//! Strict configuration and project-manifest contracts for `actions-v1` custom actions.
//!
//! This module performs format, resource, and lexical path validation. It deliberately does not
//! access the filesystem: the eventual executor must canonicalize paths immediately before spawn,
//! enforce symlink containment beneath the authorized project root, filter environment values,
//! and use direct argv execution with `shell = false`.

use std::collections::BTreeSet;
use std::path::{Component, Path};

use agent_workspace_core::LogicalShortcut;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use thiserror::Error;

use crate::{ConfigError, MAX_SAFE_REVISION};

/// Maximum number of project actions in one v1 manifest.
pub const MAX_PROJECT_ACTIONS: usize = 64;
/// Maximum encoded JSON bytes in one action definition.
pub const MAX_ACTION_DEFINITION_BYTES: usize = 16 * 1024;
/// Maximum number of literal argv elements in one action definition.
pub const MAX_ACTION_ARGUMENTS: usize = 64;
/// Maximum Unicode scalars in one literal argv element.
pub const MAX_ACTION_ARGUMENT_SCALARS: usize = 1_024;
/// Maximum encoded JSON bytes in one complete project action manifest.
pub const MAX_PROJECT_ACTION_MANIFEST_BYTES: usize =
    MAX_PROJECT_ACTIONS * MAX_ACTION_DEFINITION_BYTES + 16 * 1024;

const PROJECT_ACTION_MANIFEST_VERSION: u32 = 1;
const MAX_ACTION_ID_BYTES: usize = 128;
const MAX_ACTION_TITLE_SCALARS: usize = 120;
const MAX_SHORTCUT_SCALARS: usize = 128;
const MAX_RELATIVE_PATH_SCALARS: usize = 1_024;
const MAX_CANONICAL_ROOT_SCALARS: usize = 4_096;
const MAX_EXECUTABLE_NAME_BYTES: usize = 128;
const MAX_APPROVED_EXECUTABLES: usize = 64;
const MAX_TRUSTED_PROJECTS: usize = 256;
const MAX_ENVIRONMENT_NAMES: usize = 32;

/// Application-owned policy for project action manifests.
///
/// Neither executable approval nor project trust is read from a project manifest. Both are stored
/// in the owner-only application configuration so project content cannot authorize itself.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionConfig {
    /// Bare executable names that project manifests may reference exactly.
    pub approved_executables: Vec<String>,
    /// Exact project-root and manifest-digest approvals granted by trusted application UI.
    pub trusted_projects: Vec<TrustedProjectRecord>,
}

/// A bounded application-owned approval for one exact project manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedProjectRecord {
    /// Filesystem-canonical absolute project root captured by the trusted application.
    pub canonical_root: String,
    /// Lowercase hexadecimal SHA-256 of the exact trusted manifest bytes.
    pub manifest_sha256: String,
    /// Trust-grant timestamp as Unix epoch milliseconds.
    pub trusted_at_unix_ms: u64,
}

/// One strict version-1 project action manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActionManifest {
    /// Manifest schema version. Version 1 is the only accepted value.
    pub schema_version: u32,
    /// Validated project action definitions.
    pub actions: Vec<ProjectActionDefinition>,
}

impl ProjectActionManifest {
    /// Parse and validate untrusted JSON manifest bytes against application-owned policy.
    ///
    /// # Errors
    ///
    /// Returns [`ActionManifestError`] for malformed or unsupported JSON, any unknown/ambiguous
    /// field, a resource-bound violation, a lexical policy violation, or a bare executable that
    /// is not approved by `policy`.
    pub fn parse_json(bytes: &[u8], policy: &ActionConfig) -> Result<Self, ActionManifestError> {
        if bytes.len() > MAX_PROJECT_ACTION_MANIFEST_BYTES {
            return Err(ActionManifestError::ResourceLimit {
                kind: "manifest bytes",
            });
        }
        validate_action_config_for_manifest(policy)?;
        let wire: ProjectActionManifestWire =
            serde_json::from_slice(bytes).map_err(|_| ActionManifestError::InvalidJson)?;
        if wire.schema_version != PROJECT_ACTION_MANIFEST_VERSION {
            return Err(ActionManifestError::UnsupportedSchema {
                found: wire.schema_version,
                expected: PROJECT_ACTION_MANIFEST_VERSION,
            });
        }
        if wire.actions.len() > MAX_PROJECT_ACTIONS {
            return Err(ActionManifestError::ResourceLimit {
                kind: "action count",
            });
        }

        let approved: BTreeSet<&str> = policy
            .approved_executables
            .iter()
            .map(String::as_str)
            .collect();
        let mut ids = BTreeSet::new();
        let mut actions = Vec::with_capacity(wire.actions.len());
        for raw in wire.actions {
            if raw.get().len() > MAX_ACTION_DEFINITION_BYTES {
                return Err(ActionManifestError::ResourceLimit {
                    kind: "action definition bytes",
                });
            }
            let action: ProjectActionDefinition =
                serde_json::from_str(raw.get()).map_err(|_| ActionManifestError::InvalidJson)?;
            validate_project_action(&action, &approved)?;
            if !ids.insert(action.id.clone()) {
                return Err(ActionManifestError::InvalidField {
                    field: "actions.id",
                    reason: "must be unique within the manifest",
                });
            }
            actions.push(action);
        }

        Ok(Self {
            schema_version: wire.schema_version,
            actions,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectActionManifestWire {
    schema_version: u32,
    actions: Vec<Box<RawValue>>,
}

/// One declarative, direct-argv project action.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectActionDefinition {
    /// Globally namespaced lowercase identifier, such as `project.example.build`.
    pub id: String,
    /// Trimmed display title of at most 120 Unicode scalars.
    pub title: String,
    /// Project-relative executable path or an application-approved bare name.
    pub executable: ProjectActionExecutable,
    /// Literal argv elements; no interpolation, globbing, or shell syntax is applied.
    #[serde(default)]
    pub args: Vec<String>,
    /// Closed working-directory policy.
    pub working_directory: ProjectActionWorkingDirectory,
    /// Optional canonical logical shortcut. Explicit JSON `null` is invalid.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_non_null_shortcut"
    )]
    pub shortcut: Option<String>,
    /// Environment variable names requested from the executor's fixed safe allowlist.
    #[serde(default)]
    pub environment: Vec<String>,
}

/// Executable selection without a raw command line or shell mode.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProjectActionExecutable {
    /// A lexically confined path beneath the project root.
    ProjectRelativePath { path: String },
    /// A bare name that must exactly match application-owned approval.
    ApprovedName { name: String },
}

/// Closed working-directory choices for a project action.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProjectActionWorkingDirectory {
    /// Use the authorized project root.
    ProjectRoot,
    /// Use a lexically confined directory beneath the project root.
    ProjectRelativePath { path: String },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ProjectActionWorkingDirectoryWire {
    ProjectRoot {},
    ProjectRelativePath { path: String },
}

impl<'de> Deserialize<'de> for ProjectActionWorkingDirectory {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(
            match ProjectActionWorkingDirectoryWire::deserialize(deserializer)? {
                ProjectActionWorkingDirectoryWire::ProjectRoot {} => Self::ProjectRoot,
                ProjectActionWorkingDirectoryWire::ProjectRelativePath { path } => {
                    Self::ProjectRelativePath { path }
                }
            },
        )
    }
}

/// Stable project action manifest validation failures.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ActionManifestError {
    /// JSON is malformed, ambiguous, or contains a field outside the closed v1 schema.
    #[error("project action manifest JSON is invalid")]
    InvalidJson,
    /// The manifest declares an unsupported schema version.
    #[error("project action manifest schema {found} is unsupported; expected {expected}")]
    UnsupportedSchema {
        /// Version found in the manifest.
        found: u32,
        /// Only supported version.
        expected: u32,
    },
    /// A manifest resource bound was exceeded.
    #[error("project action manifest exceeds the {kind} resource limit")]
    ResourceLimit {
        /// Stable resource category.
        kind: &'static str,
    },
    /// A known field violates its strict v1 contract.
    #[error("invalid project action field `{field}`: {reason}")]
    InvalidField {
        /// Stable field identifier.
        field: &'static str,
        /// Stable validation description.
        reason: &'static str,
    },
}

pub(crate) fn validate_action_config(config: &ActionConfig) -> Result<(), ConfigError> {
    validate_action_config_inner(config).map_err(|error| match error {
        ActionManifestError::ResourceLimit { kind } => ConfigError::ResourceLimit { kind },
        ActionManifestError::InvalidField { field, reason } => {
            ConfigError::InvalidSetting { field, reason }
        }
        ActionManifestError::InvalidJson | ActionManifestError::UnsupportedSchema { .. } => {
            ConfigError::InvalidSetting {
                field: "actions",
                reason: "contains invalid application-owned policy",
            }
        }
    })
}

fn validate_action_config_for_manifest(config: &ActionConfig) -> Result<(), ActionManifestError> {
    validate_action_config_inner(config)
}

fn validate_action_config_inner(config: &ActionConfig) -> Result<(), ActionManifestError> {
    if config.approved_executables.len() > MAX_APPROVED_EXECUTABLES {
        return Err(ActionManifestError::ResourceLimit {
            kind: "approved executable count",
        });
    }
    let mut executable_names = BTreeSet::new();
    for name in &config.approved_executables {
        if !valid_bare_executable_name(name) {
            return Err(ActionManifestError::InvalidField {
                field: "actions.approvedExecutables",
                reason: "must contain unique portable bare executable names",
            });
        }
        if !executable_names.insert(name) {
            return Err(ActionManifestError::InvalidField {
                field: "actions.approvedExecutables",
                reason: "must contain unique portable bare executable names",
            });
        }
    }

    if config.trusted_projects.len() > MAX_TRUSTED_PROJECTS {
        return Err(ActionManifestError::ResourceLimit {
            kind: "trusted project count",
        });
    }
    let mut roots = BTreeSet::new();
    for trusted in &config.trusted_projects {
        if !valid_canonical_root(&trusted.canonical_root) {
            return Err(ActionManifestError::InvalidField {
                field: "actions.trustedProjects.canonicalRoot",
                reason: "must be a clean absolute canonical path",
            });
        }
        if !roots.insert(trusted.canonical_root.as_str()) {
            return Err(ActionManifestError::InvalidField {
                field: "actions.trustedProjects.canonicalRoot",
                reason: "must be unique",
            });
        }
        if trusted.manifest_sha256.len() != 64
            || !trusted
                .manifest_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(ActionManifestError::InvalidField {
                field: "actions.trustedProjects.manifestSha256",
                reason: "must be exactly 64 lowercase hexadecimal characters",
            });
        }
        if trusted.trusted_at_unix_ms > MAX_SAFE_REVISION {
            return Err(ActionManifestError::InvalidField {
                field: "actions.trustedProjects.trustedAtUnixMs",
                reason: "must be a JavaScript-safe non-negative integer",
            });
        }
    }
    Ok(())
}

fn validate_project_action(
    action: &ProjectActionDefinition,
    approved: &BTreeSet<&str>,
) -> Result<(), ActionManifestError> {
    if !valid_namespaced_action_id(&action.id) {
        return Err(ActionManifestError::InvalidField {
            field: "actions.id",
            reason: "must be a lowercase globally namespaced identifier",
        });
    }
    if action.title.is_empty()
        || action.title.chars().count() > MAX_ACTION_TITLE_SCALARS
        || action.title.chars().any(char::is_control)
        || action.title.trim() != action.title
    {
        return Err(ActionManifestError::InvalidField {
            field: "actions.title",
            reason: "must be trimmed, non-empty, control-free, and at most 120 Unicode scalars",
        });
    }
    match &action.executable {
        ProjectActionExecutable::ProjectRelativePath { path } => {
            validate_project_relative_path("actions.executable.path", path)?;
        }
        ProjectActionExecutable::ApprovedName { name } => {
            if !valid_bare_executable_name(name) || !approved.contains(name.as_str()) {
                return Err(ActionManifestError::InvalidField {
                    field: "actions.executable.name",
                    reason: "must exactly match an application-approved bare executable name",
                });
            }
        }
    }
    if action.args.len() > MAX_ACTION_ARGUMENTS {
        return Err(ActionManifestError::ResourceLimit {
            kind: "argument count",
        });
    }
    for argument in &action.args {
        if argument.chars().count() > MAX_ACTION_ARGUMENT_SCALARS
            || argument.chars().any(char::is_control)
        {
            return Err(ActionManifestError::InvalidField {
                field: "actions.args",
                reason: "each literal argument must be control-free and at most 1024 Unicode scalars",
            });
        }
    }
    if let ProjectActionWorkingDirectory::ProjectRelativePath { path } = &action.working_directory {
        validate_project_relative_path("actions.workingDirectory.path", path)?;
    }
    if let Some(shortcut) = &action.shortcut
        && !valid_logical_shortcut(shortcut)
    {
        return Err(ActionManifestError::InvalidField {
            field: "actions.shortcut",
            reason: "must use canonical logical shortcut syntax",
        });
    }
    if action.environment.len() > MAX_ENVIRONMENT_NAMES {
        return Err(ActionManifestError::ResourceLimit {
            kind: "environment name count",
        });
    }
    let mut environment = BTreeSet::new();
    for name in &action.environment {
        if !valid_environment_name(name)
            || forbidden_environment_name(name)
            || !environment.insert(name)
        {
            return Err(ActionManifestError::InvalidField {
                field: "actions.environment",
                reason: "must contain unique non-sensitive portable environment names",
            });
        }
    }
    Ok(())
}

fn valid_namespaced_action_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ACTION_ID_BYTES
        && value.contains('.')
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'-' | b'_')
                })
        })
}

fn valid_bare_executable_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_EXECUTABLE_NAME_BYTES
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
}

fn validate_project_relative_path(
    field: &'static str,
    value: &str,
) -> Result<(), ActionManifestError> {
    let scalar_count = value.chars().count();
    let valid_segments = !value.is_empty()
        && scalar_count <= MAX_RELATIVE_PATH_SCALARS
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."));
    if !valid_segments || Path::new(value).is_absolute() {
        return Err(ActionManifestError::InvalidField {
            field,
            reason: "must be a clean project-relative path without traversal",
        });
    }
    Ok(())
}

fn valid_canonical_root(value: &str) -> bool {
    if value.is_empty()
        || value.chars().count() > MAX_CANONICAL_ROOT_SCALARS
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return false;
    }
    let mut normal_components = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {}
            Component::Normal(_) => normal_components += 1,
            Component::CurDir | Component::ParentDir => return false,
        }
    }
    normal_components > 0
}

fn valid_environment_name(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn forbidden_environment_name(value: &str) -> bool {
    let segments: Vec<_> = value.split('_').collect();
    segments.iter().any(|segment| {
        matches!(
            *segment,
            "KEY"
                | "TOKEN"
                | "SECRET"
                | "PASSWORD"
                | "PASSWD"
                | "CREDENTIAL"
                | "CREDENTIALS"
                | "AUTHORIZATION"
                | "COOKIE"
        )
    }) || matches!(
        value,
        "AGENT_WORKSPACE_AUTH"
            | "SSH_AUTH_SOCK"
            | "GPG_AGENT_INFO"
            | "XAUTHORITY"
            | "DBUS_SESSION_BUS_ADDRESS"
    )
}

fn valid_logical_shortcut(value: &str) -> bool {
    value.chars().count() <= MAX_SHORTCUT_SCALARS
        && LogicalShortcut::new(value).is_ok_and(|parsed| parsed.as_str() == value)
}

fn deserialize_optional_non_null_shortcut<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("shortcut must be omitted instead of null"))
}

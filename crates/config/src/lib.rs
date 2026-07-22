//! Versioned, validated, human-readable application configuration.
//!
//! [`ConfigStore`] persists [`AppConfig`] as `config.json` using same-directory atomic
//! replacement. Unknown fields are retained at every object boundary so newer settings survive
//! a read/modify/write cycle through an older application, subject to conservative resource and
//! sensitive-key limits.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

mod actions;

pub use actions::{
    ActionConfig, ActionManifestError, MAX_ACTION_ARGUMENT_SCALARS, MAX_ACTION_ARGUMENTS,
    MAX_ACTION_DEFINITION_BYTES, MAX_PROJECT_ACTION_MANIFEST_BYTES, MAX_PROJECT_ACTIONS,
    ProjectActionDefinition, ProjectActionExecutable, ProjectActionManifest,
    ProjectActionWorkingDirectory, TrustedProjectRecord,
};

/// Current on-disk configuration schema.
pub const SCHEMA_VERSION: u32 = 2;
const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;
/// Maximum accepted size of a configuration file.
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
/// Largest revision that round-trips exactly through JavaScript numbers.
pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

const MAX_STRING_BYTES: usize = 4 * 1024;
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_NODES: usize = 4_096;
const MAX_OBJECT_ENTRIES: usize = 512;
const MAX_ARRAY_ITEMS: usize = 256;
const MAX_SHORTCUTS: usize = 128;
const MAX_UNKNOWN_BYTES: usize = 256 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

type Extensions = BTreeMap<String, Value>;

/// Validated current-schema application configuration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// On-disk schema version. It must equal [`SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Monotonic optimistic-concurrency revision.
    #[serde(default)]
    pub revision: u64,
    /// Appearance preferences.
    #[serde(default)]
    pub appearance: AppearanceConfig,
    /// Terminal preferences.
    #[serde(default)]
    pub terminal: TerminalConfig,
    /// Embedded browser preferences.
    #[serde(default)]
    pub browser: BrowserConfig,
    /// Desktop notification preferences.
    #[serde(default)]
    pub notifications: NotificationConfig,
    /// Keyboard shortcut customizations.
    #[serde(default)]
    pub keyboard_shortcuts: KeyboardShortcutConfig,
    /// Agent integration preferences.
    #[serde(default)]
    pub agent_integration: AgentIntegrationConfig,
    /// Application update preferences.
    #[serde(default)]
    pub updates: UpdateConfig,
    /// Logging preferences.
    #[serde(default)]
    pub logging: LoggingConfig,
    /// Policy and trust records for project-defined actions.
    #[serde(default)]
    pub actions: ActionConfig,
    /// Non-secret policy for bounded remote-session retries.
    #[serde(default)]
    pub remote_sessions: RemoteSessionConfig,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            revision: 0,
            appearance: AppearanceConfig::default(),
            terminal: TerminalConfig::default(),
            browser: BrowserConfig::default(),
            notifications: NotificationConfig::default(),
            keyboard_shortcuts: KeyboardShortcutConfig::default(),
            agent_integration: AgentIntegrationConfig::default(),
            updates: UpdateConfig::default(),
            logging: LoggingConfig::default(),
            actions: ActionConfig::default(),
            remote_sessions: RemoteSessionConfig::default(),
            extra: Extensions::new(),
        }
    }
}

/// Non-secret policy only; SSH identities and credentials never enter config.json.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSessionConfig {
    pub reconnect_max_attempts: u8,
    pub reconnect_initial_delay_ms: u32,
    pub reconnect_max_delay_ms: u32,
}

impl Default for RemoteSessionConfig {
    fn default() -> Self {
        Self {
            reconnect_max_attempts: 5,
            reconnect_initial_delay_ms: 500,
            reconnect_max_delay_ms: 30_000,
        }
    }
}

/// Appearance preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceConfig {
    /// Color theme.
    pub theme: Theme,
    /// Interface spacing.
    pub density: Density,
    /// Interface font family or CSS font-family stack.
    pub font_family: String,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            density: Density::default(),
            font_family: "system-ui, 'Segoe UI', 'Cantarell', 'Ubuntu', sans-serif".to_owned(),
            extra: Extensions::new(),
        }
    }
}

/// Color theme.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    /// Follow the desktop preference.
    #[default]
    System,
    /// Use a dark palette.
    Dark,
    /// Use a light palette.
    Light,
}

/// Interface spacing.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    /// Tighter controls and spacing.
    Compact,
    /// Standard controls and spacing.
    #[default]
    Comfortable,
    /// More room for readable metadata and workspace card slots.
    Expanded,
}

/// Terminal preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalConfig {
    /// Optional shell executable path. The application never treats this as a command line.
    pub shell_path: Option<String>,
    /// Terminal font family.
    pub font_family: String,
    /// Terminal font size in points.
    pub font_size: f32,
    /// Number of retained scrollback lines.
    pub scrollback: u32,
    /// Whether multiline paste requires confirmation.
    pub multiline_paste_protection: bool,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            shell_path: None,
            font_family: "JetBrains Mono Variable".to_owned(),
            font_size: 13.0,
            scrollback: 10_000,
            multiline_paste_protection: true,
            extra: Extensions::new(),
        }
    }
}

/// Embedded browser preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserConfig {
    /// Human-facing profile name.
    pub profile_name: String,
    /// Stable storage partition name.
    pub partition: String,
    /// Browser privacy behavior.
    pub privacy: PrivacyBehavior,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            profile_name: "Default".to_owned(),
            partition: "default".to_owned(),
            privacy: PrivacyBehavior::default(),
            extra: Extensions::new(),
        }
    }
}

/// Browser privacy behavior.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyBehavior {
    /// Preserve normal browser behavior.
    #[default]
    Standard,
    /// Prefer stronger tracking and storage restrictions.
    Strict,
}

/// Desktop notification preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationConfig {
    /// Whether system notifications are enabled.
    pub system_enabled: bool,
    /// Whether notification bodies may contain event text.
    pub include_body: bool,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            system_enabled: true,
            include_body: false,
            extra: Extensions::new(),
        }
    }
}

/// Keyboard shortcut customizations.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcutConfig {
    /// Action identifier to shortcut override. `null` means explicitly cleared.
    pub overrides: BTreeMap<String, ShortcutOverride>,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

/// A keyboard shortcut explicitly set or cleared.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShortcutOverride {
    /// Override the action with this portable shortcut string.
    Set(String),
    /// Remove the default shortcut. This is represented as JSON `null`.
    Cleared,
}

/// Agent integration preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentIntegrationConfig {
    /// Enable agent-aware workspace integration.
    pub enabled: bool,
    /// Allow agents to request desktop notifications.
    pub notifications_enabled: bool,
    /// Allow agents to open browser views.
    pub browser_enabled: bool,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

impl Default for AgentIntegrationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            notifications_enabled: true,
            browser_enabled: true,
            extra: Extensions::new(),
        }
    }
}

/// Application update preferences.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateConfig {
    /// Preferred release channel.
    pub channel: UpdateChannel,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

/// Application release channel.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    /// Stable releases only.
    #[default]
    Stable,
    /// Beta releases.
    Beta,
}

/// Logging preferences.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoggingConfig {
    /// Maximum emitted log verbosity.
    pub level: LogLevel,
    /// Fields introduced by newer compatible versions.
    #[serde(flatten)]
    pub extra: Extensions,
}

/// Logging verbosity.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    /// Errors only.
    Error,
    /// Warnings and errors.
    Warn,
    /// Informational messages.
    #[default]
    Info,
    /// Debug diagnostics.
    Debug,
    /// Full trace diagnostics.
    Trace,
}

/// Stable error categories for configuration persistence.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// The configured path has no usable file name or parent directory.
    #[error("invalid configuration path")]
    InvalidPath,
    /// A path component is a symlink or unexpected filesystem object.
    #[error("unsafe configuration path component at `{path}`")]
    UnsafePath {
        /// Rejected component.
        path: PathBuf,
    },
    /// The configuration exceeds the accepted file size.
    #[error("configuration file exceeds the {limit}-byte limit")]
    FileTooLarge {
        /// Maximum allowed bytes.
        limit: u64,
    },
    /// JSON is malformed or cannot be represented by a supported configuration schema.
    #[error("configuration JSON is invalid")]
    InvalidJson,
    /// The file was written by a newer schema.
    #[error("configuration schema {found} is newer than supported schema {supported}")]
    FutureSchema {
        /// Version found on disk.
        found: u32,
        /// Highest supported version.
        supported: u32,
    },
    /// The schema version is missing, zero, or otherwise unsupported.
    #[error("configuration schema {found} is unsupported; expected {expected}")]
    UnsupportedSchema {
        /// Version found on disk.
        found: u32,
        /// Required version.
        expected: u32,
    },
    /// A known setting violates its contract.
    #[error("invalid configuration setting `{field}`: {reason}")]
    InvalidSetting {
        /// Stable field identifier.
        field: &'static str,
        /// Stable validation description.
        reason: &'static str,
    },
    /// JSON resource limits were exceeded.
    #[error("configuration exceeds the {kind} resource limit")]
    ResourceLimit {
        /// Stable resource category.
        kind: &'static str,
    },
    /// A filesystem operation failed.
    #[error("configuration filesystem operation `{operation}` failed: {kind:?}")]
    Io {
        /// Stable operation name.
        operation: &'static str,
        /// Portable I/O error category; no file contents are retained.
        kind: io::ErrorKind,
    },
}

impl ConfigError {
    fn io(operation: &'static str, error: &io::Error) -> Self {
        Self::Io {
            operation,
            kind: error.kind(),
        }
    }
}

/// A configuration store bound to one `config.json` path.
#[derive(Clone, Debug)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    /// Bind a store to a configuration file path.
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Return the bound configuration path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Load and validate the configuration. A missing file returns current-schema defaults.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when the path is unsafe, filesystem access fails, the file exceeds
    /// a resource limit, or the JSON/schema/settings are invalid.
    pub fn load(&self) -> Result<AppConfig, ConfigError> {
        inspect_parent_safely(safe_parent(&self.path)?)?;
        let Some(metadata) = metadata_if_exists(&self.path)? else {
            return Ok(AppConfig::default());
        };
        ensure_regular_not_symlink(&self.path, &metadata)?;
        secure_existing_permissions(&self.path, &metadata)?;
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::FileTooLarge {
                limit: MAX_CONFIG_BYTES,
            });
        }

        let mut file = open_read_nofollow(&self.path)?;
        let opened_metadata = file
            .metadata()
            .map_err(|error| ConfigError::io("inspect opened file", &error))?;
        if !opened_metadata.file_type().is_file() {
            return Err(ConfigError::UnsafePath {
                path: self.path.clone(),
            });
        }
        let mut bytes = Vec::with_capacity(usize::try_from(opened_metadata.len()).unwrap_or(0));
        Read::by_ref(&mut file)
            .take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| ConfigError::io("read configuration", &error))?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(ConfigError::FileTooLarge {
                limit: MAX_CONFIG_BYTES,
            });
        }
        decode_and_validate(&bytes)
    }

    /// Validate and atomically replace the bound configuration file.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when validation fails, the path is unsafe, or a required
    /// filesystem operation cannot be completed.
    pub fn save(&self, config: &AppConfig) -> Result<(), ConfigError> {
        validate_config(config)?;
        let bytes = serde_json::to_vec_pretty(config).map_err(|_| ConfigError::InvalidJson)?;
        if bytes.len().saturating_add(1) as u64 > MAX_CONFIG_BYTES {
            return Err(ConfigError::FileTooLarge {
                limit: MAX_CONFIG_BYTES,
            });
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| ConfigError::InvalidJson)?;
        validate_json_limits(&value)?;

        let parent = safe_parent(&self.path)?;
        create_parent_safely(parent)?;
        let existing_mode = match metadata_if_exists(&self.path)? {
            Some(metadata) => {
                ensure_regular_not_symlink(&self.path, &metadata)?;
                Some(secure_existing_permissions(&self.path, &metadata)?)
            }
            None => None,
        };

        let (temp_path, mut temp) = create_temp_file(
            parent,
            self.path.file_name().ok_or(ConfigError::InvalidPath)?,
        )?;
        let write_result = (|| {
            temp.write_all(&bytes)
                .map_err(|error| ConfigError::io("write temporary file", &error))?;
            temp.write_all(b"\n")
                .map_err(|error| ConfigError::io("write temporary file", &error))?;
            set_file_mode(&temp, existing_mode.unwrap_or(0o600))?;
            temp.sync_all()
                .map_err(|error| ConfigError::io("sync temporary file", &error))?;
            drop(temp);

            if let Some(metadata) = metadata_if_exists(&self.path)? {
                ensure_regular_not_symlink(&self.path, &metadata)?;
            }
            fs::rename(&temp_path, &self.path)
                .map_err(|error| ConfigError::io("replace configuration", &error))?;
            sync_directory(parent)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        write_result
    }

    /// Load, mutate, validate, save, and return the resulting configuration.
    ///
    /// # Errors
    ///
    /// Returns any error produced by [`Self::load`] or [`Self::save`].
    pub fn update<F>(&self, update: F) -> Result<AppConfig, ConfigError>
    where
        F: FnOnce(&mut AppConfig),
    {
        let mut config = self.load()?;
        update(&mut config);
        self.save(&config)?;
        Ok(config)
    }
}

fn decode_and_validate(bytes: &[u8]) -> Result<AppConfig, ConfigError> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| ConfigError::InvalidJson)?;
    validate_json_limits(&value)?;
    let schema = value
        .as_object()
        .and_then(|object| object.get("schemaVersion"))
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or(ConfigError::InvalidSetting {
            field: "schemaVersion",
            reason: "must be an unsigned integer",
        })?;
    if schema > SCHEMA_VERSION {
        return Err(ConfigError::FutureSchema {
            found: schema,
            supported: SCHEMA_VERSION,
        });
    }
    if schema < MIN_SUPPORTED_SCHEMA_VERSION {
        return Err(ConfigError::UnsupportedSchema {
            found: schema,
            expected: SCHEMA_VERSION,
        });
    }
    if schema == 1 {
        if value.pointer("/appearance/density") == Some(&Value::String("expanded".to_owned())) {
            return Err(ConfigError::InvalidSetting {
                field: "appearance.density",
                reason: "expanded density requires configuration schemaVersion 2",
            });
        }
        value["schemaVersion"] = Value::from(SCHEMA_VERSION);
    }
    let config: AppConfig = serde_json::from_value(value).map_err(|_| ConfigError::InvalidJson)?;
    validate_config(&config)?;
    Ok(config)
}

fn validate_config(config: &AppConfig) -> Result<(), ConfigError> {
    if config.schema_version > SCHEMA_VERSION {
        return Err(ConfigError::FutureSchema {
            found: config.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    if config.schema_version != SCHEMA_VERSION {
        return Err(ConfigError::UnsupportedSchema {
            found: config.schema_version,
            expected: SCHEMA_VERSION,
        });
    }
    if config.revision > MAX_SAFE_REVISION {
        return Err(ConfigError::InvalidSetting {
            field: "revision",
            reason: "must be a JavaScript-safe non-negative integer",
        });
    }
    validate_string(
        "appearance.fontFamily",
        &config.appearance.font_family,
        1,
        256,
    )?;
    validate_optional_string(
        "terminal.shellPath",
        config.terminal.shell_path.as_deref(),
        1,
        1024,
    )?;
    if config
        .terminal
        .shell_path
        .as_deref()
        .is_some_and(|path| !Path::new(path).is_absolute())
    {
        return Err(ConfigError::InvalidSetting {
            field: "terminal.shellPath",
            reason: "must be an absolute path",
        });
    }
    validate_string("terminal.fontFamily", &config.terminal.font_family, 1, 256)?;
    if !config.terminal.font_size.is_finite() || !(6.0..=72.0).contains(&config.terminal.font_size)
    {
        return Err(ConfigError::InvalidSetting {
            field: "terminal.fontSize",
            reason: "must be a finite number from 6 through 72",
        });
    }
    if !(100..=1_000_000).contains(&config.terminal.scrollback) {
        return Err(ConfigError::InvalidSetting {
            field: "terminal.scrollback",
            reason: "must be from 100 through 1000000",
        });
    }
    validate_string("browser.profileName", &config.browser.profile_name, 1, 128)?;
    validate_string("browser.partition", &config.browser.partition, 1, 128)?;
    if !config
        .browser
        .partition
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err(ConfigError::InvalidSetting {
            field: "browser.partition",
            reason: "may contain only ASCII letters, numbers, dash, underscore, and dot",
        });
    }
    if config.keyboard_shortcuts.overrides.len() > MAX_SHORTCUTS {
        return Err(ConfigError::ResourceLimit {
            kind: "shortcut map",
        });
    }
    for (action, shortcut) in &config.keyboard_shortcuts.overrides {
        validate_string("keyboardShortcuts.overrides.action", action, 1, 128)?;
        if !action.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        }) {
            return Err(ConfigError::InvalidSetting {
                field: "keyboardShortcuts.overrides.action",
                reason: "contains unsupported characters",
            });
        }
        if let ShortcutOverride::Set(shortcut) = shortcut {
            validate_string("keyboardShortcuts.overrides.value", shortcut, 1, 128)?;
        }
    }

    actions::validate_action_config(&config.actions)?;
    validate_remote_session_config(&config.remote_sessions)?;

    let value = serde_json::to_value(config).map_err(|_| ConfigError::InvalidJson)?;
    validate_json_limits(&value)
}

fn validate_remote_session_config(config: &RemoteSessionConfig) -> Result<(), ConfigError> {
    if config.reconnect_max_attempts > 10 {
        return Err(ConfigError::InvalidSetting {
            field: "remoteSessions.reconnectMaxAttempts",
            reason: "must be at most 10",
        });
    }
    if !(100..=60_000).contains(&config.reconnect_initial_delay_ms)
        || config.reconnect_max_delay_ms < config.reconnect_initial_delay_ms
        || config.reconnect_max_delay_ms > 300_000
    {
        return Err(ConfigError::InvalidSetting {
            field: "remoteSessions",
            reason: "contains invalid reconnect delay bounds",
        });
    }
    Ok(())
}

fn validate_string(
    field: &'static str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), ConfigError> {
    if !(minimum..=maximum).contains(&value.len()) || value.chars().any(char::is_control) {
        return Err(ConfigError::InvalidSetting {
            field,
            reason: "has an invalid length or contains control characters",
        });
    }
    Ok(())
}

fn validate_optional_string(
    field: &'static str,
    value: Option<&str>,
    minimum: usize,
    maximum: usize,
) -> Result<(), ConfigError> {
    value.map_or(Ok(()), |value| {
        validate_string(field, value, minimum, maximum)
    })
}

fn validate_json_limits(root: &Value) -> Result<(), ConfigError> {
    struct Budget {
        nodes: usize,
        unknown_bytes: usize,
    }

    fn visit(value: &Value, depth: usize, budget: &mut Budget) -> Result<(), ConfigError> {
        if depth > MAX_JSON_DEPTH {
            return Err(ConfigError::ResourceLimit { kind: "JSON depth" });
        }
        budget.nodes = budget.nodes.saturating_add(1);
        if budget.nodes > MAX_JSON_NODES {
            return Err(ConfigError::ResourceLimit {
                kind: "JSON node count",
            });
        }
        match value {
            Value::Object(object) => {
                if object.len() > MAX_OBJECT_ENTRIES {
                    return Err(ConfigError::ResourceLimit {
                        kind: "object entries",
                    });
                }
                for (key, child) in object {
                    if key.len() > MAX_STRING_BYTES {
                        return Err(ConfigError::ResourceLimit {
                            kind: "string length",
                        });
                    }
                    let lowered = key.to_ascii_lowercase();
                    if ["token", "secret", "command"]
                        .iter()
                        .any(|reserved| lowered.contains(reserved))
                    {
                        return Err(ConfigError::InvalidSetting {
                            field: "extension key",
                            reason: "sensitive or executable fields are not permitted",
                        });
                    }
                    budget.unknown_bytes = budget
                        .unknown_bytes
                        .saturating_add(key.len())
                        .saturating_add(estimated_scalar_bytes(child));
                    if budget.unknown_bytes > MAX_UNKNOWN_BYTES {
                        return Err(ConfigError::ResourceLimit {
                            kind: "aggregate extension data",
                        });
                    }
                    visit(child, depth + 1, budget)?;
                }
            }
            Value::Array(array) => {
                if array.len() > MAX_ARRAY_ITEMS {
                    return Err(ConfigError::ResourceLimit {
                        kind: "array items",
                    });
                }
                for child in array {
                    visit(child, depth + 1, budget)?;
                }
            }
            Value::String(string) if string.len() > MAX_STRING_BYTES => {
                return Err(ConfigError::ResourceLimit {
                    kind: "string length",
                });
            }
            _ => {}
        }
        Ok(())
    }

    visit(
        root,
        0,
        &mut Budget {
            nodes: 0,
            unknown_bytes: 0,
        },
    )
}

fn estimated_scalar_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 24,
        Value::String(string) => string.len(),
        Value::Array(_) | Value::Object(_) => 1,
    }
}

fn safe_parent(path: &Path) -> Result<&Path, ConfigError> {
    if path.file_name().is_none() {
        return Err(ConfigError::InvalidPath);
    }
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent),
        Some(_) => Ok(Path::new(".")),
        None => Err(ConfigError::InvalidPath),
    }
}

fn create_parent_safely(parent: &Path) -> Result<(), ConfigError> {
    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(ConfigError::UnsafePath {
                    path: parent.to_owned(),
                });
            }
            Component::Normal(part) => current.push(part),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            }
            Ok(_) => return Err(ConfigError::UnsafePath { path: current }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|error| ConfigError::io("create parent directory", &error))?;
                set_path_mode(&current, 0o700)?;
            }
            Err(error) => return Err(ConfigError::io("inspect parent directory", &error)),
        }
    }
    Ok(())
}

fn inspect_parent_safely(parent: &Path) -> Result<(), ConfigError> {
    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(ConfigError::UnsafePath {
                    path: parent.to_owned(),
                });
            }
            Component::Normal(part) => current.push(part),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            }
            Ok(_) => return Err(ConfigError::UnsafePath { path: current }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(ConfigError::io("inspect parent directory", &error)),
        }
    }
    Ok(())
}

fn metadata_if_exists(path: &Path) -> Result<Option<fs::Metadata>, ConfigError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ConfigError::io("inspect configuration path", &error)),
    }
}

fn ensure_regular_not_symlink(path: &Path, metadata: &fs::Metadata) -> Result<(), ConfigError> {
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(ConfigError::UnsafePath {
            path: path.to_owned(),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn secure_existing_permissions(path: &Path, metadata: &fs::Metadata) -> Result<u32, ConfigError> {
    use std::os::unix::fs::PermissionsExt;

    let current = metadata.permissions().mode() & 0o777;
    let secured = current & !0o077;
    if current != secured {
        fs::set_permissions(path, fs::Permissions::from_mode(secured))
            .map_err(|error| ConfigError::io("secure configuration permissions", &error))?;
    }
    Ok(secured)
}

#[cfg(not(unix))]
fn secure_existing_permissions(_path: &Path, _metadata: &fs::Metadata) -> Result<u32, ConfigError> {
    Ok(0o600)
}

#[cfg(unix)]
fn open_read_nofollow(path: &Path) -> Result<File, ConfigError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| ConfigError::io("open configuration", &error))
}

#[cfg(not(unix))]
fn open_read_nofollow(path: &Path) -> Result<File, ConfigError> {
    File::open(path).map_err(|error| ConfigError::io("open configuration", &error))
}

fn create_temp_file(parent: &Path, file_name: &OsStr) -> Result<(PathBuf, File), ConfigError> {
    for _ in 0..128 {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut name = OsString::from(".");
        name.push(file_name);
        name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
        let path = parent.join(name);
        match open_new_private(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(ConfigError::io("create temporary file", &error)),
        }
    }
    Err(ConfigError::Io {
        operation: "allocate temporary file name",
        kind: io::ErrorKind::AlreadyExists,
    })
}

#[cfg(unix)]
fn open_new_private(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_new_private(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn set_file_mode(file: &File, mode: u32) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(fs::Permissions::from_mode(mode & 0o700))
        .map_err(|error| ConfigError::io("set configuration permissions", &error))
}

#[cfg(not(unix))]
fn set_file_mode(_file: &File, _mode: u32) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(unix)]
fn set_path_mode(path: &Path, mode: u32) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| ConfigError::io("set directory permissions", &error))
}

#[cfg(not(unix))]
fn set_path_mode(_path: &Path, _mode: u32) -> Result<(), ConfigError> {
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ConfigError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| ConfigError::io("sync parent directory", &error))
}

//! Service-owned discovery and confirmation for trusted project custom actions.
//!
//! This module intentionally does not expose an execution-enabling switch. The current action
//! runtime provides process-group cleanup and path revalidation, but not a trustworthy
//! per-invocation Linux containment boundary. Discovery and confirmation therefore remain usable,
//! while every attempted execution fails closed with a stable policy result.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_workspace_action_runtime::{
    AuditSummary as RuntimeAuditSummary, CancellationToken, ExecutableClass, ExecutionError,
    ExecutionPolicy, ExecutionRequest, ExecutionResult, ExitClass, confirmation_definition_sha256,
    containment_availability, execute,
};
use agent_workspace_config::{
    ActionConfig, MAX_PROJECT_ACTION_MANIFEST_BYTES, ProjectActionDefinition,
    ProjectActionExecutable, ProjectActionManifest,
};
use agent_workspace_protocol::{
    ActionAuthorizationClass, ActionDefinition, ActionInteractionClass, ActionLimits, ActionOwner,
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;
use thiserror::Error;
use uuid::Uuid;

/// The sole project-relative manifest location accepted by the service.
pub const PROJECT_ACTION_MANIFEST_PATH: &str = ".cmux/actions.json";
/// Confirmation lifetime. Confirmation is deliberately short-lived and cannot be refreshed.
pub const CONFIRMATION_TTL: Duration = Duration::from_secs(30);
const MAX_INVOCATIONS: usize = 256;

/// Exact provider/window incarnation authorized to show and answer a confirmation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderWindowGeneration {
    pub provider_id: Uuid,
    pub provider_epoch: u64,
    pub provider_lease_id: Uuid,
    pub window_id: Uuid,
    pub generation: u64,
}

/// Safe registry metadata. It contains no executable, argv, environment, or filesystem data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomActionRecord {
    pub action_id: String,
    pub title: String,
    pub shortcut: Option<String>,
    pub shortcut_collides: bool,
    pub confirmation_definition_sha256: String,
}

/// One deterministic shortcut collision reported by registry refresh.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShortcutCollision {
    pub shortcut: String,
    pub action_ids: Vec<String>,
}

/// A complete immutable snapshot of the currently trusted registry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomActionRegistrySnapshot {
    pub revision: u64,
    pub manifest_sha256: String,
    pub actions: Vec<CustomActionRecord>,
    pub shortcut_collisions: Vec<ShortcutCollision>,
}

/// Service-created, single-use confirmation challenge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfirmationChallenge {
    pub invocation_id: Uuid,
    pub nonce: Uuid,
    pub challenge: String,
    pub provider: ProviderWindowGeneration,
    pub confirmation_definition_sha256: String,
    pub action_id: String,
    pub display_title: String,
    pub executable_class: ExecutableClass,
    pub argument_count: u32,
    pub project_label: String,
    pub expires_at_unix_ms: u64,
}

/// Exact echo accepted from the desktop provider. No caller action parameters are accepted here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfirmationResponse {
    pub invocation_id: Uuid,
    pub nonce: Uuid,
    pub challenge: String,
    pub provider: ProviderWindowGeneration,
    pub confirmation_definition_sha256: String,
}

/// Content-free invocation lifecycle state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CustomInvocationState {
    AwaitingConfirmation,
    Executing,
    Cancelled,
    PolicyDenied,
    ContainmentUnavailable,
    Completed,
    Failed,
}

/// Stable terminal classification suitable for protocol and audit mapping.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)] // Secure execution result variants remain reserved for the containment backend.
pub enum CustomTerminalCode {
    Cancelled,
    PolicyDenied,
    ContainmentUnavailable,
    Succeeded,
    Failed,
    Signalled,
    TimedOut,
    RuntimeRejected,
}

/// Bounded execution metadata. Raw output and execution inputs never cross this boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedExecutionResult {
    pub terminal_code: CustomTerminalCode,
    pub exit_code: Option<i32>,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub output_truncated: bool,
    pub redaction_count: usize,
    pub duration_ms: u64,
}

/// Content-free service audit record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomActionAudit {
    pub invocation_id: Uuid,
    pub action_id: String,
    pub provider: ProviderWindowGeneration,
    pub state: CustomInvocationState,
    pub terminal_code: Option<CustomTerminalCode>,
    pub accepted_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub result: Option<BoundedExecutionResult>,
}

/// Stable fail-closed coordinator errors.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum CustomActionError {
    #[error("the authorized project root is invalid")]
    InvalidProjectRoot,
    #[error("the trusted project label is invalid")]
    InvalidProjectLabel,
    #[error("the fixed project action manifest is unavailable")]
    ManifestUnavailable,
    #[error("the project action manifest is not trusted")]
    UntrustedManifest,
    #[error("the project action manifest is invalid")]
    InvalidManifest,
    #[error("the custom action is not registered")]
    ActionNotFound,
    #[error("the invocation identifier is already in use")]
    DuplicateInvocation,
    #[error("the invocation capacity has been reached")]
    InvocationLimit,
    #[error("the confirmation is invalid or does not match the invocation")]
    ConfirmationMismatch,
    #[error("the confirmation was already consumed")]
    ConfirmationReplay,
    #[error("the confirmation expired")]
    ConfirmationExpired,
    #[error("the invocation cannot be cancelled in its current state")]
    NotCancellable,
    #[error("custom action execution is disabled by service policy")]
    PolicyDenied,
    #[error("a trustworthy per-invocation containment backend is unavailable")]
    ContainmentUnavailable,
    #[error("the contained custom action execution failed")]
    ExecutionFailed,
}

#[derive(Clone)]
pub struct CustomActionCoordinator {
    inner: Arc<Mutex<CoordinatorInner>>,
    action_config: Arc<ActionConfig>,
    execution_policy: Arc<ExecutionPolicy>,
    policy_enabled: bool,
    server_secret: [u8; 32],
}

struct CoordinatorInner {
    revision: u64,
    registry: Option<TrustedRegistry>,
    invocations: BTreeMap<Uuid, Invocation>,
}

struct TrustedRegistry {
    canonical_root: PathBuf,
    project_label: String,
    manifest_bytes: Vec<u8>,
    manifest_sha256: String,
    actions: BTreeMap<String, RegisteredAction>,
    snapshot: CustomActionRegistrySnapshot,
}

struct RegisteredAction {
    definition: ProjectActionDefinition,
    confirmation_definition_sha256: String,
}

struct Invocation {
    action_id: String,
    project_label: String,
    provider: ProviderWindowGeneration,
    request: Arc<ExecutionRequest>,
    nonce: Uuid,
    challenge: String,
    definition_sha256: String,
    expires_at_unix_ms: u64,
    expires_at: Instant,
    confirmation_consumed: bool,
    state: CustomInvocationState,
    accepted_at_unix_ms: u64,
    updated_at_unix_ms: u64,
    cancellation: CancellationToken,
    result: Option<BoundedExecutionResult>,
}

impl std::fmt::Debug for CustomActionCoordinator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self
            .inner
            .lock()
            .expect("custom action lock is not poisoned");
        formatter
            .debug_struct("CustomActionCoordinator")
            .field("policy_enabled", &self.policy_enabled)
            .field("registry_revision", &inner.revision)
            .field("has_trusted_registry", &inner.registry.is_some())
            .field("invocation_count", &inner.invocations.len())
            .finish_non_exhaustive()
    }
}

impl CustomActionCoordinator {
    /// Construct a coordinator. Execution is disabled unless `policy_enabled` is true; even then,
    /// confirmation fails with `ContainmentUnavailable` until a secure backend is implemented.
    #[must_use]
    pub fn new(
        action_config: Arc<ActionConfig>,
        execution_policy: Arc<ExecutionPolicy>,
        policy_enabled: bool,
    ) -> Self {
        let mut secret_material = [0_u8; 32];
        secret_material[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        secret_material[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        Self {
            inner: Arc::new(Mutex::new(CoordinatorInner {
                revision: 0,
                registry: None,
                invocations: BTreeMap::new(),
            })),
            action_config,
            execution_policy,
            policy_enabled,
            server_secret: secret_material,
        }
    }

    /// Discover and atomically replace the registry from the one fixed manifest path.
    /// Any failure first invalidates the previous registry.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn refresh(
        &self,
        authorized_project_root: &Path,
    ) -> Result<CustomActionRegistrySnapshot, CustomActionError> {
        self.refresh_project(authorized_project_root, "Project")
    }

    /// Refresh with a trusted, non-path project label suitable for native confirmation UX.
    pub fn refresh_project(
        &self,
        authorized_project_root: &Path,
        project_label: &str,
    ) -> Result<CustomActionRegistrySnapshot, CustomActionError> {
        self.refresh_at(authorized_project_root, project_label, unix_ms())
    }

    fn refresh_at(
        &self,
        authorized_project_root: &Path,
        project_label: &str,
        now_unix_ms: u64,
    ) -> Result<CustomActionRegistrySnapshot, CustomActionError> {
        let loaded = self.load_registry(authorized_project_root, project_label);
        let mut inner = self
            .inner
            .lock()
            .expect("custom action lock is not poisoned");
        inner.revision = inner.revision.saturating_add(1);
        match loaded {
            Ok(mut registry) => {
                let changed = inner.registry.as_ref().is_some_and(|current| {
                    current.canonical_root != registry.canonical_root
                        || current.manifest_sha256 != registry.manifest_sha256
                });
                if changed {
                    invalidate_pending_invocations(&mut inner.invocations, now_unix_ms);
                }
                registry.snapshot.revision = inner.revision;
                let snapshot = registry.snapshot.clone();
                inner.registry = Some(registry);
                Ok(snapshot)
            }
            Err(error) => {
                invalidate_pending_invocations(&mut inner.invocations, now_unix_ms);
                inner.registry = None;
                Err(error)
            }
        }
    }

    /// Return current safe registry metadata, if the last refresh was trusted and valid.
    #[must_use]
    pub fn registry(&self) -> Option<CustomActionRegistrySnapshot> {
        self.inner
            .lock()
            .expect("custom action lock is not poisoned")
            .registry
            .as_ref()
            .map(|registry| registry.snapshot.clone())
    }

    /// Project the current trusted registry into the public action registry contract.
    /// Dynamic titles and shortcuts are copied only from the already-validated manifest.
    #[must_use]
    pub fn action_definitions(&self) -> Vec<ActionDefinition> {
        self.registry().map_or_else(Vec::new, |snapshot| {
            snapshot
                .actions
                .into_iter()
                .map(|record| ActionDefinition {
                    action_id: record.action_id,
                    action_version: 1,
                    localized_title_key: "actions.project_custom".to_owned(),
                    display_title: Some(record.title),
                    default_shortcut: record.shortcut,
                    category: "project".to_owned(),
                    owner: ActionOwner::Service,
                    parameter_schema_version: 1,
                    result_schema_version: 1,
                    authorization_class: ActionAuthorizationClass::Owner,
                    interaction_class: ActionInteractionClass::ConfirmationRequired,
                    required_desktop_capability: None,
                    limits: ActionLimits {
                        // Parameters are fixed by the manifest; callers may supply only `{}`.
                        max_parameter_bytes: 2,
                        max_result_bytes: 1_024,
                        timeout_ms: 30_000,
                    },
                })
                .collect()
        })
    }

    /// Create a mandatory confirmation state for an exact registered definition.
    pub fn begin_invocation(
        &self,
        invocation_id: Uuid,
        action_id: &str,
        provider: ProviderWindowGeneration,
    ) -> Result<ConfirmationChallenge, CustomActionError> {
        self.begin_invocation_at(
            invocation_id,
            action_id,
            provider,
            unix_ms(),
            Instant::now(),
        )
    }

    fn begin_invocation_at(
        &self,
        invocation_id: Uuid,
        action_id: &str,
        provider: ProviderWindowGeneration,
        now_unix_ms: u64,
        now: Instant,
    ) -> Result<ConfirmationChallenge, CustomActionError> {
        let mut inner = self
            .inner
            .lock()
            .expect("custom action lock is not poisoned");
        if inner.invocations.contains_key(&invocation_id) {
            return Err(CustomActionError::DuplicateInvocation);
        }
        if inner.invocations.len() >= MAX_INVOCATIONS {
            let oldest_terminal = inner
                .invocations
                .iter()
                .filter(|(_, invocation)| {
                    invocation.state != CustomInvocationState::AwaitingConfirmation
                })
                .min_by_key(|(_, invocation)| invocation.updated_at_unix_ms)
                .map(|(id, _)| *id);
            if let Some(oldest_terminal) = oldest_terminal {
                inner.invocations.remove(&oldest_terminal);
            } else {
                return Err(CustomActionError::InvocationLimit);
            }
        }
        let registry = inner
            .registry
            .as_ref()
            .ok_or(CustomActionError::ActionNotFound)?;
        let registered = registry
            .actions
            .get(action_id)
            .ok_or(CustomActionError::ActionNotFound)?;
        let definition = registered.definition.clone();
        let definition_sha256 = registered.confirmation_definition_sha256.clone();
        let project_root = registry.canonical_root.clone();
        let manifest_bytes = registry.manifest_bytes.clone();
        let project_label = registry.project_label.clone();
        let executable_class = match &definition.executable {
            agent_workspace_config::ProjectActionExecutable::ProjectRelativePath { .. } => {
                ExecutableClass::ProjectRelative
            }
            agent_workspace_config::ProjectActionExecutable::ApprovedName { .. } => {
                ExecutableClass::ApprovedName
            }
        };
        let argument_count = u32::try_from(definition.args.len()).unwrap_or(u32::MAX);
        let nonce = Uuid::new_v4();
        let expires_at_unix_ms = now_unix_ms.saturating_add(duration_ms(CONFIRMATION_TTL));
        let challenge = make_challenge(
            &self.server_secret,
            ChallengeBinding {
                invocation_id,
                nonce,
                provider,
                definition_sha256: &definition_sha256,
                action_id,
                display_title: &definition.title,
                executable_class,
                argument_count,
                project_label: &project_label,
                expires_at_unix_ms,
            },
        );
        let response = ConfirmationChallenge {
            invocation_id,
            nonce,
            challenge: challenge.clone(),
            provider,
            confirmation_definition_sha256: definition_sha256.clone(),
            action_id: action_id.to_owned(),
            display_title: definition.title.clone(),
            executable_class,
            argument_count,
            project_label: project_label.clone(),
            expires_at_unix_ms,
        };
        inner.invocations.insert(
            invocation_id,
            Invocation {
                action_id: action_id.to_owned(),
                project_label,
                provider,
                request: Arc::new(ExecutionRequest {
                    invocation_id: invocation_id.to_string(),
                    action: definition,
                    project_root,
                    manifest_bytes,
                }),
                nonce,
                challenge,
                definition_sha256,
                expires_at_unix_ms,
                expires_at: now + CONFIRMATION_TTL,
                confirmation_consumed: false,
                state: CustomInvocationState::AwaitingConfirmation,
                accepted_at_unix_ms: now_unix_ms,
                updated_at_unix_ms: now_unix_ms,
                cancellation: CancellationToken::default(),
                result: None,
            },
        );
        Ok(response)
    }

    /// Consume an exact confirmation and execute only through an available secure containment
    /// backend. Availability, runtime errors, and results remain content-free.
    pub async fn confirm(
        &self,
        response: &ConfirmationResponse,
    ) -> Result<CustomActionAudit, CustomActionError> {
        let (request, cancellation) =
            self.prepare_confirmation_at(response, unix_ms(), Instant::now())?;
        if !containment_availability().await.is_available() {
            self.finish_with_policy(
                response.invocation_id,
                CustomInvocationState::ContainmentUnavailable,
                CustomTerminalCode::ContainmentUnavailable,
            );
            return Err(CustomActionError::ContainmentUnavailable);
        }
        match execute(&self.execution_policy, &request, &cancellation).await {
            Ok(result) => {
                let bounded = bounded_execution_result(&result);
                let state = match bounded.terminal_code {
                    CustomTerminalCode::Succeeded => CustomInvocationState::Completed,
                    CustomTerminalCode::Cancelled => CustomInvocationState::Cancelled,
                    _ => CustomInvocationState::Failed,
                };
                let mut inner = self
                    .inner
                    .lock()
                    .expect("custom action lock is not poisoned");
                let invocation = inner
                    .invocations
                    .get_mut(&response.invocation_id)
                    .ok_or(CustomActionError::ExecutionFailed)?;
                invocation.state = state;
                invocation.updated_at_unix_ms = unix_ms();
                invocation.result = Some(bounded);
                Ok(invocation.audit(response.invocation_id))
            }
            Err(error) => {
                let _ = bounded_runtime_error(error);
                self.finish_with_policy(
                    response.invocation_id,
                    CustomInvocationState::Failed,
                    CustomTerminalCode::RuntimeRejected,
                );
                Err(CustomActionError::ExecutionFailed)
            }
        }
    }

    #[cfg(test)]
    fn confirm_at(
        &self,
        response: &ConfirmationResponse,
        now_unix_ms: u64,
        now: Instant,
    ) -> Result<CustomActionAudit, CustomActionError> {
        let _ = self.prepare_confirmation_at(response, now_unix_ms, now)?;
        self.finish_with_policy(
            response.invocation_id,
            CustomInvocationState::ContainmentUnavailable,
            CustomTerminalCode::ContainmentUnavailable,
        );
        Err(CustomActionError::ContainmentUnavailable)
    }

    fn prepare_confirmation_at(
        &self,
        response: &ConfirmationResponse,
        now_unix_ms: u64,
        now: Instant,
    ) -> Result<(Arc<ExecutionRequest>, CancellationToken), CustomActionError> {
        let mut inner = self
            .inner
            .lock()
            .expect("custom action lock is not poisoned");
        let invocation = inner
            .invocations
            .get_mut(&response.invocation_id)
            .ok_or(CustomActionError::ConfirmationMismatch)?;
        if invocation.confirmation_consumed {
            return Err(CustomActionError::ConfirmationReplay);
        }
        if invocation.state != CustomInvocationState::AwaitingConfirmation {
            return Err(CustomActionError::ConfirmationMismatch);
        }
        if now > invocation.expires_at {
            invocation.confirmation_consumed = true;
            invocation.state = CustomInvocationState::PolicyDenied;
            invocation.updated_at_unix_ms = now_unix_ms;
            invocation.result = Some(policy_result(CustomTerminalCode::PolicyDenied));
            return Err(CustomActionError::ConfirmationExpired);
        }
        let expected = make_challenge(
            &self.server_secret,
            ChallengeBinding {
                invocation_id: response.invocation_id,
                nonce: response.nonce,
                provider: response.provider,
                definition_sha256: &response.confirmation_definition_sha256,
                action_id: &invocation.action_id,
                display_title: &invocation.request.action.title,
                executable_class: invocation.request.summary().executable_class,
                argument_count: u32::try_from(invocation.request.action.args.len())
                    .unwrap_or(u32::MAX),
                project_label: &invocation.project_label,
                expires_at_unix_ms: invocation.expires_at_unix_ms,
            },
        );
        let exact = response.nonce == invocation.nonce
            && response.provider == invocation.provider
            && response.confirmation_definition_sha256 == invocation.definition_sha256
            && constant_time_equal(
                response.challenge.as_bytes(),
                invocation.challenge.as_bytes(),
            )
            && constant_time_equal(expected.as_bytes(), invocation.challenge.as_bytes());
        if !exact {
            invocation.confirmation_consumed = true;
            invocation.state = CustomInvocationState::PolicyDenied;
            invocation.updated_at_unix_ms = now_unix_ms;
            invocation.result = Some(policy_result(CustomTerminalCode::PolicyDenied));
            return Err(CustomActionError::ConfirmationMismatch);
        }
        invocation.confirmation_consumed = true;
        invocation.updated_at_unix_ms = now_unix_ms;
        if !self.policy_enabled {
            invocation.state = CustomInvocationState::PolicyDenied;
            invocation.result = Some(policy_result(CustomTerminalCode::PolicyDenied));
            return Err(CustomActionError::PolicyDenied);
        }
        invocation.state = CustomInvocationState::Executing;
        Ok((
            Arc::clone(&invocation.request),
            invocation.cancellation.clone(),
        ))
    }

    fn finish_with_policy(
        &self,
        invocation_id: Uuid,
        state: CustomInvocationState,
        terminal_code: CustomTerminalCode,
    ) {
        let mut inner = self
            .inner
            .lock()
            .expect("custom action lock is not poisoned");
        if let Some(invocation) = inner.invocations.get_mut(&invocation_id) {
            invocation.state = state;
            invocation.updated_at_unix_ms = unix_ms();
            invocation.result = Some(policy_result(terminal_code));
        }
    }

    /// Cancel an invocation before execution. Cancellation is idempotent only through the first
    /// successful transition and invalidates any outstanding confirmation.
    pub fn cancel(&self, invocation_id: Uuid) -> Result<CustomActionAudit, CustomActionError> {
        let now = unix_ms();
        let mut inner = self
            .inner
            .lock()
            .expect("custom action lock is not poisoned");
        let invocation = inner
            .invocations
            .get_mut(&invocation_id)
            .ok_or(CustomActionError::NotCancellable)?;
        if !matches!(
            invocation.state,
            CustomInvocationState::AwaitingConfirmation | CustomInvocationState::Executing
        ) {
            return Err(CustomActionError::NotCancellable);
        }
        invocation.cancellation.cancel();
        if invocation.state == CustomInvocationState::AwaitingConfirmation {
            invocation.confirmation_consumed = true;
            invocation.state = CustomInvocationState::Cancelled;
            invocation.result = Some(policy_result(CustomTerminalCode::Cancelled));
        }
        invocation.updated_at_unix_ms = now;
        Ok(invocation.audit(invocation_id))
    }

    /// Return content-free audit state for an invocation.
    #[must_use]
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn audit(&self, invocation_id: Uuid) -> Option<CustomActionAudit> {
        self.inner
            .lock()
            .expect("custom action lock is not poisoned")
            .invocations
            .get(&invocation_id)
            .map(|invocation| invocation.audit(invocation_id))
    }

    #[allow(clippy::too_many_lines)]
    fn load_registry(
        &self,
        root: &Path,
        project_label: &str,
    ) -> Result<TrustedRegistry, CustomActionError> {
        if project_label.is_empty()
            || project_label.trim() != project_label
            || project_label.chars().count() > 80
            || project_label.chars().any(char::is_control)
        {
            return Err(CustomActionError::InvalidProjectLabel);
        }
        let canonical_root =
            fs::canonicalize(root).map_err(|_| CustomActionError::InvalidProjectRoot)?;
        if !fs::metadata(&canonical_root).is_ok_and(|metadata| metadata.is_dir()) {
            return Err(CustomActionError::InvalidProjectRoot);
        }
        let manifest_path = canonical_root.join(PROJECT_ACTION_MANIFEST_PATH);
        let link_metadata = fs::symlink_metadata(&manifest_path)
            .map_err(|_| CustomActionError::ManifestUnavailable)?;
        if !link_metadata.file_type().is_file() || link_metadata.file_type().is_symlink() {
            return Err(CustomActionError::ManifestUnavailable);
        }
        let canonical_manifest =
            fs::canonicalize(&manifest_path).map_err(|_| CustomActionError::ManifestUnavailable)?;
        if !canonical_manifest.starts_with(&canonical_root) {
            return Err(CustomActionError::ManifestUnavailable);
        }
        let metadata = fs::metadata(&canonical_manifest)
            .map_err(|_| CustomActionError::ManifestUnavailable)?;
        if metadata.len() > u64::try_from(MAX_PROJECT_ACTION_MANIFEST_BYTES).unwrap_or(u64::MAX) {
            return Err(CustomActionError::InvalidManifest);
        }
        let bytes =
            fs::read(&canonical_manifest).map_err(|_| CustomActionError::ManifestUnavailable)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let root_text = canonical_root
            .to_str()
            .ok_or(CustomActionError::InvalidProjectRoot)?;
        let trusted = self.action_config.trusted_projects.iter().any(|record| {
            record.canonical_root == root_text
                && constant_time_equal(record.manifest_sha256.as_bytes(), digest.as_bytes())
        });
        if !trusted {
            return Err(CustomActionError::UntrustedManifest);
        }
        let manifest = ProjectActionManifest::parse_json(&bytes, &self.action_config)
            .map_err(|_| CustomActionError::InvalidManifest)?;
        let mut actions = BTreeMap::new();
        let mut shortcut_actions: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for definition in manifest.actions {
            if let ProjectActionExecutable::ApprovedName { name } = &definition.executable
                && !self
                    .execution_policy
                    .approved_executables
                    .iter()
                    .any(|approved| approved.name == *name)
            {
                continue;
            }
            let request = ExecutionRequest {
                invocation_id: "definition-digest".to_owned(),
                action: definition.clone(),
                project_root: canonical_root.clone(),
                manifest_bytes: bytes.clone(),
            };
            let definition_sha256 =
                confirmation_definition_sha256(&self.execution_policy, &request)
                    .map_err(|_| CustomActionError::InvalidManifest)?;
            if let Some(shortcut) = &definition.shortcut {
                shortcut_actions
                    .entry(shortcut.clone())
                    .or_default()
                    .push(definition.id.clone());
            }
            actions.insert(
                definition.id.clone(),
                RegisteredAction {
                    definition,
                    confirmation_definition_sha256: definition_sha256,
                },
            );
        }
        let shortcut_collisions: Vec<_> = shortcut_actions
            .into_iter()
            .filter_map(|(shortcut, mut action_ids)| {
                if action_ids.len() < 2 {
                    return None;
                }
                action_ids.sort();
                Some(ShortcutCollision {
                    shortcut,
                    action_ids,
                })
            })
            .collect();
        let colliding: BTreeSet<_> = shortcut_collisions
            .iter()
            .map(|collision| collision.shortcut.as_str())
            .collect();
        let records = actions
            .values()
            .map(|registered| CustomActionRecord {
                action_id: registered.definition.id.clone(),
                title: registered.definition.title.clone(),
                shortcut: registered.definition.shortcut.clone(),
                shortcut_collides: registered
                    .definition
                    .shortcut
                    .as_deref()
                    .is_some_and(|shortcut| colliding.contains(shortcut)),
                confirmation_definition_sha256: registered.confirmation_definition_sha256.clone(),
            })
            .collect();
        Ok(TrustedRegistry {
            canonical_root,
            project_label: project_label.to_owned(),
            manifest_bytes: bytes,
            manifest_sha256: digest.clone(),
            actions,
            snapshot: CustomActionRegistrySnapshot {
                revision: 0,
                manifest_sha256: digest,
                actions: records,
                shortcut_collisions,
            },
        })
    }
}

impl Invocation {
    fn audit(&self, invocation_id: Uuid) -> CustomActionAudit {
        CustomActionAudit {
            invocation_id,
            action_id: self.action_id.clone(),
            provider: self.provider,
            state: self.state,
            terminal_code: self.result.as_ref().map(|result| result.terminal_code),
            accepted_at_unix_ms: self.accepted_at_unix_ms,
            updated_at_unix_ms: self.updated_at_unix_ms,
            result: self.result.clone(),
        }
    }
}

/// Convert a runtime success without retaining raw captured output.
#[must_use]
#[allow(dead_code)] // Used when secure containment permits runtime completion.
pub fn bounded_execution_result(result: &ExecutionResult) -> BoundedExecutionResult {
    let summary = result.summary();
    BoundedExecutionResult {
        terminal_code: match summary.exit_class {
            ExitClass::Success => CustomTerminalCode::Succeeded,
            ExitClass::Failure => CustomTerminalCode::Failed,
            ExitClass::Signalled => CustomTerminalCode::Signalled,
            ExitClass::TimedOut => CustomTerminalCode::TimedOut,
            ExitClass::Cancelled => CustomTerminalCode::Cancelled,
        },
        exit_code: summary.exit_code,
        stdout_bytes: summary.stdout_bytes,
        stderr_bytes: summary.stderr_bytes,
        output_truncated: summary.output_truncated,
        redaction_count: summary.redaction_count,
        duration_ms: summary.duration_ms,
    }
}

/// Convert the runtime audit representation without adding sensitive execution inputs.
#[must_use]
#[allow(dead_code)] // Used when secure containment permits runtime completion.
pub fn bounded_runtime_audit(audit: &RuntimeAuditSummary) -> BoundedExecutionResult {
    BoundedExecutionResult {
        terminal_code: match audit.exit_class {
            ExitClass::Success => CustomTerminalCode::Succeeded,
            ExitClass::Failure => CustomTerminalCode::Failed,
            ExitClass::Signalled => CustomTerminalCode::Signalled,
            ExitClass::TimedOut => CustomTerminalCode::TimedOut,
            ExitClass::Cancelled => CustomTerminalCode::Cancelled,
        },
        exit_code: audit.exit_code,
        stdout_bytes: audit.stdout_bytes,
        stderr_bytes: audit.stderr_bytes,
        output_truncated: audit.output_truncated,
        redaction_count: audit.redaction_count,
        duration_ms: audit.duration_ms,
    }
}

/// Map runtime rejection to the single content-free terminal category.
#[must_use]
#[allow(dead_code)] // Used when secure containment permits runtime completion.
pub const fn bounded_runtime_error(_error: ExecutionError) -> CustomTerminalCode {
    CustomTerminalCode::RuntimeRejected
}

fn policy_result(terminal_code: CustomTerminalCode) -> BoundedExecutionResult {
    BoundedExecutionResult {
        terminal_code,
        exit_code: None,
        stdout_bytes: 0,
        stderr_bytes: 0,
        output_truncated: false,
        redaction_count: 0,
        duration_ms: 0,
    }
}

fn invalidate_pending_invocations(invocations: &mut BTreeMap<Uuid, Invocation>, now_unix_ms: u64) {
    for invocation in invocations
        .values_mut()
        .filter(|invocation| invocation.state == CustomInvocationState::AwaitingConfirmation)
    {
        invocation.confirmation_consumed = true;
        invocation.cancellation.cancel();
        invocation.state = CustomInvocationState::PolicyDenied;
        invocation.updated_at_unix_ms = now_unix_ms;
        invocation.result = Some(policy_result(CustomTerminalCode::PolicyDenied));
    }
}

#[derive(Clone, Copy)]
struct ChallengeBinding<'a> {
    invocation_id: Uuid,
    nonce: Uuid,
    provider: ProviderWindowGeneration,
    definition_sha256: &'a str,
    action_id: &'a str,
    display_title: &'a str,
    executable_class: ExecutableClass,
    argument_count: u32,
    project_label: &'a str,
    expires_at_unix_ms: u64,
}

fn make_challenge(secret: &[u8; 32], binding: ChallengeBinding<'_>) -> String {
    let mut digest = Sha256::new();
    digest.update(b"agent-workspace-custom-action-challenge-v1\0");
    digest.update(secret);
    digest.update(binding.invocation_id.as_bytes());
    digest.update(binding.nonce.as_bytes());
    digest.update(binding.provider.provider_id.as_bytes());
    digest.update(binding.provider.provider_epoch.to_be_bytes());
    digest.update(binding.provider.provider_lease_id.as_bytes());
    digest.update(binding.provider.window_id.as_bytes());
    digest.update(binding.provider.generation.to_be_bytes());
    update_digest_field(&mut digest, binding.definition_sha256.as_bytes());
    update_digest_field(&mut digest, binding.action_id.as_bytes());
    update_digest_field(&mut digest, binding.display_title.as_bytes());
    digest.update([match binding.executable_class {
        ExecutableClass::ProjectRelative => 1,
        ExecutableClass::ApprovedName => 2,
    }]);
    digest.update(binding.argument_count.to_be_bytes());
    update_digest_field(&mut digest, binding.project_label.as_bytes());
    digest.update(binding.expires_at_unix_ms.to_be_bytes());
    format!("{:x}", digest.finalize())
}

fn update_digest_field(digest: &mut Sha256, value: &[u8]) {
    digest.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    digest.update(value);
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, duration_ms)
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use tempfile::TempDir;

    use agent_workspace_config::{
        ProjectActionExecutable, ProjectActionWorkingDirectory, TrustedProjectRecord,
    };

    fn definition(id: &str, shortcut: Option<&str>) -> ProjectActionDefinition {
        ProjectActionDefinition {
            id: id.to_owned(),
            title: format!("Title {id}"),
            executable: ProjectActionExecutable::ApprovedName {
                name: "tool".into(),
            },
            args: vec!["literal-parameter".into()],
            working_directory: ProjectActionWorkingDirectory::ProjectRoot,
            shortcut: shortcut.map(str::to_owned),
            environment: Vec::new(),
        }
    }

    fn manifest(definitions: Vec<ProjectActionDefinition>) -> Vec<u8> {
        serde_json::to_vec(&ProjectActionManifest {
            schema_version: 1,
            actions: definitions,
        })
        .unwrap()
    }

    fn fixture(
        enabled: bool,
        definitions: Vec<ProjectActionDefinition>,
    ) -> (TempDir, CustomActionCoordinator) {
        fixture_with_schema(enabled, definitions, BTreeMap::new())
    }

    fn fixture_with_schema(
        enabled: bool,
        definitions: Vec<ProjectActionDefinition>,
        file_argument_schemas: BTreeMap<String, BTreeSet<usize>>,
    ) -> (TempDir, CustomActionCoordinator) {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join(".cmux")).unwrap();
        let bytes = manifest(definitions);
        fs::write(root.path().join(PROJECT_ACTION_MANIFEST_PATH), &bytes).unwrap();
        let coordinator =
            coordinator_for_bytes(root.path(), enabled, &bytes, file_argument_schemas);
        (root, coordinator)
    }

    fn coordinator_for_bytes(
        root: &Path,
        enabled: bool,
        bytes: &[u8],
        file_argument_schemas: BTreeMap<String, BTreeSet<usize>>,
    ) -> CustomActionCoordinator {
        let canonical = fs::canonicalize(root).unwrap();
        let trusted = TrustedProjectRecord {
            canonical_root: canonical.to_str().unwrap().to_owned(),
            manifest_sha256: format!("{:x}", Sha256::digest(bytes)),
            trusted_at_unix_ms: 1,
        };
        let config = Arc::new(ActionConfig {
            approved_executables: vec!["tool".into()],
            trusted_projects: vec![trusted.clone()],
        });
        let policy = Arc::new(ExecutionPolicy {
            trusted_projects: vec![trusted],
            approved_executables: vec![agent_workspace_action_runtime::ApprovedExecutable {
                name: "tool".into(),
                path: PathBuf::from("/bin/true"),
            }],
            safe_environment: BTreeMap::new(),
            redaction_values: Vec::new(),
            file_argument_schemas,
            output_limit_bytes: 1024,
            timeout: Duration::from_secs(1),
        });
        CustomActionCoordinator::new(config, policy, enabled)
    }

    fn provider() -> ProviderWindowGeneration {
        ProviderWindowGeneration {
            provider_id: Uuid::new_v4(),
            provider_epoch: 3,
            provider_lease_id: Uuid::new_v4(),
            window_id: Uuid::new_v4(),
            generation: 7,
        }
    }

    fn response(challenge: &ConfirmationChallenge) -> ConfirmationResponse {
        ConfirmationResponse {
            invocation_id: challenge.invocation_id,
            nonce: challenge.nonce,
            challenge: challenge.challenge.clone(),
            provider: challenge.provider,
            confirmation_definition_sha256: challenge.confirmation_definition_sha256.clone(),
        }
    }

    fn begin_at(
        coordinator: &CustomActionCoordinator,
        invocation_id: Uuid,
        action_id: &str,
        provider: ProviderWindowGeneration,
        now_unix_ms: u64,
    ) -> ConfirmationChallenge {
        coordinator
            .begin_invocation_at(
                invocation_id,
                action_id,
                provider,
                now_unix_ms,
                Instant::now(),
            )
            .unwrap()
    }

    fn confirm_at_ms(
        coordinator: &CustomActionCoordinator,
        response: &ConfirmationResponse,
        now_unix_ms: u64,
    ) -> Result<CustomActionAudit, CustomActionError> {
        coordinator.confirm_at(response, now_unix_ms, Instant::now())
    }

    #[test]
    fn exact_bytes_trust_and_strict_parsing_are_required() {
        let (root, coordinator) = fixture(false, vec![definition("project.test.run", None)]);
        assert!(coordinator.refresh(root.path()).is_ok());
        fs::write(
            root.path().join(PROJECT_ACTION_MANIFEST_PATH),
            b"{\"schemaVersion\":1,\"actions\":[]}",
        )
        .unwrap();
        assert_eq!(
            coordinator.refresh(root.path()),
            Err(CustomActionError::UntrustedManifest)
        );
        assert!(coordinator.registry().is_none());

        let invalid_root = TempDir::new().unwrap();
        fs::create_dir(invalid_root.path().join(".cmux")).unwrap();
        let invalid = br#"{"schemaVersion":1,"actions":[],"unknown":true}"#;
        fs::write(
            invalid_root.path().join(PROJECT_ACTION_MANIFEST_PATH),
            invalid,
        )
        .unwrap();
        let invalid_coordinator =
            coordinator_for_bytes(invalid_root.path(), false, invalid, BTreeMap::new());
        assert_eq!(
            invalid_coordinator.refresh(invalid_root.path()),
            Err(CustomActionError::InvalidManifest)
        );
    }

    #[test]
    fn changed_deleted_and_untrusted_manifests_invalidate_the_registry() {
        let (root, coordinator) = fixture(false, vec![definition("project.test.run", None)]);
        coordinator.refresh(root.path()).unwrap();
        let invocation_id = Uuid::new_v4();
        let challenge = coordinator
            .begin_invocation(invocation_id, "project.test.run", provider())
            .unwrap();
        fs::remove_file(root.path().join(PROJECT_ACTION_MANIFEST_PATH)).unwrap();
        assert_eq!(
            coordinator.refresh(root.path()),
            Err(CustomActionError::ManifestUnavailable)
        );
        assert!(coordinator.registry().is_none());
        assert_eq!(
            coordinator.confirm_at(&response(&challenge), unix_ms(), Instant::now()),
            Err(CustomActionError::ConfirmationReplay)
        );
        assert_eq!(
            coordinator.audit(invocation_id).unwrap().state,
            CustomInvocationState::PolicyDenied
        );
    }

    #[test]
    fn shortcut_collisions_are_reported_on_each_record() {
        let (root, coordinator) = fixture(
            false,
            vec![
                definition("project.test.a", Some("Primary+Shift+B")),
                definition("project.test.b", Some("Primary+Shift+B")),
            ],
        );
        let registry = coordinator.refresh(root.path()).unwrap();
        assert_eq!(registry.shortcut_collisions.len(), 1);
        assert!(
            registry
                .actions
                .iter()
                .all(|record| record.shortcut_collides)
        );
        let definitions = coordinator.action_definitions();
        assert!(definitions.iter().all(|definition| {
            definition.display_title.is_some()
                && definition.default_shortcut.as_deref() == Some("Primary+Shift+B")
                && definition.interaction_class == ActionInteractionClass::ConfirmationRequired
                && definition.owner == ActionOwner::Service
        }));
    }

    #[test]
    fn unavailable_approved_names_are_not_advertised_or_invocable() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join(".cmux")).unwrap();
        let bytes = manifest(vec![definition("project.test.unavailable", None)]);
        fs::write(root.path().join(PROJECT_ACTION_MANIFEST_PATH), &bytes).unwrap();
        let canonical = fs::canonicalize(root.path()).unwrap();
        let trusted = TrustedProjectRecord {
            canonical_root: canonical.to_str().unwrap().to_owned(),
            manifest_sha256: format!("{:x}", Sha256::digest(&bytes)),
            trusted_at_unix_ms: 1,
        };
        let coordinator = CustomActionCoordinator::new(
            Arc::new(ActionConfig {
                approved_executables: vec!["tool".into()],
                trusted_projects: vec![trusted.clone()],
            }),
            Arc::new(ExecutionPolicy {
                trusted_projects: vec![trusted],
                approved_executables: Vec::new(),
                safe_environment: BTreeMap::new(),
                redaction_values: Vec::new(),
                file_argument_schemas: BTreeMap::new(),
                output_limit_bytes: 1024,
                timeout: Duration::from_secs(1),
            }),
            true,
        );

        let registry = coordinator.refresh(root.path()).unwrap();
        assert!(registry.actions.is_empty());
        assert!(coordinator.action_definitions().is_empty());
        assert_eq!(
            coordinator.begin_invocation(Uuid::new_v4(), "project.test.unavailable", provider()),
            Err(CustomActionError::ActionNotFound)
        );
    }

    #[test]
    fn invocation_always_enters_confirmation_and_default_policy_never_executes() {
        let (root, coordinator) = fixture(false, vec![definition("project.test.run", None)]);
        coordinator
            .refresh_project(root.path(), "Example project")
            .unwrap();
        let invocation_id = Uuid::new_v4();
        let challenge = begin_at(
            &coordinator,
            invocation_id,
            "project.test.run",
            provider(),
            10,
        );
        assert_eq!(challenge.action_id, "project.test.run");
        assert_eq!(challenge.display_title, "Title project.test.run");
        assert_eq!(challenge.executable_class, ExecutableClass::ApprovedName);
        assert_eq!(challenge.argument_count, 1);
        assert_eq!(challenge.project_label, "Example project");
        assert_eq!(
            coordinator.audit(invocation_id).unwrap().state,
            CustomInvocationState::AwaitingConfirmation
        );
        assert_eq!(
            confirm_at_ms(&coordinator, &response(&challenge), 11),
            Err(CustomActionError::PolicyDenied)
        );
        assert_eq!(
            coordinator.audit(invocation_id).unwrap().state,
            CustomInvocationState::PolicyDenied
        );
    }

    #[test]
    fn forged_or_mismatched_confirmation_fails_closed_and_consumes_the_challenge() {
        let (root, coordinator) = fixture(false, vec![definition("project.test.run", None)]);
        coordinator.refresh(root.path()).unwrap();
        let challenge = begin_at(
            &coordinator,
            Uuid::new_v4(),
            "project.test.run",
            provider(),
            10,
        );
        let mut forged = response(&challenge);
        forged.provider.generation += 1;
        assert_eq!(
            confirm_at_ms(&coordinator, &forged, 11),
            Err(CustomActionError::ConfirmationMismatch)
        );
        assert_eq!(
            confirm_at_ms(&coordinator, &response(&challenge), 11),
            Err(CustomActionError::ConfirmationReplay)
        );
    }

    #[test]
    fn confirmation_is_single_use_and_expiry_fails_closed() {
        let (root, coordinator) = fixture(false, vec![definition("project.test.run", None)]);
        coordinator.refresh(root.path()).unwrap();
        let first = begin_at(
            &coordinator,
            Uuid::new_v4(),
            "project.test.run",
            provider(),
            10,
        );
        assert_eq!(
            confirm_at_ms(&coordinator, &response(&first), 11),
            Err(CustomActionError::PolicyDenied)
        );
        assert_eq!(
            confirm_at_ms(&coordinator, &response(&first), 12),
            Err(CustomActionError::ConfirmationReplay)
        );
        let second = begin_at(
            &coordinator,
            Uuid::new_v4(),
            "project.test.run",
            provider(),
            10,
        );
        coordinator
            .inner
            .lock()
            .unwrap()
            .invocations
            .get_mut(&second.invocation_id)
            .unwrap()
            .expires_at = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .unwrap();
        assert_eq!(
            confirm_at_ms(
                &coordinator,
                &response(&second),
                second.expires_at_unix_ms + 1
            ),
            Err(CustomActionError::ConfirmationExpired)
        );
        assert_eq!(
            confirm_at_ms(
                &coordinator,
                &response(&second),
                second.expires_at_unix_ms + 1
            ),
            Err(CustomActionError::ConfirmationReplay)
        );
    }

    #[test]
    fn definition_binding_changes_with_manifest_parameters_and_file_schema() {
        let base_definition = definition("project.test.run", None);
        let (root, coordinator) = fixture(false, vec![base_definition.clone()]);
        let first = coordinator.refresh(root.path()).unwrap().actions[0]
            .confirmation_definition_sha256
            .clone();
        let mut changed = base_definition;
        changed.args.push("changed".into());
        let (other_root, other) = fixture(false, vec![changed]);
        let second = other.refresh(other_root.path()).unwrap().actions[0]
            .confirmation_definition_sha256
            .clone();
        assert_ne!(first, second);

        let mut schemas = BTreeMap::new();
        schemas.insert("project.test.run".to_owned(), BTreeSet::from([0]));
        let (schema_root, schema_coordinator) =
            fixture_with_schema(false, vec![definition("project.test.run", None)], schemas);
        let with_schema = schema_coordinator
            .refresh(schema_root.path())
            .unwrap()
            .actions[0]
            .confirmation_definition_sha256
            .clone();
        assert_ne!(first, with_schema);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn cancellation_consumes_confirmation_and_audit_is_content_free() {
        let (root, coordinator) = fixture(false, vec![definition("project.test.run", None)]);
        coordinator.refresh(root.path()).unwrap();
        let invocation_id = Uuid::new_v4();
        let challenge = coordinator
            .begin_invocation(invocation_id, "project.test.run", provider())
            .unwrap();
        let audit = coordinator.cancel(invocation_id).unwrap();
        assert_eq!(audit.state, CustomInvocationState::Cancelled);
        assert_eq!(
            coordinator.confirm_at(&response(&challenge), unix_ms(), Instant::now()),
            Err(CustomActionError::ConfirmationReplay)
        );
        let debug = format!("{audit:?} {coordinator:?}");
        assert!(!debug.contains("literal-parameter"));
        assert!(!debug.contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn enabled_policy_still_fails_when_secure_containment_is_unavailable() {
        let (root, coordinator) = fixture(true, vec![definition("project.test.run", None)]);
        coordinator.refresh(root.path()).unwrap();
        let invocation_id = Uuid::new_v4();
        let challenge = coordinator
            .begin_invocation(invocation_id, "project.test.run", provider())
            .unwrap();
        assert_eq!(
            coordinator.confirm_at(&response(&challenge), unix_ms(), Instant::now()),
            Err(CustomActionError::ContainmentUnavailable)
        );
        assert_eq!(
            coordinator.audit(invocation_id).unwrap().state,
            CustomInvocationState::ContainmentUnavailable
        );
    }
}

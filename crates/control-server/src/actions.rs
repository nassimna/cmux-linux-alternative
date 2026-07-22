//! Closed public-action registry and durable desktop action lifecycle.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::Write as _,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use agent_workspace_action_runtime::{ApprovedExecutable, ExecutionPolicy};
use agent_workspace_config::{ActionConfig, ConfigStore};
use agent_workspace_core::{DomainError, GroupId, MAX_SAFE_INTEGER, MutationOutcome, WorkspaceId};
use agent_workspace_protocol::{
    ACTION_CURSOR_TTL_SECONDS, ActionAuthorizationClass, ActionCancelParams, ActionCancelResult,
    ActionDefinition, ActionErrorCode, ActionInteractionClass, ActionInvocationChangedEvent,
    ActionInvocationSnapshot, ActionInvocationState, ActionInvocationTarget, ActionInvokeParams,
    ActionInvokeResult, ActionLimits, ActionListParams, ActionListResult, ActionOwner,
    ActionRegistryChangeReason, ActionRegistryChangedEvent, ActionTerminalCode,
    DesktopActionAcknowledgeParams, DesktopActionAcknowledgeResult, DesktopActionCompletionStatus,
    DesktopActionExecutionRequest, DesktopActionPollParams, DesktopActionStartClaimParams,
    DesktopActionStartClaimResult, DesktopActionStartDecision, DesktopProviderIdentityParams,
    EventEnvelope, MAX_ACTION_DEFINITIONS, MAX_ACTION_PAGE_SIZE,
    ProjectActionConfirmationChallenge, ProjectActionConfirmationDecision,
    ProjectActionConfirmationPollParams, ProjectActionConfirmationPollResult,
    ProjectActionConfirmationRespondParams, ProjectActionConfirmationRespondResult,
    ProjectActionExecutableClass, ResponseEnvelope,
};
use agent_workspace_runtime::{
    EpochIdempotentCommitResult, LaunchOptions, OperationFailure, RuntimeError, StoreError,
    epoch_idempotency_ticket,
};
use agent_workspace_storage::{
    ActionInvocationCreate, ActionInvocationCreateOutcome, ActionInvocationIdentity,
    ActionInvocationRecord, ActionInvocationState as StoredState, ActionLifecycleOutcome,
    ActionRecoveryQuery, ActionStartClaim, ActionTerminalAck, ActionTerminalOutcome,
    SqliteStateStore,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Notify, broadcast, mpsc};
use tracing::info;
use uuid::Uuid;

use super::{
    ControlContext,
    custom_actions::{
        ConfirmationChallenge, ConfirmationResponse, CustomActionAudit, CustomActionCoordinator,
        CustomActionError, CustomTerminalCode, ProviderWindowGeneration,
    },
    multi_window::{ActionProviderReservation, MultiWindowRuntime},
};

const COMMANDS: &[&str] = &[
    "action.list",
    "action.invoke",
    "action.cancel",
    "desktopAction.poll",
    "desktopAction.startClaim",
    "desktopAction.acknowledge",
    "projectAction.confirmationPoll",
    "projectAction.confirmationRespond",
];
const CURSOR_CAP: usize = 1_024;
const EVENT_CAP: usize = 256;
type ServiceMutation = Box<
    dyn FnOnce(&mut agent_workspace_core::ApplicationState) -> Result<MutationOutcome, DomainError>
        + Send,
>;

const PROJECT_CONFIRMATION_CAPABILITY: &str = "project-action-confirmation-v1";
const PROJECT_CONFIRMATION_QUEUE_CAP: usize = 256;
const PROJECT_CONFIRMATION_PROVIDER_CAP: usize = 32;

#[derive(Clone)]
pub(super) struct ActionRuntime {
    store: Arc<SqliteStateStore>,
    providers: MultiWindowRuntime,
    registry: ActionRegistry,
    events: broadcast::Sender<ActionRuntimeEvent>,
    project_actions: Option<ProjectActionService>,
}

#[derive(Clone)]
struct ProjectActionService {
    config_store: Arc<ConfigStore>,
    registry: Arc<StdMutex<ProjectRegistryState>>,
    confirmations: Arc<Mutex<BTreeMap<Uuid, QueuedConfirmation>>>,
    running: Arc<Mutex<BTreeMap<Uuid, CustomActionCoordinator>>>,
    confirmation_changed: Arc<Notify>,
}

#[derive(Default)]
struct ProjectRegistryState {
    coordinators: BTreeMap<String, CustomActionCoordinator>,
    routes: BTreeMap<String, String>,
}

#[derive(Clone)]
struct QueuedConfirmation {
    coordinator: CustomActionCoordinator,
    challenge: ProjectActionConfirmationChallenge,
    provider: ProviderWindowGeneration,
}

impl ProjectActionService {
    fn coordinator(&self, action_id: &str) -> Option<CustomActionCoordinator> {
        let state = self
            .registry
            .lock()
            .expect("project action registry lock is not poisoned");
        let key = state.routes.get(action_id)?;
        state.coordinators.get(key).cloned()
    }

    async fn rebuild(
        &self,
        workspaces: Vec<(String, PathBuf, String)>,
    ) -> Result<Vec<ActionDefinition>, ()> {
        let config_store = Arc::clone(&self.config_store);
        let built = tokio::task::spawn_blocking(move || {
            let config = config_store.load().map_err(|_| ())?.actions;
            Ok::<_, ()>(build_project_registry(config, workspaces))
        })
        .await
        .map_err(|_| ())??;
        let (state, definitions) = built;
        *self
            .registry
            .lock()
            .expect("project action registry lock is not poisoned") = state;
        Ok(definitions)
    }

    async fn enqueue(&self, queued: QueuedConfirmation) -> Result<(), ()> {
        let invocation_id = Uuid::parse_str(&queued.challenge.invocation_id).map_err(|_| ())?;
        let mut confirmations = self.confirmations.lock().await;
        if confirmations.len() >= PROJECT_CONFIRMATION_QUEUE_CAP
            || confirmations.contains_key(&invocation_id)
            || confirmations
                .values()
                .filter(|candidate| candidate.provider.provider_id == queued.provider.provider_id)
                .count()
                >= PROJECT_CONFIRMATION_PROVIDER_CAP
        {
            return Err(());
        }
        confirmations.insert(invocation_id, queued);
        drop(confirmations);
        self.confirmation_changed.notify_waiters();
        Ok(())
    }

    async fn remove(&self, invocation_id: Uuid) -> Option<QueuedConfirmation> {
        self.confirmations.lock().await.remove(&invocation_id)
    }

    fn clear_registry(&self) {
        *self
            .registry
            .lock()
            .expect("project action registry lock is not poisoned") =
            ProjectRegistryState::default();
    }
}

fn build_project_registry(
    config: ActionConfig,
    workspaces: Vec<(String, PathBuf, String)>,
) -> (ProjectRegistryState, Vec<ActionDefinition>) {
    let config = Arc::new(config);
    let reserved_action_ids: BTreeSet<_> = production_definitions()
        .into_iter()
        .map(|definition| definition.action_id)
        .collect();
    let mut state = ProjectRegistryState::default();
    let mut counts = BTreeMap::<String, usize>::new();
    for (workspace_id, root, label) in workspaces {
        let policy = Arc::new(project_execution_policy(&config));
        let coordinator = CustomActionCoordinator::new(Arc::clone(&config), policy, true);
        let Ok(snapshot) = coordinator.refresh_project(&root, &label) else {
            continue;
        };
        for action in snapshot.actions {
            if reserved_action_ids.contains(&action.action_id) {
                continue;
            }
            *counts.entry(action.action_id).or_default() += 1;
        }
        state.coordinators.insert(workspace_id, coordinator);
    }
    let mut definitions = Vec::new();
    for (workspace_id, coordinator) in &state.coordinators {
        for definition in coordinator.action_definitions() {
            if reserved_action_ids.contains(&definition.action_id) {
                continue;
            }
            if counts.get(&definition.action_id) != Some(&1) {
                continue;
            }
            state
                .routes
                .insert(definition.action_id.clone(), workspace_id.clone());
            definitions.push(definition);
        }
    }
    definitions.sort_by(|left, right| left.action_id.cmp(&right.action_id));
    (state, definitions)
}

fn project_execution_policy(config: &ActionConfig) -> ExecutionPolicy {
    ExecutionPolicy {
        trusted_projects: config.trusted_projects.clone(),
        approved_executables: resolve_approved_executables(&config.approved_executables),
        safe_environment: BTreeMap::new(),
        redaction_values: Vec::new(),
        file_argument_schemas: BTreeMap::new(),
        output_limit_bytes: 4 * 1_024,
        timeout: Duration::from_secs(30),
    }
}

/// Resolve configured bare names through the application's closed system-path map. Project data
/// and the process PATH never participate in this decision.
fn resolve_approved_executables(configured: &[String]) -> Vec<ApprovedExecutable> {
    configured
        .iter()
        .filter_map(|name| {
            let path = fixed_approved_executable_path(name)?;
            trusted_system_executable(path).then(|| ApprovedExecutable {
                name: name.clone(),
                path: PathBuf::from(path),
            })
        })
        .collect()
}

fn fixed_approved_executable_path(name: &str) -> Option<&'static str> {
    match name {
        // Approved names require an executable-specific closed argv policy. Keep the v1 catalog
        // limited to inert commands; shells, interpreters, build tools, package managers, and
        // other execution front ends would otherwise turn literal argv back into an eval mode.
        "true" => Some("/usr/bin/true"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn trusted_system_executable(path: &str) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    let path = std::path::Path::new(path);
    let Ok(link_metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if link_metadata.file_type().is_symlink()
        || !link_metadata.file_type().is_file()
        || link_metadata.uid() != 0
        || link_metadata.mode() & 0o022 != 0
        || link_metadata.mode() & 0o111 == 0
    {
        return false;
    }
    std::fs::canonicalize(path).is_ok_and(|canonical| canonical == path)
}

#[cfg(not(target_os = "linux"))]
fn trusted_system_executable(_path: &str) -> bool {
    false
}

#[derive(Clone, Debug)]
pub(super) enum ActionRuntimeEvent {
    Invocation(ActionInvocationChangedEvent),
    Registry(ActionRegistryChangedEvent),
}

#[derive(Debug)]
struct ActionAuditRecord<'a> {
    action_id: &'a str,
    action_version: u32,
    invocation_id: Uuid,
    correlation_id: Uuid,
    caller_id: Uuid,
    provider_id: Option<Uuid>,
    window_id: Option<Uuid>,
    authorization_decision: &'static str,
    lifecycle_state: StoredState,
    terminal_code: Option<&'a str>,
    accepted_at_ms: i64,
    updated_at_ms: i64,
    duration_ms: i64,
    parameter_bytes: usize,
    result_bytes: usize,
    redaction_count: usize,
}

impl ActionAuditRecord<'_> {
    fn emit(&self) {
        info!(
            action_id = self.action_id,
            action_version = self.action_version,
            invocation_id = %self.invocation_id,
            correlation_id = %self.correlation_id,
            caller_id = %self.caller_id,
            provider_id = ?self.provider_id,
            window_id = ?self.window_id,
            authorization_decision = self.authorization_decision,
            lifecycle_state = ?self.lifecycle_state,
            terminal_code = ?self.terminal_code,
            accepted_at_ms = self.accepted_at_ms,
            updated_at_ms = self.updated_at_ms,
            duration_ms = self.duration_ms,
            parameter_bytes = self.parameter_bytes,
            result_bytes = self.result_bytes,
            redaction_count = self.redaction_count,
            "action lifecycle audit"
        );
    }
}

fn action_audit(record: &ActionInvocationRecord) -> ActionAuditRecord<'_> {
    ActionAuditRecord {
        action_id: &record.action_id,
        action_version: record.action_version,
        invocation_id: record.invocation_id,
        correlation_id: record.correlation_id,
        caller_id: record.caller_id,
        provider_id: record
            .identity
            .as_ref()
            .map(|identity| identity.provider_id),
        window_id: record.identity.as_ref().map(|identity| identity.window_id),
        authorization_decision: "owner_authorized",
        lifecycle_state: record.state,
        terminal_code: record
            .terminal
            .as_ref()
            .map(|terminal| terminal.terminal_code.as_str()),
        accepted_at_ms: record.accepted_at_ms,
        updated_at_ms: record.updated_at_ms,
        duration_ms: record.updated_at_ms.saturating_sub(record.accepted_at_ms),
        parameter_bytes: record.parameters_json.len(),
        result_bytes: record
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.result_json.as_ref())
            .map_or(0, String::len),
        redaction_count: 0,
    }
}

impl ActionRuntimeEvent {
    fn into_envelope(self) -> EventEnvelope {
        match self {
            Self::Invocation(event) => EventEnvelope {
                event: event.event.clone(),
                revision: None,
                data: serde_json::to_value(event)
                    .expect("action invocation event serialization is infallible"),
            },
            Self::Registry(event) => EventEnvelope {
                event: event.event.clone(),
                revision: Some(event.registry_revision),
                data: serde_json::to_value(event)
                    .expect("action registry event serialization is infallible"),
            },
        }
    }
}

#[derive(Clone)]
pub(super) struct ActionRegistry {
    inner: Arc<StdMutex<RegistryInner>>,
}

struct RegistryInner {
    revision: u64,
    definitions: Vec<ActionDefinition>,
    cursors: BTreeMap<String, CursorEntry>,
    cursor_order: VecDeque<String>,
}

struct CursorEntry {
    revision: u64,
    offset: usize,
    expires_at: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RegistryError {
    Invalid,
    Expired,
}

impl ActionRegistry {
    fn production() -> Self {
        Self::new(production_definitions()).expect("the closed Tier A action registry is valid")
    }

    pub(super) fn new(mut definitions: Vec<ActionDefinition>) -> Result<Self, &'static str> {
        validate_definitions(&definitions)?;
        definitions.sort_by(|left, right| {
            (&left.action_id, left.action_version).cmp(&(&right.action_id, right.action_version))
        });
        Ok(Self {
            inner: Arc::new(StdMutex::new(RegistryInner {
                revision: 1,
                definitions,
                cursors: BTreeMap::new(),
                cursor_order: VecDeque::new(),
            })),
        })
    }

    fn definition(&self, action_id: &str) -> Option<ActionDefinition> {
        self.inner
            .lock()
            .expect("action registry lock is not poisoned")
            .definitions
            .iter()
            .find(|definition| definition.action_id == action_id)
            .cloned()
    }

    fn revision(&self) -> u64 {
        self.inner
            .lock()
            .expect("action registry lock is not poisoned")
            .revision
    }

    fn definitions(&self) -> Vec<ActionDefinition> {
        self.inner
            .lock()
            .expect("action registry lock is not poisoned")
            .definitions
            .clone()
    }

    fn list(
        &self,
        params: ActionListParams,
        epoch: Uuid,
    ) -> Result<ActionListResult, RegistryError> {
        self.list_at(params, epoch, Instant::now())
    }

    fn list_at(
        &self,
        params: ActionListParams,
        epoch: Uuid,
        now: Instant,
    ) -> Result<ActionListResult, RegistryError> {
        let mut inner = self
            .inner
            .lock()
            .expect("action registry lock is not poisoned");
        if let Some(token) = params.cursor.as_ref()
            && inner
                .cursors
                .get(token)
                .is_some_and(|entry| entry.expires_at <= now)
        {
            inner.cursors.remove(token);
            inner.cursor_order.retain(|queued| queued != token);
            return Err(RegistryError::Expired);
        }
        while inner.cursor_order.front().is_some_and(|token| {
            inner
                .cursors
                .get(token)
                .is_none_or(|entry| entry.expires_at <= now)
        }) {
            let token = inner.cursor_order.pop_front().expect("front cursor exists");
            inner.cursors.remove(&token);
        }
        let offset = if let Some(token) = params.cursor {
            let Some(cursor) = inner.cursors.remove(&token) else {
                return Err(RegistryError::Invalid);
            };
            inner.cursor_order.retain(|queued| queued != &token);
            if cursor.expires_at <= now {
                return Err(RegistryError::Expired);
            }
            if cursor.revision != inner.revision {
                return Err(RegistryError::Invalid);
            }
            cursor.offset
        } else {
            0
        };
        if offset > inner.definitions.len() {
            return Err(RegistryError::Invalid);
        }
        let limit = usize::from(params.limit).min(MAX_ACTION_PAGE_SIZE);
        let end = offset.saturating_add(limit).min(inner.definitions.len());
        let definitions = inner.definitions[offset..end].to_vec();
        let next_cursor = (end < inner.definitions.len()).then(|| {
            let token = Uuid::new_v4().simple().to_string();
            let revision = inner.revision;
            inner.cursors.insert(
                token.clone(),
                CursorEntry {
                    revision,
                    offset: end,
                    expires_at: now + Duration::from_secs(ACTION_CURSOR_TTL_SECONDS),
                },
            );
            inner.cursor_order.push_back(token.clone());
            while inner.cursor_order.len() > CURSOR_CAP {
                if let Some(evicted) = inner.cursor_order.pop_front() {
                    inner.cursors.remove(&evicted);
                }
            }
            token
        });
        Ok(ActionListResult {
            registry_revision: inner.revision,
            idempotency_epoch: epoch.to_string(),
            definitions,
            next_cursor,
        })
    }

    #[allow(dead_code)] // Trusted project-definition integration calls this in the next M4 slice.
    fn replace(&self, mut definitions: Vec<ActionDefinition>) -> Result<u64, &'static str> {
        validate_definitions(&definitions)?;
        definitions.sort_by(|left, right| {
            (&left.action_id, left.action_version).cmp(&(&right.action_id, right.action_version))
        });
        let mut inner = self
            .inner
            .lock()
            .expect("action registry lock is not poisoned");
        inner.revision = inner
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or("action registry revision exhausted")?;
        inner.definitions = definitions;
        Ok(inner.revision)
    }
}

fn production_definitions() -> Vec<ActionDefinition> {
    let service = |action_id: &str, title: &str, category: &str| ActionDefinition {
        action_id: action_id.to_owned(),
        action_version: 1,
        localized_title_key: title.to_owned(),
        display_title: None,
        default_shortcut: None,
        category: category.to_owned(),
        owner: ActionOwner::Service,
        parameter_schema_version: 1,
        result_schema_version: 1,
        authorization_class: ActionAuthorizationClass::Owner,
        interaction_class: ActionInteractionClass::Headless,
        required_desktop_capability: None,
        limits: ActionLimits {
            max_parameter_bytes: 4 * 1_024,
            max_result_bytes: 1_024,
            timeout_ms: 30_000,
        },
    };
    vec![
        ActionDefinition {
            action_id: "desktop.window.focus".to_owned(),
            action_version: 1,
            localized_title_key: "actions.desktop_window_focus".to_owned(),
            display_title: None,
            default_shortcut: None,
            category: "window".to_owned(),
            owner: ActionOwner::Desktop,
            parameter_schema_version: 1,
            result_schema_version: 1,
            authorization_class: ActionAuthorizationClass::Owner,
            interaction_class: ActionInteractionClass::DesktopInteraction,
            required_desktop_capability: Some("desktop-window-focus-v1".to_owned()),
            limits: ActionLimits {
                max_parameter_bytes: 2,
                max_result_bytes: 2,
                timeout_ms: 30_000,
            },
        },
        service(
            "workspace.card.pin",
            "actions.workspace_card_pin",
            "organization",
        ),
        service(
            "workspace.group.rename",
            "actions.workspace_group_rename",
            "organization",
        ),
        service(
            "workspace.group.collapse",
            "actions.workspace_group_collapse",
            "organization",
        ),
    ]
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CardPinActionParameters {
    workspace_id: String,
    pinned: bool,
    expected_revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupRenameActionParameters {
    group_id: String,
    name: String,
    expected_revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupCollapseActionParameters {
    group_id: String,
    collapsed: bool,
    expected_revision: u64,
}

fn validate_definitions(definitions: &[ActionDefinition]) -> Result<(), &'static str> {
    if definitions.len() > MAX_ACTION_DEFINITIONS {
        return Err("too many action definitions");
    }
    let mut identities = BTreeSet::new();
    for definition in definitions {
        let value = serde_json::to_value(definition).map_err(|_| "invalid action definition")?;
        serde_json::from_value::<ActionDefinition>(value)
            .map_err(|_| "invalid action definition")?;
        if !identities.insert(definition.action_id.as_str()) {
            return Err("duplicate action definition");
        }
    }
    Ok(())
}

impl ActionRuntime {
    #[cfg(test)]
    pub(super) fn new(store: Arc<SqliteStateStore>, providers: MultiWindowRuntime) -> Self {
        Self::with_registry(store, providers, ActionRegistry::production())
    }

    pub(super) fn with_custom_actions(
        store: Arc<SqliteStateStore>,
        providers: MultiWindowRuntime,
        config_store: Arc<ConfigStore>,
    ) -> Self {
        let mut runtime = Self::with_registry(store, providers, ActionRegistry::production());
        runtime.project_actions = Some(ProjectActionService {
            config_store,
            registry: Arc::new(StdMutex::new(ProjectRegistryState::default())),
            confirmations: Arc::new(Mutex::new(BTreeMap::new())),
            running: Arc::new(Mutex::new(BTreeMap::new())),
            confirmation_changed: Arc::new(Notify::new()),
        });
        runtime
    }

    pub(super) fn with_registry(
        store: Arc<SqliteStateStore>,
        providers: MultiWindowRuntime,
        registry: ActionRegistry,
    ) -> Self {
        let (events, _) = broadcast::channel(EVENT_CAP);
        Self {
            store,
            providers,
            registry,
            events,
            project_actions: None,
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<ActionRuntimeEvent> {
        self.events.subscribe()
    }

    async fn refresh_project_actions(&self, context: &ControlContext) {
        let (Some(project_actions), Some(runtime)) = (&self.project_actions, &context.runtime)
        else {
            return;
        };
        let snapshot = runtime.snapshot().await;
        let workspaces = snapshot
            .workspaces
            .iter()
            .map(|workspace| {
                (
                    workspace.id.to_string(),
                    workspace.working_directory.clone(),
                    workspace.name.clone(),
                )
            })
            .collect();
        let custom = if let Ok(custom) = project_actions.rebuild(workspaces).await {
            custom
        } else {
            project_actions.clear_registry();
            Vec::new()
        };
        let mut definitions = production_definitions();
        definitions.extend(custom);
        definitions.sort_by(|left, right| {
            (&left.action_id, left.action_version).cmp(&(&right.action_id, right.action_version))
        });
        if self.registry.definitions() != definitions {
            let _ = self.replace_registry(definitions);
        }
        self.invalidate_stale_project_confirmations(project_actions)
            .await;
    }

    async fn invalidate_stale_project_confirmations(&self, project_actions: &ProjectActionService) {
        let pending: Vec<_> = project_actions
            .confirmations
            .lock()
            .await
            .iter()
            .map(|(invocation_id, queued)| (*invocation_id, queued.clone()))
            .collect();
        for (invocation_id, queued) in pending {
            let current = project_actions
                .coordinator(&queued.challenge.action_id)
                .and_then(|coordinator| coordinator.registry())
                .and_then(|registry| {
                    registry
                        .actions
                        .into_iter()
                        .find(|action| action.action_id == queued.challenge.action_id)
                })
                .is_some_and(|action| {
                    action.confirmation_definition_sha256
                        == queued.challenge.confirmation_definition_sha256
                });
            if !current {
                self.discard_project_confirmation(invocation_id).await;
                self.terminate_project_confirmation(
                    invocation_id,
                    StoredState::Failed,
                    "failed",
                    Some(ActionErrorCode::PolicyDenied),
                )
                .await;
            }
        }
    }

    #[allow(dead_code)] // Preserves the bounded registry invalidation seam for trusted rebuilds.
    pub(super) fn replace_registry(
        &self,
        definitions: Vec<ActionDefinition>,
    ) -> Result<u64, &'static str> {
        let revision = self.registry.replace(definitions)?;
        let _ = self
            .events
            .send(ActionRuntimeEvent::Registry(ActionRegistryChangedEvent {
                event: "action.registryChanged".to_owned(),
                registry_revision: revision,
                reason: ActionRegistryChangeReason::DefinitionsChanged,
            }));
        Ok(revision)
    }

    fn emit_record(&self, record: &ActionInvocationRecord) {
        action_audit(record).emit();
        let _ = self.events.send(ActionRuntimeEvent::Invocation(
            ActionInvocationChangedEvent {
                event: "action.invocationChanged".to_owned(),
                invocation_id: record.invocation_id.to_string(),
                correlation_id: record.correlation_id.to_string(),
                state: protocol_state(record.state),
                updated_at_ms: u64::try_from(record.updated_at_ms).unwrap_or(0),
            },
        ));
    }

    async fn list(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<ActionListParams>(params) else {
            return invalid_params(id);
        };
        let store = Arc::clone(&self.store);
        let Ok(Ok(epoch)) =
            tokio::task::spawn_blocking(move || store.current_idempotency_epoch()).await
        else {
            return storage_failure(id);
        };
        match self.registry.list(params, epoch) {
            Ok(result) => success(id, result),
            Err(RegistryError::Invalid) => action_failure(id, ActionErrorCode::CursorInvalid),
            Err(RegistryError::Expired) => action_failure(id, ActionErrorCode::CursorExpired),
        }
    }

    #[allow(clippy::too_many_lines)]
    async fn invoke(
        &self,
        id: String,
        params: Value,
        context: &ControlContext,
        caller_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<ActionInvokeParams>(params) else {
            return invalid_params(id);
        };
        let Some(definition) = self.registry.definition(&params.action_id) else {
            return action_failure(id, ActionErrorCode::ActionNotFound);
        };
        if definition.action_version != params.action_version {
            return action_failure(id, ActionErrorCode::ActionVersionMismatch);
        }
        let Ok(parameter_json) = serde_json::to_string(&params.parameters) else {
            return action_failure(id, ActionErrorCode::InvalidParameters);
        };
        if !params.parameters.is_object()
            || parameter_json.len() > definition.limits.max_parameter_bytes as usize
        {
            return action_failure(id, ActionErrorCode::InvalidParameters);
        }
        if params.action_id == "desktop.window.focus" && params.target.is_none() {
            return action_failure(id, ActionErrorCode::TargetRequired);
        }
        let Ok(epoch) = Uuid::parse_str(&params.idempotency.epoch) else {
            return invalid_params(id);
        };
        let Ok(key) = Uuid::parse_str(&params.idempotency.key) else {
            return invalid_params(id);
        };
        let correlation_id = Uuid::parse_str(&params.correlation_id)
            .expect("protocol validation guarantees a correlation UUID");
        if let Some(project_actions) = &self.project_actions
            && let Some(coordinator) = project_actions.coordinator(&params.action_id)
        {
            return self
                .invoke_project_action(
                    id,
                    params,
                    definition,
                    coordinator,
                    context,
                    epoch,
                    key,
                    correlation_id,
                    caller_id,
                    parameter_json,
                )
                .await;
        }
        if definition.owner == ActionOwner::Service {
            return self
                .invoke_service(
                    id,
                    &params,
                    context,
                    epoch,
                    key,
                    correlation_id,
                    caller_id,
                    &parameter_json,
                )
                .await;
        }
        let Some(required_capability) = definition.required_desktop_capability.as_deref() else {
            return action_failure(id, ActionErrorCode::ProviderIneligible);
        };
        let invocation_id = invocation_uuid(epoch, key, &params.action_id);
        let accepted_at_ms = now_ms();
        let expires_at_ms = accepted_at_ms.saturating_add(i64::from(definition.limits.timeout_ms));
        let request_hash = request_hash(&params);
        let create = ActionInvocationCreate {
            invocation_id,
            epoch,
            idempotency_key: key,
            request_hash,
            action_id: params.action_id.clone(),
            action_version: params.action_version,
            correlation_id,
            caller_id,
            parameters_json: parameter_json,
            accepted_at_ms,
            expires_at_ms,
        };
        let store = Arc::clone(&self.store);
        let create_outcome =
            tokio::task::spawn_blocking(move || store.create_action_invocation(&create)).await;
        let Ok(Ok(outcome)) = create_outcome else {
            return storage_failure(id);
        };
        let record = match outcome {
            ActionInvocationCreateOutcome::Created(record) => record,
            ActionInvocationCreateOutcome::Pending(record) => {
                return success(
                    id,
                    ActionInvokeResult {
                        invocation: snapshot(&record),
                    },
                );
            }
            ActionInvocationCreateOutcome::Replay(terminal) => {
                return success(
                    id,
                    ActionInvokeResult {
                        invocation: terminal_snapshot(invocation_id, correlation_id, &terminal),
                    },
                );
            }
            ActionInvocationCreateOutcome::ResultExpired { .. }
            | ActionInvocationCreateOutcome::EpochExpired => {
                return action_failure(id, ActionErrorCode::IdempotencyExpired);
            }
            ActionInvocationCreateOutcome::Conflict => {
                return action_failure(id, ActionErrorCode::IdempotencyConflict);
            }
            ActionInvocationCreateOutcome::ResourceLimit => {
                return action_failure(id, ActionErrorCode::ResourceLimit);
            }
        };
        self.emit_record(&record);
        let Some(runtime) = &context.runtime else {
            let Some(terminal) = self
                .terminate_pre_start(
                    &record,
                    StoredState::Failed,
                    "failed",
                    Some(ActionErrorCode::ExecutionFailed),
                )
                .await
            else {
                return storage_failure(id);
            };
            return success(
                id,
                ActionInvokeResult {
                    invocation: snapshot(&terminal),
                },
            );
        };
        let state = runtime.snapshot().await;
        let reservation = self
            .providers
            .action_reserve(&state, required_capability, params.target.as_ref())
            .await;
        let reservation = match reservation {
            Ok(reservation) => reservation,
            Err(code) => {
                let error_code = provider_error_code(code);
                let Some(terminal) = self
                    .terminate_pre_start(&record, StoredState::Failed, "failed", Some(error_code))
                    .await
                else {
                    return storage_failure(id);
                };
                return success(
                    id,
                    ActionInvokeResult {
                        invocation: snapshot(&terminal),
                    },
                );
            }
        };
        let identity = ActionInvocationIdentity {
            attempt_epoch: reservation.attempt_epoch,
            provider_id: reservation.provider_id,
            provider_epoch: reservation.provider_epoch,
            provider_lease_id: reservation.provider_lease_id,
            window_id: reservation.window_id,
            window_generation: reservation.window_generation,
        };
        let store = Arc::clone(&self.store);
        let leased = tokio::task::spawn_blocking(move || {
            store.lease_action_invocation(invocation_id, correlation_id, &identity, now_ms())
        })
        .await;
        let Ok(Ok(
            ActionLifecycleOutcome::Applied(leased) | ActionLifecycleOutcome::Replay(leased),
        )) = leased
        else {
            self.providers
                .action_abort_reservation(reservation.reservation_id)
                .await;
            let Some(terminal) = self
                .terminate_pre_start(
                    &record,
                    StoredState::Failed,
                    "failed",
                    Some(ActionErrorCode::ExecutionFailed),
                )
                .await
            else {
                return storage_failure(id);
            };
            return success(
                id,
                ActionInvokeResult {
                    invocation: snapshot(&terminal),
                },
            );
        };
        self.emit_record(&leased);
        let store = Arc::clone(&self.store);
        let dispatch_identity = leased
            .identity
            .clone()
            .expect("a leased action has provider identity");
        let dispatched = tokio::task::spawn_blocking(move || {
            store.mark_action_dispatched(
                invocation_id,
                correlation_id,
                &dispatch_identity,
                now_ms(),
            )
        })
        .await;
        let Ok(Ok(
            ActionLifecycleOutcome::Applied(dispatched)
            | ActionLifecycleOutcome::Replay(dispatched),
        )) = dispatched
        else {
            self.providers
                .action_abort_reservation(reservation.reservation_id)
                .await;
            let Some(terminal) = self
                .terminate_pre_start(
                    &leased,
                    StoredState::Failed,
                    "failed",
                    Some(ActionErrorCode::ExecutionFailed),
                )
                .await
            else {
                return storage_failure(id);
            };
            return success(
                id,
                ActionInvokeResult {
                    invocation: snapshot(&terminal),
                },
            );
        };
        let request = DesktopActionExecutionRequest {
            identity: DesktopProviderIdentityParams {
                provider_id: reservation.provider_id.to_string(),
                provider_epoch: reservation.provider_epoch,
                lease_id: reservation.provider_lease_id.to_string(),
            },
            invocation_id: invocation_id.to_string(),
            correlation_id: correlation_id.to_string(),
            attempt_epoch: reservation.attempt_epoch,
            action_id: params.action_id,
            action_version: params.action_version,
            target: ActionInvocationTarget {
                window_id: reservation.window_id.to_string(),
                window_generation: reservation.window_generation,
            },
            parameters: params.parameters,
            expires_at_ms: u64::try_from(expires_at_ms).unwrap_or(u64::MAX),
        };
        if self
            .providers
            .action_publish(&reservation, request)
            .await
            .is_err()
        {
            let Some(terminal) = self
                .terminate_pre_start(
                    &dispatched,
                    StoredState::Failed,
                    "interrupted",
                    Some(ActionErrorCode::ExecutionFailed),
                )
                .await
            else {
                return storage_failure(id);
            };
            return success(
                id,
                ActionInvokeResult {
                    invocation: snapshot(&terminal),
                },
            );
        }
        self.emit_record(&dispatched);
        success(
            id,
            ActionInvokeResult {
                invocation: snapshot(&dispatched),
            },
        )
    }

    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    async fn invoke_project_action(
        &self,
        id: String,
        params: ActionInvokeParams,
        definition: ActionDefinition,
        coordinator: CustomActionCoordinator,
        context: &ControlContext,
        epoch: Uuid,
        key: Uuid,
        correlation_id: Uuid,
        caller_id: Uuid,
        parameter_json: String,
    ) -> ResponseEnvelope {
        if !params
            .parameters
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
        {
            return action_failure(id, ActionErrorCode::InvalidParameters);
        }
        let Some(project_actions) = &self.project_actions else {
            return action_failure(id, ActionErrorCode::CapabilityUnavailable);
        };
        let Some(runtime) = &context.runtime else {
            return action_failure(id, ActionErrorCode::CapabilityUnavailable);
        };
        let invocation_id = invocation_uuid(epoch, key, &params.action_id);
        let accepted_at_ms = now_ms();
        let expires_at_ms = accepted_at_ms.saturating_add(i64::from(definition.limits.timeout_ms));
        let create = ActionInvocationCreate {
            invocation_id,
            epoch,
            idempotency_key: key,
            request_hash: request_hash(&params),
            action_id: params.action_id.clone(),
            action_version: params.action_version,
            correlation_id,
            caller_id,
            parameters_json: parameter_json,
            accepted_at_ms,
            expires_at_ms,
        };
        let store = Arc::clone(&self.store);
        let Ok(Ok(outcome)) =
            tokio::task::spawn_blocking(move || store.create_action_invocation(&create)).await
        else {
            return storage_failure(id);
        };
        let record = match outcome {
            ActionInvocationCreateOutcome::Created(record) => record,
            ActionInvocationCreateOutcome::Pending(record) => {
                return success(
                    id,
                    ActionInvokeResult {
                        invocation: snapshot(&record),
                    },
                );
            }
            ActionInvocationCreateOutcome::Replay(terminal) => {
                return success(
                    id,
                    ActionInvokeResult {
                        invocation: terminal_snapshot(invocation_id, correlation_id, &terminal),
                    },
                );
            }
            ActionInvocationCreateOutcome::ResultExpired { .. }
            | ActionInvocationCreateOutcome::EpochExpired => {
                return action_failure(id, ActionErrorCode::IdempotencyExpired);
            }
            ActionInvocationCreateOutcome::Conflict => {
                return action_failure(id, ActionErrorCode::IdempotencyConflict);
            }
            ActionInvocationCreateOutcome::ResourceLimit => {
                return action_failure(id, ActionErrorCode::ResourceLimit);
            }
        };
        self.emit_record(&record);
        let state = runtime.snapshot().await;
        let reservation = match self
            .providers
            .action_reserve(
                &state,
                PROJECT_CONFIRMATION_CAPABILITY,
                params.target.as_ref(),
            )
            .await
        {
            Ok(reservation) => reservation,
            Err(code) => {
                return self
                    .project_invoke_terminal(id, &record, provider_error_code(code))
                    .await;
            }
        };
        if !self.reservation_is_active(&reservation).await {
            self.providers
                .action_abort_reservation(reservation.reservation_id)
                .await;
            return self
                .project_invoke_terminal(id, &record, ActionErrorCode::ProviderUnavailable)
                .await;
        }
        let identity = ActionInvocationIdentity {
            attempt_epoch: reservation.attempt_epoch,
            provider_id: reservation.provider_id,
            provider_epoch: reservation.provider_epoch,
            provider_lease_id: reservation.provider_lease_id,
            window_id: reservation.window_id,
            window_generation: reservation.window_generation,
        };
        let store = Arc::clone(&self.store);
        let leased = tokio::task::spawn_blocking(move || {
            store.lease_action_invocation(invocation_id, correlation_id, &identity, now_ms())
        })
        .await;
        let Ok(Ok(
            ActionLifecycleOutcome::Applied(leased) | ActionLifecycleOutcome::Replay(leased),
        )) = leased
        else {
            self.providers
                .action_abort_reservation(reservation.reservation_id)
                .await;
            return self
                .project_invoke_terminal(id, &record, ActionErrorCode::ExecutionFailed)
                .await;
        };
        self.emit_record(&leased);
        let dispatch_identity = leased
            .identity
            .clone()
            .expect("a leased project action has provider identity");
        let store = Arc::clone(&self.store);
        let dispatched = tokio::task::spawn_blocking(move || {
            store.mark_action_dispatched(
                invocation_id,
                correlation_id,
                &dispatch_identity,
                now_ms(),
            )
        })
        .await;
        let Ok(Ok(
            ActionLifecycleOutcome::Applied(dispatched)
            | ActionLifecycleOutcome::Replay(dispatched),
        )) = dispatched
        else {
            self.providers
                .action_abort_reservation(reservation.reservation_id)
                .await;
            return self
                .project_invoke_terminal(id, &leased, ActionErrorCode::ExecutionFailed)
                .await;
        };
        self.providers
            .action_abort_reservation(reservation.reservation_id)
            .await;
        if !self.reservation_is_active(&reservation).await {
            return self
                .project_invoke_terminal(id, &dispatched, ActionErrorCode::ProviderUnavailable)
                .await;
        }
        let provider = provider_generation(&reservation);
        let Ok(challenge) =
            coordinator.begin_invocation(invocation_id, &params.action_id, provider)
        else {
            return self
                .project_invoke_terminal(id, &dispatched, ActionErrorCode::PolicyDenied)
                .await;
        };
        let challenge = project_challenge(challenge, &reservation);
        if project_actions
            .enqueue(QueuedConfirmation {
                coordinator,
                challenge,
                provider,
            })
            .await
            .is_err()
        {
            return self
                .project_invoke_terminal(id, &dispatched, ActionErrorCode::ResourceLimit)
                .await;
        }
        self.emit_record(&dispatched);
        success(
            id,
            ActionInvokeResult {
                invocation: snapshot(&dispatched),
            },
        )
    }

    async fn reservation_is_active(&self, reservation: &ActionProviderReservation) -> bool {
        self.providers
            .action_identity_is_active(
                reservation.provider_id,
                reservation.provider_epoch,
                reservation.provider_lease_id,
                reservation.window_id,
                reservation.window_generation,
            )
            .await
    }

    async fn project_invoke_terminal(
        &self,
        id: String,
        record: &ActionInvocationRecord,
        error: ActionErrorCode,
    ) -> ResponseEnvelope {
        let Some(terminal) = self
            .terminate_pre_start(record, StoredState::Failed, "failed", Some(error))
            .await
        else {
            return storage_failure(id);
        };
        success(
            id,
            ActionInvokeResult {
                invocation: snapshot(&terminal),
            },
        )
    }

    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    async fn invoke_service(
        &self,
        id: String,
        params: &ActionInvokeParams,
        context: &ControlContext,
        epoch: Uuid,
        key: Uuid,
        correlation_id: Uuid,
        caller_id: Uuid,
        parameter_json: &str,
    ) -> ResponseEnvelope {
        let Some(runtime) = &context.runtime else {
            return action_failure(id, ActionErrorCode::CapabilityUnavailable);
        };
        if params.target.is_some() {
            return action_failure(id, ActionErrorCode::InvalidParameters);
        }
        let invocation_id = invocation_uuid(epoch, key, &params.action_id);
        let updated_at_ms = u64::try_from(now_ms()).unwrap_or(0);
        let Ok(request_json) = serde_json::to_string(params) else {
            return action_failure(id, ActionErrorCode::InvalidParameters);
        };
        let ticket = epoch_idempotency_ticket(
            format!("action.service.{}.v1", params.action_id),
            epoch,
            key,
            &request_json,
            4_096,
        );
        let (expected_revision, mutation): (u64, ServiceMutation) = match params.action_id.as_str()
        {
            "workspace.card.pin" => {
                let Ok(value) = serde_json::from_str::<CardPinActionParameters>(parameter_json)
                else {
                    return action_failure(id, ActionErrorCode::InvalidParameters);
                };
                let Ok(workspace_id) = Uuid::parse_str(&value.workspace_id) else {
                    return action_failure(id, ActionErrorCode::InvalidParameters);
                };
                (
                    value.expected_revision,
                    Box::new(move |state| {
                        state.set_workspace_pinned(
                            WorkspaceId::from_uuid(workspace_id),
                            value.pinned,
                        )
                    }),
                )
            }
            "workspace.group.rename" => {
                let Ok(value) = serde_json::from_str::<GroupRenameActionParameters>(parameter_json)
                else {
                    return action_failure(id, ActionErrorCode::InvalidParameters);
                };
                let Ok(group_id) = Uuid::parse_str(&value.group_id) else {
                    return action_failure(id, ActionErrorCode::InvalidParameters);
                };
                (
                    value.expected_revision,
                    Box::new(move |state| {
                        state.rename_workspace_group(GroupId::from_uuid(group_id), value.name)
                    }),
                )
            }
            "workspace.group.collapse" => {
                let Ok(value) =
                    serde_json::from_str::<GroupCollapseActionParameters>(parameter_json)
                else {
                    return action_failure(id, ActionErrorCode::InvalidParameters);
                };
                let Ok(group_id) = Uuid::parse_str(&value.group_id) else {
                    return action_failure(id, ActionErrorCode::InvalidParameters);
                };
                (
                    value.expected_revision,
                    Box::new(move |state| {
                        state.set_workspace_group_collapsed(
                            GroupId::from_uuid(group_id),
                            value.collapsed,
                        )
                    }),
                )
            }
            _ => return action_failure(id, ActionErrorCode::CapabilityUnavailable),
        };
        if expected_revision > MAX_SAFE_INTEGER {
            return action_failure(id, ActionErrorCode::InvalidParameters);
        }
        let result = ActionInvokeResult {
            invocation: ActionInvocationSnapshot {
                invocation_id: invocation_id.to_string(),
                correlation_id: correlation_id.to_string(),
                state: ActionInvocationState::Acknowledged,
                terminal_code: Some(ActionTerminalCode::Succeeded),
                result: Some(serde_json::json!({})),
                error_code: None,
                updated_at_ms,
            },
        };
        let Ok(result_json) = serde_json::to_string(&result) else {
            return storage_failure(id);
        };
        let commit = runtime
            .mutate_multi_window_idempotent(
                expected_revision,
                Vec::new(),
                ticket,
                LaunchOptions::default(),
                mutation,
                move |_| Ok::<_, StoreError>(result_json),
            )
            .await;
        let (lifecycle_state, terminal_code, result_bytes) = match &commit {
            Ok(
                EpochIdempotentCommitResult::Committed { result_json, .. }
                | EpochIdempotentCommitResult::Replay(result_json),
            ) => ("acknowledged", Some("succeeded"), result_json.len()),
            Ok(EpochIdempotentCommitResult::Conflict) => {
                ("failed", Some("idempotency_conflict"), 0)
            }
            Ok(
                EpochIdempotentCommitResult::ResultExpired
                | EpochIdempotentCommitResult::EpochExpired,
            ) => ("failed", Some("idempotency_expired"), 0),
            Err(_) => ("failed", Some("execution_failed"), 0),
        };
        info!(
            action_id = params.action_id,
            action_version = params.action_version,
            invocation_id = %invocation_id,
            correlation_id = %correlation_id,
            caller_id = %caller_id,
            provider_id = ?Option::<Uuid>::None,
            window_id = ?Option::<Uuid>::None,
            authorization_decision = "owner_authorized",
            lifecycle_state,
            terminal_code,
            accepted_at_ms = updated_at_ms,
            updated_at_ms,
            duration_ms = 0_u64,
            parameter_bytes = parameter_json.len(),
            result_bytes,
            redaction_count = 0_u8,
            "service action audit"
        );
        service_action_response(id, commit)
    }

    async fn cancel(&self, id: String, params: Value, _caller_id: Uuid) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<ActionCancelParams>(params) else {
            return invalid_params(id);
        };
        let invocation_id = Uuid::parse_str(&params.invocation_id)
            .expect("protocol validation guarantees an invocation UUID");
        let correlation_id = Uuid::parse_str(&params.correlation_id)
            .expect("protocol validation guarantees a correlation UUID");
        let store = Arc::clone(&self.store);
        let record =
            match tokio::task::spawn_blocking(move || store.action_invocation(invocation_id)).await
            {
                Ok(Ok(Some(record))) => record,
                Ok(Ok(None)) => return action_failure(id, ActionErrorCode::ActionNotFound),
                _ => return storage_failure(id),
            };
        if record.correlation_id != correlation_id {
            return action_failure(id, ActionErrorCode::Unauthorized);
        }
        let store = Arc::clone(&self.store);
        let outcome = tokio::task::spawn_blocking(move || {
            store.cancel_action_invocation(invocation_id, correlation_id, "canceled", now_ms())
        })
        .await;
        match outcome {
            Ok(Ok(ActionLifecycleOutcome::Applied(canceled))) => {
                self.discard_project_confirmation(invocation_id).await;
                if let Some(identity) = &record.identity {
                    let _ = self
                        .providers
                        .action_cancel_queued(identity.provider_id, invocation_id)
                        .await;
                }
                self.emit_record(&canceled);
                success(
                    id,
                    ActionCancelResult {
                        invocation: snapshot(&canceled),
                    },
                )
            }
            Ok(Ok(ActionLifecycleOutcome::Terminal(terminal))) => success(
                id,
                ActionCancelResult {
                    invocation: terminal_snapshot(invocation_id, correlation_id, &terminal),
                },
            ),
            Ok(Ok(ActionLifecycleOutcome::CancellationNotGuaranteed)) => {
                self.cancel_running_project(invocation_id).await;
                action_failure(id, ActionErrorCode::CancellationNotGuaranteed)
            }
            Ok(Ok(ActionLifecycleOutcome::Mismatch)) => {
                action_failure(id, ActionErrorCode::CorrelationMismatch)
            }
            Ok(Ok(ActionLifecycleOutcome::NotFound)) => {
                action_failure(id, ActionErrorCode::ActionNotFound)
            }
            Ok(Ok(
                ActionLifecycleOutcome::InvalidState(_)
                | ActionLifecycleOutcome::Replay(_)
                | ActionLifecycleOutcome::ResourceLimit,
            )) => action_failure(id, ActionErrorCode::InvalidState),
            _ => storage_failure(id),
        }
    }

    async fn poll(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<DesktopActionPollParams>(params) else {
            return invalid_params(id);
        };
        match self
            .providers
            .action_poll(&params.identity, params.timeout_ms)
            .await
        {
            Ok(result) => success(id, result),
            Err(code) => provider_failure(id, code),
        }
    }

    async fn confirmation_poll(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<ProjectActionConfirmationPollParams>(params)
        else {
            return invalid_params(id);
        };
        let Some(project_actions) = &self.project_actions else {
            return action_failure(id, ActionErrorCode::CapabilityUnavailable);
        };
        let notified = project_actions.confirmation_changed.notified();
        if let Some(challenge) = self
            .next_confirmation(project_actions, &params.identity)
            .await
        {
            return success(
                id,
                ProjectActionConfirmationPollResult {
                    challenge: Some(challenge),
                },
            );
        }
        if params.timeout_ms > 0 {
            let _ = tokio::time::timeout(
                Duration::from_millis(u64::from(params.timeout_ms)),
                notified,
            )
            .await;
        }
        let challenge = self
            .next_confirmation(project_actions, &params.identity)
            .await;
        success(id, ProjectActionConfirmationPollResult { challenge })
    }

    async fn next_confirmation(
        &self,
        project_actions: &ProjectActionService,
        identity: &DesktopProviderIdentityParams,
    ) -> Option<ProjectActionConfirmationChallenge> {
        loop {
            let candidate = project_actions
                .confirmations
                .lock()
                .await
                .values()
                .find(|queued| queued.challenge.identity == *identity)
                .cloned();
            let queued = candidate?;
            let invocation_id = Uuid::parse_str(&queued.challenge.invocation_id).ok()?;
            if queued.challenge.expires_at_ms <= u64::try_from(now_ms()).unwrap_or(0) {
                project_actions.remove(invocation_id).await;
                self.terminate_project_confirmation(
                    invocation_id,
                    StoredState::Expired,
                    "expired",
                    Some(ActionErrorCode::Expired),
                )
                .await;
                continue;
            }
            if !self
                .providers
                .action_identity_is_active(
                    queued.provider.provider_id,
                    queued.provider.provider_epoch,
                    queued.provider.provider_lease_id,
                    queued.provider.window_id,
                    queued.provider.generation,
                )
                .await
            {
                project_actions.remove(invocation_id).await;
                self.terminate_project_confirmation(
                    invocation_id,
                    StoredState::Failed,
                    "interrupted",
                    Some(ActionErrorCode::ProviderUnavailable),
                )
                .await;
                continue;
            }
            return Some(queued.challenge);
        }
    }

    async fn confirmation_respond(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<ProjectActionConfirmationRespondParams>(params)
        else {
            return invalid_params(id);
        };
        let Some(project_actions) = &self.project_actions else {
            return action_failure(id, ActionErrorCode::CapabilityUnavailable);
        };
        let invocation_id = Uuid::parse_str(&params.invocation_id)
            .expect("protocol validation guarantees a confirmation invocation UUID");
        let queued = project_actions
            .confirmations
            .lock()
            .await
            .get(&invocation_id)
            .cloned();
        let Some(queued) = queued else {
            return action_failure(id, ActionErrorCode::InvalidState);
        };
        if !self
            .providers
            .action_identity_is_active(
                queued.provider.provider_id,
                queued.provider.provider_epoch,
                queued.provider.provider_lease_id,
                queued.provider.window_id,
                queued.provider.generation,
            )
            .await
        {
            project_actions.remove(invocation_id).await;
            self.terminate_project_confirmation(
                invocation_id,
                StoredState::Failed,
                "interrupted",
                Some(ActionErrorCode::ProviderUnavailable),
            )
            .await;
            return action_failure(id, ActionErrorCode::ProviderUnavailable);
        }
        let exact_echo = queued.challenge.identity == params.identity
            && queued.challenge.target == params.target
            && queued.challenge.nonce == params.nonce
            && queued.challenge.challenge == params.challenge
            && queued.challenge.confirmation_definition_sha256
                == params.confirmation_definition_sha256;
        if !exact_echo {
            let response = confirmation_response(&params);
            let _ = queued.coordinator.confirm(&response).await;
            project_actions.remove(invocation_id).await;
            self.terminate_project_confirmation(
                invocation_id,
                StoredState::Failed,
                "failed",
                Some(ActionErrorCode::Unauthorized),
            )
            .await;
            return action_failure(id, ActionErrorCode::Unauthorized);
        }
        project_actions.remove(invocation_id).await;
        if params.decision == ProjectActionConfirmationDecision::Denied {
            let _ = queued.coordinator.cancel(invocation_id);
            self.terminate_project_confirmation(
                invocation_id,
                StoredState::Failed,
                "failed",
                Some(ActionErrorCode::PolicyDenied),
            )
            .await;
        } else {
            // Publish cancellation access before the durable start claim. Otherwise a concurrent
            // caller cancellation can observe StartGranted before the coordinator is reachable.
            project_actions
                .running
                .lock()
                .await
                .insert(invocation_id, queued.coordinator.clone());
            let Some(granted) = self.grant_project_start(invocation_id).await else {
                project_actions.running.lock().await.remove(&invocation_id);
                let _ = queued.coordinator.cancel(invocation_id);
                return action_failure(id, ActionErrorCode::InvalidState);
            };
            let confirmation = queued
                .coordinator
                .confirm(&confirmation_response(&params))
                .await;
            project_actions.running.lock().await.remove(&invocation_id);
            self.complete_project_execution(&granted, confirmation)
                .await;
        }
        success(
            id,
            ProjectActionConfirmationRespondResult {
                invocation_id: params.invocation_id,
                decision: params.decision,
                accepted_at_ms: u64::try_from(now_ms()).unwrap_or(0),
            },
        )
    }

    async fn grant_project_start(&self, invocation_id: Uuid) -> Option<ActionInvocationRecord> {
        let store = Arc::clone(&self.store);
        let record = tokio::task::spawn_blocking(move || store.action_invocation(invocation_id))
            .await
            .ok()?
            .ok()??;
        let claim = ActionStartClaim {
            invocation_id,
            correlation_id: record.correlation_id,
            action_id: record.action_id.clone(),
            action_version: record.action_version,
            identity: record.identity.clone()?,
            claimed_at_ms: now_ms(),
        };
        let store = Arc::clone(&self.store);
        let outcome = tokio::task::spawn_blocking(move || store.claim_action_start(&claim))
            .await
            .ok()?
            .ok()?;
        match outcome {
            ActionLifecycleOutcome::Applied(granted) | ActionLifecycleOutcome::Replay(granted) => {
                self.emit_record(&granted);
                Some(granted)
            }
            _ => None,
        }
    }

    async fn complete_project_execution(
        &self,
        granted: &ActionInvocationRecord,
        outcome: Result<CustomActionAudit, CustomActionError>,
    ) {
        let (state, code, error_code, result_json) = match outcome {
            Ok(audit) => match audit.result {
                Some(result) if result.terminal_code == CustomTerminalCode::Succeeded => (
                    StoredState::Acknowledged,
                    "succeeded",
                    None,
                    serde_json::to_string(&serde_json::json!({
                        "exitCode": result.exit_code,
                        "stdoutBytes": result.stdout_bytes,
                        "stderrBytes": result.stderr_bytes,
                        "outputTruncated": result.output_truncated,
                        "redactionCount": result.redaction_count,
                        "durationMs": result.duration_ms,
                    }))
                    .ok(),
                ),
                Some(result) if result.terminal_code == CustomTerminalCode::Cancelled => {
                    (StoredState::Canceled, "canceled", None, None)
                }
                _ => (
                    StoredState::Failed,
                    "failed",
                    Some(action_error_code(ActionErrorCode::ExecutionFailed).to_owned()),
                    None,
                ),
            },
            Err(CustomActionError::ContainmentUnavailable) => (
                StoredState::Failed,
                "failed",
                Some(action_error_code(ActionErrorCode::CapabilityUnavailable).to_owned()),
                None,
            ),
            Err(CustomActionError::ConfirmationExpired) => {
                (StoredState::Expired, "expired", None, None)
            }
            Err(CustomActionError::PolicyDenied) => (
                StoredState::Failed,
                "failed",
                Some(action_error_code(ActionErrorCode::PolicyDenied).to_owned()),
                None,
            ),
            Err(_) => (
                StoredState::Failed,
                "failed",
                Some(action_error_code(ActionErrorCode::ExecutionFailed).to_owned()),
                None,
            ),
        };
        let Some(identity) = granted.identity.clone() else {
            return;
        };
        let ack = ActionTerminalAck {
            invocation_id: granted.invocation_id,
            correlation_id: granted.correlation_id,
            action_id: granted.action_id.clone(),
            action_version: granted.action_version,
            identity: identity.clone(),
            state,
            terminal_code: code.to_owned(),
            error_code,
            result_json,
            completed_at_ms: now_ms(),
        };
        let store = Arc::clone(&self.store);
        if let Ok(Ok(ActionLifecycleOutcome::Applied(terminal))) =
            tokio::task::spawn_blocking(move || store.acknowledge_action_terminal(&ack)).await
        {
            self.emit_record(&terminal);
        }
    }

    async fn terminate_project_confirmation(
        &self,
        invocation_id: Uuid,
        state: StoredState,
        code: &'static str,
        error: Option<ActionErrorCode>,
    ) {
        let store = Arc::clone(&self.store);
        let record = tokio::task::spawn_blocking(move || store.action_invocation(invocation_id))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        if let Some(record) = record {
            let _ = self.terminate_pre_start(&record, state, code, error).await;
        }
    }

    async fn start_claim(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<DesktopActionStartClaimParams>(params) else {
            return invalid_params(id);
        };
        let invocation_id = Uuid::parse_str(&params.invocation_id)
            .expect("protocol validation guarantees an invocation UUID");
        let correlation_id = Uuid::parse_str(&params.correlation_id)
            .expect("protocol validation guarantees a correlation UUID");
        if let Err(code) = self
            .providers
            .action_request_matches(
                &params.identity,
                invocation_id,
                correlation_id,
                params.attempt_epoch,
                &params.action_id,
                params.action_version,
                &params.target,
            )
            .await
        {
            return provider_failure(id, code);
        }
        let identity =
            match invocation_identity(&params.identity, params.attempt_epoch, &params.target) {
                Ok(identity) => identity,
                Err(code) => return action_failure(id, code),
            };
        let claim = ActionStartClaim {
            invocation_id,
            correlation_id,
            action_id: params.action_id,
            action_version: params.action_version,
            identity,
            claimed_at_ms: now_ms(),
        };
        let store = Arc::clone(&self.store);
        let outcome = tokio::task::spawn_blocking(move || store.claim_action_start(&claim)).await;
        match outcome {
            Ok(Ok(
                ActionLifecycleOutcome::Applied(granted) | ActionLifecycleOutcome::Replay(granted),
            )) => {
                self.emit_record(&granted);
                success(
                    id,
                    DesktopActionStartClaimResult {
                        invocation_id: invocation_id.to_string(),
                        correlation_id: correlation_id.to_string(),
                        attempt_epoch: params.attempt_epoch,
                        decision: DesktopActionStartDecision::Granted,
                        terminal_code: None,
                        granted_at_ms: Some(
                            u64::try_from(granted.updated_at_ms).unwrap_or(u64::MAX),
                        ),
                    },
                )
            }
            Ok(Ok(ActionLifecycleOutcome::Terminal(terminal)))
                if matches!(terminal.state, StoredState::Canceled | StoredState::Expired) =>
            {
                let (decision, terminal_code) = if terminal.state == StoredState::Canceled {
                    (
                        DesktopActionStartDecision::Canceled,
                        ActionTerminalCode::Canceled,
                    )
                } else {
                    (
                        DesktopActionStartDecision::Expired,
                        ActionTerminalCode::Expired,
                    )
                };
                success(
                    id,
                    DesktopActionStartClaimResult {
                        invocation_id: invocation_id.to_string(),
                        correlation_id: correlation_id.to_string(),
                        attempt_epoch: params.attempt_epoch,
                        decision,
                        terminal_code: Some(terminal_code),
                        granted_at_ms: None,
                    },
                )
            }
            Ok(Ok(ActionLifecycleOutcome::Mismatch)) => {
                action_failure(id, ActionErrorCode::CorrelationMismatch)
            }
            Ok(Ok(
                ActionLifecycleOutcome::InvalidState(_)
                | ActionLifecycleOutcome::NotFound
                | ActionLifecycleOutcome::ResourceLimit
                | ActionLifecycleOutcome::CancellationNotGuaranteed
                | ActionLifecycleOutcome::Terminal(_),
            )) => action_failure(id, ActionErrorCode::InvalidState),
            _ => storage_failure(id),
        }
    }

    #[allow(clippy::too_many_lines)]
    async fn acknowledge(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<DesktopActionAcknowledgeParams>(params) else {
            return invalid_params(id);
        };
        let invocation_id = Uuid::parse_str(&params.invocation_id)
            .expect("protocol validation guarantees an invocation UUID");
        let correlation_id = Uuid::parse_str(&params.correlation_id)
            .expect("protocol validation guarantees a correlation UUID");
        let Some(definition) = self.registry.definition(&params.action_id) else {
            return action_failure(id, ActionErrorCode::ActionNotFound);
        };
        let result_json = match &params.result {
            Some(result)
                if result.is_object()
                    && serde_json::to_vec(result).is_ok_and(|bytes| {
                        bytes.len() <= definition.limits.max_result_bytes as usize
                    }) =>
            {
                serde_json::to_string(result).ok()
            }
            Some(_) => return action_failure(id, ActionErrorCode::InvalidResult),
            None => None,
        };
        let identity =
            match invocation_identity(&params.identity, params.attempt_epoch, &params.target) {
                Ok(identity) => identity,
                Err(code) => return action_failure(id, code),
            };
        let (state, terminal_code) = match params.status {
            DesktopActionCompletionStatus::Succeeded => (StoredState::Acknowledged, "succeeded"),
            DesktopActionCompletionStatus::Failed => (StoredState::Failed, "failed"),
            DesktopActionCompletionStatus::Canceled => (StoredState::Canceled, "canceled"),
        };
        let ack = ActionTerminalAck {
            invocation_id,
            correlation_id,
            action_id: params.action_id,
            action_version: params.action_version,
            identity,
            state,
            terminal_code: terminal_code.to_owned(),
            error_code: params.error_code.map(action_error_code).map(str::to_owned),
            result_json,
            completed_at_ms: now_ms(),
        };
        let provider_id = ack.identity.provider_id;
        let store = Arc::clone(&self.store);
        let existing =
            tokio::task::spawn_blocking(move || store.action_invocation(invocation_id)).await;
        let existing = match existing {
            Ok(Ok(Some(existing))) => existing,
            Ok(Ok(None)) => return action_failure(id, ActionErrorCode::ActionNotFound),
            _ => return storage_failure(id),
        };
        if !existing.state.is_terminal()
            && let Err(code) = match params.status {
                DesktopActionCompletionStatus::Succeeded => {
                    self.providers
                        .action_provider_identity_valid(&params.identity, &params.target)
                        .await
                }
                DesktopActionCompletionStatus::Failed | DesktopActionCompletionStatus::Canceled => {
                    self.providers
                        .action_provider_lease_valid(&params.identity)
                        .await
                }
            }
        {
            return provider_failure(id, code);
        }
        let store = Arc::clone(&self.store);
        let outcome =
            tokio::task::spawn_blocking(move || store.acknowledge_action_terminal(&ack)).await;
        match outcome {
            Ok(Ok(ActionLifecycleOutcome::Applied(record))) => {
                self.providers
                    .action_finalize(provider_id, invocation_id)
                    .await;
                self.emit_record(&record);
                success(
                    id,
                    DesktopActionAcknowledgeResult {
                        invocation: snapshot(&record),
                    },
                )
            }
            Ok(Ok(ActionLifecycleOutcome::Terminal(terminal))) => {
                self.providers
                    .action_finalize(provider_id, invocation_id)
                    .await;
                success(
                    id,
                    DesktopActionAcknowledgeResult {
                        invocation: terminal_snapshot(invocation_id, correlation_id, &terminal),
                    },
                )
            }
            Ok(Ok(ActionLifecycleOutcome::Mismatch)) => {
                action_failure(id, ActionErrorCode::CorrelationMismatch)
            }
            Ok(Ok(
                ActionLifecycleOutcome::InvalidState(_)
                | ActionLifecycleOutcome::NotFound
                | ActionLifecycleOutcome::ResourceLimit
                | ActionLifecycleOutcome::CancellationNotGuaranteed
                | ActionLifecycleOutcome::Replay(_),
            )) => action_failure(id, ActionErrorCode::InvalidState),
            _ => storage_failure(id),
        }
    }

    async fn recover(&self, query: ActionRecoveryQuery) -> Result<Vec<ActionInvocationRecord>, ()> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.recover_action_invocations(query, 256))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())
    }

    async fn provider_recovery_pending(
        &self,
        identity: &ActionInvocationIdentity,
        now_ms: i64,
    ) -> bool {
        let recovery_identity = identity.clone();
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || {
            store.action_provider_identity_recoverable(&recovery_identity, now_ms)
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false)
    }

    async fn terminate_pre_start(
        &self,
        record: &ActionInvocationRecord,
        state: StoredState,
        code: &'static str,
        error_code: Option<ActionErrorCode>,
    ) -> Option<ActionInvocationRecord> {
        let store = Arc::clone(&self.store);
        let invocation_id = record.invocation_id;
        let correlation_id = record.correlation_id;
        let outcome = tokio::task::spawn_blocking(move || {
            store.terminate_action_before_start_with_error(
                invocation_id,
                correlation_id,
                state,
                code,
                error_code.map(action_error_code),
                now_ms(),
            )
        })
        .await
        .ok()?
        .ok()?;
        let ActionLifecycleOutcome::Applied(terminal) = outcome else {
            return None;
        };
        self.discard_project_confirmation(invocation_id).await;
        if let Some(identity) = &record.identity {
            let _ = self
                .providers
                .action_cancel_queued(identity.provider_id, invocation_id)
                .await;
        }
        self.emit_record(&terminal);
        Some(terminal)
    }

    async fn discard_project_confirmation(&self, invocation_id: Uuid) {
        let Some(project_actions) = &self.project_actions else {
            return;
        };
        if let Some(queued) = project_actions.remove(invocation_id).await {
            let _ = queued.coordinator.cancel(invocation_id);
            project_actions.confirmation_changed.notify_waiters();
        }
    }

    async fn cancel_running_project(&self, invocation_id: Uuid) {
        let Some(project_actions) = &self.project_actions else {
            return;
        };
        if let Some(coordinator) = project_actions.running.lock().await.get(&invocation_id) {
            let _ = coordinator.cancel(invocation_id);
        }
    }

    async fn force_terminal(
        &self,
        record: &ActionInvocationRecord,
        state: StoredState,
        code: &'static str,
    ) {
        self.discard_project_confirmation(record.invocation_id)
            .await;
        self.cancel_running_project(record.invocation_id).await;
        if record.state != StoredState::StartGranted {
            let error_code =
                (state == StoredState::Failed).then_some(ActionErrorCode::ExecutionFailed);
            let _ = self
                .terminate_pre_start(record, state, code, error_code)
                .await;
            return;
        }
        let Some(identity) = record.identity.clone() else {
            return;
        };
        let ack = ActionTerminalAck {
            invocation_id: record.invocation_id,
            correlation_id: record.correlation_id,
            action_id: record.action_id.clone(),
            action_version: record.action_version,
            identity: identity.clone(),
            state,
            terminal_code: code.to_owned(),
            error_code: (state == StoredState::Failed)
                .then(|| action_error_code(ActionErrorCode::ExecutionFailed).to_owned()),
            result_json: None,
            completed_at_ms: now_ms(),
        };
        let store = Arc::clone(&self.store);
        if let Ok(Ok(ActionLifecycleOutcome::Applied(terminal))) =
            tokio::task::spawn_blocking(move || store.acknowledge_action_terminal(&ack)).await
        {
            self.providers
                .action_finalize(identity.provider_id, record.invocation_id)
                .await;
            self.emit_record(&terminal);
        }
    }

    /// Reconcile restart recovery, lease loss, target generation changes, and timeout.
    pub(super) async fn reconcile(&self, _context: &ControlContext) -> Result<(), ()> {
        self.reconcile_provider_lifecycle().await
    }

    /// Converge inactive provider-owned invocations unless their exact durable identity remains
    /// authorized for bounded restart recovery.
    pub(super) async fn reconcile_provider_lifecycle(&self) -> Result<(), ()> {
        let records = self.recover(ActionRecoveryQuery::AllNonterminal).await?;
        let now = now_ms();
        for record in records {
            if record.expires_at_ms <= now {
                self.force_terminal(&record, StoredState::Expired, "expired")
                    .await;
                continue;
            }
            let Some(identity) = &record.identity else {
                self.force_terminal(&record, StoredState::Failed, "interrupted")
                    .await;
                continue;
            };
            if !self
                .providers
                .action_identity_is_active(
                    identity.provider_id,
                    identity.provider_epoch,
                    identity.provider_lease_id,
                    identity.window_id,
                    identity.window_generation,
                )
                .await
            {
                if self.provider_recovery_pending(identity, now).await {
                    continue;
                }
                self.force_terminal(&record, StoredState::Failed, "interrupted")
                    .await;
            }
        }
        Ok(())
    }

    pub(super) async fn cancel_caller(&self, caller_id: Uuid) {
        let Ok(records) = self.recover(ActionRecoveryQuery::AllNonterminal).await else {
            return;
        };
        for record in records
            .into_iter()
            .filter(|record| record.caller_id == caller_id)
        {
            self.cancel_running_project(record.invocation_id).await;
            if matches!(
                record.state,
                StoredState::StartClaimed | StoredState::StartGranted
            ) {
                // The caller is gone, so an already-granted native effect has an unknown outcome.
                // Persist `interrupted` immediately and let first-terminal-wins fencing reject a
                // late provider acknowledgement rather than leaving a nonterminal orphan.
                self.force_terminal(&record, StoredState::Failed, "interrupted")
                    .await;
            } else {
                let _ = self
                    .terminate_pre_start(&record, StoredState::Canceled, "canceled", None)
                    .await;
            }
        }
    }

    /// Converge every action when the service is shutting down. Granted effects become a durable
    /// interrupted outcome because there will be no live provider left to acknowledge them.
    pub(super) async fn shutdown(&self) -> Result<(), ()> {
        let records = self.recover(ActionRecoveryQuery::AllNonterminal).await?;
        let now = now_ms();
        for record in records {
            if let Some(identity) = &record.identity
                && !self
                    .providers
                    .action_identity_is_active(
                        identity.provider_id,
                        identity.provider_epoch,
                        identity.provider_lease_id,
                        identity.window_id,
                        identity.window_generation,
                    )
                    .await
                && self.provider_recovery_pending(identity, now).await
            {
                // Another fresh service may already own this recovery row. A stale service must
                // not turn the newly reconstructed request into an interrupted terminal while it
                // drains its own handlers.
                continue;
            }
            self.force_terminal(&record, StoredState::Failed, "interrupted")
                .await;
        }
        Ok(())
    }
}

pub(super) fn is_command(command: &str) -> bool {
    COMMANDS.contains(&command)
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: Value,
    context: &ControlContext,
    caller_id: Uuid,
) -> ResponseEnvelope {
    let Some(runtime) = &context.actions else {
        return action_failure(id, ActionErrorCode::CapabilityUnavailable);
    };
    if matches!(command, "action.list" | "action.invoke") {
        runtime.refresh_project_actions(context).await;
    }
    match command {
        "action.list" => runtime.list(id, params).await,
        "action.invoke" => runtime.invoke(id, params, context, caller_id).await,
        "action.cancel" => runtime.cancel(id, params, caller_id).await,
        "desktopAction.poll" => runtime.poll(id, params).await,
        "desktopAction.startClaim" => runtime.start_claim(id, params).await,
        "desktopAction.acknowledge" => runtime.acknowledge(id, params).await,
        "projectAction.confirmationPoll" => runtime.confirmation_poll(id, params).await,
        "projectAction.confirmationRespond" => runtime.confirmation_respond(id, params).await,
        _ => action_failure(id, ActionErrorCode::CapabilityUnavailable),
    }
}

pub(super) async fn forward_events(
    runtime: ActionRuntime,
    mut receiver: broadcast::Receiver<ActionRuntimeEvent>,
    sender: mpsc::Sender<Vec<u8>>,
) {
    loop {
        let envelope = match receiver.recv().await {
            Ok(event) => event.into_envelope(),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                ActionRuntimeEvent::Registry(ActionRegistryChangedEvent {
                    event: "action.registryChanged".to_owned(),
                    registry_revision: runtime.registry.revision(),
                    reason: ActionRegistryChangeReason::ResyncRequired,
                })
                .into_envelope()
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let Ok(frame) = super::serialize_frame(&envelope) else {
            continue;
        };
        if sender.send(frame).await.is_err() {
            return;
        }
    }
}

fn provider_generation(reservation: &ActionProviderReservation) -> ProviderWindowGeneration {
    ProviderWindowGeneration {
        provider_id: reservation.provider_id,
        provider_epoch: reservation.provider_epoch,
        provider_lease_id: reservation.provider_lease_id,
        window_id: reservation.window_id,
        generation: reservation.window_generation,
    }
}

fn project_challenge(
    challenge: ConfirmationChallenge,
    reservation: &ActionProviderReservation,
) -> ProjectActionConfirmationChallenge {
    ProjectActionConfirmationChallenge {
        invocation_id: challenge.invocation_id.to_string(),
        nonce: challenge.nonce.to_string(),
        challenge: challenge.challenge,
        identity: DesktopProviderIdentityParams {
            provider_id: reservation.provider_id.to_string(),
            provider_epoch: reservation.provider_epoch,
            lease_id: reservation.provider_lease_id.to_string(),
        },
        target: ActionInvocationTarget {
            window_id: reservation.window_id.to_string(),
            window_generation: reservation.window_generation,
        },
        confirmation_definition_sha256: challenge.confirmation_definition_sha256,
        action_id: challenge.action_id,
        display_title: challenge.display_title,
        executable_class: match challenge.executable_class {
            agent_workspace_action_runtime::ExecutableClass::ProjectRelative => {
                ProjectActionExecutableClass::ProjectRelative
            }
            agent_workspace_action_runtime::ExecutableClass::ApprovedName => {
                ProjectActionExecutableClass::ApprovedName
            }
        },
        argument_count: u16::try_from(challenge.argument_count).unwrap_or(u16::MAX),
        project_label: challenge.project_label,
        expires_at_ms: challenge.expires_at_unix_ms,
    }
}

fn confirmation_response(params: &ProjectActionConfirmationRespondParams) -> ConfirmationResponse {
    ConfirmationResponse {
        invocation_id: Uuid::parse_str(&params.invocation_id)
            .expect("protocol validation guarantees an invocation UUID"),
        nonce: Uuid::parse_str(&params.nonce)
            .expect("protocol validation guarantees a confirmation nonce UUID"),
        challenge: params.challenge.clone(),
        provider: ProviderWindowGeneration {
            provider_id: Uuid::parse_str(&params.identity.provider_id)
                .expect("protocol validation guarantees a provider UUID"),
            provider_epoch: params.identity.provider_epoch,
            provider_lease_id: Uuid::parse_str(&params.identity.lease_id)
                .expect("protocol validation guarantees a provider lease UUID"),
            window_id: Uuid::parse_str(&params.target.window_id)
                .expect("protocol validation guarantees a target window UUID"),
            generation: params.target.window_generation,
        },
        confirmation_definition_sha256: params.confirmation_definition_sha256.clone(),
    }
}

fn invocation_identity(
    identity: &DesktopProviderIdentityParams,
    attempt_epoch: u64,
    target: &ActionInvocationTarget,
) -> Result<ActionInvocationIdentity, ActionErrorCode> {
    Ok(ActionInvocationIdentity {
        attempt_epoch,
        provider_id: Uuid::parse_str(&identity.provider_id)
            .map_err(|_| ActionErrorCode::ProviderIneligible)?,
        provider_epoch: identity.provider_epoch,
        provider_lease_id: Uuid::parse_str(&identity.lease_id)
            .map_err(|_| ActionErrorCode::ProviderIneligible)?,
        window_id: Uuid::parse_str(&target.window_id)
            .map_err(|_| ActionErrorCode::TargetNotFound)?,
        window_generation: target.window_generation,
    })
}

fn invocation_uuid(epoch: Uuid, key: Uuid, action_id: &str) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(b"actions-v1");
    digest.update(epoch.as_bytes());
    digest.update(key.as_bytes());
    digest.update(action_id.as_bytes());
    let digest = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn request_hash(params: &ActionInvokeParams) -> String {
    let bytes = serde_json::to_vec(params).expect("validated action parameters serialize");
    let digest = Sha256::digest(bytes);
    digest.iter().fold(
        String::with_capacity(digest.len() * 2),
        |mut encoded, byte| {
            write!(&mut encoded, "{byte:02x}").expect("writing to a String is infallible");
            encoded
        },
    )
}

fn now_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn protocol_state(state: StoredState) -> ActionInvocationState {
    match state {
        StoredState::Accepted => ActionInvocationState::Accepted,
        StoredState::Leased => ActionInvocationState::Leased,
        StoredState::Dispatched => ActionInvocationState::Dispatched,
        StoredState::StartClaimed => ActionInvocationState::StartClaimed,
        StoredState::StartGranted => ActionInvocationState::StartGranted,
        StoredState::Acknowledged => ActionInvocationState::Acknowledged,
        StoredState::Failed => ActionInvocationState::Failed,
        StoredState::Canceled => ActionInvocationState::Canceled,
        StoredState::Expired => ActionInvocationState::Expired,
    }
}

fn terminal_code(code: &str) -> Option<ActionTerminalCode> {
    match code {
        "succeeded" => Some(ActionTerminalCode::Succeeded),
        "failed" => Some(ActionTerminalCode::Failed),
        "interrupted" => Some(ActionTerminalCode::Interrupted),
        "canceled" => Some(ActionTerminalCode::Canceled),
        "expired" => Some(ActionTerminalCode::Expired),
        _ => None,
    }
}

fn snapshot(record: &ActionInvocationRecord) -> ActionInvocationSnapshot {
    let result = record
        .terminal
        .as_ref()
        .and_then(|terminal| terminal.result_json.as_ref())
        .and_then(|json| serde_json::from_str(json).ok());
    let terminal = record.terminal.as_ref();
    ActionInvocationSnapshot {
        invocation_id: record.invocation_id.to_string(),
        correlation_id: record.correlation_id.to_string(),
        state: protocol_state(record.state),
        terminal_code: terminal.and_then(|terminal| terminal_code(&terminal.terminal_code)),
        result,
        error_code: terminal
            .and_then(|terminal| terminal.error_code.as_deref())
            .and_then(stored_action_error_code),
        updated_at_ms: u64::try_from(record.updated_at_ms).unwrap_or(u64::MAX),
    }
}

fn terminal_snapshot(
    invocation_id: Uuid,
    correlation_id: Uuid,
    terminal: &ActionTerminalOutcome,
) -> ActionInvocationSnapshot {
    ActionInvocationSnapshot {
        invocation_id: invocation_id.to_string(),
        correlation_id: correlation_id.to_string(),
        state: protocol_state(terminal.state),
        terminal_code: terminal_code(&terminal.terminal_code),
        result: terminal
            .result_json
            .as_ref()
            .and_then(|json| serde_json::from_str(json).ok()),
        error_code: terminal
            .error_code
            .as_deref()
            .and_then(stored_action_error_code),
        updated_at_ms: u64::try_from(terminal.completed_at_ms).unwrap_or(u64::MAX),
    }
}

fn success(id: String, value: impl Serialize) -> ResponseEnvelope {
    match serde_json::to_value(value) {
        Ok(value) => ResponseEnvelope::success(id, value),
        Err(_) => storage_failure(id),
    }
}

fn invalid_params(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "invalid_params",
        "The request parameters do not match the command contract",
    )
}

fn storage_failure(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(id, "storage_error", "Durable action state is unavailable")
}

fn service_action_response(
    id: String,
    outcome: Result<EpochIdempotentCommitResult, OperationFailure>,
) -> ResponseEnvelope {
    match outcome {
        Ok(
            EpochIdempotentCommitResult::Committed { result_json, .. }
            | EpochIdempotentCommitResult::Replay(result_json),
        ) => match serde_json::from_str::<ActionInvokeResult>(&result_json) {
            Ok(result) => success(id, result),
            Err(_) => storage_failure(id),
        },
        Ok(EpochIdempotentCommitResult::Conflict) => {
            action_failure(id, ActionErrorCode::IdempotencyConflict)
        }
        Ok(
            EpochIdempotentCommitResult::ResultExpired | EpochIdempotentCommitResult::EpochExpired,
        ) => action_failure(id, ActionErrorCode::IdempotencyExpired),
        Err(failure) => match failure.error {
            RuntimeError::StaleStateRevision { .. } | RuntimeError::StaleWindowRevision { .. } => {
                action_failure(id, ActionErrorCode::InvalidState)
            }
            RuntimeError::Domain(DomainError::ResourceLimit { .. }) => {
                action_failure(id, ActionErrorCode::ResourceLimit)
            }
            RuntimeError::Domain(
                DomainError::WorkspaceNotFound { .. } | DomainError::GroupNotFound { .. },
            ) => action_failure(id, ActionErrorCode::TargetNotFound),
            RuntimeError::Domain(_) => action_failure(id, ActionErrorCode::PolicyDenied),
            RuntimeError::Store(_) => storage_failure(id),
            _ => action_failure(id, ActionErrorCode::ExecutionFailed),
        },
    }
}

fn provider_failure(id: String, code: &str) -> ResponseEnvelope {
    action_failure(id, provider_error_code(code))
}

fn provider_error_code(code: &str) -> ActionErrorCode {
    match code {
        "provider_unavailable" => ActionErrorCode::ProviderUnavailable,
        "provider_ineligible" => ActionErrorCode::ProviderIneligible,
        "provider_backpressure" => ActionErrorCode::ProviderBackpressure,
        "provider_lease_expired" => ActionErrorCode::ProviderLeaseExpired,
        "provider_epoch_mismatch" => ActionErrorCode::ProviderEpochMismatch,
        "target_not_found" => ActionErrorCode::TargetNotFound,
        "target_stale" => ActionErrorCode::TargetStale,
        "correlation_mismatch" => ActionErrorCode::CorrelationMismatch,
        _ => ActionErrorCode::InvalidState,
    }
}

fn action_failure(id: String, code: ActionErrorCode) -> ResponseEnvelope {
    let stable = action_error_code(code);
    ResponseEnvelope::failure(id, stable, "The action request could not be completed")
}

fn action_error_code(code: ActionErrorCode) -> &'static str {
    match code {
        ActionErrorCode::CapabilityUnavailable => "capability_unavailable",
        ActionErrorCode::ActionNotFound => "action_not_found",
        ActionErrorCode::ActionVersionMismatch => "action_version_mismatch",
        ActionErrorCode::CursorInvalid => "cursor_invalid",
        ActionErrorCode::CursorExpired => "cursor_expired",
        ActionErrorCode::InvalidParameters => "invalid_parameters",
        ActionErrorCode::InvalidResult => "invalid_result",
        ActionErrorCode::Unauthorized => "unauthorized",
        ActionErrorCode::PolicyDenied => "policy_denied",
        ActionErrorCode::TargetRequired => "target_required",
        ActionErrorCode::TargetNotFound => "target_not_found",
        ActionErrorCode::TargetStale => "target_stale",
        ActionErrorCode::ProviderUnavailable => "provider_unavailable",
        ActionErrorCode::ProviderIneligible => "provider_ineligible",
        ActionErrorCode::ProviderBackpressure => "provider_backpressure",
        ActionErrorCode::ProviderLeaseExpired => "provider_lease_expired",
        ActionErrorCode::ProviderEpochMismatch => "provider_epoch_mismatch",
        ActionErrorCode::IdempotencyConflict => "idempotency_conflict",
        ActionErrorCode::IdempotencyExpired => "idempotency_expired",
        ActionErrorCode::ResourceLimit => "resource_limit",
        ActionErrorCode::ConfirmationRequired => "confirmation_required",
        ActionErrorCode::CancellationNotGuaranteed => "cancellation_not_guaranteed",
        ActionErrorCode::Canceled => "canceled",
        ActionErrorCode::Expired => "expired",
        ActionErrorCode::ExecutionFailed => "execution_failed",
        ActionErrorCode::CorrelationMismatch => "correlation_mismatch",
        ActionErrorCode::InvalidState => "invalid_state",
    }
}

fn stored_action_error_code(code: &str) -> Option<ActionErrorCode> {
    serde_json::from_value(Value::String(code.to_owned())).ok()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use agent_workspace_config::{
        AppConfig, ProjectActionDefinition, ProjectActionExecutable, ProjectActionManifest,
        ProjectActionWorkingDirectory, TrustedProjectRecord,
    };
    use agent_workspace_core::{ShortcutPlatform, Timestamp};
    use agent_workspace_protocol::{
        ActionIdempotency, DesktopProviderRegisterParams, DesktopProviderWindowClaim,
    };
    use agent_workspace_runtime::{
        BootstrapConfig, ProductionWorkspaceRuntime, TerminalManagerBackend,
    };
    use agent_workspace_terminal_runtime::TerminalManager;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    fn definition(id: &str) -> ActionDefinition {
        ActionDefinition {
            action_id: id.to_owned(),
            action_version: 1,
            localized_title_key: "actions.test".to_owned(),
            display_title: None,
            default_shortcut: None,
            category: "test".to_owned(),
            owner: ActionOwner::Desktop,
            parameter_schema_version: 1,
            result_schema_version: 1,
            authorization_class: ActionAuthorizationClass::Owner,
            interaction_class: ActionInteractionClass::DesktopInteraction,
            required_desktop_capability: Some("native-window-v1".to_owned()),
            limits: ActionLimits {
                max_parameter_bytes: 1_024,
                max_result_bytes: 1_024,
                timeout_ms: 30_000,
            },
        }
    }

    #[test]
    fn command_family_is_closed() {
        for command in COMMANDS {
            assert!(is_command(command));
        }
        assert!(!is_command("action.invoke.extra"));
        assert!(!is_command("desktopAction.register"));
        assert!(!is_command("projectAction.confirmation.poll"));
        assert!(!is_command("projectAction.confirm"));
    }

    fn project_manifest(root: &std::path::Path, action_id: &str) -> (ActionConfig, PathBuf) {
        let action = ProjectActionDefinition {
            id: action_id.to_owned(),
            title: "Trusted build".to_owned(),
            executable: ProjectActionExecutable::ProjectRelativePath {
                path: "scripts/build".to_owned(),
            },
            args: vec!["--locked".to_owned()],
            working_directory: ProjectActionWorkingDirectory::ProjectRoot,
            shortcut: Some("Primary+Shift+B".to_owned()),
            environment: Vec::new(),
        };
        let bytes = serde_json::to_vec(&ProjectActionManifest {
            schema_version: 1,
            actions: vec![action],
        })
        .unwrap();
        std::fs::create_dir_all(root.join(".cmux")).unwrap();
        std::fs::write(root.join(".cmux/actions.json"), &bytes).unwrap();
        let canonical = std::fs::canonicalize(root).unwrap();
        (
            ActionConfig {
                approved_executables: Vec::new(),
                trusted_projects: vec![TrustedProjectRecord {
                    canonical_root: canonical.to_str().unwrap().to_owned(),
                    manifest_sha256: format!("{:x}", Sha256::digest(bytes)),
                    trusted_at_unix_ms: 1,
                }],
            },
            canonical,
        )
    }

    #[test]
    fn trusted_workspace_manifests_project_dynamic_registry_metadata() {
        let root = TempDir::new().unwrap();
        let (config, canonical) = project_manifest(root.path(), "project.test.build");
        let (state, definitions) = build_project_registry(
            config,
            vec![("workspace-1".to_owned(), canonical, "Example".to_owned())],
        );
        assert_eq!(definitions.len(), 1);
        assert_eq!(
            definitions[0].display_title.as_deref(),
            Some("Trusted build")
        );
        assert_eq!(
            definitions[0].default_shortcut.as_deref(),
            Some("Primary+Shift+B")
        );
        assert_eq!(
            definitions[0].interaction_class,
            ActionInteractionClass::ConfirmationRequired
        );
        assert!(state.routes.contains_key("project.test.build"));
    }

    #[test]
    fn duplicate_project_ids_and_untrusted_roots_fail_closed() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let (mut config, first_root) = project_manifest(first.path(), "project.test.same");
        let (second_config, second_root) = project_manifest(second.path(), "project.test.same");
        config
            .trusted_projects
            .extend(second_config.trusted_projects);
        let (state, definitions) = build_project_registry(
            config,
            vec![
                ("workspace-1".to_owned(), first_root, "First".to_owned()),
                ("workspace-2".to_owned(), second_root, "Second".to_owned()),
            ],
        );
        assert!(definitions.is_empty());
        assert!(state.routes.is_empty());

        let reserved = TempDir::new().unwrap();
        let (config, reserved_root) = project_manifest(reserved.path(), "desktop.window.focus");
        let (state, definitions) = build_project_registry(
            config,
            vec![(
                "workspace-reserved".to_owned(),
                reserved_root,
                "Reserved".to_owned(),
            )],
        );
        assert!(definitions.is_empty());
        assert!(state.routes.is_empty());

        let untrusted = TempDir::new().unwrap();
        let (_, untrusted_root) = project_manifest(untrusted.path(), "project.test.untrusted");
        let (state, definitions) = build_project_registry(
            ActionConfig::default(),
            vec![(
                "workspace-untrusted".to_owned(),
                untrusted_root,
                "Untrusted".to_owned(),
            )],
        );
        assert!(definitions.is_empty());
        assert!(state.routes.is_empty());
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn project_confirmation_flow_is_durable_exact_and_fails_closed() {
        let temp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("project-actions.sqlite3"),
                ShortcutPlatform::NonMacOs,
            )
            .unwrap(),
        );
        let terminals = TerminalManager::new();
        let backend = Arc::new(TerminalManagerBackend::new(terminals));
        let bootstrap =
            BootstrapConfig::for_service(temp.path().to_path_buf(), Timestamp(1), 24, 80).unwrap();
        let workspace_runtime = Arc::new(
            ProductionWorkspaceRuntime::bootstrap(
                Arc::clone(&store),
                Arc::clone(&backend),
                bootstrap,
            )
            .await
            .unwrap(),
        );
        let (action_config, _) = project_manifest(temp.path(), "project.test.confirmed");
        let config_store = Arc::new(ConfigStore::new(temp.path().join("config/config.json")));
        let config = AppConfig {
            actions: action_config,
            ..AppConfig::default()
        };
        config_store.save(&config).unwrap();

        let state = workspace_runtime.snapshot().await;
        let proof = "p".repeat(43);
        let providers = MultiWindowRuntime::new(
            super::super::DesktopProviderBootstrapSecret::new(proof.as_bytes()).unwrap(),
        );
        let registration = providers
            .register(
                &state,
                DesktopProviderRegisterParams {
                    bootstrap_proof: proof,
                    instance_id: Uuid::new_v4().to_string(),
                    capabilities: vec![
                        "window-host-v1".to_owned(),
                        "tab-transfer-v1".to_owned(),
                        "browser-transfer-v1".to_owned(),
                        PROJECT_CONFIRMATION_CAPABILITY.to_owned(),
                    ],
                    windows: vec![DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 1,
                    }],
                },
            )
            .await
            .unwrap();
        let runtime =
            ActionRuntime::with_custom_actions(Arc::clone(&store), providers.clone(), config_store);
        let context = ControlContext {
            terminal_io: backend.terminal_io().clone(),
            terminal_backend: Some((*backend).clone()),
            logging_runtime: None,
            terminal_lifecycle: super::super::TerminalLifecycle::WorkspaceManaged,
            runtime: Some(workspace_runtime),
            persistence: None,
            card_slots: None,
            card_slots_v2: None,
            attention: None,
            actions: Some(runtime.clone()),
            browser_automation: None,
            agent_sessions: None,
            remote_sessions: None,
            sidebar_content: None,
            multi_window: Some(providers),
            platform: ShortcutPlatform::NonMacOs,
        };
        runtime.refresh_project_actions(&context).await;
        let epoch = store.current_idempotency_epoch().unwrap();
        let key = Uuid::new_v4();
        let correlation_id = Uuid::new_v4();
        let params = ActionInvokeParams {
            action_id: "project.test.confirmed".to_owned(),
            action_version: 1,
            parameters: json!({}),
            target: None,
            idempotency: ActionIdempotency {
                epoch: epoch.to_string(),
                key: key.to_string(),
            },
            correlation_id: correlation_id.to_string(),
        };
        let invoked = runtime
            .invoke(
                "project-invoke".to_owned(),
                serde_json::to_value(&params).unwrap(),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let invoked: ActionInvokeResult = serde_json::from_value(invoked.result.unwrap()).unwrap();
        assert_eq!(invoked.invocation.state, ActionInvocationState::Dispatched);

        let identity = DesktopProviderIdentityParams {
            provider_id: registration.provider_id,
            provider_epoch: registration.provider_epoch,
            lease_id: registration.lease_id,
        };
        let polled = runtime
            .confirmation_poll(
                "confirmation-poll".to_owned(),
                serde_json::to_value(ProjectActionConfirmationPollParams {
                    identity: identity.clone(),
                    timeout_ms: 0,
                })
                .unwrap(),
            )
            .await;
        let polled: ProjectActionConfirmationPollResult =
            serde_json::from_value(polled.result.unwrap()).unwrap();
        let challenge = polled.challenge.unwrap();
        assert_eq!(challenge.action_id, "project.test.confirmed");
        assert_eq!(challenge.project_label, state.workspaces[0].name);

        let responded = runtime
            .confirmation_respond(
                "confirmation-respond".to_owned(),
                serde_json::to_value(ProjectActionConfirmationRespondParams {
                    identity,
                    invocation_id: challenge.invocation_id.clone(),
                    nonce: challenge.nonce,
                    challenge: challenge.challenge,
                    target: challenge.target,
                    confirmation_definition_sha256: challenge.confirmation_definition_sha256,
                    decision: ProjectActionConfirmationDecision::Confirmed,
                })
                .unwrap(),
            )
            .await;
        assert!(responded.ok);
        let replayed = runtime
            .invoke(
                "project-replay".to_owned(),
                serde_json::to_value(params).unwrap(),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let replayed: ActionInvokeResult =
            serde_json::from_value(replayed.result.unwrap()).unwrap();
        assert_eq!(replayed.invocation.state, ActionInvocationState::Failed);
        assert!(matches!(
            replayed.invocation.error_code,
            Some(ActionErrorCode::CapabilityUnavailable | ActionErrorCode::ExecutionFailed)
        ));
    }

    #[test]
    fn production_registry_contains_bounded_executable_tier_a_set() {
        let definitions = production_definitions();
        assert_eq!(definitions.len(), 4);
        assert!(validate_definitions(&definitions).is_ok());
        let definition = definitions
            .iter()
            .find(|definition| definition.action_id == "desktop.window.focus")
            .expect("desktop focus definition");
        assert_eq!(definition.action_id, "desktop.window.focus");
        assert_eq!(definition.owner, ActionOwner::Desktop);
        assert_eq!(
            definition.required_desktop_capability.as_deref(),
            Some("desktop-window-focus-v1")
        );
        assert_eq!(definition.limits.max_parameter_bytes, 2);
        assert_eq!(definition.limits.max_result_bytes, 2);
        for action_id in [
            "workspace.card.pin",
            "workspace.group.rename",
            "workspace.group.collapse",
        ] {
            let definition = definitions
                .iter()
                .find(|definition| definition.action_id == action_id)
                .expect("service definition");
            assert_eq!(definition.owner, ActionOwner::Service);
            assert_eq!(
                definition.interaction_class,
                ActionInteractionClass::Headless
            );
            assert!(definition.required_desktop_capability.is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn approved_executables_use_only_available_trusted_fixed_paths() {
        let resolved = resolve_approved_executables(&[
            "true".to_owned(),
            "bash".to_owned(),
            "cargo".to_owned(),
            "cmake".to_owned(),
            "git".to_owned(),
            "make".to_owned(),
            "node".to_owned(),
            "npm".to_owned(),
            "python3".to_owned(),
            "not-an-application-mapping".to_owned(),
        ]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "true");
        assert_eq!(resolved[0].path, PathBuf::from("/usr/bin/true"));
    }

    #[test]
    fn interpreter_eval_modes_cannot_enter_the_project_registry() {
        for (index, (name, args)) in [
            ("bash", vec!["-c", "program"]),
            ("sh", vec!["-c", "program"]),
            ("env", vec!["sh", "-c", "program"]),
            ("python", vec!["-c", "program"]),
            ("python3", vec!["-c", "program"]),
            ("node", vec!["-e", "program"]),
            ("perl", vec!["-e", "program"]),
            ("ruby", vec!["-e", "program"]),
        ]
        .into_iter()
        .enumerate()
        {
            let root = TempDir::new().expect("temporary project");
            let action_id = format!("project.test.denied{index}");
            let action = ProjectActionDefinition {
                id: action_id.clone(),
                title: "Denied interpreter".to_owned(),
                executable: ProjectActionExecutable::ApprovedName {
                    name: name.to_owned(),
                },
                args: args.into_iter().map(str::to_owned).collect(),
                working_directory: ProjectActionWorkingDirectory::ProjectRoot,
                shortcut: None,
                environment: Vec::new(),
            };
            let bytes = serde_json::to_vec(&ProjectActionManifest {
                schema_version: 1,
                actions: vec![action],
            })
            .expect("manifest serializes");
            std::fs::create_dir_all(root.path().join(".cmux")).expect("manifest directory");
            std::fs::write(root.path().join(".cmux/actions.json"), &bytes)
                .expect("manifest writes");
            let canonical = std::fs::canonicalize(root.path()).expect("project canonicalizes");
            let config = ActionConfig {
                approved_executables: vec![name.to_owned()],
                trusted_projects: vec![TrustedProjectRecord {
                    canonical_root: canonical.to_string_lossy().into_owned(),
                    manifest_sha256: format!("{:x}", Sha256::digest(bytes)),
                    trusted_at_unix_ms: 1,
                }],
            };

            let (state, definitions) = build_project_registry(
                config,
                vec![("workspace-1".to_owned(), canonical, "Example".to_owned())],
            );
            assert!(definitions.is_empty(), "{name} must not be advertised");
            assert!(
                !state.routes.contains_key(&action_id),
                "{name} must not have an invocation route"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn approved_executable_validation_rejects_symlinks_and_user_owned_files() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};

        let root = TempDir::new().unwrap();
        let user_owned = root.path().join("tool");
        std::fs::write(&user_owned, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&user_owned, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!trusted_system_executable(user_owned.to_str().unwrap()));

        let link = root.path().join("tool-link");
        symlink("/usr/bin/true", &link).unwrap();
        assert!(!trusted_system_executable(link.to_str().unwrap()));
    }

    #[test]
    fn registry_cursor_rejects_forgery_staleness_and_expiry() {
        let registry = ActionRegistry::new(vec![definition("test.one"), definition("test.two")])
            .expect("registry");
        let epoch = Uuid::new_v4();
        let now = Instant::now();
        let first = registry
            .list_at(
                ActionListParams {
                    cursor: None,
                    limit: 1,
                },
                epoch,
                now,
            )
            .expect("first page");
        let cursor = first.next_cursor.expect("cursor");
        assert_eq!(
            registry.list_at(
                ActionListParams {
                    cursor: Some("forged".to_owned()),
                    limit: 1,
                },
                epoch,
                now,
            ),
            Err(RegistryError::Invalid)
        );
        let stale_cursor = cursor.clone();
        registry
            .replace(vec![definition("test.one"), definition("test.three")])
            .expect("replace");
        assert_eq!(
            registry.list_at(
                ActionListParams {
                    cursor: Some(stale_cursor),
                    limit: 1,
                },
                epoch,
                now,
            ),
            Err(RegistryError::Invalid)
        );
        let fresh = registry
            .list_at(
                ActionListParams {
                    cursor: None,
                    limit: 1,
                },
                epoch,
                now,
            )
            .expect("fresh page")
            .next_cursor
            .expect("fresh cursor");
        assert_eq!(
            registry.list_at(
                ActionListParams {
                    cursor: Some(fresh),
                    limit: 1,
                },
                epoch,
                now + Duration::from_secs(ACTION_CURSOR_TTL_SECONDS + 1),
            ),
            Err(RegistryError::Expired)
        );
    }

    #[test]
    fn registry_is_bounded_and_versioned() {
        let mut newer_duplicate = definition("test.same");
        newer_duplicate.action_version = 2;
        let duplicate = vec![definition("test.same"), newer_duplicate];
        assert!(ActionRegistry::new(duplicate).is_err());
        let too_many = (0..=MAX_ACTION_DEFINITIONS)
            .map(|index| definition(&format!("test.action-{index}")))
            .collect();
        assert!(ActionRegistry::new(too_many).is_err());
    }

    #[test]
    fn stable_error_strings_cover_every_protocol_code() {
        assert_eq!(
            action_error_code(ActionErrorCode::CancellationNotGuaranteed),
            "cancellation_not_guaranteed"
        );
        assert_eq!(
            action_error_code(ActionErrorCode::ProviderEpochMismatch),
            "provider_epoch_mismatch"
        );
        assert_eq!(
            action_error_code(ActionErrorCode::IdempotencyExpired),
            "idempotency_expired"
        );
        for (provider_code, protocol_code) in [
            ("target_not_found", ActionErrorCode::TargetNotFound),
            ("target_stale", ActionErrorCode::TargetStale),
            ("provider_ineligible", ActionErrorCode::ProviderIneligible),
            ("provider_unavailable", ActionErrorCode::ProviderUnavailable),
            (
                "provider_backpressure",
                ActionErrorCode::ProviderBackpressure,
            ),
        ] {
            assert_eq!(provider_error_code(provider_code), protocol_code);
            assert_eq!(action_error_code(protocol_code), provider_code);
        }
    }

    #[test]
    fn audit_projection_is_content_free() {
        let marker = "SECRET-MARKER-DO-NOT-LOG";
        let record = ActionInvocationRecord {
            invocation_id: Uuid::new_v4(),
            epoch: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            request_hash: "0".repeat(64),
            action_id: "workspace.card.pin".to_owned(),
            action_version: 1,
            correlation_id: Uuid::new_v4(),
            caller_id: Uuid::new_v4(),
            parameters_json: format!(r#"{{"value":"{marker}"}}"#),
            state: StoredState::Acknowledged,
            identity: None,
            terminal: Some(ActionTerminalOutcome {
                state: StoredState::Acknowledged,
                terminal_code: "succeeded".to_owned(),
                error_code: None,
                result_json: Some(format!(r#"{{"value":"{marker}"}}"#)),
                completed_at_ms: 11,
            }),
            accepted_at_ms: 10,
            updated_at_ms: 11,
            expires_at_ms: 40,
        };
        let rendered = format!("{:?}", action_audit(&record));
        assert!(!rendered.contains(marker));
        assert!(!rendered.contains("parameters_json"));
        assert!(!rendered.contains("result_json"));
        assert!(rendered.contains("parameter_bytes"));
        assert!(rendered.contains("result_bytes"));
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn caller_cleanup_and_shutdown_are_durable_replayable_terminals() {
        let temp = TempDir::new().expect("temporary directory");
        let store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("actions.sqlite3"),
                ShortcutPlatform::NonMacOs,
            )
            .expect("action store opens"),
        );
        let providers = MultiWindowRuntime::new(
            super::super::DesktopProviderBootstrapSecret::new([7_u8; 32])
                .expect("bootstrap proof is strong"),
        );
        let runtime = ActionRuntime::with_registry(
            Arc::clone(&store),
            providers,
            ActionRegistry::new(vec![definition("test.cleanup")]).expect("registry"),
        );
        let epoch = store.current_idempotency_epoch().expect("epoch");
        let caller_id = Uuid::new_v4();
        let accepted_at_ms = now_ms();
        let create = |key: Uuid, invocation_id: Uuid, correlation_id: Uuid, action_id: &str| {
            ActionInvocationCreate {
                invocation_id,
                epoch,
                idempotency_key: key,
                request_hash: "0".repeat(64),
                action_id: action_id.to_owned(),
                action_version: 1,
                correlation_id,
                caller_id,
                parameters_json: "{}".to_owned(),
                accepted_at_ms,
                expires_at_ms: accepted_at_ms + 30_000,
            }
        };

        let cleanup = create(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "test.cleanup",
        );
        assert!(matches!(
            store
                .create_action_invocation(&cleanup)
                .expect("create cleanup action"),
            ActionInvocationCreateOutcome::Created(_)
        ));
        runtime.cancel_caller(caller_id).await;
        assert!(matches!(
            store
                .create_action_invocation(&cleanup)
                .expect("replay cleanup action"),
            ActionInvocationCreateOutcome::Replay(ActionTerminalOutcome {
                state: StoredState::Canceled,
                ..
            })
        ));

        let granted = create(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "test.cleanup",
        );
        assert!(matches!(
            store
                .create_action_invocation(&granted)
                .expect("create granted cleanup action"),
            ActionInvocationCreateOutcome::Created(_)
        ));
        let exact = ActionInvocationIdentity {
            attempt_epoch: 1,
            provider_id: Uuid::new_v4(),
            provider_epoch: 1,
            provider_lease_id: Uuid::new_v4(),
            window_id: Uuid::new_v4(),
            window_generation: 1,
        };
        store
            .lease_action_invocation(
                granted.invocation_id,
                granted.correlation_id,
                &exact,
                accepted_at_ms + 1,
            )
            .expect("lease granted cleanup action");
        store
            .mark_action_dispatched(
                granted.invocation_id,
                granted.correlation_id,
                &exact,
                accepted_at_ms + 2,
            )
            .expect("dispatch granted cleanup action");
        store
            .claim_action_start(&ActionStartClaim {
                invocation_id: granted.invocation_id,
                correlation_id: granted.correlation_id,
                action_id: granted.action_id.clone(),
                action_version: granted.action_version,
                identity: exact,
                claimed_at_ms: accepted_at_ms + 3,
            })
            .expect("grant cleanup action start");
        runtime.cancel_caller(caller_id).await;
        assert!(matches!(
            store
                .create_action_invocation(&granted)
                .expect("replay interrupted granted action"),
            ActionInvocationCreateOutcome::Replay(ActionTerminalOutcome {
                state: StoredState::Failed,
                terminal_code,
                ..
            }) if terminal_code == "interrupted"
        ));

        let shutdown = create(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "test.cleanup",
        );
        assert!(matches!(
            store
                .create_action_invocation(&shutdown)
                .expect("create shutdown action"),
            ActionInvocationCreateOutcome::Created(_)
        ));
        runtime.shutdown().await.expect("shutdown reconciliation");
        assert!(matches!(
            store
                .create_action_invocation(&shutdown)
                .expect("replay shutdown action"),
            ActionInvocationCreateOutcome::Replay(ActionTerminalOutcome {
                state: StoredState::Failed,
                terminal_code,
                ..
            }) if terminal_code == "interrupted"
        ));
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn desktop_focus_runs_claim_ack_replay_and_cancel_wins_before_start() {
        let temp = TempDir::new().expect("temporary directory");
        let store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("lifecycle.sqlite3"),
                ShortcutPlatform::NonMacOs,
            )
            .expect("action store opens"),
        );
        let terminals = TerminalManager::new();
        let backend = Arc::new(TerminalManagerBackend::new(terminals));
        let config = BootstrapConfig::for_service(PathBuf::from(temp.path()), Timestamp(1), 24, 80)
            .expect("bootstrap config is valid");
        let workspace_runtime = Arc::new(
            ProductionWorkspaceRuntime::bootstrap(Arc::clone(&store), Arc::clone(&backend), config)
                .await
                .expect("workspace runtime bootstraps"),
        );
        let state = workspace_runtime.snapshot().await;
        let proof = "f".repeat(43);
        let providers = MultiWindowRuntime::new(
            super::super::DesktopProviderBootstrapSecret::new(proof.as_bytes())
                .expect("bootstrap proof is strong"),
        );
        let registration = providers
            .register(
                &state,
                DesktopProviderRegisterParams {
                    bootstrap_proof: proof,
                    instance_id: Uuid::new_v4().to_string(),
                    capabilities: vec![
                        "window-host-v1".to_owned(),
                        "tab-transfer-v1".to_owned(),
                        "browser-transfer-v1".to_owned(),
                        "desktop-window-focus-v1".to_owned(),
                    ],
                    windows: vec![DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 1,
                    }],
                },
            )
            .await
            .expect("desktop provider registers");
        let runtime = ActionRuntime::new(Arc::clone(&store), providers.clone());
        let context = ControlContext {
            terminal_io: backend.terminal_io().clone(),
            terminal_backend: Some((*backend).clone()),
            logging_runtime: None,
            terminal_lifecycle: super::super::TerminalLifecycle::WorkspaceManaged,
            runtime: Some(Arc::clone(&workspace_runtime)),
            persistence: None,
            card_slots: None,
            card_slots_v2: None,
            attention: None,
            actions: Some(runtime.clone()),
            browser_automation: None,
            agent_sessions: None,
            remote_sessions: None,
            sidebar_content: None,
            multi_window: Some(providers.clone()),
            platform: ShortcutPlatform::NonMacOs,
        };
        let epoch = store.current_idempotency_epoch().expect("epoch");
        let identity = DesktopProviderIdentityParams {
            provider_id: registration.provider_id,
            provider_epoch: registration.provider_epoch,
            lease_id: registration.lease_id,
        };

        let invoke_params = |key: Uuid, correlation_id: Uuid| ActionInvokeParams {
            action_id: "desktop.window.focus".to_owned(),
            action_version: 1,
            parameters: json!({}),
            target: Some(ActionInvocationTarget {
                window_id: state.focused_window_id.to_string(),
                window_generation: 1,
            }),
            idempotency: ActionIdempotency {
                epoch: epoch.to_string(),
                key: key.to_string(),
            },
            correlation_id: correlation_id.to_string(),
        };

        let service_params = ActionInvokeParams {
            action_id: "workspace.card.pin".to_owned(),
            action_version: 1,
            parameters: json!({
                "workspaceId": state.selected_workspace_id.to_string(),
                "pinned": true,
                "expectedRevision": state.revision,
            }),
            target: None,
            idempotency: ActionIdempotency {
                epoch: epoch.to_string(),
                key: Uuid::new_v4().to_string(),
            },
            correlation_id: Uuid::new_v4().to_string(),
        };
        let service_result = runtime
            .invoke(
                "invoke-service".to_owned(),
                serde_json::to_value(&service_params).expect("service params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let service_result: ActionInvokeResult =
            serde_json::from_value(service_result.result.expect("service action succeeds"))
                .expect("service result is strict");
        assert_eq!(
            service_result.invocation.state,
            ActionInvocationState::Acknowledged
        );
        assert!(
            workspace_runtime
                .snapshot()
                .await
                .workspace_pins
                .contains(&state.selected_workspace_id)
        );
        let service_replay = runtime
            .invoke(
                "invoke-service-replay".to_owned(),
                serde_json::to_value(service_params).expect("service replay params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let service_replay: ActionInvokeResult =
            serde_json::from_value(service_replay.result.expect("service replay succeeds"))
                .expect("service replay is strict");
        assert_eq!(service_replay, service_result);

        // Provider selection failures are terminal invocation snapshots, not transient envelope
        // errors. Exact replay must retain the stable public reason without re-running selection.
        let mut stale_params = invoke_params(Uuid::new_v4(), Uuid::new_v4());
        stale_params
            .target
            .as_mut()
            .expect("desktop focus has an explicit target")
            .window_generation = 2;
        let selection_failure = runtime
            .invoke(
                "invoke-stale".to_owned(),
                serde_json::to_value(&stale_params).expect("stale params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let selection_failure: ActionInvokeResult = serde_json::from_value(
            selection_failure
                .result
                .expect("selection failure is a successful terminal snapshot"),
        )
        .expect("stale selection result is strict");
        assert_eq!(
            selection_failure.invocation.state,
            ActionInvocationState::Failed
        );
        assert_eq!(
            selection_failure.invocation.error_code,
            Some(ActionErrorCode::TargetStale)
        );
        let stale_replay = runtime
            .invoke(
                "invoke-stale-replay".to_owned(),
                serde_json::to_value(stale_params).expect("stale replay params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let stale_replay: ActionInvokeResult = serde_json::from_value(
            stale_replay
                .result
                .expect("selection failure replay succeeds"),
        )
        .expect("stale replay result is strict");
        assert_eq!(stale_replay, selection_failure);

        let key = Uuid::new_v4();
        let correlation_id = Uuid::new_v4();
        let params = invoke_params(key, correlation_id);
        let invoked = runtime
            .invoke(
                "invoke".to_owned(),
                serde_json::to_value(&params).expect("invoke params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let invoked: ActionInvokeResult =
            serde_json::from_value(invoked.result.expect("invoke succeeds with a result"))
                .expect("invoke result is strict");
        assert_eq!(invoked.invocation.state, ActionInvocationState::Dispatched);

        let polled = runtime
            .poll(
                "poll".to_owned(),
                serde_json::to_value(DesktopActionPollParams {
                    identity: identity.clone(),
                    timeout_ms: 0,
                })
                .expect("poll params serialize"),
            )
            .await;
        let polled: agent_workspace_protocol::DesktopActionPollResult =
            serde_json::from_value(polled.result.expect("poll succeeds"))
                .expect("poll result is strict");
        let request = polled.request.expect("action request is queued");
        let claim = DesktopActionStartClaimParams {
            identity: identity.clone(),
            invocation_id: request.invocation_id.clone(),
            correlation_id: request.correlation_id.clone(),
            attempt_epoch: request.attempt_epoch,
            action_id: request.action_id.clone(),
            action_version: request.action_version,
            target: request.target.clone(),
        };
        let claimed = runtime
            .start_claim(
                "claim".to_owned(),
                serde_json::to_value(claim).expect("claim params serialize"),
            )
            .await;
        let claimed: DesktopActionStartClaimResult =
            serde_json::from_value(claimed.result.expect("claim succeeds"))
                .expect("claim result is strict");
        assert_eq!(claimed.decision, DesktopActionStartDecision::Granted);

        let successful_ack = DesktopActionAcknowledgeParams {
            identity: identity.clone(),
            invocation_id: request.invocation_id,
            correlation_id: request.correlation_id,
            attempt_epoch: request.attempt_epoch,
            action_id: request.action_id,
            action_version: request.action_version,
            target: request.target,
            status: DesktopActionCompletionStatus::Succeeded,
            result: Some(json!({})),
            error_code: None,
        };
        let acknowledged = runtime
            .acknowledge(
                "ack".to_owned(),
                serde_json::to_value(&successful_ack).expect("ack params serialize"),
            )
            .await;
        let acknowledged: DesktopActionAcknowledgeResult =
            serde_json::from_value(acknowledged.result.expect("ack succeeds"))
                .expect("ack result is strict");
        assert_eq!(
            acknowledged.invocation.state,
            ActionInvocationState::Acknowledged
        );
        assert_eq!(acknowledged.invocation.result, Some(json!({})));

        let replayed = runtime
            .invoke(
                "replay".to_owned(),
                serde_json::to_value(&params).expect("replay params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let replayed: ActionInvokeResult =
            serde_json::from_value(replayed.result.expect("replay succeeds"))
                .expect("replay result is strict");
        assert_eq!(
            replayed,
            ActionInvokeResult {
                invocation: acknowledged.invocation
            }
        );

        let failure_params = invoke_params(Uuid::new_v4(), Uuid::new_v4());
        let failed_invocation = runtime
            .invoke(
                "invoke-failure".to_owned(),
                serde_json::to_value(&failure_params).expect("failure params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        assert!(failed_invocation.ok);
        let failed_poll = runtime
            .poll(
                "poll-failure".to_owned(),
                serde_json::to_value(DesktopActionPollParams {
                    identity: identity.clone(),
                    timeout_ms: 0,
                })
                .expect("failure poll params serialize"),
            )
            .await;
        let failed_request = serde_json::from_value::<
            agent_workspace_protocol::DesktopActionPollResult,
        >(failed_poll.result.expect("failure poll succeeds"))
        .expect("failure poll result is strict")
        .request
        .expect("failure request is queued");
        let failed_claim = DesktopActionStartClaimParams {
            identity: identity.clone(),
            invocation_id: failed_request.invocation_id.clone(),
            correlation_id: failed_request.correlation_id.clone(),
            attempt_epoch: failed_request.attempt_epoch,
            action_id: failed_request.action_id.clone(),
            action_version: failed_request.action_version,
            target: failed_request.target.clone(),
        };
        assert!(
            runtime
                .start_claim(
                    "claim-failure".to_owned(),
                    serde_json::to_value(failed_claim).expect("failure claim params serialize"),
                )
                .await
                .ok
        );
        let failed_ack = runtime
            .acknowledge(
                "ack-failure".to_owned(),
                serde_json::to_value(DesktopActionAcknowledgeParams {
                    identity: identity.clone(),
                    invocation_id: failed_request.invocation_id,
                    correlation_id: failed_request.correlation_id,
                    attempt_epoch: failed_request.attempt_epoch,
                    action_id: failed_request.action_id,
                    action_version: failed_request.action_version,
                    target: failed_request.target,
                    status: DesktopActionCompletionStatus::Failed,
                    result: None,
                    error_code: Some(ActionErrorCode::TargetStale),
                })
                .expect("failed ack params serialize"),
            )
            .await;
        let failed_ack: DesktopActionAcknowledgeResult =
            serde_json::from_value(failed_ack.result.expect("failed ack succeeds"))
                .expect("failed ack result is strict");
        assert_eq!(failed_ack.invocation.state, ActionInvocationState::Failed);
        assert_eq!(
            failed_ack.invocation.error_code,
            Some(ActionErrorCode::TargetStale)
        );
        let failure_replay = runtime
            .invoke(
                "failure-replay".to_owned(),
                serde_json::to_value(failure_params).expect("failure replay params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let failure_replay: ActionInvokeResult =
            serde_json::from_value(failure_replay.result.expect("failure replay succeeds"))
                .expect("failure replay result is strict");
        assert_eq!(failure_replay.invocation, failed_ack.invocation);

        let cancel_params = invoke_params(Uuid::new_v4(), Uuid::new_v4());
        let pending = runtime
            .invoke(
                "invoke-cancel".to_owned(),
                serde_json::to_value(&cancel_params).expect("cancel invoke params serialize"),
                &context,
                Uuid::new_v4(),
            )
            .await;
        let pending: ActionInvokeResult =
            serde_json::from_value(pending.result.expect("second invoke succeeds"))
                .expect("second invoke result is strict");
        let cancel_request = ActionCancelParams {
            invocation_id: pending.invocation.invocation_id,
            correlation_id: pending.invocation.correlation_id,
        };
        let canceled = runtime
            .cancel(
                "cancel".to_owned(),
                serde_json::to_value(&cancel_request).expect("cancel params serialize"),
                Uuid::new_v4(),
            )
            .await;
        let canceled: ActionCancelResult =
            serde_json::from_value(canceled.result.expect("cancel succeeds"))
                .expect("cancel result is strict");
        assert_eq!(canceled.invocation.state, ActionInvocationState::Canceled);
        let cancel_replay = runtime
            .cancel(
                "cancel-replay".to_owned(),
                serde_json::to_value(cancel_request).expect("cancel replay params serialize"),
                Uuid::new_v4(),
            )
            .await;
        let cancel_replay: ActionCancelResult =
            serde_json::from_value(cancel_replay.result.expect("cancel replay succeeds"))
                .expect("cancel replay result is strict");
        assert_eq!(cancel_replay, canceled);

        providers
            .heartbeat(
                &workspace_runtime.snapshot().await,
                agent_workspace_protocol::DesktopProviderHeartbeatParams {
                    provider_id: identity.provider_id.clone(),
                    provider_epoch: identity.provider_epoch,
                    lease_id: identity.lease_id.clone(),
                    windows: vec![DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 2,
                    }],
                },
            )
            .await
            .expect("provider advances its target generation");
        let lost_ack_replay = runtime
            .acknowledge(
                "lost-ack-replay".to_owned(),
                serde_json::to_value(successful_ack).expect("lost ack replay params serialize"),
            )
            .await;
        let lost_ack_replay: DesktopActionAcknowledgeResult =
            serde_json::from_value(lost_ack_replay.result.expect("lost ack replay succeeds"))
                .expect("lost ack replay result is strict");
        assert_eq!(
            lost_ack_replay.invocation.state,
            ActionInvocationState::Acknowledged
        );

        workspace_runtime
            .shutdown()
            .await
            .expect("workspace runtime shuts down");
    }
}

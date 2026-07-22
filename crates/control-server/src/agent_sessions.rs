//! Production integration for the metadata-only agent-session catalog.

use std::{
    collections::BTreeMap,
    sync::Arc,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use agent_workspace_agent_adapter::{
    AdapterCapability, AdapterOperationContext, AdapterPlatform, AdapterRequest, CodexAdapter,
    ResumeOutcome, TrustedAdapterRegistry,
};
use agent_workspace_agent_session_runtime::{
    ForkExecutionOutcome, HibernationPreflight, LiveRuntimeEvidence, RestoreAssessmentInputs,
    RestoreExecutionOutcome, RuntimeError as AgentRuntimeError, assess_restore,
    execute_adapter_restore, execute_fork, hibernation_preflight as adapter_hibernation_preflight,
    reconcile_after_restart,
};
use agent_workspace_core::{PaneId, TabContent, TabId, Timestamp, WorkspaceId};
use agent_workspace_protocol::{
    AGENT_SESSION_CATALOG_VERSION, AgentArtifactDescriptor, AgentAttentionSetParams,
    AgentAttentionSetResult, AgentAttentionState, AgentAttentionTarget, AgentCatalogGetParams,
    AgentCatalogGetResult, AgentCatalogListParams, AgentCatalogListResult,
    AgentCatalogMutationIdentity, AgentCatalogRegisterParams, AgentCatalogRegisterResult,
    AgentDestructiveChoice, AgentForkProvenance, AgentHibernationCancelParams,
    AgentHibernationChallenge, AgentHibernationConfirmParams, AgentHibernationMutationResult,
    AgentHibernationPreflightParams, AgentHibernationPreflightResult, AgentHibernationState,
    AgentOperationIdentity, AgentProvenanceArtifact, AgentRestoreAssessParams,
    AgentRestoreAssessResult, AgentRestoreAssessment, AgentRestoreLevel, AgentRestoreOutcome,
    AgentSessionBinding, AgentSessionForkParams, AgentSessionForkResult, AgentSessionLifecycle,
    AgentSessionRestoreParams, AgentSessionRestoreResult, AgentSessionSnapshot,
    AgentTeamCreateParams, AgentTeamDeleteParams, AgentTeamMemberCreateParams,
    AgentTeamMemberDeleteParams, AgentTeamMemberMoveParams, AgentTeamMemberMutationResult,
    AgentTeamMemberSnapshot, AgentTeamMemberUpdateParams, AgentTeamMutationIdentity,
    AgentTeamMutationResult, AgentTeamSnapshot, AgentTeamUpdateParams, ResponseEnvelope,
    TaskActionKind, TaskTarget,
};
use agent_workspace_runtime::ProductionWorkspaceRuntime;
use agent_workspace_storage::{
    AgentAttentionRecord, AgentAttentionStateRecord, AgentCatalogMutationIdentityRecord,
    AgentCatalogMutationOutcome, AgentCatalogRecord, AgentHibernationConfirmationCreate,
    AgentHibernationConfirmationOutcome, AgentLifecycleRecord, AgentOperationBegin,
    AgentOperationBeginOutcome, AgentOperationRecord, AgentOperationStateRecord,
    AgentRestoreLevelRecord, AgentRestoreOutcomeRecord, AgentSessionBindingRecord,
    AgentSessionCreate, AgentSessionCreateOutcome, AgentSessionRecord, AgentSessionUpdate,
    AgentTeamMemberCreate, AgentTeamMemberMutationIdentityRecord, AgentTeamMemberRecord,
    AgentTeamMutationIdentityRecord, AgentTeamRecord, SqliteStateStore, StorageError,
};
use agent_workspace_terminal_runtime::TerminalIoHandle;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::multi_window::MultiWindowRuntime;

const COMMANDS: &[&str] = &[
    "agent.catalog.list",
    "agent.catalog.get",
    "agent.catalog.register",
    "agent.restore.assess",
    "agent.session.restore",
    "agent.session.fork",
    "agent.hibernate.preflight",
    "agent.hibernate.confirm",
    "agent.hibernate.cancel",
    "agent.team.create",
    "agent.team.update",
    "agent.team.delete",
    "agent.team.member.create",
    "agent.team.member.update",
    "agent.team.member.move",
    "agent.team.member.delete",
    "agent.attention.set",
];

#[derive(Clone)]
pub(super) struct AgentSessionControlRuntime {
    store: Arc<SqliteStateStore>,
    workspace: Arc<ProductionWorkspaceRuntime>,
    terminals: TerminalIoHandle,
    adapters: Arc<TrustedAdapterRegistry>,
    platform: AdapterPlatform,
    multi_window: Option<MultiWindowRuntime>,
    challenge_nonces: Arc<Mutex<BTreeMap<Uuid, ChallengeNonce>>>,
}

#[derive(Clone)]
struct ChallengeNonce {
    nonce: String,
    expires_at_ms: i64,
    agent_session_id: Uuid,
}

pub(super) struct AgentTaskActionOutcome {
    pub session: AgentSessionRecord,
    pub already_terminal: bool,
}

impl AgentSessionControlRuntime {
    pub(super) fn new(
        store: Arc<SqliteStateStore>,
        workspace: Arc<ProductionWorkspaceRuntime>,
        terminals: TerminalIoHandle,
        multi_window: Option<MultiWindowRuntime>,
    ) -> Result<Self, AgentRuntimeError> {
        store.import_agent_fork_orphan_recovery()?;
        reconcile_after_restart(&store, now_ms())?;
        let mut adapters = TrustedAdapterRegistry::default();
        if let Ok(adapter) = CodexAdapter::discover() {
            adapters.register(Arc::new(adapter))?;
        }
        let platform = host_platform();
        cleanup_fork_orphans(&store, &adapters, platform, now_ms())?;
        Ok(Self {
            store,
            workspace,
            terminals,
            adapters: Arc::new(adapters),
            platform,
            multi_window,
            challenge_nonces: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    async fn live_evidence(&self, session: &AgentSessionRecord) -> Option<LiveRuntimeEvidence> {
        self.terminal_for_binding(&session.binding).await?;
        let observed_at_ms = now_ms();
        Some(LiveRuntimeEvidence {
            agent_session_id: session.binding.agent_session_id,
            evidence_epoch: session.evidence_epoch,
            observed_at_ms,
        })
    }

    async fn terminal_for_binding(&self, binding: &AgentSessionBindingRecord) -> Option<String> {
        let snapshot = self.workspace.snapshot().await;
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.id.to_string() == binding.workspace_id.to_string())?;
        let pane = workspace.panes.get(&PaneId::from_uuid(binding.pane_id))?;
        if !pane
            .tabs
            .iter()
            .any(|tab| tab.to_string() == binding.tab_id.to_string())
        {
            return None;
        }
        let tab = workspace.tabs.get(&TabId::from_uuid(binding.tab_id))?;
        if tab.pane_id.to_string() != binding.pane_id.to_string() {
            return None;
        }
        let TabContent::Terminal {
            runtime_session_id: Some(terminal_id),
            ..
        } = &tab.content
        else {
            return None;
        };
        let terminal_id = terminal_id.to_string();
        let terminal = self.terminals.attach(&terminal_id).ok()?;
        (!terminal.terminal.exited).then_some(terminal_id)
    }

    async fn placement_is_live(&self, binding: &AgentSessionBindingRecord) -> bool {
        self.terminal_for_binding(binding).await.is_some()
    }

    pub(super) async fn task_action(
        &self,
        action: TaskActionKind,
        target: &TaskTarget,
    ) -> Result<AgentTaskActionOutcome, &'static str> {
        if action == TaskActionKind::Detach {
            return Err("unsupported_action");
        }
        let id = Uuid::parse_str(&target.session_id).map_err(|_| "target_not_found")?;
        let current = self
            .store
            .load_agent_session(id)
            .map_err(|_| "runtime_unavailable")?
            .ok_or("target_not_found")?;
        let durable_intent = match action {
            TaskActionKind::Cancel => "taskCancelled",
            TaskActionKind::Terminate => "taskTerminated",
            TaskActionKind::ForceTerminate => "taskForceTerminated",
            TaskActionKind::Detach => return Err("unsupported_action"),
        };
        if current.attempt_epoch != target.generation
            || (current.revision != target.revision && current.durable_intent != durable_intent)
        {
            return Err("target_stale");
        }
        if current.lifecycle.terminal() || current.durable_intent == durable_intent {
            return Ok(AgentTaskActionOutcome {
                already_terminal: current.durable_intent != durable_intent,
                session: current,
            });
        }
        if let Some(terminal_id) = self.terminal_for_binding(&current.binding).await {
            let detached = self
                .workspace
                .detach_terminal(
                    WorkspaceId::from_uuid(current.binding.workspace_id),
                    TabId::from_uuid(current.binding.tab_id),
                    agent_workspace_core::RuntimeSessionId::new(terminal_id),
                    Timestamp(u64::try_from(now_ms()).map_err(|_| "runtime_unavailable")?),
                )
                .await
                .map_err(|_| "runtime_unavailable")?;
            if !detached.termination_failures.is_empty() {
                return Err("runtime_unavailable");
            }
        }
        let session = self
            .store
            .complete_agent_task_action(
                id,
                target.revision,
                target.generation,
                durable_intent,
                now_ms(),
            )
            .map_err(|_| "target_stale")?;
        Ok(AgentTaskActionOutcome {
            session,
            already_terminal: false,
        })
    }
}

fn cleanup_fork_orphans(
    store: &SqliteStateStore,
    adapters: &TrustedAdapterRegistry,
    platform: AdapterPlatform,
    now: i64,
) -> Result<(), AgentRuntimeError> {
    for orphan in store.load_agent_fork_orphans()? {
        if store
            .load_agent_session(orphan.destination_agent_session_id)?
            .is_some()
        {
            store.clear_agent_fork_orphan(orphan.destination_agent_session_id)?;
            continue;
        }
        if let Ok(adapter) = adapters.resolve(
            &orphan.adapter_id,
            &orphan.adapter_version,
            platform,
            AdapterCapability::Fork,
            None,
            u64::try_from(now).unwrap_or(0),
        ) {
            if adapter
                .compensate_fork(orphan.destination_agent_session_id)
                .is_ok()
            {
                store.clear_agent_fork_orphan(orphan.destination_agent_session_id)?;
            } else {
                store.mark_agent_fork_orphan_archive_failed(
                    orphan.destination_agent_session_id,
                    now,
                )?;
            }
        }
    }
    Ok(())
}

pub(super) fn is_command(command: &str) -> bool {
    COMMANDS.contains(&command)
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> ResponseEnvelope {
    match dispatch_inner(command, params, runtime).await {
        Ok(result) => ResponseEnvelope::success(id, result),
        Err(error) => ResponseEnvelope::failure(id, error.code, error.message),
    }
}

#[derive(Debug)]
struct CommandError {
    code: &'static str,
    message: &'static str,
}

impl CommandError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[allow(clippy::too_many_lines)]
async fn dispatch_inner(
    command: &str,
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    match command {
        "agent.catalog.list" => {
            let _: AgentCatalogListParams = parse(params)?;
            encode(catalog_snapshot(runtime)?)
        }
        "agent.catalog.get" => {
            let params: AgentCatalogGetParams = parse(params)?;
            let id = uuid(&params.agent_session_id)?;
            let session = runtime
                .store
                .load_agent_session(id)
                .map_err(storage_error)?
                .ok_or_else(session_unavailable)?;
            let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
            encode(AgentCatalogGetResult {
                session: session_snapshot(&catalog, &session),
            })
        }
        "agent.catalog.register" => {
            let params: AgentCatalogRegisterParams = parse(params)?;
            if params.operation.session_revision != 1 {
                return Err(stale_revision());
            }
            let binding = binding_record(&params.binding)?;
            let operation_id = uuid(&params.operation.idempotency_key)?;
            let is_replay = runtime
                .store
                .load_agent_operation("catalog.register", operation_id)
                .map_err(storage_error)?
                .is_some();
            if !is_replay && !runtime.placement_is_live(&binding).await {
                return Err(CommandError::new(
                    "runtime_unavailable",
                    "The exact terminal binding is not live",
                ));
            }
            if !is_replay {
                let adapter = runtime
                    .adapters
                    .resolve(
                        &params.adapter_id,
                        &params.adapter_version,
                        runtime.platform,
                        AdapterCapability::Resume,
                        None,
                        u64::try_from(now_ms()).map_err(|_| invalid_params())?,
                    )
                    .map_err(|_| provider_unavailable())?;
                let context = AdapterOperationContext {
                    operation_id,
                    request_hash_sha256: digest(&params.operation.request_hash)?,
                    agent_session_id: binding.agent_session_id,
                    session_revision: params.operation.session_revision,
                    attempt_epoch: params.operation.attempt_epoch,
                };
                if !matches!(
                    adapter.resume(AdapterRequest {
                        context: &context,
                        platform: runtime.platform,
                        artifact: None,
                        credential: None,
                    }),
                    Ok(ResumeOutcome::Prepared(_) | ResumeOutcome::Resumed)
                ) {
                    return Err(provider_unavailable());
                }
            }
            let outcome = runtime
                .store
                .create_agent_session(&AgentSessionCreate {
                    binding,
                    adapter_id: params.adapter_id,
                    adapter_version: params.adapter_version,
                    title: params.title,
                    operation_id,
                    request_hash: params.operation.request_hash,
                    attempt_epoch: params.operation.attempt_epoch,
                    now_ms: now_ms(),
                    forked_from: None,
                })
                .map_err(storage_error)?;
            let session = match outcome {
                AgentSessionCreateOutcome::Created(value)
                | AgentSessionCreateOutcome::Replay(value) => value,
                AgentSessionCreateOutcome::Conflict => return Err(idempotency_conflict()),
                AgentSessionCreateOutcome::ResourceLimit => return Err(resource_limit()),
            };
            let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
            encode(AgentCatalogRegisterResult {
                session: session_snapshot(&catalog, &session),
            })
        }
        "agent.restore.assess" => assess(command, params, runtime).await,
        "agent.session.restore" => restore(params, runtime).await,
        "agent.session.fork" => fork(params, runtime).await,
        "agent.hibernate.preflight" => hibernation_preflight(params, runtime).await,
        "agent.hibernate.confirm" => hibernation_confirm(params, runtime).await,
        "agent.hibernate.cancel" => hibernation_cancel(params, runtime),
        "agent.team.create" => {
            let params: AgentTeamCreateParams = parse(params)?;
            let outcome = runtime
                .store
                .create_agent_team(
                    uuid(&params.team_id)?,
                    &params.title,
                    &catalog_mutation(&params.mutation)?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            let team = applied(outcome)?;
            encode(AgentTeamMutationResult {
                team: team_snapshot(runtime, &team)?,
            })
        }
        "agent.team.update" => {
            let params: AgentTeamUpdateParams = parse(params)?;
            let outcome = runtime
                .store
                .update_agent_team(
                    uuid(&params.team_id)?,
                    &params.title,
                    &team_mutation(&params.mutation)?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            let team = applied(outcome)?;
            encode(AgentTeamMutationResult {
                team: team_snapshot(runtime, &team)?,
            })
        }
        "agent.team.delete" => {
            let params: AgentTeamDeleteParams = parse(params)?;
            applied(
                runtime
                    .store
                    .delete_agent_team(
                        uuid(&params.team_id)?,
                        &team_mutation(&params.mutation)?,
                        now_ms(),
                    )
                    .map_err(storage_error)?,
            )?;
            encode(catalog_snapshot(runtime)?)
        }
        "agent.team.member.create" => {
            let params: AgentTeamMemberCreateParams = parse(params)?;
            let outcome = runtime
                .store
                .add_agent_team_member(&AgentTeamMemberCreate {
                    member_id: uuid(&params.member_id)?,
                    team_id: uuid(&params.team_id)?,
                    role: params.role,
                    target: binding_record(&params.target)?,
                    parent_member_id: params.parent_member_id.as_deref().map(uuid).transpose()?,
                    mutation: team_mutation(&params.mutation)?,
                    now_ms: now_ms(),
                })
                .map_err(storage_error)?;
            encode(AgentTeamMemberMutationResult {
                member: member_snapshot(&applied(outcome)?),
            })
        }
        "agent.team.member.update" => {
            let params: AgentTeamMemberUpdateParams = parse(params)?;
            let outcome = runtime
                .store
                .update_agent_team_member(
                    uuid(&params.team_id)?,
                    uuid(&params.member_id)?,
                    &params.role,
                    params.parent_member_id.as_deref().map(uuid).transpose()?,
                    &member_mutation(&params.mutation)?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            encode(AgentTeamMemberMutationResult {
                member: member_snapshot(&applied(outcome)?),
            })
        }
        "agent.team.member.move" => {
            let params: AgentTeamMemberMoveParams = parse(params)?;
            let target = binding_record(&params.target)?;
            let outcome = runtime
                .store
                .move_agent_team_member(
                    uuid(&params.team_id)?,
                    uuid(&params.member_id)?,
                    &target,
                    &member_mutation(&params.mutation)?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            encode(AgentTeamMemberMutationResult {
                member: member_snapshot(&applied(outcome)?),
            })
        }
        "agent.team.member.delete" => {
            let params: AgentTeamMemberDeleteParams = parse(params)?;
            applied(
                runtime
                    .store
                    .delete_agent_team_member(
                        uuid(&params.team_id)?,
                        uuid(&params.member_id)?,
                        &member_mutation(&params.mutation)?,
                        now_ms(),
                    )
                    .map_err(storage_error)?,
            )?;
            let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
            let team = catalog
                .teams
                .iter()
                .find(|team| team.team_id.to_string() == params.team_id)
                .ok_or_else(|| CommandError::new("team_unavailable", "The team is unavailable"))?;
            encode(AgentTeamMutationResult {
                team: team_snapshot_from(&catalog, team),
            })
        }
        "agent.attention.set" => attention_set(params, runtime),
        _ => Err(CommandError::new(
            "unknown_command",
            "Unknown agent-session command",
        )),
    }
}

async fn assess(
    _command: &str,
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: AgentRestoreAssessParams = parse(params)?;
    let id = uuid(&params.agent_session_id)?;
    let admission = begin_operation(runtime, "session.restoreAssess", id, &params.operation)?;
    let session = runtime
        .store
        .load_agent_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_unavailable)?;
    let now = now_ms();
    match admission {
        OperationAdmission::Pending => return Err(operation_pending()),
        OperationAdmission::Replay(_) => {
            return encode(AgentRestoreAssessResult {
                assessment: AgentRestoreAssessment {
                    level: restore_level(session.restore_level),
                    assessed_at_ms: u64::try_from(session.last_verified_at_ms)
                        .map_err(|_| invalid_params())?,
                    evidence_epoch: session.evidence_epoch,
                },
            });
        }
        OperationAdmission::Begun => {}
    }
    let live = runtime.live_evidence(&session).await;
    let level = assess_restore(
        &runtime.adapters,
        &session,
        runtime.platform,
        now,
        RestoreAssessmentInputs {
            live,
            resume_artifact: None,
            durable_layout_available: false,
        },
    );
    let updated = runtime
        .store
        .update_agent_session(&AgentSessionUpdate {
            agent_session_id: id,
            expected_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
            lifecycle: session.lifecycle,
            durable_intent: "none".to_owned(),
            restore_level: level,
            restore_outcome: session.restore_outcome,
            hibernation_state: session.hibernation_state,
            evidence_epoch: session.evidence_epoch + 1,
            verified_at_ms: now.max(session.last_verified_at_ms),
            checkpoint: session.checkpoint,
        })
        .map_err(storage_error)?;
    finish_operation(
        runtime,
        "session.restoreAssess",
        &params.operation,
        "assessed",
        now,
    )?;
    encode(AgentRestoreAssessResult {
        assessment: AgentRestoreAssessment {
            level: restore_level(level),
            assessed_at_ms: u64::try_from(now).map_err(|_| invalid_params())?,
            evidence_epoch: updated.evidence_epoch,
        },
    })
}

#[allow(clippy::too_many_lines)]
async fn restore(
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: AgentSessionRestoreParams = parse(params)?;
    let id = uuid(&params.agent_session_id)?;
    let session = runtime
        .store
        .load_agent_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_unavailable)?;
    if let Some(operation) = runtime
        .store
        .load_agent_operation("session.restore", uuid(&params.operation.idempotency_key)?)
        .map_err(storage_error)?
    {
        if operation.agent_session_id != id
            || operation.session_revision != params.operation.session_revision
            || operation.attempt_epoch != params.operation.attempt_epoch
            || operation.request_hash != params.operation.request_hash
        {
            return Err(idempotency_conflict());
        }
        if operation.state == AgentOperationStateRecord::Pending {
            return Err(operation_pending());
        }
        let terminal_code = operation.terminal_code.as_deref().unwrap_or_default();
        let replay_outcome = match terminal_code {
            "liveReattached" => AgentRestoreOutcome::LiveReattached,
            "resumed" => AgentRestoreOutcome::Resumed,
            "layoutRestarted" | "layoutAlreadyRunning" => AgentRestoreOutcome::LayoutRestarted,
            "restoreUnavailable" | "adapterRejected" | "adapterUnavailable" => {
                return Err(CommandError::new(
                    "provider_unavailable",
                    "No trusted adapter can perform this operation",
                ));
            }
            "serviceRestart" => {
                return Err(CommandError::new(
                    "invalid_state",
                    "The restore operation was interrupted by service restart",
                ));
            }
            _ => {
                return Err(CommandError::new(
                    "invalid_state",
                    "The restore replay outcome is unavailable",
                ));
            }
        };
        let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
        return encode(AgentSessionRestoreResult {
            outcome: replay_outcome,
            session: session_snapshot(&catalog, &session),
        });
    }
    let now = now_ms();
    let outcome = if runtime.live_evidence(&session).await.is_some() {
        match begin_operation(runtime, "session.restore", id, &params.operation)? {
            OperationAdmission::Pending => return Err(operation_pending()),
            OperationAdmission::Replay(_) => {
                let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
                return encode(AgentSessionRestoreResult {
                    outcome: session.restore_outcome.map_or(
                        AgentRestoreOutcome::LiveReattached,
                        protocol_restore_outcome,
                    ),
                    session: session_snapshot(&catalog, &session),
                });
            }
            OperationAdmission::Begun => {}
        }
        RestoreExecutionOutcome::Replay {
            terminal_code: "liveReattached".to_owned(),
        }
    } else {
        if session.revision != params.operation.session_revision
            || session.attempt_epoch != params.operation.attempt_epoch
        {
            return Err(stale_revision());
        }
        execute_adapter_restore(
            &runtime.store,
            &runtime.adapters,
            &session,
            runtime.platform,
            &operation_context(&session, &params.operation)?,
            None,
            false,
            u64::try_from(now).map_err(|_| invalid_params())?,
        )
        .map_err(runtime_error)?
    };
    let (restore_outcome, success_identity) = match outcome {
        RestoreExecutionOutcome::ResumeAttempting => {
            (AgentRestoreOutcomeRecord::ResumeAttempting, None)
        }
        RestoreExecutionOutcome::ResumePrepared {
            plan,
            session_revision,
            attempt_epoch,
        } => {
            if runtime
                .workspace
                .restart_terminal_verified(
                    WorkspaceId::from_uuid(session.binding.workspace_id),
                    TabId::from_uuid(session.binding.tab_id),
                    Some(plan.command()),
                    Some(plan.executable_identity()),
                    Timestamp(u64::try_from(now).map_err(|_| invalid_params())?),
                )
                .await
                .is_err()
            {
                finish_failed_operation(
                    runtime,
                    "session.restore",
                    &params.operation,
                    "runtimeLaunchFailed",
                )?;
                return Err(CommandError::new(
                    "runtime_unavailable",
                    "The exact terminal could not be replaced",
                ));
            }
            (
                AgentRestoreOutcomeRecord::Resumed,
                Some((session_revision, attempt_epoch, "resumed")),
            )
        }
        RestoreExecutionOutcome::Resumed {
            session_revision,
            attempt_epoch,
        } => (
            AgentRestoreOutcomeRecord::Resumed,
            Some((session_revision, attempt_epoch, "resumed")),
        ),
        RestoreExecutionOutcome::LayoutRestarted {
            session_revision,
            attempt_epoch,
            terminal_code,
        } => (
            AgentRestoreOutcomeRecord::LayoutRestarted,
            Some((session_revision, attempt_epoch, terminal_code)),
        ),
        RestoreExecutionOutcome::Replay { ref terminal_code }
            if terminal_code == "liveReattached" =>
        {
            (
                AgentRestoreOutcomeRecord::LiveReattached,
                Some((session.revision, session.attempt_epoch, "liveReattached")),
            )
        }
        RestoreExecutionOutcome::Pending => return Err(operation_pending()),
        RestoreExecutionOutcome::Replay { .. } => {
            return Err(CommandError::new(
                "invalid_state",
                "The restore replay bypassed durable replay handling",
            ));
        }
    };
    let updated = if let Some((expected_revision, attempt_epoch, terminal_code)) = success_identity
    {
        runtime
            .store
            .finish_agent_restore_success(
                uuid(&params.operation.idempotency_key)?,
                &params.operation.request_hash,
                id,
                expected_revision,
                attempt_epoch,
                restore_outcome,
                terminal_code,
                now,
            )
            .map_err(storage_error)?
    } else {
        let latest = runtime
            .store
            .load_agent_session(id)
            .map_err(storage_error)?
            .ok_or_else(session_unavailable)?;
        runtime
            .store
            .update_agent_session(&AgentSessionUpdate {
                agent_session_id: id,
                expected_revision: latest.revision,
                attempt_epoch: latest.attempt_epoch,
                lifecycle: latest.lifecycle,
                durable_intent: "restore".to_owned(),
                restore_level: latest.restore_level,
                restore_outcome: Some(restore_outcome),
                hibernation_state: latest.hibernation_state,
                evidence_epoch: latest.evidence_epoch,
                verified_at_ms: now.max(latest.last_verified_at_ms),
                checkpoint: latest.checkpoint,
            })
            .map_err(storage_error)?
    };
    let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
    encode(AgentSessionRestoreResult {
        outcome: protocol_restore_outcome(restore_outcome),
        session: session_snapshot(&catalog, &updated),
    })
}

#[allow(clippy::too_many_lines)]
async fn fork(params: Value, runtime: &AgentSessionControlRuntime) -> Result<Value, CommandError> {
    let params: AgentSessionForkParams = parse(params)?;
    let source_id = uuid(&params.source_agent_session_id)?;
    let source = exact_session(runtime, source_id, &params.operation)?;
    let placement = AgentSessionBindingRecord {
        workspace_id: uuid(&params.destination.workspace_id)?,
        pane_id: uuid(&params.destination.pane_id)?,
        tab_id: uuid(&params.destination.tab_id)?,
        agent_session_id: Uuid::nil(),
    };
    if placement.workspace_id == source.binding.workspace_id
        && placement.pane_id == source.binding.pane_id
        && placement.tab_id == source.binding.tab_id
    {
        return Err(CommandError::new(
            "invalid_params",
            "The fork destination must be a different live terminal",
        ));
    }
    let operation_id = uuid(&params.operation.idempotency_key)?;
    let is_replay = runtime
        .store
        .load_agent_operation("session.fork", operation_id)
        .map_err(storage_error)?
        .is_some();
    if !is_replay && !runtime.placement_is_live(&placement).await {
        return Err(CommandError::new(
            "runtime_unavailable",
            "The fork destination terminal is not live",
        ));
    }
    if !is_replay
        && runtime
            .store
            .load_agent_catalog()
            .map_err(storage_error)?
            .sessions
            .len()
            >= 512
    {
        return Err(resource_limit());
    }
    let outcome = execute_fork(
        &runtime.store,
        &runtime.adapters,
        &source,
        runtime.platform,
        &operation_context(&source, &params.operation)?,
        placement.workspace_id,
        placement.pane_id,
        placement.tab_id,
        params.title,
        u64::try_from(now_ms()).map_err(|_| invalid_params())?,
    )
    .map_err(runtime_error)?;
    let session = match outcome {
        ForkExecutionOutcome::Created { session, launch } => {
            let Some(plan) = launch else {
                return Err(CommandError::new(
                    "provider_unavailable",
                    "The adapter did not provide an executable fork plan",
                ));
            };
            if runtime
                .workspace
                .restart_terminal_verified(
                    WorkspaceId::from_uuid(session.binding.workspace_id),
                    TabId::from_uuid(session.binding.tab_id),
                    Some(plan.command()),
                    Some(plan.executable_identity()),
                    Timestamp(u64::try_from(now_ms()).map_err(|_| invalid_params())?),
                )
                .await
                .is_err()
            {
                let _ = runtime.store.update_agent_session(&AgentSessionUpdate {
                    agent_session_id: session.binding.agent_session_id,
                    expected_revision: session.revision,
                    attempt_epoch: session.attempt_epoch,
                    lifecycle: AgentLifecycleRecord::Failed,
                    durable_intent: "forkLaunchFailed".to_owned(),
                    restore_level: AgentRestoreLevelRecord::Unavailable,
                    restore_outcome: None,
                    hibernation_state: session.hibernation_state,
                    evidence_epoch: session.evidence_epoch,
                    verified_at_ms: now_ms().max(session.last_verified_at_ms),
                    checkpoint: session.checkpoint.clone(),
                });
                return Err(CommandError::new(
                    "runtime_unavailable",
                    "The forked thread exists but its destination terminal failed to start",
                ));
            }
            session
        }
        ForkExecutionOutcome::Replay(value) => {
            if value.lifecycle == AgentLifecycleRecord::Failed {
                return Err(CommandError::new(
                    "runtime_unavailable",
                    "The forked thread exists but its destination terminal failed to start",
                ));
            }
            value
        }
        ForkExecutionOutcome::Pending => {
            return Err(CommandError::new(
                "operation_pending",
                "The fork operation is pending",
            ));
        }
        ForkExecutionOutcome::ResourceLimit => return Err(resource_limit()),
    };
    let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
    encode(AgentSessionForkResult {
        session: session_snapshot(&catalog, &session),
    })
}

#[allow(clippy::too_many_lines)]
async fn hibernation_preflight(
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: AgentHibernationPreflightParams = parse(params)?;
    let id = uuid(&params.agent_session_id)?;
    if params.challenge.choice != AgentDestructiveChoice::TerminateAfterWarning {
        return Err(CommandError::new(
            "invalid_params",
            "Only a proposed destructive disposition can issue a challenge",
        ));
    }
    runtime
        .multi_window
        .as_ref()
        .ok_or_else(provider_unavailable)?
        .action_provider_identity_valid(&params.challenge.provider, &params.challenge.window)
        .await
        .map_err(|_| provider_unavailable())?;
    let admission = begin_operation(runtime, "session.hibernatePreflight", id, &params.operation)?;
    let session = runtime
        .store
        .load_agent_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_unavailable)?;
    match admission {
        OperationAdmission::Pending => return Err(operation_pending()),
        OperationAdmission::Replay(_) => {
            let replay = runtime
                .store
                .load_hibernation_challenge_replay(uuid(&params.operation.idempotency_key)?)
                .map_err(storage_error)?
                .ok_or_else(|| {
                    CommandError::new("invalid_state", "The challenge is unavailable")
                })?;
            if replay.confirmation.consumed_at_ms.is_some()
                || replay.confirmation.request.expires_at_ms <= now_ms()
            {
                return Err(CommandError::new(
                    "invalid_state",
                    "The replayed challenge expired or was invalidated",
                ));
            }
            let issued = replay.confirmation.request;
            return encode(AgentHibernationPreflightResult {
                state: protocol_hibernation(
                    session.hibernation_state.unwrap_or(
                        agent_workspace_storage::AgentHibernationStateRecord::Interrupted,
                    ),
                ),
                confirmation_id: Some(issued.confirmation_id.to_string()),
                challenge: Some(AgentHibernationChallenge {
                    confirmation_id: issued.confirmation_id.to_string(),
                    choice: AgentDestructiveChoice::TerminateAfterWarning,
                    provider: agent_workspace_protocol::DesktopProviderIdentityParams {
                        provider_id: issued.provider_id.to_string(),
                        provider_epoch: issued.provider_epoch,
                        lease_id: issued.provider_lease_id.to_string(),
                    },
                    window: agent_workspace_protocol::ActionInvocationTarget {
                        window_id: issued.window_id.to_string(),
                        window_generation: issued.window_generation,
                    },
                    nonce: runtime
                        .challenge_nonces
                        .lock()
                        .map_err(|_| {
                            CommandError::new("invalid_state", "The challenge is unavailable")
                        })?
                        .get(&issued.confirmation_id)
                        .filter(|entry| entry.expires_at_ms > now_ms())
                        .map(|entry| entry.nonce.clone())
                        .ok_or_else(|| {
                            CommandError::new("invalid_state", "The challenge was invalidated")
                        })?,
                    expires_at_ms: u64::try_from(issued.expires_at_ms)
                        .map_err(|_| invalid_params())?,
                }),
                checkpoint: session
                    .checkpoint
                    .as_ref()
                    .map(|checkpoint| AgentArtifactDescriptor {
                        descriptor_version: 1,
                        kind: checkpoint.kind.clone(),
                        digest_sha256: checkpoint.digest_sha256.clone(),
                        size_bytes: 16,
                        created_at_ms: u64::try_from(checkpoint.verified_at_ms).unwrap_or(0),
                        expires_at_ms: u64::try_from(checkpoint.expires_at_ms).unwrap_or(0),
                    }),
            });
        }
        OperationAdmission::Begun => {}
    }
    let requested = transition(
        runtime,
        &session,
        AgentHibernationState::Requested,
        "hibernate",
    )?;
    let preflight = transition(
        runtime,
        &requested,
        AgentHibernationState::Preflight,
        "hibernate",
    )?;
    let result = adapter_hibernation_preflight(
        &runtime.adapters,
        &preflight,
        runtime.platform,
        &operation_context(&preflight, &params.operation)?,
        u64::try_from(now_ms()).map_err(|_| invalid_params())?,
    )
    .map_err(runtime_error)?;
    let (confirmation, checkpoint) = match result {
        HibernationPreflight::ConfirmationRequired => (
            transition(
                runtime,
                &preflight,
                AgentHibernationState::ConfirmationRequired,
                "hibernate",
            )?,
            None,
        ),
        HibernationPreflight::CheckpointVerified(checkpoint) => {
            let updated = runtime
                .store
                .update_agent_session(&AgentSessionUpdate {
                    agent_session_id: id,
                    expected_revision: preflight.revision,
                    attempt_epoch: preflight.attempt_epoch,
                    lifecycle: AgentLifecycleRecord::Checkpointing,
                    durable_intent: "hibernate".to_owned(),
                    restore_level: preflight.restore_level,
                    restore_outcome: preflight.restore_outcome,
                    hibernation_state: Some(
                        agent_workspace_storage::AgentHibernationStateRecord::CheckpointVerified,
                    ),
                    evidence_epoch: preflight.evidence_epoch,
                    verified_at_ms: checkpoint.verified_at_ms,
                    checkpoint: Some(checkpoint.clone()),
                })
                .map_err(storage_error)?;
            let confirmation = transition(
                runtime,
                &updated,
                AgentHibernationState::ConfirmationRequired,
                "hibernate",
            )?;
            (
                confirmation,
                Some(AgentArtifactDescriptor {
                    descriptor_version: 1,
                    kind: checkpoint.kind,
                    digest_sha256: checkpoint.digest_sha256,
                    size_bytes: 16,
                    created_at_ms: u64::try_from(checkpoint.verified_at_ms)
                        .map_err(|_| invalid_params())?,
                    expires_at_ms: u64::try_from(checkpoint.expires_at_ms)
                        .map_err(|_| invalid_params())?,
                }),
            )
        }
    };
    let confirmation_id = Uuid::new_v4();
    let nonce = Uuid::new_v4().to_string();
    let expires_at_ms = now_ms().saturating_add(30_000);
    let challenge_record = AgentHibernationConfirmationCreate {
        confirmation_id,
        agent_session_id: id,
        session_revision: confirmation.revision,
        attempt_epoch: confirmation.attempt_epoch,
        choice: destructive_choice(params.challenge.choice).to_owned(),
        provider_id: uuid(&params.challenge.provider.provider_id)?,
        provider_epoch: params.challenge.provider.provider_epoch,
        provider_lease_id: uuid(&params.challenge.provider.lease_id)?,
        window_id: uuid(&params.challenge.window.window_id)?,
        window_generation: params.challenge.window.window_generation,
        nonce_hash: format!("{:x}", Sha256::digest(nonce.as_bytes())),
        expires_at_ms,
    };
    runtime
        .store
        .create_hibernation_confirmation(&challenge_record, now_ms())
        .map_err(storage_error)?;
    runtime
        .store
        .link_hibernation_confirmation_replay(
            uuid(&params.operation.idempotency_key)?,
            confirmation_id,
        )
        .map_err(storage_error)?;
    let mut challenge_nonces = runtime
        .challenge_nonces
        .lock()
        .map_err(|_| CommandError::new("internal_error", "The challenge could not be issued"))?;
    challenge_nonces
        .retain(|_, entry| entry.expires_at_ms > now_ms() && entry.agent_session_id != id);
    challenge_nonces.insert(
        confirmation_id,
        ChallengeNonce {
            nonce: nonce.clone(),
            expires_at_ms,
            agent_session_id: id,
        },
    );
    drop(challenge_nonces);
    finish_operation(
        runtime,
        "session.hibernatePreflight",
        &params.operation,
        "preflightComplete",
        now_ms(),
    )?;
    let challenge = AgentHibernationChallenge {
        confirmation_id: confirmation_id.to_string(),
        choice: params.challenge.choice,
        provider: params.challenge.provider,
        window: params.challenge.window,
        nonce,
        expires_at_ms: u64::try_from(expires_at_ms).map_err(|_| invalid_params())?,
    };
    encode(AgentHibernationPreflightResult {
        state: protocol_hibernation(
            confirmation
                .hibernation_state
                .unwrap_or(agent_workspace_storage::AgentHibernationStateRecord::Interrupted),
        ),
        confirmation_id: Some(confirmation_id.to_string()),
        challenge: Some(challenge),
        checkpoint,
    })
}

fn hibernation_cancel(
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: AgentHibernationCancelParams = parse(params)?;
    let id = uuid(&params.agent_session_id)?;
    let admission = begin_operation(runtime, "session.hibernateCancel", id, &params.operation)?;
    let session = runtime
        .store
        .load_agent_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_unavailable)?;
    match admission {
        OperationAdmission::Pending => return Err(operation_pending()),
        OperationAdmission::Replay(_) => {}
        OperationAdmission::Begun => {
            transition(runtime, &session, AgentHibernationState::Canceled, "none")?;
            runtime
                .challenge_nonces
                .lock()
                .map_err(|_| {
                    CommandError::new("internal_error", "The challenge could not be canceled")
                })?
                .retain(|_, entry| entry.agent_session_id != id);
            finish_operation(
                runtime,
                "session.hibernateCancel",
                &params.operation,
                "canceled",
                now_ms(),
            )?;
        }
    }
    encode(AgentHibernationMutationResult {
        state: AgentHibernationState::Canceled,
    })
}

#[allow(clippy::too_many_lines)]
async fn hibernation_confirm(
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: AgentHibernationConfirmParams = parse(params)?;
    let id = uuid(&params.agent_session_id)?;
    match begin_operation(runtime, "session.hibernateConfirm", id, &params.operation)? {
        OperationAdmission::Pending => return Err(operation_pending()),
        OperationAdmission::Replay(record) => {
            let state = match record.terminal_code.as_deref() {
                Some("hibernated") => AgentHibernationState::Hibernated,
                Some("terminatedAfterWarning") => AgentHibernationState::TerminatedAfterWarning,
                _ => {
                    return Err(CommandError::new(
                        "invalid_state",
                        "The prior confirmation did not complete successfully",
                    ));
                }
            };
            return encode(AgentHibernationMutationResult { state });
        }
        OperationAdmission::Begun => {}
    }
    let session = exact_session(runtime, id, &params.operation)?;
    if params.choice == AgentDestructiveChoice::LeaveRunning {
        finish_failed_operation(
            runtime,
            "session.hibernateConfirm",
            &params.operation,
            "choiceMismatch",
        )?;
        return Err(CommandError::new(
            "invalid_params",
            "Use agent.hibernate.cancel to leave the process running",
        ));
    }
    let now = u64::try_from(now_ms()).map_err(|_| invalid_params())?;
    if params.expires_at_ms < now || params.expires_at_ms > now.saturating_add(30_000) {
        finish_failed_operation(
            runtime,
            "session.hibernateConfirm",
            &params.operation,
            "challengeExpired",
        )?;
        return Err(CommandError::new(
            "invalid_state",
            "The hibernation challenge expired or exceeds its bounded lifetime",
        ));
    }
    let provider_valid = if let Some(multi_window) = runtime.multi_window.as_ref() {
        multi_window
            .action_provider_identity_valid(&params.provider, &params.window)
            .await
            .is_ok()
    } else {
        false
    };
    if !provider_valid {
        finish_failed_operation(
            runtime,
            "session.hibernateConfirm",
            &params.operation,
            "providerUnavailable",
        )?;
        return Err(provider_unavailable());
    }
    let challenge_record = AgentHibernationConfirmationCreate {
        confirmation_id: uuid(&params.confirmation_id)?,
        agent_session_id: id,
        session_revision: session.revision,
        attempt_epoch: session.attempt_epoch,
        choice: destructive_choice(params.choice).to_owned(),
        provider_id: uuid(&params.provider.provider_id)?,
        provider_epoch: params.provider.provider_epoch,
        provider_lease_id: uuid(&params.provider.lease_id)?,
        window_id: uuid(&params.window.window_id)?,
        window_generation: params.window.window_generation,
        nonce_hash: format!("{:x}", Sha256::digest(params.nonce.as_bytes())),
        expires_at_ms: i64::try_from(params.expires_at_ms).map_err(|_| invalid_params())?,
    };
    match runtime
        .store
        .consume_hibernation_confirmation(&challenge_record, now_ms())
        .map_err(storage_error)?
    {
        AgentHibernationConfirmationOutcome::Consumed => {}
        AgentHibernationConfirmationOutcome::Expired => {
            finish_failed_operation(
                runtime,
                "session.hibernateConfirm",
                &params.operation,
                "challengeExpired",
            )?;
            return Err(CommandError::new("invalid_state", "The challenge expired"));
        }
        AgentHibernationConfirmationOutcome::Conflict
        | AgentHibernationConfirmationOutcome::AlreadyConsumed => {
            finish_failed_operation(
                runtime,
                "session.hibernateConfirm",
                &params.operation,
                "challengeUnavailable",
            )?;
            return Err(CommandError::new(
                "invalid_state",
                "The challenge is unavailable or has already been consumed",
            ));
        }
    }
    runtime
        .challenge_nonces
        .lock()
        .map_err(|_| CommandError::new("internal_error", "The challenge could not be consumed"))?
        .remove(&challenge_record.confirmation_id);
    let has_fresh_checkpoint = session
        .checkpoint
        .as_ref()
        .is_some_and(|checkpoint| checkpoint.expires_at_ms > now_ms());
    let Some(terminal_id) = runtime.terminal_for_binding(&session.binding).await else {
        finish_failed_operation(
            runtime,
            "session.hibernateConfirm",
            &params.operation,
            "runtimeUnavailable",
        )?;
        return Err(CommandError::new(
            "runtime_unavailable",
            "The exact terminal binding is not live",
        ));
    };
    let pending = transition(
        runtime,
        &session,
        AgentHibernationState::ProcessDispositionPending,
        "hibernate",
    )?;
    let detached_result = runtime
        .workspace
        .detach_terminal(
            WorkspaceId::from_uuid(session.binding.workspace_id),
            TabId::from_uuid(session.binding.tab_id),
            agent_workspace_core::RuntimeSessionId::new(terminal_id),
            Timestamp(u64::try_from(now_ms()).map_err(|_| invalid_params())?),
        )
        .await;
    let Ok(detached) = detached_result else {
        finish_failed_operation(
            runtime,
            "session.hibernateConfirm",
            &params.operation,
            "detachFailed",
        )?;
        return Err(CommandError::new(
            "runtime_unavailable",
            "The exact terminal could not be durably detached",
        ));
    };
    if !detached.termination_failures.is_empty() {
        let _ = runtime.store.update_agent_session(&AgentSessionUpdate {
            agent_session_id: id,
            expected_revision: pending.revision,
            attempt_epoch: pending.attempt_epoch,
            lifecycle: AgentLifecycleRecord::Failed,
            durable_intent: "hibernateDispositionFailed".to_owned(),
            restore_level: AgentRestoreLevelRecord::ToolResume,
            restore_outcome: pending.restore_outcome,
            hibernation_state: Some(agent_workspace_storage::AgentHibernationStateRecord::Failed),
            evidence_epoch: pending.evidence_epoch,
            verified_at_ms: pending.last_verified_at_ms,
            checkpoint: pending.checkpoint.clone(),
        });
        finish_failed_operation(
            runtime,
            "session.hibernateConfirm",
            &params.operation,
            "dispositionUnverified",
        )?;
        return Err(CommandError::new(
            "runtime_unavailable",
            "The terminal binding was detached but process disposition was not verified",
        ));
    }
    let hibernated = if has_fresh_checkpoint {
        runtime.store.update_agent_session(&AgentSessionUpdate {
            agent_session_id: id,
            expected_revision: pending.revision,
            attempt_epoch: pending.attempt_epoch,
            lifecycle: AgentLifecycleRecord::Hibernated,
            durable_intent: "hibernate".to_owned(),
            restore_level: AgentRestoreLevelRecord::ToolResume,
            restore_outcome: pending.restore_outcome,
            hibernation_state: Some(
                agent_workspace_storage::AgentHibernationStateRecord::Hibernated,
            ),
            evidence_epoch: pending.evidence_epoch,
            verified_at_ms: now_ms().max(pending.last_verified_at_ms),
            checkpoint: pending.checkpoint,
        })
    } else {
        runtime.store.record_terminated_after_warning(
            id,
            pending.revision,
            pending.attempt_epoch,
            uuid(&params.confirmation_id)?,
            now_ms(),
        )
    }
    .map_err(storage_error)?;
    finish_operation(
        runtime,
        "session.hibernateConfirm",
        &params.operation,
        if has_fresh_checkpoint {
            "hibernated"
        } else {
            "terminatedAfterWarning"
        },
        now_ms(),
    )?;
    encode(AgentHibernationMutationResult {
        state: protocol_hibernation(hibernated.hibernation_state.unwrap()),
    })
}

fn attention_set(
    params: Value,
    runtime: &AgentSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: AgentAttentionSetParams = parse(params)?;
    let target = binding_record(&params.target.target)?;
    let session = exact_session(runtime, target.agent_session_id, &params.operation)?;
    if session.binding != target {
        return Err(CommandError::new(
            "invalid_state",
            "The attention target is not the session's exact durable binding",
        ));
    }
    let team_member = match (
        params.target.team_id.as_deref(),
        params.target.member_id.as_deref(),
    ) {
        (Some(team_id), Some(member_id)) => Some((uuid(team_id)?, uuid(member_id)?)),
        (None, None) => None,
        _ => return Err(invalid_params()),
    };
    let admission = begin_operation(
        runtime,
        "attention.set",
        target.agent_session_id,
        &params.operation,
    )?;
    match admission {
        OperationAdmission::Pending => return Err(operation_pending()),
        OperationAdmission::Replay(record) => {
            let terminal_code = record.terminal_code.as_deref().unwrap_or_default();
            if let Some(error) = attention_terminal_error(terminal_code) {
                return Err(error);
            }
            let revision = terminal_code
                .strip_prefix("attentionSet:")
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| {
                    CommandError::new("invalid_state", "The attention replay is unavailable")
                })?;
            return encode(AgentAttentionSetResult {
                target: params.target,
                state: params.state,
                revision,
            });
        }
        OperationAdmission::Begun => {}
    }
    let current = runtime
        .store
        .load_agent_catalog()
        .map_err(storage_error)?
        .attention
        .into_iter()
        .find(|record| record.target.agent_session_id == target.agent_session_id);
    if current.as_ref().map(|record| record.revision) != params.expected_attention_revision {
        finish_failed_operation(
            runtime,
            "attention.set",
            &params.operation,
            "staleAttentionRevision",
        )?;
        return Err(stale_revision());
    }
    let attention = match runtime.store.set_agent_attention(
        &target,
        team_member,
        storage_attention(params.state),
        params.expected_attention_revision,
        now_ms(),
    ) {
        Ok(record) => record,
        Err(error) => {
            let terminal_code = if matches!(error, StorageError::InvalidAgentCatalog { .. }) {
                "staleAttentionRevision"
            } else {
                "storageFailure"
            };
            finish_failed_operation(runtime, "attention.set", &params.operation, terminal_code)?;
            return Err(attention_terminal_error(terminal_code)
                .expect("closed attention failure terminal must map to an error"));
        }
    };
    finish_operation(
        runtime,
        "attention.set",
        &params.operation,
        &format!("attentionSet:{}", attention.revision),
        now_ms(),
    )?;
    encode(attention_snapshot(&attention))
}

fn transition(
    runtime: &AgentSessionControlRuntime,
    session: &AgentSessionRecord,
    state: AgentHibernationState,
    intent: &str,
) -> Result<AgentSessionRecord, CommandError> {
    runtime
        .store
        .update_agent_session(&AgentSessionUpdate {
            agent_session_id: session.binding.agent_session_id,
            expected_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
            lifecycle: session.lifecycle,
            durable_intent: intent.to_owned(),
            restore_level: session.restore_level,
            restore_outcome: session.restore_outcome,
            hibernation_state: Some(storage_hibernation(state)),
            evidence_epoch: session.evidence_epoch,
            verified_at_ms: session.last_verified_at_ms,
            checkpoint: session.checkpoint.clone(),
        })
        .map_err(storage_error)
}

fn exact_session(
    runtime: &AgentSessionControlRuntime,
    id: Uuid,
    operation: &AgentOperationIdentity,
) -> Result<AgentSessionRecord, CommandError> {
    let session = runtime
        .store
        .load_agent_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_unavailable)?;
    if session.revision != operation.session_revision
        || session.attempt_epoch != operation.attempt_epoch
    {
        return Err(stale_revision());
    }
    Ok(session)
}

#[derive(Clone)]
enum OperationAdmission {
    Begun,
    Pending,
    Replay(AgentOperationRecord),
}

fn begin_operation(
    runtime: &AgentSessionControlRuntime,
    namespace: &str,
    id: Uuid,
    operation: &AgentOperationIdentity,
) -> Result<OperationAdmission, CommandError> {
    match runtime
        .store
        .begin_agent_operation(&AgentOperationBegin {
            operation_id: uuid(&operation.idempotency_key)?,
            namespace: namespace.to_owned(),
            agent_session_id: id,
            session_revision: operation.session_revision,
            attempt_epoch: operation.attempt_epoch,
            request_hash: operation.request_hash.clone(),
            now_ms: now_ms(),
        })
        .map_err(storage_error)?
    {
        AgentOperationBeginOutcome::Begun(_) => Ok(OperationAdmission::Begun),
        AgentOperationBeginOutcome::Pending(_) => Ok(OperationAdmission::Pending),
        AgentOperationBeginOutcome::Replay(record) => Ok(OperationAdmission::Replay(record)),
        AgentOperationBeginOutcome::Conflict => Err(idempotency_conflict()),
    }
}

fn finish_operation(
    runtime: &AgentSessionControlRuntime,
    namespace: &str,
    operation: &AgentOperationIdentity,
    terminal_code: &str,
    at: i64,
) -> Result<(), CommandError> {
    runtime
        .store
        .finish_agent_operation(
            namespace,
            uuid(&operation.idempotency_key)?,
            &operation.request_hash,
            AgentOperationStateRecord::Succeeded,
            terminal_code,
            at,
        )
        .map_err(storage_error)?;
    Ok(())
}

fn finish_failed_operation(
    runtime: &AgentSessionControlRuntime,
    namespace: &str,
    operation: &AgentOperationIdentity,
    terminal_code: &str,
) -> Result<(), CommandError> {
    runtime
        .store
        .finish_agent_operation(
            namespace,
            uuid(&operation.idempotency_key)?,
            &operation.request_hash,
            AgentOperationStateRecord::Failed,
            terminal_code,
            now_ms(),
        )
        .map_err(storage_error)?;
    Ok(())
}

fn catalog_snapshot(
    runtime: &AgentSessionControlRuntime,
) -> Result<AgentCatalogListResult, CommandError> {
    let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
    Ok(AgentCatalogListResult {
        catalog_version: AGENT_SESSION_CATALOG_VERSION,
        revision: catalog.revision,
        sessions: catalog
            .sessions
            .iter()
            .map(|session| session_snapshot(&catalog, session))
            .collect(),
        teams: catalog
            .teams
            .iter()
            .map(|team| team_snapshot_from(&catalog, team))
            .collect(),
        attention: catalog.attention.iter().map(attention_snapshot).collect(),
    })
}

fn attention_snapshot(attention: &AgentAttentionRecord) -> AgentAttentionSetResult {
    AgentAttentionSetResult {
        target: AgentAttentionTarget {
            target: protocol_binding(&attention.target),
            team_id: attention.team_id.map(|id| id.to_string()),
            member_id: attention.member_id.map(|id| id.to_string()),
        },
        state: protocol_attention(attention.state),
        revision: attention.revision,
    }
}

fn attention_terminal_error(terminal_code: &str) -> Option<CommandError> {
    match terminal_code {
        "staleAttentionRevision" => Some(stale_revision()),
        "storageFailure" => Some(CommandError::new(
            "storage_failure",
            "The durable attention route could not be updated",
        )),
        _ => None,
    }
}

fn team_snapshot(
    runtime: &AgentSessionControlRuntime,
    team: &AgentTeamRecord,
) -> Result<AgentTeamSnapshot, CommandError> {
    let catalog = runtime.store.load_agent_catalog().map_err(storage_error)?;
    Ok(team_snapshot_from(&catalog, team))
}

fn team_snapshot_from(catalog: &AgentCatalogRecord, team: &AgentTeamRecord) -> AgentTeamSnapshot {
    AgentTeamSnapshot {
        team_id: team.team_id.to_string(),
        title: team.title.clone(),
        revision: team.revision,
        members: catalog
            .members
            .iter()
            .filter(|member| member.team_id == team.team_id)
            .map(member_snapshot)
            .collect(),
    }
}

fn member_snapshot(member: &AgentTeamMemberRecord) -> AgentTeamMemberSnapshot {
    AgentTeamMemberSnapshot {
        member_id: member.member_id.to_string(),
        role: member.role.clone(),
        target: protocol_binding(&member.target),
        parent_member_id: member.parent_member_id.map(|id| id.to_string()),
        revision: member.revision,
    }
}

fn session_snapshot(
    catalog: &AgentCatalogRecord,
    session: &AgentSessionRecord,
) -> AgentSessionSnapshot {
    let membership = catalog
        .members
        .iter()
        .find(|member| member.target.agent_session_id == session.binding.agent_session_id);
    AgentSessionSnapshot {
        catalog_version: AGENT_SESSION_CATALOG_VERSION,
        binding: protocol_binding(&session.binding),
        adapter_id: session.adapter_id.clone(),
        adapter_version: session.adapter_version.clone(),
        title: session.title.clone(),
        lifecycle: protocol_lifecycle(session.lifecycle),
        hibernation_state: session.hibernation_state.map(protocol_hibernation),
        restore: AgentRestoreAssessment {
            level: restore_level(session.restore_level),
            assessed_at_ms: u64::try_from(session.last_verified_at_ms).unwrap_or(0),
            evidence_epoch: session.evidence_epoch,
        },
        last_restore_outcome: session.restore_outcome.map(protocol_restore_outcome),
        revision: session.revision,
        attempt_epoch: session.attempt_epoch,
        last_verified_at_ms: u64::try_from(session.last_verified_at_ms).unwrap_or(0),
        team_id: membership.map(|member| member.team_id.to_string()),
        member_id: membership.map(|member| member.member_id.to_string()),
        forked_from: session
            .forked_from
            .as_ref()
            .map(|fork| AgentForkProvenance {
                provenance_version: 1,
                forked_from_agent_session_id: fork.source_agent_session_id.to_string(),
                artifact: AgentProvenanceArtifact {
                    version: fork.version,
                    kind: fork.kind.clone(),
                    digest_sha256: fork.digest_sha256.clone(),
                },
            }),
    }
}

fn applied<T>(outcome: AgentCatalogMutationOutcome<T>) -> Result<T, CommandError> {
    match outcome {
        AgentCatalogMutationOutcome::Applied(value)
        | AgentCatalogMutationOutcome::Replay(value) => Ok(value),
        AgentCatalogMutationOutcome::Conflict => Err(idempotency_conflict()),
        AgentCatalogMutationOutcome::StaleCatalog
        | AgentCatalogMutationOutcome::StaleTeam
        | AgentCatalogMutationOutcome::StaleMember => Err(stale_revision()),
        AgentCatalogMutationOutcome::ResourceLimit => Err(resource_limit()),
        AgentCatalogMutationOutcome::DependencyConflict => Err(CommandError::new(
            "invalid_state",
            "The mutation conflicts with a catalog dependency",
        )),
    }
}

fn catalog_mutation(
    value: &AgentCatalogMutationIdentity,
) -> Result<AgentCatalogMutationIdentityRecord, CommandError> {
    Ok(AgentCatalogMutationIdentityRecord {
        idempotency_key: uuid(&value.idempotency_key)?,
        request_hash: value.request_hash.clone(),
        expected_catalog_revision: value.expected_catalog_revision,
    })
}
fn team_mutation(
    value: &AgentTeamMutationIdentity,
) -> Result<AgentTeamMutationIdentityRecord, CommandError> {
    Ok(AgentTeamMutationIdentityRecord {
        idempotency_key: uuid(&value.idempotency_key)?,
        request_hash: value.request_hash.clone(),
        expected_catalog_revision: value.expected_catalog_revision,
        expected_team_revision: value.expected_team_revision,
    })
}
fn member_mutation(
    value: &agent_workspace_protocol::AgentTeamMemberMutationIdentity,
) -> Result<AgentTeamMemberMutationIdentityRecord, CommandError> {
    Ok(AgentTeamMemberMutationIdentityRecord {
        idempotency_key: uuid(&value.idempotency_key)?,
        request_hash: value.request_hash.clone(),
        expected_catalog_revision: value.expected_catalog_revision,
        expected_team_revision: value.expected_team_revision,
        expected_member_revision: value.expected_member_revision,
    })
}
fn binding_record(value: &AgentSessionBinding) -> Result<AgentSessionBindingRecord, CommandError> {
    Ok(AgentSessionBindingRecord {
        workspace_id: uuid(&value.workspace_id)?,
        pane_id: uuid(&value.pane_id)?,
        tab_id: uuid(&value.tab_id)?,
        agent_session_id: uuid(&value.agent_session_id)?,
    })
}
fn protocol_binding(value: &AgentSessionBindingRecord) -> AgentSessionBinding {
    AgentSessionBinding {
        workspace_id: value.workspace_id.to_string(),
        pane_id: value.pane_id.to_string(),
        tab_id: value.tab_id.to_string(),
        agent_session_id: value.agent_session_id.to_string(),
    }
}
fn operation_context(
    session: &AgentSessionRecord,
    value: &AgentOperationIdentity,
) -> Result<AdapterOperationContext, CommandError> {
    Ok(AdapterOperationContext {
        operation_id: uuid(&value.idempotency_key)?,
        request_hash_sha256: digest(&value.request_hash)?,
        agent_session_id: session.binding.agent_session_id,
        session_revision: value.session_revision,
        attempt_epoch: value.attempt_epoch,
    })
}
fn digest(value: &str) -> Result<[u8; 32], CommandError> {
    if value.len() != 64 {
        return Err(invalid_params());
    }
    let mut output = [0_u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = u8::from_str_radix(
            std::str::from_utf8(chunk).map_err(|_| invalid_params())?,
            16,
        )
        .map_err(|_| invalid_params())?;
    }
    Ok(output)
}

fn protocol_lifecycle(value: AgentLifecycleRecord) -> AgentSessionLifecycle {
    match value {
        AgentLifecycleRecord::Created => AgentSessionLifecycle::Created,
        AgentLifecycleRecord::Launching => AgentSessionLifecycle::Launching,
        AgentLifecycleRecord::Running => AgentSessionLifecycle::Running,
        AgentLifecycleRecord::Waiting => AgentSessionLifecycle::Waiting,
        AgentLifecycleRecord::Checkpointing => AgentSessionLifecycle::Checkpointing,
        AgentLifecycleRecord::Hibernated => AgentSessionLifecycle::Hibernated,
        AgentLifecycleRecord::Completed => AgentSessionLifecycle::Completed,
        AgentLifecycleRecord::Failed => AgentSessionLifecycle::Failed,
        AgentLifecycleRecord::Unavailable => AgentSessionLifecycle::Unavailable,
    }
}
fn restore_level(value: AgentRestoreLevelRecord) -> AgentRestoreLevel {
    match value {
        AgentRestoreLevelRecord::LiveReattach => AgentRestoreLevel::LiveReattach,
        AgentRestoreLevelRecord::ToolResume => AgentRestoreLevel::ToolResume,
        AgentRestoreLevelRecord::LayoutRestart => AgentRestoreLevel::LayoutRestart,
        AgentRestoreLevelRecord::Unavailable => AgentRestoreLevel::Unavailable,
    }
}
fn protocol_restore_outcome(value: AgentRestoreOutcomeRecord) -> AgentRestoreOutcome {
    match value {
        AgentRestoreOutcomeRecord::LiveReattached => AgentRestoreOutcome::LiveReattached,
        AgentRestoreOutcomeRecord::ResumeAttempting => AgentRestoreOutcome::ResumeAttempting,
        AgentRestoreOutcomeRecord::Resumed => AgentRestoreOutcome::Resumed,
        AgentRestoreOutcomeRecord::LayoutRestarted => AgentRestoreOutcome::LayoutRestarted,
        AgentRestoreOutcomeRecord::Unavailable => AgentRestoreOutcome::Unavailable,
    }
}
fn storage_hibernation(
    value: AgentHibernationState,
) -> agent_workspace_storage::AgentHibernationStateRecord {
    use agent_workspace_storage::AgentHibernationStateRecord as S;
    match value {
        AgentHibernationState::Requested => S::Requested,
        AgentHibernationState::Preflight => S::Preflight,
        AgentHibernationState::ConfirmationRequired => S::ConfirmationRequired,
        AgentHibernationState::Checkpointing => S::Checkpointing,
        AgentHibernationState::CheckpointVerified => S::CheckpointVerified,
        AgentHibernationState::ProcessDispositionPending => S::ProcessDispositionPending,
        AgentHibernationState::Hibernated => S::Hibernated,
        AgentHibernationState::TerminatedAfterWarning => S::TerminatedAfterWarning,
        AgentHibernationState::Canceled => S::Canceled,
        AgentHibernationState::Failed => S::Failed,
        AgentHibernationState::Interrupted => S::Interrupted,
    }
}
fn protocol_hibernation(
    value: agent_workspace_storage::AgentHibernationStateRecord,
) -> AgentHibernationState {
    use agent_workspace_storage::AgentHibernationStateRecord as S;
    match value {
        S::Requested => AgentHibernationState::Requested,
        S::Preflight => AgentHibernationState::Preflight,
        S::ConfirmationRequired => AgentHibernationState::ConfirmationRequired,
        S::Checkpointing => AgentHibernationState::Checkpointing,
        S::CheckpointVerified => AgentHibernationState::CheckpointVerified,
        S::ProcessDispositionPending => AgentHibernationState::ProcessDispositionPending,
        S::Hibernated => AgentHibernationState::Hibernated,
        S::TerminatedAfterWarning => AgentHibernationState::TerminatedAfterWarning,
        S::Canceled => AgentHibernationState::Canceled,
        S::Failed => AgentHibernationState::Failed,
        S::Interrupted => AgentHibernationState::Interrupted,
    }
}
fn destructive_choice(value: AgentDestructiveChoice) -> &'static str {
    match value {
        AgentDestructiveChoice::LeaveRunning => "leaveRunning",
        AgentDestructiveChoice::TerminateAfterWarning => "terminateAfterWarning",
    }
}
fn storage_attention(value: AgentAttentionState) -> AgentAttentionStateRecord {
    match value {
        AgentAttentionState::Informational => AgentAttentionStateRecord::Informational,
        AgentAttentionState::Completed => AgentAttentionStateRecord::Completed,
        AgentAttentionState::Waiting => AgentAttentionStateRecord::Waiting,
        AgentAttentionState::Urgent => AgentAttentionStateRecord::Urgent,
    }
}
fn protocol_attention(value: AgentAttentionStateRecord) -> AgentAttentionState {
    match value {
        AgentAttentionStateRecord::Informational => AgentAttentionState::Informational,
        AgentAttentionStateRecord::Completed => AgentAttentionState::Completed,
        AgentAttentionStateRecord::Waiting => AgentAttentionState::Waiting,
        AgentAttentionStateRecord::Urgent => AgentAttentionState::Urgent,
    }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, CommandError> {
    serde_json::from_value(value).map_err(|_| invalid_params())
}
fn encode<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value)
        .map_err(|_| CommandError::new("internal_error", "The result could not be encoded"))
}
fn uuid(value: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(value).map_err(|_| invalid_params())
}
fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}
fn invalid_params() -> CommandError {
    CommandError::new(
        "invalid_params",
        "The request parameters do not match the command contract",
    )
}
fn session_unavailable() -> CommandError {
    CommandError::new("session_unavailable", "The agent session is unavailable")
}

const fn provider_unavailable() -> CommandError {
    CommandError::new(
        "provider_unavailable",
        "No trusted adapter can verify the exact agent session",
    )
}
fn stale_revision() -> CommandError {
    CommandError::new(
        "stale_revision",
        "The exact catalog or session revision is stale",
    )
}
fn idempotency_conflict() -> CommandError {
    CommandError::new(
        "idempotency_conflict",
        "The idempotency key conflicts with another request",
    )
}
fn resource_limit() -> CommandError {
    CommandError::new(
        "resource_limit",
        "The bounded catalog resource limit was reached",
    )
}
fn operation_pending() -> CommandError {
    CommandError::new(
        "operation_pending",
        "The durable operation is pending and was not redispatched",
    )
}
fn storage_error(_: agent_workspace_storage::StorageError) -> CommandError {
    CommandError::new(
        "storage_failure",
        "The durable agent-session catalog could not be updated",
    )
}
#[allow(clippy::needless_pass_by_value)]
fn runtime_error(error: AgentRuntimeError) -> CommandError {
    match error {
        AgentRuntimeError::IdempotencyConflict => idempotency_conflict(),
        AgentRuntimeError::StaleSession => stale_revision(),
        AgentRuntimeError::RestoreUnavailable | AgentRuntimeError::Adapter(_) => CommandError::new(
            "provider_unavailable",
            "No trusted adapter can perform this operation",
        ),
        AgentRuntimeError::ForkConflict => {
            CommandError::new("invalid_state", "The fork identity or placement conflicts")
        }
        AgentRuntimeError::UncompensatedFork => CommandError::new(
            "invalid_state",
            "The external fork exists but compensation could not be verified",
        ),
        AgentRuntimeError::UnsafeCheckpoint | AgentRuntimeError::UnverifiedDisposition => {
            CommandError::new(
                "confirmation_required",
                "A fresh verified checkpoint or explicit confirmation is required",
            )
        }
        AgentRuntimeError::Storage(_) => CommandError::new(
            "storage_failure",
            "The durable operation could not be updated",
        ),
    }
}

#[cfg(target_os = "windows")]
fn host_platform() -> AdapterPlatform {
    AdapterPlatform::Windows
}
#[cfg(target_os = "macos")]
fn host_platform() -> AdapterPlatform {
    AdapterPlatform::MacOs
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn host_platform() -> AdapterPlatform {
    AdapterPlatform::Linux
}

#[cfg(test)]
mod tests {
    use agent_workspace_agent_adapter::{
        AdapterDescriptor, AdapterError, CheckpointOutcome, ForkOutcome, HibernateOutcome,
        LaunchOutcome, ResumeOutcome, TrustedAgentAdapter,
    };
    use agent_workspace_core::{ShortcutPlatform, Timestamp};
    use agent_workspace_runtime::{BootstrapConfig, TerminalManagerBackend};
    use agent_workspace_storage::{AgentOperationBegin, AgentOperationStateRecord};
    use agent_workspace_terminal_runtime::TerminalManager;
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    struct RegistrationAdapter {
        descriptor: AdapterDescriptor,
        compensation_fails: bool,
    }

    impl TrustedAgentAdapter for RegistrationAdapter {
        fn descriptor(&self) -> &AdapterDescriptor {
            &self.descriptor
        }
        fn launch(&self, _: AdapterRequest<'_>) -> Result<LaunchOutcome, AdapterError> {
            Err(AdapterError::Declined)
        }
        fn resume(&self, _: AdapterRequest<'_>) -> Result<ResumeOutcome, AdapterError> {
            Ok(ResumeOutcome::Resumed)
        }
        fn fork(&self, _: AdapterRequest<'_>) -> Result<ForkOutcome, AdapterError> {
            Err(AdapterError::Declined)
        }
        fn checkpoint(&self, _: AdapterRequest<'_>) -> Result<CheckpointOutcome, AdapterError> {
            Ok(CheckpointOutcome::ConfirmationRequired)
        }
        fn hibernate(&self, _: AdapterRequest<'_>) -> Result<HibernateOutcome, AdapterError> {
            Ok(HibernateOutcome::ProcessDispositionPending)
        }
        fn compensate_fork(&self, _: Uuid) -> Result<(), AdapterError> {
            if self.compensation_fails {
                Err(AdapterError::Unavailable)
            } else {
                Ok(())
            }
        }
    }

    async fn harness() -> (
        tempfile::TempDir,
        Arc<SqliteStateStore>,
        Arc<TerminalManagerBackend>,
        Arc<ProductionWorkspaceRuntime>,
        AgentSessionControlRuntime,
    ) {
        let directory = tempdir().unwrap();
        let store = Arc::new(
            SqliteStateStore::open(
                directory.path().join("agent-control.sqlite3"),
                ShortcutPlatform::NonMacOs,
            )
            .unwrap(),
        );
        let backend = Arc::new(TerminalManagerBackend::new(TerminalManager::new()));
        let workspace = Arc::new(
            ProductionWorkspaceRuntime::bootstrap(
                Arc::clone(&store),
                Arc::clone(&backend),
                BootstrapConfig::for_service(directory.path().to_path_buf(), Timestamp(1), 24, 80)
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        let mut runtime = AgentSessionControlRuntime::new(
            Arc::clone(&store),
            Arc::clone(&workspace),
            backend.terminal_io().clone(),
            None,
        )
        .unwrap();
        let mut adapters = TrustedAdapterRegistry::default();
        adapters
            .register(Arc::new(RegistrationAdapter {
                descriptor: AdapterDescriptor::new(
                    "unregistered.adapter",
                    "1",
                    vec![AdapterPlatform::Linux],
                    vec![AdapterCapability::Resume],
                    "test-v1",
                    64,
                )
                .unwrap(),
                compensation_fails: false,
            }))
            .unwrap();
        runtime.adapters = Arc::new(adapters);
        (directory, store, backend, workspace, runtime)
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn live_registration_assessment_replay_and_restart_reconciliation_are_truthful() {
        let (_directory, store, backend, workspace, runtime) = harness().await;
        let state = workspace.snapshot().await;
        let workspace_record = &state.workspaces[0];
        let pane_id = workspace_record.selected_pane_id;
        let tab_id = workspace_record.panes[&pane_id].selected_tab_id;
        let session_id = Uuid::new_v4();
        let register = json!({
            "catalogVersion": 1,
            "binding": { "workspaceId": workspace_record.id, "paneId": pane_id, "tabId": tab_id, "agentSessionId": session_id },
            "adapterId": "unregistered.adapter", "adapterVersion": "1", "title": "live session",
            "operation": { "idempotencyKey": Uuid::new_v4(), "requestHash": "a".repeat(64), "sessionRevision": 1, "attemptEpoch": 1 }
        });
        let first = dispatch_inner("agent.catalog.register", register.clone(), &runtime)
            .await
            .unwrap();
        assert_eq!(
            dispatch_inner("agent.catalog.register", register.clone(), &runtime)
                .await
                .unwrap(),
            first
        );
        let same_terminal_fork = json!({
            "sourceAgentSessionId": session_id,
            "destination": {
                "workspaceId": workspace_record.id,
                "paneId": pane_id,
                "tabId": tab_id
            },
            "title": "unsafe replacement",
            "operation": {
                "idempotencyKey": Uuid::new_v4(),
                "requestHash": "f".repeat(64),
                "sessionRevision": 1,
                "attemptEpoch": 1
            }
        });
        assert_eq!(
            dispatch_inner("agent.session.fork", same_terminal_fork, &runtime)
                .await
                .unwrap_err()
                .code,
            "invalid_params"
        );

        let assess = json!({
            "agentSessionId": session_id,
            "operation": { "idempotencyKey": Uuid::new_v4(), "requestHash": "b".repeat(64), "sessionRevision": 1, "attemptEpoch": 1 }
        });
        let assessed = dispatch_inner("agent.restore.assess", assess.clone(), &runtime)
            .await
            .unwrap();
        assert_eq!(assessed["assessment"]["level"], "liveReattach");
        assert_eq!(
            dispatch_inner("agent.restore.assess", assess, &runtime)
                .await
                .unwrap(),
            assessed
        );

        let current = store.load_agent_session(session_id).unwrap().unwrap();
        let pending_id = Uuid::new_v4();
        store
            .begin_agent_operation(&AgentOperationBegin {
                operation_id: pending_id,
                namespace: "session.restore".to_owned(),
                agent_session_id: session_id,
                session_revision: current.revision,
                attempt_epoch: current.attempt_epoch,
                request_hash: "c".repeat(64),
                now_ms: 10,
            })
            .unwrap();
        let retry_after_caller_loss = json!({
            "agentSessionId": session_id,
            "operation": {
                "idempotencyKey": pending_id,
                "requestHash": "c".repeat(64),
                "sessionRevision": current.revision,
                "attemptEpoch": current.attempt_epoch
            }
        });
        assert_eq!(
            dispatch_inner("agent.session.restore", retry_after_caller_loss, &runtime)
                .await
                .unwrap_err()
                .code,
            "operation_pending",
        );
        let restarted = AgentSessionControlRuntime::new(
            Arc::clone(&store),
            Arc::clone(&workspace),
            backend.terminal_io().clone(),
            None,
        )
        .unwrap();
        assert_eq!(
            store
                .load_agent_operation("session.restore", pending_id)
                .unwrap()
                .unwrap()
                .state,
            AgentOperationStateRecord::Interrupted,
        );
        workspace.shutdown().await.unwrap();
        let replay_after_exit = dispatch_inner("agent.catalog.register", register, &restarted)
            .await
            .unwrap();
        assert_eq!(
            replay_after_exit["session"]["binding"]["agentSessionId"],
            first["session"]["binding"]["agentSessionId"],
            "a durable registration replay must retain identity without requiring a live PTY",
        );
        let unavailable_restore = json!({
            "agentSessionId": session_id,
            "operation": {
                "idempotencyKey": Uuid::new_v4(),
                "requestHash": "8".repeat(64),
                "sessionRevision": current.revision,
                "attemptEpoch": current.attempt_epoch
            }
        });
        let first_failure = dispatch_inner(
            "agent.session.restore",
            unavailable_restore.clone(),
            &restarted,
        )
        .await
        .unwrap_err();
        let replay_failure =
            dispatch_inner("agent.session.restore", unavailable_restore, &restarted)
                .await
                .unwrap_err();
        assert_eq!(first_failure.code, "provider_unavailable");
        assert_eq!(replay_failure.code, first_failure.code);
        assert_eq!(replay_failure.message, first_failure.message);
    }

    #[tokio::test]
    async fn team_mutations_are_strict_cas_and_destructive_confirm_fails_closed() {
        let (_directory, _store, _backend, workspace, runtime) = harness().await;
        let team_id = Uuid::new_v4();
        let create = json!({
            "teamId": team_id, "title": "workers",
            "mutation": { "idempotencyKey": Uuid::new_v4(), "requestHash": "d".repeat(64), "expectedCatalogRevision": 0 }
        });
        let first = dispatch_inner("agent.team.create", create.clone(), &runtime)
            .await
            .unwrap();
        assert_eq!(
            dispatch_inner("agent.team.create", create, &runtime)
                .await
                .unwrap(),
            first
        );
        let stale = json!({
            "teamId": team_id, "title": "renamed",
            "mutation": { "idempotencyKey": Uuid::new_v4(), "requestHash": "e".repeat(64), "expectedCatalogRevision": 0, "expectedTeamRevision": 1 }
        });
        assert_eq!(
            dispatch_inner("agent.team.update", stale, &runtime)
                .await
                .unwrap_err()
                .code,
            "stale_revision"
        );
        assert_eq!(
            dispatch_inner(
                "agent.hibernate.confirm",
                json!({"unexpected": true}),
                &runtime
            )
            .await
            .unwrap_err()
            .code,
            "invalid_params"
        );
        workspace.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn hibernation_confirmation_replays_terminal_outcomes_before_side_effect_checks() {
        let (_directory, store, _backend, workspace, runtime) = harness().await;
        let state = workspace.snapshot().await;
        let workspace_record = &state.workspaces[0];
        let pane_id = workspace_record.selected_pane_id;
        let tab_id = workspace_record.panes[&pane_id].selected_tab_id;
        for (index, (terminal_code, expected_state)) in [
            ("hibernated", "hibernated"),
            ("terminatedAfterWarning", "terminatedAfterWarning"),
        ]
        .into_iter()
        .enumerate()
        {
            let session_id = Uuid::new_v4();
            let session = match store
                .create_agent_session(&agent_workspace_storage::AgentSessionCreate {
                    binding: AgentSessionBindingRecord {
                        workspace_id: workspace_record.id.as_uuid(),
                        pane_id: pane_id.as_uuid(),
                        tab_id: tab_id.as_uuid(),
                        agent_session_id: session_id,
                    },
                    adapter_id: "unregistered.adapter".to_owned(),
                    adapter_version: "1.0.0".to_owned(),
                    title: format!("replay {index}"),
                    operation_id: Uuid::new_v4(),
                    request_hash: "a".repeat(64),
                    attempt_epoch: 1,
                    now_ms: 1,
                    forked_from: None,
                })
                .unwrap()
            {
                AgentSessionCreateOutcome::Created(value) => value,
                other => panic!("unexpected create outcome: {other:?}"),
            };
            let operation_id = Uuid::new_v4();
            store
                .begin_agent_operation(&AgentOperationBegin {
                    operation_id,
                    namespace: "session.hibernateConfirm".to_owned(),
                    agent_session_id: session_id,
                    session_revision: session.revision,
                    attempt_epoch: session.attempt_epoch,
                    request_hash: "b".repeat(64),
                    now_ms: 2,
                })
                .unwrap();
            store
                .finish_agent_operation(
                    "session.hibernateConfirm",
                    operation_id,
                    &"b".repeat(64),
                    AgentOperationStateRecord::Succeeded,
                    terminal_code,
                    3,
                )
                .unwrap();
            let replay = dispatch_inner(
                "agent.hibernate.confirm",
                json!({
                    "agentSessionId": session_id,
                    "confirmationId": Uuid::new_v4(),
                    "choice": "terminateAfterWarning",
                    "provider": { "providerId": Uuid::new_v4(), "providerEpoch": 1, "leaseId": Uuid::new_v4() },
                    "window": { "windowId": Uuid::new_v4(), "windowGeneration": 1 },
                    "nonce": Uuid::new_v4(),
                    "expiresAtMs": 1,
                    "operation": { "idempotencyKey": operation_id, "requestHash": "b".repeat(64), "sessionRevision": session.revision, "attemptEpoch": session.attempt_epoch }
                }),
                &runtime,
            )
            .await
            .unwrap();
            assert_eq!(replay["state"], expected_state);
        }
        workspace.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn hibernation_cancel_keeps_the_exact_pty_live() {
        let (_directory, store, _backend, workspace, runtime) = harness().await;
        let before = workspace.snapshot().await;
        let workspace_record = &before.workspaces[0];
        let pane_id = workspace_record.selected_pane_id;
        let tab_id = workspace_record.panes[&pane_id].selected_tab_id;
        let runtime_id = workspace_record.tabs[&tab_id]
            .content
            .runtime_session_id()
            .cloned();
        let session_id = Uuid::new_v4();
        let mut session = match store
            .create_agent_session(&agent_workspace_storage::AgentSessionCreate {
                binding: AgentSessionBindingRecord {
                    workspace_id: workspace_record.id.as_uuid(),
                    pane_id: pane_id.as_uuid(),
                    tab_id: tab_id.as_uuid(),
                    agent_session_id: session_id,
                },
                adapter_id: "unregistered.adapter".to_owned(),
                adapter_version: "1.0.0".to_owned(),
                title: "cancel remains live".to_owned(),
                operation_id: Uuid::new_v4(),
                request_hash: "c".repeat(64),
                attempt_epoch: 1,
                now_ms: 1,
                forked_from: None,
            })
            .unwrap()
        {
            AgentSessionCreateOutcome::Created(value) => value,
            other => panic!("unexpected create outcome: {other:?}"),
        };
        for state in [
            agent_workspace_storage::AgentHibernationStateRecord::Requested,
            agent_workspace_storage::AgentHibernationStateRecord::Preflight,
            agent_workspace_storage::AgentHibernationStateRecord::ConfirmationRequired,
        ] {
            session = store
                .update_agent_session(&AgentSessionUpdate {
                    agent_session_id: session_id,
                    expected_revision: session.revision,
                    attempt_epoch: session.attempt_epoch,
                    lifecycle: session.lifecycle,
                    durable_intent: "hibernate".to_owned(),
                    restore_level: session.restore_level,
                    restore_outcome: session.restore_outcome,
                    hibernation_state: Some(state),
                    evidence_epoch: session.evidence_epoch,
                    verified_at_ms: session.last_verified_at_ms,
                    checkpoint: None,
                })
                .unwrap();
        }
        let result = dispatch_inner(
            "agent.hibernate.cancel",
            json!({
                "agentSessionId": session_id,
                "operation": { "idempotencyKey": Uuid::new_v4(), "requestHash": "d".repeat(64), "sessionRevision": session.revision, "attemptEpoch": session.attempt_epoch }
            }),
            &runtime,
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "canceled");
        assert_eq!(
            workspace.snapshot().await.workspaces[0].tabs[&tab_id]
                .content
                .runtime_session_id(),
            runtime_id.as_ref()
        );
        workspace.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn restart_cleanup_archives_the_exact_durable_fork_orphan() {
        let (_directory, store, _backend, workspace, _runtime) = harness().await;
        let state = workspace.snapshot().await;
        let workspace_record = &state.workspaces[0];
        let pane_id = workspace_record.selected_pane_id;
        let tab_id = workspace_record.panes[&pane_id].selected_tab_id;
        let source_id = Uuid::new_v4();
        let source = match store
            .create_agent_session(&agent_workspace_storage::AgentSessionCreate {
                binding: AgentSessionBindingRecord {
                    workspace_id: workspace_record.id.as_uuid(),
                    pane_id: pane_id.as_uuid(),
                    tab_id: tab_id.as_uuid(),
                    agent_session_id: source_id,
                },
                adapter_id: "cleanup.adapter".to_owned(),
                adapter_version: "1".to_owned(),
                title: "orphan source".to_owned(),
                operation_id: Uuid::new_v4(),
                request_hash: "e".repeat(64),
                attempt_epoch: 1,
                now_ms: 1,
                forked_from: None,
            })
            .unwrap()
        {
            AgentSessionCreateOutcome::Created(value) => value,
            other => panic!("unexpected create outcome: {other:?}"),
        };
        let destination = Uuid::new_v4();
        store
            .record_agent_fork_orphan(&agent_workspace_storage::AgentForkOrphanRecord {
                destination_agent_session_id: destination,
                source_agent_session_id: source_id,
                adapter_id: source.adapter_id,
                adapter_version: source.adapter_version,
                operation_id: Uuid::new_v4(),
                request_hash: "f".repeat(64),
                artifact_kind: "test-v1".to_owned(),
                artifact_version: 1,
                artifact_digest_sha256: "a".repeat(64),
                cleanup_state: "pending".to_owned(),
                cleanup_attempts: 0,
                created_at_ms: 2,
                updated_at_ms: 2,
            })
            .unwrap();
        let mut adapters = TrustedAdapterRegistry::default();
        adapters
            .register(Arc::new(RegistrationAdapter {
                descriptor: AdapterDescriptor::new(
                    "cleanup.adapter",
                    "1",
                    vec![AdapterPlatform::Linux],
                    vec![AdapterCapability::Fork],
                    "test-v1",
                    64,
                )
                .unwrap(),
                compensation_fails: true,
            }))
            .unwrap();
        cleanup_fork_orphans(&store, &adapters, AdapterPlatform::Linux, 3).unwrap();
        let retained = store.load_agent_fork_orphans().unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].destination_agent_session_id, destination);
        assert_eq!(retained[0].cleanup_state, "archiveFailed");
        let mut adapters = TrustedAdapterRegistry::default();
        adapters
            .register(Arc::new(RegistrationAdapter {
                descriptor: AdapterDescriptor::new(
                    "cleanup.adapter",
                    "1",
                    vec![AdapterPlatform::Linux],
                    vec![AdapterCapability::Fork],
                    "test-v1",
                    64,
                )
                .unwrap(),
                compensation_fails: false,
            }))
            .unwrap();
        cleanup_fork_orphans(&store, &adapters, AdapterPlatform::Linux, 4).unwrap();
        assert!(store.load_agent_fork_orphans().unwrap().is_empty());
        workspace.shutdown().await.unwrap();
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn attention_is_cas_fenced_replayed_retargeted_and_restart_durable() {
        let (_directory, store, backend, workspace, runtime) = harness().await;
        let state = workspace.snapshot().await;
        let workspace_record = &state.workspaces[0];
        let pane_id = workspace_record.selected_pane_id;
        let tab_id = workspace_record.panes[&pane_id].selected_tab_id;
        let first_session = Uuid::new_v4();
        let second_session = Uuid::new_v4();
        let binding = |agent_session_id: Uuid| {
            json!({
                "workspaceId": workspace_record.id,
                "paneId": pane_id,
                "tabId": tab_id,
                "agentSessionId": agent_session_id
            })
        };
        for (index, session_id) in [first_session, second_session].into_iter().enumerate() {
            dispatch_inner(
                "agent.catalog.register",
                json!({
                    "catalogVersion": 1,
                    "binding": binding(session_id),
                    "adapterId": "unregistered.adapter",
                    "adapterVersion": "1",
                    "title": format!("session {index}"),
                    "operation": {
                        "idempotencyKey": Uuid::new_v4(),
                        "requestHash": if index == 0 { "1".repeat(64) } else { "2".repeat(64) },
                        "sessionRevision": 1,
                        "attemptEpoch": 1
                    }
                }),
                &runtime,
            )
            .await
            .unwrap();
        }
        let team_id = Uuid::new_v4();
        let member_id = Uuid::new_v4();
        dispatch_inner(
            "agent.team.create",
            json!({
                "teamId": team_id,
                "title": "attention team",
                "mutation": {
                    "idempotencyKey": Uuid::new_v4(),
                    "requestHash": "3".repeat(64),
                    "expectedCatalogRevision": 2
                }
            }),
            &runtime,
        )
        .await
        .unwrap();
        dispatch_inner(
            "agent.team.member.create",
            json!({
                "teamId": team_id,
                "memberId": member_id,
                "role": "worker",
                "target": binding(first_session),
                "mutation": {
                    "idempotencyKey": Uuid::new_v4(),
                    "requestHash": "4".repeat(64),
                    "expectedCatalogRevision": 3,
                    "expectedTeamRevision": 1
                }
            }),
            &runtime,
        )
        .await
        .unwrap();
        let attention = json!({
            "target": {
                "target": binding(first_session),
                "teamId": team_id,
                "memberId": member_id
            },
            "state": "urgent",
            "expectedAttentionRevision": null,
            "operation": {
                "idempotencyKey": Uuid::new_v4(),
                "requestHash": "5".repeat(64),
                "sessionRevision": 1,
                "attemptEpoch": 1
            }
        });
        let first = dispatch_inner("agent.attention.set", attention.clone(), &runtime)
            .await
            .unwrap();
        assert_eq!(first["revision"], 1);
        assert_eq!(
            dispatch_inner("agent.attention.set", attention, &runtime)
                .await
                .unwrap(),
            first,
        );
        assert_eq!(
            dispatch_inner(
                "agent.attention.set",
                json!({
                    "target": { "target": binding(first_session), "teamId": team_id, "memberId": member_id },
                    "state": "waiting",
                    "expectedAttentionRevision": null,
                    "operation": {
                        "idempotencyKey": Uuid::new_v4(), "requestHash": "6".repeat(64),
                        "sessionRevision": 1, "attemptEpoch": 1
                    }
                }),
                &runtime,
            )
            .await
            .unwrap_err()
            .code,
            "stale_revision",
        );
        dispatch_inner(
            "agent.team.member.move",
            json!({
                "teamId": team_id,
                "memberId": member_id,
                "target": binding(second_session),
                "mutation": {
                    "idempotencyKey": Uuid::new_v4(), "requestHash": "7".repeat(64),
                    "expectedCatalogRevision": 5, "expectedTeamRevision": 2,
                    "expectedMemberRevision": 1
                }
            }),
            &runtime,
        )
        .await
        .unwrap();
        let restarted = AgentSessionControlRuntime::new(
            Arc::clone(&store),
            Arc::clone(&workspace),
            backend.terminal_io().clone(),
            None,
        )
        .unwrap();
        let catalog = catalog_snapshot(&restarted).unwrap();
        assert_eq!(catalog.attention.len(), 1);
        assert_eq!(catalog.attention[0].revision, 2);
        assert_eq!(
            catalog.attention[0].target.target.agent_session_id,
            second_session.to_string(),
        );
        assert_eq!(
            catalog.attention[0].target.team_id,
            Some(team_id.to_string())
        );
        assert_eq!(
            catalog.attention[0].target.member_id,
            Some(member_id.to_string()),
        );
        workspace.shutdown().await.unwrap();
    }

    #[test]
    fn attention_storage_failure_replay_keeps_the_first_stable_code() {
        let first = attention_terminal_error("storageFailure").unwrap();
        let replay = attention_terminal_error("storageFailure").unwrap();
        assert_eq!(first.code, "storage_failure");
        assert_eq!(replay.code, first.code);
        assert_eq!(replay.message, first.message);
    }
}

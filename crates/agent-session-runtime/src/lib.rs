//! Truthful orchestration decisions over the durable metadata catalog and trusted adapters.
//!
//! This crate owns no PTY or process handle. Callers must provide current, bounded runtime
//! evidence and persist intent before dispatching any returned adapter operation.

use std::collections::BTreeSet;

use agent_workspace_agent_adapter::{
    AdapterCapability, AdapterError, AdapterOperationContext, AdapterPlatform, AdapterRequest,
    ArtifactDescriptor, CheckpointOutcome, ForkOutcome, HibernateOutcome, LaunchOutcome,
    ResumeOutcome, TerminalLaunchPlan, TrustedAdapterRegistry,
};
use agent_workspace_storage::{
    AgentCheckpointRecord, AgentForkOrphanRecord, AgentHibernationStateRecord,
    AgentLifecycleRecord, AgentOperationBegin, AgentOperationBeginOutcome,
    AgentOperationStateRecord, AgentRestoreLevelRecord, AgentSessionCreateOutcome,
    AgentSessionRecord, SqliteStateStore, StorageError,
};
use thiserror::Error;
use uuid::Uuid;

/// Upper bound on the age of live runtime evidence accepted by restore assessment.
pub const LIVE_EVIDENCE_MAX_AGE_MS: i64 = 5_000;
/// Upper bound on the age of a newly verified checkpoint used for destructive disposition.
pub const CHECKPOINT_FRESHNESS_MS: i64 = 30_000;

/// Exact ephemeral proof that the owned runtime still corresponds to a durable session epoch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiveRuntimeEvidence {
    pub agent_session_id: Uuid,
    pub evidence_epoch: u64,
    pub observed_at_ms: i64,
}

/// Current inputs used to assess an honest restore level.
#[derive(Clone, Copy)]
pub struct RestoreAssessmentInputs<'a> {
    pub live: Option<LiveRuntimeEvidence>,
    pub resume_artifact: Option<&'a ArtifactDescriptor>,
    pub durable_layout_available: bool,
}

/// Result of hibernation preflight. Neither variant has terminated a process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HibernationPreflight {
    CheckpointVerified(AgentCheckpointRecord),
    ConfirmationRequired,
}

/// Durable restore dispatch result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreExecutionOutcome {
    /// An identical request is already nonterminal and was not redispatched.
    Pending,
    /// The exact first terminal result was replayed without adapter invocation.
    Replay { terminal_code: String },
    /// The adapter accepted the documented tool resume mechanism.
    ResumeAttempting,
    ResumePrepared {
        plan: TerminalLaunchPlan,
        session_revision: u64,
        attempt_epoch: u64,
    },
    /// The adapter verified tool resume for the exact fenced attempt.
    Resumed {
        session_revision: u64,
        attempt_epoch: u64,
    },
    /// A fresh process was launched from durable layout metadata.
    LayoutRestarted {
        session_revision: u64,
        attempt_epoch: u64,
        terminal_code: &'static str,
    },
}

/// Idempotent sanitized fork preparation and durable identity result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForkExecutionOutcome {
    Pending,
    Created {
        session: AgentSessionRecord,
        launch: Option<TerminalLaunchPlan>,
    },
    Replay(AgentSessionRecord),
    ResourceLimit,
}

/// Hibernation decision/runtime error.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("trusted adapter rejected orchestration: {0}")]
    Adapter(#[from] AdapterError),
    #[error("durable agent session metadata is stale or invalid")]
    StaleSession,
    #[error("checkpoint is stale, mismatched, or unverified")]
    UnsafeCheckpoint,
    #[error("adapter did not verify final process disposition")]
    UnverifiedDisposition,
    #[error("idempotency key conflicts with a different restore request")]
    IdempotencyConflict,
    #[error("no adapter-dispatchable restore level is currently available")]
    RestoreUnavailable,
    #[error("fork identity or placement conflicts with durable catalog state")]
    ForkConflict,
    #[error("fork exists externally but compensation could not be verified")]
    UncompensatedFork,
    #[error("durable catalog reconciliation failed: {0}")]
    Storage(#[from] StorageError),
}

/// Evaluates restore capability from current evidence without trusting a stored restore claim.
#[must_use]
pub fn assess_restore(
    registry: &TrustedAdapterRegistry,
    session: &AgentSessionRecord,
    platform: AdapterPlatform,
    now_ms: i64,
    inputs: RestoreAssessmentInputs<'_>,
) -> AgentRestoreLevelRecord {
    if valid_live_evidence(session, now_ms, inputs.live) {
        return AgentRestoreLevelRecord::LiveReattach;
    }
    if let Ok(now) = u64::try_from(now_ms)
        && registry
            .resolve(
                &session.adapter_id,
                &session.adapter_version,
                platform,
                AdapterCapability::Resume,
                inputs.resume_artifact,
                now,
            )
            .is_ok()
    {
        return AgentRestoreLevelRecord::ToolResume;
    }
    if inputs.durable_layout_available
        && u64::try_from(now_ms).is_ok_and(|now| {
            registry
                .resolve(
                    &session.adapter_id,
                    &session.adapter_version,
                    platform,
                    AdapterCapability::Launch,
                    None,
                    now,
                )
                .is_ok()
        })
    {
        AgentRestoreLevelRecord::LayoutRestart
    } else {
        AgentRestoreLevelRecord::Unavailable
    }
}

/// Persists restore intent, dispatches the exact adapter capability, and commits first terminal.
///
/// Live PTY attachment is intentionally outside this crate because it owns no terminal handle;
/// callers should use [`assess_restore`] and their terminal owner for `liveReattach`.
///
/// # Errors
/// Returns a typed error for stale identity, idempotency conflict, unavailable capability,
/// adapter rejection, or a durable storage failure.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn execute_adapter_restore(
    store: &SqliteStateStore,
    registry: &TrustedAdapterRegistry,
    session: &AgentSessionRecord,
    platform: AdapterPlatform,
    operation: &AdapterOperationContext,
    artifact: Option<&ArtifactDescriptor>,
    durable_layout_available: bool,
    now_ms: u64,
) -> Result<RestoreExecutionOutcome, RuntimeError> {
    operation.validate(session.revision, session.attempt_epoch)?;
    let request_hash = hex_digest(operation.request_hash_sha256);
    let now_i64 = i64::try_from(now_ms).map_err(|_| RuntimeError::StaleSession)?;
    let operation_begin = AgentOperationBegin {
        operation_id: operation.operation_id,
        namespace: "session.restore".to_owned(),
        agent_session_id: session.binding.agent_session_id,
        session_revision: session.revision,
        attempt_epoch: session.attempt_epoch,
        request_hash: request_hash.clone(),
        now_ms: now_i64,
    };
    let level = assess_restore(
        registry,
        session,
        platform,
        now_i64,
        RestoreAssessmentInputs {
            live: None,
            resume_artifact: artifact,
            durable_layout_available,
        },
    );
    let (begin, attempt_session) = if matches!(
        level,
        AgentRestoreLevelRecord::ToolResume | AgentRestoreLevelRecord::LayoutRestart
    ) {
        store.begin_agent_restore_attempt(&operation_begin)?
    } else {
        (
            store.begin_agent_operation(&operation_begin)?,
            session.clone(),
        )
    };
    match begin {
        AgentOperationBeginOutcome::Conflict => return Err(RuntimeError::IdempotencyConflict),
        AgentOperationBeginOutcome::Pending(_) => return Ok(RestoreExecutionOutcome::Pending),
        AgentOperationBeginOutcome::Replay(record) => {
            return Ok(RestoreExecutionOutcome::Replay {
                terminal_code: record.terminal_code.unwrap_or_else(|| "unknown".to_owned()),
            });
        }
        AgentOperationBeginOutcome::Begun(_) => {}
    }
    let attempt_context = AdapterOperationContext {
        operation_id: operation.operation_id,
        request_hash_sha256: operation.request_hash_sha256,
        agent_session_id: operation.agent_session_id,
        session_revision: attempt_session.revision,
        attempt_epoch: attempt_session.attempt_epoch,
    };
    let dispatched = match level {
        AgentRestoreLevelRecord::ToolResume => {
            let adapter = registry.resolve(
                &attempt_session.adapter_id,
                &attempt_session.adapter_version,
                platform,
                AdapterCapability::Resume,
                artifact,
                now_ms,
            )?;
            match adapter.resume(AdapterRequest {
                context: &attempt_context,
                platform,
                artifact,
                credential: None,
            }) {
                Ok(outcome) => outcome,
                Err(error) => {
                    store.finish_agent_operation(
                        "session.restore",
                        operation.operation_id,
                        &request_hash,
                        AgentOperationStateRecord::Failed,
                        "adapterRejected",
                        now_i64,
                    )?;
                    return Err(error.into());
                }
            }
        }
        AgentRestoreLevelRecord::LayoutRestart => {
            let adapter = registry.resolve(
                &attempt_session.adapter_id,
                &attempt_session.adapter_version,
                platform,
                AdapterCapability::Launch,
                None,
                now_ms,
            )?;
            let outcome = match adapter.launch(AdapterRequest {
                context: &attempt_context,
                platform,
                artifact: None,
                credential: None,
            }) {
                Ok(outcome) => outcome,
                Err(error) => {
                    store.finish_agent_operation(
                        "session.restore",
                        operation.operation_id,
                        &request_hash,
                        AgentOperationStateRecord::Failed,
                        "adapterRejected",
                        now_i64,
                    )?;
                    return Err(error.into());
                }
            };
            let terminal_code = match outcome {
                LaunchOutcome::Launched => "layoutRestarted",
                LaunchOutcome::AlreadyRunning => "layoutAlreadyRunning",
            };
            return Ok(RestoreExecutionOutcome::LayoutRestarted {
                session_revision: attempt_session.revision,
                attempt_epoch: attempt_session.attempt_epoch,
                terminal_code,
            });
        }
        AgentRestoreLevelRecord::LiveReattach | AgentRestoreLevelRecord::Unavailable => {
            store.finish_agent_operation(
                "session.restore",
                operation.operation_id,
                &request_hash,
                AgentOperationStateRecord::Failed,
                "restoreUnavailable",
                now_i64,
            )?;
            return Err(RuntimeError::RestoreUnavailable);
        }
    };
    if dispatched == ResumeOutcome::ResumeAttempting {
        return Ok(RestoreExecutionOutcome::ResumeAttempting);
    }
    if let ResumeOutcome::Prepared(plan) = dispatched {
        return Ok(RestoreExecutionOutcome::ResumePrepared {
            plan,
            session_revision: attempt_session.revision,
            attempt_epoch: attempt_session.attempt_epoch,
        });
    }
    Ok(RestoreExecutionOutcome::Resumed {
        session_revision: attempt_session.revision,
        attempt_epoch: attempt_session.attempt_epoch,
    })
}

/// Invokes exact trusted fork preparation, then atomically commits a fresh durable identity and
/// immutable digest/kind/version provenance. Artifact bytes never cross into storage.
///
/// # Errors
/// Returns a typed error for stale source identity, adapter rejection, idempotency conflict,
/// invalid placement, or durable storage failure.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)]
pub fn execute_fork(
    store: &SqliteStateStore,
    registry: &TrustedAdapterRegistry,
    source: &AgentSessionRecord,
    platform: AdapterPlatform,
    operation: &AdapterOperationContext,
    workspace_id: Uuid,
    pane_id: Uuid,
    tab_id: Uuid,
    title: String,
    now_ms: u64,
) -> Result<ForkExecutionOutcome, RuntimeError> {
    operation.validate(source.revision, source.attempt_epoch)?;
    let request_hash = hex_digest(operation.request_hash_sha256);
    let now_i64 = i64::try_from(now_ms).map_err(|_| RuntimeError::StaleSession)?;
    let begin = store.begin_agent_operation(&AgentOperationBegin {
        operation_id: operation.operation_id,
        namespace: "session.fork".to_owned(),
        agent_session_id: source.binding.agent_session_id,
        session_revision: source.revision,
        attempt_epoch: source.attempt_epoch,
        request_hash: request_hash.clone(),
        now_ms: now_i64,
    })?;
    match begin {
        AgentOperationBeginOutcome::Conflict => return Err(RuntimeError::IdempotencyConflict),
        AgentOperationBeginOutcome::Pending(_) => {
            return recover_committed_fork(store, source, operation, &request_hash, now_i64);
        }
        AgentOperationBeginOutcome::Replay(record) => {
            return match record.terminal_code.as_deref() {
                Some("forkCreated") => {
                    recover_committed_fork(store, source, operation, &request_hash, now_i64)
                }
                Some("resourceLimit") => Ok(ForkExecutionOutcome::ResourceLimit),
                Some("adapterUnavailable" | "adapterRejected") => Err(RuntimeError::Adapter(
                    AdapterError::UnsupportedAdapterVersion,
                )),
                Some("serviceRestart") => Err(RuntimeError::Adapter(AdapterError::Interrupted)),
                _ => Err(RuntimeError::ForkConflict),
            };
        }
        AgentOperationBeginOutcome::Begun(_) => {}
    }
    let adapter = match registry.resolve(
        &source.adapter_id,
        &source.adapter_version,
        platform,
        AdapterCapability::Fork,
        None,
        now_ms,
    ) {
        Ok(adapter) => adapter,
        Err(error) => {
            store.finish_agent_operation(
                "session.fork",
                operation.operation_id,
                &request_hash,
                AgentOperationStateRecord::Failed,
                "adapterUnavailable",
                now_i64,
            )?;
            return Err(error.into());
        }
    };
    let fork_result = adapter.fork(AdapterRequest {
        context: operation,
        platform,
        artifact: None,
        credential: None,
    });
    let prepared = match fork_result {
        Ok(outcome) => outcome,
        Err(error) => {
            store.finish_agent_operation(
                "session.fork",
                operation.operation_id,
                &request_hash,
                AgentOperationStateRecord::Failed,
                "adapterRejected",
                now_i64,
            )?;
            return Err(error.into());
        }
    };
    let (destination_id, artifact, launch) = match prepared {
        ForkOutcome::Prepared(artifact) => (Uuid::new_v4(), artifact, None),
        ForkOutcome::ThreadPrepared {
            destination_agent_session_id,
            artifact,
            launch,
        } => (destination_agent_session_id, artifact, Some(launch)),
    };
    let orphan = AgentForkOrphanRecord {
        destination_agent_session_id: destination_id,
        source_agent_session_id: source.binding.agent_session_id,
        adapter_id: source.adapter_id.clone(),
        adapter_version: source.adapter_version.clone(),
        operation_id: operation.operation_id,
        request_hash: request_hash.clone(),
        artifact_kind: artifact.kind().to_owned(),
        artifact_version: artifact.version(),
        artifact_digest_sha256: hex_digest(artifact.digest_sha256()),
        cleanup_state: "pending".to_owned(),
        cleanup_attempts: 0,
        created_at_ms: now_i64,
        updated_at_ms: now_i64,
    };
    if let Err(error) = store.persist_agent_fork_orphan_recovery(&orphan) {
        if adapter.compensate_fork(destination_id).is_err() {
            finish_fork(
                store,
                operation,
                &request_hash,
                "forkCompensationFailed",
                now_i64,
            )?;
            return Err(RuntimeError::UncompensatedFork);
        }
        finish_fork(store, operation, &request_hash, "forkCompensated", now_i64)?;
        return Err(RuntimeError::Storage(error));
    }
    if let Err(error) = store.record_agent_fork_orphan(&orphan) {
        if adapter.compensate_fork(destination_id).is_err() {
            finish_fork(
                store,
                operation,
                &request_hash,
                "forkCompensationFailed",
                now_i64,
            )?;
            return Err(RuntimeError::UncompensatedFork);
        }
        store.clear_agent_fork_orphan_recovery(destination_id)?;
        finish_fork(store, operation, &request_hash, "forkCompensated", now_i64)?;
        return Err(RuntimeError::Storage(error));
    }
    store.clear_agent_fork_orphan_recovery(destination_id)?;
    let result = store.fork_agent_session(
        source.binding.agent_session_id,
        destination_id,
        workspace_id,
        pane_id,
        tab_id,
        title,
        artifact.kind().to_owned(),
        artifact.version(),
        hex_digest(artifact.digest_sha256()),
        operation.operation_id,
        request_hash.clone(),
        operation.attempt_epoch,
        now_i64,
    );
    let result = match result {
        Ok(value) => value,
        Err(error) => {
            if adapter.compensate_fork(destination_id).is_err() {
                store.mark_agent_fork_orphan_archive_failed(destination_id, now_i64)?;
                finish_fork(
                    store,
                    operation,
                    &request_hash,
                    "forkCompensationFailed",
                    now_i64,
                )?;
                return Err(RuntimeError::UncompensatedFork);
            }
            store.clear_agent_fork_orphan(destination_id)?;
            finish_fork(store, operation, &request_hash, "forkCompensated", now_i64)?;
            return Err(RuntimeError::Storage(error));
        }
    };
    match result {
        AgentSessionCreateOutcome::Created(session) => {
            store.clear_agent_fork_orphan(destination_id)?;
            finish_fork(store, operation, &request_hash, "forkCreated", now_i64)?;
            Ok(ForkExecutionOutcome::Created { session, launch })
        }
        AgentSessionCreateOutcome::Replay(session) => {
            store.clear_agent_fork_orphan(destination_id)?;
            finish_fork(store, operation, &request_hash, "forkCreated", now_i64)?;
            Ok(ForkExecutionOutcome::Replay(session))
        }
        AgentSessionCreateOutcome::ResourceLimit => {
            if adapter.compensate_fork(destination_id).is_err() {
                store.mark_agent_fork_orphan_archive_failed(destination_id, now_i64)?;
                finish_fork(
                    store,
                    operation,
                    &request_hash,
                    "forkCompensationFailed",
                    now_i64,
                )?;
                return Err(RuntimeError::UncompensatedFork);
            }
            store.clear_agent_fork_orphan(destination_id)?;
            finish_fork(store, operation, &request_hash, "resourceLimit", now_i64)?;
            Ok(ForkExecutionOutcome::ResourceLimit)
        }
        AgentSessionCreateOutcome::Conflict => {
            if adapter.compensate_fork(destination_id).is_err() {
                store.mark_agent_fork_orphan_archive_failed(destination_id, now_i64)?;
                finish_fork(
                    store,
                    operation,
                    &request_hash,
                    "forkCompensationFailed",
                    now_i64,
                )?;
                return Err(RuntimeError::UncompensatedFork);
            }
            store.clear_agent_fork_orphan(destination_id)?;
            finish_fork(store, operation, &request_hash, "forkConflict", now_i64)?;
            Err(RuntimeError::ForkConflict)
        }
    }
}

fn recover_committed_fork(
    store: &SqliteStateStore,
    source: &AgentSessionRecord,
    operation: &AdapterOperationContext,
    request_hash: &str,
    now_ms: i64,
) -> Result<ForkExecutionOutcome, RuntimeError> {
    let Some(existing) = store.load_agent_operation("catalog.register", operation.operation_id)?
    else {
        return Ok(ForkExecutionOutcome::Pending);
    };
    if existing.request_hash != request_hash
        || existing.agent_session_id == source.binding.agent_session_id
    {
        return Err(RuntimeError::IdempotencyConflict);
    }
    let session = store
        .load_agent_session(existing.agent_session_id)?
        .ok_or(RuntimeError::ForkConflict)?;
    finish_fork(store, operation, request_hash, "forkCreated", now_ms)?;
    Ok(ForkExecutionOutcome::Replay(session))
}

fn finish_fork(
    store: &SqliteStateStore,
    operation: &AdapterOperationContext,
    request_hash: &str,
    terminal_code: &str,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    let state = if terminal_code == "forkCreated" {
        AgentOperationStateRecord::Succeeded
    } else {
        AgentOperationStateRecord::Failed
    };
    store.finish_agent_operation(
        "session.fork",
        operation.operation_id,
        request_hash,
        state,
        terminal_code,
        now_ms,
    )?;
    Ok(())
}

/// Requests a checkpoint from the exact trusted adapter without disposing of the process.
///
/// `ConfirmationRequired` is returned for unsupported/missing checkpoint capability or when the
/// adapter cannot produce fresh verified metadata. No call to `hibernate` occurs in this method.
///
/// # Errors
/// Returns a typed error for stale operation identity or an unexpected trusted-adapter failure.
pub fn hibernation_preflight(
    registry: &TrustedAdapterRegistry,
    session: &AgentSessionRecord,
    platform: AdapterPlatform,
    operation: &AdapterOperationContext,
    now_ms: u64,
) -> Result<HibernationPreflight, RuntimeError> {
    operation
        .validate(session.revision, session.attempt_epoch)
        .map_err(RuntimeError::Adapter)?;
    let adapter = match registry.resolve(
        &session.adapter_id,
        &session.adapter_version,
        platform,
        AdapterCapability::Checkpoint,
        None,
        now_ms,
    ) {
        Ok(adapter) => adapter,
        Err(
            AdapterError::UnsupportedAdapterVersion
            | AdapterError::UnsupportedPlatform
            | AdapterError::UnsupportedCapability,
        ) => {
            return Ok(HibernationPreflight::ConfirmationRequired);
        }
        Err(error) => return Err(error.into()),
    };
    let outcome = adapter.checkpoint(AdapterRequest {
        context: operation,
        platform,
        artifact: None,
        credential: None,
    })?;
    match outcome {
        CheckpointOutcome::ConfirmationRequired => Ok(HibernationPreflight::ConfirmationRequired),
        CheckpointOutcome::Verified(artifact) => {
            if artifact.created_at_ms() > now_ms
                || artifact.expires_at_ms() <= now_ms
                || now_ms.saturating_sub(artifact.created_at_ms()) > CHECKPOINT_FRESHNESS_MS as u64
            {
                return Ok(HibernationPreflight::ConfirmationRequired);
            }
            registry.resolve(
                &session.adapter_id,
                &session.adapter_version,
                platform,
                AdapterCapability::Hibernate,
                Some(&artifact),
                now_ms,
            )?;
            Ok(HibernationPreflight::CheckpointVerified(
                AgentCheckpointRecord {
                    kind: artifact.kind().to_owned(),
                    version: artifact.version(),
                    digest_sha256: hex_digest(artifact.digest_sha256()),
                    verified_at_ms: i64::try_from(now_ms)
                        .map_err(|_| RuntimeError::UnsafeCheckpoint)?,
                    expires_at_ms: i64::try_from(artifact.expires_at_ms())
                        .map_err(|_| RuntimeError::UnsafeCheckpoint)?,
                },
            ))
        }
    }
}

/// Performs process disposition only after matching a fresh adapter artifact to persisted
/// checkpoint metadata. The caller must have durably entered `processDispositionPending` first.
///
/// # Errors
/// Returns a typed error before disposition for any stale state, revision, adapter, or checkpoint;
/// it also rejects an adapter outcome that does not verify final disposition.
pub fn dispatch_verified_hibernation(
    registry: &TrustedAdapterRegistry,
    session: &AgentSessionRecord,
    platform: AdapterPlatform,
    operation: &AdapterOperationContext,
    artifact: &ArtifactDescriptor,
    now_ms: u64,
) -> Result<(), RuntimeError> {
    if session.lifecycle != AgentLifecycleRecord::Checkpointing
        || session.hibernation_state != Some(AgentHibernationStateRecord::ProcessDispositionPending)
    {
        return Err(RuntimeError::UnsafeCheckpoint);
    }
    operation.validate(session.revision, session.attempt_epoch)?;
    let checkpoint = session
        .checkpoint
        .as_ref()
        .ok_or(RuntimeError::UnsafeCheckpoint)?;
    let now_i64 = i64::try_from(now_ms).map_err(|_| RuntimeError::UnsafeCheckpoint)?;
    if checkpoint.kind != artifact.kind()
        || checkpoint.version != artifact.version()
        || checkpoint.digest_sha256 != hex_digest(artifact.digest_sha256())
        || checkpoint.expires_at_ms <= now_i64
        || now_i64.saturating_sub(checkpoint.verified_at_ms) > CHECKPOINT_FRESHNESS_MS
    {
        return Err(RuntimeError::UnsafeCheckpoint);
    }
    let adapter = registry.resolve(
        &session.adapter_id,
        &session.adapter_version,
        platform,
        AdapterCapability::Hibernate,
        Some(artifact),
        now_ms,
    )?;
    match adapter.hibernate(AdapterRequest {
        context: operation,
        platform,
        artifact: Some(artifact),
        credential: None,
    })? {
        HibernateOutcome::Hibernated => Ok(()),
        HibernateOutcome::ProcessDispositionPending => Err(RuntimeError::UnverifiedDisposition),
    }
}

/// Applies conservative restart reconciliation. Until an adapter-specific proof source is wired,
/// no recovered operation epoch is trusted and every nonterminal operation becomes interrupted.
///
/// # Errors
/// Returns a storage error when reconciliation cannot commit atomically.
pub fn reconcile_after_restart(
    store: &SqliteStateStore,
    now_ms: i64,
) -> Result<usize, RuntimeError> {
    let interrupted = store.reconcile_agent_operations(&BTreeSet::new(), now_ms)?;
    let invalidated = store.invalidate_pending_hibernation_confirmations(now_ms)?;
    Ok(interrupted.saturating_add(invalidated))
}

fn valid_live_evidence(
    session: &AgentSessionRecord,
    now_ms: i64,
    evidence: Option<LiveRuntimeEvidence>,
) -> bool {
    evidence.is_some_and(|value| {
        value.agent_session_id == session.binding.agent_session_id
            && value.evidence_epoch == session.evidence_epoch
            && value.observed_at_ms <= now_ms
            && now_ms.saturating_sub(value.observed_at_ms) <= LIVE_EVIDENCE_MAX_AGE_MS
    })
}

fn hex_digest(bytes: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use agent_workspace_agent_adapter::{
        AdapterDescriptor, ForkOutcome, LaunchOutcome, ResumeOutcome, TrustedAgentAdapter,
    };
    use agent_workspace_core::ShortcutPlatform;
    use agent_workspace_storage::{
        AgentSessionBindingRecord, AgentSessionCreate, AgentSessionCreateOutcome,
    };
    use tempfile::tempdir;

    use super::*;

    struct Adapter {
        descriptor: AdapterDescriptor,
        hibernations: AtomicUsize,
        resumes: AtomicUsize,
        forks: AtomicUsize,
        resume_attempting: AtomicBool,
    }

    impl Adapter {
        fn new() -> Self {
            Self {
                descriptor: AdapterDescriptor::new(
                    "test.adapter",
                    "1",
                    vec![AdapterPlatform::Linux],
                    vec![
                        AdapterCapability::Launch,
                        AdapterCapability::Resume,
                        AdapterCapability::Fork,
                        AdapterCapability::Checkpoint,
                        AdapterCapability::Hibernate,
                    ],
                    "checkpoint-v1",
                    1024,
                )
                .unwrap(),
                hibernations: AtomicUsize::new(0),
                resumes: AtomicUsize::new(0),
                forks: AtomicUsize::new(0),
                resume_attempting: AtomicBool::new(false),
            }
        }

        fn artifact(&self) -> ArtifactDescriptor {
            ArtifactDescriptor::new(
                &self.descriptor,
                "checkpoint-v1",
                1,
                [7; 32],
                64,
                100,
                1_000,
            )
            .unwrap()
        }
    }

    impl TrustedAgentAdapter for Adapter {
        fn descriptor(&self) -> &AdapterDescriptor {
            &self.descriptor
        }
        fn launch(&self, _request: AdapterRequest<'_>) -> Result<LaunchOutcome, AdapterError> {
            Ok(LaunchOutcome::Launched)
        }
        fn resume(&self, _request: AdapterRequest<'_>) -> Result<ResumeOutcome, AdapterError> {
            self.resumes.fetch_add(1, Ordering::SeqCst);
            Ok(if self.resume_attempting.load(Ordering::SeqCst) {
                ResumeOutcome::ResumeAttempting
            } else {
                ResumeOutcome::Resumed
            })
        }
        fn fork(&self, _request: AdapterRequest<'_>) -> Result<ForkOutcome, AdapterError> {
            self.forks.fetch_add(1, Ordering::SeqCst);
            Ok(ForkOutcome::Prepared(self.artifact()))
        }
        fn checkpoint(
            &self,
            _request: AdapterRequest<'_>,
        ) -> Result<CheckpointOutcome, AdapterError> {
            Ok(CheckpointOutcome::Verified(self.artifact()))
        }
        fn hibernate(
            &self,
            _request: AdapterRequest<'_>,
        ) -> Result<HibernateOutcome, AdapterError> {
            self.hibernations.fetch_add(1, Ordering::SeqCst);
            Ok(HibernateOutcome::Hibernated)
        }
    }

    fn session() -> AgentSessionRecord {
        AgentSessionRecord {
            binding: AgentSessionBindingRecord {
                workspace_id: Uuid::from_u128(1),
                pane_id: Uuid::from_u128(2),
                tab_id: Uuid::from_u128(3),
                agent_session_id: Uuid::from_u128(4),
            },
            adapter_id: "test.adapter".to_owned(),
            adapter_version: "1".to_owned(),
            title: "test".to_owned(),
            lifecycle: AgentLifecycleRecord::Running,
            durable_intent: "none".to_owned(),
            restore_level: AgentRestoreLevelRecord::Unavailable,
            restore_outcome: None,
            hibernation_state: None,
            revision: 3,
            attempt_epoch: 2,
            evidence_epoch: 7,
            last_verified_at_ms: 100,
            forked_from: None,
            checkpoint: None,
            created_at_ms: 1,
            updated_at_ms: 100,
        }
    }

    fn operation(session: &AgentSessionRecord) -> AdapterOperationContext {
        AdapterOperationContext {
            operation_id: Uuid::from_u128(10),
            request_hash_sha256: [9; 32],
            agent_session_id: session.binding.agent_session_id,
            session_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
        }
    }

    fn durable_session(store: &SqliteStateStore) -> AgentSessionRecord {
        let template = session();
        match store
            .create_agent_session(&AgentSessionCreate {
                binding: template.binding,
                adapter_id: template.adapter_id,
                adapter_version: template.adapter_version,
                title: template.title,
                operation_id: Uuid::from_u128(20),
                request_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_owned(),
                attempt_epoch: 1,
                now_ms: 1,
                forked_from: None,
            })
            .unwrap()
        {
            AgentSessionCreateOutcome::Created(session) => session,
            other => panic!("unexpected session create outcome: {other:?}"),
        }
    }

    #[test]
    fn restore_taxonomy_requires_current_exact_evidence() {
        let mut registry = TrustedAdapterRegistry::default();
        let adapter = Arc::new(Adapter::new());
        registry.register(adapter.clone()).unwrap();
        let session = session();
        let artifact = adapter.artifact();
        assert_eq!(
            assess_restore(
                &registry,
                &session,
                AdapterPlatform::Linux,
                110,
                RestoreAssessmentInputs {
                    live: Some(LiveRuntimeEvidence {
                        agent_session_id: session.binding.agent_session_id,
                        evidence_epoch: 7,
                        observed_at_ms: 109,
                    }),
                    resume_artifact: Some(&artifact),
                    durable_layout_available: true,
                },
            ),
            AgentRestoreLevelRecord::LiveReattach
        );
        assert_eq!(
            assess_restore(
                &registry,
                &session,
                AdapterPlatform::Linux,
                120,
                RestoreAssessmentInputs {
                    live: Some(LiveRuntimeEvidence {
                        agent_session_id: Uuid::from_u128(99),
                        evidence_epoch: 7,
                        observed_at_ms: 119,
                    }),
                    resume_artifact: Some(&artifact),
                    durable_layout_available: true,
                },
            ),
            AgentRestoreLevelRecord::ToolResume
        );
        assert_eq!(
            assess_restore(
                &registry,
                &session,
                AdapterPlatform::Linux,
                1_000,
                RestoreAssessmentInputs {
                    live: None,
                    resume_artifact: Some(&artifact),
                    durable_layout_available: true,
                },
            ),
            AgentRestoreLevelRecord::LayoutRestart
        );
    }

    #[test]
    fn preflight_never_disposes_and_dispatch_requires_persisted_fresh_checkpoint() {
        let mut registry = TrustedAdapterRegistry::default();
        let adapter = Arc::new(Adapter::new());
        registry.register(adapter.clone()).unwrap();
        let mut session = session();
        let operation = operation(&session);
        let preflight =
            hibernation_preflight(&registry, &session, AdapterPlatform::Linux, &operation, 110)
                .unwrap();
        assert_eq!(adapter.hibernations.load(Ordering::SeqCst), 0);
        let HibernationPreflight::CheckpointVerified(checkpoint) = preflight else {
            panic!("expected verified checkpoint");
        };
        let artifact = adapter.artifact();
        assert_eq!(
            dispatch_verified_hibernation(
                &registry,
                &session,
                AdapterPlatform::Linux,
                &operation,
                &artifact,
                111,
            )
            .unwrap_err()
            .to_string(),
            RuntimeError::UnsafeCheckpoint.to_string()
        );
        assert_eq!(adapter.hibernations.load(Ordering::SeqCst), 0);
        session.checkpoint = Some(checkpoint);
        assert_eq!(
            dispatch_verified_hibernation(
                &registry,
                &session,
                AdapterPlatform::Linux,
                &operation,
                &artifact,
                111,
            )
            .unwrap_err()
            .to_string(),
            RuntimeError::UnsafeCheckpoint.to_string()
        );
        assert_eq!(adapter.hibernations.load(Ordering::SeqCst), 0);
        session.lifecycle = AgentLifecycleRecord::Checkpointing;
        session.hibernation_state = Some(AgentHibernationStateRecord::ProcessDispositionPending);
        dispatch_verified_hibernation(
            &registry,
            &session,
            AdapterPlatform::Linux,
            &operation,
            &artifact,
            111,
        )
        .unwrap();
        assert_eq!(adapter.hibernations.load(Ordering::SeqCst), 1);
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn adapter_restore_and_fork_are_idempotent_without_redispatch() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("runtime.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let source = durable_session(&store);
        let mut registry = TrustedAdapterRegistry::default();
        let adapter = Arc::new(Adapter::new());
        registry.register(adapter.clone()).unwrap();

        let restore_operation = AdapterOperationContext {
            operation_id: Uuid::from_u128(30),
            request_hash_sha256: [3; 32],
            agent_session_id: source.binding.agent_session_id,
            session_revision: source.revision,
            attempt_epoch: source.attempt_epoch,
        };
        let artifact = adapter.artifact();
        let dispatched = execute_adapter_restore(
            &store,
            &registry,
            &source,
            AdapterPlatform::Linux,
            &restore_operation,
            Some(&artifact),
            true,
            110,
        )
        .unwrap();
        let RestoreExecutionOutcome::Resumed {
            session_revision,
            attempt_epoch,
        } = dispatched
        else {
            panic!("expected verified resume");
        };
        assert!(matches!(
            execute_adapter_restore(
                &store,
                &registry,
                &source,
                AdapterPlatform::Linux,
                &restore_operation,
                Some(&artifact),
                true,
                111,
            )
            .unwrap(),
            RestoreExecutionOutcome::Pending
        ));
        assert_eq!(adapter.resumes.load(Ordering::SeqCst), 1);

        store
            .finish_agent_restore_success(
                restore_operation.operation_id,
                &hex_digest(restore_operation.request_hash_sha256),
                restore_operation.agent_session_id,
                session_revision,
                attempt_epoch,
                agent_workspace_storage::AgentRestoreOutcomeRecord::Resumed,
                "resumed",
                112,
            )
            .unwrap();
        assert!(matches!(
            execute_adapter_restore(
                &store,
                &registry,
                &source,
                AdapterPlatform::Linux,
                &restore_operation,
                Some(&artifact),
                true,
                113,
            )
            .unwrap(),
            RestoreExecutionOutcome::Replay { .. }
        ));

        let source = store
            .load_agent_session(source.binding.agent_session_id)
            .unwrap()
            .unwrap();
        assert!(
            restore_operation
                .validate(source.revision, source.attempt_epoch)
                .is_err()
        );

        let fork_operation = AdapterOperationContext {
            operation_id: Uuid::from_u128(40),
            request_hash_sha256: [4; 32],
            agent_session_id: source.binding.agent_session_id,
            session_revision: source.revision,
            attempt_epoch: source.attempt_epoch,
        };
        let created = execute_fork(
            &store,
            &registry,
            &source,
            AdapterPlatform::Linux,
            &fork_operation,
            Uuid::from_u128(41),
            Uuid::from_u128(42),
            Uuid::from_u128(43),
            "fork".to_owned(),
            120,
        )
        .unwrap();
        let ForkExecutionOutcome::Created {
            session: created, ..
        } = created
        else {
            panic!("expected created fork");
        };
        assert_ne!(
            created.binding.agent_session_id,
            source.binding.agent_session_id
        );
        let replay = execute_fork(
            &store,
            &registry,
            &source,
            AdapterPlatform::Linux,
            &fork_operation,
            Uuid::from_u128(41),
            Uuid::from_u128(42),
            Uuid::from_u128(43),
            "fork".to_owned(),
            121,
        )
        .unwrap();
        let ForkExecutionOutcome::Replay(replay) = replay else {
            panic!("expected replayed fork");
        };
        assert_eq!(
            replay.binding.agent_session_id,
            created.binding.agent_session_id
        );
        assert_eq!(adapter.forks.load(Ordering::SeqCst), 1);

        let pending_fork = AdapterOperationContext {
            operation_id: Uuid::from_u128(50),
            request_hash_sha256: [5; 32],
            agent_session_id: source.binding.agent_session_id,
            session_revision: source.revision,
            attempt_epoch: source.attempt_epoch,
        };
        store
            .begin_agent_operation(&AgentOperationBegin {
                operation_id: pending_fork.operation_id,
                namespace: "session.fork".to_owned(),
                agent_session_id: source.binding.agent_session_id,
                session_revision: source.revision,
                attempt_epoch: source.attempt_epoch,
                request_hash: hex_digest(pending_fork.request_hash_sha256),
                now_ms: 130,
            })
            .unwrap();
        assert_eq!(
            execute_fork(
                &store,
                &registry,
                &source,
                AdapterPlatform::Linux,
                &pending_fork,
                Uuid::from_u128(51),
                Uuid::from_u128(52),
                Uuid::from_u128(53),
                "pending fork".to_owned(),
                131,
            )
            .unwrap(),
            ForkExecutionOutcome::Pending
        );
        assert_eq!(adapter.forks.load(Ordering::SeqCst), 1);

        adapter.resume_attempting.store(true, Ordering::SeqCst);
        let source = store
            .load_agent_session(source.binding.agent_session_id)
            .unwrap()
            .unwrap();
        let attempting_restore = AdapterOperationContext {
            operation_id: Uuid::from_u128(60),
            request_hash_sha256: [6; 32],
            agent_session_id: source.binding.agent_session_id,
            session_revision: source.revision,
            attempt_epoch: source.attempt_epoch,
        };
        assert_eq!(
            execute_adapter_restore(
                &store,
                &registry,
                &source,
                AdapterPlatform::Linux,
                &attempting_restore,
                Some(&artifact),
                true,
                140,
            )
            .unwrap(),
            RestoreExecutionOutcome::ResumeAttempting
        );
        let resume_count = adapter.resumes.load(Ordering::SeqCst);
        assert_eq!(
            execute_adapter_restore(
                &store,
                &registry,
                &source,
                AdapterPlatform::Linux,
                &attempting_restore,
                Some(&artifact),
                true,
                141,
            )
            .unwrap(),
            RestoreExecutionOutcome::Pending
        );
        assert_eq!(adapter.resumes.load(Ordering::SeqCst), resume_count);

        let source = store
            .load_agent_session(source.binding.agent_session_id)
            .unwrap()
            .unwrap();
        let unavailable_operation = AdapterOperationContext {
            operation_id: Uuid::from_u128(70),
            request_hash_sha256: [7; 32],
            agent_session_id: source.binding.agent_session_id,
            session_revision: source.revision,
            attempt_epoch: source.attempt_epoch,
        };
        let unavailable_registry = TrustedAdapterRegistry::default();
        for now_ms in [150, 151] {
            assert!(matches!(
                execute_fork(
                    &store,
                    &unavailable_registry,
                    &source,
                    AdapterPlatform::Linux,
                    &unavailable_operation,
                    Uuid::from_u128(71),
                    Uuid::from_u128(72),
                    Uuid::from_u128(73),
                    "unavailable fork".to_owned(),
                    now_ms,
                ),
                Err(RuntimeError::Adapter(
                    AdapterError::UnsupportedAdapterVersion
                ))
            ));
        }
        let terminal = store
            .load_agent_operation("session.fork", unavailable_operation.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, AgentOperationStateRecord::Failed);
        assert_eq!(
            terminal.terminal_code.as_deref(),
            Some("adapterUnavailable")
        );
    }

    #[test]
    fn failed_primary_orphan_write_and_archive_remain_restart_recoverable() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("runtime.sqlite3");
        let store = SqliteStateStore::open(&database, ShortcutPlatform::NonMacOs).unwrap();
        let source = durable_session(&store);
        let mut registry = TrustedAdapterRegistry::default();
        let adapter = Arc::new(Adapter::new());
        registry.register(adapter).unwrap();
        let operation = AdapterOperationContext {
            operation_id: Uuid::from_u128(80),
            request_hash_sha256: [8; 32],
            agent_session_id: source.binding.agent_session_id,
            session_revision: source.revision,
            attempt_epoch: source.attempt_epoch,
        };
        let fault = rusqlite::Connection::open(&database).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER fail_first_orphan_write BEFORE INSERT ON agent_fork_orphans \
                 BEGIN SELECT RAISE(FAIL, 'injected orphan write failure'); END;",
            )
            .unwrap();

        assert!(matches!(
            execute_fork(
                &store,
                &registry,
                &source,
                AdapterPlatform::Linux,
                &operation,
                Uuid::from_u128(81),
                Uuid::from_u128(82),
                Uuid::from_u128(83),
                "recoverable fork".to_owned(),
                160,
            ),
            Err(RuntimeError::UncompensatedFork)
        ));
        assert!(store.load_agent_fork_orphans().unwrap().is_empty());

        fault
            .execute_batch("DROP TRIGGER fail_first_orphan_write")
            .unwrap();
        drop(fault);
        assert_eq!(store.import_agent_fork_orphan_recovery().unwrap(), 1);
        let recovered = store.load_agent_fork_orphans().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            recovered[0].source_agent_session_id,
            source.binding.agent_session_id
        );
        assert_eq!(recovered[0].operation_id, operation.operation_id);
        assert_eq!(recovered[0].adapter_id, "test.adapter");
        assert_eq!(recovered[0].cleanup_state, "pending");
    }
}

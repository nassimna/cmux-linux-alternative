//! Capability-gated, privacy-preserving browser-automation service.

#![allow(
    clippy::manual_let_else,
    clippy::match_same_arms,
    clippy::single_match_else,
    clippy::too_many_lines
)]

use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_workspace_protocol::{
    AUTOMATION_CONTENT_TTL_MS, AUTOMATION_SESSION_IDLE_TTL_MS, ActionInvocationTarget,
    BROWSER_AUTOMATION_CAPABILITY, BrowserAutomationErrorCode, BrowserAutomationExecutionRequest,
    BrowserAutomationOperation, BrowserAutomationOperationCancelParams,
    BrowserAutomationOperationInvokeParams, BrowserAutomationOperationInvokeResult,
    BrowserAutomationOperationResultData, BrowserAutomationOperationSnapshot,
    BrowserAutomationOperationState, BrowserAutomationProviderAcknowledgeParams,
    BrowserAutomationProviderAcknowledgeResult, BrowserAutomationProviderPollParams,
    BrowserAutomationProviderRequest, BrowserAutomationProviderTransferOutcome,
    BrowserAutomationProviderTransferRespondParams, BrowserAutomationScreenshotHandle,
    BrowserAutomationScreenshotReadParams, BrowserAutomationScreenshotReleaseParams,
    BrowserAutomationScreenshotReleaseResult, BrowserAutomationSessionCreateParams,
    BrowserAutomationSessionCreateResult, BrowserAutomationSessionListResult,
    BrowserAutomationSessionMode, BrowserAutomationSessionParams,
    BrowserAutomationSessionProvision, BrowserAutomationSessionResult,
    BrowserAutomationSessionSnapshot, BrowserAutomationSessionState,
    BrowserAutomationTargetBinding, DesktopProviderIdentityParams, ResponseEnvelope,
};
use agent_workspace_storage::{
    BrowserAutomationCreateOutcome, BrowserAutomationLifecycleOutcome,
    BrowserAutomationOperationCreateRecord, BrowserAutomationOperationRecord,
    BrowserAutomationOperationStateRecord, BrowserAutomationProviderFence,
    BrowserAutomationSessionCreateRecord, BrowserAutomationSessionModeRecord,
    BrowserAutomationSessionRecord, BrowserAutomationSessionStateRecord,
    BrowserAutomationTargetRecord, BrowserAutomationTerminalUpdate, SqliteStateStore,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

use super::{
    ControlContext,
    multi_window::{ActionProviderReservation, MultiWindowRuntime},
};

pub(super) const COMMANDS: &[&str] = &[
    "browserAutomation.sessionCreate",
    "browserAutomation.sessionList",
    "browserAutomation.sessionGet",
    "browserAutomation.sessionDestroy",
    "browserAutomation.operationInvoke",
    "browserAutomation.operationCancel",
    "browserAutomation.providerPoll",
    "browserAutomation.providerAcknowledge",
    "browserAutomation.providerTransferRespond",
    "browserAutomation.screenshotRead",
    "browserAutomation.screenshotRelease",
];

const CREATE_TIMEOUT: Duration = Duration::from_mins(2);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(super) struct BrowserAutomationRuntime {
    store: Arc<SqliteStateStore>,
    providers: MultiWindowRuntime,
    owner_id: Uuid,
    digest_key: [u8; 32],
    sensitive_operations: Arc<Mutex<BTreeMap<Uuid, BrowserAutomationOperationInvokeParams>>>,
    ephemeral_results: Arc<Mutex<BTreeMap<Uuid, EphemeralResult>>>,
    create_waiters: Arc<Mutex<BTreeMap<Uuid, oneshot::Sender<SessionCreateCompletion>>>>,
    transfer_waiters: Arc<Mutex<BTreeMap<Uuid, PendingTransfer>>>,
    handles: Arc<Mutex<BTreeMap<Uuid, ScreenshotOwnership>>>,
}

struct EphemeralResult {
    result: BrowserAutomationOperationResultData,
    expires_at_ms: u64,
}

struct SessionCreateCompletion {
    record: BrowserAutomationSessionRecord,
    error_code: Option<BrowserAutomationErrorCode>,
}

struct PendingTransfer {
    caller_id: Uuid,
    automation_session_id: Uuid,
    handle_id: Uuid,
    provider: BrowserAutomationProviderFence,
    correlation_id: Uuid,
    expectation: TransferExpectation,
    sender: oneshot::Sender<BrowserAutomationProviderTransferOutcome>,
}

#[derive(Clone)]
enum TransferExpectation {
    ScreenshotRead {
        chunk_index: u16,
        chunk_count: u16,
        handle_expires_at_ms: u64,
        sha256: String,
    },
    ScreenshotRelease,
}

#[derive(Clone)]
struct ScreenshotOwnership {
    caller_id: Uuid,
    automation_session_id: Uuid,
    session_generation: u64,
    profile_key: String,
    provider: BrowserAutomationProviderFence,
    byte_length: u64,
    chunk_count: u16,
    sha256: String,
    expires_at_ms: u64,
}

impl BrowserAutomationRuntime {
    pub(super) fn new(
        store: Arc<SqliteStateStore>,
        providers: MultiWindowRuntime,
        control_token: &[u8],
    ) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"cmux-browser-automation-digest-v1\0");
        digest.update(control_token);
        let digest_key: [u8; 32] = digest.finalize().into();
        let mut owner_digest = Sha256::new();
        owner_digest.update(b"cmux-browser-automation-owner-v1\0");
        owner_digest.update(control_token);
        let owner_digest = owner_digest.finalize();
        let mut owner_bytes = [0_u8; 16];
        owner_bytes.copy_from_slice(&owner_digest[..16]);
        owner_bytes[6] = (owner_bytes[6] & 0x0f) | 0x50;
        owner_bytes[8] = (owner_bytes[8] & 0x3f) | 0x80;
        Self {
            store,
            providers,
            owner_id: Uuid::from_bytes(owner_bytes),
            digest_key,
            sensitive_operations: Arc::new(Mutex::new(BTreeMap::new())),
            ephemeral_results: Arc::new(Mutex::new(BTreeMap::new())),
            create_waiters: Arc::new(Mutex::new(BTreeMap::new())),
            transfer_waiters: Arc::new(Mutex::new(BTreeMap::new())),
            handles: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn request_digest<T: Serialize>(&self, namespace: &[u8], value: &T) -> Option<String> {
        let bytes = serde_json::to_vec(value).ok()?;
        let mut digest = Sha256::new();
        digest.update(self.digest_key);
        digest.update(namespace);
        digest.update([0]);
        digest.update(bytes);
        Some(format!("{:x}", digest.finalize()))
    }

    async fn session_create(
        &self,
        id: String,
        params: Value,
        context: &ControlContext,
        _connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationSessionCreateParams>(params)
        else {
            return invalid_params(id);
        };
        let Some(workspace) = &context.runtime else {
            return failure(id, BrowserAutomationErrorCode::CapabilityUnavailable);
        };
        let state = workspace.snapshot().await;
        let requested_target = params.target.as_ref().map(|target| target.window.clone());
        let reservation = match self
            .providers
            .action_reserve(
                &state,
                BROWSER_AUTOMATION_CAPABILITY,
                requested_target.as_ref(),
            )
            .await
        {
            Ok(value) => value,
            Err(code) => return provider_failure(id, code),
        };
        let automation_session_id = Uuid::new_v4();
        let lifecycle_operation_id = Uuid::new_v4();
        let correlation_id = parse_uuid(&params.correlation_id);
        let epoch = parse_uuid(&params.idempotency.epoch);
        let key = parse_uuid(&params.idempotency.key);
        let now = now_ms();
        let request_digest = self
            .request_digest(b"sessionCreate", &params)
            .expect("validated parameters serialize");
        let create = BrowserAutomationSessionCreateRecord {
            automation_session_id,
            caller_id: self.owner_id,
            profile_key: params.profile_key.clone(),
            mode: mode_record(params.mode),
            generation: 1,
            navigation_epoch: 1,
            target: params.target.as_ref().map(target_record),
            provider: provider_fence(&reservation),
            lifecycle_operation_id,
            lifecycle_correlation_id: correlation_id,
            lifecycle_attempt_epoch: reservation.attempt_epoch,
            idempotency_epoch: epoch,
            idempotency_key: key,
            request_digest,
            created_at_ms: i64_now(now),
            expires_at_ms: i64_now(now.saturating_add(AUTOMATION_SESSION_IDLE_TTL_MS)),
        };
        let store = Arc::clone(&self.store);
        let outcome =
            tokio::task::spawn_blocking(move || store.create_browser_automation_session(&create))
                .await;
        let Ok(Ok(outcome)) = outcome else {
            self.providers
                .action_abort_reservation(reservation.reservation_id)
                .await;
            return storage_failure(id);
        };
        match outcome {
            BrowserAutomationCreateOutcome::Pending(record) => {
                self.providers
                    .action_abort_reservation(reservation.reservation_id)
                    .await;
                return match self
                    .wait_for_session_ready(record.automation_session_id)
                    .await
                {
                    Some(ready) => session_create_result_response(id, &ready),
                    None => failure(id, BrowserAutomationErrorCode::Interrupted),
                };
            }
            BrowserAutomationCreateOutcome::Replay(record) => {
                self.providers
                    .action_abort_reservation(reservation.reservation_id)
                    .await;
                return session_create_result_response(id, &record);
            }
            BrowserAutomationCreateOutcome::ResultExpired { .. }
            | BrowserAutomationCreateOutcome::EpochExpired => {
                self.providers
                    .action_abort_reservation(reservation.reservation_id)
                    .await;
                return failure(id, BrowserAutomationErrorCode::IdempotencyExpired);
            }
            BrowserAutomationCreateOutcome::Conflict => {
                self.providers
                    .action_abort_reservation(reservation.reservation_id)
                    .await;
                return failure(id, BrowserAutomationErrorCode::IdempotencyConflict);
            }
            BrowserAutomationCreateOutcome::ResourceLimit => {
                self.providers
                    .action_abort_reservation(reservation.reservation_id)
                    .await;
                return failure(id, BrowserAutomationErrorCode::SessionLimit);
            }
            BrowserAutomationCreateOutcome::Created(_) => {}
        }
        let identity = identity_params(&reservation);
        let target = action_target(&reservation);
        let request = BrowserAutomationProviderRequest::Create {
            identity,
            target,
            provision: BrowserAutomationSessionProvision {
                automation_session_id: automation_session_id.to_string(),
                generation: 1,
                mode: params.mode,
                profile_key: params.profile_key,
                requested_target: params.target,
                created_at_ms: now,
                expires_at_ms: now.saturating_add(AUTOMATION_SESSION_IDLE_TTL_MS),
            },
            operation_id: lifecycle_operation_id.to_string(),
            correlation_id: correlation_id.to_string(),
            attempt_epoch: reservation.attempt_epoch,
        };
        let (sender, receiver) = oneshot::channel();
        self.create_waiters
            .lock()
            .await
            .insert(lifecycle_operation_id, sender);
        if let Err(code) = self
            .providers
            .browser_publish(&reservation, lifecycle_operation_id, request)
            .await
        {
            self.create_waiters
                .lock()
                .await
                .remove(&lifecycle_operation_id);
            self.force_session_terminal(
                automation_session_id,
                BrowserAutomationSessionStateRecord::Failed,
                "interrupted",
            )
            .await;
            return provider_failure(id, code);
        }
        match tokio::time::timeout(CREATE_TIMEOUT, receiver).await {
            Ok(Ok(completion)) => {
                if completion.record.state == BrowserAutomationSessionStateRecord::Ready {
                    session_create_result_response(id, &completion.record)
                } else {
                    failure(
                        id,
                        completion
                            .error_code
                            .unwrap_or(BrowserAutomationErrorCode::Interrupted),
                    )
                }
            }
            _ => {
                self.create_waiters
                    .lock()
                    .await
                    .remove(&lifecycle_operation_id);
                let _ = self
                    .providers
                    .browser_cancel(reservation.provider_id, lifecycle_operation_id)
                    .await;
                self.force_session_terminal(
                    automation_session_id,
                    BrowserAutomationSessionStateRecord::Failed,
                    "interrupted",
                )
                .await;
                failure(id, BrowserAutomationErrorCode::Timeout)
            }
        }
    }

    async fn session_list(
        &self,
        id: String,
        params: Value,
        _connection_id: Uuid,
    ) -> ResponseEnvelope {
        if serde_json::from_value::<agent_workspace_protocol::EmptyParams>(params).is_err() {
            return invalid_params(id);
        }
        let store = Arc::clone(&self.store);
        let owner_id = self.owner_id;
        match tokio::task::spawn_blocking(move || {
            store.list_browser_automation_sessions(owner_id, 16)
        })
        .await
        {
            Ok(Ok(records)) => success(
                id,
                BrowserAutomationSessionListResult {
                    sessions: records.iter().filter_map(session_snapshot).collect(),
                },
            ),
            _ => storage_failure(id),
        }
    }

    async fn session_get(
        &self,
        id: String,
        params: Value,
        _connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationSessionParams>(params) else {
            return invalid_params(id);
        };
        let session_id = parse_uuid(&params.automation_session_id);
        let store = Arc::clone(&self.store);
        match tokio::task::spawn_blocking(move || store.browser_automation_session(session_id))
            .await
        {
            Ok(Ok(Some(record)))
                if record.caller_id == self.owner_id && record.generation == params.generation =>
            {
                session_result_response(id, &record)
            }
            Ok(Ok(_)) => failure(id, BrowserAutomationErrorCode::SessionNotFound),
            _ => storage_failure(id),
        }
    }

    async fn session_destroy(
        &self,
        id: String,
        params: Value,
        _connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationSessionParams>(params) else {
            return invalid_params(id);
        };
        let session_id = parse_uuid(&params.automation_session_id);
        let Some(record) = self.load_session(session_id).await else {
            return failure(id, BrowserAutomationErrorCode::SessionNotFound);
        };
        if record.caller_id != self.owner_id || record.generation != params.generation {
            return failure(id, BrowserAutomationErrorCode::SessionGenerationMismatch);
        }
        let Some(provider) = record.provider.clone() else {
            return failure(id, BrowserAutomationErrorCode::Interrupted);
        };
        let operation_id = Uuid::new_v4();
        let correlation_id = Uuid::new_v4();
        let now = now_ms();
        let store = Arc::clone(&self.store);
        let owner_id = self.owner_id;
        let outcome = tokio::task::spawn_blocking(move || {
            store.begin_browser_automation_session_destroy(
                session_id,
                owner_id,
                params.generation,
                operation_id,
                correlation_id,
                provider.provider_epoch,
                i64_now(now),
            )
        })
        .await;
        let Ok(Ok(
            BrowserAutomationLifecycleOutcome::Applied(record)
            | BrowserAutomationLifecycleOutcome::Replay(record),
        )) = outcome
        else {
            return failure(id, BrowserAutomationErrorCode::SessionNotFound);
        };
        self.cleanup_session_memory(session_id).await;
        let request = BrowserAutomationProviderRequest::Destroy {
            identity: identity_from_fence(&provider),
            target: target_from_fence(&provider),
            session: session_snapshot(&record).expect("ready/destroying session has a binding"),
            operation_id: operation_id.to_string(),
            correlation_id: correlation_id.to_string(),
            attempt_epoch: provider.provider_epoch,
        };
        self.providers
            .browser_cancel_session_requests(provider.provider_id, session_id)
            .await;
        if self
            .providers
            .browser_publish_bound(
                provider.provider_id,
                provider.provider_epoch,
                provider.provider_lease_id,
                provider.window_id,
                provider.window_generation,
                operation_id,
                request,
            )
            .await
            .is_err()
        {
            self.force_session_terminal(
                session_id,
                BrowserAutomationSessionStateRecord::Destroyed,
                "canceled",
            )
            .await;
        }
        session_result_response(id, &record)
    }

    async fn operation_invoke(
        &self,
        id: String,
        params: Value,
        _connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationOperationInvokeParams>(params)
        else {
            return invalid_params(id);
        };
        let session_id = parse_uuid(&params.automation_session_id);
        let operation_id = parse_uuid(&params.operation_id);
        let correlation_id = parse_uuid(&params.correlation_id);
        let digest = self
            .request_digest(b"operation", &params)
            .expect("validated operation serializes");
        // An exact operation replay is resolved against its immutable durable record before the
        // mutable session navigation fence. A successful Navigate legitimately advances that
        // fence, so checking the live session first would reject its own terminal replay.
        if let Some(record) = self.load_operation(operation_id).await {
            if record.caller_id == self.owner_id
                && record.automation_session_id == session_id
                && record.session_generation == params.session_generation
                && record.navigation_epoch == params.navigation_epoch
                && record.attempt_epoch == params.attempt_epoch
                && record.correlation_id == correlation_id
                && record.idempotency_epoch == parse_uuid(&params.idempotency.epoch)
                && record.idempotency_key == parse_uuid(&params.idempotency.key)
                && record.request_digest == digest
            {
                return success(
                    id,
                    BrowserAutomationOperationInvokeResult {
                        operation: self.operation_snapshot(&record).await,
                    },
                );
            }
            return failure(id, BrowserAutomationErrorCode::IdempotencyConflict);
        }
        let Some(session) = self.load_session(session_id).await else {
            return failure(id, BrowserAutomationErrorCode::SessionNotFound);
        };
        if session.caller_id != self.owner_id || session.generation != params.session_generation {
            return failure(id, BrowserAutomationErrorCode::SessionGenerationMismatch);
        }
        if session.navigation_epoch != params.navigation_epoch {
            return failure(id, BrowserAutomationErrorCode::StaleNavigation);
        }
        if session.state != BrowserAutomationSessionStateRecord::Ready {
            return failure(id, BrowserAutomationErrorCode::SessionExpired);
        }
        let Some(provider) = session.provider.clone() else {
            return failure(id, BrowserAutomationErrorCode::ProviderUnavailable);
        };
        let bytes = serde_json::to_vec(&params.operation)
            .expect("validated operation serializes")
            .len();
        let create = BrowserAutomationOperationCreateRecord {
            operation_id,
            automation_session_id: session_id,
            caller_id: self.owner_id,
            session_generation: params.session_generation,
            navigation_epoch: params.navigation_epoch,
            attempt_epoch: params.attempt_epoch,
            correlation_id,
            idempotency_epoch: parse_uuid(&params.idempotency.epoch),
            idempotency_key: parse_uuid(&params.idempotency.key),
            request_digest: digest,
            operation_kind: operation_kind(&params.operation).to_owned(),
            input_bytes: u32::try_from(bytes).unwrap_or(u32::MAX),
            provider: provider.clone(),
            accepted_at_ms: i64_now(now_ms()),
            expires_at_ms: i64_now(now_ms().saturating_add(u64::from(params.timeout_ms))),
        };
        let store = Arc::clone(&self.store);
        let outcome =
            tokio::task::spawn_blocking(move || store.create_browser_automation_operation(&create))
                .await;
        let Ok(Ok(outcome)) = outcome else {
            return storage_failure(id);
        };
        let record = match outcome {
            BrowserAutomationCreateOutcome::Created(record) => record,
            BrowserAutomationCreateOutcome::Pending(record) => {
                return success(
                    id,
                    BrowserAutomationOperationInvokeResult {
                        operation: self.operation_snapshot(&record).await,
                    },
                );
            }
            BrowserAutomationCreateOutcome::Replay(record) => {
                return success(
                    id,
                    BrowserAutomationOperationInvokeResult {
                        operation: self.operation_snapshot(&record).await,
                    },
                );
            }
            BrowserAutomationCreateOutcome::ResultExpired { .. } => {
                return failure(id, BrowserAutomationErrorCode::ResultExpired);
            }
            BrowserAutomationCreateOutcome::EpochExpired => {
                return failure(id, BrowserAutomationErrorCode::IdempotencyExpired);
            }
            BrowserAutomationCreateOutcome::Conflict => {
                return failure(id, BrowserAutomationErrorCode::IdempotencyConflict);
            }
            BrowserAutomationCreateOutcome::ResourceLimit => {
                return failure(id, BrowserAutomationErrorCode::ResourceLimit);
            }
        };
        self.sensitive_operations
            .lock()
            .await
            .insert(operation_id, params.clone());
        let request = BrowserAutomationProviderRequest::Execute {
            request: BrowserAutomationExecutionRequest {
                identity: identity_from_fence(&provider),
                target: target_from_fence(&provider),
                session: session_snapshot(&session).expect("ready session has target"),
                operation: params,
            },
        };
        if let Err(code) = self
            .providers
            .browser_publish_bound(
                provider.provider_id,
                provider.provider_epoch,
                provider.provider_lease_id,
                provider.window_id,
                provider.window_generation,
                operation_id,
                request,
            )
            .await
        {
            self.sensitive_operations.lock().await.remove(&operation_id);
            self.force_operation_terminal(
                operation_id,
                BrowserAutomationOperationStateRecord::Interrupted,
                "interrupted",
            )
            .await;
            return provider_failure(id, code);
        }
        success(
            id,
            BrowserAutomationOperationInvokeResult {
                operation: self.operation_snapshot(&record).await,
            },
        )
    }

    async fn operation_cancel(
        &self,
        id: String,
        params: Value,
        _connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationOperationCancelParams>(params)
        else {
            return invalid_params(id);
        };
        let operation_id = parse_uuid(&params.operation_id);
        let Some(record) = self.load_operation(operation_id).await else {
            return failure(id, BrowserAutomationErrorCode::InvalidOperation);
        };
        if record.caller_id != self.owner_id
            || record.automation_session_id != parse_uuid(&params.automation_session_id)
            || record.session_generation != params.session_generation
            || record.correlation_id != parse_uuid(&params.correlation_id)
        {
            return failure(id, BrowserAutomationErrorCode::InvalidOperation);
        }
        self.force_operation_terminal(
            operation_id,
            BrowserAutomationOperationStateRecord::Canceled,
            "canceled",
        )
        .await;
        self.sensitive_operations.lock().await.remove(&operation_id);
        let _ = self
            .providers
            .browser_cancel(record.provider.provider_id, operation_id)
            .await;
        let cancel_request = BrowserAutomationProviderRequest::Cancel {
            identity: identity_from_fence(&record.provider),
            target: target_from_fence(&record.provider),
            automation_session_id: record.automation_session_id.to_string(),
            session_generation: record.session_generation,
            operation_id: record.operation_id.to_string(),
            correlation_id: record.correlation_id.to_string(),
        };
        let _ = self
            .providers
            .browser_publish_bound(
                record.provider.provider_id,
                record.provider.provider_epoch,
                record.provider.provider_lease_id,
                record.provider.window_id,
                record.provider.window_generation,
                operation_id,
                cancel_request,
            )
            .await;
        let updated = self.load_operation(operation_id).await.unwrap_or(record);
        success(
            id,
            BrowserAutomationOperationInvokeResult {
                operation: self.operation_snapshot(&updated).await,
            },
        )
    }

    async fn provider_poll(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationProviderPollParams>(params)
        else {
            return invalid_params(id);
        };
        match self
            .providers
            .browser_poll(&params.identity, params.timeout_ms)
            .await
        {
            Ok(mut result) => {
                if let Some(BrowserAutomationProviderRequest::Execute { request }) = &result.request
                {
                    let operation_id = parse_uuid(&request.operation.operation_id);
                    let polled_provider_id = parse_uuid(&request.identity.provider_id);
                    match self.load_operation_checked(operation_id).await {
                        Ok(Some(record)) => {
                            let provider_id = record.provider.provider_id;
                            if provider_id != polled_provider_id {
                                self.force_operation_terminal(
                                    operation_id,
                                    BrowserAutomationOperationStateRecord::Interrupted,
                                    "interrupted",
                                )
                                .await;
                                self.providers
                                    .browser_finalize(polled_provider_id, operation_id)
                                    .await;
                                result.request = None;
                                return success(id, result);
                            }
                            let store = Arc::clone(&self.store);
                            let provider = record.provider.clone();
                            let outcome = tokio::task::spawn_blocking(move || {
                                store.mark_browser_automation_operation_running(
                                    operation_id,
                                    record.correlation_id,
                                    record.attempt_epoch,
                                    &provider,
                                    i64_now(now_ms()),
                                )
                            })
                            .await;
                            match outcome {
                                Ok(Ok(
                                    BrowserAutomationLifecycleOutcome::Applied(_)
                                    | BrowserAutomationLifecycleOutcome::Replay(_),
                                )) => {}
                                Ok(Ok(BrowserAutomationLifecycleOutcome::ResourceLimit)) => {
                                    self.providers
                                        .browser_defer(provider_id, operation_id)
                                        .await;
                                    result.request = None;
                                }
                                Ok(Ok(
                                    BrowserAutomationLifecycleOutcome::Terminal(_)
                                    | BrowserAutomationLifecycleOutcome::NotFound,
                                )) => {
                                    self.providers
                                        .browser_finalize(provider_id, operation_id)
                                        .await;
                                    result.request = None;
                                }
                                Ok(Ok(
                                    BrowserAutomationLifecycleOutcome::Mismatch
                                    | BrowserAutomationLifecycleOutcome::InvalidState,
                                )) => {
                                    self.force_operation_terminal(
                                        operation_id,
                                        BrowserAutomationOperationStateRecord::Interrupted,
                                        "interrupted",
                                    )
                                    .await;
                                    self.providers
                                        .browser_finalize(provider_id, operation_id)
                                        .await;
                                    result.request = None;
                                }
                                Err(_) | Ok(Err(_)) => {
                                    self.providers
                                        .browser_defer(provider_id, operation_id)
                                        .await;
                                    result.request = None;
                                }
                            }
                        }
                        Ok(None) => {
                            self.providers
                                .browser_finalize(polled_provider_id, operation_id)
                                .await;
                            result.request = None;
                        }
                        Err(()) => {
                            self.providers
                                .browser_defer(polled_provider_id, operation_id)
                                .await;
                            result.request = None;
                        }
                    }
                }
                success(id, result)
            }
            Err(code) => provider_failure(id, code),
        }
    }

    async fn provider_acknowledge(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) =
            serde_json::from_value::<BrowserAutomationProviderAcknowledgeParams>(params)
        else {
            return invalid_params(id);
        };
        let session_id = parse_uuid(&params.automation_session_id);
        let operation_id = parse_uuid(&params.operation_id);
        let correlation_id = parse_uuid(&params.correlation_id);
        if self
            .providers
            .browser_request_matches(
                &params.identity,
                &params.target,
                operation_id,
                correlation_id,
            )
            .await
            .is_err()
        {
            return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch);
        }
        if let Some(session) = self.load_session(session_id).await
            && session.lifecycle_operation_id == operation_id
        {
            return self.acknowledge_lifecycle(id, params, session).await;
        }
        let Some(record) = self.load_operation(operation_id).await else {
            return failure(id, BrowserAutomationErrorCode::InvalidOperation);
        };
        if record.automation_session_id != session_id
            || record.session_generation != params.session_generation
            || record.correlation_id != correlation_id
            || record.attempt_epoch != params.attempt_epoch
            || record.provider != fence_from_ack(&params)
        {
            return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch);
        }
        if record.state.is_terminal() {
            self.providers
                .browser_finalize(record.provider.provider_id, operation_id)
                .await;
            return success(
                id,
                BrowserAutomationProviderAcknowledgeResult {
                    operation: self.operation_snapshot(&record).await,
                },
            );
        }
        if i64_now(now_ms()) >= record.expires_at_ms {
            self.force_operation_terminal(
                operation_id,
                BrowserAutomationOperationStateRecord::Expired,
                "timeout",
            )
            .await;
            self.sensitive_operations.lock().await.remove(&operation_id);
            self.providers
                .browser_finalize(record.provider.provider_id, operation_id)
                .await;
            let terminal = self.load_operation(operation_id).await.unwrap_or(record);
            return success(
                id,
                BrowserAutomationProviderAcknowledgeResult {
                    operation: self.operation_snapshot(&terminal).await,
                },
            );
        }
        if !execute_ack_shape_matches(&params) {
            return failure(id, BrowserAutomationErrorCode::InvalidOperation);
        }
        let (state, error) = match terminal_state(params.state, params.error_code) {
            Ok(value) => value,
            Err(code) => return failure(id, code),
        };
        let (result_kind, result_digest, result_bytes) = if state
            == BrowserAutomationOperationStateRecord::Succeeded
        {
            let Some(result) = params.result.clone() else {
                return failure(id, BrowserAutomationErrorCode::InvalidOperation);
            };
            if !result_matches_operation(&record.operation_kind, &result) {
                return failure(id, BrowserAutomationErrorCode::InvalidOperation);
            }
            if let BrowserAutomationOperationResultData::Navigation { navigation_epoch } = &result
                && *navigation_epoch != record.navigation_epoch.saturating_add(1)
            {
                return failure(id, BrowserAutomationErrorCode::StaleNavigation);
            }
            if let BrowserAutomationOperationResultData::Screenshot { handle } = &result
                && let Err(code) = self.register_handle(&record, handle).await
            {
                return failure(id, code);
            }
            let bytes = serde_json::to_vec(&result).expect("validated result serializes");
            let digest = self
                .request_digest(b"result", &result)
                .expect("validated result serializes");
            (
                Some(result_kind(&result).to_owned()),
                Some(digest),
                Some(u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
            )
        } else {
            if params.result.is_some() {
                return failure(id, BrowserAutomationErrorCode::InvalidOperation);
            }
            (None, None, None)
        };
        let update = BrowserAutomationTerminalUpdate {
            operation_id,
            automation_session_id: session_id,
            session_generation: params.session_generation,
            navigation_epoch: record.navigation_epoch,
            attempt_epoch: params.attempt_epoch,
            correlation_id,
            provider: record.provider.clone(),
            state,
            result_kind,
            result_digest,
            result_bytes,
            error_code: error.map(error_code_str).map(str::to_owned),
            completed_at_ms: i64_now(now_ms()),
        };
        let store = Arc::clone(&self.store);
        let outcome = tokio::task::spawn_blocking(move || {
            store.terminalize_browser_automation_operation(&update)
        })
        .await;
        let Ok(Ok(outcome)) = outcome else {
            return storage_failure(id);
        };
        let was_applied = matches!(&outcome, BrowserAutomationLifecycleOutcome::Applied(_));
        let terminal = match outcome {
            BrowserAutomationLifecycleOutcome::Applied(value)
            | BrowserAutomationLifecycleOutcome::Terminal(value)
            | BrowserAutomationLifecycleOutcome::Replay(value) => value,
            _ => return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch),
        };
        if was_applied && let Some(result) = params.result {
            self.ephemeral_results.lock().await.insert(
                operation_id,
                EphemeralResult {
                    result,
                    expires_at_ms: now_ms().saturating_add(AUTOMATION_CONTENT_TTL_MS),
                },
            );
        }
        self.sensitive_operations.lock().await.remove(&operation_id);
        self.providers
            .browser_finalize(record.provider.provider_id, operation_id)
            .await;
        success(
            id,
            BrowserAutomationProviderAcknowledgeResult {
                operation: self.operation_snapshot(&terminal).await,
            },
        )
    }

    async fn acknowledge_lifecycle(
        &self,
        id: String,
        params: BrowserAutomationProviderAcknowledgeParams,
        record: BrowserAutomationSessionRecord,
    ) -> ResponseEnvelope {
        if !lifecycle_ack_shape_matches(record.state, &params) {
            return failure(id, BrowserAutomationErrorCode::InvalidOperation);
        }
        let provider = fence_from_ack(&params);
        if record.provider.as_ref() != Some(&provider)
            || record.lifecycle_correlation_id != parse_uuid(&params.correlation_id)
            || record.lifecycle_attempt_epoch != params.attempt_epoch
            || record.generation != params.session_generation
        {
            return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch);
        }
        let successful = params.state == BrowserAutomationOperationState::Succeeded;
        let updated = if record.state == BrowserAutomationSessionStateRecord::Creating && successful
        {
            let Some(snapshot) = params.session.clone() else {
                return failure(id, BrowserAutomationErrorCode::InvalidOperation);
            };
            if !session_ack_matches(&record, &snapshot, &params.target) {
                return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch);
            }
            let target = target_record(&snapshot.target);
            let store = Arc::clone(&self.store);
            let op = record.lifecycle_operation_id;
            let corr = record.lifecycle_correlation_id;
            let provider_for_store = provider.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                store.mark_browser_automation_session_ready(
                    record.automation_session_id,
                    op,
                    corr,
                    params.attempt_epoch,
                    &provider_for_store,
                    &target,
                    snapshot.navigation_epoch,
                    i64_now(now_ms()),
                )
            })
            .await;
            match outcome {
                Ok(Ok(
                    BrowserAutomationLifecycleOutcome::Applied(value)
                    | BrowserAutomationLifecycleOutcome::Replay(value),
                )) => value,
                _ => return storage_failure(id),
            }
        } else {
            let terminal_state =
                if record.state == BrowserAutomationSessionStateRecord::Destroying && successful {
                    BrowserAutomationSessionStateRecord::Destroyed
                } else {
                    BrowserAutomationSessionStateRecord::Failed
                };
            let store = Arc::clone(&self.store);
            let op = record.lifecycle_operation_id;
            let corr = record.lifecycle_correlation_id;
            let sid = record.automation_session_id;
            let provider_for_store = provider.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                store.terminalize_browser_automation_session(
                    sid,
                    op,
                    corr,
                    params.attempt_epoch,
                    &provider_for_store,
                    terminal_state,
                    "interrupted",
                    i64_now(now_ms()),
                )
            })
            .await;
            match outcome {
                Ok(Ok(
                    BrowserAutomationLifecycleOutcome::Applied(value)
                    | BrowserAutomationLifecycleOutcome::Terminal(value),
                )) => value,
                _ => return storage_failure(id),
            }
        };
        self.providers
            .browser_finalize(provider.provider_id, record.lifecycle_operation_id)
            .await;
        if let Some(sender) = self
            .create_waiters
            .lock()
            .await
            .remove(&record.lifecycle_operation_id)
        {
            let _ = sender.send(SessionCreateCompletion {
                record: updated.clone(),
                error_code: params.error_code,
            });
        }
        success(
            id,
            BrowserAutomationProviderAcknowledgeResult {
                operation: lifecycle_snapshot(&updated, params.state, params.error_code),
            },
        )
    }

    async fn screenshot_read(
        &self,
        id: String,
        params: Value,
        connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationScreenshotReadParams>(params)
        else {
            return invalid_params(id);
        };
        let handle_id = params.handle_id.clone();
        let chunk_index = params.chunk_index;
        match self
            .transfer(
                params.automation_session_id.clone(),
                params.session_generation,
                &handle_id,
                connection_id,
                Some(chunk_index),
                |identity, target, request_id, correlation_id| {
                    BrowserAutomationProviderRequest::ScreenshotRead {
                        identity,
                        target,
                        request_id,
                        correlation_id,
                        params,
                    }
                },
            )
            .await
        {
            Ok(BrowserAutomationProviderTransferOutcome::ScreenshotRead { result }) => {
                success(id, result)
            }
            Ok(BrowserAutomationProviderTransferOutcome::Error { error_code }) => {
                failure(id, error_code)
            }
            Ok(_) => failure(id, BrowserAutomationErrorCode::InvalidOperation),
            Err(code) => failure(id, code),
        }
    }

    async fn screenshot_release(
        &self,
        id: String,
        params: Value,
        connection_id: Uuid,
    ) -> ResponseEnvelope {
        let Ok(params) = serde_json::from_value::<BrowserAutomationScreenshotReleaseParams>(params)
        else {
            return invalid_params(id);
        };
        let handle_id = parse_uuid(&params.handle_id);
        let handle_id_text = params.handle_id.clone();
        match self
            .transfer(
                params.automation_session_id.clone(),
                params.session_generation,
                &handle_id_text,
                connection_id,
                None,
                |identity, target, request_id, correlation_id| {
                    BrowserAutomationProviderRequest::ScreenshotRelease {
                        identity,
                        target,
                        request_id,
                        correlation_id,
                        params,
                    }
                },
            )
            .await
        {
            Ok(BrowserAutomationProviderTransferOutcome::ScreenshotRelease { released }) => {
                self.handles.lock().await.remove(&handle_id);
                success(id, BrowserAutomationScreenshotReleaseResult { released })
            }
            Ok(BrowserAutomationProviderTransferOutcome::Error { error_code }) => {
                failure(id, error_code)
            }
            Ok(_) => failure(id, BrowserAutomationErrorCode::InvalidOperation),
            Err(code) => failure(id, code),
        }
    }

    async fn transfer<F>(
        &self,
        session_id: String,
        generation: u64,
        handle: &str,
        connection_id: Uuid,
        chunk_index: Option<u16>,
        build: F,
    ) -> Result<BrowserAutomationProviderTransferOutcome, BrowserAutomationErrorCode>
    where
        F: FnOnce(
            DesktopProviderIdentityParams,
            ActionInvocationTarget,
            String,
            String,
        ) -> BrowserAutomationProviderRequest,
    {
        self.prune_handles().await;
        let handle_id = parse_uuid(handle);
        let ownership = self
            .handles
            .lock()
            .await
            .get(&handle_id)
            .cloned()
            .ok_or(BrowserAutomationErrorCode::ResultExpired)?;
        if ownership.caller_id != self.owner_id
            || ownership.automation_session_id != parse_uuid(&session_id)
            || ownership.session_generation != generation
        {
            return Err(BrowserAutomationErrorCode::PolicyDenied);
        }
        let mut waiters = self.transfer_waiters.lock().await;
        if waiters
            .values()
            .filter(|pending| pending.caller_id == connection_id)
            .count()
            >= 4
        {
            return Err(BrowserAutomationErrorCode::AutomationBackpressure);
        }
        let request_id = Uuid::new_v4();
        let correlation_id = Uuid::new_v4();
        let (sender, receiver) = oneshot::channel();
        waiters.insert(
            request_id,
            PendingTransfer {
                caller_id: connection_id,
                automation_session_id: ownership.automation_session_id,
                handle_id,
                provider: ownership.provider.clone(),
                correlation_id,
                expectation: match chunk_index {
                    Some(chunk_index) => TransferExpectation::ScreenshotRead {
                        chunk_index,
                        chunk_count: ownership.chunk_count,
                        handle_expires_at_ms: ownership.expires_at_ms,
                        sha256: ownership.sha256.clone(),
                    },
                    None => TransferExpectation::ScreenshotRelease,
                },
                sender,
            },
        );
        drop(waiters);
        let request = build(
            identity_from_fence(&ownership.provider),
            target_from_fence(&ownership.provider),
            request_id.to_string(),
            correlation_id.to_string(),
        );
        if self
            .providers
            .browser_publish_bound(
                ownership.provider.provider_id,
                ownership.provider.provider_epoch,
                ownership.provider.provider_lease_id,
                ownership.provider.window_id,
                ownership.provider.window_generation,
                request_id,
                request,
            )
            .await
            .is_err()
        {
            self.transfer_waiters.lock().await.remove(&request_id);
            return Err(BrowserAutomationErrorCode::ProviderUnavailable);
        }
        match tokio::time::timeout(TRANSFER_TIMEOUT, receiver).await {
            Ok(Ok(outcome)) => Ok(outcome),
            _ => {
                self.transfer_waiters.lock().await.remove(&request_id);
                let _ = self
                    .providers
                    .browser_cancel(ownership.provider.provider_id, request_id)
                    .await;
                Err(BrowserAutomationErrorCode::Timeout)
            }
        }
    }

    async fn transfer_respond(&self, id: String, params: Value) -> ResponseEnvelope {
        let Ok(params) =
            serde_json::from_value::<BrowserAutomationProviderTransferRespondParams>(params)
        else {
            return invalid_params(id);
        };
        let request_id = parse_uuid(&params.request_id);
        let correlation_id = parse_uuid(&params.correlation_id);
        if self
            .providers
            .browser_request_matches(&params.identity, &params.target, request_id, correlation_id)
            .await
            .is_err()
        {
            return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch);
        }
        let mut waiters = self.transfer_waiters.lock().await;
        let Some(pending) = waiters.get(&request_id) else {
            return failure(id, BrowserAutomationErrorCode::Canceled);
        };
        if pending.correlation_id != correlation_id
            || pending.provider != fence_from_identity(&params.identity, &params.target)
        {
            return failure(id, BrowserAutomationErrorCode::ProviderEpochMismatch);
        }
        if !transfer_outcome_matches(&params.outcome, pending.handle_id, &pending.expectation) {
            return failure(id, BrowserAutomationErrorCode::InvalidOperation);
        }
        let pending = waiters
            .remove(&request_id)
            .expect("validated transfer waiter remains present");
        drop(waiters);
        let provider_id = pending.provider.provider_id;
        let _ = pending.sender.send(params.outcome);
        self.providers
            .browser_finalize(provider_id, request_id)
            .await;
        success(id, serde_json::json!({}))
    }

    async fn register_handle(
        &self,
        record: &BrowserAutomationOperationRecord,
        handle: &BrowserAutomationScreenshotHandle,
    ) -> Result<(), BrowserAutomationErrorCode> {
        self.prune_handles().await;
        let now = now_ms();
        if handle.expires_at_ms <= now
            || handle.expires_at_ms > now.saturating_add(AUTOMATION_CONTENT_TTL_MS)
        {
            return Err(BrowserAutomationErrorCode::InvalidOperation);
        }
        let session = self
            .load_session(record.automation_session_id)
            .await
            .ok_or(BrowserAutomationErrorCode::SessionNotFound)?;
        let handle_id = parse_uuid(&handle.handle_id);
        let mut handles = self.handles.lock().await;
        if handles.contains_key(&handle_id) {
            return Err(BrowserAutomationErrorCode::IdempotencyConflict);
        }
        let session_handles: Vec<_> = handles
            .values()
            .filter(|v| v.automation_session_id == record.automation_session_id)
            .collect();
        let provider_handles: Vec<_> = handles
            .values()
            .filter(|v| v.provider.provider_id == record.provider.provider_id)
            .collect();
        let profile_handles: Vec<_> = handles
            .values()
            .filter(|v| v.profile_key == session.profile_key)
            .collect();
        if session_handles.len() >= 2
            || session_handles
                .iter()
                .map(|v| v.byte_length)
                .sum::<u64>()
                .saturating_add(handle.byte_length)
                > 32 * 1024 * 1024
            || provider_handles.len() >= 8
            || provider_handles
                .iter()
                .map(|v| v.byte_length)
                .sum::<u64>()
                .saturating_add(handle.byte_length)
                > 64 * 1024 * 1024
            || profile_handles.len() >= 16
            || profile_handles
                .iter()
                .map(|v| v.byte_length)
                .sum::<u64>()
                .saturating_add(handle.byte_length)
                > 128 * 1024 * 1024
        {
            return Err(BrowserAutomationErrorCode::ResourceLimit);
        }
        handles.insert(
            handle_id,
            ScreenshotOwnership {
                caller_id: record.caller_id,
                automation_session_id: record.automation_session_id,
                session_generation: record.session_generation,
                profile_key: session.profile_key,
                provider: record.provider.clone(),
                byte_length: handle.byte_length,
                chunk_count: handle.chunk_count,
                sha256: handle.sha256.clone(),
                expires_at_ms: handle.expires_at_ms,
            },
        );
        Ok(())
    }

    async fn prune_handles(&self) {
        let now = now_ms();
        self.handles
            .lock()
            .await
            .retain(|_, v| v.expires_at_ms > now);
    }
    async fn load_session(&self, id: Uuid) -> Option<BrowserAutomationSessionRecord> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.browser_automation_session(id))
            .await
            .ok()?
            .ok()?
    }
    async fn wait_for_session_ready(&self, id: Uuid) -> Option<BrowserAutomationSessionRecord> {
        tokio::time::timeout(CREATE_TIMEOUT, async {
            loop {
                let record = self.load_session(id).await?;
                if record.state == BrowserAutomationSessionStateRecord::Ready {
                    return Some(record);
                }
                if record.state.is_terminal() {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .ok()
        .flatten()
    }
    async fn load_operation(&self, id: Uuid) -> Option<BrowserAutomationOperationRecord> {
        self.load_operation_checked(id).await.ok().flatten()
    }
    async fn load_operation_checked(
        &self,
        id: Uuid,
    ) -> Result<Option<BrowserAutomationOperationRecord>, ()> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.browser_automation_operation(id))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())
    }
    async fn force_operation_terminal(
        &self,
        id: Uuid,
        state: BrowserAutomationOperationStateRecord,
        code: &'static str,
    ) {
        let store = Arc::clone(&self.store);
        let _ = tokio::task::spawn_blocking(move || {
            store.terminalize_browser_automation_operation_unchecked(
                id,
                state,
                code,
                i64_now(now_ms()),
            )
        })
        .await;
    }
    async fn force_session_terminal(
        &self,
        id: Uuid,
        state: BrowserAutomationSessionStateRecord,
        code: &'static str,
    ) {
        let Some(record) = self.load_session(id).await else {
            return;
        };
        let Some(provider) = record.provider.clone() else {
            return;
        };
        let store = Arc::clone(&self.store);
        let _ = tokio::task::spawn_blocking(move || {
            store.terminalize_browser_automation_session(
                id,
                record.lifecycle_operation_id,
                record.lifecycle_correlation_id,
                record.lifecycle_attempt_epoch,
                &provider,
                state,
                code,
                i64_now(now_ms()),
            )
        })
        .await;
    }
    async fn request_session_cleanup(
        &self,
        record: BrowserAutomationSessionRecord,
        fallback_state: BrowserAutomationSessionStateRecord,
        fallback_code: &'static str,
    ) {
        self.cleanup_session_memory(record.automation_session_id)
            .await;
        let Some(provider) = record.provider.clone() else {
            return;
        };
        match record.state {
            BrowserAutomationSessionStateRecord::Creating => {
                let _ = self
                    .providers
                    .browser_cancel(provider.provider_id, record.lifecycle_operation_id)
                    .await;
                self.force_session_terminal(
                    record.automation_session_id,
                    fallback_state,
                    fallback_code,
                )
                .await;
            }
            BrowserAutomationSessionStateRecord::Ready => {
                let operation_id = Uuid::new_v4();
                let correlation_id = Uuid::new_v4();
                let session_id = record.automation_session_id;
                let caller_id = record.caller_id;
                let generation = record.generation;
                let provider_epoch = provider.provider_epoch;
                let store = Arc::clone(&self.store);
                let outcome = tokio::task::spawn_blocking(move || {
                    store.begin_browser_automation_session_destroy(
                        session_id,
                        caller_id,
                        generation,
                        operation_id,
                        correlation_id,
                        provider_epoch,
                        i64_now(now_ms()),
                    )
                })
                .await;
                let Ok(Ok(
                    BrowserAutomationLifecycleOutcome::Applied(destroying)
                    | BrowserAutomationLifecycleOutcome::Replay(destroying),
                )) = outcome
                else {
                    self.force_session_terminal(session_id, fallback_state, fallback_code)
                        .await;
                    return;
                };
                let Some(snapshot) = session_snapshot(&destroying) else {
                    self.force_session_terminal(session_id, fallback_state, fallback_code)
                        .await;
                    return;
                };
                self.providers
                    .browser_cancel_session_requests(provider.provider_id, session_id)
                    .await;
                let request = BrowserAutomationProviderRequest::Destroy {
                    identity: identity_from_fence(&provider),
                    target: target_from_fence(&provider),
                    session: snapshot,
                    operation_id: operation_id.to_string(),
                    correlation_id: correlation_id.to_string(),
                    attempt_epoch: provider_epoch,
                };
                if self
                    .providers
                    .browser_publish_bound(
                        provider.provider_id,
                        provider.provider_epoch,
                        provider.provider_lease_id,
                        provider.window_id,
                        provider.window_generation,
                        operation_id,
                        request,
                    )
                    .await
                    .is_err()
                {
                    self.force_session_terminal(session_id, fallback_state, fallback_code)
                        .await;
                }
            }
            BrowserAutomationSessionStateRecord::Destroying => {
                // A provider-bound destroy is already queued or in flight.
            }
            BrowserAutomationSessionStateRecord::Destroyed
            | BrowserAutomationSessionStateRecord::Failed
            | BrowserAutomationSessionStateRecord::Expired => {}
        }
    }
    async fn cleanup_session_memory(&self, id: Uuid) {
        self.sensitive_operations
            .lock()
            .await
            .retain(|_, v| parse_uuid(&v.automation_session_id) != id);
        self.handles
            .lock()
            .await
            .retain(|_, v| v.automation_session_id != id);
        self.transfer_waiters
            .lock()
            .await
            .retain(|_, v| v.automation_session_id != id);
    }

    async fn operation_snapshot(
        &self,
        record: &BrowserAutomationOperationRecord,
    ) -> BrowserAutomationOperationSnapshot {
        let now = now_ms();
        let mut results = self.ephemeral_results.lock().await;
        results.retain(|_, v| v.expires_at_ms > now);
        let mut result = results.get(&record.operation_id).map(|v| v.result.clone());
        if result.is_none()
            && record.state == BrowserAutomationOperationStateRecord::Succeeded
            && record.result_kind.as_deref() == Some("empty")
        {
            result = Some(BrowserAutomationOperationResultData::Empty);
        }
        let result_expired =
            record.state == BrowserAutomationOperationStateRecord::Succeeded && result.is_none();
        let state = if result_expired {
            BrowserAutomationOperationState::ResultExpired
        } else {
            operation_state(record.state)
        };
        BrowserAutomationOperationSnapshot {
            automation_session_id: record.automation_session_id.to_string(),
            session_generation: record.session_generation,
            operation_id: record.operation_id.to_string(),
            correlation_id: record.correlation_id.to_string(),
            attempt_epoch: record.attempt_epoch,
            navigation_epoch: record.navigation_epoch,
            state,
            result,
            error_code: if result_expired {
                Some(BrowserAutomationErrorCode::ResultExpired)
            } else {
                record.error_code.as_deref().and_then(parse_error_code)
            },
            updated_at_ms: u64_time(record.updated_at_ms),
        }
    }

    pub(super) async fn reconcile(&self) {
        let store = Arc::clone(&self.store);
        let operations = tokio::task::spawn_blocking(move || {
            store.recover_browser_automation_operations(i64_now(now_ms()), 4_096)
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
        for record in operations {
            if record.state.is_terminal() {
                continue;
            }
            let in_memory = self
                .sensitive_operations
                .lock()
                .await
                .contains_key(&record.operation_id);
            let active = self
                .providers
                .action_identity_is_active(
                    record.provider.provider_id,
                    record.provider.provider_epoch,
                    record.provider.provider_lease_id,
                    record.provider.window_id,
                    record.provider.window_generation,
                )
                .await;
            if !in_memory || !active {
                self.force_operation_terminal(
                    record.operation_id,
                    BrowserAutomationOperationStateRecord::Interrupted,
                    "interrupted",
                )
                .await;
            } else if record.expires_at_ms <= i64_now(now_ms()) {
                self.force_operation_terminal(
                    record.operation_id,
                    BrowserAutomationOperationStateRecord::Expired,
                    "timeout",
                )
                .await;
            }
        }
        let store = Arc::clone(&self.store);
        let sessions =
            tokio::task::spawn_blocking(move || store.recover_browser_automation_sessions(4_096))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
        for record in sessions {
            let Some(provider) = &record.provider else {
                continue;
            };
            let active = self
                .providers
                .action_identity_is_active(
                    provider.provider_id,
                    provider.provider_epoch,
                    provider.provider_lease_id,
                    provider.window_id,
                    provider.window_generation,
                )
                .await;
            if !active {
                self.force_session_terminal(
                    record.automation_session_id,
                    BrowserAutomationSessionStateRecord::Failed,
                    "interrupted",
                )
                .await;
                self.cleanup_session_memory(record.automation_session_id)
                    .await;
            } else if record.expires_at_ms <= i64_now(now_ms()) {
                self.request_session_cleanup(
                    record,
                    BrowserAutomationSessionStateRecord::Expired,
                    "timeout",
                )
                .await;
            }
        }
        let store = Arc::clone(&self.store);
        let _ = tokio::task::spawn_blocking(move || {
            store.prune_browser_automation_records(i64_now(now_ms()))
        })
        .await;
        self.prune_handles().await;
    }

    pub(super) async fn cancel_caller(&self, caller_id: Uuid) {
        let mut waiters = self.transfer_waiters.lock().await;
        let request_ids: Vec<_> = waiters
            .iter()
            .filter_map(|(request_id, pending)| {
                (pending.caller_id == caller_id)
                    .then_some((*request_id, pending.provider.provider_id))
            })
            .collect();
        for (request_id, _) in &request_ids {
            waiters.remove(request_id);
        }
        drop(waiters);
        for (request_id, provider_id) in request_ids {
            let _ = self.providers.browser_cancel(provider_id, request_id).await;
        }
    }
    pub(super) async fn shutdown(&self) {
        let store = Arc::clone(&self.store);
        let operations = tokio::task::spawn_blocking(move || {
            store.recover_browser_automation_operations(i64_now(now_ms()), 4_096)
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
        for record in operations {
            if !record.state.is_terminal() {
                self.force_operation_terminal(
                    record.operation_id,
                    BrowserAutomationOperationStateRecord::Interrupted,
                    "interrupted",
                )
                .await;
            }
        }
        let store = Arc::clone(&self.store);
        let sessions =
            tokio::task::spawn_blocking(move || store.recover_browser_automation_sessions(4_096))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
        for record in sessions {
            self.force_session_terminal(
                record.automation_session_id,
                BrowserAutomationSessionStateRecord::Failed,
                "interrupted",
            )
            .await;
            self.cleanup_session_memory(record.automation_session_id)
                .await;
        }
        self.handles.lock().await.clear();
        self.transfer_waiters.lock().await.clear();
        self.sensitive_operations.lock().await.clear();
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
    let Some(runtime) = &context.browser_automation else {
        return failure(id, BrowserAutomationErrorCode::CapabilityUnavailable);
    };
    match command {
        "browserAutomation.sessionCreate" => {
            runtime.session_create(id, params, context, caller_id).await
        }
        "browserAutomation.sessionList" => runtime.session_list(id, params, caller_id).await,
        "browserAutomation.sessionGet" => runtime.session_get(id, params, caller_id).await,
        "browserAutomation.sessionDestroy" => runtime.session_destroy(id, params, caller_id).await,
        "browserAutomation.operationInvoke" => {
            runtime.operation_invoke(id, params, caller_id).await
        }
        "browserAutomation.operationCancel" => {
            runtime.operation_cancel(id, params, caller_id).await
        }
        "browserAutomation.providerPoll" => runtime.provider_poll(id, params).await,
        "browserAutomation.providerAcknowledge" => runtime.provider_acknowledge(id, params).await,
        "browserAutomation.providerTransferRespond" => runtime.transfer_respond(id, params).await,
        "browserAutomation.screenshotRead" => runtime.screenshot_read(id, params, caller_id).await,
        "browserAutomation.screenshotRelease" => {
            runtime.screenshot_release(id, params, caller_id).await
        }
        _ => failure(id, BrowserAutomationErrorCode::CapabilityUnavailable),
    }
}

fn provider_fence(value: &ActionProviderReservation) -> BrowserAutomationProviderFence {
    BrowserAutomationProviderFence {
        provider_id: value.provider_id,
        provider_epoch: value.provider_epoch,
        provider_lease_id: value.provider_lease_id,
        window_id: value.window_id,
        window_generation: value.window_generation,
    }
}
fn identity_params(value: &ActionProviderReservation) -> DesktopProviderIdentityParams {
    identity_from_fence(&provider_fence(value))
}
fn action_target(value: &ActionProviderReservation) -> ActionInvocationTarget {
    target_from_fence(&provider_fence(value))
}
fn identity_from_fence(value: &BrowserAutomationProviderFence) -> DesktopProviderIdentityParams {
    DesktopProviderIdentityParams {
        provider_id: value.provider_id.to_string(),
        provider_epoch: value.provider_epoch,
        lease_id: value.provider_lease_id.to_string(),
    }
}
fn target_from_fence(value: &BrowserAutomationProviderFence) -> ActionInvocationTarget {
    ActionInvocationTarget {
        window_id: value.window_id.to_string(),
        window_generation: value.window_generation,
    }
}
fn fence_from_identity(
    identity: &DesktopProviderIdentityParams,
    target: &ActionInvocationTarget,
) -> BrowserAutomationProviderFence {
    BrowserAutomationProviderFence {
        provider_id: parse_uuid(&identity.provider_id),
        provider_epoch: identity.provider_epoch,
        provider_lease_id: parse_uuid(&identity.lease_id),
        window_id: parse_uuid(&target.window_id),
        window_generation: target.window_generation,
    }
}
fn fence_from_ack(
    params: &BrowserAutomationProviderAcknowledgeParams,
) -> BrowserAutomationProviderFence {
    fence_from_identity(&params.identity, &params.target)
}
fn target_record(value: &BrowserAutomationTargetBinding) -> BrowserAutomationTargetRecord {
    BrowserAutomationTargetRecord {
        workspace_id: parse_uuid(&value.workspace_id),
        pane_id: parse_uuid(&value.pane_id),
        tab_id: parse_uuid(&value.tab_id),
        browser_session_id: parse_uuid(&value.browser_session_id),
        browser_lifecycle_id: parse_uuid(&value.browser_lifecycle_id),
    }
}
fn mode_record(value: BrowserAutomationSessionMode) -> BrowserAutomationSessionModeRecord {
    match value {
        BrowserAutomationSessionMode::Ephemeral => BrowserAutomationSessionModeRecord::Ephemeral,
        BrowserAutomationSessionMode::Attach => BrowserAutomationSessionModeRecord::Attach,
    }
}
fn mode(value: BrowserAutomationSessionModeRecord) -> BrowserAutomationSessionMode {
    match value {
        BrowserAutomationSessionModeRecord::Ephemeral => BrowserAutomationSessionMode::Ephemeral,
        BrowserAutomationSessionModeRecord::Attach => BrowserAutomationSessionMode::Attach,
    }
}
fn session_state(value: BrowserAutomationSessionStateRecord) -> BrowserAutomationSessionState {
    match value {
        BrowserAutomationSessionStateRecord::Creating => BrowserAutomationSessionState::Creating,
        BrowserAutomationSessionStateRecord::Ready => BrowserAutomationSessionState::Ready,
        BrowserAutomationSessionStateRecord::Destroying => {
            BrowserAutomationSessionState::Destroying
        }
        BrowserAutomationSessionStateRecord::Destroyed => BrowserAutomationSessionState::Destroyed,
        BrowserAutomationSessionStateRecord::Failed => BrowserAutomationSessionState::Failed,
        BrowserAutomationSessionStateRecord::Expired => BrowserAutomationSessionState::Expired,
    }
}
fn session_snapshot(
    value: &BrowserAutomationSessionRecord,
) -> Option<BrowserAutomationSessionSnapshot> {
    let target = value.target.as_ref()?;
    let provider = value.provider.as_ref()?;
    Some(BrowserAutomationSessionSnapshot {
        automation_session_id: value.automation_session_id.to_string(),
        generation: value.generation,
        navigation_epoch: value.navigation_epoch,
        mode: mode(value.mode),
        state: session_state(value.state),
        profile_key: value.profile_key.clone(),
        target: BrowserAutomationTargetBinding {
            workspace_id: target.workspace_id.to_string(),
            pane_id: target.pane_id.to_string(),
            tab_id: target.tab_id.to_string(),
            browser_session_id: target.browser_session_id.to_string(),
            browser_lifecycle_id: target.browser_lifecycle_id.to_string(),
            window: target_from_fence(provider),
        },
        created_at_ms: u64_time(value.created_at_ms),
        updated_at_ms: u64_time(value.updated_at_ms),
        expires_at_ms: u64_time(value.expires_at_ms),
    })
}
fn session_result_response(
    id: String,
    record: &BrowserAutomationSessionRecord,
) -> ResponseEnvelope {
    match session_snapshot(record) {
        Some(session) => success(id, BrowserAutomationSessionResult { session }),
        None => failure(id, BrowserAutomationErrorCode::ResultExpired),
    }
}
fn session_create_result_response(
    id: String,
    record: &BrowserAutomationSessionRecord,
) -> ResponseEnvelope {
    if record.state != BrowserAutomationSessionStateRecord::Ready {
        return failure(id, BrowserAutomationErrorCode::Interrupted);
    }
    match session_snapshot(record) {
        Some(session) => success(id, BrowserAutomationSessionCreateResult { session }),
        None => failure(id, BrowserAutomationErrorCode::ResultExpired),
    }
}
fn operation_kind(value: &BrowserAutomationOperation) -> &'static str {
    match value {
        BrowserAutomationOperation::Navigate { .. } => "navigate",
        BrowserAutomationOperation::Wait { .. } => "wait",
        BrowserAutomationOperation::Query { .. } => "query",
        BrowserAutomationOperation::Focus { .. } => "focus",
        BrowserAutomationOperation::Click { .. } => "click",
        BrowserAutomationOperation::TypeText { .. } => "typeText",
        BrowserAutomationOperation::Key { .. } => "key",
        BrowserAutomationOperation::KeyAt { .. } => "keyAt",
        BrowserAutomationOperation::Screenshot { .. } => "screenshot",
    }
}
fn result_kind(value: &BrowserAutomationOperationResultData) -> &'static str {
    match value {
        BrowserAutomationOperationResultData::Empty => "empty",
        BrowserAutomationOperationResultData::Navigation { .. } => "navigation",
        BrowserAutomationOperationResultData::Query { .. } => "query",
        BrowserAutomationOperationResultData::Screenshot { .. } => "screenshot",
    }
}
fn result_matches_operation(kind: &str, result: &BrowserAutomationOperationResultData) -> bool {
    matches!(
        (kind, result),
        (
            "navigate",
            BrowserAutomationOperationResultData::Navigation { .. }
        ) | ("query", BrowserAutomationOperationResultData::Query { .. })
            | (
                "screenshot",
                BrowserAutomationOperationResultData::Screenshot { .. }
            )
            | (
                "wait" | "focus" | "click" | "typeText" | "key" | "keyAt",
                BrowserAutomationOperationResultData::Empty
            )
    )
}
fn operation_state(
    value: BrowserAutomationOperationStateRecord,
) -> BrowserAutomationOperationState {
    match value {
        BrowserAutomationOperationStateRecord::Queued => BrowserAutomationOperationState::Queued,
        BrowserAutomationOperationStateRecord::Running => BrowserAutomationOperationState::Running,
        BrowserAutomationOperationStateRecord::Succeeded => {
            BrowserAutomationOperationState::Succeeded
        }
        BrowserAutomationOperationStateRecord::Failed => BrowserAutomationOperationState::Failed,
        BrowserAutomationOperationStateRecord::Canceled => {
            BrowserAutomationOperationState::Canceled
        }
        BrowserAutomationOperationStateRecord::Expired => BrowserAutomationOperationState::Expired,
        BrowserAutomationOperationStateRecord::Interrupted => {
            BrowserAutomationOperationState::Interrupted
        }
        BrowserAutomationOperationStateRecord::ResultExpired => {
            BrowserAutomationOperationState::ResultExpired
        }
    }
}
fn terminal_state(
    state: BrowserAutomationOperationState,
    error: Option<BrowserAutomationErrorCode>,
) -> Result<
    (
        BrowserAutomationOperationStateRecord,
        Option<BrowserAutomationErrorCode>,
    ),
    BrowserAutomationErrorCode,
> {
    match state {
        BrowserAutomationOperationState::Succeeded if error.is_none() => {
            Ok((BrowserAutomationOperationStateRecord::Succeeded, None))
        }
        BrowserAutomationOperationState::Failed if error.is_some() => {
            Ok((BrowserAutomationOperationStateRecord::Failed, error))
        }
        BrowserAutomationOperationState::Canceled => Ok((
            BrowserAutomationOperationStateRecord::Canceled,
            Some(BrowserAutomationErrorCode::Canceled),
        )),
        BrowserAutomationOperationState::Expired => Ok((
            BrowserAutomationOperationStateRecord::Expired,
            Some(BrowserAutomationErrorCode::Timeout),
        )),
        BrowserAutomationOperationState::Interrupted => Ok((
            BrowserAutomationOperationStateRecord::Interrupted,
            Some(BrowserAutomationErrorCode::Interrupted),
        )),
        BrowserAutomationOperationState::ResultExpired => Ok((
            BrowserAutomationOperationStateRecord::ResultExpired,
            Some(BrowserAutomationErrorCode::ResultExpired),
        )),
        _ => Err(BrowserAutomationErrorCode::InvalidOperation),
    }
}
fn failed_ack_shape_matches(params: &BrowserAutomationProviderAcknowledgeParams) -> bool {
    matches!(
        params.state,
        BrowserAutomationOperationState::Failed
            | BrowserAutomationOperationState::Canceled
            | BrowserAutomationOperationState::Expired
            | BrowserAutomationOperationState::Interrupted
            | BrowserAutomationOperationState::ResultExpired
    ) && params.session.is_none()
        && params.result.is_none()
        && params.error_code.is_some()
}
fn execute_ack_shape_matches(params: &BrowserAutomationProviderAcknowledgeParams) -> bool {
    (params.state == BrowserAutomationOperationState::Succeeded
        && params.session.is_none()
        && params.result.is_some()
        && params.error_code.is_none())
        || failed_ack_shape_matches(params)
}
fn lifecycle_ack_shape_matches(
    lifecycle_state: BrowserAutomationSessionStateRecord,
    params: &BrowserAutomationProviderAcknowledgeParams,
) -> bool {
    match lifecycle_state {
        BrowserAutomationSessionStateRecord::Creating => {
            (params.state == BrowserAutomationOperationState::Succeeded
                && params.session.is_some()
                && params.result.is_none()
                && params.error_code.is_none())
                || failed_ack_shape_matches(params)
        }
        BrowserAutomationSessionStateRecord::Destroying => {
            (params.state == BrowserAutomationOperationState::Succeeded
                && params.session.is_none()
                && params.result.is_none()
                && params.error_code.is_none())
                || failed_ack_shape_matches(params)
        }
        BrowserAutomationSessionStateRecord::Ready
        | BrowserAutomationSessionStateRecord::Destroyed
        | BrowserAutomationSessionStateRecord::Failed
        | BrowserAutomationSessionStateRecord::Expired => false,
    }
}
fn session_ack_matches(
    record: &BrowserAutomationSessionRecord,
    snapshot: &BrowserAutomationSessionSnapshot,
    target: &ActionInvocationTarget,
) -> bool {
    snapshot.automation_session_id == record.automation_session_id.to_string()
        && snapshot.generation == record.generation
        && snapshot.navigation_epoch == record.navigation_epoch
        && snapshot.mode == mode(record.mode)
        && snapshot.profile_key == record.profile_key
        && snapshot.target.window == *target
        && record
            .target
            .as_ref()
            .is_none_or(|requested| requested == &target_record(&snapshot.target))
}
fn lifecycle_snapshot(
    record: &BrowserAutomationSessionRecord,
    state: BrowserAutomationOperationState,
    error: Option<BrowserAutomationErrorCode>,
) -> BrowserAutomationOperationSnapshot {
    BrowserAutomationOperationSnapshot {
        automation_session_id: record.automation_session_id.to_string(),
        session_generation: record.generation,
        operation_id: record.lifecycle_operation_id.to_string(),
        correlation_id: record.lifecycle_correlation_id.to_string(),
        attempt_epoch: record.lifecycle_attempt_epoch,
        navigation_epoch: record.navigation_epoch,
        state,
        result: (state == BrowserAutomationOperationState::Succeeded)
            .then_some(BrowserAutomationOperationResultData::Empty),
        error_code: error,
        updated_at_ms: u64_time(record.updated_at_ms),
    }
}
fn transfer_outcome_matches(
    outcome: &BrowserAutomationProviderTransferOutcome,
    handle_id: Uuid,
    expectation: &TransferExpectation,
) -> bool {
    match (expectation, outcome) {
        (
            TransferExpectation::ScreenshotRead {
                chunk_index,
                chunk_count,
                handle_expires_at_ms,
                sha256,
            },
            BrowserAutomationProviderTransferOutcome::ScreenshotRead { result },
        ) => {
            parse_uuid(&result.handle_id) == handle_id
                && result.chunk_index == *chunk_index
                && result.chunk_count == *chunk_count
                && result.expires_at_ms <= *handle_expires_at_ms
                && result.sha256 == *sha256
        }
        (
            TransferExpectation::ScreenshotRelease,
            BrowserAutomationProviderTransferOutcome::ScreenshotRelease { .. },
        )
        | (_, BrowserAutomationProviderTransferOutcome::Error { .. }) => true,
        _ => false,
    }
}
fn error_code_str(value: BrowserAutomationErrorCode) -> &'static str {
    match value {
        BrowserAutomationErrorCode::CapabilityUnavailable => "capability_unavailable",
        BrowserAutomationErrorCode::SessionNotFound => "session_not_found",
        BrowserAutomationErrorCode::SessionLimit => "session_limit",
        BrowserAutomationErrorCode::SessionExpired => "session_expired",
        BrowserAutomationErrorCode::SessionGenerationMismatch => "session_generation_mismatch",
        BrowserAutomationErrorCode::StaleNavigation => "stale_navigation",
        BrowserAutomationErrorCode::TargetRequired => "target_required",
        BrowserAutomationErrorCode::TargetNotFound => "target_not_found",
        BrowserAutomationErrorCode::TargetStale => "target_stale",
        BrowserAutomationErrorCode::ProviderUnavailable => "provider_unavailable",
        BrowserAutomationErrorCode::ProviderIneligible => "provider_ineligible",
        BrowserAutomationErrorCode::ProviderLeaseExpired => "provider_lease_expired",
        BrowserAutomationErrorCode::ProviderEpochMismatch => "provider_epoch_mismatch",
        BrowserAutomationErrorCode::AutomationBackpressure => "automation_backpressure",
        BrowserAutomationErrorCode::InvalidOperation => "invalid_operation",
        BrowserAutomationErrorCode::InvalidSelector => "invalid_selector",
        BrowserAutomationErrorCode::UnsafeUrl => "unsafe_url",
        BrowserAutomationErrorCode::PolicyDenied => "policy_denied",
        BrowserAutomationErrorCode::ResourceLimit => "resource_limit",
        BrowserAutomationErrorCode::Timeout => "timeout",
        BrowserAutomationErrorCode::Canceled => "canceled",
        BrowserAutomationErrorCode::Interrupted => "interrupted",
        BrowserAutomationErrorCode::ResultExpired => "result_expired",
        BrowserAutomationErrorCode::IdempotencyConflict => "idempotency_conflict",
        BrowserAutomationErrorCode::IdempotencyExpired => "idempotency_expired",
    }
}
fn parse_error_code(value: &str) -> Option<BrowserAutomationErrorCode> {
    [
        BrowserAutomationErrorCode::CapabilityUnavailable,
        BrowserAutomationErrorCode::SessionNotFound,
        BrowserAutomationErrorCode::SessionLimit,
        BrowserAutomationErrorCode::SessionExpired,
        BrowserAutomationErrorCode::SessionGenerationMismatch,
        BrowserAutomationErrorCode::StaleNavigation,
        BrowserAutomationErrorCode::TargetRequired,
        BrowserAutomationErrorCode::TargetNotFound,
        BrowserAutomationErrorCode::TargetStale,
        BrowserAutomationErrorCode::ProviderUnavailable,
        BrowserAutomationErrorCode::ProviderIneligible,
        BrowserAutomationErrorCode::ProviderLeaseExpired,
        BrowserAutomationErrorCode::ProviderEpochMismatch,
        BrowserAutomationErrorCode::AutomationBackpressure,
        BrowserAutomationErrorCode::InvalidOperation,
        BrowserAutomationErrorCode::InvalidSelector,
        BrowserAutomationErrorCode::UnsafeUrl,
        BrowserAutomationErrorCode::PolicyDenied,
        BrowserAutomationErrorCode::ResourceLimit,
        BrowserAutomationErrorCode::Timeout,
        BrowserAutomationErrorCode::Canceled,
        BrowserAutomationErrorCode::Interrupted,
        BrowserAutomationErrorCode::ResultExpired,
        BrowserAutomationErrorCode::IdempotencyConflict,
        BrowserAutomationErrorCode::IdempotencyExpired,
    ]
    .into_iter()
    .find(|code| error_code_str(*code) == value)
}
fn provider_failure(id: String, value: &str) -> ResponseEnvelope {
    let code = match value {
        "target_not_found" => BrowserAutomationErrorCode::TargetNotFound,
        "target_stale" => BrowserAutomationErrorCode::TargetStale,
        "provider_ineligible" => BrowserAutomationErrorCode::ProviderIneligible,
        "provider_lease_expired" => BrowserAutomationErrorCode::ProviderLeaseExpired,
        "provider_epoch_mismatch" => BrowserAutomationErrorCode::ProviderEpochMismatch,
        "provider_backpressure" => BrowserAutomationErrorCode::AutomationBackpressure,
        _ => BrowserAutomationErrorCode::ProviderUnavailable,
    };
    failure(id, code)
}
fn parse_uuid(value: &str) -> Uuid {
    Uuid::parse_str(value).expect("protocol validation guarantees UUID")
}
fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}
fn i64_now(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}
fn u64_time(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}
fn success(id: String, value: impl Serialize) -> ResponseEnvelope {
    ResponseEnvelope::success(
        id,
        serde_json::to_value(value).expect("protocol result serializes"),
    )
}
fn invalid_params(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "invalid_params",
        "Browser automation parameters are invalid",
    )
}
fn storage_failure(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "storage_unavailable",
        "Browser automation storage is unavailable",
    )
}
fn failure(id: String, code: BrowserAutomationErrorCode) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        error_code_str(code),
        "Browser automation request was rejected",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ActionInvocationTarget {
        ActionInvocationTarget {
            window_id: Uuid::new_v4().to_string(),
            window_generation: 1,
        }
    }

    fn session_record() -> BrowserAutomationSessionRecord {
        BrowserAutomationSessionRecord {
            automation_session_id: Uuid::new_v4(),
            caller_id: Uuid::new_v4(),
            profile_key: "profile".into(),
            mode: BrowserAutomationSessionModeRecord::Ephemeral,
            state: BrowserAutomationSessionStateRecord::Ready,
            generation: 1,
            navigation_epoch: 1,
            target: None,
            provider: Some(BrowserAutomationProviderFence {
                provider_id: Uuid::new_v4(),
                provider_epoch: 1,
                provider_lease_id: Uuid::new_v4(),
                window_id: Uuid::new_v4(),
                window_generation: 1,
            }),
            lifecycle_operation_id: Uuid::new_v4(),
            lifecycle_correlation_id: Uuid::new_v4(),
            lifecycle_attempt_epoch: 1,
            idempotency_epoch: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            request_digest: "0".repeat(64),
            created_at_ms: 1,
            updated_at_ms: 2,
            expires_at_ms: 3,
            terminal_at_ms: None,
        }
    }

    fn acknowledge(
        state: BrowserAutomationOperationState,
    ) -> BrowserAutomationProviderAcknowledgeParams {
        BrowserAutomationProviderAcknowledgeParams {
            identity: DesktopProviderIdentityParams {
                provider_id: Uuid::new_v4().to_string(),
                provider_epoch: 1,
                lease_id: Uuid::new_v4().to_string(),
            },
            target: target(),
            automation_session_id: Uuid::new_v4().to_string(),
            session_generation: 1,
            operation_id: Uuid::new_v4().to_string(),
            correlation_id: Uuid::new_v4().to_string(),
            attempt_epoch: 1,
            state,
            session: None,
            result: None,
            error_code: None,
        }
    }

    #[test]
    fn successful_lifecycle_snapshot_satisfies_operation_snapshot_contract() {
        let snapshot = lifecycle_snapshot(
            &session_record(),
            BrowserAutomationOperationState::Succeeded,
            None,
        );
        let value = serde_json::to_value(snapshot).unwrap();

        assert_eq!(value["state"], "succeeded");
        assert_eq!(value["result"], serde_json::json!({ "kind": "empty" }));
        assert!(value.get("errorCode").is_none());
    }

    #[test]
    fn provider_acknowledgement_shape_is_bound_to_request_kind() {
        let mut success = acknowledge(BrowserAutomationOperationState::Succeeded);
        assert!(lifecycle_ack_shape_matches(
            BrowserAutomationSessionStateRecord::Destroying,
            &success
        ));
        assert!(!lifecycle_ack_shape_matches(
            BrowserAutomationSessionStateRecord::Creating,
            &success
        ));
        assert!(!execute_ack_shape_matches(&success));

        success.result = Some(BrowserAutomationOperationResultData::Empty);
        assert!(execute_ack_shape_matches(&success));
        assert!(!lifecycle_ack_shape_matches(
            BrowserAutomationSessionStateRecord::Destroying,
            &success
        ));

        let mut failed = acknowledge(BrowserAutomationOperationState::Failed);
        failed.error_code = Some(BrowserAutomationErrorCode::Interrupted);
        assert!(execute_ack_shape_matches(&failed));
        assert!(lifecycle_ack_shape_matches(
            BrowserAutomationSessionStateRecord::Creating,
            &failed
        ));
    }

    #[test]
    fn screenshot_transfer_response_is_bound_to_registered_handle_and_chunk() {
        let handle_id = Uuid::new_v4();
        let expectation = TransferExpectation::ScreenshotRead {
            chunk_index: 2,
            chunk_count: 3,
            handle_expires_at_ms: 500,
            sha256: "a".repeat(64),
        };
        let mut outcome = BrowserAutomationProviderTransferOutcome::ScreenshotRead {
            result: agent_workspace_protocol::BrowserAutomationScreenshotReadResult {
                handle_id: handle_id.to_string(),
                chunk_index: 2,
                chunk_count: 3,
                data_base64: "AA==".into(),
                sha256: "a".repeat(64),
                expires_at_ms: 500,
            },
        };
        assert!(transfer_outcome_matches(&outcome, handle_id, &expectation));
        let BrowserAutomationProviderTransferOutcome::ScreenshotRead { result } = &mut outcome
        else {
            unreachable!()
        };
        result.chunk_index = 1;
        assert!(!transfer_outcome_matches(&outcome, handle_id, &expectation));
    }

    #[tokio::test]
    async fn socket_disconnect_preserves_sessions_for_the_next_authenticated_connection() {
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("state.sqlite3"),
                agent_workspace_core::ShortcutPlatform::NonMacOs,
            )
            .unwrap(),
        );
        let providers = MultiWindowRuntime::new(
            super::super::DesktopProviderBootstrapSecret::new([7_u8; 32]).unwrap(),
        );
        let token = b"stable-authenticated-control-profile";
        let connection_a = Uuid::new_v4();
        let first = BrowserAutomationRuntime::new(Arc::clone(&store), providers.clone(), token);
        let automation_session_id = Uuid::new_v4();
        let record = BrowserAutomationSessionCreateRecord {
            automation_session_id,
            caller_id: first.owner_id,
            profile_key: "persistent-profile".into(),
            mode: BrowserAutomationSessionModeRecord::Ephemeral,
            generation: 1,
            navigation_epoch: 1,
            target: None,
            provider: BrowserAutomationProviderFence {
                provider_id: Uuid::new_v4(),
                provider_epoch: 1,
                provider_lease_id: Uuid::new_v4(),
                window_id: Uuid::new_v4(),
                window_generation: 1,
            },
            lifecycle_operation_id: Uuid::new_v4(),
            lifecycle_correlation_id: Uuid::new_v4(),
            lifecycle_attempt_epoch: 1,
            idempotency_epoch: store.current_idempotency_epoch().unwrap(),
            idempotency_key: Uuid::new_v4(),
            request_digest: "a".repeat(64),
            created_at_ms: 1,
            expires_at_ms: i64::MAX,
        };
        assert!(matches!(
            store.create_browser_automation_session(&record).unwrap(),
            BrowserAutomationCreateOutcome::Created(_)
        ));

        first.cancel_caller(connection_a).await;

        let second = BrowserAutomationRuntime::new(Arc::clone(&store), providers, token);
        assert_eq!(first.owner_id, second.owner_id);
        let sessions = store
            .list_browser_automation_sessions(second.owner_id, 16)
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].automation_session_id, automation_session_id);
        assert_eq!(
            sessions[0].state,
            BrowserAutomationSessionStateRecord::Creating
        );
    }
}

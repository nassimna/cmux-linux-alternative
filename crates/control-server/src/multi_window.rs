#![allow(
    clippy::ignored_unit_patterns,
    clippy::manual_let_else,
    clippy::match_same_arms,
    clippy::single_match_else,
    clippy::struct_field_names,
    clippy::too_many_arguments,
    clippy::too_many_lines,
    clippy::unnested_or_patterns,
    clippy::unnecessary_min_or_max
)]

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::Write as _,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use agent_workspace_core::{
    ApplicationState, BrowserMetadata, CLOSED_ITEM_RETENTION_MS, ClosedItemId, ClosedItemRecord,
    DomainError, FocusTarget, HostingState, MutationOutcome, PaneId, RestoreDescriptor, Tab,
    TabContent, TabId, TerminalLaunchSpec, Timestamp, WindowId, WindowPlacement, WindowRehome,
    Workspace, WorkspaceId,
};
use agent_workspace_protocol::{
    ActionInvocationTarget, AdvancedTabCloseResult, AdvancedTabMutationResult,
    BrowserAutomationProviderPollResult, BrowserAutomationProviderRequest,
    BrowserOwnershipTransferDescriptor, CliWindowBindParams, ClosedItemGetParams,
    ClosedItemGetResult, ClosedItemListResult, ClosedItemSnapshot, DesktopActionExecutionRequest,
    DesktopActionPollResult, DesktopProviderAcknowledgeParams, DesktopProviderCancelParams,
    DesktopProviderCompletionStatus, DesktopProviderHeartbeatParams,
    DesktopProviderHeartbeatResult, DesktopProviderIdentityParams, DesktopProviderOperationKind,
    DesktopProviderPollParams, DesktopProviderPollResult, DesktopProviderRegisterParams,
    DesktopProviderRegistration, DesktopProviderRequest, DesktopProviderUnregisterParams,
    DesktopProviderWindowClaim, EmptyParams, EventEnvelope, ExactTabPlacement,
    FocusHistoryNavigateParams, FocusHistoryNavigateResult, FocusNavigationDirection,
    FocusTargetSnapshot, MAX_PROVIDER_QUEUE, MAX_PROVIDER_WINDOWS, MultiWindowChangeReason,
    MultiWindowChangedEvent, MultiWindowMutationToken, PROVIDER_HEARTBEAT_SECONDS,
    PROVIDER_LEASE_SECONDS, ResponseEnvelope, RuntimeOwnershipKind, TabCloseAdvancedParams,
    TabDetachParams, TabDuplicateParams, TabMoveExactParams, TabOwnershipTransferredEvent,
    TabPlacementSnapshot, TabReopenParams, TabSource, WindowBindParams, WindowBindResult,
    WindowCloseParams, WindowClosePolicy, WindowCloseResult, WindowCreateParams,
    WindowDefaultTabDestination, WindowFocusParams, WindowHostingState, WindowListResult,
    WindowMutationResult, WindowPlacementSnapshot, WindowStateGetForParams,
    WindowStateGetForResult, WindowStateSnapshot, WindowStateUpdateForParams, WorkspaceListResult,
};
use agent_workspace_runtime::{
    EpochIdempotentCommitResult, LaunchOptions, OperationFailure, ProductionWorkspaceRuntime,
    RuntimeError, StoreError, epoch_idempotency_ticket,
};
use agent_workspace_storage::{
    ActionInvocationRecord, ActionInvocationState as StoredActionState,
    ActionProviderRecoveryAcquireOutcome, ActionProviderRecoveryRecord, SqliteStateStore,
    StorageError, WindowState,
};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, Notify, oneshot};
use tracing::warn;
use uuid::Uuid;

use super::{ControlContext, DesktopProviderBootstrapSecret};

const PROVIDER_RECOVERY_SECONDS: u64 = 30;

pub(super) const COMMANDS: &[&str] = &[
    "window.list",
    "window.create",
    "window.close",
    "window.focus",
    "window.bind",
    "window.bindCli",
    "windowState.getFor",
    "windowState.updateFor",
    "closed.list",
    "closed.get",
    "focusHistory.navigate",
    "tab.duplicate",
    "tab.moveExact",
    "tab.detach",
    "tab.closeAdvanced",
    "tab.reopen",
    "desktopProvider.register",
    "desktopProvider.heartbeat",
    "desktopProvider.unregister",
    "desktopProvider.poll",
    "desktopProvider.acknowledge",
    "desktopProvider.cancel",
];

#[derive(Clone)]
pub(super) struct MultiWindowRuntime {
    bootstrap_proof: Arc<Mutex<Option<Vec<u8>>>>,
    providers: Arc<Mutex<ProviderRegistry>>,
    queue_changed: Arc<Notify>,
    recovery_store: Option<Arc<SqliteStateStore>>,
    service_owner_id: Uuid,
}

#[derive(Default)]
struct ProviderRegistry {
    next_registration_sequence: u64,
    instance_epochs: BTreeMap<Uuid, u64>,
    providers: BTreeMap<Uuid, ProviderLease>,
    recoverable_providers: BTreeMap<Uuid, RecoverableProvider>,
    reservations: BTreeMap<Uuid, ReservedProviderOperation>,
    action_reservations: BTreeMap<Uuid, ActionProviderReservation>,
    registration_retry: Option<RegistrationRetry>,
    completed_correlations: VecDeque<Uuid>,
}

struct RecoverableProvider {
    provider_id: Uuid,
    lease: ProviderLease,
    recover_until: Instant,
}

struct RegistrationRetry {
    instance_id: Uuid,
    claims: BTreeMap<WindowId, u64>,
    capabilities: BTreeSet<String>,
    proof_digest: [u8; 32],
    expires_at: Instant,
}

struct ReservedProviderOperation {
    provider_id: Uuid,
    request: DesktopProviderRequest,
    claim_preconditions: Vec<(WindowId, u64)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderReservation {
    Reserved(Vec<Uuid>),
    Existing,
}

#[derive(Clone)]
struct ReservedRecoverySaga {
    reservation: ProviderReservation,
    correlation_id: Uuid,
    target_windows: BTreeSet<WindowId>,
    requests: Vec<DesktopProviderRequest>,
}

struct ProviderLease {
    instance_id: Uuid,
    registration_sequence: u64,
    provider_epoch: u64,
    lease_id: Uuid,
    expires_at: Instant,
    claims: BTreeMap<WindowId, u64>,
    capabilities: BTreeSet<String>,
    registration_proof_digest: [u8; 32],
    queued: VecDeque<PendingProviderOperation>,
    in_flight: BTreeMap<Uuid, PendingProviderOperation>,
    action_queued: VecDeque<DesktopActionExecutionRequest>,
    action_in_flight: BTreeMap<Uuid, DesktopActionExecutionRequest>,
    completed_actions: VecDeque<DesktopActionExecutionRequest>,
    browser_queued: VecDeque<BrowserAutomationProviderRequest>,
    browser_in_flight: BTreeMap<Uuid, BrowserAutomationProviderRequest>,
    completed_browser_requests: VecDeque<BrowserAutomationProviderRequest>,
}

/// One exact provider/window reservation held while the invocation is durably created and leased.
#[derive(Clone)]
pub(super) struct ActionProviderReservation {
    pub reservation_id: Uuid,
    pub provider_id: Uuid,
    pub provider_epoch: u64,
    pub provider_lease_id: Uuid,
    pub attempt_epoch: u64,
    pub window_id: Uuid,
    pub window_generation: u64,
}

struct PendingProviderOperation {
    request: DesktopProviderRequest,
    completion: Option<oneshot::Sender<ProviderCompletion>>,
}

impl Drop for PendingProviderOperation {
    fn drop(&mut self) {
        if let Some(sender) = self.completion.take() {
            let _ = sender.send(ProviderCompletion::Canceled);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderCompletion {
    Succeeded,
    Failed(String),
    Canceled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct BoundWindow {
    pub window_id: WindowId,
    provider: Option<ProviderBinding>,
}

#[derive(Clone)]
pub(super) struct WindowEventScope {
    binding: Arc<Mutex<Option<BoundWindow>>>,
    control: MultiWindowRuntime,
    runtime: Arc<ProductionWorkspaceRuntime>,
}

impl WindowEventScope {
    pub(super) fn new(
        binding: Arc<Mutex<Option<BoundWindow>>>,
        control: MultiWindowRuntime,
        runtime: Arc<ProductionWorkspaceRuntime>,
    ) -> Self {
        Self {
            binding,
            control,
            runtime,
        }
    }

    async fn valid_binding(&self) -> Option<(BoundWindow, ApplicationState)> {
        let binding = *self.binding.lock().await;
        let binding = binding?;
        let state = self.runtime.snapshot().await;
        self.control.validate_binding(&state, binding).await.ok()?;
        Some((binding, state))
    }

    pub(super) async fn owns_workspace(&self, workspace_id: &str) -> bool {
        let Ok(workspace_id) = Uuid::parse_str(workspace_id).map(WorkspaceId::from_uuid) else {
            return false;
        };
        let Some((binding, state)) = self.valid_binding().await else {
            return false;
        };
        state
            .window_placement(binding.window_id)
            .is_some_and(|placement| placement.workspace_ids.contains(&workspace_id))
    }

    pub(super) async fn owns_runtime_session(&self, runtime_session_id: &str) -> bool {
        let Some((binding, state)) = self.valid_binding().await else {
            return false;
        };
        let Some(placement) = state.window_placement(binding.window_id) else {
            return false;
        };
        state.workspaces.iter().any(|workspace| {
            placement.workspace_ids.contains(&workspace.id)
                && workspace.tabs.values().any(|tab| {
                    tab.content
                        .runtime_session_id()
                        .is_some_and(|session_id| session_id.as_str() == runtime_session_id)
                })
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProviderBinding {
    provider_id: Uuid,
    provider_epoch: u64,
    generation: u64,
}

impl MultiWindowRuntime {
    pub(super) fn new(secret: DesktopProviderBootstrapSecret) -> Self {
        Self {
            bootstrap_proof: Arc::new(Mutex::new(Some(secret.0))),
            providers: Arc::new(Mutex::new(ProviderRegistry::default())),
            queue_changed: Arc::new(Notify::new()),
            recovery_store: None,
            service_owner_id: Uuid::new_v4(),
        }
    }

    pub(super) fn with_recovery_store(
        secret: DesktopProviderBootstrapSecret,
        recovery_store: Arc<SqliteStateStore>,
    ) -> Self {
        Self {
            recovery_store: Some(recovery_store),
            ..Self::new(secret)
        }
    }

    fn recovery_owner_valid(&self, provider_id: Uuid) -> bool {
        self.recovery_store.as_ref().is_none_or(|store| {
            store
                .action_provider_recovery_owner_valid(
                    provider_id,
                    self.service_owner_id,
                    wall_now_ms(),
                )
                .unwrap_or(false)
        })
    }

    fn delete_recovery(&self, provider_id: Uuid) -> bool {
        self.recovery_store.as_ref().is_none_or(|store| {
            store
                .delete_action_provider_recovery(provider_id, self.service_owner_id)
                .unwrap_or(false)
        })
    }

    pub(super) async fn register(
        &self,
        state: &ApplicationState,
        params: DesktopProviderRegisterParams,
    ) -> Result<DesktopProviderRegistration, ()> {
        let supplied = params.bootstrap_proof.as_bytes();
        let supplied_digest: [u8; 32] = Sha256::digest(supplied).into();
        let instance_id = parse_uuid(&params.instance_id).map_err(|_| ())?;
        let capabilities = params.capabilities.into_iter().collect::<BTreeSet<_>>();
        if !["window-host-v1", "tab-transfer-v1", "browser-transfer-v1"]
            .iter()
            .all(|capability| capabilities.contains(*capability))
        {
            return Err(());
        }
        let claims = parse_claims(state, &params.windows)?;
        let capability_claim_digest = capability_claim_digest(&capabilities, &claims);
        // The bootstrap proof and provider registry are always locked in this order. The proof is
        // consumed only in the same critical section that publishes the first successful lease.
        let mut bootstrap_proof = self.bootstrap_proof.lock().await;
        let mut providers = self.providers.lock().await;
        prune_expired(&mut providers);
        if let Some(provider_id) = providers
            .providers
            .iter()
            .find(|(_, provider)| provider.instance_id == instance_id)
            .map(|(provider_id, _)| *provider_id)
        {
            let active = providers
                .providers
                .get_mut(&provider_id)
                .expect("active provider was selected above");
            // Exact response-loss replay is the sole post-consumption registration exception. It
            // requires the same live instance, claims, capabilities, and constant-time proof
            // digest; it never changes provider identity or epoch.
            if active.claims == claims
                && active.capabilities == capabilities
                && active
                    .registration_proof_digest
                    .ct_eq(&supplied_digest)
                    .unwrap_u8()
                    == 1
                && self.recovery_owner_valid(provider_id)
            {
                let remaining = active.expires_at.saturating_duration_since(Instant::now());
                return Ok(DesktopProviderRegistration {
                    provider_id: provider_id.to_string(),
                    provider_epoch: active.provider_epoch,
                    lease_id: active.lease_id.to_string(),
                    lease_expires_at_ms: lease_expiry_ms(remaining.as_secs()),
                    registration_sequence: active.registration_sequence,
                    heartbeat_interval_ms: u32::try_from(PROVIDER_HEARTBEAT_SECONDS * 1_000)
                        .expect("heartbeat duration fits u32"),
                });
            }
            return Err(());
        }
        let recovery_matches = providers
            .recoverable_providers
            .get(&instance_id)
            .is_some_and(|recovery| {
                recovery.recover_until > Instant::now()
                    && recovery.lease.claims == claims
                    && recovery.lease.capabilities == capabilities
                    && recovery
                        .lease
                        .registration_proof_digest
                        .ct_eq(&supplied_digest)
                        .unwrap_u8()
                        == 1
            });
        if recovery_matches {
            if !providers.providers.is_empty() {
                return Err(());
            }
            let RecoverableProvider {
                provider_id,
                mut lease,
                ..
            } = providers
                .recoverable_providers
                .remove(&instance_id)
                .expect("exact recoverable provider was selected above");
            if !self.recovery_owner_valid(provider_id) {
                return Err(());
            }
            // Recovery is a single-use, proof-bound continuation of the old attempt. Preserving
            // every identity component lets a durable reverse request and its terminal ack retain
            // their exact provider/epoch/lease correlation across a provider process restart.
            lease.expires_at = Instant::now() + Duration::from_secs(PROVIDER_LEASE_SECONDS);
            let registration = DesktopProviderRegistration {
                provider_id: provider_id.to_string(),
                provider_epoch: lease.provider_epoch,
                lease_id: lease.lease_id.to_string(),
                lease_expires_at_ms: lease_expiry_ms(PROVIDER_LEASE_SECONDS),
                registration_sequence: lease.registration_sequence,
                heartbeat_interval_ms: u32::try_from(PROVIDER_HEARTBEAT_SECONDS * 1_000)
                    .expect("heartbeat duration fits u32"),
            };
            providers.providers.insert(provider_id, lease);
            return Ok(registration);
        }
        let initial_proof_matches = bootstrap_proof.as_ref().is_some_and(|expected| {
            expected.len() == supplied.len() && expected.ct_eq(supplied).unwrap_u8() == 1
        });
        let retry_matches = providers.registration_retry.as_ref().is_some_and(|retry| {
            retry.expires_at > Instant::now()
                && retry.instance_id == instance_id
                && retry.claims == claims
                && retry.capabilities == capabilities
                && retry.proof_digest.ct_eq(&supplied_digest).unwrap_u8() == 1
        });
        if !initial_proof_matches && !retry_matches {
            return Err(());
        }
        if initial_proof_matches && let Some(store) = &self.recovery_store {
            let now_ms = wall_now_ms();
            let recovered_until_ms = provider_recover_until_ms(now_ms);
            let acquired = store
                .acquire_action_provider_recovery(
                    instance_id,
                    &capability_claim_digest,
                    self.service_owner_id,
                    now_ms,
                    recovered_until_ms,
                )
                .map_err(|_| ())?;
            match acquired {
                ActionProviderRecoveryAcquireOutcome::Acquired {
                    provider,
                    invocations,
                } => {
                    if !providers.providers.is_empty() {
                        return Err(());
                    }
                    let lease = recovered_provider_lease(
                        &provider,
                        claims,
                        capabilities,
                        supplied_digest,
                        invocations,
                    )?;
                    providers.next_registration_sequence = providers
                        .next_registration_sequence
                        .max(provider.registration_sequence);
                    providers
                        .instance_epochs
                        .insert(instance_id, provider.provider_epoch);
                    providers.providers.insert(provider.provider_id, lease);
                    bootstrap_proof.take();
                    self.queue_changed.notify_waiters();
                    return Ok(DesktopProviderRegistration {
                        provider_id: provider.provider_id.to_string(),
                        provider_epoch: provider.provider_epoch,
                        lease_id: provider.lease_id.to_string(),
                        lease_expires_at_ms: lease_expiry_ms(PROVIDER_LEASE_SECONDS),
                        registration_sequence: provider.registration_sequence,
                        heartbeat_interval_ms: u32::try_from(PROVIDER_HEARTBEAT_SECONDS * 1_000)
                            .expect("heartbeat duration fits u32"),
                    });
                }
                ActionProviderRecoveryAcquireOutcome::Mismatch
                | ActionProviderRecoveryAcquireOutcome::Expired => return Err(()),
                ActionProviderRecoveryAcquireOutcome::Missing => {}
            }
        }
        if providers
            .providers
            .values()
            .any(|provider| provider.instance_id != instance_id)
        {
            return Err(());
        }
        providers.providers.clear();
        providers.next_registration_sequence =
            providers.next_registration_sequence.saturating_add(1);
        let registration_sequence = providers.next_registration_sequence;
        let provider_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let provider_epoch = providers
            .instance_epochs
            .get(&instance_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        providers
            .instance_epochs
            .insert(instance_id, provider_epoch);
        let expires_at = Instant::now() + Duration::from_secs(PROVIDER_LEASE_SECONDS);
        if let Some(store) = &self.recovery_store {
            let now_ms = wall_now_ms();
            let persisted = store
                .persist_action_provider_recovery(
                    &ActionProviderRecoveryRecord {
                        provider_id,
                        provider_instance_id: instance_id,
                        provider_epoch,
                        lease_id,
                        registration_sequence,
                        capability_claim_digest,
                        owner_service_id: self.service_owner_id,
                        recover_until_ms: provider_recover_until_ms(now_ms),
                    },
                    now_ms,
                )
                .map_err(|_| ())?;
            if !persisted {
                return Err(());
            }
        }
        providers.providers.insert(
            provider_id,
            ProviderLease {
                instance_id,
                registration_sequence,
                provider_epoch,
                lease_id,
                expires_at,
                claims,
                capabilities,
                registration_proof_digest: supplied_digest,
                queued: VecDeque::new(),
                in_flight: BTreeMap::new(),
                action_queued: VecDeque::new(),
                action_in_flight: BTreeMap::new(),
                completed_actions: VecDeque::new(),
                browser_queued: VecDeque::new(),
                browser_in_flight: BTreeMap::new(),
                completed_browser_requests: VecDeque::new(),
            },
        );
        providers.registration_retry = None;
        // Consumption happens after every validation and cannot race another successful
        // registration because the authorization lock is still held.
        if initial_proof_matches {
            bootstrap_proof.take();
        }
        Ok(DesktopProviderRegistration {
            provider_id: provider_id.to_string(),
            provider_epoch,
            lease_id: lease_id.to_string(),
            lease_expires_at_ms: lease_expiry_ms(PROVIDER_LEASE_SECONDS),
            registration_sequence,
            heartbeat_interval_ms: u32::try_from(PROVIDER_HEARTBEAT_SECONDS * 1_000)
                .expect("heartbeat duration fits u32"),
        })
    }

    pub(super) async fn heartbeat(
        &self,
        state: &ApplicationState,
        params: DesktopProviderHeartbeatParams,
    ) -> Result<DesktopProviderHeartbeatResult, &'static str> {
        let identity = ParsedIdentity::parse_fields(
            &params.provider_id,
            params.provider_epoch,
            &params.lease_id,
        )?;
        let claims = parse_claims(state, &params.windows).map_err(|()| "provider_ineligible")?;
        let mut providers = self.providers.lock().await;
        prune_expired(&mut providers);
        let lease = providers
            .providers
            .get_mut(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(lease, identity)?;
        if !self.recovery_owner_valid(identity.provider_id) {
            providers.providers.remove(&identity.provider_id);
            return Err("provider_epoch_mismatch");
        }
        if let Some(store) = &self.recovery_store {
            let now_ms = wall_now_ms();
            let persisted = store
                .persist_action_provider_recovery(
                    &ActionProviderRecoveryRecord {
                        provider_id: identity.provider_id,
                        provider_instance_id: lease.instance_id,
                        provider_epoch: lease.provider_epoch,
                        lease_id: lease.lease_id,
                        registration_sequence: lease.registration_sequence,
                        capability_claim_digest: capability_claim_digest(
                            &lease.capabilities,
                            &claims,
                        ),
                        owner_service_id: self.service_owner_id,
                        recover_until_ms: provider_recover_until_ms(now_ms),
                    },
                    now_ms,
                )
                .map_err(|_| "provider_unavailable")?;
            if !persisted {
                providers.providers.remove(&identity.provider_id);
                return Err("provider_epoch_mismatch");
            }
        }
        lease.claims = claims;
        lease.expires_at = Instant::now() + Duration::from_secs(PROVIDER_LEASE_SECONDS);
        Ok(DesktopProviderHeartbeatResult {
            lease_expires_at_ms: lease_expiry_ms(PROVIDER_LEASE_SECONDS),
        })
    }

    async fn unregister(
        &self,
        params: DesktopProviderUnregisterParams,
    ) -> Result<(), &'static str> {
        let identity = ParsedIdentity::parse(&params.identity)?;
        let mut providers = self.providers.lock().await;
        prune_expired(&mut providers);
        let lease = providers
            .providers
            .get(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(lease, identity)?;
        if !self.delete_recovery(identity.provider_id) {
            providers.providers.remove(&identity.provider_id);
            return Err("provider_epoch_mismatch");
        }
        providers.providers.remove(&identity.provider_id);
        providers
            .recoverable_providers
            .retain(|_, recovery| recovery.provider_id != identity.provider_id);
        providers.registration_retry = None;
        Ok(())
    }

    async fn revoke(&self, provider_id: Uuid) {
        let _ = self.delete_recovery(provider_id);
        let mut providers = self.providers.lock().await;
        providers.providers.remove(&provider_id);
        providers
            .recoverable_providers
            .retain(|_, recovery| recovery.provider_id != provider_id);
    }

    /// Roll back a provider created by a registration route whose downstream durable work failed.
    /// Only the exact same proof/instance/claims/capabilities may retry, and only for the bounded
    /// restart-recovery window.
    async fn revoke_registration(&self, provider_id: Uuid) {
        let _ = self.delete_recovery(provider_id);
        let mut providers = self.providers.lock().await;
        if let Some(provider) = providers.providers.remove(&provider_id) {
            providers.registration_retry = Some(RegistrationRetry {
                instance_id: provider.instance_id,
                claims: provider.claims,
                capabilities: provider.capabilities,
                proof_digest: provider.registration_proof_digest,
                expires_at: Instant::now() + Duration::from_secs(30),
            });
        }
    }

    /// Reserve one slot in the authoritative provider queue for a desktop-owned action.
    ///
    /// The core snapshot exposes only the currently focused window, not exact focus timestamps.
    /// Untargeted selection therefore prefers that deterministic focused window and then the
    /// provider registration sequence, as permitted by ADR 0008's fallback rule.
    pub(super) async fn action_reserve(
        &self,
        state: &ApplicationState,
        required_capability: &str,
        target: Option<&ActionInvocationTarget>,
    ) -> Result<ActionProviderReservation, &'static str> {
        let explicit = target
            .map(|target| {
                parse_window_id(&target.window_id)
                    .map(|window_id| (window_id, target.window_generation))
                    .map_err(|()| "target_not_found")
            })
            .transpose()?;
        if explicit.is_some_and(|(window_id, _)| state.window_placement(window_id).is_none()) {
            return Err("target_not_found");
        }

        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let target_is_stale = explicit.is_some_and(|(window_id, generation)| {
            registry.providers.values().any(|provider| {
                provider.capabilities.contains(required_capability)
                    && provider
                        .claims
                        .get(&window_id)
                        .is_some_and(|claimed| *claimed != generation)
            })
        });
        let selected = registry
            .providers
            .iter()
            .filter(|(_, provider)| provider.capabilities.contains(required_capability))
            .filter_map(|(provider_id, provider)| {
                let claim = if let Some((window_id, generation)) = explicit {
                    (provider.claims.get(&window_id).copied() == Some(generation))
                        .then_some((window_id, generation))
                } else if let Some(generation) = provider.claims.get(&state.focused_window_id) {
                    Some((state.focused_window_id, *generation))
                } else {
                    provider
                        .claims
                        .iter()
                        .find(|(window_id, _)| state.window_placement(**window_id).is_some())
                        .map(|(window_id, generation)| (*window_id, *generation))
                }?;
                let focused = claim.0 == state.focused_window_id;
                Some((
                    (focused, provider.registration_sequence),
                    *provider_id,
                    claim,
                ))
            })
            .max_by_key(|(priority, _, _)| *priority)
            .map(|(_, provider_id, claim)| (provider_id, claim))
            .ok_or(if target_is_stale {
                "target_stale"
            } else if explicit.is_some() {
                "provider_ineligible"
            } else {
                "provider_unavailable"
            })?;
        let (provider_id, (window_id, window_generation)) = selected;
        if !self.recovery_owner_valid(provider_id) {
            registry.providers.remove(&provider_id);
            return Err("provider_unavailable");
        }
        let transfer_reserved = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count();
        let action_reserved = registry
            .action_reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count();
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected action provider remains registered");
        let load = provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(provider.browser_queued.len())
            .saturating_add(provider.browser_in_flight.len())
            .saturating_add(transfer_reserved)
            .saturating_add(action_reserved);
        if load >= MAX_PROVIDER_QUEUE {
            return Err("provider_backpressure");
        }
        let reservation = ActionProviderReservation {
            reservation_id: Uuid::new_v4(),
            provider_id,
            provider_epoch: provider.provider_epoch,
            provider_lease_id: provider.lease_id,
            attempt_epoch: provider.provider_epoch,
            window_id: window_id.as_uuid(),
            window_generation,
        };
        registry
            .action_reservations
            .insert(reservation.reservation_id, reservation.clone());
        Ok(reservation)
    }

    pub(super) async fn action_abort_reservation(&self, reservation_id: Uuid) {
        self.providers
            .lock()
            .await
            .action_reservations
            .remove(&reservation_id);
    }

    /// Atomically converts a reserved slot into a visible reverse request.
    pub(super) async fn action_publish(
        &self,
        reservation: &ActionProviderReservation,
        request: DesktopActionExecutionRequest,
    ) -> Result<(), &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let Some(stored) = registry
            .action_reservations
            .remove(&reservation.reservation_id)
        else {
            return Err("provider_unavailable");
        };
        if stored.provider_id != reservation.provider_id
            || stored.provider_epoch != reservation.provider_epoch
            || stored.provider_lease_id != reservation.provider_lease_id
            || stored.window_id != reservation.window_id
            || stored.window_generation != reservation.window_generation
        {
            return Err("provider_epoch_mismatch");
        }
        if !self.recovery_owner_valid(reservation.provider_id) {
            registry.providers.remove(&reservation.provider_id);
            return Err("provider_epoch_mismatch");
        }
        let provider = registry
            .providers
            .get_mut(&reservation.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(
            provider,
            ParsedIdentity {
                provider_id: reservation.provider_id,
                provider_epoch: reservation.provider_epoch,
                lease_id: reservation.provider_lease_id,
            },
        )?;
        let target_window = WindowId::from_uuid(reservation.window_id);
        if provider.claims.get(&target_window).copied() != Some(reservation.window_generation)
            || request.identity.provider_id != reservation.provider_id.to_string()
            || request.identity.provider_epoch != reservation.provider_epoch
            || request.identity.lease_id != reservation.provider_lease_id.to_string()
            || request.attempt_epoch != reservation.attempt_epoch
            || request.target.window_id != reservation.window_id.to_string()
            || request.target.window_generation != reservation.window_generation
        {
            return Err("provider_epoch_mismatch");
        }
        provider.action_queued.push_back(request);
        drop(registry);
        self.queue_changed.notify_waiters();
        Ok(())
    }

    pub(super) async fn action_poll(
        &self,
        identity_params: &DesktopProviderIdentityParams,
        timeout_ms: u32,
    ) -> Result<DesktopActionPollResult, &'static str> {
        let identity = ParsedIdentity::parse(identity_params)?;
        let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
        loop {
            if !self.recovery_owner_valid(identity.provider_id) {
                self.providers
                    .lock()
                    .await
                    .providers
                    .remove(&identity.provider_id);
                return Err("provider_epoch_mismatch");
            }
            let notified = self.queue_changed.notified();
            {
                let mut registry = self.providers.lock().await;
                prune_expired(&mut registry);
                let provider = registry
                    .providers
                    .get_mut(&identity.provider_id)
                    .ok_or("provider_lease_expired")?;
                require_identity(provider, identity)?;
                if let Some(request) = provider.action_in_flight.values().next() {
                    return Ok(DesktopActionPollResult {
                        request: Some(request.clone()),
                    });
                }
                if let Some(request) = provider.action_queued.pop_front() {
                    let invocation_id = parse_uuid(&request.invocation_id)
                        .expect("service-issued action invocation ID is a UUID");
                    provider
                        .action_in_flight
                        .insert(invocation_id, request.clone());
                    return Ok(DesktopActionPollResult {
                        request: Some(request),
                    });
                }
            }
            let now = Instant::now();
            if now >= deadline
                || tokio::time::timeout(deadline.saturating_duration_since(now), notified)
                    .await
                    .is_err()
            {
                return Ok(DesktopActionPollResult { request: None });
            }
        }
    }

    pub(super) async fn action_provider_identity_valid(
        &self,
        identity_params: &DesktopProviderIdentityParams,
        target: &ActionInvocationTarget,
    ) -> Result<(), &'static str> {
        let identity = ParsedIdentity::parse(identity_params)?;
        if !self.recovery_owner_valid(identity.provider_id) {
            self.providers
                .lock()
                .await
                .providers
                .remove(&identity.provider_id);
            return Err("provider_epoch_mismatch");
        }
        let window_id = parse_window_id(&target.window_id).map_err(|()| "target_not_found")?;
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider = registry
            .providers
            .get(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(provider, identity)?;
        match provider.claims.get(&window_id).copied() {
            Some(generation) if generation == target.window_generation => Ok(()),
            Some(_) => Err("target_stale"),
            None => Err("provider_ineligible"),
        }
    }

    /// Validates the provider lease without requiring the target claim to remain present. Failed
    /// and canceled acknowledgements must remain possible precisely when a target disappears or
    /// advances generation after start was granted.
    pub(super) async fn action_provider_lease_valid(
        &self,
        identity_params: &DesktopProviderIdentityParams,
    ) -> Result<(), &'static str> {
        let identity = ParsedIdentity::parse(identity_params)?;
        if !self.recovery_owner_valid(identity.provider_id) {
            self.providers
                .lock()
                .await
                .providers
                .remove(&identity.provider_id);
            return Err("provider_epoch_mismatch");
        }
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider = registry
            .providers
            .get(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(provider, identity)
    }

    /// Authorize a start claim only after the exact reverse request was polled, or after a
    /// cancel-winning race moved that same request into the bounded completed cache.
    pub(super) async fn action_request_matches(
        &self,
        identity_params: &DesktopProviderIdentityParams,
        invocation_id: Uuid,
        correlation_id: Uuid,
        attempt_epoch: u64,
        action_id: &str,
        action_version: u32,
        target: &ActionInvocationTarget,
    ) -> Result<(), &'static str> {
        self.action_provider_identity_valid(identity_params, target)
            .await?;
        let identity = ParsedIdentity::parse(identity_params)?;
        let registry = self.providers.lock().await;
        let provider = registry
            .providers
            .get(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        let request = provider
            .action_in_flight
            .get(&invocation_id)
            .or_else(|| {
                provider
                    .completed_actions
                    .iter()
                    .find(|request| request.invocation_id == invocation_id.to_string())
            })
            .ok_or("correlation_mismatch")?;
        if request.correlation_id != correlation_id.to_string()
            || request.attempt_epoch != attempt_epoch
            || request.action_id != action_id
            || request.action_version != action_version
            || request.target != *target
        {
            return Err("correlation_mismatch");
        }
        Ok(())
    }

    pub(super) async fn action_finalize(&self, provider_id: Uuid, invocation_id: Uuid) {
        let mut registry = self.providers.lock().await;
        let Some(provider) = registry.providers.get_mut(&provider_id) else {
            return;
        };
        if let Some(request) = provider.action_in_flight.remove(&invocation_id) {
            provider.completed_actions.push_back(request);
            while provider.completed_actions.len() > 4_096 {
                provider.completed_actions.pop_front();
            }
        }
    }

    pub(super) async fn action_cancel_queued(
        &self,
        provider_id: Uuid,
        invocation_id: Uuid,
    ) -> Result<(), &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider = registry
            .providers
            .get_mut(&provider_id)
            .ok_or("provider_lease_expired")?;
        if let Some(index) = provider
            .action_queued
            .iter()
            .position(|request| request.invocation_id == invocation_id.to_string())
        {
            if let Some(request) = provider.action_queued.remove(index) {
                provider.completed_actions.push_back(request);
            }
            while provider.completed_actions.len() > 4_096 {
                provider.completed_actions.pop_front();
            }
            return Ok(());
        }
        if let Some(request) = provider.action_in_flight.remove(&invocation_id) {
            provider.completed_actions.push_back(request);
        }
        while provider.completed_actions.len() > 4_096 {
            provider.completed_actions.pop_front();
        }
        Ok(())
    }

    /// Atomically converts an action-style provider reservation into a browser-automation reverse
    /// request. Sensitive request fields remain only in this bounded in-memory queue.
    pub(super) async fn browser_publish(
        &self,
        reservation: &ActionProviderReservation,
        request_id: Uuid,
        request: BrowserAutomationProviderRequest,
    ) -> Result<(), &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let Some(stored) = registry
            .action_reservations
            .remove(&reservation.reservation_id)
        else {
            return Err("provider_unavailable");
        };
        if stored.provider_id != reservation.provider_id
            || stored.provider_epoch != reservation.provider_epoch
            || stored.provider_lease_id != reservation.provider_lease_id
            || stored.window_id != reservation.window_id
            || stored.window_generation != reservation.window_generation
        {
            return Err("provider_epoch_mismatch");
        }
        if !self.recovery_owner_valid(reservation.provider_id) {
            registry.providers.remove(&reservation.provider_id);
            return Err("provider_epoch_mismatch");
        }
        let provider = registry
            .providers
            .get_mut(&reservation.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(
            provider,
            ParsedIdentity {
                provider_id: reservation.provider_id,
                provider_epoch: reservation.provider_epoch,
                lease_id: reservation.provider_lease_id,
            },
        )?;
        if provider
            .browser_queued
            .iter()
            .chain(provider.browser_in_flight.values())
            .any(|existing| browser_request_id(existing) == request_id)
        {
            return Err("correlation_mismatch");
        }
        let target = browser_request_target(&request);
        let identity = browser_request_identity(&request);
        if identity.provider_id != reservation.provider_id.to_string()
            || identity.provider_epoch != reservation.provider_epoch
            || identity.lease_id != reservation.provider_lease_id.to_string()
            || target.window_id != reservation.window_id.to_string()
            || target.window_generation != reservation.window_generation
        {
            return Err("provider_epoch_mismatch");
        }
        provider.browser_queued.push_back(request);
        drop(registry);
        self.queue_changed.notify_waiters();
        Ok(())
    }

    /// Publish against an already durable exact provider/window fence. This path is used after
    /// session creation, where provider arbitration must never select a different owner.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn browser_publish_bound(
        &self,
        provider_id: Uuid,
        provider_epoch: u64,
        provider_lease_id: Uuid,
        window_id: Uuid,
        window_generation: u64,
        request_id: Uuid,
        request: BrowserAutomationProviderRequest,
    ) -> Result<(), &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        if !self.recovery_owner_valid(provider_id) {
            registry.providers.remove(&provider_id);
            return Err("provider_epoch_mismatch");
        }
        let provider = registry
            .providers
            .get_mut(&provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(
            provider,
            ParsedIdentity {
                provider_id,
                provider_epoch,
                lease_id: provider_lease_id,
            },
        )?;
        if provider
            .claims
            .get(&WindowId::from_uuid(window_id))
            .copied()
            != Some(window_generation)
        {
            return Err("target_stale");
        }
        if provider
            .browser_queued
            .iter()
            .chain(provider.browser_in_flight.values())
            .any(|existing| browser_request_id(existing) == request_id)
        {
            return Err("correlation_mismatch");
        }
        if provider
            .browser_queued
            .len()
            .saturating_add(provider.browser_in_flight.len())
            >= MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let identity = browser_request_identity(&request);
        let target = browser_request_target(&request);
        if identity.provider_id != provider_id.to_string()
            || identity.provider_epoch != provider_epoch
            || identity.lease_id != provider_lease_id.to_string()
            || target.window_id != window_id.to_string()
            || target.window_generation != window_generation
        {
            return Err("provider_epoch_mismatch");
        }
        provider.browser_queued.push_back(request);
        drop(registry);
        self.queue_changed.notify_waiters();
        Ok(())
    }

    pub(super) async fn browser_poll(
        &self,
        identity_params: &DesktopProviderIdentityParams,
        timeout_ms: u32,
    ) -> Result<BrowserAutomationProviderPollResult, &'static str> {
        let identity = ParsedIdentity::parse(identity_params)?;
        let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
        loop {
            if !self.recovery_owner_valid(identity.provider_id) {
                self.providers
                    .lock()
                    .await
                    .providers
                    .remove(&identity.provider_id);
                return Err("provider_epoch_mismatch");
            }
            let notified = self.queue_changed.notified();
            {
                let mut registry = self.providers.lock().await;
                prune_expired(&mut registry);
                let provider = registry
                    .providers
                    .get_mut(&identity.provider_id)
                    .ok_or("provider_lease_expired")?;
                require_identity(provider, identity)?;
                if let Some(request) = provider.browser_queued.pop_front() {
                    provider
                        .browser_in_flight
                        .insert(browser_request_id(&request), request.clone());
                    return Ok(BrowserAutomationProviderPollResult {
                        request: Some(request),
                    });
                }
            }
            let now = Instant::now();
            if now >= deadline
                || tokio::time::timeout(deadline.saturating_duration_since(now), notified)
                    .await
                    .is_err()
            {
                return Ok(BrowserAutomationProviderPollResult { request: None });
            }
        }
    }

    pub(super) async fn browser_request_matches(
        &self,
        identity_params: &DesktopProviderIdentityParams,
        target: &ActionInvocationTarget,
        request_id: Uuid,
        correlation_id: Uuid,
    ) -> Result<(), &'static str> {
        self.action_provider_identity_valid(identity_params, target)
            .await?;
        let identity = ParsedIdentity::parse(identity_params)?;
        let registry = self.providers.lock().await;
        let provider = registry
            .providers
            .get(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        let request = provider
            .browser_in_flight
            .get(&request_id)
            .or_else(|| {
                provider
                    .completed_browser_requests
                    .iter()
                    .find(|request| browser_request_id(request) == request_id)
            })
            .ok_or("correlation_mismatch")?;
        if browser_request_correlation(request) != correlation_id
            || browser_request_target(request) != target
        {
            return Err("correlation_mismatch");
        }
        Ok(())
    }

    pub(super) async fn browser_finalize(&self, provider_id: Uuid, request_id: Uuid) {
        let mut registry = self.providers.lock().await;
        let Some(provider) = registry.providers.get_mut(&provider_id) else {
            return;
        };
        if let Some(request) = provider.browser_in_flight.remove(&request_id) {
            provider.completed_browser_requests.push_back(request);
            while provider.completed_browser_requests.len() > 4_096 {
                provider.completed_browser_requests.pop_front();
            }
        }
    }

    pub(super) async fn browser_defer(&self, provider_id: Uuid, request_id: Uuid) {
        let mut registry = self.providers.lock().await;
        let Some(provider) = registry.providers.get_mut(&provider_id) else {
            return;
        };
        if let Some(request) = provider.browser_in_flight.remove(&request_id) {
            provider.browser_queued.push_front(request);
        }
    }

    pub(super) async fn browser_cancel(
        &self,
        provider_id: Uuid,
        request_id: Uuid,
    ) -> Result<(), &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider = registry
            .providers
            .get_mut(&provider_id)
            .ok_or("provider_lease_expired")?;
        if let Some(index) = provider
            .browser_queued
            .iter()
            .position(|request| browser_request_id(request) == request_id)
            && let Some(request) = provider.browser_queued.remove(index)
        {
            provider.completed_browser_requests.push_back(request);
        }
        if let Some(request) = provider.browser_in_flight.remove(&request_id) {
            provider.completed_browser_requests.push_back(request);
        }
        while provider.completed_browser_requests.len() > 4_096 {
            provider.completed_browser_requests.pop_front();
        }
        Ok(())
    }

    pub(super) async fn browser_cancel_session_requests(
        &self,
        provider_id: Uuid,
        automation_session_id: Uuid,
    ) {
        let mut registry = self.providers.lock().await;
        let Some(provider) = registry.providers.get_mut(&provider_id) else {
            return;
        };
        let session_id = automation_session_id.to_string();
        let mut retained = VecDeque::with_capacity(provider.browser_queued.len());
        while let Some(request) = provider.browser_queued.pop_front() {
            if browser_request_session_id(&request) == session_id {
                provider.completed_browser_requests.push_back(request);
            } else {
                retained.push_back(request);
            }
        }
        provider.browser_queued = retained;
        let request_ids: Vec<_> = provider
            .browser_in_flight
            .iter()
            .filter_map(|(request_id, request)| {
                (browser_request_session_id(request) == session_id).then_some(*request_id)
            })
            .collect();
        for request_id in request_ids {
            if let Some(request) = provider.browser_in_flight.remove(&request_id) {
                provider.completed_browser_requests.push_back(request);
            }
        }
        while provider.completed_browser_requests.len() > 4_096 {
            provider.completed_browser_requests.pop_front();
        }
    }

    pub(super) async fn action_identity_is_active(
        &self,
        provider_id: Uuid,
        provider_epoch: u64,
        lease_id: Uuid,
        window_id: Uuid,
        window_generation: u64,
    ) -> bool {
        if !self.recovery_owner_valid(provider_id) {
            self.providers.lock().await.providers.remove(&provider_id);
            return false;
        }
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        registry
            .providers
            .get(&provider_id)
            .is_some_and(|provider| {
                provider.provider_epoch == provider_epoch
                    && provider.lease_id == lease_id
                    && provider
                        .claims
                        .get(&WindowId::from_uuid(window_id))
                        .copied()
                        == Some(window_generation)
            })
    }

    async fn enqueue(
        &self,
        operation: DesktopProviderOperationKind,
        target: DesktopProviderWindowClaim,
        correlation_id: Uuid,
        tab_id: Option<String>,
        runtime_session_id: Option<String>,
        transfer_epoch: Option<u64>,
    ) -> Result<oneshot::Receiver<ProviderCompletion>, &'static str> {
        let target_window = parse_window_id(&target.window_id).map_err(|_| "target_not_found")?;
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            let (sender, receiver) = oneshot::channel();
            drop(sender);
            return Ok(receiver);
        }
        let required_capability = match operation {
            DesktopProviderOperationKind::CreateWindow
            | DesktopProviderOperationKind::CloseWindow
            | DesktopProviderOperationKind::FocusWindow => "window-host-v1",
            DesktopProviderOperationKind::AttachOwnership
            | DesktopProviderOperationKind::DetachOwnership
            | DesktopProviderOperationKind::RecoverOwnership => "tab-transfer-v1",
        };
        let provider_id = registry
            .providers
            .iter()
            .filter(|(_, provider)| provider.capabilities.contains(required_capability))
            .filter(|(_, provider)| {
                matches!(operation, DesktopProviderOperationKind::CreateWindow)
                    || provider.claims.get(&target_window).copied() == Some(target.generation)
            })
            .max_by_key(|(_, provider)| provider.registration_sequence)
            .map(|(provider_id, _)| *provider_id)
            .ok_or("provider_unavailable")?;
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        let provider = registry
            .providers
            .get_mut(&provider_id)
            .expect("selected provider remains registered");
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            >= MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let request_id = Uuid::new_v4();
        let request = DesktopProviderRequest {
            request_id: request_id.to_string(),
            correlation_id: correlation,
            attempt_epoch: provider.provider_epoch,
            operation,
            target,
            source: None,
            tab_id,
            runtime_session_id,
            transfer_epoch,
            workspace_id: None,
            pane_id: None,
            ownership_kind: None,
            browser: None,
        };
        let (completion, receiver) = oneshot::channel();
        provider.queued.push_back(PendingProviderOperation {
            request,
            completion: Some(completion),
        });
        drop(registry);
        self.queue_changed.notify_waiters();
        Ok(receiver)
    }

    /// Reserves provider eligibility and bounded queue capacity before a
    /// durable topology mutation. Publishing is a separate post-commit step.
    async fn reserve_window_operation(
        &self,
        operation: DesktopProviderOperationKind,
        target_window: WindowId,
        create_generation: Option<u64>,
        correlation_id: Uuid,
    ) -> Result<ProviderReservation, &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry
                .reservations
                .values()
                .any(|reserved| reserved.request.correlation_id == correlation)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            return Ok(ProviderReservation::Existing);
        }
        let provider_id = registry
            .providers
            .iter()
            .filter(|(_, provider)| provider.capabilities.contains("window-host-v1"))
            .filter(|(_, provider)| {
                operation == DesktopProviderOperationKind::CreateWindow
                    || provider.claims.contains_key(&target_window)
            })
            .max_by_key(|(_, provider)| provider.registration_sequence)
            .map(|(provider_id, _)| *provider_id)
            .ok_or("provider_unavailable")?;
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected provider remains registered");
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            >= MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let generation = create_generation
            .or_else(|| provider.claims.get(&target_window).copied())
            .ok_or("provider_ineligible")?;
        let attempt_epoch = provider.provider_epoch;
        let reservation_id = Uuid::new_v4();
        registry.reservations.insert(
            reservation_id,
            ReservedProviderOperation {
                provider_id,
                claim_preconditions: (operation != DesktopProviderOperationKind::CreateWindow)
                    .then_some(vec![(target_window, generation)])
                    .unwrap_or_default(),
                request: DesktopProviderRequest {
                    request_id: Uuid::new_v4().to_string(),
                    correlation_id: correlation,
                    attempt_epoch,
                    operation,
                    target: DesktopProviderWindowClaim {
                        window_id: target_window.to_string(),
                        generation,
                    },
                    source: None,
                    tab_id: None,
                    runtime_session_id: None,
                    transfer_epoch: None,
                    workspace_id: None,
                    pane_id: None,
                    ownership_kind: None,
                    browser: None,
                },
            },
        );
        Ok(ProviderReservation::Reserved(vec![reservation_id]))
    }

    /// Reserves the complete native ownership plan for moving one existing
    /// workspace into a newly-created placement. The reservation is assembled
    /// before the durable mutation, including bounded capacity for every
    /// resource and an optional final source-window close.
    async fn reserve_workspace_window_create(
        &self,
        state: &ApplicationState,
        source_window: WindowId,
        target_window: WindowId,
        workspace_id: WorkspaceId,
        correlation_id: Uuid,
        transfer_epoch: u64,
    ) -> Result<ProviderReservation, &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry
                .reservations
                .values()
                .any(|reserved| reserved.request.correlation_id == correlation)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            return Ok(ProviderReservation::Existing);
        }

        let source = state
            .window_placement(source_window)
            .filter(|placement| placement.workspace_ids.contains(&workspace_id))
            .ok_or("source_not_found")?;
        let workspace = state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or("source_not_found")?;
        let close_source = source.workspace_ids.len() == 1;
        let mut resources = Vec::with_capacity(workspace.tabs.len());
        for tab in workspace.tabs.values() {
            let (runtime_session_id, ownership_kind, mut browser) =
                ownership_transfer_resource(tab)?;
            if let Some(browser) = &mut browser {
                browser.lifecycle_id = Uuid::new_v4().to_string();
            }
            resources.push((
                tab.id,
                tab.pane_id,
                runtime_session_id,
                ownership_kind,
                browser,
            ));
        }

        let required = 1_usize
            .saturating_add(resources.len().saturating_mul(2))
            .saturating_add(usize::from(close_source));
        let provider_id = registry
            .providers
            .iter()
            .filter(|(_, provider)| {
                ["window-host-v1", "tab-transfer-v1", "browser-transfer-v1"]
                    .iter()
                    .all(|capability| provider.capabilities.contains(*capability))
                    && provider.claims.contains_key(&source_window)
            })
            .max_by_key(|(_, provider)| provider.registration_sequence)
            .map(|(provider_id, _)| *provider_id)
            .ok_or("provider_ineligible")?;
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected provider remains registered");
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            .saturating_add(required)
            > MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let attempt_epoch = provider.provider_epoch;
        let source_generation = provider.claims[&source_window];
        let claim_preconditions = vec![(source_window, source_generation)];
        let mut requests = Vec::with_capacity(required);
        requests.push(DesktopProviderRequest {
            request_id: Uuid::new_v4().to_string(),
            correlation_id: correlation.clone(),
            attempt_epoch,
            operation: DesktopProviderOperationKind::CreateWindow,
            target: DesktopProviderWindowClaim {
                window_id: target_window.to_string(),
                generation: 1,
            },
            source: None,
            tab_id: None,
            runtime_session_id: None,
            transfer_epoch: None,
            workspace_id: None,
            pane_id: None,
            ownership_kind: None,
            browser: None,
        });
        for (tab_id, pane_id, runtime_session_id, ownership_kind, browser) in resources {
            for (operation, window_id, generation) in [
                (
                    DesktopProviderOperationKind::DetachOwnership,
                    source_window,
                    source_generation,
                ),
                (
                    DesktopProviderOperationKind::AttachOwnership,
                    target_window,
                    1,
                ),
            ] {
                requests.push(DesktopProviderRequest {
                    request_id: Uuid::new_v4().to_string(),
                    correlation_id: correlation.clone(),
                    attempt_epoch,
                    operation,
                    target: DesktopProviderWindowClaim {
                        window_id: window_id.to_string(),
                        generation,
                    },
                    source: None,
                    tab_id: Some(tab_id.to_string()),
                    runtime_session_id: Some(runtime_session_id.clone()),
                    transfer_epoch: Some(transfer_epoch),
                    workspace_id: Some(workspace_id.to_string()),
                    pane_id: Some(pane_id.to_string()),
                    ownership_kind: Some(ownership_kind),
                    browser: browser.clone(),
                });
            }
        }
        if close_source {
            requests.push(DesktopProviderRequest {
                request_id: Uuid::new_v4().to_string(),
                correlation_id: correlation,
                attempt_epoch,
                operation: DesktopProviderOperationKind::CloseWindow,
                target: DesktopProviderWindowClaim {
                    window_id: source_window.to_string(),
                    generation: source_generation,
                },
                source: None,
                tab_id: None,
                runtime_session_id: None,
                transfer_epoch: None,
                workspace_id: None,
                pane_id: None,
                ownership_kind: None,
                browser: None,
            });
        }

        let mut reservation_ids = Vec::with_capacity(requests.len());
        for request in requests {
            let reservation_id = Uuid::new_v4();
            registry.reservations.insert(
                reservation_id,
                ReservedProviderOperation {
                    provider_id,
                    request,
                    claim_preconditions: claim_preconditions.clone(),
                },
            );
            reservation_ids.push(reservation_id);
        }
        Ok(ProviderReservation::Reserved(reservation_ids))
    }

    /// Reserves every resource adoption required by a durable claim
    /// reconciliation. Unlike an ordinary transfer this operation may recover
    /// from a native source incarnation that has already vanished.
    async fn reserve_reconciliation_recovery(
        &self,
        state: &ApplicationState,
        rehomes: &[WindowRehome],
        target_claims: &BTreeMap<WindowId, u64>,
        identity: Option<ParsedIdentity>,
        namespace: &str,
        transfer_epoch: u64,
    ) -> Result<ReservedRecoverySaga, &'static str> {
        let mut resources = Vec::new();
        let mut target_windows = BTreeSet::new();
        for rehome in rehomes {
            let source = state
                .window_placement(rehome.source_window_id)
                .ok_or("source_not_found")?;
            let target_generation = target_claims
                .get(&rehome.target_window_id)
                .copied()
                .ok_or("provider_ineligible")?;
            target_windows.insert(rehome.target_window_id);
            for workspace_id in &source.workspace_ids {
                let workspace = state
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.id == *workspace_id)
                    .ok_or("source_not_found")?;
                for tab in workspace.tabs.values() {
                    let (runtime_session_id, ownership_kind, mut browser) =
                        ownership_transfer_resource(tab)?;
                    if let Some(browser) = &mut browser {
                        browser.lifecycle_id = Uuid::new_v4().to_string();
                    }
                    resources.push((
                        rehome.source_window_id,
                        rehome.target_window_id,
                        target_generation,
                        workspace.id,
                        tab.pane_id,
                        tab.id,
                        runtime_session_id,
                        ownership_kind,
                        browser,
                    ));
                }
            }
        }

        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider_id = if let Some(identity) = identity {
            let provider = registry
                .providers
                .get(&identity.provider_id)
                .ok_or("provider_lease_expired")?;
            require_identity(provider, identity)?;
            if !["window-host-v1", "tab-transfer-v1", "browser-transfer-v1"]
                .iter()
                .all(|capability| provider.capabilities.contains(*capability))
                || target_windows
                    .iter()
                    .any(|window_id| !target_claims.contains_key(window_id))
            {
                return Err("provider_ineligible");
            }
            identity.provider_id
        } else {
            registry
                .providers
                .iter()
                .filter(|(_, provider)| {
                    ["window-host-v1", "tab-transfer-v1", "browser-transfer-v1"]
                        .iter()
                        .all(|capability| provider.capabilities.contains(*capability))
                        && target_windows.iter().all(|window_id| {
                            provider.claims.get(window_id) == target_claims.get(window_id)
                        })
                })
                .max_by_key(|(_, provider)| provider.registration_sequence)
                .map(|(provider_id, _)| *provider_id)
                .ok_or("provider_ineligible")?
        };
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected provider remains registered");
        let correlation_id =
            recovery_correlation(namespace, provider.provider_epoch, state.revision, rehomes);
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry
                .reservations
                .values()
                .any(|reserved| reserved.request.correlation_id == correlation)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            return Ok(ReservedRecoverySaga {
                reservation: ProviderReservation::Existing,
                correlation_id,
                target_windows,
                requests: Vec::new(),
            });
        }
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            .saturating_add(resources.len())
            > MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let attempt_epoch = provider.provider_epoch;
        let source_generations = resources
            .iter()
            .map(|(source, ..)| (*source, provider.claims.get(source).copied().unwrap_or(1)))
            .collect::<BTreeMap<_, _>>();
        let mut reservation_ids = Vec::with_capacity(resources.len());
        let mut recovery_requests = Vec::with_capacity(resources.len());
        for (
            source_window,
            target_window,
            target_generation,
            workspace_id,
            pane_id,
            tab_id,
            runtime_session_id,
            ownership_kind,
            browser,
        ) in resources
        {
            let reservation_id = Uuid::new_v4();
            let request = DesktopProviderRequest {
                request_id: Uuid::new_v4().to_string(),
                correlation_id: correlation.clone(),
                attempt_epoch,
                operation: DesktopProviderOperationKind::RecoverOwnership,
                target: DesktopProviderWindowClaim {
                    window_id: target_window.to_string(),
                    generation: target_generation,
                },
                source: Some(DesktopProviderWindowClaim {
                    window_id: source_window.to_string(),
                    generation: source_generations[&source_window],
                }),
                tab_id: Some(tab_id.to_string()),
                runtime_session_id: Some(runtime_session_id),
                transfer_epoch: Some(transfer_epoch),
                workspace_id: Some(workspace_id.to_string()),
                pane_id: Some(pane_id.to_string()),
                ownership_kind: Some(ownership_kind),
                browser,
            };
            registry.reservations.insert(
                reservation_id,
                ReservedProviderOperation {
                    provider_id,
                    claim_preconditions: vec![(target_window, target_generation)],
                    request: request.clone(),
                },
            );
            reservation_ids.push(reservation_id);
            recovery_requests.push(request);
        }
        Ok(ReservedRecoverySaga {
            reservation: ProviderReservation::Reserved(reservation_ids),
            correlation_id,
            target_windows,
            requests: recovery_requests,
        })
    }

    async fn reserve_exact_recovery_requests(
        &self,
        templates: &[DesktopProviderRequest],
        namespace: &str,
        original_correlation: Uuid,
    ) -> Result<ReservedRecoverySaga, &'static str> {
        if templates.is_empty() {
            return Err("transfer_conflict");
        }
        let target_claims = templates
            .iter()
            .map(|request| {
                Ok((
                    parse_window_id(&request.target.window_id).map_err(|_| "target_not_found")?,
                    request.target.generation,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, &'static str>>()?;
        let target_windows = target_claims.keys().copied().collect::<BTreeSet<_>>();
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider_id = registry
            .providers
            .iter()
            .filter(|(_, provider)| {
                ["window-host-v1", "tab-transfer-v1", "browser-transfer-v1"]
                    .iter()
                    .all(|capability| provider.capabilities.contains(*capability))
                    && target_claims.iter().all(|(window_id, generation)| {
                        provider.claims.get(window_id).copied() == Some(*generation)
                    })
            })
            .max_by_key(|(_, provider)| provider.registration_sequence)
            .map(|(provider_id, _)| *provider_id)
            .ok_or("provider_ineligible")?;
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected provider remains registered");
        let correlation_id = provider_correlation(
            namespace,
            Uuid::from_u128(u128::from(provider.provider_epoch)),
            original_correlation,
        );
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry
                .reservations
                .values()
                .any(|reserved| reserved.request.correlation_id == correlation)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            return Ok(ReservedRecoverySaga {
                reservation: ProviderReservation::Existing,
                correlation_id,
                target_windows,
                requests: Vec::new(),
            });
        }
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            .saturating_add(templates.len())
            > MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let attempt_epoch = provider.provider_epoch;
        let mut reservation_ids = Vec::with_capacity(templates.len());
        let mut recovery_requests = Vec::with_capacity(templates.len());
        for template in templates {
            let mut request = template.clone();
            request.request_id = Uuid::new_v4().to_string();
            request.correlation_id.clone_from(&correlation);
            request.attempt_epoch = attempt_epoch;
            request.operation = DesktopProviderOperationKind::RecoverOwnership;
            if let Some(browser) = &mut request.browser {
                browser.lifecycle_id = Uuid::new_v4().to_string();
            }
            let target_window = parse_window_id(&request.target.window_id)
                .expect("validated recovery target is a UUID");
            let reservation_id = Uuid::new_v4();
            registry.reservations.insert(
                reservation_id,
                ReservedProviderOperation {
                    provider_id,
                    claim_preconditions: vec![(target_window, request.target.generation)],
                    request: request.clone(),
                },
            );
            reservation_ids.push(reservation_id);
            recovery_requests.push(request);
        }
        Ok(ReservedRecoverySaga {
            reservation: ProviderReservation::Reserved(reservation_ids),
            correlation_id,
            target_windows,
            requests: recovery_requests,
        })
    }

    async fn reserve_tab_transfer(
        &self,
        source_window: WindowId,
        target_window: WindowId,
        create_target: bool,
        correlation_id: Uuid,
        transfer_epoch: u64,
        tab_id: TabId,
        runtime_session_id: String,
        ownership_kind: RuntimeOwnershipKind,
        browser: Option<BrowserOwnershipTransferDescriptor>,
        source_workspace: WorkspaceId,
        source_pane: PaneId,
        target_workspace: WorkspaceId,
        target_pane: PaneId,
    ) -> Result<ProviderReservation, &'static str> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry
                .reservations
                .values()
                .any(|reserved| reserved.request.correlation_id == correlation)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            return Ok(ProviderReservation::Existing);
        }
        let provider_id = registry
            .providers
            .iter()
            .filter(|(_, provider)| provider.capabilities.contains("tab-transfer-v1"))
            .filter(|(_, provider)| {
                provider.claims.contains_key(&source_window)
                    && (create_target || provider.claims.contains_key(&target_window))
            })
            .max_by_key(|(_, provider)| provider.registration_sequence)
            .map(|(provider_id, _)| *provider_id)
            .ok_or("provider_ineligible")?;
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected provider remains registered");
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            .saturating_add(if create_target { 3 } else { 2 })
            > MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let attempt_epoch = provider.provider_epoch;
        let source_generation = provider.claims[&source_window];
        let target_generation = if create_target {
            1
        } else {
            provider.claims[&target_window]
        };
        let lifecycle_id = browser.as_ref().map(|_| Uuid::new_v4().to_string());
        let browser = browser.map(|mut descriptor| {
            descriptor.lifecycle_id = lifecycle_id.expect("browser lifecycle ID was created");
            descriptor
        });
        let mut specs = Vec::with_capacity(if create_target { 3 } else { 2 });
        if create_target {
            specs.push((
                DesktopProviderOperationKind::CreateWindow,
                target_window,
                target_generation,
                target_workspace,
                target_pane,
            ));
        }
        specs.extend([
            (
                DesktopProviderOperationKind::DetachOwnership,
                source_window,
                source_generation,
                source_workspace,
                source_pane,
            ),
            (
                DesktopProviderOperationKind::AttachOwnership,
                target_window,
                target_generation,
                target_workspace,
                target_pane,
            ),
        ]);
        let mut reservation_ids = Vec::with_capacity(specs.len());
        for (operation, window_id, generation, workspace_id, pane_id) in specs {
            let reservation_id = Uuid::new_v4();
            registry.reservations.insert(
                reservation_id,
                ReservedProviderOperation {
                    provider_id,
                    claim_preconditions: if create_target {
                        vec![(source_window, source_generation)]
                    } else {
                        vec![
                            (source_window, source_generation),
                            (target_window, target_generation),
                        ]
                    },
                    request: DesktopProviderRequest {
                        request_id: Uuid::new_v4().to_string(),
                        correlation_id: correlation.clone(),
                        attempt_epoch,
                        operation,
                        target: DesktopProviderWindowClaim {
                            window_id: window_id.to_string(),
                            generation,
                        },
                        source: None,
                        tab_id: (operation != DesktopProviderOperationKind::CreateWindow)
                            .then(|| tab_id.to_string()),
                        runtime_session_id: (operation
                            != DesktopProviderOperationKind::CreateWindow)
                            .then(|| runtime_session_id.clone()),
                        transfer_epoch: (operation != DesktopProviderOperationKind::CreateWindow)
                            .then_some(transfer_epoch),
                        workspace_id: (operation != DesktopProviderOperationKind::CreateWindow)
                            .then(|| workspace_id.to_string()),
                        pane_id: (operation != DesktopProviderOperationKind::CreateWindow)
                            .then(|| pane_id.to_string()),
                        ownership_kind: (operation != DesktopProviderOperationKind::CreateWindow)
                            .then_some(ownership_kind),
                        browser: (operation != DesktopProviderOperationKind::CreateWindow)
                            .then(|| browser.clone())
                            .flatten(),
                    },
                },
            );
            reservation_ids.push(reservation_id);
        }
        Ok(ProviderReservation::Reserved(reservation_ids))
    }

    async fn reserve_window_rehome(
        &self,
        state: &ApplicationState,
        source_window: WindowId,
        target_window: WindowId,
        correlation_id: Uuid,
        transfer_epoch: u64,
    ) -> Result<ProviderReservation, &'static str> {
        let source = state
            .window_placement(source_window)
            .ok_or("source_not_found")?;
        let target = state
            .window_placement(target_window)
            .ok_or("target_not_found")?;
        let mut resources = Vec::new();
        for workspace_id in &source.workspace_ids {
            let workspace = state
                .workspaces
                .iter()
                .find(|workspace| workspace.id == *workspace_id)
                .ok_or("source_not_found")?;
            for tab in workspace.tabs.values() {
                let (runtime_session_id, ownership_kind, mut browser) =
                    ownership_transfer_resource(tab)?;
                if let Some(browser) = &mut browser {
                    browser.lifecycle_id = Uuid::new_v4().to_string();
                }
                resources.push((
                    tab.id,
                    runtime_session_id,
                    ownership_kind,
                    browser,
                    workspace.id,
                    tab.pane_id,
                ));
            }
        }
        let required = resources.len().saturating_mul(2).saturating_add(1);
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let correlation = correlation_id.to_string();
        if registry.completed_correlations.contains(&correlation_id)
            || registry
                .reservations
                .values()
                .any(|reserved| reserved.request.correlation_id == correlation)
            || registry.providers.values().any(|provider| {
                provider
                    .queued
                    .iter()
                    .chain(provider.in_flight.values())
                    .any(|pending| pending.request.correlation_id == correlation)
            })
        {
            return Ok(ProviderReservation::Existing);
        }
        let provider_id = registry
            .providers
            .iter()
            .filter(|(_, provider)| {
                provider.capabilities.contains("window-host-v1")
                    && provider.capabilities.contains("tab-transfer-v1")
                    && provider.claims.contains_key(&source_window)
                    && provider.claims.contains_key(&target_window)
            })
            .max_by_key(|(_, provider)| provider.registration_sequence)
            .map(|(provider_id, _)| *provider_id)
            .ok_or("provider_ineligible")?;
        let reserved_for_provider = registry
            .reservations
            .values()
            .filter(|reservation| reservation.provider_id == provider_id)
            .count()
            .saturating_add(
                registry
                    .action_reservations
                    .values()
                    .filter(|reservation| reservation.provider_id == provider_id)
                    .count(),
            );
        let provider = registry
            .providers
            .get(&provider_id)
            .expect("selected provider remains registered");
        if provider
            .queued
            .len()
            .saturating_add(provider.in_flight.len())
            .saturating_add(provider.action_queued.len())
            .saturating_add(provider.action_in_flight.len())
            .saturating_add(reserved_for_provider)
            .saturating_add(required)
            > MAX_PROVIDER_QUEUE
        {
            return Err("provider_backpressure");
        }
        let attempt_epoch = provider.provider_epoch;
        let source_generation = provider.claims[&source.id];
        let target_generation = provider.claims[&target.id];
        let mut requests = Vec::with_capacity(required);
        for (tab_id, runtime_session_id, ownership_kind, browser, workspace_id, pane_id) in
            resources
        {
            for (operation, window_id, generation) in [
                (
                    DesktopProviderOperationKind::DetachOwnership,
                    source.id,
                    source_generation,
                ),
                (
                    DesktopProviderOperationKind::AttachOwnership,
                    target.id,
                    target_generation,
                ),
            ] {
                requests.push(DesktopProviderRequest {
                    request_id: Uuid::new_v4().to_string(),
                    correlation_id: correlation.clone(),
                    attempt_epoch,
                    operation,
                    target: DesktopProviderWindowClaim {
                        window_id: window_id.to_string(),
                        generation,
                    },
                    source: None,
                    tab_id: Some(tab_id.to_string()),
                    runtime_session_id: Some(runtime_session_id.clone()),
                    transfer_epoch: Some(transfer_epoch),
                    workspace_id: Some(workspace_id.to_string()),
                    pane_id: Some(pane_id.to_string()),
                    ownership_kind: Some(ownership_kind),
                    browser: browser.clone(),
                });
            }
        }
        requests.push(DesktopProviderRequest {
            request_id: Uuid::new_v4().to_string(),
            correlation_id: correlation,
            attempt_epoch,
            operation: DesktopProviderOperationKind::CloseWindow,
            target: DesktopProviderWindowClaim {
                window_id: source.id.to_string(),
                generation: source_generation,
            },
            source: None,
            tab_id: None,
            runtime_session_id: None,
            transfer_epoch: None,
            workspace_id: None,
            pane_id: None,
            ownership_kind: None,
            browser: None,
        });
        let mut reservation_ids = Vec::with_capacity(requests.len());
        for request in requests {
            let reservation_id = Uuid::new_v4();
            registry.reservations.insert(
                reservation_id,
                ReservedProviderOperation {
                    provider_id,
                    claim_preconditions: vec![
                        (source_window, source_generation),
                        (target_window, target_generation),
                    ],
                    request,
                },
            );
            reservation_ids.push(reservation_id);
        }
        Ok(ProviderReservation::Reserved(reservation_ids))
    }

    async fn release_reservation(&self, reservation: ProviderReservation) {
        if let ProviderReservation::Reserved(reservation_ids) = reservation {
            let mut registry = self.providers.lock().await;
            for reservation_id in reservation_ids {
                registry.reservations.remove(&reservation_id);
            }
        }
    }

    async fn reservation_requests(
        &self,
        reservation: &ProviderReservation,
    ) -> Vec<DesktopProviderRequest> {
        let ProviderReservation::Reserved(reservation_ids) = reservation else {
            return Vec::new();
        };
        let registry = self.providers.lock().await;
        reservation_ids
            .iter()
            .filter_map(|reservation_id| {
                registry
                    .reservations
                    .get(reservation_id)
                    .map(|reservation| reservation.request.clone())
            })
            .collect()
    }

    async fn publish_reservation(
        &self,
        reservation: ProviderReservation,
    ) -> Result<
        Vec<(
            DesktopProviderRequest,
            oneshot::Receiver<ProviderCompletion>,
        )>,
        &'static str,
    > {
        let ProviderReservation::Reserved(reservation_ids) = reservation else {
            return Ok(Vec::new());
        };
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let mut reserved = Vec::with_capacity(reservation_ids.len());
        let validation_error = reservation_ids.iter().find_map(|reservation_id| {
            let operation = registry.reservations.get(reservation_id)?;
            let Some(provider) = registry.providers.get(&operation.provider_id) else {
                return Some("provider_lease_expired");
            };
            (provider.provider_epoch != operation.request.attempt_epoch
                || operation
                    .claim_preconditions
                    .iter()
                    .any(|(window_id, generation)| {
                        provider.claims.get(window_id).copied() != Some(*generation)
                    }))
            .then_some("provider_epoch_mismatch")
        });
        let validation_error = validation_error.or_else(|| {
            reservation_ids
                .iter()
                .any(|reservation_id| !registry.reservations.contains_key(reservation_id))
                .then_some("transfer_conflict")
        });
        if let Some(error) = validation_error {
            for reservation_id in reservation_ids {
                registry.reservations.remove(&reservation_id);
            }
            return Err(error);
        }
        for reservation_id in reservation_ids {
            reserved.push(
                registry
                    .reservations
                    .remove(&reservation_id)
                    .expect("reservation was prevalidated"),
            );
        }
        let mut receivers = Vec::with_capacity(reserved.len());
        for reserved in reserved {
            let correlation_id = parse_uuid(&reserved.request.correlation_id)
                .expect("service-issued correlation ID is a UUID");
            if !registry.completed_correlations.contains(&correlation_id) {
                registry.completed_correlations.push_back(correlation_id);
            }
            let (sender, receiver) = oneshot::channel();
            let request = reserved.request.clone();
            registry
                .providers
                .get_mut(&reserved.provider_id)
                .expect("provider was prevalidated")
                .queued
                .push_back(PendingProviderOperation {
                    request: reserved.request,
                    completion: Some(sender),
                });
            receivers.push((request, receiver));
        }
        while registry.completed_correlations.len() > 4_096 {
            registry.completed_correlations.pop_front();
        }
        drop(registry);
        self.queue_changed.notify_waiters();
        Ok(receivers)
    }

    async fn active_claim_map(&self) -> BTreeMap<WindowId, u64> {
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        registry
            .providers
            .values()
            .flat_map(|provider| {
                provider
                    .claims
                    .iter()
                    .map(|(id, generation)| (*id, *generation))
            })
            .collect()
    }

    async fn cancel_queued_correlation(&self, correlation_id: Uuid) {
        let correlation = correlation_id.to_string();
        let mut registry = self.providers.lock().await;
        for provider in registry.providers.values_mut() {
            provider
                .queued
                .retain(|pending| pending.request.correlation_id != correlation);
        }
    }

    async fn poll(
        &self,
        params: DesktopProviderPollParams,
    ) -> Result<DesktopProviderPollResult, &'static str> {
        let identity = ParsedIdentity::parse(&params.identity)?;
        let deadline = Instant::now() + Duration::from_millis(u64::from(params.timeout_ms));
        loop {
            let notified = self.queue_changed.notified();
            {
                let mut registry = self.providers.lock().await;
                prune_expired(&mut registry);
                let provider = registry
                    .providers
                    .get_mut(&identity.provider_id)
                    .ok_or("provider_lease_expired")?;
                require_identity(provider, identity)?;
                if let Some(pending) = provider.in_flight.values().next() {
                    return Ok(DesktopProviderPollResult {
                        request: Some(pending.request.clone()),
                    });
                }
                if let Some(pending) = provider.queued.pop_front() {
                    let request = pending.request.clone();
                    let request_id = parse_uuid(&request.request_id)
                        .expect("service-issued request ID is a UUID");
                    provider.in_flight.insert(request_id, pending);
                    return Ok(DesktopProviderPollResult {
                        request: Some(request),
                    });
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(DesktopProviderPollResult { request: None });
            }
            if tokio::time::timeout(deadline.saturating_duration_since(now), notified)
                .await
                .is_err()
            {
                return Ok(DesktopProviderPollResult { request: None });
            }
        }
    }

    async fn acknowledge(
        &self,
        params: DesktopProviderAcknowledgeParams,
    ) -> Result<(), &'static str> {
        let identity = ParsedIdentity::parse(&params.identity)?;
        let request_id = parse_uuid(&params.request_id).map_err(|_| "transfer_conflict")?;
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider = registry
            .providers
            .get_mut(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(provider, identity)?;
        let pending = provider
            .in_flight
            .get(&request_id)
            .ok_or("transfer_conflict")?;
        if pending.request.correlation_id != params.correlation_id
            || pending.request.attempt_epoch != params.attempt_epoch
        {
            return Err("provider_epoch_mismatch");
        }
        let mut pending = provider
            .in_flight
            .remove(&request_id)
            .expect("in-flight request was checked above");
        let completion = match params.status {
            DesktopProviderCompletionStatus::Succeeded => ProviderCompletion::Succeeded,
            DesktopProviderCompletionStatus::Failed => ProviderCompletion::Failed(
                params
                    .error_code
                    .expect("protocol validation requires an error code"),
            ),
            DesktopProviderCompletionStatus::Canceled => ProviderCompletion::Canceled,
        };
        if let Some(sender) = pending.completion.take() {
            let _ = sender.send(completion);
        }
        let correlation_id = parse_uuid(&pending.request.correlation_id)
            .expect("service-issued correlation ID is a UUID");
        if !registry.completed_correlations.contains(&correlation_id) {
            registry.completed_correlations.push_back(correlation_id);
        }
        while registry.completed_correlations.len() > 4_096 {
            registry.completed_correlations.pop_front();
        }
        Ok(())
    }

    async fn cancel(&self, params: DesktopProviderCancelParams) -> Result<(), &'static str> {
        let identity = ParsedIdentity::parse(&params.identity)?;
        let request_id = parse_uuid(&params.request_id).map_err(|_| "transfer_conflict")?;
        let mut registry = self.providers.lock().await;
        prune_expired(&mut registry);
        let provider = registry
            .providers
            .get_mut(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(provider, identity)?;
        if let Some(index) = provider.queued.iter().position(|pending| {
            pending.request.request_id == params.request_id
                && pending.request.correlation_id == params.correlation_id
                && pending.request.attempt_epoch == params.attempt_epoch
        }) {
            let mut pending = provider
                .queued
                .remove(index)
                .expect("queued request index was checked");
            if let Some(sender) = pending.completion.take() {
                let _ = sender.send(ProviderCompletion::Canceled);
            }
            return Ok(());
        }
        if provider.in_flight.contains_key(&request_id) {
            return Err("cancellation_not_guaranteed");
        }
        Err("transfer_conflict")
    }

    /// Remove expired providers and return the still-authoritative claim set when it changed.
    pub(super) async fn expire_leases(&self) -> Option<BTreeSet<WindowId>> {
        if let Some(store) = &self.recovery_store {
            let _ = store.prune_action_provider_recovery(wall_now_ms());
        }
        let mut registry = self.providers.lock().await;
        let before = registry.providers.len();
        prune_expired(&mut registry);
        if registry.providers.len() == before {
            return None;
        }
        Some(
            registry
                .providers
                .values()
                .flat_map(|provider| provider.claims.keys().copied())
                .collect(),
        )
    }

    async fn bind(
        &self,
        state: &ApplicationState,
        params: WindowBindParams,
    ) -> Result<BoundWindow, &'static str> {
        let identity = ParsedIdentity::parse(&params.identity)?;
        let window_id =
            parse_window_id(&params.window.window_id).map_err(|_| "target_not_found")?;
        if state.window_placement(window_id).is_none() {
            return Err("target_not_found");
        }
        let mut providers = self.providers.lock().await;
        prune_expired(&mut providers);
        let lease = providers
            .providers
            .get(&identity.provider_id)
            .ok_or("provider_lease_expired")?;
        require_identity(lease, identity)?;
        if lease.claims.get(&window_id).copied() != Some(params.window.generation) {
            return Err("provider_ineligible");
        }
        Ok(BoundWindow {
            window_id,
            provider: Some(ProviderBinding {
                provider_id: identity.provider_id,
                provider_epoch: identity.provider_epoch,
                generation: params.window.generation,
            }),
        })
    }

    pub(super) async fn validate_binding(
        &self,
        state: &ApplicationState,
        binding: BoundWindow,
    ) -> Result<(), &'static str> {
        if state.window_placement(binding.window_id).is_none() {
            return Err("target_not_found");
        }
        let Some(provider) = binding.provider else {
            return Ok(());
        };
        let mut providers = self.providers.lock().await;
        prune_expired(&mut providers);
        let lease = providers
            .providers
            .get(&provider.provider_id)
            .ok_or("provider_lease_expired")?;
        if lease.provider_epoch != provider.provider_epoch {
            return Err("provider_epoch_mismatch");
        }
        if !["window-host-v1", "tab-transfer-v1", "browser-transfer-v1"]
            .iter()
            .all(|capability| lease.capabilities.contains(*capability))
        {
            return Err("provider_ineligible");
        }
        if lease.claims.get(&binding.window_id).copied() != Some(provider.generation) {
            return Err("provider_ineligible");
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct ParsedIdentity {
    provider_id: Uuid,
    provider_epoch: u64,
    lease_id: Uuid,
}

impl ParsedIdentity {
    fn parse(params: &DesktopProviderIdentityParams) -> Result<Self, &'static str> {
        Self::parse_fields(&params.provider_id, params.provider_epoch, &params.lease_id)
    }

    fn parse_fields(
        provider_id: &str,
        provider_epoch: u64,
        lease_id: &str,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            provider_id: parse_uuid(provider_id).map_err(|_| "provider_ineligible")?,
            provider_epoch,
            lease_id: parse_uuid(lease_id).map_err(|_| "provider_ineligible")?,
        })
    }
}

pub(super) fn is_command(command: &str) -> bool {
    COMMANDS.contains(&command)
}

pub(super) fn project_state_to_window(
    state: &ApplicationState,
    window_id: WindowId,
) -> Option<ApplicationState> {
    let placement = state.window_placement(window_id)?.clone();
    let owned = placement
        .workspace_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let mut projected = state.clone();
    projected
        .workspaces
        .retain(|workspace| owned.contains(&workspace.id));
    projected.selected_workspace_id = if owned.contains(&state.selected_workspace_id) {
        state.selected_workspace_id
    } else {
        placement.focused_workspace_id
    };
    projected
        .workspace_selection
        .retain(|workspace_id| owned.contains(workspace_id));
    if !projected
        .workspace_selection
        .contains(&projected.selected_workspace_id)
    {
        projected
            .workspace_selection
            .push(projected.selected_workspace_id);
    }
    projected
        .workspace_pins
        .retain(|workspace_id| owned.contains(workspace_id));
    projected
        .workspace_group_assignments
        .retain(|workspace_id, _| owned.contains(workspace_id));
    let owned_groups = projected
        .workspace_group_assignments
        .values()
        .copied()
        .collect::<BTreeSet<_>>();
    let assigned_groups = state
        .workspace_group_assignments
        .values()
        .copied()
        .collect::<BTreeSet<_>>();
    projected
        .workspace_groups
        .retain(|group| owned_groups.contains(&group.id) || !assigned_groups.contains(&group.id));
    projected.saved_layouts.clear();
    projected.legacy_over_limit = None;
    projected
        .notifications
        .retain(|notification| owned.contains(&notification.workspace_id));
    projected.window_placements = vec![placement];
    projected.focused_window_id = window_id;
    projected
        .focus_history
        .entries
        .retain(|target| target.window_id == window_id);
    projected.focus_history.cursor = projected
        .focus_history
        .cursor
        .min(projected.focus_history.entries.len().saturating_sub(1));
    projected
        .recently_closed
        .retain(|record| owned.contains(&record.prior_workspace_id));
    Some(projected)
}

pub(super) fn topology_event_envelopes(
    before: &ApplicationState,
    after: &ApplicationState,
    idempotency_epoch: Uuid,
) -> Vec<EventEnvelope> {
    let before_windows = before
        .window_placements
        .iter()
        .map(|placement| placement.id)
        .collect::<BTreeSet<_>>();
    let after_windows = after
        .window_placements
        .iter()
        .map(|placement| placement.id)
        .collect::<BTreeSet<_>>();
    let mut events = Vec::new();
    if before.window_placements != after.window_placements
        || before.focused_window_id != after.focused_window_id
    {
        let reason = if after_windows.len() > before_windows.len() {
            MultiWindowChangeReason::WindowCreated
        } else if after_windows.len() < before_windows.len() {
            let surviving_gained_workspace = after.window_placements.iter().any(|placement| {
                before
                    .window_placement(placement.id)
                    .is_some_and(|old| old.workspace_ids.len() < placement.workspace_ids.len())
            });
            if surviving_gained_workspace {
                MultiWindowChangeReason::WindowRehomed
            } else {
                MultiWindowChangeReason::WindowClosed
            }
        } else if before.focused_window_id != after.focused_window_id {
            MultiWindowChangeReason::WindowFocused
        } else if before.window_placements.iter().any(|old| {
            after
                .window_placement(old.id)
                .is_some_and(|new| old.hosting_state != new.hosting_state)
        }) {
            MultiWindowChangeReason::HostingChanged
        } else {
            MultiWindowChangeReason::TabMoved
        };
        events.push(revision_event(
            "window.topologyChanged",
            after.revision,
            MultiWindowChangedEvent {
                event: "window.topologyChanged".to_owned(),
                revision: after.revision,
                idempotency_epoch: idempotency_epoch.to_string(),
                window_ids: after_windows.iter().map(ToString::to_string).collect(),
                reason,
            },
        ));
    }

    for workspace in &before.workspaces {
        for tab in workspace.tabs.values() {
            let Some(source) = exact_tab_event_placement(before, tab.id) else {
                continue;
            };
            let Some(target) = exact_tab_event_placement(after, tab.id) else {
                continue;
            };
            if source.0 == target.0 {
                continue;
            }
            let (runtime_session_id, ownership_kind) = match &tab.content {
                TabContent::Terminal {
                    runtime_session_id: Some(runtime_session_id),
                    ..
                } => (
                    runtime_session_id.to_string(),
                    RuntimeOwnershipKind::Terminal,
                ),
                TabContent::Browser { metadata } => (
                    metadata.browser_session_id().to_string(),
                    RuntimeOwnershipKind::Browser,
                ),
                TabContent::Terminal {
                    runtime_session_id: None,
                    ..
                } => continue,
            };
            events.push(revision_event(
                "tab.ownershipTransferred",
                after.revision,
                TabOwnershipTransferredEvent {
                    event: "tab.ownershipTransferred".to_owned(),
                    revision: after.revision,
                    transfer_epoch: after.revision,
                    tab_id: tab.id.to_string(),
                    runtime_session_id,
                    ownership_kind,
                    source: source.0,
                    target: target.0,
                    reason: MultiWindowChangeReason::TabMoved,
                },
            ));
        }
    }
    events
}

pub(super) fn ownership_event_targets_window(
    envelope: &EventEnvelope,
    window_id: WindowId,
) -> bool {
    envelope.event == "tab.ownershipTransferred"
        && ["source", "target"].into_iter().any(|side| {
            envelope
                .data
                .get(side)
                .and_then(|placement| placement.get("windowId"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|event_window_id| event_window_id == window_id.to_string())
        })
}

fn exact_tab_event_placement(
    state: &ApplicationState,
    tab_id: TabId,
) -> Option<(TabPlacementSnapshot, WorkspaceId)> {
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.tabs.contains_key(&tab_id))?;
    let tab = workspace.tabs.get(&tab_id)?;
    let pane = workspace.panes.get(&tab.pane_id)?;
    let index = pane.tabs.iter().position(|id| *id == tab_id)?;
    let window = state.window_for_workspace(workspace.id)?;
    Some((
        TabPlacementSnapshot {
            window_id: window.id.to_string(),
            workspace_id: workspace.id.to_string(),
            pane_id: pane.id.to_string(),
            index: u32::try_from(index).ok()?,
            window_revision: window.revision,
        },
        workspace.id,
    ))
}

fn preview_reconciliation_rehomes(
    state: &ApplicationState,
    claimed: &BTreeSet<WindowId>,
) -> Result<Vec<WindowRehome>, DomainError> {
    let mut candidate = state.clone();
    candidate
        .reconcile_window_claims(claimed)
        .map(|reconciliation| reconciliation.rehomes)
}

fn reconcile_claims_without_rehomes(
    state: &mut ApplicationState,
    claimed: &BTreeSet<WindowId>,
) -> Result<MutationOutcome, DomainError> {
    let unhosted = state.reconcile_window_claims(&BTreeSet::new())?.outcome;
    if claimed.is_empty() {
        return Ok(unhosted);
    }
    state
        .reconcile_window_claims(claimed)
        .map(|reconciliation| reconciliation.outcome)
}

fn recovery_templates_from_provider_requests(
    requests: &[DesktopProviderRequest],
) -> Vec<DesktopProviderRequest> {
    let mut detached = BTreeMap::new();
    let mut recovery = Vec::new();
    for request in requests {
        let resource = request
            .tab_id
            .as_ref()
            .zip(request.runtime_session_id.as_ref())
            .zip(request.transfer_epoch)
            .map(|((tab_id, runtime_session_id), transfer_epoch)| {
                (tab_id.clone(), runtime_session_id.clone(), transfer_epoch)
            });
        match (request.operation, resource) {
            (DesktopProviderOperationKind::DetachOwnership, Some(resource)) => {
                detached.insert(resource, request.target.clone());
            }
            (DesktopProviderOperationKind::AttachOwnership, Some(resource)) => {
                if let Some(source) = detached.get(&resource) {
                    let mut request = request.clone();
                    request.operation = DesktopProviderOperationKind::RecoverOwnership;
                    request.source = Some(source.clone());
                    recovery.push(request);
                }
            }
            _ => {}
        }
    }
    recovery
}

fn ownership_transfer_resource(
    tab: &Tab,
) -> Result<
    (
        String,
        RuntimeOwnershipKind,
        Option<BrowserOwnershipTransferDescriptor>,
    ),
    &'static str,
> {
    match &tab.content {
        TabContent::Terminal {
            runtime_session_id: Some(runtime_session_id),
            ..
        } => Ok((
            runtime_session_id.to_string(),
            RuntimeOwnershipKind::Terminal,
            None,
        )),
        TabContent::Browser { metadata } => Ok((
            metadata.browser_session_id().to_string(),
            RuntimeOwnershipKind::Browser,
            Some(BrowserOwnershipTransferDescriptor {
                browser_session_id: metadata.browser_session_id().to_string(),
                url: metadata.url().to_owned(),
                title: metadata.navigation_title().to_owned(),
                profile_partition: metadata.profile_partition().to_owned(),
                state_revision: metadata.state_revision(),
                lifecycle_id: Uuid::nil().to_string(),
            }),
        )),
        TabContent::Terminal {
            runtime_session_id: None,
            ..
        } => Err("transfer_conflict"),
    }
}

fn revision_event(event: &str, revision: u64, data: impl Serialize) -> EventEnvelope {
    EventEnvelope {
        event: event.to_owned(),
        revision: Some(revision),
        data: serde_json::to_value(data).expect("multi-window event serialization is infallible"),
    }
}

/// Projects aggregate legacy read results onto the connection's bound placement.
///
/// Targeted legacy commands are authorized before dispatch. `workspace.list` is
/// the remaining aggregate snapshot read and must be rebuilt from a projected
/// core snapshot so workspace, tab, pane, notification, and attention data from
/// sibling native windows never reaches this connection.
pub(super) fn project_legacy_response(
    command: &str,
    mut response: ResponseEnvelope,
    binding: BoundWindow,
    state: &ApplicationState,
) -> ResponseEnvelope {
    if !response.ok {
        return response;
    }
    if command == "system.identify" {
        if let Some(capabilities) = response
            .result
            .as_mut()
            .and_then(|result| result.get_mut("capabilities"))
            .and_then(serde_json::Value::as_array_mut)
        {
            let mut strings = capabilities
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            apply_identify_capabilities(&mut strings, state, Some(binding));
            *capabilities = strings.into_iter().map(serde_json::Value::String).collect();
        }
        return response;
    }
    if !matches!(command, "workspace.list" | "workspace.organization.get") {
        return response;
    }
    let Some(projected) = project_state_to_window(state, binding.window_id) else {
        return ResponseEnvelope::failure(
            response.id,
            "placement_required",
            "This control connection's window placement no longer exists",
        );
    };
    response.result = match command {
        "workspace.list" => serde_json::to_value(WorkspaceListResult {
            snapshot: super::milestone2::application_snapshot(&projected),
        })
        .ok(),
        "workspace.organization.get" => {
            serde_json::to_value(agent_workspace_protocol::WorkspaceOrganizationGetResult {
                organization: super::organization::organization_snapshot(&projected),
            })
            .ok()
        }
        _ => unreachable!("projectable command was matched above"),
    };
    // Dispatch and placement projection take separate snapshots. The projected
    // result above is wholly rebuilt from `state`, so its envelope must carry
    // that same revision rather than the earlier aggregate-read revision.
    response.revision = Some(state.revision);
    response
}

pub(super) fn apply_identify_capabilities(
    capabilities: &mut Vec<String>,
    state: &ApplicationState,
    binding: Option<BoundWindow>,
) {
    if state.legacy_over_limit.is_none() {
        if !capabilities
            .iter()
            .any(|capability| capability == agent_workspace_protocol::MULTI_WINDOW_CAPABILITY)
        {
            capabilities.push(agent_workspace_protocol::MULTI_WINDOW_CAPABILITY.to_owned());
        }
    } else {
        capabilities
            .retain(|capability| capability != agent_workspace_protocol::MULTI_WINDOW_CAPABILITY);
    }
    if state.window_placements.len() > 1 && binding.is_some() {
        capabilities.retain(|capability| {
            capability != "saved-layouts-v1" && !capability.starts_with("layout.")
        });
    }
}

pub(super) fn bound_request_targets_owned_state(
    state: &ApplicationState,
    binding: BoundWindow,
    params: &serde_json::Value,
) -> bool {
    let Some(placement) = state.window_placement(binding.window_id) else {
        return false;
    };
    let owned = placement
        .workspace_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let mut values = Vec::new();
    collect_identity_values(params, None, &mut values);
    values.into_iter().all(|value| {
        for window in &state.window_placements {
            if value == window.id.to_string() {
                return window.id == binding.window_id;
            }
        }
        for workspace in &state.workspaces {
            let workspace_owned = owned.contains(&workspace.id);
            if value == workspace.id.to_string() {
                return workspace_owned;
            }
            if workspace
                .panes
                .keys()
                .any(|pane_id| value == pane_id.to_string())
                || workspace.tabs.values().any(|tab| {
                    value == tab.id.to_string()
                        || tab
                            .content
                            .runtime_session_id()
                            .is_some_and(|session_id| value == session_id.as_str())
                        || matches!(
                            &tab.content,
                            TabContent::Browser { metadata }
                                if value == metadata.browser_session_id().to_string()
                        )
                })
            {
                return workspace_owned;
            }
        }
        for notification in &state.notifications {
            if value == notification.id.to_string() {
                return owned.contains(&notification.workspace_id);
            }
        }
        true
    })
}

fn collect_identity_values<'a>(
    value: &'a serde_json::Value,
    key: Option<&str>,
    output: &mut Vec<&'a str>,
) {
    match value {
        serde_json::Value::String(value)
            if key.is_some_and(|key| key.ends_with("Id") || key.ends_with("Ids")) =>
        {
            output.push(value);
        }
        serde_json::Value::String(_) => {}
        serde_json::Value::Array(values) => {
            for value in values {
                collect_identity_values(value, key, output);
            }
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                collect_identity_values(value, Some(key), output);
            }
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {}
    }
}

/// Legacy notification mutations can address the whole application without a
/// target ID and are denied on a bound connection. The aggregate list is safe:
/// `milestone2::dispatch_for_window` projects and paginates it from the bound
/// placement's authoritative workspace set.
pub(super) fn legacy_notification_request_is_global(
    command: &str,
    params: &serde_json::Value,
) -> bool {
    match command {
        "notification.list" => false,
        "notification.clear" => params
            .get("scope")
            .and_then(serde_json::Value::as_object)
            .and_then(|scope| scope.get("kind"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|kind| kind != "notification"),
        _ => false,
    }
}

/// Applies explicit window-scoping semantics to the legacy organization surface.
/// Aggregate reads are projected after dispatch; mutations are admitted only
/// when their entire affected workspace/group set belongs to the binding.
pub(super) fn legacy_organization_request_is_allowed(
    state: &ApplicationState,
    binding: BoundWindow,
    command: &str,
    params: &serde_json::Value,
) -> bool {
    let Some(placement) = state.window_placement(binding.window_id) else {
        return false;
    };
    let owned = placement
        .workspace_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let workspace_values_owned = |values: Option<&serde_json::Value>| {
        values
            .and_then(serde_json::Value::as_array)
            .is_some_and(|values| {
                !values.is_empty()
                    && values.iter().all(|value| {
                        value
                            .as_str()
                            .and_then(|value| Uuid::parse_str(value).ok())
                            .map(WorkspaceId::from_uuid)
                            .is_some_and(|workspace_id| owned.contains(&workspace_id))
                    })
            })
    };
    let group_is_owned = |group_id: Option<&str>| {
        let Some(group_id) = group_id
            .and_then(|value| Uuid::parse_str(value).ok())
            .map(agent_workspace_core::GroupId::from_uuid)
        else {
            return false;
        };
        state
            .workspace_group_assignments
            .iter()
            .filter(|(_, assigned)| **assigned == group_id)
            .all(|(workspace_id, _)| owned.contains(workspace_id))
    };
    match command {
        "workspace.organization.get" | "group.create" => true,
        "workspace.selectMany" => workspace_values_owned(params.get("selection")),
        "workspace.pin" | "workspace.reorder" | "group.assign" => true,
        "workspace.closeSelected" => state
            .workspace_selection
            .iter()
            .all(|workspace_id| owned.contains(workspace_id)),
        "group.rename" | "group.delete" | "group.collapse" => {
            group_is_owned(params.get("groupId").and_then(serde_json::Value::as_str))
        }
        // Moving a group changes the application-global group order, including
        // foreign groups, so it has no safe window-local interpretation.
        "group.move" => false,
        _ => false,
    }
}

#[allow(clippy::too_many_lines)]
pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
    bound_window: &Mutex<Option<BoundWindow>>,
) -> ResponseEnvelope {
    let Some(runtime) = context.runtime.clone() else {
        return unavailable(id);
    };
    let Some(control) = context.multi_window.clone() else {
        return unavailable(id);
    };
    match command {
        "window.list" => {
            if parse::<EmptyParams>(&id, params).is_err() {
                return invalid_params(id);
            }
            let state = runtime.snapshot().await;
            let epoch = match runtime.current_idempotency_epoch().await {
                Ok(epoch) => epoch,
                Err(_) => return storage_failure(id),
            };
            serialized(id, window_list(&state, epoch))
        }
        "window.create" => {
            let params = match parse::<WindowCreateParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.source_window.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Window source is outside the binding",
                );
            }
            create_window(id, runtime, control, params).await
        }
        "window.close" => {
            let params = match parse::<WindowCloseParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.window.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Window source is outside the binding",
                );
            }
            close_window(id, runtime, control, params).await
        }
        "window.focus" => {
            let params = match parse::<WindowFocusParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            focus_window(id, runtime, control, params).await
        }
        "window.bind" => {
            let params = match parse::<WindowBindParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            let state = runtime.snapshot().await;
            match control.bind(&state, params).await {
                Ok(binding) => {
                    let Some(placement) = state.window_placement(binding.window_id) else {
                        return failure(id, "target_not_found", "Window placement does not exist");
                    };
                    let mut current = bound_window.lock().await;
                    if current.is_some_and(|existing| existing != binding) {
                        return failure(
                            id,
                            "provider_ineligible",
                            "This connection is already bound to a different window",
                        );
                    }
                    *current = Some(binding);
                    serialized(
                        id,
                        WindowBindResult {
                            window: placement_snapshot(&state, placement),
                        },
                    )
                }
                Err(code) => failure(id, code, "Window binding was denied"),
            }
        }
        "window.bindCli" => {
            let params = match parse::<CliWindowBindParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            let state = runtime.snapshot().await;
            let window_id = match parse_window_id(&params.window_id) {
                Ok(window_id) if state.window_placement(window_id).is_some() => window_id,
                _ => return failure(id, "target_not_found", "Window placement does not exist"),
            };
            let binding = BoundWindow {
                window_id,
                provider: None,
            };
            let mut current = bound_window.lock().await;
            if current.is_some_and(|existing| existing != binding) {
                return failure(id, "placement_required", "Connection is already bound");
            }
            *current = Some(binding);
            let placement = state
                .window_placement(window_id)
                .expect("placement checked above");
            serialized(
                id,
                WindowBindResult {
                    window: placement_snapshot(&state, placement),
                },
            )
        }
        "windowState.getFor" => {
            let params = match parse::<WindowStateGetForParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_matches(
                bound_window,
                &control,
                &runtime.snapshot().await,
                &params.window_id,
            )
            .await
            {
                return failure(
                    id,
                    "placement_required",
                    "Connection is not bound to this window",
                );
            }
            window_state_get_for(id, context, &runtime.snapshot().await, params).await
        }
        "windowState.updateFor" => {
            let params = match parse::<WindowStateUpdateForParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_matches(
                bound_window,
                &control,
                &runtime.snapshot().await,
                &params.window_id,
            )
            .await
            {
                return failure(
                    id,
                    "placement_required",
                    "Connection is not bound to this window",
                );
            }
            window_state_update_for(id, context, &runtime.snapshot().await, params).await
        }
        "closed.list" => {
            if parse::<EmptyParams>(&id, params).is_err() {
                return invalid_params(id);
            }
            let state = runtime.snapshot().await;
            let now = current_timestamp();
            let binding = *bound_window.lock().await;
            serialized(
                id,
                ClosedItemListResult {
                    revision: state.revision,
                    items: state
                        .recently_closed
                        .iter()
                        .filter(|record| {
                            closed_record_visible(record, now)
                                && binding.is_none_or(|binding| {
                                    state
                                        .window_for_workspace(record.prior_workspace_id)
                                        .is_some_and(|window| window.id == binding.window_id)
                                })
                        })
                        .map(closed_snapshot)
                        .collect(),
                },
            )
        }
        "closed.get" => {
            let params = match parse::<ClosedItemGetParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            let closed_item_id = match parse_closed_item_id(&params.closed_item_id) {
                Ok(value) => value,
                Err(()) => return invalid_params(id),
            };
            let state = runtime.snapshot().await;
            let now = current_timestamp();
            let binding = *bound_window.lock().await;
            match state.recently_closed.iter().find(|item| {
                item.id == closed_item_id
                    && closed_record_visible(item, now)
                    && binding.is_none_or(|binding| {
                        state
                            .window_for_workspace(item.prior_workspace_id)
                            .is_some_and(|window| window.id == binding.window_id)
                    })
            }) {
                Some(item) => serialized(
                    id,
                    ClosedItemGetResult {
                        revision: state.revision,
                        item: closed_snapshot(item),
                    },
                ),
                None => failure(
                    id,
                    "source_not_found",
                    "Recently-closed item does not exist",
                ),
            }
        }
        "focusHistory.navigate" => {
            let params = match parse::<FocusHistoryNavigateParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            navigate_focus_history(id, runtime, control, params).await
        }
        "tab.duplicate" => {
            let params = match parse::<TabDuplicateParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.source.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Tab source is outside the binding",
                );
            }
            duplicate_tab(id, runtime, params).await
        }
        "tab.moveExact" => {
            let params = match parse::<TabMoveExactParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.source.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Tab source is outside the binding",
                );
            }
            move_tab_exact(id, runtime, control, params).await
        }
        "tab.detach" => {
            let params = match parse::<TabDetachParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.source.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Tab source is outside the binding",
                );
            }
            detach_tab(id, runtime, control, params).await
        }
        "tab.closeAdvanced" => {
            let params = match parse::<TabCloseAdvancedParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.source.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Tab source is outside the binding",
                );
            }
            close_tab_advanced(id, runtime, params).await
        }
        "tab.reopen" => {
            let params = match parse::<TabReopenParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            if !bound_source_allows(bound_window, &params.target.window_id).await {
                return failure(
                    id,
                    "placement_required",
                    "Tab target is outside the binding",
                );
            }
            reopen_tab(id, runtime, params).await
        }
        "desktopProvider.register" => {
            let params = match parse::<DesktopProviderRegisterParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            let state = runtime.snapshot().await;
            let claimed = match parse_claims(&state, &params.windows) {
                Ok(claims) => claims,
                Err(()) => return invalid_params(id),
            };
            let claimed_ids = claimed.keys().copied().collect::<BTreeSet<_>>();
            let rehomes = match preview_reconciliation_rehomes(&state, &claimed_ids) {
                Ok(rehomes) => rehomes,
                Err(_) => return invalid_params(id),
            };
            match control.register(&state, params).await {
                Ok(registration) => {
                    let provider_id = parse_uuid(&registration.provider_id)
                        .expect("issued provider ID is a UUID");
                    let recovery = if rehomes.is_empty() {
                        None
                    } else {
                        let identity = ParsedIdentity {
                            provider_id,
                            provider_epoch: registration.provider_epoch,
                            lease_id: parse_uuid(&registration.lease_id)
                                .expect("issued lease ID is a UUID"),
                        };
                        let transfer_epoch = state.revision.saturating_add(1);
                        match control
                            .reserve_reconciliation_recovery(
                                &state,
                                &rehomes,
                                &claimed,
                                Some(identity),
                                "desktopProvider.register.recoverOwnership",
                                transfer_epoch,
                            )
                            .await
                        {
                            Ok(reservation) => Some(reservation),
                            Err(code) => {
                                warn!(
                                    code,
                                    "startup recovery unavailable; preserving unhosted source placements"
                                );
                                None
                            }
                        }
                    };
                    let merge_rehomes = rehomes.is_empty() || recovery.is_some();
                    let claimed_for_reconcile = claimed_ids.clone();
                    match runtime
                        .mutate(LaunchOptions::default(), move |state| {
                            if merge_rehomes {
                                state
                                    .reconcile_window_claims(&claimed_for_reconcile)
                                    .map(|reconciliation| reconciliation.outcome)
                            } else {
                                reconcile_claims_without_rehomes(state, &claimed_for_reconcile)
                            }
                        })
                        .await
                    {
                        Ok(commit) => {
                            if let Some(recovery) = recovery {
                                finish_recovery_saga(&control, Arc::clone(&runtime), recovery)
                                    .await;
                            }
                            for target in commit
                                .snapshot
                                .window_placements
                                .iter()
                                .filter(|placement| !claimed_ids.contains(&placement.id))
                                .map(|placement| DesktopProviderWindowClaim {
                                    window_id: placement.id.to_string(),
                                    generation: 1,
                                })
                            {
                                let window_key = parse_window_id(&target.window_id)
                                    .expect("authoritative window ID parses")
                                    .as_uuid();
                                let correlation_id = provider_correlation(
                                    "desktopProvider.register.createWindow",
                                    Uuid::from_u128(u128::from(registration.provider_epoch)),
                                    window_key,
                                );
                                if control
                                    .enqueue(
                                        DesktopProviderOperationKind::CreateWindow,
                                        target,
                                        correlation_id,
                                        None,
                                        None,
                                        None,
                                    )
                                    .await
                                    .is_err()
                                {
                                    control.revoke_registration(provider_id).await;
                                    return failure(
                                        id,
                                        "provider_backpressure",
                                        "Startup window restoration could not be queued",
                                    );
                                }
                            }
                            serialized(id, registration)
                        }
                        Err(_) => {
                            if let Some(recovery) = recovery {
                                control.release_reservation(recovery.reservation).await;
                            }
                            control.revoke_registration(provider_id).await;
                            storage_failure(id)
                        }
                    }
                }
                Err(()) => failure(
                    id,
                    "provider_registration_denied",
                    "Desktop-provider registration was denied",
                ),
            }
        }
        "desktopProvider.heartbeat" => {
            let params = match parse::<DesktopProviderHeartbeatParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            let state = runtime.snapshot().await;
            let claimed = match parse_claims(&state, &params.windows) {
                Ok(claims) => claims,
                Err(()) => return invalid_params(id),
            };
            let claimed_ids = claimed.keys().copied().collect::<BTreeSet<_>>();
            let provider_id = match parse_uuid(&params.provider_id) {
                Ok(value) => value,
                Err(()) => return invalid_params(id),
            };
            let identity = match ParsedIdentity::parse_fields(
                &params.provider_id,
                params.provider_epoch,
                &params.lease_id,
            ) {
                Ok(value) => value,
                Err(_) => return invalid_params(id),
            };
            let rehomes = match preview_reconciliation_rehomes(&state, &claimed_ids) {
                Ok(rehomes) => rehomes,
                Err(_) => return invalid_params(id),
            };
            let recovery = if rehomes.is_empty() {
                None
            } else {
                let transfer_epoch = match state.revision.checked_add(1) {
                    Some(value) => value,
                    None => {
                        return failure(id, "revision_out_of_range", "Recovery epoch overflowed");
                    }
                };
                match control
                    .reserve_reconciliation_recovery(
                        &state,
                        &rehomes,
                        &claimed,
                        Some(identity),
                        "desktopProvider.heartbeat.recoverOwnership",
                        transfer_epoch,
                    )
                    .await
                {
                    Ok(reservation) => Some(reservation),
                    Err(code) => {
                        return failure(
                            id,
                            code,
                            "Desktop-provider recovery capacity is unavailable",
                        );
                    }
                }
            };
            match control.heartbeat(&state, params).await {
                Ok(result) => match runtime
                    .mutate(LaunchOptions::default(), move |state| {
                        state
                            .reconcile_window_claims(&claimed_ids)
                            .map(|reconciliation| reconciliation.outcome)
                    })
                    .await
                {
                    Ok(_) => {
                        if let Some(recovery) = recovery {
                            finish_recovery_saga(&control, Arc::clone(&runtime), recovery).await;
                        }
                        serialized(id, result)
                    }
                    Err(_) => {
                        if let Some(recovery) = recovery {
                            control.release_reservation(recovery.reservation).await;
                        }
                        control.revoke(provider_id).await;
                        storage_failure(id)
                    }
                },
                Err(code) => {
                    if let Some(recovery) = recovery {
                        control.release_reservation(recovery.reservation).await;
                    }
                    failure(id, code, "Desktop-provider heartbeat was denied")
                }
            }
        }
        "desktopProvider.unregister" => {
            let params = match parse::<DesktopProviderUnregisterParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            match control.unregister(params).await {
                Ok(()) => match runtime
                    .mutate(LaunchOptions::default(), move |state| {
                        state
                            .reconcile_window_claims(&BTreeSet::new())
                            .map(|reconciliation| reconciliation.outcome)
                    })
                    .await
                {
                    Ok(_) => {
                        if let Some(actions) = &context.actions
                            && actions.reconcile_provider_lifecycle().await.is_err()
                        {
                            return storage_failure(id);
                        }
                        ResponseEnvelope::success(id, serde_json::json!({}))
                    }
                    Err(_) => storage_failure(id),
                },
                Err(code) => failure(id, code, "Desktop-provider unregister was denied"),
            }
        }
        "desktopProvider.poll" => {
            let params = match parse::<DesktopProviderPollParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            match control.poll(params).await {
                Ok(result) => serialized(id, result),
                Err(code) => failure(id, code, "Desktop-provider poll was denied"),
            }
        }
        "desktopProvider.acknowledge" => {
            let params = match parse::<DesktopProviderAcknowledgeParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            match control.acknowledge(params).await {
                Ok(()) => ResponseEnvelope::success(id, serde_json::json!({})),
                Err(code) => failure(id, code, "Desktop-provider acknowledgement was denied"),
            }
        }
        "desktopProvider.cancel" => {
            let params = match parse::<DesktopProviderCancelParams>(&id, params) {
                Ok(params) => params,
                Err(()) => return invalid_params(id),
            };
            match control.cancel(params).await {
                Ok(()) => ResponseEnvelope::success(id, serde_json::json!({})),
                Err(code) => failure(id, code, "Desktop-provider cancellation was denied"),
            }
        }
        _ => unavailable(id),
    }
}

async fn create_window(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    control: MultiWindowRuntime,
    params: WindowCreateParams,
) -> ResponseEnvelope {
    let workspace_id = match parse_workspace_id(&params.workspace_id) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let source_window_id = match parse_window_id(&params.source_window.window_id) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let epoch = match parse_uuid(&params.mutation.idempotency_epoch) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let key = match parse_uuid(&params.mutation.idempotency_key) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("window.create", epoch, key, &request_json, 4_096);
    let provider_correlation = provider_correlation("window.create", epoch, key);
    let new_window_id = WindowId::new();
    let transfer_epoch = match params.mutation.expected_revision.checked_add(1) {
        Some(value) => value,
        None => return failure(id, "revision_out_of_range", "Transfer epoch overflowed"),
    };
    let before = runtime.snapshot().await;
    let reservation = match control
        .reserve_workspace_window_create(
            &before,
            source_window_id,
            new_window_id,
            workspace_id,
            provider_correlation,
            transfer_epoch,
        )
        .await
    {
        Ok(reservation) => reservation,
        Err(code) => return failure(id, code, "Desktop-provider capacity is unavailable"),
    };
    let label = params.label.clone();
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            vec![(source_window_id, params.source_window.expected_revision)],
            ticket,
            LaunchOptions::default(),
            move |state| state.create_window_placement(new_window_id, label, workspace_id),
            move |state| {
                mutation_result_json(state, epoch, new_window_id)
                    .map_err(|_| StoreError::new("window create result could not be encoded"))
            },
        )
        .await;
    finish_provider_saga(
        &control,
        Arc::clone(&runtime),
        reservation,
        provider_correlation,
        &result,
    )
    .await;
    epoch_response(id, result)
}

async fn close_window(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    control: MultiWindowRuntime,
    params: WindowCloseParams,
) -> ResponseEnvelope {
    let window_id = match parse_window_id(&params.window.window_id) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let epoch = match parse_uuid(&params.mutation.idempotency_epoch) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let key = match parse_uuid(&params.mutation.idempotency_key) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let target_window_id = match params.rehome_target.as_ref() {
        Some(target) => match parse_window_id(&target.window_id) {
            Ok(value) => Some(value),
            Err(()) => return invalid_params(id),
        },
        None => None,
    };
    let before = runtime.snapshot().await;
    let now = current_timestamp();
    let (records, replacement) = if params.policy == WindowClosePolicy::CloseWorkspaces {
        match close_window_inputs(&before, window_id, now) {
            Ok(inputs) => inputs,
            Err(code) => return failure(id, code, "Window workspaces cannot be closed safely"),
        }
    } else {
        (Vec::new(), None)
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("window.close", epoch, key, &request_json, 4_096);
    let provider_correlation = provider_correlation("window.close", epoch, key);
    let transfer_epoch = match params.mutation.expected_revision.checked_add(1) {
        Some(value) => value,
        None => return failure(id, "revision_out_of_range", "Transfer epoch overflowed"),
    };
    let reservation_result = match (params.policy, target_window_id) {
        (WindowClosePolicy::Rehome, Some(target_window_id)) => {
            control
                .reserve_window_rehome(
                    &before,
                    window_id,
                    target_window_id,
                    provider_correlation,
                    transfer_epoch,
                )
                .await
        }
        (WindowClosePolicy::CloseWorkspaces, _) => {
            control
                .reserve_window_operation(
                    DesktopProviderOperationKind::CloseWindow,
                    window_id,
                    None,
                    provider_correlation,
                )
                .await
        }
        (WindowClosePolicy::Rehome, None) => Err("target_not_found"),
    };
    let reservation = match reservation_result {
        Ok(reservation) => reservation,
        Err(code) => return failure(id, code, "Desktop-provider capacity is unavailable"),
    };
    let result_target = target_window_id;
    let policy = params.policy;
    let mut preconditions = vec![(window_id, params.window.expected_revision)];
    if let (Some(target), Some(target_id)) = (&params.rehome_target, target_window_id) {
        preconditions.push((target_id, target.expected_revision));
    }
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            preconditions,
            ticket,
            LaunchOptions::default(),
            move |state| match policy {
                WindowClosePolicy::Rehome => {
                    state.close_window_placement(window_id, target_window_id)
                }
                WindowClosePolicy::CloseWorkspaces => {
                    state.close_window_workspaces(window_id, replacement, records, now)
                }
            },
            move |state| {
                let rehome_target = result_target
                    .and_then(|target| state.window_placement(target))
                    .map(|placement| placement_snapshot(state, placement));
                serde_json::to_string(&WindowCloseResult {
                    revision: state.revision,
                    idempotency_epoch: epoch.to_string(),
                    closed_window_id: window_id.to_string(),
                    rehome_target,
                    replayed: false,
                })
                .map_err(|_| StoreError::new("window close result could not be encoded"))
            },
        )
        .await;
    finish_provider_saga(
        &control,
        Arc::clone(&runtime),
        reservation,
        provider_correlation,
        &result,
    )
    .await;
    epoch_response(id, result)
}

async fn navigate_focus_history(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    control: MultiWindowRuntime,
    params: FocusHistoryNavigateParams,
) -> ResponseEnvelope {
    let epoch = match parse_uuid(&params.mutation.idempotency_epoch) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let key = match parse_uuid(&params.mutation.idempotency_key) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket =
        epoch_idempotency_ticket("focusHistory.navigate", epoch, key, &request_json, 4_096);
    let provider_correlation = provider_correlation("focusHistory.navigate", epoch, key);
    let direction = params.direction;
    let mut candidate = runtime.snapshot().await;
    let candidate_result = match direction {
        FocusNavigationDirection::Back => candidate.focus_back(),
        FocusNavigationDirection::Forward => candidate.focus_forward(),
    };
    if candidate_result.is_err() {
        return failure(
            id,
            "target_not_found",
            "Focus history target does not exist",
        );
    }
    let Some(target) = current_focus_target(&candidate) else {
        return failure(
            id,
            "target_not_found",
            "Focus history target does not exist",
        );
    };
    let reservation = match control
        .reserve_window_operation(
            DesktopProviderOperationKind::FocusWindow,
            target.window_id,
            None,
            provider_correlation,
        )
        .await
    {
        Ok(reservation) => reservation,
        Err(code) => return failure(id, code, "Desktop-provider capacity is unavailable"),
    };
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            Vec::new(),
            ticket,
            LaunchOptions::default(),
            move |state| match direction {
                FocusNavigationDirection::Back => state.focus_back(),
                FocusNavigationDirection::Forward => state.focus_forward(),
            },
            move |state| {
                let target = current_focus_target(state).ok_or_else(|| {
                    StoreError::new("focus history result has no authoritative target")
                })?;
                serde_json::to_string(&FocusHistoryNavigateResult {
                    revision: state.revision,
                    idempotency_epoch: epoch.to_string(),
                    target: focus_target_snapshot(target),
                    replayed: false,
                })
                .map_err(|_| StoreError::new("focus history result could not be encoded"))
            },
        )
        .await;
    finish_provider_saga(
        &control,
        Arc::clone(&runtime),
        reservation,
        provider_correlation,
        &result,
    )
    .await;
    epoch_response(id, result)
}

async fn duplicate_tab(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    params: TabDuplicateParams,
) -> ResponseEnvelope {
    let before = runtime.snapshot().await;
    let source = match parse_tab_source(&before, &params.source) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab source is not authoritative"),
    };
    let target = match parse_tab_target(&before, &params.target) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab target is not authoritative"),
    };
    let preconditions = match transfer_preconditions(&params.source, &params.target) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Window preconditions conflict"),
    };
    let (epoch, key) = match mutation_identity(&params.mutation) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("tab.duplicate", epoch, key, &request_json, 4_096);
    let new_tab_id = TabId::new();
    let now = current_timestamp();
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            preconditions,
            ticket,
            LaunchOptions::default(),
            move |state| {
                state.duplicate_tab(
                    source.workspace_id,
                    source.tab_id,
                    target.workspace_id,
                    target.pane_id,
                    target.index,
                    new_tab_id,
                    now,
                    now,
                )
            },
            move |state| advanced_result_json(state, epoch, target.workspace_id, new_tab_id, None),
        )
        .await;
    epoch_response(id, result)
}

async fn move_tab_exact(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    control: MultiWindowRuntime,
    params: TabMoveExactParams,
) -> ResponseEnvelope {
    let before = runtime.snapshot().await;
    let source = match parse_tab_source(&before, &params.source) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab source is not authoritative"),
    };
    let target = match parse_tab_target(&before, &params.target) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab target is not authoritative"),
    };
    let preconditions = match transfer_preconditions(&params.source, &params.target) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Window preconditions conflict"),
    };
    let replacement = if source.workspace_id == target.workspace_id {
        None
    } else {
        match replacement_for_tab_removal(&before, source.workspace_id, source.tab_id) {
            Ok(value) => value,
            Err(code) => return failure(id, code, "Source tab cannot be moved safely"),
        }
    };
    let (epoch, key) = match mutation_identity(&params.mutation) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("tab.moveExact", epoch, key, &request_json, 4_096);
    let provider_correlation = provider_correlation("tab.moveExact", epoch, key);
    let now = current_timestamp();
    let tab_id = source.tab_id;
    let reservation = if source.window_id == target.window_id {
        ProviderReservation::Existing
    } else {
        let Some(tab) = before
            .workspaces
            .iter()
            .find(|workspace| workspace.id == source.workspace_id)
            .and_then(|workspace| workspace.tabs.get(&source.tab_id))
        else {
            return failure(id, "source_not_found", "Tab source is not authoritative");
        };
        let (runtime_session_id, ownership_kind, browser) = match &tab.content {
            TabContent::Terminal {
                runtime_session_id: Some(runtime_session_id),
                ..
            } => (
                runtime_session_id.to_string(),
                RuntimeOwnershipKind::Terminal,
                None,
            ),
            TabContent::Browser { metadata } => (
                metadata.browser_session_id().to_string(),
                RuntimeOwnershipKind::Browser,
                Some(BrowserOwnershipTransferDescriptor {
                    browser_session_id: metadata.browser_session_id().to_string(),
                    url: metadata.url().to_owned(),
                    title: metadata.navigation_title().to_owned(),
                    profile_partition: metadata.profile_partition().to_owned(),
                    state_revision: metadata.state_revision(),
                    lifecycle_id: Uuid::nil().to_string(),
                }),
            ),
            TabContent::Terminal {
                runtime_session_id: None,
                ..
            } => {
                return failure(
                    id,
                    "transfer_conflict",
                    "Terminal ownership is not bound to a runtime session",
                );
            }
        };
        let transfer_epoch = match params.mutation.expected_revision.checked_add(1) {
            Some(value) => value,
            None => return failure(id, "revision_out_of_range", "Transfer epoch overflowed"),
        };
        let source_pane = match parse_pane_id(&params.source.pane_id) {
            Ok(value) => value,
            Err(()) => return invalid_params(id),
        };
        match control
            .reserve_tab_transfer(
                source.window_id,
                target.window_id,
                false,
                provider_correlation,
                transfer_epoch,
                source.tab_id,
                runtime_session_id,
                ownership_kind,
                browser,
                source.workspace_id,
                source_pane,
                target.workspace_id,
                target.pane_id,
            )
            .await
        {
            Ok(reservation) => reservation,
            Err(code) => return failure(id, code, "Desktop-provider capacity is unavailable"),
        }
    };
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            preconditions,
            ticket,
            LaunchOptions::default(),
            move |state| {
                state.move_tab_to_workspace(
                    source.workspace_id,
                    tab_id,
                    target.workspace_id,
                    target.pane_id,
                    target.index,
                    replacement,
                    now,
                )
            },
            move |state| advanced_result_json(state, epoch, target.workspace_id, tab_id, None),
        )
        .await;
    finish_provider_saga(
        &control,
        Arc::clone(&runtime),
        reservation,
        provider_correlation,
        &result,
    )
    .await;
    epoch_response(id, result)
}

async fn detach_tab(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    control: MultiWindowRuntime,
    params: TabDetachParams,
) -> ResponseEnvelope {
    let before = runtime.snapshot().await;
    let source = match parse_tab_source(&before, &params.source) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab source is not authoritative"),
    };
    let source_workspace = before
        .workspaces
        .iter()
        .find(|workspace| workspace.id == source.workspace_id)
        .expect("source validation found the workspace");
    let working_directory = source_workspace.working_directory.clone();
    let replacement = match replacement_for_tab_removal(&before, source.workspace_id, source.tab_id)
    {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Source tab cannot be detached safely"),
    };
    let (epoch, key) = match mutation_identity(&params.mutation) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("tab.detach", epoch, key, &request_json, 4_096);
    let provider_correlation = provider_correlation("tab.detach", epoch, key);
    let workspace_id = WorkspaceId::new();
    let pane_id = PaneId::new();
    let window_id = WindowId::new();
    let tab_id = source.tab_id;
    let label = params.window_label.clone();
    let workspace_name = if label.is_empty() {
        "Detached".to_owned()
    } else {
        label.clone()
    };
    let now = current_timestamp();
    let tab = source_workspace
        .tabs
        .get(&source.tab_id)
        .expect("source validation found the tab");
    let (runtime_session_id, ownership_kind, browser) = match ownership_transfer_resource(tab) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab ownership cannot be transferred"),
    };
    let source_pane = match parse_pane_id(&params.source.pane_id) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let transfer_epoch = match params.mutation.expected_revision.checked_add(1) {
        Some(value) => value,
        None => return failure(id, "revision_out_of_range", "Transfer epoch overflowed"),
    };
    let reservation = match control
        .reserve_tab_transfer(
            source.window_id,
            window_id,
            true,
            provider_correlation,
            transfer_epoch,
            source.tab_id,
            runtime_session_id,
            ownership_kind,
            browser,
            source.workspace_id,
            source_pane,
            workspace_id,
            pane_id,
        )
        .await
    {
        Ok(reservation) => reservation,
        Err(code) => return failure(id, code, "Desktop-provider capacity is unavailable"),
    };
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            vec![(source.window_id, params.source.expected_window_revision)],
            ticket,
            LaunchOptions::default(),
            move |state| {
                state.detach_tab_to_window(
                    source.workspace_id,
                    tab_id,
                    replacement,
                    workspace_id,
                    workspace_name,
                    working_directory,
                    pane_id,
                    window_id,
                    label,
                    now,
                    now,
                )
            },
            move |state| advanced_result_json(state, epoch, workspace_id, tab_id, None),
        )
        .await;
    finish_provider_saga(
        &control,
        Arc::clone(&runtime),
        reservation,
        provider_correlation,
        &result,
    )
    .await;
    epoch_response(id, result)
}

async fn close_tab_advanced(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    params: TabCloseAdvancedParams,
) -> ResponseEnvelope {
    let before = runtime.snapshot().await;
    let source = match parse_tab_source(&before, &params.source) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab source is not authoritative"),
    };
    let workspace = before
        .workspaces
        .iter()
        .find(|workspace| workspace.id == source.workspace_id)
        .expect("source validation found the workspace");
    let tab = workspace
        .tabs
        .get(&source.tab_id)
        .expect("source validation found the tab");
    let now = current_timestamp();
    let record = match closed_record_for_tab(workspace, tab, now) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab restore metadata cannot be recorded safely"),
    };
    let closed_item_id = record.id;
    let replacement = match replacement_for_tab_removal(&before, source.workspace_id, source.tab_id)
    {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab cannot be closed safely"),
    };
    let (epoch, key) = match mutation_identity(&params.mutation) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("tab.closeAdvanced", epoch, key, &request_json, 4_096);
    let tab_id = source.tab_id;
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            vec![(source.window_id, params.source.expected_window_revision)],
            ticket,
            LaunchOptions::default(),
            move |state| {
                state.close_tab_with_record(
                    source.workspace_id,
                    tab_id,
                    replacement,
                    record,
                    now,
                    now,
                )
            },
            move |state| {
                serde_json::to_string(&AdvancedTabCloseResult {
                    revision: state.revision,
                    idempotency_epoch: epoch.to_string(),
                    closed_tab_id: tab_id.to_string(),
                    closed_item_id: closed_item_id.to_string(),
                    replayed: false,
                })
                .map_err(|_| StoreError::new("advanced tab close result could not be encoded"))
            },
        )
        .await;
    epoch_response(id, result)
}

async fn reopen_tab(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    params: TabReopenParams,
) -> ResponseEnvelope {
    let before = runtime.snapshot().await;
    let target = match parse_tab_target(&before, &params.target) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Tab target is not authoritative"),
    };
    let closed_item_id = match parse_closed_item_id(&params.closed_item_id) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let record = match before
        .recently_closed
        .iter()
        .find(|record| record.id == closed_item_id)
    {
        Some(record) if record.item_kind == agent_workspace_core::ClosedItemKind::Tab => record,
        _ => return failure(id, "source_not_found", "Closed tab record does not exist"),
    };
    let new_tab_id = TabId::new();
    let now = current_timestamp();
    let tab = match reopened_tab_from_record(&before, record, new_tab_id, target.pane_id, now) {
        Ok(tab) => tab,
        Err(code) => return failure(id, code, "Closed tab cannot be restored safely"),
    };
    let (epoch, key) = match mutation_identity(&params.mutation) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("tab.reopen", epoch, key, &request_json, 4_096);
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            vec![(target.window_id, params.target.expected_window_revision)],
            ticket,
            LaunchOptions::default(),
            move |state| {
                state.reopen_closed_tab(
                    closed_item_id,
                    target.workspace_id,
                    target.pane_id,
                    target.index,
                    tab,
                    now,
                )
            },
            move |state| advanced_result_json(state, epoch, target.workspace_id, new_tab_id, None),
        )
        .await;
    epoch_response(id, result)
}

pub(super) async fn reopen_tab_from_sidebar(
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    params: TabReopenParams,
) -> ResponseEnvelope {
    reopen_tab(Uuid::new_v4().to_string(), runtime, params).await
}

async fn focus_window(
    id: String,
    runtime: Arc<agent_workspace_runtime::ProductionWorkspaceRuntime>,
    control: MultiWindowRuntime,
    params: WindowFocusParams,
) -> ResponseEnvelope {
    let window_id = match parse_window_id(&params.window.window_id) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let epoch = match parse_uuid(&params.mutation.idempotency_epoch) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let key = match parse_uuid(&params.mutation.idempotency_key) {
        Ok(value) => value,
        Err(()) => return invalid_params(id),
    };
    let snapshot = runtime.snapshot().await;
    let focus = match focus_for_window(&snapshot, window_id) {
        Ok(value) => value,
        Err(code) => return failure(id, code, "Window focus target does not exist"),
    };
    let request_json = serde_json::to_string(&params).expect("validated request serializes");
    let ticket = epoch_idempotency_ticket("window.focus", epoch, key, &request_json, 4_096);
    let provider_correlation = provider_correlation("window.focus", epoch, key);
    let reservation = match control
        .reserve_window_operation(
            DesktopProviderOperationKind::FocusWindow,
            window_id,
            None,
            provider_correlation,
        )
        .await
    {
        Ok(reservation) => reservation,
        Err(code) => return failure(id, code, "Desktop-provider capacity is unavailable"),
    };
    let result = runtime
        .mutate_multi_window_idempotent(
            params.mutation.expected_revision,
            vec![(window_id, params.window.expected_revision)],
            ticket,
            LaunchOptions::default(),
            move |state| state.focus_target(focus),
            move |state| {
                mutation_result_json(state, epoch, window_id)
                    .map_err(|_| StoreError::new("window focus result could not be encoded"))
            },
        )
        .await;
    finish_provider_saga(
        &control,
        Arc::clone(&runtime),
        reservation,
        provider_correlation,
        &result,
    )
    .await;
    epoch_response(id, result)
}

async fn finish_provider_saga(
    control: &MultiWindowRuntime,
    runtime: Arc<ProductionWorkspaceRuntime>,
    reservation: ProviderReservation,
    correlation_id: Uuid,
    result: &Result<EpochIdempotentCommitResult, OperationFailure>,
) {
    if matches!(result, Ok(EpochIdempotentCommitResult::Committed { .. })) {
        let reserved_requests = control.reservation_requests(&reservation).await;
        let reserved_recovery_templates =
            recovery_templates_from_provider_requests(&reserved_requests);
        match control.publish_reservation(reservation).await {
            Ok(receivers) => {
                let control = control.clone();
                tokio::spawn(async move {
                    let recovery_templates = reserved_recovery_templates;
                    for (_, receiver) in receivers {
                        if !matches!(receiver.await, Ok(ProviderCompletion::Succeeded)) {
                            control.cancel_queued_correlation(correlation_id).await;
                            if recovery_templates.is_empty() {
                                reconcile_after_provider_failure(
                                    &control,
                                    &runtime,
                                    &BTreeSet::new(),
                                )
                                .await;
                            } else {
                                match control
                                    .reserve_exact_recovery_requests(
                                        &recovery_templates,
                                        "providerSaga.recoverOwnership",
                                        correlation_id,
                                    )
                                    .await
                                {
                                    Ok(recovery) => {
                                        finish_recovery_saga(
                                            &control,
                                            Arc::clone(&runtime),
                                            recovery,
                                        )
                                        .await;
                                    }
                                    Err(code) => {
                                        warn!(code, "provider saga recovery could not be reserved");
                                        let targets = recovery_templates
                                            .iter()
                                            .filter_map(|request| {
                                                parse_window_id(&request.target.window_id).ok()
                                            })
                                            .collect();
                                        mark_recovery_targets_unhosted(&runtime, targets).await;
                                    }
                                }
                            }
                            return;
                        }
                    }
                });
            }
            Err(code) => {
                warn!(
                    code,
                    "post-commit desktop-provider publication requires recovery"
                );
                if !reserved_recovery_templates.is_empty() {
                    match control
                        .reserve_exact_recovery_requests(
                            &reserved_recovery_templates,
                            "providerSaga.publishFailure.recoverOwnership",
                            correlation_id,
                        )
                        .await
                    {
                        Ok(recovery) => {
                            finish_recovery_saga(control, Arc::clone(&runtime), recovery).await;
                        }
                        Err(recovery_code) => {
                            warn!(
                                recovery_code,
                                "post-commit ownership recovery could not be reserved"
                            );
                            let targets = reserved_recovery_templates
                                .iter()
                                .filter_map(|request| {
                                    parse_window_id(&request.target.window_id).ok()
                                })
                                .collect();
                            mark_recovery_targets_unhosted(&runtime, targets).await;
                        }
                    }
                }
            }
        }
    } else {
        control.release_reservation(reservation).await;
    }
}

async fn finish_recovery_saga(
    control: &MultiWindowRuntime,
    runtime: Arc<ProductionWorkspaceRuntime>,
    saga: ReservedRecoverySaga,
) {
    let ReservedRecoverySaga {
        reservation,
        correlation_id,
        target_windows,
        requests,
    } = saga;
    match control.publish_reservation(reservation).await {
        Ok(receivers) if receivers.is_empty() => {}
        Ok(receivers) => {
            let control = control.clone();
            tokio::spawn(async move {
                for (_, receiver) in receivers {
                    if !matches!(receiver.await, Ok(ProviderCompletion::Succeeded)) {
                        control.cancel_queued_correlation(correlation_id).await;
                        if retry_recovery_requests(&control, &requests, correlation_id).await {
                            return;
                        }
                        mark_recovery_targets_unhosted(&runtime, target_windows).await;
                        return;
                    }
                }
            });
        }
        Err(code) => {
            warn!(code, "recovery ownership publication failed");
            if retry_recovery_requests(control, &requests, correlation_id).await {
                return;
            }
            mark_recovery_targets_unhosted(&runtime, target_windows).await;
        }
    }
}

async fn retry_recovery_requests(
    control: &MultiWindowRuntime,
    requests: &[DesktopProviderRequest],
    original_correlation: Uuid,
) -> bool {
    let retry = match control
        .reserve_exact_recovery_requests(requests, "recoverOwnership.retry", original_correlation)
        .await
    {
        Ok(retry) => retry,
        Err(code) => {
            warn!(code, "recovery ownership retry could not be reserved");
            return false;
        }
    };
    match control.publish_reservation(retry.reservation).await {
        Ok(receivers) => {
            for (_, receiver) in receivers {
                if !matches!(receiver.await, Ok(ProviderCompletion::Succeeded)) {
                    warn!("recovery ownership retry failed");
                    return false;
                }
            }
            true
        }
        Err(code) => {
            warn!(code, "recovery ownership retry publication failed");
            false
        }
    }
}

async fn mark_recovery_targets_unhosted(
    runtime: &ProductionWorkspaceRuntime,
    target_windows: BTreeSet<WindowId>,
) {
    if let Err(error) = runtime
        .mutate(LaunchOptions::default(), move |state| {
            mark_recovery_targets_unhosted_in_state(state, target_windows)
        })
        .await
    {
        warn!(%error, "recovery ownership failure could not mark target unhosted");
    } else {
        warn!("recovery ownership failed; affected placement marked unhosted");
    }
}

fn mark_recovery_targets_unhosted_in_state(
    state: &mut ApplicationState,
    target_windows: BTreeSet<WindowId>,
) -> Result<MutationOutcome, DomainError> {
    let mut targets = target_windows.into_iter();
    let first = targets
        .next()
        .expect("a recovery saga always has a durable target");
    let mut outcome = state.set_window_hosting_state(first, HostingState::Unhosted)?;
    for window_id in targets {
        outcome = state.set_window_hosting_state(window_id, HostingState::Unhosted)?;
    }
    Ok(outcome)
}

pub(super) async fn reconcile_after_provider_failure(
    control: &MultiWindowRuntime,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    ineligible_windows: &BTreeSet<WindowId>,
) {
    let snapshot = runtime.snapshot().await;
    let claimed = control
        .active_claim_map()
        .await
        .into_iter()
        .filter(|(window_id, _)| {
            !ineligible_windows.contains(window_id)
                && snapshot.window_placement(*window_id).is_some()
        })
        .collect::<BTreeMap<_, _>>();
    let claimed_ids = claimed.keys().copied().collect::<BTreeSet<_>>();
    let rehomes = match preview_reconciliation_rehomes(&snapshot, &claimed_ids) {
        Ok(rehomes) => rehomes,
        Err(error) => {
            warn!(%error, "desktop-provider failure reconciliation preview failed");
            return;
        }
    };
    let recovery = if rehomes.is_empty() {
        None
    } else {
        match control
            .reserve_reconciliation_recovery(
                &snapshot,
                &rehomes,
                &claimed,
                None,
                "desktopProvider.failure.recoverOwnership",
                snapshot.revision.saturating_add(1),
            )
            .await
        {
            Ok(reservation) => Some(reservation),
            Err(code) => {
                warn!(
                    code,
                    "provider failure recovery unavailable; retaining unhosted sources"
                );
                None
            }
        }
    };
    let merge_rehomes = rehomes.is_empty() || recovery.is_some();
    match runtime
        .mutate(LaunchOptions::default(), move |state| {
            if merge_rehomes {
                state
                    .reconcile_window_claims(&claimed_ids)
                    .map(|reconciliation| reconciliation.outcome)
            } else {
                reconcile_claims_without_rehomes(state, &claimed_ids)
            }
        })
        .await
    {
        Ok(_) => {
            if let Some(recovery) = recovery {
                finish_recovery_saga(control, Arc::clone(runtime), recovery).await;
            }
        }
        Err(error) => {
            if let Some(recovery) = recovery {
                control.release_reservation(recovery.reservation).await;
            }
            warn!(%error, "desktop-provider failure reconciliation failed");
        }
    }
}

async fn window_state_get_for(
    id: String,
    context: &ControlContext,
    state: &ApplicationState,
    params: WindowStateGetForParams,
) -> ResponseEnvelope {
    let Some(persistence) = context.persistence.clone() else {
        return unavailable(id);
    };
    let window_id = match parse_window_id(&params.window_id) {
        Ok(value) if state.window_placement(value).is_some() => value,
        _ => return failure(id, "target_not_found", "Window placement does not exist"),
    };
    let _guard = persistence.window_state_lock.lock().await;
    let store = Arc::clone(&persistence.state_store);
    match tokio::task::spawn_blocking(move || store.load_window_state_for(window_id)).await {
        Ok(Ok(stored)) => {
            let state = match stored.map(window_snapshot).transpose() {
                Ok(state) => state,
                Err(()) => return storage_failure(id),
            };
            serialized_at_independent_revision(
                id,
                state.as_ref().map(|state| state.revision),
                WindowStateGetForResult {
                    window_id: params.window_id,
                    state,
                },
            )
        }
        _ => storage_failure(id),
    }
}

async fn window_state_update_for(
    id: String,
    context: &ControlContext,
    state: &ApplicationState,
    params: WindowStateUpdateForParams,
) -> ResponseEnvelope {
    let Some(persistence) = context.persistence.clone() else {
        return unavailable(id);
    };
    let window_id = match parse_window_id(&params.window_id) {
        Ok(value) if state.window_placement(value).is_some() => value,
        _ => return failure(id, "target_not_found", "Window placement does not exist"),
    };
    let _guard = persistence.window_state_lock.lock().await;
    let store = Arc::clone(&persistence.state_store);
    let stored = stored_window_state(params.state.clone());
    match tokio::task::spawn_blocking(move || store.save_window_state_for(window_id, &stored)).await
    {
        Ok(Ok(())) => serialized_at_independent_revision(
            id,
            Some(params.state.revision),
            WindowStateGetForResult {
                window_id: params.window_id,
                state: Some(params.state),
            },
        ),
        Ok(Err(StorageError::StaleWindowStateRevision { .. })) => {
            failure(id, "stale_revision", "Window-state revision is stale")
        }
        Ok(Err(StorageError::WindowStateRevisionConflict { .. })) => {
            failure(id, "stale_revision", "Window-state revision conflicts")
        }
        _ => storage_failure(id),
    }
}

#[derive(Clone, Copy)]
struct ParsedTabSource {
    window_id: WindowId,
    workspace_id: WorkspaceId,
    tab_id: TabId,
}

#[derive(Clone, Copy)]
struct ParsedTabTarget {
    window_id: WindowId,
    workspace_id: WorkspaceId,
    pane_id: PaneId,
    index: usize,
}

fn parse_tab_source(
    state: &ApplicationState,
    source: &TabSource,
) -> Result<ParsedTabSource, &'static str> {
    let window_id = parse_window_id(&source.window_id).map_err(|_| "source_not_found")?;
    let workspace_id = parse_workspace_id(&source.workspace_id).map_err(|_| "source_not_found")?;
    let pane_id = parse_pane_id(&source.pane_id).map_err(|_| "source_not_found")?;
    let tab_id = parse_tab_id(&source.tab_id).map_err(|_| "source_not_found")?;
    let placement = state
        .window_placement(window_id)
        .filter(|placement| placement.workspace_ids.contains(&workspace_id))
        .ok_or("source_not_found")?;
    if placement.revision != source.expected_window_revision {
        return Err("stale_window_revision");
    }
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or("source_not_found")?;
    let pane = workspace.panes.get(&pane_id).ok_or("source_not_found")?;
    let tab = workspace.tabs.get(&tab_id).ok_or("source_not_found")?;
    if tab.pane_id != pane_id || !pane.tabs.contains(&tab_id) {
        return Err("source_not_found");
    }
    Ok(ParsedTabSource {
        window_id,
        workspace_id,
        tab_id,
    })
}

fn parse_tab_target(
    state: &ApplicationState,
    target: &ExactTabPlacement,
) -> Result<ParsedTabTarget, &'static str> {
    let window_id = parse_window_id(&target.window_id).map_err(|_| "target_not_found")?;
    let workspace_id = parse_workspace_id(&target.workspace_id).map_err(|_| "target_not_found")?;
    let pane_id = parse_pane_id(&target.pane_id).map_err(|_| "target_not_found")?;
    let placement = state
        .window_placement(window_id)
        .filter(|placement| placement.workspace_ids.contains(&workspace_id))
        .ok_or("target_not_found")?;
    if placement.revision != target.expected_window_revision {
        return Err("stale_window_revision");
    }
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or("target_not_found")?;
    let pane = workspace.panes.get(&pane_id).ok_or("target_not_found")?;
    let index = usize::try_from(target.destination_index).map_err(|_| "target_not_found")?;
    if index > pane.tabs.len() {
        return Err("target_not_found");
    }
    Ok(ParsedTabTarget {
        window_id,
        workspace_id,
        pane_id,
        index,
    })
}

fn transfer_preconditions(
    source: &TabSource,
    target: &ExactTabPlacement,
) -> Result<Vec<(WindowId, u64)>, &'static str> {
    let source_id = parse_window_id(&source.window_id).map_err(|_| "source_not_found")?;
    let target_id = parse_window_id(&target.window_id).map_err(|_| "target_not_found")?;
    if source_id == target_id {
        if source.expected_window_revision != target.expected_window_revision {
            return Err("stale_window_revision");
        }
        Ok(vec![(source_id, source.expected_window_revision)])
    } else {
        Ok(vec![
            (source_id, source.expected_window_revision),
            (target_id, target.expected_window_revision),
        ])
    }
}

fn mutation_identity(token: &MultiWindowMutationToken) -> Result<(Uuid, Uuid), ()> {
    Ok((
        parse_uuid(&token.idempotency_epoch)?,
        parse_uuid(&token.idempotency_key)?,
    ))
}

fn replacement_for_tab_removal(
    state: &ApplicationState,
    workspace_id: WorkspaceId,
    tab_id: TabId,
) -> Result<Option<Tab>, &'static str> {
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or("source_not_found")?;
    if workspace.tabs.len() > 1 {
        return Ok(None);
    }
    let tab = workspace.tabs.get(&tab_id).ok_or("source_not_found")?;
    let launch = TerminalLaunchSpec::new(workspace.working_directory.clone(), None, 24, 80)
        .map_err(|_| "policy_denied")?;
    Tab::terminal(
        TabId::new(),
        tab.pane_id,
        "Terminal",
        launch,
        None,
        current_timestamp(),
    )
    .map(Some)
    .map_err(|_| "policy_denied")
}

fn reopened_tab_from_record(
    state: &ApplicationState,
    record: &ClosedItemRecord,
    tab_id: TabId,
    pane_id: PaneId,
    now: Timestamp,
) -> Result<Tab, &'static str> {
    let title = if record.title.is_empty() {
        match record.content_kind {
            agent_workspace_core::ClosedContentKind::Terminal => "Terminal",
            agent_workspace_core::ClosedContentKind::Browser => "Browser",
        }
    } else {
        &record.title
    };
    match &record.restore {
        RestoreDescriptor::Terminal {
            authorized_root_id,
            root_relative_cwd,
            rows,
            cols,
        } => {
            let root = state
                .workspaces
                .iter()
                .find(|workspace| workspace.id == *authorized_root_id)
                .ok_or("policy_denied")?;
            let cwd = restore_terminal_cwd(&root.working_directory, root_relative_cwd);
            let launch =
                TerminalLaunchSpec::new(cwd, None, *rows, *cols).map_err(|_| "policy_denied")?;
            Tab::terminal(tab_id, pane_id, title, launch, None, now).map_err(|_| "policy_denied")
        }
        RestoreDescriptor::Browser { url } => {
            let metadata = BrowserMetadata::new(url).map_err(|_| "policy_denied")?;
            Tab::browser(tab_id, pane_id, title, metadata, now).map_err(|_| "policy_denied")
        }
    }
}

fn restore_terminal_cwd(root: &std::path::Path, relative: &std::path::Path) -> std::path::PathBuf {
    if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    }
}

fn advanced_result_json(
    state: &ApplicationState,
    epoch: Uuid,
    workspace_id: WorkspaceId,
    tab_id: TabId,
    closed_item_id: Option<ClosedItemId>,
) -> Result<String, StoreError> {
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| StoreError::new("advanced result workspace does not exist"))?;
    let tab = workspace
        .tabs
        .get(&tab_id)
        .ok_or_else(|| StoreError::new("advanced result tab does not exist"))?;
    let pane = workspace
        .panes
        .get(&tab.pane_id)
        .ok_or_else(|| StoreError::new("advanced result pane does not exist"))?;
    let index = pane
        .tabs
        .iter()
        .position(|id| *id == tab_id)
        .ok_or_else(|| StoreError::new("advanced result tab is not pane-owned"))?;
    let placement = state
        .window_for_workspace(workspace_id)
        .ok_or_else(|| StoreError::new("advanced result window does not exist"))?;
    let (runtime_session_id, ownership_kind) = match &tab.content {
        TabContent::Terminal {
            runtime_session_id, ..
        } => (
            runtime_session_id.as_ref().map(ToString::to_string),
            RuntimeOwnershipKind::Terminal,
        ),
        TabContent::Browser { metadata } => (
            Some(metadata.browser_session_id().to_string()),
            RuntimeOwnershipKind::Browser,
        ),
    };
    serde_json::to_string(&AdvancedTabMutationResult {
        revision: state.revision,
        idempotency_epoch: epoch.to_string(),
        tab_id: tab_id.to_string(),
        runtime_session_id,
        ownership_kind,
        placement: TabPlacementSnapshot {
            window_id: placement.id.to_string(),
            workspace_id: workspace_id.to_string(),
            pane_id: pane.id.to_string(),
            index: u32::try_from(index).expect("authoritative tab capacity fits u32"),
            window_revision: placement.revision,
        },
        closed_item_id: closed_item_id.map(|id| id.to_string()),
        transfer_epoch: state.revision,
        replayed: false,
    })
    .map_err(|_| StoreError::new("advanced tab result could not be encoded"))
}

fn focus_for_window(
    state: &ApplicationState,
    window_id: WindowId,
) -> Result<FocusTarget, &'static str> {
    let placement = state
        .window_placement(window_id)
        .ok_or("target_not_found")?;
    if placement.hosting_state == HostingState::Unhosted {
        return Err("window_unhosted");
    }
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == placement.focused_workspace_id)
        .ok_or("target_not_found")?;
    let pane = workspace
        .panes
        .get(&workspace.selected_pane_id)
        .ok_or("target_not_found")?;
    Ok(FocusTarget {
        window_id,
        workspace_id: workspace.id,
        pane_id: pane.id,
        tab_id: pane.selected_tab_id,
    })
}

fn current_focus_target(state: &ApplicationState) -> Option<FocusTarget> {
    let placement = state.window_placement(state.focused_window_id)?;
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == placement.focused_workspace_id)?;
    let pane = workspace.panes.get(&workspace.selected_pane_id)?;
    Some(FocusTarget {
        window_id: placement.id,
        workspace_id: workspace.id,
        pane_id: pane.id,
        tab_id: pane.selected_tab_id,
    })
}

fn focus_target_snapshot(target: FocusTarget) -> FocusTargetSnapshot {
    FocusTargetSnapshot {
        window_id: target.window_id.to_string(),
        workspace_id: target.workspace_id.to_string(),
        pane_id: target.pane_id.to_string(),
        tab_id: target.tab_id.to_string(),
    }
}

fn close_window_inputs(
    state: &ApplicationState,
    window_id: WindowId,
    now: Timestamp,
) -> Result<(Vec<ClosedItemRecord>, Option<Workspace>), &'static str> {
    let placement = state
        .window_placement(window_id)
        .ok_or("source_not_found")?;
    let closing_ids = placement
        .workspace_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let closing_workspaces = state
        .workspaces
        .iter()
        .filter(|workspace| closing_ids.contains(&workspace.id))
        .collect::<Vec<_>>();
    let records = closing_workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .tabs
                .values()
                .map(move |tab| closed_record_for_tab(workspace, tab, now))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let replacement = (closing_ids.len() == state.workspaces.len())
        .then(|| replacement_workspace(&closing_workspaces, now))
        .transpose()?;
    Ok((records, replacement))
}

fn replacement_workspace(
    closing_workspaces: &[&Workspace],
    now: Timestamp,
) -> Result<Workspace, &'static str> {
    let working_directory = closing_workspaces
        .first()
        .ok_or("source_not_found")?
        .working_directory
        .clone();
    let workspace_id = WorkspaceId::new();
    let pane_id = PaneId::new();
    let tab_id = TabId::new();
    let launch = TerminalLaunchSpec::new(working_directory.clone(), None, 24, 80)
        .map_err(|_| "policy_denied")?;
    let tab = Tab::terminal(tab_id, pane_id, "Terminal", launch, None, now)
        .map_err(|_| "policy_denied")?;
    Workspace::new(
        workspace_id,
        "Workspace",
        working_directory,
        pane_id,
        tab,
        now,
        now,
    )
    .map_err(|_| "policy_denied")
}

pub(super) fn closed_record_for_tab(
    workspace: &Workspace,
    tab: &Tab,
    now: Timestamp,
) -> Result<ClosedItemRecord, &'static str> {
    let (content_kind, restore) = match &tab.content {
        TabContent::Terminal { launch, .. } => {
            let relative = launch
                .cwd
                .strip_prefix(&workspace.working_directory)
                .map_err(|_| "policy_denied")?
                .to_path_buf();
            let restore =
                RestoreDescriptor::terminal(workspace.id, relative, launch.rows, launch.cols)
                    .map_err(|_| "policy_denied")?;
            (agent_workspace_core::ClosedContentKind::Terminal, restore)
        }
        TabContent::Browser { metadata } => {
            let restore =
                RestoreDescriptor::browser(metadata.url()).map_err(|_| "policy_denied")?;
            (agent_workspace_core::ClosedContentKind::Browser, restore)
        }
    };
    ClosedItemRecord::new(
        ClosedItemId::new(),
        agent_workspace_core::ClosedItemKind::Tab,
        workspace.id,
        Some(tab.id),
        content_kind,
        tab.custom_title.as_deref().unwrap_or(&tab.title),
        now,
        restore,
    )
    .map_err(|_| "policy_denied")
}

fn closed_snapshot(record: &ClosedItemRecord) -> ClosedItemSnapshot {
    ClosedItemSnapshot {
        closed_item_id: record.id.to_string(),
        item_kind: match record.item_kind {
            agent_workspace_core::ClosedItemKind::Tab => {
                agent_workspace_protocol::ClosedItemKind::Tab
            }
            agent_workspace_core::ClosedItemKind::Workspace => {
                agent_workspace_protocol::ClosedItemKind::Workspace
            }
        },
        prior_item_id: record.prior_tab_id.map_or_else(
            || record.prior_workspace_id.to_string(),
            |tab_id| tab_id.to_string(),
        ),
        content_kind: match record.content_kind {
            agent_workspace_core::ClosedContentKind::Terminal => {
                agent_workspace_protocol::ClosedContentKind::Terminal
            }
            agent_workspace_core::ClosedContentKind::Browser => {
                agent_workspace_protocol::ClosedContentKind::Browser
            }
        },
        title: record.title.clone(),
        closed_at_ms: record.closed_at.0,
        restored: false,
    }
}

fn closed_record_visible(record: &ClosedItemRecord, now: Timestamp) -> bool {
    now.0.saturating_sub(record.closed_at.0) <= CLOSED_ITEM_RETENTION_MS
}

fn current_timestamp() -> Timestamp {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Timestamp(u64::try_from(millis).unwrap_or(u64::MAX.min(9_007_199_254_740_991)))
}

fn window_list(state: &ApplicationState, epoch: Uuid) -> WindowListResult {
    WindowListResult {
        revision: state.revision,
        idempotency_epoch: epoch.to_string(),
        windows: state
            .window_placements
            .iter()
            .map(|placement| placement_snapshot(state, placement))
            .collect(),
        focused_window_id: state.focused_window_id.to_string(),
    }
}

fn mutation_result_json(
    state: &ApplicationState,
    epoch: Uuid,
    window_id: WindowId,
) -> Result<String, serde_json::Error> {
    let placement = state
        .window_placement(window_id)
        .expect("result target must exist after successful mutation");
    serde_json::to_string(&WindowMutationResult {
        revision: state.revision,
        idempotency_epoch: epoch.to_string(),
        window: placement_snapshot(state, placement),
        replayed: false,
    })
}

fn placement_snapshot(
    state: &ApplicationState,
    placement: &WindowPlacement,
) -> WindowPlacementSnapshot {
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == placement.focused_workspace_id)
        .expect("validated placement focus references a workspace");
    let pane = workspace
        .panes
        .get(&workspace.selected_pane_id)
        .expect("validated workspace focus references a pane");
    WindowPlacementSnapshot {
        window_id: placement.id.to_string(),
        label: placement.label.clone(),
        workspace_ids: placement
            .workspace_ids
            .iter()
            .map(ToString::to_string)
            .collect(),
        focused_workspace_id: placement.focused_workspace_id.to_string(),
        hosting_state: match placement.hosting_state {
            HostingState::Hosted => WindowHostingState::Hosted,
            HostingState::Unhosted => WindowHostingState::Unhosted,
            HostingState::Closing => WindowHostingState::Closing,
        },
        default_tab_destination: WindowDefaultTabDestination {
            workspace_id: workspace.id.to_string(),
            pane_id: pane.id.to_string(),
            destination_index: u32::try_from(pane.tabs.len())
                .expect("authoritative tab capacity fits u32"),
        },
        revision: placement.revision,
    }
}

fn epoch_response(
    id: String,
    result: Result<EpochIdempotentCommitResult, OperationFailure>,
) -> ResponseEnvelope {
    match result {
        Ok(EpochIdempotentCommitResult::Committed { result_json, .. })
        | Ok(EpochIdempotentCommitResult::Replay(result_json)) => {
            match serde_json::from_str::<serde_json::Value>(&result_json) {
                Ok(value) => match value.get("revision").and_then(serde_json::Value::as_u64) {
                    Some(revision) => ResponseEnvelope::success_at_revision(id, revision, value),
                    None => storage_failure(id),
                },
                Err(_) => storage_failure(id),
            }
        }
        Ok(EpochIdempotentCommitResult::Conflict) => {
            failure(id, "idempotency_conflict", "Idempotency key conflicts")
        }
        Ok(
            EpochIdempotentCommitResult::ResultExpired | EpochIdempotentCommitResult::EpochExpired,
        ) => failure(id, "idempotency_expired", "Idempotency ticket expired"),
        Err(failure_value) => match failure_value.error {
            RuntimeError::StaleStateRevision { .. } => {
                failure(id, "stale_revision", "Application revision is stale")
            }
            RuntimeError::StaleWindowRevision { .. } => {
                failure(id, "stale_window_revision", "Window revision is stale")
            }
            RuntimeError::Domain(agent_workspace_core::DomainError::WindowNotFound { .. }) => {
                failure(id, "target_not_found", "Window placement does not exist")
            }
            RuntimeError::Domain(agent_workspace_core::DomainError::ResourceLimit { .. }) => {
                failure(id, "resource_limit", "Resource limit reached")
            }
            RuntimeError::Domain(_) => failure(id, "policy_denied", "Mutation was denied"),
            RuntimeError::Store(_) => storage_failure(id),
            _ => failure(id, "policy_denied", "Mutation could not be committed"),
        },
    }
}

fn parse_claims(
    state: &ApplicationState,
    claims: &[DesktopProviderWindowClaim],
) -> Result<BTreeMap<WindowId, u64>, ()> {
    if claims.len() > MAX_PROVIDER_WINDOWS {
        return Err(());
    }
    let mut parsed = BTreeMap::new();
    for claim in claims {
        let window_id = parse_window_id(&claim.window_id)?;
        if state.window_placement(window_id).is_none()
            || parsed.insert(window_id, claim.generation).is_some()
        {
            return Err(());
        }
    }
    Ok(parsed)
}

async fn bound_matches(
    bound_window: &Mutex<Option<BoundWindow>>,
    control: &MultiWindowRuntime,
    state: &ApplicationState,
    requested_window_id: &str,
) -> bool {
    let Ok(requested) = parse_window_id(requested_window_id) else {
        return false;
    };
    let Some(binding) = *bound_window.lock().await else {
        return false;
    };
    binding.window_id == requested && control.validate_binding(state, binding).await.is_ok()
}

async fn bound_source_allows(
    bound_window: &Mutex<Option<BoundWindow>>,
    source_window_id: &str,
) -> bool {
    let Ok(source) = parse_window_id(source_window_id) else {
        return false;
    };
    bound_window
        .lock()
        .await
        .is_none_or(|binding| binding.window_id == source)
}

fn require_identity(lease: &ProviderLease, identity: ParsedIdentity) -> Result<(), &'static str> {
    if lease.provider_epoch != identity.provider_epoch {
        return Err("provider_epoch_mismatch");
    }
    if lease.lease_id != identity.lease_id {
        return Err("provider_ineligible");
    }
    if lease.expires_at <= Instant::now() {
        return Err("provider_lease_expired");
    }
    Ok(())
}

fn prune_expired(registry: &mut ProviderRegistry) {
    let now = Instant::now();
    let expired = registry
        .providers
        .iter()
        .filter_map(|(provider_id, lease)| (lease.expires_at <= now).then_some(*provider_id))
        .collect::<Vec<_>>();
    for provider_id in expired {
        if let Some(lease) = registry.providers.remove(&provider_id) {
            let recover_until = lease.expires_at + Duration::from_secs(30);
            if recover_until > now {
                registry.recoverable_providers.insert(
                    lease.instance_id,
                    RecoverableProvider {
                        provider_id,
                        lease,
                        recover_until,
                    },
                );
            }
        }
    }
    registry
        .recoverable_providers
        .retain(|_, recovery| recovery.recover_until > now);
    let live = registry.providers.keys().copied().collect::<BTreeSet<_>>();
    registry
        .reservations
        .retain(|_, reservation| live.contains(&reservation.provider_id));
    registry
        .action_reservations
        .retain(|_, reservation| live.contains(&reservation.provider_id));
}

fn recovered_provider_lease(
    provider: &ActionProviderRecoveryRecord,
    claims: BTreeMap<WindowId, u64>,
    capabilities: BTreeSet<String>,
    registration_proof_digest: [u8; 32],
    invocations: Vec<ActionInvocationRecord>,
) -> Result<ProviderLease, ()> {
    let mut action_queued = VecDeque::new();
    let mut action_in_flight = BTreeMap::new();
    for record in invocations {
        let identity = record.identity.as_ref().ok_or(())?;
        if identity.provider_id != provider.provider_id
            || identity.provider_epoch != provider.provider_epoch
            || identity.provider_lease_id != provider.lease_id
            || identity.attempt_epoch != provider.provider_epoch
            || claims
                .get(&WindowId::from_uuid(identity.window_id))
                .copied()
                != Some(identity.window_generation)
        {
            return Err(());
        }
        let parameters = serde_json::from_str(&record.parameters_json).map_err(|_| ())?;
        let request = DesktopActionExecutionRequest {
            identity: DesktopProviderIdentityParams {
                provider_id: provider.provider_id.to_string(),
                provider_epoch: provider.provider_epoch,
                lease_id: provider.lease_id.to_string(),
            },
            invocation_id: record.invocation_id.to_string(),
            correlation_id: record.correlation_id.to_string(),
            attempt_epoch: identity.attempt_epoch,
            action_id: record.action_id,
            action_version: record.action_version,
            target: ActionInvocationTarget {
                window_id: identity.window_id.to_string(),
                window_generation: identity.window_generation,
            },
            parameters,
            expires_at_ms: u64::try_from(record.expires_at_ms).map_err(|_| ())?,
        };
        match record.state {
            StoredActionState::Dispatched => action_queued.push_back(request),
            StoredActionState::StartGranted => {
                action_in_flight.insert(record.invocation_id, request);
            }
            _ => return Err(()),
        }
    }
    Ok(ProviderLease {
        instance_id: provider.provider_instance_id,
        registration_sequence: provider.registration_sequence,
        provider_epoch: provider.provider_epoch,
        lease_id: provider.lease_id,
        expires_at: Instant::now() + Duration::from_secs(PROVIDER_LEASE_SECONDS),
        claims,
        capabilities,
        registration_proof_digest,
        queued: VecDeque::new(),
        in_flight: BTreeMap::new(),
        action_queued,
        action_in_flight,
        completed_actions: VecDeque::new(),
        browser_queued: VecDeque::new(),
        browser_in_flight: BTreeMap::new(),
        completed_browser_requests: VecDeque::new(),
    })
}

fn browser_request_id(request: &BrowserAutomationProviderRequest) -> Uuid {
    let value = match request {
        BrowserAutomationProviderRequest::Create { operation_id, .. }
        | BrowserAutomationProviderRequest::Destroy { operation_id, .. }
        | BrowserAutomationProviderRequest::Cancel { operation_id, .. } => operation_id,
        BrowserAutomationProviderRequest::Execute { request } => &request.operation.operation_id,
        BrowserAutomationProviderRequest::ScreenshotRead { request_id, .. }
        | BrowserAutomationProviderRequest::ScreenshotRelease { request_id, .. } => request_id,
    };
    Uuid::parse_str(value).expect("service-issued browser request ID is a UUID")
}

fn browser_request_correlation(request: &BrowserAutomationProviderRequest) -> Uuid {
    let value = match request {
        BrowserAutomationProviderRequest::Create { correlation_id, .. }
        | BrowserAutomationProviderRequest::Destroy { correlation_id, .. }
        | BrowserAutomationProviderRequest::Cancel { correlation_id, .. }
        | BrowserAutomationProviderRequest::ScreenshotRead { correlation_id, .. }
        | BrowserAutomationProviderRequest::ScreenshotRelease { correlation_id, .. } => {
            correlation_id
        }
        BrowserAutomationProviderRequest::Execute { request } => &request.operation.correlation_id,
    };
    Uuid::parse_str(value).expect("service-issued browser correlation ID is a UUID")
}

fn browser_request_identity(
    request: &BrowserAutomationProviderRequest,
) -> &DesktopProviderIdentityParams {
    match request {
        BrowserAutomationProviderRequest::Create { identity, .. }
        | BrowserAutomationProviderRequest::Destroy { identity, .. }
        | BrowserAutomationProviderRequest::Cancel { identity, .. }
        | BrowserAutomationProviderRequest::ScreenshotRead { identity, .. }
        | BrowserAutomationProviderRequest::ScreenshotRelease { identity, .. } => identity,
        BrowserAutomationProviderRequest::Execute { request } => &request.identity,
    }
}

fn browser_request_target(request: &BrowserAutomationProviderRequest) -> &ActionInvocationTarget {
    match request {
        BrowserAutomationProviderRequest::Create { target, .. }
        | BrowserAutomationProviderRequest::Destroy { target, .. }
        | BrowserAutomationProviderRequest::Cancel { target, .. }
        | BrowserAutomationProviderRequest::ScreenshotRead { target, .. }
        | BrowserAutomationProviderRequest::ScreenshotRelease { target, .. } => target,
        BrowserAutomationProviderRequest::Execute { request } => &request.target,
    }
}

fn browser_request_session_id(request: &BrowserAutomationProviderRequest) -> &str {
    match request {
        BrowserAutomationProviderRequest::Create { provision, .. } => {
            &provision.automation_session_id
        }
        BrowserAutomationProviderRequest::Destroy { session, .. } => &session.automation_session_id,
        BrowserAutomationProviderRequest::Execute { request } => {
            &request.operation.automation_session_id
        }
        BrowserAutomationProviderRequest::Cancel {
            automation_session_id,
            ..
        } => automation_session_id,
        BrowserAutomationProviderRequest::ScreenshotRead { params, .. } => {
            &params.automation_session_id
        }
        BrowserAutomationProviderRequest::ScreenshotRelease { params, .. } => {
            &params.automation_session_id
        }
    }
}

fn capability_claim_digest(
    capabilities: &BTreeSet<String>,
    claims: &BTreeMap<WindowId, u64>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"cmux-action-provider-recovery-v1\0");
    digest.update(
        u64::try_from(capabilities.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for capability in capabilities {
        digest.update(
            u64::try_from(capability.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        digest.update(capability.as_bytes());
    }
    digest.update(
        u64::try_from(claims.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for (window_id, generation) in claims {
        digest.update(window_id.as_uuid().as_bytes());
        digest.update(generation.to_be_bytes());
    }
    let bytes = digest.finalize();
    let mut hexadecimal = String::with_capacity(64);
    for byte in bytes {
        write!(&mut hexadecimal, "{byte:02x}").expect("writing to a string is infallible");
    }
    hexadecimal
}

fn wall_now_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn provider_recover_until_ms(now_ms: i64) -> i64 {
    let lease_ms = i64::try_from(PROVIDER_LEASE_SECONDS.saturating_mul(1_000)).unwrap_or(i64::MAX);
    let recovery_ms =
        i64::try_from(PROVIDER_RECOVERY_SECONDS.saturating_mul(1_000)).unwrap_or(i64::MAX);
    now_ms.saturating_add(lease_ms).saturating_add(recovery_ms)
}

fn lease_expiry_ms(seconds: u64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(now)
        .unwrap_or(u64::MAX)
        .saturating_add(seconds.saturating_mul(1_000))
}

fn parse<T: DeserializeOwned>(id: &str, params: serde_json::Value) -> Result<T, ()> {
    let _ = id;
    serde_json::from_value(params).map_err(|_| ())
}

fn parse_uuid(value: &str) -> Result<Uuid, ()> {
    Uuid::parse_str(value).map_err(|_| ())
}

/// Derives the private provider saga identity from the complete durable
/// idempotency namespace. The public UUID remains opaque on the wire, while
/// callers may safely reuse one idempotency UUID for a different command.
fn provider_correlation(namespace: &str, epoch: Uuid, key: Uuid) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(namespace.as_bytes());
    digest.update([0]);
    digest.update(epoch.as_bytes());
    digest.update(key.as_bytes());
    let digest = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Mark the deterministic digest as an RFC 9562 name-based UUID.
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn recovery_correlation(
    namespace: &str,
    provider_epoch: u64,
    state_revision: u64,
    rehomes: &[WindowRehome],
) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(namespace.as_bytes());
    digest.update([0]);
    digest.update(provider_epoch.to_be_bytes());
    digest.update(state_revision.to_be_bytes());
    for rehome in rehomes {
        digest.update(rehome.source_window_id.as_uuid().as_bytes());
        digest.update(rehome.target_window_id.as_uuid().as_bytes());
    }
    let digest = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn parse_window_id(value: &str) -> Result<WindowId, ()> {
    parse_uuid(value).map(WindowId::from_uuid)
}

fn parse_workspace_id(value: &str) -> Result<WorkspaceId, ()> {
    parse_uuid(value).map(WorkspaceId::from_uuid)
}

fn parse_pane_id(value: &str) -> Result<PaneId, ()> {
    parse_uuid(value).map(PaneId::from_uuid)
}

fn parse_tab_id(value: &str) -> Result<TabId, ()> {
    parse_uuid(value).map(TabId::from_uuid)
}

fn parse_closed_item_id(value: &str) -> Result<ClosedItemId, ()> {
    parse_uuid(value).map(ClosedItemId::from_uuid)
}

fn stored_window_state(state: WindowStateSnapshot) -> WindowState {
    WindowState {
        revision: state.revision,
        x: i64::from(state.x),
        y: i64::from(state.y),
        width: u64::from(state.width),
        height: u64::from(state.height),
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        display_identifier: state.display_id,
    }
}

fn window_snapshot(state: WindowState) -> Result<WindowStateSnapshot, ()> {
    Ok(WindowStateSnapshot {
        revision: state.revision,
        x: i32::try_from(state.x).map_err(|_| ())?,
        y: i32::try_from(state.y).map_err(|_| ())?,
        width: u32::try_from(state.width).map_err(|_| ())?,
        height: u32::try_from(state.height).map_err(|_| ())?,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        display_id: state.display_identifier,
    })
}

fn serialized(id: String, value: impl Serialize) -> ResponseEnvelope {
    match serde_json::to_value(value) {
        Ok(value) => ResponseEnvelope::success(id, value),
        Err(_) => storage_failure(id),
    }
}

fn serialized_at_independent_revision(
    id: String,
    revision: Option<u64>,
    value: impl Serialize,
) -> ResponseEnvelope {
    match serde_json::to_value(value) {
        Ok(value) => match revision {
            Some(revision) => ResponseEnvelope::success_at_revision(id, revision, value),
            None => ResponseEnvelope::success(id, value),
        },
        Err(_) => storage_failure(id),
    }
}

fn invalid_params(id: String) -> ResponseEnvelope {
    failure(
        id,
        "invalid_params",
        "The request parameters do not match the command contract",
    )
}

fn unavailable(id: String) -> ResponseEnvelope {
    failure(
        id,
        "capability_unavailable",
        "Multi-window support is unavailable",
    )
}

fn storage_failure(id: String) -> ResponseEnvelope {
    failure(id, "storage_error", "Durable state is unavailable")
}

fn failure(id: String, code: &str, message: &str) -> ResponseEnvelope {
    ResponseEnvelope::failure(id, code, message)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use agent_workspace_core::{
        BrowserMetadata, PaneId, RuntimeSessionId, Tab, TabId, Timestamp, Workspace, WorkspaceId,
    };
    use agent_workspace_protocol::{
        BROWSER_AUTOMATION_CAPABILITY, BrowserAutomationSessionMode,
        BrowserAutomationSessionProvision,
    };

    use super::*;

    #[test]
    fn root_terminal_restore_preserves_the_exact_root_path() {
        assert_eq!(
            restore_terminal_cwd(
                std::path::Path::new("/tmp/project"),
                std::path::Path::new("")
            ),
            PathBuf::from("/tmp/project")
        );
        assert_eq!(
            restore_terminal_cwd(
                std::path::Path::new("/tmp/project"),
                std::path::Path::new("nested")
            ),
            PathBuf::from("/tmp/project/nested")
        );
    }

    fn state() -> ApplicationState {
        let workspace_id = WorkspaceId::new();
        let pane_id = PaneId::new();
        let tab = Tab::browser(
            TabId::new(),
            pane_id,
            "Browser",
            BrowserMetadata::new("https://example.com/").expect("URL is valid"),
            Timestamp(1),
        )
        .expect("tab is valid");
        let workspace = Workspace::new(
            workspace_id,
            "Workspace",
            PathBuf::from("/tmp"),
            pane_id,
            tab,
            Timestamp(1),
            Timestamp(1),
        )
        .expect("workspace is valid");
        ApplicationState::new(workspace).expect("state is valid")
    }

    fn state_with_two_windows() -> ApplicationState {
        let mut state = state();
        let workspace_id = WorkspaceId::new();
        let pane_id = PaneId::new();
        let tab = Tab::browser(
            TabId::new(),
            pane_id,
            "Second browser",
            BrowserMetadata::new("https://example.com/second?exact=yes#fragment")
                .expect("URL is valid"),
            Timestamp(2),
        )
        .expect("tab is valid");
        let workspace = Workspace::new(
            workspace_id,
            "Second",
            PathBuf::from("/tmp"),
            pane_id,
            tab,
            Timestamp(2),
            Timestamp(2),
        )
        .expect("workspace is valid");
        state
            .create_workspace(workspace)
            .expect("workspace creates");
        state
            .create_window_placement(WindowId::new(), "Second", workspace_id)
            .expect("window creates");
        state
    }

    fn mixed_rehome_state() -> (ApplicationState, TabId) {
        let mut state = state_with_two_windows();
        let source = &state.window_placements[0];
        let workspace_id = source.workspace_ids[0];
        let pane_id = state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .expect("source workspace")
            .selected_pane_id;
        let terminal_id = TabId::new();
        state
            .open_terminal_tab(
                workspace_id,
                pane_id,
                1,
                Tab::terminal(
                    terminal_id,
                    pane_id,
                    "Recovery terminal",
                    TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80)
                        .expect("launch is valid"),
                    None,
                    Timestamp(3),
                )
                .expect("terminal is valid"),
                Timestamp(3),
            )
            .expect("terminal opens");
        state
            .bind_terminal_runtime_session(
                workspace_id,
                terminal_id,
                RuntimeSessionId::new("20000000-0000-4000-8000-000000000099"),
                Timestamp(4),
            )
            .expect("runtime binds");
        let hosted = state
            .window_placements
            .iter()
            .map(|placement| placement.id)
            .collect();
        state
            .reconcile_window_claims(&hosted)
            .expect("fixture windows become hosted");
        (state, terminal_id)
    }

    fn registration(
        state: &ApplicationState,
        proof: &str,
        instance_id: Uuid,
    ) -> DesktopProviderRegisterParams {
        DesktopProviderRegisterParams {
            bootstrap_proof: proof.to_owned(),
            instance_id: instance_id.to_string(),
            capabilities: vec![
                "window-host-v1".to_owned(),
                "tab-transfer-v1".to_owned(),
                "browser-transfer-v1".to_owned(),
            ],
            windows: vec![DesktopProviderWindowClaim {
                window_id: state.focused_window_id.to_string(),
                generation: 1,
            }],
        }
    }

    #[tokio::test]
    async fn consumed_bootstrap_allows_only_live_exact_replay_and_identity_heartbeat() {
        let state = state();
        let proof = "p".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let instance_id = Uuid::new_v4();
        let first = control
            .register(&state, registration(&state, &proof, instance_id))
            .await
            .expect("first registration succeeds");
        let first_binding = control
            .bind(
                &state,
                WindowBindParams {
                    identity: DesktopProviderIdentityParams {
                        provider_id: first.provider_id.clone(),
                        provider_epoch: first.provider_epoch,
                        lease_id: first.lease_id.clone(),
                    },
                    window: DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 1,
                    },
                },
            )
            .await
            .expect("first binding succeeds");
        let identity = DesktopProviderIdentityParams {
            provider_id: first.provider_id.clone(),
            provider_epoch: first.provider_epoch,
            lease_id: first.lease_id.clone(),
        };
        let replay = control
            .register(&state, registration(&state, &proof, instance_id))
            .await
            .expect("exact response-loss replay succeeds while lease is live");
        assert_eq!(replay.provider_id, first.provider_id);
        control
            .heartbeat(
                &state,
                DesktopProviderHeartbeatParams {
                    provider_id: identity.provider_id.clone(),
                    provider_epoch: identity.provider_epoch,
                    lease_id: identity.lease_id.clone(),
                    windows: vec![DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 1,
                    }],
                },
            )
            .await
            .expect("normal reconnect renews with the issued identity");
        assert!(
            control
                .validate_binding(&state, first_binding)
                .await
                .is_ok()
        );
        control
            .unregister(DesktopProviderUnregisterParams { identity })
            .await
            .expect("unregister succeeds");
        assert!(
            control
                .register(&state, registration(&state, &proof, instance_id))
                .await
                .is_err(),
            "unregister does not restore the single-use bootstrap"
        );
    }

    #[tokio::test]
    async fn explicit_unregister_immediately_reconciles_actions_once_and_replays_terminal() {
        let temp = tempfile::TempDir::new().expect("temporary directory");
        let database_path = temp.path().join("state.sqlite3");
        let store = Arc::new(
            SqliteStateStore::open(
                &database_path,
                agent_workspace_core::ShortcutPlatform::NonMacOs,
            )
            .expect("store opens"),
        );
        let state = state();
        let proof = "unregister-action-proof".repeat(2);
        let control = MultiWindowRuntime::with_recovery_store(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
            Arc::clone(&store),
        );
        let registration = control
            .register(&state, registration(&state, &proof, Uuid::new_v4()))
            .await
            .expect("provider registers");
        let provider_identity = DesktopProviderIdentityParams {
            provider_id: registration.provider_id.clone(),
            provider_epoch: registration.provider_epoch,
            lease_id: registration.lease_id.clone(),
        };
        let invocation_identity = agent_workspace_storage::ActionInvocationIdentity {
            attempt_epoch: 1,
            provider_id: Uuid::parse_str(&registration.provider_id).expect("provider UUID"),
            provider_epoch: registration.provider_epoch,
            provider_lease_id: Uuid::parse_str(&registration.lease_id).expect("lease UUID"),
            window_id: state.focused_window_id.as_uuid(),
            window_generation: 1,
        };
        let epoch = store
            .current_idempotency_epoch()
            .expect("idempotency epoch");
        let accepted_at_ms = wall_now_ms().saturating_sub(100);
        let mut creates = Vec::new();

        for index in 0..4 {
            let create = agent_workspace_storage::ActionInvocationCreate {
                invocation_id: Uuid::new_v4(),
                epoch,
                idempotency_key: Uuid::new_v4(),
                request_hash: format!("{index:064x}"),
                action_id: "desktop.window.focus".to_owned(),
                action_version: 1,
                correlation_id: Uuid::new_v4(),
                caller_id: Uuid::new_v4(),
                parameters_json: "{}".to_owned(),
                accepted_at_ms,
                expires_at_ms: accepted_at_ms + 30_000,
            };
            assert!(matches!(
                store
                    .create_action_invocation(&create)
                    .expect("invocation creates"),
                agent_workspace_storage::ActionInvocationCreateOutcome::Created(_)
            ));
            store
                .lease_action_invocation(
                    create.invocation_id,
                    create.correlation_id,
                    &invocation_identity,
                    accepted_at_ms + 1,
                )
                .expect("invocation leases");
            if index > 0 {
                store
                    .mark_action_dispatched(
                        create.invocation_id,
                        create.correlation_id,
                        &invocation_identity,
                        accepted_at_ms + 2,
                    )
                    .expect("invocation dispatches");
            }
            if index == 2 {
                rusqlite::Connection::open(&database_path)
                    .expect("database opens")
                    .execute(
                        "UPDATE action_invocations SET state = 'startClaimed', updated_at_ms = ?1 WHERE invocation_id = ?2",
                        rusqlite::params![accepted_at_ms + 3, create.invocation_id.to_string()],
                    )
                    .expect("claim fixture persists");
            } else if index == 3 {
                store
                    .claim_action_start(&agent_workspace_storage::ActionStartClaim {
                        invocation_id: create.invocation_id,
                        correlation_id: create.correlation_id,
                        action_id: create.action_id.clone(),
                        action_version: create.action_version,
                        identity: invocation_identity.clone(),
                        claimed_at_ms: accepted_at_ms + 3,
                    })
                    .expect("start grants");
            }
            creates.push(create);
        }

        let actions = crate::actions::ActionRuntime::new(Arc::clone(&store), control.clone());
        let mut events = actions.subscribe();
        control
            .unregister(DesktopProviderUnregisterParams {
                identity: provider_identity,
            })
            .await
            .expect("provider unregisters");
        actions
            .reconcile_provider_lifecycle()
            .await
            .expect("actions reconcile after definitive unregister");

        for create in &creates {
            assert!(matches!(
                store
                    .create_action_invocation(create)
                    .expect("terminal replay loads"),
                agent_workspace_storage::ActionInvocationCreateOutcome::Replay(
                    agent_workspace_storage::ActionTerminalOutcome {
                        state: StoredActionState::Failed,
                        terminal_code,
                        ..
                    }
                ) if terminal_code == "interrupted"
            ));
        }
        let first_event_count = std::iter::from_fn(|| events.try_recv().ok()).count();
        assert_eq!(first_event_count, creates.len());

        actions
            .reconcile_provider_lifecycle()
            .await
            .expect("terminal reconciliation is idempotent");
        assert!(
            events.try_recv().is_err(),
            "no duplicate terminal event is emitted"
        );
        assert!(
            store
                .recover_action_invocations(
                    agent_workspace_storage::ActionRecoveryQuery::AllNonterminal,
                    256,
                )
                .expect("nonterminal query succeeds")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn expired_provider_has_one_exact_proof_bound_recovery_within_grace() {
        let state = state();
        let proof = "y".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let instance_id = Uuid::new_v4();
        let first = control
            .register(&state, registration(&state, &proof, instance_id))
            .await
            .expect("provider registers");
        {
            let mut registry = control.providers.lock().await;
            registry
                .providers
                .get_mut(&Uuid::parse_str(&first.provider_id).expect("provider UUID"))
                .expect("provider lease")
                .expires_at = Instant::now()
                .checked_sub(Duration::from_millis(1))
                .expect("one millisecond precedes now");
        }

        let mut mismatched = registration(&state, &proof, instance_id);
        mismatched.capabilities.push("native-window-v1".to_owned());
        assert!(control.register(&state, mismatched).await.is_err());
        let recovered = control
            .register(&state, registration(&state, &proof, instance_id))
            .await
            .expect("exact recovery succeeds");
        assert_eq!(recovered.provider_id, first.provider_id);
        assert_eq!(recovered.provider_epoch, first.provider_epoch);
        assert_eq!(recovered.lease_id, first.lease_id);
        assert_eq!(recovered.registration_sequence, first.registration_sequence);

        {
            let mut registry = control.providers.lock().await;
            registry
                .providers
                .get_mut(&Uuid::parse_str(&first.provider_id).expect("provider UUID"))
                .expect("recovered provider lease")
                .expires_at = Instant::now()
                .checked_sub(Duration::from_millis(1))
                .expect("one millisecond precedes now");
            prune_expired(&mut registry);
            registry
                .recoverable_providers
                .get_mut(&instance_id)
                .expect("expired provider is recoverable")
                .recover_until = Instant::now()
                .checked_sub(Duration::from_millis(1))
                .expect("one millisecond precedes now");
        }
        assert!(
            control
                .register(&state, registration(&state, &proof, instance_id))
                .await
                .is_err(),
            "the consumed proof cannot recover after the bounded grace"
        );
    }

    #[tokio::test]
    async fn fresh_service_proof_recovers_exact_actions_and_fences_the_stale_service() {
        let temp = tempfile::TempDir::new().expect("temporary directory");
        let store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("state.sqlite3"),
                agent_workspace_core::ShortcutPlatform::NonMacOs,
            )
            .expect("store opens"),
        );
        let state = state();
        let first_proof = "first-service-proof".repeat(3);
        let second_proof = "second-service-proof".repeat(3);
        let instance_id = Uuid::new_v4();
        let first_control = MultiWindowRuntime::with_recovery_store(
            DesktopProviderBootstrapSecret::new(first_proof.as_bytes()).expect("proof is strong"),
            Arc::clone(&store),
        );
        let first = first_control
            .register(&state, registration(&state, &first_proof, instance_id))
            .await
            .expect("first service registers provider");
        let epoch = store.current_idempotency_epoch().expect("epoch");
        let now = wall_now_ms();
        let invocation_id = Uuid::new_v4();
        let correlation_id = Uuid::new_v4();
        let create = agent_workspace_storage::ActionInvocationCreate {
            invocation_id,
            epoch,
            idempotency_key: Uuid::new_v4(),
            request_hash: "a".repeat(64),
            action_id: "desktop.window.focus".to_owned(),
            action_version: 1,
            correlation_id,
            caller_id: Uuid::new_v4(),
            parameters_json: "{}".to_owned(),
            accepted_at_ms: now,
            expires_at_ms: now + 30_000,
        };
        assert!(matches!(
            store.create_action_invocation(&create).expect("create"),
            agent_workspace_storage::ActionInvocationCreateOutcome::Created(_)
        ));
        let exact_identity = agent_workspace_storage::ActionInvocationIdentity {
            attempt_epoch: first.provider_epoch,
            provider_id: Uuid::parse_str(&first.provider_id).expect("provider ID"),
            provider_epoch: first.provider_epoch,
            provider_lease_id: Uuid::parse_str(&first.lease_id).expect("lease ID"),
            window_id: state.focused_window_id.as_uuid(),
            window_generation: 1,
        };
        assert!(matches!(
            store
                .lease_action_invocation(invocation_id, correlation_id, &exact_identity, now + 1)
                .expect("lease"),
            agent_workspace_storage::ActionLifecycleOutcome::Applied(_)
        ));

        let mismatched_control = MultiWindowRuntime::with_recovery_store(
            DesktopProviderBootstrapSecret::new(second_proof.as_bytes()).expect("proof is strong"),
            Arc::clone(&store),
        );
        let mut mismatched = registration(&state, &second_proof, instance_id);
        mismatched.capabilities.push("native-window-v1".to_owned());
        assert!(
            mismatched_control
                .register(&state, mismatched)
                .await
                .is_err()
        );

        let second_control = MultiWindowRuntime::with_recovery_store(
            DesktopProviderBootstrapSecret::new(second_proof.as_bytes()).expect("proof is strong"),
            Arc::clone(&store),
        );
        assert!(
            second_control
                .register(&state, registration(&state, &first_proof, instance_id))
                .await
                .is_err(),
            "the prior service proof cannot authorize recovery"
        );
        let recovered = second_control
            .register(&state, registration(&state, &second_proof, instance_id))
            .await
            .expect("fresh proof recovers exact identity");
        assert_eq!(recovered.provider_id, first.provider_id);
        assert_eq!(recovered.provider_epoch, first.provider_epoch);
        assert_eq!(recovered.lease_id, first.lease_id);
        assert!(
            first_control
                .register(&state, registration(&state, &first_proof, instance_id),)
                .await
                .is_err(),
            "the fenced service cannot replay its old registration"
        );

        let identity = DesktopProviderIdentityParams {
            provider_id: recovered.provider_id,
            provider_epoch: recovered.provider_epoch,
            lease_id: recovered.lease_id,
        };
        assert_eq!(
            first_control.action_poll(&identity, 0).await,
            Err("provider_epoch_mismatch")
        );
        let polled = second_control
            .action_poll(&identity, 0)
            .await
            .expect("recovered provider polls");
        assert_eq!(
            polled.request.map(|request| request.invocation_id),
            Some(invocation_id.to_string())
        );
        crate::actions::ActionRuntime::new(Arc::clone(&store), first_control)
            .shutdown()
            .await
            .expect("stale service drains without mutating the recovered invocation");
        assert_eq!(
            store
                .action_invocation(invocation_id)
                .expect("lookup")
                .expect("invocation")
                .state,
            StoredActionState::Dispatched,
            "lease-before-dispatch crash window closes during atomic recovery"
        );
    }

    #[tokio::test]
    async fn cross_service_recovery_rejects_an_expired_durable_identity() {
        let temp = tempfile::TempDir::new().expect("temporary directory");
        let path = temp.path().join("state.sqlite3");
        let store = Arc::new(
            SqliteStateStore::open(&path, agent_workspace_core::ShortcutPlatform::NonMacOs)
                .expect("store opens"),
        );
        let state = state();
        let first_proof = "first-expiry-proof".repeat(3);
        let second_proof = "second-expiry-proof".repeat(3);
        let instance_id = Uuid::new_v4();
        let first_control = MultiWindowRuntime::with_recovery_store(
            DesktopProviderBootstrapSecret::new(first_proof.as_bytes()).expect("proof is strong"),
            Arc::clone(&store),
        );
        first_control
            .register(&state, registration(&state, &first_proof, instance_id))
            .await
            .expect("first service registers provider");
        rusqlite::Connection::open(&path)
            .expect("database opens")
            .execute(
                "UPDATE action_provider_recovery SET recover_until_ms = ?1",
                [wall_now_ms().saturating_sub(1)],
            )
            .expect("fixture recovery expires");

        let second_control = MultiWindowRuntime::with_recovery_store(
            DesktopProviderBootstrapSecret::new(second_proof.as_bytes()).expect("proof is strong"),
            store,
        );
        assert!(
            second_control
                .register(&state, registration(&state, &second_proof, instance_id),)
                .await
                .is_err(),
            "an expired durable identity cannot be recovered or silently replaced"
        );
    }

    #[tokio::test]
    async fn downstream_registration_rollback_allows_only_exact_bounded_retry() {
        let state = state();
        let proof = "z".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let instance_id = Uuid::new_v4();
        let first = control
            .register(&state, registration(&state, &proof, instance_id))
            .await
            .expect("registration reaches downstream work");
        control
            .revoke_registration(Uuid::parse_str(&first.provider_id).expect("provider UUID"))
            .await;
        let mut changed = registration(&state, &proof, instance_id);
        changed.capabilities.push("native-window-v1".to_owned());
        assert!(control.register(&state, changed).await.is_err());
        assert!(
            control
                .register(&state, registration(&state, &proof, Uuid::new_v4()))
                .await
                .is_err()
        );
        assert!(
            control
                .register(&state, registration(&state, &proof, instance_id))
                .await
                .is_ok(),
            "the exact failed-route registration may retry"
        );
    }

    #[tokio::test]
    async fn action_and_transfer_work_share_one_bounded_provider_queue() {
        let state = state();
        let proof = "a".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params.capabilities.push("native-window-v1".to_owned());
        control
            .register(&state, params)
            .await
            .expect("provider registers");
        for _ in 0..(MAX_PROVIDER_QUEUE - 1) {
            control
                .reserve_window_operation(
                    DesktopProviderOperationKind::FocusWindow,
                    state.focused_window_id,
                    None,
                    Uuid::new_v4(),
                )
                .await
                .expect("transfer capacity reserves");
        }
        let action = control
            .action_reserve(&state, "native-window-v1", None)
            .await
            .expect("the final shared slot is available to an action");
        assert_eq!(action.window_id, state.focused_window_id.as_uuid());
        assert_eq!(
            control
                .enqueue(
                    DesktopProviderOperationKind::FocusWindow,
                    DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 1,
                    },
                    Uuid::new_v4(),
                    None,
                    None,
                    None,
                )
                .await
                .err(),
            Some("provider_backpressure")
        );
        assert_eq!(
            control
                .reserve_window_operation(
                    DesktopProviderOperationKind::FocusWindow,
                    state.focused_window_id,
                    None,
                    Uuid::new_v4(),
                )
                .await,
            Err("provider_backpressure")
        );
    }

    #[tokio::test]
    async fn browser_session_cleanup_removes_queued_and_inflight_work() {
        let state = state();
        let proof = "c".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params
            .capabilities
            .push(BROWSER_AUTOMATION_CAPABILITY.to_owned());
        let registered = control
            .register(&state, params)
            .await
            .expect("provider registers");
        let provider_id = Uuid::parse_str(&registered.provider_id).unwrap();
        let lease_id = Uuid::parse_str(&registered.lease_id).unwrap();
        let window_id = state.focused_window_id.as_uuid();
        let identity = DesktopProviderIdentityParams {
            provider_id: registered.provider_id,
            provider_epoch: registered.provider_epoch,
            lease_id: registered.lease_id,
        };
        let target = ActionInvocationTarget {
            window_id: window_id.to_string(),
            window_generation: 1,
        };
        let session_id = Uuid::new_v4();
        let other_session_id = Uuid::new_v4();
        let request =
            |session_id: Uuid, operation_id: Uuid| BrowserAutomationProviderRequest::Create {
                identity: identity.clone(),
                target: target.clone(),
                provision: BrowserAutomationSessionProvision {
                    automation_session_id: session_id.to_string(),
                    generation: 1,
                    mode: BrowserAutomationSessionMode::Ephemeral,
                    profile_key: "cleanup-test".into(),
                    requested_target: None,
                    created_at_ms: 1,
                    expires_at_ms: 2,
                },
                operation_id: operation_id.to_string(),
                correlation_id: Uuid::new_v4().to_string(),
                attempt_epoch: registered.provider_epoch,
            };
        let inflight_id = Uuid::new_v4();
        control
            .browser_publish_bound(
                provider_id,
                registered.provider_epoch,
                lease_id,
                window_id,
                1,
                inflight_id,
                request(session_id, inflight_id),
            )
            .await
            .expect("session work publishes");
        assert!(
            control
                .browser_poll(&identity, 0)
                .await
                .unwrap()
                .request
                .is_some(),
            "first request becomes in flight"
        );
        assert!(
            control
                .browser_poll(&identity, 0)
                .await
                .unwrap()
                .request
                .is_none(),
            "an in-flight browser request is not concurrently redelivered"
        );
        let queued_id = Uuid::new_v4();
        control
            .browser_publish_bound(
                provider_id,
                registered.provider_epoch,
                lease_id,
                window_id,
                1,
                queued_id,
                request(session_id, queued_id),
            )
            .await
            .expect("second session request queues");
        let survivor_id = Uuid::new_v4();
        control
            .browser_publish_bound(
                provider_id,
                registered.provider_epoch,
                lease_id,
                window_id,
                1,
                survivor_id,
                request(other_session_id, survivor_id),
            )
            .await
            .expect("unrelated request queues");

        control
            .browser_cancel_session_requests(provider_id, session_id)
            .await;

        let survivor = control
            .browser_poll(&identity, 0)
            .await
            .unwrap()
            .request
            .expect("unrelated request survives cleanup");
        assert_eq!(browser_request_id(&survivor), survivor_id);
        control.browser_finalize(provider_id, survivor_id).await;
        assert!(
            control
                .browser_poll(&identity, 0)
                .await
                .unwrap()
                .request
                .is_none()
        );
    }

    #[tokio::test]
    async fn action_selection_is_focused_exact_and_generation_loss_is_detected() {
        let state = state();
        let proof = "b".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params.capabilities.push("native-window-v1".to_owned());
        let registered = control
            .register(&state, params)
            .await
            .expect("provider registers");
        assert_eq!(
            control
                .action_reserve(
                    &state,
                    "native-window-v1",
                    Some(&ActionInvocationTarget {
                        window_id: state.focused_window_id.to_string(),
                        window_generation: 2,
                    }),
                )
                .await
                .err(),
            Some("target_stale")
        );
        let reservation = control
            .action_reserve(&state, "native-window-v1", None)
            .await
            .expect("focused target is selected");
        assert_eq!(reservation.window_id, state.focused_window_id.as_uuid());
        let identity = DesktopProviderIdentityParams {
            provider_id: registered.provider_id.clone(),
            provider_epoch: registered.provider_epoch,
            lease_id: registered.lease_id.clone(),
        };
        control
            .heartbeat(
                &state,
                DesktopProviderHeartbeatParams {
                    provider_id: identity.provider_id,
                    provider_epoch: identity.provider_epoch,
                    lease_id: identity.lease_id,
                    windows: vec![DesktopProviderWindowClaim {
                        window_id: state.focused_window_id.to_string(),
                        generation: 2,
                    }],
                },
            )
            .await
            .expect("provider advances its window generation");
        assert!(
            !control
                .action_identity_is_active(
                    reservation.provider_id,
                    reservation.provider_epoch,
                    reservation.provider_lease_id,
                    reservation.window_id,
                    reservation.window_generation,
                )
                .await
        );
    }

    #[tokio::test]
    async fn wrong_proof_does_not_consume_session_recovery_secret() {
        let state = state();
        let proof = "q".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let instance_id = Uuid::new_v4();
        assert!(
            control
                .register(&state, registration(&state, &"x".repeat(43), instance_id))
                .await
                .is_err()
        );
        assert!(
            control
                .register(&state, registration(&state, &proof, instance_id))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn provider_queue_requires_exact_identity_and_correlated_acknowledgement() {
        let state = state();
        let proof = "r".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let registration = control
            .register(&state, registration(&state, &proof, Uuid::new_v4()))
            .await
            .expect("registration succeeds");
        let identity = DesktopProviderIdentityParams {
            provider_id: registration.provider_id,
            provider_epoch: registration.provider_epoch,
            lease_id: registration.lease_id,
        };
        let correlation_id = Uuid::new_v4();
        let completion = control
            .enqueue(
                DesktopProviderOperationKind::FocusWindow,
                DesktopProviderWindowClaim {
                    window_id: state.focused_window_id.to_string(),
                    generation: 1,
                },
                correlation_id,
                None,
                None,
                None,
            )
            .await
            .expect("eligible request queues");
        let request = control
            .poll(DesktopProviderPollParams {
                identity: identity.clone(),
                timeout_ms: 0,
            })
            .await
            .expect("poll succeeds")
            .request
            .expect("request is returned");
        assert_eq!(request.correlation_id, correlation_id.to_string());
        control
            .acknowledge(DesktopProviderAcknowledgeParams {
                identity,
                request_id: request.request_id,
                correlation_id: request.correlation_id,
                attempt_epoch: request.attempt_epoch,
                status: DesktopProviderCompletionStatus::Succeeded,
                error_code: None,
            })
            .await
            .expect("exact acknowledgement succeeds");
        assert_eq!(
            completion.await.expect("completion sender remains live"),
            ProviderCompletion::Succeeded
        );
    }

    #[test]
    fn bound_projection_and_identity_scope_do_not_leak_sibling_window_state() {
        let mut state = state_with_two_windows();
        let first = state.window_placements[0].id;
        let second = state.window_placements[1].id;
        let foreign_workspace = state.window_placements[1].workspace_ids[0];
        let empty_group = agent_workspace_core::GroupId::new();
        let foreign_group = agent_workspace_core::GroupId::new();
        state
            .create_workspace_group(empty_group, "Empty".to_owned())
            .expect("empty group creates");
        state
            .create_workspace_group(foreign_group, "Foreign".to_owned())
            .expect("foreign group creates");
        state
            .assign_workspace_group(foreign_workspace, Some(foreign_group))
            .expect("foreign workspace assigns");
        let binding = BoundWindow {
            window_id: first,
            provider: None,
        };
        let projected = project_state_to_window(&state, first).expect("placement projects");
        assert_eq!(projected.window_placements.len(), 1);
        assert_eq!(projected.window_placements[0].id, first);
        assert_eq!(projected.workspaces.len(), 1);
        assert!(projected.window_placement(second).is_none());
        assert!(
            projected
                .workspace_groups
                .iter()
                .any(|group| group.id == empty_group)
        );
        assert!(
            projected
                .workspace_groups
                .iter()
                .all(|group| group.id != foreign_group)
        );
        assert!(!bound_request_targets_owned_state(
            &state,
            binding,
            &serde_json::json!({ "workspaceId": foreign_workspace.to_string() }),
        ));
        assert!(bound_request_targets_owned_state(
            &state,
            binding,
            &serde_json::json!({ "label": foreign_workspace.to_string() }),
        ));
        assert!(legacy_organization_request_is_allowed(
            &state,
            binding,
            "workspace.organization.get",
            &serde_json::json!({}),
        ));
        assert!(!legacy_organization_request_is_allowed(
            &state,
            binding,
            "group.move",
            &serde_json::json!({}),
        ));

        let projected_response = project_legacy_response(
            "workspace.list",
            ResponseEnvelope::success_at_revision(
                "stale-read",
                state.revision.saturating_sub(1),
                serde_json::json!({ "snapshot": { "revision": 0 } }),
            ),
            binding,
            &state,
        );
        assert_eq!(projected_response.revision, Some(state.revision));
        assert_eq!(
            projected_response.result.as_ref().and_then(|result| result
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("revision"))
                .and_then(serde_json::Value::as_u64)),
            Some(state.revision)
        );

        let projected_organization_response = project_legacy_response(
            "workspace.organization.get",
            ResponseEnvelope::success_at_revision(
                "stale-organization-read",
                state.revision.saturating_sub(1),
                serde_json::json!({ "organization": { "revision": 0 } }),
            ),
            binding,
            &state,
        );
        assert_eq!(
            projected_organization_response.revision,
            Some(state.revision)
        );
        assert_eq!(
            projected_organization_response
                .result
                .as_ref()
                .and_then(|result| result
                    .get("organization")
                    .and_then(|organization| organization.get("revision"))
                    .and_then(serde_json::Value::as_u64)),
            Some(state.revision)
        );
    }

    #[test]
    fn full_ownership_event_is_visible_to_both_participants_and_no_third_window() {
        let source = WindowId::new();
        let target = WindowId::new();
        let third = WindowId::new();
        let event = EventEnvelope {
            event: "tab.ownershipTransferred".to_owned(),
            revision: Some(9),
            data: serde_json::json!({
                "source": { "windowId": source.to_string() },
                "target": { "windowId": target.to_string() }
            }),
        };
        assert!(ownership_event_targets_window(&event, source));
        assert!(ownership_event_targets_window(&event, target));
        assert!(!ownership_event_targets_window(&event, third));
    }

    #[test]
    fn identify_capabilities_follow_topology_binding_and_legacy_recovery_gate() {
        let single = state();
        let mut single_capabilities = vec!["layout.list".to_owned()];
        apply_identify_capabilities(&mut single_capabilities, &single, None);
        assert!(
            single_capabilities
                .iter()
                .any(|value| value == "layout.list")
        );
        assert!(
            single_capabilities
                .iter()
                .any(|value| value == agent_workspace_protocol::MULTI_WINDOW_CAPABILITY)
        );

        let multiple = state_with_two_windows();
        let mut bound_capabilities = vec!["layout.list".to_owned(), "saved-layouts-v1".to_owned()];
        apply_identify_capabilities(
            &mut bound_capabilities,
            &multiple,
            Some(BoundWindow {
                window_id: multiple.window_placements[0].id,
                provider: None,
            }),
        );
        assert!(
            !bound_capabilities
                .iter()
                .any(|value| value == "layout.list")
        );
        assert!(
            !bound_capabilities
                .iter()
                .any(|value| value == "saved-layouts-v1")
        );
        assert!(
            bound_capabilities
                .iter()
                .any(|value| value == agent_workspace_protocol::MULTI_WINDOW_CAPABILITY)
        );

        let mut recovery = single;
        recovery.legacy_over_limit = Some(agent_workspace_core::LegacyOverLimit {
            workspace_count: 129,
            maximum_panes_in_workspace: 1,
            maximum_tabs_in_workspace: 1,
            total_pane_count: 129,
            total_tab_count: 129,
        });
        let mut recovery_capabilities = vec![
            "layout.list".to_owned(),
            agent_workspace_protocol::MULTI_WINDOW_CAPABILITY.to_owned(),
        ];
        apply_identify_capabilities(&mut recovery_capabilities, &recovery, None);
        assert!(
            recovery_capabilities
                .iter()
                .any(|value| value == "layout.list")
        );
        assert!(
            !recovery_capabilities
                .iter()
                .any(|value| value == agent_workspace_protocol::MULTI_WINDOW_CAPABILITY)
        );
    }

    #[test]
    fn exact_mutation_replay_preserves_the_envelope_revision_contract() {
        let response = epoch_response(
            "request".to_owned(),
            Ok(EpochIdempotentCommitResult::Replay(
                serde_json::json!({ "revision": 17, "replayed": true }).to_string(),
            )),
        );

        assert!(response.ok);
        assert_eq!(response.revision, Some(17));
        assert_eq!(
            response
                .result
                .as_ref()
                .and_then(|result| result.get("revision"))
                .and_then(serde_json::Value::as_u64),
            Some(17)
        );
    }

    #[test]
    fn exact_mutation_result_without_revision_fails_closed() {
        let response = epoch_response(
            "request".to_owned(),
            Ok(EpochIdempotentCommitResult::Replay(
                serde_json::json!({ "replayed": true }).to_string(),
            )),
        );

        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("storage_error")
        );
    }

    #[tokio::test]
    async fn transfer_reservation_publishes_ordered_detach_then_attach_with_one_epoch() {
        let state = state_with_two_windows();
        let proof = "s".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let instance_id = Uuid::new_v4();
        let mut params = registration(&state, &proof, instance_id);
        params.windows = state
            .window_placements
            .iter()
            .map(|window| DesktopProviderWindowClaim {
                window_id: window.id.to_string(),
                generation: 1,
            })
            .collect();
        let registration = control
            .register(&state, params)
            .await
            .expect("registration succeeds");
        let identity = DesktopProviderIdentityParams {
            provider_id: registration.provider_id,
            provider_epoch: registration.provider_epoch,
            lease_id: registration.lease_id,
        };
        let source_window = &state.window_placements[0];
        let target_window = &state.window_placements[1];
        let source_workspace = state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == source_window.workspace_ids[0])
            .expect("source workspace");
        let target_workspace = state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == target_window.workspace_ids[0])
            .expect("target workspace");
        let tab = source_workspace.tabs.values().next().expect("source tab");
        let TabContent::Browser { metadata } = &tab.content else {
            panic!("fixture is browser");
        };
        let correlation = Uuid::new_v4();
        let reservation = control
            .reserve_tab_transfer(
                source_window.id,
                target_window.id,
                false,
                correlation,
                77,
                tab.id,
                metadata.browser_session_id().to_string(),
                RuntimeOwnershipKind::Browser,
                Some(BrowserOwnershipTransferDescriptor {
                    browser_session_id: metadata.browser_session_id().to_string(),
                    url: metadata.url().to_owned(),
                    title: metadata.navigation_title().to_owned(),
                    profile_partition: metadata.profile_partition().to_owned(),
                    state_revision: metadata.state_revision(),
                    lifecycle_id: Uuid::nil().to_string(),
                }),
                source_workspace.id,
                tab.pane_id,
                target_workspace.id,
                target_workspace.selected_pane_id,
            )
            .await
            .expect("capacity reserves");
        let receivers = control
            .publish_reservation(reservation)
            .await
            .expect("reservation publishes");
        assert_eq!(receivers.len(), 2);
        let detach = control
            .poll(DesktopProviderPollParams {
                identity: identity.clone(),
                timeout_ms: 0,
            })
            .await
            .expect("poll succeeds")
            .request
            .expect("detach request");
        assert_eq!(
            detach.operation,
            DesktopProviderOperationKind::DetachOwnership
        );
        assert_eq!(detach.transfer_epoch, Some(77));
        assert_eq!(detach.correlation_id, correlation.to_string());
        control
            .acknowledge(DesktopProviderAcknowledgeParams {
                identity: identity.clone(),
                request_id: detach.request_id,
                correlation_id: detach.correlation_id,
                attempt_epoch: detach.attempt_epoch,
                status: DesktopProviderCompletionStatus::Succeeded,
                error_code: None,
            })
            .await
            .expect("detach ack succeeds");
        let attach = control
            .poll(DesktopProviderPollParams {
                identity,
                timeout_ms: 0,
            })
            .await
            .expect("poll succeeds")
            .request
            .expect("attach request");
        assert_eq!(
            attach.operation,
            DesktopProviderOperationKind::AttachOwnership
        );
        assert_eq!(attach.transfer_epoch, Some(77));
        assert_eq!(attach.correlation_id, correlation.to_string());
    }

    #[tokio::test]
    async fn close_rehome_reserves_all_resource_moves_before_final_close() {
        let state = state_with_two_windows();
        let proof = "t".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params.windows = state
            .window_placements
            .iter()
            .map(|window| DesktopProviderWindowClaim {
                window_id: window.id.to_string(),
                generation: 1,
            })
            .collect();
        let registered = control
            .register(&state, params)
            .await
            .expect("registration succeeds");
        let identity = DesktopProviderIdentityParams {
            provider_id: registered.provider_id,
            provider_epoch: registered.provider_epoch,
            lease_id: registered.lease_id,
        };
        let source = state.window_placements[0].id;
        let target = state.window_placements[1].id;
        let correlation = Uuid::new_v4();
        let reservation = control
            .reserve_window_rehome(&state, source, target, correlation, 91)
            .await
            .expect("entire rehome plan reserves");
        let published = control
            .publish_reservation(reservation)
            .await
            .expect("rehome plan publishes");
        assert_eq!(published.len(), 3);
        for expected in [
            DesktopProviderOperationKind::DetachOwnership,
            DesktopProviderOperationKind::AttachOwnership,
            DesktopProviderOperationKind::CloseWindow,
        ] {
            let request = control
                .poll(DesktopProviderPollParams {
                    identity: identity.clone(),
                    timeout_ms: 0,
                })
                .await
                .expect("poll succeeds")
                .request
                .expect("ordered request exists");
            assert_eq!(request.operation, expected);
            assert_eq!(request.correlation_id, correlation.to_string());
            if expected == DesktopProviderOperationKind::AttachOwnership {
                assert_eq!(request.target.window_id, target.to_string());
                assert_eq!(request.transfer_epoch, Some(91));
                let browser = request.browser.as_ref().expect("browser descriptor");
                assert!(browser.url.contains("https://example.com/"));
                assert!(Uuid::parse_str(&browser.lifecycle_id).is_ok());
            }
            control
                .acknowledge(DesktopProviderAcknowledgeParams {
                    identity: identity.clone(),
                    request_id: request.request_id,
                    correlation_id: request.correlation_id,
                    attempt_epoch: request.attempt_epoch,
                    status: DesktopProviderCompletionStatus::Succeeded,
                    error_code: None,
                })
                .await
                .expect("request acknowledgement succeeds");
        }
    }

    #[tokio::test]
    async fn window_create_reserves_complete_mixed_resource_plan_before_publish() {
        let mut state = state();
        let source = state.focused_window_id;
        let workspace_id = state.window_placements[0].workspace_ids[0];
        let pane_id = state.workspaces[0].selected_pane_id;
        let terminal_id = TabId::new();
        state
            .open_terminal_tab(
                workspace_id,
                pane_id,
                1,
                Tab::terminal(
                    terminal_id,
                    pane_id,
                    "Terminal",
                    TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80)
                        .expect("launch spec is valid"),
                    None,
                    Timestamp(2),
                )
                .expect("terminal tab is valid"),
                Timestamp(2),
            )
            .expect("terminal opens");
        state
            .bind_terminal_runtime_session(
                workspace_id,
                terminal_id,
                RuntimeSessionId::new("runtime-exact"),
                Timestamp(3),
            )
            .expect("terminal runtime binds");
        let proof = "u".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        control
            .register(&state, registration(&state, &proof, Uuid::new_v4()))
            .await
            .expect("registration succeeds");

        let target = WindowId::new();
        let correlation = Uuid::new_v4();
        let reservation = control
            .reserve_workspace_window_create(&state, source, target, workspace_id, correlation, 12)
            .await
            .expect("complete create plan reserves");
        let ProviderReservation::Reserved(reservation_ids) = &reservation else {
            panic!("first reservation must be new")
        };
        assert_eq!(reservation_ids.len(), 6);
        let requests = {
            let registry = control.providers.lock().await;
            reservation_ids
                .iter()
                .map(|id| registry.reservations[id].request.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            requests
                .iter()
                .map(|request| request.operation)
                .collect::<Vec<_>>(),
            vec![
                DesktopProviderOperationKind::CreateWindow,
                DesktopProviderOperationKind::DetachOwnership,
                DesktopProviderOperationKind::AttachOwnership,
                DesktopProviderOperationKind::DetachOwnership,
                DesktopProviderOperationKind::AttachOwnership,
                DesktopProviderOperationKind::CloseWindow,
            ]
        );
        assert_eq!(requests[0].target.window_id, target.to_string());
        assert_eq!(requests[0].target.generation, 1);
        assert!(
            requests[1..5]
                .iter()
                .all(|request| request.transfer_epoch == Some(12))
        );

        let mut observed_terminal = false;
        let mut observed_browser_lifecycle = None;
        for pair in requests[1..5].chunks_exact(2) {
            assert_eq!(pair[0].tab_id, pair[1].tab_id);
            assert_eq!(pair[0].runtime_session_id, pair[1].runtime_session_id);
            assert_eq!(pair[0].ownership_kind, pair[1].ownership_kind);
            assert_eq!(pair[0].browser, pair[1].browser);
            assert_eq!(pair[0].target.window_id, source.to_string());
            assert_eq!(pair[1].target.window_id, target.to_string());
            match pair[0].ownership_kind {
                Some(RuntimeOwnershipKind::Terminal) => {
                    observed_terminal = true;
                    assert_eq!(
                        pair[0].tab_id.as_deref(),
                        Some(terminal_id.to_string().as_str())
                    );
                    assert_eq!(pair[0].runtime_session_id.as_deref(), Some("runtime-exact"));
                    assert!(pair[0].browser.is_none());
                }
                Some(RuntimeOwnershipKind::Browser) => {
                    let browser = pair[0].browser.as_ref().expect("browser descriptor exists");
                    Uuid::parse_str(&browser.lifecycle_id).expect("fresh lifecycle is a UUID");
                    observed_browser_lifecycle = Some(browser.lifecycle_id.clone());
                }
                None => panic!("ownership kind is required"),
            }
        }
        assert!(observed_terminal);
        assert!(observed_browser_lifecycle.is_some());

        state
            .create_window_placement(target, "Created", workspace_id)
            .expect("durable topology moves before an exact retry");
        assert_eq!(
            control
                .reserve_workspace_window_create(
                    &state,
                    source,
                    target,
                    workspace_id,
                    correlation,
                    12,
                )
                .await,
            Ok(ProviderReservation::Existing)
        );
        assert_eq!(control.providers.lock().await.reservations.len(), 6);
        control.release_reservation(reservation).await;
    }

    #[tokio::test]
    async fn publish_rejects_a_provider_claim_generation_changed_after_reservation() {
        let state = state();
        let proof = "v".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let registered = control
            .register(&state, registration(&state, &proof, Uuid::new_v4()))
            .await
            .expect("registration succeeds");
        let reservation = control
            .reserve_window_operation(
                DesktopProviderOperationKind::FocusWindow,
                state.focused_window_id,
                None,
                Uuid::new_v4(),
            )
            .await
            .expect("focus reserves");
        {
            let mut registry = control.providers.lock().await;
            registry
                .providers
                .get_mut(&Uuid::parse_str(&registered.provider_id).expect("provider UUID"))
                .expect("provider remains registered")
                .claims
                .insert(state.focused_window_id, 2);
        }

        assert!(matches!(
            control.publish_reservation(reservation).await,
            Err("provider_epoch_mismatch")
        ));
        assert!(control.providers.lock().await.reservations.is_empty());
    }

    #[test]
    fn provider_saga_correlations_are_namespaced_and_epoch_scoped() {
        let key = Uuid::new_v4();
        let epoch = Uuid::new_v4();
        let create = provider_correlation("window.create", epoch, key);
        assert_eq!(create, provider_correlation("window.create", epoch, key));
        assert_ne!(create, provider_correlation("window.close", epoch, key));
        assert_ne!(
            create,
            provider_correlation("window.create", Uuid::new_v4(), key)
        );
    }

    #[tokio::test]
    async fn vanished_source_heartbeat_reserves_exact_terminal_and_browser_recovery() {
        let (state, terminal_id) = mixed_rehome_state();
        let source = state.window_placements[0].id;
        let target = state.window_placements[1].id;
        let proof = "w".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params.windows = vec![
            DesktopProviderWindowClaim {
                window_id: source.to_string(),
                generation: 7,
            },
            DesktopProviderWindowClaim {
                window_id: target.to_string(),
                generation: 9,
            },
        ];
        let registered = control
            .register(&state, params)
            .await
            .expect("registration succeeds");
        let identity = ParsedIdentity {
            provider_id: Uuid::parse_str(&registered.provider_id).expect("provider UUID"),
            provider_epoch: registered.provider_epoch,
            lease_id: Uuid::parse_str(&registered.lease_id).expect("lease UUID"),
        };
        let claims = [(target, 9)].into_iter().collect::<BTreeMap<_, _>>();
        let claimed_ids = claims.keys().copied().collect();
        let rehomes =
            preview_reconciliation_rehomes(&state, &claimed_ids).expect("reconciliation previews");
        assert_eq!(
            rehomes,
            vec![WindowRehome {
                source_window_id: source,
                target_window_id: target,
            }]
        );
        let saga = control
            .reserve_reconciliation_recovery(
                &state,
                &rehomes,
                &claims,
                Some(identity),
                "desktopProvider.heartbeat.recoverOwnership",
                41,
            )
            .await
            .expect("recovery reserves");
        assert_eq!(saga.requests.len(), 2);
        assert!(saga.requests.iter().all(|request| {
            request.operation == DesktopProviderOperationKind::RecoverOwnership
                && request.source.as_ref().is_some_and(|claim| {
                    claim.window_id == source.to_string() && claim.generation == 7
                })
                && request.target.window_id == target.to_string()
                && request.target.generation == 9
                && request.transfer_epoch == Some(41)
        }));
        let terminal = saga
            .requests
            .iter()
            .find(|request| request.ownership_kind == Some(RuntimeOwnershipKind::Terminal))
            .expect("terminal recovery exists");
        assert_eq!(
            terminal.tab_id.as_deref(),
            Some(terminal_id.to_string().as_str())
        );
        assert_eq!(
            terminal.runtime_session_id.as_deref(),
            Some("20000000-0000-4000-8000-000000000099")
        );
        let browser = saga
            .requests
            .iter()
            .find_map(|request| request.browser.as_ref())
            .expect("browser recovery exists");
        assert_ne!(browser.lifecycle_id, Uuid::nil().to_string());
        Uuid::parse_str(&browser.lifecycle_id).expect("lifecycle is a UUID");
        assert!(matches!(
            control
                .reserve_reconciliation_recovery(
                    &state,
                    &rehomes,
                    &claims,
                    Some(identity),
                    "desktopProvider.heartbeat.recoverOwnership",
                    41,
                )
                .await
                .expect("exact replay is accepted")
                .reservation,
            ProviderReservation::Existing
        ));
        assert_eq!(control.providers.lock().await.reservations.len(), 2);

        control
            .heartbeat(
                &state,
                DesktopProviderHeartbeatParams {
                    provider_id: registered.provider_id,
                    provider_epoch: registered.provider_epoch,
                    lease_id: registered.lease_id,
                    windows: vec![DesktopProviderWindowClaim {
                        window_id: target.to_string(),
                        generation: 9,
                    }],
                },
            )
            .await
            .expect("heartbeat applies incoming claims");
        let published = control
            .publish_reservation(saga.reservation)
            .await
            .expect("recovery publishes after heartbeat");
        assert_eq!(published.len(), 2);
        let mut reconciled = state;
        reconciled
            .reconcile_window_claims(&[target].into_iter().collect())
            .expect("durable reconciliation commits");
        assert!(reconciled.window_placement(source).is_none());
        assert_eq!(reconciled.window_placements[0].workspace_ids.len(), 2);
    }

    #[test]
    fn reconciliation_without_a_surviving_target_marks_sources_unhosted() {
        let mut state = state_with_two_windows();
        let reconciliation = state
            .reconcile_window_claims(&BTreeSet::new())
            .expect("no-target reconciliation succeeds");
        assert!(reconciliation.rehomes.is_empty());
        assert_eq!(state.window_placements.len(), 2);
        assert!(
            state
                .window_placements
                .iter()
                .all(|placement| placement.hosting_state == HostingState::Unhosted)
        );
    }

    #[tokio::test]
    async fn recovery_capacity_and_target_generation_are_precommit_guards() {
        let (state, _) = mixed_rehome_state();
        let source = state.window_placements[0].id;
        let target = state.window_placements[1].id;
        let proof = "x".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params.windows = vec![
            DesktopProviderWindowClaim {
                window_id: source.to_string(),
                generation: 1,
            },
            DesktopProviderWindowClaim {
                window_id: target.to_string(),
                generation: 2,
            },
        ];
        let registered = control
            .register(&state, params)
            .await
            .expect("registration succeeds");
        let identity = ParsedIdentity {
            provider_id: Uuid::parse_str(&registered.provider_id).expect("provider UUID"),
            provider_epoch: registered.provider_epoch,
            lease_id: Uuid::parse_str(&registered.lease_id).expect("lease UUID"),
        };
        let claims = [(target, 2)].into_iter().collect::<BTreeMap<_, _>>();
        let rehomes = preview_reconciliation_rehomes(&state, &claims.keys().copied().collect())
            .expect("reconciliation previews");
        for _ in 0..(MAX_PROVIDER_QUEUE - 1) {
            control
                .reserve_window_operation(
                    DesktopProviderOperationKind::FocusWindow,
                    target,
                    None,
                    Uuid::new_v4(),
                )
                .await
                .expect("capacity filler reserves");
        }
        assert!(matches!(
            control
                .reserve_reconciliation_recovery(
                    &state,
                    &rehomes,
                    &claims,
                    Some(identity),
                    "desktopProvider.heartbeat.recoverOwnership",
                    51,
                )
                .await,
            Err("provider_backpressure")
        ));

        control.providers.lock().await.reservations.clear();
        let saga = control
            .reserve_reconciliation_recovery(
                &state,
                &rehomes,
                &claims,
                Some(identity),
                "desktopProvider.heartbeat.recoverOwnership",
                51,
            )
            .await
            .expect("recovery reserves with capacity");
        control
            .providers
            .lock()
            .await
            .providers
            .get_mut(&identity.provider_id)
            .expect("provider remains")
            .claims
            .insert(target, 3);
        assert!(matches!(
            control.publish_reservation(saga.reservation).await,
            Err("provider_epoch_mismatch")
        ));
        assert!(control.providers.lock().await.reservations.is_empty());
    }

    #[tokio::test]
    async fn publication_generation_change_after_commit_recovers_or_unhosts_exact_target() {
        let mut state = state_with_two_windows();
        let source = state.window_placements[0].id;
        let target = state.window_placements[1].id;
        state
            .reconcile_window_claims(&[source, target].into_iter().collect())
            .expect("fixture windows become hosted");
        let proof = "y".repeat(43);
        let control = MultiWindowRuntime::new(
            DesktopProviderBootstrapSecret::new(proof.as_bytes()).expect("proof is strong"),
        );
        let mut params = registration(&state, &proof, Uuid::new_v4());
        params.windows = [source, target]
            .into_iter()
            .map(|window_id| DesktopProviderWindowClaim {
                window_id: window_id.to_string(),
                generation: 1,
            })
            .collect();
        let registered = control
            .register(&state, params)
            .await
            .expect("registration succeeds");
        let correlation = Uuid::new_v4();
        let reservation = control
            .reserve_window_rehome(&state, source, target, correlation, 61)
            .await
            .expect("native plan reserves before commit");
        let requests = control.reservation_requests(&reservation).await;
        let recovery_templates = recovery_templates_from_provider_requests(&requests);
        assert_eq!(recovery_templates.len(), 1);

        state
            .reconcile_window_claims(&[target].into_iter().collect())
            .expect("durable rehome commits");
        control
            .providers
            .lock()
            .await
            .providers
            .get_mut(&Uuid::parse_str(&registered.provider_id).expect("provider UUID"))
            .expect("provider remains")
            .claims
            .insert(target, 2);
        assert!(matches!(
            control.publish_reservation(reservation).await,
            Err("provider_epoch_mismatch")
        ));
        assert!(matches!(
            control
                .reserve_exact_recovery_requests(
                    &recovery_templates,
                    "providerSaga.publishFailure.recoverOwnership",
                    correlation,
                )
                .await,
            Err("provider_ineligible")
        ));
        mark_recovery_targets_unhosted_in_state(&mut state, [target].into_iter().collect())
            .expect("fallback marks durable owner unhosted");
        assert_eq!(
            state
                .window_placement(target)
                .expect("durable target survives")
                .hosting_state,
            HostingState::Unhosted
        );
    }

    #[test]
    fn failed_recovery_marks_the_durable_owner_unhosted() {
        let mut state = state_with_two_windows();
        let source = state.window_placements[0].id;
        let target = state.window_placements[1].id;
        state
            .reconcile_window_claims(&[source, target].into_iter().collect())
            .expect("fixture windows become hosted");
        state
            .reconcile_window_claims(&[target].into_iter().collect())
            .expect("source rehomes to target");
        mark_recovery_targets_unhosted_in_state(&mut state, [target].into_iter().collect())
            .expect("failure fallback commits");
        assert!(state.window_placement(source).is_none());
        assert_eq!(
            state
                .window_placement(target)
                .expect("target survives")
                .hosting_state,
            HostingState::Unhosted
        );
    }
}

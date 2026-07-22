//! Capability-gated advanced-tab, multi-window, and desktop-provider wire contracts.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::WindowStateSnapshot;

/// The capability is advertised only when the complete M3 command family is enabled.
pub const MULTI_WINDOW_CAPABILITY: &str = "multi-window-v1";
pub const MAX_WINDOW_PLACEMENTS: usize = 16;
pub const MAX_WORKSPACES_PER_PLACEMENT: usize = 128;
pub const MAX_RECENTLY_CLOSED: usize = 100;
pub const MAX_PROVIDER_CAPABILITIES: usize = 16;
pub const MAX_PROVIDER_WINDOWS: usize = 16;
pub const MAX_PROVIDER_QUEUE: usize = 32;
pub const PROVIDER_LEASE_SECONDS: u64 = 15;
pub const PROVIDER_HEARTBEAT_SECONDS: u64 = 5;

/// Stable failure codes used by every command in `multi-window-v1`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MultiWindowErrorCode {
    CapabilityUnavailable,
    StaleRevision,
    StaleWindowRevision,
    IdempotencyConflict,
    IdempotencyExpired,
    SourceNotFound,
    TargetNotFound,
    PlacementRequired,
    ProviderUnavailable,
    ProviderIneligible,
    ProviderBackpressure,
    ProviderLeaseExpired,
    ProviderEpochMismatch,
    WindowUnhosted,
    TransferConflict,
    TransferCanceled,
    CancellationNotGuaranteed,
    PolicyDenied,
    ResourceLimit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WindowHostingState {
    Hosted,
    Unhosted,
    Closing,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WindowClosePolicy {
    Rehome,
    CloseWorkspaces,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ClosedItemKind {
    Tab,
    Workspace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ClosedContentKind {
    Terminal,
    Browser,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FocusNavigationDirection {
    Back,
    Forward,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MultiWindowChangeReason {
    WindowCreated,
    WindowClosed,
    WindowFocused,
    WindowRehomed,
    HostingChanged,
    TabDuplicated,
    TabMoved,
    TabDetached,
    TabClosed,
    TabReopened,
    FocusHistoryNavigated,
    ProviderChanged,
    ResyncRequired,
}

/// Authoritative default insertion point for moving a tab into a window's focused pane.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowDefaultTabDestination {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "tab_destination_index")]
    pub destination_index: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowPlacementSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "window_label")]
    pub label: String,
    #[serde(deserialize_with = "bounded_workspace_ids")]
    pub workspace_ids: Vec<String>,
    #[serde(deserialize_with = "uuid_string")]
    pub focused_workspace_id: String,
    pub hosting_state: WindowHostingState,
    pub default_tab_destination: WindowDefaultTabDestination,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowPlacementSnapshotWire {
    #[serde(deserialize_with = "uuid_string")]
    window_id: String,
    #[serde(deserialize_with = "window_label")]
    label: String,
    #[serde(deserialize_with = "bounded_workspace_ids")]
    workspace_ids: Vec<String>,
    #[serde(deserialize_with = "uuid_string")]
    focused_workspace_id: String,
    hosting_state: WindowHostingState,
    default_tab_destination: WindowDefaultTabDestination,
    #[serde(deserialize_with = "safe_integer")]
    revision: u64,
}

impl<'de> Deserialize<'de> for WindowPlacementSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WindowPlacementSnapshotWire::deserialize(deserializer)?;
        if !wire.workspace_ids.contains(&wire.focused_workspace_id)
            || wire.default_tab_destination.workspace_id != wire.focused_workspace_id
        {
            return Err(serde::de::Error::custom(
                "window focus and default tab destination must belong to the placement",
            ));
        }
        Ok(Self {
            window_id: wire.window_id,
            label: wire.label,
            workspace_ids: wire.workspace_ids,
            focused_workspace_id: wire.focused_workspace_id,
            hosting_state: wire.hosting_state,
            default_tab_destination: wire.default_tab_destination,
            revision: wire.revision,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowListResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "bounded_windows")]
    pub windows: Vec<WindowPlacementSnapshot>,
    #[serde(deserialize_with = "uuid_string")]
    pub focused_window_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowListResultWire {
    #[serde(deserialize_with = "safe_integer")]
    revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    idempotency_epoch: String,
    #[serde(deserialize_with = "bounded_windows")]
    windows: Vec<WindowPlacementSnapshot>,
    #[serde(deserialize_with = "uuid_string")]
    focused_window_id: String,
}

impl<'de> Deserialize<'de> for WindowListResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WindowListResultWire::deserialize(deserializer)?;
        if !wire
            .windows
            .iter()
            .any(|window| window.window_id == wire.focused_window_id)
        {
            return Err(serde::de::Error::custom(
                "focused window is outside the topology",
            ));
        }
        Ok(Self {
            revision: wire.revision,
            idempotency_epoch: wire.idempotency_epoch,
            windows: wire.windows,
            focused_window_id: wire.focused_window_id,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MultiWindowMutationToken {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowRevisionPrecondition {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowCreateParams {
    pub mutation: MultiWindowMutationToken,
    #[serde(deserialize_with = "window_label")]
    pub label: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub source_window: WindowRevisionPrecondition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WindowCloseParams {
    pub mutation: MultiWindowMutationToken,
    pub window: WindowRevisionPrecondition,
    pub policy: WindowClosePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rehome_target: Option<WindowRevisionPrecondition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowCloseParamsWire {
    mutation: MultiWindowMutationToken,
    window: WindowRevisionPrecondition,
    policy: WindowClosePolicy,
    #[serde(default)]
    rehome_target: Option<WindowRevisionPrecondition>,
}

impl<'de> Deserialize<'de> for WindowCloseParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WindowCloseParamsWire::deserialize(deserializer)?;
        if matches!(wire.policy, WindowClosePolicy::Rehome) != wire.rehome_target.is_some() {
            return Err(serde::de::Error::custom(
                "rehome target must be present exactly for rehome policy",
            ));
        }
        if wire
            .rehome_target
            .as_ref()
            .is_some_and(|target| target.window_id == wire.window.window_id)
        {
            return Err(serde::de::Error::custom("window cannot rehome to itself"));
        }
        Ok(Self {
            mutation: wire.mutation,
            window: wire.window,
            policy: wire.policy,
            rehome_target: wire.rehome_target,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowFocusParams {
    pub mutation: MultiWindowMutationToken,
    pub window: WindowRevisionPrecondition,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowMutationResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    pub window: WindowPlacementSnapshot,
    pub replayed: bool,
}

/// Result of removing a window placement. The removed window is represented only by identity;
/// when workspaces were rehomed the surviving target snapshot is returned.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WindowCloseResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "uuid_string")]
    pub closed_window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rehome_target: Option<WindowPlacementSnapshot>,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowStateGetForParams {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WindowStateGetForResult {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_window_state"
    )]
    pub state: Option<WindowStateSnapshot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowStateUpdateForParams {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    pub state: WindowStateSnapshot,
}

/// An exact tab destination. The service resolves no implicit window, workspace, pane, or index.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ExactTabPlacement {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "tab_destination_index")]
    pub destination_index: u32,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_window_revision: u64,
}

/// Authoritative placement returned after commit; unlike a request target it has no precondition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabPlacementSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "tab_destination_index")]
    pub index: u32,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub window_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabSource {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_window_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabDuplicateParams {
    pub mutation: MultiWindowMutationToken,
    pub source: TabSource,
    pub target: ExactTabPlacement,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabMoveExactParams {
    pub mutation: MultiWindowMutationToken,
    pub source: TabSource,
    pub target: ExactTabPlacement,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabDetachParams {
    pub mutation: MultiWindowMutationToken,
    pub source: TabSource,
    #[serde(deserialize_with = "window_label")]
    pub window_label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabCloseAdvancedParams {
    pub mutation: MultiWindowMutationToken,
    pub source: TabSource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabReopenParams {
    pub mutation: MultiWindowMutationToken,
    #[serde(deserialize_with = "uuid_string")]
    pub closed_item_id: String,
    pub target: ExactTabPlacement,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RuntimeOwnershipKind {
    Terminal,
    Browser,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AdvancedTabMutationResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub runtime_session_id: Option<String>,
    pub ownership_kind: RuntimeOwnershipKind,
    pub placement: TabPlacementSnapshot,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub closed_item_id: Option<String>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub transfer_epoch: u64,
    pub replayed: bool,
}

/// Result of closing a tab. No post-commit placement is fabricated for the removed tab.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AdvancedTabCloseResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "uuid_string")]
    pub closed_tab_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub closed_item_id: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ClosedItemSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub closed_item_id: String,
    pub item_kind: ClosedItemKind,
    #[serde(deserialize_with = "uuid_string")]
    pub prior_item_id: String,
    pub content_kind: ClosedContentKind,
    #[serde(deserialize_with = "closed_title")]
    pub title: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub closed_at_ms: u64,
    pub restored: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ClosedItemListResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "bounded_closed_items")]
    pub items: Vec<ClosedItemSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ClosedItemGetParams {
    #[serde(deserialize_with = "uuid_string")]
    pub closed_item_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ClosedItemGetResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub item: ClosedItemSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FocusHistoryNavigateParams {
    pub mutation: MultiWindowMutationToken,
    pub direction: FocusNavigationDirection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FocusTargetSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FocusHistoryNavigateResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    pub target: FocusTargetSnapshot,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MultiWindowChangedEvent {
    #[ts(type = "\"window.topologyChanged\"")]
    pub event: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "bounded_uuid_list")]
    pub window_ids: Vec<String>,
    pub reason: MultiWindowChangeReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabOwnershipTransferredEvent {
    #[ts(type = "\"tab.ownershipTransferred\"")]
    pub event: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub transfer_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub runtime_session_id: String,
    pub ownership_kind: RuntimeOwnershipKind,
    pub source: TabPlacementSnapshot,
    pub target: TabPlacementSnapshot,
    pub reason: MultiWindowChangeReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderWindowClaim {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderRegisterParams {
    #[serde(deserialize_with = "bootstrap_proof")]
    pub bootstrap_proof: String,
    #[serde(deserialize_with = "uuid_string")]
    pub instance_id: String,
    #[serde(deserialize_with = "provider_capabilities")]
    pub capabilities: Vec<String>,
    #[serde(deserialize_with = "provider_window_claims")]
    pub windows: Vec<DesktopProviderWindowClaim>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderRegistration {
    #[serde(deserialize_with = "uuid_string")]
    pub provider_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub provider_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub lease_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub lease_expires_at_ms: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub registration_sequence: u64,
    #[serde(deserialize_with = "heartbeat_interval")]
    pub heartbeat_interval_ms: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderHeartbeatParams {
    #[serde(deserialize_with = "uuid_string")]
    pub provider_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub provider_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub lease_id: String,
    #[serde(deserialize_with = "provider_window_claims")]
    pub windows: Vec<DesktopProviderWindowClaim>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderHeartbeatResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub lease_expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderIdentityParams {
    #[serde(deserialize_with = "uuid_string")]
    pub provider_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub provider_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderUnregisterParams {
    pub identity: DesktopProviderIdentityParams,
}

/// Binds one authenticated control connection to one provider-owned window generation.
///
/// The binding is connection-local and must precede legacy workspace, pane, tab, or terminal
/// commands once more than one placement exists.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowBindParams {
    pub identity: DesktopProviderIdentityParams,
    pub window: DesktopProviderWindowClaim,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowBindResult {
    pub window: WindowPlacementSnapshot,
}

/// Explicit placement binding for an authenticated non-renderer control client such as the CLI.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CliWindowBindParams {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DesktopProviderOperationKind {
    CreateWindow,
    CloseWindow,
    FocusWindow,
    AttachOwnership,
    DetachOwnership,
    RecoverOwnership,
}

/// Privileged authoritative browser state sufficient to create the target `BrowserView`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserOwnershipTransferDescriptor {
    #[serde(deserialize_with = "uuid_string")]
    pub browser_session_id: String,
    #[serde(deserialize_with = "safe_browser_transfer_url")]
    pub url: String,
    #[serde(deserialize_with = "browser_transfer_title")]
    pub title: String,
    #[serde(deserialize_with = "browser_transfer_partition")]
    pub profile_partition: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub state_revision: u64,
    /// Service-issued lifecycle generation for deterministic native adoption.
    #[serde(deserialize_with = "uuid_string")]
    pub lifecycle_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct DesktopProviderRequest {
    #[serde(deserialize_with = "uuid_string")]
    pub request_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub attempt_epoch: u64,
    pub operation: DesktopProviderOperationKind,
    pub target: DesktopProviderWindowClaim,
    /// Exact former native owner. Present only for recovery adoption.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DesktopProviderWindowClaim>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub tab_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub runtime_session_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_safe_integer"
    )]
    #[ts(type = "number", optional)]
    pub transfer_epoch: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub workspace_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_kind: Option<RuntimeOwnershipKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<BrowserOwnershipTransferDescriptor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopProviderRequestWire {
    #[serde(deserialize_with = "uuid_string")]
    request_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    attempt_epoch: u64,
    operation: DesktopProviderOperationKind,
    target: DesktopProviderWindowClaim,
    #[serde(default)]
    source: Option<DesktopProviderWindowClaim>,
    #[serde(default, deserialize_with = "optional_uuid")]
    tab_id: Option<String>,
    #[serde(default, deserialize_with = "optional_uuid")]
    runtime_session_id: Option<String>,
    #[serde(default, deserialize_with = "optional_safe_integer")]
    transfer_epoch: Option<u64>,
    #[serde(default, deserialize_with = "optional_uuid")]
    workspace_id: Option<String>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pane_id: Option<String>,
    #[serde(default)]
    ownership_kind: Option<RuntimeOwnershipKind>,
    #[serde(default)]
    browser: Option<BrowserOwnershipTransferDescriptor>,
}

impl<'de> Deserialize<'de> for DesktopProviderRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DesktopProviderRequestWire::deserialize(deserializer)?;
        let has_resource = wire.tab_id.is_some()
            && wire.runtime_session_id.is_some()
            && wire.transfer_epoch.is_some()
            && wire.workspace_id.is_some()
            && wire.pane_id.is_some()
            && wire.ownership_kind.is_some();
        let no_resource = wire.tab_id.is_none()
            && wire.runtime_session_id.is_none()
            && wire.transfer_epoch.is_none()
            && wire.workspace_id.is_none()
            && wire.pane_id.is_none()
            && wire.ownership_kind.is_none()
            && wire.browser.is_none()
            && wire.source.is_none();
        let ownership_consistent = match wire.ownership_kind {
            Some(RuntimeOwnershipKind::Terminal) | None => wire.browser.is_none(),
            Some(RuntimeOwnershipKind::Browser) => wire.browser.as_ref().is_some_and(|browser| {
                wire.runtime_session_id.as_deref() == Some(browser.browser_session_id.as_str())
            }),
        };
        let consistent = match wire.operation {
            DesktopProviderOperationKind::AttachOwnership
            | DesktopProviderOperationKind::DetachOwnership => {
                has_resource && wire.source.is_none()
            }
            DesktopProviderOperationKind::RecoverOwnership => {
                has_resource
                    && wire
                        .source
                        .as_ref()
                        .is_some_and(|source| source.window_id != wire.target.window_id)
            }
            DesktopProviderOperationKind::CreateWindow
            | DesktopProviderOperationKind::CloseWindow
            | DesktopProviderOperationKind::FocusWindow => no_resource,
        };
        if !consistent || !ownership_consistent {
            return Err(serde::de::Error::custom(
                "provider operation resource correlation is incomplete or irrelevant",
            ));
        }
        Ok(Self {
            request_id: wire.request_id,
            correlation_id: wire.correlation_id,
            attempt_epoch: wire.attempt_epoch,
            operation: wire.operation,
            target: wire.target,
            source: wire.source,
            tab_id: wire.tab_id,
            runtime_session_id: wire.runtime_session_id,
            transfer_epoch: wire.transfer_epoch,
            workspace_id: wire.workspace_id,
            pane_id: wire.pane_id,
            ownership_kind: wire.ownership_kind,
            browser: wire.browser,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderPollParams {
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "poll_timeout")]
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct DesktopProviderPollResult {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_provider_request"
    )]
    pub request: Option<DesktopProviderRequest>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DesktopProviderCompletionStatus {
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct DesktopProviderAcknowledgeParams {
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    pub request_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub attempt_epoch: u64,
    pub status: DesktopProviderCompletionStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_error_code"
    )]
    pub error_code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopProviderAcknowledgeWire {
    identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    request_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    attempt_epoch: u64,
    status: DesktopProviderCompletionStatus,
    #[serde(default, deserialize_with = "optional_error_code")]
    error_code: Option<String>,
}

impl<'de> Deserialize<'de> for DesktopProviderAcknowledgeParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DesktopProviderAcknowledgeWire::deserialize(deserializer)?;
        let consistent = matches!(
            (wire.status, wire.error_code.is_some()),
            (DesktopProviderCompletionStatus::Failed, true)
                | (
                    DesktopProviderCompletionStatus::Succeeded
                        | DesktopProviderCompletionStatus::Canceled,
                    false
                )
        );
        if !consistent {
            return Err(serde::de::Error::custom(
                "failed acknowledgement requires an error code and other statuses forbid one",
            ));
        }
        Ok(Self {
            identity: wire.identity,
            request_id: wire.request_id,
            correlation_id: wire.correlation_id,
            attempt_epoch: wire.attempt_epoch,
            status: wire.status,
            error_code: wire.error_code,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopProviderCancelParams {
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    pub request_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub attempt_epoch: u64,
}

fn uuid_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    uuid::Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn optional_uuid<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    uuid_string(deserializer).map(Some)
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom(
            "integer exceeds JavaScript safe range",
        ));
    }
    Ok(value)
}

fn optional_safe_integer<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    safe_integer(deserializer).map(Some)
}

fn optional_provider_request<'de, D>(
    deserializer: D,
) -> Result<Option<DesktopProviderRequest>, D::Error>
where
    D: Deserializer<'de>,
{
    DesktopProviderRequest::deserialize(deserializer).map(Some)
}

fn optional_window_state<'de, D>(deserializer: D) -> Result<Option<WindowStateSnapshot>, D::Error>
where
    D: Deserializer<'de>,
{
    WindowStateSnapshot::deserialize(deserializer).map(Some)
}

fn normalized_bounded<'de, D>(
    deserializer: D,
    maximum: usize,
    name: &str,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value != value.trim()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(serde::de::Error::custom(format!(
            "{name} must be normalized, non-empty, control-free, and at most {maximum} scalars"
        )));
    }
    Ok(value)
}

fn window_label<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value != value.trim() || value.chars().count() > 128 || value.chars().any(char::is_control) {
        return Err(serde::de::Error::custom(
            "window label must be normalized, control-free, and at most 128 scalars",
        ));
    }
    Ok(value)
}

fn closed_title<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    normalized_bounded(deserializer, 160, "closed title")
}

fn bounded_uuid_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    if values.len() > MAX_WINDOW_PLACEMENTS {
        return Err(serde::de::Error::custom(
            "UUID list exceeds window capacity",
        ));
    }
    let mut unique = std::collections::BTreeSet::new();
    for value in &values {
        uuid::Uuid::parse_str(value).map_err(serde::de::Error::custom)?;
        if !unique.insert(value) {
            return Err(serde::de::Error::custom("UUID list contains duplicates"));
        }
    }
    Ok(values)
}

fn bounded_workspace_ids<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    if values.is_empty() || values.len() > MAX_WORKSPACES_PER_PLACEMENT {
        return Err(serde::de::Error::custom(
            "a window placement must own between 1 and 128 workspaces",
        ));
    }
    let mut unique = std::collections::BTreeSet::new();
    for value in &values {
        uuid::Uuid::parse_str(value).map_err(serde::de::Error::custom)?;
        if !unique.insert(value) {
            return Err(serde::de::Error::custom(
                "window placement contains a duplicate workspace",
            ));
        }
    }
    Ok(values)
}

fn bounded_windows<'de, D>(deserializer: D) -> Result<Vec<WindowPlacementSnapshot>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<WindowPlacementSnapshot>::deserialize(deserializer)?;
    if values.is_empty() || values.len() > MAX_WINDOW_PLACEMENTS {
        return Err(serde::de::Error::custom(
            "window list must be non-empty and bounded",
        ));
    }
    let mut window_ids = std::collections::BTreeSet::new();
    let mut workspace_ids = std::collections::BTreeSet::new();
    for window in &values {
        if !window_ids.insert(&window.window_id) {
            return Err(serde::de::Error::custom("duplicate window ID"));
        }
        if !window.workspace_ids.contains(&window.focused_workspace_id) {
            return Err(serde::de::Error::custom(
                "focused workspace is outside the window",
            ));
        }
        for workspace_id in &window.workspace_ids {
            if !workspace_ids.insert(workspace_id) {
                return Err(serde::de::Error::custom(
                    "workspace has multiple window owners",
                ));
            }
        }
    }
    Ok(values)
}

fn bounded_closed_items<'de, D>(deserializer: D) -> Result<Vec<ClosedItemSnapshot>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<ClosedItemSnapshot>::deserialize(deserializer)?;
    if values.len() > MAX_RECENTLY_CLOSED {
        return Err(serde::de::Error::custom(
            "recently-closed list exceeds capacity",
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    if values.iter().any(|item| !ids.insert(&item.closed_item_id)) {
        return Err(serde::de::Error::custom("duplicate recently-closed ID"));
    }
    Ok(values)
}

fn bootstrap_proof<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !(32..=256).contains(&value.len()) || value.chars().any(char::is_whitespace) {
        return Err(serde::de::Error::custom(
            "invalid desktop-provider bootstrap proof",
        ));
    }
    Ok(value)
}

fn safe_browser_transfer_url<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.chars().count() > 8_192
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || value.contains('\\')
    {
        return Err(serde::de::Error::custom("unsafe browser transfer URL"));
    }
    let parsed = url::Url::parse(&value)
        .map_err(|_| serde::de::Error::custom("unsafe browser transfer URL"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host_str().is_none()
    {
        return Err(serde::de::Error::custom(
            "browser transfer URL must be canonical credential-free http or https",
        ));
    }
    Ok(value)
}

fn browser_transfer_title<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.chars().count() > 256 || value.trim() != value || value.chars().any(char::is_control) {
        return Err(serde::de::Error::custom("invalid browser transfer title"));
    }
    Ok(value)
}

fn browser_transfer_partition<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(serde::de::Error::custom(
            "invalid browser transfer partition",
        ));
    }
    Ok(value)
}

fn provider_capabilities<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    if values.is_empty() || values.len() > MAX_PROVIDER_CAPABILITIES {
        return Err(serde::de::Error::custom(
            "provider capabilities must be non-empty and bounded",
        ));
    }
    let mut unique = std::collections::BTreeSet::new();
    for value in &values {
        if value.is_empty()
            || value.len() > 64
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
            })
            || !unique.insert(value)
        {
            return Err(serde::de::Error::custom(
                "invalid or duplicate provider capability",
            ));
        }
    }
    Ok(values)
}

fn provider_window_claims<'de, D>(
    deserializer: D,
) -> Result<Vec<DesktopProviderWindowClaim>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<DesktopProviderWindowClaim>::deserialize(deserializer)?;
    if values.len() > MAX_PROVIDER_WINDOWS {
        return Err(serde::de::Error::custom(
            "provider window claims exceed capacity",
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    if values.iter().any(|claim| !ids.insert(&claim.window_id)) {
        return Err(serde::de::Error::custom("duplicate provider window claim"));
    }
    Ok(values)
}

fn poll_timeout<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value > 5_000 {
        return Err(serde::de::Error::custom(
            "provider poll timeout exceeds 5000 ms",
        ));
    }
    Ok(value)
}

fn tab_destination_index<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value > 1_024 {
        return Err(serde::de::Error::custom(
            "tab destination index exceeds application tab capacity",
        ));
    }
    Ok(value)
}

fn heartbeat_interval<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if !(100..=5_000).contains(&value) {
        return Err(serde::de::Error::custom(
            "provider heartbeat interval must be within 100..=5000 ms",
        ));
    }
    Ok(value)
}

fn optional_error_code<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(serde::de::Error::custom("invalid provider error code"));
    }
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "10000000-0000-4000-8000-000000000001";
    const B: &str = "20000000-0000-4000-8000-000000000002";
    const C: &str = "30000000-0000-4000-8000-000000000003";
    const D: &str = "40000000-0000-4000-8000-000000000004";

    #[test]
    fn exact_move_rejects_unknown_fields_and_unsafe_integers() {
        let valid = json!({
            "mutation": {"expectedRevision": 4, "idempotencyEpoch": A, "idempotencyKey": B},
            "source": {"windowId": A, "workspaceId": B, "paneId": C, "tabId": D, "expectedWindowRevision": 2},
            "target": {"windowId": B, "workspaceId": A, "paneId": D, "destinationIndex": 0, "expectedWindowRevision": 3}
        });
        assert!(serde_json::from_value::<TabMoveExactParams>(valid.clone()).is_ok());
        let mut unknown = valid.clone();
        unknown["implicitTarget"] = json!(true);
        assert!(serde_json::from_value::<TabMoveExactParams>(unknown).is_err());
        let mut unsafe_revision = valid.clone();
        unsafe_revision["mutation"]["expectedRevision"] = json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<TabMoveExactParams>(unsafe_revision).is_err());

        let mut maximum_index = valid.clone();
        maximum_index["target"]["destinationIndex"] = json!(1_024);
        assert!(serde_json::from_value::<TabMoveExactParams>(maximum_index).is_ok());
        let mut above_capacity = valid;
        above_capacity["target"]["destinationIndex"] = json!(1_025);
        assert!(serde_json::from_value::<TabMoveExactParams>(above_capacity).is_err());
    }

    #[test]
    fn window_projection_enforces_single_workspace_owner() {
        let window = |id: &str| {
            json!({
                "windowId": id,
                "label": "Window",
                "workspaceIds": [C],
                "focusedWorkspaceId": C,
                "hostingState": "hosted",
                "defaultTabDestination": {
                    "workspaceId": C,
                    "paneId": D,
                    "destinationIndex": 0
                },
                "revision": 1
            })
        };
        let duplicate_owner = json!({
            "revision": 2,
            "idempotencyEpoch": A,
            "windows": [window(A), window(B)],
            "focusedWindowId": A
        });
        assert!(serde_json::from_value::<WindowListResult>(duplicate_owner).is_err());

        let missing_focus = json!({
            "revision": 2,
            "idempotencyEpoch": A,
            "windows": [window(A)],
            "focusedWindowId": B
        });
        assert!(serde_json::from_value::<WindowListResult>(missing_focus).is_err());
    }

    #[test]
    fn window_close_policy_and_target_are_consistent() {
        let params = |policy: &str, target: Option<&str>| {
            let mut value = json!({
                "mutation": {"expectedRevision": 4, "idempotencyEpoch": A, "idempotencyKey": B},
                "window": {"windowId": A, "expectedRevision": 2},
                "policy": policy
            });
            if let Some(target) = target {
                value["rehomeTarget"] = json!({"windowId": target, "expectedRevision": 3});
            }
            value
        };
        assert!(serde_json::from_value::<WindowCloseParams>(params("rehome", Some(B))).is_ok());
        assert!(serde_json::from_value::<WindowCloseParams>(params("rehome", None)).is_err());
        assert!(
            serde_json::from_value::<WindowCloseParams>(params("closeWorkspaces", Some(B)))
                .is_err()
        );
        assert!(
            serde_json::from_value::<WindowCloseParams>(params("closeWorkspaces", None)).is_ok()
        );
    }

    #[test]
    fn window_and_workspace_capacities_are_independent() {
        let workspace_ids = (0..128)
            .map(|index| format!("10000000-0000-4000-8000-{index:012x}"))
            .collect::<Vec<_>>();
        let placement = json!({
            "windowId": A,
            "label": "",
            "workspaceIds": workspace_ids,
            "focusedWorkspaceId": "10000000-0000-4000-8000-000000000000",
            "hostingState": "hosted",
            "defaultTabDestination": {
                "workspaceId": "10000000-0000-4000-8000-000000000000",
                "paneId": B,
                "destinationIndex": 0
            },
            "revision": 1
        });
        assert!(serde_json::from_value::<WindowPlacementSnapshot>(placement.clone()).is_ok());
        let mut too_many_workspaces = placement;
        too_many_workspaces["workspaceIds"] = json!(
            (0..129)
                .map(|index| format!("10000000-0000-4000-8000-{index:012x}"))
                .collect::<Vec<_>>()
        );
        assert!(serde_json::from_value::<WindowPlacementSnapshot>(too_many_workspaces).is_err());

        let event = |count: usize| {
            json!({
                "event": "window.topologyChanged",
                "revision": 1,
                "idempotencyEpoch": A,
                "windowIds": (0..count).map(|index| format!("20000000-0000-4000-8000-{index:012x}")).collect::<Vec<_>>(),
                "reason": "resyncRequired"
            })
        };
        assert!(serde_json::from_value::<MultiWindowChangedEvent>(event(16)).is_ok());
        assert!(serde_json::from_value::<MultiWindowChangedEvent>(event(17)).is_err());
    }

    #[test]
    fn provider_registration_is_bounded_and_strict() {
        let valid = json!({
            "bootstrapProof": "a".repeat(32),
            "instanceId": A,
            "capabilities": ["window-host-v1", "tab-transfer-v1"],
            "windows": [{"windowId": B, "generation": 1}]
        });
        assert!(serde_json::from_value::<DesktopProviderRegisterParams>(valid.clone()).is_ok());
        let mut duplicate = valid;
        duplicate["windows"] = json!([
            {"windowId": B, "generation": 1},
            {"windowId": B, "generation": 2}
        ]);
        assert!(serde_json::from_value::<DesktopProviderRegisterParams>(duplicate).is_err());
    }

    #[test]
    fn provider_poll_forbids_null_and_acknowledgements_are_status_consistent() {
        assert!(
            serde_json::from_value::<DesktopProviderPollResult>(json!({ "request": null }))
                .is_err()
        );
        let identity = json!({"providerId": A, "providerEpoch": 1, "leaseId": B});
        let acknowledgement = |status: &str, error_code: Option<&str>| {
            let mut value = json!({
                "identity": identity,
                "requestId": C,
                "correlationId": D,
                "attemptEpoch": 1,
                "status": status
            });
            if let Some(error_code) = error_code {
                value["errorCode"] = json!(error_code);
            }
            value
        };
        assert!(
            serde_json::from_value::<DesktopProviderAcknowledgeParams>(acknowledgement(
                "failed",
                Some("native_failure")
            ))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<DesktopProviderAcknowledgeParams>(acknowledgement(
                "failed", None
            ))
            .is_err()
        );
        assert!(
            serde_json::from_value::<DesktopProviderAcknowledgeParams>(acknowledgement(
                "succeeded",
                Some("native_failure")
            ))
            .is_err()
        );
    }

    #[test]
    fn provider_recovery_requires_exact_distinct_source_and_complete_resource() {
        let recover = json!({
            "requestId": A,
            "correlationId": B,
            "attemptEpoch": 3,
            "operation": "recoverOwnership",
            "source": {"windowId": C, "generation": 7},
            "target": {"windowId": D, "generation": 9},
            "tabId": A,
            "runtimeSessionId": B,
            "transferEpoch": 11,
            "workspaceId": C,
            "paneId": D,
            "ownershipKind": "terminal"
        });
        assert!(serde_json::from_value::<DesktopProviderRequest>(recover.clone()).is_ok());

        let mut missing_source = recover.clone();
        missing_source.as_object_mut().unwrap().remove("source");
        assert!(serde_json::from_value::<DesktopProviderRequest>(missing_source).is_err());

        let mut same_source = recover.clone();
        same_source["source"]["windowId"] = json!(D);
        assert!(serde_json::from_value::<DesktopProviderRequest>(same_source).is_err());

        let mut incomplete = recover.clone();
        incomplete
            .as_object_mut()
            .unwrap()
            .remove("runtimeSessionId");
        assert!(serde_json::from_value::<DesktopProviderRequest>(incomplete).is_err());

        let mut ordinary_attach = recover;
        ordinary_attach["operation"] = json!("attachOwnership");
        assert!(serde_json::from_value::<DesktopProviderRequest>(ordinary_attach).is_err());
    }
}

//! Pure, side-effect-free application domain model.
//!
//! The crate owns persistent workspace layout and selection state. It deliberately
//! does not create terminals, access storage, or depend on a user-interface runtime.

mod error;
mod ids;
mod model;
mod notification;
mod organization;
mod state;
mod topology;

pub use error::DomainError;
pub use ids::{
    ClosedItemId, CommandId, GroupId, LayoutId, NotificationId, PaneId, RuntimeSessionId, SplitId,
    TabId, WindowId, WorkspaceId,
};
pub use model::{
    ApplicationState, Axis, BrowserAction, BrowserMetadata, DEFAULT_SHORTCUT_CATALOG,
    DefaultShortcutBinding, LogicalShortcut, MAX_SAFE_INTEGER, Pane, PaneNode, ShortcutPlatform,
    SplitPlacement, Tab, TabContent, TerminalLaunchSpec, Timestamp, UncheckedApplicationState,
    Workspace, WorkspaceUpdate, default_shortcut_bindings,
};
pub use notification::{
    AttentionExcerpt, AttentionState, AttentionSummary, NOTIFICATION_BODY_MAX_CHARS,
    NOTIFICATION_RETENTION_CAP, NOTIFICATION_TITLE_MAX_CHARS, Notification, NotificationLevel,
    NotificationSettings, NotificationSource,
};
pub use organization::{
    APPLICATION_MAX_PANES, APPLICATION_MAX_TABS, APPLICATION_MAX_WORKSPACES,
    GROUP_ASSIGNMENT_MAX_COUNT, LAYOUT_FORMAT_VERSION, LAYOUT_MAX_COUNT, LAYOUT_TEMPLATE_MAX_BYTES,
    LAYOUT_TEMPLATE_MAX_PANES, LAYOUT_TEMPLATE_MAX_TABS, LAYOUT_TEMPLATE_MAX_WORKSPACES,
    LayoutApplyPlan, LayoutExportEnvelope, LayoutTabContentTemplate, LayoutTabTemplate,
    LayoutTemplate, LayoutWorkspaceTemplate, LegacyOverLimit, SavedLayout, WorkspaceGroup,
};
pub use state::{MutationOutcome, SplitContent, TerminalLaunchRequest};
pub use topology::{
    CLOSED_ITEM_RETENTION_CAP, CLOSED_ITEM_RETENTION_MS, CLOSED_ITEM_TITLE_MAX_CHARS,
    ClosedContentKind, ClosedItemKind, ClosedItemRecord, FOCUS_HISTORY_CAP, FocusHistory,
    FocusTarget, HostingState, MAX_WINDOW_LABEL_CHARS, RestoreDescriptor, WINDOW_PLACEMENT_CAP,
    WindowHostingReconciliation, WindowPlacement, WindowRehome,
};

//! Milestone 2 workspace, pane, tab, and shortcut wire contracts.

use crate::{AttentionSummary, NotificationSettings};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeSet;
use ts_rs::TS;
use uuid::Uuid;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const COMMAND_CATALOG: [(&str, &str); 12] = [
    ("workspace.new", "Primary+O"),
    ("terminal.new", "Primary+T"),
    ("tab.close", "Primary+W"),
    ("pane.splitRight", "Primary+D"),
    ("pane.splitDown", "Primary+Shift+D"),
    ("sidebar.toggle", "Primary+B"),
    ("commandPalette.toggle", "Primary+Shift+P"),
    ("terminal.search", "Primary+F"),
    ("browser.openSplit", "Primary+Shift+L"),
    ("notifications.toggle", "Primary+I"),
    ("notifications.latestUnread", "Primary+Shift+U"),
    ("settings.open", "Primary+Comma"),
];

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ApplicationSnapshot {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub workspaces: Vec<WorkspaceSnapshot>,
    #[serde(deserialize_with = "uuid_string")]
    pub selected_workspace_id: String,
    pub shortcut_overrides: Vec<ShortcutOverride>,
    pub attention: AttentionSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "workspace_name")]
    pub name: String,
    #[serde(deserialize_with = "required_nullable_description")]
    pub description: Option<String>,
    #[serde(deserialize_with = "required_nullable_color")]
    pub color: Option<String>,
    #[serde(deserialize_with = "absolute_path")]
    pub working_directory: String,
    pub layout: PaneTreeNode,
    #[serde(deserialize_with = "uuid_string")]
    pub selected_pane_id: String,
    pub panes: Vec<PaneSnapshot>,
    pub tabs: Vec<TabSnapshot>,
    pub attention: AttentionSummary,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub created_at: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
#[ts(export)]
pub enum PaneTreeNode {
    Leaf {
        #[serde(deserialize_with = "uuid_string")]
        pane_id: String,
    },
    Split {
        #[serde(deserialize_with = "uuid_string")]
        split_id: String,
        axis: SplitAxis,
        #[serde(deserialize_with = "split_ratio")]
        ratio: f64,
        first: Box<Self>,
        second: Box<Self>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub enum SplitAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub enum SplitPlacement {
    Before,
    After,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "uuid_vec")]
    pub tab_ids: Vec<String>,
    #[serde(deserialize_with = "uuid_string")]
    pub selected_tab_id: String,
    #[serde(deserialize_with = "required_nullable_title")]
    pub title: Option<String>,
    pub attention: AttentionSummary,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    #[serde(deserialize_with = "required_nullable_title")]
    pub custom_title: Option<String>,
    pub content: TabContentSnapshot,
    pub attention: AttentionSummary,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
#[ts(export)]
pub enum TabContentSnapshot {
    Terminal {
        launch: TerminalLaunchMetadata,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[serde(default, deserialize_with = "optional_uuid")]
        runtime_session_id: Option<String>,
    },
    Browser {
        state: BrowserSessionState,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalLaunchMetadata {
    #[serde(deserialize_with = "absolute_path")]
    pub cwd: String,
    #[serde(deserialize_with = "terminal_dimension")]
    pub rows: u16,
    #[serde(deserialize_with = "terminal_dimension")]
    pub cols: u16,
}

/// Ephemeral terminal launch request. `command` is never persisted in snapshots.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TerminalLaunchRequest {
    #[serde(deserialize_with = "absolute_path")]
    pub cwd: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_command"
    )]
    pub command: Option<Vec<String>>,
    #[serde(deserialize_with = "terminal_dimension")]
    pub rows: u16,
    #[serde(deserialize_with = "terminal_dimension")]
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserPlaceholderMetadata {
    #[serde(deserialize_with = "safe_browser_url")]
    pub url: String,
}

/// Complete backend-authoritative browser-session projection.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserSessionState {
    #[serde(deserialize_with = "uuid_string")]
    pub browser_session_id: String,
    #[serde(deserialize_with = "safe_browser_url")]
    pub url: String,
    #[serde(deserialize_with = "browser_navigation_title")]
    pub navigation_title: String,
    pub can_back: bool,
    pub can_forward: bool,
    pub loading: bool,
    pub dev_tools_open: bool,
    #[serde(deserialize_with = "browser_partition")]
    pub profile_partition: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub state_revision: u64,
    #[serde(deserialize_with = "required_nullable_browser_correlation")]
    pub correlation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ShortcutOverride {
    #[serde(deserialize_with = "catalog_command_id")]
    pub command_id: String,
    /// `null` means that the project-owned shortcut is explicitly cleared.
    #[serde(deserialize_with = "required_nullable_shortcut")]
    pub shortcut: Option<String>,
}

impl<'de> Deserialize<'de> for WorkspaceSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Keep graph validation at the serde boundary without changing the public DTO or its
        // ts-rs export. Field-level deserializers retain the scalar wire constraints; this
        // private shape exists only so all fields are available for the cross-reference pass.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "uuid_string")]
            id: String,
            #[serde(deserialize_with = "workspace_name")]
            name: String,
            #[serde(deserialize_with = "required_nullable_description")]
            description: Option<String>,
            #[serde(deserialize_with = "required_nullable_color")]
            color: Option<String>,
            #[serde(deserialize_with = "absolute_path")]
            working_directory: String,
            layout: PaneTreeNode,
            #[serde(deserialize_with = "uuid_string")]
            selected_pane_id: String,
            panes: Vec<PaneSnapshot>,
            tabs: Vec<TabSnapshot>,
            attention: AttentionSummary,
            #[serde(deserialize_with = "safe_integer")]
            created_at: u64,
            #[serde(deserialize_with = "safe_integer")]
            updated_at: u64,
        }

        let wire = Wire::deserialize(deserializer)?;
        let snapshot = Self {
            id: wire.id,
            name: wire.name,
            description: wire.description,
            color: wire.color,
            working_directory: wire.working_directory,
            layout: wire.layout,
            selected_pane_id: wire.selected_pane_id,
            panes: wire.panes,
            tabs: wire.tabs,
            attention: wire.attention,
            created_at: wire.created_at,
            updated_at: wire.updated_at,
        };
        validate_workspace_snapshot(&snapshot).map_err(serde::de::Error::custom)?;
        Ok(snapshot)
    }
}

impl<'de> Deserialize<'de> for ApplicationSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "safe_integer")]
            revision: u64,
            workspaces: Vec<WorkspaceSnapshot>,
            #[serde(deserialize_with = "uuid_string")]
            selected_workspace_id: String,
            shortcut_overrides: Vec<ShortcutOverride>,
            attention: AttentionSummary,
        }

        let wire = Wire::deserialize(deserializer)?;
        let snapshot = Self {
            revision: wire.revision,
            workspaces: wire.workspaces,
            selected_workspace_id: wire.selected_workspace_id,
            shortcut_overrides: wire.shortcut_overrides,
            attention: wire.attention,
        };
        validate_application_snapshot(&snapshot).map_err(serde::de::Error::custom)?;
        Ok(snapshot)
    }
}

fn validate_workspace_snapshot(snapshot: &WorkspaceSnapshot) -> Result<(), &'static str> {
    if snapshot.panes.is_empty() {
        return Err("workspace must contain at least one pane");
    }
    if snapshot.tabs.is_empty() {
        return Err("workspace must contain at least one tab");
    }

    let mut pane_ids = BTreeSet::new();
    let mut owned_tab_ids = BTreeSet::new();
    for pane in &snapshot.panes {
        if !pane_ids.insert(pane.id.as_str()) {
            return Err("pane ids must be unique within a workspace");
        }
        if pane.tab_ids.is_empty() {
            return Err("each pane must contain at least one tab");
        }
        if !pane.tab_ids.iter().any(|id| id == &pane.selected_tab_id) {
            return Err("selected tab is missing from its pane");
        }
        for tab_id in &pane.tab_ids {
            if !owned_tab_ids.insert(tab_id.as_str()) {
                return Err("a tab must be owned by exactly one pane");
            }
        }
    }

    let mut tab_ids = BTreeSet::new();
    for tab in &snapshot.tabs {
        if !tab_ids.insert(tab.id.as_str()) {
            return Err("tab ids must be unique within a workspace");
        }
    }
    if owned_tab_ids != tab_ids {
        return Err("pane tab order must reference every workspace tab exactly once");
    }
    for tab in &snapshot.tabs {
        let owner = snapshot
            .panes
            .iter()
            .find(|pane| pane.id == tab.pane_id)
            .ok_or("tab references a missing pane owner")?;
        if !owner.tab_ids.iter().any(|id| id == &tab.id) {
            return Err("tab pane ownership does not match pane tab order");
        }
    }

    let mut leaf_ids = BTreeSet::new();
    let mut split_ids = BTreeSet::new();
    collect_workspace_layout_ids(&snapshot.layout, &mut leaf_ids, &mut split_ids)?;
    if leaf_ids != pane_ids {
        return Err("layout leaves must match workspace panes exactly");
    }
    if !pane_ids.contains(snapshot.selected_pane_id.as_str()) {
        return Err("selected pane does not exist");
    }
    Ok(())
}

fn collect_workspace_layout_ids<'a>(
    node: &'a PaneTreeNode,
    leaf_ids: &mut BTreeSet<&'a str>,
    split_ids: &mut BTreeSet<&'a str>,
) -> Result<(), &'static str> {
    match node {
        PaneTreeNode::Leaf { pane_id } => {
            if !leaf_ids.insert(pane_id) {
                return Err("layout pane ids must be unique");
            }
        }
        PaneTreeNode::Split {
            split_id,
            first,
            second,
            ..
        } => {
            if !split_ids.insert(split_id) {
                return Err("split ids must be unique within a workspace");
            }
            collect_workspace_layout_ids(first, leaf_ids, split_ids)?;
            collect_workspace_layout_ids(second, leaf_ids, split_ids)?;
        }
    }
    Ok(())
}

fn validate_application_snapshot(snapshot: &ApplicationSnapshot) -> Result<(), &'static str> {
    if snapshot.workspaces.is_empty() {
        return Err("application must contain at least one workspace");
    }

    let mut workspace_ids = BTreeSet::new();
    let mut application_ids = BTreeSet::new();
    for workspace in &snapshot.workspaces {
        if !workspace_ids.insert(workspace.id.as_str()) {
            return Err("workspace ids must be unique");
        }
        if !application_ids.insert(workspace.id.as_str()) {
            return Err("application identities must be globally unique");
        }
        for pane in &workspace.panes {
            if !application_ids.insert(pane.id.as_str()) {
                return Err("application identities must be globally unique");
            }
        }
        collect_application_layout_ids(&workspace.layout, &mut application_ids)?;
        for tab in &workspace.tabs {
            if !application_ids.insert(tab.id.as_str()) {
                return Err("application identities must be globally unique");
            }
            if let TabContentSnapshot::Terminal {
                runtime_session_id: Some(runtime_session_id),
                ..
            } = &tab.content
                && !application_ids.insert(runtime_session_id.as_str())
            {
                return Err("application identities must be globally unique");
            }
        }
    }
    if !workspace_ids.contains(snapshot.selected_workspace_id.as_str()) {
        return Err("selected workspace does not exist");
    }

    let mut command_ids = BTreeSet::new();
    for shortcut_override in &snapshot.shortcut_overrides {
        if !command_ids.insert(shortcut_override.command_id.as_str()) {
            return Err("shortcut override command ids must be unique");
        }
    }
    Ok(())
}

fn collect_application_layout_ids<'a>(
    node: &'a PaneTreeNode,
    application_ids: &mut BTreeSet<&'a str>,
) -> Result<(), &'static str> {
    match node {
        PaneTreeNode::Leaf { .. } => Ok(()),
        PaneTreeNode::Split {
            split_id,
            first,
            second,
            ..
        } => {
            if !application_ids.insert(split_id) {
                return Err("application identities must be globally unique");
            }
            collect_application_layout_ids(first, application_ids)?;
            collect_application_layout_ids(second, application_ids)
        }
    }
}

/// Present wrapper means update; its nullable value distinguishes set from clear.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NullableStringUpdate {
    #[serde(deserialize_with = "required_nullable_description")]
    pub value: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct EmptyParams {}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceListResult {
    pub snapshot: ApplicationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceSnapshotParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceSnapshotResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub workspace: WorkspaceSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WorkspaceCreateParams {
    #[serde(deserialize_with = "workspace_name")]
    pub name: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_description"
    )]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_color"
    )]
    pub color: Option<String>,
    #[serde(deserialize_with = "absolute_path")]
    pub working_directory: String,
    pub initial_terminal: TerminalLaunchRequest,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WorkspaceUpdateParams {
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<NullableStringUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<NullableStringUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceSelectParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceMoveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub destination_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCloseParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MutationResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub snapshot: ApplicationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
#[ts(export)]
pub enum PaneSplitContent {
    NewTerminal {
        launch: TerminalLaunchRequest,
    },
    NewBrowser {
        #[serde(deserialize_with = "safe_browser_url")]
        url: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_browser_partition"
        )]
        #[ts(optional)]
        profile_partition: Option<String>,
    },
    ExistingTab {
        #[serde(deserialize_with = "uuid_string")]
        tab_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneSplitParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub target_pane_id: String,
    pub axis: SplitAxis,
    #[serde(deserialize_with = "split_ratio")]
    pub ratio: f64,
    pub placement: SplitPlacement,
    pub content: PaneSplitContent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneFocusParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneResizeParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub split_id: String,
    #[serde(deserialize_with = "split_ratio")]
    pub ratio: f64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneCloseParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneMoveTabParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub destination_pane_id: String,
    pub destination_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TabOpenTerminalParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub destination_index: Option<u32>,
    pub launch: TerminalLaunchRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TabOpenBrowserParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub destination_index: Option<u32>,
    pub metadata: BrowserPlaceholderMetadata,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_browser_partition"
    )]
    pub profile_partition: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserNavigateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub browser_session_id: String,
    #[serde(deserialize_with = "safe_browser_url")]
    pub url: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_state_revision: u64,
    #[serde(deserialize_with = "browser_correlation")]
    pub correlation_id: String,
}

macro_rules! browser_action_params {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[ts(export)]
        pub struct $name {
            #[serde(deserialize_with = "uuid_string")]
            pub browser_session_id: String,
            #[ts(type = "number")]
            #[serde(deserialize_with = "safe_integer")]
            pub expected_state_revision: u64,
            #[serde(deserialize_with = "browser_correlation")]
            pub correlation_id: String,
        }
    };
}

browser_action_params!(BrowserBackParams);
browser_action_params!(BrowserForwardParams);
browser_action_params!(BrowserReloadParams);
browser_action_params!(BrowserStopParams);
browser_action_params!(BrowserOpenDevToolsParams);

/// Authenticated desktop-main observation submitted to the authoritative service.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserObserveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    pub state: BrowserSessionState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabSelectParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TabUpdateParams {
    pub workspace_id: String,
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<NullableStringUpdate>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabMoveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub destination_pane_id: String,
    pub destination_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabCloseParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalRestartParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SettingsGetResult {
    #[ts(type = "number")]
    pub revision: u64,
    /// Complete ordered command catalog with default, override, and effective bindings.
    pub shortcuts: Vec<ShortcutSetting>,
    pub notifications: NotificationSettings,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ShortcutSetting {
    #[serde(deserialize_with = "catalog_command_id")]
    pub command_id: String,
    #[serde(deserialize_with = "shortcut")]
    pub default_shortcut: String,
    pub override_state: ShortcutOverrideState,
    #[serde(deserialize_with = "required_nullable_shortcut")]
    pub effective_shortcut: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
#[ts(export)]
pub enum ShortcutOverrideState {
    /// No persisted override; the effective binding inherits the default.
    Default,
    /// A user-selected logical shortcut replaces the default.
    Set {
        #[serde(deserialize_with = "shortcut")]
        shortcut: String,
    },
    /// The project-owned shortcut is explicitly disabled.
    Cleared,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct SettingsUpdateParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut_overrides: Option<Vec<ShortcutOverride>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationSettings>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SettingsResetKeyParams {
    #[serde(deserialize_with = "catalog_command_id")]
    pub command_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RevisionEventData {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_vec")]
    pub workspace_ids: Vec<String>,
    #[serde(deserialize_with = "uuid_vec")]
    pub pane_ids: Vec<String>,
    #[serde(deserialize_with = "uuid_vec")]
    pub tab_ids: Vec<String>,
    #[serde(deserialize_with = "catalog_command_id_vec")]
    pub command_ids: Vec<String>,
    #[serde(deserialize_with = "reason")]
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceChangedEvent(pub RevisionEventData);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceSelectionChangedEvent(pub RevisionEventData);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PaneLayoutChangedEvent(pub RevisionEventData);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TabChangedEvent(pub RevisionEventData);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserChangedEvent {
    pub state: BrowserSessionState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SettingsChangedEvent(pub RevisionEventData);

impl<'de> Deserialize<'de> for MutationResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "safe_integer")]
            revision: u64,
            snapshot: ApplicationSnapshot,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.revision != wire.snapshot.revision {
            return Err(serde::de::Error::custom(
                "mutation result and snapshot revisions must match",
            ));
        }
        Ok(Self {
            revision: wire.revision,
            snapshot: wire.snapshot,
        })
    }
}

impl<'de> Deserialize<'de> for WorkspaceUpdateParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "uuid_string")]
            workspace_id: String,
            #[serde(default, deserialize_with = "optional_workspace_name")]
            name: Option<String>,
            #[serde(default, deserialize_with = "optional_non_null")]
            description: Option<NullableStringUpdate>,
            #[serde(default, deserialize_with = "optional_non_null")]
            color: Option<NullableStringUpdate>,
            #[serde(default, deserialize_with = "optional_absolute_path")]
            working_directory: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if let Some(Some(value)) = wire.color.as_ref().map(|update| update.value.as_ref()) {
            bounded_normalized::<D::Error>(value.clone(), 64, false)?;
        }
        Ok(Self {
            workspace_id: wire.workspace_id,
            name: wire.name,
            description: wire.description,
            color: wire.color,
            working_directory: wire.working_directory,
        })
    }
}

impl<'de> Deserialize<'de> for TabUpdateParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "uuid_string")]
            workspace_id: String,
            #[serde(deserialize_with = "uuid_string")]
            tab_id: String,
            #[serde(default, deserialize_with = "optional_title")]
            title: Option<String>,
            #[serde(default, deserialize_with = "optional_non_null")]
            custom_title: Option<NullableStringUpdate>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if let Some(Some(value)) = wire
            .custom_title
            .as_ref()
            .map(|update| update.value.as_ref())
        {
            bounded_normalized::<D::Error>(value.clone(), 256, false)?;
        }
        Ok(Self {
            workspace_id: wire.workspace_id,
            tab_id: wire.tab_id,
            title: wire.title,
            custom_title: wire.custom_title,
        })
    }
}

impl<'de> Deserialize<'de> for SettingsGetResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "safe_integer")]
            revision: u64,
            shortcuts: Vec<ShortcutSetting>,
            notifications: NotificationSettings,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.shortcuts.len() != COMMAND_CATALOG.len() {
            return Err(serde::de::Error::custom(
                "settings must contain the complete command catalog",
            ));
        }
        for (setting, (command_id, default_shortcut)) in wire.shortcuts.iter().zip(COMMAND_CATALOG)
        {
            if setting.command_id != command_id || setting.default_shortcut != default_shortcut {
                return Err(serde::de::Error::custom(
                    "settings command catalog is incomplete or out of order",
                ));
            }
            let expected = match &setting.override_state {
                ShortcutOverrideState::Default => Some(setting.default_shortcut.as_str()),
                ShortcutOverrideState::Set { shortcut } => Some(shortcut.as_str()),
                ShortcutOverrideState::Cleared => None,
            };
            if setting.effective_shortcut.as_deref() != expected {
                return Err(serde::de::Error::custom(
                    "effective shortcut does not match override state",
                ));
            }
        }
        Ok(Self {
            revision: wire.revision,
            shortcuts: wire.shortcuts,
            notifications: wire.notifications,
        })
    }
}

impl<'de> Deserialize<'de> for SettingsUpdateParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(default, deserialize_with = "optional_non_null")]
            shortcut_overrides: Option<Vec<ShortcutOverride>>,
            #[serde(default, deserialize_with = "optional_non_null")]
            notifications: Option<NotificationSettings>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.shortcut_overrides.is_none() && wire.notifications.is_none() {
            return Err(serde::de::Error::custom(
                "settings update must contain shortcutOverrides or notifications",
            ));
        }
        if let Some(overrides) = &wire.shortcut_overrides {
            let mut ids = BTreeSet::new();
            if overrides
                .iter()
                .any(|item| !ids.insert(item.command_id.as_str()))
            {
                return Err(serde::de::Error::custom(
                    "shortcut override command ids must be unique",
                ));
            }
        }
        Ok(Self {
            shortcut_overrides: wire.shortcut_overrides,
            notifications: wire.notifications,
        })
    }
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > MAX_SAFE_INTEGER {
        return Err(serde::de::Error::custom(
            "integer exceeds JavaScript safe range",
        ));
    }
    Ok(value)
}

fn uuid_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn optional_uuid<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    uuid_string(deserializer).map(Some)
}

fn uuid_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    let mut seen = std::collections::BTreeSet::new();
    for value in &values {
        Uuid::parse_str(value).map_err(serde::de::Error::custom)?;
        if !seen.insert(value) {
            return Err(serde::de::Error::custom(
                "UUID lists must not contain duplicates",
            ));
        }
    }
    Ok(values)
}

fn bounded_normalized<E>(value: String, max: usize, allow_empty: bool) -> Result<String, E>
where
    E: serde::de::Error,
{
    if trim_ecmascript_whitespace(&value) != value
        || (!allow_empty && value.is_empty())
        || value.chars().count() > max
    {
        return Err(E::custom("text is empty, untrimmed, or exceeds its bound"));
    }
    Ok(value)
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(is_ecmascript_trim_whitespace)
}

fn is_ecmascript_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

macro_rules! bounded_string_deserializer {
    ($name:ident, $max:expr, $allow_empty:expr) => {
        fn $name<'de, D>(deserializer: D) -> Result<String, D::Error>
        where
            D: Deserializer<'de>,
        {
            bounded_normalized(String::deserialize(deserializer)?, $max, $allow_empty)
        }
    };
}

bounded_string_deserializer!(workspace_name, 128, false);
bounded_string_deserializer!(title, 256, false);
bounded_string_deserializer!(reason, 256, false);

fn required_nullable<E>(
    value: Option<String>,
    max: usize,
    allow_empty: bool,
) -> Result<Option<String>, E>
where
    E: serde::de::Error,
{
    value
        .map(|value| bounded_normalized(value, max, allow_empty))
        .transpose()
}

macro_rules! nullable_string_deserializer {
    ($required:ident, $optional:ident, $max:expr, $allow_empty:expr) => {
        fn $required<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
        where
            D: Deserializer<'de>,
        {
            required_nullable(
                Option::<String>::deserialize(deserializer)?,
                $max,
                $allow_empty,
            )
        }

        fn $optional<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
        where
            D: Deserializer<'de>,
        {
            $required(deserializer).and_then(|value| {
                value
                    .ok_or_else(|| serde::de::Error::custom("null is not allowed here"))
                    .map(Some)
            })
        }
    };
}

nullable_string_deserializer!(
    required_nullable_description,
    optional_description,
    4_096,
    true
);
nullable_string_deserializer!(required_nullable_color, optional_color, 64, false);
nullable_string_deserializer!(required_nullable_title, optional_title, 256, false);

fn optional_workspace_name<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    workspace_name(deserializer).map(Some)
}

fn absolute_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !value.starts_with('/') || value.contains('\0') {
        return Err(serde::de::Error::custom(
            "path must be an absolute UTF-8 path",
        ));
    }
    Ok(value)
}

fn optional_absolute_path<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    absolute_path(deserializer).map(Some)
}

fn terminal_dimension<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if !(1..=1_000).contains(&value) {
        return Err(serde::de::Error::custom(
            "terminal dimension must be within 1..=1000",
        ));
    }
    Ok(value)
}

fn split_ratio<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || !(0.05..=0.95).contains(&value) {
        return Err(serde::de::Error::custom(
            "split ratio must be finite and within 0.05..=0.95",
        ));
    }
    Ok(value)
}

fn optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn optional_command<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Vec::<String>::deserialize(deserializer)?;
    if value.is_empty()
        || value
            .iter()
            .any(|argument| argument.is_empty() || argument.contains('\0'))
    {
        return Err(serde::de::Error::custom(
            "terminal command must contain non-empty arguments",
        ));
    }
    Ok(Some(value))
}

fn catalog_command_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !COMMAND_CATALOG
        .iter()
        .any(|(command_id, _)| *command_id == value)
    {
        return Err(serde::de::Error::custom("unknown command catalog key"));
    }
    Ok(value)
}

fn catalog_command_id_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    let mut seen = std::collections::BTreeSet::new();
    for value in &values {
        if !COMMAND_CATALOG
            .iter()
            .any(|(command_id, _)| command_id == value)
        {
            return Err(serde::de::Error::custom("unknown command catalog key"));
        }
        if !seen.insert(value) {
            return Err(serde::de::Error::custom(
                "command ID lists must not contain duplicates",
            ));
        }
    }
    Ok(values)
}

fn shortcut<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = bounded_normalized::<D::Error>(String::deserialize(deserializer)?, 128, false)?;
    let parts: Vec<_> = value.split('+').collect();
    let modifier_order = ["Primary", "Secondary", "Control", "Shift"];
    let modifiers = parts
        .get(..parts.len().saturating_sub(1))
        .unwrap_or_default();
    let modifiers_are_canonical = parts.len() >= 2
        && modifiers.iter().enumerate().all(|(index, modifier)| {
            modifier_order
                .iter()
                .position(|candidate| candidate == modifier)
                .is_some_and(|position| {
                    index == 0
                        || modifier_order
                            .iter()
                            .position(|candidate| candidate == &modifiers[index - 1])
                            .is_some_and(|previous| position > previous)
                })
        });
    let key = parts.last().copied().unwrap_or_default();
    let key_is_canonical = (key.len() == 1
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
        || key
            .strip_prefix('F')
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number))
        || [
            "Backspace",
            "Tab",
            "Enter",
            "Escape",
            "Space",
            "Delete",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Comma",
            "Period",
            "Slash",
            "Backslash",
            "Semicolon",
            "Quote",
            "BracketLeft",
            "BracketRight",
            "Minus",
            "Equal",
            "Backquote",
        ]
        .contains(&key);
    if value.chars().any(char::is_control) || !modifiers_are_canonical || !key_is_canonical {
        return Err(serde::de::Error::custom("invalid logical shortcut"));
    }
    Ok(value)
}

fn required_nullable_shortcut<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| {
            let deserializer = serde::de::value::StringDeserializer::<D::Error>::new(value);
            shortcut(deserializer)
        })
        .transpose()
}

fn safe_browser_url<'de, D>(deserializer: D) -> Result<String, D::Error>
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
        return Err(serde::de::Error::custom("unsafe browser URL"));
    }
    let (scheme, remainder) = value
        .split_once("://")
        .ok_or_else(|| serde::de::Error::custom("unsafe browser URL"))?;
    if !matches!(scheme, "http" | "https") {
        return Err(serde::de::Error::custom(
            "browser URL must use canonical http or https",
        ));
    }
    validate_browser_authority::<D::Error>(
        remainder.split(['/', '?', '#']).next().unwrap_or_default(),
    )?;
    Ok(value)
}

fn browser_navigation_title<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value != value.trim() || value.chars().count() > 256 || value.chars().any(char::is_control) {
        return Err(serde::de::Error::custom("invalid browser navigation title"));
    }
    Ok(value)
}

fn browser_partition<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.chars().count() > 128
        || !value.starts_with("persist:")
        || value.len() == "persist:".len()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(serde::de::Error::custom(
            "invalid browser profile partition",
        ));
    }
    Ok(value)
}

fn optional_browser_partition<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?
        .ok_or_else(|| serde::de::Error::custom("browser profile partition cannot be null"))?;
    browser_partition(serde::de::value::StringDeserializer::<D::Error>::new(value)).map(Some)
}

fn browser_correlation<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.chars().count() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(serde::de::Error::custom("invalid browser correlation ID"));
    }
    Ok(value)
}

fn required_nullable_browser_correlation<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| {
            browser_correlation(serde::de::value::StringDeserializer::<D::Error>::new(value))
        })
        .transpose()
}

fn validate_browser_authority<E>(authority: &str) -> Result<(), E>
where
    E: serde::de::Error,
{
    if authority.is_empty() || authority.contains(['@', '%']) {
        return Err(E::custom("unsafe browser URL authority"));
    }
    let port = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, suffix) = bracketed
            .split_once(']')
            .ok_or_else(|| E::custom("unsafe browser URL authority"))?;
        if host.is_empty()
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || matches!(byte, b':' | b'.'))
        {
            return Err(E::custom("unsafe browser URL authority"));
        }
        if suffix.is_empty() {
            None
        } else {
            Some(
                suffix
                    .strip_prefix(':')
                    .ok_or_else(|| E::custom("unsafe browser URL authority"))?,
            )
        }
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        if host.is_empty()
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err(E::custom("unsafe browser URL authority"));
        }
        port
    };
    if let Some(port) = port
        && (port.is_empty()
            || !port.bytes().all(|byte| byte.is_ascii_digit())
            || port.parse::<u16>().ok().is_none_or(|port| port == 0))
    {
        return Err(E::custom("unsafe browser URL port"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WORKSPACE_ID: &str = "10000000-0000-4000-8000-000000000001";
    const PANE_ID: &str = "30000000-0000-4000-8000-000000000001";

    fn minimal_launch() -> TerminalLaunchRequest {
        TerminalLaunchRequest {
            cwd: "/tmp".to_owned(),
            command: None,
            rows: 24,
            cols: 80,
        }
    }

    #[test]
    fn minimal_workspace_create_omits_optional_fields_and_rejects_null() {
        let encoded = serde_json::to_value(WorkspaceCreateParams {
            name: "Minimal workspace".to_owned(),
            description: None,
            color: None,
            working_directory: "/tmp".to_owned(),
            initial_terminal: minimal_launch(),
        })
        .expect("workspace create request must serialize");

        assert_eq!(
            encoded,
            json!({
                "name": "Minimal workspace",
                "workingDirectory": "/tmp",
                "initialTerminal": { "cwd": "/tmp", "rows": 24, "cols": 80 }
            })
        );
        for field in ["description", "color"] {
            let mut invalid = encoded.clone();
            invalid[field] = serde_json::Value::Null;
            assert!(serde_json::from_value::<WorkspaceCreateParams>(invalid).is_err());
        }
    }

    #[test]
    fn minimal_tab_open_terminal_omits_command_and_destination_and_rejects_null() {
        let encoded = serde_json::to_value(TabOpenTerminalParams {
            workspace_id: WORKSPACE_ID.to_owned(),
            pane_id: PANE_ID.to_owned(),
            destination_index: None,
            launch: minimal_launch(),
        })
        .expect("terminal open request must serialize");

        assert_eq!(
            encoded,
            json!({
                "workspaceId": WORKSPACE_ID,
                "paneId": PANE_ID,
                "launch": { "cwd": "/tmp", "rows": 24, "cols": 80 }
            })
        );
        let mut null_destination = encoded.clone();
        null_destination["destinationIndex"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<TabOpenTerminalParams>(null_destination).is_err());
        let mut null_command = encoded;
        null_command["launch"]["command"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<TabOpenTerminalParams>(null_command).is_err());
    }

    #[test]
    fn minimal_terminal_pane_split_omits_command_and_rejects_null() {
        let encoded = serde_json::to_value(PaneSplitParams {
            workspace_id: WORKSPACE_ID.to_owned(),
            target_pane_id: PANE_ID.to_owned(),
            axis: SplitAxis::Vertical,
            ratio: 0.5,
            placement: SplitPlacement::After,
            content: PaneSplitContent::NewTerminal {
                launch: minimal_launch(),
            },
        })
        .expect("pane split request must serialize");

        assert_eq!(
            encoded,
            json!({
                "workspaceId": WORKSPACE_ID,
                "targetPaneId": PANE_ID,
                "axis": "vertical",
                "ratio": 0.5,
                "placement": "after",
                "content": {
                    "kind": "newTerminal",
                    "launch": { "cwd": "/tmp", "rows": 24, "cols": 80 }
                }
            })
        );
        assert!(encoded.get("destinationIndex").is_none());
        let mut null_command = encoded;
        null_command["content"]["launch"]["command"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<PaneSplitParams>(null_command).is_err());
    }

    #[test]
    fn adjacent_strict_optional_request_fields_serialize_by_omission() {
        assert_eq!(
            serde_json::to_value(WorkspaceUpdateParams {
                workspace_id: WORKSPACE_ID.to_owned(),
                name: None,
                description: None,
                color: None,
                working_directory: None,
            })
            .expect("workspace update request must serialize"),
            json!({ "workspaceId": WORKSPACE_ID })
        );
        assert_eq!(
            serde_json::to_value(TabUpdateParams {
                workspace_id: WORKSPACE_ID.to_owned(),
                tab_id: "40000000-0000-4000-8000-000000000001".to_owned(),
                title: None,
                custom_title: None,
            })
            .expect("tab update request must serialize"),
            json!({
                "workspaceId": WORKSPACE_ID,
                "tabId": "40000000-0000-4000-8000-000000000001"
            })
        );
        assert_eq!(
            serde_json::to_value(TabOpenBrowserParams {
                workspace_id: WORKSPACE_ID.to_owned(),
                pane_id: PANE_ID.to_owned(),
                destination_index: None,
                metadata: BrowserPlaceholderMetadata {
                    url: "https://example.test".to_owned(),
                },
                profile_partition: None,
            })
            .expect("browser open request must serialize"),
            json!({
                "workspaceId": WORKSPACE_ID,
                "paneId": PANE_ID,
                "metadata": { "url": "https://example.test" }
            })
        );
        assert_eq!(
            serde_json::to_value(SettingsUpdateParams {
                shortcut_overrides: None,
                notifications: None,
            })
            .expect("settings update request must serialize"),
            json!({})
        );
    }
}

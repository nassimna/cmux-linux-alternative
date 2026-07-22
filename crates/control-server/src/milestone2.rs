use std::{
    collections::{BTreeSet, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use agent_workspace_core::{
    ApplicationState, AttentionSummary as CoreAttentionSummary, Axis, BrowserAction,
    BrowserMetadata, CommandId, DEFAULT_SHORTCUT_CATALOG, DomainError, LogicalShortcut,
    MAX_SAFE_INTEGER, MutationOutcome, Notification, NotificationId,
    NotificationLevel as CoreNotificationLevel, NotificationSettings as CoreNotificationSettings,
    NotificationSource as CoreNotificationSource, PaneId, PaneNode, ShortcutPlatform, SplitContent,
    SplitId, SplitPlacement as CoreSplitPlacement, Tab, TabContent, TabId, TerminalLaunchSpec,
    Timestamp, WindowId, Workspace, WorkspaceId, WorkspaceUpdate,
};
use agent_workspace_protocol::{
    ApplicationSnapshot, AttentionExcerpt, AttentionSummary, BrowserBackParams,
    BrowserChangedEvent, BrowserForwardParams, BrowserNavigateParams, BrowserObserveParams,
    BrowserOpenDevToolsParams, BrowserReloadParams, BrowserSessionState, BrowserStopParams,
    EmptyParams, EventEnvelope, IdentifyResult, MutationResult, NotificationChangedEvent,
    NotificationClearParams, NotificationClearScope, NotificationCreatedEvent, NotificationLevel,
    NotificationListParams, NotificationListResult, NotificationMarkReadParams,
    NotificationMarkUnreadParams, NotificationPublishParams, NotificationSettings,
    NotificationSnapshot, NotificationSource, PaneCloseParams, PaneFocusParams,
    PaneLayoutChangedEvent, PaneMoveTabParams, PaneResizeParams, PaneSnapshot, PaneSplitContent,
    PaneSplitParams, PaneTreeNode, ResponseEnvelope, RevisionEventData, SavedLayoutsChangeReason,
    SavedLayoutsChangedEvent, SettingsChangedEvent, SettingsGetResult, SettingsResetKeyParams,
    SettingsUpdateParams, ShortcutOverrideState, ShortcutSetting, SplitAxis, SplitPlacement,
    TabChangedEvent, TabCloseParams, TabContentSnapshot, TabMoveParams, TabOpenBrowserParams,
    TabOpenTerminalParams, TabSelectParams, TabSnapshot, TabUpdateParams, TerminalLaunchMetadata,
    TerminalRestartParams, WorkspaceChangedEvent, WorkspaceCloseParams, WorkspaceCreateParams,
    WorkspaceListResult, WorkspaceMoveParams, WorkspaceOrganizationChangeReason,
    WorkspaceOrganizationChangedEvent, WorkspaceSelectParams, WorkspaceSelectionChangedEvent,
    WorkspaceSnapshot, WorkspaceSnapshotParams, WorkspaceSnapshotResult, WorkspaceUpdateParams,
};
use agent_workspace_runtime::{
    CommitResult, DomainEvent, LaunchOptions, OperationFailure, ProductionWorkspaceRuntime,
    RuntimeError,
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::{Mutex, broadcast, mpsc};
use tracing::warn;
use uuid::Uuid;

#[cfg(test)]
use super::TerminalLifecycle;
use super::{ControlContext, serialize_frame};

const M1_IO_CAPABILITIES: &[&str] = &[
    "system.identify",
    "system.ping",
    "terminal.attach",
    "terminal.runtimeMetadata",
    "terminal.detach",
    "terminal.send",
    "terminal.resize",
    "terminal.checkpoint",
    "terminal.events",
];

#[cfg(test)]
const LEGACY_LIFECYCLE_CAPABILITIES: &[&str] = &["terminal.create", "terminal.terminate"];

const M2_CAPABILITIES: &[&str] = &[
    "terminal.restart",
    "workspace.list",
    "workspace.snapshot",
    "workspace.cardSlots.get",
    "workspace.cardSlots.replace",
    "workspace.cardSlots.events",
    "card-slots-v1",
    "workspace.cardSlots.v2.get",
    "workspace.cardSlots.v2.replace",
    "workspace.cardSlots.v2.events",
    "card-slots-v2",
    "workspace.create",
    "workspace.update",
    "workspace.select",
    "workspace.move",
    "workspace.close",
    "pane.split",
    "pane.focus",
    "pane.resize",
    "pane.close",
    "pane.moveTab",
    "tab.openTerminal",
    "tab.openBrowser",
    "tab.select",
    "tab.update",
    "tab.move",
    "tab.close",
    "browser.navigate",
    "browser.back",
    "browser.forward",
    "browser.reload",
    "browser.stop",
    "browser.openDevTools",
    "settings.get",
    "settings.update",
    "settings.resetKey",
    "notification.list",
    "notification.publish",
    "notification.markRead",
    "notification.markUnread",
    "notification.clear",
];

const ATTENTION_CAPABILITIES: &[&str] = &[
    "workspace.attention.get",
    "workspace.attention.events",
    "attention.acknowledge",
    "attention-v1",
];

const ORGANIZATION_CAPABILITIES: &[&str] = &[
    "workspace.organization.get",
    "workspace.selectMany",
    "workspace.pin",
    "workspace.closeSelected",
    "workspace.reorder",
    "group.create",
    "group.rename",
    "group.delete",
    "group.move",
    "group.assign",
    "group.collapse",
    "workspace-groups-v1",
];

const SAVED_LAYOUT_CAPABILITIES: &[&str] = &[
    "layout.list",
    "layout.get",
    "layout.save",
    "layout.delete",
    "layout.apply",
    "layout.export",
    "layout.import",
    "saved-layouts-v1",
];

pub(super) fn identify(has_runtime: bool, has_persistence: bool) -> IdentifyResult {
    let current = IdentifyResult::current();
    let capabilities = M1_IO_CAPABILITIES
        .iter()
        .chain(
            (!has_runtime)
                .then_some(legacy_lifecycle_capabilities())
                .into_iter()
                .flatten(),
        )
        .chain(has_runtime.then_some(M2_CAPABILITIES).into_iter().flatten())
        .chain(
            (has_runtime && has_persistence)
                .then_some(ATTENTION_CAPABILITIES)
                .into_iter()
                .flatten(),
        )
        .chain(
            (has_runtime && has_persistence)
                .then_some(ORGANIZATION_CAPABILITIES)
                .into_iter()
                .flatten(),
        )
        .chain(
            (has_runtime && has_persistence)
                .then_some(SAVED_LAYOUT_CAPABILITIES)
                .into_iter()
                .flatten(),
        )
        .chain(
            has_persistence
                .then_some(super::milestone5::CAPABILITIES)
                .into_iter()
                .flatten(),
        )
        .map(|value| (*value).to_owned())
        .collect();
    IdentifyResult {
        capabilities,
        ..current
    }
}

const fn legacy_lifecycle_capabilities() -> &'static [&'static str] {
    #[cfg(test)]
    {
        LEGACY_LIFECYCLE_CAPABILITIES
    }
    #[cfg(not(test))]
    {
        &[]
    }
}

#[allow(clippy::too_many_lines)]
#[cfg(test)]
pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
) -> ResponseEnvelope {
    dispatch_for_window(id, command, params, context, None).await
}

#[allow(clippy::too_many_lines)]
pub(super) async fn dispatch_for_window(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
    target_window: Option<WindowId>,
) -> ResponseEnvelope {
    let Some(runtime) = context.runtime.as_ref() else {
        return ResponseEnvelope::failure(
            id,
            "unknown_command",
            format!("Unknown command: {command}"),
        );
    };
    match command {
        "workspace.list" => {
            if let Err(response) = parse::<EmptyParams>(&id, params) {
                return *response;
            }
            let state = runtime.snapshot().await;
            revision_success(
                id,
                state.revision,
                WorkspaceListResult {
                    snapshot: application_snapshot(&state),
                },
            )
        }
        "workspace.snapshot" => {
            let params = try_params!(id, params, WorkspaceSnapshotParams);
            let state = runtime.snapshot().await;
            let workspace_id = workspace_id(&params.workspace_id);
            let Some(workspace) = state.workspaces.iter().find(|item| item.id == workspace_id)
            else {
                return domain_failure(id, &DomainError::WorkspaceNotFound { id: workspace_id });
            };
            revision_success(
                id,
                state.revision,
                WorkspaceSnapshotResult {
                    revision: state.revision,
                    workspace: workspace_snapshot(&state, workspace),
                },
            )
        }
        "workspace.create" => {
            let params = try_params!(id, params, WorkspaceCreateParams);
            let at = now();
            let workspace_id = WorkspaceId::new();
            let pane_id = PaneId::new();
            let tab_id = TabId::new();
            let launch = match launch_spec(&params.initial_terminal) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            let tab = match Tab::terminal(tab_id, pane_id, "Terminal", launch, None, at) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            let mut workspace = match Workspace::new(
                workspace_id,
                params.name,
                PathBuf::from(params.working_directory),
                pane_id,
                tab,
                at,
                at,
            ) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            workspace.description = params.description;
            workspace.color = params.color;
            let mut options = LaunchOptions::default();
            if let Some(command) = params.initial_terminal.command {
                options = options.with_command(tab_id, command);
            }
            mutate(id, runtime, options, move |state| match target_window {
                Some(window_id) => state.create_workspace_in_window(workspace, window_id),
                None => state.create_workspace(workspace),
            })
            .await
        }
        "workspace.update" => {
            let params = try_params!(id, params, WorkspaceUpdateParams);
            let workspace_id = workspace_id(&params.workspace_id);
            let update = WorkspaceUpdate {
                name: params.name,
                description: params.description.map(|value| value.value),
                color: params.color.map(|value| value.value),
                working_directory: params.working_directory.map(PathBuf::from),
            };
            let at = now();
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.update_workspace(workspace_id, update, at)
            })
            .await
        }
        "workspace.select" => {
            let params = try_params!(id, params, WorkspaceSelectParams);
            let workspace_id = workspace_id(&params.workspace_id);
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.select_workspace(workspace_id)
            })
            .await
        }
        "workspace.move" => {
            let params = try_params!(id, params, WorkspaceMoveParams);
            let workspace_id = workspace_id(&params.workspace_id);
            let destination = params.destination_index as usize;
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.move_workspace(workspace_id, destination)
            })
            .await
        }
        "workspace.close" => {
            let params = try_params!(id, params, WorkspaceCloseParams);
            let response = close_workspace(id, runtime, workspace_id(&params.workspace_id)).await;
            if response.ok {
                context.prune_ephemeral_workspace_state().await;
            }
            response
        }
        "pane.split" => {
            let params = try_params!(id, params, PaneSplitParams);
            split_pane(id, runtime, params).await
        }
        "pane.focus" => {
            let params = try_params!(id, params, PaneFocusParams);
            let workspace_id = workspace_id(&params.workspace_id);
            let pane_id = pane_id(&params.pane_id);
            let at = now();
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.focus_pane(workspace_id, pane_id, at)
            })
            .await
        }
        "pane.resize" => {
            let params = try_params!(id, params, PaneResizeParams);
            let workspace_id = workspace_id(&params.workspace_id);
            let split_id = split_id(&params.split_id);
            let at = now();
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.resize_pane_split(workspace_id, split_id, params.ratio, at)
            })
            .await
        }
        "pane.close" => {
            let params = try_params!(id, params, PaneCloseParams);
            close_pane(
                id,
                runtime,
                workspace_id(&params.workspace_id),
                pane_id(&params.pane_id),
            )
            .await
        }
        "pane.moveTab" => {
            let params = try_params!(id, params, PaneMoveTabParams);
            move_tab(
                id,
                runtime,
                workspace_id(&params.workspace_id),
                tab_id(&params.tab_id),
                pane_id(&params.destination_pane_id),
                params.destination_index,
            )
            .await
        }
        "tab.openTerminal" => {
            let params = try_params!(id, params, TabOpenTerminalParams);
            open_terminal(id, runtime, params).await
        }
        "tab.openBrowser" => {
            let params = try_params!(id, params, TabOpenBrowserParams);
            open_browser(id, runtime, params).await
        }
        "tab.select" => {
            let params = try_params!(id, params, TabSelectParams);
            let workspace_id = workspace_id(&params.workspace_id);
            let tab_id = tab_id(&params.tab_id);
            let at = now();
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.select_tab(workspace_id, tab_id, at)
            })
            .await
        }
        "tab.update" => {
            let params = try_params!(id, params, TabUpdateParams);
            let workspace_id = workspace_id(&params.workspace_id);
            let tab_id = tab_id(&params.tab_id);
            let at = now();
            let custom_title = params.custom_title.map(|value| value.value);
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.update_tab(workspace_id, tab_id, params.title, custom_title, at)
            })
            .await
        }
        "tab.move" => {
            let params = try_params!(id, params, TabMoveParams);
            move_tab(
                id,
                runtime,
                workspace_id(&params.workspace_id),
                tab_id(&params.tab_id),
                pane_id(&params.destination_pane_id),
                params.destination_index,
            )
            .await
        }
        "tab.close" => {
            let params = try_params!(id, params, TabCloseParams);
            close_tab(
                id,
                runtime,
                workspace_id(&params.workspace_id),
                tab_id(&params.tab_id),
            )
            .await
        }
        "terminal.restart" => {
            let params = try_params!(id, params, TerminalRestartParams);
            match runtime
                .restart_terminal(
                    workspace_id(&params.workspace_id),
                    tab_id(&params.tab_id),
                    None,
                    now(),
                )
                .await
            {
                Ok(commit) => commit_response(id, &commit),
                Err(error) => operation_failure(id, &error),
            }
        }
        "browser.navigate" => {
            let params = try_params!(id, params, BrowserNavigateParams);
            navigate_browser(id, runtime, params).await
        }
        "browser.back" => {
            let params = try_params!(id, params, BrowserBackParams);
            browser_action(
                id,
                runtime,
                params.browser_session_id,
                params.expected_state_revision,
                params.correlation_id,
                BrowserAction::Back,
            )
            .await
        }
        "browser.forward" => {
            let params = try_params!(id, params, BrowserForwardParams);
            browser_action(
                id,
                runtime,
                params.browser_session_id,
                params.expected_state_revision,
                params.correlation_id,
                BrowserAction::Forward,
            )
            .await
        }
        "browser.reload" => {
            let params = try_params!(id, params, BrowserReloadParams);
            browser_action(
                id,
                runtime,
                params.browser_session_id,
                params.expected_state_revision,
                params.correlation_id,
                BrowserAction::Reload,
            )
            .await
        }
        "browser.stop" => {
            let params = try_params!(id, params, BrowserStopParams);
            browser_action(
                id,
                runtime,
                params.browser_session_id,
                params.expected_state_revision,
                params.correlation_id,
                BrowserAction::Stop,
            )
            .await
        }
        "browser.openDevTools" => {
            let params = try_params!(id, params, BrowserOpenDevToolsParams);
            browser_action(
                id,
                runtime,
                params.browser_session_id,
                params.expected_state_revision,
                params.correlation_id,
                BrowserAction::OpenDevTools,
            )
            .await
        }
        // Authenticated desktop-main command. It is deliberately not advertised as a
        // public capability, but still uses the strict protocol parser above.
        "browser.observe" => {
            let params = try_params!(id, params, BrowserObserveParams);
            observe_browser(id, runtime, params).await
        }
        "notification.list" => {
            let params = try_params!(id, params, NotificationListParams);
            let state = runtime.snapshot().await;
            let owned_workspaces = match target_window {
                Some(window_id) => match state.window_placement(window_id) {
                    Some(placement) => Some(
                        placement
                            .workspace_ids
                            .iter()
                            .copied()
                            .collect::<BTreeSet<_>>(),
                    ),
                    None => {
                        return ResponseEnvelope::failure(
                            id,
                            "placement_required",
                            "This control connection's window placement no longer exists",
                        );
                    }
                },
                None => None,
            };
            let workspace_id = params.workspace_id.as_deref().map(workspace_id);
            let unread_only = params.resolved_unread_only();
            let matching = state
                .notifications
                .iter()
                .filter(|notification| {
                    owned_workspaces
                        .as_ref()
                        .is_none_or(|owned| owned.contains(&notification.workspace_id))
                        && workspace_id.is_none_or(|id| notification.workspace_id == id)
                        && (!unread_only || notification.is_unread())
                })
                .collect::<Vec<_>>();
            let total = matching.len() as u64;
            let unread_count = matching
                .iter()
                .filter(|notification| notification.is_unread())
                .count() as u64;
            let mut notifications = matching;
            notifications.sort_unstable_by_key(|notification| {
                std::cmp::Reverse((notification.created_at, notification.id))
            });
            let offset = usize::try_from(params.resolved_offset()).unwrap_or(usize::MAX);
            let notifications = notifications
                .into_iter()
                .skip(offset)
                .take(usize::from(params.resolved_limit()))
                .map(notification_snapshot)
                .collect();
            revision_success(
                id,
                state.revision,
                NotificationListResult {
                    revision: state.revision,
                    notifications,
                    total,
                    unread_count,
                },
            )
        }
        "notification.publish" => {
            let params = try_params!(id, params, NotificationPublishParams);
            publish_notification(id, runtime, params).await
        }
        "notification.markRead" => {
            let params = try_params!(id, params, NotificationMarkReadParams);
            let notification_id = notification_id(&params.notification_id);
            let at = now();
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.mark_notification_read(notification_id, at)
            })
            .await
        }
        "notification.markUnread" => {
            let params = try_params!(id, params, NotificationMarkUnreadParams);
            let notification_id = notification_id(&params.notification_id);
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.mark_notification_unread(notification_id)
            })
            .await
        }
        "notification.clear" => {
            let params = try_params!(id, params, NotificationClearParams);
            clear_notifications(id, runtime, params.scope).await
        }
        "settings.get" => {
            if let Err(response) = parse::<EmptyParams>(&id, params) {
                return *response;
            }
            let state = runtime.snapshot().await;
            revision_success(id, state.revision, settings(&state))
        }
        "settings.update" => {
            let params = try_params!(id, params, SettingsUpdateParams);
            update_settings(id, runtime, context.platform, params).await
        }
        "settings.resetKey" => {
            let params = try_params!(id, params, SettingsResetKeyParams);
            let command_id = match CommandId::new(params.command_id) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            let platform = context.platform;
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.reset_shortcut_override(&command_id, platform)
            })
            .await
        }
        _ => {
            ResponseEnvelope::failure(id, "unknown_command", format!("Unknown command: {command}"))
        }
    }
}

macro_rules! try_params {
    ($id:ident, $params:ident, $type:ty) => {
        match parse::<$type>(&$id, $params) {
            Ok(value) => value,
            Err(response) => return *response,
        }
    };
}
use try_params;

fn parse<T: DeserializeOwned>(
    id: &str,
    params: serde_json::Value,
) -> Result<T, Box<ResponseEnvelope>> {
    serde_json::from_value(params).map_err(|_| {
        Box::new(ResponseEnvelope::failure(
            id,
            "invalid_params",
            "The request parameters do not match the command contract",
        ))
    })
}

async fn mutate<F>(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    options: LaunchOptions,
    mutation: F,
) -> ResponseEnvelope
where
    F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
{
    match runtime.mutate(options, mutation).await {
        Ok(commit) => commit_response(id, &commit),
        Err(error) => operation_failure(id, &error),
    }
}

fn commit_response(id: String, commit: &CommitResult) -> ResponseEnvelope {
    if !commit.termination_failures.is_empty() {
        warn!(
            count = commit.termination_failures.len(),
            revision = commit.snapshot.revision,
            "committed workspace mutation left terminal termination failures"
        );
    }
    let revision = commit.snapshot.revision;
    revision_success(
        id,
        revision,
        MutationResult {
            revision,
            snapshot: application_snapshot(&commit.snapshot),
        },
    )
}

fn revision_success(id: String, revision: u64, value: impl Serialize) -> ResponseEnvelope {
    ResponseEnvelope::success_at_revision(
        id,
        revision,
        serde_json::to_value(value).expect("protocol projection serialization is infallible"),
    )
}

async fn split_pane(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    params: PaneSplitParams,
) -> ResponseEnvelope {
    let workspace_id = workspace_id(&params.workspace_id);
    let target_pane_id = pane_id(&params.target_pane_id);
    let new_pane_id = PaneId::new();
    let new_split_id = SplitId::new();
    let at = now();
    let axis = axis(params.axis);
    let placement = placement(params.placement);
    let mut options = LaunchOptions::default();
    let content = match params.content {
        PaneSplitContent::ExistingTab { tab_id: value } => {
            SplitContent::ExistingTab(tab_id(&value))
        }
        PaneSplitContent::NewTerminal { launch } => {
            let tab_id = TabId::new();
            let spec = match launch_spec(&launch) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            let tab = match Tab::terminal(tab_id, new_pane_id, "Terminal", spec, None, at) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            if let Some(command) = launch.command {
                options = options.with_command(tab_id, command);
            }
            SplitContent::NewTerminal(tab)
        }
        PaneSplitContent::NewBrowser {
            url,
            profile_partition,
        } => {
            let tab_id = TabId::new();
            let metadata = match profile_partition {
                Some(partition) => BrowserMetadata::new_with_partition(url, partition),
                None => BrowserMetadata::new(url),
            };
            let metadata = match metadata {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            let tab = match Tab::browser(tab_id, new_pane_id, "Browser", metadata, at) {
                Ok(value) => value,
                Err(error) => return domain_failure(id, &error),
            };
            SplitContent::NewBrowser(tab)
        }
    };
    mutate(id, runtime, options, move |state| {
        state.split_pane(
            workspace_id,
            target_pane_id,
            new_pane_id,
            new_split_id,
            axis,
            params.ratio,
            placement,
            content,
            at,
        )
    })
    .await
}

async fn open_terminal(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    params: TabOpenTerminalParams,
) -> ResponseEnvelope {
    let workspace_id = workspace_id(&params.workspace_id);
    let pane_id = pane_id(&params.pane_id);
    let state = runtime.snapshot().await;
    let Some(workspace) = state
        .workspaces
        .iter()
        .find(|value| value.id == workspace_id)
    else {
        return domain_failure(id, &DomainError::WorkspaceNotFound { id: workspace_id });
    };
    let Some(pane) = workspace.panes.get(&pane_id) else {
        return domain_failure(id, &DomainError::PaneNotFound { id: pane_id });
    };
    let index = params
        .destination_index
        .map_or(pane.tabs.len(), |value| value as usize);
    let tab_id = TabId::new();
    let at = now();
    let spec = match launch_spec(&params.launch) {
        Ok(value) => value,
        Err(error) => return domain_failure(id, &error),
    };
    let tab = match Tab::terminal(tab_id, pane_id, "Terminal", spec, None, at) {
        Ok(value) => value,
        Err(error) => return domain_failure(id, &error),
    };
    let mut options = LaunchOptions::default();
    if let Some(command) = params.launch.command {
        options = options.with_command(tab_id, command);
    }
    mutate(id, runtime, options, move |state| {
        state.open_terminal_tab(workspace_id, pane_id, index, tab, at)
    })
    .await
}

async fn open_browser(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    params: TabOpenBrowserParams,
) -> ResponseEnvelope {
    let workspace_id = workspace_id(&params.workspace_id);
    let pane_id = pane_id(&params.pane_id);
    let state = runtime.snapshot().await;
    let Some(workspace) = state
        .workspaces
        .iter()
        .find(|value| value.id == workspace_id)
    else {
        return domain_failure(id, &DomainError::WorkspaceNotFound { id: workspace_id });
    };
    let Some(pane) = workspace.panes.get(&pane_id) else {
        return domain_failure(id, &DomainError::PaneNotFound { id: pane_id });
    };
    let index = params
        .destination_index
        .map_or(pane.tabs.len(), |value| value as usize);
    let metadata = match params.profile_partition {
        Some(partition) => BrowserMetadata::new_with_partition(params.metadata.url, partition),
        None => BrowserMetadata::new(params.metadata.url),
    };
    let metadata = match metadata {
        Ok(value) => value,
        Err(error) => return domain_failure(id, &error),
    };
    let tab = match Tab::browser(TabId::new(), pane_id, "Browser", metadata, now()) {
        Ok(value) => value,
        Err(error) => return domain_failure(id, &error),
    };
    let at = tab.created_at;
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.open_browser_tab(workspace_id, pane_id, index, tab, at)
    })
    .await
}

fn find_browser_session(
    state: &ApplicationState,
    browser_session_id: Uuid,
) -> Option<(WorkspaceId, TabId)> {
    let mut matches = state.workspaces.iter().flat_map(|workspace| {
        workspace
            .tabs
            .values()
            .filter_map(move |tab| match &tab.content {
                TabContent::Browser { metadata }
                    if metadata.browser_session_id() == browser_session_id =>
                {
                    Some((workspace.id, tab.id))
                }
                _ => None,
            })
    });
    let found = matches.next()?;
    matches.next().is_none().then_some(found)
}

async fn navigate_browser(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    params: BrowserNavigateParams,
) -> ResponseEnvelope {
    let browser_session_id = Uuid::parse_str(&params.browser_session_id)
        .expect("protocol validates browser session UUIDs");
    let state = runtime.snapshot().await;
    let Some((workspace_id, tab_id)) = find_browser_session(&state, browser_session_id) else {
        return ResponseEnvelope::failure(
            id,
            "invalid_operation",
            "Browser session was not found uniquely",
        );
    };
    let at = now();
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.navigate_browser(
            workspace_id,
            tab_id,
            browser_session_id,
            params.expected_state_revision,
            &params.url,
            &params.correlation_id,
            at,
        )
    })
    .await
}

async fn browser_action(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    browser_session_id: String,
    expected_state_revision: u64,
    correlation_id: String,
    action: BrowserAction,
) -> ResponseEnvelope {
    let browser_session_id =
        Uuid::parse_str(&browser_session_id).expect("protocol validates browser session UUIDs");
    let state = runtime.snapshot().await;
    let Some((workspace_id, tab_id)) = find_browser_session(&state, browser_session_id) else {
        return ResponseEnvelope::failure(
            id,
            "invalid_operation",
            "Browser session was not found uniquely",
        );
    };
    let at = now();
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.request_browser_action(
            workspace_id,
            tab_id,
            browser_session_id,
            action,
            expected_state_revision,
            &correlation_id,
            at,
        )
    })
    .await
}

async fn observe_browser(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    params: BrowserObserveParams,
) -> ResponseEnvelope {
    let workspace_id = workspace_id(&params.workspace_id);
    let tab_id = tab_id(&params.tab_id);
    let browser_session_id = Uuid::parse_str(&params.state.browser_session_id)
        .expect("protocol validates browser session UUIDs");
    let snapshot = runtime.snapshot().await;
    let metadata = snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .and_then(|workspace| workspace.tabs.get(&tab_id))
        .and_then(|tab| match &tab.content {
            TabContent::Browser { metadata } => Some(metadata),
            TabContent::Terminal { .. } => None,
        });
    if metadata.is_none_or(|metadata| {
        metadata.browser_session_id() != browser_session_id
            || metadata.profile_partition() != params.state.profile_partition
    }) {
        return ResponseEnvelope::failure(
            id,
            "invalid_operation",
            "Browser observation does not match the tab session",
        );
    }
    let observed = params.state;
    let at = now();
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.update_browser_observation(
            workspace_id,
            tab_id,
            browser_session_id,
            observed.state_revision,
            &observed.url,
            &observed.navigation_title,
            observed.can_back,
            observed.can_forward,
            observed.loading,
            observed.dev_tools_open,
            observed.correlation_id.as_deref(),
            at,
        )
    })
    .await
}

async fn close_workspace(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    workspace_id: WorkspaceId,
) -> ResponseEnvelope {
    let state = runtime.snapshot().await;
    let Some(closing) = state
        .workspaces
        .iter()
        .find(|value| value.id == workspace_id)
    else {
        return domain_failure(id, &DomainError::WorkspaceNotFound { id: workspace_id });
    };
    let at = now();
    let replacement = if state.workspaces.len() == 1 {
        let (rows, cols) = terminal_dimensions(closing);
        match replacement_workspace(closing.working_directory.clone(), rows, cols, at) {
            Ok(value) => Some(value),
            Err(error) => return domain_failure(id, &error),
        }
    } else {
        None
    };
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.close_workspace(workspace_id, replacement)
    })
    .await
}

async fn close_pane(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    workspace_id: WorkspaceId,
    pane_id: PaneId,
) -> ResponseEnvelope {
    let state = runtime.snapshot().await;
    let Some(workspace) = state
        .workspaces
        .iter()
        .find(|value| value.id == workspace_id)
    else {
        return domain_failure(id, &DomainError::WorkspaceNotFound { id: workspace_id });
    };
    if !workspace.panes.contains_key(&pane_id) {
        return domain_failure(id, &DomainError::PaneNotFound { id: pane_id });
    }
    let at = now();
    let replacement = if workspace.panes.len() == 1 {
        let (rows, cols) = terminal_dimensions(workspace);
        match terminal_tab(
            TabId::new(),
            pane_id,
            workspace.working_directory.clone(),
            rows,
            cols,
            at,
        ) {
            Ok(value) => Some(value),
            Err(error) => return domain_failure(id, &error),
        }
    } else {
        None
    };
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.close_pane(workspace_id, pane_id, replacement, at)
    })
    .await
}

async fn close_tab(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    workspace_id: WorkspaceId,
    tab_id: TabId,
) -> ResponseEnvelope {
    let state = runtime.snapshot().await;
    let Some(workspace) = state
        .workspaces
        .iter()
        .find(|value| value.id == workspace_id)
    else {
        return domain_failure(id, &DomainError::WorkspaceNotFound { id: workspace_id });
    };
    let Some(tab) = workspace.tabs.get(&tab_id) else {
        return domain_failure(id, &DomainError::TabNotFound { id: tab_id });
    };
    let at = now();
    let replacement = if workspace.tabs.len() == 1 {
        let (rows, cols) = terminal_dimensions(workspace);
        match terminal_tab(
            TabId::new(),
            tab.pane_id,
            workspace.working_directory.clone(),
            rows,
            cols,
            at,
        ) {
            Ok(value) => Some(value),
            Err(error) => return domain_failure(id, &error),
        }
    } else {
        None
    };
    let Ok(record) = super::multi_window::closed_record_for_tab(workspace, tab, at) else {
        return ResponseEnvelope::failure(
            id,
            "policy_denied",
            "The tab restore metadata could not be recorded safely",
        );
    };
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.close_tab_with_record(workspace_id, tab_id, replacement, record, at, at)
    })
    .await
}

async fn move_tab(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    workspace_id: WorkspaceId,
    tab_id: TabId,
    pane_id: PaneId,
    destination_index: u32,
) -> ResponseEnvelope {
    let at = now();
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.move_tab(
            workspace_id,
            tab_id,
            pane_id,
            destination_index as usize,
            at,
        )
    })
    .await
}

pub(super) async fn publish_notification(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    params: NotificationPublishParams,
) -> ResponseEnvelope {
    let notification = match Notification::new(
        NotificationId::new(),
        workspace_id(&params.target.workspace_id),
        params.target.pane_id.as_deref().map(pane_id),
        params.target.tab_id.as_deref().map(tab_id),
        notification_source(params.source),
        notification_level(params.level),
        params.title,
        params.body,
        now(),
    ) {
        Ok(notification) => notification,
        Err(error) => return domain_failure(id, &error),
    };
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        state.publish_notification(notification)
    })
    .await
}

async fn clear_notifications(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    scope: NotificationClearScope,
) -> ResponseEnvelope {
    match scope {
        NotificationClearScope::Notification {
            notification_id: value,
        } => {
            let notification_id = notification_id(&value);
            mutate(id, runtime, LaunchOptions::default(), move |state| {
                state.clear_notification(notification_id)
            })
            .await
        }
        NotificationClearScope::Read => {
            mutate(id, runtime, LaunchOptions::default(), |state| {
                state.clear_read_notifications()
            })
            .await
        }
        NotificationClearScope::All => {
            mutate(id, runtime, LaunchOptions::default(), |state| {
                state.clear_all_notifications()
            })
            .await
        }
    }
}

async fn update_settings(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    platform: ShortcutPlatform,
    params: SettingsUpdateParams,
) -> ResponseEnvelope {
    let mut seen = HashSet::new();
    let shortcut_overrides = params.shortcut_overrides.unwrap_or_default();
    let mut updates = Vec::with_capacity(shortcut_overrides.len());
    for update in shortcut_overrides {
        if !seen.insert(update.command_id.clone()) {
            return ResponseEnvelope::failure(
                id,
                "invalid_params",
                "A shortcut command may appear only once",
            );
        }
        let command = match CommandId::new(update.command_id) {
            Ok(value) => value,
            Err(error) => return domain_failure(id, &error),
        };
        let shortcut = match update.shortcut.map(LogicalShortcut::new).transpose() {
            Ok(value) => value,
            Err(error) => return domain_failure(id, &error),
        };
        updates.push((command, shortcut));
    }
    let notification_settings = params
        .notifications
        .map(|settings| CoreNotificationSettings {
            system_enabled: settings.system_enabled,
            include_body: settings.include_body,
        });
    mutate(id, runtime, LaunchOptions::default(), move |state| {
        let before = state.shortcut_overrides.clone();
        let before_notifications = state.notification_settings;
        for (command, shortcut) in updates {
            state.shortcut_overrides.insert(command, shortcut);
        }
        if let Some(settings) = notification_settings {
            state.notification_settings = settings;
        }
        if state.shortcut_overrides == before && state.notification_settings == before_notifications
        {
            return Err(DomainError::InvalidOperation {
                message: "settings are unchanged",
            });
        }
        state.validate_shortcut_overrides_for(platform)?;
        state.revision = state
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or(DomainError::RevisionOverflow)?;
        Ok(MutationOutcome {
            revision: state.revision,
            terminal_launches: Vec::new(),
            terminal_sessions_to_terminate: Vec::new(),
        })
    })
    .await
}

fn replacement_workspace(
    cwd: PathBuf,
    rows: u16,
    cols: u16,
    at: Timestamp,
) -> Result<Workspace, DomainError> {
    let workspace_id = WorkspaceId::new();
    let pane_id = PaneId::new();
    let tab = terminal_tab(TabId::new(), pane_id, cwd.clone(), rows, cols, at)?;
    Workspace::new(workspace_id, "Workspace 1", cwd, pane_id, tab, at, at)
}

fn terminal_tab(
    tab_id: TabId,
    pane_id: PaneId,
    cwd: PathBuf,
    rows: u16,
    cols: u16,
    at: Timestamp,
) -> Result<Tab, DomainError> {
    Tab::terminal(
        tab_id,
        pane_id,
        "Terminal",
        TerminalLaunchSpec::new(cwd, None, rows, cols)?,
        None,
        at,
    )
}

fn terminal_dimensions(workspace: &Workspace) -> (u16, u16) {
    workspace
        .tabs
        .values()
        .find_map(|tab| match &tab.content {
            TabContent::Terminal { launch, .. } => Some((launch.rows, launch.cols)),
            TabContent::Browser { .. } => None,
        })
        .unwrap_or((24, 80))
}

fn launch_spec(
    value: &agent_workspace_protocol::TerminalLaunchRequest,
) -> Result<TerminalLaunchSpec, DomainError> {
    TerminalLaunchSpec::new(PathBuf::from(&value.cwd), None, value.rows, value.cols)
}

pub(super) fn application_snapshot(state: &ApplicationState) -> ApplicationSnapshot {
    let attention = state.attention_state();
    ApplicationSnapshot {
        revision: state.revision,
        workspaces: state
            .workspaces
            .iter()
            .map(|workspace| workspace_snapshot_with_attention(workspace, &attention))
            .collect(),
        selected_workspace_id: state.selected_workspace_id.to_string(),
        shortcut_overrides: DEFAULT_SHORTCUT_CATALOG
            .iter()
            .filter_map(|binding| {
                state
                    .shortcut_overrides
                    .iter()
                    .find(|(command, _)| command.as_str() == binding.command_id)
            })
            .map(
                |(command_id, shortcut)| agent_workspace_protocol::ShortcutOverride {
                    command_id: command_id.as_str().to_owned(),
                    shortcut: shortcut.as_ref().map(|value| value.as_str().to_owned()),
                },
            )
            .collect(),
        attention: attention_summary(attention.application),
    }
}

fn workspace_snapshot(state: &ApplicationState, workspace: &Workspace) -> WorkspaceSnapshot {
    workspace_snapshot_with_attention(workspace, &state.attention_state())
}

fn workspace_snapshot_with_attention(
    workspace: &Workspace,
    attention: &agent_workspace_core::AttentionState,
) -> WorkspaceSnapshot {
    let mut pane_order = Vec::new();
    collect_leaves(&workspace.layout, &mut pane_order);
    let panes = pane_order
        .iter()
        .map(|pane_id| {
            let pane = &workspace.panes[pane_id];
            PaneSnapshot {
                id: pane.id.to_string(),
                tab_ids: pane.tabs.iter().map(ToString::to_string).collect(),
                selected_tab_id: pane.selected_tab_id.to_string(),
                title: pane.title.clone(),
                attention: attention_summary(
                    attention.panes.get(&pane.id).cloned().unwrap_or_default(),
                ),
            }
        })
        .collect();
    let tabs = pane_order
        .iter()
        .flat_map(|pane_id| workspace.panes[pane_id].tabs.iter())
        .map(|tab_id| {
            let tab = &workspace.tabs[tab_id];
            tab_snapshot(
                tab,
                attention.tabs.get(&tab.id).cloned().unwrap_or_default(),
            )
        })
        .collect();
    WorkspaceSnapshot {
        id: workspace.id.to_string(),
        name: workspace.name.clone(),
        description: workspace.description.clone(),
        color: workspace.color.clone(),
        working_directory: workspace.working_directory.to_string_lossy().into_owned(),
        layout: pane_tree(&workspace.layout),
        selected_pane_id: workspace.selected_pane_id.to_string(),
        panes,
        tabs,
        attention: attention_summary(
            attention
                .workspaces
                .get(&workspace.id)
                .cloned()
                .unwrap_or_default(),
        ),
        created_at: workspace.created_at.0,
        updated_at: workspace.updated_at.0,
    }
}

fn pane_tree(value: &PaneNode) -> PaneTreeNode {
    match value {
        PaneNode::Leaf { pane_id } => PaneTreeNode::Leaf {
            pane_id: pane_id.to_string(),
        },
        PaneNode::Split {
            split_id,
            axis,
            ratio,
            first,
            second,
        } => PaneTreeNode::Split {
            split_id: split_id.to_string(),
            axis: match axis {
                Axis::Horizontal => SplitAxis::Horizontal,
                Axis::Vertical => SplitAxis::Vertical,
            },
            ratio: *ratio,
            first: Box::new(pane_tree(first)),
            second: Box::new(pane_tree(second)),
        },
    }
}

fn tab_snapshot(tab: &Tab, attention: CoreAttentionSummary) -> TabSnapshot {
    let content = match &tab.content {
        TabContent::Terminal {
            launch,
            runtime_session_id,
        } => TabContentSnapshot::Terminal {
            launch: TerminalLaunchMetadata {
                cwd: launch.cwd.to_string_lossy().into_owned(),
                rows: launch.rows,
                cols: launch.cols,
            },
            runtime_session_id: runtime_session_id.as_ref().map(ToString::to_string),
        },
        TabContent::Browser { metadata } => TabContentSnapshot::Browser {
            state: browser_session_state(metadata),
        },
    };
    TabSnapshot {
        id: tab.id.to_string(),
        pane_id: tab.pane_id.to_string(),
        title: tab.title.clone(),
        custom_title: tab.custom_title.clone(),
        content,
        attention: attention_summary(attention),
        created_at: tab.created_at.0,
    }
}

fn browser_session_state(metadata: &BrowserMetadata) -> BrowserSessionState {
    BrowserSessionState {
        browser_session_id: metadata.browser_session_id().to_string(),
        url: metadata.url().to_owned(),
        navigation_title: metadata.navigation_title().to_owned(),
        can_back: metadata.can_back(),
        can_forward: metadata.can_forward(),
        loading: metadata.loading(),
        dev_tools_open: metadata.dev_tools_open(),
        profile_partition: metadata.profile_partition().to_owned(),
        state_revision: metadata.state_revision(),
        correlation_id: metadata.correlation_id().map(str::to_owned),
    }
}

fn attention_summary(value: CoreAttentionSummary) -> AttentionSummary {
    AttentionSummary {
        unread_count: value.unread_count,
        highest_level: value.highest_level.map(core_notification_level),
        latest_unread: value.latest_unread.map(|latest| AttentionExcerpt {
            notification_id: latest.notification_id.to_string(),
            title: latest.title,
            body_excerpt: latest.body_excerpt,
            source: core_notification_source(latest.source),
            created_at: latest.created_at.0,
        }),
    }
}

fn settings(state: &ApplicationState) -> SettingsGetResult {
    let shortcuts = DEFAULT_SHORTCUT_CATALOG
        .iter()
        .map(|binding| {
            let override_value = state
                .shortcut_overrides
                .iter()
                .find(|(command, _)| command.as_str() == binding.command_id)
                .map(|(_, value)| value);
            let (override_state, effective_shortcut) = match override_value {
                None => (
                    ShortcutOverrideState::Default,
                    Some(binding.shortcut.to_owned()),
                ),
                Some(Some(value)) => (
                    ShortcutOverrideState::Set {
                        shortcut: value.as_str().to_owned(),
                    },
                    Some(value.as_str().to_owned()),
                ),
                Some(None) => (ShortcutOverrideState::Cleared, None),
            };
            ShortcutSetting {
                command_id: binding.command_id.to_owned(),
                default_shortcut: binding.shortcut.to_owned(),
                override_state,
                effective_shortcut,
            }
        })
        .collect();
    SettingsGetResult {
        revision: state.revision,
        shortcuts,
        notifications: NotificationSettings {
            system_enabled: state.notification_settings.system_enabled,
            include_body: state.notification_settings.include_body,
        },
    }
}

pub(super) fn operation_failure(id: String, failure: &OperationFailure) -> ResponseEnvelope {
    match &failure.error {
        RuntimeError::Domain(error) => domain_failure(id, error),
        RuntimeError::Store(_) => ResponseEnvelope::failure(
            id,
            "storage_failure",
            "The authoritative state could not be stored",
        ),
        RuntimeError::Terminal(_) => ResponseEnvelope::failure(
            id,
            "terminal_lifecycle_failed",
            "The terminal lifecycle operation failed",
        ),
        RuntimeError::UnexpectedCommand { .. } => ResponseEnvelope::failure(
            id,
            "invalid_terminal_command",
            "The terminal command did not target a newly created terminal",
        ),
        RuntimeError::InvalidMutationContract => ResponseEnvelope::failure(
            id,
            "runtime_contract_failure",
            "The workspace runtime rejected an inconsistent mutation",
        ),
        RuntimeError::StaleStateRevision { .. } => ResponseEnvelope::failure(
            id,
            "stale_revision",
            "The authoritative application revision is stale",
        ),
        RuntimeError::StaleWindowRevision { .. } => ResponseEnvelope::failure(
            id,
            "stale_window_revision",
            "The authoritative window revision is stale",
        ),
        RuntimeError::Worker => ResponseEnvelope::failure(
            id,
            "runtime_worker_failed",
            "The workspace runtime worker stopped unexpectedly",
        ),
        RuntimeError::TabNotTerminal { .. } => ResponseEnvelope::failure(
            id,
            "tab_not_terminal",
            "The requested tab does not contain a terminal",
        ),
        RuntimeError::TabNotFound { .. } => ResponseEnvelope::failure(
            id,
            "tab_not_found",
            "The requested tab does not exist in the workspace",
        ),
        RuntimeError::ShuttingDown => ResponseEnvelope::failure(
            id,
            "service_shutting_down",
            "The workspace runtime is shutting down",
        ),
    }
}

pub(super) fn domain_failure(id: String, error: &DomainError) -> ResponseEnvelope {
    let code = match error {
        DomainError::WorkspaceNotFound { .. } => "workspace_not_found",
        DomainError::PaneNotFound { .. } => "pane_not_found",
        DomainError::SplitNotFound { .. } => "split_not_found",
        DomainError::TabNotFound { .. } => "tab_not_found",
        DomainError::NotificationNotFound { .. } => "notification_not_found",
        DomainError::IndexOutOfBounds { .. } => "index_out_of_bounds",
        DomainError::ShortcutConflict { .. } => "shortcut_conflict",
        DomainError::TabNotTerminal { .. } => "tab_not_terminal",
        DomainError::InvalidOperation { .. }
        | DomainError::SplitWouldEmptyTarget
        | DomainError::ReplacementRequired { .. }
        | DomainError::UnexpectedReplacement { .. } => "invalid_operation",
        DomainError::RevisionOverflow | DomainError::RevisionOutOfRange { .. } => {
            "revision_out_of_range"
        }
        _ => "invalid_params",
    };
    ResponseEnvelope::failure(id, code, error.to_string())
}

fn now() -> Timestamp {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    Timestamp(
        u64::try_from(milliseconds)
            .unwrap_or(MAX_SAFE_INTEGER)
            .min(MAX_SAFE_INTEGER),
    )
}

fn workspace_id(value: &str) -> WorkspaceId {
    WorkspaceId::from_uuid(Uuid::parse_str(value).expect("protocol validates workspace UUIDs"))
}

fn pane_id(value: &str) -> PaneId {
    PaneId::from_uuid(Uuid::parse_str(value).expect("protocol validates pane UUIDs"))
}

fn split_id(value: &str) -> SplitId {
    SplitId::from_uuid(Uuid::parse_str(value).expect("protocol validates split UUIDs"))
}

fn tab_id(value: &str) -> TabId {
    TabId::from_uuid(Uuid::parse_str(value).expect("protocol validates tab UUIDs"))
}

fn notification_id(value: &str) -> NotificationId {
    NotificationId::from_uuid(
        Uuid::parse_str(value).expect("protocol validates notification UUIDs"),
    )
}

fn notification_source(value: NotificationSource) -> CoreNotificationSource {
    match value {
        NotificationSource::Cli => CoreNotificationSource::Cli,
        NotificationSource::Osc => CoreNotificationSource::Osc,
        NotificationSource::AgentHook => CoreNotificationSource::AgentHook,
        NotificationSource::Internal => CoreNotificationSource::Internal,
    }
}

fn core_notification_source(value: CoreNotificationSource) -> NotificationSource {
    match value {
        CoreNotificationSource::Cli => NotificationSource::Cli,
        CoreNotificationSource::Osc => NotificationSource::Osc,
        CoreNotificationSource::AgentHook => NotificationSource::AgentHook,
        CoreNotificationSource::Internal => NotificationSource::Internal,
    }
}

fn notification_level(value: NotificationLevel) -> CoreNotificationLevel {
    match value {
        NotificationLevel::Info => CoreNotificationLevel::Info,
        NotificationLevel::Warning => CoreNotificationLevel::Warning,
        NotificationLevel::Error => CoreNotificationLevel::Error,
    }
}

fn core_notification_level(value: CoreNotificationLevel) -> NotificationLevel {
    match value {
        CoreNotificationLevel::Info => NotificationLevel::Info,
        CoreNotificationLevel::Warning => NotificationLevel::Warning,
        CoreNotificationLevel::Error => NotificationLevel::Error,
    }
}

fn notification_snapshot(value: &Notification) -> NotificationSnapshot {
    NotificationSnapshot {
        id: value.id.to_string(),
        workspace_id: value.workspace_id.to_string(),
        pane_id: value.pane_id.map(|id| id.to_string()),
        tab_id: value.tab_id.map(|id| id.to_string()),
        source: core_notification_source(value.source),
        level: core_notification_level(value.level),
        title: value.title.clone(),
        body: value.body.clone(),
        created_at: value.created_at.0,
        read_at: value.read_at.map(|timestamp| timestamp.0),
    }
}

fn axis(value: SplitAxis) -> Axis {
    match value {
        SplitAxis::Horizontal => Axis::Horizontal,
        SplitAxis::Vertical => Axis::Vertical,
    }
}

fn placement(value: SplitPlacement) -> CoreSplitPlacement {
    match value {
        SplitPlacement::Before => CoreSplitPlacement::Before,
        SplitPlacement::After => CoreSplitPlacement::After,
    }
}

fn collect_leaves(node: &PaneNode, panes: &mut Vec<PaneId>) {
    match node {
        PaneNode::Leaf { pane_id } => panes.push(*pane_id),
        PaneNode::Split { first, second, .. } => {
            collect_leaves(first, panes);
            collect_leaves(second, panes);
        }
    }
}

pub(super) async fn forward_domain_events(
    runtime: Arc<ProductionWorkspaceRuntime>,
    sender: mpsc::Sender<Vec<u8>>,
    scope: Option<(
        Arc<Mutex<Option<super::multi_window::BoundWindow>>>,
        super::multi_window::MultiWindowRuntime,
    )>,
) {
    let mut receiver = runtime.subscribe();
    let mut previous = runtime.snapshot().await;
    let idempotency_epoch = runtime.current_idempotency_epoch().await.ok();
    loop {
        let event = match receiver.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let snapshot = runtime.snapshot().await;
                DomainEvent {
                    revision: snapshot.revision,
                    snapshot,
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        if event.revision <= previous.revision {
            continue;
        }
        let envelopes = if let Some((bound_window, multi_window)) = &scope {
            let Some(binding) = *bound_window.lock().await else {
                previous = event.snapshot;
                continue;
            };
            if multi_window
                .validate_binding(&event.snapshot, binding)
                .await
                .is_err()
            {
                previous = event.snapshot;
                continue;
            }
            let Some(projected_before) =
                super::multi_window::project_state_to_window(&previous, binding.window_id)
            else {
                previous = event.snapshot;
                continue;
            };
            let Some(projected_after) =
                super::multi_window::project_state_to_window(&event.snapshot, binding.window_id)
            else {
                previous = event.snapshot;
                continue;
            };
            let mut envelopes = Vec::new();
            if let Some(epoch) = idempotency_epoch {
                envelopes.extend(
                    super::multi_window::topology_event_envelopes(
                        &previous,
                        &event.snapshot,
                        epoch,
                    )
                    .into_iter()
                    .filter(|envelope| {
                        super::multi_window::ownership_event_targets_window(
                            envelope,
                            binding.window_id,
                        )
                    }),
                );
                envelopes.extend(
                    super::multi_window::topology_event_envelopes(
                        &projected_before,
                        &projected_after,
                        epoch,
                    )
                    .into_iter()
                    .filter(|envelope| envelope.event != "tab.ownershipTransferred"),
                );
            }
            envelopes.extend(domain_event_envelopes(
                &projected_before,
                &DomainEvent {
                    revision: event.revision,
                    snapshot: projected_after,
                },
            ));
            envelopes
        } else {
            let mut envelopes = idempotency_epoch.map_or_else(Vec::new, |epoch| {
                super::multi_window::topology_event_envelopes(&previous, &event.snapshot, epoch)
            });
            envelopes.extend(domain_event_envelopes(&previous, &event));
            envelopes
        };
        previous = event.snapshot;
        for envelope in envelopes {
            let Ok(frame) = serialize_frame(&envelope) else {
                continue;
            };
            if sender.send(frame).await.is_err() {
                return;
            }
        }
    }
}

#[allow(clippy::too_many_lines)]
fn domain_event_envelopes(before: &ApplicationState, event: &DomainEvent) -> Vec<EventEnvelope> {
    let after = &event.snapshot;
    let mut envelopes = Vec::new();
    if before.workspace_selection != after.workspace_selection
        || before.workspace_pins != after.workspace_pins
        || before.workspace_groups != after.workspace_groups
        || before.workspace_group_assignments != after.workspace_group_assignments
    {
        envelopes.push(revision_event_envelope(
            "workspace.organizationChanged",
            event.revision,
            WorkspaceOrganizationChangedEvent {
                revision: event.revision,
                reason: WorkspaceOrganizationChangeReason::OrganizationChanged,
            },
        ));
    }
    if before.saved_layouts != after.saved_layouts {
        envelopes.push(revision_event_envelope(
            "layout.changed",
            event.revision,
            SavedLayoutsChangedEvent {
                revision: event.revision,
                reason: SavedLayoutsChangeReason::LayoutsChanged,
            },
        ));
    }
    let workspace_ids = changed_workspace_ids(before, after);
    if !workspace_ids.is_empty() {
        envelopes.push(revision_event_envelope(
            "workspace.changed",
            event.revision,
            WorkspaceChangedEvent(revision_event_data(
                event.revision,
                workspace_ids,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                "workspace_snapshot_invalidated",
            )),
        ));
    }
    if before.selected_workspace_id != event.snapshot.selected_workspace_id {
        envelopes.push(revision_event_envelope(
            "workspace.selectionChanged",
            event.revision,
            WorkspaceSelectionChangedEvent(revision_event_data(
                event.revision,
                ordered_union(
                    [event.snapshot.selected_workspace_id.to_string()].into_iter(),
                    [before.selected_workspace_id.to_string()].into_iter(),
                ),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                "workspace_selection_invalidated",
            )),
        ));
    }
    let pane_workspace_ids = changed_pane_workspace_ids(before, after);
    if !pane_workspace_ids.is_empty() {
        let pane_ids = pane_ids_for_workspaces(before, after, &pane_workspace_ids);
        envelopes.push(revision_event_envelope(
            "pane.layoutChanged",
            event.revision,
            PaneLayoutChangedEvent(revision_event_data(
                event.revision,
                pane_workspace_ids,
                pane_ids,
                Vec::new(),
                Vec::new(),
                "pane_layout_invalidated",
            )),
        ));
    }
    let tab_workspace_ids = changed_tab_workspace_ids(before, after);
    if !tab_workspace_ids.is_empty() {
        let tab_ids = tab_ids_for_workspaces(before, after, &tab_workspace_ids);
        envelopes.push(revision_event_envelope(
            "tab.changed",
            event.revision,
            TabChangedEvent(revision_event_data(
                event.revision,
                tab_workspace_ids,
                Vec::new(),
                tab_ids,
                Vec::new(),
                "tab_snapshot_invalidated",
            )),
        ));
    }
    for state in changed_browser_states(before, after) {
        envelopes.push(revision_event_envelope(
            "browser.changed",
            event.revision,
            BrowserChangedEvent { state },
        ));
    }
    if before.shortcut_overrides != event.snapshot.shortcut_overrides
        || before.notification_settings != event.snapshot.notification_settings
    {
        envelopes.push(revision_event_envelope(
            "settings.changed",
            event.revision,
            SettingsChangedEvent(revision_event_data(
                event.revision,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                changed_command_ids(before, after),
                "settings_snapshot_invalidated",
            )),
        ));
    }
    let added = after
        .notifications
        .iter()
        .filter(|notification| {
            !before
                .notifications
                .iter()
                .any(|value| value.id == notification.id)
        })
        .collect::<Vec<_>>();
    for notification in &added {
        envelopes.push(revision_event_envelope(
            "notification.created",
            event.revision,
            NotificationCreatedEvent {
                notification: notification_snapshot(notification),
            },
        ));
    }
    let removed = before
        .notifications
        .iter()
        .filter(|notification| {
            !after
                .notifications
                .iter()
                .any(|value| value.id == notification.id)
        })
        .collect::<Vec<_>>();
    let read_state_changed = after
        .notifications
        .iter()
        .filter(|notification| {
            before
                .notifications
                .iter()
                .find(|value| value.id == notification.id)
                .is_some_and(|value| value.read_at != notification.read_at)
        })
        .collect::<Vec<_>>();
    if !removed.is_empty() || !read_state_changed.is_empty() {
        let reason = if !removed.is_empty() && !added.is_empty() {
            "notification_retention_evicted"
        } else if !removed.is_empty() {
            "notifications_cleared"
        } else {
            "notification_read_state_changed"
        };
        envelopes.push(revision_event_envelope(
            "notification.changed",
            event.revision,
            NotificationChangedEvent {
                revision: event.revision,
                notification_ids: ordered_union(
                    removed.iter().map(|value| value.id.to_string()),
                    read_state_changed.iter().map(|value| value.id.to_string()),
                ),
                workspace_ids: ordered_union(
                    removed.iter().map(|value| value.workspace_id.to_string()),
                    read_state_changed
                        .iter()
                        .map(|value| value.workspace_id.to_string()),
                ),
                reason: reason.to_owned(),
            },
        ));
    }
    envelopes
}

fn changed_browser_states(
    before: &ApplicationState,
    after: &ApplicationState,
) -> Vec<BrowserSessionState> {
    let before_sessions = before
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| match &tab.content {
            TabContent::Browser { metadata } => Some(metadata),
            TabContent::Terminal { .. } => None,
        })
        .map(|metadata| (metadata.browser_session_id(), metadata))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut changed = after
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| match &tab.content {
            TabContent::Browser { metadata }
                if before_sessions
                    .get(&metadata.browser_session_id())
                    .is_none_or(|before| *before != metadata) =>
            {
                Some(browser_session_state(metadata))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    changed.sort_unstable_by(|left, right| left.browser_session_id.cmp(&right.browser_session_id));
    changed
}

fn revision_event_data(
    revision: u64,
    workspace_ids: Vec<String>,
    pane_ids: Vec<String>,
    tab_ids: Vec<String>,
    command_ids: Vec<String>,
    reason: &str,
) -> RevisionEventData {
    RevisionEventData {
        revision,
        workspace_ids,
        pane_ids,
        tab_ids,
        command_ids,
        reason: reason.to_owned(),
    }
}

fn revision_event_envelope(event: &str, revision: u64, data: impl Serialize) -> EventEnvelope {
    EventEnvelope {
        event: event.to_owned(),
        revision: Some(revision),
        data: serde_json::to_value(data).expect("revision event serialization is infallible"),
    }
}

fn changed_workspace_ids(before: &ApplicationState, after: &ApplicationState) -> Vec<String> {
    ordered_union(
        after
            .workspaces
            .iter()
            .enumerate()
            .filter_map(|(index, workspace)| {
                let before_index = before
                    .workspaces
                    .iter()
                    .position(|value| value.id == workspace.id);
                (before_index != Some(index)
                    || before_index.is_none_or(|index| before.workspaces[index] != *workspace))
                .then(|| workspace.id.to_string())
            }),
        before
            .workspaces
            .iter()
            .filter(|workspace| {
                !after
                    .workspaces
                    .iter()
                    .any(|value| value.id == workspace.id)
            })
            .map(|workspace| workspace.id.to_string()),
    )
}

fn changed_pane_workspace_ids(before: &ApplicationState, after: &ApplicationState) -> Vec<String> {
    changed_projection_workspace_ids(before, after, |left, right| {
        left.layout != right.layout
            || left.panes != right.panes
            || left.selected_pane_id != right.selected_pane_id
    })
}

fn changed_tab_workspace_ids(before: &ApplicationState, after: &ApplicationState) -> Vec<String> {
    changed_projection_workspace_ids(before, after, |left, right| left.tabs != right.tabs)
}

fn changed_projection_workspace_ids(
    before: &ApplicationState,
    after: &ApplicationState,
    changed: impl Fn(&Workspace, &Workspace) -> bool,
) -> Vec<String> {
    ordered_union(
        after
            .workspaces
            .iter()
            .filter(|workspace| {
                before
                    .workspaces
                    .iter()
                    .find(|value| value.id == workspace.id)
                    .is_none_or(|left| changed(left, workspace))
            })
            .map(|workspace| workspace.id.to_string()),
        before
            .workspaces
            .iter()
            .filter(|workspace| {
                !after
                    .workspaces
                    .iter()
                    .any(|value| value.id == workspace.id)
            })
            .map(|workspace| workspace.id.to_string()),
    )
}

fn pane_ids_for_workspaces(
    before: &ApplicationState,
    after: &ApplicationState,
    workspace_ids: &[String],
) -> Vec<String> {
    ordered_union(
        state_pane_ids(after, workspace_ids),
        state_pane_ids(before, workspace_ids),
    )
}

fn tab_ids_for_workspaces(
    before: &ApplicationState,
    after: &ApplicationState,
    workspace_ids: &[String],
) -> Vec<String> {
    ordered_union(
        state_tab_ids(after, workspace_ids),
        state_tab_ids(before, workspace_ids),
    )
}

fn state_pane_ids<'a>(
    state: &'a ApplicationState,
    workspace_ids: &'a [String],
) -> impl Iterator<Item = String> + 'a {
    state
        .workspaces
        .iter()
        .filter(|workspace| {
            workspace_ids
                .iter()
                .any(|id| *id == workspace.id.to_string())
        })
        .flat_map(|workspace| {
            let mut ids = Vec::new();
            collect_leaves(&workspace.layout, &mut ids);
            ids.into_iter().map(|value| value.to_string())
        })
}

fn state_tab_ids<'a>(
    state: &'a ApplicationState,
    workspace_ids: &'a [String],
) -> impl Iterator<Item = String> + 'a {
    state
        .workspaces
        .iter()
        .filter(|workspace| {
            workspace_ids
                .iter()
                .any(|id| *id == workspace.id.to_string())
        })
        .flat_map(|workspace| {
            let mut panes = Vec::new();
            collect_leaves(&workspace.layout, &mut panes);
            panes.into_iter().flat_map(|pane_id| {
                workspace.panes[&pane_id]
                    .tabs
                    .iter()
                    .map(ToString::to_string)
            })
        })
}

fn changed_command_ids(before: &ApplicationState, after: &ApplicationState) -> Vec<String> {
    ordered_union(
        after
            .shortcut_overrides
            .iter()
            .filter(|(command, shortcut)| {
                before.shortcut_overrides.get(*command) != Some(*shortcut)
            })
            .map(|(command, _)| command.as_str().to_owned()),
        before
            .shortcut_overrides
            .keys()
            .filter(|command| !after.shortcut_overrides.contains_key(*command))
            .map(|command| command.as_str().to_owned()),
    )
}

fn ordered_union(
    primary: impl Iterator<Item = String>,
    secondary: impl Iterator<Item = String>,
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    primary
        .chain(secondary)
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_protocol::RequestEnvelope;
    use agent_workspace_runtime::{BootstrapConfig, TerminalManagerBackend};
    use agent_workspace_storage::SqliteStateStore;
    use agent_workspace_terminal_runtime::TerminalManager;
    use serde_json::{Value, json};
    use tempfile::TempDir;

    #[test]
    fn production_capabilities_match_public_dispatcher() {
        let capabilities = identify(true, false).capabilities;
        assert!(capabilities.contains(&"system.ping".to_owned()));
        assert!(capabilities.contains(&"terminal.restart".to_owned()));
        assert!(!capabilities.contains(&"terminal.create".to_owned()));
        assert!(!capabilities.contains(&"terminal.terminate".to_owned()));
        assert!(capabilities.contains(&"tab.openBrowser".to_owned()));
        assert!(capabilities.contains(&"browser.navigate".to_owned()));
        assert!(capabilities.contains(&"browser.back".to_owned()));
        assert!(capabilities.contains(&"browser.forward".to_owned()));
        assert!(capabilities.contains(&"browser.reload".to_owned()));
        assert!(capabilities.contains(&"browser.stop".to_owned()));
        assert!(capabilities.contains(&"browser.openDevTools".to_owned()));
        assert!(!capabilities.contains(&"attention-v1".to_owned()));
        assert!(!capabilities.contains(&"browser.observe".to_owned()));
    }

    #[tokio::test]
    #[cfg(unix)]
    #[allow(clippy::too_many_lines)]
    async fn browser_commands_project_full_state_and_preserve_terminal_lifecycle() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let runtime = context.runtime.as_ref().expect("production has a runtime");
        let initial = runtime.snapshot().await;
        let workspace_id = initial.workspaces[0].id.to_string();
        let pane_id = initial.workspaces[0].selected_pane_id.to_string();
        let terminal_sessions = initial.workspaces[0]
            .tabs
            .values()
            .filter_map(|tab| tab.content.runtime_session_id().map(ToString::to_string))
            .collect::<BTreeSet<_>>();

        let opened = dispatch(
            "browser-open".to_owned(),
            "tab.openBrowser",
            json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "metadata": { "url": "https://example.test/path?q=a%26b#fragment" },
                "profilePartition": "persist:integration"
            }),
            &context,
        )
        .await;
        assert!(opened.ok, "browser open failed: {:?}", opened.error);
        let opened_snapshot = mutation_snapshot(&opened);
        let browser = opened_snapshot["workspaces"][0]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["content"]["kind"] == "browser")
            .expect("browser snapshot must exist");
        let browser_tab_id = browser["id"].as_str().unwrap().to_owned();
        let state = &browser["content"]["state"];
        let browser_session_id = state["browserSessionId"].as_str().unwrap().to_owned();
        assert_eq!(browser["title"], "Browser");
        assert_eq!(state["url"], "https://example.test/path?q=a%26b#fragment");
        assert_eq!(state["navigationTitle"], "");
        assert_eq!(state["canBack"], false);
        assert_eq!(state["canForward"], false);
        assert_eq!(state["loading"], false);
        assert_eq!(state["devToolsOpen"], false);
        assert_eq!(state["profilePartition"], "persist:integration");
        assert_eq!(state["stateRevision"], 0);
        assert!(state["correlationId"].is_null());

        let after_open = runtime.snapshot().await;
        let events = domain_event_envelopes(
            &initial,
            &DomainEvent {
                revision: after_open.revision,
                snapshot: after_open.clone(),
            },
        );
        let changed = events
            .iter()
            .find(|event| event.event == "browser.changed")
            .expect("browser creation must emit browser.changed");
        assert_eq!(changed.revision, Some(after_open.revision));
        assert_eq!(changed.data["state"], *state);

        let navigated = dispatch(
            "browser-navigate".to_owned(),
            "browser.navigate",
            json!({
                "browserSessionId": browser_session_id,
                "url": "https://example.test/next?x=1#two",
                "expectedStateRevision": 0,
                "correlationId": "navigate-1"
            }),
            &context,
        )
        .await;
        assert!(navigated.ok, "navigate failed: {:?}", navigated.error);
        let navigated_state = &mutation_snapshot(&navigated)["workspaces"][0]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["id"] == browser_tab_id)
            .unwrap()["content"]["state"];
        assert_eq!(navigated_state["url"], "https://example.test/next?x=1#two");
        assert_eq!(navigated_state["loading"], true);
        assert_eq!(navigated_state["stateRevision"], 1);
        assert_eq!(navigated_state["correlationId"], "navigate-1");

        let impossible = dispatch(
            "browser-back-impossible".to_owned(),
            "browser.back",
            json!({
                "browserSessionId": browser_session_id,
                "expectedStateRevision": 1,
                "correlationId": "back-impossible"
            }),
            &context,
        )
        .await;
        assert!(!impossible.ok);
        assert!(impossible.error.is_some());

        let observed = dispatch(
            "browser-observe".to_owned(),
            "browser.observe",
            json!({
                "workspaceId": workspace_id,
                "tabId": browser_tab_id,
                "state": {
                    "browserSessionId": browser_session_id,
                    "url": "https://example.test/next?x=1#two",
                    "navigationTitle": "Query & Fragment",
                    "canBack": true,
                    "canForward": false,
                    "loading": false,
                    "devToolsOpen": false,
                    "profilePartition": "persist:integration",
                    "stateRevision": 2,
                    "correlationId": "navigate-1"
                }
            }),
            &context,
        )
        .await;
        assert!(observed.ok, "observation failed: {:?}", observed.error);
        let observed_state = &mutation_snapshot(&observed)["workspaces"][0]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["id"] == browser_tab_id)
            .unwrap()["content"]["state"];
        assert_eq!(observed_state["navigationTitle"], "Query & Fragment");
        assert_eq!(observed_state["canBack"], true);
        assert_eq!(observed_state["stateRevision"], 2);

        let stale_observation = dispatch(
            "browser-observe-stale".to_owned(),
            "browser.observe",
            json!({
                "workspaceId": workspace_id,
                "tabId": browser_tab_id,
                "state": observed_state
            }),
            &context,
        )
        .await;
        assert!(!stale_observation.ok);
        assert!(stale_observation.error.is_some());

        let invalid_internal = dispatch(
            "browser-observe-invalid".to_owned(),
            "browser.observe",
            json!({ "workspaceId": workspace_id, "tabId": browser_tab_id, "state": observed_state, "extra": true }),
            &context,
        )
        .await;
        assert_eq!(
            invalid_internal.error.as_ref().unwrap().code,
            "invalid_params"
        );

        let split = dispatch(
            "browser-split".to_owned(),
            "pane.split",
            json!({
                "workspaceId": workspace_id,
                "targetPaneId": pane_id,
                "axis": "horizontal",
                "ratio": 0.5,
                "placement": "after",
                "content": { "kind": "newBrowser", "url": "https://split.example/" }
            }),
            &context,
        )
        .await;
        assert!(split.ok, "browser split failed: {:?}", split.error);
        let final_state = runtime.snapshot().await;
        let final_terminal_sessions = final_state.workspaces[0]
            .tabs
            .values()
            .filter_map(|tab| tab.content.runtime_session_id().map(ToString::to_string))
            .collect::<BTreeSet<_>>();
        assert_eq!(final_terminal_sessions, terminal_sessions);
        assert_eq!(
            final_state.workspaces[0]
                .tabs
                .values()
                .filter(|tab| matches!(tab.content, TabContent::Browser { .. }))
                .count(),
            2
        );

        runtime
            .shutdown()
            .await
            .expect("authoritative runtime shutdown must complete");
    }

    async fn production_context(temp: &TempDir) -> ControlContext {
        let store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("state.sqlite3"),
                ShortcutPlatform::NonMacOs,
            )
            .expect("test store must open"),
        );
        let terminals = TerminalManager::new();
        let backend = Arc::new(TerminalManagerBackend::new(terminals));
        let config = BootstrapConfig::for_service(temp.path().to_path_buf(), Timestamp(1), 24, 80)
            .expect("bootstrap config must be valid");
        let runtime = Arc::new(
            ProductionWorkspaceRuntime::bootstrap(store, Arc::clone(&backend), config)
                .await
                .expect("runtime must bootstrap"),
        );
        ControlContext {
            terminal_io: backend.terminal_io().clone(),
            terminal_backend: Some((*backend).clone()),
            logging_runtime: None,
            terminal_lifecycle: TerminalLifecycle::WorkspaceManaged,
            runtime: Some(runtime),
            persistence: None,
            card_slots: Some(crate::card_slots::CardSlotRuntime::new()),
            card_slots_v2: Some(crate::card_slots::CardSlotV2Runtime::new()),
            attention: Some(crate::attention::AttentionRuntime::new()),
            actions: None,
            browser_automation: None,
            agent_sessions: None,
            remote_sessions: None,
            sidebar_content: None,
            multi_window: None,
            platform: ShortcutPlatform::NonMacOs,
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn card_slots_are_targeted_revisioned_noop_safe_and_non_durable() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let runtime = context.runtime.as_ref().expect("production has a runtime");
        let before = runtime.snapshot().await;
        let workspace_id = before.workspaces[0].id.to_string();
        let card_slots = context.card_slots.as_ref().expect("card slots enabled");
        let mut events = card_slots.subscribe();
        let attachments = tokio::sync::Mutex::new(HashSet::new());
        let bound_window = tokio::sync::Mutex::new(None);
        let call_card_slots = |id: &str, command: &str, params: Value| {
            super::super::dispatch(
                RequestEnvelope {
                    id: id.to_owned(),
                    command: command.to_owned(),
                    params,
                },
                &context,
                &attachments,
                &bound_window,
            )
        };

        let initial = call_card_slots(
            "card-get",
            "workspace.cardSlots.get",
            json!({ "workspaceId": workspace_id }),
        )
        .await;
        assert!(initial.ok);
        assert_eq!(initial.revision, None);
        assert_eq!(initial.result.as_ref().expect("result")["revision"], 0);

        let replacement = json!({
            "workspaceId": workspace_id,
            "expectedRevision": 0,
            "agentStatus": { "status": "running", "label": "Reviewing" },
            "progress": { "mode": "determinate", "value": 50, "label": "Tests" }
        });
        let changed = call_card_slots(
            "card-replace",
            "workspace.cardSlots.replace",
            replacement.clone(),
        )
        .await;
        assert!(changed.ok);
        assert_eq!(changed.revision, None);
        assert_eq!(changed.result.as_ref().expect("result")["revision"], 1);
        let event = events.recv().await.expect("one targeted event");
        assert_eq!(event.workspace_id, workspace_id);
        assert_eq!(event.slot_revision, 1);

        let mut no_op_params = replacement;
        no_op_params["expectedRevision"] = json!(1);
        let no_op =
            call_card_slots("card-no-op", "workspace.cardSlots.replace", no_op_params).await;
        assert!(no_op.ok);
        assert_eq!(no_op.result.as_ref().expect("result")["revision"], 1);
        assert!(events.try_recv().is_err());

        let conflict = call_card_slots(
            "card-conflict",
            "workspace.cardSlots.replace",
            json!({
                "workspaceId": workspace_id,
                "expectedRevision": 0,
                "agentStatus": null,
                "progress": null
            }),
        )
        .await;
        assert_eq!(
            conflict.error.as_ref().expect("conflict").code,
            "revision_conflict"
        );
        let missing = call_card_slots(
            "card-missing",
            "workspace.cardSlots.get",
            json!({ "workspaceId": "10000000-0000-4000-8000-000000000099" }),
        )
        .await;
        assert_eq!(
            missing.error.as_ref().expect("missing").code,
            "workspace_not_found"
        );
        assert_eq!(runtime.snapshot().await, before);

        runtime
            .shutdown()
            .await
            .expect("authoritative runtime shutdown must complete");
    }

    #[tokio::test]
    #[cfg(unix)]
    #[allow(clippy::too_many_lines)]
    async fn production_rejects_raw_lifecycle_without_changing_workspace_ownership() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let runtime = context.runtime.as_ref().expect("production has a runtime");
        let before = runtime.snapshot().await;
        let workspace = before.workspaces.first().expect("workspace must exist");
        let tab = workspace
            .tabs
            .values()
            .find(|tab| tab.content.runtime_session_id().is_some())
            .expect("bootstrapped terminal tab must exist");
        let workspace_id = workspace.id.to_string();
        let tab_id = tab.id.to_string();
        let original_session = tab
            .content
            .runtime_session_id()
            .expect("terminal must be bound")
            .to_string();
        assert!(
            !context
                .terminal_io
                .attach(&original_session)
                .expect("workspace terminal must be attachable")
                .terminal
                .exited
        );

        let attachments = tokio::sync::Mutex::new(HashSet::new());
        let bound_window = tokio::sync::Mutex::new(None);
        let raw_create = super::super::dispatch(
            RequestEnvelope {
                id: "raw-create".to_owned(),
                command: "terminal.create".to_owned(),
                params: json!({
                    "rows": 24,
                    "cols": 80,
                    "cwd": temp.path(),
                    "command": ["/bin/sh"]
                }),
            },
            &context,
            &attachments,
            &bound_window,
        )
        .await;
        let raw_terminate = super::super::dispatch(
            RequestEnvelope {
                id: "raw-terminate".to_owned(),
                command: "terminal.terminate".to_owned(),
                params: json!({ "terminalId": original_session }),
            },
            &context,
            &attachments,
            &bound_window,
        )
        .await;

        for response in [&raw_create, &raw_terminate] {
            assert!(!response.ok);
            let error = response.error.as_ref().expect("failure must have an error");
            assert_eq!(error.code, "terminal_lifecycle_managed");
            assert_eq!(
                error.message,
                "Terminal lifecycle is managed by authoritative workspace commands"
            );
            assert_eq!(response.revision, None);
        }
        assert_eq!(runtime.snapshot().await, before);
        assert!(
            !context
                .terminal_io
                .attach(&original_session)
                .expect("raw termination must not affect the workspace PTY")
                .terminal
                .exited
        );

        let restart = dispatch(
            "authorized-restart".to_owned(),
            "terminal.restart",
            json!({ "workspaceId": workspace_id, "tabId": tab_id }),
            &context,
        )
        .await;
        assert!(restart.ok, "authorized restart failed: {:?}", restart.error);
        let after = runtime.snapshot().await;
        let replacement_session = after.workspaces[0]
            .tabs
            .get(&tab.id)
            .expect("same tab must remain authoritative")
            .content
            .runtime_session_id()
            .expect("restarted tab must be rebound")
            .to_string();
        assert_ne!(replacement_session, original_session);
        assert!(
            !context
                .terminal_io
                .attach(&replacement_session)
                .expect("authorized replacement PTY must be attachable")
                .terminal
                .exited
        );

        runtime
            .shutdown()
            .await
            .expect("authoritative runtime shutdown must complete");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn closing_a_workspace_revokes_every_removed_terminal_attachment() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let runtime = context.runtime.as_ref().expect("production has a runtime");
        let before = runtime.snapshot().await;
        let workspace = before.workspaces.first().expect("workspace must exist");
        let old_session = workspace
            .tabs
            .values()
            .find_map(|tab| tab.content.runtime_session_id())
            .expect("bootstrapped terminal must be bound")
            .to_string();

        let closed = dispatch(
            "close-workspace".to_owned(),
            "workspace.close",
            json!({ "workspaceId": workspace.id }),
            &context,
        )
        .await;
        assert!(closed.ok, "workspace close failed: {:?}", closed.error);
        assert!(context.terminal_io.attach(&old_session).is_err());

        let after = runtime.snapshot().await;
        let replacement_session = after.workspaces[0]
            .tabs
            .values()
            .find_map(|tab| tab.content.runtime_session_id())
            .expect("replacement terminal must be bound")
            .to_string();
        assert_ne!(replacement_session, old_session);
        assert!(context.terminal_io.attach(&replacement_session).is_ok());
        runtime
            .shutdown()
            .await
            .expect("authoritative runtime shutdown must complete");
    }

    async fn call(
        context: &ControlContext,
        sequence: &mut u64,
        command: &str,
        params: Value,
    ) -> ResponseEnvelope {
        *sequence += 1;
        let response = dispatch(format!("request-{sequence}"), command, params, context).await;
        assert!(
            response.ok,
            "{command} failed: {:?}",
            response.error.as_ref()
        );
        response
    }

    fn mutation_snapshot(response: &ResponseEnvelope) -> &Value {
        let result = response.result.as_ref().expect("success has result");
        assert_eq!(response.revision, result["revision"].as_u64());
        assert_eq!(response.revision, result["snapshot"]["revision"].as_u64());
        &result["snapshot"]
    }

    fn workspace<'a>(snapshot: &'a Value, workspace_id: &str) -> &'a Value {
        snapshot["workspaces"]
            .as_array()
            .expect("workspaces must be an array")
            .iter()
            .find(|workspace| workspace["id"] == workspace_id)
            .expect("workspace must exist")
    }

    #[tokio::test]
    #[cfg(unix)]
    #[allow(clippy::too_many_lines)]
    async fn every_public_milestone_two_command_uses_authoritative_revisions() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let mut sequence = 0;

        let listed = call(&context, &mut sequence, "workspace.list", json!({})).await;
        let initial = &listed.result.as_ref().unwrap()["snapshot"];
        assert_eq!(listed.revision, initial["revision"].as_u64());
        let first_workspace = initial["workspaces"][0]["id"].as_str().unwrap().to_owned();
        let first_pane = initial["workspaces"][0]["panes"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let first_tab = initial["workspaces"][0]["tabs"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let snapshot = call(
            &context,
            &mut sequence,
            "workspace.snapshot",
            json!({ "workspaceId": first_workspace }),
        )
        .await;
        assert_eq!(
            snapshot.revision,
            snapshot.result.as_ref().unwrap()["revision"].as_u64()
        );

        let created = call(
            &context,
            &mut sequence,
            "workspace.create",
            json!({
                "name": "Created",
                "description": "integration",
                "color": "blue",
                "workingDirectory": temp.path(),
                "initialTerminal": {
                    "cwd": temp.path(),
                    "command": ["/bin/sh"],
                    "rows": 25,
                    "cols": 81
                }
            }),
        )
        .await;
        let created_snapshot = mutation_snapshot(&created);
        let created_workspace = created_snapshot["selectedWorkspaceId"]
            .as_str()
            .unwrap()
            .to_owned();
        let created_pane = workspace(created_snapshot, &created_workspace)["panes"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let created_tab = workspace(created_snapshot, &created_workspace)["tabs"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "workspace.update",
                json!({ "workspaceId": created_workspace, "name": "Renamed" }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "workspace.select",
                json!({ "workspaceId": first_workspace }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "workspace.move",
                json!({ "workspaceId": created_workspace, "destinationIndex": 0 }),
            )
            .await,
        );

        let split = call(
            &context,
            &mut sequence,
            "pane.split",
            json!({
                "workspaceId": created_workspace,
                "targetPaneId": created_pane,
                "axis": "horizontal",
                "ratio": 0.4,
                "placement": "after",
                "content": {
                    "kind": "newTerminal",
                    "launch": { "cwd": temp.path(), "rows": 24, "cols": 80 }
                }
            }),
        )
        .await;
        let split_snapshot = mutation_snapshot(&split);
        let created_projection = workspace(split_snapshot, &created_workspace);
        let second_pane = created_projection["panes"][1]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let split_id = created_projection["layout"]["splitId"]
            .as_str()
            .unwrap()
            .to_owned();

        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "pane.focus",
                json!({ "workspaceId": created_workspace, "paneId": created_pane }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "pane.resize",
                json!({ "workspaceId": created_workspace, "splitId": split_id, "ratio": 0.6 }),
            )
            .await,
        );

        let opened = call(
            &context,
            &mut sequence,
            "tab.openTerminal",
            json!({
                "workspaceId": created_workspace,
                "paneId": created_pane,
                "launch": { "cwd": temp.path(), "rows": 24, "cols": 80 }
            }),
        )
        .await;
        let opened_snapshot = mutation_snapshot(&opened);
        let opened_tab = workspace(opened_snapshot, &created_workspace)["panes"][0]["tabIds"][1]
            .as_str()
            .unwrap()
            .to_owned();
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "tab.select",
                json!({ "workspaceId": created_workspace, "tabId": created_tab }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "tab.update",
                json!({
                    "workspaceId": created_workspace,
                    "tabId": created_tab,
                    "customTitle": { "value": "Custom" }
                }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "tab.move",
                json!({
                    "workspaceId": created_workspace,
                    "tabId": opened_tab,
                    "destinationPaneId": second_pane,
                    "destinationIndex": 1
                }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "pane.moveTab",
                json!({
                    "workspaceId": created_workspace,
                    "tabId": opened_tab,
                    "destinationPaneId": created_pane,
                    "destinationIndex": 1
                }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "terminal.restart",
                json!({ "workspaceId": created_workspace, "tabId": created_tab }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "tab.close",
                json!({ "workspaceId": created_workspace, "tabId": opened_tab }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "pane.close",
                json!({ "workspaceId": created_workspace, "paneId": second_pane }),
            )
            .await,
        );

        let settings_get = call(&context, &mut sequence, "settings.get", json!({})).await;
        assert_eq!(
            settings_get.revision,
            settings_get.result.as_ref().unwrap()["revision"].as_u64()
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "settings.update",
                json!({
                    "shortcutOverrides": [
                        { "commandId": "workspace.new", "shortcut": null }
                    ]
                }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "settings.resetKey",
                json!({ "commandId": "workspace.new" }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "workspace.close",
                json!({ "workspaceId": first_workspace }),
            )
            .await,
        );

        let state = context.runtime.as_ref().unwrap().snapshot().await;
        let committed_revision = state.revision;
        let persisted = serde_json::to_string(&state).expect("state must serialize");
        assert!(!persisted.contains("/bin/sh"));
        assert!(!persisted.contains("runtimeSessionId"));
        assert!(state.revision > 0);

        let before = ApplicationState::new(
            replacement_workspace(temp.path().to_path_buf(), 24, 80, Timestamp(1)).unwrap(),
        )
        .unwrap();
        let domain_event = DomainEvent {
            revision: state.revision,
            snapshot: state.clone(),
        };
        for event in domain_event_envelopes(&before, &domain_event) {
            assert_eq!(event.revision, Some(domain_event.revision));
            assert_eq!(event.data["revision"], json!(domain_event.revision));
        }

        // Keep otherwise-unused bootstrap identities covered by the projection assertions.
        assert_ne!(first_pane, created_pane);
        assert_ne!(first_tab, created_tab);
        context
            .runtime
            .as_ref()
            .unwrap()
            .shutdown()
            .await
            .expect("authoritative runtime shutdown must complete");
        drop(context);

        let restored_store = Arc::new(
            SqliteStateStore::open(
                temp.path().join("state.sqlite3"),
                ShortcutPlatform::NonMacOs,
            )
            .expect("persisted store must reopen"),
        );
        let restored_terminals = TerminalManager::new();
        let restored_backend = Arc::new(TerminalManagerBackend::new(restored_terminals));
        let restored = ProductionWorkspaceRuntime::bootstrap(
            restored_store,
            restored_backend,
            BootstrapConfig::for_service(temp.path().to_path_buf(), Timestamp(2), 24, 80).unwrap(),
        )
        .await
        .expect("persisted runtime must restore");
        let restored_state = restored.snapshot().await;
        assert_eq!(restored_state.revision, committed_revision);
        assert_eq!(restored_state.workspaces[0].name, "Renamed");
        assert!(
            !serde_json::to_string(&restored_state)
                .unwrap()
                .contains("/bin/sh")
        );
        restored
            .shutdown()
            .await
            .expect("restored runtime shutdown must complete");
    }

    #[test]
    fn replay_cache_compares_the_complete_request() {
        let request = RequestEnvelope {
            id: "same-id".to_owned(),
            command: "system.ping".to_owned(),
            params: json!({}),
        };
        let mut cache = super::super::ReplayCache::default();
        cache.insert(request.clone(), b"first\n".to_vec());
        assert_eq!(cache.lookup(&request), Some(b"first\n".to_vec()));
        assert!(cache.contains_id("same-id"));
        assert_eq!(
            cache.lookup(&RequestEnvelope {
                params: json!({ "different": true }),
                ..request
            }),
            None
        );
    }

    #[tokio::test]
    async fn concurrent_dispatchers_receive_distinct_serialized_revisions() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let first = dispatch(
            "client-a".to_owned(),
            "settings.update",
            json!({
                "shortcutOverrides": [
                    { "commandId": "workspace.new", "shortcut": null }
                ]
            }),
            &context,
        );
        let second = dispatch(
            "client-b".to_owned(),
            "settings.update",
            json!({
                "shortcutOverrides": [
                    { "commandId": "terminal.new", "shortcut": null }
                ]
            }),
            &context,
        );
        let (first, second) = tokio::join!(first, second);
        assert!(first.ok && second.ok);
        let first_revision = first.revision.unwrap();
        let second_revision = second.revision.unwrap();
        assert_ne!(first_revision, second_revision);
        assert_eq!(first_revision.abs_diff(second_revision), 1);
        let state = context.runtime.as_ref().unwrap().snapshot().await;
        assert_eq!(state.revision, first_revision.max(second_revision));
        assert_eq!(state.shortcut_overrides.len(), 2);
        context
            .runtime
            .as_ref()
            .unwrap()
            .shutdown()
            .await
            .expect("authoritative runtime shutdown must complete");
    }

    #[test]
    fn settings_only_mutation_emits_one_precise_named_invalidation() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let mut after = ApplicationState::new(
            replacement_workspace(temp.path().to_path_buf(), 24, 80, Timestamp(1)).unwrap(),
        )
        .unwrap();
        let before = after.clone();
        let command = CommandId::new("workspace.new").unwrap();
        let outcome = after
            .set_shortcut_override(command, None, ShortcutPlatform::NonMacOs)
            .expect("settings mutation must succeed");
        let domain_event = DomainEvent {
            revision: outcome.revision,
            snapshot: after,
        };

        let envelopes = domain_event_envelopes(&before, &domain_event);
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].event, "settings.changed");
        assert_eq!(envelopes[0].revision, Some(outcome.revision));
        assert_eq!(envelopes[0].data["revision"], outcome.revision);
        assert_eq!(envelopes[0].data["workspaceIds"], json!([]));
        assert_eq!(envelopes[0].data["paneIds"], json!([]));
        assert_eq!(envelopes[0].data["tabIds"], json!([]));
        assert_eq!(envelopes[0].data["commandIds"], json!(["workspace.new"]));
    }

    #[tokio::test]
    #[cfg(unix)]
    #[allow(clippy::too_many_lines)]
    async fn notification_commands_cover_attention_pagination_and_partial_settings() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let state = context.runtime.as_ref().unwrap().snapshot().await;
        let workspace = &state.workspaces[0];
        let tab = workspace.tabs.values().next().unwrap();
        let target = json!({
            "workspaceId": workspace.id,
            "paneId": tab.pane_id,
            "tabId": tab.id,
        });
        let mut sequence = 0;

        for (title, level) in [("First", "info"), ("Second", "warning"), ("Third", "error")] {
            let response = call(
                &context,
                &mut sequence,
                "notification.publish",
                json!({
                    "target": target,
                    "source": "cli",
                    "level": level,
                    "title": title,
                    "body": format!("{title} body"),
                }),
            )
            .await;
            assert_eq!(
                mutation_snapshot(&response)["attention"]["unreadCount"],
                sequence
            );
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }

        let page = call(
            &context,
            &mut sequence,
            "notification.list",
            json!({ "offset": 1, "limit": 1 }),
        )
        .await;
        let page = page.result.unwrap();
        assert_eq!(page["total"], 3);
        assert_eq!(page["unreadCount"], 3);
        assert_eq!(page["notifications"][0]["title"], "Second");

        let all = call(
            &context,
            &mut sequence,
            "notification.list",
            json!({ "workspaceId": workspace.id }),
        )
        .await
        .result
        .unwrap();
        let oldest_id = all["notifications"][2]["id"].as_str().unwrap().to_owned();
        let newest_id = all["notifications"][0]["id"].as_str().unwrap().to_owned();
        let marked = call(
            &context,
            &mut sequence,
            "notification.markRead",
            json!({ "notificationId": oldest_id }),
        )
        .await;
        assert_eq!(mutation_snapshot(&marked)["attention"]["unreadCount"], 2);
        let unread = call(
            &context,
            &mut sequence,
            "notification.list",
            json!({ "unreadOnly": true }),
        )
        .await
        .result
        .unwrap();
        assert_eq!(unread["total"], 2);
        assert_eq!(unread["unreadCount"], 2);

        let before_shortcuts = context
            .runtime
            .as_ref()
            .unwrap()
            .snapshot()
            .await
            .shortcut_overrides;
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "settings.update",
                json!({
                    "notifications": { "systemEnabled": false, "includeBody": true }
                }),
            )
            .await,
        );
        let settings = call(&context, &mut sequence, "settings.get", json!({}))
            .await
            .result
            .unwrap();
        assert_eq!(
            settings["notifications"],
            json!({ "systemEnabled": false, "includeBody": true })
        );
        assert_eq!(
            context
                .runtime
                .as_ref()
                .unwrap()
                .snapshot()
                .await
                .shortcut_overrides,
            before_shortcuts
        );

        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "notification.markUnread",
                json!({ "notificationId": oldest_id }),
            )
            .await,
        );
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "notification.clear",
                json!({ "scope": { "kind": "notification", "notificationId": newest_id } }),
            )
            .await,
        );
        let missing = dispatch(
            "missing-notification".to_owned(),
            "notification.markRead",
            json!({ "notificationId": NotificationId::new() }),
            &context,
        )
        .await;
        assert_eq!(missing.error.unwrap().code, "notification_not_found");
        mutation_snapshot(
            &call(
                &context,
                &mut sequence,
                "notification.clear",
                json!({ "scope": { "kind": "all" } }),
            )
            .await,
        );
        assert!(
            context
                .runtime
                .as_ref()
                .unwrap()
                .snapshot()
                .await
                .notifications
                .is_empty()
        );
        context.runtime.as_ref().unwrap().shutdown().await.unwrap();
    }

    #[tokio::test]
    #[cfg(unix)]
    #[allow(clippy::too_many_lines)]
    async fn terminal_notification_mapping_uses_current_tab_location_and_drops_stale_targets() {
        use agent_workspace_terminal_runtime::{
            TerminalEvent as RuntimeEvent, TerminalNotificationSource,
        };

        let temp = TempDir::new().expect("temporary directory must exist");
        let context = production_context(&temp).await;
        let runtime = context.runtime.as_ref().unwrap();
        let state = runtime.snapshot().await;
        let workspace_id = state.workspaces[0].id;
        let initial_pane_id = state.workspaces[0].selected_pane_id;
        let initial_tab = state.workspaces[0].tabs.values().next().unwrap();
        let initial_tab_id = initial_tab.id;
        let session_id = initial_tab
            .content
            .runtime_session_id()
            .unwrap()
            .as_str()
            .to_owned();
        let mut sequence = 0;
        call(
            &context,
            &mut sequence,
            "tab.openTerminal",
            json!({
                "workspaceId": workspace_id,
                "paneId": initial_pane_id,
                "launch": { "cwd": temp.path(), "rows": 24, "cols": 80 }
            }),
        )
        .await;
        let split = call(
            &context,
            &mut sequence,
            "pane.split",
            json!({
                "workspaceId": workspace_id,
                "targetPaneId": initial_pane_id,
                "axis": "horizontal",
                "ratio": 0.5,
                "placement": "after",
                "content": {
                    "kind": "newTerminal",
                    "launch": { "cwd": temp.path(), "rows": 24, "cols": 80 }
                }
            }),
        )
        .await;
        let moved_pane_id = mutation_snapshot(&split)["workspaces"][0]["panes"][1]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        call(
            &context,
            &mut sequence,
            "tab.move",
            json!({
                "workspaceId": workspace_id,
                "tabId": initial_tab_id,
                "destinationPaneId": moved_pane_id,
                "destinationIndex": 1
            }),
        )
        .await;

        super::super::handle_terminal_notification(
            runtime,
            RuntimeEvent::Notification {
                terminal_id: session_id.clone(),
                source: TerminalNotificationSource::Osc9,
                title: None,
                body: "Build completed".to_owned(),
            },
        )
        .await;
        let after_osc = runtime.snapshot().await;
        assert_eq!(after_osc.notifications.len(), 1);
        let osc = &after_osc.notifications[0];
        assert_eq!(osc.workspace_id, workspace_id);
        assert_eq!(osc.pane_id.unwrap().to_string(), moved_pane_id);
        assert_eq!(osc.tab_id, Some(initial_tab_id));
        assert_eq!(osc.source, CoreNotificationSource::Osc);
        assert_eq!(osc.level, CoreNotificationLevel::Info);
        assert_eq!(osc.title, "Terminal notification");

        super::super::handle_terminal_notification(
            runtime,
            RuntimeEvent::Exited {
                terminal_id: session_id,
                exit_code: 7,
                signal: None,
            },
        )
        .await;
        let after_exit = runtime.snapshot().await;
        assert_eq!(after_exit.notifications.len(), 2);
        let exit = &after_exit.notifications[1];
        assert_eq!(exit.source, CoreNotificationSource::Internal);
        assert_eq!(exit.level, CoreNotificationLevel::Error);
        assert_eq!(exit.body.as_deref(), Some("Exit code 7"));

        super::super::handle_terminal_notification(
            runtime,
            RuntimeEvent::Exited {
                terminal_id: Uuid::new_v4().to_string(),
                exit_code: 0,
                signal: None,
            },
        )
        .await;
        assert_eq!(runtime.snapshot().await.notifications.len(), 2);
        runtime.shutdown().await.unwrap();
    }

    #[test]
    fn notification_domain_events_cover_read_clear_and_retention_eviction() {
        let temp = TempDir::new().expect("temporary directory must exist");
        let mut state = ApplicationState::new(
            replacement_workspace(temp.path().to_path_buf(), 24, 80, Timestamp(1)).unwrap(),
        )
        .unwrap();
        let workspace = &state.workspaces[0];
        let workspace_id = workspace.id;
        let pane_id = workspace.selected_pane_id;
        let tab_id = workspace.panes[&pane_id].selected_tab_id;
        for value in 0..agent_workspace_core::NOTIFICATION_RETENTION_CAP {
            state
                .publish_notification(
                    Notification::new(
                        NotificationId::from_uuid(Uuid::from_u128(10_000 + value as u128)),
                        workspace_id,
                        Some(pane_id),
                        Some(tab_id),
                        CoreNotificationSource::Cli,
                        CoreNotificationLevel::Info,
                        format!("notice-{value}"),
                        None,
                        Timestamp(value as u64 + 2),
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        let before = state.clone();
        let evicted_id = before.notifications[0].id;
        let created_id = NotificationId::from_uuid(Uuid::from_u128(99_999));
        let outcome = state
            .publish_notification(
                Notification::new(
                    created_id,
                    workspace_id,
                    Some(pane_id),
                    Some(tab_id),
                    CoreNotificationSource::Osc,
                    CoreNotificationLevel::Info,
                    "storm tail",
                    None,
                    Timestamp(10_000),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            state.notifications.len(),
            agent_workspace_core::NOTIFICATION_RETENTION_CAP
        );
        let envelopes = domain_event_envelopes(
            &before,
            &DomainEvent {
                revision: outcome.revision,
                snapshot: state.clone(),
            },
        );
        let created = envelopes
            .iter()
            .find(|event| event.event == "notification.created")
            .unwrap();
        assert_eq!(created.data["notification"]["id"], created_id.to_string());
        let changed = envelopes
            .iter()
            .find(|event| event.event == "notification.changed")
            .unwrap();
        assert_eq!(changed.data["notificationIds"], json!([evicted_id]));
        assert_eq!(changed.data["workspaceIds"], json!([workspace_id]));
        assert_eq!(changed.data["reason"], "notification_retention_evicted");

        let before_read = state.clone();
        let read_id = state.notifications[0].id;
        let outcome = state
            .mark_notification_read(read_id, Timestamp(20_000))
            .unwrap();
        let read_events = domain_event_envelopes(
            &before_read,
            &DomainEvent {
                revision: outcome.revision,
                snapshot: state,
            },
        );
        let changed = read_events
            .iter()
            .find(|event| event.event == "notification.changed")
            .unwrap();
        assert_eq!(changed.data["notificationIds"], json!([read_id]));
        assert_eq!(changed.data["reason"], "notification_read_state_changed");
    }
}

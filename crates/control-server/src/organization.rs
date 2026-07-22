//! Capability-gated M2 workspace organization dispatch.

use std::sync::Arc;

use agent_workspace_core::{
    ApplicationState, DomainError, GroupId, MutationOutcome, PaneId, Tab, TabId,
    TerminalLaunchSpec, Timestamp, Workspace, WorkspaceId,
};
use agent_workspace_protocol::{
    EmptyParams, GroupAssignParams, GroupCollapseParams, GroupCreateParams, GroupDeleteParams,
    GroupMoveParams, GroupRenameParams, LegacyLimitDimension, LegacyOverLimitSnapshot,
    MutationResult, ResponseEnvelope, WorkspaceBatchCloseParams, WorkspaceCanonicalMoveParams,
    WorkspaceGroupAssignment, WorkspaceGroupSnapshot, WorkspaceOrganizationGetResult,
    WorkspaceOrganizationSnapshot, WorkspacePinParams, WorkspaceSelectionReplaceParams,
};
use agent_workspace_runtime::{IdempotentCommitResult, LaunchOptions, ProductionWorkspaceRuntime};
use agent_workspace_storage::{IdempotencyLookup, IdempotencySaveRequest};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::{ControlContext, milestone2};

const ORGANIZATION_NAMESPACE: &str = "workspace-groups-v1";
const IDEMPOTENCY_RETENTION: usize = 256;

pub(super) fn is_command(command: &str) -> bool {
    matches!(
        command,
        "workspace.organization.get"
            | "workspace.selectMany"
            | "workspace.pin"
            | "workspace.closeSelected"
            | "workspace.reorder"
            | "group.create"
            | "group.rename"
            | "group.delete"
            | "group.move"
            | "group.assign"
            | "group.collapse"
    )
}

#[allow(clippy::too_many_lines)]
pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
) -> ResponseEnvelope {
    let (Some(runtime), Some(persistence)) = (&context.runtime, &context.persistence) else {
        return ResponseEnvelope::failure(
            id,
            "capability_unavailable",
            "The workspace organization capability is unavailable",
        );
    };
    match command {
        "workspace.organization.get" => {
            if parse::<EmptyParams>(&id, params).is_err() {
                return invalid_params(id);
            }
            let state = runtime.snapshot().await;
            ResponseEnvelope::success_at_revision(
                id,
                state.revision,
                serde_json::to_value(WorkspaceOrganizationGetResult {
                    organization: organization_snapshot(&state),
                })
                .expect("organization projection serializes"),
            )
        }
        "workspace.selectMany" => {
            let Ok(params) = parse::<WorkspaceSelectionReplaceParams>(&id, params) else {
                return invalid_params(id);
            };
            let selection: Vec<_> = params.selection.iter().map(|id| workspace_id(id)).collect();
            let focused = workspace_id(&params.focused_workspace_id);
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.replace_workspace_selection(selection.clone(), focused),
            )
            .await
        }
        "workspace.pin" => {
            let Ok(params) = parse::<WorkspacePinParams>(&id, params) else {
                return invalid_params(id);
            };
            let workspace_id = workspace_id(&params.workspace_id);
            let pinned = params.pinned;
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.set_workspace_pinned(workspace_id, pinned),
            )
            .await
        }
        "workspace.closeSelected" => {
            let Ok(params) = parse::<WorkspaceBatchCloseParams>(&id, params) else {
                return invalid_params(id);
            };
            let prepared = match params
                .replacement
                .as_ref()
                .map(replacement_workspace)
                .transpose()
            {
                Ok(value) => value,
                Err(error) => return milestone2::domain_failure(id, &error),
            };
            let (replacement, options) = prepared.map_or_else(
                || (None, LaunchOptions::default()),
                |(workspace, tab_id, command)| {
                    let options = command.map_or_else(LaunchOptions::default, |command| {
                        LaunchOptions::default().with_command(tab_id, command)
                    });
                    (Some(workspace), options)
                },
            );
            let response = idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                options,
                move |state| state.close_selected_workspaces(replacement.clone()),
            )
            .await;
            if response.ok {
                context.prune_ephemeral_workspace_state().await;
            }
            response
        }
        "workspace.reorder" => {
            let Ok(params) = parse::<WorkspaceCanonicalMoveParams>(&id, params) else {
                return invalid_params(id);
            };
            let workspace_id = workspace_id(&params.workspace_id);
            let destination = params.destination_index as usize;
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.move_workspace(workspace_id, destination),
            )
            .await
        }
        "group.create" => {
            let Ok(params) = parse::<GroupCreateParams>(&id, params) else {
                return invalid_params(id);
            };
            let group_id = group_id(&params.group_id);
            let name = params.name.clone();
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.create_workspace_group(group_id, name.clone()),
            )
            .await
        }
        "group.rename" => {
            let Ok(params) = parse::<GroupRenameParams>(&id, params) else {
                return invalid_params(id);
            };
            let group_id = group_id(&params.group_id);
            let name = params.name.clone();
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.rename_workspace_group(group_id, name.clone()),
            )
            .await
        }
        "group.delete" => {
            let Ok(params) = parse::<GroupDeleteParams>(&id, params) else {
                return invalid_params(id);
            };
            let group_id = group_id(&params.group_id);
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.delete_workspace_group(group_id),
            )
            .await
        }
        "group.move" => {
            let Ok(params) = parse::<GroupMoveParams>(&id, params) else {
                return invalid_params(id);
            };
            let group_id = group_id(&params.group_id);
            let destination = params.destination_index as usize;
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.move_workspace_group(group_id, destination),
            )
            .await
        }
        "group.assign" => {
            let Ok(params) = parse::<GroupAssignParams>(&id, params) else {
                return invalid_params(id);
            };
            let workspace_id = workspace_id(&params.workspace_id);
            let group_id = params.group_id.as_deref().map(group_id);
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.assign_workspace_group(workspace_id, group_id),
            )
            .await
        }
        "group.collapse" => {
            let Ok(params) = parse::<GroupCollapseParams>(&id, params) else {
                return invalid_params(id);
            };
            let group_id = group_id(&params.group_id);
            let collapsed = params.collapsed;
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                LaunchOptions::default(),
                move |state| state.set_workspace_group_collapsed(group_id, collapsed),
            )
            .await
        }
        _ => {
            ResponseEnvelope::failure(id, "unknown_command", format!("Unknown command: {command}"))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn idempotent_mutation<P, F>(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    store: Arc<agent_workspace_storage::SqliteStateStore>,
    params: &P,
    expected_revision: u64,
    idempotency_key: &str,
    options: LaunchOptions,
    mutation: F,
) -> ResponseEnvelope
where
    P: Serialize,
    F: Fn(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + Sync + 'static,
{
    let request_json = serde_json::to_string(params).expect("validated request serializes");
    match load_idempotency(
        Arc::clone(&store),
        idempotency_key.to_owned(),
        request_json.clone(),
    )
    .await
    {
        Ok(IdempotencyLookup::Replay(result)) => return replay_response(id, &result),
        Ok(IdempotencyLookup::Conflict) => return idempotency_conflict(id),
        Ok(IdempotencyLookup::Missing) => {}
        Err(()) => {
            return ResponseEnvelope::failure(
                id,
                "storage_failure",
                "The idempotency result could not be loaded",
            );
        }
    }
    let mut candidate = runtime.snapshot().await;
    if candidate.revision != expected_revision {
        return ResponseEnvelope::failure(
            id,
            "revision_conflict",
            "The expected revision does not match durable state",
        );
    }
    let mutation = Arc::new(mutation);
    if let Err(error) = mutation(&mut candidate) {
        return milestone2::domain_failure(id, &error);
    }
    let result = MutationResult {
        revision: candidate.revision,
        snapshot: milestone2::application_snapshot(&candidate),
    };
    let result_json = serde_json::to_string(&result).expect("mutation result serializes");
    let request = IdempotencySaveRequest {
        namespace: ORGANIZATION_NAMESPACE.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        request_json,
        result_json,
        retention_capacity: IDEMPOTENCY_RETENTION,
    };
    let apply = Arc::clone(&mutation);
    match runtime
        .mutate_lifecycle_idempotent(expected_revision, request, options, move |state| {
            apply(state)
        })
        .await
    {
        Ok(IdempotentCommitResult::Committed(commit)) => {
            let revision = commit.snapshot.revision;
            ResponseEnvelope::success_at_revision(
                id,
                revision,
                serde_json::to_value(MutationResult {
                    revision,
                    snapshot: milestone2::application_snapshot(&commit.snapshot),
                })
                .expect("mutation result serializes"),
            )
        }
        Ok(IdempotentCommitResult::Replay(result)) => replay_response(id, &result),
        Ok(IdempotentCommitResult::Conflict) => idempotency_conflict(id),
        Err(error) => {
            if runtime.snapshot().await.revision == expected_revision {
                milestone2::operation_failure(id, &error)
            } else {
                ResponseEnvelope::failure(
                    id,
                    "revision_conflict",
                    "The expected revision does not match durable state",
                )
            }
        }
    }
}

async fn load_idempotency(
    store: Arc<agent_workspace_storage::SqliteStateStore>,
    key: String,
    request_json: String,
) -> Result<IdempotencyLookup, ()> {
    tokio::task::spawn_blocking(move || {
        store.load_idempotency_result(ORGANIZATION_NAMESPACE, &key, &request_json)
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

fn replay_response(id: String, result: &str) -> ResponseEnvelope {
    match serde_json::from_str::<MutationResult>(result) {
        Ok(result) => ResponseEnvelope::success_at_revision(
            id,
            result.revision,
            serde_json::to_value(result).expect("replay result serializes"),
        ),
        Err(_) => {
            ResponseEnvelope::failure(id, "storage_failure", "The idempotency result is invalid")
        }
    }
}

fn idempotency_conflict(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "idempotency_conflict",
        "The idempotency key was already used for another request",
    )
}

pub(super) fn organization_snapshot(state: &ApplicationState) -> WorkspaceOrganizationSnapshot {
    WorkspaceOrganizationSnapshot {
        revision: state.revision,
        selection: state
            .workspace_selection
            .iter()
            .map(ToString::to_string)
            .collect(),
        focused_workspace_id: state.selected_workspace_id.to_string(),
        pins: state
            .workspace_pins
            .iter()
            .map(ToString::to_string)
            .collect(),
        groups: state
            .workspace_groups
            .iter()
            .map(|group| WorkspaceGroupSnapshot {
                id: group.id.to_string(),
                name: group.name.clone(),
                collapsed: group.collapsed,
                order: group.order,
            })
            .collect(),
        assignments: state
            .workspace_group_assignments
            .iter()
            .map(|(workspace_id, group_id)| WorkspaceGroupAssignment {
                workspace_id: workspace_id.to_string(),
                group_id: group_id.to_string(),
            })
            .collect(),
        legacy_over_limit: state.legacy_over_limit.as_ref().map(|legacy| {
            let workspace_count = u64::try_from(legacy.workspace_count).unwrap_or(u64::MAX);
            let maximum_panes_in_workspace =
                u64::try_from(legacy.maximum_panes_in_workspace).unwrap_or(u64::MAX);
            let maximum_tabs_in_workspace =
                u64::try_from(legacy.maximum_tabs_in_workspace).unwrap_or(u64::MAX);
            let total_pane_count = u64::try_from(legacy.total_pane_count).unwrap_or(u64::MAX);
            let total_tab_count = u64::try_from(legacy.total_tab_count).unwrap_or(u64::MAX);
            let exceeded_dimensions = [
                (
                    legacy.workspace_count > 128,
                    LegacyLimitDimension::Workspaces,
                ),
                (
                    legacy.maximum_panes_in_workspace > 64,
                    LegacyLimitDimension::PanesPerWorkspace,
                ),
                (
                    legacy.maximum_tabs_in_workspace > 128,
                    LegacyLimitDimension::TabsPerWorkspace,
                ),
                (
                    legacy.total_pane_count > 1_024,
                    LegacyLimitDimension::TotalPanes,
                ),
                (
                    legacy.total_tab_count > 2_048,
                    LegacyLimitDimension::TotalTabs,
                ),
            ]
            .into_iter()
            .filter_map(|(exceeded, dimension)| exceeded.then_some(dimension))
            .collect();
            LegacyOverLimitSnapshot {
                workspace_count,
                maximum_panes_in_workspace,
                maximum_tabs_in_workspace,
                total_pane_count,
                total_tab_count,
                exceeded_dimensions,
            }
        }),
    }
}

fn replacement_workspace(
    params: &agent_workspace_protocol::WorkspaceCreateParams,
) -> Result<(Workspace, TabId, Option<Vec<String>>), DomainError> {
    let workspace_id = WorkspaceId::new();
    let pane_id = PaneId::new();
    let tab_id = TabId::new();
    let at = now();
    let launch = TerminalLaunchSpec::new(
        params.initial_terminal.cwd.clone().into(),
        None,
        params.initial_terminal.rows,
        params.initial_terminal.cols,
    )?;
    let mut workspace = Workspace::new(
        workspace_id,
        params.name.clone(),
        params.working_directory.clone().into(),
        pane_id,
        Tab::terminal(tab_id, pane_id, "Terminal", launch, None, at)?,
        at,
        at,
    )?;
    workspace.description.clone_from(&params.description);
    workspace.color.clone_from(&params.color);
    workspace.validate()?;
    Ok((workspace, tab_id, params.initial_terminal.command.clone()))
}

#[allow(clippy::result_large_err)]
fn parse<T: DeserializeOwned>(id: &str, params: serde_json::Value) -> Result<T, ResponseEnvelope> {
    serde_json::from_value(params).map_err(|_| invalid_params(id.to_owned()))
}

fn invalid_params(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "invalid_params",
        "The request parameters do not match the command contract",
    )
}

fn workspace_id(value: &str) -> WorkspaceId {
    WorkspaceId::from_uuid(Uuid::parse_str(value).expect("protocol validates UUID"))
}

fn group_id(value: &str) -> GroupId {
    GroupId::from_uuid(Uuid::parse_str(value).expect("protocol validates UUID"))
}

fn now() -> Timestamp {
    use std::time::{SystemTime, UNIX_EPOCH};
    Timestamp(
        u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |value| value.as_millis()),
        )
        .unwrap_or(9_007_199_254_740_991)
        .min(9_007_199_254_740_991),
    )
}

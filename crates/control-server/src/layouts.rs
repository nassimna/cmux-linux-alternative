//! Capability-gated M2 saved-layout dispatch.

use std::{path::PathBuf, sync::Arc};

use agent_workspace_core::{
    ApplicationState, DomainError, LayoutExportEnvelope as CoreLayoutExportEnvelope, LayoutId,
    LayoutTemplate, MutationOutcome, SavedLayout, Timestamp, WorkspaceId,
};
use agent_workspace_protocol::{
    EmptyParams, LayoutApplyParams, LayoutDeleteParams, LayoutExportEnvelope, LayoutExportParams,
    LayoutExportResult, LayoutGetParams, LayoutGetResult, LayoutImportParams, LayoutListResult,
    LayoutMutationResult, LayoutSaveParams, LayoutTemplateSnapshot, ResponseEnvelope,
    SavedLayoutSnapshot, SavedLayoutSummary,
};
use agent_workspace_runtime::{
    IdempotentCommitResult, LaunchOptions, ProductionWorkspaceRuntime,
    verify_saved_layout_export_paths,
};
use agent_workspace_storage::{IdempotencyLookup, IdempotencySaveRequest};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::{ControlContext, milestone2};

const LAYOUT_NAMESPACE: &str = "saved-layouts-v1";
const IDEMPOTENCY_RETENTION: usize = 256;

pub(super) fn is_command(command: &str) -> bool {
    matches!(
        command,
        "layout.list"
            | "layout.get"
            | "layout.save"
            | "layout.delete"
            | "layout.apply"
            | "layout.export"
            | "layout.import"
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
            "The saved-layout capability is unavailable",
        );
    };
    match command {
        "layout.list" => {
            if parse::<EmptyParams>(params).is_err() {
                return invalid_params(id);
            }
            let state = runtime.snapshot().await;
            success(
                id,
                state.revision,
                LayoutListResult {
                    revision: state.revision,
                    layouts: state.saved_layouts.iter().map(layout_summary).collect(),
                },
            )
        }
        "layout.get" => {
            let Ok(params) = parse::<LayoutGetParams>(params) else {
                return invalid_params(id);
            };
            let state = runtime.snapshot().await;
            let target = layout_id(&params.layout_id);
            let Some(layout) = state
                .saved_layouts
                .iter()
                .find(|layout| layout.id == target)
            else {
                return ResponseEnvelope::failure(
                    id,
                    "layout_not_found",
                    "The saved layout does not exist",
                );
            };
            match layout_snapshot(layout) {
                Ok(layout) => success(
                    id,
                    state.revision,
                    LayoutGetResult {
                        revision: state.revision,
                        layout,
                    },
                ),
                Err(error) => milestone2::domain_failure(id, &error),
            }
        }
        "layout.export" => {
            let Ok(params) = parse::<LayoutExportParams>(params) else {
                return invalid_params(id);
            };
            let state = runtime.snapshot().await;
            let target = layout_id(&params.layout_id);
            if let Err(error) =
                verify_saved_layout_export_paths(&state, target, &authorized_roots(&state))
            {
                return milestone2::domain_failure(id, &error);
            }
            let envelope = match state.export_saved_layout(target) {
                Ok(value) => value,
                Err(error) => return milestone2::domain_failure(id, &error),
            };
            match convert::<_, LayoutExportEnvelope>(&envelope) {
                Ok(envelope) => success(id, state.revision, LayoutExportResult { envelope }),
                Err(error) => milestone2::domain_failure(id, &error),
            }
        }
        "layout.save" => {
            let Ok(params) = parse::<LayoutSaveParams>(params) else {
                return invalid_params(id);
            };
            let ids = params
                .workspace_ids
                .iter()
                .map(|id| workspace_id(id))
                .collect::<Vec<_>>();
            let target = layout_id(&params.layout_id);
            let name = params.name.clone();
            let at = now();
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                move |state| {
                    let workspaces = ids
                        .iter()
                        .map(|id| {
                            state
                                .workspaces
                                .iter()
                                .find(|workspace| workspace.id == *id)
                                .cloned()
                                .ok_or(DomainError::WorkspaceNotFound { id: *id })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let template = LayoutTemplate::from_live_workspaces(&workspaces)?;
                    if let Some(existing) = state
                        .saved_layouts
                        .iter()
                        .find(|layout| layout.id == target)
                        && existing.name == name
                        && existing.template == template
                    {
                        return state.save_layout(existing.clone());
                    }
                    let created_at = state
                        .saved_layouts
                        .iter()
                        .find(|layout| layout.id == target)
                        .map_or(at, |layout| layout.created_at);
                    state.save_layout(SavedLayout::new(
                        target,
                        name.clone(),
                        template,
                        created_at,
                        at,
                    )?)
                },
            )
            .await
        }
        "layout.delete" => {
            let Ok(params) = parse::<LayoutDeleteParams>(params) else {
                return invalid_params(id);
            };
            let target = layout_id(&params.layout_id);
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                move |state| state.delete_saved_layout(target),
            )
            .await
        }
        "layout.import" => {
            let Ok(params) = parse::<LayoutImportParams>(params) else {
                return invalid_params(id);
            };
            let envelope = match convert::<_, CoreLayoutExportEnvelope>(&params.envelope) {
                Ok(value) => value,
                Err(error) => return milestone2::domain_failure(id, &error),
            };
            let target = layout_id(&params.layout_id);
            let at = now();
            idempotent_mutation(
                id,
                runtime,
                Arc::clone(&persistence.state_store),
                &params,
                params.expected_revision,
                &params.idempotency_key,
                move |state| state.import_saved_layout(envelope.clone(), target, at, at),
            )
            .await
        }
        "layout.apply" => {
            let Ok(params) = parse::<LayoutApplyParams>(params) else {
                return invalid_params(id);
            };
            let response =
                apply_layout(id, runtime, Arc::clone(&persistence.state_store), &params).await;
            if response.ok {
                context.prune_ephemeral_workspace_state().await;
            }
            response
        }
        _ => {
            ResponseEnvelope::failure(id, "unknown_command", format!("Unknown command: {command}"))
        }
    }
}

async fn idempotent_mutation<P, F>(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    store: Arc<agent_workspace_storage::SqliteStateStore>,
    params: &P,
    expected_revision: u64,
    idempotency_key: &str,
    mutation: F,
) -> ResponseEnvelope
where
    P: Serialize,
    F: Fn(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + Sync + 'static,
{
    let request_json = serde_json::to_string(params).expect("validated request serializes");
    if let Some(response) = prelookup(&id, Arc::clone(&store), idempotency_key, &request_json).await
    {
        return response;
    }
    let mut candidate = runtime.snapshot().await;
    if candidate.revision != expected_revision {
        return revision_conflict(id);
    }
    let mutation = Arc::new(mutation);
    if let Err(error) = mutation(&mut candidate) {
        return milestone2::domain_failure(id, &error);
    }
    let result = LayoutMutationResult {
        revision: candidate.revision,
    };
    let request = save_request(idempotency_key, request_json, &result);
    let apply = Arc::clone(&mutation);
    match runtime
        .mutate_lifecycle_idempotent(
            expected_revision,
            request,
            LaunchOptions::default(),
            move |state| apply(state),
        )
        .await
    {
        Ok(IdempotentCommitResult::Committed(commit)) => success(
            id,
            commit.snapshot.revision,
            LayoutMutationResult {
                revision: commit.snapshot.revision,
            },
        ),
        Ok(IdempotentCommitResult::Replay(result)) => replay_response(id, &result),
        Ok(IdempotentCommitResult::Conflict) => idempotency_conflict(id),
        Err(error) => serialized_operation_failure(id, runtime, expected_revision, &error).await,
    }
}

async fn apply_layout(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    store: Arc<agent_workspace_storage::SqliteStateStore>,
    params: &LayoutApplyParams,
) -> ResponseEnvelope {
    let request_json = serde_json::to_string(params).expect("validated request serializes");
    if let Some(response) = prelookup(&id, store, &params.idempotency_key, &request_json).await {
        return response;
    }
    let mut candidate = runtime.snapshot().await;
    if candidate.revision != params.expected_revision {
        return revision_conflict(id);
    }
    // Trust roots are server-derived from the currently open application state, never supplied by
    // renderer or CLI input. Runtime preflight canonicalizes both roots and launch paths.
    let roots = authorized_roots(&candidate);
    let target = layout_id(&params.layout_id);
    let plan = match candidate.plan_saved_layout_application(target, &roots) {
        Ok(value) => value,
        Err(error) => return milestone2::domain_failure(id, &error),
    };
    if let Err(error) = candidate.apply_layout_plan(plan) {
        return milestone2::domain_failure(id, &error);
    }
    let result = LayoutMutationResult {
        revision: candidate.revision,
    };
    let request = save_request(&params.idempotency_key, request_json, &result);
    match runtime
        .apply_saved_layout_idempotent(
            params.expected_revision,
            request,
            target,
            roots,
            LaunchOptions::default(),
        )
        .await
    {
        Ok(IdempotentCommitResult::Committed(commit)) => success(
            id,
            commit.snapshot.revision,
            LayoutMutationResult {
                revision: commit.snapshot.revision,
            },
        ),
        Ok(IdempotentCommitResult::Replay(result)) => replay_response(id, &result),
        Ok(IdempotentCommitResult::Conflict) => idempotency_conflict(id),
        Err(error) => {
            serialized_operation_failure(id, runtime, params.expected_revision, &error).await
        }
    }
}

async fn serialized_operation_failure(
    id: String,
    runtime: &Arc<ProductionWorkspaceRuntime>,
    expected_revision: u64,
    error: &agent_workspace_runtime::OperationFailure,
) -> ResponseEnvelope {
    if runtime.snapshot().await.revision == expected_revision {
        milestone2::operation_failure(id, error)
    } else {
        revision_conflict(id)
    }
}

async fn prelookup(
    id: &str,
    store: Arc<agent_workspace_storage::SqliteStateStore>,
    key: &str,
    request_json: &str,
) -> Option<ResponseEnvelope> {
    let key = key.to_owned();
    let request_json = request_json.to_owned();
    let lookup = tokio::task::spawn_blocking(move || {
        store.load_idempotency_result(LAYOUT_NAMESPACE, &key, &request_json)
    })
    .await;
    match lookup {
        Ok(Ok(IdempotencyLookup::Missing)) => None,
        Ok(Ok(IdempotencyLookup::Replay(result))) => Some(replay_response(id.to_owned(), &result)),
        Ok(Ok(IdempotencyLookup::Conflict)) => Some(idempotency_conflict(id.to_owned())),
        _ => Some(ResponseEnvelope::failure(
            id.to_owned(),
            "storage_failure",
            "The idempotency result could not be loaded",
        )),
    }
}

fn save_request(
    key: &str,
    request_json: String,
    result: &LayoutMutationResult,
) -> IdempotencySaveRequest {
    IdempotencySaveRequest {
        namespace: LAYOUT_NAMESPACE.to_owned(),
        idempotency_key: key.to_owned(),
        request_json,
        result_json: serde_json::to_string(result).expect("layout result serializes"),
        retention_capacity: IDEMPOTENCY_RETENTION,
    }
}

fn replay_response(id: String, result: &str) -> ResponseEnvelope {
    match serde_json::from_str::<LayoutMutationResultWire>(result) {
        Ok(result) => success(
            id,
            result.revision,
            LayoutMutationResult {
                revision: result.revision,
            },
        ),
        Err(_) => {
            ResponseEnvelope::failure(id, "storage_failure", "The idempotency result is invalid")
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayoutMutationResultWire {
    revision: u64,
}

fn layout_summary(layout: &SavedLayout) -> SavedLayoutSummary {
    SavedLayoutSummary {
        id: layout.id.to_string(),
        name: layout.name.clone(),
        format_version: layout.format_version,
        created_at: layout.created_at.0,
        updated_at: layout.updated_at.0,
        workspace_count: u32::try_from(layout.template.workspaces.len()).unwrap_or(u32::MAX),
    }
}

fn layout_snapshot(layout: &SavedLayout) -> Result<SavedLayoutSnapshot, DomainError> {
    Ok(SavedLayoutSnapshot {
        id: layout.id.to_string(),
        name: layout.name.clone(),
        format_version: layout.format_version,
        created_at: layout.created_at.0,
        updated_at: layout.updated_at.0,
        template: convert::<_, LayoutTemplateSnapshot>(&layout.template)?,
    })
}

fn convert<T: Serialize, U: DeserializeOwned>(value: &T) -> Result<U, DomainError> {
    serde_json::from_value(serde_json::to_value(value).map_err(invalid_conversion)?)
        .map_err(invalid_conversion)
}
#[allow(clippy::needless_pass_by_value)]
fn invalid_conversion(error: serde_json::Error) -> DomainError {
    DomainError::InvalidState {
        message: error.to_string(),
    }
}
fn authorized_roots(state: &ApplicationState) -> Vec<PathBuf> {
    state
        .workspaces
        .iter()
        .map(|workspace| workspace.working_directory.clone())
        .collect()
}
fn success(id: String, revision: u64, result: impl Serialize) -> ResponseEnvelope {
    ResponseEnvelope::success_at_revision(
        id,
        revision,
        serde_json::to_value(result).expect("layout response serializes"),
    )
}
fn parse<T: DeserializeOwned>(params: serde_json::Value) -> Result<T, serde_json::Error> {
    serde_json::from_value(params)
}
fn invalid_params(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "invalid_params",
        "The request parameters do not match the command contract",
    )
}
fn revision_conflict(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "revision_conflict",
        "The expected revision does not match durable state",
    )
}
fn idempotency_conflict(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "idempotency_conflict",
        "The idempotency key was already used for another request",
    )
}
fn layout_id(value: &str) -> LayoutId {
    LayoutId::from_uuid(Uuid::parse_str(value).expect("protocol validates UUID"))
}
fn workspace_id(value: &str) -> WorkspaceId {
    WorkspaceId::from_uuid(Uuid::parse_str(value).expect("protocol validates UUID"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_config::ConfigStore;
    use agent_workspace_core::{ShortcutPlatform, WorkspaceUpdate};
    use agent_workspace_runtime::{BootstrapConfig, TerminalManagerBackend};
    use agent_workspace_storage::SqliteStateStore;
    use agent_workspace_terminal_runtime::TerminalManager;
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::time::{Duration, timeout};

    use crate::{ControlContext, PersistenceServices, TerminalLifecycle};

    struct Harness {
        temp: TempDir,
        context: ControlContext,
    }

    impl Harness {
        async fn new() -> Self {
            let temp = TempDir::new().expect("temporary directory must exist");
            let state_store = Arc::new(
                SqliteStateStore::open(
                    temp.path().join("state.sqlite3"),
                    ShortcutPlatform::NonMacOs,
                )
                .expect("test state store must open"),
            );
            let config_store = Arc::new(ConfigStore::new(temp.path().join("config.json")));
            let terminals = TerminalManager::new();
            let backend = Arc::new(TerminalManagerBackend::new(terminals));
            let bootstrap =
                BootstrapConfig::for_service(temp.path().to_path_buf(), Timestamp(1), 24, 80)
                    .expect("bootstrap config must be valid");
            let runtime = Arc::new(
                ProductionWorkspaceRuntime::bootstrap(
                    Arc::clone(&state_store),
                    Arc::clone(&backend),
                    bootstrap,
                )
                .await
                .expect("runtime must bootstrap"),
            );
            let context = ControlContext {
                terminal_io: backend.terminal_io().clone(),
                terminal_backend: Some((*backend).clone()),
                logging_runtime: None,
                terminal_lifecycle: TerminalLifecycle::WorkspaceManaged,
                runtime: Some(runtime),
                persistence: Some(PersistenceServices::new(config_store, state_store)),
                card_slots: Some(crate::card_slots::CardSlotRuntime::new()),
                card_slots_v2: Some(crate::card_slots::CardSlotV2Runtime::new()),
                attention: None,
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: None,
                platform: ShortcutPlatform::NonMacOs,
            };
            Self { temp, context }
        }

        async fn shutdown(&self) {
            self.context
                .runtime
                .as_ref()
                .expect("runtime")
                .shutdown()
                .await
                .expect("runtime shutdown must complete");
        }
    }

    fn error_code(response: &ResponseEnvelope) -> Option<&str> {
        response.error.as_ref().map(|error| error.code.as_str())
    }

    async fn create_workspace(harness: &Harness, name: &str) -> String {
        let response = milestone2::dispatch(
            "create-workspace".to_owned(),
            "workspace.create",
            json!({
                "name": name,
                "workingDirectory": harness.temp.path(),
                "initialTerminal": {
                    "cwd": harness.temp.path(),
                    "command": ["/bin/sh"],
                    "rows": 24,
                    "cols": 80
                }
            }),
            &harness.context,
        )
        .await;
        assert!(response.ok, "workspace create failed: {:?}", response.error);
        harness
            .context
            .runtime
            .as_ref()
            .unwrap()
            .snapshot()
            .await
            .selected_workspace_id
            .to_string()
    }

    async fn seed_card_slots(harness: &Harness, workspace_id: &str) {
        let legacy = crate::card_slots::dispatch(
            "seed-legacy-card".to_owned(),
            "workspace.cardSlots.replace",
            json!({
                "workspaceId": workspace_id,
                "expectedRevision": 0,
                "agentStatus": { "status": "running", "label": "Working" },
                "progress": null
            }),
            &harness.context,
        )
        .await;
        assert!(legacy.ok, "legacy card seed failed: {:?}", legacy.error);
        let rich = crate::card_slots::dispatch_v2(
            "seed-rich-card".to_owned(),
            "workspace.cardSlots.v2.replace",
            json!({
                "workspaceId": workspace_id,
                "kind": "agentStatus",
                "expectedRevision": 0,
                "payload": {
                    "kind": "agentStatus",
                    "value": { "status": "running", "label": "Working" }
                }
            }),
            &harness.context,
        )
        .await;
        assert!(rich.ok, "rich card seed failed: {:?}", rich.error);
        assert!(
            harness
                .context
                .card_slots
                .as_ref()
                .unwrap()
                .contains_workspace(workspace_id)
                .await
        );
        assert!(
            harness
                .context
                .card_slots_v2
                .as_ref()
                .unwrap()
                .contains_workspace(workspace_id)
                .await
        );
    }

    async fn assert_card_slots_pruned(harness: &Harness, workspace_id: &str) {
        assert!(
            !harness
                .context
                .card_slots
                .as_ref()
                .unwrap()
                .contains_workspace(workspace_id)
                .await
        );
        assert!(
            !harness
                .context
                .card_slots_v2
                .as_ref()
                .unwrap()
                .contains_workspace(workspace_id)
                .await
        );
    }

    #[tokio::test]
    async fn batch_close_prunes_all_card_slot_generations() {
        let harness = Harness::new().await;
        let workspace_id = create_workspace(&harness, "Disposable").await;
        seed_card_slots(&harness, &workspace_id).await;
        let revision = harness
            .context
            .runtime
            .as_ref()
            .unwrap()
            .snapshot()
            .await
            .revision;
        let response = crate::organization::dispatch(
            "batch-close".to_owned(),
            "workspace.closeSelected",
            json!({
                "expectedRevision": revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        )
        .await;
        assert!(response.ok, "batch close failed: {:?}", response.error);
        assert_card_slots_pruned(&harness, &workspace_id).await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn layout_apply_prunes_all_card_slot_generations() {
        let harness = Harness::new().await;
        let initial = harness.context.runtime.as_ref().unwrap().snapshot().await;
        let layout_id = Uuid::new_v4();
        let saved = dispatch(
            "save-for-prune".to_owned(),
            "layout.save",
            json!({
                "layoutId": layout_id,
                "name": "without disposable workspace",
                "workspaceIds": [initial.workspaces[0].id],
                "expectedRevision": initial.revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        )
        .await;
        assert!(saved.ok, "layout save failed: {:?}", saved.error);
        let workspace_id = create_workspace(&harness, "Disposable").await;
        seed_card_slots(&harness, &workspace_id).await;
        let revision = harness
            .context
            .runtime
            .as_ref()
            .unwrap()
            .snapshot()
            .await
            .revision;
        let applied = dispatch(
            "apply-for-prune".to_owned(),
            "layout.apply",
            json!({
                "layoutId": layout_id,
                "expectedRevision": revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        )
        .await;
        assert!(applied.ok, "layout apply failed: {:?}", applied.error);
        assert_card_slots_pruned(&harness, &workspace_id).await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn close_serializes_with_v2_replace_before_existence_validation() {
        let harness = Harness::new().await;
        let workspace_id = create_workspace(&harness, "Concurrent close").await;
        let card_slots = harness.context.card_slots_v2.as_ref().unwrap().clone();
        let (replace_locked, release_replace) =
            card_slots.install_replace_after_lock_barriers().await;
        let replace_context = harness.context.clone();
        let replace_workspace_id = workspace_id.clone();
        let replace = tokio::spawn(async move {
            crate::card_slots::dispatch_v2(
                "concurrent-replace".to_owned(),
                "workspace.cardSlots.v2.replace",
                json!({
                    "workspaceId": replace_workspace_id,
                    "kind": "agentStatus",
                    "expectedRevision": 0,
                    "payload": {
                        "kind": "agentStatus",
                        "value": { "status": "running", "label": "Must not survive" }
                    }
                }),
                &replace_context,
            )
            .await
        });
        replace_locked.wait().await;

        let close_context = harness.context.clone();
        let close_workspace_id = workspace_id.clone();
        let close = tokio::spawn(async move {
            milestone2::dispatch(
                "concurrent-close".to_owned(),
                "workspace.close",
                json!({ "workspaceId": close_workspace_id }),
                &close_context,
            )
            .await
        });
        let runtime = harness.context.runtime.as_ref().unwrap();
        timeout(Duration::from_secs(5), async {
            loop {
                let removed = !runtime
                    .snapshot()
                    .await
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.id.to_string() == workspace_id);
                if removed {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("workspace close did not reach its committed state before the timeout");
        release_replace.wait().await;

        let replace = replace.await.expect("replace task must complete");
        let close = close.await.expect("close task must complete");
        assert_eq!(error_code(&replace), Some("workspace_not_found"));
        assert!(close.ok, "workspace close failed: {:?}", close.error);
        assert_card_slots_pruned(&harness, &workspace_id).await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn stale_slot_sweep_never_deletes_a_concurrently_created_workspace() {
        let harness = Harness::new().await;
        let card_slots = harness.context.card_slots_v2.as_ref().unwrap().clone();
        let (slot_ids_sampled, release_sweep) = card_slots
            .install_workspace_ids_after_snapshot_barriers()
            .await;
        let sweep_context = harness.context.clone();
        let sweep = tokio::spawn(async move {
            sweep_context.prune_ephemeral_workspace_state().await;
        });
        slot_ids_sampled.wait().await;

        let workspace_id = create_workspace(&harness, "Concurrent create").await;
        seed_card_slots(&harness, &workspace_id).await;
        release_sweep.wait().await;
        sweep.await.expect("stale slot sweep must complete");

        assert!(
            harness
                .context
                .card_slots
                .as_ref()
                .unwrap()
                .contains_workspace(&workspace_id)
                .await
        );
        assert!(
            harness
                .context
                .card_slots_v2
                .as_ref()
                .unwrap()
                .contains_workspace(&workspace_id)
                .await
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn layout_export_uses_the_strict_camel_case_pane_tree_contract() {
        let harness = Harness::new().await;
        let state = harness.context.runtime.as_ref().unwrap().snapshot().await;
        let layout_id = Uuid::new_v4();
        let saved = dispatch(
            "save".to_owned(),
            "layout.save",
            json!({
                "layoutId": layout_id,
                "name": "portable",
                "workspaceIds": [state.workspaces[0].id],
                "expectedRevision": state.revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        )
        .await;
        assert!(saved.ok, "layout save failed: {:?}", saved.error);

        let exported = dispatch(
            "export".to_owned(),
            "layout.export",
            json!({ "layoutId": layout_id }),
            &harness.context,
        )
        .await;
        assert!(exported.ok, "layout export failed: {:?}", exported.error);
        let result = exported.result.expect("layout export result");
        let tree = &result["envelope"]["template"]["workspaces"][0]["layout"];
        assert!(tree.get("paneId").is_some());
        assert!(tree.get("pane_id").is_none());
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_generic_layout_mutations_have_one_stable_revision_conflict() {
        let harness = Harness::new().await;
        let state = harness.context.runtime.as_ref().unwrap().snapshot().await;
        let workspace_id = state.workspaces[0].id.to_string();
        let save = |id: &'static str, name: &'static str| {
            dispatch(
                id.to_owned(),
                "layout.save",
                json!({
                    "layoutId": Uuid::new_v4(),
                    "name": name,
                    "workspaceIds": [workspace_id],
                    "expectedRevision": state.revision,
                    "idempotencyKey": Uuid::new_v4()
                }),
                &harness.context,
            )
        };
        let (first, second) = tokio::join!(save("first", "first"), save("second", "second"));
        let responses = [first, second];
        assert_eq!(responses.iter().filter(|response| response.ok).count(), 1);
        let success = responses.iter().find(|response| response.ok).unwrap();
        assert_eq!(
            success.revision,
            success
                .result
                .as_ref()
                .and_then(|result| result["revision"].as_u64())
        );
        assert_eq!(
            responses
                .iter()
                .filter(|response| error_code(response) == Some("revision_conflict"))
                .count(),
            1
        );
        let final_state = harness.context.runtime.as_ref().unwrap().snapshot().await;
        assert_eq!(final_state.revision, state.revision + 1);
        assert_eq!(final_state.saved_layouts.len(), 1);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_layout_apply_race_has_one_stable_revision_conflict() {
        let harness = Harness::new().await;
        let runtime = harness.context.runtime.as_ref().unwrap();
        let initial = runtime.snapshot().await;
        let layout_id = Uuid::new_v4();
        let saved = dispatch(
            "save".to_owned(),
            "layout.save",
            json!({
                "layoutId": layout_id,
                "name": "restore",
                "workspaceIds": [initial.workspaces[0].id],
                "expectedRevision": initial.revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        )
        .await;
        assert!(saved.ok, "layout save failed: {:?}", saved.error);

        let workspace_id = initial.workspaces[0].id;
        runtime
            .mutate(LaunchOptions::default(), move |state| {
                state.update_workspace(
                    workspace_id,
                    WorkspaceUpdate {
                        name: Some("changed".to_owned()),
                        ..WorkspaceUpdate::default()
                    },
                    Timestamp(2),
                )
            })
            .await
            .expect("workspace mutation must commit");
        let expected_revision = runtime.snapshot().await.revision;

        let apply = dispatch(
            "apply".to_owned(),
            "layout.apply",
            json!({
                "layoutId": layout_id,
                "expectedRevision": expected_revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        );
        let delete = dispatch(
            "delete".to_owned(),
            "layout.delete",
            json!({
                "layoutId": layout_id,
                "expectedRevision": expected_revision,
                "idempotencyKey": Uuid::new_v4()
            }),
            &harness.context,
        );
        let (apply, delete) = tokio::join!(apply, delete);
        let responses = [apply, delete];
        assert_eq!(responses.iter().filter(|response| response.ok).count(), 1);
        let success = responses.iter().find(|response| response.ok).unwrap();
        assert_eq!(
            success.revision,
            success
                .result
                .as_ref()
                .and_then(|result| result["revision"].as_u64())
        );
        assert_eq!(
            responses
                .iter()
                .filter(|response| error_code(response) == Some("revision_conflict"))
                .count(),
            1
        );
        assert_eq!(runtime.snapshot().await.revision, expected_revision + 1);
        harness.shutdown().await;
    }
}

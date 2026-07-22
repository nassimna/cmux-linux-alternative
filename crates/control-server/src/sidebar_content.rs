//! Dormant M8 service integration over the strict sidebar/content foundations.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use agent_workspace_content::WorkspacePathProvider;
use agent_workspace_content_index::{
    CodexAppServerTranscriptSource, ContentIndex, IndexBudget, TranscriptAdapter,
    TranscriptSourceError, TrustedTranscriptBatch, TrustedTranscriptRequest,
    TrustedTranscriptSource, load_or_create_profile_key, parse_transcript,
};
use agent_workspace_protocol::{
    BoundedListParams, ContentDiffParams, ContentDocumentIssueParams, ContentDocumentIssueResult,
    ContentMarkdownParams, ContentReadParams, ContentSaveParams, ContentSaveResult,
    RecentlyClosedListResult, RecentlyClosedRecord, RecentlyClosedReopenParams, ReopenAction,
    ResponseEnvelope, SafeDiffLine, SafeDiffLineKind, SafeMarkdownDocument, SearchCancelParams,
    SearchCancelResult, SearchControlResult, SearchControlState, SearchExportConfirmation,
    SearchExportConfirmationIssueParams, SearchExportConfirmationIssueResult, SearchExportParams,
    SearchExportResult, SearchQueryParams, SearchQueryResult, SearchRebuildParams, SearchResult,
    SearchSourceKind, SearchSourceMutationParams, SearchSourcePolicyParams, SidebarGetParams,
    SidebarListResult, SidebarSaveParams, TaskActionKind, TaskActionOutcome, TaskActionParams,
    TaskActionResult, TaskConfirmation, TaskConfirmationIssueParams, TaskConfirmationIssueResult,
    TaskKind, TaskLifecycle, TaskListParams, TaskListResult, TaskObservation, TaskSummary,
    TaskTarget, TextBoxCreateParams, TextBoxDeleteParams, TextBoxDocument, TextBoxIdParams,
    TextBoxListResult, TextBoxSaveParams, WorkspaceDirectoryListParams,
};
use agent_workspace_runtime::ProductionWorkspaceRuntime;
use agent_workspace_storage::{
    SidebarContentMutationOutcome, SqliteStateStore, StorageError, TaskConfirmationConsumeOutcome,
};
use agent_workspace_terminal_runtime::TerminalIoHandle;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

const COMMANDS: &[&str] = &[
    "sidebar.placement.list",
    "sidebar.placement.get",
    "sidebar.placement.save",
    "content.root.list",
    "content.directory.list",
    "content.document.issue",
    "content.read",
    "content.save",
    "content.markdown",
    "content.diff",
    "textbox.list",
    "textbox.get",
    "textbox.create",
    "textbox.save",
    "textbox.delete",
    "search.query",
    "search.cancel",
    "search.source.policy",
    "search.source.exclude",
    "search.source.forget",
    "search.source.rebuild",
    "search.source.export.confirmation.issue",
    "search.source.export",
    "task.list",
    "task.confirmation.issue",
    "task.action",
    "recentlyClosed.list",
    "recentlyClosed.reopen",
];

#[derive(Clone)]
pub(super) struct SidebarContentRuntime {
    store: Arc<SqliteStateStore>,
    workspace: Arc<ProductionWorkspaceRuntime>,
    documents: Arc<Mutex<WorkspacePathProvider>>,
    closed_descriptors: Arc<Mutex<HashMap<Uuid, ClosedDescriptor>>>,
    index: Arc<Mutex<Option<ContentIndex>>>,
    transcripts: Arc<dyn TrustedTranscriptSource>,
    agents: Option<super::agent_sessions::AgentSessionControlRuntime>,
    remotes: Option<super::remote_sessions::RemoteSessionControlRuntime>,
    multi_window: Option<super::multi_window::MultiWindowRuntime>,
    profile: Option<std::path::PathBuf>,
    cancellations: Arc<StdMutex<HashMap<Uuid, Arc<AtomicBool>>>>,
    export_confirmations: Arc<StdMutex<HashMap<Uuid, SearchExportConfirmationRecord>>>,
}

#[derive(Clone, Copy)]
struct ClosedDescriptor {
    closed_id: Uuid,
    revision: u64,
    action: ReopenAction,
}

#[derive(Clone, Copy)]
struct SearchExportConfirmationRecord {
    source: Uuid,
    expires_at_ms: i64,
}

impl SidebarContentRuntime {
    pub(super) fn new(
        store: Arc<SqliteStateStore>,
        workspace: Arc<ProductionWorkspaceRuntime>,
        _terminal_io: TerminalIoHandle,
        agents: Option<super::agent_sessions::AgentSessionControlRuntime>,
        remotes: Option<super::remote_sessions::RemoteSessionControlRuntime>,
        multi_window: Option<super::multi_window::MultiWindowRuntime>,
    ) -> Self {
        let profile = store.path().parent().map(std::path::Path::to_path_buf);
        Self {
            store,
            workspace,
            documents: Arc::new(Mutex::new(WorkspacePathProvider::default())),
            closed_descriptors: Arc::new(Mutex::new(HashMap::new())),
            index: Arc::new(Mutex::new(None)),
            transcripts: Arc::new(CodexAppServerTranscriptSource),
            agents,
            remotes,
            multi_window,
            profile,
            cancellations: Arc::new(StdMutex::new(HashMap::new())),
            export_confirmations: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub(super) fn initialize(&self) {
        let _ = self.store.invalidate_pending_task_confirmations(now_ms());
        let runtime = self.clone();
        drop(tokio::task::spawn_blocking(move || {
            let Ok(background) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            background.block_on(runtime.initialize_index());
        }));
    }

    async fn initialize_index(&self) {
        let Some(profile) = &self.profile else {
            return;
        };
        let key = match load_or_create_profile_key(profile).await {
            Ok(key) => key,
            Err(error) => {
                tracing::warn!(?error, "encrypted content index is unavailable");
                return;
            }
        };
        let Ok((_, Some(mut index))) = ContentIndex::open(profile, &key) else {
            tracing::warn!("encrypted content index could not be opened");
            return;
        };
        if index.clear_runtime_bound_documents().is_err() {
            return;
        }
        *self.index.lock().await = Some(index);
    }
}

pub(super) fn is_command(command: &str) -> bool {
    COMMANDS.contains(&command)
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: Value,
    runtime: &SidebarContentRuntime,
) -> ResponseEnvelope {
    match dispatch_inner(command, params, runtime).await {
        Ok(value) => ResponseEnvelope::success(id, value),
        Err(error) => ResponseEnvelope::failure(id, error.code, error.message),
    }
}

#[derive(Clone, Copy, Debug)]
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
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    match command {
        "sidebar.placement.list" => {
            parse::<Empty>(params)?;
            encode(SidebarListResult {
                placements: runtime
                    .store
                    .list_sidebar_placements()
                    .map_err(storage_error)?,
            })
        }
        "sidebar.placement.get" => {
            let params: SidebarGetParams = parse(params)?;
            let id = uuid(&params.window_id)?;
            ensure_window(runtime, id).await?;
            let placement = runtime
                .store
                .load_sidebar_placement(id)
                .map_err(storage_error)?
                .ok_or_else(not_found)?;
            encode(placement)
        }
        "sidebar.placement.save" => save_placement(parse(params)?, runtime).await,
        "content.root.list" => list_content_roots(parse(params)?, runtime).await,
        "content.directory.list" => list_content_directory(parse(params)?, runtime).await,
        "textbox.list" => list_text_boxes(parse(params)?, runtime).await,
        "textbox.get" => {
            let params: TextBoxIdParams = parse(params)?;
            let document = runtime
                .store
                .load_text_box_document(uuid(&params.text_box_document_id)?)
                .map_err(storage_error)?
                .ok_or_else(not_found)?;
            ensure_document_binding(runtime, &document).await?;
            encode(document)
        }
        "textbox.create" => create_text_box(parse(params)?, runtime).await,
        "textbox.save" => save_text_box(parse(params)?, runtime).await,
        "textbox.delete" => delete_text_box(parse(params)?, runtime).await,
        "content.read" => {
            let params: ContentReadParams = parse(params)?;
            sync_content_roots(runtime).await?;
            let provider = runtime.documents.lock().await;
            let display_name = provider
                .document_display_name(&params.document)
                .map_err(|error| content_error(&error))?;
            let preview = content_preview(
                &params.document,
                &display_name,
                provider.read_chunk(
                    &params.document,
                    params.offset,
                    usize::try_from(params.max_bytes).unwrap_or(usize::MAX),
                ),
            )?;
            encode(preview)
        }
        "content.markdown" => {
            let params: ContentMarkdownParams = parse(params)?;
            sync_content_roots(runtime).await?;
            let provider = runtime.documents.lock().await;
            let chunk = provider
                .read_chunk(
                    &params.document,
                    0,
                    agent_workspace_protocol::MAX_CONTENT_CHUNK_BYTES,
                )
                .map_err(|error| content_error(&error))?;
            if !chunk.eof {
                return Err(CommandError::new(
                    "resource_limit",
                    "Markdown preview exceeds the bounded document preview",
                ));
            }
            encode(SafeMarkdownDocument {
                document: chunk.document,
                nodes: agent_workspace_content::parse_safe_markdown(&chunk.text),
                content_revision: chunk.content_revision,
            })
        }
        "content.diff" => diff(parse(params)?, runtime).await,
        "content.document.issue" => issue_content_document(parse(params)?, runtime).await,
        "content.save" => save_content_document(parse(params)?, runtime).await,
        "search.cancel" => {
            let params: SearchCancelParams = parse(params)?;
            encode(SearchCancelResult {
                cancelled: cancel_operation(runtime, uuid(&params.cancellation_id)?),
            })
        }
        "search.query" => search_query(parse(params)?, runtime).await,
        "search.source.policy" => search_source_policy(parse(params)?, runtime).await,
        "search.source.exclude" => search_source_exclude(parse(params)?, runtime).await,
        "search.source.forget" => search_source_forget(parse(params)?, runtime).await,
        "search.source.rebuild" => search_source_rebuild(parse(params)?, runtime).await,
        "search.source.export.confirmation.issue" => {
            search_export_confirmation_issue(parse(params)?, runtime).await
        }
        "search.source.export" => search_source_export(parse(params)?, runtime).await,
        "task.list" => task_list(parse(params)?, runtime),
        "task.confirmation.issue" => task_confirmation_issue(parse(params)?, runtime).await,
        "task.action" => task_action(parse(params)?, runtime).await,
        "recentlyClosed.list" => recently_closed(parse(params)?, runtime).await,
        "recentlyClosed.reopen" => reopen_recently_closed(parse(params)?, runtime).await,
        _ => Err(CommandError::new(
            "unknown_command",
            "Unknown sidebar/content command",
        )),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

async fn save_placement(
    params: SidebarSaveParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let window = uuid(&params.placement.window_id)?;
    ensure_window(runtime, window).await?;
    let result = encode(params.placement.clone())?;
    exact(
        runtime
            .store
            .save_sidebar_placement_exact(
                &params.placement,
                &params.mutation,
                &serde_json::to_string(&result).map_err(|_| internal())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        result,
    )
}

async fn sync_content_roots(runtime: &SidebarContentRuntime) -> Result<(), CommandError> {
    let snapshot = runtime.workspace.snapshot().await;
    let desired = snapshot
        .workspaces
        .iter()
        .map(|workspace| {
            Ok((
                uuid(&workspace.id.to_string())?,
                workspace.working_directory.clone(),
                workspace.name.clone(),
            ))
        })
        .collect::<Result<Vec<_>, CommandError>>()?;
    let (before, after) = {
        let mut provider = runtime.documents.lock().await;
        let before = provider.root_generations();
        provider
            .sync_workspace_roots(&desired)
            .map_err(|error| content_error(&error))?;
        (before, provider.root_generations())
    };
    let mut index_guard = runtime.index.lock().await;
    let Some(index) = index_guard.as_mut() else {
        return Ok(());
    };
    let mut unsafe_index = false;
    for (source, generation) in before {
        match after.iter().find(|(id, _)| *id == source) {
            None => {
                if index.forget_source(source).is_err() {
                    unsafe_index = true;
                    break;
                }
            }
            Some((_, current)) if *current != generation => {
                if let Err(error) = index.rebuild_source(source)
                    && !matches!(
                        error,
                        agent_workspace_content_index::IndexError::Unauthorized
                    )
                {
                    unsafe_index = true;
                    break;
                }
            }
            _ => {}
        }
    }
    if unsafe_index {
        *index_guard = None;
        return Err(CommandError::new(
            "runtime_unavailable",
            "The encrypted search index could not revoke stale source data",
        ));
    }
    Ok(())
}

async fn list_content_roots(
    params: BoundedListParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    sync_content_roots(runtime).await?;
    let provider = runtime.documents.lock().await;
    encode(
        provider
            .list_roots(optional_uuid(params.cursor.as_deref())?, params.limit)
            .map_err(|error| content_error(&error))?,
    )
}

async fn list_content_directory(
    params: WorkspaceDirectoryListParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    sync_content_roots(runtime).await?;
    let cancellation_id = uuid(&params.cancellation_id)?;
    let directory_descriptor_id = uuid(&params.directory_descriptor_id)?;
    let cursor = optional_uuid(params.cursor.as_deref())?;
    let cancellation = begin_operation(runtime, cancellation_id)?;
    let mut provider = runtime.documents.lock().await;
    let result = provider
        .list_directory_with_cancel(
            directory_descriptor_id,
            params.generation,
            cursor,
            params.limit,
            || cancellation.load(Ordering::Relaxed),
        )
        .map_err(|error| content_error(&error));
    end_operation(runtime, cancellation_id);
    encode(result?)
}

async fn issue_content_document(
    params: ContentDocumentIssueParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    sync_content_roots(runtime).await?;
    let mut provider = runtime.documents.lock().await;
    let (document, display_name) = provider
        .issue_document_from_descriptor(
            uuid(&params.authorized_descriptor_id)?,
            params.descriptor_generation,
            params.expected_kind,
        )
        .map_err(|error| content_error(&error))?;
    encode(ContentDocumentIssueResult {
        document,
        display_name,
    })
}

async fn save_content_document(
    params: ContentSaveParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    if params.expected_revision != params.mutation.expected_revision {
        return Err(CommandError::new(
            "stale_revision",
            "The document revision changed",
        ));
    }
    sync_content_roots(runtime).await?;
    let mut provider = runtime.documents.lock().await;
    let content_revision = provider
        .save(&params.document, params.expected_revision, &params.text)
        .map_err(|error| content_error(&error))?;
    let document = agent_workspace_protocol::OpaqueDocumentRef {
        document_id: params.document.document_id,
        identity_version: params.document.identity_version.saturating_add(1),
    };
    encode(ContentSaveResult {
        document,
        content_revision,
    })
}

async fn list_text_boxes(
    params: BoundedListParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let (documents, next) = runtime
        .store
        .list_text_box_documents(optional_uuid(params.cursor.as_deref())?, params.limit)
        .map_err(storage_error)?;
    let mut authorized = Vec::new();
    for document in documents {
        if ensure_document_binding(runtime, &document).await.is_ok() {
            authorized.push(document);
        }
    }
    encode(TextBoxListResult {
        documents: authorized,
        next_cursor: next.map(|id| id.to_string()),
    })
}

async fn create_text_box(
    params: TextBoxCreateParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    ensure_workspace_window(
        runtime,
        uuid(&params.workspace_id)?,
        uuid(&params.window_id)?,
    )
    .await?;
    let document = TextBoxDocument {
        text_box_document_id: params.text_box_document_id.clone(),
        workspace_id: params.workspace_id.clone(),
        window_id: params.window_id.clone(),
        title: params.title.clone(),
        text: params.text.clone(),
        content_revision: 1,
        created_at_ms: u64::try_from(now_ms()).unwrap_or(0),
        updated_at_ms: u64::try_from(now_ms()).unwrap_or(0),
    };
    let result = encode(document)?;
    exact(
        runtime
            .store
            .create_text_box_document_exact(
                &params,
                &serde_json::to_string(&result).map_err(|_| internal())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        result,
    )
}

async fn save_text_box(
    params: TextBoxSaveParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let current = runtime
        .store
        .load_text_box_document(uuid(&params.text_box_document_id)?)
        .map_err(storage_error)?
        .ok_or_else(not_found)?;
    ensure_document_binding(runtime, &current).await?;
    let document = TextBoxDocument {
        title: params.title.clone(),
        text: params.text.clone(),
        content_revision: current.content_revision.saturating_add(1),
        updated_at_ms: u64::try_from(now_ms()).unwrap_or(0),
        ..current
    };
    let result = encode(document)?;
    exact(
        runtime
            .store
            .save_text_box_document_exact(
                &params,
                &serde_json::to_string(&result).map_err(|_| internal())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        result,
    )
}

async fn delete_text_box(
    params: TextBoxDeleteParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let id = uuid(&params.text_box_document_id)?;
    let current = runtime
        .store
        .load_text_box_document(id)
        .map_err(storage_error)?
        .ok_or_else(not_found)?;
    ensure_document_binding(runtime, &current).await?;
    let result = encode(current)?;
    exact(
        runtime
            .store
            .delete_text_box_document_exact(
                id,
                params.expected_revision,
                &params.mutation,
                &serde_json::to_string(&result).map_err(|_| internal())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        result,
    )
}

async fn diff(
    params: ContentDiffParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    sync_content_roots(runtime).await?;
    let provider = runtime.documents.lock().await;
    let before = provider
        .read_chunk(
            &params.before,
            0,
            usize::try_from(params.max_bytes).unwrap_or(usize::MAX),
        )
        .map_err(|error| content_error(&error))?;
    let after = provider
        .read_chunk(
            &params.after,
            0,
            usize::try_from(params.max_bytes).unwrap_or(usize::MAX),
        )
        .map_err(|error| content_error(&error))?;
    if !before.eof || !after.eof {
        return Err(CommandError::new(
            "resource_limit",
            "Diff input exceeds the bounded preview",
        ));
    }
    let mut lines = Vec::new();
    for line in before.text.lines().take(2048) {
        if !after.text.lines().any(|other| other == line) {
            lines.push(SafeDiffLine {
                kind: SafeDiffLineKind::Removed,
                text: line.chars().take(16_384).collect(),
            });
        }
    }
    for line in after.text.lines().take(2048) {
        lines.push(SafeDiffLine {
            kind: if before.text.lines().any(|other| other == line) {
                SafeDiffLineKind::Context
            } else {
                SafeDiffLineKind::Added
            },
            text: line.chars().take(16_384).collect(),
        });
    }
    encode(agent_workspace_protocol::ContentDiffResult {
        truncated: lines.len() >= 4096,
        lines,
    })
}

#[allow(clippy::too_many_lines)]
fn task_list(
    params: TaskListParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let cancellation_id = uuid(&params.cancellation_id)?;
    let cancellation = begin_operation(runtime, cancellation_id)?;
    let mut tasks = Vec::new();
    // Workspace tabs do not expose an authoritative terminal generation, so terminals are
    // intentionally omitted instead of fabricating generation/liveness evidence.
    let catalog = match runtime.store.load_agent_catalog().map_err(storage_error) {
        Ok(value) => value,
        Err(error) => {
            end_operation(runtime, cancellation_id);
            return Err(error);
        }
    };
    for session in catalog.sessions {
        if runtime.agents.is_none() {
            break;
        }
        if cancellation.load(Ordering::Relaxed) {
            end_operation(runtime, cancellation_id);
            return Err(CommandError::new(
                "cancelled",
                "The task list was cancelled",
            ));
        }
        tasks.push(TaskSummary {
            target: TaskTarget {
                session_id: session.binding.agent_session_id.to_string(),
                generation: session.attempt_epoch,
                revision: session.revision,
            },
            kind: TaskKind::Agent,
            label: session.title.clone(),
            lifecycle: agent_task_lifecycle(runtime, &session)?,
            observation: if session.last_verified_at_ms > 0 {
                TaskObservation::LastVerified
            } else {
                TaskObservation::Unknown
            },
            owner_label: "Agent".into(),
            resource_summary: None,
        });
    }
    let mut remote = Vec::new();
    let mut remote_cursor = None;
    loop {
        let page = runtime
            .store
            .list_remote_sessions(remote_cursor, 128)
            .map_err(storage_error);
        let (mut records, next) = match page {
            Ok(value) => value,
            Err(error) => {
                end_operation(runtime, cancellation_id);
                return Err(error);
            }
        };
        remote.append(&mut records);
        if remote.len() > agent_workspace_storage::MAX_REMOTE_SESSIONS {
            end_operation(runtime, cancellation_id);
            return Err(CommandError::new(
                "resource_limit",
                "The task registry exceeds its fixed bound",
            ));
        }
        match next {
            Some(cursor) => remote_cursor = Some(cursor),
            None => break,
        }
    }
    for session in remote {
        if runtime.remotes.is_none() {
            break;
        }
        if cancellation.load(Ordering::Relaxed) {
            end_operation(runtime, cancellation_id);
            return Err(CommandError::new(
                "cancelled",
                "The task list was cancelled",
            ));
        }
        tasks.push(TaskSummary {
            target: TaskTarget {
                session_id: session.remote_session_id.to_string(),
                generation: session.attempt_generation,
                revision: session.revision,
            },
            kind: TaskKind::RemoteSession,
            label: "Remote session".into(),
            lifecycle: remote_lifecycle(session.state),
            observation: remote_observation(&session.observation),
            owner_label: "Remote".into(),
            resource_summary: None,
        });
    }
    tasks.sort_by(|a, b| a.target.session_id.cmp(&b.target.session_id));
    if let Some(cursor) = params.cursor {
        tasks.retain(|task| task.target.session_id > cursor);
    }
    if let Some(kind) = params.kind {
        tasks.retain(|task| task.kind == kind);
    }
    if let Some(lifecycle) = params.lifecycle {
        tasks.retain(|task| task.lifecycle == lifecycle);
    }
    let has_more = tasks.len() > usize::from(params.limit);
    tasks.truncate(usize::from(params.limit));
    let next_cursor = has_more.then(|| {
        tasks
            .last()
            .expect("nonzero limit")
            .target
            .session_id
            .clone()
    });
    end_operation(runtime, cancellation_id);
    encode(TaskListResult { tasks, next_cursor })
}

async fn task_confirmation_issue(
    params: TaskConfirmationIssueParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    if params.action == TaskActionKind::Detach {
        return Err(CommandError::new(
            "invalid_params",
            "Detach does not use a destructive confirmation",
        ));
    }
    let summary = exact_task_summary(runtime, &params.target)?;
    let multi_window = runtime
        .multi_window
        .as_ref()
        .ok_or_else(provider_unavailable)?;
    let state = runtime.workspace.snapshot().await;
    let window = agent_workspace_protocol::ActionInvocationTarget {
        window_id: params.window.window_id.clone(),
        window_generation: params.window.window_generation,
    };
    let reservation = multi_window
        .action_reserve(&state, "window-host-v1", Some(&window))
        .await
        .map_err(provider_error)?;
    let now = now_ms();
    let confirmation = TaskConfirmation {
        invocation_id: Uuid::new_v4().to_string(),
        action: params.action,
        kind: summary.kind,
        target: params.target,
        provider_id: reservation.provider_id.to_string(),
        provider_epoch: reservation.provider_epoch,
        provider_lease_id: reservation.provider_lease_id.to_string(),
        window_id: reservation.window_id.to_string(),
        window_generation: reservation.window_generation,
        request_hash: params.request_hash,
        nonce: Uuid::new_v4().to_string(),
        expires_at_ms: u64::try_from(now).unwrap_or(0).saturating_add(30_000),
    };
    let stored = runtime
        .store
        .create_task_confirmation_exact(&confirmation, now)
        .map_err(storage_error);
    multi_window
        .action_abort_reservation(reservation.reservation_id)
        .await;
    stored?;
    encode(TaskConfirmationIssueResult { confirmation })
}

#[allow(clippy::too_many_lines)]
async fn task_action(
    params: TaskActionParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let (action, target, confirmation, mutation) = match params {
        TaskActionParams::Detach { target, mutation } => {
            (TaskActionKind::Detach, target, None, mutation)
        }
        TaskActionParams::Cancel {
            target,
            confirmation,
            mutation,
        } => (TaskActionKind::Cancel, target, Some(confirmation), mutation),
        TaskActionParams::Terminate {
            target,
            confirmation,
            mutation,
        } => (
            TaskActionKind::Terminate,
            target,
            Some(confirmation),
            mutation,
        ),
        TaskActionParams::ForceTerminate {
            target,
            confirmation,
            mutation,
        } => (
            TaskActionKind::ForceTerminate,
            target,
            Some(confirmation),
            mutation,
        ),
    };
    if mutation.expected_revision != target.revision {
        return Err(stale_target());
    }
    let kind = match &confirmation {
        Some(value) => value.kind,
        None => task_kind_for_id(runtime, uuid(&target.session_id)?)?,
    };
    match runtime
        .store
        .load_task_action_outcome_exact(action, kind, &target, &mutation)
        .map_err(storage_error)?
    {
        SidebarContentMutationOutcome::Replay(value) => {
            return serde_json::from_str(&value).map_err(|_| internal());
        }
        SidebarContentMutationOutcome::Conflict => {
            return Err(CommandError::new(
                "idempotency_conflict",
                "The task action idempotency key conflicts",
            ));
        }
        SidebarContentMutationOutcome::NotFound => {}
        _ => return Err(internal()),
    }
    let invocation_id = if let Some(confirmation) = &confirmation {
        if confirmation.action != action
            || confirmation.kind != kind
            || confirmation.target != target
            || confirmation.request_hash != mutation.request_hash
        {
            return Err(CommandError::new(
                "invalid_state",
                "The task confirmation does not match the exact action target",
            ));
        }
        let consume = runtime
            .store
            .consume_task_confirmation_exact(confirmation, &mutation, now_ms())
            .map_err(storage_error)?;
        match consume {
            TaskConfirmationConsumeOutcome::Consumed => {
                let multi_window = runtime
                    .multi_window
                    .as_ref()
                    .ok_or_else(provider_unavailable)?;
                let identity = agent_workspace_protocol::DesktopProviderIdentityParams {
                    provider_id: confirmation.provider_id.clone(),
                    provider_epoch: confirmation.provider_epoch,
                    lease_id: confirmation.provider_lease_id.clone(),
                };
                let window = agent_workspace_protocol::ActionInvocationTarget {
                    window_id: confirmation.window_id.clone(),
                    window_generation: confirmation.window_generation,
                };
                if multi_window
                    .action_provider_identity_valid(&identity, &window)
                    .await
                    .is_err()
                {
                    return record_task_terminal_outcome(
                        runtime,
                        Uuid::parse_str(&confirmation.invocation_id)
                            .map_err(|_| invalid_params())?,
                        action,
                        kind,
                        &target,
                        &mutation,
                        TaskActionOutcome::ProviderLost,
                    );
                }
            }
            TaskConfirmationConsumeOutcome::Replay => {}
            TaskConfirmationConsumeOutcome::Expired => {
                return record_task_terminal_outcome(
                    runtime,
                    Uuid::parse_str(&confirmation.invocation_id).map_err(|_| invalid_params())?,
                    action,
                    kind,
                    &target,
                    &mutation,
                    TaskActionOutcome::ConfirmationExpired,
                );
            }
            TaskConfirmationConsumeOutcome::Conflict
            | TaskConfirmationConsumeOutcome::AlreadyConsumed => {
                return Err(CommandError::new(
                    "invalid_state",
                    "The task confirmation is unavailable or already consumed",
                ));
            }
        }
        Uuid::parse_str(&confirmation.invocation_id).map_err(|_| invalid_params())?
    } else {
        Uuid::new_v4()
    };

    let owner = match kind {
        TaskKind::Agent => {
            let result = runtime
                .agents
                .as_ref()
                .ok_or_else(provider_unavailable)?
                .task_action(action, &target)
                .await;
            match result {
                Ok(value) => Ok((
                    TaskTarget {
                        session_id: value.session.binding.agent_session_id.to_string(),
                        generation: value.session.attempt_epoch,
                        revision: value.session.revision,
                    },
                    agent_task_lifecycle(runtime, &value.session)?,
                    if value.session.last_verified_at_ms > 0 {
                        TaskObservation::LastVerified
                    } else {
                        TaskObservation::Unknown
                    },
                    value.already_terminal,
                )),
                Err(error) => Err(error),
            }
        }
        TaskKind::RemoteSession => {
            let result = runtime
                .remotes
                .as_ref()
                .ok_or_else(provider_unavailable)?
                .task_action(action, &target, mutation.clone())
                .await;
            match result {
                Ok(value) => Ok((
                    TaskTarget {
                        session_id: value.session.remote_session_id.to_string(),
                        generation: value.session.attempt_generation,
                        revision: value.session.revision,
                    },
                    remote_lifecycle(value.session.state),
                    remote_observation(&value.session.observation),
                    value.already_terminal,
                )),
                Err(error) => Err(error),
            }
        }
        TaskKind::Terminal | TaskKind::BrowserAutomation | TaskKind::CustomAction => {
            return Err(provider_unavailable());
        }
    };
    let (current_target, lifecycle, observation, already_terminal) = match owner {
        Ok(value) => value,
        Err("target_stale") => {
            return record_task_terminal_outcome(
                runtime,
                invocation_id,
                action,
                kind,
                &target,
                &mutation,
                TaskActionOutcome::StaleTarget,
            );
        }
        Err("provider_unavailable" | "runtime_unavailable") => {
            return record_task_terminal_outcome(
                runtime,
                invocation_id,
                action,
                kind,
                &target,
                &mutation,
                TaskActionOutcome::ProviderLost,
            );
        }
        Err("unsupported_action") => {
            return Err(CommandError::new(
                "invalid_params",
                "The authoritative task owner does not support this action",
            ));
        }
        Err(_) => return Err(internal()),
    };
    let result = TaskActionResult {
        revision: current_target.revision,
        target: current_target,
        lifecycle,
        observation,
        outcome: if already_terminal {
            TaskActionOutcome::AlreadyConverged
        } else {
            TaskActionOutcome::Accepted
        },
    };
    let value = encode(result)?;
    exact(
        runtime
            .store
            .record_task_action_outcome_exact(
                invocation_id,
                action,
                kind,
                &target,
                &mutation,
                &serde_json::to_string(&value).map_err(|_| internal())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        value,
    )
}

async fn search_query(
    params: SearchQueryParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let cancellation_id = uuid(&params.cancellation_id)?;
    sync_content_roots(runtime).await?;
    let cancellation = begin_operation(runtime, cancellation_id)?;
    if cancellation.load(Ordering::Relaxed) {
        end_operation(runtime, cancellation_id);
        return Err(CommandError::new(
            "cancelled",
            "The search query was cancelled",
        ));
    }
    let results = {
        let mut index = runtime.index.lock().await;
        index
            .as_mut()
            .ok_or_else(provider_unavailable)
            .and_then(|index| {
                index
                    .search(&params.query, usize::from(params.limit))
                    .map_err(|_| {
                        CommandError::new(
                            "runtime_unavailable",
                            "The encrypted index could not complete the bounded query",
                        )
                    })
            })
    };
    let mut results = match results {
        Ok(results) => results,
        Err(error) => {
            end_operation(runtime, cancellation_id);
            return Err(error);
        }
    };
    if cancellation.load(Ordering::Relaxed) {
        end_operation(runtime, cancellation_id);
        return Err(CommandError::new(
            "cancelled",
            "The search query was cancelled",
        ));
    }
    let provider = runtime.documents.lock().await;
    revalidate_search_results(&provider, &runtime.store, &mut results);
    let truncated = results.len() == usize::from(params.limit);
    drop(provider);
    end_operation(runtime, cancellation_id);
    encode(SearchQueryResult { results, truncated })
}

async fn search_source_policy(
    params: SearchSourcePolicyParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    if params.mutation.expected_revision == 0 {
        return Err(CommandError::new(
            "stale_revision",
            "The search policy revision changed",
        ));
    }
    sync_content_roots(runtime).await?;
    let source = uuid(&params.source_authorization_id)?;
    match params.source_kind {
        SearchSourceKind::WorkspaceFile => {
            if !runtime.documents.lock().await.has_root(source)
                || runtime
                    .store
                    .load_agent_session(source)
                    .map_err(storage_error)?
                    .is_some()
            {
                return Err(CommandError::new(
                    "unauthorized",
                    "The workspace source is not authorized",
                ));
            }
        }
        SearchSourceKind::AgentTranscript => {
            if runtime.documents.lock().await.has_root(source) {
                return Err(CommandError::new(
                    "unauthorized",
                    "The transcript source identity is ambiguous",
                ));
            }
            trusted_codex_transcript_session(runtime, source)?;
        }
    }
    let mut index = runtime.index.lock().await;
    let index = index.as_mut().ok_or_else(provider_unavailable)?;
    index
        .authorize_source(source, u64::try_from(now_ms()).unwrap_or(0))
        .and_then(|()| {
            index.set_source_policy(source, params.retention_days, &params.exclusion_ids)
        })
        .map_err(index_error)?;
    encode(SearchControlResult {
        source_authorization_id: source.to_string(),
        state: SearchControlState::Enabled,
        revision: params.mutation.expected_revision.saturating_add(1),
    })
}

async fn search_source_exclude(
    params: SearchSourceMutationParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let source = uuid(&params.source_authorization_id)?;
    runtime
        .index
        .lock()
        .await
        .as_mut()
        .ok_or_else(provider_unavailable)?
        .exclude_source(source)
        .map_err(index_error)?;
    search_control(
        source,
        SearchControlState::Excluded,
        params.mutation.expected_revision,
    )
}

async fn search_source_forget(
    params: SearchSourceMutationParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let source = uuid(&params.source_authorization_id)?;
    runtime
        .index
        .lock()
        .await
        .as_mut()
        .ok_or_else(provider_unavailable)?
        .forget_source(source)
        .map_err(index_error)?;
    search_control(
        source,
        SearchControlState::Forgotten,
        params.mutation.expected_revision,
    )
}

#[allow(clippy::too_many_lines)]
async fn search_source_rebuild(
    params: SearchRebuildParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    sync_content_roots(runtime).await?;
    let source = uuid(&params.source_authorization_id)?;
    let cancellation_id = uuid(&params.cancellation_id)?;
    let max_indexable_bytes = usize::try_from(agent_workspace_content::MAX_INDEXABLE_FILE_BYTES)
        .map_err(|_| internal())?;
    let cancellation = begin_operation(runtime, cancellation_id)?;
    let authorization = runtime
        .index
        .lock()
        .await
        .as_ref()
        .ok_or_else(provider_unavailable)
        .and_then(|index| index.authorize_source_read(source).map_err(index_error));
    if let Err(error) = authorization {
        end_operation(runtime, cancellation_id);
        return Err(error);
    }
    let workspace_source = runtime.documents.lock().await.has_root(source);
    let agent_source = runtime
        .store
        .load_agent_session(source)
        .map_err(storage_error);
    let agent_source = match agent_source {
        Ok(value) => value,
        Err(error) => {
            end_operation(runtime, cancellation_id);
            return Err(error);
        }
    };
    if workspace_source && agent_source.is_some() {
        end_operation(runtime, cancellation_id);
        return Err(CommandError::new(
            "unauthorized",
            "The search source identity is ambiguous",
        ));
    }
    let collected = if workspace_source {
        let documents = Arc::clone(&runtime.documents);
        let scan_cancellation = Arc::clone(&cancellation);
        tokio::task::spawn_blocking(move || {
            documents
                .blocking_lock()
                .enumerate_index_documents_with_cancel(source, || {
                    scan_cancellation.load(Ordering::Relaxed)
                })
        })
        .await
        .map_err(|_| internal())
        .and_then(|result| result.map_err(|error| content_error(&error)))
        .map(|enumeration| {
            (
                SearchSourceKind::WorkspaceFile,
                enumeration
                    .documents
                    .into_iter()
                    .map(|item| (item.document, IndexDocumentText::Workspace(item.text)))
                    .collect::<Vec<_>>(),
                enumeration.partial,
                max_indexable_bytes,
            )
        })
    } else {
        match trusted_codex_transcript_session(runtime, source) {
            Err(error) => Err(error),
            Ok(session) => {
                let request = TrustedTranscriptRequest {
                    agent_session_id: source,
                    session_revision: session.revision,
                    adapter: TranscriptAdapter::CodexJsonlV1,
                    adapter_version: session.adapter_version,
                    cancellation: Arc::clone(&cancellation),
                };
                match runtime.transcripts.read_bounded(request).await {
                    Ok(batch) => collect_transcript_batch(batch),
                    Err(error) => Err(transcript_source_error(error)),
                }
            }
        }
    };
    let (source_kind, indexed_documents, mut partial, index_document_bytes) = match collected {
        Ok(value) => value,
        Err(error) => {
            end_operation(runtime, cancellation_id);
            return Err(error);
        }
    };
    let mut index = runtime.index.lock().await;
    let Some(index) = index.as_mut() else {
        end_operation(runtime, cancellation_id);
        return Err(provider_unavailable());
    };
    if let Err(error) = index.rebuild_source(source) {
        end_operation(runtime, cancellation_id);
        return Err(index_error(error));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    for (position, (document, text)) in indexed_documents.into_iter().enumerate() {
        if cancellation.load(Ordering::Relaxed) {
            let _ = index.rebuild_source(source);
            end_operation(runtime, cancellation_id);
            return Err(CommandError::new(
                "cancelled",
                "The search rebuild was cancelled",
            ));
        }
        match index.index_text(
            source,
            &document,
            source_kind,
            text.as_str(),
            false,
            u64::try_from(now_ms()).unwrap_or(0),
            IndexBudget {
                max_bytes: index_document_bytes,
                deadline,
            },
        ) {
            Ok(()) => {}
            Err(agent_workspace_content_index::IndexError::Capacity) => {
                partial = true;
                break;
            }
            Err(error) => {
                let _ = index.rebuild_source(source);
                end_operation(runtime, cancellation_id);
                return Err(index_error(error));
            }
        }
        if position % 32 == 31 {
            tokio::task::yield_now().await;
        }
    }
    if cancellation.load(Ordering::Relaxed) {
        let _ = index.rebuild_source(source);
        end_operation(runtime, cancellation_id);
        return Err(CommandError::new(
            "cancelled",
            "The search rebuild was cancelled",
        ));
    }
    end_operation(runtime, cancellation_id);
    search_control(
        source,
        if partial {
            SearchControlState::PausedLimit
        } else {
            SearchControlState::Enabled
        },
        params.mutation.expected_revision,
    )
}

async fn search_source_export(
    params: SearchExportParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let source = uuid(&params.source_authorization_id)?;
    let confirmation_id = uuid(&params.confirmation_id)?;
    let mut index = runtime.index.lock().await;
    let index = index.as_mut().ok_or_else(provider_unavailable)?;
    index.authorize_source_read(source).map_err(index_error)?;
    consume_export_confirmation(runtime, confirmation_id, source)?;
    let summary = index.export_source_summary(source).map_err(index_error)?;
    let generated_at_ms = u64::try_from(now_ms()).unwrap_or(0);
    let artifact_id = Uuid::new_v4();
    let content = export_artifact_content(source, &summary, generated_at_ms)?;
    encode(SearchExportResult {
        source_authorization_id: source.to_string(),
        artifact: agent_workspace_protocol::ContentChunk {
            document: agent_workspace_protocol::OpaqueDocumentRef {
                document_id: artifact_id.to_string(),
                identity_version: 1,
            },
            offset: 0,
            text: content,
            eof: true,
            content_revision: 1,
            display_name: "search-index-summary.json".into(),
        },
    })
}

async fn search_export_confirmation_issue(
    params: SearchExportConfirmationIssueParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let source = uuid(&params.source_authorization_id)?;
    runtime
        .index
        .lock()
        .await
        .as_ref()
        .ok_or_else(provider_unavailable)?
        .authorize_source_read(source)
        .map_err(index_error)?;
    let now = now_ms();
    let expires_at_ms = now.saturating_add(60_000);
    let confirmation_id = Uuid::new_v4();
    let mut confirmations = runtime
        .export_confirmations
        .lock()
        .map_err(|_| internal())?;
    confirmations.retain(|_, record| record.expires_at_ms > now);
    if confirmations.len() >= 16 {
        return Err(CommandError::new(
            "resource_limit",
            "The bounded export confirmation registry is full",
        ));
    }
    confirmations.insert(
        confirmation_id,
        SearchExportConfirmationRecord {
            source,
            expires_at_ms,
        },
    );
    encode(SearchExportConfirmationIssueResult {
        confirmation: SearchExportConfirmation {
            confirmation_id: confirmation_id.to_string(),
            source_authorization_id: source.to_string(),
            expires_at_ms: u64::try_from(expires_at_ms).map_err(|_| internal())?,
        },
    })
}

fn consume_export_confirmation(
    runtime: &SidebarContentRuntime,
    confirmation_id: Uuid,
    source: Uuid,
) -> Result<(), CommandError> {
    let record = runtime
        .export_confirmations
        .lock()
        .map_err(|_| internal())?
        .remove(&confirmation_id)
        .ok_or_else(|| {
            CommandError::new(
                "confirmation_expired",
                "The export confirmation is unavailable",
            )
        })?;
    if !export_confirmation_matches(record, source, now_ms()) {
        return Err(CommandError::new(
            "confirmation_expired",
            "The export confirmation does not match the exact source",
        ));
    }
    Ok(())
}

fn export_confirmation_matches(
    record: SearchExportConfirmationRecord,
    source: Uuid,
    now_ms: i64,
) -> bool {
    record.source == source && record.expires_at_ms >= now_ms
}

fn export_artifact_content(
    source: Uuid,
    summary: &agent_workspace_content_index::IndexExportSummary,
    generated_at_ms: u64,
) -> Result<String, CommandError> {
    let content = serde_json::to_string(&serde_json::json!({
        "schemaVersion": summary.schema_version,
        "sourceAuthorizationId": source,
        "documentCount": summary.documents,
        "tokenCount": summary.tokens,
        "generatedAtMs": generated_at_ms,
    }))
    .map_err(|_| internal())?;
    if content.len() > agent_workspace_protocol::MAX_CONTENT_CHUNK_BYTES {
        return Err(CommandError::new(
            "resource_limit",
            "The bounded export artifact exceeded its fixed limit",
        ));
    }
    Ok(content)
}

fn search_control(
    source: Uuid,
    state: SearchControlState,
    expected_revision: u64,
) -> Result<Value, CommandError> {
    encode(SearchControlResult {
        source_authorization_id: source.to_string(),
        state,
        revision: expected_revision.saturating_add(1),
    })
}

fn revalidate_search_results(
    provider: &WorkspacePathProvider,
    store: &SqliteStateStore,
    results: &mut Vec<SearchResult>,
) {
    results.retain(|result| match result.source_kind {
        SearchSourceKind::WorkspaceFile => provider.revalidate(&result.document).is_ok(),
        SearchSourceKind::AgentTranscript => Uuid::parse_str(&result.document.document_id)
            .ok()
            .and_then(|session_id| store.load_agent_session(session_id).ok().flatten())
            .is_some_and(|session| {
                session.binding.agent_session_id.to_string() == result.document.document_id
                    && session.revision == result.document.identity_version
                    && session.adapter_id == "codex"
                    && session.adapter_version == "0.142.4"
            }),
    });
}

fn trusted_codex_transcript_session(
    runtime: &SidebarContentRuntime,
    source: Uuid,
) -> Result<agent_workspace_storage::AgentSessionRecord, CommandError> {
    let session = runtime
        .store
        .load_agent_session(source)
        .map_err(storage_error)?
        .ok_or_else(not_found)?;
    if session.adapter_id != "codex" || session.adapter_version != "0.142.4" {
        return Err(provider_unavailable());
    }
    Ok(session)
}

type TranscriptIndexDocument = (
    agent_workspace_protocol::OpaqueDocumentRef,
    IndexDocumentText,
);
type TranscriptBatchCollection = (SearchSourceKind, Vec<TranscriptIndexDocument>, bool, usize);

fn collect_transcript_batch(
    batch: TrustedTranscriptBatch,
) -> Result<TranscriptBatchCollection, CommandError> {
    const MAX_TRANSCRIPT_BATCH_DOCUMENTS: usize = 256;
    const MAX_TRANSCRIPT_BATCH_BYTES: usize = 8 * 1024 * 1024;
    if batch.documents.len() > MAX_TRANSCRIPT_BATCH_DOCUMENTS {
        return Err(CommandError::new(
            "resource_limit",
            "The trusted transcript batch exceeds its fixed bound",
        ));
    }
    let mut total_bytes = 0_usize;
    let mut partial = batch.partial;
    let mut documents = Vec::with_capacity(batch.documents.len());
    for item in batch.documents {
        uuid(&item.document.document_id)?;
        if item.document.identity_version == 0 {
            return Err(CommandError::new(
                "stale_revision",
                "The transcript document identity changed",
            ));
        }
        total_bytes = total_bytes
            .checked_add(item.payload.len())
            .filter(|total| *total <= MAX_TRANSCRIPT_BATCH_BYTES)
            .ok_or_else(|| {
                CommandError::new(
                    "resource_limit",
                    "The trusted transcript batch exceeds its fixed bound",
                )
            })?;
        let parsed = parse_transcript(TranscriptAdapter::CodexJsonlV1, &item.payload);
        partial |= parsed.skipped_records != 0;
        if !parsed.text.is_empty() {
            let joined = zeroize::Zeroizing::new(
                parsed
                    .text
                    .iter()
                    .map(|value| value.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            documents.push((item.document, IndexDocumentText::Sensitive(joined)));
        }
    }
    Ok((
        SearchSourceKind::AgentTranscript,
        documents,
        partial,
        MAX_TRANSCRIPT_BATCH_BYTES,
    ))
}

enum IndexDocumentText {
    Workspace(String),
    Sensitive(zeroize::Zeroizing<String>),
}

impl IndexDocumentText {
    fn as_str(&self) -> &str {
        match self {
            Self::Workspace(value) => value,
            Self::Sensitive(value) => value,
        }
    }
}

const fn transcript_source_error(error: TranscriptSourceError) -> CommandError {
    match error {
        TranscriptSourceError::Unavailable | TranscriptSourceError::UnsupportedFormat => {
            provider_unavailable()
        }
        TranscriptSourceError::Cancelled => {
            CommandError::new("cancelled", "The transcript rebuild was cancelled")
        }
        TranscriptSourceError::ResourceLimit => CommandError::new(
            "resource_limit",
            "The trusted transcript batch exceeds its fixed bound",
        ),
    }
}

fn begin_operation(
    runtime: &SidebarContentRuntime,
    id: Uuid,
) -> Result<Arc<AtomicBool>, CommandError> {
    let mut active = runtime.cancellations.lock().map_err(|_| internal())?;
    if active.len() >= 256 || active.contains_key(&id) {
        return Err(CommandError::new(
            "resource_limit",
            "The cancellation registry reached its fixed bound",
        ));
    }
    let flag = Arc::new(AtomicBool::new(false));
    active.insert(id, Arc::clone(&flag));
    Ok(flag)
}

fn cancel_operation(runtime: &SidebarContentRuntime, id: Uuid) -> bool {
    runtime
        .cancellations
        .lock()
        .ok()
        .and_then(|active| active.get(&id).cloned())
        .is_some_and(|flag| {
            flag.store(true, Ordering::Relaxed);
            true
        })
}

fn end_operation(runtime: &SidebarContentRuntime, id: Uuid) {
    if let Ok(mut active) = runtime.cancellations.lock() {
        active.remove(&id);
    }
}

async fn recently_closed(
    params: BoundedListParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let snapshot = runtime.workspace.snapshot().await;
    let revision = snapshot.revision.max(1);
    let live_ids = snapshot
        .recently_closed
        .iter()
        .filter_map(|record| Uuid::parse_str(&record.id.to_string()).ok())
        .collect::<HashSet<_>>();
    let mut descriptors = runtime.closed_descriptors.lock().await;
    descriptors.retain(|_, descriptor| {
        live_ids.contains(&descriptor.closed_id) && descriptor.revision == revision
    });
    let mut records = Vec::with_capacity(snapshot.recently_closed.len());
    for record in &snapshot.recently_closed {
        let closed_id = uuid(&record.id.to_string())?;
        let action = match record.content_kind {
            agent_workspace_core::ClosedContentKind::Terminal => ReopenAction::ReopenTerminal,
            agent_workspace_core::ClosedContentKind::Browser => ReopenAction::ReopenBrowser,
        };
        let descriptor_id = descriptors
            .iter()
            .find_map(|(id, descriptor)| {
                (descriptor.closed_id == closed_id
                    && descriptor.revision == revision
                    && descriptor.action == action)
                    .then_some(*id)
            })
            .unwrap_or_else(|| {
                let id = Uuid::new_v4();
                descriptors.insert(
                    id,
                    ClosedDescriptor {
                        closed_id,
                        revision,
                        action,
                    },
                );
                id
            });
        records.push(RecentlyClosedRecord {
            recently_closed_id: record.id.to_string(),
            authorized_descriptor_id: descriptor_id.to_string(),
            action,
            label: record.title.clone(),
            closed_at_ms: record.closed_at.0,
            revision,
        });
    }
    records.sort_by(|a, b| a.recently_closed_id.cmp(&b.recently_closed_id));
    if let Some(cursor) = params.cursor {
        records.retain(|record| record.recently_closed_id > cursor);
    }
    let has_more = records.len() > usize::from(params.limit);
    records.truncate(usize::from(params.limit));
    let next_cursor = has_more.then(|| {
        records
            .last()
            .expect("nonzero limit")
            .recently_closed_id
            .clone()
    });
    encode(RecentlyClosedListResult {
        records,
        next_cursor,
    })
}

async fn reopen_recently_closed(
    params: RecentlyClosedReopenParams,
    runtime: &SidebarContentRuntime,
) -> Result<Value, CommandError> {
    let closed_id = uuid(&params.recently_closed_id)?;
    let descriptor_id = uuid(&params.authorized_descriptor_id)?;
    if params.expected_revision != params.mutation.expected_revision {
        return Err(CommandError::new(
            "stale_revision",
            "The recently-closed revision changed",
        ));
    }
    let snapshot = runtime.workspace.snapshot().await;
    let record = snapshot
        .recently_closed
        .iter()
        .find(|record| record.id.to_string() == closed_id.to_string())
        .ok_or_else(not_found)?;
    let expected_action = match record.content_kind {
        agent_workspace_core::ClosedContentKind::Terminal => ReopenAction::ReopenTerminal,
        agent_workspace_core::ClosedContentKind::Browser => ReopenAction::ReopenBrowser,
    };
    let descriptor = runtime
        .closed_descriptors
        .lock()
        .await
        .get(&descriptor_id)
        .copied()
        .ok_or_else(|| {
            CommandError::new(
                "unauthorized",
                "The recently-closed descriptor is not authorized",
            )
        })?;
    if !closed_descriptor_matches(
        descriptor,
        closed_id,
        params.expected_revision,
        params.action,
    ) || expected_action != params.action
        || snapshot.revision != params.expected_revision
    {
        return Err(CommandError::new(
            "stale_revision",
            "The recently-closed descriptor is stale",
        ));
    }
    let response = super::multi_window::reopen_tab_from_sidebar(
        Arc::clone(&runtime.workspace),
        agent_workspace_protocol::TabReopenParams {
            mutation: agent_workspace_protocol::MultiWindowMutationToken {
                expected_revision: params.expected_revision,
                idempotency_epoch: params.idempotency_epoch,
                idempotency_key: params.mutation.idempotency_key,
            },
            closed_item_id: params.recently_closed_id,
            target: params.target,
        },
    )
    .await;
    if response.ok {
        response.result.ok_or_else(internal)
    } else {
        Err(
            match response.error.as_ref().map(|error| error.code.as_str()) {
                Some("idempotency_conflict") => CommandError::new(
                    "idempotency_conflict",
                    "Idempotency key conflicts with a prior request",
                ),
                Some("stale_revision" | "window_revision_mismatch") => {
                    CommandError::new("stale_revision", "The recently-closed revision changed")
                }
                Some("source_not_found") => not_found(),
                Some("resource_limit") => CommandError::new(
                    "resource_limit",
                    "The reopen operation reached its fixed bound",
                ),
                _ => CommandError::new(
                    "runtime_unavailable",
                    "The exact tab reopen could not be completed",
                ),
            },
        )
    }
}

#[cfg(test)]
fn terminal_task_evidence(
    terminal_io: &TerminalIoHandle,
    runtime_session_id: Option<&str>,
) -> (TaskLifecycle, TaskObservation) {
    let evidence = runtime_session_id.and_then(|id| terminal_io.attach(id).ok());
    (
        match evidence.as_ref() {
            Some(snapshot) if snapshot.terminal.exited => TaskLifecycle::Failed,
            Some(_) => TaskLifecycle::Running,
            None => TaskLifecycle::Detached,
        },
        if evidence.is_some() {
            TaskObservation::LastVerified
        } else {
            TaskObservation::Unknown
        },
    )
}

fn agent_task_lifecycle(
    runtime: &SidebarContentRuntime,
    session: &agent_workspace_storage::AgentSessionRecord,
) -> Result<TaskLifecycle, CommandError> {
    let disposition = runtime
        .store
        .load_agent_task_disposition(
            session.binding.agent_session_id,
            session.attempt_epoch,
            session.revision,
        )
        .map_err(storage_error)?;
    Ok(agent_task_lifecycle_from(
        session.lifecycle,
        disposition.as_deref().unwrap_or(&session.durable_intent),
    ))
}

fn agent_task_lifecycle_from(
    state: agent_workspace_storage::AgentLifecycleRecord,
    durable_intent: &str,
) -> TaskLifecycle {
    use agent_workspace_storage::AgentLifecycleRecord as S;
    match (state, durable_intent) {
        (S::Completed, "taskCancelled") => TaskLifecycle::Cancelled,
        (S::Completed, "taskTerminated" | "taskForceTerminated") => TaskLifecycle::Terminated,
        (state, _) => match state {
            S::Created | S::Launching => TaskLifecycle::Created,
            S::Running | S::Waiting | S::Checkpointing => TaskLifecycle::Running,
            S::Hibernated => TaskLifecycle::Detached,
            S::Completed => TaskLifecycle::Succeeded,
            S::Failed | S::Unavailable => TaskLifecycle::Failed,
        },
    }
}

fn task_kind_for_id(runtime: &SidebarContentRuntime, id: Uuid) -> Result<TaskKind, CommandError> {
    let agent = runtime.agents.is_some()
        && runtime
            .store
            .load_agent_session(id)
            .map_err(storage_error)?
            .is_some();
    let remote = runtime.remotes.is_some()
        && runtime
            .store
            .load_remote_session(id)
            .map_err(storage_error)?
            .is_some();
    match (agent, remote) {
        (true, false) => Ok(TaskKind::Agent),
        (false, true) => Ok(TaskKind::RemoteSession),
        (false, false) => Err(not_found()),
        (true, true) => Err(CommandError::new(
            "invalid_state",
            "The task identity is ambiguous across authoritative owners",
        )),
    }
}

fn exact_task_summary(
    runtime: &SidebarContentRuntime,
    target: &TaskTarget,
) -> Result<TaskSummary, CommandError> {
    let kind = task_kind_for_id(runtime, uuid(&target.session_id)?)?;
    let summary = task_summary_for_kind(runtime, kind, uuid(&target.session_id)?)?;
    if summary.target != *target {
        return Err(stale_target());
    }
    Ok(summary)
}

fn task_summary_for_kind(
    runtime: &SidebarContentRuntime,
    kind: TaskKind,
    id: Uuid,
) -> Result<TaskSummary, CommandError> {
    match kind {
        TaskKind::Agent if runtime.agents.is_some() => {
            let session = runtime
                .store
                .load_agent_session(id)
                .map_err(storage_error)?
                .ok_or_else(not_found)?;
            Ok(TaskSummary {
                target: TaskTarget {
                    session_id: session.binding.agent_session_id.to_string(),
                    generation: session.attempt_epoch,
                    revision: session.revision,
                },
                kind,
                label: session.title.clone(),
                lifecycle: agent_task_lifecycle(runtime, &session)?,
                observation: if session.last_verified_at_ms > 0 {
                    TaskObservation::LastVerified
                } else {
                    TaskObservation::Unknown
                },
                owner_label: "Agent".into(),
                resource_summary: None,
            })
        }
        TaskKind::RemoteSession if runtime.remotes.is_some() => {
            let session = runtime
                .store
                .load_remote_session(id)
                .map_err(storage_error)?
                .ok_or_else(not_found)?;
            Ok(TaskSummary {
                target: TaskTarget {
                    session_id: session.remote_session_id.to_string(),
                    generation: session.attempt_generation,
                    revision: session.revision,
                },
                kind,
                label: "Remote session".into(),
                lifecycle: remote_lifecycle(session.state),
                observation: remote_observation(&session.observation),
                owner_label: "Remote".into(),
                resource_summary: None,
            })
        }
        _ => Err(provider_unavailable()),
    }
}

fn record_task_terminal_outcome(
    runtime: &SidebarContentRuntime,
    invocation_id: Uuid,
    action: TaskActionKind,
    kind: TaskKind,
    original_target: &TaskTarget,
    mutation: &agent_workspace_protocol::RemoteMutationIdentity,
    outcome: TaskActionOutcome,
) -> Result<Value, CommandError> {
    let summary = task_summary_for_kind(runtime, kind, uuid(&original_target.session_id)?)?;
    let result = TaskActionResult {
        revision: summary.target.revision,
        target: summary.target,
        lifecycle: summary.lifecycle,
        observation: summary.observation,
        outcome,
    };
    let value = encode(result)?;
    exact(
        runtime
            .store
            .record_task_action_outcome_exact(
                invocation_id,
                action,
                kind,
                original_target,
                mutation,
                &serde_json::to_string(&value).map_err(|_| internal())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        value,
    )
}

fn closed_descriptor_matches(
    descriptor: ClosedDescriptor,
    closed_id: Uuid,
    revision: u64,
    action: ReopenAction,
) -> bool {
    descriptor.closed_id == closed_id
        && descriptor.revision == revision
        && descriptor.action == action
}

async fn ensure_window(runtime: &SidebarContentRuntime, id: Uuid) -> Result<(), CommandError> {
    runtime
        .workspace
        .snapshot()
        .await
        .window_placements
        .iter()
        .any(|window| window.id.to_string() == id.to_string())
        .then_some(())
        .ok_or_else(not_found)
}
async fn ensure_workspace_window(
    runtime: &SidebarContentRuntime,
    workspace_id: Uuid,
    window_id: Uuid,
) -> Result<(), CommandError> {
    let snapshot = runtime.workspace.snapshot().await;
    snapshot
        .window_placements
        .iter()
        .any(|window| {
            window.id.to_string() == window_id.to_string()
                && window
                    .workspace_ids
                    .iter()
                    .any(|id| id.to_string() == workspace_id.to_string())
        })
        .then_some(())
        .ok_or_else(|| {
            CommandError::new(
                "unauthorized",
                "Workspace is not owned by the requested window",
            )
        })
}
async fn ensure_document_binding(
    runtime: &SidebarContentRuntime,
    document: &TextBoxDocument,
) -> Result<(), CommandError> {
    ensure_workspace_window(
        runtime,
        uuid(&document.workspace_id)?,
        uuid(&document.window_id)?,
    )
    .await
}

fn exact(outcome: SidebarContentMutationOutcome, applied: Value) -> Result<Value, CommandError> {
    match outcome {
        SidebarContentMutationOutcome::Applied => Ok(applied),
        SidebarContentMutationOutcome::Replay(value) => {
            serde_json::from_str(&value).map_err(|_| internal())
        }
        SidebarContentMutationOutcome::Conflict => Err(CommandError::new(
            "idempotency_conflict",
            "Idempotency key conflicts with a prior request",
        )),
        SidebarContentMutationOutcome::NotFound => Err(not_found()),
        SidebarContentMutationOutcome::StaleRevision => Err(CommandError::new(
            "stale_revision",
            "The durable revision changed",
        )),
        SidebarContentMutationOutcome::ResourceLimit => Err(CommandError::new(
            "resource_limit",
            "The durable catalog reached its bound",
        )),
    }
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T, CommandError> {
    serde_json::from_value(value).map_err(|_| {
        CommandError::new(
            "invalid_params",
            "Parameters do not match the fixed command contract",
        )
    })
}
fn encode<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value).map_err(|_| internal())
}
fn uuid(value: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(value)
        .map_err(|_| CommandError::new("invalid_params", "Opaque identity is invalid"))
}
fn optional_uuid(value: Option<&str>) -> Result<Option<Uuid>, CommandError> {
    value.map(uuid).transpose()
}
fn storage_error(_: StorageError) -> CommandError {
    CommandError::new(
        "runtime_unavailable",
        "Durable sidebar state is unavailable",
    )
}
#[allow(clippy::needless_pass_by_value)]
fn index_error(error: agent_workspace_content_index::IndexError) -> CommandError {
    match error {
        agent_workspace_content_index::IndexError::Unauthorized => CommandError::new(
            "unauthorized",
            "The encrypted search source is not authorized",
        ),
        agent_workspace_content_index::IndexError::Capacity => CommandError::new(
            "resource_limit",
            "The encrypted search operation exceeded its fixed budget",
        ),
        agent_workspace_content_index::IndexError::Disabled => provider_unavailable(),
        agent_workspace_content_index::IndexError::UnsafeDatabase
        | agent_workspace_content_index::IndexError::Database
        | agent_workspace_content_index::IndexError::Crypto => CommandError::new(
            "runtime_unavailable",
            "The encrypted search index is unavailable",
        ),
    }
}
fn content_error(error: &agent_workspace_content::ContentError) -> CommandError {
    match error {
        agent_workspace_content::ContentError::Unauthorized
        | agent_workspace_content::ContentError::InvalidPath
        | agent_workspace_content::ContentError::UnsafeObject => {
            CommandError::new("unauthorized", "The opaque document is not authorized")
        }
        agent_workspace_content::ContentError::IdentityChanged
        | agent_workspace_content::ContentError::Conflict => {
            CommandError::new("stale_revision", "The opaque document identity changed")
        }
        agent_workspace_content::ContentError::Oversized
        | agent_workspace_content::ContentError::ResourceLimit => {
            CommandError::new("resource_limit", "The content exceeds its fixed bound")
        }
        agent_workspace_content::ContentError::UnsupportedEncoding => CommandError::new(
            "unsupported_encoding",
            "The content encoding is unsupported",
        ),
        agent_workspace_content::ContentError::Cancelled => {
            CommandError::new("cancelled", "The bounded operation was cancelled")
        }
        agent_workspace_content::ContentError::Io => internal(),
    }
}
fn content_preview(
    document: &agent_workspace_protocol::OpaqueDocumentRef,
    display_name: &str,
    result: Result<agent_workspace_protocol::ContentChunk, agent_workspace_content::ContentError>,
) -> Result<agent_workspace_protocol::ContentPreview, CommandError> {
    use agent_workspace_content::ContentError;
    use agent_workspace_protocol::{ContentPreview, ContentUnavailableReason};

    match result {
        Ok(chunk)
            if chunk.text.chars().any(|character| {
                character.is_control() && !matches!(character, '\n' | '\r' | '\t')
            }) =>
        {
            Ok(ContentPreview::Unavailable {
                document: chunk.document,
                reason: ContentUnavailableReason::Binary,
                display_name: chunk.display_name,
            })
        }
        Ok(chunk) => Ok(ContentPreview::Text { chunk }),
        Err(ContentError::Oversized | ContentError::ResourceLimit) => {
            Ok(ContentPreview::Unavailable {
                document: document.clone(),
                reason: ContentUnavailableReason::Oversized,
                display_name: display_name.to_owned(),
            })
        }
        Err(ContentError::UnsupportedEncoding) => Ok(ContentPreview::Unavailable {
            document: document.clone(),
            reason: ContentUnavailableReason::UnsupportedEncoding,
            display_name: display_name.to_owned(),
        }),
        Err(error) => Err(content_error(&error)),
    }
}
const fn provider_unavailable() -> CommandError {
    CommandError::new(
        "provider_unavailable",
        "The required trusted provider is unavailable",
    )
}
fn provider_error(error: &'static str) -> CommandError {
    match error {
        "target_not_found" => not_found(),
        "target_stale" => stale_target(),
        "provider_backpressure" => CommandError::new(
            "resource_limit",
            "The trusted provider queue reached its bound",
        ),
        _ => provider_unavailable(),
    }
}
const fn stale_target() -> CommandError {
    CommandError::new("stale_revision", "The exact task target changed")
}
const fn invalid_params() -> CommandError {
    CommandError::new("invalid_params", "The fixed task contract is invalid")
}
const fn not_found() -> CommandError {
    CommandError::new(
        "target_not_found",
        "The requested sidebar object does not exist",
    )
}
const fn internal() -> CommandError {
    CommandError::new(
        "runtime_unavailable",
        "The sidebar runtime could not complete the request",
    )
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .unwrap_or(0)
}
fn remote_lifecycle(state: agent_workspace_storage::RemoteSessionStateRecord) -> TaskLifecycle {
    use agent_workspace_storage::RemoteSessionStateRecord as S;
    match state {
        S::Created | S::TrustRequired | S::CredentialRequired | S::Connecting | S::Reconnecting => {
            TaskLifecycle::Created
        }
        S::Connected => TaskLifecycle::Running,
        S::Detached => TaskLifecycle::Detached,
        S::Failed => TaskLifecycle::Failed,
        S::Closed => TaskLifecycle::Terminated,
    }
}
fn remote_observation(value: &str) -> TaskObservation {
    match value {
        "lastVerified" => TaskObservation::LastVerified,
        "lost" => TaskObservation::Lost,
        _ => TaskObservation::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_registry_is_closed_and_has_no_generic_escape_hatch() {
        assert!(is_command("textbox.create"));
        assert!(is_command("task.action"));
        assert!(is_command("content.root.list"));
        assert!(is_command("content.directory.list"));
        assert!(!is_command("content.execute"));
        assert!(!is_command("filesystem.readPath"));
        assert!(!is_command("process.signal"));
    }

    #[test]
    fn privileged_provider_failure_is_content_free() {
        let error = provider_unavailable();
        assert_eq!(error.code, "provider_unavailable");
        for forbidden in ["/", "sqlite", "pid", "key", "transcript"] {
            assert!(!error.message.to_ascii_lowercase().contains(forbidden));
        }
    }

    #[test]
    fn content_read_returns_safe_unavailable_previews() {
        let document = agent_workspace_protocol::OpaqueDocumentRef {
            document_id: Uuid::new_v4().to_string(),
            identity_version: 1,
        };
        let binary = agent_workspace_protocol::ContentChunk {
            document: document.clone(),
            offset: 0,
            text: "text\0binary".into(),
            eof: true,
            content_revision: 1,
            display_name: "binary.dat".into(),
        };
        assert!(matches!(
            content_preview(&document, "binary.dat", Ok(binary)).unwrap(),
            agent_workspace_protocol::ContentPreview::Unavailable {
                reason: agent_workspace_protocol::ContentUnavailableReason::Binary,
                ..
            }
        ));
        assert!(matches!(
            content_preview(
                &document,
                "canonical.bin",
                Err(agent_workspace_content::ContentError::UnsupportedEncoding)
            )
            .unwrap(),
            agent_workspace_protocol::ContentPreview::Unavailable {
                reason: agent_workspace_protocol::ContentUnavailableReason::UnsupportedEncoding,
                display_name,
                ..
            } if display_name == "canonical.bin"
        ));
        assert!(matches!(
            content_preview(
                &document,
                "canonical.large",
                Err(agent_workspace_content::ContentError::Oversized)
            )
            .unwrap(),
            agent_workspace_protocol::ContentPreview::Unavailable {
                reason: agent_workspace_protocol::ContentUnavailableReason::Oversized,
                display_name,
                ..
            } if display_name == "canonical.large"
        ));
    }

    #[test]
    fn export_artifact_is_bounded_opaque_and_confirmation_bound() {
        let source = Uuid::new_v4();
        let content = export_artifact_content(
            source,
            &agent_workspace_content_index::IndexExportSummary {
                schema_version: 1,
                authorized_sources: 1,
                documents: 2,
                tokens: 5,
            },
            10,
        )
        .unwrap();
        assert!(content.len() <= agent_workspace_protocol::MAX_CONTENT_CHUNK_BYTES);
        assert!(content.contains(&source.to_string()));
        assert!(!content.contains('/'));
        let record = SearchExportConfirmationRecord {
            source,
            expires_at_ms: 20,
        };
        assert!(export_confirmation_matches(record, source, 20));
        assert!(!export_confirmation_matches(record, Uuid::new_v4(), 10));
        assert!(!export_confirmation_matches(record, source, 21));
    }

    #[test]
    fn cancellation_contract_is_opaque_and_fixed() {
        let value = serde_json::json!({"cancellationId": Uuid::new_v4()});
        assert!(parse::<SearchCancelParams>(value).is_ok());
        assert!(
            parse::<SearchCancelParams>(serde_json::json!({
                "cancellationId": Uuid::new_v4(),
                "path": "/tmp"
            }))
            .is_err()
        );
    }

    #[test]
    fn missing_terminal_owner_evidence_is_not_reported_running() {
        let manager = agent_workspace_terminal_runtime::TerminalManager::new();
        let io = manager.io_handle();
        assert_eq!(
            terminal_task_evidence(&io, Some("not-owned")),
            (TaskLifecycle::Detached, TaskObservation::Unknown)
        );
    }

    #[test]
    fn agent_task_lifecycle_is_derived_only_from_durable_catalog_state() {
        use agent_workspace_storage::AgentLifecycleRecord as S;
        assert_eq!(
            agent_task_lifecycle_from(S::Created, "none"),
            TaskLifecycle::Created
        );
        assert_eq!(
            agent_task_lifecycle_from(S::Running, "none"),
            TaskLifecycle::Running
        );
        assert_eq!(
            agent_task_lifecycle_from(S::Waiting, "none"),
            TaskLifecycle::Running
        );
        assert_eq!(
            agent_task_lifecycle_from(S::Hibernated, "none"),
            TaskLifecycle::Detached
        );
        assert_eq!(
            agent_task_lifecycle_from(S::Completed, "none"),
            TaskLifecycle::Succeeded
        );
        assert_eq!(
            agent_task_lifecycle_from(S::Completed, "taskCancelled"),
            TaskLifecycle::Cancelled
        );
        assert_eq!(
            agent_task_lifecycle_from(S::Unavailable, "none"),
            TaskLifecycle::Failed
        );
    }

    #[test]
    fn recently_closed_descriptors_bind_identity_revision_and_action() {
        let closed_id = Uuid::new_v4();
        let descriptor = ClosedDescriptor {
            closed_id,
            revision: 7,
            action: ReopenAction::ReopenTerminal,
        };
        assert!(closed_descriptor_matches(
            descriptor,
            closed_id,
            7,
            ReopenAction::ReopenTerminal
        ));
        assert!(!closed_descriptor_matches(
            descriptor,
            closed_id,
            8,
            ReopenAction::ReopenTerminal
        ));
        assert!(!closed_descriptor_matches(
            descriptor,
            closed_id,
            7,
            ReopenAction::ReopenBrowser
        ));
    }
}

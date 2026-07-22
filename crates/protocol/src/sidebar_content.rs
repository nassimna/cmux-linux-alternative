//! M8 sidebar, content, search, recently-closed, and authoritative-task contracts.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const SIDEBAR_SURFACE_COUNT: usize = 8;
pub const MAX_SIDEBAR_WINDOWS: usize = 16;
pub const MAX_TEXT_BOX_DOCUMENTS: usize = 64;
pub const MAX_TEXT_BOX_BYTES: usize = 256 * 1024;
pub const MAX_CONTENT_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_SEARCH_RESULTS: usize = 100;
pub const MAX_SEARCH_SNIPPET_SCALARS: usize = 512;
pub const MAX_M8_RECENTLY_CLOSED: usize = 100;
pub const MAX_WORKSPACE_ROOTS: usize = 64;
pub const MAX_WORKSPACE_DIRECTORY_ENTRIES: usize = 100;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const SIDEBAR_SURFACES_CAPABILITY: &str = "sidebar-surfaces-v1";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SidebarSurface {
    TextBox,
    Vault,
    TaskManager,
    Files,
    Markdown,
    Diff,
    Search,
    RecentlyClosed,
}

impl SidebarSurface {
    pub const ALL: [Self; SIDEBAR_SURFACE_COUNT] = [
        Self::TextBox,
        Self::Vault,
        Self::TaskManager,
        Self::Files,
        Self::Markdown,
        Self::Diff,
        Self::Search,
        Self::RecentlyClosed,
    ];
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SidebarSide {
    Left,
    Right,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SidebarPlacement {
    pub window_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub side: SidebarSide,
    pub width: u16,
    pub enabled: Vec<SidebarSurface>,
    pub order: Vec<SidebarSurface>,
    pub selected: SidebarSurface,
}

impl<'de> Deserialize<'de> for SidebarPlacement {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Raw {
            window_id: String,
            revision: u64,
            side: SidebarSide,
            width: u16,
            enabled: Vec<SidebarSurface>,
            order: Vec<SidebarSurface>,
            selected: SidebarSurface,
        }
        let v = Raw::deserialize(d)?;
        uuid(&v.window_id).map_err(serde::de::Error::custom)?;
        if v.revision == 0 || v.revision > MAX_SAFE_INTEGER || !(240..=720).contains(&v.width) {
            return Err(serde::de::Error::custom(
                "invalid sidebar revision or width",
            ));
        }
        if v.order.len() != SIDEBAR_SURFACE_COUNT
            || v.enabled.len() > SIDEBAR_SURFACE_COUNT
            || has_duplicates(&v.order)
            || has_duplicates(&v.enabled)
            || !SidebarSurface::ALL.iter().all(|s| v.order.contains(s))
            || !v.enabled.contains(&v.selected)
        {
            return Err(serde::de::Error::custom("invalid closed sidebar registry"));
        }
        Ok(Self {
            window_id: v.window_id,
            revision: v.revision,
            side: v.side,
            width: v.width,
            enabled: v.enabled,
            order: v.order,
            selected: v.selected,
        })
    }
}

fn has_duplicates(values: &[SidebarSurface]) -> bool {
    values
        .iter()
        .enumerate()
        .any(|(i, v)| values[..i].contains(v))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct OpaqueDocumentRef {
    #[serde(deserialize_with = "uuid_string")]
    pub document_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub identity_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ContentUnavailableReason {
    Binary,
    Oversized,
    UnsupportedEncoding,
    Unauthorized,
    Changed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentChunk {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "safe")]
    #[ts(type = "number")]
    pub offset: u64,
    #[serde(deserialize_with = "bounded_chunk")]
    pub text: String,
    pub eof: bool,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub content_revision: u64,
    #[serde(deserialize_with = "display_name")]
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ContentPreview {
    Text {
        chunk: ContentChunk,
    },
    Unavailable {
        document: OpaqueDocumentRef,
        reason: ContentUnavailableReason,
        #[serde(rename = "displayName")]
        #[ts(rename = "displayName")]
        #[serde(deserialize_with = "display_name")]
        display_name: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub enum SafeMarkdownNode {
    Heading {
        level: u8,
        children: Vec<SafeMarkdownNode>,
    },
    Paragraph {
        children: Vec<SafeMarkdownNode>,
    },
    List {
        ordered: bool,
        items: Vec<SafeMarkdownNode>,
    },
    ListItem {
        children: Vec<SafeMarkdownNode>,
    },
    Emphasis {
        children: Vec<SafeMarkdownNode>,
    },
    Strong {
        children: Vec<SafeMarkdownNode>,
    },
    Link {
        label: String,
        href: String,
    },
    Code {
        text: String,
    },
    CodeBlock {
        language: Option<String>,
        text: String,
    },
    Text {
        text: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SafeMarkdownDocument {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "markdown_nodes")]
    pub nodes: Vec<SafeMarkdownNode>,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub content_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentReadParams {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "safe")]
    #[ts(type = "number")]
    pub offset: u64,
    #[serde(deserialize_with = "chunk_limit")]
    pub max_bytes: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentSaveParams {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "bounded_save")]
    pub text: String,
    pub mutation: crate::RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentSaveResult {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub content_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TextBoxDocument {
    #[serde(deserialize_with = "uuid_string")]
    pub text_box_document_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    #[serde(deserialize_with = "textbox_text")]
    pub text: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub content_revision: u64,
    #[serde(deserialize_with = "safe")]
    #[ts(type = "number")]
    pub created_at_ms: u64,
    #[serde(deserialize_with = "safe")]
    #[ts(type = "number")]
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TextBoxSaveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub text_box_document_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "title")]
    pub title: String,
    #[serde(deserialize_with = "textbox_text")]
    pub text: String,
    pub mutation: crate::RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchQueryParams {
    #[serde(deserialize_with = "query")]
    pub query: String,
    #[serde(deserialize_with = "search_limit")]
    pub limit: u16,
    #[serde(deserialize_with = "uuid_string")]
    pub cancellation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchResult {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "snippet")]
    pub snippet: String,
    pub source_kind: SearchSourceKind,
    #[serde(deserialize_with = "safe")]
    #[ts(type = "number")]
    pub indexed_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SearchSourceKind {
    WorkspaceFile,
    AgentTranscript,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchQueryResult {
    #[serde(deserialize_with = "search_results")]
    pub results: Vec<SearchResult>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskKind {
    Terminal,
    Agent,
    BrowserAutomation,
    RemoteSession,
    CustomAction,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskLifecycle {
    Created,
    Running,
    Detaching,
    Cancelling,
    Terminating,
    ForceTerminating,
    Detached,
    Succeeded,
    Failed,
    Cancelled,
    Terminated,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskObservation {
    Unknown,
    LastVerified,
    Lost,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskTarget {
    #[serde(deserialize_with = "uuid_string")]
    pub session_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub generation: u64,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskSummary {
    pub target: TaskTarget,
    pub kind: TaskKind,
    #[serde(deserialize_with = "label")]
    pub label: String,
    pub lifecycle: TaskLifecycle,
    pub observation: TaskObservation,
    #[serde(deserialize_with = "label")]
    pub owner_label: String,
    #[serde(default, deserialize_with = "optional_resource")]
    pub resource_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskConfirmation {
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    pub action: TaskActionKind,
    pub kind: TaskKind,
    pub target: TaskTarget,
    #[serde(deserialize_with = "uuid_string")]
    pub provider_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub provider_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub provider_lease_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub window_generation: u64,
    #[serde(deserialize_with = "digest")]
    pub request_hash: String,
    #[serde(deserialize_with = "uuid_string")]
    pub nonce: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskActionKind {
    Detach,
    Cancel,
    Terminate,
    ForceTerminate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskWindowTarget {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub window_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskConfirmationIssueParams {
    pub action: TaskActionKind,
    pub target: TaskTarget,
    pub window: TaskWindowTarget,
    #[serde(deserialize_with = "digest")]
    pub request_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskConfirmationIssueResult {
    pub confirmation: TaskConfirmation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub enum TaskActionParams {
    Detach {
        target: TaskTarget,
        mutation: crate::RemoteMutationIdentity,
    },
    Cancel {
        target: TaskTarget,
        confirmation: TaskConfirmation,
        mutation: crate::RemoteMutationIdentity,
    },
    Terminate {
        target: TaskTarget,
        confirmation: TaskConfirmation,
        mutation: crate::RemoteMutationIdentity,
    },
    ForceTerminate {
        target: TaskTarget,
        confirmation: TaskConfirmation,
        mutation: crate::RemoteMutationIdentity,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReopenAction {
    ReopenTerminal,
    ReopenAgent,
    ReopenBrowser,
    ReconnectRemote,
    ReinvokeAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RecentlyClosedRecord {
    #[serde(deserialize_with = "uuid_string")]
    pub recently_closed_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub authorized_descriptor_id: String,
    pub action: ReopenAction,
    #[serde(deserialize_with = "label")]
    pub label: String,
    #[serde(deserialize_with = "safe")]
    #[ts(type = "number")]
    pub closed_at_ms: u64,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RecentlyClosedReopenParams {
    #[serde(deserialize_with = "uuid_string")]
    pub recently_closed_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub authorized_descriptor_id: String,
    pub action: ReopenAction,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    pub target: crate::ExactTabPlacement,
    pub mutation: crate::RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SidebarGetParams {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SidebarSaveParams {
    pub placement: SidebarPlacement,
    pub mutation: crate::RemoteMutationIdentity,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SidebarListResult {
    #[serde(deserialize_with = "sidebar_placements")]
    pub placements: Vec<SidebarPlacement>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AuthorizedDocumentKind {
    PlainText,
    Markdown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkspaceEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceRootDescriptor {
    #[serde(deserialize_with = "uuid_string")]
    pub root_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub directory_descriptor_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "display_name")]
    pub label: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceRootListResult {
    #[serde(deserialize_with = "workspace_roots")]
    pub roots: Vec<WorkspaceRootDescriptor>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceDirectoryListParams {
    #[serde(deserialize_with = "uuid_string")]
    pub directory_descriptor_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub generation: u64,
    #[serde(deserialize_with = "list_limit")]
    pub limit: u16,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub cursor: Option<String>,
    #[serde(deserialize_with = "uuid_string")]
    pub cancellation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceDirectoryEntry {
    #[serde(deserialize_with = "uuid_string")]
    pub entry_descriptor_id: String,
    pub kind: WorkspaceEntryKind,
    #[serde(deserialize_with = "display_name")]
    pub label: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceDirectoryListResult {
    #[serde(deserialize_with = "workspace_entries")]
    pub entries: Vec<WorkspaceDirectoryEntry>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentDocumentIssueParams {
    #[serde(deserialize_with = "uuid_string")]
    pub authorized_descriptor_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub descriptor_generation: u64,
    pub expected_kind: AuthorizedDocumentKind,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentDocumentIssueResult {
    pub document: OpaqueDocumentRef,
    #[serde(deserialize_with = "display_name")]
    pub display_name: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentMarkdownParams {
    pub document: OpaqueDocumentRef,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentDiffParams {
    pub before: OpaqueDocumentRef,
    pub after: OpaqueDocumentRef,
    #[serde(deserialize_with = "chunk_limit")]
    pub max_bytes: u32,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SafeDiffLineKind {
    Context,
    Added,
    Removed,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SafeDiffLine {
    pub kind: SafeDiffLineKind,
    #[serde(deserialize_with = "diff_text")]
    pub text: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ContentDiffResult {
    #[serde(deserialize_with = "diff_lines")]
    pub lines: Vec<SafeDiffLine>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TextBoxCreateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub text_box_document_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    #[serde(deserialize_with = "textbox_text")]
    pub text: String,
    pub mutation: crate::RemoteMutationIdentity,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BoundedListParams {
    #[serde(deserialize_with = "list_limit")]
    pub limit: u16,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TextBoxListResult {
    #[serde(deserialize_with = "textbox_documents")]
    pub documents: Vec<TextBoxDocument>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TextBoxIdParams {
    #[serde(deserialize_with = "uuid_string")]
    pub text_box_document_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TextBoxDeleteParams {
    #[serde(deserialize_with = "uuid_string")]
    pub text_box_document_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub mutation: crate::RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchCancelParams {
    #[serde(deserialize_with = "uuid_string")]
    pub cancellation_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchCancelResult {
    pub cancelled: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchSourcePolicyParams {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    pub source_kind: SearchSourceKind,
    #[serde(deserialize_with = "retention_days")]
    pub retention_days: u16,
    #[serde(deserialize_with = "exclusion_ids")]
    pub exclusion_ids: Vec<String>,
    pub mutation: crate::RemoteMutationIdentity,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchSourceMutationParams {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    pub mutation: crate::RemoteMutationIdentity,
}
pub type SearchForgetParams = SearchSourceMutationParams;
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchRebuildParams {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub cancellation_id: String,
    pub mutation: crate::RemoteMutationIdentity,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchExportParams {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub confirmation_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchExportConfirmationIssueParams {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchExportConfirmation {
    #[serde(deserialize_with = "uuid_string")]
    pub confirmation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchExportConfirmationIssueResult {
    pub confirmation: SearchExportConfirmation,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchExportResult {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    pub artifact: ContentChunk,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SearchControlResult {
    #[serde(deserialize_with = "uuid_string")]
    pub source_authorization_id: String,
    pub state: SearchControlState,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub revision: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SearchControlState {
    Enabled,
    Excluded,
    Forgotten,
    Rebuilding,
    ExportReady,
    PausedLimit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskListParams {
    #[serde(default, deserialize_with = "optional_non_null")]
    pub kind: Option<TaskKind>,
    #[serde(default, deserialize_with = "optional_non_null")]
    pub lifecycle: Option<TaskLifecycle>,
    #[serde(deserialize_with = "list_limit")]
    pub limit: u16,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub cursor: Option<String>,
    #[serde(deserialize_with = "uuid_string")]
    pub cancellation_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskListResult {
    #[serde(deserialize_with = "tasks")]
    pub tasks: Vec<TaskSummary>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskActionResult {
    pub target: TaskTarget,
    pub lifecycle: TaskLifecycle,
    pub observation: TaskObservation,
    pub outcome: TaskActionOutcome,
    #[serde(deserialize_with = "positive_safe")]
    #[ts(type = "number")]
    pub revision: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskActionOutcome {
    Accepted,
    AlreadyConverged,
    StaleTarget,
    ProviderLost,
    ConfirmationExpired,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RecentlyClosedListResult {
    #[serde(deserialize_with = "recent_records")]
    pub records: Vec<RecentlyClosedRecord>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub next_cursor: Option<String>,
}

fn uuid(v: &str) -> Result<(), String> {
    Uuid::parse_str(v)
        .map(|_| ())
        .map_err(|_| "invalid opaque UUID".into())
}
fn uuid_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    uuid(&v).map_err(serde::de::Error::custom)?;
    Ok(v)
}
fn safe<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = u64::deserialize(d)?;
    (v <= MAX_SAFE_INTEGER)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("unsafe integer"))
}
fn positive_safe<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = safe(d)?;
    (v > 0)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("expected positive integer"))
}
fn bounded_string<'de, D: Deserializer<'de>>(d: D, max: usize) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    (!v.chars().any(char::is_control) && v.chars().count() <= max)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("invalid bounded string"))
}
fn title<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = bounded_string(d, 120)?;
    (!v.trim().is_empty())
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("empty title"))
}
fn label<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = bounded_string(d, 256)?;
    (!v.trim().is_empty())
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("empty label"))
}
fn query<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = bounded_string(d, 512)?;
    (!v.trim().is_empty())
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("empty query"))
}
fn snippet<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded_string(d, MAX_SEARCH_SNIPPET_SCALARS)
}
fn textbox_text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    (v.len() <= MAX_TEXT_BOX_BYTES)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("TextBox overflow"))
}
fn bounded_chunk<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    (v.len() <= MAX_CONTENT_CHUNK_BYTES)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("content chunk overflow"))
}
fn bounded_save<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    (v.len() <= MAX_TEXT_BOX_BYTES)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("save overflow"))
}
fn display_name<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = bounded_string(d, 256)?;
    (!v.trim().is_empty())
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("invalid display name"))
}
fn optional_resource<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v = bounded_string(d, 512)?;
    Ok(Some(v))
}
fn optional_uuid<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(d)?;
    value
        .map(|value| {
            (Uuid::parse_str(&value).is_ok() && value.len() == 36)
                .then_some(value)
                .ok_or_else(|| serde::de::Error::custom("invalid UUID"))
        })
        .transpose()
}
fn optional_non_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
fn list_limit<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let v = u16::deserialize(d)?;
    (v > 0 && v <= 100)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("invalid list limit"))
}
fn retention_days<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let v = u16::deserialize(d)?;
    (v > 0 && v <= 365)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("invalid retention"))
}
fn sidebar_placements<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<SidebarPlacement>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= MAX_SIDEBAR_WINDOWS)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many sidebar windows"))
}
fn textbox_documents<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<TextBoxDocument>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= MAX_TEXT_BOX_DOCUMENTS)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many TextBox documents"))
}
fn tasks<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<TaskSummary>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= 100)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many tasks"))
}
fn recent_records<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<RecentlyClosedRecord>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= MAX_M8_RECENTLY_CLOSED)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many recently-closed records"))
}
fn workspace_roots<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<WorkspaceRootDescriptor>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= MAX_WORKSPACE_ROOTS)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many workspace roots"))
}
fn workspace_entries<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<WorkspaceDirectoryEntry>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= MAX_WORKSPACE_DIRECTORY_ENTRIES)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many workspace entries"))
}
fn exclusion_ids<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    let v = Vec::<String>::deserialize(d)?;
    if v.len() > 256 {
        return Err(serde::de::Error::custom("too many exclusions"));
    }
    let mut seen = std::collections::HashSet::new();
    for id in &v {
        uuid(id).map_err(serde::de::Error::custom)?;
        if !seen.insert(id) {
            return Err(serde::de::Error::custom("duplicate exclusion"));
        }
    }
    Ok(v)
}
fn diff_text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded_string(d, 16_384)
}
fn diff_lines<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<SafeDiffLine>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= 4096)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many diff lines"))
}
fn chunk_limit<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = u32::deserialize(d)?;
    (v > 0 && v as usize <= MAX_CONTENT_CHUNK_BYTES)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("invalid chunk bound"))
}
fn search_limit<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let v = u16::deserialize(d)?;
    (v > 0 && v as usize <= MAX_SEARCH_RESULTS)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("invalid search limit"))
}
fn digest<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = String::deserialize(d)?;
    (v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(v)
    .ok_or_else(|| serde::de::Error::custom("invalid digest"))
}
fn markdown_nodes<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<SafeMarkdownNode>, D::Error> {
    let v = Vec::deserialize(d)?;
    let mut total = 0usize;
    for node in &v {
        validate_markdown_node(node, 1, &mut total).map_err(serde::de::Error::custom)?;
    }
    Ok(v)
}
fn validate_markdown_node(
    node: &SafeMarkdownNode,
    depth: usize,
    total: &mut usize,
) -> Result<(), &'static str> {
    if depth > 16 || *total >= 4096 {
        return Err("markdown AST bound exceeded");
    }
    *total += 1;
    let children = match node {
        SafeMarkdownNode::Heading { level, children } => {
            if !(1..=6).contains(level) {
                return Err("invalid heading level");
            }
            Some(children)
        }
        SafeMarkdownNode::Paragraph { children }
        | SafeMarkdownNode::ListItem { children }
        | SafeMarkdownNode::Emphasis { children }
        | SafeMarkdownNode::Strong { children } => Some(children),
        SafeMarkdownNode::List { items, .. } => Some(items),
        SafeMarkdownNode::Link { label, href } => {
            if label.chars().count() > 2048 || href.len() > 2048 {
                return Err("link overflow");
            }
            let url = url::Url::parse(href).map_err(|_| "invalid link")?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("unsafe link");
            }
            None
        }
        SafeMarkdownNode::Code { text } | SafeMarkdownNode::Text { text } => {
            if text.chars().count() > 16_384 {
                return Err("markdown text overflow");
            }
            None
        }
        SafeMarkdownNode::CodeBlock { language, text } => {
            if language
                .as_ref()
                .is_some_and(|v| v.chars().count() > 32 || v.chars().any(char::is_control))
                || text.chars().count() > 65_536
            {
                return Err("code block overflow");
            }
            None
        }
    };
    if let Some(children) = children {
        if children.len() > 1024 {
            return Err("markdown child bound exceeded");
        }
        for child in children {
            validate_markdown_node(child, depth + 1, total)?;
        }
    }
    Ok(())
}
fn search_results<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<SearchResult>, D::Error> {
    let v = Vec::deserialize(d)?;
    (v.len() <= MAX_SEARCH_RESULTS)
        .then_some(v)
        .ok_or_else(|| serde::de::Error::custom("too many search results"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn optional_uuid_contract_round_trips_absence_as_null() {
        let params: BoundedListParams = serde_json::from_value(json!({ "limit": 100 })).unwrap();
        let serialized = serde_json::to_value(&params).unwrap();
        assert_eq!(serialized.get("cursor"), Some(&json!(null)));
        assert_eq!(
            serde_json::from_value::<BoundedListParams>(serialized)
                .unwrap()
                .cursor,
            None
        );
    }
    #[test]
    fn sidebar_registry_is_exact() {
        let all = json!([
            "textBox",
            "vault",
            "taskManager",
            "files",
            "markdown",
            "diff",
            "search",
            "recentlyClosed"
        ]);
        assert!(serde_json::from_value::<SidebarPlacement>(json!({"windowId":Uuid::new_v4(),"revision":1,"side":"right","width":320,"enabled":all,"order":["textBox","vault","taskManager","files","markdown","diff","search","recentlyClosed"],"selected":"textBox"})).is_ok());
    }
    #[test]
    fn public_tasks_reject_pid_and_unconfirmed_destruction() {
        let target = json!({"sessionId":Uuid::new_v4(),"generation":1,"revision":1});
        assert!(serde_json::from_value::<TaskActionParams>(json!({"action":"terminate","target":target,"mutation":{"idempotencyKey":Uuid::new_v4(),"requestHash":"a".repeat(64),"expectedRevision":1}})).is_err());
        let issue = serde_json::from_value::<TaskConfirmationIssueParams>(json!({
            "action":"terminate",
            "target":target.clone(),
            "window":{"windowId":Uuid::new_v4(),"windowGeneration":2},
            "requestHash":"a".repeat(64)
        }))
        .unwrap();
        let confirmation = json!({
            "invocationId":Uuid::new_v4(),
            "action":"terminate",
            "kind":"agent",
            "target":target.clone(),
            "providerId":Uuid::new_v4(),
            "providerEpoch":3,
            "providerLeaseId":Uuid::new_v4(),
            "windowId":issue.window.window_id,
            "windowGeneration":2,
            "requestHash":"a".repeat(64),
            "nonce":Uuid::new_v4(),
            "expiresAtMs":100
        });
        assert!(serde_json::from_value::<TaskActionParams>(json!({
            "action":"terminate",
            "target":target.clone(),
            "confirmation":confirmation,
            "mutation":{"idempotencyKey":Uuid::new_v4(),"requestHash":"a".repeat(64),"expectedRevision":1}
        })).is_ok());
        let incomplete = json!({
            "invocationId":Uuid::new_v4(),"providerId":Uuid::new_v4(),"windowId":Uuid::new_v4(),
            "requestHash":"a".repeat(64),"expiresAtMs":100
        });
        assert!(serde_json::from_value::<TaskConfirmation>(incomplete).is_err());
        assert!(
            serde_json::from_value::<TaskTarget>(
                json!({"sessionId":Uuid::new_v4(),"generation":1,"revision":1,"pid":42})
            )
            .is_err()
        );
    }
    #[test]
    fn content_bounds_are_strict() {
        assert!(serde_json::from_value::<ContentReadParams>(json!({"document":{"documentId":Uuid::new_v4(),"identityVersion":1},"offset":0,"maxBytes":65537})).is_err());
        assert!(serde_json::from_value::<TextBoxSaveParams>(json!({"textBoxDocumentId":Uuid::new_v4(),"expectedRevision":1,"title":"x","text":"x".repeat(MAX_TEXT_BOX_BYTES+1),"mutation":{"idempotencyKey":Uuid::new_v4(),"requestHash":"a".repeat(64),"expectedRevision":1}})).is_err());
    }
    #[test]
    fn unavailable_preview_uses_canonical_camel_case_wire_name() {
        let document = OpaqueDocumentRef {
            document_id: Uuid::new_v4().to_string(),
            identity_version: 1,
        };
        let value = serde_json::to_value(ContentPreview::Unavailable {
            document,
            reason: ContentUnavailableReason::Oversized,
            display_name: "Unavailable document".into(),
        })
        .unwrap();
        assert_eq!(
            value.get("displayName"),
            Some(&json!("Unavailable document"))
        );
        assert!(value.get("display_name").is_none());
    }
    #[test]
    fn recently_closed_reopen_requires_an_independent_descriptor() {
        assert!(serde_json::from_value::<RecentlyClosedReopenParams>(json!({
            "recentlyClosedId": Uuid::new_v4(),
            "action": "reopenTerminal",
            "expectedRevision": 1,
            "mutation": {"idempotencyKey":Uuid::new_v4(),"requestHash":"a".repeat(64),"expectedRevision":1}
        })).is_err());
    }
    #[test]
    fn explorer_contracts_are_opaque_bounded_and_cancellable() {
        assert!(
            serde_json::from_value::<WorkspaceDirectoryListParams>(json!({
                "directoryDescriptorId": Uuid::new_v4(),
                "generation": 1,
                "limit": 100,
                "cancellationId": Uuid::new_v4()
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<WorkspaceDirectoryListParams>(json!({
                "directoryDescriptorId": Uuid::new_v4(),
                "generation": 1,
                "limit": 101,
                "cancellationId": Uuid::new_v4(),
                "path": "/tmp"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<SearchRebuildParams>(json!({
                "sourceAuthorizationId": Uuid::new_v4(),
                "cancellationId": Uuid::new_v4(),
                "mutation": {
                    "idempotencyKey": Uuid::new_v4(),
                    "requestHash": "a".repeat(64),
                    "expectedRevision": 1
                }
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<SearchRebuildParams>(json!({
                "sourceAuthorizationId": Uuid::new_v4(),
                "mutation": {
                    "idempotencyKey": Uuid::new_v4(),
                    "requestHash": "a".repeat(64),
                    "expectedRevision": 1
                }
            }))
            .is_err()
        );
    }
}

//! Ephemeral, fixed-shape workspace card-slot wire contracts.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_CARD_SLOT_LABEL_SCALARS: usize = 120;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentStatus {
    Idle,
    Running,
    Waiting,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentStatusCardSlot {
    pub status: AgentStatus,
    pub label: Option<String>,
}

impl<'de> Deserialize<'de> for AgentStatusCardSlot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            status: AgentStatus,
            #[serde(deserialize_with = "required_nullable_label")]
            label: Option<String>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            status: wire.status,
            label: wire.label,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "mode",
    deny_unknown_fields
)]
#[ts(export)]
pub enum ProgressCardSlot {
    Determinate {
        #[serde(deserialize_with = "progress_value")]
        value: u8,
        #[serde(deserialize_with = "required_nullable_label")]
        label: Option<String>,
    },
    Indeterminate {
        #[serde(deserialize_with = "label")]
        label: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotsSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "required_nullable_agent_status")]
    pub agent_status: Option<AgentStatusCardSlot>,
    #[serde(deserialize_with = "required_nullable_progress")]
    pub progress: Option<ProgressCardSlot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotsSnapshotParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotsReplaceParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "required_nullable_agent_status")]
    pub agent_status: Option<AgentStatusCardSlot>,
    #[serde(deserialize_with = "required_nullable_progress")]
    pub progress: Option<ProgressCardSlot>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkspaceCardSlotsChangeReason {
    SlotsReplaced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotsChangedEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub slot_revision: u64,
    pub reason: WorkspaceCardSlotsChangeReason,
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
    uuid::Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn validate_label<E>(value: &str) -> Result<(), E>
where
    E: serde::de::Error,
{
    if value.is_empty()
        || value != value.trim()
        || value.chars().count() > MAX_CARD_SLOT_LABEL_SCALARS
        || value.chars().any(char::is_control)
    {
        return Err(E::custom(
            "card-slot label must be normalized, non-empty, control-free, and at most 120 characters",
        ));
    }
    Ok(())
}

fn label<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_label::<D::Error>(&value)?;
    Ok(value)
}

fn required_nullable_label<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(label) = &value {
        validate_label::<D::Error>(label)?;
    }
    Ok(value)
}

fn required_nullable_agent_status<'de, D>(
    deserializer: D,
) -> Result<Option<AgentStatusCardSlot>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<AgentStatusCardSlot>::deserialize(deserializer)
}

fn required_nullable_progress<'de, D>(deserializer: D) -> Result<Option<ProgressCardSlot>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<ProgressCardSlot>::deserialize(deserializer)
}

fn progress_value<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if value > 100 {
        return Err(serde::de::Error::custom(
            "determinate progress must be within 0..=100",
        ));
    }
    Ok(value)
}

pub const MAX_CARD_SLOT_V2_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkspaceCardSlotV2Kind {
    AgentStatus,
    Progress,
    PullRequest,
    Metadata,
    Markdown,
    LogTail,
    Task,
    Ssh,
    Media,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PullRequestLifecycleState {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PullRequestChecksState {
    Unknown,
    Pending,
    Passing,
    Failing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PullRequestCardSlot {
    #[serde(deserialize_with = "provider_label")]
    pub provider: String,
    #[serde(deserialize_with = "positive_u64")]
    #[ts(type = "number")]
    pub number: u64,
    #[serde(deserialize_with = "title_160")]
    pub title: String,
    pub lifecycle: PullRequestLifecycleState,
    pub checks: PullRequestChecksState,
    #[serde(deserialize_with = "optional_https_url")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MetadataCardSlotRow {
    #[serde(deserialize_with = "metadata_key")]
    pub key: String,
    #[serde(deserialize_with = "label")]
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MetadataCardSlot {
    #[serde(deserialize_with = "metadata_rows")]
    pub rows: Vec<MetadataCardSlotRow>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MarkdownCardSlot {
    #[serde(deserialize_with = "markdown_source")]
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LogTailCardSlot {
    #[serde(deserialize_with = "log_lines")]
    pub lines: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskCardSlotItemState {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskCardSlotItem {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "title_160")]
    pub label: String,
    pub state: TaskCardSlotItemState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TaskCardSlot {
    #[serde(deserialize_with = "label")]
    pub title: String,
    #[serde(deserialize_with = "task_items")]
    pub items: Vec<TaskCardSlotItem>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SshCardSlotState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Detached,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SshCardSlot {
    #[serde(deserialize_with = "label")]
    pub label: String,
    pub state: SshCardSlotState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MediaCardSlotKind {
    Audio,
    Video,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MediaCardSlotState {
    Idle,
    Playing,
    Paused,
    Buffering,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MediaCardSlot {
    pub media_kind: MediaCardSlotKind,
    pub state: MediaCardSlotState,
    #[serde(deserialize_with = "title_160")]
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "value",
    deny_unknown_fields
)]
#[ts(export)]
pub enum WorkspaceCardSlotV2Payload {
    AgentStatus(AgentStatusCardSlot),
    Progress(ProgressCardSlot),
    PullRequest(PullRequestCardSlot),
    Metadata(MetadataCardSlot),
    Markdown(MarkdownCardSlot),
    LogTail(LogTailCardSlot),
    Task(TaskCardSlot),
    Ssh(SshCardSlot),
    Media(MediaCardSlot),
}

impl WorkspaceCardSlotV2Payload {
    #[must_use]
    pub const fn kind(&self) -> WorkspaceCardSlotV2Kind {
        match self {
            Self::AgentStatus(_) => WorkspaceCardSlotV2Kind::AgentStatus,
            Self::Progress(_) => WorkspaceCardSlotV2Kind::Progress,
            Self::PullRequest(_) => WorkspaceCardSlotV2Kind::PullRequest,
            Self::Metadata(_) => WorkspaceCardSlotV2Kind::Metadata,
            Self::Markdown(_) => WorkspaceCardSlotV2Kind::Markdown,
            Self::LogTail(_) => WorkspaceCardSlotV2Kind::LogTail,
            Self::Task(_) => WorkspaceCardSlotV2Kind::Task,
            Self::Ssh(_) => WorkspaceCardSlotV2Kind::Ssh,
            Self::Media(_) => WorkspaceCardSlotV2Kind::Media,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotV2Snapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub kind: WorkspaceCardSlotV2Kind,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub slot_revision: u64,
    #[serde(deserialize_with = "required_nullable_v2_payload")]
    pub payload: Option<WorkspaceCardSlotV2Payload>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotV2GetParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub kind: WorkspaceCardSlotV2Kind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotV2ReplaceParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub kind: WorkspaceCardSlotV2Kind,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "required_nullable_v2_payload")]
    pub payload: Option<WorkspaceCardSlotV2Payload>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkspaceCardSlotV2ChangeReason {
    SlotReplaced,
    ResyncRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCardSlotV2ChangedEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub kind: WorkspaceCardSlotV2Kind,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub slot_revision: u64,
    pub reason: WorkspaceCardSlotV2ChangeReason,
}

fn bounded_text<E: serde::de::Error>(value: &str, max: usize, name: &str) -> Result<(), E> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        return Err(E::custom(format!(
            "{name} must be normalized, non-empty, control-free, and at most {max} characters"
        )));
    }
    Ok(())
}

macro_rules! bounded_deserializer {
    ($name:ident, $max:expr, $description:literal) => {
        fn $name<'de, D>(deserializer: D) -> Result<String, D::Error>
        where
            D: Deserializer<'de>,
        {
            let value = String::deserialize(deserializer)?;
            bounded_text::<D::Error>(&value, $max, $description)?;
            Ok(value)
        }
    };
}

bounded_deserializer!(provider_label, 40, "pull-request provider");
bounded_deserializer!(metadata_key, 40, "metadata key");
bounded_deserializer!(title_160, 160, "card-slot text");

fn positive_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = safe_integer(deserializer)?;
    (value > 0)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("pull-request number must be positive"))
}

fn optional_https_url<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    let Some(value) = value else { return Ok(None) };
    bounded_text::<D::Error>(&value, 2048, "pull-request URL")?;
    if !is_canonical_https_url(&value) {
        return Err(serde::de::Error::custom(
            "pull-request URL must be a canonical credential-free HTTPS URL",
        ));
    }
    Ok(Some(value))
}

fn is_canonical_https_url(value: &str) -> bool {
    if !value.starts_with("https://")
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
        || value.contains('\\')
    {
        return false;
    }
    let authority = value["https://".len()..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority.contains(['@', '%']) {
        return false;
    }
    let (host, port) = if let Some(ipv6) = authority.strip_prefix('[') {
        let Some(close) = ipv6.find(']') else {
            return false;
        };
        let host = &ipv6[..close];
        let suffix = &ipv6[close + 1..];
        if !suffix.is_empty() && !suffix.starts_with(':') {
            return false;
        }
        if host.is_empty()
            || !host
                .chars()
                .all(|character| character.is_ascii_hexdigit() || matches!(character, ':' | '.'))
        {
            return false;
        }
        (host, suffix.strip_prefix(':'))
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        if host.is_empty()
            || host.split('.').any(|label| {
                label.is_empty()
                    || !label
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
                    || !label
                        .chars()
                        .next()
                        .is_some_and(|character| character.is_ascii_alphanumeric())
                    || !label
                        .chars()
                        .next_back()
                        .is_some_and(|character| character.is_ascii_alphanumeric())
            })
        {
            return false;
        }
        (host, port)
    };
    let _ = host;
    if let Some(port) = port {
        let Ok(port) = port.parse::<u16>() else {
            return false;
        };
        if port == 0 {
            return false;
        }
    }
    url::Url::parse(value).is_ok_and(|parsed| {
        parsed.scheme() == "https"
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
    })
}

fn metadata_rows<'de, D>(deserializer: D) -> Result<Vec<MetadataCardSlotRow>, D::Error>
where
    D: Deserializer<'de>,
{
    let rows = Vec::<MetadataCardSlotRow>::deserialize(deserializer)?;
    if rows.len() > 6 {
        return Err(serde::de::Error::custom(
            "metadata may contain at most 6 rows",
        ));
    }
    let mut keys = std::collections::BTreeSet::new();
    for row in &rows {
        let normalized = row.key.to_lowercase();
        if !keys.insert(normalized) {
            return Err(serde::de::Error::custom(
                "duplicate normalized metadata key",
            ));
        }
    }
    Ok(rows)
}

fn markdown_source<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value != value.trim()
        || value.is_empty()
        || value.chars().count() > 4096
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n')
    {
        return Err(serde::de::Error::custom(
            "Markdown source must be normalized, non-empty, control-free, and at most 4096 characters",
        ));
    }
    Ok(value)
}

fn log_lines<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let lines = Vec::<String>::deserialize(deserializer)?;
    if lines.len() > 20 {
        return Err(serde::de::Error::custom(
            "log tail may contain at most 20 lines",
        ));
    }
    for line in &lines {
        bounded_text::<D::Error>(line, 240, "log line")?;
        if line.contains('\u{1b}') {
            return Err(serde::de::Error::custom(
                "log lines must not contain ANSI escapes",
            ));
        }
    }
    Ok(lines)
}

fn task_items<'de, D>(deserializer: D) -> Result<Vec<TaskCardSlotItem>, D::Error>
where
    D: Deserializer<'de>,
{
    let items = Vec::<TaskCardSlotItem>::deserialize(deserializer)?;
    if items.len() > 12 {
        return Err(serde::de::Error::custom(
            "task may contain at most 12 items",
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    if items.iter().any(|item| !ids.insert(&item.id)) {
        return Err(serde::de::Error::custom("task item IDs must be unique"));
    }
    Ok(items)
}

fn required_nullable_v2_payload<'de, D>(
    deserializer: D,
) -> Result<Option<WorkspaceCardSlotV2Payload>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<WorkspaceCardSlotV2Payload>::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WORKSPACE_ID: &str = "10000000-0000-4000-8000-000000000001";

    fn replace_params() -> serde_json::Value {
        json!({
            "workspaceId": WORKSPACE_ID,
            "expectedRevision": 0,
            "agentStatus": { "status": "running", "label": "Reviewing changes" },
            "progress": { "mode": "determinate", "value": 42, "label": "Tests" }
        })
    }

    #[test]
    fn fixed_card_slots_accept_the_complete_bounded_shape() {
        assert!(
            serde_json::from_value::<WorkspaceCardSlotsReplaceParams>(replace_params()).is_ok()
        );
        assert!(
            serde_json::from_value::<WorkspaceCardSlotsReplaceParams>(json!({
                "workspaceId": WORKSPACE_ID,
                "expectedRevision": 0,
                "agentStatus": null,
                "progress": { "mode": "indeterminate", "label": "Indexing" }
            }))
            .is_ok()
        );
    }

    #[test]
    fn fixed_card_slots_reject_missing_unknown_and_unbounded_values() {
        let mut missing = replace_params();
        missing.as_object_mut().expect("object").remove("progress");
        assert!(serde_json::from_value::<WorkspaceCardSlotsReplaceParams>(missing).is_err());

        let mut unknown = replace_params();
        unknown["customSlot"] = json!({});
        assert!(serde_json::from_value::<WorkspaceCardSlotsReplaceParams>(unknown).is_err());

        for invalid in [
            json!({ "mode": "determinate", "value": 101, "label": null }),
            json!({ "mode": "indeterminate", "label": "" }),
            json!({ "mode": "indeterminate", "label": " line\nbreak " }),
            json!({ "mode": "indeterminate", "label": "x".repeat(MAX_CARD_SLOT_LABEL_SCALARS + 1) }),
        ] {
            let mut value = replace_params();
            value["progress"] = invalid;
            assert!(serde_json::from_value::<WorkspaceCardSlotsReplaceParams>(value).is_err());
        }
    }

    #[test]
    fn card_slot_revision_is_javascript_safe() {
        let mut value = replace_params();
        value["expectedRevision"] = json!(MAX_SAFE_INTEGER + 1);
        assert!(serde_json::from_value::<WorkspaceCardSlotsReplaceParams>(value).is_err());
    }

    #[test]
    fn card_slot_v2_accepts_matching_bounded_payloads_and_null() {
        for (kind, payload) in [
            (
                "agentStatus",
                json!({"kind":"agentStatus","value":{"status":"running","label":null}}),
            ),
            (
                "progress",
                json!({"kind":"progress","value":{"mode":"determinate","value":100,"label":"Done"}}),
            ),
            (
                "pullRequest",
                json!({"kind":"pullRequest","value":{"provider":"GitHub","number":42,"title":"Bounded slots","lifecycle":"open","checks":"passing","url":"https://example.com/pr/42"}}),
            ),
            (
                "metadata",
                json!({"kind":"metadata","value":{"rows":[{"key":"Branch","value":"main"}]}}),
            ),
            (
                "markdown",
                json!({"kind":"markdown","value":{"source":"# Notes\n\n`safe`"}}),
            ),
            (
                "logTail",
                json!({"kind":"logTail","value":{"lines":["tests passed"],"truncated":false}}),
            ),
            (
                "task",
                json!({"kind":"task","value":{"title":"Release","items":[{"id":"20000000-0000-4000-8000-000000000002","label":"Run tests","state":"completed"}]}}),
            ),
            (
                "ssh",
                json!({"kind":"ssh","value":{"label":"Production bastion","state":"connected"}}),
            ),
            (
                "media",
                json!({"kind":"media","value":{"mediaKind":"video","state":"paused","label":"Demo"}}),
            ),
        ] {
            let value = json!({
                "workspaceId": WORKSPACE_ID,
                "kind": kind,
                "expectedRevision": 0,
                "payload": payload
            });
            assert!(serde_json::from_value::<WorkspaceCardSlotV2ReplaceParams>(value).is_ok());
        }
        assert!(
            serde_json::from_value::<WorkspaceCardSlotV2ReplaceParams>(json!({
                "workspaceId": WORKSPACE_ID,
                "kind": "media",
                "expectedRevision": 0,
                "payload": null
            }))
            .is_ok()
        );
    }

    #[test]
    fn card_slot_v2_rejects_hostile_or_unbounded_payloads() {
        for (kind, payload) in [
            (
                "pullRequest",
                json!({"kind":"pullRequest","value":{"provider":"GitHub","number":1,"title":"Unsafe","lifecycle":"open","checks":"pending","url":"http://example.com"}}),
            ),
            (
                "metadata",
                json!({"kind":"metadata","value":{"rows":[{"key":"Branch","value":"main"},{"key":"branch","value":"other"}]}}),
            ),
            (
                "markdown",
                json!({"kind":"markdown","value":{"source":"unsafe\u{0000}"}}),
            ),
            (
                "logTail",
                json!({"kind":"logTail","value":{"lines":["\u{001b}[31mred"],"truncated":false}}),
            ),
            (
                "task",
                json!({"kind":"task","value":{"title":"Task","items":[{"id":"20000000-0000-4000-8000-000000000002","label":"One","state":"pending"},{"id":"20000000-0000-4000-8000-000000000002","label":"Two","state":"pending"}]}}),
            ),
            (
                "media",
                json!({"kind":"media","value":{"mediaKind":"video","state":"playing","label":"Demo","url":"https://evil.invalid"}}),
            ),
        ] {
            let value = json!({
                "workspaceId": WORKSPACE_ID,
                "kind": kind,
                "expectedRevision": 0,
                "payload": payload
            });
            assert!(serde_json::from_value::<WorkspaceCardSlotV2ReplaceParams>(value).is_err());
        }
    }

    #[test]
    fn pull_request_url_rejects_credentials_and_noncanonical_or_unsafe_variants() {
        for url in [
            "https://user:secret@example.com/pr/1",
            "HTTPS://example.com/pr/1",
            " https://example.com/pr/1",
            "https://example.com/pr/1\n",
            "https://example.com\\pr\\1",
            "http://example.com/pr/1",
            "file:///tmp/pr/1",
            "javascript:alert(1)",
        ] {
            let value = json!({
                "workspaceId": WORKSPACE_ID,
                "kind": "pullRequest",
                "expectedRevision": 0,
                "payload": {
                    "kind": "pullRequest",
                    "value": {
                        "provider": "GitHub",
                        "number": 1,
                        "title": "Unsafe",
                        "lifecycle": "open",
                        "checks": "pending",
                        "url": url
                    }
                }
            });
            assert!(
                serde_json::from_value::<WorkspaceCardSlotV2ReplaceParams>(value).is_err(),
                "URL must be rejected: {url:?}"
            );
        }
    }
}

//! Authoritative workspace-attention wire contracts.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Stable five-state presentation taxonomy. Ordering is defined by the service, not this enum.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AttentionState {
    None,
    Informational,
    Completed,
    Waiting,
    Urgent,
}

/// Closed explanation for the source which won the authoritative attention fold.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AttentionReason {
    None,
    NotificationInfo,
    NotificationWarning,
    NotificationError,
    AgentRunning,
    AgentWaiting,
    AgentCompleted,
    AgentFailed,
}

/// Latest-state projection for one workspace.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(try_from = "WorkspaceAttentionSnapshotWire", rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct WorkspaceAttentionSnapshot {
    pub workspace_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub state: AttentionState,
    pub reason: AttentionReason,
    pub unread_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceAttentionSnapshotWire {
    #[serde(deserialize_with = "uuid_string")]
    workspace_id: String,
    #[serde(deserialize_with = "safe_integer")]
    revision: u64,
    state: AttentionState,
    reason: AttentionReason,
    unread_count: u32,
    #[serde(default, deserialize_with = "optional_uuid")]
    notification_id: Option<String>,
    #[serde(default, deserialize_with = "optional_uuid")]
    pane_id: Option<String>,
    #[serde(default, deserialize_with = "optional_uuid")]
    tab_id: Option<String>,
}

impl TryFrom<WorkspaceAttentionSnapshotWire> for WorkspaceAttentionSnapshot {
    type Error = &'static str;

    fn try_from(value: WorkspaceAttentionSnapshotWire) -> Result<Self, Self::Error> {
        let valid_pair = matches!(
            (value.state, value.reason),
            (AttentionState::None, AttentionReason::None)
                | (
                    AttentionState::Informational,
                    AttentionReason::NotificationInfo
                        | AttentionReason::NotificationWarning
                        | AttentionReason::AgentRunning
                )
                | (AttentionState::Completed, AttentionReason::AgentCompleted)
                | (AttentionState::Waiting, AttentionReason::AgentWaiting)
                | (
                    AttentionState::Urgent,
                    AttentionReason::NotificationError | AttentionReason::AgentFailed
                )
        );
        let notification_reason = matches!(
            value.reason,
            AttentionReason::NotificationInfo
                | AttentionReason::NotificationWarning
                | AttentionReason::NotificationError
        );
        if !valid_pair
            || notification_reason != value.notification_id.is_some()
            || (value.state == AttentionState::None && value.unread_count != 0)
            || (value.reason == AttentionReason::AgentRunning && value.unread_count != 0)
            || (notification_reason && value.unread_count == 0)
            || (value.tab_id.is_some() && value.pane_id.is_none())
            || (!notification_reason && (value.pane_id.is_some() || value.tab_id.is_some()))
        {
            return Err("attention source and target are inconsistent");
        }
        Ok(Self {
            workspace_id: value.workspace_id,
            revision: value.revision,
            state: value.state,
            reason: value.reason,
            unread_count: value.unread_count,
            notification_id: value.notification_id,
            pane_id: value.pane_id,
            tab_id: value.tab_id,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceAttentionSnapshotParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AttentionAcknowledgementMode {
    /// The service verifies that the exact retained target is selected before marking it read.
    Focused,
    /// Explicit non-navigation acknowledgement initiated by a dedicated read action.
    Explicit,
}

/// Idempotent acknowledgement of one exact durable notification.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AttentionAcknowledgementParams {
    #[serde(deserialize_with = "uuid_string")]
    pub notification_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
    pub mode: AttentionAcknowledgementMode,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    try_from = "AttentionAcknowledgementResultWire",
    rename_all = "camelCase"
)]
#[ts(export)]
pub struct AttentionAcknowledgementResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub attention: WorkspaceAttentionSnapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttentionAcknowledgementResultWire {
    #[serde(deserialize_with = "safe_integer")]
    revision: u64,
    attention: WorkspaceAttentionSnapshot,
}

impl TryFrom<AttentionAcknowledgementResultWire> for AttentionAcknowledgementResult {
    type Error = &'static str;

    fn try_from(value: AttentionAcknowledgementResultWire) -> Result<Self, Self::Error> {
        if value.revision != value.attention.revision {
            return Err("acknowledgement and attention revisions must match");
        }
        Ok(Self {
            revision: value.revision,
            attention: value.attention,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkspaceAttentionChangeReason {
    SourcesChanged,
    ResyncRequired,
}

/// Bounded invalidation: clients refetch the latest projection by workspace ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceAttentionChangedEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub attention_revision: u64,
    pub reason: WorkspaceAttentionChangeReason,
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

fn optional_uuid<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    uuid::Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WORKSPACE_ID: &str = "10000000-0000-4000-8000-000000000001";
    const NOTIFICATION_ID: &str = "20000000-0000-4000-8000-000000000002";

    #[test]
    fn attention_contract_fixture_matches_canonical_rust_validation() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/attention-contract-parity.json"))
                .expect("valid parity fixture");
        for case in fixture["cases"].as_array().expect("fixture cases") {
            let valid = case["valid"].as_bool().expect("valid flag");
            let parsed =
                serde_json::from_value::<WorkspaceAttentionSnapshot>(case["value"].clone());
            assert_eq!(parsed.is_ok(), valid, "case `{}`", case["name"]);
        }
    }

    #[test]
    fn attention_contracts_are_strict_bounded_and_javascript_safe() {
        let value = json!({
            "workspaceId": WORKSPACE_ID,
            "revision": 7,
            "state": "urgent",
            "reason": "notificationError",
            "unreadCount": 1,
            "notificationId": NOTIFICATION_ID
        });
        assert!(serde_json::from_value::<WorkspaceAttentionSnapshot>(value.clone()).is_ok());

        let mut unknown = value.clone();
        unknown["label"] = json!("renderer-owned text is forbidden");
        assert!(serde_json::from_value::<WorkspaceAttentionSnapshot>(unknown).is_err());

        let mut unsafe_revision = value;
        unsafe_revision["revision"] = json!(MAX_SAFE_INTEGER + 1);
        assert!(serde_json::from_value::<WorkspaceAttentionSnapshot>(unsafe_revision).is_err());

        let explicit_null = json!({
            "workspaceId": WORKSPACE_ID,
            "revision": 7,
            "state": "urgent",
            "reason": "notificationError",
            "unreadCount": 1,
            "notificationId": null
        });
        assert!(serde_json::from_value::<WorkspaceAttentionSnapshot>(explicit_null).is_err());

        let inconsistent_pair = json!({
            "workspaceId": WORKSPACE_ID,
            "revision": 7,
            "state": "waiting",
            "reason": "agentFailed",
            "unreadCount": 0
        });
        assert!(serde_json::from_value::<WorkspaceAttentionSnapshot>(inconsistent_pair).is_err());
    }

    #[test]
    fn acknowledgement_result_revision_matches_nested_snapshot() {
        let mismatched = json!({
            "revision": 8,
            "attention": {
                "workspaceId": WORKSPACE_ID,
                "revision": 7,
                "state": "none",
                "reason": "none",
                "unreadCount": 0
            }
        });
        assert!(serde_json::from_value::<AttentionAcknowledgementResult>(mismatched).is_err());
    }

    #[test]
    fn acknowledgement_requires_exact_identity_revision_key_and_mode() {
        let params = json!({
            "notificationId": NOTIFICATION_ID,
            "expectedRevision": 4,
            "idempotencyKey": "30000000-0000-4000-8000-000000000003",
            "mode": "focused"
        });
        assert!(serde_json::from_value::<AttentionAcknowledgementParams>(params.clone()).is_ok());
        for field in [
            "notificationId",
            "expectedRevision",
            "idempotencyKey",
            "mode",
        ] {
            let mut missing = params.clone();
            missing.as_object_mut().expect("object").remove(field);
            assert!(serde_json::from_value::<AttentionAcknowledgementParams>(missing).is_err());
        }
    }
}

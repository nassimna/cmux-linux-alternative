//! Milestone 3 notification, attention, and notification-settings wire contracts.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use uuid::Uuid;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEFAULT_NOTIFICATION_LIMIT: u16 = 50;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NotificationSource {
    Cli,
    Osc,
    AgentHook,
    Internal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct NotificationSnapshot {
    pub id: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub source: NotificationSource,
    pub level: NotificationLevel,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number", optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AttentionExcerpt {
    #[serde(deserialize_with = "uuid_string")]
    pub notification_id: String,
    #[serde(deserialize_with = "notification_title")]
    pub title: String,
    #[serde(deserialize_with = "required_nullable_notification_body")]
    pub body_excerpt: Option<String>,
    pub source: NotificationSource,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub created_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AttentionSummary {
    pub unread_count: u32,
    pub highest_level: Option<NotificationLevel>,
    pub latest_unread: Option<AttentionExcerpt>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct NotificationTarget {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "optional_uuid")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "optional_uuid")]
    pub tab_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct NotificationListParams {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub workspace_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub unread_only: Option<bool>,
    #[ts(type = "number", optional)]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_safe_integer"
    )]
    pub offset: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_notification_limit"
    )]
    pub limit: Option<u16>,
}

impl NotificationListParams {
    #[must_use]
    pub fn resolved_unread_only(&self) -> bool {
        self.unread_only.unwrap_or(false)
    }

    #[must_use]
    pub fn resolved_offset(&self) -> u64 {
        self.offset.unwrap_or(0)
    }

    #[must_use]
    pub fn resolved_limit(&self) -> u16 {
        self.limit.unwrap_or(DEFAULT_NOTIFICATION_LIMIT)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationListResult {
    #[ts(type = "number")]
    pub revision: u64,
    pub notifications: Vec<NotificationSnapshot>,
    #[ts(type = "number")]
    pub total: u64,
    #[ts(type = "number")]
    pub unread_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct NotificationPublishParams {
    pub target: NotificationTarget,
    pub source: NotificationSource,
    pub level: NotificationLevel,
    #[serde(deserialize_with = "notification_title")]
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "optional_notification_body")]
    pub body: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationMarkReadParams {
    #[serde(deserialize_with = "uuid_string")]
    pub notification_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationMarkUnreadParams {
    #[serde(deserialize_with = "uuid_string")]
    pub notification_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
#[ts(export)]
pub enum NotificationClearScope {
    Notification {
        #[serde(deserialize_with = "uuid_string")]
        notification_id: String,
    },
    Read,
    All,
}

impl<'de> Deserialize<'de> for NotificationClearScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut object = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let kind = object
            .remove("kind")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| serde::de::Error::custom("notification clear scope requires kind"))?;
        match kind.as_str() {
            "notification" => {
                let notification_id = object
                    .remove("notificationId")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .ok_or_else(|| {
                        serde::de::Error::custom("notification scope requires notificationId")
                    })?;
                Uuid::parse_str(&notification_id).map_err(serde::de::Error::custom)?;
                if !object.is_empty() {
                    return Err(serde::de::Error::custom("unknown notification scope field"));
                }
                Ok(Self::Notification { notification_id })
            }
            "read" | "all" => {
                if !object.is_empty() {
                    return Err(serde::de::Error::custom("unknown notification scope field"));
                }
                Ok(if kind == "read" {
                    Self::Read
                } else {
                    Self::All
                })
            }
            _ => Err(serde::de::Error::custom("unknown notification clear scope")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationClearParams {
    pub scope: NotificationClearScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationSettings {
    pub system_enabled: bool,
    pub include_body: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationCreatedEvent {
    pub notification: NotificationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationChangedEvent {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "uuid_vec")]
    pub notification_ids: Vec<String>,
    #[serde(deserialize_with = "uuid_vec")]
    pub workspace_ids: Vec<String>,
    #[serde(deserialize_with = "notification_reason")]
    pub reason: String,
}

impl<'de> Deserialize<'de> for NotificationSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "uuid_string")]
            id: String,
            #[serde(deserialize_with = "uuid_string")]
            workspace_id: String,
            #[serde(default, deserialize_with = "optional_uuid")]
            pane_id: Option<String>,
            #[serde(default, deserialize_with = "optional_uuid")]
            tab_id: Option<String>,
            source: NotificationSource,
            level: NotificationLevel,
            #[serde(deserialize_with = "notification_title")]
            title: String,
            #[serde(default, deserialize_with = "optional_notification_body")]
            body: Option<String>,
            #[serde(deserialize_with = "safe_integer")]
            created_at: u64,
            #[serde(default, deserialize_with = "optional_safe_integer")]
            read_at: Option<u64>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire
            .read_at
            .is_some_and(|read_at| read_at < wire.created_at)
        {
            return Err(serde::de::Error::custom(
                "readAt must not precede createdAt",
            ));
        }
        Ok(Self {
            id: wire.id,
            workspace_id: wire.workspace_id,
            pane_id: wire.pane_id,
            tab_id: wire.tab_id,
            source: wire.source,
            level: wire.level,
            title: wire.title,
            body: wire.body,
            created_at: wire.created_at,
            read_at: wire.read_at,
        })
    }
}

impl<'de> Deserialize<'de> for AttentionSummary {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            unread_count: u32,
            highest_level: Option<NotificationLevel>,
            latest_unread: Option<AttentionExcerpt>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let structurally_consistent = if wire.unread_count == 0 {
            wire.highest_level.is_none() && wire.latest_unread.is_none()
        } else {
            wire.highest_level.is_some() && wire.latest_unread.is_some()
        };
        if !structurally_consistent {
            return Err(serde::de::Error::custom(
                "empty attention must have null level and latest unread",
            ));
        }
        Ok(Self {
            unread_count: wire.unread_count,
            highest_level: wire.highest_level,
            latest_unread: wire.latest_unread,
        })
    }
}

impl<'de> Deserialize<'de> for NotificationTarget {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(rename = "workspaceId")]
            #[serde(deserialize_with = "uuid_string")]
            workspace: String,
            #[serde(rename = "paneId")]
            #[serde(default, deserialize_with = "optional_uuid")]
            pane: Option<String>,
            #[serde(rename = "tabId")]
            #[serde(default, deserialize_with = "optional_uuid")]
            tab: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            workspace_id: wire.workspace,
            pane_id: wire.pane,
            tab_id: wire.tab,
        })
    }
}

impl<'de> Deserialize<'de> for NotificationListResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "safe_integer")]
            revision: u64,
            notifications: Vec<NotificationSnapshot>,
            #[serde(deserialize_with = "safe_integer")]
            total: u64,
            #[serde(deserialize_with = "safe_integer")]
            unread_count: u64,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.total < wire.notifications.len() as u64 || wire.unread_count > wire.total {
            return Err(serde::de::Error::custom("invalid notification list counts"));
        }
        if wire
            .notifications
            .windows(2)
            .any(|pair| pair[0].created_at < pair[1].created_at)
        {
            return Err(serde::de::Error::custom(
                "notifications must be newest first",
            ));
        }
        Ok(Self {
            revision: wire.revision,
            notifications: wire.notifications,
            total: wire.total,
            unread_count: wire.unread_count,
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

fn optional_safe_integer<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    safe_integer(deserializer).map(Some)
}

fn notification_limit<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if !(1..=200).contains(&value) {
        return Err(serde::de::Error::custom(
            "notification limit must be within 1..=200",
        ));
    }
    Ok(value)
}

fn optional_notification_limit<'de, D>(deserializer: D) -> Result<Option<u16>, D::Error>
where
    D: Deserializer<'de>,
{
    notification_limit(deserializer).map(Some)
}

fn optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
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

fn bounded_control_free<E>(value: String, max: usize) -> Result<String, E>
where
    E: serde::de::Error,
{
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        return Err(E::custom(
            "notification text is empty, untrimmed, controlled, or exceeds its bound",
        ));
    }
    Ok(value)
}

fn notification_title<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_control_free(String::deserialize(deserializer)?, 256)
}

fn optional_notification_body<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_control_free(String::deserialize(deserializer)?, 4_096).map(Some)
}

fn required_nullable_notification_body<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| bounded_control_free(value, 4_096))
        .transpose()
}

fn notification_reason<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_control_free(String::deserialize(deserializer)?, 256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WORKSPACE_ID: &str = "10000000-0000-4000-8000-000000000001";
    const PANE_ID: &str = "30000000-0000-4000-8000-000000000001";
    const TAB_ID: &str = "40000000-0000-4000-8000-000000000001";
    const NOTIFICATION_ID: &str = "60000000-0000-4000-8000-000000000001";

    fn notification() -> serde_json::Value {
        json!({ "id": NOTIFICATION_ID, "workspaceId": WORKSPACE_ID, "paneId": PANE_ID,
            "tabId": TAB_ID, "source": "agentHook", "level": "warning", "title": "Needs attention",
            "body": "Review the output", "createdAt": 100, "readAt": 101 })
    }

    #[test]
    fn notification_snapshot_enforces_shape_text_and_timestamps() {
        assert!(serde_json::from_value::<NotificationSnapshot>(notification()).is_ok());
        let mut tab_only = notification();
        tab_only.as_object_mut().unwrap().remove("paneId");
        assert!(serde_json::from_value::<NotificationSnapshot>(tab_only).is_ok());
        let mut invalid = notification();
        invalid["readAt"] = json!(99);
        assert!(serde_json::from_value::<NotificationSnapshot>(invalid).is_err());
        let mut invalid = notification();
        invalid["title"] = json!("bad\ncontrol");
        assert!(serde_json::from_value::<NotificationSnapshot>(invalid).is_err());
    }

    #[test]
    fn publish_params_without_optional_fields_round_trip() {
        let params = NotificationPublishParams {
            target: NotificationTarget {
                workspace_id: WORKSPACE_ID.to_owned(),
                pane_id: None,
                tab_id: None,
            },
            source: NotificationSource::Cli,
            level: NotificationLevel::Info,
            title: "Finished".to_owned(),
            body: None,
        };
        let wire = serde_json::to_value(&params).unwrap();
        assert_eq!(
            wire,
            json!({
                "target": { "workspaceId": WORKSPACE_ID },
                "source": "cli",
                "level": "info",
                "title": "Finished"
            })
        );
        assert_eq!(
            serde_json::from_value::<NotificationPublishParams>(wire).unwrap(),
            params
        );
    }

    #[test]
    fn list_pagination_defaults_and_boundaries_are_strict() {
        let defaults: NotificationListParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(serde_json::to_value(&defaults).unwrap(), json!({}));
        assert_eq!(defaults.resolved_limit(), 50);
        assert!(!defaults.resolved_unread_only());
        assert_eq!(defaults.resolved_offset(), 0);
        for field in ["workspaceId", "unreadOnly", "offset", "limit"] {
            let mut invalid = json!({});
            invalid[field] = serde_json::Value::Null;
            assert!(serde_json::from_value::<NotificationListParams>(invalid).is_err());
        }
        assert!(serde_json::from_value::<NotificationListParams>(json!({ "limit": 1 })).is_ok());
        assert!(serde_json::from_value::<NotificationListParams>(json!({ "limit": 200 })).is_ok());
        assert!(serde_json::from_value::<NotificationListParams>(json!({ "limit": 0 })).is_err());
        assert!(serde_json::from_value::<NotificationListParams>(json!({ "limit": 201 })).is_err());
    }

    #[test]
    fn attention_requires_structurally_consistent_empty_state() {
        assert!(
            serde_json::from_value::<AttentionSummary>(json!({
                "unreadCount": 0, "highestLevel": null, "latestUnread": null
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<AttentionSummary>(json!({
                "unreadCount": 1, "highestLevel": null, "latestUnread": null
            }))
            .is_err()
        );
    }

    #[test]
    fn clear_scope_is_a_strict_discriminated_union() {
        assert!(
            serde_json::from_value::<NotificationClearParams>(json!({
                "scope": { "kind": "notification", "notificationId": NOTIFICATION_ID }
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<NotificationClearParams>(json!({
                "scope": { "kind": "all", "notificationId": NOTIFICATION_ID }
            }))
            .is_err()
        );
    }

    #[test]
    fn settings_updates_require_at_least_one_strict_section() {
        assert!(serde_json::from_value::<crate::SettingsUpdateParams>(json!({})).is_err());
        assert!(
            serde_json::from_value::<crate::SettingsUpdateParams>(json!({
                "notifications": { "systemEnabled": false, "includeBody": true }
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<crate::SettingsUpdateParams>(json!({
                "notifications": { "systemEnabled": false, "includeBody": true },
                "unknown": true
            }))
            .is_err()
        );
    }
}

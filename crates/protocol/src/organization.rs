//! Capability-gated M2 workspace organization wire contracts.

use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::WorkspaceCreateParams;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SELECTION: usize = 128;
const MAX_GROUPS: usize = 128;
const MAX_NAME_CHARS: usize = 80;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LegacyLimitDimension {
    Workspaces,
    PanesPerWorkspace,
    TabsPerWorkspace,
    TotalPanes,
    TotalTabs,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LegacyOverLimitSnapshot {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub workspace_count: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub maximum_panes_in_workspace: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub maximum_tabs_in_workspace: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub total_pane_count: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub total_tab_count: u64,
    pub exceeded_dimensions: Vec<LegacyLimitDimension>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceGroupSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "organization_name")]
    pub name: String,
    pub collapsed: bool,
    pub order: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceGroupAssignment {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub group_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceOrganizationSnapshot {
    #[ts(type = "number")]
    pub revision: u64,
    pub selection: Vec<String>,
    pub focused_workspace_id: String,
    pub pins: Vec<String>,
    pub groups: Vec<WorkspaceGroupSnapshot>,
    pub assignments: Vec<WorkspaceGroupAssignment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub legacy_over_limit: Option<LegacyOverLimitSnapshot>,
}

impl<'de> Deserialize<'de> for WorkspaceOrganizationSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "safe_integer")]
            revision: u64,
            #[serde(deserialize_with = "uuid_vec")]
            selection: Vec<String>,
            #[serde(deserialize_with = "uuid_string")]
            focused_workspace_id: String,
            #[serde(deserialize_with = "uuid_vec")]
            pins: Vec<String>,
            groups: Vec<WorkspaceGroupSnapshot>,
            assignments: Vec<WorkspaceGroupAssignment>,
            #[serde(default, deserialize_with = "optional_non_null")]
            legacy_over_limit: Option<LegacyOverLimitSnapshot>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.selection.is_empty() || wire.selection.len() > MAX_SELECTION {
            return Err(serde::de::Error::custom(
                "workspace selection is outside its bound",
            ));
        }
        if !wire.selection.contains(&wire.focused_workspace_id) {
            return Err(serde::de::Error::custom(
                "focused workspace is not selected",
            ));
        }
        if wire.pins.len() > MAX_SELECTION || wire.groups.len() > MAX_GROUPS {
            return Err(serde::de::Error::custom(
                "workspace organization exceeds its bound",
            ));
        }
        let group_ids = wire
            .groups
            .iter()
            .map(|group| &group.id)
            .collect::<BTreeSet<_>>();
        let orders = wire
            .groups
            .iter()
            .map(|group| group.order)
            .collect::<BTreeSet<_>>();
        if group_ids.len() != wire.groups.len() || orders.len() != wire.groups.len() {
            return Err(serde::de::Error::custom(
                "group ids and orders must be unique",
            ));
        }
        let mut assigned_workspaces = BTreeSet::new();
        if wire.assignments.len() > MAX_GROUPS
            || wire.assignments.iter().any(|assignment| {
                !assigned_workspaces.insert(&assignment.workspace_id)
                    || !group_ids.contains(&assignment.group_id)
            })
        {
            return Err(serde::de::Error::custom(
                "workspace group assignments are invalid",
            ));
        }
        if let Some(legacy) = &wire.legacy_over_limit {
            let expected = [
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
            .collect::<Vec<_>>();
            if expected.is_empty() || legacy.exceeded_dimensions != expected {
                return Err(serde::de::Error::custom(
                    "legacy over-limit dimensions are inconsistent",
                ));
            }
        }
        Ok(Self {
            revision: wire.revision,
            selection: wire.selection,
            focused_workspace_id: wire.focused_workspace_id,
            pins: wire.pins,
            groups: wire.groups,
            assignments: wire.assignments,
            legacy_over_limit: wire.legacy_over_limit,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceOrganizationGetResult {
    pub organization: WorkspaceOrganizationSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceSelectionReplaceParams {
    pub selection: Vec<String>,
    pub focused_workspace_id: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub idempotency_key: String,
}

impl<'de> Deserialize<'de> for WorkspaceSelectionReplaceParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "uuid_vec")]
            selection: Vec<String>,
            #[serde(deserialize_with = "uuid_string")]
            focused_workspace_id: String,
            #[serde(deserialize_with = "safe_integer")]
            expected_revision: u64,
            #[serde(deserialize_with = "uuid_string")]
            idempotency_key: String,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.selection.is_empty() || !wire.selection.contains(&wire.focused_workspace_id) {
            return Err(serde::de::Error::custom(
                "workspace selection must be nonempty and contain the focused workspace",
            ));
        }
        Ok(Self {
            selection: wire.selection,
            focused_workspace_id: wire.focused_workspace_id,
            expected_revision: wire.expected_revision,
            idempotency_key: wire.idempotency_key,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspacePinParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub pinned: bool,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WorkspaceBatchCloseParams {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub replacement: Option<WorkspaceCreateParams>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceCanonicalMoveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    pub destination_index: u32,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GroupCreateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub group_id: String,
    #[serde(deserialize_with = "organization_name")]
    pub name: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GroupRenameParams {
    #[serde(deserialize_with = "uuid_string")]
    pub group_id: String,
    #[serde(deserialize_with = "organization_name")]
    pub name: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GroupDeleteParams {
    #[serde(deserialize_with = "uuid_string")]
    pub group_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GroupMoveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub group_id: String,
    pub destination_index: u32,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct GroupAssignParams {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub group_id: Option<String>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GroupCollapseParams {
    #[serde(deserialize_with = "uuid_string")]
    pub group_id: String,
    pub collapsed: bool,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WorkspaceOrganizationChangeReason {
    OrganizationChanged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceOrganizationChangedEvent {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub reason: WorkspaceOrganizationChangeReason,
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
    let mut seen = BTreeSet::new();
    for value in &values {
        Uuid::parse_str(value).map_err(serde::de::Error::custom)?;
        if !seen.insert(value) {
            return Err(serde::de::Error::custom(
                "UUID lists must not contain duplicates",
            ));
        }
    }
    if values.len() > MAX_SELECTION {
        return Err(serde::de::Error::custom("UUID list exceeds its bound"));
    }
    Ok(values)
}

fn organization_name<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value != value.trim() || value.is_empty() || value.chars().count() > MAX_NAME_CHARS {
        return Err(serde::de::Error::custom(
            "organization name is outside its bound",
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn organization_params_reject_unknown_null_duplicate_and_invalid_values() {
        let valid = json!({
            "selection": ["10000000-0000-4000-8000-000000000001"],
            "focusedWorkspaceId": "10000000-0000-4000-8000-000000000001",
            "expectedRevision": 2,
            "idempotencyKey": "20000000-0000-4000-8000-000000000002"
        });
        assert!(serde_json::from_value::<WorkspaceSelectionReplaceParams>(valid.clone()).is_ok());
        let mut unknown = valid.clone();
        unknown["unknown"] = json!(true);
        assert!(serde_json::from_value::<WorkspaceSelectionReplaceParams>(unknown).is_err());
        let mut duplicate = valid.clone();
        duplicate["selection"] = json!([
            "10000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000001"
        ]);
        assert!(serde_json::from_value::<WorkspaceSelectionReplaceParams>(duplicate).is_err());

        let mut empty = valid.clone();
        empty["selection"] = json!([]);
        assert!(serde_json::from_value::<WorkspaceSelectionReplaceParams>(empty).is_err());
        let mut missing_focus = valid.clone();
        missing_focus["focusedWorkspaceId"] = json!("10000000-0000-4000-8000-000000000099");
        assert!(serde_json::from_value::<WorkspaceSelectionReplaceParams>(missing_focus).is_err());
        let mut oversized = valid.clone();
        oversized["selection"] = json!(
            (0..=MAX_SELECTION)
                .map(|_| Uuid::new_v4().to_string())
                .collect::<Vec<_>>()
        );
        oversized["focusedWorkspaceId"] = oversized["selection"][0].clone();
        assert!(serde_json::from_value::<WorkspaceSelectionReplaceParams>(oversized).is_err());

        let assignment = json!({
            "workspaceId": "10000000-0000-4000-8000-000000000001",
            "groupId": null,
            "expectedRevision": 2,
            "idempotencyKey": "20000000-0000-4000-8000-000000000002"
        });
        assert!(serde_json::from_value::<GroupAssignParams>(assignment).is_err());
    }
}

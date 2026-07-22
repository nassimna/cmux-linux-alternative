//! Capability-gated portable saved-layout wire contracts.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use url::{Host, Url};
use uuid::Uuid;

use crate::{PaneTreeNode, TerminalLaunchMetadata};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_LAYOUT_BYTES: usize = 256 * 1_024;
const MAX_LAYOUT_WORKSPACES: usize = 32;
const MAX_LAYOUT_PANES: usize = 128;
const MAX_LAYOUT_TABS: usize = 256;
const MAX_NAME_CHARS: usize = 80;
const MAX_TITLE_CHARS: usize = 256;
const MAX_DESCRIPTION_CHARS: usize = 4_096;
const MAX_COLOR_CHARS: usize = 64;
const MAX_BROWSER_URL_CHARS: usize = 8_192;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutPaneTemplate {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "layout_tab_uuid_vec")]
    pub tabs: Vec<String>,
    #[serde(deserialize_with = "uuid_string")]
    pub selected_tab_id: String,
    #[serde(deserialize_with = "required_nullable_title")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
#[ts(export)]
pub enum LayoutTabContentTemplate {
    Terminal {
        launch: TerminalLaunchMetadata,
    },
    Browser {
        #[serde(deserialize_with = "safe_browser_url")]
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutTabTemplate {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    #[serde(deserialize_with = "required_nullable_title")]
    pub custom_title: Option<String>,
    pub content: LayoutTabContentTemplate,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutWorkspaceTemplate {
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
    pub panes: BTreeMap<String, LayoutPaneTemplate>,
    pub tabs: BTreeMap<String, LayoutTabTemplate>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub created_at: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutTemplateSnapshot {
    pub workspaces: Vec<LayoutWorkspaceTemplate>,
}

impl<'de> Deserialize<'de> for LayoutTemplateSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            workspaces: Vec<LayoutWorkspaceTemplate>,
        }
        let value = Self {
            workspaces: Wire::deserialize(deserializer)?.workspaces,
        };
        validate_template(&value).map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutExportEnvelope {
    pub format_version: u32,
    pub name: String,
    pub template: LayoutTemplateSnapshot,
}

impl<'de> Deserialize<'de> for LayoutExportEnvelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            format_version: u32,
            #[serde(deserialize_with = "layout_name")]
            name: String,
            template: LayoutTemplateSnapshot,
        }
        let wire = Wire::deserialize(deserializer)?;
        let value = Self {
            format_version: wire.format_version,
            name: wire.name,
            template: wire.template,
        };
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

impl LayoutExportEnvelope {
    fn validate(&self) -> Result<(), String> {
        if self.format_version != 1 {
            return Err("unsupported saved-layout format version".to_owned());
        }
        validate_template(&self.template)?;
        let bytes = serde_json::to_vec(self)
            .map_err(|error| error.to_string())?
            .len();
        if bytes > MAX_LAYOUT_BYTES {
            return Err("saved-layout document exceeds its byte bound".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SavedLayoutSnapshot {
    pub id: String,
    pub name: String,
    pub format_version: u32,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    pub template: LayoutTemplateSnapshot,
}

impl<'de> Deserialize<'de> for SavedLayoutSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "uuid_string")]
            id: String,
            #[serde(deserialize_with = "layout_name")]
            name: String,
            #[serde(deserialize_with = "layout_format_version")]
            format_version: u32,
            #[serde(deserialize_with = "safe_integer")]
            created_at: u64,
            #[serde(deserialize_with = "safe_integer")]
            updated_at: u64,
            template: LayoutTemplateSnapshot,
        }
        let wire = Wire::deserialize(deserializer)?;
        let value = Self {
            id: wire.id,
            name: wire.name,
            format_version: wire.format_version,
            created_at: wire.created_at,
            updated_at: wire.updated_at,
            template: wire.template,
        };
        let bytes = serde_json::to_vec(&value)
            .map_err(serde::de::Error::custom)?
            .len();
        if bytes > MAX_LAYOUT_BYTES {
            return Err(serde::de::Error::custom(
                "saved-layout snapshot exceeds its byte bound",
            ));
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SavedLayoutSummary {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(deserialize_with = "layout_name")]
    pub name: String,
    #[serde(deserialize_with = "layout_format_version")]
    pub format_version: u32,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub created_at: u64,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub updated_at: u64,
    #[serde(deserialize_with = "layout_workspace_count")]
    pub workspace_count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutListResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    #[serde(deserialize_with = "layout_summaries")]
    pub layouts: Vec<SavedLayoutSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutGetParams {
    #[serde(deserialize_with = "uuid_string")]
    pub layout_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutGetResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub layout: SavedLayoutSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutSaveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub layout_id: String,
    #[serde(deserialize_with = "layout_name")]
    pub name: String,
    #[serde(deserialize_with = "nonempty_uuid_vec")]
    pub workspace_ids: Vec<String>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutDeleteParams {
    #[serde(deserialize_with = "uuid_string")]
    pub layout_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutApplyParams {
    #[serde(deserialize_with = "uuid_string")]
    pub layout_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutExportParams {
    #[serde(deserialize_with = "uuid_string")]
    pub layout_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutExportResult {
    pub envelope: LayoutExportEnvelope,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutImportParams {
    #[serde(deserialize_with = "uuid_string")]
    pub layout_id: String,
    pub envelope: LayoutExportEnvelope,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expected_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LayoutMutationResult {
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SavedLayoutsChangeReason {
    LayoutsChanged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SavedLayoutsChangedEvent {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub reason: SavedLayoutsChangeReason,
}

fn validate_template(template: &LayoutTemplateSnapshot) -> Result<(), String> {
    if template.workspaces.is_empty() || template.workspaces.len() > MAX_LAYOUT_WORKSPACES {
        return Err("saved-layout workspace count is outside its bound".to_owned());
    }
    let pane_count: usize = template
        .workspaces
        .iter()
        .map(|value| value.panes.len())
        .sum();
    let tab_count: usize = template
        .workspaces
        .iter()
        .map(|value| value.tabs.len())
        .sum();
    if pane_count > MAX_LAYOUT_PANES || tab_count > MAX_LAYOUT_TABS {
        return Err("saved-layout pane or tab count exceeds its bound".to_owned());
    }
    let mut workspace_ids = BTreeSet::new();
    let mut pane_ids = BTreeSet::new();
    let mut tab_ids = BTreeSet::new();
    let mut split_ids = BTreeSet::new();
    for workspace in &template.workspaces {
        if !workspace_ids.insert(&workspace.id)
            || workspace.panes.is_empty()
            || workspace.tabs.is_empty()
        {
            return Err("saved-layout workspace identity or content is invalid".to_owned());
        }
        if !workspace.panes.contains_key(&workspace.selected_pane_id) {
            return Err("saved-layout selected pane is missing".to_owned());
        }
        let mut leaves = Vec::new();
        collect_tree_ids(&workspace.layout, &mut leaves, &mut split_ids)?;
        if leaves.len() != workspace.panes.len()
            || leaves.iter().collect::<BTreeSet<_>>().len() != leaves.len()
            || leaves.iter().any(|id| !workspace.panes.contains_key(*id))
        {
            return Err("saved-layout pane tree is invalid".to_owned());
        }
        let mut referenced_tabs = BTreeSet::new();
        for (key, pane) in &workspace.panes {
            if key != &pane.id
                || !pane_ids.insert(key)
                || pane.tabs.is_empty()
                || !pane.tabs.contains(&pane.selected_tab_id)
                || pane.tabs.iter().any(|id| !referenced_tabs.insert(id))
            {
                return Err("saved-layout pane graph is invalid".to_owned());
            }
        }
        if referenced_tabs.len() != workspace.tabs.len()
            || referenced_tabs
                .iter()
                .any(|id| !workspace.tabs.contains_key(*id))
        {
            return Err("saved-layout tab references are invalid".to_owned());
        }
        for (key, tab) in &workspace.tabs {
            if key != &tab.id
                || !tab_ids.insert(key)
                || !workspace.panes.contains_key(&tab.pane_id)
                || !workspace.panes[&tab.pane_id].tabs.contains(key)
            {
                return Err("saved-layout tab graph is invalid".to_owned());
            }
        }
    }
    let bytes = serde_json::to_vec(template)
        .map_err(|error| error.to_string())?
        .len();
    if bytes > MAX_LAYOUT_BYTES {
        return Err("saved-layout template exceeds its serialized byte bound".to_owned());
    }
    Ok(())
}

fn collect_tree_ids<'a>(
    node: &'a PaneTreeNode,
    leaves: &mut Vec<&'a String>,
    split_ids: &mut BTreeSet<&'a String>,
) -> Result<(), String> {
    match node {
        PaneTreeNode::Leaf { pane_id } => leaves.push(pane_id),
        PaneTreeNode::Split {
            split_id,
            first,
            second,
            ..
        } => {
            if !split_ids.insert(split_id) {
                return Err("saved-layout split IDs must be unique".to_owned());
            }
            collect_tree_ids(first, leaves, split_ids)?;
            collect_tree_ids(second, leaves, split_ids)?;
        }
    }
    Ok(())
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    (value <= MAX_SAFE_INTEGER)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("integer is outside the JavaScript safe range"))
}

fn layout_format_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    (value == 1)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("unsupported saved-layout format version"))
}

fn layout_workspace_count<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    (value > 0 && value <= 32).then_some(value).ok_or_else(|| {
        serde::de::Error::custom("saved-layout workspace count is outside its bound")
    })
}

fn layout_summaries<'de, D>(deserializer: D) -> Result<Vec<SavedLayoutSummary>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<SavedLayoutSummary>::deserialize(deserializer)?;
    if values.len() > 64
        || values
            .iter()
            .map(|layout| &layout.id)
            .collect::<BTreeSet<_>>()
            .len()
            != values.len()
    {
        return Err(serde::de::Error::custom(
            "saved-layout summaries exceed their bound or contain duplicate IDs",
        ));
    }
    Ok(values)
}

fn uuid_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn layout_tab_uuid_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    validate_uuid_vec(values, true, MAX_LAYOUT_TABS).map_err(serde::de::Error::custom)
}

fn nonempty_uuid_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<String>::deserialize(deserializer)?;
    validate_uuid_vec(values, true, MAX_LAYOUT_WORKSPACES).map_err(serde::de::Error::custom)
}

fn validate_uuid_vec(
    values: Vec<String>,
    nonempty: bool,
    maximum: usize,
) -> Result<Vec<String>, String> {
    if (nonempty && values.is_empty()) || values.len() > maximum {
        return Err("UUID list is outside its bound".to_owned());
    }
    let mut unique = BTreeSet::new();
    for value in &values {
        Uuid::parse_str(value).map_err(|error| error.to_string())?;
        if !unique.insert(value) {
            return Err("UUID list contains duplicates".to_owned());
        }
    }
    Ok(values)
}

fn checked_text(value: String, maximum: usize, allow_empty: bool) -> Result<String, String> {
    if value != value.trim()
        || (!allow_empty && value.is_empty())
        || value.chars().count() > maximum
    {
        return Err("text is not normalized or is outside its bound".to_owned());
    }
    Ok(value)
}

macro_rules! text_deserializer {
    ($name:ident, $maximum:expr, $allow_empty:expr) => {
        fn $name<'de, D>(deserializer: D) -> Result<String, D::Error>
        where
            D: Deserializer<'de>,
        {
            checked_text(String::deserialize(deserializer)?, $maximum, $allow_empty)
                .map_err(serde::de::Error::custom)
        }
    };
}
text_deserializer!(layout_name, MAX_NAME_CHARS, false);
text_deserializer!(workspace_name, 128, false);
text_deserializer!(title, MAX_TITLE_CHARS, false);

fn required_nullable_title<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| checked_text(value, MAX_TITLE_CHARS, false).map_err(serde::de::Error::custom))
        .transpose()
}

fn required_nullable_description<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| {
            checked_text(value, MAX_DESCRIPTION_CHARS, true).map_err(serde::de::Error::custom)
        })
        .transpose()
}

fn required_nullable_color<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| checked_text(value, MAX_COLOR_CHARS, false).map_err(serde::de::Error::custom))
        .transpose()
}

fn absolute_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.contains('\0') || !Path::new(&value).is_absolute() {
        return Err(serde::de::Error::custom(
            "path must be absolute and contain no NUL",
        ));
    }
    Ok(value)
}

fn safe_browser_url<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let parsed = Url::parse(&value).map_err(serde::de::Error::custom)?;
    if value.chars().count() > MAX_BROWSER_URL_CHARS
        || !matches!(parsed.scheme(), "http" | "https")
        || !safe_browser_host(&parsed)
        || parsed.port() == Some(0)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.as_str() != value
    {
        return Err(serde::de::Error::custom(
            "browser URL is not a safe canonical HTTP(S) URL",
        ));
    }
    Ok(value)
}

fn safe_browser_host(parsed: &Url) -> bool {
    match parsed.host() {
        Some(Host::Domain(host)) => host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        }),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => true,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_template() -> serde_json::Value {
        let workspace = Uuid::new_v4().to_string();
        let pane = Uuid::new_v4().to_string();
        let tab = Uuid::new_v4().to_string();
        serde_json::json!({
            "workspaces": [{
                "id": workspace, "name": "workspace", "description": null, "color": null,
                "workingDirectory": "/tmp", "layout": { "kind": "leaf", "paneId": pane },
                "selectedPaneId": pane,
                "panes": { (pane.clone()): { "id": pane, "tabs": [tab.clone()], "selectedTabId": tab.clone(), "title": null } },
                "tabs": { (tab.clone()): { "id": tab, "paneId": pane, "title": "Terminal", "customTitle": null,
                    "content": { "kind": "terminal", "launch": { "cwd": "/tmp", "rows": 24, "cols": 80 } }, "createdAt": 1 } },
                "createdAt": 1, "updatedAt": 1
            }]
        })
    }

    #[test]
    fn import_envelope_rejects_runtime_only_terminal_identity() {
        let value = serde_json::json!({
            "formatVersion": 1,
            "name": "portable",
            "template": { "workspaces": [{
                "id": Uuid::new_v4(), "name": "workspace", "description": null,
                "color": null, "workingDirectory": "/tmp", "layout": { "kind": "leaf", "paneId": Uuid::new_v4() },
                "selectedPaneId": Uuid::new_v4(), "panes": {}, "tabs": {}, "createdAt": 1, "updatedAt": 1
            }]}
        });
        let mut value = value;
        value["template"]["workspaces"][0]["runtimeSessionId"] = serde_json::json!(Uuid::new_v4());
        assert!(serde_json::from_value::<LayoutExportEnvelope>(value).is_err());
    }

    #[test]
    fn saved_layout_results_reject_invalid_identity_format_bounds_and_duplicates() {
        let summary = serde_json::json!({
            "id": Uuid::new_v4(), "name": "layout", "formatVersion": 1,
            "createdAt": 1, "updatedAt": 1, "workspaceCount": 1
        });
        assert!(serde_json::from_value::<SavedLayoutSummary>(summary.clone()).is_ok());
        let mut invalid = summary.clone();
        invalid["id"] = serde_json::json!("not-a-uuid");
        assert!(serde_json::from_value::<SavedLayoutSummary>(invalid).is_err());
        let mut invalid = summary.clone();
        invalid["formatVersion"] = serde_json::json!(2);
        assert!(serde_json::from_value::<SavedLayoutSummary>(invalid).is_err());
        let mut invalid = summary.clone();
        invalid["createdAt"] = serde_json::json!(MAX_SAFE_INTEGER + 1);
        assert!(serde_json::from_value::<SavedLayoutSummary>(invalid).is_err());
        let list = serde_json::json!({ "revision": 1, "layouts": [summary.clone(), summary] });
        assert!(serde_json::from_value::<LayoutListResult>(list).is_err());
    }

    #[test]
    fn saved_layout_snapshot_enforces_strict_fields_and_complete_byte_cap() {
        let id = Uuid::new_v4();
        let snapshot = serde_json::json!({
            "id": id, "name": "layout", "formatVersion": 1,
            "createdAt": 1, "updatedAt": 1, "template": minimal_template()
        });
        assert!(serde_json::from_value::<SavedLayoutSnapshot>(snapshot.clone()).is_ok());
        let mut invalid = snapshot.clone();
        invalid["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<SavedLayoutSnapshot>(invalid).is_err());

        let mut oversized = minimal_template();
        let pane = oversized["workspaces"][0]["selectedPaneId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut tab_ids = Vec::new();
        let mut tabs = serde_json::Map::new();
        for _ in 0..64 {
            let tab = Uuid::new_v4().to_string();
            tab_ids.push(tab.clone());
            tabs.insert(tab.clone(), serde_json::json!({
                "id": tab, "paneId": pane, "title": "Browser", "customTitle": null,
                "content": { "kind": "browser", "url": format!("https://example.test/{}", "a".repeat(7_000)) },
                "createdAt": 1
            }));
        }
        oversized["workspaces"][0]["panes"][&pane]["tabs"] = serde_json::json!(tab_ids);
        oversized["workspaces"][0]["panes"][&pane]["selectedTabId"] = serde_json::json!(tab_ids[0]);
        oversized["workspaces"][0]["tabs"] = serde_json::Value::Object(tabs);
        let oversized_snapshot = serde_json::json!({
            "id": id, "name": "layout", "formatVersion": 1,
            "createdAt": 1, "updatedAt": 1, "template": oversized
        });
        assert!(serde_json::from_value::<SavedLayoutSnapshot>(oversized_snapshot).is_err());
    }

    #[test]
    fn portable_browser_urls_are_canonical_origin_path_only() {
        let mut template = minimal_template();
        let pane = template["workspaces"][0]["selectedPaneId"]
            .as_str()
            .unwrap()
            .to_owned();
        let tab = template["workspaces"][0]["panes"][&pane]["selectedTabId"]
            .as_str()
            .unwrap()
            .to_owned();
        for url in [
            "https://example.test/private/path",
            "https://localhost/private/path",
            "https://127.0.0.1/private/path",
            "https://[::1]/private/path",
        ] {
            let mut valid = template.clone();
            valid["workspaces"][0]["tabs"][&tab]["content"] =
                serde_json::json!({ "kind": "browser", "url": url });
            assert!(
                serde_json::from_value::<LayoutTemplateSnapshot>(valid).is_ok(),
                "rejected {url}"
            );
        }

        template["workspaces"][0]["tabs"][&tab]["content"] =
            serde_json::json!({ "kind": "browser", "url": "https://example.test/private/path" });

        for url in [
            "https://user:password@example.test/private/path",
            "https://example.test/private/path?access_token=secret",
            "https://example.test/private/path#secret",
            "HTTPS://EXAMPLE.TEST/private/path",
            "https://example.test:443/private/path",
            "https://example.test/private/../path",
            "https://foo_bar/private/path",
            "https://-foo/private/path",
            "https://foo-/private/path",
            "https://foo..bar/private/path",
            "https://example.test:0/private/path",
        ] {
            let mut hostile = template.clone();
            hostile["workspaces"][0]["tabs"][&tab]["content"]["url"] = serde_json::json!(url);
            assert!(
                serde_json::from_value::<LayoutTemplateSnapshot>(hostile).is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn layout_pane_tab_list_has_its_own_256_uuid_bound() {
        let ids = (0..33)
            .map(|_| Uuid::new_v4().to_string())
            .collect::<Vec<_>>();
        let pane = serde_json::json!({
            "id": Uuid::new_v4(), "tabs": ids, "selectedTabId": ids[0], "title": null
        });
        assert!(serde_json::from_value::<LayoutPaneTemplate>(pane).is_ok());

        let ids = (0..257)
            .map(|_| Uuid::new_v4().to_string())
            .collect::<Vec<_>>();
        let pane = serde_json::json!({
            "id": Uuid::new_v4(), "tabs": ids, "selectedTabId": ids[0], "title": null
        });
        assert!(serde_json::from_value::<LayoutPaneTemplate>(pane).is_err());
        let empty = serde_json::json!({
            "id": Uuid::new_v4(), "tabs": [], "selectedTabId": Uuid::new_v4(), "title": null
        });
        assert!(serde_json::from_value::<LayoutPaneTemplate>(empty).is_err());
    }
}

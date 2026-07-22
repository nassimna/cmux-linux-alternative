use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::model::{MAX_SAFE_INTEGER, checked_text, validate_timestamp};
use crate::{
    BrowserMetadata, DomainError, GroupId, LayoutId, Pane, PaneId, PaneNode, RuntimeSessionId,
    SplitId, Tab, TabContent, TabId, TerminalLaunchSpec, Timestamp, Workspace, WorkspaceId,
};

pub const APPLICATION_MAX_WORKSPACES: usize = 128;
pub const WORKSPACE_MAX_PANES: usize = 64;
pub const WORKSPACE_MAX_TABS: usize = 128;
pub const APPLICATION_MAX_PANES: usize = 1_024;
pub const APPLICATION_MAX_TABS: usize = 2_048;
pub const WORKSPACE_SELECTION_MAX_COUNT: usize = 128;
pub const WORKSPACE_PIN_MAX_COUNT: usize = 128;
pub const WORKSPACE_GROUP_MAX_COUNT: usize = 128;
pub const GROUP_ASSIGNMENT_MAX_COUNT: usize = 128;
pub const LAYOUT_MAX_COUNT: usize = 64;
pub const LAYOUT_TEMPLATE_MAX_WORKSPACES: usize = 32;
pub const LAYOUT_TEMPLATE_MAX_PANES: usize = 128;
pub const LAYOUT_TEMPLATE_MAX_TABS: usize = 256;
pub const LAYOUT_TEMPLATE_MAX_BYTES: usize = 256 * 1_024;
pub const LAYOUT_FORMAT_VERSION: u32 = 1;
const ORGANIZATION_NAME_MAX_CHARS: usize = 80;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGroup {
    pub id: GroupId,
    pub name: String,
    pub collapsed: bool,
    pub order: u32,
}

impl WorkspaceGroup {
    /// Creates a normalized bounded workspace group.
    ///
    /// # Errors
    /// Returns an error when the name or order violates the durable contract.
    pub fn new(id: GroupId, name: impl Into<String>, order: u32) -> Result<Self, DomainError> {
        let value = Self {
            id,
            name: checked_text(
                "workspace_group.name",
                &name.into(),
                ORGANIZATION_NAME_MAX_CHARS,
                false,
            )?,
            collapsed: false,
            order,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        let normalized = checked_text(
            "workspace_group.name",
            &self.name,
            ORGANIZATION_NAME_MAX_CHARS,
            false,
        )?;
        if normalized != self.name {
            return Err(DomainError::InvalidState {
                message: "workspace group name is not normalized".to_owned(),
            });
        }
        Ok(())
    }
}

/// Exact legacy aggregate counts retained while a pre-v4 snapshot is being reduced.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyOverLimit {
    pub workspace_count: usize,
    pub maximum_panes_in_workspace: usize,
    pub maximum_tabs_in_workspace: usize,
    pub total_pane_count: usize,
    pub total_tab_count: usize,
}

impl LegacyOverLimit {
    pub(crate) fn counts(workspaces: &[Workspace]) -> Self {
        Self {
            workspace_count: workspaces.len(),
            maximum_panes_in_workspace: workspaces
                .iter()
                .map(|workspace| workspace.panes.len())
                .max()
                .unwrap_or_default(),
            maximum_tabs_in_workspace: workspaces
                .iter()
                .map(|workspace| workspace.tabs.len())
                .max()
                .unwrap_or_default(),
            total_pane_count: workspaces
                .iter()
                .map(|workspace| workspace.panes.len())
                .sum(),
            total_tab_count: workspaces
                .iter()
                .map(|workspace| workspace.tabs.len())
                .sum(),
        }
    }

    #[must_use]
    pub fn from_workspaces(workspaces: &[Workspace]) -> Option<Self> {
        let counts = Self::counts(workspaces);
        counts.exceeds_any_limit().then_some(counts)
    }

    #[must_use]
    pub const fn exceeds_any_limit(&self) -> bool {
        self.workspace_count > APPLICATION_MAX_WORKSPACES
            || self.maximum_panes_in_workspace > WORKSPACE_MAX_PANES
            || self.maximum_tabs_in_workspace > WORKSPACE_MAX_TABS
            || self.total_pane_count > APPLICATION_MAX_PANES
            || self.total_tab_count > APPLICATION_MAX_TABS
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        for (field, count) in [
            ("legacy_over_limit.workspace_count", self.workspace_count),
            (
                "legacy_over_limit.maximum_panes_in_workspace",
                self.maximum_panes_in_workspace,
            ),
            (
                "legacy_over_limit.maximum_tabs_in_workspace",
                self.maximum_tabs_in_workspace,
            ),
            ("legacy_over_limit.total_pane_count", self.total_pane_count),
            ("legacy_over_limit.total_tab_count", self.total_tab_count),
        ] {
            let count = u64::try_from(count).map_err(|_| DomainError::InvalidState {
                message: format!("{field} is outside the safe integer range"),
            })?;
            if count > MAX_SAFE_INTEGER {
                return Err(DomainError::InvalidState {
                    message: format!("{field} is outside the safe integer range"),
                });
            }
        }
        Ok(())
    }

    pub(crate) fn require_nonincreasing(&self, next: &Self) -> Result<(), DomainError> {
        for (dimension, was, now, limit) in [
            (
                "workspaces",
                self.workspace_count,
                next.workspace_count,
                APPLICATION_MAX_WORKSPACES,
            ),
            (
                "panes_per_workspace",
                self.maximum_panes_in_workspace,
                next.maximum_panes_in_workspace,
                WORKSPACE_MAX_PANES,
            ),
            (
                "tabs_per_workspace",
                self.maximum_tabs_in_workspace,
                next.maximum_tabs_in_workspace,
                WORKSPACE_MAX_TABS,
            ),
            (
                "total_panes",
                self.total_pane_count,
                next.total_pane_count,
                APPLICATION_MAX_PANES,
            ),
            (
                "total_tabs",
                self.total_tab_count,
                next.total_tab_count,
                APPLICATION_MAX_TABS,
            ),
        ] {
            if now > limit && (was <= limit || now > was) {
                return Err(DomainError::LegacyLimitReductionRequired { dimension });
            }
        }
        Ok(())
    }
}

/// Portable tab content containing intent only, never live browser or terminal ownership.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum LayoutTabContentTemplate {
    Terminal { launch: TerminalLaunchSpec },
    Browser { url: String },
}

/// Portable tab metadata with stable durable tree identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutTabTemplate {
    pub id: TabId,
    pub pane_id: PaneId,
    pub title: String,
    pub custom_title: Option<String>,
    pub content: LayoutTabContentTemplate,
    pub created_at: Timestamp,
}

impl From<&Tab> for LayoutTabTemplate {
    fn from(tab: &Tab) -> Self {
        let content = match &tab.content {
            TabContent::Terminal { launch, .. } => LayoutTabContentTemplate::Terminal {
                launch: launch.clone(),
            },
            TabContent::Browser { metadata } => LayoutTabContentTemplate::Browser {
                url: portable_browser_url(metadata.url())
                    .expect("validated live browser URL must have a portable representation"),
            },
        };
        Self {
            id: tab.id,
            pane_id: tab.pane_id,
            title: tab.title.clone(),
            custom_title: tab.custom_title.clone(),
            content,
            created_at: tab.created_at,
        }
    }
}

/// Portable workspace layout. Browser profile, session, navigation, and correlation state are
/// deliberately unrepresentable.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutWorkspaceTemplate {
    pub id: WorkspaceId,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub working_directory: PathBuf,
    pub layout: PaneNode,
    pub selected_pane_id: PaneId,
    pub panes: BTreeMap<PaneId, Pane>,
    pub tabs: BTreeMap<TabId, LayoutTabTemplate>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl From<&Workspace> for LayoutWorkspaceTemplate {
    fn from(workspace: &Workspace) -> Self {
        Self {
            id: workspace.id,
            name: workspace.name.clone(),
            description: workspace.description.clone(),
            color: workspace.color.clone(),
            working_directory: workspace.working_directory.clone(),
            layout: workspace.layout.clone(),
            selected_pane_id: workspace.selected_pane_id,
            panes: workspace.panes.clone(),
            tabs: workspace
                .tabs
                .iter()
                .map(|(id, tab)| (*id, LayoutTabTemplate::from(tab)))
                .collect(),
            created_at: workspace.created_at,
            updated_at: workspace.updated_at,
        }
    }
}

impl From<Workspace> for LayoutWorkspaceTemplate {
    fn from(workspace: Workspace) -> Self {
        Self::from(&workspace)
    }
}

/// Portable checked workspace tree containing no runtime session or browser-storage state.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutTemplate {
    pub workspaces: Vec<LayoutWorkspaceTemplate>,
}

impl LayoutTemplate {
    /// Creates and validates a portable bounded workspace template.
    ///
    /// # Errors
    /// Returns an error for invalid workspace trees, duplicate IDs, or exceeded bounds.
    pub fn new<T>(workspaces: Vec<T>) -> Result<Self, DomainError>
    where
        T: Into<LayoutWorkspaceTemplate>,
    {
        let value = Self {
            workspaces: workspaces.into_iter().map(Into::into).collect(),
        };
        value.validate()?;
        Ok(value)
    }

    /// Captures a live workspace set while scrubbing all runtime-only browser and terminal state.
    ///
    /// # Errors
    /// Returns an error when the resulting portable template violates a bound or graph invariant.
    pub fn from_live_workspaces(workspaces: &[Workspace]) -> Result<Self, DomainError> {
        Self::new(
            workspaces
                .iter()
                .map(LayoutWorkspaceTemplate::from)
                .collect(),
        )
    }

    /// Validates the complete template graph and its serialized byte size.
    ///
    /// # Errors
    /// Returns the first structural, field, count, duplicate, or size violation.
    pub fn validate(&self) -> Result<(), DomainError> {
        check_limit(
            "layout_template.workspaces",
            self.workspaces.len(),
            LAYOUT_TEMPLATE_MAX_WORKSPACES,
        )?;
        if self.workspaces.is_empty() {
            return Err(DomainError::InvalidState {
                message: "saved-layout template has no workspaces".to_owned(),
            });
        }
        let panes = self.workspaces.iter().map(|value| value.panes.len()).sum();
        let tabs = self.workspaces.iter().map(|value| value.tabs.len()).sum();
        check_limit("layout_template.panes", panes, LAYOUT_TEMPLATE_MAX_PANES)?;
        check_limit("layout_template.tabs", tabs, LAYOUT_TEMPLATE_MAX_TABS)?;
        let mut workspace_ids = BTreeSet::new();
        let mut pane_ids = BTreeSet::new();
        let mut split_ids = BTreeSet::new();
        let mut tab_ids = BTreeSet::new();
        for workspace in &self.workspaces {
            workspace.materialize(&BTreeMap::new())?.validate()?;
            check_limit(
                "layout_workspace.panes",
                workspace.panes.len(),
                WORKSPACE_MAX_PANES,
            )?;
            check_limit(
                "layout_workspace.tabs",
                workspace.tabs.len(),
                WORKSPACE_MAX_TABS,
            )?;
            insert_unique(&mut workspace_ids, workspace.id, "layout workspace")?;
            for id in workspace.panes.keys() {
                insert_unique(&mut pane_ids, *id, "layout pane")?;
            }
            workspace.layout.collect(&mut Vec::new(), &mut split_ids)?;
            for id in workspace.tabs.keys() {
                insert_unique(&mut tab_ids, *id, "layout tab")?;
            }
            for tab in workspace.tabs.values() {
                if let LayoutTabContentTemplate::Browser { url } = &tab.content
                    && portable_browser_url(url)? != *url
                {
                    return Err(DomainError::UnsafeBrowserUrl);
                }
            }
        }
        let bytes = serde_json::to_vec(self)
            .map_err(|error| DomainError::InvalidState {
                message: error.to_string(),
            })?
            .len();
        if bytes > LAYOUT_TEMPLATE_MAX_BYTES {
            return Err(DomainError::LayoutTemplateTooLarge {
                actual: bytes,
                maximum: LAYOUT_TEMPLATE_MAX_BYTES,
            });
        }
        Ok(())
    }

    /// Replaces all workspace, pane, split, and tab identities with fresh local UUIDs.
    ///
    /// # Errors
    /// Returns an error if the remapped template fails the complete template contract.
    pub fn with_fresh_ids(&self) -> Result<Self, DomainError> {
        let mut workspaces = self.workspaces.clone();
        for workspace in &mut workspaces {
            let pane_ids: BTreeMap<_, _> = workspace
                .panes
                .keys()
                .map(|id| (*id, PaneId::new()))
                .collect();
            let tab_ids: BTreeMap<_, _> = workspace
                .tabs
                .keys()
                .map(|id| (*id, TabId::new()))
                .collect();
            workspace.id = WorkspaceId::new();
            remap_layout(&mut workspace.layout, &pane_ids);
            let mut panes = BTreeMap::new();
            for (old_id, mut pane) in std::mem::take(&mut workspace.panes) {
                pane.id = pane_ids[&old_id];
                pane.tabs = pane.tabs.iter().map(|id| tab_ids[id]).collect();
                pane.selected_tab_id = tab_ids[&pane.selected_tab_id];
                panes.insert(pane.id, pane);
            }
            workspace.selected_pane_id = pane_ids[&workspace.selected_pane_id];
            workspace.panes = panes;
            let mut tabs = BTreeMap::new();
            for (old_id, mut tab) in std::mem::take(&mut workspace.tabs) {
                tab.id = tab_ids[&old_id];
                tab.pane_id = pane_ids[&tab.pane_id];
                tabs.insert(tab.id, tab);
            }
            workspace.tabs = tabs;
        }
        Self::new(workspaces)
    }

    pub(crate) fn materialize(
        &self,
        current_tabs: &BTreeMap<TabId, &Tab>,
    ) -> Result<Vec<Workspace>, DomainError> {
        self.workspaces
            .iter()
            .map(|workspace| workspace.materialize(current_tabs))
            .collect()
    }
}

/// Reduces a live browser URL to credential-free canonical HTTP(S) origin/path intent.
///
/// Query, fragment, and user-info components can contain credentials or other private state and
/// are deliberately discarded. Saved-layout import validates that the supplied value is already
/// exactly this canonical representation.
fn portable_browser_url(value: &str) -> Result<String, DomainError> {
    let mut parsed = Url::parse(value).map_err(|_| DomainError::UnsafeBrowserUrl)?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(DomainError::UnsafeBrowserUrl);
    }
    parsed
        .set_username("")
        .map_err(|()| DomainError::UnsafeBrowserUrl)?;
    parsed
        .set_password(None)
        .map_err(|()| DomainError::UnsafeBrowserUrl)?;
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.into())
}

impl LayoutWorkspaceTemplate {
    fn materialize(&self, current_tabs: &BTreeMap<TabId, &Tab>) -> Result<Workspace, DomainError> {
        let mut tabs = BTreeMap::new();
        for (id, template) in &self.tabs {
            let mut tab = match &template.content {
                LayoutTabContentTemplate::Terminal { launch } => {
                    let preserved =
                        current_tabs
                            .get(id)
                            .and_then(|current| match &current.content {
                                TabContent::Terminal {
                                    launch: current_launch,
                                    runtime_session_id,
                                } if current_launch == launch => runtime_session_id.clone(),
                                _ => None,
                            });
                    Tab::terminal(
                        template.id,
                        template.pane_id,
                        &template.title,
                        launch.clone(),
                        preserved,
                        template.created_at,
                    )?
                }
                LayoutTabContentTemplate::Browser { url } => {
                    let metadata = current_tabs
                        .get(id)
                        .and_then(|current| match &current.content {
                            TabContent::Browser { metadata }
                                if portable_browser_url(metadata.url())
                                    .is_ok_and(|current_url| current_url == *url) =>
                            {
                                Some(metadata.clone())
                            }
                            _ => None,
                        })
                        .map_or_else(|| BrowserMetadata::new(url), Ok)?;
                    Tab::browser(
                        template.id,
                        template.pane_id,
                        &template.title,
                        metadata,
                        template.created_at,
                    )?
                }
            };
            tab.set_custom_title(template.custom_title.clone())?;
            tabs.insert(*id, tab);
        }
        let workspace = Workspace {
            id: self.id,
            name: self.name.clone(),
            description: self.description.clone(),
            color: self.color.clone(),
            working_directory: self.working_directory.clone(),
            layout: self.layout.clone(),
            selected_pane_id: self.selected_pane_id,
            panes: self.panes.clone(),
            tabs,
            created_at: self.created_at,
            updated_at: self.updated_at,
        };
        workspace.validate()?;
        Ok(workspace)
    }
}

fn remap_layout(node: &mut PaneNode, panes: &BTreeMap<PaneId, PaneId>) {
    match node {
        PaneNode::Leaf { pane_id } => *pane_id = panes[pane_id],
        PaneNode::Split {
            split_id,
            first,
            second,
            ..
        } => {
            *split_id = SplitId::new();
            remap_layout(first, panes);
            remap_layout(second, panes);
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedLayout {
    pub id: LayoutId,
    pub name: String,
    pub format_version: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub template: LayoutTemplate,
}

impl SavedLayout {
    /// Creates a named version-one saved layout.
    ///
    /// # Errors
    /// Returns an error for invalid text, timestamps, format, or template content.
    pub fn new(
        id: LayoutId,
        name: impl Into<String>,
        template: LayoutTemplate,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<Self, DomainError> {
        let value = Self {
            id,
            name: checked_text(
                "saved_layout.name",
                &name.into(),
                ORGANIZATION_NAME_MAX_CHARS,
                false,
            )?,
            format_version: LAYOUT_FORMAT_VERSION,
            created_at,
            updated_at,
            template,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        if self.format_version != LAYOUT_FORMAT_VERSION {
            return Err(DomainError::UnsupportedLayoutFormat {
                version: self.format_version,
            });
        }
        let normalized = checked_text(
            "saved_layout.name",
            &self.name,
            ORGANIZATION_NAME_MAX_CHARS,
            false,
        )?;
        if normalized != self.name {
            return Err(DomainError::InvalidState {
                message: "saved layout name is not normalized".to_owned(),
            });
        }
        validate_timestamp("saved_layout.created_at", self.created_at)?;
        validate_timestamp("saved_layout.updated_at", self.updated_at)?;
        self.template.validate()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutExportEnvelope {
    pub format_version: u32,
    pub name: String,
    pub template: LayoutTemplate,
}

impl LayoutExportEnvelope {
    #[must_use]
    pub fn from_saved_layout(layout: &SavedLayout) -> Self {
        Self {
            format_version: layout.format_version,
            name: layout.name.clone(),
            template: layout.template.clone(),
        }
    }

    /// Validates strict format, name, and template invariants before import.
    ///
    /// # Errors
    /// Returns an error for an unsupported version or invalid bounded content.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.format_version != LAYOUT_FORMAT_VERSION {
            return Err(DomainError::UnsupportedLayoutFormat {
                version: self.format_version,
            });
        }
        checked_text(
            "saved_layout.name",
            &self.name,
            ORGANIZATION_NAME_MAX_CHARS,
            false,
        )?;
        self.template.validate()
    }
}

/// Pure preflight result. Runtime-owned sessions named here may remain attached during commit.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutApplyPlan {
    pub workspaces: Vec<Workspace>,
    pub selected_workspace_id: WorkspaceId,
    pub preserved_terminal_sessions: Vec<RuntimeSessionId>,
}

pub(crate) fn check_limit(
    resource: &'static str,
    actual: usize,
    maximum: usize,
) -> Result<(), DomainError> {
    if actual > maximum {
        return Err(DomainError::ResourceLimit {
            resource,
            actual,
            maximum,
        });
    }
    Ok(())
}

fn insert_unique<T: Ord + Copy + ToString>(
    values: &mut BTreeSet<T>,
    value: T,
    entity: &'static str,
) -> Result<(), DomainError> {
    if !values.insert(value) {
        return Err(DomainError::DuplicateId {
            entity,
            id: value.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn within_limits() -> LegacyOverLimit {
        LegacyOverLimit {
            workspace_count: APPLICATION_MAX_WORKSPACES,
            maximum_panes_in_workspace: WORKSPACE_MAX_PANES,
            maximum_tabs_in_workspace: WORKSPACE_MAX_TABS,
            total_pane_count: APPLICATION_MAX_PANES,
            total_tab_count: APPLICATION_MAX_TABS,
        }
    }

    #[test]
    fn reduction_mode_rejects_every_within_limit_to_over_limit_transition() {
        let mut current = within_limits();
        current.workspace_count = APPLICATION_MAX_WORKSPACES + 1;
        let assert_transition = |dimension, mutate: fn(&mut LegacyOverLimit)| {
            let mut next = current.clone();
            mutate(&mut next);
            assert_eq!(
                current.require_nonincreasing(&next),
                Err(DomainError::LegacyLimitReductionRequired { dimension })
            );
        };
        assert_transition("panes_per_workspace", |value| {
            value.maximum_panes_in_workspace = WORKSPACE_MAX_PANES + 1;
        });
        assert_transition("tabs_per_workspace", |value| {
            value.maximum_tabs_in_workspace = WORKSPACE_MAX_TABS + 1;
        });
        assert_transition("total_panes", |value| {
            value.total_pane_count = APPLICATION_MAX_PANES + 1;
        });
        assert_transition("total_tabs", |value| {
            value.total_tab_count = APPLICATION_MAX_TABS + 1;
        });
    }

    #[test]
    fn reduction_mode_allows_only_nonincreasing_already_exceeded_dimensions() {
        let mut current = within_limits();
        current.workspace_count += 2;
        let mut reduced = current.clone();
        reduced.workspace_count -= 1;
        assert_eq!(current.require_nonincreasing(&reduced), Ok(()));
        let mut increased = current.clone();
        increased.workspace_count += 1;
        assert_eq!(
            current.require_nonincreasing(&increased),
            Err(DomainError::LegacyLimitReductionRequired {
                dimension: "workspaces"
            })
        );
    }
}

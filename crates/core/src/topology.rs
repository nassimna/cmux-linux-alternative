#![allow(clippy::missing_errors_doc, clippy::missing_panics_doc)]

use std::collections::BTreeSet;
use std::path::{Component, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{MAX_SAFE_INTEGER, checked_browser_url, checked_text, validate_timestamp};
use crate::{
    ApplicationState, ClosedItemId, DomainError, MutationOutcome, PaneId, TabId, Timestamp,
    WindowId, WorkspaceId,
};

pub const WINDOW_PLACEMENT_CAP: usize = 16;
pub const MAX_WINDOW_LABEL_CHARS: usize = 128;
pub const CLOSED_ITEM_RETENTION_CAP: usize = 100;
pub const CLOSED_ITEM_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
pub const CLOSED_ITEM_TITLE_MAX_CHARS: usize = 160;
pub const RESTORE_DESCRIPTOR_MAX_BYTES: usize = 8 * 1_024;
pub const CLOSED_BROWSER_URL_MAX_CHARS: usize = 2_048;
pub const FOCUS_HISTORY_CAP: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostingState {
    Hosted,
    Unhosted,
    Closing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowPlacement {
    pub id: WindowId,
    pub label: String,
    pub workspace_ids: Vec<WorkspaceId>,
    pub focused_workspace_id: WorkspaceId,
    pub hosting_state: HostingState,
    pub revision: u64,
}

impl WindowPlacement {
    pub fn new(
        id: WindowId,
        label: impl Into<String>,
        initial_workspace_id: WorkspaceId,
    ) -> Result<Self, DomainError> {
        let value = Self {
            id,
            label: checked_text("window.label", &label.into(), MAX_WINDOW_LABEL_CHARS, false)?,
            workspace_ids: vec![initial_workspace_id],
            focused_workspace_id: initial_workspace_id,
            hosting_state: HostingState::Unhosted,
            revision: 0,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn migrated_default(
        id: WindowId,
        workspace_ids: Vec<WorkspaceId>,
        focused_workspace_id: WorkspaceId,
    ) -> Self {
        Self {
            id,
            label: "Main".to_owned(),
            workspace_ids,
            focused_workspace_id,
            hosting_state: HostingState::Unhosted,
            revision: 0,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        checked_text("window.label", &self.label, MAX_WINDOW_LABEL_CHARS, false)?;
        if self.workspace_ids.is_empty() {
            return Err(invalid("window placement has no workspaces"));
        }
        if self.revision > MAX_SAFE_INTEGER {
            return Err(invalid("window revision exceeds the safe integer bound"));
        }
        let unique: BTreeSet<_> = self.workspace_ids.iter().copied().collect();
        if unique.len() != self.workspace_ids.len() {
            return Err(invalid("window placement contains duplicate workspaces"));
        }
        if !unique.contains(&self.focused_workspace_id) {
            return Err(invalid("window focus is not owned by the placement"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClosedItemKind {
    Tab,
    Workspace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClosedContentKind {
    Terminal,
    Browser,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum RestoreDescriptor {
    Terminal {
        authorized_root_id: WorkspaceId,
        root_relative_cwd: PathBuf,
        rows: u16,
        cols: u16,
    },
    Browser {
        url: String,
    },
}

impl RestoreDescriptor {
    pub fn terminal(
        authorized_root_id: WorkspaceId,
        root_relative_cwd: PathBuf,
        rows: u16,
        cols: u16,
    ) -> Result<Self, DomainError> {
        let value = Self::Terminal {
            authorized_root_id,
            root_relative_cwd,
            rows,
            cols,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn browser(url: impl Into<String>) -> Result<Self, DomainError> {
        let input = checked_browser_url(&url.into())?;
        let mut parsed = url::Url::parse(&input).map_err(|_| DomainError::UnsafeBrowserUrl)?;
        parsed.set_query(None);
        parsed.set_fragment(None);
        let value = Self::Browser {
            url: parsed.to_string(),
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        match self {
            Self::Terminal {
                root_relative_cwd,
                rows,
                cols,
                ..
            } => {
                if root_relative_cwd.is_absolute()
                    || root_relative_cwd.components().any(|component| {
                        matches!(
                            component,
                            Component::CurDir
                                | Component::ParentDir
                                | Component::RootDir
                                | Component::Prefix(_)
                        )
                    })
                {
                    return Err(invalid("closed terminal cwd is not root-relative"));
                }
                if !(1..=1_000).contains(rows) || !(1..=1_000).contains(cols) {
                    return Err(DomainError::InvalidTerminalDimensions);
                }
            }
            Self::Browser { url } => {
                let parsed = url::Url::parse(url).map_err(|_| DomainError::UnsafeBrowserUrl)?;
                if url.chars().count() > CLOSED_BROWSER_URL_MAX_CHARS
                    || checked_browser_url(url)? != *url
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(DomainError::UnsafeBrowserUrl);
                }
            }
        }
        let actual = serde_json::to_vec(self)
            .map_err(|_| invalid("restore descriptor cannot be serialized"))?
            .len();
        if actual > RESTORE_DESCRIPTOR_MAX_BYTES {
            return Err(DomainError::ResourceLimit {
                resource: "restore_descriptor_bytes",
                actual,
                maximum: RESTORE_DESCRIPTOR_MAX_BYTES,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClosedItemRecord {
    pub id: ClosedItemId,
    pub item_kind: ClosedItemKind,
    pub prior_workspace_id: WorkspaceId,
    pub prior_tab_id: Option<TabId>,
    pub content_kind: ClosedContentKind,
    pub title: String,
    pub closed_at: Timestamp,
    pub restore: RestoreDescriptor,
}

impl ClosedItemRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: ClosedItemId,
        item_kind: ClosedItemKind,
        prior_workspace_id: WorkspaceId,
        prior_tab_id: Option<TabId>,
        content_kind: ClosedContentKind,
        title: impl Into<String>,
        closed_at: Timestamp,
        restore: RestoreDescriptor,
    ) -> Result<Self, DomainError> {
        let value = Self {
            id,
            item_kind,
            prior_workspace_id,
            prior_tab_id,
            content_kind,
            title: checked_text(
                "closed.title",
                &title.into(),
                CLOSED_ITEM_TITLE_MAX_CHARS,
                true,
            )?,
            closed_at,
            restore,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        checked_text(
            "closed.title",
            &self.title,
            CLOSED_ITEM_TITLE_MAX_CHARS,
            true,
        )?;
        validate_timestamp("closed.closed_at", self.closed_at)?;
        if self.item_kind == ClosedItemKind::Tab && self.prior_tab_id.is_none() {
            return Err(invalid("closed tab record has no prior tab identity"));
        }
        match (&self.content_kind, &self.restore) {
            (ClosedContentKind::Terminal, RestoreDescriptor::Terminal { .. })
            | (ClosedContentKind::Browser, RestoreDescriptor::Browser { .. }) => {
                self.restore.validate()
            }
            _ => Err(invalid("closed content kind and restore descriptor differ")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusTarget {
    pub window_id: WindowId,
    pub workspace_id: WorkspaceId,
    pub pane_id: PaneId,
    pub tab_id: TabId,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusHistory {
    pub entries: Vec<FocusTarget>,
    pub cursor: usize,
}

/// One deterministic durable rehome caused by provider-claim reconciliation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowRehome {
    pub source_window_id: WindowId,
    pub target_window_id: WindowId,
}

/// Aggregate mutation outcome plus the native ownership moves required after persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowHostingReconciliation {
    pub outcome: MutationOutcome,
    pub rehomes: Vec<WindowRehome>,
}

impl ApplicationState {
    #[must_use]
    pub fn window_placement(&self, id: WindowId) -> Option<&WindowPlacement> {
        self.window_placements
            .iter()
            .find(|placement| placement.id == id)
    }

    #[must_use]
    pub fn window_for_workspace(&self, id: WorkspaceId) -> Option<&WindowPlacement> {
        self.window_placements
            .iter()
            .find(|placement| placement.workspace_ids.contains(&id))
    }

    pub fn create_window_placement(
        &mut self,
        window_id: WindowId,
        label: impl Into<String>,
        workspace_id: WorkspaceId,
    ) -> Result<MutationOutcome, DomainError> {
        let label = label.into();
        self.transact(|state| {
            if state.window_placements.len() >= WINDOW_PLACEMENT_CAP {
                return Err(DomainError::ResourceLimit {
                    resource: "window_placements",
                    actual: state.window_placements.len() + 1,
                    maximum: WINDOW_PLACEMENT_CAP,
                });
            }
            if state.window_placement(window_id).is_some() {
                return Err(DomainError::DuplicateId {
                    entity: "window",
                    id: window_id.to_string(),
                });
            }
            remove_workspace_from_placement(state, workspace_id)?;
            state
                .window_placements
                .push(WindowPlacement::new(window_id, label, workspace_id)?);
            state.focused_window_id = window_id;
            state.selected_workspace_id = workspace_id;
            Ok(())
        })
    }

    pub fn move_workspace_to_window(
        &mut self,
        workspace_id: WorkspaceId,
        target_window_id: WindowId,
        destination_index: usize,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let source = placement_index_for_workspace(state, workspace_id)?;
            let target = placement_index(state, target_window_id)?;
            let source_position = state.window_placements[source]
                .workspace_ids
                .iter()
                .position(|id| *id == workspace_id)
                .expect("membership checked");
            let maximum = if source == target {
                state.window_placements[target]
                    .workspace_ids
                    .len()
                    .saturating_sub(1)
            } else {
                state.window_placements[target].workspace_ids.len()
            };
            if destination_index > maximum {
                return Err(DomainError::IndexOutOfBounds {
                    index: destination_index,
                    len: maximum + 1,
                });
            }
            if source == target {
                if source_position == destination_index {
                    return Ok(());
                }
                let id = state.window_placements[source]
                    .workspace_ids
                    .remove(source_position);
                state.window_placements[source]
                    .workspace_ids
                    .insert(destination_index, id);
                state.window_placements[source].focused_workspace_id = id;
            } else {
                state.window_placements[source]
                    .workspace_ids
                    .remove(source_position);
                state.window_placements[target]
                    .workspace_ids
                    .insert(destination_index, workspace_id);
                state.window_placements[target].focused_workspace_id = workspace_id;
                if state.window_placements[source].workspace_ids.is_empty() {
                    state.window_placements.remove(source);
                } else {
                    repair_placement_focus(&mut state.window_placements[source]);
                }
            }
            state.focused_window_id = target_window_id;
            state.selected_workspace_id = workspace_id;
            state.workspace_selection = vec![workspace_id];
            Ok(())
        })
    }

    pub fn close_window_placement(
        &mut self,
        window_id: WindowId,
        rehome_target: Option<WindowId>,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let source = placement_index(state, window_id)?;
            if let Some(target_id) = rehome_target {
                if target_id == window_id {
                    return Err(invalid("window cannot rehome to itself"));
                }
                let target = placement_index(state, target_id)?;
                if state.window_placements[target].hosting_state != HostingState::Hosted {
                    return Err(invalid("window rehome target must be hosted"));
                }
                let focused = state.window_placements[source].focused_workspace_id;
                let moved = state.window_placements[source].workspace_ids.clone();
                state.window_placements[target].workspace_ids.extend(moved);
                state.window_placements[target].focused_workspace_id = focused;
                state.window_placements.remove(source);
                state.focused_window_id = target_id;
            } else {
                state.window_placements[source].hosting_state = HostingState::Unhosted;
            }
            Ok(())
        })
    }

    /// Explicitly closes every workspace owned by a placement in one aggregate mutation.
    ///
    /// The caller supplies one authenticated redacted tab record for every closed tab. Closing
    /// the final application workspaces requires one unbound replacement workspace.
    #[allow(clippy::too_many_lines)]
    pub fn close_window_workspaces(
        &mut self,
        window_id: WindowId,
        replacement: Option<crate::Workspace>,
        closed_records: Vec<ClosedItemRecord>,
        now: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let placement = state
                .window_placement(window_id)
                .ok_or(DomainError::WindowNotFound { id: window_id })?
                .clone();
            let closing_ids: BTreeSet<_> = placement.workspace_ids.iter().copied().collect();
            let closing_panes: BTreeSet<_> = state
                .workspaces
                .iter()
                .filter(|workspace| closing_ids.contains(&workspace.id))
                .flat_map(|workspace| workspace.panes.keys().copied())
                .collect();
            let closing_tab_ids: BTreeSet<_> = state
                .workspaces
                .iter()
                .filter(|workspace| closing_ids.contains(&workspace.id))
                .flat_map(|workspace| workspace.tabs.keys().copied())
                .collect();
            let closing_browser_sessions: BTreeSet<_> = state
                .workspaces
                .iter()
                .filter(|workspace| closing_ids.contains(&workspace.id))
                .flat_map(|workspace| workspace.tabs.values())
                .filter_map(|tab| match &tab.content {
                    crate::TabContent::Browser { metadata } => Some(metadata.browser_session_id()),
                    crate::TabContent::Terminal { .. } => None,
                })
                .collect();
            let closing_tabs: Vec<_> = state
                .workspaces
                .iter()
                .filter(|workspace| closing_ids.contains(&workspace.id))
                .flat_map(|workspace| workspace.tabs.values().map(move |tab| (workspace, tab)))
                .collect();
            if closed_records.len() != closing_tabs.len() {
                return Err(invalid(
                    "window close requires exactly one closed record per tab",
                ));
            }
            let mut record_tabs = BTreeSet::new();
            for record in &closed_records {
                record.validate()?;
                if record.item_kind != ClosedItemKind::Tab
                    || record.closed_at > now
                    || !record_tabs.insert((record.prior_workspace_id, record.prior_tab_id))
                {
                    return Err(invalid(
                        "window close contains an invalid or duplicate closed record",
                    ));
                }
            }
            for (workspace, tab) in &closing_tabs {
                let record = closed_records
                    .iter()
                    .find(|record| {
                        record.prior_workspace_id == workspace.id
                            && record.prior_tab_id == Some(tab.id)
                    })
                    .ok_or_else(|| invalid("window close is missing a tab record"))?;
                crate::state::validate_closed_record_for_tab(record, workspace, tab)?;
            }
            let closes_everything = closing_ids.len() == state.workspaces.len();
            if closes_everything && replacement.is_none() {
                return Err(DomainError::ReplacementRequired {
                    entity: "workspace",
                });
            }
            if !closes_everything && replacement.is_some() {
                return Err(DomainError::UnexpectedReplacement {
                    entity: "workspace",
                });
            }
            state
                .workspaces
                .retain(|workspace| !closing_ids.contains(&workspace.id));
            if let Some(replacement) = replacement {
                replacement.validate()?;
                crate::state::require_unbound_workspace(&replacement)?;
                if closing_ids.contains(&replacement.id)
                    || replacement
                        .panes
                        .keys()
                        .any(|id| closing_panes.contains(id))
                    || replacement
                        .tabs
                        .keys()
                        .any(|id| closing_tab_ids.contains(id))
                    || replacement.tabs.values().any(|tab| match &tab.content {
                        crate::TabContent::Browser { metadata } => {
                            closing_browser_sessions.contains(&metadata.browser_session_id())
                        }
                        crate::TabContent::Terminal { .. } => false,
                    })
                {
                    return Err(invalid(
                        "replacement workspace reuses a closing durable identity",
                    ));
                }
                state.workspaces.push(replacement);
            }
            state.workspace_pins.retain(|id| !closing_ids.contains(id));
            state
                .workspace_group_assignments
                .retain(|id, _| !closing_ids.contains(id));
            state
                .workspace_selection
                .retain(|id| !closing_ids.contains(id));
            state
                .window_placements
                .retain(|placement| placement.id != window_id);
            if closing_ids.contains(&state.selected_workspace_id) {
                state.selected_workspace_id = state.workspaces[0].id;
                state.workspace_selection = vec![state.selected_workspace_id];
            } else if !state
                .workspace_selection
                .contains(&state.selected_workspace_id)
            {
                state.workspace_selection.push(state.selected_workspace_id);
            }
            state.recently_closed.extend(closed_records);
            prune_closed(&mut state.recently_closed, now);
            Ok(())
        })
    }

    pub fn set_window_hosting_state(
        &mut self,
        window_id: WindowId,
        hosting_state: HostingState,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let index = placement_index(state, window_id)?;
            state.window_placements[index].hosting_state = hosting_state;
            Ok(())
        })
    }

    /// Reconciles every provider-hosted placement in one aggregate mutation.
    ///
    /// This compatibility projection discards the explicit rehome plan. Runtime integrations that
    /// coordinate native ownership must call [`Self::reconcile_window_claims`] instead.
    pub fn reconcile_window_hosting(
        &mut self,
        claimed: &BTreeSet<WindowId>,
    ) -> Result<MutationOutcome, DomainError> {
        self.reconcile_window_claims(claimed)
            .map(|reconciliation| reconciliation.outcome)
    }

    /// Reconciles provider claims and returns every required native ownership rehome.
    ///
    /// Previously hosted placements absent from the claim set are rehomed to the lowest ordered
    /// claimed placement and removed. If no eligible placement survives, they remain durable and
    /// become unhosted. Unknown or closing claims fail without changing the aggregate.
    pub fn reconcile_window_claims(
        &mut self,
        claimed: &BTreeSet<WindowId>,
    ) -> Result<WindowHostingReconciliation, DomainError> {
        let mut rehomes = Vec::new();
        let outcome = self.transact(|state| {
            for window_id in claimed {
                let placement = state
                    .window_placement(*window_id)
                    .ok_or(DomainError::WindowNotFound { id: *window_id })?;
                if placement.hosting_state == HostingState::Closing {
                    return Err(invalid("a closing window placement cannot be reclaimed"));
                }
            }

            let rehome_target = claimed.iter().next().copied();
            let missing_hosted: Vec<_> = state
                .window_placements
                .iter()
                .filter(|placement| {
                    placement.hosting_state == HostingState::Hosted
                        && !claimed.contains(&placement.id)
                })
                .map(|placement| placement.id)
                .collect();
            if let Some(target_id) = rehome_target {
                for source_id in missing_hosted {
                    let source = placement_index(state, source_id)?;
                    let moved = state.window_placements[source].workspace_ids.clone();
                    state.window_placements.remove(source);
                    let target = placement_index(state, target_id)?;
                    state.window_placements[target].workspace_ids.extend(moved);
                    if state.focused_window_id == source_id {
                        state.focused_window_id = target_id;
                    }
                    rehomes.push(WindowRehome {
                        source_window_id: source_id,
                        target_window_id: target_id,
                    });
                }
            }
            for placement in &mut state.window_placements {
                if claimed.contains(&placement.id) {
                    placement.hosting_state = HostingState::Hosted;
                } else if placement.hosting_state == HostingState::Hosted {
                    placement.hosting_state = HostingState::Unhosted;
                }
            }
            Ok(())
        })?;
        Ok(WindowHostingReconciliation { outcome, rehomes })
    }

    pub fn focus_target(&mut self, target: FocusTarget) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| apply_focus(state, target, true))
    }

    pub fn focus_back(&mut self) -> Result<MutationOutcome, DomainError> {
        self.transact_focus_navigation(|state| {
            if state.focus_history.entries.is_empty() || state.focus_history.cursor == 0 {
                return Ok(());
            }
            state.focus_history.cursor -= 1;
            apply_focus(
                state,
                state.focus_history.entries[state.focus_history.cursor],
                false,
            )
        })
    }

    pub fn focus_forward(&mut self) -> Result<MutationOutcome, DomainError> {
        self.transact_focus_navigation(|state| {
            if state.focus_history.entries.is_empty()
                || state.focus_history.cursor + 1 >= state.focus_history.entries.len()
            {
                return Ok(());
            }
            state.focus_history.cursor += 1;
            apply_focus(
                state,
                state.focus_history.entries[state.focus_history.cursor],
                false,
            )
        })
    }

    pub fn append_closed_record(
        &mut self,
        record: ClosedItemRecord,
        now: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            record.validate()?;
            validate_timestamp("closed.retention_now", now)?;
            if record.closed_at > now {
                return Err(invalid("closed record timestamp is in the future"));
            }
            if state
                .recently_closed
                .iter()
                .any(|item| item.id == record.id)
            {
                return Err(DomainError::DuplicateId {
                    entity: "closed_item",
                    id: record.id.to_string(),
                });
            }
            state.recently_closed.push(record);
            prune_closed(&mut state.recently_closed, now);
            Ok(())
        })
    }

    pub fn prune_recently_closed(
        &mut self,
        now: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            validate_timestamp("closed.retention_now", now)?;
            prune_closed(&mut state.recently_closed, now);
            Ok(())
        })
    }

    pub fn consume_closed_record(
        &mut self,
        id: ClosedItemId,
    ) -> Result<(MutationOutcome, ClosedItemRecord), DomainError> {
        let record = self
            .recently_closed
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or(DomainError::ClosedItemNotFound { id })?;
        let outcome = self.transact(|state| {
            state.recently_closed.retain(|item| item.id != id);
            Ok(())
        })?;
        Ok((outcome, record))
    }

    pub(crate) fn reconcile_topology(&mut self) {
        let ids: BTreeSet<_> = self
            .workspaces
            .iter()
            .map(|workspace| workspace.id)
            .collect();
        for placement in &mut self.window_placements {
            placement.workspace_ids.retain(|id| ids.contains(id));
        }
        self.window_placements
            .retain(|placement| !placement.workspace_ids.is_empty());
        let placed: BTreeSet<_> = self
            .window_placements
            .iter()
            .flat_map(|placement| placement.workspace_ids.iter().copied())
            .collect();
        let missing: Vec<_> = self
            .workspaces
            .iter()
            .map(|workspace| workspace.id)
            .filter(|id| !placed.contains(id))
            .collect();
        if self.window_placements.is_empty() {
            self.window_placements
                .push(WindowPlacement::migrated_default(
                    WindowId::from_uuid(self.selected_workspace_id.as_uuid()),
                    missing,
                    self.selected_workspace_id,
                ));
        } else if !missing.is_empty() {
            let target = self
                .window_placements
                .iter()
                .position(|placement| placement.id == self.focused_window_id)
                .unwrap_or(0);
            self.window_placements[target].workspace_ids.extend(missing);
            self.window_placements[target].focused_workspace_id = self.selected_workspace_id;
        }
        for placement in &mut self.window_placements {
            repair_placement_focus(placement);
        }
        if self.window_placement(self.focused_window_id).is_none() {
            self.focused_window_id = self.window_placements[0].id;
        }
        if let Some(index) = self.window_placements.iter().position(|placement| {
            placement
                .workspace_ids
                .contains(&self.selected_workspace_id)
        }) {
            self.focused_window_id = self.window_placements[index].id;
            self.window_placements[index].focused_workspace_id = self.selected_workspace_id;
        }
        let entries_through_cursor = self.focus_history.cursor.saturating_add(1);
        let retained_through_cursor = self
            .focus_history
            .entries
            .iter()
            .take(entries_through_cursor)
            .filter(|target| focus_target_valid(self, **target))
            .count();
        let valid_entries: Vec<_> = self
            .focus_history
            .entries
            .iter()
            .copied()
            .filter(|target| focus_target_valid(self, *target))
            .collect();
        self.focus_history.cursor = retained_through_cursor
            .saturating_sub(1)
            .min(valid_entries.len().saturating_sub(1));
        self.focus_history.entries = valid_entries;
    }

    pub(crate) fn record_focus_transition(&mut self, previous: &Self) {
        let Some(next) = current_focus_target(self) else {
            return;
        };
        let prior = current_focus_target(previous);
        if prior == Some(next) {
            return;
        }
        if self.focus_history.entries.is_empty()
            && let Some(prior) = prior
            && focus_target_valid(self, prior)
        {
            self.focus_history.entries.push(prior);
        }
        if self.focus_history.entries.last().copied() != Some(next) {
            if !self.focus_history.entries.is_empty() {
                self.focus_history
                    .entries
                    .truncate(self.focus_history.cursor + 1);
            }
            self.focus_history.entries.push(next);
        }
        if self.focus_history.entries.len() > FOCUS_HISTORY_CAP {
            self.focus_history.entries.remove(0);
        }
        self.focus_history.cursor = self.focus_history.entries.len().saturating_sub(1);
    }

    pub(crate) fn bump_changed_window_revisions(
        &mut self,
        previous: &Self,
    ) -> Result<(), DomainError> {
        for placement in &mut self.window_placements {
            let Some(old) = previous
                .window_placements
                .iter()
                .find(|old| old.id == placement.id)
            else {
                continue;
            };
            let candidate_revision = placement.revision;
            placement.revision = old.revision;
            if *placement == *old {
                placement.revision = candidate_revision.min(old.revision);
            } else {
                placement.revision = old
                    .revision
                    .checked_add(1)
                    .filter(|revision| *revision <= MAX_SAFE_INTEGER)
                    .ok_or(DomainError::RevisionOverflow)?;
            }
        }
        Ok(())
    }

    pub(crate) fn validate_topology(
        &self,
        workspace_ids: &BTreeSet<WorkspaceId>,
    ) -> Result<(), DomainError> {
        if self.window_placements.is_empty() || self.window_placements.len() > WINDOW_PLACEMENT_CAP
        {
            return Err(DomainError::ResourceLimit {
                resource: "window_placements",
                actual: self.window_placements.len(),
                maximum: WINDOW_PLACEMENT_CAP,
            });
        }
        let mut windows = BTreeSet::new();
        let mut owned = BTreeSet::new();
        for placement in &self.window_placements {
            placement.validate()?;
            if !windows.insert(placement.id) {
                return Err(DomainError::DuplicateId {
                    entity: "window",
                    id: placement.id.to_string(),
                });
            }
            for id in &placement.workspace_ids {
                if !workspace_ids.contains(id) || !owned.insert(*id) {
                    return Err(invalid(
                        "workspace placement ownership is dangling or duplicated",
                    ));
                }
            }
        }
        if &owned != workspace_ids {
            return Err(invalid("a workspace has no window placement owner"));
        }
        if !windows.contains(&self.focused_window_id) {
            return Err(invalid("focused window placement does not exist"));
        }
        if self.focus_history.entries.len() > FOCUS_HISTORY_CAP
            || (!self.focus_history.entries.is_empty()
                && self.focus_history.cursor >= self.focus_history.entries.len())
            || (self.focus_history.entries.is_empty() && self.focus_history.cursor != 0)
        {
            return Err(invalid(
                "focus history exceeds its bound or has an invalid cursor",
            ));
        }
        if self
            .focus_history
            .entries
            .iter()
            .any(|target| !focus_target_valid(self, *target))
        {
            return Err(invalid("focus history contains a dangling target"));
        }
        if self.recently_closed.len() > CLOSED_ITEM_RETENTION_CAP {
            return Err(DomainError::ResourceLimit {
                resource: "recently_closed",
                actual: self.recently_closed.len(),
                maximum: CLOSED_ITEM_RETENTION_CAP,
            });
        }
        let mut closed = BTreeSet::new();
        let mut previous = None;
        for record in &self.recently_closed {
            record.validate()?;
            if !closed.insert(record.id) {
                return Err(DomainError::DuplicateId {
                    entity: "closed_item",
                    id: record.id.to_string(),
                });
            }
            let key = (record.closed_at, record.id);
            if previous.is_some_and(|previous| previous > key) {
                return Err(invalid(
                    "recently-closed records are not canonically ordered",
                ));
            }
            previous = Some(key);
        }
        Ok(())
    }
}

fn apply_focus(
    state: &mut ApplicationState,
    target: FocusTarget,
    record: bool,
) -> Result<(), DomainError> {
    if !focus_target_valid(state, target) {
        return Err(invalid("focus target ownership is invalid"));
    }
    let workspace = state
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == target.workspace_id)
        .expect("validated");
    workspace.selected_pane_id = target.pane_id;
    workspace
        .panes
        .get_mut(&target.pane_id)
        .expect("validated")
        .selected_tab_id = target.tab_id;
    state.selected_workspace_id = target.workspace_id;
    state.workspace_selection = vec![target.workspace_id];
    state.focused_window_id = target.window_id;
    state
        .window_placements
        .iter_mut()
        .find(|placement| placement.id == target.window_id)
        .expect("validated")
        .focused_workspace_id = target.workspace_id;
    if record {
        if !state.focus_history.entries.is_empty() {
            state
                .focus_history
                .entries
                .truncate(state.focus_history.cursor + 1);
        }
        if state.focus_history.entries.last().copied() != Some(target) {
            state.focus_history.entries.push(target);
        }
        if state.focus_history.entries.len() > FOCUS_HISTORY_CAP {
            state.focus_history.entries.remove(0);
        }
        state.focus_history.cursor = state.focus_history.entries.len().saturating_sub(1);
    }
    Ok(())
}

fn focus_target_valid(state: &ApplicationState, target: FocusTarget) -> bool {
    state
        .window_placement(target.window_id)
        .is_some_and(|placement| placement.workspace_ids.contains(&target.workspace_id))
        && state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == target.workspace_id)
            .and_then(|workspace| {
                workspace
                    .panes
                    .get(&target.pane_id)
                    .map(|pane| (workspace, pane))
            })
            .is_some_and(|(workspace, pane)| {
                pane.tabs.contains(&target.tab_id)
                    && workspace
                        .tabs
                        .get(&target.tab_id)
                        .is_some_and(|tab| tab.pane_id == target.pane_id)
            })
}

fn current_focus_target(state: &ApplicationState) -> Option<FocusTarget> {
    let placement = state.window_for_workspace(state.selected_workspace_id)?;
    let workspace = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == state.selected_workspace_id)?;
    let pane = workspace.panes.get(&workspace.selected_pane_id)?;
    Some(FocusTarget {
        window_id: placement.id,
        workspace_id: workspace.id,
        pane_id: pane.id,
        tab_id: pane.selected_tab_id,
    })
}

fn placement_index(state: &ApplicationState, id: WindowId) -> Result<usize, DomainError> {
    state
        .window_placements
        .iter()
        .position(|placement| placement.id == id)
        .ok_or(DomainError::WindowNotFound { id })
}

fn placement_index_for_workspace(
    state: &ApplicationState,
    id: WorkspaceId,
) -> Result<usize, DomainError> {
    state
        .window_placements
        .iter()
        .position(|placement| placement.workspace_ids.contains(&id))
        .ok_or(DomainError::WorkspaceNotFound { id })
}

fn remove_workspace_from_placement(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
) -> Result<(), DomainError> {
    if !state
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(DomainError::WorkspaceNotFound { id: workspace_id });
    }
    let source = placement_index_for_workspace(state, workspace_id)?;
    state.window_placements[source]
        .workspace_ids
        .retain(|id| *id != workspace_id);
    if state.window_placements[source].workspace_ids.is_empty() {
        state.window_placements.remove(source);
    } else {
        repair_placement_focus(&mut state.window_placements[source]);
    }
    Ok(())
}

fn repair_placement_focus(placement: &mut WindowPlacement) {
    if !placement
        .workspace_ids
        .contains(&placement.focused_workspace_id)
    {
        placement.focused_workspace_id = placement.workspace_ids[0];
    }
}

pub(crate) fn prune_closed(records: &mut Vec<ClosedItemRecord>, now: Timestamp) {
    records.retain(|record| now.0.saturating_sub(record.closed_at.0) <= CLOSED_ITEM_RETENTION_MS);
    records.sort_by_key(|record| (record.closed_at, record.id));
    if records.len() > CLOSED_ITEM_RETENTION_CAP {
        records.drain(..records.len() - CLOSED_ITEM_RETENTION_CAP);
    }
}

fn invalid(message: impl Into<String>) -> DomainError {
    DomainError::InvalidState {
        message: message.into(),
    }
}

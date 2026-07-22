#![allow(clippy::missing_errors_doc, clippy::missing_panics_doc)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::model::{
    MAX_COLOR_CHARS, MAX_DESCRIPTION_CHARS, MAX_SAFE_INTEGER, checked_text, clamped_ratio,
};
use crate::topology::prune_closed;
use crate::{
    ApplicationState, Axis, ClosedItemId, ClosedItemRecord, CommandId, DomainError, GroupId,
    HostingState, LayoutApplyPlan, LayoutExportEnvelope, LayoutId, LayoutTabContentTemplate,
    LegacyOverLimit, LogicalShortcut, NOTIFICATION_RETENTION_CAP, Notification, NotificationId,
    NotificationSettings, Pane, PaneId, PaneNode, RuntimeSessionId, SavedLayout, ShortcutPlatform,
    SplitId, SplitPlacement, Tab, TabContent, TabId, TerminalLaunchSpec, Timestamp, WindowId,
    Workspace, WorkspaceGroup, WorkspaceId, WorkspaceUpdate,
};

/// Terminal launch requested by the pure domain mutation layer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalLaunchRequest {
    /// Workspace containing the new tab.
    pub workspace_id: WorkspaceId,
    /// Pane owning the new tab.
    pub pane_id: PaneId,
    /// New terminal tab identity.
    pub tab_id: TabId,
    /// Persistent launch metadata to pass to a terminal runtime.
    pub launch: TerminalLaunchSpec,
}

/// Side-effect description returned after an atomic mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationOutcome {
    /// Revision committed by the mutation.
    pub revision: u64,
    /// New unattached terminal tabs that an orchestrator may launch.
    pub terminal_launches: Vec<TerminalLaunchRequest>,
    /// Removed runtime sessions that an orchestrator may terminate after persistence succeeds.
    pub terminal_sessions_to_terminate: Vec<RuntimeSessionId>,
}

/// Content source for a newly split pane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SplitContent {
    /// Move an existing tab, preserving content and runtime identity.
    ExistingTab(TabId),
    /// Insert a caller-created terminal tab.
    NewTerminal(Tab),
    /// Insert a caller-created browser tab without creating a transient terminal runtime.
    NewBrowser(Tab),
}

impl ApplicationState {
    pub(crate) fn transact(
        &mut self,
        mutation: impl FnOnce(&mut Self) -> Result<(), DomainError>,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact_internal(mutation, true)
    }

    pub(crate) fn transact_focus_navigation(
        &mut self,
        mutation: impl FnOnce(&mut Self) -> Result<(), DomainError>,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact_internal(mutation, false)
    }

    fn transact_internal(
        &mut self,
        mutation: impl FnOnce(&mut Self) -> Result<(), DomainError>,
        record_focus: bool,
    ) -> Result<MutationOutcome, DomainError> {
        let mut candidate = self.clone();
        mutation(&mut candidate)?;
        candidate.reconcile_topology();
        if record_focus {
            candidate.record_focus_transition(self);
        }
        candidate.bump_changed_window_revisions(self)?;
        let next_counts = LegacyOverLimit::counts(&candidate.workspaces);
        if let Some(current) = &self.legacy_over_limit {
            current.require_nonincreasing(&next_counts)?;
            candidate.legacy_over_limit = next_counts.exceeds_any_limit().then_some(next_counts);
        } else {
            // Reduction mode is migration-only and cannot be entered by an ordinary v4 mutation.
            candidate.legacy_over_limit = None;
        }
        candidate.validate()?;
        if candidate == *self {
            return Ok(MutationOutcome {
                revision: self.revision,
                terminal_launches: Vec::new(),
                terminal_sessions_to_terminate: Vec::new(),
            });
        }
        let revision = self
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or(DomainError::RevisionOverflow)?;
        candidate.revision = revision;
        let outcome = mutation_outcome(self, &candidate);
        *self = candidate;
        Ok(MutationOutcome {
            revision,
            ..outcome
        })
    }

    /// Appends a caller-created workspace and selects it.
    ///
    /// # Errors
    /// Returns an error when the workspace is invalid or its ID already exists.
    pub fn create_workspace(
        &mut self,
        workspace: Workspace,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            workspace.validate()?;
            require_unbound_workspace(&workspace)?;
            if state.workspaces.iter().any(|item| item.id == workspace.id) {
                return Err(duplicate("workspace", &workspace.id));
            }
            state.selected_workspace_id = workspace.id;
            state.workspace_selection = vec![workspace.id];
            state.workspaces.push(workspace);
            Ok(())
        })
    }

    /// Appends a caller-created workspace to a specific window placement and focuses it there.
    ///
    /// The workspace creation, placement ownership, and global focus change commit as one
    /// revision. Callers that do not have an authoritative window target should use
    /// [`Self::create_workspace`] instead.
    ///
    /// # Errors
    /// Returns an error when the workspace is invalid or conflicts with an existing identity,
    /// or when the target placement is missing or closing.
    pub fn create_workspace_in_window(
        &mut self,
        workspace: Workspace,
        window_id: WindowId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            workspace.validate()?;
            require_unbound_workspace(&workspace)?;
            if state.workspaces.iter().any(|item| item.id == workspace.id) {
                return Err(duplicate("workspace", &workspace.id));
            }
            let placement_index = state
                .window_placements
                .iter()
                .position(|placement| placement.id == window_id)
                .ok_or(DomainError::WindowNotFound { id: window_id })?;
            if state.window_placements[placement_index].hosting_state == HostingState::Closing {
                return Err(DomainError::InvalidOperation {
                    message: "cannot create a workspace in a closing window placement",
                });
            }

            let workspace_id = workspace.id;
            state.workspaces.push(workspace);
            state.window_placements[placement_index]
                .workspace_ids
                .push(workspace_id);
            state.window_placements[placement_index].focused_workspace_id = workspace_id;
            state.selected_workspace_id = workspace_id;
            state.workspace_selection = vec![workspace_id];
            state.focused_window_id = window_id;
            Ok(())
        })
    }

    /// Updates workspace metadata and records a caller-supplied update time.
    ///
    /// # Errors
    /// Returns an error when the workspace is missing or supplied metadata is invalid.
    pub fn update_workspace(
        &mut self,
        workspace_id: WorkspaceId,
        update: WorkspaceUpdate,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            let before = workspace.clone();
            if let Some(name) = update.name {
                workspace.name = checked_text("workspace.name", &name, 128, false)?;
            }
            if let Some(description) = update.description {
                workspace.description = description
                    .map(|value| {
                        checked_text("workspace.description", &value, MAX_DESCRIPTION_CHARS, true)
                    })
                    .transpose()?;
            }
            if let Some(color) = update.color {
                workspace.color = color
                    .map(|value| checked_text("workspace.color", &value, MAX_COLOR_CHARS, false))
                    .transpose()?;
            }
            if let Some(path) = update.working_directory {
                if !path.is_absolute() {
                    return Err(DomainError::RelativePath {
                        field: "workspace.working_directory",
                    });
                }
                workspace.working_directory = path;
            }
            if *workspace == before {
                return Err(DomainError::InvalidOperation {
                    message: "workspace metadata is unchanged",
                });
            }
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Selects a workspace.
    ///
    /// # Errors
    /// Returns an error when the workspace is missing.
    pub fn select_workspace(
        &mut self,
        workspace_id: WorkspaceId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            workspace_index(state, workspace_id)?;
            if state.selected_workspace_id == workspace_id {
                return Err(DomainError::InvalidOperation {
                    message: "workspace is already selected",
                });
            }
            state.selected_workspace_id = workspace_id;
            state.workspace_selection = vec![workspace_id];
            Ok(())
        })
    }

    /// Moves a workspace to a final zero-based index.
    ///
    /// # Errors
    /// Returns an error for a missing workspace or invalid index. Moving to the
    /// current index is a successful semantic no-op.
    pub fn move_workspace(
        &mut self,
        workspace_id: WorkspaceId,
        destination_index: usize,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let source_index = workspace_index(state, workspace_id)?;
            let len = state.workspaces.len();
            if destination_index >= len {
                return Err(DomainError::IndexOutOfBounds {
                    index: destination_index,
                    len,
                });
            }
            if source_index == destination_index {
                return Ok(());
            }
            let workspace = state.workspaces.remove(source_index);
            state.workspaces.insert(destination_index, workspace);
            Ok(())
        })
    }

    /// Closes a workspace. Closing the final workspace requires a valid replacement.
    ///
    /// # Errors
    /// Returns an error for a missing workspace or an invalid replacement rule.
    pub fn close_workspace(
        &mut self,
        workspace_id: WorkspaceId,
        replacement: Option<Workspace>,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let index = workspace_index(state, workspace_id)?;
            if state.workspaces.len() == 1 {
                let replacement = replacement.ok_or(DomainError::ReplacementRequired {
                    entity: "workspace",
                })?;
                replacement.validate()?;
                require_unbound_workspace(&replacement)?;
                if replacement.id == workspace_id {
                    return Err(DomainError::DuplicateId {
                        entity: "workspace",
                        id: replacement.id.to_string(),
                    });
                }
                replace_placed_workspace(state, workspace_id, replacement.id);
                state.selected_workspace_id = replacement.id;
                state.workspace_selection = vec![replacement.id];
                state.workspace_pins.retain(|id| *id != workspace_id);
                state.workspace_group_assignments.remove(&workspace_id);
                state.workspaces[0] = replacement;
                return Ok(());
            }
            if replacement.is_some() {
                return Err(DomainError::UnexpectedReplacement {
                    entity: "workspace",
                });
            }
            state.workspaces.remove(index);
            state.workspace_selection.retain(|id| *id != workspace_id);
            state.workspace_pins.retain(|id| *id != workspace_id);
            state.workspace_group_assignments.remove(&workspace_id);
            if state.selected_workspace_id == workspace_id {
                let selected_index = index.min(state.workspaces.len() - 1);
                state.selected_workspace_id = state.workspaces[selected_index].id;
            }
            if state.workspace_selection.is_empty()
                || !state
                    .workspace_selection
                    .contains(&state.selected_workspace_id)
            {
                state.workspace_selection.push(state.selected_workspace_id);
            }
            Ok(())
        })
    }

    /// Splits a leaf pane and either moves an existing tab or inserts a new tab.
    ///
    /// # Errors
    /// Returns an error for missing/duplicate IDs, invalid content, or a non-finite ratio.
    #[allow(clippy::too_many_arguments)]
    pub fn split_pane(
        &mut self,
        workspace_id: WorkspaceId,
        target_pane_id: PaneId,
        new_pane_id: PaneId,
        split_id: SplitId,
        axis: Axis,
        ratio: f64,
        placement: SplitPlacement,
        content: SplitContent,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            require_pane(workspace, target_pane_id)?;
            if workspace.panes.contains_key(&new_pane_id) {
                return Err(duplicate("pane", &new_pane_id));
            }
            if contains_split(&workspace.layout, split_id) {
                return Err(duplicate("split", &split_id));
            }
            let ratio = clamped_ratio(ratio)?;
            let tab = match content {
                SplitContent::NewTerminal(tab) => {
                    require_new_terminal(workspace, &tab, new_pane_id)?;
                    tab
                }
                SplitContent::NewBrowser(tab) => {
                    require_new_browser(workspace, &tab, new_pane_id)?;
                    tab
                }
                SplitContent::ExistingTab(tab_id) => {
                    let tab = workspace
                        .tabs
                        .get(&tab_id)
                        .ok_or(DomainError::TabNotFound { id: tab_id })?;
                    let source_id = tab.pane_id;
                    if source_id == target_pane_id && workspace.panes[&source_id].tabs.len() == 1 {
                        return Err(DomainError::SplitWouldEmptyTarget);
                    }
                    let mut tab = tab.clone();
                    remove_tab_reference(workspace, source_id, tab_id)?;
                    if workspace.panes[&source_id].tabs.is_empty() {
                        workspace.panes.remove(&source_id);
                        collapse_leaf(&mut workspace.layout, source_id)?;
                    }
                    tab.pane_id = new_pane_id;
                    tab
                }
            };
            let tab_id = tab.id;
            workspace.tabs.insert(tab_id, tab);
            workspace
                .panes
                .insert(new_pane_id, Pane::new(new_pane_id, tab_id));
            replace_leaf_with_split(
                &mut workspace.layout,
                target_pane_id,
                new_pane_id,
                split_id,
                axis,
                ratio,
                placement,
            )?;
            workspace.selected_pane_id = new_pane_id;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Focuses a pane.
    ///
    /// # Errors
    /// Returns an error when the workspace or pane is missing.
    pub fn focus_pane(
        &mut self,
        workspace_id: WorkspaceId,
        pane_id: PaneId,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            require_pane(workspace, pane_id)?;
            if workspace.selected_pane_id == pane_id {
                return Err(DomainError::InvalidOperation {
                    message: "pane is already focused",
                });
            }
            workspace.selected_pane_id = pane_id;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Resizes a split, clamping finite ratios into `0.05..=0.95`.
    ///
    /// # Errors
    /// Returns an error when the workspace/split is missing or the ratio is non-finite.
    pub fn resize_pane_split(
        &mut self,
        workspace_id: WorkspaceId,
        split_id: SplitId,
        ratio: f64,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            let ratio = clamped_ratio(ratio)?;
            let stored = find_split_ratio_mut(&mut workspace.layout, split_id)
                .ok_or(DomainError::SplitNotFound { id: split_id })?;
            if stored.to_bits() == ratio.to_bits() {
                return Err(DomainError::InvalidOperation {
                    message: "split ratio is unchanged",
                });
            }
            *stored = ratio;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Closes a pane. Closing the final pane replaces it with one terminal tab.
    ///
    /// # Errors
    /// Returns an error for missing IDs or an invalid replacement rule.
    pub fn close_pane(
        &mut self,
        workspace_id: WorkspaceId,
        pane_id: PaneId,
        replacement: Option<Tab>,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            require_pane(workspace, pane_id)?;
            if workspace.panes.len() == 1 {
                let replacement =
                    replacement.ok_or(DomainError::ReplacementRequired { entity: "pane" })?;
                require_new_terminal(workspace, &replacement, pane_id)?;
                let old_ids = workspace.panes[&pane_id].tabs.clone();
                for tab_id in old_ids {
                    workspace.tabs.remove(&tab_id);
                }
                let tab_id = replacement.id;
                workspace.tabs.insert(tab_id, replacement);
                workspace.panes.insert(pane_id, Pane::new(pane_id, tab_id));
            } else {
                if replacement.is_some() {
                    return Err(DomainError::UnexpectedReplacement { entity: "pane" });
                }
                let pane = workspace
                    .panes
                    .remove(&pane_id)
                    .ok_or(DomainError::PaneNotFound { id: pane_id })?;
                for tab_id in pane.tabs {
                    workspace.tabs.remove(&tab_id);
                }
                collapse_leaf(&mut workspace.layout, pane_id)?;
                if workspace.selected_pane_id == pane_id {
                    workspace.selected_pane_id = first_leaf(&workspace.layout);
                }
            }
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Opens a caller-created terminal tab at an insertion boundary and selects it.
    ///
    /// # Errors
    /// Returns an error for missing/duplicate IDs, invalid content, or an invalid index.
    pub fn open_terminal_tab(
        &mut self,
        workspace_id: WorkspaceId,
        pane_id: PaneId,
        index: usize,
        tab: Tab,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            require_pane(workspace, pane_id)?;
            require_new_terminal(workspace, &tab, pane_id)?;
            let len = workspace.panes[&pane_id].tabs.len();
            if index > len {
                return Err(DomainError::IndexOutOfBounds { index, len });
            }
            let tab_id = tab.id;
            workspace.tabs.insert(tab_id, tab);
            let pane = workspace
                .panes
                .get_mut(&pane_id)
                .ok_or(DomainError::PaneNotFound { id: pane_id })?;
            pane.tabs.insert(index, tab_id);
            pane.selected_tab_id = tab_id;
            workspace.selected_pane_id = pane_id;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Selects a tab and focuses its owning pane.
    ///
    /// # Errors
    /// Returns an error when the workspace, tab, or owning pane is missing.
    pub fn select_tab(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            let pane_id = workspace
                .tabs
                .get(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?
                .pane_id;
            if workspace.selected_pane_id == pane_id
                && workspace.panes[&pane_id].selected_tab_id == tab_id
            {
                return Err(DomainError::InvalidOperation {
                    message: "tab is already selected",
                });
            }
            workspace
                .panes
                .get_mut(&pane_id)
                .ok_or(DomainError::PaneNotFound { id: pane_id })?
                .selected_tab_id = tab_id;
            workspace.selected_pane_id = pane_id;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Updates a tab's default and/or custom title.
    ///
    /// # Errors
    /// Returns an error when an ID is missing or supplied title data is invalid.
    pub fn update_tab(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        title: Option<String>,
        custom_title: Option<Option<String>>,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            let tab = workspace
                .tabs
                .get_mut(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?;
            let before = tab.clone();
            if let Some(title) = title {
                tab.set_title(title)?;
            }
            if let Some(custom_title) = custom_title {
                tab.set_custom_title(custom_title)?;
            }
            if *tab == before {
                return Err(DomainError::InvalidOperation {
                    message: "tab metadata is unchanged",
                });
            }
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Moves or reorders a tab. Moving the only tab out of a non-final pane collapses it.
    ///
    /// # Errors
    /// Returns an error for missing IDs, invalid indices, or a normalized self move.
    pub fn move_tab(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        destination_pane_id: PaneId,
        destination_index: usize,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            require_pane(workspace, destination_pane_id)?;
            let source_pane_id = workspace
                .tabs
                .get(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?
                .pane_id;
            let destination_len = workspace.panes[&destination_pane_id].tabs.len();
            if destination_index > destination_len {
                return Err(DomainError::IndexOutOfBounds {
                    index: destination_index,
                    len: destination_len,
                });
            }
            if source_pane_id == destination_pane_id {
                let pane = workspace
                    .panes
                    .get_mut(&source_pane_id)
                    .ok_or(DomainError::PaneNotFound { id: source_pane_id })?;
                let source_index = pane
                    .tabs
                    .iter()
                    .position(|id| *id == tab_id)
                    .ok_or(DomainError::TabNotFound { id: tab_id })?;
                let normalized = if source_index < destination_index {
                    destination_index - 1
                } else {
                    destination_index
                };
                if normalized == source_index {
                    return Err(DomainError::InvalidOperation {
                        message: "tab is already at the destination index",
                    });
                }
                pane.tabs.remove(source_index);
                pane.tabs.insert(normalized, tab_id);
                pane.selected_tab_id = tab_id;
            } else {
                remove_tab_reference(workspace, source_pane_id, tab_id)?;
                if workspace.panes[&source_pane_id].tabs.is_empty() {
                    workspace.panes.remove(&source_pane_id);
                    collapse_leaf(&mut workspace.layout, source_pane_id)?;
                }
                workspace
                    .tabs
                    .get_mut(&tab_id)
                    .ok_or(DomainError::TabNotFound { id: tab_id })?
                    .pane_id = destination_pane_id;
                let destination = workspace.panes.get_mut(&destination_pane_id).ok_or(
                    DomainError::PaneNotFound {
                        id: destination_pane_id,
                    },
                )?;
                destination.tabs.insert(destination_index, tab_id);
                destination.selected_tab_id = tab_id;
            }
            workspace.selected_pane_id = destination_pane_id;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Duplicates bounded durable tab metadata with fresh tab and browser/runtime identity.
    #[allow(clippy::too_many_arguments)]
    pub fn duplicate_tab(
        &mut self,
        source_workspace_id: WorkspaceId,
        source_tab_id: TabId,
        target_workspace_id: WorkspaceId,
        target_pane_id: PaneId,
        destination_index: usize,
        new_tab_id: TabId,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let source = state
                .workspaces
                .iter()
                .find(|workspace| workspace.id == source_workspace_id)
                .ok_or(DomainError::WorkspaceNotFound {
                    id: source_workspace_id,
                })?
                .tabs
                .get(&source_tab_id)
                .ok_or(DomainError::TabNotFound { id: source_tab_id })?
                .clone();
            let target = workspace_mut(state, target_workspace_id)?;
            require_pane(target, target_pane_id)?;
            let len = target.panes[&target_pane_id].tabs.len();
            if destination_index > len {
                return Err(DomainError::IndexOutOfBounds {
                    index: destination_index,
                    len,
                });
            }
            let duplicated = source.duplicate_for(new_tab_id, target_pane_id, created_at)?;
            match &duplicated.content {
                TabContent::Terminal { .. } => {
                    require_new_terminal(target, &duplicated, target_pane_id)?;
                }
                TabContent::Browser { .. } => {
                    require_new_browser(target, &duplicated, target_pane_id)?;
                }
            }
            target.tabs.insert(new_tab_id, duplicated);
            let pane = target.panes.get_mut(&target_pane_id).expect("pane checked");
            pane.tabs.insert(destination_index, new_tab_id);
            pane.selected_tab_id = new_tab_id;
            target.selected_pane_id = target_pane_id;
            target.updated_at = updated_at;
            state.selected_workspace_id = target_workspace_id;
            state.workspace_selection = vec![target_workspace_id];
            Ok(())
        })
    }

    /// Moves the exact durable tab across workspaces without creating or terminating its runtime.
    #[allow(clippy::too_many_arguments)]
    pub fn move_tab_to_workspace(
        &mut self,
        source_workspace_id: WorkspaceId,
        tab_id: TabId,
        target_workspace_id: WorkspaceId,
        target_pane_id: PaneId,
        destination_index: usize,
        source_replacement: Option<Tab>,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        if source_workspace_id == target_workspace_id {
            if source_replacement.is_some() {
                return Err(DomainError::UnexpectedReplacement { entity: "tab" });
            }
            return self.move_tab(
                source_workspace_id,
                tab_id,
                target_pane_id,
                destination_index,
                updated_at,
            );
        }
        self.transact(|state| {
            let tab = take_tab_for_cross_workspace_move(
                state,
                source_workspace_id,
                tab_id,
                source_replacement,
                updated_at,
            )?;
            insert_transferred_tab(
                state,
                target_workspace_id,
                target_pane_id,
                destination_index,
                tab,
                updated_at,
            )
        })
    }

    /// Detaches the exact tab into a new one-pane workspace and new window placement atomically.
    #[allow(clippy::too_many_arguments)]
    pub fn detach_tab_to_window(
        &mut self,
        source_workspace_id: WorkspaceId,
        tab_id: TabId,
        source_replacement: Option<Tab>,
        new_workspace_id: WorkspaceId,
        new_workspace_name: String,
        new_working_directory: PathBuf,
        new_pane_id: PaneId,
        new_window_id: WindowId,
        new_window_label: String,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            if state.window_placements.len() >= crate::WINDOW_PLACEMENT_CAP {
                return Err(DomainError::ResourceLimit {
                    resource: "window_placements",
                    actual: state.window_placements.len() + 1,
                    maximum: crate::WINDOW_PLACEMENT_CAP,
                });
            }
            if state
                .workspaces
                .iter()
                .any(|workspace| workspace.id == new_workspace_id)
            {
                return Err(duplicate("workspace", &new_workspace_id));
            }
            if state.window_placement(new_window_id).is_some() {
                return Err(duplicate("window", &new_window_id));
            }
            let mut tab = take_tab_for_cross_workspace_move(
                state,
                source_workspace_id,
                tab_id,
                source_replacement,
                updated_at,
            )?;
            tab.pane_id = new_pane_id;
            let workspace = Workspace::new(
                new_workspace_id,
                new_workspace_name,
                new_working_directory,
                new_pane_id,
                tab,
                created_at,
                updated_at,
            )?;
            state.workspaces.push(workspace);
            state.window_placements.push(crate::WindowPlacement::new(
                new_window_id,
                new_window_label,
                new_workspace_id,
            )?);
            state.focused_window_id = new_window_id;
            state.selected_workspace_id = new_workspace_id;
            state.workspace_selection = vec![new_workspace_id];
            Ok(())
        })
    }

    /// Closes a tab and appends its already-redacted restore record in the same mutation.
    pub fn close_tab_with_record(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        replacement: Option<Tab>,
        record: ClosedItemRecord,
        now: Timestamp,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            record.validate()?;
            if record.item_kind != crate::ClosedItemKind::Tab
                || record.prior_workspace_id != workspace_id
                || record.prior_tab_id != Some(tab_id)
                || record.closed_at > now
            {
                return Err(DomainError::InvalidState {
                    message: "closed record does not match the tab mutation".to_owned(),
                });
            }
            let workspace = state
                .workspaces
                .iter()
                .find(|workspace| workspace.id == workspace_id)
                .ok_or(DomainError::WorkspaceNotFound { id: workspace_id })?;
            let closing_tab = workspace
                .tabs
                .get(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?;
            validate_closed_record_for_tab(&record, workspace, closing_tab)?;
            if state
                .recently_closed
                .iter()
                .any(|item| item.id == record.id)
            {
                return Err(duplicate("closed_item", &record.id));
            }
            close_tab_in_state(state, workspace_id, tab_id, replacement, updated_at)?;
            state.recently_closed.push(record);
            prune_closed(&mut state.recently_closed, now);
            Ok(())
        })
    }

    /// Consumes a closed record and inserts a fresh-identity tab atomically.
    ///
    /// Terminal runtime identity must be absent. Browser runtime metadata must describe a clean
    /// session and its browser-session identity is always rematerialized by the aggregate.
    pub fn reopen_closed_tab(
        &mut self,
        closed_item_id: ClosedItemId,
        target_workspace_id: WorkspaceId,
        target_pane_id: PaneId,
        destination_index: usize,
        mut tab: Tab,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let index = state
                .recently_closed
                .iter()
                .position(|record| record.id == closed_item_id)
                .ok_or(DomainError::ClosedItemNotFound { id: closed_item_id })?;
            let record = state.recently_closed[index].clone();
            if record.item_kind != crate::ClosedItemKind::Tab || record.prior_tab_id == Some(tab.id)
            {
                return Err(DomainError::InvalidState {
                    message: "reopened tab must use a fresh durable identity".to_owned(),
                });
            }
            validate_reopened_tab(&record, state, &mut tab)?;
            let target = workspace_mut(state, target_workspace_id)?;
            require_pane(target, target_pane_id)?;
            let len = target.panes[&target_pane_id].tabs.len();
            if destination_index > len {
                return Err(DomainError::IndexOutOfBounds {
                    index: destination_index,
                    len,
                });
            }
            match &tab.content {
                TabContent::Terminal { .. } => require_new_terminal(target, &tab, target_pane_id)?,
                TabContent::Browser { .. } => require_new_browser(target, &tab, target_pane_id)?,
            }
            let tab_id = tab.id;
            target.tabs.insert(tab_id, tab);
            let pane = target.panes.get_mut(&target_pane_id).expect("pane checked");
            pane.tabs.insert(destination_index, tab_id);
            pane.selected_tab_id = tab_id;
            target.selected_pane_id = target_pane_id;
            target.updated_at = updated_at;
            state.recently_closed.remove(index);
            state.selected_workspace_id = target_workspace_id;
            state.workspace_selection = vec![target_workspace_id];
            Ok(())
        })
    }

    /// Closes a tab without producing an M3 restore record.
    ///
    /// New capability-qualified close paths must use [`Self::close_tab_with_record`]. This legacy
    /// entry point remains temporarily available for pre-M3 single-window callers and migration
    /// reduction flows only.
    ///
    /// # Errors
    /// Returns an error for missing IDs or an invalid replacement rule.
    #[deprecated(
        since = "0.1.0",
        note = "M3 close paths must use close_tab_with_record so every close is recorded"
    )]
    pub fn close_tab(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        replacement: Option<Tab>,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            close_tab_in_state(state, workspace_id, tab_id, replacement, updated_at)
        })
    }

    /// Binds a runtime-created PTY identity to an unattached terminal tab.
    ///
    /// The identity remains runtime-only and is omitted from serialized snapshots.
    ///
    /// # Errors
    /// Returns an error for missing IDs, browser content, or an already-bound session.
    pub fn bind_terminal_runtime_session(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        runtime_session_id: RuntimeSessionId,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            let tab = workspace
                .tabs
                .get_mut(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?;
            match &mut tab.content {
                TabContent::Terminal {
                    runtime_session_id: current,
                    ..
                } => {
                    if current.is_some() {
                        return Err(DomainError::RuntimeSessionAlreadyBound { id: tab_id });
                    }
                    *current = Some(runtime_session_id);
                }
                TabContent::Browser { .. } => {
                    return Err(DomainError::TabNotTerminal { id: tab_id });
                }
            }
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Atomically swaps an attached terminal's runtime session after a replacement PTY starts.
    ///
    /// The returned outcome schedules the old runtime session for termination. The new runtime
    /// identity remains non-persistent and serialization continues to omit it.
    ///
    /// # Errors
    /// Returns an error for missing IDs, browser content, an unattached terminal, or a runtime
    /// identity already attached anywhere in the application.
    pub fn replace_terminal_runtime_session(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        new_runtime_session_id: RuntimeSessionId,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            if state.workspaces.iter().any(|workspace| {
                workspace
                    .tabs
                    .values()
                    .any(|tab| tab.content.runtime_session_id() == Some(&new_runtime_session_id))
            }) {
                return Err(DomainError::DuplicateId {
                    entity: "runtime_session",
                    id: new_runtime_session_id.to_string(),
                });
            }
            let workspace = workspace_mut(state, workspace_id)?;
            let tab = workspace
                .tabs
                .get_mut(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?;
            match &mut tab.content {
                TabContent::Terminal {
                    runtime_session_id, ..
                } => {
                    if runtime_session_id.is_none() {
                        return Err(DomainError::RuntimeSessionNotBound { id: tab_id });
                    }
                    *runtime_session_id = Some(new_runtime_session_id);
                }
                TabContent::Browser { .. } => {
                    return Err(DomainError::TabNotTerminal { id: tab_id });
                }
            }
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Durably clears one exact terminal runtime identity before its owner terminates the PTY.
    pub fn detach_terminal_runtime_session(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        expected_runtime_session_id: &RuntimeSessionId,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let workspace = workspace_mut(state, workspace_id)?;
            let tab = workspace
                .tabs
                .get_mut(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?;
            match &mut tab.content {
                TabContent::Terminal {
                    runtime_session_id, ..
                } => {
                    if runtime_session_id.as_ref() != Some(expected_runtime_session_id) {
                        return Err(DomainError::RuntimeSessionNotBound { id: tab_id });
                    }
                    *runtime_session_id = None;
                }
                TabContent::Browser { .. } => {
                    return Err(DomainError::TabNotTerminal { id: tab_id });
                }
            }
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Inserts or changes an override. `None` records an explicit clearing.
    ///
    /// # Errors
    /// Returns an error when the active shortcut conflicts with another override.
    pub fn set_shortcut_override(
        &mut self,
        command_id: CommandId,
        shortcut: Option<LogicalShortcut>,
        platform: ShortcutPlatform,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            if state.shortcut_overrides.get(&command_id) == Some(&shortcut) {
                return Err(DomainError::InvalidOperation {
                    message: "shortcut override is unchanged",
                });
            }
            state.shortcut_overrides.insert(command_id, shortcut);
            state.validate_shortcut_overrides_for(platform)
        })
    }

    /// Removes an override so the command returns to its default binding.
    ///
    /// # Errors
    /// Returns an error when no override exists for the command.
    pub fn reset_shortcut_override(
        &mut self,
        command_id: &CommandId,
        platform: ShortcutPlatform,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            if state.shortcut_overrides.remove(command_id).is_none() {
                return Err(DomainError::InvalidOperation {
                    message: "shortcut override is already at its default",
                });
            }
            state.validate_shortcut_overrides_for(platform)
        })
    }

    /// Publishes an unread notification after validating its current target hierarchy.
    ///
    /// Retention is deterministic by `(created_at, id)`: the oldest records are evicted until
    /// the authoritative history is within [`NOTIFICATION_RETENTION_CAP`].
    ///
    /// # Errors
    /// Returns an error for malformed content, a duplicate ID, or a missing/mismatched target.
    pub fn publish_notification(
        &mut self,
        notification: Notification,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            notification.validate()?;
            if state
                .notifications
                .iter()
                .any(|item| item.id == notification.id)
            {
                return Err(duplicate("notification", &notification.id));
            }
            if notification.read_at.is_some() {
                return Err(DomainError::InvalidOperation {
                    message: "a newly published notification must be unread",
                });
            }
            let workspace = state
                .workspaces
                .iter()
                .find(|workspace| workspace.id == notification.workspace_id)
                .ok_or(DomainError::WorkspaceNotFound {
                    id: notification.workspace_id,
                })?;
            if let Some(pane_id) = notification.pane_id {
                require_pane(workspace, pane_id)?;
            }
            if let Some(tab_id) = notification.tab_id {
                let tab = workspace
                    .tabs
                    .get(&tab_id)
                    .ok_or(DomainError::TabNotFound { id: tab_id })?;
                if let Some(pane_id) = notification.pane_id
                    && pane_id != tab.pane_id
                {
                    return Err(DomainError::TabPaneMismatch {
                        tab: tab_id,
                        expected: pane_id,
                        actual: tab.pane_id,
                    });
                }
            }
            state.notifications.push(notification);
            while state.notifications.len() > NOTIFICATION_RETENTION_CAP {
                let Some(oldest) = state
                    .notifications
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, item)| (item.created_at, item.id))
                    .map(|(index, _)| index)
                else {
                    break;
                };
                state.notifications.remove(oldest);
            }
            Ok(())
        })
    }

    /// Marks an unread notification read using a caller-supplied timestamp.
    ///
    /// # Errors
    /// Returns an error when the record is missing, already read, or the timestamp is invalid.
    pub fn mark_notification_read(
        &mut self,
        notification_id: NotificationId,
        read_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let notification = notification_mut(state, notification_id)?;
            if notification.read_at.is_some() {
                return Err(DomainError::InvalidOperation {
                    message: "notification is already read",
                });
            }
            notification.read_at = Some(read_at);
            Ok(())
        })
    }

    /// Marks a read notification unread.
    ///
    /// # Errors
    /// Returns an error when the record is missing or already unread.
    pub fn mark_notification_unread(
        &mut self,
        notification_id: NotificationId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let notification = notification_mut(state, notification_id)?;
            if notification.read_at.take().is_none() {
                return Err(DomainError::InvalidOperation {
                    message: "notification is already unread",
                });
            }
            Ok(())
        })
    }

    /// Removes one retained notification.
    ///
    /// # Errors
    /// Returns an error when the record is missing.
    pub fn clear_notification(
        &mut self,
        notification_id: NotificationId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let index = state
                .notifications
                .iter()
                .position(|item| item.id == notification_id)
                .ok_or(DomainError::NotificationNotFound {
                    id: notification_id,
                })?;
            state.notifications.remove(index);
            Ok(())
        })
    }

    /// Removes every read notification while preserving unread records.
    ///
    /// # Errors
    /// Returns an error when there are no read notifications to clear.
    pub fn clear_read_notifications(&mut self) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let before = state.notifications.len();
            state.notifications.retain(Notification::is_unread);
            if state.notifications.len() == before {
                return Err(DomainError::InvalidOperation {
                    message: "there are no read notifications to clear",
                });
            }
            Ok(())
        })
    }

    /// Removes the complete notification history.
    ///
    /// # Errors
    /// Returns an error when the history is already empty.
    pub fn clear_all_notifications(&mut self) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            if state.notifications.is_empty() {
                return Err(DomainError::InvalidOperation {
                    message: "notification history is already empty",
                });
            }
            state.notifications.clear();
            Ok(())
        })
    }

    /// Replaces persisted operating-system notification policy.
    ///
    /// # Errors
    /// Returns an error when the policy is unchanged.
    pub fn set_notification_settings(
        &mut self,
        settings: NotificationSettings,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            if state.notification_settings == settings {
                return Err(DomainError::InvalidOperation {
                    message: "notification settings are unchanged",
                });
            }
            state.notification_settings = settings;
            Ok(())
        })
    }

    /// Replaces the complete authoritative workspace selection and focus.
    ///
    /// # Errors
    /// Returns an error for missing, duplicate, dangling, empty, or focus-omitting selections.
    pub fn replace_workspace_selection(
        &mut self,
        selection: Vec<WorkspaceId>,
        focused_workspace_id: WorkspaceId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            for id in &selection {
                workspace_index(state, *id)?;
            }
            if !selection.contains(&focused_workspace_id) {
                return Err(DomainError::InvalidState {
                    message: "focused workspace must belong to selection".to_owned(),
                });
            }
            state.workspace_selection = selection;
            state.selected_workspace_id = focused_workspace_id;
            Ok(())
        })
    }

    /// Sets pin membership without changing canonical workspace order.
    ///
    /// # Errors
    /// Returns an error when the workspace is missing or the pin bound would be exceeded.
    pub fn set_workspace_pinned(
        &mut self,
        workspace_id: WorkspaceId,
        pinned: bool,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            workspace_index(state, workspace_id)?;
            if pinned {
                if !state.workspace_pins.contains(&workspace_id) {
                    state.workspace_pins.push(workspace_id);
                }
            } else {
                state.workspace_pins.retain(|id| *id != workspace_id);
            }
            Ok(())
        })
    }

    /// Atomically closes the authoritative selection, retaining deterministic successor focus.
    ///
    /// # Errors
    /// Returns an error for invalid selection or final-workspace replacement rules.
    pub fn close_selected_workspaces(
        &mut self,
        replacement: Option<Workspace>,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let closing: BTreeSet<_> = state.workspace_selection.iter().copied().collect();
            if closing.is_empty() {
                return Err(DomainError::InvalidState {
                    message: "workspace selection is empty".to_owned(),
                });
            }
            if closing.len() == state.workspaces.len() {
                let replacement = replacement.ok_or(DomainError::ReplacementRequired {
                    entity: "workspace",
                })?;
                replacement.validate()?;
                require_unbound_workspace(&replacement)?;
                if state
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.id == replacement.id)
                {
                    return Err(duplicate("workspace", &replacement.id));
                }
                replace_placed_workspace(state, state.selected_workspace_id, replacement.id);
                state.workspaces = vec![replacement];
                state.selected_workspace_id = state.workspaces[0].id;
                state.workspace_selection = vec![state.selected_workspace_id];
                state.workspace_pins.clear();
                state.workspace_group_assignments.clear();
                return Ok(());
            }
            if replacement.is_some() {
                return Err(DomainError::UnexpectedReplacement {
                    entity: "workspace",
                });
            }
            let focused_index = workspace_index(state, state.selected_workspace_id)?;
            let next_focus = state.workspaces[focused_index + 1..]
                .iter()
                .find(|workspace| !closing.contains(&workspace.id))
                .or_else(|| {
                    state.workspaces[..focused_index]
                        .iter()
                        .rev()
                        .find(|workspace| !closing.contains(&workspace.id))
                })
                .map(|workspace| workspace.id)
                .ok_or_else(|| DomainError::InvalidState {
                    message: "batch close could not choose a successor".to_owned(),
                })?;
            state
                .workspaces
                .retain(|workspace| !closing.contains(&workspace.id));
            state.workspace_pins.retain(|id| !closing.contains(id));
            state
                .workspace_group_assignments
                .retain(|id, _| !closing.contains(id));
            state.selected_workspace_id = next_focus;
            state.workspace_selection = vec![next_focus];
            Ok(())
        })
    }

    /// Creates a group at the end of durable group order.
    ///
    /// # Errors
    /// Returns an error for a duplicate ID, invalid name, or exceeded group bound.
    pub fn create_workspace_group(
        &mut self,
        id: GroupId,
        name: impl Into<String>,
    ) -> Result<MutationOutcome, DomainError> {
        let name = name.into();
        self.transact(|state| {
            if state.workspace_groups.iter().any(|group| group.id == id) {
                return Err(duplicate("workspace_group", &id));
            }
            let order = u32::try_from(state.workspace_groups.len()).map_err(|_| {
                DomainError::ResourceLimit {
                    resource: "workspace_groups",
                    actual: state.workspace_groups.len() + 1,
                    maximum: crate::organization::WORKSPACE_GROUP_MAX_COUNT,
                }
            })?;
            state
                .workspace_groups
                .push(WorkspaceGroup::new(id, name, order)?);
            Ok(())
        })
    }

    /// Replaces a group's normalized bounded name.
    ///
    /// # Errors
    /// Returns an error when the group is missing or the name is invalid.
    pub fn rename_workspace_group(
        &mut self,
        group_id: GroupId,
        name: impl Into<String>,
    ) -> Result<MutationOutcome, DomainError> {
        let name = name.into();
        self.transact(|state| {
            let group = workspace_group_mut(state, group_id)?;
            group.name = checked_text("workspace_group.name", &name, 80, false)?;
            Ok(())
        })
    }

    /// Deletes a group and atomically ungroups all members.
    ///
    /// # Errors
    /// Returns an error when the group is missing.
    pub fn delete_workspace_group(
        &mut self,
        group_id: GroupId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let index = workspace_group_index(state, group_id)?;
            state.workspace_groups.remove(index);
            state
                .workspace_group_assignments
                .retain(|_, assigned| *assigned != group_id);
            normalize_group_orders(&mut state.workspace_groups);
            Ok(())
        })
    }

    /// Moves a group to a final zero-based durable order index.
    ///
    /// # Errors
    /// Returns an error for a missing group or out-of-range index.
    pub fn move_workspace_group(
        &mut self,
        group_id: GroupId,
        destination_index: usize,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let source = workspace_group_index(state, group_id)?;
            if destination_index >= state.workspace_groups.len() {
                return Err(DomainError::IndexOutOfBounds {
                    index: destination_index,
                    len: state.workspace_groups.len(),
                });
            }
            if source != destination_index {
                let group = state.workspace_groups.remove(source);
                state.workspace_groups.insert(destination_index, group);
                normalize_group_orders(&mut state.workspace_groups);
            }
            Ok(())
        })
    }

    /// Assigns or ungroups one workspace.
    ///
    /// # Errors
    /// Returns an error for a missing workspace/group or exceeded assignment bound.
    pub fn assign_workspace_group(
        &mut self,
        workspace_id: WorkspaceId,
        group_id: Option<GroupId>,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            workspace_index(state, workspace_id)?;
            if let Some(group_id) = group_id {
                workspace_group_index(state, group_id)?;
                state
                    .workspace_group_assignments
                    .insert(workspace_id, group_id);
            } else {
                state.workspace_group_assignments.remove(&workspace_id);
            }
            Ok(())
        })
    }

    /// Sets durable group collapse state without changing focus or selection.
    ///
    /// # Errors
    /// Returns an error when the group is missing.
    pub fn set_workspace_group_collapsed(
        &mut self,
        group_id: GroupId,
        collapsed: bool,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            workspace_group_mut(state, group_id)?.collapsed = collapsed;
            Ok(())
        })
    }

    /// Inserts or replaces a checked saved layout by ID.
    ///
    /// # Errors
    /// Returns an error when the layout is invalid or the layout bound would be exceeded.
    pub fn save_layout(&mut self, layout: SavedLayout) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            layout.validate()?;
            if let Some(index) = state
                .saved_layouts
                .iter()
                .position(|value| value.id == layout.id)
            {
                state.saved_layouts[index] = layout;
            } else {
                state.saved_layouts.push(layout);
            }
            Ok(())
        })
    }

    /// Deletes a saved layout by ID.
    ///
    /// # Errors
    /// Returns an error when the layout is missing.
    pub fn delete_saved_layout(
        &mut self,
        layout_id: LayoutId,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            let index = saved_layout_index(state, layout_id)?;
            state.saved_layouts.remove(index);
            Ok(())
        })
    }

    /// Produces a portable strict envelope without runtime terminal identities.
    ///
    /// # Errors
    /// Returns an error when the layout is missing.
    pub fn export_saved_layout(
        &self,
        layout_id: LayoutId,
    ) -> Result<LayoutExportEnvelope, DomainError> {
        let index = saved_layout_index(self, layout_id)?;
        Ok(LayoutExportEnvelope::from_saved_layout(
            &self.saved_layouts[index],
        ))
    }

    /// Validates a portable envelope and stores it under fresh local tree identities.
    ///
    /// # Errors
    /// Returns an error for any envelope, template, timestamp, ID, or capacity violation.
    pub fn import_saved_layout(
        &mut self,
        envelope: LayoutExportEnvelope,
        layout_id: LayoutId,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        envelope.validate()?;
        let template = envelope.template.with_fresh_ids()?;
        self.save_layout(SavedLayout::new(
            layout_id,
            envelope.name,
            template,
            created_at,
            updated_at,
        )?)
    }

    /// Preflights path authorization and derives a complete side-effect-free layout candidate.
    ///
    /// # Errors
    /// Returns an error for a missing/invalid layout, unauthorized path, or invalid candidate.
    pub fn plan_saved_layout_application(
        &self,
        layout_id: LayoutId,
        authorized_workspace_roots: &[PathBuf],
    ) -> Result<LayoutApplyPlan, DomainError> {
        let layout = &self.saved_layouts[saved_layout_index(self, layout_id)?];
        layout.validate()?;
        for workspace in &layout.template.workspaces {
            authorize_path(&workspace.working_directory, authorized_workspace_roots)?;
            for tab in workspace.tabs.values() {
                if let LayoutTabContentTemplate::Terminal { launch } = &tab.content {
                    authorize_path(&launch.cwd, authorized_workspace_roots)?;
                }
            }
        }
        let current_tabs: BTreeMap<_, _> = self
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.tabs.values().map(|tab| (tab.id, tab)))
            .collect();
        let workspaces = layout.template.materialize(&current_tabs)?;
        let preserved_terminal_sessions = workspaces
            .iter()
            .flat_map(|workspace| workspace.tabs.values())
            .filter_map(|tab| tab.content.runtime_session_id().cloned())
            .collect();
        let selected_workspace_id = workspaces[0].id;
        let plan = LayoutApplyPlan {
            workspaces,
            selected_workspace_id,
            preserved_terminal_sessions,
        };
        let mut candidate = self.clone();
        candidate.workspaces.clone_from(&plan.workspaces);
        candidate.selected_workspace_id = plan.selected_workspace_id;
        candidate.workspace_selection = vec![plan.selected_workspace_id];
        candidate.workspace_pins.retain(|id| {
            candidate
                .workspaces
                .iter()
                .any(|workspace| workspace.id == *id)
        });
        candidate.workspace_group_assignments.retain(|id, _| {
            candidate
                .workspaces
                .iter()
                .any(|workspace| workspace.id == *id)
        });
        candidate.legacy_over_limit = None;
        candidate.reconcile_topology();
        candidate.validate()?;
        Ok(plan)
    }

    /// Commits a previously checked layout plan through the ordinary atomic domain transaction.
    ///
    /// # Errors
    /// Returns an error when the plan is invalid or violates resource/reduction bounds.
    pub fn apply_layout_plan(
        &mut self,
        plan: LayoutApplyPlan,
    ) -> Result<MutationOutcome, DomainError> {
        self.transact(|state| {
            state.workspaces = plan.workspaces;
            state.selected_workspace_id = plan.selected_workspace_id;
            state.workspace_selection = vec![plan.selected_workspace_id];
            let ids: BTreeSet<_> = state
                .workspaces
                .iter()
                .map(|workspace| workspace.id)
                .collect();
            state.workspace_pins.retain(|id| ids.contains(id));
            state
                .workspace_group_assignments
                .retain(|id, _| ids.contains(id));
            Ok(())
        })
    }
}

fn mutation_outcome(before: &ApplicationState, after: &ApplicationState) -> MutationOutcome {
    let before_tabs = tab_keys(before);
    let before_tab_states: BTreeMap<_, _> = before
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values().map(|tab| (tab.id, tab)))
        .collect();
    let after_sessions: BTreeSet<_> = after
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| tab.content.runtime_session_id())
        .collect();
    let mut terminal_launches = Vec::new();
    let mut terminal_sessions_to_terminate = Vec::new();

    for workspace in &after.workspaces {
        for tab in workspace.tabs.values() {
            if let TabContent::Terminal {
                launch,
                runtime_session_id: None,
            } = &tab.content
                && (!before_tabs.contains(&(workspace.id, tab.id))
                    || before_tab_states
                        .get(&tab.id)
                        .is_none_or(|before| before.content.runtime_session_id().is_some()))
            {
                terminal_launches.push(TerminalLaunchRequest {
                    workspace_id: workspace.id,
                    pane_id: tab.pane_id,
                    tab_id: tab.id,
                    launch: launch.clone(),
                });
            }
        }
    }
    for session in before
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| tab.content.runtime_session_id())
    {
        if !after_sessions.contains(session) {
            terminal_sessions_to_terminate.push(session.clone());
        }
    }
    MutationOutcome {
        revision: after.revision,
        terminal_launches,
        terminal_sessions_to_terminate,
    }
}

fn tab_keys(state: &ApplicationState) -> BTreeSet<(WorkspaceId, TabId)> {
    state
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .tabs
                .keys()
                .map(move |tab_id| (workspace.id, *tab_id))
        })
        .collect()
}

fn workspace_index(
    state: &ApplicationState,
    workspace_id: WorkspaceId,
) -> Result<usize, DomainError> {
    state
        .workspaces
        .iter()
        .position(|workspace| workspace.id == workspace_id)
        .ok_or(DomainError::WorkspaceNotFound { id: workspace_id })
}

fn replace_placed_workspace(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
    replacement_id: WorkspaceId,
) {
    for placement in &mut state.window_placements {
        for placed_workspace_id in &mut placement.workspace_ids {
            if *placed_workspace_id == workspace_id {
                *placed_workspace_id = replacement_id;
            }
        }
        if placement.focused_workspace_id == workspace_id {
            placement.focused_workspace_id = replacement_id;
        }
    }
}

fn workspace_group_index(
    state: &ApplicationState,
    group_id: GroupId,
) -> Result<usize, DomainError> {
    state
        .workspace_groups
        .iter()
        .position(|group| group.id == group_id)
        .ok_or(DomainError::GroupNotFound { id: group_id })
}

fn workspace_group_mut(
    state: &mut ApplicationState,
    group_id: GroupId,
) -> Result<&mut WorkspaceGroup, DomainError> {
    state
        .workspace_groups
        .iter_mut()
        .find(|group| group.id == group_id)
        .ok_or(DomainError::GroupNotFound { id: group_id })
}

fn saved_layout_index(state: &ApplicationState, layout_id: LayoutId) -> Result<usize, DomainError> {
    state
        .saved_layouts
        .iter()
        .position(|layout| layout.id == layout_id)
        .ok_or(DomainError::LayoutNotFound { id: layout_id })
}

fn normalize_group_orders(groups: &mut [WorkspaceGroup]) {
    for (index, group) in groups.iter_mut().enumerate() {
        group.order = u32::try_from(index).unwrap_or(u32::MAX);
    }
}

fn authorize_path(path: &Path, roots: &[PathBuf]) -> Result<(), DomainError> {
    use std::path::Component;

    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(DomainError::RelativePath {
            field: "layout.path",
        });
    }
    if roots.iter().any(|root| {
        root.is_absolute()
            && !root
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
            && path.starts_with(root)
    }) {
        return Ok(());
    }
    Err(DomainError::UnauthorizedLayoutPath {
        path: path.to_path_buf(),
    })
}

fn notification_mut(
    state: &mut ApplicationState,
    notification_id: NotificationId,
) -> Result<&mut Notification, DomainError> {
    state
        .notifications
        .iter_mut()
        .find(|item| item.id == notification_id)
        .ok_or(DomainError::NotificationNotFound {
            id: notification_id,
        })
}

fn workspace_mut(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
) -> Result<&mut Workspace, DomainError> {
    state
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or(DomainError::WorkspaceNotFound { id: workspace_id })
}

fn require_pane(workspace: &Workspace, pane_id: PaneId) -> Result<(), DomainError> {
    if workspace.panes.contains_key(&pane_id) {
        Ok(())
    } else {
        Err(DomainError::PaneNotFound { id: pane_id })
    }
}

fn require_new_terminal(
    workspace: &Workspace,
    tab: &Tab,
    pane_id: PaneId,
) -> Result<(), DomainError> {
    tab.validate()?;
    if !tab.content.is_terminal() {
        return Err(DomainError::ReplacementMustBeTerminal);
    }
    if tab.content.runtime_session_id().is_some() {
        return Err(DomainError::PreboundTerminalInput { id: tab.id });
    }
    if tab.pane_id != pane_id {
        return Err(DomainError::TabPaneMismatch {
            tab: tab.id,
            expected: pane_id,
            actual: tab.pane_id,
        });
    }
    if workspace.tabs.contains_key(&tab.id) {
        return Err(duplicate("tab", &tab.id));
    }
    Ok(())
}

fn require_new_browser(
    workspace: &Workspace,
    tab: &Tab,
    pane_id: PaneId,
) -> Result<(), DomainError> {
    tab.validate()?;
    if !matches!(tab.content, TabContent::Browser { .. }) {
        return Err(DomainError::InvalidState {
            message: "new browser split does not contain browser content".to_owned(),
        });
    }
    if tab.pane_id != pane_id {
        return Err(DomainError::TabPaneMismatch {
            tab: tab.id,
            expected: pane_id,
            actual: tab.pane_id,
        });
    }
    if workspace.tabs.contains_key(&tab.id) {
        return Err(duplicate("tab", &tab.id));
    }
    Ok(())
}

pub(crate) fn require_unbound_workspace(workspace: &Workspace) -> Result<(), DomainError> {
    if let Some(tab) = workspace
        .tabs
        .values()
        .find(|tab| tab.content.runtime_session_id().is_some())
    {
        return Err(DomainError::PreboundTerminalInput { id: tab.id });
    }
    Ok(())
}

fn remove_tab_reference(
    workspace: &mut Workspace,
    pane_id: PaneId,
    tab_id: TabId,
) -> Result<(), DomainError> {
    let pane = workspace
        .panes
        .get_mut(&pane_id)
        .ok_or(DomainError::PaneNotFound { id: pane_id })?;
    let index = pane
        .tabs
        .iter()
        .position(|id| *id == tab_id)
        .ok_or(DomainError::TabNotFound { id: tab_id })?;
    pane.tabs.remove(index);
    if !pane.tabs.is_empty() && pane.selected_tab_id == tab_id {
        pane.selected_tab_id = pane.tabs[index.min(pane.tabs.len() - 1)];
    }
    Ok(())
}

fn take_tab_for_cross_workspace_move(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
    tab_id: TabId,
    replacement: Option<Tab>,
    updated_at: Timestamp,
) -> Result<Tab, DomainError> {
    let workspace = workspace_mut(state, workspace_id)?;
    let pane_id = workspace
        .tabs
        .get(&tab_id)
        .ok_or(DomainError::TabNotFound { id: tab_id })?
        .pane_id;
    if replacement
        .as_ref()
        .is_some_and(|replacement| replacement.id == tab_id)
    {
        return Err(duplicate("tab", &tab_id));
    }
    let tab = workspace
        .tabs
        .remove(&tab_id)
        .ok_or(DomainError::TabNotFound { id: tab_id })?;
    if workspace.tabs.is_empty() {
        let replacement = replacement.ok_or(DomainError::ReplacementRequired { entity: "tab" })?;
        require_new_terminal(workspace, &replacement, pane_id)?;
        let replacement_id = replacement.id;
        workspace.tabs.insert(replacement_id, replacement);
        let pane = workspace
            .panes
            .get_mut(&pane_id)
            .ok_or(DomainError::PaneNotFound { id: pane_id })?;
        pane.tabs = vec![replacement_id];
        pane.selected_tab_id = replacement_id;
    } else {
        if replacement.is_some() {
            return Err(DomainError::UnexpectedReplacement { entity: "tab" });
        }
        remove_tab_reference(workspace, pane_id, tab_id)?;
        if workspace.panes[&pane_id].tabs.is_empty() {
            workspace.panes.remove(&pane_id);
            collapse_leaf(&mut workspace.layout, pane_id)?;
            if workspace.selected_pane_id == pane_id {
                workspace.selected_pane_id = first_leaf(&workspace.layout);
            }
        }
    }
    workspace.updated_at = updated_at;
    Ok(tab)
}

fn insert_transferred_tab(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
    pane_id: PaneId,
    destination_index: usize,
    mut tab: Tab,
    updated_at: Timestamp,
) -> Result<(), DomainError> {
    let workspace = workspace_mut(state, workspace_id)?;
    require_pane(workspace, pane_id)?;
    let len = workspace.panes[&pane_id].tabs.len();
    if destination_index > len {
        return Err(DomainError::IndexOutOfBounds {
            index: destination_index,
            len,
        });
    }
    if workspace.tabs.contains_key(&tab.id) {
        return Err(duplicate("tab", &tab.id));
    }
    let tab_id = tab.id;
    tab.pane_id = pane_id;
    workspace.tabs.insert(tab_id, tab);
    let pane = workspace.panes.get_mut(&pane_id).expect("pane checked");
    pane.tabs.insert(destination_index, tab_id);
    pane.selected_tab_id = tab_id;
    workspace.selected_pane_id = pane_id;
    workspace.updated_at = updated_at;
    state.selected_workspace_id = workspace_id;
    state.workspace_selection = vec![workspace_id];
    Ok(())
}

fn close_tab_in_state(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
    tab_id: TabId,
    replacement: Option<Tab>,
    updated_at: Timestamp,
) -> Result<(), DomainError> {
    let workspace = workspace_mut(state, workspace_id)?;
    let pane_id = workspace
        .tabs
        .get(&tab_id)
        .ok_or(DomainError::TabNotFound { id: tab_id })?
        .pane_id;
    if replacement
        .as_ref()
        .is_some_and(|replacement| replacement.id == tab_id)
    {
        return Err(duplicate("tab", &tab_id));
    }
    if workspace.tabs.len() == 1 {
        let replacement = replacement.ok_or(DomainError::ReplacementRequired { entity: "tab" })?;
        require_new_terminal(workspace, &replacement, pane_id)?;
        workspace.tabs.remove(&tab_id);
        let replacement_id = replacement.id;
        workspace.tabs.insert(replacement_id, replacement);
        let pane = workspace
            .panes
            .get_mut(&pane_id)
            .ok_or(DomainError::PaneNotFound { id: pane_id })?;
        pane.tabs = vec![replacement_id];
        pane.selected_tab_id = replacement_id;
    } else {
        if replacement.is_some() {
            return Err(DomainError::UnexpectedReplacement { entity: "tab" });
        }
        workspace.tabs.remove(&tab_id);
        remove_tab_reference(workspace, pane_id, tab_id)?;
        if workspace.panes[&pane_id].tabs.is_empty() {
            workspace.panes.remove(&pane_id);
            collapse_leaf(&mut workspace.layout, pane_id)?;
            if workspace.selected_pane_id == pane_id {
                workspace.selected_pane_id = first_leaf(&workspace.layout);
            }
        }
    }
    workspace.updated_at = updated_at;
    Ok(())
}

pub(crate) fn validate_closed_record_for_tab(
    record: &ClosedItemRecord,
    workspace: &Workspace,
    tab: &Tab,
) -> Result<(), DomainError> {
    let expected_title: String = tab
        .custom_title
        .as_deref()
        .unwrap_or(&tab.title)
        .chars()
        .take(crate::CLOSED_ITEM_TITLE_MAX_CHARS)
        .collect();
    if record.title != expected_title {
        return Err(DomainError::InvalidState {
            message: "closed record title does not match the tab".to_owned(),
        });
    }
    match (&tab.content, &record.restore) {
        (
            TabContent::Terminal { launch, .. },
            crate::RestoreDescriptor::Terminal {
                authorized_root_id,
                root_relative_cwd,
                rows,
                cols,
            },
        ) if *authorized_root_id == workspace.id
            && workspace.working_directory.join(root_relative_cwd) == launch.cwd
            && *rows == launch.rows
            && *cols == launch.cols
            && record.content_kind == crate::ClosedContentKind::Terminal =>
        {
            Ok(())
        }
        (TabContent::Browser { metadata }, crate::RestoreDescriptor::Browser { url })
            if crate::RestoreDescriptor::browser(metadata.url())?
                == crate::RestoreDescriptor::Browser { url: url.clone() }
                && record.content_kind == crate::ClosedContentKind::Browser =>
        {
            Ok(())
        }
        _ => Err(DomainError::InvalidState {
            message: "closed restore descriptor does not match the tab".to_owned(),
        }),
    }
}

fn validate_reopened_tab(
    record: &ClosedItemRecord,
    state: &ApplicationState,
    tab: &mut Tab,
) -> Result<(), DomainError> {
    if tab.title != record.title || tab.custom_title.is_some() {
        return Err(DomainError::InvalidState {
            message: "reopened tab title does not match the closed record".to_owned(),
        });
    }
    match (&record.restore, &tab.content) {
        (
            crate::RestoreDescriptor::Terminal {
                authorized_root_id,
                root_relative_cwd,
                rows,
                cols,
            },
            TabContent::Terminal {
                launch,
                runtime_session_id,
            },
        ) if state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == *authorized_root_id)
            .is_some_and(|root| root.working_directory.join(root_relative_cwd) == launch.cwd)
            && *rows == launch.rows
            && *cols == launch.cols
            && runtime_session_id.is_none() =>
        {
            Ok(())
        }
        (crate::RestoreDescriptor::Browser { url }, TabContent::Browser { metadata })
            if metadata.is_fresh_reopen_state(url)
                && !state.workspaces.iter().any(|workspace| {
                    workspace.tabs.values().any(|existing| {
                        matches!(
                            &existing.content,
                            TabContent::Browser {
                                metadata: existing_metadata
                            } if existing_metadata.browser_session_id()
                                == metadata.browser_session_id()
                        )
                    })
                }) =>
        {
            tab.content = TabContent::Browser {
                metadata: crate::BrowserMetadata::new(url)?,
            };
            Ok(())
        }
        _ => Err(DomainError::InvalidState {
            message: "reopened tab does not match the restore descriptor".to_owned(),
        }),
    }
}

fn contains_split(node: &PaneNode, wanted: SplitId) -> bool {
    match node {
        PaneNode::Leaf { .. } => false,
        PaneNode::Split {
            split_id,
            first,
            second,
            ..
        } => *split_id == wanted || contains_split(first, wanted) || contains_split(second, wanted),
    }
}

#[allow(clippy::too_many_arguments)]
fn replace_leaf_with_split(
    node: &mut PaneNode,
    target: PaneId,
    new_pane: PaneId,
    split_id: SplitId,
    axis: Axis,
    ratio: f64,
    placement: SplitPlacement,
) -> Result<(), DomainError> {
    match node {
        PaneNode::Leaf { pane_id } if *pane_id == target => {
            let target_node = Box::new(PaneNode::Leaf { pane_id: target });
            let new_node = Box::new(PaneNode::Leaf { pane_id: new_pane });
            let (first, second) = match placement {
                SplitPlacement::Before => (new_node, target_node),
                SplitPlacement::After => (target_node, new_node),
            };
            *node = PaneNode::Split {
                split_id,
                axis,
                ratio,
                first,
                second,
            };
            Ok(())
        }
        PaneNode::Leaf { .. } => Err(DomainError::PaneNotFound { id: target }),
        PaneNode::Split { first, second, .. } => {
            if replace_leaf_with_split(first, target, new_pane, split_id, axis, ratio, placement)
                .is_ok()
            {
                Ok(())
            } else {
                replace_leaf_with_split(second, target, new_pane, split_id, axis, ratio, placement)
            }
        }
    }
}

fn collapse_leaf(node: &mut PaneNode, target: PaneId) -> Result<(), DomainError> {
    match node {
        PaneNode::Leaf { .. } => Err(DomainError::PaneNotFound { id: target }),
        PaneNode::Split { first, second, .. } => {
            if matches!(&**first, PaneNode::Leaf { pane_id } if *pane_id == target) {
                *node = (**second).clone();
                return Ok(());
            }
            if matches!(&**second, PaneNode::Leaf { pane_id } if *pane_id == target) {
                *node = (**first).clone();
                return Ok(());
            }
            if collapse_leaf(first, target).is_ok() {
                Ok(())
            } else {
                collapse_leaf(second, target)
            }
        }
    }
}

fn first_leaf(node: &PaneNode) -> PaneId {
    match node {
        PaneNode::Leaf { pane_id } => *pane_id,
        PaneNode::Split { first, .. } => first_leaf(first),
    }
}

fn find_split_ratio_mut(node: &mut PaneNode, wanted: SplitId) -> Option<&mut f64> {
    match node {
        PaneNode::Leaf { .. } => None,
        PaneNode::Split {
            split_id,
            ratio,
            first,
            second,
            ..
        } => {
            if *split_id == wanted {
                Some(ratio)
            } else {
                find_split_ratio_mut(first, wanted).or_else(|| find_split_ratio_mut(second, wanted))
            }
        }
    }
}

fn duplicate(entity: &'static str, id: &impl ToString) -> DomainError {
    DomainError::DuplicateId {
        entity,
        id: id.to_string(),
    }
}

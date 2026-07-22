use std::collections::BTreeSet;
use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, BrowserMetadata, ClosedContentKind, ClosedItemId, ClosedItemKind,
    ClosedItemRecord, DomainError, FocusHistory, HostingState, PaneId, RestoreDescriptor,
    RuntimeSessionId, Tab, TabContent, TabId, TerminalLaunchSpec, Timestamp,
    UncheckedApplicationState, WINDOW_PLACEMENT_CAP, WindowId, Workspace, WorkspaceId,
};
use uuid::Uuid;

fn id<T>(value: u128, make: impl FnOnce(Uuid) -> T) -> T {
    make(Uuid::from_u128(value))
}

fn terminal_workspace(workspace: u128, pane: u128, tab: u128, session: Option<&str>) -> Workspace {
    let workspace_id = id(workspace, WorkspaceId::from_uuid);
    let pane_id = id(pane, PaneId::from_uuid);
    let tab_id = id(tab, TabId::from_uuid);
    let tab = Tab::terminal(
        tab_id,
        pane_id,
        format!("tab-{tab}"),
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        session.map(RuntimeSessionId::new),
        Timestamp(1),
    )
    .unwrap();
    Workspace::new(
        workspace_id,
        format!("ws-{workspace}"),
        PathBuf::from("/tmp"),
        pane_id,
        tab,
        Timestamp(1),
        Timestamp(1),
    )
    .unwrap()
}

#[test]
fn schema_v5_is_strict_while_the_v4_boundary_derives_one_owner() {
    let state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    let mut json = serde_json::to_value(state).unwrap();
    json.as_object_mut().unwrap().remove("windowPlacements");
    json.as_object_mut().unwrap().remove("focusedWindowId");
    let unchecked: UncheckedApplicationState = serde_json::from_value(json).unwrap();
    assert!(matches!(
        ApplicationState::try_from(unchecked.clone()),
        Err(DomainError::InvalidState { .. })
    ));
    let migrated = ApplicationState::try_from_schema_v4(unchecked).unwrap();
    assert_eq!(migrated.window_placements.len(), 1);
    assert_eq!(
        migrated.window_placements[0].workspace_ids,
        vec![migrated.selected_workspace_id]
    );
}

#[test]
fn ownership_window_revisions_and_window_cap_are_atomic() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    for value in 2..=u128::try_from(WINDOW_PLACEMENT_CAP).unwrap() {
        state
            .create_workspace(terminal_workspace(value, value * 10, value * 100, None))
            .unwrap();
        state
            .create_window_placement(
                id(1_000 + value, WindowId::from_uuid),
                format!("window-{value}"),
                id(value, WorkspaceId::from_uuid),
            )
            .unwrap();
    }
    assert_eq!(state.window_placements.len(), WINDOW_PLACEMENT_CAP);
    let before = state.clone();
    assert!(matches!(
        state.create_window_placement(WindowId::new(), "overflow", state.selected_workspace_id),
        Err(DomainError::ResourceLimit { .. })
    ));
    assert_eq!(state, before);
    let target = state.window_placements[0].id;
    let source_workspace = state.window_placements[1].workspace_ids[0];
    let target_revision = state.window_placements[0].revision;
    state
        .move_workspace_to_window(source_workspace, target, 1)
        .unwrap();
    assert_eq!(state.window_placements[0].revision, target_revision + 1);
    state.validate().unwrap();
}

#[test]
fn targeted_workspace_create_owns_and_focuses_the_exact_window_in_one_revision() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    let target = state.window_placements[0].id;
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    let other = id(1_002, WindowId::from_uuid);
    state
        .create_window_placement(other, "other", id(2, WorkspaceId::from_uuid))
        .unwrap();
    assert_eq!(state.focused_window_id, other);

    let revision = state.revision;
    let outcome = state
        .create_workspace_in_window(terminal_workspace(3, 30, 300, None), target)
        .unwrap();

    assert_eq!(outcome.revision, revision + 1);
    assert_eq!(state.revision, revision + 1);
    assert_eq!(state.focused_window_id, target);
    assert_eq!(state.selected_workspace_id, id(3, WorkspaceId::from_uuid));
    assert_eq!(
        state.window_placement(target).unwrap().workspace_ids,
        vec![id(1, WorkspaceId::from_uuid), id(3, WorkspaceId::from_uuid)]
    );
    assert_eq!(
        state.window_placement(target).unwrap().focused_workspace_id,
        id(3, WorkspaceId::from_uuid)
    );
    assert_eq!(
        state.window_placement(other).unwrap().workspace_ids,
        vec![id(2, WorkspaceId::from_uuid)]
    );
    assert_eq!(
        state
            .window_placements
            .iter()
            .flat_map(|placement| placement.workspace_ids.iter())
            .filter(|workspace_id| **workspace_id == id(3, WorkspaceId::from_uuid))
            .count(),
        1
    );
    state.validate().unwrap();
}

#[test]
fn targeted_workspace_create_errors_are_atomic() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    let target = state.window_placements[0].id;

    let before = state.clone();
    assert!(matches!(
        state.create_workspace_in_window(terminal_workspace(1, 20, 200, None), target),
        Err(DomainError::DuplicateId {
            entity: "workspace",
            ..
        })
    ));
    assert_eq!(state, before);

    let before = state.clone();
    assert!(matches!(
        state.create_workspace_in_window(terminal_workspace(2, 10, 200, None), target),
        Err(DomainError::DuplicateId { entity: "pane", .. })
    ));
    assert_eq!(state, before);

    let before = state.clone();
    assert!(matches!(
        state.create_workspace_in_window(
            terminal_workspace(2, 20, 200, None),
            id(9_999, WindowId::from_uuid),
        ),
        Err(DomainError::WindowNotFound { .. })
    ));
    assert_eq!(state, before);

    state
        .set_window_hosting_state(target, HostingState::Closing)
        .unwrap();
    let before = state.clone();
    assert!(matches!(
        state.create_workspace_in_window(terminal_workspace(2, 20, 200, None), target),
        Err(DomainError::InvalidOperation { .. })
    ));
    assert_eq!(state, before);
}

#[test]
fn targeted_workspace_create_has_the_ordinary_create_lifecycle_delta() {
    let state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    let target = state.window_placements[0].id;
    let mut ordinary = state.clone();
    let mut targeted = state;

    let ordinary_outcome = ordinary
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    let targeted_outcome = targeted
        .create_workspace_in_window(terminal_workspace(2, 20, 200, None), target)
        .unwrap();

    assert_eq!(targeted_outcome, ordinary_outcome);
    assert_eq!(targeted, ordinary);
}

#[test]
fn provider_claims_reconcile_hosting_once_and_reject_unknown_or_closing_windows() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    let first = state.window_placements[0].id;
    let second = id(1_002, WindowId::from_uuid);
    state
        .create_window_placement(second, "second", id(2, WorkspaceId::from_uuid))
        .unwrap();

    let before_revision = state.revision;
    state
        .reconcile_window_hosting(&[first].into_iter().collect())
        .unwrap();
    assert_eq!(state.revision, before_revision + 1);
    assert_eq!(
        state.window_placement(first).unwrap().hosting_state,
        agent_workspace_core::HostingState::Hosted
    );
    assert_eq!(
        state.window_placement(second).unwrap().hosting_state,
        agent_workspace_core::HostingState::Unhosted
    );

    let reconciliation = state
        .reconcile_window_claims(&[second].into_iter().collect())
        .unwrap();
    assert_eq!(reconciliation.outcome.revision, before_revision + 2);
    assert_eq!(
        reconciliation.rehomes,
        vec![agent_workspace_core::WindowRehome {
            source_window_id: first,
            target_window_id: second,
        }]
    );
    assert!(state.window_placement(first).is_none());
    assert_eq!(
        state.window_placement(second).unwrap().hosting_state,
        agent_workspace_core::HostingState::Hosted
    );

    let before = state.clone();
    assert!(matches!(
        state.reconcile_window_hosting(&[WindowId::new()].into_iter().collect()),
        Err(DomainError::WindowNotFound { .. })
    ));
    assert_eq!(state, before);

    state
        .set_window_hosting_state(second, agent_workspace_core::HostingState::Closing)
        .unwrap();
    let before = state.clone();
    assert!(
        state
            .reconcile_window_hosting(&[second].into_iter().collect())
            .is_err()
    );
    assert_eq!(state, before);
}

#[test]
fn claim_reconcile_rehomes_to_lowest_survivor_or_unhosts_when_none_survive() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    let source = state.window_placements[0].id;
    let higher = id(2_000, WindowId::from_uuid);
    let lower = id(1_000, WindowId::from_uuid);
    state
        .create_window_placement(higher, "higher", id(2, WorkspaceId::from_uuid))
        .unwrap();
    state
        .create_workspace(terminal_workspace(3, 30, 300, None))
        .unwrap();
    state
        .create_window_placement(lower, "lower", id(3, WorkspaceId::from_uuid))
        .unwrap();
    state
        .set_window_hosting_state(source, agent_workspace_core::HostingState::Hosted)
        .unwrap();
    let revision = state.revision;
    let result = state
        .reconcile_window_claims(&[higher, lower].into_iter().collect())
        .unwrap();
    assert_eq!(result.outcome.revision, revision + 1);
    assert_eq!(
        result.rehomes,
        vec![agent_workspace_core::WindowRehome {
            source_window_id: source,
            target_window_id: lower,
        }]
    );
    assert!(state.window_placement(source).is_none());
    assert_eq!(
        state.window_placement(lower).unwrap().workspace_ids.len(),
        2
    );

    let revision = state.revision;
    let no_survivor = state.reconcile_window_claims(&BTreeSet::new()).unwrap();
    assert_eq!(no_survivor.outcome.revision, revision + 1);
    assert!(no_survivor.rehomes.is_empty());
    assert!(
        state.window_placements.iter().all(
            |placement| placement.hosting_state == agent_workspace_core::HostingState::Unhosted
        )
    );
}

#[test]
fn close_window_rehomes_only_to_a_hosted_eligible_target() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    let source = state.window_placements[0].id;
    let target = id(1_002, WindowId::from_uuid);
    state
        .create_window_placement(target, "target", id(2, WorkspaceId::from_uuid))
        .unwrap();

    let before = state.clone();
    assert!(state.close_window_placement(source, Some(target)).is_err());
    assert_eq!(state, before);

    state
        .set_window_hosting_state(target, agent_workspace_core::HostingState::Closing)
        .unwrap();
    let before = state.clone();
    assert!(state.close_window_placement(source, Some(target)).is_err());
    assert_eq!(state, before);

    state
        .set_window_hosting_state(target, agent_workspace_core::HostingState::Hosted)
        .unwrap();
    state.close_window_placement(source, Some(target)).unwrap();
    assert!(state.window_placement(source).is_none());
    assert_eq!(state.window_placements[0].workspace_ids.len(), 2);
}

#[test]
fn exact_move_preserves_runtime_and_duplicate_uses_fresh_identity() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, Some("live"))).unwrap();
    let extra = Tab::terminal(
        id(101, TabId::from_uuid),
        id(10, PaneId::from_uuid),
        "extra",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(1),
    )
    .unwrap();
    state
        .open_terminal_tab(
            id(1, WorkspaceId::from_uuid),
            id(10, PaneId::from_uuid),
            1,
            extra,
            Timestamp(2),
        )
        .unwrap();
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    let moved = state
        .move_tab_to_workspace(
            id(1, WorkspaceId::from_uuid),
            id(100, TabId::from_uuid),
            id(2, WorkspaceId::from_uuid),
            id(20, PaneId::from_uuid),
            1,
            None,
            Timestamp(3),
        )
        .unwrap();
    assert!(moved.terminal_launches.is_empty());
    assert!(moved.terminal_sessions_to_terminate.is_empty());
    assert_eq!(
        state.workspaces[1].tabs[&id(100, TabId::from_uuid)]
            .content
            .runtime_session_id()
            .unwrap()
            .as_str(),
        "live"
    );
    let duplicated = state
        .duplicate_tab(
            id(2, WorkspaceId::from_uuid),
            id(100, TabId::from_uuid),
            id(2, WorkspaceId::from_uuid),
            id(20, PaneId::from_uuid),
            2,
            id(201, TabId::from_uuid),
            Timestamp(4),
            Timestamp(4),
        )
        .unwrap();
    assert_eq!(duplicated.terminal_launches.len(), 1);
    assert!(
        state.workspaces[1].tabs[&id(201, TabId::from_uuid)]
            .content
            .runtime_session_id()
            .is_none()
    );
}

#[test]
fn focus_back_forward_and_branching_preserve_the_forward_stack() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    state
        .create_workspace(terminal_workspace(3, 30, 300, None))
        .unwrap();
    state.focus_history = FocusHistory::default();
    state
        .select_workspace(id(1, WorkspaceId::from_uuid))
        .unwrap();
    state
        .select_workspace(id(2, WorkspaceId::from_uuid))
        .unwrap();
    state
        .select_workspace(id(3, WorkspaceId::from_uuid))
        .unwrap();
    state.focus_back().unwrap();
    assert_eq!(state.selected_workspace_id, id(2, WorkspaceId::from_uuid));
    state.focus_back().unwrap();
    assert_eq!(state.selected_workspace_id, id(1, WorkspaceId::from_uuid));
    state.focus_forward().unwrap();
    assert_eq!(state.selected_workspace_id, id(2, WorkspaceId::from_uuid));
    state
        .select_workspace(id(3, WorkspaceId::from_uuid))
        .unwrap();
    let revision = state.revision;
    state.focus_forward().unwrap();
    assert_eq!(state.revision, revision);
}

#[test]
fn topology_reconcile_preserves_focus_cursor_target_when_earlier_entries_are_removed() {
    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, None)).unwrap();
    state
        .create_workspace(terminal_workspace(2, 20, 200, None))
        .unwrap();
    state
        .create_workspace(terminal_workspace(3, 30, 300, None))
        .unwrap();
    let window_id = state.focused_window_id;
    let target = |workspace, pane, tab| agent_workspace_core::FocusTarget {
        window_id,
        workspace_id: id(workspace, WorkspaceId::from_uuid),
        pane_id: id(pane, PaneId::from_uuid),
        tab_id: id(tab, TabId::from_uuid),
    };
    let second = target(2, 20, 200);
    let third = target(3, 30, 300);
    state.focus_history = FocusHistory {
        entries: vec![
            agent_workspace_core::FocusTarget {
                window_id: WindowId::new(),
                ..second
            },
            second,
            third,
        ],
        cursor: 2,
    };

    state
        .set_window_hosting_state(window_id, agent_workspace_core::HostingState::Hosted)
        .unwrap();
    assert_eq!(state.focus_history.entries, vec![second, third]);
    assert_eq!(state.focus_history.cursor, 1);
    state.focus_back().unwrap();
    assert_eq!(state.selected_workspace_id, id(2, WorkspaceId::from_uuid));
}

#[test]
fn closed_record_authenticity_and_browser_redaction_are_strict() {
    let descriptor =
        RestoreDescriptor::browser("https://example.com/path?secret=x#fragment").unwrap();
    assert_eq!(
        descriptor,
        RestoreDescriptor::Browser {
            url: "https://example.com/path".to_owned()
        }
    );
    let hostile = serde_json::json!({"kind":"browser","url":"https://example.com/path?secret=x"});
    let hostile: RestoreDescriptor = serde_json::from_value(hostile).unwrap();
    let record = ClosedItemRecord::new(
        id(9, ClosedItemId::from_uuid),
        ClosedItemKind::Tab,
        id(1, WorkspaceId::from_uuid),
        Some(id(100, TabId::from_uuid)),
        ClosedContentKind::Browser,
        "browser",
        Timestamp(2),
        hostile,
    );
    assert!(record.is_err());

    let mut state = ApplicationState::new(terminal_workspace(1, 10, 100, Some("live"))).unwrap();
    let replacement = Tab::terminal(
        id(101, TabId::from_uuid),
        id(10, PaneId::from_uuid),
        "replacement",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(2),
    )
    .unwrap();
    let lying = ClosedItemRecord::new(
        id(10, ClosedItemId::from_uuid),
        ClosedItemKind::Tab,
        id(1, WorkspaceId::from_uuid),
        Some(id(100, TabId::from_uuid)),
        ClosedContentKind::Terminal,
        "wrong",
        Timestamp(2),
        RestoreDescriptor::terminal(id(1, WorkspaceId::from_uuid), PathBuf::new(), 24, 80).unwrap(),
    )
    .unwrap();
    let before = state.clone();
    assert!(
        state
            .close_tab_with_record(
                id(1, WorkspaceId::from_uuid),
                id(100, TabId::from_uuid),
                Some(replacement),
                lying,
                Timestamp(2),
                Timestamp(2)
            )
            .is_err()
    );
    assert_eq!(state, before);
}

#[test]
fn browser_duplicate_gets_a_fresh_logical_session() {
    let pane = id(10, PaneId::from_uuid);
    let browser = Tab::browser(
        id(100, TabId::from_uuid),
        pane,
        "browser",
        BrowserMetadata::new("https://example.com/").unwrap(),
        Timestamp(1),
    )
    .unwrap();
    let original = match &browser.content {
        TabContent::Browser { metadata } => metadata.browser_session_id(),
        TabContent::Terminal { .. } => unreachable!(),
    };
    let workspace = Workspace::new(
        id(1, WorkspaceId::from_uuid),
        "browser",
        PathBuf::from("/tmp"),
        pane,
        browser,
        Timestamp(1),
        Timestamp(1),
    )
    .unwrap();
    let mut state = ApplicationState::new(workspace).unwrap();
    state
        .duplicate_tab(
            id(1, WorkspaceId::from_uuid),
            id(100, TabId::from_uuid),
            id(1, WorkspaceId::from_uuid),
            pane,
            1,
            id(101, TabId::from_uuid),
            Timestamp(2),
            Timestamp(2),
        )
        .unwrap();
    let duplicate = match &state.workspaces[0].tabs[&id(101, TabId::from_uuid)].content {
        TabContent::Browser { metadata } => metadata.browser_session_id(),
        TabContent::Terminal { .. } => unreachable!(),
    };
    assert_ne!(original, duplicate);
}

#[test]
#[allow(clippy::too_many_lines)]
fn browser_reopen_rejects_cloned_runtime_state_and_accepts_a_fresh_session() {
    let pane = id(10, PaneId::from_uuid);
    let original_metadata: BrowserMetadata = serde_json::from_value(serde_json::json!({
        "browserSessionId": Uuid::from_u128(500),
        "url": "https://example.com/path",
        "navigationTitle": "Old renderer title",
        "canBack": true,
        "canForward": true,
        "loading": true,
        "devToolsOpen": true,
        "profilePartition": "persist:old-runtime-profile",
        "stateRevision": 7,
        "correlationId": "old-navigation"
    }))
    .unwrap();
    let original_session_id = original_metadata.browser_session_id();
    let browser = Tab::browser(
        id(100, TabId::from_uuid),
        pane,
        "browser",
        original_metadata.clone(),
        Timestamp(1),
    )
    .unwrap();
    let workspace = Workspace::new(
        id(1, WorkspaceId::from_uuid),
        "browser",
        PathBuf::from("/tmp"),
        pane,
        browser,
        Timestamp(1),
        Timestamp(1),
    )
    .unwrap();
    let mut state = ApplicationState::new(workspace).unwrap();
    let record = ClosedItemRecord::new(
        id(9, ClosedItemId::from_uuid),
        ClosedItemKind::Tab,
        id(1, WorkspaceId::from_uuid),
        Some(id(100, TabId::from_uuid)),
        ClosedContentKind::Browser,
        "browser",
        Timestamp(2),
        RestoreDescriptor::browser("https://example.com/path").unwrap(),
    )
    .unwrap();
    state
        .close_tab_with_record(
            id(1, WorkspaceId::from_uuid),
            id(100, TabId::from_uuid),
            Some(
                Tab::terminal(
                    id(101, TabId::from_uuid),
                    pane,
                    "replacement",
                    TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
                    None,
                    Timestamp(2),
                )
                .unwrap(),
            ),
            record,
            Timestamp(2),
            Timestamp(2),
        )
        .unwrap();

    let cloned = Tab::browser(
        id(102, TabId::from_uuid),
        pane,
        "browser",
        original_metadata,
        Timestamp(3),
    )
    .unwrap();
    let before = state.clone();
    assert!(
        state
            .reopen_closed_tab(
                id(9, ClosedItemId::from_uuid),
                id(1, WorkspaceId::from_uuid),
                pane,
                1,
                cloned,
                Timestamp(3),
            )
            .is_err()
    );
    assert_eq!(state, before);

    let fresh = Tab::browser(
        id(102, TabId::from_uuid),
        pane,
        "browser",
        BrowserMetadata::new("https://example.com/path").unwrap(),
        Timestamp(3),
    )
    .unwrap();
    let fresh_session_id = match &fresh.content {
        TabContent::Browser { metadata } => metadata.browser_session_id(),
        TabContent::Terminal { .. } => unreachable!(),
    };
    assert_ne!(fresh_session_id, original_session_id);
    state
        .reopen_closed_tab(
            id(9, ClosedItemId::from_uuid),
            id(1, WorkspaceId::from_uuid),
            pane,
            1,
            fresh,
            Timestamp(3),
        )
        .unwrap();
    assert!(state.recently_closed.is_empty());
    let reopened_session_id = match &state.workspaces[0].tabs[&id(102, TabId::from_uuid)].content {
        TabContent::Browser { metadata } => metadata.browser_session_id(),
        TabContent::Terminal { .. } => unreachable!(),
    };
    assert_ne!(reopened_session_id, original_session_id);
    assert_ne!(reopened_session_id, fresh_session_id);
}

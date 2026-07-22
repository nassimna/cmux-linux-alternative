#![allow(deprecated)]

use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, Axis, BrowserAction, BrowserMetadata, CommandId, DEFAULT_SHORTCUT_CATALOG,
    DomainError, LogicalShortcut, MAX_SAFE_INTEGER, PaneId, PaneNode, RuntimeSessionId,
    ShortcutPlatform, SplitContent, SplitId, SplitPlacement, Tab, TabContent, TabId,
    TerminalLaunchSpec, Timestamp, UncheckedApplicationState, Workspace, WorkspaceId,
    WorkspaceUpdate,
};
use uuid::Uuid;

fn boundary_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../protocol/fixtures/boundary-parity.json"))
        .expect("boundary fixture must be JSON")
}

fn workspace_id(value: u128) -> WorkspaceId {
    WorkspaceId::from_uuid(Uuid::from_u128(value))
}

fn pane_id(value: u128) -> PaneId {
    PaneId::from_uuid(Uuid::from_u128(value))
}

fn split_id(value: u128) -> SplitId {
    SplitId::from_uuid(Uuid::from_u128(value))
}

fn tab_id(value: u128) -> TabId {
    TabId::from_uuid(Uuid::from_u128(value))
}

fn launch() -> TerminalLaunchSpec {
    TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap()
}

fn terminal_tab(id: u128, pane: PaneId, session: Option<&str>) -> Tab {
    Tab::terminal(
        tab_id(id),
        pane,
        format!("tab-{id}"),
        launch(),
        session.map(RuntimeSessionId::new),
        Timestamp(u64::try_from(id).unwrap()),
    )
    .unwrap()
}

fn workspace(id: u128, pane: u128, tab: u128) -> Workspace {
    let pane = pane_id(pane);
    Workspace::new(
        workspace_id(id),
        format!(" workspace-{id} "),
        PathBuf::from("/tmp"),
        pane,
        terminal_tab(tab, pane, Some(&format!("session-{tab}"))),
        Timestamp(1),
        Timestamp(1),
    )
    .unwrap()
}

fn initial_state() -> ApplicationState {
    ApplicationState::new(workspace(1, 10, 100)).unwrap()
}

fn unbound_workspace(id: u128, pane: u128, tab: u128) -> Workspace {
    let mut workspace = workspace(id, pane, tab);
    workspace
        .tabs
        .get_mut(&tab_id(tab))
        .unwrap()
        .content
        .set_runtime_session_id(None);
    workspace
}

#[test]
fn constructors_trim_and_validate_names_paths_and_bounds() {
    let state = initial_state();
    assert_eq!(state.workspaces[0].name, "workspace-1");
    assert!(matches!(
        Workspace::new(
            workspace_id(2),
            "   ",
            PathBuf::from("/tmp"),
            pane_id(20),
            terminal_tab(200, pane_id(20), None),
            Timestamp(1),
            Timestamp(1),
        ),
        Err(DomainError::EmptyText {
            field: "workspace.name"
        })
    ));
    assert!(matches!(
        Workspace::new(
            workspace_id(2),
            "ok",
            PathBuf::from("relative"),
            pane_id(20),
            terminal_tab(200, pane_id(20), None),
            Timestamp(1),
            Timestamp(1),
        ),
        Err(DomainError::RelativePath { .. })
    ));
    assert!(matches!(
        Workspace::new(
            workspace_id(2),
            "x".repeat(129),
            PathBuf::from("/tmp"),
            pane_id(20),
            terminal_tab(200, pane_id(20), None),
            Timestamp(1),
            Timestamp(1),
        ),
        Err(DomainError::TextTooLong { max: 128, .. })
    ));
    assert!(TerminalLaunchSpec::new(PathBuf::from("x"), None, 24, 80).is_err());
    assert!(TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 0, 80).is_err());
    assert!(TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 1_001, 80).is_err());
    assert!(matches!(
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), Some(vec![]), 24, 80),
        Err(DomainError::PersistentTerminalCommandUnsupported)
    ));
    assert!(matches!(
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), Some(vec!["  ".into()]), 24, 80),
        Err(DomainError::PersistentTerminalCommandUnsupported)
    ));
    let command = vec![" bash ".into(), String::new()];
    assert!(matches!(
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), Some(command), 1_000, 1),
        Err(DomainError::PersistentTerminalCommandUnsupported)
    ));
}

#[test]
fn constructors_match_the_shared_ecmascript_trim_boundary() {
    let unicode = &boundary_fixture()["unicode"];
    for character in unicode["ecmaScriptTrimWhitespace"]
        .as_array()
        .expect("trim whitespace fixture")
    {
        let character = character.as_str().expect("trim scalar");
        let workspace = Workspace::new(
            workspace_id(2),
            format!("{character}workspace{character}"),
            PathBuf::from("/tmp"),
            pane_id(20),
            terminal_tab(200, pane_id(20), None),
            Timestamp(1),
            Timestamp(1),
        )
        .expect("ECMAScript edge whitespace is normalized");
        assert_eq!(workspace.name, "workspace");
    }

    for character in unicode["nonTrimWhitespace"]
        .as_array()
        .expect("non-trim whitespace fixture")
    {
        let character = character.as_str().expect("non-trim scalar");
        let expected = format!("{character}workspace{character}");
        let workspace = Workspace::new(
            workspace_id(2),
            expected.clone(),
            PathBuf::from("/tmp"),
            pane_id(20),
            terminal_tab(200, pane_id(20), None),
            Timestamp(1),
            Timestamp(1),
        )
        .expect("non-trim scalar remains part of the name");
        assert_eq!(workspace.name, expected);
    }
}

#[test]
fn workspace_crud_order_selection_and_final_replacement_are_deterministic() {
    let mut state = initial_state();
    let created = state
        .create_workspace(unbound_workspace(2, 20, 200))
        .unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(state.selected_workspace_id, workspace_id(2));

    state
        .update_workspace(
            workspace_id(2),
            WorkspaceUpdate {
                name: Some(" renamed ".into()),
                description: Some(Some(" notes ".into())),
                color: Some(Some(" blue ".into())),
                working_directory: Some(PathBuf::from("/var")),
            },
            Timestamp(9),
        )
        .unwrap();
    let changed = &state.workspaces[1];
    assert_eq!(changed.name, "renamed");
    assert_eq!(changed.description.as_deref(), Some("notes"));
    assert_eq!(changed.updated_at, Timestamp(9));

    state.move_workspace(workspace_id(2), 0).unwrap();
    assert_eq!(state.workspaces[0].id, workspace_id(2));
    state.close_workspace(workspace_id(2), None).unwrap();
    assert_eq!(state.selected_workspace_id, workspace_id(1));

    let before = state.clone();
    assert!(matches!(
        state.close_workspace(workspace_id(1), None),
        Err(DomainError::ReplacementRequired {
            entity: "workspace"
        })
    ));
    assert_eq!(state, before);
    let placement_id = state.window_placements[0].id;
    state
        .close_workspace(workspace_id(1), Some(unbound_workspace(3, 30, 300)))
        .unwrap();
    assert_eq!(state.workspaces[0].id, workspace_id(3));
    assert_eq!(state.selected_workspace_id, workspace_id(3));
    assert_eq!(state.window_placements[0].id, placement_id);
    assert_eq!(state.window_placements[0].workspace_ids, [workspace_id(3)]);
    assert_eq!(
        state.window_placements[0].focused_workspace_id,
        workspace_id(3)
    );

    state
        .close_selected_workspaces(Some(unbound_workspace(4, 40, 400)))
        .unwrap();
    assert_eq!(state.workspaces[0].id, workspace_id(4));
    assert_eq!(state.window_placements[0].id, placement_id);
    assert_eq!(state.window_placements[0].workspace_ids, [workspace_id(4)]);
    assert_eq!(
        state.window_placements[0].focused_workspace_id,
        workspace_id(4)
    );
}

#[test]
fn every_failure_is_atomic_and_success_increments_once() {
    let mut state = initial_state();
    let before = state.clone();
    let result = state.move_workspace(workspace_id(99), 0);
    assert!(matches!(result, Err(DomainError::WorkspaceNotFound { .. })));
    assert_eq!(state, before);

    state
        .create_workspace(unbound_workspace(2, 20, 200))
        .unwrap();
    let revision = state.revision;
    let outcome = state.select_workspace(workspace_id(1)).unwrap();
    assert_eq!(outcome.revision, revision + 1);
    assert_eq!(state.revision, revision + 1);
}

#[test]
fn split_clamps_ratio_and_resize_rejects_non_finite_atomically() {
    let mut state = initial_state();
    let new_pane = pane_id(20);
    let new_tab = terminal_tab(200, new_pane, None);
    let outcome = state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            new_pane,
            split_id(1_000),
            Axis::Horizontal,
            -5.0,
            SplitPlacement::Before,
            SplitContent::NewTerminal(new_tab),
            Timestamp(2),
        )
        .unwrap();
    assert_eq!(outcome.terminal_launches.len(), 1);
    assert_eq!(outcome.terminal_launches[0].tab_id, tab_id(200));
    assert!(matches!(
        &state.workspaces[0].layout,
        PaneNode::Split { ratio, first, .. }
            if (*ratio - 0.05).abs() < f64::EPSILON
                && matches!(&**first, PaneNode::Leaf { pane_id: id } if *id == new_pane)
    ));

    state
        .resize_pane_split(workspace_id(1), split_id(1_000), 5.0, Timestamp(3))
        .unwrap();
    assert!(matches!(
        &state.workspaces[0].layout,
        PaneNode::Split { ratio, .. } if (*ratio - 0.95).abs() < f64::EPSILON
    ));
    let before = state.clone();
    assert!(matches!(
        state.resize_pane_split(workspace_id(1), split_id(1_000), f64::NAN, Timestamp(4)),
        Err(DomainError::NonFiniteRatio)
    ));
    assert_eq!(state, before);
}

#[test]
fn move_tab_preserves_session_and_last_source_pane_collapses() {
    let mut state = initial_state();
    let second_pane = pane_id(20);
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            second_pane,
            split_id(1_000),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, second_pane, None)),
            Timestamp(2),
        )
        .unwrap();
    let outcome = state
        .move_tab(workspace_id(1), tab_id(100), second_pane, 1, Timestamp(3))
        .unwrap();
    assert!(outcome.terminal_launches.is_empty());
    assert!(outcome.terminal_sessions_to_terminate.is_empty());
    let workspace = &state.workspaces[0];
    assert_eq!(workspace.panes.len(), 1);
    assert!(matches!(workspace.layout, PaneNode::Leaf { pane_id } if pane_id == second_pane));
    assert_eq!(
        workspace.panes[&second_pane].tabs,
        [tab_id(200), tab_id(100)]
    );
    assert_eq!(
        workspace.tabs[&tab_id(100)]
            .content
            .runtime_session_id()
            .map(RuntimeSessionId::as_str),
        Some("session-100")
    );
}

#[test]
fn same_pane_reorder_normalizes_boundaries_and_rejects_self_moves() {
    let mut state = initial_state();
    state
        .open_terminal_tab(
            workspace_id(1),
            pane_id(10),
            1,
            terminal_tab(101, pane_id(10), None),
            Timestamp(2),
        )
        .unwrap();
    state
        .open_terminal_tab(
            workspace_id(1),
            pane_id(10),
            2,
            terminal_tab(102, pane_id(10), None),
            Timestamp(3),
        )
        .unwrap();
    state
        .move_tab(workspace_id(1), tab_id(100), pane_id(10), 3, Timestamp(4))
        .unwrap();
    assert_eq!(
        state.workspaces[0].panes[&pane_id(10)].tabs,
        [tab_id(101), tab_id(102), tab_id(100)]
    );
    let before = state.clone();
    assert!(matches!(
        state.move_tab(workspace_id(1), tab_id(102), pane_id(10), 1, Timestamp(5)),
        Err(DomainError::InvalidOperation { .. })
    ));
    assert_eq!(state, before);
}

#[test]
fn close_tab_selects_next_then_previous_and_final_requires_terminal() {
    let mut state = initial_state();
    state
        .open_terminal_tab(
            workspace_id(1),
            pane_id(10),
            1,
            terminal_tab(101, pane_id(10), None),
            Timestamp(2),
        )
        .unwrap();
    state
        .select_tab(workspace_id(1), tab_id(100), Timestamp(3))
        .unwrap();
    let outcome = state
        .close_tab(workspace_id(1), tab_id(100), None, Timestamp(4))
        .unwrap();
    assert_eq!(
        outcome.terminal_sessions_to_terminate,
        [RuntimeSessionId::new("session-100")]
    );
    assert_eq!(
        state.workspaces[0].panes[&pane_id(10)].selected_tab_id,
        tab_id(101)
    );

    let before = state.clone();
    assert!(
        state
            .close_tab(workspace_id(1), tab_id(101), None, Timestamp(5))
            .is_err()
    );
    assert_eq!(state, before);
    let browser = Tab::browser(
        tab_id(102),
        pane_id(10),
        "web",
        BrowserMetadata::new("https://example.test").unwrap(),
        Timestamp(5),
    )
    .unwrap();
    assert!(matches!(
        state.close_tab(workspace_id(1), tab_id(101), Some(browser), Timestamp(5)),
        Err(DomainError::ReplacementMustBeTerminal)
    ));
    let outcome = state
        .close_tab(
            workspace_id(1),
            tab_id(101),
            Some(terminal_tab(103, pane_id(10), None)),
            Timestamp(6),
        )
        .unwrap();
    assert_eq!(outcome.terminal_launches[0].tab_id, tab_id(103));
}

#[test]
fn close_nonfinal_pane_collapses_parent_and_focuses_first_leaf() {
    let mut state = initial_state();
    let second = pane_id(20);
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            second,
            split_id(1_000),
            Axis::Vertical,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, second, None)),
            Timestamp(2),
        )
        .unwrap();
    state
        .close_pane(workspace_id(1), second, None, Timestamp(3))
        .unwrap();
    let workspace = &state.workspaces[0];
    assert_eq!(workspace.selected_pane_id, pane_id(10));
    assert!(matches!(workspace.layout, PaneNode::Leaf { pane_id: id } if id == pane_id(10)));
}

#[test]
fn split_can_move_existing_tab_and_collapse_its_last_tab_source() {
    let mut state = initial_state();
    let source = pane_id(20);
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            source,
            split_id(1_000),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, source, None)),
            Timestamp(2),
        )
        .unwrap();
    state
        .bind_terminal_runtime_session(
            workspace_id(1),
            tab_id(200),
            RuntimeSessionId::new("live-200"),
            Timestamp(2),
        )
        .unwrap();
    let new_pane = pane_id(30);
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            new_pane,
            split_id(1_001),
            Axis::Vertical,
            0.5,
            SplitPlacement::Before,
            SplitContent::ExistingTab(tab_id(200)),
            Timestamp(3),
        )
        .unwrap();
    let workspace = &state.workspaces[0];
    assert!(!workspace.panes.contains_key(&source));
    assert_eq!(workspace.tabs[&tab_id(200)].pane_id, new_pane);
    assert_eq!(
        workspace.tabs[&tab_id(200)]
            .content
            .runtime_session_id()
            .map(RuntimeSessionId::as_str),
        Some("live-200")
    );
    workspace.validate().unwrap();
}

#[test]
fn closing_final_pane_requires_and_launches_one_replacement_terminal() {
    let mut state = initial_state();
    let before = state.clone();
    assert!(matches!(
        state.close_pane(workspace_id(1), pane_id(10), None, Timestamp(2)),
        Err(DomainError::ReplacementRequired { entity: "pane" })
    ));
    assert_eq!(state, before);
    let outcome = state
        .close_pane(
            workspace_id(1),
            pane_id(10),
            Some(terminal_tab(101, pane_id(10), None)),
            Timestamp(2),
        )
        .unwrap();
    assert_eq!(outcome.terminal_launches[0].tab_id, tab_id(101));
    assert_eq!(
        outcome.terminal_sessions_to_terminate,
        [RuntimeSessionId::new("session-100")]
    );
}

#[test]
fn shortcut_clear_is_distinct_from_reset_and_conflicts_are_atomic() {
    let mut state = initial_state();
    let first = CommandId::new("pane.split").unwrap();
    let second = CommandId::new("tab.close").unwrap();
    let shortcut = LogicalShortcut::new(" Ctrl+K ").unwrap();
    state
        .set_shortcut_override(
            first.clone(),
            Some(shortcut.clone()),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
    state
        .set_shortcut_override(second.clone(), None, ShortcutPlatform::NonMacOs)
        .unwrap();
    assert_eq!(state.shortcut_overrides.get(&second), Some(&None));
    let before = state.clone();
    assert!(matches!(
        state.set_shortcut_override(second.clone(), Some(shortcut), ShortcutPlatform::NonMacOs),
        Err(DomainError::ShortcutConflict { .. })
    ));
    assert_eq!(state, before);
    state
        .reset_shortcut_override(&second, ShortcutPlatform::NonMacOs)
        .unwrap();
    assert!(!state.shortcut_overrides.contains_key(&second));
    assert!(CommandId::new("bad command").is_err());
}

#[test]
fn shortcut_conflicts_respect_primary_platform_mapping() {
    let primary = CommandId::new("first.command").unwrap();
    let control = CommandId::new("second.command").unwrap();

    let mut linux = initial_state();
    linux
        .set_shortcut_override(
            primary.clone(),
            Some(LogicalShortcut::new("Primary+K").unwrap()),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
    let before = linux.clone();
    assert!(matches!(
        linux.set_shortcut_override(
            control.clone(),
            Some(LogicalShortcut::new("Control+K").unwrap()),
            ShortcutPlatform::NonMacOs,
        ),
        Err(DomainError::ShortcutConflict { .. })
    ));
    assert_eq!(linux, before);

    let mut mac = initial_state();
    mac.set_shortcut_override(
        primary,
        Some(LogicalShortcut::new("Primary+K").unwrap()),
        ShortcutPlatform::MacOs,
    )
    .unwrap();
    mac.set_shortcut_override(
        control,
        Some(LogicalShortcut::new("Control+K").unwrap()),
        ShortcutPlatform::MacOs,
    )
    .unwrap();
    mac.validate_for_platform(ShortcutPlatform::MacOs).unwrap();
    assert!(matches!(
        mac.validate_for_platform(ShortcutPlatform::NonMacOs),
        Err(DomainError::ShortcutConflict { .. })
    ));
}

#[test]
fn serialization_omits_runtime_identity_and_preserves_persistent_snapshot() {
    let state = initial_state();
    let encoded = serde_json::to_string_pretty(&state).unwrap();
    assert!(!encoded.contains("session-100"));
    assert!(!encoded.contains("command"));
    assert!(encoded.contains("\"rows\": 24"));
    assert!(encoded.contains("\"cols\": 80"));

    let unchecked: UncheckedApplicationState = serde_json::from_str(&encoded).unwrap();
    let decoded = ApplicationState::try_from(unchecked).unwrap();
    assert_eq!(decoded.revision, state.revision);
    assert_eq!(decoded.workspaces[0].layout, state.workspaces[0].layout);
    assert_eq!(
        decoded.workspaces[0].tabs[&tab_id(100)]
            .content
            .runtime_session_id(),
        None
    );
    let TabContent::Terminal { launch, .. } = &decoded.workspaces[0].tabs[&tab_id(100)].content
    else {
        panic!("expected terminal")
    };
    assert_eq!(launch.cwd, PathBuf::from("/tmp"));
}

#[test]
fn persistent_terminal_commands_and_unsafe_browser_urls_are_default_denied() {
    let command = vec!["agent".into(), "--token=secret-value".into()];
    assert!(matches!(
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), Some(command), 24, 80),
        Err(DomainError::PersistentTerminalCommandUnsupported)
    ));

    let encoded = serde_json::to_string(&initial_state()).unwrap();
    assert!(!encoded.contains("command"));
    assert!(!encoded.contains("secret-value"));

    let mut injected: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    let tabs = injected["workspaces"][0]["tabs"].as_object_mut().unwrap();
    let launch = tabs.values_mut().next().unwrap()["content"]["launch"]
        .as_object_mut()
        .unwrap();
    launch.insert(
        "command".into(),
        serde_json::json!(["agent", "--token=secret-value"]),
    );
    assert!(serde_json::from_value::<UncheckedApplicationState>(injected).is_err());

    for unsafe_url in [
        "file:///tmp/private",
        "javascript:alert(1)",
        "https://user:password@example.test/private",
        "https://example.test\\@attacker.test/private",
        "https://example.test:0/private",
        "https://foo_bar/private",
        "https://-foo/private",
        "https://foo-/private",
        "https://foo..bar/private",
    ] {
        assert!(matches!(
            BrowserMetadata::new(unsafe_url),
            Err(DomainError::UnsafeBrowserUrl)
        ));
        assert!(
            serde_json::from_value::<BrowserMetadata>(serde_json::json!({
                "url": unsafe_url
            }))
            .is_err()
        );
    }

    for safe_url in [
        "https://localhost/private",
        "https://127.0.0.1/private",
        "https://[::1]/private",
    ] {
        assert!(
            BrowserMetadata::new(safe_url).is_ok(),
            "rejected {safe_url}"
        );
    }

    let safe = BrowserMetadata::new(
        " HTTPS://example.test:443/docs/readme?section=browser&view=full#security ",
    )
    .unwrap();
    assert_eq!(
        safe.url(),
        "https://example.test:443/docs/readme?section=browser&view=full#security"
    );
    assert_eq!(safe.profile_partition(), "persist:agent-workspace-default");
    assert_eq!(safe.state_revision(), 0);
    assert_eq!(
        serde_json::from_str::<BrowserMetadata>(&serde_json::to_string(&safe).unwrap()).unwrap(),
        safe
    );
}

#[test]
fn browser_metadata_migrates_url_only_state_and_rejects_invalid_session_state() {
    let legacy: BrowserMetadata = serde_json::from_value(serde_json::json!({
        "url": "https://example.test/search?q=rust#results"
    }))
    .expect("legacy URL-only browser metadata must remain readable");
    assert_eq!(legacy.url(), "https://example.test/search?q=rust#results");
    assert_eq!(
        legacy.profile_partition(),
        "persist:agent-workspace-default"
    );
    assert_eq!(legacy.state_revision(), 0);

    let valid = serde_json::json!({
        "browserSessionId": legacy.browser_session_id(),
        "url": legacy.url(),
        "navigationTitle": "Search results",
        "canBack": true,
        "canForward": false,
        "loading": false,
        "devToolsOpen": true,
        "profilePartition": "persist:workspace-1",
        "stateRevision": 12,
        "correlationId": "navigate:12"
    });
    let decoded: BrowserMetadata = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), valid);

    for (field, invalid_value) in [
        ("profilePartition", serde_json::json!("persist:../escape")),
        ("profilePartition", serde_json::json!("temporary")),
        (
            "stateRevision",
            serde_json::json!(9_007_199_254_740_992_u64),
        ),
        ("correlationId", serde_json::json!("navigate/12")),
    ] {
        let mut candidate = valid.clone();
        candidate[field] = invalid_value;
        assert!(
            serde_json::from_value::<BrowserMetadata>(candidate).is_err(),
            "invalid {field} must be rejected"
        );
    }
}

#[test]
fn browser_actions_and_observations_are_revisioned_and_atomic() {
    let mut state = initial_state();
    let metadata = BrowserMetadata::new("https://example.test/start?q=1#top").unwrap();
    let session_id = metadata.browser_session_id();
    let browser =
        Tab::browser(tab_id(101), pane_id(10), "Browser", metadata, Timestamp(1)).unwrap();
    state
        .open_browser_tab(workspace_id(1), pane_id(10), 1, browser, Timestamp(2))
        .unwrap();
    state
        .navigate_browser(
            workspace_id(1),
            tab_id(101),
            session_id,
            0,
            "https://example.test/next?q=2#result",
            "navigate:1",
            Timestamp(3),
        )
        .unwrap();
    state
        .update_browser_observation(
            workspace_id(1),
            tab_id(101),
            session_id,
            2,
            "https://example.test/next?q=2#result",
            "Next",
            true,
            false,
            false,
            false,
            Some("navigate:1"),
            Timestamp(4),
        )
        .unwrap();
    state
        .request_browser_action(
            workspace_id(1),
            tab_id(101),
            session_id,
            BrowserAction::Back,
            2,
            "back:3",
            Timestamp(5),
        )
        .unwrap();
    let before = state.clone();
    assert!(
        state
            .update_browser_observation(
                workspace_id(1),
                tab_id(101),
                session_id,
                2,
                "https://example.test/stale",
                "Stale",
                false,
                false,
                false,
                false,
                None,
                Timestamp(6),
            )
            .is_err()
    );
    assert_eq!(state, before);
}

#[test]
fn split_can_create_a_browser_without_a_terminal_launch() {
    let mut state = initial_state();
    let new_pane = pane_id(20);
    let browser = Tab::browser(
        tab_id(200),
        new_pane,
        "Browser",
        BrowserMetadata::new("https://example.test/docs?q=split#browser").unwrap(),
        Timestamp(1),
    )
    .unwrap();
    let outcome = state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            new_pane,
            split_id(2_000),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewBrowser(browser),
            Timestamp(2),
        )
        .unwrap();
    assert!(outcome.terminal_launches.is_empty());
    assert!(matches!(
        state.workspaces[0].tabs[&tab_id(200)].content,
        TabContent::Browser { .. }
    ));
}

#[test]
fn split_ratio_regression_is_canonical_and_snapshot_idempotent() {
    let mut state = initial_state();
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            pane_id(1_000),
            split_id(1_001),
            Axis::Vertical,
            f64::from(113) / 10.0 - 4.0,
            SplitPlacement::Before,
            SplitContent::NewTerminal(terminal_tab(1_002, pane_id(1_000), None)),
            Timestamp(0),
        )
        .unwrap();
    state
        .resize_pane_split(
            workspace_id(1),
            split_id(1_001),
            f64::from(24) / 255.0,
            Timestamp(1),
        )
        .unwrap();

    assert!(matches!(
        state.workspaces[0].layout,
        PaneNode::Split { ratio, .. } if ratio.to_bits() == 0.094_118_f64.to_bits()
    ));
    let first_json = serde_json::to_string(&state).unwrap();
    let unchecked: UncheckedApplicationState = serde_json::from_str(&first_json).unwrap();
    let reloaded = ApplicationState::try_from(unchecked).unwrap();
    let second_json = serde_json::to_string(&reloaded).unwrap();
    let mut persistent_state = state;
    for tab in persistent_state.workspaces[0].tabs.values_mut() {
        tab.content.set_runtime_session_id(None);
    }
    assert_eq!(reloaded, persistent_state);
    assert_eq!(second_json, first_json);
}

#[test]
fn loaded_snapshot_validation_catches_orphans_and_bad_selection() {
    let mut state = initial_state();
    state.workspaces[0].selected_pane_id = pane_id(999);
    assert!(matches!(
        state.validate(),
        Err(DomainError::InvalidState { .. })
    ));

    let mut state = initial_state();
    state.workspaces[0]
        .panes
        .get_mut(&pane_id(10))
        .unwrap()
        .tabs = vec![tab_id(999)];
    assert!(state.validate().is_err());
}

#[test]
fn caller_created_terminals_must_be_unbound_on_every_creation_and_replacement_path() {
    let mut state = initial_state();
    let fake = terminal_tab(101, pane_id(10), Some("session-100"));
    let before = state.clone();
    assert!(matches!(
        state.open_terminal_tab(workspace_id(1), pane_id(10), 1, fake, Timestamp(2)),
        Err(DomainError::PreboundTerminalInput { id }) if id == tab_id(101)
    ));
    assert_eq!(state, before);

    let before = state.clone();
    assert!(matches!(
        state.split_pane(
            workspace_id(1),
            pane_id(10),
            pane_id(20),
            split_id(1_000),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, pane_id(20), Some("fake"))),
            Timestamp(2),
        ),
        Err(DomainError::PreboundTerminalInput { id }) if id == tab_id(200)
    ));
    assert_eq!(state, before);

    for result in [
        state.close_tab(
            workspace_id(1),
            tab_id(100),
            Some(terminal_tab(101, pane_id(10), Some("fake"))),
            Timestamp(2),
        ),
        state.close_pane(
            workspace_id(1),
            pane_id(10),
            Some(terminal_tab(102, pane_id(10), Some("fake"))),
            Timestamp(2),
        ),
    ] {
        assert!(matches!(
            result,
            Err(DomainError::PreboundTerminalInput { .. })
        ));
        assert_eq!(state, before);
    }

    assert!(matches!(
        state.create_workspace(workspace(2, 20, 200)),
        Err(DomainError::PreboundTerminalInput { id }) if id == tab_id(200)
    ));
    assert_eq!(state, before);
    assert!(matches!(
        state.close_workspace(workspace_id(1), Some(workspace(3, 30, 300))),
        Err(DomainError::PreboundTerminalInput { id }) if id == tab_id(300)
    ));
    assert_eq!(state, before);

    let outcome = state
        .close_workspace(workspace_id(1), Some(unbound_workspace(3, 30, 300)))
        .unwrap();
    assert_eq!(outcome.terminal_launches.len(), 1);
    assert_eq!(outcome.terminal_launches[0].tab_id, tab_id(300));
    assert_eq!(
        outcome.terminal_sessions_to_terminate,
        [RuntimeSessionId::new("session-100")]
    );
}

#[test]
fn default_shortcuts_participate_in_effective_conflict_validation() {
    assert_eq!(DEFAULT_SHORTCUT_CATALOG.len(), 12);
    let mut state = initial_state();
    let terminal = CommandId::new("terminal.new").unwrap();
    let workspace = CommandId::new("workspace.new").unwrap();
    let primary_o = LogicalShortcut::new("Primary+O").unwrap();

    let before = state.clone();
    assert!(matches!(
        state.set_shortcut_override(
            terminal.clone(),
            Some(primary_o.clone()),
            ShortcutPlatform::NonMacOs,
        ),
        Err(DomainError::ShortcutConflict { .. })
    ));
    assert_eq!(state, before);

    state
        .set_shortcut_override(workspace.clone(), None, ShortcutPlatform::NonMacOs)
        .unwrap();
    state
        .set_shortcut_override(
            terminal.clone(),
            Some(primary_o),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
    let before_reset = state.clone();
    assert!(matches!(
        state.reset_shortcut_override(&workspace, ShortcutPlatform::NonMacOs),
        Err(DomainError::ShortcutConflict { .. })
    ));
    assert_eq!(state, before_reset);

    state
        .set_shortcut_override(terminal, None, ShortcutPlatform::NonMacOs)
        .unwrap();
    state
        .reset_shortcut_override(&workspace, ShortcutPlatform::NonMacOs)
        .unwrap();
    assert!(
        state
            .effective_shortcut_bindings()
            .unwrap()
            .contains_key(&workspace)
    );
}

#[test]
fn secondary_maps_to_alt_and_option_on_all_platforms() {
    for platform in [ShortcutPlatform::MacOs, ShortcutPlatform::NonMacOs] {
        for alias in ["Alt+K", "Option+K"] {
            let mut state = initial_state();
            state
                .set_shortcut_override(
                    CommandId::new("first").unwrap(),
                    Some(LogicalShortcut::new("Secondary+K").unwrap()),
                    platform,
                )
                .unwrap();
            let before = state.clone();
            assert!(matches!(
                state.set_shortcut_override(
                    CommandId::new("second").unwrap(),
                    Some(LogicalShortcut::new(alias).unwrap()),
                    platform,
                ),
                Err(DomainError::ShortcutConflict { .. })
            ));
            assert_eq!(state, before);
        }
    }
}

#[test]
fn exact_semantic_noops_preserve_revision_timestamps_and_state() {
    let mut state = initial_state();
    for result in [
        state.select_workspace(workspace_id(1)),
        state.focus_pane(workspace_id(1), pane_id(10), Timestamp(99)),
        state.select_tab(workspace_id(1), tab_id(100), Timestamp(99)),
        state.update_workspace(
            workspace_id(1),
            WorkspaceUpdate {
                name: Some(" workspace-1 ".into()),
                ..WorkspaceUpdate::default()
            },
            Timestamp(99),
        ),
        state.update_tab(
            workspace_id(1),
            tab_id(100),
            Some(" tab-100 ".into()),
            None,
            Timestamp(99),
        ),
    ] {
        assert!(matches!(result, Err(DomainError::InvalidOperation { .. })));
        assert_eq!(state, initial_state());
    }

    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            pane_id(20),
            split_id(1_000),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, pane_id(20), None)),
            Timestamp(2),
        )
        .unwrap();
    let before = state.clone();
    assert!(matches!(
        state.resize_pane_split(workspace_id(1), split_id(1_000), 0.5, Timestamp(99)),
        Err(DomainError::InvalidOperation { .. })
    ));
    assert_eq!(state, before);

    let command = CommandId::new("workspace.new").unwrap();
    state
        .set_shortcut_override(command.clone(), None, ShortcutPlatform::NonMacOs)
        .unwrap();
    let before = state.clone();
    assert!(matches!(
        state.set_shortcut_override(command, None, ShortcutPlatform::NonMacOs),
        Err(DomainError::InvalidOperation { .. })
    ));
    assert_eq!(state, before);
}

#[test]
fn unchecked_snapshot_conversion_separates_syntax_and_domain_errors() {
    assert!(serde_json::from_str::<UncheckedApplicationState>("{not-json").is_err());

    let encoded = serde_json::to_string(&initial_state()).unwrap();
    let mut unchecked: UncheckedApplicationState = serde_json::from_str(&encoded).unwrap();
    unchecked.selected_workspace_id = workspace_id(999);
    assert!(matches!(
        ApplicationState::try_from(unchecked),
        Err(DomainError::InvalidState { .. })
    ));
}

#[test]
fn persistent_pane_split_and_tab_ids_are_globally_unique() {
    let cases = [unbound_workspace(2, 10, 200), unbound_workspace(2, 20, 100)];
    for duplicate_workspace in cases {
        let mut state = initial_state();
        let before = state.clone();
        assert!(matches!(
            state.create_workspace(duplicate_workspace),
            Err(DomainError::DuplicateId { .. })
        ));
        assert_eq!(state, before);
    }

    let mut state = initial_state();
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            pane_id(11),
            split_id(1_000),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(101, pane_id(11), None)),
            Timestamp(2),
        )
        .unwrap();
    let mut second = ApplicationState::new(unbound_workspace(2, 20, 200)).unwrap();
    second
        .split_pane(
            workspace_id(2),
            pane_id(20),
            pane_id(21),
            split_id(1_000),
            Axis::Vertical,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(201, pane_id(21), None)),
            Timestamp(2),
        )
        .unwrap();
    let before = state.clone();
    assert!(matches!(
        state.create_workspace(second.workspaces.remove(0)),
        Err(DomainError::DuplicateId {
            entity: "split",
            ..
        })
    ));
    assert_eq!(state, before);
}

#[test]
fn revisions_and_timestamps_stay_within_javascript_safe_integer_range() {
    let mut state = initial_state();
    state.revision = MAX_SAFE_INTEGER;
    state.validate().unwrap();
    let before = state.clone();
    assert!(matches!(
        state.update_tab(
            workspace_id(1),
            tab_id(100),
            Some("changed".into()),
            None,
            Timestamp(2),
        ),
        Err(DomainError::RevisionOverflow)
    ));
    assert_eq!(state, before);

    state.revision = MAX_SAFE_INTEGER + 1;
    assert!(matches!(
        state.validate(),
        Err(DomainError::RevisionOutOfRange { .. })
    ));

    let mut state = initial_state();
    state.workspaces[0].updated_at = Timestamp(MAX_SAFE_INTEGER + 1);
    assert!(matches!(
        state.validate(),
        Err(DomainError::TimestampOutOfRange {
            field: "workspace.updated_at",
            ..
        })
    ));
    let mut state = initial_state();
    state.workspaces[0]
        .tabs
        .get_mut(&tab_id(100))
        .unwrap()
        .created_at = Timestamp(MAX_SAFE_INTEGER + 1);
    assert!(matches!(
        state.validate(),
        Err(DomainError::TimestampOutOfRange {
            field: "tab.created_at",
            ..
        })
    ));
}

#[test]
fn shortcut_grammar_matches_renderer_supported_chords() {
    for invalid in ["Ctrl", "Banana", "Primary+K+L", "Ctrl+Ctrl+K", "Primary++K"] {
        assert!(matches!(
            LogicalShortcut::new(invalid),
            Err(DomainError::InvalidShortcut { .. })
        ));
    }
    assert_eq!(
        LogicalShortcut::new(" shift+primary+, ").unwrap().as_str(),
        "Primary+Shift+Comma"
    );
    assert_eq!(
        LogicalShortcut::new("option+f24").unwrap().as_str(),
        "Secondary+F24"
    );
    assert_eq!(LogicalShortcut::new("F1").unwrap().as_str(), "F1");
}

#[test]
fn runtime_session_replacement_is_atomic_and_terminates_only_the_old_session() {
    let mut state = initial_state();
    let before_revision = state.revision;
    let outcome = state
        .replace_terminal_runtime_session(
            workspace_id(1),
            tab_id(100),
            RuntimeSessionId::new("session-new"),
            Timestamp(2),
        )
        .unwrap();
    assert_eq!(outcome.revision, before_revision + 1);
    assert!(outcome.terminal_launches.is_empty());
    assert_eq!(
        outcome.terminal_sessions_to_terminate,
        [RuntimeSessionId::new("session-100")]
    );
    assert_eq!(
        state.workspaces[0].tabs[&tab_id(100)]
            .content
            .runtime_session_id()
            .map(RuntimeSessionId::as_str),
        Some("session-new")
    );

    state
        .open_terminal_tab(
            workspace_id(1),
            pane_id(10),
            1,
            terminal_tab(101, pane_id(10), None),
            Timestamp(3),
        )
        .unwrap();
    let unattached = state.clone();
    assert!(matches!(
        state.replace_terminal_runtime_session(
            workspace_id(1),
            tab_id(101),
            RuntimeSessionId::new("unused"),
            Timestamp(4),
        ),
        Err(DomainError::RuntimeSessionNotBound { .. })
    ));
    assert_eq!(state, unattached);

    let before_duplicate = state.clone();
    assert!(matches!(
        state.replace_terminal_runtime_session(
            workspace_id(1),
            tab_id(100),
            RuntimeSessionId::new("session-new"),
            Timestamp(4),
        ),
        Err(DomainError::DuplicateId {
            entity: "runtime_session",
            ..
        })
    ));
    assert_eq!(state, before_duplicate);
}

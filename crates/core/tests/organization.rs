use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, Axis, BrowserMetadata, DomainError, GroupId, LayoutExportEnvelope, LayoutId,
    LayoutTemplate, PaneId, PaneNode, RuntimeSessionId, SavedLayout, SplitId, Tab, TabContent,
    TabId, TerminalLaunchSpec, Timestamp, UncheckedApplicationState, Workspace, WorkspaceId,
};

fn workspace(name: &str) -> Workspace {
    let pane_id = PaneId::new();
    let tab = Tab::terminal(
        TabId::new(),
        pane_id,
        "Terminal",
        TerminalLaunchSpec::new(PathBuf::from("/tmp/project"), None, 24, 80).unwrap(),
        None,
        Timestamp(1),
    )
    .unwrap();
    Workspace::new(
        WorkspaceId::new(),
        name,
        PathBuf::from("/tmp/project"),
        pane_id,
        tab,
        Timestamp(1),
        Timestamp(1),
    )
    .unwrap()
}

fn browser_workspace(profile_partition: &str) -> (Workspace, uuid::Uuid) {
    let pane_id = PaneId::new();
    let metadata = BrowserMetadata::new_with_partition(
        "HTTPS://Example.COM:443/private/path?access_token=query-secret#fragment-secret",
        profile_partition,
    )
    .unwrap();
    let browser_session_id = metadata.browser_session_id();
    let tab = Tab::browser(TabId::new(), pane_id, "Browser", metadata, Timestamp(1)).unwrap();
    (
        Workspace::new(
            WorkspaceId::new(),
            "browser",
            PathBuf::from("/tmp/project"),
            pane_id,
            tab,
            Timestamp(1),
            Timestamp(1),
        )
        .unwrap(),
        browser_session_id,
    )
}

#[test]
fn organization_mutations_are_atomic_reference_safe_and_noops_preserve_revision() {
    let first = workspace("first");
    let first_id = first.id;
    let mut state = ApplicationState::new(first).unwrap();
    let second = workspace("second");
    let second_id = second.id;
    state.create_workspace(second).unwrap();
    state
        .replace_workspace_selection(vec![first_id], first_id)
        .unwrap();
    let revision = state.revision;
    let no_op = state.set_workspace_pinned(first_id, false).unwrap();
    assert_eq!(no_op.revision, revision);
    assert_eq!(state.revision, revision);
    let reorder_no_op = state.move_workspace(second_id, 1).unwrap();
    assert_eq!(reorder_no_op.revision, revision);
    assert_eq!(state.revision, revision);
    assert_eq!(
        state
            .workspaces
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        vec![first_id, second_id]
    );

    state.set_workspace_pinned(first_id, true).unwrap();
    let group_id = GroupId::new();
    state
        .create_workspace_group(group_id, "  Delivery  ")
        .unwrap();
    state
        .assign_workspace_group(first_id, Some(group_id))
        .unwrap();
    state.set_workspace_group_collapsed(group_id, true).unwrap();
    state.close_selected_workspaces(None).unwrap();
    assert_eq!(state.selected_workspace_id, second_id);
    assert_eq!(state.workspace_selection, vec![second_id]);
    assert!(!state.workspace_pins.contains(&first_id));
    assert!(!state.workspace_group_assignments.contains_key(&first_id));
    state.validate().unwrap();
}

#[test]
fn layout_preflight_authorizes_paths_and_preserves_matching_terminal_by_global_tab_id() {
    let mut original = workspace("original");
    let tab_id = *original.tabs.keys().next().unwrap();
    original
        .tabs
        .get_mut(&tab_id)
        .unwrap()
        .content
        .set_runtime_session_id(Some(RuntimeSessionId::new("pty-1")));
    let mut state = ApplicationState::new(original.clone()).unwrap();
    let mut template_workspace = original;
    template_workspace.name = "renamed".to_owned();
    template_workspace
        .tabs
        .get_mut(&tab_id)
        .unwrap()
        .set_title("renamed tab")
        .unwrap();
    template_workspace
        .tabs
        .get_mut(&tab_id)
        .unwrap()
        .content
        .set_runtime_session_id(None);
    let layout = SavedLayout::new(
        LayoutId::new(),
        "work",
        LayoutTemplate::new(vec![template_workspace]).unwrap(),
        Timestamp(2),
        Timestamp(2),
    )
    .unwrap();
    let layout_id = layout.id;
    state.save_layout(layout).unwrap();

    assert!(matches!(
        state.plan_saved_layout_application(layout_id, &[PathBuf::from("/other")]),
        Err(DomainError::UnauthorizedLayoutPath { .. })
    ));
    assert!(
        state
            .plan_saved_layout_application(layout_id, &[PathBuf::from("/tmp/project/../other")])
            .is_err()
    );
    let plan = state
        .plan_saved_layout_application(layout_id, &[PathBuf::from("/tmp")])
        .unwrap();
    assert_eq!(
        plan.preserved_terminal_sessions,
        vec![RuntimeSessionId::new("pty-1")]
    );
    let outcome = state.apply_layout_plan(plan).unwrap();
    assert!(outcome.terminal_launches.is_empty());
    assert!(outcome.terminal_sessions_to_terminate.is_empty());
}

#[test]
fn ordinary_mutations_cannot_enter_legacy_reduction_mode() {
    let mut state = ApplicationState::new(workspace("0")).unwrap();
    for index in 1..128 {
        state
            .create_workspace(workspace(&index.to_string()))
            .unwrap();
    }
    let before = state.clone();
    assert!(matches!(
        state.create_workspace(workspace("overflow")),
        Err(DomainError::ResourceLimit {
            resource: "application.workspaces",
            actual: 129,
            maximum: 128
        })
    ));
    assert_eq!(state, before);
    assert!(state.legacy_over_limit.is_none());
}

#[test]
fn layout_import_is_strict_and_assigns_fresh_tree_ids() {
    let initial = workspace("initial");
    let original_workspace_id = initial.id;
    let mut state = ApplicationState::new(initial.clone()).unwrap();
    let envelope = LayoutExportEnvelope {
        format_version: 1,
        name: "portable".to_owned(),
        template: LayoutTemplate::new(vec![initial]).unwrap(),
    };
    let layout_id = LayoutId::new();
    state
        .import_saved_layout(envelope, layout_id, Timestamp(2), Timestamp(2))
        .unwrap();
    assert_ne!(
        state.saved_layouts[0].template.workspaces[0].id,
        original_workspace_id
    );
    let unknown = serde_json::json!({
        "formatVersion": 1,
        "name": "portable",
        "template": { "workspaces": [], "unexpected": true }
    });
    assert!(serde_json::from_value::<LayoutExportEnvelope>(unknown).is_err());
}

#[test]
fn explicit_empty_selection_is_not_treated_as_a_legacy_missing_field() {
    let state = ApplicationState::new(workspace("initial")).unwrap();
    let mut value = serde_json::to_value(state).unwrap();
    value["workspaceSelection"] = serde_json::json!([]);
    let unchecked: UncheckedApplicationState = serde_json::from_value(value).unwrap();
    assert!(ApplicationState::try_from(unchecked).is_err());
}

#[test]
fn pane_tree_emits_camel_case_and_accepts_pre_m2_persisted_field_names() {
    let pane_id = PaneId::new();
    let split_id = SplitId::new();
    let tree = PaneNode::Split {
        split_id,
        axis: Axis::Horizontal,
        ratio: 0.5,
        first: Box::new(PaneNode::Leaf { pane_id }),
        second: Box::new(PaneNode::Leaf {
            pane_id: PaneId::new(),
        }),
    };
    let wire = serde_json::to_value(&tree).unwrap();
    assert_eq!(wire["splitId"], split_id.to_string());
    assert_eq!(wire["first"]["paneId"], pane_id.to_string());
    assert!(wire.get("split_id").is_none());
    assert!(wire["first"].get("pane_id").is_none());

    let legacy = serde_json::json!({
        "kind": "split",
        "split_id": split_id,
        "axis": "horizontal",
        "ratio": 0.5,
        "first": { "kind": "leaf", "pane_id": pane_id },
        "second": { "kind": "leaf", "pane_id": PaneId::new() }
    });
    assert!(serde_json::from_value::<PaneNode>(legacy).is_ok());
}

#[test]
fn portable_browser_envelope_scrubs_storage_and_materializes_fresh_local_identity() {
    let (workspace, original_browser_id) = browser_workspace("persist:hostile-private-profile");
    let mut state = ApplicationState::new(workspace.clone()).unwrap();
    let local_layout = SavedLayout::new(
        LayoutId::new(),
        "browser",
        LayoutTemplate::new(vec![workspace]).unwrap(),
        Timestamp(2),
        Timestamp(2),
    )
    .unwrap();
    let local_layout_id = local_layout.id;
    state.save_layout(local_layout).unwrap();
    let envelope = state.export_saved_layout(local_layout_id).unwrap();
    let json = serde_json::to_string(&envelope).unwrap();
    let saved_json = serde_json::to_string(&state.saved_layouts[0]).unwrap();
    assert!(json.contains("https://example.com"));
    for forbidden in [
        "browserSessionId",
        "profilePartition",
        "navigationTitle",
        "correlationId",
        "stateRevision",
        "canBack",
        "canForward",
        "devToolsOpen",
        "persist:hostile-private-profile",
        "access_token",
        "query-secret",
        "fragment-secret",
    ] {
        assert!(!json.contains(forbidden), "leaked {forbidden}: {json}");
        assert!(
            !saved_json.contains(forbidden),
            "saved layout leaked {forbidden}: {saved_json}"
        );
    }
    assert!(!json.contains(&original_browser_id.to_string()));

    let local_plan = state
        .plan_saved_layout_application(local_layout_id, &[PathBuf::from("/tmp")])
        .unwrap();
    let local_metadata = local_plan.workspaces[0]
        .tabs
        .values()
        .find_map(|tab| match &tab.content {
            TabContent::Browser { metadata } => Some(metadata),
            TabContent::Terminal { .. } => None,
        })
        .unwrap();
    assert_eq!(local_metadata.browser_session_id(), original_browser_id);
    assert_eq!(
        local_metadata.url(),
        "https://Example.COM:443/private/path?access_token=query-secret#fragment-secret"
    );
    assert_eq!(
        local_metadata.profile_partition(),
        "persist:hostile-private-profile"
    );

    let mut hostile = serde_json::to_value(&envelope).unwrap();
    let content = &mut hostile["template"]["workspaces"][0]["tabs"];
    let first_key = content.as_object().unwrap().keys().next().unwrap().clone();
    content[&first_key]["content"]["profilePartition"] = serde_json::json!("persist:stolen");
    assert!(serde_json::from_value::<LayoutExportEnvelope>(hostile).is_err());

    for hostile_url in [
        "https://user:password@example.com/private/path",
        "https://example.com/private/path?access_token=stolen",
        "https://example.com/private/path#stolen",
        "HTTPS://EXAMPLE.COM/private/path",
        "https://foo_bar/private/path",
        "https://-foo/private/path",
        "https://foo-/private/path",
        "https://foo..bar/private/path",
        "https://example.com:0/private/path",
    ] {
        let mut hostile = serde_json::to_value(&envelope).unwrap();
        let tabs = &mut hostile["template"]["workspaces"][0]["tabs"];
        let first_key = tabs.as_object().unwrap().keys().next().unwrap().clone();
        tabs[&first_key]["content"]["url"] = serde_json::json!(hostile_url);
        let envelope: LayoutExportEnvelope = serde_json::from_value(hostile).unwrap();
        assert!(envelope.validate().is_err(), "accepted {hostile_url}");
    }

    let imported_id = LayoutId::new();
    state
        .import_saved_layout(envelope, imported_id, Timestamp(3), Timestamp(3))
        .unwrap();
    let plan = state
        .plan_saved_layout_application(imported_id, &[PathBuf::from("/tmp")])
        .unwrap();
    let metadata = plan.workspaces[0]
        .tabs
        .values()
        .find_map(|tab| match &tab.content {
            TabContent::Browser { metadata } => Some(metadata),
            TabContent::Terminal { .. } => None,
        })
        .unwrap();
    assert_ne!(metadata.browser_session_id(), original_browser_id);
    assert_eq!(
        metadata.profile_partition(),
        "persist:agent-workspace-default"
    );
}

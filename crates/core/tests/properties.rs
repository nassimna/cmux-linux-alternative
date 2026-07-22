#![allow(deprecated)]

use std::collections::BTreeSet;
use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, Axis, CommandId, LogicalShortcut, MutationOutcome, PaneId, PaneNode,
    RuntimeSessionId, ShortcutPlatform, SplitContent, SplitId, SplitPlacement, Tab, TabContent,
    TabId, TerminalLaunchSpec, Timestamp, UncheckedApplicationState, Workspace, WorkspaceId,
};
use proptest::prelude::*;
use uuid::Uuid;

fn wid(value: u128) -> WorkspaceId {
    WorkspaceId::from_uuid(Uuid::from_u128(value))
}

fn pid(value: u128) -> PaneId {
    PaneId::from_uuid(Uuid::from_u128(value))
}

fn sid(value: u128) -> SplitId {
    SplitId::from_uuid(Uuid::from_u128(value))
}

fn tid(value: u128) -> TabId {
    TabId::from_uuid(Uuid::from_u128(value))
}

fn tab(id: u128, pane: PaneId) -> Tab {
    Tab::terminal(
        tid(id),
        pane,
        "terminal",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(u64::try_from(id).unwrap()),
    )
    .unwrap()
}

fn initial() -> ApplicationState {
    let pane = pid(10);
    ApplicationState::new(
        Workspace::new(
            wid(1),
            "main",
            PathBuf::from("/tmp"),
            pane,
            tab(100, pane),
            Timestamp(0),
            Timestamp(0),
        )
        .unwrap(),
    )
    .unwrap()
}

fn collect_layout(node: &PaneNode, leaves: &mut Vec<PaneId>, ratios: &mut Vec<f64>) {
    match node {
        PaneNode::Leaf { pane_id } => leaves.push(*pane_id),
        PaneNode::Split {
            ratio,
            first,
            second,
            ..
        } => {
            ratios.push(*ratio);
            collect_layout(first, leaves, ratios);
            collect_layout(second, leaves, ratios);
        }
    }
}

fn assert_strong_invariants(state: &ApplicationState) {
    state.validate().unwrap();
    assert!(!state.workspaces.is_empty());
    assert!(
        state
            .workspaces
            .iter()
            .any(|workspace| workspace.id == state.selected_workspace_id)
    );
    for workspace in &state.workspaces {
        let mut leaves = Vec::new();
        let mut ratios = Vec::new();
        collect_layout(&workspace.layout, &mut leaves, &mut ratios);
        assert_eq!(leaves.len(), leaves.iter().collect::<BTreeSet<_>>().len());
        assert_eq!(
            leaves.iter().copied().collect::<BTreeSet<_>>(),
            workspace.panes.keys().copied().collect()
        );
        assert!(
            ratios
                .iter()
                .all(|ratio| ratio.is_finite() && (0.05..=0.95).contains(ratio))
        );
        let mut tab_owners = BTreeSet::new();
        for (pane_id, pane) in &workspace.panes {
            assert!(!pane.tabs.is_empty());
            assert!(pane.tabs.contains(&pane.selected_tab_id));
            for tab_id in &pane.tabs {
                assert!(tab_owners.insert(*tab_id));
                assert_eq!(workspace.tabs[tab_id].pane_id, *pane_id);
            }
        }
        assert_eq!(tab_owners, workspace.tabs.keys().copied().collect());
    }
}

fn split_ids(node: &PaneNode, ids: &mut Vec<SplitId>) {
    if let PaneNode::Split {
        split_id,
        first,
        second,
        ..
    } = node
    {
        ids.push(*split_id);
        split_ids(first, ids);
        split_ids(second, ids);
    }
}

fn assert_effect_oracle(
    before: &ApplicationState,
    after: &ApplicationState,
    outcome: &MutationOutcome,
) {
    let before_tabs: BTreeSet<_> = before
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .tabs
                .keys()
                .map(move |tab_id| (workspace.id, *tab_id))
        })
        .collect();
    let after_sessions: BTreeSet<_> = after
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| tab.content.runtime_session_id().cloned())
        .collect();
    let expected_launches: Vec<_> = after
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace.tabs.values().filter_map(|tab| {
                if before_tabs.contains(&(workspace.id, tab.id)) {
                    return None;
                }
                let TabContent::Terminal {
                    launch,
                    runtime_session_id: None,
                } = &tab.content
                else {
                    return None;
                };
                Some((workspace.id, tab.pane_id, tab.id, launch.clone()))
            })
        })
        .collect();
    let actual_launches: Vec<_> = outcome
        .terminal_launches
        .iter()
        .map(|launch| {
            (
                launch.workspace_id,
                launch.pane_id,
                launch.tab_id,
                launch.launch.clone(),
            )
        })
        .collect();
    assert_eq!(actual_launches, expected_launches);

    let expected_terminations: Vec<_> = before
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| tab.content.runtime_session_id())
        .filter(|session| !after_sessions.contains(*session))
        .cloned()
        .collect();
    assert_eq!(
        outcome.terminal_sessions_to_terminate,
        expected_terminations
    );
}

fn assert_persistent_round_trip(state: &ApplicationState) {
    let encoded = serde_json::to_string(state).unwrap();
    let unchecked: UncheckedApplicationState = serde_json::from_str(&encoded).unwrap();
    let decoded = ApplicationState::try_from(unchecked).unwrap();
    let mut expected = state.clone();
    for workspace in &mut expected.workspaces {
        for tab in workspace.tabs.values_mut() {
            tab.content.set_runtime_session_id(None);
        }
    }
    assert_eq!(decoded, expected);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn mutation_sequences_preserve_invariants_and_atomicity(ops in prop::collection::vec(any::<u8>(), 1..80)) {
        let mut state = initial();
        let mut next = 1_000_u128;
        for (step, op) in ops.into_iter().enumerate() {
            let before = state.clone();
            let revision = state.revision;
            let workspace_id = state.selected_workspace_id;
            let workspace = state.workspaces.iter().find(|item| item.id == workspace_id).unwrap();
            let pane_ids: Vec<_> = workspace.panes.keys().copied().collect();
            let tab_ids: Vec<_> = workspace.tabs.keys().copied().collect();
            let result = match op % 16 {
                0 => {
                    let pane = pane_ids[usize::from(op) % pane_ids.len()];
                    let id = next;
                    next += 1;
                    state.open_terminal_tab(workspace_id, pane, workspace.panes[&pane].tabs.len(), tab(id, pane), Timestamp(step as u64))
                }
                1 if pane_ids.len() < 10 => {
                    let target = pane_ids[usize::from(op) % pane_ids.len()];
                    let pane = pid(next);
                    let split = sid(next + 1);
                    let new_tab = tab(next + 2, pane);
                    next += 3;
                    state.split_pane(
                        workspace_id,
                        target,
                        pane,
                        split,
                        if op & 1 == 0 { Axis::Horizontal } else { Axis::Vertical },
                        f64::from(op) / 10.0 - 4.0,
                        if op & 2 == 0 { SplitPlacement::Before } else { SplitPlacement::After },
                        SplitContent::NewTerminal(new_tab),
                        Timestamp(step as u64),
                    )
                }
                2 if tab_ids.len() > 1 => {
                    let tab_id = tab_ids[usize::from(op) % tab_ids.len()];
                    state.close_tab(workspace_id, tab_id, None, Timestamp(step as u64))
                }
                3 if pane_ids.len() > 1 => {
                    let pane = pane_ids[usize::from(op) % pane_ids.len()];
                    state.close_pane(workspace_id, pane, None, Timestamp(step as u64))
                }
                4 if pane_ids.len() > 1 => {
                    let tab_id = tab_ids[usize::from(op) % tab_ids.len()];
                    let source = workspace.tabs[&tab_id].pane_id;
                    let destination = pane_ids.iter().copied().find(|pane| *pane != source).unwrap();
                    let index = workspace.panes[&destination].tabs.len();
                    state.move_tab(workspace_id, tab_id, destination, index, Timestamp(step as u64))
                }
                5 => {
                    let tab_id = tab_ids[usize::from(op) % tab_ids.len()];
                    state.select_tab(workspace_id, tab_id, Timestamp(step as u64))
                }
                6 => {
                    let pane = pane_ids[usize::from(op) % pane_ids.len()];
                    state.focus_pane(workspace_id, pane, Timestamp(step as u64))
                }
                7 => {
                    if let Some((pane_id, pane)) = workspace.panes.iter().find(|(_, pane)| pane.tabs.len() > 1) {
                        state.move_tab(workspace_id, pane.tabs[0], *pane_id, pane.tabs.len(), Timestamp(step as u64))
                    } else {
                        state.move_tab(workspace_id, tab_ids[0], pid(u128::MAX), 0, Timestamp(step as u64))
                    }
                }
                8 => {
                    let mut ids = Vec::new();
                    split_ids(&workspace.layout, &mut ids);
                    if let Some(split_id) = ids.first() {
                        state.resize_pane_split(workspace_id, *split_id, f64::from(op) / 255.0, Timestamp(step as u64))
                    } else {
                        state.resize_pane_split(workspace_id, sid(u128::MAX), 0.5, Timestamp(step as u64))
                    }
                }
                9 => {
                    if op & 1 == 0 {
                        state.set_shortcut_override(
                            CommandId::new("workspace.new").unwrap(),
                            None,
                            ShortcutPlatform::NonMacOs,
                        )
                    } else {
                        state.set_shortcut_override(
                            CommandId::new("model.command").unwrap(),
                            Some(LogicalShortcut::new("Control+F12").unwrap()),
                            ShortcutPlatform::NonMacOs,
                        )
                    }
                }
                10 => {
                    if let Some(tab_id) = workspace.tabs.values().find(|tab| {
                        matches!(tab.content, TabContent::Terminal { .. })
                            && tab.content.runtime_session_id().is_none()
                    }).map(|tab| tab.id) {
                        state.bind_terminal_runtime_session(
                            workspace_id,
                            tab_id,
                            RuntimeSessionId::new(format!("session-{next}")),
                            Timestamp(step as u64),
                        )
                    } else {
                        state.bind_terminal_runtime_session(
                            workspace_id,
                            tab_ids[0],
                            RuntimeSessionId::new(format!("session-{next}")),
                            Timestamp(step as u64),
                        )
                    }
                }
                11 => {
                    if let Some((target, tab_id)) = workspace
                        .panes
                        .iter()
                        .find(|(_, pane)| pane.tabs.len() > 1)
                        .map(|(pane_id, pane)| (*pane_id, pane.tabs[0]))
                        .or_else(|| {
                            (pane_ids.len() > 1).then(|| {
                                let source = pane_ids[0];
                                let target = pane_ids[1];
                                (target, workspace.panes[&source].tabs[0])
                            })
                        })
                    {
                        let pane = pid(next);
                        let split = sid(next + 1);
                        next += 2;
                        state.split_pane(
                            workspace_id,
                            target,
                            pane,
                            split,
                            Axis::Vertical,
                            0.5,
                            SplitPlacement::After,
                            SplitContent::ExistingTab(tab_id),
                            Timestamp(step as u64),
                        )
                    } else {
                        state.move_tab(workspace_id, tab_ids[0], pid(u128::MAX), 0, Timestamp(step as u64))
                    }
                }
                12 => {
                    let pane = pid(next + 1);
                    let workspace = Workspace::new(
                        wid(next),
                        format!("workspace-{next}"),
                        PathBuf::from("/tmp"),
                        pane,
                        tab(next + 2, pane),
                        Timestamp(step as u64),
                        Timestamp(step as u64),
                    ).unwrap();
                    next += 3;
                    state.create_workspace(workspace)
                }
                13 => {
                    if state.workspaces.len() > 1 {
                        state.close_workspace(workspace_id, None)
                    } else {
                        let pane = pid(next + 1);
                        let replacement = Workspace::new(
                            wid(next),
                            format!("replacement-{next}"),
                            PathBuf::from("/tmp"),
                            pane,
                            tab(next + 2, pane),
                            Timestamp(step as u64),
                            Timestamp(step as u64),
                        ).unwrap();
                        next += 3;
                        state.close_workspace(workspace_id, Some(replacement))
                    }
                }
                14 => {
                    if let Some(tab) = workspace.tabs.values().find(|tab| tab.content.runtime_session_id().is_some()) {
                        state.replace_terminal_runtime_session(
                            workspace_id,
                            tab.id,
                            RuntimeSessionId::new(format!("replacement-session-{next}")),
                            Timestamp(step as u64),
                        )
                    } else {
                        state.move_tab(workspace_id, tab_ids[0], pid(u128::MAX), 0, Timestamp(step as u64))
                    }
                }
                _ if workspace.tabs.len() == 1 => {
                    let pane = workspace.tabs[&tab_ids[0]].pane_id;
                    let replacement = tab(next, pane);
                    next += 1;
                    state.close_tab(workspace_id, tab_ids[0], Some(replacement), Timestamp(step as u64))
                }
                _ => {
                    let pane = workspace.selected_pane_id;
                    let mut prebound = tab(next, pane);
                    prebound.content.set_runtime_session_id(Some(RuntimeSessionId::new("fake-prebound")));
                    next += 1;
                    state.open_terminal_tab(workspace_id, pane, workspace.panes[&pane].tabs.len(), prebound, Timestamp(step as u64))
                },
            };
            if let Ok(outcome) = result {
                prop_assert_eq!(outcome.revision, revision + 1);
                prop_assert_eq!(state.revision, revision + 1);
                assert_effect_oracle(&before, &state, &outcome);
                assert_strong_invariants(&state);
            } else {
                prop_assert_eq!(&state, &before);
            }
            assert_persistent_round_trip(&state);
        }
    }

    #[test]
    fn arbitrary_ratios_are_clamped_or_rejected_atomically(ratio in any::<f64>()) {
        let mut state = initial();
        let before = state.clone();
        let pane = pid(20);
        let result = state.split_pane(
            wid(1),
            pid(10),
            pane,
            sid(1_000),
            Axis::Horizontal,
            ratio,
            SplitPlacement::After,
            SplitContent::NewTerminal(tab(200, pane)),
            Timestamp(1),
        );
        if ratio.is_finite() {
            prop_assert!(result.is_ok());
            assert_strong_invariants(&state);
            assert_persistent_round_trip(&state);
        } else {
            prop_assert!(result.is_err());
            prop_assert_eq!(state, before);
        }
    }
}

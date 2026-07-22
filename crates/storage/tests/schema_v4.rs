#![allow(deprecated)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, Axis, Pane, PaneId, PaneNode, ShortcutPlatform, SplitId, Tab, TabId,
    TerminalLaunchSpec, Timestamp, Workspace, WorkspaceId,
};
use agent_workspace_storage::{MigrationOutcome, SCHEMA_VERSION, SqliteStateStore, StorageError};
use rusqlite::{Connection, params};
use tempfile::TempDir;

fn workspace(pane_count: usize, tab_count: usize) -> Workspace {
    assert!(pane_count > 0 && tab_count >= pane_count);
    let workspace_id = WorkspaceId::new();
    let pane_ids: Vec<_> = (0..pane_count).map(|_| PaneId::new()).collect();
    let mut panes = BTreeMap::new();
    let mut tabs = BTreeMap::new();
    let mut remaining_tabs = tab_count;
    for (index, pane_id) in pane_ids.iter().copied().enumerate() {
        let count = if index == 0 {
            tab_count - (pane_count - 1)
        } else {
            1
        };
        remaining_tabs -= count;
        let ids: Vec<_> = (0..count).map(|_| TabId::new()).collect();
        let mut pane = Pane::new(pane_id, ids[0]);
        pane.tabs.clone_from(&ids);
        for id in ids {
            tabs.insert(
                id,
                Tab::terminal(
                    id,
                    pane_id,
                    "Terminal",
                    TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
                    None,
                    Timestamp(1),
                )
                .unwrap(),
            );
        }
        panes.insert(pane_id, pane);
    }
    assert_eq!(remaining_tabs, 0);
    let layout = pane_ids
        .iter()
        .copied()
        .map(|pane_id| PaneNode::Leaf { pane_id })
        .reduce(|first, second| PaneNode::Split {
            split_id: SplitId::new(),
            axis: Axis::Horizontal,
            ratio: 0.5,
            first: Box::new(first),
            second: Box::new(second),
        })
        .unwrap();
    Workspace {
        id: workspace_id,
        name: "legacy".to_owned(),
        description: None,
        color: None,
        working_directory: PathBuf::from("/tmp"),
        layout,
        selected_pane_id: pane_ids[0],
        panes,
        tabs,
        created_at: Timestamp(1),
        updated_at: Timestamp(1),
    }
}

fn legacy_payload(workspaces: Vec<Workspace>) -> String {
    let mut state = ApplicationState::new(workspace(1, 1)).unwrap();
    state.workspaces = workspaces;
    state.selected_workspace_id = state.workspaces[0].id;
    let mut value = serde_json::to_value(state).unwrap();
    let object = value.as_object_mut().unwrap();
    for field in [
        "workspaceSelection",
        "workspacePins",
        "workspaceGroups",
        "workspaceGroupAssignments",
        "savedLayouts",
        "legacyOverLimit",
    ] {
        object.remove(field);
    }
    serde_json::to_string(&value).unwrap()
}

fn write_v3(path: &std::path::Path, payload: &str) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE application_snapshot (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),
               json_payload TEXT NOT NULL,
               saved_at_ms INTEGER NOT NULL
             );
             CREATE TABLE window_state (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),
               json_payload TEXT NOT NULL,
               saved_at_ms INTEGER NOT NULL
             );
             CREATE TABLE idempotency_results (
               sequence INTEGER PRIMARY KEY AUTOINCREMENT,
               namespace TEXT NOT NULL,
               idempotency_key TEXT NOT NULL,
               request_json TEXT NOT NULL,
               result_json TEXT NOT NULL,
               completed_at_ms INTEGER NOT NULL,
               UNIQUE(namespace, idempotency_key)
             );
             PRAGMA user_version = 3;",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO application_snapshot VALUES (1, '0', ?1, 1)",
            params![payload],
        )
        .unwrap();
}

fn raw_payload(path: &std::path::Path) -> String {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT json_payload FROM application_snapshot WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn every_legacy_count_dimension_migrates_and_v5_materializes_topology() {
    let cases = [
        ("workspaces", (0..129).map(|_| workspace(1, 1)).collect()),
        ("panes_per_workspace", vec![workspace(65, 65)]),
        ("tabs_per_workspace", vec![workspace(1, 129)]),
        ("total_panes", (0..17).map(|_| workspace(61, 61)).collect()),
        ("total_tabs", (0..17).map(|_| workspace(1, 121)).collect()),
    ];
    for (name, workspaces) in cases {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(format!("{name}.sqlite3"));
        let payload = legacy_payload(workspaces);
        write_v3(&path, &payload);
        let (store, outcome) =
            SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
        let MigrationOutcome::Upgraded {
            from: 3,
            to: SCHEMA_VERSION,
            backup_path,
        } = outcome
        else {
            panic!("expected v3 upgrade for {name}");
        };
        let migrated_payload = raw_payload(&path);
        assert_ne!(
            migrated_payload, payload,
            "v5 topology was not materialized for {name}"
        );
        let migrated_json: serde_json::Value = serde_json::from_str(&migrated_payload).unwrap();
        assert_eq!(
            migrated_json["windowPlacements"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            raw_payload(&backup_path),
            payload,
            "backup changed for {name}"
        );
        let mut loaded = store.load().unwrap().unwrap();
        assert!(
            loaded.legacy_over_limit.is_some(),
            "missing mode for {name}"
        );
        assert_eq!(
            loaded.workspace_selection,
            vec![loaded.selected_workspace_id]
        );
        while loaded.legacy_over_limit.is_some() {
            match name {
                "workspaces" => {
                    let id = loaded.workspaces[0].id;
                    loaded.close_workspace(id, None).unwrap();
                }
                "panes_per_workspace" | "total_panes" => {
                    let workspace = loaded
                        .workspaces
                        .iter()
                        .find(|workspace| workspace.panes.len() > 1)
                        .unwrap();
                    let workspace_id = workspace.id;
                    let pane_id = *workspace.panes.keys().next_back().unwrap();
                    loaded
                        .close_pane(workspace_id, pane_id, None, Timestamp(2))
                        .unwrap();
                }
                "tabs_per_workspace" | "total_tabs" => {
                    let workspace = loaded
                        .workspaces
                        .iter()
                        .find(|workspace| workspace.tabs.len() > 1)
                        .unwrap();
                    let workspace_id = workspace.id;
                    let tab_id = *workspace.tabs.keys().next_back().unwrap();
                    loaded
                        .close_tab(workspace_id, tab_id, None, Timestamp(2))
                        .unwrap();
                }
                _ => unreachable!(),
            }
        }
        loaded.validate().unwrap();
    }
}

#[test]
fn reduction_mode_clears_atomically_and_cannot_be_reentered() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("reduce.sqlite3");
    let payload = legacy_payload((0..129).map(|_| workspace(1, 1)).collect());
    write_v3(&path, &payload);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let mut state = store.load().unwrap().unwrap();
    let removed = state.workspaces[0].id;
    state.close_workspace(removed, None).unwrap();
    assert!(state.legacy_over_limit.is_none());
    store.save(&state).unwrap();
    assert!(store.load().unwrap().unwrap().legacy_over_limit.is_none());
    drop(store);
    let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert!(
        reopened
            .load()
            .unwrap()
            .unwrap()
            .legacy_over_limit
            .is_none()
    );
    let marker: u8 = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT legacy_snapshot_compatibility FROM migration_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, 0);
}

#[test]
fn schema_v4_missing_or_null_reduction_metadata_cannot_reenter_mode() {
    for explicit_null in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(format!("reject-{explicit_null}.sqlite3"));
        let payload = legacy_payload((0..129).map(|_| workspace(1, 1)).collect());
        write_v3(&path, &payload);
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        drop(store);
        let payload = if explicit_null {
            let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
            value["legacyOverLimit"] = serde_json::Value::Null;
            serde_json::to_string(&value).unwrap()
        } else {
            payload
        };
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE migration_metadata SET legacy_snapshot_compatibility = 0 WHERE singleton = 1",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
                params![payload],
            )
            .unwrap();
        drop(connection);
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        assert!(matches!(
            store.load(),
            Err(StorageError::InvalidSnapshot { .. })
        ));
    }
}

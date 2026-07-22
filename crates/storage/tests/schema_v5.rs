use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, PaneId, ShortcutPlatform, Tab, TabId, TerminalLaunchSpec, Timestamp,
    WindowId, Workspace, WorkspaceId,
};
use agent_workspace_storage::{
    EpochIdempotencyLookup, EpochIdempotencySaveRequest, SCHEMA_VERSION, SqliteStateStore,
    StorageError, WindowState,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;
use uuid::Uuid;

fn v4_payload(application: &ApplicationState) -> String {
    let mut value = serde_json::to_value(application).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("windowPlacements");
    object.remove("focusedWindowId");
    serde_json::to_string(&value).unwrap()
}

fn write_v4(path: &std::path::Path, application: &ApplicationState, state: &WindowState) {
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
             CREATE TABLE migration_metadata (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               source_version INTEGER NOT NULL,
               target_version INTEGER NOT NULL,
               backup_path TEXT,
               legacy_snapshot_compatibility INTEGER NOT NULL CHECK (legacy_snapshot_compatibility IN (0, 1)),
               migrated_at_ms INTEGER NOT NULL
             );
             INSERT INTO migration_metadata VALUES (1, 4, 4, NULL, 0, 1);
             PRAGMA user_version = 4;",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO application_snapshot VALUES (1, ?1, ?2, 1)",
            params![application.revision.to_string(), v4_payload(application)],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO window_state VALUES (1, ?1, ?2, 1)",
            params![
                state.revision.to_string(),
                serde_json::to_string(state).unwrap()
            ],
        )
        .unwrap();
}

fn state() -> ApplicationState {
    let workspace_id = WorkspaceId::from_uuid(Uuid::from_u128(1));
    let pane_id = PaneId::from_uuid(Uuid::from_u128(10));
    let tab = Tab::terminal(
        TabId::from_uuid(Uuid::from_u128(100)),
        pane_id,
        "terminal",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(1),
    )
    .unwrap();
    ApplicationState::new(
        Workspace::new(
            workspace_id,
            "workspace",
            PathBuf::from("/tmp"),
            pane_id,
            tab,
            Timestamp(1),
            Timestamp(1),
        )
        .unwrap(),
    )
    .unwrap()
}

fn bounds(revision: u64) -> WindowState {
    WindowState {
        revision,
        x: 10,
        y: 20,
        width: 800,
        height: 600,
        maximized: false,
        fullscreen: false,
        display_identifier: None,
    }
}

#[test]
fn scoped_bounds_require_authoritative_placement_and_are_pruned_with_snapshot() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let application = state();
    let owned = application.focused_window_id;
    assert!(matches!(
        store.save_window_state_for(owned, &bounds(1)),
        Err(StorageError::UnknownWindowPlacement { .. })
    ));
    store.save(&application).unwrap();
    store.save_window_state_for(owned, &bounds(1)).unwrap();
    assert_eq!(store.load_window_state_for(owned).unwrap(), Some(bounds(1)));

    let mut changed = application.clone();
    let workspace = changed.workspaces[0].id;
    let replacement_window = WindowId::new();
    changed
        .create_window_placement(replacement_window, "replacement", workspace)
        .unwrap();
    store.save(&changed).unwrap();
    assert_eq!(store.load_window_state_for(owned).unwrap(), None);
    assert!(matches!(
        store.save_window_state_for(owned, &bounds(2)),
        Err(StorageError::UnknownWindowPlacement { .. })
    ));
}

#[test]
fn v4_singleton_bounds_migrate_to_initial_window_and_reopen_idempotently() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let application = state();
    let legacy_bounds = bounds(7);
    write_v4(&path, &application, &legacy_bounds);

    let (store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert!(matches!(
        outcome,
        agent_workspace_storage::MigrationOutcome::Upgraded {
            from: 4,
            to: SCHEMA_VERSION,
            ..
        }
    ));
    let migrated = store.load().unwrap().unwrap();
    let migrated_window_id = migrated.focused_window_id;
    assert_eq!(
        store.load_window_state_for(migrated_window_id).unwrap(),
        Some(legacy_bounds.clone())
    );
    drop(store);

    let (reopened, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert_eq!(
        outcome,
        agent_workspace_storage::MigrationOutcome::Current {
            version: SCHEMA_VERSION
        }
    );
    assert_eq!(
        reopened.load_window_state_for(migrated_window_id).unwrap(),
        Some(legacy_bounds)
    );
}

#[test]
fn failed_v4_to_v5_migration_rolls_back_singleton_bounds_and_schema() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let application = state();
    let legacy_bounds = bounds(11);
    write_v4(&path, &application, &legacy_bounds);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE idempotency_epoch (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               epoch TEXT NOT NULL CHECK (length(epoch) = 36),
               issued_at_ms INTEGER NOT NULL
             );",
        )
        .unwrap();

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::Migration { from: 4, to: 5, .. })
    ));
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
    let schema: String = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'window_state'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(schema.contains("singleton"));
    let (revision, payload): (String, String) = connection
        .query_row(
            "SELECT revision, json_payload FROM window_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(revision, "11");
    assert_eq!(
        serde_json::from_str::<WindowState>(&payload).unwrap(),
        legacy_bounds
    );
}

#[test]
fn epoch_results_become_tombstones_and_rotation_never_reexecutes_old_epoch() {
    let temp = TempDir::new().unwrap();
    let store = SqliteStateStore::open(
        temp.path().join("state.sqlite3"),
        ShortcutPlatform::NonMacOs,
    )
    .unwrap();
    let application = state();
    store.save(&application).unwrap();
    let epoch = store.current_idempotency_epoch().unwrap();
    let first_key = Uuid::new_v4();
    let request = |key, hash: &str, result: &str| EpochIdempotencySaveRequest {
        namespace: "multi-window-v1".to_owned(),
        epoch,
        idempotency_key: key,
        request_hash: hash.to_owned(),
        result_json: result.to_owned(),
        retention_capacity: 1,
    };
    let hash_a = "a".repeat(64);
    let hash_b = "b".repeat(64);
    assert_eq!(
        store
            .save_with_epoch_idempotency(&application, &request(first_key, &hash_a, "{\"one\":1}"))
            .unwrap(),
        EpochIdempotencyLookup::Replay("{\"one\":1}".to_owned())
    );
    assert_eq!(
        store
            .load_epoch_idempotency_result("multi-window-v1", epoch, first_key, &hash_b)
            .unwrap(),
        EpochIdempotencyLookup::Conflict
    );
    let second_key = Uuid::new_v4();
    store
        .save_with_epoch_idempotency(&application, &request(second_key, &hash_b, "{\"two\":2}"))
        .unwrap();
    assert_eq!(
        store
            .load_epoch_idempotency_result("multi-window-v1", epoch, first_key, &hash_a)
            .unwrap(),
        EpochIdempotencyLookup::ResultExpired
    );
    store.rotate_idempotency_epoch().unwrap();
    assert_eq!(
        store
            .load_epoch_idempotency_result("multi-window-v1", epoch, second_key, &hash_b)
            .unwrap(),
        EpochIdempotencyLookup::EpochExpired
    );
}

#[test]
fn schema_v5_missing_topology_is_corruption_not_an_implicit_migration() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state()).unwrap();
    let connection = Connection::open(&path).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT json_payload FROM application_snapshot WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
    value.as_object_mut().unwrap().remove("windowPlacements");
    connection
        .execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            params![serde_json::to_string(&value).unwrap()],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        store.load(),
        Err(StorageError::InvalidSnapshot { .. })
    ));
}

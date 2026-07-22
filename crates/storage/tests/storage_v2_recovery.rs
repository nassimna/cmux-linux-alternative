use std::path::{Path, PathBuf};

use agent_workspace_core::{
    ApplicationState, MAX_SAFE_INTEGER, PaneId, ShortcutPlatform, Tab, TabId, TerminalLaunchSpec,
    Timestamp, Workspace, WorkspaceId,
};
use agent_workspace_storage::{
    MAX_DISPLAY_IDENTIFIER_CHARS, MigrationOutcome, RecoveryClassification, RecoveryExportMode,
    SCHEMA_VERSION, SqliteStateStore, StorageError, WindowState,
};
use rusqlite::{Connection, OptionalExtension, params};
use tempfile::TempDir;
use uuid::Uuid;

fn workspace_id(value: u128) -> WorkspaceId {
    WorkspaceId::from_uuid(Uuid::from_u128(value))
}

fn pane_id(value: u128) -> PaneId {
    PaneId::from_uuid(Uuid::from_u128(value))
}

fn tab_id(value: u128) -> TabId {
    TabId::from_uuid(Uuid::from_u128(value))
}

fn state() -> ApplicationState {
    let pane = pane_id(10);
    let tab = Tab::terminal(
        tab_id(100),
        pane,
        "shell",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(1),
    )
    .unwrap();
    ApplicationState::new(
        Workspace::new(
            workspace_id(1),
            "workspace",
            PathBuf::from("/tmp"),
            pane,
            tab,
            Timestamp(1),
            Timestamp(1),
        )
        .unwrap(),
    )
    .unwrap()
}

fn window_state(revision: u64) -> WindowState {
    WindowState {
        revision,
        x: -1_920,
        y: 25,
        width: 1_440,
        height: 900,
        maximized: false,
        fullscreen: false,
        display_identifier: Some("display-primary".to_owned()),
    }
}

fn create_v1(path: &Path, snapshot: &ApplicationState) -> String {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let payload = serde_json::to_string(snapshot).unwrap();
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE application_snapshot (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),
               json_payload TEXT NOT NULL,
               saved_at_ms INTEGER NOT NULL
             );
             PRAGMA user_version = 1;",
        )
        .unwrap();
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO application_snapshot
               (singleton, revision, json_payload, saved_at_ms)
             VALUES (1, ?1, ?2, 123)",
            params![snapshot.revision.to_string(), payload],
        )
        .unwrap();
    payload
}

fn raw_snapshot(path: &Path) -> (String, String, i64) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT revision, json_payload, saved_at_ms
             FROM application_snapshot WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

#[test]
fn v1_snapshot_migrates_without_loss_and_reports_secured_backup() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("private/state.sqlite3");
    let snapshot = state();
    let payload = create_v1(&path, &snapshot);
    let legacy_row = raw_snapshot(&path);

    let (store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    let MigrationOutcome::Upgraded {
        from: 1,
        to: SCHEMA_VERSION,
        backup_path,
    } = outcome
    else {
        panic!("expected a backed-up v1 to v4 upgrade");
    };

    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.load().unwrap(), Some(snapshot));
    assert_eq!(raw_snapshot(&path), legacy_row);
    assert_eq!(raw_snapshot(&backup_path), legacy_row);
    assert_eq!(raw_snapshot(&backup_path).1, payload);
    let backup = Connection::open(&backup_path).unwrap();
    let backup_version: u32 = backup
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(backup_version, 1);
    assert!(backup_path.parent() == path.parent());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        assert_eq!(
            std::fs::metadata(backup_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    drop(store);
    let (_store, reopened) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert_eq!(
        reopened,
        MigrationOutcome::Current {
            version: SCHEMA_VERSION
        }
    );
}

#[test]
fn failed_v1_to_v2_migration_rolls_back_bytes_and_keeps_backup() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("private/state.sqlite3");
    let snapshot = state();
    create_v1(&path, &snapshot);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE window_state (sentinel TEXT NOT NULL);
             INSERT INTO window_state VALUES ('keep-me');",
        )
        .unwrap();
    let bytes_before = std::fs::read(&path).unwrap();
    let row_before = raw_snapshot(&path);

    let Err(error) = SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs) else {
        panic!("injected migration conflict should fail");
    };
    let retained_backup_path = match &error {
        StorageError::Migration {
            from: 1,
            to: 2,
            backup_path: Some(backup_path),
            ..
        } => backup_path.clone(),
        _ => panic!("migration failure must retain its secured backup path"),
    };
    assert!(matches!(
        RecoveryClassification::from_storage_error(&error),
        RecoveryClassification::MigrationFailure { from: 1, to: 2, .. }
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
    assert_eq!(raw_snapshot(&path), row_before);
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let sentinel: String = connection
        .query_row("SELECT sentinel FROM window_state", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    assert_eq!(sentinel, "keep-me");

    let backup_path = PathBuf::from(format!(
        "{}.pre-v1-to-v{SCHEMA_VERSION}.backup",
        path.display()
    ));
    assert_eq!(retained_backup_path, backup_path);
    assert!(backup_path.exists());
    assert_eq!(raw_snapshot(&backup_path), row_before);
    let backup_window_table: Option<String> = Connection::open(&backup_path)
        .unwrap()
        .query_row(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'window_state'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(backup_window_table.as_deref(), Some("window_state"));
}

#[test]
fn window_state_round_trip_revisions_conflicts_and_geometry_validation() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert_eq!(store.load_window_state().unwrap(), None);

    let durable = window_state(5);
    store.save_window_state(&durable).unwrap();
    assert_eq!(store.load_window_state().unwrap(), Some(durable.clone()));
    store.save_window_state(&durable).unwrap();

    let mut stale = durable.clone();
    stale.revision = 4;
    assert!(matches!(
        store.save_window_state(&stale),
        Err(StorageError::StaleWindowStateRevision {
            stored: 5,
            attempted: 4
        })
    ));
    let mut conflict = durable.clone();
    conflict.width += 1;
    assert!(matches!(
        store.save_window_state(&conflict),
        Err(StorageError::WindowStateRevisionConflict { revision: 5 })
    ));
    for invalid in [
        WindowState {
            width: 0,
            revision: 6,
            ..durable.clone()
        },
        WindowState {
            height: 100_001,
            revision: 6,
            ..durable.clone()
        },
        WindowState {
            x: i64::MAX,
            revision: 6,
            ..durable.clone()
        },
        WindowState {
            display_identifier: Some("x".repeat(MAX_DISPLAY_IDENTIFIER_CHARS + 1)),
            revision: 6,
            ..durable.clone()
        },
        WindowState {
            revision: MAX_SAFE_INTEGER + 1,
            ..durable.clone()
        },
    ] {
        assert!(matches!(
            store.save_window_state(&invalid),
            Err(StorageError::InvalidWindowState { .. })
        ));
    }
    assert_eq!(store.load_window_state().unwrap(), Some(durable));
}

#[test]
fn strict_window_json_and_snapshot_recovery_classification_are_non_mutating() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state()).unwrap();
    store.save_window_state(&window_state(1)).unwrap();
    let connection = Connection::open(&path).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT json_payload FROM window_state ORDER BY window_id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
    value["unknownField"] = serde_json::json!(true);
    connection
        .execute(
            "UPDATE window_state SET json_payload = ?1 WHERE window_id = (SELECT window_id FROM window_state ORDER BY window_id LIMIT 1)",
            [serde_json::to_string(&value).unwrap()],
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();

    assert!(matches!(
        store.load_window_state(),
        Err(StorageError::MalformedWindowState { .. })
    ));
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&path, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::MalformedWindowState { revision, .. } if revision == "1"
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn recovery_inspection_validates_every_per_window_bounds_row() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state()).unwrap();
    store.save_window_state(&window_state(1)).unwrap();
    let later_window_id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO window_state (window_id, revision, json_payload, saved_at_ms)
             VALUES (?1, '2', '{not-json', 2)",
            [later_window_id],
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();

    assert!(matches!(
        SqliteStateStore::inspect_recovery(&path, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::MalformedWindowState { revision, .. } if revision == "2"
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn recovery_inspection_distinguishes_malformed_and_invalid_application_snapshots() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE application_snapshot SET json_payload = '{not-json' WHERE singleton = 1",
            [],
        )
        .unwrap();
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&path, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::MalformedSnapshot { revision, .. } if revision == "0"
    ));

    let mut invalid = state();
    invalid.selected_workspace_id = workspace_id(999);
    connection
        .execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&invalid).unwrap()],
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&path, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::InvalidSnapshot { revision, .. } if revision == "0"
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn future_and_corrupt_databases_have_read_only_recovery_classifications() {
    let temp = TempDir::new().unwrap();
    let future = temp.path().join("future.sqlite3");
    Connection::open(&future)
        .unwrap()
        .execute_batch("CREATE TABLE keep(value TEXT); PRAGMA user_version = 99;")
        .unwrap();
    let future_before = std::fs::read(&future).unwrap();
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&future, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::FutureSchema {
            found: 99,
            supported: SCHEMA_VERSION
        }
    ));
    assert_eq!(std::fs::read(&future).unwrap(), future_before);

    let corrupt_schema = temp.path().join("corrupt-schema.sqlite3");
    Connection::open(&corrupt_schema)
        .unwrap()
        .execute_batch("CREATE TABLE unrelated(value TEXT); PRAGMA user_version = 2;")
        .unwrap();
    let schema_before = std::fs::read(&corrupt_schema).unwrap();
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&corrupt_schema, ShortcutPlatform::NonMacOs)
            .classification,
        RecoveryClassification::CorruptSchema { .. }
    ));
    assert_eq!(std::fs::read(&corrupt_schema).unwrap(), schema_before);

    let corrupt = temp.path().join("corrupt.sqlite3");
    let corrupt_bytes = b"not a sqlite database";
    std::fs::write(&corrupt, corrupt_bytes).unwrap();
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&corrupt, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::CorruptSqlite { .. }
    ));
    assert_eq!(std::fs::read(&corrupt).unwrap(), corrupt_bytes);
}

#[test]
fn recovery_export_is_wal_consistent_readable_and_preserves_source() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source/state.sqlite3");
    let destination = temp.path().join("exports/recovery.sqlite3");
    let store = SqliteStateStore::open(&source, ShortcutPlatform::NonMacOs).unwrap();
    let mut snapshot = state();
    snapshot.revision = 7;
    store.save(&snapshot).unwrap();
    store.save_window_state(&window_state(9)).unwrap();
    let source_bytes = std::fs::read(&source).unwrap();
    let source_row = raw_snapshot(&source);

    let report = SqliteStateStore::export_recovery_copy(
        &source,
        &destination,
        RecoveryExportMode::CreateNew,
    )
    .unwrap();
    assert_eq!(report.destination, destination);
    assert!(!report.replaced_existing);
    assert_eq!(raw_snapshot(&destination), source_row);
    let copied_window_revision: String = Connection::open(&destination)
        .unwrap()
        .query_row(
            "SELECT revision FROM window_state ORDER BY window_id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(copied_window_revision, "9");
    assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
    assert_eq!(store.load().unwrap().unwrap().revision, 7);
    assert_eq!(store.load_window_state().unwrap().unwrap().revision, 9);

    assert!(matches!(
        SqliteStateStore::export_recovery_copy(
            &source,
            &destination,
            RecoveryExportMode::CreateNew
        ),
        Err(StorageError::RecoveryExport { .. })
    ));
    assert_eq!(raw_snapshot(&destination), source_row);

    let replacement = temp.path().join("exports/replacement.sqlite3");
    std::fs::write(&replacement, b"safe regular file to replace").unwrap();
    let report = SqliteStateStore::export_recovery_copy(
        &source,
        &replacement,
        RecoveryExportMode::ReplaceExisting,
    )
    .unwrap();
    assert!(report.replaced_existing);
    assert_eq!(raw_snapshot(&replacement), source_row);
    assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
}

#[test]
fn recovery_export_preserves_corrupt_main_bytes_and_create_new_destination() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("corrupt.sqlite3");
    let corrupt_bytes = b"not a sqlite database\0with raw recovery evidence";
    std::fs::write(&source, corrupt_bytes).unwrap();
    let source_before = std::fs::read(&source).unwrap();

    let destination = temp.path().join("exports/recovery.sqlite3");
    let report = SqliteStateStore::export_recovery_copy(
        &source,
        &destination,
        RecoveryExportMode::CreateNew,
    )
    .unwrap();
    assert_eq!(report.destination, destination);
    assert!(!report.replaced_existing);
    assert_eq!(std::fs::read(&destination).unwrap(), corrupt_bytes);
    assert_eq!(std::fs::read(&source).unwrap(), source_before);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let existing = temp.path().join("exports/existing.sqlite3");
    let sentinel = b"existing destination must remain byte-for-byte untouched";
    std::fs::write(&existing, sentinel).unwrap();
    assert!(matches!(
        SqliteStateStore::export_recovery_copy(&source, &existing, RecoveryExportMode::CreateNew),
        Err(StorageError::RecoveryExport { .. })
    ));
    assert_eq!(std::fs::read(&existing).unwrap(), sentinel);
    assert_eq!(std::fs::read(&source).unwrap(), source_before);
}

#[test]
fn recovery_export_atomically_replaces_safe_destination_with_corrupt_main_bytes() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("corrupt.sqlite3");
    let corrupt_bytes = b"unreadable SQLite bytes retained for recovery";
    std::fs::write(&source, corrupt_bytes).unwrap();
    let source_before = std::fs::read(&source).unwrap();
    let destination = temp.path().join("recovery.sqlite3");
    std::fs::write(&destination, b"replace this safe regular file").unwrap();

    let report = SqliteStateStore::export_recovery_copy(
        &source,
        &destination,
        RecoveryExportMode::ReplaceExisting,
    )
    .unwrap();
    assert!(report.replaced_existing);
    assert_eq!(std::fs::read(&destination).unwrap(), corrupt_bytes);
    assert_eq!(std::fs::read(&source).unwrap(), source_before);
    assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".recovery-export.tmp")
    }));
}

#[cfg(unix)]
#[test]
fn recovery_export_is_owner_only_and_rejects_symlink_and_hard_link_destinations() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source.sqlite3");
    let store = SqliteStateStore::open(&source, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state()).unwrap();

    let exported = temp.path().join("exported.sqlite3");
    SqliteStateStore::export_recovery_copy(&source, &exported, RecoveryExportMode::CreateNew)
        .unwrap();
    assert_eq!(
        std::fs::metadata(&exported).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let target = temp.path().join("target.sqlite3");
    let sentinel = b"never replace me";
    std::fs::write(&target, sentinel).unwrap();
    let linked = temp.path().join("linked.sqlite3");
    symlink(&target, &linked).unwrap();
    assert!(matches!(
        SqliteStateStore::export_recovery_copy(
            &source,
            &linked,
            RecoveryExportMode::ReplaceExisting
        ),
        Err(StorageError::RecoveryExport { .. })
    ));
    assert_eq!(std::fs::read(&target).unwrap(), sentinel);

    let hard_link = temp.path().join("hard-linked.sqlite3");
    std::fs::hard_link(&target, &hard_link).unwrap();
    assert!(matches!(
        SqliteStateStore::export_recovery_copy(
            &source,
            &hard_link,
            RecoveryExportMode::ReplaceExisting
        ),
        Err(StorageError::RecoveryExport { .. })
    ));
    assert_eq!(std::fs::read(&target).unwrap(), sentinel);

    let corrupt_source_target = temp.path().join("corrupt-source-target.sqlite3");
    let corrupt_source_bytes = b"source symlink target must never be exported or touched";
    std::fs::write(&corrupt_source_target, corrupt_source_bytes).unwrap();
    let corrupt_source_link = temp.path().join("corrupt-source-link.sqlite3");
    symlink(&corrupt_source_target, &corrupt_source_link).unwrap();
    let rejected_destination = temp.path().join("source-link-export.sqlite3");
    assert!(matches!(
        SqliteStateStore::export_recovery_copy(
            &corrupt_source_link,
            &rejected_destination,
            RecoveryExportMode::CreateNew
        ),
        Err(StorageError::RecoveryExport { .. })
    ));
    assert_eq!(
        std::fs::read(&corrupt_source_target).unwrap(),
        corrupt_source_bytes
    );
    assert!(!rejected_destination.exists());
}

#[cfg(unix)]
#[test]
fn recovery_inspection_rejects_symlink_without_touching_target() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let target = temp.path().join("target.sqlite3");
    let bytes = b"target sentinel";
    std::fs::write(&target, bytes).unwrap();
    let linked = temp.path().join("linked.sqlite3");
    symlink(&target, &linked).unwrap();
    assert!(matches!(
        SqliteStateStore::inspect_recovery(&linked, ShortcutPlatform::NonMacOs).classification,
        RecoveryClassification::PermissionOrPath { .. }
    ));
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

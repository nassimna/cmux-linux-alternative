use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;
use std::time::Duration;

use agent_workspace_core::{
    ApplicationState, BrowserMetadata, CommandId, DomainError, LogicalShortcut, MAX_SAFE_INTEGER,
    PaneId, RuntimeSessionId, ShortcutPlatform, Tab, TabId, TerminalLaunchSpec, Timestamp,
    Workspace, WorkspaceId,
};
use agent_workspace_storage::{SCHEMA_VERSION, SqliteStateStore, StorageError};
use rusqlite::{Connection, TransactionBehavior, params};
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

fn state_with_runtime_session() -> ApplicationState {
    let pane_id = pane_id(10);
    let tab = Tab::terminal(
        tab_id(100),
        pane_id,
        "shell",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        Some(RuntimeSessionId::new("runtime-100")),
        Timestamp(1),
    )
    .unwrap();
    ApplicationState::new(
        Workspace::new(
            workspace_id(1),
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

fn database_path(temp: &TempDir) -> PathBuf {
    temp.path().join("private").join("state.sqlite3")
}

fn raw_snapshot(path: &Path) -> (String, String) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT revision, json_payload FROM application_snapshot WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn raw_saved_at(path: &Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT saved_at_ms FROM application_snapshot WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn create_version_one_database(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
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
}

#[test]
fn new_store_is_empty_and_reports_schema_version() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();

    assert_eq!(store.load().unwrap(), None);
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(SqliteStateStore::supported_schema_version(), SCHEMA_VERSION);
    assert_eq!(store.path(), path);
}

#[test]
fn save_load_and_reopen_preserve_state_but_omit_sensitive_runtime_data() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let original = state_with_runtime_session();
    {
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        store.save(&original).unwrap();
        let loaded = store.load().unwrap().unwrap();

        let mut expected = original.clone();
        expected.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content
            .set_runtime_session_id(None);
        assert_eq!(loaded, expected);
        assert_eq!(
            loaded.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id(),
            None
        );
        let raw_payload = raw_snapshot(&path).1;
        assert!(!raw_payload.contains("runtime-100"));
        assert!(!raw_payload.contains("command"));
    }

    let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert_eq!(
        reopened.load().unwrap().unwrap().revision,
        original.revision
    );
}

#[test]
fn a_later_save_atomically_replaces_revision_and_payload_at_max_safe_integer() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let first = state_with_runtime_session();
    store.save(&first).unwrap();

    let mut second = first;
    second.revision = MAX_SAFE_INTEGER;
    second.workspaces[0].name = "updated".into();
    store.save(&second).unwrap();

    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.revision, MAX_SAFE_INTEGER);
    assert_eq!(loaded.workspaces[0].name, "updated");
    assert_eq!(raw_snapshot(&path).0, MAX_SAFE_INTEGER.to_string());
}

#[test]
fn revision_above_max_safe_integer_is_rejected_without_overwrite() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let durable = state_with_runtime_session();
    store.save(&durable).unwrap();
    let before = raw_snapshot(&path);

    let mut invalid = durable;
    invalid.revision = u64::MAX;
    assert!(matches!(
        store.save(&invalid),
        Err(StorageError::InvalidState { .. })
    ));
    assert_eq!(raw_snapshot(&path), before);
}

#[test]
fn stale_and_divergent_same_revision_saves_do_not_replace_durable_state() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let mut durable = state_with_runtime_session();
    durable.revision = 5;
    durable.workspaces[0].name = "durable".into();
    store.save(&durable).unwrap();
    let before = raw_snapshot(&path);
    let saved_at_before = raw_saved_at(&path);

    let mut stale = durable.clone();
    stale.revision = 4;
    assert!(matches!(
        store.save(&stale),
        Err(StorageError::StaleRevision {
            stored: 5,
            attempted: 4
        })
    ));
    assert_eq!(raw_snapshot(&path), before);

    let mut divergent = durable.clone();
    divergent.workspaces[0].name = "different".into();
    assert!(matches!(
        store.save(&divergent),
        Err(StorageError::RevisionConflict { revision: 5 })
    ));
    assert_eq!(raw_snapshot(&path), before);

    store.save(&durable).unwrap();
    assert_eq!(raw_snapshot(&path), before);
    assert_eq!(raw_saved_at(&path), saved_at_before);
}

#[test]
fn storage_payload_never_contains_runtime_ids_commands_or_credential_urls() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let command_secret = "terminal-token-secret";
    assert!(matches!(
        TerminalLaunchSpec::new(
            PathBuf::from("/tmp"),
            Some(vec!["agent".into(), format!("--token={command_secret}")]),
            24,
            80,
        ),
        Err(DomainError::PersistentTerminalCommandUnsupported)
    ));
    let url_secret = "browser-password-secret";
    assert!(matches!(
        BrowserMetadata::new(format!("https://user:{url_secret}@example.test/private")),
        Err(DomainError::UnsafeBrowserUrl)
    ));

    store.save(&state_with_runtime_session()).unwrap();
    let payload = raw_snapshot(&path).1;
    for forbidden in ["runtime-100", "command", command_secret, url_secret] {
        assert!(!payload.contains(forbidden), "payload leaked `{forbidden}`");
    }
}

#[test]
fn invalid_in_memory_state_is_rejected_without_replacing_snapshot() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let valid = state_with_runtime_session();
    store.save(&valid).unwrap();
    let before = raw_snapshot(&path);

    let mut invalid = valid;
    invalid.selected_workspace_id = workspace_id(999);
    assert!(matches!(
        store.save(&invalid),
        Err(StorageError::InvalidState { .. })
    ));
    assert_eq!(raw_snapshot(&path), before);
}

#[test]
fn save_uses_the_configured_platform_for_shortcut_validation() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let mut state = state_with_runtime_session();
    state.shortcut_overrides.insert(
        CommandId::new("first").unwrap(),
        Some(LogicalShortcut::new("Primary+K").unwrap()),
    );
    state.shortcut_overrides.insert(
        CommandId::new("second").unwrap(),
        Some(LogicalShortcut::new("Control+K").unwrap()),
    );
    state
        .validate_for_platform(ShortcutPlatform::MacOs)
        .unwrap();

    assert!(matches!(
        store.save(&state),
        Err(StorageError::InvalidState { .. })
    ));
    assert_eq!(store.load().unwrap(), None);
}

#[test]
fn malformed_stored_json_is_rejected_without_mutation() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state_with_runtime_session()).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            ["{not-json"],
        )
        .unwrap();
    let before = raw_snapshot(&path);

    assert!(matches!(
        store.load(),
        Err(StorageError::MalformedSnapshot { .. })
    ));
    assert_eq!(raw_snapshot(&path), before);

    let mut replacement = state_with_runtime_session();
    replacement.revision = 1;
    assert!(matches!(
        store.save(&replacement),
        Err(StorageError::MalformedSnapshot { .. })
    ));
    assert_eq!(raw_snapshot(&path), before);
}

#[test]
fn revision_metadata_mismatch_is_rejected_and_preserved() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let durable = state_with_runtime_session();
    store.save(&durable).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE application_snapshot SET revision = '7' WHERE singleton = 1",
            [],
        )
        .unwrap();
    let before = raw_snapshot(&path);

    assert!(matches!(
        store.load(),
        Err(StorageError::RevisionMismatch { .. })
    ));
    let mut replacement = durable;
    replacement.revision = 8;
    assert!(matches!(
        store.save(&replacement),
        Err(StorageError::RevisionMismatch { .. })
    ));
    assert_eq!(raw_snapshot(&path), before);
}

#[test]
fn injected_command_or_credential_url_payloads_are_rejected_without_overwrite() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let durable = state_with_runtime_session();
    store.save(&durable).unwrap();

    let (_, payload) = raw_snapshot(&path);
    let mut command_payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    let tabs = command_payload["workspaces"][0]["tabs"]
        .as_object_mut()
        .unwrap();
    tabs.values_mut().next().unwrap()["content"]["launch"]["command"] =
        serde_json::json!(["agent", "--token=secret-value"]);
    let command_payload = serde_json::to_string(&command_payload).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            [&command_payload],
        )
        .unwrap();
    let command_row = raw_snapshot(&path);
    assert!(matches!(
        store.load(),
        Err(StorageError::MalformedSnapshot { .. })
    ));
    assert!(matches!(
        store.save(&durable),
        Err(StorageError::MalformedSnapshot { .. })
    ));
    assert_eq!(raw_snapshot(&path), command_row);

    let mut url_payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    let tabs = url_payload["workspaces"][0]["tabs"]
        .as_object_mut()
        .unwrap();
    tabs.values_mut().next().unwrap()["content"] = serde_json::json!({
        "kind": "browser",
        "metadata": {"url": "https://user:password@example.test/private"}
    });
    let url_payload = serde_json::to_string(&url_payload).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            [&url_payload],
        )
        .unwrap();
    let url_row = raw_snapshot(&path);
    assert!(matches!(
        store.load(),
        Err(StorageError::MalformedSnapshot { .. })
    ));
    assert!(matches!(
        store.save(&durable),
        Err(StorageError::MalformedSnapshot { .. })
    ));
    assert_eq!(raw_snapshot(&path), url_row);
}

#[test]
fn invalid_stored_snapshot_is_reported_as_an_invariant_failure() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let mut invalid = state_with_runtime_session();
    invalid.selected_workspace_id = workspace_id(999);
    let payload = serde_json::to_string(&invalid).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO application_snapshot (singleton, revision, json_payload, saved_at_ms)
             VALUES (1, ?1, ?2, 0)",
            params![invalid.revision.to_string(), payload],
        )
        .unwrap();
    let before = raw_snapshot(&path);

    assert!(matches!(
        store.load(),
        Err(StorageError::InvalidSnapshot { .. })
    ));
    let mut replacement = state_with_runtime_session();
    replacement.revision = 1;
    assert!(matches!(
        store.save(&replacement),
        Err(StorageError::InvalidSnapshot { .. })
    ));
    assert_eq!(raw_snapshot(&path), before);
}

#[test]
fn future_schema_is_rejected_without_downgrade_or_data_loss() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE future_data (value TEXT NOT NULL);
             INSERT INTO future_data VALUES ('keep-me');",
        )
        .unwrap();
    let future_version = SCHEMA_VERSION + 1;
    connection
        .pragma_update(None, "user_version", future_version)
        .unwrap();
    drop(connection);

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::FutureSchema { found, supported, .. })
            if found == future_version && supported == SCHEMA_VERSION
    ));
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let value: String = connection
        .query_row("SELECT value FROM future_data", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, future_version);
    assert_eq!(value, "keep-me");
}

#[test]
fn failed_migration_rolls_back_schema_version_and_preserves_existing_table() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE application_snapshot (sentinel TEXT NOT NULL);
             INSERT INTO application_snapshot VALUES ('keep-me');",
        )
        .unwrap();
    drop(connection);

    let Err(error) = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs) else {
        panic!("injected migration conflict should fail");
    };
    assert!(matches!(
        error,
        StorageError::Migration {
            from: 0,
            to: 1,
            backup_path: None,
            ..
        }
    ));
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let value: String = connection
        .query_row("SELECT sentinel FROM application_snapshot", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, 0);
    assert_eq!(value, "keep-me");
}

#[test]
fn version_one_without_required_table_is_rejected_without_mutation() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE legacy_data (value TEXT NOT NULL);
             INSERT INTO legacy_data VALUES ('keep-me');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    drop(connection);

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::CorruptSchema { .. })
    ));
    let connection = Connection::open(&path).unwrap();
    let value: String = connection
        .query_row("SELECT value FROM legacy_data", [], |row| row.get(0))
        .unwrap();
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(value, "keep-me");
    assert_eq!(journal_mode.to_ascii_lowercase(), "delete");
}

#[test]
fn version_one_with_wrong_constraints_is_rejected_without_mutation() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE application_snapshot (
               singleton INTEGER PRIMARY KEY,
               revision TEXT NOT NULL,
               json_payload TEXT NOT NULL,
               saved_at_ms INTEGER NOT NULL
             );
             INSERT INTO application_snapshot VALUES (9, 'legacy', 'keep-me', 17);
             PRAGMA user_version = 1;",
        )
        .unwrap();
    drop(connection);

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::CorruptSchema { .. })
    ));
    let connection = Connection::open(&path).unwrap();
    let row: (i64, String, String, i64) = connection
        .query_row(
            "SELECT singleton, revision, json_payload, saved_at_ms FROM application_snapshot",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(row, (9, "legacy".into(), "keep-me".into(), 17));
}

#[test]
fn corrupt_database_returns_a_typed_sqlite_error_without_resetting_file() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes = b"this is not a SQLite database";
    std::fs::write(&path, bytes).unwrap();

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::Database { .. })
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn busy_writer_waits_and_then_saves_after_the_other_transaction_commits() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let first = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    first.save(&state_with_runtime_session()).unwrap();
    let second = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();

    let mut blocker = Connection::open(&path).unwrap();
    let transaction = blocker
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let start = Arc::new(Barrier::new(2));
    let writer_start = Arc::clone(&start);
    let (attempted_tx, attempted_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let mut state = state_with_runtime_session();
        state.revision = 2;
        writer_start.wait();
        attempted_tx.send(()).unwrap();
        completed_tx.send(second.save(&state)).unwrap();
    });
    start.wait();
    attempted_rx.recv().unwrap();
    assert!(
        completed_rx
            .recv_timeout(Duration::from_millis(150))
            .is_err()
    );
    transaction.commit().unwrap();

    completed_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    writer.join().unwrap();
    assert_eq!(first.load().unwrap().unwrap().revision, 2);
}

#[test]
fn concurrent_writers_from_the_same_base_revision_have_one_winner() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let first = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let second = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let mut base = state_with_runtime_session();
    base.revision = 1;
    first.save(&base).unwrap();

    let start = Arc::new(Barrier::new(3));
    let (results_tx, results_rx) = mpsc::channel();
    let handles: Vec<_> = [(first, "first"), (second, "second")]
        .into_iter()
        .map(|(store, name)| {
            let start = Arc::clone(&start);
            let results_tx = results_tx.clone();
            let mut candidate = base.clone();
            candidate.revision = 2;
            candidate.workspaces[0].name = name.into();
            thread::spawn(move || {
                start.wait();
                results_tx.send((name, store.save(&candidate))).unwrap();
            })
        })
        .collect();
    drop(results_tx);
    start.wait();
    let results: Vec<_> = results_rx.iter().collect();
    for handle in handles {
        handle.join().unwrap();
    }

    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|(_, result)| matches!(
                result,
                Err(StorageError::RevisionConflict { revision: 2 })
            ))
            .count(),
        1
    );
    let winner = results
        .iter()
        .find_map(|(name, result)| result.is_ok().then_some(*name))
        .unwrap();
    let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let loaded = reopened.load().unwrap().unwrap();
    assert_eq!(loaded.revision, 2);
    assert_eq!(loaded.workspaces[0].name, winner);
}

#[cfg(unix)]
#[test]
fn unix_directory_database_and_sidecars_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent).unwrap();
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o777)).unwrap();

    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&state_with_runtime_session()).unwrap();
    assert_eq!(
        std::fs::metadata(parent).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for suffix in ["-wal", "-shm"] {
        let sidecar = sidecar_path(&path, suffix);
        assert!(
            sidecar.exists(),
            "expected `{}` to exist",
            sidecar.display()
        );
        assert_eq!(
            std::fs::metadata(sidecar).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn wal_full_synchronous_and_busy_wait_remain_effective_after_reopen() {
    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    {
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        store.save(&state_with_runtime_session()).unwrap();
    }
    let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let connection = Connection::open(&path).unwrap();
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let synchronous: u32 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    assert_eq!(synchronous, 2);
    assert_eq!(reopened.load().unwrap().unwrap().revision, 0);
}

#[cfg(unix)]
#[test]
fn database_symlink_is_rejected_without_touching_target() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let path = database_path(&temp);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let target = temp.path().join("database-target");
    let sentinel = b"do-not-touch-database-target";
    std::fs::write(&target, sentinel).unwrap();
    symlink(&target, &path).unwrap();

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::Permissions { .. })
    ));
    assert_eq!(std::fs::read(&target).unwrap(), sentinel);
    assert!(
        std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn parent_symlink_is_rejected_without_creating_database_in_target() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let real_parent = temp.path().join("real-parent");
    std::fs::create_dir(&real_parent).unwrap();
    let sentinel = real_parent.join("sentinel");
    std::fs::write(&sentinel, b"keep-parent").unwrap();
    let linked_parent = temp.path().join("linked-parent");
    symlink(&real_parent, &linked_parent).unwrap();
    let path = linked_parent.join("state.sqlite3");

    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::Permissions { .. })
    ));
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep-parent");
    assert!(!real_parent.join("state.sqlite3").exists());
}

#[cfg(unix)]
#[test]
fn preplaced_sidecar_symlinks_are_rejected_and_preserved() {
    use std::os::unix::fs::symlink;

    for suffix in ["-wal", "-shm"] {
        let temp = TempDir::new().unwrap();
        let path = database_path(&temp);
        create_version_one_database(&path);
        let target = temp.path().join(format!("target{}", &suffix[1..]));
        let sentinel = format!("keep-{suffix}");
        std::fs::write(&target, sentinel.as_bytes()).unwrap();
        let sidecar = sidecar_path(&path, suffix);
        symlink(&target, &sidecar).unwrap();

        assert!(matches!(
            SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
            Err(StorageError::Permissions { .. })
        ));
        assert_eq!(std::fs::read(&target).unwrap(), sentinel.as_bytes());
        assert!(
            std::fs::symlink_metadata(&sidecar)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}

#[cfg(unix)]
#[test]
fn permission_hardening_does_not_add_owner_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let directory = temp.path().join("safer");
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();

    // Whether opening succeeds can vary for privileged test users, but hardening must not turn the
    // pre-existing owner-write bit back on as a side effect.
    let path = directory.join("state.sqlite3");
    let _result = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs);
    assert_eq!(
        std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o500
    );
}

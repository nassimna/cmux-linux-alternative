use agent_workspace_core::ShortcutPlatform;
use agent_workspace_storage::{MigrationOutcome, SqliteStateStore, StorageError};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn v9_upgrade_is_backed_up_and_schema_is_privacy_minimized() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    drop(SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap());
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "DROP TABLE remote_sessions;
             DROP TABLE remote_targets;
             DROP TABLE sidebar_placements;
             DROP TABLE text_box_documents;
             DROP TABLE recently_closed_records;
             DROP TABLE task_metadata;
             UPDATE migration_metadata SET target_version = 9 WHERE singleton = 1;
             PRAGMA user_version = 9;",
        )
        .unwrap();

    let (store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    let MigrationOutcome::Upgraded {
        from,
        to,
        backup_path,
    } = outcome
    else {
        panic!("expected migration");
    };
    assert_eq!((from, to), (9, agent_workspace_storage::SCHEMA_VERSION));
    assert!(backup_path.exists());
    drop(store);

    let schema: String = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT group_concat(sql, ' ') FROM sqlite_schema WHERE name LIKE 'remote_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    for forbidden in [
        "private_key",
        "passphrase",
        "agent_socket",
        "proxy_command",
        "ssh_options",
        "remote_command",
    ] {
        assert!(
            !schema.to_lowercase().contains(forbidden),
            "schema leaked {forbidden}"
        );
    }
}

#[test]
fn malformed_uuid_is_classified_as_corruption_without_reset() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    drop(SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap());
    let connection = Connection::open(&path).unwrap();
    let digest = "a".repeat(64);
    connection.execute(
        "INSERT INTO remote_targets(remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
         VALUES(?1,'dev','example.com',22,'alice','untrusted',1,1,?2,?3,1,1)",
        rusqlite::params!["xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", digest],
    ).unwrap();
    drop(connection);
    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::CorruptSchema { .. })
    ));
    assert!(path.exists());
}

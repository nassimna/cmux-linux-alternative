use agent_workspace_core::ShortcutPlatform;
use agent_workspace_storage::{SCHEMA_VERSION, SqliteStateStore};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn schema_v14_migrates_to_bounded_task_security_tables() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("DROP TABLE task_action_outcomes", [])
        .unwrap();
    connection
        .execute("DROP TABLE task_confirmations", [])
        .unwrap();
    connection.pragma_update(None, "user_version", 14).unwrap();
    drop(connection);

    let (_store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert!(matches!(
        outcome,
        agent_workspace_storage::MigrationOutcome::Upgraded {
            from: 14,
            to: 15,
            ..
        }
    ));
    let connection = Connection::open(path).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    for table in ["task_confirmations", "task_action_outcomes"] {
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }
}

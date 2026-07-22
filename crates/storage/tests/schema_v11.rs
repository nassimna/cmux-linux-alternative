use agent_workspace_core::ShortcutPlatform;
use agent_workspace_storage::{SCHEMA_VERSION, SqliteStateStore};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn schema_v10_migrates_to_private_bounded_v11_tables() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    {
        let _ = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    }
    let c = Connection::open(&path).unwrap();
    c.pragma_update(None, "user_version", 10).unwrap();
    for table in [
        "sidebar_placements",
        "text_box_documents",
        "recently_closed_records",
        "task_metadata",
    ] {
        c.execute(&format!("DROP TABLE {table}"), []).unwrap();
    }
    drop(c);
    let (_store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert!(matches!(
        outcome,
        agent_workspace_storage::MigrationOutcome::Upgraded {
            from: 10,
            to: SCHEMA_VERSION,
            ..
        }
    ));
    let c = Connection::open(&path).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    let schema:String=c.query_row("SELECT group_concat(sql,' ') FROM sqlite_schema WHERE type='table' AND name IN ('sidebar_placements','text_box_documents','recently_closed_records','task_metadata')",[],|r|r.get(0)).unwrap();
    for forbidden in [
        " pid ",
        " private_key ",
        " filesystem_path ",
        " environment ",
        " terminal_output ",
    ] {
        assert!(!schema.to_ascii_lowercase().contains(forbidden));
    }
}

#[test]
fn corrupt_sidebar_registry_is_rejected_without_deleting_source() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    {
        let _ = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    }
    let c = Connection::open(&path).unwrap();
    c.execute("INSERT INTO sidebar_placements(window_id,revision,side,width,enabled_json,order_json,selected,updated_at_ms) VALUES(?1,1,'right',320,'[\"textBox\"]','[\"textBox\"]','textBox',0)",[uuid::Uuid::new_v4().to_string()]).unwrap();
    drop(c);
    assert!(SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).is_err());
    assert!(path.exists());
}

#[test]
fn textbox_overflow_is_atomic_at_sql_boundary() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    {
        let _ = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    }
    let c = Connection::open(&path).unwrap();
    let result=c.execute("INSERT INTO text_box_documents(text_box_document_id,workspace_id,window_id,title,text_content,content_revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,'x',?4,1,?5,?6,0,0)",rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),"x".repeat(262_145),uuid::Uuid::new_v4().to_string(),"a".repeat(64)]);
    assert!(result.is_err());
    let count: i64 = c
        .query_row("SELECT count(*) FROM text_box_documents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

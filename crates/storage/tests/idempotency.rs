use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, Notification, NotificationId, NotificationLevel, NotificationSource, PaneId,
    ShortcutPlatform, Tab, TabId, TerminalLaunchSpec, Timestamp, Workspace, WorkspaceId,
};
use agent_workspace_storage::{
    IdempotencyLookup, IdempotencySaveOutcome, IdempotencySaveRequest, SqliteStateStore,
};
use tempfile::TempDir;
use uuid::Uuid;

fn state() -> ApplicationState {
    let pane_id = PaneId::from_uuid(Uuid::from_u128(10));
    let tab = Tab::terminal(
        TabId::from_uuid(Uuid::from_u128(20)),
        pane_id,
        "shell",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(1),
    )
    .unwrap();
    ApplicationState::new(
        Workspace::new(
            WorkspaceId::from_uuid(Uuid::from_u128(1)),
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

fn notification(id: u128, at: u64) -> Notification {
    Notification::new(
        NotificationId::from_uuid(Uuid::from_u128(id)),
        WorkspaceId::from_uuid(Uuid::from_u128(1)),
        Some(PaneId::from_uuid(Uuid::from_u128(10))),
        Some(TabId::from_uuid(Uuid::from_u128(20))),
        NotificationSource::AgentHook,
        NotificationLevel::Warning,
        format!("notification {id}"),
        None,
        Timestamp(at),
    )
    .unwrap()
}

fn request(
    key: &str,
    request_json: &str,
    result_json: &str,
    capacity: usize,
) -> IdempotencySaveRequest {
    IdempotencySaveRequest {
        namespace: "attention-v1".to_owned(),
        idempotency_key: key.to_owned(),
        request_json: request_json.to_owned(),
        result_json: result_json.to_owned(),
        retention_capacity: capacity,
    }
}

#[test]
fn exact_result_survives_restart_and_conflicting_key_reuse_is_rejected() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let mut application = state();
    application
        .publish_notification(notification(100, 2))
        .unwrap();
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&application).unwrap();

    application
        .mark_notification_read(
            NotificationId::from_uuid(Uuid::from_u128(100)),
            Timestamp(3),
        )
        .unwrap();
    let durable = request("key-1", r#"{"notification":"100"}"#, r#"{"revision":2}"#, 8);
    assert_eq!(
        store.save_with_idempotency(&application, &durable).unwrap(),
        IdempotencySaveOutcome::Committed
    );
    drop(store);

    let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert_eq!(
        reopened
            .load_idempotency_result("attention-v1", "key-1", &durable.request_json)
            .unwrap(),
        IdempotencyLookup::Replay(durable.result_json.clone())
    );
    assert_eq!(
        reopened
            .load_idempotency_result("attention-v1", "key-1", "different")
            .unwrap(),
        IdempotencyLookup::Conflict
    );
}

#[test]
fn durable_results_are_trimmed_deterministically_to_the_requested_bound() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let mut application = state();
    for id in 100..103 {
        application
            .publish_notification(notification(id, u64::try_from(id).unwrap()))
            .unwrap();
    }
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    store.save(&application).unwrap();

    for index in 0..3 {
        let id = 100 + index;
        application
            .mark_notification_read(
                NotificationId::from_uuid(Uuid::from_u128(id)),
                Timestamp(200 + u64::try_from(index).unwrap()),
            )
            .unwrap();
        let durable = request(
            &format!("key-{index}"),
            &format!(r#"{{"notification":{id}}}"#),
            &format!(r#"{{"result":{index}}}"#),
            2,
        );
        assert_eq!(
            store.save_with_idempotency(&application, &durable).unwrap(),
            IdempotencySaveOutcome::Committed
        );
    }

    assert_eq!(
        store
            .load_idempotency_result("attention-v1", "key-0", r#"{"notification":100}"#)
            .unwrap(),
        IdempotencyLookup::Missing
    );
    for index in 1..3 {
        assert!(matches!(
            store
                .load_idempotency_result(
                    "attention-v1",
                    &format!("key-{index}"),
                    &format!(r#"{{"notification":{}}}"#, 100 + index)
                )
                .unwrap(),
            IdempotencyLookup::Replay(_)
        ));
    }
}

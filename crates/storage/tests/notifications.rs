use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, NOTIFICATION_RETENTION_CAP, Notification, NotificationId, NotificationLevel,
    NotificationSettings, NotificationSource, PaneId, ShortcutPlatform, Tab, TabId,
    TerminalLaunchSpec, Timestamp, Workspace, WorkspaceId,
};
use agent_workspace_storage::SqliteStateStore;
use rusqlite::Connection;
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

fn notification_id(value: u128) -> NotificationId {
    NotificationId::from_uuid(Uuid::from_u128(value))
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

fn notification(id: u128, created_at: u64) -> Notification {
    Notification::new(
        notification_id(id),
        workspace_id(1),
        Some(pane_id(10)),
        Some(tab_id(100)),
        NotificationSource::AgentHook,
        NotificationLevel::Warning,
        format!("event {id}"),
        Some(format!("body {id}")),
        Timestamp(created_at),
    )
    .unwrap()
}

#[test]
fn schema_v1_payload_without_milestone_three_fields_loads_with_private_defaults() {
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
    let mut legacy: serde_json::Value = serde_json::from_str(&payload).unwrap();
    let object = legacy.as_object_mut().unwrap();
    object.remove("notifications");
    object.remove("notificationSettings");
    connection
        .execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&legacy).unwrap()],
        )
        .unwrap();
    drop(connection);

    let loaded = store.load().unwrap().unwrap();
    assert!(loaded.notifications.is_empty());
    assert_eq!(
        loaded.notification_settings,
        NotificationSettings::default()
    );
    assert!(loaded.notification_settings.system_enabled);
    assert!(!loaded.notification_settings.include_body);
}

#[test]
fn restart_round_trip_preserves_read_state_settings_and_bounded_retention() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite3");
    let mut expected = state();
    for index in 0..=NOTIFICATION_RETENTION_CAP {
        expected
            .publish_notification(notification(index as u128 + 1, index as u64))
            .unwrap();
    }
    expected
        .mark_notification_read(notification_id(2), Timestamp(2_000))
        .unwrap();
    expected
        .set_notification_settings(NotificationSettings {
            system_enabled: false,
            include_body: true,
        })
        .unwrap();
    assert_eq!(expected.notifications.len(), NOTIFICATION_RETENTION_CAP);
    assert!(
        !expected
            .notifications
            .iter()
            .any(|item| item.id == notification_id(1))
    );

    {
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        store.save(&expected).unwrap();
    }
    let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let loaded = reopened.load().unwrap().unwrap();
    assert_eq!(loaded, expected);
    assert_eq!(
        loaded
            .notifications
            .iter()
            .find(|item| item.id == notification_id(2))
            .unwrap()
            .read_at,
        Some(Timestamp(2_000))
    );
    assert_eq!(
        loaded.notification_settings,
        NotificationSettings {
            system_enabled: false,
            include_body: true,
        }
    );
}

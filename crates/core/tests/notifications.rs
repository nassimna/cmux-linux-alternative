#![allow(deprecated)]

use std::path::PathBuf;

use agent_workspace_core::{
    ApplicationState, Axis, DomainError, NOTIFICATION_RETENTION_CAP, Notification, NotificationId,
    NotificationLevel, NotificationSettings, NotificationSource, PaneId, SplitContent, SplitId,
    SplitPlacement, Tab, TabId, TerminalLaunchSpec, Timestamp, Workspace, WorkspaceId,
};
use proptest::prelude::*;
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

fn terminal_tab(id: u128, pane: PaneId) -> Tab {
    Tab::terminal(
        tab_id(id),
        pane,
        "shell",
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap(),
        None,
        Timestamp(1),
    )
    .unwrap()
}

fn initial_state() -> ApplicationState {
    let pane = pane_id(10);
    ApplicationState::new(
        Workspace::new(
            workspace_id(1),
            "workspace",
            PathBuf::from("/tmp"),
            pane,
            terminal_tab(100, pane),
            Timestamp(1),
            Timestamp(1),
        )
        .unwrap(),
    )
    .unwrap()
}

fn notification(
    id: u128,
    pane: Option<PaneId>,
    tab: Option<TabId>,
    level: NotificationLevel,
    created_at: u64,
) -> Notification {
    Notification::new(
        notification_id(id),
        workspace_id(1),
        pane,
        tab,
        NotificationSource::Internal,
        level,
        format!("event {id}"),
        Some(format!("body {id}")),
        Timestamp(created_at),
    )
    .unwrap()
}

#[test]
fn notification_text_is_trimmed_bounded_and_control_safe() {
    let item = Notification::new(
        notification_id(1),
        workspace_id(1),
        None,
        None,
        NotificationSource::Osc,
        NotificationLevel::Info,
        "\u{00a0}finished\u{00a0}",
        Some(" details ".into()),
        Timestamp(1),
    )
    .unwrap();
    assert_eq!(item.source, NotificationSource::Osc);
    assert_eq!(item.title, "finished");
    assert_eq!(item.body.as_deref(), Some("details"));

    for (title, body) in [
        ("bad\u{0000}title", None),
        ("title", Some("bad\nbody".to_owned())),
    ] {
        assert!(matches!(
            Notification::new(
                notification_id(2),
                workspace_id(1),
                None,
                None,
                NotificationSource::Internal,
                NotificationLevel::Info,
                title,
                body,
                Timestamp(1),
            ),
            Err(DomainError::UnsafeControlCharacter { .. })
        ));
    }

    assert!(matches!(
        Notification::new(
            notification_id(3),
            workspace_id(1),
            None,
            None,
            NotificationSource::Internal,
            NotificationLevel::Info,
            "x".repeat(257),
            None,
            Timestamp(1),
        ),
        Err(DomainError::TextTooLong { max: 256, .. })
    ));
}

#[test]
fn publish_validates_current_target_hierarchy_and_duplicate_ids_atomically() {
    let mut state = initial_state();
    let before = state.clone();
    let missing_workspace = Notification::new(
        notification_id(1),
        workspace_id(99),
        None,
        None,
        NotificationSource::Internal,
        NotificationLevel::Info,
        "title",
        None,
        Timestamp(1),
    )
    .unwrap();
    assert!(matches!(
        state.publish_notification(missing_workspace),
        Err(DomainError::WorkspaceNotFound { .. })
    ));
    assert_eq!(state, before);

    let missing_pane = notification(2, Some(pane_id(99)), None, NotificationLevel::Info, 2);
    assert!(matches!(
        state.publish_notification(missing_pane),
        Err(DomainError::PaneNotFound { .. })
    ));

    let missing_tab = notification(3, None, Some(tab_id(99)), NotificationLevel::Info, 3);
    assert!(matches!(
        state.publish_notification(missing_tab),
        Err(DomainError::TabNotFound { .. })
    ));

    let second_pane = pane_id(20);
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            second_pane,
            SplitId::from_uuid(Uuid::from_u128(1_000)),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, second_pane)),
            Timestamp(2),
        )
        .unwrap();
    assert!(matches!(
        state.publish_notification(notification(
            4,
            Some(second_pane),
            Some(tab_id(100)),
            NotificationLevel::Info,
            4,
        )),
        Err(DomainError::TabPaneMismatch { .. })
    ));

    let valid = notification(
        5,
        Some(pane_id(10)),
        Some(tab_id(100)),
        NotificationLevel::Info,
        5,
    );
    let revision = state.revision;
    assert_eq!(
        state.publish_notification(valid.clone()).unwrap().revision,
        revision + 1
    );
    let after_publish = state.clone();
    assert!(matches!(
        state.publish_notification(valid),
        Err(DomainError::DuplicateId {
            entity: "notification",
            ..
        })
    ));
    assert_eq!(state, after_publish);

    let mut invalid_snapshot = state;
    invalid_snapshot
        .notifications
        .push(invalid_snapshot.notifications[0].clone());
    assert!(matches!(
        invalid_snapshot.validate(),
        Err(DomainError::DuplicateId {
            entity: "notification",
            ..
        })
    ));
}

#[test]
fn attention_derives_hierarchy_severity_latest_excerpt_and_read_state() {
    let mut state = initial_state();
    state
        .publish_notification(notification(1, None, None, NotificationLevel::Warning, 2))
        .unwrap();
    state
        .publish_notification(notification(
            2,
            Some(pane_id(10)),
            Some(tab_id(100)),
            NotificationLevel::Error,
            3,
        ))
        .unwrap();

    let attention = state.attention_state();
    assert_eq!(attention.application.unread_count, 2);
    assert_eq!(
        attention.application.highest_level,
        Some(NotificationLevel::Error)
    );
    assert_eq!(
        attention.application.latest_unread.unwrap().notification_id,
        notification_id(2)
    );
    assert_eq!(attention.workspaces[&workspace_id(1)].unread_count, 2);
    assert_eq!(attention.panes[&pane_id(10)].unread_count, 1);
    assert_eq!(attention.tabs[&tab_id(100)].unread_count, 1);

    let revision = state.revision;
    state
        .mark_notification_read(notification_id(2), Timestamp(4))
        .unwrap();
    assert_eq!(state.revision, revision + 1);
    assert_eq!(state.attention_state().application.unread_count, 1);
    let before = state.clone();
    assert!(matches!(
        state.mark_notification_read(notification_id(2), Timestamp(5)),
        Err(DomainError::InvalidOperation { .. })
    ));
    assert_eq!(state, before);

    let before = state.clone();
    assert!(matches!(
        state.mark_notification_read(notification_id(1), Timestamp(1)),
        Err(DomainError::InvalidState { .. })
    ));
    assert_eq!(state, before);

    state.mark_notification_unread(notification_id(2)).unwrap();
    assert_eq!(state.attention_state().application.unread_count, 2);
    assert_eq!(state.notifications[1].read_at, None);
}

#[test]
fn stale_targets_remain_valid_move_with_tabs_and_disappear_from_entity_attention_on_delete() {
    let mut state = initial_state();
    state
        .publish_notification(notification(
            1,
            Some(pane_id(10)),
            Some(tab_id(100)),
            NotificationLevel::Warning,
            2,
        ))
        .unwrap();
    let second_pane = pane_id(20);
    state
        .split_pane(
            workspace_id(1),
            pane_id(10),
            second_pane,
            SplitId::from_uuid(Uuid::from_u128(1_000)),
            Axis::Horizontal,
            0.5,
            SplitPlacement::After,
            SplitContent::NewTerminal(terminal_tab(200, second_pane)),
            Timestamp(3),
        )
        .unwrap();
    state
        .move_tab(workspace_id(1), tab_id(100), second_pane, 1, Timestamp(4))
        .unwrap();
    state.validate().unwrap();
    let attention = state.attention_state();
    assert!(!attention.panes.contains_key(&pane_id(10)));
    assert_eq!(attention.panes[&second_pane].unread_count, 1);

    state
        .close_tab(workspace_id(1), tab_id(100), None, Timestamp(5))
        .unwrap();
    state.validate().unwrap();
    let attention = state.attention_state();
    assert_eq!(attention.application.unread_count, 1);
    assert!(attention.workspaces.is_empty());
    assert!(attention.panes.is_empty());
    assert!(attention.tabs.is_empty());
    assert_eq!(state.notifications.len(), 1);
}

#[test]
fn clear_operations_and_settings_are_revisioned_and_reject_noops() {
    let mut state = initial_state();
    assert_eq!(state.notification_settings, NotificationSettings::default());
    assert!(state.notification_settings.system_enabled);
    assert!(!state.notification_settings.include_body);

    let settings = NotificationSettings {
        system_enabled: false,
        include_body: true,
    };
    state.set_notification_settings(settings).unwrap();
    assert_eq!(state.notification_settings, settings);
    let before = state.clone();
    assert!(matches!(
        state.set_notification_settings(settings),
        Err(DomainError::InvalidOperation { .. })
    ));
    assert_eq!(state, before);

    state
        .publish_notification(notification(1, None, None, NotificationLevel::Info, 2))
        .unwrap();
    state
        .publish_notification(notification(2, None, None, NotificationLevel::Info, 3))
        .unwrap();
    state
        .mark_notification_read(notification_id(1), Timestamp(4))
        .unwrap();
    state.clear_read_notifications().unwrap();
    assert_eq!(state.notifications[0].id, notification_id(2));
    state.clear_notification(notification_id(2)).unwrap();
    assert!(state.notifications.is_empty());
    assert!(matches!(
        state.clear_all_notifications(),
        Err(DomainError::InvalidOperation { .. })
    ));
}

#[test]
fn retention_evicts_the_oldest_record_deterministically_and_validation_rejects_overflow() {
    let mut state = initial_state();
    for index in 0..NOTIFICATION_RETENTION_CAP {
        state
            .publish_notification(notification(
                index as u128 + 1,
                None,
                None,
                NotificationLevel::Info,
                index as u64,
            ))
            .unwrap();
    }
    state
        .publish_notification(notification(
            10_000,
            None,
            None,
            NotificationLevel::Info,
            500,
        ))
        .unwrap();
    assert_eq!(state.notifications.len(), NOTIFICATION_RETENTION_CAP);
    assert!(
        !state
            .notifications
            .iter()
            .any(|item| item.id == notification_id(1))
    );
    assert!(
        state
            .notifications
            .iter()
            .any(|item| item.id == notification_id(10_000))
    );
    state.validate().unwrap();

    let mut invalid = state;
    invalid.notifications.push(notification(
        20_000,
        None,
        None,
        NotificationLevel::Info,
        2_000,
    ));
    assert!(matches!(
        invalid.validate(),
        Err(DomainError::InvalidState { .. })
    ));
}

proptest! {
    #[test]
    fn notification_title_scalar_bound_is_exact(title in "[a-z]{0,300}") {
        let result = Notification::new(
            notification_id(1),
            workspace_id(1),
            None,
            None,
            NotificationSource::Internal,
            NotificationLevel::Info,
            title.clone(),
            None,
            Timestamp(1),
        );
        prop_assert_eq!(result.is_ok(), (1..=256).contains(&title.chars().count()));
    }
}

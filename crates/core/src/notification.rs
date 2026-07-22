use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::{checked_text, invalid, validate_normalized_text, validate_timestamp};
use crate::{ApplicationState, DomainError, NotificationId, PaneId, TabId, Timestamp, WorkspaceId};

/// Maximum number of notification records retained in a snapshot.
pub const NOTIFICATION_RETENTION_CAP: usize = 1_000;
/// Maximum notification title length in Unicode scalar values.
pub const NOTIFICATION_TITLE_MAX_CHARS: usize = 256;
/// Maximum notification body length in Unicode scalar values.
pub const NOTIFICATION_BODY_MAX_CHARS: usize = 4_096;
const ATTENTION_BODY_EXCERPT_CHARS: usize = 160;

/// Severity used for notification ordering and derived attention.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationLevel {
    /// Informational activity.
    Info,
    /// Activity that may need intervention.
    Warning,
    /// Activity requiring prompt attention.
    Error,
}

/// Trusted producer class for a notification.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationSource {
    /// A command-line integration.
    Cli,
    /// An OSC terminal escape sequence.
    Osc,
    /// An agent lifecycle hook.
    AgentHook,
    /// Application-owned activity.
    Internal,
}

/// Persisted policy for forwarding notifications outside the application.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettings {
    /// Whether operating-system notifications may be emitted.
    pub system_enabled: bool,
    /// Whether notification bodies, which may contain terminal content, may be forwarded.
    pub include_body: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            system_enabled: true,
            include_body: false,
        }
    }
}

/// One bounded, durable notification record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notification {
    /// Opaque persistent identity.
    pub id: NotificationId,
    /// Workspace targeted when the record was published.
    pub workspace_id: WorkspaceId,
    /// Optional pane targeted when the record was published.
    pub pane_id: Option<PaneId>,
    /// Optional tab targeted when the record was published.
    pub tab_id: Option<TabId>,
    /// Trusted producer class shown to the user.
    pub source: NotificationSource,
    /// Notification severity.
    pub level: NotificationLevel,
    /// Bounded display title.
    pub title: String,
    /// Optional bounded detail text.
    pub body: Option<String>,
    /// Caller-supplied publication time.
    pub created_at: Timestamp,
    /// Caller-supplied time at which the record was marked read.
    pub read_at: Option<Timestamp>,
}

impl Notification {
    /// Creates a canonical unread notification.
    ///
    /// # Errors
    /// Returns an error for empty, overlong, or control-bearing text or an invalid timestamp.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: NotificationId,
        workspace_id: WorkspaceId,
        pane_id: Option<PaneId>,
        tab_id: Option<TabId>,
        source: NotificationSource,
        level: NotificationLevel,
        title: impl Into<String>,
        body: Option<String>,
        created_at: Timestamp,
    ) -> Result<Self, DomainError> {
        let value = Self {
            id,
            workspace_id,
            pane_id,
            tab_id,
            source,
            level,
            title: checked_safe_text(
                "notification.title",
                &title.into(),
                NOTIFICATION_TITLE_MAX_CHARS,
            )?,
            body: body
                .map(|body| {
                    checked_safe_text("notification.body", &body, NOTIFICATION_BODY_MAX_CHARS)
                })
                .transpose()?,
            created_at,
            read_at: None,
        };
        value.validate()?;
        Ok(value)
    }

    /// Returns whether the notification contributes to attention.
    #[must_use]
    pub const fn is_unread(&self) -> bool {
        self.read_at.is_none()
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        validate_safe_text(
            "notification.title",
            &self.title,
            NOTIFICATION_TITLE_MAX_CHARS,
        )?;
        if let Some(body) = &self.body {
            validate_safe_text("notification.body", body, NOTIFICATION_BODY_MAX_CHARS)?;
        }
        validate_timestamp("notification.created_at", self.created_at)?;
        if let Some(read_at) = self.read_at {
            validate_timestamp("notification.read_at", read_at)?;
            if read_at < self.created_at {
                return Err(invalid(
                    "notification read_at precedes notification created_at",
                ));
            }
        }
        Ok(())
    }
}

/// Compact latest-unread detail embedded in an attention summary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionExcerpt {
    /// Notification represented by this excerpt.
    pub notification_id: NotificationId,
    /// Producer identity.
    pub source: NotificationSource,
    /// Full bounded title.
    pub title: String,
    /// Body truncated to 160 Unicode scalars when present.
    pub body_excerpt: Option<String>,
    /// Publication time used to select the latest record.
    pub created_at: Timestamp,
}

/// Derived attention for one scope.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSummary {
    /// Number of unread notifications in this scope.
    pub unread_count: u32,
    /// Highest unread severity.
    pub highest_level: Option<NotificationLevel>,
    /// Most recently created unread notification, with deterministic ID tie-breaking.
    pub latest_unread: Option<AttentionExcerpt>,
}

/// Complete derived attention projection. Empty entity scopes are omitted from the maps.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionState {
    /// All retained unread records, including records whose historical target was deleted.
    pub application: AttentionSummary,
    /// Attention associated with currently existing workspaces.
    pub workspaces: BTreeMap<WorkspaceId, AttentionSummary>,
    /// Attention associated with currently existing panes.
    pub panes: BTreeMap<PaneId, AttentionSummary>,
    /// Attention associated with currently existing tabs.
    pub tabs: BTreeMap<TabId, AttentionSummary>,
}

impl ApplicationState {
    /// Derives attention solely from unread notification records and the current entity graph.
    #[must_use]
    pub fn attention_state(&self) -> AttentionState {
        let mut attention = AttentionState::default();
        for notification in self.notifications.iter().filter(|item| item.is_unread()) {
            attention.application.include(notification);

            if let Some(tab_id) = notification.tab_id {
                let Some((workspace_id, pane_id)) = self.workspaces.iter().find_map(|workspace| {
                    workspace
                        .tabs
                        .get(&tab_id)
                        .map(|tab| (workspace.id, tab.pane_id))
                }) else {
                    continue;
                };
                attention
                    .workspaces
                    .entry(workspace_id)
                    .or_default()
                    .include(notification);
                attention
                    .panes
                    .entry(pane_id)
                    .or_default()
                    .include(notification);
                attention
                    .tabs
                    .entry(tab_id)
                    .or_default()
                    .include(notification);
                continue;
            }

            let Some(workspace) = self
                .workspaces
                .iter()
                .find(|workspace| workspace.id == notification.workspace_id)
            else {
                continue;
            };
            if let Some(pane_id) = notification.pane_id {
                if !workspace.panes.contains_key(&pane_id) {
                    continue;
                }
                attention
                    .panes
                    .entry(pane_id)
                    .or_default()
                    .include(notification);
            }
            attention
                .workspaces
                .entry(workspace.id)
                .or_default()
                .include(notification);
        }
        attention
    }
}

impl AttentionSummary {
    fn include(&mut self, notification: &Notification) {
        self.unread_count = self
            .unread_count
            .checked_add(1)
            .expect("notification retention cap fits in u32");
        self.highest_level = Some(
            self.highest_level
                .map_or(notification.level, |level| level.max(notification.level)),
        );
        let replace_latest = self.latest_unread.as_ref().is_none_or(|latest| {
            (notification.created_at, notification.id) > (latest.created_at, latest.notification_id)
        });
        if replace_latest {
            self.latest_unread = Some(AttentionExcerpt {
                notification_id: notification.id,
                source: notification.source,
                title: notification.title.clone(),
                body_excerpt: notification.body.as_deref().map(body_excerpt),
                created_at: notification.created_at,
            });
        }
    }
}

fn checked_safe_text(field: &'static str, value: &str, max: usize) -> Result<String, DomainError> {
    let value = checked_text(field, value, max, false)?;
    reject_control_characters(field, &value)?;
    Ok(value)
}

fn validate_safe_text(field: &'static str, value: &str, max: usize) -> Result<(), DomainError> {
    validate_normalized_text(field, value, max, false)?;
    reject_control_characters(field, value)
}

fn reject_control_characters(field: &'static str, value: &str) -> Result<(), DomainError> {
    if value.chars().any(char::is_control) {
        Err(DomainError::UnsafeControlCharacter { field })
    } else {
        Ok(())
    }
}

fn body_excerpt(body: &str) -> String {
    body.chars().take(ATTENTION_BODY_EXCERPT_CHARS).collect()
}

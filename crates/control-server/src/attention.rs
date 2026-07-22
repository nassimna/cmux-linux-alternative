use std::{collections::BTreeMap, sync::Arc};

use agent_workspace_core::{
    ApplicationState, Notification, NotificationId, NotificationLevel as CoreNotificationLevel,
    Timestamp,
};
use agent_workspace_protocol::{
    AgentStatus, AttentionAcknowledgementMode, AttentionAcknowledgementParams,
    AttentionAcknowledgementResult, AttentionReason, AttentionState, EventEnvelope,
    ResponseEnvelope, WorkspaceAttentionChangeReason, WorkspaceAttentionChangedEvent,
    WorkspaceAttentionSnapshot, WorkspaceAttentionSnapshotParams, WorkspaceCardSlotsSnapshot,
};
use agent_workspace_runtime::{IdempotentCommitResult, ProductionWorkspaceRuntime};
use agent_workspace_storage::{IdempotencyLookup, IdempotencySaveRequest, SqliteStateStore};
use serde::de::DeserializeOwned;
use tokio::sync::{Mutex, broadcast, mpsc};
use uuid::Uuid;

use super::{ControlContext, serialize_frame};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ATTENTION_EVENT_CAPACITY: usize = 64;
const ACKNOWLEDGEMENT_CACHE_CAPACITY: usize = 256;
const DURABLE_ACKNOWLEDGEMENT_CAPACITY: usize = 4_096;
const ATTENTION_ACKNOWLEDGEMENT_NAMESPACE: &str = "attention-v1";

#[derive(Clone)]
pub(super) struct AttentionRuntime {
    state: Arc<Mutex<AttentionRuntimeState>>,
    events: broadcast::Sender<WorkspaceAttentionChangedEvent>,
}

#[derive(Clone, Default)]
struct AttentionRuntimeState {
    snapshots: BTreeMap<String, WorkspaceAttentionSnapshot>,
    latest_application_revision: u64,
    card_slot_revisions: BTreeMap<String, u64>,
    acknowledgements: BTreeMap<String, AcknowledgementCacheEntry>,
    acknowledgement_order: Vec<String>,
}

#[derive(Clone)]
struct AcknowledgementCacheEntry {
    params: AttentionAcknowledgementParams,
    result: Option<AttentionAcknowledgementResult>,
}

enum CachedAcknowledgement {
    New,
    Pending,
    Complete(AttentionAcknowledgementResult),
}

struct PreparedAcknowledgement {
    notification_id: NotificationId,
    read_at: Timestamp,
    projected: AttentionRuntimeState,
    events: Vec<WorkspaceAttentionChangedEvent>,
    result: AttentionAcknowledgementResult,
    durable_request: IdempotencySaveRequest,
}

#[derive(Debug)]
enum AttentionFailure {
    WorkspaceNotFound,
    NotificationNotFound,
    TargetUnavailable,
    TargetNotFocused,
    AlreadyAcknowledged,
    RevisionConflict,
    RevisionExhausted,
    IdempotencyConflict,
    Runtime,
}

impl AttentionRuntime {
    pub(super) fn new() -> Self {
        let (events, _) = broadcast::channel(ATTENTION_EVENT_CAPACITY);
        Self {
            state: Arc::new(Mutex::new(AttentionRuntimeState::default())),
            events,
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<WorkspaceAttentionChangedEvent> {
        self.events.subscribe()
    }

    async fn get(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        card_slots: &super::card_slots::CardSlotRuntime,
        workspace_id: &str,
    ) -> Result<WorkspaceAttentionSnapshot, AttentionFailure> {
        self.refresh(
            runtime,
            card_slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .await?;
        self.state
            .lock()
            .await
            .snapshots
            .get(workspace_id)
            .cloned()
            .ok_or(AttentionFailure::WorkspaceNotFound)
    }

    async fn refresh(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        card_slots: &super::card_slots::CardSlotRuntime,
        reason: WorkspaceAttentionChangeReason,
    ) -> Result<(), AttentionFailure> {
        let application = runtime.snapshot().await;
        let slots = card_slots.snapshot_all().await;
        let events = {
            let mut state = self.state.lock().await;
            apply_fold(&mut state, &application, &slots, reason)?
        };
        self.publish(events);
        Ok(())
    }

    async fn acknowledge(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        card_slots: &super::card_slots::CardSlotRuntime,
        store: Arc<SqliteStateStore>,
        params: AttentionAcknowledgementParams,
    ) -> Result<AttentionAcknowledgementResult, AttentionFailure> {
        let request_json = serde_json::to_string(&params).map_err(|_| AttentionFailure::Runtime)?;
        if let Some(result) = replay_durable_acknowledgement(
            Arc::clone(&store),
            &params.idempotency_key,
            &request_json,
        )
        .await?
        {
            return Ok(result);
        }
        // Keep this order: card-slot replacement also takes slots before runtime, while refresh
        // releases both source locks before taking attention. Holding slots through the runtime CAS
        // makes the folded source pair the acknowledgement's linearization basis.
        let mut attention = self.state.lock().await;
        let was_pending = match cached_acknowledgement(&attention, &params)? {
            CachedAcknowledgement::New => false,
            CachedAcknowledgement::Pending => true,
            CachedAcknowledgement::Complete(result) => return Ok(result),
        };
        let slots = card_slots.lock_snapshots().await;
        let application = runtime.snapshot().await;
        let source_events = apply_fold(
            &mut attention,
            &application,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )?;
        self.publish(source_events);
        if was_pending
            && let Some(result) = replay_durable_acknowledgement(
                Arc::clone(&store),
                &params.idempotency_key,
                &request_json,
            )
            .await?
        {
            return Ok(result);
        }
        let prepared =
            prepare_acknowledgement(&application, &mut attention, &slots, &params, request_json)?;
        let PreparedAcknowledgement {
            notification_id,
            read_at,
            projected,
            events,
            result,
            durable_request,
        } = prepared;
        let commit = runtime
            .mutate_idempotent(application.revision, durable_request, move |state| {
                state.mark_notification_read(notification_id, read_at)
            })
            .await;
        let (returned, publish_events) = match commit {
            Ok(IdempotentCommitResult::Committed(_)) => {
                attention.snapshots = projected.snapshots;
                attention.latest_application_revision = projected.latest_application_revision;
                attention.card_slot_revisions = projected.card_slot_revisions;
                (result, true)
            }
            Ok(IdempotentCommitResult::Replay(result)) => (decode_acknowledgement(&result)?, false),
            Ok(IdempotentCommitResult::Conflict) => {
                forget_acknowledgement(&mut attention, &params.idempotency_key);
                return Err(AttentionFailure::IdempotencyConflict);
            }
            Err(_) => {
                forget_acknowledgement(&mut attention, &params.idempotency_key);
                let latest = runtime.snapshot().await;
                if latest.revision != application.revision {
                    let events = apply_fold(
                        &mut attention,
                        &latest,
                        &slots,
                        WorkspaceAttentionChangeReason::SourcesChanged,
                    )?;
                    self.publish(events);
                    return Err(AttentionFailure::RevisionConflict);
                }
                return Err(AttentionFailure::Runtime);
            }
        };
        drop(slots);
        complete_acknowledgement(&mut attention, &params.idempotency_key, returned.clone());
        drop(attention);
        if publish_events {
            self.publish(events);
        }
        Ok(returned)
    }

    fn publish(&self, events: Vec<WorkspaceAttentionChangedEvent>) {
        for event in events {
            let _ = self.events.send(event);
        }
    }
}

async fn replay_durable_acknowledgement(
    store: Arc<SqliteStateStore>,
    idempotency_key: &str,
    request_json: &str,
) -> Result<Option<AttentionAcknowledgementResult>, AttentionFailure> {
    match load_durable_acknowledgement(store, idempotency_key, request_json).await? {
        IdempotencyLookup::Replay(result) => decode_acknowledgement(&result).map(Some),
        IdempotencyLookup::Conflict => Err(AttentionFailure::IdempotencyConflict),
        IdempotencyLookup::Missing => Ok(None),
    }
}

fn prepare_acknowledgement(
    application: &ApplicationState,
    attention: &mut AttentionRuntimeState,
    slots: &BTreeMap<String, WorkspaceCardSlotsSnapshot>,
    params: &AttentionAcknowledgementParams,
    request_json: String,
) -> Result<PreparedAcknowledgement, AttentionFailure> {
    let notification_id = NotificationId::from_uuid(
        Uuid::parse_str(&params.notification_id)
            .expect("protocol validates notification identities"),
    );
    let notification = application
        .notifications
        .iter()
        .find(|notification| notification.id == notification_id)
        .cloned()
        .ok_or(AttentionFailure::NotificationNotFound)?;
    let workspace_id = notification.workspace_id.to_string();
    let current = attention
        .snapshots
        .get(&workspace_id)
        .ok_or(AttentionFailure::TargetUnavailable)?;
    if current.revision != params.expected_revision {
        return Err(AttentionFailure::RevisionConflict);
    }
    if !notification.is_unread() {
        return Err(AttentionFailure::AlreadyAcknowledged);
    }
    if !notification_target_exists(application, &notification) {
        return Err(AttentionFailure::TargetUnavailable);
    }
    if params.mode == AttentionAcknowledgementMode::Focused
        && !notification_target_is_focused(application, &notification)
    {
        return Err(AttentionFailure::TargetNotFocused);
    }
    remember_pending_acknowledgement(attention, params.clone());
    let read_at = now();
    let mut candidate = application.clone();
    candidate
        .mark_notification_read(notification_id, read_at)
        .map_err(|_| AttentionFailure::Runtime)?;
    let mut projected = attention.clone();
    let events = apply_fold(
        &mut projected,
        &candidate,
        slots,
        WorkspaceAttentionChangeReason::SourcesChanged,
    )?;
    let snapshot = projected
        .snapshots
        .get(&workspace_id)
        .cloned()
        .ok_or(AttentionFailure::TargetUnavailable)?;
    let result = AttentionAcknowledgementResult {
        revision: snapshot.revision,
        attention: snapshot,
    };
    let result_json = serde_json::to_string(&result).map_err(|_| AttentionFailure::Runtime)?;
    let durable_request = IdempotencySaveRequest {
        namespace: ATTENTION_ACKNOWLEDGEMENT_NAMESPACE.to_owned(),
        idempotency_key: params.idempotency_key.clone(),
        request_json,
        result_json,
        retention_capacity: DURABLE_ACKNOWLEDGEMENT_CAPACITY,
    };
    Ok(PreparedAcknowledgement {
        notification_id,
        read_at,
        projected,
        events,
        result,
        durable_request,
    })
}

pub(super) fn is_command(command: &str) -> bool {
    matches!(command, "workspace.attention.get" | "attention.acknowledge")
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
) -> ResponseEnvelope {
    let (Some(runtime), Some(card_slots), Some(attention)) =
        (&context.runtime, &context.card_slots, &context.attention)
    else {
        return ResponseEnvelope::failure(
            id,
            "unknown_command",
            format!("Unknown command: {command}"),
        );
    };
    let result = match command {
        "workspace.attention.get" => {
            let params = match parse::<WorkspaceAttentionSnapshotParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            attention
                .get(runtime, card_slots, &params.workspace_id)
                .await
                .map(|snapshot| {
                    serde_json::to_value(snapshot)
                        .expect("attention snapshot serialization is infallible")
                })
        }
        "attention.acknowledge" => {
            let params = match parse::<AttentionAcknowledgementParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            let Some(persistence) = &context.persistence else {
                return ResponseEnvelope::failure(
                    id,
                    "unknown_command",
                    "Unknown command: attention.acknowledge",
                );
            };
            attention
                .acknowledge(
                    runtime,
                    card_slots,
                    Arc::clone(&persistence.state_store),
                    params,
                )
                .await
                .map(|result| {
                    serde_json::to_value(result)
                        .expect("attention acknowledgement serialization is infallible")
                })
        }
        _ => unreachable!("attention dispatcher receives only known commands"),
    };
    match result {
        Ok(value) => ResponseEnvelope::success(id, value),
        Err(error) => failure(id, &error),
    }
}

pub(super) async fn monitor_sources(
    attention: AttentionRuntime,
    runtime: Arc<ProductionWorkspaceRuntime>,
    card_slots: super::card_slots::CardSlotRuntime,
) {
    let mut domain = runtime.subscribe();
    let mut slots = card_slots.subscribe();
    let _ = attention
        .refresh(
            runtime.as_ref(),
            &card_slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .await;
    loop {
        let reason = tokio::select! {
            event = domain.recv() => match event {
                Ok(_) => WorkspaceAttentionChangeReason::SourcesChanged,
                Err(broadcast::error::RecvError::Lagged(_)) => WorkspaceAttentionChangeReason::ResyncRequired,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            event = slots.recv() => match event {
                Ok(_) => WorkspaceAttentionChangeReason::SourcesChanged,
                Err(broadcast::error::RecvError::Lagged(_)) => WorkspaceAttentionChangeReason::ResyncRequired,
                Err(broadcast::error::RecvError::Closed) => return,
            },
        };
        let _ = attention
            .refresh(runtime.as_ref(), &card_slots, reason)
            .await;
    }
}

pub(super) async fn forward_events(
    runtime: AttentionRuntime,
    mut receiver: broadcast::Receiver<WorkspaceAttentionChangedEvent>,
    sender: mpsc::Sender<Vec<u8>>,
    scope: Option<super::multi_window::WindowEventScope>,
) {
    loop {
        let events = match receiver.recv().await {
            Ok(event) => vec![event],
            Err(broadcast::error::RecvError::Lagged(_)) => runtime
                .state
                .lock()
                .await
                .snapshots
                .values()
                .map(|snapshot| WorkspaceAttentionChangedEvent {
                    workspace_id: snapshot.workspace_id.clone(),
                    attention_revision: snapshot.revision,
                    reason: WorkspaceAttentionChangeReason::ResyncRequired,
                })
                .collect(),
            Err(broadcast::error::RecvError::Closed) => return,
        };
        for event in events {
            if let Some(scope) = &scope
                && !scope.owns_workspace(&event.workspace_id).await
            {
                continue;
            }
            let envelope = EventEnvelope {
                event: "workspace.attentionChanged".to_owned(),
                revision: None,
                data: serde_json::to_value(event)
                    .expect("attention event serialization is infallible"),
            };
            let Ok(frame) = serialize_frame(&envelope) else {
                continue;
            };
            if sender.send(frame).await.is_err() {
                return;
            }
        }
    }
}

fn apply_fold(
    runtime: &mut AttentionRuntimeState,
    application: &ApplicationState,
    slots: &BTreeMap<String, WorkspaceCardSlotsSnapshot>,
    reason: WorkspaceAttentionChangeReason,
) -> Result<Vec<WorkspaceAttentionChangedEvent>, AttentionFailure> {
    if application.revision < runtime.latest_application_revision {
        return Ok(Vec::new());
    }
    let mut next = BTreeMap::new();
    let mut next_slot_revisions = BTreeMap::new();
    let mut events = Vec::new();
    for workspace in &application.workspaces {
        let workspace_id = workspace.id.to_string();
        let slot_revision = slots.get(&workspace_id).map_or(0, |slot| slot.revision);
        if runtime
            .card_slot_revisions
            .get(&workspace_id)
            .is_some_and(|installed| *installed > slot_revision)
        {
            if let Some(previous) = runtime.snapshots.get(&workspace_id) {
                next.insert(workspace_id.clone(), previous.clone());
                let installed_slot_revision =
                    *runtime.card_slot_revisions.get(&workspace_id).unwrap_or(&0);
                next_slot_revisions.insert(workspace_id, installed_slot_revision);
            }
            continue;
        }
        let mut snapshot = fold_workspace(application, &workspace_id, slots.get(&workspace_id));
        match runtime.snapshots.get(&workspace_id) {
            Some(previous) if same_projection(previous, &snapshot) => {
                snapshot.revision = previous.revision;
            }
            Some(previous) => {
                snapshot.revision = previous
                    .revision
                    .checked_add(1)
                    .filter(|revision| *revision <= MAX_SAFE_INTEGER)
                    .ok_or(AttentionFailure::RevisionExhausted)?;
                events.push(WorkspaceAttentionChangedEvent {
                    workspace_id: workspace_id.clone(),
                    attention_revision: snapshot.revision,
                    reason,
                });
            }
            None => {
                snapshot.revision = 0;
            }
        }
        next_slot_revisions.insert(workspace_id.clone(), slot_revision);
        next.insert(workspace_id, snapshot);
    }
    runtime.snapshots = next;
    runtime.latest_application_revision = application.revision;
    runtime.card_slot_revisions = next_slot_revisions;
    Ok(events)
}

fn fold_workspace(
    application: &ApplicationState,
    workspace_id: &str,
    slots: Option<&WorkspaceCardSlotsSnapshot>,
) -> WorkspaceAttentionSnapshot {
    let workspace = application
        .workspaces
        .iter()
        .find(|workspace| workspace.id.to_string() == workspace_id)
        .expect("folding only iterates existing workspaces");
    let mut unread_count = 0_u32;
    let mut winner: Option<&Notification> = None;
    for notification in application.notifications.iter().filter(|notification| {
        notification.is_unread()
            && notification.workspace_id == workspace.id
            && notification_target_exists(application, notification)
    }) {
        unread_count = unread_count.saturating_add(1);
        let replace = winner.is_none_or(|current| {
            let current_priority = notification_priority(current);
            let candidate_priority = notification_priority(notification);
            candidate_priority > current_priority
                || (candidate_priority == current_priority
                    && (notification.created_at, notification.id)
                        > (current.created_at, current.id))
        });
        if replace {
            winner = Some(notification);
        }
    }

    let notification_priority = winner.map_or(0, notification_priority);
    let (agent_state, agent_reason, agent_priority) =
        slots.and_then(|slots| slots.agent_status.as_ref()).map_or(
            (AttentionState::None, AttentionReason::None, 0),
            |slot| match slot.status {
                AgentStatus::Idle => (AttentionState::None, AttentionReason::None, 0),
                AgentStatus::Running => (
                    AttentionState::Informational,
                    AttentionReason::AgentRunning,
                    1,
                ),
                AgentStatus::Completed => (
                    AttentionState::Completed,
                    AttentionReason::AgentCompleted,
                    2,
                ),
                AgentStatus::Waiting => (AttentionState::Waiting, AttentionReason::AgentWaiting, 3),
                AgentStatus::Failed => (AttentionState::Urgent, AttentionReason::AgentFailed, 4),
            },
        );

    if let Some(notification) = winner
        && notification_priority >= agent_priority
    {
        let (state, reason) = match notification.level {
            CoreNotificationLevel::Error => {
                (AttentionState::Urgent, AttentionReason::NotificationError)
            }
            CoreNotificationLevel::Warning => (
                AttentionState::Informational,
                AttentionReason::NotificationWarning,
            ),
            CoreNotificationLevel::Info => (
                AttentionState::Informational,
                AttentionReason::NotificationInfo,
            ),
        };
        let tab_pane = notification.tab_id.and_then(|tab_id| {
            workspace
                .tabs
                .get(&tab_id)
                .map(|tab| tab.pane_id.to_string())
        });
        return WorkspaceAttentionSnapshot {
            workspace_id: workspace_id.to_owned(),
            revision: 0,
            state,
            reason,
            unread_count,
            notification_id: Some(notification.id.to_string()),
            pane_id: notification
                .pane_id
                .map(|pane_id| pane_id.to_string())
                .or(tab_pane),
            tab_id: notification.tab_id.map(|tab_id| tab_id.to_string()),
        };
    }

    WorkspaceAttentionSnapshot {
        workspace_id: workspace_id.to_owned(),
        revision: 0,
        state: agent_state,
        reason: agent_reason,
        unread_count,
        notification_id: None,
        pane_id: None,
        tab_id: None,
    }
}

fn notification_priority(notification: &Notification) -> u8 {
    match notification.level {
        CoreNotificationLevel::Error => 4,
        CoreNotificationLevel::Warning | CoreNotificationLevel::Info => 1,
    }
}

fn notification_target_exists(application: &ApplicationState, notification: &Notification) -> bool {
    let Some(workspace) = application
        .workspaces
        .iter()
        .find(|workspace| workspace.id == notification.workspace_id)
    else {
        return false;
    };
    if let Some(tab_id) = notification.tab_id {
        let Some(tab) = workspace.tabs.get(&tab_id) else {
            return false;
        };
        return notification
            .pane_id
            .is_none_or(|pane_id| pane_id == tab.pane_id);
    }
    notification
        .pane_id
        .is_none_or(|pane_id| workspace.panes.contains_key(&pane_id))
}

fn notification_target_is_focused(
    application: &ApplicationState,
    notification: &Notification,
) -> bool {
    if application.selected_workspace_id != notification.workspace_id {
        return false;
    }
    let Some(workspace) = application
        .workspaces
        .iter()
        .find(|workspace| workspace.id == notification.workspace_id)
    else {
        return false;
    };
    let target_pane = notification.pane_id.or_else(|| {
        notification
            .tab_id
            .and_then(|tab_id| workspace.tabs.get(&tab_id).map(|tab| tab.pane_id))
    });
    if target_pane.is_some_and(|pane_id| workspace.selected_pane_id != pane_id) {
        return false;
    }
    if let Some(tab_id) = notification.tab_id {
        let Some(tab) = workspace.tabs.get(&tab_id) else {
            return false;
        };
        return workspace
            .panes
            .get(&tab.pane_id)
            .is_some_and(|pane| pane.selected_tab_id == tab_id);
    }
    true
}

fn same_projection(
    previous: &WorkspaceAttentionSnapshot,
    next: &WorkspaceAttentionSnapshot,
) -> bool {
    previous.workspace_id == next.workspace_id
        && previous.state == next.state
        && previous.reason == next.reason
        && previous.unread_count == next.unread_count
        && previous.notification_id == next.notification_id
        && previous.pane_id == next.pane_id
        && previous.tab_id == next.tab_id
}

fn remember_pending_acknowledgement(
    state: &mut AttentionRuntimeState,
    params: AttentionAcknowledgementParams,
) {
    if let Some(entry) = state.acknowledgements.get_mut(&params.idempotency_key) {
        entry.params = params;
        entry.result = None;
        return;
    }
    if state.acknowledgements.len() == ACKNOWLEDGEMENT_CACHE_CAPACITY {
        let oldest = state.acknowledgement_order.remove(0);
        state.acknowledgements.remove(&oldest);
    }
    state
        .acknowledgement_order
        .push(params.idempotency_key.clone());
    state.acknowledgements.insert(
        params.idempotency_key.clone(),
        AcknowledgementCacheEntry {
            params,
            result: None,
        },
    );
}

fn cached_acknowledgement(
    state: &AttentionRuntimeState,
    params: &AttentionAcknowledgementParams,
) -> Result<CachedAcknowledgement, AttentionFailure> {
    let Some(cached) = state.acknowledgements.get(&params.idempotency_key) else {
        return Ok(CachedAcknowledgement::New);
    };
    if cached.params != *params {
        return Err(AttentionFailure::IdempotencyConflict);
    }
    Ok(cached.result.clone().map_or(
        CachedAcknowledgement::Pending,
        CachedAcknowledgement::Complete,
    ))
}

fn complete_acknowledgement(
    state: &mut AttentionRuntimeState,
    idempotency_key: &str,
    result: AttentionAcknowledgementResult,
) {
    if let Some(entry) = state.acknowledgements.get_mut(idempotency_key) {
        entry.result = Some(result);
    }
}

fn forget_acknowledgement(state: &mut AttentionRuntimeState, idempotency_key: &str) {
    state.acknowledgements.remove(idempotency_key);
    state
        .acknowledgement_order
        .retain(|key| key != idempotency_key);
}

async fn load_durable_acknowledgement(
    store: Arc<SqliteStateStore>,
    idempotency_key: &str,
    request_json: &str,
) -> Result<IdempotencyLookup, AttentionFailure> {
    let idempotency_key = idempotency_key.to_owned();
    let request_json = request_json.to_owned();
    tokio::task::spawn_blocking(move || {
        store.load_idempotency_result(
            ATTENTION_ACKNOWLEDGEMENT_NAMESPACE,
            &idempotency_key,
            &request_json,
        )
    })
    .await
    .map_err(|_| AttentionFailure::Runtime)?
    .map_err(|_| AttentionFailure::Runtime)
}

fn decode_acknowledgement(value: &str) -> Result<AttentionAcknowledgementResult, AttentionFailure> {
    serde_json::from_str(value).map_err(|_| AttentionFailure::Runtime)
}

fn parse<T: DeserializeOwned>(
    id: &str,
    params: serde_json::Value,
) -> Result<T, Box<ResponseEnvelope>> {
    serde_json::from_value(params).map_err(|_| {
        Box::new(ResponseEnvelope::failure(
            id,
            "invalid_params",
            "The request parameters do not match the command contract",
        ))
    })
}

fn failure(id: String, error: &AttentionFailure) -> ResponseEnvelope {
    let (code, message) = match error {
        AttentionFailure::WorkspaceNotFound => (
            "workspace_not_found",
            "The requested workspace does not exist",
        ),
        AttentionFailure::NotificationNotFound => (
            "notification_not_found",
            "The acknowledgement target no longer exists",
        ),
        AttentionFailure::TargetUnavailable => (
            "attention_target_unavailable",
            "The exact acknowledgement target is no longer available",
        ),
        AttentionFailure::TargetNotFocused => (
            "attention_target_not_focused",
            "The exact acknowledgement target must be focused first",
        ),
        AttentionFailure::AlreadyAcknowledged => (
            "attention_already_acknowledged",
            "The notification was already acknowledged",
        ),
        AttentionFailure::RevisionConflict => (
            "revision_conflict",
            "The workspace attention revision changed before acknowledgement",
        ),
        AttentionFailure::RevisionExhausted => (
            "revision_out_of_range",
            "The workspace attention revision cannot be incremented safely",
        ),
        AttentionFailure::IdempotencyConflict => (
            "idempotency_conflict",
            "The idempotency key was already used for another acknowledgement",
        ),
        AttentionFailure::Runtime => (
            "runtime_update_failure",
            "The durable notification acknowledgement could not be committed",
        ),
    };
    ResponseEnvelope::failure(id, code, message)
}

fn now() -> Timestamp {
    use std::time::{SystemTime, UNIX_EPOCH};
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    Timestamp(
        u64::try_from(milliseconds)
            .unwrap_or(MAX_SAFE_INTEGER)
            .min(MAX_SAFE_INTEGER),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_core::{
        NotificationSource, PaneId, ShortcutPlatform, Tab, TabId, TerminalLaunchSpec, Workspace,
        WorkspaceId,
    };
    use agent_workspace_protocol::{AgentStatusCardSlot, WorkspaceCardSlotsReplaceParams};
    use agent_workspace_runtime::{BootstrapConfig, LaunchOptions, TerminalManagerBackend};
    use agent_workspace_terminal_runtime::TerminalManager;
    use proptest::prelude::*;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use tokio::time::{Duration, timeout};

    #[test]
    fn priority_order_is_strict_and_notification_wins_equal_priority() {
        assert_eq!(notification_priority_value(CoreNotificationLevel::Info), 1);
        assert_eq!(
            notification_priority_value(CoreNotificationLevel::Warning),
            1
        );
        assert_eq!(notification_priority_value(CoreNotificationLevel::Error), 4);
    }

    fn notification_priority_value(level: CoreNotificationLevel) -> u8 {
        let notification = Notification::new(
            NotificationId::new(),
            WorkspaceId::new(),
            Some(PaneId::new()),
            Some(TabId::new()),
            NotificationSource::Internal,
            level,
            "Attention",
            None,
            Timestamp(1),
        )
        .expect("valid notification");
        notification_priority(&notification)
    }

    #[test]
    fn projection_comparison_ignores_revision_only() {
        let mut left = WorkspaceAttentionSnapshot {
            workspace_id: Uuid::new_v4().to_string(),
            revision: 1,
            state: AttentionState::Waiting,
            reason: AttentionReason::AgentWaiting,
            unread_count: 0,
            notification_id: None,
            pane_id: None,
            tab_id: None,
        };
        let mut right = left.clone();
        right.revision = 99;
        assert!(same_projection(&left, &right));
        left.state = AttentionState::Urgent;
        assert!(!same_projection(&left, &right));
    }

    fn application() -> ApplicationState {
        let pane_id = PaneId::from_uuid(Uuid::from_u128(10));
        let tab = Tab::terminal(
            TabId::from_uuid(Uuid::from_u128(20)),
            pane_id,
            "shell",
            TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).expect("launch spec"),
            None,
            Timestamp(1),
        )
        .expect("tab");
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
            .expect("workspace"),
        )
        .expect("application")
    }

    fn slot(status: AgentStatus, revision: u64) -> WorkspaceCardSlotsSnapshot {
        WorkspaceCardSlotsSnapshot {
            workspace_id: Uuid::from_u128(1).to_string(),
            revision,
            agent_status: Some(agent_workspace_protocol::AgentStatusCardSlot {
                status,
                label: None,
            }),
            progress: None,
        }
    }

    fn publish(application: &mut ApplicationState, level: CoreNotificationLevel, at: u64) {
        application
            .publish_notification(
                Notification::new(
                    NotificationId::from_uuid(Uuid::from_u128(100 + u128::from(at))),
                    WorkspaceId::from_uuid(Uuid::from_u128(1)),
                    Some(PaneId::from_uuid(Uuid::from_u128(10))),
                    Some(TabId::from_uuid(Uuid::from_u128(20))),
                    NotificationSource::Internal,
                    level,
                    "bounded title",
                    Some("private body never enters attention DTO".to_owned()),
                    Timestamp(at),
                )
                .expect("notification"),
            )
            .expect("publish");
    }

    proptest! {
        #[test]
        fn fold_priority_matches_all_source_combinations(
            error_notification in any::<bool>(),
            agent_index in 0_u8..5,
        ) {
            let status = [
                AgentStatus::Idle,
                AgentStatus::Running,
                AgentStatus::Completed,
                AgentStatus::Waiting,
                AgentStatus::Failed,
            ][usize::from(agent_index)];
            let mut application = application();
            publish(
                &mut application,
                if error_notification { CoreNotificationLevel::Error } else { CoreNotificationLevel::Info },
                2,
            );
            let workspace_id = Uuid::from_u128(1).to_string();
            let slots = BTreeMap::from([(workspace_id.clone(), slot(status, 1))]);
            let folded = fold_workspace(&application, &workspace_id, slots.get(&workspace_id));
            let expected_priority = notification_priority(
                application.notifications.first().expect("notification")
            ).max(match status {
                AgentStatus::Idle => 0,
                AgentStatus::Running => 1,
                AgentStatus::Completed => 2,
                AgentStatus::Waiting => 3,
                AgentStatus::Failed => 4,
            });
            let actual_priority = match folded.state {
                AttentionState::None => 0,
                AttentionState::Informational => 1,
                AttentionState::Completed => 2,
                AttentionState::Waiting => 3,
                AttentionState::Urgent => 4,
            };
            prop_assert_eq!(actual_priority, expected_priority);
            let retention_cap = u32::try_from(agent_workspace_core::NOTIFICATION_RETENTION_CAP)
                .expect("notification retention cap fits the wire count");
            prop_assert!(folded.unread_count <= retention_cap);
        }
    }

    #[test]
    fn source_races_increment_only_changed_projection_and_never_demote() {
        let mut application = application();
        let workspace_id = Uuid::from_u128(1).to_string();
        let mut runtime = AttentionRuntimeState::default();
        let mut slots = BTreeMap::from([(workspace_id.clone(), slot(AgentStatus::Waiting, 1))]);
        apply_fold(
            &mut runtime,
            &application,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .expect("initial fold");
        assert_eq!(
            runtime.snapshots[&workspace_id].state,
            AttentionState::Waiting
        );
        assert_eq!(runtime.snapshots[&workspace_id].revision, 0);

        publish(&mut application, CoreNotificationLevel::Error, 2);
        let events = apply_fold(
            &mut runtime,
            &application,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .expect("error wins");
        assert_eq!(events.len(), 1);
        assert_eq!(
            runtime.snapshots[&workspace_id].state,
            AttentionState::Urgent
        );
        assert_eq!(runtime.snapshots[&workspace_id].revision, 1);

        slots.insert(workspace_id.clone(), slot(AgentStatus::Failed, 2));
        let events = apply_fold(
            &mut runtime,
            &application,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .expect("equal priority remains deterministic");
        assert!(events.is_empty());
        assert_eq!(
            runtime.snapshots[&workspace_id].reason,
            AttentionReason::NotificationError
        );
    }

    #[test]
    fn out_of_order_source_refresh_cannot_overwrite_a_newer_fold() {
        let base = application();
        let workspace_id = base.workspaces[0].id.to_string();
        let mut slots = BTreeMap::from([(workspace_id.clone(), slot(AgentStatus::Waiting, 2))]);
        let mut runtime = AttentionRuntimeState::default();
        apply_fold(
            &mut runtime,
            &base,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .expect("initial fold");

        let mut newer = base.clone();
        publish(&mut newer, CoreNotificationLevel::Error, 10);
        apply_fold(
            &mut runtime,
            &newer,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .expect("newer fold");
        let installed = runtime.snapshots[&workspace_id].clone();
        assert_eq!(installed.state, AttentionState::Urgent);

        slots.insert(workspace_id.clone(), slot(AgentStatus::Running, 1));
        let events = apply_fold(
            &mut runtime,
            &base,
            &slots,
            WorkspaceAttentionChangeReason::SourcesChanged,
        )
        .expect("stale refresh is ignored");
        assert!(events.is_empty());
        assert_eq!(runtime.snapshots[&workspace_id], installed);
        assert_eq!(runtime.latest_application_revision, newer.revision);
        assert_eq!(runtime.card_slot_revisions[&workspace_id], 2);
    }

    #[test]
    fn process_cache_eviction_does_not_claim_durable_retention() {
        let mut state = AttentionRuntimeState::default();
        for value in 0..=ACKNOWLEDGEMENT_CACHE_CAPACITY {
            remember_pending_acknowledgement(
                &mut state,
                AttentionAcknowledgementParams {
                    notification_id: Uuid::from_u128(10_000 + value as u128).to_string(),
                    expected_revision: value as u64,
                    idempotency_key: Uuid::from_u128(20_000 + value as u128).to_string(),
                    mode: AttentionAcknowledgementMode::Explicit,
                },
            );
        }
        assert_eq!(state.acknowledgements.len(), ACKNOWLEDGEMENT_CACHE_CAPACITY);
        assert!(
            !state
                .acknowledgements
                .contains_key(&Uuid::from_u128(20_000).to_string())
        );
    }

    #[test]
    fn process_cache_tracks_pending_completion_and_rejects_key_reuse() {
        let params = AttentionAcknowledgementParams {
            notification_id: Uuid::from_u128(2).to_string(),
            expected_revision: 4,
            idempotency_key: Uuid::from_u128(3).to_string(),
            mode: AttentionAcknowledgementMode::Focused,
        };
        let result = AttentionAcknowledgementResult {
            revision: 5,
            attention: WorkspaceAttentionSnapshot {
                workspace_id: Uuid::from_u128(1).to_string(),
                revision: 5,
                state: AttentionState::None,
                reason: AttentionReason::None,
                unread_count: 0,
                notification_id: None,
                pane_id: None,
                tab_id: None,
            },
        };
        let mut state = AttentionRuntimeState::default();
        remember_pending_acknowledgement(&mut state, params.clone());
        assert!(matches!(
            cached_acknowledgement(&state, &params),
            Ok(CachedAcknowledgement::Pending)
        ));
        complete_acknowledgement(&mut state, &params.idempotency_key, result.clone());
        assert!(matches!(
            cached_acknowledgement(&state, &params),
            Ok(CachedAcknowledgement::Complete(value)) if value == result
        ));

        let mut divergent = params.clone();
        divergent.notification_id = Uuid::from_u128(9).to_string();
        assert!(matches!(
            cached_acknowledgement(&state, &divergent),
            Err(AttentionFailure::IdempotencyConflict)
        ));

        forget_acknowledgement(&mut state, &params.idempotency_key);
        assert!(matches!(
            cached_acknowledgement(&state, &params),
            Ok(CachedAcknowledgement::New)
        ));
    }

    struct CancellationAcknowledgementFixture {
        _temp: TempDir,
        database: PathBuf,
        store: Arc<SqliteStateStore>,
        runtime: Arc<ProductionWorkspaceRuntime>,
        attention: AttentionRuntime,
        card_slots: super::super::card_slots::CardSlotRuntime,
        params: AttentionAcknowledgementParams,
    }

    async fn cancellation_acknowledgement_fixture() -> CancellationAcknowledgementFixture {
        let temp = TempDir::new().expect("temporary directory");
        let database = temp.path().join("state.sqlite3");
        let store = Arc::new(
            SqliteStateStore::open(&database, ShortcutPlatform::NonMacOs).expect("state store"),
        );
        let backend = Arc::new(TerminalManagerBackend::new(TerminalManager::new()));
        let runtime = Arc::new(
            ProductionWorkspaceRuntime::bootstrap(
                Arc::clone(&store),
                Arc::clone(&backend),
                BootstrapConfig::for_service(temp.path().to_path_buf(), Timestamp(1), 24, 80)
                    .expect("bootstrap config"),
            )
            .await
            .expect("runtime bootstrap"),
        );
        let initial = runtime.snapshot().await;
        let workspace = &initial.workspaces[0];
        let pane_id = workspace.selected_pane_id;
        let tab_id = workspace.panes[&pane_id].selected_tab_id;
        let notification_id = NotificationId::from_uuid(Uuid::from_u128(50_000));
        runtime
            .mutate(LaunchOptions::default(), move |state| {
                state.publish_notification(Notification::new(
                    notification_id,
                    state.selected_workspace_id,
                    Some(pane_id),
                    Some(tab_id),
                    NotificationSource::Internal,
                    CoreNotificationLevel::Info,
                    "attention",
                    None,
                    Timestamp(2),
                )?)
            })
            .await
            .expect("notification publish");
        let attention = AttentionRuntime::new();
        let card_slots = super::super::card_slots::CardSlotRuntime::new();
        let workspace_id = runtime.snapshot().await.selected_workspace_id.to_string();
        let snapshot = attention
            .get(runtime.as_ref(), &card_slots, &workspace_id)
            .await
            .expect("attention snapshot");
        let params = AttentionAcknowledgementParams {
            notification_id: notification_id.to_string(),
            expected_revision: snapshot.revision,
            idempotency_key: Uuid::from_u128(60_000).to_string(),
            mode: AttentionAcknowledgementMode::Explicit,
        };
        CancellationAcknowledgementFixture {
            _temp: temp,
            database,
            store,
            runtime,
            attention,
            card_slots,
            params,
        }
    }

    fn spawn_acknowledgement(
        fixture: &CancellationAcknowledgementFixture,
    ) -> tokio::task::JoinHandle<Result<AttentionAcknowledgementResult, AttentionFailure>> {
        let attention = fixture.attention.clone();
        let runtime = Arc::clone(&fixture.runtime);
        let card_slots = fixture.card_slots.clone();
        let store = Arc::clone(&fixture.store);
        let params = fixture.params.clone();
        tokio::spawn(async move {
            attention
                .acknowledge(runtime.as_ref(), &card_slots, store, params)
                .await
        })
    }

    async fn wait_until_idempotent_worker_owns_authority(
        task: &tokio::task::JoinHandle<Result<AttentionAcknowledgementResult, AttentionFailure>>,
        runtime: &ProductionWorkspaceRuntime,
    ) {
        timeout(Duration::from_secs(2), async {
            loop {
                assert!(
                    !task.is_finished(),
                    "the first acknowledgement completed before its persistence was released"
                );
                if timeout(Duration::from_millis(20), runtime.snapshot())
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the detached idempotent worker owns authority");
    }

    fn assert_durable_acknowledgement(
        fixture: &CancellationAcknowledgementFixture,
        replay: &AttentionAcknowledgementResult,
    ) {
        let request_json = serde_json::to_string(&fixture.params).expect("request serialization");
        let durable = fixture
            .store
            .load_idempotency_result(
                ATTENTION_ACKNOWLEDGEMENT_NAMESPACE,
                &fixture.params.idempotency_key,
                &request_json,
            )
            .expect("durable lookup");
        assert_eq!(
            durable,
            IdempotencyLookup::Replay(serde_json::to_string(replay).expect("result serialization"))
        );
    }

    #[tokio::test]
    async fn cancelled_acknowledgement_immediate_retry_returns_exact_durable_success() {
        let fixture = cancellation_acknowledgement_fixture().await;
        let database_lock = Connection::open(&fixture.database).expect("second SQLite connection");
        database_lock
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold write lock");
        let first = spawn_acknowledgement(&fixture);
        wait_until_idempotent_worker_owns_authority(&first, fixture.runtime.as_ref()).await;
        first.abort();
        first.await.expect_err("first caller is cancelled");

        let retry = spawn_acknowledgement(&fixture);
        tokio::task::yield_now().await;
        database_lock
            .execute_batch("ROLLBACK")
            .expect("release write lock");
        let replay = timeout(Duration::from_secs(2), retry)
            .await
            .expect("retry completes")
            .expect("retry task")
            .expect("exact durable replay");
        assert_durable_acknowledgement(&fixture, &replay);
        assert!(!fixture.runtime.snapshot().await.notifications[0].is_unread());
        fixture.runtime.shutdown().await.expect("runtime shutdown");
    }

    #[tokio::test]
    async fn source_update_while_acknowledgement_waits_is_a_revision_conflict() {
        let fixture = cancellation_acknowledgement_fixture().await;
        let serialization_gate = fixture.attention.state.lock().await;
        let acknowledgement = spawn_acknowledgement(&fixture);
        tokio::task::yield_now().await;

        let current = fixture.runtime.snapshot().await;
        let workspace = &current.workspaces[0];
        let pane_id = workspace.selected_pane_id;
        let tab_id = workspace.panes[&pane_id].selected_tab_id;
        let newer_notification_id = NotificationId::from_uuid(Uuid::from_u128(70_000));
        fixture
            .runtime
            .mutate(LaunchOptions::default(), move |state| {
                state.publish_notification(Notification::new(
                    newer_notification_id,
                    state.selected_workspace_id,
                    Some(pane_id),
                    Some(tab_id),
                    NotificationSource::Internal,
                    CoreNotificationLevel::Error,
                    "newer attention",
                    None,
                    Timestamp(3),
                )?)
            })
            .await
            .expect("source update");
        drop(serialization_gate);

        let error = acknowledgement
            .await
            .expect("acknowledgement task")
            .expect_err("the unseen projection must conflict");
        assert!(matches!(error, AttentionFailure::RevisionConflict));
        let application = fixture.runtime.snapshot().await;
        let original_id = NotificationId::from_uuid(
            Uuid::parse_str(&fixture.params.notification_id).expect("notification id"),
        );
        assert!(
            application
                .notifications
                .iter()
                .find(|notification| notification.id == original_id)
                .expect("original notification")
                .is_unread()
        );
        let attention = fixture.attention.state.lock().await;
        let workspace_id = application.selected_workspace_id.to_string();
        assert!(attention.snapshots[&workspace_id].revision > fixture.params.expected_revision);
        assert_eq!(
            attention.snapshots[&workspace_id].notification_id,
            Some(newer_notification_id.to_string())
        );
        drop(attention);
        fixture.runtime.shutdown().await.expect("runtime shutdown");
    }

    #[tokio::test]
    async fn card_slot_update_before_acknowledgement_linearization_conflicts() {
        let fixture = cancellation_acknowledgement_fixture().await;
        let serialization_gate = fixture.attention.state.lock().await;
        let acknowledgement = spawn_acknowledgement(&fixture);
        tokio::task::yield_now().await;

        let workspace_id = fixture
            .runtime
            .snapshot()
            .await
            .selected_workspace_id
            .to_string();
        fixture
            .card_slots
            .replace(
                fixture.runtime.as_ref(),
                WorkspaceCardSlotsReplaceParams {
                    workspace_id: workspace_id.clone(),
                    expected_revision: 0,
                    agent_status: Some(AgentStatusCardSlot {
                        status: AgentStatus::Failed,
                        label: None,
                    }),
                    progress: None,
                },
            )
            .await
            .expect("card-slot source update");
        drop(serialization_gate);

        let error = acknowledgement
            .await
            .expect("acknowledgement task")
            .expect_err("the unseen card-slot projection must conflict");
        assert!(matches!(error, AttentionFailure::RevisionConflict));
        let application = fixture.runtime.snapshot().await;
        assert!(application.notifications[0].is_unread());
        let attention = fixture.attention.state.lock().await;
        assert!(attention.snapshots[&workspace_id].revision > fixture.params.expected_revision);
        assert_eq!(
            attention.snapshots[&workspace_id].reason,
            AttentionReason::AgentFailed
        );
        drop(attention);
        fixture.runtime.shutdown().await.expect("runtime shutdown");
    }
}

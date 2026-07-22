use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ops::Bound::{Excluded, Unbounded},
    sync::Arc,
    time::Duration,
};

use agent_workspace_protocol::{
    EventEnvelope, MAX_CARD_SLOT_V2_RESPONSE_BYTES, ResponseEnvelope,
    WorkspaceCardSlotV2ChangeReason, WorkspaceCardSlotV2ChangedEvent, WorkspaceCardSlotV2GetParams,
    WorkspaceCardSlotV2Kind, WorkspaceCardSlotV2ReplaceParams, WorkspaceCardSlotV2Snapshot,
    WorkspaceCardSlotsChangeReason, WorkspaceCardSlotsChangedEvent,
    WorkspaceCardSlotsReplaceParams, WorkspaceCardSlotsSnapshot, WorkspaceCardSlotsSnapshotParams,
};
use agent_workspace_runtime::ProductionWorkspaceRuntime;
use serde::de::DeserializeOwned;
use tokio::sync::{Mutex, MutexGuard, broadcast, mpsc};

use super::{ControlContext, serialize_frame};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CARD_SLOT_EVENT_CAPACITY: usize = 64;
// The authoritative application is bounded to 128 workspaces and v2 has exactly nine fixed kinds.
// A valid client therefore cannot have more distinct pending invalidations than this.
const MAX_CARD_SLOT_V2_PENDING_EVENTS: usize = 128 * 9;

type CardSlotV2Key = (String, WorkspaceCardSlotV2Kind);
#[cfg(test)]
type TestBarriers = (Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>);
#[cfg(test)]
type TestBarrierSlot = Arc<Mutex<Option<TestBarriers>>>;

#[derive(Clone)]
pub(super) struct CardSlotV2Runtime {
    state: Arc<Mutex<BTreeMap<CardSlotV2Key, WorkspaceCardSlotV2Snapshot>>>,
    pub(super) events: broadcast::Sender<WorkspaceCardSlotV2ChangedEvent>,
    #[cfg(test)]
    replace_after_lock_barriers: TestBarrierSlot,
    #[cfg(test)]
    workspace_ids_after_snapshot_barriers: TestBarrierSlot,
}

impl CardSlotV2Runtime {
    pub(super) fn new() -> Self {
        let (events, _) = broadcast::channel(CARD_SLOT_EVENT_CAPACITY);
        Self {
            state: Arc::new(Mutex::new(BTreeMap::new())),
            events,
            #[cfg(test)]
            replace_after_lock_barriers: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            workspace_ids_after_snapshot_barriers: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<WorkspaceCardSlotV2ChangedEvent> {
        self.events.subscribe()
    }

    async fn get(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        params: WorkspaceCardSlotV2GetParams,
    ) -> Result<WorkspaceCardSlotV2Snapshot, CardSlotFailure> {
        ensure_workspace_exists(runtime, &params.workspace_id).await?;
        let state = self.state.lock().await;
        Ok(state
            .get(&(params.workspace_id.clone(), params.kind))
            .cloned()
            .unwrap_or_else(|| empty_v2_snapshot(params.workspace_id, params.kind)))
    }

    async fn replace(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        params: WorkspaceCardSlotV2ReplaceParams,
    ) -> Result<(WorkspaceCardSlotV2Snapshot, bool), CardSlotFailure> {
        let mut state = self.state.lock().await;
        #[cfg(test)]
        if let Some((entered, release)) = self.replace_after_lock_barriers.lock().await.clone() {
            entered.wait().await;
            release.wait().await;
        }
        ensure_workspace_exists(runtime, &params.workspace_id).await?;
        let (snapshot, changed) = replace_v2_state(&mut state, params)?;
        drop(state);
        if changed {
            let _ = self.events.send(WorkspaceCardSlotV2ChangedEvent {
                workspace_id: snapshot.workspace_id.clone(),
                kind: snapshot.kind,
                slot_revision: snapshot.slot_revision,
                reason: WorkspaceCardSlotV2ChangeReason::SlotReplaced,
            });
        }
        Ok((snapshot, changed))
    }

    pub(super) async fn workspace_ids(&self) -> BTreeSet<String> {
        let workspace_ids = self
            .state
            .lock()
            .await
            .keys()
            .map(|(workspace_id, _kind)| workspace_id.clone())
            .collect();
        #[cfg(test)]
        if let Some((entered, release)) = self
            .workspace_ids_after_snapshot_barriers
            .lock()
            .await
            .clone()
        {
            entered.wait().await;
            release.wait().await;
        }
        workspace_ids
    }

    pub(super) async fn discard_workspaces(&self, workspace_ids: &BTreeSet<String>) {
        self.state
            .lock()
            .await
            .retain(|(workspace_id, _kind), _| !workspace_ids.contains(workspace_id));
    }

    #[cfg(test)]
    pub(super) async fn contains_workspace(&self, workspace_id: &str) -> bool {
        self.state
            .lock()
            .await
            .keys()
            .any(|(candidate, _kind)| candidate == workspace_id)
    }

    #[cfg(test)]
    pub(super) async fn install_replace_after_lock_barriers(&self) -> TestBarriers {
        let barriers = (
            Arc::new(tokio::sync::Barrier::new(2)),
            Arc::new(tokio::sync::Barrier::new(2)),
        );
        *self.replace_after_lock_barriers.lock().await = Some(barriers.clone());
        barriers
    }

    #[cfg(test)]
    pub(super) async fn install_workspace_ids_after_snapshot_barriers(&self) -> TestBarriers {
        let barriers = (
            Arc::new(tokio::sync::Barrier::new(2)),
            Arc::new(tokio::sync::Barrier::new(2)),
        );
        *self.workspace_ids_after_snapshot_barriers.lock().await = Some(barriers.clone());
        barriers
    }
}

fn replace_v2_state(
    state: &mut BTreeMap<CardSlotV2Key, WorkspaceCardSlotV2Snapshot>,
    params: WorkspaceCardSlotV2ReplaceParams,
) -> Result<(WorkspaceCardSlotV2Snapshot, bool), CardSlotFailure> {
    if params
        .payload
        .as_ref()
        .is_some_and(|payload| payload.kind() != params.kind)
    {
        return Err(CardSlotFailure::PayloadKindMismatch);
    }
    let candidate = WorkspaceCardSlotV2Snapshot {
        workspace_id: params.workspace_id.clone(),
        kind: params.kind,
        slot_revision: params.expected_revision,
        payload: params.payload.clone(),
    };
    if serde_json::to_vec(&candidate)
        .map_or(true, |bytes| bytes.len() > MAX_CARD_SLOT_V2_RESPONSE_BYTES)
    {
        return Err(CardSlotFailure::ResponseTooLarge);
    }
    let key = (params.workspace_id.clone(), params.kind);
    let current = state
        .get(&key)
        .cloned()
        .unwrap_or_else(|| empty_v2_snapshot(params.workspace_id.clone(), params.kind));
    if params.expected_revision != current.slot_revision {
        return Err(CardSlotFailure::RevisionConflict);
    }
    if params.payload == current.payload {
        return Ok((current, false));
    }
    let revision = current
        .slot_revision
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(CardSlotFailure::RevisionExhausted)?;
    let snapshot = WorkspaceCardSlotV2Snapshot {
        workspace_id: params.workspace_id,
        kind: params.kind,
        slot_revision: revision,
        payload: params.payload,
    };
    if serde_json::to_vec(&snapshot)
        .map_or(true, |bytes| bytes.len() > MAX_CARD_SLOT_V2_RESPONSE_BYTES)
    {
        return Err(CardSlotFailure::ResponseTooLarge);
    }
    state.insert(key, snapshot.clone());
    Ok((snapshot, true))
}

#[derive(Clone)]
pub(super) struct CardSlotRuntime {
    state: Arc<Mutex<BTreeMap<String, WorkspaceCardSlotsSnapshot>>>,
    events: broadcast::Sender<WorkspaceCardSlotsChangedEvent>,
}

impl CardSlotRuntime {
    pub(super) fn new() -> Self {
        let (events, _) = broadcast::channel(CARD_SLOT_EVENT_CAPACITY);
        Self {
            state: Arc::new(Mutex::new(BTreeMap::new())),
            events,
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<WorkspaceCardSlotsChangedEvent> {
        self.events.subscribe()
    }

    pub(super) async fn snapshot_all(&self) -> BTreeMap<String, WorkspaceCardSlotsSnapshot> {
        self.state.lock().await.clone()
    }

    pub(super) async fn lock_snapshots(
        &self,
    ) -> MutexGuard<'_, BTreeMap<String, WorkspaceCardSlotsSnapshot>> {
        self.state.lock().await
    }

    async fn get(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        workspace_id: &str,
    ) -> Result<WorkspaceCardSlotsSnapshot, CardSlotFailure> {
        let state = self.state.lock().await;
        ensure_workspace_exists(runtime, workspace_id).await?;
        Ok(state
            .get(workspace_id)
            .cloned()
            .unwrap_or_else(|| empty_snapshot(workspace_id)))
    }

    pub(super) async fn replace(
        &self,
        runtime: &ProductionWorkspaceRuntime,
        params: WorkspaceCardSlotsReplaceParams,
    ) -> Result<(WorkspaceCardSlotsSnapshot, bool), CardSlotFailure> {
        let mut state = self.state.lock().await;
        ensure_workspace_exists(runtime, &params.workspace_id).await?;
        let (snapshot, changed) = replace_state(&mut state, params)?;
        if changed {
            let _ = self.events.send(WorkspaceCardSlotsChangedEvent {
                workspace_id: snapshot.workspace_id.clone(),
                slot_revision: snapshot.revision,
                reason: WorkspaceCardSlotsChangeReason::SlotsReplaced,
            });
        }
        Ok((snapshot, changed))
    }

    pub(super) async fn workspace_ids(&self) -> BTreeSet<String> {
        self.state.lock().await.keys().cloned().collect()
    }

    pub(super) async fn discard_workspaces(&self, workspace_ids: &BTreeSet<String>) {
        self.state
            .lock()
            .await
            .retain(|workspace_id, _| !workspace_ids.contains(workspace_id));
    }

    #[cfg(test)]
    pub(super) async fn contains_workspace(&self, workspace_id: &str) -> bool {
        self.state.lock().await.contains_key(workspace_id)
    }
}

#[derive(Debug)]
pub(super) enum CardSlotFailure {
    WorkspaceNotFound,
    RevisionConflict,
    RevisionExhausted,
    PayloadKindMismatch,
    ResponseTooLarge,
}

pub(super) fn is_command(command: &str) -> bool {
    matches!(
        command,
        "workspace.cardSlots.get" | "workspace.cardSlots.replace"
    )
}

pub(super) fn is_v2_command(command: &str) -> bool {
    matches!(
        command,
        "workspace.cardSlots.v2.get" | "workspace.cardSlots.v2.replace"
    )
}

pub(super) async fn dispatch_v2(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
) -> ResponseEnvelope {
    let (Some(runtime), Some(card_slots)) = (&context.runtime, &context.card_slots_v2) else {
        return ResponseEnvelope::failure(
            id,
            "unknown_command",
            format!("Unknown command: {command}"),
        );
    };
    let result = match command {
        "workspace.cardSlots.v2.get" => {
            let params = match parse::<WorkspaceCardSlotV2GetParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            card_slots.get(runtime, params).await
        }
        "workspace.cardSlots.v2.replace" => {
            let params = match parse::<WorkspaceCardSlotV2ReplaceParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            card_slots
                .replace(runtime, params)
                .await
                .map(|(snapshot, _)| snapshot)
        }
        _ => unreachable!("card-slot v2 dispatcher receives only known commands"),
    };
    match result {
        Ok(snapshot) => ResponseEnvelope::success(
            id,
            serde_json::to_value(snapshot).expect("card-slot v2 serialization is infallible"),
        ),
        Err(CardSlotFailure::WorkspaceNotFound) => ResponseEnvelope::failure(
            id,
            "workspace_not_found",
            "The requested workspace does not exist",
        ),
        Err(CardSlotFailure::RevisionConflict) => ResponseEnvelope::failure(
            id,
            "revision_conflict",
            "The workspace card-slot revision changed before this replacement",
        ),
        Err(CardSlotFailure::RevisionExhausted) => ResponseEnvelope::failure(
            id,
            "revision_out_of_range",
            "The workspace card-slot revision cannot be incremented safely",
        ),
        Err(CardSlotFailure::PayloadKindMismatch) => ResponseEnvelope::failure(
            id,
            "invalid_params",
            "The tagged payload kind must match the requested slot kind",
        ),
        Err(CardSlotFailure::ResponseTooLarge) => ResponseEnvelope::failure(
            id,
            "card_slot_too_large",
            "The serialized card-slot response exceeds 16 KiB",
        ),
    }
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
) -> ResponseEnvelope {
    let (Some(runtime), Some(card_slots)) = (&context.runtime, &context.card_slots) else {
        return ResponseEnvelope::failure(
            id,
            "unknown_command",
            format!("Unknown command: {command}"),
        );
    };
    let result = match command {
        "workspace.cardSlots.get" => {
            let params = match parse::<WorkspaceCardSlotsSnapshotParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            card_slots.get(runtime, &params.workspace_id).await
        }
        "workspace.cardSlots.replace" => {
            let params = match parse::<WorkspaceCardSlotsReplaceParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            card_slots
                .replace(runtime, params)
                .await
                .map(|(snapshot, _changed)| snapshot)
        }
        _ => unreachable!("card-slot dispatcher receives only known commands"),
    };
    match result {
        Ok(snapshot) => ResponseEnvelope::success(
            id,
            serde_json::to_value(snapshot).expect("card-slot snapshot serialization is infallible"),
        ),
        Err(CardSlotFailure::WorkspaceNotFound) => ResponseEnvelope::failure(
            id,
            "workspace_not_found",
            "The requested workspace does not exist",
        ),
        Err(CardSlotFailure::RevisionConflict) => ResponseEnvelope::failure(
            id,
            "revision_conflict",
            "The workspace card-slot revision changed before this replacement",
        ),
        Err(CardSlotFailure::RevisionExhausted) => ResponseEnvelope::failure(
            id,
            "revision_out_of_range",
            "The workspace card-slot revision cannot be incremented safely",
        ),
        Err(CardSlotFailure::PayloadKindMismatch | CardSlotFailure::ResponseTooLarge) => {
            unreachable!("v1 payload cannot produce a v2 validation failure")
        }
    }
}

#[allow(clippy::too_many_lines)]
pub(super) async fn forward_v2_events(
    runtime: CardSlotV2Runtime,
    mut receiver: broadcast::Receiver<WorkspaceCardSlotV2ChangedEvent>,
    sender: mpsc::Sender<Vec<u8>>,
    scope: Option<super::multi_window::WindowEventScope>,
) {
    let mut pending = BTreeMap::<CardSlotV2Key, WorkspaceCardSlotV2ChangedEvent>::new();
    let mut order = VecDeque::<CardSlotV2Key>::new();
    let mut resync_all = false;
    let mut resync_cursor: Option<CardSlotV2Key> = None;
    let mut retry = tokio::time::interval(Duration::from_millis(10));
    loop {
        tokio::select! {
            next_event = receiver.recv() => {
                match next_event {
                    Ok(event) => {
                        if let Some(scope) = &scope
                            && !scope.owns_workspace(&event.workspace_id).await
                        {
                            continue;
                        }
                        if !queue_v2_event(&mut pending, &mut order, event) {
                            pending.clear();
                            order.clear();
                            resync_all = true;
                            resync_cursor = None;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        pending.clear();
                        order.clear();
                        resync_all = true;
                        resync_cursor = None;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            _ = retry.tick(), if !pending.is_empty() || resync_all => {}
        }
        while resync_all {
            let next = {
                let state = runtime.state.lock().await;
                match &resync_cursor {
                    Some(cursor) => state
                        .range((Excluded(cursor.clone()), Unbounded))
                        .next()
                        .map(|(key, snapshot)| (key.clone(), snapshot.clone())),
                    None => state
                        .first_key_value()
                        .map(|(key, snapshot)| (key.clone(), snapshot.clone())),
                }
            };
            let Some((key, snapshot)) = next else {
                resync_all = false;
                resync_cursor = None;
                break;
            };
            let event = WorkspaceCardSlotV2ChangedEvent {
                workspace_id: snapshot.workspace_id,
                kind: snapshot.kind,
                slot_revision: snapshot.slot_revision,
                reason: WorkspaceCardSlotV2ChangeReason::ResyncRequired,
            };
            if let Some(scope) = &scope
                && !scope.owns_workspace(&event.workspace_id).await
            {
                resync_cursor = Some(key);
                continue;
            }
            let envelope = EventEnvelope {
                event: "workspace.cardSlots.v2Changed".to_owned(),
                revision: None,
                data: serde_json::to_value(event)
                    .expect("card-slot v2 event serialization is infallible"),
            };
            let Ok(frame) = serialize_frame(&envelope) else {
                resync_cursor = Some(key);
                continue;
            };
            match sender.try_send(frame) {
                Ok(()) => resync_cursor = Some(key),
                Err(mpsc::error::TrySendError::Full(_)) => break,
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            }
        }
        if resync_all {
            continue;
        }
        while let Some(key) = order.front().cloned() {
            let Some(event) = pending.get(&key) else {
                order.pop_front();
                continue;
            };
            if let Some(scope) = &scope
                && !scope.owns_workspace(&event.workspace_id).await
            {
                pending.remove(&key);
                order.pop_front();
                continue;
            }
            let envelope = EventEnvelope {
                event: "workspace.cardSlots.v2Changed".to_owned(),
                revision: None,
                data: serde_json::to_value(event)
                    .expect("card-slot v2 event serialization is infallible"),
            };
            let Ok(frame) = serialize_frame(&envelope) else {
                pending.remove(&key);
                order.pop_front();
                continue;
            };
            match sender.try_send(frame) {
                Ok(()) => {
                    pending.remove(&key);
                    order.pop_front();
                }
                Err(mpsc::error::TrySendError::Full(_)) => break,
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            }
        }
    }
}

fn queue_v2_event(
    pending: &mut BTreeMap<CardSlotV2Key, WorkspaceCardSlotV2ChangedEvent>,
    order: &mut VecDeque<CardSlotV2Key>,
    event: WorkspaceCardSlotV2ChangedEvent,
) -> bool {
    let key = (event.workspace_id.clone(), event.kind);
    if let Some(current) = pending.get_mut(&key) {
        current.slot_revision = current.slot_revision.max(event.slot_revision);
        if event.reason == WorkspaceCardSlotV2ChangeReason::ResyncRequired {
            current.reason = WorkspaceCardSlotV2ChangeReason::ResyncRequired;
        }
        true
    } else if pending.len() < MAX_CARD_SLOT_V2_PENDING_EVENTS {
        order.push_back(key.clone());
        pending.insert(key, event);
        true
    } else {
        false
    }
}

pub(super) async fn forward_events(
    runtime: CardSlotRuntime,
    mut receiver: broadcast::Receiver<WorkspaceCardSlotsChangedEvent>,
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
                .values()
                .map(|snapshot| WorkspaceCardSlotsChangedEvent {
                    workspace_id: snapshot.workspace_id.clone(),
                    slot_revision: snapshot.revision,
                    reason: WorkspaceCardSlotsChangeReason::SlotsReplaced,
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
                event: "workspace.cardSlotsChanged".to_owned(),
                revision: None,
                data: serde_json::to_value(event)
                    .expect("card-slot event serialization is infallible"),
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

async fn ensure_workspace_exists(
    runtime: &ProductionWorkspaceRuntime,
    workspace_id: &str,
) -> Result<(), CardSlotFailure> {
    runtime
        .snapshot()
        .await
        .workspaces
        .iter()
        .any(|workspace| workspace.id.to_string() == workspace_id)
        .then_some(())
        .ok_or(CardSlotFailure::WorkspaceNotFound)
}

fn empty_snapshot(workspace_id: &str) -> WorkspaceCardSlotsSnapshot {
    WorkspaceCardSlotsSnapshot {
        workspace_id: workspace_id.to_owned(),
        revision: 0,
        agent_status: None,
        progress: None,
    }
}

fn empty_v2_snapshot(
    workspace_id: String,
    kind: WorkspaceCardSlotV2Kind,
) -> WorkspaceCardSlotV2Snapshot {
    WorkspaceCardSlotV2Snapshot {
        workspace_id,
        kind,
        slot_revision: 0,
        payload: None,
    }
}

fn replace_state(
    state: &mut BTreeMap<String, WorkspaceCardSlotsSnapshot>,
    params: WorkspaceCardSlotsReplaceParams,
) -> Result<(WorkspaceCardSlotsSnapshot, bool), CardSlotFailure> {
    let current = state
        .get(&params.workspace_id)
        .cloned()
        .unwrap_or_else(|| empty_snapshot(&params.workspace_id));
    if params.expected_revision != current.revision {
        return Err(CardSlotFailure::RevisionConflict);
    }
    if current.agent_status == params.agent_status && current.progress == params.progress {
        return Ok((current, false));
    }
    let Some(revision) = current.revision.checked_add(1) else {
        return Err(CardSlotFailure::RevisionExhausted);
    };
    if revision > MAX_SAFE_INTEGER {
        return Err(CardSlotFailure::RevisionExhausted);
    }
    let snapshot = WorkspaceCardSlotsSnapshot {
        workspace_id: params.workspace_id,
        revision,
        agent_status: params.agent_status,
        progress: params.progress,
    };
    state.insert(snapshot.workspace_id.clone(), snapshot.clone());
    Ok((snapshot, true))
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

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_protocol::{
        AgentStatus, AgentStatusCardSlot, LogTailCardSlot, ProgressCardSlot,
        WorkspaceCardSlotV2Payload,
    };

    const WORKSPACE_ID: &str = "10000000-0000-4000-8000-000000000001";

    fn replacement(expected_revision: u64) -> WorkspaceCardSlotsReplaceParams {
        WorkspaceCardSlotsReplaceParams {
            workspace_id: WORKSPACE_ID.to_owned(),
            expected_revision,
            agent_status: Some(AgentStatusCardSlot {
                status: AgentStatus::Running,
                label: Some("Reviewing changes".to_owned()),
            }),
            progress: Some(ProgressCardSlot::Determinate {
                value: 42,
                label: Some("Tests".to_owned()),
            }),
        }
    }

    #[test]
    fn state_replace_conflict_noop_and_restart_are_independent() {
        let mut state = BTreeMap::new();
        let (snapshot, changed) = replace_state(&mut state, replacement(0)).expect("first replace");
        assert!(changed);
        assert_eq!(snapshot.revision, 1);

        let (same, changed) = replace_state(&mut state, replacement(1)).expect("no-op replace");
        assert!(!changed);
        assert_eq!(same, snapshot);
        assert!(matches!(
            replace_state(&mut state, replacement(0)),
            Err(CardSlotFailure::RevisionConflict)
        ));

        let restarted_state: BTreeMap<String, WorkspaceCardSlotsSnapshot> = BTreeMap::new();
        assert_eq!(empty_snapshot(WORKSPACE_ID).revision, 0);
        assert!(restarted_state.is_empty());
    }

    #[tokio::test]
    async fn changed_state_emits_only_the_targeted_bounded_invalidation() {
        let runtime = CardSlotRuntime::new();
        let mut events = runtime.subscribe();
        let _ = runtime.events.send(WorkspaceCardSlotsChangedEvent {
            workspace_id: WORKSPACE_ID.to_owned(),
            slot_revision: 1,
            reason: WorkspaceCardSlotsChangeReason::SlotsReplaced,
        });
        let event = events.recv().await.expect("targeted event");
        assert_eq!(event.workspace_id, WORKSPACE_ID);
        assert_eq!(event.slot_revision, 1);
        assert_eq!(event.reason, WorkspaceCardSlotsChangeReason::SlotsReplaced);
    }

    #[test]
    fn v2_storm_stays_bounded_and_does_not_invalidate_unrelated_kinds() {
        let mut state = BTreeMap::new();
        let mut revision = 0;
        for index in 0..10_000 {
            let (snapshot, changed) = replace_v2_state(
                &mut state,
                WorkspaceCardSlotV2ReplaceParams {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    kind: WorkspaceCardSlotV2Kind::LogTail,
                    expected_revision: revision,
                    payload: Some(WorkspaceCardSlotV2Payload::LogTail(LogTailCardSlot {
                        lines: vec![format!("bounded line {index}")],
                        truncated: index > 19,
                    })),
                },
            )
            .expect("bounded replacement");
            assert!(changed);
            revision = snapshot.slot_revision;
        }
        assert_eq!(revision, 10_000);
        assert_eq!(state.len(), 1);
        assert!(state.contains_key(&(WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::LogTail)));
        assert!(!state.contains_key(&(WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::Progress)));

        let same_payload = state
            .get(&(WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::LogTail))
            .and_then(|snapshot| snapshot.payload.clone());
        let (_, changed) = replace_v2_state(
            &mut state,
            WorkspaceCardSlotV2ReplaceParams {
                workspace_id: WORKSPACE_ID.to_owned(),
                kind: WorkspaceCardSlotV2Kind::LogTail,
                expected_revision: revision,
                payload: same_payload,
            },
        )
        .expect("semantic no-op");
        assert!(!changed);
    }

    #[tokio::test]
    async fn v2_event_queue_reports_lag_and_workspace_retention_clears_every_kind() {
        let runtime = CardSlotV2Runtime::new();
        let mut receiver = runtime.subscribe();
        for revision in 1..=CARD_SLOT_EVENT_CAPACITY + 1 {
            let _ = runtime.events.send(WorkspaceCardSlotV2ChangedEvent {
                workspace_id: WORKSPACE_ID.to_owned(),
                kind: WorkspaceCardSlotV2Kind::Progress,
                slot_revision: revision as u64,
                reason: WorkspaceCardSlotV2ChangeReason::SlotReplaced,
            });
        }
        assert!(matches!(
            receiver.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));

        runtime.state.lock().await.insert(
            (WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::Progress),
            empty_v2_snapshot(WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::Progress),
        );
        runtime.state.lock().await.insert(
            (WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::Ssh),
            empty_v2_snapshot(WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::Ssh),
        );
        runtime
            .discard_workspaces(&BTreeSet::from([WORKSPACE_ID.to_owned()]))
            .await;
        assert!(runtime.state.lock().await.is_empty());
    }

    #[test]
    fn v2_pending_invalidations_coalesce_latest_revision_and_preserve_resync() {
        let mut pending = BTreeMap::new();
        let mut order = VecDeque::new();
        for (revision, reason) in [
            (3, WorkspaceCardSlotV2ChangeReason::SlotReplaced),
            (5, WorkspaceCardSlotV2ChangeReason::ResyncRequired),
            (7, WorkspaceCardSlotV2ChangeReason::SlotReplaced),
        ] {
            queue_v2_event(
                &mut pending,
                &mut order,
                WorkspaceCardSlotV2ChangedEvent {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    kind: WorkspaceCardSlotV2Kind::LogTail,
                    slot_revision: revision,
                    reason,
                },
            );
        }

        assert_eq!(pending.len(), 1);
        assert_eq!(order.len(), 1);
        let event = pending
            .get(&(WORKSPACE_ID.to_owned(), WorkspaceCardSlotV2Kind::LogTail))
            .expect("coalesced invalidation must remain queued");
        assert_eq!(event.slot_revision, 7);
        assert_eq!(
            event.reason,
            WorkspaceCardSlotV2ChangeReason::ResyncRequired
        );
    }

    #[test]
    fn v2_pending_invalidations_have_an_explicit_per_client_memory_bound() {
        let mut pending = BTreeMap::new();
        let mut order = VecDeque::new();
        for index in 0..MAX_CARD_SLOT_V2_PENDING_EVENTS {
            assert!(queue_v2_event(
                &mut pending,
                &mut order,
                WorkspaceCardSlotV2ChangedEvent {
                    workspace_id: format!("workspace-{index}"),
                    kind: WorkspaceCardSlotV2Kind::Progress,
                    slot_revision: 1,
                    reason: WorkspaceCardSlotV2ChangeReason::SlotReplaced,
                },
            ));
        }

        assert_eq!(pending.len(), MAX_CARD_SLOT_V2_PENDING_EVENTS);
        assert_eq!(order.len(), MAX_CARD_SLOT_V2_PENDING_EVENTS);
        assert_eq!(
            order.front(),
            Some(&("workspace-0".to_owned(), WorkspaceCardSlotV2Kind::Progress))
        );

        assert!(queue_v2_event(
            &mut pending,
            &mut order,
            WorkspaceCardSlotV2ChangedEvent {
                workspace_id: "workspace-0".to_owned(),
                kind: WorkspaceCardSlotV2Kind::Progress,
                slot_revision: 9,
                reason: WorkspaceCardSlotV2ChangeReason::ResyncRequired,
            },
        ));
        let coalesced = pending
            .get(&("workspace-0".to_owned(), WorkspaceCardSlotV2Kind::Progress))
            .expect("an existing key remains coalescible at capacity");
        assert_eq!(coalesced.slot_revision, 9);
        assert_eq!(
            coalesced.reason,
            WorkspaceCardSlotV2ChangeReason::ResyncRequired
        );
        assert_eq!(pending.len(), MAX_CARD_SLOT_V2_PENDING_EVENTS);
        assert_eq!(order.len(), MAX_CARD_SLOT_V2_PENDING_EVENTS);

        assert!(!queue_v2_event(
            &mut pending,
            &mut order,
            WorkspaceCardSlotV2ChangedEvent {
                workspace_id: "legacy-overflow-workspace".to_owned(),
                kind: WorkspaceCardSlotV2Kind::Progress,
                slot_revision: 1,
                reason: WorkspaceCardSlotV2ChangeReason::SlotReplaced,
            },
        ));
        assert_eq!(pending.len(), MAX_CARD_SLOT_V2_PENDING_EVENTS);
        assert_eq!(order.len(), MAX_CARD_SLOT_V2_PENDING_EVENTS);
    }

    #[tokio::test]
    async fn v2_overflow_resync_streams_legacy_state_without_an_unbounded_queue() {
        let runtime = CardSlotV2Runtime::new();
        let legacy_count = MAX_CARD_SLOT_V2_PENDING_EVENTS + 1;
        {
            let mut state = runtime.state.lock().await;
            for index in 0..legacy_count {
                let workspace_id = format!("10000000-0000-4000-8000-{index:012x}");
                state.insert(
                    (workspace_id.clone(), WorkspaceCardSlotV2Kind::Progress),
                    WorkspaceCardSlotV2Snapshot {
                        workspace_id,
                        kind: WorkspaceCardSlotV2Kind::Progress,
                        slot_revision: 7,
                        payload: None,
                    },
                );
            }
        }
        let event_subscription = runtime.subscribe();
        let (sender, mut frames) = mpsc::channel(legacy_count + 1);
        let forwarder = tokio::spawn(forward_v2_events(
            runtime.clone(),
            event_subscription,
            sender,
            None,
        ));
        for revision in 1..=CARD_SLOT_EVENT_CAPACITY + 1 {
            let _ = runtime.events.send(WorkspaceCardSlotV2ChangedEvent {
                workspace_id: WORKSPACE_ID.to_owned(),
                kind: WorkspaceCardSlotV2Kind::Progress,
                slot_revision: revision as u64,
                reason: WorkspaceCardSlotV2ChangeReason::SlotReplaced,
            });
        }

        let resync_count = tokio::time::timeout(Duration::from_secs(2), async {
            let mut frame_count = 0;
            while frame_count < legacy_count {
                let frame = frames.recv().await.expect("resync frame must arrive");
                let envelope: EventEnvelope = serde_json::from_slice(&frame)
                    .expect("resync frame must be a valid event envelope");
                let event: WorkspaceCardSlotV2ChangedEvent = serde_json::from_value(envelope.data)
                    .expect("resync data must match the v2 event contract");
                assert_eq!(
                    event.reason,
                    WorkspaceCardSlotV2ChangeReason::ResyncRequired
                );
                frame_count += 1;
            }
            frame_count
        })
        .await
        .expect("legacy resync must make bounded forward progress");
        assert_eq!(resync_count, legacy_count);
        forwarder.abort();
    }
}

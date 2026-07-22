//! Authenticated newline-delimited JSON server over a per-user local transport.

use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    future::Future,
    io,
    sync::Arc,
    time::{Duration, Instant},
};

use agent_workspace_config::{ConfigStore, LogLevel};
use agent_workspace_core::ShortcutPlatform;
use agent_workspace_protocol::{
    AGENT_SESSIONS_CAPABILITY, AuthEnvelope, EventEnvelope, MAX_CONTROL_MESSAGE_BYTES,
    MAX_TERMINAL_CHECKPOINT_WIRE_BYTES, MAX_TERMINAL_LISTENING_PORTS, NotificationLevel,
    NotificationPublishParams, NotificationSource, NotificationTarget, RequestEnvelope,
    ResponseEnvelope, SIDEBAR_SURFACES_CAPABILITY, ServiceShuttingDownEvent, TerminalActiveBuffer,
    TerminalAttachParams, TerminalAttachResult, TerminalCheckpointParams,
    TerminalCheckpointRequestedEvent, TerminalDescriptor, TerminalDetachParams,
    TerminalExitedEvent, TerminalOutputChunk, TerminalOutputEvent, TerminalResizeParams,
    TerminalResizedEvent, TerminalRuntimeMetadataParams, TerminalRuntimeMetadataResult,
    TerminalSendParams,
};
#[cfg(test)]
use agent_workspace_protocol::{
    TerminalCreateParams, TerminalCreateResult, TerminalTerminateParams,
};
use agent_workspace_runtime::{ProductionWorkspaceRuntime, TerminalManagerBackend};
use agent_workspace_storage::SqliteStateStore;
use agent_workspace_terminal_runtime::{
    ActiveBuffer, TerminalCheckpoint as RuntimeCheckpoint, TerminalDescriptor as RuntimeDescriptor,
    TerminalError, TerminalEvent as RuntimeEvent, TerminalIoHandle,
    TerminalOutputChunk as RuntimeChunk, TerminalSnapshot,
};
#[cfg(test)]
use agent_workspace_terminal_runtime::{TerminalManager, TerminalSpawnRequest};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use interprocess::local_socket::tokio::{Stream, prelude::*};
use serde::{Serialize, de::DeserializeOwned};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, broadcast, mpsc, watch},
    task::{AbortHandle, JoinSet},
};
use tracing::{debug, warn};
use uuid::Uuid;

const MAX_AUTH_FAILURES: usize = 5;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(10);
const MAX_CLIENTS: usize = 32;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_mins(30);
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_HANDLERS_PER_CLIENT: usize = 16;
const REPLAY_CACHE_CAPACITY: usize = 256;
const REPLAY_CACHE_MAX_BYTES: usize = 4 * MAX_CONTROL_MESSAGE_BYTES;

mod actions;
mod agent_sessions;
mod attention;
mod browser_automation;
mod card_slots;
mod custom_actions;
mod layouts;
mod milestone2;
mod milestone5;
mod multi_window;
mod organization;
mod remote_sessions;
mod sidebar_content;

/// Single-use process-session proof accepted only for desktop-provider registration.
pub struct DesktopProviderBootstrapSecret(Vec<u8>);

impl DesktopProviderBootstrapSecret {
    /// Wrap a freshly-generated provider proof. The proof is intentionally distinct from the
    /// ordinary control token and is consumed by the first successful registration.
    ///
    /// # Errors
    /// Returns [`ServerError::WeakDesktopProviderBootstrapSecret`] for proofs shorter than 32 bytes.
    pub fn new(proof: impl AsRef<[u8]>) -> Result<Self, ServerError> {
        let proof = proof.as_ref();
        if proof.len() < 32 {
            return Err(ServerError::WeakDesktopProviderBootstrapSecret);
        }
        Ok(Self(proof.to_vec()))
    }
}

impl std::fmt::Debug for DesktopProviderBootstrapSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DesktopProviderBootstrapSecret([REDACTED])")
    }
}

/// Process-local owner for the active structured-log filter.
///
/// The callback is installed only after the global tracing subscriber is active. Updating the
/// level is deliberately infallible so configuration persistence and other fallible runtime
/// mutations can complete before the final live swap.
#[derive(Clone)]
pub struct LoggingRuntime {
    update: Arc<dyn Fn(LogLevel) + Send + Sync>,
}

impl LoggingRuntime {
    /// Create a runtime owner around an infallible live filter update.
    pub fn new(update: impl Fn(LogLevel) + Send + Sync + 'static) -> Self {
        Self {
            update: Arc::new(update),
        }
    }

    /// Apply a new level to subsequent tracing events.
    pub fn set_level(&self, level: LogLevel) {
        (self.update)(level);
    }
}

/// Durable services used by Milestone 5 configuration and desktop-window commands.
///
/// The locks are intentionally shareable so every control server instance that targets the same
/// files can serialize its read/compare/write sequences.
#[derive(Clone)]
pub struct PersistenceServices {
    config_store: Arc<ConfigStore>,
    state_store: Arc<SqliteStateStore>,
    configuration_lock: Arc<Mutex<()>>,
    window_state_lock: Arc<Mutex<()>>,
}

impl PersistenceServices {
    /// Create persistence services with process-local serialization locks.
    #[must_use]
    pub fn new(config_store: Arc<ConfigStore>, state_store: Arc<SqliteStateStore>) -> Self {
        Self::with_locks(
            config_store,
            state_store,
            Arc::new(Mutex::new(())),
            Arc::new(Mutex::new(())),
        )
    }

    /// Create persistence services with caller-owned serialization locks.
    #[must_use]
    pub fn with_locks(
        config_store: Arc<ConfigStore>,
        state_store: Arc<SqliteStateStore>,
        configuration_lock: Arc<Mutex<()>>,
        window_state_lock: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            config_store,
            state_store,
            configuration_lock,
            window_state_lock,
        }
    }
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("the control token must contain at least 256 bits of entropy")]
    WeakControlToken,
    #[error("the desktop-provider bootstrap proof must contain at least 256 bits of entropy")]
    WeakDesktopProviderBootstrapSecret,
    #[error("could not prepare the local transport: {0}")]
    Transport(#[from] io::Error),
}

pub struct ControlServer {
    listener: LocalSocketListener,
    token: Arc<[u8]>,
    auth_limiter: Arc<Mutex<AuthFailureLimiter>>,
    client_slots: Arc<tokio::sync::Semaphore>,
    context: ControlContext,
}

#[derive(Clone)]
struct ControlContext {
    terminal_io: TerminalIoHandle,
    terminal_backend: Option<TerminalManagerBackend>,
    logging_runtime: Option<LoggingRuntime>,
    #[cfg(test)]
    terminal_lifecycle: TerminalLifecycle,
    runtime: Option<Arc<ProductionWorkspaceRuntime>>,
    persistence: Option<PersistenceServices>,
    card_slots: Option<card_slots::CardSlotRuntime>,
    card_slots_v2: Option<card_slots::CardSlotV2Runtime>,
    attention: Option<attention::AttentionRuntime>,
    actions: Option<actions::ActionRuntime>,
    browser_automation: Option<browser_automation::BrowserAutomationRuntime>,
    agent_sessions: Option<agent_sessions::AgentSessionControlRuntime>,
    remote_sessions: Option<remote_sessions::RemoteSessionControlRuntime>,
    sidebar_content: Option<sidebar_content::SidebarContentRuntime>,
    multi_window: Option<multi_window::MultiWindowRuntime>,
    platform: ShortcutPlatform,
}

impl ControlContext {
    async fn prune_ephemeral_workspace_state(&self) {
        let Some(runtime) = &self.runtime else {
            return;
        };
        // Sample only keys that already exist before consulting authoritative state. A workspace
        // created concurrently after this sample can therefore never be mistaken for stale state.
        let mut tracked_workspace_ids = BTreeSet::new();
        if let Some(card_slots) = &self.card_slots {
            tracked_workspace_ids.extend(card_slots.workspace_ids().await);
        }
        if let Some(card_slots) = &self.card_slots_v2 {
            tracked_workspace_ids.extend(card_slots.workspace_ids().await);
        }
        let current_workspace_ids = runtime
            .snapshot()
            .await
            .workspaces
            .iter()
            .map(|workspace| workspace.id.to_string())
            .collect::<BTreeSet<_>>();
        let stale_workspace_ids = tracked_workspace_ids
            .difference(&current_workspace_ids)
            .cloned()
            .collect::<BTreeSet<_>>();
        if stale_workspace_ids.is_empty() {
            return;
        }
        if let Some(card_slots) = &self.card_slots {
            card_slots.discard_workspaces(&stale_workspace_ids).await;
        }
        if let Some(card_slots) = &self.card_slots_v2 {
            card_slots.discard_workspaces(&stale_workspace_ids).await;
        }
    }
}

#[cfg(test)]
#[derive(Clone)]
enum TerminalLifecycle {
    WorkspaceManaged,
    LegacyTest(TerminalManager),
}

impl ControlServer {
    /// Bind a local transport after validating its directory and token.
    ///
    /// # Errors
    ///
    /// Returns an error when the token is too short or the local transport cannot be prepared.
    #[cfg(test)]
    fn bind_legacy_for_test(endpoint: &str, token: impl AsRef<[u8]>) -> Result<Self, ServerError> {
        let terminals = TerminalManager::new();
        let terminal_io = terminals.io_handle();
        Self::bind_inner(
            endpoint,
            token,
            ControlContext {
                terminal_io,
                terminal_backend: None,
                logging_runtime: None,
                terminal_lifecycle: TerminalLifecycle::LegacyTest(terminals),
                runtime: None,
                persistence: None,
                card_slots: None,
                card_slots_v2: None,
                attention: None,
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: None,
                platform: ShortcutPlatform::NonMacOs,
            },
        )
    }

    /// Bind the production service to an already-bootstrapped workspace runtime and its
    /// capability-restricted terminal I/O handle.
    ///
    /// # Errors
    /// Returns an error when the token or local transport is invalid.
    pub fn bind_with_runtime(
        endpoint: &str,
        token: impl AsRef<[u8]>,
        runtime: Arc<ProductionWorkspaceRuntime>,
        backend: &TerminalManagerBackend,
        platform: ShortcutPlatform,
    ) -> Result<Self, ServerError> {
        Self::bind_inner(
            endpoint,
            token,
            ControlContext {
                terminal_io: backend.terminal_io().clone(),
                terminal_backend: Some(backend.clone()),
                logging_runtime: None,
                #[cfg(test)]
                terminal_lifecycle: TerminalLifecycle::WorkspaceManaged,
                runtime: Some(runtime),
                persistence: None,
                card_slots: None,
                card_slots_v2: None,
                attention: None,
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: None,
                platform,
            },
        )
    }

    /// Bind the production service with Milestone 5 durable configuration and window-state
    /// commands enabled.
    ///
    /// # Errors
    /// Returns an error when the token or local transport is invalid.
    pub fn bind_with_runtime_and_persistence(
        endpoint: &str,
        token: impl AsRef<[u8]>,
        runtime: Arc<ProductionWorkspaceRuntime>,
        backend: &TerminalManagerBackend,
        platform: ShortcutPlatform,
        logging_runtime: LoggingRuntime,
        persistence: PersistenceServices,
    ) -> Result<Self, ServerError> {
        Self::bind_inner(
            endpoint,
            token,
            ControlContext {
                terminal_io: backend.terminal_io().clone(),
                terminal_backend: Some(backend.clone()),
                logging_runtime: Some(logging_runtime),
                #[cfg(test)]
                terminal_lifecycle: TerminalLifecycle::WorkspaceManaged,
                runtime: Some(runtime),
                persistence: Some(persistence),
                card_slots: None,
                card_slots_v2: None,
                attention: None,
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: None,
                platform,
            },
        )
    }

    /// Bind production persistence plus the private desktop-provider and multi-window control
    /// plane. Callers must remove the inherited bootstrap proof from their environment before
    /// invoking this constructor.
    ///
    /// # Errors
    /// Returns a transport, authentication, persistence, or provider-bootstrap setup error.
    #[allow(clippy::too_many_arguments)]
    pub fn bind_with_runtime_persistence_and_multi_window(
        endpoint: &str,
        token: impl AsRef<[u8]>,
        runtime: Arc<ProductionWorkspaceRuntime>,
        backend: &TerminalManagerBackend,
        platform: ShortcutPlatform,
        logging_runtime: LoggingRuntime,
        persistence: PersistenceServices,
        provider_bootstrap: DesktopProviderBootstrapSecret,
    ) -> Result<Self, ServerError> {
        let provider_recovery_store = Arc::clone(&persistence.state_store);
        Self::bind_inner(
            endpoint,
            token,
            ControlContext {
                terminal_io: backend.terminal_io().clone(),
                terminal_backend: Some(backend.clone()),
                logging_runtime: Some(logging_runtime),
                #[cfg(test)]
                terminal_lifecycle: TerminalLifecycle::WorkspaceManaged,
                runtime: Some(runtime),
                persistence: Some(persistence),
                card_slots: None,
                card_slots_v2: None,
                attention: None,
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: Some(multi_window::MultiWindowRuntime::with_recovery_store(
                    provider_bootstrap,
                    provider_recovery_store,
                )),
                platform,
            },
        )
    }

    fn bind_inner(
        endpoint: &str,
        token: impl AsRef<[u8]>,
        mut context: ControlContext,
    ) -> Result<Self, ServerError> {
        let token = token.as_ref();
        if token.len() < 32 {
            return Err(ServerError::WeakControlToken);
        }

        prepare_endpoint(endpoint)?;
        let listener = create_listener(endpoint)?;
        if context.runtime.is_some() {
            context.card_slots = Some(card_slots::CardSlotRuntime::new());
            context.card_slots_v2 = Some(card_slots::CardSlotV2Runtime::new());
            context.attention = Some(attention::AttentionRuntime::new());
        }
        if let (Some(persistence), Some(multi_window)) =
            (&context.persistence, &context.multi_window)
        {
            context.actions = Some(actions::ActionRuntime::with_custom_actions(
                Arc::clone(&persistence.state_store),
                multi_window.clone(),
                Arc::clone(&persistence.config_store),
            ));
            if context.runtime.is_some() {
                context.browser_automation =
                    Some(browser_automation::BrowserAutomationRuntime::new(
                        Arc::clone(&persistence.state_store),
                        multi_window.clone(),
                        token,
                    ));
            }
        }
        if let (Some(runtime), Some(persistence)) = (&context.runtime, &context.persistence) {
            context.agent_sessions = agent_sessions::AgentSessionControlRuntime::new(
                Arc::clone(&persistence.state_store),
                Arc::clone(runtime),
                context.terminal_io.clone(),
                context.multi_window.clone(),
            )
            .ok();
            if let Some(backend) = &context.terminal_backend {
                context.remote_sessions = remote_sessions::RemoteSessionControlRuntime::new(
                    Arc::clone(&persistence.state_store),
                    backend.clone(),
                )
                .ok();
            }
            context.sidebar_content = Some(sidebar_content::SidebarContentRuntime::new(
                Arc::clone(&persistence.state_store),
                Arc::clone(runtime),
                context.terminal_io.clone(),
                context.agent_sessions.clone(),
                context.remote_sessions.clone(),
                context.multi_window.clone(),
            ));
        }

        Ok(Self {
            listener,
            token: Arc::from(token),
            auth_limiter: Arc::new(Mutex::new(AuthFailureLimiter::default())),
            client_slots: Arc::new(tokio::sync::Semaphore::new(MAX_CLIENTS)),
            context,
        })
    }

    /// Accept connections until the supplied shutdown future resolves.
    ///
    /// # Errors
    ///
    /// Returns an error when the local transport cannot continue serving connections.
    #[allow(clippy::too_many_lines)]
    pub async fn run(self, shutdown: impl Future<Output = ()>) -> Result<(), ServerError> {
        let Self {
            listener,
            token,
            auth_limiter,
            client_slots,
            context,
        } = self;
        let (shutdown_sender, _) = watch::channel(false);
        let mut handlers = JoinSet::new();
        if let Some(sidebar_content) = &context.sidebar_content {
            sidebar_content.initialize();
        }
        if let Some(actions) = &context.actions {
            let _ = actions.reconcile(&context).await;
        }
        if let Some(browser_automation) = &context.browser_automation {
            browser_automation.reconcile().await;
        }
        let terminal_bridge = context.runtime.as_ref().map(|runtime| {
            tokio::spawn(forward_terminal_notifications(
                context.terminal_io.clone(),
                Arc::clone(runtime),
            ))
        });
        let provider_lease_sweeper = match (context.runtime.as_ref(), context.multi_window.as_ref())
        {
            (Some(runtime), Some(multi_window)) => {
                let runtime = Arc::clone(runtime);
                let multi_window = multi_window.clone();
                let actions = context.actions.clone();
                let browser_automation = context.browser_automation.clone();
                let reconcile_context = context.clone();
                Some(tokio::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(1));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        interval.tick().await;
                        if multi_window.expire_leases().await.is_some() {
                            multi_window::reconcile_after_provider_failure(
                                &multi_window,
                                &runtime,
                                &BTreeSet::new(),
                            )
                            .await;
                        }
                        if let Some(actions) = &actions {
                            let _ = actions.reconcile(&reconcile_context).await;
                        }
                        if let Some(browser_automation) = &browser_automation {
                            browser_automation.reconcile().await;
                        }
                    }
                }))
            }
            _ => None,
        };
        let attention_monitor = match (
            context.runtime.as_ref(),
            context.card_slots.as_ref(),
            context.attention.as_ref(),
        ) {
            (Some(runtime), Some(card_slots), Some(attention)) => {
                Some(tokio::spawn(attention::monitor_sources(
                    attention.clone(),
                    Arc::clone(runtime),
                    card_slots.clone(),
                )))
            }
            _ => None,
        };
        tokio::pin!(shutdown);

        loop {
            tokio::select! {
                () = &mut shutdown => break,
                accepted = listener.accept() => {
                    let stream = match accepted {
                        Ok(stream) => stream,
                        Err(error) => {
                            warn!(%error, "local control connection failed");
                            continue;
                        }
                    };
                    let Ok(client_slot) = Arc::clone(&client_slots).try_acquire_owned() else {
                        warn!("local control client limit reached");
                        continue;
                    };

                    let token = Arc::clone(&token);
                    let auth_limiter = Arc::clone(&auth_limiter);
                    let context = context.clone();
                    let shutdown = shutdown_sender.subscribe();
                    handlers.spawn(async move {
                        let _client_slot = client_slot;
                        if let Err(error) = handle_stream(stream, &token, &auth_limiter, context, shutdown).await {
                            debug!(%error, "local control connection closed");
                        }
                    });
                }
            }
        }
        drop(listener);
        shutdown_sender.send_replace(true);
        if !drain_handlers(&mut handlers, CLIENT_DRAIN_TIMEOUT).await {
            warn!(
                timeout_ms = CLIENT_DRAIN_TIMEOUT.as_millis(),
                "control clients exceeded shutdown drain deadline"
            );
        }
        if let Some(actions) = &context.actions {
            let _ = actions.shutdown().await;
        }
        if let Some(browser_automation) = &context.browser_automation {
            browser_automation.shutdown().await;
        }
        if let Some(task) = terminal_bridge {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = provider_lease_sweeper {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = attention_monitor {
            task.abort();
            let _ = task.await;
        }
        #[cfg(test)]
        if let TerminalLifecycle::LegacyTest(terminals) = &context.terminal_lifecycle {
            terminals.shutdown_all().await;
        }
        Ok(())
    }
}

async fn drain_handlers(handlers: &mut JoinSet<()>, timeout: Duration) -> bool {
    let drained = tokio::time::timeout(timeout, async {
        while let Some(result) = handlers.join_next().await {
            if let Err(error) = result {
                debug!(%error, "control client task failed while draining");
            }
        }
    })
    .await
    .is_ok();
    if !drained {
        handlers.abort_all();
        while handlers.join_next().await.is_some() {}
    }
    drained
}

struct ChildTaskGuard(Vec<AbortHandle>);

impl Drop for ChildTaskGuard {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn handle_stream(
    stream: Stream,
    token: &[u8],
    auth_limiter: &Mutex<AuthFailureLimiter>,
    context: ControlContext,
    shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    let caller_id = Uuid::new_v4();
    let actions = context.actions.clone();
    let browser_automation = context.browser_automation.clone();
    let result =
        handle_stream_for_caller(stream, token, auth_limiter, context, shutdown, caller_id).await;
    if let Some(actions) = actions {
        actions.cancel_caller(caller_id).await;
    }
    if let Some(browser_automation) = browser_automation {
        browser_automation.cancel_caller(caller_id).await;
    }
    result
}

#[allow(clippy::too_many_lines)]
async fn handle_stream_for_caller(
    stream: Stream,
    token: &[u8],
    auth_limiter: &Mutex<AuthFailureLimiter>,
    context: ControlContext,
    mut shutdown: watch::Receiver<bool>,
    caller_id: Uuid,
) -> io::Result<()> {
    let stream = Arc::new(stream);
    let mut reader = BufReader::new(stream.as_ref());
    let mut writer = stream.as_ref();

    let Some(auth_line) = tokio::time::timeout(AUTH_TIMEOUT, read_frame(&mut reader))
        .await
        .map_err(|_| {
            io::Error::new(io::ErrorKind::TimedOut, "control authentication timed out")
        })??
    else {
        return Ok(());
    };
    let authenticated = serde_json::from_str::<AuthEnvelope>(&auth_line)
        .ok()
        .is_some_and(|envelope| tokens_match(envelope.auth.token.as_bytes(), token));

    if !authenticated {
        let delay = auth_limiter.lock().await.record_failure(Instant::now());
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        write_response(
            &mut writer,
            &ResponseEnvelope::failure(
                String::new(),
                "unauthenticated",
                "Control protocol authentication failed",
            ),
        )
        .await?;
        return Ok(());
    }

    let (response_tx, response_rx) = mpsc::channel(32);
    let (event_tx, event_rx) = mpsc::channel(16);
    // Rich card invalidations are advisory and may arrive in bursts. Keep them out of the
    // latency-sensitive terminal/domain lane and bound them to one queued frame per client.
    let (card_slot_v2_event_tx, card_slot_v2_event_rx) = mpsc::channel(1);
    let attachments = Arc::new(Mutex::new(HashSet::new()));
    let bound_window = Arc::new(Mutex::new(None));
    let window_event_scope = match (context.multi_window.clone(), context.runtime.as_ref()) {
        (Some(control), Some(runtime)) => Some(multi_window::WindowEventScope::new(
            Arc::clone(&bound_window),
            control,
            Arc::clone(runtime),
        )),
        _ => None,
    };
    let mut writer_task = tokio::spawn(write_loop(
        Arc::clone(&stream),
        response_rx,
        event_rx,
        card_slot_v2_event_rx,
        shutdown.clone(),
    ));
    let event_task = tokio::spawn(forward_terminal_events(
        context.terminal_io.clone(),
        event_tx.clone(),
        Arc::clone(&attachments),
        window_event_scope.clone(),
    ));
    let domain_task = context.runtime.as_ref().map(|runtime| {
        tokio::spawn(milestone2::forward_domain_events(
            Arc::clone(runtime),
            event_tx.clone(),
            context
                .multi_window
                .clone()
                .map(|multi_window| (Arc::clone(&bound_window), multi_window)),
        ))
    });
    let card_slot_task = context.card_slots.as_ref().map(|card_slots| {
        let receiver = card_slots.subscribe();
        tokio::spawn(card_slots::forward_events(
            card_slots.clone(),
            receiver,
            event_tx.clone(),
            window_event_scope.clone(),
        ))
    });
    let card_slot_v2_task = context.card_slots_v2.as_ref().map(|card_slots| {
        let receiver = card_slots.subscribe();
        tokio::spawn(card_slots::forward_v2_events(
            card_slots.clone(),
            receiver,
            card_slot_v2_event_tx.clone(),
            window_event_scope.clone(),
        ))
    });
    let attention_task = context.attention.as_ref().map(|attention| {
        let receiver = attention.subscribe();
        tokio::spawn(attention::forward_events(
            attention.clone(),
            receiver,
            event_tx.clone(),
            window_event_scope.clone(),
        ))
    });
    let action_task = context.actions.as_ref().map(|actions| {
        let receiver = actions.subscribe();
        tokio::spawn(actions::forward_events(
            actions.clone(),
            receiver,
            event_tx.clone(),
        ))
    });
    let _child_tasks = ChildTaskGuard(
        std::iter::once(writer_task.abort_handle())
            .chain(std::iter::once(event_task.abort_handle()))
            .chain(
                domain_task
                    .iter()
                    .map(tokio::task::JoinHandle::abort_handle),
            )
            .chain(
                card_slot_task
                    .iter()
                    .map(tokio::task::JoinHandle::abort_handle),
            )
            .chain(
                card_slot_v2_task
                    .iter()
                    .map(tokio::task::JoinHandle::abort_handle),
            )
            .chain(
                attention_task
                    .iter()
                    .map(tokio::task::JoinHandle::abort_handle),
            )
            .chain(
                action_task
                    .iter()
                    .map(tokio::task::JoinHandle::abort_handle),
            )
            .collect(),
    );
    let mut replay_cache = ReplayCache::default();
    let mut request_handlers = JoinSet::new();
    let mut in_flight = HashMap::<String, InFlightRequest>::new();

    loop {
        let mut request_line = None;
        let completed = tokio::select! {
            biased;
            changed = shutdown.wait_for(|requested| *requested) => {
                let _ = changed;
                break;
            }
            writer_result = &mut writer_task => {
                event_task.abort();
                if let Some(task) = &domain_task { task.abort(); }
                if let Some(task) = &card_slot_task { task.abort(); }
                if let Some(task) = &card_slot_v2_task { task.abort(); }
                if let Some(task) = &attention_task { task.abort(); }
                if let Some(task) = &action_task { task.abort(); }
                return writer_result.map_err(io::Error::other)?;
            }
            completed = request_handlers.join_next(), if !request_handlers.is_empty() => {
                Some(completed.expect("guarded request handler set cannot be empty"))
            }
            request = tokio::time::timeout(CLIENT_IDLE_TIMEOUT, read_frame(&mut reader)),
                if request_handlers.len() < MAX_REQUEST_HANDLERS_PER_CLIENT => {
                    request_line = request
                        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control client timed out"))??;
                    None
            }
        };
        if let Some(completed) = completed {
            complete_request_handler(completed, &mut in_flight, &mut replay_cache, &response_tx)
                .await?;
            continue;
        }
        let Some(request_line) = request_line else {
            break;
        };
        let Ok(request) = serde_json::from_str::<RequestEnvelope>(&request_line) else {
            let response = ResponseEnvelope::failure(
                String::new(),
                "invalid_request",
                "The request is not a valid protocol envelope",
            );
            response_tx
                .send(serialize_frame(&response)?)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response writer closed"))?;
            break;
        };

        if let Some(pending) = in_flight.get_mut(&request.id) {
            if pending.followups.len() == REPLAY_CACHE_CAPACITY {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "too many duplicate in-flight control requests",
                ));
            }
            if pending.request == request {
                pending.followups.push(InFlightFollowup::Replay);
            } else {
                pending
                    .followups
                    .push(InFlightFollowup::Encoded(serialize_frame(
                        &ResponseEnvelope::failure(
                            request.id,
                            "duplicate_request_id",
                            "The request ID was already used for a different request",
                        ),
                    )?));
            }
            continue;
        }
        if let Some(encoded) = replay_cache.lookup(&request) {
            response_tx
                .send(encoded)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response writer closed"))?;
            continue;
        }
        if replay_cache.contains_id(&request.id) {
            let response = ResponseEnvelope::failure(
                request.id,
                "duplicate_request_id",
                "The request ID was already used for a different request",
            );
            response_tx
                .send(serialize_frame(&response)?)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response writer closed"))?;
            continue;
        }

        in_flight.insert(
            request.id.clone(),
            InFlightRequest {
                request: request.clone(),
                followups: Vec::new(),
            },
        );
        let handler_context = context.clone();
        let handler_attachments = Arc::clone(&attachments);
        let handler_bound_window = Arc::clone(&bound_window);
        request_handlers.spawn(async move {
            let replay_request = request.clone();
            let response = dispatch_for_caller(
                request,
                &handler_context,
                handler_attachments.as_ref(),
                handler_bound_window.as_ref(),
                caller_id,
            )
            .await;
            (replay_request, serialize_frame(&response))
        });
    }

    request_handlers.abort_all();
    while request_handlers.join_next().await.is_some() {}

    event_task.abort();
    if let Some(task) = domain_task {
        task.abort();
    }
    if let Some(task) = card_slot_task {
        task.abort();
    }
    if let Some(task) = card_slot_v2_task {
        task.abort();
    }
    if let Some(task) = attention_task {
        task.abort();
    }
    if let Some(task) = action_task {
        task.abort();
    }
    drop(response_tx);
    drop(event_tx);
    drop(card_slot_v2_event_tx);
    writer_task.await.map_err(io::Error::other)?
}

#[allow(clippy::too_many_lines)]
#[cfg(test)]
async fn dispatch(
    request: RequestEnvelope,
    context: &ControlContext,
    attachments: &Mutex<HashSet<String>>,
    bound_window: &Mutex<Option<multi_window::BoundWindow>>,
) -> ResponseEnvelope {
    dispatch_for_caller(request, context, attachments, bound_window, Uuid::nil()).await
}

#[allow(clippy::too_many_lines)]
async fn dispatch_for_caller(
    request: RequestEnvelope,
    context: &ControlContext,
    attachments: &Mutex<HashSet<String>>,
    bound_window: &Mutex<Option<multi_window::BoundWindow>>,
    caller_id: Uuid,
) -> ResponseEnvelope {
    let RequestEnvelope {
        id,
        command,
        params,
    } = request;
    #[cfg(test)]
    if command == "system.testWait" {
        tokio::time::sleep(Duration::from_millis(500)).await;
        return ResponseEnvelope::success(id, serde_json::json!({}));
    }
    let is_multi_window_command =
        context.multi_window.is_some() && multi_window::is_command(&command);
    let is_action_command = context.actions.is_some() && actions::is_command(&command);
    let is_browser_automation_command =
        context.browser_automation.is_some() && browser_automation::is_command(&command);
    let is_agent_session_command =
        context.agent_sessions.is_some() && agent_sessions::is_command(&command);
    let mut active_binding = None;
    if let Some(runtime) = &context.runtime {
        let topology = runtime.snapshot().await;
        let binding = *bound_window.lock().await;
        active_binding = binding;
        // A committed cross-window move can remove the source placement before the
        // desktop provider performs its physical PTY detach. Permit that one
        // cleanup operation only when this exact connection already owns the
        // attachment; it cannot expose output or acquire another resource.
        let attached_terminal_detach = permits_stale_attached_terminal_detach(
            binding.is_some(),
            &command,
            &params,
            attachments,
        )
        .await;
        if let (Some(control), Some(binding)) = (&context.multi_window, binding)
            && control.validate_binding(&topology, binding).await.is_err()
            && !attached_terminal_detach
            && !is_action_command
            && !is_browser_automation_command
            && !is_agent_session_command
        {
            return ResponseEnvelope::failure(
                id,
                "placement_required",
                "This control connection's window binding is no longer valid",
            );
        }
        if let Some(binding) = binding
            && !is_multi_window_command
            && !is_action_command
            && !is_browser_automation_command
            && !is_agent_session_command
        {
            if topology.window_placements.len() > 1
                && ((organization::is_command(&command)
                    && !multi_window::legacy_organization_request_is_allowed(
                        &topology, binding, &command, &params,
                    ))
                    || layouts::is_command(&command)
                    || multi_window::legacy_notification_request_is_global(&command, &params))
            {
                return ResponseEnvelope::failure(
                    id,
                    "placement_required",
                    "This legacy command has application-global semantics in a multi-window session",
                );
            }
            if !attached_terminal_detach
                && !multi_window::bound_request_targets_owned_state(&topology, binding, &params)
            {
                return ResponseEnvelope::failure(
                    id,
                    "placement_required",
                    "The request target is outside this connection's window placement",
                );
            }
        }
        if topology.window_placements.len() > 1
            && binding.is_none()
            && !is_multi_window_command
            && !is_action_command
            && !is_browser_automation_command
            && !is_agent_session_command
            && !matches!(command.as_str(), "system.identify" | "system.ping")
            && !command.starts_with("configuration.")
        {
            return ResponseEnvelope::failure(
                id,
                "placement_required",
                "This control connection must bind to one window placement",
            );
        }
    }
    if is_multi_window_command {
        return multi_window::dispatch(id, &command, params, context, bound_window).await;
    }
    if context.runtime.is_some()
        && matches!(command.as_str(), "terminal.create" | "terminal.terminate")
    {
        return terminal_lifecycle_managed(id);
    }
    let response = match command.as_str() {
        "system.identify" => {
            let mut result = milestone2::identify(
                context.runtime.is_some(),
                context.runtime.is_some() && context.persistence.is_some(),
            );
            if context.multi_window.is_some()
                && let Some(runtime) = context.runtime.as_ref()
            {
                multi_window::apply_identify_capabilities(
                    &mut result.capabilities,
                    &runtime.snapshot().await,
                    active_binding,
                );
            }
            // A capability declares that this service generation implements the closed command
            // contract; transient native-provider availability is an operation precondition with
            // its own stable `provider_unavailable` result. Gating this on an already registered
            // provider creates an impossible bootstrap cycle because Electron uses identify to
            // decide whether it should register that provider capability.
            let browser_automation_available = context.browser_automation.is_some();
            apply_service_capabilities(
                &mut result.capabilities,
                context.actions.is_some(),
                browser_automation_available,
                context.agent_sessions.is_some(),
                context.remote_sessions.is_some(),
                context.sidebar_content.is_some(),
            );
            ResponseEnvelope::success(
                id,
                serde_json::to_value(result).expect("IdentifyResult serialization is infallible"),
            )
        }
        "system.ping" => ResponseEnvelope::success(id, serde_json::json!({ "pong": true })),
        #[cfg(test)]
        "terminal.create" => {
            let TerminalLifecycle::LegacyTest(terminals) = &context.terminal_lifecycle else {
                unreachable!("workspace-managed lifecycle commands return before dispatch")
            };
            create_terminal(id, params, terminals, attachments).await
        }
        "terminal.attach" => {
            let params = match parse_params::<TerminalAttachParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            match subscribe_before_snapshot(&params.terminal_id, attachments, || {
                context.terminal_io.attach(&params.terminal_id)
            })
            .await
            {
                Ok(snapshot) => success(id, attach_result(snapshot)),
                Err(error) => terminal_failure(id, &error),
            }
        }
        "terminal.runtimeMetadata" => {
            let params = match parse_params::<TerminalRuntimeMetadataParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            terminal_runtime_metadata(id, params, &context.terminal_io).await
        }
        "terminal.detach" => {
            let params = match parse_params::<TerminalDetachParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            match context.terminal_io.attach(&params.terminal_id) {
                Ok(_) => {
                    attachments.lock().await.remove(&params.terminal_id);
                    ResponseEnvelope::success(id, serde_json::json!({}))
                }
                Err(error) => terminal_failure(id, &error),
            }
        }
        "terminal.send" => {
            let params = match parse_params::<TerminalSendParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            let Ok(data) = BASE64.decode(params.data) else {
                return ResponseEnvelope::failure(
                    id,
                    "invalid_terminal_data",
                    "Terminal input must be valid base64",
                );
            };
            match context.terminal_io.write(&params.terminal_id, data).await {
                Ok(()) => ResponseEnvelope::success(id, serde_json::json!({})),
                Err(error) => terminal_failure(id, &error),
            }
        }
        "terminal.resize" => {
            let params = match parse_params::<TerminalResizeParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            match context
                .terminal_io
                .resize(&params.terminal_id, params.rows, params.cols)
                .await
            {
                Ok(()) => ResponseEnvelope::success(id, serde_json::json!({})),
                Err(error) => terminal_failure(id, &error),
            }
        }
        "terminal.checkpoint" => {
            checkpoint_terminal(id, params, &context.terminal_io, attachments).await
        }
        #[cfg(test)]
        "terminal.terminate" => {
            let TerminalLifecycle::LegacyTest(terminals) = &context.terminal_lifecycle else {
                unreachable!("workspace-managed lifecycle commands return before dispatch")
            };
            let params = match parse_params::<TerminalTerminateParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            match terminals.terminate(&params.terminal_id).await {
                Ok(()) => ResponseEnvelope::success(id, serde_json::json!({})),
                Err(error) => terminal_failure(id, &error),
            }
        }
        _ if context.persistence.is_some() && milestone5::is_command(&command) => {
            milestone5::dispatch(id, &command, params, context).await
        }
        _ if context.card_slots.is_some() && card_slots::is_command(&command) => {
            card_slots::dispatch(id, &command, params, context).await
        }
        _ if context.card_slots_v2.is_some() && card_slots::is_v2_command(&command) => {
            card_slots::dispatch_v2(id, &command, params, context).await
        }
        _ if context.attention.is_some() && attention::is_command(&command) => {
            attention::dispatch(id, &command, params, context).await
        }
        _ if context.actions.is_some() && actions::is_command(&command) => {
            actions::dispatch(id, &command, params, context, caller_id).await
        }
        _ if context.browser_automation.is_some() && browser_automation::is_command(&command) => {
            browser_automation::dispatch(id, &command, params, context, caller_id).await
        }
        _ if let Some(runtime) = &context.agent_sessions
            && agent_sessions::is_command(&command) =>
        {
            agent_sessions::dispatch(id, &command, params, runtime).await
        }
        _ if let Some(runtime) = &context.remote_sessions
            && remote_sessions::is_command(&command) =>
        {
            remote_sessions::dispatch(id, &command, params, runtime).await
        }
        _ if let Some(runtime) = &context.sidebar_content
            && sidebar_content::is_command(&command) =>
        {
            sidebar_content::dispatch(id, &command, params, runtime).await
        }
        _ if context.runtime.is_some() && organization::is_command(&command) => {
            organization::dispatch(id, &command, params, context).await
        }
        _ if context.runtime.is_some() && layouts::is_command(&command) => {
            layouts::dispatch(id, &command, params, context).await
        }
        _ if context.runtime.is_some() => {
            milestone2::dispatch_for_window(
                id,
                &command,
                params,
                context,
                active_binding.map(|binding| binding.window_id),
            )
            .await
        }
        _ => {
            ResponseEnvelope::failure(id, "unknown_command", format!("Unknown command: {command}"))
        }
    };
    if let (Some(binding), Some(runtime)) = (active_binding, context.runtime.as_ref()) {
        multi_window::project_legacy_response(
            &command,
            response,
            binding,
            &runtime.snapshot().await,
        )
    } else {
        response
    }
}

async fn permits_stale_attached_terminal_detach(
    is_bound: bool,
    command: &str,
    params: &serde_json::Value,
    attachments: &Mutex<HashSet<String>>,
) -> bool {
    if !is_bound || command != "terminal.detach" {
        return false;
    }
    let Ok(params) = serde_json::from_value::<TerminalDetachParams>(params.clone()) else {
        return false;
    };
    attachments.lock().await.contains(&params.terminal_id)
}

async fn terminal_runtime_metadata(
    id: String,
    params: TerminalRuntimeMetadataParams,
    terminals: &TerminalIoHandle,
) -> ResponseEnvelope {
    let snapshot = match terminals.attach(&params.terminal_id) {
        Ok(snapshot) => snapshot,
        Err(error) => return terminal_failure(id, &error),
    };
    let listening_ports = match (snapshot.terminal.exited, snapshot.terminal.process_id) {
        (false, Some(process_id)) => {
            if let Ok(Ok(ports)) =
                tokio::task::spawn_blocking(move || discover_listening_ports(process_id)).await
            {
                ports
            } else {
                warn!("terminal listening-port discovery unavailable");
                Vec::new()
            }
        }
        _ => Vec::new(),
    };
    success(
        id,
        TerminalRuntimeMetadataResult {
            terminal_id: params.terminal_id,
            listening_ports,
        },
    )
}

fn discover_listening_ports(root_process_id: u32) -> Result<Vec<u16>, ()> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().without_tasks()),
    );
    let relations = system.processes().iter().map(|(process_id, process)| {
        (
            process_id.as_u32(),
            process.parent().map(sysinfo::Pid::as_u32),
        )
    });
    let process_ids = descendant_process_ids(root_process_id, relations);
    if process_ids.is_empty() {
        return Ok(Vec::new());
    }
    let listeners = listeners::get_all().map_err(|_| ())?;
    Ok(listening_ports_for_process_ids(&process_ids, listeners))
}

fn listening_ports_for_process_ids(
    process_ids: &HashSet<u32>,
    listeners: impl IntoIterator<Item = listeners::Listener>,
) -> Vec<u16> {
    listeners
        .into_iter()
        .filter(|listener| {
            listener.protocol == listeners::Protocol::TCP
                && listener.state == listeners::SocketState::Listen
                && process_ids.contains(&listener.process.pid)
        })
        .map(|listener| listener.socket.port())
        .filter(|port| *port != 0)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_TERMINAL_LISTENING_PORTS)
        .collect()
}

fn descendant_process_ids(
    root_process_id: u32,
    relations: impl IntoIterator<Item = (u32, Option<u32>)>,
) -> HashSet<u32> {
    let relations = relations.into_iter().collect::<Vec<_>>();
    if !relations
        .iter()
        .any(|(process_id, _)| *process_id == root_process_id)
    {
        return HashSet::new();
    }
    let mut descendants = HashSet::from([root_process_id]);
    loop {
        let previous_count = descendants.len();
        for (process_id, parent_process_id) in &relations {
            if parent_process_id.is_some_and(|parent| descendants.contains(&parent)) {
                descendants.insert(*process_id);
            }
        }
        if descendants.len() == previous_count {
            return descendants;
        }
    }
}

async fn subscribe_before_snapshot(
    terminal_id: &str,
    attachments: &Mutex<HashSet<String>>,
    snapshot: impl FnOnce() -> Result<TerminalSnapshot, TerminalError>,
) -> Result<TerminalSnapshot, TerminalError> {
    attachments.lock().await.insert(terminal_id.to_owned());
    match snapshot() {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            attachments.lock().await.remove(terminal_id);
            Err(error)
        }
    }
}

fn terminal_lifecycle_managed(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "terminal_lifecycle_managed",
        "Terminal lifecycle is managed by authoritative workspace commands",
    )
}

#[cfg(test)]
async fn create_terminal(
    id: String,
    params: serde_json::Value,
    terminals: &TerminalManager,
    attachments: &Mutex<HashSet<String>>,
) -> ResponseEnvelope {
    let params = match parse_params::<TerminalCreateParams>(&id, params) {
        Ok(params) => params,
        Err(response) => return *response,
    };
    match terminals
        .create(TerminalSpawnRequest {
            rows: params.rows,
            cols: params.cols,
            cwd: params.cwd.map(Into::into),
            command: params.command,
            executable_identity: None,
            environment: Vec::new(),
        })
        .await
    {
        Ok(terminal) => {
            attachments.lock().await.insert(terminal.id.clone());
            success(
                id,
                TerminalCreateResult {
                    terminal: descriptor(terminal),
                },
            )
        }
        Err(error) => terminal_failure(id, &error),
    }
}

async fn checkpoint_terminal(
    id: String,
    params: serde_json::Value,
    terminals: &TerminalIoHandle,
    attachments: &Mutex<HashSet<String>>,
) -> ResponseEnvelope {
    let params = match parse_params::<TerminalCheckpointParams>(&id, params) {
        Ok(params) => params,
        Err(response) => return *response,
    };
    if serde_json::to_vec(&params.checkpoint).map_or(true, |encoded| {
        encoded.len() > MAX_TERMINAL_CHECKPOINT_WIRE_BYTES
    }) {
        return terminal_failure(id, &TerminalError::CheckpointTooLarge);
    }
    if !attachments.lock().await.contains(&params.terminal_id) {
        return ResponseEnvelope::failure(
            id,
            "terminal_not_attached",
            "The client must attach before submitting a terminal checkpoint",
        );
    }
    let checkpoint = RuntimeCheckpoint {
        sequence: params.checkpoint.sequence,
        rows: params.checkpoint.rows,
        cols: params.checkpoint.cols,
        active_buffer: match params.checkpoint.active_buffer {
            TerminalActiveBuffer::Normal => ActiveBuffer::Normal,
            TerminalActiveBuffer::Alternate => ActiveBuffer::Alternate,
        },
        data: params.checkpoint.data,
    };
    match terminals.checkpoint(&params.terminal_id, checkpoint) {
        Ok(()) => ResponseEnvelope::success(id, serde_json::json!({})),
        Err(error) => terminal_failure(id, &error),
    }
}

fn parse_params<T: DeserializeOwned>(
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

fn success(id: String, value: impl Serialize) -> ResponseEnvelope {
    ResponseEnvelope::success(
        id,
        serde_json::to_value(value).expect("protocol result serialization is infallible"),
    )
}

fn terminal_failure(id: String, error: &TerminalError) -> ResponseEnvelope {
    let (code, message) = match error {
        TerminalError::InvalidSize => (
            "invalid_terminal_size",
            "Terminal dimensions must be between 1 and 1000 cells",
        ),
        TerminalError::InvalidCommand => {
            ("invalid_terminal_command", "The terminal command is empty")
        }
        TerminalError::InvalidConfiguredShell => (
            "terminal_spawn_failed",
            "The configured terminal shell could not be started",
        ),
        TerminalError::InvalidWorkingDirectory => (
            "invalid_working_directory",
            "The terminal working directory does not exist",
        ),
        TerminalError::NotFound => ("terminal_not_found", "The terminal no longer exists"),
        TerminalError::CheckpointAhead => (
            "terminal_checkpoint_ahead",
            "The checkpoint is ahead of service output",
        ),
        TerminalError::StaleCheckpoint => (
            "terminal_checkpoint_stale",
            "A newer terminal checkpoint is already stored",
        ),
        TerminalError::CheckpointTooLarge => (
            "terminal_checkpoint_too_large",
            "The serialized terminal checkpoint is too large",
        ),
        TerminalError::Exited => ("terminal_exited", "The terminal process has exited"),
        TerminalError::OpenPty => (
            "terminal_open_failed",
            "The operating system could not create a terminal",
        ),
        TerminalError::Spawn => (
            "terminal_spawn_failed",
            "The terminal process could not be started",
        ),
        TerminalError::Write => (
            "terminal_write_failed",
            "Input could not be written to the terminal",
        ),
        TerminalError::Resize => (
            "terminal_resize_failed",
            "The terminal could not be resized",
        ),
        TerminalError::Terminate => (
            "terminal_terminate_failed",
            "The terminal process could not be terminated",
        ),
        TerminalError::Worker => (
            "terminal_worker_failed",
            "A terminal runtime worker stopped unexpectedly",
        ),
    };
    ResponseEnvelope::failure(id, code, message)
}

fn descriptor(value: RuntimeDescriptor) -> TerminalDescriptor {
    TerminalDescriptor {
        id: value.id,
        process_id: value.process_id,
        command: value.command,
        cwd: value.cwd.to_string_lossy().into_owned(),
        rows: value.rows,
        cols: value.cols,
        exited: value.exited,
        exit_code: value.exit_code,
    }
}

fn output_chunk(value: RuntimeChunk) -> TerminalOutputChunk {
    TerminalOutputChunk {
        sequence: value.sequence,
        byte_length: u32::try_from(value.data.len()).expect("terminal chunk length fits u32"),
        data: BASE64.encode(value.data),
    }
}

fn attach_result(value: TerminalSnapshot) -> TerminalAttachResult {
    TerminalAttachResult {
        terminal: descriptor(value.terminal),
        checkpoint: value.checkpoint.map(|checkpoint| {
            agent_workspace_protocol::TerminalCheckpoint {
                sequence: checkpoint.sequence,
                rows: checkpoint.rows,
                cols: checkpoint.cols,
                active_buffer: match checkpoint.active_buffer {
                    ActiveBuffer::Normal => TerminalActiveBuffer::Normal,
                    ActiveBuffer::Alternate => TerminalActiveBuffer::Alternate,
                },
                data: checkpoint.data,
            }
        }),
        output: value.output.into_iter().map(output_chunk).collect(),
        last_sequence: value.last_sequence,
        reconstruction_complete: value.reconstruction_complete,
    }
}

const TERMINAL_TARGET_LOOKUP_ATTEMPTS: usize = 8;
const TERMINAL_TARGET_LOOKUP_RETRY: Duration = Duration::from_millis(25);

async fn forward_terminal_notifications(
    terminals: TerminalIoHandle,
    runtime: Arc<ProductionWorkspaceRuntime>,
) {
    let mut receiver = terminals.subscribe();
    loop {
        match receiver.recv().await {
            Ok(event) => handle_terminal_notification(&runtime, event).await,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(skipped, "terminal notification bridge lagged");
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn handle_terminal_notification(
    runtime: &Arc<ProductionWorkspaceRuntime>,
    event: RuntimeEvent,
) {
    let (terminal_id, title, body, source, level) = match event {
        RuntimeEvent::Notification {
            terminal_id,
            source: _,
            title,
            body,
        } => {
            let title = title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Terminal notification".to_owned());
            let body = (!body.trim().is_empty()).then_some(body);
            (
                terminal_id,
                title,
                body,
                NotificationSource::Osc,
                NotificationLevel::Info,
            )
        }
        RuntimeEvent::Exited {
            terminal_id,
            exit_code,
            signal: _,
        } => {
            let (title, level) = if exit_code == 0 {
                ("Terminal exited".to_owned(), NotificationLevel::Info)
            } else {
                (
                    "Terminal exited with an error".to_owned(),
                    NotificationLevel::Error,
                )
            };
            (
                terminal_id,
                title,
                Some(format!("Exit code {exit_code}")),
                NotificationSource::Internal,
                level,
            )
        }
        RuntimeEvent::Output { .. }
        | RuntimeEvent::Resized { .. }
        | RuntimeEvent::CheckpointRequested { .. } => return,
    };
    let Some(target) = terminal_notification_target(runtime, &terminal_id).await else {
        debug!(%terminal_id, "dropping terminal notification for stale runtime target");
        return;
    };
    let response = milestone2::publish_notification(
        String::new(),
        runtime,
        NotificationPublishParams {
            target,
            source,
            level,
            title,
            body,
        },
    )
    .await;
    if !response.ok {
        warn!(%terminal_id, "terminal notification could not be committed");
    }
}

async fn terminal_notification_target(
    runtime: &Arc<ProductionWorkspaceRuntime>,
    terminal_id: &str,
) -> Option<NotificationTarget> {
    for attempt in 0..TERMINAL_TARGET_LOOKUP_ATTEMPTS {
        let state = runtime.snapshot().await;
        if let Some(target) = state.workspaces.iter().find_map(|workspace| {
            workspace.tabs.values().find_map(|tab| {
                (tab.content
                    .runtime_session_id()
                    .map(agent_workspace_core::RuntimeSessionId::as_str)
                    == Some(terminal_id))
                .then(|| NotificationTarget {
                    workspace_id: workspace.id.to_string(),
                    pane_id: Some(tab.pane_id.to_string()),
                    tab_id: Some(tab.id.to_string()),
                })
            })
        }) {
            return Some(target);
        }
        if attempt + 1 < TERMINAL_TARGET_LOOKUP_ATTEMPTS {
            tokio::time::sleep(TERMINAL_TARGET_LOOKUP_RETRY).await;
        }
    }
    None
}

fn terminal_event(event: RuntimeEvent) -> Option<EventEnvelope> {
    Some(match event {
        RuntimeEvent::Output { terminal_id, chunk } => event_envelope(
            "terminal.output",
            TerminalOutputEvent {
                terminal_id,
                chunk: output_chunk(chunk),
            },
        ),
        RuntimeEvent::Resized {
            terminal_id,
            rows,
            cols,
        } => event_envelope(
            "terminal.resized",
            TerminalResizedEvent {
                terminal_id,
                rows,
                cols,
            },
        ),
        RuntimeEvent::CheckpointRequested {
            terminal_id,
            sequence,
        } => event_envelope(
            "terminal.checkpointRequested",
            TerminalCheckpointRequestedEvent {
                terminal_id,
                sequence,
            },
        ),
        RuntimeEvent::Notification { .. } => return None,
        RuntimeEvent::Exited {
            terminal_id,
            exit_code,
            signal,
        } => event_envelope(
            "terminal.exited",
            TerminalExitedEvent {
                terminal_id,
                exit_code,
                signal,
            },
        ),
    })
}

fn event_envelope(event: &str, value: impl Serialize) -> EventEnvelope {
    EventEnvelope {
        event: event.to_owned(),
        revision: None,
        data: serde_json::to_value(value).expect("terminal event serialization is infallible"),
    }
}

async fn forward_terminal_events(
    terminals: TerminalIoHandle,
    sender: mpsc::Sender<Vec<u8>>,
    attachments: Arc<Mutex<HashSet<String>>>,
    scope: Option<multi_window::WindowEventScope>,
) {
    let mut receiver = terminals.subscribe();
    let mut resync_pending = false;
    let mut retry = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            event = receiver.recv() => {
                let envelope = match event {
                    Ok(event) => {
                        let terminal_id = runtime_event_terminal_id(&event);
                        if !attachments.lock().await.contains(terminal_id) {
                            continue;
                        }
                        if let Some(scope) = &scope
                            && !scope.owns_runtime_session(terminal_id).await
                        {
                            attachments.lock().await.remove(terminal_id);
                            continue;
                        }
                        let Some(envelope) = terminal_event(event) else {
                            continue;
                        };
                        envelope
                    },
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        resync_pending = true;
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                };
                let Ok(frame) = serialize_frame(&envelope) else {
                    resync_pending = true;
                    continue;
                };
                if sender.try_send(frame).is_err() {
                    resync_pending = true;
                }
            }
            _ = retry.tick(), if resync_pending => {
                let resync = event_envelope(
                    "terminal.resyncRequired",
                    agent_workspace_protocol::TerminalResyncRequiredEvent { terminal_id: None },
                );
                if let Ok(frame) = serialize_frame(&resync)
                    && sender.try_send(frame).is_ok()
                {
                    resync_pending = false;
                }
            }
        }
    }
}

fn runtime_event_terminal_id(event: &RuntimeEvent) -> &str {
    match event {
        RuntimeEvent::Output { terminal_id, .. }
        | RuntimeEvent::Resized { terminal_id, .. }
        | RuntimeEvent::CheckpointRequested { terminal_id, .. }
        | RuntimeEvent::Notification { terminal_id, .. }
        | RuntimeEvent::Exited { terminal_id, .. } => terminal_id,
    }
}

struct InFlightRequest {
    request: RequestEnvelope,
    followups: Vec<InFlightFollowup>,
}

enum InFlightFollowup {
    Replay,
    Encoded(Vec<u8>),
}

async fn complete_request_handler(
    completed: Result<(RequestEnvelope, io::Result<Vec<u8>>), tokio::task::JoinError>,
    in_flight: &mut HashMap<String, InFlightRequest>,
    replay_cache: &mut ReplayCache,
    response_tx: &mpsc::Sender<Vec<u8>>,
) -> io::Result<()> {
    let (request, encoded) = completed.map_err(io::Error::other)?;
    let encoded = encoded?;
    let pending = in_flight.remove(&request.id).ok_or_else(|| {
        io::Error::other("completed control request was not registered as in-flight")
    })?;
    replay_cache.insert(request, encoded.clone());
    response_tx
        .send(encoded.clone())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response writer closed"))?;
    for followup in pending.followups {
        let followup = match followup {
            InFlightFollowup::Replay => encoded.clone(),
            InFlightFollowup::Encoded(encoded) => encoded,
        };
        response_tx
            .send(followup)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response writer closed"))?;
    }
    Ok(())
}

#[derive(Default)]
struct ReplayCache {
    entries: VecDeque<ReplayEntry>,
    bytes: usize,
}

struct ReplayEntry {
    request: RequestEnvelope,
    encoded_response: Vec<u8>,
    weight: usize,
}

impl ReplayCache {
    fn lookup(&self, request: &RequestEnvelope) -> Option<Vec<u8>> {
        self.entries
            .iter()
            .find(|entry| entry.request == *request)
            .map(|entry| entry.encoded_response.clone())
    }

    fn contains_id(&self, id: &str) -> bool {
        self.entries.iter().any(|entry| entry.request.id == id)
    }

    fn insert(&mut self, request: RequestEnvelope, encoded_response: Vec<u8>) {
        let weight = serde_json::to_vec(&request).map_or(encoded_response.len(), |value| {
            value.len() + encoded_response.len()
        });
        while !self.entries.is_empty()
            && (self.entries.len() == REPLAY_CACHE_CAPACITY
                || self.bytes.saturating_add(weight) > REPLAY_CACHE_MAX_BYTES)
        {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes = self.bytes.saturating_sub(entry.weight);
            }
        }
        self.bytes = self.bytes.saturating_add(weight);
        self.entries.push_back(ReplayEntry {
            request,
            encoded_response,
            weight,
        });
    }
}

async fn write_loop(
    stream: Arc<Stream>,
    mut responses: mpsc::Receiver<Vec<u8>>,
    mut events: mpsc::Receiver<Vec<u8>>,
    mut card_slot_v2_events: mpsc::Receiver<Vec<u8>>,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    let shutdown_frame = serialize_frame(&event_envelope(
        "service.shuttingDown",
        ServiceShuttingDownEvent {
            reason: "service_shutdown".to_owned(),
        },
    ))?;
    let mut shutdown_sent = false;
    loop {
        if !shutdown_sent && *shutdown.borrow() {
            write_encoded(stream.as_ref(), &shutdown_frame).await?;
            shutdown_sent = true;
        }
        if let Ok(response) = responses.try_recv() {
            write_encoded(stream.as_ref(), &response).await?;
            continue;
        }
        if let Ok(event) = events.try_recv() {
            write_encoded(stream.as_ref(), &event).await?;
            continue;
        }
        if responses.is_closed()
            && responses.is_empty()
            && events.is_closed()
            && events.is_empty()
            && card_slot_v2_events.is_closed()
            && card_slot_v2_events.is_empty()
        {
            return Ok(());
        }
        tokio::select! {
            biased;
            changed = shutdown.changed(), if !shutdown_sent => {
                if changed.is_ok() {
                    continue;
                }
                shutdown_sent = true;
            }
            response = responses.recv(), if !(responses.is_closed() && responses.is_empty()) => match response {
                Some(response) => write_encoded(stream.as_ref(), &response).await?,
                None if events.is_closed() && card_slot_v2_events.is_closed() => return Ok(()),
                None => {}
            },
            event = events.recv(), if !(events.is_closed() && events.is_empty()) => match event {
                Some(event) => write_encoded(stream.as_ref(), &event).await?,
                None if responses.is_closed() && card_slot_v2_events.is_closed() => return Ok(()),
                None => {}
            },
            event = card_slot_v2_events.recv(), if !(card_slot_v2_events.is_closed() && card_slot_v2_events.is_empty()) => match event {
                Some(event) => write_encoded(stream.as_ref(), &event).await?,
                None if responses.is_closed() && events.is_closed() => return Ok(()),
                None => {}
            }
        }
    }
}

async fn read_frame(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Option<String>> {
    let mut frame = String::new();
    let bytes_read = reader
        .take((MAX_CONTROL_MESSAGE_BYTES + 1) as u64)
        .read_line(&mut frame)
        .await?;

    if bytes_read == 0 {
        return Ok(None);
    }
    if bytes_read > MAX_CONTROL_MESSAGE_BYTES || !frame.ends_with('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control message exceeds the maximum frame size",
        ));
    }

    frame.pop();
    if frame.ends_with('\r') {
        frame.pop();
    }
    Ok(Some(frame))
}

async fn write_response(
    writer: &mut (impl AsyncWrite + Unpin),
    response: &ResponseEnvelope,
) -> io::Result<()> {
    let encoded = serialize_frame(response)?;
    writer.write_all(&encoded).await
}

fn serialize_frame(value: &impl Serialize) -> io::Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(value).map_err(io::Error::other)?;
    encoded.push(b'\n');
    if encoded.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "outbound control message exceeds the maximum frame size",
        ));
    }
    Ok(encoded)
}

async fn write_encoded(stream: &Stream, encoded: &[u8]) -> io::Result<()> {
    let mut writer = stream;
    write_all_with_timeout(&mut writer, encoded, CLIENT_WRITE_TIMEOUT).await
}

async fn write_all_with_timeout(
    writer: &mut (impl AsyncWrite + Unpin),
    encoded: &[u8],
    timeout: Duration,
) -> io::Result<()> {
    tokio::time::timeout(timeout, writer.write_all(encoded))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control client write timed out"))?
}

fn tokens_match(candidate: &[u8], expected: &[u8]) -> bool {
    candidate.len() == expected.len() && candidate.ct_eq(expected).into()
}

#[derive(Default)]
struct AuthFailureLimiter {
    failures: VecDeque<Instant>,
}

impl AuthFailureLimiter {
    fn record_failure(&mut self, now: Instant) -> Duration {
        while self
            .failures
            .front()
            .is_some_and(|failure| now.duration_since(*failure) >= AUTH_FAILURE_WINDOW)
        {
            self.failures.pop_front();
        }
        self.failures.push_back(now);

        if self.failures.len() > MAX_AUTH_FAILURES {
            Duration::from_millis(250)
        } else {
            Duration::ZERO
        }
    }
}

#[cfg(unix)]
fn prepare_endpoint(endpoint: &str) -> io::Result<()> {
    use std::{fs, os::unix::fs::MetadataExt, path::Path};

    let endpoint = Path::new(endpoint);
    let parent = endpoint.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "socket path has no parent directory",
        )
    })?;

    fs::create_dir_all(parent)?;
    let metadata = fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket directory must be a real directory",
        ));
    }
    if metadata.uid() != rustix::process::getuid().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket directory is not owned by the current user",
        ));
    }
    fs::set_permissions(parent, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

#[cfg(windows)]
fn prepare_endpoint(_endpoint: &str) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn create_listener(endpoint: &str) -> io::Result<LocalSocketListener> {
    use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName as _};
    use interprocess::os::unix::local_socket::ListenerOptionsExt;

    let name = endpoint.to_fs_name::<GenericFilePath>()?;
    ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .mode(0o600)
        .create_tokio()
}

#[cfg(windows)]
fn create_listener(endpoint: &str) -> io::Result<LocalSocketListener> {
    use interprocess::local_socket::{GenericNamespaced, ListenerOptions, ToNsName as _};
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt as _, security_descriptor::SecurityDescriptor,
    };
    use widestring::u16cstr;

    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    // Named pipes inherit a permissive default DACL that includes read access for Everyone and
    // anonymous users. Restrict the endpoint to its owner and LocalSystem, and protect the DACL
    // from inherited ACEs. The transport separately rejects remote clients.
    let security_descriptor =
        SecurityDescriptor::deserialize(u16cstr!("D:P(A;;GA;;;OW)(A;;GA;;;SY)"))?;
    ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .security_descriptor(security_descriptor)
        .create_tokio()
}

#[allow(clippy::fn_params_excessive_bools)]
fn apply_service_capabilities(
    capabilities: &mut Vec<String>,
    actions_available: bool,
    browser_automation_available: bool,
    agent_sessions_available: bool,
    remote_sessions_available: bool,
    sidebar_surfaces_available: bool,
) {
    for (available, capability) in [
        (
            actions_available,
            agent_workspace_protocol::ACTIONS_CAPABILITY,
        ),
        (
            browser_automation_available,
            agent_workspace_protocol::BROWSER_AUTOMATION_CAPABILITY,
        ),
        (agent_sessions_available, AGENT_SESSIONS_CAPABILITY),
        (
            remote_sessions_available,
            agent_workspace_protocol::REMOTE_SESSIONS_CAPABILITY,
        ),
        (sidebar_surfaces_available, SIDEBAR_SURFACES_CAPABILITY),
    ] {
        if available && !capabilities.iter().any(|value| value == capability) {
            capabilities.push(capability.to_owned());
        } else if !available {
            capabilities.retain(|value| value != capability);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_protocol::{
        APPLICATION_ID, PROTOCOL_VERSION, TerminalCheckpoint as ProtocolCheckpoint,
    };
    use agent_workspace_terminal_runtime::{
        MAX_OUTPUT_CHUNK_BYTES, POST_CHECKPOINT_JOURNAL_LIMIT_BYTES, TerminalNotificationSource,
    };
    use interprocess::local_socket::{GenericFilePath, tokio::Stream};
    use serde_json::{Value, json};
    use tempfile::tempdir;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        sync::oneshot,
    };

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn token_comparison_requires_equal_content_and_length() {
        assert!(tokens_match(TEST_TOKEN.as_bytes(), TEST_TOKEN.as_bytes()));
        assert!(!tokens_match(b"wrong", TEST_TOKEN.as_bytes()));
        assert!(!tokens_match(
            b"1123456789abcdef0123456789abcdef0123456789abcdef",
            TEST_TOKEN.as_bytes()
        ));
    }

    #[test]
    fn service_capabilities_are_truthful_ordered_and_deduplicated() {
        let mut capabilities = vec!["system.ping".to_owned()];
        apply_service_capabilities(&mut capabilities, true, false, false, false, false);
        assert_eq!(
            capabilities,
            vec!["system.ping".to_owned(), "actions-v1".to_owned()]
        );
        apply_service_capabilities(&mut capabilities, true, true, true, true, true);
        apply_service_capabilities(&mut capabilities, true, true, true, true, true);
        assert_eq!(
            capabilities,
            vec![
                "system.ping".to_owned(),
                "actions-v1".to_owned(),
                "browser-automation-v1".to_owned(),
                "agent-sessions-v1".to_owned(),
                "remote-sessions-v1".to_owned(),
                "sidebar-surfaces-v1".to_owned(),
            ]
        );
        apply_service_capabilities(&mut capabilities, false, false, false, false, false);
        assert_eq!(capabilities, vec!["system.ping".to_owned()]);
    }

    #[test]
    fn limiter_delays_repeated_failures() {
        let now = Instant::now();
        let mut limiter = AuthFailureLimiter::default();

        for _ in 0..MAX_AUTH_FAILURES {
            assert_eq!(limiter.record_failure(now), Duration::ZERO);
        }
        assert_eq!(limiter.record_failure(now), Duration::from_millis(250));
    }

    #[test]
    fn osc_notifications_are_reserved_for_the_global_bridge() {
        let event = RuntimeEvent::Notification {
            terminal_id: "terminal-id".to_owned(),
            source: TerminalNotificationSource::Osc9,
            title: None,
            body: "notice".to_owned(),
        };

        assert_eq!(runtime_event_terminal_id(&event), "terminal-id");
        assert!(terminal_event(event).is_none());
    }

    #[test]
    fn terminal_process_tree_includes_transitive_descendants_and_rejects_missing_roots() {
        let relations = [
            (10, Some(1)),
            (11, Some(10)),
            (12, Some(11)),
            (13, Some(99)),
            (14, Some(12)),
        ];

        assert_eq!(
            descendant_process_ids(10, relations),
            HashSet::from([10, 11, 12, 14])
        );
        assert!(descendant_process_ids(404, relations).is_empty());
    }

    #[test]
    fn terminal_ports_include_only_owned_tcp_listeners_with_a_bounded_stable_order() {
        let listener = |pid, port, protocol, state| listeners::Listener {
            process: listeners::Process {
                pid,
                name: "process".to_owned(),
                path: String::new(),
            },
            socket: format!("127.0.0.1:{port}").parse().unwrap(),
            protocol,
            state,
        };
        let mut sockets = vec![
            listener(
                11,
                5173,
                listeners::Protocol::TCP,
                listeners::SocketState::Listen,
            ),
            listener(
                10,
                3000,
                listeners::Protocol::TCP,
                listeners::SocketState::Listen,
            ),
            listener(
                10,
                3000,
                listeners::Protocol::TCP,
                listeners::SocketState::Listen,
            ),
            listener(
                10,
                4000,
                listeners::Protocol::UDP,
                listeners::SocketState::Unknown,
            ),
            listener(
                99,
                8080,
                listeners::Protocol::TCP,
                listeners::SocketState::Listen,
            ),
            listener(
                10,
                9000,
                listeners::Protocol::TCP,
                listeners::SocketState::Established,
            ),
        ];
        sockets.extend((1..=20).map(|port| {
            listener(
                10,
                port,
                listeners::Protocol::TCP,
                listeners::SocketState::Listen,
            )
        }));

        assert_eq!(
            listening_ports_for_process_ids(&HashSet::from([10, 11]), sockets),
            (1..=16).collect::<Vec<_>>()
        );
    }

    #[test]
    fn maximum_attach_projection_fits_the_outbound_frame() {
        let mut checkpoint_data = "x".repeat(MAX_TERMINAL_CHECKPOINT_WIRE_BYTES);
        let checkpoint = loop {
            let candidate = ProtocolCheckpoint {
                sequence: 1,
                rows: 24,
                cols: 80,
                active_buffer: TerminalActiveBuffer::Normal,
                data: checkpoint_data,
            };
            let overflow = serde_json::to_vec(&candidate)
                .expect("checkpoint must serialize")
                .len()
                .saturating_sub(MAX_TERMINAL_CHECKPOINT_WIRE_BYTES);
            if overflow == 0 {
                break candidate;
            }
            checkpoint_data = candidate.data[..candidate.data.len() - overflow].to_owned();
        };
        assert_eq!(
            serde_json::to_vec(&checkpoint)
                .expect("checkpoint must serialize")
                .len(),
            MAX_TERMINAL_CHECKPOINT_WIRE_BYTES
        );

        let output = (1..=POST_CHECKPOINT_JOURNAL_LIMIT_BYTES / MAX_OUTPUT_CHUNK_BYTES)
            .map(|sequence| RuntimeChunk {
                sequence: sequence as u64 + 1,
                data: vec![u8::MAX; MAX_OUTPUT_CHUNK_BYTES],
            })
            .collect();
        let snapshot = TerminalSnapshot {
            terminal: RuntimeDescriptor {
                id: "terminal-id".to_owned(),
                process_id: Some(u32::MAX),
                command: vec!["/bin/sh".to_owned()],
                cwd: "/tmp".into(),
                rows: 24,
                cols: 80,
                exited: false,
                exit_code: None,
            },
            checkpoint: Some(RuntimeCheckpoint {
                sequence: checkpoint.sequence,
                rows: checkpoint.rows,
                cols: checkpoint.cols,
                active_buffer: ActiveBuffer::Normal,
                data: checkpoint.data,
            }),
            output,
            last_sequence: 5,
            reconstruction_complete: true,
        };
        let response = success("attach-request".to_owned(), attach_result(snapshot));
        let frame = serialize_frame(&response).expect("maximum attach projection must fit");

        assert!(frame.len() < MAX_CONTROL_MESSAGE_BYTES);
    }

    #[test]
    fn outbound_frame_enforces_the_exact_wire_boundary() {
        let exact = Value::String("x".repeat(MAX_CONTROL_MESSAGE_BYTES - 3));
        assert_eq!(
            serialize_frame(&exact)
                .expect("exactly bounded frame must serialize")
                .len(),
            MAX_CONTROL_MESSAGE_BYTES
        );

        let oversized = Value::String("x".repeat(MAX_CONTROL_MESSAGE_BYTES - 2));
        let error = serialize_frame(&oversized).expect_err("oversized frame must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn escape_heavy_checkpoint_over_wire_budget_is_rejected_by_strict_params() {
        let request = RequestEnvelope {
            id: "checkpoint-request".to_owned(),
            command: "terminal.checkpoint".to_owned(),
            params: serde_json::to_value(TerminalCheckpointParams {
                terminal_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                checkpoint: ProtocolCheckpoint {
                    sequence: 0,
                    rows: 24,
                    cols: 80,
                    active_buffer: TerminalActiveBuffer::Normal,
                    data: "\0".repeat(MAX_TERMINAL_CHECKPOINT_WIRE_BYTES / 6),
                },
            })
            .expect("checkpoint request must serialize"),
        };

        let terminals = TerminalManager::new();
        let context = ControlContext {
            terminal_io: terminals.io_handle(),
            terminal_backend: None,
            logging_runtime: None,
            terminal_lifecycle: TerminalLifecycle::LegacyTest(terminals),
            runtime: None,
            persistence: None,
            card_slots: None,
            card_slots_v2: None,
            attention: None,
            actions: None,
            browser_automation: None,
            agent_sessions: None,
            remote_sessions: None,
            sidebar_content: None,
            multi_window: None,
            platform: ShortcutPlatform::NonMacOs,
        };
        let response = dispatch(
            request,
            &context,
            &Mutex::new(HashSet::new()),
            &Mutex::new(None),
        )
        .await;

        assert!(!response.ok);
        assert_eq!(
            response.error.expect("failure must include an error").code,
            "invalid_params"
        );
    }

    #[test]
    fn escape_heavy_outbound_frame_is_rejected() {
        let oversized = Value::String("\0".repeat(MAX_CONTROL_MESSAGE_BYTES / 6 + 1));
        let error = serialize_frame(&oversized).expect_err("escaped frame must be rejected");

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn stale_binding_cleanup_allows_only_an_exact_existing_terminal_detach() {
        let terminal_id = "00000000-0000-4000-8000-000000000001";
        let attachments = Mutex::new(HashSet::from([terminal_id.to_owned()]));
        let exact = serde_json::json!({ "terminalId": terminal_id });

        assert!(
            permits_stale_attached_terminal_detach(true, "terminal.detach", &exact, &attachments)
                .await
        );
        assert!(
            !permits_stale_attached_terminal_detach(false, "terminal.detach", &exact, &attachments)
                .await
        );
        assert!(
            !permits_stale_attached_terminal_detach(true, "terminal.attach", &exact, &attachments)
                .await
        );
        assert!(
            !permits_stale_attached_terminal_detach(
                true,
                "terminal.detach",
                &serde_json::json!({
                    "terminalId": "00000000-0000-4000-8000-000000000002"
                }),
                &attachments
            )
            .await
        );
        assert!(
            !permits_stale_attached_terminal_detach(
                true,
                "terminal.detach",
                &serde_json::json!({ "terminalId": terminal_id, "extra": true }),
                &attachments
            )
            .await
        );
    }

    #[tokio::test]
    async fn attach_subscription_precedes_snapshot_and_rolls_back_on_failure() {
        let attachments = Mutex::new(HashSet::new());
        let terminal_id = "terminal-id";
        let snapshot = TerminalSnapshot {
            terminal: RuntimeDescriptor {
                id: terminal_id.to_owned(),
                process_id: Some(42),
                command: vec!["shell".to_owned()],
                cwd: ".".into(),
                rows: 24,
                cols: 80,
                exited: false,
                exit_code: None,
            },
            checkpoint: None,
            output: Vec::new(),
            last_sequence: 0,
            reconstruction_complete: true,
        };

        let attached = subscribe_before_snapshot(terminal_id, &attachments, || {
            assert!(
                attachments
                    .try_lock()
                    .expect("subscription lock must be released before snapshot")
                    .contains(terminal_id)
            );
            Ok(snapshot)
        })
        .await
        .expect("snapshot must succeed");
        assert_eq!(attached.terminal.id, terminal_id);
        assert!(attachments.lock().await.contains(terminal_id));

        let missing_id = "missing-terminal";
        let error = subscribe_before_snapshot(missing_id, &attachments, || {
            assert!(
                attachments
                    .try_lock()
                    .expect("subscription lock must be released before snapshot")
                    .contains(missing_id)
            );
            Err(TerminalError::NotFound)
        })
        .await
        .expect_err("failed snapshot must be returned");
        assert!(matches!(error, TerminalError::NotFound));
        assert!(!attachments.lock().await.contains(missing_id));
    }

    #[tokio::test]
    async fn non_reading_control_writer_is_bounded_by_a_timeout() {
        let (mut writer, _reader) = tokio::io::duplex(1);
        let error = write_all_with_timeout(&mut writer, &[b'x'; 1024], Duration::from_millis(10))
            .await
            .expect_err("a stalled writer must time out");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn v2_slot_storm_cannot_delay_ping_or_terminal_output() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        prepare_endpoint(&endpoint).expect("endpoint must be prepared");
        let listener = create_listener(&endpoint).expect("listener must bind");
        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");
        let client = Stream::connect(name).await.expect("client must connect");
        let server_stream = listener.accept().await.expect("server must accept");

        let (response_tx, response_rx) = mpsc::channel(32);
        let (event_tx, event_rx) = mpsc::channel(16);
        let (v2_tx, v2_rx) = mpsc::channel(1);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let card_slots = card_slots::CardSlotV2Runtime::new();
        let v2_forwarder = tokio::spawn(card_slots::forward_v2_events(
            card_slots.clone(),
            card_slots.subscribe(),
            v2_tx,
            None,
        ));
        let storm_runtime = card_slots.clone();
        let storm = tokio::spawn(async move {
            let mut revision = 0;
            loop {
                revision += 1;
                let _ =
                    storm_runtime
                        .events
                        .send(agent_workspace_protocol::WorkspaceCardSlotV2ChangedEvent {
                        workspace_id: "10000000-0000-4000-8000-000000000001".to_owned(),
                        kind: agent_workspace_protocol::WorkspaceCardSlotV2Kind::LogTail,
                        slot_revision: revision,
                        reason:
                            agent_workspace_protocol::WorkspaceCardSlotV2ChangeReason::SlotReplaced,
                    });
                if revision % 100 == 0 {
                    tokio::task::yield_now().await;
                }
            }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        response_tx
            .send(
                serialize_frame(&ResponseEnvelope::success(
                    "ping".to_owned(),
                    json!({ "pong": true }),
                ))
                .expect("ping frame must serialize"),
            )
            .await
            .expect("ping must queue");
        event_tx
            .send(
                serialize_frame(&event_envelope(
                    "terminal.output",
                    TerminalOutputEvent {
                        terminal_id: "terminal-id".to_owned(),
                        chunk: TerminalOutputChunk {
                            sequence: 1,
                            byte_length: 1,
                            data: BASE64.encode(b"x"),
                        },
                    },
                ))
                .expect("terminal frame must serialize"),
            )
            .await
            .expect("terminal output must queue");
        let writer = tokio::spawn(write_loop(
            Arc::new(server_stream),
            response_rx,
            event_rx,
            v2_rx,
            shutdown_rx,
        ));

        let mut reader = BufReader::new(&client);
        let received = tokio::time::timeout(Duration::from_millis(250), async {
            let mut received = Vec::new();
            while received.len() < 2 {
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("frame must read");
                received.push(serde_json::from_str::<Value>(&line).expect("frame must be JSON"));
            }
            received
        })
        .await
        .expect("ping and terminal output must not be starved");
        assert_eq!(received[0]["id"], "ping");
        assert_eq!(received[1]["event"], "terminal.output");

        storm.abort();
        v2_forwarder.abort();
        writer.abort();
    }

    #[tokio::test]
    async fn completed_control_handlers_drain_cleanly() {
        let mut handlers = JoinSet::new();
        handlers.spawn(async {});

        assert!(drain_handlers(&mut handlers, Duration::from_secs(1)).await);
        assert!(handlers.is_empty());
    }

    #[tokio::test]
    async fn stalled_control_handlers_are_aborted_at_the_drain_deadline() {
        let mut handlers = JoinSet::new();
        handlers.spawn(std::future::pending());

        assert!(!drain_handlers(&mut handlers, Duration::from_millis(10)).await);
        assert!(handlers.is_empty());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn authenticated_client_receives_shutdown_event_before_disconnect() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        let server =
            ControlServer::bind_legacy_for_test(&endpoint, TEST_TOKEN).expect("server must bind");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(server.run(async {
            let _ = shutdown_rx.await;
        }));

        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");
        let stream = Stream::connect(name).await.expect("client must connect");
        let mut writer = &stream;
        writer
            .write_all(
                format!(
                    "{{\"auth\":{{\"token\":\"{TEST_TOKEN}\"}}}}\n\
                     {{\"id\":\"ready\",\"command\":\"system.ping\",\"params\":{{}}}}\n"
                )
                .as_bytes(),
            )
            .await
            .expect("authentication probe must be written");
        let mut reader = BufReader::new(&stream);
        let mut response = String::new();
        reader
            .read_line(&mut response)
            .await
            .expect("probe response must be read");
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap()["ok"],
            true
        );

        shutdown_tx.send(()).expect("shutdown must send");
        let mut event = String::new();
        tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut event))
            .await
            .expect("shutdown event must arrive before the drain deadline")
            .expect("shutdown event must be readable");
        let event: Value = serde_json::from_str(&event).expect("shutdown event must be JSON");
        assert_eq!(event["event"], "service.shuttingDown");
        assert_eq!(event["data"]["reason"], "service_shutdown");

        task.await
            .expect("server task must join")
            .expect("server must stop cleanly");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn repeated_normal_v2_disconnects_release_client_permits() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        let terminals = TerminalManager::new();
        let server = ControlServer::bind_inner(
            &endpoint,
            TEST_TOKEN,
            ControlContext {
                terminal_io: terminals.io_handle(),
                terminal_backend: None,
                logging_runtime: None,
                terminal_lifecycle: TerminalLifecycle::LegacyTest(terminals),
                runtime: None,
                persistence: None,
                card_slots: None,
                card_slots_v2: Some(card_slots::CardSlotV2Runtime::new()),
                attention: None,
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: None,
                platform: ShortcutPlatform::NonMacOs,
            },
        )
        .expect("server must bind");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(server.run(async {
            let _ = shutdown_rx.await;
        }));
        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");

        for index in 0..=MAX_CLIENTS {
            let stream = Stream::connect(name.clone())
                .await
                .expect("client must connect");
            let mut writer = &stream;
            writer
                .write_all(
                    format!(
                        "{{\"auth\":{{\"token\":\"{TEST_TOKEN}\"}}}}\n\
                         {{\"id\":\"ping-{index}\",\"command\":\"system.ping\",\"params\":{{}}}}\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("probe must write");
            let mut response = String::new();
            tokio::time::timeout(
                Duration::from_secs(1),
                BufReader::new(&stream).read_line(&mut response),
            )
            .await
            .expect("a permit must remain available")
            .expect("probe response must read");
            assert_eq!(
                serde_json::from_str::<Value>(&response).expect("response must be JSON")["ok"],
                true
            );
            drop(stream);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        shutdown_tx.send(()).expect("shutdown must send");
        task.await
            .expect("server task must join")
            .expect("server must stop cleanly");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn authenticated_client_can_identify_the_service() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        let server =
            ControlServer::bind_legacy_for_test(&endpoint, TEST_TOKEN).expect("server must bind");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(server.run(async {
            let _ = shutdown_rx.await;
        }));

        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");
        let stream = Stream::connect(name).await.expect("client must connect");
        let mut writer = &stream;
        writer
            .write_all(
                format!(
                    "{{\"auth\":{{\"token\":\"{TEST_TOKEN}\"}}}}\n\
                     {{\"id\":\"request-1\",\"command\":\"system.identify\",\"params\":{{}}}}\n"
                )
                .as_bytes(),
            )
            .await
            .expect("request must be written");

        let mut line = String::new();
        BufReader::new(&stream)
            .read_line(&mut line)
            .await
            .expect("response must be read");
        let response: Value = serde_json::from_str(&line).expect("response must be JSON");

        assert_eq!(response["ok"], json!(true));
        assert_eq!(response["result"]["application"], json!(APPLICATION_ID));
        assert_eq!(
            response["result"]["protocolVersion"],
            json!(PROTOCOL_VERSION)
        );

        shutdown_tx.send(()).expect("shutdown must send");
        task.await
            .expect("server task must join")
            .expect("server must stop cleanly");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn authenticated_client_replays_identical_request_and_rejects_divergent_id_reuse() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        let server =
            ControlServer::bind_legacy_for_test(&endpoint, TEST_TOKEN).expect("server must bind");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(server.run(async {
            let _ = shutdown_rx.await;
        }));

        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");
        let stream = Stream::connect(name).await.expect("client must connect");
        let mut writer = &stream;
        writer
            .write_all(
                format!(
                    "{{\"auth\":{{\"token\":\"{TEST_TOKEN}\"}}}}\n\
                     {{\"id\":\"replay\",\"command\":\"system.ping\",\"params\":{{}}}}\n\
                     {{\"id\":\"replay\",\"command\":\"system.ping\",\"params\":{{}}}}\n\
                     {{\"id\":\"replay\",\"command\":\"system.identify\",\"params\":{{}}}}\n"
                )
                .as_bytes(),
            )
            .await
            .expect("requests must be written");

        let mut reader = BufReader::new(&stream);
        let mut first = String::new();
        let mut replay = String::new();
        let mut divergent = String::new();
        reader.read_line(&mut first).await.unwrap();
        reader.read_line(&mut replay).await.unwrap();
        reader.read_line(&mut divergent).await.unwrap();
        assert_eq!(first.as_bytes(), replay.as_bytes());
        let divergent: Value = serde_json::from_str(&divergent).unwrap();
        assert_eq!(divergent["error"]["code"], "duplicate_request_id");

        shutdown_tx.send(()).expect("shutdown must send");
        task.await
            .expect("server task must join")
            .expect("server must stop cleanly");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn long_request_does_not_head_of_line_block_later_request_on_same_connection() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        let server =
            ControlServer::bind_legacy_for_test(&endpoint, TEST_TOKEN).expect("server must bind");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(server.run(async {
            let _ = shutdown_rx.await;
        }));

        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");
        let stream = Stream::connect(name).await.expect("client must connect");
        let mut writer = &stream;
        writer
            .write_all(
                format!(
                    "{{\"auth\":{{\"token\":\"{TEST_TOKEN}\"}}}}\n\
                     {{\"id\":\"wait\",\"command\":\"system.testWait\",\"params\":{{}}}}\n\
                     {{\"id\":\"ping\",\"command\":\"system.ping\",\"params\":{{}}}}\n"
                )
                .as_bytes(),
            )
            .await
            .expect("requests must be written");

        let mut reader = BufReader::new(&stream);
        let mut first = String::new();
        tokio::time::timeout(Duration::from_millis(250), reader.read_line(&mut first))
            .await
            .expect("ping must bypass the long request")
            .expect("response must be readable");
        assert_eq!(serde_json::from_str::<Value>(&first).unwrap()["id"], "ping");
        let mut second = String::new();
        reader.read_line(&mut second).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&second).unwrap()["id"],
            "wait"
        );

        shutdown_tx.send(()).expect("shutdown must send");
        task.await
            .expect("server task must join")
            .expect("server must stop cleanly");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn unauthenticated_client_receives_an_error() {
        let temp = tempdir().expect("temporary directory must be created");
        let socket = temp.path().join("runtime/control.sock");
        let endpoint = socket.to_string_lossy().into_owned();
        let server =
            ControlServer::bind_legacy_for_test(&endpoint, TEST_TOKEN).expect("server must bind");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(server.run(async {
            let _ = shutdown_rx.await;
        }));

        let name = endpoint
            .as_str()
            .to_fs_name::<GenericFilePath>()
            .expect("socket name must be valid");
        let stream = Stream::connect(name).await.expect("client must connect");
        let mut writer = &stream;
        writer
            .write_all(b"{\"auth\":{\"token\":\"incorrect-token\"}}\n")
            .await
            .expect("auth preamble must be written");

        let mut line = String::new();
        BufReader::new(&stream)
            .read_line(&mut line)
            .await
            .expect("response must be read");
        let response: Value = serde_json::from_str(&line).expect("response must be JSON");

        assert_eq!(response["ok"], json!(false));
        assert_eq!(response["error"]["code"], json!("unauthenticated"));

        shutdown_tx.send(()).expect("shutdown must send");
        task.await
            .expect("server task must join")
            .expect("server must stop cleanly");
    }
}

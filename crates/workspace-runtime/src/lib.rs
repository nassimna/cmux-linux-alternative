//! Serialized application orchestration across the pure domain, durable storage, and PTYs.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::{Arc, OnceLock},
};

use agent_workspace_core::{
    ApplicationState, DomainError, LayoutId, MutationOutcome, PaneId, RuntimeSessionId, Tab,
    TabContent, TabId, TerminalLaunchRequest, TerminalLaunchSpec, Timestamp, WindowId, Workspace,
    WorkspaceId,
};
use agent_workspace_storage::{
    EpochIdempotencyLookup as StoreEpochIdempotencyLookup, EpochIdempotencySaveRequest,
    IdempotencyLookup as StoreIdempotencyLookup,
    IdempotencySaveOutcome as StoreIdempotencySaveOutcome, IdempotencySaveRequest,
    SqliteStateStore, StorageError,
};
use agent_workspace_terminal_runtime::{TerminalIoHandle, TerminalManager, TerminalSpawnRequest};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{Mutex, broadcast, oneshot};
use uuid::Uuid;

const EVENT_CHANNEL_CAPACITY: usize = 256;

/// A synchronous snapshot store. Implemented by the production `SQLite` store and test fakes.
pub trait StateStore: Send + Sync + 'static {
    /// Load the latest durable state.
    ///
    /// # Errors
    /// Returns a stable store error when the snapshot cannot be read or validated.
    fn load(&self) -> Result<Option<ApplicationState>, StoreError>;

    /// Atomically persist a state snapshot.
    ///
    /// # Errors
    /// Returns a stable store error when validation or durable replacement fails.
    fn save(&self, state: &ApplicationState) -> Result<(), StoreError>;

    /// Atomically persist a state snapshot and an exact bounded idempotency result.
    ///
    /// # Errors
    /// Returns a stable store error when validation or durable replacement fails.
    fn save_with_idempotency(
        &self,
        state: &ApplicationState,
        _request: &IdempotencySaveRequest,
    ) -> Result<StoreIdempotencySaveOutcome, StoreError> {
        self.save(state)?;
        Ok(StoreIdempotencySaveOutcome::Committed)
    }

    /// Look up an exact namespaced idempotency result before lifecycle effects begin.
    ///
    /// Alternate stores that support durable idempotency must override this together with
    /// [`Self::save_with_idempotency`]. The default keeps legacy in-memory test stores compatible.
    ///
    /// # Errors
    /// Returns a stable store error when the idempotency record cannot be read.
    fn load_idempotency_result(
        &self,
        _namespace: &str,
        _idempotency_key: &str,
        _request_json: &str,
    ) -> Result<StoreIdempotencyLookup, StoreError> {
        Ok(StoreIdempotencyLookup::Missing)
    }

    /// Return the current server-issued epoch for durable multi-window mutations.
    ///
    /// # Errors
    /// Returns a stable store error when the epoch cannot be read.
    fn current_idempotency_epoch(&self) -> Result<Uuid, StoreError> {
        Ok(Uuid::nil())
    }

    /// Start a new service-lifecycle epoch and expire every prior exact result.
    ///
    /// Alternate stores without durable epoch support retain their current
    /// compatibility epoch.
    ///
    /// # Errors
    /// Returns a stable store error when lifecycle invalidation cannot commit.
    fn rotate_idempotency_epoch(&self) -> Result<Uuid, StoreError> {
        self.current_idempotency_epoch()
    }

    /// Look up one epoch-scoped exact result before lifecycle effects.
    ///
    /// # Errors
    /// Returns a stable store error when the epoch-scoped record cannot be read.
    fn load_epoch_idempotency_result(
        &self,
        _namespace: &str,
        _epoch: Uuid,
        _idempotency_key: Uuid,
        _request_hash: &str,
    ) -> Result<StoreEpochIdempotencyLookup, StoreError> {
        Ok(StoreEpochIdempotencyLookup::Missing)
    }

    /// Commit state and an exact epoch-scoped result atomically.
    ///
    /// # Errors
    /// Returns a stable store error when the aggregate and result cannot be committed atomically.
    fn save_with_epoch_idempotency(
        &self,
        state: &ApplicationState,
        request: &EpochIdempotencySaveRequest,
    ) -> Result<StoreEpochIdempotencyLookup, StoreError> {
        self.save(state)?;
        Ok(StoreEpochIdempotencyLookup::Replay(
            request.result_json.clone(),
        ))
    }
}

impl StateStore for SqliteStateStore {
    fn load(&self) -> Result<Option<ApplicationState>, StoreError> {
        SqliteStateStore::load(self).map_err(StoreError::from)
    }

    fn save(&self, state: &ApplicationState) -> Result<(), StoreError> {
        SqliteStateStore::save(self, state).map_err(StoreError::from)
    }

    fn save_with_idempotency(
        &self,
        state: &ApplicationState,
        request: &IdempotencySaveRequest,
    ) -> Result<StoreIdempotencySaveOutcome, StoreError> {
        SqliteStateStore::save_with_idempotency(self, state, request).map_err(StoreError::from)
    }

    fn load_idempotency_result(
        &self,
        namespace: &str,
        idempotency_key: &str,
        request_json: &str,
    ) -> Result<StoreIdempotencyLookup, StoreError> {
        SqliteStateStore::load_idempotency_result(self, namespace, idempotency_key, request_json)
            .map_err(StoreError::from)
    }

    fn current_idempotency_epoch(&self) -> Result<Uuid, StoreError> {
        SqliteStateStore::current_idempotency_epoch(self).map_err(StoreError::from)
    }

    fn rotate_idempotency_epoch(&self) -> Result<Uuid, StoreError> {
        SqliteStateStore::rotate_idempotency_epoch(self).map_err(StoreError::from)
    }

    fn load_epoch_idempotency_result(
        &self,
        namespace: &str,
        epoch: Uuid,
        idempotency_key: Uuid,
        request_hash: &str,
    ) -> Result<StoreEpochIdempotencyLookup, StoreError> {
        SqliteStateStore::load_epoch_idempotency_result(
            self,
            namespace,
            epoch,
            idempotency_key,
            request_hash,
        )
        .map_err(StoreError::from)
    }

    fn save_with_epoch_idempotency(
        &self,
        state: &ApplicationState,
        request: &EpochIdempotencySaveRequest,
    ) -> Result<StoreEpochIdempotencyLookup, StoreError> {
        SqliteStateStore::save_with_epoch_idempotency(self, state, request)
            .map_err(StoreError::from)
    }
}

/// A stable storage failure boundary suitable for alternate stores and deterministic fakes.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct StoreError {
    message: String,
}

impl StoreError {
    /// Construct a store failure while retaining an actionable message.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<StorageError> for StoreError {
    fn from(value: StorageError) -> Self {
        Self::new(value.to_string())
    }
}

/// Narrow PTY lifecycle used by workspace orchestration.
pub trait TerminalBackend: Send + Sync + 'static {
    /// Create one live terminal and return its runtime-only identity.
    fn create(
        &self,
        authority: &LifecycleAuthority,
        request: TerminalSpawnRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RuntimeSessionId, TerminalBackendError>> + Send + '_>>;

    /// Terminate a live terminal.
    fn terminate(
        &self,
        authority: &LifecycleAuthority,
        session_id: &RuntimeSessionId,
    ) -> Pin<Box<dyn Future<Output = Result<(), TerminalBackendError>> + Send + '_>>;
}

/// Unforgeable lifecycle capability passed to terminal backend implementations.
///
/// The type is public so alternate backends can implement [`TerminalBackend`], but only this crate
/// can construct a value. Consequently, holding a production backend does not grant permission to
/// create or terminate terminals outside [`WorkspaceRuntime`].
pub struct LifecycleAuthority {
    _private: (),
}

static LIFECYCLE_AUTHORITY: LifecycleAuthority = LifecycleAuthority { _private: () };

const fn lifecycle_authority() -> &'static LifecycleAuthority {
    &LIFECYCLE_AUTHORITY
}

/// Production adapter over [`TerminalManager`].
#[derive(Clone)]
pub struct TerminalManagerBackend {
    manager: TerminalManager,
    terminal_io: TerminalIoHandle,
}

impl TerminalManagerBackend {
    /// Wrap a terminal manager without changing its ownership semantics.
    #[must_use]
    pub fn new(manager: TerminalManager) -> Self {
        let terminal_io = manager.io_handle();
        Self {
            manager,
            terminal_io,
        }
    }

    /// Access existing terminals without gaining create, terminate, or shutdown authority.
    ///
    /// ```compile_fail
    /// use agent_workspace_terminal_runtime::TerminalManager;
    /// use agent_workspace_runtime::TerminalManagerBackend;
    ///
    /// let backend = TerminalManagerBackend::new(TerminalManager::new());
    /// backend.terminal_io().shutdown_all();
    /// ```
    #[must_use]
    pub const fn terminal_io(&self) -> &TerminalIoHandle {
        &self.terminal_io
    }

    /// Validate a configured default shell against the current host without changing the
    /// terminal runtime.
    ///
    /// # Errors
    /// Returns a stable backend error when the path is not an absolute executable file.
    pub fn validate_configured_shell(
        &self,
        shell: Option<&Path>,
    ) -> Result<(), TerminalBackendError> {
        TerminalManager::validate_configured_shell(shell)
            .map_err(|error| TerminalBackendError::new(error.to_string()))
    }

    /// Change the shell used by future implicit terminal launches. Existing sessions are left
    /// untouched.
    ///
    /// The value must already have passed [`Self::validate_configured_shell`]. The final swap is
    /// deliberately infallible so a persisted configuration can be applied atomically after all
    /// fallible runtime mutations complete.
    pub fn set_configured_shell(&self, shell: Option<PathBuf>) {
        self.manager.set_configured_shell(shell);
    }

    /// Starts a remote transport from the terminal crate's closed validated launch plan.
    ///
    /// # Errors
    /// Returns a stable backend error when the validated SSH launch cannot be started.
    pub async fn create_remote(
        &self,
        plan: &agent_workspace_terminal_runtime::remote::SshLaunchPlan,
        rows: u16,
        cols: u16,
    ) -> Result<RuntimeSessionId, TerminalBackendError> {
        self.manager
            .create_remote(plan, rows, cols)
            .await
            .map(|terminal| RuntimeSessionId::new(terminal.id))
            .map_err(|error| TerminalBackendError::new(error.to_string()))
    }

    /// Releases one service-owned remote transport without affecting remote tmux process health.
    ///
    /// # Errors
    /// Returns a stable backend error when the runtime cannot terminate the transport.
    pub async fn terminate_remote(
        &self,
        session_id: &RuntimeSessionId,
    ) -> Result<(), TerminalBackendError> {
        self.manager
            .terminate(session_id.as_str())
            .await
            .map_err(|error| TerminalBackendError::new(error.to_string()))
    }
}

impl TerminalBackend for TerminalManagerBackend {
    fn create(
        &self,
        _authority: &LifecycleAuthority,
        request: TerminalSpawnRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RuntimeSessionId, TerminalBackendError>> + Send + '_>>
    {
        Box::pin(async move {
            self.manager
                .create(request)
                .await
                .map(|terminal| RuntimeSessionId::new(terminal.id))
                .map_err(|error| TerminalBackendError::new(error.to_string()))
        })
    }

    fn terminate(
        &self,
        _authority: &LifecycleAuthority,
        session_id: &RuntimeSessionId,
    ) -> Pin<Box<dyn Future<Output = Result<(), TerminalBackendError>> + Send + '_>> {
        let session_id = session_id.as_str().to_owned();
        Box::pin(async move {
            self.manager
                .terminate(&session_id)
                .await
                .map_err(|error| TerminalBackendError::new(error.to_string()))
        })
    }
}

/// Stable terminal failure boundary used by production and fake backends.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct TerminalBackendError {
    message: String,
}

impl TerminalBackendError {
    /// Construct a backend failure while retaining an actionable message.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Bootstrap defaults used only when durable storage is empty.
#[derive(Clone, Debug)]
pub struct BootstrapConfig {
    default_state: ApplicationState,
}

impl BootstrapConfig {
    /// Build a single-terminal default workspace rooted at the service working directory.
    ///
    /// # Errors
    /// Returns a domain validation error when the directory or terminal dimensions are invalid.
    pub fn for_service(
        service_default_cwd: PathBuf,
        started_at: Timestamp,
        rows: u16,
        cols: u16,
    ) -> Result<Self, DomainError> {
        let workspace_id = WorkspaceId::new();
        let pane_id = PaneId::new();
        let tab = Tab::terminal(
            TabId::new(),
            pane_id,
            "Terminal",
            TerminalLaunchSpec::new(service_default_cwd.clone(), None, rows, cols)?,
            None,
            started_at,
        )?;
        let workspace = Workspace::new(
            workspace_id,
            "Workspace 1",
            service_default_cwd,
            pane_id,
            tab,
            started_at,
            started_at,
        )?;
        Ok(Self {
            default_state: ApplicationState::new(workspace)?,
        })
    }

    /// Use a caller-constructed default state when the store is empty.
    ///
    /// # Errors
    /// Returns a domain error when the supplied state is invalid.
    pub fn from_state(default_state: ApplicationState) -> Result<Self, DomainError> {
        default_state.validate()?;
        Ok(Self { default_state })
    }
}

/// Ephemeral launch data. It is consumed by the terminal backend and never added to domain state.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LaunchOptions {
    commands: BTreeMap<TabId, Vec<String>>,
}

impl LaunchOptions {
    /// Add the process argv for a terminal tab created by the same mutation.
    #[must_use]
    pub fn with_command(mut self, tab_id: TabId, command: Vec<String>) -> Self {
        self.commands.insert(tab_id, command);
        self
    }
}

/// A revisioned event emitted after durable commit and authoritative-state swap.
#[derive(Clone, Debug, PartialEq)]
pub struct DomainEvent {
    /// Newly committed revision.
    pub revision: u64,
    /// Complete authoritative snapshot at that revision.
    pub snapshot: ApplicationState,
}

/// A session that could not be terminated after commit or while rolling back a new PTY.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminationFailure {
    /// Runtime-only terminal identity.
    pub session_id: RuntimeSessionId,
    /// Backend failure detail.
    pub error: TerminalBackendError,
}

/// Successful durable mutation result. Termination failures do not obscure the committed state.
#[derive(Clone, Debug, PartialEq)]
pub struct CommitResult {
    /// Committed authoritative state.
    pub snapshot: ApplicationState,
    /// Old sessions whose post-commit termination failed.
    pub termination_failures: Vec<TerminationFailure>,
}

/// Outcome of a mutation whose exact response is durably idempotent.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq)]
pub enum IdempotentCommitResult {
    Committed(CommitResult),
    Replay(String),
    Conflict,
}

/// Epoch-aware durable mutation outcome. Expired tickets are terminal and never execute anew.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq)]
pub enum EpochIdempotentCommitResult {
    Committed {
        commit: CommitResult,
        result_json: String,
    },
    Replay(String),
    Conflict,
    ResultExpired,
    EpochExpired,
}

/// Epoch-scoped lookup identity retained before an exact post-lifecycle result exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochMutationTicket {
    pub namespace: String,
    pub epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub retention_capacity: usize,
}

/// Construct a schema-v5 request hash over the exact canonical request JSON.
#[must_use]
pub fn epoch_idempotency_ticket(
    namespace: impl Into<String>,
    epoch: Uuid,
    idempotency_key: Uuid,
    request_json: &str,
    retention_capacity: usize,
) -> EpochMutationTicket {
    let request_hash = format!("{:x}", Sha256::digest(request_json.as_bytes()));
    EpochMutationTicket {
        namespace: namespace.into(),
        epoch,
        idempotency_key,
        request_hash,
        retention_capacity,
    }
}

/// Pre-commit error plus any failure to clean up newly-created sessions.
#[derive(Debug, Error)]
#[error("{error}")]
pub struct OperationFailure {
    /// Error that prevented commit.
    pub error: RuntimeError,
    /// New sessions that also failed cleanup during rollback.
    pub rollback_termination_failures: Vec<TerminationFailure>,
}

/// Errors that prevent a state change from committing.
#[derive(Debug, Error)]
pub enum RuntimeError {
    /// Pure domain mutation failed.
    #[error(transparent)]
    Domain(#[from] DomainError),
    /// Durable snapshot operation failed.
    #[error("state storage failed: {0}")]
    Store(#[from] StoreError),
    /// Creating a required PTY failed.
    #[error("terminal creation failed: {0}")]
    Terminal(#[from] TerminalBackendError),
    /// Ephemeral command data named a tab not launched by the mutation.
    #[error("ephemeral command supplied for terminal tab {tab_id} that is not launched")]
    UnexpectedCommand { tab_id: TabId },
    /// A mutation closure did not obey the core mutation revision contract.
    #[error("domain mutation returned an inconsistent revision")]
    InvalidMutationContract,
    /// The caller's application revision precondition no longer matches authoritative state.
    #[error("application revision is stale (expected {expected}, current {current})")]
    StaleStateRevision { expected: u64, current: u64 },
    /// The caller's placement revision precondition no longer matches authoritative state.
    #[error("window {window_id} revision is stale or the placement no longer exists")]
    StaleWindowRevision { window_id: WindowId },
    /// An orchestration task stopped before returning its result.
    #[error("workspace runtime worker failed")]
    Worker,
    /// Restart was requested for a browser tab.
    #[error("tab {tab_id} is not a terminal")]
    TabNotTerminal { tab_id: TabId },
    /// Restart target does not exist in the requested workspace.
    #[error("tab {tab_id} does not exist in workspace {workspace_id}")]
    TabNotFound {
        workspace_id: WorkspaceId,
        tab_id: TabId,
    },
    /// The runtime has crossed its process-shutdown lifecycle boundary.
    #[error("workspace runtime is shutting down")]
    ShuttingDown,
}

struct AuthoritativeState {
    state: ApplicationState,
    shutting_down: bool,
}

/// Serialized authoritative workspace state and its PTY lifecycle coordinator.
pub struct WorkspaceRuntime<S, B> {
    store: Arc<S>,
    terminals: Arc<B>,
    authoritative: Arc<Mutex<AuthoritativeState>>,
    events: broadcast::Sender<DomainEvent>,
}

/// Production facade type using `SQLite` and the Milestone 1 terminal manager.
pub type ProductionWorkspaceRuntime = WorkspaceRuntime<SqliteStateStore, TerminalManagerBackend>;

impl<S, B> WorkspaceRuntime<S, B>
where
    S: StateStore,
    B: TerminalBackend,
{
    /// Load durable state or create a default, reopen every stored terminal tab, and persist it.
    ///
    /// No partially restored state is exposed. A launch or save failure terminates all PTYs created
    /// during bootstrap and leaves the durable snapshot unchanged when it already existed.
    ///
    /// # Errors
    /// Returns the pre-commit failure and any failed rollback terminations.
    pub async fn bootstrap(
        store: Arc<S>,
        terminals: Arc<B>,
        config: BootstrapConfig,
    ) -> Result<Self, OperationFailure> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let task_store = Arc::clone(&store);
        let task_terminals = Arc::clone(&terminals);
        spawn_lifecycle_worker(async move {
            let result = bootstrap_inner(task_store, Arc::clone(&task_terminals), config).await;
            if let Err(Ok(abandoned)) = reply_tx.send(result) {
                let _ = terminate_sessions(&abandoned.created, task_terminals.as_ref()).await;
            }
        })?;
        let bootstrapped = reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))??;
        Ok(Self {
            store,
            terminals,
            authoritative: Arc::new(Mutex::new(AuthoritativeState {
                state: bootstrapped.state,
                shutting_down: false,
            })),
            events: bootstrapped.events,
        })
    }

    /// Clone the current authoritative snapshot.
    pub async fn snapshot(&self) -> ApplicationState {
        self.authoritative.lock().await.state.clone()
    }

    /// Subscribe to domain commits. Lag is explicit through Tokio's broadcast receiver error.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<DomainEvent> {
        self.events.subscribe()
    }

    /// Read the current durable epoch used by all `multi-window-v1` mutation tickets.
    ///
    /// # Errors
    /// Returns a stable store error when the epoch cannot be read.
    pub async fn current_idempotency_epoch(&self) -> Result<Uuid, StoreError> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.current_idempotency_epoch())
            .await
            .map_err(|_| StoreError::new("idempotency epoch storage worker failed"))?
    }

    /// Apply one pure core mutation with optional per-new-tab ephemeral commands.
    ///
    /// The whole candidate/create/bind/save/swap sequence is serialized. Newly created PTYs are
    /// rolled back on every pre-commit failure. Removed old sessions are terminated only after the
    /// event for the committed revision has been emitted.
    ///
    /// # Errors
    /// Returns a domain, terminal, storage, command-target, or mutation-contract failure.
    pub async fn mutate<F>(
        &self,
        options: LaunchOptions,
        mutation: F,
    ) -> Result<CommitResult, OperationFailure>
    where
        F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let store = Arc::clone(&self.store);
        let terminals = Arc::clone(&self.terminals);
        let authoritative = Arc::clone(&self.authoritative);
        let events = self.events.clone();
        spawn_lifecycle_worker(async move {
            let result =
                mutate_inner(store, terminals, authoritative, events, options, mutation).await;
            let _ = reply_tx.send(result);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))?
    }

    /// Apply a pure non-lifecycle mutation and atomically retain its exact idempotency result.
    ///
    /// # Errors
    /// Returns a domain, storage, stale-revision, idempotency, mutation-contract, or worker failure.
    pub async fn mutate_idempotent<F>(
        &self,
        expected_state_revision: u64,
        request: IdempotencySaveRequest,
        mutation: F,
    ) -> Result<IdempotentCommitResult, OperationFailure>
    where
        F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let store = Arc::clone(&self.store);
        let authoritative = Arc::clone(&self.authoritative).lock_owned().await;
        let events = self.events.clone();
        spawn_lifecycle_worker(async move {
            let result = mutate_idempotent_inner(
                store,
                authoritative,
                events,
                expected_state_revision,
                request,
                mutation,
            )
            .await;
            let _ = reply_tx.send(result);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))?
    }

    /// Apply a saved-layout domain mutation with lifecycle effects and durable idempotency.
    ///
    /// Core layout planning is the preflight boundary: it runs while the authoritative mutation
    /// lock is held and finishes all layout, authorized-root, and domain validation before any
    /// effect. Only then are replacement terminals started. Existing terminal and browser
    /// ownership remains attached when the saved template preserves the same durable tab identity
    /// and terminal launch specification. The checked candidate and exact idempotency result are
    /// saved atomically, published once, and removed terminal sessions are terminated afterward.
    /// This reconstructs declared layout and process launches; it never clones process memory.
    ///
    /// `options` is ephemeral and is never persisted. It may name only terminal tabs that the
    /// preflight proves require a replacement launch.
    ///
    /// # Errors
    /// Returns a preflight, terminal, storage, command-target, mutation-contract, shutdown, or
    /// worker failure. Launch and save failures tear down only terminals created by this attempt.
    pub async fn apply_saved_layout_idempotent(
        &self,
        expected_state_revision: u64,
        request: IdempotencySaveRequest,
        layout_id: LayoutId,
        authorized_workspace_roots: Vec<PathBuf>,
        options: LaunchOptions,
    ) -> Result<IdempotentCommitResult, OperationFailure> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let store = Arc::clone(&self.store);
        let terminals = Arc::clone(&self.terminals);
        let authoritative = Arc::clone(&self.authoritative).lock_owned().await;
        let events = self.events.clone();
        spawn_lifecycle_worker(async move {
            let result = mutate_lifecycle_idempotent_inner(
                store,
                terminals,
                authoritative,
                events,
                expected_state_revision,
                request,
                options,
                move |state| {
                    let verified_paths =
                        verify_saved_layout_paths(state, layout_id, &authorized_workspace_roots)?;
                    let mut plan = state
                        .plan_saved_layout_application(layout_id, &authorized_workspace_roots)?;
                    apply_verified_layout_paths(&mut plan, &verified_paths);
                    state.apply_layout_plan(plan)
                },
            )
            .await;
            let _ = reply_tx.send(result);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))?
    }

    /// Apply a lifecycle-capable core mutation with an atomically durable idempotency result.
    ///
    /// The closure is executed under the serialized mutation lock and must complete all pure
    /// preflight validation before returning its lifecycle delta. Required replacement terminals
    /// are started and bound before the checked snapshot/idempotency transaction; removed sessions
    /// are terminated only after authoritative publication. Failed launch/save attempts clean up
    /// only sessions created by that attempt.
    ///
    /// # Errors
    /// Returns a domain, terminal, storage, command-target, contract, shutdown, or worker failure.
    pub async fn mutate_lifecycle_idempotent<F>(
        &self,
        expected_state_revision: u64,
        request: IdempotencySaveRequest,
        options: LaunchOptions,
        mutation: F,
    ) -> Result<IdempotentCommitResult, OperationFailure>
    where
        F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let store = Arc::clone(&self.store);
        let terminals = Arc::clone(&self.terminals);
        let authoritative = Arc::clone(&self.authoritative).lock_owned().await;
        let events = self.events.clone();
        spawn_lifecycle_worker(async move {
            let result = mutate_lifecycle_idempotent_inner(
                store,
                terminals,
                authoritative,
                events,
                expected_state_revision,
                request,
                options,
                mutation,
            )
            .await;
            let _ = reply_tx.send(result);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))?
    }

    /// Apply one epoch-scoped multi-window mutation under exact application/window revisions.
    ///
    /// The revision preconditions are checked under the same serialized lifecycle lock as pure
    /// preflight, PTY creation/binding, durable state/idempotency commit, publication, and old PTY
    /// termination. Moving a live terminal therefore produces neither a launch nor termination;
    /// duplicate/reopen create one fresh runtime and close terminates only after commit.
    ///
    /// # Errors
    /// Returns a stable pre-commit failure without publishing partial ownership.
    pub async fn mutate_multi_window_idempotent<F, R>(
        &self,
        expected_state_revision: u64,
        expected_window_revisions: Vec<(WindowId, u64)>,
        ticket: EpochMutationTicket,
        options: LaunchOptions,
        mutation: F,
        result: R,
    ) -> Result<EpochIdempotentCommitResult, OperationFailure>
    where
        F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
        R: FnOnce(&ApplicationState) -> Result<String, StoreError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let store = Arc::clone(&self.store);
        let terminals = Arc::clone(&self.terminals);
        let authoritative = Arc::clone(&self.authoritative).lock_owned().await;
        let events = self.events.clone();
        spawn_lifecycle_worker(async move {
            let result = mutate_multi_window_inner(
                store,
                terminals,
                authoritative,
                events,
                expected_state_revision,
                expected_window_revisions,
                ticket,
                options,
                mutation,
                result,
            )
            .await;
            let _ = reply_tx.send(result);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))?
    }

    /// Replace a terminal's PTY, durably commit the core replacement, then terminate the old PTY.
    ///
    /// `command` is ephemeral and is passed only to the terminal backend.
    ///
    /// # Errors
    /// Returns a lookup, domain, terminal, or storage error before commit.
    pub async fn restart_terminal(
        &self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        command: Option<Vec<String>>,
        updated_at: Timestamp,
    ) -> Result<CommitResult, OperationFailure> {
        self.restart_terminal_verified(workspace_id, tab_id, command, None, updated_at)
            .await
    }

    /// Replaces a terminal while revalidating an ephemeral executable identity at spawn.
    ///
    /// # Errors
    /// Returns a lookup, identity, domain, terminal, or storage error before commit.
    pub async fn restart_terminal_verified(
        &self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        command: Option<Vec<String>>,
        executable_identity: Option<agent_workspace_terminal_runtime::ExecutableIdentity>,
        updated_at: Timestamp,
    ) -> Result<CommitResult, OperationFailure> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let store = Arc::clone(&self.store);
        let terminals = Arc::clone(&self.terminals);
        let authoritative = Arc::clone(&self.authoritative);
        let events = self.events.clone();
        spawn_lifecycle_worker(async move {
            let result = restart_inner(
                store,
                terminals,
                authoritative,
                events,
                workspace_id,
                tab_id,
                command,
                executable_identity,
                updated_at,
            )
            .await;
            let _ = reply_tx.send(result);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))?
    }

    /// Clears an exact runtime binding durably, publishes it, then terminates that PTY.
    ///
    /// # Errors
    /// Returns a lookup, stale-identity, storage, worker, or terminal failure.
    pub async fn detach_terminal(
        &self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        expected_session_id: RuntimeSessionId,
        updated_at: Timestamp,
    ) -> Result<CommitResult, OperationFailure> {
        let mut authoritative = self.authoritative.lock().await;
        if authoritative.shutting_down {
            return Err(OperationFailure::plain(RuntimeError::ShuttingDown));
        }
        let mut candidate = authoritative.state.clone();
        let outcome = candidate
            .detach_terminal_runtime_session(workspace_id, tab_id, &expected_session_id, updated_at)
            .map_err(RuntimeError::from)
            .map_err(OperationFailure::plain)?;
        save_store(Arc::clone(&self.store), candidate.clone())
            .await
            .map_err(RuntimeError::from)
            .map_err(OperationFailure::plain)?;
        authoritative.state = candidate.clone();
        let _ = self.events.send(DomainEvent {
            revision: candidate.revision,
            snapshot: candidate.clone(),
        });
        let termination_failures = terminate_sessions(
            &outcome.terminal_sessions_to_terminate,
            self.terminals.as_ref(),
        )
        .await;
        Ok(CommitResult {
            snapshot: candidate,
            termination_failures,
        })
    }

    /// Terminate every terminal currently owned by the authoritative workspace snapshot.
    ///
    /// This is the process-shutdown lifecycle boundary. It is serialized with mutations so a
    /// concurrent commit cannot create a terminal after the shutdown session set is captured.
    ///
    /// # Errors
    /// Returns a worker failure if the lifecycle operation cannot be scheduled or completed.
    pub async fn shutdown(&self) -> Result<Vec<TerminationFailure>, OperationFailure> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let terminals = Arc::clone(&self.terminals);
        let authoritative = Arc::clone(&self.authoritative);
        spawn_lifecycle_worker(async move {
            let mut authoritative = authoritative.lock().await;
            authoritative.shutting_down = true;
            let sessions = runtime_sessions(&authoritative.state);
            let failures = terminate_sessions(&sessions, terminals.as_ref()).await;
            let _ = reply_tx.send(failures);
        })?;
        reply_rx
            .await
            .map_err(|_| OperationFailure::plain(RuntimeError::Worker))
    }
}

/// Resolves server-authorized roots and every path a saved layout could launch before any PTY
/// effect. Renderer/CLI input never contributes roots. Parent traversal and unresolved paths fail
/// closed; symlinks are followed once here and their canonical target must remain inside a
/// canonical root.
fn verify_saved_layout_paths(
    state: &ApplicationState,
    layout_id: LayoutId,
    authorized_roots: &[PathBuf],
) -> Result<BTreeMap<PathBuf, PathBuf>, DomainError> {
    let canonical_roots = authorized_roots
        .iter()
        .map(|root| canonicalize_authorized_path(root, &[]))
        .collect::<Result<Vec<_>, _>>()?;
    let layout = state
        .saved_layouts
        .iter()
        .find(|layout| layout.id == layout_id)
        .ok_or(DomainError::LayoutNotFound { id: layout_id })?;
    let mut verified = BTreeMap::new();
    for workspace in &layout.template.workspaces {
        verify_one_layout_path(
            &workspace.working_directory,
            &canonical_roots,
            &mut verified,
        )?;
        for tab in workspace.tabs.values() {
            if let agent_workspace_core::LayoutTabContentTemplate::Terminal { launch } =
                &tab.content
            {
                verify_one_layout_path(&launch.cwd, &canonical_roots, &mut verified)?;
            }
        }
    }
    Ok(verified)
}

/// Verifies that a saved layout is safe to expose through a portable export using only
/// server-derived authorized roots.
///
/// # Errors
/// Returns an authorization or missing-layout error for unresolved, traversing, or escaping paths.
pub fn verify_saved_layout_export_paths(
    state: &ApplicationState,
    layout_id: LayoutId,
    authorized_roots: &[PathBuf],
) -> Result<(), DomainError> {
    verify_saved_layout_paths(state, layout_id, authorized_roots).map(drop)
}

fn canonicalize_authorized_path(
    path: &Path,
    canonical_roots: &[PathBuf],
) -> Result<PathBuf, DomainError> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(DomainError::UnauthorizedLayoutPath {
            path: path.to_path_buf(),
        });
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|_| DomainError::UnauthorizedLayoutPath {
            path: path.to_path_buf(),
        })?;
    if !canonical_roots.is_empty()
        && !canonical_roots
            .iter()
            .any(|root| canonical.starts_with(root))
    {
        return Err(DomainError::UnauthorizedLayoutPath {
            path: path.to_path_buf(),
        });
    }
    Ok(canonical)
}

fn verify_one_layout_path(
    path: &Path,
    canonical_roots: &[PathBuf],
    verified: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), DomainError> {
    let canonical = canonicalize_authorized_path(path, canonical_roots)?;
    verified.insert(path.to_path_buf(), canonical);
    Ok(())
}

fn apply_verified_layout_paths(
    plan: &mut agent_workspace_core::LayoutApplyPlan,
    verified: &BTreeMap<PathBuf, PathBuf>,
) {
    for workspace in &mut plan.workspaces {
        if let Some(path) = verified.get(&workspace.working_directory) {
            workspace.working_directory.clone_from(path);
        }
        for tab in workspace.tabs.values_mut() {
            if let TabContent::Terminal { launch, .. } = &mut tab.content
                && let Some(path) = verified.get(&launch.cwd)
            {
                launch.cwd.clone_from(path);
            }
        }
    }
}

struct BootstrappedState {
    state: ApplicationState,
    created: Vec<RuntimeSessionId>,
    events: broadcast::Sender<DomainEvent>,
}

async fn bootstrap_inner<S, B>(
    store: Arc<S>,
    terminals: Arc<B>,
    config: BootstrapConfig,
) -> Result<BootstrappedState, OperationFailure>
where
    S: StateStore,
    B: TerminalBackend,
{
    rotate_store_idempotency_epoch(Arc::clone(&store))
        .await
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    let mut candidate = load_store(Arc::clone(&store))
        .await
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?
        .unwrap_or(config.default_state);
    clear_runtime_sessions(&mut candidate);

    let launches = all_terminal_launches(&candidate);
    let mut created = Vec::with_capacity(launches.len());
    for launch in launches {
        match terminals
            .create(
                lifecycle_authority(),
                spawn_request(
                    &launch.launch,
                    None,
                    None,
                    launch.workspace_id,
                    launch.pane_id,
                    launch.tab_id,
                ),
            )
            .await
        {
            Ok(session_id) => {
                if let Err(error) = bind_runtime_session(
                    &mut candidate,
                    launch.workspace_id,
                    launch.tab_id,
                    session_id.clone(),
                ) {
                    created.push(session_id);
                    return Err(rollback_failure(
                        RuntimeError::Domain(error),
                        &created,
                        terminals.as_ref(),
                    )
                    .await);
                }
                created.push(session_id);
            }
            Err(error) => {
                return Err(rollback_failure(
                    RuntimeError::Terminal(error),
                    &created,
                    terminals.as_ref(),
                )
                .await);
            }
        }
    }

    if let Err(error) = save_store(store, candidate.clone()).await {
        return Err(
            rollback_failure(RuntimeError::Store(error), &created, terminals.as_ref()).await,
        );
    }

    let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
    Ok(BootstrappedState {
        state: candidate,
        created,
        events,
    })
}

async fn rotate_store_idempotency_epoch<S: StateStore>(store: Arc<S>) -> Result<Uuid, StoreError> {
    tokio::task::spawn_blocking(move || store.rotate_idempotency_epoch())
        .await
        .map_err(|_| StoreError::new("idempotency epoch rotation worker failed"))?
}

#[allow(clippy::too_many_lines)]
async fn mutate_inner<S, B, F>(
    store: Arc<S>,
    terminals: Arc<B>,
    authoritative: Arc<Mutex<AuthoritativeState>>,
    events: broadcast::Sender<DomainEvent>,
    options: LaunchOptions,
    mutation: F,
) -> Result<CommitResult, OperationFailure>
where
    S: StateStore,
    B: TerminalBackend,
    F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
{
    let mut authoritative = authoritative.lock().await;
    if authoritative.shutting_down {
        return Err(OperationFailure::plain(RuntimeError::ShuttingDown));
    }
    let before = authoritative.state.clone();
    let mut candidate = before.clone();
    let outcome = mutation(&mut candidate)
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    candidate
        .validate()
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    let expected_outcome = lifecycle_outcome(&before, &candidate);
    let changed = candidate != before;
    let expected_revision = if changed {
        before.revision.saturating_add(1)
    } else {
        before.revision
    };
    if candidate.revision != expected_revision
        || outcome != expected_outcome
        || introduces_unowned_runtime_session(&before, &candidate)
    {
        return Err(OperationFailure::plain(
            RuntimeError::InvalidMutationContract,
        ));
    }

    let launched_tabs = expected_outcome
        .terminal_launches
        .iter()
        .map(|launch| launch.tab_id)
        .collect::<BTreeSet<_>>();
    if let Some(tab_id) = options
        .commands
        .keys()
        .find(|tab_id| !launched_tabs.contains(tab_id))
    {
        return Err(OperationFailure::plain(RuntimeError::UnexpectedCommand {
            tab_id: *tab_id,
        }));
    }
    if !changed {
        return Ok(CommitResult {
            snapshot: before,
            termination_failures: Vec::new(),
        });
    }

    let mut created = Vec::with_capacity(expected_outcome.terminal_launches.len());
    for launch in &expected_outcome.terminal_launches {
        let command = options.commands.get(&launch.tab_id).cloned();
        let session_id = match terminals
            .create(
                lifecycle_authority(),
                spawn_request(
                    &launch.launch,
                    command,
                    None,
                    launch.workspace_id,
                    launch.pane_id,
                    launch.tab_id,
                ),
            )
            .await
        {
            Ok(session_id) => session_id,
            Err(error) => {
                return Err(rollback_failure(
                    RuntimeError::Terminal(error),
                    &created,
                    terminals.as_ref(),
                )
                .await);
            }
        };
        if let Err(error) = bind_runtime_session(
            &mut candidate,
            launch.workspace_id,
            launch.tab_id,
            session_id.clone(),
        ) {
            created.push(session_id);
            return Err(rollback_failure(
                RuntimeError::Domain(error),
                &created,
                terminals.as_ref(),
            )
            .await);
        }
        created.push(session_id);
    }

    if let Err(error) = save_store(store, candidate.clone()).await {
        return Err(
            rollback_failure(RuntimeError::Store(error), &created, terminals.as_ref()).await,
        );
    }

    authoritative.state = candidate.clone();
    let _ = events.send(DomainEvent {
        revision: candidate.revision,
        snapshot: candidate.clone(),
    });
    let termination_failures = terminate_sessions(
        &expected_outcome.terminal_sessions_to_terminate,
        terminals.as_ref(),
    )
    .await;
    Ok(CommitResult {
        snapshot: candidate,
        termination_failures,
    })
}

async fn mutate_idempotent_inner<S, F>(
    store: Arc<S>,
    mut authoritative: tokio::sync::OwnedMutexGuard<AuthoritativeState>,
    events: broadcast::Sender<DomainEvent>,
    expected_state_revision: u64,
    request: IdempotencySaveRequest,
    mutation: F,
) -> Result<IdempotentCommitResult, OperationFailure>
where
    S: StateStore,
    F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
{
    if authoritative.shutting_down {
        return Err(OperationFailure::plain(RuntimeError::ShuttingDown));
    }
    let lookup = load_store_idempotency_result(
        Arc::clone(&store),
        request.namespace.clone(),
        request.idempotency_key.clone(),
        request.request_json.clone(),
    )
    .await
    .map_err(RuntimeError::Store)
    .map_err(OperationFailure::plain)?;
    match lookup {
        StoreIdempotencyLookup::Replay(result) => {
            return Ok(IdempotentCommitResult::Replay(result));
        }
        StoreIdempotencyLookup::Conflict => {
            return Ok(IdempotentCommitResult::Conflict);
        }
        StoreIdempotencyLookup::Missing => {}
    }
    if authoritative.state.revision != expected_state_revision {
        return Err(OperationFailure::plain(RuntimeError::StaleStateRevision {
            expected: expected_state_revision,
            current: authoritative.state.revision,
        }));
    }
    let before = authoritative.state.clone();
    let mut candidate = before.clone();
    let outcome = mutation(&mut candidate)
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    candidate
        .validate()
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    let expected_outcome = lifecycle_outcome(&before, &candidate);
    let changed = candidate != before;
    let expected_revision = if changed {
        before.revision.saturating_add(1)
    } else {
        before.revision
    };
    if candidate.revision != expected_revision
        || outcome != expected_outcome
        || !expected_outcome.terminal_launches.is_empty()
        || !expected_outcome.terminal_sessions_to_terminate.is_empty()
        || introduces_unowned_runtime_session(&before, &candidate)
    {
        return Err(OperationFailure::plain(
            RuntimeError::InvalidMutationContract,
        ));
    }

    let save_outcome = save_store_with_idempotency(store, candidate.clone(), request)
        .await
        .map_err(RuntimeError::Store)
        .map_err(OperationFailure::plain)?;
    match save_outcome {
        StoreIdempotencySaveOutcome::Replay(result) => {
            return Ok(IdempotentCommitResult::Replay(result));
        }
        StoreIdempotencySaveOutcome::Conflict => {
            return Ok(IdempotentCommitResult::Conflict);
        }
        StoreIdempotencySaveOutcome::Committed => {}
    }

    authoritative.state = candidate.clone();
    if changed {
        let _ = events.send(DomainEvent {
            revision: candidate.revision,
            snapshot: candidate.clone(),
        });
    }
    Ok(IdempotentCommitResult::Committed(CommitResult {
        snapshot: candidate,
        termination_failures: Vec::new(),
    }))
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn mutate_lifecycle_idempotent_inner<S, B, F>(
    store: Arc<S>,
    terminals: Arc<B>,
    mut authoritative: tokio::sync::OwnedMutexGuard<AuthoritativeState>,
    events: broadcast::Sender<DomainEvent>,
    expected_state_revision: u64,
    request: IdempotencySaveRequest,
    options: LaunchOptions,
    mutation: F,
) -> Result<IdempotentCommitResult, OperationFailure>
where
    S: StateStore,
    B: TerminalBackend,
    F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
{
    if authoritative.shutting_down {
        return Err(OperationFailure::plain(RuntimeError::ShuttingDown));
    }

    // Resolve retries before checking their now-stale expected revision and, critically, before
    // rerunning preflight or starting any replacement session.
    let lookup = load_store_idempotency_result(
        Arc::clone(&store),
        request.namespace.clone(),
        request.idempotency_key.clone(),
        request.request_json.clone(),
    )
    .await
    .map_err(RuntimeError::Store)
    .map_err(OperationFailure::plain)?;
    match lookup {
        StoreIdempotencyLookup::Replay(result) => {
            return Ok(IdempotentCommitResult::Replay(result));
        }
        StoreIdempotencyLookup::Conflict => {
            return Ok(IdempotentCommitResult::Conflict);
        }
        StoreIdempotencyLookup::Missing => {}
    }

    if authoritative.state.revision != expected_state_revision {
        return Err(OperationFailure::plain(
            RuntimeError::InvalidMutationContract,
        ));
    }

    let before = authoritative.state.clone();
    let mut candidate = before.clone();
    let outcome = mutation(&mut candidate)
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    candidate
        .validate()
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    let expected_outcome = lifecycle_outcome(&before, &candidate);
    let changed = candidate != before;
    let expected_revision = if changed {
        before.revision.saturating_add(1)
    } else {
        before.revision
    };
    if candidate.revision != expected_revision
        || outcome != expected_outcome
        || introduces_unowned_runtime_session(&before, &candidate)
    {
        return Err(OperationFailure::plain(
            RuntimeError::InvalidMutationContract,
        ));
    }

    let launched_tabs = expected_outcome
        .terminal_launches
        .iter()
        .map(|launch| launch.tab_id)
        .collect::<BTreeSet<_>>();
    if let Some(tab_id) = options
        .commands
        .keys()
        .find(|tab_id| !launched_tabs.contains(tab_id))
    {
        return Err(OperationFailure::plain(RuntimeError::UnexpectedCommand {
            tab_id: *tab_id,
        }));
    }

    let mut created = Vec::with_capacity(expected_outcome.terminal_launches.len());
    for launch in &expected_outcome.terminal_launches {
        let command = options.commands.get(&launch.tab_id).cloned();
        let session_id = match terminals
            .create(
                lifecycle_authority(),
                spawn_request(
                    &launch.launch,
                    command,
                    None,
                    launch.workspace_id,
                    launch.pane_id,
                    launch.tab_id,
                ),
            )
            .await
        {
            Ok(session_id) => session_id,
            Err(error) => {
                return Err(rollback_failure(
                    RuntimeError::Terminal(error),
                    &created,
                    terminals.as_ref(),
                )
                .await);
            }
        };
        if let Err(error) = bind_runtime_session(
            &mut candidate,
            launch.workspace_id,
            launch.tab_id,
            session_id.clone(),
        ) {
            created.push(session_id);
            return Err(rollback_failure(
                RuntimeError::Domain(error),
                &created,
                terminals.as_ref(),
            )
            .await);
        }
        created.push(session_id);
    }

    let save_outcome = match save_store_with_idempotency(store, candidate.clone(), request).await {
        Ok(outcome) => outcome,
        Err(error) => {
            return Err(
                rollback_failure(RuntimeError::Store(error), &created, terminals.as_ref()).await,
            );
        }
    };
    match save_outcome {
        StoreIdempotencySaveOutcome::Replay(result) => {
            let failures = terminate_sessions(&created, terminals.as_ref()).await;
            if failures.is_empty() {
                return Ok(IdempotentCommitResult::Replay(result));
            }
            return Err(OperationFailure {
                error: RuntimeError::Store(StoreError::new(
                    "idempotency replay raced with layout lifecycle commit",
                )),
                rollback_termination_failures: failures,
            });
        }
        StoreIdempotencySaveOutcome::Conflict => {
            let failures = terminate_sessions(&created, terminals.as_ref()).await;
            if failures.is_empty() {
                return Ok(IdempotentCommitResult::Conflict);
            }
            return Err(OperationFailure {
                error: RuntimeError::Store(StoreError::new(
                    "idempotency conflict raced with layout lifecycle commit",
                )),
                rollback_termination_failures: failures,
            });
        }
        StoreIdempotencySaveOutcome::Committed => {}
    }

    authoritative.state = candidate.clone();
    if changed {
        let _ = events.send(DomainEvent {
            revision: candidate.revision,
            snapshot: candidate.clone(),
        });
    }
    let termination_failures = terminate_sessions(
        &expected_outcome.terminal_sessions_to_terminate,
        terminals.as_ref(),
    )
    .await;
    Ok(IdempotentCommitResult::Committed(CommitResult {
        snapshot: candidate,
        termination_failures,
    }))
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn mutate_multi_window_inner<S, B, F, R>(
    store: Arc<S>,
    terminals: Arc<B>,
    mut authoritative: tokio::sync::OwnedMutexGuard<AuthoritativeState>,
    events: broadcast::Sender<DomainEvent>,
    expected_state_revision: u64,
    expected_window_revisions: Vec<(WindowId, u64)>,
    ticket: EpochMutationTicket,
    options: LaunchOptions,
    mutation: F,
    result: R,
) -> Result<EpochIdempotentCommitResult, OperationFailure>
where
    S: StateStore,
    B: TerminalBackend,
    F: FnOnce(&mut ApplicationState) -> Result<MutationOutcome, DomainError> + Send + 'static,
    R: FnOnce(&ApplicationState) -> Result<String, StoreError> + Send + 'static,
{
    if authoritative.shutting_down {
        return Err(OperationFailure::plain(RuntimeError::ShuttingDown));
    }
    let lookup = load_store_epoch_idempotency_result(
        Arc::clone(&store),
        ticket.namespace.clone(),
        ticket.epoch,
        ticket.idempotency_key,
        ticket.request_hash.clone(),
    )
    .await
    .map_err(RuntimeError::Store)
    .map_err(OperationFailure::plain)?;
    match lookup {
        StoreEpochIdempotencyLookup::Replay(result) => {
            return Ok(EpochIdempotentCommitResult::Replay(result));
        }
        StoreEpochIdempotencyLookup::Conflict => {
            return Ok(EpochIdempotentCommitResult::Conflict);
        }
        StoreEpochIdempotencyLookup::ResultExpired => {
            return Ok(EpochIdempotentCommitResult::ResultExpired);
        }
        StoreEpochIdempotencyLookup::EpochExpired => {
            return Ok(EpochIdempotentCommitResult::EpochExpired);
        }
        StoreEpochIdempotencyLookup::Missing => {}
    }
    if authoritative.state.revision != expected_state_revision {
        return Err(OperationFailure::plain(RuntimeError::StaleStateRevision {
            expected: expected_state_revision,
            current: authoritative.state.revision,
        }));
    }
    let mut observed = BTreeSet::new();
    for (window_id, expected_revision) in expected_window_revisions {
        if !observed.insert(window_id)
            || authoritative
                .state
                .window_placement(window_id)
                .is_none_or(|window| window.revision != expected_revision)
        {
            return Err(OperationFailure::plain(RuntimeError::StaleWindowRevision {
                window_id,
            }));
        }
    }

    let before = authoritative.state.clone();
    let mut candidate = before.clone();
    let outcome = mutation(&mut candidate)
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    candidate
        .validate()
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;
    let expected_outcome = lifecycle_outcome(&before, &candidate);
    let changed = candidate != before;
    let expected_revision = if changed {
        before.revision.saturating_add(1)
    } else {
        before.revision
    };
    if candidate.revision != expected_revision
        || outcome != expected_outcome
        || introduces_unowned_runtime_session(&before, &candidate)
    {
        return Err(OperationFailure::plain(
            RuntimeError::InvalidMutationContract,
        ));
    }

    let launched_tabs = expected_outcome
        .terminal_launches
        .iter()
        .map(|launch| launch.tab_id)
        .collect::<BTreeSet<_>>();
    if let Some(tab_id) = options
        .commands
        .keys()
        .find(|tab_id| !launched_tabs.contains(tab_id))
    {
        return Err(OperationFailure::plain(RuntimeError::UnexpectedCommand {
            tab_id: *tab_id,
        }));
    }

    let mut created = Vec::with_capacity(expected_outcome.terminal_launches.len());
    for launch in &expected_outcome.terminal_launches {
        let command = options.commands.get(&launch.tab_id).cloned();
        let session_id = match terminals
            .create(
                lifecycle_authority(),
                spawn_request(
                    &launch.launch,
                    command,
                    None,
                    launch.workspace_id,
                    launch.pane_id,
                    launch.tab_id,
                ),
            )
            .await
        {
            Ok(session_id) => session_id,
            Err(error) => {
                return Err(rollback_failure(
                    RuntimeError::Terminal(error),
                    &created,
                    terminals.as_ref(),
                )
                .await);
            }
        };
        if let Err(error) = bind_runtime_session(
            &mut candidate,
            launch.workspace_id,
            launch.tab_id,
            session_id.clone(),
        ) {
            created.push(session_id);
            return Err(rollback_failure(
                RuntimeError::Domain(error),
                &created,
                terminals.as_ref(),
            )
            .await);
        }
        created.push(session_id);
    }

    let result_json = match result(&candidate) {
        Ok(result) => result,
        Err(error) => {
            return Err(
                rollback_failure(RuntimeError::Store(error), &created, terminals.as_ref()).await,
            );
        }
    };
    let request = EpochIdempotencySaveRequest {
        namespace: ticket.namespace,
        epoch: ticket.epoch,
        idempotency_key: ticket.idempotency_key,
        request_hash: ticket.request_hash,
        result_json: result_json.clone(),
        retention_capacity: ticket.retention_capacity,
    };
    let save_outcome = match save_store_with_epoch_idempotency(store, candidate.clone(), request)
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            return Err(
                rollback_failure(RuntimeError::Store(error), &created, terminals.as_ref()).await,
            );
        }
    };
    match save_outcome {
        // The schema-v5 store returns the submitted exact result after its first commit.
        StoreEpochIdempotencyLookup::Replay(stored) if stored == result_json => {}
        StoreEpochIdempotencyLookup::Replay(_) => {
            let failures = terminate_sessions(&created, terminals.as_ref()).await;
            return Err(OperationFailure {
                error: RuntimeError::Store(StoreError::new(
                    "epoch idempotency commit returned a different exact result",
                )),
                rollback_termination_failures: failures,
            });
        }
        StoreEpochIdempotencyLookup::Conflict => {
            let failures = terminate_sessions(&created, terminals.as_ref()).await;
            if failures.is_empty() {
                return Ok(EpochIdempotentCommitResult::Conflict);
            }
            return Err(OperationFailure {
                error: RuntimeError::Store(StoreError::new(
                    "epoch idempotency conflict raced with lifecycle commit",
                )),
                rollback_termination_failures: failures,
            });
        }
        StoreEpochIdempotencyLookup::ResultExpired => {
            let _ = terminate_sessions(&created, terminals.as_ref()).await;
            return Ok(EpochIdempotentCommitResult::ResultExpired);
        }
        StoreEpochIdempotencyLookup::EpochExpired => {
            let _ = terminate_sessions(&created, terminals.as_ref()).await;
            return Ok(EpochIdempotentCommitResult::EpochExpired);
        }
        StoreEpochIdempotencyLookup::Missing => {
            return Err(OperationFailure::plain(RuntimeError::Store(
                StoreError::new("epoch idempotency commit returned no durable result"),
            )));
        }
    }

    authoritative.state = candidate.clone();
    if changed {
        let _ = events.send(DomainEvent {
            revision: candidate.revision,
            snapshot: candidate.clone(),
        });
    }
    let termination_failures = terminate_sessions(
        &expected_outcome.terminal_sessions_to_terminate,
        terminals.as_ref(),
    )
    .await;
    Ok(EpochIdempotentCommitResult::Committed {
        commit: CommitResult {
            snapshot: candidate,
            termination_failures,
        },
        result_json,
    })
}

#[allow(clippy::too_many_arguments)]
async fn restart_inner<S, B>(
    store: Arc<S>,
    terminals: Arc<B>,
    authoritative: Arc<Mutex<AuthoritativeState>>,
    events: broadcast::Sender<DomainEvent>,
    workspace_id: WorkspaceId,
    tab_id: TabId,
    command: Option<Vec<String>>,
    executable_identity: Option<agent_workspace_terminal_runtime::ExecutableIdentity>,
    updated_at: Timestamp,
) -> Result<CommitResult, OperationFailure>
where
    S: StateStore,
    B: TerminalBackend,
{
    let mut authoritative = authoritative.lock().await;
    if authoritative.shutting_down {
        return Err(OperationFailure::plain(RuntimeError::ShuttingDown));
    }
    let (pane_id, launch) = terminal_launch(&authoritative.state, workspace_id, tab_id)
        .map_err(OperationFailure::plain)?;
    let new_session = terminals
        .create(
            lifecycle_authority(),
            spawn_request(
                &launch,
                command,
                executable_identity,
                workspace_id,
                pane_id,
                tab_id,
            ),
        )
        .await
        .map_err(RuntimeError::from)
        .map_err(OperationFailure::plain)?;

    let mut candidate = authoritative.state.clone();
    let outcome = match candidate.replace_terminal_runtime_session(
        workspace_id,
        tab_id,
        new_session.clone(),
        updated_at,
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            return Err(rollback_failure(
                RuntimeError::Domain(error),
                &[new_session],
                terminals.as_ref(),
            )
            .await);
        }
    };
    if let Err(error) = save_store(store, candidate.clone()).await {
        return Err(rollback_failure(
            RuntimeError::Store(error),
            &[new_session],
            terminals.as_ref(),
        )
        .await);
    }

    authoritative.state = candidate.clone();
    let _ = events.send(DomainEvent {
        revision: candidate.revision,
        snapshot: candidate.clone(),
    });
    let termination_failures =
        terminate_sessions(&outcome.terminal_sessions_to_terminate, terminals.as_ref()).await;
    Ok(CommitResult {
        snapshot: candidate,
        termination_failures,
    })
}

async fn load_store<S: StateStore>(store: Arc<S>) -> Result<Option<ApplicationState>, StoreError> {
    tokio::task::spawn_blocking(move || store.load())
        .await
        .map_err(|_| StoreError::new("state storage worker failed"))?
}

async fn save_store<S: StateStore>(
    store: Arc<S>,
    state: ApplicationState,
) -> Result<(), StoreError> {
    tokio::task::spawn_blocking(move || store.save(&state))
        .await
        .map_err(|_| StoreError::new("state storage worker failed"))?
}

async fn save_store_with_idempotency<S: StateStore>(
    store: Arc<S>,
    state: ApplicationState,
    request: IdempotencySaveRequest,
) -> Result<StoreIdempotencySaveOutcome, StoreError> {
    tokio::task::spawn_blocking(move || store.save_with_idempotency(&state, &request))
        .await
        .map_err(|_| StoreError::new("state storage worker failed"))?
}

async fn load_store_idempotency_result<S: StateStore>(
    store: Arc<S>,
    namespace: String,
    idempotency_key: String,
    request_json: String,
) -> Result<StoreIdempotencyLookup, StoreError> {
    tokio::task::spawn_blocking(move || {
        store.load_idempotency_result(&namespace, &idempotency_key, &request_json)
    })
    .await
    .map_err(|_| StoreError::new("state storage worker failed"))?
}

async fn load_store_epoch_idempotency_result<S: StateStore>(
    store: Arc<S>,
    namespace: String,
    epoch: Uuid,
    idempotency_key: Uuid,
    request_hash: String,
) -> Result<StoreEpochIdempotencyLookup, StoreError> {
    tokio::task::spawn_blocking(move || {
        store.load_epoch_idempotency_result(&namespace, epoch, idempotency_key, &request_hash)
    })
    .await
    .map_err(|_| StoreError::new("epoch idempotency storage worker failed"))?
}

async fn save_store_with_epoch_idempotency<S: StateStore>(
    store: Arc<S>,
    state: ApplicationState,
    request: EpochIdempotencySaveRequest,
) -> Result<StoreEpochIdempotencyLookup, StoreError> {
    tokio::task::spawn_blocking(move || store.save_with_epoch_idempotency(&state, &request))
        .await
        .map_err(|_| StoreError::new("epoch idempotency storage worker failed"))?
}

fn lifecycle_outcome(before: &ApplicationState, after: &ApplicationState) -> MutationOutcome {
    let before_tabs = before
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .tabs
                .values()
                .map(move |tab| (tab.id, (workspace.id, tab)))
        })
        .collect::<BTreeMap<_, _>>();
    let after_tabs = after
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .tabs
                .values()
                .map(move |tab| (tab.id, (workspace.id, tab)))
        })
        .collect::<BTreeMap<_, _>>();
    let mut terminal_launches = Vec::new();
    let mut terminal_sessions_to_terminate = Vec::new();

    for workspace in &after.workspaces {
        for tab in workspace.tabs.values() {
            if let TabContent::Terminal { launch, .. } = &tab.content {
                let requires_launch = match before_tabs.get(&tab.id) {
                    Some((_, before_tab)) => match &before_tab.content {
                        TabContent::Terminal {
                            launch: before_launch,
                            ..
                        } => before_launch != launch || tab.content.runtime_session_id().is_none(),
                        TabContent::Browser { .. } => true,
                    },
                    None => true,
                };
                if requires_launch {
                    terminal_launches.push(TerminalLaunchRequest {
                        workspace_id: workspace.id,
                        pane_id: tab.pane_id,
                        tab_id: tab.id,
                        launch: launch.clone(),
                    });
                }
            }
        }
    }

    for workspace in &before.workspaces {
        for tab in workspace.tabs.values() {
            let TabContent::Terminal {
                launch: before_launch,
                ..
            } = &tab.content
            else {
                continue;
            };
            let requires_termination = match after_tabs.get(&tab.id) {
                Some((_, after_tab)) => match &after_tab.content {
                    TabContent::Terminal {
                        launch: after_launch,
                        ..
                    } => {
                        after_launch != before_launch
                            || after_tab.content.runtime_session_id()
                                != tab.content.runtime_session_id()
                    }
                    TabContent::Browser { .. } => true,
                },
                None => true,
            };
            if requires_termination && let Some(session) = tab.content.runtime_session_id() {
                terminal_sessions_to_terminate.push(session.clone());
            }
        }
    }
    MutationOutcome {
        revision: after.revision,
        terminal_launches,
        terminal_sessions_to_terminate,
    }
}

fn introduces_unowned_runtime_session(before: &ApplicationState, after: &ApplicationState) -> bool {
    let before_tabs = before
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .map(|tab| (tab.id, tab))
        .collect::<BTreeMap<_, _>>();
    after
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter(|tab| matches!(tab.content, TabContent::Terminal { .. }))
        .any(|tab| {
            let after_session = tab.content.runtime_session_id();
            match before_tabs.get(&tab.id).map(|tab| &tab.content) {
                Some(TabContent::Terminal { .. }) => {
                    after_session != before_tabs[&tab.id].content.runtime_session_id()
                }
                Some(TabContent::Browser { .. }) | None => after_session.is_some(),
            }
        })
}

fn spawn_lifecycle_worker<F>(future: F) -> Result<(), OperationFailure>
where
    F: Future<Output = ()> + Send + 'static,
{
    static LIFECYCLE_RUNTIME: OnceLock<Result<tokio::runtime::Runtime, ()>> = OnceLock::new();
    let runtime = LIFECYCLE_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("workspace-lifecycle")
            .enable_all()
            .build()
            .map_err(|_| ())
    });
    let runtime = runtime
        .as_ref()
        .map_err(|()| OperationFailure::plain(RuntimeError::Worker))?;
    // This process-lifetime executor is independent of every caller executor. Dropping a caller's
    // runtime therefore cannot discard the continuation between a blocking save and state swap.
    drop(runtime.spawn(future));
    Ok(())
}

impl OperationFailure {
    fn plain(error: RuntimeError) -> Self {
        Self {
            error,
            rollback_termination_failures: Vec::new(),
        }
    }
}

fn spawn_request(
    launch: &TerminalLaunchSpec,
    command: Option<Vec<String>>,
    executable_identity: Option<agent_workspace_terminal_runtime::ExecutableIdentity>,
    workspace_id: WorkspaceId,
    pane_id: PaneId,
    tab_id: TabId,
) -> TerminalSpawnRequest {
    TerminalSpawnRequest {
        rows: launch.rows,
        cols: launch.cols,
        cwd: Some(launch.cwd.clone()),
        command,
        executable_identity,
        environment: vec![
            (
                "AGENT_WORKSPACE_WORKSPACE_ID".to_owned(),
                workspace_id.to_string(),
            ),
            ("AGENT_WORKSPACE_PANE_ID".to_owned(), pane_id.to_string()),
            ("AGENT_WORKSPACE_TAB_ID".to_owned(), tab_id.to_string()),
        ],
    }
}

fn all_terminal_launches(state: &ApplicationState) -> Vec<TerminalLaunchRequest> {
    state
        .workspaces
        .iter()
        .flat_map(|workspace| {
            workspace
                .tabs
                .values()
                .filter_map(|tab| match &tab.content {
                    TabContent::Terminal { launch, .. } => Some(TerminalLaunchRequest {
                        workspace_id: workspace.id,
                        pane_id: tab.pane_id,
                        tab_id: tab.id,
                        launch: launch.clone(),
                    }),
                    TabContent::Browser { .. } => None,
                })
        })
        .collect()
}

fn clear_runtime_sessions(state: &mut ApplicationState) {
    for workspace in &mut state.workspaces {
        for tab in workspace.tabs.values_mut() {
            tab.content.set_runtime_session_id(None);
        }
    }
}

fn runtime_sessions(state: &ApplicationState) -> Vec<RuntimeSessionId> {
    state
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.tabs.values())
        .filter_map(|tab| tab.content.runtime_session_id().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn bind_runtime_session(
    state: &mut ApplicationState,
    workspace_id: WorkspaceId,
    tab_id: TabId,
    session_id: RuntimeSessionId,
) -> Result<(), DomainError> {
    let workspace = state
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or(DomainError::WorkspaceNotFound { id: workspace_id })?;
    let tab = workspace
        .tabs
        .get_mut(&tab_id)
        .ok_or(DomainError::TabNotFound { id: tab_id })?;
    if !matches!(tab.content, TabContent::Terminal { .. }) {
        return Err(DomainError::TabNotTerminal { id: tab_id });
    }
    tab.content.set_runtime_session_id(Some(session_id));
    state.validate()
}

fn terminal_launch(
    state: &ApplicationState,
    workspace_id: WorkspaceId,
    tab_id: TabId,
) -> Result<(PaneId, TerminalLaunchSpec), RuntimeError> {
    let tab = state
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .and_then(|workspace| workspace.tabs.get(&tab_id))
        .ok_or(RuntimeError::TabNotFound {
            workspace_id,
            tab_id,
        })?;
    match &tab.content {
        TabContent::Terminal { launch, .. } => Ok((tab.pane_id, launch.clone())),
        TabContent::Browser { .. } => Err(RuntimeError::TabNotTerminal { tab_id }),
    }
}

async fn rollback_failure<B: TerminalBackend>(
    error: RuntimeError,
    created: &[RuntimeSessionId],
    terminals: &B,
) -> OperationFailure {
    OperationFailure {
        error,
        rollback_termination_failures: terminate_sessions(created, terminals).await,
    }
}

async fn terminate_sessions<B: TerminalBackend>(
    sessions: &[RuntimeSessionId],
    terminals: &B,
) -> Vec<TerminationFailure> {
    let mut failures = Vec::new();
    for session_id in sessions {
        if let Err(error) = terminals.terminate(lifecycle_authority(), session_id).await {
            failures.push(TerminationFailure {
                session_id: session_id.clone(),
                error,
            });
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Condvar, Mutex as StdMutex};

    use agent_workspace_core::{
        LayoutTemplate, Notification, NotificationId, NotificationLevel, NotificationSource,
        PaneId, SavedLayout, ShortcutPlatform, TabId, TerminalLaunchSpec, Timestamp, WorkspaceId,
    };
    use tokio::{
        sync::Notify,
        time::{Duration, Instant, sleep, timeout},
    };
    use uuid::Uuid;

    use super::*;

    #[derive(Clone, Default)]
    struct FakeStore {
        inner: Arc<StdMutex<FakeStoreState>>,
        shared_audit: Arc<StdMutex<Vec<String>>>,
        blocking_save: Arc<(StdMutex<BlockingSaveState>, Condvar)>,
        save_started: Arc<Notify>,
    }

    #[derive(Default)]
    struct BlockingSaveState {
        block_next: bool,
        released: bool,
    }

    #[derive(Default)]
    struct FakeStoreState {
        durable: Option<ApplicationState>,
        fail_next_save: bool,
        saves: Vec<String>,
        audit: Vec<String>,
        idempotency: BTreeMap<(String, String), (String, String)>,
        epoch_idempotency: BTreeMap<(String, Uuid, Uuid), (String, String)>,
    }

    impl FakeStore {
        fn with_state(state: ApplicationState) -> Self {
            Self {
                inner: Arc::new(StdMutex::new(FakeStoreState {
                    durable: Some(state),
                    ..FakeStoreState::default()
                })),
                shared_audit: Arc::default(),
                blocking_save: Arc::default(),
                save_started: Arc::default(),
            }
        }

        fn fail_next_save(&self) {
            self.inner.lock().unwrap().fail_next_save = true;
        }

        fn clear_observations(&self) {
            let mut inner = self.inner.lock().unwrap();
            inner.saves.clear();
            inner.audit.clear();
        }

        fn block_next_save(&self) {
            let (state, _) = self.blocking_save.as_ref();
            let mut state = state.lock().unwrap();
            state.block_next = true;
            state.released = false;
        }

        fn release_save(&self) {
            let (state, wake) = self.blocking_save.as_ref();
            state.lock().unwrap().released = true;
            wake.notify_all();
        }
    }

    impl StateStore for FakeStore {
        fn load(&self) -> Result<Option<ApplicationState>, StoreError> {
            Ok(self.inner.lock().unwrap().durable.clone())
        }

        fn save(&self, state: &ApplicationState) -> Result<(), StoreError> {
            let (blocking, wake) = self.blocking_save.as_ref();
            let mut blocking = blocking.lock().unwrap();
            if blocking.block_next {
                blocking.block_next = false;
                self.save_started.notify_one();
                while !blocking.released {
                    blocking = wake.wait(blocking).unwrap();
                }
                blocking.released = false;
            }
            drop(blocking);
            let mut inner = self.inner.lock().unwrap();
            if inner.fail_next_save {
                inner.fail_next_save = false;
                inner.audit.push("save-failed".into());
                self.shared_audit.lock().unwrap().push("save-failed".into());
                return Err(StoreError::new("injected save failure"));
            }
            inner.audit.push(format!("save:{}", state.revision));
            self.shared_audit
                .lock()
                .unwrap()
                .push(format!("save:{}", state.revision));
            inner
                .saves
                .push(serde_json::to_string(state).expect("state serializes"));
            inner.durable = Some(state.clone());
            Ok(())
        }

        fn save_with_idempotency(
            &self,
            state: &ApplicationState,
            request: &IdempotencySaveRequest,
        ) -> Result<StoreIdempotencySaveOutcome, StoreError> {
            let key = (request.namespace.clone(), request.idempotency_key.clone());
            if let Some((stored_request, result)) =
                self.inner.lock().unwrap().idempotency.get(&key).cloned()
            {
                return Ok(if stored_request == request.request_json {
                    StoreIdempotencySaveOutcome::Replay(result)
                } else {
                    StoreIdempotencySaveOutcome::Conflict
                });
            }
            self.save(state)?;
            self.inner.lock().unwrap().idempotency.insert(
                key,
                (request.request_json.clone(), request.result_json.clone()),
            );
            Ok(StoreIdempotencySaveOutcome::Committed)
        }

        fn load_idempotency_result(
            &self,
            namespace: &str,
            idempotency_key: &str,
            request_json: &str,
        ) -> Result<StoreIdempotencyLookup, StoreError> {
            Ok(
                match self
                    .inner
                    .lock()
                    .unwrap()
                    .idempotency
                    .get(&(namespace.to_owned(), idempotency_key.to_owned()))
                    .cloned()
                {
                    None => StoreIdempotencyLookup::Missing,
                    Some((stored_request, result)) if stored_request == request_json => {
                        StoreIdempotencyLookup::Replay(result)
                    }
                    Some(_) => StoreIdempotencyLookup::Conflict,
                },
            )
        }

        fn current_idempotency_epoch(&self) -> Result<Uuid, StoreError> {
            Ok(Uuid::nil())
        }

        fn load_epoch_idempotency_result(
            &self,
            namespace: &str,
            epoch: Uuid,
            idempotency_key: Uuid,
            request_hash: &str,
        ) -> Result<StoreEpochIdempotencyLookup, StoreError> {
            if epoch != Uuid::nil() {
                return Ok(StoreEpochIdempotencyLookup::EpochExpired);
            }
            Ok(
                match self.inner.lock().unwrap().epoch_idempotency.get(&(
                    namespace.to_owned(),
                    epoch,
                    idempotency_key,
                )) {
                    None => StoreEpochIdempotencyLookup::Missing,
                    Some((stored_hash, _)) if stored_hash != request_hash => {
                        StoreEpochIdempotencyLookup::Conflict
                    }
                    Some((_, result)) => StoreEpochIdempotencyLookup::Replay(result.clone()),
                },
            )
        }

        fn save_with_epoch_idempotency(
            &self,
            state: &ApplicationState,
            request: &EpochIdempotencySaveRequest,
        ) -> Result<StoreEpochIdempotencyLookup, StoreError> {
            let key = (
                request.namespace.clone(),
                request.epoch,
                request.idempotency_key,
            );
            if let Some((stored_hash, result)) = self
                .inner
                .lock()
                .unwrap()
                .epoch_idempotency
                .get(&key)
                .cloned()
            {
                return Ok(if stored_hash == request.request_hash {
                    StoreEpochIdempotencyLookup::Replay(result)
                } else {
                    StoreEpochIdempotencyLookup::Conflict
                });
            }
            self.save(state)?;
            self.inner.lock().unwrap().epoch_idempotency.insert(
                key,
                (request.request_hash.clone(), request.result_json.clone()),
            );
            Ok(StoreEpochIdempotencyLookup::Replay(
                request.result_json.clone(),
            ))
        }
    }

    #[derive(Clone, Default)]
    struct FakeTerminal {
        inner: Arc<StdMutex<FakeTerminalState>>,
        shared_audit: Arc<StdMutex<Vec<String>>>,
        blocked_create: Arc<StdMutex<Option<u64>>>,
        create_started: Arc<Notify>,
        release_create: Arc<Notify>,
        blocked_termination: Arc<StdMutex<Option<RuntimeSessionId>>>,
        termination_started: Arc<Notify>,
        release_termination: Arc<Notify>,
    }

    #[derive(Default)]
    struct FakeTerminalState {
        next_id: u64,
        requests: Vec<TerminalSpawnRequest>,
        live: BTreeSet<RuntimeSessionId>,
        terminated: Vec<RuntimeSessionId>,
        fail_create_number: Option<u64>,
        fail_terminate: BTreeSet<RuntimeSessionId>,
        audit: Vec<String>,
    }

    impl FakeTerminal {
        fn clear_observations(&self) {
            let mut inner = self.inner.lock().unwrap();
            inner.requests.clear();
            inner.terminated.clear();
            inner.audit.clear();
        }

        fn fail_termination(&self, session_id: RuntimeSessionId) {
            self.inner.lock().unwrap().fail_terminate.insert(session_id);
        }

        fn block_create(&self, number: u64) {
            *self.blocked_create.lock().unwrap() = Some(number);
        }

        fn block_termination(&self, session_id: RuntimeSessionId) {
            *self.blocked_termination.lock().unwrap() = Some(session_id);
        }

        fn live_sessions(&self) -> BTreeSet<RuntimeSessionId> {
            self.inner.lock().unwrap().live.clone()
        }
    }

    impl TerminalBackend for FakeTerminal {
        fn create(
            &self,
            _authority: &LifecycleAuthority,
            request: TerminalSpawnRequest,
        ) -> Pin<Box<dyn Future<Output = Result<RuntimeSessionId, TerminalBackendError>> + Send + '_>>
        {
            Box::pin(async move {
                let (number, fail) = {
                    let mut inner = self.inner.lock().unwrap();
                    inner.next_id += 1;
                    let number = inner.next_id;
                    inner.requests.push(request);
                    inner.audit.push(format!("create:s{number}"));
                    self.shared_audit
                        .lock()
                        .unwrap()
                        .push(format!("create:s{number}"));
                    (number, inner.fail_create_number == Some(number))
                };
                if *self.blocked_create.lock().unwrap() == Some(number) {
                    self.create_started.notify_one();
                    self.release_create.notified().await;
                }
                if fail {
                    return Err(TerminalBackendError::new("injected create failure"));
                }
                let session_id = RuntimeSessionId::new(format!("s{number}"));
                self.inner.lock().unwrap().live.insert(session_id.clone());
                Ok(session_id)
            })
        }

        fn terminate(
            &self,
            _authority: &LifecycleAuthority,
            session_id: &RuntimeSessionId,
        ) -> Pin<Box<dyn Future<Output = Result<(), TerminalBackendError>> + Send + '_>> {
            let session_id = session_id.clone();
            Box::pin(async move {
                let fail = {
                    let mut inner = self.inner.lock().unwrap();
                    inner.audit.push(format!("terminate:{session_id}"));
                    self.shared_audit
                        .lock()
                        .unwrap()
                        .push(format!("terminate:{session_id}"));
                    inner.terminated.push(session_id.clone());
                    inner.fail_terminate.contains(&session_id)
                };
                if self.blocked_termination.lock().unwrap().as_ref() == Some(&session_id) {
                    self.termination_started.notify_one();
                    self.release_termination.notified().await;
                }
                if fail {
                    return Err(TerminalBackendError::new("injected terminate failure"));
                }
                self.inner.lock().unwrap().live.remove(&session_id);
                Ok(())
            })
        }
    }

    fn workspace_id(value: u128) -> WorkspaceId {
        WorkspaceId::from_uuid(Uuid::from_u128(value))
    }

    fn pane_id(value: u128) -> PaneId {
        PaneId::from_uuid(Uuid::from_u128(value))
    }

    fn tab_id(value: u128) -> TabId {
        TabId::from_uuid(Uuid::from_u128(value))
    }

    fn layout_id(value: u128) -> LayoutId {
        LayoutId::from_uuid(Uuid::from_u128(value))
    }

    fn idempotency_request(key: &str, request_json: &str) -> IdempotencySaveRequest {
        IdempotencySaveRequest {
            namespace: "saved-layouts-v1".to_owned(),
            idempotency_key: key.to_owned(),
            request_json: request_json.to_owned(),
            result_json: format!("result:{key}"),
            retention_capacity: 8,
        }
    }

    fn expected_environment(
        workspace_id: WorkspaceId,
        pane_id: PaneId,
        tab_id: TabId,
    ) -> Vec<(String, String)> {
        vec![
            (
                "AGENT_WORKSPACE_WORKSPACE_ID".to_owned(),
                workspace_id.to_string(),
            ),
            ("AGENT_WORKSPACE_PANE_ID".to_owned(), pane_id.to_string()),
            ("AGENT_WORKSPACE_TAB_ID".to_owned(), tab_id.to_string()),
        ]
    }

    fn launch() -> TerminalLaunchSpec {
        TerminalLaunchSpec::new(PathBuf::from("/tmp"), None, 24, 80).unwrap()
    }

    fn tab(value: u128, pane_id: PaneId, session: Option<&str>) -> Tab {
        Tab::terminal(
            tab_id(value),
            pane_id,
            format!("tab-{value}"),
            launch(),
            session.map(RuntimeSessionId::new),
            Timestamp(1),
        )
        .unwrap()
    }

    fn browser_tab(value: u128, pane_id: PaneId) -> Tab {
        Tab::browser(
            tab_id(value),
            pane_id,
            format!("browser-{value}"),
            serde_json::from_value(serde_json::json!({
                "url": "https://example.com"
            }))
            .unwrap(),
            Timestamp(1),
        )
        .unwrap()
    }

    fn state() -> ApplicationState {
        let pane_id = pane_id(10);
        let workspace = Workspace::new(
            workspace_id(1),
            "workspace",
            PathBuf::from("/tmp"),
            pane_id,
            tab(100, pane_id, Some("stale-session")),
            Timestamp(1),
            Timestamp(1),
        )
        .unwrap();
        ApplicationState::new(workspace).unwrap()
    }

    fn state_with_layout(layout_workspaces: Vec<Workspace>) -> ApplicationState {
        let mut value = state();
        value.saved_layouts.push(
            SavedLayout::new(
                layout_id(500),
                "test-layout",
                LayoutTemplate::new(layout_workspaces).unwrap(),
                Timestamp(1),
                Timestamp(1),
            )
            .unwrap(),
        );
        value.validate().unwrap();
        value
    }

    fn terminal_layout_workspace(tab_values: &[u128], cwd: &str) -> Workspace {
        let pane = pane_id(10);
        let mut application = ApplicationState::new(
            Workspace::new(
                workspace_id(1),
                "workspace",
                PathBuf::from(cwd),
                pane,
                tab(tab_values[0], pane, None),
                Timestamp(1),
                Timestamp(1),
            )
            .unwrap(),
        )
        .unwrap();
        for (index, value) in tab_values.iter().copied().enumerate().skip(1) {
            application
                .open_terminal_tab(
                    workspace_id(1),
                    pane,
                    index,
                    tab(value, pane, None),
                    Timestamp(index as u64 + 1),
                )
                .unwrap();
        }
        application.workspaces.remove(0)
    }

    fn two_terminal_state() -> ApplicationState {
        let mut value = state();
        value
            .open_terminal_tab(
                workspace_id(1),
                pane_id(10),
                1,
                tab(200, pane_id(10), None),
                Timestamp(2),
            )
            .unwrap();
        value
    }

    async fn runtime(
        store: &FakeStore,
        terminals: &FakeTerminal,
    ) -> WorkspaceRuntime<FakeStore, FakeTerminal> {
        WorkspaceRuntime::bootstrap(
            Arc::new(store.clone()),
            Arc::new(terminals.clone()),
            BootstrapConfig::from_state(state()).unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn bootstrap_restores_terminals_with_new_runtime_ids_and_persists_default() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;

        let snapshot = runtime.snapshot().await;
        let session = snapshot.workspaces[0].tabs[&tab_id(100)]
            .content
            .runtime_session_id()
            .unwrap();
        assert_eq!(session.as_str(), "s1");
        assert_eq!(snapshot.revision, 0);
        assert_eq!(
            terminals.inner.lock().unwrap().requests[0].environment,
            expected_environment(workspace_id(1), pane_id(10), tab_id(100))
        );
        let inner = store.inner.lock().unwrap();
        assert_eq!(inner.saves.len(), 1);
        assert!(!inner.saves[0].contains("stale-session"));
        assert!(!inner.saves[0].contains("s1"));
    }

    #[tokio::test]
    async fn production_bootstrap_rotates_epoch_and_expires_results_with_old_runtime_ids() {
        let directory = tempfile::tempdir().expect("temporary directory creates");
        let store = Arc::new(
            SqliteStateStore::open(
                directory.path().join("workspace.db"),
                ShortcutPlatform::NonMacOs,
            )
            .expect("SQLite store opens"),
        );
        let first = WorkspaceRuntime::bootstrap(
            Arc::clone(&store),
            Arc::new(FakeTerminal::default()),
            BootstrapConfig::from_state(state()).expect("bootstrap config is valid"),
        )
        .await
        .expect("first bootstrap succeeds");
        let first_epoch = first
            .current_idempotency_epoch()
            .await
            .expect("epoch reads");
        let first_snapshot = first.snapshot().await;
        let old_runtime_id = first_snapshot.workspaces[0].tabs[&tab_id(100)]
            .content
            .runtime_session_id()
            .expect("terminal is live")
            .to_string();
        let key = Uuid::new_v4();
        let request_hash = "a".repeat(64);
        StateStore::save_with_epoch_idempotency(
            store.as_ref(),
            &first_snapshot,
            &EpochIdempotencySaveRequest {
                namespace: "multi-window.tab.duplicate".to_owned(),
                epoch: first_epoch,
                idempotency_key: key,
                request_hash: request_hash.clone(),
                result_json: serde_json::json!({ "runtimeSessionId": old_runtime_id }).to_string(),
                retention_capacity: 64,
            },
        )
        .expect("old lifecycle result persists");
        drop(first);

        let second = WorkspaceRuntime::bootstrap(
            Arc::clone(&store),
            Arc::new(FakeTerminal::default()),
            BootstrapConfig::from_state(state()).expect("bootstrap config is valid"),
        )
        .await
        .expect("restart bootstrap succeeds");
        let second_epoch = second
            .current_idempotency_epoch()
            .await
            .expect("rotated epoch reads");
        assert_ne!(first_epoch, second_epoch);
        assert_eq!(
            StateStore::load_epoch_idempotency_result(
                store.as_ref(),
                "multi-window.tab.duplicate",
                first_epoch,
                key,
                &request_hash,
            )
            .expect("old epoch lookup succeeds"),
            StoreEpochIdempotencyLookup::EpochExpired
        );
    }

    #[tokio::test]
    async fn epoch_duplicate_replay_returns_exact_post_bind_runtime_and_placement() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        let before = runtime.snapshot().await;
        let window = before.window_placements[0].clone();
        let key = Uuid::new_v4();
        let ticket = epoch_idempotency_ticket(
            "multi-window.tab.duplicate",
            Uuid::nil(),
            key,
            r#"{"operation":"duplicate"}"#,
            64,
        );
        let result = runtime
            .mutate_multi_window_idempotent(
                before.revision,
                vec![(window.id, window.revision)],
                ticket.clone(),
                LaunchOptions::default(),
                |state| {
                    state.duplicate_tab(
                        workspace_id(1),
                        tab_id(100),
                        workspace_id(1),
                        pane_id(10),
                        1,
                        tab_id(201),
                        Timestamp(2),
                        Timestamp(2),
                    )
                },
                |state| {
                    let tab = &state.workspaces[0].tabs[&tab_id(201)];
                    serde_json::to_string(&serde_json::json!({
                        "runtimeSessionId": tab.content.runtime_session_id().map(ToString::to_string),
                        "windowRevision": state.window_placements[0].revision,
                    }))
                    .map_err(|error| StoreError::new(error.to_string()))
                },
            )
            .await
            .unwrap();
        let EpochIdempotentCommitResult::Committed { result_json, .. } = result else {
            panic!("first duplicate must commit")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&result_json).unwrap()["runtimeSessionId"],
            "s2"
        );

        let replay = runtime
            .mutate_multi_window_idempotent(
                before.revision,
                vec![(window.id, window.revision)],
                ticket,
                LaunchOptions::default(),
                |_| panic!("replay must not rerun the domain mutation"),
                |_| panic!("replay must not rebuild the exact result"),
            )
            .await
            .unwrap();
        assert_eq!(replay, EpochIdempotentCommitResult::Replay(result_json));
        assert_eq!(terminals.inner.lock().unwrap().requests.len(), 2);
    }

    #[tokio::test]
    async fn shutdown_terminates_exactly_authoritative_sessions_and_reports_failures() {
        let store = FakeStore::with_state(two_terminal_state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        terminals.clear_observations();
        terminals.fail_termination(RuntimeSessionId::new("s2"));

        let failures = runtime.shutdown().await.unwrap();

        assert_eq!(
            terminals.inner.lock().unwrap().terminated,
            [RuntimeSessionId::new("s1"), RuntimeSessionId::new("s2")]
        );
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].session_id.as_str(), "s2");
        assert_eq!(
            terminals.live_sessions(),
            BTreeSet::from([RuntimeSessionId::new("s2")])
        );
        let failure = runtime
            .restart_terminal(workspace_id(1), tab_id(100), None, Timestamp(2))
            .await
            .unwrap_err();
        assert!(matches!(failure.error, RuntimeError::ShuttingDown));
        assert!(terminals.inner.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn detach_commits_clear_before_exact_termination_and_reports_failure() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        terminals.clear_observations();
        terminals.fail_termination(RuntimeSessionId::new("s1"));

        let result = runtime
            .detach_terminal(
                workspace_id(1),
                tab_id(100),
                RuntimeSessionId::new("s1"),
                Timestamp(2),
            )
            .await
            .unwrap();

        assert!(
            result.snapshot.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id()
                .is_none()
        );
        assert_eq!(result.termination_failures.len(), 1);
        assert_eq!(
            terminals.inner.lock().unwrap().terminated,
            [RuntimeSessionId::new("s1")]
        );
    }

    #[tokio::test]
    async fn detach_save_failure_preserves_binding_and_does_not_terminate() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        terminals.clear_observations();
        store.fail_next_save();

        runtime
            .detach_terminal(
                workspace_id(1),
                tab_id(100),
                RuntimeSessionId::new("s1"),
                Timestamp(2),
            )
            .await
            .unwrap_err();

        assert_eq!(
            runtime.snapshot().await.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s1"
        );
        assert!(terminals.inner.lock().unwrap().terminated.is_empty());
    }

    #[tokio::test]
    async fn save_failure_rolls_back_new_pty_and_preserves_authoritative_state() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        store.fail_next_save();
        let before = runtime.snapshot().await;
        let new_tab = tab(200, pane_id(10), None);
        let secret = "secret-token-never-persist".to_owned();

        let failure = runtime
            .mutate(
                LaunchOptions::default()
                    .with_command(tab_id(200), vec!["shell".into(), secret.clone()]),
                move |candidate| {
                    candidate.open_terminal_tab(
                        workspace_id(1),
                        pane_id(10),
                        1,
                        new_tab,
                        Timestamp(2),
                    )
                },
            )
            .await
            .unwrap_err();

        assert!(matches!(failure.error, RuntimeError::Store(_)));
        assert_eq!(runtime.snapshot().await, before);
        let terminal = terminals.inner.lock().unwrap();
        assert_eq!(terminal.requests[0].command.as_ref().unwrap()[1], secret);
        assert_eq!(
            terminal.requests[0].environment,
            expected_environment(workspace_id(1), pane_id(10), tab_id(200))
        );
        assert!(
            terminal.requests[0]
                .environment
                .iter()
                .all(|(key, value)| !key.contains(&secret) && !value.contains(&secret))
        );
        assert_eq!(terminal.terminated[0].as_str(), "s2");
        let stored = store.inner.lock().unwrap();
        assert!(
            stored
                .saves
                .iter()
                .all(|payload| !payload.contains(&secret))
        );
    }

    #[tokio::test]
    async fn invalid_layout_preflight_has_no_store_session_or_event_effects() {
        let invalid_path_layout = terminal_layout_workspace(&[200], "/unauthorized");
        let store = FakeStore::with_state(state_with_layout(vec![invalid_path_layout]));
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        let before = runtime.snapshot().await;
        let mut events = runtime.subscribe();

        let failure = runtime
            .apply_saved_layout_idempotent(
                before.revision,
                idempotency_request("invalid", "invalid-request"),
                layout_id(500),
                vec![PathBuf::from("/tmp")],
                LaunchOptions::default(),
            )
            .await
            .unwrap_err();

        assert!(matches!(failure.error, RuntimeError::Domain(_)));
        assert_eq!(runtime.snapshot().await, before);
        assert!(store.inner.lock().unwrap().saves.is_empty());
        {
            let terminal = terminals.inner.lock().unwrap();
            assert!(terminal.requests.is_empty());
            assert!(terminal.terminated.is_empty());
            assert_eq!(terminal.live, BTreeSet::from([RuntimeSessionId::new("s1")]));
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_escape_layout_fails_before_store_session_or_event_effects() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let escape = root.join("escape");
        symlink(&outside, &escape).unwrap();
        let escaped = terminal_layout_workspace(&[200], escape.to_str().unwrap());
        let store = FakeStore::with_state(state_with_layout(vec![escaped]));
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        let before = runtime.snapshot().await;
        let mut events = runtime.subscribe();

        let failure = runtime
            .apply_saved_layout_idempotent(
                before.revision,
                idempotency_request("symlink-escape", "symlink-escape-request"),
                layout_id(500),
                vec![root],
                LaunchOptions::default(),
            )
            .await
            .unwrap_err();

        assert!(matches!(failure.error, RuntimeError::Domain(_)));
        assert_eq!(runtime.snapshot().await, before);
        assert!(store.inner.lock().unwrap().saves.is_empty());
        {
            let terminal = terminals.inner.lock().unwrap();
            assert!(terminal.requests.is_empty());
            assert!(terminal.terminated.is_empty());
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_layout_path_policy_accepts_in_root_and_rejects_nested_escape_and_traversal() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let child = root.join("child");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();
        assert_eq!(
            canonicalize_authorized_path(&child, std::slice::from_ref(&canonical_root)).unwrap(),
            std::fs::canonicalize(&child).unwrap()
        );

        let first_link = root.join("nested");
        let second_link = outside.join("target");
        std::fs::create_dir_all(&second_link).unwrap();
        symlink(&outside, &first_link).unwrap();
        assert!(
            canonicalize_authorized_path(
                &first_link.join("target"),
                std::slice::from_ref(&canonical_root),
            )
            .is_err()
        );
        assert!(
            canonicalize_authorized_path(
                &root.join("child/../child"),
                std::slice::from_ref(&canonical_root),
            )
            .is_err()
        );
        assert!(
            canonicalize_authorized_path(
                &root.join("missing"),
                std::slice::from_ref(&canonical_root),
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn layout_create_failure_rolls_back_only_attempt_sessions() {
        let store = FakeStore::with_state(state_with_layout(vec![terminal_layout_workspace(
            &[200, 300],
            "/tmp",
        )]));
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        terminals.inner.lock().unwrap().fail_create_number = Some(3);
        let before = runtime.snapshot().await;
        let mut events = runtime.subscribe();

        let failure = runtime
            .apply_saved_layout_idempotent(
                before.revision,
                idempotency_request("create-failure", "create-failure-request"),
                layout_id(500),
                vec![PathBuf::from("/tmp")],
                LaunchOptions::default(),
            )
            .await
            .unwrap_err();

        assert!(matches!(failure.error, RuntimeError::Terminal(_)));
        assert_eq!(runtime.snapshot().await, before);
        assert!(store.inner.lock().unwrap().saves.is_empty());
        {
            let terminal = terminals.inner.lock().unwrap();
            assert_eq!(terminal.requests.len(), 2);
            assert_eq!(terminal.terminated, [RuntimeSessionId::new("s2")]);
            assert_eq!(terminal.live, BTreeSet::from([RuntimeSessionId::new("s1")]));
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn layout_save_failure_rolls_back_replacement_and_preserves_old_session() {
        let store = FakeStore::with_state(state_with_layout(vec![terminal_layout_workspace(
            &[200],
            "/tmp",
        )]));
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        store.fail_next_save();
        let before = runtime.snapshot().await;
        let mut events = runtime.subscribe();

        let failure = runtime
            .apply_saved_layout_idempotent(
                before.revision,
                idempotency_request("save-failure", "save-failure-request"),
                layout_id(500),
                vec![PathBuf::from("/tmp")],
                LaunchOptions::default(),
            )
            .await
            .unwrap_err();

        assert!(matches!(failure.error, RuntimeError::Store(_)));
        assert_eq!(runtime.snapshot().await, before);
        {
            let terminal = terminals.inner.lock().unwrap();
            assert_eq!(terminal.requests.len(), 1);
            assert_eq!(terminal.terminated, [RuntimeSessionId::new("s2")]);
            assert_eq!(terminal.live, BTreeSet::from([RuntimeSessionId::new("s1")]));
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn successful_layout_preserves_eligible_terminal_and_browser_sessions() {
        let mut initial = state();
        initial
            .open_browser_tab(
                workspace_id(1),
                pane_id(10),
                1,
                browser_tab(300, pane_id(10)),
                Timestamp(2),
            )
            .unwrap();
        initial.revision = 0;
        let browser_session = match &initial.workspaces[0].tabs[&tab_id(300)].content {
            TabContent::Browser { metadata } => metadata.browser_session_id(),
            TabContent::Terminal { .. } => unreachable!(),
        };
        let mut target = initial.clone();
        target
            .open_terminal_tab(
                workspace_id(1),
                pane_id(10),
                2,
                tab(200, pane_id(10), None),
                Timestamp(3),
            )
            .unwrap();
        initial.saved_layouts.push(
            SavedLayout::new(
                layout_id(500),
                "preserving-layout",
                LayoutTemplate::new(target.workspaces).unwrap(),
                Timestamp(1),
                Timestamp(1),
            )
            .unwrap(),
        );
        initial.validate().unwrap();
        let store = FakeStore::with_state(initial);
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        let before = runtime.snapshot().await;
        let before_browser_session = match &before.workspaces[0].tabs[&tab_id(300)].content {
            TabContent::Browser { metadata } => metadata.browser_session_id(),
            TabContent::Terminal { .. } => unreachable!(),
        };
        assert_eq!(before_browser_session, browser_session);

        let result = runtime
            .apply_saved_layout_idempotent(
                before.revision,
                idempotency_request("preserve", "preserve-request"),
                layout_id(500),
                vec![PathBuf::from("/tmp")],
                LaunchOptions::default(),
            )
            .await
            .unwrap();

        let IdempotentCommitResult::Committed(commit) = result else {
            panic!("first layout apply must commit");
        };
        assert_eq!(
            commit.snapshot.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s1"
        );
        assert_eq!(
            commit.snapshot.workspaces[0].tabs[&tab_id(200)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s2"
        );
        let committed_browser_session =
            match &commit.snapshot.workspaces[0].tabs[&tab_id(300)].content {
                TabContent::Browser { metadata } => metadata.browser_session_id(),
                TabContent::Terminal { .. } => unreachable!(),
            };
        assert_eq!(committed_browser_session, browser_session);
        let terminal = terminals.inner.lock().unwrap();
        assert_eq!(terminal.requests.len(), 1);
        assert!(terminal.terminated.is_empty());
        assert_eq!(
            terminal.live,
            BTreeSet::from([RuntimeSessionId::new("s1"), RuntimeSessionId::new("s2")])
        );
    }

    #[tokio::test]
    async fn layout_publishes_after_save_and_before_removed_session_termination_finishes() {
        let store = FakeStore::with_state(state_with_layout(vec![terminal_layout_workspace(
            &[200],
            "/tmp",
        )]));
        let terminals = FakeTerminal::default();
        let runtime = Arc::new(runtime(&store, &terminals).await);
        store.clear_observations();
        terminals.clear_observations();
        terminals.block_termination(RuntimeSessionId::new("s1"));
        let mut events = runtime.subscribe();
        let apply_runtime = Arc::clone(&runtime);

        let apply = tokio::spawn(async move {
            apply_runtime
                .apply_saved_layout_idempotent(
                    0,
                    idempotency_request("ordering", "ordering-request"),
                    layout_id(500),
                    vec![PathBuf::from("/tmp")],
                    LaunchOptions::default(),
                )
                .await
        });

        terminals.termination_started.notified().await;
        let event = timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("commit event must precede terminal cleanup")
            .unwrap();
        assert_eq!(event.revision, 1);
        assert_eq!(event.snapshot.revision, 1);
        assert_eq!(
            store
                .inner
                .lock()
                .unwrap()
                .durable
                .as_ref()
                .unwrap()
                .revision,
            1
        );
        assert!(!apply.is_finished());
        terminals.release_termination.notify_one();
        let result = apply.await.unwrap().unwrap();
        assert!(matches!(result, IdempotentCommitResult::Committed(_)));
    }

    #[tokio::test]
    async fn layout_idempotency_replay_and_conflict_have_no_lifecycle_effects() {
        let store = FakeStore::with_state(state_with_layout(vec![terminal_layout_workspace(
            &[200],
            "/tmp",
        )]));
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        let first = runtime
            .apply_saved_layout_idempotent(
                0,
                idempotency_request("retry", "same-request"),
                layout_id(500),
                vec![PathBuf::from("/tmp")],
                LaunchOptions::default(),
            )
            .await
            .unwrap();
        assert!(matches!(first, IdempotentCommitResult::Committed(_)));
        store.clear_observations();
        terminals.clear_observations();
        let mut events = runtime.subscribe();

        let replay = runtime
            .apply_saved_layout_idempotent(
                0,
                idempotency_request("retry", "same-request"),
                layout_id(500),
                Vec::new(),
                LaunchOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            replay,
            IdempotentCommitResult::Replay("result:retry".to_owned())
        );
        let conflict = runtime
            .apply_saved_layout_idempotent(
                0,
                idempotency_request("retry", "different-request"),
                layout_id(500),
                Vec::new(),
                LaunchOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(conflict, IdempotentCommitResult::Conflict);
        assert!(store.inner.lock().unwrap().saves.is_empty());
        {
            let terminal = terminals.inner.lock().unwrap();
            assert!(terminal.requests.is_empty());
            assert!(terminal.terminated.is_empty());
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn no_op_layout_durably_records_idempotency_without_revision_or_event() {
        let store = FakeStore::with_state(state_with_layout(vec![terminal_layout_workspace(
            &[100],
            "/tmp",
        )]));
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        let mut events = runtime.subscribe();

        let result = runtime
            .apply_saved_layout_idempotent(
                0,
                idempotency_request("no-op", "no-op-request"),
                layout_id(500),
                vec![PathBuf::from("/tmp")],
                LaunchOptions::default(),
            )
            .await
            .unwrap();

        let IdempotentCommitResult::Committed(commit) = result else {
            panic!("first no-op must commit its idempotency record");
        };
        assert_eq!(commit.snapshot.revision, 0);
        assert_eq!(runtime.snapshot().await.revision, 0);
        assert_eq!(store.inner.lock().unwrap().saves.len(), 1);
        {
            let terminal = terminals.inner.lock().unwrap();
            assert!(terminal.requests.is_empty());
            assert!(terminal.terminated.is_empty());
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn notification_save_failure_is_atomic_and_emits_no_domain_event() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        store.fail_next_save();
        let before = runtime.snapshot().await;
        let mut events = runtime.subscribe();
        let notification = Notification::new(
            NotificationId::new(),
            workspace_id(1),
            Some(pane_id(10)),
            Some(tab_id(100)),
            NotificationSource::Internal,
            NotificationLevel::Error,
            "Failed process",
            Some("Exit code 1".to_owned()),
            Timestamp(2),
        )
        .unwrap();

        let failure = runtime
            .mutate(LaunchOptions::default(), move |candidate| {
                candidate.publish_notification(notification)
            })
            .await
            .unwrap_err();

        assert!(matches!(failure.error, RuntimeError::Store(_)));
        assert_eq!(runtime.snapshot().await, before);
        assert!(events.try_recv().is_err());
        assert!(terminals.inner.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn restart_commits_new_session_then_reports_old_termination_failure() {
        let mut store = FakeStore::with_state(state());
        let mut terminals = FakeTerminal::default();
        let shared_audit = Arc::new(StdMutex::new(Vec::new()));
        store.shared_audit = Arc::clone(&shared_audit);
        terminals.shared_audit = Arc::clone(&shared_audit);
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        shared_audit.lock().unwrap().clear();
        terminals.fail_termination(RuntimeSessionId::new("s1"));
        let mut events = runtime.subscribe();

        let result = runtime
            .restart_terminal(
                workspace_id(1),
                tab_id(100),
                Some(vec!["custom-shell".into(), "--private".into()]),
                Timestamp(2),
            )
            .await
            .unwrap();

        assert_eq!(result.snapshot.revision, 1);
        assert_eq!(result.termination_failures.len(), 1);
        assert_eq!(result.termination_failures[0].session_id.as_str(), "s1");
        let event = events.recv().await.unwrap();
        assert_eq!(event.revision, 1);
        let terminal = terminals.inner.lock().unwrap();
        assert_eq!(terminal.audit, ["create:s2", "terminate:s1"]);
        assert_eq!(terminal.requests[0].cwd, Some(PathBuf::from("/tmp")));
        assert_eq!(
            terminal.requests[0].environment,
            expected_environment(workspace_id(1), pane_id(10), tab_id(100))
        );
        let stored = store.inner.lock().unwrap();
        assert_eq!(stored.audit, ["save:1"]);
        assert!(!stored.saves[0].contains("custom-shell"));
        assert!(!stored.saves[0].contains("--private"));
        assert_eq!(
            *shared_audit.lock().unwrap(),
            ["create:s2", "save:1", "terminate:s1"]
        );
    }

    #[tokio::test]
    async fn no_op_has_no_side_effects_and_concurrent_mutations_have_ordered_revisions() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = Arc::new(runtime(&store, &terminals).await);
        store.clear_observations();
        terminals.clear_observations();
        let mut events = runtime.subscribe();

        let failure = runtime
            .mutate(LaunchOptions::default(), |candidate| {
                candidate.update_tab(
                    workspace_id(1),
                    tab_id(100),
                    Some("tab-100".into()),
                    None,
                    Timestamp(2),
                )
            })
            .await
            .unwrap_err();
        assert!(matches!(failure.error, RuntimeError::Domain(_)));
        assert!(store.inner.lock().unwrap().saves.is_empty());
        assert!(terminals.inner.lock().unwrap().requests.is_empty());
        assert!(events.try_recv().is_err());

        let mut tasks = Vec::new();
        for value in 0..8_u64 {
            let runtime = Arc::clone(&runtime);
            tasks.push(tokio::spawn(async move {
                runtime
                    .mutate(LaunchOptions::default(), move |candidate| {
                        candidate.update_tab(
                            workspace_id(1),
                            tab_id(100),
                            Some(format!("title-{value}")),
                            None,
                            Timestamp(value + 3),
                        )
                    })
                    .await
                    .unwrap()
                    .snapshot
                    .revision
            }));
        }
        let mut committed = Vec::new();
        for task in tasks {
            committed.push(task.await.unwrap());
        }
        committed.sort_unstable();
        assert_eq!(committed, (1..=8).collect::<Vec<_>>());
        for expected in 1..=8 {
            assert_eq!(events.recv().await.unwrap().revision, expected);
        }
        assert_eq!(runtime.snapshot().await.revision, 8);
    }

    #[tokio::test]
    async fn ordinary_semantic_no_op_skips_store_terminal_and_event_effects() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        let mut events = runtime.subscribe();

        let result = runtime
            .mutate(LaunchOptions::default(), |candidate| {
                candidate.set_workspace_pinned(workspace_id(1), false)
            })
            .await
            .unwrap();

        assert_eq!(result.snapshot.revision, 0);
        assert!(store.inner.lock().unwrap().saves.is_empty());
        {
            let terminal = terminals.inner.lock().unwrap();
            assert!(terminal.requests.is_empty());
            assert!(terminal.terminated.is_empty());
        }
        assert!(
            timeout(Duration::from_millis(25), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn same_index_reorder_is_a_durable_idempotent_semantic_no_op() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        let mut events = runtime.subscribe();

        let committed = runtime
            .mutate_idempotent(
                0,
                idempotency_request("reorder-no-op", "same-index"),
                |candidate| candidate.move_workspace(workspace_id(1), 0),
            )
            .await
            .unwrap();
        let IdempotentCommitResult::Committed(commit) = committed else {
            panic!("same-index reorder must commit its idempotency result");
        };
        assert_eq!(commit.snapshot.revision, 0);
        assert!(events.try_recv().is_err());

        let replay = runtime
            .mutate_idempotent(
                99,
                idempotency_request("reorder-no-op", "same-index"),
                |_| panic!("replay must not rerun mutation"),
            )
            .await
            .unwrap();
        assert_eq!(
            replay,
            IdempotentCommitResult::Replay("result:reorder-no-op".to_owned())
        );
        assert_eq!(runtime.snapshot().await.revision, 0);
    }

    #[tokio::test]
    async fn idempotent_semantic_no_op_is_atomic_replayable_and_conflict_checked_first() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        let mut events = runtime.subscribe();
        store.fail_next_save();

        let failure = runtime
            .mutate_idempotent(
                0,
                idempotency_request("pin-no-op", "same-request"),
                |candidate| candidate.set_workspace_pinned(workspace_id(1), false),
            )
            .await
            .unwrap_err();
        assert!(matches!(failure.error, RuntimeError::Store(_)));
        assert_eq!(runtime.snapshot().await.revision, 0);
        assert!(events.try_recv().is_err());

        let committed = runtime
            .mutate_idempotent(
                0,
                idempotency_request("pin-no-op", "same-request"),
                |candidate| candidate.set_workspace_pinned(workspace_id(1), false),
            )
            .await
            .unwrap();
        let IdempotentCommitResult::Committed(commit) = committed else {
            panic!("no-op idempotency record must commit");
        };
        assert_eq!(commit.snapshot.revision, 0);
        assert!(events.try_recv().is_err());

        let replay = runtime
            .mutate_idempotent(99, idempotency_request("pin-no-op", "same-request"), |_| {
                panic!("replay must not rerun mutation")
            })
            .await
            .unwrap();
        assert_eq!(
            replay,
            IdempotentCommitResult::Replay("result:pin-no-op".to_owned())
        );
        let conflict = runtime
            .mutate_idempotent(
                99,
                idempotency_request("pin-no-op", "different-request"),
                |_| panic!("conflict must not rerun mutation"),
            )
            .await
            .unwrap();
        assert_eq!(conflict, IdempotentCommitResult::Conflict);
        assert_eq!(runtime.snapshot().await.revision, 0);
    }

    #[tokio::test]
    async fn forged_terminal_launch_effect_is_rejected_before_side_effects() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();

        let failure = runtime
            .mutate(LaunchOptions::default(), |candidate| {
                let mut outcome = candidate.update_tab(
                    workspace_id(1),
                    tab_id(100),
                    Some("renamed".into()),
                    None,
                    Timestamp(2),
                )?;
                outcome.terminal_launches.push(TerminalLaunchRequest {
                    workspace_id: workspace_id(1),
                    pane_id: pane_id(10),
                    tab_id: tab_id(999),
                    launch: launch(),
                });
                Ok(outcome)
            })
            .await
            .unwrap_err();

        assert!(matches!(
            failure.error,
            RuntimeError::InvalidMutationContract
        ));
        assert!(store.inner.lock().unwrap().saves.is_empty());
        assert!(terminals.inner.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn forged_terminal_termination_effect_is_rejected_before_side_effects() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();

        let failure = runtime
            .mutate(LaunchOptions::default(), |candidate| {
                let mut outcome = candidate.update_tab(
                    workspace_id(1),
                    tab_id(100),
                    Some("renamed".into()),
                    None,
                    Timestamp(2),
                )?;
                outcome
                    .terminal_sessions_to_terminate
                    .push(RuntimeSessionId::new("forged-session"));
                Ok(outcome)
            })
            .await
            .unwrap_err();

        assert!(matches!(
            failure.error,
            RuntimeError::InvalidMutationContract
        ));
        assert!(store.inner.lock().unwrap().saves.is_empty());
        assert!(terminals.inner.lock().unwrap().terminated.is_empty());
    }

    #[test]
    fn lifecycle_mapping_covers_launch_session_and_content_transitions() {
        let before = state();

        let mut launch_changed = before.clone();
        let replacement_launch =
            TerminalLaunchSpec::new(PathBuf::from("/var/tmp"), None, 40, 120).unwrap();
        let TabContent::Terminal { launch, .. } = &mut launch_changed.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content
        else {
            panic!("fixture tab must be terminal");
        };
        *launch = replacement_launch.clone();
        assert_eq!(
            lifecycle_outcome(&before, &launch_changed),
            MutationOutcome {
                revision: 0,
                terminal_launches: vec![TerminalLaunchRequest {
                    workspace_id: workspace_id(1),
                    pane_id: pane_id(10),
                    tab_id: tab_id(100),
                    launch: replacement_launch,
                }],
                terminal_sessions_to_terminate: vec![RuntimeSessionId::new("stale-session")],
            }
        );
        assert!(!introduces_unowned_runtime_session(
            &before,
            &launch_changed
        ));

        let mut two_before = two_terminal_state();
        two_before.workspaces[0]
            .tabs
            .get_mut(&tab_id(200))
            .unwrap()
            .content
            .set_runtime_session_id(Some(RuntimeSessionId::new("second-session")));
        let mut swapped = two_before.clone();
        swapped.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content
            .set_runtime_session_id(Some(RuntimeSessionId::new("second-session")));
        swapped.workspaces[0]
            .tabs
            .get_mut(&tab_id(200))
            .unwrap()
            .content
            .set_runtime_session_id(Some(RuntimeSessionId::new("stale-session")));
        assert!(introduces_unowned_runtime_session(&two_before, &swapped));

        let mut browser_before = before.clone();
        browser_before.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content = browser_tab(100, pane_id(10)).content;
        let mut browser_to_terminal = browser_before.clone();
        browser_to_terminal.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content = tab(100, pane_id(10), None).content;
        assert_eq!(
            lifecycle_outcome(&browser_before, &browser_to_terminal)
                .terminal_launches
                .len(),
            1
        );
        browser_to_terminal.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content
            .set_runtime_session_id(Some(RuntimeSessionId::new("stale-session")));
        assert!(introduces_unowned_runtime_session(
            &browser_before,
            &browser_to_terminal
        ));

        let mut terminal_to_browser = before.clone();
        terminal_to_browser.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content = browser_tab(100, pane_id(10)).content;
        assert_eq!(
            lifecycle_outcome(&before, &terminal_to_browser).terminal_sessions_to_terminate,
            [RuntimeSessionId::new("stale-session")]
        );
    }

    #[test]
    fn detached_existing_terminal_is_replaced_instead_of_left_without_a_session() {
        let before = state();
        let mut detached = before.clone();
        detached.workspaces[0]
            .tabs
            .get_mut(&tab_id(100))
            .unwrap()
            .content
            .set_runtime_session_id(None);

        assert_eq!(
            lifecycle_outcome(&before, &detached),
            MutationOutcome {
                revision: 0,
                terminal_launches: vec![TerminalLaunchRequest {
                    workspace_id: workspace_id(1),
                    pane_id: pane_id(10),
                    tab_id: tab_id(100),
                    launch: launch(),
                }],
                terminal_sessions_to_terminate: vec![RuntimeSessionId::new("stale-session")],
            }
        );
    }

    #[test]
    fn moving_a_terminal_tab_across_workspaces_preserves_runtime_identity() {
        let mut before = state();
        let second_pane = pane_id(20);
        before.workspaces.push(
            Workspace::new(
                workspace_id(2),
                "second-workspace",
                PathBuf::from("/tmp"),
                second_pane,
                browser_tab(300, second_pane),
                Timestamp(1),
                Timestamp(1),
            )
            .unwrap(),
        );
        let mut after = before.clone();
        let mut moved = after.workspaces[0].tabs.remove(&tab_id(100)).unwrap();
        moved.pane_id = second_pane;
        after.workspaces[1].tabs.insert(moved.id, moved);

        assert_eq!(
            lifecycle_outcome(&before, &after),
            MutationOutcome {
                revision: 0,
                terminal_launches: Vec::new(),
                terminal_sessions_to_terminate: Vec::new(),
            }
        );
        assert!(!introduces_unowned_runtime_session(&before, &after));
    }

    #[tokio::test]
    async fn launch_spec_change_replaces_the_exact_tab_pty() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();
        let replacement_launch =
            TerminalLaunchSpec::new(PathBuf::from("/var/tmp"), None, 40, 120).unwrap();
        let closure_launch = replacement_launch.clone();

        let result = runtime
            .mutate(LaunchOptions::default(), move |candidate| {
                let mut outcome = candidate.update_tab(
                    workspace_id(1),
                    tab_id(100),
                    Some("relaunched".into()),
                    None,
                    Timestamp(2),
                )?;
                let TabContent::Terminal { launch, .. } = &mut candidate.workspaces[0]
                    .tabs
                    .get_mut(&tab_id(100))
                    .unwrap()
                    .content
                else {
                    unreachable!();
                };
                *launch = closure_launch.clone();
                outcome.terminal_launches.push(TerminalLaunchRequest {
                    workspace_id: workspace_id(1),
                    pane_id: pane_id(10),
                    tab_id: tab_id(100),
                    launch: closure_launch,
                });
                outcome
                    .terminal_sessions_to_terminate
                    .push(RuntimeSessionId::new("s1"));
                Ok(outcome)
            })
            .await
            .unwrap();

        assert_eq!(result.snapshot.revision, 1);
        assert_eq!(
            result.snapshot.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s2"
        );
        assert_eq!(terminals.inner.lock().unwrap().requests[0].rows, 40);
        assert_eq!(
            terminals.inner.lock().unwrap().terminated,
            [RuntimeSessionId::new("s1")]
        );
        assert_eq!(
            terminals.live_sessions(),
            BTreeSet::from([RuntimeSessionId::new("s2")])
        );
    }

    #[tokio::test]
    async fn swapping_existing_sessions_between_tabs_is_rejected_before_save() {
        let store = FakeStore::with_state(two_terminal_state());
        let terminals = FakeTerminal::default();
        let runtime = runtime(&store, &terminals).await;
        store.clear_observations();
        terminals.clear_observations();

        let failure = runtime
            .mutate(LaunchOptions::default(), |candidate| {
                let outcome = candidate.update_tab(
                    workspace_id(1),
                    tab_id(100),
                    Some("attempted-swap".into()),
                    None,
                    Timestamp(3),
                )?;
                let first_session = candidate.workspaces[0].tabs[&tab_id(100)]
                    .content
                    .runtime_session_id()
                    .unwrap()
                    .clone();
                let second_session = candidate.workspaces[0].tabs[&tab_id(200)]
                    .content
                    .runtime_session_id()
                    .unwrap()
                    .clone();
                candidate.workspaces[0]
                    .tabs
                    .get_mut(&tab_id(100))
                    .unwrap()
                    .content
                    .set_runtime_session_id(Some(second_session));
                candidate.workspaces[0]
                    .tabs
                    .get_mut(&tab_id(200))
                    .unwrap()
                    .content
                    .set_runtime_session_id(Some(first_session));
                Ok(outcome)
            })
            .await
            .unwrap_err();

        assert!(matches!(
            failure.error,
            RuntimeError::InvalidMutationContract
        ));
        assert!(store.inner.lock().unwrap().saves.is_empty());
        assert!(terminals.inner.lock().unwrap().terminated.is_empty());
        assert_eq!(
            terminals.live_sessions(),
            BTreeSet::from([RuntimeSessionId::new("s1"), RuntimeSessionId::new("s2")])
        );
    }

    #[test]
    fn executor_shutdown_cannot_split_durable_authority_or_leak_ptys() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let caller = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let runtime = Arc::new(caller.block_on(runtime(&store, &terminals)));
        store.clear_observations();
        terminals.clear_observations();
        store.block_next_save();

        let task_runtime = Arc::clone(&runtime);
        let _caller_task = caller.spawn(async move {
            task_runtime
                .restart_terminal(workspace_id(1), tab_id(100), None, Timestamp(2))
                .await
        });
        caller.block_on(store.save_started.notified());
        drop(caller);
        store.release_save();

        let verifier = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        verifier
            .block_on(async {
                timeout(Duration::from_secs(2), async {
                    loop {
                        let durable_revision = store
                            .inner
                            .lock()
                            .unwrap()
                            .durable
                            .as_ref()
                            .map(|state| state.revision);
                        let snapshot = runtime.snapshot().await;
                        if durable_revision == Some(1)
                            && snapshot.revision == 1
                            && terminals.live_sessions()
                                == BTreeSet::from([RuntimeSessionId::new("s2")])
                        {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
            })
            .expect("lifecycle worker must finish after the caller executor shuts down");

        let durable = store.inner.lock().unwrap().durable.clone().unwrap();
        let authoritative = verifier.block_on(runtime.snapshot());
        assert_eq!(durable.revision, authoritative.revision);
        assert_eq!(
            authoritative.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s2"
        );
        assert_eq!(
            terminals.inner.lock().unwrap().terminated,
            [RuntimeSessionId::new("s1")]
        );

        let bootstrap_store = FakeStore::with_state(state());
        let bootstrap_terminals = FakeTerminal::default();
        bootstrap_store.block_next_save();
        let bootstrap_caller = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let task_store = bootstrap_store.clone();
        let task_terminals = bootstrap_terminals.clone();
        let _bootstrap_task = bootstrap_caller.spawn(async move {
            WorkspaceRuntime::bootstrap(
                Arc::new(task_store),
                Arc::new(task_terminals),
                BootstrapConfig::from_state(state()).unwrap(),
            )
            .await
        });
        bootstrap_caller.block_on(bootstrap_store.save_started.notified());
        drop(bootstrap_caller);
        bootstrap_store.release_save();
        verifier
            .block_on(async {
                timeout(Duration::from_secs(2), async {
                    loop {
                        if bootstrap_terminals.live_sessions().is_empty()
                            && bootstrap_terminals.inner.lock().unwrap().terminated
                                == [RuntimeSessionId::new("s1")]
                        {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
            })
            .expect("abandoned bootstrap must clean its PTY after executor shutdown");
    }

    #[tokio::test]
    async fn aborting_multi_create_bootstrap_cleans_every_created_session() {
        let store = FakeStore::with_state(two_terminal_state());
        let terminals = FakeTerminal::default();
        terminals.block_create(2);
        let bootstrap = tokio::spawn(WorkspaceRuntime::bootstrap(
            Arc::new(store),
            Arc::new(terminals.clone()),
            BootstrapConfig::from_state(state()).unwrap(),
        ));

        terminals.create_started.notified().await;
        bootstrap.abort();
        assert!(bootstrap.await.is_err());
        terminals.release_create.notify_one();

        timeout(Duration::from_secs(2), async {
            loop {
                if terminals.inner.lock().unwrap().terminated.len() == 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned bootstrap must clean every created terminal");
        let terminated = &terminals.inner.lock().unwrap().terminated;
        assert_eq!(terminated[0].as_str(), "s1");
        assert_eq!(terminated[1].as_str(), "s2");
    }

    #[tokio::test]
    async fn aborting_mutate_and_restart_does_not_interrupt_authoritative_completion() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = Arc::new(runtime(&store, &terminals).await);

        terminals.block_create(2);
        let mutate_runtime = Arc::clone(&runtime);
        let mutation = tokio::spawn(async move {
            mutate_runtime
                .mutate(LaunchOptions::default(), |candidate| {
                    candidate.open_terminal_tab(
                        workspace_id(1),
                        pane_id(10),
                        1,
                        tab(200, pane_id(10), None),
                        Timestamp(2),
                    )
                })
                .await
        });
        terminals.create_started.notified().await;
        mutation.abort();
        mutation.await.unwrap_err();
        terminals.release_create.notify_one();
        timeout(Duration::from_secs(2), async {
            loop {
                if runtime.snapshot().await.revision == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled mutation must finish its authoritative commit");
        assert_eq!(
            runtime.snapshot().await.workspaces[0].tabs[&tab_id(200)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s2"
        );

        terminals.block_create(3);
        let restart_runtime = Arc::clone(&runtime);
        let restart = tokio::spawn(async move {
            restart_runtime
                .restart_terminal(workspace_id(1), tab_id(100), None, Timestamp(3))
                .await
        });
        terminals.create_started.notified().await;
        restart.abort();
        restart.await.unwrap_err();
        terminals.release_create.notify_one();
        timeout(Duration::from_secs(2), async {
            loop {
                if runtime.snapshot().await.revision == 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled restart must finish its authoritative commit");
        let snapshot = runtime.snapshot().await;
        assert_eq!(
            snapshot.workspaces[0].tabs[&tab_id(100)]
                .content
                .runtime_session_id()
                .unwrap()
                .as_str(),
            "s3"
        );
        assert!(
            terminals
                .inner
                .lock()
                .unwrap()
                .terminated
                .iter()
                .any(|session| session.as_str() == "s1")
        );
    }

    #[tokio::test]
    async fn aborting_idempotent_mutation_does_not_interrupt_authoritative_completion() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = Arc::new(runtime(&store, &terminals).await);
        store.block_next_save();
        let mutation_runtime = Arc::clone(&runtime);
        let mutation = tokio::spawn(async move {
            mutation_runtime
                .mutate_idempotent(
                    0,
                    IdempotencySaveRequest {
                        namespace: "attention-v1".to_owned(),
                        idempotency_key: "key".to_owned(),
                        request_json: "request".to_owned(),
                        result_json: "result".to_owned(),
                        retention_capacity: 8,
                    },
                    |candidate| {
                        candidate.publish_notification(Notification::new(
                            NotificationId::from_uuid(Uuid::from_u128(900)),
                            workspace_id(1),
                            Some(pane_id(10)),
                            Some(tab_id(100)),
                            NotificationSource::Internal,
                            NotificationLevel::Info,
                            "attention",
                            None,
                            Timestamp(2),
                        )?)
                    },
                )
                .await
        });
        store.save_started.notified().await;
        mutation.abort();
        mutation.await.unwrap_err();
        store.release_save();
        timeout(Duration::from_secs(2), async {
            loop {
                if runtime.snapshot().await.revision == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled idempotent mutation must finish its authoritative commit");
        assert_eq!(
            store
                .inner
                .lock()
                .unwrap()
                .durable
                .as_ref()
                .unwrap()
                .revision,
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_storage_save_does_not_stall_single_worker_timers() {
        let store = FakeStore::with_state(state());
        let terminals = FakeTerminal::default();
        let runtime = Arc::new(runtime(&store, &terminals).await);
        store.block_next_save();
        let task_runtime = Arc::clone(&runtime);
        let mutation = tokio::spawn(async move {
            task_runtime
                .mutate(LaunchOptions::default(), |candidate| {
                    candidate.update_tab(
                        workspace_id(1),
                        tab_id(100),
                        Some("nonblocking-save".into()),
                        None,
                        Timestamp(2),
                    )
                })
                .await
        });

        store.save_started.notified().await;
        let watchdog_store = store.clone();
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            watchdog_store.release_save();
        });
        let started = Instant::now();
        sleep(Duration::from_millis(20)).await;
        assert!(
            started.elapsed() < Duration::from_millis(150),
            "storage work blocked the only async worker"
        );
        store.release_save();
        mutation.await.unwrap().unwrap();
        watchdog.join().unwrap();
    }
}

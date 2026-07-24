//! Closed remote target/session catalog and service-owned transport orchestration.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    time::{SystemTime, UNIX_EPOCH},
};

use agent_workspace_core::RuntimeSessionId;
use agent_workspace_protocol::{
    RemoteAuthenticationMethod, RemoteHostKeyChallenge, RemoteHostKeyDecision,
    RemoteHostKeyScanParams, RemoteHostKeyState, RemoteHostKeyTrustParams, RemoteListParams,
    RemoteObservationState, RemoteSessionCloseParams, RemoteSessionConnectParams,
    RemoteSessionDetachParams, RemoteSessionIdParams, RemoteSessionListResult,
    RemoteSessionReconnectParams, RemoteSessionResult, RemoteSessionSnapshot, RemoteSessionState,
    RemoteTargetCreateParams, RemoteTargetDeleteParams, RemoteTargetIdParams,
    RemoteTargetListResult, RemoteTargetResult, RemoteTargetSnapshot, RemoteTmuxDiscoverParams,
    RemoteTmuxDiscoveryResult, RemoteTmuxIdentity, RemoteTmuxMode, ResponseEnvelope,
    TaskActionKind, TaskTarget,
};
use agent_workspace_runtime::TerminalManagerBackend;
use agent_workspace_storage::{
    RemoteMutationOutcome, RemoteSessionRecord, RemoteSessionStateRecord, RemoteTargetRecord,
    SqliteStateStore, StorageError,
};
use agent_workspace_terminal_runtime::TerminalEvent;
#[cfg(any(test, not(target_os = "linux")))]
use agent_workspace_terminal_runtime::remote::UnavailableCredentialProvider;
#[cfg(target_os = "linux")]
use agent_workspace_terminal_runtime::remote::{
    SecretServiceCredentialProvider, delete_target_credential,
};
use agent_workspace_terminal_runtime::remote::{
    CredentialBrokerLease, CredentialProvider, CredentialReference, HostKeyDescriptor,
    RemoteRuntimeError, SshLaunchPlan, SystemHostKeyScanner, TmuxOperation, VerifiedRemoteTarget,
    parse_tmux_sessions, reconnect_delay, resolve_ssh_executable, write_known_host_atomic,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

const COMMANDS: &[&str] = &[
    "remote.target.list",
    "remote.target.get",
    "remote.target.create",
    "remote.target.delete",
    "remote.session.list",
    "remote.session.get",
    "remote.session.connect",
    "remote.hostKey.scan",
    "remote.hostKey.decide",
    "remote.session.detach",
    "remote.session.reconnect",
    "remote.session.close",
    "remote.tmux.discover",
];

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

trait RemoteExecutor: Send + Sync {
    fn launch(
        &self,
        plan: SshLaunchPlan,
    ) -> BoxFuture<Result<(RuntimeSessionId, CredentialBrokerLease), RemoteRuntimeError>>;
    fn terminate(&self, terminal_id: RuntimeSessionId)
    -> BoxFuture<Result<(), RemoteRuntimeError>>;
    fn is_live(&self, _terminal_id: &RuntimeSessionId) -> bool {
        false
    }
    fn discover(&self, _plan: SshLaunchPlan) -> BoxFuture<Result<Vec<u8>, RemoteRuntimeError>> {
        Box::pin(async { Err(RemoteRuntimeError::CredentialProviderUnavailable) })
    }
}

#[derive(Clone)]
struct ProductionExecutor(TerminalManagerBackend);
impl RemoteExecutor for ProductionExecutor {
    fn launch(
        &self,
        plan: SshLaunchPlan,
    ) -> BoxFuture<Result<(RuntimeSessionId, CredentialBrokerLease), RemoteRuntimeError>> {
        let backend = self.0.clone();
        Box::pin(async move {
            let terminal_id = backend
                .create_remote(&plan, 24, 80)
                .await
                .map_err(|_| RemoteRuntimeError::TransportUnavailable)?;
            Ok((terminal_id, plan.into_lease()))
        })
    }
    fn terminate(
        &self,
        terminal_id: RuntimeSessionId,
    ) -> BoxFuture<Result<(), RemoteRuntimeError>> {
        let backend = self.0.clone();
        Box::pin(async move {
            backend
                .terminate_remote(&terminal_id)
                .await
                .map_err(|_| RemoteRuntimeError::TransportUnavailable)
        })
    }
    fn is_live(&self, terminal_id: &RuntimeSessionId) -> bool {
        self.0
            .terminal_io()
            .attach(terminal_id.as_str())
            .is_ok_and(|snapshot| !snapshot.terminal.exited)
    }
    fn discover(&self, plan: SshLaunchPlan) -> BoxFuture<Result<Vec<u8>, RemoteRuntimeError>> {
        Box::pin(async move {
            use std::process::Stdio;
            use tokio::io::AsyncReadExt as _;
            plan.revalidate()?;
            let mut command = tokio::process::Command::new(plan.executable());
            command
                .args(plan.argv())
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            for (key, value) in plan.environment() {
                command.env(key, value);
            }
            let mut child = command
                .spawn()
                .map_err(|_| RemoteRuntimeError::TransportUnavailable)?;
            let stdout = child
                .stdout
                .take()
                .ok_or(RemoteRuntimeError::InvalidTmuxResponse)?;
            let operation = async {
                let mut output = Vec::new();
                let mut limited = stdout.take(
                    (agent_workspace_terminal_runtime::remote::MAX_TMUX_DISCOVERY_BYTES + 1) as u64,
                );
                let read = limited.read_to_end(&mut output);
                let (read, status) = tokio::join!(read, child.wait());
                read.map_err(|_| RemoteRuntimeError::InvalidTmuxResponse)?;
                let status = status.map_err(|_| RemoteRuntimeError::InvalidTmuxResponse)?;
                if !status.success()
                    || output.len()
                        > agent_workspace_terminal_runtime::remote::MAX_TMUX_DISCOVERY_BYTES
                {
                    return Err(RemoteRuntimeError::InvalidTmuxResponse);
                }
                Ok(output)
            };
            tokio::time::timeout(std::time::Duration::from_secs(15), operation)
                .await
                .map_err(|_| RemoteRuntimeError::InvalidTmuxResponse)?
        })
    }
}

#[async_trait::async_trait]
trait HostKeyAuthority: Send + Sync {
    async fn verify(
        &self,
        target: &RemoteTargetRecord,
        attempt_generation: u64,
    ) -> Result<VerifiedRemoteTarget, RemoteRuntimeError>;
    async fn challenge(
        &self,
        _target: &RemoteTargetRecord,
        _remote_session_id: Uuid,
        _attempt_generation: u64,
    ) -> Result<RemoteHostKeyChallenge, RemoteRuntimeError> {
        Err(RemoteRuntimeError::HostKeyScanUnavailable)
    }
    async fn decide(
        &self,
        _target: &RemoteTargetRecord,
        _remote_session_id: Uuid,
        _prompt_id: Uuid,
        _attempt_generation: u64,
        _fingerprint: &str,
        _decision: RemoteHostKeyDecision,
    ) -> Result<(), RemoteRuntimeError> {
        Err(RemoteRuntimeError::CredentialProviderUnavailable)
    }
    async fn remove_target(&self, _target_id: Uuid) -> Result<(), RemoteRuntimeError> {
        Ok(())
    }
}

#[async_trait::async_trait]
trait CredentialCleanup: Send + Sync {
    async fn remove_target(&self, target_id: Uuid) -> Result<(), RemoteRuntimeError>;
}

#[derive(Clone, Copy, Debug, Default)]
struct ProductionCredentialCleanup;

#[async_trait::async_trait]
impl CredentialCleanup for ProductionCredentialCleanup {
    async fn remove_target(&self, target_id: Uuid) -> Result<(), RemoteRuntimeError> {
        #[cfg(target_os = "linux")]
        {
            delete_target_credential(target_id).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            // No Secret Service credential store exists off Linux, so there is nothing to remove.
            let _ = target_id;
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
#[cfg(test)]
struct NoopCredentialCleanup;

#[cfg(test)]
#[async_trait::async_trait]
impl CredentialCleanup for NoopCredentialCleanup {
    async fn remove_target(&self, _target_id: Uuid) -> Result<(), RemoteRuntimeError> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
#[cfg(test)]
struct UnavailableHostKeyAuthority;
#[cfg(test)]
#[async_trait::async_trait]
impl HostKeyAuthority for UnavailableHostKeyAuthority {
    async fn verify(
        &self,
        target: &RemoteTargetRecord,
        _generation: u64,
    ) -> Result<VerifiedRemoteTarget, RemoteRuntimeError> {
        Err(match target.host_key_state.as_str() {
            "changed" | "revoked" => RemoteRuntimeError::HostKeyMismatch,
            "untrusted" => RemoteRuntimeError::HostKeyUntrusted,
            _ => RemoteRuntimeError::CredentialProviderUnavailable,
        })
    }
}

const HOST_KEY_PROMPT_TTL_MS: i64 = 120_000;
const MAX_HOST_KEY_PROMPTS: usize = 64;
const MAX_HOST_KEY_PROMPTS_PER_TARGET: usize = 4;

#[derive(Clone)]
struct ProductionHostKeyAuthority {
    scanner: SystemHostKeyScanner,
    known_hosts_root: PathBuf,
    prompts: Arc<StdMutex<HashMap<Uuid, PendingHostKeyPrompt>>>,
}

#[derive(Clone)]
struct PendingHostKeyPrompt {
    remote_session_id: Uuid,
    target_id: Uuid,
    target_revision: u64,
    attempt_generation: u64,
    expires_at_ms: i64,
    descriptor: HostKeyDescriptor,
}

impl ProductionHostKeyAuthority {
    fn new(known_hosts_root: PathBuf) -> Result<Self, RemoteRuntimeError> {
        Ok(Self {
            scanner: SystemHostKeyScanner::resolve()?,
            known_hosts_root,
            prompts: Arc::new(StdMutex::new(HashMap::new())),
        })
    }

    fn known_hosts(&self, target_id: Uuid) -> PathBuf {
        self.known_hosts_root
            .join(format!("{target_id}.known_hosts"))
    }

    fn check_prompt_capacity(&self, target_id: Uuid) -> Result<(), RemoteRuntimeError> {
        let now = now_ms();
        let mut prompts = self
            .prompts
            .lock()
            .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?;
        prompts.retain(|_, prompt| prompt.expires_at_ms >= now);
        let target_count = prompts
            .values()
            .filter(|prompt| prompt.target_id == target_id)
            .count();
        if prompts.len() >= MAX_HOST_KEY_PROMPTS || target_count >= MAX_HOST_KEY_PROMPTS_PER_TARGET
        {
            return Err(RemoteRuntimeError::HostKeyPromptCapacity);
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl HostKeyAuthority for ProductionHostKeyAuthority {
    async fn verify(
        &self,
        target: &RemoteTargetRecord,
        _attempt_generation: u64,
    ) -> Result<VerifiedRemoteTarget, RemoteRuntimeError> {
        if target.host_key_state != "trusted" {
            return Err(
                if matches!(target.host_key_state.as_str(), "changed" | "revoked") {
                    RemoteRuntimeError::HostKeyMismatch
                } else {
                    RemoteRuntimeError::HostKeyUntrusted
                },
            );
        }
        let approved = HostKeyDescriptor::read_exact(
            &self.known_hosts(target.remote_target_id),
            &target.host,
            target.port,
        )?;
        let presented = self.scanner.scan(&target.host, target.port).await?;
        if approved != presented {
            return Err(RemoteRuntimeError::HostKeyMismatch);
        }
        VerifiedRemoteTarget::verify(
            target.host.clone(),
            target.port,
            target.user.clone(),
            target.known_hosts_version,
            RemoteHostKeyState::Trusted,
            &approved.fingerprint,
            &presented.fingerprint,
        )
    }

    async fn challenge(
        &self,
        target: &RemoteTargetRecord,
        remote_session_id: Uuid,
        attempt_generation: u64,
    ) -> Result<RemoteHostKeyChallenge, RemoteRuntimeError> {
        if !matches!(
            target.host_key_state.as_str(),
            "untrusted" | "changed" | "revoked"
        ) || attempt_generation == 0
        {
            return Err(RemoteRuntimeError::HostKeyMismatch);
        }
        self.check_prompt_capacity(target.remote_target_id)?;
        let descriptor = self.scanner.scan(&target.host, target.port).await?;
        self.check_prompt_capacity(target.remote_target_id)?;
        let prompt_id = Uuid::new_v4();
        let expires_at_ms = now_ms().saturating_add(HOST_KEY_PROMPT_TTL_MS);
        let pending = PendingHostKeyPrompt {
            remote_session_id,
            target_id: target.remote_target_id,
            target_revision: target.revision,
            attempt_generation,
            expires_at_ms,
            descriptor: descriptor.clone(),
        };
        let replaced = self
            .prompts
            .lock()
            .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?
            .insert(prompt_id, pending);
        if replaced.is_some() {
            return Err(RemoteRuntimeError::HostKeyPromptCapacity);
        }
        Ok(RemoteHostKeyChallenge {
            remote_session_id: remote_session_id.to_string(),
            prompt_id: prompt_id.to_string(),
            attempt_generation,
            canonical_host: descriptor.canonical_host,
            port: descriptor.port,
            algorithm: descriptor.algorithm,
            public_key: descriptor.public_key,
            presented_fingerprint: descriptor.fingerprint,
            target_revision: target.revision,
            expires_at_ms: u64::try_from(expires_at_ms)
                .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?,
        })
    }

    async fn decide(
        &self,
        target: &RemoteTargetRecord,
        remote_session_id: Uuid,
        prompt_id: Uuid,
        attempt_generation: u64,
        fingerprint: &str,
        decision: RemoteHostKeyDecision,
    ) -> Result<(), RemoteRuntimeError> {
        // Remove first: every prompt is one-shot even when the decision or write fails.
        let prompt = self
            .prompts
            .lock()
            .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?
            .remove(&prompt_id)
            .ok_or(RemoteRuntimeError::HostKeyMismatch)?;
        if prompt.remote_session_id != remote_session_id
            || prompt.target_id != target.remote_target_id
            || prompt.target_revision != target.revision
            || prompt.attempt_generation != attempt_generation
            || prompt.expires_at_ms < now_ms()
            || prompt.descriptor.fingerprint != fingerprint
        {
            return Err(RemoteRuntimeError::HostKeyMismatch);
        }
        if decision == RemoteHostKeyDecision::Trust {
            write_known_host_atomic(
                &self.known_hosts(target.remote_target_id),
                &prompt.descriptor,
            )?;
        }
        Ok(())
    }

    async fn remove_target(&self, target_id: Uuid) -> Result<(), RemoteRuntimeError> {
        self.prompts
            .lock()
            .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?
            .retain(|_, prompt| prompt.target_id != target_id);
        let path = self.known_hosts(target_id);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(RemoteRuntimeError::UnsafeKnownHosts),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.uid() != rustix::process::getuid().as_raw()
                || metadata.permissions().mode() & 0o077 != 0
                || metadata.nlink() != 1
            {
                return Err(RemoteRuntimeError::UnsafeKnownHosts);
            }
        }
        #[cfg(not(unix))]
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RemoteRuntimeError::UnsafeKnownHosts);
        }
        fs::remove_file(path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)
    }
}

#[derive(Clone)]
pub(super) struct RemoteSessionControlRuntime {
    store: Arc<SqliteStateStore>,
    ssh: PathBuf,
    known_hosts_root: PathBuf,
    credentials: Arc<dyn CredentialProvider>,
    credential_cleanup: Arc<dyn CredentialCleanup>,
    host_keys: Arc<dyn HostKeyAuthority>,
    executor: Arc<dyn RemoteExecutor>,
    live: Arc<Mutex<HashMap<Uuid, LiveTransport>>>,
    target_locks: Arc<Mutex<HashMap<Uuid, Arc<Mutex<()>>>>>,
}

struct LiveTransport {
    generation: u64,
    terminal_id: RuntimeSessionId,
    _credential_lease: CredentialBrokerLease,
}

pub(super) struct RemoteTaskActionOutcome {
    pub session: RemoteSessionRecord,
    pub already_terminal: bool,
}

impl RemoteSessionControlRuntime {
    pub(super) fn new(
        store: Arc<SqliteStateStore>,
        backend: TerminalManagerBackend,
    ) -> Result<Self, RemoteRuntimeError> {
        let ssh = resolve_ssh_executable()?;
        let parent = store
            .path()
            .parent()
            .ok_or(RemoteRuntimeError::UnsafeKnownHosts)?;
        let known_hosts_root = parent.join("remote-known-hosts");
        let broker_root = parent.join("remote-agent-sockets");
        prepare_private_directory(&known_hosts_root)?;
        prepare_private_directory(&broker_root)?;
        let known_hosts_root =
            fs::canonicalize(known_hosts_root).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
        store
            .reconcile_remote_sessions_after_restart(now_ms())
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
        let mut events = backend.terminal_io().subscribe();
        let host_keys = Arc::new(ProductionHostKeyAuthority::new(known_hosts_root.clone())?);
        let runtime = Self {
            store,
            ssh,
            known_hosts_root,
            #[cfg(target_os = "linux")]
            credentials: Arc::new(SecretServiceCredentialProvider::new(broker_root)?),
            #[cfg(not(target_os = "linux"))]
            credentials: Arc::new(UnavailableCredentialProvider),
            credential_cleanup: Arc::new(ProductionCredentialCleanup),
            host_keys,
            executor: Arc::new(ProductionExecutor(backend)),
            live: Arc::new(Mutex::new(HashMap::new())),
            target_locks: Arc::new(Mutex::new(HashMap::new())),
        };
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| RemoteRuntimeError::TransportUnavailable)?;
        let event_runtime = runtime.clone();
        handle.spawn(async move {
            let mut credential_fence_tick =
                tokio::time::interval(std::time::Duration::from_millis(250));
            loop {
                tokio::select! {
                    _ = credential_fence_tick.tick() => {
                        reconcile_live_transport_fences(&event_runtime).await;
                    }
                    event = events.recv() => match event {
                        Ok(TerminalEvent::Exited { terminal_id, .. }) => {
                            let exited = {
                                let mut live = event_runtime.live.lock().await;
                                let found = live
                                    .iter()
                                    .find(|(_, value)| value.terminal_id.as_str() == terminal_id)
                                    .map(|(id, value)| (*id, value.generation));
                                if let Some((id, _)) = found {
                                    live.remove(&id);
                                }
                                found
                            };
                            if let Some((id, generation)) = exited
                                && event_runtime
                                    .store
                                    .record_remote_transport_exit(id, generation, now_ms())
                                    .unwrap_or(false)
                            {
                                let reconnect_runtime = event_runtime.clone();
                                tokio::spawn(async move {
                                    automatic_reconnect(reconnect_runtime, id, generation).await;
                                });
                            }
                        }
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        });
        Ok(runtime)
    }

    pub(super) async fn task_action(
        &self,
        action: TaskActionKind,
        target: &TaskTarget,
        mutation: agent_workspace_protocol::RemoteMutationIdentity,
    ) -> Result<RemoteTaskActionOutcome, &'static str> {
        let id = Uuid::parse_str(&target.session_id).map_err(|_| "target_not_found")?;
        let before = self
            .store
            .load_remote_session(id)
            .map_err(|_| "runtime_unavailable")?
            .ok_or("target_not_found")?;
        if before.attempt_generation != target.generation {
            return Err("target_stale");
        }
        let already_terminal = match action {
            TaskActionKind::Detach => before.state == RemoteSessionStateRecord::Detached,
            TaskActionKind::Cancel | TaskActionKind::Terminate | TaskActionKind::ForceTerminate => {
                before.state == RemoteSessionStateRecord::Closed
            }
        };
        let params = match action {
            TaskActionKind::Detach => serde_json::to_value(RemoteSessionDetachParams {
                remote_session_id: target.session_id.clone(),
                mutation,
            }),
            TaskActionKind::Cancel | TaskActionKind::Terminate | TaskActionKind::ForceTerminate => {
                serde_json::to_value(RemoteSessionCloseParams {
                    remote_session_id: target.session_id.clone(),
                    mutation,
                })
            }
        }
        .map_err(|_| "runtime_unavailable")?;
        let result = match action {
            TaskActionKind::Detach => {
                lifecycle_mutation(
                    "remote.session.detach",
                    target.session_id.clone(),
                    parse::<RemoteSessionDetachParams>(params)
                        .map_err(|_| "runtime_unavailable")?
                        .mutation,
                    RemoteSessionStateRecord::Detached,
                    false,
                    self,
                )
                .await
            }
            TaskActionKind::Cancel | TaskActionKind::Terminate | TaskActionKind::ForceTerminate => {
                lifecycle_mutation(
                    "remote.session.close",
                    target.session_id.clone(),
                    parse::<RemoteSessionCloseParams>(params)
                        .map_err(|_| "runtime_unavailable")?
                        .mutation,
                    RemoteSessionStateRecord::Closed,
                    false,
                    self,
                )
                .await
            }
        };
        result.map_err(|error| error.code)?;
        let session = self
            .store
            .load_remote_session(id)
            .map_err(|_| "runtime_unavailable")?
            .ok_or("target_not_found")?;
        Ok(RemoteTaskActionOutcome {
            session,
            already_terminal,
        })
    }

    fn known_hosts(&self, target_id: Uuid) -> Result<PathBuf, RemoteRuntimeError> {
        let path = self
            .known_hosts_root
            .join(format!("{target_id}.known_hosts"));
        prepare_private_file(&path)?;
        Ok(path)
    }

    async fn launch_plan(
        &self,
        target: &RemoteTargetRecord,
        generation: u64,
        operation: &TmuxOperation,
    ) -> Result<SshLaunchPlan, RemoteRuntimeError> {
        if self
            .store
            .remote_target_delete_pending(target.remote_target_id)
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?
        {
            return Err(RemoteRuntimeError::CredentialRevoked);
        }
        let verified = self.host_keys.verify(target, generation).await?;
        let reference = CredentialReference::for_target(target.remote_target_id);
        let lease = self
            .credentials
            .acquire(&reference, target.remote_target_id, generation)
            .await?;
        if lease.target_id() != target.remote_target_id || lease.generation() != generation {
            return Err(RemoteRuntimeError::CredentialRevoked);
        }
        SshLaunchPlan::new(
            self.ssh.clone(),
            &self.known_hosts(target.remote_target_id)?,
            lease,
            &verified,
            operation,
        )
    }

    async fn target_guard(&self, target_id: Uuid) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.target_locks.lock().await;
            Arc::clone(
                locks
                    .entry(target_id)
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        lock.lock_owned().await
    }

    fn ensure_target_active(&self, target_id: Uuid) -> Result<(), CommandError> {
        if self
            .store
            .remote_target_delete_pending(target_id)
            .map_err(storage_error)?
        {
            return Err(CommandError::new(
                "target_cleanup_pending",
                "The remote target is fenced while secure cleanup completes",
            ));
        }
        Ok(())
    }
}

#[allow(clippy::too_many_lines)]
async fn automatic_reconnect(
    runtime: RemoteSessionControlRuntime,
    session_id: Uuid,
    exited_generation: u64,
) {
    let Some(initial) = runtime.store.load_remote_session(session_id).ok().flatten() else {
        return;
    };
    if initial.state != RemoteSessionStateRecord::Reconnecting
        || initial.attempt_generation != exited_generation
    {
        return;
    }
    let policy = agent_workspace_protocol::RemoteReconnectPolicy {
        max_attempts: initial.reconnect_max_attempts,
        initial_delay_ms: initial.reconnect_initial_delay_ms,
        max_delay_ms: initial.reconnect_max_delay_ms,
    };
    for attempt in 1..=policy.max_attempts {
        let Some(before_timer) = runtime.store.load_remote_session(session_id).ok().flatten()
        else {
            return;
        };
        if before_timer.state != RemoteSessionStateRecord::Reconnecting {
            return;
        }
        let jitter = u16::try_from(
            (session_id.as_u128() ^ u128::from(before_timer.attempt_generation)) % 1001,
        )
        .unwrap_or(0);
        let Ok(delay) = reconnect_delay(&policy, attempt, jitter) else {
            return;
        };
        tokio::time::sleep(delay).await;
        let Some(current) = runtime.store.load_remote_session(session_id).ok().flatten() else {
            return;
        };
        if current.state != RemoteSessionStateRecord::Reconnecting
            || current.revision != before_timer.revision
            || current.attempt_generation != before_timer.attempt_generation
        {
            return;
        }
        if !runtime
            .store
            .begin_remote_reconnect_attempt(
                session_id,
                current.revision,
                current.attempt_generation,
                now_ms(),
            )
            .unwrap_or(false)
        {
            return;
        }
        let Some(session) = runtime.store.load_remote_session(session_id).ok().flatten() else {
            return;
        };
        let Some(target) = runtime
            .store
            .load_remote_target(session.remote_target_id)
            .ok()
            .flatten()
        else {
            return;
        };
        let _target_guard = runtime.target_guard(target.remote_target_id).await;
        if runtime
            .ensure_target_active(target.remote_target_id)
            .is_err()
        {
            return;
        }
        let launch = launch_stored_session(&runtime, &target, &session).await;
        match launch {
            Ok((terminal_id, credential_lease)) => {
                if !register_live_transport(
                    &runtime,
                    session_id,
                    session.attempt_generation,
                    terminal_id,
                    credential_lease,
                )
                .await
                {
                    if attempt == policy.max_attempts {
                        let _ = runtime.store.transition_remote_session(
                            session_id,
                            session.revision,
                            session.attempt_generation,
                            RemoteSessionStateRecord::Failed,
                            "lost",
                            now_ms(),
                        );
                        return;
                    }
                    continue;
                }
                if runtime
                    .store
                    .transition_remote_session(
                        session_id,
                        session.revision,
                        session.attempt_generation,
                        RemoteSessionStateRecord::Connected,
                        "lastVerified",
                        now_ms(),
                    )
                    .unwrap_or(false)
                {
                    return;
                }
                if let Some(live) =
                    take_live_generation(&runtime, session_id, session.attempt_generation).await
                {
                    let _ = runtime.executor.terminate(live.terminal_id).await;
                }
                return;
            }
            Err(error) if attempt == policy.max_attempts => {
                record_host_key_mismatch(&runtime, &target, &error);
                let _ = runtime.store.transition_remote_session(
                    session_id,
                    session.revision,
                    session.attempt_generation,
                    RemoteSessionStateRecord::Failed,
                    "lost",
                    now_ms(),
                );
                return;
            }
            Err(error) => {
                record_host_key_mismatch(&runtime, &target, &error);
            }
        }
    }
}

async fn take_live_generation(
    runtime: &RemoteSessionControlRuntime,
    session_id: Uuid,
    generation: u64,
) -> Option<LiveTransport> {
    let mut live = runtime.live.lock().await;
    (live.get(&session_id).map(|value| value.generation) == Some(generation))
        .then(|| live.remove(&session_id))
        .flatten()
}

async fn register_live_transport(
    runtime: &RemoteSessionControlRuntime,
    session_id: Uuid,
    generation: u64,
    terminal_id: RuntimeSessionId,
    credential_lease: CredentialBrokerLease,
) -> bool {
    if !remote_attempt_is_current(runtime, session_id, generation) {
        let _ = runtime.executor.terminate(terminal_id).await;
        return false;
    }
    runtime.live.lock().await.insert(
        session_id,
        LiveTransport {
            generation,
            terminal_id: terminal_id.clone(),
            _credential_lease: credential_lease,
        },
    );
    let executor_live = runtime.executor.is_live(&terminal_id);
    let attempt_current = remote_attempt_is_current(runtime, session_id, generation);
    if executor_live && attempt_current {
        true
    } else {
        if let Some(transport) = take_live_generation(runtime, session_id, generation).await {
            let _ = runtime.executor.terminate(transport.terminal_id).await;
        }
        false
    }
}

fn remote_attempt_is_current(
    runtime: &RemoteSessionControlRuntime,
    session_id: Uuid,
    generation: u64,
) -> bool {
    runtime
        .store
        .load_remote_session(session_id)
        .ok()
        .flatten()
        .is_some_and(|session| {
            session.attempt_generation == generation
                && matches!(
                    session.state,
                    RemoteSessionStateRecord::Connecting
                        | RemoteSessionStateRecord::Connected
                        | RemoteSessionStateRecord::Reconnecting
                )
        })
}

async fn reconcile_live_transport_fences(runtime: &RemoteSessionControlRuntime) {
    let stale = {
        let live = runtime.live.lock().await;
        live.iter()
            .filter_map(|(session_id, transport)| {
                (!remote_attempt_is_current(runtime, *session_id, transport.generation))
                    .then_some((*session_id, transport.generation))
            })
            .collect::<Vec<_>>()
    };
    for (session_id, generation) in stale {
        if let Some(transport) = take_live_generation(runtime, session_id, generation).await {
            // Dropping the live entry revokes the attempt-scoped signing lease before termination.
            let _ = runtime.executor.terminate(transport.terminal_id).await;
        }
    }
}

async fn launch_stored_session(
    runtime: &RemoteSessionControlRuntime,
    target: &RemoteTargetRecord,
    session: &RemoteSessionRecord,
) -> Result<(RuntimeSessionId, CredentialBrokerLease), RemoteRuntimeError> {
    let version_plan = runtime
        .launch_plan(
            target,
            session.attempt_generation,
            &TmuxOperation::DiscoverVersion,
        )
        .await?;
    let version = runtime.executor.discover(version_plan).await?;
    agent_workspace_terminal_runtime::remote::parse_tmux_version(&version)?;
    let operation = session
        .tmux_name
        .as_ref()
        .map(|name| TmuxOperation::Attach(name.clone()))
        .ok_or(RemoteRuntimeError::InvalidTarget)?;
    let plan = runtime
        .launch_plan(target, session.attempt_generation, &operation)
        .await?;
    runtime.executor.launch(plan).await
}

fn record_host_key_mismatch(
    runtime: &RemoteSessionControlRuntime,
    target: &RemoteTargetRecord,
    error: &RemoteRuntimeError,
) {
    if *error == RemoteRuntimeError::HostKeyMismatch {
        let _ = runtime.store.mark_remote_target_host_key_changed(
            target.remote_target_id,
            target.revision,
            now_ms(),
        );
    }
}

pub(super) fn is_command(command: &str) -> bool {
    COMMANDS.contains(&command)
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> ResponseEnvelope {
    match dispatch_inner(command, params, runtime).await {
        Ok(value) => ResponseEnvelope::success(id, value),
        Err(error) => ResponseEnvelope::failure(id, error.code, error.message),
    }
}

#[derive(Debug)]
struct CommandError {
    code: &'static str,
    message: &'static str,
}
impl CommandError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[allow(clippy::too_many_lines)]
async fn dispatch_inner(
    command: &str,
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    match command {
        "remote.target.list" => {
            let params: RemoteListParams = parse(params)?;
            let (targets, next_cursor) = runtime
                .store
                .list_remote_targets(optional_uuid(params.cursor.as_deref())?, params.limit)
                .map_err(storage_error)?;
            encode(RemoteTargetListResult {
                targets: targets.iter().map(target_snapshot).collect(),
                next_cursor: next_cursor.map(|id| id.to_string()),
            })
        }
        "remote.target.get" => {
            let params: RemoteTargetIdParams = parse(params)?;
            let target = runtime
                .store
                .load_remote_target(uuid(&params.remote_target_id)?)
                .map_err(storage_error)?
                .ok_or_else(target_not_found)?;
            encode(RemoteTargetResult {
                target: target_snapshot(&target),
            })
        }
        "remote.target.create" => create_target(params, runtime),
        "remote.target.delete" => delete_target(params, runtime).await,
        "remote.session.list" => {
            let params: RemoteListParams = parse(params)?;
            let (sessions, next_cursor) = runtime
                .store
                .list_remote_sessions(optional_uuid(params.cursor.as_deref())?, params.limit)
                .map_err(storage_error)?;
            encode(RemoteSessionListResult {
                sessions: sessions.iter().map(session_snapshot).collect(),
                next_cursor: next_cursor.map(|id| id.to_string()),
            })
        }
        "remote.session.get" => {
            let params: RemoteSessionIdParams = parse(params)?;
            encode(RemoteSessionResult {
                session: load_session(runtime, uuid(&params.remote_session_id)?)?,
            })
        }
        "remote.session.connect" => connect(params, runtime).await,
        "remote.hostKey.scan" => scan_host_key(params, runtime).await,
        "remote.hostKey.decide" => decide_host_key(params, runtime).await,
        "remote.session.detach" => detach(params, runtime).await,
        "remote.session.reconnect" => reconnect(params, runtime).await,
        "remote.session.close" => close(params, runtime).await,
        "remote.tmux.discover" => discover_tmux(params, runtime).await,
        _ => Err(CommandError::new(
            "unknown_command",
            "Unknown remote command",
        )),
    }
}

fn create_target(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteTargetCreateParams = parse(params)?;
    if params.mutation.expected_revision != 0 {
        return Err(stale_revision());
    }
    let record = RemoteTargetRecord {
        remote_target_id: uuid(&params.remote_target_id)?,
        label: params.label,
        host: params.host,
        port: params.port,
        user: params.user,
        host_key_state: "untrusted".into(),
        known_hosts_version: 1,
        revision: 1,
        idempotency_key: uuid(&params.mutation.idempotency_key)?,
        request_hash: params.mutation.request_hash,
        created_at_ms: now_ms(),
    };
    let result = encode(RemoteTargetResult {
        target: target_snapshot(&record),
    })?;
    let result_json = serde_json::to_string(&result).map_err(|_| internal_error())?;
    exact(
        runtime
            .store
            .create_remote_target_exact(&record, &result_json)
            .map_err(storage_error)?,
        result,
    )
}

async fn delete_target(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteTargetDeleteParams = parse(params)?;
    let target_id = uuid(&params.remote_target_id)?;
    let _target_guard = runtime.target_guard(target_id).await;
    let key = uuid(&params.mutation.idempotency_key)?;
    let target = runtime
        .store
        .load_remote_target(target_id)
        .map_err(storage_error)?;
    let Some(target) = target else {
        return exact(
            runtime
                .store
                .load_remote_mutation_result(
                    "remote.target.delete",
                    key,
                    &params.mutation.request_hash,
                )
                .map_err(storage_error)?,
            serde_json::json!({}),
        );
    };
    let result = encode(RemoteTargetResult {
        target: target_snapshot(&target),
    })?;
    let result_json = serde_json::to_string(&result).map_err(|_| internal_error())?;
    match runtime
        .store
        .begin_remote_target_delete_exact(
            target_id,
            params.mutation.expected_revision,
            key,
            &params.mutation.request_hash,
            &result_json,
            now_ms(),
        )
        .map_err(storage_error)?
    {
        RemoteMutationOutcome::Replay(stored) => return decode_stored_result(&stored),
        RemoteMutationOutcome::Applied => {}
        other => return exact(other, result),
    }

    let session_ids = runtime
        .store
        .remote_session_ids_for_target(target_id)
        .map_err(storage_error)?;
    for session_id in session_ids {
        if let Some(live) = runtime.live.lock().await.remove(&session_id) {
            // Removing the entry drops and revokes its attempt-scoped credential lease first.
            let _ = runtime.executor.terminate(live.terminal_id).await;
        }
    }
    runtime
        .host_keys
        .remove_target(target_id)
        .await
        .map_err(target_cleanup_error)?;
    runtime
        .credential_cleanup
        .remove_target(target_id)
        .await
        .map_err(target_cleanup_error)?;

    match runtime
        .store
        .finish_remote_target_delete_exact(target_id, key, &params.mutation.request_hash, now_ms())
        .map_err(storage_error)?
    {
        RemoteMutationOutcome::Replay(stored) => decode_stored_result(&stored),
        RemoteMutationOutcome::InvalidState => Err(target_cleanup_error(
            RemoteRuntimeError::CredentialProviderUnavailable,
        )),
        other => exact(other, result),
    }
}

#[allow(clippy::too_many_lines)]
async fn connect(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteSessionConnectParams = parse(params)?;
    if params.mutation.expected_revision != 0 {
        return Err(stale_revision());
    }
    let target_id = uuid(&params.remote_target_id)?;
    let _target_guard = runtime.target_guard(target_id).await;
    runtime.ensure_target_active(target_id)?;
    let target = runtime
        .store
        .load_remote_target(target_id)
        .map_err(storage_error)?
        .ok_or_else(target_not_found)?;
    if params.tmux.is_none() {
        return Err(CommandError::new(
            "invalid_state",
            "A closed tmux attach or create operation is required",
        ));
    }
    let state = match target.host_key_state.as_str() {
        "untrusted" | "changed" | "revoked" => RemoteSessionStateRecord::TrustRequired,
        "trusted" => RemoteSessionStateRecord::Connecting,
        _ => return Err(internal_error()),
    };
    let record = RemoteSessionRecord {
        remote_session_id: uuid(&params.remote_session_id)?,
        remote_target_id: target_id,
        workspace_id: uuid(&params.workspace_id)?,
        pane_id: uuid(&params.pane_id)?,
        tab_id: uuid(&params.tab_id)?,
        tmux_mode: params
            .tmux
            .as_ref()
            .map(|value| tmux_mode(value.mode).to_owned()),
        tmux_name: params.tmux.as_ref().map(|value| value.session_name.clone()),
        state,
        observation: "unknown".into(),
        attempt_generation: 1,
        reconnect_max_attempts: params.reconnect.max_attempts,
        reconnect_initial_delay_ms: params.reconnect.initial_delay_ms,
        reconnect_max_delay_ms: params.reconnect.max_delay_ms,
        revision: 1,
        idempotency_key: uuid(&params.mutation.idempotency_key)?,
        request_hash: params.mutation.request_hash,
        created_at_ms: now_ms(),
    };
    let preflight_error = match target.host_key_state.as_str() {
        "untrusted" => Some(CommandError::new(
            "host_key_trust_required",
            "Exact first-contact host-key confirmation is required",
        )),
        "changed" | "revoked" => Some(CommandError::new(
            "host_key_replacement_required",
            "Exact replacement host-key confirmation is required",
        )),
        _ => None,
    };
    let initial_result = preflight_error
        .as_ref()
        .map_or_else(pending_result, stored_error);
    match runtime
        .store
        .create_remote_session_exact(
            &record,
            &serde_json::to_string(&initial_result).map_err(|_| internal_error())?,
        )
        .map_err(storage_error)?
    {
        RemoteMutationOutcome::Replay(result) => return decode_stored_result(&result),
        RemoteMutationOutcome::Applied => {}
        other => return exact(other, initial_result),
    }
    if let Some(error) = preflight_error {
        return Err(error);
    }
    let tmux = params.tmux.as_ref().expect("tmux was required above");
    let launch = async {
        let version_plan = runtime
            .launch_plan(&target, 1, &TmuxOperation::DiscoverVersion)
            .await?;
        let version = runtime.executor.discover(version_plan).await?;
        agent_workspace_terminal_runtime::remote::parse_tmux_version(&version)?;
        let operation = TmuxOperation::try_from(tmux)?;
        let plan = runtime.launch_plan(&target, 1, &operation).await?;
        runtime.executor.launch(plan).await
    }
    .await;
    let (terminal_id, credential_lease) = match launch {
        Ok(transport) => transport,
        Err(error) => {
            record_host_key_mismatch(runtime, &target, &error);
            let command_error = runtime_error(error);
            let stored = serde_json::to_string(&stored_error(&command_error))
                .map_err(|_| internal_error())?;
            let _ = runtime
                .store
                .complete_remote_session_attempt(
                    "remote.session.connect",
                    record.remote_session_id,
                    1,
                    1,
                    RemoteSessionStateRecord::Failed,
                    "unknown",
                    record.idempotency_key,
                    &record.request_hash,
                    &stored,
                    now_ms(),
                )
                .map_err(storage_error)?;
            return Err(command_error);
        }
    };
    if !register_live_transport(
        runtime,
        record.remote_session_id,
        1,
        terminal_id,
        credential_lease,
    )
    .await
    {
        let command_error = runtime_error(RemoteRuntimeError::TransportUnavailable);
        let _ = runtime
            .store
            .complete_remote_session_attempt(
                "remote.session.connect",
                record.remote_session_id,
                1,
                1,
                RemoteSessionStateRecord::Failed,
                "unknown",
                record.idempotency_key,
                &record.request_hash,
                &serde_json::to_string(&stored_error(&command_error))
                    .map_err(|_| internal_error())?,
                now_ms(),
            )
            .map_err(storage_error)?;
        return Err(command_error);
    }
    let connected = RemoteSessionRecord {
        state: RemoteSessionStateRecord::Connected,
        observation: "lastVerified".into(),
        revision: 2,
        ..record.clone()
    };
    let result = encode(RemoteSessionResult {
        session: session_snapshot(&connected),
    })?;
    let completed = runtime
        .store
        .complete_remote_session_attempt(
            "remote.session.connect",
            record.remote_session_id,
            1,
            1,
            RemoteSessionStateRecord::Connected,
            "lastVerified",
            record.idempotency_key,
            &record.request_hash,
            &serde_json::to_string(&result).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?;
    if !completed {
        if let Some(live) = take_live_generation(runtime, record.remote_session_id, 1).await {
            let _ = runtime.executor.terminate(live.terminal_id).await;
        }
        return Err(stale_revision());
    }
    Ok(result)
}

async fn scan_host_key(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteHostKeyScanParams = parse(params)?;
    let session_id = uuid(&params.remote_session_id)?;
    let initial = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    let _target_guard = runtime.target_guard(initial.remote_target_id).await;
    runtime.ensure_target_active(initial.remote_target_id)?;
    let session = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    if session.remote_target_id != initial.remote_target_id {
        return Err(stale_revision());
    }
    if session.state != RemoteSessionStateRecord::TrustRequired {
        return Err(CommandError::new(
            "invalid_state",
            "The remote session does not require first-contact trust",
        ));
    }
    let target = runtime
        .store
        .load_remote_target(session.remote_target_id)
        .map_err(storage_error)?
        .ok_or_else(target_not_found)?;
    let key = uuid(&params.mutation.idempotency_key)?;
    match runtime
        .store
        .reserve_remote_session_operation(
            "remote.hostKey.scan",
            session_id,
            params.mutation.expected_revision,
            key,
            &params.mutation.request_hash,
            &serde_json::to_string(&pending_result()).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?
    {
        RemoteMutationOutcome::Applied => {}
        RemoteMutationOutcome::Replay(value) => return decode_stored_result(&value),
        other => return exact(other, pending_result()),
    }
    let result = match runtime
        .host_keys
        .challenge(&target, session_id, session.attempt_generation)
        .await
    {
        Ok(challenge) => encode(challenge)?,
        Err(error) => {
            record_host_key_mismatch(runtime, &target, &error);
            let command_error = runtime_error(error);
            let _ = runtime
                .store
                .complete_remote_operation_result(
                    "remote.hostKey.scan",
                    key,
                    &params.mutation.request_hash,
                    &serde_json::to_string(&stored_error(&command_error))
                        .map_err(|_| internal_error())?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            return Err(command_error);
        }
    };
    if !runtime
        .store
        .complete_remote_operation_result(
            "remote.hostKey.scan",
            key,
            &params.mutation.request_hash,
            &serde_json::to_string(&result).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?
    {
        return Err(stale_revision());
    }
    Ok(result)
}

#[allow(clippy::too_many_lines)]
async fn decide_host_key(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteHostKeyTrustParams = parse(params)?;
    let session_id = uuid(&params.remote_session_id)?;
    let initial = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    let _target_guard = runtime.target_guard(initial.remote_target_id).await;
    runtime.ensure_target_active(initial.remote_target_id)?;
    let session = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    if session.remote_target_id != initial.remote_target_id {
        return Err(stale_revision());
    }
    if session.state != RemoteSessionStateRecord::TrustRequired
        || session.attempt_generation != params.attempt_generation
    {
        return Err(stale_revision());
    }
    let target = runtime
        .store
        .load_remote_target(session.remote_target_id)
        .map_err(storage_error)?
        .ok_or_else(target_not_found)?;
    let key = uuid(&params.mutation.idempotency_key)?;
    match runtime
        .store
        .reserve_remote_target_operation(
            "remote.hostKey.decide",
            target.remote_target_id,
            params.mutation.expected_revision,
            key,
            &params.mutation.request_hash,
            &serde_json::to_string(&pending_result()).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?
    {
        RemoteMutationOutcome::Applied => {}
        RemoteMutationOutcome::Replay(value) => return decode_stored_result(&value),
        other => return exact(other, pending_result()),
    }
    if let Err(error) = runtime
        .host_keys
        .decide(
            &target,
            session_id,
            uuid(&params.prompt_id)?,
            params.attempt_generation,
            &params.presented_fingerprint,
            params.decision,
        )
        .await
    {
        let command_error = runtime_error(error);
        let _ = runtime
            .store
            .complete_remote_operation_result(
                "remote.hostKey.decide",
                key,
                &params.mutation.request_hash,
                &serde_json::to_string(&stored_error(&command_error))
                    .map_err(|_| internal_error())?,
                now_ms(),
            )
            .map_err(storage_error)?;
        return Err(command_error);
    }
    let next_state = match params.decision {
        RemoteHostKeyDecision::Trust => "trusted",
        RemoteHostKeyDecision::Reject => target.host_key_state.as_str(),
    };
    let next_known_hosts_version =
        target.known_hosts_version + u64::from(params.decision == RemoteHostKeyDecision::Trust);
    let next = RemoteTargetRecord {
        host_key_state: next_state.into(),
        known_hosts_version: next_known_hosts_version,
        revision: target.revision + 1,
        ..target.clone()
    };
    let result = encode(RemoteSessionResult {
        session: session_snapshot(&session),
    })?;
    exact(
        runtime
            .store
            .mutate_remote_target_trust_exact(
                target.remote_target_id,
                params.mutation.expected_revision,
                next_state,
                next.known_hosts_version,
                uuid(&params.mutation.idempotency_key)?,
                &params.mutation.request_hash,
                &serde_json::to_string(&result).map_err(|_| internal_error())?,
                now_ms(),
            )
            .map_err(storage_error)?,
        result,
    )
}

async fn detach(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteSessionDetachParams = parse(params)?;
    lifecycle_mutation(
        "remote.session.detach",
        params.remote_session_id,
        params.mutation,
        RemoteSessionStateRecord::Detached,
        false,
        runtime,
    )
    .await
}
#[allow(clippy::too_many_lines)]
async fn reconnect(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteSessionReconnectParams = parse(params)?;
    let session_id = uuid(&params.remote_session_id)?;
    let current = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    let _target_guard = runtime.target_guard(current.remote_target_id).await;
    runtime.ensure_target_active(current.remote_target_id)?;
    let connecting = RemoteSessionRecord {
        state: RemoteSessionStateRecord::Connecting,
        revision: current.revision + 1,
        attempt_generation: current.attempt_generation + 1,
        observation: "unknown".into(),
        ..current.clone()
    };
    let outcome = runtime
        .store
        .mutate_remote_session_exact(
            "remote.session.reconnect",
            session_id,
            params.mutation.expected_revision,
            current.attempt_generation,
            RemoteSessionStateRecord::Connecting,
            "unknown",
            true,
            uuid(&params.mutation.idempotency_key)?,
            &params.mutation.request_hash,
            &serde_json::to_string(&pending_result()).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?;
    match outcome {
        RemoteMutationOutcome::Applied => {}
        RemoteMutationOutcome::Replay(value) => return decode_stored_result(&value),
        other => return exact(other, pending_result()),
    }
    let session = connecting;
    let target = runtime
        .store
        .load_remote_target(session.remote_target_id)
        .map_err(storage_error)?
        .ok_or_else(target_not_found)?;
    let launch = async {
        let version_plan = runtime
            .launch_plan(
                &target,
                session.attempt_generation,
                &TmuxOperation::DiscoverVersion,
            )
            .await?;
        let version = runtime.executor.discover(version_plan).await?;
        agent_workspace_terminal_runtime::remote::parse_tmux_version(&version)?;
        let operation = session
            .tmux_name
            .as_ref()
            .map(|name| TmuxOperation::Attach(name.clone()))
            .ok_or(RemoteRuntimeError::InvalidTarget)?;
        let plan = runtime
            .launch_plan(&target, session.attempt_generation, &operation)
            .await?;
        runtime.executor.launch(plan).await
    }
    .await;
    let (terminal_id, credential_lease) = match launch {
        Ok(value) => value,
        Err(error) => {
            record_host_key_mismatch(runtime, &target, &error);
            let command_error = runtime_error(error);
            let _ = runtime
                .store
                .complete_remote_session_attempt(
                    "remote.session.reconnect",
                    session_id,
                    session.revision,
                    session.attempt_generation,
                    RemoteSessionStateRecord::Failed,
                    "unknown",
                    uuid(&params.mutation.idempotency_key)?,
                    &params.mutation.request_hash,
                    &serde_json::to_string(&stored_error(&command_error))
                        .map_err(|_| internal_error())?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            return Err(command_error);
        }
    };
    if !register_live_transport(
        runtime,
        session_id,
        session.attempt_generation,
        terminal_id,
        credential_lease,
    )
    .await
    {
        let command_error = runtime_error(RemoteRuntimeError::TransportUnavailable);
        let _ = runtime
            .store
            .complete_remote_session_attempt(
                "remote.session.reconnect",
                session_id,
                session.revision,
                session.attempt_generation,
                RemoteSessionStateRecord::Failed,
                "unknown",
                uuid(&params.mutation.idempotency_key)?,
                &params.mutation.request_hash,
                &serde_json::to_string(&stored_error(&command_error))
                    .map_err(|_| internal_error())?,
                now_ms(),
            )
            .map_err(storage_error)?;
        return Err(command_error);
    }
    let connected = RemoteSessionRecord {
        state: RemoteSessionStateRecord::Connected,
        observation: "lastVerified".into(),
        revision: session.revision + 1,
        ..session.clone()
    };
    let result = encode(RemoteSessionResult {
        session: session_snapshot(&connected),
    })?;
    let completed = runtime
        .store
        .complete_remote_session_attempt(
            "remote.session.reconnect",
            session_id,
            session.revision,
            session.attempt_generation,
            RemoteSessionStateRecord::Connected,
            "lastVerified",
            uuid(&params.mutation.idempotency_key)?,
            &params.mutation.request_hash,
            &serde_json::to_string(&result).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?;
    if !completed {
        if let Some(live) =
            take_live_generation(runtime, session_id, session.attempt_generation).await
        {
            let _ = runtime.executor.terminate(live.terminal_id).await;
        }
        return Err(stale_revision());
    }
    Ok(result)
}
async fn close(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteSessionCloseParams = parse(params)?;
    lifecycle_mutation(
        "remote.session.close",
        params.remote_session_id,
        params.mutation,
        RemoteSessionStateRecord::Closed,
        false,
        runtime,
    )
    .await
}

async fn lifecycle_mutation(
    namespace: &str,
    id: String,
    mutation: agent_workspace_protocol::RemoteMutationIdentity,
    next: RemoteSessionStateRecord,
    increment_generation: bool,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let id = uuid(&id)?;
    let initial = runtime
        .store
        .load_remote_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    let _target_guard = runtime.target_guard(initial.remote_target_id).await;
    runtime.ensure_target_active(initial.remote_target_id)?;
    let current = runtime
        .store
        .load_remote_session(id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    if current.remote_target_id != initial.remote_target_id {
        return Err(stale_revision());
    }
    let projected = RemoteSessionRecord {
        state: next,
        revision: current.revision + 1,
        attempt_generation: current.attempt_generation + u64::from(increment_generation),
        observation: "unknown".into(),
        ..current.clone()
    };
    let result = encode(RemoteSessionResult {
        session: session_snapshot(&projected),
    })?;
    let outcome = runtime
        .store
        .mutate_remote_session_exact(
            namespace,
            id,
            mutation.expected_revision,
            current.attempt_generation,
            next,
            "unknown",
            increment_generation,
            uuid(&mutation.idempotency_key)?,
            &mutation.request_hash,
            &serde_json::to_string(&result).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?;
    let applied = matches!(outcome, RemoteMutationOutcome::Applied);
    let value = exact(outcome, result)?;
    if applied
        && matches!(
            next,
            RemoteSessionStateRecord::Detached | RemoteSessionStateRecord::Closed
        )
        && let Some(live) = take_live_generation(runtime, id, current.attempt_generation).await
    {
        let _ = runtime.executor.terminate(live.terminal_id).await;
    }
    Ok(value)
}

async fn discover_tmux(
    params: Value,
    runtime: &RemoteSessionControlRuntime,
) -> Result<Value, CommandError> {
    let params: RemoteTmuxDiscoverParams = parse(params)?;
    let session_id = uuid(&params.remote_session_id)?;
    let initial = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    let _target_guard = runtime.target_guard(initial.remote_target_id).await;
    runtime.ensure_target_active(initial.remote_target_id)?;
    let session = runtime
        .store
        .load_remote_session(session_id)
        .map_err(storage_error)?
        .ok_or_else(session_not_found)?;
    if session.remote_target_id != initial.remote_target_id {
        return Err(stale_revision());
    }
    let target = runtime
        .store
        .load_remote_target(session.remote_target_id)
        .map_err(storage_error)?
        .ok_or_else(target_not_found)?;
    let key = uuid(&params.mutation.idempotency_key)?;
    match runtime
        .store
        .reserve_remote_session_operation(
            "remote.tmux.discover",
            session_id,
            params.mutation.expected_revision,
            key,
            &params.mutation.request_hash,
            &serde_json::to_string(&pending_result()).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?
    {
        RemoteMutationOutcome::Applied => {}
        RemoteMutationOutcome::Replay(value) => return decode_stored_result(&value),
        other => return exact(other, pending_result()),
    }
    let execution = async {
        let version_plan = runtime
            .launch_plan(
                &target,
                session.attempt_generation,
                &TmuxOperation::DiscoverVersion,
            )
            .await?;
        let version = runtime.executor.discover(version_plan).await?;
        agent_workspace_terminal_runtime::remote::parse_tmux_version(&version)?;
        let plan = runtime
            .launch_plan(
                &target,
                session.attempt_generation,
                &TmuxOperation::DiscoverSessions,
            )
            .await?;
        let output = runtime.executor.discover(plan).await?;
        parse_tmux_sessions(&output)
    }
    .await;
    let result = match execution {
        Ok(sessions) => encode(RemoteTmuxDiscoveryResult { sessions })?,
        Err(error) => {
            record_host_key_mismatch(runtime, &target, &error);
            let command_error = runtime_error(error);
            let _ = runtime
                .store
                .complete_remote_operation_result(
                    "remote.tmux.discover",
                    key,
                    &params.mutation.request_hash,
                    &serde_json::to_string(&stored_error(&command_error))
                        .map_err(|_| internal_error())?,
                    now_ms(),
                )
                .map_err(storage_error)?;
            return Err(command_error);
        }
    };
    if !runtime
        .store
        .complete_remote_operation_result(
            "remote.tmux.discover",
            key,
            &params.mutation.request_hash,
            &serde_json::to_string(&result).map_err(|_| internal_error())?,
            now_ms(),
        )
        .map_err(storage_error)?
    {
        return Err(stale_revision());
    }
    Ok(result)
}

fn exact(outcome: RemoteMutationOutcome, applied: Value) -> Result<Value, CommandError> {
    match outcome {
        RemoteMutationOutcome::Applied => Ok(applied),
        RemoteMutationOutcome::Replay(value) => decode_stored_result(&value),
        RemoteMutationOutcome::Conflict => Err(CommandError::new(
            "idempotency_conflict",
            "The idempotency key was used for a different request",
        )),
        RemoteMutationOutcome::NotFound => Err(CommandError::new(
            "target_not_found",
            "The requested remote object does not exist",
        )),
        RemoteMutationOutcome::StaleRevision => Err(stale_revision()),
        RemoteMutationOutcome::ResourceLimit => Err(CommandError::new(
            "resource_limit",
            "The remote catalog reached its bound",
        )),
        RemoteMutationOutcome::InvalidState => Err(CommandError::new(
            "invalid_state",
            "The remote mutation is not valid in the current state",
        )),
    }
}

fn pending_result() -> Value {
    serde_json::json!({ "remoteOperation": "pending" })
}
fn stored_error(error: &CommandError) -> Value {
    serde_json::json!({ "remoteError": { "code": error.code, "message": error.message } })
}
fn decode_stored_result(value: &str) -> Result<Value, CommandError> {
    let value: Value = serde_json::from_str(value).map_err(|_| internal_error())?;
    if value.get("remoteOperation").and_then(Value::as_str) == Some("pending") {
        return Err(CommandError::new(
            "operation_pending",
            "The durable remote operation is still pending",
        ));
    }
    if let Some(error) = value.get("remoteError") {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("runtime_unavailable");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The remote operation failed");
        return Err(CommandError::new(
            stable_error_code(code),
            stable_error_message(code, message),
        ));
    }
    Ok(value)
}
fn stable_error_code(value: &str) -> &'static str {
    match value {
        "host_key_trust_required" => "host_key_trust_required",
        "host_key_replacement_required" => "host_key_replacement_required",
        "host_key_mismatch" => "host_key_mismatch",
        "credential_required" => "credential_required",
        "provider_unavailable" => "provider_unavailable",
        "credential_revoked" => "credential_revoked",
        "tmux_unsupported" => "tmux_unsupported",
        "resource_limit" => "resource_limit",
        _ => "runtime_unavailable",
    }
}
fn stable_error_message(code: &str, _fallback: &str) -> &'static str {
    match code {
        "host_key_trust_required" => "Exact first-contact host-key confirmation is required",
        "host_key_replacement_required" => "Exact replacement host-key confirmation is required",
        "host_key_mismatch" => "The host key changed or was revoked",
        "credential_required" => "A trusted public-key credential is required",
        "provider_unavailable" => "The trusted credential or host-key provider is unavailable",
        "credential_revoked" => "The attempt credential was revoked",
        "tmux_unsupported" => "tmux 3.2 or newer is required",
        "resource_limit" => "The bounded remote resource limit was reached",
        _ => "The remote runtime could not complete the request",
    }
}

fn load_session(
    runtime: &RemoteSessionControlRuntime,
    id: Uuid,
) -> Result<RemoteSessionSnapshot, CommandError> {
    runtime
        .store
        .load_remote_session(id)
        .map_err(storage_error)?
        .as_ref()
        .map(session_snapshot)
        .ok_or_else(session_not_found)
}
fn target_snapshot(value: &RemoteTargetRecord) -> RemoteTargetSnapshot {
    RemoteTargetSnapshot {
        remote_target_id: value.remote_target_id.to_string(),
        label: value.label.clone(),
        host: value.host.clone(),
        port: value.port,
        user: value.user.clone(),
        authentication: RemoteAuthenticationMethod::PublicKey,
        host_key_state: match value.host_key_state.as_str() {
            "trusted" => RemoteHostKeyState::Trusted,
            "changed" => RemoteHostKeyState::Changed,
            "revoked" => RemoteHostKeyState::Revoked,
            _ => RemoteHostKeyState::Untrusted,
        },
        known_hosts_version: value.known_hosts_version,
        revision: value.revision,
    }
}
fn session_snapshot(value: &RemoteSessionRecord) -> RemoteSessionSnapshot {
    RemoteSessionSnapshot {
        remote_session_id: value.remote_session_id.to_string(),
        remote_target_id: value.remote_target_id.to_string(),
        workspace_id: value.workspace_id.to_string(),
        pane_id: value.pane_id.to_string(),
        tab_id: value.tab_id.to_string(),
        tmux: value.tmux_name.as_ref().map(|name| RemoteTmuxIdentity {
            mode: if value.tmux_mode.as_deref() == Some("create") {
                RemoteTmuxMode::Create
            } else {
                RemoteTmuxMode::Attach
            },
            session_name: name.clone(),
        }),
        state: session_state(value.state),
        observation: match value.observation.as_str() {
            "lastVerified" => RemoteObservationState::LastVerified,
            "lost" => RemoteObservationState::Lost,
            _ => RemoteObservationState::Unknown,
        },
        attempt_generation: value.attempt_generation,
        revision: value.revision,
        reconnect: agent_workspace_protocol::RemoteReconnectPolicy {
            max_attempts: value.reconnect_max_attempts,
            initial_delay_ms: value.reconnect_initial_delay_ms,
            max_delay_ms: value.reconnect_max_delay_ms,
        },
    }
}
const fn session_state(value: RemoteSessionStateRecord) -> RemoteSessionState {
    match value {
        RemoteSessionStateRecord::Created => RemoteSessionState::Created,
        RemoteSessionStateRecord::TrustRequired => RemoteSessionState::TrustRequired,
        RemoteSessionStateRecord::CredentialRequired => RemoteSessionState::CredentialRequired,
        RemoteSessionStateRecord::Connecting => RemoteSessionState::Connecting,
        RemoteSessionStateRecord::Connected => RemoteSessionState::Connected,
        RemoteSessionStateRecord::Reconnecting => RemoteSessionState::Reconnecting,
        RemoteSessionStateRecord::Detached => RemoteSessionState::Detached,
        RemoteSessionStateRecord::Failed => RemoteSessionState::Failed,
        RemoteSessionStateRecord::Closed => RemoteSessionState::Closed,
    }
}
const fn tmux_mode(value: RemoteTmuxMode) -> &'static str {
    match value {
        RemoteTmuxMode::Attach => "attach",
        RemoteTmuxMode::Create => "create",
    }
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T, CommandError> {
    serde_json::from_value(value)
        .map_err(|_| CommandError::new("invalid_params", "Invalid remote command parameters"))
}
fn encode<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value).map_err(|_| internal_error())
}
fn uuid(value: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(value).map_err(|_| CommandError::new("invalid_params", "Invalid remote UUID"))
}
fn optional_uuid(value: Option<&str>) -> Result<Option<Uuid>, CommandError> {
    value.map(uuid).transpose()
}
fn target_not_found() -> CommandError {
    CommandError::new("target_not_found", "The remote target does not exist")
}
fn session_not_found() -> CommandError {
    CommandError::new("session_not_found", "The remote session does not exist")
}
fn stale_revision() -> CommandError {
    CommandError::new("stale_revision", "The expected remote revision is stale")
}
fn internal_error() -> CommandError {
    CommandError::new(
        "runtime_unavailable",
        "The remote runtime could not complete the request",
    )
}
fn storage_error(_error: StorageError) -> CommandError {
    internal_error()
}
fn target_cleanup_error(_error: RemoteRuntimeError) -> CommandError {
    CommandError::new(
        "target_cleanup_failed",
        "The remote target is fenced, but secure credential cleanup must be retried",
    )
}
#[allow(clippy::needless_pass_by_value)]
fn runtime_error(error: RemoteRuntimeError) -> CommandError {
    match error {
        RemoteRuntimeError::HostKeyUntrusted => CommandError::new(
            "host_key_trust_required",
            "Exact first-contact host-key confirmation is required",
        ),
        RemoteRuntimeError::HostKeyMismatch => {
            CommandError::new("host_key_mismatch", "The host key changed or was revoked")
        }
        RemoteRuntimeError::CredentialRequired => CommandError::new(
            "credential_required",
            "A trusted public-key credential is required",
        ),
        RemoteRuntimeError::CredentialProviderUnavailable
        | RemoteRuntimeError::HostKeyScanUnavailable => CommandError::new(
            "provider_unavailable",
            "The trusted credential or host-key provider is unavailable",
        ),
        RemoteRuntimeError::HostKeyPromptCapacity => CommandError::new(
            "resource_limit",
            "The bounded host-key prompt authority is at capacity",
        ),
        RemoteRuntimeError::CredentialRevoked => {
            CommandError::new("credential_revoked", "The attempt credential was revoked")
        }
        RemoteRuntimeError::UnsupportedTmux => {
            CommandError::new("tmux_unsupported", "tmux 3.2 or newer is required")
        }
        _ => internal_error(),
    }
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| {
            i64::try_from(value.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(unix)]
fn prepare_private_directory(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(RemoteRuntimeError::UnsafeKnownHosts);
    }
    fs::create_dir_all(path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(RemoteRuntimeError::UnsafeKnownHosts);
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)
}
#[cfg(not(unix))]
fn prepare_private_directory(path: &Path) -> Result<(), RemoteRuntimeError> {
    fs::create_dir_all(path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)
}
#[cfg(unix)]
fn prepare_private_file(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(
            i32::try_from(rustix::fs::OFlags::NOFOLLOW.bits())
                .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?,
        )
        .open(path)
        .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    let metadata = file
        .metadata()
        .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.nlink() != 1
    {
        return Err(RemoteRuntimeError::UnsafeKnownHosts);
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use agent_workspace_core::ShortcutPlatform;
    use agent_workspace_terminal_runtime::{TerminalManager, remote::EphemeralAgentSocket};
    use tempfile::tempdir;

    #[derive(Clone)]
    struct NeverLiveExecutor;
    impl RemoteExecutor for NeverLiveExecutor {
        fn launch(
            &self,
            _plan: SshLaunchPlan,
        ) -> BoxFuture<Result<(RuntimeSessionId, CredentialBrokerLease), RemoteRuntimeError>>
        {
            Box::pin(async { Err(RemoteRuntimeError::TransportUnavailable) })
        }
        fn terminate(
            &self,
            _terminal_id: RuntimeSessionId,
        ) -> BoxFuture<Result<(), RemoteRuntimeError>> {
            Box::pin(async { Ok(()) })
        }
        fn is_live(&self, _terminal_id: &RuntimeSessionId) -> bool {
            false
        }
    }

    #[cfg(unix)]
    #[derive(Clone)]
    struct TestCredentialProvider {
        root: PathBuf,
        listeners: Arc<StdMutex<Vec<std::os::unix::net::UnixListener>>>,
    }

    #[cfg(unix)]
    #[async_trait::async_trait]
    impl CredentialProvider for TestCredentialProvider {
        async fn acquire(
            &self,
            _reference: &CredentialReference,
            target_id: Uuid,
            attempt_generation: u64,
        ) -> Result<CredentialBrokerLease, RemoteRuntimeError> {
            use std::os::unix::{fs::PermissionsExt as _, net::UnixListener};

            let path = self.root.join(format!(
                "{}-{attempt_generation}-{}.sock",
                target_id.simple(),
                Uuid::new_v4().simple()
            ));
            let listener = UnixListener::bind(&path)
                .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
            let socket = EphemeralAgentSocket::from_broker_path(path)?;
            self.listeners.lock().unwrap().push(listener);
            Ok(CredentialBrokerLease::new(
                target_id,
                attempt_generation,
                socket,
            ))
        }
    }

    #[derive(Clone, Copy)]
    struct TrustedHostKeyAuthority;

    #[async_trait::async_trait]
    impl HostKeyAuthority for TrustedHostKeyAuthority {
        async fn verify(
            &self,
            target: &RemoteTargetRecord,
            _attempt_generation: u64,
        ) -> Result<VerifiedRemoteTarget, RemoteRuntimeError> {
            VerifiedRemoteTarget::verify(
                target.host.clone(),
                target.port,
                target.user.clone(),
                target.known_hosts_version,
                RemoteHostKeyState::Trusted,
                "SHA256:fixture",
                "SHA256:fixture",
            )
        }
    }

    #[derive(Clone, Copy)]
    struct AcceptingHostKeyAuthority;

    #[async_trait::async_trait]
    impl HostKeyAuthority for AcceptingHostKeyAuthority {
        async fn verify(
            &self,
            _target: &RemoteTargetRecord,
            _attempt_generation: u64,
        ) -> Result<VerifiedRemoteTarget, RemoteRuntimeError> {
            Err(RemoteRuntimeError::HostKeyUntrusted)
        }

        async fn decide(
            &self,
            _target: &RemoteTargetRecord,
            _remote_session_id: Uuid,
            _prompt_id: Uuid,
            _attempt_generation: u64,
            _fingerprint: &str,
            _decision: RemoteHostKeyDecision,
        ) -> Result<(), RemoteRuntimeError> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct RecoveryExecutor {
        discoveries: Arc<AtomicUsize>,
        launches: Arc<StdMutex<Vec<String>>>,
        live: Arc<StdMutex<Vec<String>>>,
    }

    impl RemoteExecutor for RecoveryExecutor {
        fn launch(
            &self,
            plan: SshLaunchPlan,
        ) -> BoxFuture<Result<(RuntimeSessionId, CredentialBrokerLease), RemoteRuntimeError>>
        {
            let operation = plan.argv().last().cloned().unwrap_or_default();
            let launches = Arc::clone(&self.launches);
            let live = Arc::clone(&self.live);
            Box::pin(async move {
                launches.lock().unwrap().push(operation);
                let terminal_id = RuntimeSessionId::new("recovered-transport");
                live.lock().unwrap().push(terminal_id.as_str().to_owned());
                Ok((terminal_id, plan.into_lease()))
            })
        }

        fn terminate(
            &self,
            terminal_id: RuntimeSessionId,
        ) -> BoxFuture<Result<(), RemoteRuntimeError>> {
            let live = Arc::clone(&self.live);
            Box::pin(async move {
                live.lock().unwrap().retain(|id| id != terminal_id.as_str());
                Ok(())
            })
        }

        fn is_live(&self, terminal_id: &RuntimeSessionId) -> bool {
            self.live
                .lock()
                .unwrap()
                .iter()
                .any(|id| id == terminal_id.as_str())
        }

        fn discover(&self, _plan: SshLaunchPlan) -> BoxFuture<Result<Vec<u8>, RemoteRuntimeError>> {
            let attempt = self.discoveries.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if attempt == 0 {
                    Err(RemoteRuntimeError::TransportUnavailable)
                } else {
                    Ok(b"tmux 3.2\n".to_vec())
                }
            })
        }
    }

    fn runtime() -> (tempfile::TempDir, RemoteSessionControlRuntime) {
        let dir = tempdir().unwrap();
        let store = Arc::new(
            SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
                .unwrap(),
        );
        let backend = TerminalManagerBackend::new(TerminalManager::new());
        let runtime = RemoteSessionControlRuntime {
            store,
            ssh: PathBuf::from("/not-used"),
            known_hosts_root: dir.path().join("known-hosts"),
            credentials: Arc::new(UnavailableCredentialProvider),
            credential_cleanup: Arc::new(NoopCredentialCleanup),
            host_keys: Arc::new(UnavailableHostKeyAuthority),
            executor: Arc::new(ProductionExecutor(backend)),
            live: Arc::new(Mutex::new(HashMap::new())),
            target_locks: Arc::new(Mutex::new(HashMap::new())),
        };
        (dir, runtime)
    }

    #[cfg(unix)]
    fn recovery_runtime() -> (
        tempfile::TempDir,
        RemoteSessionControlRuntime,
        RecoveryExecutor,
        RemoteTargetRecord,
        RemoteSessionRecord,
    ) {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempdir().unwrap();
        let store = Arc::new(
            SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
                .unwrap(),
        );
        let known_hosts_root = dir.path().join("known-hosts");
        let credential_root = dir.path().join("credential-sockets");
        for root in [&known_hosts_root, &credential_root] {
            fs::create_dir(root).unwrap();
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let executor = RecoveryExecutor::default();
        let runtime = RemoteSessionControlRuntime {
            store: Arc::clone(&store),
            // SshLaunchPlan revalidates the executable before handing the plan to even a test
            // executor, so the fixture must use the same approved stock-SSH authority as runtime.
            ssh: resolve_ssh_executable().unwrap(),
            known_hosts_root,
            credentials: Arc::new(TestCredentialProvider {
                root: credential_root,
                listeners: Arc::new(StdMutex::new(Vec::new())),
            }),
            credential_cleanup: Arc::new(NoopCredentialCleanup),
            host_keys: Arc::new(TrustedHostKeyAuthority),
            executor: Arc::new(executor.clone()),
            live: Arc::new(Mutex::new(HashMap::new())),
            target_locks: Arc::new(Mutex::new(HashMap::new())),
        };
        let target = RemoteTargetRecord {
            remote_target_id: Uuid::from_u128(101),
            label: "network-loss-target".into(),
            host: "example.com".into(),
            port: 22,
            user: "alice".into(),
            host_key_state: "trusted".into(),
            known_hosts_version: 1,
            revision: 1,
            idempotency_key: Uuid::from_u128(102),
            request_hash: "a".repeat(64),
            created_at_ms: 1,
        };
        let session = RemoteSessionRecord {
            remote_session_id: Uuid::from_u128(103),
            remote_target_id: target.remote_target_id,
            workspace_id: Uuid::from_u128(104),
            pane_id: Uuid::from_u128(105),
            tab_id: Uuid::from_u128(106),
            tmux_mode: Some("create".into()),
            tmux_name: Some("exact-work".into()),
            state: RemoteSessionStateRecord::Connected,
            observation: "lastVerified".into(),
            attempt_generation: 1,
            reconnect_max_attempts: 2,
            reconnect_initial_delay_ms: 100,
            reconnect_max_delay_ms: 100,
            revision: 1,
            idempotency_key: Uuid::from_u128(107),
            request_hash: "b".repeat(64),
            created_at_ms: 1,
        };
        store.create_remote_target_exact(&target, "{}").unwrap();
        store
            .create_remote_session_exact(&session, "{\"pending\":true}")
            .unwrap();
        (dir, runtime, executor, target, session)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn network_loss_reconnects_exact_identity_once_and_restart_detaches_truthfully() {
        let (_dir, runtime, executor, target, original) = recovery_runtime();
        assert!(
            runtime
                .store
                .record_remote_transport_exit(original.remote_session_id, 1, 2)
                .unwrap()
        );
        let lost = runtime
            .store
            .load_remote_session(original.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(lost.state, RemoteSessionStateRecord::Reconnecting);
        assert_eq!(lost.observation, "lost");

        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            automatic_reconnect(runtime.clone(), original.remote_session_id, 1),
        )
        .await
        .unwrap();
        let connected = runtime
            .store
            .load_remote_session(original.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(connected.state, RemoteSessionStateRecord::Connected);
        assert_eq!(connected.observation, "lastVerified");
        assert_eq!(connected.remote_target_id, target.remote_target_id);
        assert_eq!(connected.workspace_id, original.workspace_id);
        assert_eq!(connected.pane_id, original.pane_id);
        assert_eq!(connected.tab_id, original.tab_id);
        assert_eq!(connected.tmux_name, original.tmux_name);
        assert_eq!(executor.discoveries.load(Ordering::SeqCst), 2);
        assert_eq!(
            *executor.launches.lock().unwrap(),
            vec!["tmux attach-session -t exact-work"]
        );
        assert!(
            !executor
                .launches
                .lock()
                .unwrap()
                .iter()
                .any(|operation| operation.contains("new-session"))
        );

        assert_eq!(
            runtime
                .store
                .reconcile_remote_sessions_after_restart(10)
                .unwrap(),
            1
        );
        let restarted = runtime
            .store
            .load_remote_session(original.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(restarted.state, RemoteSessionStateRecord::Detached);
        assert_eq!(restarted.observation, "unknown");
        assert_eq!(restarted.remote_target_id, target.remote_target_id);
        assert_eq!(restarted.tmux_name.as_deref(), Some("exact-work"));
        assert!(
            !runtime
                .store
                .record_remote_transport_exit(
                    original.remote_session_id,
                    connected.attempt_generation,
                    11,
                )
                .unwrap()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn credential_replacement_reaps_live_transport_and_attempt_lease() {
        let (_dir, runtime, executor, target, session) = recovery_runtime();
        let terminal_id = RuntimeSessionId::new("credential-fenced-transport");
        executor
            .live
            .lock()
            .unwrap()
            .push(terminal_id.as_str().to_owned());
        let lease = runtime
            .credentials
            .acquire(
                &CredentialReference::for_target(target.remote_target_id),
                target.remote_target_id,
                session.attempt_generation,
            )
            .await
            .unwrap();
        runtime.live.lock().await.insert(
            session.remote_session_id,
            LiveTransport {
                generation: session.attempt_generation,
                terminal_id: terminal_id.clone(),
                _credential_lease: lease,
            },
        );

        let enrollment = Uuid::from_u128(109);
        assert!(
            runtime
                .store
                .prepare_remote_credential_enrollment(
                    enrollment,
                    target.remote_target_id,
                    target.revision,
                    10,
                )
                .unwrap()
        );
        assert!(
            runtime
                .store
                .commit_remote_credential_enrollment(
                    enrollment,
                    target.remote_target_id,
                    target.revision,
                )
                .unwrap()
        );
        reconcile_live_transport_fences(&runtime).await;

        assert!(runtime.live.lock().await.is_empty());
        assert!(!executor.is_live(&terminal_id));
        let fenced = runtime
            .store
            .load_remote_session(session.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(fenced.state, RemoteSessionStateRecord::Failed);
        assert_eq!(fenced.attempt_generation, session.attempt_generation + 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn task_manager_detach_and_force_terminate_use_exact_remote_owner_fences() {
        let (_dir, runtime, _executor, _target, original) = recovery_runtime();
        let target = TaskTarget {
            session_id: original.remote_session_id.to_string(),
            generation: original.attempt_generation,
            revision: original.revision,
        };
        let mutation = agent_workspace_protocol::RemoteMutationIdentity {
            idempotency_key: Uuid::from_u128(700).to_string(),
            request_hash: "c".repeat(64),
            expected_revision: target.revision,
        };
        let detached = runtime
            .task_action(TaskActionKind::Detach, &target, mutation.clone())
            .await
            .unwrap();
        assert_eq!(detached.session.state, RemoteSessionStateRecord::Detached);
        let replay = runtime
            .task_action(TaskActionKind::Detach, &target, mutation)
            .await
            .unwrap();
        assert_eq!(replay.session.revision, detached.session.revision);

        let force_target = TaskTarget {
            session_id: replay.session.remote_session_id.to_string(),
            generation: replay.session.attempt_generation,
            revision: replay.session.revision,
        };
        let forced = runtime
            .task_action(
                TaskActionKind::ForceTerminate,
                &force_target,
                agent_workspace_protocol::RemoteMutationIdentity {
                    idempotency_key: Uuid::from_u128(701).to_string(),
                    request_hash: "d".repeat(64),
                    expected_revision: force_target.revision,
                },
            )
            .await
            .unwrap();
        assert_eq!(forced.session.state, RemoteSessionStateRecord::Closed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detach_cancels_reconnect_before_any_duplicate_remote_dispatch() {
        let (_dir, runtime, executor, _target, original) = recovery_runtime();
        assert!(
            runtime
                .store
                .record_remote_transport_exit(original.remote_session_id, 1, 2)
                .unwrap()
        );
        let reconnecting = runtime
            .store
            .load_remote_session(original.remote_session_id)
            .unwrap()
            .unwrap();
        let reconnect = tokio::spawn(automatic_reconnect(
            runtime.clone(),
            original.remote_session_id,
            1,
        ));
        assert!(
            runtime
                .store
                .transition_remote_session(
                    original.remote_session_id,
                    reconnecting.revision,
                    reconnecting.attempt_generation,
                    RemoteSessionStateRecord::Detached,
                    "lost",
                    3,
                )
                .unwrap()
        );
        reconnect.await.unwrap();
        let detached = runtime
            .store
            .load_remote_session(original.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(detached.state, RemoteSessionStateRecord::Detached);
        assert_eq!(detached.observation, "lost");
        assert_eq!(executor.discoveries.load(Ordering::SeqCst), 0);
        assert!(executor.launches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn target_catalog_is_paginated_and_create_replays_exactly() {
        let (_dir, runtime) = runtime();
        let target_id = Uuid::from_u128(1);
        let key = Uuid::from_u128(2);
        let params = serde_json::json!({
            "remoteTargetId": target_id, "label": "dev", "host": "example.com", "port": 22,
            "user": "alice", "mutation": { "idempotencyKey": key, "requestHash": "a".repeat(64), "expectedRevision": 0 }
        });
        let first = dispatch_inner("remote.target.create", params.clone(), &runtime)
            .await
            .unwrap();
        let replay = dispatch_inner("remote.target.create", params, &runtime)
            .await
            .unwrap();
        assert_eq!(first, replay);
        let list = dispatch_inner(
            "remote.target.list",
            serde_json::json!({ "limit": 1 }),
            &runtime,
        )
        .await
        .unwrap();
        assert_eq!(list["targets"].as_array().unwrap().len(), 1);
        assert_eq!(list["targets"][0]["remoteTargetId"], target_id.to_string());
    }

    #[tokio::test]
    async fn unavailable_trust_authority_fails_closed_and_replays_the_error() {
        let (_dir, runtime) = runtime();
        let target_id = Uuid::from_u128(3);
        dispatch_inner("remote.target.create", serde_json::json!({
            "remoteTargetId": target_id, "label": "dev", "host": "example.com", "port": 22,
            "user": "alice", "mutation": { "idempotencyKey": Uuid::from_u128(4), "requestHash": "b".repeat(64), "expectedRevision": 0 }
        }), &runtime).await.unwrap();
        let request = serde_json::json!({
            "remoteSessionId": Uuid::from_u128(5), "remoteTargetId": target_id,
            "workspaceId": Uuid::from_u128(6), "paneId": Uuid::from_u128(7), "tabId": Uuid::from_u128(8),
            "tmux": { "mode": "attach", "sessionName": "work" },
            "reconnect": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 5000 },
            "mutation": { "idempotencyKey": Uuid::from_u128(9), "requestHash": "c".repeat(64), "expectedRevision": 0 }
        });
        let first = dispatch_inner("remote.session.connect", request.clone(), &runtime)
            .await
            .unwrap_err();
        let replay = dispatch_inner("remote.session.connect", request, &runtime)
            .await
            .unwrap_err();
        assert_eq!(first.code, "host_key_trust_required");
        assert_eq!(replay.code, first.code);
        let session = runtime
            .store
            .load_remote_session(Uuid::from_u128(5))
            .unwrap()
            .unwrap();
        assert_eq!(session.state, RemoteSessionStateRecord::TrustRequired);
    }

    #[tokio::test]
    async fn host_key_decision_commits_and_replays_the_canonical_session_result() {
        let (_dir, mut runtime) = runtime();
        runtime.host_keys = Arc::new(AcceptingHostKeyAuthority);
        let target_id = Uuid::from_u128(11);
        let session_id = Uuid::from_u128(12);
        dispatch_inner(
            "remote.target.create",
            serde_json::json!({
                "remoteTargetId": target_id, "label": "dev", "host": "example.com", "port": 22,
                "user": "alice", "mutation": { "idempotencyKey": Uuid::from_u128(13), "requestHash": "d".repeat(64), "expectedRevision": 0 }
            }),
            &runtime,
        )
        .await
        .unwrap();
        let _ = dispatch_inner(
            "remote.session.connect",
            serde_json::json!({
                "remoteSessionId": session_id, "remoteTargetId": target_id,
                "workspaceId": Uuid::from_u128(14), "paneId": Uuid::from_u128(15), "tabId": Uuid::from_u128(16),
                "tmux": { "mode": "attach", "sessionName": "work" },
                "reconnect": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 5000 },
                "mutation": { "idempotencyKey": Uuid::from_u128(17), "requestHash": "e".repeat(64), "expectedRevision": 0 }
            }),
            &runtime,
        )
        .await;
        let decision = serde_json::json!({
            "remoteSessionId": session_id,
            "promptId": Uuid::from_u128(18),
            "attemptGeneration": 1,
            "presentedFingerprint": "SHA256:canonical-fixture",
            "decision": "trust",
            "mutation": { "idempotencyKey": Uuid::from_u128(19), "requestHash": "f".repeat(64), "expectedRevision": 1 }
        });

        let first = dispatch_inner("remote.hostKey.decide", decision.clone(), &runtime)
            .await
            .unwrap();
        let replay = dispatch_inner("remote.hostKey.decide", decision, &runtime)
            .await
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(first["session"]["remoteSessionId"], session_id.to_string());
        assert!(first.get("target").is_none());
        let target = runtime
            .store
            .load_remote_target(target_id)
            .unwrap()
            .unwrap();
        assert_eq!(target.host_key_state, "trusted");
        assert_eq!(target.revision, 2);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn changed_host_key_preserves_session_identity_in_replacement_required_state() {
        let (_dir, mut runtime) = runtime();
        runtime.host_keys = Arc::new(AcceptingHostKeyAuthority);
        let target_id = Uuid::from_u128(31);
        let session_id = Uuid::from_u128(32);
        dispatch_inner(
            "remote.target.create",
            serde_json::json!({
                "remoteTargetId": target_id, "label": "dev", "host": "example.com", "port": 22,
                "user": "alice", "mutation": { "idempotencyKey": Uuid::from_u128(33), "requestHash": "1".repeat(64), "expectedRevision": 0 }
            }),
            &runtime,
        )
        .await
        .unwrap();
        assert_eq!(
            runtime
                .store
                .mutate_remote_target_trust_exact(
                    target_id,
                    1,
                    "trusted",
                    1,
                    Uuid::from_u128(42),
                    &"0".repeat(64),
                    "{\"trusted\":true}",
                    now_ms(),
                )
                .unwrap(),
            RemoteMutationOutcome::Applied
        );
        assert!(
            runtime
                .store
                .mark_remote_target_host_key_changed(target_id, 2, now_ms())
                .unwrap()
        );
        let error = dispatch_inner(
            "remote.session.connect",
            serde_json::json!({
                "remoteSessionId": session_id, "remoteTargetId": target_id,
                "workspaceId": Uuid::from_u128(34), "paneId": Uuid::from_u128(35), "tabId": Uuid::from_u128(36),
                "tmux": { "mode": "attach", "sessionName": "work" },
                "reconnect": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 5000 },
                "mutation": { "idempotencyKey": Uuid::from_u128(37), "requestHash": "2".repeat(64), "expectedRevision": 0 }
            }),
            &runtime,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "host_key_replacement_required");
        let session = runtime
            .store
            .load_remote_session(session_id)
            .unwrap()
            .unwrap();
        assert_eq!(session.remote_session_id, session_id);
        assert_eq!(session.remote_target_id, target_id);
        assert_eq!(session.state, RemoteSessionStateRecord::TrustRequired);

        let rejection = serde_json::json!({
            "remoteSessionId": session_id,
            "promptId": Uuid::from_u128(38),
            "attemptGeneration": 1,
            "presentedFingerprint": "SHA256:changed-fixture",
            "decision": "reject",
            "mutation": { "idempotencyKey": Uuid::from_u128(39), "requestHash": "3".repeat(64), "expectedRevision": 3 }
        });
        let first = dispatch_inner("remote.hostKey.decide", rejection.clone(), &runtime)
            .await
            .unwrap();
        let replay = dispatch_inner("remote.hostKey.decide", rejection, &runtime)
            .await
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(first["session"]["remoteSessionId"], session_id.to_string());
        let target = runtime
            .store
            .load_remote_target(target_id)
            .unwrap()
            .unwrap();
        assert_eq!(target.host_key_state, "changed");
        assert_eq!(target.revision, 4);

        let stale = dispatch_inner(
            "remote.hostKey.decide",
            serde_json::json!({
                "remoteSessionId": session_id,
                "promptId": Uuid::from_u128(40),
                "attemptGeneration": 1,
                "presentedFingerprint": "SHA256:changed-fixture",
                "decision": "trust",
                "mutation": { "idempotencyKey": Uuid::from_u128(41), "requestHash": "4".repeat(64), "expectedRevision": 2 }
            }),
            &runtime,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, "stale_revision");
        assert_eq!(
            runtime
                .store
                .load_remote_target(target_id)
                .unwrap()
                .unwrap()
                .host_key_state,
            "changed"
        );
    }

    #[tokio::test]
    async fn deletion_fence_rejects_detach_close_and_discovery_before_mutation_intent() {
        let (_dir, runtime) = runtime();
        let target_id = Uuid::from_u128(21);
        let session_id = Uuid::from_u128(22);
        dispatch_inner("remote.target.create", serde_json::json!({
            "remoteTargetId": target_id, "label": "dev", "host": "example.com", "port": 22,
            "user": "alice", "mutation": { "idempotencyKey": Uuid::from_u128(23), "requestHash": "a".repeat(64), "expectedRevision": 0 }
        }), &runtime).await.unwrap();
        let _ = dispatch_inner("remote.session.connect", serde_json::json!({
            "remoteSessionId": session_id, "remoteTargetId": target_id,
            "workspaceId": Uuid::from_u128(24), "paneId": Uuid::from_u128(25), "tabId": Uuid::from_u128(26),
            "tmux": { "mode": "attach", "sessionName": "work" },
            "reconnect": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 5000 },
            "mutation": { "idempotencyKey": Uuid::from_u128(27), "requestHash": "b".repeat(64), "expectedRevision": 0 }
        }), &runtime).await;
        assert_eq!(
            runtime
                .store
                .begin_remote_target_delete_exact(
                    target_id,
                    1,
                    Uuid::from_u128(28),
                    &"c".repeat(64),
                    "{\"deleted\":true}",
                    now_ms(),
                )
                .unwrap(),
            RemoteMutationOutcome::Applied
        );

        for (index, command) in [
            "remote.session.detach",
            "remote.session.close",
            "remote.tmux.discover",
        ]
        .into_iter()
        .enumerate()
        {
            let error = dispatch_inner(
                command,
                serde_json::json!({
                    "remoteSessionId": session_id,
                    "mutation": {
                        "idempotencyKey": Uuid::from_u128(30 + index as u128),
                        "requestHash": format!("{:064x}", 30 + index),
                        "expectedRevision": 2
                    }
                }),
                &runtime,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "target_cleanup_pending");
        }
        let fenced = runtime
            .store
            .load_remote_session(session_id)
            .unwrap()
            .unwrap();
        assert_eq!(fenced.state, RemoteSessionStateRecord::Closed);
        assert_eq!(fenced.revision, 2);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn host_key_prompt_is_exact_session_bound_and_one_shot() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempdir().unwrap();
        let root = dir.path().join("known-hosts");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let authority = ProductionHostKeyAuthority::new(root.clone()).unwrap();
        let target_id = Uuid::from_u128(41);
        let session_id = Uuid::from_u128(42);
        let prompt_id = Uuid::from_u128(43);
        let target = RemoteTargetRecord {
            remote_target_id: target_id,
            label: "test".into(),
            host: "example.com".into(),
            port: 22,
            user: "alice".into(),
            host_key_state: "untrusted".into(),
            known_hosts_version: 1,
            revision: 3,
            idempotency_key: Uuid::from_u128(44),
            request_hash: "a".repeat(64),
            created_at_ms: now_ms(),
        };
        let descriptor = HostKeyDescriptor {
            canonical_host: target.host.clone(),
            port: target.port,
            algorithm: "ssh-ed25519".into(),
            public_key: "AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3"
                .into(),
            fingerprint: "SHA256:prompt-bound-fixture".into(),
        };
        authority.prompts.lock().unwrap().insert(
            prompt_id,
            PendingHostKeyPrompt {
                remote_session_id: session_id,
                target_id,
                target_revision: target.revision,
                attempt_generation: 7,
                expires_at_ms: now_ms() + 5_000,
                descriptor,
            },
        );
        assert_eq!(
            authority
                .decide(
                    &target,
                    Uuid::from_u128(999),
                    prompt_id,
                    7,
                    "SHA256:prompt-bound-fixture",
                    RemoteHostKeyDecision::Trust,
                )
                .await
                .unwrap_err(),
            RemoteRuntimeError::HostKeyMismatch
        );
        assert!(!root.join(format!("{target_id}.known_hosts")).exists());
        assert!(
            authority
                .decide(
                    &target,
                    session_id,
                    prompt_id,
                    7,
                    "SHA256:prompt-bound-fixture",
                    RemoteHostKeyDecision::Trust,
                )
                .await
                .is_err()
        );
        let accepted_prompt = Uuid::from_u128(45);
        authority.prompts.lock().unwrap().insert(
            accepted_prompt,
            PendingHostKeyPrompt {
                remote_session_id: session_id,
                target_id,
                target_revision: target.revision,
                attempt_generation: 7,
                expires_at_ms: now_ms() + 5_000,
                descriptor: HostKeyDescriptor {
                    canonical_host: target.host.clone(),
                    port: target.port,
                    algorithm: "ssh-ed25519".into(),
                    public_key:
                        "AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3"
                            .into(),
                    fingerprint: "SHA256:prompt-bound-fixture".into(),
                },
            },
        );
        authority
            .decide(
                &target,
                session_id,
                accepted_prompt,
                7,
                "SHA256:prompt-bound-fixture",
                RemoteHostKeyDecision::Trust,
            )
            .await
            .unwrap();
        let record = fs::read_to_string(root.join(format!("{target_id}.known_hosts"))).unwrap();
        assert_eq!(record.lines().count(), 1);
        assert!(record.starts_with("example.com ssh-ed25519 "));
    }

    #[test]
    fn host_key_prompt_capacity_prunes_expired_and_caps_each_target() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempdir().unwrap();
        let root = dir.path().join("known-hosts");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let authority = ProductionHostKeyAuthority::new(root).unwrap();
        let target_id = Uuid::from_u128(61);
        let descriptor = HostKeyDescriptor {
            canonical_host: "example.com".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            public_key: "fixture".into(),
            fingerprint: "SHA256:fixture".into(),
        };
        let mut prompts = authority.prompts.lock().unwrap();
        prompts.insert(
            Uuid::from_u128(62),
            PendingHostKeyPrompt {
                remote_session_id: Uuid::from_u128(63),
                target_id,
                target_revision: 1,
                attempt_generation: 1,
                expires_at_ms: now_ms() - 1,
                descriptor: descriptor.clone(),
            },
        );
        for index in 0..MAX_HOST_KEY_PROMPTS_PER_TARGET {
            prompts.insert(
                Uuid::from_u128(70 + index as u128),
                PendingHostKeyPrompt {
                    remote_session_id: Uuid::from_u128(80 + index as u128),
                    target_id,
                    target_revision: 1,
                    attempt_generation: 1,
                    expires_at_ms: now_ms() + 5_000,
                    descriptor: descriptor.clone(),
                },
            );
        }
        drop(prompts);
        assert_eq!(
            authority.check_prompt_capacity(target_id).unwrap_err(),
            RemoteRuntimeError::HostKeyPromptCapacity
        );
        assert_eq!(authority.prompts.lock().unwrap().len(), 4);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn immediate_exit_is_rejected_before_live_registration() {
        use std::os::unix::{fs::PermissionsExt as _, net::UnixListener};

        let (_dir, mut runtime) = runtime();
        runtime.executor = Arc::new(NeverLiveExecutor);
        let socket_dir = tempdir().unwrap();
        fs::set_permissions(socket_dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = socket_dir.path().join("agent.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).unwrap();
        let socket =
            agent_workspace_terminal_runtime::remote::EphemeralAgentSocket::from_broker_path(
                socket_path,
            )
            .unwrap();
        let session_id = Uuid::from_u128(91);
        assert!(
            !register_live_transport(
                &runtime,
                session_id,
                4,
                RuntimeSessionId::new("already-exited"),
                CredentialBrokerLease::new(Uuid::from_u128(92), 4, socket),
            )
            .await
        );
        assert!(!runtime.live.lock().await.contains_key(&session_id));
        drop(listener);
    }
}
#[cfg(not(unix))]
fn prepare_private_file(path: &Path) -> Result<(), RemoteRuntimeError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .map(|_| ())
        .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)
}

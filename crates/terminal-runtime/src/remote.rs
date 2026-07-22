//! Contained, stock-OpenSSH remote terminal launch foundation.
//!
//! This module accepts only validated atoms and emits a fixed SSH invocation.
//! It deliberately has no general SSH-options or remote-command escape hatch.

use std::{
    fmt, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use agent_workspace_protocol::{
    RemoteHostKeyState, RemoteObservationState, RemoteReconnectPolicy, RemoteTmuxIdentity,
    RemoteTmuxMode,
};
use thiserror::Error;
use uuid::Uuid;

mod credential_broker;
pub use credential_broker::{
    CredentialReference, SecretServiceCredentialProvider, delete_target_credential,
    enroll_target_credential_from_file,
};
mod host_keys;
pub use host_keys::{HostKeyDescriptor, SystemHostKeyScanner, write_known_host_atomic};

pub const MAX_TMUX_DISCOVERY_ROWS: usize = 128;
pub const MAX_TMUX_DISCOVERY_BYTES: usize = 64 * 1024;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum RemoteRuntimeError {
    #[error("SSH executable must be an absolute executable regular file")]
    UnsafeSshExecutable,
    #[error("known-hosts file must be an absolute owner-only regular file")]
    UnsafeKnownHosts,
    #[error("SSH agent socket must be an absolute owner-only Unix socket")]
    UnsafeAgentSocket,
    #[error("host key trust is not established")]
    HostKeyUntrusted,
    #[error("host key changed, was revoked, or did not match the approved fingerprint")]
    HostKeyMismatch,
    #[error("the approved host-key scanner could not produce one exact key")]
    HostKeyScanUnavailable,
    #[error("the bounded host-key prompt authority is at capacity")]
    HostKeyPromptCapacity,
    #[error("invalid SSH target atom")]
    InvalidTarget,
    #[error("invalid tmux response")]
    InvalidTmuxResponse,
    #[error("tmux 3.2 or newer is required")]
    UnsupportedTmux,
    #[error("reconnect policy is invalid or exhausted")]
    ReconnectExhausted,
    #[error("a trusted credential is required for this target")]
    CredentialRequired,
    #[error("the trusted credential provider is unavailable")]
    CredentialProviderUnavailable,
    #[error("the credential was revoked or no longer matches this attempt")]
    CredentialRevoked,
    #[error("the selected credential file is not a safe owner-only regular file")]
    UnsafeCredentialFile,
    #[error("the selected credential must be an unencrypted OpenSSH Ed25519 private key")]
    InvalidCredential,
    #[error("the contained SSH transport could not be started or completed")]
    TransportUnavailable,
}

/// Attempt-scoped signing authority. The socket path is deliberately redacted and non-durable.
pub struct CredentialBrokerLease {
    target_id: Uuid,
    generation: u64,
    socket: EphemeralAgentSocket,
    _guard: Option<Box<dyn Send + Sync>>,
}

impl fmt::Debug for CredentialBrokerLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialBrokerLease")
            .field("target_id", &self.target_id)
            .field("generation", &self.generation)
            .field("socket", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl CredentialBrokerLease {
    /// Binds one broker-created socket to one exact target attempt.
    #[must_use]
    pub const fn new(target_id: Uuid, generation: u64, socket: EphemeralAgentSocket) -> Self {
        Self {
            target_id,
            generation,
            socket,
            _guard: None,
        }
    }
    pub(crate) fn with_guard(
        target_id: Uuid,
        generation: u64,
        socket: EphemeralAgentSocket,
        guard: Box<dyn Send + Sync>,
    ) -> Self {
        Self {
            target_id,
            generation,
            socket,
            _guard: Some(guard),
        }
    }
    #[must_use]
    pub const fn target_id(&self) -> Uuid {
        self.target_id
    }
    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }
    #[must_use]
    pub const fn socket(&self) -> &EphemeralAgentSocket {
        &self.socket
    }
}

/// Trusted credential/keyring boundary. Implementations return only a fenced signing broker.
#[async_trait::async_trait]
pub trait CredentialProvider: Send + Sync {
    /// Acquires a short-lived agent lease scoped to one target attempt.
    ///
    /// # Errors
    /// Returns a stable credential error when the trusted provider cannot issue a lease.
    async fn acquire(
        &self,
        reference: &CredentialReference,
        target_id: Uuid,
        attempt_generation: u64,
    ) -> Result<CredentialBrokerLease, RemoteRuntimeError>;
}

/// Honest production fallback used until a Secret Service signing broker is installed.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableCredentialProvider;

#[async_trait::async_trait]
impl CredentialProvider for UnavailableCredentialProvider {
    async fn acquire(
        &self,
        _reference: &CredentialReference,
        _target_id: Uuid,
        _attempt_generation: u64,
    ) -> Result<CredentialBrokerLease, RemoteRuntimeError> {
        Err(RemoteRuntimeError::CredentialProviderUnavailable)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct EphemeralAgentSocket(PathBuf);

impl fmt::Debug for EphemeralAgentSocket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("EphemeralAgentSocket")
            .field(&"[REDACTED]")
            .finish()
    }
}

impl EphemeralAgentSocket {
    /// Accepts a broker-created socket only after owner and mode checks.
    ///
    /// # Errors
    ///
    /// Returns an error unless `path` is an absolute, owner-only Unix socket.
    pub fn from_broker_path(path: PathBuf) -> Result<Self, RemoteRuntimeError> {
        validate_owner_only_socket(&path)?;
        Ok(Self(path))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRemoteTarget {
    host: String,
    port: u16,
    user: String,
    known_hosts_version: u64,
}

impl VerifiedRemoteTarget {
    /// Constructs launch authority only after an exact, already-prompt-bound trust match.
    ///
    /// # Errors
    ///
    /// Returns an error for untrusted or mismatched keys and invalid target fields.
    pub fn verify(
        host: String,
        port: u16,
        user: String,
        known_hosts_version: u64,
        state: RemoteHostKeyState,
        approved_fingerprint: &str,
        presented: &str,
    ) -> Result<Self, RemoteRuntimeError> {
        if state != RemoteHostKeyState::Trusted {
            return Err(
                if matches!(
                    state,
                    RemoteHostKeyState::Changed | RemoteHostKeyState::Revoked
                ) {
                    RemoteRuntimeError::HostKeyMismatch
                } else {
                    RemoteRuntimeError::HostKeyUntrusted
                },
            );
        }
        if approved_fingerprint != presented
            || !approved_fingerprint.starts_with("SHA256:")
            || approved_fingerprint.len() > 128
        {
            return Err(RemoteRuntimeError::HostKeyMismatch);
        }
        let target = Self {
            host,
            port,
            user,
            known_hosts_version,
        };
        target.validate()?;
        Ok(target)
    }
    fn validate(&self) -> Result<(), RemoteRuntimeError> {
        let host_ok = !self.host.is_empty()
            && self.host.len() <= 253
            && self.host == self.host.to_ascii_lowercase()
            && !self.host.starts_with('-')
            // v1 intentionally excludes IPv6 until bracketed known_hosts and
            // ssh-keyscan normalization are qualified end-to-end.
            && !self.host.contains([':', '[', ']'])
            && !self
                .host
                .chars()
                .any(|c| c.is_control() || c.is_whitespace());
        let user_ok = !self.user.is_empty()
            && self.user.len() <= 64
            && !self.user.starts_with('-')
            && !self
                .user
                .chars()
                .any(|c| c.is_control() || c.is_whitespace());
        if self.port == 0 || self.known_hosts_version == 0 || !host_ok || !user_ok {
            return Err(RemoteRuntimeError::InvalidTarget);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TmuxOperation {
    DiscoverVersion,
    DiscoverSessions,
    Attach(String),
    Create(String),
}

impl TryFrom<&RemoteTmuxIdentity> for TmuxOperation {
    type Error = RemoteRuntimeError;
    fn try_from(value: &RemoteTmuxIdentity) -> Result<Self, Self::Error> {
        validate_tmux_name(&value.session_name)?;
        Ok(match value.mode {
            RemoteTmuxMode::Attach => Self::Attach(value.session_name.clone()),
            RemoteTmuxMode::Create => Self::Create(value.session_name.clone()),
        })
    }
}

pub struct SshLaunchPlan {
    executable: PathBuf,
    argv: Vec<String>,
    lease: CredentialBrokerLease,
    known_hosts: PathBuf,
}

#[allow(clippy::missing_fields_in_debug)]
impl fmt::Debug for SshLaunchPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshLaunchPlan")
            .field("kind", &"stock-ssh")
            .field("argument_count", &self.argv.len())
            .field("agent_socket", &"[REDACTED]")
            .finish()
    }
}

impl SshLaunchPlan {
    /// Creates a fixed, fail-closed stock-SSH launch plan.
    ///
    /// # Errors
    ///
    /// Returns an error if any trusted input, file authority, or tmux operation is invalid.
    pub fn new(
        ssh: PathBuf,
        known_hosts: &Path,
        lease: CredentialBrokerLease,
        target: &VerifiedRemoteTarget,
        operation: &TmuxOperation,
    ) -> Result<Self, RemoteRuntimeError> {
        validate_executable(&ssh)?;
        validate_owner_only_file(known_hosts)?;
        target.validate()?;
        let remote = tmux_command(operation)?;
        let mut argv = vec![
            "-F".into(),
            "/dev/null".into(),
            "-o".into(),
            format!("UserKnownHostsFile={}", known_hosts.display()),
            "-o".into(),
            "GlobalKnownHostsFile=/dev/null".into(),
            "-o".into(),
            "StrictHostKeyChecking=yes".into(),
            "-o".into(),
            "HostKeyAlgorithms=ssh-ed25519".into(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "IdentitiesOnly=no".into(),
            "-o".into(),
            "PasswordAuthentication=no".into(),
            "-o".into(),
            "KbdInteractiveAuthentication=no".into(),
            "-o".into(),
            "PubkeyAuthentication=yes".into(),
            "-o".into(),
            "ForwardAgent=no".into(),
            "-o".into(),
            "ClearAllForwardings=yes".into(),
            "-o".into(),
            "DisableForwarding=yes".into(),
            "-o".into(),
            "ProxyCommand=none".into(),
            "-o".into(),
            "ProxyJump=none".into(),
            "-o".into(),
            "CanonicalizeHostname=no".into(),
            "-o".into(),
            "PermitLocalCommand=no".into(),
            "-o".into(),
            "RequestTTY=force".into(),
            "-p".into(),
            target.port.to_string(),
            "-l".into(),
            target.user.clone(),
            "--".into(),
            target.host.clone(),
        ];
        argv.push(remote);
        Ok(Self {
            executable: ssh,
            argv,
            lease,
            known_hosts: known_hosts.to_path_buf(),
        })
    }
    #[must_use]
    pub fn executable(&self) -> &Path {
        &self.executable
    }
    #[must_use]
    pub fn argv(&self) -> &[String] {
        &self.argv
    }
    /// The only inherited credential channel. Callers must clear the child environment first.
    #[must_use]
    pub fn environment(&self) -> [(&'static str, &Path); 1] {
        [("SSH_AUTH_SOCK", self.lease.socket().path())]
    }

    /// Returns the attempt lease after the SSH child has inherited its socket path.
    #[must_use]
    pub fn into_lease(self) -> CredentialBrokerLease {
        self.lease
    }

    /// Revalidates path authority immediately before the child opens its inputs.
    ///
    /// # Errors
    /// Returns an authority error if the executable, known-hosts file, or broker socket changed.
    pub fn revalidate(&self) -> Result<(), RemoteRuntimeError> {
        validate_executable(&self.executable)?;
        validate_owner_only_file(&self.known_hosts)?;
        validate_owner_only_socket(self.lease.socket().path())
    }
}

/// Resolves and validates the one approved stock-SSH executable at service construction.
///
/// # Errors
/// Returns an error when `ssh` is absent or does not resolve to an executable regular file.
pub fn resolve_ssh_executable() -> Result<PathBuf, RemoteRuntimeError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        for approved in [Path::new("/usr/bin/ssh"), Path::new("/bin/ssh")] {
            let Ok(path) = fs::canonicalize(approved) else {
                continue;
            };
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if metadata.is_file()
                && metadata.uid() == 0
                && metadata.nlink() == 1
                && metadata.permissions().mode() & 0o111 != 0
                && metadata.permissions().mode() & 0o022 == 0
            {
                return Ok(path);
            }
        }
        Err(RemoteRuntimeError::UnsafeSshExecutable)
    }
    #[cfg(not(unix))]
    {
        let path = which::which("ssh").map_err(|_| RemoteRuntimeError::UnsafeSshExecutable)?;
        let path = fs::canonicalize(path).map_err(|_| RemoteRuntimeError::UnsafeSshExecutable)?;
        validate_executable(&path)?;
        Ok(path)
    }
}

fn tmux_command(operation: &TmuxOperation) -> Result<String, RemoteRuntimeError> {
    Ok(match operation {
        TmuxOperation::DiscoverVersion => "tmux -V".into(),
        // Single quotes are fixed syntax, not influenced by remote input.
        TmuxOperation::DiscoverSessions => "tmux list-sessions -F '#{session_name}'".into(),
        TmuxOperation::Attach(name) => {
            validate_tmux_name(name)?;
            format!("tmux attach-session -t {name}")
        }
        TmuxOperation::Create(name) => {
            validate_tmux_name(name)?;
            format!("tmux new-session -s {name}")
        }
    })
}

fn validate_tmux_name(value: &str) -> Result<(), RemoteRuntimeError> {
    if value.is_empty()
        || value.chars().count() > 64
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(RemoteRuntimeError::InvalidTarget);
    }
    Ok(())
}

/// Parses the bounded output of the fixed `tmux -V` probe.
///
/// # Errors
///
/// Returns an error for oversized, malformed, or unsupported version output.
pub fn parse_tmux_version(output: &[u8]) -> Result<(), RemoteRuntimeError> {
    if output.len() > 128 {
        return Err(RemoteRuntimeError::InvalidTmuxResponse);
    }
    let value = std::str::from_utf8(output)
        .map_err(|_| RemoteRuntimeError::InvalidTmuxResponse)?
        .trim();
    let version = value
        .strip_prefix("tmux ")
        .ok_or(RemoteRuntimeError::InvalidTmuxResponse)?;
    let mut numbers = version.split(|c: char| !c.is_ascii_digit());
    let major: u16 = numbers
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or(RemoteRuntimeError::InvalidTmuxResponse)?;
    let minor: u16 = numbers.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    if (major, minor) < (3, 2) {
        return Err(RemoteRuntimeError::UnsupportedTmux);
    }
    Ok(())
}

/// Parses bounded session names from the fixed tmux discovery format.
///
/// # Errors
///
/// Returns an error for oversized, non-UTF-8, or invalid session output.
pub fn parse_tmux_sessions(output: &[u8]) -> Result<Vec<String>, RemoteRuntimeError> {
    if output.len() > MAX_TMUX_DISCOVERY_BYTES {
        return Err(RemoteRuntimeError::InvalidTmuxResponse);
    }
    let value = std::str::from_utf8(output).map_err(|_| RemoteRuntimeError::InvalidTmuxResponse)?;
    let rows: Vec<_> = value.lines().map(str::to_owned).collect();
    if rows.len() > MAX_TMUX_DISCOVERY_ROWS
        || rows.iter().any(|row| validate_tmux_name(row).is_err())
    {
        return Err(RemoteRuntimeError::InvalidTmuxResponse);
    }
    Ok(rows)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteAttemptFence {
    pub generation: u64,
    pub child_exited: bool,
    pub observation: RemoteObservationState,
}

impl RemoteAttemptFence {
    #[must_use]
    pub fn accepts(&self, callback_generation: u64) -> bool {
        !self.child_exited && callback_generation == self.generation
    }
    pub fn child_exited(&mut self, callback_generation: u64) -> bool {
        if !self.accepts(callback_generation) {
            return false;
        }
        self.child_exited = true;
        // Observation is intentionally unchanged: a local SSH exit is not proof of remote loss.
        true
    }
    pub fn record_observation(
        &mut self,
        callback_generation: u64,
        observation: RemoteObservationState,
    ) -> bool {
        if !self.accepts(callback_generation) {
            return false;
        }
        self.observation = observation;
        true
    }
}

/// Computes the bounded reconnect delay for an authorized attempt.
///
/// # Errors
///
/// Returns an error when the policy, attempt, or jitter is outside fixed bounds.
pub fn reconnect_delay(
    policy: &RemoteReconnectPolicy,
    attempt: u8,
    jitter_per_mille: u16,
) -> Result<Duration, RemoteRuntimeError> {
    if policy.max_attempts > 10
        || policy.initial_delay_ms < 100
        || policy.max_delay_ms < policy.initial_delay_ms
        || policy.max_delay_ms > 300_000
        || attempt == 0
        || attempt > policy.max_attempts
        || jitter_per_mille > 1000
    {
        return Err(RemoteRuntimeError::ReconnectExhausted);
    }
    let exponent = u32::from(attempt - 1).min(31);
    let base = policy
        .initial_delay_ms
        .saturating_mul(1_u32 << exponent)
        .min(policy.max_delay_ms);
    let jitter = u64::from(base) * u64::from(jitter_per_mille) / 10_000; // capped at +10%
    Ok(Duration::from_millis(u64::from(base) + jitter))
}

#[cfg(unix)]
fn validate_executable(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::PermissionsExt as _;
    let meta = fs::symlink_metadata(path).map_err(|_| RemoteRuntimeError::UnsafeSshExecutable)?;
    if !path.is_absolute() || !meta.file_type().is_file() || meta.permissions().mode() & 0o111 == 0
    {
        return Err(RemoteRuntimeError::UnsafeSshExecutable);
    }
    Ok(())
}
#[cfg(not(unix))]
fn validate_executable(path: &Path) -> Result<(), RemoteRuntimeError> {
    if path.is_absolute() && path.is_file() {
        Ok(())
    } else {
        Err(RemoteRuntimeError::UnsafeSshExecutable)
    }
}

#[cfg(unix)]
fn validate_owner_only_file(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let meta = fs::symlink_metadata(path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    if !path.is_absolute()
        || !meta.file_type().is_file()
        || meta.uid() != rustix::process::getuid().as_raw()
        || meta.nlink() != 1
        || meta.permissions().mode() & 0o077 != 0
        || !owner_only_parent(path)
    {
        return Err(RemoteRuntimeError::UnsafeKnownHosts);
    }
    Ok(())
}
#[cfg(not(unix))]
fn validate_owner_only_file(path: &Path) -> Result<(), RemoteRuntimeError> {
    if path.is_absolute() && path.is_file() {
        Ok(())
    } else {
        Err(RemoteRuntimeError::UnsafeKnownHosts)
    }
}

#[cfg(unix)]
fn validate_owner_only_socket(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};
    let meta = fs::symlink_metadata(path).map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)?;
    if !path.is_absolute()
        || !meta.file_type().is_socket()
        || meta.uid() != rustix::process::getuid().as_raw()
        || meta.nlink() != 1
        || meta.permissions().mode() & 0o077 != 0
        || !owner_only_parent(path)
    {
        return Err(RemoteRuntimeError::UnsafeAgentSocket);
    }
    Ok(())
}

#[cfg(unix)]
fn owner_only_parent(path: &Path) -> bool {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(parent) else {
        return false;
    };
    metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == rustix::process::getuid().as_raw()
        && metadata.permissions().mode().trailing_zeros() >= 6
        && fs::canonicalize(parent).ok().as_deref() == Some(parent)
}
#[cfg(not(unix))]
fn validate_owner_only_socket(_path: &Path) -> Result<(), RemoteRuntimeError> {
    Err(RemoteRuntimeError::UnsafeAgentSocket)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs::File,
        os::unix::{fs::PermissionsExt as _, net::UnixListener},
    };
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, EphemeralAgentSocket) {
        let dir = tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let ssh = dir.path().join("ssh");
        File::create(&ssh).unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let known = dir.path().join("known_hosts");
        File::create(&known).unwrap();
        fs::set_permissions(&known, fs::Permissions::from_mode(0o600)).unwrap();
        let socket_path = dir.path().join("agent.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).unwrap();
        std::mem::forget(listener);
        let socket = EphemeralAgentSocket::from_broker_path(socket_path).unwrap();
        (dir, ssh, known, socket)
    }

    #[test]
    fn ssh_plan_has_fixed_fail_closed_options_and_redacts_socket() {
        let (_dir, ssh, known, socket) = fixture();
        let target = VerifiedRemoteTarget::verify(
            "example.com".into(),
            22,
            "alice".into(),
            1,
            RemoteHostKeyState::Trusted,
            "SHA256:abc",
            "SHA256:abc",
        )
        .unwrap();
        let plan = SshLaunchPlan::new(
            ssh,
            &known,
            CredentialBrokerLease::new(Uuid::nil(), 1, socket),
            &target,
            &TmuxOperation::Attach("work".into()),
        )
        .unwrap();
        let args = plan.argv().join(" ");
        assert!(args.contains("-F /dev/null"));
        assert!(args.contains("StrictHostKeyChecking=yes"));
        assert!(args.contains("ClearAllForwardings=yes"));
        assert!(args.contains("DisableForwarding=yes"));
        assert!(args.contains("ProxyCommand=none"));
        assert_eq!(plan.argv().last().unwrap(), "tmux attach-session -t work");
        let debug = format!("{plan:?}");
        for sensitive in [
            "example.com",
            "alice",
            "SHA256:abc",
            "known_hosts",
            "agent.sock",
            "work",
        ] {
            assert!(!debug.contains(sensitive));
        }
    }
    #[test]
    fn stale_callbacks_and_child_exit_do_not_forge_observation() {
        let mut fence = RemoteAttemptFence {
            generation: 7,
            child_exited: false,
            observation: RemoteObservationState::LastVerified,
        };
        assert!(!fence.child_exited(6));
        assert!(fence.child_exited(7));
        assert_eq!(fence.observation, RemoteObservationState::LastVerified);
        assert!(!fence.record_observation(6, RemoteObservationState::Lost));
        assert!(!fence.record_observation(7, RemoteObservationState::Lost));
        assert_eq!(fence.observation, RemoteObservationState::LastVerified);
    }
    #[test]
    fn discovery_and_retry_are_bounded() {
        let (_dir, ssh, known, socket) = fixture();
        let target = VerifiedRemoteTarget::verify(
            "example.com".into(),
            22,
            "alice".into(),
            1,
            RemoteHostKeyState::Trusted,
            "SHA256:abc",
            "SHA256:abc",
        )
        .unwrap();
        let plan = SshLaunchPlan::new(
            ssh,
            &known,
            CredentialBrokerLease::new(Uuid::nil(), 1, socket),
            &target,
            &TmuxOperation::DiscoverSessions,
        )
        .unwrap();
        assert_eq!(
            plan.argv().last().unwrap(),
            "tmux list-sessions -F '#{session_name}'"
        );
        assert!(parse_tmux_version(b"tmux 3.2a\n").is_ok());
        assert!(parse_tmux_version(b"tmux 3.1\n").is_err());
        assert_eq!(parse_tmux_sessions(b"one\ntwo\n").unwrap(), ["one", "two"]);
        for hostile in ["x;id", "$(id)", "x y", "x#comment", "x'quote", "x\nnext"] {
            assert_eq!(
                validate_tmux_name(hostile).unwrap_err(),
                RemoteRuntimeError::InvalidTarget
            );
        }
        let p = RemoteReconnectPolicy {
            max_attempts: 3,
            initial_delay_ms: 500,
            max_delay_ms: 1000,
        };
        assert_eq!(
            reconnect_delay(&p, 3, 1000).unwrap(),
            Duration::from_millis(1100)
        );
        assert!(reconnect_delay(&p, 4, 0).is_err());
    }

    #[test]
    fn launch_authority_requires_exact_trusted_host_key() {
        assert_eq!(
            VerifiedRemoteTarget::verify(
                "example.com".into(),
                22,
                "alice".into(),
                1,
                RemoteHostKeyState::Untrusted,
                "SHA256:abc",
                "SHA256:abc"
            )
            .unwrap_err(),
            RemoteRuntimeError::HostKeyUntrusted
        );
        assert_eq!(
            VerifiedRemoteTarget::verify(
                "example.com".into(),
                22,
                "alice".into(),
                1,
                RemoteHostKeyState::Trusted,
                "SHA256:abc",
                "SHA256:changed"
            )
            .unwrap_err(),
            RemoteRuntimeError::HostKeyMismatch
        );
        assert_eq!(
            VerifiedRemoteTarget::verify(
                "[2001:db8::1]".into(),
                22,
                "alice".into(),
                1,
                RemoteHostKeyState::Trusted,
                "SHA256:abc",
                "SHA256:abc"
            )
            .unwrap_err(),
            RemoteRuntimeError::InvalidTarget
        );
    }

    #[test]
    fn hermetic_sshd_tmux_gate_is_explicit_when_host_tooling_is_incomplete() {
        let sshd = Path::new("/usr/bin/sshd");
        let tmux = Path::new("/usr/bin/tmux");
        if !sshd.is_file() || !tmux.is_file() {
            eprintln!(
                "M7 hermetic qualification unavailable: required host sshd/tmux tooling is incomplete"
            );
            assert_eq!(
                parse_tmux_version(b"").unwrap_err(),
                RemoteRuntimeError::InvalidTmuxResponse
            );
            return;
        }
        // A runner with both tools must execute the repository's external hermetic fixture before
        // capability advertisement; this unit gate deliberately does not claim that evidence.
        assert!(resolve_ssh_executable().is_ok());
    }
}

//! Trusted, in-process agent adapter abstraction.
//!
//! Adapters are service-owned Rust registrations. This crate deliberately has
//! no renderer, IPC callback, persistence, or plugin loading surface.

use std::{
    collections::BTreeMap,
    fmt,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use agent_workspace_terminal_runtime::ExecutableIdentity;
use serde::{Deserialize, Serialize, de::IgnoredAny};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub const MAX_ADAPTER_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_ADAPTER_ID_SCALARS: usize = 64;
pub const MAX_ADAPTER_VERSION_SCALARS: usize = 64;
pub const MAX_ARTIFACT_KIND_SCALARS: usize = 64;
pub const MAX_SECRET_REFERENCE_SCALARS: usize = 256;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CODEX_ADAPTER_ID: &str = "codex";
const CODEX_ADAPTER_VERSION: &str = "0.142.4";
const CODEX_ARTIFACT_KIND: &str = "codex-thread-v1";
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROTOCOL_LINE_BYTES: usize = 64 * 1024;
const MAX_PROTOCOL_LINES: usize = 256;
const MAX_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_MESSAGES: usize = 10_000;
const MAX_TRANSCRIPT_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodexTranscriptRole {
    User,
    Assistant,
}

/// One bounded text-only record returned by the exact audited Codex app-server adapter. The text
/// is zeroized on drop and deliberately has no `Debug` implementation.
pub struct CodexTranscriptMessage {
    pub role: CodexTranscriptRole,
    pub text: Zeroizing<String>,
}

/// A content-only transcript projection. It contains no source path, command, tool output,
/// reasoning, environment, or renderer-provided location.
pub struct CodexTranscript {
    pub messages: Vec<CodexTranscriptMessage>,
    pub skipped_items: usize,
}

/// A closed, adapter-produced process plan. It is deliberately non-serializable and ephemeral.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalLaunchPlan {
    executable: PathBuf,
    arguments: Vec<String>,
    executable_identity: ExecutableIdentity,
}

impl TerminalLaunchPlan {
    #[must_use]
    pub fn command(&self) -> Vec<String> {
        std::iter::once(self.executable.to_string_lossy().into_owned())
            .chain(self.arguments.iter().cloned())
            .collect()
    }

    #[must_use]
    pub fn executable_identity(&self) -> ExecutableIdentity {
        self.executable_identity.clone()
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AdapterPlatform {
    Linux,
    MacOs,
    Windows,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AdapterCapability {
    Launch,
    Resume,
    Fork,
    Checkpoint,
    Hibernate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterDescriptor {
    id: String,
    version: String,
    platforms: Vec<AdapterPlatform>,
    capabilities: Vec<AdapterCapability>,
    artifact_kind: String,
    max_artifact_bytes: u64,
}

impl AdapterDescriptor {
    /// Creates a bounded, stable adapter registration descriptor.
    ///
    /// # Errors
    /// Returns an error for malformed identifiers, duplicate/empty declarations,
    /// or an artifact limit outside the application ceiling.
    pub fn new(
        id: impl Into<String>,
        version: impl Into<String>,
        mut platforms: Vec<AdapterPlatform>,
        mut capabilities: Vec<AdapterCapability>,
        artifact_kind: impl Into<String>,
        max_artifact_bytes: u64,
    ) -> Result<Self, AdapterError> {
        let id = id.into();
        let version = version.into();
        let artifact_kind = artifact_kind.into();
        validate_token(&id, MAX_ADAPTER_ID_SCALARS)?;
        validate_token(&version, MAX_ADAPTER_VERSION_SCALARS)?;
        validate_token(&artifact_kind, MAX_ARTIFACT_KIND_SCALARS)?;
        platforms.sort_unstable();
        platforms.dedup();
        capabilities.sort_unstable();
        capabilities.dedup();
        if platforms.is_empty() || capabilities.is_empty() {
            return Err(AdapterError::InvalidDescriptor);
        }
        if max_artifact_bytes == 0 || max_artifact_bytes > MAX_ADAPTER_ARTIFACT_BYTES {
            return Err(AdapterError::InvalidDescriptor);
        }
        Ok(Self {
            id,
            version,
            platforms,
            capabilities,
            artifact_kind,
            max_artifact_bytes,
        })
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }
    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }
    #[must_use]
    pub fn supports_platform(&self, platform: AdapterPlatform) -> bool {
        self.platforms.contains(&platform)
    }
    #[must_use]
    pub fn supports(&self, capability: AdapterCapability) -> bool {
        self.capabilities.contains(&capability)
    }
    #[must_use]
    pub fn artifact_kind(&self) -> &str {
        &self.artifact_kind
    }
    #[must_use]
    pub const fn max_artifact_bytes(&self) -> u64 {
        self.max_artifact_bytes
    }
}

/// Sanitized metadata about an adapter-owned artifact. The artifact bytes are
/// never present in this value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactDescriptor {
    kind: String,
    version: u16,
    digest_sha256: [u8; 32],
    size_bytes: u64,
    created_at_ms: u64,
    expires_at_ms: u64,
}

impl ArtifactDescriptor {
    /// Creates verified, bounded artifact metadata.
    ///
    /// # Errors
    /// Returns an error for mismatched kind, zero version, unsafe time values,
    /// empty/oversized content, or non-increasing expiry.
    pub fn new(
        adapter: &AdapterDescriptor,
        kind: impl Into<String>,
        version: u16,
        digest_sha256: [u8; 32],
        size_bytes: u64,
        created_at_ms: u64,
        expires_at_ms: u64,
    ) -> Result<Self, AdapterError> {
        let kind = kind.into();
        if kind != adapter.artifact_kind
            || version == 0
            || size_bytes == 0
            || size_bytes > adapter.max_artifact_bytes
            || created_at_ms > MAX_SAFE_INTEGER
            || expires_at_ms > MAX_SAFE_INTEGER
            || expires_at_ms <= created_at_ms
        {
            return Err(AdapterError::UnsupportedArtifact);
        }
        Ok(Self {
            kind,
            version,
            digest_sha256,
            size_bytes,
            created_at_ms,
            expires_at_ms,
        })
    }

    #[must_use]
    pub fn kind(&self) -> &str {
        &self.kind
    }
    #[must_use]
    pub const fn version(&self) -> u16 {
        self.version
    }
    #[must_use]
    pub const fn digest_sha256(&self) -> [u8; 32] {
        self.digest_sha256
    }
    #[must_use]
    pub const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }
    #[must_use]
    pub const fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    #[must_use]
    pub const fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

/// Opaque lookup key for an OS credential facility. Its contents cannot be
/// formatted, serialized, cloned, or retrieved from this crate.
pub struct OpaqueSecretReference(String);

impl OpaqueSecretReference {
    /// Wraps a bounded non-empty credential-facility reference.
    ///
    /// # Errors
    /// Returns an error for whitespace, control characters, or excessive length.
    pub fn new(value: impl Into<String>) -> Result<Self, AdapterError> {
        let value = value.into();
        validate_text(&value, MAX_SECRET_REFERENCE_SCALARS)?;
        Ok(Self(value))
    }

    /// Supplies the opaque reference only to trusted adapter code.
    #[must_use]
    pub fn expose_to_adapter(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for OpaqueSecretReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpaqueSecretReference([REDACTED])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterOperationContext {
    pub operation_id: Uuid,
    pub request_hash_sha256: [u8; 32],
    pub agent_session_id: Uuid,
    pub session_revision: u64,
    pub attempt_epoch: u64,
}

impl AdapterOperationContext {
    /// Validates revision and epoch against the current service-owned values.
    ///
    /// # Errors
    /// Returns `StaleRevision` or `StaleAttemptEpoch` on replay.
    pub fn validate(
        &self,
        current_revision: u64,
        current_attempt_epoch: u64,
    ) -> Result<(), AdapterError> {
        if self.session_revision == 0 || self.attempt_epoch == 0 {
            return Err(AdapterError::InvalidOperation);
        }
        if self.session_revision != current_revision {
            return Err(AdapterError::StaleRevision);
        }
        if self.attempt_epoch != current_attempt_epoch {
            return Err(AdapterError::StaleAttemptEpoch);
        }
        if self.session_revision > MAX_SAFE_INTEGER || self.attempt_epoch > MAX_SAFE_INTEGER {
            return Err(AdapterError::InvalidOperation);
        }
        Ok(())
    }
}

pub struct AdapterRequest<'a> {
    pub context: &'a AdapterOperationContext,
    pub platform: AdapterPlatform,
    pub artifact: Option<&'a ArtifactDescriptor>,
    pub credential: Option<&'a OpaqueSecretReference>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchOutcome {
    Launched,
    AlreadyRunning,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResumeOutcome {
    ResumeAttempting,
    Resumed,
    Prepared(TerminalLaunchPlan),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForkOutcome {
    Prepared(ArtifactDescriptor),
    ThreadPrepared {
        destination_agent_session_id: Uuid,
        artifact: ArtifactDescriptor,
        launch: TerminalLaunchPlan,
    },
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CheckpointOutcome {
    Verified(ArtifactDescriptor),
    ConfirmationRequired,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HibernateOutcome {
    ProcessDispositionPending,
    Hibernated,
}

/// Fixed interface implemented only by trusted Rust code registered by the service.
pub trait TrustedAgentAdapter: Send + Sync {
    fn descriptor(&self) -> &AdapterDescriptor;
    /// Launches a fresh tool process.
    ///
    /// # Errors
    /// Returns a typed adapter error when launch cannot be proven or dispatched.
    fn launch(&self, request: AdapterRequest<'_>) -> Result<LaunchOutcome, AdapterError>;
    /// Invokes the tool's documented resume mechanism.
    ///
    /// # Errors
    /// Returns a typed adapter error for unsupported, invalid, stale, or failed resume.
    fn resume(&self, request: AdapterRequest<'_>) -> Result<ResumeOutcome, AdapterError>;
    /// Prepares a sanitized artifact for a new fork identity.
    ///
    /// # Errors
    /// Returns a typed adapter error when fork preparation cannot be verified.
    fn fork(&self, request: AdapterRequest<'_>) -> Result<ForkOutcome, AdapterError>;
    /// Produces or assesses a bounded checkpoint.
    ///
    /// # Errors
    /// Returns a typed adapter error when checkpointing fails or is interrupted.
    fn checkpoint(&self, request: AdapterRequest<'_>) -> Result<CheckpointOutcome, AdapterError>;
    /// Applies the adapter-owned hibernation step after service preconditions.
    ///
    /// # Errors
    /// Returns a typed adapter error when disposition cannot be verified.
    fn hibernate(&self, request: AdapterRequest<'_>) -> Result<HibernateOutcome, AdapterError>;
    /// Removes an exact adapter-created fork after downstream commit failure.
    ///
    /// # Errors
    /// Returns a typed error unless exact compensation is verified.
    fn compensate_fork(&self, _destination: Uuid) -> Result<(), AdapterError> {
        Err(AdapterError::UnsupportedCapability)
    }
}

/// Production adapter for the exact installed Codex CLI protocol version.
pub struct CodexAdapter {
    descriptor: AdapterDescriptor,
    executable: PathBuf,
    executable_identity: ExecutableIdentity,
    timeout: Duration,
}

impl CodexAdapter {
    /// Discovers `codex` on PATH and accepts only the audited CLI version.
    ///
    /// # Errors
    /// Returns a typed error when discovery, trust checks, or version verification fails.
    pub fn discover() -> Result<Self, AdapterError> {
        Self::from_executable(Path::new("codex"))
    }

    /// Constructs an adapter for a fixed executable after verifying its exact version.
    ///
    /// # Errors
    /// Returns a typed error for an insecure, unavailable, or mismatched executable.
    pub fn from_executable(executable: &Path) -> Result<Self, AdapterError> {
        let executable = secure_executable(executable)?;
        let executable_identity = ExecutableIdentity::capture(&executable)
            .map_err(|_| AdapterError::InsecureExecutable)?;
        #[cfg(target_os = "linux")]
        let execution_path = executable_identity.execution_path();
        #[cfg(not(target_os = "linux"))]
        let execution_path = executable.clone();
        let output = Command::new(execution_path)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| AdapterError::Unavailable)?;
        let version = String::from_utf8(output.stdout).map_err(|_| AdapterError::Protocol)?;
        if !output.status.success()
            || !version
                .split_ascii_whitespace()
                .any(|part| part == CODEX_ADAPTER_VERSION)
        {
            return Err(AdapterError::UnsupportedAdapterVersion);
        }
        Ok(Self {
            descriptor: AdapterDescriptor::new(
                CODEX_ADAPTER_ID,
                CODEX_ADAPTER_VERSION,
                vec![AdapterPlatform::Linux],
                vec![
                    AdapterCapability::Resume,
                    AdapterCapability::Fork,
                    AdapterCapability::Checkpoint,
                    AdapterCapability::Hibernate,
                ],
                CODEX_ARTIFACT_KIND,
                64,
            )?,
            executable,
            executable_identity,
            timeout: APP_SERVER_TIMEOUT,
        })
    }

    fn resume_launch(&self, id: Uuid) -> TerminalLaunchPlan {
        TerminalLaunchPlan {
            executable: self.executable.clone(),
            arguments: vec![
                "resume".to_owned(),
                id.to_string(),
                "--no-alt-screen".to_owned(),
            ],
            executable_identity: self.executable_identity.clone(),
        }
    }

    fn artifact(&self, id: Uuid, now_ms: u64) -> Result<ArtifactDescriptor, AdapterError> {
        let mut hasher = Sha256::new();
        hasher.update(b"codex-thread-v1\0");
        hasher.update(id.as_bytes());
        let digest: [u8; 32] = hasher.finalize().into();
        ArtifactDescriptor::new(
            &self.descriptor,
            CODEX_ARTIFACT_KIND,
            1,
            digest,
            16,
            now_ms,
            now_ms.saturating_add(30_000),
        )
    }

    /// Verifies that app-server can read the exact thread without loading turns.
    ///
    /// # Errors
    /// Returns a typed protocol, identity, timeout, or process error.
    pub fn verify_thread(&self, id: Uuid) -> Result<(), AdapterError> {
        let returned = self.app_server(ThreadMethod::Read(id))?;
        (returned == id)
            .then_some(())
            .ok_or(AdapterError::IdentityMismatch)
    }

    /// Reads one exact Codex thread through the audited 0.142.4 app-server contract and projects
    /// only bounded user/assistant text. Tool calls, commands, reasoning, images, paths, and any
    /// record carrying unexpected fields are skipped.
    ///
    /// # Errors
    /// Returns a typed identity, cancellation, resource, protocol, or executable-trust error.
    pub fn read_transcript(
        &self,
        id: Uuid,
        cancellation: &AtomicBool,
    ) -> Result<CodexTranscript, AdapterError> {
        if cancellation.load(Ordering::Relaxed) {
            return Err(AdapterError::Interrupted);
        }
        verify_secure_executable(&self.executable)?;
        self.executable_identity
            .revalidate(&self.executable)
            .map_err(|_| AdapterError::InsecureExecutable)?;
        #[cfg(target_os = "linux")]
        let execution_path = self.executable_identity.execution_path();
        #[cfg(not(target_os = "linux"))]
        let execution_path = self.executable.clone();
        let mut child = Command::new(execution_path)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| AdapterError::Unavailable)?;
        let result = run_app_server_transcript(&mut child, id, self.timeout, cancellation);
        let _ = child.kill();
        let _ = child.wait();
        result
    }

    fn fork_exact(&self, id: Uuid) -> Result<Uuid, AdapterError> {
        let destination = self.app_server(ThreadMethod::Fork(id))?;
        if destination == id {
            return Err(AdapterError::IdentityMismatch);
        }
        Ok(destination)
    }

    fn archive_exact(&self, id: Uuid) -> Result<(), AdapterError> {
        let returned = self.app_server(ThreadMethod::Archive(id))?;
        (returned == id)
            .then_some(())
            .ok_or(AdapterError::IdentityMismatch)
    }

    fn app_server(&self, method: ThreadMethod) -> Result<Uuid, AdapterError> {
        self.app_server_with_hook(method, || {})
    }

    fn app_server_with_hook<F>(
        &self,
        method: ThreadMethod,
        after_revalidation: F,
    ) -> Result<Uuid, AdapterError>
    where
        F: FnOnce(),
    {
        verify_secure_executable(&self.executable)?;
        self.executable_identity
            .revalidate(&self.executable)
            .map_err(|_| AdapterError::InsecureExecutable)?;
        after_revalidation();
        #[cfg(target_os = "linux")]
        let execution_path = self.executable_identity.execution_path();
        #[cfg(not(target_os = "linux"))]
        let execution_path = self.executable.clone();
        let mut child = Command::new(execution_path)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| AdapterError::Unavailable)?;
        let result = run_app_server(&mut child, method, self.timeout);
        let _ = child.kill();
        let _ = child.wait();
        result
    }
}

impl TrustedAgentAdapter for CodexAdapter {
    fn descriptor(&self) -> &AdapterDescriptor {
        &self.descriptor
    }
    fn launch(&self, _: AdapterRequest<'_>) -> Result<LaunchOutcome, AdapterError> {
        Err(AdapterError::UnsupportedCapability)
    }
    fn resume(&self, request: AdapterRequest<'_>) -> Result<ResumeOutcome, AdapterError> {
        self.verify_thread(request.context.agent_session_id)?;
        Ok(ResumeOutcome::Prepared(
            self.resume_launch(request.context.agent_session_id),
        ))
    }
    fn fork(&self, request: AdapterRequest<'_>) -> Result<ForkOutcome, AdapterError> {
        let destination = self.fork_exact(request.context.agent_session_id)?;
        Ok(ForkOutcome::ThreadPrepared {
            destination_agent_session_id: destination,
            artifact: self.artifact(destination, current_time_ms()?)?,
            launch: self.resume_launch(destination),
        })
    }
    fn checkpoint(&self, request: AdapterRequest<'_>) -> Result<CheckpointOutcome, AdapterError> {
        self.verify_thread(request.context.agent_session_id)?;
        Ok(CheckpointOutcome::Verified(self.artifact(
            request.context.agent_session_id,
            current_time_ms()?,
        )?))
    }
    fn hibernate(&self, request: AdapterRequest<'_>) -> Result<HibernateOutcome, AdapterError> {
        self.verify_thread(request.context.agent_session_id)?;
        Ok(HibernateOutcome::ProcessDispositionPending)
    }
    fn compensate_fork(&self, destination: Uuid) -> Result<(), AdapterError> {
        self.archive_exact(destination)
    }
}

#[derive(Clone, Copy)]
enum ThreadMethod {
    Read(Uuid),
    Fork(Uuid),
    Archive(Uuid),
}

#[derive(Serialize)]
struct RpcRequest<P> {
    id: u8,
    method: &'static str,
    params: P,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    client_info: ClientInfo,
}
#[derive(Serialize)]
struct ClientInfo {
    name: &'static str,
    title: &'static str,
    version: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    thread_id: String,
    include_turns: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkParams {
    thread_id: String,
    exclude_turns: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveParams {
    thread_id: String,
}
#[derive(Serialize)]
struct Notification {
    method: &'static str,
}
#[derive(Deserialize)]
struct ThreadResponse {
    id: u8,
    result: Option<ThreadResult>,
    error: Option<RpcError>,
}
#[derive(Deserialize)]
struct ResponseId {
    id: u8,
}
#[derive(Deserialize)]
struct InitializeResponse {
    id: u8,
    result: Option<InitializeResult>,
    error: Option<RpcError>,
}
#[derive(Deserialize)]
struct InitializeResult {}
#[derive(Deserialize)]
struct AckResponse {
    id: u8,
    result: Option<AckResult>,
    error: Option<RpcError>,
}
#[derive(Deserialize)]
struct AckResult {}
#[derive(Deserialize)]
struct ThreadResult {
    thread: ThreadIdentity,
}
#[derive(Deserialize)]
struct ThreadIdentity {
    id: String,
}
#[derive(Deserialize)]
struct RpcError {}

#[derive(Deserialize)]
struct TranscriptResponse {
    id: u8,
    result: Option<TranscriptResult>,
    error: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct TranscriptResult {
    thread: TranscriptThread,
}

#[derive(Deserialize)]
#[allow(clippy::zero_sized_map_values)]
struct TranscriptThread {
    id: String,
    turns: Vec<TranscriptTurn>,
    #[serde(flatten)]
    _metadata: BTreeMap<String, IgnoredAny>,
}

impl Drop for TranscriptThread {
    fn drop(&mut self) {
        self.id.zeroize();
    }
}

#[derive(Deserialize)]
#[allow(clippy::zero_sized_map_values)]
struct TranscriptTurn {
    items: Vec<TranscriptItem>,
    #[serde(flatten)]
    _metadata: BTreeMap<String, IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::zero_sized_map_values)]
struct TranscriptItem {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: Option<IgnoredAny>,
    #[serde(default)]
    client_id: Option<IgnoredAny>,
    #[serde(default)]
    content: Option<Vec<TranscriptUserContent>>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    phase: Option<IgnoredAny>,
    #[serde(default)]
    memory_citation: Option<IgnoredAny>,
    #[serde(flatten)]
    extra: BTreeMap<String, IgnoredAny>,
}

impl Drop for TranscriptItem {
    fn drop(&mut self) {
        self.kind.zeroize();
        if let Some(text) = &mut self.text {
            text.zeroize();
        }
    }
}

#[derive(Deserialize)]
#[allow(clippy::zero_sized_map_values)]
struct TranscriptUserContent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    text_elements: Option<IgnoredAny>,
    #[serde(flatten)]
    extra: BTreeMap<String, IgnoredAny>,
}

impl Drop for TranscriptUserContent {
    fn drop(&mut self) {
        self.kind.zeroize();
        if let Some(text) = &mut self.text {
            text.zeroize();
        }
    }
}

fn write_line<T: Serialize>(stdin: &mut impl Write, value: &T) -> Result<(), AdapterError> {
    serde_json::to_writer(&mut *stdin, value).map_err(|_| AdapterError::Protocol)?;
    stdin
        .write_all(b"\n")
        .map_err(|_| AdapterError::Interrupted)?;
    stdin.flush().map_err(|_| AdapterError::Interrupted)
}

fn run_app_server(
    child: &mut Child,
    method: ThreadMethod,
    timeout: Duration,
) -> Result<Uuid, AdapterError> {
    let mut stdin = child.stdin.take().ok_or(AdapterError::Protocol)?;
    let stdout = child.stdout.take().ok_or(AdapterError::Protocol)?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        for _ in 0..MAX_PROTOCOL_LINES {
            let mut line = String::new();
            match (&mut reader)
                .take((MAX_PROTOCOL_LINE_BYTES + 1) as u64)
                .read_line(&mut line)
            {
                Ok(0) | Err(_) => {
                    let _ = sender.send(Err(AdapterError::Interrupted));
                    return;
                }
                Ok(_) if line.len() > MAX_PROTOCOL_LINE_BYTES => {
                    let _ = sender.send(Err(AdapterError::Protocol));
                    return;
                }
                Ok(_) => {
                    if sender.send(Ok(line)).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = sender.send(Err(AdapterError::Protocol));
    });
    write_line(
        &mut stdin,
        &RpcRequest {
            id: 1,
            method: "initialize",
            params: InitializeParams {
                client_info: ClientInfo {
                    name: "cmux-linux-alternative",
                    title: "cmux",
                    version: env!("CARGO_PKG_VERSION"),
                },
            },
        },
    )?;
    receive_initialize(&receiver, timeout)?;
    write_line(
        &mut stdin,
        &Notification {
            method: "initialized",
        },
    )?;
    match method {
        ThreadMethod::Read(id) => write_line(
            &mut stdin,
            &RpcRequest {
                id: 2,
                method: "thread/read",
                params: ReadParams {
                    thread_id: id.to_string(),
                    include_turns: false,
                },
            },
        )?,
        ThreadMethod::Fork(id) => write_line(
            &mut stdin,
            &RpcRequest {
                id: 2,
                method: "thread/fork",
                params: ForkParams {
                    thread_id: id.to_string(),
                    exclude_turns: true,
                },
            },
        )?,
        ThreadMethod::Archive(id) => write_line(
            &mut stdin,
            &RpcRequest {
                id: 2,
                method: "thread/archive",
                params: ArchiveParams {
                    thread_id: id.to_string(),
                },
            },
        )?,
    }
    drop(stdin);
    let value = match method {
        ThreadMethod::Archive(id) => {
            receive_ack(&receiver, timeout)?;
            id.to_string()
        }
        ThreadMethod::Read(_) | ThreadMethod::Fork(_) => receive_thread(&receiver, timeout)?,
    };
    Uuid::parse_str(&value).map_err(|_| AdapterError::Protocol)
}

fn run_app_server_transcript(
    child: &mut Child,
    thread_id: Uuid,
    timeout: Duration,
    cancellation: &AtomicBool,
) -> Result<CodexTranscript, AdapterError> {
    let mut stdin = child.stdin.take().ok_or(AdapterError::Protocol)?;
    let stdout = child.stdout.take().ok_or(AdapterError::Protocol)?;
    let (sender, receiver) = mpsc::sync_channel(4);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        for _ in 0..MAX_PROTOCOL_LINES {
            let mut line = String::new();
            match (&mut reader)
                .take((MAX_TRANSCRIPT_BYTES + 1) as u64)
                .read_line(&mut line)
            {
                Ok(0) | Err(_) => {
                    let _ = sender.send(Err(AdapterError::Interrupted));
                    return;
                }
                Ok(_) if line.len() > MAX_TRANSCRIPT_BYTES => {
                    let _ = sender.send(Err(AdapterError::ResourceLimit));
                    return;
                }
                Ok(_) => {
                    if sender.send(Ok(Zeroizing::new(line))).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = sender.send(Err(AdapterError::Protocol));
    });
    let deadline = Instant::now() + timeout;
    write_line(
        &mut stdin,
        &RpcRequest {
            id: 1,
            method: "initialize",
            params: InitializeParams {
                client_info: ClientInfo {
                    name: "cmux-linux-alternative",
                    title: "cmux",
                    version: env!("CARGO_PKG_VERSION"),
                },
            },
        },
    )?;
    receive_initialize_cancellable(&receiver, deadline, cancellation)?;
    write_line(
        &mut stdin,
        &Notification {
            method: "initialized",
        },
    )?;
    write_line(
        &mut stdin,
        &RpcRequest {
            id: 2,
            method: "thread/read",
            params: ReadParams {
                thread_id: thread_id.to_string(),
                include_turns: true,
            },
        },
    )?;
    drop(stdin);
    receive_transcript(&receiver, deadline, thread_id, cancellation)
}

fn receive_initialize_cancellable(
    receiver: &mpsc::Receiver<Result<Zeroizing<String>, AdapterError>>,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<(), AdapterError> {
    for _ in 0..MAX_PROTOCOL_LINES {
        let line = receive_cancellable(receiver, deadline, cancellation)?;
        let Ok(id) = serde_json::from_str::<ResponseId>(&line) else {
            continue;
        };
        if id.id != 1 {
            return Err(AdapterError::Protocol);
        }
        let response: InitializeResponse =
            serde_json::from_str(&line).map_err(|_| AdapterError::Protocol)?;
        return if response.id == 1 && response.result.is_some() && response.error.is_none() {
            Ok(())
        } else if response.error.is_some() {
            Err(AdapterError::Declined)
        } else {
            Err(AdapterError::Protocol)
        };
    }
    Err(AdapterError::Protocol)
}

fn receive_transcript(
    receiver: &mpsc::Receiver<Result<Zeroizing<String>, AdapterError>>,
    deadline: Instant,
    expected_thread_id: Uuid,
    cancellation: &AtomicBool,
) -> Result<CodexTranscript, AdapterError> {
    for _ in 0..MAX_PROTOCOL_LINES {
        let line = receive_cancellable(receiver, deadline, cancellation)?;
        let Ok(id) = serde_json::from_str::<ResponseId>(&line) else {
            continue;
        };
        if id.id != 2 {
            return Err(AdapterError::Protocol);
        }
        let response: TranscriptResponse =
            serde_json::from_str(&line).map_err(|_| AdapterError::Protocol)?;
        if response.id != 2 {
            return Err(AdapterError::Protocol);
        }
        let Some(result) = response.result else {
            return Err(if response.error.is_some() {
                AdapterError::Declined
            } else {
                AdapterError::Protocol
            });
        };
        if Uuid::parse_str(&result.thread.id).ok() != Some(expected_thread_id) {
            return Err(AdapterError::IdentityMismatch);
        }
        let mut thread = result.thread;
        return project_transcript(std::mem::take(&mut thread.turns), cancellation);
    }
    Err(AdapterError::Protocol)
}

fn receive_cancellable(
    receiver: &mpsc::Receiver<Result<Zeroizing<String>, AdapterError>>,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<Zeroizing<String>, AdapterError> {
    loop {
        if cancellation.load(Ordering::Relaxed) {
            return Err(AdapterError::Interrupted);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(AdapterError::Interrupted);
        }
        match receiver.recv_timeout(
            deadline
                .saturating_duration_since(now)
                .min(Duration::from_millis(25)),
        ) {
            Ok(value) => return value,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(AdapterError::Interrupted),
        }
    }
}

fn project_transcript(
    turns: Vec<TranscriptTurn>,
    cancellation: &AtomicBool,
) -> Result<CodexTranscript, AdapterError> {
    let mut transcript = CodexTranscript {
        messages: Vec::new(),
        skipped_items: 0,
    };
    let mut bytes = 0_usize;
    for mut turn in turns {
        for mut item in std::mem::take(&mut turn.items) {
            if cancellation.load(Ordering::Relaxed) {
                return Err(AdapterError::Interrupted);
            }
            if transcript.messages.len() == MAX_TRANSCRIPT_MESSAGES {
                transcript.skipped_items = transcript.skipped_items.saturating_add(1);
                continue;
            }
            let projected = match item.kind.as_str() {
                "userMessage"
                    if item.id.is_some()
                        && item.extra.is_empty()
                        && item.text.is_none()
                        && item.phase.is_none()
                        && item.memory_citation.is_none() =>
                {
                    let mut chunks = Vec::new();
                    let Some(content) = item.content.take() else {
                        transcript.skipped_items = transcript.skipped_items.saturating_add(1);
                        continue;
                    };
                    let mut valid = true;
                    for mut value in content {
                        if value.kind == "text"
                            && value.extra.is_empty()
                            && value.text_elements.is_some()
                            && let Some(text) = value.text.take()
                            && text.len() <= MAX_TRANSCRIPT_MESSAGE_BYTES
                        {
                            chunks.push(text);
                        } else {
                            valid = false;
                            break;
                        }
                    }
                    if !valid || chunks.is_empty() {
                        transcript.skipped_items = transcript.skipped_items.saturating_add(1);
                        continue;
                    }
                    Some((CodexTranscriptRole::User, chunks.join("\n")))
                }
                "agentMessage"
                    if item.id.is_some()
                        && item.extra.is_empty()
                        && item.content.is_none()
                        && item.client_id.is_none() =>
                {
                    item.text
                        .take()
                        .filter(|text| text.len() <= MAX_TRANSCRIPT_MESSAGE_BYTES)
                        .map(|text| (CodexTranscriptRole::Assistant, text))
                }
                _ => None,
            };
            let Some((role, text)) = projected else {
                transcript.skipped_items = transcript.skipped_items.saturating_add(1);
                continue;
            };
            bytes = bytes
                .checked_add(text.len())
                .ok_or(AdapterError::ResourceLimit)?;
            if bytes > MAX_TRANSCRIPT_BYTES {
                return Err(AdapterError::ResourceLimit);
            }
            transcript.messages.push(CodexTranscriptMessage {
                role,
                text: Zeroizing::new(text),
            });
        }
    }
    Ok(transcript)
}

fn receive_ack(
    receiver: &mpsc::Receiver<Result<String, AdapterError>>,
    timeout: Duration,
) -> Result<(), AdapterError> {
    for _ in 0..MAX_PROTOCOL_LINES {
        let line = receiver
            .recv_timeout(timeout)
            .map_err(|_| AdapterError::Interrupted)??;
        let Ok(id) = serde_json::from_str::<ResponseId>(&line) else {
            continue;
        };
        if id.id != 2 {
            return Err(AdapterError::Protocol);
        }
        let response: AckResponse =
            serde_json::from_str(&line).map_err(|_| AdapterError::Protocol)?;
        if response.id != 2 {
            return Err(AdapterError::Protocol);
        }
        if response.result.is_some() && response.error.is_none() {
            return Ok(());
        }
        return Err(if response.error.is_some() {
            AdapterError::Declined
        } else {
            AdapterError::Protocol
        });
    }
    Err(AdapterError::Protocol)
}

fn receive_initialize(
    receiver: &mpsc::Receiver<Result<String, AdapterError>>,
    timeout: Duration,
) -> Result<(), AdapterError> {
    for _ in 0..MAX_PROTOCOL_LINES {
        let line = receiver
            .recv_timeout(timeout)
            .map_err(|_| AdapterError::Interrupted)??;
        let Ok(id) = serde_json::from_str::<ResponseId>(&line) else {
            continue;
        };
        if id.id != 1 {
            return Err(AdapterError::Protocol);
        }
        let response: InitializeResponse =
            serde_json::from_str(&line).map_err(|_| AdapterError::Protocol)?;
        if response.id != 1 {
            return Err(AdapterError::Protocol);
        }
        if response.result.is_some() && response.error.is_none() {
            return Ok(());
        }
        return Err(if response.error.is_some() {
            AdapterError::Declined
        } else {
            AdapterError::Protocol
        });
    }
    Err(AdapterError::Protocol)
}

fn receive_thread(
    receiver: &mpsc::Receiver<Result<String, AdapterError>>,
    timeout: Duration,
) -> Result<String, AdapterError> {
    for _ in 0..MAX_PROTOCOL_LINES {
        let line = receiver
            .recv_timeout(timeout)
            .map_err(|_| AdapterError::Interrupted)??;
        let Ok(id) = serde_json::from_str::<ResponseId>(&line) else {
            continue;
        };
        if id.id != 2 {
            return Err(AdapterError::Protocol);
        }
        let response: ThreadResponse =
            serde_json::from_str(&line).map_err(|_| AdapterError::Protocol)?;
        if response.id != 2 {
            return Err(AdapterError::Protocol);
        }
        if let Some(result) = response.result {
            return Ok(result.thread.id);
        }
        if response.error.is_some() {
            return Err(AdapterError::Declined);
        }
        return Err(AdapterError::Protocol);
    }
    Err(AdapterError::Protocol)
}

fn secure_executable(path: &Path) -> Result<PathBuf, AdapterError> {
    let candidate = if path.components().count() > 1 {
        path.to_path_buf()
    } else {
        std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|root| root.join(path))
                    .find(|item| item.is_file())
            })
            .ok_or(AdapterError::Unavailable)?
    };
    let canonical = std::fs::canonicalize(candidate).map_err(|_| AdapterError::Unavailable)?;
    verify_secure_executable(&canonical)?;
    Ok(canonical)
}

#[cfg(unix)]
fn verify_secure_executable(path: &Path) -> Result<(), AdapterError> {
    use std::os::unix::fs::PermissionsExt as _;
    let metadata = std::fs::metadata(path).map_err(|_| AdapterError::Unavailable)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o022 != 0 {
        return Err(AdapterError::InsecureExecutable);
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_secure_executable(_: &Path) -> Result<(), AdapterError> {
    Err(AdapterError::UnsupportedPlatform)
}

fn current_time_ms() -> Result<u64, AdapterError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AdapterError::InvalidOperation)?
        .as_millis()
        .try_into()
        .map_err(|_| AdapterError::InvalidOperation)
}

#[derive(Default)]
pub struct TrustedAdapterRegistry {
    adapters: BTreeMap<(String, String), Arc<dyn TrustedAgentAdapter>>,
}

impl TrustedAdapterRegistry {
    /// Registers service-owned adapter code by its exact stable ID and version.
    ///
    /// # Errors
    /// Returns `DuplicateRegistration` when the pair already exists.
    pub fn register(&mut self, adapter: Arc<dyn TrustedAgentAdapter>) -> Result<(), AdapterError> {
        let descriptor = adapter.descriptor();
        let key = (descriptor.id.clone(), descriptor.version.clone());
        if self.adapters.contains_key(&key) {
            return Err(AdapterError::DuplicateRegistration);
        }
        self.adapters.insert(key, adapter);
        Ok(())
    }

    /// Resolves an exact adapter/version/platform/capability/artifact tuple.
    ///
    /// # Errors
    /// Returns a typed unsupported error rather than falling back to another version.
    pub fn resolve(
        &self,
        id: &str,
        version: &str,
        platform: AdapterPlatform,
        capability: AdapterCapability,
        artifact: Option<&ArtifactDescriptor>,
        now_ms: u64,
    ) -> Result<Arc<dyn TrustedAgentAdapter>, AdapterError> {
        if now_ms > MAX_SAFE_INTEGER {
            return Err(AdapterError::InvalidOperation);
        }
        let adapter = self
            .adapters
            .get(&(id.to_owned(), version.to_owned()))
            .ok_or(AdapterError::UnsupportedAdapterVersion)?;
        let descriptor = adapter.descriptor();
        if !descriptor.supports_platform(platform) {
            return Err(AdapterError::UnsupportedPlatform);
        }
        if !descriptor.supports(capability) {
            return Err(AdapterError::UnsupportedCapability);
        }
        if artifact.is_some_and(|value| {
            value.kind != descriptor.artifact_kind
                || value.size_bytes > descriptor.max_artifact_bytes
                || value.expires_at_ms <= now_ms
        }) {
            return Err(AdapterError::UnsupportedArtifact);
        }
        Ok(Arc::clone(adapter))
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum AdapterError {
    #[error("invalid adapter descriptor")]
    InvalidDescriptor,
    #[error("invalid adapter operation")]
    InvalidOperation,
    #[error("adapter registration already exists")]
    DuplicateRegistration,
    #[error("adapter ID or version is not registered")]
    UnsupportedAdapterVersion,
    #[error("adapter does not support this platform")]
    UnsupportedPlatform,
    #[error("adapter does not support this capability")]
    UnsupportedCapability,
    #[error("artifact is unsupported, mismatched, stale, or malformed")]
    UnsupportedArtifact,
    #[error("session revision is stale")]
    StaleRevision,
    #[error("attempt epoch is stale")]
    StaleAttemptEpoch,
    #[error("adapter operation was interrupted")]
    Interrupted,
    #[error("adapter operation exceeded its fixed resource limit")]
    ResourceLimit,
    #[error("adapter declined the operation")]
    Declined,
    #[error("adapter executable is unavailable")]
    Unavailable,
    #[error("adapter protocol response is invalid")]
    Protocol,
    #[error("adapter returned a different session identity")]
    IdentityMismatch,
    #[error("adapter executable is not a secure regular file")]
    InsecureExecutable,
}

fn validate_token(value: &str, max: usize) -> Result<(), AdapterError> {
    validate_text(value, max)?;
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(AdapterError::InvalidDescriptor)
    }
}

fn validate_text(value: &str, max: usize) -> Result<(), AdapterError> {
    if !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= max
        && value.chars().all(|c| !c.is_control())
    {
        Ok(())
    } else {
        Err(AdapterError::InvalidDescriptor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    struct TestAdapter {
        descriptor: AdapterDescriptor,
    }
    impl TrustedAgentAdapter for TestAdapter {
        fn descriptor(&self) -> &AdapterDescriptor {
            &self.descriptor
        }
        fn launch(&self, _: AdapterRequest<'_>) -> Result<LaunchOutcome, AdapterError> {
            Ok(LaunchOutcome::Launched)
        }
        fn resume(&self, _: AdapterRequest<'_>) -> Result<ResumeOutcome, AdapterError> {
            Ok(ResumeOutcome::Resumed)
        }
        fn fork(&self, _: AdapterRequest<'_>) -> Result<ForkOutcome, AdapterError> {
            Err(AdapterError::Declined)
        }
        fn checkpoint(&self, _: AdapterRequest<'_>) -> Result<CheckpointOutcome, AdapterError> {
            Ok(CheckpointOutcome::ConfirmationRequired)
        }
        fn hibernate(&self, _: AdapterRequest<'_>) -> Result<HibernateOutcome, AdapterError> {
            Ok(HibernateOutcome::ProcessDispositionPending)
        }
    }

    fn descriptor() -> AdapterDescriptor {
        AdapterDescriptor::new(
            "codex",
            "1.0",
            vec![AdapterPlatform::Linux],
            vec![AdapterCapability::Launch, AdapterCapability::Resume],
            "resume-v1",
            1024,
        )
        .unwrap()
    }

    #[cfg(unix)]
    fn fake_codex(response: &str) -> (tempfile::TempDir, PathBuf) {
        fake_codex_with_init("{\"id\":1,\"result\":{}}", response)
    }

    #[cfg(unix)]
    fn fake_codex_with_init(init_response: &str, response: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("codex");
        std::fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.142.4"
  exit 0
fi
IFS= read -r initialize
printf '%s\n' '{init_response}'
IFS= read -r initialized
IFS= read -r request
printf '%s\n' '{response}'
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        (directory, executable)
    }

    #[cfg(unix)]
    #[test]
    fn codex_adapter_reads_and_forks_exact_ids_with_closed_launch_plan() {
        let source = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let destination = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let (_directory, executable) = fake_codex(&format!(
            "{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"{source}\"}}}}}}"
        ));
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        adapter.verify_thread(source).unwrap();

        let (_directory, executable) = fake_codex(&format!(
            "{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"{destination}\"}}}}}}"
        ));
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        let context = AdapterOperationContext {
            operation_id: Uuid::new_v4(),
            request_hash_sha256: [1; 32],
            agent_session_id: source,
            session_revision: 1,
            attempt_epoch: 1,
        };
        let ForkOutcome::ThreadPrepared {
            destination_agent_session_id,
            launch,
            ..
        } = adapter
            .fork(AdapterRequest {
                context: &context,
                platform: AdapterPlatform::Linux,
                artifact: None,
                credential: None,
            })
            .unwrap()
        else {
            panic!("Codex must return an exact thread plan")
        };
        assert_eq!(destination_agent_session_id, destination);
        assert_eq!(
            launch.command(),
            vec![
                executable.to_string_lossy(),
                "resume".into(),
                destination.to_string().into(),
                "--no-alt-screen".into()
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_transcript_projection_is_exact_bounded_and_cancellable() {
        let source = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let response = serde_json::json!({
            "id": 2,
            "result": {
                "thread": {
                    "id": source,
                    "path": "/must/not/escape",
                    "turns": [{
                        "id": "turn-1",
                        "items": [
                            {"type":"userMessage","id":"u","clientId":null,"content":[{"type":"text","text":"safe user","text_elements":[]}]},
                            {"type":"agentMessage","id":"a","text":"safe assistant","phase":null,"memoryCitation":null},
                            {"type":"commandExecution","id":"c","command":"secret command","aggregatedOutput":"secret output"},
                            {"type":"agentMessage","id":"bad","text":"must skip","phase":null,"memoryCitation":null,"apiKey":"secret"}
                        ]
                    }]
                }
            }
        });
        let (_directory, executable) = fake_codex(&response.to_string());
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        let cancellation = AtomicBool::new(false);
        let transcript = adapter.read_transcript(source, &cancellation).unwrap();
        assert_eq!(transcript.messages.len(), 2);
        assert_eq!(transcript.messages[0].role, CodexTranscriptRole::User);
        assert_eq!(transcript.messages[0].text.as_str(), "safe user");
        assert_eq!(transcript.messages[1].role, CodexTranscriptRole::Assistant);
        assert_eq!(transcript.messages[1].text.as_str(), "safe assistant");
        assert_eq!(transcript.skipped_items, 2);

        cancellation.store(true, Ordering::Relaxed);
        assert!(matches!(
            adapter.read_transcript(source, &cancellation),
            Err(AdapterError::Interrupted)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn codex_app_server_executes_sealed_snapshot_after_path_swap() {
        let source = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let replacement_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let (_trusted_directory, executable) = fake_codex(&format!(
            "{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"{source}\"}}}}}}"
        ));
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        let (_replacement_directory, replacement) = fake_codex(&format!(
            "{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"{replacement_id}\"}}}}}}"
        ));

        let returned = adapter
            .app_server_with_hook(ThreadMethod::Read(source), || {
                std::fs::rename(&replacement, &executable).unwrap();
            })
            .unwrap();
        assert_eq!(returned, source);
    }

    #[cfg(unix)]
    #[test]
    fn codex_adapter_rejects_rpc_errors_and_insecure_executables() {
        let id = Uuid::new_v4();
        let (_directory, executable) = fake_codex("{\"id\":2,\"error\":{\"code\":-32602}}");
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        assert_eq!(adapter.verify_thread(id), Err(AdapterError::Declined));

        let (_directory, executable) = fake_codex("{}");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(
            CodexAdapter::from_executable(&executable),
            Err(AdapterError::InsecureExecutable)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn codex_adapter_requires_successful_initialize_before_thread_rpc() {
        let id = Uuid::new_v4();
        let (_directory, executable) = fake_codex_with_init(
            "{\"id\":1,\"error\":{\"code\":-32600}}",
            &format!("{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"{id}\"}}}}}}"),
        );
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        assert_eq!(adapter.verify_thread(id), Err(AdapterError::Declined));

        let (_directory, executable) = fake_codex_with_init(
            &format!("{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"{id}\"}}}}}}"),
            "{}",
        );
        let adapter = CodexAdapter::from_executable(&executable).unwrap();
        assert_eq!(adapter.verify_thread(id), Err(AdapterError::Protocol));
    }

    #[test]
    fn exact_registry_resolution_rejects_unsupported_inputs() {
        let mut registry = TrustedAdapterRegistry::default();
        registry
            .register(Arc::new(TestAdapter {
                descriptor: descriptor(),
            }))
            .unwrap();
        assert!(
            registry
                .resolve(
                    "codex",
                    "1.0",
                    AdapterPlatform::Linux,
                    AdapterCapability::Resume,
                    None,
                    1
                )
                .is_ok()
        );
        assert_eq!(
            registry
                .resolve(
                    "codex",
                    "2.0",
                    AdapterPlatform::Linux,
                    AdapterCapability::Resume,
                    None,
                    1
                )
                .err(),
            Some(AdapterError::UnsupportedAdapterVersion)
        );
        assert_eq!(
            registry
                .resolve(
                    "codex",
                    "1.0",
                    AdapterPlatform::Windows,
                    AdapterCapability::Resume,
                    None,
                    1
                )
                .err(),
            Some(AdapterError::UnsupportedPlatform)
        );
        assert_eq!(
            registry
                .resolve(
                    "codex",
                    "1.0",
                    AdapterPlatform::Linux,
                    AdapterCapability::Fork,
                    None,
                    1
                )
                .err(),
            Some(AdapterError::UnsupportedCapability)
        );
        let artifact =
            ArtifactDescriptor::new(&descriptor(), "resume-v1", 1, [7; 32], 1, 1, 10).unwrap();
        assert_eq!(
            registry
                .resolve(
                    "codex",
                    "1.0",
                    AdapterPlatform::Linux,
                    AdapterCapability::Resume,
                    Some(&artifact),
                    10,
                )
                .err(),
            Some(AdapterError::UnsupportedArtifact)
        );
    }

    #[test]
    fn artifact_and_operation_validation_fail_closed() {
        let adapter = descriptor();
        assert_eq!(
            ArtifactDescriptor::new(&adapter, "other", 1, [7; 32], 1, 1, 2),
            Err(AdapterError::UnsupportedArtifact)
        );
        let operation = AdapterOperationContext {
            operation_id: Uuid::new_v4(),
            request_hash_sha256: [1; 32],
            agent_session_id: Uuid::new_v4(),
            session_revision: 4,
            attempt_epoch: 2,
        };
        assert_eq!(operation.validate(3, 2), Err(AdapterError::StaleRevision));
        assert_eq!(
            operation.validate(4, 3),
            Err(AdapterError::StaleAttemptEpoch)
        );
        let zero = AdapterOperationContext {
            session_revision: 0,
            ..operation
        };
        assert_eq!(zero.validate(0, 2), Err(AdapterError::InvalidOperation));
    }

    #[test]
    fn secret_debug_output_is_redacted() {
        let secret = OpaqueSecretReference::new("credential-store:item-42").unwrap();
        let output = format!("{secret:?}");
        assert_eq!(output, "OpaqueSecretReference([REDACTED])");
        assert!(!output.contains("item-42"));
    }

    proptest! {
        #[test]
        fn stale_revision_or_epoch_never_validates(
            revision in 1_u64..=1_000_000,
            epoch in 1_u64..=1_000_000,
            revision_delta in 1_u64..=1_000,
            epoch_delta in 1_u64..=1_000,
        ) {
            let operation = AdapterOperationContext {
                operation_id: Uuid::new_v4(),
                request_hash_sha256: [1; 32],
                agent_session_id: Uuid::new_v4(),
                session_revision: revision,
                attempt_epoch: epoch,
            };
            prop_assert_eq!(operation.validate(revision + revision_delta, epoch), Err(AdapterError::StaleRevision));
            prop_assert_eq!(operation.validate(revision, epoch + epoch_delta), Err(AdapterError::StaleAttemptEpoch));
        }
    }
}

//! Cross-platform PTY ownership, ordered output journals, and renderer checkpoints.

use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use portable_pty::{
    Child, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system,
};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

pub mod remote;

pub const MAX_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;
const STARTUP_JOURNAL_LIMIT_BYTES: usize = 512 * 1024;
/// Maximum raw output retained after a renderer checkpoint has been accepted.
pub const POST_CHECKPOINT_JOURNAL_LIMIT_BYTES: usize = 256 * 1024;
const CHECKPOINT_REQUEST_THRESHOLD_BYTES: usize = 64 * 1024;
const MAX_CHECKPOINT_BYTES: usize = 512 * 1024;
const EVENT_CHANNEL_CAPACITY: usize = 1024;
const MAX_RETAINED_EXITED_SESSIONS: usize = 64;
const MAX_NOTIFICATION_TITLE_SCALARS: usize = 256;
const MAX_NOTIFICATION_BODY_SCALARS: usize = 4096;
// Four bytes per Unicode scalar plus the longest supported OSC command prefix.
const MAX_OSC_NOTIFICATION_PAYLOAD_BYTES: usize =
    4 * (MAX_NOTIFICATION_TITLE_SCALARS + MAX_NOTIFICATION_BODY_SCALARS) + 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalSpawnRequest {
    pub rows: u16,
    pub cols: u16,
    pub cwd: Option<PathBuf>,
    pub command: Option<Vec<String>>,
    /// Ephemeral identity fence for a pre-audited executable. Never persisted.
    pub executable_identity: Option<ExecutableIdentity>,
    pub environment: Vec<(String, String)>,
}

impl Default for TerminalSpawnRequest {
    fn default() -> Self {
        Self {
            rows: 24,
            cols: 80,
            cwd: None,
            command: None,
            executable_identity: None,
            environment: Vec::new(),
        }
    }
}

/// Linux filesystem identity captured for a trusted executable handoff.
#[derive(Clone)]
pub struct ExecutableIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    mode: u32,
    size: u64,
    digest_sha256: [u8; 32],
    #[cfg(target_os = "linux")]
    sealed: Arc<std::fs::File>,
}

impl std::fmt::Debug for ExecutableIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExecutableIdentity")
            .field("device", &self.device)
            .field("inode", &self.inode)
            .field("uid", &self.uid)
            .field("mode", &self.mode)
            .field("size", &self.size)
            .field("digest_sha256", &self.digest_sha256)
            .finish_non_exhaustive()
    }
}

impl PartialEq for ExecutableIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.device == other.device
            && self.inode == other.inode
            && self.uid == other.uid
            && self.mode == other.mode
            && self.size == other.size
            && self.digest_sha256 == other.digest_sha256
    }
}

impl Eq for ExecutableIdentity {}

impl ExecutableIdentity {
    /// Captures the exact filesystem identity of a secure regular executable.
    ///
    /// # Errors
    /// Returns [`TerminalError::Spawn`] when the file cannot be inspected or is writable by
    /// group/other users.
    #[cfg(unix)]
    pub fn capture(path: &Path) -> Result<Self, TerminalError> {
        use std::os::unix::fs::MetadataExt;

        let mut source = std::fs::File::open(path).map_err(|_| TerminalError::Spawn)?;
        let metadata = source.metadata().map_err(|_| TerminalError::Spawn)?;
        if !metadata.is_file() || metadata.mode() & 0o022 != 0 {
            return Err(TerminalError::Spawn);
        }
        #[cfg(target_os = "linux")]
        let (sealed, size, digest_sha256) = seal_executable(&mut source)?;
        #[cfg(not(target_os = "linux"))]
        let (size, digest_sha256) = digest_executable(&mut source)?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            mode: metadata.mode(),
            size,
            digest_sha256,
            #[cfg(target_os = "linux")]
            sealed,
        })
    }

    #[cfg(not(unix))]
    pub fn capture(_path: &Path) -> Result<Self, TerminalError> {
        Err(TerminalError::Spawn)
    }

    /// Revalidates the same secure filesystem object.
    ///
    /// # Errors
    /// Returns [`TerminalError::Spawn`] after replacement or permission/ownership drift.
    pub fn revalidate(&self, path: &Path) -> Result<(), TerminalError> {
        self.matches(path).then_some(()).ok_or(TerminalError::Spawn)
    }

    #[cfg(unix)]
    fn matches(&self, path: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;

        let Ok(mut file) = std::fs::File::open(path) else {
            return false;
        };
        let Ok(metadata) = file.metadata() else {
            return false;
        };
        metadata.is_file()
            && metadata.mode() & 0o022 == 0
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
            && metadata.uid() == self.uid
            && metadata.mode() == self.mode
            && digest_executable(&mut file)
                .is_ok_and(|(size, digest)| size == self.size && digest == self.digest_sha256)
    }

    #[cfg(not(unix))]
    fn matches(&self, _path: &Path) -> bool {
        false
    }

    /// Returns the immutable Linux execution path while retaining the sealed descriptor.
    #[must_use]
    #[cfg(target_os = "linux")]
    pub fn execution_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd as _;

        PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            self.sealed.as_raw_fd()
        ))
    }
}

#[cfg(unix)]
fn digest_executable(file: &mut std::fs::File) -> Result<(u64, [u8; 32]), TerminalError> {
    use std::io::{Seek as _, SeekFrom};

    file.seek(SeekFrom::Start(0))
        .map_err(|_| TerminalError::Spawn)?;
    let mut hasher = Sha256::new();
    let size = std::io::copy(file, &mut hasher).map_err(|_| TerminalError::Spawn)?;
    Ok((size, hasher.finalize().into()))
}

#[cfg(target_os = "linux")]
fn seal_executable(
    source: &mut std::fs::File,
) -> Result<(Arc<std::fs::File>, u64, [u8; 32]), TerminalError> {
    use std::io::{Read as _, Seek as _, SeekFrom};

    let descriptor = rustix::fs::memfd_create(
        "agent-workspace-trusted-exec",
        rustix::fs::MemfdFlags::CLOEXEC | rustix::fs::MemfdFlags::ALLOW_SEALING,
    )
    .map_err(|_| TerminalError::Spawn)?;
    let mut sealed = std::fs::File::from(descriptor);
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| TerminalError::Spawn)?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|_| TerminalError::Spawn)?;
        if count == 0 {
            break;
        }
        sealed
            .write_all(&buffer[..count])
            .map_err(|_| TerminalError::Spawn)?;
        hasher.update(&buffer[..count]);
        size = size
            .checked_add(u64::try_from(count).map_err(|_| TerminalError::Spawn)?)
            .ok_or(TerminalError::Spawn)?;
    }
    sealed.sync_all().map_err(|_| TerminalError::Spawn)?;
    rustix::fs::fcntl_add_seals(
        &sealed,
        rustix::fs::SealFlags::WRITE
            | rustix::fs::SealFlags::GROW
            | rustix::fs::SealFlags::SHRINK
            | rustix::fs::SealFlags::SEAL,
    )
    .map_err(|_| TerminalError::Spawn)?;
    let digest: [u8; 32] = hasher.finalize().into();
    let (verified_size, verified_digest) = digest_executable(&mut sealed)?;
    if verified_size != size || verified_digest != digest {
        return Err(TerminalError::Spawn);
    }
    Ok((Arc::new(sealed), size, digest))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalDescriptor {
    pub id: String,
    pub process_id: Option<u32>,
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub rows: u16,
    pub cols: u16,
    pub exited: bool,
    pub exit_code: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalOutputChunk {
    pub sequence: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalCheckpoint {
    pub sequence: u64,
    pub rows: u16,
    pub cols: u16,
    pub active_buffer: ActiveBuffer,
    pub data: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveBuffer {
    Normal,
    Alternate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub terminal: TerminalDescriptor,
    pub checkpoint: Option<TerminalCheckpoint>,
    pub output: Vec<TerminalOutputChunk>,
    pub last_sequence: u64,
    pub reconstruction_complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    Output {
        terminal_id: String,
        chunk: TerminalOutputChunk,
    },
    Resized {
        terminal_id: String,
        rows: u16,
        cols: u16,
    },
    CheckpointRequested {
        terminal_id: String,
        sequence: u64,
    },
    Notification {
        terminal_id: String,
        source: TerminalNotificationSource,
        title: Option<String>,
        body: String,
    },
    Exited {
        terminal_id: String,
        exit_code: u32,
        signal: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalNotificationSource {
    Osc9,
    Osc777,
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal dimensions must be between 1 and 1000 cells")]
    InvalidSize,
    #[error("the terminal command cannot be empty")]
    InvalidCommand,
    #[error("the configured terminal shell is not an absolute executable file")]
    InvalidConfiguredShell,
    #[error("the terminal working directory is not a directory")]
    InvalidWorkingDirectory,
    #[error("the requested terminal does not exist")]
    NotFound,
    #[error("the terminal checkpoint is ahead of the service output")]
    CheckpointAhead,
    #[error("the terminal checkpoint is older than the accepted checkpoint")]
    StaleCheckpoint,
    #[error("the serialized terminal checkpoint is too large")]
    CheckpointTooLarge,
    #[error("the terminal process has already exited")]
    Exited,
    #[error("the operating system could not create a pseudo-terminal")]
    OpenPty,
    #[error("the terminal process could not be started")]
    Spawn,
    #[error("terminal input could not be written")]
    Write,
    #[error("the pseudo-terminal could not be resized")]
    Resize,
    #[error("the terminal process could not be terminated")]
    Terminate,
    #[error("terminal runtime worker failed")]
    Worker,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<ManagerInner>,
}

/// Capability-restricted terminal access for UI and transport consumers.
///
/// This handle deliberately excludes terminal creation, termination, and global shutdown. Those
/// lifecycle operations remain on [`TerminalManager`] so an authoritative workspace runtime can
/// be the only component that changes the live-session set.
#[derive(Clone)]
pub struct TerminalIoHandle {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
    configured_shell: Mutex<Option<PathBuf>>,
    events: broadcast::Sender<TerminalEvent>,
}

struct TerminalSession {
    id: String,
    process_id: Option<u32>,
    command: Vec<String>,
    cwd: PathBuf,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    child_completed: AtomicBool,
    projection: Mutex<ProjectionState>,
    notification_parser: Mutex<OscNotificationParser>,
    events: broadcast::Sender<TerminalEvent>,
}

#[derive(Default)]
struct OscNotificationParser {
    state: OscParserState,
}

#[derive(Default)]
enum OscParserState {
    #[default]
    Ground,
    Escape,
    Osc(Vec<u8>),
    OscEscape(Vec<u8>),
    Discard,
    DiscardEscape,
}

struct ParsedNotification {
    source: TerminalNotificationSource,
    title: Option<String>,
    body: String,
}

impl OscNotificationParser {
    fn push(&mut self, input: &[u8]) -> Vec<ParsedNotification> {
        let mut notifications = Vec::new();
        for &byte in input {
            let state = std::mem::take(&mut self.state);
            self.state = match state {
                OscParserState::Escape if byte == b']' => OscParserState::Osc(Vec::new()),
                OscParserState::Osc(payload) if byte == 0x07 => {
                    if let Some(notification) = parse_osc_notification(&payload) {
                        notifications.push(notification);
                    }
                    OscParserState::Ground
                }
                OscParserState::Osc(payload) if byte == 0x1b => OscParserState::OscEscape(payload),
                OscParserState::Osc(mut payload) => {
                    if payload.len() == MAX_OSC_NOTIFICATION_PAYLOAD_BYTES {
                        OscParserState::Discard
                    } else {
                        payload.push(byte);
                        OscParserState::Osc(payload)
                    }
                }
                OscParserState::OscEscape(payload) if byte == b'\\' => {
                    if let Some(notification) = parse_osc_notification(&payload) {
                        notifications.push(notification);
                    }
                    OscParserState::Ground
                }
                OscParserState::Ground | OscParserState::Escape | OscParserState::OscEscape(_)
                    if byte == 0x1b =>
                {
                    OscParserState::Escape
                }
                OscParserState::Ground | OscParserState::Escape | OscParserState::OscEscape(_) => {
                    OscParserState::Ground
                }
                OscParserState::Discard if byte == 0x07 => OscParserState::Ground,
                OscParserState::DiscardEscape if byte == b'\\' => OscParserState::Ground,
                OscParserState::Discard | OscParserState::DiscardEscape if byte == 0x1b => {
                    OscParserState::DiscardEscape
                }
                OscParserState::Discard | OscParserState::DiscardEscape => OscParserState::Discard,
            };
        }
        notifications
    }
}

fn parse_osc_notification(payload: &[u8]) -> Option<ParsedNotification> {
    if let Some(body) = payload.strip_prefix(b"9;") {
        return Some(ParsedNotification {
            source: TerminalNotificationSource::Osc9,
            title: None,
            body: parse_notification_field(body, MAX_NOTIFICATION_BODY_SCALARS)?,
        });
    }

    let fields = payload.strip_prefix(b"777;notify;")?;
    let separator = fields.iter().position(|byte| *byte == b';')?;
    let (title, body) = fields.split_at(separator);
    Some(ParsedNotification {
        source: TerminalNotificationSource::Osc777,
        title: Some(parse_notification_field(
            title,
            MAX_NOTIFICATION_TITLE_SCALARS,
        )?),
        body: parse_notification_field(&body[1..], MAX_NOTIFICATION_BODY_SCALARS)?,
    })
}

fn parse_notification_field(bytes: &[u8], max_scalars: usize) -> Option<String> {
    let field = std::str::from_utf8(bytes).ok()?;
    if field.chars().count() > max_scalars {
        return None;
    }
    Some(
        field
            .chars()
            .filter(|character| !is_c0_or_c1(*character))
            .collect(),
    )
}

fn is_c0_or_c1(character: char) -> bool {
    matches!(character as u32, 0x00..=0x1f | 0x7f..=0x9f)
}

struct ProjectionState {
    rows: u16,
    cols: u16,
    last_sequence: u64,
    checkpoint: Option<TerminalCheckpoint>,
    journal: VecDeque<TerminalOutputChunk>,
    journal_bytes: usize,
    reconstruction_complete: bool,
    checkpoint_requested: bool,
    exited: bool,
    exit_code: Option<u32>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    #[must_use]
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            inner: Arc::new(ManagerInner {
                sessions: Mutex::new(HashMap::new()),
                configured_shell: Mutex::new(None),
                events,
            }),
        }
    }

    /// Set the shell used for future terminal launches that do not carry an explicit command.
    /// Existing terminal processes are never restarted or otherwise changed.
    ///
    /// Callers must validate a non-empty path with [`Self::validate_configured_shell`] before
    /// applying it. Keeping this final swap infallible lets the configuration owner persist and
    /// apply one already-validated value without introducing a partial runtime failure.
    pub fn set_configured_shell(&self, shell: Option<PathBuf>) {
        *lock(&self.inner.configured_shell) = shell;
    }

    /// Validate a configured shell without changing the runtime default.
    ///
    /// # Errors
    ///
    /// Returns [`TerminalError::InvalidConfiguredShell`] for an unusable host path.
    pub fn validate_configured_shell(shell: Option<&Path>) -> Result<(), TerminalError> {
        validate_configured_shell(shell)
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<TerminalEvent> {
        self.inner.events.subscribe()
    }

    /// Return a handle that can interact with existing terminals without changing their lifecycle.
    #[must_use]
    pub fn io_handle(&self) -> TerminalIoHandle {
        TerminalIoHandle {
            inner: Arc::clone(&self.inner),
        }
    }

    /// Create a terminal on a blocking worker and begin output collection.
    ///
    /// # Errors
    ///
    /// Returns a stable terminal error when validation, PTY creation, or process spawn fails.
    pub async fn create(
        &self,
        mut request: TerminalSpawnRequest,
    ) -> Result<TerminalDescriptor, TerminalError> {
        validate_size(request.rows, request.cols)?;
        if request.command.is_none() {
            request.command = lock(&self.inner.configured_shell)
                .as_ref()
                .map(|shell| implicit_shell_command(shell));
        }
        let events = self.inner.events.clone();
        self.create_with_spawner(request, move |request| spawn_terminal(request, events))
            .await
    }

    /// Creates a contained remote transport from a prevalidated fixed SSH plan.
    ///
    /// The child receives a cleared environment containing only `SSH_AUTH_SOCK`; the public
    /// descriptor uses a generic label and never exposes destination, argv, or private paths.
    ///
    /// # Errors
    /// Returns a stable terminal error when PTY creation or process spawning fails.
    pub async fn create_remote(
        &self,
        plan: &remote::SshLaunchPlan,
        rows: u16,
        cols: u16,
    ) -> Result<TerminalDescriptor, TerminalError> {
        validate_size(rows, cols)?;
        let events = self.inner.events.clone();
        let request = TerminalSpawnRequest {
            rows,
            cols,
            cwd: Some(PathBuf::from("/")),
            command: Some(vec!["remote-transport".to_owned()]),
            executable_identity: None,
            environment: Vec::new(),
        };
        let executable = plan.executable().to_path_buf();
        let argv = plan.argv().to_vec();
        let environment = plan.environment()[0].1.to_path_buf();
        plan.revalidate().map_err(|_| TerminalError::Spawn)?;
        self.create_with_spawner(request, move |_| {
            spawn_remote_terminal(&executable, &argv, &environment, rows, cols, events)
        })
        .await
    }

    async fn create_with_spawner<F>(
        &self,
        request: TerminalSpawnRequest,
        spawner: F,
    ) -> Result<TerminalDescriptor, TerminalError>
    where
        F: FnOnce(TerminalSpawnRequest) -> Result<Arc<TerminalSession>, TerminalError>
            + Send
            + 'static,
    {
        let pending =
            tokio::task::spawn_blocking(move || spawner(request).map(PendingTerminal::new))
                .await
                .map_err(|_| TerminalError::Worker)??;
        let session = pending.into_session();
        let descriptor = session.descriptor();
        let mut sessions = lock(&self.inner.sessions);
        prune_exited_sessions(&mut sessions);
        sessions.insert(session.id.clone(), session);
        Ok(descriptor)
    }

    /// Return the current checkpoint and ordered output journal.
    ///
    /// # Errors
    ///
    /// Returns [`TerminalError::NotFound`] when the terminal ID is unknown.
    pub fn attach(&self, terminal_id: &str) -> Result<TerminalSnapshot, TerminalError> {
        Ok(self.session(terminal_id)?.snapshot())
    }

    /// Write raw bytes to a terminal.
    ///
    /// # Errors
    ///
    /// Returns a stable error when the terminal is missing, exited, or cannot accept input.
    pub async fn write(&self, terminal_id: &str, data: Vec<u8>) -> Result<(), TerminalError> {
        let session = self.session(terminal_id)?;
        tokio::task::spawn_blocking(move || session.write(&data))
            .await
            .map_err(|_| TerminalError::Worker)?
    }

    /// Resize a terminal using character cells.
    ///
    /// # Errors
    ///
    /// Returns a stable error for invalid dimensions, missing terminals, or OS resize failure.
    pub async fn resize(
        &self,
        terminal_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), TerminalError> {
        validate_size(rows, cols)?;
        let session = self.session(terminal_id)?;
        tokio::task::spawn_blocking(move || session.resize(rows, cols))
            .await
            .map_err(|_| TerminalError::Worker)?
    }

    /// Accept a serialized renderer projection at an applied output sequence.
    ///
    /// # Errors
    ///
    /// Returns a stable error for a missing terminal or invalid checkpoint sequence.
    pub fn checkpoint(
        &self,
        terminal_id: &str,
        checkpoint: TerminalCheckpoint,
    ) -> Result<(), TerminalError> {
        self.session(terminal_id)?.checkpoint(checkpoint)
    }

    /// Terminate a terminal process.
    ///
    /// # Errors
    ///
    /// Returns a stable error for a missing terminal or OS termination failure.
    pub async fn terminate(&self, terminal_id: &str) -> Result<(), TerminalError> {
        // Explicit lifecycle termination revokes manager ownership immediately. Natural process
        // exits remain retained for checkpoint replay, but a workspace/tab that was durably
        // removed must never stay attachable while its child cleanup completes.
        let session = lock(&self.inner.sessions)
            .remove(terminal_id)
            .ok_or(TerminalError::NotFound)?;
        tokio::task::spawn_blocking(move || session.terminate())
            .await
            .map_err(|_| TerminalError::Worker)?
    }

    pub async fn shutdown_all(&self) {
        let sessions = lock(&self.inner.sessions)
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            let _ = tokio::task::spawn_blocking(move || session.terminate()).await;
        }
    }

    fn session(&self, terminal_id: &str) -> Result<Arc<TerminalSession>, TerminalError> {
        lock(&self.inner.sessions)
            .get(terminal_id)
            .cloned()
            .ok_or(TerminalError::NotFound)
    }
}

impl TerminalIoHandle {
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<TerminalEvent> {
        self.inner.events.subscribe()
    }

    /// Return the current checkpoint and ordered output journal.
    ///
    /// # Errors
    /// Returns [`TerminalError::NotFound`] when the terminal ID is unknown.
    pub fn attach(&self, terminal_id: &str) -> Result<TerminalSnapshot, TerminalError> {
        Ok(self.session(terminal_id)?.snapshot())
    }

    /// Write raw bytes to an existing terminal.
    ///
    /// # Errors
    /// Returns a stable error when the terminal is missing, exited, or cannot accept input.
    pub async fn write(&self, terminal_id: &str, data: Vec<u8>) -> Result<(), TerminalError> {
        let session = self.session(terminal_id)?;
        tokio::task::spawn_blocking(move || session.write(&data))
            .await
            .map_err(|_| TerminalError::Worker)?
    }

    /// Resize an existing terminal using character cells.
    ///
    /// # Errors
    /// Returns a stable error for invalid dimensions, missing terminals, or OS resize failure.
    pub async fn resize(
        &self,
        terminal_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), TerminalError> {
        validate_size(rows, cols)?;
        let session = self.session(terminal_id)?;
        tokio::task::spawn_blocking(move || session.resize(rows, cols))
            .await
            .map_err(|_| TerminalError::Worker)?
    }

    /// Accept a serialized renderer projection at an applied output sequence.
    ///
    /// # Errors
    /// Returns a stable error for a missing terminal or invalid checkpoint sequence.
    pub fn checkpoint(
        &self,
        terminal_id: &str,
        checkpoint: TerminalCheckpoint,
    ) -> Result<(), TerminalError> {
        self.session(terminal_id)?.checkpoint(checkpoint)
    }

    fn session(&self, terminal_id: &str) -> Result<Arc<TerminalSession>, TerminalError> {
        lock(&self.inner.sessions)
            .get(terminal_id)
            .cloned()
            .ok_or(TerminalError::NotFound)
    }
}

struct PendingTerminal {
    session: Option<Arc<TerminalSession>>,
}

impl PendingTerminal {
    fn new(session: Arc<TerminalSession>) -> Self {
        Self {
            session: Some(session),
        }
    }

    fn into_session(mut self) -> Arc<TerminalSession> {
        self.session
            .take()
            .expect("pending terminal must be present")
    }
}

impl Drop for PendingTerminal {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            // A dropped JoinHandle does not cancel spawn_blocking. If the async creator was
            // cancelled, the blocking task's result is discarded and this guard owns cleanup.
            let _ = session.terminate();
        }
    }
}

impl TerminalSession {
    fn descriptor(&self) -> TerminalDescriptor {
        let projection = lock(&self.projection);
        TerminalDescriptor {
            id: self.id.clone(),
            process_id: self.process_id,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            rows: projection.rows,
            cols: projection.cols,
            exited: projection.exited,
            exit_code: projection.exit_code,
        }
    }

    fn snapshot(&self) -> TerminalSnapshot {
        let projection = lock(&self.projection);
        TerminalSnapshot {
            terminal: TerminalDescriptor {
                id: self.id.clone(),
                process_id: self.process_id,
                command: self.command.clone(),
                cwd: self.cwd.clone(),
                rows: projection.rows,
                cols: projection.cols,
                exited: projection.exited,
                exit_code: projection.exit_code,
            },
            checkpoint: projection.checkpoint.clone(),
            output: projection.journal.iter().cloned().collect(),
            last_sequence: projection.last_sequence,
            reconstruction_complete: projection.reconstruction_complete,
        }
    }

    fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if lock(&self.projection).exited {
            return Err(TerminalError::Exited);
        }
        let mut writer = lock(&self.writer);
        let writer = writer.as_mut().ok_or(TerminalError::Exited)?;
        writer.write_all(data).map_err(|_| TerminalError::Write)?;
        writer.flush().map_err(|_| TerminalError::Write)
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), TerminalError> {
        if lock(&self.projection).exited {
            return Err(TerminalError::Exited);
        }
        lock(&self.master)
            .as_mut()
            .ok_or(TerminalError::Exited)?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| TerminalError::Resize)?;
        {
            let mut projection = lock(&self.projection);
            projection.rows = rows;
            projection.cols = cols;
        }
        let _ = self.events.send(TerminalEvent::Resized {
            terminal_id: self.id.clone(),
            rows,
            cols,
        });
        Ok(())
    }

    fn checkpoint(&self, checkpoint: TerminalCheckpoint) -> Result<(), TerminalError> {
        validate_size(checkpoint.rows, checkpoint.cols)?;
        if checkpoint.data.len() > MAX_CHECKPOINT_BYTES {
            return Err(TerminalError::CheckpointTooLarge);
        }
        let mut projection = lock(&self.projection);
        if checkpoint.sequence > projection.last_sequence {
            return Err(TerminalError::CheckpointAhead);
        }
        if projection
            .checkpoint
            .as_ref()
            .is_some_and(|accepted| checkpoint.sequence < accepted.sequence)
        {
            return Err(TerminalError::StaleCheckpoint);
        }

        while projection
            .journal
            .front()
            .is_some_and(|chunk| chunk.sequence <= checkpoint.sequence)
        {
            if let Some(removed) = projection.journal.pop_front() {
                projection.journal_bytes -= removed.data.len();
            }
        }
        let reconstruction_complete = projection
            .journal
            .front()
            .map_or(checkpoint.sequence == projection.last_sequence, |chunk| {
                chunk.sequence == checkpoint.sequence.saturating_add(1)
            });
        projection.checkpoint = Some(checkpoint);
        projection.reconstruction_complete = reconstruction_complete;
        projection.checkpoint_requested = false;
        Ok(())
    }

    fn terminate(&self) -> Result<(), TerminalError> {
        if lock(&self.projection).exited {
            return Ok(());
        }
        lock(&self.killer)
            .as_mut()
            .ok_or(TerminalError::Exited)?
            .kill()
            .map_err(|_| TerminalError::Terminate)?;

        #[cfg(unix)]
        if let Some(process_id) = self.process_id {
            for _ in 0..25 {
                if self.child_completed.load(Ordering::Acquire) {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if let Some(process_id) = rustix::process::Pid::from_raw(process_id.cast_signed()) {
                match rustix::process::kill_process(process_id, rustix::process::Signal::KILL) {
                    Ok(()) | Err(rustix::io::Errno::SRCH) => {}
                    Err(_) => return Err(TerminalError::Terminate),
                }
            }
        }
        Ok(())
    }

    fn append_output(&self, data: &[u8]) {
        for piece in data.chunks(MAX_OUTPUT_CHUNK_BYTES) {
            let notifications = lock(&self.notification_parser).push(piece);
            let (chunk, request_checkpoint) = {
                let mut projection = lock(&self.projection);
                projection.last_sequence += 1;
                let chunk = TerminalOutputChunk {
                    sequence: projection.last_sequence,
                    data: piece.to_vec(),
                };
                projection.journal_bytes += piece.len();
                projection.journal.push_back(chunk.clone());

                let limit = if projection.checkpoint.is_some() {
                    POST_CHECKPOINT_JOURNAL_LIMIT_BYTES
                } else {
                    STARTUP_JOURNAL_LIMIT_BYTES
                };
                while projection.journal_bytes > limit {
                    if let Some(removed) = projection.journal.pop_front() {
                        projection.journal_bytes -= removed.data.len();
                        projection.reconstruction_complete = false;
                    }
                }

                let request_checkpoint = projection.checkpoint.is_some()
                    && projection.journal_bytes >= CHECKPOINT_REQUEST_THRESHOLD_BYTES
                    && !projection.checkpoint_requested;
                if request_checkpoint {
                    projection.checkpoint_requested = true;
                }
                (chunk, request_checkpoint)
            };

            let _ = self.events.send(TerminalEvent::Output {
                terminal_id: self.id.clone(),
                chunk: chunk.clone(),
            });
            for notification in notifications {
                let _ = self.events.send(TerminalEvent::Notification {
                    terminal_id: self.id.clone(),
                    source: notification.source,
                    title: notification.title,
                    body: notification.body,
                });
            }
            if request_checkpoint {
                let _ = self.events.send(TerminalEvent::CheckpointRequested {
                    terminal_id: self.id.clone(),
                    sequence: chunk.sequence,
                });
            }
        }
    }

    fn mark_exited(&self, exit_code: u32, signal: Option<String>) {
        {
            let mut projection = lock(&self.projection);
            projection.exited = true;
            projection.exit_code = Some(exit_code);
        }
        lock(&self.writer).take();
        lock(&self.master).take();
        lock(&self.killer).take();
        let _ = self.events.send(TerminalEvent::Exited {
            terminal_id: self.id.clone(),
            exit_code,
            signal,
        });
    }
}

fn spawn_terminal(
    request: TerminalSpawnRequest,
    events: broadcast::Sender<TerminalEvent>,
) -> Result<Arc<TerminalSession>, TerminalError> {
    spawn_terminal_with_hook(request, events, || {})
}

fn spawn_terminal_with_hook<F>(
    request: TerminalSpawnRequest,
    events: broadcast::Sender<TerminalEvent>,
    after_executable_opened: F,
) -> Result<Arc<TerminalSession>, TerminalError>
where
    F: FnOnce(),
{
    let cwd = resolve_working_directory(request.cwd)?;
    let command = resolve_command(request.command)?;
    #[cfg(target_os = "linux")]
    let executable = if let Some(identity) = request.executable_identity.as_ref() {
        identity.revalidate(Path::new(&command[0]))?;
        identity.execution_path().to_string_lossy().into_owned()
    } else {
        command[0].clone()
    };
    #[cfg(not(target_os = "linux"))]
    let executable = if request.executable_identity.is_none() {
        command[0].clone()
    } else {
        return Err(TerminalError::Spawn);
    };
    after_executable_opened();
    let mut builder = CommandBuilder::new(&executable);
    builder.args(command.iter().skip(1));
    builder.cwd(&cwd);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("AGENT_WORKSPACE_ACTIVE", "1");
    for (key, value) in request.environment {
        builder.env(key, value);
    }

    spawn_terminal_builder(builder, command, cwd, request.rows, request.cols, events)
}

fn spawn_remote_terminal(
    executable: &Path,
    argv: &[String],
    agent_socket: &Path,
    rows: u16,
    cols: u16,
    events: broadcast::Sender<TerminalEvent>,
) -> Result<Arc<TerminalSession>, TerminalError> {
    let mut builder = CommandBuilder::new(executable);
    builder.args(argv);
    builder.cwd("/");
    builder.env_clear();
    builder.env("SSH_AUTH_SOCK", agent_socket);
    spawn_terminal_builder(
        builder,
        vec!["remote-transport".to_owned()],
        PathBuf::from("/"),
        rows,
        cols,
        events,
    )
}

fn spawn_terminal_builder(
    builder: CommandBuilder,
    command: Vec<String>,
    cwd: PathBuf,
    rows: u16,
    cols: u16,
    events: broadcast::Sender<TerminalEvent>,
) -> Result<Arc<TerminalSession>, TerminalError> {
    let PtyPair { master, slave } = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| TerminalError::OpenPty)?;
    let reader = master
        .try_clone_reader()
        .map_err(|_| TerminalError::OpenPty)?;
    let writer = master.take_writer().map_err(|_| TerminalError::OpenPty)?;
    let child = slave
        .spawn_command(builder)
        .map_err(|_| TerminalError::Spawn)?;
    drop(slave);

    let process_id = child.process_id();
    let killer = child.clone_killer();
    let session = Arc::new(TerminalSession {
        id: Uuid::new_v4().to_string(),
        process_id,
        command,
        cwd,
        master: Mutex::new(Some(master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(Some(killer)),
        child_completed: AtomicBool::new(false),
        projection: Mutex::new(ProjectionState {
            rows,
            cols,
            last_sequence: 0,
            checkpoint: None,
            journal: VecDeque::new(),
            journal_bytes: 0,
            reconstruction_complete: true,
            checkpoint_requested: false,
            exited: false,
            exit_code: None,
        }),
        notification_parser: Mutex::new(OscNotificationParser::default()),
        events,
    });

    start_reader(Arc::clone(&session), reader, child);
    Ok(session)
}

fn start_reader(
    session: Arc<TerminalSession>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
) {
    let (reader_done_tx, reader_done_rx) = mpsc::sync_channel(1);
    let reader_session = Arc::clone(&session);
    std::thread::Builder::new()
        .name(format!("terminal-reader-{}", session.id))
        .spawn(move || {
            let mut buffer = vec![0_u8; MAX_OUTPUT_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => reader_session.append_output(&buffer[..read]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => {
                        warn!(terminal_id = %reader_session.id, %error, "terminal read failed");
                        break;
                    }
                }
            }
            let _ = reader_done_tx.send(());
        })
        .expect("terminal reader thread must spawn");

    std::thread::Builder::new()
        .name(format!("terminal-waiter-{}", session.id))
        .spawn(move || match child.wait() {
            Ok(status) => {
                session.child_completed.store(true, Ordering::Release);
                let _ = reader_done_rx.recv_timeout(Duration::from_secs(1));
                session.mark_exited(status.exit_code(), status.signal().map(ToOwned::to_owned));
            }
            Err(error) => {
                session.child_completed.store(true, Ordering::Release);
                warn!(terminal_id = %session.id, %error, "terminal wait failed");
                session.mark_exited(1, None);
            }
        })
        .expect("terminal waiter thread must spawn");
}

fn resolve_working_directory(requested: Option<PathBuf>) -> Result<PathBuf, TerminalError> {
    let cwd = requested
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    if !cwd.is_dir() {
        return Err(TerminalError::InvalidWorkingDirectory);
    }
    Ok(cwd)
}

fn resolve_command(explicit: Option<Vec<String>>) -> Result<Vec<String>, TerminalError> {
    if let Some(command) = explicit {
        if command.first().is_none_or(String::is_empty) {
            return Err(TerminalError::InvalidCommand);
        }
        return Ok(command);
    }
    Ok(implicit_shell_command(&resolve_default_shell()))
}

#[cfg(unix)]
fn implicit_shell_command(shell: &Path) -> Vec<String> {
    let executable = shell.to_string_lossy().into_owned();
    let name = shell
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let login_argument = match name.as_str() {
        "nu" => Some("--login"),
        "powershell" | "pwsh" => Some("-Login"),
        "ash" | "bash" | "dash" | "fish" | "ksh" | "sh" | "zsh" => Some("-l"),
        _ => None,
    };
    match login_argument {
        Some(argument) => vec![executable, argument.into()],
        None => vec![executable],
    }
}

#[cfg(windows)]
fn implicit_shell_command(shell: &Path) -> Vec<String> {
    vec![shell.to_string_lossy().into_owned()]
}

fn validate_configured_shell(shell: Option<&Path>) -> Result<(), TerminalError> {
    let Some(shell) = shell else {
        return Ok(());
    };
    if !shell.is_absolute() || !configured_shell_is_executable(shell) {
        return Err(TerminalError::InvalidConfiguredShell);
    }
    Ok(())
}

#[cfg(unix)]
fn configured_shell_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn configured_shell_is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(unix)]
fn resolve_default_shell() -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    use uzers::os::unix::UserExt as _;

    fn executable(path: &Path) -> bool {
        path.is_file()
            && path
                .metadata()
                .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }

    if let Some(user) = uzers::get_user_by_uid(uzers::get_current_uid()) {
        let shell = user.shell();
        if executable(shell) {
            return shell.to_path_buf();
        }
    }
    if let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from)
        && executable(&shell)
    {
        return shell;
    }
    PathBuf::from("/bin/sh")
}

#[cfg(windows)]
fn resolve_default_shell() -> PathBuf {
    ["pwsh.exe", "powershell.exe", "cmd.exe"]
        .into_iter()
        .find_map(|candidate| which::which(candidate).ok())
        .unwrap_or_else(|| PathBuf::from("cmd.exe"))
}

fn validate_size(rows: u16, cols: u16) -> Result<(), TerminalError> {
    if rows == 0 || cols == 0 || rows > 1000 || cols > 1000 {
        Err(TerminalError::InvalidSize)
    } else {
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn prune_exited_sessions(sessions: &mut HashMap<String, Arc<TerminalSession>>) {
    let exited = sessions
        .iter()
        .filter_map(|(id, session)| lock(&session.projection).exited.then_some(id.clone()))
        .collect::<Vec<_>>();
    let remove_count = exited
        .len()
        .saturating_add(1)
        .saturating_sub(MAX_RETAINED_EXITED_SESSIONS);
    for id in exited.into_iter().take(remove_count) {
        sessions.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::time::{Instant, timeout};

    fn assert_notification(
        notification: &ParsedNotification,
        source: TerminalNotificationSource,
        title: Option<&str>,
        body: &str,
    ) {
        assert_eq!(notification.source, source);
        assert_eq!(notification.title.as_deref(), title);
        assert_eq!(notification.body, body);
    }

    #[test]
    fn osc_notifications_support_bel_and_st_across_every_byte_boundary() {
        let cases: &[(&[u8], TerminalNotificationSource, Option<&str>, &str)] = &[
            (
                b"\x1b]9;build finished\x07",
                TerminalNotificationSource::Osc9,
                None,
                "build finished",
            ),
            (
                b"\x1b]9;build finished\x1b\\",
                TerminalNotificationSource::Osc9,
                None,
                "build finished",
            ),
            (
                b"\x1b]777;notify;Build;finished successfully\x07",
                TerminalNotificationSource::Osc777,
                Some("Build"),
                "finished successfully",
            ),
            (
                b"\x1b]777;notify;Build;finished successfully\x1b\\",
                TerminalNotificationSource::Osc777,
                Some("Build"),
                "finished successfully",
            ),
        ];

        for &(sequence, source, title, body) in cases {
            for boundary in 0..=sequence.len() {
                let mut parser = OscNotificationParser::default();
                let mut notifications = parser.push(&sequence[..boundary]);
                notifications.extend(parser.push(&sequence[boundary..]));
                assert_eq!(notifications.len(), 1, "split at byte {boundary}");
                assert_notification(&notifications[0], source, title, body);
            }
        }
    }

    #[test]
    fn osc_parser_emits_multiple_notifications_in_order() {
        let notifications = OscNotificationParser::default().push(
            b"prefix\x1b]9;first\x07middle\x1b]777;notify;Second;body;with;semicolons\x1b\\suffix",
        );

        assert_eq!(notifications.len(), 2);
        assert_notification(
            &notifications[0],
            TerminalNotificationSource::Osc9,
            None,
            "first",
        );
        assert_notification(
            &notifications[1],
            TerminalNotificationSource::Osc777,
            Some("Second"),
            "body;with;semicolons",
        );
    }

    #[test]
    fn osc_parser_recovers_after_malformed_and_overlong_sequences() {
        let mut parser = OscNotificationParser::default();
        assert!(parser.push(b"\x1b]9;malformed\x1bx").is_empty());

        let mut overlong = b"\x1b]9;".to_vec();
        overlong.extend(std::iter::repeat_n(
            b'x',
            MAX_OSC_NOTIFICATION_PAYLOAD_BYTES + 1,
        ));
        overlong.push(0x07);
        assert!(parser.push(&overlong).is_empty());

        let notifications = parser.push(b"\x1b]9;recovered\x07");
        assert_eq!(notifications.len(), 1);
        assert_notification(
            &notifications[0],
            TerminalNotificationSource::Osc9,
            None,
            "recovered",
        );
    }

    #[test]
    fn osc_parser_rejects_invalid_utf8_and_unsupported_commands() {
        let notifications = OscNotificationParser::default()
            .push(b"\x1b]9;bad\xffutf8\x07\x1b]52;c;dGVzdA==\x07\x1b]777;other;title;body\x07");
        assert!(notifications.is_empty());
    }

    #[test]
    fn osc_parser_enforces_field_scalar_limits_and_sanitizes_controls() {
        let mut parser = OscNotificationParser::default();
        let mut title_too_long = b"\x1b]777;notify;".to_vec();
        title_too_long.extend(std::iter::repeat_n(
            b't',
            MAX_NOTIFICATION_TITLE_SCALARS + 1,
        ));
        title_too_long.extend_from_slice(b";body\x07");
        assert!(parser.push(&title_too_long).is_empty());

        let mut body_too_long = b"\x1b]9;".to_vec();
        body_too_long.extend(std::iter::repeat_n(b'b', MAX_NOTIFICATION_BODY_SCALARS + 1));
        body_too_long.push(0x07);
        assert!(parser.push(&body_too_long).is_empty());

        let notifications =
            parser.push(b"\x1b]777;notify;ti\tle\x7f\xc2\x85;bo\ndy\x01\xc2\x9f\x07");
        assert_eq!(notifications.len(), 1);
        assert_notification(
            &notifications[0],
            TerminalNotificationSource::Osc777,
            Some("tile"),
            "body",
        );
    }

    #[cfg(unix)]
    #[test]
    fn configured_shell_validation_requires_an_absolute_executable_regular_file() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempdir().expect("temporary directory");
        let candidate = directory.path().join("shell");
        std::fs::write(&candidate, b"#!/bin/sh\nexit 0\n").expect("write candidate");
        let mut permissions = std::fs::metadata(&candidate)
            .expect("candidate metadata")
            .permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&candidate, permissions).expect("set candidate permissions");

        assert!(matches!(
            TerminalManager::validate_configured_shell(Some(Path::new("relative-shell"))),
            Err(TerminalError::InvalidConfiguredShell)
        ));
        assert!(matches!(
            TerminalManager::validate_configured_shell(Some(&candidate)),
            Err(TerminalError::InvalidConfiguredShell)
        ));

        let mut permissions = std::fs::metadata(&candidate)
            .expect("candidate metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&candidate, permissions).expect("set candidate permissions");
        TerminalManager::validate_configured_shell(Some(&candidate))
            .expect("absolute executable file must be accepted");
        TerminalManager::validate_configured_shell(None)
            .expect("system-default selection must be accepted");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn configured_shell_applies_only_to_future_implicit_launches() {
        let manager = TerminalManager::new();
        manager.set_configured_shell(Some(PathBuf::from("/bin/sh")));
        let existing = manager
            .create(TerminalSpawnRequest::default())
            .await
            .expect("configured shell must launch");
        assert_eq!(existing.command, vec!["/bin/sh", "-l"]);

        manager.set_configured_shell(Some(PathBuf::from("/bin/false")));
        assert_eq!(
            manager
                .attach(&existing.id)
                .expect("existing terminal must remain")
                .terminal
                .command,
            vec!["/bin/sh", "-l"]
        );

        let future = manager
            .create(TerminalSpawnRequest::default())
            .await
            .expect("updated configured shell must launch");
        assert_eq!(future.command, vec!["/bin/false"]);

        let explicit_command = shell_command("sleep 5");
        let explicit = manager
            .create(TerminalSpawnRequest {
                command: Some(explicit_command.clone()),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("explicit command must launch");
        assert_eq!(explicit.command, explicit_command);

        manager
            .terminate(&existing.id)
            .await
            .expect("existing terminal must terminate");
        manager
            .terminate(&explicit.id)
            .await
            .expect("explicit terminal must terminate");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executable_identity_rejects_path_replacement_before_spawn() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("trusted-command");
        std::fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let identity = ExecutableIdentity::capture(&executable).unwrap();
        let replacement = directory.path().join("replacement");
        std::fs::write(&replacement, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::rename(&replacement, &executable).unwrap();

        let error = TerminalManager::new()
            .create(TerminalSpawnRequest {
                command: Some(vec![executable.to_string_lossy().into_owned()]),
                executable_identity: Some(identity),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect_err("replaced executable identity must fail closed");
        assert!(matches!(error, TerminalError::Spawn));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn executable_identity_rejects_same_inode_content_mutation() {
        use std::io::{Seek as _, SeekFrom, Write as _};
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("trusted-command");
        std::fs::copy("/bin/sh", &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let identity = ExecutableIdentity::capture(&executable).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&executable)
            .unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(b"BAD!").unwrap();
        file.sync_all().unwrap();

        let error = TerminalManager::new()
            .create(TerminalSpawnRequest {
                command: Some(vec![executable.to_string_lossy().into_owned()]),
                executable_identity: Some(identity),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect_err("same-inode content mutation must fail closed");
        assert!(matches!(error, TerminalError::Spawn));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn executable_identity_memfd_is_write_sealed() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("trusted-command");
        std::fs::copy("/bin/sh", &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let identity = ExecutableIdentity::capture(&executable).unwrap();
        let write = std::fs::OpenOptions::new()
            .write(true)
            .open(identity.execution_path())
            .and_then(|mut file| file.write_all(b"replacement"));
        assert!(
            write.is_err(),
            "sealed executable must reject same-UID writes"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn executable_identity_uses_sealed_snapshot_when_path_swaps_after_validation() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("trusted-command");
        let replacement = directory.path().join("replacement");
        let result = directory.path().join("result");
        std::fs::copy("/bin/sh", &executable).unwrap();
        std::fs::copy("/bin/false", &replacement).unwrap();
        for path in [&executable, &replacement] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let identity = ExecutableIdentity::capture(&executable).unwrap();
        let (events, _) = broadcast::channel(8);
        let _session = spawn_terminal_with_hook(
            TerminalSpawnRequest {
                cwd: Some(directory.path().to_path_buf()),
                command: Some(vec![
                    executable.to_string_lossy().into_owned(),
                    "-c".to_owned(),
                    format!("printf original > '{}'", result.display()),
                ]),
                executable_identity: Some(identity),
                ..TerminalSpawnRequest::default()
            },
            events,
            || std::fs::rename(&replacement, &executable).unwrap(),
        )
        .expect("the already-open trusted executable must launch");
        for _ in 0..100 {
            if result.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(std::fs::read_to_string(result).unwrap(), "original");
    }

    #[tokio::test]
    async fn append_output_preserves_raw_chunks_and_broadcasts_notifications() {
        let manager = TerminalManager::new();
        let mut events = manager.subscribe();
        let terminal = manager
            .create(TerminalSpawnRequest {
                command: Some(shell_command(if cfg!(windows) {
                    "ping -n 6 127.0.0.1 >NUL"
                } else {
                    "sleep 5"
                })),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");
        let session = manager.session(&terminal.id).expect("terminal must exist");
        let raw = b"before\x1b]777;notify;Title;Body\x07after";

        session.append_output(raw);

        let output = events.recv().await.expect("output event");
        assert!(matches!(
            output,
            TerminalEvent::Output {
                ref terminal_id,
                ref chunk,
            } if terminal_id == &terminal.id && chunk.data == raw
        ));
        let notification = events.recv().await.expect("notification event");
        assert!(matches!(
            notification,
            TerminalEvent::Notification {
                ref terminal_id,
                source: TerminalNotificationSource::Osc777,
                title: Some(ref title),
                ref body,
            } if terminal_id == &terminal.id && title == "Title" && body == "Body"
        ));

        manager
            .terminate(&terminal.id)
            .await
            .expect("terminal must terminate");
    }

    fn shell_command(script: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd.exe".to_owned(), "/C".to_owned(), script.to_owned()]
        } else {
            vec!["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()]
        }
    }

    async fn collect_until(
        receiver: &mut broadcast::Receiver<TerminalEvent>,
        terminal_id: &str,
        needle: &[u8],
    ) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            if let Ok(Ok(TerminalEvent::Output {
                terminal_id: event_terminal,
                chunk,
            })) = timeout(Duration::from_millis(500), receiver.recv()).await
                && event_terminal == terminal_id
            {
                output.extend_from_slice(&chunk.data);
                if output.windows(needle.len()).any(|window| window == needle) {
                    return output;
                }
            }
        }
        panic!("terminal output did not contain {needle:?}: {output:?}");
    }

    #[tokio::test]
    async fn real_shell_accepts_input_and_emits_ordered_output() {
        let manager = TerminalManager::new();
        let mut events = manager.subscribe();
        let terminal = manager
            .create(TerminalSpawnRequest {
                command: Some(shell_command(
                    "printf READY; read line; printf 'GOT:%s' \"$line\"",
                )),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");

        collect_until(&mut events, &terminal.id, b"READY").await;
        manager
            .write(&terminal.id, b"hello\n".to_vec())
            .await
            .expect("input must write");
        let output = collect_until(&mut events, &terminal.id, b"GOT:hello").await;
        assert!(output.windows(9).any(|window| window == b"GOT:hello"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn resize_updates_the_kernel_terminal_dimensions() {
        let manager = TerminalManager::new();
        let mut events = manager.subscribe();
        let terminal = manager
            .create(TerminalSpawnRequest {
                rows: 24,
                cols: 80,
                command: Some(shell_command("stty size; read line; stty size")),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");

        collect_until(&mut events, &terminal.id, b"24 80").await;
        manager
            .resize(&terminal.id, 40, 100)
            .await
            .expect("terminal must resize");
        manager
            .write(&terminal.id, b"\n".to_vec())
            .await
            .expect("input must write");
        collect_until(&mut events, &terminal.id, b"40 100").await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn checkpoint_and_following_output_reconstruct_in_order() {
        let manager = TerminalManager::new();
        let mut events = manager.subscribe();
        let terminal = manager
            .create(TerminalSpawnRequest {
                command: Some(vec!["/bin/cat".to_owned()]),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");

        manager
            .write(&terminal.id, b"before\n".to_vec())
            .await
            .expect("input must write");
        collect_until(&mut events, &terminal.id, b"before").await;
        let before = manager.attach(&terminal.id).expect("terminal must attach");
        manager
            .checkpoint(
                &terminal.id,
                TerminalCheckpoint {
                    sequence: before.last_sequence,
                    rows: 24,
                    cols: 80,
                    active_buffer: ActiveBuffer::Normal,
                    data: "serialized-before".to_owned(),
                },
            )
            .expect("checkpoint must be accepted");
        manager
            .write(&terminal.id, b"after\n".to_vec())
            .await
            .expect("input must write");
        collect_until(&mut events, &terminal.id, b"after").await;

        let reattached = manager.attach(&terminal.id).expect("terminal must attach");
        assert_eq!(
            reattached.checkpoint.expect("checkpoint").data,
            "serialized-before"
        );
        assert!(
            reattached
                .output
                .iter()
                .any(|chunk| { String::from_utf8_lossy(&chunk.data).contains("after") })
        );
        manager
            .terminate(&terminal.id)
            .await
            .expect("terminal must terminate");
    }

    #[tokio::test]
    async fn process_exit_is_reported_and_retained() {
        let manager = TerminalManager::new();
        let mut events = manager.subscribe();
        let terminal = manager
            .create(TerminalSpawnRequest {
                command: Some(shell_command("exit 7")),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");

        loop {
            let event = timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("exit event timeout")
                .expect("event channel");
            if let TerminalEvent::Exited {
                terminal_id,
                exit_code,
                ..
            } = event
                && terminal_id == terminal.id
            {
                assert_eq!(exit_code, 7);
                break;
            }
        }
        let snapshot = manager
            .attach(&terminal.id)
            .expect("terminal must remain attachable");
        assert!(snapshot.terminal.exited);
        assert_eq!(snapshot.terminal.exit_code, Some(7));
    }

    #[tokio::test]
    async fn explicit_termination_revokes_attach_without_waiting_for_process_exit() {
        let manager = TerminalManager::new();
        let terminal = manager
            .create(TerminalSpawnRequest {
                command: Some(shell_command("sleep 30")),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");

        manager
            .terminate(&terminal.id)
            .await
            .expect("terminal must terminate");
        assert!(matches!(
            manager.attach(&terminal.id),
            Err(TerminalError::NotFound)
        ));
    }

    #[tokio::test]
    async fn repeated_process_exit_releases_handles_and_bounds_tombstones() {
        let manager = TerminalManager::new();
        let mut events = manager.subscribe();
        let mut terminal_ids = Vec::new();

        for _ in 0..=MAX_RETAINED_EXITED_SESSIONS {
            let terminal = manager
                .create(TerminalSpawnRequest {
                    command: Some(shell_command("exit 0")),
                    ..TerminalSpawnRequest::default()
                })
                .await
                .expect("terminal must spawn");

            loop {
                let event = timeout(Duration::from_secs(5), events.recv())
                    .await
                    .expect("exit event timeout")
                    .expect("event channel");
                if matches!(
                    event,
                    TerminalEvent::Exited {
                        ref terminal_id,
                        exit_code: 0,
                        ..
                    } if terminal_id == &terminal.id
                ) {
                    break;
                }
            }

            let session = manager
                .session(&terminal.id)
                .expect("newly exited terminal must be retained");
            assert!(lock(&session.master).is_none());
            assert!(lock(&session.writer).is_none());
            assert!(lock(&session.killer).is_none());
            terminal_ids.push(terminal.id);
        }

        let sessions = lock(&manager.inner.sessions);
        assert_eq!(sessions.len(), MAX_RETAINED_EXITED_SESSIONS);
        assert!(sessions.values().all(|session| {
            let projection = lock(&session.projection);
            projection.exited
                && lock(&session.master).is_none()
                && lock(&session.writer).is_none()
                && lock(&session.killer).is_none()
        }));
        assert_eq!(
            terminal_ids
                .iter()
                .filter(|terminal_id| sessions.contains_key(*terminal_id))
                .count(),
            MAX_RETAINED_EXITED_SESSIONS
        );
    }

    #[tokio::test]
    async fn invalid_working_directory_is_rejected() {
        let missing = tempdir().expect("tempdir").path().join("missing");
        let error = TerminalManager::new()
            .create(TerminalSpawnRequest {
                cwd: Some(missing),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect_err("missing cwd must fail");

        assert!(matches!(error, TerminalError::InvalidWorkingDirectory));
    }

    #[tokio::test]
    async fn aborting_blocked_production_creation_terminates_the_spawned_process() {
        let manager = TerminalManager::new();
        let task_manager = manager.clone();
        let events = manager.inner.events.clone();
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let (spawned_tx, spawned_rx) = std::sync::mpsc::sync_channel(1);
        let creation = tokio::spawn(async move {
            task_manager
                .create_with_spawner(
                    TerminalSpawnRequest {
                        command: Some(shell_command("sleep 30")),
                        ..TerminalSpawnRequest::default()
                    },
                    move |request| {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        let session = spawn_terminal(request, events)?;
                        spawned_tx.send(Arc::downgrade(&session)).unwrap();
                        Ok(session)
                    },
                )
                .await
        });

        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();
        creation.abort();
        creation.await.unwrap_err();
        release_tx.send(()).unwrap();
        let session = tokio::task::spawn_blocking(move || spawned_rx.recv().unwrap())
            .await
            .unwrap();

        timeout(Duration::from_secs(2), async {
            loop {
                let cleaned = session.upgrade().is_none_or(|session| {
                    lock(&session.projection).exited
                        || session.child_completed.load(Ordering::Acquire)
                });
                if cleaned {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("discarded spawn_blocking result must terminate its child");
        assert!(lock(&manager.inner.sessions).is_empty());
    }

    #[tokio::test]
    async fn checkpoint_only_restores_completeness_when_it_bridges_the_retained_journal() {
        let manager = TerminalManager::new();
        let terminal = manager
            .create(TerminalSpawnRequest {
                command: Some(shell_command(if cfg!(windows) {
                    "ping -n 6 127.0.0.1 >NUL"
                } else {
                    "sleep 5"
                })),
                ..TerminalSpawnRequest::default()
            })
            .await
            .expect("terminal must spawn");
        let session = manager.session(&terminal.id).expect("terminal must exist");
        session.append_output(&vec![b'x'; STARTUP_JOURNAL_LIMIT_BYTES + 64 * 1024]);

        let truncated = manager.attach(&terminal.id).expect("terminal must attach");
        assert!(!truncated.reconstruction_complete);

        manager
            .checkpoint(
                &terminal.id,
                TerminalCheckpoint {
                    sequence: 0,
                    rows: 24,
                    cols: 80,
                    active_buffer: ActiveBuffer::Normal,
                    data: "incomplete".to_owned(),
                },
            )
            .expect("old checkpoint remains valid but incomplete");
        assert!(
            !manager
                .attach(&terminal.id)
                .expect("terminal must attach")
                .reconstruction_complete
        );

        manager
            .checkpoint(
                &terminal.id,
                TerminalCheckpoint {
                    sequence: truncated.last_sequence,
                    rows: 24,
                    cols: 80,
                    active_buffer: ActiveBuffer::Normal,
                    data: "current".to_owned(),
                },
            )
            .expect("current checkpoint must bridge the journal");
        assert!(
            manager
                .attach(&terminal.id)
                .expect("terminal must attach")
                .reconstruction_complete
        );
        manager
            .terminate(&terminal.id)
            .await
            .expect("terminal must terminate");
    }
}

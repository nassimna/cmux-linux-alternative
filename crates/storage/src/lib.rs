#![allow(clippy::missing_errors_doc, clippy::too_many_lines)]

//! Durable `SQLite` persistence for validated application snapshots.
//!
//! The store is intentionally synchronous. Async callers should serialize writes or invoke the
//! operations on a blocking thread.

use std::ffi::OsString;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use agent_workspace_core::{
    ApplicationState, DomainError, MAX_SAFE_INTEGER, ShortcutPlatform, UncheckedApplicationState,
    WindowId,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, backup, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

mod action_invocations;
mod action_provider_recovery;
mod agent_sessions;
mod browser_automation;
mod remote_sessions;
mod sidebar_content;

pub use action_invocations::{
    ACTION_FULL_RESULT_CAP, ACTION_FULL_RESULT_RETENTION_MS, ACTION_INVOCATION_GLOBAL_CAP,
    ACTION_INVOCATION_PROVIDER_CAP, ACTION_TOMBSTONE_CAP, ACTION_TOMBSTONE_RETENTION_MS,
    ActionInvocationCreate, ActionInvocationCreateOutcome, ActionInvocationIdentity,
    ActionInvocationRecord, ActionInvocationState, ActionLifecycleOutcome, ActionPruneReport,
    ActionRecoveryQuery, ActionStartClaim, ActionTerminalAck, ActionTerminalOutcome,
};
pub use action_provider_recovery::{
    ActionProviderRecoveryAcquireOutcome, ActionProviderRecoveryRecord,
};
pub use agent_sessions::{
    AGENT_SESSION_CAP, AGENT_TEAM_CAP, AGENT_TEAM_MEMBER_CAP, AgentAttentionRecord,
    AgentAttentionStateRecord, AgentCatalogMutationIdentityRecord, AgentCatalogMutationOutcome,
    AgentCatalogRecord, AgentCheckpointRecord, AgentForkArtifactRecord, AgentForkOrphanRecord,
    AgentHibernationChallengeReplay, AgentHibernationConfirmation,
    AgentHibernationConfirmationCreate, AgentHibernationConfirmationOutcome,
    AgentHibernationStateRecord, AgentLifecycleRecord, AgentOperationBegin,
    AgentOperationBeginOutcome, AgentOperationRecord, AgentOperationStateRecord,
    AgentRestoreLevelRecord, AgentRestoreOutcomeRecord, AgentSessionBindingRecord,
    AgentSessionCreate, AgentSessionCreateOutcome, AgentSessionRecord, AgentSessionUpdate,
    AgentTeamDeleteRecord, AgentTeamMemberCreate, AgentTeamMemberDeleteRecord,
    AgentTeamMemberMutationIdentityRecord, AgentTeamMemberRecord, AgentTeamMutationIdentityRecord,
    AgentTeamRecord,
};
pub use browser_automation::{
    AUTOMATION_TERMINAL_RECORD_CAP, AUTOMATION_TERMINAL_RETENTION_MS,
    BrowserAutomationCreateOutcome, BrowserAutomationLifecycleOutcome,
    BrowserAutomationOperationCreateRecord, BrowserAutomationOperationRecord,
    BrowserAutomationOperationStateRecord, BrowserAutomationProviderFence,
    BrowserAutomationSessionCreateRecord, BrowserAutomationSessionModeRecord,
    BrowserAutomationSessionRecord, BrowserAutomationSessionStateRecord,
    BrowserAutomationTargetRecord, BrowserAutomationTerminalUpdate,
};
pub use remote_sessions::{
    MAX_REMOTE_SESSIONS, MAX_REMOTE_TARGETS, RemoteCreateOutcome, RemoteMutationOutcome,
    RemoteSessionRecord, RemoteSessionStateRecord, RemoteTargetRecord,
};
pub use sidebar_content::{SidebarContentMutationOutcome, TaskConfirmationConsumeOutcome};

/// Current on-disk schema version.
pub const SCHEMA_VERSION: u32 = 15;

/// Largest persisted desktop-window dimension in logical pixels.
pub const MAX_WINDOW_DIMENSION: u64 = 100_000;

/// Largest persisted display identifier, counted in Unicode scalar values.
pub const MAX_DISPLAY_IDENTIFIER_CHARS: usize = 512;

const SNAPSHOT_SINGLETON_ID: i64 = 1;
const LEGACY_IDEMPOTENCY_EPOCH: &str = "00000000-0000-0000-0000-000000000001";
const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const IDEMPOTENCY_NAMESPACE_MAX_CHARS: usize = 128;
const IDEMPOTENCY_RESULT_MAX_BYTES: usize = 256 * 1_024;
const IDEMPOTENCY_RESULT_RETENTION_CAP: usize = 4_096;
pub const IDEMPOTENCY_TOMBSTONE_CAP: usize = 65_536;
pub const WINDOW_STATE_CAP: usize = 16;
const EXPECTED_SNAPSHOT_SCHEMA: &str = "CREATE TABLE application_snapshot (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),
    json_payload TEXT NOT NULL,
    saved_at_ms INTEGER NOT NULL
)";
const EXPECTED_LEGACY_WINDOW_STATE_SCHEMA: &str = "CREATE TABLE window_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),
    json_payload TEXT NOT NULL,
    saved_at_ms INTEGER NOT NULL
)";
const EXPECTED_WINDOW_STATE_SCHEMA: &str = "CREATE TABLE window_state (
    window_id TEXT PRIMARY KEY CHECK (length(window_id) = 36),
    revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),
    json_payload TEXT NOT NULL,
    saved_at_ms INTEGER NOT NULL
)";
const EXPECTED_LEGACY_IDEMPOTENCY_RESULTS_SCHEMA: &str = "CREATE TABLE idempotency_results (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    UNIQUE(namespace, idempotency_key)
)";
const EXPECTED_IDEMPOTENCY_RESULTS_SCHEMA: &str = "CREATE TABLE idempotency_results (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    epoch TEXT NOT NULL CHECK (length(epoch) = 36),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT,
    completed_at_ms INTEGER NOT NULL,
    UNIQUE(namespace, epoch, idempotency_key)
)";
const EXPECTED_IDEMPOTENCY_EPOCH_SCHEMA: &str = "CREATE TABLE idempotency_epoch (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    epoch TEXT NOT NULL CHECK (length(epoch) = 36),
    issued_at_ms INTEGER NOT NULL
)";
const EXPECTED_MIGRATION_METADATA_SCHEMA: &str = "CREATE TABLE migration_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    source_version INTEGER NOT NULL,
    target_version INTEGER NOT NULL,
    backup_path TEXT,
    legacy_snapshot_compatibility INTEGER NOT NULL CHECK (legacy_snapshot_compatibility IN (0, 1)),
    migrated_at_ms INTEGER NOT NULL
)";

/// One namespaced durable idempotency write committed atomically with an application snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotencySaveRequest {
    pub namespace: String,
    pub idempotency_key: String,
    pub request_json: String,
    pub result_json: String,
    pub retention_capacity: usize,
}

/// Durable lookup outcome for a caller-provided idempotency key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdempotencyLookup {
    Missing,
    Replay(String),
    Conflict,
}

/// Atomic snapshot/idempotency transaction outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdempotencySaveOutcome {
    Committed,
    Replay(String),
    Conflict,
}

/// Schema-v5 idempotency write bound to the current server-issued epoch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochIdempotencySaveRequest {
    pub namespace: String,
    pub epoch: Uuid,
    pub idempotency_key: Uuid,
    /// Lowercase hexadecimal SHA-256 of the canonical request.
    pub request_hash: String,
    pub result_json: String,
    pub retention_capacity: usize,
}

/// Epoch-aware lookup including compact tombstone and rotated-epoch outcomes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EpochIdempotencyLookup {
    Missing,
    Replay(String),
    Conflict,
    ResultExpired,
    EpochExpired,
}

/// Validated state for the single current desktop window.
///
/// JSON decoding is strict: unknown fields are rejected so recovery inspection can distinguish
/// incompatible or malformed payloads instead of silently discarding them.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowState {
    /// Monotonically increasing caller-owned revision.
    pub revision: u64,
    /// Horizontal logical-pixel position. Negative values support displays left of the origin.
    pub x: i64,
    /// Vertical logical-pixel position. Negative values support displays above the origin.
    pub y: i64,
    /// Width in logical pixels.
    pub width: u64,
    /// Height in logical pixels.
    pub height: u64,
    /// Whether the window is maximized.
    pub maximized: bool,
    /// Whether the window is fullscreen.
    pub fullscreen: bool,
    /// Stable platform display identifier, when one is available.
    pub display_identifier: Option<String>,
}

impl WindowState {
    /// Validates safe-integer, geometry, and display-identifier bounds.
    ///
    /// # Errors
    /// Returns the precise field invariant that is not satisfied.
    pub fn validate(&self) -> Result<(), WindowStateValidationError> {
        if self.revision > MAX_SAFE_INTEGER {
            return Err(WindowStateValidationError::RevisionOutOfRange {
                revision: self.revision,
            });
        }
        let safe_coordinate = i64::try_from(MAX_SAFE_INTEGER).unwrap_or(i64::MAX);
        if !(-safe_coordinate..=safe_coordinate).contains(&self.x) {
            return Err(WindowStateValidationError::CoordinateOutOfRange {
                field: "x",
                value: self.x,
            });
        }
        if !(-safe_coordinate..=safe_coordinate).contains(&self.y) {
            return Err(WindowStateValidationError::CoordinateOutOfRange {
                field: "y",
                value: self.y,
            });
        }
        validate_dimension("width", self.width)?;
        validate_dimension("height", self.height)?;
        if let Some(identifier) = &self.display_identifier {
            let chars = identifier.chars().count();
            if chars == 0 || chars > MAX_DISPLAY_IDENTIFIER_CHARS {
                return Err(WindowStateValidationError::DisplayIdentifierLength { chars });
            }
            if identifier.trim().is_empty() || identifier.chars().any(char::is_control) {
                return Err(WindowStateValidationError::UnsafeDisplayIdentifier);
            }
        }
        Ok(())
    }
}

fn validate_dimension(field: &'static str, value: u64) -> Result<(), WindowStateValidationError> {
    if !(1..=MAX_WINDOW_DIMENSION).contains(&value) {
        return Err(WindowStateValidationError::DimensionOutOfRange {
            field,
            value,
            maximum: MAX_WINDOW_DIMENSION,
        });
    }
    Ok(())
}

/// Validation failures for persisted desktop-window state.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WindowStateValidationError {
    /// The revision is outside JavaScript's exactly representable integer range.
    #[error("revision {revision} exceeds the maximum safe integer")]
    RevisionOutOfRange {
        /// Rejected revision.
        revision: u64,
    },
    /// A coordinate is outside JavaScript's exactly representable integer range.
    #[error("{field} coordinate {value} is outside the safe integer range")]
    CoordinateOutOfRange {
        /// Rejected field.
        field: &'static str,
        /// Rejected coordinate.
        value: i64,
    },
    /// A dimension is zero or unreasonably large.
    #[error("{field} dimension {value} must be between 1 and {maximum}")]
    DimensionOutOfRange {
        /// Rejected field.
        field: &'static str,
        /// Rejected dimension.
        value: u64,
        /// Inclusive upper bound.
        maximum: u64,
    },
    /// A display identifier is empty or too long.
    #[error(
        "display identifier length {chars} must be between 1 and {MAX_DISPLAY_IDENTIFIER_CHARS}"
    )]
    DisplayIdentifierLength {
        /// Identifier length in Unicode scalar values.
        chars: usize,
    },
    /// A display identifier is blank or contains control characters.
    #[error("display identifier must not be blank or contain control characters")]
    UnsafeDisplayIdentifier,
}

/// Result of applying schema migrations while opening a store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationOutcome {
    /// The database already used the current schema.
    Current {
        /// Current schema version.
        version: u32,
    },
    /// A new or unversioned database was initialized without a pre-migration backup.
    Initialized {
        /// Initial schema version.
        from: u32,
        /// Final schema version.
        to: u32,
    },
    /// An existing versioned database was upgraded after a consistent backup was created.
    Upgraded {
        /// Initial schema version.
        from: u32,
        /// Final schema version.
        to: u32,
        /// Owner-only `SQLite` backup made before any migration transaction began.
        backup_path: PathBuf,
    },
}

/// Explicit replacement policy for recovery exports.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryExportMode {
    /// The destination must not already exist.
    CreateNew,
    /// The destination must already be a safe owner-owned regular file with one hard link.
    ReplaceExisting,
}

/// Successful recovery-copy details.
///
/// A readable database is exported with `SQLite`'s online-backup API, including committed WAL
/// state. If `SQLite` identifies the source as corrupt or not a database, the export instead
/// preserves the main database file's exact raw bytes as recovery evidence. Success therefore
/// means that a data-preserving recovery copy was published, not that the result is valid `SQLite`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryExportReport {
    /// Final recovery-copy path.
    pub destination: PathBuf,
    /// Whether a validated existing destination was atomically replaced.
    pub replaced_existing: bool,
}

/// Read-only recovery classification for a database path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryClassification {
    /// The current schema and stored payloads are readable and valid.
    Healthy {
        /// Schema version inspected.
        schema_version: u32,
        /// Canonical application snapshot revision, if present.
        snapshot_revision: Option<u64>,
        /// Window-state revision, if present.
        window_state_revision: Option<u64>,
    },
    /// The database is valid but requires a supported migration before normal use.
    MigrationRequired {
        /// Existing schema version.
        from: u32,
        /// Supported target schema version.
        to: u32,
        /// Canonical application snapshot revision, if present.
        snapshot_revision: Option<u64>,
    },
    /// The database belongs to a newer application build.
    FutureSchema {
        /// Version found.
        found: u32,
        /// Highest version supported by this build.
        supported: u32,
    },
    /// `SQLite` could not read the database file.
    CorruptSqlite {
        /// Diagnostic detail.
        message: String,
    },
    /// Schema objects disagree with the recorded schema version.
    CorruptSchema {
        /// Diagnostic detail.
        message: String,
    },
    /// The canonical application snapshot is semantically invalid.
    InvalidSnapshot {
        /// Stored row revision.
        revision: String,
        /// Diagnostic detail.
        message: String,
    },
    /// The canonical application snapshot cannot be decoded strictly.
    MalformedSnapshot {
        /// Stored row revision.
        revision: String,
        /// Diagnostic detail.
        message: String,
    },
    /// The window-state payload is semantically invalid.
    InvalidWindowState {
        /// Stored row revision.
        revision: String,
        /// Diagnostic detail.
        message: String,
    },
    /// The window-state payload cannot be decoded strictly.
    MalformedWindowState {
        /// Stored row revision.
        revision: String,
        /// Diagnostic detail.
        message: String,
    },
    /// The path is missing, inaccessible, unsafe, or has unsafe permissions.
    PermissionOrPath {
        /// Diagnostic detail.
        message: String,
    },
    /// A prior typed store error represents a migration failure.
    MigrationFailure {
        /// Source schema version.
        from: u32,
        /// Attempted target schema version.
        to: u32,
        /// Diagnostic detail.
        message: String,
    },
}

/// A non-mutating recovery inspection report.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryInspection {
    /// Inspected database path.
    pub path: PathBuf,
    /// Typed classification.
    pub classification: RecoveryClassification,
}

/// Errors produced while opening, migrating, reading, or writing durable state.
#[derive(Debug, Error)]
pub enum StorageError {
    /// The database parent directory could not be created.
    #[error("failed to create SQLite parent directory `{path}`: {source}")]
    CreateDirectory {
        /// Directory that could not be created.
        path: PathBuf,
        /// Underlying filesystem error.
        #[source]
        source: std::io::Error,
    },

    /// The database file could not be securely created before `SQLite` opened it.
    #[error("failed to prepare SQLite database file `{path}`: {source}")]
    PrepareDatabaseFile {
        /// Database path.
        path: PathBuf,
        /// Underlying filesystem error.
        #[source]
        source: std::io::Error,
    },

    /// Secure filesystem permissions could not be applied or verified.
    #[error("failed to secure SQLite path `{path}`: {message}")]
    Permissions {
        /// Path whose permissions were unsafe or inaccessible.
        path: PathBuf,
        /// Actionable failure detail.
        message: String,
    },

    /// A `SQLite` operation failed.
    #[error("SQLite {operation} failed for `{path}`: {source}")]
    Database {
        /// Operation being performed.
        operation: &'static str,
        /// Database path.
        path: PathBuf,
        /// Underlying `SQLite` error, including corruption classifications when available.
        #[source]
        source: rusqlite::Error,
    },

    /// The database was created by a newer, unsupported application version.
    #[error(
        "SQLite schema version {found} is newer than supported version {supported} for `{path}`; refusing to downgrade"
    )]
    FutureSchema {
        /// Database path.
        path: PathBuf,
        /// Version read from `SQLite`.
        found: u32,
        /// Highest version supported by this build.
        supported: u32,
    },

    /// A migration failed and its transaction was rolled back.
    #[error("SQLite migration from schema {from} to {to} failed for `{path}`: {source}")]
    Migration {
        /// Database path.
        path: PathBuf,
        /// Original schema version.
        from: u32,
        /// Target schema version.
        to: u32,
        /// Secured pre-migration backup retained after the rollback, when one was created.
        backup_path: Option<PathBuf>,
        /// Underlying `SQLite` failure.
        #[source]
        source: rusqlite::Error,
    },

    /// A consistent pre-migration backup could not be created.
    #[error(
        "failed to create pre-migration backup `{backup_path}` for SQLite schema {from} to {to} at `{path}`: {message}"
    )]
    MigrationBackup {
        /// Source database path.
        path: PathBuf,
        /// Initial schema version.
        from: u32,
        /// Target schema version.
        to: u32,
        /// Intended or partially prepared backup path.
        backup_path: PathBuf,
        /// Actionable failure detail.
        message: String,
    },

    /// The recorded schema version does not match the required schema objects.
    #[error("SQLite schema is corrupt or incomplete for `{path}`: {message}")]
    CorruptSchema {
        /// Database path.
        path: PathBuf,
        /// Schema mismatch detail.
        message: String,
    },

    /// The database could not enable the required write-ahead log mode.
    #[error("SQLite WAL mode is unavailable for `{path}`; SQLite returned `{found}`")]
    WalUnavailable {
        /// Database path.
        path: PathBuf,
        /// Journal mode returned by `SQLite`.
        found: String,
    },

    /// Caller-supplied state violates domain or platform invariants.
    #[error("refusing to persist invalid application state: {source}")]
    InvalidState {
        /// Domain validation failure.
        #[source]
        source: DomainError,
    },

    /// A loaded snapshot violates domain or platform invariants.
    #[error("stored application snapshot at revision {revision} is invalid: {source}")]
    InvalidSnapshot {
        /// Revision recorded beside the snapshot.
        revision: String,
        /// Domain validation failure.
        #[source]
        source: DomainError,
    },

    /// Valid state could not be serialized.
    #[error("failed to serialize application state: {source}")]
    Serialize {
        /// JSON serialization failure.
        #[source]
        source: serde_json::Error,
    },

    /// Stored snapshot JSON could not be decoded.
    #[error("stored application snapshot at revision {revision} contains malformed JSON: {source}")]
    MalformedSnapshot {
        /// Revision recorded beside the snapshot.
        revision: String,
        /// JSON decoding failure.
        #[source]
        source: serde_json::Error,
    },

    /// Stored revision metadata is malformed or disagrees with the payload.
    #[error("stored application snapshot revision metadata is inconsistent: {message}")]
    RevisionMismatch {
        /// Actionable mismatch detail.
        message: String,
    },

    /// A caller attempted to replace a newer durable snapshot with an older revision.
    #[error(
        "refusing stale application snapshot revision {attempted}; durable revision is {stored}"
    )]
    StaleRevision {
        /// Revision already stored durably.
        stored: u64,
        /// Older revision supplied by the caller.
        attempted: u64,
    },

    /// A caller supplied different content for an already durable revision.
    #[error("application snapshot revision {revision} already exists with different content")]
    RevisionConflict {
        /// Revision whose content is inconsistent.
        revision: u64,
    },

    /// A schema-v5 idempotency request violates its strict DTO bounds.
    #[error("invalid epoch idempotency request: {message}")]
    InvalidIdempotencyRequest { message: String },

    /// An action invocation request violates schema-v6 bounds or lifecycle invariants.
    #[error("invalid action invocation request: {message}")]
    InvalidActionInvocation { message: String },

    /// An agent catalog request or stored relationship violates schema-v9 invariants.
    #[error("invalid agent session catalog mutation: {message}")]
    InvalidAgentCatalog { message: String },

    /// A remote target/session mutation violates schema-v10 privacy or lifecycle invariants.
    #[error("invalid remote-session mutation: {message}")]
    InvalidRemoteSession { message: String },

    /// Bounds were supplied for a window not owned by the durable topology.
    #[error("window placement `{id}` is not present in the durable application topology")]
    UnknownWindowPlacement { id: WindowId },

    /// Per-window bounds would exceed the topology's hard window cap.
    #[error("window-state row count {actual} exceeds the {maximum} window limit")]
    WindowStateLimit { actual: usize, maximum: usize },

    /// Caller-supplied desktop-window state violates persistence invariants.
    #[error("refusing to persist invalid window state: {source}")]
    InvalidWindowState {
        /// Window-state validation failure.
        #[source]
        source: WindowStateValidationError,
    },

    /// Stored desktop-window state violates persistence invariants.
    #[error("stored window state at revision {revision} is invalid: {source}")]
    InvalidStoredWindowState {
        /// Revision recorded beside the state.
        revision: String,
        /// Window-state validation failure.
        #[source]
        source: WindowStateValidationError,
    },

    /// Stored desktop-window JSON could not be decoded strictly.
    #[error("stored window state at revision {revision} contains malformed JSON: {source}")]
    MalformedWindowState {
        /// Revision recorded beside the state.
        revision: String,
        /// JSON decoding failure.
        #[source]
        source: serde_json::Error,
    },

    /// Stored desktop-window revision metadata is malformed or inconsistent.
    #[error("stored window state revision metadata is inconsistent: {message}")]
    WindowStateRevisionMismatch {
        /// Actionable mismatch detail.
        message: String,
    },

    /// A caller attempted to replace a newer durable desktop-window state.
    #[error("refusing stale window state revision {attempted}; durable revision is {stored}")]
    StaleWindowStateRevision {
        /// Revision already stored durably.
        stored: u64,
        /// Older revision supplied by the caller.
        attempted: u64,
    },

    /// A caller supplied different desktop-window content for an existing revision.
    #[error("window state revision {revision} already exists with different content")]
    WindowStateRevisionConflict {
        /// Revision whose content is inconsistent.
        revision: u64,
    },

    /// A recovery export failed before a safe copy could be published.
    #[error(
        "recovery export from `{source_path}` to `{destination}` failed during {operation}: {message}"
    )]
    RecoveryExport {
        /// Source database path.
        source_path: PathBuf,
        /// Requested final destination.
        destination: PathBuf,
        /// Operation being performed.
        operation: &'static str,
        /// Actionable failure detail.
        message: String,
    },

    /// Another thread panicked while accessing this store.
    #[error("SQLite state store lock is poisoned")]
    LockPoisoned,
}

impl RecoveryClassification {
    /// Classifies a typed storage failure for recovery UI without performing any mutation.
    #[must_use]
    pub fn from_storage_error(error: &StorageError) -> Self {
        match error {
            StorageError::FutureSchema {
                found, supported, ..
            } => Self::FutureSchema {
                found: *found,
                supported: *supported,
            },
            StorageError::Migration {
                from, to, source, ..
            } => Self::MigrationFailure {
                from: *from,
                to: *to,
                message: source.to_string(),
            },
            StorageError::MigrationBackup {
                from, to, message, ..
            } => Self::MigrationFailure {
                from: *from,
                to: *to,
                message: message.clone(),
            },
            StorageError::CorruptSchema { message, .. } => Self::CorruptSchema {
                message: message.clone(),
            },
            StorageError::InvalidSnapshot { revision, source } => Self::InvalidSnapshot {
                revision: revision.clone(),
                message: source.to_string(),
            },
            StorageError::MalformedSnapshot { revision, source } => Self::MalformedSnapshot {
                revision: revision.clone(),
                message: source.to_string(),
            },
            StorageError::RevisionMismatch { message } => Self::InvalidSnapshot {
                revision: String::new(),
                message: message.clone(),
            },
            StorageError::InvalidStoredWindowState { revision, source } => {
                Self::InvalidWindowState {
                    revision: revision.clone(),
                    message: source.to_string(),
                }
            }
            StorageError::MalformedWindowState { revision, source } => Self::MalformedWindowState {
                revision: revision.clone(),
                message: source.to_string(),
            },
            StorageError::WindowStateRevisionMismatch { message } => Self::InvalidWindowState {
                revision: String::new(),
                message: message.clone(),
            },
            StorageError::CreateDirectory { .. }
            | StorageError::PrepareDatabaseFile { .. }
            | StorageError::Permissions { .. }
            | StorageError::RecoveryExport { .. } => Self::PermissionOrPath {
                message: error.to_string(),
            },
            StorageError::Database { source, .. } if sqlite_is_path_error(source) => {
                Self::PermissionOrPath {
                    message: source.to_string(),
                }
            }
            StorageError::Database { source, .. } => Self::CorruptSqlite {
                message: source.to_string(),
            },
            StorageError::WalUnavailable { .. }
            | StorageError::InvalidState { .. }
            | StorageError::Serialize { .. }
            | StorageError::StaleRevision { .. }
            | StorageError::RevisionConflict { .. }
            | StorageError::InvalidIdempotencyRequest { .. }
            | StorageError::UnknownWindowPlacement { .. }
            | StorageError::WindowStateLimit { .. }
            | StorageError::InvalidWindowState { .. }
            | StorageError::StaleWindowStateRevision { .. }
            | StorageError::WindowStateRevisionConflict { .. }
            | StorageError::LockPoisoned => Self::CorruptSqlite {
                message: error.to_string(),
            },
            StorageError::InvalidActionInvocation { .. } => Self::CorruptSqlite {
                message: "action invocation request failed validation".to_owned(),
            },
            StorageError::InvalidAgentCatalog { .. } => Self::CorruptSqlite {
                message: "agent catalog request or stored relationship failed validation"
                    .to_owned(),
            },
            StorageError::InvalidRemoteSession { .. } => Self::CorruptSqlite {
                message: "remote-session request or stored row failed validation".to_owned(),
            },
        }
    }
}

fn sqlite_is_path_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::CannotOpen
                    | rusqlite::ErrorCode::PermissionDenied
                    | rusqlite::ErrorCode::ReadOnly,
                ..
            },
            _
        )
    )
}

/// Synchronous, thread-safe access to one versioned application snapshot.
pub struct SqliteStateStore {
    connection: Mutex<Connection>,
    path: PathBuf,
    platform: ShortcutPlatform,
}

impl SqliteStateStore {
    /// Opens a database, creates its parent directory, and applies all supported migrations.
    ///
    /// On Unix, newly created directories are restricted to the user and database files are
    /// restricted to owner read/write. Existing paths have group/other access removed without
    /// adding permissions that were not already present.
    ///
    /// # Errors
    /// Returns a typed error for filesystem, `SQLite`, migration, or future-schema failures. The
    /// database is never deleted or reset on failure.
    pub fn open(path: impl AsRef<Path>, platform: ShortcutPlatform) -> Result<Self, StorageError> {
        Self::open_with_report(path, platform).map(|(store, _outcome)| store)
    }

    /// Opens a database and also reports whether initialization or a backed-up upgrade occurred.
    ///
    /// # Errors
    /// Returns the same typed failures as [`Self::open`]. A failed migration is rolled back and a
    /// successfully created pre-migration backup is deliberately retained for recovery.
    pub fn open_with_report(
        path: impl AsRef<Path>,
        platform: ShortcutPlatform,
    ) -> Result<(Self, MigrationOutcome), StorageError> {
        let path = path.as_ref().to_path_buf();
        let parent = path.parent().filter(|value| !value.as_os_str().is_empty());
        if let Some(parent) = parent {
            prepare_parent_directory(parent)?;
            secure_directory(parent)?;
        }
        prepare_database_file(&path)?;
        secure_database_artifacts(&path)?;

        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|source| database_error(&path, "open", source))?;

        connection
            .busy_timeout(DEFAULT_BUSY_TIMEOUT)
            .map_err(|source| database_error(&path, "busy-timeout configuration", source))?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|source| database_error(&path, "foreign-key configuration", source))?;

        let found = read_schema_version(&connection, &path)?;
        if found > SCHEMA_VERSION {
            return Err(StorageError::FutureSchema {
                path,
                found,
                supported: SCHEMA_VERSION,
            });
        }
        verify_schema_for_version(&connection, &path, found)?;
        let migration_outcome = migrate(&mut connection, &path, found, platform)?;
        verify_current_schema(&connection, &path)?;

        enable_wal(&connection, &path)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|source| database_error(&path, "synchronous configuration", source))?;
        let synchronous: u32 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|source| database_error(&path, "synchronous verification", source))?;
        if synchronous != 2 {
            return Err(StorageError::CorruptSchema {
                path,
                message: format!("required synchronous=FULL (2), found {synchronous}"),
            });
        }
        secure_database_artifacts(&path)?;

        Ok((
            Self {
                connection: Mutex::new(connection),
                path,
                platform,
            },
            migration_outcome,
        ))
    }

    /// Returns the schema version supported by this store implementation.
    #[must_use]
    pub const fn supported_schema_version() -> u32 {
        SCHEMA_VERSION
    }

    /// Reads the schema version currently recorded by `SQLite`.
    ///
    /// # Errors
    /// Returns an error if the database cannot be queried.
    pub fn schema_version(&self) -> Result<u32, StorageError> {
        let connection = self.lock()?;
        read_schema_version(&connection, &self.path)
    }

    /// Returns the database path used by this store.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads and validates the current snapshot, or returns `None` for an empty database.
    ///
    /// # Errors
    /// Returns a typed error for `SQLite` corruption, malformed JSON, inconsistent revision
    /// metadata, or a domain/platform invariant failure. No data is mutated on these failures.
    pub fn load(&self) -> Result<Option<ApplicationState>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let stored = connection
            .query_row(
                "SELECT revision, json_payload FROM application_snapshot WHERE singleton = ?1",
                [SNAPSHOT_SINGLETON_ID],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "snapshot read", source))?;

        let Some((stored_revision, payload)) = stored else {
            return Ok(None);
        };
        let legacy_compatibility = legacy_snapshot_compatibility(&connection, &self.path)?;
        let state = decode_snapshot(
            &stored_revision,
            &payload,
            self.platform,
            legacy_compatibility,
        )?;
        Ok(Some(state))
    }

    /// Loads and validates the current desktop-window state, or returns `None` if it has not been
    /// saved yet.
    ///
    /// # Errors
    /// Returns a typed error for `SQLite` failures, strict JSON decoding, validation, or inconsistent
    /// revision metadata. The row is never changed on failure.
    pub fn load_window_state(&self) -> Result<Option<WindowState>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_window_state_from_connection(&connection, &self.path)
    }

    /// Loads bounds for one stable service-issued window placement.
    pub fn load_window_state_for(
        &self,
        window_id: WindowId,
    ) -> Result<Option<WindowState>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_window_state_for_connection(&connection, &self.path, window_id)
    }

    /// Looks up a completed namespaced operation without exposing unrelated durable records.
    ///
    /// # Errors
    /// Returns a typed storage error when database hardening, locking, or lookup fails.
    pub fn load_idempotency_result(
        &self,
        namespace: &str,
        idempotency_key: &str,
        request_json: &str,
    ) -> Result<IdempotencyLookup, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let stored = connection
            .query_row(
                "SELECT request_hash, result_json FROM idempotency_results
                 WHERE namespace = ?1 AND epoch = ?2 AND idempotency_key = ?3",
                params![namespace, LEGACY_IDEMPOTENCY_EPOCH, idempotency_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "idempotency result read", source))?;
        Ok(match stored {
            None => IdempotencyLookup::Missing,
            Some((stored_request, Some(result))) if stored_request == request_json => {
                IdempotencyLookup::Replay(result)
            }
            Some((stored_request, None)) if stored_request == request_json => {
                IdempotencyLookup::Missing
            }
            Some(_) => IdempotencyLookup::Conflict,
        })
    }

    /// Returns the durable current server-issued idempotency epoch.
    pub fn current_idempotency_epoch(&self) -> Result<Uuid, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        read_idempotency_epoch(&connection, &self.path)
    }

    /// Rotates the epoch and atomically invalidates every prior result and tombstone.
    pub fn rotate_idempotency_epoch(&self) -> Result<Uuid, StorageError> {
        secure_database_artifacts(&self.path)?;
        let next = Uuid::new_v4();
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| {
                database_error(&self.path, "idempotency epoch rotation begin", source)
            })?;
        transaction
            .execute("DELETE FROM idempotency_results", [])
            .map_err(|source| {
                database_error(&self.path, "idempotency epoch result clear", source)
            })?;
        transaction
            .execute("DELETE FROM action_invocation_tombstones", [])
            .map_err(|source| {
                database_error(&self.path, "action idempotency tombstone clear", source)
            })?;
        transaction
            .execute("DELETE FROM browser_automation_tombstones", [])
            .map_err(|source| {
                database_error(
                    &self.path,
                    "browser automation idempotency tombstone clear",
                    source,
                )
            })?;
        transaction
            .execute(
                "UPDATE idempotency_epoch SET epoch = ?1,
             issued_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1",
                [next.to_string()],
            )
            .map_err(|source| {
                database_error(&self.path, "idempotency epoch replacement", source)
            })?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "idempotency epoch rotation commit", source)
        })?;
        Ok(next)
    }

    /// Looks up an epoch-bound result without ever executing a replay from a rotated epoch.
    pub fn load_epoch_idempotency_result(
        &self,
        namespace: &str,
        epoch: Uuid,
        idempotency_key: Uuid,
        request_hash: &str,
    ) -> Result<EpochIdempotencyLookup, StorageError> {
        validate_epoch_request_fields(namespace, request_hash, 0, 1)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        if read_idempotency_epoch(&connection, &self.path)? != epoch {
            return Ok(EpochIdempotencyLookup::EpochExpired);
        }
        let stored = connection
            .query_row(
                "SELECT request_hash, result_json FROM idempotency_results
             WHERE namespace = ?1 AND epoch = ?2 AND idempotency_key = ?3",
                params![namespace, epoch.to_string(), idempotency_key.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|source| {
                database_error(&self.path, "epoch idempotency result read", source)
            })?;
        Ok(match stored {
            None => EpochIdempotencyLookup::Missing,
            Some((stored_hash, _)) if stored_hash != request_hash => {
                EpochIdempotencyLookup::Conflict
            }
            Some((_, Some(result))) => EpochIdempotencyLookup::Replay(result),
            Some((_, None)) => EpochIdempotencyLookup::ResultExpired,
        })
    }

    /// Atomically persists an application mutation and its epoch-bound exact result.
    pub fn save_with_epoch_idempotency(
        &self,
        state: &ApplicationState,
        request: &EpochIdempotencySaveRequest,
    ) -> Result<EpochIdempotencyLookup, StorageError> {
        validate_epoch_request_fields(
            &request.namespace,
            &request.request_hash,
            request.result_json.len(),
            request.retention_capacity,
        )?;
        state
            .validate_for_platform(self.platform)
            .map_err(|source| StorageError::InvalidState { source })?;
        let payload =
            serde_json::to_string(state).map_err(|source| StorageError::Serialize { source })?;
        let revision = state.revision.to_string();
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| {
                database_error(&self.path, "epoch idempotency transaction begin", source)
            })?;
        if read_idempotency_epoch(&transaction, &self.path)? != request.epoch {
            return Ok(EpochIdempotencyLookup::EpochExpired);
        }
        let existing = transaction
            .query_row(
                "SELECT request_hash, result_json FROM idempotency_results
             WHERE namespace = ?1 AND epoch = ?2 AND idempotency_key = ?3",
                params![
                    request.namespace,
                    request.epoch.to_string(),
                    request.idempotency_key.to_string()
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|source| {
                database_error(&self.path, "epoch idempotency result read", source)
            })?;
        if let Some((stored_hash, result)) = existing {
            return Ok(if stored_hash != request.request_hash {
                EpochIdempotencyLookup::Conflict
            } else if let Some(result) = result {
                EpochIdempotencyLookup::Replay(result)
            } else {
                EpochIdempotencyLookup::ResultExpired
            });
        }
        let tombstone_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM idempotency_results WHERE namespace = ?1 AND epoch = ?2",
                params![request.namespace, request.epoch.to_string()],
                |row| row.get(0),
            )
            .map_err(|source| {
                database_error(&self.path, "epoch idempotency tombstone count", source)
            })?;
        if tombstone_count >= i64::try_from(IDEMPOTENCY_TOMBSTONE_CAP).unwrap_or(i64::MAX) {
            return Err(StorageError::InvalidIdempotencyRequest {
                message: format!(
                    "epoch/namespace tombstone cap {IDEMPOTENCY_TOMBSTONE_CAP} reached; rotate the epoch"
                ),
            });
        }
        if let Some((stored_state, stored_payload)) =
            load_current_snapshot(&transaction, &self.path, self.platform)?
        {
            match state.revision.cmp(&stored_state.revision) {
                std::cmp::Ordering::Less => {
                    return Err(StorageError::StaleRevision {
                        stored: stored_state.revision,
                        attempted: state.revision,
                    });
                }
                std::cmp::Ordering::Equal if payload != stored_payload => {
                    return Err(StorageError::RevisionConflict {
                        revision: state.revision,
                    });
                }
                _ => {}
            }
        }
        transaction
            .execute(
                "INSERT INTO application_snapshot (singleton, revision, json_payload, saved_at_ms)
             VALUES (?1, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER))
             ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision,
             json_payload = excluded.json_payload, saved_at_ms = excluded.saved_at_ms",
                params![SNAPSHOT_SINGLETON_ID, revision, payload],
            )
            .map_err(|source| database_error(&self.path, "snapshot replacement", source))?;
        prune_window_states(&transaction, state, &self.path)?;
        clear_legacy_snapshot_compatibility(&transaction, &self.path)?;
        transaction
            .execute(
                "INSERT INTO idempotency_results
             (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                params![
                    request.namespace,
                    request.epoch.to_string(),
                    request.idempotency_key.to_string(),
                    request.request_hash,
                    request.result_json
                ],
            )
            .map_err(|source| {
                database_error(&self.path, "epoch idempotency result insert", source)
            })?;
        let capacity = i64::try_from(request.retention_capacity).unwrap_or(i64::MAX);
        transaction
            .execute(
                "UPDATE idempotency_results SET result_json = NULL
             WHERE namespace = ?1 AND epoch = ?2 AND sequence NOT IN (
               SELECT sequence FROM idempotency_results WHERE namespace = ?1 AND epoch = ?2
               AND result_json IS NOT NULL ORDER BY completed_at_ms DESC, sequence DESC LIMIT ?3
             )",
                params![request.namespace, request.epoch.to_string(), capacity],
            )
            .map_err(|source| {
                database_error(&self.path, "epoch idempotency retention trim", source)
            })?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "epoch idempotency commit", source))?;
        Ok(EpochIdempotencyLookup::Replay(request.result_json.clone()))
    }

    /// Atomically persists an application mutation and its exact idempotency result.
    ///
    /// # Errors
    /// Returns a typed validation, serialization, revision, or database error. The transaction is
    /// rolled back when either the snapshot or idempotency result cannot be committed.
    pub fn save_with_idempotency(
        &self,
        state: &ApplicationState,
        request: &IdempotencySaveRequest,
    ) -> Result<IdempotencySaveOutcome, StorageError> {
        state
            .validate_for_platform(self.platform)
            .map_err(|source| StorageError::InvalidState { source })?;
        let payload =
            serde_json::to_string(state).map_err(|source| StorageError::Serialize { source })?;
        let revision = state.revision.to_string();
        let retention_capacity =
            i64::try_from(request.retention_capacity.max(1)).unwrap_or(i64::MAX);

        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| {
                database_error(&self.path, "idempotency transaction begin", source)
            })?;
        let existing = transaction
            .query_row(
                "SELECT request_hash, result_json FROM idempotency_results
                 WHERE namespace = ?1 AND epoch = ?2 AND idempotency_key = ?3",
                params![
                    request.namespace,
                    LEGACY_IDEMPOTENCY_EPOCH,
                    request.idempotency_key
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "idempotency result read", source))?;
        if let Some((stored_request, result)) = existing {
            return Ok(match result {
                Some(result) if stored_request == request.request_json => {
                    IdempotencySaveOutcome::Replay(result)
                }
                _ => IdempotencySaveOutcome::Conflict,
            });
        }

        if let Some((stored_state, stored_payload)) =
            load_current_snapshot(&transaction, &self.path, self.platform)?
        {
            match state.revision.cmp(&stored_state.revision) {
                std::cmp::Ordering::Less => {
                    return Err(StorageError::StaleRevision {
                        stored: stored_state.revision,
                        attempted: state.revision,
                    });
                }
                std::cmp::Ordering::Equal if payload != stored_payload => {
                    return Err(StorageError::RevisionConflict {
                        revision: state.revision,
                    });
                }
                std::cmp::Ordering::Equal | std::cmp::Ordering::Greater => {}
            }
        }
        transaction
            .execute(
                "INSERT INTO application_snapshot
                   (singleton, revision, json_payload, saved_at_ms)
                 VALUES
                   (?1, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER))
                 ON CONFLICT(singleton) DO UPDATE SET
                   revision = excluded.revision,
                   json_payload = excluded.json_payload,
                   saved_at_ms = excluded.saved_at_ms",
                params![SNAPSHOT_SINGLETON_ID, revision, payload],
            )
            .map_err(|source| database_error(&self.path, "snapshot replacement", source))?;
        prune_window_states(&transaction, state, &self.path)?;
        clear_legacy_snapshot_compatibility(&transaction, &self.path)?;
        transaction
            .execute(
                "INSERT INTO idempotency_results
                   (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                params![
                    request.namespace,
                    LEGACY_IDEMPOTENCY_EPOCH,
                    request.idempotency_key,
                    request.request_json,
                    request.result_json
                ],
            )
            .map_err(|source| database_error(&self.path, "idempotency result insert", source))?;
        transaction
            .execute(
                "UPDATE idempotency_results SET result_json = NULL
                 WHERE namespace = ?1 AND epoch = ?2 AND sequence NOT IN (
                   SELECT sequence FROM idempotency_results
                   WHERE namespace = ?1 AND epoch = ?2 AND result_json IS NOT NULL
                   ORDER BY sequence DESC LIMIT ?3
                 )",
                params![
                    request.namespace,
                    LEGACY_IDEMPOTENCY_EPOCH,
                    retention_capacity
                ],
            )
            .map_err(|source| database_error(&self.path, "idempotency retention trim", source))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "idempotency commit", source))?;
        Ok(IdempotencySaveOutcome::Committed)
    }

    /// Atomically replaces the current snapshot after validating it for the configured platform.
    ///
    /// # Errors
    /// Returns before touching `SQLite` if validation or serialization fails. `SQLite` write
    /// failures roll the transaction back and never deliberately replace the database file.
    pub fn save(&self, state: &ApplicationState) -> Result<(), StorageError> {
        state
            .validate_for_platform(self.platform)
            .map_err(|source| StorageError::InvalidState { source })?;
        let payload =
            serde_json::to_string(state).map_err(|source| StorageError::Serialize { source })?;
        let revision = state.revision.to_string();

        // This is the last fallible path-hardening operation. Once a transaction commits, its
        // successful outcome is never obscured by a subsequent filesystem error.
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| database_error(&self.path, "snapshot transaction begin", source))?;
        if let Some((stored_state, stored_payload)) =
            load_current_snapshot(&transaction, &self.path, self.platform)?
        {
            match state.revision.cmp(&stored_state.revision) {
                std::cmp::Ordering::Less => {
                    return Err(StorageError::StaleRevision {
                        stored: stored_state.revision,
                        attempted: state.revision,
                    });
                }
                std::cmp::Ordering::Equal if payload != stored_payload => {
                    return Err(StorageError::RevisionConflict {
                        revision: state.revision,
                    });
                }
                std::cmp::Ordering::Equal => {
                    // No write occurred, so dropping this transaction preserves the original
                    // timestamp and avoids manufacturing a fallible commit for an exact no-op.
                    return Ok(());
                }
                std::cmp::Ordering::Greater => {}
            }
        }
        transaction
            .execute(
                "INSERT INTO application_snapshot
                   (singleton, revision, json_payload, saved_at_ms)
                 VALUES
                   (?1, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER))
                 ON CONFLICT(singleton) DO UPDATE SET
                   revision = excluded.revision,
                   json_payload = excluded.json_payload,
                   saved_at_ms = excluded.saved_at_ms",
                params![SNAPSHOT_SINGLETON_ID, revision, payload],
            )
            .map_err(|source| database_error(&self.path, "snapshot replacement", source))?;
        prune_window_states(&transaction, state, &self.path)?;
        clear_legacy_snapshot_compatibility(&transaction, &self.path)?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "snapshot commit", source))?;
        Ok(())
    }

    /// Atomically saves validated desktop-window state with monotonic revision semantics.
    ///
    /// Saving identical content at the durable revision is a no-op. Older revisions are stale and
    /// divergent content at the same revision is a conflict.
    ///
    /// # Errors
    /// Returns before touching `SQLite` for invalid or unserializable state. Transactional failures
    /// leave the durable row unchanged.
    pub fn save_window_state(&self, state: &WindowState) -> Result<(), StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let window_id = default_window_id_from_connection(&connection, &self.path)?;
        drop(connection);
        self.save_window_state_internal(window_id, state, true)
    }

    /// Atomically saves bounds for one stable service-issued window placement.
    pub fn save_window_state_for(
        &self,
        window_id: WindowId,
        state: &WindowState,
    ) -> Result<(), StorageError> {
        self.save_window_state_internal(window_id, state, false)
    }

    fn save_window_state_internal(
        &self,
        window_id: WindowId,
        state: &WindowState,
        allow_legacy_bootstrap: bool,
    ) -> Result<(), StorageError> {
        state
            .validate()
            .map_err(|source| StorageError::InvalidWindowState { source })?;
        let payload =
            serde_json::to_string(state).map_err(|source| StorageError::Serialize { source })?;
        let revision = state.revision.to_string();

        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| {
                database_error(&self.path, "window-state transaction begin", source)
            })?;
        match load_current_snapshot(&transaction, &self.path, self.platform)? {
            Some((snapshot, _)) if snapshot.window_placement(window_id).is_none() => {
                return Err(StorageError::UnknownWindowPlacement { id: window_id });
            }
            None if !allow_legacy_bootstrap => {
                return Err(StorageError::UnknownWindowPlacement { id: window_id });
            }
            _ => {}
        }
        let stored = transaction
            .query_row(
                "SELECT revision, json_payload FROM window_state WHERE window_id = ?1",
                [window_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "existing window-state read", source))?;
        if stored.is_none() {
            let count: i64 = transaction
                .query_row("SELECT COUNT(*) FROM window_state", [], |row| row.get(0))
                .map_err(|source| database_error(&self.path, "window-state count", source))?;
            if count >= i64::try_from(WINDOW_STATE_CAP).unwrap_or(i64::MAX) {
                return Err(StorageError::WindowStateLimit {
                    actual: usize::try_from(count)
                        .unwrap_or(usize::MAX)
                        .saturating_add(1),
                    maximum: WINDOW_STATE_CAP,
                });
            }
        }
        if let Some((stored_revision, stored_payload)) = stored {
            let stored_state = decode_window_state(&stored_revision, &stored_payload)?;
            match state.revision.cmp(&stored_state.revision) {
                std::cmp::Ordering::Less => {
                    return Err(StorageError::StaleWindowStateRevision {
                        stored: stored_state.revision,
                        attempted: state.revision,
                    });
                }
                std::cmp::Ordering::Equal if payload != stored_payload => {
                    return Err(StorageError::WindowStateRevisionConflict {
                        revision: state.revision,
                    });
                }
                std::cmp::Ordering::Equal => return Ok(()),
                std::cmp::Ordering::Greater => {}
            }
        }
        transaction
            .execute(
                "INSERT INTO window_state
                   (window_id, revision, json_payload, saved_at_ms)
                 VALUES
                   (?1, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER))
                 ON CONFLICT(window_id) DO UPDATE SET
                   revision = excluded.revision,
                   json_payload = excluded.json_payload,
                   saved_at_ms = excluded.saved_at_ms",
                params![window_id.to_string(), revision, payload],
            )
            .map_err(|source| database_error(&self.path, "window-state replacement", source))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "window-state commit", source))?;
        Ok(())
    }

    /// Creates a data-preserving recovery copy without mutating the source.
    ///
    /// Readable databases use `SQLite`'s online-backup API so committed WAL state is included. If
    /// `SQLite` reports a corrupt source or produces an unusable copy, this falls back to the exact
    /// bytes of the main database file. The fallback deliberately does not merge `-wal` or `-shm`
    /// sidecars: without a readable `SQLite` database, inventing a merge could destroy forensic
    /// evidence. A successful raw fallback is a recovery copy, not a claim of `SQLite` validity.
    ///
    /// # Errors
    /// Rejects unsafe source or destination paths and returns typed export failures. The source is
    /// opened read-only and is never reset, renamed, truncated, or deleted.
    pub fn export_recovery_copy(
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        mode: RecoveryExportMode,
    ) -> Result<RecoveryExportReport, StorageError> {
        export_recovery_copy(source.as_ref(), destination.as_ref(), mode)
    }

    /// Inspects a `SQLite` path without creating, migrating, hardening, or otherwise mutating it.
    #[must_use]
    pub fn inspect_recovery(
        path: impl AsRef<Path>,
        platform: ShortcutPlatform,
    ) -> RecoveryInspection {
        inspect_recovery(path.as_ref(), platform)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, StorageError> {
        self.connection
            .lock()
            .map_err(|_| StorageError::LockPoisoned)
    }
}

fn read_schema_version(connection: &Connection, path: &Path) -> Result<u32, StorageError> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|source| database_error(path, "schema-version read", source))
}

fn enable_wal(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|source| database_error(path, "WAL configuration", source))?;
    if !journal_mode.trim().eq_ignore_ascii_case("wal") {
        return Err(StorageError::WalUnavailable {
            path: path.to_path_buf(),
            found: journal_mode,
        });
    }
    Ok(())
}

fn decode_snapshot(
    stored_revision: &str,
    payload: &str,
    platform: ShortcutPlatform,
    legacy_compatibility: bool,
) -> Result<ApplicationState, StorageError> {
    let unchecked: UncheckedApplicationState =
        serde_json::from_str(payload).map_err(|source| StorageError::MalformedSnapshot {
            revision: stored_revision.to_owned(),
            source,
        })?;
    let state = if legacy_compatibility {
        ApplicationState::try_from_schema_v3(unchecked)
    } else {
        ApplicationState::try_from(unchecked)
    }
    .map_err(|source| StorageError::InvalidSnapshot {
        revision: stored_revision.to_owned(),
        source,
    })?;
    if state.revision.to_string() != stored_revision {
        return Err(StorageError::RevisionMismatch {
            message: format!(
                "row records revision `{stored_revision}` but JSON payload records `{}`",
                state.revision
            ),
        });
    }
    state
        .validate_for_platform(platform)
        .map_err(|source| StorageError::InvalidSnapshot {
            revision: stored_revision.to_owned(),
            source,
        })?;
    Ok(state)
}

fn decode_current_snapshot(
    connection: &Connection,
    path: &Path,
    stored_revision: &str,
    payload: &str,
    platform: ShortcutPlatform,
) -> Result<ApplicationState, StorageError> {
    decode_snapshot(
        stored_revision,
        payload,
        platform,
        legacy_snapshot_compatibility(connection, path)?,
    )
}

fn load_current_snapshot(
    connection: &Connection,
    path: &Path,
    platform: ShortcutPlatform,
) -> Result<Option<(ApplicationState, String)>, StorageError> {
    let stored = connection
        .query_row(
            "SELECT revision, json_payload FROM application_snapshot WHERE singleton = ?1",
            [SNAPSHOT_SINGLETON_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|source| database_error(path, "existing snapshot read", source))?;
    stored
        .map(|(revision, payload)| {
            decode_current_snapshot(connection, path, &revision, &payload, platform)
                .map(|state| (state, payload))
        })
        .transpose()
}

fn legacy_snapshot_compatibility(
    connection: &Connection,
    path: &Path,
) -> Result<bool, StorageError> {
    let value: u8 = connection
        .query_row(
            "SELECT legacy_snapshot_compatibility FROM migration_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|source| database_error(path, "migration compatibility read", source))?;
    Ok(value == 1)
}

fn clear_legacy_snapshot_compatibility(
    connection: &Connection,
    path: &Path,
) -> Result<(), StorageError> {
    connection
        .execute(
            "UPDATE migration_metadata SET legacy_snapshot_compatibility = 0 WHERE singleton = 1",
            [],
        )
        .map_err(|source| database_error(path, "migration compatibility clear", source))?;
    Ok(())
}

fn decode_window_state(stored_revision: &str, payload: &str) -> Result<WindowState, StorageError> {
    let state: WindowState =
        serde_json::from_str(payload).map_err(|source| StorageError::MalformedWindowState {
            revision: stored_revision.to_owned(),
            source,
        })?;
    state
        .validate()
        .map_err(|source| StorageError::InvalidStoredWindowState {
            revision: stored_revision.to_owned(),
            source,
        })?;
    if state.revision.to_string() != stored_revision {
        return Err(StorageError::WindowStateRevisionMismatch {
            message: format!(
                "row records revision `{stored_revision}` but JSON payload records `{}`",
                state.revision
            ),
        });
    }
    Ok(state)
}

fn load_snapshot_from_connection(
    connection: &Connection,
    path: &Path,
    platform: ShortcutPlatform,
    legacy_compatibility: bool,
) -> Result<Option<ApplicationState>, StorageError> {
    let stored = connection
        .query_row(
            "SELECT revision, json_payload FROM application_snapshot WHERE singleton = ?1",
            [SNAPSHOT_SINGLETON_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|source| database_error(path, "snapshot read", source))?;
    stored
        .map(|(revision, payload)| {
            decode_snapshot(&revision, &payload, platform, legacy_compatibility)
        })
        .transpose()
}

fn load_window_state_from_connection(
    connection: &Connection,
    path: &Path,
) -> Result<Option<WindowState>, StorageError> {
    let stored = connection
        .query_row(
            "SELECT revision, json_payload FROM window_state ORDER BY window_id LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|source| database_error(path, "window-state read", source))?;
    stored
        .map(|(revision, payload)| decode_window_state(&revision, &payload))
        .transpose()
}

fn inspect_all_window_states_from_connection(
    connection: &Connection,
    path: &Path,
) -> Result<Option<u64>, StorageError> {
    let mut statement = connection
        .prepare("SELECT window_id, revision, json_payload FROM window_state ORDER BY window_id")
        .map_err(|source| database_error(path, "window-state inspection preparation", source))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|source| database_error(path, "window-state inspection read", source))?;
    let mut first_revision = None;
    for row in rows {
        let (window_id, revision, payload) =
            row.map_err(|source| database_error(path, "window-state inspection row", source))?;
        Uuid::parse_str(&window_id).map_err(|_| StorageError::CorruptSchema {
            path: path.to_path_buf(),
            message: "window_state contains a malformed window UUID".to_owned(),
        })?;
        let state = decode_window_state(&revision, &payload)?;
        first_revision.get_or_insert(state.revision);
    }
    Ok(first_revision)
}

fn load_window_state_for_connection(
    connection: &Connection,
    path: &Path,
    window_id: WindowId,
) -> Result<Option<WindowState>, StorageError> {
    let stored = connection
        .query_row(
            "SELECT revision, json_payload FROM window_state WHERE window_id = ?1",
            [window_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|source| database_error(path, "window-state read", source))?;
    stored
        .map(|(revision, payload)| decode_window_state(&revision, &payload))
        .transpose()
}

fn prune_window_states(
    connection: &Connection,
    state: &ApplicationState,
    path: &Path,
) -> Result<(), StorageError> {
    let owned: std::collections::BTreeSet<_> = state
        .window_placements
        .iter()
        .map(|placement| placement.id.to_string())
        .collect();
    let mut statement = connection
        .prepare("SELECT window_id FROM window_state")
        .map_err(|source| database_error(path, "window-state prune preparation", source))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|source| database_error(path, "window-state prune read", source))?;
    let mut obsolete_ids = Vec::new();
    for row in rows {
        let id = row.map_err(|source| database_error(path, "window-state prune row", source))?;
        if !owned.contains(&id) {
            obsolete_ids.push(id);
        }
    }
    drop(statement);
    for id in obsolete_ids {
        connection
            .execute("DELETE FROM window_state WHERE window_id = ?1", [id])
            .map_err(|source| database_error(path, "window-state prune delete", source))?;
    }
    Ok(())
}

fn default_window_id_from_connection(
    connection: &Connection,
    path: &Path,
) -> Result<WindowId, StorageError> {
    if let Some(value) = connection
        .query_row(
            "SELECT window_id FROM window_state ORDER BY window_id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|source| database_error(path, "legacy window projection read", source))?
    {
        let uuid = Uuid::parse_str(&value).map_err(|_| StorageError::CorruptSchema {
            path: path.to_path_buf(),
            message: "window_state contains a malformed window UUID".to_owned(),
        })?;
        return Ok(WindowId::from_uuid(uuid));
    }
    let selected: Option<String> = connection.query_row(
        "SELECT json_extract(json_payload, '$.selectedWorkspaceId') FROM application_snapshot WHERE singleton = 1",
        [],
        |row| row.get(0),
    ).optional().map_err(|source| database_error(path, "legacy window projection snapshot read", source))?;
    let uuid = selected
        .as_deref()
        .and_then(|value| Uuid::parse_str(value).ok())
        .unwrap_or_else(|| Uuid::parse_str(LEGACY_IDEMPOTENCY_EPOCH).expect("constant UUID"));
    Ok(WindowId::from_uuid(uuid))
}

fn read_idempotency_epoch(connection: &Connection, path: &Path) -> Result<Uuid, StorageError> {
    let value: String = connection
        .query_row(
            "SELECT epoch FROM idempotency_epoch WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|source| database_error(path, "idempotency epoch read", source))?;
    Uuid::parse_str(&value).map_err(|_| StorageError::CorruptSchema {
        path: path.to_path_buf(),
        message: "idempotency_epoch contains a malformed UUID".to_owned(),
    })
}

fn validate_epoch_request_fields(
    namespace: &str,
    request_hash: &str,
    result_bytes: usize,
    retention_capacity: usize,
) -> Result<(), StorageError> {
    if namespace.is_empty() || namespace.chars().count() > IDEMPOTENCY_NAMESPACE_MAX_CHARS {
        return Err(StorageError::InvalidIdempotencyRequest {
            message: "namespace is empty or exceeds 128 scalars".to_owned(),
        });
    }
    if request_hash.len() != 64
        || !request_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StorageError::InvalidIdempotencyRequest {
            message: "request_hash must be 64 lowercase hexadecimal characters".to_owned(),
        });
    }
    if result_bytes > IDEMPOTENCY_RESULT_MAX_BYTES {
        return Err(StorageError::InvalidIdempotencyRequest {
            message: "result exceeds 256 KiB".to_owned(),
        });
    }
    if retention_capacity == 0 || retention_capacity > IDEMPOTENCY_RESULT_RETENTION_CAP {
        return Err(StorageError::InvalidIdempotencyRequest {
            message: "retention capacity must be between 1 and 4096".to_owned(),
        });
    }
    Ok(())
}

fn verify_schema_v11(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_schema_v6(connection, path)?;
    verify_table_schema(
        connection,
        path,
        "action_provider_recovery",
        action_provider_recovery::EXPECTED_ACTION_PROVIDER_RECOVERY_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "browser_automation_sessions",
        browser_automation::EXPECTED_BROWSER_AUTOMATION_SESSIONS_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "browser_automation_operations",
        browser_automation::EXPECTED_BROWSER_AUTOMATION_OPERATIONS_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "browser_automation_tombstones",
        browser_automation::EXPECTED_BROWSER_AUTOMATION_TOMBSTONES_SCHEMA,
        SCHEMA_VERSION,
    )?;
    agent_sessions::verify_schema(connection, path)?;
    remote_sessions::verify_schema(connection, path)?;
    sidebar_content::verify_schema(connection, path)
}

fn verify_schema_v12(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_schema_v11(connection, path)?;
    remote_sessions::verify_deletion_schema(connection, path)
}

fn verify_schema_v13(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_schema_v12(connection, path)?;
    agent_sessions::verify_v13_schema(connection, path)
}

fn verify_current_schema(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_schema_v13(connection, path)?;
    remote_sessions::verify_enrollment_schema(connection, path)?;
    sidebar_content::verify_v15_schema(connection, path)
}

fn verify_schema_v6(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_schema_v5(connection, path)?;
    verify_table_schema(
        connection,
        path,
        "action_invocations",
        action_invocations::EXPECTED_ACTION_INVOCATIONS_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "action_invocation_tombstones",
        action_invocations::EXPECTED_ACTION_TOMBSTONES_SCHEMA,
        SCHEMA_VERSION,
    )
}

fn verify_schema_v5(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_table_schema(
        connection,
        path,
        "application_snapshot",
        EXPECTED_SNAPSHOT_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "idempotency_epoch",
        EXPECTED_IDEMPOTENCY_EPOCH_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "window_state",
        EXPECTED_WINDOW_STATE_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "idempotency_results",
        EXPECTED_IDEMPOTENCY_RESULTS_SCHEMA,
        SCHEMA_VERSION,
    )?;
    verify_table_schema(
        connection,
        path,
        "migration_metadata",
        EXPECTED_MIGRATION_METADATA_SCHEMA,
        SCHEMA_VERSION,
    )
}

fn verify_schema_for_version(
    connection: &Connection,
    path: &Path,
    version: u32,
) -> Result<(), StorageError> {
    match version {
        1 => verify_table_schema(
            connection,
            path,
            "application_snapshot",
            EXPECTED_SNAPSHOT_SCHEMA,
            1,
        ),
        2 => {
            verify_table_schema(
                connection,
                path,
                "application_snapshot",
                EXPECTED_SNAPSHOT_SCHEMA,
                2,
            )?;
            verify_table_schema(
                connection,
                path,
                "window_state",
                EXPECTED_LEGACY_WINDOW_STATE_SCHEMA,
                2,
            )
        }
        3 => {
            verify_table_schema(
                connection,
                path,
                "application_snapshot",
                EXPECTED_SNAPSHOT_SCHEMA,
                3,
            )?;
            verify_table_schema(
                connection,
                path,
                "window_state",
                EXPECTED_LEGACY_WINDOW_STATE_SCHEMA,
                3,
            )?;
            verify_table_schema(
                connection,
                path,
                "idempotency_results",
                EXPECTED_LEGACY_IDEMPOTENCY_RESULTS_SCHEMA,
                3,
            )
        }
        4 => {
            verify_table_schema(
                connection,
                path,
                "application_snapshot",
                EXPECTED_SNAPSHOT_SCHEMA,
                4,
            )?;
            verify_table_schema(
                connection,
                path,
                "window_state",
                EXPECTED_LEGACY_WINDOW_STATE_SCHEMA,
                4,
            )?;
            verify_table_schema(
                connection,
                path,
                "idempotency_results",
                EXPECTED_LEGACY_IDEMPOTENCY_RESULTS_SCHEMA,
                4,
            )?;
            verify_table_schema(
                connection,
                path,
                "migration_metadata",
                EXPECTED_MIGRATION_METADATA_SCHEMA,
                4,
            )
        }
        5 => verify_schema_v5(connection, path),
        6 => verify_schema_v6(connection, path),
        7 => {
            verify_schema_v6(connection, path)?;
            verify_table_schema(
                connection,
                path,
                "action_provider_recovery",
                action_provider_recovery::EXPECTED_ACTION_PROVIDER_RECOVERY_SCHEMA,
                7,
            )
        }
        8 => {
            verify_schema_v6(connection, path)?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_sessions",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_SESSIONS_SCHEMA,
                8,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_operations",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_OPERATIONS_SCHEMA,
                8,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_tombstones",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_TOMBSTONES_SCHEMA,
                8,
            )
        }
        9 => {
            verify_schema_v6(connection, path)?;
            verify_table_schema(
                connection,
                path,
                "action_provider_recovery",
                action_provider_recovery::EXPECTED_ACTION_PROVIDER_RECOVERY_SCHEMA,
                9,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_sessions",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_SESSIONS_SCHEMA,
                9,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_operations",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_OPERATIONS_SCHEMA,
                9,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_tombstones",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_TOMBSTONES_SCHEMA,
                9,
            )?;
            agent_sessions::verify_schema(connection, path)
        }
        10 => {
            verify_schema_v6(connection, path)?;
            verify_table_schema(
                connection,
                path,
                "action_provider_recovery",
                action_provider_recovery::EXPECTED_ACTION_PROVIDER_RECOVERY_SCHEMA,
                10,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_sessions",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_SESSIONS_SCHEMA,
                10,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_operations",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_OPERATIONS_SCHEMA,
                10,
            )?;
            verify_table_schema(
                connection,
                path,
                "browser_automation_tombstones",
                browser_automation::EXPECTED_BROWSER_AUTOMATION_TOMBSTONES_SCHEMA,
                10,
            )?;
            agent_sessions::verify_schema(connection, path)?;
            remote_sessions::verify_schema(connection, path)
        }
        11 => verify_schema_v11(connection, path),
        12 => verify_schema_v12(connection, path),
        13 => verify_schema_v13(connection, path),
        14 => {
            verify_schema_v13(connection, path)?;
            remote_sessions::verify_enrollment_schema(connection, path)
        }
        15 => verify_current_schema(connection, path),
        _ => Ok(()),
    }
}

fn verify_table_schema(
    connection: &Connection,
    path: &Path,
    table: &'static str,
    expected: &str,
    version: u32,
) -> Result<(), StorageError> {
    let schema: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .optional()
        .map_err(|source| database_error(path, "schema readiness verification", source))?;
    let Some(schema) = schema else {
        return Err(StorageError::CorruptSchema {
            path: path.to_path_buf(),
            message: format!("required `{table}` table is missing"),
        });
    };
    if normalized_schema(&schema) != normalized_schema(expected) {
        return Err(StorageError::CorruptSchema {
            path: path.to_path_buf(),
            message: format!("`{table}` definition does not match schema version {version}"),
        });
    }
    Ok(())
}

fn normalized_schema(schema: &str) -> String {
    schema
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn migrate(
    connection: &mut Connection,
    path: &Path,
    mut version: u32,
    platform: ShortcutPlatform,
) -> Result<MigrationOutcome, StorageError> {
    let initial_version = version;
    if version == SCHEMA_VERSION {
        return Ok(MigrationOutcome::Current { version });
    }
    let backup_path = if version > 0 {
        Some(create_migration_backup(
            connection,
            path,
            version,
            SCHEMA_VERSION,
        )?)
    } else {
        None
    };
    if version > 0 {
        validate_pre_migration_snapshot(
            connection,
            path,
            initial_version,
            backup_path.as_deref(),
            platform,
        )?;
    }
    while version < SCHEMA_VERSION {
        let target = version + 1;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| StorageError::Migration {
                path: path.to_path_buf(),
                from: version,
                to: target,
                backup_path: backup_path.clone(),
                source,
            })?;
        let result = match target {
            1 => transaction.execute_batch(
                "CREATE TABLE application_snapshot (\
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\
                   revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),\
                   json_payload TEXT NOT NULL,\
                   saved_at_ms INTEGER NOT NULL\
                 );\
                 PRAGMA user_version = 1;",
            ),
            2 => transaction.execute_batch(
                "CREATE TABLE window_state (\
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\
                   revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),\
                   json_payload TEXT NOT NULL,\
                   saved_at_ms INTEGER NOT NULL\
                 );\
                 PRAGMA user_version = 2;",
            ),
            3 => transaction.execute_batch(
                "CREATE TABLE idempotency_results (\
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,\
                   namespace TEXT NOT NULL,\
                   idempotency_key TEXT NOT NULL,\
                   request_json TEXT NOT NULL,\
                   result_json TEXT NOT NULL,\
                   completed_at_ms INTEGER NOT NULL,\
                   UNIQUE(namespace, idempotency_key)\
                 );\
                 PRAGMA user_version = 3;",
            ),
            4 => migrate_to_v4(
                &transaction,
                initial_version,
                backup_path.as_deref(),
                platform,
            ),
            5 => migrate_to_v5(&transaction, platform),
            6 => action_invocations::migrate_to_v6(&transaction),
            7 => action_provider_recovery::migrate_to_v7(&transaction),
            8 => browser_automation::migrate_to_v8(&transaction),
            9 => agent_sessions::migrate_to_v9(&transaction),
            10 => remote_sessions::migrate_to_v10(&transaction),
            11 => sidebar_content::migrate_to_v11(&transaction),
            12 => remote_sessions::migrate_to_v12(&transaction),
            13 => agent_sessions::migrate_to_v13(&transaction),
            14 => remote_sessions::migrate_to_v14(&transaction),
            15 => sidebar_content::migrate_to_v15(&transaction),
            _ => unreachable!("migration target is bounded by SCHEMA_VERSION"),
        };
        result.map_err(|source| StorageError::Migration {
            path: path.to_path_buf(),
            from: version,
            to: target,
            backup_path: backup_path.clone(),
            source,
        })?;
        transaction
            .commit()
            .map_err(|source| StorageError::Migration {
                path: path.to_path_buf(),
                from: version,
                to: target,
                backup_path: backup_path.clone(),
                source,
            })?;
        version = target;
    }
    Ok(completed_migration_outcome(
        initial_version,
        version,
        backup_path,
    ))
}

fn completed_migration_outcome(
    from: u32,
    to: u32,
    backup_path: Option<PathBuf>,
) -> MigrationOutcome {
    match backup_path {
        Some(backup_path) => MigrationOutcome::Upgraded {
            from,
            to,
            backup_path,
        },
        None => MigrationOutcome::Initialized { from, to },
    }
}

fn validate_pre_migration_snapshot(
    connection: &Connection,
    path: &Path,
    from: u32,
    backup_path: Option<&Path>,
    platform: ShortcutPlatform,
) -> Result<(), StorageError> {
    let migration_error = |source| StorageError::Migration {
        path: path.to_path_buf(),
        from,
        to: SCHEMA_VERSION,
        backup_path: backup_path.map(Path::to_path_buf),
        source,
    };
    let stored = connection
        .query_row(
            "SELECT revision, json_payload FROM application_snapshot WHERE singleton = ?1",
            [SNAPSHOT_SINGLETON_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(migration_error)?;
    if let Some((revision, payload)) = stored {
        validate_v4_migration_snapshot(&revision, &payload, platform).map_err(migration_error)?;
    }
    Ok(())
}

fn migrate_to_v4(
    transaction: &rusqlite::Transaction<'_>,
    source_version: u32,
    backup_path: Option<&Path>,
    platform: ShortcutPlatform,
) -> rusqlite::Result<()> {
    // Decode through the schema-v4 checked aggregate without rewriting the payload. This is what
    // preserves every supported v3 snapshot byte-for-byte, including an over-limit snapshot whose
    // missing organization fields are inferred as safe defaults by the core conversion layer.
    let stored = transaction
        .query_row(
            "SELECT revision, json_payload FROM application_snapshot WHERE singleton = ?1",
            [SNAPSHOT_SINGLETON_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let has_snapshot = stored.is_some();
    if let Some((revision, payload)) = stored {
        validate_v4_migration_snapshot(&revision, &payload, platform)?;
    }
    let legacy_snapshot_compatibility = u8::from(source_version > 0 && has_snapshot);
    transaction.execute_batch(
        "CREATE TABLE migration_metadata (\
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\
           source_version INTEGER NOT NULL,\
           target_version INTEGER NOT NULL,\
           backup_path TEXT,\
           legacy_snapshot_compatibility INTEGER NOT NULL CHECK (legacy_snapshot_compatibility IN (0, 1)),\
           migrated_at_ms INTEGER NOT NULL\
         );",
    )?;
    transaction.execute(
        "INSERT INTO migration_metadata
           (singleton, source_version, target_version, backup_path, legacy_snapshot_compatibility, migrated_at_ms)
         VALUES (1, ?1, 4, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
        params![
            source_version,
            backup_path.map(Path::to_string_lossy),
            legacy_snapshot_compatibility
        ],
    )?;
    transaction.pragma_update(None, "user_version", 4_u32)?;
    Ok(())
}

fn validate_v4_migration_snapshot(
    revision: &str,
    payload: &str,
    platform: ShortcutPlatform,
) -> rusqlite::Result<()> {
    let unchecked: UncheckedApplicationState = serde_json::from_str(payload).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(source))
    })?;
    let state = ApplicationState::try_from_schema_v3(unchecked).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(source))
    })?;
    if state.revision.to_string() != revision {
        return Err(rusqlite::Error::InvalidQuery);
    }
    state.validate_for_platform(platform).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(source))
    })
}

fn migrate_to_v5(
    transaction: &rusqlite::Transaction<'_>,
    platform: ShortcutPlatform,
) -> rusqlite::Result<()> {
    let stored = transaction
        .query_row(
            "SELECT revision, json_payload FROM application_snapshot WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let mut initial_window_id = Uuid::parse_str(LEGACY_IDEMPOTENCY_EPOCH).expect("constant UUID");
    if let Some((revision, payload)) = stored {
        let unchecked: UncheckedApplicationState =
            serde_json::from_str(&payload).map_err(|source| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(source),
                )
            })?;
        let legacy_compatibility: u8 = transaction.query_row(
            "SELECT legacy_snapshot_compatibility FROM migration_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let state = if legacy_compatibility == 1 {
            ApplicationState::try_from_schema_v3(unchecked)
        } else {
            ApplicationState::try_from_schema_v4(unchecked)
        }
        .map_err(|source| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(source),
            )
        })?;
        if state.revision.to_string() != revision {
            return Err(rusqlite::Error::InvalidQuery);
        }
        state.validate_for_platform(platform).map_err(|source| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(source),
            )
        })?;
        initial_window_id = state.focused_window_id.as_uuid();
        let migrated = serde_json::to_string(&state)
            .map_err(|source| rusqlite::Error::ToSqlConversionFailure(Box::new(source)))?;
        transaction.execute(
            "UPDATE application_snapshot SET json_payload = ?1 WHERE singleton = 1",
            [migrated],
        )?;
    }

    transaction.execute_batch(
        "ALTER TABLE window_state RENAME TO window_state_v4;\
         CREATE TABLE window_state (\
           window_id TEXT PRIMARY KEY CHECK (length(window_id) = 36),\
           revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),\
           json_payload TEXT NOT NULL,\
           saved_at_ms INTEGER NOT NULL\
         );",
    )?;
    transaction.execute(
        "INSERT INTO window_state (window_id, revision, json_payload, saved_at_ms)
         SELECT ?1, revision, json_payload, saved_at_ms FROM window_state_v4 WHERE singleton = 1",
        [initial_window_id.to_string()],
    )?;
    transaction.execute_batch("DROP TABLE window_state_v4;")?;

    let epoch = Uuid::new_v4();
    transaction.execute_batch(
        "ALTER TABLE idempotency_results RENAME TO idempotency_results_v4;\
         CREATE TABLE idempotency_results (\
           sequence INTEGER PRIMARY KEY AUTOINCREMENT,\
           namespace TEXT NOT NULL,\
           epoch TEXT NOT NULL CHECK (length(epoch) = 36),\
           idempotency_key TEXT NOT NULL,\
           request_hash TEXT NOT NULL,\
           result_json TEXT,\
           completed_at_ms INTEGER NOT NULL,\
           UNIQUE(namespace, epoch, idempotency_key)\
         );\
         CREATE TABLE idempotency_epoch (\
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\
           epoch TEXT NOT NULL CHECK (length(epoch) = 36),\
           issued_at_ms INTEGER NOT NULL\
         );",
    )?;
    transaction.execute(
        "INSERT INTO idempotency_results
         (sequence, namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
         SELECT sequence, namespace, ?1, idempotency_key, request_json, result_json, completed_at_ms
         FROM idempotency_results_v4 ORDER BY sequence",
        [LEGACY_IDEMPOTENCY_EPOCH],
    )?;
    transaction.execute(
        "INSERT INTO idempotency_epoch (singleton, epoch, issued_at_ms)
         VALUES (1, ?1, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
        [epoch.to_string()],
    )?;
    transaction.execute_batch(
        "DROP TABLE idempotency_results_v4;\
         UPDATE migration_metadata SET target_version = 5, legacy_snapshot_compatibility = 0 WHERE singleton = 1;\
         PRAGMA user_version = 5;",
    )?;
    Ok(())
}

fn create_migration_backup(
    connection: &Connection,
    path: &Path,
    from: u32,
    to: u32,
) -> Result<PathBuf, StorageError> {
    let label = format!(".pre-v{from}-to-v{to}.backup");
    let (backup_path, reservation) =
        reserve_unique_adjacent_file(path, &label).map_err(|source| {
            StorageError::MigrationBackup {
                path: path.to_path_buf(),
                from,
                to,
                backup_path: adjacent_path(path, &label),
                message: source.to_string(),
            }
        })?;
    drop(reservation);
    if let Err(source) = backup_connection(connection, &backup_path) {
        remove_created_file(&backup_path);
        return Err(StorageError::MigrationBackup {
            path: path.to_path_buf(),
            from,
            to,
            backup_path,
            message: source.to_string(),
        });
    }
    if let Err(source) = secure_database_file(&backup_path) {
        remove_created_file(&backup_path);
        return Err(StorageError::MigrationBackup {
            path: path.to_path_buf(),
            from,
            to,
            backup_path,
            message: source.to_string(),
        });
    }
    Ok(backup_path)
}

fn backup_connection(source: &Connection, destination: &Path) -> rusqlite::Result<()> {
    let mut destination = Connection::open_with_flags(
        destination,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let backup = backup::Backup::new(source, &mut destination)?;
    backup.run_to_completion(128, Duration::from_millis(10), None)
}

fn adjacent_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn reserve_unique_adjacent_file(
    source: &Path,
    label: &str,
) -> Result<(PathBuf, std::fs::File), std::io::Error> {
    let base = adjacent_path(source, label);
    for attempt in 0..1_024_u16 {
        let candidate = if attempt == 0 {
            base.clone()
        } else {
            let mut value: OsString = base.as_os_str().to_owned();
            value.push(format!(".{attempt}"));
            PathBuf::from(value)
        };
        match create_owner_only_file(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(source) => return Err(source),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "all bounded adjacent backup names already exist",
    ))
}

fn create_owner_only_file(path: &Path) -> Result<std::fs::File, std::io::Error> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn remove_created_file(path: &Path) {
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_file(path);
    }
}

fn export_recovery_copy(
    source_path: &Path,
    destination: &Path,
    mode: RecoveryExportMode,
) -> Result<RecoveryExportReport, StorageError> {
    let source_identity = validated_destination_identity(source_path).map_err(|message| {
        StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "source validation",
            message,
        }
    })?;
    if source_path == destination {
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "destination validation",
            message: "source and destination paths must differ".to_owned(),
        });
    }
    let parent = destination
        .parent()
        .filter(|value| !value.as_os_str().is_empty());
    if let Some(parent) = parent {
        prepare_parent_directory(parent).map_err(|source| StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "destination parent preparation",
            message: source.to_string(),
        })?;
        secure_directory(parent).map_err(|source| StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "destination parent hardening",
            message: source.to_string(),
        })?;
    }

    // Keep a validated raw handle open from before SQLite touches the source. It is used only if
    // SQLite identifies corruption, and lets the fallback preserve the originally validated file
    // rather than following a path that may have been exchanged in the meantime.
    let mut raw_source =
        open_validated_source(source_path, &source_identity).map_err(|message| {
            StorageError::RecoveryExport {
                source_path: source_path.to_path_buf(),
                destination: destination.to_path_buf(),
                operation: "read-only source open",
                message,
            }
        })?;
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    );
    let source = match source {
        Ok(source) => {
            source
                .busy_timeout(DEFAULT_BUSY_TIMEOUT)
                .map_err(|source| StorageError::RecoveryExport {
                    source_path: source_path.to_path_buf(),
                    destination: destination.to_path_buf(),
                    operation: "source busy-timeout configuration",
                    message: source.to_string(),
                })?;
            Some(source)
        }
        Err(error) if sqlite_error_indicates_corrupt_source(&error) => None,
        Err(source) => {
            return Err(StorageError::RecoveryExport {
                source_path: source_path.to_path_buf(),
                destination: destination.to_path_buf(),
                operation: "read-only source open",
                message: source.to_string(),
            });
        }
    };
    ensure_path_identity(source_path, &source_identity).map_err(|message| {
        StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "source revalidation",
            message,
        }
    })?;

    match mode {
        RecoveryExportMode::CreateNew => export_create_new(
            source.as_ref(),
            &mut raw_source,
            &source_identity,
            source_path,
            destination,
        ),
        RecoveryExportMode::ReplaceExisting => export_replace_existing(
            source.as_ref(),
            &mut raw_source,
            &source_identity,
            source_path,
            destination,
        ),
    }
}

fn export_create_new(
    sqlite_source: Option<&Connection>,
    raw_source: &mut File,
    source_identity: &FileIdentity,
    source_path: &Path,
    destination: &Path,
) -> Result<RecoveryExportReport, StorageError> {
    let mut reservation =
        create_owner_only_file(destination).map_err(|source| StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "exclusive destination creation",
            message: source.to_string(),
        })?;
    let reservation_identity = validated_destination_identity(destination).map_err(|message| {
        remove_created_file(destination);
        StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "destination reservation validation",
            message,
        }
    })?;
    if let Err(error) = populate_recovery_copy(
        sqlite_source,
        raw_source,
        source_identity,
        source_path,
        destination,
        &mut reservation,
        &reservation_identity,
    ) {
        remove_created_file_if_identity(destination, &reservation_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: error.operation,
            message: error.message,
        });
    }
    if let Err(source) = secure_database_file(destination) {
        remove_created_file_if_identity(destination, &reservation_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "destination hardening",
            message: source.to_string(),
        });
    }
    if let Err(message) = ensure_path_identity(destination, &reservation_identity) {
        remove_created_file_if_identity(destination, &reservation_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "destination revalidation",
            message,
        });
    }
    drop(reservation);
    Ok(RecoveryExportReport {
        destination: destination.to_path_buf(),
        replaced_existing: false,
    })
}

fn export_replace_existing(
    sqlite_source: Option<&Connection>,
    raw_source: &mut File,
    source_identity: &FileIdentity,
    source_path: &Path,
    destination: &Path,
) -> Result<RecoveryExportReport, StorageError> {
    let original_identity = validated_destination_identity(destination).map_err(|message| {
        StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "replacement destination validation",
            message,
        }
    })?;
    if same_file_identity(source_path, destination).unwrap_or(false) {
        return Err(recovery_export_error(
            source_path,
            destination,
            "replacement destination validation",
            "source and destination resolve to the same filesystem object",
        ));
    }
    let (temporary, mut reservation) =
        reserve_unique_adjacent_file(destination, ".recovery-export.tmp").map_err(|source| {
            StorageError::RecoveryExport {
                source_path: source_path.to_path_buf(),
                destination: destination.to_path_buf(),
                operation: "temporary destination creation",
                message: source.to_string(),
            }
        })?;
    let temporary_identity = validated_destination_identity(&temporary).map_err(|message| {
        remove_created_file(&temporary);
        StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "temporary destination validation",
            message,
        }
    })?;
    if let Err(error) = populate_recovery_copy(
        sqlite_source,
        raw_source,
        source_identity,
        source_path,
        &temporary,
        &mut reservation,
        &temporary_identity,
    ) {
        remove_created_file_if_identity(&temporary, &temporary_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: error.operation,
            message: error.message,
        });
    }
    if let Err(source) = secure_database_file(&temporary) {
        remove_created_file_if_identity(&temporary, &temporary_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "temporary destination hardening",
            message: source.to_string(),
        });
    }
    if let Err(message) = ensure_path_identity(&temporary, &temporary_identity) {
        remove_created_file_if_identity(&temporary, &temporary_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "temporary destination revalidation",
            message,
        });
    }
    // Release the checked handle before rename for Windows compatibility.
    drop(reservation);
    publish_recovery_replacement(
        source_path,
        destination,
        &temporary,
        &temporary_identity,
        &original_identity,
    )?;
    Ok(RecoveryExportReport {
        destination: destination.to_path_buf(),
        replaced_existing: true,
    })
}

fn publish_recovery_replacement(
    source_path: &Path,
    destination: &Path,
    temporary: &Path,
    temporary_identity: &FileIdentity,
    original_identity: &FileIdentity,
) -> Result<(), StorageError> {
    let current_identity = validated_destination_identity(destination).map_err(|message| {
        remove_created_file_if_identity(temporary, temporary_identity);
        StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "replacement destination revalidation",
            message,
        }
    })?;
    if &current_identity != original_identity {
        remove_created_file_if_identity(temporary, temporary_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "replacement destination revalidation",
            message: "destination changed while the recovery copy was prepared".to_owned(),
        });
    }
    if let Err(source) = std::fs::rename(temporary, destination) {
        remove_created_file_if_identity(temporary, temporary_identity);
        return Err(StorageError::RecoveryExport {
            source_path: source_path.to_path_buf(),
            destination: destination.to_path_buf(),
            operation: "atomic destination replacement",
            message: source.to_string(),
        });
    }
    Ok(())
}

fn recovery_export_error(
    source_path: &Path,
    destination: &Path,
    operation: &'static str,
    message: impl Into<String>,
) -> StorageError {
    StorageError::RecoveryExport {
        source_path: source_path.to_path_buf(),
        destination: destination.to_path_buf(),
        operation,
        message: message.into(),
    }
}

#[derive(Debug)]
struct RecoveryCopyPreparationError {
    operation: &'static str,
    message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceFileSnapshot {
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    modified_seconds: i64,
    #[cfg(unix)]
    modified_nanoseconds: i64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

fn populate_recovery_copy(
    sqlite_source: Option<&Connection>,
    raw_source: &mut File,
    source_identity: &FileIdentity,
    source_path: &Path,
    destination: &Path,
    destination_file: &mut File,
    destination_identity: &FileIdentity,
) -> Result<(), RecoveryCopyPreparationError> {
    if let Some(sqlite_source) = sqlite_source {
        match backup_connection(sqlite_source, destination) {
            Ok(()) => match sqlite_recovery_copy_is_usable(destination) {
                Ok(true) => {
                    ensure_path_identity(destination, destination_identity).map_err(|message| {
                        RecoveryCopyPreparationError {
                            operation: "SQLite recovery-copy revalidation",
                            message,
                        }
                    })?;
                    ensure_path_identity(source_path, source_identity).map_err(|message| {
                        RecoveryCopyPreparationError {
                            operation: "source revalidation",
                            message,
                        }
                    })?;
                    return Ok(());
                }
                Ok(false) => {}
                Err(error) if sqlite_error_indicates_corrupt_source(&error) => {}
                Err(error) => {
                    return Err(RecoveryCopyPreparationError {
                        operation: "SQLite recovery-copy verification",
                        message: error.to_string(),
                    });
                }
            },
            Err(error) if sqlite_error_indicates_corrupt_source(&error) => {}
            Err(error) => {
                return Err(RecoveryCopyPreparationError {
                    operation: "SQLite online backup",
                    message: error.to_string(),
                });
            }
        }
    }

    // A corrupt database's WAL cannot be merged safely without SQLite understanding the main
    // database. Preserve the exact main-file bytes as evidence instead of inventing a sidecar
    // merge or claiming that this fallback is a valid SQLite backup.
    copy_raw_main_database(
        raw_source,
        source_identity,
        source_path,
        destination_file,
        destination_identity,
        destination,
    )
}

fn sqlite_recovery_copy_is_usable(path: &Path) -> rusqlite::Result<bool> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map(|result| result == "ok")
}

fn sqlite_error_indicates_corrupt_source(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase,
                ..
            },
            _
        )
    )
}

fn open_validated_source(path: &Path, identity: &FileIdentity) -> Result<File, String> {
    let file = File::open(path).map_err(|source| source.to_string())?;
    validate_open_file_identity(&file, identity)?;
    ensure_path_identity(path, identity)?;
    Ok(file)
}

fn copy_raw_main_database(
    source: &mut File,
    source_identity: &FileIdentity,
    source_path: &Path,
    destination: &mut File,
    destination_identity: &FileIdentity,
    destination_path: &Path,
) -> Result<(), RecoveryCopyPreparationError> {
    validate_open_file_identity(source, source_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw source validation",
            message,
        }
    })?;
    ensure_path_identity(source_path, source_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw source revalidation",
            message,
        }
    })?;
    validate_open_file_identity(destination, destination_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw destination validation",
            message,
        }
    })?;
    ensure_path_identity(destination_path, destination_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw destination revalidation",
            message,
        }
    })?;

    let source_before =
        source_file_snapshot(source).map_err(|source| RecoveryCopyPreparationError {
            operation: "raw source snapshot",
            message: source.to_string(),
        })?;
    source
        .seek(SeekFrom::Start(0))
        .map_err(|source| RecoveryCopyPreparationError {
            operation: "raw source rewind",
            message: source.to_string(),
        })?;
    destination
        .set_len(0)
        .map_err(|source| RecoveryCopyPreparationError {
            operation: "raw destination truncation",
            message: source.to_string(),
        })?;
    destination
        .seek(SeekFrom::Start(0))
        .map_err(|source| RecoveryCopyPreparationError {
            operation: "raw destination rewind",
            message: source.to_string(),
        })?;
    let copied =
        std::io::copy(source, destination).map_err(|source| RecoveryCopyPreparationError {
            operation: "raw recovery copy",
            message: source.to_string(),
        })?;
    destination
        .flush()
        .map_err(|source| RecoveryCopyPreparationError {
            operation: "raw recovery-copy flush",
            message: source.to_string(),
        })?;
    destination
        .sync_all()
        .map_err(|source| RecoveryCopyPreparationError {
            operation: "raw recovery-copy synchronization",
            message: source.to_string(),
        })?;

    let source_after =
        source_file_snapshot(source).map_err(|source| RecoveryCopyPreparationError {
            operation: "raw source revalidation",
            message: source.to_string(),
        })?;
    if copied != source_before.length || source_after != source_before {
        return Err(RecoveryCopyPreparationError {
            operation: "raw source revalidation",
            message: "source changed while its recovery copy was being prepared".to_owned(),
        });
    }
    validate_open_file_identity(source, source_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw source revalidation",
            message,
        }
    })?;
    ensure_path_identity(source_path, source_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw source revalidation",
            message,
        }
    })?;
    validate_open_file_identity(destination, destination_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw destination revalidation",
            message,
        }
    })?;
    ensure_path_identity(destination_path, destination_identity).map_err(|message| {
        RecoveryCopyPreparationError {
            operation: "raw destination revalidation",
            message,
        }
    })
}

fn source_file_snapshot(file: &File) -> Result<SourceFileSnapshot, std::io::Error> {
    let metadata = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        Ok(SourceFileSnapshot {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(SourceFileSnapshot {
            length: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(not(unix))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    canonical_path: PathBuf,
}

fn ensure_path_identity(path: &Path, expected: &FileIdentity) -> Result<(), String> {
    let current = validated_destination_identity(path)?;
    if &current == expected {
        Ok(())
    } else {
        Err("filesystem object changed while the recovery copy was prepared".to_owned())
    }
}

fn validate_open_file_identity(file: &File, expected: &FileIdentity) -> Result<(), String> {
    let metadata = file.metadata().map_err(|source| source.to_string())?;
    if !metadata.is_file() {
        return Err("opened recovery file must be a regular file".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let current_uid = rustix::process::getuid().as_raw();
        if metadata.uid() != current_uid {
            return Err(format!(
                "opened recovery file is owned by uid {}, but current uid is {current_uid}",
                metadata.uid()
            ));
        }
        if metadata.nlink() != 1 {
            return Err(format!(
                "opened recovery file has {} hard links; expected exactly one",
                metadata.nlink()
            ));
        }
        let current = FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        if &current != expected {
            return Err("opened recovery file is not the validated filesystem object".to_owned());
        }
    }
    #[cfg(not(unix))]
    let _ = expected;
    Ok(())
}

fn remove_created_file_if_identity(path: &Path, expected: &FileIdentity) {
    if ensure_path_identity(path, expected).is_ok() {
        let _ = std::fs::remove_file(path);
    }
}

fn validated_destination_identity(path: &Path) -> Result<FileIdentity, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| source.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("destination must be a regular file, not a symlink or special file".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let current_uid = rustix::process::getuid().as_raw();
        if metadata.uid() != current_uid {
            return Err(format!(
                "destination is owned by uid {}, but current uid is {current_uid}",
                metadata.uid()
            ));
        }
        if metadata.nlink() != 1 {
            return Err(format!(
                "destination has {} hard links; expected exactly one",
                metadata.nlink()
            ));
        }
        Ok(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        std::fs::canonicalize(path)
            .map(|canonical_path| FileIdentity { canonical_path })
            .map_err(|source| source.to_string())
    }
}

fn same_file_identity(first: &Path, second: &Path) -> Result<bool, String> {
    let first = validated_destination_identity(first)?;
    let second = validated_destination_identity(second)?;
    Ok(first == second)
}

fn validate_read_only_source(path: &Path) -> Result<(), String> {
    validated_destination_identity(path).map(|_| ())
}

fn inspect_recovery(path: &Path, platform: ShortcutPlatform) -> RecoveryInspection {
    let classification = match inspect_recovery_inner(path, platform) {
        Ok(classification) => classification,
        Err(error) => RecoveryClassification::from_storage_error(&error),
    };
    RecoveryInspection {
        path: path.to_path_buf(),
        classification,
    }
}

fn inspect_recovery_inner(
    path: &Path,
    platform: ShortcutPlatform,
) -> Result<RecoveryClassification, StorageError> {
    validate_read_only_source(path).map_err(|message| StorageError::Permissions {
        path: path.to_path_buf(),
        message,
    })?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|source| database_error(path, "read-only recovery inspection open", source))?;
    connection
        .busy_timeout(DEFAULT_BUSY_TIMEOUT)
        .map_err(|source| database_error(path, "recovery inspection busy timeout", source))?;
    let version = read_schema_version(&connection, path)?;
    if version > SCHEMA_VERSION {
        return Ok(RecoveryClassification::FutureSchema {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }
    verify_schema_for_version(&connection, path, version)?;
    if version == 0 {
        return Ok(RecoveryClassification::MigrationRequired {
            from: 0,
            to: SCHEMA_VERSION,
            snapshot_revision: None,
        });
    }
    let legacy_compatibility = if version < SCHEMA_VERSION {
        true
    } else {
        legacy_snapshot_compatibility(&connection, path)?
    };
    let snapshot_revision =
        load_snapshot_from_connection(&connection, path, platform, legacy_compatibility)?
            .map(|snapshot| snapshot.revision);
    if version < SCHEMA_VERSION {
        return Ok(RecoveryClassification::MigrationRequired {
            from: version,
            to: SCHEMA_VERSION,
            snapshot_revision,
        });
    }
    let window_state_revision = inspect_all_window_states_from_connection(&connection, path)?;
    Ok(RecoveryClassification::Healthy {
        schema_version: version,
        snapshot_revision,
        window_state_revision,
    })
}

fn database_error(path: &Path, operation: &'static str, source: rusqlite::Error) -> StorageError {
    StorageError::Database {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn prepare_database_file(path: &Path) -> Result<(), StorageError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => return secure_database_file(path),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(StorageError::PrepareDatabaseFile {
                path: path.to_path_buf(),
                source,
            });
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map(|_| ())
        .map_err(|source| StorageError::PrepareDatabaseFile {
            path: path.to_path_buf(),
            source,
        })
}

fn prepare_parent_directory(path: &Path) -> Result<(), StorageError> {
    let mut ancestors: Vec<_> = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .collect();
    ancestors.reverse();
    for ancestor in ancestors {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => ensure_directory_metadata(ancestor, &metadata)?,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                if let Err(source) = builder.create(ancestor)
                    && source.kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(StorageError::CreateDirectory {
                        path: ancestor.to_path_buf(),
                        source,
                    });
                }
                let metadata = std::fs::symlink_metadata(ancestor).map_err(|source| {
                    StorageError::CreateDirectory {
                        path: ancestor.to_path_buf(),
                        source,
                    }
                })?;
                ensure_directory_metadata(ancestor, &metadata)?;
            }
            Err(source) => {
                return Err(StorageError::CreateDirectory {
                    path: ancestor.to_path_buf(),
                    source,
                });
            }
        }
    }
    Ok(())
}

fn ensure_directory_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<(), StorageError> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: "expected a real directory, not a symlink or special file".to_owned(),
        });
    }
    Ok(())
}

fn ensure_regular_file_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<(), StorageError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: "expected a regular file, not a symlink or special file".to_owned(),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), StorageError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| StorageError::Permissions {
        path: path.to_path_buf(),
        message: source.to_string(),
    })?;
    ensure_directory_metadata(path, &metadata)?;
    secure_unix_mode(path, UnixPathKind::Directory, 0o700, 0o077)
}

#[cfg(not(unix))]
fn secure_directory(path: &Path) -> Result<(), StorageError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| StorageError::Permissions {
        path: path.to_path_buf(),
        message: source.to_string(),
    })?;
    ensure_directory_metadata(path, &metadata)
}

#[cfg(unix)]
fn secure_database_file(path: &Path) -> Result<(), StorageError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| StorageError::Permissions {
        path: path.to_path_buf(),
        message: source.to_string(),
    })?;
    ensure_regular_file_metadata(path, &metadata)?;
    secure_unix_mode(path, UnixPathKind::File, 0o600, 0o177)
}

#[cfg(not(unix))]
fn secure_database_file(path: &Path) -> Result<(), StorageError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| StorageError::Permissions {
        path: path.to_path_buf(),
        message: source.to_string(),
    })?;
    ensure_regular_file_metadata(path, &metadata)
}

fn secure_database_artifacts(path: &Path) -> Result<(), StorageError> {
    secure_database_file(path)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match std::fs::symlink_metadata(&sidecar) {
            Ok(_) => secure_database_file(&sidecar)?,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(StorageError::Permissions {
                    path: sidecar,
                    message: source.to_string(),
                });
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
#[derive(Clone, Copy)]
enum UnixPathKind {
    Directory,
    File,
}

#[cfg(unix)]
fn secure_unix_mode(
    path: &Path,
    kind: UnixPathKind,
    maximum_mode: u32,
    forbidden: u32,
) -> Result<(), StorageError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(path).map_err(|source| StorageError::Permissions {
        path: path.to_path_buf(),
        message: source.to_string(),
    })?;
    let expected_kind = match kind {
        UnixPathKind::Directory => metadata.is_dir(),
        UnixPathKind::File => metadata.is_file(),
    };
    if !expected_kind {
        let expected = match kind {
            UnixPathKind::Directory => "directory",
            UnixPathKind::File => "regular file",
        };
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: format!("expected a {expected}"),
        });
    }
    let current_uid = rustix::process::getuid().as_raw();
    if metadata.uid() != current_uid {
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: format!(
                "path is owned by uid {}, but the current uid is {current_uid}",
                metadata.uid()
            ),
        });
    }
    if matches!(kind, UnixPathKind::File) && metadata.nlink() != 1 {
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: format!(
                "regular file has {} hard links; expected exactly one",
                metadata.nlink()
            ),
        });
    }
    let current = metadata.permissions().mode() & 0o777;
    let secured = current & maximum_mode;
    if secured != current {
        let mut permissions = metadata.permissions();
        permissions.set_mode(secured);
        std::fs::set_permissions(path, permissions).map_err(|source| {
            StorageError::Permissions {
                path: path.to_path_buf(),
                message: source.to_string(),
            }
        })?;
    }
    let verified_metadata =
        std::fs::symlink_metadata(path).map_err(|source| StorageError::Permissions {
            path: path.to_path_buf(),
            message: source.to_string(),
        })?;
    let verified = verified_metadata.permissions().mode() & 0o777;
    let same_object = metadata.dev() == verified_metadata.dev()
        && metadata.ino() == verified_metadata.ino()
        && !verified_metadata.file_type().is_symlink();
    if !same_object {
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: "filesystem object changed while permissions were being secured".to_owned(),
        });
    }
    if verified & forbidden != 0 {
        return Err(StorageError::Permissions {
            path: path.to_path_buf(),
            message: format!("mode {verified:o} retains forbidden permission bits {forbidden:o}"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_wal_mode_has_a_typed_error() {
        let connection = Connection::open_in_memory().unwrap();
        assert!(matches!(
            enable_wal(&connection, Path::new("memory-only")),
            Err(StorageError::WalUnavailable { found, .. }) if found.eq_ignore_ascii_case("memory")
        ));
    }
}

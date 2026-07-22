//! Privacy-preserving durable browser-automation records.
//!
//! The service deliberately stores no selectors, typed text, URLs, query content, or screenshot
//! bytes. Durable rows contain only opaque identities, fencing epochs, operation kinds, byte
//! counts, and keyed digests. Consequently a non-terminal operation recovered after restart must
//! be terminalized instead of redispatched.

use std::path::Path;

use rusqlite::{OptionalExtension, Row, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::{
    MAX_SAFE_INTEGER, SqliteStateStore, StorageError, database_error, read_idempotency_epoch,
    secure_database_artifacts,
};

pub const AUTOMATION_TERMINAL_RECORD_CAP: usize = 4_096;
pub const AUTOMATION_TERMINAL_RETENTION_MS: i64 = 24 * 60 * 60 * 1_000;
const AUTOMATION_TERMINAL_RECORD_CAP_I64: i64 = 4_096;
const AUTOMATION_PROFILE_SESSION_CAP_I64: i64 = 16;
const AUTOMATION_PROVIDER_SESSION_CAP_I64: i64 = 8;
const AUTOMATION_SESSION_QUEUE_CAP_I64: i64 = 32;

pub(crate) const EXPECTED_BROWSER_AUTOMATION_SESSIONS_SCHEMA: &str =
    "CREATE TABLE browser_automation_sessions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    automation_session_id TEXT NOT NULL UNIQUE CHECK (length(automation_session_id) = 36),
    caller_id TEXT NOT NULL CHECK (length(caller_id) = 36),
    profile_key TEXT NOT NULL CHECK (length(profile_key) BETWEEN 1 AND 64),
    mode TEXT NOT NULL CHECK (mode IN ('ephemeral', 'attach')),
    state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'destroying', 'destroyed', 'failed', 'expired')),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    navigation_epoch INTEGER NOT NULL CHECK (navigation_epoch BETWEEN 1 AND 9007199254740991),
    workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) = 36),
    pane_id TEXT CHECK (pane_id IS NULL OR length(pane_id) = 36),
    tab_id TEXT CHECK (tab_id IS NULL OR length(tab_id) = 36),
    browser_session_id TEXT CHECK (browser_session_id IS NULL OR length(browser_session_id) = 36),
    browser_lifecycle_id TEXT CHECK (browser_lifecycle_id IS NULL OR length(browser_lifecycle_id) = 36),
    provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) = 36),
    provider_epoch INTEGER CHECK (provider_epoch IS NULL OR provider_epoch BETWEEN 1 AND 9007199254740991),
    provider_lease_id TEXT CHECK (provider_lease_id IS NULL OR length(provider_lease_id) = 36),
    window_id TEXT CHECK (window_id IS NULL OR length(window_id) = 36),
    window_generation INTEGER CHECK (window_generation IS NULL OR window_generation BETWEEN 1 AND 9007199254740991),
    lifecycle_operation_id TEXT NOT NULL CHECK (length(lifecycle_operation_id) = 36),
    lifecycle_correlation_id TEXT NOT NULL CHECK (length(lifecycle_correlation_id) = 36),
    lifecycle_attempt_epoch INTEGER NOT NULL CHECK (lifecycle_attempt_epoch BETWEEN 1 AND 9007199254740991),
    idempotency_epoch TEXT NOT NULL CHECK (length(idempotency_epoch) = 36),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
    UNIQUE(idempotency_epoch, idempotency_key),
    CHECK ((workspace_id IS NULL AND pane_id IS NULL AND tab_id IS NULL AND browser_session_id IS NULL AND browser_lifecycle_id IS NULL) OR (workspace_id IS NOT NULL AND pane_id IS NOT NULL AND tab_id IS NOT NULL AND browser_session_id IS NOT NULL AND browser_lifecycle_id IS NOT NULL)),
    CHECK ((provider_id IS NULL AND provider_epoch IS NULL AND provider_lease_id IS NULL AND window_id IS NULL AND window_generation IS NULL) OR (provider_id IS NOT NULL AND provider_epoch IS NOT NULL AND provider_lease_id IS NOT NULL AND window_id IS NOT NULL AND window_generation IS NOT NULL)),
    CHECK ((state IN ('creating', 'ready', 'destroying') AND terminal_at_ms IS NULL) OR (state IN ('destroyed', 'failed', 'expired') AND terminal_at_ms IS NOT NULL))
)";

pub(crate) const EXPECTED_BROWSER_AUTOMATION_OPERATIONS_SCHEMA: &str =
    "CREATE TABLE browser_automation_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE CHECK (length(operation_id) = 36),
    automation_session_id TEXT NOT NULL CHECK (length(automation_session_id) = 36),
    caller_id TEXT NOT NULL CHECK (length(caller_id) = 36),
    session_generation INTEGER NOT NULL CHECK (session_generation BETWEEN 1 AND 9007199254740991),
    navigation_epoch INTEGER NOT NULL CHECK (navigation_epoch BETWEEN 1 AND 9007199254740991),
    attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch BETWEEN 1 AND 9007199254740991),
    correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
    idempotency_epoch TEXT NOT NULL CHECK (length(idempotency_epoch) = 36),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('navigate', 'wait', 'query', 'focus', 'click', 'typeText', 'key', 'keyAt', 'screenshot')),
    input_bytes INTEGER NOT NULL CHECK (input_bytes BETWEEN 0 AND 65536),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'expired', 'interrupted', 'resultExpired')),
    provider_id TEXT NOT NULL CHECK (length(provider_id) = 36),
    provider_epoch INTEGER NOT NULL CHECK (provider_epoch BETWEEN 1 AND 9007199254740991),
    provider_lease_id TEXT NOT NULL CHECK (length(provider_lease_id) = 36),
    window_id TEXT NOT NULL CHECK (length(window_id) = 36),
    window_generation INTEGER NOT NULL CHECK (window_generation BETWEEN 1 AND 9007199254740991),
    result_kind TEXT CHECK (result_kind IS NULL OR result_kind IN ('empty', 'navigation', 'query', 'screenshot')),
    result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
    result_bytes INTEGER CHECK (result_bytes IS NULL OR result_bytes BETWEEN 0 AND 16777216),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
    accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= accepted_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= accepted_at_ms),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= accepted_at_ms),
    UNIQUE(idempotency_epoch, idempotency_key),
    FOREIGN KEY(automation_session_id) REFERENCES browser_automation_sessions(automation_session_id),
    CHECK ((state IN ('queued', 'running') AND terminal_at_ms IS NULL AND error_code IS NULL AND result_kind IS NULL AND result_digest IS NULL AND result_bytes IS NULL) OR (state = 'succeeded' AND terminal_at_ms IS NOT NULL AND error_code IS NULL AND result_kind IS NOT NULL AND result_digest IS NOT NULL AND result_bytes IS NOT NULL) OR (state IN ('failed', 'canceled', 'expired', 'interrupted', 'resultExpired') AND terminal_at_ms IS NOT NULL AND error_code IS NOT NULL AND result_kind IS NULL AND result_digest IS NULL AND result_bytes IS NULL))
)";

pub(crate) const EXPECTED_BROWSER_AUTOMATION_TOMBSTONES_SCHEMA: &str =
    "CREATE TABLE browser_automation_tombstones (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL CHECK (namespace IN ('sessionCreate', 'operation')),
    idempotency_epoch TEXT NOT NULL CHECK (length(idempotency_epoch) = 36),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    terminal_code TEXT NOT NULL CHECK (length(terminal_code) BETWEEN 1 AND 64),
    completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
    UNIQUE(namespace, idempotency_epoch, idempotency_key)
)";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserAutomationSessionModeRecord {
    Ephemeral,
    Attach,
}

impl BrowserAutomationSessionModeRecord {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ephemeral => "ephemeral",
            Self::Attach => "attach",
        }
    }

    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "ephemeral" => Ok(Self::Ephemeral),
            "attach" => Ok(Self::Attach),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserAutomationSessionStateRecord {
    Creating,
    Ready,
    Destroying,
    Destroyed,
    Failed,
    Expired,
}

impl BrowserAutomationSessionStateRecord {
    fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Ready => "ready",
            Self::Destroying => "destroying",
            Self::Destroyed => "destroyed",
            Self::Failed => "failed",
            Self::Expired => "expired",
        }
    }
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "creating" => Ok(Self::Creating),
            "ready" => Ok(Self::Ready),
            "destroying" => Ok(Self::Destroying),
            "destroyed" => Ok(Self::Destroyed),
            "failed" => Ok(Self::Failed),
            "expired" => Ok(Self::Expired),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Destroyed | Self::Failed | Self::Expired)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserAutomationOperationStateRecord {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
    Expired,
    Interrupted,
    ResultExpired,
}

impl BrowserAutomationOperationStateRecord {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Expired => "expired",
            Self::Interrupted => "interrupted",
            Self::ResultExpired => "resultExpired",
        }
    }
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            "expired" => Ok(Self::Expired),
            "interrupted" => Ok(Self::Interrupted),
            "resultExpired" => Ok(Self::ResultExpired),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationProviderFence {
    pub provider_id: Uuid,
    pub provider_epoch: u64,
    pub provider_lease_id: Uuid,
    pub window_id: Uuid,
    pub window_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationTargetRecord {
    pub workspace_id: Uuid,
    pub pane_id: Uuid,
    pub tab_id: Uuid,
    pub browser_session_id: Uuid,
    pub browser_lifecycle_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationSessionCreateRecord {
    pub automation_session_id: Uuid,
    pub caller_id: Uuid,
    pub profile_key: String,
    pub mode: BrowserAutomationSessionModeRecord,
    pub generation: u64,
    pub navigation_epoch: u64,
    pub target: Option<BrowserAutomationTargetRecord>,
    pub provider: BrowserAutomationProviderFence,
    pub lifecycle_operation_id: Uuid,
    pub lifecycle_correlation_id: Uuid,
    pub lifecycle_attempt_epoch: u64,
    pub idempotency_epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_digest: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationSessionRecord {
    pub automation_session_id: Uuid,
    pub caller_id: Uuid,
    pub profile_key: String,
    pub mode: BrowserAutomationSessionModeRecord,
    pub state: BrowserAutomationSessionStateRecord,
    pub generation: u64,
    pub navigation_epoch: u64,
    pub target: Option<BrowserAutomationTargetRecord>,
    pub provider: Option<BrowserAutomationProviderFence>,
    pub lifecycle_operation_id: Uuid,
    pub lifecycle_correlation_id: Uuid,
    pub lifecycle_attempt_epoch: u64,
    pub idempotency_epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_digest: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub expires_at_ms: i64,
    pub terminal_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserAutomationCreateOutcome<T> {
    Created(T),
    Pending(T),
    Replay(T),
    ResultExpired { terminal_code: String },
    Conflict,
    EpochExpired,
    ResourceLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationOperationCreateRecord {
    pub operation_id: Uuid,
    pub automation_session_id: Uuid,
    pub caller_id: Uuid,
    pub session_generation: u64,
    pub navigation_epoch: u64,
    pub attempt_epoch: u64,
    pub correlation_id: Uuid,
    pub idempotency_epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_digest: String,
    pub operation_kind: String,
    pub input_bytes: u32,
    pub provider: BrowserAutomationProviderFence,
    pub accepted_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationOperationRecord {
    pub operation_id: Uuid,
    pub automation_session_id: Uuid,
    pub caller_id: Uuid,
    pub session_generation: u64,
    pub navigation_epoch: u64,
    pub attempt_epoch: u64,
    pub correlation_id: Uuid,
    pub idempotency_epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_digest: String,
    pub operation_kind: String,
    pub input_bytes: u32,
    pub state: BrowserAutomationOperationStateRecord,
    pub provider: BrowserAutomationProviderFence,
    pub result_kind: Option<String>,
    pub result_digest: Option<String>,
    pub result_bytes: Option<u64>,
    pub error_code: Option<String>,
    pub accepted_at_ms: i64,
    pub updated_at_ms: i64,
    pub expires_at_ms: i64,
    pub terminal_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserAutomationLifecycleOutcome<T> {
    Applied(T),
    Replay(T),
    Terminal(T),
    Mismatch,
    InvalidState,
    NotFound,
    ResourceLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserAutomationTerminalUpdate {
    pub operation_id: Uuid,
    pub automation_session_id: Uuid,
    pub session_generation: u64,
    pub navigation_epoch: u64,
    pub attempt_epoch: u64,
    pub correlation_id: Uuid,
    pub provider: BrowserAutomationProviderFence,
    pub state: BrowserAutomationOperationStateRecord,
    pub result_kind: Option<String>,
    pub result_digest: Option<String>,
    pub result_bytes: Option<u64>,
    pub error_code: Option<String>,
    pub completed_at_ms: i64,
}

pub(crate) fn migrate_to_v8(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(&format!(
        "{EXPECTED_BROWSER_AUTOMATION_SESSIONS_SCHEMA};{EXPECTED_BROWSER_AUTOMATION_OPERATIONS_SCHEMA};{EXPECTED_BROWSER_AUTOMATION_TOMBSTONES_SCHEMA};UPDATE migration_metadata SET target_version = 8 WHERE singleton = 1;PRAGMA user_version = 8;",
    ))
}

impl SqliteStateStore {
    pub fn create_browser_automation_session(
        &self,
        request: &BrowserAutomationSessionCreateRecord,
    ) -> Result<BrowserAutomationCreateOutcome<BrowserAutomationSessionRecord>, StorageError> {
        validate_session_create(request)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation session create")?;
        if read_idempotency_epoch(&transaction, &self.path)? != request.idempotency_epoch {
            return Ok(BrowserAutomationCreateOutcome::EpochExpired);
        }
        if let Some(record) = load_session_by_key(
            &transaction,
            request.idempotency_epoch,
            request.idempotency_key,
        )? {
            return Ok(if record.request_digest != request.request_digest {
                BrowserAutomationCreateOutcome::Conflict
            } else if record.state.is_terminal() {
                BrowserAutomationCreateOutcome::Replay(record)
            } else {
                BrowserAutomationCreateOutcome::Pending(record)
            });
        }
        if let Some((digest, terminal_code)) = load_tombstone(
            &transaction,
            "sessionCreate",
            request.idempotency_epoch,
            request.idempotency_key,
        )? {
            return Ok(if digest == request.request_digest {
                BrowserAutomationCreateOutcome::ResultExpired { terminal_code }
            } else {
                BrowserAutomationCreateOutcome::Conflict
            });
        }
        if load_session(&transaction, request.automation_session_id)?.is_some() {
            return Ok(BrowserAutomationCreateOutcome::Conflict);
        }
        let profile_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM browser_automation_sessions WHERE profile_key = ?1 AND state IN ('creating', 'ready', 'destroying')",
            [&request.profile_key], |row| row.get(0),
        ).map_err(|source| database_error(&self.path, "automation profile session count", source))?;
        let provider_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM browser_automation_sessions WHERE provider_id = ?1 AND state IN ('creating', 'ready', 'destroying')",
            [request.provider.provider_id.to_string()], |row| row.get(0),
        ).map_err(|source| database_error(&self.path, "automation provider session count", source))?;
        if profile_count >= AUTOMATION_PROFILE_SESSION_CAP_I64
            || provider_count >= AUTOMATION_PROVIDER_SESSION_CAP_I64
        {
            return Ok(BrowserAutomationCreateOutcome::ResourceLimit);
        }
        let target = request.target.as_ref();
        transaction.execute(
            "INSERT INTO browser_automation_sessions (automation_session_id, caller_id, profile_key, mode, state, generation, navigation_epoch, workspace_id, pane_id, tab_id, browser_session_id, browser_lifecycle_id, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, lifecycle_operation_id, lifecycle_correlation_id, lifecycle_attempt_epoch, idempotency_epoch, idempotency_key, request_digest, created_at_ms, updated_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4, 'creating', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23, ?24)",
            params![
                request.automation_session_id.to_string(), request.caller_id.to_string(), request.profile_key,
                request.mode.as_str(), i64_from_u64(request.generation)?, i64_from_u64(request.navigation_epoch)?,
                target.map(|v| v.workspace_id.to_string()), target.map(|v| v.pane_id.to_string()),
                target.map(|v| v.tab_id.to_string()), target.map(|v| v.browser_session_id.to_string()),
                target.map(|v| v.browser_lifecycle_id.to_string()), request.provider.provider_id.to_string(),
                i64_from_u64(request.provider.provider_epoch)?, request.provider.provider_lease_id.to_string(),
                request.provider.window_id.to_string(), i64_from_u64(request.provider.window_generation)?,
                request.lifecycle_operation_id.to_string(), request.lifecycle_correlation_id.to_string(),
                i64_from_u64(request.lifecycle_attempt_epoch)?, request.idempotency_epoch.to_string(),
                request.idempotency_key.to_string(), request.request_digest, request.created_at_ms, request.expires_at_ms,
            ],
        ).map_err(|source| database_error(&self.path, "automation session insert", source))?;
        let record = load_session(&transaction, request.automation_session_id)?
            .ok_or_else(|| invalid("inserted automation session is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation session create commit", source)
        })?;
        Ok(BrowserAutomationCreateOutcome::Created(record))
    }

    pub fn browser_automation_session(
        &self,
        id: Uuid,
    ) -> Result<Option<BrowserAutomationSessionRecord>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_session(&connection, id)
    }

    pub fn list_browser_automation_sessions(
        &self,
        caller_id: Uuid,
        limit: usize,
    ) -> Result<Vec<BrowserAutomationSessionRecord>, StorageError> {
        if limit == 0 || limit > 16 {
            return Err(invalid("automation session list limit must be 1..=16"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!("SELECT {SESSION_COLUMNS} FROM browser_automation_sessions WHERE caller_id = ?1 AND state IN ('creating', 'ready', 'destroying') ORDER BY sequence LIMIT ?2"))
            .map_err(|source| database_error(&self.path, "automation session list prepare", source))?;
        let rows = statement
            .query_map(
                params![caller_id.to_string(), i64::try_from(limit).unwrap_or(16)],
                row_to_session,
            )
            .map_err(|source| database_error(&self.path, "automation session list", source))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|source| database_error(&self.path, "automation session list row", source))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_browser_automation_session_ready(
        &self,
        id: Uuid,
        lifecycle_operation_id: Uuid,
        correlation_id: Uuid,
        attempt_epoch: u64,
        provider: &BrowserAutomationProviderFence,
        target: &BrowserAutomationTargetRecord,
        navigation_epoch: u64,
        at_ms: i64,
    ) -> Result<BrowserAutomationLifecycleOutcome<BrowserAutomationSessionRecord>, StorageError>
    {
        validate_provider(provider)?;
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation session ready")?;
        let Some(record) = load_session(&transaction, id)? else {
            return Ok(BrowserAutomationLifecycleOutcome::NotFound);
        };
        if !session_lifecycle_matches(
            &record,
            lifecycle_operation_id,
            correlation_id,
            attempt_epoch,
            provider,
        ) {
            return Ok(BrowserAutomationLifecycleOutcome::Mismatch);
        }
        if record.state == BrowserAutomationSessionStateRecord::Ready {
            return Ok(BrowserAutomationLifecycleOutcome::Replay(record));
        }
        if record.state.is_terminal() {
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(record));
        }
        if record.state != BrowserAutomationSessionStateRecord::Creating {
            return Ok(BrowserAutomationLifecycleOutcome::InvalidState);
        }
        if let Some(existing) = &record.target
            && existing != target
        {
            return Ok(BrowserAutomationLifecycleOutcome::Mismatch);
        }
        transaction.execute(
            "UPDATE browser_automation_sessions SET state = 'ready', workspace_id = ?1, pane_id = ?2, tab_id = ?3, browser_session_id = ?4, browser_lifecycle_id = ?5, navigation_epoch = ?6, updated_at_ms = ?7 WHERE automation_session_id = ?8 AND state = 'creating'",
            params![target.workspace_id.to_string(), target.pane_id.to_string(), target.tab_id.to_string(), target.browser_session_id.to_string(), target.browser_lifecycle_id.to_string(), i64_from_u64(navigation_epoch)?, at_ms, id.to_string()],
        ).map_err(|source| database_error(&self.path, "automation session ready update", source))?;
        let updated = load_session(&transaction, id)?
            .ok_or_else(|| invalid("updated automation session is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation session ready commit", source)
        })?;
        Ok(BrowserAutomationLifecycleOutcome::Applied(updated))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn begin_browser_automation_session_destroy(
        &self,
        id: Uuid,
        caller_id: Uuid,
        generation: u64,
        operation_id: Uuid,
        correlation_id: Uuid,
        attempt_epoch: u64,
        at_ms: i64,
    ) -> Result<BrowserAutomationLifecycleOutcome<BrowserAutomationSessionRecord>, StorageError>
    {
        let mut connection = self.lock()?;
        let transaction = automation_transaction(
            &mut connection,
            &self.path,
            "automation session destroy begin",
        )?;
        let Some(record) = load_session(&transaction, id)? else {
            return Ok(BrowserAutomationLifecycleOutcome::NotFound);
        };
        if record.caller_id != caller_id || record.generation != generation {
            return Ok(BrowserAutomationLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(record));
        }
        if record.state == BrowserAutomationSessionStateRecord::Destroying {
            return Ok(
                if record.lifecycle_operation_id == operation_id
                    && record.lifecycle_correlation_id == correlation_id
                    && record.lifecycle_attempt_epoch == attempt_epoch
                {
                    BrowserAutomationLifecycleOutcome::Replay(record)
                } else {
                    BrowserAutomationLifecycleOutcome::Mismatch
                },
            );
        }
        if record.state != BrowserAutomationSessionStateRecord::Ready {
            return Ok(BrowserAutomationLifecycleOutcome::InvalidState);
        }
        transaction.execute(
            "UPDATE browser_automation_sessions SET state = 'destroying', lifecycle_operation_id = ?1, lifecycle_correlation_id = ?2, lifecycle_attempt_epoch = ?3, updated_at_ms = ?4 WHERE automation_session_id = ?5 AND state = 'ready'",
            params![operation_id.to_string(), correlation_id.to_string(), i64_from_u64(attempt_epoch)?, at_ms, id.to_string()],
        ).map_err(|source| database_error(&self.path, "automation session destroy update", source))?;
        terminalize_session_operations(&transaction, id, "canceled", at_ms)?;
        let updated = load_session(&transaction, id)?
            .ok_or_else(|| invalid("destroying automation session is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation session destroy commit", source)
        })?;
        Ok(BrowserAutomationLifecycleOutcome::Applied(updated))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn terminalize_browser_automation_session(
        &self,
        id: Uuid,
        lifecycle_operation_id: Uuid,
        correlation_id: Uuid,
        attempt_epoch: u64,
        provider: &BrowserAutomationProviderFence,
        state: BrowserAutomationSessionStateRecord,
        operation_error: &str,
        at_ms: i64,
    ) -> Result<BrowserAutomationLifecycleOutcome<BrowserAutomationSessionRecord>, StorageError>
    {
        if !state.is_terminal() {
            return Err(invalid("automation session terminal state required"));
        }
        validate_provider(provider)?;
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation session terminal")?;
        let Some(record) = load_session(&transaction, id)? else {
            return Ok(BrowserAutomationLifecycleOutcome::NotFound);
        };
        if !session_lifecycle_matches(
            &record,
            lifecycle_operation_id,
            correlation_id,
            attempt_epoch,
            provider,
        ) {
            return Ok(BrowserAutomationLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(record));
        }
        transaction.execute(
            "UPDATE browser_automation_sessions SET state = ?1, updated_at_ms = ?2, terminal_at_ms = ?2 WHERE automation_session_id = ?3 AND terminal_at_ms IS NULL",
            params![state.as_str(), at_ms, id.to_string()],
        ).map_err(|source| database_error(&self.path, "automation session terminal update", source))?;
        terminalize_session_operations(&transaction, id, operation_error, at_ms)?;
        let updated = load_session(&transaction, id)?
            .ok_or_else(|| invalid("terminal automation session is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation session terminal commit", source)
        })?;
        Ok(BrowserAutomationLifecycleOutcome::Applied(updated))
    }

    pub fn create_browser_automation_operation(
        &self,
        request: &BrowserAutomationOperationCreateRecord,
    ) -> Result<BrowserAutomationCreateOutcome<BrowserAutomationOperationRecord>, StorageError>
    {
        validate_operation_create(request)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation operation create")?;
        if read_idempotency_epoch(&transaction, &self.path)? != request.idempotency_epoch {
            return Ok(BrowserAutomationCreateOutcome::EpochExpired);
        }
        if let Some(record) = load_operation_by_key(
            &transaction,
            request.idempotency_epoch,
            request.idempotency_key,
        )? {
            return Ok(if record.request_digest != request.request_digest {
                BrowserAutomationCreateOutcome::Conflict
            } else if record.state.is_terminal() {
                BrowserAutomationCreateOutcome::Replay(record)
            } else {
                BrowserAutomationCreateOutcome::Pending(record)
            });
        }
        if let Some((digest, terminal_code)) = load_tombstone(
            &transaction,
            "operation",
            request.idempotency_epoch,
            request.idempotency_key,
        )? {
            return Ok(if digest == request.request_digest {
                BrowserAutomationCreateOutcome::ResultExpired { terminal_code }
            } else {
                BrowserAutomationCreateOutcome::Conflict
            });
        }
        if load_operation(&transaction, request.operation_id)?.is_some() {
            return Ok(BrowserAutomationCreateOutcome::Conflict);
        }
        let Some(session) = load_session(&transaction, request.automation_session_id)? else {
            return Ok(BrowserAutomationCreateOutcome::ResourceLimit);
        };
        if session.state != BrowserAutomationSessionStateRecord::Ready
            || session.caller_id != request.caller_id
            || session.generation != request.session_generation
            || session.navigation_epoch != request.navigation_epoch
            || session.provider.as_ref() != Some(&request.provider)
        {
            return Ok(BrowserAutomationCreateOutcome::Conflict);
        }
        let pending_count: i64 = transaction.query_row("SELECT COUNT(*) FROM browser_automation_operations WHERE automation_session_id = ?1 AND state IN ('queued', 'running')", [request.automation_session_id.to_string()], |row| row.get(0))
            .map_err(|source| database_error(&self.path, "automation session queue count", source))?;
        if pending_count >= AUTOMATION_SESSION_QUEUE_CAP_I64 {
            return Ok(BrowserAutomationCreateOutcome::ResourceLimit);
        }
        transaction.execute(
            "INSERT INTO browser_automation_operations (operation_id, automation_session_id, caller_id, session_generation, navigation_epoch, attempt_epoch, correlation_id, idempotency_epoch, idempotency_key, request_digest, operation_kind, input_bytes, state, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, accepted_at_ms, updated_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'queued', ?13, ?14, ?15, ?16, ?17, ?18, ?18, ?19)",
            params![request.operation_id.to_string(), request.automation_session_id.to_string(), request.caller_id.to_string(), i64_from_u64(request.session_generation)?, i64_from_u64(request.navigation_epoch)?, i64_from_u64(request.attempt_epoch)?, request.correlation_id.to_string(), request.idempotency_epoch.to_string(), request.idempotency_key.to_string(), request.request_digest, request.operation_kind, i64::from(request.input_bytes), request.provider.provider_id.to_string(), i64_from_u64(request.provider.provider_epoch)?, request.provider.provider_lease_id.to_string(), request.provider.window_id.to_string(), i64_from_u64(request.provider.window_generation)?, request.accepted_at_ms, request.expires_at_ms],
        ).map_err(|source| database_error(&self.path, "automation operation insert", source))?;
        transaction.execute("UPDATE browser_automation_sessions SET updated_at_ms = ?1, expires_at_ms = MAX(expires_at_ms, ?2) WHERE automation_session_id = ?3", params![request.accepted_at_ms, request.accepted_at_ms.saturating_add(30 * 60 * 1_000), request.automation_session_id.to_string()])
            .map_err(|source| database_error(&self.path, "automation session activity update", source))?;
        let record = load_operation(&transaction, request.operation_id)?
            .ok_or_else(|| invalid("inserted automation operation is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation operation create commit", source)
        })?;
        Ok(BrowserAutomationCreateOutcome::Created(record))
    }

    pub fn browser_automation_operation(
        &self,
        id: Uuid,
    ) -> Result<Option<BrowserAutomationOperationRecord>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_operation(&connection, id)
    }

    pub fn mark_browser_automation_operation_running(
        &self,
        operation_id: Uuid,
        correlation_id: Uuid,
        attempt_epoch: u64,
        provider: &BrowserAutomationProviderFence,
        at_ms: i64,
    ) -> Result<BrowserAutomationLifecycleOutcome<BrowserAutomationOperationRecord>, StorageError>
    {
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation operation running")?;
        let Some(record) = load_operation(&transaction, operation_id)? else {
            return Ok(BrowserAutomationLifecycleOutcome::NotFound);
        };
        if !operation_matches(&record, correlation_id, attempt_epoch, provider) {
            return Ok(BrowserAutomationLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(record));
        }
        if record.state == BrowserAutomationOperationStateRecord::Running {
            return Ok(BrowserAutomationLifecycleOutcome::Replay(record));
        }
        if record.state != BrowserAutomationOperationStateRecord::Queued {
            return Ok(BrowserAutomationLifecycleOutcome::InvalidState);
        }
        let current_session = load_session(&transaction, record.automation_session_id)?;
        let is_stale = current_session.as_ref().is_none_or(|session| {
            session.state != BrowserAutomationSessionStateRecord::Ready
                || session.generation != record.session_generation
                || session.navigation_epoch != record.navigation_epoch
                || session.provider.as_ref() != Some(&record.provider)
        });
        if is_stale || at_ms >= record.expires_at_ms {
            let (terminal_state, error_code) = if at_ms >= record.expires_at_ms {
                (BrowserAutomationOperationStateRecord::Expired, "timeout")
            } else {
                (
                    BrowserAutomationOperationStateRecord::Interrupted,
                    "stale_navigation",
                )
            };
            transaction
                .execute(
                    "UPDATE browser_automation_operations SET state = ?1, error_code = ?2, updated_at_ms = ?3, terminal_at_ms = ?3 WHERE operation_id = ?4 AND state = 'queued'",
                    params![terminal_state.as_str(), error_code, at_ms, operation_id.to_string()],
                )
                .map_err(|source| {
                    database_error(&self.path, "stale automation operation terminal", source)
                })?;
            let terminal = load_operation(&transaction, operation_id)?
                .ok_or_else(|| invalid("stale terminal operation is missing"))?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale automation operation commit", source)
            })?;
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(terminal));
        }
        let running: i64 = transaction.query_row("SELECT COUNT(*) FROM browser_automation_operations WHERE automation_session_id = ?1 AND state = 'running'", [record.automation_session_id.to_string()], |row| row.get(0))
            .map_err(|source| database_error(&self.path, "automation running count", source))?;
        if running != 0 {
            return Ok(BrowserAutomationLifecycleOutcome::ResourceLimit);
        }
        transaction.execute("UPDATE browser_automation_operations SET state = 'running', updated_at_ms = ?1 WHERE operation_id = ?2 AND state = 'queued'", params![at_ms, operation_id.to_string()])
            .map_err(|source| database_error(&self.path, "automation operation running update", source))?;
        let updated = load_operation(&transaction, operation_id)?
            .ok_or_else(|| invalid("running automation operation is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation operation running commit", source)
        })?;
        Ok(BrowserAutomationLifecycleOutcome::Applied(updated))
    }

    pub fn terminalize_browser_automation_operation(
        &self,
        update: &BrowserAutomationTerminalUpdate,
    ) -> Result<BrowserAutomationLifecycleOutcome<BrowserAutomationOperationRecord>, StorageError>
    {
        validate_terminal_update(update)?;
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation operation terminal")?;
        let Some(record) = load_operation(&transaction, update.operation_id)? else {
            return Ok(BrowserAutomationLifecycleOutcome::NotFound);
        };
        if record.automation_session_id != update.automation_session_id
            || record.session_generation != update.session_generation
            || record.navigation_epoch != update.navigation_epoch
            || !operation_matches(
                &record,
                update.correlation_id,
                update.attempt_epoch,
                &update.provider,
            )
        {
            return Ok(BrowserAutomationLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(record));
        }
        transaction.execute(
            "UPDATE browser_automation_operations SET state = ?1, result_kind = ?2, result_digest = ?3, result_bytes = ?4, error_code = ?5, updated_at_ms = ?6, terminal_at_ms = ?6 WHERE operation_id = ?7 AND terminal_at_ms IS NULL",
            params![update.state.as_str(), update.result_kind, update.result_digest, update.result_bytes.map(i64_from_u64).transpose()?, update.error_code, update.completed_at_ms, update.operation_id.to_string()],
        ).map_err(|source| database_error(&self.path, "automation operation terminal update", source))?;
        if update.state == BrowserAutomationOperationStateRecord::Succeeded
            && update.result_kind.as_deref() == Some("navigation")
        {
            transaction.execute("UPDATE browser_automation_sessions SET navigation_epoch = navigation_epoch + 1, updated_at_ms = ?1 WHERE automation_session_id = ?2 AND generation = ?3 AND navigation_epoch = ?4 AND state = 'ready'", params![update.completed_at_ms, update.automation_session_id.to_string(), i64_from_u64(update.session_generation)?, i64_from_u64(update.navigation_epoch)?])
                .map_err(|source| database_error(&self.path, "automation navigation epoch update", source))?;
        }
        let updated = load_operation(&transaction, update.operation_id)?
            .ok_or_else(|| invalid("terminal automation operation is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation operation terminal commit", source)
        })?;
        Ok(BrowserAutomationLifecycleOutcome::Applied(updated))
    }

    pub fn terminalize_browser_automation_operation_unchecked(
        &self,
        operation_id: Uuid,
        state: BrowserAutomationOperationStateRecord,
        error_code: &str,
        at_ms: i64,
    ) -> Result<BrowserAutomationLifecycleOutcome<BrowserAutomationOperationRecord>, StorageError>
    {
        if !state.is_terminal() || state == BrowserAutomationOperationStateRecord::Succeeded {
            return Err(invalid("non-success terminal state required"));
        }
        let mut connection = self.lock()?;
        let transaction =
            automation_transaction(&mut connection, &self.path, "automation forced terminal")?;
        let Some(record) = load_operation(&transaction, operation_id)? else {
            return Ok(BrowserAutomationLifecycleOutcome::NotFound);
        };
        if record.state.is_terminal() {
            return Ok(BrowserAutomationLifecycleOutcome::Terminal(record));
        }
        transaction.execute("UPDATE browser_automation_operations SET state = ?1, error_code = ?2, updated_at_ms = ?3, terminal_at_ms = ?3 WHERE operation_id = ?4 AND terminal_at_ms IS NULL", params![state.as_str(), error_code, at_ms, operation_id.to_string()])
            .map_err(|source| database_error(&self.path, "automation forced terminal update", source))?;
        let updated = load_operation(&transaction, operation_id)?
            .ok_or_else(|| invalid("forced terminal operation is missing"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "automation forced terminal commit", source)
        })?;
        Ok(BrowserAutomationLifecycleOutcome::Applied(updated))
    }

    pub fn recover_browser_automation_operations(
        &self,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<BrowserAutomationOperationRecord>, StorageError> {
        if limit == 0 || limit > 4_096 {
            return Err(invalid("automation recovery limit must be 1..=4096"));
        }
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!("SELECT {OPERATION_COLUMNS} FROM browser_automation_operations WHERE terminal_at_ms IS NULL OR expires_at_ms <= ?1 ORDER BY sequence LIMIT ?2"))
            .map_err(|source| database_error(&self.path, "automation recovery prepare", source))?;
        let rows = statement
            .query_map(
                params![now_ms, i64::try_from(limit).unwrap_or(4_096)],
                row_to_operation,
            )
            .map_err(|source| database_error(&self.path, "automation recovery", source))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|source| database_error(&self.path, "automation recovery row", source))
    }

    pub fn recover_browser_automation_sessions(
        &self,
        limit: usize,
    ) -> Result<Vec<BrowserAutomationSessionRecord>, StorageError> {
        if limit == 0 || limit > 4_096 {
            return Err(invalid(
                "automation session recovery limit must be 1..=4096",
            ));
        }
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS} FROM browser_automation_sessions WHERE terminal_at_ms IS NULL ORDER BY sequence LIMIT ?1"
            ))
            .map_err(|source| {
                database_error(&self.path, "automation session recovery prepare", source)
            })?;
        let rows = statement
            .query_map([i64::try_from(limit).unwrap_or(4_096)], row_to_session)
            .map_err(|source| database_error(&self.path, "automation session recovery", source))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|source| database_error(&self.path, "automation session recovery row", source))
    }

    pub fn prune_browser_automation_records(&self, now_ms: i64) -> Result<usize, StorageError> {
        let mut connection = self.lock()?;
        let transaction = automation_transaction(&mut connection, &self.path, "automation prune")?;
        let cutoff = now_ms.saturating_sub(AUTOMATION_TERMINAL_RETENTION_MS);
        transaction.execute(
            "INSERT OR IGNORE INTO browser_automation_tombstones (namespace, idempotency_epoch, idempotency_key, request_digest, terminal_code, completed_at_ms) SELECT 'operation', idempotency_epoch, idempotency_key, request_digest, COALESCE(error_code, state), terminal_at_ms FROM browser_automation_operations WHERE terminal_at_ms IS NOT NULL AND (terminal_at_ms <= ?1 OR sequence NOT IN (SELECT sequence FROM browser_automation_operations WHERE terminal_at_ms IS NOT NULL ORDER BY terminal_at_ms DESC, sequence DESC LIMIT ?2))",
            params![cutoff, AUTOMATION_TERMINAL_RECORD_CAP_I64],
        ).map_err(|source| database_error(&self.path, "automation operation tombstone insert", source))?;
        let deleted_operations = transaction.execute(
            "DELETE FROM browser_automation_operations WHERE terminal_at_ms IS NOT NULL AND (terminal_at_ms <= ?1 OR sequence NOT IN (SELECT sequence FROM browser_automation_operations WHERE terminal_at_ms IS NOT NULL ORDER BY terminal_at_ms DESC, sequence DESC LIMIT ?2))",
            params![cutoff, AUTOMATION_TERMINAL_RECORD_CAP_I64],
        ).map_err(|source| database_error(&self.path, "automation operation prune", source))?;
        transaction.execute(
            "INSERT OR IGNORE INTO browser_automation_tombstones (namespace, idempotency_epoch, idempotency_key, request_digest, terminal_code, completed_at_ms) SELECT 'sessionCreate', idempotency_epoch, idempotency_key, request_digest, state, terminal_at_ms FROM browser_automation_sessions WHERE terminal_at_ms IS NOT NULL AND terminal_at_ms <= ?1",
            [cutoff],
        ).map_err(|source| database_error(&self.path, "automation session tombstone insert", source))?;
        let deleted_sessions = transaction.execute("DELETE FROM browser_automation_sessions WHERE terminal_at_ms IS NOT NULL AND terminal_at_ms <= ?1", [cutoff])
            .map_err(|source| database_error(&self.path, "automation session prune", source))?;
        let tombstone_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM browser_automation_tombstones",
                [],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "automation tombstone count", source))?;
        let has_old_tombstone: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM browser_automation_tombstones WHERE completed_at_ms <= ?1)",
                [cutoff],
                |row| row.get(0),
            )
            .map_err(|source| {
                database_error(&self.path, "automation tombstone age check", source)
            })?;
        let rotate_epoch =
            has_old_tombstone || tombstone_count > AUTOMATION_TERMINAL_RECORD_CAP_I64;
        transaction.execute("DELETE FROM browser_automation_tombstones WHERE completed_at_ms <= ?1 OR sequence NOT IN (SELECT sequence FROM browser_automation_tombstones ORDER BY completed_at_ms DESC, sequence DESC LIMIT ?2)", params![cutoff, AUTOMATION_TERMINAL_RECORD_CAP_I64])
            .map_err(|source| database_error(&self.path, "automation tombstone prune", source))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "automation prune commit", source))?;
        drop(connection);
        if rotate_epoch {
            let _ = self.rotate_idempotency_epoch()?;
        }
        Ok(deleted_operations.saturating_add(deleted_sessions))
    }
}

const SESSION_COLUMNS: &str = "automation_session_id, caller_id, profile_key, mode, state, generation, navigation_epoch, workspace_id, pane_id, tab_id, browser_session_id, browser_lifecycle_id, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, lifecycle_operation_id, lifecycle_correlation_id, lifecycle_attempt_epoch, idempotency_epoch, idempotency_key, request_digest, created_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms";
const OPERATION_COLUMNS: &str = "operation_id, automation_session_id, caller_id, session_generation, navigation_epoch, attempt_epoch, correlation_id, idempotency_epoch, idempotency_key, request_digest, operation_kind, input_bytes, state, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, result_kind, result_digest, result_bytes, error_code, accepted_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms";

fn load_session(
    connection: &rusqlite::Connection,
    id: Uuid,
) -> Result<Option<BrowserAutomationSessionRecord>, StorageError> {
    connection.query_row(&format!("SELECT {SESSION_COLUMNS} FROM browser_automation_sessions WHERE automation_session_id = ?1"), [id.to_string()], row_to_session).optional().map_err(|source| database_error(Path::new("browser_automation_sessions"), "automation session lookup", source))
}
fn load_session_by_key(
    connection: &rusqlite::Connection,
    epoch: Uuid,
    key: Uuid,
) -> Result<Option<BrowserAutomationSessionRecord>, StorageError> {
    connection.query_row(&format!("SELECT {SESSION_COLUMNS} FROM browser_automation_sessions WHERE idempotency_epoch = ?1 AND idempotency_key = ?2"), params![epoch.to_string(), key.to_string()], row_to_session).optional().map_err(|source| database_error(Path::new("browser_automation_sessions"), "automation session idempotency lookup", source))
}
fn load_operation(
    connection: &rusqlite::Connection,
    id: Uuid,
) -> Result<Option<BrowserAutomationOperationRecord>, StorageError> {
    connection.query_row(&format!("SELECT {OPERATION_COLUMNS} FROM browser_automation_operations WHERE operation_id = ?1"), [id.to_string()], row_to_operation).optional().map_err(|source| database_error(Path::new("browser_automation_operations"), "automation operation lookup", source))
}
fn load_operation_by_key(
    connection: &rusqlite::Connection,
    epoch: Uuid,
    key: Uuid,
) -> Result<Option<BrowserAutomationOperationRecord>, StorageError> {
    connection.query_row(&format!("SELECT {OPERATION_COLUMNS} FROM browser_automation_operations WHERE idempotency_epoch = ?1 AND idempotency_key = ?2"), params![epoch.to_string(), key.to_string()], row_to_operation).optional().map_err(|source| database_error(Path::new("browser_automation_operations"), "automation operation idempotency lookup", source))
}
fn load_tombstone(
    connection: &rusqlite::Connection,
    namespace: &str,
    epoch: Uuid,
    key: Uuid,
) -> Result<Option<(String, String)>, StorageError> {
    connection.query_row("SELECT request_digest, terminal_code FROM browser_automation_tombstones WHERE namespace = ?1 AND idempotency_epoch = ?2 AND idempotency_key = ?3", params![namespace, epoch.to_string(), key.to_string()], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|source| database_error(Path::new("browser_automation_tombstones"), "automation tombstone lookup", source))
}

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<BrowserAutomationSessionRecord> {
    let target = optional_target(row, 7)?;
    let provider = optional_provider(row, 12)?;
    Ok(BrowserAutomationSessionRecord {
        automation_session_id: parse_uuid(row.get::<_, String>(0)?)?,
        caller_id: parse_uuid(row.get::<_, String>(1)?)?,
        profile_key: row.get(2)?,
        mode: BrowserAutomationSessionModeRecord::parse(&row.get::<_, String>(3)?)?,
        state: BrowserAutomationSessionStateRecord::parse(&row.get::<_, String>(4)?)?,
        generation: parse_u64(row.get(5)?)?,
        navigation_epoch: parse_u64(row.get(6)?)?,
        target,
        provider,
        lifecycle_operation_id: parse_uuid(row.get::<_, String>(17)?)?,
        lifecycle_correlation_id: parse_uuid(row.get::<_, String>(18)?)?,
        lifecycle_attempt_epoch: parse_u64(row.get(19)?)?,
        idempotency_epoch: parse_uuid(row.get::<_, String>(20)?)?,
        idempotency_key: parse_uuid(row.get::<_, String>(21)?)?,
        request_digest: row.get(22)?,
        created_at_ms: row.get(23)?,
        updated_at_ms: row.get(24)?,
        expires_at_ms: row.get(25)?,
        terminal_at_ms: row.get(26)?,
    })
}

fn row_to_operation(row: &Row<'_>) -> rusqlite::Result<BrowserAutomationOperationRecord> {
    Ok(BrowserAutomationOperationRecord {
        operation_id: parse_uuid(row.get::<_, String>(0)?)?,
        automation_session_id: parse_uuid(row.get::<_, String>(1)?)?,
        caller_id: parse_uuid(row.get::<_, String>(2)?)?,
        session_generation: parse_u64(row.get(3)?)?,
        navigation_epoch: parse_u64(row.get(4)?)?,
        attempt_epoch: parse_u64(row.get(5)?)?,
        correlation_id: parse_uuid(row.get::<_, String>(6)?)?,
        idempotency_epoch: parse_uuid(row.get::<_, String>(7)?)?,
        idempotency_key: parse_uuid(row.get::<_, String>(8)?)?,
        request_digest: row.get(9)?,
        operation_kind: row.get(10)?,
        input_bytes: u32::try_from(row.get::<_, i64>(11)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        state: BrowserAutomationOperationStateRecord::parse(&row.get::<_, String>(12)?)?,
        provider: BrowserAutomationProviderFence {
            provider_id: parse_uuid(row.get::<_, String>(13)?)?,
            provider_epoch: parse_u64(row.get(14)?)?,
            provider_lease_id: parse_uuid(row.get::<_, String>(15)?)?,
            window_id: parse_uuid(row.get::<_, String>(16)?)?,
            window_generation: parse_u64(row.get(17)?)?,
        },
        result_kind: row.get(18)?,
        result_digest: row.get(19)?,
        result_bytes: row.get::<_, Option<i64>>(20)?.map(parse_u64).transpose()?,
        error_code: row.get(21)?,
        accepted_at_ms: row.get(22)?,
        updated_at_ms: row.get(23)?,
        expires_at_ms: row.get(24)?,
        terminal_at_ms: row.get(25)?,
    })
}

fn optional_target(
    row: &Row<'_>,
    offset: usize,
) -> rusqlite::Result<Option<BrowserAutomationTargetRecord>> {
    let values = (
        row.get::<_, Option<String>>(offset)?,
        row.get::<_, Option<String>>(offset + 1)?,
        row.get::<_, Option<String>>(offset + 2)?,
        row.get::<_, Option<String>>(offset + 3)?,
        row.get::<_, Option<String>>(offset + 4)?,
    );
    match values {
        (None, None, None, None, None) => Ok(None),
        (
            Some(workspace_id),
            Some(pane_id),
            Some(tab_id),
            Some(browser_session_id),
            Some(browser_lifecycle_id),
        ) => Ok(Some(BrowserAutomationTargetRecord {
            workspace_id: parse_uuid(workspace_id)?,
            pane_id: parse_uuid(pane_id)?,
            tab_id: parse_uuid(tab_id)?,
            browser_session_id: parse_uuid(browser_session_id)?,
            browser_lifecycle_id: parse_uuid(browser_lifecycle_id)?,
        })),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn optional_provider(
    row: &Row<'_>,
    offset: usize,
) -> rusqlite::Result<Option<BrowserAutomationProviderFence>> {
    let values = (
        row.get::<_, Option<String>>(offset)?,
        row.get::<_, Option<i64>>(offset + 1)?,
        row.get::<_, Option<String>>(offset + 2)?,
        row.get::<_, Option<String>>(offset + 3)?,
        row.get::<_, Option<i64>>(offset + 4)?,
    );
    match values {
        (None, None, None, None, None) => Ok(None),
        (
            Some(provider_id),
            Some(provider_epoch),
            Some(provider_lease_id),
            Some(window_id),
            Some(window_generation),
        ) => Ok(Some(BrowserAutomationProviderFence {
            provider_id: parse_uuid(provider_id)?,
            provider_epoch: parse_u64(provider_epoch)?,
            provider_lease_id: parse_uuid(provider_lease_id)?,
            window_id: parse_uuid(window_id)?,
            window_generation: parse_u64(window_generation)?,
        })),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn session_lifecycle_matches(
    record: &BrowserAutomationSessionRecord,
    operation_id: Uuid,
    correlation_id: Uuid,
    attempt_epoch: u64,
    provider: &BrowserAutomationProviderFence,
) -> bool {
    record.lifecycle_operation_id == operation_id
        && record.lifecycle_correlation_id == correlation_id
        && record.lifecycle_attempt_epoch == attempt_epoch
        && record.provider.as_ref() == Some(provider)
}
fn operation_matches(
    record: &BrowserAutomationOperationRecord,
    correlation_id: Uuid,
    attempt_epoch: u64,
    provider: &BrowserAutomationProviderFence,
) -> bool {
    record.correlation_id == correlation_id
        && record.attempt_epoch == attempt_epoch
        && &record.provider == provider
}
fn terminalize_session_operations(
    transaction: &Transaction<'_>,
    id: Uuid,
    error_code: &str,
    at_ms: i64,
) -> Result<(), StorageError> {
    transaction.execute("UPDATE browser_automation_operations SET state = CASE WHEN ?1 = 'canceled' THEN 'canceled' ELSE 'interrupted' END, error_code = ?1, updated_at_ms = ?2, terminal_at_ms = ?2 WHERE automation_session_id = ?3 AND terminal_at_ms IS NULL", params![error_code, at_ms, id.to_string()])
        .map(|_| ()).map_err(|source| database_error(Path::new("browser_automation_operations"), "automation session operation terminalization", source))
}

fn validate_session_create(
    request: &BrowserAutomationSessionCreateRecord,
) -> Result<(), StorageError> {
    validate_profile_key(&request.profile_key)?;
    validate_provider(&request.provider)?;
    validate_digest(&request.request_digest)?;
    validate_epoch(request.generation, "generation")?;
    validate_epoch(request.navigation_epoch, "navigation_epoch")?;
    validate_epoch(request.lifecycle_attempt_epoch, "lifecycle_attempt_epoch")?;
    if (request.mode == BrowserAutomationSessionModeRecord::Attach) != request.target.is_some() {
        return Err(invalid(
            "attach requires a target and ephemeral forbids one",
        ));
    }
    validate_times(request.created_at_ms, request.expires_at_ms)
}
fn validate_operation_create(
    request: &BrowserAutomationOperationCreateRecord,
) -> Result<(), StorageError> {
    validate_digest(&request.request_digest)?;
    validate_provider(&request.provider)?;
    validate_epoch(request.session_generation, "session_generation")?;
    validate_epoch(request.navigation_epoch, "navigation_epoch")?;
    validate_epoch(request.attempt_epoch, "attempt_epoch")?;
    if !matches!(
        request.operation_kind.as_str(),
        "navigate"
            | "wait"
            | "query"
            | "focus"
            | "click"
            | "typeText"
            | "key"
            | "keyAt"
            | "screenshot"
    ) {
        return Err(invalid("invalid automation operation kind"));
    }
    if request.input_bytes > 65_536 {
        return Err(invalid("automation input byte count exceeds 64 KiB"));
    }
    validate_times(request.accepted_at_ms, request.expires_at_ms)
}
fn validate_terminal_update(update: &BrowserAutomationTerminalUpdate) -> Result<(), StorageError> {
    if !update.state.is_terminal() {
        return Err(invalid(
            "automation terminal update requires a terminal state",
        ));
    }
    validate_provider(&update.provider)?;
    validate_epoch(update.session_generation, "session_generation")?;
    validate_epoch(update.navigation_epoch, "navigation_epoch")?;
    validate_epoch(update.attempt_epoch, "attempt_epoch")?;
    match update.state {
        BrowserAutomationOperationStateRecord::Succeeded => {
            let kind = update
                .result_kind
                .as_deref()
                .ok_or_else(|| invalid("successful automation result kind is required"))?;
            if !matches!(kind, "empty" | "navigation" | "query" | "screenshot")
                || update
                    .result_digest
                    .as_deref()
                    .is_none_or(|v| validate_digest(v).is_err())
                || update.result_bytes.is_none()
                || update.error_code.is_some()
            {
                return Err(invalid("invalid successful automation result metadata"));
            }
        }
        _ => {
            if update.result_kind.is_some()
                || update.result_digest.is_some()
                || update.result_bytes.is_some()
                || update.error_code.as_deref().is_none_or(str::is_empty)
            {
                return Err(invalid("invalid failed automation result metadata"));
            }
        }
    }
    if update.completed_at_ms < 0 {
        return Err(invalid("completed_at_ms must be nonnegative"));
    }
    Ok(())
}
fn validate_provider(provider: &BrowserAutomationProviderFence) -> Result<(), StorageError> {
    validate_epoch(provider.provider_epoch, "provider_epoch")?;
    validate_epoch(provider.window_generation, "window_generation")
}
fn validate_epoch(value: u64, field: &str) -> Result<(), StorageError> {
    if value == 0 || value > MAX_SAFE_INTEGER {
        return Err(invalid(format!("{field} must be a positive safe integer")));
    }
    Ok(())
}
fn validate_profile_key(value: &str) -> Result<(), StorageError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(invalid("invalid automation profile key"));
    }
    Ok(())
}
fn validate_digest(value: &str) -> Result<(), StorageError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("automation digest must be lowercase SHA-256 hex"));
    }
    Ok(())
}
fn validate_times(created: i64, expires: i64) -> Result<(), StorageError> {
    if created < 0 || expires < created {
        return Err(invalid("invalid automation timestamps"));
    }
    Ok(())
}
fn i64_from_u64(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| invalid("automation integer exceeds SQLite range"))
}
fn parse_u64(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)
}
#[allow(clippy::needless_pass_by_value)]
fn parse_uuid(value: String) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|_| rusqlite::Error::InvalidQuery)
}
fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidActionInvocation {
        message: message.into(),
    }
}
fn automation_transaction<'a>(
    connection: &'a mut rusqlite::Connection,
    path: &Path,
    operation: &'static str,
) -> Result<Transaction<'a>, StorageError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| database_error(path, operation, source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ShortcutPlatform;
    use tempfile::tempdir;

    fn provider() -> BrowserAutomationProviderFence {
        BrowserAutomationProviderFence {
            provider_id: Uuid::new_v4(),
            provider_epoch: 1,
            provider_lease_id: Uuid::new_v4(),
            window_id: Uuid::new_v4(),
            window_generation: 1,
        }
    }
    fn session(
        epoch: Uuid,
        provider: BrowserAutomationProviderFence,
    ) -> BrowserAutomationSessionCreateRecord {
        BrowserAutomationSessionCreateRecord {
            automation_session_id: Uuid::new_v4(),
            caller_id: Uuid::new_v4(),
            profile_key: "private".into(),
            mode: BrowserAutomationSessionModeRecord::Ephemeral,
            generation: 1,
            navigation_epoch: 1,
            target: None,
            provider,
            lifecycle_operation_id: Uuid::new_v4(),
            lifecycle_correlation_id: Uuid::new_v4(),
            lifecycle_attempt_epoch: 1,
            idempotency_epoch: epoch,
            idempotency_key: Uuid::new_v4(),
            request_digest: "a".repeat(64),
            created_at_ms: 100,
            expires_at_ms: 1_800_100,
        }
    }

    #[test]
    fn v8_migration_is_backward_compatible_and_privacy_safe() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::SCHEMA_VERSION);
        let epoch = store.current_idempotency_epoch().unwrap();
        let create = session(epoch, provider());
        assert!(matches!(
            store.create_browser_automation_session(&create).unwrap(),
            BrowserAutomationCreateOutcome::Created(_)
        ));
        let connection = rusqlite::Connection::open(&path).unwrap();
        let all_text: String = connection.query_row("SELECT group_concat(COALESCE(profile_key, '') || COALESCE(request_digest, ''), '') FROM browser_automation_sessions", [], |row| row.get(0)).unwrap();
        assert!(!all_text.contains("https://private.example"));
        assert!(!all_text.contains("#password"));
        assert!(!all_text.contains("secret text"));
        let operation_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(browser_automation_operations)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for forbidden in [
            "selector",
            "text",
            "url",
            "query_result",
            "screenshot_bytes",
            "parameters",
        ] {
            assert!(
                !operation_columns.iter().any(|column| column == forbidden),
                "privacy-sensitive column must not exist: {forbidden}"
            );
        }
    }

    #[test]
    fn session_create_is_idempotent_and_conflicts_on_digest() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("state.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let create = session(store.current_idempotency_epoch().unwrap(), provider());
        assert!(matches!(
            store.create_browser_automation_session(&create).unwrap(),
            BrowserAutomationCreateOutcome::Created(_)
        ));
        assert!(matches!(
            store.create_browser_automation_session(&create).unwrap(),
            BrowserAutomationCreateOutcome::Pending(_)
        ));
        let mut changed = create.clone();
        changed.request_digest = "b".repeat(64);
        assert_eq!(
            store.create_browser_automation_session(&changed).unwrap(),
            BrowserAutomationCreateOutcome::Conflict
        );
    }

    fn ready_session(
        store: &SqliteStateStore,
    ) -> (
        BrowserAutomationSessionRecord,
        BrowserAutomationProviderFence,
    ) {
        let provider = provider();
        let create = session(store.current_idempotency_epoch().unwrap(), provider.clone());
        let created = match store.create_browser_automation_session(&create).unwrap() {
            BrowserAutomationCreateOutcome::Created(value) => value,
            other => panic!("unexpected create outcome: {other:?}"),
        };
        let target = BrowserAutomationTargetRecord {
            workspace_id: Uuid::new_v4(),
            pane_id: Uuid::new_v4(),
            tab_id: Uuid::new_v4(),
            browser_session_id: Uuid::new_v4(),
            browser_lifecycle_id: Uuid::new_v4(),
        };
        let ready = match store
            .mark_browser_automation_session_ready(
                created.automation_session_id,
                created.lifecycle_operation_id,
                created.lifecycle_correlation_id,
                created.lifecycle_attempt_epoch,
                &provider,
                &target,
                1,
                101,
            )
            .unwrap()
        {
            BrowserAutomationLifecycleOutcome::Applied(value) => value,
            other => panic!("unexpected ready outcome: {other:?}"),
        };
        (ready, provider)
    }

    fn operation(
        store: &SqliteStateStore,
        session: &BrowserAutomationSessionRecord,
        provider: BrowserAutomationProviderFence,
    ) -> BrowserAutomationOperationCreateRecord {
        BrowserAutomationOperationCreateRecord {
            operation_id: Uuid::new_v4(),
            automation_session_id: session.automation_session_id,
            caller_id: session.caller_id,
            session_generation: session.generation,
            navigation_epoch: session.navigation_epoch,
            attempt_epoch: provider.provider_epoch,
            correlation_id: Uuid::new_v4(),
            idempotency_epoch: store.current_idempotency_epoch().unwrap(),
            idempotency_key: Uuid::new_v4(),
            request_digest: "c".repeat(64),
            operation_kind: "click".into(),
            input_bytes: 42,
            provider,
            accepted_at_ms: 200,
            expires_at_ms: 30_200,
        }
    }

    #[test]
    fn operation_first_terminal_wins_and_restart_recovery_is_content_free() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        let (session, provider) = ready_session(&store);
        let create = operation(&store, &session, provider.clone());
        let record = match store.create_browser_automation_operation(&create).unwrap() {
            BrowserAutomationCreateOutcome::Created(value) => value,
            other => panic!("unexpected operation outcome: {other:?}"),
        };
        assert!(matches!(
            store
                .mark_browser_automation_operation_running(
                    record.operation_id,
                    record.correlation_id,
                    record.attempt_epoch,
                    &provider,
                    201,
                )
                .unwrap(),
            BrowserAutomationLifecycleOutcome::Applied(_)
        ));
        let terminal = BrowserAutomationTerminalUpdate {
            operation_id: record.operation_id,
            automation_session_id: record.automation_session_id,
            session_generation: record.session_generation,
            navigation_epoch: record.navigation_epoch,
            attempt_epoch: record.attempt_epoch,
            correlation_id: record.correlation_id,
            provider,
            state: BrowserAutomationOperationStateRecord::Succeeded,
            result_kind: Some("empty".into()),
            result_digest: Some("d".repeat(64)),
            result_bytes: Some(0),
            error_code: None,
            completed_at_ms: 202,
        };
        assert!(matches!(
            store
                .terminalize_browser_automation_operation(&terminal)
                .unwrap(),
            BrowserAutomationLifecycleOutcome::Applied(_)
        ));
        let mut late = terminal.clone();
        late.state = BrowserAutomationOperationStateRecord::Failed;
        late.result_kind = None;
        late.result_digest = None;
        late.result_bytes = None;
        late.error_code = Some("interrupted".into());
        assert!(matches!(
            store.terminalize_browser_automation_operation(&late).unwrap(),
            BrowserAutomationLifecycleOutcome::Terminal(value)
                if value.state == BrowserAutomationOperationStateRecord::Succeeded
        ));
        drop(store);
        let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        let durable = reopened
            .browser_automation_operation(record.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(durable.operation_kind, "click");
        assert_eq!(durable.input_bytes, 42);
        assert_eq!(
            durable.result_digest.as_deref(),
            Some("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd")
        );
    }

    #[test]
    fn one_running_operation_per_session_is_enforced() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("state.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let (session, provider) = ready_session(&store);
        let first = operation(&store, &session, provider.clone());
        let second = operation(&store, &session, provider.clone());
        for create in [&first, &second] {
            assert!(matches!(
                store.create_browser_automation_operation(create).unwrap(),
                BrowserAutomationCreateOutcome::Created(_)
            ));
        }
        assert!(matches!(
            store
                .mark_browser_automation_operation_running(
                    first.operation_id,
                    first.correlation_id,
                    first.attempt_epoch,
                    &provider,
                    201,
                )
                .unwrap(),
            BrowserAutomationLifecycleOutcome::Applied(_)
        ));
        assert_eq!(
            store
                .mark_browser_automation_operation_running(
                    second.operation_id,
                    second.correlation_id,
                    second.attempt_epoch,
                    &provider,
                    202,
                )
                .unwrap(),
            BrowserAutomationLifecycleOutcome::ResourceLimit
        );
    }
}

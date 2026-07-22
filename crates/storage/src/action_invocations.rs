use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::{
    MAX_SAFE_INTEGER, SqliteStateStore, StorageError, database_error, read_idempotency_epoch,
    secure_database_artifacts,
};

pub const ACTION_INVOCATION_GLOBAL_CAP: usize = 256;
pub const ACTION_INVOCATION_PROVIDER_CAP: usize = 32;
pub const ACTION_FULL_RESULT_CAP: usize = 4_096;
pub const ACTION_TOMBSTONE_CAP: usize = 65_536;
pub const ACTION_FULL_RESULT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
pub const ACTION_TOMBSTONE_RETENTION_MS: i64 = 365 * 24 * 60 * 60 * 1_000;

const ACTION_ID_MAX_CHARS: usize = 128;
const ACTION_PAYLOAD_MAX_BYTES: usize = 64 * 1_024;
const ACTION_INVOCATION_GLOBAL_CAP_I64: i64 = 256;
const ACTION_INVOCATION_PROVIDER_CAP_I64: i64 = 32;
const ACTION_FULL_RESULT_CAP_I64: i64 = 4_096;
const ACTION_TOMBSTONE_CAP_I64: i64 = 65_536;

pub(crate) const EXPECTED_ACTION_INVOCATIONS_SCHEMA: &str = "CREATE TABLE action_invocations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    invocation_id TEXT NOT NULL UNIQUE CHECK (length(invocation_id) = 36),
    epoch TEXT NOT NULL CHECK (length(epoch) = 36),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 1 AND 128),
    action_version INTEGER NOT NULL CHECK (action_version BETWEEN 1 AND 4294967295),
    correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
    caller_id TEXT NOT NULL CHECK (length(caller_id) = 36),
    parameters_json TEXT NOT NULL CHECK (length(CAST(parameters_json AS BLOB)) <= 65536),
    state TEXT NOT NULL CHECK (state IN ('accepted', 'leased', 'dispatched', 'startClaimed', 'startGranted', 'acknowledged', 'failed', 'canceled', 'expired')),
    attempt_epoch INTEGER CHECK (attempt_epoch IS NULL OR attempt_epoch BETWEEN 1 AND 9007199254740991),
    provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) = 36),
    provider_epoch INTEGER CHECK (provider_epoch IS NULL OR provider_epoch BETWEEN 1 AND 9007199254740991),
    provider_lease_id TEXT CHECK (provider_lease_id IS NULL OR length(provider_lease_id) = 36),
    window_id TEXT CHECK (window_id IS NULL OR length(window_id) = 36),
    window_generation INTEGER CHECK (window_generation IS NULL OR window_generation >= 1),
    terminal_code TEXT CHECK (terminal_code IS NULL OR terminal_code IN ('succeeded', 'failed', 'interrupted', 'canceled', 'expired')),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
    result_json TEXT CHECK (result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 65536),
    accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= accepted_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= accepted_at_ms),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= accepted_at_ms),
    UNIQUE(epoch, idempotency_key),
    CHECK ((attempt_epoch IS NULL AND provider_id IS NULL AND provider_epoch IS NULL AND provider_lease_id IS NULL AND window_id IS NULL AND window_generation IS NULL) OR (attempt_epoch IS NOT NULL AND provider_id IS NOT NULL AND provider_epoch IS NOT NULL AND provider_lease_id IS NOT NULL AND window_id IS NOT NULL AND window_generation IS NOT NULL)),
    CHECK ((state IN ('accepted', 'leased', 'dispatched', 'startClaimed', 'startGranted') AND terminal_code IS NULL AND error_code IS NULL AND result_json IS NULL AND terminal_at_ms IS NULL) OR (state = 'acknowledged' AND terminal_code = 'succeeded' AND error_code IS NULL AND result_json IS NOT NULL AND terminal_at_ms IS NOT NULL) OR (state = 'failed' AND terminal_code IN ('failed', 'interrupted') AND error_code IS NOT NULL AND result_json IS NULL AND terminal_at_ms IS NOT NULL) OR (state = 'canceled' AND terminal_code = 'canceled' AND error_code IS NULL AND result_json IS NULL AND terminal_at_ms IS NOT NULL) OR (state = 'expired' AND terminal_code = 'expired' AND error_code IS NULL AND result_json IS NULL AND terminal_at_ms IS NOT NULL))
)";

pub(crate) const EXPECTED_ACTION_TOMBSTONES_SCHEMA: &str =
    "CREATE TABLE action_invocation_tombstones (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch TEXT NOT NULL CHECK (length(epoch) = 36),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    terminal_code TEXT NOT NULL CHECK (terminal_code IN ('succeeded', 'failed', 'interrupted', 'canceled', 'expired')),
    completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
    UNIQUE(epoch, idempotency_key)
)";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionInvocationState {
    Accepted,
    Leased,
    Dispatched,
    StartClaimed,
    StartGranted,
    Acknowledged,
    Failed,
    Canceled,
    Expired,
}

impl ActionInvocationState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Leased => "leased",
            Self::Dispatched => "dispatched",
            Self::StartClaimed => "startClaimed",
            Self::StartGranted => "startGranted",
            Self::Acknowledged => "acknowledged",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Expired => "expired",
        }
    }

    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "accepted" => Ok(Self::Accepted),
            "leased" => Ok(Self::Leased),
            "dispatched" => Ok(Self::Dispatched),
            "startClaimed" => Ok(Self::StartClaimed),
            "startGranted" => Ok(Self::StartGranted),
            "acknowledged" => Ok(Self::Acknowledged),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            "expired" => Ok(Self::Expired),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Acknowledged | Self::Failed | Self::Canceled | Self::Expired
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionInvocationIdentity {
    pub attempt_epoch: u64,
    pub provider_id: Uuid,
    pub provider_epoch: u64,
    pub provider_lease_id: Uuid,
    pub window_id: Uuid,
    pub window_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionInvocationCreate {
    pub invocation_id: Uuid,
    pub epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub action_id: String,
    pub action_version: u32,
    pub correlation_id: Uuid,
    pub caller_id: Uuid,
    pub parameters_json: String,
    pub accepted_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionStartClaim {
    pub invocation_id: Uuid,
    pub correlation_id: Uuid,
    pub action_id: String,
    pub action_version: u32,
    pub identity: ActionInvocationIdentity,
    pub claimed_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionTerminalAck {
    pub invocation_id: Uuid,
    pub correlation_id: Uuid,
    pub action_id: String,
    pub action_version: u32,
    pub identity: ActionInvocationIdentity,
    pub state: ActionInvocationState,
    pub terminal_code: String,
    pub error_code: Option<String>,
    pub result_json: Option<String>,
    pub completed_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionTerminalOutcome {
    pub state: ActionInvocationState,
    pub terminal_code: String,
    pub error_code: Option<String>,
    pub result_json: Option<String>,
    pub completed_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionInvocationRecord {
    pub invocation_id: Uuid,
    pub epoch: Uuid,
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub action_id: String,
    pub action_version: u32,
    pub correlation_id: Uuid,
    pub caller_id: Uuid,
    pub parameters_json: String,
    pub state: ActionInvocationState,
    pub identity: Option<ActionInvocationIdentity>,
    pub terminal: Option<ActionTerminalOutcome>,
    pub accepted_at_ms: i64,
    pub updated_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionInvocationCreateOutcome {
    Created(ActionInvocationRecord),
    Pending(ActionInvocationRecord),
    Replay(ActionTerminalOutcome),
    ResultExpired { terminal_code: String },
    Conflict,
    EpochExpired,
    ResourceLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionLifecycleOutcome {
    Applied(ActionInvocationRecord),
    Replay(ActionInvocationRecord),
    Terminal(ActionTerminalOutcome),
    CancellationNotGuaranteed,
    Mismatch,
    InvalidState(ActionInvocationState),
    NotFound,
    ResourceLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionRecoveryQuery {
    AllNonterminal,
    AwaitingProvider,
    Granted,
    ExpiredAtOrBefore(i64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionPruneReport {
    pub full_results_compacted: usize,
    pub tombstones_deleted: usize,
    pub epoch_rotated_to: Option<Uuid>,
}

pub(crate) fn migrate_to_v6(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "CREATE TABLE action_invocations (\
           sequence INTEGER PRIMARY KEY AUTOINCREMENT,\
           invocation_id TEXT NOT NULL UNIQUE CHECK (length(invocation_id) = 36),\
           epoch TEXT NOT NULL CHECK (length(epoch) = 36),\
           idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),\
           request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),\
           action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 1 AND 128),\
           action_version INTEGER NOT NULL CHECK (action_version BETWEEN 1 AND 4294967295),\
           correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),\
           caller_id TEXT NOT NULL CHECK (length(caller_id) = 36),\
           parameters_json TEXT NOT NULL CHECK (length(CAST(parameters_json AS BLOB)) <= 65536),\
           state TEXT NOT NULL CHECK (state IN ('accepted', 'leased', 'dispatched', 'startClaimed', 'startGranted', 'acknowledged', 'failed', 'canceled', 'expired')),\
           attempt_epoch INTEGER CHECK (attempt_epoch IS NULL OR attempt_epoch BETWEEN 1 AND 9007199254740991),\
           provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) = 36),\
           provider_epoch INTEGER CHECK (provider_epoch IS NULL OR provider_epoch BETWEEN 1 AND 9007199254740991),\
           provider_lease_id TEXT CHECK (provider_lease_id IS NULL OR length(provider_lease_id) = 36),\
           window_id TEXT CHECK (window_id IS NULL OR length(window_id) = 36),\
           window_generation INTEGER CHECK (window_generation IS NULL OR window_generation >= 1),\
           terminal_code TEXT CHECK (terminal_code IS NULL OR terminal_code IN ('succeeded', 'failed', 'interrupted', 'canceled', 'expired')),\
           error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),\
           result_json TEXT CHECK (result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 65536),\
           accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),\
           updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= accepted_at_ms),\
           expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= accepted_at_ms),\
           terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= accepted_at_ms),\
           UNIQUE(epoch, idempotency_key),\
           CHECK ((attempt_epoch IS NULL AND provider_id IS NULL AND provider_epoch IS NULL AND provider_lease_id IS NULL AND window_id IS NULL AND window_generation IS NULL) OR (attempt_epoch IS NOT NULL AND provider_id IS NOT NULL AND provider_epoch IS NOT NULL AND provider_lease_id IS NOT NULL AND window_id IS NOT NULL AND window_generation IS NOT NULL)),\
           CHECK ((state IN ('accepted', 'leased', 'dispatched', 'startClaimed', 'startGranted') AND terminal_code IS NULL AND error_code IS NULL AND result_json IS NULL AND terminal_at_ms IS NULL) OR (state = 'acknowledged' AND terminal_code = 'succeeded' AND error_code IS NULL AND result_json IS NOT NULL AND terminal_at_ms IS NOT NULL) OR (state = 'failed' AND terminal_code IN ('failed', 'interrupted') AND error_code IS NOT NULL AND result_json IS NULL AND terminal_at_ms IS NOT NULL) OR (state = 'canceled' AND terminal_code = 'canceled' AND error_code IS NULL AND result_json IS NULL AND terminal_at_ms IS NOT NULL) OR (state = 'expired' AND terminal_code = 'expired' AND error_code IS NULL AND result_json IS NULL AND terminal_at_ms IS NOT NULL))\
         );\
         CREATE TABLE action_invocation_tombstones (\
           sequence INTEGER PRIMARY KEY AUTOINCREMENT,\
           epoch TEXT NOT NULL CHECK (length(epoch) = 36),\
           idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),\
           request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),\
           terminal_code TEXT NOT NULL CHECK (terminal_code IN ('succeeded', 'failed', 'interrupted', 'canceled', 'expired')),\
           completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),\
           UNIQUE(epoch, idempotency_key)\
         );\
         UPDATE migration_metadata SET target_version = 6 WHERE singleton = 1;\
         PRAGMA user_version = 6;",
    )
}

impl SqliteStateStore {
    pub fn create_action_invocation(
        &self,
        request: &ActionInvocationCreate,
    ) -> Result<ActionInvocationCreateOutcome, StorageError> {
        validate_create(request)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = action_transaction(&mut connection, &self.path, "action create")?;
        if read_idempotency_epoch(&transaction, &self.path)? != request.epoch {
            return Ok(ActionInvocationCreateOutcome::EpochExpired);
        }
        if let Some(record) = load_by_key(&transaction, request.epoch, request.idempotency_key)? {
            return Ok(if record.request_hash != request.request_hash {
                ActionInvocationCreateOutcome::Conflict
            } else if let Some(terminal) = record.terminal {
                ActionInvocationCreateOutcome::Replay(terminal)
            } else {
                ActionInvocationCreateOutcome::Pending(record)
            });
        }
        if load_by_id(&transaction, request.invocation_id)?.is_some() {
            return Ok(ActionInvocationCreateOutcome::Conflict);
        }
        if let Some((stored_hash, terminal_code)) = transaction
            .query_row(
                "SELECT request_hash, terminal_code FROM action_invocation_tombstones WHERE epoch = ?1 AND idempotency_key = ?2",
                params![request.epoch.to_string(), request.idempotency_key.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "action tombstone lookup", source))?
        {
            return Ok(if stored_hash == request.request_hash {
                ActionInvocationCreateOutcome::ResultExpired { terminal_code }
            } else {
                ActionInvocationCreateOutcome::Conflict
            });
        }
        let nonterminal_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM action_invocations WHERE terminal_at_ms IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "action nonterminal count", source))?;
        if nonterminal_count >= ACTION_INVOCATION_GLOBAL_CAP_I64 {
            return Ok(ActionInvocationCreateOutcome::ResourceLimit);
        }
        transaction
            .execute(
                "INSERT INTO action_invocations (invocation_id, epoch, idempotency_key, request_hash, action_id, action_version, correlation_id, caller_id, parameters_json, state, accepted_at_ms, updated_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'accepted', ?10, ?10, ?11)",
                params![request.invocation_id.to_string(), request.epoch.to_string(), request.idempotency_key.to_string(), request.request_hash, request.action_id, request.action_version, request.correlation_id.to_string(), request.caller_id.to_string(), request.parameters_json, request.accepted_at_ms, request.expires_at_ms],
            )
            .map_err(|source| database_error(&self.path, "action invocation insert", source))?;
        let record = load_by_id(&transaction, request.invocation_id)?
            .ok_or_else(|| corrupt_lifecycle(&self.path, "inserted invocation row is missing"))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "action create commit", source))?;
        Ok(ActionInvocationCreateOutcome::Created(record))
    }

    pub fn lease_action_invocation(
        &self,
        invocation_id: Uuid,
        correlation_id: Uuid,
        identity: &ActionInvocationIdentity,
        leased_at_ms: i64,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        validate_identity(identity)?;
        validate_time(leased_at_ms, "leased_at_ms")?;
        self.update_identity_state(
            invocation_id,
            correlation_id,
            identity,
            leased_at_ms,
            ActionInvocationState::Accepted,
            ActionInvocationState::Leased,
            true,
        )
    }

    pub fn mark_action_dispatched(
        &self,
        invocation_id: Uuid,
        correlation_id: Uuid,
        identity: &ActionInvocationIdentity,
        dispatched_at_ms: i64,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        validate_identity(identity)?;
        validate_time(dispatched_at_ms, "dispatched_at_ms")?;
        self.update_identity_state(
            invocation_id,
            correlation_id,
            identity,
            dispatched_at_ms,
            ActionInvocationState::Leased,
            ActionInvocationState::Dispatched,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn update_identity_state(
        &self,
        invocation_id: Uuid,
        correlation_id: Uuid,
        identity: &ActionInvocationIdentity,
        at_ms: i64,
        expected: ActionInvocationState,
        next: ActionInvocationState,
        enforce_provider_cap: bool,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = action_transaction(&mut connection, &self.path, "action lifecycle")?;
        let Some(record) = load_by_id(&transaction, invocation_id)? else {
            return Ok(ActionLifecycleOutcome::NotFound);
        };
        if record.correlation_id != correlation_id {
            return Ok(ActionLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(ActionLifecycleOutcome::Terminal(terminal_from_record(
                &record, &self.path,
            )?));
        }
        if record.state == next {
            return Ok(if record.identity.as_ref() == Some(identity) {
                ActionLifecycleOutcome::Replay(record)
            } else {
                ActionLifecycleOutcome::Mismatch
            });
        }
        if record.state != expected {
            return Ok(ActionLifecycleOutcome::InvalidState(record.state));
        }
        if at_ms < record.updated_at_ms {
            return Err(invalid("lifecycle timestamp precedes the durable update"));
        }
        if enforce_provider_cap {
            let count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM action_invocations WHERE provider_id = ?1 AND terminal_at_ms IS NULL",
                [identity.provider_id.to_string()], |row| row.get(0),
            ).map_err(|source| database_error(&self.path, "provider invocation count", source))?;
            if count >= ACTION_INVOCATION_PROVIDER_CAP_I64 {
                return Ok(ActionLifecycleOutcome::ResourceLimit);
            }
        }
        transaction.execute(
            "UPDATE action_invocations SET state = ?1, attempt_epoch = ?2, provider_id = ?3, provider_epoch = ?4, provider_lease_id = ?5, window_id = ?6, window_generation = ?7, updated_at_ms = ?8 WHERE invocation_id = ?9",
            params![next.as_str(), i64::try_from(identity.attempt_epoch).expect("validated safe integer"), identity.provider_id.to_string(), i64::try_from(identity.provider_epoch).expect("validated safe integer"), identity.provider_lease_id.to_string(), identity.window_id.to_string(), i64::try_from(identity.window_generation).expect("validated safe integer"), at_ms, invocation_id.to_string()],
        ).map_err(|source| database_error(&self.path, "action lifecycle update", source))?;
        let updated = load_by_id(&transaction, invocation_id)?
            .ok_or_else(|| corrupt_lifecycle(&self.path, "updated invocation row is missing"))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "action lifecycle commit", source))?;
        Ok(ActionLifecycleOutcome::Applied(updated))
    }

    pub fn claim_action_start(
        &self,
        claim: &ActionStartClaim,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        validate_identity(&claim.identity)?;
        validate_time(claim.claimed_at_ms, "claimed_at_ms")?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = action_transaction(&mut connection, &self.path, "action start claim")?;
        let Some(record) = load_by_id(&transaction, claim.invocation_id)? else {
            return Ok(ActionLifecycleOutcome::NotFound);
        };
        if record.correlation_id != claim.correlation_id
            || record.action_id != claim.action_id
            || record.action_version != claim.action_version
            || record.identity.as_ref() != Some(&claim.identity)
        {
            return Ok(ActionLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(ActionLifecycleOutcome::Terminal(terminal_from_record(
                &record, &self.path,
            )?));
        }
        if record.state == ActionInvocationState::StartGranted {
            return Ok(ActionLifecycleOutcome::Replay(record));
        }
        if record.state != ActionInvocationState::Dispatched {
            return Ok(ActionLifecycleOutcome::InvalidState(record.state));
        }
        if claim.claimed_at_ms < record.updated_at_ms {
            return Err(invalid("claim timestamp precedes dispatch"));
        }
        if claim.claimed_at_ms >= record.expires_at_ms {
            set_terminal(
                &transaction,
                claim.invocation_id,
                ActionInvocationState::Expired,
                "expired",
                None,
                None,
                claim.claimed_at_ms,
                &self.path,
            )?;
            let expired = load_by_id(&transaction, claim.invocation_id)?.ok_or_else(|| {
                corrupt_lifecycle(&self.path, "expired invocation row is missing")
            })?;
            let terminal = terminal_from_record(&expired, &self.path)?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "action start expiry commit", source)
            })?;
            return Ok(ActionLifecycleOutcome::Terminal(terminal));
        }
        transaction.execute("UPDATE action_invocations SET state = 'startClaimed', updated_at_ms = ?1 WHERE invocation_id = ?2", params![claim.claimed_at_ms, claim.invocation_id.to_string()])
            .map_err(|source| database_error(&self.path, "action start claim persistence", source))?;
        transaction.execute("UPDATE action_invocations SET state = 'startGranted' WHERE invocation_id = ?1 AND state = 'startClaimed'", [claim.invocation_id.to_string()])
            .map_err(|source| database_error(&self.path, "action start grant persistence", source))?;
        let granted = load_by_id(&transaction, claim.invocation_id)?
            .ok_or_else(|| corrupt_lifecycle(&self.path, "granted invocation row is missing"))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "action start grant commit", source))?;
        Ok(ActionLifecycleOutcome::Applied(granted))
    }

    pub fn cancel_action_invocation(
        &self,
        invocation_id: Uuid,
        correlation_id: Uuid,
        terminal_code: &str,
        canceled_at_ms: i64,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        self.terminate_action_before_start(
            invocation_id,
            correlation_id,
            ActionInvocationState::Canceled,
            terminal_code,
            canceled_at_ms,
        )
    }

    /// Atomically records a pre-start failure, cancellation, or expiry.
    ///
    /// Once the exact start is granted this returns `CancellationNotGuaranteed`; callers must then
    /// wait for the matching provider to prove a terminal outcome through acknowledgement.
    pub fn terminate_action_before_start(
        &self,
        invocation_id: Uuid,
        correlation_id: Uuid,
        state: ActionInvocationState,
        terminal_code: &str,
        completed_at_ms: i64,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        let error_code = (state == ActionInvocationState::Failed).then_some("execution_failed");
        self.terminate_action_before_start_with_error(
            invocation_id,
            correlation_id,
            state,
            terminal_code,
            error_code,
            completed_at_ms,
        )
    }

    /// Atomically records a pre-start terminal with its exact stable public failure code.
    pub fn terminate_action_before_start_with_error(
        &self,
        invocation_id: Uuid,
        correlation_id: Uuid,
        state: ActionInvocationState,
        terminal_code: &str,
        error_code: Option<&str>,
        completed_at_ms: i64,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        if !matches!(
            state,
            ActionInvocationState::Failed
                | ActionInvocationState::Canceled
                | ActionInvocationState::Expired
        ) {
            return Err(invalid(
                "pre-start termination must be failed, canceled, or expired",
            ));
        }
        validate_terminal_fields(state, terminal_code, error_code, None, completed_at_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = action_transaction(&mut connection, &self.path, "action termination")?;
        let Some(record) = load_by_id(&transaction, invocation_id)? else {
            return Ok(ActionLifecycleOutcome::NotFound);
        };
        if record.correlation_id != correlation_id {
            return Ok(ActionLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            return Ok(ActionLifecycleOutcome::Terminal(terminal_from_record(
                &record, &self.path,
            )?));
        }
        // `startClaimed` is the durable pre-grant fence: the provider has not received authority
        // to perform the effect yet, so definitive caller/provider loss can still terminalize it.
        // Only `startGranted` has an outcome that must be reconciled through the exact identity.
        if record.state == ActionInvocationState::StartGranted {
            return Ok(ActionLifecycleOutcome::CancellationNotGuaranteed);
        }
        if completed_at_ms < record.updated_at_ms {
            return Err(invalid("terminal timestamp precedes the durable update"));
        }
        set_terminal(
            &transaction,
            invocation_id,
            state,
            terminal_code,
            error_code,
            None,
            completed_at_ms,
            &self.path,
        )?;
        let terminal = load_by_id(&transaction, invocation_id)?
            .ok_or_else(|| corrupt_lifecycle(&self.path, "terminal invocation row is missing"))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "action termination commit", source))?;
        Ok(ActionLifecycleOutcome::Applied(terminal))
    }

    pub fn acknowledge_action_terminal(
        &self,
        ack: &ActionTerminalAck,
    ) -> Result<ActionLifecycleOutcome, StorageError> {
        validate_identity(&ack.identity)?;
        validate_terminal_fields(
            ack.state,
            &ack.terminal_code,
            ack.error_code.as_deref(),
            ack.result_json.as_deref(),
            ack.completed_at_ms,
        )?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction =
            action_transaction(&mut connection, &self.path, "action acknowledgement")?;
        let Some(record) = load_by_id(&transaction, ack.invocation_id)? else {
            return Ok(ActionLifecycleOutcome::NotFound);
        };
        if record.correlation_id != ack.correlation_id
            || record.action_id != ack.action_id
            || record.action_version != ack.action_version
            || record.identity.as_ref() != Some(&ack.identity)
        {
            return Ok(ActionLifecycleOutcome::Mismatch);
        }
        if record.state.is_terminal() {
            let terminal = terminal_from_record(&record, &self.path)?;
            return Ok(
                if terminal.state == ack.state
                    && terminal.terminal_code == ack.terminal_code
                    && terminal.error_code == ack.error_code
                    && terminal.result_json == ack.result_json
                {
                    ActionLifecycleOutcome::Terminal(terminal)
                } else {
                    ActionLifecycleOutcome::Mismatch
                },
            );
        }
        if record.state != ActionInvocationState::StartGranted {
            return Ok(ActionLifecycleOutcome::InvalidState(record.state));
        }
        if ack.completed_at_ms < record.updated_at_ms {
            return Err(invalid(
                "acknowledgement timestamp precedes the start grant",
            ));
        }
        set_terminal(
            &transaction,
            ack.invocation_id,
            ack.state,
            &ack.terminal_code,
            ack.error_code.as_deref(),
            ack.result_json.as_deref(),
            ack.completed_at_ms,
            &self.path,
        )?;
        let terminal = load_by_id(&transaction, ack.invocation_id)?.ok_or_else(|| {
            corrupt_lifecycle(&self.path, "acknowledged invocation row is missing")
        })?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "action acknowledgement commit", source)
        })?;
        Ok(ActionLifecycleOutcome::Applied(terminal))
    }

    pub fn recover_action_invocations(
        &self,
        query: ActionRecoveryQuery,
        limit: usize,
    ) -> Result<Vec<ActionInvocationRecord>, StorageError> {
        if limit == 0 || limit > ACTION_INVOCATION_GLOBAL_CAP {
            return Err(invalid("recovery limit must be between 1 and 256"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let (predicate, bound) = match query {
            ActionRecoveryQuery::AllNonterminal => ("terminal_at_ms IS NULL", None),
            ActionRecoveryQuery::AwaitingProvider => {
                ("state IN ('accepted', 'leased', 'dispatched')", None)
            }
            ActionRecoveryQuery::Granted => ("state IN ('startClaimed', 'startGranted')", None),
            ActionRecoveryQuery::ExpiredAtOrBefore(at) => {
                validate_time(at, "recovery expiry")?;
                ("terminal_at_ms IS NULL AND expires_at_ms <= ?1", Some(at))
            }
        };
        let sql = format!(
            "SELECT {} FROM action_invocations WHERE {predicate} ORDER BY sequence LIMIT ?{}",
            RECORD_COLUMNS,
            if bound.is_some() { 2 } else { 1 }
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|source| database_error(&self.path, "action recovery prepare", source))?;
        let limit = i64::try_from(limit).map_err(|_| invalid("recovery limit is invalid"))?;
        let rows = if let Some(at) = bound {
            statement.query_map(params![at, limit], row_to_record)
        } else {
            statement.query_map([limit], row_to_record)
        }
        .map_err(|source| database_error(&self.path, "action recovery query", source))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|source| database_error(&self.path, "action recovery decode", source))
    }

    /// Looks up one exact durable action row, including terminal outcomes.
    pub fn action_invocation(
        &self,
        invocation_id: Uuid,
    ) -> Result<Option<ActionInvocationRecord>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_by_id(&connection, invocation_id)
    }

    pub fn prune_action_invocations(&self, now_ms: i64) -> Result<ActionPruneReport, StorageError> {
        validate_time(now_ms, "prune time")?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = action_transaction(&mut connection, &self.path, "action prune")?;
        let age_cutoff = now_ms.saturating_sub(ACTION_FULL_RESULT_RETENTION_MS);
        let terminal_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM action_invocations WHERE terminal_at_ms IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "action result count", source))?;
        let excess = terminal_count.saturating_sub(ACTION_FULL_RESULT_CAP_I64);
        let compacted = transaction.execute(
            "INSERT OR IGNORE INTO action_invocation_tombstones (epoch, idempotency_key, request_hash, terminal_code, completed_at_ms) SELECT epoch, idempotency_key, request_hash, terminal_code, terminal_at_ms FROM action_invocations WHERE terminal_at_ms IS NOT NULL AND (terminal_at_ms < ?1 OR sequence IN (SELECT sequence FROM action_invocations WHERE terminal_at_ms IS NOT NULL ORDER BY terminal_at_ms, sequence LIMIT ?2))",
            params![age_cutoff, excess],
        ).map_err(|source| database_error(&self.path, "action result compaction", source))?;
        transaction.execute(
            "DELETE FROM action_invocations WHERE terminal_at_ms IS NOT NULL AND (terminal_at_ms < ?1 OR sequence IN (SELECT sequence FROM action_invocations WHERE terminal_at_ms IS NOT NULL ORDER BY terminal_at_ms, sequence LIMIT ?2))",
            params![age_cutoff, excess],
        ).map_err(|source| database_error(&self.path, "action compacted result deletion", source))?;
        let tombstone_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM action_invocation_tombstones",
                [],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "action tombstone count", source))?;
        let old_cutoff = now_ms.saturating_sub(ACTION_TOMBSTONE_RETENTION_MS);
        let old_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM action_invocation_tombstones WHERE completed_at_ms < ?1",
                [old_cutoff],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "old action tombstone count", source))?;
        let must_rotate = old_count > 0 || tombstone_count > ACTION_TOMBSTONE_CAP_I64;
        let (deleted, rotated) = if must_rotate {
            let deleted = transaction
                .execute("DELETE FROM action_invocation_tombstones", [])
                .map_err(|source| {
                    database_error(&self.path, "action tombstone destructive prune", source)
                })?;
            transaction
                .execute("DELETE FROM idempotency_results", [])
                .map_err(|source| {
                    database_error(
                        &self.path,
                        "action prune prior-epoch idempotency clear",
                        source,
                    )
                })?;
            let next = Uuid::new_v4();
            transaction.execute("UPDATE idempotency_epoch SET epoch = ?1, issued_at_ms = ?2 WHERE singleton = 1", params![next.to_string(), now_ms])
                .map_err(|source| database_error(&self.path, "action prune epoch rotation", source))?;
            (deleted, Some(next))
        } else {
            (0, None)
        };
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "action prune commit", source))?;
        Ok(ActionPruneReport {
            full_results_compacted: compacted,
            tombstones_deleted: deleted,
            epoch_rotated_to: rotated,
        })
    }
}

pub(crate) const RECORD_COLUMNS: &str = "invocation_id, epoch, idempotency_key, request_hash, action_id, action_version, correlation_id, caller_id, parameters_json, state, attempt_epoch, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, terminal_code, error_code, result_json, accepted_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms";

fn load_by_id(
    connection: &Connection,
    invocation_id: Uuid,
) -> Result<Option<ActionInvocationRecord>, StorageError> {
    let sql = format!("SELECT {RECORD_COLUMNS} FROM action_invocations WHERE invocation_id = ?1");
    connection
        .query_row(&sql, [invocation_id.to_string()], row_to_record)
        .optional()
        .map_err(|source| {
            database_error(
                Path::new("action_invocations"),
                "action invocation lookup",
                source,
            )
        })
}

fn load_by_key(
    connection: &Connection,
    epoch: Uuid,
    key: Uuid,
) -> Result<Option<ActionInvocationRecord>, StorageError> {
    let sql = format!(
        "SELECT {RECORD_COLUMNS} FROM action_invocations WHERE epoch = ?1 AND idempotency_key = ?2"
    );
    connection
        .query_row(
            &sql,
            params![epoch.to_string(), key.to_string()],
            row_to_record,
        )
        .optional()
        .map_err(|source| {
            database_error(
                Path::new("action_invocations"),
                "action idempotency lookup",
                source,
            )
        })
}

pub(crate) fn row_to_record(row: &Row<'_>) -> rusqlite::Result<ActionInvocationRecord> {
    let state = ActionInvocationState::parse(&row.get::<_, String>(9)?)?;
    let attempt_epoch = optional_safe_u64(row, 10)?;
    let identity = if let Some(attempt_epoch) = attempt_epoch {
        Some(ActionInvocationIdentity {
            attempt_epoch,
            provider_id: required_uuid(row, 11)?,
            provider_epoch: required_safe_u64(row, 12)?,
            provider_lease_id: required_uuid(row, 13)?,
            window_id: required_uuid(row, 14)?,
            window_generation: u64::try_from(row.get::<_, i64>(15)?).map_err(|source| {
                rusqlite::Error::FromSqlConversionFailure(
                    15,
                    rusqlite::types::Type::Integer,
                    Box::new(source),
                )
            })?,
        })
    } else {
        None
    };
    let terminal_code: Option<String> = row.get(16)?;
    let terminal_at_ms: Option<i64> = row.get(22)?;
    let terminal = match (terminal_code, terminal_at_ms) {
        (Some(terminal_code), Some(completed_at_ms)) => Some(ActionTerminalOutcome {
            state,
            terminal_code,
            error_code: row.get(17)?,
            result_json: row.get(18)?,
            completed_at_ms,
        }),
        (None, None) => None,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(ActionInvocationRecord {
        invocation_id: required_uuid(row, 0)?,
        epoch: required_uuid(row, 1)?,
        idempotency_key: required_uuid(row, 2)?,
        request_hash: row.get(3)?,
        action_id: row.get(4)?,
        action_version: row.get(5)?,
        correlation_id: required_uuid(row, 6)?,
        caller_id: required_uuid(row, 7)?,
        parameters_json: row.get(8)?,
        state,
        identity,
        terminal,
        accepted_at_ms: row.get(19)?,
        updated_at_ms: row.get(20)?,
        expires_at_ms: row.get(21)?,
    })
}

fn required_uuid(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    let value: String = row.get(index)?;
    Uuid::parse_str(&value).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(source),
        )
    })
}

fn required_safe_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(row.get::<_, i64>(index)?).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(source),
        )
    })
}

fn optional_safe_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u64::try_from(value).map_err(|source| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Integer,
                    Box::new(source),
                )
            })
        })
        .transpose()
}

#[allow(clippy::too_many_arguments)]
fn set_terminal(
    connection: &Connection,
    invocation_id: Uuid,
    state: ActionInvocationState,
    code: &str,
    error_code: Option<&str>,
    result: Option<&str>,
    at_ms: i64,
    path: &Path,
) -> Result<(), StorageError> {
    connection.execute("UPDATE action_invocations SET state = ?1, terminal_code = ?2, error_code = ?3, result_json = ?4, terminal_at_ms = ?5, updated_at_ms = ?5 WHERE invocation_id = ?6 AND terminal_at_ms IS NULL", params![state.as_str(), code, error_code, result, at_ms, invocation_id.to_string()])
        .map_err(|source| database_error(path, "action terminal persistence", source))?;
    Ok(())
}

fn terminal_from_record(
    record: &ActionInvocationRecord,
    path: &Path,
) -> Result<ActionTerminalOutcome, StorageError> {
    record
        .terminal
        .clone()
        .ok_or_else(|| corrupt_lifecycle(path, "terminal state is missing its terminal outcome"))
}

fn corrupt_lifecycle(path: &Path, message: impl Into<String>) -> StorageError {
    StorageError::CorruptSchema {
        path: path.to_path_buf(),
        message: message.into(),
    }
}

fn action_transaction<'a>(
    connection: &'a mut Connection,
    path: &Path,
    operation: &'static str,
) -> Result<Transaction<'a>, StorageError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| database_error(path, operation, source))
}

fn validate_create(request: &ActionInvocationCreate) -> Result<(), StorageError> {
    if request.request_hash.len() != 64
        || !request
            .request_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            "request_hash must be 64 lowercase hexadecimal characters",
        ));
    }
    if !valid_namespaced_action_id(&request.action_id) {
        return Err(invalid(
            "action_id must be a lowercase namespaced identifier",
        ));
    }
    if request.action_version == 0 {
        return Err(invalid("action_version must be positive"));
    }
    if request.parameters_json.len() > ACTION_PAYLOAD_MAX_BYTES {
        return Err(invalid("parameters exceed 64 KiB"));
    }
    validate_json_object(&request.parameters_json, "parameters_json")?;
    validate_time(request.accepted_at_ms, "accepted_at_ms")?;
    if request.expires_at_ms < request.accepted_at_ms {
        return Err(invalid("expires_at_ms precedes acceptance"));
    }
    Ok(())
}

fn validate_identity(identity: &ActionInvocationIdentity) -> Result<(), StorageError> {
    if identity.attempt_epoch == 0 || identity.attempt_epoch > MAX_SAFE_INTEGER {
        return Err(invalid("attempt_epoch must be a positive safe integer"));
    }
    if identity.provider_epoch == 0 || identity.provider_epoch > MAX_SAFE_INTEGER {
        return Err(invalid("provider_epoch must be a positive safe integer"));
    }
    if identity.window_generation == 0 || identity.window_generation > MAX_SAFE_INTEGER {
        return Err(invalid("window_generation must be a positive safe integer"));
    }
    Ok(())
}

fn validate_terminal_fields(
    state: ActionInvocationState,
    code: &str,
    error_code: Option<&str>,
    result: Option<&str>,
    at_ms: i64,
) -> Result<(), StorageError> {
    if !state.is_terminal() {
        return Err(invalid(
            "terminal acknowledgement requires a terminal state",
        ));
    }
    let consistent = match state {
        ActionInvocationState::Acknowledged => {
            code == "succeeded" && error_code.is_none() && result.is_some()
        }
        ActionInvocationState::Failed => {
            matches!(code, "failed" | "interrupted")
                && error_code.is_some_and(valid_action_error_code)
                && result.is_none()
        }
        ActionInvocationState::Canceled => {
            code == "canceled" && error_code.is_none() && result.is_none()
        }
        ActionInvocationState::Expired => {
            code == "expired" && error_code.is_none() && result.is_none()
        }
        _ => false,
    };
    if !consistent {
        return Err(invalid("terminal state, code, and result are inconsistent"));
    }
    if let Some(result) = result {
        if result.len() > ACTION_PAYLOAD_MAX_BYTES {
            return Err(invalid("result exceeds 64 KiB"));
        }
        validate_json_object(result, "result_json")?;
    }
    validate_time(at_ms, "terminal timestamp")
}

fn valid_action_error_code(code: &str) -> bool {
    matches!(
        code,
        "capability_unavailable"
            | "action_not_found"
            | "action_version_mismatch"
            | "cursor_invalid"
            | "cursor_expired"
            | "invalid_parameters"
            | "invalid_result"
            | "unauthorized"
            | "policy_denied"
            | "target_required"
            | "target_not_found"
            | "target_stale"
            | "provider_unavailable"
            | "provider_ineligible"
            | "provider_backpressure"
            | "provider_lease_expired"
            | "provider_epoch_mismatch"
            | "idempotency_conflict"
            | "idempotency_expired"
            | "resource_limit"
            | "confirmation_required"
            | "cancellation_not_guaranteed"
            | "canceled"
            | "expired"
            | "execution_failed"
            | "correlation_mismatch"
            | "invalid_state"
    )
}

fn valid_namespaced_action_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ACTION_ID_MAX_CHARS
        && value.contains('.')
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'-' | b'_')
                })
        })
}

fn validate_json_object(value: &str, field: &str) -> Result<(), StorageError> {
    let decoded = serde_json::from_str::<serde_json::Value>(value)
        .map_err(|_| invalid(format!("{field} must contain valid JSON")))?;
    if !decoded.is_object() {
        return Err(invalid(format!("{field} must be a top-level object")));
    }
    Ok(())
}

fn validate_time(value: i64, field: &str) -> Result<(), StorageError> {
    if value < 0 {
        return Err(invalid(format!("{field} must be nonnegative")));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidActionInvocation {
        message: message.into(),
    }
}

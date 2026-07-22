//! Schema-v10 privacy-minimized remote target and session intent.

use super::{
    LEGACY_IDEMPOTENCY_EPOCH, MAX_SAFE_INTEGER, SqliteStateStore, StorageError, database_error,
    secure_database_artifacts, verify_table_schema,
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use std::path::Path;
use uuid::Uuid;

pub const MAX_REMOTE_TARGETS: usize = 128;
pub const MAX_REMOTE_SESSIONS: usize = 256;
const MAX_REMOTE_TARGETS_I64: i64 = 128;
const MAX_REMOTE_SESSIONS_I64: i64 = 256;

pub(crate) const EXPECTED_REMOTE_TARGETS_SCHEMA: &str = "CREATE TABLE remote_targets (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    remote_target_id TEXT NOT NULL UNIQUE CHECK (length(remote_target_id) = 36),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 512),
    host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    user TEXT NOT NULL CHECK (length(user) BETWEEN 1 AND 64),
    host_key_state TEXT NOT NULL CHECK (host_key_state IN ('untrusted', 'trusted', 'changed', 'revoked')),
    known_hosts_version INTEGER NOT NULL CHECK (known_hosts_version BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE(idempotency_key)
)";

pub(crate) const EXPECTED_REMOTE_SESSIONS_SCHEMA: &str = "CREATE TABLE remote_sessions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    remote_session_id TEXT NOT NULL UNIQUE CHECK (length(remote_session_id) = 36),
    remote_target_id TEXT NOT NULL CHECK (length(remote_target_id) = 36),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
    pane_id TEXT NOT NULL CHECK (length(pane_id) = 36),
    tab_id TEXT NOT NULL CHECK (length(tab_id) = 36),
    tmux_mode TEXT CHECK (tmux_mode IS NULL OR tmux_mode IN ('attach', 'create')),
    tmux_name TEXT CHECK (tmux_name IS NULL OR length(tmux_name) BETWEEN 1 AND 64),
    state TEXT NOT NULL CHECK (state IN ('created', 'trustRequired', 'credentialRequired', 'connecting', 'connected', 'reconnecting', 'detached', 'failed', 'closed')),
    observation TEXT NOT NULL CHECK (observation IN ('unknown', 'lastVerified', 'lost')),
    attempt_generation INTEGER NOT NULL CHECK (attempt_generation BETWEEN 1 AND 9007199254740991),
    reconnect_max_attempts INTEGER NOT NULL CHECK (reconnect_max_attempts BETWEEN 0 AND 10),
    reconnect_initial_delay_ms INTEGER NOT NULL CHECK (reconnect_initial_delay_ms BETWEEN 100 AND 60000),
    reconnect_max_delay_ms INTEGER NOT NULL CHECK (reconnect_max_delay_ms BETWEEN reconnect_initial_delay_ms AND 300000),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE(idempotency_key),
    FOREIGN KEY(remote_target_id) REFERENCES remote_targets(remote_target_id),
    CHECK ((tmux_mode IS NULL AND tmux_name IS NULL) OR (tmux_mode IS NOT NULL AND tmux_name IS NOT NULL))
)";

pub(crate) const EXPECTED_REMOTE_TARGET_DELETIONS_SCHEMA: &str =
    "CREATE TABLE remote_target_deletions (
    remote_target_id TEXT PRIMARY KEY NOT NULL CHECK (length(remote_target_id) = 36),
    expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740991),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 1 AND 262144),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    FOREIGN KEY(remote_target_id) REFERENCES remote_targets(remote_target_id)
)";

pub(crate) const EXPECTED_REMOTE_CREDENTIAL_ENROLLMENTS_SCHEMA: &str =
    "CREATE TABLE remote_credential_enrollments (
    enrollment_id TEXT PRIMARY KEY NOT NULL CHECK (length(enrollment_id) = 36),
    remote_target_id TEXT NOT NULL UNIQUE CHECK (length(remote_target_id) = 36),
    expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740991),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
)";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteSessionStateRecord {
    Created,
    TrustRequired,
    CredentialRequired,
    Connecting,
    Connected,
    Reconnecting,
    Detached,
    Failed,
    Closed,
}
impl RemoteSessionStateRecord {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::TrustRequired => "trustRequired",
            Self::CredentialRequired => "credentialRequired",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Detached => "detached",
            Self::Failed => "failed",
            Self::Closed => "closed",
        }
    }
    fn can_transition(self, next: Self) -> bool {
        use RemoteSessionStateRecord as S;
        matches!(
            (self, next),
            (
                S::Created,
                S::TrustRequired | S::CredentialRequired | S::Connecting | S::Closed
            ) | (
                S::TrustRequired,
                S::CredentialRequired | S::Connecting | S::Failed | S::Closed
            ) | (S::CredentialRequired, S::Connecting | S::Failed | S::Closed)
                | (
                    S::Connecting,
                    S::Connected | S::Reconnecting | S::Failed | S::Closed
                )
                | (
                    S::Connected,
                    S::Reconnecting | S::Detached | S::Failed | S::Closed
                )
                | (
                    S::Reconnecting,
                    S::Connected | S::Detached | S::Failed | S::Closed
                )
                | (S::Detached, S::Connecting | S::Closed)
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteTargetRecord {
    pub remote_target_id: Uuid,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub host_key_state: String,
    pub known_hosts_version: u64,
    pub revision: u64,
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub created_at_ms: i64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteSessionRecord {
    pub remote_session_id: Uuid,
    pub remote_target_id: Uuid,
    pub workspace_id: Uuid,
    pub pane_id: Uuid,
    pub tab_id: Uuid,
    pub tmux_mode: Option<String>,
    pub tmux_name: Option<String>,
    pub state: RemoteSessionStateRecord,
    pub observation: String,
    pub attempt_generation: u64,
    pub reconnect_max_attempts: u8,
    pub reconnect_initial_delay_ms: u32,
    pub reconnect_max_delay_ms: u32,
    pub revision: u64,
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub created_at_ms: i64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteCreateOutcome {
    Created,
    Replay,
    Conflict,
    LimitReached,
}

/// Result of an exact, namespaced remote mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteMutationOutcome {
    Applied,
    Replay(String),
    Conflict,
    NotFound,
    StaleRevision,
    ResourceLimit,
    InvalidState,
}

pub(crate) fn migrate_to_v10(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    // Tolerate test/recovery databases whose user_version was manually lowered
    // while retaining exact v10 tables; verification after migration still
    // rejects any mismatched definition.
    let targets_exist: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='remote_targets')",
        [],
        |row| row.get(0),
    )?;
    if !targets_exist {
        tx.execute_batch(EXPECTED_REMOTE_TARGETS_SCHEMA)?;
    }
    let sessions_exist: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='remote_sessions')",
        [],
        |row| row.get(0),
    )?;
    if !sessions_exist {
        tx.execute_batch(EXPECTED_REMOTE_SESSIONS_SCHEMA)?;
    }
    tx.pragma_update(None, "user_version", 10)
}

pub(crate) fn migrate_to_v12(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='remote_target_deletions')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch(EXPECTED_REMOTE_TARGET_DELETIONS_SCHEMA)?;
    }
    tx.execute_batch(
        "UPDATE migration_metadata SET target_version = 12 WHERE singleton = 1;PRAGMA user_version = 12;",
    )
}

pub(crate) fn migrate_to_v14(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    // Recovery tests and inspected databases may have a deliberately lowered
    // user_version while retaining later tables. Avoid replacing such a table;
    // the post-migration verifier still requires its exact definition.
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='remote_credential_enrollments')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch(EXPECTED_REMOTE_CREDENTIAL_ENROLLMENTS_SCHEMA)?;
    }
    tx.execute_batch(
        "UPDATE migration_metadata SET target_version = 14 WHERE singleton = 1;PRAGMA user_version = 14;",
    )
}

pub(crate) fn verify_schema(
    connection: &rusqlite::Connection,
    path: &Path,
) -> Result<(), StorageError> {
    verify_table_schema(
        connection,
        path,
        "remote_targets",
        EXPECTED_REMOTE_TARGETS_SCHEMA,
        10,
    )?;
    verify_table_schema(
        connection,
        path,
        "remote_sessions",
        EXPECTED_REMOTE_SESSIONS_SCHEMA,
        10,
    )?;
    for (table, cap) in [
        ("remote_targets", MAX_REMOTE_TARGETS_I64),
        ("remote_sessions", MAX_REMOTE_SESSIONS_I64),
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| database_error(path, "remote row-bound verification", e))?;
        if count > cap {
            return Err(StorageError::CorruptSchema {
                path: path.to_path_buf(),
                message: format!("{table} exceeds its durable row bound"),
            });
        }
    }
    let mut targets = connection
        .prepare("SELECT remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision,idempotency_key,request_hash,created_at_ms FROM remote_targets")
        .map_err(|e| database_error(path, "remote target corruption preparation", e))?;
    let rows = targets
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u16>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, i64>(10)?,
            ))
        })
        .map_err(|e| database_error(path, "remote target corruption read", e))?;
    for row in rows {
        let (id, label, host, port, user, state, known, revision, key, hash, created) =
            row.map_err(|e| database_error(path, "remote target corruption row", e))?;
        let corrupt = || StorageError::CorruptSchema {
            path: path.to_path_buf(),
            message: "remote_targets contains an invalid privacy-bound row".into(),
        };
        let record = RemoteTargetRecord {
            remote_target_id: parse_uuid(&id).map_err(|_| corrupt())?,
            label,
            host,
            port,
            user,
            host_key_state: state,
            known_hosts_version: stored_uint(known, "known-hosts version")
                .map_err(|_| corrupt())?,
            revision: stored_uint(revision, "target revision").map_err(|_| corrupt())?,
            idempotency_key: parse_uuid(&key).map_err(|_| corrupt())?,
            request_hash: hash,
            created_at_ms: created,
        };
        validate_target(&record).map_err(|_| corrupt())?;
    }
    let malformed_sessions:i64=connection.query_row(
        "SELECT count(*) FROM remote_sessions WHERE request_hash GLOB '*[^0-9a-f]*' OR length(request_hash) != 64 OR (tmux_name IS NOT NULL AND (tmux_name GLOB '*[^A-Za-z0-9_.-]*' OR length(tmux_name) > 64))",
        [],|r|r.get(0)).map_err(|e|database_error(path,"remote session corruption read",e))?;
    if malformed_sessions != 0 {
        return Err(StorageError::CorruptSchema {
            path: path.to_path_buf(),
            message: "remote_sessions contains invalid bounded text".into(),
        });
    }
    Ok(())
}

pub(crate) fn verify_deletion_schema(
    connection: &rusqlite::Connection,
    path: &Path,
) -> Result<(), StorageError> {
    verify_table_schema(
        connection,
        path,
        "remote_target_deletions",
        EXPECTED_REMOTE_TARGET_DELETIONS_SCHEMA,
        12,
    )
}

pub(crate) fn verify_enrollment_schema(
    connection: &rusqlite::Connection,
    path: &Path,
) -> Result<(), StorageError> {
    verify_table_schema(
        connection,
        path,
        "remote_credential_enrollments",
        EXPECTED_REMOTE_CREDENTIAL_ENROLLMENTS_SCHEMA,
        14,
    )
}

impl SqliteStateStore {
    /// Looks up one exact remote terminal result without re-entering its mutation path.
    pub fn load_remote_mutation_result(
        &self,
        namespace: &str,
        idempotency_key: Uuid,
        request_hash: &str,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_namespace(namespace)?;
        if idempotency_key.is_nil() || !valid_hash(request_hash) {
            return Err(invalid("remote mutation identity is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let stored = connection.query_row("SELECT request_hash,result_json FROM idempotency_results WHERE namespace=?1 AND epoch=?2 AND idempotency_key=?3", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, idempotency_key.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).optional()
            .map_err(|error| database_error(&self.path, "remote idempotency lookup", error))?;
        Ok(match stored {
            None => RemoteMutationOutcome::NotFound,
            Some((hash, _)) if hash != request_hash => RemoteMutationOutcome::Conflict,
            Some((_, Some(result))) => RemoteMutationOutcome::Replay(result),
            Some((_, None)) => RemoteMutationOutcome::InvalidState,
        })
    }

    /// Loads one durable non-secret remote target.
    pub fn load_remote_target(&self, id: Uuid) -> Result<Option<RemoteTargetRecord>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .query_row(
                &format!("SELECT {TARGET_COLUMNS} FROM remote_targets WHERE remote_target_id=?1"),
                [id.to_string()],
                target_from_row,
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target read", error))
    }

    /// Lists targets in stable UUID order. The cursor is the last UUID from the previous page.
    pub fn list_remote_targets(
        &self,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<(Vec<RemoteTargetRecord>, Option<Uuid>), StorageError> {
        if !(1..=128).contains(&limit) {
            return Err(invalid("remote target page limit is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {TARGET_COLUMNS} FROM remote_targets WHERE remote_target_id>?1 ORDER BY remote_target_id LIMIT ?2"
            ))
            .map_err(|error| database_error(&self.path, "remote target list prepare", error))?;
        let rows = statement
            .query_map(
                params![
                    cursor.map_or_else(String::new, |value| value.to_string()),
                    i64::from(limit) + 1
                ],
                target_from_row,
            )
            .map_err(|error| database_error(&self.path, "remote target list", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| database_error(&self.path, "remote target list row", error))?;
        Ok(page(rows, usize::from(limit), |record| {
            record.remote_target_id
        }))
    }

    /// Creates a target and stores the exact terminal response in the same transaction.
    pub fn create_remote_target_exact(
        &self,
        record: &RemoteTargetRecord,
        result_json: &str,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_target(record)?;
        validate_result(result_json)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "remote target exact transaction", error)
            })?;
        if let Some(outcome) = replay_outcome(
            &tx,
            "remote.target.create",
            record.idempotency_key,
            &record.request_hash,
        )? {
            return Ok(outcome);
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM remote_targets", [], |row| row.get(0))
            .map_err(|error| database_error(&self.path, "remote target exact count", error))?;
        if count >= MAX_REMOTE_TARGETS_I64 {
            return Ok(RemoteMutationOutcome::ResourceLimit);
        }
        if tx
            .query_row(
                "SELECT 1 FROM remote_targets WHERE remote_target_id=?1 UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id=?1 LIMIT 1",
                [record.remote_target_id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target identity lookup", error))?
            .is_some()
        {
            return Ok(RemoteMutationOutcome::InvalidState);
        }
        insert_target(&tx, record, &self.path)?;
        save_remote_result(
            &tx,
            "remote.target.create",
            record.idempotency_key,
            &record.request_hash,
            result_json,
            record.created_at_ms,
        )?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "remote target exact commit", error))?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Durably records deletion intent and fences all durable sessions before external cleanup.
    pub fn begin_remote_target_delete_exact(
        &self,
        id: Uuid,
        expected_revision: u64,
        idempotency_key: Uuid,
        request_hash: &str,
        result_json: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_mutation(idempotency_key, request_hash, result_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "remote target delete intent", error))?;
        if let Some(outcome) =
            replay_outcome(&tx, "remote.target.delete", idempotency_key, request_hash)?
        {
            return Ok(outcome);
        }
        if let Some((stored_key, stored_hash)) = tx
            .query_row(
                "SELECT idempotency_key,request_hash FROM remote_target_deletions WHERE remote_target_id=?1",
                [id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target deletion lookup", error))?
        {
            return Ok(if stored_key == idempotency_key.to_string() && stored_hash == request_hash {
                RemoteMutationOutcome::Applied
            } else {
                RemoteMutationOutcome::InvalidState
            });
        }
        let Some(revision) = tx
            .query_row(
                "SELECT revision FROM remote_targets WHERE remote_target_id=?1",
                [id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target delete read", error))?
        else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        if stored_uint(revision, "target revision")? != expected_revision {
            return Ok(RemoteMutationOutcome::StaleRevision);
        }
        tx.execute(
            "INSERT INTO remote_target_deletions(remote_target_id,expected_revision,idempotency_key,request_hash,result_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id.to_string(), sql_int(expected_revision, "target revision")?, idempotency_key.to_string(), request_hash, result_json, now_ms],
        )
        .map_err(|error| database_error(&self.path, "remote target delete intent insert", error))?;
        tx.execute(
            "UPDATE remote_sessions SET state='closed',observation='lost',revision=revision+1,updated_at_ms=?2 WHERE remote_target_id=?1 AND state!='closed' AND revision<9007199254740991",
            params![id.to_string(), now_ms],
        )
        .map_err(|error| database_error(&self.path, "remote target session fence", error))?;
        tx.commit().map_err(|error| {
            database_error(&self.path, "remote target delete intent commit", error)
        })?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Completes a previously fenced deletion after exact external cleanup succeeds.
    pub fn finish_remote_target_delete_exact(
        &self,
        id: Uuid,
        idempotency_key: Uuid,
        request_hash: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "remote target delete finish", error))?;
        if let Some(outcome) =
            replay_outcome(&tx, "remote.target.delete", idempotency_key, request_hash)?
        {
            return Ok(outcome);
        }
        let pending = tx
            .query_row(
                "SELECT idempotency_key,request_hash,result_json FROM remote_target_deletions WHERE remote_target_id=?1",
                [id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target delete finish lookup", error))?;
        let Some((stored_key, stored_hash, result_json)) = pending else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        if stored_key != idempotency_key.to_string() || stored_hash != request_hash {
            return Ok(RemoteMutationOutcome::Conflict);
        }
        let enrollment_pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM remote_credential_enrollments WHERE remote_target_id=?1)",
                [id.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| database_error(&self.path, "remote target enrollment fence", error))?;
        if enrollment_pending {
            return Ok(RemoteMutationOutcome::InvalidState);
        }
        tx.execute(
            "DELETE FROM remote_sessions WHERE remote_target_id=?1",
            [id.to_string()],
        )
        .map_err(|error| database_error(&self.path, "remote target session cleanup", error))?;
        tx.execute(
            "DELETE FROM remote_target_deletions WHERE remote_target_id=?1",
            [id.to_string()],
        )
        .map_err(|error| database_error(&self.path, "remote target tombstone cleanup", error))?;
        tx.execute(
            "DELETE FROM remote_targets WHERE remote_target_id=?1",
            [id.to_string()],
        )
        .map_err(|error| database_error(&self.path, "remote target delete", error))?;
        save_remote_result(
            &tx,
            "remote.target.delete",
            idempotency_key,
            request_hash,
            &result_json,
            now_ms,
        )?;
        tx.commit().map_err(|error| {
            database_error(&self.path, "remote target delete finish commit", error)
        })?;
        Ok(RemoteMutationOutcome::Replay(result_json))
    }

    /// Reports whether a target identity is fenced by durable deletion intent.
    pub fn remote_target_delete_pending(&self, id: Uuid) -> Result<bool, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM remote_target_deletions WHERE remote_target_id=?1)",
                [id.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| database_error(&self.path, "remote target delete fence read", error))
    }

    /// Lists every durable session identity so the service can revoke live transports and leases.
    pub fn remote_session_ids_for_target(&self, id: Uuid) -> Result<Vec<Uuid>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT remote_session_id FROM remote_sessions WHERE remote_target_id=?1")
            .map_err(|error| database_error(&self.path, "remote target session list", error))?;
        statement
            .query_map([id.to_string()], |row| row.get::<_, String>(0))
            .map_err(|error| database_error(&self.path, "remote target session list", error))?
            .map(|row| {
                row.map_err(|error| database_error(&self.path, "remote target session row", error))
                    .and_then(|value| {
                        Uuid::parse_str(&value)
                            .map_err(|_| invalid("remote session identifier is invalid"))
                    })
            })
            .collect()
    }

    /// Reserves one bounded credential enrollment before the external keyring write.
    pub fn prepare_remote_credential_enrollment(
        &self,
        enrollment_id: Uuid,
        target_id: Uuid,
        expected_revision: u64,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        if enrollment_id.is_nil() || target_id.is_nil() || now_ms < 0 {
            return Err(invalid("remote credential enrollment identity is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "credential enrollment prepare", error))?;
        let deleting: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM remote_target_deletions WHERE remote_target_id=?1)",
                [target_id.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| database_error(&self.path, "credential enrollment fence", error))?;
        let revision = tx
            .query_row(
                "SELECT revision FROM remote_targets WHERE remote_target_id=?1",
                [target_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "credential enrollment target", error))?;
        let target_matches = if expected_revision == 0 {
            revision.is_none()
        } else {
            revision
                .map(|value| stored_uint(value, "target revision"))
                .transpose()?
                == Some(expected_revision)
        };
        if deleting || !target_matches {
            return Ok(false);
        }
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO remote_credential_enrollments(enrollment_id,remote_target_id,expected_revision,created_at_ms) VALUES(?1,?2,?3,?4)",
                params![enrollment_id.to_string(), target_id.to_string(), sql_int(expected_revision, "target revision")?, now_ms],
            )
            .map_err(|error| database_error(&self.path, "credential enrollment insert", error))?;
        tx.commit().map_err(|error| {
            database_error(&self.path, "credential enrollment prepare commit", error)
        })?;
        Ok(inserted == 1)
    }

    /// Commits an enrollment only while the exact target revision remains active.
    pub fn commit_remote_credential_enrollment(
        &self,
        enrollment_id: Uuid,
        target_id: Uuid,
        expected_revision: u64,
    ) -> Result<bool, StorageError> {
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "credential enrollment commit", error))?;
        let required_revision = if expected_revision == 0 {
            1
        } else {
            expected_revision
        };
        let valid: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM remote_credential_enrollments e JOIN remote_targets t ON t.remote_target_id=e.remote_target_id WHERE e.enrollment_id=?1 AND e.remote_target_id=?2 AND e.expected_revision=?3 AND t.revision=?4 AND NOT EXISTS(SELECT 1 FROM remote_target_deletions d WHERE d.remote_target_id=e.remote_target_id))",
                params![enrollment_id.to_string(), target_id.to_string(), sql_int(expected_revision, "target revision")?, sql_int(required_revision, "target revision")?],
                |row| row.get(0),
            )
            .map_err(|error| database_error(&self.path, "credential enrollment commit check", error))?;
        if !valid {
            return Ok(false);
        }
        if expected_revision != 0 {
            let exhausted: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM remote_targets t WHERE t.remote_target_id=?1 AND t.revision>=9007199254740991 UNION ALL SELECT 1 FROM remote_sessions s WHERE s.remote_target_id=?1 AND (s.revision>=9007199254740991 OR s.attempt_generation>=9007199254740991))",
                    [target_id.to_string()],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    database_error(&self.path, "credential replacement capacity", error)
                })?;
            if exhausted {
                return Ok(false);
            }
            let updated = tx
                .execute(
                    "UPDATE remote_targets SET revision=revision+1,updated_at_ms=(SELECT created_at_ms FROM remote_credential_enrollments WHERE enrollment_id=?2) WHERE remote_target_id=?1 AND revision=?3",
                    params![target_id.to_string(), enrollment_id.to_string(), sql_int(expected_revision, "target revision")?],
                )
                .map_err(|error| {
                    database_error(&self.path, "credential replacement target fence", error)
                })?;
            if updated != 1 {
                return Ok(false);
            }
            tx.execute(
                "UPDATE remote_sessions SET state=CASE WHEN state='closed' THEN 'closed' ELSE 'failed' END,observation=CASE WHEN state='closed' THEN observation ELSE 'lost' END,attempt_generation=attempt_generation+1,revision=revision+1,updated_at_ms=(SELECT created_at_ms FROM remote_credential_enrollments WHERE enrollment_id=?2) WHERE remote_target_id=?1",
                params![target_id.to_string(), enrollment_id.to_string()],
            )
            .map_err(|error| {
                database_error(&self.path, "credential replacement session fence", error)
            })?;
        }
        tx.execute(
            "DELETE FROM remote_credential_enrollments WHERE enrollment_id=?1",
            [enrollment_id.to_string()],
        )
        .map_err(|error| {
            database_error(&self.path, "credential enrollment commit delete", error)
        })?;
        tx.commit().map_err(|error| {
            database_error(
                &self.path,
                "credential enrollment commit transaction",
                error,
            )
        })?;
        Ok(true)
    }

    /// Clears one exact enrollment intent after compensation removed the keyring item.
    pub fn abort_remote_credential_enrollment(
        &self,
        enrollment_id: Uuid,
        target_id: Uuid,
    ) -> Result<(), StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM remote_credential_enrollments WHERE enrollment_id=?1 AND remote_target_id=?2",
                params![enrollment_id.to_string(), target_id.to_string()],
            )
            .map_err(|error| database_error(&self.path, "credential enrollment abort", error))?;
        Ok(())
    }

    /// Returns bounded interrupted enrollment intents for startup compensation.
    pub fn pending_remote_credential_enrollments(&self) -> Result<Vec<(Uuid, Uuid)>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT enrollment_id,remote_target_id FROM remote_credential_enrollments ORDER BY enrollment_id LIMIT 129")
            .map_err(|error| database_error(&self.path, "credential enrollment reconciliation", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| {
                database_error(&self.path, "credential enrollment reconciliation", error)
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                database_error(
                    &self.path,
                    "credential enrollment reconciliation row",
                    error,
                )
            })?;
        if rows.len() > 128 {
            return Err(invalid("remote credential enrollment capacity exceeded"));
        }
        rows.into_iter()
            .map(|(enrollment, target)| {
                Ok((
                    Uuid::parse_str(&enrollment)
                        .map_err(|_| invalid("enrollment identifier is invalid"))?,
                    Uuid::parse_str(&target)
                        .map_err(|_| invalid("target identifier is invalid"))?,
                ))
            })
            .collect()
    }

    /// Deletes an exact target revision when no durable session still references it.
    pub fn delete_remote_target_exact(
        &self,
        id: Uuid,
        expected_revision: u64,
        idempotency_key: Uuid,
        request_hash: &str,
        result_json: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_mutation(idempotency_key, request_hash, result_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "remote target delete transaction", error)
            })?;
        if let Some(outcome) =
            replay_outcome(&tx, "remote.target.delete", idempotency_key, request_hash)?
        {
            return Ok(outcome);
        }
        let Some(revision) = tx
            .query_row(
                "SELECT revision FROM remote_targets WHERE remote_target_id=?1",
                [id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target delete read", error))?
        else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        if stored_uint(revision, "target revision")? != expected_revision {
            return Ok(RemoteMutationOutcome::StaleRevision);
        }
        let dependent: i64 = tx.query_row("SELECT count(*) FROM remote_sessions WHERE remote_target_id=?1 AND state!='closed'", [id.to_string()], |row| row.get(0))
            .map_err(|error| database_error(&self.path, "remote target dependency read", error))?;
        if dependent != 0 {
            return Ok(RemoteMutationOutcome::InvalidState);
        }
        tx.execute(
            "DELETE FROM remote_sessions WHERE remote_target_id=?1",
            [id.to_string()],
        )
        .map_err(|error| database_error(&self.path, "closed remote session cleanup", error))?;
        tx.execute(
            "DELETE FROM remote_targets WHERE remote_target_id=?1",
            [id.to_string()],
        )
        .map_err(|error| database_error(&self.path, "remote target delete", error))?;
        save_remote_result(
            &tx,
            "remote.target.delete",
            idempotency_key,
            request_hash,
            result_json,
            now_ms,
        )?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "remote target delete commit", error))?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Loads one durable remote-session intent.
    pub fn load_remote_session(
        &self,
        id: Uuid,
    ) -> Result<Option<RemoteSessionRecord>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .query_row(
                &format!(
                    "SELECT {SESSION_COLUMNS} FROM remote_sessions WHERE remote_session_id=?1"
                ),
                [id.to_string()],
                session_from_row,
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote session read", error))
    }

    /// Lists remote sessions in stable UUID order.
    pub fn list_remote_sessions(
        &self,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<(Vec<RemoteSessionRecord>, Option<Uuid>), StorageError> {
        if !(1..=128).contains(&limit) {
            return Err(invalid("remote session page limit is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!("SELECT {SESSION_COLUMNS} FROM remote_sessions WHERE remote_session_id>?1 ORDER BY remote_session_id LIMIT ?2"))
            .map_err(|error| database_error(&self.path, "remote session list prepare", error))?;
        let rows = statement
            .query_map(
                params![
                    cursor.map_or_else(String::new, |value| value.to_string()),
                    i64::from(limit) + 1
                ],
                session_from_row,
            )
            .map_err(|error| database_error(&self.path, "remote session list", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| database_error(&self.path, "remote session list row", error))?;
        Ok(page(rows, usize::from(limit), |record| {
            record.remote_session_id
        }))
    }

    /// Creates durable connection intent and its exact initial response atomically.
    pub fn create_remote_session_exact(
        &self,
        record: &RemoteSessionRecord,
        result_json: &str,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_session(record)?;
        validate_result(result_json)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "remote session exact transaction", error)
            })?;
        if let Some(outcome) = replay_outcome(
            &tx,
            "remote.session.connect",
            record.idempotency_key,
            &record.request_hash,
        )? {
            return Ok(outcome);
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM remote_sessions", [], |row| row.get(0))
            .map_err(|error| database_error(&self.path, "remote session exact count", error))?;
        if count >= MAX_REMOTE_SESSIONS_I64 {
            return Ok(RemoteMutationOutcome::ResourceLimit);
        }
        let target_exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM remote_targets WHERE remote_target_id=?1)",
                [record.remote_target_id.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| database_error(&self.path, "remote session target lookup", error))?;
        if !target_exists {
            return Ok(RemoteMutationOutcome::NotFound);
        }
        if tx
            .query_row(
                "SELECT 1 FROM remote_sessions WHERE remote_session_id=?1",
                [record.remote_session_id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote session identity lookup", error))?
            .is_some()
        {
            return Ok(RemoteMutationOutcome::InvalidState);
        }
        insert_session(&tx, record, &self.path)?;
        save_remote_result(
            &tx,
            "remote.session.connect",
            record.idempotency_key,
            &record.request_hash,
            result_json,
            record.created_at_ms,
        )?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "remote session exact commit", error))?;
        Ok(RemoteMutationOutcome::Applied)
    }
    pub fn create_remote_target(
        &self,
        record: &RemoteTargetRecord,
    ) -> Result<RemoteCreateOutcome, StorageError> {
        validate_target(record)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| database_error(&self.path, "remote target transaction", e))?;
        if let Some(hash) = tx
            .query_row(
                "SELECT request_hash FROM remote_targets WHERE idempotency_key=?1",
                [record.idempotency_key.to_string()],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| database_error(&self.path, "remote target idempotency lookup", e))?
        {
            return Ok(if hash == record.request_hash {
                RemoteCreateOutcome::Replay
            } else {
                RemoteCreateOutcome::Conflict
            });
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM remote_targets", [], |r| r.get(0))
            .map_err(|e| database_error(&self.path, "remote target count", e))?;
        if count >= MAX_REMOTE_TARGETS_I64 {
            return Ok(RemoteCreateOutcome::LimitReached);
        }
        let known_hosts_version = sql_int(record.known_hosts_version, "known-hosts version")?;
        let revision = sql_int(record.revision, "target revision")?;
        tx.execute("INSERT INTO remote_targets(remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",params![record.remote_target_id.to_string(),record.label,record.host,record.port,record.user,record.host_key_state,known_hosts_version,revision,record.idempotency_key.to_string(),record.request_hash,record.created_at_ms]).map_err(|e|database_error(&self.path,"remote target insert",e))?;
        tx.commit()
            .map_err(|e| database_error(&self.path, "remote target commit", e))?;
        secure_database_artifacts(&self.path)?;
        Ok(RemoteCreateOutcome::Created)
    }
    pub fn create_remote_session(
        &self,
        record: &RemoteSessionRecord,
    ) -> Result<RemoteCreateOutcome, StorageError> {
        validate_session(record)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| database_error(&self.path, "remote session transaction", e))?;
        if let Some(hash) = tx
            .query_row(
                "SELECT request_hash FROM remote_sessions WHERE idempotency_key=?1",
                [record.idempotency_key.to_string()],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| database_error(&self.path, "remote session idempotency lookup", e))?
        {
            return Ok(if hash == record.request_hash {
                RemoteCreateOutcome::Replay
            } else {
                RemoteCreateOutcome::Conflict
            });
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM remote_sessions", [], |r| r.get(0))
            .map_err(|e| database_error(&self.path, "remote session count", e))?;
        if count >= MAX_REMOTE_SESSIONS_I64 {
            return Ok(RemoteCreateOutcome::LimitReached);
        }
        let attempt_generation = sql_int(record.attempt_generation, "attempt generation")?;
        let revision = sql_int(record.revision, "session revision")?;
        tx.execute("INSERT INTO remote_sessions(remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,reconnect_max_delay_ms,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17)",params![record.remote_session_id.to_string(),record.remote_target_id.to_string(),record.workspace_id.to_string(),record.pane_id.to_string(),record.tab_id.to_string(),record.tmux_mode,record.tmux_name,record.state.as_str(),record.observation,attempt_generation,record.reconnect_max_attempts,record.reconnect_initial_delay_ms,record.reconnect_max_delay_ms,revision,record.idempotency_key.to_string(),record.request_hash,record.created_at_ms]).map_err(|e|database_error(&self.path,"remote session insert",e))?;
        tx.commit()
            .map_err(|e| database_error(&self.path, "remote session commit", e))?;
        secure_database_artifacts(&self.path)?;
        Ok(RemoteCreateOutcome::Created)
    }
    pub fn transition_remote_session(
        &self,
        id: Uuid,
        expected_revision: u64,
        expected_generation: u64,
        next: RemoteSessionStateRecord,
        observation: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        if !matches!(observation, "unknown" | "lastVerified" | "lost") {
            return Err(invalid("remote observation is invalid"));
        }
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| database_error(&self.path, "remote transition transaction", e))?;
        let current=tx.query_row("SELECT state,revision,attempt_generation FROM remote_sessions WHERE remote_session_id=?1",[id.to_string()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?))).optional().map_err(|e|database_error(&self.path,"remote transition read",e))?;
        let Some((state, stored_revision, stored_generation)) = current else {
            return Ok(false);
        };
        let revision = stored_uint(stored_revision, "stored session revision")?;
        let generation = stored_uint(stored_generation, "stored attempt generation")?;
        let current = parse_state(&state)?;
        if revision != expected_revision
            || generation != expected_generation
            || !current.can_transition(next)
        {
            return Ok(false);
        }
        let expected_revision_sql = sql_int(expected_revision, "expected revision")?;
        let expected_generation_sql = sql_int(expected_generation, "expected generation")?;
        let changed=tx.execute("UPDATE remote_sessions SET state=?2,observation=?3,revision=revision+1,updated_at_ms=?4 WHERE remote_session_id=?1 AND revision=?5 AND attempt_generation=?6",params![id.to_string(),next.as_str(),observation,now_ms,expected_revision_sql,expected_generation_sql]).map_err(|e|database_error(&self.path,"remote transition update",e))?;
        tx.commit()
            .map_err(|e| database_error(&self.path, "remote transition commit", e))?;
        Ok(changed == 1)
    }

    /// Commits a lifecycle transition and exact terminal result before any caller side effect.
    #[allow(clippy::too_many_arguments)]
    pub fn mutate_remote_session_exact(
        &self,
        namespace: &str,
        id: Uuid,
        expected_revision: u64,
        expected_generation: u64,
        next: RemoteSessionStateRecord,
        observation: &str,
        increment_generation: bool,
        idempotency_key: Uuid,
        request_hash: &str,
        result_json: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_namespace(namespace)?;
        validate_mutation(idempotency_key, request_hash, result_json, now_ms)?;
        if !matches!(observation, "unknown" | "lastVerified" | "lost") {
            return Err(invalid("remote observation is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "remote session mutation transaction", error)
            })?;
        if let Some(outcome) = replay_outcome(&tx, namespace, idempotency_key, request_hash)? {
            return Ok(outcome);
        }
        let Some((state, revision, generation)) = tx.query_row(
            "SELECT state,revision,attempt_generation FROM remote_sessions WHERE remote_session_id=?1",
            [id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        ).optional().map_err(|error| database_error(&self.path, "remote session mutation read", error))? else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        let revision = stored_uint(revision, "session revision")?;
        let generation = stored_uint(generation, "attempt generation")?;
        if revision != expected_revision || generation != expected_generation {
            return Ok(RemoteMutationOutcome::StaleRevision);
        }
        if !parse_state(&state)?.can_transition(next) {
            return Ok(RemoteMutationOutcome::InvalidState);
        }
        let next_generation = if increment_generation {
            generation
                .checked_add(1)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("attempt generation exhausted"))?
        } else {
            generation
        };
        tx.execute(
            "UPDATE remote_sessions SET state=?2,observation=?3,attempt_generation=?4,revision=revision+1,updated_at_ms=?5 WHERE remote_session_id=?1",
            params![id.to_string(), next.as_str(), observation, sql_int(next_generation, "attempt generation")?, now_ms],
        ).map_err(|error| database_error(&self.path, "remote session mutation update", error))?;
        save_remote_result(
            &tx,
            namespace,
            idempotency_key,
            request_hash,
            result_json,
            now_ms,
        )?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "remote session mutation commit", error))?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Updates exact host-key trust state and known-hosts version with revision CAS.
    #[allow(clippy::too_many_arguments)]
    pub fn mutate_remote_target_trust_exact(
        &self,
        id: Uuid,
        expected_revision: u64,
        next_state: &str,
        next_known_hosts_version: u64,
        idempotency_key: Uuid,
        request_hash: &str,
        result_json: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        if !matches!(next_state, "trusted" | "untrusted" | "changed" | "revoked")
            || next_known_hosts_version == 0
        {
            return Err(invalid("remote host-key state is invalid"));
        }
        validate_mutation(idempotency_key, request_hash, result_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "remote trust transaction", error))?;
        if let Some((stored_hash, stored_result)) =
            raw_replay(&tx, "remote.hostKey.decide", idempotency_key)?
        {
            if stored_hash != request_hash {
                return Ok(RemoteMutationOutcome::Conflict);
            }
            if stored_result.as_deref() != Some("{\"remoteOperation\":\"pending\"}") {
                return Ok(stored_result.map_or(
                    RemoteMutationOutcome::InvalidState,
                    RemoteMutationOutcome::Replay,
                ));
            }
        }
        let Some(revision) = tx
            .query_row(
                "SELECT revision FROM remote_targets WHERE remote_target_id=?1",
                [id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote trust target read", error))?
        else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        if stored_uint(revision, "target revision")? != expected_revision {
            return Ok(RemoteMutationOutcome::StaleRevision);
        }
        tx.execute("UPDATE remote_targets SET host_key_state=?2,known_hosts_version=?3,revision=revision+1,updated_at_ms=?4 WHERE remote_target_id=?1", params![id.to_string(), next_state, sql_int(next_known_hosts_version, "known-hosts version")?, now_ms])
            .map_err(|error| database_error(&self.path, "remote trust target update", error))?;
        let changed = tx.execute("UPDATE idempotency_results SET result_json=?4,completed_at_ms=?5 WHERE namespace='remote.hostKey.decide' AND epoch=?1 AND idempotency_key=?2 AND request_hash=?3", params![LEGACY_IDEMPOTENCY_EPOCH, idempotency_key.to_string(), request_hash, result_json, now_ms])
            .map_err(|error| database_error(&self.path, "remote trust exact-result update", error))?;
        if changed != 1 {
            save_remote_result(
                &tx,
                "remote.hostKey.decide",
                idempotency_key,
                request_hash,
                result_json,
                now_ms,
            )?;
        }
        tx.commit()
            .map_err(|error| database_error(&self.path, "remote trust commit", error))?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Reconciles process-local transport state after restart without inventing remote health.
    pub fn reconcile_remote_sessions_after_restart(
        &self,
        now_ms: i64,
    ) -> Result<usize, StorageError> {
        if now_ms < 0 {
            return Err(invalid("restart timestamp is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(
                    &self.path,
                    "remote restart reconciliation transaction",
                    error,
                )
            })?;
        let changed = tx.execute(
            "UPDATE remote_sessions SET state='detached',observation='unknown',attempt_generation=attempt_generation+1,revision=revision+1,updated_at_ms=?1 WHERE state IN ('connecting','connected','reconnecting') AND attempt_generation<9007199254740991 AND revision<9007199254740991",
            [now_ms],
        ).map_err(|error| database_error(&self.path, "remote restart reconciliation", error))?;
        tx.commit().map_err(|error| {
            database_error(&self.path, "remote restart reconciliation commit", error)
        })?;
        Ok(changed)
    }

    /// Fences a local SSH exit to one attempt and preserves unknown remote-process health.
    pub fn record_remote_transport_exit(
        &self,
        id: Uuid,
        attempt_generation: u64,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        if attempt_generation == 0 || now_ms < 0 {
            return Err(invalid("remote exit fence is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_sessions SET state=CASE WHEN state='connected' AND reconnect_max_attempts>0 THEN 'reconnecting' WHEN state='connected' THEN 'detached' ELSE 'failed' END,observation=CASE WHEN state='connected' THEN 'lost' ELSE 'unknown' END,revision=revision+1,updated_at_ms=?3 WHERE remote_session_id=?1 AND attempt_generation=?2 AND state IN ('connecting','connected','reconnecting')",
            params![id.to_string(), sql_int(attempt_generation, "attempt generation")?, now_ms],
        ).map_err(|error| database_error(&self.path, "remote transport exit fence", error))?;
        Ok(changed == 1)
    }

    /// Persists a generation-fenced automatic reconnect attempt before launching SSH.
    pub fn begin_remote_reconnect_attempt(
        &self,
        id: Uuid,
        expected_revision: u64,
        expected_generation: u64,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        if expected_revision == 0 || expected_generation == 0 || now_ms < 0 {
            return Err(invalid("automatic reconnect fence is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE remote_sessions SET attempt_generation=attempt_generation+1,revision=revision+1,updated_at_ms=?4 WHERE remote_session_id=?1 AND state='reconnecting' AND revision=?2 AND attempt_generation=?3 AND revision<9007199254740991 AND attempt_generation<9007199254740991",
                params![
                    id.to_string(),
                    sql_int(expected_revision, "automatic reconnect revision")?,
                    sql_int(expected_generation, "automatic reconnect generation")?,
                    now_ms
                ],
            )
            .map_err(|error| database_error(&self.path, "automatic reconnect intent", error))?;
        Ok(changed == 1)
    }

    /// Fences a detected trusted host-key mismatch into a durable changed state.
    pub fn mark_remote_target_host_key_changed(
        &self,
        id: Uuid,
        expected_revision: u64,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        if expected_revision == 0 || now_ms < 0 {
            return Err(invalid("host-key change fence is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE remote_targets SET host_key_state='changed',revision=revision+1,updated_at_ms=?3 WHERE remote_target_id=?1 AND revision=?2 AND host_key_state='trusted'",
                params![
                    id.to_string(),
                    sql_int(expected_revision, "host-key change revision")?,
                    now_ms
                ],
            )
            .map_err(|error| database_error(&self.path, "host-key change fence", error))?;
        Ok(changed == 1)
    }

    /// Atomically records the terminal outcome of a previously persisted remote attempt.
    #[allow(clippy::too_many_arguments)]
    pub fn complete_remote_session_attempt(
        &self,
        namespace: &str,
        id: Uuid,
        expected_revision: u64,
        expected_generation: u64,
        next: RemoteSessionStateRecord,
        observation: &str,
        idempotency_key: Uuid,
        request_hash: &str,
        result_json: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        validate_namespace(namespace)?;
        validate_mutation(idempotency_key, request_hash, result_json, now_ms)?;
        if !matches!(observation, "unknown" | "lastVerified" | "lost") {
            return Err(invalid("remote observation is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "remote attempt completion transaction", error)
            })?;
        let Some((state, revision, generation)) = tx.query_row("SELECT state,revision,attempt_generation FROM remote_sessions WHERE remote_session_id=?1", [id.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))).optional()
            .map_err(|error| database_error(&self.path, "remote attempt completion read", error))? else { return Ok(false); };
        if stored_uint(revision, "session revision")? != expected_revision
            || stored_uint(generation, "attempt generation")? != expected_generation
            || !parse_state(&state)?.can_transition(next)
        {
            return Ok(false);
        }
        tx.execute("UPDATE remote_sessions SET state=?2,observation=?3,revision=revision+1,updated_at_ms=?4 WHERE remote_session_id=?1", params![id.to_string(), next.as_str(), observation, now_ms])
            .map_err(|error| database_error(&self.path, "remote attempt completion update", error))?;
        let changed = tx.execute("UPDATE idempotency_results SET result_json=?4,completed_at_ms=?5 WHERE namespace=?1 AND epoch=?2 AND idempotency_key=?3 AND request_hash=?6", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, idempotency_key.to_string(), result_json, now_ms, request_hash])
            .map_err(|error| database_error(&self.path, "remote attempt exact-result completion", error))?;
        if changed != 1 {
            return Err(invalid("remote attempt result identity is missing"));
        }
        tx.commit().map_err(|error| {
            database_error(&self.path, "remote attempt completion commit", error)
        })?;
        Ok(true)
    }

    /// Persists a non-lifecycle remote operation before dispatching its external side effect.
    #[allow(clippy::too_many_arguments)]
    pub fn reserve_remote_session_operation(
        &self,
        namespace: &str,
        id: Uuid,
        expected_revision: u64,
        idempotency_key: Uuid,
        request_hash: &str,
        pending_json: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_namespace(namespace)?;
        validate_mutation(idempotency_key, request_hash, pending_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(
                    &self.path,
                    "remote operation reservation transaction",
                    error,
                )
            })?;
        if let Some(outcome) = replay_outcome(&tx, namespace, idempotency_key, request_hash)? {
            return Ok(outcome);
        }
        let Some(revision) = tx
            .query_row(
                "SELECT revision FROM remote_sessions WHERE remote_session_id=?1",
                [id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote operation session read", error))?
        else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        if stored_uint(revision, "session revision")? != expected_revision {
            return Ok(RemoteMutationOutcome::StaleRevision);
        }
        save_remote_result(
            &tx,
            namespace,
            idempotency_key,
            request_hash,
            pending_json,
            now_ms,
        )?;
        tx.commit().map_err(|error| {
            database_error(&self.path, "remote operation reservation commit", error)
        })?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Persists target-bound trust intent before invoking a host-key authority.
    #[allow(clippy::too_many_arguments)]
    pub fn reserve_remote_target_operation(
        &self,
        namespace: &str,
        id: Uuid,
        expected_revision: u64,
        idempotency_key: Uuid,
        request_hash: &str,
        pending_json: &str,
        now_ms: i64,
    ) -> Result<RemoteMutationOutcome, StorageError> {
        validate_namespace(namespace)?;
        validate_mutation(idempotency_key, request_hash, pending_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(
                    &self.path,
                    "remote target operation reservation transaction",
                    error,
                )
            })?;
        if let Some(outcome) = replay_outcome(&tx, namespace, idempotency_key, request_hash)? {
            return Ok(outcome);
        }
        let Some(revision) = tx
            .query_row(
                "SELECT revision FROM remote_targets WHERE remote_target_id=?1",
                [id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "remote target operation read", error))?
        else {
            return Ok(RemoteMutationOutcome::NotFound);
        };
        if stored_uint(revision, "target revision")? != expected_revision {
            return Ok(RemoteMutationOutcome::StaleRevision);
        }
        save_remote_result(
            &tx,
            namespace,
            idempotency_key,
            request_hash,
            pending_json,
            now_ms,
        )?;
        tx.commit().map_err(|error| {
            database_error(
                &self.path,
                "remote target operation reservation commit",
                error,
            )
        })?;
        Ok(RemoteMutationOutcome::Applied)
    }

    /// Replaces a pending remote-operation marker with its exact bounded terminal result.
    pub fn complete_remote_operation_result(
        &self,
        namespace: &str,
        idempotency_key: Uuid,
        request_hash: &str,
        result_json: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        validate_namespace(namespace)?;
        validate_mutation(idempotency_key, request_hash, result_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let changed = connection.execute("UPDATE idempotency_results SET result_json=?4,completed_at_ms=?5 WHERE namespace=?1 AND epoch=?2 AND idempotency_key=?3 AND request_hash=?6", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, idempotency_key.to_string(), result_json, now_ms, request_hash])
            .map_err(|error| database_error(&self.path, "remote operation result completion", error))?;
        Ok(changed == 1)
    }
}

const TARGET_COLUMNS: &str = "remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision,idempotency_key,request_hash,created_at_ms";
const SESSION_COLUMNS: &str = "remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,reconnect_max_delay_ms,revision,idempotency_key,request_hash,created_at_ms";

fn target_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteTargetRecord> {
    Ok(RemoteTargetRecord {
        remote_target_id: parse_uuid_sql(&row.get::<_, String>(0)?)?,
        label: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        user: row.get(4)?,
        host_key_state: row.get(5)?,
        known_hosts_version: stored_uint_sql(row.get(6)?)?,
        revision: stored_uint_sql(row.get(7)?)?,
        idempotency_key: parse_uuid_sql(&row.get::<_, String>(8)?)?,
        request_hash: row.get(9)?,
        created_at_ms: row.get(10)?,
    })
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteSessionRecord> {
    let state = row.get::<_, String>(7)?;
    Ok(RemoteSessionRecord {
        remote_session_id: parse_uuid_sql(&row.get::<_, String>(0)?)?,
        remote_target_id: parse_uuid_sql(&row.get::<_, String>(1)?)?,
        workspace_id: parse_uuid_sql(&row.get::<_, String>(2)?)?,
        pane_id: parse_uuid_sql(&row.get::<_, String>(3)?)?,
        tab_id: parse_uuid_sql(&row.get::<_, String>(4)?)?,
        tmux_mode: row.get(5)?,
        tmux_name: row.get(6)?,
        state: parse_state_sql(&state)?,
        observation: row.get(8)?,
        attempt_generation: stored_uint_sql(row.get(9)?)?,
        reconnect_max_attempts: row.get(10)?,
        reconnect_initial_delay_ms: row.get(11)?,
        reconnect_max_delay_ms: row.get(12)?,
        revision: stored_uint_sql(row.get(13)?)?,
        idempotency_key: parse_uuid_sql(&row.get::<_, String>(14)?)?,
        request_hash: row.get(15)?,
        created_at_ms: row.get(16)?,
    })
}

fn parse_uuid_sql(value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
fn stored_uint_sql(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value)
        .ok()
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| rusqlite::Error::IntegralValueOutOfRange(0, value))
}
fn parse_state_sql(value: &str) -> rusqlite::Result<RemoteSessionStateRecord> {
    parse_state(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
fn page<T>(mut rows: Vec<T>, limit: usize, id: impl Fn(&T) -> Uuid) -> (Vec<T>, Option<Uuid>) {
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = has_more.then(|| id(rows.last().expect("a nonzero page limit has a last row")));
    (rows, cursor)
}

fn insert_target(
    tx: &Transaction<'_>,
    record: &RemoteTargetRecord,
    path: &Path,
) -> Result<(), StorageError> {
    tx.execute("INSERT INTO remote_targets(remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![record.remote_target_id.to_string(),record.label,record.host,record.port,record.user,record.host_key_state,sql_int(record.known_hosts_version,"known-hosts version")?,sql_int(record.revision,"target revision")?,record.idempotency_key.to_string(),record.request_hash,record.created_at_ms])
        .map_err(|error| database_error(path, "remote target exact insert", error))?;
    Ok(())
}
fn insert_session(
    tx: &Transaction<'_>,
    record: &RemoteSessionRecord,
    path: &Path,
) -> Result<(), StorageError> {
    tx.execute("INSERT INTO remote_sessions(remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,reconnect_max_delay_ms,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17)",params![record.remote_session_id.to_string(),record.remote_target_id.to_string(),record.workspace_id.to_string(),record.pane_id.to_string(),record.tab_id.to_string(),record.tmux_mode,record.tmux_name,record.state.as_str(),record.observation,sql_int(record.attempt_generation,"attempt generation")?,record.reconnect_max_attempts,record.reconnect_initial_delay_ms,record.reconnect_max_delay_ms,sql_int(record.revision,"session revision")?,record.idempotency_key.to_string(),record.request_hash,record.created_at_ms])
        .map_err(|error| database_error(path, "remote session exact insert", error))?;
    Ok(())
}

fn replay_outcome(
    tx: &Transaction<'_>,
    namespace: &str,
    key: Uuid,
    hash: &str,
) -> Result<Option<RemoteMutationOutcome>, StorageError> {
    let stored = raw_replay(tx, namespace, key)?;
    Ok(stored.map(|(stored_hash, result)| {
        if stored_hash != hash {
            RemoteMutationOutcome::Conflict
        } else if let Some(result) = result {
            RemoteMutationOutcome::Replay(result)
        } else {
            RemoteMutationOutcome::InvalidState
        }
    }))
}
fn raw_replay(
    tx: &Transaction<'_>,
    namespace: &str,
    key: Uuid,
) -> Result<Option<(String, Option<String>)>, StorageError> {
    tx.query_row("SELECT request_hash,result_json FROM idempotency_results WHERE namespace=?1 AND epoch=?2 AND idempotency_key=?3", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, key.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).optional()
        .map_err(|error| database_error(Path::new("remote_sessions"), "remote idempotency read", error))
}
fn save_remote_result(
    tx: &Transaction<'_>,
    namespace: &str,
    key: Uuid,
    hash: &str,
    result: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    tx.execute("INSERT INTO idempotency_results(namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms) VALUES(?1,?2,?3,?4,?5,?6)", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, key.to_string(), hash, result, now_ms])
        .map_err(|error| database_error(Path::new("remote_sessions"), "remote idempotency insert", error))?;
    Ok(())
}
fn validate_namespace(value: &str) -> Result<(), StorageError> {
    const ALLOWED: &[&str] = &[
        "remote.target.delete",
        "remote.session.connect",
        "remote.session.detach",
        "remote.session.reconnect",
        "remote.session.close",
        "remote.tmux.discover",
        "remote.hostKey.reject",
        "remote.hostKey.decide",
    ];
    ALLOWED
        .contains(&value)
        .then_some(())
        .ok_or_else(|| invalid("remote mutation namespace is invalid"))
}
fn validate_result(value: &str) -> Result<(), StorageError> {
    if value.is_empty()
        || value.len() > 64 * 1024
        || serde_json::from_str::<serde_json::Value>(value).is_err()
    {
        return Err(invalid("remote mutation result is invalid"));
    }
    Ok(())
}
fn validate_mutation(key: Uuid, hash: &str, result: &str, now_ms: i64) -> Result<(), StorageError> {
    if key.is_nil() || !valid_hash(hash) || now_ms < 0 {
        return Err(invalid("remote mutation identity is invalid"));
    }
    validate_result(result)
}

fn parse_state(v: &str) -> Result<RemoteSessionStateRecord, StorageError> {
    match v {
        "created" => Ok(RemoteSessionStateRecord::Created),
        "trustRequired" => Ok(RemoteSessionStateRecord::TrustRequired),
        "credentialRequired" => Ok(RemoteSessionStateRecord::CredentialRequired),
        "connecting" => Ok(RemoteSessionStateRecord::Connecting),
        "connected" => Ok(RemoteSessionStateRecord::Connected),
        "reconnecting" => Ok(RemoteSessionStateRecord::Reconnecting),
        "detached" => Ok(RemoteSessionStateRecord::Detached),
        "failed" => Ok(RemoteSessionStateRecord::Failed),
        "closed" => Ok(RemoteSessionStateRecord::Closed),
        _ => Err(invalid("stored state is not closed")),
    }
}
fn invalid(message: &str) -> StorageError {
    StorageError::InvalidRemoteSession {
        message: message.into(),
    }
}
fn sql_int(value: u64, field: &str) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| invalid(&format!("{field} exceeds SQLite integer range")))
}
fn stored_uint(value: i64, field: &str) -> Result<u64, StorageError> {
    let value = u64::try_from(value).map_err(|_| invalid(&format!("{field} is negative")))?;
    if value == 0 || value > MAX_SAFE_INTEGER {
        return Err(invalid(&format!(
            "{field} is outside the safe integer range"
        )));
    }
    Ok(value)
}
fn parse_uuid(value: &str) -> Result<Uuid, StorageError> {
    Uuid::parse_str(value).map_err(|_| invalid("stored remote UUID is malformed"))
}
fn valid_hash(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn validate_target(r: &RemoteTargetRecord) -> Result<(), StorageError> {
    if r.label.is_empty()
        || r.label.chars().count() > 128
        || r.label.chars().any(char::is_control)
        || r.host.is_empty()
        || r.host.len() > 253
        || r.host != r.host.to_ascii_lowercase()
        || r.host.starts_with('-')
        || r.host.chars().any(|c| c.is_control() || c.is_whitespace())
        || r.user.is_empty()
        || r.user.len() > 64
        || r.user.starts_with('-')
        || r.user.chars().any(|c| c.is_control() || c.is_whitespace())
        || r.port == 0
        || !matches!(
            r.host_key_state.as_str(),
            "untrusted" | "trusted" | "changed" | "revoked"
        )
        || r.known_hosts_version == 0
        || r.revision == 0
        || r.revision > MAX_SAFE_INTEGER
        || !valid_hash(&r.request_hash)
        || r.created_at_ms < 0
    {
        return Err(invalid("target fields violate bounds"));
    }
    Ok(())
}
fn validate_session(r: &RemoteSessionRecord) -> Result<(), StorageError> {
    let tmux_ok = match (&r.tmux_mode, &r.tmux_name) {
        (None, None) => true,
        (Some(mode), Some(name)) => {
            matches!(mode.as_str(), "attach" | "create")
                && !name.is_empty()
                && name.len() <= 64
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        }
        _ => false,
    };
    if !tmux_ok
        || !matches!(r.observation.as_str(), "unknown" | "lastVerified" | "lost")
        || r.attempt_generation == 0
        || r.attempt_generation > MAX_SAFE_INTEGER
        || r.revision == 0
        || r.revision > MAX_SAFE_INTEGER
        || r.reconnect_max_attempts > 10
        || r.reconnect_initial_delay_ms < 100
        || r.reconnect_initial_delay_ms > 60_000
        || r.reconnect_max_delay_ms < r.reconnect_initial_delay_ms
        || r.reconnect_max_delay_ms > 300_000
        || !valid_hash(&r.request_hash)
        || r.created_at_ms < 0
    {
        return Err(invalid("session fields violate bounds"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_core::ShortcutPlatform;
    use tempfile::tempdir;
    #[test]
    fn v10_is_private_bounded_and_idempotent() {
        let d = tempdir().unwrap();
        let s =
            SqliteStateStore::open(d.path().join("state.db"), ShortcutPlatform::NonMacOs).unwrap();
        assert_eq!(s.schema_version().unwrap(), crate::SCHEMA_VERSION);
        let r = RemoteTargetRecord {
            remote_target_id: Uuid::new_v4(),
            label: "dev".into(),
            host: "example.com".into(),
            port: 22,
            user: "alice".into(),
            host_key_state: "untrusted".into(),
            known_hosts_version: 1,
            revision: 1,
            idempotency_key: Uuid::new_v4(),
            request_hash: "a".repeat(64),
            created_at_ms: 1,
        };
        assert_eq!(
            s.create_remote_target(&r).unwrap(),
            RemoteCreateOutcome::Created
        );
        assert_eq!(
            s.create_remote_target(&r).unwrap(),
            RemoteCreateOutcome::Replay
        );
        let columns = {
            let c = s.lock().unwrap();
            c.prepare("PRAGMA table_info(remote_targets)")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(!columns.iter().any(|c| {
            [
                "credential",
                "private_key",
                "agent_socket",
                "proxy",
                "ssh_options",
            ]
            .contains(&c.as_str())
        }));
    }

    fn target(seed: u128, key: u128) -> RemoteTargetRecord {
        RemoteTargetRecord {
            remote_target_id: Uuid::from_u128(seed),
            label: format!("target-{seed}"),
            host: format!("host-{seed}.example"),
            port: 22,
            user: "alice".into(),
            host_key_state: "trusted".into(),
            known_hosts_version: 1,
            revision: 1,
            idempotency_key: Uuid::from_u128(key),
            request_hash: format!("{seed:064x}"),
            created_at_ms: i64::try_from(seed).unwrap(),
        }
    }
    fn session(target_id: Uuid, key: u128) -> RemoteSessionRecord {
        RemoteSessionRecord {
            remote_session_id: Uuid::from_u128(key + 100),
            remote_target_id: target_id,
            workspace_id: Uuid::from_u128(1000),
            pane_id: Uuid::from_u128(1001),
            tab_id: Uuid::from_u128(1002),
            tmux_mode: Some("attach".into()),
            tmux_name: Some("work".into()),
            state: RemoteSessionStateRecord::Connecting,
            observation: "unknown".into(),
            attempt_generation: 1,
            reconnect_max_attempts: 3,
            reconnect_initial_delay_ms: 500,
            reconnect_max_delay_ms: 5_000,
            revision: 1,
            idempotency_key: Uuid::from_u128(key),
            request_hash: format!("{key:064x}"),
            created_at_ms: 10,
        }
    }

    #[test]
    fn uuid_pagination_and_exact_remote_replay_are_durable() {
        let dir = tempdir().unwrap();
        let store = SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
            .unwrap();
        for seed in 1..=3 {
            let record = target(seed, seed + 10);
            let result = format!("{{\"target\":{seed}}}");
            assert_eq!(
                store.create_remote_target_exact(&record, &result).unwrap(),
                RemoteMutationOutcome::Applied
            );
            assert_eq!(
                store.create_remote_target_exact(&record, &result).unwrap(),
                RemoteMutationOutcome::Replay(result)
            );
        }
        let (first, cursor) = store.list_remote_targets(None, 2).unwrap();
        assert_eq!(
            first
                .iter()
                .map(|row| row.remote_target_id)
                .collect::<Vec<_>>(),
            vec![Uuid::from_u128(1), Uuid::from_u128(2)]
        );
        let (second, next) = store.list_remote_targets(cursor, 2).unwrap();
        assert_eq!(second[0].remote_target_id, Uuid::from_u128(3));
        assert!(next.is_none());
        let mut conflicting = target(1, 11);
        conflicting.request_hash = "f".repeat(64);
        assert_eq!(
            store
                .create_remote_target_exact(&conflicting, "{}")
                .unwrap(),
            RemoteMutationOutcome::Conflict
        );
    }

    #[test]
    fn pending_connect_completes_once_and_restart_fences_local_transport() {
        let dir = tempdir().unwrap();
        let store = SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
            .unwrap();
        let target = target(1, 11);
        store.create_remote_target_exact(&target, "{}").unwrap();
        let session = session(target.remote_target_id, 21);
        let pending = "{\"remoteOperation\":\"pending\"}";
        assert_eq!(
            store
                .create_remote_session_exact(&session, pending)
                .unwrap(),
            RemoteMutationOutcome::Applied
        );
        let result = "{\"session\":\"connected\"}";
        assert!(
            store
                .complete_remote_session_attempt(
                    "remote.session.connect",
                    session.remote_session_id,
                    1,
                    1,
                    RemoteSessionStateRecord::Connected,
                    "unknown",
                    session.idempotency_key,
                    &session.request_hash,
                    result,
                    200,
                )
                .unwrap()
        );
        assert_eq!(
            store
                .create_remote_session_exact(&session, pending)
                .unwrap(),
            RemoteMutationOutcome::Replay(result.into())
        );
        assert!(
            store
                .record_remote_transport_exit(session.remote_session_id, 1, 21)
                .unwrap()
        );
        let reconnecting = store
            .load_remote_session(session.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(reconnecting.state, RemoteSessionStateRecord::Reconnecting);
        assert_eq!(reconnecting.observation, "lost");
        assert!(
            store
                .begin_remote_reconnect_attempt(
                    session.remote_session_id,
                    reconnecting.revision,
                    reconnecting.attempt_generation,
                    22,
                )
                .unwrap()
        );
        let retry = store
            .load_remote_session(session.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            retry.attempt_generation,
            reconnecting.attempt_generation + 1
        );
        assert!(
            !store
                .record_remote_transport_exit(session.remote_session_id, 1, 23)
                .unwrap()
        );
    }

    #[test]
    fn durable_delete_fences_sessions_blocks_reuse_and_replays_after_cleanup() {
        let dir = tempdir().unwrap();
        let store = SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
            .unwrap();
        let target = target(41, 51);
        let session = session(target.remote_target_id, 61);
        store.create_remote_target_exact(&target, "{}").unwrap();
        store
            .create_remote_session_exact(&session, "{\"pending\":true}")
            .unwrap();
        let delete_key = Uuid::from_u128(71);
        let delete_hash = "d".repeat(64);
        let result = "{\"deleted\":true}";

        assert_eq!(
            store
                .begin_remote_target_delete_exact(
                    target.remote_target_id,
                    target.revision,
                    delete_key,
                    &delete_hash,
                    result,
                    20,
                )
                .unwrap(),
            RemoteMutationOutcome::Applied
        );
        assert!(
            store
                .remote_target_delete_pending(target.remote_target_id)
                .unwrap()
        );
        let fenced = store
            .load_remote_session(session.remote_session_id)
            .unwrap()
            .unwrap();
        assert_eq!(fenced.state, RemoteSessionStateRecord::Closed);
        assert_eq!(fenced.observation, "lost");

        let mut reused = target.clone();
        reused.idempotency_key = Uuid::from_u128(72);
        reused.request_hash = "e".repeat(64);
        assert_eq!(
            store.create_remote_target_exact(&reused, "{}").unwrap(),
            RemoteMutationOutcome::InvalidState
        );
        drop(store);

        let reopened =
            SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
                .unwrap();
        assert!(
            reopened
                .remote_target_delete_pending(target.remote_target_id)
                .unwrap()
        );
        assert_eq!(
            reopened
                .finish_remote_target_delete_exact(
                    target.remote_target_id,
                    delete_key,
                    &delete_hash,
                    21,
                )
                .unwrap(),
            RemoteMutationOutcome::Replay(result.into())
        );
        assert_eq!(
            reopened
                .finish_remote_target_delete_exact(
                    target.remote_target_id,
                    delete_key,
                    &delete_hash,
                    22,
                )
                .unwrap(),
            RemoteMutationOutcome::Replay(result.into())
        );
        assert!(
            reopened
                .load_remote_target(target.remote_target_id)
                .unwrap()
                .is_none()
        );
        assert!(
            reopened
                .load_remote_session(session.remote_session_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn credential_enrollment_is_revision_fenced_and_reconciles_after_restart() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        let target = target(81, 82);
        let enrollment = Uuid::from_u128(83);

        assert!(
            store
                .prepare_remote_credential_enrollment(enrollment, target.remote_target_id, 0, 1)
                .unwrap()
        );
        assert!(
            !store
                .commit_remote_credential_enrollment(enrollment, target.remote_target_id, 0)
                .unwrap()
        );
        drop(store);

        let reopened = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
        assert_eq!(
            reopened.pending_remote_credential_enrollments().unwrap(),
            vec![(enrollment, target.remote_target_id)]
        );
        reopened.create_remote_target_exact(&target, "{}").unwrap();
        assert!(
            reopened
                .commit_remote_credential_enrollment(enrollment, target.remote_target_id, 0)
                .unwrap()
        );
        assert!(
            reopened
                .pending_remote_credential_enrollments()
                .unwrap()
                .is_empty()
        );

        let replacement = Uuid::from_u128(84);
        assert!(
            reopened
                .prepare_remote_credential_enrollment(
                    replacement,
                    target.remote_target_id,
                    target.revision,
                    2,
                )
                .unwrap()
        );
        let delete_key = Uuid::from_u128(85);
        let delete_hash = "f".repeat(64);
        assert_eq!(
            reopened
                .begin_remote_target_delete_exact(
                    target.remote_target_id,
                    target.revision,
                    delete_key,
                    &delete_hash,
                    "{\"deleted\":true}",
                    3,
                )
                .unwrap(),
            RemoteMutationOutcome::Applied
        );
        assert!(
            !reopened
                .commit_remote_credential_enrollment(
                    replacement,
                    target.remote_target_id,
                    target.revision,
                )
                .unwrap()
        );
        assert_eq!(
            reopened
                .finish_remote_target_delete_exact(
                    target.remote_target_id,
                    delete_key,
                    &delete_hash,
                    4,
                )
                .unwrap(),
            RemoteMutationOutcome::InvalidState
        );
        reopened
            .abort_remote_credential_enrollment(replacement, target.remote_target_id)
            .unwrap();
        assert!(matches!(
            reopened
                .finish_remote_target_delete_exact(
                    target.remote_target_id,
                    delete_key,
                    &delete_hash,
                    5,
                )
                .unwrap(),
            RemoteMutationOutcome::Replay(_)
        ));
    }

    #[test]
    fn credential_replacement_preserves_identity_and_fences_every_session_generation() {
        let dir = tempdir().unwrap();
        let store = SqliteStateStore::open(dir.path().join("state.db"), ShortcutPlatform::NonMacOs)
            .unwrap();
        let target = target(91, 92);
        let mut first = session(target.remote_target_id, 93);
        first.state = RemoteSessionStateRecord::Connected;
        let mut second = session(target.remote_target_id, 94);
        second.state = RemoteSessionStateRecord::Reconnecting;
        second.attempt_generation = 7;
        second.revision = 5;
        store.create_remote_target_exact(&target, "{}").unwrap();
        store
            .create_remote_session_exact(&first, "{\"pending\":true}")
            .unwrap();
        store
            .create_remote_session_exact(&second, "{\"pending\":true}")
            .unwrap();

        let enrollment = Uuid::from_u128(95);
        assert!(
            store
                .prepare_remote_credential_enrollment(
                    enrollment,
                    target.remote_target_id,
                    target.revision,
                    200,
                )
                .unwrap()
        );
        assert!(
            store
                .commit_remote_credential_enrollment(
                    enrollment,
                    target.remote_target_id,
                    target.revision,
                )
                .unwrap()
        );

        let fenced_target = store
            .load_remote_target(target.remote_target_id)
            .unwrap()
            .unwrap();
        assert_eq!(fenced_target.remote_target_id, target.remote_target_id);
        assert_eq!(fenced_target.revision, target.revision + 1);
        for (original, expected_generation) in [(first, 2), (second, 8)] {
            let fenced = store
                .load_remote_session(original.remote_session_id)
                .unwrap()
                .unwrap();
            assert_eq!(fenced.remote_target_id, target.remote_target_id);
            assert_eq!(fenced.state, RemoteSessionStateRecord::Failed);
            assert_eq!(fenced.observation, "lost");
            assert_eq!(fenced.attempt_generation, expected_generation);
            assert_eq!(fenced.revision, original.revision + 1);
        }
        assert!(
            store
                .pending_remote_credential_enrollments()
                .unwrap()
                .is_empty()
        );
    }
}

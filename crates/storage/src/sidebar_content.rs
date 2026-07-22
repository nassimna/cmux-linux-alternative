//! Schema-v11 durable sidebar, `TextBox`, recently-closed, and task metadata.

use super::{
    LEGACY_IDEMPOTENCY_EPOCH, MAX_SAFE_INTEGER, SqliteStateStore, StorageError, database_error,
    secure_database_artifacts, verify_table_schema,
};
use agent_workspace_protocol::{
    MAX_M8_RECENTLY_CLOSED, MAX_SIDEBAR_WINDOWS, MAX_TEXT_BOX_BYTES, MAX_TEXT_BOX_DOCUMENTS,
    RemoteMutationIdentity, SidebarPlacement, SidebarSide, SidebarSurface, TaskActionKind,
    TaskConfirmation, TaskKind, TaskTarget, TextBoxCreateParams, TextBoxDocument,
    TextBoxSaveParams,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const MAX_TASK_METADATA: i64 = 512;
const MAX_TASK_CONFIRMATIONS: i64 = 256;
const MAX_TASK_ACTION_OUTCOMES: i64 = 4_096;
pub(crate) const EXPECTED_SIDEBAR_PLACEMENTS_SCHEMA:&str="CREATE TABLE sidebar_placements (
    window_id TEXT PRIMARY KEY CHECK (length(window_id) = 36),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    side TEXT NOT NULL CHECK (side IN ('left', 'right')),
    width INTEGER NOT NULL CHECK (width BETWEEN 240 AND 720),
    enabled_json TEXT NOT NULL,
    order_json TEXT NOT NULL,
    selected TEXT NOT NULL CHECK (selected IN ('textBox', 'vault', 'taskManager', 'files', 'markdown', 'diff', 'search', 'recentlyClosed')),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)";
pub(crate) const EXPECTED_TEXT_BOX_DOCUMENTS_SCHEMA: &str = "CREATE TABLE text_box_documents (
    text_box_document_id TEXT PRIMARY KEY CHECK (length(text_box_document_id) = 36),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
    window_id TEXT NOT NULL CHECK (length(window_id) = 36),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 480),
    text_content TEXT NOT NULL CHECK (length(CAST(text_content AS BLOB)) <= 262144),
    content_revision INTEGER NOT NULL CHECK (content_revision BETWEEN 1 AND 9007199254740991),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)";
pub(crate) const EXPECTED_RECENTLY_CLOSED_SCHEMA:&str="CREATE TABLE recently_closed_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    recently_closed_id TEXT NOT NULL UNIQUE CHECK (length(recently_closed_id) = 36),
    authorized_descriptor_id TEXT NOT NULL CHECK (length(authorized_descriptor_id) = 36),
    reopen_action TEXT NOT NULL CHECK (reopen_action IN ('reopenTerminal', 'reopenAgent', 'reopenBrowser', 'reconnectRemote', 'reinvokeAction')),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 1024),
    closed_at_ms INTEGER NOT NULL CHECK (closed_at_ms >= 0),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    restored INTEGER NOT NULL CHECK (restored IN (0, 1))
)";
pub(crate) const EXPECTED_TASK_METADATA_SCHEMA:&str="CREATE TABLE task_metadata (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) = 36),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    task_kind TEXT NOT NULL CHECK (task_kind IN ('terminal', 'agent', 'browserAutomation', 'remoteSession', 'customAction')),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('created', 'running', 'detaching', 'cancelling', 'terminating', 'forceTerminating', 'detached', 'succeeded', 'failed', 'cancelled', 'terminated')),
    observation TEXT NOT NULL CHECK (observation IN ('unknown', 'lastVerified', 'lost')),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 1024),
    owner_label TEXT NOT NULL CHECK (length(owner_label) BETWEEN 1 AND 1024),
    resource_summary TEXT CHECK (resource_summary IS NULL OR length(resource_summary) <= 2048),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
)";
pub(crate) const EXPECTED_TASK_CONFIRMATIONS_SCHEMA: &str = "CREATE TABLE task_confirmations (
    invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) = 36),
    action TEXT NOT NULL CHECK (action IN ('cancel', 'terminate', 'forceTerminate')),
    task_kind TEXT NOT NULL CHECK (task_kind IN ('agent', 'remoteSession')),
    session_id TEXT NOT NULL CHECK (length(session_id) = 36),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    provider_id TEXT NOT NULL CHECK (length(provider_id) = 36),
    provider_epoch INTEGER NOT NULL CHECK (provider_epoch BETWEEN 1 AND 9007199254740991),
    provider_lease_id TEXT NOT NULL CHECK (length(provider_lease_id) = 36),
    window_id TEXT NOT NULL CHECK (length(window_id) = 36),
    window_generation INTEGER NOT NULL CHECK (window_generation BETWEEN 1 AND 9007199254740991),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= 0),
    consumed_idempotency_key TEXT CHECK (consumed_idempotency_key IS NULL OR length(consumed_idempotency_key) = 36),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
)";
pub(crate) const EXPECTED_TASK_ACTION_OUTCOMES_SCHEMA: &str = "CREATE TABLE task_action_outcomes (
    idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    invocation_id TEXT NOT NULL UNIQUE CHECK (length(invocation_id) = 36),
    action TEXT NOT NULL CHECK (action IN ('detach', 'cancel', 'terminate', 'forceTerminate')),
    task_kind TEXT NOT NULL CHECK (task_kind IN ('agent', 'remoteSession')),
    session_id TEXT NOT NULL CHECK (length(session_id) = 36),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    result_json TEXT NOT NULL CHECK (length(CAST(result_json AS BLOB)) <= 262144),
    completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0)
)";

pub(crate) fn migrate_to_v15(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    for (table, schema) in [
        ("task_confirmations", EXPECTED_TASK_CONFIRMATIONS_SCHEMA),
        ("task_action_outcomes", EXPECTED_TASK_ACTION_OUTCOMES_SCHEMA),
        (
            "agent_task_dispositions",
            super::agent_sessions::EXPECTED_AGENT_TASK_DISPOSITIONS_SCHEMA,
        ),
    ] {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            transaction.execute_batch(schema)?;
        }
    }
    transaction.execute_batch(
        "UPDATE migration_metadata SET target_version = 15 WHERE singleton = 1;PRAGMA user_version = 15;",
    )
}

pub(crate) fn verify_v15_schema(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    for (table, schema, cap) in [
        (
            "task_confirmations",
            EXPECTED_TASK_CONFIRMATIONS_SCHEMA,
            MAX_TASK_CONFIRMATIONS,
        ),
        (
            "task_action_outcomes",
            EXPECTED_TASK_ACTION_OUTCOMES_SCHEMA,
            MAX_TASK_ACTION_OUTCOMES,
        ),
        (
            "agent_task_dispositions",
            super::agent_sessions::EXPECTED_AGENT_TASK_DISPOSITIONS_SCHEMA,
            super::agent_sessions::AGENT_SESSION_CAP_I64,
        ),
    ] {
        verify_table_schema(connection, path, table, schema, 15)?;
        let count: i64 = connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|error| database_error(path, "schema-v15 row bound", error))?;
        if count > cap {
            return Err(corrupt(
                path,
                "task security table exceeds its durable row bound",
            ));
        }
    }
    Ok(())
}

pub(crate) fn migrate_to_v11(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    for (name, schema) in [
        ("sidebar_placements", EXPECTED_SIDEBAR_PLACEMENTS_SCHEMA),
        ("text_box_documents", EXPECTED_TEXT_BOX_DOCUMENTS_SCHEMA),
        ("recently_closed_records", EXPECTED_RECENTLY_CLOSED_SCHEMA),
        ("task_metadata", EXPECTED_TASK_METADATA_SCHEMA),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [name],
            |row| row.get(0),
        )?;
        if !exists {
            tx.execute_batch(schema)?;
        }
    }
    tx.pragma_update(None, "user_version", 11)
}

pub(crate) fn verify_schema(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    for (name, schema) in [
        ("sidebar_placements", EXPECTED_SIDEBAR_PLACEMENTS_SCHEMA),
        ("text_box_documents", EXPECTED_TEXT_BOX_DOCUMENTS_SCHEMA),
        ("recently_closed_records", EXPECTED_RECENTLY_CLOSED_SCHEMA),
        ("task_metadata", EXPECTED_TASK_METADATA_SCHEMA),
    ] {
        verify_table_schema(connection, path, name, schema, 11)?;
    }
    for (name, cap) in [
        (
            "sidebar_placements",
            i64::try_from(MAX_SIDEBAR_WINDOWS).unwrap_or(i64::MAX),
        ),
        (
            "text_box_documents",
            i64::try_from(MAX_TEXT_BOX_DOCUMENTS).unwrap_or(i64::MAX),
        ),
        (
            "recently_closed_records",
            i64::try_from(MAX_M8_RECENTLY_CLOSED).unwrap_or(i64::MAX),
        ),
        ("task_metadata", MAX_TASK_METADATA),
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT count(*) FROM {name}"), [], |r| r.get(0))
            .map_err(|e| database_error(path, "schema-v11 row bound", e))?;
        if count > cap {
            return Err(StorageError::CorruptSchema {
                path: path.to_path_buf(),
                message: format!("{name} exceeds its durable row bound"),
            });
        }
    }
    let mut statement=connection.prepare("SELECT window_id,revision,side,width,enabled_json,order_json,selected FROM sidebar_placements").map_err(|e|database_error(path,"sidebar verification",e))?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u16>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| database_error(path, "sidebar verification", e))?;
    for row in rows {
        let (window_id, revision, side, width, enabled, order, selected) =
            row.map_err(|e| database_error(path, "sidebar verification", e))?;
        let value = serde_json::json!({"windowId":window_id,"revision":revision,"side":side,"width":width,"enabled":serde_json::from_str::<serde_json::Value>(&enabled).map_err(|_|corrupt(path,"invalid enabled surfaces"))?,"order":serde_json::from_str::<serde_json::Value>(&order).map_err(|_|corrupt(path,"invalid surface order"))?,"selected":selected});
        serde_json::from_value::<SidebarPlacement>(value)
            .map_err(|_| corrupt(path, "invalid sidebar placement"))?;
    }
    let mut docs=connection.prepare("SELECT text_box_document_id,workspace_id,window_id,title,text_content,content_revision,idempotency_key,request_hash,created_at_ms,updated_at_ms FROM text_box_documents").map_err(|e|database_error(path,"TextBox verification",e))?;
    let rows = docs
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
            ))
        })
        .map_err(|e| database_error(path, "TextBox verification", e))?;
    for row in rows {
        let (id, w, win, title, text, rev, key, hash, created, updated) =
            row.map_err(|e| database_error(path, "TextBox verification", e))?;
        if [id, w, win, key]
            .iter()
            .any(|v| Uuid::parse_str(v).is_err())
            || title.trim().is_empty()
            || title.chars().count() > 120
            || text.len() > MAX_TEXT_BOX_BYTES
            || rev <= 0
            || created < 0
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || updated < created
        {
            return Err(corrupt(path, "invalid TextBox row"));
        }
    }
    let forbidden: [&str; 5] = ["pid", "path", "command", "environment", "secret"];
    for table in [
        EXPECTED_SIDEBAR_PLACEMENTS_SCHEMA,
        EXPECTED_TEXT_BOX_DOCUMENTS_SCHEMA,
        EXPECTED_RECENTLY_CLOSED_SCHEMA,
        EXPECTED_TASK_METADATA_SCHEMA,
    ] {
        let lower = table.to_ascii_lowercase();
        if forbidden.iter().any(|word| {
            lower
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .any(|v| v == *word)
        }) {
            return Err(corrupt(path, "private field in schema-v11 table"));
        }
    }
    Ok(())
}

/// Exact outcome for one durable M8 catalog mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SidebarContentMutationOutcome {
    Applied,
    Replay(String),
    Conflict,
    NotFound,
    StaleRevision,
    ResourceLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskConfirmationConsumeOutcome {
    Consumed,
    Replay,
    Expired,
    Conflict,
    AlreadyConsumed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoredTaskConfirmation {
    invocation_id: Uuid,
    action: TaskActionKind,
    kind: TaskKind,
    target: TaskTarget,
    provider_id: Uuid,
    provider_epoch: u64,
    provider_lease_id: Uuid,
    window_id: Uuid,
    window_generation: u64,
    request_hash: String,
    nonce_hash: String,
    expires_at_ms: i64,
    consumed_at_ms: Option<i64>,
    consumed_idempotency_key: Option<Uuid>,
}

impl SqliteStateStore {
    pub fn create_task_confirmation_exact(
        &self,
        confirmation: &TaskConfirmation,
        created_at_ms: i64,
    ) -> Result<(), StorageError> {
        validate_task_confirmation(confirmation, created_at_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "task confirmation transaction", error))?;
        tx.execute(
            "DELETE FROM task_confirmations WHERE expires_at_ms<=?1 AND consumed_at_ms IS NOT NULL",
            [created_at_ms],
        )
        .map_err(|error| database_error(&self.path, "task confirmation prune", error))?;
        let count: i64 = tx
            .query_row("SELECT count(*) FROM task_confirmations", [], |row| {
                row.get(0)
            })
            .map_err(|error| database_error(&self.path, "task confirmation capacity", error))?;
        if count >= MAX_TASK_CONFIRMATIONS {
            return Err(invalid("task confirmation capacity reached"));
        }
        tx.execute(
            "INSERT INTO task_confirmations(invocation_id,action,task_kind,session_id,generation,revision,provider_id,provider_epoch,provider_lease_id,window_id,window_generation,request_hash,nonce_hash,expires_at_ms,consumed_at_ms,consumed_idempotency_key,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,NULL,?15)",
            params![
                confirmation.invocation_id,
                task_action(confirmation.action),
                task_kind(confirmation.kind),
                confirmation.target.session_id,
                sql_u64(confirmation.target.generation)?,
                sql_u64(confirmation.target.revision)?,
                confirmation.provider_id,
                sql_u64(confirmation.provider_epoch)?,
                confirmation.provider_lease_id,
                confirmation.window_id,
                sql_u64(confirmation.window_generation)?,
                confirmation.request_hash,
                format!("{:x}", Sha256::digest(confirmation.nonce.as_bytes())),
                i64::try_from(confirmation.expires_at_ms).map_err(|_| invalid("invalid task confirmation expiry"))?,
                created_at_ms,
            ],
        )
        .map_err(|error| database_error(&self.path, "task confirmation insert", error))?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "task confirmation commit", error))
    }

    pub fn consume_task_confirmation_exact(
        &self,
        confirmation: &TaskConfirmation,
        mutation: &RemoteMutationIdentity,
        now_ms: i64,
    ) -> Result<TaskConfirmationConsumeOutcome, StorageError> {
        validate_task_confirmation(confirmation, now_ms)?;
        validate_mutation(mutation, "{}", now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "task confirmation consume transaction", error)
            })?;
        let Some(stored) = load_task_confirmation(
            &tx,
            Uuid::parse_str(&confirmation.invocation_id)
                .map_err(|_| invalid("invalid task confirmation"))?,
        )
        .map_err(|error| database_error(&self.path, "task confirmation read", error))?
        else {
            return Ok(TaskConfirmationConsumeOutcome::Conflict);
        };
        let idempotency_key = Uuid::parse_str(&mutation.idempotency_key)
            .map_err(|_| invalid("invalid task idempotency key"))?;
        if stored.consumed_at_ms.is_some() {
            return Ok(
                if stored.consumed_idempotency_key == Some(idempotency_key)
                    && stored.request_hash == mutation.request_hash
                    && stored_task_confirmation_matches(&stored, confirmation)
                    && mutation.expected_revision == confirmation.target.revision
                {
                    TaskConfirmationConsumeOutcome::Replay
                } else {
                    TaskConfirmationConsumeOutcome::AlreadyConsumed
                },
            );
        }
        let exact = stored_task_confirmation_matches(&stored, confirmation)
            && mutation.expected_revision == confirmation.target.revision
            && mutation.request_hash == confirmation.request_hash;
        let changed = tx.execute(
            "UPDATE task_confirmations SET consumed_at_ms=?2,consumed_idempotency_key=?3 WHERE invocation_id=?1 AND consumed_at_ms IS NULL",
            params![confirmation.invocation_id, now_ms, mutation.idempotency_key],
        )
        .map_err(|error| database_error(&self.path, "task confirmation burn", error))?;
        if changed != 1 {
            return Ok(TaskConfirmationConsumeOutcome::AlreadyConsumed);
        }
        tx.commit().map_err(|error| {
            database_error(&self.path, "task confirmation consume commit", error)
        })?;
        if stored.expires_at_ms <= now_ms {
            Ok(TaskConfirmationConsumeOutcome::Expired)
        } else if exact {
            Ok(TaskConfirmationConsumeOutcome::Consumed)
        } else {
            Ok(TaskConfirmationConsumeOutcome::Conflict)
        }
    }

    pub fn invalidate_pending_task_confirmations(
        &self,
        now_ms: i64,
    ) -> Result<usize, StorageError> {
        if now_ms < 0 {
            return Err(invalid("invalid task confirmation time"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE task_confirmations SET consumed_at_ms=?1 WHERE consumed_at_ms IS NULL",
                [now_ms],
            )
            .map_err(|error| database_error(&self.path, "task confirmation invalidation", error))
    }

    pub fn load_task_action_outcome_exact(
        &self,
        action: TaskActionKind,
        kind: TaskKind,
        target: &TaskTarget,
        mutation: &RemoteMutationIdentity,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(mutation, "{}", 0)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT request_hash,action,task_kind,session_id,generation,revision,result_json FROM task_action_outcomes WHERE idempotency_key=?1",
                [mutation.idempotency_key.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, String>(6)?)),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "task action outcome read", error))?;
        Ok(match row {
            None => SidebarContentMutationOutcome::NotFound,
            Some((hash, stored_action, stored_kind, session, generation, revision, result))
                if hash == mutation.request_hash
                    && stored_action == task_action(action)
                    && stored_kind == task_kind(kind)
                    && session == target.session_id
                    && u64::try_from(generation).ok() == Some(target.generation)
                    && u64::try_from(revision).ok() == Some(target.revision) =>
            {
                SidebarContentMutationOutcome::Replay(result)
            }
            Some(_) => SidebarContentMutationOutcome::Conflict,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_task_action_outcome_exact(
        &self,
        invocation_id: Uuid,
        action: TaskActionKind,
        kind: TaskKind,
        target: &TaskTarget,
        mutation: &RemoteMutationIdentity,
        result_json: &str,
        now_ms: i64,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(mutation, result_json, now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database_error(&self.path, "task action outcome transaction", error)
            })?;
        if let Some(outcome) = load_task_outcome(&tx, action, kind, target, mutation)? {
            return Ok(outcome);
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM task_action_outcomes", [], |row| {
                row.get(0)
            })
            .map_err(|error| database_error(&self.path, "task action outcome capacity", error))?;
        if count >= MAX_TASK_ACTION_OUTCOMES {
            return Ok(SidebarContentMutationOutcome::ResourceLimit);
        }
        tx.execute(
            "INSERT INTO task_action_outcomes(idempotency_key,request_hash,invocation_id,action,task_kind,session_id,generation,revision,result_json,completed_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![mutation.idempotency_key, mutation.request_hash, invocation_id.to_string(), task_action(action), task_kind(kind), target.session_id, sql_u64(target.generation)?, sql_u64(target.revision)?, result_json, now_ms],
        )
        .map_err(|error| database_error(&self.path, "task action outcome insert", error))?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "task action outcome commit", error))?;
        Ok(SidebarContentMutationOutcome::Applied)
    }

    /// Reads one exact bounded idempotency result without creating or mutating an operation. This
    /// is used by Task Manager to converge after a crash between an authoritative owner mutation
    /// and the task facade's own durable result write.
    pub fn load_task_operation_result_exact(
        &self,
        namespace: &str,
        mutation: &RemoteMutationIdentity,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        if !matches!(
            namespace,
            "task.action" | "remote.session.detach" | "remote.session.close"
        ) {
            return Err(invalid("invalid task operation namespace"));
        }
        validate_mutation(mutation, "{}", 0)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        replay(&connection, namespace, mutation)
            .map(|outcome| outcome.unwrap_or(SidebarContentMutationOutcome::NotFound))
    }

    pub fn record_sidebar_operation_exact(
        &self,
        namespace: &str,
        mutation: &RemoteMutationIdentity,
        result_json: &str,
        now_ms: i64,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(mutation, result_json, now_ms)?;
        if !namespace.starts_with("sidebar.")
            && !namespace.starts_with("search.")
            && !namespace.starts_with("task.")
            && !namespace.starts_with("recentlyClosed.")
        {
            return Err(invalid("invalid sidebar operation namespace"));
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "sidebar operation transaction", error))?;
        if let Some(outcome) = replay(&tx, namespace, mutation)? {
            return Ok(outcome);
        }
        store_result(&tx, namespace, mutation, result_json, now_ms)?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "sidebar operation commit", error))?;
        Ok(SidebarContentMutationOutcome::Applied)
    }

    pub fn load_sidebar_placement(
        &self,
        window_id: Uuid,
    ) -> Result<Option<SidebarPlacement>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_placement(&connection, window_id)
            .map_err(|error| database_error(&self.path, "sidebar placement read", error))
    }

    pub fn list_sidebar_placements(&self) -> Result<Vec<SidebarPlacement>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT window_id,revision,side,width,enabled_json,order_json,selected FROM sidebar_placements ORDER BY window_id")
            .map_err(|error| database_error(&self.path, "sidebar placement list prepare", error))?;
        statement
            .query_map([], placement_from_row)
            .map_err(|error| database_error(&self.path, "sidebar placement list", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| database_error(&self.path, "sidebar placement list row", error))
    }

    pub fn save_sidebar_placement_exact(
        &self,
        placement: &SidebarPlacement,
        mutation: &RemoteMutationIdentity,
        result_json: &str,
        now_ms: i64,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(mutation, result_json, now_ms)?;
        let window_id = parse_uuid_value(&placement.window_id)?;
        if placement.revision != mutation.expected_revision.saturating_add(1) {
            return Ok(SidebarContentMutationOutcome::StaleRevision);
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "sidebar save transaction", error))?;
        if let Some(outcome) = replay(&tx, "sidebar.placement.save", mutation)? {
            return Ok(outcome);
        }
        let stored_revision = tx
            .query_row(
                "SELECT revision FROM sidebar_placements WHERE window_id=?1",
                [window_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| database_error(&self.path, "sidebar revision read", error))?;
        match stored_revision {
            Some(value) if u64::try_from(value).ok() != Some(mutation.expected_revision) => {
                return Ok(SidebarContentMutationOutcome::StaleRevision);
            }
            None if mutation.expected_revision != 0 => {
                return Ok(SidebarContentMutationOutcome::NotFound);
            }
            None => {
                let count: i64 = tx
                    .query_row("SELECT count(*) FROM sidebar_placements", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| database_error(&self.path, "sidebar capacity read", error))?;
                if count >= i64::try_from(MAX_SIDEBAR_WINDOWS).unwrap_or(i64::MAX) {
                    return Ok(SidebarContentMutationOutcome::ResourceLimit);
                }
            }
            Some(_) => {}
        }
        tx.execute(
            "INSERT INTO sidebar_placements(window_id,revision,side,width,enabled_json,order_json,selected,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(window_id) DO UPDATE SET revision=excluded.revision,side=excluded.side,width=excluded.width,enabled_json=excluded.enabled_json,order_json=excluded.order_json,selected=excluded.selected,updated_at_ms=excluded.updated_at_ms",
            params![
                placement.window_id,
                sql_u64(placement.revision)?,
                side(placement.side),
                placement.width,
                serde_json::to_string(&placement.enabled).map_err(|_| invalid("sidebar enabled registry cannot be encoded"))?,
                serde_json::to_string(&placement.order).map_err(|_| invalid("sidebar order cannot be encoded"))?,
                surface(placement.selected),
                now_ms,
            ],
        )
        .map_err(|error| database_error(&self.path, "sidebar placement save", error))?;
        store_result(&tx, "sidebar.placement.save", mutation, result_json, now_ms)?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "sidebar save commit", error))?;
        Ok(SidebarContentMutationOutcome::Applied)
    }

    pub fn load_text_box_document(
        &self,
        id: Uuid,
    ) -> Result<Option<TextBoxDocument>, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        load_text_box(&connection, id)
            .map_err(|error| database_error(&self.path, "TextBox read", error))
    }

    pub fn list_text_box_documents(
        &self,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<(Vec<TextBoxDocument>, Option<Uuid>), StorageError> {
        if limit == 0 || usize::from(limit) > MAX_TEXT_BOX_DOCUMENTS {
            return Err(invalid("TextBox list limit is invalid"));
        }
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let mut statement = connection.prepare("SELECT text_box_document_id,workspace_id,window_id,title,text_content,content_revision,created_at_ms,updated_at_ms FROM text_box_documents WHERE text_box_document_id>?1 ORDER BY text_box_document_id LIMIT ?2")
            .map_err(|error| database_error(&self.path, "TextBox list prepare", error))?;
        let mut rows = statement
            .query_map(
                params![
                    cursor.map_or_else(String::new, |id| id.to_string()),
                    i64::from(limit) + 1
                ],
                text_box_from_row,
            )
            .map_err(|error| database_error(&self.path, "TextBox list", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| database_error(&self.path, "TextBox list row", error))?;
        let has_more = rows.len() > usize::from(limit);
        rows.truncate(usize::from(limit));
        let next = if has_more {
            rows.last()
                .map(|record| parse_uuid_value(&record.text_box_document_id))
                .transpose()?
        } else {
            None
        };
        Ok((rows, next))
    }

    pub fn create_text_box_document_exact(
        &self,
        params: &TextBoxCreateParams,
        result_json: &str,
        now_ms: i64,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(&params.mutation, result_json, now_ms)?;
        if params.mutation.expected_revision != 0 {
            return Ok(SidebarContentMutationOutcome::StaleRevision);
        }
        let id = parse_uuid_value(&params.text_box_document_id)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "TextBox create transaction", error))?;
        if let Some(outcome) = replay(&tx, "textbox.create", &params.mutation)? {
            return Ok(outcome);
        }
        if load_text_box(&tx, id)
            .map_err(|error| database_error(&self.path, "TextBox existence read", error))?
            .is_some()
        {
            return Ok(SidebarContentMutationOutcome::Conflict);
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM text_box_documents", [], |row| {
                row.get(0)
            })
            .map_err(|error| database_error(&self.path, "TextBox capacity read", error))?;
        if count >= i64::try_from(MAX_TEXT_BOX_DOCUMENTS).unwrap_or(i64::MAX) {
            return Ok(SidebarContentMutationOutcome::ResourceLimit);
        }
        tx.execute("INSERT INTO text_box_documents(text_box_document_id,workspace_id,window_id,title,text_content,content_revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?8)", params![params.text_box_document_id, params.workspace_id, params.window_id, params.title, params.text, params.mutation.idempotency_key, params.mutation.request_hash, now_ms])
            .map_err(|error| database_error(&self.path, "TextBox create", error))?;
        store_result(&tx, "textbox.create", &params.mutation, result_json, now_ms)?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "TextBox create commit", error))?;
        Ok(SidebarContentMutationOutcome::Applied)
    }

    pub fn save_text_box_document_exact(
        &self,
        params: &TextBoxSaveParams,
        result_json: &str,
        now_ms: i64,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(&params.mutation, result_json, now_ms)?;
        if params.expected_revision != params.mutation.expected_revision {
            return Ok(SidebarContentMutationOutcome::StaleRevision);
        }
        let id = parse_uuid_value(&params.text_box_document_id)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "TextBox save transaction", error))?;
        if let Some(outcome) = replay(&tx, "textbox.save", &params.mutation)? {
            return Ok(outcome);
        }
        let changed = tx.execute("UPDATE text_box_documents SET title=?2,text_content=?3,content_revision=content_revision+1,updated_at_ms=?4 WHERE text_box_document_id=?1 AND content_revision=?5 AND content_revision<9007199254740991", params![id.to_string(), params.title, params.text, now_ms, sql_u64(params.expected_revision)?])
            .map_err(|error| database_error(&self.path, "TextBox save", error))?;
        if changed == 0 {
            return Ok(
                if load_text_box(&tx, id)
                    .map_err(|error| database_error(&self.path, "TextBox save read", error))?
                    .is_some()
                {
                    SidebarContentMutationOutcome::StaleRevision
                } else {
                    SidebarContentMutationOutcome::NotFound
                },
            );
        }
        store_result(&tx, "textbox.save", &params.mutation, result_json, now_ms)?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "TextBox save commit", error))?;
        Ok(SidebarContentMutationOutcome::Applied)
    }

    pub fn delete_text_box_document_exact(
        &self,
        id: Uuid,
        expected_revision: u64,
        mutation: &RemoteMutationIdentity,
        result_json: &str,
        now_ms: i64,
    ) -> Result<SidebarContentMutationOutcome, StorageError> {
        validate_mutation(mutation, result_json, now_ms)?;
        if expected_revision != mutation.expected_revision {
            return Ok(SidebarContentMutationOutcome::StaleRevision);
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error(&self.path, "TextBox delete transaction", error))?;
        if let Some(outcome) = replay(&tx, "textbox.delete", mutation)? {
            return Ok(outcome);
        }
        let changed = tx.execute("DELETE FROM text_box_documents WHERE text_box_document_id=?1 AND content_revision=?2", params![id.to_string(), sql_u64(expected_revision)?])
            .map_err(|error| database_error(&self.path, "TextBox delete", error))?;
        if changed == 0 {
            return Ok(
                if load_text_box(&tx, id)
                    .map_err(|error| database_error(&self.path, "TextBox delete read", error))?
                    .is_some()
                {
                    SidebarContentMutationOutcome::StaleRevision
                } else {
                    SidebarContentMutationOutcome::NotFound
                },
            );
        }
        store_result(&tx, "textbox.delete", mutation, result_json, now_ms)?;
        tx.commit()
            .map_err(|error| database_error(&self.path, "TextBox delete commit", error))?;
        Ok(SidebarContentMutationOutcome::Applied)
    }
}

fn load_task_confirmation(
    connection: &Connection,
    invocation_id: Uuid,
) -> rusqlite::Result<Option<StoredTaskConfirmation>> {
    connection
        .query_row(
            "SELECT invocation_id,action,task_kind,session_id,generation,revision,provider_id,provider_epoch,provider_lease_id,window_id,window_generation,request_hash,nonce_hash,expires_at_ms,consumed_at_ms,consumed_idempotency_key FROM task_confirmations WHERE invocation_id=?1",
            [invocation_id.to_string()],
            |row| {
                Ok(StoredTaskConfirmation {
                    invocation_id: sql_uuid(&row.get::<_, String>(0)?)?,
                    action: parse_task_action(&row.get::<_, String>(1)?)?,
                    kind: parse_task_kind(&row.get::<_, String>(2)?)?,
                    target: TaskTarget {
                        session_id: row.get(3)?,
                        generation: sql_u64_value(row.get(4)?, 4)?,
                        revision: sql_u64_value(row.get(5)?, 5)?,
                    },
                    provider_id: sql_uuid(&row.get::<_, String>(6)?)?,
                    provider_epoch: sql_u64_value(row.get(7)?, 7)?,
                    provider_lease_id: sql_uuid(&row.get::<_, String>(8)?)?,
                    window_id: sql_uuid(&row.get::<_, String>(9)?)?,
                    window_generation: sql_u64_value(row.get(10)?, 10)?,
                    request_hash: row.get(11)?,
                    nonce_hash: row.get(12)?,
                    expires_at_ms: row.get(13)?,
                    consumed_at_ms: row.get(14)?,
                    consumed_idempotency_key: row
                        .get::<_, Option<String>>(15)?
                        .map(|value| sql_uuid(&value))
                        .transpose()?,
                })
            },
        )
        .optional()
}

fn stored_task_confirmation_matches(
    stored: &StoredTaskConfirmation,
    confirmation: &TaskConfirmation,
) -> bool {
    Uuid::parse_str(&confirmation.invocation_id).ok() == Some(stored.invocation_id)
        && stored.action == confirmation.action
        && stored.kind == confirmation.kind
        && stored.target == confirmation.target
        && Uuid::parse_str(&confirmation.provider_id).ok() == Some(stored.provider_id)
        && stored.provider_epoch == confirmation.provider_epoch
        && Uuid::parse_str(&confirmation.provider_lease_id).ok() == Some(stored.provider_lease_id)
        && Uuid::parse_str(&confirmation.window_id).ok() == Some(stored.window_id)
        && stored.window_generation == confirmation.window_generation
        && stored.request_hash == confirmation.request_hash
        && stored.nonce_hash == format!("{:x}", Sha256::digest(confirmation.nonce.as_bytes()))
        && u64::try_from(stored.expires_at_ms).ok() == Some(confirmation.expires_at_ms)
}

fn validate_task_confirmation(
    confirmation: &TaskConfirmation,
    now_ms: i64,
) -> Result<(), StorageError> {
    for value in [
        &confirmation.invocation_id,
        &confirmation.target.session_id,
        &confirmation.provider_id,
        &confirmation.provider_lease_id,
        &confirmation.window_id,
        &confirmation.nonce,
    ] {
        parse_uuid_value(value)?;
    }
    if confirmation.action == TaskActionKind::Detach
        || !matches!(confirmation.kind, TaskKind::Agent | TaskKind::RemoteSession)
        || confirmation.target.generation == 0
        || confirmation.target.revision == 0
        || confirmation.provider_epoch == 0
        || confirmation.window_generation == 0
        || confirmation.request_hash.len() != 64
        || !confirmation
            .request_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || now_ms < 0
        || confirmation.expires_at_ms > u64::try_from(now_ms).unwrap_or(0).saturating_add(30_000)
    {
        return Err(invalid("invalid task confirmation"));
    }
    Ok(())
}

fn load_task_outcome(
    connection: &Connection,
    action: TaskActionKind,
    kind: TaskKind,
    target: &TaskTarget,
    mutation: &RemoteMutationIdentity,
) -> Result<Option<SidebarContentMutationOutcome>, StorageError> {
    let row = connection
        .query_row(
            "SELECT request_hash,action,task_kind,session_id,generation,revision,result_json FROM task_action_outcomes WHERE idempotency_key=?1",
            [mutation.idempotency_key.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, String>(6)?)),
        )
        .optional()
        .map_err(|error| invalid(&format!("task action outcome lookup failed: {error}")))?;
    Ok(row.map(
        |(hash, stored_action, stored_kind, session, generation, revision, result)| {
            if hash == mutation.request_hash
                && stored_action == task_action(action)
                && stored_kind == task_kind(kind)
                && session == target.session_id
                && u64::try_from(generation).ok() == Some(target.generation)
                && u64::try_from(revision).ok() == Some(target.revision)
            {
                SidebarContentMutationOutcome::Replay(result)
            } else {
                SidebarContentMutationOutcome::Conflict
            }
        },
    ))
}

const fn task_action(value: TaskActionKind) -> &'static str {
    match value {
        TaskActionKind::Detach => "detach",
        TaskActionKind::Cancel => "cancel",
        TaskActionKind::Terminate => "terminate",
        TaskActionKind::ForceTerminate => "forceTerminate",
    }
}

const fn task_kind(value: TaskKind) -> &'static str {
    match value {
        TaskKind::Terminal => "terminal",
        TaskKind::Agent => "agent",
        TaskKind::BrowserAutomation => "browserAutomation",
        TaskKind::RemoteSession => "remoteSession",
        TaskKind::CustomAction => "customAction",
    }
}

fn parse_task_action(value: &str) -> rusqlite::Result<TaskActionKind> {
    match value {
        "detach" => Ok(TaskActionKind::Detach),
        "cancel" => Ok(TaskActionKind::Cancel),
        "terminate" => Ok(TaskActionKind::Terminate),
        "forceTerminate" => Ok(TaskActionKind::ForceTerminate),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_task_kind(value: &str) -> rusqlite::Result<TaskKind> {
    match value {
        "agent" => Ok(TaskKind::Agent),
        "remoteSession" => Ok(TaskKind::RemoteSession),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn sql_uuid(value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn sql_u64_value(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, value))
}

fn placement_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SidebarPlacement> {
    let enabled: String = row.get(4)?;
    let order: String = row.get(5)?;
    let value = serde_json::json!({
        "windowId": row.get::<_, String>(0)?,
        "revision": row.get::<_, i64>(1)?,
        "side": row.get::<_, String>(2)?,
        "width": row.get::<_, u16>(3)?,
        "enabled": serde_json::from_str::<serde_json::Value>(&enabled).map_err(json_sql)?,
        "order": serde_json::from_str::<serde_json::Value>(&order).map_err(json_sql)?,
        "selected": row.get::<_, String>(6)?,
    });
    serde_json::from_value(value).map_err(json_sql)
}

fn load_placement(connection: &Connection, id: Uuid) -> rusqlite::Result<Option<SidebarPlacement>> {
    connection.query_row("SELECT window_id,revision,side,width,enabled_json,order_json,selected FROM sidebar_placements WHERE window_id=?1", [id.to_string()], placement_from_row).optional()
}

fn text_box_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TextBoxDocument> {
    let created = row.get::<_, i64>(6)?;
    let updated = row.get::<_, i64>(7)?;
    Ok(TextBoxDocument {
        text_box_document_id: row.get(0)?,
        workspace_id: row.get(1)?,
        window_id: row.get(2)?,
        title: row.get(3)?,
        text: row.get(4)?,
        content_revision: u64::try_from(row.get::<_, i64>(5)?)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(5, -1))?,
        created_at_ms: u64::try_from(created)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(6, created))?,
        updated_at_ms: u64::try_from(updated)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(7, updated))?,
    })
}

fn load_text_box(connection: &Connection, id: Uuid) -> rusqlite::Result<Option<TextBoxDocument>> {
    connection.query_row("SELECT text_box_document_id,workspace_id,window_id,title,text_content,content_revision,created_at_ms,updated_at_ms FROM text_box_documents WHERE text_box_document_id=?1", [id.to_string()], text_box_from_row).optional()
}

fn replay(
    tx: &Connection,
    namespace: &str,
    mutation: &RemoteMutationIdentity,
) -> Result<Option<SidebarContentMutationOutcome>, StorageError> {
    let stored = tx.query_row("SELECT request_hash,result_json FROM idempotency_results WHERE namespace=?1 AND epoch=?2 AND idempotency_key=?3", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, mutation.idempotency_key], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).optional()
        .map_err(|error| invalid(&format!("idempotency lookup failed: {error}")))?;
    Ok(stored.map(|(hash, result)| {
        if hash == mutation.request_hash {
            result.map_or(
                SidebarContentMutationOutcome::Conflict,
                SidebarContentMutationOutcome::Replay,
            )
        } else {
            SidebarContentMutationOutcome::Conflict
        }
    }))
}

fn store_result(
    tx: &Transaction<'_>,
    namespace: &str,
    mutation: &RemoteMutationIdentity,
    result: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    tx.execute("INSERT INTO idempotency_results(namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms) VALUES(?1,?2,?3,?4,?5,?6)", params![namespace, LEGACY_IDEMPOTENCY_EPOCH, mutation.idempotency_key, mutation.request_hash, result, now_ms])
        .map_err(|error| invalid(&format!("idempotency result write failed: {error}")))?;
    Ok(())
}

fn validate_mutation(
    mutation: &RemoteMutationIdentity,
    result: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    parse_uuid_value(&mutation.idempotency_key)?;
    if mutation.request_hash.len() != 64
        || !mutation
            .request_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || mutation.expected_revision > MAX_SAFE_INTEGER
        || result.len() > 256 * 1024
        || now_ms < 0
    {
        return Err(invalid("invalid sidebar content mutation"));
    }
    Ok(())
}

fn parse_uuid_value(value: &str) -> Result<Uuid, StorageError> {
    Uuid::parse_str(value).map_err(|_| invalid("invalid UUID"))
}
fn sql_u64(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| invalid("integer exceeds SQLite range"))
}
fn json_sql(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
const fn side(value: SidebarSide) -> &'static str {
    match value {
        SidebarSide::Left => "left",
        SidebarSide::Right => "right",
    }
}
const fn surface(value: SidebarSurface) -> &'static str {
    match value {
        SidebarSurface::TextBox => "textBox",
        SidebarSurface::Vault => "vault",
        SidebarSurface::TaskManager => "taskManager",
        SidebarSurface::Files => "files",
        SidebarSurface::Markdown => "markdown",
        SidebarSurface::Diff => "diff",
        SidebarSurface::Search => "search",
        SidebarSurface::RecentlyClosed => "recentlyClosed",
    }
}
fn invalid(message: &str) -> StorageError {
    StorageError::InvalidIdempotencyRequest {
        message: message.to_owned(),
    }
}

fn corrupt(path: &Path, message: &str) -> StorageError {
    StorageError::CorruptSchema {
        path: path.to_path_buf(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_core::ShortcutPlatform;
    use tempfile::tempdir;

    fn mutation(seed: u128, expected_revision: u64) -> RemoteMutationIdentity {
        RemoteMutationIdentity {
            idempotency_key: Uuid::from_u128(seed).to_string(),
            request_hash: "a".repeat(64),
            expected_revision,
        }
    }

    fn task_confirmation(seed: u128) -> TaskConfirmation {
        TaskConfirmation {
            invocation_id: Uuid::from_u128(seed).to_string(),
            action: TaskActionKind::Terminate,
            kind: TaskKind::Agent,
            target: TaskTarget {
                session_id: Uuid::from_u128(seed + 1).to_string(),
                generation: 2,
                revision: 3,
            },
            provider_id: Uuid::from_u128(seed + 2).to_string(),
            provider_epoch: 4,
            provider_lease_id: Uuid::from_u128(seed + 3).to_string(),
            window_id: Uuid::from_u128(seed + 4).to_string(),
            window_generation: 5,
            request_hash: "a".repeat(64),
            nonce: Uuid::from_u128(seed + 5).to_string(),
            expires_at_ms: 20_000,
        }
    }

    #[test]
    fn task_confirmation_is_exact_one_shot_and_same_request_can_converge() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("state.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let confirmation = task_confirmation(100);
        let mutation = RemoteMutationIdentity {
            idempotency_key: Uuid::from_u128(200).to_string(),
            request_hash: confirmation.request_hash.clone(),
            expected_revision: confirmation.target.revision,
        };
        store
            .create_task_confirmation_exact(&confirmation, 1_000)
            .unwrap();
        assert_eq!(
            store
                .consume_task_confirmation_exact(&confirmation, &mutation, 2_000)
                .unwrap(),
            TaskConfirmationConsumeOutcome::Consumed
        );
        assert_eq!(
            store
                .consume_task_confirmation_exact(&confirmation, &mutation, 2_001)
                .unwrap(),
            TaskConfirmationConsumeOutcome::Replay
        );
        let mut forged = confirmation.clone();
        forged.window_generation += 1;
        assert_eq!(
            store
                .consume_task_confirmation_exact(&forged, &mutation, 2_002)
                .unwrap(),
            TaskConfirmationConsumeOutcome::AlreadyConsumed
        );

        let stale = task_confirmation(300);
        let stale_mutation = RemoteMutationIdentity {
            idempotency_key: Uuid::from_u128(400).to_string(),
            request_hash: stale.request_hash.clone(),
            expected_revision: stale.target.revision + 1,
        };
        store.create_task_confirmation_exact(&stale, 1_000).unwrap();
        assert_eq!(
            store
                .consume_task_confirmation_exact(&stale, &stale_mutation, 2_000)
                .unwrap(),
            TaskConfirmationConsumeOutcome::Conflict
        );
        assert_eq!(
            store
                .consume_task_confirmation_exact(&stale, &stale_mutation, 2_001)
                .unwrap(),
            TaskConfirmationConsumeOutcome::AlreadyConsumed
        );
    }

    #[test]
    fn task_provider_loss_outcome_replays_exactly() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("state.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let confirmation = task_confirmation(500);
        let mutation = RemoteMutationIdentity {
            idempotency_key: Uuid::from_u128(600).to_string(),
            request_hash: confirmation.request_hash.clone(),
            expected_revision: confirmation.target.revision,
        };
        let result = r#"{"outcome":"providerLost"}"#;
        assert_eq!(
            store
                .record_task_action_outcome_exact(
                    Uuid::parse_str(&confirmation.invocation_id).unwrap(),
                    confirmation.action,
                    confirmation.kind,
                    &confirmation.target,
                    &mutation,
                    result,
                    1_000,
                )
                .unwrap(),
            SidebarContentMutationOutcome::Applied
        );
        assert_eq!(
            store
                .load_task_action_outcome_exact(
                    confirmation.action,
                    confirmation.kind,
                    &confirmation.target,
                    &mutation,
                )
                .unwrap(),
            SidebarContentMutationOutcome::Replay(result.into())
        );
    }

    #[test]
    fn placement_and_text_box_mutations_replay_exactly() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("state.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let window_id = Uuid::from_u128(1);
        let placement = SidebarPlacement {
            window_id: window_id.to_string(),
            revision: 1,
            side: SidebarSide::Right,
            width: 320,
            enabled: SidebarSurface::ALL.to_vec(),
            order: SidebarSurface::ALL.to_vec(),
            selected: SidebarSurface::TextBox,
        };
        let placement_result = serde_json::to_string(&placement).unwrap();
        assert_eq!(
            store
                .save_sidebar_placement_exact(&placement, &mutation(2, 0), &placement_result, 1,)
                .unwrap(),
            SidebarContentMutationOutcome::Applied
        );
        assert_eq!(
            store
                .save_sidebar_placement_exact(&placement, &mutation(2, 0), &placement_result, 2,)
                .unwrap(),
            SidebarContentMutationOutcome::Replay(placement_result)
        );

        let create = TextBoxCreateParams {
            text_box_document_id: Uuid::from_u128(3).to_string(),
            workspace_id: Uuid::from_u128(4).to_string(),
            window_id: window_id.to_string(),
            title: "note".into(),
            text: "private text".into(),
            mutation: mutation(5, 0),
        };
        let result = "{\"result\":\"created\"}";
        assert_eq!(
            store
                .create_text_box_document_exact(&create, result, 3)
                .unwrap(),
            SidebarContentMutationOutcome::Applied
        );
        assert_eq!(
            store
                .create_text_box_document_exact(&create, result, 4)
                .unwrap(),
            SidebarContentMutationOutcome::Replay(result.into())
        );
        assert_eq!(store.list_text_box_documents(None, 1).unwrap().0.len(), 1);
    }

    #[test]
    fn text_box_conflicts_never_overwrite() {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("state.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let id = Uuid::from_u128(10);
        let create = TextBoxCreateParams {
            text_box_document_id: id.to_string(),
            workspace_id: Uuid::from_u128(11).to_string(),
            window_id: Uuid::from_u128(12).to_string(),
            title: "note".into(),
            text: "first".into(),
            mutation: mutation(13, 0),
        };
        store
            .create_text_box_document_exact(&create, "{}", 1)
            .unwrap();
        let save = TextBoxSaveParams {
            text_box_document_id: id.to_string(),
            expected_revision: 2,
            title: "note".into(),
            text: "attacker".into(),
            mutation: mutation(14, 2),
        };
        assert_eq!(
            store.save_text_box_document_exact(&save, "{}", 2).unwrap(),
            SidebarContentMutationOutcome::StaleRevision
        );
        assert_eq!(
            store.load_text_box_document(id).unwrap().unwrap().text,
            "first"
        );
    }
}

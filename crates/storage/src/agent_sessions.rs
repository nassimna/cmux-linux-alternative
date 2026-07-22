//! Metadata-only durable agent-session catalog.
//!
//! These tables deliberately cannot contain prompts, transcripts, commands, runtime identifiers,
//! credentials, or adapter payloads. Adapter artifacts are represented only by a kind, format
//! version, and SHA-256 digest.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::{
    MAX_SAFE_INTEGER, SqliteStateStore, StorageError, create_owner_only_file, database_error,
    prepare_parent_directory, secure_database_file, secure_directory, verify_table_schema,
};

/// Maximum number of durable agent sessions.
pub const AGENT_SESSION_CAP: usize = 512;
/// Maximum number of durable teams.
pub const AGENT_TEAM_CAP: usize = 64;
/// Maximum number of members in one team.
pub const AGENT_TEAM_MEMBER_CAP: usize = 64;

pub(crate) const AGENT_SESSION_CAP_I64: i64 = 512;
const AGENT_TEAM_CAP_I64: i64 = 64;
const AGENT_TEAM_MEMBER_CAP_I64: i64 = 64;
const MAX_TITLE_CHARS: usize = 160;
const MAX_ROLE_CHARS: usize = 80;
const MAX_TOKEN_CHARS: usize = 64;

pub(crate) const EXPECTED_AGENT_CATALOG_STATE_SCHEMA: &str = "CREATE TABLE agent_catalog_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991)
)";
pub(crate) const EXPECTED_AGENT_SESSIONS_SCHEMA: &str = "CREATE TABLE agent_sessions (
    agent_session_id TEXT PRIMARY KEY CHECK (length(agent_session_id) = 36),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
    pane_id TEXT NOT NULL CHECK (length(pane_id) = 36),
    tab_id TEXT NOT NULL CHECK (length(tab_id) = 36),
    adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 64),
    adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('created', 'launching', 'running', 'waiting', 'checkpointing', 'hibernated', 'completed', 'failed', 'unavailable')),
    durable_intent TEXT NOT NULL CHECK (durable_intent IN ('none', 'launch', 'restore', 'fork', 'hibernate')),
    restore_level TEXT NOT NULL CHECK (restore_level IN ('liveReattach', 'toolResume', 'layoutRestart', 'unavailable')),
    restore_outcome TEXT CHECK (restore_outcome IS NULL OR restore_outcome IN ('liveReattached', 'resumeAttempting', 'resumed', 'layoutRestarted', 'unavailable')),
    hibernation_state TEXT CHECK (hibernation_state IS NULL OR hibernation_state IN ('requested', 'preflight', 'confirmationRequired', 'checkpointing', 'checkpointVerified', 'processDispositionPending', 'hibernated', 'canceled', 'failed', 'interrupted')),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch BETWEEN 1 AND 9007199254740991),
    evidence_epoch INTEGER NOT NULL CHECK (evidence_epoch BETWEEN 1 AND 9007199254740991),
    last_verified_at_ms INTEGER NOT NULL CHECK (last_verified_at_ms >= 0),
    forked_from_agent_session_id TEXT CHECK (forked_from_agent_session_id IS NULL OR length(forked_from_agent_session_id) = 36),
    fork_artifact_kind TEXT CHECK (fork_artifact_kind IS NULL OR length(fork_artifact_kind) BETWEEN 1 AND 64),
    fork_artifact_version INTEGER CHECK (fork_artifact_version IS NULL OR fork_artifact_version BETWEEN 1 AND 65535),
    fork_artifact_digest TEXT CHECK (fork_artifact_digest IS NULL OR length(fork_artifact_digest) = 64),
    checkpoint_kind TEXT CHECK (checkpoint_kind IS NULL OR length(checkpoint_kind) BETWEEN 1 AND 64),
    checkpoint_version INTEGER CHECK (checkpoint_version IS NULL OR checkpoint_version BETWEEN 1 AND 65535),
    checkpoint_digest TEXT CHECK (checkpoint_digest IS NULL OR length(checkpoint_digest) = 64),
    checkpoint_verified_at_ms INTEGER,
    checkpoint_expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK ((forked_from_agent_session_id IS NULL AND fork_artifact_kind IS NULL AND fork_artifact_version IS NULL AND fork_artifact_digest IS NULL) OR (forked_from_agent_session_id IS NOT NULL AND fork_artifact_kind IS NOT NULL AND fork_artifact_version IS NOT NULL AND fork_artifact_digest IS NOT NULL)),
    CHECK ((checkpoint_kind IS NULL AND checkpoint_version IS NULL AND checkpoint_digest IS NULL AND checkpoint_verified_at_ms IS NULL AND checkpoint_expires_at_ms IS NULL) OR (checkpoint_kind IS NOT NULL AND checkpoint_version IS NOT NULL AND checkpoint_digest IS NOT NULL AND checkpoint_verified_at_ms IS NOT NULL AND checkpoint_expires_at_ms > checkpoint_verified_at_ms))
)";
pub(crate) const EXPECTED_AGENT_TASK_DISPOSITIONS_SCHEMA: &str = "CREATE TABLE agent_task_dispositions (
    agent_session_id TEXT PRIMARY KEY CHECK (length(agent_session_id) = 36),
    attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch BETWEEN 1 AND 9007199254740991),
    expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740991),
    completed_revision INTEGER NOT NULL CHECK (completed_revision BETWEEN 1 AND 9007199254740991),
    disposition TEXT NOT NULL CHECK (disposition IN ('taskCancelled', 'taskTerminated', 'taskForceTerminated')),
    disposed_at_ms INTEGER NOT NULL CHECK (disposed_at_ms >= 0),
    FOREIGN KEY(agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE
)";
pub(crate) const EXPECTED_AGENT_TEAMS_SCHEMA: &str = "CREATE TABLE agent_teams (
    team_id TEXT PRIMARY KEY CHECK (length(team_id) = 36),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
)";
pub(crate) const EXPECTED_AGENT_TEAM_MEMBERS_SCHEMA: &str = "CREATE TABLE agent_team_members (
    member_id TEXT PRIMARY KEY CHECK (length(member_id) = 36),
    team_id TEXT NOT NULL CHECK (length(team_id) = 36),
    role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 80),
    target_agent_session_id TEXT NOT NULL UNIQUE CHECK (length(target_agent_session_id) = 36),
    target_workspace_id TEXT NOT NULL CHECK (length(target_workspace_id) = 36),
    target_pane_id TEXT NOT NULL CHECK (length(target_pane_id) = 36),
    target_tab_id TEXT NOT NULL CHECK (length(target_tab_id) = 36),
    parent_member_id TEXT CHECK (parent_member_id IS NULL OR length(parent_member_id) = 36),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    FOREIGN KEY(team_id) REFERENCES agent_teams(team_id) ON DELETE CASCADE,
    FOREIGN KEY(target_agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE RESTRICT,
    FOREIGN KEY(parent_member_id) REFERENCES agent_team_members(member_id) ON DELETE RESTRICT,
    CHECK (parent_member_id IS NULL OR parent_member_id <> member_id)
)";
pub(crate) const EXPECTED_AGENT_ATTENTION_SCHEMA: &str = "CREATE TABLE agent_attention (
    agent_session_id TEXT PRIMARY KEY CHECK (length(agent_session_id) = 36),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
    pane_id TEXT NOT NULL CHECK (length(pane_id) = 36),
    tab_id TEXT NOT NULL CHECK (length(tab_id) = 36),
    team_id TEXT CHECK (team_id IS NULL OR length(team_id) = 36),
    member_id TEXT CHECK (member_id IS NULL OR length(member_id) = 36),
    state TEXT NOT NULL CHECK (state IN ('informational', 'completed', 'waiting', 'urgent')),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    FOREIGN KEY(agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    FOREIGN KEY(team_id) REFERENCES agent_teams(team_id) ON DELETE CASCADE,
    FOREIGN KEY(member_id) REFERENCES agent_team_members(member_id) ON DELETE CASCADE,
    CHECK ((team_id IS NULL AND member_id IS NULL) OR (team_id IS NOT NULL AND member_id IS NOT NULL))
)";
pub(crate) const EXPECTED_AGENT_OPERATIONS_SCHEMA: &str = "CREATE TABLE agent_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
    namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 64),
    agent_session_id TEXT NOT NULL CHECK (length(agent_session_id) = 36),
    session_revision INTEGER NOT NULL CHECK (session_revision BETWEEN 1 AND 9007199254740991),
    attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch BETWEEN 1 AND 9007199254740991),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'interrupted')),
    terminal_code TEXT CHECK (terminal_code IS NULL OR length(terminal_code) BETWEEN 1 AND 64),
    accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= accepted_at_ms),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= accepted_at_ms),
    UNIQUE(namespace, operation_id),
    FOREIGN KEY(agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    CHECK ((state = 'pending' AND terminal_code IS NULL AND terminal_at_ms IS NULL) OR (state <> 'pending' AND terminal_code IS NOT NULL AND terminal_at_ms IS NOT NULL))
)";
pub(crate) const EXPECTED_AGENT_CATALOG_MUTATIONS_SCHEMA: &str = "CREATE TABLE agent_catalog_mutations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL CHECK (namespace IN ('teamCreate', 'teamUpdate', 'teamDelete', 'memberCreate', 'memberUpdate', 'memberMove', 'memberDelete')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    expected_catalog_revision INTEGER NOT NULL CHECK (expected_catalog_revision BETWEEN 0 AND 9007199254740991),
    expected_team_revision INTEGER CHECK (expected_team_revision IS NULL OR expected_team_revision BETWEEN 1 AND 9007199254740991),
    expected_member_revision INTEGER CHECK (expected_member_revision IS NULL OR expected_member_revision BETWEEN 1 AND 9007199254740991),
    terminal_code TEXT NOT NULL CHECK (terminal_code IN ('applied', 'staleCatalog', 'staleTeam', 'staleMember', 'resourceLimit', 'dependencyConflict')),
    result_metadata_json TEXT CHECK (result_metadata_json IS NULL OR length(result_metadata_json) BETWEEN 2 AND 65536),
    completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
    UNIQUE(namespace, idempotency_key),
    CHECK ((terminal_code = 'applied' AND result_metadata_json IS NOT NULL) OR (terminal_code <> 'applied' AND result_metadata_json IS NULL))
)";
pub(crate) const EXPECTED_AGENT_CONFIRMATIONS_SCHEMA: &str =
    "CREATE TABLE agent_hibernation_confirmations (
    confirmation_id TEXT PRIMARY KEY CHECK (length(confirmation_id) = 36),
    agent_session_id TEXT NOT NULL CHECK (length(agent_session_id) = 36),
    session_revision INTEGER NOT NULL CHECK (session_revision BETWEEN 1 AND 9007199254740991),
    attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch BETWEEN 1 AND 9007199254740991),
    choice TEXT NOT NULL CHECK (choice IN ('leaveRunning', 'terminateAfterWarning')),
    provider_id TEXT NOT NULL CHECK (length(provider_id) = 36),
    provider_epoch INTEGER NOT NULL CHECK (provider_epoch BETWEEN 1 AND 9007199254740991),
    provider_lease_id TEXT NOT NULL CHECK (length(provider_lease_id) = 36),
    window_id TEXT NOT NULL CHECK (length(window_id) = 36),
    window_generation INTEGER NOT NULL CHECK (window_generation BETWEEN 1 AND 9007199254740991),
    nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    consumed_at_ms INTEGER,
    FOREIGN KEY(agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE
)";
pub(crate) const EXPECTED_AGENT_FORK_ORPHANS_SCHEMA: &str =
    "CREATE TABLE agent_fork_orphans (
    destination_agent_session_id TEXT PRIMARY KEY CHECK (length(destination_agent_session_id) = 36),
    source_agent_session_id TEXT NOT NULL CHECK (length(source_agent_session_id) = 36),
    adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 64),
    adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
    operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    artifact_kind TEXT NOT NULL CHECK (length(artifact_kind) BETWEEN 1 AND 64),
    artifact_version INTEGER NOT NULL CHECK (artifact_version BETWEEN 1 AND 65535),
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
    cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending', 'archiveFailed')),
    cleanup_attempts INTEGER NOT NULL CHECK (cleanup_attempts BETWEEN 0 AND 9007199254740991),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    FOREIGN KEY(source_agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE RESTRICT
)";
pub(crate) const EXPECTED_AGENT_HIBERNATION_DISPOSITIONS_SCHEMA: &str =
    "CREATE TABLE agent_hibernation_dispositions (
    agent_session_id TEXT PRIMARY KEY CHECK (length(agent_session_id) = 36),
    confirmation_id TEXT NOT NULL UNIQUE CHECK (length(confirmation_id) = 36),
    outcome TEXT NOT NULL CHECK (outcome = 'terminatedAfterWarning'),
    disposed_at_ms INTEGER NOT NULL CHECK (disposed_at_ms >= 0),
    FOREIGN KEY(agent_session_id) REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE
)";
pub(crate) const EXPECTED_AGENT_HIBERNATION_CHALLENGE_REPLAY_SCHEMA: &str =
    "CREATE TABLE agent_hibernation_challenge_replay (
    operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
    confirmation_id TEXT NOT NULL UNIQUE CHECK (length(confirmation_id) = 36),
    FOREIGN KEY(confirmation_id) REFERENCES agent_hibernation_confirmations(confirmation_id) ON DELETE CASCADE
)";

/// Creates schema-v9 metadata tables in one migration transaction.
pub(crate) fn migrate_to_v9(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(&format!(
        "{EXPECTED_AGENT_CATALOG_STATE_SCHEMA};INSERT INTO agent_catalog_state VALUES (1, 0);{EXPECTED_AGENT_SESSIONS_SCHEMA};{EXPECTED_AGENT_TEAMS_SCHEMA};{EXPECTED_AGENT_TEAM_MEMBERS_SCHEMA};{EXPECTED_AGENT_ATTENTION_SCHEMA};{EXPECTED_AGENT_OPERATIONS_SCHEMA};{EXPECTED_AGENT_CATALOG_MUTATIONS_SCHEMA};{EXPECTED_AGENT_CONFIRMATIONS_SCHEMA};UPDATE migration_metadata SET target_version = 9 WHERE singleton = 1;PRAGMA user_version = 9;"
    ))
}

pub(crate) fn migrate_to_v13(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    for (table, schema) in [
        ("agent_fork_orphans", EXPECTED_AGENT_FORK_ORPHANS_SCHEMA),
        (
            "agent_hibernation_dispositions",
            EXPECTED_AGENT_HIBERNATION_DISPOSITIONS_SCHEMA,
        ),
        (
            "agent_hibernation_challenge_replay",
            EXPECTED_AGENT_HIBERNATION_CHALLENGE_REPLAY_SCHEMA,
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
        "UPDATE migration_metadata SET target_version = 13 WHERE singleton = 1;PRAGMA user_version = 13;",
    )
}

pub(crate) fn verify_v13_schema(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    verify_table_schema(
        connection,
        path,
        "agent_fork_orphans",
        EXPECTED_AGENT_FORK_ORPHANS_SCHEMA,
        13,
    )?;
    verify_table_schema(
        connection,
        path,
        "agent_hibernation_dispositions",
        EXPECTED_AGENT_HIBERNATION_DISPOSITIONS_SCHEMA,
        13,
    )?;
    verify_table_schema(
        connection,
        path,
        "agent_hibernation_challenge_replay",
        EXPECTED_AGENT_HIBERNATION_CHALLENGE_REPLAY_SCHEMA,
        13,
    )
}

pub(crate) fn verify_schema(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    for (table, schema) in [
        ("agent_catalog_state", EXPECTED_AGENT_CATALOG_STATE_SCHEMA),
        ("agent_sessions", EXPECTED_AGENT_SESSIONS_SCHEMA),
        ("agent_teams", EXPECTED_AGENT_TEAMS_SCHEMA),
        ("agent_team_members", EXPECTED_AGENT_TEAM_MEMBERS_SCHEMA),
        ("agent_attention", EXPECTED_AGENT_ATTENTION_SCHEMA),
        ("agent_operations", EXPECTED_AGENT_OPERATIONS_SCHEMA),
        (
            "agent_catalog_mutations",
            EXPECTED_AGENT_CATALOG_MUTATIONS_SCHEMA,
        ),
        (
            "agent_hibernation_confirmations",
            EXPECTED_AGENT_CONFIRMATIONS_SCHEMA,
        ),
    ] {
        verify_table_schema(connection, path, table, schema, 9)?;
    }
    Ok(())
}

macro_rules! string_enum {
    ($(#[$meta:meta])* $visibility:vis enum $name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        $(#[$meta])*
        $visibility enum $name { $($variant),+ }
        impl $name {
            fn as_str(self) -> &'static str { match self { $(Self::$variant => $value),+ } }
            fn parse(value: &str) -> rusqlite::Result<Self> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(rusqlite::Error::InvalidQuery) }
            }
        }
    };
}

string_enum! { #[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum AgentLifecycleRecord {
    Created => "created", Launching => "launching", Running => "running", Waiting => "waiting",
    Checkpointing => "checkpointing", Hibernated => "hibernated", Completed => "completed",
    Failed => "failed", Unavailable => "unavailable"
}}
string_enum! { #[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum AgentRestoreLevelRecord {
    LiveReattach => "liveReattach", ToolResume => "toolResume", LayoutRestart => "layoutRestart",
    Unavailable => "unavailable"
}}
string_enum! { #[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum AgentRestoreOutcomeRecord {
    LiveReattached => "liveReattached", ResumeAttempting => "resumeAttempting", Resumed => "resumed",
    LayoutRestarted => "layoutRestarted", Unavailable => "unavailable"
}}
string_enum! { #[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum AgentAttentionStateRecord {
    Informational => "informational", Completed => "completed", Waiting => "waiting", Urgent => "urgent"
}}
string_enum! { #[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum AgentOperationStateRecord {
    Pending => "pending", Succeeded => "succeeded", Failed => "failed", Interrupted => "interrupted"
}}
string_enum! { #[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum AgentHibernationStateRecord {
    Requested => "requested", Preflight => "preflight", ConfirmationRequired => "confirmationRequired",
    Checkpointing => "checkpointing", CheckpointVerified => "checkpointVerified",
    ProcessDispositionPending => "processDispositionPending", Hibernated => "hibernated",
    TerminatedAfterWarning => "terminatedAfterWarning",
    Canceled => "canceled", Failed => "failed", Interrupted => "interrupted"
}}

impl AgentHibernationStateRecord {
    /// Returns whether the closed hibernation state machine permits `next`.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use AgentHibernationStateRecord as S;
        matches!(
            (self, next),
            (S::Requested, S::Preflight | S::Canceled | S::Failed)
                | (
                    S::Preflight,
                    S::ConfirmationRequired | S::Checkpointing | S::Canceled | S::Failed
                )
                | (
                    S::ConfirmationRequired,
                    S::Checkpointing | S::ProcessDispositionPending | S::Canceled | S::Failed
                )
                | (
                    S::Checkpointing,
                    S::CheckpointVerified | S::Failed | S::Interrupted
                )
                | (
                    S::CheckpointVerified,
                    S::ConfirmationRequired | S::ProcessDispositionPending | S::Failed
                )
                | (
                    S::ProcessDispositionPending,
                    S::Hibernated | S::TerminatedAfterWarning | S::Failed | S::Interrupted
                )
        )
    }
}

impl AgentLifecycleRecord {
    /// Returns whether the closed lifecycle permits a transition to `next`.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use AgentLifecycleRecord as S;
        matches!(
            (self, next),
            (S::Created | S::Hibernated, S::Launching)
                | (S::Launching, S::Running | S::Failed | S::Unavailable)
                | (
                    S::Running,
                    S::Waiting | S::Checkpointing | S::Completed | S::Failed | S::Unavailable
                )
                | (
                    S::Waiting,
                    S::Running | S::Checkpointing | S::Completed | S::Failed | S::Unavailable
                )
                | (
                    S::Checkpointing,
                    S::Hibernated | S::Running | S::Waiting | S::Failed | S::Unavailable
                )
        )
    }
    #[must_use]
    pub const fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Unavailable)
    }
}

/// Exact workspace/pane/tab/session binding.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentSessionBindingRecord {
    pub workspace_id: Uuid,
    pub pane_id: Uuid,
    pub tab_id: Uuid,
    pub agent_session_id: Uuid,
}

/// Immutable, payload-free fork provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentForkArtifactRecord {
    pub source_agent_session_id: Uuid,
    pub kind: String,
    pub version: u16,
    pub digest_sha256: String,
}

/// Durable metadata for one session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSessionRecord {
    pub binding: AgentSessionBindingRecord,
    pub adapter_id: String,
    pub adapter_version: String,
    pub title: String,
    pub lifecycle: AgentLifecycleRecord,
    pub durable_intent: String,
    pub restore_level: AgentRestoreLevelRecord,
    pub restore_outcome: Option<AgentRestoreOutcomeRecord>,
    pub hibernation_state: Option<AgentHibernationStateRecord>,
    pub revision: u64,
    pub attempt_epoch: u64,
    pub evidence_epoch: u64,
    pub last_verified_at_ms: i64,
    pub forked_from: Option<AgentForkArtifactRecord>,
    pub checkpoint: Option<AgentCheckpointRecord>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Verified checkpoint metadata; artifact bytes and lookup locations are excluded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCheckpointRecord {
    pub kind: String,
    pub version: u16,
    pub digest_sha256: String,
    pub verified_at_ms: i64,
    pub expires_at_ms: i64,
}

/// Validated session insertion request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSessionCreate {
    pub binding: AgentSessionBindingRecord,
    pub adapter_id: String,
    pub adapter_version: String,
    pub title: String,
    pub operation_id: Uuid,
    pub request_hash: String,
    pub attempt_epoch: u64,
    pub now_ms: i64,
    pub forked_from: Option<AgentForkArtifactRecord>,
}

/// Idempotent session creation result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentSessionCreateOutcome {
    Created(AgentSessionRecord),
    Replay(AgentSessionRecord),
    Conflict,
    ResourceLimit,
}

/// Compare-and-swap update for lifecycle and live restore evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSessionUpdate {
    pub agent_session_id: Uuid,
    pub expected_revision: u64,
    pub attempt_epoch: u64,
    pub lifecycle: AgentLifecycleRecord,
    pub durable_intent: String,
    pub restore_level: AgentRestoreLevelRecord,
    pub restore_outcome: Option<AgentRestoreOutcomeRecord>,
    pub hibernation_state: Option<AgentHibernationStateRecord>,
    pub evidence_epoch: u64,
    pub verified_at_ms: i64,
    pub checkpoint: Option<AgentCheckpointRecord>,
}

/// Durable team metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentTeamRecord {
    pub team_id: Uuid,
    pub title: String,
    pub revision: u64,
}
/// Exact member projection and graph edge.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentTeamMemberRecord {
    pub member_id: Uuid,
    pub team_id: Uuid,
    pub role: String,
    pub target: AgentSessionBindingRecord,
    pub parent_member_id: Option<Uuid>,
    pub revision: u64,
}
/// Validated member insertion request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTeamMemberCreate {
    pub member_id: Uuid,
    pub team_id: Uuid,
    pub role: String,
    pub target: AgentSessionBindingRecord,
    pub parent_member_id: Option<Uuid>,
    pub mutation: AgentTeamMutationIdentityRecord,
    pub now_ms: i64,
}

/// Idempotency plus exact catalog compare-and-swap authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCatalogMutationIdentityRecord {
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub expected_catalog_revision: u64,
}

/// Idempotency plus exact catalog/team compare-and-swap authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTeamMutationIdentityRecord {
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub expected_catalog_revision: u64,
    pub expected_team_revision: u64,
}

/// Idempotency plus exact catalog/team/member compare-and-swap authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTeamMemberMutationIdentityRecord {
    pub idempotency_key: Uuid,
    pub request_hash: String,
    pub expected_catalog_revision: u64,
    pub expected_team_revision: u64,
    pub expected_member_revision: u64,
}

/// First-terminal-wins outcome for a catalog/team mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentCatalogMutationOutcome<T> {
    Applied(T),
    Replay(T),
    Conflict,
    StaleCatalog,
    StaleTeam,
    StaleMember,
    ResourceLimit,
    DependencyConflict,
}

/// Exact terminal metadata for team deletion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentTeamDeleteRecord {
    pub team_id: Uuid,
    pub catalog_revision: u64,
    pub deleted_team_revision: u64,
}

/// Exact terminal metadata for member deletion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentTeamMemberDeleteRecord {
    pub team_id: Uuid,
    pub member_id: Uuid,
    pub catalog_revision: u64,
    pub team_revision: u64,
    pub deleted_member_revision: u64,
}
/// Exact durable attention target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttentionRecord {
    pub target: AgentSessionBindingRecord,
    pub team_id: Option<Uuid>,
    pub member_id: Option<Uuid>,
    pub state: AgentAttentionStateRecord,
    pub revision: u64,
}
/// One complete metadata catalog snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCatalogRecord {
    pub revision: u64,
    pub sessions: Vec<AgentSessionRecord>,
    pub teams: Vec<AgentTeamRecord>,
    pub members: Vec<AgentTeamMemberRecord>,
    pub attention: Vec<AgentAttentionRecord>,
}

/// Durable operation intent written before adapter side effects.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentOperationBegin {
    pub operation_id: Uuid,
    pub namespace: String,
    pub agent_session_id: Uuid,
    pub session_revision: u64,
    pub attempt_epoch: u64,
    pub request_hash: String,
    pub now_ms: i64,
}
/// Durable operation record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentOperationRecord {
    pub operation_id: Uuid,
    pub namespace: String,
    pub agent_session_id: Uuid,
    pub session_revision: u64,
    pub attempt_epoch: u64,
    pub request_hash: String,
    pub state: AgentOperationStateRecord,
    pub terminal_code: Option<String>,
}
/// Result of starting an idempotent operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentOperationBeginOutcome {
    Begun(AgentOperationRecord),
    Pending(AgentOperationRecord),
    Replay(AgentOperationRecord),
    Conflict,
}

/// Provider/window-bound short-lived destructive confirmation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentHibernationConfirmationCreate {
    pub confirmation_id: Uuid,
    pub agent_session_id: Uuid,
    pub session_revision: u64,
    pub attempt_epoch: u64,
    pub choice: String,
    pub provider_id: Uuid,
    pub provider_epoch: u64,
    pub provider_lease_id: Uuid,
    pub window_id: Uuid,
    pub window_generation: u64,
    pub nonce_hash: String,
    pub expires_at_ms: i64,
}
/// Stored confirmation metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentHibernationConfirmation {
    pub request: AgentHibernationConfirmationCreate,
    pub consumed_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentHibernationChallengeReplay {
    pub confirmation: AgentHibernationConfirmation,
    pub operation_id: Uuid,
}
/// Exact-once confirmation consumption result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentHibernationConfirmationOutcome {
    Consumed,
    Expired,
    Conflict,
    AlreadyConsumed,
}

/// Durable provenance for an adapter fork that is not yet attached to the catalog.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentForkOrphanRecord {
    pub destination_agent_session_id: Uuid,
    pub source_agent_session_id: Uuid,
    pub adapter_id: String,
    pub adapter_version: String,
    pub operation_id: Uuid,
    pub request_hash: String,
    pub artifact_kind: String,
    pub artifact_version: u16,
    pub artifact_digest_sha256: String,
    pub cleanup_state: String,
    pub cleanup_attempts: u64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl SqliteStateStore {
    /// Writes exact fork provenance to an atomic, owner-only recovery file independent of `SQLite`.
    pub fn persist_agent_fork_orphan_recovery(
        &self,
        orphan: &AgentForkOrphanRecord,
    ) -> Result<(), StorageError> {
        validate_initial_fork_orphan(orphan)?;
        let directory = fork_orphan_recovery_directory(&self.path);
        prepare_parent_directory(&directory)?;
        secure_directory(&directory)?;
        let destination = directory.join(format!(
            "{}.json",
            orphan.destination_agent_session_id.simple()
        ));
        match std::fs::symlink_metadata(&destination) {
            Ok(_) => {
                secure_database_file(&destination)?;
                let existing = decode_fork_orphan_recovery(&destination)?;
                return (existing == *orphan)
                    .then_some(())
                    .ok_or_else(|| invalid("conflicting fork orphan recovery file"));
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(StorageError::Permissions {
                    path: destination,
                    message: source.to_string(),
                });
            }
        }
        let temporary = directory.join(format!(
            "{}.{}.tmp",
            orphan.destination_agent_session_id.simple(),
            Uuid::new_v4().simple()
        ));
        let payload =
            serde_json::to_vec(orphan).map_err(|source| StorageError::Serialize { source })?;
        let mut file =
            create_owner_only_file(&temporary).map_err(|source| StorageError::Permissions {
                path: temporary.clone(),
                message: source.to_string(),
            })?;
        sync_directory(&directory)?;
        if let Err(source) = file.write_all(&payload).and_then(|()| file.sync_all()) {
            let _ = std::fs::remove_file(&temporary);
            return Err(StorageError::Permissions {
                path: temporary,
                message: source.to_string(),
            });
        }
        if let Err(source) = std::fs::rename(&temporary, &destination) {
            let _ = std::fs::remove_file(&temporary);
            return Err(StorageError::Permissions {
                path: destination,
                message: source.to_string(),
            });
        }
        sync_directory(&directory)
    }

    /// Imports all bounded recovery files into `SQLite` before orphan cleanup runs.
    pub fn import_agent_fork_orphan_recovery(&self) -> Result<usize, StorageError> {
        let directory = fork_orphan_recovery_directory(&self.path);
        if !directory.exists() {
            return Ok(0);
        }
        secure_directory(&directory)?;
        let mut paths = std::fs::read_dir(&directory)
            .map_err(|source| StorageError::Permissions {
                path: directory.clone(),
                message: source.to_string(),
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|source| StorageError::Permissions {
                path: directory.clone(),
                message: source.to_string(),
            })?;
        if paths.len() > AGENT_SESSION_CAP {
            return Err(invalid("fork orphan recovery file cap exceeded"));
        }
        paths.sort_by_key(std::fs::DirEntry::file_name);
        let mut imported = 0;
        for entry in paths {
            let path = entry.path();
            secure_database_file(&path)?;
            let orphan = decode_fork_orphan_recovery(&path)?;
            validate_initial_fork_orphan(&orphan)?;
            let existing = self.load_agent_fork_orphans()?.into_iter().find(|record| {
                record.destination_agent_session_id == orphan.destination_agent_session_id
            });
            match existing {
                Some(existing) if existing == orphan => {}
                Some(_) => return Err(invalid("conflicting durable fork orphan provenance")),
                None => self.record_agent_fork_orphan(&orphan)?,
            }
            std::fs::remove_file(&path).map_err(|source| StorageError::Permissions {
                path: path.clone(),
                message: source.to_string(),
            })?;
            imported += 1;
        }
        sync_directory(&directory)?;
        Ok(imported)
    }

    /// Removes the recovery file after `SQLite` provenance or verified compensation is durable.
    pub fn clear_agent_fork_orphan_recovery(&self, destination: Uuid) -> Result<(), StorageError> {
        let directory = fork_orphan_recovery_directory(&self.path);
        let path = directory.join(format!("{}.json", destination.simple()));
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                secure_database_file(&path)?;
                std::fs::remove_file(&path).map_err(|source| StorageError::Permissions {
                    path: path.clone(),
                    message: source.to_string(),
                })?;
                sync_directory(&directory)
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(StorageError::Permissions {
                path,
                message: source.to_string(),
            }),
        }
    }

    /// Records the exact external fork identity before catalog attachment.
    pub fn record_agent_fork_orphan(
        &self,
        orphan: &AgentForkOrphanRecord,
    ) -> Result<(), StorageError> {
        validate_initial_fork_orphan(orphan)?;
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO agent_fork_orphans(destination_agent_session_id,source_agent_session_id,adapter_id,adapter_version,operation_id,request_hash,artifact_kind,artifact_version,artifact_digest,cleanup_state,cleanup_attempts,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',0,?10,?10)",
            params![orphan.destination_agent_session_id.to_string(), orphan.source_agent_session_id.to_string(), orphan.adapter_id, orphan.adapter_version, orphan.operation_id.to_string(), orphan.request_hash, orphan.artifact_kind, i64::from(orphan.artifact_version), orphan.artifact_digest_sha256, orphan.created_at_ms],
        ).map_err(|source| database_error(&self.path, "fork orphan insert", source))?;
        Ok(())
    }

    /// Lists exact unresolved fork identities for bounded startup cleanup.
    pub fn load_agent_fork_orphans(&self) -> Result<Vec<AgentForkOrphanRecord>, StorageError> {
        let connection = self.lock()?;
        query_all(
            &connection,
            "SELECT destination_agent_session_id,source_agent_session_id,adapter_id,adapter_version,operation_id,request_hash,artifact_kind,artifact_version,artifact_digest,cleanup_state,cleanup_attempts,created_at_ms,updated_at_ms FROM agent_fork_orphans ORDER BY created_at_ms,destination_agent_session_id",
            |row| {
                Ok(AgentForkOrphanRecord {
                    destination_agent_session_id: uuid_at(row, 0)?,
                    source_agent_session_id: uuid_at(row, 1)?,
                    adapter_id: row.get(2)?,
                    adapter_version: row.get(3)?,
                    operation_id: uuid_at(row, 4)?,
                    request_hash: row.get(5)?,
                    artifact_kind: row.get(6)?,
                    artifact_version: u16::try_from(row.get::<_, i64>(7)?)
                        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(7, 0))?,
                    artifact_digest_sha256: row.get(8)?,
                    cleanup_state: row.get(9)?,
                    cleanup_attempts: u64_from_i64_sql(row.get(10)?)?,
                    created_at_ms: row.get(11)?,
                    updated_at_ms: row.get(12)?,
                })
            },
            &self.path,
            "fork orphan list",
        )
    }

    /// Records a failed archive attempt without discarding destination provenance.
    pub fn mark_agent_fork_orphan_archive_failed(
        &self,
        destination: Uuid,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        validate_time(now_ms)?;
        let connection = self.lock()?;
        let changed = connection.execute("UPDATE agent_fork_orphans SET cleanup_state='archiveFailed', cleanup_attempts=cleanup_attempts+1, updated_at_ms=?1 WHERE destination_agent_session_id=?2", params![now_ms, destination.to_string()]).map_err(|source| database_error(&self.path, "fork orphan cleanup failure", source))?;
        if changed != 1 {
            return Err(invalid("fork orphan is unavailable"));
        }
        Ok(())
    }

    /// Clears provenance only after catalog attachment or verified archive.
    pub fn clear_agent_fork_orphan(&self, destination: Uuid) -> Result<(), StorageError> {
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM agent_fork_orphans WHERE destination_agent_session_id=?1",
                [destination.to_string()],
            )
            .map_err(|source| database_error(&self.path, "fork orphan clear", source))?;
        Ok(())
    }

    /// Loads the complete bounded agent catalog and validates graph and exact-target integrity.
    pub fn load_agent_catalog(&self) -> Result<AgentCatalogRecord, StorageError> {
        let connection = self.lock()?;
        let revision = catalog_revision(&connection, &self.path)?;
        let sessions = query_all(
            &connection,
            "SELECT agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version, title, lifecycle, durable_intent, restore_level, restore_outcome, CASE WHEN EXISTS (SELECT 1 FROM agent_hibernation_dispositions d WHERE d.agent_session_id=agent_sessions.agent_session_id) THEN 'terminatedAfterWarning' ELSE hibernation_state END, revision, attempt_epoch, evidence_epoch, last_verified_at_ms, forked_from_agent_session_id, fork_artifact_kind, fork_artifact_version, fork_artifact_digest, checkpoint_kind, checkpoint_version, checkpoint_digest, checkpoint_verified_at_ms, checkpoint_expires_at_ms, created_at_ms, updated_at_ms FROM agent_sessions ORDER BY created_at_ms, agent_session_id",
            parse_session,
            &self.path,
            "agent session catalog read",
        )?;
        let teams = query_all(
            &connection,
            "SELECT team_id, title, revision FROM agent_teams ORDER BY created_at_ms, team_id",
            parse_team,
            &self.path,
            "agent team catalog read",
        )?;
        let members = query_all(
            &connection,
            "SELECT member_id, team_id, role, target_agent_session_id, target_workspace_id, target_pane_id, target_tab_id, parent_member_id, revision FROM agent_team_members ORDER BY created_at_ms, member_id",
            parse_member,
            &self.path,
            "agent team member catalog read",
        )?;
        let attention = query_all(
            &connection,
            "SELECT agent_session_id, workspace_id, pane_id, tab_id, team_id, member_id, state, revision FROM agent_attention ORDER BY agent_session_id",
            parse_attention,
            &self.path,
            "agent attention catalog read",
        )?;
        validate_catalog(&sessions, &teams, &members, &attention)?;
        Ok(AgentCatalogRecord {
            revision,
            sessions,
            teams,
            members,
            attention,
        })
    }

    /// Loads one durable session.
    pub fn load_agent_session(&self, id: Uuid) -> Result<Option<AgentSessionRecord>, StorageError> {
        let connection = self.lock()?;
        load_session(&connection, id, &self.path)
    }

    /// Loads a Task Manager disposition only when it belongs to the exact current attempt and
    /// completed session revision.
    pub fn load_agent_task_disposition(
        &self,
        agent_session_id: Uuid,
        attempt_epoch: u64,
        completed_revision: u64,
    ) -> Result<Option<String>, StorageError> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT disposition FROM agent_task_dispositions WHERE agent_session_id=?1 AND attempt_epoch=?2 AND completed_revision=?3",
                params![
                    agent_session_id.to_string(),
                    i64_from_u64(attempt_epoch)?,
                    i64_from_u64(completed_revision)?
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "agent task disposition projection", source))
    }

    /// Creates a session and a terminal registration idempotency record atomically.
    pub fn create_agent_session(
        &self,
        request: &AgentSessionCreate,
    ) -> Result<AgentSessionCreateOutcome, StorageError> {
        validate_session_create(request)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent session create")?;
        if let Some(operation) = load_operation(
            &transaction,
            "catalog.register",
            request.operation_id,
            &self.path,
        )? {
            return Ok(if operation.request_hash == request.request_hash {
                load_session(&transaction, operation.agent_session_id, &self.path)?.map_or(
                    AgentSessionCreateOutcome::Conflict,
                    AgentSessionCreateOutcome::Replay,
                )
            } else {
                AgentSessionCreateOutcome::Conflict
            });
        }
        let count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM agent_sessions", [], |row| row.get(0))
            .map_err(|source| database_error(&self.path, "agent session cap read", source))?;
        if count >= AGENT_SESSION_CAP_I64 {
            return Ok(AgentSessionCreateOutcome::ResourceLimit);
        }
        if load_session(&transaction, request.binding.agent_session_id, &self.path)?.is_some() {
            return Ok(AgentSessionCreateOutcome::Conflict);
        }
        if request
            .forked_from
            .as_ref()
            .is_some_and(|fork| fork.source_agent_session_id == request.binding.agent_session_id)
        {
            return Err(invalid("a fork cannot reference its own fresh identity"));
        }
        if let Some(fork) = &request.forked_from
            && load_session(&transaction, fork.source_agent_session_id, &self.path)?.is_none()
        {
            return Err(invalid("fork source session is unavailable"));
        }
        let fork = request.forked_from.as_ref();
        transaction.execute(
            "INSERT INTO agent_sessions (agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version, title, lifecycle, durable_intent, restore_level, revision, attempt_epoch, evidence_epoch, last_verified_at_ms, forked_from_agent_session_id, fork_artifact_kind, fork_artifact_version, fork_artifact_digest, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'created', ?8, 'unavailable', 1, ?9, 1, ?10, ?11, ?12, ?13, ?14, ?10, ?10)",
            params![request.binding.agent_session_id.to_string(), request.binding.workspace_id.to_string(), request.binding.pane_id.to_string(), request.binding.tab_id.to_string(), request.adapter_id, request.adapter_version, request.title, if fork.is_some() { "fork" } else { "launch" }, i64_from_u64(request.attempt_epoch)?, request.now_ms, fork.map(|v| v.source_agent_session_id.to_string()), fork.map(|v| &v.kind), fork.map(|v| i64::from(v.version)), fork.map(|v| &v.digest_sha256)]
        ).map_err(|source| database_error(&self.path, "agent session insert", source))?;
        insert_terminal_operation(
            &transaction,
            "catalog.register",
            request.operation_id,
            request.binding.agent_session_id,
            1,
            request.attempt_epoch,
            &request.request_hash,
            "registered",
            request.now_ms,
            &self.path,
        )?;
        bump_catalog_revision(&transaction, &self.path)?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent session create commit", source))?;
        drop(connection);
        self.load_agent_session(request.binding.agent_session_id)?
            .map(AgentSessionCreateOutcome::Created)
            .ok_or_else(|| invalid("created session disappeared"))
    }

    /// Atomically records the exact adapter-created UUID and immutable fork provenance.
    #[allow(clippy::too_many_arguments)]
    pub fn fork_agent_session(
        &self,
        source_id: Uuid,
        destination_id: Uuid,
        workspace_id: Uuid,
        pane_id: Uuid,
        tab_id: Uuid,
        title: String,
        artifact_kind: String,
        artifact_version: u16,
        artifact_digest_sha256: String,
        operation_id: Uuid,
        request_hash: String,
        attempt_epoch: u64,
        now_ms: i64,
    ) -> Result<AgentSessionCreateOutcome, StorageError> {
        let source = self
            .load_agent_session(source_id)?
            .ok_or_else(|| invalid("fork source session is unavailable"))?;
        let request = AgentSessionCreate {
            binding: AgentSessionBindingRecord {
                workspace_id,
                pane_id,
                tab_id,
                agent_session_id: destination_id,
            },
            adapter_id: source.adapter_id,
            adapter_version: source.adapter_version,
            title,
            operation_id,
            request_hash,
            attempt_epoch,
            now_ms,
            forked_from: Some(AgentForkArtifactRecord {
                source_agent_session_id: source_id,
                kind: artifact_kind,
                version: artifact_version,
                digest_sha256: artifact_digest_sha256,
            }),
        };
        self.create_agent_session(&request)
    }

    /// Applies a monotonic compare-and-swap lifecycle/restore update.
    pub fn update_agent_session(
        &self,
        update: &AgentSessionUpdate,
    ) -> Result<AgentSessionRecord, StorageError> {
        validate_session_update(update)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent session update")?;
        let current = load_session(&transaction, update.agent_session_id, &self.path)?
            .ok_or_else(|| invalid("agent session is unavailable"))?;
        if current.revision != update.expected_revision {
            return Err(invalid("agent session revision is stale"));
        }
        if current.lifecycle.terminal() && current.lifecycle != update.lifecycle {
            return Err(invalid("terminal session lifecycle cannot revert"));
        }
        if current.lifecycle != update.lifecycle
            && !current.lifecycle.can_transition_to(update.lifecycle)
        {
            return Err(invalid("invalid session lifecycle transition"));
        }
        match (current.hibernation_state, update.hibernation_state) {
            (Some(previous), Some(next))
                if previous == next || previous.can_transition_to(next) => {}
            (Some(AgentHibernationStateRecord::Hibernated), None)
                if current.lifecycle == AgentLifecycleRecord::Hibernated
                    && update.lifecycle == AgentLifecycleRecord::Launching
                    && update.attempt_epoch == current.attempt_epoch.saturating_add(1) => {}
            (None, Some(AgentHibernationStateRecord::Requested) | None) => {}
            _ => return Err(invalid("invalid hibernation state transition")),
        }
        if update.attempt_epoch < current.attempt_epoch
            || update.attempt_epoch > current.attempt_epoch.saturating_add(1)
        {
            return Err(invalid("attempt epoch is stale or skipped"));
        }
        if update.evidence_epoch < current.evidence_epoch
            || update.verified_at_ms < current.last_verified_at_ms
        {
            return Err(invalid("restore evidence is stale"));
        }
        if update
            .checkpoint
            .as_ref()
            .is_some_and(|value| value.verified_at_ms != update.verified_at_ms)
        {
            return Err(invalid(
                "checkpoint verification time must match session observation",
            ));
        }
        let checkpoint = update.checkpoint.as_ref();
        let changed = transaction.execute(
            "UPDATE agent_sessions SET lifecycle = ?1, durable_intent = ?2, restore_level = ?3, restore_outcome = ?4, hibernation_state = ?5, revision = revision + 1, attempt_epoch = ?6, evidence_epoch = ?7, last_verified_at_ms = ?8, checkpoint_kind = ?9, checkpoint_version = ?10, checkpoint_digest = ?11, checkpoint_verified_at_ms = ?12, checkpoint_expires_at_ms = ?13, updated_at_ms = ?8 WHERE agent_session_id = ?14 AND revision = ?15",
            params![update.lifecycle.as_str(), update.durable_intent, update.restore_level.as_str(), update.restore_outcome.map(AgentRestoreOutcomeRecord::as_str), update.hibernation_state.map(AgentHibernationStateRecord::as_str), i64_from_u64(update.attempt_epoch)?, i64_from_u64(update.evidence_epoch)?, update.verified_at_ms, checkpoint.map(|v| &v.kind), checkpoint.map(|v| i64::from(v.version)), checkpoint.map(|v| &v.digest_sha256), checkpoint.map(|v| v.verified_at_ms), checkpoint.map(|v| v.expires_at_ms), update.agent_session_id.to_string(), i64_from_u64(update.expected_revision)?]
        ).map_err(|source| database_error(&self.path, "agent session update", source))?;
        if changed != 1 {
            return Err(invalid("agent session revision raced"));
        }
        bump_catalog_revision(&transaction, &self.path)?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent session update commit", source))?;
        drop(connection);
        self.load_agent_session(update.agent_session_id)?
            .ok_or_else(|| invalid("updated session disappeared"))
    }

    /// Creates a bounded durable team.
    pub fn create_agent_team(
        &self,
        team_id: Uuid,
        title: &str,
        mutation: &AgentCatalogMutationIdentityRecord,
        now_ms: i64,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamRecord>, StorageError> {
        validate_text(title, MAX_TITLE_CHARS, "team title")?;
        validate_catalog_mutation(mutation)?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent team create")?;
        let fence = MutationFence::catalog("teamCreate", mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if catalog_revision(&transaction, &self.path)? != mutation.expected_catalog_revision {
            record_catalog_mutation::<AgentTeamRecord>(
                &transaction,
                &fence,
                "staleCatalog",
                None,
                now_ms,
                &self.path,
            )?;
            transaction
                .commit()
                .map_err(|source| database_error(&self.path, "stale team create commit", source))?;
            return Ok(AgentCatalogMutationOutcome::StaleCatalog);
        }
        let count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM agent_teams", [], |row| row.get(0))
            .map_err(|source| database_error(&self.path, "agent team cap read", source))?;
        if count >= AGENT_TEAM_CAP_I64 {
            record_catalog_mutation::<AgentTeamRecord>(
                &transaction,
                &fence,
                "resourceLimit",
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "team resource limit commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::ResourceLimit);
        }
        transaction.execute("INSERT INTO agent_teams (team_id, title, revision, created_at_ms, updated_at_ms) VALUES (?1, ?2, 1, ?3, ?3)", params![team_id.to_string(), title, now_ms]).map_err(|source| database_error(&self.path, "agent team insert", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamRecord {
            team_id,
            title: title.to_owned(),
            revision: 1,
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            now_ms,
            &self.path,
        )?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent team create commit", source))?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Atomically updates a team title with an exact revision fence.
    pub fn update_agent_team(
        &self,
        team_id: Uuid,
        title: &str,
        mutation: &AgentTeamMutationIdentityRecord,
        now_ms: i64,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamRecord>, StorageError> {
        validate_text(title, MAX_TITLE_CHARS, "team title")?;
        validate_team_mutation(mutation)?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent team update")?;
        let fence = MutationFence::team("teamUpdate", mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if catalog_revision(&transaction, &self.path)? != mutation.expected_catalog_revision {
            record_catalog_mutation::<AgentTeamRecord>(
                &transaction,
                &fence,
                "staleCatalog",
                None,
                now_ms,
                &self.path,
            )?;
            transaction
                .commit()
                .map_err(|source| database_error(&self.path, "stale team update commit", source))?;
            return Ok(AgentCatalogMutationOutcome::StaleCatalog);
        }
        if team_revision(&transaction, team_id, &self.path)?
            != Some(mutation.expected_team_revision)
        {
            record_catalog_mutation::<AgentTeamRecord>(
                &transaction,
                &fence,
                "staleTeam",
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale team revision commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::StaleTeam);
        }
        let changed = transaction
            .execute(
                "UPDATE agent_teams SET title = ?1, revision = revision + 1, updated_at_ms = ?2 WHERE team_id = ?3 AND revision = ?4",
                params![title, now_ms, team_id.to_string(), i64_from_u64(mutation.expected_team_revision)?],
            )
            .map_err(|source| database_error(&self.path, "agent team update", source))?;
        if changed != 1 {
            return Err(invalid("agent team revision raced"));
        }
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamRecord {
            team_id,
            title: title.to_owned(),
            revision: mutation.expected_team_revision + 1,
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            now_ms,
            &self.path,
        )?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent team update commit", source))?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Deletes one exact team revision and records a replayable terminal result atomically.
    pub fn delete_agent_team(
        &self,
        team_id: Uuid,
        mutation: &AgentTeamMutationIdentityRecord,
        now_ms: i64,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamDeleteRecord>, StorageError> {
        validate_team_mutation(mutation)?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent team delete")?;
        let fence = MutationFence::team("teamDelete", mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if catalog_revision(&transaction, &self.path)? != mutation.expected_catalog_revision {
            record_catalog_mutation::<AgentTeamDeleteRecord>(
                &transaction,
                &fence,
                "staleCatalog",
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale team delete catalog commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::StaleCatalog);
        }
        if team_revision(&transaction, team_id, &self.path)?
            != Some(mutation.expected_team_revision)
        {
            record_catalog_mutation::<AgentTeamDeleteRecord>(
                &transaction,
                &fence,
                "staleTeam",
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale team delete revision commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::StaleTeam);
        }
        transaction
            .execute(
                "DELETE FROM agent_attention WHERE team_id = ?1",
                [team_id.to_string()],
            )
            .map_err(|source| database_error(&self.path, "team attention delete", source))?;
        transaction
            .execute(
                "UPDATE agent_team_members SET parent_member_id = NULL WHERE team_id = ?1",
                [team_id.to_string()],
            )
            .map_err(|source| database_error(&self.path, "team parent detach", source))?;
        transaction
            .execute(
                "DELETE FROM agent_team_members WHERE team_id = ?1",
                [team_id.to_string()],
            )
            .map_err(|source| database_error(&self.path, "team member delete", source))?;
        let changed = transaction
            .execute(
                "DELETE FROM agent_teams WHERE team_id = ?1 AND revision = ?2",
                params![
                    team_id.to_string(),
                    i64_from_u64(mutation.expected_team_revision)?
                ],
            )
            .map_err(|source| database_error(&self.path, "agent team delete", source))?;
        if changed != 1 {
            return Err(invalid("agent team delete revision raced"));
        }
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamDeleteRecord {
            team_id,
            catalog_revision: mutation.expected_catalog_revision + 1,
            deleted_team_revision: mutation.expected_team_revision,
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            now_ms,
            &self.path,
        )?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent team delete commit", source))?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Adds one unique session-bound member after validating its parent belongs to the same team.
    pub fn add_agent_team_member(
        &self,
        request: &AgentTeamMemberCreate,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamMemberRecord>, StorageError> {
        validate_member_create(request)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent team member add")?;
        let fence = MutationFence::team("memberCreate", &request.mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if catalog_revision(&transaction, &self.path)? != request.mutation.expected_catalog_revision
        {
            record_catalog_mutation::<AgentTeamMemberRecord>(
                &transaction,
                &fence,
                "staleCatalog",
                None,
                request.now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale member create catalog commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::StaleCatalog);
        }
        if team_revision(&transaction, request.team_id, &self.path)?
            != Some(request.mutation.expected_team_revision)
        {
            record_catalog_mutation::<AgentTeamMemberRecord>(
                &transaction,
                &fence,
                "staleTeam",
                None,
                request.now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale member create team commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::StaleTeam);
        }
        ensure_exact_binding(&transaction, &request.target, &self.path)?;
        let count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM agent_team_members WHERE team_id = ?1",
                [request.team_id.to_string()],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "agent team member cap read", source))?;
        if count >= AGENT_TEAM_MEMBER_CAP_I64 {
            record_catalog_mutation::<AgentTeamMemberRecord>(
                &transaction,
                &fence,
                "resourceLimit",
                None,
                request.now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "member resource limit commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::ResourceLimit);
        }
        ensure_parent_team(
            &transaction,
            request.team_id,
            request.parent_member_id,
            &self.path,
        )?;
        transaction.execute("INSERT INTO agent_team_members (member_id, team_id, role, target_agent_session_id, target_workspace_id, target_pane_id, target_tab_id, parent_member_id, revision, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)", params![request.member_id.to_string(), request.team_id.to_string(), request.role, request.target.agent_session_id.to_string(), request.target.workspace_id.to_string(), request.target.pane_id.to_string(), request.target.tab_id.to_string(), request.parent_member_id.map(|v| v.to_string()), request.now_ms]).map_err(|source| database_error(&self.path, "agent team member insert", source))?;
        transaction.execute("UPDATE agent_teams SET revision = revision + 1, updated_at_ms = ?1 WHERE team_id = ?2", params![request.now_ms, request.team_id.to_string()]).map_err(|source| database_error(&self.path, "agent team revision update", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamMemberRecord {
            member_id: request.member_id,
            team_id: request.team_id,
            role: request.role.clone(),
            target: request.target.clone(),
            parent_member_id: request.parent_member_id,
            revision: 1,
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            request.now_ms,
            &self.path,
        )?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent team member add commit", source))?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Atomically moves a member and any exact attention projection to a new session binding.
    pub fn move_agent_team_member(
        &self,
        team_id: Uuid,
        member_id: Uuid,
        target: &AgentSessionBindingRecord,
        mutation: &AgentTeamMemberMutationIdentityRecord,
        now_ms: i64,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamMemberRecord>, StorageError> {
        validate_binding(target)?;
        validate_member_mutation(mutation)?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent team member move")?;
        let fence = MutationFence::member("memberMove", mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if let Some(stale) =
            check_member_mutation_fence(&transaction, team_id, member_id, mutation, &self.path)?
        {
            record_catalog_mutation::<AgentTeamMemberRecord>(
                &transaction,
                &fence,
                stale.code(),
                None,
                now_ms,
                &self.path,
            )?;
            transaction
                .commit()
                .map_err(|source| database_error(&self.path, "stale member move commit", source))?;
            return Ok(stale.into_outcome());
        }
        ensure_exact_binding(&transaction, target, &self.path)?;
        let current = load_member_from(&transaction, member_id, &self.path)?
            .ok_or_else(|| invalid("member disappeared after revision check"))?;
        let changed = transaction.execute("UPDATE agent_team_members SET target_agent_session_id = ?1, target_workspace_id = ?2, target_pane_id = ?3, target_tab_id = ?4, revision = revision + 1, updated_at_ms = ?5 WHERE team_id = ?6 AND member_id = ?7 AND revision = ?8", params![target.agent_session_id.to_string(), target.workspace_id.to_string(), target.pane_id.to_string(), target.tab_id.to_string(), now_ms, team_id.to_string(), member_id.to_string(), i64_from_u64(mutation.expected_member_revision)?]).map_err(|source| database_error(&self.path, "agent team member move", source))?;
        if changed != 1 {
            return Err(invalid("team member is unavailable or revision is stale"));
        }
        transaction.execute("UPDATE agent_attention SET agent_session_id = ?1, workspace_id = ?2, pane_id = ?3, tab_id = ?4, revision = revision + 1, updated_at_ms = ?5 WHERE team_id = ?6 AND member_id = ?7", params![target.agent_session_id.to_string(), target.workspace_id.to_string(), target.pane_id.to_string(), target.tab_id.to_string(), now_ms, team_id.to_string(), member_id.to_string()]).map_err(|source| database_error(&self.path, "agent attention retarget", source))?;
        transaction.execute("UPDATE agent_teams SET revision = revision + 1, updated_at_ms = ?1 WHERE team_id = ?2", params![now_ms, team_id.to_string()]).map_err(|source| database_error(&self.path, "agent team move revision", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamMemberRecord {
            target: target.clone(),
            revision: mutation.expected_member_revision + 1,
            ..current
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            now_ms,
            &self.path,
        )?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "agent team member move commit", source)
        })?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Updates a member role/parent while rejecting cross-team parents and cycles.
    pub fn update_agent_team_member(
        &self,
        team_id: Uuid,
        member_id: Uuid,
        role: &str,
        parent_member_id: Option<Uuid>,
        mutation: &AgentTeamMemberMutationIdentityRecord,
        now_ms: i64,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamMemberRecord>, StorageError> {
        validate_text(role, MAX_ROLE_CHARS, "member role")?;
        validate_member_mutation(mutation)?;
        validate_time(now_ms)?;
        let normalized = normalize_role(role);
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent team member update")?;
        let fence = MutationFence::member("memberUpdate", mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if let Some(stale) =
            check_member_mutation_fence(&transaction, team_id, member_id, mutation, &self.path)?
        {
            record_catalog_mutation::<AgentTeamMemberRecord>(
                &transaction,
                &fence,
                stale.code(),
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale member update commit", source)
            })?;
            return Ok(stale.into_outcome());
        }
        ensure_parent_team(&transaction, team_id, parent_member_id, &self.path)?;
        if parent_member_id == Some(member_id)
            || parent_member_id.is_some_and(|parent| {
                reaches_member(&transaction, parent, member_id, &self.path).unwrap_or(true)
            })
        {
            return Err(invalid("team member parent would create a cycle"));
        }
        let current = load_member_from(&transaction, member_id, &self.path)?
            .ok_or_else(|| invalid("member disappeared after revision check"))?;
        let changed = transaction.execute("UPDATE agent_team_members SET role = ?1, parent_member_id = ?2, revision = revision + 1, updated_at_ms = ?3 WHERE team_id = ?4 AND member_id = ?5 AND revision = ?6", params![normalized, parent_member_id.map(|v| v.to_string()), now_ms, team_id.to_string(), member_id.to_string(), i64_from_u64(mutation.expected_member_revision)?]).map_err(|source| database_error(&self.path, "agent team member update", source))?;
        if changed != 1 {
            return Err(invalid("team member is unavailable or revision is stale"));
        }
        transaction.execute("UPDATE agent_teams SET revision = revision + 1, updated_at_ms = ?1 WHERE team_id = ?2", params![now_ms, team_id.to_string()]).map_err(|source| database_error(&self.path, "agent team member revision update", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamMemberRecord {
            role: normalized,
            parent_member_id,
            revision: mutation.expected_member_revision + 1,
            ..current
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            now_ms,
            &self.path,
        )?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "agent team member update commit", source)
        })?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Deletes one exact leaf member revision and preserves its terminal idempotency result.
    pub fn delete_agent_team_member(
        &self,
        team_id: Uuid,
        member_id: Uuid,
        mutation: &AgentTeamMemberMutationIdentityRecord,
        now_ms: i64,
    ) -> Result<AgentCatalogMutationOutcome<AgentTeamMemberDeleteRecord>, StorageError> {
        validate_member_mutation(mutation)?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent member delete")?;
        let fence = MutationFence::member("memberDelete", mutation);
        if let Some(outcome) = load_catalog_mutation(&transaction, &fence, &self.path)? {
            return Ok(outcome);
        }
        if let Some(stale) =
            check_member_mutation_fence(&transaction, team_id, member_id, mutation, &self.path)?
        {
            record_catalog_mutation::<AgentTeamMemberDeleteRecord>(
                &transaction,
                &fence,
                stale.code(),
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "stale member delete commit", source)
            })?;
            return Ok(stale.into_outcome());
        }
        let children: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM agent_team_members WHERE parent_member_id = ?1",
                [member_id.to_string()],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "member child count", source))?;
        if children != 0 {
            record_catalog_mutation::<AgentTeamMemberDeleteRecord>(
                &transaction,
                &fence,
                "dependencyConflict",
                None,
                now_ms,
                &self.path,
            )?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "member dependency conflict commit", source)
            })?;
            return Ok(AgentCatalogMutationOutcome::DependencyConflict);
        }
        transaction
            .execute(
                "DELETE FROM agent_attention WHERE member_id = ?1",
                [member_id.to_string()],
            )
            .map_err(|source| database_error(&self.path, "member attention delete", source))?;
        let changed = transaction.execute("DELETE FROM agent_team_members WHERE team_id = ?1 AND member_id = ?2 AND revision = ?3", params![team_id.to_string(), member_id.to_string(), i64_from_u64(mutation.expected_member_revision)?]).map_err(|source| database_error(&self.path, "agent member delete", source))?;
        if changed != 1 {
            return Err(invalid("member delete revision raced"));
        }
        transaction.execute("UPDATE agent_teams SET revision = revision + 1, updated_at_ms = ?1 WHERE team_id = ?2 AND revision = ?3", params![now_ms, team_id.to_string(), i64_from_u64(mutation.expected_team_revision)?]).map_err(|source| database_error(&self.path, "member delete team revision", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        let result = AgentTeamMemberDeleteRecord {
            team_id,
            member_id,
            catalog_revision: mutation.expected_catalog_revision + 1,
            team_revision: mutation.expected_team_revision + 1,
            deleted_member_revision: mutation.expected_member_revision,
        };
        record_catalog_mutation(
            &transaction,
            &fence,
            "applied",
            Some(&result),
            now_ms,
            &self.path,
        )?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent member delete commit", source))?;
        Ok(AgentCatalogMutationOutcome::Applied(result))
    }

    /// Stores one exact attention target; team/member identifiers must match its current member row.
    pub fn set_agent_attention(
        &self,
        target: &AgentSessionBindingRecord,
        team_member: Option<(Uuid, Uuid)>,
        state: AgentAttentionStateRecord,
        expected_revision: Option<u64>,
        now_ms: i64,
    ) -> Result<AgentAttentionRecord, StorageError> {
        validate_binding(target)?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent attention set")?;
        ensure_exact_binding(&transaction, target, &self.path)?;
        if let Some((team_id, member_id)) = team_member {
            let member = load_member_from(&transaction, member_id, &self.path)?
                .ok_or_else(|| invalid("attention member is unavailable"))?;
            if member.team_id != team_id || member.target != *target {
                return Err(invalid(
                    "attention target does not exactly match member binding",
                ));
            }
        }
        let current: Option<u64> = transaction
            .query_row(
                "SELECT revision FROM agent_attention WHERE agent_session_id = ?1",
                [target.agent_session_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|source| database_error(&self.path, "agent attention revision read", source))?
            .map(u64_from_i64)
            .transpose()?;
        if expected_revision != current {
            return Err(invalid("attention revision is stale"));
        }
        let next = current.unwrap_or(0) + 1;
        transaction.execute("INSERT INTO agent_attention (agent_session_id, workspace_id, pane_id, tab_id, team_id, member_id, state, revision, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(agent_session_id) DO UPDATE SET workspace_id = excluded.workspace_id, pane_id = excluded.pane_id, tab_id = excluded.tab_id, team_id = excluded.team_id, member_id = excluded.member_id, state = excluded.state, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms", params![target.agent_session_id.to_string(), target.workspace_id.to_string(), target.pane_id.to_string(), target.tab_id.to_string(), team_member.map(|v| v.0.to_string()), team_member.map(|v| v.1.to_string()), state.as_str(), i64_from_u64(next)?, now_ms]).map_err(|source| database_error(&self.path, "agent attention write", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent attention set commit", source))?;
        Ok(AgentAttentionRecord {
            target: target.clone(),
            team_id: team_member.map(|v| v.0),
            member_id: team_member.map(|v| v.1),
            state,
            revision: next,
        })
    }

    /// Persists operation intent before any adapter side effect.
    pub fn begin_agent_operation(
        &self,
        request: &AgentOperationBegin,
    ) -> Result<AgentOperationBeginOutcome, StorageError> {
        validate_operation_begin(request)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent operation begin")?;
        if let Some(existing) = load_operation(
            &transaction,
            &request.namespace,
            request.operation_id,
            &self.path,
        )? {
            return Ok(
                if existing.request_hash != request.request_hash
                    || existing.agent_session_id != request.agent_session_id
                    || existing.session_revision != request.session_revision
                    || existing.attempt_epoch != request.attempt_epoch
                {
                    AgentOperationBeginOutcome::Conflict
                } else if existing.state == AgentOperationStateRecord::Pending {
                    AgentOperationBeginOutcome::Pending(existing)
                } else {
                    AgentOperationBeginOutcome::Replay(existing)
                },
            );
        }
        let session = load_session(&transaction, request.agent_session_id, &self.path)?
            .ok_or_else(|| invalid("operation session is unavailable"))?;
        if session.revision != request.session_revision
            || session.attempt_epoch != request.attempt_epoch
        {
            return Err(invalid(
                "operation session revision or attempt epoch is stale",
            ));
        }
        transaction.execute("INSERT INTO agent_operations (operation_id, namespace, agent_session_id, session_revision, attempt_epoch, request_hash, state, accepted_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)", params![request.operation_id.to_string(), request.namespace, request.agent_session_id.to_string(), i64_from_u64(request.session_revision)?, i64_from_u64(request.attempt_epoch)?, request.request_hash, request.now_ms]).map_err(|source| database_error(&self.path, "agent operation intent insert", source))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent operation begin commit", source))?;
        Ok(AgentOperationBeginOutcome::Begun(AgentOperationRecord {
            operation_id: request.operation_id,
            namespace: request.namespace.clone(),
            agent_session_id: request.agent_session_id,
            session_revision: request.session_revision,
            attempt_epoch: request.attempt_epoch,
            request_hash: request.request_hash.clone(),
            state: AgentOperationStateRecord::Pending,
            terminal_code: None,
        }))
    }

    /// Atomically fences a genuinely new restore/relaunch attempt and persists its intent.
    /// The operation identity remains bound to the caller's pre-attempt revision/epoch, while
    /// the returned session is the only current identity adapters may use for callbacks.
    pub fn begin_agent_restore_attempt(
        &self,
        request: &AgentOperationBegin,
    ) -> Result<(AgentOperationBeginOutcome, AgentSessionRecord), StorageError> {
        validate_operation_begin(request)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent restore attempt begin")?;
        let current = load_session(&transaction, request.agent_session_id, &self.path)?
            .ok_or_else(|| invalid("operation session is unavailable"))?;
        if let Some(existing) = load_operation(
            &transaction,
            &request.namespace,
            request.operation_id,
            &self.path,
        )? {
            let outcome = if existing.request_hash != request.request_hash
                || existing.agent_session_id != request.agent_session_id
                || existing.session_revision != request.session_revision
                || existing.attempt_epoch != request.attempt_epoch
            {
                AgentOperationBeginOutcome::Conflict
            } else if existing.state == AgentOperationStateRecord::Pending {
                AgentOperationBeginOutcome::Pending(existing)
            } else {
                AgentOperationBeginOutcome::Replay(existing)
            };
            return Ok((outcome, current));
        }
        if current.revision != request.session_revision
            || current.attempt_epoch != request.attempt_epoch
        {
            return Err(invalid(
                "operation session revision or attempt epoch is stale",
            ));
        }
        if current.lifecycle.terminal() && current.lifecycle != AgentLifecycleRecord::Hibernated {
            return Err(invalid("terminal session cannot begin a restore attempt"));
        }
        let another_restore_pending = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_operations WHERE namespace='session.restore' AND agent_session_id=?1 AND state='pending')",
                [request.agent_session_id.to_string()],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|source| {
                database_error(
                    &self.path,
                    "agent restore attempt pending check",
                    source,
                )
            })?;
        if another_restore_pending {
            return Err(invalid("another restore attempt is already pending"));
        }
        let next_epoch = current
            .attempt_epoch
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("attempt epoch is exhausted"))?;
        let next_lifecycle = if current.lifecycle == AgentLifecycleRecord::Hibernated {
            AgentLifecycleRecord::Launching
        } else {
            current.lifecycle
        };
        let next_hibernation = if current.lifecycle == AgentLifecycleRecord::Hibernated {
            None
        } else {
            current.hibernation_state
        };
        transaction.execute(
            "UPDATE agent_sessions SET lifecycle=?1,durable_intent='restore',hibernation_state=?2,revision=revision+1,attempt_epoch=?3,updated_at_ms=?4 WHERE agent_session_id=?5 AND revision=?6 AND attempt_epoch=?7",
            params![next_lifecycle.as_str(), next_hibernation.map(AgentHibernationStateRecord::as_str), i64_from_u64(next_epoch)?, request.now_ms, request.agent_session_id.to_string(), i64_from_u64(request.session_revision)?, i64_from_u64(request.attempt_epoch)?],
        ).map_err(|source| database_error(&self.path, "agent restore attempt fence", source))?;
        let record = AgentOperationRecord {
            operation_id: request.operation_id,
            namespace: request.namespace.clone(),
            agent_session_id: request.agent_session_id,
            session_revision: request.session_revision,
            attempt_epoch: request.attempt_epoch,
            request_hash: request.request_hash.clone(),
            state: AgentOperationStateRecord::Pending,
            terminal_code: None,
        };
        transaction.execute("INSERT INTO agent_operations (operation_id, namespace, agent_session_id, session_revision, attempt_epoch, request_hash, state, accepted_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)", params![request.operation_id.to_string(), request.namespace, request.agent_session_id.to_string(), i64_from_u64(request.session_revision)?, i64_from_u64(request.attempt_epoch)?, request.request_hash, request.now_ms]).map_err(|source| database_error(&self.path, "agent restore attempt intent", source))?;
        bump_catalog_revision(&transaction, &self.path)?;
        let updated = load_session(&transaction, request.agent_session_id, &self.path)?
            .ok_or_else(|| invalid("agent session disappeared during restore attempt"))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "agent restore attempt begin commit", source)
        })?;
        Ok((AgentOperationBeginOutcome::Begun(record), updated))
    }

    /// Commits the first terminal outcome; later terminal races return the already durable result.
    pub fn finish_agent_operation(
        &self,
        namespace: &str,
        operation_id: Uuid,
        request_hash: &str,
        state: AgentOperationStateRecord,
        terminal_code: &str,
        now_ms: i64,
    ) -> Result<AgentOperationRecord, StorageError> {
        if state == AgentOperationStateRecord::Pending {
            return Err(invalid("terminal operation state is required"));
        }
        validate_text(namespace, MAX_TOKEN_CHARS, "operation namespace")?;
        validate_digest(request_hash, "request hash")?;
        validate_text(terminal_code, MAX_TOKEN_CHARS, "terminal code")?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent operation finish")?;
        let current = load_operation(&transaction, namespace, operation_id, &self.path)?
            .ok_or_else(|| invalid("operation is unavailable"))?;
        if current.request_hash != request_hash {
            return Err(invalid("operation request hash conflicts"));
        }
        if current.state != AgentOperationStateRecord::Pending {
            return Ok(current);
        }
        transaction.execute("UPDATE agent_operations SET state = ?1, terminal_code = ?2, updated_at_ms = ?3, terminal_at_ms = ?3 WHERE namespace = ?4 AND operation_id = ?5 AND state = 'pending'", params![state.as_str(), terminal_code, now_ms, namespace, operation_id.to_string()]).map_err(|source| database_error(&self.path, "agent operation terminal update", source))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "agent operation finish commit", source)
        })?;
        drop(connection);
        self.load_agent_operation(namespace, operation_id)?
            .ok_or_else(|| invalid("terminal operation disappeared"))
    }

    /// Atomically commits a successful restore operation and its exact session projection.
    /// A newer attempt cannot enter between operation completion and outcome persistence.
    #[allow(clippy::too_many_arguments)]
    pub fn finish_agent_restore_success(
        &self,
        operation_id: Uuid,
        request_hash: &str,
        agent_session_id: Uuid,
        expected_revision: u64,
        attempt_epoch: u64,
        outcome: AgentRestoreOutcomeRecord,
        terminal_code: &str,
        now_ms: i64,
    ) -> Result<AgentSessionRecord, StorageError> {
        validate_digest(request_hash, "request hash")?;
        validate_positive(expected_revision, "session revision")?;
        validate_positive(attempt_epoch, "attempt epoch")?;
        validate_text(terminal_code, MAX_TOKEN_CHARS, "terminal code")?;
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "agent restore success")?;
        let operation = load_operation(&transaction, "session.restore", operation_id, &self.path)?
            .ok_or_else(|| invalid("restore operation is unavailable"))?;
        if operation.request_hash != request_hash || operation.agent_session_id != agent_session_id
        {
            return Err(invalid("restore operation identity conflicts"));
        }
        if operation.state != AgentOperationStateRecord::Pending {
            return Err(invalid("restore operation is already terminal"));
        }
        let current = load_session(&transaction, agent_session_id, &self.path)?
            .ok_or_else(|| invalid("agent session is unavailable"))?;
        if current.revision != expected_revision || current.attempt_epoch != attempt_epoch {
            return Err(invalid("restore callback identity is stale"));
        }
        let changed = transaction.execute(
            "UPDATE agent_sessions SET durable_intent='restore',restore_outcome=?1,revision=revision+1,last_verified_at_ms=max(last_verified_at_ms,?2),updated_at_ms=?2 WHERE agent_session_id=?3 AND revision=?4 AND attempt_epoch=?5",
            params![outcome.as_str(), now_ms, agent_session_id.to_string(), i64_from_u64(expected_revision)?, i64_from_u64(attempt_epoch)?],
        ).map_err(|source| database_error(&self.path, "agent restore success session update", source))?;
        if changed != 1 {
            return Err(invalid("restore callback identity raced"));
        }
        let completed = transaction.execute(
            "UPDATE agent_operations SET state='succeeded',terminal_code=?1,updated_at_ms=?2,terminal_at_ms=?2 WHERE namespace='session.restore' AND operation_id=?3 AND state='pending'",
            params![terminal_code, now_ms, operation_id.to_string()],
        ).map_err(|source| database_error(&self.path, "agent restore success operation update", source))?;
        if completed != 1 {
            return Err(invalid("restore operation completion raced"));
        }
        bump_catalog_revision(&transaction, &self.path)?;
        let updated = load_session(&transaction, agent_session_id, &self.path)?
            .ok_or_else(|| invalid("updated restore session disappeared"))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent restore success commit", source))?;
        Ok(updated)
    }

    /// Loads one namespaced operation.
    pub fn load_agent_operation(
        &self,
        namespace: &str,
        operation_id: Uuid,
    ) -> Result<Option<AgentOperationRecord>, StorageError> {
        let connection = self.lock()?;
        load_operation(&connection, namespace, operation_id, &self.path)
    }

    /// Interrupts every recovered nonterminal operation not proven by exact session/attempt epoch.
    pub fn reconcile_agent_operations(
        &self,
        proven_epochs: &BTreeSet<(Uuid, u64)>,
        now_ms: i64,
    ) -> Result<usize, StorageError> {
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(
            &mut connection,
            &self.path,
            "agent operation reconciliation",
        )?;
        let pending = query_all(
            &transaction,
            "SELECT operation_id, namespace, agent_session_id, session_revision, attempt_epoch, request_hash, state, terminal_code FROM agent_operations WHERE state = 'pending' ORDER BY sequence",
            parse_operation,
            &self.path,
            "pending agent operation read",
        )?;
        let mut interrupted = 0;
        for operation in pending {
            if !proven_epochs.contains(&(operation.agent_session_id, operation.attempt_epoch)) {
                interrupted += transaction.execute("UPDATE agent_operations SET state = 'interrupted', terminal_code = 'serviceRestart', updated_at_ms = ?1, terminal_at_ms = ?1 WHERE namespace = ?2 AND operation_id = ?3 AND state = 'pending'", params![now_ms, operation.namespace, operation.operation_id.to_string()]).map_err(|source| database_error(&self.path, "agent operation interrupt", source))?;
            }
        }
        transaction.commit().map_err(|source| {
            database_error(&self.path, "agent operation reconciliation commit", source)
        })?;
        Ok(interrupted)
    }

    /// Persists a provider/window/revision-bound confirmation using only a nonce digest.
    pub fn create_hibernation_confirmation(
        &self,
        request: &AgentHibernationConfirmationCreate,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        validate_confirmation(request, now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(
            &mut connection,
            &self.path,
            "hibernation confirmation create",
        )?;
        let session = load_session(&transaction, request.agent_session_id, &self.path)?
            .ok_or_else(|| invalid("confirmation session is unavailable"))?;
        if session.revision != request.session_revision
            || session.attempt_epoch != request.attempt_epoch
            || session.hibernation_state != Some(AgentHibernationStateRecord::ConfirmationRequired)
        {
            return Err(invalid(
                "confirmation is not bound to the current hibernation attempt",
            ));
        }
        transaction.execute("INSERT INTO agent_hibernation_confirmations (confirmation_id, agent_session_id, session_revision, attempt_epoch, choice, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, nonce_hash, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)", params![request.confirmation_id.to_string(), request.agent_session_id.to_string(), i64_from_u64(request.session_revision)?, i64_from_u64(request.attempt_epoch)?, request.choice, request.provider_id.to_string(), i64_from_u64(request.provider_epoch)?, request.provider_lease_id.to_string(), request.window_id.to_string(), i64_from_u64(request.window_generation)?, request.nonce_hash, request.expires_at_ms]).map_err(|source| database_error(&self.path, "hibernation confirmation insert", source))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "hibernation confirmation create commit", source)
        })
    }

    /// Durably links a content-free nonce to the preflight operation for exact response replay.
    pub fn link_hibernation_confirmation_replay(
        &self,
        operation_id: Uuid,
        confirmation_id: Uuid,
    ) -> Result<(), StorageError> {
        let connection = self.lock()?;
        connection.execute("INSERT INTO agent_hibernation_challenge_replay(operation_id,confirmation_id) VALUES(?1,?2)", params![operation_id.to_string(), confirmation_id.to_string()]).map_err(|source| database_error(&self.path, "hibernation challenge replay link", source))?;
        Ok(())
    }

    /// Loads the exact issued challenge, including whether it was burned or expired.
    pub fn load_hibernation_challenge_replay(
        &self,
        operation_id: Uuid,
    ) -> Result<Option<AgentHibernationChallengeReplay>, StorageError> {
        let connection = self.lock()?;
        connection.query_row("SELECT c.confirmation_id,c.agent_session_id,c.session_revision,c.attempt_epoch,c.choice,c.provider_id,c.provider_epoch,c.provider_lease_id,c.window_id,c.window_generation,c.nonce_hash,c.expires_at_ms,c.consumed_at_ms,r.operation_id FROM agent_hibernation_challenge_replay r JOIN agent_hibernation_confirmations c ON c.confirmation_id=r.confirmation_id WHERE r.operation_id=?1", [operation_id.to_string()], |row| Ok(AgentHibernationChallengeReplay { confirmation: AgentHibernationConfirmation { request: AgentHibernationConfirmationCreate { confirmation_id: uuid_at(row, 0)?, agent_session_id: uuid_at(row, 1)?, session_revision: u64_from_i64_sql(row.get(2)?)?, attempt_epoch: u64_from_i64_sql(row.get(3)?)?, choice: row.get(4)?, provider_id: uuid_at(row, 5)?, provider_epoch: u64_from_i64_sql(row.get(6)?)?, provider_lease_id: uuid_at(row, 7)?, window_id: uuid_at(row, 8)?, window_generation: u64_from_i64_sql(row.get(9)?)?, nonce_hash: row.get(10)?, expires_at_ms: row.get(11)? }, consumed_at_ms: row.get(12)? }, operation_id: uuid_at(row, 13)? })).optional().map_err(|source| database_error(&self.path, "hibernation challenge replay read", source))
    }

    /// Consumes an exact confirmation once, rejecting expiry or any changed binding field.
    pub fn consume_hibernation_confirmation(
        &self,
        request: &AgentHibernationConfirmationCreate,
        now_ms: i64,
    ) -> Result<AgentHibernationConfirmationOutcome, StorageError> {
        validate_time(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(
            &mut connection,
            &self.path,
            "hibernation confirmation consume",
        )?;
        let stored = load_confirmation(&transaction, request.confirmation_id, &self.path)?
            .ok_or_else(|| invalid("hibernation confirmation is unavailable"))?;
        if stored.request != *request {
            return Ok(AgentHibernationConfirmationOutcome::Conflict);
        }
        let Some(session) = load_session(&transaction, request.agent_session_id, &self.path)?
        else {
            return Ok(AgentHibernationConfirmationOutcome::Conflict);
        };
        if session.revision != request.session_revision
            || session.attempt_epoch != request.attempt_epoch
            || session.hibernation_state != Some(AgentHibernationStateRecord::ConfirmationRequired)
        {
            return Ok(AgentHibernationConfirmationOutcome::Conflict);
        }
        if stored.consumed_at_ms.is_some() {
            return Ok(AgentHibernationConfirmationOutcome::AlreadyConsumed);
        }
        if stored.request.expires_at_ms <= now_ms {
            return Ok(AgentHibernationConfirmationOutcome::Expired);
        }
        let changed = transaction.execute("UPDATE agent_hibernation_confirmations SET consumed_at_ms = ?1 WHERE confirmation_id = ?2 AND consumed_at_ms IS NULL", params![now_ms, request.confirmation_id.to_string()]).map_err(|source| database_error(&self.path, "hibernation confirmation consume", source))?;
        if changed != 1 {
            return Ok(AgentHibernationConfirmationOutcome::AlreadyConsumed);
        }
        transaction.commit().map_err(|source| {
            database_error(
                &self.path,
                "hibernation confirmation consume commit",
                source,
            )
        })?;
        Ok(AgentHibernationConfirmationOutcome::Consumed)
    }

    /// Burns every unconsumed challenge during service startup so restart is fail-closed.
    pub fn invalidate_pending_hibernation_confirmations(
        &self,
        now_ms: i64,
    ) -> Result<usize, StorageError> {
        validate_time(now_ms)?;
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE agent_hibernation_confirmations SET consumed_at_ms = ?1 WHERE consumed_at_ms IS NULL",
                [now_ms],
            )
            .map_err(|source| database_error(&self.path, "hibernation confirmation invalidation", source))
    }

    /// Atomically records a verified destructive disposition that has no resumable checkpoint.
    pub fn record_terminated_after_warning(
        &self,
        agent_session_id: Uuid,
        expected_revision: u64,
        attempt_epoch: u64,
        confirmation_id: Uuid,
        disposed_at_ms: i64,
    ) -> Result<AgentSessionRecord, StorageError> {
        validate_time(disposed_at_ms)?;
        let mut connection = self.lock()?;
        let transaction =
            catalog_transaction(&mut connection, &self.path, "terminated disposition")?;
        let current = load_session(&transaction, agent_session_id, &self.path)?
            .ok_or_else(|| invalid("agent session is unavailable"))?;
        if current.revision != expected_revision
            || current.attempt_epoch != attempt_epoch
            || current.hibernation_state
                != Some(AgentHibernationStateRecord::ProcessDispositionPending)
        {
            return Err(invalid("destructive disposition fence is stale"));
        }
        transaction.execute("UPDATE agent_sessions SET lifecycle='completed',durable_intent='none',restore_level='unavailable',restore_outcome='unavailable',hibernation_state='failed',revision=revision+1,last_verified_at_ms=max(last_verified_at_ms,?1),checkpoint_kind=NULL,checkpoint_version=NULL,checkpoint_digest=NULL,checkpoint_verified_at_ms=NULL,checkpoint_expires_at_ms=NULL,updated_at_ms=?1 WHERE agent_session_id=?2 AND revision=?3", params![disposed_at_ms, agent_session_id.to_string(), i64_from_u64(expected_revision)?]).map_err(|source| database_error(&self.path, "terminated disposition session update", source))?;
        transaction.execute("INSERT INTO agent_hibernation_dispositions(agent_session_id,confirmation_id,outcome,disposed_at_ms) VALUES(?1,?2,'terminatedAfterWarning',?3)", params![agent_session_id.to_string(), confirmation_id.to_string(), disposed_at_ms]).map_err(|source| database_error(&self.path, "terminated disposition insert", source))?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "terminated disposition commit", source)
        })?;
        drop(connection);
        self.load_agent_session(agent_session_id)?
            .ok_or_else(|| invalid("terminated session disappeared"))
    }

    /// Records Task Manager's exact service-owned disposition after the bound terminal has been
    /// detached and its process disposition verified. The target revision/generation fence makes
    /// a retry safe after caller or service loss; an already-recorded identical disposition is a
    /// semantic replay.
    pub fn complete_agent_task_action(
        &self,
        agent_session_id: Uuid,
        expected_revision: u64,
        attempt_epoch: u64,
        durable_intent: &str,
        disposed_at_ms: i64,
    ) -> Result<AgentSessionRecord, StorageError> {
        if !matches!(
            durable_intent,
            "taskCancelled" | "taskTerminated" | "taskForceTerminated"
        ) {
            return Err(invalid("invalid agent task disposition"));
        }
        validate_time(disposed_at_ms)?;
        let mut connection = self.lock()?;
        let transaction = catalog_transaction(&mut connection, &self.path, "agent task action")?;
        let current = load_session(&transaction, agent_session_id, &self.path)?
            .ok_or_else(|| invalid("agent session is unavailable"))?;
        let recorded: Option<(u64, u64, u64, String)> = transaction
            .query_row(
                "SELECT attempt_epoch,expected_revision,completed_revision,disposition FROM agent_task_dispositions WHERE agent_session_id=?1",
                [agent_session_id.to_string()],
                |row| {
                    Ok((
                        u64_from_i64_sql(row.get(0)?)?,
                        u64_from_i64_sql(row.get(1)?)?,
                        u64_from_i64_sql(row.get(2)?)?,
                        row.get(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|source| database_error(&self.path, "agent task disposition read", source))?;
        if current.revision != expected_revision || current.attempt_epoch != attempt_epoch {
            if recorded.as_ref().is_some_and(
                |(recorded_attempt, recorded_expected, completed_revision, disposition)| {
                    *recorded_attempt == attempt_epoch
                        && *recorded_expected == expected_revision
                        && *completed_revision == current.revision
                        && disposition == durable_intent
                },
            ) {
                transaction.commit().map_err(|source| {
                    database_error(&self.path, "agent task replay commit", source)
                })?;
                drop(connection);
                return self
                    .load_agent_session(agent_session_id)?
                    .ok_or_else(|| invalid("agent task replay disappeared"));
            }
            return Err(invalid("agent task disposition fence is stale"));
        }
        if current.lifecycle.terminal() {
            return Ok(current);
        }
        let changed = transaction
            .execute(
                "UPDATE agent_sessions SET lifecycle='completed',durable_intent='none',restore_level='unavailable',restore_outcome='unavailable',hibernation_state=CASE WHEN hibernation_state IS NULL THEN NULL ELSE 'failed' END,revision=revision+1,last_verified_at_ms=max(last_verified_at_ms,?1),checkpoint_kind=NULL,checkpoint_version=NULL,checkpoint_digest=NULL,checkpoint_verified_at_ms=NULL,checkpoint_expires_at_ms=NULL,updated_at_ms=?1 WHERE agent_session_id=?2 AND revision=?3 AND attempt_epoch=?4",
                params![disposed_at_ms, agent_session_id.to_string(), i64_from_u64(expected_revision)?, i64_from_u64(attempt_epoch)?],
            )
            .map_err(|source| database_error(&self.path, "agent task session update", source))?;
        if changed != 1 {
            return Err(invalid("agent task disposition fence is stale"));
        }
        let completed_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| invalid("agent task disposition revision overflow"))?;
        transaction
            .execute(
                "INSERT INTO agent_task_dispositions(agent_session_id,attempt_epoch,expected_revision,completed_revision,disposition,disposed_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
                params![agent_session_id.to_string(), i64_from_u64(attempt_epoch)?, i64_from_u64(expected_revision)?, i64_from_u64(completed_revision)?, durable_intent, disposed_at_ms],
            )
            .map_err(|source| database_error(&self.path, "agent task disposition insert", source))?;
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "agent task commit", source))?;
        drop(connection);
        self.load_agent_session(agent_session_id)?
            .ok_or_else(|| invalid("agent task session disappeared"))
    }
}

struct MutationFence<'a> {
    namespace: &'static str,
    idempotency_key: Uuid,
    request_hash: &'a str,
    expected_catalog_revision: u64,
    expected_team_revision: Option<u64>,
    expected_member_revision: Option<u64>,
}

impl<'a> MutationFence<'a> {
    fn catalog(namespace: &'static str, value: &'a AgentCatalogMutationIdentityRecord) -> Self {
        Self {
            namespace,
            idempotency_key: value.idempotency_key,
            request_hash: &value.request_hash,
            expected_catalog_revision: value.expected_catalog_revision,
            expected_team_revision: None,
            expected_member_revision: None,
        }
    }
    fn team(namespace: &'static str, value: &'a AgentTeamMutationIdentityRecord) -> Self {
        Self {
            namespace,
            idempotency_key: value.idempotency_key,
            request_hash: &value.request_hash,
            expected_catalog_revision: value.expected_catalog_revision,
            expected_team_revision: Some(value.expected_team_revision),
            expected_member_revision: None,
        }
    }
    fn member(namespace: &'static str, value: &'a AgentTeamMemberMutationIdentityRecord) -> Self {
        Self {
            namespace,
            idempotency_key: value.idempotency_key,
            request_hash: &value.request_hash,
            expected_catalog_revision: value.expected_catalog_revision,
            expected_team_revision: Some(value.expected_team_revision),
            expected_member_revision: Some(value.expected_member_revision),
        }
    }
}

#[derive(Clone, Copy)]
enum StaleMutation {
    Catalog,
    Team,
    Member,
}
impl StaleMutation {
    fn code(self) -> &'static str {
        match self {
            Self::Catalog => "staleCatalog",
            Self::Team => "staleTeam",
            Self::Member => "staleMember",
        }
    }
    fn into_outcome<T>(self) -> AgentCatalogMutationOutcome<T> {
        match self {
            Self::Catalog => AgentCatalogMutationOutcome::StaleCatalog,
            Self::Team => AgentCatalogMutationOutcome::StaleTeam,
            Self::Member => AgentCatalogMutationOutcome::StaleMember,
        }
    }
}

fn load_catalog_mutation<T: DeserializeOwned>(
    connection: &Connection,
    fence: &MutationFence<'_>,
    path: &Path,
) -> Result<Option<AgentCatalogMutationOutcome<T>>, StorageError> {
    let stored = connection.query_row("SELECT request_hash, expected_catalog_revision, expected_team_revision, expected_member_revision, terminal_code, result_metadata_json FROM agent_catalog_mutations WHERE namespace = ?1 AND idempotency_key = ?2", params![fence.namespace, fence.idempotency_key.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?))).optional().map_err(|source| database_error(path, "catalog mutation replay read", source))?;
    let Some((hash, catalog, team, member, code, metadata)) = stored else {
        return Ok(None);
    };
    if hash != fence.request_hash
        || u64_from_i64(catalog)? != fence.expected_catalog_revision
        || team.map(u64_from_i64).transpose()? != fence.expected_team_revision
        || member.map(u64_from_i64).transpose()? != fence.expected_member_revision
    {
        return Ok(Some(AgentCatalogMutationOutcome::Conflict));
    }
    let outcome = match code.as_str() {
        "applied" => AgentCatalogMutationOutcome::Replay(
            serde_json::from_str(
                metadata
                    .as_deref()
                    .ok_or_else(|| invalid("applied catalog mutation lacks result metadata"))?,
            )
            .map_err(|_| invalid("catalog mutation result metadata is malformed"))?,
        ),
        "staleCatalog" => AgentCatalogMutationOutcome::StaleCatalog,
        "staleTeam" => AgentCatalogMutationOutcome::StaleTeam,
        "staleMember" => AgentCatalogMutationOutcome::StaleMember,
        "resourceLimit" => AgentCatalogMutationOutcome::ResourceLimit,
        "dependencyConflict" => AgentCatalogMutationOutcome::DependencyConflict,
        _ => return Err(invalid("catalog mutation terminal code is invalid")),
    };
    Ok(Some(outcome))
}

fn record_catalog_mutation<T: Serialize>(
    connection: &Connection,
    fence: &MutationFence<'_>,
    terminal_code: &str,
    result: Option<&T>,
    now_ms: i64,
    path: &Path,
) -> Result<(), StorageError> {
    let metadata = result
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| invalid("catalog mutation result metadata serialization failed"))?;
    if metadata.as_ref().is_some_and(|value| value.len() > 65_536) {
        return Err(invalid("catalog mutation result metadata exceeds 64 KiB"));
    }
    connection.execute("INSERT INTO agent_catalog_mutations (namespace, idempotency_key, request_hash, expected_catalog_revision, expected_team_revision, expected_member_revision, terminal_code, result_metadata_json, completed_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![fence.namespace, fence.idempotency_key.to_string(), fence.request_hash, i64_from_u64_allow_zero(fence.expected_catalog_revision)?, fence.expected_team_revision.map(i64_from_u64).transpose()?, fence.expected_member_revision.map(i64_from_u64).transpose()?, terminal_code, metadata, now_ms]).map_err(|source| database_error(path, "catalog mutation terminal insert", source))?;
    Ok(())
}

fn check_member_mutation_fence(
    connection: &Connection,
    team_id: Uuid,
    member_id: Uuid,
    mutation: &AgentTeamMemberMutationIdentityRecord,
    path: &Path,
) -> Result<Option<StaleMutation>, StorageError> {
    if catalog_revision(connection, path)? != mutation.expected_catalog_revision {
        return Ok(Some(StaleMutation::Catalog));
    }
    if team_revision(connection, team_id, path)? != Some(mutation.expected_team_revision) {
        return Ok(Some(StaleMutation::Team));
    }
    if member_revision(connection, member_id, path)? != Some(mutation.expected_member_revision) {
        return Ok(Some(StaleMutation::Member));
    }
    Ok(None)
}

fn team_revision(
    connection: &Connection,
    team_id: Uuid,
    path: &Path,
) -> Result<Option<u64>, StorageError> {
    connection
        .query_row(
            "SELECT revision FROM agent_teams WHERE team_id = ?1",
            [team_id.to_string()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|source| database_error(path, "agent team revision read", source))?
        .map(u64_from_i64)
        .transpose()
}

fn member_revision(
    connection: &Connection,
    member_id: Uuid,
    path: &Path,
) -> Result<Option<u64>, StorageError> {
    connection
        .query_row(
            "SELECT revision FROM agent_team_members WHERE member_id = ?1",
            [member_id.to_string()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|source| database_error(path, "agent member revision read", source))?
        .map(u64_from_i64)
        .transpose()
}

fn catalog_transaction<'a>(
    connection: &'a mut Connection,
    path: &Path,
    operation: &'static str,
) -> Result<Transaction<'a>, StorageError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| database_error(path, operation, source))
}

fn query_all<T>(
    connection: &Connection,
    sql: &str,
    parser: fn(&Row<'_>) -> rusqlite::Result<T>,
    path: &Path,
    operation: &'static str,
) -> Result<Vec<T>, StorageError> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|source| database_error(path, operation, source))?;
    let rows = statement
        .query_map([], parser)
        .map_err(|source| database_error(path, operation, source))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|source| database_error(path, operation, source))
}

fn catalog_revision(connection: &Connection, path: &Path) -> Result<u64, StorageError> {
    connection
        .query_row(
            "SELECT revision FROM agent_catalog_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|source| database_error(path, "agent catalog revision read", source))
        .and_then(u64_from_i64)
}

fn bump_catalog_revision(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    let changed = connection.execute("UPDATE agent_catalog_state SET revision = revision + 1 WHERE singleton = 1 AND revision < 9007199254740991", []).map_err(|source| database_error(path, "agent catalog revision update", source))?;
    if changed == 1 {
        Ok(())
    } else {
        Err(invalid("agent catalog revision exhausted"))
    }
}

fn load_session(
    connection: &Connection,
    id: Uuid,
    path: &Path,
) -> Result<Option<AgentSessionRecord>, StorageError> {
    connection.query_row("SELECT agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version, title, lifecycle, durable_intent, restore_level, restore_outcome, CASE WHEN EXISTS (SELECT 1 FROM agent_hibernation_dispositions d WHERE d.agent_session_id=agent_sessions.agent_session_id) THEN 'terminatedAfterWarning' ELSE hibernation_state END, revision, attempt_epoch, evidence_epoch, last_verified_at_ms, forked_from_agent_session_id, fork_artifact_kind, fork_artifact_version, fork_artifact_digest, checkpoint_kind, checkpoint_version,checkpoint_digest,checkpoint_verified_at_ms,checkpoint_expires_at_ms,created_at_ms,updated_at_ms FROM agent_sessions WHERE agent_session_id = ?1", [id.to_string()], parse_session).optional().map_err(|source| database_error(path, "agent session read", source))
}

fn parse_session(row: &Row<'_>) -> rusqlite::Result<AgentSessionRecord> {
    let fork_source_text = row.get::<_, Option<String>>(16)?;
    let fork_source = optional_uuid(fork_source_text.as_deref())?;
    let fork_kind: Option<String> = row.get(17)?;
    let fork_version: Option<i64> = row.get(18)?;
    let fork_digest: Option<String> = row.get(19)?;
    let checkpoint_kind: Option<String> = row.get(20)?;
    let checkpoint_version: Option<i64> = row.get(21)?;
    let checkpoint_digest: Option<String> = row.get(22)?;
    let checkpoint_verified: Option<i64> = row.get(23)?;
    let checkpoint_expires: Option<i64> = row.get(24)?;
    Ok(AgentSessionRecord {
        binding: AgentSessionBindingRecord {
            agent_session_id: uuid_at(row, 0)?,
            workspace_id: uuid_at(row, 1)?,
            pane_id: uuid_at(row, 2)?,
            tab_id: uuid_at(row, 3)?,
        },
        adapter_id: row.get(4)?,
        adapter_version: row.get(5)?,
        title: row.get(6)?,
        lifecycle: AgentLifecycleRecord::parse(&row.get::<_, String>(7)?)?,
        durable_intent: row.get(8)?,
        restore_level: AgentRestoreLevelRecord::parse(&row.get::<_, String>(9)?)?,
        restore_outcome: row
            .get::<_, Option<String>>(10)?
            .map(|value| AgentRestoreOutcomeRecord::parse(&value))
            .transpose()?,
        hibernation_state: row
            .get::<_, Option<String>>(11)?
            .map(|value| AgentHibernationStateRecord::parse(&value))
            .transpose()?,
        revision: u64_from_i64_sql(row.get(12)?)?,
        attempt_epoch: u64_from_i64_sql(row.get(13)?)?,
        evidence_epoch: u64_from_i64_sql(row.get(14)?)?,
        last_verified_at_ms: row.get(15)?,
        forked_from: match (fork_source, fork_kind, fork_version, fork_digest) {
            (Some(source_agent_session_id), Some(kind), Some(version), Some(digest_sha256)) => {
                Some(AgentForkArtifactRecord {
                    source_agent_session_id,
                    kind,
                    version: u16::try_from(version)
                        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(18, version))?,
                    digest_sha256,
                })
            }
            (None, None, None, None) => None,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        checkpoint: match (
            checkpoint_kind,
            checkpoint_version,
            checkpoint_digest,
            checkpoint_verified,
            checkpoint_expires,
        ) {
            (
                Some(kind),
                Some(version),
                Some(digest_sha256),
                Some(verified_at_ms),
                Some(expires_at_ms),
            ) => Some(AgentCheckpointRecord {
                kind,
                version: u16::try_from(version)
                    .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(21, version))?,
                digest_sha256,
                verified_at_ms,
                expires_at_ms,
            }),
            (None, None, None, None, None) => None,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        created_at_ms: row.get(25)?,
        updated_at_ms: row.get(26)?,
    })
}

fn parse_team(row: &Row<'_>) -> rusqlite::Result<AgentTeamRecord> {
    Ok(AgentTeamRecord {
        team_id: uuid_at(row, 0)?,
        title: row.get(1)?,
        revision: u64_from_i64_sql(row.get(2)?)?,
    })
}
fn parse_member(row: &Row<'_>) -> rusqlite::Result<AgentTeamMemberRecord> {
    let parent = row.get::<_, Option<String>>(7)?;
    Ok(AgentTeamMemberRecord {
        member_id: uuid_at(row, 0)?,
        team_id: uuid_at(row, 1)?,
        role: row.get(2)?,
        target: AgentSessionBindingRecord {
            agent_session_id: uuid_at(row, 3)?,
            workspace_id: uuid_at(row, 4)?,
            pane_id: uuid_at(row, 5)?,
            tab_id: uuid_at(row, 6)?,
        },
        parent_member_id: optional_uuid(parent.as_deref())?,
        revision: u64_from_i64_sql(row.get(8)?)?,
    })
}
fn parse_attention(row: &Row<'_>) -> rusqlite::Result<AgentAttentionRecord> {
    let team = row.get::<_, Option<String>>(4)?;
    let member = row.get::<_, Option<String>>(5)?;
    Ok(AgentAttentionRecord {
        target: AgentSessionBindingRecord {
            agent_session_id: uuid_at(row, 0)?,
            workspace_id: uuid_at(row, 1)?,
            pane_id: uuid_at(row, 2)?,
            tab_id: uuid_at(row, 3)?,
        },
        team_id: optional_uuid(team.as_deref())?,
        member_id: optional_uuid(member.as_deref())?,
        state: AgentAttentionStateRecord::parse(&row.get::<_, String>(6)?)?,
        revision: u64_from_i64_sql(row.get(7)?)?,
    })
}
fn parse_operation(row: &Row<'_>) -> rusqlite::Result<AgentOperationRecord> {
    Ok(AgentOperationRecord {
        operation_id: uuid_at(row, 0)?,
        namespace: row.get(1)?,
        agent_session_id: uuid_at(row, 2)?,
        session_revision: u64_from_i64_sql(row.get(3)?)?,
        attempt_epoch: u64_from_i64_sql(row.get(4)?)?,
        request_hash: row.get(5)?,
        state: AgentOperationStateRecord::parse(&row.get::<_, String>(6)?)?,
        terminal_code: row.get(7)?,
    })
}

fn load_operation(
    connection: &Connection,
    namespace: &str,
    operation_id: Uuid,
    path: &Path,
) -> Result<Option<AgentOperationRecord>, StorageError> {
    connection.query_row("SELECT operation_id, namespace, agent_session_id, session_revision, attempt_epoch, request_hash, state, terminal_code FROM agent_operations WHERE namespace = ?1 AND operation_id = ?2", params![namespace, operation_id.to_string()], parse_operation).optional().map_err(|source| database_error(path, "agent operation read", source))
}

#[allow(clippy::too_many_arguments)]
fn insert_terminal_operation(
    connection: &Connection,
    namespace: &str,
    operation_id: Uuid,
    session_id: Uuid,
    session_revision: u64,
    attempt_epoch: u64,
    request_hash: &str,
    terminal_code: &str,
    now_ms: i64,
    path: &Path,
) -> Result<(), StorageError> {
    connection.execute("INSERT INTO agent_operations (operation_id, namespace, agent_session_id, session_revision, attempt_epoch, request_hash, state, terminal_code, accepted_at_ms, updated_at_ms, terminal_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'succeeded', ?7, ?8, ?8, ?8)", params![operation_id.to_string(), namespace, session_id.to_string(), i64_from_u64(session_revision)?, i64_from_u64(attempt_epoch)?, request_hash, terminal_code, now_ms]).map_err(|source| database_error(path, "agent terminal operation insert", source))?;
    Ok(())
}

fn load_member_from(
    connection: &Connection,
    member_id: Uuid,
    path: &Path,
) -> Result<Option<AgentTeamMemberRecord>, StorageError> {
    connection.query_row("SELECT member_id, team_id, role, target_agent_session_id, target_workspace_id, target_pane_id, target_tab_id, parent_member_id, revision FROM agent_team_members WHERE member_id = ?1", [member_id.to_string()], parse_member).optional().map_err(|source| database_error(path, "agent team member read", source))
}

fn ensure_exact_binding(
    connection: &Connection,
    binding: &AgentSessionBindingRecord,
    path: &Path,
) -> Result<(), StorageError> {
    let stored = load_session(connection, binding.agent_session_id, path)?
        .ok_or_else(|| invalid("target session is unavailable"))?;
    if stored.binding == *binding {
        Ok(())
    } else {
        Err(invalid("workspace/pane/tab/session binding is not exact"))
    }
}

fn ensure_parent_team(
    connection: &Connection,
    team_id: Uuid,
    parent: Option<Uuid>,
    path: &Path,
) -> Result<(), StorageError> {
    if let Some(parent_id) = parent {
        let record = load_member_from(connection, parent_id, path)?
            .ok_or_else(|| invalid("parent member is unavailable"))?;
        if record.team_id != team_id {
            return Err(invalid("parent member belongs to another team"));
        }
    } else {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_teams WHERE team_id = ?1)",
                [team_id.to_string()],
                |row| row.get(0),
            )
            .map_err(|source| database_error(path, "agent team existence read", source))?;
        if !exists {
            return Err(invalid("agent team is unavailable"));
        }
    }
    Ok(())
}

fn reaches_member(
    connection: &Connection,
    start: Uuid,
    target: Uuid,
    path: &Path,
) -> Result<bool, StorageError> {
    connection.query_row("WITH RECURSIVE ancestors(member_id) AS (SELECT ?1 UNION ALL SELECT parent_member_id FROM agent_team_members JOIN ancestors ON agent_team_members.member_id = ancestors.member_id WHERE parent_member_id IS NOT NULL) SELECT EXISTS(SELECT 1 FROM ancestors WHERE member_id = ?2)", params![start.to_string(), target.to_string()], |row| row.get(0)).map_err(|source| database_error(path, "agent team cycle check", source))
}

fn load_confirmation(
    connection: &Connection,
    id: Uuid,
    path: &Path,
) -> Result<Option<AgentHibernationConfirmation>, StorageError> {
    connection.query_row("SELECT confirmation_id, agent_session_id, session_revision, attempt_epoch, choice, provider_id, provider_epoch, provider_lease_id, window_id, window_generation, nonce_hash, expires_at_ms, consumed_at_ms FROM agent_hibernation_confirmations WHERE confirmation_id = ?1", [id.to_string()], |row| Ok(AgentHibernationConfirmation { request: AgentHibernationConfirmationCreate { confirmation_id: uuid_at(row, 0)?, agent_session_id: uuid_at(row, 1)?, session_revision: u64_from_i64_sql(row.get(2)?)?, attempt_epoch: u64_from_i64_sql(row.get(3)?)?, choice: row.get(4)?, provider_id: uuid_at(row, 5)?, provider_epoch: u64_from_i64_sql(row.get(6)?)?, provider_lease_id: uuid_at(row, 7)?, window_id: uuid_at(row, 8)?, window_generation: u64_from_i64_sql(row.get(9)?)?, nonce_hash: row.get(10)?, expires_at_ms: row.get(11)? }, consumed_at_ms: row.get(12)? })).optional().map_err(|source| database_error(path, "hibernation confirmation read", source))
}

fn validate_catalog(
    sessions: &[AgentSessionRecord],
    teams: &[AgentTeamRecord],
    members: &[AgentTeamMemberRecord],
    attention: &[AgentAttentionRecord],
) -> Result<(), StorageError> {
    if sessions.len() > AGENT_SESSION_CAP || teams.len() > AGENT_TEAM_CAP {
        return Err(invalid("stored agent catalog exceeds global caps"));
    }
    let session_map: BTreeMap<_, _> = sessions
        .iter()
        .map(|session| (session.binding.agent_session_id, &session.binding))
        .collect();
    let team_ids: BTreeSet<_> = teams.iter().map(|team| team.team_id).collect();
    let member_map: BTreeMap<_, _> = members
        .iter()
        .map(|member| (member.member_id, member))
        .collect();
    let mut team_counts = BTreeMap::<Uuid, usize>::new();
    let mut member_sessions = BTreeSet::new();
    for member in members {
        if !team_ids.contains(&member.team_id)
            || session_map.get(&member.target.agent_session_id) != Some(&&member.target)
            || !member_sessions.insert(member.target.agent_session_id)
        {
            return Err(invalid(
                "stored team member has an invalid or duplicate exact target",
            ));
        }
        *team_counts.entry(member.team_id).or_default() += 1;
        if team_counts[&member.team_id] > AGENT_TEAM_MEMBER_CAP {
            return Err(invalid("stored team exceeds member cap"));
        }
        if let Some(parent) = member.parent_member_id {
            let parent_record = member_map
                .get(&parent)
                .ok_or_else(|| invalid("stored parent member is unavailable"))?;
            if parent_record.team_id != member.team_id {
                return Err(invalid("stored parent member belongs to another team"));
            }
        }
        let mut seen = BTreeSet::new();
        let mut cursor = Some(member.member_id);
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return Err(invalid("stored team graph contains a cycle"));
            }
            cursor = member_map
                .get(&id)
                .and_then(|record| record.parent_member_id);
        }
    }
    for record in attention {
        if session_map.get(&record.target.agent_session_id) != Some(&&record.target) {
            return Err(invalid("stored attention target is not exact"));
        }
        match (record.team_id, record.member_id) {
            (Some(team), Some(member)) => {
                let member = member_map
                    .get(&member)
                    .ok_or_else(|| invalid("stored attention member is unavailable"))?;
                if member.team_id != team || member.target != record.target {
                    return Err(invalid("stored attention member target is stale"));
                }
            }
            (None, None) => {}
            _ => return Err(invalid("stored attention team/member pair is incomplete")),
        }
    }
    Ok(())
}

fn validate_session_create(request: &AgentSessionCreate) -> Result<(), StorageError> {
    validate_binding(&request.binding)?;
    validate_token(&request.adapter_id, "adapter ID")?;
    validate_token(&request.adapter_version, "adapter version")?;
    validate_text(&request.title, MAX_TITLE_CHARS, "session title")?;
    validate_digest(&request.request_hash, "request hash")?;
    validate_positive(request.attempt_epoch, "attempt epoch")?;
    validate_time(request.now_ms)?;
    if let Some(fork) = &request.forked_from {
        validate_token(&fork.kind, "artifact kind")?;
        if fork.version == 0 {
            return Err(invalid("artifact version must be positive"));
        }
        validate_digest(&fork.digest_sha256, "artifact digest")?;
    }
    Ok(())
}
fn validate_session_update(update: &AgentSessionUpdate) -> Result<(), StorageError> {
    validate_positive(update.expected_revision, "session revision")?;
    validate_positive(update.attempt_epoch, "attempt epoch")?;
    validate_positive(update.evidence_epoch, "evidence epoch")?;
    validate_time(update.verified_at_ms)?;
    if !matches!(
        update.durable_intent.as_str(),
        "none" | "launch" | "restore" | "fork" | "hibernate"
    ) {
        return Err(invalid("invalid durable session intent"));
    }
    if let Some(checkpoint) = &update.checkpoint {
        validate_token(&checkpoint.kind, "checkpoint kind")?;
        if checkpoint.version == 0 {
            return Err(invalid("checkpoint version must be positive"));
        }
        validate_digest(&checkpoint.digest_sha256, "checkpoint digest")?;
        validate_time(checkpoint.verified_at_ms)?;
        validate_time(checkpoint.expires_at_ms)?;
        if checkpoint.expires_at_ms <= checkpoint.verified_at_ms {
            return Err(invalid("checkpoint must expire after verification"));
        }
    }
    Ok(())
}
fn validate_member_create(request: &AgentTeamMemberCreate) -> Result<(), StorageError> {
    validate_text(&request.role, MAX_ROLE_CHARS, "member role")?;
    if request.role != normalize_role(&request.role) {
        return Err(invalid("member role must be whitespace-normalized"));
    }
    validate_binding(&request.target)?;
    validate_team_mutation(&request.mutation)?;
    validate_time(request.now_ms)
}
fn validate_catalog_mutation(
    value: &AgentCatalogMutationIdentityRecord,
) -> Result<(), StorageError> {
    if value.idempotency_key.is_nil() {
        return Err(invalid("catalog mutation idempotency key must be non-nil"));
    }
    validate_digest(&value.request_hash, "catalog mutation request hash")?;
    validate_safe_integer(value.expected_catalog_revision, "expected catalog revision")
}
fn validate_team_mutation(value: &AgentTeamMutationIdentityRecord) -> Result<(), StorageError> {
    validate_catalog_mutation(&AgentCatalogMutationIdentityRecord {
        idempotency_key: value.idempotency_key,
        request_hash: value.request_hash.clone(),
        expected_catalog_revision: value.expected_catalog_revision,
    })?;
    validate_positive(value.expected_team_revision, "expected team revision")
}
fn validate_member_mutation(
    value: &AgentTeamMemberMutationIdentityRecord,
) -> Result<(), StorageError> {
    validate_team_mutation(&AgentTeamMutationIdentityRecord {
        idempotency_key: value.idempotency_key,
        request_hash: value.request_hash.clone(),
        expected_catalog_revision: value.expected_catalog_revision,
        expected_team_revision: value.expected_team_revision,
    })?;
    validate_positive(value.expected_member_revision, "expected member revision")
}
fn validate_operation_begin(request: &AgentOperationBegin) -> Result<(), StorageError> {
    validate_text(&request.namespace, MAX_TOKEN_CHARS, "operation namespace")?;
    validate_positive(request.session_revision, "session revision")?;
    validate_positive(request.attempt_epoch, "attempt epoch")?;
    validate_digest(&request.request_hash, "request hash")?;
    validate_time(request.now_ms)
}
fn validate_confirmation(
    request: &AgentHibernationConfirmationCreate,
    now_ms: i64,
) -> Result<(), StorageError> {
    validate_positive(request.session_revision, "session revision")?;
    validate_positive(request.attempt_epoch, "attempt epoch")?;
    validate_positive(request.provider_epoch, "provider epoch")?;
    validate_positive(request.window_generation, "window generation")?;
    validate_digest(&request.nonce_hash, "nonce hash")?;
    if !matches!(
        request.choice.as_str(),
        "leaveRunning" | "terminateAfterWarning"
    ) {
        return Err(invalid("invalid destructive choice"));
    }
    validate_time(now_ms)?;
    validate_time(request.expires_at_ms)?;
    if request.expires_at_ms <= now_ms || request.expires_at_ms - now_ms > 5 * 60 * 1_000 {
        return Err(invalid(
            "confirmation must be fresh and expire within five minutes",
        ));
    }
    Ok(())
}
fn validate_binding(binding: &AgentSessionBindingRecord) -> Result<(), StorageError> {
    if [
        binding.workspace_id,
        binding.pane_id,
        binding.tab_id,
        binding.agent_session_id,
    ]
    .contains(&Uuid::nil())
    {
        Err(invalid("binding UUIDs must be non-nil"))
    } else {
        Ok(())
    }
}
fn validate_token(value: &str, label: &str) -> Result<(), StorageError> {
    validate_text(value, MAX_TOKEN_CHARS, label)?;
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(invalid(format!("invalid {label}")))
    }
}
fn validate_text(value: &str, max: usize, label: &str) -> Result<(), StorageError> {
    if !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= max
        && value.chars().all(|character| !character.is_control())
    {
        Ok(())
    } else {
        Err(invalid(format!("invalid {label}")))
    }
}
fn validate_digest(value: &str, label: &str) -> Result<(), StorageError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(invalid(format!("invalid {label}")))
    }
}
fn validate_positive(value: u64, label: &str) -> Result<(), StorageError> {
    if value > 0 && value <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(invalid(format!("invalid {label}")))
    }
}
fn validate_safe_integer(value: u64, label: &str) -> Result<(), StorageError> {
    if value <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(invalid(format!("invalid {label}")))
    }
}
fn validate_time(value: i64) -> Result<(), StorageError> {
    if (0..=i64::try_from(MAX_SAFE_INTEGER).expect("safe integer fits i64")).contains(&value) {
        Ok(())
    } else {
        Err(invalid("timestamp is outside the safe integer range"))
    }
}
fn normalize_role(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidAgentCatalog {
        message: message.into(),
    }
}

fn validate_initial_fork_orphan(orphan: &AgentForkOrphanRecord) -> Result<(), StorageError> {
    validate_time(orphan.created_at_ms)?;
    validate_time(orphan.updated_at_ms)?;
    validate_text(&orphan.adapter_id, MAX_TOKEN_CHARS, "adapter id")?;
    validate_text(&orphan.adapter_version, MAX_TOKEN_CHARS, "adapter version")?;
    validate_text(&orphan.artifact_kind, MAX_TOKEN_CHARS, "artifact kind")?;
    validate_digest(&orphan.request_hash, "request hash")?;
    validate_digest(&orphan.artifact_digest_sha256, "artifact digest")?;
    if orphan.artifact_version == 0
        || orphan.cleanup_state != "pending"
        || orphan.cleanup_attempts != 0
        || orphan.created_at_ms != orphan.updated_at_ms
    {
        return Err(invalid("invalid initial fork orphan state"));
    }
    Ok(())
}

fn fork_orphan_recovery_directory(database: &Path) -> std::path::PathBuf {
    let mut path = database.as_os_str().to_owned();
    path.push(".fork-orphan-recovery");
    path.into()
}

fn decode_fork_orphan_recovery(path: &Path) -> Result<AgentForkOrphanRecord, StorageError> {
    let payload = std::fs::read(path).map_err(|source| StorageError::Permissions {
        path: path.to_path_buf(),
        message: source.to_string(),
    })?;
    serde_json::from_slice(&payload)
        .map_err(|source| invalid(format!("malformed fork orphan recovery file: {source}")))
}

fn sync_directory(path: &Path) -> Result<(), StorageError> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| StorageError::Permissions {
            path: path.to_path_buf(),
            message: source.to_string(),
        })
}
fn i64_from_u64(value: u64) -> Result<i64, StorageError> {
    validate_positive(value, "safe integer")?;
    i64::try_from(value).map_err(|_| invalid("integer does not fit SQLite"))
}
fn i64_from_u64_allow_zero(value: u64) -> Result<i64, StorageError> {
    validate_safe_integer(value, "safe integer")?;
    i64::try_from(value).map_err(|_| invalid("integer does not fit SQLite"))
}
fn u64_from_i64(value: i64) -> Result<u64, StorageError> {
    u64::try_from(value).map_err(|_| invalid("stored integer is negative"))
}
fn u64_from_i64_sql(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}
fn parse_uuid(value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
fn optional_uuid(value: Option<&str>) -> rusqlite::Result<Option<Uuid>> {
    value.map(parse_uuid).transpose()
}

fn uuid_at(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    parse_uuid(&row.get::<_, String>(index)?)
}

#[cfg(test)]
mod tests {
    use agent_workspace_core::ShortcutPlatform;
    use tempfile::tempdir;

    use super::*;

    const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn catalog_mutation(seed: u128, revision: u64) -> AgentCatalogMutationIdentityRecord {
        AgentCatalogMutationIdentityRecord {
            idempotency_key: Uuid::from_u128(seed),
            request_hash: DIGEST.to_owned(),
            expected_catalog_revision: revision,
        }
    }

    fn team_mutation(seed: u128, catalog: u64, team: u64) -> AgentTeamMutationIdentityRecord {
        AgentTeamMutationIdentityRecord {
            idempotency_key: Uuid::from_u128(seed),
            request_hash: DIGEST.to_owned(),
            expected_catalog_revision: catalog,
            expected_team_revision: team,
        }
    }

    fn member_mutation(
        seed: u128,
        catalog: u64,
        team: u64,
        member: u64,
    ) -> AgentTeamMemberMutationIdentityRecord {
        AgentTeamMemberMutationIdentityRecord {
            idempotency_key: Uuid::from_u128(seed),
            request_hash: DIGEST.to_owned(),
            expected_catalog_revision: catalog,
            expected_team_revision: team,
            expected_member_revision: member,
        }
    }

    fn store() -> (tempfile::TempDir, SqliteStateStore) {
        let directory = tempdir().unwrap();
        let store = SqliteStateStore::open(
            directory.path().join("catalog.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        (directory, store)
    }

    fn binding(seed: u128) -> AgentSessionBindingRecord {
        AgentSessionBindingRecord {
            workspace_id: Uuid::from_u128(seed + 1),
            pane_id: Uuid::from_u128(seed + 2),
            tab_id: Uuid::from_u128(seed + 3),
            agent_session_id: Uuid::from_u128(seed + 4),
        }
    }

    fn create(store: &SqliteStateStore, seed: u128) -> AgentSessionRecord {
        let request = AgentSessionCreate {
            binding: binding(seed),
            adapter_id: "test.adapter".to_owned(),
            adapter_version: "1.0.0".to_owned(),
            title: format!("session {seed}"),
            operation_id: Uuid::from_u128(seed + 10),
            request_hash: DIGEST.to_owned(),
            attempt_epoch: 1,
            now_ms: 1,
            forked_from: None,
        };
        match store.create_agent_session(&request).unwrap() {
            AgentSessionCreateOutcome::Created(session) => session,
            other => panic!("unexpected create outcome: {other:?}"),
        }
    }

    fn update(
        store: &SqliteStateStore,
        session: &AgentSessionRecord,
        lifecycle: AgentLifecycleRecord,
        hibernation_state: Option<AgentHibernationStateRecord>,
    ) -> AgentSessionRecord {
        store
            .update_agent_session(&AgentSessionUpdate {
                agent_session_id: session.binding.agent_session_id,
                expected_revision: session.revision,
                attempt_epoch: session.attempt_epoch,
                lifecycle,
                durable_intent: "none".to_owned(),
                restore_level: AgentRestoreLevelRecord::Unavailable,
                restore_outcome: None,
                hibernation_state,
                evidence_epoch: session.evidence_epoch + 1,
                verified_at_ms: session.last_verified_at_ms + 1,
                checkpoint: None,
            })
            .unwrap()
    }

    #[test]
    fn task_manager_agent_disposition_is_exact_and_replayable() {
        let (_directory, store) = store();
        let mut session = create(&store, 900);
        session = update(&store, &session, AgentLifecycleRecord::Launching, None);
        session = update(&store, &session, AgentLifecycleRecord::Running, None);
        let target_revision = session.revision;
        let completed = store
            .complete_agent_task_action(
                session.binding.agent_session_id,
                target_revision,
                session.attempt_epoch,
                "taskForceTerminated",
                session.last_verified_at_ms + 1,
            )
            .unwrap();
        assert_eq!(completed.lifecycle, AgentLifecycleRecord::Completed);
        assert_eq!(completed.durable_intent, "none");
        assert_eq!(
            store
                .load_agent_task_disposition(
                    session.binding.agent_session_id,
                    session.attempt_epoch,
                    completed.revision
                )
                .unwrap()
                .as_deref(),
            Some("taskForceTerminated")
        );
        let replay = store
            .complete_agent_task_action(
                session.binding.agent_session_id,
                target_revision,
                session.attempt_epoch,
                "taskForceTerminated",
                completed.last_verified_at_ms + 1,
            )
            .unwrap();
        assert_eq!(replay.revision, completed.revision);
        assert!(
            store
                .complete_agent_task_action(
                    session.binding.agent_session_id,
                    target_revision,
                    session.attempt_epoch,
                    "taskCancelled",
                    replay.last_verified_at_ms + 1,
                )
                .is_err()
        );
    }

    #[test]
    fn v9_is_metadata_only_and_creation_is_idempotent() {
        let (_directory, store) = store();
        assert_eq!(store.schema_version().unwrap(), crate::SCHEMA_VERSION);
        let request = AgentSessionCreate {
            binding: binding(100),
            adapter_id: "test.adapter".to_owned(),
            adapter_version: "1".to_owned(),
            title: "bounded title".to_owned(),
            operation_id: Uuid::from_u128(200),
            request_hash: DIGEST.to_owned(),
            attempt_epoch: 1,
            now_ms: 1,
            forked_from: None,
        };
        assert!(matches!(
            store.create_agent_session(&request).unwrap(),
            AgentSessionCreateOutcome::Created(_)
        ));
        assert!(matches!(
            store.create_agent_session(&request).unwrap(),
            AgentSessionCreateOutcome::Replay(_)
        ));
        let schema = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT group_concat(sql, ' ') FROM sqlite_schema WHERE name LIKE 'agent_%'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
            .to_lowercase();
        for forbidden in [
            "transcript",
            "prompt",
            "command",
            "credential",
            "runtime_id",
            "pid",
            "artifact_payload",
        ] {
            assert!(!schema.contains(forbidden), "schema leaked {forbidden}");
        }
    }

    #[test]
    fn fork_persists_and_replays_exact_adapter_destination_identity() {
        let (_directory, store) = store();
        let source = create(&store, 100);
        let destination = Uuid::from_u128(9_999);
        let operation = Uuid::from_u128(8_888);
        let invoke = || {
            store
                .fork_agent_session(
                    source.binding.agent_session_id,
                    destination,
                    Uuid::from_u128(201),
                    Uuid::from_u128(202),
                    Uuid::from_u128(203),
                    "fork".to_owned(),
                    "codex-thread-v1".to_owned(),
                    1,
                    DIGEST.to_owned(),
                    operation,
                    DIGEST.to_owned(),
                    1,
                    2,
                )
                .unwrap()
        };
        let AgentSessionCreateOutcome::Created(created) = invoke() else {
            panic!("must create")
        };
        assert_eq!(created.binding.agent_session_id, destination);
        let AgentSessionCreateOutcome::Replay(replayed) = invoke() else {
            panic!("must replay")
        };
        assert_eq!(replayed.binding.agent_session_id, destination);
        assert_eq!(
            replayed.forked_from.unwrap().source_agent_session_id,
            source.binding.agent_session_id
        );
    }

    #[test]
    fn v8_upgrade_is_backed_up_and_missing_v9_table_is_corruption() {
        let (directory, store) = store();
        let path = directory.path().join("catalog.sqlite3");
        drop(store);
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "DROP TABLE agent_hibernation_confirmations;
                 DROP TABLE agent_catalog_mutations;
                 DROP TABLE agent_attention;
                 DROP TABLE agent_team_members;
                 DROP TABLE agent_teams;
                 DROP TABLE agent_operations;
                 DROP TABLE agent_task_dispositions;
                 DROP TABLE agent_sessions;
                 DROP TABLE agent_catalog_state;
                 DROP TABLE sidebar_placements;
                 DROP TABLE text_box_documents;
                 DROP TABLE recently_closed_records;
                 DROP TABLE task_metadata;
                 DROP TABLE task_confirmations;
                 DROP TABLE task_action_outcomes;
                 UPDATE migration_metadata SET target_version = 8 WHERE singleton = 1;
                 PRAGMA user_version = 8;",
            )
            .unwrap();
        let (store, outcome) =
            SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
        let super::super::MigrationOutcome::Upgraded {
            from,
            to,
            backup_path,
        } = outcome
        else {
            panic!("expected backed-up migration");
        };
        assert_eq!((from, to), (8, crate::SCHEMA_VERSION));
        assert!(backup_path.exists());
        drop(store);
        Connection::open(&path)
            .unwrap()
            .execute_batch("DROP TABLE agent_attention;")
            .unwrap();
        assert!(matches!(
            SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
            Err(StorageError::CorruptSchema { .. })
        ));
    }

    #[test]
    fn hibernated_session_reopens_and_can_launch_a_fresh_attempt() {
        let (directory, store) = store();
        let mut session = create(&store, 300);
        session = update(&store, &session, AgentLifecycleRecord::Launching, None);
        session = update(&store, &session, AgentLifecycleRecord::Running, None);
        for state in [
            AgentHibernationStateRecord::Requested,
            AgentHibernationStateRecord::Preflight,
            AgentHibernationStateRecord::Checkpointing,
            AgentHibernationStateRecord::CheckpointVerified,
            AgentHibernationStateRecord::ProcessDispositionPending,
        ] {
            let lifecycle = if matches!(
                state,
                AgentHibernationStateRecord::Checkpointing
                    | AgentHibernationStateRecord::CheckpointVerified
                    | AgentHibernationStateRecord::ProcessDispositionPending
            ) {
                AgentLifecycleRecord::Checkpointing
            } else {
                AgentLifecycleRecord::Running
            };
            session = update(&store, &session, lifecycle, Some(state));
        }
        session = update(
            &store,
            &session,
            AgentLifecycleRecord::Hibernated,
            Some(AgentHibernationStateRecord::Hibernated),
        );
        drop(store);
        let reopened = SqliteStateStore::open(
            directory.path().join("catalog.sqlite3"),
            ShortcutPlatform::NonMacOs,
        )
        .unwrap();
        let restored = reopened
            .load_agent_session(session.binding.agent_session_id)
            .unwrap()
            .unwrap();
        let launched = reopened
            .update_agent_session(&AgentSessionUpdate {
                agent_session_id: restored.binding.agent_session_id,
                expected_revision: restored.revision,
                attempt_epoch: restored.attempt_epoch + 1,
                lifecycle: AgentLifecycleRecord::Launching,
                durable_intent: "restore".to_owned(),
                restore_level: AgentRestoreLevelRecord::LayoutRestart,
                restore_outcome: None,
                hibernation_state: None,
                evidence_epoch: restored.evidence_epoch + 1,
                verified_at_ms: restored.last_verified_at_ms + 1,
                checkpoint: None,
            })
            .unwrap();
        assert_eq!(launched.lifecycle, AgentLifecycleRecord::Launching);
        assert_eq!(launched.attempt_epoch, 2);
    }

    #[test]
    fn restore_attempt_atomically_fences_epoch_and_replays_original_identity() {
        let (_directory, store) = store();
        let session = create(&store, 350);
        let request = AgentOperationBegin {
            operation_id: Uuid::from_u128(360),
            namespace: "session.restore".to_owned(),
            agent_session_id: session.binding.agent_session_id,
            session_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
            request_hash: DIGEST.to_owned(),
            now_ms: session.last_verified_at_ms + 1,
        };

        let (begun, fenced) = store.begin_agent_restore_attempt(&request).unwrap();
        assert!(matches!(begun, AgentOperationBeginOutcome::Begun(_)));
        assert_eq!(fenced.revision, session.revision + 1);
        assert_eq!(fenced.attempt_epoch, session.attempt_epoch + 1);

        let (pending, current) = store.begin_agent_restore_attempt(&request).unwrap();
        assert!(matches!(pending, AgentOperationBeginOutcome::Pending(_)));
        assert_eq!(current, fenced);

        let concurrent = AgentOperationBegin {
            operation_id: Uuid::from_u128(361),
            session_revision: fenced.revision,
            attempt_epoch: fenced.attempt_epoch,
            now_ms: request.now_ms + 1,
            ..request.clone()
        };
        assert!(store.begin_agent_restore_attempt(&concurrent).is_err());

        let stale = AgentOperationBegin {
            operation_id: Uuid::from_u128(362),
            ..request.clone()
        };
        assert!(store.begin_agent_restore_attempt(&stale).is_err());

        let completed = store
            .finish_agent_restore_success(
                request.operation_id,
                &request.request_hash,
                request.agent_session_id,
                fenced.revision,
                fenced.attempt_epoch,
                AgentRestoreOutcomeRecord::Resumed,
                "resumed",
                request.now_ms + 2,
            )
            .unwrap();
        assert_eq!(completed.revision, fenced.revision + 1);
        assert_eq!(
            completed.restore_outcome,
            Some(AgentRestoreOutcomeRecord::Resumed)
        );
        assert_eq!(
            store
                .load_agent_operation("session.restore", request.operation_id)
                .unwrap()
                .unwrap()
                .state,
            AgentOperationStateRecord::Succeeded
        );
        let successor = AgentOperationBegin {
            operation_id: Uuid::from_u128(363),
            session_revision: completed.revision,
            attempt_epoch: completed.attempt_epoch,
            now_ms: request.now_ms + 3,
            ..request
        };
        assert!(matches!(
            store.begin_agent_restore_attempt(&successor).unwrap().0,
            AgentOperationBeginOutcome::Begun(_)
        ));
        assert_eq!(
            store
                .load_agent_session(session.binding.agent_session_id)
                .unwrap()
                .unwrap()
                .attempt_epoch,
            completed.attempt_epoch + 1
        );
    }

    #[test]
    fn team_graph_attention_and_move_remain_exact_and_acyclic() {
        let (_directory, store) = store();
        let first = create(&store, 400);
        let second = create(&store, 500);
        let team = Uuid::from_u128(600);
        assert!(matches!(
            store
                .create_agent_team(team, "team", &catalog_mutation(610, 2), 2)
                .unwrap(),
            AgentCatalogMutationOutcome::Applied(_)
        ));
        let root = Uuid::from_u128(601);
        let child = Uuid::from_u128(602);
        store
            .add_agent_team_member(&AgentTeamMemberCreate {
                member_id: root,
                team_id: team,
                role: "lead".to_owned(),
                target: first.binding.clone(),
                parent_member_id: None,
                mutation: team_mutation(611, 3, 1),
                now_ms: 3,
            })
            .unwrap();
        store
            .add_agent_team_member(&AgentTeamMemberCreate {
                member_id: child,
                team_id: team,
                role: "worker".to_owned(),
                target: second.binding.clone(),
                parent_member_id: Some(root),
                mutation: team_mutation(612, 4, 2),
                now_ms: 4,
            })
            .unwrap();
        assert!(
            store
                .update_agent_team_member(
                    team,
                    root,
                    "lead",
                    Some(child),
                    &member_mutation(613, 5, 3, 1),
                    5
                )
                .is_err()
        );
        store
            .set_agent_attention(
                &second.binding,
                Some((team, child)),
                AgentAttentionStateRecord::Urgent,
                None,
                6,
            )
            .unwrap();
        let catalog = store.load_agent_catalog().unwrap();
        assert_eq!(catalog.attention[0].target, second.binding);
    }

    #[test]
    fn team_mutations_cas_and_replay_first_terminal_results() {
        let (_directory, store) = store();
        let session = create(&store, 1_100);
        let team_id = Uuid::from_u128(1_200);
        let create_identity = catalog_mutation(1_201, 1);
        let applied = store
            .create_agent_team(team_id, "team", &create_identity, 2)
            .unwrap();
        assert!(matches!(applied, AgentCatalogMutationOutcome::Applied(_)));
        assert!(matches!(
            store
                .create_agent_team(team_id, "team", &create_identity, 3)
                .unwrap(),
            AgentCatalogMutationOutcome::Replay(AgentTeamRecord { revision: 1, .. })
        ));
        let mut conflicting = create_identity.clone();
        conflicting.request_hash = "b".repeat(64);
        assert_eq!(
            store
                .create_agent_team(team_id, "team", &conflicting, 3)
                .unwrap(),
            AgentCatalogMutationOutcome::Conflict
        );

        let stale = team_mutation(1_202, 1, 1);
        assert_eq!(
            store
                .update_agent_team(team_id, "renamed", &stale, 3)
                .unwrap(),
            AgentCatalogMutationOutcome::StaleCatalog
        );
        assert_eq!(
            store
                .update_agent_team(team_id, "renamed", &stale, 4)
                .unwrap(),
            AgentCatalogMutationOutcome::StaleCatalog
        );

        let member_id = Uuid::from_u128(1_203);
        assert!(matches!(
            store
                .add_agent_team_member(&AgentTeamMemberCreate {
                    member_id,
                    team_id,
                    role: "worker".to_owned(),
                    target: session.binding,
                    parent_member_id: None,
                    mutation: team_mutation(1_204, 2, 1),
                    now_ms: 5,
                })
                .unwrap(),
            AgentCatalogMutationOutcome::Applied(_)
        ));
        let delete_member = member_mutation(1_205, 3, 2, 1);
        let deleted = store
            .delete_agent_team_member(team_id, member_id, &delete_member, 6)
            .unwrap();
        assert!(matches!(deleted, AgentCatalogMutationOutcome::Applied(_)));
        assert!(matches!(
            store
                .delete_agent_team_member(team_id, member_id, &delete_member, 7)
                .unwrap(),
            AgentCatalogMutationOutcome::Replay(AgentTeamMemberDeleteRecord {
                deleted_member_revision: 1,
                ..
            })
        ));
        let delete_team = team_mutation(1_206, 4, 3);
        assert!(matches!(
            store.delete_agent_team(team_id, &delete_team, 8).unwrap(),
            AgentCatalogMutationOutcome::Applied(_)
        ));
        let database_path = store.path().to_path_buf();
        drop(store);
        let reopened = SqliteStateStore::open(database_path, ShortcutPlatform::NonMacOs).unwrap();
        assert!(matches!(
            reopened
                .delete_agent_team(team_id, &delete_team, 9)
                .unwrap(),
            AgentCatalogMutationOutcome::Replay(AgentTeamDeleteRecord {
                deleted_team_revision: 3,
                ..
            })
        ));
    }

    #[test]
    fn restart_reconciliation_and_terminal_race_are_first_writer_wins() {
        let (_directory, store) = store();
        let session = create(&store, 700);
        let request = AgentOperationBegin {
            operation_id: Uuid::from_u128(800),
            namespace: "session.restore".to_owned(),
            agent_session_id: session.binding.agent_session_id,
            session_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
            request_hash: DIGEST.to_owned(),
            now_ms: 2,
        };
        assert!(matches!(
            store.begin_agent_operation(&request).unwrap(),
            AgentOperationBeginOutcome::Begun(_)
        ));
        assert_eq!(
            store
                .reconcile_agent_operations(&BTreeSet::new(), 3)
                .unwrap(),
            1
        );
        let result = store
            .finish_agent_operation(
                &request.namespace,
                request.operation_id,
                DIGEST,
                AgentOperationStateRecord::Succeeded,
                "lateSuccess",
                4,
            )
            .unwrap();
        assert_eq!(result.state, AgentOperationStateRecord::Interrupted);
        assert_eq!(result.terminal_code.as_deref(), Some("serviceRestart"));
    }

    #[test]
    fn confirmation_is_rejected_after_session_state_advances() {
        let (_directory, store) = store();
        let mut session = create(&store, 900);
        session = update(&store, &session, AgentLifecycleRecord::Launching, None);
        session = update(&store, &session, AgentLifecycleRecord::Running, None);
        session = update(
            &store,
            &session,
            AgentLifecycleRecord::Running,
            Some(AgentHibernationStateRecord::Requested),
        );
        session = update(
            &store,
            &session,
            AgentLifecycleRecord::Running,
            Some(AgentHibernationStateRecord::Preflight),
        );
        session = update(
            &store,
            &session,
            AgentLifecycleRecord::Running,
            Some(AgentHibernationStateRecord::ConfirmationRequired),
        );
        let confirmation = AgentHibernationConfirmationCreate {
            confirmation_id: Uuid::from_u128(1_000),
            agent_session_id: session.binding.agent_session_id,
            session_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
            choice: "leaveRunning".to_owned(),
            provider_id: Uuid::from_u128(1_001),
            provider_epoch: 1,
            provider_lease_id: Uuid::from_u128(1_002),
            window_id: Uuid::from_u128(1_003),
            window_generation: 1,
            nonce_hash: DIGEST.to_owned(),
            expires_at_ms: 1_000,
        };
        store
            .create_hibernation_confirmation(&confirmation, 100)
            .unwrap();
        let _advanced = update(
            &store,
            &session,
            AgentLifecycleRecord::Running,
            Some(AgentHibernationStateRecord::Canceled),
        );
        assert_eq!(
            store
                .consume_hibernation_confirmation(&confirmation, 101)
                .unwrap(),
            AgentHibernationConfirmationOutcome::Conflict
        );
    }

    #[test]
    fn challenge_replay_is_exact_and_restart_invalidation_burns_it() {
        let (_directory, store) = store();
        let mut session = create(&store, 1_010);
        session = update(&store, &session, AgentLifecycleRecord::Launching, None);
        session = update(&store, &session, AgentLifecycleRecord::Running, None);
        for state in [
            AgentHibernationStateRecord::Requested,
            AgentHibernationStateRecord::Preflight,
            AgentHibernationStateRecord::ConfirmationRequired,
        ] {
            session = update(&store, &session, AgentLifecycleRecord::Running, Some(state));
        }
        let operation_id = Uuid::from_u128(1_020);
        let confirmation = AgentHibernationConfirmationCreate {
            confirmation_id: Uuid::from_u128(1_021),
            agent_session_id: session.binding.agent_session_id,
            session_revision: session.revision,
            attempt_epoch: session.attempt_epoch,
            choice: "terminateAfterWarning".to_owned(),
            provider_id: Uuid::from_u128(1_022),
            provider_epoch: 2,
            provider_lease_id: Uuid::from_u128(1_023),
            window_id: Uuid::from_u128(1_024),
            window_generation: 3,
            nonce_hash: DIGEST.to_owned(),
            expires_at_ms: 1_000,
        };
        store
            .create_hibernation_confirmation(&confirmation, 100)
            .unwrap();
        store
            .link_hibernation_confirmation_replay(operation_id, confirmation.confirmation_id)
            .unwrap();
        let replay = store
            .load_hibernation_challenge_replay(operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(replay.confirmation.request, confirmation);
        assert_eq!(
            store
                .invalidate_pending_hibernation_confirmations(101)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .consume_hibernation_confirmation(&confirmation, 102)
                .unwrap(),
            AgentHibernationConfirmationOutcome::AlreadyConsumed
        );
    }

    #[test]
    fn v13_preserves_orphan_provenance_and_non_resumable_disposition() {
        let (_directory, store) = store();
        let mut session = create(&store, 1_100);
        let destination = Uuid::from_u128(1_200);
        store
            .record_agent_fork_orphan(&AgentForkOrphanRecord {
                destination_agent_session_id: destination,
                source_agent_session_id: session.binding.agent_session_id,
                adapter_id: session.adapter_id.clone(),
                adapter_version: session.adapter_version.clone(),
                operation_id: Uuid::from_u128(1_201),
                request_hash: DIGEST.to_owned(),
                artifact_kind: "test-artifact".to_owned(),
                artifact_version: 1,
                artifact_digest_sha256: DIGEST.to_owned(),
                cleanup_state: "pending".to_owned(),
                cleanup_attempts: 0,
                created_at_ms: 2,
                updated_at_ms: 2,
            })
            .unwrap();
        store
            .mark_agent_fork_orphan_archive_failed(destination, 3)
            .unwrap();
        let orphan = store.load_agent_fork_orphans().unwrap().pop().unwrap();
        assert_eq!(orphan.destination_agent_session_id, destination);
        assert_eq!(orphan.cleanup_state, "archiveFailed");
        assert_eq!(orphan.cleanup_attempts, 1);

        session = update(&store, &session, AgentLifecycleRecord::Launching, None);
        session = update(&store, &session, AgentLifecycleRecord::Running, None);
        for state in [
            AgentHibernationStateRecord::Requested,
            AgentHibernationStateRecord::Preflight,
            AgentHibernationStateRecord::ConfirmationRequired,
            AgentHibernationStateRecord::ProcessDispositionPending,
        ] {
            session = update(&store, &session, AgentLifecycleRecord::Running, Some(state));
        }
        let terminated = store
            .record_terminated_after_warning(
                session.binding.agent_session_id,
                session.revision,
                session.attempt_epoch,
                Uuid::from_u128(1_300),
                4,
            )
            .unwrap();
        assert_eq!(terminated.lifecycle, AgentLifecycleRecord::Completed);
        assert_eq!(
            terminated.restore_level,
            AgentRestoreLevelRecord::Unavailable
        );
        assert_eq!(
            terminated.hibernation_state,
            Some(AgentHibernationStateRecord::TerminatedAfterWarning)
        );
        assert!(terminated.checkpoint.is_none());
    }
}

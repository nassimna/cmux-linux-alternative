//! Canonical, privacy-preserving contracts for agent session orchestration.
//!
//! These DTOs describe the `agent-sessions-v1` boundary. They do not advertise
//! the capability or imply that a persistence/service implementation exists.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{ActionInvocationTarget, DesktopProviderIdentityParams};

pub const AGENT_SESSIONS_CAPABILITY: &str = "agent-sessions-v1";
pub const AGENT_SESSION_CATALOG_VERSION: u16 = 1;
pub const MAX_AGENT_SESSIONS: usize = 512;
pub const MAX_AGENT_TEAMS: usize = 64;
pub const MAX_AGENT_TEAM_MEMBERS: usize = 64;
pub const MAX_AGENT_TITLE_SCALARS: usize = 160;
pub const MAX_AGENT_ROLE_SCALARS: usize = 80;
pub const MAX_ADAPTER_ID_SCALARS: usize = 64;
pub const MAX_ADAPTER_VERSION_SCALARS: usize = 64;
pub const MAX_ARTIFACT_KIND_SCALARS: usize = 64;
pub const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentRestoreLevel {
    LiveReattach,
    ToolResume,
    LayoutRestart,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentRestoreOutcome {
    LiveReattached,
    ResumeAttempting,
    Resumed,
    LayoutRestarted,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentSessionLifecycle {
    Created,
    Launching,
    Running,
    Waiting,
    Checkpointing,
    Hibernated,
    Completed,
    Failed,
    Unavailable,
}

impl AgentSessionLifecycle {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use AgentSessionLifecycle as S;
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
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentHibernationState {
    Requested,
    Preflight,
    ConfirmationRequired,
    Checkpointing,
    CheckpointVerified,
    ProcessDispositionPending,
    Hibernated,
    TerminatedAfterWarning,
    Canceled,
    Failed,
    Interrupted,
}

impl AgentHibernationState {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use AgentHibernationState as S;
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentAttentionState {
    Informational,
    Completed,
    Waiting,
    Urgent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentDestructiveChoice {
    LeaveRunning,
    TerminateAfterWarning,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentOperationIdentity {
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
    #[serde(deserialize_with = "request_hash")]
    pub request_hash: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub session_revision: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub attempt_epoch: u64,
}

/// Idempotency and compare-and-swap authority for creating a catalog child.
/// This identity is deliberately independent of any agent session attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentCatalogMutationIdentity {
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
    #[serde(deserialize_with = "request_hash")]
    pub request_hash: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expected_catalog_revision: u64,
}

/// Idempotency and exact catalog/team revision authority for a team mutation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamMutationIdentity {
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
    #[serde(deserialize_with = "request_hash")]
    pub request_hash: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expected_catalog_revision: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub expected_team_revision: u64,
}

/// Idempotency and exact catalog/team/member revision authority for member changes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamMemberMutationIdentity {
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
    #[serde(deserialize_with = "request_hash")]
    pub request_hash: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expected_catalog_revision: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub expected_team_revision: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub expected_member_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionBinding {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub agent_session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentArtifactDescriptor {
    #[serde(deserialize_with = "version_one")]
    pub descriptor_version: u16,
    #[serde(deserialize_with = "artifact_kind")]
    pub kind: String,
    #[serde(deserialize_with = "sha256_digest")]
    pub digest_sha256: String,
    #[serde(deserialize_with = "artifact_size")]
    #[ts(type = "number")]
    pub size_bytes: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub created_at_ms: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentArtifactDescriptorWire {
    #[serde(deserialize_with = "version_one")]
    descriptor_version: u16,
    #[serde(deserialize_with = "artifact_kind")]
    kind: String,
    #[serde(deserialize_with = "sha256_digest")]
    digest_sha256: String,
    #[serde(deserialize_with = "artifact_size")]
    size_bytes: u64,
    #[serde(deserialize_with = "safe_integer")]
    created_at_ms: u64,
    #[serde(deserialize_with = "safe_integer")]
    expires_at_ms: u64,
}

impl<'de> Deserialize<'de> for AgentArtifactDescriptor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AgentArtifactDescriptorWire::deserialize(deserializer)?;
        if wire.expires_at_ms <= wire.created_at_ms {
            return Err(serde::de::Error::custom(
                "artifact expiry must follow creation",
            ));
        }
        Ok(Self {
            descriptor_version: wire.descriptor_version,
            kind: wire.kind,
            digest_sha256: wire.digest_sha256,
            size_bytes: wire.size_bytes,
            created_at_ms: wire.created_at_ms,
            expires_at_ms: wire.expires_at_ms,
        })
    }
}

/// Immutable fork provenance contains only a sanitized artifact identity. It
/// intentionally omits artifact location, payload, size, expiry, and runtime data.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentProvenanceArtifact {
    #[serde(deserialize_with = "version_one")]
    pub version: u16,
    #[serde(deserialize_with = "artifact_kind")]
    pub kind: String,
    #[serde(deserialize_with = "sha256_digest")]
    pub digest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentForkProvenance {
    #[serde(deserialize_with = "version_one")]
    pub provenance_version: u16,
    #[serde(deserialize_with = "uuid_string")]
    pub forked_from_agent_session_id: String,
    pub artifact: AgentProvenanceArtifact,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentRestoreAssessment {
    pub level: AgentRestoreLevel,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub assessed_at_ms: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub evidence_epoch: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AgentSessionSnapshot {
    #[serde(deserialize_with = "version_one")]
    pub catalog_version: u16,
    pub binding: AgentSessionBinding,
    #[serde(deserialize_with = "adapter_id")]
    pub adapter_id: String,
    #[serde(deserialize_with = "adapter_version")]
    pub adapter_version: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    pub lifecycle: AgentSessionLifecycle,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_hibernation_state"
    )]
    pub hibernation_state: Option<AgentHibernationState>,
    pub restore: AgentRestoreAssessment,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_restore_outcome"
    )]
    pub last_restore_outcome: Option<AgentRestoreOutcome>,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub attempt_epoch: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub last_verified_at_ms: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub team_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub member_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_provenance"
    )]
    pub forked_from: Option<AgentForkProvenance>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AgentTeamMemberSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub member_id: String,
    #[serde(deserialize_with = "role")]
    pub role: String,
    pub target: AgentSessionBinding,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub parent_member_id: Option<String>,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(deserialize_with = "bounded_members")]
    pub members: Vec<AgentTeamMemberSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentCatalogListParams {
    #[serde(deserialize_with = "version_one")]
    pub catalog_version: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentCatalogListResult {
    #[serde(deserialize_with = "version_one")]
    pub catalog_version: u16,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(deserialize_with = "bounded_sessions")]
    pub sessions: Vec<AgentSessionSnapshot>,
    #[serde(deserialize_with = "bounded_teams")]
    pub teams: Vec<AgentTeamSnapshot>,
    #[serde(deserialize_with = "bounded_attention")]
    pub attention: Vec<AgentAttentionSetResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentCatalogGetResult {
    pub session: AgentSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentCatalogRegisterParams {
    #[serde(deserialize_with = "version_one")]
    pub catalog_version: u16,
    pub binding: AgentSessionBinding,
    #[serde(deserialize_with = "adapter_id")]
    pub adapter_id: String,
    #[serde(deserialize_with = "adapter_version")]
    pub adapter_version: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    pub operation: AgentOperationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentCatalogRegisterResult {
    pub session: AgentSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentRestoreAssessResult {
    pub assessment: AgentRestoreAssessment,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionRestoreResult {
    pub outcome: AgentRestoreOutcome,
    pub session: AgentSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionForkParams {
    #[serde(deserialize_with = "uuid_string")]
    pub source_agent_session_id: String,
    pub destination: AgentSessionPlacement,
    #[serde(deserialize_with = "title")]
    pub title: String,
    pub operation: AgentOperationIdentity,
}

/// Exact durable placement for a fork. The service allocates the fresh agent
/// session identity; callers cannot choose or reuse it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionPlacement {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionForkResult {
    pub session: AgentSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamCreateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    pub mutation: AgentCatalogMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamUpdateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "title")]
    pub title: String,
    pub mutation: AgentTeamMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamMutationResult {
    pub team: AgentTeamSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AgentTeamMemberCreateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub member_id: String,
    #[serde(deserialize_with = "role")]
    pub role: String,
    pub target: AgentSessionBinding,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub parent_member_id: Option<String>,
    pub mutation: AgentTeamMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AgentTeamMemberUpdateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub member_id: String,
    #[serde(deserialize_with = "role")]
    pub role: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub parent_member_id: Option<String>,
    pub mutation: AgentTeamMemberMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamMemberMoveParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub member_id: String,
    pub target: AgentSessionBinding,
    pub mutation: AgentTeamMemberMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamMemberMutationResult {
    pub member: AgentTeamMemberSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AgentAttentionTarget {
    pub target: AgentSessionBinding,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub team_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub member_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentAttentionSetParams {
    pub target: AgentAttentionTarget,
    pub state: AgentAttentionState,
    #[serde(deserialize_with = "required_nullable_safe_integer")]
    #[ts(type = "number | null")]
    pub expected_attention_revision: Option<u64>,
    pub operation: AgentOperationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentAttentionSetResult {
    pub target: AgentAttentionTarget,
    pub state: AgentAttentionState,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct AgentHibernationPreflightResult {
    pub state: AgentHibernationState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub confirmation_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_hibernation_challenge"
    )]
    pub challenge: Option<AgentHibernationChallenge>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_artifact"
    )]
    pub checkpoint: Option<AgentArtifactDescriptor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentHibernationChallengeRequest {
    pub choice: AgentDestructiveChoice,
    pub provider: DesktopProviderIdentityParams,
    pub window: ActionInvocationTarget,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentHibernationChallenge {
    #[serde(deserialize_with = "uuid_string")]
    pub confirmation_id: String,
    pub choice: AgentDestructiveChoice,
    pub provider: DesktopProviderIdentityParams,
    pub window: ActionInvocationTarget,
    #[serde(deserialize_with = "nonce")]
    pub nonce: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentHibernationConfirmParams {
    #[serde(deserialize_with = "uuid_string")]
    pub agent_session_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub confirmation_id: String,
    pub choice: AgentDestructiveChoice,
    pub provider: DesktopProviderIdentityParams,
    pub window: ActionInvocationTarget,
    #[serde(deserialize_with = "nonce")]
    pub nonce: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
    pub operation: AgentOperationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentHibernationMutationResult {
    pub state: AgentHibernationState,
}

fn validate_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= max
        && value.chars().all(|c| !c.is_control())
}

fn validated_string<'de, D>(deserializer: D, label: &str, max: usize) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if validate_text(&value, max) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(format!("invalid {label}")))
    }
}

fn uuid_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}
fn adapter_id<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    validated_string(d, "adapter ID", MAX_ADAPTER_ID_SCALARS)
}
fn adapter_version<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    validated_string(d, "adapter version", MAX_ADAPTER_VERSION_SCALARS)
}
fn artifact_kind<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    validated_string(d, "artifact kind", MAX_ARTIFACT_KIND_SCALARS)
}
fn title<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    validated_string(d, "title", MAX_AGENT_TITLE_SCALARS)
}
fn role<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    validated_string(d, "role", MAX_AGENT_ROLE_SCALARS)
}
fn nonce<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    validated_string(d, "nonce", 128)
}
fn optional_hibernation_challenge<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<AgentHibernationChallenge>, D::Error> {
    Option::<AgentHibernationChallenge>::deserialize(d)
}
fn request_hash<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    sha256_digest(d)
}
fn sha256_digest<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "expected lowercase SHA-256 digest",
        ))
    }
}
fn safe_integer<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(d)?;
    (value <= MAX_SAFE_INTEGER)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("integer exceeds JavaScript safe range"))
}
fn positive_safe_integer<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let value = safe_integer(d)?;
    (value > 0)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("integer must be positive"))
}
fn required_nullable_safe_integer<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<u64>, D::Error> {
    let value = Option::<u64>::deserialize(d)?;
    if value.is_some_and(|value| value > MAX_SAFE_INTEGER) {
        Err(serde::de::Error::custom(
            "integer exceeds JavaScript safe range",
        ))
    } else {
        Ok(value)
    }
}
fn version_one<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let value = u16::deserialize(d)?;
    (value == AGENT_SESSION_CATALOG_VERSION)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("unsupported agent session contract version"))
}
fn artifact_size<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let value = safe_integer(d)?;
    (value > 0 && value <= MAX_ARTIFACT_BYTES)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("artifact size is out of range"))
}

fn optional_non_null<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}
fn optional_uuid<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = String::deserialize(d)?;
    Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(Some(value))
}
fn optional_restore_outcome<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<AgentRestoreOutcome>, D::Error> {
    optional_non_null(d)
}
fn optional_hibernation_state<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<AgentHibernationState>, D::Error> {
    optional_non_null(d)
}
fn optional_provenance<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<AgentForkProvenance>, D::Error> {
    optional_non_null(d)
}
fn optional_artifact<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<AgentArtifactDescriptor>, D::Error> {
    optional_non_null(d)
}

fn bounded_sessions<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<AgentSessionSnapshot>, D::Error> {
    bounded_vec(d, MAX_AGENT_SESSIONS, "sessions")
}
fn bounded_teams<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<AgentTeamSnapshot>, D::Error> {
    bounded_vec(d, MAX_AGENT_TEAMS, "teams")
}
fn bounded_attention<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<AgentAttentionSetResult>, D::Error> {
    bounded_vec(d, MAX_AGENT_SESSIONS, "attention records")
}
fn bounded_members<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<AgentTeamMemberSnapshot>, D::Error> {
    let values: Vec<AgentTeamMemberSnapshot> = bounded_vec(d, MAX_AGENT_TEAM_MEMBERS, "members")?;
    let ids: std::collections::BTreeSet<_> = values.iter().map(|m| m.member_id.as_str()).collect();
    if ids.len() != values.len() {
        return Err(serde::de::Error::custom("duplicate member ID"));
    }
    let session_ids: std::collections::BTreeSet<_> = values
        .iter()
        .map(|member| member.target.agent_session_id.as_str())
        .collect();
    if session_ids.len() != values.len() {
        return Err(serde::de::Error::custom("duplicate member session binding"));
    }
    for member in &values {
        if member.parent_member_id.as_deref() == Some(member.member_id.as_str()) {
            return Err(serde::de::Error::custom(
                "member graph contains a self-cycle",
            ));
        }
        if member
            .parent_member_id
            .as_ref()
            .is_some_and(|parent| !ids.contains(parent.as_str()))
        {
            return Err(serde::de::Error::custom(
                "member parent is outside the team",
            ));
        }
        let mut cursor = member.parent_member_id.as_deref();
        let mut seen = std::collections::BTreeSet::new();
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return Err(serde::de::Error::custom("member graph contains a cycle"));
            }
            cursor = values
                .iter()
                .find(|m| m.member_id == id)
                .and_then(|m| m.parent_member_id.as_deref());
        }
    }
    Ok(values)
}
fn bounded_vec<'de, D, T>(d: D, max: usize, label: &str) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let values = Vec::<T>::deserialize(d)?;
    if values.len() <= max {
        Ok(values)
    } else {
        Err(serde::de::Error::custom(format!("too many {label}")))
    }
}

macro_rules! id_params_real {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[ts(export)]
        pub struct $name {
            #[serde(deserialize_with = "uuid_string")]
            pub agent_session_id: String,
        }
    };
}
macro_rules! operation_params_real {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[ts(export)]
        pub struct $name {
            #[serde(deserialize_with = "uuid_string")]
            pub agent_session_id: String,
            pub operation: AgentOperationIdentity,
        }
    };
}
id_params_real!(AgentCatalogGetParams);
operation_params_real!(AgentRestoreAssessParams);
operation_params_real!(AgentSessionRestoreParams);
operation_params_real!(AgentHibernationCancelParams);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentHibernationPreflightParams {
    #[serde(deserialize_with = "uuid_string")]
    pub agent_session_id: String,
    pub challenge: AgentHibernationChallengeRequest,
    pub operation: AgentOperationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamDeleteParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    pub mutation: AgentTeamMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentTeamMemberDeleteParams {
    #[serde(deserialize_with = "uuid_string")]
    pub team_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub member_id: String,
    pub mutation: AgentTeamMemberMutationIdentity,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_session_and_hibernation_states_do_not_revert() {
        assert!(AgentSessionLifecycle::Created.can_transition_to(AgentSessionLifecycle::Launching));
        assert!(
            !AgentSessionLifecycle::Completed.can_transition_to(AgentSessionLifecycle::Running)
        );
        assert!(
            AgentSessionLifecycle::Hibernated.can_transition_to(AgentSessionLifecycle::Launching)
        );
        assert!(
            AgentHibernationState::CheckpointVerified
                .can_transition_to(AgentHibernationState::ProcessDispositionPending)
        );
        assert!(
            !AgentHibernationState::Hibernated
                .can_transition_to(AgentHibernationState::Checkpointing)
        );
    }

    #[test]
    fn operation_rejects_unsafe_numbers_and_unknown_or_null_fields() {
        let base = json!({
            "agentSessionId": Uuid::new_v4(),
            "operation": {"idempotencyKey": Uuid::new_v4(), "requestHash": "a".repeat(64), "sessionRevision": 1, "attemptEpoch": 1}
        });
        assert!(serde_json::from_value::<AgentSessionRestoreParams>(base.clone()).is_ok());
        let mut zero_revision = base.clone();
        zero_revision["operation"]["sessionRevision"] = json!(0);
        assert!(serde_json::from_value::<AgentSessionRestoreParams>(zero_revision).is_err());
        let mut unsafe_value = base.clone();
        unsafe_value["operation"]["attemptEpoch"] = json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<AgentSessionRestoreParams>(unsafe_value).is_err());
        let mut unknown = base;
        unknown["secret"] = json!(null);
        assert!(serde_json::from_value::<AgentSessionRestoreParams>(unknown).is_err());
        let invalid_artifact = json!({
            "descriptorVersion": 1,
            "kind": "resume-v1",
            "digestSha256": "b".repeat(64),
            "sizeBytes": 1,
            "createdAtMs": 10,
            "expiresAtMs": 10
        });
        assert!(serde_json::from_value::<AgentArtifactDescriptor>(invalid_artifact).is_err());
    }

    #[test]
    fn team_mutations_use_exact_catalog_team_and_member_authority() {
        let id = Uuid::new_v4();
        let create = json!({
            "teamId": id,
            "title": "team",
            "mutation": {
                "idempotencyKey": Uuid::new_v4(),
                "requestHash": "a".repeat(64),
                "expectedCatalogRevision": 0
            }
        });
        assert!(serde_json::from_value::<AgentTeamCreateParams>(create.clone()).is_ok());
        let mut fake_attempt = create.clone();
        fake_attempt["mutation"]["attemptEpoch"] = json!(1);
        assert!(serde_json::from_value::<AgentTeamCreateParams>(fake_attempt).is_err());

        let member_update = json!({
            "teamId": id,
            "memberId": Uuid::new_v4(),
            "role": "worker",
            "mutation": {
                "idempotencyKey": Uuid::new_v4(),
                "requestHash": "b".repeat(64),
                "expectedCatalogRevision": 3,
                "expectedTeamRevision": 2,
                "expectedMemberRevision": 1
            }
        });
        assert!(
            serde_json::from_value::<AgentTeamMemberUpdateParams>(member_update.clone()).is_ok()
        );
        let mut missing_member_revision = member_update.clone();
        missing_member_revision["mutation"]
            .as_object_mut()
            .unwrap()
            .remove("expectedMemberRevision");
        assert!(
            serde_json::from_value::<AgentTeamMemberUpdateParams>(missing_member_revision).is_err()
        );
        let mut zero_team_revision = member_update;
        zero_team_revision["mutation"]["expectedTeamRevision"] = json!(0);
        assert!(serde_json::from_value::<AgentTeamMemberUpdateParams>(zero_team_revision).is_err());
    }

    #[test]
    fn attention_requires_explicit_nullable_cas_and_returns_revision() {
        let binding = json!({
            "workspaceId": Uuid::new_v4(),
            "paneId": Uuid::new_v4(),
            "tabId": Uuid::new_v4(),
            "agentSessionId": Uuid::new_v4()
        });
        let operation = json!({
            "idempotencyKey": Uuid::new_v4(),
            "requestHash": "c".repeat(64),
            "sessionRevision": 1,
            "attemptEpoch": 1
        });
        let first = json!({
            "target": { "target": binding },
            "state": "urgent",
            "expectedAttentionRevision": null,
            "operation": operation
        });
        assert!(serde_json::from_value::<AgentAttentionSetParams>(first.clone()).is_ok());
        let mut missing = first.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("expectedAttentionRevision");
        assert!(serde_json::from_value::<AgentAttentionSetParams>(missing).is_err());
        let mut unsafe_revision = first;
        unsafe_revision["expectedAttentionRevision"] = json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<AgentAttentionSetParams>(unsafe_revision).is_err());
    }

    #[test]
    fn team_graph_rejects_cycles_duplicate_bindings_and_unknown_versions() {
        let team = |second_parent: &str, second_session: &str| {
            json!({
                "teamId": "10000000-0000-4000-8000-000000000001",
                "title": "team",
                "revision": 1,
                "members": [
                    {
                        "memberId": "10000000-0000-4000-8000-000000000002",
                        "role": "lead",
                        "target": {
                            "workspaceId": "10000000-0000-4000-8000-000000000001",
                            "paneId": "10000000-0000-4000-8000-000000000002",
                            "tabId": "10000000-0000-4000-8000-000000000003",
                            "agentSessionId": "10000000-0000-4000-8000-000000000004"
                        },
                        "parentMemberId": "10000000-0000-4000-8000-000000000003",
                        "revision": 1
                    },
                    {
                        "memberId": "10000000-0000-4000-8000-000000000003",
                        "role": "worker",
                        "target": {
                            "workspaceId": "10000000-0000-4000-8000-000000000001",
                            "paneId": "10000000-0000-4000-8000-000000000002",
                            "tabId": "10000000-0000-4000-8000-000000000005",
                            "agentSessionId": second_session
                        },
                        "parentMemberId": second_parent,
                        "revision": 1
                    }
                ]
            })
        };
        assert!(
            serde_json::from_value::<AgentTeamSnapshot>(team(
                "10000000-0000-4000-8000-000000000002",
                "10000000-0000-4000-8000-000000000006"
            ))
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentTeamSnapshot>(team(
                "10000000-0000-4000-8000-000000000001",
                "10000000-0000-4000-8000-000000000004"
            ))
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentCatalogListParams>(json!({"catalogVersion": 2})).is_err()
        );
    }

    #[test]
    fn privacy_markers_are_absent_from_catalog_wire_shape() {
        let source = include_str!("agent_sessions.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("module source has a pre-test section")
            .to_ascii_lowercase();
        for forbidden in [
            "pub pid",
            "pub prompt",
            "pub transcript",
            "pub command",
            "pub secret",
            "checkpoint_bytes",
            "runtime_checkpoint",
        ] {
            assert!(
                !source.contains(forbidden),
                "privacy marker {forbidden} entered a public field"
            );
        }
    }
}

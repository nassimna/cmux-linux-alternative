//! Closed, privacy-preserving contracts for the future remote-session boundary.
//!
//! These types intentionally carry no private key material, credential locator,
//! agent socket, proxy setting, arbitrary SSH option, or remote command.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use url::Host;
use uuid::Uuid;

pub const REMOTE_SESSIONS_CAPABILITY: &str = "remote-sessions-v1";
pub const MAX_REMOTE_TARGETS: usize = 128;
pub const MAX_REMOTE_SESSIONS: usize = 256;
pub const MAX_REMOTE_LABEL_SCALARS: usize = 128;
pub const MAX_REMOTE_HOST_SCALARS: usize = 253;
pub const MAX_REMOTE_USER_SCALARS: usize = 64;
pub const MAX_TMUX_SESSION_NAME_SCALARS: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteAuthenticationMethod {
    PublicKey,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteHostKeyState {
    Untrusted,
    Trusted,
    Changed,
    Revoked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteSessionState {
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

impl RemoteSessionState {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use RemoteSessionState as S;
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
                | (S::Reconnecting, S::Connected | S::Failed | S::Closed)
                | (S::Detached, S::Connecting | S::Closed)
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteObservationState {
    Unknown,
    LastVerified,
    Lost,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteTmuxMode {
    Attach,
    Create,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteHostKeyDecision {
    Reject,
    Trust,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteMutationIdentity {
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_key: String,
    #[serde(deserialize_with = "digest")]
    pub request_hash: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTargetSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_target_id: String,
    #[serde(deserialize_with = "label")]
    pub label: String,
    #[serde(deserialize_with = "canonical_host")]
    pub host: String,
    #[serde(deserialize_with = "nonzero_port")]
    pub port: u16,
    #[serde(deserialize_with = "user")]
    pub user: String,
    pub authentication: RemoteAuthenticationMethod,
    pub host_key_state: RemoteHostKeyState,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub known_hosts_version: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTmuxIdentity {
    pub mode: RemoteTmuxMode,
    #[serde(deserialize_with = "tmux_name")]
    pub session_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteReconnectPolicy {
    pub max_attempts: u8,
    pub initial_delay_ms: u32,
    pub max_delay_ms: u32,
}

impl RemoteReconnectPolicy {
    #[must_use]
    pub const fn is_valid(&self) -> bool {
        self.max_attempts <= 10
            && self.initial_delay_ms >= 100
            && self.initial_delay_ms <= 60_000
            && self.max_delay_ms >= self.initial_delay_ms
            && self.max_delay_ms <= 300_000
    }
}

impl<'de> Deserialize<'de> for RemoteReconnectPolicy {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Raw {
            #[serde(deserialize_with = "reconnect_attempts")]
            max_attempts: u8,
            #[serde(deserialize_with = "initial_delay")]
            initial_delay_ms: u32,
            #[serde(deserialize_with = "maximum_delay")]
            max_delay_ms: u32,
        }
        let raw = Raw::deserialize(d)?;
        let value = Self {
            max_attempts: raw.max_attempts,
            initial_delay_ms: raw.initial_delay_ms,
            max_delay_ms: raw.max_delay_ms,
        };
        value
            .is_valid()
            .then_some(value)
            .ok_or_else(|| serde::de::Error::custom("reconnect delays are inconsistent"))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteSessionSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub remote_target_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(default, deserialize_with = "optional_non_null")]
    #[ts(optional)]
    pub tmux: Option<RemoteTmuxIdentity>,
    pub state: RemoteSessionState,
    pub observation: RemoteObservationState,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub attempt_generation: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub revision: u64,
    pub reconnect: RemoteReconnectPolicy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTargetCreateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_target_id: String,
    #[serde(deserialize_with = "label")]
    pub label: String,
    #[serde(deserialize_with = "canonical_host")]
    pub host: String,
    #[serde(deserialize_with = "nonzero_port")]
    pub port: u16,
    #[serde(deserialize_with = "user")]
    pub user: String,
    pub mutation: RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteSessionConnectParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub remote_target_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(default, deserialize_with = "optional_non_null")]
    #[ts(optional)]
    pub tmux: Option<RemoteTmuxIdentity>,
    pub reconnect: RemoteReconnectPolicy,
    pub mutation: RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteSessionMutationParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
    pub mutation: RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteHostKeyTrustParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub prompt_id: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub attempt_generation: u64,
    #[serde(deserialize_with = "fingerprint")]
    pub presented_fingerprint: String,
    pub decision: RemoteHostKeyDecision,
    pub mutation: RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteHostKeyScanParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
    pub mutation: RemoteMutationIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTargetIdParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_target_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteSessionIdParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteListParams {
    #[serde(deserialize_with = "page_limit")]
    pub limit: u16,
    #[serde(default, deserialize_with = "optional_uuid")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTargetListResult {
    #[serde(deserialize_with = "target_list")]
    pub targets: Vec<RemoteTargetSnapshot>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteSessionListResult {
    #[serde(deserialize_with = "session_list")]
    pub sessions: Vec<RemoteSessionSnapshot>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTargetResult {
    pub target: RemoteTargetSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteSessionResult {
    pub session: RemoteSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteHostKeyChallenge {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_session_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub prompt_id: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub attempt_generation: u64,
    #[serde(deserialize_with = "canonical_host")]
    pub canonical_host: String,
    #[serde(deserialize_with = "nonzero_port")]
    pub port: u16,
    #[serde(deserialize_with = "host_key_algorithm")]
    pub algorithm: String,
    #[serde(deserialize_with = "host_public_key")]
    pub public_key: String,
    #[serde(deserialize_with = "fingerprint")]
    pub presented_fingerprint: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub target_revision: u64,
    #[serde(deserialize_with = "positive_safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTmuxDiscoveryResult {
    #[serde(deserialize_with = "tmux_sessions")]
    pub sessions: Vec<String>,
}

macro_rules! session_mutation_params {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[ts(export)]
        pub struct $name {
            #[serde(deserialize_with = "uuid_string")]
            pub remote_session_id: String,
            pub mutation: RemoteMutationIdentity,
        }
    };
}
session_mutation_params!(RemoteSessionDetachParams);
session_mutation_params!(RemoteSessionReconnectParams);
session_mutation_params!(RemoteSessionCloseParams);
session_mutation_params!(RemoteTmuxDiscoverParams);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RemoteTargetDeleteParams {
    #[serde(deserialize_with = "uuid_string")]
    pub remote_target_id: String,
    pub mutation: RemoteMutationIdentity,
}

fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
fn label<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded(d, MAX_REMOTE_LABEL_SCALARS, "label")
}
fn user<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = bounded(d, MAX_REMOTE_USER_SCALARS, "user")?;
    if value.starts_with('-') || value.chars().any(char::is_whitespace) {
        return Err(serde::de::Error::custom("invalid SSH user"));
    }
    Ok(value)
}
fn host_key_algorithm<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    (value == "ssh-ed25519")
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("unsupported host-key algorithm"))
}
fn host_public_key<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    (!value.is_empty()
        && value.len() <= 1024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')))
    .then_some(value)
    .ok_or_else(|| serde::de::Error::custom("invalid host public key"))
}
fn bounded<'de, D: Deserializer<'de>>(d: D, max: usize, what: &str) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    text(&value, max)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom(format!("invalid {what}")))
}
fn canonical_host<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = bounded(d, MAX_REMOTE_HOST_SCALARS, "host")?;
    let parsed = Host::parse(&value).map_err(serde::de::Error::custom)?;
    if matches!(parsed, Host::Ipv6(_)) {
        return Err(serde::de::Error::custom(
            "IPv6 remote targets are not supported by remote-sessions-v1",
        ));
    }
    let canonical = parsed.to_string().to_ascii_lowercase();
    if canonical != value {
        return Err(serde::de::Error::custom(
            "host must be canonical lowercase IDNA or an IP literal",
        ));
    }
    Ok(value)
}
fn tmux_name<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = bounded(d, MAX_TMUX_SESSION_NAME_SCALARS, "tmux session name")?;
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("invalid tmux session name"))
}
fn uuid_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}
fn optional_uuid<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    uuid_string(d).map(Some)
}
fn digest<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    (value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(value)
    .ok_or_else(|| serde::de::Error::custom("request hash must be lowercase SHA-256"))
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
fn nonzero_port<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let value = u16::deserialize(d)?;
    (value > 0)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("port must be nonzero"))
}
fn reconnect_attempts<'de, D: Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let value = u8::deserialize(d)?;
    (value <= 10)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("too many reconnect attempts"))
}
fn initial_delay<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    (100..=60_000)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("invalid initial reconnect delay"))
}
fn maximum_delay<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    (100..=300_000)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("invalid maximum reconnect delay"))
}
fn fingerprint<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    (value.starts_with("SHA256:") && value.len() <= 128 && !value.chars().any(char::is_whitespace))
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("invalid host-key fingerprint"))
}
fn page_limit<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let value = u16::deserialize(d)?;
    (1..=128)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("page limit must be 1 through 128"))
}
fn target_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<RemoteTargetSnapshot>, D::Error> {
    let value = Vec::deserialize(d)?;
    (value.len() <= MAX_REMOTE_TARGETS)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("too many remote targets"))
}
fn session_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<RemoteSessionSnapshot>, D::Error> {
    let value = Vec::deserialize(d)?;
    (value.len() <= 128)
        .then_some(value)
        .ok_or_else(|| serde::de::Error::custom("too many remote sessions"))
}
fn tmux_sessions<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    let value = Vec::<String>::deserialize(d)?;
    if value.len() > 128
        || value.iter().any(|name| {
            name.is_empty()
                || name.chars().count() > 64
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        })
    {
        return Err(serde::de::Error::custom("invalid tmux discovery result"));
    }
    Ok(value)
}
fn optional_non_null<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn boundary_rejects_unknown_and_unsafe_ssh_fields() {
        let value = json!({"remoteTargetId":Uuid::new_v4(),"label":"dev","host":"example.com","port":22,"user":"alice","privateKey":"secret","mutation":{"idempotencyKey":Uuid::new_v4(),"requestHash":"a".repeat(64),"expectedRevision":0}});
        assert!(serde_json::from_value::<RemoteTargetCreateParams>(value).is_err());
    }
    #[test]
    fn v1_rejects_ipv6_until_known_hosts_normalization_is_qualified() {
        let value = json!({"remoteTargetId":Uuid::new_v4(),"label":"dev","host":"[2001:db8::1]","port":22,"user":"alice","mutation":{"idempotencyKey":Uuid::new_v4(),"requestHash":"a".repeat(64),"expectedRevision":0}});
        assert!(serde_json::from_value::<RemoteTargetCreateParams>(value).is_err());
    }
    #[test]
    fn lifecycle_is_closed_and_forward_only() {
        assert!(RemoteSessionState::Connecting.can_transition_to(RemoteSessionState::Connected));
        assert!(
            !RemoteSessionState::Connected.can_transition_to(RemoteSessionState::TrustRequired)
        );
        assert!(!RemoteSessionState::Closed.can_transition_to(RemoteSessionState::Connecting));
    }

    #[test]
    fn reconnect_and_trust_workflows_are_strictly_bounded() {
        assert!(
            serde_json::from_value::<RemoteReconnectPolicy>(json!({
                "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 10_000
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<RemoteReconnectPolicy>(json!({
                "maxAttempts": 3, "initialDelayMs": 5_000, "maxDelayMs": 500
            }))
            .is_err()
        );
        let trust = json!({
            "remoteSessionId": Uuid::new_v4(), "promptId": Uuid::new_v4(),
            "attemptGeneration": 2, "presentedFingerprint": "SHA256:abc",
            "decision": "trust", "mutation": {
                "idempotencyKey": Uuid::new_v4(), "requestHash": "b".repeat(64),
                "expectedRevision": 1
            }
        });
        assert!(serde_json::from_value::<RemoteHostKeyTrustParams>(trust.clone()).is_ok());
        let mut unsafe_trust = trust;
        unsafe_trust["privateKey"] = json!("secret");
        assert!(serde_json::from_value::<RemoteHostKeyTrustParams>(unsafe_trust).is_err());
    }

    #[test]
    fn list_pagination_uses_bounded_opaque_uuid_cursors() {
        assert!(
            serde_json::from_value::<RemoteListParams>(json!({
                "limit": 128,
                "cursor": Uuid::new_v4()
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<RemoteListParams>(json!({
                "limit": 129
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<RemoteListParams>(json!({
                "limit": 1,
                "cursor": "offset:1"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<RemoteSessionListResult>(json!({
                "sessions": [],
                "nextCursor": null
            }))
            .is_err()
        );
    }
}

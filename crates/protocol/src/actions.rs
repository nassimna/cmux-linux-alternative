//! Strict, capability-gated public-action and desktop execution wire contracts.

use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;
use uuid::Uuid;

use crate::{DesktopProviderIdentityParams, DesktopProviderWindowClaim};

/// Advertised only once the complete action command family is available.
pub const ACTIONS_CAPABILITY: &str = "actions-v1";
pub const MAX_ACTION_DEFINITIONS: usize = 256;
pub const MAX_ACTION_DEFINITION_BYTES: usize = 8 * 1024;
pub const MAX_ACTION_PAGE_SIZE: usize = 64;
pub const MAX_ACTION_CURSOR_BYTES: usize = 512;
pub const ACTION_CURSOR_TTL_SECONDS: u64 = 5 * 60;
pub const MAX_ACTION_PARAMETERS_BYTES: usize = 64 * 1024;
pub const MAX_ACTION_RESULT_BYTES: usize = 64 * 1024;
const MAX_ACTION_PARAMETERS_BYTES_U32: u32 = 64 * 1024;
const MAX_ACTION_RESULT_BYTES_U32: u32 = 64 * 1024;
pub const DEFAULT_ACTION_TIMEOUT_MS: u32 = 30_000;
pub const MAX_ACTION_TIMEOUT_MS: u32 = 5 * 60 * 1_000;
pub const MAX_ACTION_NONTERMINAL_INVOCATIONS: usize = 256;
pub const MAX_ACTION_INVOCATIONS_PER_PROVIDER: usize = 32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActionOwner {
    Service,
    Desktop,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActionAuthorizationClass {
    Owner,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActionInteractionClass {
    Headless,
    DesktopInteraction,
    ConfirmationRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ActionErrorCode {
    CapabilityUnavailable,
    ActionNotFound,
    ActionVersionMismatch,
    CursorInvalid,
    CursorExpired,
    InvalidParameters,
    InvalidResult,
    Unauthorized,
    PolicyDenied,
    TargetRequired,
    TargetNotFound,
    TargetStale,
    ProviderUnavailable,
    ProviderIneligible,
    ProviderBackpressure,
    ProviderLeaseExpired,
    ProviderEpochMismatch,
    IdempotencyConflict,
    IdempotencyExpired,
    ResourceLimit,
    ConfirmationRequired,
    CancellationNotGuaranteed,
    Canceled,
    Expired,
    ExecutionFailed,
    CorrelationMismatch,
    InvalidState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Acknowledged | Self::Failed | Self::Canceled | Self::Expired
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActionTerminalCode {
    Succeeded,
    Failed,
    Canceled,
    Expired,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DesktopActionCompletionStatus {
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DesktopActionStartDecision {
    Granted,
    Canceled,
    Expired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActionRegistryChangeReason {
    DefinitionsChanged,
    ResyncRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionLimits {
    #[serde(deserialize_with = "parameter_byte_limit")]
    pub max_parameter_bytes: u32,
    #[serde(deserialize_with = "result_byte_limit")]
    pub max_result_bytes: u32,
    #[serde(deserialize_with = "action_timeout_ms")]
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ActionDefinition {
    #[serde(deserialize_with = "action_id")]
    pub action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    pub action_version: u32,
    #[serde(deserialize_with = "localized_title_key")]
    pub localized_title_key: String,
    /// Trusted display text for dynamic definitions such as project actions. Built-in actions
    /// normally omit this and resolve `localized_title_key` in the client locale.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_display_title"
    )]
    pub display_title: Option<String>,
    /// Canonical logical shortcut proposed by the definition. Clients must still run the shared
    /// conflict policy before installing it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_shortcut"
    )]
    pub default_shortcut: Option<String>,
    #[serde(deserialize_with = "action_category")]
    pub category: String,
    pub owner: ActionOwner,
    #[serde(deserialize_with = "nonzero_version")]
    pub parameter_schema_version: u32,
    #[serde(deserialize_with = "nonzero_version")]
    pub result_schema_version: u32,
    pub authorization_class: ActionAuthorizationClass,
    pub interaction_class: ActionInteractionClass,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_provider_capability"
    )]
    pub required_desktop_capability: Option<String>,
    pub limits: ActionLimits,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionDefinitionWire {
    #[serde(deserialize_with = "action_id")]
    action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    action_version: u32,
    #[serde(deserialize_with = "localized_title_key")]
    localized_title_key: String,
    #[serde(default, deserialize_with = "optional_action_display_title")]
    display_title: Option<String>,
    #[serde(default, deserialize_with = "optional_action_shortcut")]
    default_shortcut: Option<String>,
    #[serde(deserialize_with = "action_category")]
    category: String,
    owner: ActionOwner,
    #[serde(deserialize_with = "nonzero_version")]
    parameter_schema_version: u32,
    #[serde(deserialize_with = "nonzero_version")]
    result_schema_version: u32,
    authorization_class: ActionAuthorizationClass,
    interaction_class: ActionInteractionClass,
    #[serde(default, deserialize_with = "optional_provider_capability")]
    required_desktop_capability: Option<String>,
    limits: ActionLimits,
}

impl<'de> Deserialize<'de> for ActionDefinition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ActionDefinitionWire::deserialize(deserializer)?;
        let ownership_is_consistent = match wire.owner {
            ActionOwner::Service => wire.required_desktop_capability.is_none(),
            ActionOwner::Desktop => wire.required_desktop_capability.is_some(),
        };
        if !ownership_is_consistent {
            return Err(serde::de::Error::custom(
                "desktop actions require a capability and service actions forbid one",
            ));
        }
        if serde_json::to_vec(&wire)
            .map_err(serde::de::Error::custom)?
            .len()
            > MAX_ACTION_DEFINITION_BYTES
        {
            return Err(serde::de::Error::custom(
                "serialized action definition exceeds 8192 bytes",
            ));
        }
        Ok(Self {
            action_id: wire.action_id,
            action_version: wire.action_version,
            localized_title_key: wire.localized_title_key,
            display_title: wire.display_title,
            default_shortcut: wire.default_shortcut,
            category: wire.category,
            owner: wire.owner,
            parameter_schema_version: wire.parameter_schema_version,
            result_schema_version: wire.result_schema_version,
            authorization_class: wire.authorization_class,
            interaction_class: wire.interaction_class,
            required_desktop_capability: wire.required_desktop_capability,
            limits: wire.limits,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ActionListParams {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_cursor"
    )]
    pub cursor: Option<String>,
    #[serde(deserialize_with = "action_page_limit")]
    pub limit: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ActionListResult {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub registry_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub idempotency_epoch: String,
    #[serde(deserialize_with = "action_definition_page")]
    pub definitions: Vec<ActionDefinition>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_cursor"
    )]
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionListResultWire {
    #[serde(deserialize_with = "safe_integer")]
    registry_revision: u64,
    #[serde(deserialize_with = "uuid_string")]
    idempotency_epoch: String,
    #[serde(deserialize_with = "action_definition_page")]
    definitions: Vec<ActionDefinition>,
    #[serde(default, deserialize_with = "optional_action_cursor")]
    next_cursor: Option<String>,
}

impl<'de> Deserialize<'de> for ActionListResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ActionListResultWire::deserialize(deserializer)?;
        if wire.next_cursor.is_some() && wire.definitions.is_empty() {
            return Err(serde::de::Error::custom(
                "an action discovery cursor requires a non-empty page",
            ));
        }
        Ok(Self {
            registry_revision: wire.registry_revision,
            idempotency_epoch: wire.idempotency_epoch,
            definitions: wire.definitions,
            next_cursor: wire.next_cursor,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionInvocationTarget {
    #[serde(deserialize_with = "uuid_string")]
    pub window_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "positive_safe_integer")]
    pub window_generation: u64,
}

impl From<ActionInvocationTarget> for DesktopProviderWindowClaim {
    fn from(target: ActionInvocationTarget) -> Self {
        Self {
            window_id: target.window_id,
            generation: target.window_generation,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionIdempotency {
    #[serde(deserialize_with = "uuid_string")]
    pub epoch: String,
    #[serde(deserialize_with = "uuid_string")]
    pub key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ActionInvokeParams {
    #[serde(deserialize_with = "action_id")]
    pub action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    pub action_version: u32,
    #[serde(deserialize_with = "action_parameters")]
    pub parameters: Value,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_invocation_target"
    )]
    pub target: Option<ActionInvocationTarget>,
    pub idempotency: ActionIdempotency,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ActionInvocationSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    pub state: ActionInvocationState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_terminal_code"
    )]
    pub terminal_code: Option<ActionTerminalCode>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_result"
    )]
    pub result: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_error_code"
    )]
    pub error_code: Option<ActionErrorCode>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub updated_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionInvocationSnapshotWire {
    #[serde(deserialize_with = "uuid_string")]
    invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    state: ActionInvocationState,
    #[serde(default, deserialize_with = "optional_terminal_code")]
    terminal_code: Option<ActionTerminalCode>,
    #[serde(default, deserialize_with = "optional_action_result")]
    result: Option<Value>,
    #[serde(default, deserialize_with = "optional_action_error_code")]
    error_code: Option<ActionErrorCode>,
    #[serde(deserialize_with = "safe_integer")]
    updated_at_ms: u64,
}

impl<'de> Deserialize<'de> for ActionInvocationSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ActionInvocationSnapshotWire::deserialize(deserializer)?;
        let consistent = match wire.state {
            ActionInvocationState::Acknowledged => {
                wire.terminal_code == Some(ActionTerminalCode::Succeeded)
                    && wire.result.is_some()
                    && wire.error_code.is_none()
            }
            ActionInvocationState::Failed => {
                matches!(
                    wire.terminal_code,
                    Some(ActionTerminalCode::Failed | ActionTerminalCode::Interrupted)
                ) && wire.result.is_none()
                    && wire.error_code.is_some()
            }
            ActionInvocationState::Canceled => {
                wire.terminal_code == Some(ActionTerminalCode::Canceled)
                    && wire.result.is_none()
                    && wire.error_code.is_none()
            }
            ActionInvocationState::Expired => {
                wire.terminal_code == Some(ActionTerminalCode::Expired)
                    && wire.result.is_none()
                    && wire.error_code.is_none()
            }
            _ => wire.terminal_code.is_none() && wire.result.is_none() && wire.error_code.is_none(),
        };
        if !consistent {
            return Err(serde::de::Error::custom(
                "action invocation terminal fields are inconsistent with state",
            ));
        }
        Ok(Self {
            invocation_id: wire.invocation_id,
            correlation_id: wire.correlation_id,
            state: wire.state,
            terminal_code: wire.terminal_code,
            result: wire.result,
            error_code: wire.error_code,
            updated_at_ms: wire.updated_at_ms,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionInvokeResult {
    pub invocation: ActionInvocationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionCancelParams {
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionCancelResult {
    pub invocation: ActionInvocationSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionInvocationChangedEvent {
    #[ts(type = "\"action.invocationChanged\"")]
    pub event: String,
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    pub state: ActionInvocationState,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub updated_at_ms: u64,
}

/// Content-free invalidation for registry rebuilds such as trusted project definition changes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ActionRegistryChangedEvent {
    #[ts(type = "\"action.registryChanged\"")]
    pub event: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub registry_revision: u64,
    pub reason: ActionRegistryChangeReason,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionRegistryChangedEventWire {
    event: String,
    #[serde(deserialize_with = "safe_integer")]
    registry_revision: u64,
    reason: ActionRegistryChangeReason,
}

impl<'de> Deserialize<'de> for ActionRegistryChangedEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ActionRegistryChangedEventWire::deserialize(deserializer)?;
        if wire.event != "action.registryChanged" {
            return Err(serde::de::Error::custom(
                "invalid action registry invalidation event name",
            ));
        }
        Ok(Self {
            event: wire.event,
            registry_revision: wire.registry_revision,
            reason: wire.reason,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionInvocationChangedEventWire {
    event: String,
    #[serde(deserialize_with = "uuid_string")]
    invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    state: ActionInvocationState,
    #[serde(deserialize_with = "safe_integer")]
    updated_at_ms: u64,
}

impl<'de> Deserialize<'de> for ActionInvocationChangedEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ActionInvocationChangedEventWire::deserialize(deserializer)?;
        if wire.event != "action.invocationChanged" {
            return Err(serde::de::Error::custom(
                "invalid action invocation lifecycle event name",
            ));
        }
        Ok(Self {
            event: wire.event,
            invocation_id: wire.invocation_id,
            correlation_id: wire.correlation_id,
            state: wire.state,
            updated_at_ms: wire.updated_at_ms,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopActionExecutionRequest {
    #[serde(deserialize_with = "action_provider_identity")]
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "positive_safe_integer")]
    pub attempt_epoch: u64,
    #[serde(deserialize_with = "action_id")]
    pub action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    pub action_version: u32,
    pub target: ActionInvocationTarget,
    #[serde(deserialize_with = "action_parameters")]
    pub parameters: Value,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expires_at_ms: u64,
}

/// Polls the action reverse queue through the existing M3 provider identity.
///
/// This is a separate `actions-v1` shape so enabling actions does not change the established
/// `multi-window-v1` poll result. The control server must still use the same authoritative
/// provider registry and bounded per-provider queue.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopActionPollParams {
    #[serde(deserialize_with = "action_provider_identity")]
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "provider_poll_timeout")]
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct DesktopActionPollResult {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_desktop_action_request"
    )]
    pub request: Option<DesktopActionExecutionRequest>,
}

/// Content-free executable category shown by trusted native confirmation UI.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProjectActionExecutableClass {
    ProjectRelative,
    ApprovedName,
}

/// One short-lived confirmation challenge for a service-owned project action.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ProjectActionConfirmationChallenge {
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub nonce: String,
    #[serde(deserialize_with = "lowercase_sha256")]
    pub challenge: String,
    #[serde(deserialize_with = "action_provider_identity")]
    pub identity: DesktopProviderIdentityParams,
    pub target: ActionInvocationTarget,
    #[serde(deserialize_with = "lowercase_sha256")]
    pub confirmation_definition_sha256: String,
    #[serde(deserialize_with = "action_id")]
    pub action_id: String,
    #[serde(deserialize_with = "action_display_title")]
    pub display_title: String,
    pub executable_class: ProjectActionExecutableClass,
    #[serde(deserialize_with = "action_argument_count")]
    pub argument_count: u16,
    #[serde(deserialize_with = "project_label")]
    pub project_label: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub expires_at_ms: u64,
}

/// Poll the confirmation queue using the exact leased desktop-provider identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ProjectActionConfirmationPollParams {
    #[serde(deserialize_with = "action_provider_identity")]
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "provider_poll_timeout")]
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ProjectActionConfirmationPollResult {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_project_action_confirmation_challenge"
    )]
    pub challenge: Option<ProjectActionConfirmationChallenge>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProjectActionConfirmationDecision {
    Confirmed,
    Denied,
}

/// Exact provider response. It is available only on the provider-authenticated command family and
/// can never be embedded in caller-supplied action parameters.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ProjectActionConfirmationRespondParams {
    #[serde(deserialize_with = "action_provider_identity")]
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub nonce: String,
    #[serde(deserialize_with = "lowercase_sha256")]
    pub challenge: String,
    pub target: ActionInvocationTarget,
    #[serde(deserialize_with = "lowercase_sha256")]
    pub confirmation_definition_sha256: String,
    pub decision: ProjectActionConfirmationDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ProjectActionConfirmationRespondResult {
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    pub decision: ProjectActionConfirmationDecision,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub accepted_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopActionStartClaimParams {
    #[serde(deserialize_with = "action_provider_identity")]
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "positive_safe_integer")]
    pub attempt_epoch: u64,
    #[serde(deserialize_with = "action_id")]
    pub action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    pub action_version: u32,
    pub target: ActionInvocationTarget,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct DesktopActionStartClaimResult {
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "positive_safe_integer")]
    pub attempt_epoch: u64,
    pub decision: DesktopActionStartDecision,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_terminal_code"
    )]
    pub terminal_code: Option<ActionTerminalCode>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_safe_integer"
    )]
    #[ts(type = "number", optional)]
    pub granted_at_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopActionStartClaimResultWire {
    #[serde(deserialize_with = "uuid_string")]
    invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    attempt_epoch: u64,
    decision: DesktopActionStartDecision,
    #[serde(default, deserialize_with = "optional_terminal_code")]
    terminal_code: Option<ActionTerminalCode>,
    #[serde(default, deserialize_with = "optional_safe_integer")]
    granted_at_ms: Option<u64>,
}

impl<'de> Deserialize<'de> for DesktopActionStartClaimResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DesktopActionStartClaimResultWire::deserialize(deserializer)?;
        let consistent = match wire.decision {
            DesktopActionStartDecision::Granted => {
                wire.terminal_code.is_none() && wire.granted_at_ms.is_some()
            }
            DesktopActionStartDecision::Canceled => {
                wire.terminal_code == Some(ActionTerminalCode::Canceled)
                    && wire.granted_at_ms.is_none()
            }
            DesktopActionStartDecision::Expired => {
                wire.terminal_code == Some(ActionTerminalCode::Expired)
                    && wire.granted_at_ms.is_none()
            }
        };
        if !consistent {
            return Err(serde::de::Error::custom(
                "desktop action start decision fields are inconsistent",
            ));
        }
        Ok(Self {
            invocation_id: wire.invocation_id,
            correlation_id: wire.correlation_id,
            attempt_epoch: wire.attempt_epoch,
            decision: wire.decision,
            terminal_code: wire.terminal_code,
            granted_at_ms: wire.granted_at_ms,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct DesktopActionAcknowledgeParams {
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    pub invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub attempt_epoch: u64,
    #[serde(deserialize_with = "action_id")]
    pub action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    pub action_version: u32,
    pub target: ActionInvocationTarget,
    pub status: DesktopActionCompletionStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_result"
    )]
    pub result: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_action_error_code"
    )]
    pub error_code: Option<ActionErrorCode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopActionAcknowledgeWire {
    #[serde(deserialize_with = "action_provider_identity")]
    identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "uuid_string")]
    invocation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    #[serde(deserialize_with = "positive_safe_integer")]
    attempt_epoch: u64,
    #[serde(deserialize_with = "action_id")]
    action_id: String,
    #[serde(deserialize_with = "nonzero_version")]
    action_version: u32,
    target: ActionInvocationTarget,
    status: DesktopActionCompletionStatus,
    #[serde(default, deserialize_with = "optional_action_result")]
    result: Option<Value>,
    #[serde(default, deserialize_with = "optional_action_error_code")]
    error_code: Option<ActionErrorCode>,
}

impl<'de> Deserialize<'de> for DesktopActionAcknowledgeParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = DesktopActionAcknowledgeWire::deserialize(deserializer)?;
        let consistent = match wire.status {
            DesktopActionCompletionStatus::Succeeded => {
                wire.result.is_some() && wire.error_code.is_none()
            }
            DesktopActionCompletionStatus::Failed => {
                wire.result.is_none() && wire.error_code.is_some()
            }
            DesktopActionCompletionStatus::Canceled => {
                wire.result.is_none() && wire.error_code.is_none()
            }
        };
        if !consistent {
            return Err(serde::de::Error::custom(
                "desktop action acknowledgement fields are inconsistent",
            ));
        }
        Ok(Self {
            identity: wire.identity,
            invocation_id: wire.invocation_id,
            correlation_id: wire.correlation_id,
            attempt_epoch: wire.attempt_epoch,
            action_id: wire.action_id,
            action_version: wire.action_version,
            target: wire.target,
            status: wire.status,
            result: wire.result,
            error_code: wire.error_code,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DesktopActionAcknowledgeResult {
    pub invocation: ActionInvocationSnapshot,
}

fn valid_namespaced_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
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

fn action_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !valid_namespaced_identifier(&value, 128) {
        return Err(serde::de::Error::custom("invalid namespaced action ID"));
    }
    Ok(value)
}

fn localized_title_key<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !valid_namespaced_identifier(&value, 160) {
        return Err(serde::de::Error::custom(
            "invalid localized action title key",
        ));
    }
    Ok(value)
}

fn optional_action_display_title<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    action_display_title(deserializer).map(Some)
}

fn action_display_title<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > 120
        || value.chars().any(char::is_control)
    {
        return Err(serde::de::Error::custom("invalid action display title"));
    }
    Ok(value)
}

fn project_label<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > 80
        || value.chars().any(char::is_control)
    {
        return Err(serde::de::Error::custom("invalid project label"));
    }
    Ok(value)
}

fn lowercase_sha256<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(serde::de::Error::custom(
            "expected a lowercase SHA-256 digest",
        ));
    }
    Ok(value)
}

fn action_argument_count<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value > 64 {
        return Err(serde::de::Error::custom(
            "project action argument count exceeds 64",
        ));
    }
    Ok(value)
}

fn optional_action_shortcut<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !valid_canonical_shortcut(&value) {
        return Err(serde::de::Error::custom(
            "invalid canonical logical action shortcut",
        ));
    }
    Ok(Some(value))
}

fn valid_canonical_shortcut(value: &str) -> bool {
    const MODIFIERS: [&str; 4] = ["Primary", "Secondary", "Control", "Shift"];

    if value.is_empty() || value.chars().count() > 128 {
        return false;
    }
    let parts: Vec<_> = value.split('+').collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    let mut previous = None;
    for modifier in &parts[..parts.len() - 1] {
        let Some(index) = MODIFIERS.iter().position(|candidate| candidate == modifier) else {
            return false;
        };
        if previous.is_some_and(|previous| index <= previous) {
            return false;
        }
        previous = Some(index);
    }
    let key = parts[parts.len() - 1];
    (key.len() == 1
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
        || key
            .strip_prefix('F')
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number))
        || matches!(
            key,
            "Backspace"
                | "Tab"
                | "Enter"
                | "Escape"
                | "Space"
                | "Delete"
                | "Home"
                | "End"
                | "PageUp"
                | "PageDown"
                | "ArrowLeft"
                | "ArrowRight"
                | "ArrowUp"
                | "ArrowDown"
                | "Comma"
                | "Period"
                | "Slash"
                | "Backslash"
                | "Semicolon"
                | "Quote"
                | "BracketLeft"
                | "BracketRight"
                | "Minus"
                | "Equal"
                | "Backquote"
        )
}

fn action_category<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        return Err(serde::de::Error::custom("invalid action category"));
    }
    Ok(value)
}

fn provider_capability_value(value: String) -> Result<String, &'static str> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
    {
        return Err("invalid desktop capability");
    }
    Ok(value)
}

fn optional_provider_capability<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    provider_capability_value(String::deserialize(deserializer)?)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn nonzero_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value == 0 {
        return Err(serde::de::Error::custom(
            "schema/action version must be nonzero",
        ));
    }
    Ok(value)
}

fn parameter_byte_limit<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_nonzero_u32(
        deserializer,
        MAX_ACTION_PARAMETERS_BYTES_U32,
        "parameter byte limit",
    )
}

fn result_byte_limit<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_nonzero_u32(
        deserializer,
        MAX_ACTION_RESULT_BYTES_U32,
        "result byte limit",
    )
}

fn action_timeout_ms<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_nonzero_u32(deserializer, MAX_ACTION_TIMEOUT_MS, "action timeout")
}

fn bounded_nonzero_u32<'de, D>(
    deserializer: D,
    maximum: u32,
    name: &'static str,
) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value == 0 || value > maximum {
        return Err(serde::de::Error::custom(format_args!(
            "{name} must be within 1..={maximum}"
        )));
    }
    Ok(value)
}

fn action_page_limit<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value == 0 || usize::from(value) > MAX_ACTION_PAGE_SIZE {
        return Err(serde::de::Error::custom(
            "action discovery page limit must be within 1..=64",
        ));
    }
    Ok(value)
}

fn action_cursor_value(value: String) -> Result<String, &'static str> {
    if value.is_empty()
        || value.len() > MAX_ACTION_CURSOR_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("invalid opaque action cursor");
    }
    Ok(value)
}

fn optional_action_cursor<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    action_cursor_value(String::deserialize(deserializer)?)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn action_definition_page<'de, D>(deserializer: D) -> Result<Vec<ActionDefinition>, D::Error>
where
    D: Deserializer<'de>,
{
    let definitions = Vec::<ActionDefinition>::deserialize(deserializer)?;
    if definitions.len() > MAX_ACTION_PAGE_SIZE {
        return Err(serde::de::Error::custom(
            "action discovery page exceeds 64 definitions",
        ));
    }
    let mut identities = BTreeSet::new();
    if definitions
        .iter()
        .any(|definition| !identities.insert((&definition.action_id, definition.action_version)))
    {
        return Err(serde::de::Error::custom(
            "action discovery page contains duplicate definitions",
        ));
    }
    Ok(definitions)
}

fn bounded_json_object<'de, D>(deserializer: D, maximum: usize) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if !value.is_object() {
        return Err(serde::de::Error::custom(
            "action payload must be a JSON object",
        ));
    }
    if serde_json::to_vec(&value)
        .map_err(serde::de::Error::custom)?
        .len()
        > maximum
    {
        return Err(serde::de::Error::custom(
            "serialized action payload exceeds its byte limit",
        ));
    }
    Ok(value)
}

fn action_parameters<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_json_object(deserializer, MAX_ACTION_PARAMETERS_BYTES)
}

fn optional_action_result<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_json_object(deserializer, MAX_ACTION_RESULT_BYTES).map(Some)
}

fn optional_invocation_target<'de, D>(
    deserializer: D,
) -> Result<Option<ActionInvocationTarget>, D::Error>
where
    D: Deserializer<'de>,
{
    ActionInvocationTarget::deserialize(deserializer).map(Some)
}

fn provider_poll_timeout<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value > 5_000 {
        return Err(serde::de::Error::custom(
            "desktop action poll timeout exceeds 5000 ms",
        ));
    }
    Ok(value)
}

fn optional_desktop_action_request<'de, D>(
    deserializer: D,
) -> Result<Option<DesktopActionExecutionRequest>, D::Error>
where
    D: Deserializer<'de>,
{
    DesktopActionExecutionRequest::deserialize(deserializer).map(Some)
}

fn optional_project_action_confirmation_challenge<'de, D>(
    deserializer: D,
) -> Result<Option<ProjectActionConfirmationChallenge>, D::Error>
where
    D: Deserializer<'de>,
{
    ProjectActionConfirmationChallenge::deserialize(deserializer).map(Some)
}

fn optional_terminal_code<'de, D>(deserializer: D) -> Result<Option<ActionTerminalCode>, D::Error>
where
    D: Deserializer<'de>,
{
    ActionTerminalCode::deserialize(deserializer).map(Some)
}

fn optional_action_error_code<'de, D>(deserializer: D) -> Result<Option<ActionErrorCode>, D::Error>
where
    D: Deserializer<'de>,
{
    ActionErrorCode::deserialize(deserializer).map(Some)
}

fn optional_safe_integer<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    safe_integer(deserializer).map(Some)
}

fn positive_safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = safe_integer(deserializer)?;
    if value == 0 {
        return Err(serde::de::Error::custom(
            "integer identity epoch/generation must be positive",
        ));
    }
    Ok(value)
}

fn action_provider_identity<'de, D>(
    deserializer: D,
) -> Result<DesktopProviderIdentityParams, D::Error>
where
    D: Deserializer<'de>,
{
    let identity = DesktopProviderIdentityParams::deserialize(deserializer)?;
    if identity.provider_epoch == 0 {
        return Err(serde::de::Error::custom(
            "desktop action provider epoch must be positive",
        ));
    }
    Ok(identity)
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom(
            "integer exceeds JavaScript safe integer range",
        ));
    }
    Ok(value)
}

fn uuid_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Uuid::parse_str(&value).map_err(|_| serde::de::Error::custom("invalid UUID"))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "10000000-0000-4000-8000-000000000001";
    const B: &str = "20000000-0000-4000-8000-000000000002";
    const C: &str = "30000000-0000-4000-8000-000000000003";
    const D: &str = "40000000-0000-4000-8000-000000000004";

    fn definition(owner: &str) -> Value {
        let mut value = json!({
            "actionId": "workspace.tab.close",
            "actionVersion": 1,
            "localizedTitleKey": "actions.workspace.tab_close",
            "category": "workspace",
            "owner": owner,
            "parameterSchemaVersion": 1,
            "resultSchemaVersion": 1,
            "authorizationClass": "owner",
            "interactionClass": "headless",
            "limits": {
                "maxParameterBytes": 65536,
                "maxResultBytes": 65536,
                "timeoutMs": 30000
            }
        });
        if owner == "desktop" {
            value["requiredDesktopCapability"] = json!("native-window-v1");
            value["interactionClass"] = json!("desktopInteraction");
        }
        value
    }

    fn identity() -> Value {
        json!({"providerId": A, "providerEpoch": 1, "leaseId": B})
    }

    #[test]
    fn definitions_are_closed_bounded_and_owner_consistent() {
        assert!(serde_json::from_value::<ActionDefinition>(definition("service")).is_ok());
        assert!(serde_json::from_value::<ActionDefinition>(definition("desktop")).is_ok());

        let mut dynamic = definition("service");
        dynamic["displayTitle"] = json!("Build project");
        dynamic["defaultShortcut"] = json!("Primary+Shift+B");
        assert!(serde_json::from_value::<ActionDefinition>(dynamic.clone()).is_ok());

        dynamic["defaultShortcut"] = json!("Shift+Primary+B");
        assert!(serde_json::from_value::<ActionDefinition>(dynamic).is_err());

        let mut null_display_title = definition("service");
        null_display_title["displayTitle"] = Value::Null;
        assert!(serde_json::from_value::<ActionDefinition>(null_display_title).is_err());

        let mut unknown = definition("service");
        unknown["command"] = json!("rm -rf");
        assert!(serde_json::from_value::<ActionDefinition>(unknown).is_err());

        let mut service_capability = definition("service");
        service_capability["requiredDesktopCapability"] = json!("native-window-v1");
        assert!(serde_json::from_value::<ActionDefinition>(service_capability).is_err());

        let mut desktop_without_capability = definition("desktop");
        desktop_without_capability
            .as_object_mut()
            .unwrap()
            .remove("requiredDesktopCapability");
        assert!(serde_json::from_value::<ActionDefinition>(desktop_without_capability).is_err());

        let mut null_capability = definition("desktop");
        null_capability["requiredDesktopCapability"] = Value::Null;
        assert!(serde_json::from_value::<ActionDefinition>(null_capability).is_err());

        let mut invalid_id = definition("service");
        invalid_id["actionId"] = json!("NotNamespaced");
        assert!(serde_json::from_value::<ActionDefinition>(invalid_id).is_err());
    }

    #[test]
    fn discovery_pages_enforce_cursor_and_record_bounds() {
        let valid = json!({
            "registryRevision": 1,
            "idempotencyEpoch": A,
            "definitions": [definition("service")],
            "nextCursor": "opaque.cursor_1"
        });
        assert!(serde_json::from_value::<ActionListResult>(valid.clone()).is_ok());

        let mut duplicate = valid.clone();
        duplicate["definitions"] = json!([definition("service"), definition("service")]);
        assert!(serde_json::from_value::<ActionListResult>(duplicate).is_err());

        let mut null_cursor = valid.clone();
        null_cursor["nextCursor"] = Value::Null;
        assert!(serde_json::from_value::<ActionListResult>(null_cursor).is_err());

        let too_many = json!({
            "registryRevision": 1,
            "idempotencyEpoch": A,
            "definitions": (0..65).map(|index| {
                let mut item = definition("service");
                item["actionId"] = json!(format!("workspace.action_{index}"));
                item
            }).collect::<Vec<_>>()
        });
        assert!(serde_json::from_value::<ActionListResult>(too_many).is_err());

        assert!(serde_json::from_value::<ActionListParams>(json!({"limit": 64})).is_ok());
        assert!(serde_json::from_value::<ActionListParams>(json!({"limit": 65})).is_err());
        assert!(
            serde_json::from_value::<ActionListParams>(json!({"limit": 1, "cursor": null}))
                .is_err()
        );
    }

    #[test]
    fn project_confirmation_is_provider_bound_closed_and_content_free() {
        let challenge = json!({
            "invocationId": A,
            "nonce": B,
            "challenge": "a".repeat(64),
            "identity": {"providerId": C, "providerEpoch": 3, "leaseId": D},
            "target": {"windowId": A, "windowGeneration": 4},
            "confirmationDefinitionSha256": "b".repeat(64),
            "actionId": "project.example.build",
            "displayTitle": "Build project",
            "executableClass": "projectRelative",
            "argumentCount": 2,
            "projectLabel": "Example",
            "expiresAtMs": 99
        });
        assert!(
            serde_json::from_value::<ProjectActionConfirmationChallenge>(challenge.clone()).is_ok()
        );

        let mut raw_command = challenge.clone();
        raw_command["command"] = json!("/bin/sh -c secret");
        assert!(serde_json::from_value::<ProjectActionConfirmationChallenge>(raw_command).is_err());

        let mut uppercase_digest = challenge.clone();
        uppercase_digest["challenge"] = json!("A".repeat(64));
        assert!(
            serde_json::from_value::<ProjectActionConfirmationChallenge>(uppercase_digest).is_err()
        );

        assert!(
            serde_json::from_value::<ProjectActionConfirmationPollResult>(json!({
                "challenge": challenge
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ProjectActionConfirmationPollResult>(json!({
                "challenge": null
            }))
            .is_err()
        );

        let response = json!({
            "identity": {"providerId": C, "providerEpoch": 3, "leaseId": D},
            "invocationId": A,
            "nonce": B,
            "challenge": "a".repeat(64),
            "target": {"windowId": A, "windowGeneration": 4},
            "confirmationDefinitionSha256": "b".repeat(64),
            "decision": "confirmed"
        });
        assert!(serde_json::from_value::<ProjectActionConfirmationRespondParams>(response).is_ok());
    }

    #[test]
    fn invocation_rejects_null_non_object_and_oversized_payloads() {
        let valid = json!({
            "actionId": "workspace.tab.close",
            "actionVersion": 1,
            "parameters": {"tabId": A},
            "target": {"windowId": B, "windowGeneration": 2},
            "idempotency": {"epoch": C, "key": D},
            "correlationId": A
        });
        assert!(serde_json::from_value::<ActionInvokeParams>(valid.clone()).is_ok());

        for invalid_payload in [Value::Null, json!([]), json!("value")] {
            let mut invalid = valid.clone();
            invalid["parameters"] = invalid_payload;
            assert!(serde_json::from_value::<ActionInvokeParams>(invalid).is_err());
        }
        let mut null_target = valid.clone();
        null_target["target"] = Value::Null;
        assert!(serde_json::from_value::<ActionInvokeParams>(null_target).is_err());

        let mut oversized = valid;
        oversized["parameters"] = json!({"value": "x".repeat(MAX_ACTION_PARAMETERS_BYTES)});
        assert!(serde_json::from_value::<ActionInvokeParams>(oversized).is_err());
    }

    #[test]
    fn invocation_snapshots_enforce_terminal_fields() {
        let succeeded = json!({
            "invocationId": A,
            "correlationId": B,
            "state": "acknowledged",
            "terminalCode": "succeeded",
            "result": {},
            "updatedAtMs": 10
        });
        assert!(serde_json::from_value::<ActionInvocationSnapshot>(succeeded.clone()).is_ok());

        let mut missing_result = succeeded.clone();
        missing_result.as_object_mut().unwrap().remove("result");
        assert!(serde_json::from_value::<ActionInvocationSnapshot>(missing_result).is_err());

        let nonterminal = json!({
            "invocationId": A,
            "correlationId": B,
            "state": "dispatched",
            "updatedAtMs": 10
        });
        assert!(serde_json::from_value::<ActionInvocationSnapshot>(nonterminal.clone()).is_ok());
        let mut early_result = nonterminal;
        early_result["result"] = json!({});
        assert!(serde_json::from_value::<ActionInvocationSnapshot>(early_result).is_err());

        let event = json!({
            "event": "action.invocationChanged",
            "invocationId": A,
            "correlationId": B,
            "state": "dispatched",
            "updatedAtMs": 10
        });
        assert!(serde_json::from_value::<ActionInvocationChangedEvent>(event.clone()).is_ok());
        let mut wrong_name = event;
        wrong_name["event"] = json!("action.changed");
        assert!(serde_json::from_value::<ActionInvocationChangedEvent>(wrong_name).is_err());

        let registry_event = json!({
            "event": "action.registryChanged",
            "registryRevision": 11,
            "reason": "definitionsChanged"
        });
        assert!(
            serde_json::from_value::<ActionRegistryChangedEvent>(registry_event.clone()).is_ok()
        );
        let mut unsafe_revision = registry_event.clone();
        unsafe_revision["registryRevision"] = json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<ActionRegistryChangedEvent>(unsafe_revision).is_err());
        let mut registry_wrong_name = registry_event;
        registry_wrong_name["event"] = json!("action.registryInvalidated");
        assert!(serde_json::from_value::<ActionRegistryChangedEvent>(registry_wrong_name).is_err());
    }

    #[test]
    fn start_claim_decision_is_exact_and_null_free() {
        let granted = json!({
            "invocationId": A,
            "correlationId": B,
            "attemptEpoch": 2,
            "decision": "granted",
            "grantedAtMs": 100
        });
        assert!(serde_json::from_value::<DesktopActionStartClaimResult>(granted.clone()).is_ok());

        let mut missing_time = granted.clone();
        missing_time.as_object_mut().unwrap().remove("grantedAtMs");
        assert!(serde_json::from_value::<DesktopActionStartClaimResult>(missing_time).is_err());

        let canceled = json!({
            "invocationId": A,
            "correlationId": B,
            "attemptEpoch": 2,
            "decision": "canceled",
            "terminalCode": "canceled"
        });
        assert!(serde_json::from_value::<DesktopActionStartClaimResult>(canceled).is_ok());

        let mut explicit_null = granted;
        explicit_null["terminalCode"] = Value::Null;
        assert!(serde_json::from_value::<DesktopActionStartClaimResult>(explicit_null).is_err());
    }

    #[test]
    fn acknowledgements_require_status_specific_fields() {
        let base = json!({
            "identity": identity(),
            "invocationId": A,
            "correlationId": B,
            "attemptEpoch": 2,
            "actionId": "workspace.tab.close",
            "actionVersion": 1,
            "target": {"windowId": C, "windowGeneration": 3},
            "status": "succeeded",
            "result": {}
        });
        assert!(serde_json::from_value::<DesktopActionAcknowledgeParams>(base.clone()).is_ok());

        let mut failed = base.clone();
        failed["status"] = json!("failed");
        failed.as_object_mut().unwrap().remove("result");
        failed["errorCode"] = json!("execution_failed");
        assert!(serde_json::from_value::<DesktopActionAcknowledgeParams>(failed).is_ok());

        let mut failed_with_result = base.clone();
        failed_with_result["status"] = json!("failed");
        failed_with_result["errorCode"] = json!("execution_failed");
        assert!(
            serde_json::from_value::<DesktopActionAcknowledgeParams>(failed_with_result).is_err()
        );

        let mut null_result = base;
        null_result["result"] = Value::Null;
        assert!(serde_json::from_value::<DesktopActionAcknowledgeParams>(null_result).is_err());
    }

    #[test]
    fn desktop_execution_request_carries_exact_attempt_and_target() {
        let request = json!({
            "identity": identity(),
            "invocationId": A,
            "correlationId": B,
            "attemptEpoch": 7,
            "actionId": "workspace.tab.close",
            "actionVersion": 1,
            "target": {"windowId": C, "windowGeneration": 8},
            "parameters": {},
            "expiresAtMs": 1000
        });
        assert!(serde_json::from_value::<DesktopActionExecutionRequest>(request.clone()).is_ok());
        let poll = json!({"request": request.clone()});
        assert!(serde_json::from_value::<DesktopActionPollResult>(poll).is_ok());
        assert!(
            serde_json::from_value::<DesktopActionPollResult>(json!({"request": null})).is_err()
        );
        assert!(
            serde_json::from_value::<DesktopActionPollParams>(json!({
                "identity": identity(),
                "timeoutMs": 5000
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<DesktopActionPollParams>(json!({
                "identity": identity(),
                "timeoutMs": 5001
            }))
            .is_err()
        );

        let mut unsafe_attempt = request.clone();
        unsafe_attempt["attemptEpoch"] = json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<DesktopActionExecutionRequest>(unsafe_attempt).is_err());

        let mut zero_attempt = request.clone();
        zero_attempt["attemptEpoch"] = json!(0);
        assert!(serde_json::from_value::<DesktopActionExecutionRequest>(zero_attempt).is_err());
        let mut zero_provider_epoch = request.clone();
        zero_provider_epoch["identity"]["providerEpoch"] = json!(0);
        assert!(
            serde_json::from_value::<DesktopActionExecutionRequest>(zero_provider_epoch).is_err()
        );
        let mut zero_window_generation = request;
        zero_window_generation["target"]["windowGeneration"] = json!(0);
        assert!(
            serde_json::from_value::<DesktopActionExecutionRequest>(zero_window_generation)
                .is_err()
        );
    }
}

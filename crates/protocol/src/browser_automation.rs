//! Strict browser-automation contracts for the main-owned closed operation set.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use url::Url;
use uuid::Uuid;

use crate::{ActionIdempotency, ActionInvocationTarget, DesktopProviderIdentityParams};

pub const BROWSER_AUTOMATION_CAPABILITY: &str = "browser-automation-v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_AUTOMATION_SESSIONS_PER_PROVIDER: usize = 8;
pub const MAX_AUTOMATION_SESSIONS_PER_PROFILE: usize = 16;
pub const MAX_AUTOMATION_QUEUE_DEPTH: usize = 32;
pub const MAX_AUTOMATION_SELECTOR_SCALARS: usize = 1_024;
pub const MAX_AUTOMATION_TEXT_BYTES: usize = 48 * 1_024;
pub const MAX_AUTOMATION_URL_SCALARS: usize = 2_048;
pub const MAX_AUTOMATION_QUERY_MATCHES: u16 = 100;
pub const MAX_AUTOMATION_QUERY_RESULT_BYTES: usize = 16 * 1_024;
pub const MAX_AUTOMATION_SCREENSHOT_DIMENSION: u32 = 4_096;
pub const MAX_AUTOMATION_SCREENSHOT_PIXELS: u64 = 16_000_000;
pub const MAX_AUTOMATION_SCREENSHOT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_AUTOMATION_SCREENSHOT_CHUNKS: u16 = 32;
pub const MAX_AUTOMATION_SCREENSHOT_CHUNK_BYTES: usize = 512 * 1024;
pub const DEFAULT_AUTOMATION_OPERATION_TIMEOUT_MS: u32 = 30_000;
pub const MAX_AUTOMATION_OPERATION_TIMEOUT_MS: u32 = 120_000;
pub const AUTOMATION_SESSION_IDLE_TTL_MS: u64 = 30 * 60 * 1_000;
pub const AUTOMATION_CONTENT_TTL_MS: u64 = 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationSessionMode {
    Ephemeral,
    Attach,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationSessionState {
    Creating,
    Ready,
    Destroying,
    Destroyed,
    Failed,
    Expired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationOperationState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
    Expired,
    Interrupted,
    ResultExpired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BrowserAutomationErrorCode {
    CapabilityUnavailable,
    SessionNotFound,
    SessionLimit,
    SessionExpired,
    SessionGenerationMismatch,
    StaleNavigation,
    TargetRequired,
    TargetNotFound,
    TargetStale,
    ProviderUnavailable,
    ProviderIneligible,
    ProviderLeaseExpired,
    ProviderEpochMismatch,
    AutomationBackpressure,
    InvalidOperation,
    InvalidSelector,
    UnsafeUrl,
    PolicyDenied,
    ResourceLimit,
    Timeout,
    Canceled,
    Interrupted,
    ResultExpired,
    IdempotencyConflict,
    IdempotencyExpired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationTargetBinding {
    #[serde(deserialize_with = "uuid_string")]
    pub workspace_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub pane_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub tab_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub browser_session_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub browser_lifecycle_id: String,
    pub window: ActionInvocationTarget,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct BrowserAutomationSessionCreateParams {
    pub mode: BrowserAutomationSessionMode,
    #[serde(deserialize_with = "profile_key")]
    pub profile_key: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_target"
    )]
    pub target: Option<BrowserAutomationTargetBinding>,
    pub idempotency: ActionIdempotency,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationSessionCreateParamsWire {
    mode: BrowserAutomationSessionMode,
    #[serde(deserialize_with = "profile_key")]
    profile_key: String,
    #[serde(default, deserialize_with = "optional_target")]
    target: Option<BrowserAutomationTargetBinding>,
    idempotency: ActionIdempotency,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
}

impl<'de> Deserialize<'de> for BrowserAutomationSessionCreateParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrowserAutomationSessionCreateParamsWire::deserialize(deserializer)?;
        if (wire.mode == BrowserAutomationSessionMode::Attach) != wire.target.is_some() {
            return Err(serde::de::Error::custom(
                "attach requires one exact target and ephemeral forbids one",
            ));
        }
        Ok(Self {
            mode: wire.mode,
            profile_key: wire.profile_key,
            target: wire.target,
            idempotency: wire.idempotency,
            correlation_id: wire.correlation_id,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationSessionSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub generation: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub navigation_epoch: u64,
    pub mode: BrowserAutomationSessionMode,
    pub state: BrowserAutomationSessionState,
    #[serde(deserialize_with = "profile_key")]
    pub profile_key: String,
    pub target: BrowserAutomationTargetBinding,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub created_at_ms: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub updated_at_ms: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationSessionCreateResult {
    pub session: BrowserAutomationSessionSnapshot,
}

/// Service-owned create request. The exact native binding is absent for an
/// ephemeral session until Electron main creates the isolated page, and is
/// returned in the provider acknowledgement.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct BrowserAutomationSessionProvision {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub generation: u64,
    pub mode: BrowserAutomationSessionMode,
    #[serde(deserialize_with = "profile_key")]
    pub profile_key: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_target"
    )]
    pub requested_target: Option<BrowserAutomationTargetBinding>,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub created_at_ms: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationSessionProvisionWire {
    #[serde(deserialize_with = "uuid_string")]
    automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    generation: u64,
    mode: BrowserAutomationSessionMode,
    #[serde(deserialize_with = "profile_key")]
    profile_key: String,
    #[serde(default, deserialize_with = "optional_target")]
    requested_target: Option<BrowserAutomationTargetBinding>,
    #[serde(deserialize_with = "safe_integer")]
    created_at_ms: u64,
    #[serde(deserialize_with = "safe_integer")]
    expires_at_ms: u64,
}

impl<'de> Deserialize<'de> for BrowserAutomationSessionProvision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrowserAutomationSessionProvisionWire::deserialize(deserializer)?;
        if (wire.mode == BrowserAutomationSessionMode::Attach) != wire.requested_target.is_some() {
            return Err(serde::de::Error::custom(
                "attach provision requires one exact target and ephemeral forbids one",
            ));
        }
        if wire.generation == 0 || wire.expires_at_ms <= wire.created_at_ms {
            return Err(serde::de::Error::custom(
                "invalid automation session provision epoch",
            ));
        }
        Ok(Self {
            automation_session_id: wire.automation_session_id,
            generation: wire.generation,
            mode: wire.mode,
            profile_key: wire.profile_key,
            requested_target: wire.requested_target,
            created_at_ms: wire.created_at_ms,
            expires_at_ms: wire.expires_at_ms,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationSessionParams {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationSessionResult {
    pub session: BrowserAutomationSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationSessionListResult {
    #[serde(deserialize_with = "session_list")]
    pub sessions: Vec<BrowserAutomationSessionSnapshot>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationWaitLifecycle {
    DomContentLoaded,
    Load,
    NetworkIdle,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationSelectorCondition {
    Attached,
    Visible,
    Hidden,
    Enabled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(export)]
pub enum BrowserAutomationWaitCondition {
    Lifecycle {
        lifecycle: BrowserAutomationWaitLifecycle,
    },
    Selector {
        #[serde(deserialize_with = "selector")]
        selector: String,
        condition: BrowserAutomationSelectorCondition,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationKey {
    Enter,
    Escape,
    Tab,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    PageUp,
    PageDown,
    Backspace,
    Delete,
    Space,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(export)]
pub enum BrowserAutomationOperation {
    Navigate {
        #[serde(deserialize_with = "safe_url")]
        url: String,
    },
    Wait {
        condition: BrowserAutomationWaitCondition,
    },
    Query {
        #[serde(deserialize_with = "selector")]
        selector: String,
        #[serde(deserialize_with = "query_limit")]
        limit: u16,
    },
    Focus {
        #[serde(deserialize_with = "selector")]
        selector: String,
    },
    Click {
        #[serde(deserialize_with = "selector")]
        selector: String,
    },
    TypeText {
        #[serde(deserialize_with = "selector")]
        selector: String,
        #[serde(deserialize_with = "typed_text")]
        text: String,
    },
    Key {
        key: BrowserAutomationKey,
    },
    KeyAt {
        #[serde(deserialize_with = "selector")]
        selector: String,
        key: BrowserAutomationKey,
    },
    Screenshot {
        #[serde(deserialize_with = "screenshot_dimension")]
        width: u32,
        #[serde(deserialize_with = "screenshot_dimension")]
        height: u32,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationOperationInvokeParams {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[ts(type = "number")]
    pub session_generation: u64,
    #[ts(type = "number")]
    pub navigation_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub operation_id: String,
    #[ts(type = "number")]
    pub attempt_epoch: u64,
    #[serde(deserialize_with = "operation_timeout")]
    pub timeout_ms: u32,
    pub operation: BrowserAutomationOperation,
    pub idempotency: ActionIdempotency,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationOperationInvokeParamsWire {
    #[serde(deserialize_with = "uuid_string")]
    automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    session_generation: u64,
    #[serde(deserialize_with = "safe_integer")]
    navigation_epoch: u64,
    #[serde(deserialize_with = "uuid_string")]
    operation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    attempt_epoch: u64,
    #[serde(deserialize_with = "operation_timeout")]
    timeout_ms: u32,
    operation: BrowserAutomationOperation,
    idempotency: ActionIdempotency,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
}

impl<'de> Deserialize<'de> for BrowserAutomationOperationInvokeParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrowserAutomationOperationInvokeParamsWire::deserialize(deserializer)?;
        if let BrowserAutomationOperation::Screenshot { width, height } = wire.operation
            && u64::from(width).saturating_mul(u64::from(height)) > MAX_AUTOMATION_SCREENSHOT_PIXELS
        {
            return Err(serde::de::Error::custom(
                "screenshot pixel count exceeds its bound",
            ));
        }
        if serde_json::to_vec(&wire.operation).map_or(true, |bytes| bytes.len() > 64 * 1_024) {
            return Err(serde::de::Error::custom(
                "automation operation exceeds its wire bound",
            ));
        }
        Ok(Self {
            automation_session_id: wire.automation_session_id,
            session_generation: wire.session_generation,
            navigation_epoch: wire.navigation_epoch,
            operation_id: wire.operation_id,
            attempt_epoch: wire.attempt_epoch,
            timeout_ms: wire.timeout_ms,
            operation: wire.operation,
            idempotency: wire.idempotency,
            correlation_id: wire.correlation_id,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
#[allow(clippy::struct_excessive_bools)] // Closed, content-free DOM state flags are independent.
pub struct BrowserAutomationElementSummary {
    #[serde(deserialize_with = "element_index")]
    pub index: u16,
    pub tag: BrowserAutomationElementTag,
    pub visible: bool,
    pub enabled: bool,
    pub focused: bool,
    pub editable: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationElementTag {
    Button,
    Input,
    Textarea,
    Select,
    Link,
    Form,
    Image,
    Dialog,
    Generic,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationScreenshotHandle {
    #[serde(deserialize_with = "uuid_string")]
    pub handle_id: String,
    #[serde(deserialize_with = "screenshot_dimension")]
    pub width: u32,
    #[serde(deserialize_with = "screenshot_dimension")]
    pub height: u32,
    #[serde(deserialize_with = "screenshot_byte_length")]
    #[ts(type = "number")]
    pub byte_length: u64,
    #[ts(type = "\"image/png\"")]
    pub media_type: String,
    #[serde(deserialize_with = "sha256")]
    pub sha256: String,
    #[serde(deserialize_with = "chunk_count")]
    pub chunk_count: u16,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(rename_all_fields = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationOperationResultData {
    Empty,
    Navigation {
        #[ts(type = "number")]
        navigation_epoch: u64,
    },
    Query {
        matches: Vec<BrowserAutomationElementSummary>,
    },
    Screenshot {
        handle: BrowserAutomationScreenshotHandle,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum BrowserAutomationOperationResultDataWire {
    Empty,
    Navigation {
        #[serde(deserialize_with = "safe_integer")]
        navigation_epoch: u64,
    },
    Query {
        matches: Vec<BrowserAutomationElementSummary>,
    },
    Screenshot {
        handle: BrowserAutomationScreenshotHandle,
    },
}

impl<'de> Deserialize<'de> for BrowserAutomationOperationResultData {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrowserAutomationOperationResultDataWire::deserialize(deserializer)?;
        match wire {
            BrowserAutomationOperationResultDataWire::Empty => Ok(Self::Empty),
            BrowserAutomationOperationResultDataWire::Navigation { navigation_epoch } => {
                Ok(Self::Navigation { navigation_epoch })
            }
            BrowserAutomationOperationResultDataWire::Query { matches } => {
                if matches.len() > usize::from(MAX_AUTOMATION_QUERY_MATCHES)
                    || serde_json::to_vec(&matches).map_or(true, |bytes| {
                        bytes.len() > MAX_AUTOMATION_QUERY_RESULT_BYTES
                    })
                {
                    return Err(serde::de::Error::custom("query result exceeds its bounds"));
                }
                Ok(Self::Query { matches })
            }
            BrowserAutomationOperationResultDataWire::Screenshot { handle } => {
                Ok(Self::Screenshot { handle })
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct BrowserAutomationOperationSnapshot {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub operation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub attempt_epoch: u64,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub navigation_epoch: u64,
    pub state: BrowserAutomationOperationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "optional_operation_result")]
    pub result: Option<BrowserAutomationOperationResultData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "optional_automation_error")]
    pub error_code: Option<BrowserAutomationErrorCode>,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub updated_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationOperationSnapshotWire {
    #[serde(deserialize_with = "uuid_string")]
    automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    operation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    attempt_epoch: u64,
    #[serde(deserialize_with = "safe_integer")]
    navigation_epoch: u64,
    state: BrowserAutomationOperationState,
    #[serde(default, deserialize_with = "optional_operation_result")]
    result: Option<BrowserAutomationOperationResultData>,
    #[serde(default, deserialize_with = "optional_automation_error")]
    error_code: Option<BrowserAutomationErrorCode>,
    #[serde(deserialize_with = "safe_integer")]
    updated_at_ms: u64,
}

impl<'de> Deserialize<'de> for BrowserAutomationOperationSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrowserAutomationOperationSnapshotWire::deserialize(deserializer)?;
        if wire.session_generation == 0 || wire.attempt_epoch == 0 {
            return Err(serde::de::Error::custom(
                "automation operation epochs must be positive",
            ));
        }
        let fields_are_consistent = match wire.state {
            BrowserAutomationOperationState::Queued | BrowserAutomationOperationState::Running => {
                wire.result.is_none() && wire.error_code.is_none()
            }
            BrowserAutomationOperationState::Succeeded => {
                wire.result.is_some() && wire.error_code.is_none()
            }
            BrowserAutomationOperationState::Failed
            | BrowserAutomationOperationState::Canceled
            | BrowserAutomationOperationState::Expired
            | BrowserAutomationOperationState::Interrupted
            | BrowserAutomationOperationState::ResultExpired => {
                wire.result.is_none() && wire.error_code.is_some()
            }
        };
        if !fields_are_consistent {
            return Err(serde::de::Error::custom(
                "inconsistent automation operation terminal fields",
            ));
        }
        Ok(Self {
            automation_session_id: wire.automation_session_id,
            session_generation: wire.session_generation,
            operation_id: wire.operation_id,
            correlation_id: wire.correlation_id,
            attempt_epoch: wire.attempt_epoch,
            navigation_epoch: wire.navigation_epoch,
            state: wire.state,
            result: wire.result,
            error_code: wire.error_code,
            updated_at_ms: wire.updated_at_ms,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationOperationInvokeResult {
    pub operation: BrowserAutomationOperationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationOperationCancelParams {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub operation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationScreenshotReadParams {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub handle_id: String,
    #[serde(deserialize_with = "chunk_index")]
    pub chunk_index: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationScreenshotReadResult {
    #[serde(deserialize_with = "uuid_string")]
    pub handle_id: String,
    #[serde(deserialize_with = "chunk_index")]
    pub chunk_index: u16,
    #[serde(deserialize_with = "chunk_count")]
    pub chunk_count: u16,
    #[serde(deserialize_with = "base64_chunk")]
    pub data_base64: String,
    #[serde(deserialize_with = "sha256")]
    pub sha256: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationScreenshotReleaseParams {
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub handle_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationProviderPollParams {
    pub identity: DesktopProviderIdentityParams,
    #[serde(deserialize_with = "poll_timeout")]
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationExecutionRequest {
    pub identity: DesktopProviderIdentityParams,
    pub target: ActionInvocationTarget,
    pub session: BrowserAutomationSessionSnapshot,
    pub operation: BrowserAutomationOperationInvokeParams,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(rename_all_fields = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationProviderRequest {
    Create {
        identity: DesktopProviderIdentityParams,
        target: ActionInvocationTarget,
        provision: BrowserAutomationSessionProvision,
        #[serde(deserialize_with = "uuid_string")]
        operation_id: String,
        #[serde(deserialize_with = "uuid_string")]
        correlation_id: String,
        #[serde(deserialize_with = "safe_integer")]
        #[ts(type = "number")]
        attempt_epoch: u64,
    },
    Destroy {
        identity: DesktopProviderIdentityParams,
        target: ActionInvocationTarget,
        session: BrowserAutomationSessionSnapshot,
        #[serde(deserialize_with = "uuid_string")]
        operation_id: String,
        #[serde(deserialize_with = "uuid_string")]
        correlation_id: String,
        #[serde(deserialize_with = "safe_integer")]
        #[ts(type = "number")]
        attempt_epoch: u64,
    },
    Execute {
        request: BrowserAutomationExecutionRequest,
    },
    Cancel {
        identity: DesktopProviderIdentityParams,
        target: ActionInvocationTarget,
        #[serde(deserialize_with = "uuid_string")]
        automation_session_id: String,
        #[serde(deserialize_with = "safe_integer")]
        #[ts(type = "number")]
        session_generation: u64,
        #[serde(deserialize_with = "uuid_string")]
        operation_id: String,
        #[serde(deserialize_with = "uuid_string")]
        correlation_id: String,
    },
    ScreenshotRead {
        identity: DesktopProviderIdentityParams,
        target: ActionInvocationTarget,
        #[serde(deserialize_with = "uuid_string")]
        request_id: String,
        #[serde(deserialize_with = "uuid_string")]
        correlation_id: String,
        params: BrowserAutomationScreenshotReadParams,
    },
    ScreenshotRelease {
        identity: DesktopProviderIdentityParams,
        target: ActionInvocationTarget,
        #[serde(deserialize_with = "uuid_string")]
        request_id: String,
        #[serde(deserialize_with = "uuid_string")]
        correlation_id: String,
        params: BrowserAutomationScreenshotReleaseParams,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct BrowserAutomationProviderPollResult {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_provider_request"
    )]
    pub request: Option<BrowserAutomationProviderRequest>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationProviderAcknowledgeParams {
    pub identity: DesktopProviderIdentityParams,
    pub target: ActionInvocationTarget,
    #[serde(deserialize_with = "uuid_string")]
    pub automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    pub operation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    #[ts(type = "number")]
    pub attempt_epoch: u64,
    pub state: BrowserAutomationOperationState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_session_snapshot"
    )]
    pub session: Option<BrowserAutomationSessionSnapshot>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_operation_result"
    )]
    pub result: Option<BrowserAutomationOperationResultData>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_automation_error"
    )]
    pub error_code: Option<BrowserAutomationErrorCode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationProviderAcknowledgeParamsWire {
    identity: DesktopProviderIdentityParams,
    target: ActionInvocationTarget,
    #[serde(deserialize_with = "uuid_string")]
    automation_session_id: String,
    #[serde(deserialize_with = "safe_integer")]
    session_generation: u64,
    #[serde(deserialize_with = "uuid_string")]
    operation_id: String,
    #[serde(deserialize_with = "uuid_string")]
    correlation_id: String,
    #[serde(deserialize_with = "safe_integer")]
    attempt_epoch: u64,
    state: BrowserAutomationOperationState,
    #[serde(default, deserialize_with = "optional_session_snapshot")]
    session: Option<BrowserAutomationSessionSnapshot>,
    #[serde(default, deserialize_with = "optional_operation_result")]
    result: Option<BrowserAutomationOperationResultData>,
    #[serde(default, deserialize_with = "optional_automation_error")]
    error_code: Option<BrowserAutomationErrorCode>,
}

impl<'de> Deserialize<'de> for BrowserAutomationProviderAcknowledgeParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BrowserAutomationProviderAcknowledgeParamsWire::deserialize(deserializer)?;
        if wire.session_generation == 0 || wire.attempt_epoch == 0 {
            return Err(serde::de::Error::custom(
                "provider acknowledgement epochs must be positive",
            ));
        }
        match wire.state {
            BrowserAutomationOperationState::Queued | BrowserAutomationOperationState::Running => {
                return Err(serde::de::Error::custom(
                    "provider acknowledgement must be terminal",
                ));
            }
            BrowserAutomationOperationState::Succeeded => {
                if wire.error_code.is_some() || (wire.session.is_some() && wire.result.is_some()) {
                    return Err(serde::de::Error::custom(
                        "successful provider acknowledgement has inconsistent output",
                    ));
                }
            }
            BrowserAutomationOperationState::Failed
            | BrowserAutomationOperationState::Canceled
            | BrowserAutomationOperationState::Expired
            | BrowserAutomationOperationState::Interrupted
            | BrowserAutomationOperationState::ResultExpired => {
                if wire.error_code.is_none() || wire.session.is_some() || wire.result.is_some() {
                    return Err(serde::de::Error::custom(
                        "failed provider acknowledgement has inconsistent output",
                    ));
                }
            }
        }
        if let Some(session) = &wire.session
            && (session.automation_session_id != wire.automation_session_id
                || session.generation != wire.session_generation
                || session.target.window != wire.target
                || session.state != BrowserAutomationSessionState::Ready)
        {
            return Err(serde::de::Error::custom(
                "provider acknowledgement session binding is inconsistent",
            ));
        }
        Ok(Self {
            identity: wire.identity,
            target: wire.target,
            automation_session_id: wire.automation_session_id,
            session_generation: wire.session_generation,
            operation_id: wire.operation_id,
            correlation_id: wire.correlation_id,
            attempt_epoch: wire.attempt_epoch,
            state: wire.state,
            session: wire.session,
            result: wire.result,
            error_code: wire.error_code,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationProviderAcknowledgeResult {
    pub operation: BrowserAutomationOperationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(rename_all_fields = "camelCase")]
#[ts(export)]
pub enum BrowserAutomationProviderTransferOutcome {
    ScreenshotRead {
        result: BrowserAutomationScreenshotReadResult,
    },
    ScreenshotRelease {
        released: bool,
    },
    Error {
        error_code: BrowserAutomationErrorCode,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationProviderTransferRespondParams {
    pub identity: DesktopProviderIdentityParams,
    pub target: ActionInvocationTarget,
    #[serde(deserialize_with = "uuid_string")]
    pub request_id: String,
    #[serde(deserialize_with = "uuid_string")]
    pub correlation_id: String,
    pub outcome: BrowserAutomationProviderTransferOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserAutomationScreenshotReleaseResult {
    pub released: bool,
}

fn uuid_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > MAX_SAFE_INTEGER {
        return Err(serde::de::Error::custom(
            "integer exceeds JavaScript's safe range",
        ));
    }
    Ok(value)
}

fn session_list<'de, D>(deserializer: D) -> Result<Vec<BrowserAutomationSessionSnapshot>, D::Error>
where
    D: Deserializer<'de>,
{
    let sessions = Vec::<BrowserAutomationSessionSnapshot>::deserialize(deserializer)?;
    if sessions.len() > MAX_AUTOMATION_SESSIONS_PER_PROFILE {
        return Err(serde::de::Error::custom(
            "automation session list exceeds its bound",
        ));
    }
    Ok(sessions)
}

fn profile_key<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(serde::de::Error::custom("invalid automation profile key"));
    }
    Ok(value)
}

fn optional_target<'de, D>(
    deserializer: D,
) -> Result<Option<BrowserAutomationTargetBinding>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<BrowserAutomationTargetBinding>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("automation target must not be null"))
}

fn optional_operation_result<'de, D>(
    deserializer: D,
) -> Result<Option<BrowserAutomationOperationResultData>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<BrowserAutomationOperationResultData>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("automation result must not be null"))
}

fn optional_session_snapshot<'de, D>(
    deserializer: D,
) -> Result<Option<BrowserAutomationSessionSnapshot>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<BrowserAutomationSessionSnapshot>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("automation session must not be null"))
}

fn optional_automation_error<'de, D>(
    deserializer: D,
) -> Result<Option<BrowserAutomationErrorCode>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<BrowserAutomationErrorCode>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("automation error must not be null"))
}

fn optional_provider_request<'de, D>(
    deserializer: D,
) -> Result<Option<BrowserAutomationProviderRequest>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<BrowserAutomationProviderRequest>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("automation provider request must not be null"))
}

fn selector<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    bounded_text(
        deserializer,
        MAX_AUTOMATION_SELECTOR_SCALARS,
        false,
        "selector",
    )
}

fn typed_text<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() > MAX_AUTOMATION_TEXT_BYTES || value.chars().any(|c| c == '\0') {
        return Err(serde::de::Error::custom("typed text exceeds its bounds"));
    }
    Ok(value)
}

fn safe_url<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = bounded_text(deserializer, MAX_AUTOMATION_URL_SCALARS, false, "URL")?;
    let parsed = Url::parse(&value).map_err(serde::de::Error::custom)?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
        return Err(serde::de::Error::custom(
            "automation URL must be HTTP or HTTPS",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(serde::de::Error::custom(
            "automation URL must not contain credentials",
        ));
    }
    Ok(value)
}

fn bounded_text<'de, D>(
    deserializer: D,
    max_scalars: usize,
    allow_empty: bool,
    label: &'static str,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    validate_bounded_text(
        String::deserialize(deserializer)?,
        max_scalars,
        allow_empty,
        label,
    )
}

fn validate_bounded_text<E>(
    value: String,
    max_scalars: usize,
    allow_empty: bool,
    label: &'static str,
) -> Result<String, E>
where
    E: serde::de::Error,
{
    let count = value.chars().count();
    if (!allow_empty && count == 0) || count > max_scalars || value.chars().any(char::is_control) {
        return Err(E::custom(format!("invalid {label}")));
    }
    Ok(value)
}

fn query_limit<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value == 0 || value > MAX_AUTOMATION_QUERY_MATCHES {
        return Err(serde::de::Error::custom("invalid automation query limit"));
    }
    Ok(value)
}

fn operation_timeout<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value == 0 || value > MAX_AUTOMATION_OPERATION_TIMEOUT_MS {
        return Err(serde::de::Error::custom("invalid automation timeout"));
    }
    Ok(value)
}

fn poll_timeout<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value > 30_000 {
        return Err(serde::de::Error::custom("invalid automation poll timeout"));
    }
    Ok(value)
}

fn screenshot_dimension<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value == 0 || value > MAX_AUTOMATION_SCREENSHOT_DIMENSION {
        return Err(serde::de::Error::custom("invalid screenshot dimension"));
    }
    Ok(value)
}

fn screenshot_byte_length<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value == 0 || value > MAX_AUTOMATION_SCREENSHOT_BYTES {
        return Err(serde::de::Error::custom("invalid screenshot byte length"));
    }
    Ok(value)
}

fn chunk_count<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value == 0 || value > MAX_AUTOMATION_SCREENSHOT_CHUNKS {
        return Err(serde::de::Error::custom("invalid screenshot chunk count"));
    }
    Ok(value)
}

fn chunk_index<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value >= MAX_AUTOMATION_SCREENSHOT_CHUNKS {
        return Err(serde::de::Error::custom("invalid screenshot chunk index"));
    }
    Ok(value)
}

fn base64_chunk<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let max_encoded = MAX_AUTOMATION_SCREENSHOT_CHUNK_BYTES.div_ceil(3) * 4;
    let canonical = BASE64_STANDARD
        .decode(value.as_bytes())
        .ok()
        .filter(|decoded| decoded.len() <= MAX_AUTOMATION_SCREENSHOT_CHUNK_BYTES)
        .map(|decoded| BASE64_STANDARD.encode(decoded));
    if value.is_empty() || value.len() > max_encoded || canonical.as_deref() != Some(&value) {
        return Err(serde::de::Error::custom("invalid screenshot chunk"));
    }
    Ok(value)
}

fn sha256<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(serde::de::Error::custom("invalid SHA-256 digest"));
    }
    Ok(value)
}

fn element_index<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value >= MAX_AUTOMATION_QUERY_MATCHES {
        return Err(serde::de::Error::custom("invalid query result index"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn invoke(operation: &serde_json::Value) -> serde_json::Value {
        json!({
            "automationSessionId": "10000000-0000-4000-8000-000000000001",
            "sessionGeneration": 1,
            "navigationEpoch": 2,
            "operationId": "10000000-0000-4000-8000-000000000002",
            "attemptEpoch": 1,
            "timeoutMs": 30000,
            "operation": operation,
            "idempotency": {
                "epoch": "10000000-0000-4000-8000-000000000003",
                "key": "10000000-0000-4000-8000-000000000004"
            },
            "correlationId": "10000000-0000-4000-8000-000000000005"
        })
    }

    #[test]
    fn operation_set_rejects_code_urls_credentials_and_unknown_fields() {
        assert!(
            serde_json::from_value::<BrowserAutomationOperationInvokeParams>(invoke(&json!({
                "kind": "navigate", "url": "https://example.test/path"
            })))
            .is_ok()
        );
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://u:p@example.test/",
        ] {
            assert!(
                serde_json::from_value::<BrowserAutomationOperationInvokeParams>(invoke(&json!({
                    "kind": "navigate", "url": url
                })))
                .is_err()
            );
        }
        assert!(serde_json::from_value::<BrowserAutomationOperationInvokeParams>(invoke(&json!({
            "kind": "query", "selector": "button", "limit": 1, "script": "return document.cookie"
        }))).is_err());
    }

    #[test]
    fn creation_mode_and_exact_target_are_consistent() {
        let base = json!({
            "mode": "ephemeral",
            "profileKey": "private",
            "idempotency": {
                "epoch": "10000000-0000-4000-8000-000000000003",
                "key": "10000000-0000-4000-8000-000000000004"
            },
            "correlationId": "10000000-0000-4000-8000-000000000005"
        });
        assert!(
            serde_json::from_value::<BrowserAutomationSessionCreateParams>(base.clone()).is_ok()
        );
        let mut invalid = base;
        invalid["mode"] = json!("attach");
        assert!(serde_json::from_value::<BrowserAutomationSessionCreateParams>(invalid).is_err());

        let provision = json!({
            "automationSessionId": "10000000-0000-4000-8000-000000000001",
            "generation": 1,
            "mode": "ephemeral",
            "profileKey": "private",
            "createdAtMs": 1,
            "expiresAtMs": 2
        });
        assert!(
            serde_json::from_value::<BrowserAutomationSessionProvision>(provision.clone()).is_ok()
        );
        let mut invalid_provision = provision;
        invalid_provision["requestedTarget"] = json!(null);
        assert!(
            serde_json::from_value::<BrowserAutomationSessionProvision>(invalid_provision).is_err()
        );
    }

    #[test]
    fn query_and_screenshot_results_are_bounded_and_content_free() {
        assert!(
            serde_json::from_value::<BrowserAutomationOperationResultData>(json!({
                "kind": "query",
                "matches": [{
                    "index": 0,
                    "tag": "button",
                    "visible": true,
                    "enabled": true,
                    "focused": false,
                    "editable": false
                }]
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<BrowserAutomationOperationResultData>(json!({
                "kind": "query",
                "matches": [{
                    "index": 0,
                    "tag": "button",
                    "visible": true,
                    "enabled": true,
                    "focused": false,
                    "editable": false,
                    "text": "secret"
                }]
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<BrowserAutomationOperationInvokeParams>(invoke(&json!({
                "kind": "screenshot", "width": 4000, "height": 4000
            })))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<BrowserAutomationOperationInvokeParams>(invoke(&json!({
                "kind": "screenshot", "width": 4096, "height": 4096
            })))
            .is_err()
        );

        let screenshot_chunk = json!({
            "handleId": "10000000-0000-4000-8000-000000000001",
            "chunkIndex": 0,
            "chunkCount": 1,
            "dataBase64": "cG5n",
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "expiresAtMs": 1
        });
        assert!(
            serde_json::from_value::<BrowserAutomationScreenshotReadResult>(
                screenshot_chunk.clone()
            )
            .is_ok()
        );
        for invalid in ["abc", "cG5n=", "A===", "YR=="] {
            let mut candidate = screenshot_chunk.clone();
            candidate["dataBase64"] = json!(invalid);
            assert!(
                serde_json::from_value::<BrowserAutomationScreenshotReadResult>(candidate).is_err(),
                "accepted noncanonical base64: {invalid}"
            );
        }
    }

    #[test]
    fn javascript_number_fields_and_session_lists_are_bounded() {
        let mut invalid = invoke(&json!({ "kind": "key", "key": "enter" }));
        invalid["sessionGeneration"] = json!(MAX_SAFE_INTEGER + 1);
        assert!(serde_json::from_value::<BrowserAutomationOperationInvokeParams>(invalid).is_err());

        let sessions = std::iter::repeat_with(|| {
            json!({
                "automationSessionId": Uuid::new_v4().to_string(),
                "generation": 1,
                "navigationEpoch": 0,
                "mode": "ephemeral",
                "state": "ready",
                "profileKey": "private",
                "target": {
                    "workspaceId": "10000000-0000-4000-8000-000000000001",
                    "paneId": "10000000-0000-4000-8000-000000000002",
                    "tabId": "10000000-0000-4000-8000-000000000003",
                    "browserSessionId": "10000000-0000-4000-8000-000000000004",
                    "browserLifecycleId": "10000000-0000-4000-8000-000000000005",
                    "window": {
                        "windowId": "10000000-0000-4000-8000-000000000006",
                        "windowGeneration": 1
                    }
                },
                "createdAtMs": 1,
                "updatedAtMs": 1,
                "expiresAtMs": 2
            })
        })
        .take(MAX_AUTOMATION_SESSIONS_PER_PROFILE + 1)
        .collect::<Vec<_>>();
        assert!(
            serde_json::from_value::<BrowserAutomationSessionListResult>(json!({
                "sessions": sessions
            }))
            .is_err()
        );
    }

    #[test]
    fn provider_request_struct_variant_fields_use_camel_case_on_the_wire() {
        let wire = json!({
            "kind": "create",
            "identity": {
                "providerId": "10000000-0000-4000-8000-000000000001",
                "providerEpoch": 1,
                "leaseId": "10000000-0000-4000-8000-000000000002"
            },
            "target": {
                "windowId": "10000000-0000-4000-8000-000000000003",
                "windowGeneration": 1
            },
            "provision": {
                "automationSessionId": "10000000-0000-4000-8000-000000000004",
                "generation": 1,
                "mode": "ephemeral",
                "profileKey": "private",
                "createdAtMs": 1,
                "expiresAtMs": 2
            },
            "operationId": "10000000-0000-4000-8000-000000000005",
            "correlationId": "10000000-0000-4000-8000-000000000006",
            "attemptEpoch": 1
        });
        let request = serde_json::from_value::<BrowserAutomationProviderRequest>(wire.clone())
            .expect("camel-case provider request must deserialize");
        assert_eq!(
            serde_json::to_value(request).expect("provider request must serialize"),
            wire
        );
    }

    #[test]
    fn provider_acknowledgements_are_terminal_and_shape_consistent() {
        let base = json!({
            "identity": {
                "providerId": "10000000-0000-4000-8000-000000000001",
                "providerEpoch": 1,
                "leaseId": "10000000-0000-4000-8000-000000000002"
            },
            "target": {
                "windowId": "10000000-0000-4000-8000-000000000003",
                "windowGeneration": 1
            },
            "automationSessionId": "10000000-0000-4000-8000-000000000004",
            "sessionGeneration": 1,
            "operationId": "10000000-0000-4000-8000-000000000005",
            "correlationId": "10000000-0000-4000-8000-000000000006",
            "attemptEpoch": 1,
            "state": "failed",
            "errorCode": "interrupted"
        });
        assert!(
            serde_json::from_value::<BrowserAutomationProviderAcknowledgeParams>(base.clone())
                .is_ok()
        );
        let mut nonterminal = base.clone();
        nonterminal["state"] = json!("running");
        assert!(
            serde_json::from_value::<BrowserAutomationProviderAcknowledgeParams>(nonterminal)
                .is_err()
        );
        let mut inconsistent = base;
        inconsistent["state"] = json!("succeeded");
        assert!(
            serde_json::from_value::<BrowserAutomationProviderAcknowledgeParams>(inconsistent)
                .is_err()
        );
    }

    #[test]
    fn operation_snapshots_enforce_positive_epochs_and_terminal_shape() {
        let succeeded = json!({
            "automationSessionId": "10000000-0000-4000-8000-000000000001",
            "sessionGeneration": 1,
            "operationId": "10000000-0000-4000-8000-000000000002",
            "correlationId": "10000000-0000-4000-8000-000000000003",
            "attemptEpoch": 1,
            "navigationEpoch": 0,
            "state": "succeeded",
            "result": { "kind": "empty" },
            "updatedAtMs": 1
        });
        assert!(
            serde_json::from_value::<BrowserAutomationOperationSnapshot>(succeeded.clone()).is_ok()
        );
        let mut missing_result = succeeded.clone();
        missing_result.as_object_mut().unwrap().remove("result");
        assert!(
            serde_json::from_value::<BrowserAutomationOperationSnapshot>(missing_result).is_err()
        );
        let mut zero_epoch = succeeded;
        zero_epoch["attemptEpoch"] = json!(0);
        assert!(serde_json::from_value::<BrowserAutomationOperationSnapshot>(zero_epoch).is_err());
    }
}

use agent_workspace_protocol::{
    ActionIdempotency, ActionInvocationTarget, BrowserAutomationKey, BrowserAutomationOperation,
    BrowserAutomationOperationCancelParams, BrowserAutomationOperationInvokeParams,
    BrowserAutomationOperationInvokeResult, BrowserAutomationOperationSnapshot,
    BrowserAutomationOperationState, BrowserAutomationScreenshotReadParams,
    BrowserAutomationScreenshotReadResult, BrowserAutomationScreenshotReleaseParams,
    BrowserAutomationScreenshotReleaseResult, BrowserAutomationSelectorCondition,
    BrowserAutomationSessionCreateParams, BrowserAutomationSessionCreateResult,
    BrowserAutomationSessionListResult, BrowserAutomationSessionMode,
    BrowserAutomationSessionParams, BrowserAutomationSessionResult, BrowserAutomationTargetBinding,
    BrowserAutomationWaitCondition, BrowserAutomationWaitLifecycle,
    DEFAULT_AUTOMATION_OPERATION_TIMEOUT_MS, MAX_AUTOMATION_OPERATION_TIMEOUT_MS,
    MAX_AUTOMATION_QUERY_MATCHES, MAX_AUTOMATION_SCREENSHOT_CHUNKS,
    MAX_AUTOMATION_SCREENSHOT_DIMENSION, MAX_AUTOMATION_SCREENSHOT_PIXELS,
    MAX_AUTOMATION_SELECTOR_SCALARS, MAX_AUTOMATION_TEXT_BYTES, MAX_AUTOMATION_URL_SCALARS,
};
use clap::{Subcommand, ValueEnum};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json, to_value};
use uuid::Uuid;

use crate::{
    CliError, ControlClient, EXIT_AUTHORIZATION_OR_POLICY, EXIT_CANCELLATION_OR_TIMEOUT,
    EXIT_CONFLICT, EXIT_PROVIDER_UNAVAILABLE, EXIT_TRANSPORT_OR_SERVICE, EXIT_USAGE_OR_VALIDATION,
    JSON_SAFE_INTEGER_MAX,
};

pub const OUTPUT_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Subcommand)]
pub enum BrowserCommand {
    /// Run a closed, capability-gated browser automation operation.
    Automation {
        #[command(subcommand)]
        command: AutomationCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum AutomationCommand {
    SessionCreate(SessionCreateArguments),
    SessionList,
    SessionGet(SessionArguments),
    SessionDestroy(SessionArguments),
    Navigate(OperationArguments<NavigateArguments>),
    Wait {
        #[command(flatten)]
        operation: OperationIdentityArguments,
        #[command(subcommand)]
        condition: WaitCommand,
    },
    Query(OperationArguments<QueryArguments>),
    Focus(OperationArguments<SelectorArguments>),
    Click(OperationArguments<SelectorArguments>),
    Type(OperationArguments<TypeArguments>),
    Key(OperationArguments<KeyArguments>),
    KeyAt(OperationArguments<KeyAtArguments>),
    Screenshot(OperationArguments<ScreenshotArguments>),
    Cancel(CancelArguments),
    ScreenshotRead(ScreenshotChunkArguments),
    ScreenshotRelease(ScreenshotHandleArguments),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum SessionMode {
    Ephemeral,
    Attach,
}

#[derive(Debug, clap::Args)]
pub struct SessionCreateArguments {
    #[arg(long, value_enum)]
    mode: SessionMode,
    #[arg(long, value_parser = profile_key)]
    profile_key: String,
    #[arg(long, required_if_eq("mode", "attach"))]
    workspace_id: Option<Uuid>,
    #[arg(long, required_if_eq("mode", "attach"))]
    pane_id: Option<Uuid>,
    #[arg(long, required_if_eq("mode", "attach"))]
    tab_id: Option<Uuid>,
    #[arg(long, required_if_eq("mode", "attach"))]
    browser_session_id: Option<Uuid>,
    #[arg(long, required_if_eq("mode", "attach"))]
    browser_lifecycle_id: Option<Uuid>,
    #[arg(long, required_if_eq("mode", "attach"))]
    target_window_id: Option<Uuid>,
    #[arg(
        long,
        required_if_eq("mode", "attach"),
        value_parser = positive_safe_u64
    )]
    target_window_generation: Option<u64>,
    #[arg(long)]
    idempotency_epoch: Uuid,
    #[arg(long)]
    idempotency_key: Option<Uuid>,
    #[arg(long)]
    correlation_id: Option<Uuid>,
}

#[derive(Debug, clap::Args)]
pub struct SessionArguments {
    #[arg(long)]
    automation_session_id: Uuid,
    #[arg(long, value_parser = positive_safe_u64)]
    generation: u64,
}

#[derive(Debug, clap::Args)]
pub struct OperationIdentityArguments {
    #[arg(long)]
    automation_session_id: Uuid,
    #[arg(long, value_parser = positive_safe_u64)]
    session_generation: u64,
    #[arg(long, value_parser = safe_u64)]
    navigation_epoch: u64,
    #[arg(long)]
    operation_id: Option<Uuid>,
    #[arg(long, default_value_t = 1, value_parser = positive_safe_u64)]
    attempt_epoch: u64,
    #[arg(
        long,
        default_value_t = DEFAULT_AUTOMATION_OPERATION_TIMEOUT_MS,
        value_parser = operation_timeout
    )]
    timeout_ms: u32,
    #[arg(long)]
    idempotency_epoch: Uuid,
    #[arg(long)]
    idempotency_key: Option<Uuid>,
    #[arg(long)]
    correlation_id: Option<Uuid>,
}

#[derive(Debug, clap::Args)]
pub struct OperationArguments<T: clap::Args> {
    #[command(flatten)]
    identity: OperationIdentityArguments,
    #[command(flatten)]
    arguments: T,
}

#[derive(Debug, clap::Args)]
pub struct NavigateArguments {
    #[arg(long, value_parser = safe_url)]
    url: String,
}

#[derive(Debug, Subcommand)]
pub enum WaitCommand {
    Lifecycle {
        #[arg(long, value_enum)]
        lifecycle: WaitLifecycle,
    },
    Selector {
        #[arg(long, value_parser = selector)]
        selector: String,
        #[arg(long, value_enum)]
        condition: SelectorCondition,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum WaitLifecycle {
    DomContentLoaded,
    Load,
    NetworkIdle,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum SelectorCondition {
    Attached,
    Visible,
    Hidden,
    Enabled,
}

#[derive(Debug, clap::Args)]
pub struct QueryArguments {
    #[arg(long, value_parser = selector)]
    selector: String,
    #[arg(long, default_value_t = MAX_AUTOMATION_QUERY_MATCHES, value_parser = query_limit)]
    limit: u16,
}

#[derive(Debug, clap::Args)]
pub struct SelectorArguments {
    #[arg(long, value_parser = selector)]
    selector: String,
}

#[derive(Debug, clap::Args)]
pub struct TypeArguments {
    #[arg(long, value_parser = selector)]
    selector: String,
    #[arg(long, value_parser = typed_text)]
    text: String,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Key {
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

#[derive(Debug, clap::Args)]
pub struct KeyArguments {
    #[arg(long, value_enum)]
    key: Key,
}

#[derive(Debug, clap::Args)]
pub struct KeyAtArguments {
    #[arg(long, value_parser = selector)]
    selector: String,
    #[arg(long, value_enum)]
    key: Key,
}

#[derive(Debug, clap::Args)]
pub struct ScreenshotArguments {
    #[arg(long, value_parser = screenshot_dimension)]
    width: u32,
    #[arg(long, value_parser = screenshot_dimension)]
    height: u32,
}

#[derive(Debug, clap::Args)]
pub struct CancelArguments {
    #[arg(long)]
    automation_session_id: Uuid,
    #[arg(long, value_parser = positive_safe_u64)]
    session_generation: u64,
    #[arg(long)]
    operation_id: Uuid,
    #[arg(long)]
    correlation_id: Uuid,
}

#[derive(Debug, clap::Args)]
pub struct ScreenshotHandleArguments {
    #[arg(long)]
    automation_session_id: Uuid,
    #[arg(long, value_parser = positive_safe_u64)]
    session_generation: u64,
    #[arg(long)]
    handle_id: Uuid,
}

#[derive(Debug, clap::Args)]
pub struct ScreenshotChunkArguments {
    #[command(flatten)]
    handle: ScreenshotHandleArguments,
    #[arg(long, value_parser = chunk_index)]
    chunk_index: u16,
}

pub fn command_name(command: &BrowserCommand) -> &'static str {
    let BrowserCommand::Automation { command } = command;
    match command {
        AutomationCommand::SessionCreate(_) => "browserAutomation.sessionCreate",
        AutomationCommand::SessionList => "browserAutomation.sessionList",
        AutomationCommand::SessionGet(_) => "browserAutomation.sessionGet",
        AutomationCommand::SessionDestroy(_) => "browserAutomation.sessionDestroy",
        AutomationCommand::Navigate(_)
        | AutomationCommand::Wait { .. }
        | AutomationCommand::Query(_)
        | AutomationCommand::Focus(_)
        | AutomationCommand::Click(_)
        | AutomationCommand::Type(_)
        | AutomationCommand::Key(_)
        | AutomationCommand::KeyAt(_)
        | AutomationCommand::Screenshot(_) => "browserAutomation.operationInvoke",
        AutomationCommand::Cancel(_) => "browserAutomation.operationCancel",
        AutomationCommand::ScreenshotRead(_) => "browserAutomation.screenshotRead",
        AutomationCommand::ScreenshotRelease(_) => "browserAutomation.screenshotRelease",
    }
}

pub fn validate(command: &BrowserCommand) -> Result<(), Box<dyn std::error::Error>> {
    let BrowserCommand::Automation { command } = command;
    match command {
        AutomationCommand::SessionCreate(arguments) => {
            create_target(arguments)?;
        }
        AutomationCommand::Screenshot(arguments)
            if u64::from(arguments.arguments.width) * u64::from(arguments.arguments.height)
                > MAX_AUTOMATION_SCREENSHOT_PIXELS =>
        {
            return Err("screenshot pixel count exceeds its bound".into());
        }
        _ => {}
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
pub async fn execute(
    client: &ControlClient,
    command: BrowserCommand,
) -> Result<Value, Box<dyn std::error::Error>> {
    let BrowserCommand::Automation { command } = command;
    match command {
        AutomationCommand::SessionCreate(arguments) => {
            let target = create_target(&arguments)?;
            request::<BrowserAutomationSessionCreateResult, _>(
                client,
                "browserAutomation.sessionCreate",
                BrowserAutomationSessionCreateParams {
                    mode: match arguments.mode {
                        SessionMode::Ephemeral => BrowserAutomationSessionMode::Ephemeral,
                        SessionMode::Attach => BrowserAutomationSessionMode::Attach,
                    },
                    profile_key: arguments.profile_key,
                    target,
                    idempotency: idempotency(
                        arguments.idempotency_epoch,
                        arguments.idempotency_key,
                    ),
                    correlation_id: generated(arguments.correlation_id),
                },
            )
            .await
        }
        AutomationCommand::SessionList => {
            request::<BrowserAutomationSessionListResult, _>(
                client,
                "browserAutomation.sessionList",
                json!({}),
            )
            .await
        }
        AutomationCommand::SessionGet(arguments) => {
            session_request(client, "browserAutomation.sessionGet", arguments).await
        }
        AutomationCommand::SessionDestroy(arguments) => {
            session_request(client, "browserAutomation.sessionDestroy", arguments).await
        }
        AutomationCommand::Navigate(arguments) => {
            invoke(
                client,
                arguments.identity,
                BrowserAutomationOperation::Navigate {
                    url: arguments.arguments.url,
                },
            )
            .await
        }
        AutomationCommand::Wait {
            operation,
            condition,
        } => {
            let condition = match condition {
                WaitCommand::Lifecycle { lifecycle } => BrowserAutomationWaitCondition::Lifecycle {
                    lifecycle: match lifecycle {
                        WaitLifecycle::DomContentLoaded => {
                            BrowserAutomationWaitLifecycle::DomContentLoaded
                        }
                        WaitLifecycle::Load => BrowserAutomationWaitLifecycle::Load,
                        WaitLifecycle::NetworkIdle => BrowserAutomationWaitLifecycle::NetworkIdle,
                    },
                },
                WaitCommand::Selector {
                    selector,
                    condition,
                } => BrowserAutomationWaitCondition::Selector {
                    selector,
                    condition: match condition {
                        SelectorCondition::Attached => BrowserAutomationSelectorCondition::Attached,
                        SelectorCondition::Visible => BrowserAutomationSelectorCondition::Visible,
                        SelectorCondition::Hidden => BrowserAutomationSelectorCondition::Hidden,
                        SelectorCondition::Enabled => BrowserAutomationSelectorCondition::Enabled,
                    },
                },
            };
            invoke(
                client,
                operation,
                BrowserAutomationOperation::Wait { condition },
            )
            .await
        }
        AutomationCommand::Query(arguments) => {
            invoke(
                client,
                arguments.identity,
                BrowserAutomationOperation::Query {
                    selector: arguments.arguments.selector,
                    limit: arguments.arguments.limit,
                },
            )
            .await
        }
        AutomationCommand::Focus(arguments) => {
            invoke_selector(client, arguments, |selector| {
                BrowserAutomationOperation::Focus { selector }
            })
            .await
        }
        AutomationCommand::Click(arguments) => {
            invoke_selector(client, arguments, |selector| {
                BrowserAutomationOperation::Click { selector }
            })
            .await
        }
        AutomationCommand::Type(arguments) => {
            invoke(
                client,
                arguments.identity,
                BrowserAutomationOperation::TypeText {
                    selector: arguments.arguments.selector,
                    text: arguments.arguments.text,
                },
            )
            .await
        }
        AutomationCommand::Key(arguments) => {
            invoke(
                client,
                arguments.identity,
                BrowserAutomationOperation::Key {
                    key: protocol_key(arguments.arguments.key),
                },
            )
            .await
        }
        AutomationCommand::KeyAt(arguments) => {
            invoke(
                client,
                arguments.identity,
                BrowserAutomationOperation::KeyAt {
                    selector: arguments.arguments.selector,
                    key: protocol_key(arguments.arguments.key),
                },
            )
            .await
        }
        AutomationCommand::Screenshot(arguments) => {
            let width = arguments.arguments.width;
            let height = arguments.arguments.height;
            if u64::from(width) * u64::from(height) > MAX_AUTOMATION_SCREENSHOT_PIXELS {
                return Err("screenshot pixel count exceeds its bound".into());
            }
            invoke(
                client,
                arguments.identity,
                BrowserAutomationOperation::Screenshot { width, height },
            )
            .await
        }
        AutomationCommand::Cancel(arguments) => {
            request::<BrowserAutomationOperationInvokeResult, _>(
                client,
                "browserAutomation.operationCancel",
                BrowserAutomationOperationCancelParams {
                    automation_session_id: arguments.automation_session_id.to_string(),
                    session_generation: arguments.session_generation,
                    operation_id: arguments.operation_id.to_string(),
                    correlation_id: arguments.correlation_id.to_string(),
                },
            )
            .await
        }
        AutomationCommand::ScreenshotRead(arguments) => {
            request::<BrowserAutomationScreenshotReadResult, _>(
                client,
                "browserAutomation.screenshotRead",
                BrowserAutomationScreenshotReadParams {
                    automation_session_id: arguments.handle.automation_session_id.to_string(),
                    session_generation: arguments.handle.session_generation,
                    handle_id: arguments.handle.handle_id.to_string(),
                    chunk_index: arguments.chunk_index,
                },
            )
            .await
        }
        AutomationCommand::ScreenshotRelease(arguments) => {
            request::<BrowserAutomationScreenshotReleaseResult, _>(
                client,
                "browserAutomation.screenshotRelease",
                BrowserAutomationScreenshotReleaseParams {
                    automation_session_id: arguments.automation_session_id.to_string(),
                    session_generation: arguments.session_generation,
                    handle_id: arguments.handle_id.to_string(),
                },
            )
            .await
        }
    }
}

async fn session_request(
    client: &ControlClient,
    command: &'static str,
    arguments: SessionArguments,
) -> Result<Value, Box<dyn std::error::Error>> {
    request::<BrowserAutomationSessionResult, _>(
        client,
        command,
        BrowserAutomationSessionParams {
            automation_session_id: arguments.automation_session_id.to_string(),
            generation: arguments.generation,
        },
    )
    .await
}

async fn invoke_selector<F>(
    client: &ControlClient,
    arguments: OperationArguments<SelectorArguments>,
    operation: F,
) -> Result<Value, Box<dyn std::error::Error>>
where
    F: FnOnce(String) -> BrowserAutomationOperation,
{
    invoke(
        client,
        arguments.identity,
        operation(arguments.arguments.selector),
    )
    .await
}

async fn invoke(
    client: &ControlClient,
    arguments: OperationIdentityArguments,
    operation: BrowserAutomationOperation,
) -> Result<Value, Box<dyn std::error::Error>> {
    let params = BrowserAutomationOperationInvokeParams {
        automation_session_id: arguments.automation_session_id.to_string(),
        session_generation: arguments.session_generation,
        navigation_epoch: arguments.navigation_epoch,
        operation_id: generated(arguments.operation_id),
        attempt_epoch: arguments.attempt_epoch,
        timeout_ms: arguments.timeout_ms,
        operation,
        idempotency: idempotency(arguments.idempotency_epoch, arguments.idempotency_key),
        correlation_id: generated(arguments.correlation_id),
    };
    let result = client
        .invoke_browser_automation_until_terminal(&params)
        .await?;
    terminal_output(output(
        "browserAutomation.operationInvoke",
        &to_value(result)?,
    ))
}

fn terminal_output(output: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let operation: BrowserAutomationOperationSnapshot =
        serde_json::from_value(output["result"]["operation"].clone())?;
    if let Some(exit_class) = terminal_exit_class(&operation) {
        return Err(Box::new(CliError::Terminal { output, exit_class }));
    }
    Ok(output)
}

fn terminal_exit_class(operation: &BrowserAutomationOperationSnapshot) -> Option<i32> {
    match operation.state {
        BrowserAutomationOperationState::Succeeded
        | BrowserAutomationOperationState::Queued
        | BrowserAutomationOperationState::Running => None,
        BrowserAutomationOperationState::Canceled | BrowserAutomationOperationState::Expired => {
            Some(EXIT_CANCELLATION_OR_TIMEOUT)
        }
        BrowserAutomationOperationState::Failed => Some(match operation.error_code {
            Some(
                agent_workspace_protocol::BrowserAutomationErrorCode::CapabilityUnavailable
                | agent_workspace_protocol::BrowserAutomationErrorCode::ProviderUnavailable
                | agent_workspace_protocol::BrowserAutomationErrorCode::ProviderIneligible
                | agent_workspace_protocol::BrowserAutomationErrorCode::ProviderLeaseExpired
                | agent_workspace_protocol::BrowserAutomationErrorCode::ProviderEpochMismatch
                | agent_workspace_protocol::BrowserAutomationErrorCode::AutomationBackpressure,
            ) => EXIT_PROVIDER_UNAVAILABLE,
            Some(agent_workspace_protocol::BrowserAutomationErrorCode::PolicyDenied) => {
                EXIT_AUTHORIZATION_OR_POLICY
            }
            Some(
                agent_workspace_protocol::BrowserAutomationErrorCode::SessionLimit
                | agent_workspace_protocol::BrowserAutomationErrorCode::ResourceLimit
                | agent_workspace_protocol::BrowserAutomationErrorCode::IdempotencyConflict
                | agent_workspace_protocol::BrowserAutomationErrorCode::IdempotencyExpired,
            ) => EXIT_CONFLICT,
            Some(
                agent_workspace_protocol::BrowserAutomationErrorCode::Canceled
                | agent_workspace_protocol::BrowserAutomationErrorCode::Timeout
                | agent_workspace_protocol::BrowserAutomationErrorCode::SessionExpired,
            ) => EXIT_CANCELLATION_OR_TIMEOUT,
            Some(
                agent_workspace_protocol::BrowserAutomationErrorCode::TargetRequired
                | agent_workspace_protocol::BrowserAutomationErrorCode::TargetNotFound
                | agent_workspace_protocol::BrowserAutomationErrorCode::TargetStale
                | agent_workspace_protocol::BrowserAutomationErrorCode::SessionNotFound
                | agent_workspace_protocol::BrowserAutomationErrorCode::SessionGenerationMismatch
                | agent_workspace_protocol::BrowserAutomationErrorCode::StaleNavigation
                | agent_workspace_protocol::BrowserAutomationErrorCode::InvalidOperation
                | agent_workspace_protocol::BrowserAutomationErrorCode::InvalidSelector
                | agent_workspace_protocol::BrowserAutomationErrorCode::UnsafeUrl,
            ) => EXIT_USAGE_OR_VALIDATION,
            _ => EXIT_TRANSPORT_OR_SERVICE,
        }),
        BrowserAutomationOperationState::Interrupted
        | BrowserAutomationOperationState::ResultExpired => Some(EXIT_TRANSPORT_OR_SERVICE),
    }
}

async fn request<R, P>(
    client: &ControlClient,
    command: &'static str,
    params: P,
) -> Result<Value, Box<dyn std::error::Error>>
where
    R: DeserializeOwned + Serialize,
    P: Serialize,
{
    let params = strict_value(params)?;
    let result: R = client.request(command, params).await?;
    Ok(output(command, &to_value(result)?))
}

fn strict_value<T>(value: T) -> Result<Value, serde_json::Error>
where
    T: Serialize,
{
    to_value(value)
}

fn output(command: &'static str, result: &Value) -> Value {
    json!({ "schemaVersion": OUTPUT_SCHEMA_VERSION, "command": command, "result": result })
}

fn create_target(
    arguments: &SessionCreateArguments,
) -> Result<Option<BrowserAutomationTargetBinding>, Box<dyn std::error::Error>> {
    let values = (
        arguments.workspace_id,
        arguments.pane_id,
        arguments.tab_id,
        arguments.browser_session_id,
        arguments.browser_lifecycle_id,
        arguments.target_window_id,
        arguments.target_window_generation,
    );
    match (arguments.mode, values) {
        (SessionMode::Ephemeral, (None, None, None, None, None, None, None)) => Ok(None),
        (
            SessionMode::Attach,
            (
                Some(workspace),
                Some(pane),
                Some(tab),
                Some(browser),
                Some(lifecycle),
                Some(window),
                Some(window_generation),
            ),
        ) => Ok(Some(BrowserAutomationTargetBinding {
            workspace_id: workspace.to_string(),
            pane_id: pane.to_string(),
            tab_id: tab.to_string(),
            browser_session_id: browser.to_string(),
            browser_lifecycle_id: lifecycle.to_string(),
            window: ActionInvocationTarget {
                window_id: window.to_string(),
                window_generation,
            },
        })),
        (SessionMode::Ephemeral, _) => Err("ephemeral sessions forbid an attach target".into()),
        (SessionMode::Attach, _) => Err("attach sessions require one exact target".into()),
    }
}

fn idempotency(epoch: Uuid, key: Option<Uuid>) -> ActionIdempotency {
    ActionIdempotency {
        epoch: epoch.to_string(),
        key: generated(key),
    }
}

fn generated(value: Option<Uuid>) -> String {
    value.unwrap_or_else(Uuid::new_v4).to_string()
}

fn protocol_key(key: Key) -> BrowserAutomationKey {
    match key {
        Key::Enter => BrowserAutomationKey::Enter,
        Key::Escape => BrowserAutomationKey::Escape,
        Key::Tab => BrowserAutomationKey::Tab,
        Key::ArrowUp => BrowserAutomationKey::ArrowUp,
        Key::ArrowDown => BrowserAutomationKey::ArrowDown,
        Key::ArrowLeft => BrowserAutomationKey::ArrowLeft,
        Key::ArrowRight => BrowserAutomationKey::ArrowRight,
        Key::Home => BrowserAutomationKey::Home,
        Key::End => BrowserAutomationKey::End,
        Key::PageUp => BrowserAutomationKey::PageUp,
        Key::PageDown => BrowserAutomationKey::PageDown,
        Key::Backspace => BrowserAutomationKey::Backspace,
        Key::Delete => BrowserAutomationKey::Delete,
        Key::Space => BrowserAutomationKey::Space,
    }
}

fn profile_key(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("must be 1-64 ASCII letters, digits, '-' or '_'".to_owned());
    }
    Ok(value.to_owned())
}

fn selector(value: &str) -> Result<String, String> {
    bounded_scalars(value, MAX_AUTOMATION_SELECTOR_SCALARS, "selector")
}

fn typed_text(value: &str) -> Result<String, String> {
    if value.len() > MAX_AUTOMATION_TEXT_BYTES || value.contains('\0') {
        return Err(format!(
            "must be at most {MAX_AUTOMATION_TEXT_BYTES} UTF-8 bytes without NUL"
        ));
    }
    Ok(value.to_owned())
}

fn safe_url(value: &str) -> Result<String, String> {
    bounded_scalars(value, MAX_AUTOMATION_URL_SCALARS, "URL")?;
    let parsed =
        url::Url::parse(value).map_err(|_| "must be an absolute HTTP(S) URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("must be an absolute HTTP(S) URL without credentials".to_owned());
    }
    Ok(value.to_owned())
}

fn bounded_scalars(value: &str, max: usize, label: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(format!(
            "{label} must contain 1-{max} Unicode scalars without NUL"
        ));
    }
    Ok(value.to_owned())
}

fn safe_u64(value: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| "must be a JSON-safe integer".to_owned())?;
    if parsed > JSON_SAFE_INTEGER_MAX {
        return Err("must be a JSON-safe integer".to_owned());
    }
    Ok(parsed)
}

fn positive_safe_u64(value: &str) -> Result<u64, String> {
    let parsed = safe_u64(value)?;
    if parsed == 0 {
        return Err("must be a positive JSON-safe integer".to_owned());
    }
    Ok(parsed)
}

fn operation_timeout(value: &str) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| "must be a positive timeout".to_owned())?;
    if parsed == 0 || parsed > MAX_AUTOMATION_OPERATION_TIMEOUT_MS {
        return Err(format!(
            "must be from 1 to {MAX_AUTOMATION_OPERATION_TIMEOUT_MS}"
        ));
    }
    Ok(parsed)
}

fn query_limit(value: &str) -> Result<u16, String> {
    let parsed = value
        .parse::<u16>()
        .map_err(|_| "must be a positive query limit".to_owned())?;
    if parsed == 0 || parsed > MAX_AUTOMATION_QUERY_MATCHES {
        return Err(format!("must be from 1 to {MAX_AUTOMATION_QUERY_MATCHES}"));
    }
    Ok(parsed)
}

fn screenshot_dimension(value: &str) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| "must be a positive dimension".to_owned())?;
    if parsed == 0 || parsed > MAX_AUTOMATION_SCREENSHOT_DIMENSION {
        return Err(format!(
            "must be from 1 to {MAX_AUTOMATION_SCREENSHOT_DIMENSION}"
        ));
    }
    Ok(parsed)
}

fn chunk_index(value: &str) -> Result<u16, String> {
    let parsed = value
        .parse::<u16>()
        .map_err(|_| "must be a nonnegative chunk index".to_owned())?;
    if parsed >= MAX_AUTOMATION_SCREENSHOT_CHUNKS {
        return Err(format!(
            "must be less than {MAX_AUTOMATION_SCREENSHOT_CHUNKS}"
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Arguments, Command};
    use clap::Parser as _;
    use serde_json::json;

    const SESSION: &str = "00000000-0000-4000-8000-000000000001";
    const OPERATION: &str = "00000000-0000-4000-8000-000000000002";
    const EPOCH: &str = "00000000-0000-4000-8000-000000000003";

    fn operation(command: &[&str]) -> Vec<String> {
        let mut arguments = vec!["cli", "browser", "automation"];
        arguments.extend_from_slice(command);
        arguments.extend_from_slice(&[
            "--automation-session-id",
            SESSION,
            "--session-generation",
            "1",
            "--navigation-epoch",
            "0",
            "--operation-id",
            OPERATION,
            "--idempotency-epoch",
            EPOCH,
        ]);
        arguments.into_iter().map(str::to_owned).collect()
    }

    fn browser_command(arguments: Vec<String>) -> BrowserCommand {
        let parsed = Arguments::try_parse_from(arguments).unwrap();
        let Command::Browser { command } = parsed.command else {
            panic!("expected browser command");
        };
        command
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn every_browser_automation_leaf_has_a_stable_protocol_command() {
        let create = browser_command(
            [
                "cli",
                "browser",
                "automation",
                "session-create",
                "--mode",
                "ephemeral",
                "--profile-key",
                "default",
                "--idempotency-epoch",
                EPOCH,
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        assert_eq!(command_name(&create), "browserAutomation.sessionCreate");

        let cases = [
            (vec!["session-list"], "browserAutomation.sessionList"),
            (
                vec![
                    "session-get",
                    "--automation-session-id",
                    SESSION,
                    "--generation",
                    "1",
                ],
                "browserAutomation.sessionGet",
            ),
            (
                vec![
                    "session-destroy",
                    "--automation-session-id",
                    SESSION,
                    "--generation",
                    "1",
                ],
                "browserAutomation.sessionDestroy",
            ),
            (
                vec![
                    "cancel",
                    "--automation-session-id",
                    SESSION,
                    "--session-generation",
                    "1",
                    "--operation-id",
                    OPERATION,
                    "--correlation-id",
                    EPOCH,
                ],
                "browserAutomation.operationCancel",
            ),
            (
                vec![
                    "screenshot-read",
                    "--automation-session-id",
                    SESSION,
                    "--session-generation",
                    "1",
                    "--handle-id",
                    OPERATION,
                    "--chunk-index",
                    "0",
                ],
                "browserAutomation.screenshotRead",
            ),
            (
                vec![
                    "screenshot-release",
                    "--automation-session-id",
                    SESSION,
                    "--session-generation",
                    "1",
                    "--handle-id",
                    OPERATION,
                ],
                "browserAutomation.screenshotRelease",
            ),
        ];
        for (leaf, expected) in cases {
            let mut arguments = vec!["cli", "browser", "automation"];
            arguments.extend(leaf);
            assert_eq!(
                command_name(&browser_command(
                    arguments.into_iter().map(str::to_owned).collect()
                )),
                expected
            );
        }

        let operations = [
            vec!["navigate", "--url", "https://example.test/path"],
            vec!["query", "--selector", "button", "--limit", "2"],
            vec!["focus", "--selector", "input"],
            vec!["click", "--selector", "button"],
            vec!["type", "--selector", "input", "--text", "literal"],
            vec!["key", "--key", "enter"],
            vec!["key-at", "--selector", "input", "--key", "tab"],
            vec!["screenshot", "--width", "800", "--height", "600"],
        ];
        for leaf in operations {
            assert_eq!(
                command_name(&browser_command(operation(&leaf))),
                "browserAutomation.operationInvoke"
            );
        }

        let mut wait_lifecycle = operation(&["wait"]);
        wait_lifecycle.extend([
            "lifecycle".to_owned(),
            "--lifecycle".to_owned(),
            "load".to_owned(),
        ]);
        assert_eq!(
            command_name(&browser_command(wait_lifecycle)),
            "browserAutomation.operationInvoke"
        );
        let mut wait_selector = operation(&["wait"]);
        wait_selector.extend([
            "selector".to_owned(),
            "--selector".to_owned(),
            "#ready".to_owned(),
            "--condition".to_owned(),
            "visible".to_owned(),
        ]);
        assert_eq!(
            command_name(&browser_command(wait_selector)),
            "browserAutomation.operationInvoke"
        );
    }

    #[test]
    fn unsafe_urls_bounds_and_inexact_attach_are_rejected_locally() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://u:p@example.test",
        ] {
            assert!(Arguments::try_parse_from(operation(&["navigate", "--url", url])).is_err());
        }
        assert!(
            Arguments::try_parse_from(operation(&["query", "--selector", "x", "--limit", "101"]))
                .is_err()
        );
        assert!(
            Arguments::try_parse_from(operation(&[
                "screenshot",
                "--width",
                "4097",
                "--height",
                "1"
            ]))
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "browser",
                "automation",
                "session-create",
                "--mode",
                "attach",
                "--profile-key",
                "default",
                "--idempotency-epoch",
                EPOCH,
            ])
            .is_err()
        );
        let ephemeral_with_target = Arguments::try_parse_from([
            "cli",
            "browser",
            "automation",
            "session-create",
            "--mode",
            "ephemeral",
            "--profile-key",
            "default",
            "--workspace-id",
            SESSION,
            "--idempotency-epoch",
            EPOCH,
        ])
        .unwrap();
        let Command::Browser { command } = ephemeral_with_target.command else {
            panic!()
        };
        assert!(validate(&command).is_err());
    }

    #[test]
    fn terminal_failures_keep_stable_json_and_nonzero_exit_classes() {
        let failed: BrowserAutomationOperationSnapshot = serde_json::from_value(json!({
            "automationSessionId": SESSION,
            "sessionGeneration": 1,
            "operationId": OPERATION,
            "correlationId": EPOCH,
            "attemptEpoch": 1,
            "navigationEpoch": 0,
            "state": "failed",
            "errorCode": "policy_denied",
            "updatedAtMs": 1
        }))
        .unwrap();
        assert_eq!(
            terminal_exit_class(&failed),
            Some(EXIT_AUTHORIZATION_OR_POLICY)
        );
        let canceled = BrowserAutomationOperationSnapshot {
            state: BrowserAutomationOperationState::Canceled,
            error_code: None,
            ..failed
        };
        assert_eq!(
            terminal_exit_class(&canceled),
            Some(EXIT_CANCELLATION_OR_TIMEOUT)
        );
        assert_eq!(
            output(
                "browserAutomation.screenshotRead",
                &json!({"dataBase64": "YQ=="})
            ),
            json!({
                "schemaVersion": 1,
                "command": "browserAutomation.screenshotRead",
                "result": {"dataBase64": "YQ=="}
            })
        );
    }
}

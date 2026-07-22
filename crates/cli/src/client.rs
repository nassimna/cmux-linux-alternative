use std::{path::Path, time::Duration};

use agent_workspace_notification_runtime::{CliSessionRecord, read_session_record};
use agent_workspace_protocol::{
    ActionInvocationChangedEvent, ActionInvokeParams, ActionInvokeResult, AuthEnvelope,
    AuthPayload, BrowserAutomationOperationInvokeParams, BrowserAutomationOperationInvokeResult,
    BrowserAutomationOperationState, CliWindowBindParams, EventEnvelope, MAX_CONTROL_MESSAGE_BYTES,
    RequestEnvelope, ResponseEnvelope, WindowBindResult,
};
use interprocess::local_socket::tokio::{Stream, prelude::*};
use serde::de::DeserializeOwned;
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use uuid::Uuid;

const OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const ACTION_INVOKE_TIMEOUT: Duration = Duration::from_mins(6);
const BROWSER_AUTOMATION_SESSION_CREATE_TIMEOUT: Duration = Duration::from_secs(125);
const MAX_IGNORED_EVENTS: usize = 16;
const MAX_ACTION_IGNORED_EVENTS: usize = 4_096;

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("could not load a valid CLI session")]
    Session,
    #[error("could not connect to the local service")]
    Connect,
    #[error("local control I/O failed")]
    Io,
    #[error("the local service response was invalid")]
    InvalidResponse,
    #[error("the local service rejected the request ({code}): {message}")]
    Rejected { code: String, message: String },
}

pub struct ControlClient {
    record: CliSessionRecord,
    window_id: Option<Uuid>,
}

impl ControlClient {
    pub fn discover(path: &Path) -> Result<Self, ClientError> {
        let record = read_session_record(path).map_err(|_| ClientError::Session)?;
        Ok(Self {
            record,
            window_id: None,
        })
    }

    pub fn with_window(mut self, window_id: Option<Uuid>) -> Self {
        self.window_id = window_id;
        self
    }

    pub async fn request<T: DeserializeOwned>(
        &self,
        command: &str,
        params: Value,
    ) -> Result<T, ClientError> {
        let stream = self.authenticated_stream().await?;
        let mut reader = BufReader::new(&stream);
        self.bind_window(&stream, &mut reader).await?;

        let request_id = Uuid::new_v4().to_string();
        let request = RequestEnvelope {
            id: request_id.clone(),
            command: command.to_owned(),
            params,
        };
        write_request(&stream, &request).await?;
        let response_timeout = match command {
            "action.invoke" => ACTION_INVOKE_TIMEOUT,
            // The service intentionally allows a native browser target up to two minutes to
            // provision. Keep the caller-bound socket alive through that authoritative timeout.
            "browserAutomation.sessionCreate" => BROWSER_AUTOMATION_SESSION_CREATE_TIMEOUT,
            _ => OPERATION_TIMEOUT,
        };
        parse_response(read_response(&mut reader, &request_id, false, response_timeout).await?)
    }

    /// Keep the initiating caller alive until the exact durable terminal replay is available.
    /// Dropping this future closes the socket, so the service's caller-loss cancellation remains
    /// authoritative without a separate client-side cancellation flag.
    pub async fn invoke_action_until_terminal(
        &self,
        params: &ActionInvokeParams,
    ) -> Result<ActionInvokeResult, ClientError> {
        let stream = self.authenticated_stream().await?;
        let mut reader = BufReader::new(&stream);
        self.bind_window(&stream, &mut reader).await?;
        let params = serde_json::to_value(params).map_err(|_| ClientError::Io)?;
        let correlation_id = params
            .get("correlationId")
            .and_then(Value::as_str)
            .ok_or(ClientError::InvalidResponse)?
            .to_owned();
        let (initial, terminal_observed) =
            request_action(&stream, &mut reader, &params, &correlation_id).await?;
        let mut result = parse_response::<ActionInvokeResult>(initial)?;
        if result.invocation.correlation_id != correlation_id {
            return Err(ClientError::InvalidResponse);
        }
        if result.invocation.state.is_terminal() {
            return Ok(result);
        }
        if terminal_observed {
            result = replay_action(&stream, &mut reader, &params, &correlation_id).await?;
            if result.invocation.state.is_terminal() {
                return Ok(result);
            }
        }

        loop {
            if wait_for_action_terminal(&mut reader, &result.invocation, &correlation_id).await? {
                result = replay_action(&stream, &mut reader, &params, &correlation_id).await?;
                if result.invocation.state.is_terminal() {
                    return Ok(result);
                }
            }
        }
    }

    /// Replay the exact idempotent operation on its caller-bound connection until the service's
    /// durable terminal record is visible. Replays never select a new operation or native target.
    pub async fn invoke_browser_automation_until_terminal(
        &self,
        params: &BrowserAutomationOperationInvokeParams,
    ) -> Result<BrowserAutomationOperationInvokeResult, ClientError> {
        let stream = self.authenticated_stream().await?;
        let mut reader = BufReader::new(&stream);
        self.bind_window(&stream, &mut reader).await?;
        let timeout_ms = params.timeout_ms;
        let params = serde_json::to_value(params).map_err(|_| ClientError::Io)?;
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(u64::from(timeout_ms).saturating_add(5_000));
        loop {
            let request_id = Uuid::new_v4().to_string();
            write_request(
                &stream,
                &RequestEnvelope {
                    id: request_id.clone(),
                    command: "browserAutomation.operationInvoke".to_owned(),
                    params: params.clone(),
                },
            )
            .await?;
            let result: BrowserAutomationOperationInvokeResult = parse_response(
                read_response(&mut reader, &request_id, false, OPERATION_TIMEOUT).await?,
            )?;
            if !matches!(
                result.operation.state,
                BrowserAutomationOperationState::Queued | BrowserAutomationOperationState::Running
            ) {
                return Ok(result);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ClientError::Io);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn authenticated_stream(&self) -> Result<Stream, ClientError> {
        let stream = tokio::time::timeout(OPERATION_TIMEOUT, connect(&self.record.endpoint))
            .await
            .map_err(|_| ClientError::Connect)?
            .map_err(|_| ClientError::Connect)?;
        let auth = AuthEnvelope {
            auth: AuthPayload {
                token: self.record.token.clone(),
            },
        };
        let mut wire = serde_json::to_vec(&auth).map_err(|_| ClientError::Io)?;
        wire.push(b'\n');
        let mut writer = &stream;
        tokio::time::timeout(OPERATION_TIMEOUT, writer.write_all(&wire))
            .await
            .map_err(|_| ClientError::Io)?
            .map_err(|_| ClientError::Io)?;
        Ok(stream)
    }

    async fn bind_window(
        &self,
        stream: &Stream,
        reader: &mut BufReader<&Stream>,
    ) -> Result<(), ClientError> {
        let Some(window_id) = self.window_id else {
            return Ok(());
        };
        let bind_id = Uuid::new_v4().to_string();
        let bind = RequestEnvelope {
            id: bind_id.clone(),
            command: "window.bindCli".to_owned(),
            params: serde_json::to_value(CliWindowBindParams {
                window_id: window_id.to_string(),
            })
            .map_err(|_| ClientError::Io)?,
        };
        write_request(stream, &bind).await?;
        let response = read_response(reader, &bind_id, true, OPERATION_TIMEOUT).await?;
        let bind_result = parse_response::<WindowBindResult>(response)?;
        if bind_result.window.window_id != window_id.to_string() {
            return Err(ClientError::InvalidResponse);
        }
        Ok(())
    }
}

async fn request_action(
    stream: &Stream,
    reader: &mut BufReader<&Stream>,
    params: &Value,
    correlation_id: &str,
) -> Result<(ResponseEnvelope, bool), ClientError> {
    let request_id = Uuid::new_v4().to_string();
    write_request(
        stream,
        &RequestEnvelope {
            id: request_id.clone(),
            command: "action.invoke".to_owned(),
            params: params.clone(),
        },
    )
    .await?;
    let mut terminal_observed = false;
    for _ in 0..=MAX_ACTION_IGNORED_EVENTS {
        let frame = read_frame(reader, ACTION_INVOKE_TIMEOUT).await?;
        if let Ok(response) = serde_json::from_slice::<ResponseEnvelope>(&frame) {
            if response.id != request_id {
                return Err(ClientError::InvalidResponse);
            }
            return Ok((response, terminal_observed));
        }
        let event = serde_json::from_slice::<EventEnvelope>(&frame)
            .map_err(|_| ClientError::InvalidResponse)?;
        terminal_observed |= matching_terminal_event(&event, correlation_id, None)?;
    }
    Err(ClientError::InvalidResponse)
}

async fn replay_action(
    stream: &Stream,
    reader: &mut BufReader<&Stream>,
    params: &Value,
    correlation_id: &str,
) -> Result<ActionInvokeResult, ClientError> {
    let (response, _) = request_action(stream, reader, params, correlation_id).await?;
    let result = parse_response::<ActionInvokeResult>(response)?;
    if result.invocation.correlation_id != correlation_id {
        return Err(ClientError::InvalidResponse);
    }
    Ok(result)
}

async fn wait_for_action_terminal(
    reader: &mut BufReader<&Stream>,
    invocation: &agent_workspace_protocol::ActionInvocationSnapshot,
    correlation_id: &str,
) -> Result<bool, ClientError> {
    for _ in 0..=MAX_ACTION_IGNORED_EVENTS {
        let frame = read_frame(reader, ACTION_INVOKE_TIMEOUT).await?;
        if serde_json::from_slice::<ResponseEnvelope>(&frame).is_ok() {
            return Err(ClientError::InvalidResponse);
        }
        let event = serde_json::from_slice::<EventEnvelope>(&frame)
            .map_err(|_| ClientError::InvalidResponse)?;
        if matching_terminal_event(&event, correlation_id, Some(&invocation.invocation_id))? {
            return Ok(true);
        }
        if event.event == "action.registryChanged" {
            return Ok(true);
        }
    }
    Err(ClientError::InvalidResponse)
}

fn matching_terminal_event(
    event: &EventEnvelope,
    correlation_id: &str,
    invocation_id: Option<&str>,
) -> Result<bool, ClientError> {
    if event.event != "action.invocationChanged" {
        return Ok(false);
    }
    let event: ActionInvocationChangedEvent =
        serde_json::from_value(event.data.clone()).map_err(|_| ClientError::InvalidResponse)?;
    Ok(event.correlation_id == correlation_id
        && invocation_id.is_none_or(|expected| event.invocation_id == expected)
        && event.state.is_terminal())
}

async fn write_request(stream: &Stream, request: &RequestEnvelope) -> Result<(), ClientError> {
    let mut wire = serde_json::to_vec(request).map_err(|_| ClientError::Io)?;
    wire.push(b'\n');
    let mut writer = stream;
    tokio::time::timeout(OPERATION_TIMEOUT, writer.write_all(&wire))
        .await
        .map_err(|_| ClientError::Io)?
        .map_err(|_| ClientError::Io)
}

async fn read_response(
    reader: &mut BufReader<&Stream>,
    expected_id: &str,
    strict_id: bool,
    timeout: Duration,
) -> Result<ResponseEnvelope, ClientError> {
    let ignored_event_limit = if timeout == ACTION_INVOKE_TIMEOUT {
        MAX_ACTION_IGNORED_EVENTS
    } else {
        MAX_IGNORED_EVENTS
    };
    for _ in 0..=ignored_event_limit {
        let line = read_frame(reader, timeout).await?;
        let response = match serde_json::from_slice::<ResponseEnvelope>(&line) {
            Ok(response) => response,
            Err(_) if serde_json::from_slice::<EventEnvelope>(&line).is_ok() => continue,
            Err(_) => return Err(ClientError::InvalidResponse),
        };
        if response.id != expected_id {
            if strict_id {
                return Err(ClientError::InvalidResponse);
            }
            continue;
        }
        return Ok(response);
    }
    Err(ClientError::InvalidResponse)
}

async fn read_frame(
    reader: &mut BufReader<&Stream>,
    timeout: Duration,
) -> Result<Vec<u8>, ClientError> {
    let mut bytes = Vec::new();
    let read = tokio::time::timeout(timeout, async {
        let mut bounded = reader.take(
            u64::try_from(MAX_CONTROL_MESSAGE_BYTES)
                .unwrap_or(u64::MAX)
                .saturating_add(1),
        );
        bounded.read_until(b'\n', &mut bytes).await
    })
    .await
    .map_err(|_| ClientError::Io)?
    .map_err(|_| ClientError::Io)?;
    if read == 0 || bytes.len() > MAX_CONTROL_MESSAGE_BYTES || bytes.last() != Some(&b'\n') {
        return Err(ClientError::InvalidResponse);
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    Ok(bytes)
}

fn parse_response<T: DeserializeOwned>(response: ResponseEnvelope) -> Result<T, ClientError> {
    match (response.ok, response.result, response.error) {
        (true, Some(result), None) => {
            serde_json::from_value(result).map_err(|_| ClientError::InvalidResponse)
        }
        (false, None, Some(error)) => Err(ClientError::Rejected {
            code: error.code,
            message: error.message,
        }),
        _ => Err(ClientError::InvalidResponse),
    }
}

#[cfg(unix)]
async fn connect(endpoint: &str) -> std::io::Result<Stream> {
    use interprocess::local_socket::{GenericFilePath, ToFsName as _};
    Stream::connect(endpoint.to_fs_name::<GenericFilePath>()?).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use agent_workspace_notification_runtime::{CliSessionGuard, CliSessionRecord};
    use agent_workspace_protocol::{NotificationLevel, NotificationSource};
    use interprocess::local_socket::{GenericFilePath, ListenerOptions};
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn authenticates_and_publishes_a_strict_request_to_a_mock_server() {
        let root = tempdir().unwrap();
        let endpoint = root.path().join("control.sock");
        let endpoint_string = endpoint.to_string_lossy().into_owned();
        let listener = ListenerOptions::new()
            .name(
                endpoint_string
                    .clone()
                    .to_fs_name::<GenericFilePath>()
                    .unwrap(),
            )
            .create_tokio()
            .unwrap();
        let token = "mock-control-token-with-at-least-32-bytes".to_owned();
        let session_path = root.path().join("runtime/cli-session.json");
        let _guard = CliSessionGuard::create(
            &session_path,
            &CliSessionRecord::current(endpoint_string, token.clone()),
        )
        .unwrap();

        let server = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&stream);
            let mut auth = String::new();
            let mut request = String::new();
            reader.read_line(&mut auth).await.unwrap();
            reader.read_line(&mut request).await.unwrap();
            let auth: AuthEnvelope = serde_json::from_str(auth.trim_end()).unwrap();
            assert_eq!(auth.auth.token, token);
            let request: RequestEnvelope = serde_json::from_str(request.trim_end()).unwrap();
            assert_eq!(request.command, "notification.publish");
            assert_eq!(request.params["source"], json!(NotificationSource::Cli));
            assert_eq!(request.params["level"], json!(NotificationLevel::Info));
            let response = ResponseEnvelope::success(request.id, json!({ "accepted": true }));
            let mut writer = &stream;
            writer
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        });

        let client = ControlClient::discover(&session_path).unwrap();
        let response: Value = client
            .request(
                "notification.publish",
                json!({ "source": "cli", "level": "info" }),
            )
            .await
            .unwrap();
        assert_eq!(response, json!({ "accepted": true }));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn window_binding_and_command_share_one_connection_with_distinct_ids() {
        let root = tempdir().unwrap();
        let endpoint = root.path().join("control.sock");
        let endpoint_string = endpoint.to_string_lossy().into_owned();
        let listener = ListenerOptions::new()
            .name(
                endpoint_string
                    .clone()
                    .to_fs_name::<GenericFilePath>()
                    .unwrap(),
            )
            .create_tokio()
            .unwrap();
        let token = "mock-control-token-with-at-least-32-bytes".to_owned();
        let session_path = root.path().join("runtime/cli-session.json");
        let _guard = CliSessionGuard::create(
            &session_path,
            &CliSessionRecord::current(endpoint_string, token.clone()),
        )
        .unwrap();
        let window_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();

        let server = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let auth: AuthEnvelope = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(auth.auth.token, token);

            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let bind: RequestEnvelope = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(bind.command, "window.bindCli");
            assert_eq!(bind.params, json!({ "windowId": window_id }));
            let bind_response = ResponseEnvelope::success(
                bind.id.clone(),
                json!({
                    "window": {
                        "windowId": window_id,
                        "label": "Main",
                        "workspaceIds": [workspace_id],
                        "focusedWorkspaceId": workspace_id,
                        "hostingState": "hosted",
                        "defaultTabDestination": {
                            "workspaceId": workspace_id,
                            "paneId": pane_id,
                            "destinationIndex": 0
                        },
                        "revision": 1
                    }
                }),
            );
            let mut writer = &stream;
            writer
                .write_all(
                    format!("{}\n", serde_json::to_string(&bind_response).unwrap()).as_bytes(),
                )
                .await
                .unwrap();

            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let request: RequestEnvelope = serde_json::from_str(line.trim_end()).unwrap();
            assert_ne!(request.id, bind.id);
            assert_eq!(request.command, "system.identify");
            let response = ResponseEnvelope::success(request.id, json!({ "bound": true }));
            writer
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        });

        let client = ControlClient::discover(&session_path)
            .unwrap()
            .with_window(Some(window_id));
        let response: Value = client.request("system.identify", json!({})).await.unwrap();
        assert_eq!(response, json!({ "bound": true }));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejected_window_binding_preserves_stable_error_and_stops_command() {
        for code in ["placement_required", "target_not_found"] {
            let root = tempdir().unwrap();
            let endpoint = root.path().join("control.sock");
            let endpoint_string = endpoint.to_string_lossy().into_owned();
            let listener = ListenerOptions::new()
                .name(
                    endpoint_string
                        .clone()
                        .to_fs_name::<GenericFilePath>()
                        .unwrap(),
                )
                .create_tokio()
                .unwrap();
            let session_path = root.path().join("runtime/cli-session.json");
            let _guard = CliSessionGuard::create(
                &session_path,
                &CliSessionRecord::current(
                    endpoint_string,
                    "mock-control-token-with-at-least-32-bytes".to_owned(),
                ),
            )
            .unwrap();
            let code = code.to_owned();
            let expected_code = code.clone();
            let server = tokio::spawn(async move {
                let stream = listener.accept().await.unwrap();
                let mut reader = BufReader::new(&stream);
                let mut auth = String::new();
                let mut bind = String::new();
                reader.read_line(&mut auth).await.unwrap();
                reader.read_line(&mut bind).await.unwrap();
                let bind: RequestEnvelope = serde_json::from_str(bind.trim_end()).unwrap();
                let response =
                    ResponseEnvelope::failure(bind.id, code, "Window binding was denied");
                let mut writer = &stream;
                writer
                    .write_all(
                        format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                    )
                    .await
                    .unwrap();
                assert!(read_frame(&mut reader, OPERATION_TIMEOUT).await.is_err());
            });
            let client = ControlClient::discover(&session_path)
                .unwrap()
                .with_window(Some(Uuid::new_v4()));
            let error = client
                .request::<Value>("system.identify", json!({}))
                .await
                .unwrap_err();
            assert!(matches!(error, ClientError::Rejected { code, .. } if code == expected_code));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn action_invoke_keeps_one_caller_alive_and_replays_after_terminal_event() {
        let root = tempdir().unwrap();
        let endpoint = root.path().join("control.sock");
        let endpoint_string = endpoint.to_string_lossy().into_owned();
        let listener = ListenerOptions::new()
            .name(
                endpoint_string
                    .clone()
                    .to_fs_name::<GenericFilePath>()
                    .unwrap(),
            )
            .create_tokio()
            .unwrap();
        let token = "mock-control-token-with-at-least-32-bytes".to_owned();
        let session_path = root.path().join("runtime/cli-session.json");
        let _guard = CliSessionGuard::create(
            &session_path,
            &CliSessionRecord::current(endpoint_string, token.clone()),
        )
        .unwrap();
        let invocation_id = Uuid::new_v4().to_string();
        let correlation_id = Uuid::new_v4().to_string();
        let params = ActionInvokeParams {
            action_id: "desktop.window.focus".to_owned(),
            action_version: 1,
            parameters: json!({}),
            target: None,
            idempotency: agent_workspace_protocol::ActionIdempotency {
                epoch: Uuid::new_v4().to_string(),
                key: Uuid::new_v4().to_string(),
            },
            correlation_id: correlation_id.clone(),
        };
        let expected_params = serde_json::to_value(&params).unwrap();
        let expected_invocation_id = invocation_id.clone();
        let expected_correlation_id = correlation_id.clone();

        let server = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let auth: AuthEnvelope = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(auth.auth.token, token);

            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let initial: RequestEnvelope = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(initial.command, "action.invoke");
            assert_eq!(initial.params, expected_params);
            let pending = ResponseEnvelope::success(
                initial.id.clone(),
                json!({
                    "invocation": {
                        "invocationId": expected_invocation_id.clone(),
                        "correlationId": expected_correlation_id.clone(),
                        "state": "dispatched",
                        "updatedAtMs": 1
                    }
                }),
            );
            let terminal = EventEnvelope {
                event: "action.invocationChanged".to_owned(),
                revision: None,
                data: json!({
                    "event": "action.invocationChanged",
                    "invocationId": expected_invocation_id.clone(),
                    "correlationId": expected_correlation_id.clone(),
                    "state": "acknowledged",
                    "updatedAtMs": 2
                }),
            };
            let mut writer = &stream;
            for envelope in [
                serde_json::to_value(pending).unwrap(),
                serde_json::to_value(terminal).unwrap(),
            ] {
                writer
                    .write_all(
                        format!("{}\n", serde_json::to_string(&envelope).unwrap()).as_bytes(),
                    )
                    .await
                    .unwrap();
            }

            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let replay: RequestEnvelope = serde_json::from_str(line.trim_end()).unwrap();
            assert_ne!(replay.id, initial.id);
            assert_eq!(replay.command, "action.invoke");
            assert_eq!(replay.params, expected_params);
            let result = ResponseEnvelope::success(
                replay.id,
                json!({
                    "invocation": {
                        "invocationId": expected_invocation_id,
                        "correlationId": expected_correlation_id,
                        "state": "acknowledged",
                        "terminalCode": "succeeded",
                        "result": {},
                        "updatedAtMs": 2
                    }
                }),
            );
            writer
                .write_all(format!("{}\n", serde_json::to_string(&result).unwrap()).as_bytes())
                .await
                .unwrap();
        });

        let client = ControlClient::discover(&session_path).unwrap();
        let result = client.invoke_action_until_terminal(&params).await.unwrap();
        assert_eq!(result.invocation.invocation_id, invocation_id);
        assert!(result.invocation.state.is_terminal());
        server.await.unwrap();
    }
}

#[cfg(windows)]
async fn connect(endpoint: &str) -> std::io::Result<Stream> {
    use interprocess::local_socket::{GenericNamespaced, ToNsName as _};
    Stream::connect(endpoint.to_ns_name::<GenericNamespaced>()?).await
}

//! Shared wire types for the authenticated local control protocol.

mod actions;
mod agent_sessions;
mod attention;
mod browser_automation;
mod card_slots;
mod layouts;
mod milestone2;
mod milestone3;
mod milestone5;
mod multi_window;
mod organization;
mod remote_sessions;
mod sidebar_content;

pub use actions::*;
pub use agent_sessions::*;
pub use attention::*;
pub use browser_automation::*;
pub use card_slots::*;
pub use layouts::*;
pub use milestone2::*;
pub use milestone3::*;
pub use milestone5::*;
pub use multi_window::*;
pub use organization::*;
pub use remote_sessions::*;
pub use sidebar_content::*;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Temporary application identifier, centralized for the eventual public rename.
pub const APPLICATION_ID: &str = "agent-workspace";
pub const PROTOCOL_VERSION: u32 = 1;
pub const SERVICE_READY_EVENT: &str = "service.ready";
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_TERMINAL_CHECKPOINT_WIRE_BYTES: usize = 512 * 1024;
pub const MAX_TERMINAL_LISTENING_PORTS: usize = 16;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AuthPayload {
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AuthEnvelope {
    pub auth: AuthPayload,
}

/// Stable startup record written as one JSON line to the service's standard output.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ServiceReadyRecord {
    #[ts(type = "\"service.ready\"")]
    pub event: String,
    #[ts(type = "\"agent-workspace\"")]
    pub application: String,
    pub version: String,
    pub protocol_version: u32,
}

impl ServiceReadyRecord {
    #[must_use]
    pub fn current() -> Self {
        Self {
            event: SERVICE_READY_EVENT.to_owned(),
            application: APPLICATION_ID.to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            protocol_version: PROTOCOL_VERSION,
        }
    }
}

/// Data carried by the final `service.shuttingDown` control event.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ServiceShuttingDownEvent {
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RequestEnvelope {
    pub id: String,
    pub command: String,
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    pub details: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ResponseEnvelope {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number", optional)]
    #[serde(default, deserialize_with = "optional_safe_integer")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub error: Option<ProtocolError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct IdentifyResult {
    pub application: String,
    pub version: String,
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
}

impl IdentifyResult {
    #[must_use]
    pub fn current() -> Self {
        Self {
            application: APPLICATION_ID.to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            protocol_version: PROTOCOL_VERSION,
            capabilities: [
                "system.identify",
                "terminal.create",
                "terminal.attach",
                "terminal.runtimeMetadata",
                "terminal.detach",
                "terminal.send",
                "terminal.resize",
                "terminal.checkpoint",
                "terminal.restart",
                "terminal.terminate",
                "terminal.events",
                "workspace.list",
                "workspace.snapshot",
                "workspace.cardSlots.get",
                "workspace.cardSlots.replace",
                "workspace.cardSlots.events",
                "card-slots-v1",
                "workspace.cardSlots.v2.get",
                "workspace.cardSlots.v2.replace",
                "workspace.cardSlots.v2.events",
                "card-slots-v2",
                "workspace.attention.get",
                "workspace.attention.events",
                "attention.acknowledge",
                "attention-v1",
                "workspace.create",
                "workspace.update",
                "workspace.select",
                "workspace.move",
                "workspace.close",
                "pane.split",
                "pane.focus",
                "pane.resize",
                "pane.close",
                "pane.moveTab",
                "tab.openTerminal",
                "tab.openBrowser",
                "tab.select",
                "tab.update",
                "tab.move",
                "tab.close",
                "browser.navigate",
                "browser.back",
                "browser.forward",
                "browser.reload",
                "browser.stop",
                "browser.openDevTools",
                "browser.events",
                "settings.get",
                "settings.update",
                "settings.resetKey",
                "configuration.get",
                "configuration.update",
                "configuration-v2",
                "window.getState",
                "window.updateState",
                "notification.list",
                "notification.publish",
                "notification.markRead",
                "notification.markUnread",
                "notification.clear",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TerminalCreateParams {
    #[serde(deserialize_with = "terminal_dimension")]
    pub rows: u16,
    #[serde(deserialize_with = "terminal_dimension")]
    pub cols: u16,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_absolute_path"
    )]
    pub cwd: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_command"
    )]
    pub command: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TerminalDescriptor {
    #[serde(deserialize_with = "uuid_string")]
    pub id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub process_id: Option<u32>,
    #[serde(deserialize_with = "command")]
    pub command: Vec<String>,
    #[serde(deserialize_with = "absolute_path")]
    pub cwd: String,
    #[serde(deserialize_with = "terminal_dimension")]
    pub rows: u16,
    #[serde(deserialize_with = "terminal_dimension")]
    pub cols: u16,
    pub exited: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub exit_code: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalCreateResult {
    pub terminal: TerminalDescriptor,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalAttachParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalRuntimeMetadataParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalRuntimeMetadataResult {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    #[serde(deserialize_with = "listening_ports")]
    pub listening_ports: Vec<u16>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalDetachParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalSendParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    /// Base64-encoded raw PTY input.
    pub data: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalResizeParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    #[serde(deserialize_with = "terminal_dimension")]
    pub rows: u16,
    #[serde(deserialize_with = "terminal_dimension")]
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalTerminateParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TerminalActiveBuffer {
    Normal,
    Alternate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalCheckpoint {
    #[ts(type = "number")]
    pub sequence: u64,
    pub rows: u16,
    pub cols: u16,
    pub active_buffer: TerminalActiveBuffer,
    pub data: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalCheckpointParams {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    pub checkpoint: TerminalCheckpoint,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalOutputChunk {
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub sequence: u64,
    /// Base64-encoded raw PTY output.
    pub data: String,
    #[serde(deserialize_with = "output_byte_length")]
    pub byte_length: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TerminalAttachResult {
    pub terminal: TerminalDescriptor,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_non_null"
    )]
    pub checkpoint: Option<TerminalCheckpoint>,
    pub output: Vec<TerminalOutputChunk>,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub last_sequence: u64,
    pub reconstruction_complete: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct EventEnvelope {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number", optional)]
    #[serde(default, deserialize_with = "optional_safe_integer")]
    pub revision: Option<u64>,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalOutputEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    pub chunk: TerminalOutputChunk,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalResizedEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    #[serde(deserialize_with = "terminal_dimension")]
    pub rows: u16,
    #[serde(deserialize_with = "terminal_dimension")]
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalCheckpointRequestedEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    #[ts(type = "number")]
    #[serde(deserialize_with = "safe_integer")]
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalExitedEvent {
    #[serde(deserialize_with = "uuid_string")]
    pub terminal_id: String,
    pub exit_code: u32,
    #[serde(deserialize_with = "required_nullable")]
    pub signal: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct TerminalResyncRequiredEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "optional_uuid")]
    pub terminal_id: Option<String>,
}

impl ResponseEnvelope {
    #[must_use]
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: id.into(),
            ok: true,
            revision: None,
            result: Some(result),
            error: None,
        }
    }

    #[must_use]
    pub fn failure(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            ok: false,
            revision: None,
            result: None,
            error: Some(ProtocolError {
                code: code.into(),
                message: message.into(),
                details: Value::Object(serde_json::Map::new()),
            }),
        }
    }

    /// Builds an authoritative mutation response carrying the committed revision.
    #[must_use]
    pub fn success_at_revision(id: impl Into<String>, revision: u64, result: Value) -> Self {
        Self {
            id: id.into(),
            ok: true,
            revision: Some(revision),
            result: Some(result),
            error: None,
        }
    }
}

impl<'de> Deserialize<'de> for TerminalCheckpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            sequence: u64,
            rows: u16,
            cols: u16,
            active_buffer: TerminalActiveBuffer,
            data: String,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.sequence > 9_007_199_254_740_991
            || !(1..=1_000).contains(&wire.rows)
            || !(1..=1_000).contains(&wire.cols)
        {
            return Err(serde::de::Error::custom(
                "invalid terminal checkpoint metadata",
            ));
        }
        let wire_bytes = serde_json::to_vec(&wire).map_err(serde::de::Error::custom)?;
        if wire_bytes.len() > MAX_TERMINAL_CHECKPOINT_WIRE_BYTES {
            return Err(serde::de::Error::custom(
                "serialized terminal checkpoint exceeds the wire byte cap",
            ));
        }
        Ok(Self {
            sequence: wire.sequence,
            rows: wire.rows,
            cols: wire.cols,
            active_buffer: wire.active_buffer,
            data: wire.data,
        })
    }
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom(
            "integer exceeds JavaScript safe range",
        ));
    }
    Ok(value)
}

fn optional_safe_integer<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    safe_integer(deserializer).map(Some)
}

fn optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn uuid_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    uuid::Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn optional_uuid<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    uuid_string(deserializer).map(Some)
}

fn absolute_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !value.starts_with('/') || value.contains('\0') {
        return Err(serde::de::Error::custom(
            "path must be an absolute UTF-8 path",
        ));
    }
    Ok(value)
}

fn optional_absolute_path<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    absolute_path(deserializer).map(Some)
}

fn terminal_dimension<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if !(1..=1_000).contains(&value) {
        return Err(serde::de::Error::custom(
            "terminal dimension must be within 1..=1000",
        ));
    }
    Ok(value)
}

fn listening_ports<'de, D>(deserializer: D) -> Result<Vec<u16>, D::Error>
where
    D: Deserializer<'de>,
{
    let ports = Vec::<u16>::deserialize(deserializer)?;
    if ports.len() > MAX_TERMINAL_LISTENING_PORTS
        || ports.contains(&0)
        || ports.windows(2).any(|ports| ports[0] >= ports[1])
    {
        return Err(serde::de::Error::custom(
            "listening ports must be sorted, unique, non-zero, and bounded",
        ));
    }
    Ok(ports)
}

fn command<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Vec::<String>::deserialize(deserializer)?;
    if value.is_empty()
        || value
            .iter()
            .any(|argument| argument.is_empty() || argument.contains('\0'))
    {
        return Err(serde::de::Error::custom(
            "terminal command must contain non-empty arguments",
        ));
    }
    Ok(value)
}

fn optional_command<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    command(deserializer).map(Some)
}

fn output_byte_length<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value > 64 * 1_024 {
        return Err(serde::de::Error::custom(
            "terminal output chunk exceeds its byte cap",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::json;

    fn boundary_fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/boundary-parity.json"))
            .expect("boundary fixture must be JSON")
    }

    #[derive(Deserialize)]
    struct InvalidProjectionFixture {
        cases: Vec<InvalidProjectionCase>,
    }

    #[derive(Deserialize)]
    struct InvalidProjectionCase {
        name: String,
        boundary: String,
        operations: Vec<ProjectionOperation>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", tag = "op")]
    enum ProjectionOperation {
        Set { path: String, value: Value },
        Copy { from: String, path: String },
    }

    fn apply_projection_operations(snapshot: &mut Value, operations: &[ProjectionOperation]) {
        for operation in operations {
            match operation {
                ProjectionOperation::Set { path, value } => {
                    set_projection_value(snapshot, path, value.clone());
                }
                ProjectionOperation::Copy { from, path } => {
                    let value = snapshot
                        .pointer(from)
                        .unwrap_or_else(|| panic!("missing projection fixture source: {from}"))
                        .clone();
                    set_projection_value(snapshot, path, value);
                }
            }
        }
    }

    fn set_projection_value(snapshot: &mut Value, path: &str, value: Value) {
        if let Some(parent_path) = path.strip_suffix("/-") {
            snapshot
                .pointer_mut(parent_path)
                .and_then(Value::as_array_mut)
                .unwrap_or_else(|| {
                    panic!("projection fixture append target is not an array: {path}")
                })
                .push(value);
            return;
        }
        *snapshot
            .pointer_mut(path)
            .unwrap_or_else(|| panic!("missing projection fixture target: {path}")) = value;
    }

    fn assert_deserialization<T>(value: Value, accepted: bool)
    where
        T: DeserializeOwned,
    {
        assert_eq!(serde_json::from_value::<T>(value).is_ok(), accepted);
    }

    fn assert_core_u32_fields(value: u64, accepted: bool) {
        let terminal_id = "3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30";
        assert_deserialization::<ServiceReadyRecord>(
            json!({
                "event": "service.ready",
                "application": "agent-workspace",
                "version": "0.1.0",
                "protocolVersion": value
            }),
            accepted,
        );
        assert_deserialization::<IdentifyResult>(
            json!({
                "application": "agent-workspace",
                "version": "0.1.0",
                "protocolVersion": value,
                "capabilities": []
            }),
            accepted,
        );
        let terminal = json!({
            "id": terminal_id,
            "command": ["/bin/sh"],
            "cwd": "/tmp",
            "rows": 24,
            "cols": 80,
            "exited": true
        });
        let mut with_process_id = terminal.clone();
        with_process_id["processId"] = json!(value);
        assert_deserialization::<TerminalDescriptor>(with_process_id, accepted);
        let mut with_exit_code = terminal;
        with_exit_code["exitCode"] = json!(value);
        assert_deserialization::<TerminalDescriptor>(with_exit_code, accepted);
        assert_deserialization::<TerminalExitedEvent>(
            json!({ "terminalId": terminal_id, "exitCode": value, "signal": null }),
            accepted,
        );
    }

    #[test]
    fn terminal_runtime_metadata_is_strict_sorted_unique_and_bounded() {
        let terminal_id = "3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30";
        assert_deserialization::<TerminalRuntimeMetadataParams>(
            json!({ "terminalId": terminal_id }),
            true,
        );
        assert_deserialization::<TerminalRuntimeMetadataParams>(
            json!({ "terminalId": terminal_id, "processId": 42 }),
            false,
        );
        assert_deserialization::<TerminalRuntimeMetadataResult>(
            json!({ "terminalId": terminal_id, "listeningPorts": [3000, 5173] }),
            true,
        );
        for listening_ports in [
            json!([0]),
            json!([5173, 3000]),
            json!([3000, 3000]),
            json!((1..=MAX_TERMINAL_LISTENING_PORTS + 1).collect::<Vec<_>>()),
        ] {
            assert_deserialization::<TerminalRuntimeMetadataResult>(
                json!({ "terminalId": terminal_id, "listeningPorts": listening_ports }),
                false,
            );
        }
    }

    fn assert_destination_u32_fields(value: u64, accepted: bool) {
        let workspace_id = "10000000-0000-4000-8000-000000000001";
        let pane_id = "30000000-0000-4000-8000-000000000001";
        let tab_id = "40000000-0000-4000-8000-000000000001";
        assert_deserialization::<WorkspaceMoveParams>(
            json!({ "workspaceId": workspace_id, "destinationIndex": value }),
            accepted,
        );
        let move_tab = json!({
            "workspaceId": workspace_id,
            "tabId": tab_id,
            "destinationPaneId": pane_id,
            "destinationIndex": value
        });
        assert_deserialization::<PaneMoveTabParams>(move_tab.clone(), accepted);
        assert_deserialization::<TabMoveParams>(move_tab, accepted);
        assert_deserialization::<TabOpenTerminalParams>(
            json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "destinationIndex": value,
                "launch": { "cwd": "/tmp", "rows": 24, "cols": 80 }
            }),
            accepted,
        );
        assert_deserialization::<TabOpenBrowserParams>(
            json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "destinationIndex": value,
                "metadata": { "url": "https://example.test" }
            }),
            accepted,
        );
    }

    fn revision_event(reason: impl Into<String>) -> Value {
        json!({
            "revision": 0,
            "workspaceIds": [],
            "paneIds": [],
            "tabIds": [],
            "commandIds": [],
            "reason": reason.into()
        })
    }

    #[test]
    fn identify_result_has_stable_identity_and_protocol_version() {
        let result = IdentifyResult::current();

        assert_eq!(result.application, APPLICATION_ID);
        assert_eq!(result.protocol_version, 1);
        assert!(result.capabilities.contains(&"system.identify".to_owned()));
        assert!(result.capabilities.contains(&"terminal.attach".to_owned()));
        assert!(result.capabilities.contains(&"workspace.list".to_owned()));
        assert!(result.capabilities.contains(&"pane.split".to_owned()));
        assert!(result.capabilities.contains(&"tab.openTerminal".to_owned()));
        assert!(result.capabilities.contains(&"settings.update".to_owned()));
        for capability in [
            "configuration.get",
            "configuration.update",
            "configuration-v2",
            "window.getState",
            "window.updateState",
        ] {
            assert!(result.capabilities.contains(&capability.to_owned()));
        }
        for capability in [
            "tab.openBrowser",
            "browser.navigate",
            "browser.back",
            "browser.forward",
            "browser.reload",
            "browser.stop",
            "browser.openDevTools",
            "browser.events",
        ] {
            assert!(result.capabilities.contains(&capability.to_owned()));
        }
    }

    #[test]
    fn success_envelope_omits_empty_optional_fields() {
        let response = ResponseEnvelope::success("request-1", json!({ "value": true }));
        let encoded = serde_json::to_value(response).expect("response must serialize");

        assert_eq!(
            encoded,
            json!({
                "id": "request-1",
                "ok": true,
                "result": { "value": true }
            })
        );
    }

    #[test]
    fn request_envelope_matches_the_wire_contract() {
        let request: RequestEnvelope = serde_json::from_value(json!({
            "id": "request-1",
            "command": "system.identify",
            "params": {}
        }))
        .expect("request must deserialize");

        assert_eq!(request.command, "system.identify");
        assert_eq!(request.params, json!({}));
    }

    #[test]
    fn authoritative_mutation_response_includes_revision() {
        let response = ResponseEnvelope::success_at_revision("request-2", 42, json!({}));
        let encoded = serde_json::to_value(response).expect("response must serialize");

        assert_eq!(encoded["revision"], 42);
    }

    #[test]
    fn terminal_optional_fields_are_omitted_instead_of_serialized_as_null() {
        let descriptor = TerminalDescriptor {
            id: "3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30".to_owned(),
            process_id: None,
            command: vec!["/bin/sh".to_owned()],
            cwd: "/tmp".to_owned(),
            rows: 24,
            cols: 80,
            exited: false,
            exit_code: None,
        };
        let encoded = serde_json::to_value(TerminalAttachResult {
            terminal: descriptor,
            checkpoint: None,
            output: Vec::new(),
            last_sequence: 0,
            reconstruction_complete: true,
        })
        .expect("terminal attachment must serialize");

        assert!(encoded["terminal"].get("processId").is_none());
        assert!(encoded["terminal"].get("exitCode").is_none());
        assert!(encoded.get("checkpoint").is_none());
        assert_eq!(
            serde_json::to_value(TerminalResyncRequiredEvent { terminal_id: None })
                .expect("resync event must serialize"),
            json!({})
        );
    }

    #[test]
    fn optional_non_null_terminal_fields_accept_missing_and_reject_null() {
        let terminal = json!({
            "id": "3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30",
            "command": ["/bin/sh"],
            "cwd": "/tmp",
            "rows": 24,
            "cols": 80,
            "exited": false
        });
        assert!(serde_json::from_value::<TerminalDescriptor>(terminal.clone()).is_ok());

        for field in ["processId", "exitCode"] {
            let mut with_null = terminal.clone();
            with_null[field] = Value::Null;
            assert!(serde_json::from_value::<TerminalDescriptor>(with_null).is_err());
        }

        let attachment = json!({
            "terminal": terminal,
            "output": [],
            "lastSequence": 0,
            "reconstructionComplete": true
        });
        assert!(serde_json::from_value::<TerminalAttachResult>(attachment.clone()).is_ok());

        let mut with_null_checkpoint = attachment;
        with_null_checkpoint["checkpoint"] = Value::Null;
        assert!(serde_json::from_value::<TerminalAttachResult>(with_null_checkpoint).is_err());
    }

    #[test]
    fn response_error_is_optional_non_null_while_nullable_values_remain_nullable() {
        assert!(
            serde_json::from_value::<ResponseEnvelope>(json!({
                "id": "request-1",
                "ok": true
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ResponseEnvelope>(json!({
                "id": "request-1",
                "ok": false,
                "error": null
            }))
            .is_err()
        );

        let nullable_result = ResponseEnvelope {
            id: "request-2".to_owned(),
            ok: true,
            revision: None,
            result: Some(Value::Null),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(nullable_result).expect("response must serialize")["result"],
            Value::Null
        );

        let exited = json!({
            "terminalId": "3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30",
            "exitCode": 0,
            "signal": null
        });
        assert!(serde_json::from_value::<TerminalExitedEvent>(exited).is_ok());
        assert!(
            serde_json::from_value::<TerminalExitedEvent>(json!({
                "terminalId": "3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30",
                "exitCode": 0
            }))
            .is_err()
        );
    }

    #[test]
    fn minimal_terminal_create_omits_optional_request_fields_and_rejects_null() {
        let encoded = serde_json::to_value(TerminalCreateParams {
            rows: 24,
            cols: 80,
            cwd: None,
            command: None,
        })
        .expect("terminal create request must serialize");

        assert_eq!(encoded, json!({ "rows": 24, "cols": 80 }));
        assert!(
            serde_json::from_value::<TerminalCreateParams>(
                json!({ "rows": 24, "cols": 80, "cwd": null })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<TerminalCreateParams>(
                json!({ "rows": 24, "cols": 80, "command": null })
            )
            .is_err()
        );
    }

    #[test]
    fn milestone_two_projection_fixture_round_trips_without_shape_drift() {
        let fixture = include_str!("../fixtures/milestone2-projection.json");
        let snapshot: ApplicationSnapshot =
            serde_json::from_str(fixture).expect("shared projection fixture must deserialize");

        assert_eq!(snapshot.revision, 42);
        assert_eq!(snapshot.workspaces[0].panes.len(), 2);
        assert_eq!(snapshot.workspaces[0].tabs.len(), 3);
        assert_eq!(snapshot.shortcut_overrides[1].shortcut, None);
        assert_eq!(
            serde_json::to_value(snapshot).expect("projection fixture must serialize"),
            serde_json::from_str::<Value>(fixture).expect("fixture must be valid JSON")
        );
    }

    #[test]
    fn shared_invalid_projection_vectors_are_rejected_at_rust_serde_boundaries() {
        let fixture: InvalidProjectionFixture = serde_json::from_str(include_str!(
            "../fixtures/milestone2-invalid-projections.json"
        ))
        .expect("invalid projection fixture must deserialize");
        let valid: Value =
            serde_json::from_str(include_str!("../fixtures/milestone2-projection.json"))
                .expect("valid projection fixture must be JSON");

        for case in fixture.cases {
            let mut invalid = valid.clone();
            apply_projection_operations(&mut invalid, &case.operations);
            assert!(
                serde_json::from_value::<ApplicationSnapshot>(invalid.clone()).is_err(),
                "application boundary accepted invalid projection: {}",
                case.name
            );
            if case.boundary == "workspace" {
                let workspace = invalid["workspaces"][0].clone();
                assert!(
                    serde_json::from_value::<WorkspaceSnapshot>(workspace).is_err(),
                    "workspace boundary accepted invalid projection: {}",
                    case.name
                );
            } else {
                assert_eq!(case.boundary, "application", "unknown fixture boundary");
            }
        }
    }

    #[test]
    fn mutation_result_keeps_a_js_safe_revision_in_result_and_snapshot() {
        let snapshot: ApplicationSnapshot =
            serde_json::from_str(include_str!("../fixtures/milestone2-projection.json"))
                .expect("shared projection fixture must deserialize");
        let result = MutationResult {
            revision: snapshot.revision,
            snapshot,
        };
        let encoded = serde_json::to_value(result).expect("mutation result must serialize");

        assert_eq!(encoded["revision"], 42);
        assert_eq!(encoded["snapshot"]["revision"], 42);
    }

    #[test]
    fn milestone_two_settings_fixture_preserves_default_set_and_clear_states() {
        let fixture = include_str!("../fixtures/milestone2-settings.json");
        let settings: SettingsGetResult =
            serde_json::from_str(fixture).expect("shared settings fixture must deserialize");

        assert!(matches!(
            settings.shortcuts[0].override_state,
            ShortcutOverrideState::Default
        ));
        assert!(matches!(
            settings.shortcuts[1].override_state,
            ShortcutOverrideState::Set { .. }
        ));
        assert!(matches!(
            settings.shortcuts[2].override_state,
            ShortcutOverrideState::Cleared
        ));
        assert_eq!(settings.shortcuts[2].effective_shortcut, None);
        assert_eq!(
            serde_json::to_value(settings).expect("settings fixture must serialize"),
            serde_json::from_str::<Value>(fixture).expect("fixture must be valid JSON")
        );
    }

    #[test]
    fn persisted_launch_is_commandless_but_requests_may_carry_argv() {
        let persisted = json!({ "cwd": "/tmp", "rows": 24, "cols": 80 });
        assert!(serde_json::from_value::<TerminalLaunchMetadata>(persisted.clone()).is_ok());
        assert!(
            serde_json::from_value::<TerminalLaunchMetadata>(json!({
                "cwd": "/tmp",
                "command": ["cargo", "test"],
                "rows": 24,
                "cols": 80
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TerminalLaunchRequest>(json!({
                "cwd": "/tmp",
                "command": ["cargo", "test"],
                "rows": 24,
                "cols": 80
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<TerminalLaunchRequest>(json!({
                "cwd": "/tmp",
                "command": null,
                "rows": 24,
                "cols": 80
            }))
            .is_err()
        );
    }

    #[test]
    fn browser_urls_follow_the_safe_canonical_policy() {
        for url in [
            "https://example.test/reference",
            "http://localhost:8080/path",
            "https://example.test/search?q=rust&sort=new#results",
        ] {
            assert!(
                serde_json::from_value::<BrowserPlaceholderMetadata>(json!({ "url": url })).is_ok(),
                "{url} should be accepted"
            );
        }
        for url in [
            "HTTPS://example.test",
            "https://user@example.test",
            "https://example.test\\ambiguous",
            " https://example.test",
        ] {
            assert!(
                serde_json::from_value::<BrowserPlaceholderMetadata>(json!({ "url": url }))
                    .is_err(),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn browser_session_commands_observations_and_changed_event_are_strict() {
        let workspace_id = "10000000-0000-4000-8000-000000000001";
        let tab_id = "40000000-0000-4000-8000-000000000001";
        let session_id = "50000000-0000-4000-8000-000000000001";
        let state = json!({
            "browserSessionId": session_id,
            "url": "https://example.test/search?q=rust#results",
            "navigationTitle": "Search results",
            "canBack": true,
            "canForward": false,
            "loading": false,
            "devToolsOpen": true,
            "profilePartition": "persist:workspace-1",
            "stateRevision": 7,
            "correlationId": "navigate:7"
        });

        let decoded: BrowserSessionState = serde_json::from_value(state.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), state);
        assert_deserialization::<BrowserObserveParams>(
            json!({ "workspaceId": workspace_id, "tabId": tab_id, "state": state.clone() }),
            true,
        );
        assert_deserialization::<BrowserChangedEvent>(json!({ "state": state.clone() }), true);
        assert_deserialization::<BrowserNavigateParams>(
            json!({
                "browserSessionId": session_id,
                "url": "https://example.test/next?q=1#details",
                "expectedStateRevision": 7,
                "correlationId": "navigate:8"
            }),
            true,
        );
        let value = json!({
            "browserSessionId": session_id,
            "expectedStateRevision": 7,
            "correlationId": "back:8"
        });
        assert_deserialization::<BrowserBackParams>(value.clone(), true);
        assert_deserialization::<BrowserForwardParams>(value.clone(), true);
        assert_deserialization::<BrowserReloadParams>(value.clone(), true);
        assert_deserialization::<BrowserStopParams>(value.clone(), true);
        assert_deserialization::<BrowserOpenDevToolsParams>(value, true);

        let mut nullable = state.clone();
        nullable["correlationId"] = Value::Null;
        assert_deserialization::<BrowserSessionState>(nullable, true);
        for (field, value) in [
            ("browserSessionId", json!("not-a-uuid")),
            ("url", json!("file:///tmp/private")),
            ("navigationTitle", json!("bad\ntitle")),
            ("profilePartition", json!("persist:../escape")),
            ("stateRevision", json!(9_007_199_254_740_992_u64)),
            ("correlationId", json!("navigate/7")),
        ] {
            let mut invalid = state.clone();
            invalid[field] = value;
            assert!(
                serde_json::from_value::<BrowserSessionState>(invalid).is_err(),
                "invalid {field} must be rejected"
            );
        }
    }

    #[test]
    fn wire_updates_distinguish_missing_set_and_clear_and_reject_null_no_change() {
        let workspace_id = "10000000-0000-4000-8000-000000000001";
        let missing: WorkspaceUpdateParams =
            serde_json::from_value(json!({ "workspaceId": workspace_id }))
                .expect("missing update means no change");
        assert_eq!(missing.description, None);
        let clear: WorkspaceUpdateParams = serde_json::from_value(json!({
            "workspaceId": workspace_id,
            "description": { "value": null }
        }))
        .expect("nested null means clear");
        assert_eq!(clear.description.expect("update is present").value, None);
        assert!(
            serde_json::from_value::<WorkspaceUpdateParams>(json!({
                "workspaceId": workspace_id,
                "description": null
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<NullableStringUpdate>(json!({})).is_err());
    }

    #[test]
    fn mutation_and_settings_revisions_and_catalog_are_authoritative() {
        let snapshot: Value =
            serde_json::from_str(include_str!("../fixtures/milestone2-projection.json"))
                .expect("fixture is JSON");
        assert!(
            serde_json::from_value::<MutationResult>(json!({
                "revision": 43,
                "snapshot": snapshot
            }))
            .is_err()
        );

        let mut settings: Value =
            serde_json::from_str(include_str!("../fixtures/milestone2-settings.json"))
                .expect("fixture is JSON");
        settings["shortcuts"][0]["commandId"] = json!("unknown.command");
        assert!(serde_json::from_value::<SettingsGetResult>(settings).is_err());
    }

    #[test]
    fn terminal_checkpoint_cap_is_measured_on_serialized_utf8() {
        let oversized = json!({
            "sequence": 1,
            "rows": 24,
            "cols": 80,
            "activeBuffer": "normal",
            "data": "界".repeat(MAX_TERMINAL_CHECKPOINT_WIRE_BYTES)
        });
        assert!(serde_json::from_value::<TerminalCheckpoint>(oversized).is_err());
    }

    #[test]
    fn rust_u32_fields_match_the_shared_boundary_fixture() {
        let boundary = boundary_fixture();
        let minimum = boundary["uint32"]["minimum"]
            .as_u64()
            .expect("minimum must be an integer");
        let maximum = boundary["uint32"]["maximum"]
            .as_u64()
            .expect("maximum must be an integer");
        let above_maximum = boundary["uint32"]["aboveMaximum"]
            .as_u64()
            .expect("aboveMaximum must be an integer");
        let safe_maximum = boundary["safeInteger"]["maximum"]
            .as_u64()
            .expect("safe maximum must be an integer");
        for value in [minimum, maximum] {
            assert_core_u32_fields(value, true);
            assert_destination_u32_fields(value, true);
        }

        for value in [above_maximum, safe_maximum] {
            assert_core_u32_fields(value, false);
            assert_destination_u32_fields(value, false);
        }

        // `byteLength` is also u32, but its protocol-specific 64 KiB cap is intentionally tighter.
        assert!(
            serde_json::from_value::<TerminalOutputChunk>(json!({
                "sequence": 0,
                "data": "",
                "byteLength": 64 * 1024
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<TerminalOutputChunk>(json!({
                "sequence": 0,
                "data": "",
                "byteLength": 64 * 1024 + 1
            }))
            .is_err()
        );
        for value in [maximum, above_maximum, safe_maximum] {
            assert_deserialization::<TerminalOutputChunk>(
                json!({ "sequence": 0, "data": "", "byteLength": value }),
                false,
            );
        }
    }

    #[test]
    fn safe_u64_fields_retain_the_javascript_integer_boundary() {
        let boundary = boundary_fixture();
        let values = [
            boundary["uint32"]["minimum"].as_u64().expect("integer"),
            boundary["uint32"]["maximum"].as_u64().expect("integer"),
            boundary["uint32"]["aboveMaximum"]
                .as_u64()
                .expect("integer"),
            boundary["safeInteger"]["maximum"]
                .as_u64()
                .expect("integer"),
        ];
        for value in values {
            assert!(
                serde_json::from_value::<ResponseEnvelope>(json!({
                    "id": "request-1",
                    "ok": true,
                    "revision": value
                }))
                .is_ok()
            );
            assert!(
                serde_json::from_value::<TerminalCheckpoint>(json!({
                    "sequence": value,
                    "rows": 24,
                    "cols": 80,
                    "activeBuffer": "normal",
                    "data": ""
                }))
                .is_ok()
            );
        }
        let above_safe = boundary["safeInteger"]["aboveMaximum"]
            .as_u64()
            .expect("integer");
        assert!(
            serde_json::from_value::<ResponseEnvelope>(json!({
                "id": "request-1",
                "ok": true,
                "revision": above_safe
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TerminalCheckpoint>(json!({
                "sequence": above_safe,
                "rows": 24,
                "cols": 80,
                "activeBuffer": "normal",
                "data": ""
            }))
            .is_err()
        );
    }

    #[test]
    fn normalized_text_bounds_count_unicode_scalar_values() {
        let boundary = boundary_fixture();
        let unicode = &boundary["unicode"];
        let scalar = unicode["astralScalar"].as_str().expect("astral scalar");
        let count = |key: &str| {
            usize::try_from(unicode[key].as_u64().expect("bound must be an integer"))
                .expect("bound fits usize")
        };
        let name_max = count("nameMaximumScalars");
        let title_max = count("titleMaximumScalars");
        let description_max = count("descriptionMaximumScalars");
        let color_max = count("colorMaximumScalars");
        let reason_max = count("reasonMaximumScalars");
        let create = |name: String, description: String, color: String| {
            json!({
                "name": name,
                "description": description,
                "color": color,
                "workingDirectory": "/tmp",
                "initialTerminal": {
                    "cwd": "/tmp",
                    "command": [scalar],
                    "rows": 24,
                    "cols": 80
                }
            })
        };

        assert!(
            serde_json::from_value::<WorkspaceCreateParams>(create(
                scalar.repeat(name_max),
                scalar.repeat(description_max),
                scalar.repeat(color_max)
            ))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<WorkspaceCreateParams>(create(
                scalar.repeat(name_max + 1),
                scalar.repeat(description_max),
                scalar.repeat(color_max)
            ))
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkspaceCreateParams>(create(
                scalar.repeat(name_max),
                scalar.repeat(description_max + 1),
                scalar.repeat(color_max)
            ))
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkspaceCreateParams>(create(
                scalar.repeat(name_max),
                scalar.repeat(description_max),
                scalar.repeat(color_max + 1)
            ))
            .is_err()
        );

        let update = |title: String| {
            json!({
                "workspaceId": "10000000-0000-4000-8000-000000000001",
                "tabId": "40000000-0000-4000-8000-000000000001",
                "title": title
            })
        };
        assert!(
            serde_json::from_value::<TabUpdateParams>(update(scalar.repeat(title_max))).is_ok()
        );
        assert!(
            serde_json::from_value::<TabUpdateParams>(update(scalar.repeat(title_max + 1)))
                .is_err()
        );

        assert!(
            serde_json::from_value::<RevisionEventData>(revision_event(scalar.repeat(reason_max)))
                .is_ok()
        );
        assert!(
            serde_json::from_value::<RevisionEventData>(revision_event(
                scalar.repeat(reason_max + 1)
            ))
            .is_err()
        );
        assert_deserialization::<RevisionEventData>(revision_event(String::new()), false);
        assert_deserialization::<RevisionEventData>(revision_event(format!(" {scalar}")), false);
        assert!(
            serde_json::from_value::<WorkspaceCreateParams>(create(
                format!(" {scalar}"),
                String::new(),
                scalar.to_owned()
            ))
            .is_err()
        );
    }

    #[test]
    fn normalized_text_matches_the_shared_ecmascript_trim_boundary() {
        let boundary = boundary_fixture();
        let unicode = &boundary["unicode"];
        let create = |name: String| {
            json!({
                "name": name,
                "workingDirectory": "/tmp",
                "initialTerminal": { "cwd": "/tmp", "rows": 24, "cols": 80 }
            })
        };

        for character in unicode["ecmaScriptTrimWhitespace"]
            .as_array()
            .expect("trim whitespace fixture")
        {
            let character = character.as_str().expect("trim scalar");
            assert!(
                serde_json::from_value::<WorkspaceCreateParams>(create(format!(
                    "{character}workspace{character}"
                )))
                .is_err()
            );
            assert!(
                serde_json::from_value::<WorkspaceCreateParams>(create(character.to_owned()))
                    .is_err()
            );
        }

        for character in unicode["nonTrimWhitespace"]
            .as_array()
            .expect("non-trim whitespace fixture")
        {
            let character = character.as_str().expect("non-trim scalar");
            assert!(
                serde_json::from_value::<WorkspaceCreateParams>(create(format!(
                    "{character}workspace{character}"
                )))
                .is_ok()
            );
        }
    }
}

use std::{
    env, fs,
    io::{self, Read, Write as _},
    path::{Path, PathBuf},
};

use agent_workspace_notification_runtime::{
    MAX_SECURE_FILE_BYTES, atomic_secure_json, atomic_secure_write, read_secure_json,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use toml_edit::{Array, DocumentMut, Item, Value as TomlValue};
use uuid::Uuid;

const STATE_VERSION: u32 = 1;
const MAX_HOOK_INPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Integration {
    Codex,
    Claude,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookNotice {
    pub title: String,
    pub body: Option<String>,
}

#[derive(Debug, Error)]
pub enum HookError {
    #[error("hook input is missing, malformed, or exceeds its bound")]
    InvalidInput,
    #[error("the agent configuration is malformed; no files were changed")]
    MalformedConfig,
    #[error("the managed hook conflicts with edits made after installation; refusing to overwrite")]
    Conflict,
    #[error("the hook is not installed")]
    NotInstalled,
    #[error("could not determine the user configuration directory")]
    NoHome,
    #[error("hook file operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("secure hook state operation failed")]
    State,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedState {
    version: u32,
    integration: String,
    config_path: String,
    config_existed: bool,
    managed: Value,
    prior_codex_notify: Option<String>,
    prior_claude_notification_existed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_managed_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prior_claude_managed_count: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct HookPaths {
    pub config: PathBuf,
    pub state: PathBuf,
    pub backup: PathBuf,
}

pub fn paths(integration: Integration) -> Result<HookPaths, HookError> {
    let home = home_directory().ok_or(HookError::NoHome)?;
    let state_root = env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map_or_else(|| home.join(".local/state"), PathBuf::from)
        .join("agent-workspace/hooks");
    let (config, name) = match integration {
        Integration::Codex => (home.join(".codex/config.toml"), "codex"),
        Integration::Claude => (home.join(".claude/settings.json"), "claude"),
    };
    Ok(HookPaths {
        config,
        state: state_root.join(format!("{name}.json")),
        backup: state_root.join(format!("{name}.backup")),
    })
}

pub fn parse_codex_payload(payload: &str) -> Result<HookNotice, HookError> {
    if payload.len() > MAX_HOOK_INPUT_BYTES {
        return Err(HookError::InvalidInput);
    }
    let value: Value = serde_json::from_str(payload).map_err(|_| HookError::InvalidInput)?;
    let kind = string_field(&value, &["type"]).unwrap_or("Codex");
    let body = string_field(
        &value,
        &["last-assistant-message", "last_assistant_message"],
    )
    .and_then(|text| sanitize(text, 4_096));
    Ok(HookNotice {
        title: sanitize(kind, 256).unwrap_or_else(|| "Codex notification".to_owned()),
        body,
    })
}

pub fn parse_claude_stdin(mut input: impl Read) -> Result<HookNotice, HookError> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(u64::try_from(MAX_HOOK_INPUT_BYTES).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_HOOK_INPUT_BYTES {
        return Err(HookError::InvalidInput);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HookError::InvalidInput)?;
    let title = string_field(&value, &["title", "notification_type"])
        .and_then(|text| sanitize(text, 256))
        .unwrap_or_else(|| "Claude Code notification".to_owned());
    let body = string_field(&value, &["message"]).and_then(|text| sanitize(text, 4_096));
    Ok(HookNotice { title, body })
}

pub fn install(integration: Integration, cli: &Path) -> Result<(), HookError> {
    let paths = paths(integration)?;
    install_at(integration, cli, &paths)
}

pub fn uninstall(integration: Integration) -> Result<(), HookError> {
    let paths = paths(integration)?;
    uninstall_at(integration, &paths)
}

pub fn status(integration: Integration) -> Result<&'static str, HookError> {
    let paths = paths(integration)?;
    status_at(integration, &paths)
}

fn install_at(integration: Integration, cli: &Path, paths: &HookPaths) -> Result<(), HookError> {
    let cli = cli.canonicalize()?;
    if !cli.is_absolute() {
        return Err(HookError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CLI path must be absolute",
        )));
    }
    match integration {
        Integration::Codex => install_codex(&cli, paths),
        Integration::Claude => install_claude(&cli, paths),
    }
}

fn install_codex(cli: &Path, paths: &HookPaths) -> Result<(), HookError> {
    let bytes = read_optional_config(&paths.config)?;
    let mut document = parse_toml(&bytes)?;
    let managed = codex_managed(cli);
    if paths.state.exists() {
        let state = load_state(&paths.state, Integration::Codex, &paths.config)?;
        if state.managed == managed && codex_matches(&document, &managed) {
            return Ok(());
        }
        return Err(HookError::Conflict);
    }
    let prior = document.get("notify").map(Item::to_string);
    backup_before_first_mutation(paths, &bytes)?;
    let state = ManagedState {
        version: STATE_VERSION,
        integration: "codex".to_owned(),
        config_path: paths.config.to_string_lossy().into_owned(),
        config_existed: paths.config.exists(),
        managed,
        prior_codex_notify: prior,
        prior_claude_notification_existed: false,
        claude_managed_index: None,
        prior_claude_managed_count: None,
    };
    save_state(&paths.state, &state)?;
    document["notify"] = codex_item(cli);
    write_config(&paths.config, document.to_string().as_bytes()).inspect_err(|_| {
        let _ = fs::remove_file(&paths.state);
    })
}

fn uninstall_codex(paths: &HookPaths) -> Result<(), HookError> {
    let state = load_state(&paths.state, Integration::Codex, &paths.config)?;
    let bytes = read_optional_config(&paths.config)?;
    let mut document = parse_toml(&bytes)?;
    if !codex_matches(&document, &state.managed) {
        return Err(HookError::Conflict);
    }
    if let Some(prior) = state.prior_codex_notify {
        document["notify"] = parse_toml_item(&prior)?;
    } else {
        document.remove("notify");
    }
    if !state.config_existed && document.as_table().is_empty() {
        remove_config(&paths.config)?;
    } else {
        write_config(&paths.config, document.to_string().as_bytes())?;
    }
    fs::remove_file(&paths.state)?;
    Ok(())
}

fn install_claude(cli: &Path, paths: &HookPaths) -> Result<(), HookError> {
    let bytes = read_optional_config(&paths.config)?;
    let mut document = parse_json(&bytes)?;
    let managed = claude_managed(cli);
    if paths.state.exists() {
        let state = load_state(&paths.state, Integration::Claude, &paths.config)?;
        if state.managed == managed
            && claude_entries(&document).is_ok_and(|entries| claude_matches_state(entries, &state))
        {
            return Ok(());
        }
        return Err(HookError::Conflict);
    }
    validate_claude_entries_shape(&document)?;
    backup_before_first_mutation(paths, &bytes)?;
    let prior_claude_notification_existed = document
        .get("hooks")
        .and_then(|hooks| hooks.get("Notification"))
        .is_some();
    let entries = claude_entries_mut(&mut document)?;
    let prior_claude_managed_count = entries.iter().filter(|entry| *entry == &managed).count();
    let claude_managed_index = entries.len();
    entries.push(managed.clone());
    let state = ManagedState {
        version: STATE_VERSION,
        integration: "claude".to_owned(),
        config_path: paths.config.to_string_lossy().into_owned(),
        config_existed: paths.config.exists(),
        managed,
        prior_codex_notify: None,
        prior_claude_notification_existed,
        claude_managed_index: Some(claude_managed_index),
        prior_claude_managed_count: Some(prior_claude_managed_count),
    };
    save_state(&paths.state, &state)?;
    let encoded = serde_json::to_vec_pretty(&document).map_err(|_| HookError::MalformedConfig)?;
    write_config(&paths.config, &encoded).inspect_err(|_| {
        let _ = fs::remove_file(&paths.state);
    })
}

fn uninstall_claude(paths: &HookPaths) -> Result<(), HookError> {
    let state = load_state(&paths.state, Integration::Claude, &paths.config)?;
    let bytes = read_optional_config(&paths.config)?;
    let mut document = parse_json(&bytes)?;
    let entries = claude_entries_mut(&mut document)?;
    if !claude_matches_state(entries, &state) {
        return Err(HookError::Conflict);
    }
    let index = state.claude_managed_index.unwrap_or_else(|| {
        entries
            .iter()
            .position(|entry| entry == &state.managed)
            .expect("legacy ownership validation requires exactly one managed entry")
    });
    entries.remove(index);
    if !state.prior_claude_notification_existed {
        prune_empty_owned_claude_scaffold(&mut document);
    }
    let empty = document.as_object().is_some_and(serde_json::Map::is_empty);
    if !state.config_existed && empty {
        remove_config(&paths.config)?;
    } else {
        let encoded =
            serde_json::to_vec_pretty(&document).map_err(|_| HookError::MalformedConfig)?;
        write_config(&paths.config, &encoded)?;
    }
    fs::remove_file(&paths.state)?;
    Ok(())
}

fn uninstall_at(integration: Integration, paths: &HookPaths) -> Result<(), HookError> {
    if !paths.state.exists() {
        return Err(HookError::NotInstalled);
    }
    match integration {
        Integration::Codex => uninstall_codex(paths),
        Integration::Claude => uninstall_claude(paths),
    }
}

fn status_at(integration: Integration, paths: &HookPaths) -> Result<&'static str, HookError> {
    if !paths.state.exists() {
        return Ok("not installed");
    }
    let state = load_state(&paths.state, integration, &paths.config)?;
    let bytes = read_optional_config(&paths.config)?;
    let matches = match integration {
        Integration::Codex => {
            let document = parse_toml(&bytes)?;
            codex_matches(&document, &state.managed)
        }
        Integration::Claude => claude_entries(&parse_json(&bytes)?)
            .is_ok_and(|entries| claude_matches_state(entries, &state)),
    };
    Ok(if matches { "installed" } else { "conflict" })
}

fn codex_managed(cli: &Path) -> Value {
    json!([cli.to_string_lossy(), "hook", "codex"])
}

fn codex_item(cli: &Path) -> Item {
    let mut array = Array::new();
    array.push(cli.to_string_lossy().as_ref());
    array.push("hook");
    array.push("codex");
    Item::Value(TomlValue::Array(array))
}

fn codex_matches(document: &DocumentMut, managed: &Value) -> bool {
    let Some(expected) = managed.as_array() else {
        return false;
    };
    let Some(actual) = document.get("notify").and_then(Item::as_array) else {
        return false;
    };
    actual.len() == expected.len()
        && actual.iter().zip(expected).all(|(actual, expected)| {
            actual
                .as_str()
                .is_some_and(|actual| expected.as_str() == Some(actual))
        })
}

fn claude_managed(cli: &Path) -> Value {
    json!({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": format!("{} hook claude", shell_quote(cli))
        }]
    })
}

fn shell_quote(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    return format!("\"{}\"", path.replace('"', "\\\""));
    #[cfg(not(windows))]
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn parse_toml(bytes: &[u8]) -> Result<DocumentMut, HookError> {
    if bytes.is_empty() {
        return Ok(DocumentMut::new());
    }
    std::str::from_utf8(bytes)
        .map_err(|_| HookError::MalformedConfig)?
        .parse()
        .map_err(|_| HookError::MalformedConfig)
}

fn parse_toml_item(source: &str) -> Result<Item, HookError> {
    let document: DocumentMut = format!("notify = {source}")
        .parse()
        .map_err(|_| HookError::State)?;
    document.get("notify").cloned().ok_or(HookError::State)
}

fn parse_json(bytes: &[u8]) -> Result<Value, HookError> {
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| HookError::MalformedConfig)?;
    if !value.is_object() {
        return Err(HookError::MalformedConfig);
    }
    Ok(value)
}

fn claude_entries(value: &Value) -> Result<&Vec<Value>, HookError> {
    value
        .get("hooks")
        .and_then(|hooks| hooks.get("Notification"))
        .and_then(Value::as_array)
        .ok_or(HookError::MalformedConfig)
}

fn validate_claude_entries_shape(value: &Value) -> Result<(), HookError> {
    let object = value.as_object().ok_or(HookError::MalformedConfig)?;
    let Some(hooks) = object.get("hooks") else {
        return Ok(());
    };
    let hooks = hooks.as_object().ok_or(HookError::MalformedConfig)?;
    let Some(entries) = hooks.get("Notification") else {
        return Ok(());
    };
    entries
        .as_array()
        .map(|_| ())
        .ok_or(HookError::MalformedConfig)
}

fn claude_entries_mut(value: &mut Value) -> Result<&mut Vec<Value>, HookError> {
    let object = value.as_object_mut().ok_or(HookError::MalformedConfig)?;
    let hooks = object.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or(HookError::MalformedConfig)?;
    let entries = hooks.entry("Notification").or_insert_with(|| json!([]));
    entries.as_array_mut().ok_or(HookError::MalformedConfig)
}

fn claude_matches_state(entries: &[Value], state: &ManagedState) -> bool {
    let matching_count = entries
        .iter()
        .filter(|entry| *entry == &state.managed)
        .count();
    match (state.claude_managed_index, state.prior_claude_managed_count) {
        (Some(index), Some(prior_count)) => {
            matching_count == prior_count.saturating_add(1)
                && entries.get(index) == Some(&state.managed)
        }
        // Version 1 state written before positional ownership was recorded is only
        // safe to uninstall when there is exactly one possible owned entry.
        (None, None) => matching_count == 1,
        _ => false,
    }
}

fn read_optional_config(path: &Path) -> Result<Vec<u8>, HookError> {
    if path.parent().is_some_and(Path::exists) {
        validate_config_parent(path)?;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HookError::Io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "configuration must be a regular file",
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != rustix::process::getuid().as_raw() {
            return Err(HookError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "configuration is not user-owned",
            )));
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let mut bytes = Vec::new();
    file.take(u64::try_from(MAX_SECURE_FILE_BYTES).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SECURE_FILE_BYTES {
        Err(HookError::MalformedConfig)
    } else {
        Ok(bytes)
    }
}

fn backup_before_first_mutation(paths: &HookPaths, bytes: &[u8]) -> Result<(), HookError> {
    if !paths.backup.exists() {
        atomic_secure_write(&paths.backup, bytes).map_err(|_| HookError::State)?;
    }
    Ok(())
}

fn save_state(path: &Path, state: &ManagedState) -> Result<(), HookError> {
    atomic_secure_json(path, state).map_err(|_| HookError::State)
}

fn load_state(
    path: &Path,
    integration: Integration,
    config_path: &Path,
) -> Result<ManagedState, HookError> {
    let state: ManagedState =
        read_secure_json(path, MAX_SECURE_FILE_BYTES).map_err(|_| HookError::State)?;
    let expected_integration = match integration {
        Integration::Codex => "codex",
        Integration::Claude => "claude",
    };
    let managed_is_valid = match integration {
        Integration::Codex => state.managed.as_array().is_some_and(|values| {
            values.len() == 3
                && values[0]
                    .as_str()
                    .is_some_and(|path| Path::new(path).is_absolute())
                && values[1] == "hook"
                && values[2] == "codex"
        }),
        Integration::Claude => state
            .managed
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| {
                hooks.len() == 1
                    && hooks[0].get("type") == Some(&Value::String("command".to_owned()))
                    && hooks[0]
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|command| command.ends_with(" hook claude"))
            }),
    };
    if state.version != STATE_VERSION
        || state.integration != expected_integration
        || Path::new(&state.config_path) != config_path
        || !managed_is_valid
        || (integration == Integration::Codex
            && (state.claude_managed_index.is_some() || state.prior_claude_managed_count.is_some()))
        || (state.claude_managed_index.is_some() != state.prior_claude_managed_count.is_some())
    {
        return Err(HookError::State);
    }
    Ok(state)
}

fn prune_empty_owned_claude_scaffold(document: &mut Value) {
    let Some(root) = document.as_object_mut() else {
        return;
    };
    let remove_hooks = root
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .is_some_and(|hooks| {
            if hooks
                .get("Notification")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                hooks.remove("Notification");
            }
            hooks.is_empty()
        });
    if remove_hooks {
        root.remove("hooks");
    }
}

fn remove_config(path: &Path) -> Result<(), HookError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn write_config(path: &Path, bytes: &[u8]) -> Result<(), HookError> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "configuration path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    validate_config_parent(path)?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(HookError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "configuration must be a regular file",
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if metadata.uid() != rustix::process::getuid().as_raw() {
                return Err(HookError::Io(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "configuration is not user-owned",
                )));
            }
        }
    }
    let temporary = parent.join(format!(".agent-workspace-{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })?;
    Ok(())
}

fn validate_config_parent(path: &Path) -> Result<(), HookError> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "configuration path has no parent",
        )
    })?;
    let metadata = fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(HookError::Io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "configuration directory must be a real directory",
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != rustix::process::getuid().as_raw() {
            return Err(HookError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "configuration directory is not user-owned",
            )));
        }
    }
    Ok(())
}

fn string_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

fn sanitize(value: &str, max: usize) -> Option<String> {
    let filtered: String = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect();
    (!filtered.is_empty()).then_some(filtered)
}

fn home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";
    env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_paths(root: &Path, integration: Integration) -> HookPaths {
        let name = if integration == Integration::Codex {
            "config.toml"
        } else {
            "settings.json"
        };
        HookPaths {
            config: root.join(name),
            state: root.join(format!("state-{name}.json")),
            backup: root.join(format!("backup-{name}")),
        }
    }

    fn cli(root: &Path) -> PathBuf {
        let path = root.join("agent-workspace-cli");
        fs::write(&path, b"binary").unwrap();
        path
    }

    #[test]
    fn adapters_extract_only_bounded_notification_fields() {
        let codex = parse_codex_payload(r#"{"type":"agent-turn-complete","last-assistant-message":"done","input-messages":["secret"]}"#).unwrap();
        assert_eq!(codex.body.as_deref(), Some("done"));
        let claude = parse_claude_stdin(r#"{"notification_type":"permission_prompt","message":"approve","transcript_path":"/secret"}"#.as_bytes()).unwrap();
        assert_eq!(
            claude,
            HookNotice {
                title: "permission_prompt".to_owned(),
                body: Some("approve".to_owned())
            }
        );
        assert!(parse_codex_payload(&"x".repeat(MAX_HOOK_INPUT_BYTES + 1)).is_err());
    }

    #[test]
    fn codex_install_is_idempotent_and_restores_prior_notify() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Codex);
        fs::write(&paths.config, "model = \"example\"\nnotify = [\"old\"]\n").unwrap();
        let cli = cli(root.path());
        install_at(Integration::Codex, &cli, &paths).unwrap();
        install_at(Integration::Codex, &cli, &paths).unwrap();
        assert!(!fs::read_to_string(&paths.state).unwrap().contains("token"));
        uninstall_at(Integration::Codex, &paths).unwrap();
        let restored = fs::read_to_string(&paths.config).unwrap();
        assert!(restored.contains("model = \"example\""));
        let restored: DocumentMut = restored.parse().unwrap();
        assert_eq!(
            restored["notify"]
                .as_array()
                .unwrap()
                .get(0)
                .unwrap()
                .as_str(),
            Some("old")
        );
    }

    #[test]
    fn codex_uninstall_refuses_post_install_conflict() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Codex);
        let cli = cli(root.path());
        install_at(Integration::Codex, &cli, &paths).unwrap();
        fs::write(&paths.config, "notify = [\"user-edit\"]\n").unwrap();
        assert!(matches!(
            uninstall_at(Integration::Codex, &paths),
            Err(HookError::Conflict)
        ));
    }

    #[test]
    fn claude_preserves_unrelated_hooks_and_removes_only_owned_entry() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Claude);
        fs::write(
            &paths.config,
            r#"{"theme":"dark","hooks":{"Notification":[{"matcher":"x","hooks":[]}]}}"#,
        )
        .unwrap();
        let cli = cli(root.path());
        install_at(Integration::Claude, &cli, &paths).unwrap();
        install_at(Integration::Claude, &cli, &paths).unwrap();
        uninstall_at(Integration::Claude, &paths).unwrap();
        let value: Value = serde_json::from_slice(&fs::read(&paths.config).unwrap()).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["hooks"]["Notification"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn claude_preserves_a_preexisting_identical_entry() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Claude);
        let cli = cli(root.path());
        let managed = claude_managed(&cli);
        let original = json!({
            "theme": "dark",
            "hooks": {
                "Notification": [
                    {"matcher": "before", "hooks": []},
                    managed,
                    {"matcher": "after", "hooks": []}
                ]
            }
        });
        fs::write(&paths.config, serde_json::to_vec_pretty(&original).unwrap()).unwrap();

        install_at(Integration::Claude, &cli, &paths).unwrap();
        let installed: Value = serde_json::from_slice(&fs::read(&paths.config).unwrap()).unwrap();
        assert_eq!(
            installed["hooks"]["Notification"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| *entry == &claude_managed(&cli))
                .count(),
            2
        );

        uninstall_at(Integration::Claude, &paths).unwrap();
        let restored: Value = serde_json::from_slice(&fs::read(&paths.config).unwrap()).unwrap();
        assert_eq!(restored, original);
    }

    #[test]
    fn claude_duplicate_added_after_install_is_a_conflict() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Claude);
        let cli = cli(root.path());
        install_at(Integration::Claude, &cli, &paths).unwrap();

        let mut edited: Value = serde_json::from_slice(&fs::read(&paths.config).unwrap()).unwrap();
        claude_entries_mut(&mut edited)
            .unwrap()
            .push(claude_managed(&cli));
        let edited = serde_json::to_vec_pretty(&edited).unwrap();
        fs::write(&paths.config, &edited).unwrap();

        assert_eq!(status_at(Integration::Claude, &paths).unwrap(), "conflict");
        assert!(matches!(
            install_at(Integration::Claude, &cli, &paths),
            Err(HookError::Conflict)
        ));
        assert!(matches!(
            uninstall_at(Integration::Claude, &paths),
            Err(HookError::Conflict)
        ));
        assert_eq!(fs::read(&paths.config).unwrap(), edited);
        assert!(paths.state.exists());
    }

    #[test]
    fn claude_repeated_install_does_not_add_an_entry() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Claude);
        let cli = cli(root.path());

        install_at(Integration::Claude, &cli, &paths).unwrap();
        let once = fs::read(&paths.config).unwrap();
        let state_once = fs::read(&paths.state).unwrap();
        install_at(Integration::Claude, &cli, &paths).unwrap();

        assert_eq!(fs::read(&paths.config).unwrap(), once);
        assert_eq!(fs::read(&paths.state).unwrap(), state_once);
        let installed: Value = serde_json::from_slice(&once).unwrap();
        assert_eq!(claude_entries(&installed).unwrap().len(), 1);
    }

    #[test]
    fn legacy_claude_state_is_only_removed_when_ownership_is_unambiguous() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Claude);
        let cli = cli(root.path());
        install_at(Integration::Claude, &cli, &paths).unwrap();
        let mut legacy: Value = serde_json::from_slice(&fs::read(&paths.state).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("claudeManagedIndex");
        legacy
            .as_object_mut()
            .unwrap()
            .remove("priorClaudeManagedCount");
        atomic_secure_json(&paths.state, &legacy).unwrap();

        uninstall_at(Integration::Claude, &paths).unwrap();
        assert!(!paths.config.exists());

        let paths = test_paths(root.path(), Integration::Claude);
        let original = json!({"hooks": {"Notification": [claude_managed(&cli)]}});
        fs::write(&paths.config, serde_json::to_vec(&original).unwrap()).unwrap();
        install_at(Integration::Claude, &cli, &paths).unwrap();
        let mut legacy: Value = serde_json::from_slice(&fs::read(&paths.state).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("claudeManagedIndex");
        legacy
            .as_object_mut()
            .unwrap()
            .remove("priorClaudeManagedCount");
        atomic_secure_json(&paths.state, &legacy).unwrap();
        assert!(matches!(
            uninstall_at(Integration::Claude, &paths),
            Err(HookError::Conflict)
        ));
    }

    #[test]
    fn malformed_config_is_not_mutated_or_backed_up() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Claude);
        fs::write(&paths.config, b"{").unwrap();
        let cli = cli(root.path());
        assert!(matches!(
            install_at(Integration::Claude, &cli, &paths),
            Err(HookError::MalformedConfig)
        ));
        assert_eq!(fs::read(&paths.config).unwrap(), b"{");
        assert!(!paths.backup.exists());
        assert!(!paths.state.exists());
    }

    #[test]
    fn malformed_claude_hook_shapes_are_not_mutated_or_backed_up() {
        for malformed in [
            br#"{"theme":"dark","hooks":[]}"#.as_slice(),
            br#"{"theme":"dark","hooks":{"Notification":{}}}"#.as_slice(),
        ] {
            let root = tempdir().unwrap();
            let paths = test_paths(root.path(), Integration::Claude);
            fs::write(&paths.config, malformed).unwrap();
            let cli = cli(root.path());

            assert!(matches!(
                install_at(Integration::Claude, &cli, &paths),
                Err(HookError::MalformedConfig)
            ));
            assert_eq!(fs::read(&paths.config).unwrap(), malformed);
            assert!(!paths.backup.exists());
            assert!(!paths.state.exists());
        }
    }

    #[test]
    fn uninstall_restores_absent_config_for_both_integrations() {
        let root = tempdir().unwrap();
        let cli = cli(root.path());
        for integration in [Integration::Codex, Integration::Claude] {
            let paths = test_paths(root.path(), integration);
            assert!(!paths.config.exists());
            install_at(integration, &cli, &paths).unwrap();
            assert!(paths.config.exists());
            uninstall_at(integration, &paths).unwrap();
            assert!(!paths.config.exists());
        }
    }

    #[test]
    fn mismatched_managed_state_is_rejected_without_mutation() {
        let root = tempdir().unwrap();
        let paths = test_paths(root.path(), Integration::Codex);
        let cli = cli(root.path());
        install_at(Integration::Codex, &cli, &paths).unwrap();
        let before = fs::read(&paths.config).unwrap();
        let mut state: Value = serde_json::from_slice(&fs::read(&paths.state).unwrap()).unwrap();
        state["integration"] = Value::String("claude".to_owned());
        atomic_secure_json(&paths.state, &state).unwrap();
        assert!(matches!(
            uninstall_at(Integration::Codex, &paths),
            Err(HookError::State)
        ));
        assert_eq!(fs::read(&paths.config).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn install_refuses_a_symlinked_configuration_directory() {
        let root = tempdir().unwrap();
        let real = root.path().join("real");
        fs::create_dir(&real).unwrap();
        let linked = root.path().join("linked");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        let paths = HookPaths {
            config: linked.join("config.toml"),
            state: root.path().join("state/codex.json"),
            backup: root.path().join("state/codex.backup"),
        };
        let cli = cli(root.path());
        assert!(matches!(
            install_at(Integration::Codex, &cli, &paths),
            Err(HookError::Io(_))
        ));
        assert!(!paths.config.exists());
    }
}

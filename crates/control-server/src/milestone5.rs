use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use agent_workspace_config::{
    AppConfig, BrowserConfig, ConfigStore, Density, LogLevel, PrivacyBehavior, ShortcutOverride,
    Theme, UpdateChannel as ConfigUpdateChannel,
};
use agent_workspace_core::{
    ApplicationState, CommandId, DomainError, LogicalShortcut, MAX_SAFE_INTEGER, MutationOutcome,
    NotificationSettings as CoreNotificationSettings, ShortcutPlatform,
};
use agent_workspace_protocol::{
    AgentIntegrationConfiguration, AppearanceConfiguration, BrowserConfiguration, BrowserPrivacy,
    ConfigurationDensity, ConfigurationGetResult, ConfigurationSnapshot, ConfigurationTheme,
    ConfigurationUpdate, ConfigurationUpdateParams, EmptyParams, KeyboardShortcutConfiguration,
    LoggingConfiguration, LoggingLevel, NotificationConfiguration, ResponseEnvelope,
    TerminalConfiguration, UpdateChannel, UpdateConfiguration, WindowStateGetResult,
    WindowStateSnapshot, WindowStateUpdateParams,
};
use agent_workspace_runtime::{
    LaunchOptions, OperationFailure, ProductionWorkspaceRuntime, RuntimeError,
    TerminalManagerBackend,
};
use agent_workspace_storage::{SqliteStateStore, StorageError, WindowState};
use serde::{Serialize, de::DeserializeOwned};
use tokio::task::JoinError;
use tracing::warn;

use super::{ControlContext, LoggingRuntime, PersistenceServices};

pub(super) const CAPABILITIES: &[&str] = &[
    "configuration.get",
    "configuration.update",
    "window.getState",
    "window.updateState",
];

pub(super) fn is_command(command: &str) -> bool {
    CAPABILITIES.contains(&command)
}

pub(super) async fn dispatch(
    id: String,
    command: &str,
    params: serde_json::Value,
    context: &ControlContext,
) -> ResponseEnvelope {
    let Some(persistence) = context.persistence.clone() else {
        return unknown(id, command);
    };
    let Some(runtime) = context.runtime.clone() else {
        return unknown(id, command);
    };
    if matches!(command, "window.getState" | "window.updateState")
        && runtime.snapshot().await.window_placements.len() != 1
    {
        return ResponseEnvelope::failure(
            id,
            "placement_required",
            "Legacy window state is available only for a single placement",
        );
    }
    match command {
        "configuration.get" => {
            if let Err(response) = parse::<EmptyParams>(&id, params) {
                return *response;
            }
            configuration_get(id, runtime, persistence).await
        }
        "configuration.update" => {
            let params = match parse::<ConfigurationUpdateParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            configuration_update(
                id,
                runtime,
                persistence,
                context.terminal_backend.clone(),
                context.logging_runtime.clone(),
                context.platform,
                params,
            )
            .await
        }
        "window.getState" => {
            if let Err(response) = parse::<EmptyParams>(&id, params) {
                return *response;
            }
            window_get_state(id, persistence).await
        }
        "window.updateState" => {
            let params = match parse::<WindowStateUpdateParams>(&id, params) {
                Ok(params) => params,
                Err(response) => return *response,
            };
            window_update_state(id, persistence, params).await
        }
        _ => unknown(id, command),
    }
}

fn parse<T: DeserializeOwned>(
    id: &str,
    params: serde_json::Value,
) -> Result<T, Box<ResponseEnvelope>> {
    serde_json::from_value(params).map_err(|_| {
        Box::new(ResponseEnvelope::failure(
            id,
            "invalid_params",
            "The request parameters do not match the command contract",
        ))
    })
}

fn unknown(id: String, command: &str) -> ResponseEnvelope {
    ResponseEnvelope::failure(id, "unknown_command", format!("Unknown command: {command}"))
}

async fn configuration_get(
    id: String,
    runtime: Arc<ProductionWorkspaceRuntime>,
    persistence: PersistenceServices,
) -> ResponseEnvelope {
    let failure_id = id.clone();
    match tokio::spawn(configuration_get_inner(id, runtime, persistence)).await {
        Ok(response) => response,
        Err(_) => operation_task_failure(failure_id),
    }
}

async fn configuration_get_inner(
    id: String,
    runtime: Arc<ProductionWorkspaceRuntime>,
    persistence: PersistenceServices,
) -> ResponseEnvelope {
    let _guard = persistence.configuration_lock.lock().await;
    let state = runtime.snapshot().await;
    let Ok(mut config) = load_config(Arc::clone(&persistence.config_store)).await else {
        return configuration_storage_failure(id);
    };
    if reconcile_runtime_settings(&mut config, &state) {
        let Some(revision) = next_revision(config.revision) else {
            return revision_overflow(id);
        };
        config.revision = revision;
        if save_config(Arc::clone(&persistence.config_store), config.clone())
            .await
            .is_err()
        {
            return configuration_storage_failure(id);
        }
    }
    configuration_success(id, &config)
}

async fn configuration_update(
    id: String,
    runtime: Arc<ProductionWorkspaceRuntime>,
    persistence: PersistenceServices,
    terminal_backend: Option<TerminalManagerBackend>,
    logging_runtime: Option<LoggingRuntime>,
    platform: ShortcutPlatform,
    params: ConfigurationUpdateParams,
) -> ResponseEnvelope {
    let failure_id = id.clone();
    match tokio::spawn(configuration_update_inner(
        id,
        runtime,
        persistence,
        terminal_backend,
        logging_runtime,
        platform,
        params,
    ))
    .await
    {
        Ok(response) => response,
        Err(_) => operation_task_failure(failure_id),
    }
}

async fn configuration_update_inner(
    id: String,
    runtime: Arc<ProductionWorkspaceRuntime>,
    persistence: PersistenceServices,
    terminal_backend: Option<TerminalManagerBackend>,
    logging_runtime: Option<LoggingRuntime>,
    platform: ShortcutPlatform,
    params: ConfigurationUpdateParams,
) -> ResponseEnvelope {
    let _guard = persistence.configuration_lock.lock().await;
    let runtime_before = runtime.snapshot().await;
    let Ok(original) = load_config(Arc::clone(&persistence.config_store)).await else {
        return configuration_storage_failure(id);
    };
    if original.revision != params.expected_revision {
        return revision_conflict(id);
    }

    let mut candidate = original.clone();
    reconcile_runtime_settings(&mut candidate, &runtime_before);
    let touches_runtime =
        params.update.notifications.is_some() || params.update.keyboard_shortcuts.is_some();
    apply_configuration_update(&mut candidate, params.update);
    let shell_changed = candidate.terminal.shell_path != original.terminal.shell_path;
    let terminal_backend = if shell_changed {
        let Some(terminal_backend) = terminal_backend else {
            return consistency_failure(id);
        };
        if terminal_backend
            .validate_configured_shell(candidate.terminal.shell_path.as_deref().map(Path::new))
            .is_err()
        {
            return invalid_configuration(id);
        }
        Some(terminal_backend)
    } else {
        None
    };
    let logging_runtime = if candidate.logging.level == original.logging.level {
        None
    } else {
        let Some(logging_runtime) = logging_runtime else {
            return consistency_failure(id);
        };
        Some(logging_runtime)
    };
    let Some(revision) = next_revision(original.revision) else {
        return revision_overflow(id);
    };
    candidate.revision = revision;

    let desired_notifications = core_notifications(&candidate);
    let Ok(desired_shortcuts) = core_shortcuts(&candidate) else {
        return invalid_configuration(id);
    };
    if touches_runtime {
        let mut validation = runtime_before.clone();
        validation.notification_settings = desired_notifications;
        validation.shortcut_overrides.clone_from(&desired_shortcuts);
        if validation
            .validate_shortcut_overrides_for(platform)
            .is_err()
        {
            return invalid_configuration(id);
        }
    }

    if save_config(Arc::clone(&persistence.config_store), candidate.clone())
        .await
        .is_err()
    {
        return configuration_storage_failure(id);
    }

    if touches_runtime
        && (runtime_before.notification_settings != desired_notifications
            || runtime_before.shortcut_overrides != desired_shortcuts)
    {
        let runtime_result = runtime
            .mutate(LaunchOptions::default(), move |state| {
                replace_runtime_settings(state, desired_notifications, desired_shortcuts, platform)
            })
            .await;
        if let Err(failure) = runtime_result {
            if save_config(Arc::clone(&persistence.config_store), original)
                .await
                .is_err()
            {
                warn!("configuration/runtime compensation failed after runtime rejection");
                return consistency_failure(id);
            }
            return runtime_failure(id, &failure);
        }
    }
    if let Some(terminal_backend) = terminal_backend {
        terminal_backend
            .set_configured_shell(candidate.terminal.shell_path.clone().map(PathBuf::from));
    }
    if let Some(logging_runtime) = logging_runtime {
        logging_runtime.set_level(candidate.logging.level);
    }
    configuration_success(id, &candidate)
}

fn replace_runtime_settings(
    state: &mut ApplicationState,
    notifications: CoreNotificationSettings,
    shortcuts: BTreeMap<CommandId, Option<LogicalShortcut>>,
    platform: ShortcutPlatform,
) -> Result<MutationOutcome, DomainError> {
    state.notification_settings = notifications;
    state.shortcut_overrides = shortcuts;
    state.validate_shortcut_overrides_for(platform)?;
    state.revision = state
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
        .ok_or(DomainError::RevisionOverflow)?;
    Ok(MutationOutcome {
        revision: state.revision,
        terminal_launches: Vec::new(),
        terminal_sessions_to_terminate: Vec::new(),
    })
}

async fn window_get_state(id: String, persistence: PersistenceServices) -> ResponseEnvelope {
    let failure_id = id.clone();
    match tokio::spawn(window_get_state_inner(id, persistence)).await {
        Ok(response) => response,
        Err(_) => operation_task_failure(failure_id),
    }
}

async fn window_get_state_inner(id: String, persistence: PersistenceServices) -> ResponseEnvelope {
    let _guard = persistence.window_state_lock.lock().await;
    match load_window_state(Arc::clone(&persistence.state_store)).await {
        Ok(state) => {
            let revision = state.as_ref().map(|state| state.revision);
            let Ok(state) = state.map(window_snapshot).transpose() else {
                return storage_failure(id);
            };
            let result = WindowStateGetResult { state };
            serialized_success(id, revision, result)
        }
        Err(()) => storage_failure(id),
    }
}

async fn window_update_state(
    id: String,
    persistence: PersistenceServices,
    params: WindowStateUpdateParams,
) -> ResponseEnvelope {
    let failure_id = id.clone();
    match tokio::spawn(window_update_state_inner(id, persistence, params)).await {
        Ok(response) => response,
        Err(_) => operation_task_failure(failure_id),
    }
}

async fn window_update_state_inner(
    id: String,
    persistence: PersistenceServices,
    params: WindowStateUpdateParams,
) -> ResponseEnvelope {
    let _guard = persistence.window_state_lock.lock().await;
    let state = stored_window_state(params.state);
    let revision = state.revision;
    match save_window_state(Arc::clone(&persistence.state_store), state.clone()).await {
        Ok(()) => serialized_success(
            id,
            Some(revision),
            WindowStateGetResult {
                state: Some(
                    window_snapshot(state)
                        .expect("strict protocol input remains valid protocol output"),
                ),
            },
        ),
        Err(
            StorageError::StaleWindowStateRevision { .. }
            | StorageError::WindowStateRevisionConflict { .. },
        ) => revision_conflict(id),
        Err(StorageError::InvalidWindowState { .. }) => invalid_window_state(id),
        Err(_) => storage_failure(id),
    }
}

async fn load_config(store: Arc<ConfigStore>) -> Result<AppConfig, ()> {
    tokio::task::spawn_blocking(move || store.load().map_err(|_| ()))
        .await
        .map_err(ignore_join_error)?
}

async fn save_config(store: Arc<ConfigStore>, config: AppConfig) -> Result<(), ()> {
    tokio::task::spawn_blocking(move || store.save(&config).map_err(|_| ()))
        .await
        .map_err(ignore_join_error)?
}

async fn load_window_state(store: Arc<SqliteStateStore>) -> Result<Option<WindowState>, ()> {
    tokio::task::spawn_blocking(move || store.load_window_state().map_err(|_| ()))
        .await
        .map_err(ignore_join_error)?
}

async fn save_window_state(
    store: Arc<SqliteStateStore>,
    state: WindowState,
) -> Result<(), StorageError> {
    tokio::task::spawn_blocking(move || store.save_window_state(&state))
        .await
        .map_err(|_| storage_worker_error())?
}

fn ignore_join_error(_: JoinError) {}

fn storage_worker_error() -> StorageError {
    StorageError::WindowStateRevisionMismatch {
        message: "window-state storage worker failed".to_owned(),
    }
}

fn next_revision(revision: u64) -> Option<u64> {
    revision
        .checked_add(1)
        .filter(|revision| *revision <= agent_workspace_config::MAX_SAFE_REVISION)
}

fn reconcile_runtime_settings(config: &mut AppConfig, state: &ApplicationState) -> bool {
    let notifications = core_notifications_from_state(state);
    let shortcuts = config_shortcuts_from_state(state);
    let changed = config.notifications.system_enabled != notifications.system_enabled
        || config.notifications.include_body != notifications.include_body
        || config.keyboard_shortcuts.overrides != shortcuts;
    config.notifications.system_enabled = notifications.system_enabled;
    config.notifications.include_body = notifications.include_body;
    config.keyboard_shortcuts.overrides = shortcuts;
    changed
}

fn core_notifications(config: &AppConfig) -> CoreNotificationSettings {
    CoreNotificationSettings {
        system_enabled: config.notifications.system_enabled,
        include_body: config.notifications.include_body,
    }
}

fn core_notifications_from_state(state: &ApplicationState) -> CoreNotificationSettings {
    state.notification_settings
}

fn config_shortcuts_from_state(state: &ApplicationState) -> BTreeMap<String, ShortcutOverride> {
    state
        .shortcut_overrides
        .iter()
        .map(|(command, shortcut)| {
            (
                command.as_str().to_owned(),
                shortcut
                    .as_ref()
                    .map_or(ShortcutOverride::Cleared, |value| {
                        ShortcutOverride::Set(value.as_str().to_owned())
                    }),
            )
        })
        .collect()
}

fn core_shortcuts(
    config: &AppConfig,
) -> Result<BTreeMap<CommandId, Option<LogicalShortcut>>, DomainError> {
    config
        .keyboard_shortcuts
        .overrides
        .iter()
        .map(|(command, shortcut)| {
            let command = CommandId::new(command.clone())?;
            let shortcut = match shortcut {
                ShortcutOverride::Set(value) => Some(LogicalShortcut::new(value.clone())?),
                ShortcutOverride::Cleared => None,
            };
            Ok((command, shortcut))
        })
        .collect()
}

fn apply_configuration_update(config: &mut AppConfig, update: ConfigurationUpdate) {
    if let Some(value) = update.appearance {
        config.appearance.theme = match value.theme {
            ConfigurationTheme::System => Theme::System,
            ConfigurationTheme::Dark => Theme::Dark,
            ConfigurationTheme::Light => Theme::Light,
        };
        config.appearance.density = match value.density {
            ConfigurationDensity::Compact => Density::Compact,
            ConfigurationDensity::Comfortable => Density::Comfortable,
            ConfigurationDensity::Expanded => Density::Expanded,
        };
        config.appearance.font_family = value.font_family;
    }
    if let Some(value) = update.terminal {
        config.terminal.shell_path = value.shell_path;
        config.terminal.font_family = value.font_family;
        config.terminal.font_size = value.font_size;
        config.terminal.scrollback = value.scrollback;
        config.terminal.multiline_paste_protection = value.multiline_paste_protection;
    }
    if let Some(value) = update.browser {
        config.browser.profile_name = value.profile_name;
        config.browser.partition = value.partition;
        config.browser.privacy = match value.privacy {
            BrowserPrivacy::Standard => PrivacyBehavior::Standard,
            BrowserPrivacy::Strict => PrivacyBehavior::Strict,
        };
    }
    if let Some(value) = update.notifications {
        config.notifications.system_enabled = value.system_enabled;
        config.notifications.include_body = value.include_body;
    }
    if let Some(value) = update.keyboard_shortcuts {
        config.keyboard_shortcuts.overrides = value
            .overrides
            .into_iter()
            .map(|(command, shortcut)| {
                (
                    command,
                    shortcut.map_or(ShortcutOverride::Cleared, ShortcutOverride::Set),
                )
            })
            .collect();
    }
    if let Some(value) = update.agent_integration {
        config.agent_integration.enabled = value.enabled;
        config.agent_integration.notifications_enabled = value.notifications_enabled;
        config.agent_integration.browser_enabled = value.browser_enabled;
    }
    if let Some(value) = update.updates {
        config.updates.channel = match value.channel {
            UpdateChannel::Stable => ConfigUpdateChannel::Stable,
            UpdateChannel::Beta => ConfigUpdateChannel::Beta,
        };
    }
    if let Some(value) = update.logging {
        config.logging.level = match value.level {
            LoggingLevel::Error => LogLevel::Error,
            LoggingLevel::Warn => LogLevel::Warn,
            LoggingLevel::Info => LogLevel::Info,
            LoggingLevel::Debug => LogLevel::Debug,
            LoggingLevel::Trace => LogLevel::Trace,
        };
    }
}

fn configuration_snapshot(config: &AppConfig) -> ConfigurationSnapshot {
    ConfigurationSnapshot {
        schema_version: config.schema_version,
        revision: config.revision,
        appearance: AppearanceConfiguration {
            theme: match config.appearance.theme {
                Theme::System => ConfigurationTheme::System,
                Theme::Dark => ConfigurationTheme::Dark,
                Theme::Light => ConfigurationTheme::Light,
            },
            density: match config.appearance.density {
                Density::Compact => ConfigurationDensity::Compact,
                Density::Comfortable => ConfigurationDensity::Comfortable,
                Density::Expanded => ConfigurationDensity::Expanded,
            },
            font_family: config.appearance.font_family.clone(),
        },
        terminal: TerminalConfiguration {
            shell_path: config.terminal.shell_path.clone(),
            font_family: config.terminal.font_family.clone(),
            font_size: config.terminal.font_size,
            scrollback: config.terminal.scrollback,
            multiline_paste_protection: config.terminal.multiline_paste_protection,
        },
        browser: browser_configuration(&config.browser),
        notifications: NotificationConfiguration {
            system_enabled: config.notifications.system_enabled,
            include_body: config.notifications.include_body,
        },
        keyboard_shortcuts: KeyboardShortcutConfiguration {
            overrides: config
                .keyboard_shortcuts
                .overrides
                .iter()
                .map(|(command, shortcut)| {
                    (
                        command.clone(),
                        match shortcut {
                            ShortcutOverride::Set(value) => Some(value.clone()),
                            ShortcutOverride::Cleared => None,
                        },
                    )
                })
                .collect(),
        },
        agent_integration: AgentIntegrationConfiguration {
            enabled: config.agent_integration.enabled,
            notifications_enabled: config.agent_integration.notifications_enabled,
            browser_enabled: config.agent_integration.browser_enabled,
        },
        updates: UpdateConfiguration {
            channel: match config.updates.channel {
                ConfigUpdateChannel::Stable => UpdateChannel::Stable,
                ConfigUpdateChannel::Beta => UpdateChannel::Beta,
            },
        },
        logging: LoggingConfiguration {
            level: match config.logging.level {
                LogLevel::Error => LoggingLevel::Error,
                LogLevel::Warn => LoggingLevel::Warn,
                LogLevel::Info => LoggingLevel::Info,
                LogLevel::Debug => LoggingLevel::Debug,
                LogLevel::Trace => LoggingLevel::Trace,
            },
        },
    }
}

fn browser_configuration(config: &BrowserConfig) -> BrowserConfiguration {
    BrowserConfiguration {
        profile_name: config.profile_name.clone(),
        partition: config.partition.clone(),
        privacy: match config.privacy {
            PrivacyBehavior::Standard => BrowserPrivacy::Standard,
            PrivacyBehavior::Strict => BrowserPrivacy::Strict,
        },
    }
}

fn stored_window_state(state: WindowStateSnapshot) -> WindowState {
    WindowState {
        revision: state.revision,
        x: i64::from(state.x),
        y: i64::from(state.y),
        width: u64::from(state.width),
        height: u64::from(state.height),
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        display_identifier: state.display_id,
    }
}

fn window_snapshot(state: WindowState) -> Result<WindowStateSnapshot, ()> {
    if !(-1_000_000..=1_000_000).contains(&state.x)
        || !(-1_000_000..=1_000_000).contains(&state.y)
        || !(200..=32_768).contains(&state.width)
        || !(200..=32_768).contains(&state.height)
        || state.display_identifier.as_ref().is_some_and(|identifier| {
            identifier.chars().count() > 256
                || identifier.trim() != identifier
                || identifier.chars().any(char::is_control)
        })
    {
        return Err(());
    }
    Ok(WindowStateSnapshot {
        revision: state.revision,
        x: i32::try_from(state.x).map_err(|_| ())?,
        y: i32::try_from(state.y).map_err(|_| ())?,
        width: u32::try_from(state.width).map_err(|_| ())?,
        height: u32::try_from(state.height).map_err(|_| ())?,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        display_id: state.display_identifier,
    })
}

fn configuration_success(id: String, config: &AppConfig) -> ResponseEnvelope {
    serialized_success(
        id,
        Some(config.revision),
        ConfigurationGetResult {
            config: configuration_snapshot(config),
        },
    )
}

fn serialized_success(
    id: String,
    revision: Option<u64>,
    value: impl Serialize,
) -> ResponseEnvelope {
    let result =
        serde_json::to_value(value).expect("protocol projection serialization is infallible");
    match revision {
        Some(revision) => ResponseEnvelope::success_at_revision(id, revision, result),
        None => ResponseEnvelope::success(id, result),
    }
}

fn revision_conflict(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "revision_conflict",
        "The expected revision does not match durable state",
    )
}

fn revision_overflow(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "revision_overflow",
        "The durable configuration revision cannot be incremented",
    )
}

fn invalid_configuration(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "invalid_params",
        "The configuration is invalid for the active platform",
    )
}

fn invalid_window_state(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(id, "invalid_params", "The window state is invalid")
}

fn configuration_storage_failure(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "configuration_storage_failure",
        "The configuration could not be stored",
    )
}

fn storage_failure(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(id, "storage_failure", "The durable state operation failed")
}

fn consistency_failure(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "persistence_consistency_failure",
        "Durable configuration consistency could not be restored",
    )
}

fn operation_task_failure(id: String) -> ResponseEnvelope {
    ResponseEnvelope::failure(
        id,
        "persistence_worker_failed",
        "The durable persistence operation stopped unexpectedly",
    )
}

fn runtime_failure(id: String, failure: &OperationFailure) -> ResponseEnvelope {
    match &failure.error {
        RuntimeError::Domain(_) => invalid_configuration(id),
        RuntimeError::Store(_) => storage_failure(id),
        _ => ResponseEnvelope::failure(
            id,
            "runtime_update_failure",
            "The authoritative settings could not be updated",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_workspace_config::AppConfig;
    use agent_workspace_protocol::ConfigurationGetResult;
    use agent_workspace_runtime::{BootstrapConfig, TerminalManagerBackend};
    use agent_workspace_terminal_runtime::{TerminalManager, TerminalSpawnRequest};
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use crate::{ControlContext, TerminalLifecycle};

    struct Harness {
        temp: TempDir,
        context: ControlContext,
        config_store: Arc<ConfigStore>,
        state_store: Arc<SqliteStateStore>,
        terminals: TerminalManager,
        logging_level: Arc<std::sync::Mutex<LogLevel>>,
    }

    impl Harness {
        async fn new() -> Self {
            let temp = TempDir::new().expect("temporary directory must exist");
            let state_store = Arc::new(
                SqliteStateStore::open(
                    temp.path().join("state.sqlite3"),
                    ShortcutPlatform::NonMacOs,
                )
                .expect("test state store must open"),
            );
            let config_store = Arc::new(ConfigStore::new(temp.path().join("config.json")));
            let terminals = TerminalManager::new();
            let backend = Arc::new(TerminalManagerBackend::new(terminals.clone()));
            let logging_level = Arc::new(std::sync::Mutex::new(LogLevel::Info));
            let live_logging_level = Arc::clone(&logging_level);
            let logging_runtime = LoggingRuntime::new(move |level| {
                *live_logging_level
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = level;
            });
            let bootstrap = BootstrapConfig::for_service(
                temp.path().to_path_buf(),
                agent_workspace_core::Timestamp(1),
                24,
                80,
            )
            .expect("bootstrap config must be valid");
            let runtime = Arc::new(
                ProductionWorkspaceRuntime::bootstrap(
                    Arc::clone(&state_store),
                    Arc::clone(&backend),
                    bootstrap,
                )
                .await
                .expect("runtime must bootstrap"),
            );
            let context = ControlContext {
                terminal_io: backend.terminal_io().clone(),
                terminal_backend: Some((*backend).clone()),
                logging_runtime: Some(logging_runtime),
                terminal_lifecycle: TerminalLifecycle::WorkspaceManaged,
                runtime: Some(runtime),
                persistence: Some(PersistenceServices::new(
                    Arc::clone(&config_store),
                    Arc::clone(&state_store),
                )),
                card_slots: Some(crate::card_slots::CardSlotRuntime::new()),
                card_slots_v2: Some(crate::card_slots::CardSlotV2Runtime::new()),
                attention: Some(crate::attention::AttentionRuntime::new()),
                actions: None,
                browser_automation: None,
                agent_sessions: None,
                remote_sessions: None,
                sidebar_content: None,
                multi_window: None,
                platform: ShortcutPlatform::NonMacOs,
            };
            Self {
                temp,
                context,
                config_store,
                state_store,
                terminals,
                logging_level,
            }
        }

        async fn shutdown(&self) {
            self.context
                .runtime
                .as_ref()
                .expect("harness has a runtime")
                .shutdown()
                .await
                .expect("runtime shutdown must complete");
        }
    }

    async fn call(
        context: &ControlContext,
        id: &str,
        command: &str,
        params: Value,
    ) -> ResponseEnvelope {
        dispatch(id.to_owned(), command, params, context).await
    }

    fn configuration(response: &ResponseEnvelope) -> ConfigurationGetResult {
        serde_json::from_value(response.result.clone().expect("success has a result"))
            .expect("result must match the protocol")
    }

    fn error_code(response: &ResponseEnvelope) -> &str {
        &response.error.as_ref().expect("failure has an error").code
    }

    fn terminal_update(shell_path: &Value) -> Value {
        json!({ "terminal": {
            "shellPath": shell_path,
            "fontFamily": "monospace",
            "fontSize": 13,
            "scrollback": 10000,
            "multilinePasteProtection": true
        }})
    }

    fn active_logging_level(harness: &Harness) -> LogLevel {
        *harness
            .logging_level
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn capabilities_are_gated_by_persistence() {
        let legacy = crate::milestone2::identify(true, false).capabilities;
        for capability in CAPABILITIES {
            assert!(!legacy.iter().any(|value| value == capability));
        }
        let production = crate::milestone2::identify(true, true).capabilities;
        for capability in CAPABILITIES {
            assert!(production.iter().any(|value| value == capability));
        }
        assert!(production.iter().any(|value| value == "attention-v1"));
    }

    #[tokio::test]
    async fn persistence_commands_are_unknown_without_stores() {
        let mut harness = Harness::new().await;
        harness.context.persistence = None;
        let response = call(&harness.context, "missing", "configuration.get", json!({})).await;
        assert_eq!(error_code(&response), "unknown_command");
        harness.shutdown().await;
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn configuration_cas_preserves_extensions_reconciles_and_serializes_concurrency() {
        let harness = Harness::new().await;
        let mut initial = AppConfig::default();
        initial
            .extra
            .insert("futureRoot".to_owned(), json!({ "kept": true }));
        initial
            .appearance
            .extra
            .insert("futureAppearance".to_owned(), json!(7));
        harness
            .config_store
            .save(&initial)
            .expect("seed configuration must save");

        let get = call(&harness.context, "get", "configuration.get", json!({})).await;
        assert!(get.ok);
        assert_eq!(get.revision, Some(0));
        assert_eq!(
            configuration(&get).config.terminal.font_family,
            "JetBrains Mono Variable"
        );

        let updated = call(
            &harness.context,
            "update",
            "configuration.update",
            json!({
                "expectedRevision": 0,
                "update": {
                    "appearance": { "theme": "dark", "density": "compact", "fontFamily": "system-ui" },
                    "notifications": { "systemEnabled": false, "includeBody": true },
                    "keyboardShortcuts": {
                        "overrides": { "workspace.new": "Primary+Shift+N" }
                    }
                }
            }),
        )
        .await;
        assert!(updated.ok, "update failed: {:?}", updated.error);
        assert_eq!(updated.revision, Some(1));
        assert_eq!(configuration(&updated).config.revision, 1);

        let durable = harness
            .config_store
            .load()
            .expect("updated configuration must load");
        assert_eq!(durable.extra["futureRoot"], json!({ "kept": true }));
        assert_eq!(durable.appearance.extra["futureAppearance"], json!(7));
        let runtime = harness
            .context
            .runtime
            .as_ref()
            .expect("harness has a runtime");
        let runtime_state = runtime.snapshot().await;
        assert!(!runtime_state.notification_settings.system_enabled);
        assert!(runtime_state.notification_settings.include_body);
        assert_eq!(
            runtime_state
                .shortcut_overrides
                .iter()
                .next()
                .and_then(|(_, value)| value.as_ref())
                .map(LogicalShortcut::as_str),
            Some("Primary+Shift+N")
        );

        let stale_response = call(
            &harness.context,
            "stale",
            "configuration.update",
            json!({
                "expectedRevision": 0,
                "update": { "logging": { "level": "debug" } }
            }),
        )
        .await;
        assert_eq!(error_code(&stale_response), "revision_conflict");

        runtime
            .mutate(LaunchOptions::default(), |state| {
                let mut shortcuts = BTreeMap::new();
                shortcuts.insert(
                    CommandId::new("terminal.new").expect("command is valid"),
                    Some(LogicalShortcut::new("Primary+Shift+T").expect("shortcut is valid")),
                );
                replace_runtime_settings(
                    state,
                    CoreNotificationSettings {
                        system_enabled: true,
                        include_body: false,
                    },
                    shortcuts,
                    ShortcutPlatform::NonMacOs,
                )
            })
            .await
            .expect("legacy settings mutation must commit");
        let reconciled = call(
            &harness.context,
            "reconcile",
            "configuration.get",
            json!({}),
        )
        .await;
        assert_eq!(reconciled.revision, Some(2));
        let reconciled_config = configuration(&reconciled).config;
        assert!(reconciled_config.notifications.system_enabled);
        assert_eq!(
            reconciled_config
                .keyboard_shortcuts
                .overrides
                .get("terminal.new"),
            Some(&Some("Primary+Shift+T".to_owned()))
        );
        let identical = call(
            &harness.context,
            "identical",
            "configuration.get",
            json!({}),
        )
        .await;
        assert_eq!(identical.revision, Some(2));

        let first = call(
            &harness.context,
            "first",
            "configuration.update",
            json!({
                "expectedRevision": 2,
                "update": { "logging": { "level": "trace" } }
            }),
        );
        let second = call(
            &harness.context,
            "second",
            "configuration.update",
            json!({
                "expectedRevision": 2,
                "update": { "logging": { "level": "warn" } }
            }),
        );
        let (first, second) = tokio::join!(first, second);
        assert_ne!(first.ok, second.ok);
        let loser = if first.ok { &second } else { &first };
        assert_eq!(error_code(loser), "revision_conflict");
        let durable = harness.config_store.load().unwrap();
        assert_eq!(durable.revision, 3);
        assert_eq!(active_logging_level(&harness), durable.logging.level);
        harness.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn configured_shell_update_rejects_an_unusable_host_path_without_mutation() {
        let harness = Harness::new().await;
        let invalid_path = harness.temp.path().join("missing-shell");
        let invalid_params = json!({
            "expectedRevision": 0,
            "update": terminal_update(&json!(
                invalid_path.to_str().expect("temporary path is UTF-8")
            ))
        });
        let parsed = serde_json::from_value::<ConfigurationUpdateParams>(invalid_params.clone());
        assert!(
            parsed.is_ok(),
            "invalid-shell fixture must parse: {parsed:?}"
        );
        let invalid = call(
            &harness.context,
            "invalid-shell",
            "configuration.update",
            invalid_params,
        )
        .await;
        assert_eq!(error_code(&invalid), "invalid_params");
        assert!(!invalid.error.unwrap().message.contains("missing-shell"));
        assert_eq!(harness.config_store.load().unwrap(), AppConfig::default());
        harness.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn configured_shell_update_is_durable_live_and_clearable() {
        let harness = Harness::new().await;
        let existing = harness
            .terminals
            .create(TerminalSpawnRequest::default())
            .await
            .expect("system shell must launch");
        let existing_command = existing.command.clone();

        let updated = call(
            &harness.context,
            "configured-shell",
            "configuration.update",
            json!({
                "expectedRevision": 0,
                "update": terminal_update(&json!("/bin/false"))
            }),
        )
        .await;
        assert!(updated.ok, "shell update failed: {:?}", updated.error);
        assert_eq!(
            harness
                .config_store
                .load()
                .unwrap()
                .terminal
                .shell_path
                .as_deref(),
            Some("/bin/false")
        );
        assert_eq!(
            harness
                .terminals
                .attach(&existing.id)
                .expect("existing terminal remains")
                .terminal
                .command,
            existing_command
        );
        let configured = harness
            .terminals
            .create(TerminalSpawnRequest::default())
            .await
            .expect("configured shell must launch");
        assert_eq!(configured.command, vec!["/bin/false"]);

        let cleared = call(
            &harness.context,
            "clear-shell",
            "configuration.update",
            json!({
                "expectedRevision": 1,
                "update": terminal_update(&Value::Null)
            }),
        )
        .await;
        assert!(cleared.ok, "shell clear failed: {:?}", cleared.error);
        assert!(
            harness
                .config_store
                .load()
                .unwrap()
                .terminal
                .shell_path
                .is_none()
        );
        let system_default = harness
            .terminals
            .create(TerminalSpawnRequest::default())
            .await
            .expect("system shell must launch after clear");
        assert_ne!(system_default.command, vec!["/bin/false"]);

        harness
            .terminals
            .terminate(&existing.id)
            .await
            .expect("existing terminal must terminate");
        harness
            .terminals
            .terminate(&system_default.id)
            .await
            .expect("system terminal must terminate");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn window_state_none_roundtrip_conflicts_and_strict_geometry() {
        let harness = Harness::new().await;
        let empty = call(&harness.context, "empty", "window.getState", json!({})).await;
        assert!(empty.ok);
        assert_eq!(empty.revision, None);
        assert_eq!(empty.result.unwrap()["state"], Value::Null);

        let window_payload = json!({
            "revision": 1,
            "x": -25,
            "y": 50,
            "width": 1200,
            "height": 800,
            "maximized": false,
            "fullscreen": false,
            "displayId": "display-1"
        });
        let saved = call(
            &harness.context,
            "save",
            "window.updateState",
            json!({ "state": window_payload }),
        )
        .await;
        assert!(saved.ok, "window save failed: {:?}", saved.error);
        assert_eq!(saved.revision, Some(1));
        let loaded = call(&harness.context, "load", "window.getState", json!({})).await;
        assert_eq!(loaded.revision, Some(1));
        assert_eq!(loaded.result.unwrap()["state"]["width"], 1200);

        let stale_response = call(
            &harness.context,
            "stale",
            "window.updateState",
            json!({ "state": {
                "revision": 0, "x": 0, "y": 0, "width": 800, "height": 600,
                "maximized": false, "fullscreen": false
            }}),
        )
        .await;
        assert_eq!(error_code(&stale_response), "revision_conflict");
        let conflict = call(
            &harness.context,
            "conflict",
            "window.updateState",
            json!({ "state": {
                "revision": 1, "x": 0, "y": 0, "width": 800, "height": 600,
                "maximized": false, "fullscreen": false
            }}),
        )
        .await;
        assert_eq!(error_code(&conflict), "revision_conflict");
        let invalid = call(
            &harness.context,
            "invalid",
            "window.updateState",
            json!({ "state": {
                "revision": 2, "x": 0, "y": 0, "width": 100, "height": 600,
                "maximized": false, "fullscreen": false
            }}),
        )
        .await;
        assert_eq!(error_code(&invalid), "invalid_params");
        harness.shutdown().await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn runtime_storage_failure_rolls_back_config() {
        let harness = Harness::new().await;
        let hard_link = harness.temp.path().join("state-hard-link.sqlite3");
        std::fs::hard_link(harness.state_store.path(), &hard_link)
            .expect("hard link must inject unsafe state-store metadata");
        let response = call(
            &harness.context,
            "failure",
            "configuration.update",
            json!({
                "expectedRevision": 0,
                "update": {
                    "notifications": { "systemEnabled": false, "includeBody": true },
                    "logging": { "level": "trace" },
                    "terminal": {
                        "shellPath": "/bin/false",
                        "fontFamily": "monospace",
                        "fontSize": 13,
                        "scrollback": 10000,
                        "multilinePasteProtection": true
                    }
                }
            }),
        )
        .await;
        assert_eq!(error_code(&response), "storage_failure");
        assert_eq!(harness.config_store.load().unwrap(), AppConfig::default());
        let state = harness.context.runtime.as_ref().unwrap().snapshot().await;
        assert_eq!(
            state.notification_settings,
            CoreNotificationSettings::default()
        );
        assert_eq!(active_logging_level(&harness), LogLevel::Info);
        let terminal = harness
            .terminals
            .create(TerminalSpawnRequest::default())
            .await
            .expect("system shell must still launch");
        assert_ne!(terminal.command, vec!["/bin/false"]);
        harness
            .terminals
            .terminate(&terminal.id)
            .await
            .expect("terminal must terminate");
        std::fs::remove_file(hard_link).expect("hard link must be removed");
        harness.shutdown().await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn config_save_failure_does_not_mutate_runtime() {
        use std::os::unix::fs::PermissionsExt;

        let mut harness = Harness::new().await;
        let read_only = harness.temp.path().join("read-only-config");
        std::fs::create_dir(&read_only).expect("read-only directory must be created");
        std::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o500))
            .expect("directory permissions must be set");
        let failing_store = Arc::new(ConfigStore::new(read_only.join("config.json")));
        harness.context.persistence = Some(PersistenceServices::new(
            failing_store,
            Arc::clone(&harness.state_store),
        ));
        let before = harness.context.runtime.as_ref().unwrap().snapshot().await;
        let response = call(
            &harness.context,
            "save-failure",
            "configuration.update",
            json!({
                "expectedRevision": 0,
                "update": {
                    "notifications": { "systemEnabled": false, "includeBody": true },
                    "logging": { "level": "trace" },
                    "terminal": {
                        "shellPath": "/bin/false",
                        "fontFamily": "monospace",
                        "fontSize": 13,
                        "scrollback": 10000,
                        "multilinePasteProtection": true
                    }
                }
            }),
        )
        .await;
        assert_eq!(error_code(&response), "configuration_storage_failure");
        assert_eq!(
            harness.context.runtime.as_ref().unwrap().snapshot().await,
            before
        );
        assert_eq!(active_logging_level(&harness), LogLevel::Info);
        let terminal = harness
            .terminals
            .create(TerminalSpawnRequest::default())
            .await
            .expect("system shell must still launch");
        assert_ne!(terminal.command, vec!["/bin/false"]);
        harness
            .terminals
            .terminate(&terminal.id)
            .await
            .expect("terminal must terminate");
        std::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o700))
            .expect("directory permissions must be restored");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn request_cancellation_does_not_cancel_serialized_persistence() {
        let mut harness = Harness::new().await;
        let configuration_lock = Arc::new(tokio::sync::Mutex::new(()));
        harness.context.persistence = Some(PersistenceServices::with_locks(
            Arc::clone(&harness.config_store),
            Arc::clone(&harness.state_store),
            Arc::clone(&configuration_lock),
            Arc::new(tokio::sync::Mutex::new(())),
        ));
        let guard = configuration_lock.lock().await;
        let context = harness.context.clone();
        let request = tokio::spawn(async move {
            call(
                &context,
                "cancelled",
                "configuration.update",
                json!({
                    "expectedRevision": 0,
                    "update": { "logging": { "level": "debug" } }
                }),
            )
            .await
        });
        // The request wrapper spawns an owned persistence operation. Once it is waiting on the
        // shared lock, cancelling the request only detaches that operation; it does not drop its
        // compare/write sequence or a subsequently detached spawn_blocking save.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        request.abort();
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if harness.config_store.load().unwrap().revision == 1
                    && active_logging_level(&harness) == LogLevel::Debug
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("detached persistence operation must finish");
        assert_eq!(active_logging_level(&harness), LogLevel::Debug);
        harness.shutdown().await;
    }
}

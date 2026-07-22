//! Milestone 5 configuration, window-state, recovery, and diagnostic wire contracts.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DIAGNOSTIC_ENTRIES: usize = 64;
const MAX_DIAGNOSTIC_ENTRY_BYTES: u64 = 256 * 1_024 * 1_024;
const MAX_DIAGNOSTIC_TOTAL_BYTES: u64 = 1_024 * 1_024 * 1_024;
const COMMAND_IDS: [&str; 12] = [
    "workspace.new",
    "terminal.new",
    "tab.close",
    "pane.splitRight",
    "pane.splitDown",
    "sidebar.toggle",
    "commandPalette.toggle",
    "terminal.search",
    "browser.openSplit",
    "notifications.toggle",
    "notifications.latestUnread",
    "settings.open",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ConfigurationGetResult {
    pub config: ConfigurationSnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ConfigurationSnapshot {
    #[ts(type = "1 | 2")]
    pub schema_version: u32,
    #[ts(type = "number")]
    pub revision: u64,
    pub appearance: AppearanceConfiguration,
    pub terminal: TerminalConfiguration,
    pub browser: BrowserConfiguration,
    pub notifications: NotificationConfiguration,
    pub keyboard_shortcuts: KeyboardShortcutConfiguration,
    pub agent_integration: AgentIntegrationConfiguration,
    pub updates: UpdateConfiguration,
    pub logging: LoggingConfiguration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationSnapshotWire {
    schema_version: u32,
    #[serde(deserialize_with = "safe_integer")]
    revision: u64,
    appearance: AppearanceConfiguration,
    terminal: TerminalConfiguration,
    browser: BrowserConfiguration,
    notifications: NotificationConfiguration,
    keyboard_shortcuts: KeyboardShortcutConfiguration,
    agent_integration: AgentIntegrationConfiguration,
    updates: UpdateConfiguration,
    logging: LoggingConfiguration,
}

impl<'de> Deserialize<'de> for ConfigurationSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ConfigurationSnapshotWire::deserialize(deserializer)?;
        if !(1..=2).contains(&wire.schema_version) {
            return Err(serde::de::Error::custom(
                "configuration schemaVersion must be 1 or 2",
            ));
        }
        if wire.schema_version == 1 && wire.appearance.density == ConfigurationDensity::Expanded {
            return Err(serde::de::Error::custom(
                "expanded density requires configuration schemaVersion 2",
            ));
        }
        Ok(Self {
            schema_version: wire.schema_version,
            revision: wire.revision,
            appearance: wire.appearance,
            terminal: wire.terminal,
            browser: wire.browser,
            notifications: wire.notifications,
            keyboard_shortcuts: wire.keyboard_shortcuts,
            agent_integration: wire.agent_integration,
            updates: wire.updates,
            logging: wire.logging,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ConfigurationUpdateParams {
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub update: ConfigurationUpdate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationUpdateParamsWire {
    #[serde(deserialize_with = "safe_integer")]
    expected_revision: u64,
    update: ConfigurationUpdate,
}

impl<'de> Deserialize<'de> for ConfigurationUpdateParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ConfigurationUpdateParamsWire::deserialize(deserializer)?;
        Ok(Self {
            expected_revision: wire.expected_revision,
            update: wire.update,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ConfigurationUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser: Option<BrowserConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyboard_shortcuts: Option<KeyboardShortcutConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_integration: Option<AgentIntegrationConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdateConfiguration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logging: Option<LoggingConfiguration>,
}

impl<'de> Deserialize<'de> for ConfigurationUpdate {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(default, deserialize_with = "optional_non_null")]
            appearance: Option<AppearanceConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            terminal: Option<TerminalConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            browser: Option<BrowserConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            notifications: Option<NotificationConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            keyboard_shortcuts: Option<KeyboardShortcutConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            agent_integration: Option<AgentIntegrationConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            updates: Option<UpdateConfiguration>,
            #[serde(default, deserialize_with = "optional_non_null")]
            logging: Option<LoggingConfiguration>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.appearance.is_none()
            && wire.terminal.is_none()
            && wire.browser.is_none()
            && wire.notifications.is_none()
            && wire.keyboard_shortcuts.is_none()
            && wire.agent_integration.is_none()
            && wire.updates.is_none()
            && wire.logging.is_none()
        {
            return Err(serde::de::Error::custom(
                "configuration update must not be empty",
            ));
        }
        Ok(Self {
            appearance: wire.appearance,
            terminal: wire.terminal,
            browser: wire.browser,
            notifications: wire.notifications,
            keyboard_shortcuts: wire.keyboard_shortcuts,
            agent_integration: wire.agent_integration,
            updates: wire.updates,
            logging: wire.logging,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ConfigurationTheme {
    System,
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ConfigurationDensity {
    Compact,
    Comfortable,
    Expanded,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AppearanceConfiguration {
    pub theme: ConfigurationTheme,
    pub density: ConfigurationDensity,
    pub font_family: String,
}

impl<'de> Deserialize<'de> for AppearanceConfiguration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            theme: ConfigurationTheme,
            density: ConfigurationDensity,
            font_family: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_text::<D::Error>(&wire.font_family, 256, false, true)?;
        Ok(Self {
            theme: wire.theme,
            density: wire.density,
            font_family: wire.font_family,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TerminalConfiguration {
    pub shell_path: Option<String>,
    pub font_family: String,
    pub font_size: f32,
    pub scrollback: u32,
    pub multiline_paste_protection: bool,
}

impl<'de> Deserialize<'de> for TerminalConfiguration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "required_nullable")]
            shell_path: Option<String>,
            font_family: String,
            font_size: f32,
            scrollback: u32,
            multiline_paste_protection: bool,
        }
        let wire = Wire::deserialize(deserializer)?;
        if let Some(path) = &wire.shell_path {
            validate_absolute_path::<D::Error>(path, 1_024)?;
        }
        validate_text::<D::Error>(&wire.font_family, 256, false, true)?;
        if !wire.font_size.is_finite() || !(6.0..=72.0).contains(&wire.font_size) {
            return Err(serde::de::Error::custom(
                "fontSize must be finite and within 6..=72",
            ));
        }
        if !(100..=1_000_000).contains(&wire.scrollback) {
            return Err(serde::de::Error::custom(
                "scrollback must be within 100..=1000000",
            ));
        }
        Ok(Self {
            shell_path: wire.shell_path,
            font_family: wire.font_family,
            font_size: wire.font_size,
            scrollback: wire.scrollback,
            multiline_paste_protection: wire.multiline_paste_protection,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowserPrivacy {
    Standard,
    Strict,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct BrowserConfiguration {
    pub profile_name: String,
    pub partition: String,
    pub privacy: BrowserPrivacy,
}

impl<'de> Deserialize<'de> for BrowserConfiguration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            profile_name: String,
            partition: String,
            privacy: BrowserPrivacy,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_text::<D::Error>(&wire.profile_name, 128, false, false)?;
        if wire.partition.is_empty()
            || wire.partition.len() > 128
            || !wire
                .partition
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(serde::de::Error::custom("invalid browser partition"));
        }
        Ok(Self {
            profile_name: wire.profile_name,
            partition: wire.partition,
            privacy: wire.privacy,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct NotificationConfiguration {
    pub system_enabled: bool,
    pub include_body: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct KeyboardShortcutConfiguration {
    pub overrides: BTreeMap<String, Option<String>>,
}

impl<'de> Deserialize<'de> for KeyboardShortcutConfiguration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            overrides: BTreeMap<String, Option<String>>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.overrides.len() > COMMAND_IDS.len() {
            return Err(serde::de::Error::custom("too many shortcut overrides"));
        }
        for (command_id, shortcut_value) in &wire.overrides {
            if !COMMAND_IDS.contains(&command_id.as_str()) {
                return Err(serde::de::Error::custom("unknown shortcut command id"));
            }
            if let Some(shortcut_value) = shortcut_value {
                validate_shortcut::<D::Error>(shortcut_value)?;
            }
        }
        Ok(Self {
            overrides: wire.overrides,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AgentIntegrationConfiguration {
    pub enabled: bool,
    pub notifications_enabled: bool,
    pub browser_enabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UpdateChannel {
    Stable,
    Beta,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct UpdateConfiguration {
    pub channel: UpdateChannel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LoggingLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct LoggingConfiguration {
    pub level: LoggingLevel,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WindowStateGetResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<WindowStateSnapshot>,
}

impl<'de> Deserialize<'de> for WindowStateGetResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            #[serde(default, deserialize_with = "optional_non_null")]
            state: Option<WindowStateSnapshot>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self { state: wire.state })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WindowStateUpdateParams {
    pub state: WindowStateSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct WindowStateSnapshot {
    #[ts(type = "number")]
    pub revision: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub fullscreen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
}

impl<'de> Deserialize<'de> for WindowStateSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(deserialize_with = "safe_integer")]
            revision: u64,
            x: i64,
            y: i64,
            width: u32,
            height: u32,
            maximized: bool,
            fullscreen: bool,
            #[serde(default, deserialize_with = "optional_non_null")]
            display_id: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if !(-1_000_000..=1_000_000).contains(&wire.x)
            || !(-1_000_000..=1_000_000).contains(&wire.y)
        {
            return Err(serde::de::Error::custom(
                "window coordinates exceed their bounds",
            ));
        }
        if !(200..=32_768).contains(&wire.width) || !(200..=32_768).contains(&wire.height) {
            return Err(serde::de::Error::custom(
                "window dimensions exceed their bounds",
            ));
        }
        if let Some(display_id) = &wire.display_id {
            validate_text::<D::Error>(display_id, 256, false, true)?;
        }
        Ok(Self {
            revision: wire.revision,
            x: i32::try_from(wire.x).map_err(serde::de::Error::custom)?,
            y: i32::try_from(wire.y).map_err(serde::de::Error::custom)?,
            width: wire.width,
            height: wire.height,
            maximized: wire.maximized,
            fullscreen: wire.fullscreen,
            display_id: wire.display_id,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ServiceRecoveryCategory {
    FutureSchema,
    CorruptDatabase,
    CorruptSchema,
    InvalidSnapshot,
    MigrationFailed,
    Permissions,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, optional_fields)]
pub struct ServiceRecoveryRequiredRecord {
    #[ts(type = "\"service.recoveryRequired\"")]
    pub event: String,
    #[ts(type = "\"agent-workspace\"")]
    pub application: String,
    pub version: String,
    pub protocol_version: u32,
    pub category: ServiceRecoveryCategory,
    pub message: String,
    pub migration_backup_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_backup_path: Option<String>,
}

impl<'de> Deserialize<'de> for ServiceRecoveryRequiredRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            event: String,
            application: String,
            version: String,
            protocol_version: u32,
            category: ServiceRecoveryCategory,
            message: String,
            migration_backup_available: bool,
            #[serde(default, deserialize_with = "optional_non_null")]
            migration_backup_path: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.event != "service.recoveryRequired" || wire.application != "agent-workspace" {
            return Err(serde::de::Error::custom(
                "invalid recovery startup record identity",
            ));
        }
        validate_text::<D::Error>(&wire.version, 128, false, true)?;
        validate_text::<D::Error>(&wire.message, 512, false, true)?;
        if let Some(path) = &wire.migration_backup_path {
            validate_absolute_path::<D::Error>(path, 4_096)?;
        }
        if wire.migration_backup_available != wire.migration_backup_path.is_some() {
            return Err(serde::de::Error::custom(
                "migration backup availability does not match the retained backup path",
            ));
        }
        Ok(Self {
            event: wire.event,
            application: wire.application,
            version: wire.version,
            protocol_version: wire.protocol_version,
            category: wire.category,
            message: wire.message,
            migration_backup_available: wire.migration_backup_available,
            migration_backup_path: wire.migration_backup_path,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DiagnosticBundleEntry {
    pub name: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

impl<'de> Deserialize<'de> for DiagnosticBundleEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            name: String,
            #[serde(deserialize_with = "safe_integer")]
            bytes: u64,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_text::<D::Error>(&wire.name, 256, false, true)?;
        if wire.bytes > MAX_DIAGNOSTIC_ENTRY_BYTES {
            return Err(serde::de::Error::custom("invalid diagnostic entry"));
        }
        Ok(Self {
            name: wire.name,
            bytes: wire.bytes,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DiagnosticBundlePreview {
    pub entries: Vec<DiagnosticBundleEntry>,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub redaction_count: u64,
    #[ts(type = "number")]
    pub created_at: u64,
}

impl<'de> Deserialize<'de> for DiagnosticBundlePreview {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            entries: Vec<DiagnosticBundleEntry>,
            #[serde(deserialize_with = "safe_integer")]
            total_bytes: u64,
            #[serde(deserialize_with = "safe_integer")]
            redaction_count: u64,
            #[serde(deserialize_with = "safe_integer")]
            created_at: u64,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.entries.len() > MAX_DIAGNOSTIC_ENTRIES
            || wire.total_bytes > MAX_DIAGNOSTIC_TOTAL_BYTES
            || wire.redaction_count > 1_000_000
        {
            return Err(serde::de::Error::custom(
                "diagnostic preview exceeds its bounds",
            ));
        }
        let sum = wire
            .entries
            .iter()
            .try_fold(0_u64, |total, entry| total.checked_add(entry.bytes))
            .ok_or_else(|| serde::de::Error::custom("diagnostic entry sizes overflow"))?;
        if sum != wire.total_bytes {
            return Err(serde::de::Error::custom(
                "diagnostic total does not match entries",
            ));
        }
        Ok(Self {
            entries: wire.entries,
            total_bytes: wire.total_bytes,
            redaction_count: wire.redaction_count,
            created_at: wire.created_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RecoveryExportResult {
    pub path: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

impl<'de> Deserialize<'de> for RecoveryExportResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            path: String,
            #[serde(deserialize_with = "safe_integer")]
            bytes: u64,
        }
        let wire = Wire::deserialize(deserializer)?;
        validate_absolute_path::<D::Error>(&wire.path, 4_096)?;
        Ok(Self {
            path: wire.path,
            bytes: wire.bytes,
        })
    }
}

fn safe_integer<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > MAX_SAFE_INTEGER {
        return Err(serde::de::Error::custom(
            "integer exceeds JavaScript safe range",
        ));
    }
    Ok(value)
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

fn validate_text<E>(value: &str, max: usize, allow_empty: bool, normalized: bool) -> Result<(), E>
where
    E: serde::de::Error,
{
    if (!allow_empty && value.is_empty())
        || value.chars().count() > max
        || value.chars().any(char::is_control)
        || (normalized && value != value.trim())
    {
        return Err(E::custom(
            "text is empty, unnormalized, controlled, or exceeds its bound",
        ));
    }
    Ok(())
}

fn validate_absolute_path<E>(value: &str, max: usize) -> Result<(), E>
where
    E: serde::de::Error,
{
    validate_text::<E>(value, max, false, true)?;
    let bytes = value.as_bytes();
    let windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let windows_unc = value.starts_with("\\\\");
    if !value.starts_with('/') && !windows_drive && !windows_unc {
        return Err(E::custom("path must be normalized and absolute"));
    }
    Ok(())
}

fn validate_shortcut<E>(value: &str) -> Result<(), E>
where
    E: serde::de::Error,
{
    validate_text::<E>(value, 128, false, true)?;
    let parts: Vec<_> = value.split('+').collect();
    let order = ["Primary", "Secondary", "Control", "Shift"];
    if parts.len() < 2 {
        return Err(E::custom("invalid canonical logical shortcut"));
    }
    let modifiers = &parts[..parts.len() - 1];
    let ordered = modifiers.iter().enumerate().all(|(index, modifier)| {
        order
            .iter()
            .position(|candidate| candidate == modifier)
            .is_some_and(|position| {
                index == 0
                    || order
                        .iter()
                        .position(|candidate| candidate == &modifiers[index - 1])
                        .is_some_and(|previous| position > previous)
            })
    });
    let key = parts[parts.len() - 1];
    let named = [
        "Backspace",
        "Tab",
        "Enter",
        "Escape",
        "Space",
        "Delete",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Comma",
        "Period",
        "Slash",
        "Backslash",
        "Semicolon",
        "Quote",
        "BracketLeft",
        "BracketRight",
        "Minus",
        "Equal",
        "Backquote",
    ];
    let valid_key = (key.len() == 1
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
        || key
            .strip_prefix('F')
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number))
        || named.contains(&key);
    if !ordered || !valid_key {
        return Err(E::custom("invalid canonical logical shortcut"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::Error as _;
    use serde_json::json;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct LegacyV1DensityFixture {
        schema_version: u32,
        density: LegacyV1Density,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    enum LegacyV1Density {
        Compact,
        Comfortable,
    }

    fn legacy_v1_density_read(value: serde_json::Value) -> Result<(), serde_json::Error> {
        let fixture: LegacyV1DensityFixture = serde_json::from_value(value)?;
        if fixture.schema_version != 1 {
            return Err(serde_json::Error::custom(
                "legacy reader requires schemaVersion 1",
            ));
        }
        let _ = fixture.density;
        Ok(())
    }

    fn config() -> serde_json::Value {
        json!({
            "schemaVersion": 1, "revision": 4,
            "appearance": { "theme": "system", "density": "comfortable", "fontFamily": "system-ui" },
            "terminal": { "shellPath": "/bin/sh", "fontFamily": "monospace", "fontSize": 13, "scrollback": 10000, "multilinePasteProtection": true },
            "browser": { "profileName": "Default", "partition": "default", "privacy": "standard" },
            "notifications": { "systemEnabled": true, "includeBody": false },
            "keyboardShortcuts": { "overrides": { "terminal.new": "Primary+Shift+T", "tab.close": null } },
            "agentIntegration": { "enabled": true, "notificationsEnabled": true, "browserEnabled": true },
            "updates": { "channel": "stable" }, "logging": { "level": "info" }
        })
    }

    #[test]
    fn configuration_is_complete_strict_and_bounded() {
        assert!(
            legacy_v1_density_read(json!({
                "schemaVersion": 1,
                "density": "comfortable"
            }))
            .is_ok()
        );
        assert!(
            legacy_v1_density_read(json!({
                "schemaVersion": 2,
                "density": "expanded"
            }))
            .is_err()
        );
        assert!(
            legacy_v1_density_read(json!({
                "schemaVersion": 1,
                "density": "expanded"
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<ConfigurationSnapshot>(config()).is_ok());
        let mut expanded = config();
        expanded["schemaVersion"] = json!(2);
        expanded["appearance"]["density"] = json!("expanded");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(expanded).is_ok());
        let mut mislabeled_expanded = config();
        mislabeled_expanded["appearance"]["density"] = json!("expanded");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(mislabeled_expanded).is_err());
        let mut future_schema = config();
        future_schema["schemaVersion"] = json!(3);
        assert!(serde_json::from_value::<ConfigurationSnapshot>(future_schema).is_err());
        let mut unknown_density = config();
        unknown_density["appearance"]["density"] = json!("spacious");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(unknown_density).is_err());
        let mut invalid = config();
        invalid["extra"] = json!(true);
        assert!(serde_json::from_value::<ConfigurationSnapshot>(invalid).is_err());
        assert!(serde_json::from_value::<ConfigurationUpdate>(json!({})).is_err());
        assert!(serde_json::from_value::<ConfigurationUpdate>(json!({ "updates": null })).is_err());
        assert!(
            serde_json::from_value::<ConfigurationUpdate>(
                json!({ "updates": { "channel": "beta" } })
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ConfigurationUpdate>(
                json!({ "keyboardShortcuts": { "overrides": { "unknown": null } } })
            )
            .is_err()
        );
        let mut missing_shell_path = config();
        missing_shell_path["terminal"]
            .as_object_mut()
            .expect("terminal fixture must be an object")
            .remove("shellPath");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(missing_shell_path).is_err());

        let mut windows_shell = config();
        windows_shell["terminal"]["shellPath"] = json!(r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(windows_shell).is_ok());

        let mut unc_shell = config();
        unc_shell["terminal"]["shellPath"] = json!(r"\\server\share\pwsh.exe");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(unc_shell).is_ok());

        let mut relative_shell = config();
        relative_shell["terminal"]["shellPath"] = json!("pwsh.exe");
        assert!(serde_json::from_value::<ConfigurationSnapshot>(relative_shell).is_err());
    }

    #[test]
    fn configuration_update_serialization_omits_absent_sections_and_rejects_null() {
        let update = ConfigurationUpdate {
            appearance: None,
            terminal: None,
            browser: None,
            notifications: None,
            keyboard_shortcuts: None,
            agent_integration: Some(AgentIntegrationConfiguration {
                enabled: true,
                notifications_enabled: false,
                browser_enabled: true,
            }),
            updates: None,
            logging: None,
        };
        let serialized = serde_json::to_value(update).unwrap();
        assert_eq!(
            serialized,
            json!({
                "agentIntegration": {
                    "enabled": true,
                    "notificationsEnabled": false,
                    "browserEnabled": true
                }
            })
        );
        for absent_key in [
            "appearance",
            "terminal",
            "browser",
            "notifications",
            "keyboardShortcuts",
            "updates",
            "logging",
        ] {
            assert!(
                serialized.get(absent_key).is_none(),
                "unexpected {absent_key}"
            );
        }

        for section in [
            "appearance",
            "terminal",
            "browser",
            "notifications",
            "keyboardShortcuts",
            "agentIntegration",
            "updates",
            "logging",
        ] {
            assert!(
                serde_json::from_value::<ConfigurationUpdate>(json!({ (section): null })).is_err(),
                "explicit null unexpectedly accepted for {section}"
            );
        }
    }

    #[test]
    fn window_state_display_id_serialization_matches_strict_optional_contract() {
        let state = WindowStateSnapshot {
            revision: 1,
            x: 10,
            y: 20,
            width: 800,
            height: 600,
            maximized: false,
            fullscreen: false,
            display_id: None,
        };
        let serialized = serde_json::to_value(&state).unwrap();
        assert!(serialized.get("displayId").is_none());
        assert_eq!(
            serde_json::from_value::<WindowStateSnapshot>(serialized).unwrap(),
            state
        );

        let mut explicit_null = serde_json::to_value(&state).unwrap();
        explicit_null["displayId"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<WindowStateSnapshot>(explicit_null).is_err());

        let with_display = WindowStateSnapshot {
            display_id: Some("display-1".to_owned()),
            ..state
        };
        assert_eq!(
            serde_json::to_value(with_display).unwrap()["displayId"],
            json!("display-1")
        );
    }

    #[test]
    fn window_and_recovery_records_enforce_boundaries() {
        let state = json!({ "revision": 1, "x": -1_000_000, "y": 1_000_000, "width": 200, "height": 32_768, "maximized": false, "fullscreen": false, "displayId": "display-1" });
        assert!(serde_json::from_value::<WindowStateSnapshot>(state.clone()).is_ok());
        let mut invalid = state;
        invalid["width"] = json!(199);
        assert!(serde_json::from_value::<WindowStateSnapshot>(invalid).is_err());
        assert!(serde_json::from_value::<WindowStateGetResult>(json!({ "state": null })).is_err());
        assert_eq!(
            serde_json::to_value(WindowStateGetResult { state: None }).unwrap(),
            json!({})
        );
        let record = json!({ "event": "service.recoveryRequired", "application": "agent-workspace", "version": "0.1.0", "protocolVersion": 1, "category": "migrationFailed", "message": "Recovery required", "migrationBackupAvailable": true, "migrationBackupPath": "/tmp/backup.db" });
        assert!(serde_json::from_value::<ServiceRecoveryRequiredRecord>(record).is_ok());
        let contradictory = json!({ "event": "service.recoveryRequired", "application": "agent-workspace", "version": "0.1.0", "protocolVersion": 1, "category": "migrationFailed", "message": "Recovery required", "migrationBackupAvailable": true });
        assert!(serde_json::from_value::<ServiceRecoveryRequiredRecord>(contradictory).is_err());
        let contradictory = json!({ "event": "service.recoveryRequired", "application": "agent-workspace", "version": "0.1.0", "protocolVersion": 1, "category": "migrationFailed", "message": "Recovery required", "migrationBackupAvailable": false, "migrationBackupPath": "/tmp/backup.db" });
        assert!(serde_json::from_value::<ServiceRecoveryRequiredRecord>(contradictory).is_err());
        let null_backup = json!({ "event": "service.recoveryRequired", "application": "agent-workspace", "version": "0.1.0", "protocolVersion": 1, "category": "corruptDatabase", "message": "Recovery required", "migrationBackupAvailable": false, "migrationBackupPath": null });
        assert!(serde_json::from_value::<ServiceRecoveryRequiredRecord>(null_backup).is_err());
        let recovery_without_backup = ServiceRecoveryRequiredRecord {
            event: "service.recoveryRequired".to_owned(),
            application: "agent-workspace".to_owned(),
            version: "0.1.0".to_owned(),
            protocol_version: 1,
            category: ServiceRecoveryCategory::CorruptDatabase,
            message: "Recovery required".to_owned(),
            migration_backup_available: false,
            migration_backup_path: None,
        };
        assert!(
            serde_json::to_value(recovery_without_backup)
                .unwrap()
                .get("migrationBackupPath")
                .is_none()
        );
    }

    #[test]
    fn diagnostic_preview_bounds_and_totals_match() {
        let preview = json!({ "entries": [{ "name": "service.log", "bytes": 42 }], "totalBytes": 42, "redactionCount": 2, "createdAt": 5 });
        assert!(serde_json::from_value::<DiagnosticBundlePreview>(preview.clone()).is_ok());
        let mut invalid = preview;
        invalid["totalBytes"] = json!(41);
        assert!(serde_json::from_value::<DiagnosticBundlePreview>(invalid).is_err());
    }
}

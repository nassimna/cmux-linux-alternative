use std::collections::BTreeMap;
use std::fs;

use agent_workspace_config::{
    AgentIntegrationConfig, AppConfig, ConfigError, ConfigStore, Density, LogLevel,
    PrivacyBehavior, SCHEMA_VERSION, ShortcutOverride, Theme, UpdateChannel,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tempfile::TempDir;

fn store(temp: &TempDir) -> ConfigStore {
    ConfigStore::new(temp.path().join("settings/config.json"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyV1Config {
    schema_version: u32,
    appearance: LegacyV1Appearance,
}

#[derive(Deserialize)]
struct LegacyV1Appearance {
    density: LegacyV1Density,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum LegacyV1Density {
    Compact,
    Comfortable,
}

fn legacy_v1_read(value: Value) -> Result<LegacyV1Config, ()> {
    let config: LegacyV1Config = serde_json::from_value(value).map_err(|_| ())?;
    if config.schema_version != 1 {
        return Err(());
    }
    Ok(config)
}

#[test]
fn missing_file_returns_defaults() {
    let temp = TempDir::new().unwrap();
    let defaults = store(&temp).load().unwrap();
    assert_eq!(defaults, AppConfig::default());
    assert!(!defaults.notifications.include_body);
}

#[test]
fn full_configuration_round_trips() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let mut config = AppConfig::default();
    config.appearance.theme = Theme::Dark;
    config.appearance.density = Density::Compact;
    config.terminal.shell_path = Some("/bin/zsh".to_owned());
    config.terminal.font_family = "Iosevka".to_owned();
    config.terminal.font_size = 15.5;
    config.terminal.scrollback = 25_000;
    config.terminal.multiline_paste_protection = false;
    config.browser.profile_name = "Work".to_owned();
    config.browser.partition = "work-profile".to_owned();
    config.browser.privacy = PrivacyBehavior::Strict;
    config.notifications.system_enabled = false;
    config.notifications.include_body = false;
    config.keyboard_shortcuts.overrides.insert(
        "workspace.new".to_owned(),
        ShortcutOverride::Set("Ctrl+Shift+N".to_owned()),
    );
    config
        .keyboard_shortcuts
        .overrides
        .insert("workspace.close".to_owned(), ShortcutOverride::Cleared);
    config.agent_integration = AgentIntegrationConfig {
        enabled: false,
        notifications_enabled: false,
        browser_enabled: false,
        extra: BTreeMap::new(),
    };
    config.updates.channel = UpdateChannel::Beta;
    config.logging.level = LogLevel::Trace;

    store.save(&config).unwrap();
    assert_eq!(store.load().unwrap(), config);

    let text = fs::read_to_string(store.path()).unwrap();
    assert!(text.contains("\"schemaVersion\""));
    assert!(text.contains("\"revision\""));
    assert!(text.contains("\"multilinePasteProtection\""));
    assert!(text.contains("\"workspace.close\": null"));
}

#[test]
fn schema_v2_density_values_round_trip_and_default_remains_compatible() {
    assert_eq!(Density::default(), Density::Comfortable);
    for (wire, expected) in [
        ("compact", Density::Compact),
        ("comfortable", Density::Comfortable),
        ("expanded", Density::Expanded),
    ] {
        let parsed: Density = serde_json::from_value(json!(wire)).unwrap();
        assert_eq!(parsed, expected);
        assert_eq!(serde_json::to_value(parsed).unwrap(), json!(wire));
    }

    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let mut config = AppConfig::default();
    config.appearance.density = Density::Expanded;
    store.save(&config).unwrap();
    assert_eq!(store.load().unwrap().appearance.density, Density::Expanded);
}

#[test]
fn migrates_legacy_density_and_keeps_v2_explicit_for_old_readers() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    let legacy = json!({ "schemaVersion": 1, "appearance": { "density": "compact" } });
    let legacy_read = legacy_v1_read(legacy.clone()).expect("v1 reader accepts compact v1");
    assert!(matches!(
        legacy_read.appearance.density,
        LegacyV1Density::Compact
    ));
    fs::write(store.path(), serde_json::to_vec(&legacy).unwrap()).unwrap();

    let migrated = store.load().unwrap();
    assert_eq!(migrated.schema_version, SCHEMA_VERSION);
    assert_eq!(migrated.appearance.density, Density::Compact);
    store.save(&migrated).unwrap();

    let persisted: Value = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
    assert_eq!(persisted["schemaVersion"], json!(2));
    assert!(legacy_v1_read(persisted).is_err());
    assert!(
        legacy_v1_read(json!({ "schemaVersion": 1, "appearance": { "density": "comfortable" } }))
            .is_ok()
    );
    assert!(
        legacy_v1_read(json!({ "schemaVersion": 1, "appearance": { "density": "expanded" } }))
            .is_err()
    );
}

#[test]
fn rejects_expanded_density_mislabeled_as_schema_v1() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    fs::write(
        store.path(),
        br#"{"schemaVersion":1,"appearance":{"density":"expanded"}}"#,
    )
    .unwrap();

    assert!(matches!(
        store.load(),
        Err(ConfigError::InvalidSetting {
            field: "appearance.density",
            ..
        })
    ));
}

#[test]
fn recursively_preserves_unknown_keys() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    let original = json!({
        "schemaVersion": SCHEMA_VERSION,
        "futureTop": {"nested": {"array": [1, {"leaf": "kept"}]}},
        "appearance": {
            "theme": "dark",
            "density": "comfortable",
            "futureAppearance": {"nestedFlag": true}
        },
        "terminal": {
            "futureTerminal": {"mode": "new"}
        }
    });
    fs::write(store.path(), serde_json::to_vec_pretty(&original).unwrap()).unwrap();

    let mut loaded = store.load().unwrap();
    loaded.logging.level = LogLevel::Debug;
    store.save(&loaded).unwrap();

    let rewritten: Value = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
    assert_eq!(rewritten["futureTop"], original["futureTop"]);
    assert_eq!(
        rewritten["appearance"]["futureAppearance"],
        original["appearance"]["futureAppearance"]
    );
    assert_eq!(
        rewritten["terminal"]["futureTerminal"],
        original["terminal"]["futureTerminal"]
    );
}

#[test]
fn rejects_invalid_known_fields_and_schema_versions() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    fs::create_dir_all(store.path().parent().unwrap()).unwrap();

    fs::write(
        store.path(),
        br#"{"schemaVersion":1,"appearance":{"theme":"neon"}}"#,
    )
    .unwrap();
    assert!(matches!(store.load(), Err(ConfigError::InvalidJson)));

    fs::write(store.path(), br#"{"schemaVersion":0}"#).unwrap();
    assert!(matches!(
        store.load(),
        Err(ConfigError::UnsupportedSchema { found: 0, .. })
    ));

    fs::write(store.path(), br#"{"schemaVersion":3}"#).unwrap();
    assert!(matches!(
        store.load(),
        Err(ConfigError::FutureSchema { found: 3, .. })
    ));

    fs::write(store.path(), br#"{"appearance":{}}"#).unwrap();
    assert!(matches!(
        store.load(),
        Err(ConfigError::InvalidSetting {
            field: "schemaVersion",
            ..
        })
    ));
}

#[test]
fn rejects_relative_shell_paths() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let mut config = AppConfig::default();
    config.terminal.shell_path = Some("bin/zsh".to_owned());

    assert!(matches!(
        store.save(&config),
        Err(ConfigError::InvalidSetting {
            field: "terminal.shellPath",
            ..
        })
    ));
}

#[test]
fn rejects_revisions_above_the_javascript_safe_integer_boundary() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let config = AppConfig {
        revision: 9_007_199_254_740_992,
        ..AppConfig::default()
    };

    assert!(matches!(
        store.save(&config),
        Err(ConfigError::InvalidSetting {
            field: "revision",
            ..
        })
    ));
}

#[test]
fn rejects_oversized_and_deep_json() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    fs::write(store.path(), vec![b' '; 1024 * 1024 + 1]).unwrap();
    assert!(matches!(
        store.load(),
        Err(ConfigError::FileTooLarge { .. })
    ));

    let mut nested = json!(true);
    for _ in 0..40 {
        nested = json!({"future": nested});
    }
    fs::write(
        store.path(),
        serde_json::to_vec(&json!({"schemaVersion": 1, "futureTree": nested})).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        store.load(),
        Err(ConfigError::ResourceLimit { kind: "JSON depth" })
    ));
}

#[test]
fn failed_save_preserves_prior_valid_file() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    store.save(&AppConfig::default()).unwrap();
    let prior = fs::read(store.path()).unwrap();

    let mut invalid = AppConfig::default();
    invalid.terminal.font_size = f32::NAN;
    assert!(matches!(
        store.save(&invalid),
        Err(ConfigError::InvalidSetting {
            field: "terminal.fontSize",
            ..
        })
    ));
    assert_eq!(fs::read(store.path()).unwrap(), prior);
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_and_special_files() {
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;

    let temp = TempDir::new().unwrap();
    let target = temp.path().join("target.json");
    fs::write(&target, br#"{"schemaVersion":1}"#).unwrap();
    let link = temp.path().join("link.json");
    symlink(&target, &link).unwrap();
    let link_store = ConfigStore::new(&link);
    assert!(matches!(
        link_store.load(),
        Err(ConfigError::UnsafePath { .. })
    ));
    assert!(matches!(
        link_store.save(&AppConfig::default()),
        Err(ConfigError::UnsafePath { .. })
    ));

    let socket = temp.path().join("config.sock");
    let _listener = UnixListener::bind(&socket).unwrap();
    let socket_store = ConfigStore::new(&socket);
    assert!(matches!(
        socket_store.load(),
        Err(ConfigError::UnsafePath { .. })
    ));
    assert!(matches!(
        socket_store.save(&AppConfig::default()),
        Err(ConfigError::UnsafePath { .. })
    ));

    let real_parent = temp.path().join("real-parent");
    fs::create_dir(&real_parent).unwrap();
    let linked_parent = temp.path().join("linked-parent");
    symlink(&real_parent, &linked_parent).unwrap();
    let parent_link_store = ConfigStore::new(linked_parent.join("config.json"));
    assert!(matches!(
        parent_link_store.load(),
        Err(ConfigError::UnsafePath { .. })
    ));
    assert!(matches!(
        parent_link_store.save(&AppConfig::default()),
        Err(ConfigError::UnsafePath { .. })
    ));
}

#[cfg(unix)]
#[test]
fn creates_private_paths_and_tightens_existing_modes_without_adding_owner_rights() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    store.save(&AppConfig::default()).unwrap();
    let parent_mode = fs::metadata(store.path().parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    let file_mode = fs::metadata(store.path()).unwrap().permissions().mode();
    assert_eq!(parent_mode & 0o777, 0o700);
    assert_eq!(file_mode & 0o777, 0o600);

    fs::set_permissions(store.path(), fs::Permissions::from_mode(0o447)).unwrap();
    store.load().unwrap();
    assert_eq!(
        fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
        0o400
    );
    store.save(&AppConfig::default()).unwrap();
    assert_eq!(
        fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
        0o400
    );
}

#[test]
fn sensitive_or_executable_extension_fields_are_rejected() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let serialized = serde_json::to_string(&AppConfig::default())
        .unwrap()
        .to_ascii_lowercase();
    assert!(!serialized.contains("token"));
    assert!(!serialized.contains("secret"));
    assert!(!serialized.contains("command"));

    for key in ["apiToken", "clientSecret", "startupCommand"] {
        let mut config = AppConfig::default();
        config
            .extra
            .insert(key.to_owned(), json!("never persisted"));
        assert!(matches!(
            store.save(&config),
            Err(ConfigError::InvalidSetting {
                field: "extension key",
                ..
            })
        ));
        assert!(!store.path().exists());
    }
}

#[test]
fn update_loads_mutates_and_saves() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let updated = store
        .update(|config| config.appearance.theme = Theme::Light)
        .unwrap();
    assert_eq!(updated.appearance.theme, Theme::Light);
    assert_eq!(store.load().unwrap(), updated);
}

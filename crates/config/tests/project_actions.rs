use std::collections::BTreeMap;

use agent_workspace_config::{
    ActionConfig, ActionManifestError, AppConfig, ConfigError, ConfigStore,
    MAX_ACTION_ARGUMENT_SCALARS, MAX_ACTION_DEFINITION_BYTES, MAX_PROJECT_ACTIONS,
    ProjectActionExecutable, ProjectActionManifest, ProjectActionWorkingDirectory,
    TrustedProjectRecord,
};
use agent_workspace_core::default_shortcut_bindings;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tempfile::TempDir;

fn policy() -> ActionConfig {
    ActionConfig {
        approved_executables: vec!["cargo".to_owned(), "node".to_owned()],
        trusted_projects: vec![TrustedProjectRecord {
            canonical_root: "/projects/example".to_owned(),
            manifest_sha256: "a".repeat(64),
            trusted_at_unix_ms: 1_721_600_000_000,
        }],
    }
}

fn valid_action(id: &str) -> Value {
    json!({
        "id": id,
        "title": "Build project",
        "executable": {"kind": "projectRelativePath", "path": "scripts/build"},
        "args": ["--release", "literal $HOME; $(never)"],
        "workingDirectory": {"kind": "projectRoot"},
        "shortcut": "Primary+Shift+B",
        "environment": ["PATH", "LANG"]
    })
}

fn manifest_with(actions: Vec<Value>) -> Vec<u8> {
    let mut manifest = json!({"schemaVersion": 1});
    manifest["actions"] = Value::Array(actions);
    serde_json::to_vec(&manifest).unwrap()
}

fn parse(actions: Vec<Value>) -> Result<ProjectActionManifest, ActionManifestError> {
    ProjectActionManifest::parse_json(&manifest_with(actions), &policy())
}

#[test]
fn parses_and_round_trips_both_closed_executable_and_working_directory_variants() {
    let first = valid_action("project.example.build");
    let second = json!({
        "id": "project.example.test",
        "title": "Test 🚀",
        "executable": {"kind": "approvedName", "name": "cargo"},
        "args": ["test"],
        "workingDirectory": {"kind": "projectRelativePath", "path": "packages/app"},
        "environment": []
    });
    let parsed = parse(vec![first, second]).unwrap();
    assert_eq!(parsed.schema_version, 1);
    assert_eq!(parsed.actions.len(), 2);
    assert!(matches!(
        parsed.actions[0].executable,
        ProjectActionExecutable::ProjectRelativePath { .. }
    ));
    assert!(matches!(
        parsed.actions[1].working_directory,
        ProjectActionWorkingDirectory::ProjectRelativePath { .. }
    ));
    assert_eq!(parsed.actions[1].shortcut, None);

    let encoded = serde_json::to_vec(&parsed).unwrap();
    assert_eq!(
        ProjectActionManifest::parse_json(&encoded, &policy()).unwrap(),
        parsed
    );
}

#[test]
fn action_count_argument_count_and_unicode_scalar_bounds_are_exact() {
    let actions = (0..MAX_PROJECT_ACTIONS)
        .map(|index| valid_action(&format!("project.example.action-{index}")))
        .collect();
    assert_eq!(parse(actions).unwrap().actions.len(), MAX_PROJECT_ACTIONS);

    let too_many = (0..=MAX_PROJECT_ACTIONS)
        .map(|index| valid_action(&format!("project.example.action-{index}")))
        .collect();
    assert!(matches!(
        parse(too_many),
        Err(ActionManifestError::ResourceLimit {
            kind: "action count"
        })
    ));

    let mut action = valid_action("project.example.arguments");
    action["args"] = json!(vec![""; 64]);
    assert!(parse(vec![action.clone()]).is_ok());
    action["args"] = json!(vec![""; 65]);
    assert!(matches!(
        parse(vec![action]),
        Err(ActionManifestError::ResourceLimit {
            kind: "argument count"
        })
    ));

    let mut action = valid_action("project.example.argument-scalars");
    action["args"] = json!(["🚀".repeat(MAX_ACTION_ARGUMENT_SCALARS)]);
    assert!(parse(vec![action.clone()]).is_ok());
    action["args"] = json!(["🚀".repeat(MAX_ACTION_ARGUMENT_SCALARS + 1)]);
    assert!(matches!(
        parse(vec![action]),
        Err(ActionManifestError::InvalidField {
            field: "actions.args",
            ..
        })
    ));
}

#[test]
fn encoded_definition_limit_counts_the_untrusted_definition_bytes() {
    let compact = serde_json::to_string(&valid_action("project.example.encoded-size")).unwrap();
    let padding = " ".repeat(MAX_ACTION_DEFINITION_BYTES - compact.len());
    let exact = format!(
        "{{\"schemaVersion\":1,\"actions\":[{{{}{}}}]}}",
        padding,
        &compact[1..compact.len() - 1]
    );
    assert!(ProjectActionManifest::parse_json(exact.as_bytes(), &policy()).is_ok());

    let oversized_padding = format!("{padding} ");
    let oversized = exact.replacen(&padding, &oversized_padding, 1);
    assert!(matches!(
        ProjectActionManifest::parse_json(oversized.as_bytes(), &policy()),
        Err(ActionManifestError::ResourceLimit {
            kind: "action definition bytes"
        })
    ));
}

#[test]
fn ids_titles_shortcuts_and_nulls_are_strict() {
    for invalid_id in [
        "build",
        "Project.example.build",
        "project..build",
        ".project.build",
        "project.example.build!",
    ] {
        let mut action = valid_action(invalid_id);
        assert!(matches!(
            parse(vec![action.take()]),
            Err(ActionManifestError::InvalidField {
                field: "actions.id",
                ..
            })
        ));
    }

    let mut title = valid_action("project.example.unicode-title");
    title["title"] = json!("界".repeat(120));
    assert!(parse(vec![title.clone()]).is_ok());
    for invalid in [
        "界".repeat(121),
        " padded ".to_owned(),
        "bad\nline".to_owned(),
    ] {
        title["title"] = json!(invalid);
        assert!(matches!(
            parse(vec![title.clone()]),
            Err(ActionManifestError::InvalidField {
                field: "actions.title",
                ..
            })
        ));
    }

    let mut shortcut = valid_action("project.example.shortcut");
    shortcut["shortcut"] = json!(null);
    assert_eq!(
        parse(vec![shortcut.clone()]),
        Err(ActionManifestError::InvalidJson)
    );
    for invalid in ["Ctrl+B", "Shift+Primary+B", "Primary+b", "Primary+"] {
        shortcut["shortcut"] = json!(invalid);
        assert!(matches!(
            parse(vec![shortcut.clone()]),
            Err(ActionManifestError::InvalidField {
                field: "actions.shortcut",
                ..
            })
        ));
    }
    shortcut.as_object_mut().unwrap().remove("shortcut");
    assert!(parse(vec![shortcut]).is_ok());
}

#[test]
fn every_built_in_logical_shortcut_is_accepted_without_renormalization() {
    for (index, shortcut) in default_shortcut_bindings().values().enumerate() {
        let mut action = valid_action(&format!("project.example.builtin-{index}"));
        action["shortcut"] = json!(shortcut.as_str());
        assert!(
            parse(vec![action]).is_ok(),
            "built-in shortcut should remain valid: {}",
            shortcut.as_str()
        );
    }
}

#[test]
fn unknown_shell_template_and_confirmation_fields_are_rejected_at_every_boundary() {
    let mut top = json!({"schemaVersion": 1, "actions": []});
    top["future"] = json!(true);
    assert_eq!(
        ProjectActionManifest::parse_json(&serde_json::to_vec(&top).unwrap(), &policy()),
        Err(ActionManifestError::InvalidJson)
    );

    for field in ["unknown", "shell", "template", "confirmation", "command"] {
        let mut action = valid_action("project.example.closed");
        action[field] = json!(field == "shell");
        assert_eq!(parse(vec![action]), Err(ActionManifestError::InvalidJson));
    }

    let mut executable = valid_action("project.example.executable-closed");
    executable["executable"]["shell"] = json!(true);
    assert_eq!(
        parse(vec![executable]),
        Err(ActionManifestError::InvalidJson)
    );

    let mut working_directory = valid_action("project.example.cwd-closed");
    working_directory["workingDirectory"]["outside"] = json!("/tmp");
    assert_eq!(
        parse(vec![working_directory]),
        Err(ActionManifestError::InvalidJson)
    );
}

#[test]
fn duplicate_ids_and_unapproved_bare_names_are_rejected() {
    assert!(matches!(
        parse(vec![
            valid_action("project.example.same"),
            valid_action("project.example.same")
        ]),
        Err(ActionManifestError::InvalidField {
            field: "actions.id",
            ..
        })
    ));

    let mut action = valid_action("project.example.unapproved");
    action["executable"] = json!({"kind": "approvedName", "name": "python3"});
    assert!(matches!(
        parse(vec![action]),
        Err(ActionManifestError::InvalidField {
            field: "actions.executable.name",
            ..
        })
    ));
}

#[test]
fn project_relative_paths_are_lexically_confined_for_executable_and_cwd() {
    for valid in ["tool", "scripts/build", "packages/app/bin/run"] {
        let mut action = valid_action("project.example.valid-path");
        action["executable"] = json!({"kind": "projectRelativePath", "path": valid});
        assert!(parse(vec![action]).is_ok(), "expected valid path: {valid}");
    }

    for invalid in [
        "",
        "/usr/bin/tool",
        "../tool",
        "scripts/../tool",
        "./tool",
        "scripts//tool",
        "scripts/",
        "scripts\\tool",
        "C:/tool",
    ] {
        let mut executable = valid_action("project.example.invalid-executable-path");
        executable["executable"] = json!({"kind": "projectRelativePath", "path": invalid});
        assert!(
            matches!(
                parse(vec![executable]),
                Err(ActionManifestError::InvalidField {
                    field: "actions.executable.path",
                    ..
                })
            ),
            "expected invalid executable path: {invalid}"
        );

        let mut cwd = valid_action("project.example.invalid-cwd-path");
        cwd["workingDirectory"] = json!({"kind": "projectRelativePath", "path": invalid});
        assert!(
            matches!(
                parse(vec![cwd]),
                Err(ActionManifestError::InvalidField {
                    field: "actions.workingDirectory.path",
                    ..
                })
            ),
            "expected invalid cwd path: {invalid}"
        );
    }
}

#[test]
fn environment_names_are_bounded_unique_portable_and_non_sensitive() {
    let mut action = valid_action("project.example.environment");
    action["environment"] = json!(
        (0..32)
            .map(|index| format!("SAFE_{index}"))
            .collect::<Vec<_>>()
    );
    assert!(parse(vec![action.clone()]).is_ok());
    action["environment"] = json!(
        (0..33)
            .map(|index| format!("SAFE_{index}"))
            .collect::<Vec<_>>()
    );
    assert!(matches!(
        parse(vec![action]),
        Err(ActionManifestError::ResourceLimit {
            kind: "environment name count"
        })
    ));

    for environment in [
        json!(["PATH", "PATH"]),
        json!(["lowercase"]),
        json!(["9START"]),
        json!(["API_TOKEN"]),
        json!(["SSH_AUTH_SOCK"]),
        json!(["PRIVATE_KEY"]),
        json!(["API_KEY"]),
        json!(["BAD=VALUE"]),
    ] {
        let mut action = valid_action("project.example.invalid-environment");
        action["environment"] = environment;
        assert!(matches!(
            parse(vec![action]),
            Err(ActionManifestError::InvalidField {
                field: "actions.environment",
                ..
            })
        ));
    }

    for safe in ["KEYBOARD_LAYOUT", "TOKENIZER_MODE", "MONKEY_COUNT"] {
        let mut action = valid_action("project.example.safe-environment-name");
        action["environment"] = json!([safe]);
        assert!(parse(vec![action]).is_ok(), "expected safe name: {safe}");
    }
}

#[test]
fn application_owned_policy_round_trips_and_enforces_all_bounds() {
    let temp = TempDir::new().unwrap();
    let store = ConfigStore::new(temp.path().join("settings/config.json"));
    let config = AppConfig {
        actions: policy(),
        ..AppConfig::default()
    };
    store.save(&config).unwrap();
    assert_eq!(store.load().unwrap().actions, config.actions);

    let mut invalid = config.clone();
    invalid.actions.approved_executables = vec!["cargo".to_owned(), "cargo".to_owned()];
    assert!(matches!(
        store.save(&invalid),
        Err(ConfigError::InvalidSetting {
            field: "actions.approvedExecutables",
            ..
        })
    ));
    invalid = config.clone();
    invalid.actions.trusted_projects[0].canonical_root = "../project".to_owned();
    assert!(matches!(
        store.save(&invalid),
        Err(ConfigError::InvalidSetting {
            field: "actions.trustedProjects.canonicalRoot",
            ..
        })
    ));
    invalid = config.clone();
    invalid.actions.trusted_projects[0].manifest_sha256 = "A".repeat(64);
    assert!(matches!(
        store.save(&invalid),
        Err(ConfigError::InvalidSetting {
            field: "actions.trustedProjects.manifestSha256",
            ..
        })
    ));
    invalid = config;
    invalid.actions.trusted_projects[0].trusted_at_unix_ms = 9_007_199_254_740_992;
    assert!(matches!(
        store.save(&invalid),
        Err(ConfigError::InvalidSetting {
            field: "actions.trustedProjects.trustedAtUnixMs",
            ..
        })
    ));
}

#[test]
fn action_config_rejects_unknown_fields_and_explicit_null_collections() {
    let temp = TempDir::new().unwrap();
    let store = ConfigStore::new(temp.path().join("settings/config.json"));
    std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    for actions in [
        json!({"approvedExecutables": [], "trustedProjects": [], "unknown": true}),
        json!({"approvedExecutables": null, "trustedProjects": []}),
        json!({"approvedExecutables": [], "trustedProjects": null}),
    ] {
        std::fs::write(
            store.path(),
            serde_json::to_vec(&json!({"schemaVersion": 2, "actions": actions})).unwrap(),
        )
        .unwrap();
        assert!(matches!(store.load(), Err(ConfigError::InvalidJson)));
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyV2Reader {
    schema_version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

fn legacy_extension_keys_are_safe(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().all(|(key, child)| {
            let lowered = key.to_ascii_lowercase();
            !["token", "secret", "command"]
                .iter()
                .any(|reserved| lowered.contains(reserved))
                && legacy_extension_keys_are_safe(child)
        }),
        Value::Array(array) => array.iter().all(legacy_extension_keys_are_safe),
        _ => true,
    }
}

#[test]
fn schema_v2_legacy_reader_accepts_preserves_and_reemits_the_additive_actions_section() {
    let config = AppConfig {
        actions: policy(),
        ..AppConfig::default()
    };
    let current = serde_json::to_value(&config).unwrap();
    assert!(legacy_extension_keys_are_safe(&current));

    let legacy: LegacyV2Reader = serde_json::from_value(current.clone()).unwrap();
    assert_eq!(legacy.schema_version, 2);
    assert_eq!(legacy.extra["actions"], current["actions"]);
    let rewritten = serde_json::to_value(legacy).unwrap();
    assert_eq!(rewritten["schemaVersion"], json!(2));
    assert_eq!(rewritten["actions"], current["actions"]);

    let reread: AppConfig = serde_json::from_value(rewritten).unwrap();
    assert_eq!(reread.actions, config.actions);
}

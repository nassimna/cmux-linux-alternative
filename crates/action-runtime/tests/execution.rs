#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_workspace_action_runtime::{
    ApprovedExecutable, CancellationToken, ContainmentAvailability, ExecutionError,
    ExecutionPolicy, ExecutionRequest, ExitClass, confirmation_definition_sha256,
    containment_availability, execute,
};
use agent_workspace_config::{
    ProjectActionDefinition, ProjectActionExecutable, ProjectActionManifest,
    ProjectActionWorkingDirectory, TrustedProjectRecord,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn write_executable(root: &Path, relative: &str, body: &str) -> PathBuf {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

fn action(executable: ProjectActionExecutable, args: Vec<String>) -> ProjectActionDefinition {
    ProjectActionDefinition {
        id: "project.test.run".into(),
        title: "Run".into(),
        executable,
        args,
        working_directory: ProjectActionWorkingDirectory::ProjectRoot,
        shortcut: None,
        environment: Vec::new(),
    }
}

fn fixture(root: &Path, action: ProjectActionDefinition) -> (ExecutionPolicy, ExecutionRequest) {
    let manifest = serde_json::to_vec(&ProjectActionManifest {
        schema_version: 1,
        actions: vec![action.clone()],
    })
    .unwrap();
    let digest = format!("{:x}", Sha256::digest(&manifest));
    let canonical_root = fs::canonicalize(root).unwrap();
    (
        ExecutionPolicy {
            trusted_projects: vec![TrustedProjectRecord {
                canonical_root: canonical_root.to_str().unwrap().into(),
                manifest_sha256: digest,
                trusted_at_unix_ms: 1,
            }],
            approved_executables: Vec::new(),
            safe_environment: BTreeMap::new(),
            redaction_values: Vec::new(),
            file_argument_schemas: BTreeMap::new(),
            output_limit_bytes: 4096,
            timeout: Duration::from_secs(5),
        },
        ExecutionRequest {
            invocation_id: "invocation-safe-id".into(),
            action,
            project_root: root.to_path_buf(),
            manifest_bytes: manifest,
        },
    )
}

async fn run(
    policy: &ExecutionPolicy,
    request: &ExecutionRequest,
) -> Result<agent_workspace_action_runtime::ExecutionResult, ExecutionError> {
    execute(policy, request, &CancellationToken::default()).await
}

async fn require_containment() -> bool {
    let availability = containment_availability().await;
    if availability == ContainmentAvailability::Available {
        true
    } else {
        eprintln!("skipping host integration test: {availability:?}");
        false
    }
}

#[tokio::test]
async fn exact_manifest_and_canonical_root_trust_are_required() {
    let root = TempDir::new().unwrap();
    write_executable(root.path(), "run", "exit 0");
    let (policy, mut request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath { path: "run".into() },
            Vec::new(),
        ),
    );
    request.manifest_bytes.push(b'!');
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::UntrustedProject
    );
}

#[tokio::test]
async fn traversal_and_symlink_escape_fail_closed() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let outside_program = write_executable(outside.path(), "outside", "exit 0");
    symlink(&outside_program, root.path().join("escape")).unwrap();

    for (relative, expected) in [
        ("../outside", ExecutionError::InvalidActionDefinition),
        ("escape", ExecutionError::InvalidExecutable),
    ] {
        let (policy, request) = fixture(
            root.path(),
            action(
                ProjectActionExecutable::ProjectRelativePath {
                    path: relative.into(),
                },
                Vec::new(),
            ),
        );
        assert_eq!(run(&policy, &request).await.unwrap_err(), expected);
    }
}

#[tokio::test]
async fn working_directory_and_declared_file_arguments_cannot_escape() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write_executable(root.path(), "run", "exit 0");
    symlink(outside.path(), root.path().join("outside-link")).unwrap();

    let mut escaped_working_directory = action(
        ProjectActionExecutable::ProjectRelativePath { path: "run".into() },
        vec!["outside-link".into()],
    );
    escaped_working_directory.working_directory =
        ProjectActionWorkingDirectory::ProjectRelativePath {
            path: "outside-link".into(),
        };
    let (policy, request) = fixture(root.path(), escaped_working_directory);
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::InvalidWorkingDirectory
    );

    let (mut policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath { path: "run".into() },
            vec!["outside-link".into()],
        ),
    );
    policy
        .file_argument_schemas
        .insert(request.action.id.clone(), BTreeSet::from([0]));
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::InvalidFileArgument
    );

    let socket_path = root.path().join("argument-socket");
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let (mut policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath { path: "run".into() },
            vec!["argument-socket".into()],
        ),
    );
    policy
        .file_argument_schemas
        .insert(request.action.id.clone(), BTreeSet::from([0]));
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::InvalidFileArgument
    );
}

#[tokio::test]
async fn special_and_non_executable_files_are_rejected() {
    let root = TempDir::new().unwrap();
    fs::write(root.path().join("plain"), "not executable").unwrap();
    let socket_path = root.path().join("socket");
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();

    for relative in ["plain", "socket"] {
        let (policy, request) = fixture(
            root.path(),
            action(
                ProjectActionExecutable::ProjectRelativePath {
                    path: relative.into(),
                },
                Vec::new(),
            ),
        );
        assert_eq!(
            run(&policy, &request).await.unwrap_err(),
            ExecutionError::InvalidExecutable
        );
    }
}

#[tokio::test]
async fn approved_name_resolution_is_exact_fixed_and_unambiguous() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    let executable = write_executable(root.path(), "approved", "printf approved");
    let (mut policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ApprovedName {
                name: "tool".into(),
            },
            Vec::new(),
        ),
    );
    policy.approved_executables = vec![
        ApprovedExecutable {
            name: "tool".into(),
            path: executable.clone(),
        },
        ApprovedExecutable {
            name: "tool".into(),
            path: executable,
        },
    ];
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::InvalidPolicy
    );

    policy.approved_executables.pop();
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.stdout.as_bytes(), b"approved");
}

#[tokio::test]
async fn environment_is_minimal_filtered_and_values_are_redacted() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(
        root.path(),
        "env",
        "printf '%s|%s|%s' \"$SAFE_VALUE\" \"${HOME-unset}\" \"${SSH_AUTH_SOCK-unset}\"",
    );
    let mut environment_action = action(
        ProjectActionExecutable::ProjectRelativePath { path: "env".into() },
        Vec::new(),
    );
    environment_action.environment.push("SAFE_VALUE".into());
    let (mut policy, request) = fixture(root.path(), environment_action);
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::EnvironmentDenied
    );
    policy
        .safe_environment
        .insert("SAFE_VALUE".into(), "sensitive-runtime-value".into());
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.stdout.as_bytes(), b"[REDACTED]|unset|unset");
    assert_eq!(result.stdout.redaction_count(), 1);

    for name in [
        "SSH_AUTH_SOCK",
        "APIKEY",
        "AUTHTOKEN",
        "CLIENTSECRET",
        "PRIVATEKEY",
        "DATABASE_URL",
        "CI_JOB_JWT",
    ] {
        policy
            .safe_environment
            .insert(name.into(), "forbidden".into());
        assert_eq!(
            run(&policy, &request).await.unwrap_err(),
            ExecutionError::InvalidPolicy
        );
        policy.safe_environment.remove(name);
    }
}

#[test]
fn confirmation_digest_binds_exact_definition_manifest_and_trusted_file_schema() {
    let root = TempDir::new().unwrap();
    let (mut policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ApprovedName {
                name: "tool".into(),
            },
            vec!["file".into()],
        ),
    );
    policy.approved_executables.push(ApprovedExecutable {
        name: "tool".into(),
        path: PathBuf::from("/bin/true"),
    });
    let base = confirmation_definition_sha256(&policy, &request).unwrap();
    assert_eq!(base.len(), 64);
    policy
        .file_argument_schemas
        .insert(request.action.id.clone(), BTreeSet::from([0]));
    let with_schema = confirmation_definition_sha256(&policy, &request).unwrap();
    assert_ne!(base, with_schema);
}

#[tokio::test]
async fn action_definition_must_be_an_exact_member_of_the_trusted_manifest() {
    let root = TempDir::new().unwrap();
    write_executable(root.path(), "run", "exit 0");
    let (policy, mut request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath { path: "run".into() },
            Vec::new(),
        ),
    );
    request.action.args.push("not-in-manifest".into());
    assert_eq!(
        run(&policy, &request).await.unwrap_err(),
        ExecutionError::InvalidActionDefinition
    );
}

#[tokio::test]
async fn direct_argv_preserves_shell_metacharacters_literally() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(root.path(), "argv", "printf '%s' \"$1\"");
    let literal = "$(touch SHOULD_NOT_EXIST);*.rs;$HOME";
    let (policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "argv".into(),
            },
            vec![literal.into()],
        ),
    );
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.stdout.as_bytes(), literal.as_bytes());
    assert!(!root.path().join("SHOULD_NOT_EXIST").exists());
}

#[tokio::test]
async fn output_is_bounded_and_redacted_without_leaking_through_debug() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(
        root.path(),
        "output",
        "printf 'top-secret'; i=0; while [ $i -lt 100 ]; do printf x; i=$((i+1)); done; printf 'top-secret' >&2",
    );
    let (mut policy, mut request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "output".into(),
            },
            Vec::new(),
        ),
    );
    policy.output_limit_bytes = 24;
    policy.redaction_values.push("top-secret".into());
    request.invocation_id = "/private/absolute/path".into();
    let result = run(&policy, &request).await.unwrap();
    assert!(result.stdout.truncated());
    assert!(result.stdout.as_bytes().len() <= 24);
    assert!(
        !result
            .stdout
            .as_bytes()
            .windows(10)
            .any(|value| value == b"top-secret")
    );
    assert!(
        !result
            .stderr
            .as_bytes()
            .windows(10)
            .any(|value| value == b"top-secret")
    );
    assert!(!format!("{result:?}").contains("top-secret"));
    let audit = format!("{:?}", result.audit(&request));
    assert!(!audit.contains("top-secret"));
    assert!(!audit.contains("/private/absolute/path"));
}

#[tokio::test]
async fn repeated_maximum_length_secrets_cannot_cross_capture_boundary() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    let secret = "s".repeat(4096);
    write_executable(
        root.path(),
        "long-output",
        &format!("printf '%s%s' '{secret}' '{secret}'"),
    );
    let (mut policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "long-output".into(),
            },
            Vec::new(),
        ),
    );
    policy.output_limit_bytes = 20;
    policy.redaction_values.push(secret);
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.stdout.as_bytes(), b"[REDACTED][REDACTED]");
    assert_eq!(result.stdout.redaction_count(), 2);
    assert!(!result.stdout.as_bytes().contains(&b's'));
}

#[tokio::test]
async fn timeout_terminates_process_group_descendants() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(
        root.path(),
        "tree",
        "sleep 30 & child=$!; printf '%s' \"$child\" > child.pid; wait",
    );
    let (mut policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "tree".into(),
            },
            Vec::new(),
        ),
    );
    policy.timeout = Duration::from_millis(150);
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.exit_class, ExitClass::TimedOut);
    let child_pid: i32 = fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_process_gone(child_pid).await;
}

#[tokio::test]
async fn successful_parent_exit_still_terminates_background_descendants() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(
        root.path(),
        "background",
        "sleep 30 & child=$!; printf '%s' \"$child\" > child.pid; exit 0",
    );
    let (policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "background".into(),
            },
            Vec::new(),
        ),
    );
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.exit_class, ExitClass::Success);
    let child_pid: i32 = fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_process_gone(child_pid).await;
}

#[tokio::test]
async fn successful_parent_exit_terminates_setsid_escape_attempt() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(
        root.path(),
        "setsid-escape",
        "setsid sh -c 'printf %s $$ > setsid.pid; exec sleep 30' & while [ ! -s setsid.pid ]; do :; done; exit 0",
    );
    let (policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "setsid-escape".into(),
            },
            Vec::new(),
        ),
    );
    let result = run(&policy, &request).await.unwrap();
    assert_eq!(result.exit_class, ExitClass::Success);
    let child_pid: i32 = fs::read_to_string(root.path().join("setsid.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_process_gone(child_pid).await;
}

#[tokio::test]
async fn cancellation_terminates_process_group_descendants() {
    if !require_containment().await {
        return;
    }
    let root = TempDir::new().unwrap();
    write_executable(
        root.path(),
        "tree",
        "sleep 30 & child=$!; printf '%s' \"$child\" > child.pid; wait",
    );
    let (policy, request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath {
                path: "tree".into(),
            },
            Vec::new(),
        ),
    );
    let cancellation = CancellationToken::default();
    let trigger = cancellation.clone();
    let cancel_task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        trigger.cancel();
    });
    let result = execute(&policy, &request, &cancellation).await.unwrap();
    cancel_task.await.unwrap();
    assert_eq!(result.exit_class, ExitClass::Cancelled);
    let child_pid: i32 = fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_process_gone(child_pid).await;
}

async fn assert_process_gone(raw_pid: i32) {
    let pid = rustix::process::Pid::from_raw(raw_pid).unwrap();
    for _ in 0..20 {
        if rustix::process::test_kill_process(pid).is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("descendant process remained alive");
}

#[tokio::test]
async fn secrets_and_absolute_paths_do_not_enter_debug_or_errors() {
    let root = TempDir::new().unwrap();
    write_executable(root.path(), "run", "exit 0");
    let raw_secret = "raw-super-secret-value";
    let raw_arg = "private-argv-value";
    let (mut policy, mut request) = fixture(
        root.path(),
        action(
            ProjectActionExecutable::ProjectRelativePath { path: "run".into() },
            vec![raw_arg.into()],
        ),
    );
    policy
        .safe_environment
        .insert("SAFE".into(), raw_secret.into());
    request.manifest_bytes.push(b'!');
    let rendered = format!(
        "{policy:?} {request:?} {}",
        run(&policy, &request).await.unwrap_err()
    );
    assert!(!rendered.contains(raw_secret));
    assert!(!rendered.contains(raw_arg));
    assert!(!rendered.contains(root.path().to_str().unwrap()));
}

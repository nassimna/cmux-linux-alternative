#![cfg(unix)]

use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;
use tempfile::tempdir;

const CONTROL_TOKEN: &str = "real-cli-integration-control-token-00000001";

struct ServiceProcess {
    child: Child,
}

impl ServiceProcess {
    fn stop_from_parent_channel(mut self) -> u32 {
        let service_pid = self.child.id();
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(status) = self
                .child
                .try_wait()
                .expect("service status must be readable")
            {
                assert!(
                    status.success(),
                    "stdin EOF must produce an orderly service exit, got {status}"
                );
                return service_pid;
            }
            thread::sleep(Duration::from_millis(25));
        }
        terminate_and_wait(&mut self.child);
        panic!("service did not exit after its parent channel reached EOF");
    }
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        terminate_and_wait(&mut self.child);
    }
}

fn terminate_and_wait(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    child.wait().expect("service process must be reaped");
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("CLI crate must be inside the workspace")
        .to_owned()
}

fn build_service() -> PathBuf {
    if let Some(path) = std::env::var_os("AGENT_WORKSPACE_SERVICE_BIN") {
        return PathBuf::from(path);
    }
    let root = workspace_root();
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .map_or_else(
            || root.join("target"),
            |path| {
                if path.is_absolute() {
                    path
                } else {
                    root.join(path)
                }
            },
        );
    let service = target.join("debug/agent-workspace-service");
    if service.is_file() {
        return service;
    }

    let status = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .current_dir(&root)
        .args([
            "build",
            "--quiet",
            "-p",
            "agent-workspace-service",
            "--bin",
            "agent-workspace-service",
        ])
        .status()
        .expect("cargo must build the real service binary");
    assert!(status.success(), "real service binary must build");
    service
}

fn run_cli(session_file: &Path, arguments: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-workspace-cli"))
        .arg("--session-file")
        .arg(session_file)
        .args(arguments)
        .output()
        .expect("real CLI command must run");
    assert_success(&output, arguments);
    serde_json::from_slice(&output.stdout).expect("successful CLI output must be JSON")
}

fn assert_success(output: &Output, arguments: &[&str]) {
    assert!(
        output.status.success(),
        "CLI {:?} failed with status {:?}: {}",
        arguments,
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn selected_pane_id<'a>(
    result: &'a Value,
    workspace_name: &str,
) -> (&'a str, &'a str, usize, usize) {
    let workspace = result["snapshot"]["workspaces"]
        .as_array()
        .expect("mutation snapshot must contain workspaces")
        .iter()
        .find(|workspace| workspace["name"] == workspace_name)
        .expect("created workspace must appear in projection");
    (
        workspace["id"]
            .as_str()
            .expect("workspace id must be a string"),
        workspace["selectedPaneId"]
            .as_str()
            .expect("selected pane id must be a string"),
        workspace["tabs"]
            .as_array()
            .expect("tabs must be an array")
            .len(),
        workspace["panes"]
            .as_array()
            .expect("panes must be an array")
            .len(),
    )
}

#[test]
#[allow(clippy::too_many_lines)]
fn minimal_workspace_terminal_and_pane_split_succeed_against_real_service() {
    let root = tempdir().expect("isolated service root must be created");
    let endpoint = root.path().join("runtime/control.sock");
    let session_file = root.path().join("runtime/cli-session.json");
    let state_db = root.path().join("state/workspace.sqlite3");
    let config = root.path().join("config/config.json");
    let log_dir = root.path().join("logs");
    let working_directory = root.path().join("working-directory");
    fs::create_dir_all(&working_directory).expect("working directory must be created");

    let child = Command::new(build_service())
        .arg("--endpoint")
        .arg(&endpoint)
        .arg("--cli-session-file")
        .arg(&session_file)
        .arg("--state-db")
        .arg(&state_db)
        .arg("--config")
        .arg(&config)
        .arg("--log-dir")
        .arg(&log_dir)
        .arg("--default-cwd")
        .arg(&working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("real service must start");
    let mut service = ServiceProcess { child };
    writeln!(
        service
            .child
            .stdin
            .as_mut()
            .expect("service stdin must be piped"),
        "{CONTROL_TOKEN}"
    )
    .expect("control token must be delivered");

    let deadline = Instant::now() + Duration::from_secs(20);
    while !session_file.is_file() && Instant::now() < deadline {
        if let Some(status) = service
            .child
            .try_wait()
            .expect("service status must be readable")
        {
            let mut stderr = String::new();
            service
                .child
                .stderr
                .take()
                .expect("service stderr must be piped")
                .read_to_string(&mut stderr)
                .expect("service stderr must be readable");
            panic!("real service exited before publishing CLI discovery with {status}: {stderr}");
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        session_file.is_file(),
        "real service must publish CLI discovery"
    );

    let cwd = working_directory.to_str().expect("test path must be UTF-8");
    let created = run_cli(
        &session_file,
        &[
            "workspace",
            "create",
            "--name",
            "Minimal real CLI workspace",
            "--working-directory",
            cwd,
        ],
    );
    assert!(created["revision"].is_u64());
    let (workspace_id, pane_id, initial_tabs, initial_panes) =
        selected_pane_id(&created, "Minimal real CLI workspace");
    let workspace_id = workspace_id.to_owned();
    let pane_id = pane_id.to_owned();

    let terminal = run_cli(
        &session_file,
        &[
            "terminal",
            "create",
            "--workspace-id",
            &workspace_id,
            "--pane-id",
            &pane_id,
            "--cwd",
            cwd,
        ],
    );
    assert!(terminal["revision"].is_u64());
    let (_, _, terminal_tabs, terminal_panes) =
        selected_pane_id(&terminal, "Minimal real CLI workspace");
    assert_eq!(terminal_tabs, initial_tabs + 1);
    assert_eq!(terminal_panes, initial_panes);

    let split = run_cli(
        &session_file,
        &[
            "pane",
            "split",
            "--workspace-id",
            &workspace_id,
            "--target-pane-id",
            &pane_id,
            "--axis",
            "vertical",
            "terminal",
            "--cwd",
            cwd,
        ],
    );
    assert!(split["revision"].is_u64());
    let (_, _, split_tabs, split_panes) = selected_pane_id(&split, "Minimal real CLI workspace");
    assert_eq!(split_tabs, terminal_tabs + 1);
    assert_eq!(split_panes, terminal_panes + 1);

    let service_pid = service.stop_from_parent_channel();
    assert!(
        !session_file.exists(),
        "service shutdown must remove CLI discovery"
    );
    assert!(
        !endpoint.exists(),
        "service shutdown must remove the control socket"
    );
    if std::env::var_os("AGENT_WORKSPACE_PROBE_EVIDENCE").is_some() {
        eprintln!(
            "[parent-channel-probe] service={service_pid} exit=0 session=removed socket=removed"
        );
    }
}

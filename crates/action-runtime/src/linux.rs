//! Linux per-invocation custom-action containment.
//!
//! Retained descriptors close the validation-to-use race. Bubblewrap receives those descriptors
//! directly (never caller-selected paths), and systemd places bubblewrap in a unique cgroup scope
//! before it can execute the action. Every return path kills and verifies that scope is empty.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Seek as _, SeekFrom, Write as _};
use std::os::fd::{AsRawFd as _, OwnedFd};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_workspace_config::{ProjectActionExecutable, ProjectActionWorkingDirectory};
use command_fds::{CommandFdExt as _, FdMapping};
use rustix::fs::{
    FileType, MemfdFlags, Mode, OFlags, ResolveFlags, SealFlags, fcntl_add_seals, fstat,
    memfd_create, open, openat2,
};
use tokio::process::{Child, Command};
use uuid::Uuid;

use super::{
    CancellationToken, ContainmentAvailability, ExecutionError, ExecutionPolicy, ExecutionRequest,
    ExecutionResult, ExitClass, finish_capture, read_redacted_bounded, redaction_values,
    resolve_environment, validate_exact_action, validate_policy, verify_trust,
};

const SYSTEMD_RUN: &str = "/usr/bin/systemd-run";
const SYSTEMCTL: &str = "/usr/bin/systemctl";
const BWRAP: &str = "/usr/bin/bwrap";
const XARGS: &str = "/usr/bin/xargs";
const ENV: &str = "/usr/bin/env";
const TRUE: &str = "/usr/bin/true";
const CGROUP_CONTROLLERS: &str = "/sys/fs/cgroup/cgroup.controllers";
const MAX_PAYLOAD_BYTES: usize = 128 * 1024;
const EMPTY_PROOF_TIMEOUT: Duration = Duration::from_secs(5);
const EMPTY_PROOF_INTERVAL: Duration = Duration::from_millis(20);

pub(super) async fn availability() -> ContainmentAvailability {
    if let Err(unavailable) = prerequisite_availability() {
        return unavailable;
    }

    let unit = unique_unit("probe");
    let mut scope = ScopeGuard::new(unit.clone());
    let mut command = base_systemd_run(&unit);
    command
        .arg(BWRAP)
        .args(fixed_probe_bwrap_arguments())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return ContainmentAvailability::UserManagerUnavailable;
    };
    if scope.attach_launcher(&child).is_err() {
        return ContainmentAvailability::SupervisionUnavailable;
    }
    let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return ContainmentAvailability::UserManagerUnavailable,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            scope.launcher_exited();
            return ContainmentAvailability::NamespaceUnavailable;
        }
    };
    scope.launcher_exited();
    if scope.terminate_and_verify().await.is_err() {
        return ContainmentAvailability::SupervisionUnavailable;
    }
    scope.disarm();
    if status.success() {
        ContainmentAvailability::Available
    } else {
        ContainmentAvailability::NamespaceUnavailable
    }
}

pub(super) async fn execute(
    policy: &ExecutionPolicy,
    request: &ExecutionRequest,
    cancellation: &CancellationToken,
) -> Result<ExecutionResult, ExecutionError> {
    validate_policy(policy)?;
    if cancellation.is_cancelled() {
        return Ok(super::empty_terminated_result(ExitClass::Cancelled));
    }
    let prepared = PreparedInvocation::new(policy, request)?;
    prerequisite_availability().map_err(|_| ExecutionError::ContainmentUnsupported)?;
    let redactions = Arc::new(redaction_values(policy, &prepared.environment));
    let unit = unique_unit("action");
    let start = Instant::now();
    let (mut child, mut scope) = prepared.spawn(&unit)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ExecutionError::SupervisionFailed)?;
    let stderr = child
        .stderr
        .take()
        .ok_or(ExecutionError::SupervisionFailed)?;
    let mut stdout_task = tokio::spawn(read_redacted_bounded(
        stdout,
        policy.output_limit_bytes,
        Arc::clone(&redactions),
    ));
    let mut stderr_task = tokio::spawn(read_redacted_bounded(
        stderr,
        policy.output_limit_bytes,
        redactions,
    ));

    let outcome = tokio::select! {
        status = child.wait() => {
            let status = status.map_err(|_| ExecutionError::SupervisionFailed)?;
            scope.launcher_exited();
            WaitOutcome::Exited(status)
        },
        () = tokio::time::sleep(policy.timeout) => {
            terminate_launcher_and_scope(&mut child, &mut scope).await?;
            WaitOutcome::Terminated(ExitClass::TimedOut)
        }
        () = cancellation.cancelled() => {
            terminate_launcher_and_scope(&mut child, &mut scope).await?;
            WaitOutcome::Terminated(ExitClass::Cancelled)
        }
    };

    // systemd-run returns as soon as the original command exits. A setsid/fork descendant can
    // therefore still be live here; always kill the cgroup, even on ordinary success.
    scope.terminate_and_verify().await?;
    scope.disarm();
    let (stdout, stderr) = tokio::join!(
        finish_capture(&mut stdout_task),
        finish_capture(&mut stderr_task)
    );
    let (exit_class, exit_code) = classify(outcome);
    Ok(ExecutionResult {
        exit_class,
        exit_code,
        stdout: stdout?,
        stderr: stderr?,
        duration: start.elapsed(),
    })
}

async fn terminate_launcher_and_scope(
    child: &mut Child,
    scope: &mut ScopeGuard,
) -> Result<(), ExecutionError> {
    // Killing the launcher first closes the startup race: it cannot create a scope after a
    // not-found result from systemctl. If it already created the scope, the fixed systemctl calls
    // below kill every process in it.
    let _ = child.start_kill();
    scope.terminate_and_verify().await?;
    child
        .wait()
        .await
        .map_err(|_| ExecutionError::SupervisionFailed)?;
    scope.launcher_exited();
    Ok(())
}

#[derive(Clone, Copy)]
enum WaitOutcome {
    Exited(ExitStatus),
    Terminated(ExitClass),
}

fn classify(outcome: WaitOutcome) -> (ExitClass, Option<i32>) {
    match outcome {
        WaitOutcome::Exited(status) if status.success() => (ExitClass::Success, status.code()),
        WaitOutcome::Exited(status) if status.code().is_some() => {
            (ExitClass::Failure, status.code())
        }
        WaitOutcome::Exited(_) => (ExitClass::Signalled, None),
        WaitOutcome::Terminated(class) => (class, None),
    }
}

struct PreparedInvocation {
    retained: Vec<OwnedFd>,
    bwrap_arguments: Vec<OsString>,
    environment: BTreeMap<String, String>,
}

impl PreparedInvocation {
    fn new(policy: &ExecutionPolicy, request: &ExecutionRequest) -> Result<Self, ExecutionError> {
        let canonical_root = fs::canonicalize(&request.project_root)
            .map_err(|_| ExecutionError::InvalidProjectPath)?;
        let root = open_exact_absolute(&canonical_root, ExpectedType::Directory)
            .map_err(|()| ExecutionError::InvalidProjectPath)?;
        verify_trust(policy, &canonical_root, &request.manifest_bytes)?;
        validate_exact_action(policy, request)?;

        let executable = match &request.action.executable {
            ProjectActionExecutable::ProjectRelativePath { path } => {
                open_relative(&root, path, ExpectedType::Executable)
                    .map_err(|()| ExecutionError::InvalidExecutable)?
            }
            ProjectActionExecutable::ApprovedName { name } => {
                let mut matches = policy
                    .approved_executables
                    .iter()
                    .filter(|candidate| candidate.name == *name);
                let selected = matches
                    .next()
                    .ok_or(ExecutionError::ApprovedExecutableUnavailable)?;
                if matches.next().is_some() {
                    return Err(ExecutionError::ApprovedExecutableUnavailable);
                }
                let canonical = fs::canonicalize(&selected.path)
                    .map_err(|_| ExecutionError::ApprovedExecutableUnavailable)?;
                open_exact_absolute(&canonical, ExpectedType::Executable)
                    .map_err(|()| ExecutionError::ApprovedExecutableUnavailable)?
            }
        };
        let working_directory = match &request.action.working_directory {
            ProjectActionWorkingDirectory::ProjectRoot => {
                duplicate_path_fd(&root).map_err(|_| ExecutionError::InvalidWorkingDirectory)?
            }
            ProjectActionWorkingDirectory::ProjectRelativePath { path } => {
                open_relative(&root, path, ExpectedType::Directory)
                    .map_err(|()| ExecutionError::InvalidWorkingDirectory)?
            }
        };
        let file_indices = policy
            .file_argument_schemas
            .get(&request.action.id)
            .cloned()
            .unwrap_or_default();
        if file_indices
            .iter()
            .any(|index| *index >= request.action.args.len())
        {
            return Err(ExecutionError::InvalidFileArgument);
        }
        let mut file_arguments = Vec::with_capacity(file_indices.len());
        for index in &file_indices {
            let fd = open_relative(&root, &request.action.args[*index], ExpectedType::Regular)
                .map_err(|()| ExecutionError::InvalidFileArgument)?;
            file_arguments.push((*index, fd));
        }
        let environment = resolve_environment(policy, &request.action.environment)?;
        Self::assemble(
            root,
            executable,
            working_directory,
            file_arguments,
            &file_indices,
            environment,
            &request.action.args,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble(
        root: OwnedFd,
        executable: OwnedFd,
        working_directory: OwnedFd,
        file_arguments: Vec<(usize, OwnedFd)>,
        file_indices: &BTreeSet<usize>,
        environment: BTreeMap<String, String>,
        raw_arguments: &[String],
    ) -> Result<Self, ExecutionError> {
        let mut payload = Vec::new();
        for (name, value) in &environment {
            push_payload(&mut payload, &format!("{name}={value}"))?;
        }
        push_payload(&mut payload, "/run/action-executable")?;
        for (index, argument) in raw_arguments.iter().enumerate() {
            if file_indices.contains(&index) {
                push_payload(&mut payload, &format!("/run/action-file-{index}"))?;
            } else {
                push_payload(&mut payload, argument)?;
            }
        }
        let payload_item_count = environment
            .len()
            .checked_add(raw_arguments.len())
            .and_then(|count| count.checked_add(1))
            .ok_or(ExecutionError::InvalidActionDefinition)?
            .to_string();
        let payload_fd = sealed_payload(&payload)?;

        let mut retained = vec![payload_fd, root, executable, working_directory];
        retained.extend(file_arguments.into_iter().map(|(_, fd)| fd));
        let payload_raw = child_fd(0).to_string();
        let root_raw = child_fd(1).to_string();
        let executable_raw = child_fd(2).to_string();
        let working_raw = child_fd(3).to_string();
        let mut bwrap_arguments = fixed_bwrap_prefix();
        extend_args(&mut bwrap_arguments, ["--bind-fd", &root_raw, "/project"]);
        extend_args(
            &mut bwrap_arguments,
            ["--ro-bind-fd", &executable_raw, "/run/action-executable"],
        );
        extend_args(
            &mut bwrap_arguments,
            ["--bind-fd", &working_raw, "/workspace"],
        );
        for (file_slot, index) in (4..).zip(file_indices) {
            let raw = child_fd(file_slot).to_string();
            let destination = format!("/run/action-file-{index}");
            extend_args(&mut bwrap_arguments, ["--ro-bind-fd", &raw, &destination]);
        }
        extend_args(
            &mut bwrap_arguments,
            ["--ro-bind-data", &payload_raw, "/run/action-payload"],
        );
        extend_args(
            &mut bwrap_arguments,
            [
                "--chdir",
                "/workspace",
                XARGS,
                "-0",
                "-x",
                "-r",
                "-n",
                &payload_item_count,
                "-s",
                "131072",
                "-a",
                "/run/action-payload",
                "--",
                ENV,
                "-i",
            ],
        );
        Ok(Self {
            retained,
            bwrap_arguments,
            environment,
        })
    }

    fn spawn(self, unit: &str) -> Result<(Child, ScopeGuard), ExecutionError> {
        let mut command = base_systemd_run(unit);
        command
            .arg(BWRAP)
            .args(&self.bwrap_arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
            .fd_mappings(
                self.retained
                    .into_iter()
                    .enumerate()
                    .map(|(index, parent_fd)| FdMapping {
                        parent_fd,
                        child_fd: child_fd(index),
                    })
                    .collect(),
            )
            .map_err(|_| ExecutionError::SupervisionFailed)?;
        let mut scope = ScopeGuard::new(unit.to_owned());
        let child = command.spawn().map_err(|_| ExecutionError::SpawnFailed)?;
        scope.attach_launcher(&child)?;
        Ok((child, scope))
    }
}

struct ScopeGuard {
    unit: String,
    launcher_pid: Option<u32>,
    armed: bool,
}

impl ScopeGuard {
    const fn new(unit: String) -> Self {
        Self {
            unit,
            launcher_pid: None,
            armed: true,
        }
    }

    fn attach_launcher(&mut self, child: &Child) -> Result<(), ExecutionError> {
        self.launcher_pid = Some(child.id().ok_or(ExecutionError::SupervisionFailed)?);
        Ok(())
    }

    fn launcher_exited(&mut self) {
        self.launcher_pid = None;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn terminate_and_verify(&mut self) -> Result<(), ExecutionError> {
        if !self.armed {
            return Ok(());
        }
        let _ = systemctl(&["kill", "--kill-whom=all", "--signal=KILL", &self.unit]).await;
        let _ = systemctl(&["stop", &self.unit]).await;
        let deadline = Instant::now() + EMPTY_PROOF_TIMEOUT;
        loop {
            if scope_is_proven_empty(&self.unit).await? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ExecutionError::SupervisionFailed);
            }
            tokio::time::sleep(EMPTY_PROOF_INTERVAL).await;
        }
    }
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(pid) = self.launcher_pid.and_then(|raw| {
            i32::try_from(raw)
                .ok()
                .and_then(rustix::process::Pid::from_raw)
        }) {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
        }
        for arguments in [
            [
                "kill",
                "--kill-whom=all",
                "--signal=KILL",
                self.unit.as_str(),
            ],
            ["stop", "--no-block", "", self.unit.as_str()],
        ] {
            let mut command = std::process::Command::new(SYSTEMCTL);
            apply_bus_environment_std(&mut command);
            let filtered = arguments.into_iter().filter(|value| !value.is_empty());
            let _ = command
                .arg("--user")
                .args(filtered)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

async fn scope_is_proven_empty(unit: &str) -> Result<bool, ExecutionError> {
    let output = systemctl(&[
        "show",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=ControlGroup",
        "--value",
        unit,
    ])
    .await?;
    if !output.status.success() {
        return Err(ExecutionError::SupervisionFailed);
    }
    let values = String::from_utf8(output.stdout).map_err(|_| ExecutionError::SupervisionFailed)?;
    let mut lines = values.lines();
    let load = lines.next().unwrap_or_default();
    let active = lines.next().unwrap_or_default();
    let cgroup = lines.next().unwrap_or_default();
    Ok((load == "not-found" || active == "inactive" || active == "failed") && cgroup.is_empty())
}

async fn systemctl(arguments: &[&str]) -> Result<std::process::Output, ExecutionError> {
    let mut command = Command::new(SYSTEMCTL);
    apply_bus_environment(&mut command);
    command
        .arg("--user")
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|_| ExecutionError::SupervisionFailed)
}

fn base_systemd_run(unit: &str) -> Command {
    let mut command = Command::new(SYSTEMD_RUN);
    apply_bus_environment(&mut command);
    command.args([
        "--user",
        "--scope",
        "--quiet",
        "--expand-environment=no",
        "--description=Agent workspace custom action",
        "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes",
        "--property=TimeoutStopSec=1s",
        "--unit",
        unit,
    ]);
    command
}

fn apply_bus_environment(command: &mut Command) {
    let (runtime, bus) = fixed_bus_environment();
    command
        .env_clear()
        .env("XDG_RUNTIME_DIR", runtime)
        .env("DBUS_SESSION_BUS_ADDRESS", bus);
}

fn apply_bus_environment_std(command: &mut std::process::Command) {
    let (runtime, bus) = fixed_bus_environment();
    command
        .env_clear()
        .env("XDG_RUNTIME_DIR", runtime)
        .env("DBUS_SESSION_BUS_ADDRESS", bus);
}

fn fixed_bus_environment() -> (String, String) {
    let uid = rustix::process::getuid().as_raw();
    let runtime = format!("/run/user/{uid}");
    let bus = format!("unix:path={runtime}/bus");
    (runtime, bus)
}

fn prerequisite_availability() -> Result<(), ContainmentAvailability> {
    if !Path::new(CGROUP_CONTROLLERS).is_file() {
        return Err(ContainmentAvailability::CgroupV2Unavailable);
    }
    for helper in [SYSTEMD_RUN, SYSTEMCTL, BWRAP, XARGS, ENV, TRUE] {
        validate_fixed_helper(Path::new(helper))?;
    }
    Ok(())
}

fn validate_fixed_helper(path: &Path) -> Result<(), ContainmentAvailability> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ContainmentAvailability::MissingPrerequisite)?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.mode() & 0o111 == 0
    {
        return Err(ContainmentAvailability::MissingPrerequisite);
    }
    Ok(())
}

fn fixed_probe_bwrap_arguments() -> Vec<OsString> {
    let mut arguments = fixed_bwrap_prefix();
    arguments.push(TRUE.into());
    arguments
}

fn fixed_bwrap_prefix() -> Vec<OsString> {
    [
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/run",
        "--dir",
        "/project",
        "--dir",
        "/workspace",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib",
        "/lib64",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn extend_args<'a>(target: &mut Vec<OsString>, values: impl IntoIterator<Item = &'a str>) {
    target.extend(values.into_iter().map(OsString::from));
}

#[derive(Clone, Copy)]
enum ExpectedType {
    Directory,
    Regular,
    Executable,
}

fn open_exact_absolute(path: &Path, expected: ExpectedType) -> Result<OwnedFd, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let fd = open(
        path,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| ())?;
    validate_fd(&fd, expected)?;
    let proc_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    if fs::canonicalize(proc_path).map_err(|_| ())? != path {
        return Err(());
    }
    Ok(fd)
}

fn open_relative(root: &OwnedFd, relative: &str, expected: ExpectedType) -> Result<OwnedFd, ()> {
    if !valid_relative_path(relative) {
        return Err(());
    }
    let fd = openat2(
        root,
        relative,
        OFlags::PATH | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS | ResolveFlags::NO_XDEV,
    )
    .map_err(|_| ())?;
    validate_fd(&fd, expected)?;
    Ok(fd)
}

fn duplicate_path_fd(fd: &OwnedFd) -> rustix::io::Result<OwnedFd> {
    rustix::io::fcntl_dupfd_cloexec(fd, 0)
}

fn validate_fd(fd: &OwnedFd, expected: ExpectedType) -> Result<(), ()> {
    let stat = fstat(fd).map_err(|_| ())?;
    let file_type = FileType::from_raw_mode(stat.st_mode);
    match expected {
        ExpectedType::Directory if file_type.is_dir() => Ok(()),
        ExpectedType::Regular if file_type.is_file() => Ok(()),
        ExpectedType::Executable if file_type.is_file() && stat.st_mode & 0o111 != 0 => Ok(()),
        _ => Err(()),
    }
}

fn valid_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn push_payload(payload: &mut Vec<u8>, value: &str) -> Result<(), ExecutionError> {
    if value.as_bytes().contains(&0) {
        return Err(ExecutionError::InvalidActionDefinition);
    }
    let next = payload
        .len()
        .checked_add(value.len().saturating_add(1))
        .ok_or(ExecutionError::InvalidActionDefinition)?;
    if next > MAX_PAYLOAD_BYTES {
        return Err(ExecutionError::InvalidActionDefinition);
    }
    payload.extend_from_slice(value.as_bytes());
    payload.push(0);
    Ok(())
}

fn sealed_payload(payload: &[u8]) -> Result<OwnedFd, ExecutionError> {
    let fd = memfd_create(
        "agent-workspace-action-payload",
        MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
    )
    .map_err(|_| ExecutionError::SupervisionFailed)?;
    let mut file = File::from(fd);
    file.write_all(payload)
        .and_then(|()| file.seek(SeekFrom::Start(0)).map(|_| ()))
        .map_err(|_| ExecutionError::SupervisionFailed)?;
    fcntl_add_seals(
        &file,
        SealFlags::SEAL | SealFlags::SHRINK | SealFlags::GROW | SealFlags::WRITE,
    )
    .map_err(|_| ExecutionError::SupervisionFailed)?;
    Ok(file.into())
}

fn child_fd(index: usize) -> i32 {
    100_i32
        .checked_add(i32::try_from(index).expect("retained descriptor count fits i32"))
        .expect("retained descriptor number fits i32")
}

fn unique_unit(class: &str) -> String {
    format!("agent-workspace-{class}-{}.scope", Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn helper_validation_rejects_missing_and_writable_files() {
        let root = TempDir::new().unwrap();
        assert_eq!(
            validate_fixed_helper(&root.path().join("missing")),
            Err(ContainmentAvailability::MissingPrerequisite)
        );
        let helper = root.path().join("helper");
        fs::write(&helper, b"helper").unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            validate_fixed_helper(&helper),
            Err(ContainmentAvailability::MissingPrerequisite)
        );
    }

    #[test]
    fn relative_open_retains_identity_across_replacement() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("action");
        fs::write(&path, b"first").unwrap();
        let canonical = fs::canonicalize(root.path()).unwrap();
        let root_fd = open_exact_absolute(&canonical, ExpectedType::Directory).unwrap();
        let action_fd = open_relative(&root_fd, "action", ExpectedType::Regular).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"second").unwrap();
        let retained = fs::read(format!("/proc/self/fd/{}", action_fd.as_raw_fd())).unwrap();
        assert_eq!(retained, b"first");
    }

    #[test]
    fn retained_executable_working_directory_and_file_survive_replacement() {
        let root = TempDir::new().unwrap();
        let executable_path = root.path().join("action");
        let file_path = root.path().join("input");
        let working_path = root.path().join("working");
        fs::write(&executable_path, b"trusted-executable").unwrap();
        fs::set_permissions(&executable_path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&file_path, b"trusted-file").unwrap();
        fs::create_dir(&working_path).unwrap();
        let canonical = fs::canonicalize(root.path()).unwrap();
        let root_fd = open_exact_absolute(&canonical, ExpectedType::Directory).unwrap();
        let executable = open_relative(&root_fd, "action", ExpectedType::Executable).unwrap();
        let file = open_relative(&root_fd, "input", ExpectedType::Regular).unwrap();
        let working = open_relative(&root_fd, "working", ExpectedType::Directory).unwrap();

        fs::rename(&executable_path, root.path().join("old-action")).unwrap();
        fs::write(&executable_path, b"replacement-executable").unwrap();
        fs::rename(&file_path, root.path().join("old-input")).unwrap();
        fs::write(&file_path, b"replacement-file").unwrap();
        fs::rename(&working_path, root.path().join("old-working")).unwrap();
        fs::create_dir(&working_path).unwrap();

        assert_eq!(
            fs::read(format!("/proc/self/fd/{}", executable.as_raw_fd())).unwrap(),
            b"trusted-executable"
        );
        assert_eq!(
            fs::read(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap(),
            b"trusted-file"
        );
        fs::write(
            format!("/proc/self/fd/{}/marker", working.as_raw_fd()),
            b"retained",
        )
        .unwrap();
        assert_eq!(
            fs::read(root.path().join("old-working/marker")).unwrap(),
            b"retained"
        );
        assert!(!root.path().join("working/marker").exists());
    }

    #[test]
    fn relative_open_rejects_symlink_and_mount_escape_syntax() {
        let root = TempDir::new().unwrap();
        let canonical = fs::canonicalize(root.path()).unwrap();
        let root_fd = open_exact_absolute(&canonical, ExpectedType::Directory).unwrap();
        for value in ["../outside", "/outside", "a/../../outside", ""] {
            assert!(open_relative(&root_fd, value, ExpectedType::Regular).is_err());
        }
    }

    #[test]
    fn payload_is_nul_delimited_sealed_and_bounded() {
        let mut payload = Vec::new();
        push_payload(&mut payload, "literal;$HOME").unwrap();
        assert_eq!(payload, b"literal;$HOME\0");
        let fd = sealed_payload(&payload).unwrap();
        assert!(
            fcntl_add_seals(&fd, SealFlags::WRITE).is_err(),
            "seal itself must already be sealed"
        );
        let oversized = "x".repeat(MAX_PAYLOAD_BYTES);
        assert_eq!(
            push_payload(&mut Vec::new(), &oversized),
            Err(ExecutionError::InvalidActionDefinition)
        );
    }

    #[test]
    fn command_construction_contains_no_raw_payload() {
        let root = TempDir::new().unwrap();
        let action = root.path().join("action");
        fs::write(&action, b"action").unwrap();
        let mut permissions = fs::metadata(&action).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&action, permissions).unwrap();
        let canonical = fs::canonicalize(root.path()).unwrap();
        let root_fd = open_exact_absolute(&canonical, ExpectedType::Directory).unwrap();
        let executable = open_relative(&root_fd, "action", ExpectedType::Executable).unwrap();
        let working = duplicate_path_fd(&root_fd).unwrap();
        let prepared = PreparedInvocation::assemble(
            root_fd,
            executable,
            working,
            Vec::new(),
            &BTreeSet::new(),
            BTreeMap::from([("SAFE".into(), "raw-secret".into())]),
            &["raw-argument".into()],
        )
        .unwrap();
        let rendered = prepared
            .bwrap_arguments
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!rendered.contains("raw-secret"));
        assert!(!rendered.contains("raw-argument"));
        assert!(!rendered.contains(root.path().to_string_lossy().as_ref()));
    }

    #[tokio::test]
    async fn exact_host_probe_either_succeeds_or_reports_a_stable_prerequisite_class() {
        let availability = super::availability().await;
        assert!(matches!(
            availability,
            ContainmentAvailability::Available
                | ContainmentAvailability::MissingPrerequisite
                | ContainmentAvailability::CgroupV2Unavailable
                | ContainmentAvailability::UserManagerUnavailable
                | ContainmentAvailability::NamespaceUnavailable
                | ContainmentAvailability::SupervisionUnavailable
        ));
    }
}

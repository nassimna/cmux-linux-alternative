//! Fail-closed execution of trusted project custom actions.
//!
//! This crate is the filesystem and process boundary for the lexical contracts in
//! `agent-workspace-config`. It deliberately exposes summaries separately from execution inputs:
//! summaries, audit records, `Debug`, and errors never contain argv, environment values, captured
//! output, or absolute paths.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use agent_workspace_config::{
    ActionConfig, ProjectActionDefinition, ProjectActionExecutable, ProjectActionManifest,
    TrustedProjectRecord,
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

#[cfg(target_os = "linux")]
mod linux;

/// Hard ceiling for caller-selected output limits.
pub const MAX_CAPTURE_BYTES: usize = 32 * 1024;
/// Hard ceiling for caller-selected execution timeouts.
pub const MAX_TIMEOUT: Duration = Duration::from_mins(5);

const REDACTION_REPLACEMENT: &[u8] = b"[REDACTED]";
const MAX_SENSITIVE_VALUE_BYTES: usize = 4096;
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(250);

/// An application-owned exact mapping from an approved bare name to an executable path.
pub struct ApprovedExecutable {
    /// Exact bare name present in the validated manifest.
    pub name: String,
    /// Trusted absolute executable path. It is canonicalized again before every spawn.
    pub path: PathBuf,
}

/// Service-owned execution policy. Project data cannot construct or downgrade this policy.
pub struct ExecutionPolicy {
    /// Exact trust grants created by trusted UI.
    pub trusted_projects: Vec<TrustedProjectRecord>,
    /// Fixed approved-name resolution; duplicate names fail closed as ambiguous.
    pub approved_executables: Vec<ApprovedExecutable>,
    /// Safe environment values available for requested-name pass-through.
    pub safe_environment: BTreeMap<String, String>,
    /// Additional values that must be removed from captured output.
    pub redaction_values: Vec<String>,
    /// Service-owned file-argument indexes keyed by action ID.
    pub file_argument_schemas: BTreeMap<String, BTreeSet<usize>>,
    /// Per-stream capture limit.
    pub output_limit_bytes: usize,
    /// Maximum execution duration.
    pub timeout: Duration,
}

impl fmt::Debug for ExecutionPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionPolicy")
            .field("summary", &self.summary())
            .finish()
    }
}

impl ExecutionPolicy {
    /// Returns a content-free policy summary suitable for diagnostics.
    #[must_use]
    pub fn summary(&self) -> PolicySummary {
        PolicySummary {
            trusted_project_count: self.trusted_projects.len(),
            approved_executable_count: self.approved_executables.len(),
            available_environment_name_count: self.safe_environment.len(),
            file_argument_schema_count: self.file_argument_schemas.len(),
            output_limit_bytes: self.output_limit_bytes,
            timeout_ms: duration_millis(self.timeout),
        }
    }
}

/// One exact trusted invocation. Manifest bytes are hashed, never parsed or logged here.
pub struct ExecutionRequest {
    /// Durable invocation identifier used only in content-free audit output.
    pub invocation_id: String,
    /// Validated action definition selected from `manifest_bytes`.
    pub action: ProjectActionDefinition,
    /// Authorized project root. It is canonicalized immediately before spawn.
    pub project_root: PathBuf,
    /// Exact manifest bytes whose digest must match the root trust record.
    pub manifest_bytes: Vec<u8>,
}

impl ExecutionRequest {
    /// Returns a content-free request summary suitable for tracing and audit preparation.
    #[must_use]
    pub fn summary(&self) -> RequestSummary {
        RequestSummary {
            invocation_id: safe_summary_id(&self.invocation_id),
            action_id: safe_summary_id(&self.action.id),
            argument_count: self.action.args.len(),
            requested_environment_name_count: self.action.environment.len(),
            executable_class: match self.action.executable {
                ProjectActionExecutable::ProjectRelativePath { .. } => {
                    ExecutableClass::ProjectRelative
                }
                ProjectActionExecutable::ApprovedName { .. } => ExecutableClass::ApprovedName,
            },
        }
    }
}

impl fmt::Debug for ExecutionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionRequest")
            .field("summary", &self.summary())
            .finish()
    }
}

/// Cooperative cancellation for one execution.
#[derive(Clone, Default)]
pub struct CancellationToken {
    inner: Arc<CancellationInner>,
}

#[derive(Default)]
struct CancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancellationToken {
    /// Requests cancellation. Repeated calls are harmless.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
    }

    /// Returns whether cancellation has already been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

impl fmt::Debug for CancellationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

/// Content-free executable category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutableClass {
    /// Executable is confined under the trusted project root.
    ProjectRelative,
    /// Executable is selected through fixed application-owned name resolution.
    ApprovedName,
}

/// Safe policy metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicySummary {
    pub trusted_project_count: usize,
    pub approved_executable_count: usize,
    pub available_environment_name_count: usize,
    pub file_argument_schema_count: usize,
    pub output_limit_bytes: usize,
    pub timeout_ms: u64,
}

/// Safe request metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestSummary {
    pub invocation_id: String,
    pub action_id: String,
    pub argument_count: usize,
    pub requested_environment_name_count: usize,
    pub executable_class: ExecutableClass,
}

/// Why a process ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitClass {
    Success,
    Failure,
    Signalled,
    TimedOut,
    Cancelled,
}

/// Captured output after value redaction and byte bounding.
#[derive(Clone, Eq, PartialEq)]
pub struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
    redaction_count: usize,
}

impl CapturedOutput {
    /// Redacted, bounded bytes. Consumers must not persist them in audit state.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub const fn truncated(&self) -> bool {
        self.truncated
    }

    #[must_use]
    pub const fn redaction_count(&self) -> usize {
        self.redaction_count
    }
}

impl fmt::Debug for CapturedOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedOutput")
            .field("byte_count", &self.bytes.len())
            .field("truncated", &self.truncated)
            .field("redaction_count", &self.redaction_count)
            .finish()
    }
}

/// Execution result. Its `Debug` representation is content-free.
pub struct ExecutionResult {
    pub exit_class: ExitClass,
    pub exit_code: Option<i32>,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
    pub duration: Duration,
}

impl ExecutionResult {
    #[must_use]
    pub fn summary(&self) -> ResultSummary {
        ResultSummary {
            exit_class: self.exit_class,
            exit_code: self.exit_code,
            stdout_bytes: self.stdout.bytes.len(),
            stderr_bytes: self.stderr.bytes.len(),
            output_truncated: self.stdout.truncated || self.stderr.truncated,
            redaction_count: self.stdout.redaction_count + self.stderr.redaction_count,
            duration_ms: duration_millis(self.duration),
        }
    }

    #[must_use]
    pub fn audit(&self, request: &ExecutionRequest) -> AuditSummary {
        let summary = self.summary();
        let request_summary = request.summary();
        AuditSummary {
            invocation_id: request_summary.invocation_id,
            action_id: request_summary.action_id,
            executable_class: request_summary.executable_class,
            exit_class: summary.exit_class,
            exit_code: summary.exit_code,
            stdout_bytes: summary.stdout_bytes,
            stderr_bytes: summary.stderr_bytes,
            output_truncated: summary.output_truncated,
            redaction_count: summary.redaction_count,
            duration_ms: summary.duration_ms,
        }
    }
}

impl fmt::Debug for ExecutionResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionResult")
            .field("summary", &self.summary())
            .finish()
    }
}

/// Safe result metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResultSummary {
    pub exit_class: ExitClass,
    pub exit_code: Option<i32>,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub output_truncated: bool,
    pub redaction_count: usize,
    pub duration_ms: u64,
}

/// Content-free audit record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditSummary {
    pub invocation_id: String,
    pub action_id: String,
    pub executable_class: ExecutableClass,
    pub exit_class: ExitClass,
    pub exit_code: Option<i32>,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub output_truncated: bool,
    pub redaction_count: usize,
    pub duration_ms: u64,
}

/// Stable, content-free runtime failures.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ExecutionError {
    #[error("invalid action execution policy")]
    InvalidPolicy,
    #[error("the action request is not an exact validated member of the trusted manifest")]
    InvalidActionDefinition,
    #[error("project trust binding is absent or stale")]
    UntrustedProject,
    #[error("an authorized project path failed validation")]
    InvalidProjectPath,
    #[error("the action executable failed validation")]
    InvalidExecutable,
    #[error("approved executable resolution is missing or ambiguous")]
    ApprovedExecutableUnavailable,
    #[error("the action working directory failed validation")]
    InvalidWorkingDirectory,
    #[error("a declared file argument failed validation")]
    InvalidFileArgument,
    #[error("the requested environment is not permitted")]
    EnvironmentDenied,
    #[error("safe process-tree containment is unsupported on this platform")]
    ContainmentUnsupported,
    #[error("the action process could not be started")]
    SpawnFailed,
    #[error("the action process could not be supervised safely")]
    SupervisionFailed,
}

/// Result of the exact Linux containment availability probe.
///
/// The variants are deliberately content-free: they can be used in diagnostics without exposing
/// helper paths, command data, environment values, or output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContainmentAvailability {
    /// A transient user scope and an isolated bubblewrap process completed and were proven empty.
    Available,
    /// This backend is intentionally Linux-only.
    UnsupportedPlatform,
    /// At least one fixed, root-owned helper is absent or fails ownership/mode validation.
    MissingPrerequisite,
    /// The host is not using the unified cgroup v2 hierarchy.
    CgroupV2Unavailable,
    /// The per-user systemd manager could not create a transient scope.
    UserManagerUnavailable,
    /// The kernel or host policy refused the required namespace and mount isolation.
    NamespaceUnavailable,
    /// The probe scope could not be killed and proven empty.
    SupervisionUnavailable,
}

impl ContainmentAvailability {
    /// Whether secure custom-action execution can be attempted on this host.
    #[must_use]
    pub const fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }
}

/// Performs the exact fail-closed containment probe used by the control plane.
///
/// This executes only fixed application-owned helper paths with fixed arguments. It creates a
/// unique transient user scope, enters all required bubblewrap namespaces, exits, kills the whole
/// scope, and verifies that the scope has no remaining cgroup.
pub async fn containment_availability() -> ContainmentAvailability {
    #[cfg(target_os = "linux")]
    {
        linux::availability().await
    }

    #[cfg(not(target_os = "linux"))]
    {
        ContainmentAvailability::UnsupportedPlatform
    }
}

/// Execute a trusted action with direct argv and Linux per-invocation containment.
///
/// Filesystem identities are retained as descriptors across spawn. Linux executes in a unique
/// systemd cgroup and a bubblewrap mount/PID/network namespace; all other platforms fail closed.
///
/// # Errors
///
/// Returns a content-free [`ExecutionError`] when policy, trust, filesystem authorization, spawn,
/// or process supervision cannot be established safely.
pub async fn execute(
    policy: &ExecutionPolicy,
    request: &ExecutionRequest,
    cancellation: &CancellationToken,
) -> Result<ExecutionResult, ExecutionError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (policy, request, cancellation);
        return Err(ExecutionError::ContainmentUnsupported);
    }

    #[cfg(target_os = "linux")]
    linux::execute(policy, request, cancellation).await
}

/// Computes the exact digest that trusted confirmation state should bind as its definition hash.
///
/// It covers the exact manifest bytes, selected definition, and service-owned file-argument
/// schema. Invocation ID, provider/window generation, and expiry are control-server state inputs.
///
/// # Errors
///
/// Returns a content-free error when policy or exact manifest membership is invalid.
pub fn confirmation_definition_sha256(
    policy: &ExecutionPolicy,
    request: &ExecutionRequest,
) -> Result<String, ExecutionError> {
    validate_policy(policy)?;
    validate_exact_action(policy, request)?;
    let action_bytes =
        serde_json::to_vec(&request.action).map_err(|_| ExecutionError::InvalidActionDefinition)?;
    let mut digest = Sha256::new();
    digest.update(b"agent-workspace-action-confirmation-v1\0");
    digest.update(Sha256::digest(&request.manifest_bytes));
    digest.update(
        u64::try_from(action_bytes.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    digest.update(action_bytes);
    if let Some(indices) = policy.file_argument_schemas.get(&request.action.id) {
        for index in indices {
            digest.update(u64::try_from(*index).unwrap_or(u64::MAX).to_be_bytes());
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn validate_policy(policy: &ExecutionPolicy) -> Result<(), ExecutionError> {
    if policy.output_limit_bytes == 0
        || policy.output_limit_bytes > MAX_CAPTURE_BYTES
        || policy.timeout.is_zero()
        || policy.timeout > MAX_TIMEOUT
        || policy.approved_executables.len() > 64
        || policy.safe_environment.len() > 64
        || policy.redaction_values.len() > 128
        || policy.file_argument_schemas.len() > 64
    {
        return Err(ExecutionError::InvalidPolicy);
    }
    let mut approved = BTreeSet::new();
    if policy.approved_executables.iter().any(|item| {
        !valid_bare_name(&item.name)
            || !item.path.is_absolute()
            || !approved.insert(item.name.as_str())
    }) {
        return Err(ExecutionError::InvalidPolicy);
    }
    if policy.safe_environment.iter().any(|(name, value)| {
        !valid_environment_name(name)
            || forbidden_environment_name(name)
            || value.len() > MAX_SENSITIVE_VALUE_BYTES
            || value.as_bytes().contains(&0)
    }) || policy
        .redaction_values
        .iter()
        .any(|value| value.len() > MAX_SENSITIVE_VALUE_BYTES)
    {
        return Err(ExecutionError::InvalidPolicy);
    }
    if policy
        .file_argument_schemas
        .iter()
        .any(|(action_id, indices)| {
            safe_summary_id(action_id) != *action_id || indices.iter().any(|index| *index >= 64)
        })
    {
        return Err(ExecutionError::InvalidPolicy);
    }
    Ok(())
}

fn verify_trust(
    policy: &ExecutionPolicy,
    canonical_root: &Path,
    manifest_bytes: &[u8],
) -> Result<(), ExecutionError> {
    let root = canonical_root
        .to_str()
        .ok_or(ExecutionError::UntrustedProject)?;
    let supplied: [u8; 32] = Sha256::digest(manifest_bytes).into();
    let trusted = policy.trusted_projects.iter().any(|record| {
        record.canonical_root == root
            && decode_digest(&record.manifest_sha256)
                .is_some_and(|expected| supplied.ct_eq(&expected).into())
    });
    if trusted {
        Ok(())
    } else {
        Err(ExecutionError::UntrustedProject)
    }
}

fn validate_exact_action(
    policy: &ExecutionPolicy,
    request: &ExecutionRequest,
) -> Result<(), ExecutionError> {
    let manifest_policy = ActionConfig {
        approved_executables: policy
            .approved_executables
            .iter()
            .map(|executable| executable.name.clone())
            .collect(),
        trusted_projects: Vec::new(),
    };
    let manifest = ProjectActionManifest::parse_json(&request.manifest_bytes, &manifest_policy)
        .map_err(|_| ExecutionError::InvalidActionDefinition)?;
    let exact_member = manifest
        .actions
        .iter()
        .any(|candidate| candidate.id == request.action.id && candidate == &request.action);
    if exact_member {
        Ok(())
    } else {
        Err(ExecutionError::InvalidActionDefinition)
    }
}

fn decode_digest(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        output[index] = high << 4 | low;
    }
    Some(output)
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn resolve_environment(
    policy: &ExecutionPolicy,
    requested: &[String],
) -> Result<BTreeMap<String, String>, ExecutionError> {
    let mut output = BTreeMap::new();
    for name in requested {
        if forbidden_environment_name(name) || !valid_environment_name(name) {
            return Err(ExecutionError::EnvironmentDenied);
        }
        let value = policy
            .safe_environment
            .get(name)
            .ok_or(ExecutionError::EnvironmentDenied)?;
        output.insert(name.clone(), value.clone());
    }
    Ok(output)
}

fn redaction_values(
    policy: &ExecutionPolicy,
    environment: &BTreeMap<String, String>,
) -> Vec<Vec<u8>> {
    policy
        .redaction_values
        .iter()
        .chain(environment.values())
        .filter(|value| !value.is_empty())
        .map(|value| value.as_bytes().to_vec())
        .collect()
}

async fn read_redacted_bounded(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    values: Arc<Vec<Vec<u8>>>,
) -> Result<CapturedOutput, ExecutionError> {
    let overlap = values
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(1)
        .saturating_sub(1);
    let mut pending = Vec::with_capacity(overlap.saturating_add(8192));
    let mut output = Vec::with_capacity(limit);
    let mut truncated = false;
    let mut redaction_count = 0usize;
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|_| ExecutionError::SupervisionFailed)?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..count]);
        process_redactions(
            &mut pending,
            &values,
            overlap,
            false,
            &mut output,
            limit,
            &mut truncated,
            &mut redaction_count,
        );
    }
    process_redactions(
        &mut pending,
        &values,
        0,
        true,
        &mut output,
        limit,
        &mut truncated,
        &mut redaction_count,
    );
    Ok(CapturedOutput {
        bytes: output,
        truncated,
        redaction_count,
    })
}

async fn finish_capture(
    task: &mut JoinHandle<Result<CapturedOutput, ExecutionError>>,
) -> Result<CapturedOutput, ExecutionError> {
    if let Ok(result) = tokio::time::timeout(OUTPUT_DRAIN_GRACE, &mut *task).await {
        result.map_err(|_| ExecutionError::SupervisionFailed)?
    } else {
        task.abort();
        let _ = task.await;
        Ok(CapturedOutput {
            bytes: Vec::new(),
            truncated: true,
            redaction_count: 0,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn process_redactions(
    pending: &mut Vec<u8>,
    values: &[Vec<u8>],
    overlap: usize,
    eof: bool,
    output: &mut Vec<u8>,
    limit: usize,
    truncated: &mut bool,
    redaction_count: &mut usize,
) {
    loop {
        if let Some((start, length)) = next_redaction(pending, values) {
            append_bounded(output, &pending[..start], limit, truncated);
            append_bounded(output, REDACTION_REPLACEMENT, limit, truncated);
            pending.drain(..start + length);
            *redaction_count = redaction_count.saturating_add(1);
            continue;
        }
        let safe_length = if eof {
            pending.len()
        } else {
            pending.len().saturating_sub(overlap)
        };
        append_bounded(output, &pending[..safe_length], limit, truncated);
        pending.drain(..safe_length);
        break;
    }
}

fn next_redaction(haystack: &[u8], values: &[Vec<u8>]) -> Option<(usize, usize)> {
    values
        .iter()
        .filter_map(|value| find_bytes(haystack, value).map(|index| (index, value.len())))
        .min_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1)))
}

fn append_bounded(output: &mut Vec<u8>, value: &[u8], limit: usize, truncated: &mut bool) {
    let remaining = limit.saturating_sub(output.len());
    output.extend_from_slice(&value[..value.len().min(remaining)]);
    if value.len() > remaining {
        *truncated = true;
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn valid_bare_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
}

fn valid_environment_name(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn forbidden_environment_name(value: &str) -> bool {
    value.contains("TOKEN")
        || value.contains("SECRET")
        || value.contains("PASSWORD")
        || value.contains("PASSWD")
        || value.contains("CREDENTIAL")
        || value.contains("AUTH")
        || value.contains("COOKIE")
        || value.contains("JWT")
        || value.ends_with("KEY")
        || value == "DATABASE_URL"
        || value.split('_').any(|segment| {
            matches!(
                segment,
                "KEY"
                    | "TOKEN"
                    | "SECRET"
                    | "PASSWORD"
                    | "PASSWD"
                    | "CREDENTIAL"
                    | "CREDENTIALS"
                    | "AUTHORIZATION"
                    | "COOKIE"
            )
        })
        || matches!(
            value,
            "AGENT_WORKSPACE_AUTH"
                | "SSH_AUTH_SOCK"
                | "GPG_AGENT_INFO"
                | "XAUTHORITY"
                | "DBUS_SESSION_BUS_ADDRESS"
        )
}

fn empty_terminated_result(class: ExitClass) -> ExecutionResult {
    let empty = || CapturedOutput {
        bytes: Vec::new(),
        truncated: false,
        redaction_count: 0,
    };
    ExecutionResult {
        exit_class: class,
        exit_code: None,
        stdout: empty(),
        stderr: empty(),
        duration: Duration::ZERO,
    }
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn safe_summary_id(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        value.to_owned()
    } else {
        "[invalid]".to_owned()
    }
}

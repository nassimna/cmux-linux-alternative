//! Privacy-preserving diagnostics primitives.
//!
//! The crate provides two deliberately separate facilities:
//! [`RotatingJsonWriter`] writes bounded JSON Lines logs, while
//! [`DiagnosticBundleBuilder`] prepares an allow-listed, recursively redacted diagnostic export.
//! Bundle export requires the exact [`BundlePreview`] returned to the caller beforehand.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tracing_subscriber::fmt::MakeWriter;
use url::Url;

/// Default maximum serialized size of one log record, excluding its newline.
pub const DEFAULT_MAX_RECORD_BYTES: usize = 64 * 1024;
/// Default maximum size of the active JSONL file.
pub const DEFAULT_MAX_ACTIVE_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Default number of rotated files retained in addition to the active file.
pub const DEFAULT_RETAINED_FILES: usize = 5;
/// Default maximum age of a rotated file.
pub const DEFAULT_RETENTION_AGE: Duration = Duration::from_hours(168);
/// Fixed active log filename.
pub const ACTIVE_LOG_FILENAME: &str = "diagnostics.jsonl";
/// Diagnostic bundle format identifier.
pub const BUNDLE_FORMAT: &str = "agent-workspace-diagnostic-bundle-v1";

const REDACTED: &str = "[REDACTED]";
const TRUNCATED: &str = "[TRUNCATED]";
const MIN_RECORD_BYTES: usize = 128;
const MAX_ROTATION_ATTEMPTS: usize = 1_024;
const TEMP_ATTEMPTS: usize = 32;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Errors returned by logging, redaction preparation, and export.
///
/// Messages intentionally identify only the failed operation or invariant. User-provided values
/// and paths are never formatted into an error.
#[derive(Debug, Error)]
pub enum DiagnosticsError {
    /// A configuration bound is internally inconsistent or unsafe.
    #[error("invalid diagnostics configuration: {0}")]
    InvalidConfiguration(&'static str),
    /// A path component, file type, or platform security invariant is unsafe.
    #[error("unsafe diagnostics path: {0}")]
    UnsafePath(&'static str),
    /// A requested bundle entry name is unsafe or duplicated.
    #[error("invalid diagnostic entry name")]
    InvalidEntryName,
    /// The configured number of log-tail entries was exceeded.
    #[error("too many diagnostic log entries")]
    TooManyLogEntries,
    /// The final serialized bundle exceeds its configured maximum.
    #[error("diagnostic bundle exceeds configured size limit")]
    BundleTooLarge,
    /// The destination already exists; exports never overwrite any filesystem object.
    #[error("diagnostic export destination already exists")]
    DestinationExists,
    /// The supplied preview is not the exact preview of the current builder contents.
    #[error("diagnostic export does not match the approved preview")]
    PreviewMismatch,
    /// A shared writer mutex was poisoned by a panic.
    #[error("diagnostic writer state is unavailable")]
    LockPoisoned,
    /// A filesystem operation failed.
    #[error("diagnostic filesystem operation failed during {operation}: {source}")]
    Io {
        /// Stable operation name that contains no caller data.
        operation: &'static str,
        /// Underlying operating-system error, without path context.
        #[source]
        source: io::Error,
    },
    /// JSON serialization failed.
    #[error("diagnostic JSON serialization failed")]
    Json(#[from] serde_json::Error),
}

fn io_error(operation: &'static str, source: io::Error) -> DiagnosticsError {
    DiagnosticsError::Io { operation, source }
}

// This module is compiled on every target so CI on a Unix-only host still type-checks the
// standard-library-only fallback selected by `cfg(not(unix))`.
#[cfg_attr(unix, allow(dead_code))]
#[allow(clippy::unnecessary_wraps)] // Keep the fallible Unix hook signatures at call sites.
mod portable_security {
    use super::{DiagnosticsError, OpenOptions, Path, fs};

    pub(super) fn secure_directory_permissions(
        _path: &Path,
        _require_owner_only: bool,
    ) -> Result<(), DiagnosticsError> {
        Ok(())
    }

    pub(super) fn validate_directory_permissions(
        _metadata: &fs::Metadata,
        _require_owner_only: bool,
    ) -> Result<(), DiagnosticsError> {
        Ok(())
    }

    pub(super) fn configure_secure_open_options(_options: &mut OpenOptions) {}

    pub(super) fn secure_file_permissions(_path: &Path) -> Result<(), DiagnosticsError> {
        Ok(())
    }

    pub(super) fn validate_file_permissions(
        _metadata: &fs::Metadata,
    ) -> Result<(), DiagnosticsError> {
        Ok(())
    }

    pub(super) fn validate_link_count(_metadata: &fs::Metadata) -> Result<(), DiagnosticsError> {
        Ok(())
    }
}

#[cfg(not(unix))]
use portable_security::{
    configure_secure_open_options, secure_directory_permissions, secure_file_permissions,
    validate_directory_permissions, validate_file_permissions, validate_link_count,
};

/// Bounds and retention policy for [`RotatingJsonWriter`].
#[derive(Clone, Debug)]
pub struct LogConfig {
    /// Directory containing the active and rotated files. Unix mode is forced to `0700`.
    pub directory: PathBuf,
    /// Maximum serialized bytes in one JSON record, excluding the newline.
    pub max_record_bytes: usize,
    /// Maximum active-file bytes. Rotation occurs before a record would cross this bound.
    pub max_active_file_bytes: u64,
    /// Maximum number of rotated files retained.
    pub retained_files: usize,
    /// Maximum age of a rotated file.
    pub retention_age: Duration,
}

impl LogConfig {
    /// Creates a configuration with seven-day age retention and conservative size defaults.
    #[must_use]
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            max_record_bytes: DEFAULT_MAX_RECORD_BYTES,
            max_active_file_bytes: DEFAULT_MAX_ACTIVE_FILE_BYTES,
            retained_files: DEFAULT_RETAINED_FILES,
            retention_age: DEFAULT_RETENTION_AGE,
        }
    }

    fn validate(&self) -> Result<(), DiagnosticsError> {
        if self.max_record_bytes < MIN_RECORD_BYTES {
            return Err(DiagnosticsError::InvalidConfiguration(
                "max_record_bytes is too small",
            ));
        }
        let line_bytes =
            self.max_record_bytes
                .checked_add(1)
                .ok_or(DiagnosticsError::InvalidConfiguration(
                    "max_record_bytes overflows",
                ))?;
        if self.max_active_file_bytes < u64::try_from(line_bytes).unwrap_or(u64::MAX) {
            return Err(DiagnosticsError::InvalidConfiguration(
                "active file cannot hold one maximum record",
            ));
        }
        if self.retained_files > 10_000 {
            return Err(DiagnosticsError::InvalidConfiguration(
                "retained file count is too large",
            ));
        }
        Ok(())
    }
}

/// Outcome of one JSONL write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LogWriteReport {
    /// Serialized record bytes, excluding the newline.
    pub record_bytes: usize,
    /// Whether input content was omitted or truncated to enforce the record bound.
    pub truncated: bool,
    /// Number of sensitive values redacted before persistence.
    pub redactions: usize,
    /// Whether the active file was rotated immediately before this write.
    pub rotated: bool,
}

/// Best-effort rotated-file pruning statistics.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PruneReport {
    /// Safe rotated regular files considered.
    pub considered: usize,
    /// Rotated files successfully removed.
    pub removed: usize,
}

struct WriterState {
    file: File,
    active_bytes: u64,
    next_rotation: u64,
}

struct WriterInner {
    config: LogConfig,
    state: Mutex<WriterState>,
    redactor: Redactor,
}

/// Clonable, mutex-serialized bounded JSONL writer with deterministic file rotation.
#[derive(Clone)]
pub struct RotatingJsonWriter {
    inner: Arc<WriterInner>,
}

impl RotatingJsonWriter {
    /// Opens or creates an active log file. Unix directory/file modes are forced to `0700`/`0600`.
    ///
    /// Existing symlinks and non-regular files are refused on every platform. Unix additionally
    /// uses `O_NOFOLLOW` and refuses files with multiple hard links.
    ///
    /// # Errors
    /// Returns an error when bounds are invalid or filesystem safety checks fail.
    pub fn new(config: LogConfig) -> Result<Self, DiagnosticsError> {
        config.validate()?;
        ensure_secure_directory(&config.directory, true, true)?;
        let active_path = config.directory.join(ACTIVE_LOG_FILENAME);
        let file = open_secure_file(&active_path, false, true)?;
        let active_bytes = file
            .metadata()
            .map_err(|source| io_error("inspect active log", source))?
            .len();
        let next_rotation = next_rotation_sequence(&config.directory)?;
        let writer = Self {
            inner: Arc::new(WriterInner {
                config,
                state: Mutex::new(WriterState {
                    file,
                    active_bytes,
                    next_rotation,
                }),
                redactor: Redactor::default(),
            }),
        };
        if active_bytes > writer.inner.config.max_active_file_bytes {
            let mut state = writer.lock_state()?;
            writer.rotate_locked(&mut state)?;
        }
        let _ = writer.prune();
        Ok(writer)
    }

    /// Redacts and writes one structured value as exactly one JSON object line.
    ///
    /// Non-object values are wrapped in a `value` field. Oversized structured values are replaced
    /// by a small truncation object instead of emitting a partial or invalid JSON record.
    ///
    /// # Errors
    /// Returns an error when serialization or file output fails.
    pub fn write_json(&self, value: &Value) -> Result<LogWriteReport, DiagnosticsError> {
        let wrapped = if value.is_object() {
            value.clone()
        } else {
            json!({ "value": value })
        };
        let redacted = self.inner.redactor.redact(&wrapped);
        let mut bytes = serde_json::to_vec(&redacted.value)?;
        let mut truncated = redacted.truncations > 0;
        if bytes.len() > self.inner.config.max_record_bytes {
            let original_bytes = bytes.len();
            bytes = serde_json::to_vec(&json!({
                "recordTruncated": true,
                "originalSerializedBytes": original_bytes,
            }))?;
            truncated = true;
        }
        self.write_serialized(&bytes, truncated, redacted.redactions)
    }

    /// Sanitizes arbitrary bytes and writes them inside a JSON object rather than trusting them as
    /// preformatted JSON.
    ///
    /// # Errors
    /// Returns an error when serialization or file output fails.
    pub fn write_bytes(&self, bytes: &[u8]) -> Result<LogWriteReport, DiagnosticsError> {
        let original_bytes = bytes.len();
        let input_cap = self.inner.config.max_record_bytes.saturating_mul(2);
        let retained = &bytes[..bytes.len().min(input_cap)];
        let mut message = sanitize_unstructured(retained);
        let mut truncated = retained.len() < bytes.len();
        let mut value = json!({
            "kind": "unstructured",
            "message": message,
            "originalBytes": original_bytes,
            "truncated": truncated,
        });
        let redacted = self.inner.redactor.redact(&value);
        value = redacted.value;
        let mut serialized = serde_json::to_vec(&value)?;
        while serialized.len() > self.inner.config.max_record_bytes && !message.is_empty() {
            let excess = serialized.len() - self.inner.config.max_record_bytes;
            let target = message.len().saturating_sub(excess.max(1));
            message = truncate_utf8(&message, target).to_owned();
            truncated = true;
            value = json!({
                "kind": "unstructured",
                "message": message,
                "originalBytes": original_bytes,
                "truncated": true,
            });
            let rerun = self.inner.redactor.redact(&value);
            value = rerun.value;
            serialized = serde_json::to_vec(&value)?;
        }
        if serialized.len() > self.inner.config.max_record_bytes {
            serialized = serde_json::to_vec(&json!({
                "recordTruncated": true,
                "originalBytes": original_bytes,
            }))?;
            truncated = true;
        }
        self.write_serialized(&serialized, truncated, redacted.redactions)
    }

    /// Returns a `tracing-subscriber` writer adapter. Each adapter instance buffers one formatted
    /// event and commits it as a sanitized JSON object when flushed or dropped.
    #[must_use]
    pub fn tracing_writer(&self) -> TracingJsonMakeWriter {
        TracingJsonMakeWriter {
            writer: self.clone(),
        }
    }

    /// Applies count and age retention to safe rotated regular files only.
    ///
    /// Individual metadata and deletion failures are ignored so pruning cannot break current-log
    /// writes. Symlinks, special files, and multiply-linked files are never removed.
    ///
    /// # Errors
    /// Returns an error only when the log directory itself cannot be enumerated safely.
    pub fn prune(&self) -> Result<PruneReport, DiagnosticsError> {
        prune_directory(
            &self.inner.config.directory,
            self.inner.config.retained_files,
            self.inner.config.retention_age,
            SystemTime::now(),
        )
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, WriterState>, DiagnosticsError> {
        self.inner
            .state
            .lock()
            .map_err(|_| DiagnosticsError::LockPoisoned)
    }

    fn write_serialized(
        &self,
        bytes: &[u8],
        truncated: bool,
        redactions: usize,
    ) -> Result<LogWriteReport, DiagnosticsError> {
        if bytes.len() > self.inner.config.max_record_bytes {
            return Err(DiagnosticsError::InvalidConfiguration(
                "serialized record exceeds writer bound",
            ));
        }
        let line_bytes = u64::try_from(bytes.len().saturating_add(1)).unwrap_or(u64::MAX);
        let mut state = self.lock_state()?;
        let rotated = if state.active_bytes > 0
            && state.active_bytes.saturating_add(line_bytes)
                > self.inner.config.max_active_file_bytes
        {
            self.rotate_locked(&mut state)?;
            true
        } else {
            false
        };
        state
            .file
            .write_all(bytes)
            .and_then(|()| state.file.write_all(b"\n"))
            .map_err(|source| io_error("write log record", source))?;
        state.active_bytes = state.active_bytes.saturating_add(line_bytes);
        Ok(LogWriteReport {
            record_bytes: bytes.len(),
            truncated,
            redactions,
            rotated,
        })
    }

    fn rotate_locked(&self, state: &mut WriterState) -> Result<(), DiagnosticsError> {
        state
            .file
            .flush()
            .and_then(|()| state.file.sync_data())
            .map_err(|source| io_error("flush active log", source))?;
        validate_open_file(&state.file)?;
        let active_path = self.inner.config.directory.join(ACTIVE_LOG_FILENAME);
        let mut selected = None;
        for _ in 0..MAX_ROTATION_ATTEMPTS {
            let candidate = self
                .inner
                .config
                .directory
                .join(rotated_filename(state.next_rotation));
            state.next_rotation = state.next_rotation.saturating_add(1);
            match fs::symlink_metadata(&candidate) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    selected = Some(candidate);
                    break;
                }
                Ok(_) => {}
                Err(source) => return Err(io_error("inspect rotated log", source)),
            }
        }
        let rotated_path = selected.ok_or(DiagnosticsError::InvalidConfiguration(
            "rotation namespace exhausted",
        ))?;
        fs::rename(&active_path, &rotated_path)
            .map_err(|source| io_error("rotate active log", source))?;
        let rotated_metadata = fs::symlink_metadata(&rotated_path)
            .map_err(|source| io_error("inspect rotated log", source))?;
        validate_regular_metadata(&rotated_metadata)?;
        state.file = open_secure_file(&active_path, true, true)?;
        state.active_bytes = 0;
        let _ = prune_directory(
            &self.inner.config.directory,
            self.inner.config.retained_files,
            self.inner.config.retention_age,
            SystemTime::now(),
        );
        Ok(())
    }
}

/// A cloneable `tracing-subscriber` make-writer adapter.
#[derive(Clone)]
pub struct TracingJsonMakeWriter {
    writer: RotatingJsonWriter,
}

impl<'a> MakeWriter<'a> for TracingJsonMakeWriter {
    type Writer = TracingEventWriter;

    fn make_writer(&'a self) -> Self::Writer {
        TracingEventWriter {
            writer: self.writer.clone(),
            buffer: Vec::new(),
            input_bytes: 0,
            committed: false,
        }
    }
}

/// Per-event tracing buffer returned by [`TracingJsonMakeWriter`].
pub struct TracingEventWriter {
    writer: RotatingJsonWriter,
    buffer: Vec<u8>,
    input_bytes: usize,
    committed: bool,
}

impl TracingEventWriter {
    fn commit(&mut self) {
        if self.committed {
            return;
        }
        if self.input_bytes > self.buffer.len() {
            self.buffer.extend_from_slice(b" [TRUNCATED]");
        }
        let _ = self.writer.write_bytes(&self.buffer);
        self.committed = true;
    }
}

impl Write for TracingEventWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.input_bytes = self.input_bytes.saturating_add(buffer.len());
        let cap = self.writer.inner.config.max_record_bytes.saturating_mul(2);
        let remaining = cap.saturating_sub(self.buffer.len());
        self.buffer
            .extend_from_slice(&buffer[..buffer.len().min(remaining)]);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.commit();
        Ok(())
    }
}

impl Drop for TracingEventWriter {
    fn drop(&mut self) {
        self.commit();
    }
}

/// Resource bounds used by the centralized recursive redactor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RedactionLimits {
    /// Maximum recursive object/array depth.
    pub max_depth: usize,
    /// Maximum UTF-8 bytes retained in one string.
    pub max_string_bytes: usize,
    /// Maximum entries retained from any single object.
    pub max_object_entries: usize,
    /// Maximum items retained from any single array.
    pub max_array_items: usize,
    /// Maximum total nodes visited in one value.
    pub max_nodes: usize,
}

impl Default for RedactionLimits {
    fn default() -> Self {
        Self {
            max_depth: 16,
            max_string_bytes: 4 * 1024,
            max_object_entries: 128,
            max_array_items: 128,
            max_nodes: 4_096,
        }
    }
}

/// Result of recursively redacting and bounding one JSON value.
#[derive(Clone, Debug, PartialEq)]
pub struct RedactionReport {
    /// Sanitized JSON-compatible value.
    pub value: Value,
    /// Number of sensitive values or strings that were redacted/sanitized.
    pub redactions: usize,
    /// Number of depth, node, string, or collection truncations.
    pub truncations: usize,
}

/// Central recursive redactor used by both log persistence and bundle preparation.
#[derive(Clone, Debug)]
pub struct Redactor {
    limits: RedactionLimits,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new(RedactionLimits::default())
    }
}

impl Redactor {
    /// Creates a redactor with caller-selected resource bounds.
    #[must_use]
    pub const fn new(limits: RedactionLimits) -> Self {
        Self { limits }
    }

    /// Returns the configured resource bounds.
    #[must_use]
    pub const fn limits(&self) -> RedactionLimits {
        self.limits
    }

    /// Recursively redacts sensitive keys, sanitizes URLs, and bounds all JSON containers.
    #[must_use]
    pub fn redact(&self, value: &Value) -> RedactionReport {
        let mut context = RedactionContext {
            limits: self.limits,
            nodes_left: self.limits.max_nodes,
            redactions: 0,
            truncations: 0,
        };
        let value = context.visit(value, 0);
        RedactionReport {
            value,
            redactions: context.redactions,
            truncations: context.truncations,
        }
    }
}

struct RedactionContext {
    limits: RedactionLimits,
    nodes_left: usize,
    redactions: usize,
    truncations: usize,
}

impl RedactionContext {
    fn visit(&mut self, value: &Value, depth: usize) -> Value {
        if self.nodes_left == 0 || depth > self.limits.max_depth {
            self.truncations = self.truncations.saturating_add(1);
            return Value::String(TRUNCATED.to_owned());
        }
        self.nodes_left -= 1;
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(string) => self.visit_string(string),
            Value::Array(items) => {
                let retained = items.len().min(self.limits.max_array_items);
                if retained < items.len() {
                    self.truncations = self.truncations.saturating_add(1);
                }
                Value::Array(
                    items
                        .iter()
                        .take(retained)
                        .map(|item| self.visit(item, depth + 1))
                        .collect(),
                )
            }
            Value::Object(object) => {
                let retained = object.len().min(self.limits.max_object_entries);
                if retained < object.len() {
                    self.truncations = self.truncations.saturating_add(1);
                }
                let mut output = Map::new();
                for (key, child) in object.iter().take(retained) {
                    if is_sensitive_key(key) {
                        self.redactions = self.redactions.saturating_add(1);
                        output.insert(key.clone(), Value::String(REDACTED.to_owned()));
                    } else {
                        output.insert(key.clone(), self.visit(child, depth + 1));
                    }
                }
                Value::Object(output)
            }
        }
    }

    fn visit_string(&mut self, input: &str) -> Value {
        let bounded = truncate_utf8(input, self.limits.max_string_bytes);
        if bounded.len() < input.len() {
            self.truncations = self.truncations.saturating_add(1);
        }
        let (sanitized, changed) = sanitize_sensitive_text(bounded);
        if changed {
            self.redactions = self.redactions.saturating_add(1);
        }
        Value::String(sanitized)
    }
}

/// Safe, detail-free recovery state accepted by diagnostic bundles.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SafeRecoveryClassification {
    /// Storage was readable and semantically valid.
    Healthy,
    /// Storage is valid but needs a supported migration.
    MigrationRequired,
    /// Storage was created by a newer unsupported application version.
    FutureSchema,
    /// The database container could not be read.
    CorruptStorage,
    /// Stored application data failed semantic validation.
    InvalidState,
    /// Storage was unavailable without a safe detailed classification.
    Unavailable,
}

/// Resource bounds for diagnostic bundle preparation and export.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BundleLimits {
    /// Redactor recursion and collection bounds.
    pub redaction: RedactionLimits,
    /// Maximum number of supplied log tails.
    pub max_log_entries: usize,
    /// Maximum input bytes retained from the end of one log.
    pub max_log_tail_bytes: usize,
    /// Maximum retained tail bytes across all supplied logs.
    pub max_total_log_tail_bytes: usize,
    /// Maximum serialized bytes of the complete exported JSON document.
    pub max_bundle_bytes: usize,
}

impl Default for BundleLimits {
    fn default() -> Self {
        Self {
            redaction: RedactionLimits::default(),
            max_log_entries: 8,
            max_log_tail_bytes: 64 * 1024,
            max_total_log_tail_bytes: 256 * 1024,
            max_bundle_bytes: 512 * 1024,
        }
    }
}

impl BundleLimits {
    fn validate(self) -> Result<(), DiagnosticsError> {
        if self.redaction.max_depth == 0
            || self.redaction.max_string_bytes == 0
            || self.redaction.max_object_entries == 0
            || self.redaction.max_array_items == 0
            || self.redaction.max_nodes == 0
            || self.max_log_entries > 1_024
            || self.max_log_tail_bytes == 0
            || self.max_total_log_tail_bytes == 0
            || self.max_bundle_bytes < 512
        {
            return Err(DiagnosticsError::InvalidConfiguration(
                "bundle bounds are zero, too small, or excessive",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct LogTail {
    name: String,
    bytes: Vec<u8>,
    prefix_truncated: bool,
}

/// Allow-listed builder for an explicitly previewed diagnostic JSON bundle.
///
/// The API has no input for database files, state snapshots, notification payloads, terminal
/// checkpoints, CLI session records, process environment, or credentials. Configuration and log
/// JSON are recursively redacted again during every preview/export preparation.
pub struct DiagnosticBundleBuilder {
    application: String,
    version: String,
    platform: String,
    recovery: SafeRecoveryClassification,
    configuration_summary: Value,
    log_tails: Vec<LogTail>,
    log_names: BTreeSet<String>,
    retained_log_bytes: usize,
    limits: BundleLimits,
}

impl DiagnosticBundleBuilder {
    /// Creates a bundle builder from the complete allow-listed non-log inputs.
    ///
    /// # Errors
    /// Returns an error when resource bounds are invalid.
    pub fn new(
        application: impl Into<String>,
        version: impl Into<String>,
        platform: impl Into<String>,
        recovery: SafeRecoveryClassification,
        configuration_summary: Value,
        limits: BundleLimits,
    ) -> Result<Self, DiagnosticsError> {
        limits.validate()?;
        Ok(Self {
            application: application.into(),
            version: version.into(),
            platform: platform.into(),
            recovery,
            configuration_summary,
            log_tails: Vec::new(),
            log_names: BTreeSet::new(),
            retained_log_bytes: 0,
            limits,
        })
    }

    /// Adds a bounded suffix of one explicitly supplied log. The name must contain only ASCII
    /// alphanumerics, dot, underscore, or hyphen and cannot be `.` or `..`.
    ///
    /// # Errors
    /// Returns an error for an unsafe/duplicate name or when the log-entry count is exhausted.
    pub fn add_log_tail(
        &mut self,
        name: impl Into<String>,
        bytes: &[u8],
    ) -> Result<(), DiagnosticsError> {
        let name = name.into();
        if !is_safe_name(&name) || !self.log_names.insert(name.clone()) {
            return Err(DiagnosticsError::InvalidEntryName);
        }
        if self.log_tails.len() >= self.limits.max_log_entries {
            self.log_names.remove(&name);
            return Err(DiagnosticsError::TooManyLogEntries);
        }
        let global_remaining = self
            .limits
            .max_total_log_tail_bytes
            .saturating_sub(self.retained_log_bytes);
        let keep = bytes
            .len()
            .min(self.limits.max_log_tail_bytes)
            .min(global_remaining);
        let start = bytes.len().saturating_sub(keep);
        let (tail, prefix_truncated) = if start == 0 {
            (bytes, false)
        } else {
            let suffix = &bytes[start..];
            match suffix.iter().position(|byte| *byte == b'\n') {
                Some(position) => (&suffix[position + 1..], true),
                None => (&suffix[0..0], true),
            }
        };
        self.retained_log_bytes = self.retained_log_bytes.saturating_add(tail.len());
        self.log_tails.push(LogTail {
            name,
            bytes: tail.to_vec(),
            prefix_truncated,
        });
        Ok(())
    }

    /// Builds a content-free manifest containing exact entry names, sizes, and redaction counts.
    /// The returned preview must be passed unchanged to [`Self::export_json`].
    ///
    /// # Errors
    /// Returns an error if serialization exceeds the total bundle bound.
    pub fn preview(&self) -> Result<BundlePreview, DiagnosticsError> {
        let prepared = self.prepare()?;
        Ok(BundlePreview {
            manifest: prepared.manifest,
            export_bytes: prepared.serialized.len(),
        })
    }

    /// Atomically publishes the bounded JSON bundle only if it exactly matches `approved_preview`.
    /// Existing destinations of every type, including symlinks, are refused and never replaced.
    /// Unix exports use mode `0600`; other platforms use their native create-new permissions.
    ///
    /// # Errors
    /// Returns an error when the preview changed, the destination is unsafe/existing, or output
    /// cannot be written and atomically linked into place.
    pub fn export_json(
        &self,
        destination: impl AsRef<Path>,
        approved_preview: &BundlePreview,
    ) -> Result<ExportReport, DiagnosticsError> {
        let prepared = self.prepare()?;
        if prepared.manifest != approved_preview.manifest
            || prepared.serialized.len() != approved_preview.export_bytes
        {
            return Err(DiagnosticsError::PreviewMismatch);
        }
        atomic_create_owner_file(destination.as_ref(), &prepared.serialized)?;
        Ok(ExportReport {
            destination: destination.as_ref().to_path_buf(),
            bytes: prepared.serialized.len(),
        })
    }

    fn prepare(&self) -> Result<PreparedBundle, DiagnosticsError> {
        let redactor = Redactor::new(self.limits.redaction);
        let mut entries = BTreeMap::new();
        let metadata = redactor.redact(&json!({
            "application": self.application,
            "version": self.version,
            "platform": self.platform,
        }));
        entries.insert(
            "metadata.json".to_owned(),
            PreparedEntry::from_report(metadata),
        );
        let recovery = redactor.redact(&json!({ "classification": self.recovery }));
        entries.insert(
            "recovery.json".to_owned(),
            PreparedEntry::from_report(recovery),
        );
        let configuration = redactor.redact(&self.configuration_summary);
        entries.insert(
            "configuration-summary.json".to_owned(),
            PreparedEntry::from_report(configuration),
        );
        for log in &self.log_tails {
            let (content, redactions, truncations) = prepare_log_tail(log, &redactor);
            entries.insert(
                format!("logs/{}.json", log.name),
                PreparedEntry {
                    content,
                    redactions,
                    truncations,
                },
            );
        }

        let mut manifest_entries = Vec::with_capacity(entries.len());
        let mut total_entry_bytes = 0usize;
        let mut total_redactions = 0usize;
        let mut total_truncations = 0usize;
        let mut content = BTreeMap::new();
        for (name, entry) in entries {
            let bytes = serde_json::to_vec(&entry.content)?.len();
            total_entry_bytes = total_entry_bytes.saturating_add(bytes);
            total_redactions = total_redactions.saturating_add(entry.redactions);
            total_truncations = total_truncations.saturating_add(entry.truncations);
            manifest_entries.push(BundleManifestEntry {
                name: name.clone(),
                bytes,
                redactions: entry.redactions,
                truncations: entry.truncations,
            });
            content.insert(name, entry.content);
        }
        let manifest = BundleManifest {
            entries: manifest_entries,
            total_entry_bytes,
            total_redactions,
            total_truncations,
        };
        let document = ExportDocument {
            format: BUNDLE_FORMAT,
            manifest: &manifest,
            entries: &content,
        };
        let serialized = serde_json::to_vec(&document)?;
        if serialized.len() > self.limits.max_bundle_bytes {
            return Err(DiagnosticsError::BundleTooLarge);
        }
        Ok(PreparedBundle {
            manifest,
            serialized,
        })
    }
}

struct PreparedEntry {
    content: Value,
    redactions: usize,
    truncations: usize,
}

impl PreparedEntry {
    fn from_report(report: RedactionReport) -> Self {
        Self {
            content: report.value,
            redactions: report.redactions,
            truncations: report.truncations,
        }
    }
}

struct PreparedBundle {
    manifest: BundleManifest,
    serialized: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocument<'a> {
    format: &'static str,
    manifest: &'a BundleManifest,
    entries: &'a BTreeMap<String, Value>,
}

/// Content-free preview that must be approved before export.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePreview {
    manifest: BundleManifest,
    export_bytes: usize,
}

impl BundlePreview {
    /// Exact entry manifest that will be embedded in the export.
    #[must_use]
    pub const fn manifest(&self) -> &BundleManifest {
        &self.manifest
    }

    /// Exact complete JSON-document byte count.
    #[must_use]
    pub const fn export_bytes(&self) -> usize {
        self.export_bytes
    }
}

/// Exact entry metadata embedded in a diagnostic bundle.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    /// Entries sorted lexicographically by their safe bundle name.
    pub entries: Vec<BundleManifestEntry>,
    /// Sum of independently serialized entry content sizes.
    pub total_entry_bytes: usize,
    /// Total sensitive-value and URL/text sanitization count.
    pub total_redactions: usize,
    /// Total depth, node, string, collection, and log-tail truncation count.
    pub total_truncations: usize,
}

/// One exact diagnostic entry description.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifestEntry {
    /// Safe virtual entry name.
    pub name: String,
    /// Independently serialized JSON content bytes.
    pub bytes: usize,
    /// Sensitive values or strings sanitized in this entry.
    pub redactions: usize,
    /// Resource truncations applied in this entry.
    pub truncations: usize,
}

/// Successful atomic diagnostic export details.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportReport {
    /// Newly created final destination.
    pub destination: PathBuf,
    /// Complete exported JSON-document byte count.
    pub bytes: usize,
}

fn prepare_log_tail(log: &LogTail, redactor: &Redactor) -> (Value, usize, usize) {
    let mut records = Vec::new();
    let mut redactions = 0usize;
    let mut truncations = usize::from(log.prefix_truncated);
    if log.prefix_truncated {
        records.push(json!({ "recordTruncated": true }));
    }
    let nonempty_lines: Vec<_> = log
        .bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    let remaining = redactor
        .limits()
        .max_array_items
        .saturating_sub(records.len());
    let first_retained = nonempty_lines.len().saturating_sub(remaining);
    if first_retained > 0 {
        truncations = truncations.saturating_add(1);
    }
    for line in nonempty_lines.into_iter().skip(first_retained) {
        let parsed = serde_json::from_slice::<Value>(line).ok();
        let value = match parsed {
            Some(Value::Object(object)) => Value::Object(object),
            Some(other) => json!({ "value": other }),
            None if line.len() > redactor.limits().max_string_bytes => {
                truncations = truncations.saturating_add(1);
                json!({ "recordTruncated": true })
            }
            None => json!({ "message": sanitize_unstructured(line) }),
        };
        let report = redactor.redact(&value);
        redactions = redactions.saturating_add(report.redactions);
        truncations = truncations.saturating_add(report.truncations);
        records.push(report.value);
    }
    (Value::Array(records), redactions, truncations)
}

fn sanitize_unstructured(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect()
}

fn truncate_utf8(input: &str, maximum: usize) -> &str {
    if input.len() <= maximum {
        return input;
    }
    let mut boundary = maximum;
    while boundary > 0 && !input.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &input[..boundary]
}

fn is_sensitive_key(key: &str) -> bool {
    const SUBSTRINGS: &[&str] = &[
        "token",
        "auth",
        "authorization",
        "password",
        "passwd",
        "secret",
        "cookie",
        "session",
        "credential",
        "apikey",
        "accesskey",
        "privatekey",
        "controlkey",
        "terminalcontent",
        "terminaloutput",
        "content",
        "output",
        "checkpoint",
        "body",
        "snapshot",
        "notificationbody",
        "clisession",
        "environment",
    ];
    let normalized: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    normalized == "env" || SUBSTRINGS.iter().any(|marker| normalized.contains(marker))
}

fn sanitize_sensitive_text(input: &str) -> (String, bool) {
    let (urls, url_changed) = sanitize_urls(input);
    let (assignments, assignment_changed) = redact_assignments(&urls);
    (assignments, assignment_changed || url_changed)
}

fn redact_assignments(input: &str) -> (String, bool) {
    const MARKERS: &[&str] = &[
        "authorization",
        "password",
        "passwd",
        "secret",
        "token",
        "cookie",
        "session",
        "credential",
        "api_key",
        "apikey",
        "control_key",
        "controlkey",
    ];
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut ranges = Vec::new();
    for marker in MARKERS {
        let mut search = 0usize;
        while let Some(relative) = lower[search..].find(marker) {
            let start = search + relative;
            let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
            let mut cursor = start + marker.len();
            let after_ok = cursor == bytes.len() || !bytes[cursor].is_ascii_alphanumeric();
            if before_ok && after_ok {
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if cursor < bytes.len() && matches!(bytes[cursor], b'=' | b':') {
                    cursor += 1;
                    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                        cursor += 1;
                    }
                    let value_start = cursor;
                    while cursor < bytes.len()
                        && !bytes[cursor].is_ascii_whitespace()
                        && !matches!(bytes[cursor], b',' | b';' | b'&' | b'"' | b'\'')
                    {
                        cursor += 1;
                    }
                    if value_start < cursor {
                        ranges.push((value_start, cursor));
                    }
                }
            }
            search = (start + marker.len()).min(lower.len());
        }
    }
    let mut search = 0usize;
    while let Some(relative) = lower[search..].find("bearer ") {
        let start = search + relative + "bearer ".len();
        let mut end = start;
        while end < bytes.len()
            && !bytes[end].is_ascii_whitespace()
            && !matches!(bytes[end], b',' | b';' | b'&' | b'"' | b'\'')
        {
            end += 1;
        }
        if start < end {
            ranges.push((start, end));
        }
        search = end.max(search + 1);
    }
    if ranges.is_empty() {
        return (input.to_owned(), false);
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    let mut output = input.to_owned();
    for (start, end) in merged.into_iter().rev() {
        output.replace_range(start..end, REDACTED);
    }
    (output, true)
}

fn sanitize_urls(input: &str) -> (String, bool) {
    const SCHEMES: &[&str] = &["https://", "http://", "wss://", "ws://"];
    let lower = input.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut output = String::with_capacity(input.len());
    let mut changed = false;
    while cursor < input.len() {
        let next = SCHEMES
            .iter()
            .filter_map(|scheme| lower[cursor..].find(scheme).map(|offset| cursor + offset))
            .min();
        let Some(start) = next else {
            output.push_str(&input[cursor..]);
            break;
        };
        output.push_str(&input[cursor..start]);
        let mut end = start;
        while end < input.len() {
            let character = input[end..]
                .chars()
                .next()
                .expect("valid character boundary");
            if character.is_whitespace()
                || matches!(
                    character,
                    '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}'
                )
            {
                break;
            }
            end += character.len_utf8();
        }
        let mut candidate_end = end;
        while candidate_end > start
            && input.as_bytes()[candidate_end - 1].is_ascii_punctuation()
            && matches!(
                input.as_bytes()[candidate_end - 1],
                b',' | b';' | b'!' | b'.'
            )
        {
            candidate_end -= 1;
        }
        let candidate = &input[start..candidate_end];
        match Url::parse(candidate) {
            Ok(mut url) if url.has_host() => {
                let was_sensitive = !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some();
                if was_sensitive {
                    let _ = url.set_password(None);
                    let _ = url.set_username("");
                    url.set_query(None);
                    url.set_fragment(None);
                    output.push_str(url.as_str());
                    changed = true;
                } else {
                    output.push_str(candidate);
                }
            }
            _ => output.push_str(candidate),
        }
        output.push_str(&input[candidate_end..end]);
        cursor = end;
    }
    (output, changed)
}

fn ensure_secure_directory(
    path: &Path,
    create: bool,
    require_owner_only: bool,
) -> Result<(), DiagnosticsError> {
    if has_parent_component(path) {
        return Err(DiagnosticsError::UnsafePath(
            "parent traversal is not allowed",
        ));
    }
    if create {
        create_directory_without_symlinks(path)?;
    }
    reject_symlink_components(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| io_error("inspect diagnostics directory", source))?;
    if !metadata.file_type().is_dir() {
        return Err(DiagnosticsError::UnsafePath(
            "diagnostics directory is not a directory",
        ));
    }
    secure_directory_permissions(path, require_owner_only)?;
    let secured = fs::symlink_metadata(path)
        .map_err(|source| io_error("reinspect diagnostics directory", source))?;
    if !secured.file_type().is_dir() {
        return Err(DiagnosticsError::UnsafePath(
            "diagnostics directory is not a directory",
        ));
    }
    validate_directory_permissions(&secured, require_owner_only)?;
    Ok(())
}

#[cfg(unix)]
fn secure_directory_permissions(
    path: &Path,
    require_owner_only: bool,
) -> Result<(), DiagnosticsError> {
    if require_owner_only {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|source| io_error("secure diagnostics directory", source))?;
    }
    Ok(())
}

#[cfg(unix)]
fn validate_directory_permissions(
    metadata: &fs::Metadata,
    require_owner_only: bool,
) -> Result<(), DiagnosticsError> {
    if require_owner_only && metadata.permissions().mode() & 0o077 != 0 {
        return Err(DiagnosticsError::UnsafePath(
            "diagnostics directory is not owner-only",
        ));
    }
    Ok(())
}

fn create_directory_without_symlinks(path: &Path) -> Result<(), DiagnosticsError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| io_error("resolve current directory", source))?
            .join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) => {
                current.push(component.as_os_str());
                continue;
            }
            Component::ParentDir => {
                return Err(DiagnosticsError::UnsafePath("unsupported path component"));
            }
            Component::RootDir | Component::CurDir | Component::Normal(_) => {
                current.push(component.as_os_str());
            }
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                    return Err(DiagnosticsError::UnsafePath(
                        "log directory component is not a real directory",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|source| io_error("create log directory component", source))?;
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|source| io_error("inspect created log directory", source))?;
                if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                    return Err(DiagnosticsError::UnsafePath(
                        "created log directory component is unsafe",
                    ));
                }
            }
            Err(source) => return Err(io_error("inspect log directory component", source)),
        }
    }
    Ok(())
}

fn reject_symlink_components(path: &Path) -> Result<(), DiagnosticsError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| io_error("resolve current directory", source))?
            .join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) => {
                current.push(component.as_os_str());
                continue;
            }
            Component::ParentDir => {
                return Err(DiagnosticsError::UnsafePath("unsupported path component"));
            }
            Component::RootDir | Component::CurDir | Component::Normal(_) => {
                current.push(component.as_os_str());
            }
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|source| io_error("inspect path component", source))?;
        if metadata.file_type().is_symlink() {
            return Err(DiagnosticsError::UnsafePath(
                "symlink path component is not allowed",
            ));
        }
        if current != absolute && !metadata.file_type().is_dir() {
            return Err(DiagnosticsError::UnsafePath(
                "non-directory path component is not allowed",
            ));
        }
    }
    Ok(())
}

fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn open_secure_file(path: &Path, create_new: bool, append: bool) -> Result<File, DiagnosticsError> {
    let exists = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_regular_metadata(&metadata)?;
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(source) => return Err(io_error("inspect diagnostics file", source)),
    };
    let mut options = OpenOptions::new();
    options.write(true).append(append);
    if create_new || !exists {
        options.create_new(true);
    }
    configure_secure_open_options(&mut options);
    let file = options
        .open(path)
        .map_err(|source| io_error("open diagnostics file", source))?;
    secure_file_permissions(path)?;
    validate_open_file(&file)?;
    Ok(file)
}

#[cfg(unix)]
fn configure_secure_open_options(options: &mut OpenOptions) {
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
}

#[cfg(unix)]
fn secure_file_permissions(path: &Path) -> Result<(), DiagnosticsError> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|source| io_error("secure diagnostics file", source))
}

fn validate_open_file(file: &File) -> Result<(), DiagnosticsError> {
    let metadata = file
        .metadata()
        .map_err(|source| io_error("inspect open file", source))?;
    validate_regular_metadata(&metadata)?;
    validate_file_permissions(&metadata)?;
    Ok(())
}

#[cfg(unix)]
fn validate_file_permissions(metadata: &fs::Metadata) -> Result<(), DiagnosticsError> {
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(DiagnosticsError::UnsafePath("file is not owner-only"));
    }
    Ok(())
}

fn validate_regular_metadata(metadata: &fs::Metadata) -> Result<(), DiagnosticsError> {
    if !metadata.file_type().is_file() {
        return Err(DiagnosticsError::UnsafePath(
            "filesystem object is not a regular file",
        ));
    }
    validate_link_count(metadata)?;
    Ok(())
}

#[cfg(unix)]
fn validate_link_count(metadata: &fs::Metadata) -> Result<(), DiagnosticsError> {
    if metadata.nlink() != 1 {
        return Err(DiagnosticsError::UnsafePath(
            "multiply-linked files are not allowed",
        ));
    }
    Ok(())
}

fn rotated_filename(sequence: u64) -> String {
    format!("diagnostics.{sequence:020}.jsonl")
}

fn parse_rotation_sequence(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("diagnostics.")?.strip_suffix(".jsonl")?;
    if digits.len() != 20 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn next_rotation_sequence(directory: &Path) -> Result<u64, DiagnosticsError> {
    let mut maximum = None;
    for entry in
        fs::read_dir(directory).map_err(|source| io_error("enumerate log directory", source))?
    {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Some(sequence) = parse_rotation_sequence(&name) {
            maximum = Some(maximum.map_or(sequence, |value: u64| value.max(sequence)));
        }
    }
    Ok(maximum.map_or(0, |value| value.saturating_add(1)))
}

struct RotationCandidate {
    path: PathBuf,
    sequence: u64,
    expired: bool,
}

fn prune_directory(
    directory: &Path,
    retained_files: usize,
    retention_age: Duration,
    now: SystemTime,
) -> Result<PruneReport, DiagnosticsError> {
    let mut candidates = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|source| io_error("enumerate log directory", source))?
    {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(sequence) = parse_rotation_sequence(&name) else {
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if validate_regular_metadata(&metadata).is_err() {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > retention_age);
        candidates.push(RotationCandidate {
            path: entry.path(),
            sequence,
            expired,
        });
    }
    candidates.sort_by_key(|candidate| candidate.sequence);
    let considered = candidates.len();
    let mut removed = 0usize;
    let mut survivors = Vec::new();
    for candidate in candidates {
        if candidate.expired && remove_safe_rotated(&candidate.path) {
            removed += 1;
        } else {
            survivors.push(candidate);
        }
    }
    let excess = survivors.len().saturating_sub(retained_files);
    for candidate in survivors.into_iter().take(excess) {
        if remove_safe_rotated(&candidate.path) {
            removed += 1;
        }
    }
    Ok(PruneReport {
        considered,
        removed,
    })
}

fn remove_safe_rotated(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if validate_regular_metadata(&metadata).is_err() {
        return false;
    }
    fs::remove_file(path).is_ok()
}

fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn atomic_create_owner_file(path: &Path, contents: &[u8]) -> Result<(), DiagnosticsError> {
    if has_parent_component(path) {
        return Err(DiagnosticsError::UnsafePath(
            "parent traversal is not allowed",
        ));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| is_safe_name(name))
        .ok_or(DiagnosticsError::UnsafePath(
            "destination filename is unsafe",
        ))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    ensure_secure_directory(parent, false, false)?;
    match fs::symlink_metadata(path) {
        Ok(_) => return Err(DiagnosticsError::DestinationExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => return Err(io_error("inspect export destination", source)),
    }
    let mut temporary = None;
    for _ in 0..TEMP_ATTEMPTS {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), sequence));
        match open_secure_file(&temp_path, true, false) {
            Ok(file) => {
                temporary = Some((temp_path, file));
                break;
            }
            Err(DiagnosticsError::Io { source, .. })
                if source.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    let (temp_path, mut file) = temporary.ok_or(DiagnosticsError::InvalidConfiguration(
        "temporary export namespace exhausted",
    ))?;
    let write_result = file
        .write_all(contents)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all());
    if let Err(source) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(io_error("write diagnostic export", source));
    }
    drop(file);
    if let Err(source) = fs::hard_link(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        if source.kind() == io::ErrorKind::AlreadyExists {
            return Err(DiagnosticsError::DestinationExists);
        }
        return Err(io_error("publish diagnostic export", source));
    }
    if let Err(source) = fs::remove_file(&temp_path) {
        let _ = fs::remove_file(path);
        return Err(io_error("finalize diagnostic export", source));
    }
    let published = fs::symlink_metadata(path)
        .map_err(|source| io_error("inspect published diagnostic export", source))?;
    validate_regular_metadata(&published)?;
    validate_file_permissions(&published)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::fs;
    use std::io::Write as _;
    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[cfg(unix)]
    use filetime::{FileTime, set_file_mtime};
    use serde_json::{Value, json};
    use tempfile::tempdir;

    use super::*;

    fn small_log_config(directory: &Path) -> LogConfig {
        LogConfig {
            directory: directory.to_path_buf(),
            max_record_bytes: 256,
            max_active_file_bytes: 320,
            retained_files: 2,
            retention_age: DEFAULT_RETENTION_AGE,
        }
    }

    fn bundle_builder(configuration: Value) -> DiagnosticBundleBuilder {
        DiagnosticBundleBuilder::new(
            "Workspace",
            "1.2.3",
            "linux-x86_64",
            SafeRecoveryClassification::Healthy,
            configuration,
            BundleLimits::default(),
        )
        .unwrap()
    }

    #[test]
    fn standard_library_portable_security_fallback_is_compile_checked() {
        let temp = tempdir().unwrap();
        portable_security::secure_directory_permissions(temp.path(), true).unwrap();
        let directory_metadata = fs::metadata(temp.path()).unwrap();
        portable_security::validate_directory_permissions(&directory_metadata, true).unwrap();

        let path = temp.path().join("portable-check");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        portable_security::configure_secure_open_options(&mut options);
        let file = options.open(&path).unwrap();
        portable_security::secure_file_permissions(&path).unwrap();
        let metadata = file.metadata().unwrap();
        portable_security::validate_file_permissions(&metadata).unwrap();
        portable_security::validate_link_count(&metadata).unwrap();
    }

    #[test]
    fn rotation_is_deterministic_and_count_retention_is_bounded() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("logs");
        let writer = RotatingJsonWriter::new(small_log_config(&directory)).unwrap();
        for index in 0..12 {
            writer
                .write_json(&json!({ "index": index, "message": "x".repeat(170) }))
                .unwrap();
        }
        let mut rotated: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| parse_rotation_sequence(name).is_some())
            .collect();
        rotated.sort();
        assert_eq!(rotated.len(), 2);
        assert!(rotated[0] < rotated[1]);
        assert!(directory.join(ACTIVE_LOG_FILENAME).is_file());
    }

    #[test]
    #[cfg(unix)]
    fn age_retention_prunes_old_regular_files_but_not_symlinks() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("logs");
        let writer = RotatingJsonWriter::new(small_log_config(&directory)).unwrap();
        let old = directory.join(rotated_filename(80));
        fs::write(&old, b"{}\n").unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o600)).unwrap();
        let eight_days_ago =
            FileTime::from_system_time(SystemTime::now() - Duration::from_hours(192));
        set_file_mtime(&old, eight_days_ago).unwrap();
        let trap_target = directory.join("trap-target");
        fs::write(&trap_target, b"do not delete").unwrap();
        let trap = directory.join(rotated_filename(81));
        symlink(&trap_target, &trap).unwrap();
        let report = writer.prune().unwrap();
        assert_eq!(report.removed, 1);
        assert!(!old.exists());
        assert_eq!(fs::read(&trap_target).unwrap(), b"do not delete");
        assert!(
            fs::symlink_metadata(&trap)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn oversized_records_are_valid_bounded_objects() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("logs");
        let writer = RotatingJsonWriter::new(small_log_config(&directory)).unwrap();
        let report = writer
            .write_json(&json!({ "ordinary": "z".repeat(20_000) }))
            .unwrap();
        assert!(report.truncated);
        assert!(report.record_bytes <= 256);
        let bytes_report = writer.write_bytes(&vec![0xff; 20_000]).unwrap();
        assert!(bytes_report.truncated);
        let contents = fs::read_to_string(directory.join(ACTIVE_LOG_FILENAME)).unwrap();
        for line in contents.lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            assert!(value.is_object());
            assert!(line.len() <= 256);
        }
    }

    #[test]
    fn cloned_writers_serialize_concurrent_records_without_interleaving() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("logs");
        let mut config = small_log_config(&directory);
        config.max_active_file_bytes = 1024 * 1024;
        let writer = RotatingJsonWriter::new(config).unwrap();
        let barrier = Arc::new(Barrier::new(9));
        let mut threads = Vec::new();
        for worker in 0..8 {
            let clone = writer.clone();
            let barrier = Arc::clone(&barrier);
            threads.push(thread::spawn(move || {
                barrier.wait();
                for record in 0..100 {
                    clone
                        .write_json(&json!({ "worker": worker, "record": record }))
                        .unwrap();
                }
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        let contents = fs::read_to_string(directory.join(ACTIVE_LOG_FILENAME)).unwrap();
        let lines: Vec<_> = contents.lines().collect();
        assert_eq!(lines.len(), 800);
        assert!(
            lines
                .iter()
                .all(|line| serde_json::from_str::<Value>(line).is_ok())
        );
    }

    #[test]
    fn tracing_adapter_wraps_formatted_bytes_as_json() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("logs");
        let writer = RotatingJsonWriter::new(small_log_config(&directory)).unwrap();
        let make_writer = writer.tracing_writer();
        {
            let mut event = make_writer.make_writer();
            event.write_all(b"not json\nwith control \x01").unwrap();
        }
        let contents = fs::read_to_string(directory.join(ACTIVE_LOG_FILENAME)).unwrap();
        let value: Value = serde_json::from_str(contents.trim()).unwrap();
        assert_eq!(value["kind"], "unstructured");
        assert!(value["message"].as_str().unwrap().contains('\u{fffd}'));
    }

    #[test]
    fn recursive_redaction_covers_nested_keys_urls_and_assignments() {
        let input = json!({
            "safe": {
                "authorization": "Bearer never-export-this",
                "nested": [{ "controlKey": "control-value", "ok": 7 }],
                "url": "open https://url-user-secret:url-pass-secret@example.test/path?q=token#fragment now",
                "note": "password=hunter2 and Bearer abc.def; secret=password=overlap-secret-value",
            },
            "terminalOutput": "private terminal contents",
            "notificationBody": "private notification",
        });
        let report = Redactor::default().redact(&input);
        let serialized = serde_json::to_string(&report.value).unwrap();
        for secret in [
            "never-export-this",
            "control-value",
            "url-user-secret",
            "url-pass-secret",
            "q=token",
            "fragment",
            "hunter2",
            "abc.def",
            "overlap-secret-value",
            "private terminal",
            "private notification",
        ] {
            assert!(
                !serialized.contains(secret),
                "secret survived: {secret}; output: {serialized}"
            );
        }
        assert!(serialized.contains("https://example.test/path"));
        assert!(report.redactions >= 6);
    }

    #[test]
    fn depth_string_collection_and_node_bounds_are_enforced() {
        let limits = RedactionLimits {
            max_depth: 2,
            max_string_bytes: 5,
            max_object_entries: 2,
            max_array_items: 2,
            max_nodes: 6,
        };
        let value = json!({
            "a": "123456789",
            "b": [1, 2, 3, 4],
            "c": { "deep": { "deeper": true } },
        });
        let report = Redactor::new(limits).redact(&value);
        assert!(report.truncations >= 3);
        assert!(serde_json::to_vec(&report.value).unwrap().len() < 100);
    }

    #[test]
    fn unknown_nested_secrets_do_not_survive_preview_or_export() {
        let temp = tempdir().unwrap();
        let export = temp.path().join("bundle.json");
        let mut builder = bundle_builder(json!({
            "theme": "dark",
            "futurePlugin": {
                "newApiToken": "unknown-token-value",
                "environment": { "HOME": "/secret/home" },
                "stateSnapshot": { "ordinary": "snapshot-value" },
            }
        }));
        builder
            .add_log_tail(
                "current",
                br#"{"level":"info","url":"https://url-user-credential:url-password-credential@example.test/a?key=value#frag","deep":{"newPassword":"log-secret"}}
password=plain-secret
"#,
            )
            .unwrap();
        let preview = builder.preview().unwrap();
        let preview_json = serde_json::to_string(&preview).unwrap();
        for secret in [
            "unknown-token-value",
            "/secret/home",
            "snapshot-value",
            "log-secret",
        ] {
            assert!(!preview_json.contains(secret));
        }
        builder.export_json(&export, &preview).unwrap();
        let contents = fs::read_to_string(export).unwrap();
        for secret in [
            "unknown-token-value",
            "/secret/home",
            "snapshot-value",
            "url-user-credential",
            "url-password-credential",
            "key=value",
            "frag",
            "log-secret",
            "plain-secret",
        ] {
            assert!(!contents.contains(secret), "secret survived: {secret}");
        }
        assert!(contents.contains(REDACTED));
    }

    #[test]
    fn bundle_total_size_is_strictly_bounded() {
        let limits = BundleLimits {
            max_bundle_bytes: 512,
            ..BundleLimits::default()
        };
        let builder = DiagnosticBundleBuilder::new(
            "a".repeat(4_000),
            "v".repeat(4_000),
            "p".repeat(4_000),
            SafeRecoveryClassification::Healthy,
            json!({ "safe": "x".repeat(4_000) }),
            limits,
        )
        .unwrap();
        assert!(matches!(
            builder.preview(),
            Err(DiagnosticsError::BundleTooLarge)
        ));
    }

    #[test]
    fn log_tail_record_collection_keeps_only_the_bounded_recent_suffix() {
        let temp = tempdir().unwrap();
        let export = temp.path().join("bundle.json");
        let limits = BundleLimits {
            redaction: RedactionLimits {
                max_array_items: 3,
                ..RedactionLimits::default()
            },
            ..BundleLimits::default()
        };
        let mut builder = DiagnosticBundleBuilder::new(
            "Workspace",
            "1.2.3",
            "linux",
            SafeRecoveryClassification::Healthy,
            json!({}),
            limits,
        )
        .unwrap();
        let mut lines = String::new();
        for index in 0..10 {
            writeln!(&mut lines, "{{\"index\":{index}}}").unwrap();
        }
        builder.add_log_tail("recent", lines.as_bytes()).unwrap();
        let preview = builder.preview().unwrap();
        builder.export_json(&export, &preview).unwrap();
        let document: Value = serde_json::from_slice(&fs::read(export).unwrap()).unwrap();
        let records = document["entries"]["logs/recent.json"].as_array().unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["index"], 7);
        assert_eq!(records[2]["index"], 9);
    }

    #[test]
    fn preview_manifest_exactly_matches_exported_manifest_and_entry_sizes() {
        let temp = tempdir().unwrap();
        let export = temp.path().join("bundle.json");
        let mut builder = bundle_builder(json!({ "theme": "dark", "apiToken": "gone" }));
        builder
            .add_log_tail("current", b"{\"level\":\"info\",\"message\":\"ready\"}\n")
            .unwrap();
        let preview = builder.preview().unwrap();
        let report = builder.export_json(&export, &preview).unwrap();
        let bytes = fs::read(&export).unwrap();
        assert_eq!(report.bytes, bytes.len());
        assert_eq!(preview.export_bytes(), bytes.len());
        let document: Value = serde_json::from_slice(&bytes).unwrap();
        let exported_manifest: BundleManifest =
            serde_json::from_value(document["manifest"].clone()).unwrap();
        assert_eq!(&exported_manifest, preview.manifest());
        for entry in &exported_manifest.entries {
            let content = &document["entries"][&entry.name];
            assert_eq!(serde_json::to_vec(content).unwrap().len(), entry.bytes);
        }
    }

    #[test]
    fn export_is_atomic_and_refuses_existing_destination() {
        let temp = tempdir().unwrap();
        let builder = bundle_builder(json!({ "theme": "dark" }));
        let preview = builder.preview().unwrap();
        let export = temp.path().join("bundle.json");
        builder.export_json(&export, &preview).unwrap();
        let metadata = fs::symlink_metadata(&export).unwrap();
        assert!(metadata.file_type().is_file());
        let original = fs::read(&export).unwrap();
        assert!(matches!(
            builder.export_json(&export, &preview),
            Err(DiagnosticsError::DestinationExists)
        ));
        assert_eq!(fs::read(&export).unwrap(), original);
    }

    #[test]
    #[cfg(unix)]
    fn unix_export_is_owner_only_and_refuses_symlink_destination() {
        let temp = tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o750)).unwrap();
        let builder = bundle_builder(json!({ "theme": "dark" }));
        let preview = builder.preview().unwrap();
        let export = temp.path().join("bundle.json");
        builder.export_json(&export, &preview).unwrap();
        let metadata = fs::symlink_metadata(&export).unwrap();
        assert!(metadata.file_type().is_file());
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
            0o750
        );
        let target = temp.path().join("target.json");
        fs::write(&target, b"target remains").unwrap();
        let link = temp.path().join("link.json");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            builder.export_json(&link, &preview),
            Err(DiagnosticsError::DestinationExists)
        ));
        assert_eq!(fs::read(target).unwrap(), b"target remains");
    }

    #[test]
    fn changed_builder_is_rejected_after_preview() {
        let temp = tempdir().unwrap();
        let export = temp.path().join("bundle.json");
        let mut builder = bundle_builder(json!({ "theme": "dark" }));
        let preview = builder.preview().unwrap();
        builder.add_log_tail("later", b"{}\n").unwrap();
        assert!(matches!(
            builder.export_json(&export, &preview),
            Err(DiagnosticsError::PreviewMismatch)
        ));
        assert!(!export.exists());
    }

    #[test]
    #[cfg(unix)]
    fn writer_refuses_symlink_and_hard_link_active_files() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("logs");
        fs::create_dir(&directory).unwrap();
        let target = temp.path().join("target");
        fs::write(&target, b"do not touch").unwrap();
        symlink(&target, directory.join(ACTIVE_LOG_FILENAME)).unwrap();
        assert!(RotatingJsonWriter::new(small_log_config(&directory)).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"do not touch");

        fs::remove_file(directory.join(ACTIVE_LOG_FILENAME)).unwrap();
        fs::hard_link(&target, directory.join(ACTIVE_LOG_FILENAME)).unwrap();
        assert!(RotatingJsonWriter::new(small_log_config(&directory)).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"do not touch");
    }

    #[test]
    #[cfg(unix)]
    fn writer_does_not_create_directories_through_a_symlink_component() {
        let temp = tempdir().unwrap();
        let real = temp.path().join("real");
        fs::create_dir(&real).unwrap();
        let alias = temp.path().join("alias");
        symlink(&real, &alias).unwrap();
        let attempted = alias.join("nested");
        assert!(RotatingJsonWriter::new(small_log_config(&attempted)).is_err());
        assert!(!real.join("nested").exists());
    }
}

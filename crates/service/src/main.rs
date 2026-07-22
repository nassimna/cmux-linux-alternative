use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead as _, Read as _, Seek as _, Write as _},
    path::{Component, Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use agent_workspace_config::{AppConfig, ConfigError, ConfigStore, LogLevel};
use agent_workspace_control_server::{
    ControlServer, DesktopProviderBootstrapSecret, LoggingRuntime, PersistenceServices,
};
use agent_workspace_core::{MAX_SAFE_INTEGER, ShortcutPlatform, Timestamp};
use agent_workspace_diagnostics::{
    ACTIVE_LOG_FILENAME, BundleLimits, BundlePreview, DiagnosticBundleBuilder, LogConfig,
    RotatingJsonWriter, SafeRecoveryClassification,
};
use agent_workspace_notification_runtime::{CliSessionGuard, CliSessionRecord};
use agent_workspace_process_containment::ProcessContainment;
use agent_workspace_protocol::{
    APPLICATION_ID, DiagnosticBundleEntry, DiagnosticBundlePreview, PROTOCOL_VERSION,
    RecoveryExportResult, ServiceReadyRecord, ServiceRecoveryCategory,
    ServiceRecoveryRequiredRecord,
};
use agent_workspace_runtime::{
    BootstrapConfig, OperationFailure, ProductionWorkspaceRuntime, RuntimeError,
    TerminalManagerBackend,
};
use agent_workspace_storage::{
    MigrationOutcome, RecoveryClassification, RecoveryExportMode, RecoveryInspection,
    SqliteStateStore, StorageError,
};
use agent_workspace_terminal_runtime::TerminalManager;
use agent_workspace_terminal_runtime::remote::{
    delete_target_credential, enroll_target_credential_from_file,
};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::info;
use tracing_subscriber::{
    EnvFilter, fmt::writer::MakeWriterExt as _, layer::SubscriberExt as _, reload,
};
use uuid::Uuid;

const DIAGNOSTIC_APPROVAL_FILENAME: &str = "diagnostic-preview.approval.json";
const DIAGNOSTIC_APPROVAL_MAX_BYTES: u64 = 512 * 1024;
const DIAGNOSTIC_LOG_TAIL_BYTES: u64 = 64 * 1024;
const DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE: &str =
    "AGENT_WORKSPACE_DESKTOP_BOOTSTRAP_PROOF";

#[derive(Debug, Parser)]
#[command(version, about = "Local control service for Agent Workspace")]
struct Arguments {
    /// Unix-domain socket path on Unix or local named-pipe name on Windows.
    #[arg(long)]
    endpoint: Option<String>,

    /// Owner-only ephemeral discovery record used by the public CLI.
    #[arg(long)]
    cli_session_file: Option<PathBuf>,

    /// Durable `SQLite` state path.
    #[arg(long)]
    state_db: Option<PathBuf>,

    /// Versioned owner-only configuration file.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Owner-only structured diagnostic log directory.
    #[arg(long)]
    log_dir: Option<PathBuf>,

    /// Working directory used only when the durable database has no application state.
    #[arg(long)]
    default_cwd: Option<PathBuf>,

    #[command(subcommand)]
    utility: Option<UtilityCommand>,
}

#[derive(Debug, Subcommand)]
enum UtilityCommand {
    /// Validate and enroll one SSH key selected by the trusted desktop provider.
    CredentialEnroll {
        #[arg(long)]
        state_db: PathBuf,
        #[arg(long)]
        enrollment_id: Uuid,
        #[arg(long)]
        target_id: Uuid,
        #[arg(long)]
        expected_revision: u64,
        #[arg(long)]
        key_fd: u8,
    },
    /// Commit an initial enrollment after target creation is durable.
    CredentialCommit {
        #[arg(long)]
        state_db: PathBuf,
        #[arg(long)]
        enrollment_id: Uuid,
        #[arg(long)]
        target_id: Uuid,
        #[arg(long)]
        expected_revision: u64,
    },
    /// Remove the exact SSH credential for a target. Missing credentials succeed.
    CredentialRemove {
        #[arg(long)]
        state_db: Option<PathBuf>,
        #[arg(long)]
        enrollment_id: Option<Uuid>,
        #[arg(long)]
        target_id: Uuid,
    },
    /// Inspect the database read-only and emit a safe classification.
    RecoveryInspect {
        #[arg(long)]
        state_db: PathBuf,
    },
    /// Create a data-preserving recovery copy; an existing destination is refused.
    RecoveryExport {
        #[arg(long)]
        state_db: PathBuf,
        #[arg(long)]
        destination: PathBuf,
    },
    /// Emit the exact content-free manifest and create a one-time approval file.
    DiagnosticsPreview {
        #[arg(long)]
        state_db: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        log_dir: PathBuf,
    },
    /// Consume the one-time approval and create the exact previewed bundle.
    DiagnosticsExport {
        #[arg(long)]
        state_db: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        log_dir: PathBuf,
        #[arg(long)]
        destination: PathBuf,
    },
}

#[derive(Debug)]
struct ServerArguments {
    endpoint: String,
    cli_session_file: PathBuf,
    state_db: PathBuf,
    config: PathBuf,
    log_dir: PathBuf,
    default_cwd: PathBuf,
}

#[derive(Debug)]
struct SafeError(&'static str);

impl std::fmt::Display for SafeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for SafeError {}

enum ServerFailure {
    Startup(ServiceRecoveryRequiredRecord),
    AfterReady,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticApproval {
    builder_preview: BundlePreview,
    wire_preview: DiagnosticBundlePreview,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RecoveryInspectionCategory {
    Healthy,
    MigrationRequired,
    FutureSchema,
    CorruptDatabase,
    CorruptSchema,
    InvalidSnapshot,
    InvalidWindowState,
    MigrationFailed,
    Permissions,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeRecoveryInspectionResult {
    classification: RecoveryInspectionCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    migration_from: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    migration_to: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticExportResult {
    path: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialUtilityResult {
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceRecoveryRequiredWire<'a> {
    event: &'a str,
    application: &'a str,
    version: &'a str,
    protocol_version: u32,
    category: ServiceRecoveryCategory,
    message: &'a str,
    migration_backup_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    migration_backup_path: Option<&'a str>,
}

fn main() -> ExitCode {
    let desktop_bootstrap = take_desktop_bootstrap_proof();
    let Ok(_process_containment) = ProcessContainment::from_environment() else {
        let _ = emit_recovery_record(
            io::stdout().lock(),
            &startup_record(
                ServiceRecoveryCategory::Unknown,
                "The requested process containment could not be established.",
            ),
        );
        return ExitCode::FAILURE;
    };
    let arguments = Arguments::parse();
    let server_flags_present = has_server_flags(&arguments);
    match arguments.utility {
        Some(utility) => {
            if server_flags_present {
                eprintln!("utility modes cannot be combined with server flags");
                return ExitCode::FAILURE;
            }
            match run_utility(utility) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{error}");
                    ExitCode::FAILURE
                }
            }
        }
        None => run_server_entry(arguments, desktop_bootstrap),
    }
}

fn run_server_entry(
    arguments: Arguments,
    desktop_bootstrap: Result<Option<DesktopProviderBootstrapSecret>, SafeError>,
) -> ExitCode {
    let desktop_bootstrap = match desktop_bootstrap {
        Ok(desktop_bootstrap) => desktop_bootstrap,
        Err(error) => {
            let _ = emit_recovery_record(
                io::stdout().lock(),
                &startup_record(ServiceRecoveryCategory::Permissions, error.0),
            );
            return ExitCode::FAILURE;
        }
    };
    let arguments = match resolve_server_arguments(arguments) {
        Ok(arguments) => arguments,
        Err(error) => {
            let _ = emit_recovery_record(
                io::stdout().lock(),
                &startup_record(ServiceRecoveryCategory::Permissions, error.0),
            );
            return ExitCode::FAILURE;
        }
    };
    let configured_log_level = ConfigStore::new(arguments.config.clone())
        .load()
        .ok()
        .map(|config| config.logging.level);
    let logging_runtime = match initialize_logging(&arguments.log_dir, configured_log_level) {
        Ok(logging_runtime) => logging_runtime,
        Err(error) => {
            let _ = emit_recovery_record(
                io::stdout().lock(),
                &startup_record(ServiceRecoveryCategory::Unknown, error.0),
            );
            return ExitCode::FAILURE;
        }
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        let _ = emit_recovery_record(
            io::stdout().lock(),
            &startup_record(
                ServiceRecoveryCategory::Unknown,
                "The service runtime could not be initialized.",
            ),
        );
        return ExitCode::FAILURE;
    };
    match runtime.block_on(run_server(arguments, logging_runtime, desktop_bootstrap)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(ServerFailure::Startup(record)) => {
            let _ = emit_recovery_record(io::stdout().lock(), &record);
            ExitCode::FAILURE
        }
        Err(ServerFailure::AfterReady) => {
            eprintln!("the service stopped after startup");
            ExitCode::FAILURE
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn run_server(
    arguments: ServerArguments,
    logging_runtime: LoggingRuntime,
    desktop_bootstrap: Option<DesktopProviderBootstrapSecret>,
) -> Result<(), ServerFailure> {
    let config_store = Arc::new(ConfigStore::new(arguments.config));
    let config = config_store
        .load()
        .map_err(|error| ServerFailure::Startup(config_failure_record(&error)))?;

    let platform = service_platform();
    let (store, migration) = SqliteStateStore::open_with_report(&arguments.state_db, platform)
        .map_err(|error| ServerFailure::Startup(storage_failure_record(&error)))?;
    log_migration_outcome(&migration);
    for (enrollment_id, target_id) in store
        .pending_remote_credential_enrollments()
        .map_err(|error| ServerFailure::Startup(storage_failure_record(&error)))?
    {
        delete_target_credential(target_id).await.map_err(|_| {
            ServerFailure::Startup(startup_record(
                ServiceRecoveryCategory::Unknown,
                "Interrupted credential enrollment cleanup must complete before startup.",
            ))
        })?;
        store
            .abort_remote_credential_enrollment(enrollment_id, target_id)
            .map_err(|error| ServerFailure::Startup(storage_failure_record(&error)))?;
    }
    let store = Arc::new(store);
    let backend = Arc::new(TerminalManagerBackend::new(TerminalManager::new()));
    let configured_shell = config.terminal.shell_path.map(PathBuf::from);
    if backend
        .validate_configured_shell(configured_shell.as_deref())
        .is_err()
    {
        return Err(ServerFailure::Startup(startup_record(
            ServiceRecoveryCategory::Unknown,
            "The configured terminal shell is not usable on this host.",
        )));
    }
    backend.set_configured_shell(configured_shell);
    let bootstrap =
        BootstrapConfig::for_service(arguments.default_cwd, now(), 24, 80).map_err(|_| {
            ServerFailure::Startup(startup_record(
                ServiceRecoveryCategory::Unknown,
                "The default workspace could not be initialized.",
            ))
        })?;
    let migration_backup_path = verified_migration_backup(&migration);
    let workspace_runtime = Arc::new(
        ProductionWorkspaceRuntime::bootstrap(Arc::clone(&store), Arc::clone(&backend), bootstrap)
            .await
            .map_err(|failure| {
                let inspection = SqliteStateStore::inspect_recovery(&arguments.state_db, platform);
                ServerFailure::Startup(with_migration_backup(
                    bootstrap_failure_record(&failure, &inspection),
                    migration_backup_path.as_deref(),
                ))
            })?,
    );

    let (token, parent_liveness) = read_control_token_and_watch_parent().map_err(|_| {
        ServerFailure::Startup(with_migration_backup(
            startup_record(
                ServiceRecoveryCategory::Unknown,
                "The control token was missing or invalid.",
            ),
            migration_backup_path.as_deref(),
        ))
    })?;
    let persistence = PersistenceServices::new(Arc::clone(&config_store), Arc::clone(&store));
    let server = match desktop_bootstrap {
        Some(desktop_bootstrap) => ControlServer::bind_with_runtime_persistence_and_multi_window(
            &arguments.endpoint,
            token.as_bytes(),
            Arc::clone(&workspace_runtime),
            backend.as_ref(),
            platform,
            logging_runtime,
            persistence,
            desktop_bootstrap,
        ),
        None => ControlServer::bind_with_runtime_and_persistence(
            &arguments.endpoint,
            token.as_bytes(),
            Arc::clone(&workspace_runtime),
            backend.as_ref(),
            platform,
            logging_runtime,
            persistence,
        ),
    };
    let Ok(server) = server else {
        let _ = workspace_runtime.shutdown().await;
        return Err(ServerFailure::Startup(with_migration_backup(
            startup_record(
                ServiceRecoveryCategory::Permissions,
                "The local control endpoint could not be created safely.",
            ),
            migration_backup_path.as_deref(),
        )));
    };
    let cli_session = CliSessionRecord::current(arguments.endpoint, token);
    let Ok(_session_guard) = CliSessionGuard::create(&arguments.cli_session_file, &cli_session)
    else {
        let _ = workspace_runtime.shutdown().await;
        return Err(ServerFailure::Startup(with_migration_backup(
            startup_record(
                ServiceRecoveryCategory::Permissions,
                "The CLI discovery record could not be created safely.",
            ),
            migration_backup_path.as_deref(),
        )));
    };
    if emit_json_line(io::stdout().lock(), &ServiceReadyRecord::current()).is_err() {
        let _ = workspace_runtime.shutdown().await;
        return Err(ServerFailure::AfterReady);
    }
    info!("local control service ready");
    let server_result = server.run(shutdown_signal(parent_liveness)).await;
    let _ = workspace_runtime.shutdown().await;
    server_result.map_err(|_| ServerFailure::AfterReady)
}

fn take_desktop_bootstrap_proof() -> Result<Option<DesktopProviderBootstrapSecret>, SafeError> {
    consume_desktop_bootstrap_proof(
        || std::env::var_os(DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE),
        || env::remove_var(DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE).is_some(),
    )
}

fn consume_desktop_bootstrap_proof(
    read: impl FnOnce() -> Option<std::ffi::OsString>,
    remove: impl FnOnce() -> bool,
) -> Result<Option<DesktopProviderBootstrapSecret>, SafeError> {
    let proof = read();
    if !remove() {
        return Err(SafeError(
            "The desktop bootstrap proof was missing or invalid.",
        ));
    }
    let Some(proof) = proof else {
        return Ok(None);
    };
    let proof = proof
        .into_string()
        .map_err(|_| SafeError("The desktop bootstrap proof was missing or invalid."))?;
    DesktopProviderBootstrapSecret::new(proof.as_bytes())
        .map(Some)
        .map_err(|_| SafeError("The desktop bootstrap proof was missing or invalid."))
}

fn resolve_server_arguments(arguments: Arguments) -> Result<ServerArguments, SafeError> {
    if arguments.utility.is_some() {
        return Err(SafeError("a utility mode cannot start the server"));
    }
    let endpoint = arguments
        .endpoint
        .filter(|value| !value.trim().is_empty())
        .ok_or(SafeError("the service endpoint is required"))?;
    let cli_session_file = absolute_path(required_path(
        arguments.cli_session_file,
        "the CLI session path is required",
    )?)
    .map_err(|_| SafeError("the CLI session path is invalid"))?;
    let state_db = absolute_path(required_path(
        arguments.state_db,
        "the state database path is required",
    )?)
    .map_err(|_| SafeError("the state database path is invalid"))?;
    let config = absolute_path(required_path(
        arguments.config,
        "the configuration path is required",
    )?)
    .map_err(|_| SafeError("the configuration path is invalid"))?;
    let log_dir = absolute_path(required_path(
        arguments.log_dir,
        "the log directory is required",
    )?)
    .map_err(|_| SafeError("the log directory is invalid"))?;
    let default_cwd = match arguments.default_cwd {
        Some(path) => absolute_path(path)
            .map_err(|_| SafeError("the default working directory is invalid"))?,
        None => std::env::current_dir()
            .and_then(absolute_path)
            .map_err(|_| SafeError("the default working directory is unavailable"))?,
    };
    Ok(ServerArguments {
        endpoint,
        cli_session_file,
        state_db,
        config,
        log_dir,
        default_cwd,
    })
}

fn required_path(path: Option<PathBuf>, message: &'static str) -> Result<PathBuf, SafeError> {
    path.filter(|value| !value.as_os_str().is_empty())
        .ok_or(SafeError(message))
}

fn has_server_flags(arguments: &Arguments) -> bool {
    arguments.endpoint.is_some()
        || arguments.cli_session_file.is_some()
        || arguments.state_db.is_some()
        || arguments.config.is_some()
        || arguments.log_dir.is_some()
        || arguments.default_cwd.is_some()
}

#[allow(clippy::too_many_lines)]
fn run_utility(command: UtilityCommand) -> Result<(), SafeError> {
    match command {
        UtilityCommand::CredentialEnroll {
            state_db,
            enrollment_id,
            target_id,
            expected_revision,
            key_fd,
        } => {
            #[cfg(unix)]
            let key_file = { open_inherited_credential_fd(key_fd)? };
            #[cfg(not(unix))]
            return Err(SafeError(
                "credential enrollment is unavailable on this platform",
            ));
            #[cfg(unix)]
            {
                let store = SqliteStateStore::open(state_db, service_platform())
                    .map_err(|_| SafeError("the credential enrollment could not be prepared"))?;
                if !store
                    .prepare_remote_credential_enrollment(
                        enrollment_id,
                        target_id,
                        expected_revision,
                        i64::try_from(now().0).unwrap_or(i64::MAX),
                    )
                    .map_err(|_| SafeError("the credential enrollment could not be prepared"))?
                {
                    return Err(SafeError("the credential enrollment was fenced"));
                }
                if run_credential_future(enroll_target_credential_from_file(target_id, key_file))
                    .is_err()
                {
                    if run_credential_future(delete_target_credential(target_id)).is_ok() {
                        let _ = store.abort_remote_credential_enrollment(enrollment_id, target_id);
                    }
                    return Err(SafeError("the credential operation could not be completed"));
                }
                if expected_revision != 0
                    && !store
                        .commit_remote_credential_enrollment(
                            enrollment_id,
                            target_id,
                            expected_revision,
                        )
                        .map_err(|_| {
                            SafeError("the credential enrollment could not be committed")
                        })?
                {
                    let _ = run_credential_future(delete_target_credential(target_id));
                    let _ = store.abort_remote_credential_enrollment(enrollment_id, target_id);
                    return Err(SafeError("the credential enrollment was fenced"));
                }
            }
            emit_json_line(
                io::stdout().lock(),
                &CredentialUtilityResult { status: "stored" },
            )
            .map_err(|_| SafeError("the credential enrollment result could not be written"))
        }
        UtilityCommand::CredentialCommit {
            state_db,
            enrollment_id,
            target_id,
            expected_revision,
        } => {
            let store = SqliteStateStore::open(state_db, service_platform())
                .map_err(|_| SafeError("the credential enrollment could not be committed"))?;
            if !store
                .commit_remote_credential_enrollment(enrollment_id, target_id, expected_revision)
                .map_err(|_| SafeError("the credential enrollment could not be committed"))?
            {
                let _ = run_credential_future(delete_target_credential(target_id));
                let _ = store.abort_remote_credential_enrollment(enrollment_id, target_id);
                return Err(SafeError("the credential enrollment was fenced"));
            }
            emit_json_line(
                io::stdout().lock(),
                &CredentialUtilityResult { status: "stored" },
            )
            .map_err(|_| SafeError("the credential enrollment result could not be written"))
        }
        UtilityCommand::CredentialRemove {
            state_db,
            enrollment_id,
            target_id,
        } => {
            run_credential_future(delete_target_credential(target_id))?;
            if let (Some(state_db), Some(enrollment_id)) = (state_db, enrollment_id) {
                let store = SqliteStateStore::open(state_db, service_platform())
                    .map_err(|_| SafeError("the credential enrollment could not be aborted"))?;
                store
                    .abort_remote_credential_enrollment(enrollment_id, target_id)
                    .map_err(|_| SafeError("the credential enrollment could not be aborted"))?;
            }
            emit_json_line(
                io::stdout().lock(),
                &CredentialUtilityResult { status: "removed" },
            )
            .map_err(|_| SafeError("the credential removal result could not be written"))
        }
        UtilityCommand::RecoveryInspect { state_db } => {
            let state_db = absolute_path(state_db)
                .map_err(|_| SafeError("the state database path is invalid"))?;
            let inspection = SqliteStateStore::inspect_recovery(state_db, service_platform());
            emit_json_line(io::stdout().lock(), &safe_recovery_inspection(&inspection))
                .map_err(|_| SafeError("the recovery inspection result could not be written"))
        }
        UtilityCommand::RecoveryExport {
            state_db,
            destination,
        } => run_recovery_export(state_db, destination, io::stdout().lock()),
        UtilityCommand::DiagnosticsPreview {
            state_db,
            config,
            log_dir,
        } => {
            let paths = resolve_diagnostic_paths(state_db, config, log_dir)?;
            validate_log_directory(&paths.log_dir)?;
            let builder = diagnostic_builder(&paths)?;
            let builder_preview = builder
                .preview()
                .map_err(|_| SafeError("the diagnostic preview could not be prepared"))?;
            let wire_preview = diagnostic_wire_preview(&builder_preview)?;
            let approval = DiagnosticApproval {
                builder_preview,
                wire_preview: wire_preview.clone(),
            };
            revoke_existing_approval(&paths.log_dir)?;
            write_approval(&paths.log_dir, &approval)?;
            emit_json_line(io::stdout().lock(), &wire_preview)
                .map_err(|_| SafeError("the diagnostic preview could not be written"))
        }
        UtilityCommand::DiagnosticsExport {
            state_db,
            config,
            log_dir,
            destination,
        } => {
            let paths = resolve_diagnostic_paths(state_db, config, log_dir)?;
            validate_log_directory(&paths.log_dir)?;
            let destination = absolute_path(destination)
                .map_err(|_| SafeError("the diagnostic destination is invalid"))?;
            let destination_text = path_text(&destination)
                .ok_or(SafeError("the diagnostic destination is not portable"))?;
            let builder = diagnostic_builder(&paths)?;
            let approval = take_approval(&paths.log_dir)?;
            let current_preview = builder
                .preview()
                .map_err(|_| SafeError("the diagnostic bundle could not be prepared"))?;
            if current_preview != approval.builder_preview {
                return Err(SafeError(
                    "the diagnostic bundle changed after it was approved",
                ));
            }
            let report = builder
                .export_json(destination, &approval.builder_preview)
                .map_err(|_| SafeError("the diagnostic bundle could not be exported safely"))?;
            let bytes = u64::try_from(report.bytes)
                .map_err(|_| SafeError("the diagnostic export is too large to report"))?;
            emit_json_line(
                io::stdout().lock(),
                &DiagnosticExportResult {
                    path: destination_text,
                    bytes,
                },
            )
            .map_err(|_| SafeError("the diagnostic export result could not be written"))
        }
    }
}

#[cfg(unix)]
fn open_inherited_credential_fd(key_fd: u8) -> Result<File, SafeError> {
    if key_fd != 3 {
        return Err(SafeError("the credential descriptor is invalid"));
    }
    // Inspect the inherited open-file description before duplicating it. Reopening a
    // writable descriptor through /proc with O_RDONLY would otherwise hide its authority.
    let fd_info = fs::read_to_string("/proc/self/fdinfo/3")
        .map_err(|_| SafeError("the credential descriptor is invalid"))?;
    let flags = fd_info
        .lines()
        .find_map(|line| line.strip_prefix("flags:\t"))
        .and_then(|value| u32::from_str_radix(value, 8).ok())
        .ok_or(SafeError("the credential descriptor is invalid"))?;
    if flags & 0o3 != 0 {
        return Err(SafeError("the credential descriptor is invalid"));
    }
    // No user-selected pathname is accepted or reopened by the utility.
    File::open("/proc/self/fd/3").map_err(|_| SafeError("the credential descriptor is invalid"))
}

fn run_credential_future<F>(future: F) -> Result<(), SafeError>
where
    F: std::future::Future<
            Output = Result<(), agent_workspace_terminal_runtime::remote::RemoteRuntimeError>,
        >,
{
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| SafeError("the credential service could not be initialized"))?;
    runtime
        .block_on(future)
        .map_err(|_| SafeError("the credential operation could not be completed"))
}

fn run_recovery_export(
    state_db: PathBuf,
    destination: PathBuf,
    output: impl io::Write,
) -> Result<(), SafeError> {
    let state_db =
        absolute_path(state_db).map_err(|_| SafeError("the state database path is invalid"))?;
    let destination =
        absolute_path(destination).map_err(|_| SafeError("the recovery destination is invalid"))?;
    let destination_text =
        path_text(&destination).ok_or(SafeError("the recovery destination is not portable"))?;
    SqliteStateStore::export_recovery_copy(state_db, &destination, RecoveryExportMode::CreateNew)
        .map_err(|_| SafeError("the recovery database could not be exported safely"))?;
    let bytes = fs::metadata(&destination)
        .map_err(|_| SafeError("the recovery export could not be verified"))?
        .len();
    if bytes > MAX_SAFE_INTEGER {
        return Err(SafeError("the recovery export is too large to report"));
    }
    emit_json_line(
        output,
        &RecoveryExportResult {
            path: destination_text,
            bytes,
        },
    )
    .map_err(|_| SafeError("the recovery export result could not be written"))
}

struct DiagnosticPaths {
    state_db: PathBuf,
    config: PathBuf,
    log_dir: PathBuf,
}

fn resolve_diagnostic_paths(
    state_db: PathBuf,
    config: PathBuf,
    log_dir: PathBuf,
) -> Result<DiagnosticPaths, SafeError> {
    Ok(DiagnosticPaths {
        state_db: absolute_path(state_db)
            .map_err(|_| SafeError("the state database path is invalid"))?,
        config: absolute_path(config)
            .map_err(|_| SafeError("the configuration path is invalid"))?,
        log_dir: absolute_path(log_dir).map_err(|_| SafeError("the log directory is invalid"))?,
    })
}

fn validate_log_directory(log_dir: &Path) -> Result<(), SafeError> {
    RotatingJsonWriter::new(LogConfig::new(log_dir))
        .map(|_| ())
        .map_err(|_| SafeError("the diagnostic log directory is unsafe or unavailable"))
}

fn diagnostic_builder(paths: &DiagnosticPaths) -> Result<DiagnosticBundleBuilder, SafeError> {
    let config = ConfigStore::new(paths.config.clone())
        .load()
        .map_err(|_| SafeError("the configuration summary could not be loaded safely"))?;
    let recovery = SqliteStateStore::inspect_recovery(&paths.state_db, service_platform());
    let mut builder = DiagnosticBundleBuilder::new(
        APPLICATION_ID,
        env!("CARGO_PKG_VERSION"),
        platform_name(),
        diagnostic_recovery_classification(&recovery.classification),
        safe_config_summary(&config),
        BundleLimits::default(),
    )
    .map_err(|_| SafeError("the diagnostic bundle could not be initialized"))?;
    if let Some(tail) = read_bounded_log_tail(&paths.log_dir.join(ACTIVE_LOG_FILENAME))? {
        builder
            .add_log_tail("service", &tail)
            .map_err(|_| SafeError("the diagnostic log tail could not be added"))?;
    }
    Ok(builder)
}

fn diagnostic_wire_preview(preview: &BundlePreview) -> Result<DiagnosticBundlePreview, SafeError> {
    let entries = preview
        .manifest()
        .entries
        .iter()
        .map(|entry| {
            Ok(DiagnosticBundleEntry {
                name: entry.name.clone(),
                bytes: u64::try_from(entry.bytes)
                    .map_err(|_| SafeError("a diagnostic entry is too large"))?,
            })
        })
        .collect::<Result<Vec<_>, SafeError>>()?;
    let total_bytes = u64::try_from(preview.manifest().total_entry_bytes)
        .map_err(|_| SafeError("the diagnostic preview is too large"))?;
    let redaction_count = u64::try_from(preview.manifest().total_redactions)
        .map_err(|_| SafeError("the diagnostic redaction count is too large"))?;
    Ok(DiagnosticBundlePreview {
        entries,
        total_bytes,
        redaction_count,
        created_at: now().0,
    })
}

fn safe_config_summary(config: &AppConfig) -> Value {
    json!({
        "schemaVersion": config.schema_version,
        "revision": config.revision,
        "appearance": {
            "theme": config.appearance.theme,
            "density": config.appearance.density,
            "fontFamily": config.appearance.font_family,
        },
        "terminal": {
            "fontSize": config.terminal.font_size,
            "scrollback": config.terminal.scrollback,
            "multilinePasteProtection": config.terminal.multiline_paste_protection,
            "hasCustomShell": config.terminal.shell_path.is_some(),
        },
        "browser": {
            "privacy": config.browser.privacy,
        },
        "notifications": {
            "systemEnabled": config.notifications.system_enabled,
            "includeBody": config.notifications.include_body,
        },
        "keyboardShortcuts": {
            "overrideCount": config.keyboard_shortcuts.overrides.len(),
        },
        "agentIntegration": {
            "enabled": config.agent_integration.enabled,
            "notificationsEnabled": config.agent_integration.notifications_enabled,
            "browserEnabled": config.agent_integration.browser_enabled,
        },
        "updates": {
            "channel": config.updates.channel,
        },
        "logging": {
            "level": config.logging.level,
        },
    })
}

fn read_bounded_log_tail(path: &Path) -> Result<Option<Vec<u8>>, SafeError> {
    let before = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SafeError("the diagnostic log could not be inspected")),
    };
    validate_private_regular_file(&before)?;
    let mut file =
        File::open(path).map_err(|_| SafeError("the diagnostic log could not be read"))?;
    let opened = file
        .metadata()
        .map_err(|_| SafeError("the diagnostic log could not be verified"))?;
    validate_private_regular_file(&opened)?;
    if !same_file(&before, &opened) {
        return Err(SafeError("the diagnostic log changed while it was opened"));
    }
    let start = opened.len().saturating_sub(DIAGNOSTIC_LOG_TAIL_BYTES);
    file.seek(io::SeekFrom::Start(start))
        .map_err(|_| SafeError("the diagnostic log could not be read"))?;
    let mut bytes =
        Vec::with_capacity(usize::try_from(opened.len().saturating_sub(start)).unwrap_or(0));
    file.take(DIAGNOSTIC_LOG_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| SafeError("the diagnostic log could not be read"))?;
    Ok(Some(bytes))
}

fn write_approval(log_dir: &Path, approval: &DiagnosticApproval) -> Result<(), SafeError> {
    let bytes = serde_json::to_vec(approval)
        .map_err(|_| SafeError("the diagnostic approval could not be encoded"))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > DIAGNOSTIC_APPROVAL_MAX_BYTES {
        return Err(SafeError("the diagnostic approval is too large"));
    }
    let path = log_dir.join(DIAGNOSTIC_APPROVAL_FILENAME);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| SafeError("a diagnostic preview is already pending"))?;
    let write_result = file
        .write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all());
    if write_result.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(SafeError("the diagnostic approval could not be saved"));
    }
    let metadata = file
        .metadata()
        .map_err(|_| SafeError("the diagnostic approval could not be verified"))?;
    validate_private_regular_file(&metadata)?;
    Ok(())
}

fn revoke_existing_approval(log_dir: &Path) -> Result<(), SafeError> {
    let path = log_dir.join(DIAGNOSTIC_APPROVAL_FILENAME);
    let before = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(SafeError("the prior diagnostic approval is unavailable")),
    };
    validate_private_regular_file(&before)?;
    let file = File::open(&path)
        .map_err(|_| SafeError("the prior diagnostic approval could not be opened"))?;
    let opened = file
        .metadata()
        .map_err(|_| SafeError("the prior diagnostic approval could not be verified"))?;
    validate_private_regular_file(&opened)?;
    if !same_file(&before, &opened) {
        return Err(SafeError(
            "the prior diagnostic approval changed while it was opened",
        ));
    }
    drop(file);
    remove_same_file(&path, &opened)
}

fn take_approval(log_dir: &Path) -> Result<DiagnosticApproval, SafeError> {
    let path = log_dir.join(DIAGNOSTIC_APPROVAL_FILENAME);
    let before = fs::symlink_metadata(&path)
        .map_err(|_| SafeError("no approved diagnostic preview is pending"))?;
    validate_private_regular_file(&before)?;
    if before.len() > DIAGNOSTIC_APPROVAL_MAX_BYTES {
        return Err(SafeError("the diagnostic approval is too large"));
    }
    let mut file =
        File::open(&path).map_err(|_| SafeError("the diagnostic approval could not be opened"))?;
    let opened = file
        .metadata()
        .map_err(|_| SafeError("the diagnostic approval could not be verified"))?;
    validate_private_regular_file(&opened)?;
    if !same_file(&before, &opened) {
        return Err(SafeError(
            "the diagnostic approval changed while it was opened",
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(0));
    (&mut file)
        .take(DIAGNOSTIC_APPROVAL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SafeError("the diagnostic approval could not be read"))?;
    drop(file);
    remove_same_file(&path, &opened)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| SafeError("the diagnostic approval is invalid or has changed"))
}

fn remove_same_file(path: &Path, opened: &fs::Metadata) -> Result<(), SafeError> {
    let current = fs::symlink_metadata(path)
        .map_err(|_| SafeError("the diagnostic approval could not be consumed"))?;
    if !same_file(&current, opened) {
        return Err(SafeError(
            "the diagnostic approval changed before it was consumed",
        ));
    }
    fs::remove_file(path).map_err(|_| SafeError("the diagnostic approval could not be consumed"))
}

fn validate_private_regular_file(metadata: &fs::Metadata) -> Result<(), SafeError> {
    if !metadata.file_type().is_file() {
        return Err(SafeError("a diagnostics file is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(SafeError("a diagnostics file is not owner-only"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.file_type().is_file()
        && right.file_type().is_file()
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
}

fn level_filter(level: LogLevel) -> EnvFilter {
    let directive = match level {
        LogLevel::Error => "error",
        LogLevel::Warn => "warn",
        LogLevel::Info => "info",
        LogLevel::Debug => "debug",
        LogLevel::Trace => "trace",
    };
    EnvFilter::new(directive)
}

fn logging_runtime(
    handle: reload::Handle<EnvFilter, tracing_subscriber::Registry>,
) -> LoggingRuntime {
    LoggingRuntime::new(move |level| {
        if handle.reload(level_filter(level)).is_err() {
            eprintln!("the structured logging filter could not be updated");
        }
    })
}

fn initialize_logging(
    log_dir: &Path,
    configured_level: Option<LogLevel>,
) -> Result<LoggingRuntime, SafeError> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| level_filter(configured_level.unwrap_or_default()));
    if let Ok(writer) = RotatingJsonWriter::new(LogConfig::new(log_dir)) {
        let (filter, handle) = reload::Layer::new(filter);
        let subscriber = tracing_subscriber::registry().with(filter).with(
            tracing_subscriber::fmt::layer().with_writer(writer.tracing_writer().and(io::stderr)),
        );
        tracing::subscriber::set_global_default(subscriber)
            .map_err(|_| SafeError("structured logging could not be initialized"))?;
        Ok(logging_runtime(handle))
    } else {
        let (filter, handle) = reload::Layer::new(filter);
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().with_writer(io::stderr));
        tracing::subscriber::set_global_default(subscriber)
            .map_err(|_| SafeError("structured logging could not be initialized"))?;
        eprintln!("structured log storage is unavailable; continuing with stderr logging");
        Ok(logging_runtime(handle))
    }
}

fn log_migration_outcome(outcome: &MigrationOutcome) {
    match outcome {
        MigrationOutcome::Current { version } => {
            info!(
                schema_version = *version,
                migration = "current",
                backup_created = false
            );
        }
        MigrationOutcome::Initialized { from, to } => {
            info!(
                schema_from = *from,
                schema_to = *to,
                migration = "initialized",
                backup_created = false
            );
        }
        MigrationOutcome::Upgraded { from, to, .. } => {
            info!(
                schema_from = *from,
                schema_to = *to,
                migration = "upgraded",
                backup_created = true
            );
        }
    }
}

fn verified_migration_backup(outcome: &MigrationOutcome) -> Option<String> {
    let MigrationOutcome::Upgraded { backup_path, .. } = outcome else {
        return None;
    };
    verified_migration_backup_path(backup_path)
}

fn verified_migration_backup_path(backup_path: &Path) -> Option<String> {
    if !backup_path.is_absolute() {
        return None;
    }
    let metadata = fs::symlink_metadata(backup_path).ok()?;
    validate_private_regular_file(&metadata).ok()?;
    path_text(backup_path)
}

fn read_control_token_and_watch_parent() -> io::Result<(String, tokio::sync::oneshot::Receiver<()>)>
{
    let stdin = io::stdin();
    let token = read_control_token_from(stdin.lock())?;
    Ok((token, watch_parent_liveness(stdin)))
}

fn read_control_token_from(input: impl io::BufRead) -> io::Result<String> {
    let mut token = String::new();
    input.take(513).read_line(&mut token)?;
    if token.len() > 512 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control token input is unexpectedly large",
        ));
    }
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    if token.len() < 32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control token is missing or too short",
        ));
    }
    Ok(token)
}

fn watch_parent_liveness(
    mut input: impl io::Read + Send + 'static,
) -> tokio::sync::oneshot::Receiver<()> {
    let (notify_shutdown, shutdown) = tokio::sync::oneshot::channel();
    let _monitor = thread::Builder::new()
        .name("parent-liveness".to_owned())
        .spawn(move || {
            while !parent_channel_closed(&mut input) {}
            let _ = notify_shutdown.send(());
        });
    shutdown
}

fn parent_channel_closed(input: &mut impl io::Read) -> bool {
    let mut buffer = [0_u8; 512];
    matches!(input.read(&mut buffer), Ok(0) | Err(_))
}

fn startup_record(
    category: ServiceRecoveryCategory,
    message: impl Into<String>,
) -> ServiceRecoveryRequiredRecord {
    ServiceRecoveryRequiredRecord {
        event: "service.recoveryRequired".to_owned(),
        application: APPLICATION_ID.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_version: PROTOCOL_VERSION,
        category,
        message: message.into(),
        migration_backup_available: false,
        migration_backup_path: None,
    }
}

fn with_migration_backup(
    mut record: ServiceRecoveryRequiredRecord,
    backup_path: Option<&str>,
) -> ServiceRecoveryRequiredRecord {
    record.migration_backup_path = backup_path.map(str::to_owned);
    record.migration_backup_available = record.migration_backup_path.is_some();
    record
}

fn storage_failure_record(error: &StorageError) -> ServiceRecoveryRequiredRecord {
    if matches!(error, StorageError::Database { .. }) {
        return recovery_classification_record(&RecoveryClassification::from_storage_error(error));
    }
    let (category, message) = match error {
        StorageError::FutureSchema { .. } => (
            ServiceRecoveryCategory::FutureSchema,
            "Durable state was created by a newer service version.",
        ),
        StorageError::Migration { .. } | StorageError::MigrationBackup { .. } => (
            ServiceRecoveryCategory::MigrationFailed,
            "Durable state migration failed; the original database was preserved.",
        ),
        StorageError::CorruptSchema { .. } | StorageError::WalUnavailable { .. } => (
            ServiceRecoveryCategory::CorruptSchema,
            "The durable state schema is incomplete or inconsistent.",
        ),
        StorageError::InvalidSnapshot { .. }
        | StorageError::MalformedSnapshot { .. }
        | StorageError::RevisionMismatch { .. }
        | StorageError::InvalidStoredWindowState { .. }
        | StorageError::MalformedWindowState { .. }
        | StorageError::WindowStateRevisionMismatch { .. }
        | StorageError::InvalidAgentCatalog { .. }
        | StorageError::InvalidRemoteSession { .. } => (
            ServiceRecoveryCategory::InvalidSnapshot,
            "Durable workspace metadata is invalid and was preserved for recovery.",
        ),
        StorageError::CreateDirectory { .. }
        | StorageError::PrepareDatabaseFile { .. }
        | StorageError::Permissions { .. }
        | StorageError::RecoveryExport { .. } => (
            ServiceRecoveryCategory::Permissions,
            "Durable state is unavailable because its path or permissions are unsafe.",
        ),
        StorageError::Database { .. } => unreachable!("database errors return above"),
        StorageError::InvalidState { .. }
        | StorageError::Serialize { .. }
        | StorageError::StaleRevision { .. }
        | StorageError::RevisionConflict { .. }
        | StorageError::InvalidIdempotencyRequest { .. }
        | StorageError::InvalidActionInvocation { .. }
        | StorageError::UnknownWindowPlacement { .. }
        | StorageError::WindowStateLimit { .. }
        | StorageError::InvalidWindowState { .. }
        | StorageError::StaleWindowStateRevision { .. }
        | StorageError::WindowStateRevisionConflict { .. }
        | StorageError::LockPoisoned => (
            ServiceRecoveryCategory::Unknown,
            "Durable state could not be initialized safely.",
        ),
    };
    let backup_path = match error {
        StorageError::Migration {
            backup_path: Some(backup_path),
            ..
        } => verified_migration_backup_path(backup_path),
        _ => None,
    };
    with_migration_backup(startup_record(category, message), backup_path.as_deref())
}

fn config_failure_record(error: &ConfigError) -> ServiceRecoveryRequiredRecord {
    let category = match error {
        ConfigError::InvalidPath | ConfigError::UnsafePath { .. } | ConfigError::Io { .. } => {
            ServiceRecoveryCategory::Permissions
        }
        ConfigError::FutureSchema { .. } => ServiceRecoveryCategory::FutureSchema,
        ConfigError::FileTooLarge { .. }
        | ConfigError::InvalidJson
        | ConfigError::UnsupportedSchema { .. }
        | ConfigError::InvalidSetting { .. }
        | ConfigError::ResourceLimit { .. } => ServiceRecoveryCategory::Unknown,
    };
    startup_record(
        category,
        "The service configuration could not be loaded safely.",
    )
}

fn bootstrap_failure_record(
    failure: &OperationFailure,
    inspection: &RecoveryInspection,
) -> ServiceRecoveryRequiredRecord {
    if matches!(failure.error, RuntimeError::Store(_)) {
        return recovery_classification_record(&inspection.classification);
    }
    startup_record(
        ServiceRecoveryCategory::Unknown,
        "The durable workspace could not be restored. Live processes were not preserved.",
    )
}

fn recovery_classification_record(
    classification: &RecoveryClassification,
) -> ServiceRecoveryRequiredRecord {
    match classification {
        RecoveryClassification::FutureSchema { .. } => startup_record(
            ServiceRecoveryCategory::FutureSchema,
            "Durable state was created by a newer service version.",
        ),
        RecoveryClassification::CorruptSqlite { .. } => startup_record(
            ServiceRecoveryCategory::CorruptDatabase,
            "The durable state database could not be read safely.",
        ),
        RecoveryClassification::CorruptSchema { .. } => startup_record(
            ServiceRecoveryCategory::CorruptSchema,
            "The durable state schema is incomplete or inconsistent.",
        ),
        RecoveryClassification::InvalidSnapshot { .. }
        | RecoveryClassification::MalformedSnapshot { .. }
        | RecoveryClassification::InvalidWindowState { .. }
        | RecoveryClassification::MalformedWindowState { .. } => startup_record(
            ServiceRecoveryCategory::InvalidSnapshot,
            "Durable workspace metadata is invalid and was preserved for recovery.",
        ),
        RecoveryClassification::PermissionOrPath { .. } => startup_record(
            ServiceRecoveryCategory::Permissions,
            "Durable state is unavailable because its path or permissions are unsafe.",
        ),
        RecoveryClassification::MigrationFailure { .. } => startup_record(
            ServiceRecoveryCategory::MigrationFailed,
            "Durable state migration failed; the original database was preserved.",
        ),
        RecoveryClassification::Healthy { .. }
        | RecoveryClassification::MigrationRequired { .. } => startup_record(
            ServiceRecoveryCategory::Unknown,
            "The durable workspace could not be restored. Live processes were not preserved.",
        ),
    }
}

fn safe_recovery_inspection(inspection: &RecoveryInspection) -> SafeRecoveryInspectionResult {
    match &inspection.classification {
        RecoveryClassification::Healthy { schema_version, .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::Healthy,
            schema_version: Some(*schema_version),
            migration_from: None,
            migration_to: None,
        },
        RecoveryClassification::MigrationRequired { from, to, .. } => {
            SafeRecoveryInspectionResult {
                classification: RecoveryInspectionCategory::MigrationRequired,
                schema_version: None,
                migration_from: Some(*from),
                migration_to: Some(*to),
            }
        }
        RecoveryClassification::FutureSchema { found, supported } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::FutureSchema,
            schema_version: Some(*found),
            migration_from: None,
            migration_to: Some(*supported),
        },
        RecoveryClassification::CorruptSqlite { .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::CorruptDatabase,
            schema_version: None,
            migration_from: None,
            migration_to: None,
        },
        RecoveryClassification::CorruptSchema { .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::CorruptSchema,
            schema_version: None,
            migration_from: None,
            migration_to: None,
        },
        RecoveryClassification::InvalidSnapshot { .. }
        | RecoveryClassification::MalformedSnapshot { .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::InvalidSnapshot,
            schema_version: None,
            migration_from: None,
            migration_to: None,
        },
        RecoveryClassification::InvalidWindowState { .. }
        | RecoveryClassification::MalformedWindowState { .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::InvalidWindowState,
            schema_version: None,
            migration_from: None,
            migration_to: None,
        },
        RecoveryClassification::PermissionOrPath { .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::Permissions,
            schema_version: None,
            migration_from: None,
            migration_to: None,
        },
        RecoveryClassification::MigrationFailure { from, to, .. } => SafeRecoveryInspectionResult {
            classification: RecoveryInspectionCategory::MigrationFailed,
            schema_version: None,
            migration_from: Some(*from),
            migration_to: Some(*to),
        },
    }
}

fn diagnostic_recovery_classification(
    classification: &RecoveryClassification,
) -> SafeRecoveryClassification {
    match classification {
        RecoveryClassification::Healthy { .. } => SafeRecoveryClassification::Healthy,
        RecoveryClassification::MigrationRequired { .. } => {
            SafeRecoveryClassification::MigrationRequired
        }
        RecoveryClassification::FutureSchema { .. } => SafeRecoveryClassification::FutureSchema,
        RecoveryClassification::CorruptSqlite { .. }
        | RecoveryClassification::CorruptSchema { .. }
        | RecoveryClassification::MigrationFailure { .. } => {
            SafeRecoveryClassification::CorruptStorage
        }
        RecoveryClassification::InvalidSnapshot { .. }
        | RecoveryClassification::MalformedSnapshot { .. }
        | RecoveryClassification::InvalidWindowState { .. }
        | RecoveryClassification::MalformedWindowState { .. } => {
            SafeRecoveryClassification::InvalidState
        }
        RecoveryClassification::PermissionOrPath { .. } => SafeRecoveryClassification::Unavailable,
    }
}

fn emit_json_line(mut output: impl io::Write, value: &impl Serialize) -> io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(io::Error::other)?;
    line.push(b'\n');
    output.write_all(&line)?;
    output.flush()
}

fn emit_recovery_record(
    output: impl io::Write,
    record: &ServiceRecoveryRequiredRecord,
) -> io::Result<()> {
    emit_json_line(
        output,
        &ServiceRecoveryRequiredWire {
            event: &record.event,
            application: &record.application,
            version: &record.version,
            protocol_version: record.protocol_version,
            category: record.category,
            message: &record.message,
            migration_backup_available: record.migration_backup_available,
            migration_backup_path: record.migration_backup_path.as_deref(),
        },
    )
}

#[cfg(unix)]
async fn os_shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    if let Ok(mut terminate) = signal(SignalKind::terminate()) {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if result.is_err() {
                    tracing::warn!("failed to listen for interrupt signal");
                }
            }
            _ = terminate.recv() => {}
        }
    } else {
        tracing::warn!("failed to listen for termination signal");
        if tokio::signal::ctrl_c().await.is_err() {
            tracing::warn!("failed to listen for interrupt signal");
        }
    }
}

#[cfg(windows)]
async fn os_shutdown_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        tracing::warn!("failed to listen for interrupt signal");
    }
}

async fn shutdown_signal(parent_liveness: tokio::sync::oneshot::Receiver<()>) {
    tokio::select! {
        _ = parent_liveness => {}
        () = os_shutdown_signal() => {}
    }
}

fn absolute_path(path: PathBuf) -> io::Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty path"));
    }
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "path escapes its root",
                    ));
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    if !normalized.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path did not resolve absolutely",
        ));
    }
    Ok(normalized)
}

fn path_text(path: &Path) -> Option<String> {
    path.to_str().map(str::to_owned)
}

const fn service_platform() -> ShortcutPlatform {
    #[cfg(target_os = "macos")]
    {
        ShortcutPlatform::MacOs
    }
    #[cfg(not(target_os = "macos"))]
    {
        ShortcutPlatform::NonMacOs
    }
}

const fn platform_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "unix"
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        "other"
    }
}

fn now() -> Timestamp {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    Timestamp(
        u64::try_from(milliseconds)
            .unwrap_or(MAX_SAFE_INTEGER)
            .min(MAX_SAFE_INTEGER),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::io::Cursor;
    use tempfile::tempdir;

    fn server_cli() -> [&'static str; 11] {
        [
            "service",
            "--endpoint",
            "control.sock",
            "--cli-session-file",
            "cli-session.json",
            "--state-db",
            "state.sqlite3",
            "--config",
            "config.json",
            "--log-dir",
            "logs",
        ]
    }

    #[test]
    fn desktop_bootstrap_proof_is_removed_and_validated_without_disclosure() {
        use std::cell::Cell;

        let removed = Cell::new(false);
        let proof = "desktop-bootstrap-proof-that-is-at-least-32-bytes";
        let secret = consume_desktop_bootstrap_proof(
            || Some(std::ffi::OsString::from(proof)),
            || {
                removed.set(true);
                true
            },
        )
        .unwrap()
        .unwrap();
        assert!(removed.get());
        assert_eq!(
            format!("{secret:?}"),
            "DesktopProviderBootstrapSecret([REDACTED])"
        );
        assert!(!format!("{secret:?}").contains(proof));

        let removed = Cell::new(false);
        let absent = consume_desktop_bootstrap_proof(
            || None,
            || {
                removed.set(true);
                true
            },
        )
        .unwrap();
        assert!(absent.is_none());
        assert!(removed.get());

        let removed = Cell::new(false);
        let invalid_proof = "sensitive-but-short";
        let error = consume_desktop_bootstrap_proof(
            || Some(std::ffi::OsString::from(invalid_proof)),
            || {
                removed.set(true);
                true
            },
        )
        .unwrap_err();
        assert!(removed.get());
        assert_eq!(
            error.to_string(),
            "The desktop bootstrap proof was missing or invalid."
        );
        assert!(!error.to_string().contains(invalid_proof));
    }

    #[test]
    fn server_mode_requires_every_persistence_path() {
        let arguments = Arguments::try_parse_from([
            "service",
            "--endpoint",
            "control.sock",
            "--cli-session-file",
            "cli-session.json",
            "--state-db",
            "state.sqlite3",
            "--config",
            "config.json",
        ])
        .unwrap();
        let error = resolve_server_arguments(arguments).unwrap_err();
        assert_eq!(error.0, "the log directory is required");
    }

    #[test]
    fn server_mode_preserves_existing_shape_and_resolves_paths() {
        let arguments = Arguments::try_parse_from(server_cli()).unwrap();
        let resolved = resolve_server_arguments(arguments).unwrap();
        assert_eq!(resolved.endpoint, "control.sock");
        assert!(resolved.cli_session_file.is_absolute());
        assert!(resolved.state_db.is_absolute());
        assert!(resolved.config.is_absolute());
        assert!(resolved.log_dir.is_absolute());
    }

    #[test]
    fn utility_modes_are_exclusive_and_do_not_need_server_flags() {
        let utility = Arguments::try_parse_from([
            "service",
            "recovery-inspect",
            "--state-db",
            "state.sqlite3",
        ])
        .unwrap();
        assert!(utility.utility.is_some());
        assert!(!has_server_flags(&utility));

        let mixed = Arguments::try_parse_from([
            "service",
            "--endpoint",
            "control.sock",
            "recovery-inspect",
            "--state-db",
            "state.sqlite3",
        ])
        .unwrap();
        assert!(has_server_flags(&mixed));
    }

    #[test]
    fn ready_and_recovery_records_are_exactly_one_json_line() {
        let mut ready = Vec::new();
        emit_json_line(&mut ready, &ServiceReadyRecord::current()).unwrap();
        assert_eq!(ready.last(), Some(&b'\n'));
        assert!(!ready[..ready.len() - 1].contains(&b'\n'));
        assert_eq!(
            serde_json::from_slice::<ServiceReadyRecord>(&ready).unwrap(),
            ServiceReadyRecord::current()
        );

        let record = startup_record(
            ServiceRecoveryCategory::CorruptDatabase,
            "The database could not be read.",
        );
        let mut recovery = Vec::new();
        emit_recovery_record(&mut recovery, &record).unwrap();
        assert_eq!(recovery.last(), Some(&b'\n'));
        assert!(!recovery[..recovery.len() - 1].contains(&b'\n'));
        assert_eq!(
            serde_json::from_slice::<ServiceRecoveryRequiredRecord>(&recovery).unwrap(),
            record
        );
        let recovery_json: Value = serde_json::from_slice(&recovery).unwrap();
        assert_eq!(recovery_json["migrationBackupAvailable"], false);
        assert!(recovery_json.get("migrationBackupPath").is_none());
    }

    #[test]
    fn storage_error_mapping_never_includes_sensitive_detail() {
        let secret = "token-secret-caller-path";
        let error = StorageError::CorruptSchema {
            path: PathBuf::from(format!("/private/{secret}/state.sqlite3")),
            message: format!("snapshot contains {secret}"),
        };
        let encoded = serde_json::to_string(&storage_failure_record(&error)).unwrap();
        assert!(!encoded.contains(secret));
        assert!(encoded.contains("corruptSchema"));
    }

    #[test]
    fn failed_migration_reports_only_verified_retained_backup_availability() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        Connection::open(&database)
            .unwrap()
            .execute_batch(
                "CREATE TABLE application_snapshot (\
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\
                   revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 20),\
                   json_payload TEXT NOT NULL,\
                   saved_at_ms INTEGER NOT NULL\
                 );\
                 CREATE TABLE window_state (sentinel TEXT NOT NULL);\
                 PRAGMA user_version = 1;",
            )
            .unwrap();

        let Err(error) = SqliteStateStore::open_with_report(&database, service_platform()) else {
            panic!("injected migration conflict should fail");
        };
        let record = storage_failure_record(&error);

        assert_eq!(record.category, ServiceRecoveryCategory::MigrationFailed);
        assert!(record.migration_backup_available);
        let backup_path = record.migration_backup_path.as_deref().expect(
            "verified retained backup path must remain available to the trusted main process",
        );
        assert!(Path::new(backup_path).exists());
    }

    #[tokio::test]
    async fn corrupt_storage_returns_recovery_before_reading_control_token() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        fs::write(&database, b"not a sqlite database").unwrap();
        let failure = run_server(
            ServerArguments {
                endpoint: "unused-control-endpoint".to_owned(),
                cli_session_file: directory.path().join("cli-session.json"),
                state_db: database,
                config: directory.path().join("config.json"),
                log_dir: directory.path().join("logs"),
                default_cwd: directory.path().to_path_buf(),
            },
            LoggingRuntime::new(|_| {}),
            None,
        )
        .await;

        let Err(ServerFailure::Startup(record)) = failure else {
            panic!("corrupt storage must fail with a startup recovery record");
        };
        assert!(matches!(
            record.category,
            ServiceRecoveryCategory::CorruptDatabase | ServiceRecoveryCategory::CorruptSchema
        ));
        assert!(!record.migration_backup_available);
        assert!(record.migration_backup_path.is_none());
    }

    #[test]
    fn token_reader_is_bounded_and_trims_only_line_endings() {
        let token = "a".repeat(32);
        assert_eq!(
            read_control_token_from(Cursor::new(format!("{token}\r\n"))).unwrap(),
            token
        );
        assert!(read_control_token_from(Cursor::new("short\n")).is_err());
        assert!(read_control_token_from(Cursor::new(format!("{}\n", "x".repeat(513)))).is_err());
    }

    #[tokio::test]
    async fn parent_channel_eof_after_token_resolves_shutdown_signal() {
        let token = "a".repeat(32);
        let mut input = Cursor::new(format!("{token}\n"));

        assert_eq!(read_control_token_from(&mut input).unwrap(), token);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            watch_parent_liveness(input),
        )
        .await
        .expect("parent EOF must resolve the service shutdown branch")
        .expect("parent monitor must send the shutdown signal");
    }

    #[test]
    fn parent_channel_ignores_unexpected_data_in_bounded_chunks_until_eof() {
        let mut input = Cursor::new(vec![b'x'; 1_025]);

        assert!(!parent_channel_closed(&mut input));
        assert!(!parent_channel_closed(&mut input));
        assert!(!parent_channel_closed(&mut input));
        assert!(parent_channel_closed(&mut input));
    }

    #[test]
    fn logging_runtime_reloads_the_active_filter() {
        let (_layer, handle) = reload::Layer::new(level_filter(LogLevel::Info));
        let inspection = handle.clone();
        let runtime = logging_runtime(handle);

        runtime.set_level(LogLevel::Trace);

        assert_eq!(
            inspection
                .with_current(ToString::to_string)
                .expect("live filter must remain attached"),
            "trace"
        );
    }

    #[test]
    fn initialized_database_reports_a_safe_healthy_inspection() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let (_store, outcome) =
            SqliteStateStore::open_with_report(&database, service_platform()).unwrap();
        let current_schema = SqliteStateStore::supported_schema_version();
        assert!(matches!(
            outcome,
            MigrationOutcome::Initialized { from: 0, to } if to == current_schema
        ));
        let inspection = SqliteStateStore::inspect_recovery(database, service_platform());
        let safe = safe_recovery_inspection(&inspection);
        assert_eq!(safe.classification, RecoveryInspectionCategory::Healthy);
        assert_eq!(safe.schema_version, Some(current_schema));
    }

    #[test]
    fn recovery_export_is_create_new_and_emits_no_state_contents() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let destination = directory.path().join("recovery.sqlite3");
        let (_store, _) =
            SqliteStateStore::open_with_report(&database, service_platform()).unwrap();
        SqliteStateStore::export_recovery_copy(
            &database,
            &destination,
            RecoveryExportMode::CreateNew,
        )
        .unwrap();
        assert!(
            SqliteStateStore::export_recovery_copy(
                &database,
                &destination,
                RecoveryExportMode::CreateNew,
            )
            .is_err()
        );
    }

    #[test]
    fn corrupt_recovery_export_emits_one_safe_exact_json_line() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("corrupt.sqlite3");
        let destination = directory.path().join("recovery.sqlite3");
        let secret = "raw-secret-database-content-must-never-be-printed";
        let corrupt_bytes = format!("not SQLite: {secret}").into_bytes();
        fs::write(&database, &corrupt_bytes).unwrap();
        let source_before = fs::read(&database).unwrap();
        let mut output = Vec::new();

        run_recovery_export(database.clone(), destination.clone(), &mut output).unwrap();

        assert_eq!(output.last(), Some(&b'\n'));
        assert!(!output[..output.len() - 1].contains(&b'\n'));
        assert!(!String::from_utf8_lossy(&output).contains(secret));
        let result: RecoveryExportResult = serde_json::from_slice(&output).unwrap();
        assert_eq!(result.path, destination.to_string_lossy());
        assert_eq!(result.bytes, u64::try_from(corrupt_bytes.len()).unwrap());
        assert_eq!(fs::read(&destination).unwrap(), corrupt_bytes);
        assert_eq!(fs::read(&database).unwrap(), source_before);
    }

    #[test]
    fn corrupt_recovery_export_failure_is_content_free_and_preserves_destination() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("corrupt.sqlite3");
        let destination = directory.path().join("existing.sqlite3");
        let secret = "raw-secret-that-must-not-appear-in-errors";
        fs::write(&database, format!("not SQLite: {secret}")).unwrap();
        let sentinel = b"existing destination sentinel";
        fs::write(&destination, sentinel).unwrap();
        let mut output = Vec::new();

        let error = run_recovery_export(database, destination.clone(), &mut output).unwrap_err();

        assert_eq!(
            error.0,
            "the recovery database could not be exported safely"
        );
        assert!(!error.to_string().contains(secret));
        assert!(output.is_empty());
        assert_eq!(fs::read(destination).unwrap(), sentinel);
    }

    #[test]
    fn diagnostic_preview_and_export_are_exact_redacted_and_one_time() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let config = directory.path().join("config.json");
        let logs = directory.path().join("logs");
        let destination = directory.path().join("diagnostics.json");
        let secret = "super-secret-token-value";
        let (_store, _) =
            SqliteStateStore::open_with_report(&database, service_platform()).unwrap();
        let writer = RotatingJsonWriter::new(LogConfig::new(&logs)).unwrap();
        writer
            .write_json(&json!({"token": secret, "message": "safe"}))
            .unwrap();
        let paths = DiagnosticPaths {
            state_db: database,
            config,
            log_dir: logs.clone(),
        };
        let builder = diagnostic_builder(&paths).unwrap();
        let builder_preview = builder.preview().unwrap();
        let wire_preview = diagnostic_wire_preview(&builder_preview).unwrap();
        write_approval(
            &logs,
            &DiagnosticApproval {
                builder_preview,
                wire_preview: wire_preview.clone(),
            },
        )
        .unwrap();
        let approval = take_approval(&logs).unwrap();
        assert_eq!(approval.wire_preview, wire_preview);
        let report = builder
            .export_json(&destination, &approval.builder_preview)
            .unwrap();
        assert_eq!(
            report.bytes as u64,
            fs::metadata(&destination).unwrap().len()
        );
        let exported = fs::read_to_string(&destination).unwrap();
        assert!(!exported.contains(secret));
        assert!(exported.contains("[REDACTED]"));
        assert!(take_approval(&logs).is_err());
        assert!(
            builder
                .export_json(&destination, &approval.builder_preview)
                .is_err()
        );
    }

    #[test]
    fn utility_diagnostic_approval_survives_clock_change_and_can_be_repreviewed() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let config = directory.path().join("config.json");
        let logs = directory.path().join("logs");
        let destination = directory.path().join("diagnostics.json");
        let (_store, _) =
            SqliteStateStore::open_with_report(&database, service_platform()).unwrap();

        run_utility(UtilityCommand::DiagnosticsPreview {
            state_db: database.clone(),
            config: config.clone(),
            log_dir: logs.clone(),
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        run_utility(UtilityCommand::DiagnosticsPreview {
            state_db: database.clone(),
            config: config.clone(),
            log_dir: logs.clone(),
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        run_utility(UtilityCommand::DiagnosticsExport {
            state_db: database,
            config,
            log_dir: logs.clone(),
            destination: destination.clone(),
        })
        .unwrap();

        assert!(destination.is_file());
        assert!(!logs.join(DIAGNOSTIC_APPROVAL_FILENAME).exists());
        assert!(take_approval(&logs).is_err());
    }

    #[test]
    fn safe_config_summary_excludes_shell_profile_partition_and_extensions() {
        let mut config = AppConfig::default();
        let secret = "sensitive-profile-value";
        config.terminal.shell_path = Some(format!("/private/{secret}/shell"));
        config.browser.profile_name = secret.to_owned();
        config.browser.partition = secret.to_owned();
        config.extra.insert("token".to_owned(), json!(secret));
        let summary = serde_json::to_string(&safe_config_summary(&config)).unwrap();
        assert!(!summary.contains(secret));
        assert!(summary.contains("hasCustomShell"));
    }

    #[test]
    fn absolute_paths_are_lexically_normalized() {
        let path = absolute_path(PathBuf::from("one/../two/./state.sqlite3")).unwrap();
        assert!(path.is_absolute());
        assert!(path.ends_with(Path::new("two/state.sqlite3")));
        assert!(
            !path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        );
    }
}

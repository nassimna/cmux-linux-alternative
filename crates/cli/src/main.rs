mod browser_automation;
mod client;
mod hooks;

use std::{io, path::PathBuf};

use agent_workspace_notification_runtime::resolve_session_file;
use agent_workspace_protocol::{
    AGENT_SESSIONS_CAPABILITY, ActionCancelParams, ActionCancelResult, ActionErrorCode,
    ActionIdempotency, ActionInvocationSnapshot, ActionInvocationState, ActionInvocationTarget,
    ActionInvokeParams, ActionListParams, ActionListResult, EmptyParams, GroupAssignParams,
    GroupCollapseParams, GroupCreateParams, GroupDeleteParams, GroupMoveParams, GroupRenameParams,
    IdentifyResult, LayoutApplyParams, LayoutDeleteParams, LayoutExportEnvelope,
    LayoutExportParams, LayoutExportResult, LayoutGetParams, LayoutGetResult, LayoutImportParams,
    LayoutListResult, LayoutMutationResult, LayoutSaveParams, MAX_ACTION_PAGE_SIZE,
    MAX_ACTION_PARAMETERS_BYTES, MutationResult, NotificationLevel, NotificationPublishParams,
    NotificationSource, NotificationTarget, PaneSplitContent, PaneSplitParams,
    REMOTE_SESSIONS_CAPABILITY, RemoteHostKeyTrustParams, RemoteListParams,
    RemoteSessionCloseParams, RemoteSessionConnectParams, RemoteSessionDetachParams,
    RemoteSessionIdParams, RemoteSessionListResult, RemoteSessionReconnectParams,
    RemoteSessionResult, RemoteTargetCreateParams, RemoteTargetDeleteParams, RemoteTargetIdParams,
    RemoteTargetListResult, RemoteTargetResult, RemoteTmuxDiscoverParams,
    RemoteTmuxDiscoveryResult, SplitAxis, SplitPlacement, TabOpenTerminalParams,
    TerminalLaunchRequest, TerminalSendParams, WorkspaceBatchCloseParams,
    WorkspaceCanonicalMoveParams, WorkspaceCreateParams, WorkspaceListResult,
    WorkspaceOrganizationGetResult, WorkspacePinParams, WorkspaceSelectionReplaceParams,
};
use agent_workspace_protocol::{
    AdvancedTabMutationResult, BoundedListParams, ContentDiffParams, ContentDiffResult,
    ContentDocumentIssueParams, ContentDocumentIssueResult, ContentMarkdownParams, ContentPreview,
    ContentReadParams, ContentSaveParams, ContentSaveResult, RecentlyClosedListResult,
    RecentlyClosedReopenParams, SIDEBAR_SURFACES_CAPABILITY, SafeMarkdownDocument,
    SearchCancelParams, SearchCancelResult, SearchControlResult,
    SearchExportConfirmationIssueParams, SearchExportConfirmationIssueResult, SearchExportParams,
    SearchExportResult, SearchQueryParams, SearchQueryResult, SearchRebuildParams,
    SearchSourceMutationParams, SearchSourcePolicyParams, SidebarGetParams, SidebarListResult,
    SidebarPlacement, SidebarSaveParams, TaskActionParams, TaskActionResult, TaskListParams,
    TaskListResult, TextBoxCreateParams, TextBoxDeleteParams, TextBoxDocument, TextBoxIdParams,
    TextBoxListResult, TextBoxSaveParams, WorkspaceDirectoryListParams,
    WorkspaceDirectoryListResult, WorkspaceRootListResult,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use browser_automation::BrowserCommand;
use clap::{Parser, Subcommand, ValueEnum};
use client::{ClientError, ControlClient};
use hooks::{HookNotice, Integration};
use serde_json::{json, to_value};

const WORKSPACE_GROUPS_CAPABILITY: &str = "workspace-groups-v1";
const SAVED_LAYOUTS_CAPABILITY: &str = "saved-layouts-v1";
const ACTIONS_CAPABILITY: &str = "actions-v1";
const ACTION_OUTPUT_SCHEMA_VERSION: u8 = 1;
const JSON_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const EXIT_USAGE_OR_VALIDATION: i32 = 2;
const EXIT_PROVIDER_UNAVAILABLE: i32 = 3;
const EXIT_AUTHORIZATION_OR_POLICY: i32 = 4;
const EXIT_CONFLICT: i32 = 5;
const EXIT_CANCELLATION_OR_TIMEOUT: i32 = 6;
const EXIT_TRANSPORT_OR_SERVICE: i32 = 7;

#[derive(Debug, thiserror::Error)]
enum CliError {
    #[error("capability_unavailable: required capability `{capability}` is unavailable")]
    CapabilityUnavailable { capability: &'static str },
    #[error("operation completed with a non-success terminal outcome")]
    Terminal {
        output: serde_json::Value,
        exit_class: i32,
    },
    #[error("invalid agent-session JSON: expected one bounded object")]
    InvalidAgentParams,
    #[error("invalid remote-session JSON: expected one bounded object")]
    InvalidRemoteParams,
    #[error("invalid sidebar/content JSON: expected one bounded typed object")]
    InvalidSidebarParams,
}

#[derive(Debug, Parser)]
#[command(version, about = "Public local CLI for Agent Workspace")]
struct Arguments {
    /// Explicit discovery record path. Authentication credentials are never accepted as flags.
    #[arg(long, global = true)]
    session_file: Option<PathBuf>,
    /// Bind each remote request to this desktop window placement.
    #[arg(long, global = true)]
    window: Option<uuid::Uuid>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print local service identity as JSON.
    Identify,
    /// List or create workspaces.
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Create, rename, reorder, assign, or collapse workspace groups.
    Group {
        #[command(subcommand)]
        command: GroupCommand,
    },
    /// Manage portable saved layouts.
    Layout {
        #[command(subcommand)]
        command: LayoutCommand,
    },
    /// Create terminals or send them input.
    Terminal {
        #[command(subcommand)]
        command: TerminalCommand,
    },
    /// Perform pane operations.
    Pane {
        #[command(subcommand)]
        command: PaneCommand,
    },
    /// Publish a notification to a workspace.
    Notify(NotifyArguments),
    /// Discover, invoke, or cancel a stable public action.
    Action {
        #[command(subcommand)]
        command: ActionCommand,
    },
    /// Run capability-gated browser automation commands.
    Browser {
        #[command(subcommand)]
        command: BrowserCommand,
    },
    /// Manage the durable agent-session catalog using strict JSON request DTOs.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// Manage capability-gated remote targets and tmux-backed sessions.
    Remote {
        #[command(subcommand)]
        command: RemoteCommand,
    },
    /// Access the dormant, capability-gated sidebar/content command family.
    Sidebar {
        #[command(subcommand)]
        command: SidebarCommand,
    },
    /// Agent hook adapter and reversible installer commands.
    Hook {
        #[command(subcommand)]
        command: HookCommand,
    },
}

#[derive(Debug, Subcommand)]
enum WorkspaceCommand {
    /// Print the complete workspace list snapshot as JSON.
    List,
    /// Create a workspace with an initial terminal.
    Create(WorkspaceCreateArguments),
    /// Print the authoritative organization projection.
    Organization,
    /// Replace the ordered multiselection and focus anchor.
    SelectMany(WorkspaceSelectManyArguments),
    /// Set pin state for one workspace.
    Pin(WorkspacePinArguments),
    /// Move a workspace in canonical order.
    Reorder(WorkspaceReorderArguments),
    /// Close the selected workspaces, optionally creating a safe replacement.
    CloseSelected(WorkspaceCloseSelectedArguments),
}

#[derive(Debug, Subcommand)]
enum AgentCommand {
    /// List the bounded catalog.
    CatalogList,
    /// Get one session by UUID.
    CatalogGet {
        #[arg(long)]
        agent_session_id: uuid::Uuid,
    },
    /// Register a live terminal binding.
    CatalogRegister(AgentParamsArguments),
    /// Reassess restore support from authoritative runtime evidence.
    RestoreAssess(AgentParamsArguments),
    /// Restore or live-reattach a session.
    Restore(AgentParamsArguments),
    /// Fork a session into an independent destination identity.
    Fork(AgentParamsArguments),
    /// Run non-destructive hibernation preflight.
    HibernatePreflight(AgentParamsArguments),
    /// Explicitly confirm a hibernation choice; never implied by preflight.
    HibernateConfirm(AgentParamsArguments),
    /// Cancel a hibernation attempt.
    HibernateCancel(AgentParamsArguments),
    TeamCreate(AgentParamsArguments),
    TeamUpdate(AgentParamsArguments),
    TeamDelete(AgentParamsArguments),
    MemberCreate(AgentParamsArguments),
    MemberUpdate(AgentParamsArguments),
    MemberMove(AgentParamsArguments),
    MemberDelete(AgentParamsArguments),
    /// Set an exact durable team/subagent attention route with attention-revision CAS.
    AttentionSet(AgentParamsArguments),
}

#[derive(Debug, Subcommand)]
enum RemoteCommand {
    TargetList(RemoteParamsArguments),
    TargetGet(RemoteParamsArguments),
    TargetCreate(RemoteParamsArguments),
    TargetDelete(RemoteParamsArguments),
    SessionList(RemoteParamsArguments),
    SessionGet(RemoteParamsArguments),
    SessionConnect(RemoteParamsArguments),
    HostKeyDecide(RemoteParamsArguments),
    SessionDetach(RemoteParamsArguments),
    SessionReconnect(RemoteParamsArguments),
    SessionClose(RemoteParamsArguments),
    TmuxDiscover(RemoteParamsArguments),
}

#[derive(Debug, clap::Args)]
struct RemoteParamsArguments {
    /// One closed canonical remote request object; credentials and SSH options are forbidden.
    #[arg(long)]
    params_json: String,
}

#[derive(Debug, Subcommand)]
enum SidebarCommand {
    PlacementList(SidebarParamsArguments),
    PlacementGet(SidebarParamsArguments),
    PlacementSave(SidebarParamsArguments),
    TextBoxList(SidebarParamsArguments),
    TextBoxGet(SidebarParamsArguments),
    TextBoxCreate(SidebarParamsArguments),
    TextBoxSave(SidebarParamsArguments),
    TextBoxDelete(SidebarParamsArguments),
    RootList(SidebarParamsArguments),
    DirectoryList(SidebarParamsArguments),
    DocumentIssue(SidebarParamsArguments),
    ContentRead(SidebarParamsArguments),
    ContentSave(SidebarParamsArguments),
    ContentMarkdown(SidebarParamsArguments),
    ContentDiff(SidebarParamsArguments),
    SearchQuery(SidebarParamsArguments),
    SearchCancel(SidebarParamsArguments),
    SearchSourcePolicy(SidebarParamsArguments),
    SearchSourceExclude(SidebarParamsArguments),
    SearchSourceForget(SidebarParamsArguments),
    SearchSourceRebuild(SidebarParamsArguments),
    SearchSourceExportConfirmationIssue(SidebarParamsArguments),
    SearchSourceExport(SidebarParamsArguments),
    TaskList(SidebarParamsArguments),
    TaskAction(SidebarParamsArguments),
    RecentlyClosedList(SidebarParamsArguments),
    RecentlyClosedReopen(SidebarParamsArguments),
}

#[derive(Debug, clap::Args)]
struct SidebarParamsArguments {
    /// One closed canonical request DTO. Paths, commands, keys, and process IDs are forbidden.
    #[arg(long)]
    params_json: String,
}

#[derive(Debug, clap::Args)]
struct AgentParamsArguments {
    /// One closed canonical request object, bounded by the control-message ceiling.
    #[arg(long)]
    params_json: String,
}

#[derive(Debug, clap::Args)]
struct IdempotentArguments {
    #[arg(long)]
    expected_revision: u64,
    #[arg(long)]
    idempotency_key: Option<uuid::Uuid>,
}
impl IdempotentArguments {
    fn key(&self) -> String {
        self.idempotency_key
            .unwrap_or_else(uuid::Uuid::new_v4)
            .to_string()
    }
}

#[derive(Debug, clap::Args)]
struct WorkspaceSelectManyArguments {
    #[arg(long, num_args = 1..)]
    workspace_id: Vec<uuid::Uuid>,
    #[arg(long)]
    focused_workspace_id: uuid::Uuid,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct WorkspacePinArguments {
    #[arg(long)]
    workspace_id: uuid::Uuid,
    #[arg(long)]
    pinned: bool,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct WorkspaceReorderArguments {
    #[arg(long)]
    workspace_id: uuid::Uuid,
    #[arg(long)]
    destination_index: u32,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}

#[derive(Debug, clap::Args)]
struct WorkspaceCloseSelectedArguments {
    #[arg(long, requires = "replacement_working_directory")]
    replacement_name: Option<String>,
    #[arg(long, requires = "replacement_name")]
    replacement_description: Option<String>,
    #[arg(long, requires = "replacement_name")]
    replacement_color: Option<String>,
    #[arg(
        long,
        value_parser = absolute_path,
        requires = "replacement_name"
    )]
    replacement_working_directory: Option<String>,
    /// Replacement terminal cwd; defaults to the replacement working directory.
    #[arg(long, value_parser = absolute_path, requires = "replacement_name")]
    replacement_terminal_cwd: Option<String>,
    #[arg(long, value_parser = terminal_dimension, requires = "replacement_name")]
    replacement_rows: Option<u16>,
    #[arg(long, value_parser = terminal_dimension, requires = "replacement_name")]
    replacement_cols: Option<u16>,
    /// Replacement terminal command and arguments. Place this option last for hyphenated values.
    #[arg(
        long,
        num_args = 1..,
        allow_hyphen_values = true,
        requires = "replacement_name"
    )]
    replacement_command: Option<Vec<String>>,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}

#[derive(Debug, Subcommand)]
enum GroupCommand {
    Create(GroupNameArguments),
    Rename(GroupNameArguments),
    Delete(GroupIdArguments),
    Move(GroupMoveArguments),
    Assign(GroupAssignArguments),
    Collapse(GroupCollapseArguments),
}
#[derive(Debug, clap::Args)]
struct GroupNameArguments {
    #[arg(long)]
    group_id: uuid::Uuid,
    #[arg(long)]
    name: String,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct GroupIdArguments {
    #[arg(long)]
    group_id: uuid::Uuid,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct GroupMoveArguments {
    #[arg(long)]
    group_id: uuid::Uuid,
    #[arg(long)]
    destination_index: u32,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct GroupAssignArguments {
    #[arg(long)]
    workspace_id: uuid::Uuid,
    #[arg(long)]
    group_id: Option<uuid::Uuid>,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct GroupCollapseArguments {
    #[arg(long)]
    group_id: uuid::Uuid,
    #[arg(long)]
    collapsed: bool,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}

#[derive(Debug, Subcommand)]
enum LayoutCommand {
    List,
    Get(LayoutIdArguments),
    Export(LayoutIdArguments),
    Save(LayoutSaveArguments),
    Delete(LayoutMutationArguments),
    Apply(LayoutMutationArguments),
    Import(LayoutImportArguments),
}
#[derive(Debug, clap::Args)]
struct LayoutIdArguments {
    #[arg(long)]
    layout_id: uuid::Uuid,
}
#[derive(Debug, clap::Args)]
struct LayoutMutationArguments {
    #[arg(long)]
    layout_id: uuid::Uuid,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct LayoutSaveArguments {
    #[arg(long)]
    layout_id: uuid::Uuid,
    #[arg(long)]
    name: String,
    #[arg(long, num_args = 1..)]
    workspace_id: Vec<uuid::Uuid>,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}
#[derive(Debug, clap::Args)]
struct LayoutImportArguments {
    #[arg(long)]
    layout_id: uuid::Uuid,
    #[arg(long)]
    file: PathBuf,
    #[command(flatten)]
    idempotent: IdempotentArguments,
}

#[derive(Debug, clap::Args)]
struct WorkspaceCreateArguments {
    #[arg(long)]
    name: String,
    #[arg(long)]
    description: Option<String>,
    #[arg(long)]
    color: Option<String>,
    #[arg(long, value_parser = absolute_path)]
    working_directory: String,
    /// Initial terminal cwd; defaults to the workspace working directory.
    #[arg(long, value_parser = absolute_path)]
    terminal_cwd: Option<String>,
    #[arg(long, default_value_t = 24, value_parser = terminal_dimension)]
    rows: u16,
    #[arg(long, default_value_t = 80, value_parser = terminal_dimension)]
    cols: u16,
    /// Initial command and arguments. Place this option last when values begin with '-'.
    #[arg(long, num_args = 1.., allow_hyphen_values = true)]
    command: Option<Vec<String>>,
}

#[derive(Debug, Subcommand)]
enum TerminalCommand {
    /// Create a standalone terminal session.
    Create(TerminalCreateArguments),
    /// Send raw UTF-8 input to a terminal (base64-encoded only on the wire).
    #[command(visible_alias = "input")]
    Send(TerminalSendArguments),
}

#[derive(Debug, clap::Args)]
struct TerminalCreateArguments {
    #[arg(long)]
    workspace_id: uuid::Uuid,
    #[arg(long)]
    pane_id: uuid::Uuid,
    #[arg(long)]
    destination_index: Option<u32>,
    #[arg(long, default_value_t = 24, value_parser = terminal_dimension)]
    rows: u16,
    #[arg(long, default_value_t = 80, value_parser = terminal_dimension)]
    cols: u16,
    #[arg(long, value_parser = absolute_path)]
    cwd: String,
    #[arg(long, num_args = 1.., allow_hyphen_values = true)]
    command: Option<Vec<String>>,
}

#[derive(Debug, clap::Args)]
struct TerminalSendArguments {
    #[arg(long)]
    terminal_id: uuid::Uuid,
    /// Raw input text. It is encoded to the protocol's required base64 representation.
    #[arg(long)]
    data: String,
}

#[derive(Debug, Subcommand)]
enum PaneCommand {
    /// Split a pane and populate the new pane with exactly one content source.
    Split(PaneSplitArguments),
}

#[derive(Debug, clap::Args)]
struct PaneSplitArguments {
    #[arg(long)]
    workspace_id: uuid::Uuid,
    #[arg(long)]
    target_pane_id: uuid::Uuid,
    #[arg(long, value_enum)]
    axis: Axis,
    #[arg(long, value_enum, default_value_t = Placement::After)]
    placement: Placement,
    #[arg(long, default_value_t = 0.5, value_parser = split_ratio)]
    ratio: f64,
    #[command(subcommand)]
    content: PaneContentCommand,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Axis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum Placement {
    Before,
    #[default]
    After,
}

#[derive(Debug, Subcommand)]
enum PaneContentCommand {
    /// Open a new terminal in the new pane.
    Terminal(PaneTerminalArguments),
    /// Open a new browser placeholder in the new pane.
    Browser(PaneBrowserArguments),
    /// Move an existing tab into the new pane.
    ExistingTab {
        #[arg(long)]
        tab_id: uuid::Uuid,
    },
}

#[derive(Debug, Subcommand)]
enum ActionCommand {
    /// Print one bounded page of public action definitions.
    List(ActionListArguments),
    /// Invoke one exact action version with bounded object parameters.
    Invoke(ActionInvokeArguments),
    /// Cancel an invocation using its original correlation identity.
    Cancel(ActionCancelArguments),
}

#[derive(Debug, clap::Args)]
struct ActionListArguments {
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long, default_value_t = MAX_ACTION_PAGE_SIZE as u16, value_parser = action_page_limit)]
    limit: u16,
}

#[derive(Debug, clap::Args)]
struct ActionInvokeArguments {
    #[arg(long)]
    action_id: String,
    #[arg(long, value_parser = positive_u32)]
    action_version: u32,
    /// JSON object matching the action's declared parameter schema.
    #[arg(long, default_value = "{}", value_parser = action_parameters)]
    parameters_json: serde_json::Value,
    /// Current epoch returned by `action list`.
    #[arg(long)]
    idempotency_epoch: uuid::Uuid,
    #[arg(long)]
    idempotency_key: Option<uuid::Uuid>,
    #[arg(long)]
    correlation_id: Option<uuid::Uuid>,
    #[arg(long, requires = "target_window_generation")]
    target_window_id: Option<uuid::Uuid>,
    #[arg(long, requires = "target_window_id", value_parser = positive_safe_u64)]
    target_window_generation: Option<u64>,
}

#[derive(Debug, clap::Args)]
struct ActionCancelArguments {
    #[arg(long)]
    invocation_id: uuid::Uuid,
    #[arg(long)]
    correlation_id: uuid::Uuid,
}

#[derive(Debug, clap::Args)]
struct PaneTerminalArguments {
    #[arg(long, value_parser = absolute_path)]
    cwd: String,
    #[arg(long, default_value_t = 24, value_parser = terminal_dimension)]
    rows: u16,
    #[arg(long, default_value_t = 80, value_parser = terminal_dimension)]
    cols: u16,
    #[arg(long, num_args = 1.., allow_hyphen_values = true)]
    command: Option<Vec<String>>,
}

#[derive(Debug, clap::Args)]
struct PaneBrowserArguments {
    #[arg(long)]
    url: String,
    #[arg(long)]
    profile_partition: Option<String>,
}

#[derive(Debug, clap::Args)]
struct NotifyArguments {
    #[arg(long)]
    title: String,
    #[arg(long)]
    body: Option<String>,
    #[arg(long, value_enum, default_value_t = Level::Info)]
    level: Level,
    #[arg(long)]
    workspace_id: Option<String>,
    #[arg(long)]
    pane_id: Option<String>,
    #[arg(long)]
    tab_id: Option<String>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Level {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Agent {
    Codex,
    Claude,
}

#[derive(Debug, Subcommand)]
enum HookCommand {
    /// Adapt Codex's JSON payload argv into a local notification.
    Codex { payload: String },
    /// Adapt Claude Code's bounded JSON stdin into a local notification.
    Claude,
    /// Explicitly install a user-level agent hook.
    Install { agent: Agent },
    /// Reversibly uninstall an installer-owned hook.
    Uninstall { agent: Agent },
    /// Report installed, conflict, or not-installed state.
    Status { agent: Agent },
}

fn main() {
    let arguments = Arguments::parse();
    let action_command = action_command_name(&arguments.command);
    if let Err(error) = run(arguments) {
        let exit_code = cli_exit_code(error.as_ref());
        if let Some(CliError::Terminal { output, .. }) = error.downcast_ref::<CliError>() {
            println!(
                "{}",
                serde_json::to_string(output).unwrap_or_else(|_| {
                    r#"{"schemaVersion":1,"command":"action.invoke","error":{"code":"transport_or_service","exitClass":7}}"#.to_owned()
                })
            );
        } else if let Some(command) = action_command {
            let envelope = action_error_output(command, error.as_ref(), exit_code);
            eprintln!(
                "{}",
                serde_json::to_string(&envelope).unwrap_or_else(|_| {
                    r#"{"schemaVersion":1,"command":"action.unknown","error":{"code":"transport_or_service","exitClass":7}}"#.to_owned()
                })
            );
        } else {
            eprintln!("agent-workspace-cli: {error}");
        }
        std::process::exit(exit_code);
    }
}

fn cli_exit_code(error: &(dyn std::error::Error + 'static)) -> i32 {
    if let Some(error) = error.downcast_ref::<CliError>() {
        return match error {
            CliError::CapabilityUnavailable { .. } => EXIT_PROVIDER_UNAVAILABLE,
            CliError::Terminal { exit_class, .. } => *exit_class,
            CliError::InvalidAgentParams
            | CliError::InvalidRemoteParams
            | CliError::InvalidSidebarParams => EXIT_USAGE_OR_VALIDATION,
        };
    }
    let Some(error) = error.downcast_ref::<ClientError>() else {
        return EXIT_TRANSPORT_OR_SERVICE;
    };
    let ClientError::Rejected { code, .. } = error else {
        return EXIT_TRANSPORT_OR_SERVICE;
    };
    match code.as_str() {
        "invalid_params"
        | "invalid_parameters"
        | "invalid_result"
        | "action_not_found"
        | "action_version_mismatch"
        | "target_required"
        | "target_not_found"
        | "target_stale"
        | "session_not_found"
        | "session_generation_mismatch"
        | "session_unavailable"
        | "team_unavailable"
        | "stale_navigation"
        | "invalid_operation"
        | "invalid_selector"
        | "tmux_unsupported"
        | "unsafe_url" => EXIT_USAGE_OR_VALIDATION,
        "capability_unavailable"
        | "provider_unavailable"
        | "credential_required"
        | "provider_ineligible"
        | "provider_backpressure"
        | "automation_backpressure"
        | "provider_lease_expired"
        | "provider_epoch_mismatch"
        | "runtime_unavailable" => EXIT_PROVIDER_UNAVAILABLE,
        "unauthorized"
        | "policy_denied"
        | "confirmation_required"
        | "host_key_trust_required"
        | "host_key_mismatch"
        | "credential_revoked" => EXIT_AUTHORIZATION_OR_POLICY,
        "idempotency_conflict"
        | "idempotency_expired"
        | "correlation_mismatch"
        | "invalid_state"
        | "resource_limit"
        | "stale_revision"
        | "operation_pending" => EXIT_CONFLICT,
        "cancellation_not_guaranteed" | "canceled" | "expired" | "timeout" | "session_expired" => {
            EXIT_CANCELLATION_OR_TIMEOUT
        }
        _ => EXIT_TRANSPORT_OR_SERVICE,
    }
}

fn run(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    let window = arguments.window;
    match arguments.command {
        Command::Hook {
            command: HookCommand::Install { agent },
        } => {
            hooks::install(integration(agent), &std::env::current_exe()?)?;
            println!("installed");
            Ok(())
        }
        Command::Hook {
            command: HookCommand::Uninstall { agent },
        } => {
            hooks::uninstall(integration(agent))?;
            println!("uninstalled");
            Ok(())
        }
        Command::Hook {
            command: HookCommand::Status { agent },
        } => {
            println!("{}", hooks::status(integration(agent))?);
            Ok(())
        }
        command => {
            let session_path = resolve_session_file(arguments.session_file.as_deref());
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(run_remote(command, session_path, window))
        }
    }
}

fn action_command_name(command: &Command) -> Option<&'static str> {
    match command {
        Command::Action {
            command: ActionCommand::List(_),
        } => Some("action.list"),
        Command::Action {
            command: ActionCommand::Invoke(_),
        } => Some("action.invoke"),
        Command::Action {
            command: ActionCommand::Cancel(_),
        } => Some("action.cancel"),
        Command::Browser { command } => Some(browser_automation::command_name(command)),
        _ => None,
    }
}

fn action_error_output(
    command: &'static str,
    error: &(dyn std::error::Error + 'static),
    exit_class: i32,
) -> serde_json::Value {
    let (code, message) = if let Some(ClientError::Rejected { code, message }) =
        error.downcast_ref::<ClientError>()
    {
        (code.as_str(), message.as_str())
    } else if let Some(CliError::CapabilityUnavailable { capability }) =
        error.downcast_ref::<CliError>()
    {
        let message = if *capability == ACTIONS_CAPABILITY {
            "The actions-v1 capability is unavailable"
        } else {
            "The browser-automation-v1 capability is unavailable"
        };
        ("capability_unavailable", message)
    } else {
        (
            "transport_or_service",
            "The local control service could not complete the request",
        )
    };
    json!({
        "schemaVersion": ACTION_OUTPUT_SCHEMA_VERSION,
        "command": command,
        "error": {
            "code": code,
            "message": message,
            "exitClass": exit_class,
        }
    })
}

async fn run_remote(
    command: Command,
    session_path: PathBuf,
    window: Option<uuid::Uuid>,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = ControlClient::discover(&session_path)?.with_window(window);
    match command {
        Command::Hook {
            command: HookCommand::Codex { payload },
        } => {
            let notice = hooks::parse_codex_payload(&payload)?;
            print_json(&publish_notice(&client, notice).await?)?;
        }
        Command::Hook {
            command: HookCommand::Claude,
        } => {
            let notice = hooks::parse_claude_stdin(io::stdin().lock())?;
            print_json(&publish_notice(&client, notice).await?)?;
        }
        Command::Hook { .. } => unreachable!("local hook commands are handled before discovery"),
        command => print_json(&execute_public_command(&client, command).await?)?,
    }
    Ok(())
}

fn print_json(value: &serde_json::Value) -> Result<(), serde_json::Error> {
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}

#[allow(clippy::too_many_lines)]
async fn execute_public_command(
    client: &ControlClient,
    command: Command,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    if let Command::Browser { command } = &command {
        browser_automation::validate(command)?;
    }
    match &command {
        Command::Group { .. }
        | Command::Workspace {
            command:
                WorkspaceCommand::Organization
                | WorkspaceCommand::SelectMany(_)
                | WorkspaceCommand::Pin(_)
                | WorkspaceCommand::Reorder(_)
                | WorkspaceCommand::CloseSelected(_),
        } => require_capability(client, WORKSPACE_GROUPS_CAPABILITY).await?,
        Command::Layout { .. } => require_capability(client, SAVED_LAYOUTS_CAPABILITY).await?,
        Command::Action { .. } => require_capability(client, ACTIONS_CAPABILITY).await?,
        Command::Browser { .. } => {
            require_capability(
                client,
                agent_workspace_protocol::BROWSER_AUTOMATION_CAPABILITY,
            )
            .await?;
        }
        Command::Agent { .. } => require_capability(client, AGENT_SESSIONS_CAPABILITY).await?,
        Command::Remote { .. } => require_capability(client, REMOTE_SESSIONS_CAPABILITY).await?,
        Command::Sidebar { .. } => require_capability(client, SIDEBAR_SURFACES_CAPABILITY).await?,
        _ => {}
    }

    let value = match command {
        Command::Identify => to_value(
            client
                .request::<IdentifyResult>("system.identify", json!({}))
                .await?,
        )?,
        Command::Workspace {
            command: WorkspaceCommand::List,
        } => to_value(
            client
                .request::<WorkspaceListResult>("workspace.list", json!({}))
                .await?,
        )?,
        Command::Workspace {
            command: WorkspaceCommand::Create(arguments),
        } => {
            let terminal_cwd = arguments
                .terminal_cwd
                .unwrap_or_else(|| arguments.working_directory.clone());
            let params = WorkspaceCreateParams {
                name: arguments.name,
                description: arguments.description,
                color: arguments.color,
                working_directory: arguments.working_directory,
                initial_terminal: TerminalLaunchRequest {
                    cwd: terminal_cwd,
                    command: arguments.command,
                    rows: arguments.rows,
                    cols: arguments.cols,
                },
            };
            to_value(
                client
                    .request::<MutationResult>("workspace.create", to_value(params)?)
                    .await?,
            )?
        }
        Command::Workspace {
            command: WorkspaceCommand::Organization,
        } => to_value(
            client
                .request::<WorkspaceOrganizationGetResult>("workspace.organization.get", json!({}))
                .await?,
        )?,
        Command::Workspace {
            command: WorkspaceCommand::SelectMany(arguments),
        } => {
            let params = WorkspaceSelectionReplaceParams {
                selection: arguments
                    .workspace_id
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                focused_workspace_id: arguments.focused_workspace_id.to_string(),
                expected_revision: arguments.idempotent.expected_revision,
                idempotency_key: arguments.idempotent.key(),
            };
            to_value(
                client
                    .request::<MutationResult>("workspace.selectMany", to_value(params)?)
                    .await?,
            )?
        }
        Command::Workspace {
            command: WorkspaceCommand::Pin(arguments),
        } => {
            let params = WorkspacePinParams {
                workspace_id: arguments.workspace_id.to_string(),
                pinned: arguments.pinned,
                expected_revision: arguments.idempotent.expected_revision,
                idempotency_key: arguments.idempotent.key(),
            };
            to_value(
                client
                    .request::<MutationResult>("workspace.pin", to_value(params)?)
                    .await?,
            )?
        }
        Command::Workspace {
            command: WorkspaceCommand::Reorder(arguments),
        } => {
            let params = WorkspaceCanonicalMoveParams {
                workspace_id: arguments.workspace_id.to_string(),
                destination_index: arguments.destination_index,
                expected_revision: arguments.idempotent.expected_revision,
                idempotency_key: arguments.idempotent.key(),
            };
            to_value(
                client
                    .request::<MutationResult>("workspace.reorder", to_value(params)?)
                    .await?,
            )?
        }
        Command::Workspace {
            command: WorkspaceCommand::CloseSelected(arguments),
        } => {
            let replacement = match (
                arguments.replacement_name,
                arguments.replacement_working_directory,
            ) {
                (Some(name), Some(working_directory)) => {
                    let terminal_cwd = arguments
                        .replacement_terminal_cwd
                        .unwrap_or_else(|| working_directory.clone());
                    Some(WorkspaceCreateParams {
                        name,
                        description: arguments.replacement_description,
                        color: arguments.replacement_color,
                        working_directory,
                        initial_terminal: TerminalLaunchRequest {
                            cwd: terminal_cwd,
                            command: arguments.replacement_command,
                            rows: arguments.replacement_rows.unwrap_or(24),
                            cols: arguments.replacement_cols.unwrap_or(80),
                        },
                    })
                }
                (None, None) => None,
                _ => unreachable!("clap requires replacement name and working directory together"),
            };
            let params = WorkspaceBatchCloseParams {
                replacement,
                expected_revision: arguments.idempotent.expected_revision,
                idempotency_key: arguments.idempotent.key(),
            };
            to_value(
                client
                    .request::<MutationResult>("workspace.closeSelected", to_value(params)?)
                    .await?,
            )?
        }
        Command::Group { command } => {
            let (wire_command, params) = match command {
                GroupCommand::Create(value) => (
                    "group.create",
                    to_value(GroupCreateParams {
                        group_id: value.group_id.to_string(),
                        name: value.name,
                        expected_revision: value.idempotent.expected_revision,
                        idempotency_key: value.idempotent.key(),
                    })?,
                ),
                GroupCommand::Rename(value) => (
                    "group.rename",
                    to_value(GroupRenameParams {
                        group_id: value.group_id.to_string(),
                        name: value.name,
                        expected_revision: value.idempotent.expected_revision,
                        idempotency_key: value.idempotent.key(),
                    })?,
                ),
                GroupCommand::Delete(value) => (
                    "group.delete",
                    to_value(GroupDeleteParams {
                        group_id: value.group_id.to_string(),
                        expected_revision: value.idempotent.expected_revision,
                        idempotency_key: value.idempotent.key(),
                    })?,
                ),
                GroupCommand::Move(value) => (
                    "group.move",
                    to_value(GroupMoveParams {
                        group_id: value.group_id.to_string(),
                        destination_index: value.destination_index,
                        expected_revision: value.idempotent.expected_revision,
                        idempotency_key: value.idempotent.key(),
                    })?,
                ),
                GroupCommand::Assign(value) => (
                    "group.assign",
                    to_value(GroupAssignParams {
                        workspace_id: value.workspace_id.to_string(),
                        group_id: value.group_id.map(|id| id.to_string()),
                        expected_revision: value.idempotent.expected_revision,
                        idempotency_key: value.idempotent.key(),
                    })?,
                ),
                GroupCommand::Collapse(value) => (
                    "group.collapse",
                    to_value(GroupCollapseParams {
                        group_id: value.group_id.to_string(),
                        collapsed: value.collapsed,
                        expected_revision: value.idempotent.expected_revision,
                        idempotency_key: value.idempotent.key(),
                    })?,
                ),
            };
            to_value(
                client
                    .request::<MutationResult>(wire_command, params)
                    .await?,
            )?
        }
        Command::Layout {
            command: LayoutCommand::List,
        } => to_value(
            client
                .request::<LayoutListResult>("layout.list", json!({}))
                .await?,
        )?,
        Command::Layout {
            command: LayoutCommand::Get(value),
        } => to_value(
            client
                .request::<LayoutGetResult>(
                    "layout.get",
                    to_value(LayoutGetParams {
                        layout_id: value.layout_id.to_string(),
                    })?,
                )
                .await?,
        )?,
        Command::Layout {
            command: LayoutCommand::Export(value),
        } => to_value(
            client
                .request::<LayoutExportResult>(
                    "layout.export",
                    to_value(LayoutExportParams {
                        layout_id: value.layout_id.to_string(),
                    })?,
                )
                .await?,
        )?,
        Command::Layout {
            command: LayoutCommand::Save(value),
        } => {
            let params = LayoutSaveParams {
                layout_id: value.layout_id.to_string(),
                name: value.name,
                workspace_ids: value.workspace_id.iter().map(ToString::to_string).collect(),
                expected_revision: value.idempotent.expected_revision,
                idempotency_key: value.idempotent.key(),
            };
            to_value(
                client
                    .request::<LayoutMutationResult>("layout.save", to_value(params)?)
                    .await?,
            )?
        }
        Command::Layout {
            command: LayoutCommand::Delete(value),
        } => {
            let params = LayoutDeleteParams {
                layout_id: value.layout_id.to_string(),
                expected_revision: value.idempotent.expected_revision,
                idempotency_key: value.idempotent.key(),
            };
            to_value(
                client
                    .request::<LayoutMutationResult>("layout.delete", to_value(params)?)
                    .await?,
            )?
        }
        Command::Layout {
            command: LayoutCommand::Apply(value),
        } => {
            let params = LayoutApplyParams {
                layout_id: value.layout_id.to_string(),
                expected_revision: value.idempotent.expected_revision,
                idempotency_key: value.idempotent.key(),
            };
            to_value(
                client
                    .request::<LayoutMutationResult>("layout.apply", to_value(params)?)
                    .await?,
            )?
        }
        Command::Layout {
            command: LayoutCommand::Import(value),
        } => {
            let envelope: LayoutExportEnvelope =
                serde_json::from_str(&std::fs::read_to_string(&value.file)?)?;
            let params = LayoutImportParams {
                layout_id: value.layout_id.to_string(),
                envelope,
                expected_revision: value.idempotent.expected_revision,
                idempotency_key: value.idempotent.key(),
            };
            to_value(
                client
                    .request::<LayoutMutationResult>("layout.import", to_value(params)?)
                    .await?,
            )?
        }
        Command::Terminal {
            command: TerminalCommand::Create(arguments),
        } => {
            let params = TabOpenTerminalParams {
                workspace_id: arguments.workspace_id.to_string(),
                pane_id: arguments.pane_id.to_string(),
                destination_index: arguments.destination_index,
                launch: TerminalLaunchRequest {
                    rows: arguments.rows,
                    cols: arguments.cols,
                    cwd: arguments.cwd,
                    command: arguments.command,
                },
            };
            to_value(
                client
                    .request::<MutationResult>("tab.openTerminal", to_value(params)?)
                    .await?,
            )?
        }
        Command::Terminal {
            command: TerminalCommand::Send(arguments),
        } => {
            let params = TerminalSendParams {
                terminal_id: arguments.terminal_id.to_string(),
                data: BASE64.encode(arguments.data.as_bytes()),
            };
            to_value(
                client
                    .request::<EmptyParams>("terminal.send", to_value(params)?)
                    .await?,
            )?
        }
        Command::Pane {
            command: PaneCommand::Split(arguments),
        } => to_value(
            client
                .request::<MutationResult>("pane.split", to_value(pane_split_params(arguments))?)
                .await?,
        )?,
        Command::Notify(arguments) => {
            to_value(publish(client, arguments, NotificationSource::Cli).await?)?
        }
        Command::Action {
            command: ActionCommand::List(arguments),
        } => action_output(
            "action.list",
            &to_value(
                client
                    .request::<ActionListResult>(
                        "action.list",
                        to_value(ActionListParams {
                            cursor: arguments.cursor,
                            limit: arguments.limit,
                        })?,
                    )
                    .await?,
            )?,
        ),
        Command::Action {
            command: ActionCommand::Invoke(arguments),
        } => {
            let target = match (
                arguments.target_window_id,
                arguments.target_window_generation,
            ) {
                (Some(window_id), Some(window_generation)) => Some(ActionInvocationTarget {
                    window_id: window_id.to_string(),
                    window_generation,
                }),
                (None, None) => None,
                _ => unreachable!("clap requires both action target fields"),
            };
            let output = action_output(
                "action.invoke",
                &to_value(
                    client
                        .invoke_action_until_terminal(&ActionInvokeParams {
                            action_id: arguments.action_id,
                            action_version: arguments.action_version,
                            parameters: arguments.parameters_json,
                            target,
                            idempotency: ActionIdempotency {
                                epoch: arguments.idempotency_epoch.to_string(),
                                key: arguments
                                    .idempotency_key
                                    .unwrap_or_else(uuid::Uuid::new_v4)
                                    .to_string(),
                            },
                            correlation_id: arguments
                                .correlation_id
                                .unwrap_or_else(uuid::Uuid::new_v4)
                                .to_string(),
                        })
                        .await?,
                )?,
            );
            let invocation = &output["result"]["invocation"];
            let invocation: ActionInvocationSnapshot = serde_json::from_value(invocation.clone())?;
            if let Some(exit_class) = terminal_invocation_exit_class(&invocation) {
                return Err(Box::new(CliError::Terminal { output, exit_class }));
            }
            output
        }
        Command::Action {
            command: ActionCommand::Cancel(arguments),
        } => action_output(
            "action.cancel",
            &to_value(
                client
                    .request::<ActionCancelResult>(
                        "action.cancel",
                        to_value(ActionCancelParams {
                            invocation_id: arguments.invocation_id.to_string(),
                            correlation_id: arguments.correlation_id.to_string(),
                        })?,
                    )
                    .await?,
            )?,
        ),
        Command::Browser { command } => browser_automation::execute(client, command).await?,
        Command::Agent { command } => execute_agent_command(client, command).await?,
        Command::Remote { command } => execute_remote_session_command(client, command).await?,
        Command::Sidebar { command } => execute_sidebar_command(client, command).await?,
        Command::Hook { .. } => unreachable!("hook commands have separate input handling"),
    };
    Ok(value)
}

#[allow(clippy::too_many_lines)]
async fn execute_sidebar_command(
    client: &ControlClient,
    command: SidebarCommand,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    Ok(match command {
        SidebarCommand::PlacementList(value) => {
            sidebar_request::<EmptyParams, SidebarListResult>(
                client,
                "sidebar.placement.list",
                &value,
            )
            .await?
        }
        SidebarCommand::PlacementGet(value) => {
            sidebar_request::<SidebarGetParams, SidebarPlacement>(
                client,
                "sidebar.placement.get",
                &value,
            )
            .await?
        }
        SidebarCommand::PlacementSave(value) => {
            sidebar_request::<SidebarSaveParams, SidebarPlacement>(
                client,
                "sidebar.placement.save",
                &value,
            )
            .await?
        }
        SidebarCommand::TextBoxList(value) => {
            sidebar_request::<BoundedListParams, TextBoxListResult>(client, "textbox.list", &value)
                .await?
        }
        SidebarCommand::TextBoxGet(value) => {
            sidebar_request::<TextBoxIdParams, TextBoxDocument>(client, "textbox.get", &value)
                .await?
        }
        SidebarCommand::TextBoxCreate(value) => {
            sidebar_request::<TextBoxCreateParams, TextBoxDocument>(
                client,
                "textbox.create",
                &value,
            )
            .await?
        }
        SidebarCommand::TextBoxSave(value) => {
            sidebar_request::<TextBoxSaveParams, TextBoxDocument>(client, "textbox.save", &value)
                .await?
        }
        SidebarCommand::TextBoxDelete(value) => {
            sidebar_request::<TextBoxDeleteParams, TextBoxDocument>(
                client,
                "textbox.delete",
                &value,
            )
            .await?
        }
        SidebarCommand::RootList(value) => {
            sidebar_request::<BoundedListParams, WorkspaceRootListResult>(
                client,
                "content.root.list",
                &value,
            )
            .await?
        }
        SidebarCommand::DirectoryList(value) => {
            sidebar_request::<WorkspaceDirectoryListParams, WorkspaceDirectoryListResult>(
                client,
                "content.directory.list",
                &value,
            )
            .await?
        }
        SidebarCommand::DocumentIssue(value) => {
            sidebar_request::<ContentDocumentIssueParams, ContentDocumentIssueResult>(
                client,
                "content.document.issue",
                &value,
            )
            .await?
        }
        SidebarCommand::ContentRead(value) => {
            sidebar_request::<ContentReadParams, ContentPreview>(client, "content.read", &value)
                .await?
        }
        SidebarCommand::ContentSave(value) => {
            sidebar_request::<ContentSaveParams, ContentSaveResult>(client, "content.save", &value)
                .await?
        }
        SidebarCommand::ContentMarkdown(value) => {
            sidebar_request::<ContentMarkdownParams, SafeMarkdownDocument>(
                client,
                "content.markdown",
                &value,
            )
            .await?
        }
        SidebarCommand::ContentDiff(value) => {
            sidebar_request::<ContentDiffParams, ContentDiffResult>(client, "content.diff", &value)
                .await?
        }
        SidebarCommand::SearchQuery(value) => {
            sidebar_request::<SearchQueryParams, SearchQueryResult>(client, "search.query", &value)
                .await?
        }
        SidebarCommand::SearchCancel(value) => {
            sidebar_request::<SearchCancelParams, SearchCancelResult>(
                client,
                "search.cancel",
                &value,
            )
            .await?
        }
        SidebarCommand::SearchSourcePolicy(value) => {
            sidebar_request::<SearchSourcePolicyParams, SearchControlResult>(
                client,
                "search.source.policy",
                &value,
            )
            .await?
        }
        SidebarCommand::SearchSourceExclude(value) => {
            sidebar_request::<SearchSourceMutationParams, SearchControlResult>(
                client,
                "search.source.exclude",
                &value,
            )
            .await?
        }
        SidebarCommand::SearchSourceForget(value) => {
            sidebar_request::<SearchSourceMutationParams, SearchControlResult>(
                client,
                "search.source.forget",
                &value,
            )
            .await?
        }
        SidebarCommand::SearchSourceRebuild(value) => {
            sidebar_request::<SearchRebuildParams, SearchControlResult>(
                client,
                "search.source.rebuild",
                &value,
            )
            .await?
        }
        SidebarCommand::SearchSourceExport(value) => {
            sidebar_request::<SearchExportParams, SearchExportResult>(
                client,
                "search.source.export",
                &value,
            )
            .await?
        }
        SidebarCommand::SearchSourceExportConfirmationIssue(value) => {
            sidebar_request::<
                SearchExportConfirmationIssueParams,
                SearchExportConfirmationIssueResult,
            >(client, "search.source.export.confirmation.issue", &value)
            .await?
        }
        SidebarCommand::TaskList(value) => {
            sidebar_request::<TaskListParams, TaskListResult>(client, "task.list", &value).await?
        }
        SidebarCommand::TaskAction(value) => {
            sidebar_request::<TaskActionParams, TaskActionResult>(client, "task.action", &value)
                .await?
        }
        SidebarCommand::RecentlyClosedList(value) => {
            sidebar_request::<BoundedListParams, RecentlyClosedListResult>(
                client,
                "recentlyClosed.list",
                &value,
            )
            .await?
        }
        SidebarCommand::RecentlyClosedReopen(value) => {
            sidebar_request::<RecentlyClosedReopenParams, AdvancedTabMutationResult>(
                client,
                "recentlyClosed.reopen",
                &value,
            )
            .await?
        }
    })
}

async fn sidebar_request<P, R>(
    client: &ControlClient,
    wire: &str,
    arguments: &SidebarParamsArguments,
) -> Result<serde_json::Value, Box<dyn std::error::Error>>
where
    P: serde::de::DeserializeOwned + serde::Serialize,
    R: serde::de::DeserializeOwned + serde::Serialize,
{
    let params = strict_sidebar_params::<P>(arguments)?;
    Ok(to_value(client.request::<R>(wire, params).await?)?)
}

fn strict_sidebar_params<T>(
    arguments: &SidebarParamsArguments,
) -> Result<serde_json::Value, CliError>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    if arguments.params_json.len() > agent_workspace_protocol::MAX_CONTROL_MESSAGE_BYTES {
        return Err(CliError::InvalidSidebarParams);
    }
    let value: serde_json::Value =
        serde_json::from_str(&arguments.params_json).map_err(|_| CliError::InvalidSidebarParams)?;
    let typed: T = serde_json::from_value(value).map_err(|_| CliError::InvalidSidebarParams)?;
    serde_json::to_value(typed).map_err(|_| CliError::InvalidSidebarParams)
}

async fn execute_remote_session_command(
    client: &ControlClient,
    command: RemoteCommand,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    macro_rules! request {
        ($wire:literal, $arguments:expr, $params:ty, $result:ty) => {{
            let params = strict_remote_params::<$params>(&$arguments)?;
            to_value(client.request::<$result>($wire, params).await?)?
        }};
    }
    Ok(match command {
        RemoteCommand::TargetList(value) => request!(
            "remote.target.list",
            value,
            RemoteListParams,
            RemoteTargetListResult
        ),
        RemoteCommand::TargetGet(value) => request!(
            "remote.target.get",
            value,
            RemoteTargetIdParams,
            RemoteTargetResult
        ),
        RemoteCommand::TargetCreate(value) => request!(
            "remote.target.create",
            value,
            RemoteTargetCreateParams,
            RemoteTargetResult
        ),
        RemoteCommand::TargetDelete(value) => request!(
            "remote.target.delete",
            value,
            RemoteTargetDeleteParams,
            RemoteTargetResult
        ),
        RemoteCommand::SessionList(value) => request!(
            "remote.session.list",
            value,
            RemoteListParams,
            RemoteSessionListResult
        ),
        RemoteCommand::SessionGet(value) => request!(
            "remote.session.get",
            value,
            RemoteSessionIdParams,
            RemoteSessionResult
        ),
        RemoteCommand::SessionConnect(value) => request!(
            "remote.session.connect",
            value,
            RemoteSessionConnectParams,
            RemoteSessionResult
        ),
        RemoteCommand::HostKeyDecide(value) => request!(
            "remote.hostKey.decide",
            value,
            RemoteHostKeyTrustParams,
            RemoteTargetResult
        ),
        RemoteCommand::SessionDetach(value) => request!(
            "remote.session.detach",
            value,
            RemoteSessionDetachParams,
            RemoteSessionResult
        ),
        RemoteCommand::SessionReconnect(value) => request!(
            "remote.session.reconnect",
            value,
            RemoteSessionReconnectParams,
            RemoteSessionResult
        ),
        RemoteCommand::SessionClose(value) => request!(
            "remote.session.close",
            value,
            RemoteSessionCloseParams,
            RemoteSessionResult
        ),
        RemoteCommand::TmuxDiscover(value) => request!(
            "remote.tmux.discover",
            value,
            RemoteTmuxDiscoverParams,
            RemoteTmuxDiscoveryResult
        ),
    })
}

fn remote_params(arguments: &RemoteParamsArguments) -> Result<serde_json::Value, CliError> {
    if arguments.params_json.len() > agent_workspace_protocol::MAX_CONTROL_MESSAGE_BYTES {
        return Err(CliError::InvalidRemoteParams);
    }
    let value: serde_json::Value =
        serde_json::from_str(&arguments.params_json).map_err(|_| CliError::InvalidRemoteParams)?;
    value
        .is_object()
        .then_some(value)
        .ok_or(CliError::InvalidRemoteParams)
}

fn strict_remote_params<T>(arguments: &RemoteParamsArguments) -> Result<serde_json::Value, CliError>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let value = remote_params(arguments)?;
    let typed: T = serde_json::from_value(value).map_err(|_| CliError::InvalidRemoteParams)?;
    serde_json::to_value(typed).map_err(|_| CliError::InvalidRemoteParams)
}

async fn execute_agent_command(
    client: &ControlClient,
    command: AgentCommand,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let (wire_command, params) = match command {
        AgentCommand::CatalogList => ("agent.catalog.list", json!({ "catalogVersion": 1 })),
        AgentCommand::CatalogGet { agent_session_id } => (
            "agent.catalog.get",
            json!({ "agentSessionId": agent_session_id.to_string() }),
        ),
        AgentCommand::CatalogRegister(value) => ("agent.catalog.register", agent_params(&value)?),
        AgentCommand::RestoreAssess(value) => ("agent.restore.assess", agent_params(&value)?),
        AgentCommand::Restore(value) => ("agent.session.restore", agent_params(&value)?),
        AgentCommand::Fork(value) => ("agent.session.fork", agent_params(&value)?),
        AgentCommand::HibernatePreflight(value) => {
            ("agent.hibernate.preflight", agent_params(&value)?)
        }
        AgentCommand::HibernateConfirm(value) => ("agent.hibernate.confirm", agent_params(&value)?),
        AgentCommand::HibernateCancel(value) => ("agent.hibernate.cancel", agent_params(&value)?),
        AgentCommand::TeamCreate(value) => ("agent.team.create", agent_params(&value)?),
        AgentCommand::TeamUpdate(value) => ("agent.team.update", agent_params(&value)?),
        AgentCommand::TeamDelete(value) => ("agent.team.delete", agent_params(&value)?),
        AgentCommand::MemberCreate(value) => ("agent.team.member.create", agent_params(&value)?),
        AgentCommand::MemberUpdate(value) => ("agent.team.member.update", agent_params(&value)?),
        AgentCommand::MemberMove(value) => ("agent.team.member.move", agent_params(&value)?),
        AgentCommand::MemberDelete(value) => ("agent.team.member.delete", agent_params(&value)?),
        AgentCommand::AttentionSet(value) => ("agent.attention.set", agent_params(&value)?),
    };
    Ok(client
        .request::<serde_json::Value>(wire_command, params)
        .await?)
}

fn agent_params(arguments: &AgentParamsArguments) -> Result<serde_json::Value, CliError> {
    if arguments.params_json.len() > agent_workspace_protocol::MAX_CONTROL_MESSAGE_BYTES {
        return Err(CliError::InvalidAgentParams);
    }
    let value: serde_json::Value =
        serde_json::from_str(&arguments.params_json).map_err(|_| CliError::InvalidAgentParams)?;
    value
        .is_object()
        .then_some(value)
        .ok_or(CliError::InvalidAgentParams)
}

fn terminal_invocation_exit_class(invocation: &ActionInvocationSnapshot) -> Option<i32> {
    match invocation.state {
        ActionInvocationState::Acknowledged => None,
        ActionInvocationState::Canceled | ActionInvocationState::Expired => {
            Some(EXIT_CANCELLATION_OR_TIMEOUT)
        }
        ActionInvocationState::Failed => Some(match invocation.error_code {
            Some(
                ActionErrorCode::CapabilityUnavailable
                | ActionErrorCode::ProviderUnavailable
                | ActionErrorCode::ProviderIneligible
                | ActionErrorCode::ProviderBackpressure
                | ActionErrorCode::ProviderLeaseExpired
                | ActionErrorCode::ProviderEpochMismatch,
            ) => EXIT_PROVIDER_UNAVAILABLE,
            Some(
                ActionErrorCode::Unauthorized
                | ActionErrorCode::PolicyDenied
                | ActionErrorCode::ConfirmationRequired,
            ) => EXIT_AUTHORIZATION_OR_POLICY,
            Some(
                ActionErrorCode::IdempotencyConflict
                | ActionErrorCode::IdempotencyExpired
                | ActionErrorCode::ResourceLimit
                | ActionErrorCode::CorrelationMismatch
                | ActionErrorCode::InvalidState,
            ) => EXIT_CONFLICT,
            Some(
                ActionErrorCode::CancellationNotGuaranteed
                | ActionErrorCode::Canceled
                | ActionErrorCode::Expired,
            ) => EXIT_CANCELLATION_OR_TIMEOUT,
            Some(
                ActionErrorCode::ActionNotFound
                | ActionErrorCode::ActionVersionMismatch
                | ActionErrorCode::CursorInvalid
                | ActionErrorCode::CursorExpired
                | ActionErrorCode::InvalidParameters
                | ActionErrorCode::InvalidResult
                | ActionErrorCode::TargetRequired
                | ActionErrorCode::TargetNotFound
                | ActionErrorCode::TargetStale,
            ) => EXIT_USAGE_OR_VALIDATION,
            Some(ActionErrorCode::ExecutionFailed) | None => EXIT_TRANSPORT_OR_SERVICE,
        }),
        ActionInvocationState::Accepted
        | ActionInvocationState::Leased
        | ActionInvocationState::Dispatched
        | ActionInvocationState::StartClaimed
        | ActionInvocationState::StartGranted => Some(EXIT_TRANSPORT_OR_SERVICE),
    }
}

fn action_output(command: &'static str, result: &serde_json::Value) -> serde_json::Value {
    json!({
        "schemaVersion": ACTION_OUTPUT_SCHEMA_VERSION,
        "command": command,
        "result": result,
    })
}

async fn require_capability(
    client: &ControlClient,
    capability: &'static str,
) -> Result<(), Box<dyn std::error::Error>> {
    let identity: IdentifyResult = client.request("system.identify", json!({})).await?;
    if identity
        .capabilities
        .iter()
        .any(|available| available == capability)
    {
        Ok(())
    } else {
        Err(CliError::CapabilityUnavailable { capability }.into())
    }
}

fn pane_split_params(arguments: PaneSplitArguments) -> PaneSplitParams {
    let content = match arguments.content {
        PaneContentCommand::Terminal(terminal) => PaneSplitContent::NewTerminal {
            launch: TerminalLaunchRequest {
                cwd: terminal.cwd,
                command: terminal.command,
                rows: terminal.rows,
                cols: terminal.cols,
            },
        },
        PaneContentCommand::Browser(browser) => PaneSplitContent::NewBrowser {
            url: browser.url,
            profile_partition: browser.profile_partition,
        },
        PaneContentCommand::ExistingTab { tab_id } => PaneSplitContent::ExistingTab {
            tab_id: tab_id.to_string(),
        },
    };
    PaneSplitParams {
        workspace_id: arguments.workspace_id.to_string(),
        target_pane_id: arguments.target_pane_id.to_string(),
        axis: match arguments.axis {
            Axis::Horizontal => SplitAxis::Horizontal,
            Axis::Vertical => SplitAxis::Vertical,
        },
        ratio: arguments.ratio,
        placement: match arguments.placement {
            Placement::Before => SplitPlacement::Before,
            Placement::After => SplitPlacement::After,
        },
        content,
    }
}

async fn publish_notice(
    client: &ControlClient,
    notice: HookNotice,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    publish(
        client,
        NotifyArguments {
            title: notice.title,
            body: notice.body,
            level: Level::Info,
            workspace_id: None,
            pane_id: None,
            tab_id: None,
        },
        NotificationSource::AgentHook,
    )
    .await
    .and_then(|result| to_value(result).map_err(Into::into))
}

async fn publish(
    client: &ControlClient,
    arguments: NotifyArguments,
    source: NotificationSource,
) -> Result<MutationResult, Box<dyn std::error::Error>> {
    let workspace_id = match target_value(arguments.workspace_id, "AGENT_WORKSPACE_WORKSPACE_ID") {
        Some(workspace_id) => workspace_id,
        None => {
            client
                .request::<WorkspaceListResult>("workspace.list", json!({}))
                .await?
                .snapshot
                .selected_workspace_id
        }
    };
    let params = NotificationPublishParams {
        target: NotificationTarget {
            workspace_id,
            pane_id: target_value(arguments.pane_id, "AGENT_WORKSPACE_PANE_ID"),
            tab_id: target_value(arguments.tab_id, "AGENT_WORKSPACE_TAB_ID"),
        },
        source,
        level: match arguments.level {
            Level::Info => NotificationLevel::Info,
            Level::Warning => NotificationLevel::Warning,
            Level::Error => NotificationLevel::Error,
        },
        title: arguments.title,
        body: arguments.body,
    };
    let result: MutationResult = client
        .request("notification.publish", to_value(params)?)
        .await?;
    Ok(result)
}

fn absolute_path(value: &str) -> Result<String, String> {
    if value.is_empty() || !std::path::Path::new(value).is_absolute() {
        return Err("must be a non-empty absolute path".to_owned());
    }
    Ok(value.to_owned())
}

fn terminal_dimension(value: &str) -> Result<u16, String> {
    let parsed = value
        .parse::<u16>()
        .map_err(|_| "must be an integer from 1 to 65535".to_owned())?;
    if parsed == 0 {
        return Err("must be an integer from 1 to 65535".to_owned());
    }
    Ok(parsed)
}

fn split_ratio(value: &str) -> Result<f64, String> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| "must be a number greater than 0 and less than 1".to_owned())?;
    if !parsed.is_finite() || parsed <= 0.0 || parsed >= 1.0 {
        return Err("must be a number greater than 0 and less than 1".to_owned());
    }
    Ok(parsed)
}

fn action_page_limit(value: &str) -> Result<u16, String> {
    let parsed = value
        .parse::<u16>()
        .map_err(|_| format!("must be an integer from 1 to {MAX_ACTION_PAGE_SIZE}"))?;
    if parsed == 0 || usize::from(parsed) > MAX_ACTION_PAGE_SIZE {
        return Err(format!(
            "must be an integer from 1 to {MAX_ACTION_PAGE_SIZE}"
        ));
    }
    Ok(parsed)
}

fn action_parameters(value: &str) -> Result<serde_json::Value, String> {
    if value.len() > MAX_ACTION_PARAMETERS_BYTES {
        return Err(format!(
            "must be at most {MAX_ACTION_PARAMETERS_BYTES} UTF-8 bytes"
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "must be a valid JSON object".to_owned())?;
    if !parsed.is_object() {
        return Err("must be a JSON object".to_owned());
    }
    Ok(parsed)
}

fn positive_u32(value: &str) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| "must be a positive integer".to_owned())?;
    if parsed == 0 {
        return Err("must be a positive integer".to_owned());
    }
    Ok(parsed)
}

fn positive_safe_u64(value: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| "must be a positive JSON-safe integer".to_owned())?;
    if parsed == 0 || parsed > JSON_SAFE_INTEGER_MAX {
        return Err("must be a positive JSON-safe integer".to_owned());
    }
    Ok(parsed)
}

fn target_value(explicit: Option<String>, environment: &str) -> Option<String> {
    target_value_from(explicit, std::env::var(environment).ok())
}

fn target_value_from(explicit: Option<String>, environment: Option<String>) -> Option<String> {
    explicit.or_else(|| environment.filter(|value| !value.is_empty()))
}

const fn integration(agent: Agent) -> Integration {
    match agent {
        Agent::Codex => Integration::Codex,
        Agent::Claude => Integration::Claude,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use agent_workspace_notification_runtime::{CliSessionGuard, CliSessionRecord};
    #[cfg(unix)]
    use agent_workspace_protocol::{AuthEnvelope, RequestEnvelope, ResponseEnvelope};
    #[cfg(unix)]
    use interprocess::local_socket::traits::tokio::Listener as _;
    #[cfg(unix)]
    use interprocess::local_socket::{GenericFilePath, ListenerOptions, prelude::*};
    #[cfg(unix)]
    use tempfile::tempdir;
    #[cfg(unix)]
    use tokio::{io::AsyncBufReadExt as _, io::AsyncWriteExt as _, io::BufReader};

    #[test]
    fn explicit_target_wins_and_environment_is_fallback() {
        assert_eq!(
            target_value_from(Some("explicit".to_owned()), Some("environment".to_owned()))
                .as_deref(),
            Some("explicit")
        );
        assert_eq!(
            target_value_from(None, Some("environment".to_owned())).as_deref(),
            Some("environment")
        );
    }

    #[test]
    fn token_is_not_a_cli_option() {
        assert!(Arguments::try_parse_from(["cli", "--token", "secret", "identify"]).is_err());
    }

    #[test]
    fn remote_commands_accept_only_bounded_json_and_never_expose_ssh_flags() {
        let parsed = Arguments::try_parse_from([
            "cli",
            "remote",
            "session-connect",
            "--params-json",
            "{\"remoteSessionId\":\"x\"}",
        ])
        .unwrap();
        let Command::Remote {
            command: RemoteCommand::SessionConnect(arguments),
        } = parsed.command
        else {
            panic!("expected remote session-connect command");
        };
        assert!(remote_params(&arguments).unwrap().is_object());
        assert!(
            strict_remote_params::<RemoteListParams>(&RemoteParamsArguments {
                params_json: r#"{"limit":1,"sshOption":"ProxyCommand=evil"}"#.into(),
            })
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "remote",
                "session-connect",
                "--ssh-option",
                "ProxyCommand=evil",
            ])
            .is_err()
        );
        assert!(
            remote_params(&RemoteParamsArguments {
                params_json: "[]".into()
            })
            .is_err()
        );
        assert_eq!(
            cli_exit_code(&CliError::InvalidRemoteParams),
            EXIT_USAGE_OR_VALIDATION
        );
    }

    #[test]
    fn sidebar_commands_are_capability_gated_and_strictly_typed() {
        let parsed = Arguments::try_parse_from([
            "cli",
            "sidebar",
            "text-box-list",
            "--params-json",
            r#"{"limit":10}"#,
        ])
        .unwrap();
        let Command::Sidebar {
            command: SidebarCommand::TextBoxList(arguments),
        } = parsed.command
        else {
            panic!("expected sidebar TextBox list command");
        };
        assert!(strict_sidebar_params::<BoundedListParams>(&arguments).is_ok());
        assert!(
            strict_sidebar_params::<BoundedListParams>(&SidebarParamsArguments {
                params_json: r#"{"limit":10,"path":"/etc/passwd"}"#.into(),
            })
            .is_err()
        );
        assert!(
            Arguments::try_parse_from(["cli", "sidebar", "content-read", "--path", "/etc/passwd",])
                .is_err()
        );
    }

    #[test]
    fn agent_commands_accept_only_bounded_json_objects_and_have_stable_exits() {
        let parsed = Arguments::try_parse_from([
            "cli",
            "agent",
            "team-create",
            "--params-json",
            r#"{"teamId":"10000000-0000-4000-8000-000000000001"}"#,
        ])
        .unwrap();
        let Command::Agent {
            command: AgentCommand::TeamCreate(params),
        } = parsed.command
        else {
            panic!("expected agent team-create command");
        };
        assert!(agent_params(&params).unwrap().is_object());
        let attention = Arguments::try_parse_from([
            "cli",
            "agent",
            "attention-set",
            "--params-json",
            r#"{"expectedAttentionRevision":null}"#,
        ])
        .unwrap();
        assert!(matches!(
            attention.command,
            Command::Agent {
                command: AgentCommand::AttentionSet(_)
            }
        ));
        assert!(
            agent_params(&AgentParamsArguments {
                params_json: "[]".to_owned(),
            })
            .is_err()
        );
        assert_eq!(
            cli_exit_code(&ClientError::Rejected {
                code: "stale_revision".to_owned(),
                message: "test".to_owned(),
            }),
            EXIT_CONFLICT
        );
        assert_eq!(
            cli_exit_code(&ClientError::Rejected {
                code: "runtime_unavailable".to_owned(),
                message: "test".to_owned(),
            }),
            EXIT_PROVIDER_UNAVAILABLE
        );
    }

    #[test]
    fn public_action_failures_have_stable_machine_exit_classes() {
        let rejected = |code: &str| ClientError::Rejected {
            code: code.to_owned(),
            message: "test".to_owned(),
        };
        assert_eq!(
            cli_exit_code(&rejected("invalid_parameters")),
            EXIT_USAGE_OR_VALIDATION
        );
        assert_eq!(
            cli_exit_code(&rejected("provider_unavailable")),
            EXIT_PROVIDER_UNAVAILABLE
        );
        assert_eq!(
            cli_exit_code(&rejected("policy_denied")),
            EXIT_AUTHORIZATION_OR_POLICY
        );
        assert_eq!(
            cli_exit_code(&rejected("idempotency_conflict")),
            EXIT_CONFLICT
        );
        assert_eq!(
            cli_exit_code(&rejected("cancellation_not_guaranteed")),
            EXIT_CANCELLATION_OR_TIMEOUT
        );
        assert_eq!(
            cli_exit_code(&ClientError::InvalidResponse),
            EXIT_TRANSPORT_OR_SERVICE
        );
        assert_eq!(
            action_error_output(
                "action.invoke",
                &rejected("policy_denied"),
                EXIT_AUTHORIZATION_OR_POLICY
            ),
            json!({
                "schemaVersion": 1,
                "command": "action.invoke",
                "error": {
                    "code": "policy_denied",
                    "message": "test",
                    "exitClass": 4
                }
            })
        );
        let parsed = Arguments::try_parse_from([
            "cli",
            "action",
            "cancel",
            "--invocation-id",
            "00000000-0000-0000-0000-000000000001",
            "--correlation-id",
            "00000000-0000-0000-0000-000000000002",
        ])
        .unwrap();
        assert_eq!(action_command_name(&parsed.command), Some("action.cancel"));
    }

    #[test]
    fn terminal_action_results_have_nonzero_exit_classes_without_losing_json() {
        let invocation = |state: &str, terminal_code: &str, error_code: Option<&str>| {
            let mut value = json!({
                "invocationId": "00000000-0000-4000-8000-000000000001",
                "correlationId": "00000000-0000-4000-8000-000000000002",
                "state": state,
                "terminalCode": terminal_code,
                "updatedAtMs": 1
            });
            if let Some(error_code) = error_code {
                value["errorCode"] = json!(error_code);
            }
            serde_json::from_value::<ActionInvocationSnapshot>(value).unwrap()
        };

        assert_eq!(
            terminal_invocation_exit_class(&invocation(
                "failed",
                "failed",
                Some("provider_unavailable")
            )),
            Some(EXIT_PROVIDER_UNAVAILABLE)
        );
        assert_eq!(
            terminal_invocation_exit_class(&invocation("failed", "failed", Some("policy_denied"))),
            Some(EXIT_AUTHORIZATION_OR_POLICY)
        );
        assert_eq!(
            terminal_invocation_exit_class(&invocation("canceled", "canceled", None)),
            Some(EXIT_CANCELLATION_OR_TIMEOUT)
        );
        assert_eq!(
            terminal_invocation_exit_class(&invocation("expired", "expired", None)),
            Some(EXIT_CANCELLATION_OR_TIMEOUT)
        );
        assert_eq!(
            terminal_invocation_exit_class(&invocation(
                "failed",
                "interrupted",
                Some("execution_failed")
            )),
            Some(EXIT_TRANSPORT_OR_SERVICE)
        );

        let output = json!({
            "schemaVersion": 1,
            "command": "action.invoke",
            "result": { "invocation": serde_json::to_value(invocation(
                "failed", "failed", Some("policy_denied")
            )).unwrap() }
        });
        let error = CliError::Terminal {
            output: output.clone(),
            exit_class: EXIT_AUTHORIZATION_OR_POLICY,
        };
        assert_eq!(cli_exit_code(&error), EXIT_AUTHORIZATION_OR_POLICY);
        assert!(matches!(
            error,
            CliError::Terminal { output: retained, .. } if retained == output
        ));
    }

    #[test]
    fn window_is_a_uuid_only_global_placement_selector() {
        let window = uuid::Uuid::new_v4();
        let parsed =
            Arguments::try_parse_from(["cli", "identify", "--window", &window.to_string()])
                .unwrap();
        assert_eq!(parsed.window, Some(window));
        assert!(Arguments::try_parse_from(["cli", "--window", "not-a-uuid", "identify"]).is_err());
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn local_validation_rejects_unsafe_request_values() {
        assert!(
            Arguments::try_parse_from([
                "cli",
                "workspace",
                "create",
                "--name",
                "unsafe",
                "--working-directory",
                "relative/path",
            ])
            .is_err()
        );
        assert!(Arguments::try_parse_from(["cli", "action", "list", "--limit", "0"]).is_err());
        assert!(Arguments::try_parse_from(["cli", "action", "list", "--limit", "65"]).is_err());
        assert!(
            Arguments::try_parse_from([
                "cli",
                "action",
                "invoke",
                "--action-id",
                "workspace.focus",
                "--action-version",
                "0",
                "--idempotency-epoch",
                "00000000-0000-0000-0000-000000000001",
            ])
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "action",
                "invoke",
                "--action-id",
                "workspace.focus",
                "--action-version",
                "1",
                "--parameters-json",
                "[]",
                "--idempotency-epoch",
                "00000000-0000-0000-0000-000000000001",
            ])
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "action",
                "invoke",
                "--action-id",
                "workspace.focus",
                "--action-version",
                "1",
                "--idempotency-epoch",
                "00000000-0000-0000-0000-000000000001",
                "--target-window-id",
                "00000000-0000-0000-0000-000000000002",
            ])
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "workspace",
                "close-selected",
                "--expected-revision",
                "1",
                "--replacement-name",
                "replacement",
                "--replacement-working-directory",
                "relative/path",
            ])
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "workspace",
                "close-selected",
                "--expected-revision",
                "1",
                "--replacement-name",
                "replacement",
            ])
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "terminal",
                "send",
                "--terminal-id",
                "not-a-uuid",
                "--data",
                "hello",
            ])
            .is_err()
        );
        assert!(
            Arguments::try_parse_from([
                "cli",
                "pane",
                "split",
                "--workspace-id",
                "00000000-0000-0000-0000-000000000001",
                "--target-pane-id",
                "00000000-0000-0000-0000-000000000002",
                "--axis",
                "horizontal",
                "--ratio",
                "1",
                "existing-tab",
                "--tab-id",
                "00000000-0000-0000-0000-000000000003",
            ])
            .is_err()
        );
    }

    #[cfg(unix)]
    async fn exercise_public_command(
        arguments: &[&str],
        expected_command: &str,
        expected_params: serde_json::Value,
        response_result: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        exercise_public_command_script(
            arguments,
            vec![(expected_command, expected_params, response_result)],
        )
        .await
    }

    #[cfg(unix)]
    async fn exercise_public_command_script(
        arguments: &[&str],
        requests: Vec<(&str, serde_json::Value, Option<serde_json::Value>)>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let root = tempdir().unwrap();
        let endpoint = root.path().join("control.sock");
        let endpoint_string = endpoint.to_string_lossy().into_owned();
        let listener = ListenerOptions::new()
            .name(
                endpoint_string
                    .clone()
                    .to_fs_name::<GenericFilePath>()
                    .unwrap(),
            )
            .create_tokio()
            .unwrap();
        let token = "mock-control-token-with-at-least-32-bytes".to_owned();
        let session_path = root.path().join("runtime/cli-session.json");
        let _guard = CliSessionGuard::create(
            &session_path,
            &CliSessionRecord::current(endpoint_string, token.clone()),
        )
        .unwrap();
        let requests = requests
            .into_iter()
            .map(|(command, params, result)| (command.to_owned(), params, result))
            .collect::<Vec<_>>();

        let server = tokio::spawn(async move {
            for (expected_command, expected_params, response_result) in requests {
                let stream = listener.accept().await.unwrap();
                let mut reader = BufReader::new(&stream);
                let mut auth = String::new();
                let mut request = String::new();
                reader.read_line(&mut auth).await.unwrap();
                reader.read_line(&mut request).await.unwrap();
                let auth: AuthEnvelope = serde_json::from_str(auth.trim_end()).unwrap();
                assert_eq!(auth.auth.token, token);
                let request: RequestEnvelope = serde_json::from_str(request.trim_end()).unwrap();
                assert_eq!(request.command, expected_command);
                assert_eq!(request.params, expected_params);
                let response = match response_result {
                    Some(result) => ResponseEnvelope::success(request.id, result),
                    None => ResponseEnvelope::failure(request.id, "test_complete", "done"),
                };
                let mut writer = &stream;
                writer
                    .write_all(
                        format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                    .await
                    .is_err(),
                "the CLI issued an unexpected additional request"
            );
        });

        let parsed = Arguments::try_parse_from(arguments).unwrap();
        let client = ControlClient::discover(&session_path).unwrap();
        let result = execute_public_command(&client, parsed.command).await;
        server.await.unwrap();
        result
    }

    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn new_commands_send_exact_protocol_requests() {
        let list = exercise_public_command(
            &["cli", "workspace", "list"],
            "workspace.list",
            json!({}),
            None,
        )
        .await;
        assert!(list.is_err());

        let create_workspace = exercise_public_command(
            &[
                "cli",
                "workspace",
                "create",
                "--name",
                "CLI workspace",
                "--description",
                "created by test",
                "--color",
                "#112233",
                "--working-directory",
                "/tmp/workspace",
                "--terminal-cwd",
                "/tmp/terminal",
                "--rows",
                "30",
                "--cols",
                "100",
                "--command",
                "bash",
                "-l",
            ],
            "workspace.create",
            json!({
                "name": "CLI workspace",
                "description": "created by test",
                "color": "#112233",
                "workingDirectory": "/tmp/workspace",
                "initialTerminal": {
                    "cwd": "/tmp/terminal",
                    "command": ["bash", "-l"],
                    "rows": 30,
                    "cols": 100
                }
            }),
            None,
        )
        .await;
        assert!(create_workspace.is_err());

        let minimal_workspace = exercise_public_command(
            &[
                "cli",
                "workspace",
                "create",
                "--name",
                "Minimal CLI workspace",
                "--working-directory",
                "/tmp",
            ],
            "workspace.create",
            json!({
                "name": "Minimal CLI workspace",
                "workingDirectory": "/tmp",
                "initialTerminal": { "cwd": "/tmp", "rows": 24, "cols": 80 }
            }),
            None,
        )
        .await;
        assert!(minimal_workspace.is_err());

        let close_selected = exercise_public_command_script(
            &[
                "cli",
                "workspace",
                "close-selected",
                "--expected-revision",
                "7",
                "--idempotency-key",
                "00000000-0000-0000-0000-000000000009",
            ],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(json!({
                        "application": "test-service", "version": "0.0.0",
                        "protocolVersion": 1, "capabilities": [WORKSPACE_GROUPS_CAPABILITY]
                    })),
                ),
                (
                    "workspace.closeSelected",
                    json!({
                        "expectedRevision": 7,
                        "idempotencyKey": "00000000-0000-0000-0000-000000000009"
                    }),
                    None,
                ),
            ],
        )
        .await;
        assert!(close_selected.is_err());

        let close_selected_with_replacement = exercise_public_command_script(
            &[
                "cli",
                "workspace",
                "close-selected",
                "--expected-revision",
                "8",
                "--idempotency-key",
                "00000000-0000-0000-0000-000000000010",
                "--replacement-name",
                "Safe replacement",
                "--replacement-description",
                "created before closing all workspaces",
                "--replacement-color",
                "#445566",
                "--replacement-working-directory",
                "/tmp/replacement",
                "--replacement-terminal-cwd",
                "/tmp/replacement/terminal",
                "--replacement-rows",
                "32",
                "--replacement-cols",
                "96",
                "--replacement-command",
                "bash",
                "-l",
            ],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(json!({
                        "application": "test-service", "version": "0.0.0",
                        "protocolVersion": 1, "capabilities": [WORKSPACE_GROUPS_CAPABILITY]
                    })),
                ),
                (
                    "workspace.closeSelected",
                    json!({
                        "replacement": {
                            "name": "Safe replacement",
                            "description": "created before closing all workspaces",
                            "color": "#445566",
                            "workingDirectory": "/tmp/replacement",
                            "initialTerminal": {
                                "cwd": "/tmp/replacement/terminal",
                                "command": ["bash", "-l"],
                                "rows": 32,
                                "cols": 96
                            }
                        },
                        "expectedRevision": 8,
                        "idempotencyKey": "00000000-0000-0000-0000-000000000010"
                    }),
                    None,
                ),
            ],
        )
        .await;
        assert!(close_selected_with_replacement.is_err());

        let create_terminal = exercise_public_command(
            &[
                "cli",
                "terminal",
                "create",
                "--workspace-id",
                "00000000-0000-0000-0000-000000000001",
                "--pane-id",
                "00000000-0000-0000-0000-000000000002",
                "--destination-index",
                "2",
                "--cwd",
                "/tmp",
                "--rows",
                "40",
                "--cols",
                "120",
                "--command",
                "zsh",
                "-l",
            ],
            "tab.openTerminal",
            json!({
                "workspaceId": "00000000-0000-0000-0000-000000000001",
                "paneId": "00000000-0000-0000-0000-000000000002",
                "destinationIndex": 2,
                "launch": {
                    "rows": 40,
                    "cols": 120,
                    "cwd": "/tmp",
                    "command": ["zsh", "-l"]
                }
            }),
            None,
        )
        .await;
        assert!(create_terminal.is_err());

        let minimal_terminal = exercise_public_command(
            &[
                "cli",
                "terminal",
                "create",
                "--workspace-id",
                "00000000-0000-0000-0000-000000000001",
                "--pane-id",
                "00000000-0000-0000-0000-000000000002",
                "--cwd",
                "/tmp",
            ],
            "tab.openTerminal",
            json!({
                "workspaceId": "00000000-0000-0000-0000-000000000001",
                "paneId": "00000000-0000-0000-0000-000000000002",
                "launch": { "rows": 24, "cols": 80, "cwd": "/tmp" }
            }),
            None,
        )
        .await;
        assert!(minimal_terminal.is_err());

        let send = exercise_public_command(
            &[
                "cli",
                "terminal",
                "input",
                "--terminal-id",
                "00000000-0000-0000-0000-000000000004",
                "--data",
                "printf 'hello'\n",
            ],
            "terminal.send",
            json!({
                "terminalId": "00000000-0000-0000-0000-000000000004",
                "data": "cHJpbnRmICdoZWxsbycK"
            }),
            Some(json!({})),
        )
        .await
        .unwrap();
        assert_eq!(send, json!({}));

        let split = exercise_public_command(
            &[
                "cli",
                "pane",
                "split",
                "--workspace-id",
                "00000000-0000-0000-0000-000000000001",
                "--target-pane-id",
                "00000000-0000-0000-0000-000000000002",
                "--axis",
                "vertical",
                "--placement",
                "before",
                "--ratio",
                "0.4",
                "terminal",
                "--cwd",
                "/tmp",
                "--rows",
                "25",
                "--cols",
                "90",
            ],
            "pane.split",
            json!({
                "workspaceId": "00000000-0000-0000-0000-000000000001",
                "targetPaneId": "00000000-0000-0000-0000-000000000002",
                "axis": "vertical",
                "ratio": 0.4,
                "placement": "before",
                "content": {
                    "kind": "newTerminal",
                    "launch": { "cwd": "/tmp", "rows": 25, "cols": 90 }
                }
            }),
            None,
        )
        .await;
        assert!(split.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn group_and_layout_commands_are_independently_capability_gated() {
        let identify = |capabilities: &[&str]| {
            json!({
                "application": "test-service",
                "version": "0.0.0",
                "protocolVersion": 1,
                "capabilities": capabilities
            })
        };

        let group_present = exercise_public_command_script(
            &[
                "cli",
                "group",
                "delete",
                "--group-id",
                "00000000-0000-0000-0000-000000000001",
                "--expected-revision",
                "3",
                "--idempotency-key",
                "00000000-0000-0000-0000-000000000002",
            ],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(identify(&[WORKSPACE_GROUPS_CAPABILITY])),
                ),
                (
                    "group.delete",
                    json!({
                        "groupId": "00000000-0000-0000-0000-000000000001",
                        "expectedRevision": 3,
                        "idempotencyKey": "00000000-0000-0000-0000-000000000002"
                    }),
                    None,
                ),
            ],
        )
        .await;
        assert!(group_present.is_err());

        let layout_present = exercise_public_command_script(
            &["cli", "layout", "list"],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(identify(&[SAVED_LAYOUTS_CAPABILITY])),
                ),
                ("layout.list", json!({}), None),
            ],
        )
        .await;
        assert!(layout_present.is_err());

        let group_missing = exercise_public_command_script(
            &[
                "cli",
                "group",
                "delete",
                "--group-id",
                "00000000-0000-0000-0000-000000000001",
                "--expected-revision",
                "3",
            ],
            vec![(
                "system.identify",
                json!({}),
                Some(identify(&[SAVED_LAYOUTS_CAPABILITY])),
            )],
        )
        .await
        .unwrap_err();
        assert_eq!(
            group_missing.to_string(),
            "capability_unavailable: required capability `workspace-groups-v1` is unavailable"
        );

        let workspace_organization_missing = exercise_public_command_script(
            &[
                "cli",
                "workspace",
                "close-selected",
                "--expected-revision",
                "3",
            ],
            vec![(
                "system.identify",
                json!({}),
                Some(identify(&[SAVED_LAYOUTS_CAPABILITY])),
            )],
        )
        .await
        .unwrap_err();
        assert_eq!(
            workspace_organization_missing.to_string(),
            "capability_unavailable: required capability `workspace-groups-v1` is unavailable"
        );

        let layout_missing = exercise_public_command_script(
            &["cli", "layout", "list"],
            vec![(
                "system.identify",
                json!({}),
                Some(identify(&[WORKSPACE_GROUPS_CAPABILITY])),
            )],
        )
        .await
        .unwrap_err();
        assert_eq!(
            layout_missing.to_string(),
            "capability_unavailable: required capability `saved-layouts-v1` is unavailable"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn action_commands_are_capability_gated_and_emit_exact_versioned_contracts() {
        let identify = |capabilities: &[&str]| {
            json!({
                "application": "test-service",
                "version": "0.0.0",
                "protocolVersion": 1,
                "capabilities": capabilities
            })
        };
        let epoch = "00000000-0000-0000-0000-000000000001";
        let idempotency_key = "00000000-0000-0000-0000-000000000002";
        let correlation_id = "00000000-0000-0000-0000-000000000003";
        let window_id = "00000000-0000-0000-0000-000000000004";
        let invocation_id = "00000000-0000-0000-0000-000000000005";

        let listed = exercise_public_command_script(
            &["cli", "action", "list", "--limit", "16"],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(identify(&[ACTIONS_CAPABILITY])),
                ),
                (
                    "action.list",
                    json!({ "limit": 16 }),
                    Some(json!({
                        "registryRevision": 7,
                        "idempotencyEpoch": epoch,
                        "definitions": []
                    })),
                ),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            listed,
            json!({
                "schemaVersion": 1,
                "command": "action.list",
                "result": {
                    "registryRevision": 7,
                    "idempotencyEpoch": epoch,
                    "definitions": []
                }
            })
        );

        let invoked = exercise_public_command_script(
            &[
                "cli",
                "action",
                "invoke",
                "--action-id",
                "workspace.focus",
                "--action-version",
                "2",
                "--parameters-json",
                r#"{"workspaceId":"00000000-0000-0000-0000-000000000006"}"#,
                "--idempotency-epoch",
                epoch,
                "--idempotency-key",
                idempotency_key,
                "--correlation-id",
                correlation_id,
                "--target-window-id",
                window_id,
                "--target-window-generation",
                "9",
            ],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(identify(&[ACTIONS_CAPABILITY])),
                ),
                (
                    "action.invoke",
                    json!({
                        "actionId": "workspace.focus",
                        "actionVersion": 2,
                        "parameters": {
                            "workspaceId": "00000000-0000-0000-0000-000000000006"
                        },
                        "target": { "windowId": window_id, "windowGeneration": 9 },
                        "idempotency": { "epoch": epoch, "key": idempotency_key },
                        "correlationId": correlation_id
                    }),
                    Some(json!({
                        "invocation": {
                            "invocationId": invocation_id,
                            "correlationId": correlation_id,
                            "state": "acknowledged",
                            "terminalCode": "succeeded",
                            "result": {},
                            "updatedAtMs": 1
                        }
                    })),
                ),
            ],
        )
        .await
        .unwrap();
        assert_eq!(invoked["schemaVersion"], 1);
        assert_eq!(invoked["command"], "action.invoke");
        assert_eq!(
            invoked["result"]["invocation"]["invocationId"],
            invocation_id
        );

        let canceled = exercise_public_command_script(
            &[
                "cli",
                "action",
                "cancel",
                "--invocation-id",
                invocation_id,
                "--correlation-id",
                correlation_id,
            ],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(identify(&[ACTIONS_CAPABILITY])),
                ),
                (
                    "action.cancel",
                    json!({
                        "invocationId": invocation_id,
                        "correlationId": correlation_id
                    }),
                    Some(json!({
                        "invocation": {
                            "invocationId": invocation_id,
                            "correlationId": correlation_id,
                            "state": "canceled",
                            "terminalCode": "canceled",
                            "updatedAtMs": 2
                        }
                    })),
                ),
            ],
        )
        .await
        .unwrap();
        assert_eq!(canceled["schemaVersion"], 1);
        assert_eq!(canceled["command"], "action.cancel");

        let unavailable = exercise_public_command_script(
            &["cli", "action", "list"],
            vec![("system.identify", json!({}), Some(identify(&[])))],
        )
        .await
        .unwrap_err();
        assert_eq!(
            unavailable.to_string(),
            "capability_unavailable: required capability `actions-v1` is unavailable"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_automation_is_absent_on_older_services() {
        let error = exercise_public_command_script(
            &["cli", "browser", "automation", "session-list"],
            vec![(
                "system.identify",
                json!({}),
                Some(json!({
                    "application": "older-service",
                    "version": "0.0.0",
                    "protocolVersion": 1,
                    "capabilities": []
                })),
            )],
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "capability_unavailable: required capability `browser-automation-v1` is unavailable"
        );
        assert_eq!(cli_exit_code(error.as_ref()), EXIT_PROVIDER_UNAVAILABLE);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_automation_operation_uses_exact_typed_wire_and_terminal_exit() {
        let session_id = "00000000-0000-4000-8000-000000000001";
        let operation_id = "00000000-0000-4000-8000-000000000002";
        let epoch = "00000000-0000-4000-8000-000000000003";
        let key = "00000000-0000-4000-8000-000000000004";
        let correlation = "00000000-0000-4000-8000-000000000005";
        let result = exercise_public_command_script(
            &[
                "cli",
                "browser",
                "automation",
                "navigate",
                "--url",
                "https://example.test/path",
                "--automation-session-id",
                session_id,
                "--session-generation",
                "2",
                "--navigation-epoch",
                "7",
                "--operation-id",
                operation_id,
                "--attempt-epoch",
                "3",
                "--timeout-ms",
                "4000",
                "--idempotency-epoch",
                epoch,
                "--idempotency-key",
                key,
                "--correlation-id",
                correlation,
            ],
            vec![
                (
                    "system.identify",
                    json!({}),
                    Some(json!({
                        "application": "test-service",
                        "version": "0.0.0",
                        "protocolVersion": 1,
                        "capabilities": [agent_workspace_protocol::BROWSER_AUTOMATION_CAPABILITY]
                    })),
                ),
                (
                    "browserAutomation.operationInvoke",
                    json!({
                        "automationSessionId": session_id,
                        "sessionGeneration": 2,
                        "navigationEpoch": 7,
                        "operationId": operation_id,
                        "attemptEpoch": 3,
                        "timeoutMs": 4000,
                        "operation": {
                            "kind": "navigate",
                            "url": "https://example.test/path"
                        },
                        "idempotency": { "epoch": epoch, "key": key },
                        "correlationId": correlation
                    }),
                    Some(json!({
                        "operation": {
                            "automationSessionId": session_id,
                            "sessionGeneration": 2,
                            "operationId": operation_id,
                            "correlationId": correlation,
                            "attemptEpoch": 3,
                            "navigationEpoch": 7,
                            "state": "failed",
                            "errorCode": "policy_denied",
                            "updatedAtMs": 10
                        }
                    })),
                ),
            ],
        )
        .await
        .unwrap_err();
        assert_eq!(cli_exit_code(result.as_ref()), EXIT_AUTHORIZATION_OR_POLICY);
        let CliError::Terminal { output, .. } = result.downcast_ref::<CliError>().unwrap() else {
            panic!("expected retained terminal JSON");
        };
        assert_eq!(output["schemaVersion"], 1);
        assert_eq!(output["command"], "browserAutomation.operationInvoke");
        assert_eq!(output["result"]["operation"]["errorCode"], "policy_denied");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_workspace_skips_the_fallback_lookup() {
        use tokio::io::AsyncBufReadExt as _;

        let root = tempdir().unwrap();
        let endpoint = root.path().join("control.sock");
        let endpoint_string = endpoint.to_string_lossy().into_owned();
        let listener = ListenerOptions::new()
            .name(
                endpoint_string
                    .clone()
                    .to_fs_name::<GenericFilePath>()
                    .unwrap(),
            )
            .create_tokio()
            .unwrap();
        let token = "mock-control-token-with-at-least-32-bytes".to_owned();
        let session_path = root.path().join("runtime/cli-session.json");
        let _guard = CliSessionGuard::create(
            &session_path,
            &CliSessionRecord::current(endpoint_string, token.clone()),
        )
        .unwrap();

        let server = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&stream);
            let mut auth = String::new();
            let mut request = String::new();
            reader.read_line(&mut auth).await.unwrap();
            reader.read_line(&mut request).await.unwrap();
            let auth: AuthEnvelope = serde_json::from_str(auth.trim_end()).unwrap();
            assert_eq!(auth.auth.token, token);
            let request: RequestEnvelope = serde_json::from_str(request.trim_end()).unwrap();
            assert_eq!(request.command, "notification.publish");
            let response = ResponseEnvelope::failure(request.id, "test_complete", "done");
            let mut writer = &stream;
            writer
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        });

        let client = ControlClient::discover(&session_path).unwrap();
        let result = publish(
            &client,
            NotifyArguments {
                title: "Explicit target".to_owned(),
                body: None,
                level: Level::Info,
                workspace_id: Some("00000000-0000-0000-0000-000000000001".to_owned()),
                pane_id: None,
                tab_id: None,
            },
            NotificationSource::Cli,
        )
        .await;
        assert!(result.is_err());
        server.await.unwrap();
    }
}

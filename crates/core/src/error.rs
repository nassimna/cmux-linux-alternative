use crate::{
    ClosedItemId, CommandId, GroupId, LayoutId, NotificationId, PaneId, SplitId, TabId, WindowId,
    WorkspaceId,
};

/// Stable domain failures suitable for mapping to protocol error codes.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum DomainError {
    /// A caller supplied a string that was empty after trimming.
    #[error("{field} must not be empty")]
    EmptyText { field: &'static str },
    /// A caller supplied text beyond the documented scalar-value limit.
    #[error("{field} exceeds its {max} character limit")]
    TextTooLong { field: &'static str, max: usize },
    /// Text contains a control scalar that cannot safely cross protocol and UI boundaries.
    #[error("{field} contains an unsafe control character")]
    UnsafeControlCharacter { field: &'static str },
    /// A path that must be absolute was relative.
    #[error("{field} must be an absolute path")]
    RelativePath { field: &'static str },
    /// A layout path is outside every explicitly authorized workspace root.
    #[error("layout path `{path}` is outside authorized workspace roots")]
    UnauthorizedLayoutPath { path: std::path::PathBuf },
    /// A command identifier contains unsupported characters.
    #[error("invalid command id `{value}`")]
    InvalidCommandId { value: String },
    /// A logical shortcut cannot be parsed into a non-empty chord.
    #[error("invalid logical shortcut `{value}`")]
    InvalidShortcut { value: String },
    /// A terminal command was present but empty.
    #[error("terminal command must contain at least one argument")]
    EmptyCommand,
    /// A terminal command's executable was empty or whitespace-only.
    #[error("terminal command executable must not be empty")]
    EmptyExecutable,
    /// Arbitrary command argv has no approved persistent representation yet.
    #[error("arbitrary terminal commands cannot be stored in persistent launch metadata")]
    PersistentTerminalCommandUnsupported,
    /// Terminal dimensions must both be within the runtime-supported range.
    #[error("terminal rows and columns must be between 1 and 1000")]
    InvalidTerminalDimensions,
    /// A requested workspace does not exist.
    #[error("workspace `{id}` was not found")]
    WorkspaceNotFound { id: WorkspaceId },
    /// A requested pane does not exist in the workspace.
    #[error("pane `{id}` was not found")]
    PaneNotFound { id: PaneId },
    /// A requested split does not exist in the workspace.
    #[error("split `{id}` was not found")]
    SplitNotFound { id: SplitId },
    /// A requested tab does not exist in the workspace.
    #[error("tab `{id}` was not found")]
    TabNotFound { id: TabId },
    /// A requested notification does not exist.
    #[error("notification `{id}` was not found")]
    NotificationNotFound { id: NotificationId },
    /// A requested workspace group does not exist.
    #[error("workspace group `{id}` was not found")]
    GroupNotFound { id: GroupId },
    /// A requested saved layout does not exist.
    #[error("saved layout `{id}` was not found")]
    LayoutNotFound { id: LayoutId },
    /// A requested window placement does not exist.
    #[error("window placement `{id}` was not found")]
    WindowNotFound { id: WindowId },
    /// A requested recently-closed record does not exist.
    #[error("recently-closed record `{id}` was not found")]
    ClosedItemNotFound { id: ClosedItemId },
    /// A persistent identity is already in use.
    #[error("duplicate {entity} id `{id}`")]
    DuplicateId { entity: &'static str, id: String },
    /// An ordered insertion/move index is out of range.
    #[error("index {index} is out of bounds for length {len}")]
    IndexOutOfBounds { index: usize, len: usize },
    /// A caller supplied an entity owned by a different pane.
    #[error("tab `{tab}` belongs to pane `{actual}`, expected `{expected}`")]
    TabPaneMismatch {
        tab: TabId,
        expected: PaneId,
        actual: PaneId,
    },
    /// A non-terminal tab was supplied where a replacement terminal is required.
    #[error("replacement tab must contain a terminal")]
    ReplacementMustBeTerminal,
    /// A terminal-runtime operation targeted browser content.
    #[error("tab `{id}` does not contain a terminal")]
    TabNotTerminal { id: TabId },
    /// A terminal session is already attached to the requested tab.
    #[error("tab `{id}` already has a runtime terminal session")]
    RuntimeSessionAlreadyBound { id: TabId },
    /// A terminal runtime replacement targeted an unattached terminal tab.
    #[error("tab `{id}` does not have a runtime terminal session")]
    RuntimeSessionNotBound { id: TabId },
    /// Caller-created terminal input must not carry a runtime-owned session identity.
    #[error("new terminal tab `{id}` must not have a pre-bound runtime session")]
    PreboundTerminalInput { id: TabId },
    /// The final entity cannot be removed without caller-provided replacement data.
    #[error("closing the final {entity} requires a replacement")]
    ReplacementRequired { entity: &'static str },
    /// Replacement data is only accepted for final-entity close operations.
    #[error("replacement is not allowed when closing a non-final {entity}")]
    UnexpectedReplacement { entity: &'static str },
    /// The requested operation would split a pane using its only existing tab.
    #[error("cannot move the target pane's only tab into its new sibling")]
    SplitWouldEmptyTarget,
    /// The operation is a self/no-op mutation that the API rejects explicitly.
    #[error("invalid operation: {message}")]
    InvalidOperation { message: &'static str },
    /// A split ratio was not finite.
    #[error("split ratio must be finite")]
    NonFiniteRatio,
    /// A browser placeholder URL could leak data or use an unsafe URL form.
    #[error("browser URL must be a safe HTTP(S) URL without credentials, query, or fragment")]
    UnsafeBrowserUrl,
    /// Two active shortcut overrides resolve to the same logical shortcut.
    #[error("shortcut conflict between `{first}` and `{second}`")]
    ShortcutConflict { first: CommandId, second: CommandId },
    /// A loaded or caller-supplied snapshot violates a structural invariant.
    #[error("invalid state: {message}")]
    InvalidState { message: String },
    /// A persisted revision cannot be represented exactly by protocol number fields.
    #[error("revision {revision} exceeds the maximum safe integer")]
    RevisionOutOfRange { revision: u64 },
    /// A persisted timestamp cannot be represented exactly by protocol number fields.
    #[error("{field} value {value} exceeds the maximum safe integer")]
    TimestampOutOfRange { field: &'static str, value: u64 },
    /// The revision cannot be incremented further.
    #[error("revision cannot be incremented beyond the maximum safe integer")]
    RevisionOverflow,
    /// A bounded aggregate or template resource would exceed its hard limit.
    #[error("{resource} count {actual} exceeds its {maximum} limit")]
    ResourceLimit {
        resource: &'static str,
        actual: usize,
        maximum: usize,
    },
    /// A mutation would increase a dimension that must first be reduced from a legacy snapshot.
    #[error("legacy over-limit data must be reduced before increasing `{dimension}`")]
    LegacyLimitReductionRequired { dimension: &'static str },
    /// A layout envelope uses an unsupported format version.
    #[error("unsupported saved-layout format version {version}")]
    UnsupportedLayoutFormat { version: u32 },
    /// A saved-layout template exceeds its serialized byte limit.
    #[error("saved-layout template size {actual} exceeds its {maximum}-byte limit")]
    LayoutTemplateTooLarge { actual: usize, maximum: usize },
}

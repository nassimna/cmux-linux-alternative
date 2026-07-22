use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::{
    ClosedItemRecord, CommandId, DomainError, FocusHistory, GroupId, LayoutId, LegacyOverLimit,
    MutationOutcome, Notification, NotificationId, NotificationSettings, PaneId, RuntimeSessionId,
    SavedLayout, SplitId, TabId, WindowId, WindowPlacement, WorkspaceGroup, WorkspaceId,
};

pub(crate) const MAX_NAME_CHARS: usize = 128;
pub(crate) const MAX_TITLE_CHARS: usize = 256;
pub(crate) const MAX_DESCRIPTION_CHARS: usize = 4_096;
pub(crate) const MAX_COLOR_CHARS: usize = 64;
pub(crate) const MAX_SHORTCUT_CHARS: usize = 128;
pub(crate) const MAX_URL_CHARS: usize = 8_192;
const MAX_BROWSER_PARTITION_CHARS: usize = 128;
const MAX_BROWSER_CORRELATION_CHARS: usize = 128;
const DEFAULT_BROWSER_PARTITION: &str = "persist:agent-workspace-default";
/// Largest integer that round-trips exactly through JavaScript/TypeScript `number` values.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const RATIO_SCALE: f64 = 1_000_000.0;

/// Caller-supplied wall-clock timestamp represented as Unix milliseconds.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Timestamp(pub u64);

/// Direction in which a pane split lays out its children.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    /// Children are laid out left to right.
    Horizontal,
    /// Children are laid out top to bottom.
    Vertical,
}

/// Placement of a new pane relative to a target pane.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SplitPlacement {
    /// The new pane becomes the first child.
    Before,
    /// The new pane becomes the second child.
    After,
}

/// Browser action whose desired state is committed before the live view executes it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
    Stop,
    OpenDevTools,
}

/// Platform mapping used to detect physical keyboard-shortcut conflicts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShortcutPlatform {
    /// macOS maps logical `Primary` to Command/Meta.
    MacOs,
    /// Linux and Windows map logical `Primary` to Control.
    NonMacOs,
}

/// Persistent terminal launch metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TerminalLaunchSpec {
    /// Absolute directory used to launch the process.
    pub cwd: PathBuf,
    /// Initial terminal rows.
    pub rows: u16,
    /// Initial terminal columns.
    pub cols: u16,
}

impl TerminalLaunchSpec {
    /// Creates validated terminal launch metadata.
    ///
    /// # Errors
    /// Returns an error for a relative directory, any arbitrary command, or an invalid dimension.
    #[allow(clippy::needless_pass_by_value)]
    pub fn new(
        cwd: PathBuf,
        command: Option<Vec<String>>,
        rows: u16,
        cols: u16,
    ) -> Result<Self, DomainError> {
        if command.is_some() {
            return Err(DomainError::PersistentTerminalCommandUnsupported);
        }
        let value = Self { cwd, rows, cols };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        if !self.cwd.is_absolute() {
            return Err(DomainError::RelativePath {
                field: "terminal.cwd",
            });
        }
        if !(1..=1_000).contains(&self.rows) || !(1..=1_000).contains(&self.cols) {
            return Err(DomainError::InvalidTerminalDimensions);
        }
        Ok(())
    }
}

/// Persistent authoritative browser-session state.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMetadata {
    /// Stable application-owned identity used to associate an Electron live view.
    browser_session_id: Uuid,
    /// Current canonical URL. Credentials are never accepted or persisted.
    url: String,
    /// Last navigation title reported by the live view.
    navigation_title: String,
    can_back: bool,
    can_forward: bool,
    loading: bool,
    dev_tools_open: bool,
    /// Bounded application-owned Electron profile partition.
    profile_partition: String,
    /// Monotonically increasing browser-state revision.
    state_revision: u64,
    /// Optional operation correlation supplied with the last accepted observation.
    correlation_id: Option<String>,
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UncheckedBrowserMetadata {
    #[serde(default = "Uuid::new_v4")]
    browser_session_id: Uuid,
    url: String,
    #[serde(default)]
    navigation_title: String,
    #[serde(default)]
    can_back: bool,
    #[serde(default)]
    can_forward: bool,
    #[serde(default)]
    loading: bool,
    #[serde(default)]
    dev_tools_open: bool,
    #[serde(default = "default_browser_partition")]
    profile_partition: String,
    #[serde(default)]
    state_revision: u64,
    #[serde(default)]
    correlation_id: Option<String>,
}

impl<'de> Deserialize<'de> for BrowserMetadata {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let unchecked = UncheckedBrowserMetadata::deserialize(deserializer)?;
        let value = Self {
            browser_session_id: unchecked.browser_session_id,
            url: unchecked.url,
            navigation_title: unchecked.navigation_title,
            can_back: unchecked.can_back,
            can_forward: unchecked.can_forward,
            loading: unchecked.loading,
            dev_tools_open: unchecked.dev_tools_open,
            profile_partition: unchecked.profile_partition,
            state_revision: unchecked.state_revision,
            correlation_id: unchecked.correlation_id,
        };
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

impl BrowserMetadata {
    /// Creates validated browser metadata.
    ///
    /// # Errors
    /// Returns an error when the URL is empty or exceeds its bound.
    pub fn new(url: impl Into<String>) -> Result<Self, DomainError> {
        Self::new_with_partition(url, DEFAULT_BROWSER_PARTITION)
    }

    /// Creates browser metadata with a validated application-owned profile partition.
    ///
    /// # Errors
    /// Returns an error when the URL or profile partition violates browser safety invariants.
    pub fn new_with_partition(
        url: impl Into<String>,
        profile_partition: impl Into<String>,
    ) -> Result<Self, DomainError> {
        let profile_partition = profile_partition.into();
        checked_browser_partition(&profile_partition)?;
        Ok(Self {
            browser_session_id: Uuid::new_v4(),
            url: checked_browser_url(&url.into())?,
            navigation_title: String::new(),
            can_back: false,
            can_forward: false,
            loading: false,
            dev_tools_open: false,
            profile_partition,
            state_revision: 0,
            correlation_id: None,
        })
    }

    /// Returns the stable browser-session identity.
    #[must_use]
    pub const fn browser_session_id(&self) -> Uuid {
        self.browser_session_id
    }

    /// Returns the canonical safe URL stored for restoration.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Returns the isolated profile partition used by the live browser view.
    #[must_use]
    pub fn profile_partition(&self) -> &str {
        &self.profile_partition
    }

    #[must_use]
    pub fn navigation_title(&self) -> &str {
        &self.navigation_title
    }

    #[must_use]
    pub const fn can_back(&self) -> bool {
        self.can_back
    }

    #[must_use]
    pub const fn can_forward(&self) -> bool {
        self.can_forward
    }

    #[must_use]
    pub const fn loading(&self) -> bool {
        self.loading
    }

    #[must_use]
    pub const fn dev_tools_open(&self) -> bool {
        self.dev_tools_open
    }

    /// Returns the last accepted browser-state revision.
    #[must_use]
    pub const fn state_revision(&self) -> u64 {
        self.state_revision
    }

    #[must_use]
    pub fn correlation_id(&self) -> Option<&str> {
        self.correlation_id.as_deref()
    }

    pub(crate) fn is_fresh_reopen_state(&self, url: &str) -> bool {
        self.url == url
            && self.navigation_title.is_empty()
            && !self.can_back
            && !self.can_forward
            && !self.loading
            && !self.dev_tools_open
            && self.profile_partition == DEFAULT_BROWSER_PARTITION
            && self.state_revision == 0
            && self.correlation_id.is_none()
    }

    /// Records a desired navigation after optimistic revision validation.
    pub(crate) fn navigate(
        &mut self,
        url: &str,
        expected_state_revision: u64,
        correlation_id: &str,
    ) -> Result<(), DomainError> {
        if self.state_revision != expected_state_revision {
            return Err(invalid("browser state revision is stale"));
        }
        checked_browser_correlation(correlation_id)?;
        self.url = checked_browser_url(url)?;
        self.loading = true;
        self.state_revision = self
            .state_revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("browser state revision overflow"))?;
        self.correlation_id = Some(correlation_id.to_owned());
        Ok(())
    }

    pub(crate) fn request_action(
        &mut self,
        action: BrowserAction,
        expected_state_revision: u64,
        correlation_id: &str,
    ) -> Result<(), DomainError> {
        if self.state_revision != expected_state_revision {
            return Err(invalid("browser state revision is stale"));
        }
        checked_browser_correlation(correlation_id)?;
        match action {
            BrowserAction::Back if !self.can_back => {
                return Err(invalid("browser cannot navigate back"));
            }
            BrowserAction::Forward if !self.can_forward => {
                return Err(invalid("browser cannot navigate forward"));
            }
            BrowserAction::Back | BrowserAction::Forward | BrowserAction::Reload => {
                self.loading = true;
            }
            BrowserAction::Stop => self.loading = false,
            BrowserAction::OpenDevTools => self.dev_tools_open = true,
        }
        self.state_revision = self
            .state_revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("browser state revision overflow"))?;
        self.correlation_id = Some(correlation_id.to_owned());
        Ok(())
    }

    /// Accepts a newer observation from the live view and rejects stale replay.
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::fn_params_excessive_bools)]
    pub(crate) fn apply_observation(
        &mut self,
        observed_revision: u64,
        url: &str,
        navigation_title: &str,
        can_back: bool,
        can_forward: bool,
        loading: bool,
        dev_tools_open: bool,
        correlation_id: Option<&str>,
    ) -> Result<(), DomainError> {
        if observed_revision <= self.state_revision || observed_revision > MAX_SAFE_INTEGER {
            return Err(invalid(
                "browser observation revision is stale or out of range",
            ));
        }
        let navigation_title = checked_text(
            "browser.navigation_title",
            navigation_title,
            MAX_TITLE_CHARS,
            true,
        )?;
        if navigation_title.chars().any(char::is_control) {
            return Err(DomainError::UnsafeControlCharacter {
                field: "browser.navigation_title",
            });
        }
        let correlation_id = correlation_id
            .map(|value| {
                checked_browser_correlation(value)?;
                Ok::<_, DomainError>(value.to_owned())
            })
            .transpose()?;
        self.url = checked_browser_url(url)?;
        self.navigation_title = navigation_title;
        self.can_back = can_back;
        self.can_forward = can_forward;
        self.loading = loading;
        self.dev_tools_open = dev_tools_open;
        self.state_revision = observed_revision;
        self.correlation_id = correlation_id;
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        if checked_browser_url(&self.url)? != self.url {
            return Err(invalid("browser URL is not canonical"));
        }
        validate_normalized_text(
            "browser.navigation_title",
            &self.navigation_title,
            MAX_TITLE_CHARS,
            true,
        )?;
        checked_browser_partition(&self.profile_partition)?;
        if self.state_revision > MAX_SAFE_INTEGER {
            return Err(invalid(
                "browser state revision exceeds the safe integer bound",
            ));
        }
        if let Some(correlation_id) = &self.correlation_id {
            checked_browser_correlation(correlation_id)?;
        }
        Ok(())
    }
}

fn default_browser_partition() -> String {
    DEFAULT_BROWSER_PARTITION.to_owned()
}

/// Content hosted by a tab.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum TabContent {
    /// A terminal launch specification plus an explicitly non-persistent session identity.
    Terminal {
        /// Persistent process launch metadata.
        launch: TerminalLaunchSpec,
        /// Runtime-owned identity, always omitted from persistence and restored as `None`.
        #[serde(skip, default)]
        runtime_session_id: Option<RuntimeSessionId>,
    },
    /// Metadata-only placeholder for future browser functionality.
    Browser { metadata: BrowserMetadata },
}

impl TabContent {
    /// Returns the runtime session if this is an attached terminal.
    #[must_use]
    pub fn runtime_session_id(&self) -> Option<&RuntimeSessionId> {
        match self {
            Self::Terminal {
                runtime_session_id, ..
            } => runtime_session_id.as_ref(),
            Self::Browser { .. } => None,
        }
    }

    /// Replaces the runtime-only session identity without changing persisted launch data.
    pub fn set_runtime_session_id(&mut self, value: Option<RuntimeSessionId>) {
        if let Self::Terminal {
            runtime_session_id, ..
        } = self
        {
            *runtime_session_id = value;
        }
    }

    #[must_use]
    pub(crate) const fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal { .. })
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        match self {
            Self::Terminal { launch, .. } => launch.validate(),
            Self::Browser { metadata } => metadata.validate(),
        }
    }
}

/// A tab and its persistent ownership metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tab {
    /// Persistent tab identity.
    pub id: TabId,
    /// Pane that owns this tab.
    pub pane_id: PaneId,
    /// Default bounded display title.
    pub title: String,
    /// Optional bounded user-supplied title.
    pub custom_title: Option<String>,
    /// Hosted content.
    pub content: TabContent,
    /// Caller-supplied creation time.
    pub created_at: Timestamp,
}

impl Tab {
    /// Creates a terminal tab. Titles are trimmed and limited to 256 Unicode scalars.
    ///
    /// # Errors
    /// Returns an error when the title or launch metadata is invalid.
    pub fn terminal(
        id: TabId,
        pane_id: PaneId,
        title: impl Into<String>,
        launch: TerminalLaunchSpec,
        runtime_session_id: Option<RuntimeSessionId>,
        created_at: Timestamp,
    ) -> Result<Self, DomainError> {
        Self::new(
            id,
            pane_id,
            title,
            TabContent::Terminal {
                launch,
                runtime_session_id,
            },
            created_at,
        )
    }

    /// Creates a browser-placeholder tab.
    ///
    /// # Errors
    /// Returns an error when the title or browser metadata is invalid.
    pub fn browser(
        id: TabId,
        pane_id: PaneId,
        title: impl Into<String>,
        metadata: BrowserMetadata,
        created_at: Timestamp,
    ) -> Result<Self, DomainError> {
        Self::new(
            id,
            pane_id,
            title,
            TabContent::Browser { metadata },
            created_at,
        )
    }

    fn new(
        id: TabId,
        pane_id: PaneId,
        title: impl Into<String>,
        content: TabContent,
        created_at: Timestamp,
    ) -> Result<Self, DomainError> {
        let mut value = Self {
            id,
            pane_id,
            title: title.into(),
            custom_title: None,
            content,
            created_at,
        };
        value.title = checked_text("tab.title", &value.title, MAX_TITLE_CHARS, false)?;
        value.content.validate()?;
        Ok(value)
    }

    /// Sets or clears the custom title after applying the title bound and trimming.
    ///
    /// # Errors
    /// Returns an error when a supplied title is empty or exceeds its bound.
    pub fn set_custom_title(&mut self, title: Option<String>) -> Result<(), DomainError> {
        self.custom_title = title
            .map(|value| checked_text("tab.custom_title", &value, MAX_TITLE_CHARS, false))
            .transpose()?;
        Ok(())
    }

    /// Updates the default title after applying the title bound and trimming.
    ///
    /// # Errors
    /// Returns an error when the title is empty or exceeds its bound.
    pub fn set_title(&mut self, title: impl Into<String>) -> Result<(), DomainError> {
        self.title = checked_text("tab.title", &title.into(), MAX_TITLE_CHARS, false)?;
        Ok(())
    }

    pub(crate) fn duplicate_for(
        &self,
        id: TabId,
        pane_id: PaneId,
        created_at: Timestamp,
    ) -> Result<Self, DomainError> {
        let content = match &self.content {
            TabContent::Terminal { launch, .. } => TabContent::Terminal {
                launch: launch.clone(),
                runtime_session_id: None,
            },
            TabContent::Browser { metadata } => TabContent::Browser {
                metadata: BrowserMetadata::new_with_partition(
                    metadata.url(),
                    metadata.profile_partition(),
                )?,
            },
        };
        let mut duplicated = Self::new(id, pane_id, self.title.clone(), content, created_at)?;
        duplicated.custom_title.clone_from(&self.custom_title);
        Ok(duplicated)
    }

    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        validate_normalized_text("tab.title", &self.title, MAX_TITLE_CHARS, false)?;
        if let Some(title) = &self.custom_title {
            validate_normalized_text("tab.custom_title", title, MAX_TITLE_CHARS, false)?;
        }
        self.content.validate()
    }
}

/// A leaf pane's ordered, non-empty tab list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pane {
    /// Persistent pane identity.
    pub id: PaneId,
    /// Ordered tab identities.
    pub tabs: Vec<TabId>,
    /// Selected tab in this pane.
    pub selected_tab_id: TabId,
    /// Optional bounded pane title.
    pub title: Option<String>,
}

impl Pane {
    /// Creates a pane containing exactly one initial tab.
    #[must_use]
    pub fn new(id: PaneId, initial_tab_id: TabId) -> Self {
        Self {
            id,
            tabs: vec![initial_tab_id],
            selected_tab_id: initial_tab_id,
            title: None,
        }
    }

    /// Sets or clears a bounded pane title.
    ///
    /// # Errors
    /// Returns an error when a supplied title is empty or exceeds its bound.
    pub fn set_title(&mut self, title: Option<String>) -> Result<(), DomainError> {
        self.title = title
            .map(|value| checked_text("pane.title", &value, MAX_TITLE_CHARS, false))
            .transpose()?;
        Ok(())
    }
}

/// Recursive binary pane layout.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum PaneNode {
    /// A leaf referencing a pane in the workspace pane map.
    Leaf {
        // Keep accepting the pre-M2 persisted spelling while emitting the public camelCase
        // contract consumed by strict protocol DTOs.
        #[serde(rename = "paneId", alias = "pane_id")]
        pane_id: PaneId,
    },
    /// A binary layout split.
    Split {
        /// Persistent split identity.
        #[serde(rename = "splitId", alias = "split_id")]
        split_id: SplitId,
        /// Layout direction.
        axis: Axis,
        /// First-child share, constrained to `0.05..=0.95` and canonicalized to six decimals.
        #[serde(deserialize_with = "deserialize_ratio")]
        ratio: f64,
        /// First child.
        first: Box<Self>,
        /// Second child.
        second: Box<Self>,
    },
}

impl PaneNode {
    pub(crate) fn collect(
        &self,
        panes: &mut Vec<PaneId>,
        splits: &mut BTreeSet<SplitId>,
    ) -> Result<(), DomainError> {
        match self {
            Self::Leaf { pane_id } => panes.push(*pane_id),
            Self::Split {
                split_id,
                ratio,
                first,
                second,
                ..
            } => {
                if !ratio.is_finite() || !(0.05..=0.95).contains(ratio) {
                    return Err(DomainError::InvalidState {
                        message: format!("split `{split_id}` ratio is outside 0.05..=0.95"),
                    });
                }
                if canonical_ratio(*ratio)?.to_bits() != ratio.to_bits() {
                    return Err(DomainError::InvalidState {
                        message: format!("split `{split_id}` ratio is not canonical"),
                    });
                }
                if !splits.insert(*split_id) {
                    return Err(DomainError::DuplicateId {
                        entity: "split",
                        id: split_id.to_string(),
                    });
                }
                first.collect(panes, splits)?;
                second.collect(panes, splits)?;
            }
        }
        Ok(())
    }
}

/// A complete workspace snapshot.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    /// Persistent workspace identity.
    pub id: WorkspaceId,
    /// Trimmed non-empty name, limited to 128 Unicode scalars.
    pub name: String,
    /// Optional description, limited to 4096 Unicode scalars.
    pub description: Option<String>,
    /// Optional presentation color token, limited to 64 Unicode scalars.
    pub color: Option<String>,
    /// Absolute default working directory.
    pub working_directory: PathBuf,
    /// Recursive pane layout.
    pub layout: PaneNode,
    /// Focused pane.
    pub selected_pane_id: PaneId,
    /// Pane data keyed by persistent identity.
    pub panes: BTreeMap<PaneId, Pane>,
    /// Tab data keyed by persistent identity.
    pub tabs: BTreeMap<TabId, Tab>,
    /// Caller-supplied creation time.
    pub created_at: Timestamp,
    /// Caller-supplied last mutation time.
    pub updated_at: Timestamp,
}

impl Workspace {
    /// Creates a workspace around a caller-supplied initial tab.
    ///
    /// # Errors
    /// Returns an error when metadata, ownership, or initial content is invalid.
    pub fn new(
        id: WorkspaceId,
        name: impl Into<String>,
        working_directory: PathBuf,
        initial_pane_id: PaneId,
        initial_tab: Tab,
        created_at: Timestamp,
        updated_at: Timestamp,
    ) -> Result<Self, DomainError> {
        if initial_tab.pane_id != initial_pane_id {
            return Err(DomainError::TabPaneMismatch {
                tab: initial_tab.id,
                expected: initial_pane_id,
                actual: initial_tab.pane_id,
            });
        }
        let tab_id = initial_tab.id;
        let value = Self {
            id,
            name: checked_text("workspace.name", &name.into(), MAX_NAME_CHARS, false)?,
            description: None,
            color: None,
            working_directory,
            layout: PaneNode::Leaf {
                pane_id: initial_pane_id,
            },
            selected_pane_id: initial_pane_id,
            panes: BTreeMap::from([(initial_pane_id, Pane::new(initial_pane_id, tab_id))]),
            tabs: BTreeMap::from([(tab_id, initial_tab)]),
            created_at,
            updated_at,
        };
        value.validate()?;
        Ok(value)
    }

    /// Validates all workspace graph, ownership, selection, text, path, and ratio invariants.
    ///
    /// # Errors
    /// Returns the first structural or field invariant violation.
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_normalized_text("workspace.name", &self.name, MAX_NAME_CHARS, false)?;
        if !self.working_directory.is_absolute() {
            return Err(DomainError::RelativePath {
                field: "workspace.working_directory",
            });
        }
        if let Some(value) = &self.description {
            validate_normalized_text("workspace.description", value, MAX_DESCRIPTION_CHARS, true)?;
        }
        if let Some(value) = &self.color {
            validate_normalized_text("workspace.color", value, MAX_COLOR_CHARS, false)?;
        }
        validate_timestamp("workspace.created_at", self.created_at)?;
        validate_timestamp("workspace.updated_at", self.updated_at)?;
        let mut leaves = Vec::new();
        self.layout.collect(&mut leaves, &mut BTreeSet::new())?;
        if leaves.is_empty() {
            return Err(invalid("workspace layout has no leaf panes"));
        }
        let unique_leaves: BTreeSet<_> = leaves.iter().copied().collect();
        if leaves.len() != unique_leaves.len() {
            return Err(invalid("a pane is referenced more than once by the layout"));
        }
        if unique_leaves != self.panes.keys().copied().collect() {
            return Err(invalid("layout leaves and pane map differ"));
        }
        if !self.panes.contains_key(&self.selected_pane_id) {
            return Err(invalid("selected pane does not exist"));
        }
        let mut owned_tabs = BTreeSet::new();
        for (pane_id, pane) in &self.panes {
            if pane.id != *pane_id {
                return Err(invalid("pane map key differs from pane id"));
            }
            if pane.tabs.is_empty() {
                return Err(invalid("pane has no tabs"));
            }
            if !pane.tabs.contains(&pane.selected_tab_id) {
                return Err(invalid("selected tab does not exist in pane"));
            }
            if let Some(title) = &pane.title {
                validate_normalized_text("pane.title", title, MAX_TITLE_CHARS, false)?;
            }
            for tab_id in &pane.tabs {
                if !owned_tabs.insert(*tab_id) {
                    return Err(invalid("a tab is referenced by multiple panes"));
                }
                let tab = self
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| invalid("pane references a missing tab"))?;
                if tab.pane_id != *pane_id {
                    return Err(DomainError::TabPaneMismatch {
                        tab: *tab_id,
                        expected: *pane_id,
                        actual: tab.pane_id,
                    });
                }
            }
        }
        if owned_tabs != self.tabs.keys().copied().collect() {
            return Err(invalid("tab map contains an orphan tab"));
        }
        for (tab_id, tab) in &self.tabs {
            if tab.id != *tab_id {
                return Err(invalid("tab map key differs from tab id"));
            }
            tab.validate()?;
            validate_timestamp("tab.created_at", tab.created_at)?;
        }
        Ok(())
    }
}

/// Partial workspace metadata update. Nested options distinguish no-change from clear.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WorkspaceUpdate {
    /// New workspace name, when present.
    pub name: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
    /// `Some(None)` clears the color.
    pub color: Option<Option<String>>,
    /// New absolute working directory, when present.
    pub working_directory: Option<PathBuf>,
}

/// A normalized logical shortcut string.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct LogicalShortcut(String);

impl LogicalShortcut {
    /// Creates a trimmed, non-empty logical shortcut of at most 128 scalars.
    ///
    /// # Errors
    /// Returns an error when the shortcut is empty or exceeds its bound.
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = checked_text("shortcut", &value.into(), MAX_SHORTCUT_CHARS, false)?;
        let value = normalize_logical_shortcut(&value)?;
        Ok(Self(value))
    }

    /// Returns the normalized shortcut.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl CommandId {
    /// Creates a stable command ID containing ASCII letters, numbers, `.`, `_`, or `-`.
    ///
    /// # Errors
    /// Returns an error when the identifier is empty, too long, or uses another character.
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = checked_text("command_id", &value.into(), MAX_NAME_CHARS, false)?;
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(DomainError::InvalidCommandId { value });
        }
        Ok(Self(value))
    }
}

/// One built-in command and its authoritative logical default shortcut.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DefaultShortcutBinding {
    /// Stable command identity shared with protocol and renderer command registries.
    pub command_id: &'static str,
    /// Canonical logical shortcut string.
    pub shortcut: &'static str,
}

/// Authoritative catalog of project-owned default keyboard shortcuts.
pub const DEFAULT_SHORTCUT_CATALOG: &[DefaultShortcutBinding] = &[
    DefaultShortcutBinding {
        command_id: "workspace.new",
        shortcut: "Primary+O",
    },
    DefaultShortcutBinding {
        command_id: "terminal.new",
        shortcut: "Primary+T",
    },
    DefaultShortcutBinding {
        command_id: "tab.close",
        shortcut: "Primary+W",
    },
    DefaultShortcutBinding {
        command_id: "pane.splitRight",
        shortcut: "Primary+D",
    },
    DefaultShortcutBinding {
        command_id: "pane.splitDown",
        shortcut: "Primary+Shift+D",
    },
    DefaultShortcutBinding {
        command_id: "sidebar.toggle",
        shortcut: "Primary+B",
    },
    DefaultShortcutBinding {
        command_id: "commandPalette.toggle",
        shortcut: "Primary+Shift+P",
    },
    DefaultShortcutBinding {
        command_id: "terminal.search",
        shortcut: "Primary+F",
    },
    DefaultShortcutBinding {
        command_id: "browser.openSplit",
        shortcut: "Primary+Shift+L",
    },
    DefaultShortcutBinding {
        command_id: "notifications.toggle",
        shortcut: "Primary+I",
    },
    DefaultShortcutBinding {
        command_id: "notifications.latestUnread",
        shortcut: "Primary+Shift+U",
    },
    DefaultShortcutBinding {
        command_id: "settings.open",
        shortcut: "Primary+Comma",
    },
];

/// Root validated application snapshot.
///
/// Deserialization intentionally targets [`UncheckedApplicationState`]. Convert that type with
/// [`TryFrom`] so invalid durable data cannot enter the mutation layer accidentally.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationState {
    /// Monotonic application revision.
    pub revision: u64,
    /// User-visible workspace order.
    pub workspaces: Vec<Workspace>,
    /// Selected workspace.
    pub selected_workspace_id: WorkspaceId,
    /// Ordered authoritative multiselection, always containing the focused workspace.
    pub workspace_selection: Vec<WorkspaceId>,
    /// Ordered pin membership. Canonical workspace ordering remains unchanged.
    pub workspace_pins: Vec<WorkspaceId>,
    /// Groups in durable presentation order.
    pub workspace_groups: Vec<WorkspaceGroup>,
    /// At-most-one group membership for each assigned workspace.
    pub workspace_group_assignments: BTreeMap<WorkspaceId, GroupId>,
    /// Bounded named layout templates.
    pub saved_layouts: Vec<SavedLayout>,
    /// Exact counts for a supported pre-v4 snapshot being reduced below new limits.
    pub legacy_over_limit: Option<LegacyOverLimit>,
    /// Persisted overrides. `Some(None)` in the map means explicitly cleared.
    pub shortcut_overrides: BTreeMap<CommandId, Option<LogicalShortcut>>,
    /// Bounded authoritative notification history. Attention is derived from unread records.
    pub notifications: Vec<Notification>,
    /// Policy for optional operating-system notification forwarding.
    pub notification_settings: NotificationSettings,
    /// Durable service-owned window/workspace placement topology.
    pub window_placements: Vec<WindowPlacement>,
    /// Placement most recently focused by an authoritative mutation.
    pub focused_window_id: WindowId,
    /// Bounded durable back/forward navigation history.
    pub focus_history: FocusHistory,
    /// Bounded redacted recently-closed foundation.
    pub recently_closed: Vec<ClosedItemRecord>,
}

/// Deserializable snapshot shape that has not yet passed domain validation.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UncheckedApplicationState {
    /// Monotonic application revision from the payload.
    pub revision: u64,
    /// User-visible workspace order from the payload.
    pub workspaces: Vec<Workspace>,
    /// Selected workspace from the payload.
    pub selected_workspace_id: WorkspaceId,
    /// Ordered authoritative multiselection. Legacy snapshots omit this field.
    #[serde(default)]
    pub workspace_selection: Option<Vec<WorkspaceId>>,
    /// Ordered pinned workspace IDs. Legacy snapshots omit this field.
    #[serde(default)]
    pub workspace_pins: Vec<WorkspaceId>,
    /// Durable workspace groups. Legacy snapshots omit this field.
    #[serde(default)]
    pub workspace_groups: Vec<WorkspaceGroup>,
    /// Durable group membership. Legacy snapshots omit this field.
    #[serde(default)]
    pub workspace_group_assignments: BTreeMap<WorkspaceId, GroupId>,
    /// Durable saved layouts. Legacy snapshots omit this field.
    #[serde(default)]
    pub saved_layouts: Vec<SavedLayout>,
    /// Reduction metadata for supported snapshots predating v4 limits.
    #[serde(default)]
    pub legacy_over_limit: Option<LegacyOverLimit>,
    /// Persisted shortcut overrides from the payload.
    pub shortcut_overrides: BTreeMap<CommandId, Option<LogicalShortcut>>,
    /// Notification history. Legacy schema-v1 payloads omit this field.
    #[serde(default)]
    pub notifications: Vec<Notification>,
    /// Notification forwarding policy. Legacy snapshots use privacy-preserving defaults.
    #[serde(default)]
    pub notification_settings: NotificationSettings,
    /// Durable topology. Snapshots predating schema v5 omit this field.
    #[serde(default)]
    pub window_placements: Option<Vec<WindowPlacement>>,
    /// Focused placement. Snapshots predating schema v5 omit this field.
    #[serde(default)]
    pub focused_window_id: Option<WindowId>,
    /// Durable focus history. Snapshots predating schema v5 omit this field.
    #[serde(default)]
    pub focus_history: FocusHistory,
    /// Redacted recently-closed records. Snapshots predating schema v5 omit this field.
    #[serde(default)]
    pub recently_closed: Vec<ClosedItemRecord>,
}

impl TryFrom<UncheckedApplicationState> for ApplicationState {
    type Error = DomainError;

    fn try_from(value: UncheckedApplicationState) -> Result<Self, Self::Error> {
        Self::try_from_unchecked(value, false, false)
    }
}

impl ApplicationState {
    /// Converts a schema-v3 snapshot while deriving migration-only resource-reduction metadata.
    ///
    /// This entry point is reserved for the storage migration boundary. Ordinary schema-v4
    /// decoding must use [`TryFrom<UncheckedApplicationState>`] and cannot infer reduction mode.
    ///
    /// # Errors
    /// Returns the first full aggregate invariant violation.
    pub fn try_from_schema_v3(value: UncheckedApplicationState) -> Result<Self, DomainError> {
        Self::try_from_unchecked(value, true, true)
    }

    /// Converts a schema-v4 snapshot while deriving its single initial window placement.
    ///
    /// This entry point is reserved for the transactional storage migration boundary.
    ///
    /// # Errors
    /// Returns the first aggregate invariant violated by the legacy snapshot.
    pub fn try_from_schema_v4(value: UncheckedApplicationState) -> Result<Self, DomainError> {
        Self::try_from_unchecked(value, false, true)
    }

    fn try_from_unchecked(
        value: UncheckedApplicationState,
        infer_legacy_over_limit: bool,
        infer_topology: bool,
    ) -> Result<Self, DomainError> {
        let workspace_selection = value
            .workspace_selection
            .unwrap_or_else(|| vec![value.selected_workspace_id]);
        let legacy_over_limit = value.legacy_over_limit.or_else(|| {
            infer_legacy_over_limit
                .then(|| LegacyOverLimit::from_workspaces(&value.workspaces))
                .flatten()
        });
        let migrated_window_id = WindowId::from_uuid(value.selected_workspace_id.as_uuid());
        let migrated_workspace_ids: Vec<_> = value
            .workspaces
            .iter()
            .map(|workspace| workspace.id)
            .collect();
        let state = Self {
            revision: value.revision,
            workspaces: value.workspaces,
            selected_workspace_id: value.selected_workspace_id,
            workspace_selection,
            workspace_pins: value.workspace_pins,
            workspace_groups: value.workspace_groups,
            workspace_group_assignments: value.workspace_group_assignments,
            saved_layouts: value.saved_layouts,
            legacy_over_limit,
            shortcut_overrides: value.shortcut_overrides,
            notifications: value.notifications,
            notification_settings: value.notification_settings,
            window_placements: match value.window_placements {
                _ if infer_topology => vec![WindowPlacement::migrated_default(
                    migrated_window_id,
                    migrated_workspace_ids,
                    value.selected_workspace_id,
                )],
                Some(placements) => placements,
                None => {
                    return Err(invalid(
                        "window placements are missing from a schema-v5 snapshot",
                    ));
                }
            },
            focused_window_id: match value.focused_window_id {
                _ if infer_topology => migrated_window_id,
                Some(id) => id,
                None => {
                    return Err(invalid(
                        "focused window is missing from a schema-v5 snapshot",
                    ));
                }
            },
            focus_history: value.focus_history,
            recently_closed: value.recently_closed,
        };
        state.validate()?;
        Ok(state)
    }
}

impl From<ApplicationState> for UncheckedApplicationState {
    fn from(value: ApplicationState) -> Self {
        Self {
            revision: value.revision,
            workspaces: value.workspaces,
            selected_workspace_id: value.selected_workspace_id,
            workspace_selection: Some(value.workspace_selection),
            workspace_pins: value.workspace_pins,
            workspace_groups: value.workspace_groups,
            workspace_group_assignments: value.workspace_group_assignments,
            saved_layouts: value.saved_layouts,
            legacy_over_limit: value.legacy_over_limit,
            shortcut_overrides: value.shortcut_overrides,
            notifications: value.notifications,
            notification_settings: value.notification_settings,
            window_placements: Some(value.window_placements),
            focused_window_id: Some(value.focused_window_id),
            focus_history: value.focus_history,
            recently_closed: value.recently_closed,
        }
    }
}

impl ApplicationState {
    /// Creates revision-zero state around one valid workspace.
    ///
    /// # Errors
    /// Returns an error when the initial workspace is invalid.
    pub fn new(initial_workspace: Workspace) -> Result<Self, DomainError> {
        let selected_workspace_id = initial_workspace.id;
        let value = Self {
            revision: 0,
            workspaces: vec![initial_workspace],
            selected_workspace_id,
            workspace_selection: vec![selected_workspace_id],
            workspace_pins: Vec::new(),
            workspace_groups: Vec::new(),
            workspace_group_assignments: BTreeMap::new(),
            saved_layouts: Vec::new(),
            legacy_over_limit: None,
            shortcut_overrides: BTreeMap::new(),
            notifications: Vec::new(),
            notification_settings: NotificationSettings::default(),
            window_placements: vec![WindowPlacement::migrated_default(
                WindowId::from_uuid(selected_workspace_id.as_uuid()),
                vec![selected_workspace_id],
                selected_workspace_id,
            )],
            focused_window_id: WindowId::from_uuid(selected_workspace_id.as_uuid()),
            focus_history: FocusHistory::default(),
            recently_closed: Vec::new(),
        };
        value.validate()?;
        Ok(value)
    }

    /// Validates a full loaded snapshot before it enters the mutation layer.
    ///
    /// # Errors
    /// Returns the first application, workspace, layout, or shortcut invariant violation.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.revision > MAX_SAFE_INTEGER {
            return Err(DomainError::RevisionOutOfRange {
                revision: self.revision,
            });
        }
        if self.workspaces.is_empty() {
            return Err(invalid("application has no workspaces"));
        }
        self.validate_resource_limits()?;
        let mut workspace_ids = BTreeSet::new();
        let mut pane_ids = BTreeSet::new();
        let mut split_ids = BTreeSet::new();
        let mut tab_ids = BTreeSet::new();
        for workspace in &self.workspaces {
            if !workspace_ids.insert(workspace.id) {
                return Err(DomainError::DuplicateId {
                    entity: "workspace",
                    id: workspace.id.to_string(),
                });
            }
            workspace.validate()?;
            for pane_id in workspace.panes.keys() {
                if !pane_ids.insert(*pane_id) {
                    return Err(DomainError::DuplicateId {
                        entity: "pane",
                        id: pane_id.to_string(),
                    });
                }
            }
            workspace.layout.collect(&mut Vec::new(), &mut split_ids)?;
            for tab_id in workspace.tabs.keys() {
                if !tab_ids.insert(*tab_id) {
                    return Err(DomainError::DuplicateId {
                        entity: "tab",
                        id: tab_id.to_string(),
                    });
                }
            }
        }
        let mut runtime_sessions = BTreeSet::new();
        let mut browser_sessions = BTreeSet::new();
        for workspace in &self.workspaces {
            for tab in workspace.tabs.values() {
                if let Some(session) = tab.content.runtime_session_id()
                    && !runtime_sessions.insert(session)
                {
                    return Err(DomainError::DuplicateId {
                        entity: "runtime_session",
                        id: session.to_string(),
                    });
                }
                if let TabContent::Browser { metadata } = &tab.content
                    && !browser_sessions.insert(metadata.browser_session_id)
                {
                    return Err(DomainError::DuplicateId {
                        entity: "browser_session",
                        id: metadata.browser_session_id.to_string(),
                    });
                }
            }
        }
        if !workspace_ids.contains(&self.selected_workspace_id) {
            return Err(invalid("selected workspace does not exist"));
        }
        self.validate_organization(&workspace_ids)?;
        self.validate_topology(&workspace_ids)?;
        self.validate_notifications()?;
        self.validate_shortcut_overrides()
    }

    fn validate_resource_limits(&self) -> Result<(), DomainError> {
        use crate::organization::{
            APPLICATION_MAX_PANES, APPLICATION_MAX_TABS, APPLICATION_MAX_WORKSPACES,
            LegacyOverLimit, WORKSPACE_MAX_PANES, WORKSPACE_MAX_TABS, check_limit,
        };
        let computed = LegacyOverLimit::from_workspaces(&self.workspaces);
        if let Some(stored) = &self.legacy_over_limit {
            stored.validate()?;
        }
        if let Some(stored) = &self.legacy_over_limit {
            match computed {
                Some(computed) if stored == &computed => {}
                None => {
                    return Err(invalid("legacy reduction mode must clear within v4 limits"));
                }
                Some(_) => return Err(invalid("legacy reduction counts do not match state")),
            }
        } else {
            check_limit(
                "application.workspaces",
                self.workspaces.len(),
                APPLICATION_MAX_WORKSPACES,
            )?;
            check_limit(
                "application.panes",
                self.workspaces
                    .iter()
                    .map(|workspace| workspace.panes.len())
                    .sum(),
                APPLICATION_MAX_PANES,
            )?;
            check_limit(
                "application.tabs",
                self.workspaces
                    .iter()
                    .map(|workspace| workspace.tabs.len())
                    .sum(),
                APPLICATION_MAX_TABS,
            )?;
            for workspace in &self.workspaces {
                check_limit(
                    "workspace.panes",
                    workspace.panes.len(),
                    WORKSPACE_MAX_PANES,
                )?;
                check_limit("workspace.tabs", workspace.tabs.len(), WORKSPACE_MAX_TABS)?;
            }
        }
        Ok(())
    }

    fn validate_organization(
        &self,
        workspace_ids: &BTreeSet<WorkspaceId>,
    ) -> Result<(), DomainError> {
        use crate::organization::{
            GROUP_ASSIGNMENT_MAX_COUNT, LAYOUT_MAX_COUNT, WORKSPACE_GROUP_MAX_COUNT,
            WORKSPACE_PIN_MAX_COUNT, WORKSPACE_SELECTION_MAX_COUNT, check_limit,
        };
        check_limit(
            "workspace_selection",
            self.workspace_selection.len(),
            WORKSPACE_SELECTION_MAX_COUNT,
        )?;
        if self.workspace_selection.is_empty() {
            return Err(invalid("workspace selection is empty"));
        }
        let selection: BTreeSet<_> = self.workspace_selection.iter().copied().collect();
        if selection.len() != self.workspace_selection.len() {
            return Err(invalid("workspace selection contains duplicates"));
        }
        if !selection.contains(&self.selected_workspace_id) || !selection.is_subset(workspace_ids) {
            return Err(invalid("workspace selection is dangling or omits focus"));
        }
        check_limit(
            "workspace_pins",
            self.workspace_pins.len(),
            WORKSPACE_PIN_MAX_COUNT,
        )?;
        let pins: BTreeSet<_> = self.workspace_pins.iter().copied().collect();
        if pins.len() != self.workspace_pins.len() || !pins.is_subset(workspace_ids) {
            return Err(invalid("workspace pins contain duplicates or dangling IDs"));
        }
        check_limit(
            "workspace_groups",
            self.workspace_groups.len(),
            WORKSPACE_GROUP_MAX_COUNT,
        )?;
        let mut group_ids = BTreeSet::new();
        let mut orders = BTreeSet::new();
        for group in &self.workspace_groups {
            group.validate()?;
            if !group_ids.insert(group.id) {
                return Err(DomainError::DuplicateId {
                    entity: "workspace_group",
                    id: group.id.to_string(),
                });
            }
            if !orders.insert(group.order) {
                return Err(invalid("workspace group orders are not unique"));
            }
        }
        check_limit(
            "workspace_group_assignments",
            self.workspace_group_assignments.len(),
            GROUP_ASSIGNMENT_MAX_COUNT,
        )?;
        if self
            .workspace_group_assignments
            .keys()
            .any(|id| !workspace_ids.contains(id))
            || self
                .workspace_group_assignments
                .values()
                .any(|id| !group_ids.contains(id))
        {
            return Err(invalid("workspace group assignment is dangling"));
        }
        check_limit("saved_layouts", self.saved_layouts.len(), LAYOUT_MAX_COUNT)?;
        let mut layout_ids = BTreeSet::<LayoutId>::new();
        for layout in &self.saved_layouts {
            if !layout_ids.insert(layout.id) {
                return Err(DomainError::DuplicateId {
                    entity: "saved_layout",
                    id: layout.id.to_string(),
                });
            }
            layout.validate()?;
        }
        Ok(())
    }

    fn validate_notifications(&self) -> Result<(), DomainError> {
        if self.notifications.len() > crate::NOTIFICATION_RETENTION_CAP {
            return Err(invalid(format!(
                "notification history exceeds its {} record retention cap",
                crate::NOTIFICATION_RETENTION_CAP
            )));
        }
        let mut ids = BTreeSet::<NotificationId>::new();
        for notification in &self.notifications {
            if !ids.insert(notification.id) {
                return Err(DomainError::DuplicateId {
                    entity: "notification",
                    id: notification.id.to_string(),
                });
            }
            // Targets are deliberately not revalidated here: an entity can be moved or closed
            // after a notification was published without invalidating durable history.
            notification.validate()?;
        }
        Ok(())
    }

    /// Validates a full loaded snapshot and physical shortcut conflicts for a platform.
    ///
    /// # Errors
    /// Returns the first structural, field, or platform-specific shortcut violation.
    pub fn validate_for_platform(&self, platform: ShortcutPlatform) -> Result<(), DomainError> {
        self.validate()?;
        self.validate_shortcut_overrides_for(platform)
    }

    /// Validates that active overrides have no logical-shortcut conflict.
    ///
    /// # Errors
    /// Returns an error when an override is malformed or conflicts with another command.
    pub fn validate_shortcut_overrides(&self) -> Result<(), DomainError> {
        let mut used = BTreeMap::<LogicalShortcut, CommandId>::new();
        let effective = self.effective_shortcut_bindings()?;
        for (command, shortcut) in &self.shortcut_overrides {
            validate_normalized_text("command_id", command.as_str(), MAX_NAME_CHARS, false)?;
            if !command.has_valid_characters() {
                return Err(DomainError::InvalidCommandId {
                    value: command.as_str().to_owned(),
                });
            }
            if let Some(shortcut) = shortcut {
                validate_normalized_text("shortcut", shortcut.as_str(), MAX_SHORTCUT_CHARS, false)?;
                if normalize_logical_shortcut(shortcut.as_str())? != shortcut.as_str() {
                    return Err(invalid("shortcut is not in canonical logical form"));
                }
            }
        }
        for (command, shortcut) in effective {
            if let Some(first) = used.insert(shortcut, command.clone()) {
                return Err(DomainError::ShortcutConflict {
                    first,
                    second: command,
                });
            }
        }
        Ok(())
    }

    /// Returns the complete effective command bindings after applying overrides and clears.
    ///
    /// # Errors
    /// Returns an error if a persisted command or shortcut is malformed.
    pub fn effective_shortcut_bindings(
        &self,
    ) -> Result<BTreeMap<CommandId, LogicalShortcut>, DomainError> {
        let mut effective = default_shortcut_bindings();
        for (command, shortcut) in &self.shortcut_overrides {
            validate_normalized_text("command_id", command.as_str(), MAX_NAME_CHARS, false)?;
            if !command.has_valid_characters() {
                return Err(DomainError::InvalidCommandId {
                    value: command.as_str().to_owned(),
                });
            }
            match shortcut {
                Some(shortcut) => {
                    validate_normalized_text(
                        "shortcut",
                        shortcut.as_str(),
                        MAX_SHORTCUT_CHARS,
                        false,
                    )?;
                    if normalize_logical_shortcut(shortcut.as_str())? != shortcut.as_str() {
                        return Err(invalid("shortcut is not in canonical logical form"));
                    }
                    effective.insert(command.clone(), shortcut.clone());
                }
                None => {
                    effective.remove(command);
                }
            }
        }
        Ok(effective)
    }

    /// Validates override conflicts after mapping logical modifiers to a platform.
    ///
    /// On non-macOS platforms, `Primary` and `Control` both map to physical Ctrl.
    /// On macOS, `Primary` maps to Command/Meta and remains distinct from Control.
    ///
    /// # Errors
    /// Returns an error for a malformed chord or two active physical conflicts.
    pub fn validate_shortcut_overrides_for(
        &self,
        platform: ShortcutPlatform,
    ) -> Result<(), DomainError> {
        let mut used = BTreeMap::<String, CommandId>::new();
        for (command, shortcut) in self.effective_shortcut_bindings()? {
            let physical = physical_shortcut_key(shortcut.as_str(), platform)?;
            if let Some(first) = used.insert(physical, command.clone()) {
                return Err(DomainError::ShortcutConflict {
                    first,
                    second: command,
                });
            }
        }
        Ok(())
    }

    /// Inserts and selects a caller-created browser tab in an existing pane.
    ///
    /// # Errors
    /// Returns an error when the workspace or pane is missing, the tab is not a valid browser
    /// tab for the pane, its identity already exists, or the insertion index is out of bounds.
    #[allow(clippy::needless_pass_by_value)]
    pub fn open_browser_tab(
        &mut self,
        workspace_id: WorkspaceId,
        pane_id: PaneId,
        index: usize,
        tab: Tab,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.commit_browser_mutation(|state| {
            let workspace = state
                .workspaces
                .iter_mut()
                .find(|workspace| workspace.id == workspace_id)
                .ok_or(DomainError::WorkspaceNotFound { id: workspace_id })?;
            let pane = workspace
                .panes
                .get(&pane_id)
                .ok_or(DomainError::PaneNotFound { id: pane_id })?;
            if tab.pane_id != pane_id {
                return Err(DomainError::TabPaneMismatch {
                    tab: tab.id,
                    expected: pane_id,
                    actual: tab.pane_id,
                });
            }
            if !matches!(tab.content, TabContent::Browser { .. }) {
                return Err(invalid(
                    "new browser tab does not contain a browser session",
                ));
            }
            if workspace.tabs.contains_key(&tab.id) {
                return Err(DomainError::DuplicateId {
                    entity: "tab",
                    id: tab.id.to_string(),
                });
            }
            if index > pane.tabs.len() {
                return Err(DomainError::IndexOutOfBounds {
                    index,
                    len: pane.tabs.len(),
                });
            }
            let tab_id = tab.id;
            workspace.tabs.insert(tab_id, tab);
            let pane = workspace
                .panes
                .get_mut(&pane_id)
                .ok_or(DomainError::PaneNotFound { id: pane_id })?;
            pane.tabs.insert(index, tab_id);
            pane.selected_tab_id = tab_id;
            workspace.selected_pane_id = pane_id;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    /// Commits a desired navigation after validating workspace, tab, session, and revision.
    ///
    /// # Errors
    /// Returns an error when browser ownership does not match, the expected revision is stale,
    /// or the URL or correlation identifier violates browser safety invariants.
    #[allow(clippy::too_many_arguments)]
    pub fn navigate_browser(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        browser_session_id: Uuid,
        expected_state_revision: u64,
        url: &str,
        correlation_id: &str,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.mutate_browser(
            workspace_id,
            tab_id,
            browser_session_id,
            updated_at,
            |metadata| metadata.navigate(url, expected_state_revision, correlation_id),
        )
    }

    /// Commits a non-URL browser action after optimistic revision validation.
    ///
    /// # Errors
    /// Returns an error when browser ownership does not match, the expected revision is stale,
    /// the action is unavailable, or the correlation identifier is invalid.
    #[allow(clippy::too_many_arguments)]
    pub fn request_browser_action(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        browser_session_id: Uuid,
        action: BrowserAction,
        expected_state_revision: u64,
        correlation_id: &str,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.mutate_browser(
            workspace_id,
            tab_id,
            browser_session_id,
            updated_at,
            |metadata| metadata.request_action(action, expected_state_revision, correlation_id),
        )
    }

    /// Applies a newer live-view observation and rejects stale or mis-correlated state.
    ///
    /// # Errors
    /// Returns an error when browser ownership does not match, the observation is stale, or any
    /// observed URL, title, correlation, revision, or timestamp violates domain invariants.
    #[allow(clippy::fn_params_excessive_bools, clippy::too_many_arguments)]
    pub fn update_browser_observation(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        browser_session_id: Uuid,
        observed_state_revision: u64,
        url: &str,
        navigation_title: &str,
        can_back: bool,
        can_forward: bool,
        loading: bool,
        dev_tools_open: bool,
        correlation_id: Option<&str>,
        updated_at: Timestamp,
    ) -> Result<MutationOutcome, DomainError> {
        self.mutate_browser(
            workspace_id,
            tab_id,
            browser_session_id,
            updated_at,
            |metadata| {
                metadata.apply_observation(
                    observed_state_revision,
                    url,
                    navigation_title,
                    can_back,
                    can_forward,
                    loading,
                    dev_tools_open,
                    correlation_id,
                )
            },
        )
    }

    fn mutate_browser(
        &mut self,
        workspace_id: WorkspaceId,
        tab_id: TabId,
        browser_session_id: Uuid,
        updated_at: Timestamp,
        mutation: impl FnOnce(&mut BrowserMetadata) -> Result<(), DomainError>,
    ) -> Result<MutationOutcome, DomainError> {
        self.commit_browser_mutation(|state| {
            let workspace = state
                .workspaces
                .iter_mut()
                .find(|workspace| workspace.id == workspace_id)
                .ok_or(DomainError::WorkspaceNotFound { id: workspace_id })?;
            let tab = workspace
                .tabs
                .get_mut(&tab_id)
                .ok_or(DomainError::TabNotFound { id: tab_id })?;
            let TabContent::Browser { metadata } = &mut tab.content else {
                return Err(invalid("tab does not contain a browser session"));
            };
            if metadata.browser_session_id != browser_session_id {
                return Err(invalid(
                    "browser session does not belong to the requested tab",
                ));
            }
            mutation(metadata)?;
            workspace.updated_at = updated_at;
            Ok(())
        })
    }

    fn commit_browser_mutation(
        &mut self,
        mutation: impl FnOnce(&mut Self) -> Result<(), DomainError>,
    ) -> Result<MutationOutcome, DomainError> {
        let mut candidate = self.clone();
        mutation(&mut candidate)?;
        candidate.validate()?;
        let revision = self
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or(DomainError::RevisionOverflow)?;
        candidate.revision = revision;
        *self = candidate;
        Ok(MutationOutcome {
            revision,
            terminal_launches: Vec::new(),
            terminal_sessions_to_terminate: Vec::new(),
        })
    }
}

/// Returns the authoritative built-in shortcut bindings as validated domain values.
///
/// # Panics
/// Panics only if a compile-time built-in command or shortcut constant violates the domain
/// grammar. Tests validate the complete catalog.
#[must_use]
pub fn default_shortcut_bindings() -> BTreeMap<CommandId, LogicalShortcut> {
    DEFAULT_SHORTCUT_CATALOG
        .iter()
        .map(|binding| {
            (
                CommandId::new(binding.command_id)
                    .expect("built-in command IDs are valid domain constants"),
                LogicalShortcut::new(binding.shortcut)
                    .expect("built-in shortcuts are valid domain constants"),
            )
        })
        .collect()
}

pub(crate) fn checked_text(
    field: &'static str,
    value: &str,
    max: usize,
    allow_empty: bool,
) -> Result<String, DomainError> {
    let value = trim_ecmascript_whitespace(value);
    if !allow_empty && value.is_empty() {
        return Err(DomainError::EmptyText { field });
    }
    if value.chars().count() > max {
        return Err(DomainError::TextTooLong { field, max });
    }
    Ok(value.to_owned())
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(is_ecmascript_trim_whitespace)
}

fn is_ecmascript_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub(crate) fn validate_timestamp(field: &'static str, value: Timestamp) -> Result<(), DomainError> {
    if value.0 > MAX_SAFE_INTEGER {
        return Err(DomainError::TimestampOutOfRange {
            field,
            value: value.0,
        });
    }
    Ok(())
}

pub(crate) fn validate_normalized_text(
    field: &'static str,
    value: &str,
    max: usize,
    allow_empty: bool,
) -> Result<(), DomainError> {
    let normalized = checked_text(field, value, max, allow_empty)?;
    if normalized != value {
        return Err(invalid(format!("{field} is not trimmed")));
    }
    Ok(())
}

fn physical_shortcut_key(value: &str, platform: ShortcutPlatform) -> Result<String, DomainError> {
    let normalized = normalize_logical_shortcut(value)?;
    let mut tokens = Vec::new();
    for token in normalized.split('+') {
        let token = match token {
            "PRIMARY" | "Primary" if platform == ShortcutPlatform::MacOs => "META".to_owned(),
            "Primary" | "Control" => "CONTROL".to_owned(),
            "Secondary" => "ALT".to_owned(),
            "Shift" => "SHIFT".to_owned(),
            other => other.to_ascii_uppercase(),
        };
        tokens.push(token);
    }
    tokens.sort();
    tokens.dedup();
    Ok(tokens.join("+"))
}

fn normalize_logical_shortcut(value: &str) -> Result<String, DomainError> {
    const MODIFIER_ORDER: [&str; 4] = ["Primary", "Secondary", "Control", "Shift"];

    let parts: Vec<_> = value.split('+').map(trim_ecmascript_whitespace).collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(DomainError::InvalidShortcut {
            value: value.to_owned(),
        });
    }
    let mut modifiers = BTreeSet::new();
    for part in &parts[..parts.len() - 1] {
        let modifier = match part.to_ascii_lowercase().as_str() {
            "primary" => "Primary",
            "secondary" | "option" | "alt" => "Secondary",
            "control" | "ctrl" => "Control",
            "shift" => "Shift",
            _ => {
                return Err(DomainError::InvalidShortcut {
                    value: value.to_owned(),
                });
            }
        };
        if !modifiers.insert(modifier) {
            return Err(DomainError::InvalidShortcut {
                value: value.to_owned(),
            });
        }
    }
    if matches!(
        parts
            .last()
            .expect("a shortcut contains at least two parts")
            .to_ascii_lowercase()
            .as_str(),
        "primary" | "secondary" | "option" | "alt" | "control" | "ctrl" | "shift"
    ) {
        return Err(DomainError::InvalidShortcut {
            value: value.to_owned(),
        });
    }
    let key =
        normalize_shortcut_key(parts.last().expect("shortcut key exists")).ok_or_else(|| {
            DomainError::InvalidShortcut {
                value: value.to_owned(),
            }
        })?;
    let mut normalized: Vec<_> = MODIFIER_ORDER
        .into_iter()
        .filter(|modifier| modifiers.contains(modifier))
        .map(str::to_owned)
        .collect();
    normalized.push(key);
    Ok(normalized.join("+"))
}

fn normalize_shortcut_key(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let alias = match lower.as_str() {
        " " | "spacebar" => Some("Space"),
        "esc" => Some("Escape"),
        "return" => Some("Enter"),
        "del" => Some("Delete"),
        "left" => Some("ArrowLeft"),
        "right" => Some("ArrowRight"),
        "up" => Some("ArrowUp"),
        "down" => Some("ArrowDown"),
        "," => Some("Comma"),
        "." => Some("Period"),
        "/" => Some("Slash"),
        "\\" => Some("Backslash"),
        ";" => Some("Semicolon"),
        "'" => Some("Quote"),
        "[" => Some("BracketLeft"),
        "]" => Some("BracketRight"),
        "-" => Some("Minus"),
        "=" => Some("Equal"),
        "`" => Some("Backquote"),
        _ => None,
    };
    if let Some(alias) = alias {
        return Some(alias.to_owned());
    }
    if value.len() == 1 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Some(value.to_ascii_uppercase());
    }
    if let Some(number) = lower
        .strip_prefix('f')
        .and_then(|value| value.parse::<u8>().ok())
        && (1..=24).contains(&number)
    {
        return Some(format!("F{number}"));
    }
    [
        "Backspace",
        "Tab",
        "Enter",
        "Escape",
        "Space",
        "Delete",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Comma",
        "Period",
        "Slash",
        "Backslash",
        "Semicolon",
        "Quote",
        "BracketLeft",
        "BracketRight",
        "Minus",
        "Equal",
        "Backquote",
    ]
    .into_iter()
    .find(|candidate| candidate.eq_ignore_ascii_case(value))
    .map(str::to_owned)
}

pub(crate) fn clamped_ratio(value: f64) -> Result<f64, DomainError> {
    if !value.is_finite() {
        return Err(DomainError::NonFiniteRatio);
    }
    canonical_ratio(value.clamp(0.05, 0.95))
}

fn canonical_ratio(value: f64) -> Result<f64, DomainError> {
    if !value.is_finite() {
        return Err(DomainError::NonFiniteRatio);
    }
    Ok((value * RATIO_SCALE).round() / RATIO_SCALE)
}

fn deserialize_ratio<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let ratio = f64::deserialize(deserializer)?;
    if !ratio.is_finite() || !(0.05..=0.95).contains(&ratio) {
        return Err(serde::de::Error::custom(
            "split ratio must be finite and within 0.05..=0.95",
        ));
    }
    canonical_ratio(ratio).map_err(serde::de::Error::custom)
}

pub(crate) fn checked_browser_url(value: &str) -> Result<String, DomainError> {
    let value = checked_text("browser.url", value, MAX_URL_CHARS, false)?;
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
        || value.contains('\\')
    {
        return Err(DomainError::UnsafeBrowserUrl);
    }
    let (scheme, remainder) = value
        .split_once("://")
        .ok_or(DomainError::UnsafeBrowserUrl)?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(DomainError::UnsafeBrowserUrl);
    }
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    validate_browser_authority(authority)?;
    Ok(format!("{}://{remainder}", scheme.to_ascii_lowercase()))
}

fn checked_browser_partition(value: &str) -> Result<(), DomainError> {
    validate_normalized_text(
        "browser.profile_partition",
        value,
        MAX_BROWSER_PARTITION_CHARS,
        false,
    )?;
    if !value.starts_with("persist:")
        || value.len() == "persist:".len()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(invalid("browser profile partition is unsafe"));
    }
    Ok(())
}

fn checked_browser_correlation(value: &str) -> Result<(), DomainError> {
    validate_normalized_text(
        "browser.correlation_id",
        value,
        MAX_BROWSER_CORRELATION_CHARS,
        false,
    )?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(invalid("browser correlation ID is unsafe"));
    }
    Ok(())
}

fn validate_browser_authority(authority: &str) -> Result<(), DomainError> {
    if authority.is_empty() || authority.contains(['@', '%']) {
        return Err(DomainError::UnsafeBrowserUrl);
    }
    let port = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, suffix) = bracketed
            .split_once(']')
            .ok_or(DomainError::UnsafeBrowserUrl)?;
        if host.is_empty()
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || matches!(byte, b':' | b'.'))
        {
            return Err(DomainError::UnsafeBrowserUrl);
        }
        if suffix.is_empty() {
            None
        } else {
            Some(
                suffix
                    .strip_prefix(':')
                    .ok_or(DomainError::UnsafeBrowserUrl)?,
            )
        }
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        if host.is_empty()
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err(DomainError::UnsafeBrowserUrl);
        }
        port
    };
    if let Some(port) = port
        && (port.is_empty()
            || !port.bytes().all(|byte| byte.is_ascii_digit())
            || port
                .parse::<u16>()
                .ok()
                .as_ref()
                .is_none_or(|port| *port == 0))
    {
        return Err(DomainError::UnsafeBrowserUrl);
    }
    Ok(())
}

pub(crate) fn invalid(message: impl Into<String>) -> DomainError {
    DomainError::InvalidState {
        message: message.into(),
    }
}

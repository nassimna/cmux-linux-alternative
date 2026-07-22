use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! persistent_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(
            Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// Creates an ID from an existing UUID.
            #[must_use]
            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            /// Generates a random ID.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            /// Returns the underlying UUID.
            #[must_use]
            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

persistent_id!(WorkspaceId, "Opaque persistent workspace identity.");
persistent_id!(PaneId, "Opaque persistent pane identity.");
persistent_id!(SplitId, "Opaque persistent split identity.");
persistent_id!(TabId, "Opaque persistent tab identity.");
persistent_id!(NotificationId, "Opaque persistent notification identity.");
persistent_id!(GroupId, "Opaque persistent workspace-group identity.");
persistent_id!(LayoutId, "Opaque persistent saved-layout identity.");
persistent_id!(
    WindowId,
    "Opaque persistent desktop-window placement identity."
);
persistent_id!(
    ClosedItemId,
    "Opaque persistent recently-closed item identity."
);

/// Runtime-only PTY session identity.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RuntimeSessionId(String);

impl RuntimeSessionId {
    /// Wraps an identity allocated by the terminal runtime.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Returns the runtime identity string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RuntimeSessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Stable command identity used by keyboard shortcut overrides.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct CommandId(pub(crate) String);

impl CommandId {
    /// Returns the command identity.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn has_valid_characters(&self) -> bool {
        self.0
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    }
}

impl fmt::Display for CommandId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

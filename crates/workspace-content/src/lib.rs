#![allow(clippy::missing_errors_doc)]
//! Capability-style, descriptor-relative access to authorized workspace text.

use agent_workspace_protocol::{
    AuthorizedDocumentKind, ContentChunk, OpaqueDocumentRef, SafeMarkdownNode,
    WorkspaceDirectoryEntry, WorkspaceDirectoryListResult, WorkspaceEntryKind,
    WorkspaceRootDescriptor, WorkspaceRootListResult,
};
use rustix::fs::{self as rfs, AtFlags, Mode, OFlags, RenameFlags, ResolveFlags};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::{Read, Write},
    os::fd::AsRawFd,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_AUTHORIZED_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_SAVE_BYTES: usize = 256 * 1024;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_AUTHORIZED_ROOTS: usize = 64;
pub const MAX_ENTRY_DESCRIPTORS: usize = 8_192;
pub const MAX_DOCUMENT_DESCRIPTORS: usize = 4_096;
pub const MAX_DIRECTORY_SCAN_ENTRIES: usize = 4_096;
pub const DIRECTORY_SCAN_DEADLINE: Duration = Duration::from_millis(500);
/// Fixed limits for a user-requested workspace search rebuild. These are deliberately lower
/// than the general content-preview limits so one low-priority crawl cannot monopolize the
/// service or the encrypted index.
pub const MAX_INDEX_ENUMERATION_DEPTH: usize = 16;
pub const MAX_INDEX_ENUMERATION_FILES: usize = 1_024;
pub const MAX_INDEX_ENUMERATION_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_INDEX_ENUMERATION_QUEUE: usize = 2_048;
pub const MAX_INDEX_ENUMERATION_ENTRIES: usize = 8_192;
pub const INDEX_ENUMERATION_DEADLINE: Duration = Duration::from_secs(2);
pub const MAX_INDEXABLE_FILE_BYTES: u64 = MAX_CHUNK_BYTES as u64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceIndexDocument {
    pub document: OpaqueDocumentRef,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceIndexEnumeration {
    pub documents: Vec<WorkspaceIndexDocument>,
    /// True means the returned prefix is safe to index, but a declared resource bound stopped
    /// the traversal before the authorized root was exhausted.
    pub partial: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Identity {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}
#[derive(Debug)]
struct Root {
    directory: File,
    source_path: PathBuf,
    workspace_id: Uuid,
    label: String,
    identity: (u64, u64),
    generation: u64,
    directory_descriptor_id: Uuid,
}
#[derive(Clone, Debug)]
struct EntryDescriptor {
    root_id: Uuid,
    relative: PathBuf,
    identity: EntryIdentity,
    generation: u64,
    kind: WorkspaceEntryKind,
    label: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EntryIdentity {
    Directory((u64, u64)),
    File(Identity),
}
#[derive(Clone, Debug)]
struct Document {
    root_id: Uuid,
    relative: PathBuf,
    identity: Identity,
    identity_version: u64,
    content_revision: u64,
    display_name: String,
}
#[derive(Debug, Error, Eq, PartialEq)]
pub enum ContentError {
    #[error("unauthorized document")]
    Unauthorized,
    #[error("invalid workspace path")]
    InvalidPath,
    #[error("filesystem object is unsafe")]
    UnsafeObject,
    #[error("filesystem identity changed")]
    IdentityChanged,
    #[error("content is oversized")]
    Oversized,
    #[error("content is not UTF-8")]
    UnsupportedEncoding,
    #[error("content revision conflict")]
    Conflict,
    #[error("I/O failure")]
    Io,
    #[error("resource limit reached")]
    ResourceLimit,
    #[error("operation cancelled")]
    Cancelled,
}
#[derive(Default)]
pub struct WorkspacePathProvider {
    roots: HashMap<Uuid, Root>,
    entries: HashMap<Uuid, EntryDescriptor>,
    documents: HashMap<Uuid, Document>,
    next_generation: u64,
}

impl WorkspacePathProvider {
    pub fn authorize_root(&mut self, path: &Path) -> Result<Uuid, ContentError> {
        self.authorize_workspace_root(Uuid::new_v4(), path, "Workspace")
    }

    pub fn authorize_workspace_root(
        &mut self,
        workspace_id: Uuid,
        path: &Path,
        label: &str,
    ) -> Result<Uuid, ContentError> {
        if !path.is_absolute() {
            return Err(ContentError::InvalidPath);
        }
        let directory = open_absolute_no_symlinks(path, OFlags::RDONLY | OFlags::DIRECTORY)?;
        let meta = directory
            .metadata()
            .map_err(|_| ContentError::InvalidPath)?;
        if !meta.is_dir() {
            return Err(ContentError::UnsafeObject);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != rustix::process::getuid().as_raw() {
                return Err(ContentError::UnsafeObject);
            }
        }
        let identity = directory_identity(&directory)?;
        // Workspace identity is already opaque on the wire and remains stable across restarts,
        // so it also anchors durable per-root search consent.
        let id = workspace_id;
        let directory_descriptor_id = Uuid::new_v4();
        let generation = self.allocate_generation()?;
        self.roots.insert(
            id,
            Root {
                directory,
                source_path: path.to_owned(),
                workspace_id,
                label: bounded_label(label)?,
                identity,
                generation,
                directory_descriptor_id,
            },
        );
        self.entries.insert(
            directory_descriptor_id,
            EntryDescriptor {
                root_id: id,
                relative: PathBuf::from("."),
                identity: EntryIdentity::Directory(identity),
                generation,
                kind: WorkspaceEntryKind::Directory,
                label: bounded_label(label)?,
            },
        );
        Ok(id)
    }

    /// Replaces the authorized root set from the authoritative runtime snapshot.
    /// Existing descriptors survive only while workspace, path identity, and label agree.
    pub fn sync_workspace_roots(
        &mut self,
        desired: &[(Uuid, PathBuf, String)],
    ) -> Result<(), ContentError> {
        if desired.len() > MAX_AUTHORIZED_ROOTS {
            self.revoke_all();
            return Err(ContentError::ResourceLimit);
        }
        let desired_ids = desired.iter().map(|(id, _, _)| *id).collect::<Vec<_>>();
        let revoked = self
            .roots
            .iter()
            .filter_map(|(root_id, root)| {
                (!desired_ids.contains(&root.workspace_id)).then_some(*root_id)
            })
            .collect::<Vec<_>>();
        for id in revoked {
            self.revoke_root(id);
        }
        for (workspace_id, path, label) in desired {
            let current = self.roots.iter().find_map(|(id, root)| {
                (root.workspace_id == *workspace_id).then_some((
                    *id,
                    root.source_path.clone(),
                    root.identity,
                    root.label.clone(),
                ))
            });
            if let Some((root_id, old_path, old_identity, old_label)) = current {
                if old_path != *path || old_label != *label {
                    self.revoke_root(root_id);
                } else {
                    let opened =
                        match open_absolute_no_symlinks(path, OFlags::RDONLY | OFlags::DIRECTORY) {
                            Ok(opened) => opened,
                            Err(error) => {
                                self.revoke_root(root_id);
                                return Err(error);
                            }
                        };
                    match directory_identity(&opened) {
                        Ok(identity) if identity == old_identity => continue,
                        Ok(_) => self.revoke_root(root_id),
                        Err(error) => {
                            self.revoke_root(root_id);
                            return Err(error);
                        }
                    }
                }
            }
            // A prior authority has been revoked before replacement is attempted.
            self.authorize_workspace_root(*workspace_id, path, label)?;
        }
        Ok(())
    }

    pub fn list_roots(
        &self,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<WorkspaceRootListResult, ContentError> {
        let mut roots = self
            .roots
            .iter()
            .map(|(root_id, root)| WorkspaceRootDescriptor {
                root_id: root_id.to_string(),
                directory_descriptor_id: root.directory_descriptor_id.to_string(),
                workspace_id: root.workspace_id.to_string(),
                label: root.label.clone(),
                generation: root.generation,
            })
            .collect::<Vec<_>>();
        roots.sort_by(|a, b| a.root_id.cmp(&b.root_id));
        if let Some(cursor) = cursor {
            roots.retain(|root| root.root_id > cursor.to_string());
        }
        let has_more = roots.len() > usize::from(limit);
        roots.truncate(usize::from(limit));
        let next_cursor = has_more
            .then(|| roots.last().map(|root| root.root_id.clone()))
            .flatten();
        Ok(WorkspaceRootListResult { roots, next_cursor })
    }

    pub fn list_directory(
        &mut self,
        descriptor_id: Uuid,
        generation: u64,
        cursor: Option<Uuid>,
        limit: u16,
    ) -> Result<WorkspaceDirectoryListResult, ContentError> {
        self.list_directory_with_cancel(descriptor_id, generation, cursor, limit, || false)
    }

    #[allow(clippy::too_many_lines)]
    pub fn list_directory_with_cancel<F: Fn() -> bool>(
        &mut self,
        descriptor_id: Uuid,
        generation: u64,
        cursor: Option<Uuid>,
        limit: u16,
        cancelled: F,
    ) -> Result<WorkspaceDirectoryListResult, ContentError> {
        let deadline = Instant::now() + DIRECTORY_SCAN_DEADLINE;
        let descriptor = self
            .entries
            .get(&descriptor_id)
            .cloned()
            .ok_or(ContentError::Unauthorized)?;
        if descriptor.generation != generation || descriptor.kind != WorkspaceEntryKind::Directory {
            return Err(ContentError::IdentityChanged);
        }
        let root = self
            .roots
            .get(&descriptor.root_id)
            .ok_or(ContentError::Unauthorized)?;
        if root.generation != generation {
            return Err(ContentError::IdentityChanged);
        }
        let directory = open_beneath(
            &root.directory,
            &descriptor.relative,
            OFlags::RDONLY | OFlags::DIRECTORY,
        )?;
        if EntryIdentity::Directory(directory_identity(&directory)?) != descriptor.identity {
            return Err(ContentError::IdentityChanged);
        }
        let proc_path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        let mut names = Vec::new();
        for item in std::fs::read_dir(proc_path).map_err(|_| ContentError::Io)? {
            if cancelled() {
                return Err(ContentError::Cancelled);
            }
            if names.len() >= MAX_DIRECTORY_SCAN_ENTRIES || Instant::now() >= deadline {
                return Err(ContentError::ResourceLimit);
            }
            let item = item.map_err(|_| ContentError::Io)?;
            let name = item.file_name();
            let label = name.to_str().ok_or(ContentError::InvalidPath)?.to_owned();
            if label.is_empty()
                || label.chars().any(char::is_control)
                || label.chars().count() > 256
            {
                continue;
            }
            names.push((name, label));
        }
        names.sort_by(|a, b| a.1.cmp(&b.1));
        let mut candidates = Vec::new();
        let mut new_descriptors = Vec::new();
        for (name, label) in names {
            if cancelled() {
                return Err(ContentError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(ContentError::ResourceLimit);
            }
            let relative = if descriptor.relative == Path::new(".") {
                PathBuf::from(&name)
            } else {
                descriptor.relative.join(&name)
            };
            let Ok(opened) = open_beneath(&root.directory, &relative, OFlags::RDONLY) else {
                continue;
            };
            let metadata = opened.metadata().map_err(|_| ContentError::Io)?;
            let (kind, identity) = if metadata.is_dir() {
                (
                    WorkspaceEntryKind::Directory,
                    EntryIdentity::Directory(directory_identity(&opened)?),
                )
            } else if metadata.is_file() {
                match identity_file(&opened) {
                    Ok(identity) => (WorkspaceEntryKind::File, EntryIdentity::File(identity)),
                    Err(_) => continue,
                }
            } else {
                continue;
            };
            let existing = self.entries.iter().find_map(|(id, candidate)| {
                (candidate.root_id == descriptor.root_id
                    && candidate.relative == relative
                    && candidate.generation == generation
                    && candidate.identity == identity
                    && candidate.kind == kind)
                    .then_some(*id)
            });
            let id = existing.unwrap_or_else(Uuid::new_v4);
            if existing.is_none() {
                new_descriptors.push((
                    id,
                    EntryDescriptor {
                        root_id: descriptor.root_id,
                        relative,
                        identity,
                        generation,
                        kind,
                        label: label.clone(),
                    },
                ));
            }
            candidates.push(WorkspaceDirectoryEntry {
                entry_descriptor_id: id.to_string(),
                kind,
                label,
                generation,
            });
        }
        if self.entries.len().saturating_add(new_descriptors.len()) > MAX_ENTRY_DESCRIPTORS {
            self.revoke_entry_descriptors();
            return Err(ContentError::ResourceLimit);
        }
        self.entries.extend(new_descriptors);
        let mut discovered = candidates;
        if let Some(cursor) = cursor {
            let cursor = cursor.to_string();
            let position = discovered
                .iter()
                .position(|entry| entry.entry_descriptor_id == cursor)
                .ok_or(ContentError::IdentityChanged)?;
            discovered.drain(..=position);
        }
        let has_more = discovered.len() > usize::from(limit);
        discovered.truncate(usize::from(limit));
        let next_cursor = has_more
            .then(|| {
                discovered
                    .last()
                    .map(|entry| entry.entry_descriptor_id.clone())
            })
            .flatten();
        Ok(WorkspaceDirectoryListResult {
            entries: discovered,
            next_cursor,
        })
    }

    pub fn issue_document_from_descriptor(
        &mut self,
        descriptor_id: Uuid,
        generation: u64,
        expected_kind: AuthorizedDocumentKind,
    ) -> Result<(OpaqueDocumentRef, String), ContentError> {
        let descriptor = self
            .entries
            .get(&descriptor_id)
            .cloned()
            .ok_or(ContentError::Unauthorized)?;
        if descriptor.generation != generation || descriptor.kind != WorkspaceEntryKind::File {
            return Err(ContentError::IdentityChanged);
        }
        if matches!(expected_kind, AuthorizedDocumentKind::Markdown)
            && !matches!(
                descriptor
                    .relative
                    .extension()
                    .and_then(|value| value.to_str()),
                Some("md" | "markdown")
            )
        {
            return Err(ContentError::InvalidPath);
        }
        let root = self
            .roots
            .get(&descriptor.root_id)
            .ok_or(ContentError::Unauthorized)?;
        if root.generation != generation {
            return Err(ContentError::IdentityChanged);
        }
        let opened = open_beneath(&root.directory, &descriptor.relative, OFlags::RDONLY)?;
        if EntryIdentity::File(identity_file(&opened)?) != descriptor.identity {
            return Err(ContentError::IdentityChanged);
        }
        let document = self.issue_document(descriptor.root_id, &descriptor.relative)?;
        Ok((document, descriptor.label))
    }

    pub fn revoke_root(&mut self, id: Uuid) {
        self.roots.remove(&id);
        self.entries.retain(|_, entry| entry.root_id != id);
        self.documents.retain(|_, d| d.root_id != id);
    }
    pub fn revoke_all(&mut self) {
        self.roots.clear();
        self.entries.clear();
        self.documents.clear();
    }
    fn revoke_entry_descriptors(&mut self) {
        let roots = self
            .roots
            .values()
            .map(|root| root.directory_descriptor_id)
            .collect::<Vec<_>>();
        self.entries.retain(|id, _| roots.contains(id));
    }
    #[must_use]
    pub fn has_root(&self, id: Uuid) -> bool {
        self.roots.contains_key(&id)
    }

    #[must_use]
    pub fn root_generations(&self) -> Vec<(Uuid, u64)> {
        let mut roots = self
            .roots
            .iter()
            .map(|(id, root)| (*id, root.generation))
            .collect::<Vec<_>>();
        roots.sort_by_key(|(id, _)| *id);
        roots
    }

    pub fn documents_for_root(
        &self,
        root_id: Uuid,
    ) -> Result<Vec<OpaqueDocumentRef>, ContentError> {
        if !self.roots.contains_key(&root_id) {
            return Err(ContentError::Unauthorized);
        }
        let mut documents = self
            .documents
            .iter()
            .filter(|(_, document)| document.root_id == root_id)
            .map(|(id, document)| OpaqueDocumentRef {
                document_id: id.to_string(),
                identity_version: document.identity_version,
            })
            .collect::<Vec<_>>();
        documents.sort_by(|a, b| a.document_id.cmp(&b.document_id));
        Ok(documents)
    }

    /// Enumerates an authorized root without accepting or returning a filesystem path. Directory
    /// names come from an already-authorized descriptor and every child is opened again through
    /// `openat2(RESOLVE_BENEATH | NO_SYMLINKS | NO_MAGICLINKS)` before use. Unsupported, hidden,
    /// linked, special, oversized, and non-UTF-8 files are excluded by the closed indexing policy.
    #[allow(clippy::too_many_lines)]
    pub fn enumerate_index_documents_with_cancel<F: Fn() -> bool>(
        &mut self,
        root_id: Uuid,
        cancelled: F,
    ) -> Result<WorkspaceIndexEnumeration, ContentError> {
        let deadline = Instant::now() + INDEX_ENUMERATION_DEADLINE;
        let root = self.roots.get(&root_id).ok_or(ContentError::Unauthorized)?;
        if directory_identity(&root.directory)? != root.identity {
            return Err(ContentError::IdentityChanged);
        }
        let root_directory = root.directory.try_clone().map_err(|_| ContentError::Io)?;
        let mut queue = VecDeque::from([(PathBuf::from("."), 0_usize, root.identity)]);
        let mut visited_directories = HashSet::from([root.identity]);
        let mut visited_files = HashSet::new();
        let mut documents = Vec::new();
        let mut scanned_entries = 0_usize;
        let mut indexed_bytes = 0_u64;
        let mut partial = false;

        'directories: while let Some((directory_relative, depth, expected_identity)) =
            queue.pop_front()
        {
            if cancelled() {
                return Err(ContentError::Cancelled);
            }
            if Instant::now() >= deadline {
                partial = true;
                break;
            }
            let directory = open_beneath(
                &root_directory,
                &directory_relative,
                OFlags::RDONLY | OFlags::DIRECTORY,
            )?;
            if directory_identity(&directory)? != expected_identity {
                return Err(ContentError::IdentityChanged);
            }
            let proc_path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
            let mut names = Vec::new();
            for item in std::fs::read_dir(proc_path).map_err(|_| ContentError::Io)? {
                if cancelled() {
                    return Err(ContentError::Cancelled);
                }
                if scanned_entries >= MAX_INDEX_ENUMERATION_ENTRIES || Instant::now() >= deadline {
                    partial = true;
                    break;
                }
                scanned_entries += 1;
                let Ok(item) = item else {
                    continue;
                };
                let name = item.file_name();
                let Some(label) = name.to_str() else {
                    continue;
                };
                if should_ignore_index_name(label) {
                    continue;
                }
                names.push(name);
            }
            names.sort();
            if partial {
                break;
            }

            for name in names {
                if cancelled() {
                    return Err(ContentError::Cancelled);
                }
                if Instant::now() >= deadline {
                    partial = true;
                    break;
                }
                let relative = if directory_relative == Path::new(".") {
                    PathBuf::from(&name)
                } else {
                    directory_relative.join(&name)
                };
                let Ok(opened) = open_beneath(&root_directory, &relative, OFlags::RDONLY) else {
                    continue;
                };
                let Ok(metadata) = opened.metadata() else {
                    continue;
                };
                if metadata.is_dir() {
                    if depth >= MAX_INDEX_ENUMERATION_DEPTH {
                        partial = true;
                        continue;
                    }
                    let Ok(identity) = directory_identity(&opened) else {
                        continue;
                    };
                    if visited_directories.insert(identity) {
                        if queue.len() >= MAX_INDEX_ENUMERATION_QUEUE {
                            partial = true;
                        } else {
                            queue.push_back((relative, depth + 1, identity));
                        }
                    }
                    continue;
                }
                if !metadata.is_file() || metadata.len() > MAX_INDEXABLE_FILE_BYTES {
                    continue;
                }
                let Ok(identity) = identity_file(&opened) else {
                    continue;
                };
                if !visited_files.insert((identity.device, identity.inode)) {
                    continue;
                }
                if documents.len() >= MAX_INDEX_ENUMERATION_FILES
                    || indexed_bytes.saturating_add(identity.size) > MAX_INDEX_ENUMERATION_BYTES
                {
                    partial = true;
                    break 'directories;
                }
                let mut bytes = Vec::with_capacity(usize::try_from(identity.size).unwrap_or(0));
                let reader = opened.try_clone().map_err(|_| ContentError::Io)?;
                reader
                    .take(MAX_INDEXABLE_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| ContentError::Io)?;
                if bytes.len() as u64 != identity.size
                    || identity_file(&opened).ok() != Some(identity)
                {
                    return Err(ContentError::IdentityChanged);
                }
                let Ok(text) = String::from_utf8(bytes) else {
                    continue;
                };
                let document = self.issue_document_checked(root_id, &relative, identity)?;
                indexed_bytes = indexed_bytes.saturating_add(identity.size);
                documents.push(WorkspaceIndexDocument { document, text });
                if documents.len() % 32 == 0 {
                    std::thread::yield_now();
                }
            }
            if partial && (Instant::now() >= deadline || queue.len() >= MAX_INDEX_ENUMERATION_QUEUE)
            {
                break;
            }
        }
        Ok(WorkspaceIndexEnumeration { documents, partial })
    }

    pub fn issue_document(
        &mut self,
        root_id: Uuid,
        relative: &Path,
    ) -> Result<OpaqueDocumentRef, ContentError> {
        validate_relative(relative)?;
        let root = self.roots.get(&root_id).ok_or(ContentError::Unauthorized)?;
        let file = open_beneath(&root.directory, relative, OFlags::RDONLY)?;
        let identity = identity_file(&file)?;
        self.issue_document_checked(root_id, relative, identity)
    }

    fn issue_document_checked(
        &mut self,
        root_id: Uuid,
        relative: &Path,
        identity: Identity,
    ) -> Result<OpaqueDocumentRef, ContentError> {
        if let Some((id, document)) = self.documents.iter().find(|(_, document)| {
            document.root_id == root_id
                && document.relative == relative
                && document.identity == identity
        }) {
            return Ok(OpaqueDocumentRef {
                document_id: id.to_string(),
                identity_version: document.identity_version,
            });
        }
        if self.documents.len() >= MAX_DOCUMENT_DESCRIPTORS {
            return Err(ContentError::ResourceLimit);
        }
        let display_name = relative
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or(ContentError::InvalidPath)?
            .to_owned();
        let id = Uuid::new_v4();
        self.documents.insert(
            id,
            Document {
                root_id,
                relative: relative.to_owned(),
                identity,
                identity_version: 1,
                content_revision: 1,
                display_name,
            },
        );
        Ok(OpaqueDocumentRef {
            document_id: id.to_string(),
            identity_version: 1,
        })
    }
    pub fn read_chunk(
        &self,
        reference: &OpaqueDocumentRef,
        offset: u64,
        max_bytes: usize,
    ) -> Result<ContentChunk, ContentError> {
        if max_bytes == 0 || max_bytes > MAX_CHUNK_BYTES {
            return Err(ContentError::Oversized);
        }
        let (id, doc) = self.document(reference)?;
        let root = &self
            .roots
            .get(&doc.root_id)
            .ok_or(ContentError::Unauthorized)?
            .directory;
        let file = open_beneath(root, &doc.relative, OFlags::RDONLY)?;
        validate_open(&file, doc.identity)?;
        let mut bytes = Vec::new();
        file.take(MAX_AUTHORIZED_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ContentError::Io)?;
        if bytes.len() as u64 > MAX_AUTHORIZED_FILE_BYTES {
            return Err(ContentError::Oversized);
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| ContentError::UnsupportedEncoding)?;
        let start = usize::try_from(offset).map_err(|_| ContentError::Oversized)?;
        if start > text.len() || !text.is_char_boundary(start) {
            return Err(ContentError::InvalidPath);
        }
        let mut end = (start + max_bytes).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(ContentChunk {
            document: OpaqueDocumentRef {
                document_id: id.to_string(),
                identity_version: doc.identity_version,
            },
            offset,
            text: text[start..end].to_owned(),
            eof: end == text.len(),
            content_revision: doc.content_revision,
            display_name: doc.display_name.clone(),
        })
    }

    /// Returns the bounded display label bound to an exact opaque document generation.
    ///
    /// # Errors
    /// Returns the same authorization or stale-identity error as other document operations.
    pub fn document_display_name(
        &self,
        reference: &OpaqueDocumentRef,
    ) -> Result<String, ContentError> {
        let (_, document) = self.document(reference)?;
        Ok(document.display_name.clone())
    }

    /// Revalidates authorization and filesystem identity without returning content.
    pub fn revalidate(&self, reference: &OpaqueDocumentRef) -> Result<(), ContentError> {
        let (_, document) = self.document(reference)?;
        let root = &self
            .roots
            .get(&document.root_id)
            .ok_or(ContentError::Unauthorized)?
            .directory;
        let file = open_beneath(root, &document.relative, OFlags::RDONLY)?;
        validate_open(&file, document.identity)
    }
    pub fn save(
        &mut self,
        reference: &OpaqueDocumentRef,
        expected_revision: u64,
        text: &str,
    ) -> Result<u64, ContentError> {
        self.save_with_hook(reference, expected_revision, text, || {})
    }
    #[allow(clippy::too_many_lines)]
    fn save_with_hook<F: FnOnce()>(
        &mut self,
        reference: &OpaqueDocumentRef,
        expected_revision: u64,
        text: &str,
        hook: F,
    ) -> Result<u64, ContentError> {
        if text.len() > MAX_SAVE_BYTES {
            return Err(ContentError::Oversized);
        }
        let id = Uuid::parse_str(&reference.document_id).map_err(|_| ContentError::Unauthorized)?;
        let doc = self
            .documents
            .get(&id)
            .ok_or(ContentError::Unauthorized)?
            .clone();
        if doc.identity_version != reference.identity_version
            || doc.content_revision != expected_revision
        {
            return Err(ContentError::Conflict);
        }
        let root = self
            .roots
            .get(&doc.root_id)
            .ok_or(ContentError::Unauthorized)?
            .directory
            .try_clone()
            .map_err(|_| ContentError::Io)?;
        let target = open_beneath(&root, &doc.relative, OFlags::RDONLY)?;
        let original = identity_file(&target)?;
        let original_fingerprint = file_fingerprint(&target)?;
        if original != doc.identity {
            return Err(ContentError::IdentityChanged);
        }
        let parent_relative = doc
            .relative
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent = open_beneath(&root, parent_relative, OFlags::RDONLY | OFlags::DIRECTORY)?;
        let parent_identity = directory_identity(&parent)?;
        let temporary = format!(".agent-workspace-save-{}", Uuid::new_v4());
        let mut out = File::from(
            rfs::openat(
                &parent,
                &temporary,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|_| ContentError::Io)?,
        );
        out.write_all(text.as_bytes())
            .and_then(|()| out.sync_all())
            .map_err(|_| ContentError::Io)?;
        drop(out);
        hook();
        let result = (|| {
            let current_parent =
                open_beneath(&root, parent_relative, OFlags::RDONLY | OFlags::DIRECTORY)?;
            if directory_identity(&current_parent)? != parent_identity {
                return Err(ContentError::IdentityChanged);
            }
            let name = doc.relative.file_name().ok_or(ContentError::InvalidPath)?;
            rfs::renameat_with(
                &parent,
                &temporary,
                &current_parent,
                name,
                RenameFlags::EXCHANGE,
            )
            .map_err(|_| ContentError::Io)?;
            let swapped_out = open_beneath(&parent, Path::new(&temporary), OFlags::RDONLY)?;
            let swapped_identity = identity_file(&swapped_out)?;
            if !same_file_after_exchange(swapped_identity, original)
                || file_fingerprint(&swapped_out)? != original_fingerprint
            {
                rfs::renameat_with(
                    &parent,
                    &temporary,
                    &current_parent,
                    name,
                    RenameFlags::EXCHANGE,
                )
                .map_err(|_| ContentError::Io)?;
                return Err(ContentError::IdentityChanged);
            }
            drop(swapped_out);
            rfs::unlinkat(&parent, &temporary, AtFlags::empty()).map_err(|_| ContentError::Io)?;
            current_parent.sync_all().map_err(|_| ContentError::Io)?;
            let new_file = open_beneath(&current_parent, Path::new(name), OFlags::RDONLY)?;
            let record = self
                .documents
                .get_mut(&id)
                .ok_or(ContentError::Unauthorized)?;
            record.identity = identity_file(&new_file)?;
            record.identity_version = record
                .identity_version
                .checked_add(1)
                .ok_or(ContentError::Conflict)?;
            record.content_revision = record
                .content_revision
                .checked_add(1)
                .ok_or(ContentError::Conflict)?;
            Ok(record.content_revision)
        })();
        if result.is_err() {
            let _ = rfs::unlinkat(&parent, &temporary, AtFlags::empty());
        }
        result
    }
    fn document(&self, reference: &OpaqueDocumentRef) -> Result<(Uuid, &Document), ContentError> {
        let id = Uuid::parse_str(&reference.document_id).map_err(|_| ContentError::Unauthorized)?;
        let doc = self.documents.get(&id).ok_or(ContentError::Unauthorized)?;
        if doc.identity_version != reference.identity_version {
            return Err(ContentError::IdentityChanged);
        }
        Ok((id, doc))
    }

    fn allocate_generation(&mut self) -> Result<u64, ContentError> {
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .ok_or(ContentError::Conflict)?;
        Ok(self.next_generation)
    }
}

fn should_ignore_index_name(name: &str) -> bool {
    name.is_empty()
        || name.starts_with('.')
        || name.chars().any(char::is_control)
        || name.chars().count() > 256
        || matches!(name, "node_modules" | "target" | "vendor")
}

fn bounded_label(label: &str) -> Result<String, ContentError> {
    (!label.trim().is_empty()
        && label.chars().count() <= 256
        && !label.chars().any(char::is_control))
    .then(|| label.to_owned())
    .ok_or(ContentError::InvalidPath)
}

fn validate_relative(path: &Path) -> Result<(), ContentError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        Err(ContentError::InvalidPath)
    } else {
        Ok(())
    }
}
fn open_beneath(root: &File, path: &Path, flags: OFlags) -> Result<File, ContentError> {
    #[cfg(target_os = "linux")]
    {
        rfs::openat2(
            root,
            path,
            flags | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )
        .map(File::from)
        .map_err(|_| ContentError::UnsafeObject)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, path, flags);
        Err(ContentError::UnsafeObject)
    }
}
fn open_absolute_no_symlinks(path: &Path, flags: OFlags) -> Result<File, ContentError> {
    #[cfg(target_os = "linux")]
    {
        let slash = File::from(
            rfs::open(
                "/",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| ContentError::UnsafeObject)?,
        );
        let relative = path
            .strip_prefix("/")
            .map_err(|_| ContentError::InvalidPath)?;
        open_beneath(&slash, relative, flags)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (path, flags);
        Err(ContentError::UnsafeObject)
    }
}
fn identity_file(file: &File) -> Result<Identity, ContentError> {
    let m = file.metadata().map_err(|_| ContentError::Io)?;
    if !m.is_file() || m.len() > MAX_AUTHORIZED_FILE_BYTES {
        return Err(ContentError::UnsafeObject);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.nlink() != 1 {
            return Err(ContentError::UnsafeObject);
        }
        Ok(Identity {
            device: m.dev(),
            inode: m.ino(),
            size: m.len(),
            modified_seconds: m.mtime(),
            modified_nanoseconds: m.mtime_nsec(),
            changed_seconds: m.ctime(),
            changed_nanoseconds: m.ctime_nsec(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(Identity {
            device: 0,
            inode: 0,
            size: m.len(),
            modified_seconds: 0,
            modified_nanoseconds: 0,
            changed_seconds: 0,
            changed_nanoseconds: 0,
        })
    }
}
fn validate_open(file: &File, expected: Identity) -> Result<(), ContentError> {
    (identity_file(file)? == expected)
        .then_some(())
        .ok_or(ContentError::IdentityChanged)
}
fn same_file_after_exchange(actual: Identity, expected: Identity) -> bool {
    actual.device == expected.device
        && actual.inode == expected.inode
        && actual.size == expected.size
        && actual.modified_seconds == expected.modified_seconds
        && actual.modified_nanoseconds == expected.modified_nanoseconds
}
fn file_fingerprint(file: &File) -> Result<blake3::Hash, ContentError> {
    let mut reader = file.try_clone().map_err(|_| ContentError::Io)?;
    let mut hasher = blake3::Hasher::new();
    let copied = std::io::copy(&mut reader, &mut hasher).map_err(|_| ContentError::Io)?;
    if copied > MAX_AUTHORIZED_FILE_BYTES {
        return Err(ContentError::Oversized);
    }
    Ok(hasher.finalize())
}
fn directory_identity(file: &File) -> Result<(u64, u64), ContentError> {
    let m = file.metadata().map_err(|_| ContentError::Io)?;
    if !m.is_dir() {
        return Err(ContentError::UnsafeObject);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok((0, 0))
    }
}

#[must_use]
pub fn parse_safe_markdown(source: &str) -> Vec<SafeMarkdownNode> {
    let mut nodes = Vec::new();
    let mut lines = source.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("```") {
            let language =
                (!rest.trim().is_empty()).then(|| rest.trim().chars().take(32).collect());
            let mut text = String::new();
            for row in lines.by_ref() {
                if row == "```" {
                    break;
                }
                if !text.is_empty() {
                    text.push('\n');
                }
                text.extend(row.chars().take(16_384));
            }
            nodes.push(SafeMarkdownNode::CodeBlock { language, text });
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && line.as_bytes().get(hashes) == Some(&b' ') {
            nodes.push(SafeMarkdownNode::Heading {
                level: u8::try_from(hashes).unwrap_or(u8::MAX),
                children: inline_nodes(&line[hashes + 1..]),
            });
        } else if let Some(item) = line.strip_prefix("- ") {
            nodes.push(SafeMarkdownNode::List {
                ordered: false,
                items: vec![SafeMarkdownNode::ListItem {
                    children: inline_nodes(item),
                }],
            });
        } else if !line.trim().is_empty() {
            nodes.push(SafeMarkdownNode::Paragraph {
                children: inline_nodes(line),
            });
        }
        if nodes.len() >= 4096 {
            break;
        }
    }
    nodes
}
fn inline_nodes(text: &str) -> Vec<SafeMarkdownNode> {
    let bounded: String = text.chars().take(16_384).collect();
    if bounded.contains('<') || bounded.contains('>') {
        return vec![SafeMarkdownNode::Text { text: bounded }];
    }
    if let (Some(a), Some(b), Some(c), Some(d)) = (
        bounded.find('['),
        bounded.find("]("),
        bounded.rfind(')'),
        bounded.find("http"),
    ) && a < b
        && b < c
        && d == b + 2
    {
        let href = &bounded[d..c];
        if href.starts_with("https://") || href.starts_with("http://") {
            return vec![SafeMarkdownNode::Link {
                label: bounded[a + 1..b].to_owned(),
                href: href.to_owned(),
            }];
        }
    }
    vec![SafeMarkdownNode::Text { text: bounded }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;
    #[test]
    fn traversal_symlink_hardlink_and_special_fail_closed() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("ok"), "safe").unwrap();
        fs::write(d.path().join("outside"), "secret").unwrap();
        symlink(d.path().join("outside"), root.join("link")).unwrap();
        fs::hard_link(root.join("ok"), root.join("hard")).unwrap();
        fs::create_dir(root.join("directory")).unwrap();
        let mut p = WorkspacePathProvider::default();
        let r = p.authorize_root(&root).unwrap();
        assert_eq!(
            p.issue_document(r, Path::new("../outside")),
            Err(ContentError::InvalidPath)
        );
        assert_eq!(
            p.issue_document(r, Path::new("link")),
            Err(ContentError::UnsafeObject)
        );
        assert_eq!(
            p.issue_document(r, Path::new("hard")),
            Err(ContentError::UnsafeObject)
        );
        assert_eq!(
            p.issue_document(r, Path::new("directory")),
            Err(ContentError::UnsafeObject)
        );
    }
    #[test]
    fn root_authorization_rejects_symlinked_ancestry() {
        let d = tempdir().unwrap();
        let actual = d.path().join("actual");
        fs::create_dir(&actual).unwrap();
        let alias = d.path().join("alias");
        symlink(&actual, &alias).unwrap();
        let nested = alias.join("nested");
        fs::create_dir(actual.join("nested")).unwrap();
        let mut provider = WorkspacePathProvider::default();
        assert_eq!(
            provider.authorize_root(&nested),
            Err(ContentError::UnsafeObject)
        );
        assert!(provider.authorize_root(&actual).is_ok());
    }
    #[test]
    fn chunks_and_atomic_cas_are_bounded() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), "hello 🦀").unwrap();
        let mut p = WorkspacePathProvider::default();
        let r = p.authorize_root(&root).unwrap();
        let doc = p.issue_document(r, Path::new("a")).unwrap();
        assert_eq!(p.read_chunk(&doc, 0, 7).unwrap().text, "hello ");
        assert_eq!(p.save(&doc, 2, "x"), Err(ContentError::Conflict));
        assert_eq!(p.save(&doc, 1, "new").unwrap(), 2);
    }
    #[test]
    fn target_and_parent_replacement_races_are_rejected() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        let parent = root.join("p");
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("a");
        fs::write(&path, "old").unwrap();
        let mut p = WorkspacePathProvider::default();
        let r = p.authorize_root(&root).unwrap();
        let doc = p.issue_document(r, Path::new("p/a")).unwrap();
        let result = p.save_with_hook(&doc, 1, "new", || {
            fs::remove_file(&path).unwrap();
            fs::write(&path, "attacker").unwrap();
        });
        assert_eq!(result, Err(ContentError::IdentityChanged));
        assert_eq!(fs::read_to_string(&path).unwrap(), "attacker");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        let doc = p.issue_document(r, Path::new("p/a")).unwrap();
        let moved = root.join("moved");
        let result = p.save_with_hook(&doc, 1, "new", || {
            fs::rename(&parent, &moved).unwrap();
            fs::create_dir(&parent).unwrap();
            fs::write(parent.join("a"), "substitute").unwrap();
        });
        assert_eq!(result, Err(ContentError::IdentityChanged));
        assert_eq!(fs::read_to_string(parent.join("a")).unwrap(), "substitute");
    }
    #[test]
    fn same_size_in_place_mutation_breaks_cas() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        let path = root.join("a");
        fs::write(&path, "old").unwrap();
        let mut provider = WorkspacePathProvider::default();
        let root_id = provider.authorize_root(&root).unwrap();
        let document = provider.issue_document(root_id, Path::new("a")).unwrap();
        let result = provider.save_with_hook(&document, 1, "new", || {
            fs::write(&path, "bad").unwrap();
        });
        assert_eq!(result, Err(ContentError::IdentityChanged));
        assert_eq!(fs::read_to_string(path).unwrap(), "bad");
    }

    #[test]
    fn search_open_revalidation_rejects_replaced_identity() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("root");
        fs::create_dir(&root).unwrap();
        let path = root.join("indexed");
        fs::write(&path, "indexed text").unwrap();
        let mut provider = WorkspacePathProvider::default();
        let root_id = provider.authorize_root(&root).unwrap();
        let document = provider
            .issue_document(root_id, Path::new("indexed"))
            .unwrap();
        assert_eq!(provider.revalidate(&document), Ok(()));
        fs::remove_file(&path).unwrap();
        fs::write(&path, "replacement").unwrap();
        assert_eq!(
            provider.revalidate(&document),
            Err(ContentError::IdentityChanged)
        );
    }
    #[test]
    fn markdown_html_and_remote_embeds_are_inert() {
        let ast = parse_safe_markdown("# hi\n<script>alert(1)</script>\n![x](https://evil/x.png)");
        let debug = format!("{ast:?}");
        assert!(!debug.contains("Image"));
        assert!(debug.contains("<script>"));
    }

    #[test]
    fn huge_directories_and_descriptor_growth_are_bounded() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        for index in 0..=MAX_DIRECTORY_SCAN_ENTRIES {
            fs::write(root.join(format!("f-{index:05}")), "x").unwrap();
        }
        let mut provider = WorkspacePathProvider::default();
        provider
            .authorize_workspace_root(Uuid::new_v4(), &root, "root")
            .unwrap();
        let descriptor = provider.list_roots(None, 1).unwrap().roots.remove(0);
        assert_eq!(
            provider.list_directory(
                Uuid::parse_str(&descriptor.directory_descriptor_id).unwrap(),
                descriptor.generation,
                None,
                10,
            ),
            Err(ContentError::ResourceLimit)
        );

        fs::remove_dir_all(&root).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("one"), "x").unwrap();
        provider.revoke_all();
        provider
            .authorize_workspace_root(Uuid::new_v4(), &root, "root")
            .unwrap();
        let descriptor = provider.list_roots(None, 1).unwrap().roots.remove(0);
        let root_id = Uuid::parse_str(&descriptor.root_id).unwrap();
        for _ in provider.entries.len()..MAX_ENTRY_DESCRIPTORS {
            provider.entries.insert(
                Uuid::new_v4(),
                EntryDescriptor {
                    root_id,
                    relative: PathBuf::from("missing"),
                    identity: EntryIdentity::Directory((0, 0)),
                    generation: descriptor.generation,
                    kind: WorkspaceEntryKind::Directory,
                    label: "bounded".into(),
                },
            );
        }
        assert_eq!(
            provider.list_directory(
                Uuid::parse_str(&descriptor.directory_descriptor_id).unwrap(),
                descriptor.generation,
                None,
                1,
            ),
            Err(ContentError::ResourceLimit)
        );
        assert_eq!(provider.entries.len(), 1);
        assert_eq!(
            provider
                .list_directory(
                    Uuid::parse_str(&descriptor.directory_descriptor_id).unwrap(),
                    descriptor.generation,
                    None,
                    1,
                )
                .unwrap()
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn authoritative_root_replacement_failure_revokes_old_descriptors() {
        let d = tempdir().unwrap();
        let old = d.path().join("old");
        let actual = d.path().join("actual");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&actual).unwrap();
        fs::write(old.join("secret"), "old").unwrap();
        let workspace_id = Uuid::new_v4();
        let mut provider = WorkspacePathProvider::default();
        provider
            .sync_workspace_roots(&[(workspace_id, old.clone(), "root".into())])
            .unwrap();
        let old_descriptor = provider.list_roots(None, 1).unwrap().roots.remove(0);
        let alias = d.path().join("alias");
        symlink(&actual, &alias).unwrap();
        assert_eq!(
            provider.sync_workspace_roots(&[(workspace_id, alias, "root".into())]),
            Err(ContentError::UnsafeObject)
        );
        assert!(provider.list_roots(None, 1).unwrap().roots.is_empty());
        assert_eq!(
            provider.list_directory(
                Uuid::parse_str(&old_descriptor.directory_descriptor_id).unwrap(),
                old_descriptor.generation,
                None,
                1,
            ),
            Err(ContentError::Unauthorized)
        );
    }

    #[test]
    fn restart_keeps_source_identity_stable_without_aliasing_document_capabilities() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("document"), "safe").unwrap();
        let workspace_id = Uuid::new_v4();
        let mut first = WorkspacePathProvider::default();
        let first_root = first
            .authorize_workspace_root(workspace_id, &root, "root")
            .unwrap();
        let stale = first
            .issue_document(first_root, Path::new("document"))
            .unwrap();

        let mut restarted = WorkspacePathProvider::default();
        let restarted_root = restarted
            .authorize_workspace_root(workspace_id, &root, "root")
            .unwrap();
        assert_eq!(first_root, restarted_root);
        assert_eq!(
            restarted.revalidate(&stale),
            Err(ContentError::Unauthorized)
        );
        let fresh = restarted
            .issue_document(restarted_root, Path::new("document"))
            .unwrap();
        assert_ne!(fresh.document_id, stale.document_id);
    }

    #[test]
    fn fresh_recursive_index_enumeration_finds_unopened_nested_text_only() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir_all(root.join("nested/deeper")).unwrap();
        fs::write(
            root.join("nested/deeper/unopened.txt"),
            "fresh nested needle",
        )
        .unwrap();
        fs::write(root.join(".hidden"), "hidden needle").unwrap();
        fs::write(root.join("binary"), [0xff, 0xfe, 0xfd]).unwrap();
        fs::write(root.join("linked-source"), "linked needle").unwrap();
        fs::hard_link(root.join("linked-source"), root.join("linked-copy")).unwrap();
        symlink(
            root.join("nested/deeper/unopened.txt"),
            root.join("symlink"),
        )
        .unwrap();
        let mut provider = WorkspacePathProvider::default();
        let root_id = provider.authorize_root(&root).unwrap();
        assert!(provider.documents_for_root(root_id).unwrap().is_empty());

        let result = provider
            .enumerate_index_documents_with_cancel(root_id, || false)
            .unwrap();
        assert!(!result.partial);
        assert_eq!(result.documents.len(), 1);
        assert_eq!(result.documents[0].text, "fresh nested needle");
        assert!(provider.revalidate(&result.documents[0].document).is_ok());
    }

    #[test]
    fn restart_can_reenumerate_authorized_root_without_old_document_capabilities() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/unopened.txt"), "restart needle").unwrap();
        let workspace_id = Uuid::new_v4();
        let mut first = WorkspacePathProvider::default();
        first
            .authorize_workspace_root(workspace_id, &root, "root")
            .unwrap();
        let first_document = first
            .enumerate_index_documents_with_cancel(workspace_id, || false)
            .unwrap()
            .documents
            .remove(0)
            .document;

        let mut restarted = WorkspacePathProvider::default();
        restarted
            .authorize_workspace_root(workspace_id, &root, "root")
            .unwrap();
        assert_eq!(
            restarted.revalidate(&first_document),
            Err(ContentError::Unauthorized)
        );
        let rebuilt = restarted
            .enumerate_index_documents_with_cancel(workspace_id, || false)
            .unwrap();
        assert_eq!(rebuilt.documents[0].text, "restart needle");
        assert_ne!(rebuilt.documents[0].document, first_document);
    }

    #[test]
    fn recursive_index_cancellation_and_depth_cap_are_bounded() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        let mut current = root.clone();
        for depth in 0..=MAX_INDEX_ENUMERATION_DEPTH {
            current = current.join(format!("level-{depth}"));
            fs::create_dir(&current).unwrap();
        }
        fs::write(current.join("too-deep"), "must not leak").unwrap();
        fs::write(root.join("visible"), "bounded needle").unwrap();
        let mut provider = WorkspacePathProvider::default();
        let root_id = provider.authorize_root(&root).unwrap();
        assert_eq!(
            provider.enumerate_index_documents_with_cancel(root_id, || true),
            Err(ContentError::Cancelled)
        );
        assert!(provider.documents_for_root(root_id).unwrap().is_empty());

        let started = Instant::now();
        let result = provider
            .enumerate_index_documents_with_cancel(root_id, || false)
            .unwrap();
        assert!(result.partial);
        assert!(started.elapsed() <= INDEX_ENUMERATION_DEADLINE + Duration::from_secs(1));
        assert!(
            result
                .documents
                .iter()
                .any(|item| item.text == "bounded needle")
        );
        assert!(
            result
                .documents
                .iter()
                .all(|item| item.text != "must not leak")
        );
    }

    #[test]
    fn replaced_or_removed_root_revokes_enumerated_capabilities() {
        let d = tempdir().unwrap();
        let old = d.path().join("old");
        let replacement = d.path().join("replacement");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&replacement).unwrap();
        fs::write(old.join("secret"), "old secret needle").unwrap();
        fs::write(replacement.join("public"), "replacement needle").unwrap();
        let workspace_id = Uuid::new_v4();
        let mut provider = WorkspacePathProvider::default();
        provider
            .sync_workspace_roots(&[(workspace_id, old, "root".into())])
            .unwrap();
        let old_document = provider
            .enumerate_index_documents_with_cancel(workspace_id, || false)
            .unwrap()
            .documents
            .remove(0)
            .document;

        provider
            .sync_workspace_roots(&[(workspace_id, replacement, "root".into())])
            .unwrap();
        assert_eq!(
            provider.revalidate(&old_document),
            Err(ContentError::Unauthorized)
        );
        let current = provider
            .enumerate_index_documents_with_cancel(workspace_id, || false)
            .unwrap();
        assert_eq!(current.documents.len(), 1);
        assert_eq!(current.documents[0].text, "replacement needle");

        provider.sync_workspace_roots(&[]).unwrap();
        assert_eq!(
            provider.enumerate_index_documents_with_cancel(workspace_id, || false),
            Err(ContentError::Unauthorized)
        );
    }

    #[test]
    fn changed_entries_make_old_cursors_explicitly_stale() {
        let d = tempdir().unwrap();
        let root = d.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a"), "one").unwrap();
        fs::write(root.join("b"), "two").unwrap();
        let mut provider = WorkspacePathProvider::default();
        provider.authorize_root(&root).unwrap();
        let descriptor = provider.list_roots(None, 1).unwrap().roots.remove(0);
        let directory_id = Uuid::parse_str(&descriptor.directory_descriptor_id).unwrap();
        let first = provider
            .list_directory(directory_id, descriptor.generation, None, 1)
            .unwrap();
        let cursor = Uuid::parse_str(first.next_cursor.as_deref().unwrap()).unwrap();
        let cursor_label = first.entries[0].label.clone();
        fs::remove_file(root.join(cursor_label)).unwrap();
        assert_eq!(
            provider.list_directory(directory_id, descriptor.generation, Some(cursor), 1,),
            Err(ContentError::IdentityChanged)
        );
        assert_eq!(
            provider.list_directory_with_cancel(
                directory_id,
                descriptor.generation,
                None,
                1,
                || true,
            ),
            Err(ContentError::Cancelled)
        );
    }
}

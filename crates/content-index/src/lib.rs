#![allow(clippy::missing_errors_doc)]
//! Separate, consent-gated encrypted content index.

use agent_workspace_agent_adapter::{AdapterError, CodexAdapter, CodexTranscriptRole};
#[cfg(target_os = "linux")]
use agent_workspace_protocol::{
    MAX_SEARCH_RESULTS, OpaqueDocumentRef, SearchResult, SearchSourceKind,
};
#[cfg(not(target_os = "linux"))]
use agent_workspace_protocol::{OpaqueDocumentRef, SearchResult, SearchSourceKind};
use async_trait::async_trait;
#[cfg(target_os = "linux")]
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
#[cfg(target_os = "linux")]
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
#[cfg(target_os = "linux")]
use rustix::fs::{self as rfs, Mode, OFlags, ResolveFlags};
#[cfg(target_os = "linux")]
use secret_service::{EncryptionType, SecretService};
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::{
    collections::{BTreeSet, HashSet, VecDeque},
    fmt,
    fs::File,
    io::{Read, Write},
    os::fd::AsRawFd,
    path::{Component, Path},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(not(target_os = "linux"))]
use std::{
    collections::{HashSet, VecDeque},
    fmt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const INDEX_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const INDEX_MAX_DOCUMENTS: u64 = 100_000;
pub const INDEX_MAX_TOKENS: u64 = 10_000_000;
pub const INDEX_RETENTION_DAYS: u64 = 365;
pub const INDEX_QUEUE_CAPACITY: usize = 256;
pub const INDEX_INTERACTIVE_BATCH: usize = 8;
const MAX_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS: usize = 10_000;
#[cfg(target_os = "linux")]
const PROFILE_KEY_ID_FILE: &str = "content-index-key-id";
#[cfg(target_os = "linux")]
const SECRET_SERVICE_APPLICATION: &str = "cmux-linux-alternative";
#[cfg(target_os = "linux")]
const SECRET_SERVICE_KIND: &str = "content-index-key-v1";
#[cfg(target_os = "linux")]
const SECRET_SERVICE_CONTENT_TYPE: &str = "application/octet-stream";
#[cfg(target_os = "linux")]
const EXPECTED_METADATA: &str = "CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), sentinel_nonce BLOB NOT NULL, sentinel_ciphertext BLOB NOT NULL)";
#[cfg(target_os = "linux")]
const EXPECTED_AUTHORIZATIONS: &str = "CREATE TABLE source_authorizations (authorization_id TEXT PRIMARY KEY CHECK(length(authorization_id)=36), excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), consented_at_ms INTEGER NOT NULL CHECK(consented_at_ms>=0), retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 365), ignore_nonce BLOB NOT NULL, ignore_ciphertext BLOB NOT NULL)";
#[cfg(target_os = "linux")]
const EXPECTED_DOCUMENTS: &str = "CREATE TABLE documents (id INTEGER PRIMARY KEY, authorization_id TEXT NOT NULL REFERENCES source_authorizations(authorization_id) ON DELETE CASCADE, identity_hash BLOB NOT NULL UNIQUE CHECK(length(identity_hash)=32), identity_version INTEGER NOT NULL CHECK(identity_version BETWEEN 1 AND 9007199254740991), document_nonce BLOB NOT NULL, document_ciphertext BLOB NOT NULL, snippet_nonce BLOB NOT NULL, snippet_ciphertext BLOB NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('workspaceFile','agentTranscript')), pinned INTEGER NOT NULL CHECK(pinned IN (0,1)), indexed_at_ms INTEGER NOT NULL)";
#[cfg(target_os = "linux")]
const EXPECTED_TOKENS: &str = "CREATE TABLE tokens (document_row INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, token_hash BLOB NOT NULL, UNIQUE(document_row,token_hash))";

/// A content-only request to one audited agent transcript provider. It deliberately contains no
/// filesystem location, generic provider name, or command string.
#[derive(Clone)]
pub struct TrustedTranscriptRequest {
    pub agent_session_id: Uuid,
    pub session_revision: u64,
    pub adapter: TranscriptAdapter,
    pub adapter_version: String,
    pub cancellation: Arc<AtomicBool>,
}

/// One provider-issued, process-local transcript document. Payload bytes are zeroized on drop and
/// cannot be formatted through `Debug`.
pub struct TrustedTranscriptDocument {
    pub document: OpaqueDocumentRef,
    pub payload: Zeroizing<Vec<u8>>,
}

pub struct TrustedTranscriptBatch {
    pub documents: Vec<TrustedTranscriptDocument>,
    pub partial: bool,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum TranscriptSourceError {
    #[error("trusted transcript source is unavailable")]
    Unavailable,
    #[error("trusted transcript request was cancelled")]
    Cancelled,
    #[error("trusted transcript format is unsupported")]
    UnsupportedFormat,
    #[error("trusted transcript resource limit reached")]
    ResourceLimit,
}

#[async_trait]
pub trait TrustedTranscriptSource: Send + Sync {
    async fn read_bounded(
        &self,
        request: TrustedTranscriptRequest,
    ) -> Result<TrustedTranscriptBatch, TranscriptSourceError>;
}

/// Production source backed only by the sealed, exact-version Codex app-server adapter. It reads
/// one explicitly consented thread UUID; it never probes a home directory or accepts a path.
#[derive(Clone, Copy, Debug, Default)]
pub struct CodexAppServerTranscriptSource;

#[derive(serde::Serialize)]
struct NormalizedRecord<'a> {
    role: &'static str,
    content: &'a str,
}

#[async_trait]
impl TrustedTranscriptSource for CodexAppServerTranscriptSource {
    async fn read_bounded(
        &self,
        request: TrustedTranscriptRequest,
    ) -> Result<TrustedTranscriptBatch, TranscriptSourceError> {
        if request.cancellation.load(Ordering::Relaxed) {
            return Err(TranscriptSourceError::Cancelled);
        }
        if request.adapter != TranscriptAdapter::CodexJsonlV1
            || request.adapter_version != "0.142.4"
        {
            return Err(TranscriptSourceError::UnsupportedFormat);
        }
        if request.session_revision == 0 {
            return Err(TranscriptSourceError::UnsupportedFormat);
        }
        let thread_id = request.agent_session_id;
        let revision = request.session_revision;
        let cancellation = Arc::clone(&request.cancellation);
        let transcript = tokio::task::spawn_blocking(move || {
            let adapter = CodexAdapter::discover()?;
            adapter.read_transcript(thread_id, &cancellation)
        })
        .await
        .map_err(|_| TranscriptSourceError::Unavailable)?
        .map_err(|error| transcript_adapter_error(error, &request.cancellation))?;
        let mut payload = Zeroizing::new(Vec::with_capacity(16 * 1024));
        payload.extend_from_slice(b"{\"format\":\"codex-transcript\",\"version\":1}\n");
        for message in &transcript.messages {
            if request.cancellation.load(Ordering::Relaxed) {
                return Err(TranscriptSourceError::Cancelled);
            }
            let role = match message.role {
                CodexTranscriptRole::User => "user",
                CodexTranscriptRole::Assistant => "assistant",
            };
            serde_json::to_writer(
                &mut *payload,
                &NormalizedRecord {
                    role,
                    content: &message.text,
                },
            )
            .map_err(|_| TranscriptSourceError::UnsupportedFormat)?;
            payload.push(b'\n');
            if payload.len() > MAX_TRANSCRIPT_BYTES {
                return Err(TranscriptSourceError::ResourceLimit);
            }
        }
        Ok(TrustedTranscriptBatch {
            documents: vec![TrustedTranscriptDocument {
                document: OpaqueDocumentRef {
                    document_id: thread_id.to_string(),
                    identity_version: revision,
                },
                payload,
            }],
            partial: transcript.skipped_items != 0,
        })
    }
}

fn transcript_adapter_error(
    error: AdapterError,
    cancellation: &AtomicBool,
) -> TranscriptSourceError {
    match error {
        AdapterError::Interrupted if cancellation.load(Ordering::Relaxed) => {
            TranscriptSourceError::Cancelled
        }
        AdapterError::ResourceLimit => TranscriptSourceError::ResourceLimit,
        AdapterError::UnsupportedAdapterVersion => TranscriptSourceError::UnsupportedFormat,
        _ => TranscriptSourceError::Unavailable,
    }
}

pub trait ProfileKeyProvider {
    /// Borrows the key only for the duration of the callback. Implementations never return a
    /// plain copied secret value.
    fn with_profile_key(&self, consumer: &mut dyn FnMut(&[u8; 32])) -> bool;
}

/// A profile index key held in zeroizing memory. Its debug representation is always redacted.
pub struct LoadedProfileKey(Zeroizing<[u8; 32]>);

impl fmt::Debug for LoadedProfileKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LoadedProfileKey([REDACTED])")
    }
}

impl ProfileKeyProvider for LoadedProfileKey {
    fn with_profile_key(&self, consumer: &mut dyn FnMut(&[u8; 32])) -> bool {
        consumer(&self.0);
        true
    }
}

/// Content-free reason that production key loading could not safely enable the index.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ProfileKeyLoadError {
    #[error("profile key storage is unavailable")]
    Unavailable,
    #[error("profile key locator storage is unsafe")]
    UnsafeStorage,
    #[error("profile key result is ambiguous")]
    Ambiguous,
    #[error("profile key has an invalid shape")]
    InvalidSecret,
}

/// Exact Secret Service query result. Secret bytes remain zeroizing and are never printable.
pub struct ProfileSecretMatches {
    pub unlocked: Vec<Zeroizing<Vec<u8>>>,
    pub locked: usize,
}

#[async_trait]
pub trait ProfileSecretStore: Send + Sync {
    async fn find_exact(&self, key_id: &str) -> Result<ProfileSecretMatches, ProfileKeyLoadError>;
    async fn create_exact(
        &self,
        key_id: &str,
        secret: &[u8; 32],
    ) -> Result<(), ProfileKeyLoadError>;
}

/// Production Secret Service implementation. It never unlocks collections or items.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Default)]
pub struct SecretServiceProfileSecretStore;

#[cfg(target_os = "linux")]
#[async_trait]
impl ProfileSecretStore for SecretServiceProfileSecretStore {
    async fn find_exact(&self, key_id: &str) -> Result<ProfileSecretMatches, ProfileKeyLoadError> {
        let service = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|_| ProfileKeyLoadError::Unavailable)?;
        let attributes = std::collections::HashMap::from([
            ("application", SECRET_SERVICE_APPLICATION),
            ("kind", SECRET_SERVICE_KIND),
            ("key-id", key_id),
        ]);
        let found = service
            .search_items(attributes)
            .await
            .map_err(|_| ProfileKeyLoadError::Unavailable)?;
        let mut unlocked = Vec::with_capacity(found.unlocked.len().min(2));
        for item in found.unlocked.into_iter().take(2) {
            unlocked.push(Zeroizing::new(
                item.get_secret()
                    .await
                    .map_err(|_| ProfileKeyLoadError::Unavailable)?,
            ));
        }
        Ok(ProfileSecretMatches {
            unlocked,
            locked: found.locked.len(),
        })
    }

    async fn create_exact(
        &self,
        key_id: &str,
        secret: &[u8; 32],
    ) -> Result<(), ProfileKeyLoadError> {
        let service = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|_| ProfileKeyLoadError::Unavailable)?;
        let collection = service
            .get_default_collection()
            .await
            .map_err(|_| ProfileKeyLoadError::Unavailable)?;
        if collection
            .is_locked()
            .await
            .map_err(|_| ProfileKeyLoadError::Unavailable)?
        {
            return Err(ProfileKeyLoadError::Unavailable);
        }
        let attributes = std::collections::HashMap::from([
            ("application", SECRET_SERVICE_APPLICATION),
            ("kind", SECRET_SERVICE_KIND),
            ("key-id", key_id),
        ]);
        collection
            .create_item(
                "Agent Workspace content index key",
                attributes,
                secret,
                false,
                SECRET_SERVICE_CONTENT_TYPE,
            )
            .await
            .map_err(|_| ProfileKeyLoadError::Unavailable)?;
        Ok(())
    }
}

/// Loads or creates a profile key using an owner-only stable opaque key-id file.
///
/// Existing unsafe locator storage, locked or duplicate items, and malformed secrets fail closed.
/// No index artifact is opened or mutated by this function.
#[cfg(target_os = "linux")]
pub async fn load_or_create_profile_key(
    profile: &Path,
) -> Result<LoadedProfileKey, ProfileKeyLoadError> {
    load_or_create_profile_key_with(profile, &SecretServiceProfileSecretStore).await
}

#[cfg(not(target_os = "linux"))]
pub async fn load_or_create_profile_key(
    _profile: &Path,
) -> Result<LoadedProfileKey, ProfileKeyLoadError> {
    Err(ProfileKeyLoadError::Unavailable)
}

pub async fn load_or_create_profile_key_with(
    profile: &Path,
    store: &dyn ProfileSecretStore,
) -> Result<LoadedProfileKey, ProfileKeyLoadError> {
    let key_id = load_or_create_key_id(profile)?;
    let found = store.find_exact(&key_id).await?;
    if found.locked != 0 || found.unlocked.len() > 1 {
        return Err(ProfileKeyLoadError::Ambiguous);
    }
    if let Some(secret) = found.unlocked.into_iter().next() {
        return loaded_key(&secret);
    }
    let mut generated = Zeroizing::new([0_u8; 32]);
    getrandom::getrandom(generated.as_mut()).map_err(|_| ProfileKeyLoadError::Unavailable)?;
    store.create_exact(&key_id, &generated).await?;
    let verified = store.find_exact(&key_id).await?;
    if verified.locked != 0 || verified.unlocked.len() != 1 {
        return Err(ProfileKeyLoadError::Ambiguous);
    }
    let secret = verified
        .unlocked
        .into_iter()
        .next()
        .ok_or(ProfileKeyLoadError::Ambiguous)?;
    loaded_key(&secret)
}

fn loaded_key(secret: &Zeroizing<Vec<u8>>) -> Result<LoadedProfileKey, ProfileKeyLoadError> {
    let key: [u8; 32] = secret
        .as_slice()
        .try_into()
        .map_err(|_| ProfileKeyLoadError::InvalidSecret)?;
    Ok(LoadedProfileKey(Zeroizing::new(key)))
}

#[cfg(target_os = "linux")]
fn load_or_create_key_id(profile: &Path) -> Result<String, ProfileKeyLoadError> {
    let directory = open_safe_profile_directory(profile)?;
    match rfs::openat2(
        &directory,
        PROFILE_KEY_ID_FILE,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    ) {
        Ok(fd) => {
            let key_id = Uuid::new_v4().to_string();
            let mut file = File::from(fd);
            file.write_all(key_id.as_bytes())
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.sync_all())
                .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
            validate_locator_file(&file)?;
            directory
                .sync_all()
                .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
            Ok(key_id)
        }
        Err(rustix::io::Errno::EXIST) => read_safe_key_id(&directory),
        Err(_) => Err(ProfileKeyLoadError::UnsafeStorage),
    }
}

#[cfg(target_os = "linux")]
fn open_safe_profile_directory(profile: &Path) -> Result<File, ProfileKeyLoadError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    if !profile.is_absolute()
        || std::fs::canonicalize(profile).ok().as_deref() != Some(profile)
        || profile
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ProfileKeyLoadError::UnsafeStorage);
    }
    let slash = File::from(
        rfs::open(
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?,
    );
    let relative = profile
        .strip_prefix("/")
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
    let directory = File::from(
        rfs::openat2(
            &slash,
            relative,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?,
    );
    let metadata = directory
        .metadata()
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(ProfileKeyLoadError::UnsafeStorage);
    }
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn validate_locator_file(file: &File) -> Result<(), ProfileKeyLoadError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    let metadata = file
        .metadata()
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.len() > 64
    {
        return Err(ProfileKeyLoadError::UnsafeStorage);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_safe_key_id(directory: &File) -> Result<String, ProfileKeyLoadError> {
    read_safe_key_id_with_hook(directory, || {})
}

#[cfg(target_os = "linux")]
fn read_safe_key_id_with_hook<F: FnOnce()>(
    directory: &File,
    hook: F,
) -> Result<String, ProfileKeyLoadError> {
    let file = File::from(
        rfs::openat2(
            directory,
            PROFILE_KEY_ID_FILE,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?,
    );
    validate_locator_file(&file)?;
    hook();
    let mut bytes = Vec::with_capacity(64);
    file.take(65)
        .read_to_end(&mut bytes)
        .map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
    let value = text.strip_suffix('\n').unwrap_or(text);
    Uuid::parse_str(value).map_err(|_| ProfileKeyLoadError::UnsafeStorage)?;
    Ok(value.to_owned())
}

#[cfg(not(target_os = "linux"))]
fn load_or_create_key_id(_profile: &Path) -> Result<String, ProfileKeyLoadError> {
    Err(ProfileKeyLoadError::Unavailable)
}

#[cfg(target_os = "linux")]
fn copy_profile_key(keys: &dyn ProfileKeyProvider) -> Option<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0_u8; 32]);
    let mut called = false;
    let available = keys.with_profile_key(&mut |source| {
        if !called {
            key.copy_from_slice(source);
            called = true;
        }
    });
    (available && called).then_some(key)
}

#[cfg(target_os = "linux")]
struct FixedKeyProvider(Zeroizing<[u8; 32]>);
#[cfg(target_os = "linux")]
impl ProfileKeyProvider for FixedKeyProvider {
    fn with_profile_key(&self, consumer: &mut dyn FnMut(&[u8; 32])) -> bool {
        consumer(&self.0);
        true
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IndexAvailability {
    Enabled,
    DisabledKeyringUnavailable,
}
#[derive(Debug, Error)]
pub enum IndexError {
    #[error("durable indexing disabled")]
    Disabled,
    #[error("source is not authorized")]
    Unauthorized,
    #[error("index capacity reached")]
    Capacity,
    #[error("invalid index database permissions or schema")]
    UnsafeDatabase,
    #[error("index database failure")]
    Database,
    #[error("encrypted index value is invalid")]
    Crypto,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexExportSummary {
    pub schema_version: u8,
    pub authorized_sources: usize,
    pub documents: u64,
    pub tokens: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct IndexBudget {
    pub max_bytes: usize,
    pub deadline: Instant,
}

#[cfg(target_os = "linux")]
pub struct ContentIndex {
    connection: Connection,
    directory: File,
    key: Zeroizing<[u8; 32]>,
    authorized: HashSet<Uuid>,
    excluded: HashSet<Uuid>,
}
#[cfg(target_os = "linux")]
impl ContentIndex {
    /// Preserves validated owner-only database artifacts under unique corruption names, then
    /// creates a fresh index. This is intentionally explicit; [`Self::open`] never destroys data.
    pub fn preserve_corrupt_and_rebuild(
        profile: &Path,
        keys: &dyn ProfileKeyProvider,
    ) -> Result<(IndexAvailability, Option<Self>), IndexError> {
        let Some(recovery_key) = copy_profile_key(keys) else {
            return Ok((IndexAvailability::DisabledKeyringUnavailable, None));
        };
        let recovery_key = FixedKeyProvider(recovery_key);
        let directory = prepare_index_directory(profile)?;
        let suffix = Uuid::new_v4();
        for name in ["search.sqlite3", "search.sqlite3-wal", "search.sqlite3-shm"] {
            if artifact_exists(&directory, name)? {
                secure_artifact_at(&directory, name)?;
                let preserved = format!("{name}.corrupt-{suffix}");
                rfs::renameat(&directory, name, &directory, preserved)
                    .map_err(|_| IndexError::UnsafeDatabase)?;
            }
        }
        directory
            .sync_all()
            .map_err(|_| IndexError::UnsafeDatabase)?;
        drop(directory);
        Self::open(profile, &recovery_key)
    }

    pub fn open(
        profile: &Path,
        keys: &dyn ProfileKeyProvider,
    ) -> Result<(IndexAvailability, Option<Self>), IndexError> {
        let Some(key) = copy_profile_key(keys) else {
            return Ok((IndexAvailability::DisabledKeyringUnavailable, None));
        };
        let directory = prepare_index_directory(profile)?;
        let sqlite_path = format!("/proc/self/fd/{}/search.sqlite3", directory.as_raw_fd());
        secure_artifacts_at(&directory)?;
        let connection = Connection::open_with_flags(
            &sqlite_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|_| IndexError::Database)?;
        secure_artifact_at(&directory, "search.sqlite3")?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .map_err(|_| IndexError::Database)?;
        for schema in [
            EXPECTED_METADATA,
            EXPECTED_AUTHORIZATIONS,
            EXPECTED_DOCUMENTS,
            EXPECTED_TOKENS,
        ] {
            connection
                .execute_batch(&format!(
                    "CREATE TABLE IF NOT EXISTS {}",
                    schema.trim_start_matches("CREATE TABLE ")
                ))
                .map_err(|_| IndexError::Database)?;
        }
        connection
            .execute_batch("CREATE INDEX IF NOT EXISTS token_lookup ON tokens(token_hash)")
            .map_err(|_| IndexError::Database)?;
        verify_exact_schema(&connection)?;
        let sentinel: Option<(Vec<u8>, Vec<u8>)> = connection
            .query_row(
                "SELECT sentinel_nonce,sentinel_ciphertext FROM metadata WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| IndexError::Database)?;
        if let Some((nonce, ciphertext)) = sentinel {
            if decrypt(&key, &nonce, &ciphertext)? != b"agent-workspace-index-v1" {
                return Err(IndexError::Crypto);
            }
        } else {
            let (nonce, ciphertext) = encrypt(&key, b"agent-workspace-index-v1")?;
            connection
                .execute(
                    "INSERT INTO metadata VALUES(1,1,?1,?2)",
                    params![nonce, ciphertext],
                )
                .map_err(|_| IndexError::Database)?;
        }
        let check: String = connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| IndexError::Database)?;
        if check != "ok" {
            return Err(IndexError::UnsafeDatabase);
        }
        secure_artifacts_at(&directory)?;
        let mut authorized = HashSet::new();
        let mut excluded = HashSet::new();
        {
            let mut s = connection
                .prepare("SELECT authorization_id,excluded FROM source_authorizations")
                .map_err(|_| IndexError::Database)?;
            let rows = s
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|_| IndexError::Database)?;
            for row in rows {
                let (id, is_excluded) = row.map_err(|_| IndexError::Database)?;
                let id = Uuid::parse_str(&id).map_err(|_| IndexError::UnsafeDatabase)?;
                authorized.insert(id);
                if is_excluded == 1 {
                    excluded.insert(id);
                } else if is_excluded != 0 {
                    return Err(IndexError::UnsafeDatabase);
                }
            }
        }
        Ok((
            IndexAvailability::Enabled,
            Some(Self {
                connection,
                directory,
                key,
                authorized,
                excluded,
            }),
        ))
    }
    pub fn authorize_source(&mut self, id: Uuid, consented_at_ms: u64) -> Result<(), IndexError> {
        let (nonce, ciphertext) = encrypt(&self.key, b"[]")?;
        self.connection.execute("INSERT INTO source_authorizations(authorization_id,excluded,consented_at_ms,retention_days,ignore_nonce,ignore_ciphertext) VALUES(?1,0,?2,365,?3,?4) ON CONFLICT(authorization_id) DO UPDATE SET excluded=0,consented_at_ms=excluded.consented_at_ms",params![id.to_string(),i64::try_from(consented_at_ms).map_err(|_|IndexError::Capacity)?,nonce,ciphertext]).map_err(|_|IndexError::Database)?;
        self.authorized.insert(id);
        self.excluded.remove(&id);
        Ok(())
    }
    /// Verifies the exact source consent and decryptable policy before a caller reads source
    /// content for indexing. Excluded and forgotten sources fail closed.
    pub fn authorize_source_read(&self, id: Uuid) -> Result<(), IndexError> {
        if !self.authorized.contains(&id) || self.excluded.contains(&id) {
            return Err(IndexError::Unauthorized);
        }
        self.source_ignore_rules(id).map(|_| ())
    }
    pub fn set_source_policy(
        &mut self,
        id: Uuid,
        retention_days: u16,
        excluded_document_ids: &[String],
    ) -> Result<(), IndexError> {
        if !self.authorized.contains(&id)
            || retention_days == 0
            || retention_days > 365
            || excluded_document_ids.len() > 256
            || excluded_document_ids
                .iter()
                .any(|id| Uuid::parse_str(id).is_err())
        {
            return Err(IndexError::Unauthorized);
        }
        let serialized =
            serde_json::to_vec(excluded_document_ids).map_err(|_| IndexError::Crypto)?;
        let (nonce, ciphertext) = encrypt(&self.key, &serialized)?;
        let tx = self
            .connection
            .transaction()
            .map_err(|_| IndexError::Database)?;
        tx.execute("UPDATE source_authorizations SET retention_days=?2,ignore_nonce=?3,ignore_ciphertext=?4 WHERE authorization_id=?1",params![id.to_string(),retention_days,nonce,ciphertext]).map_err(|_|IndexError::Database)?;
        for document_id in excluded_document_ids {
            let identity_hash = blake3::keyed_hash(&self.key, document_id.as_bytes());
            tx.execute(
                "DELETE FROM documents WHERE authorization_id=?1 AND identity_hash=?2",
                params![id.to_string(), identity_hash.as_bytes()],
            )
            .map_err(|_| IndexError::Database)?;
        }
        let cutoff = retention_cutoff(epoch_ms(), retention_days);
        tx.execute(
            "DELETE FROM documents WHERE authorization_id=?1 AND pinned=0 AND indexed_at_ms < ?2",
            params![
                id.to_string(),
                i64::try_from(cutoff).map_err(|_| IndexError::Capacity)?
            ],
        )
        .map_err(|_| IndexError::Database)?;
        tx.commit().map_err(|_| IndexError::Database)?;
        Ok(())
    }
    pub fn exclude_source(&mut self, id: Uuid) -> Result<(), IndexError> {
        if !self.authorized.contains(&id) {
            return Err(IndexError::Unauthorized);
        }
        let tx = self
            .connection
            .transaction()
            .map_err(|_| IndexError::Database)?;
        tx.execute(
            "UPDATE source_authorizations SET excluded=1 WHERE authorization_id=?1",
            [id.to_string()],
        )
        .map_err(|_| IndexError::Database)?;
        tx.execute(
            "DELETE FROM documents WHERE authorization_id=?1",
            [id.to_string()],
        )
        .map_err(|_| IndexError::Database)?;
        tx.commit().map_err(|_| IndexError::Database)?;
        self.excluded.insert(id);
        Ok(())
    }
    pub fn forget_source(&mut self, id: Uuid) -> Result<(), IndexError> {
        self.authorized.remove(&id);
        self.connection
            .execute(
                "DELETE FROM source_authorizations WHERE authorization_id=?1",
                [id.to_string()],
            )
            .map_err(|_| IndexError::Database)?;
        self.excluded.remove(&id);
        Ok(())
    }
    pub fn rebuild(&mut self) -> Result<(), IndexError> {
        self.connection
            .execute("DELETE FROM documents", [])
            .map_err(|_| IndexError::Database)?;
        Ok(())
    }
    /// Document capabilities are process-local and cannot be rebound from raw paths. Clear them
    /// at every service start while preserving encrypted source consent and policy.
    pub fn clear_runtime_bound_documents(&mut self) -> Result<(), IndexError> {
        self.rebuild()
    }
    pub fn rebuild_source(&mut self, id: Uuid) -> Result<(), IndexError> {
        if !self.authorized.contains(&id) {
            return Err(IndexError::Unauthorized);
        }
        self.connection
            .execute(
                "DELETE FROM documents WHERE authorization_id=?1",
                [id.to_string()],
            )
            .map_err(|_| IndexError::Database)?;
        Ok(())
    }
    pub fn export_summary(&self) -> Result<IndexExportSummary, IndexError> {
        let documents: i64 = self
            .connection
            .query_row("SELECT count(*) FROM documents", [], |r| r.get(0))
            .map_err(|_| IndexError::Database)?;
        let tokens: i64 = self
            .connection
            .query_row("SELECT count(*) FROM tokens", [], |r| r.get(0))
            .map_err(|_| IndexError::Database)?;
        Ok(IndexExportSummary {
            schema_version: 1,
            authorized_sources: self.authorized.len(),
            documents: u64::try_from(documents).map_err(|_| IndexError::UnsafeDatabase)?,
            tokens: u64::try_from(tokens).map_err(|_| IndexError::UnsafeDatabase)?,
        })
    }
    pub fn export_source_summary(
        &mut self,
        source: Uuid,
    ) -> Result<IndexExportSummary, IndexError> {
        self.authorize_source_read(source)?;
        self.prune(epoch_ms())?;
        let documents: i64 = self
            .connection
            .query_row(
                "SELECT count(*) FROM documents WHERE authorization_id=?1",
                [source.to_string()],
                |row| row.get(0),
            )
            .map_err(|_| IndexError::Database)?;
        let tokens: i64 = self
            .connection
            .query_row(
                "SELECT count(*) FROM tokens t JOIN documents d ON d.id=t.document_row WHERE d.authorization_id=?1",
                [source.to_string()],
                |row| row.get(0),
            )
            .map_err(|_| IndexError::Database)?;
        Ok(IndexExportSummary {
            schema_version: 1,
            authorized_sources: 1,
            documents: u64::try_from(documents).map_err(|_| IndexError::UnsafeDatabase)?,
            tokens: u64::try_from(tokens).map_err(|_| IndexError::UnsafeDatabase)?,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn index_text(
        &mut self,
        authorization: Uuid,
        document: &OpaqueDocumentRef,
        kind: SearchSourceKind,
        text: &str,
        pinned: bool,
        indexed_at_ms: u64,
        budget: IndexBudget,
    ) -> Result<(), IndexError> {
        if !self.authorized.contains(&authorization) || self.excluded.contains(&authorization) {
            return Err(IndexError::Unauthorized);
        }
        if !pinned
            && indexed_at_ms
                < retention_cutoff(epoch_ms(), self.source_retention_days(authorization)?)
        {
            return Ok(());
        }
        if text.len() > budget.max_bytes
            || budget.max_bytes > MAX_TRANSCRIPT_BYTES
            || Instant::now() >= budget.deadline
        {
            return Err(IndexError::Capacity);
        }
        if self
            .source_ignore_rules(authorization)?
            .iter()
            .any(|excluded_id| excluded_id == &document.document_id)
        {
            return Ok(());
        }
        let tokens = tokenize_before(text, budget.deadline)?;
        if tokens.is_empty() {
            return Ok(());
        }
        self.prune(indexed_at_ms)?;
        ensure_before(budget.deadline)?;
        let docs: i64 = self
            .connection
            .query_row("SELECT count(*) FROM documents", [], |r| r.get(0))
            .map_err(|_| IndexError::Database)?;
        let count: i64 = self
            .connection
            .query_row("SELECT count(*) FROM tokens", [], |r| r.get(0))
            .map_err(|_| IndexError::Database)?;
        let identity_hash = blake3::keyed_hash(&self.key, document.document_id.as_bytes());
        let existing: i64 = self
            .connection
            .query_row(
                "SELECT count(*) FROM documents WHERE identity_hash=?1",
                [identity_hash.as_bytes()],
                |r| r.get(0),
            )
            .map_err(|_| IndexError::Database)?;
        if docs < 0
            || count < 0
            || (existing == 0 && u64::try_from(docs).unwrap_or(u64::MAX) >= INDEX_MAX_DOCUMENTS)
            || u64::try_from(count)
                .unwrap_or(u64::MAX)
                .saturating_add(tokens.len() as u64)
                > INDEX_MAX_TOKENS
            || artifact_bytes(&self.directory)? >= INDEX_MAX_BYTES
        {
            return Err(IndexError::Capacity);
        }
        let (dn, dc) = encrypt(&self.key, document.document_id.as_bytes())?;
        let snippet: String = text
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            .take(512)
            .collect();
        let (sn, sc) = encrypt(&self.key, snippet.as_bytes())?;
        ensure_before(budget.deadline)?;
        let tx = self
            .connection
            .transaction()
            .map_err(|_| IndexError::Database)?;
        tx.execute(
            "DELETE FROM documents WHERE identity_hash=?1",
            [identity_hash.as_bytes()],
        )
        .map_err(|_| IndexError::Database)?;
        tx.execute("INSERT INTO documents(authorization_id,identity_hash,identity_version,document_nonce,document_ciphertext,snippet_nonce,snippet_ciphertext,source_kind,pinned,indexed_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![authorization.to_string(),identity_hash.as_bytes(),i64::try_from(document.identity_version).map_err(|_|IndexError::Capacity)?,dn,dc,sn,sc,kind_string(kind),i64::from(pinned),i64::try_from(indexed_at_ms).map_err(|_|IndexError::Capacity)?]).map_err(|_|IndexError::Database)?;
        let row = tx.last_insert_rowid();
        for (index, token) in tokens.into_iter().enumerate() {
            if index % 64 == 0 {
                ensure_before(budget.deadline)?;
            }
            let hash = blake3::keyed_hash(&self.key, token.as_bytes());
            tx.execute(
                "INSERT OR IGNORE INTO tokens(document_row,token_hash) VALUES(?1,?2)",
                params![row, hash.as_bytes()],
            )
            .map_err(|_| IndexError::Database)?;
        }
        ensure_before(budget.deadline)?;
        tx.commit().map_err(|_| IndexError::Database)?;
        secure_artifacts_at(&self.directory)
    }
    pub fn search(&mut self, query: &str, limit: usize) -> Result<Vec<SearchResult>, IndexError> {
        self.prune(epoch_ms())?;
        if limit == 0 || limit > MAX_SEARCH_RESULTS {
            return Err(IndexError::Capacity);
        }
        let tokens = tokenize(query);
        if tokens.is_empty() || tokens.len() > 32 {
            return Err(IndexError::Capacity);
        }
        let hashes: Vec<Vec<u8>> = tokens
            .iter()
            .map(|token| {
                blake3::keyed_hash(&self.key, token.as_bytes())
                    .as_bytes()
                    .to_vec()
            })
            .collect();
        let placeholders = std::iter::repeat_n("?", hashes.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT d.authorization_id,d.identity_version,d.document_nonce,d.document_ciphertext,d.snippet_nonce,d.snippet_ciphertext,d.source_kind,d.indexed_at_ms FROM documents d JOIN tokens t ON t.document_row=d.id WHERE t.token_hash IN ({placeholders}) GROUP BY d.id HAVING count(DISTINCT t.token_hash)={} ORDER BY d.indexed_at_ms DESC,d.id DESC LIMIT {limit}",
            hashes.len()
        );
        let mut statement = self
            .connection
            .prepare(&sql)
            .map_err(|_| IndexError::Database)?;
        let rows = statement
            .query_map(params_from_iter(hashes.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                    r.get::<_, Vec<u8>>(4)?,
                    r.get::<_, Vec<u8>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })
            .map_err(|_| IndexError::Database)?;
        let mut out = Vec::new();
        for row in rows {
            let (authorization, identity_version, dn, dc, sn, sc, kind, at) =
                row.map_err(|_| IndexError::Database)?;
            let authorization =
                Uuid::parse_str(&authorization).map_err(|_| IndexError::UnsafeDatabase)?;
            if !self.authorized.contains(&authorization) || self.excluded.contains(&authorization) {
                continue;
            }
            let document =
                String::from_utf8(decrypt(&self.key, &dn, &dc)?).map_err(|_| IndexError::Crypto)?;
            let snippet =
                String::from_utf8(decrypt(&self.key, &sn, &sc)?).map_err(|_| IndexError::Crypto)?;
            out.push(SearchResult {
                document: OpaqueDocumentRef {
                    document_id: document,
                    identity_version: u64::try_from(identity_version)
                        .map_err(|_| IndexError::UnsafeDatabase)?,
                },
                snippet,
                source_kind: if kind == "workspaceFile" {
                    SearchSourceKind::WorkspaceFile
                } else {
                    SearchSourceKind::AgentTranscript
                },
                indexed_at_ms: u64::try_from(at).map_err(|_| IndexError::Database)?,
            });
        }
        Ok(out)
    }
    fn prune(&self, now: u64) -> Result<(), IndexError> {
        self.connection
            .execute(
                "DELETE FROM documents WHERE pinned=0 AND indexed_at_ms < (?1 - (SELECT retention_days FROM source_authorizations WHERE authorization_id=documents.authorization_id) * 86400000)",
                [i64::try_from(now).unwrap_or(i64::MAX)],
            )
            .map_err(|_| IndexError::Database)?;
        Ok(())
    }
    fn source_ignore_rules(&self, id: Uuid) -> Result<Vec<String>, IndexError> {
        let(nonce,ciphertext):(Vec<u8>,Vec<u8>)=self.connection.query_row("SELECT ignore_nonce,ignore_ciphertext FROM source_authorizations WHERE authorization_id=?1 AND excluded=0",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|IndexError::Unauthorized)?;
        serde_json::from_slice(&decrypt(&self.key, &nonce, &ciphertext)?)
            .map_err(|_| IndexError::Crypto)
    }
    fn source_retention_days(&self, id: Uuid) -> Result<u16, IndexError> {
        self.connection
            .query_row(
                "SELECT retention_days FROM source_authorizations WHERE authorization_id=?1 AND excluded=0",
                [id.to_string()],
                |row| row.get::<_, u16>(0),
            )
            .map_err(|_| IndexError::Unauthorized)
    }
}

#[cfg(not(target_os = "linux"))]
pub struct ContentIndex;

#[cfg(not(target_os = "linux"))]
impl ContentIndex {
    pub fn open(
        _profile: &Path,
        _keys: &dyn ProfileKeyProvider,
    ) -> Result<(IndexAvailability, Option<Self>), IndexError> {
        Ok((IndexAvailability::DisabledKeyringUnavailable, None))
    }
    pub fn authorize_source(
        &mut self,
        _id: Uuid,
        _consented_at_ms: u64,
    ) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn authorize_source_read(&self, _id: Uuid) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn set_source_policy(
        &mut self,
        _id: Uuid,
        _retention_days: u16,
        _excluded_document_ids: &[String],
    ) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn exclude_source(&mut self, _id: Uuid) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn forget_source(&mut self, _id: Uuid) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn rebuild_source(&mut self, _id: Uuid) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn clear_runtime_bound_documents(&mut self) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn export_source_summary(
        &mut self,
        _source: Uuid,
    ) -> Result<IndexExportSummary, IndexError> {
        Err(IndexError::Disabled)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn index_text(
        &mut self,
        _authorization: Uuid,
        _document: &OpaqueDocumentRef,
        _kind: SearchSourceKind,
        _text: &str,
        _pinned: bool,
        _indexed_at_ms: u64,
        _budget: IndexBudget,
    ) -> Result<(), IndexError> {
        Err(IndexError::Disabled)
    }
    pub fn search(
        &mut self,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<SearchResult>, IndexError> {
        Err(IndexError::Disabled)
    }
}

#[cfg(target_os = "linux")]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .unwrap_or(0)
}
#[cfg(target_os = "linux")]
fn retention_cutoff(now_ms: u64, retention_days: u16) -> u64 {
    now_ms.saturating_sub(u64::from(retention_days) * 86_400_000)
}
#[cfg(target_os = "linux")]
fn kind_string(k: SearchSourceKind) -> &'static str {
    match k {
        SearchSourceKind::WorkspaceFile => "workspaceFile",
        SearchSourceKind::AgentTranscript => "agentTranscript",
    }
}
#[cfg(target_os = "linux")]
fn tokenize(text: &str) -> Vec<String> {
    let mut values: Vec<_> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|v| v.chars().count() >= 2)
        .take(4096)
        .map(str::to_lowercase)
        .collect();
    values.sort();
    values.dedup();
    values
}
#[cfg(target_os = "linux")]
fn tokenize_before(text: &str, deadline: Instant) -> Result<Vec<String>, IndexError> {
    let mut values = Vec::new();
    for (index, value) in text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|value| value.chars().count() >= 2)
        .take(4096)
        .enumerate()
    {
        if index % 64 == 0 {
            ensure_before(deadline)?;
        }
        values.push(value.to_lowercase());
    }
    values.sort();
    values.dedup();
    ensure_before(deadline)?;
    Ok(values)
}
#[cfg(target_os = "linux")]
fn ensure_before(deadline: Instant) -> Result<(), IndexError> {
    if Instant::now() < deadline {
        Ok(())
    } else {
        Err(IndexError::Capacity)
    }
}
#[cfg(target_os = "linux")]
fn encrypt(key: &[u8; 32], value: &[u8]) -> Result<(Vec<u8>, Vec<u8>), IndexError> {
    let nonce_bytes = *Uuid::new_v4().as_bytes();
    let mut nonce = [0u8; 24];
    nonce[..16].copy_from_slice(&nonce_bytes);
    nonce[16..].copy_from_slice(&blake3::hash(&nonce_bytes).as_bytes()[..8]);
    let cipher = XChaCha20Poly1305::new(key.into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), value)
        .map_err(|_| IndexError::Crypto)?;
    Ok((nonce.to_vec(), ciphertext))
}
#[cfg(target_os = "linux")]
fn decrypt(key: &[u8; 32], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, IndexError> {
    if nonce.len() != 24 {
        return Err(IndexError::Crypto);
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| IndexError::Crypto)
}
#[cfg(target_os = "linux")]
fn open_beneath(directory: &File, name: &str, flags: OFlags) -> Result<File, IndexError> {
    rfs::openat2(
        directory,
        name,
        flags | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map(File::from)
    .map_err(|_| IndexError::UnsafeDatabase)
}

#[cfg(target_os = "linux")]
fn open_absolute_directory(path: &Path) -> Result<File, IndexError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err(IndexError::UnsafeDatabase);
    }
    let slash = File::from(
        rfs::open(
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| IndexError::UnsafeDatabase)?,
    );
    let relative = path
        .strip_prefix("/")
        .map_err(|_| IndexError::UnsafeDatabase)?;
    rfs::openat2(
        &slash,
        relative,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map(File::from)
    .map_err(|_| IndexError::UnsafeDatabase)
}

#[cfg(target_os = "linux")]
fn validate_owned_directory(directory: &File) -> Result<(), IndexError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = directory
        .metadata()
        .map_err(|_| IndexError::UnsafeDatabase)?;
    if !metadata.is_dir() || metadata.uid() != rustix::process::getuid().as_raw() {
        return Err(IndexError::UnsafeDatabase);
    }
    rfs::fchmod(directory, Mode::RUSR | Mode::WUSR | Mode::XUSR)
        .map_err(|_| IndexError::UnsafeDatabase)
}

#[cfg(target_os = "linux")]
fn validate_profile_directory(directory: &File) -> Result<(), IndexError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = directory
        .metadata()
        .map_err(|_| IndexError::UnsafeDatabase)?;
    if metadata.is_dir() && metadata.uid() == rustix::process::getuid().as_raw() {
        Ok(())
    } else {
        Err(IndexError::UnsafeDatabase)
    }
}

#[cfg(target_os = "linux")]
fn prepare_index_directory(profile: &Path) -> Result<File, IndexError> {
    let profile = open_absolute_directory(profile)?;
    validate_profile_directory(&profile)?;
    for (parent, name) in [(&profile, "index")] {
        match rfs::mkdirat(parent, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(_) => return Err(IndexError::UnsafeDatabase),
        }
    }
    let index = open_beneath(&profile, "index", OFlags::RDONLY | OFlags::DIRECTORY)?;
    validate_owned_directory(&index)?;
    match rfs::mkdirat(&index, "v1", Mode::RUSR | Mode::WUSR | Mode::XUSR) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => {}
        Err(_) => return Err(IndexError::UnsafeDatabase),
    }
    let version = open_beneath(&index, "v1", OFlags::RDONLY | OFlags::DIRECTORY)?;
    validate_owned_directory(&version)?;
    Ok(version)
}

#[cfg(target_os = "linux")]
fn artifact_exists(directory: &File, name: &str) -> Result<bool, IndexError> {
    match rfs::openat2(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    ) {
        Ok(_) => Ok(true),
        Err(rustix::io::Errno::NOENT) => Ok(false),
        Err(_) => Err(IndexError::UnsafeDatabase),
    }
}

#[cfg(target_os = "linux")]
fn secure_artifact_at(directory: &File, name: &str) -> Result<(), IndexError> {
    use std::os::unix::fs::MetadataExt;
    let file = open_beneath(directory, name, OFlags::RDWR)?;
    let metadata = file.metadata().map_err(|_| IndexError::UnsafeDatabase)?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.nlink() != 1
    {
        return Err(IndexError::UnsafeDatabase);
    }
    rfs::fchmod(&file, Mode::RUSR | Mode::WUSR).map_err(|_| IndexError::UnsafeDatabase)
}

#[cfg(target_os = "linux")]
fn secure_artifacts_at(directory: &File) -> Result<(), IndexError> {
    for name in ["search.sqlite3", "search.sqlite3-wal", "search.sqlite3-shm"] {
        if artifact_exists(directory, name)? {
            secure_artifact_at(directory, name)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn artifact_bytes(directory: &File) -> Result<u64, IndexError> {
    let mut total = 0u64;
    for name in ["search.sqlite3", "search.sqlite3-wal", "search.sqlite3-shm"] {
        if artifact_exists(directory, name)? {
            total = total
                .checked_add(
                    open_beneath(directory, name, OFlags::RDONLY)?
                        .metadata()
                        .map_err(|_| IndexError::UnsafeDatabase)?
                        .len(),
                )
                .ok_or(IndexError::Capacity)?;
        }
    }
    Ok(total)
}

#[cfg(target_os = "linux")]
fn verify_exact_schema(connection: &Connection) -> Result<(), IndexError> {
    let mut statement = connection
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .map_err(|_| IndexError::Database)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|_| IndexError::Database)?;
    let actual = rows
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|_| IndexError::Database)?;
    let expected = BTreeSet::from([
        (
            "index".to_owned(),
            "sqlite_autoindex_documents_1".to_owned(),
            "documents".to_owned(),
            None,
        ),
        (
            "index".to_owned(),
            "sqlite_autoindex_source_authorizations_1".to_owned(),
            "source_authorizations".to_owned(),
            None,
        ),
        (
            "index".to_owned(),
            "sqlite_autoindex_tokens_1".to_owned(),
            "tokens".to_owned(),
            None,
        ),
        (
            "index".to_owned(),
            "token_lookup".to_owned(),
            "tokens".to_owned(),
            Some("CREATE INDEX token_lookup ON tokens(token_hash)".to_owned()),
        ),
        (
            "table".to_owned(),
            "documents".to_owned(),
            "documents".to_owned(),
            Some(EXPECTED_DOCUMENTS.to_owned()),
        ),
        (
            "table".to_owned(),
            "metadata".to_owned(),
            "metadata".to_owned(),
            Some(EXPECTED_METADATA.to_owned()),
        ),
        (
            "table".to_owned(),
            "source_authorizations".to_owned(),
            "source_authorizations".to_owned(),
            Some(EXPECTED_AUTHORIZATIONS.to_owned()),
        ),
        (
            "table".to_owned(),
            "tokens".to_owned(),
            "tokens".to_owned(),
            Some(EXPECTED_TOKENS.to_owned()),
        ),
    ]);
    if actual != expected {
        return Err(IndexError::UnsafeDatabase);
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct IndexJob {
    pub cancellation_id: Uuid,
    pub document_id: Uuid,
    pub byte_budget: u64,
    pub deadline: Instant,
}
#[derive(Default)]
pub struct BoundedIndexQueue {
    queue: VecDeque<IndexJob>,
    cancelled: HashSet<Uuid>,
}
impl BoundedIndexQueue {
    pub fn push(&mut self, job: IndexJob) -> Result<(), IndexError> {
        if self.queue.len() >= INDEX_QUEUE_CAPACITY {
            return Err(IndexError::Capacity);
        }
        self.queue.push_back(job);
        Ok(())
    }
    pub fn cancel(&mut self, id: Uuid) {
        if self.queue.iter().any(|job| job.cancellation_id == id) {
            self.cancelled.insert(id);
        }
    }
    pub fn take_interactive_batch(&mut self) -> Vec<IndexJob> {
        let mut out = Vec::new();
        while out.len() < INDEX_INTERACTIVE_BATCH {
            let Some(job) = self.queue.pop_front() else {
                break;
            };
            let was_cancelled = self.cancelled.remove(&job.cancellation_id);
            if !was_cancelled && job.byte_budget > 0 && job.deadline > Instant::now() {
                out.push(job);
            }
        }
        out
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptAdapter {
    CodexJsonlV1,
}
pub struct TranscriptParse {
    pub text: Vec<Zeroizing<String>>,
    pub skipped_records: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    format: String,
    version: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    role: String,
    content: String,
}
#[must_use]
pub fn parse_transcript(adapter: TranscriptAdapter, input: &[u8]) -> TranscriptParse {
    if input.len() > MAX_TRANSCRIPT_BYTES {
        return TranscriptParse {
            text: vec![],
            skipped_records: 1,
        };
    }
    let Ok(value) = std::str::from_utf8(input) else {
        return TranscriptParse {
            text: vec![],
            skipped_records: 1,
        };
    };
    let mut lines = value.lines();
    let Some(first) = lines.next() else {
        return TranscriptParse {
            text: vec![],
            skipped_records: 1,
        };
    };
    let Ok(header) = serde_json::from_str::<Header>(first) else {
        return TranscriptParse {
            text: vec![],
            skipped_records: 1,
        };
    };
    if !matches!(adapter, TranscriptAdapter::CodexJsonlV1)
        || header.format != "codex-transcript"
        || header.version != 1
    {
        return TranscriptParse {
            text: vec![],
            skipped_records: 1,
        };
    }
    let mut out = TranscriptParse {
        text: Vec::new(),
        skipped_records: 0,
    };
    for (position, line) in lines.enumerate() {
        if position >= MAX_TRANSCRIPT_RECORDS {
            out.skipped_records += 1;
            continue;
        }
        match serde_json::from_str::<Record>(line) {
            Ok(record)
                if matches!(record.role.as_str(), "user" | "assistant")
                    && record.content.len() <= 64 * 1024 =>
            {
                out.text.push(Zeroizing::new(record.content));
            }
            _ => out.skipped_records += 1,
        }
    }
    out
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use agent_workspace_content::{WorkspaceIndexEnumeration, WorkspacePathProvider};
    use std::os::unix::fs::{PermissionsExt as _, symlink};
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::Duration;
    use tempfile::tempdir;
    struct Keys(Option<[u8; 32]>);
    impl ProfileKeyProvider for Keys {
        fn with_profile_key(&self, consumer: &mut dyn FnMut(&[u8; 32])) -> bool {
            if let Some(key) = &self.0 {
                consumer(key);
                true
            } else {
                false
            }
        }
    }

    fn install_workspace_enumeration(
        index: &mut ContentIndex,
        source: Uuid,
        enumeration: WorkspaceIndexEnumeration,
    ) {
        index.rebuild_source(source).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        for item in enumeration.documents {
            index
                .index_text(
                    source,
                    &item.document,
                    SearchSourceKind::WorkspaceFile,
                    &item.text,
                    false,
                    epoch_ms(),
                    IndexBudget {
                        max_bytes: usize::try_from(
                            agent_workspace_content::MAX_INDEXABLE_FILE_BYTES,
                        )
                        .unwrap(),
                        deadline,
                    },
                )
                .unwrap();
        }
    }

    #[derive(Default)]
    struct FakeSecrets {
        state: Mutex<FakeSecretState>,
    }

    #[derive(Default)]
    struct FakeSecretState {
        key_id: Option<String>,
        unlocked: Vec<Vec<u8>>,
        locked: usize,
        creates: usize,
    }

    #[async_trait]
    impl ProfileSecretStore for FakeSecrets {
        async fn find_exact(
            &self,
            key_id: &str,
        ) -> Result<ProfileSecretMatches, ProfileKeyLoadError> {
            let state = self.state.lock().unwrap();
            let unlocked = if state.key_id.as_deref() == Some(key_id) {
                state.unlocked.iter().cloned().map(Zeroizing::new).collect()
            } else {
                Vec::new()
            };
            Ok(ProfileSecretMatches {
                unlocked,
                locked: state.locked,
            })
        }

        async fn create_exact(
            &self,
            key_id: &str,
            secret: &[u8; 32],
        ) -> Result<(), ProfileKeyLoadError> {
            let mut state = self.state.lock().unwrap();
            state.creates += 1;
            state.key_id = Some(key_id.to_owned());
            state.unlocked.push(secret.to_vec());
            Ok(())
        }
    }

    #[tokio::test]
    async fn profile_key_is_generated_once_and_uses_a_stable_owner_only_locator() {
        let profile = tempdir().unwrap();
        std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let secrets = FakeSecrets::default();
        let first = load_or_create_profile_key_with(profile.path(), &secrets)
            .await
            .unwrap();
        let second = load_or_create_profile_key_with(profile.path(), &secrets)
            .await
            .unwrap();
        assert_eq!(copy_profile_key(&first), copy_profile_key(&second));
        assert_eq!(secrets.state.lock().unwrap().creates, 1);
        let locator = profile.path().join(PROFILE_KEY_ID_FILE);
        assert_eq!(
            std::fs::metadata(locator).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(format!("{first:?}"), "LoadedProfileKey([REDACTED])");
    }

    #[tokio::test]
    async fn locked_duplicate_and_malformed_profile_secrets_fail_closed() {
        for (locked, unlocked, expected) in [
            (1, vec![], ProfileKeyLoadError::Ambiguous),
            (
                0,
                vec![vec![1; 32], vec![2; 32]],
                ProfileKeyLoadError::Ambiguous,
            ),
            (0, vec![vec![3; 31]], ProfileKeyLoadError::InvalidSecret),
        ] {
            let profile = tempdir().unwrap();
            std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            let key_id = Uuid::new_v4().to_string();
            std::fs::write(
                profile.path().join(PROFILE_KEY_ID_FILE),
                format!("{key_id}\n"),
            )
            .unwrap();
            std::fs::set_permissions(
                profile.path().join(PROFILE_KEY_ID_FILE),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
            let secrets = FakeSecrets {
                state: Mutex::new(FakeSecretState {
                    key_id: Some(key_id),
                    unlocked,
                    locked,
                    creates: 0,
                }),
            };
            assert_eq!(
                load_or_create_profile_key_with(profile.path(), &secrets)
                    .await
                    .unwrap_err(),
                expected
            );
            assert!(!profile.path().join("index").exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unsafe_profile_locator_never_queries_or_creates_a_secret() {
        let profile = tempdir().unwrap();
        std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let outside = profile.path().join("outside");
        std::fs::write(&outside, Uuid::new_v4().to_string()).unwrap();
        symlink(&outside, profile.path().join(PROFILE_KEY_ID_FILE)).unwrap();
        let secrets = FakeSecrets::default();
        assert_eq!(
            load_or_create_profile_key_with(profile.path(), &secrets)
                .await
                .unwrap_err(),
            ProfileKeyLoadError::UnsafeStorage
        );
        assert_eq!(secrets.state.lock().unwrap().creates, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unsafe_parent_symlinked_ancestor_and_interrupted_locator_fail_closed() {
        let unsafe_parent = tempdir().unwrap();
        std::fs::set_permissions(unsafe_parent.path(), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let secrets = FakeSecrets::default();
        assert_eq!(
            load_or_create_profile_key_with(unsafe_parent.path(), &secrets)
                .await
                .unwrap_err(),
            ProfileKeyLoadError::UnsafeStorage
        );

        let holder = tempdir().unwrap();
        std::fs::set_permissions(holder.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let real = holder.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        let linked = holder.path().join("linked");
        symlink(&real, &linked).unwrap();
        assert_eq!(
            load_or_create_profile_key_with(&linked, &secrets)
                .await
                .unwrap_err(),
            ProfileKeyLoadError::UnsafeStorage
        );

        let interrupted = tempdir().unwrap();
        std::fs::set_permissions(interrupted.path(), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let locator = interrupted.path().join(PROFILE_KEY_ID_FILE);
        std::fs::File::create(&locator).unwrap();
        std::fs::set_permissions(&locator, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            load_or_create_profile_key_with(interrupted.path(), &secrets)
                .await
                .unwrap_err(),
            ProfileKeyLoadError::UnsafeStorage
        );
        assert_eq!(secrets.state.lock().unwrap().creates, 0);
    }

    #[cfg(unix)]
    #[test]
    fn locator_file_swap_cannot_redirect_the_opened_descriptor() {
        let profile = tempdir().unwrap();
        std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = Uuid::new_v4().to_string();
        let replacement = Uuid::new_v4().to_string();
        let locator = profile.path().join(PROFILE_KEY_ID_FILE);
        std::fs::write(&locator, format!("{original}\n")).unwrap();
        std::fs::set_permissions(&locator, std::fs::Permissions::from_mode(0o600)).unwrap();
        let directory = open_safe_profile_directory(profile.path()).unwrap();
        let swapped = profile.path().join("swapped");
        let value = read_safe_key_id_with_hook(&directory, || {
            std::fs::rename(&locator, &swapped).unwrap();
            std::fs::write(&locator, format!("{replacement}\n")).unwrap();
            std::fs::set_permissions(&locator, std::fs::Permissions::from_mode(0o600)).unwrap();
        })
        .unwrap();
        assert_eq!(value, original);
    }
    #[test]
    fn keyring_unavailable_disables_without_database() {
        let d = tempdir().unwrap();
        let (a, index) = ContentIndex::open(d.path(), &Keys(None)).unwrap();
        assert_eq!(a, IndexAvailability::DisabledKeyringUnavailable);
        assert!(index.is_none());
        assert!(!d.path().join("index").exists());
    }
    #[test]
    fn sensitive_fields_are_encrypted_and_tokens_keyed() {
        let d = tempdir().unwrap();
        let (_, index) = ContentIndex::open(d.path(), &Keys(Some([7; 32]))).unwrap();
        let mut index = index.unwrap();
        let auth = Uuid::new_v4();
        let doc = Uuid::new_v4();
        let document = OpaqueDocumentRef {
            document_id: doc.to_string(),
            identity_version: 1,
        };
        index.authorize_source(auth, 0).unwrap();
        index
            .index_text(
                auth,
                &document,
                SearchSourceKind::WorkspaceFile,
                "needle super-secret-value",
                false,
                epoch_ms(),
                IndexBudget {
                    max_bytes: 1024,
                    deadline: Instant::now() + Duration::from_secs(1),
                },
            )
            .unwrap();
        let bytes = std::fs::read(d.path().join("index/v1/search.sqlite3")).unwrap();
        let hay = String::from_utf8_lossy(&bytes);
        assert!(!hay.contains("needle"));
        assert!(!hay.contains("super-secret-value"));
        assert!(!hay.contains(&doc.to_string()));
        assert_eq!(
            index.search("needle", 10).unwrap()[0].snippet,
            "needle super-secret-value"
        );
        index
            .set_source_policy(auth, 30, std::slice::from_ref(&document.document_id))
            .unwrap();
        assert!(index.search("needle", 10).unwrap().is_empty());
        index
            .index_text(
                auth,
                &document,
                SearchSourceKind::WorkspaceFile,
                "needle should-stay-excluded",
                false,
                epoch_ms(),
                IndexBudget {
                    max_bytes: 1024,
                    deadline: Instant::now() + Duration::from_secs(1),
                },
            )
            .unwrap();
        assert!(index.search("needle", 10).unwrap().is_empty());
    }

    #[test]
    fn retention_is_applied_on_policy_change_and_before_search_results_are_read() {
        let d = tempdir().unwrap();
        let (_, index) = ContentIndex::open(d.path(), &Keys(Some([17; 32]))).unwrap();
        let mut index = index.unwrap();
        let source = Uuid::new_v4();
        let now = epoch_ms();
        let old = now.saturating_sub(2 * 86_400_000);
        index.authorize_source(source, old).unwrap();

        for (document, text, indexed_at_ms) in [
            (Uuid::new_v4(), "expired marker", old),
            (Uuid::new_v4(), "current marker", now),
        ] {
            index
                .index_text(
                    source,
                    &OpaqueDocumentRef {
                        document_id: document.to_string(),
                        identity_version: 1,
                    },
                    SearchSourceKind::WorkspaceFile,
                    text,
                    false,
                    indexed_at_ms,
                    IndexBudget {
                        max_bytes: 1024,
                        deadline: Instant::now() + Duration::from_secs(1),
                    },
                )
                .unwrap();
        }
        assert_eq!(index.export_summary().unwrap().documents, 2);

        index.set_source_policy(source, 1, &[]).unwrap();
        assert_eq!(index.export_summary().unwrap().documents, 1);

        index
            .connection
            .execute(
                "UPDATE documents SET indexed_at_ms=?1",
                [i64::try_from(old).unwrap()],
            )
            .unwrap();
        assert!(index.search("current", 10).unwrap().is_empty());
        assert_eq!(index.export_summary().unwrap().documents, 0);
    }

    #[test]
    fn fresh_restart_replacement_and_removal_rebuild_from_authorized_root() {
        let profile = tempdir().unwrap();
        let roots = tempdir().unwrap();
        let first_root = roots.path().join("first");
        let replacement_root = roots.path().join("replacement");
        std::fs::create_dir_all(first_root.join("nested")).unwrap();
        std::fs::create_dir(&replacement_root).unwrap();
        std::fs::write(
            first_root.join("nested/unopened.txt"),
            "fresh unopened needle",
        )
        .unwrap();
        std::fs::write(replacement_root.join("current.txt"), "replacement marker").unwrap();
        let key = Keys(Some([21; 32]));
        let source = Uuid::new_v4();
        let (_, index) = ContentIndex::open(profile.path(), &key).unwrap();
        let mut index = index.unwrap();
        index.authorize_source(source, 1).unwrap();
        let mut provider = WorkspacePathProvider::default();
        provider
            .authorize_workspace_root(source, &first_root, "first")
            .unwrap();
        assert!(provider.documents_for_root(source).unwrap().is_empty());
        let enumeration = provider
            .enumerate_index_documents_with_cancel(source, || false)
            .unwrap();
        install_workspace_enumeration(&mut index, source, enumeration);
        assert_eq!(index.search("unopened", 10).unwrap().len(), 1);
        drop(index);

        let (_, restarted) = ContentIndex::open(profile.path(), &key).unwrap();
        let mut restarted = restarted.unwrap();
        restarted.clear_runtime_bound_documents().unwrap();
        assert!(restarted.search("unopened", 10).unwrap().is_empty());
        let mut restarted_provider = WorkspacePathProvider::default();
        restarted_provider
            .authorize_workspace_root(source, &first_root, "first")
            .unwrap();
        let enumeration = restarted_provider
            .enumerate_index_documents_with_cancel(source, || false)
            .unwrap();
        install_workspace_enumeration(&mut restarted, source, enumeration);
        assert_eq!(restarted.search("unopened", 10).unwrap().len(), 1);

        restarted_provider
            .sync_workspace_roots(&[(source, replacement_root, "replacement".into())])
            .unwrap();
        restarted.rebuild_source(source).unwrap();
        assert!(restarted.search("unopened", 10).unwrap().is_empty());
        let enumeration = restarted_provider
            .enumerate_index_documents_with_cancel(source, || false)
            .unwrap();
        install_workspace_enumeration(&mut restarted, source, enumeration);
        assert_eq!(restarted.search("replacement", 10).unwrap().len(), 1);
        assert!(restarted.search("unopened", 10).unwrap().is_empty());

        restarted_provider.sync_workspace_roots(&[]).unwrap();
        restarted.forget_source(source).unwrap();
        assert!(restarted.search("replacement", 10).unwrap().is_empty());
        assert_eq!(
            restarted_provider.issue_document(source, Path::new("current.txt")),
            Err(agent_workspace_content::ContentError::Unauthorized)
        );
    }
    #[test]
    fn restart_clears_ephemeral_document_refs_but_preserves_source_consent() {
        let d = tempdir().unwrap();
        let keys = Keys(Some([13; 32]));
        let source = Uuid::new_v4();
        let stale_document = OpaqueDocumentRef {
            document_id: Uuid::new_v4().to_string(),
            identity_version: 1,
        };
        let (_, index) = ContentIndex::open(d.path(), &keys).unwrap();
        let mut index = index.unwrap();
        index.authorize_source(source, 1).unwrap();
        index
            .index_text(
                source,
                &stale_document,
                SearchSourceKind::WorkspaceFile,
                "restart-bound document",
                false,
                epoch_ms(),
                IndexBudget {
                    max_bytes: 1024,
                    deadline: Instant::now() + Duration::from_secs(1),
                },
            )
            .unwrap();
        assert_eq!(index.search("restart-bound", 10).unwrap().len(), 1);
        drop(index);

        let (_, index) = ContentIndex::open(d.path(), &keys).unwrap();
        let mut index = index.unwrap();
        index.clear_runtime_bound_documents().unwrap();
        assert!(index.search("restart-bound", 10).unwrap().is_empty());
        let fresh_document = OpaqueDocumentRef {
            document_id: Uuid::new_v4().to_string(),
            identity_version: 1,
        };
        index
            .index_text(
                source,
                &fresh_document,
                SearchSourceKind::WorkspaceFile,
                "freshly rebound",
                false,
                epoch_ms(),
                IndexBudget {
                    max_bytes: 1024,
                    deadline: Instant::now() + Duration::from_secs(1),
                },
            )
            .unwrap();
        assert_eq!(index.search("freshly", 10).unwrap().len(), 1);
    }
    #[test]
    fn cancellation_and_batches_cannot_starve_interactive_work() {
        let mut q = BoundedIndexQueue::default();
        let cancelled = Uuid::new_v4();
        for i in 0..20 {
            q.push(IndexJob {
                cancellation_id: if i == 0 { cancelled } else { Uuid::new_v4() },
                document_id: Uuid::new_v4(),
                byte_budget: 1,
                deadline: Instant::now() + Duration::from_secs(1),
            })
            .unwrap();
        }
        q.cancel(cancelled);
        let batch = q.take_interactive_batch();
        assert_eq!(batch.len(), INDEX_INTERACTIVE_BATCH);
        assert!(batch.iter().all(|j| j.cancellation_id != cancelled));
    }
    #[test]
    fn transcript_boundary_skips_unknown_and_secret_fields() {
        let input=b"{\"format\":\"codex-transcript\",\"version\":1}\n{\"role\":\"user\",\"content\":\"safe\"}\n{\"role\":\"assistant\",\"content\":\"leak\",\"apiKey\":\"secret\"}\n";
        let p = parse_transcript(TranscriptAdapter::CodexJsonlV1, input);
        assert_eq!(
            p.text.iter().map(|text| text.as_str()).collect::<Vec<_>>(),
            ["safe"]
        );
        assert_eq!(p.skipped_records, 1);
    }

    #[tokio::test]
    async fn production_transcript_source_is_closed_versioned_and_cancellable() {
        let source = CodexAppServerTranscriptSource;
        let cancellation = Arc::new(AtomicBool::new(false));
        let request = TrustedTranscriptRequest {
            agent_session_id: Uuid::new_v4(),
            session_revision: 1,
            adapter: TranscriptAdapter::CodexJsonlV1,
            adapter_version: "0.142.4".into(),
            cancellation: Arc::clone(&cancellation),
        };
        let mut wrong_version = request.clone();
        wrong_version.adapter_version = "0.142.5".into();
        assert!(matches!(
            source.read_bounded(wrong_version).await,
            Err(TranscriptSourceError::UnsupportedFormat)
        ));
        cancellation.store(true, Ordering::Relaxed);
        assert!(matches!(
            source.read_bounded(request).await,
            Err(TranscriptSourceError::Cancelled)
        ));
        for message in [
            TranscriptSourceError::UnsupportedFormat.to_string(),
            TranscriptSourceError::Cancelled.to_string(),
        ] {
            for forbidden in ['/', '\\'] {
                assert!(!message.contains(forbidden));
            }
            assert!(!message.to_ascii_lowercase().contains("sqlite"));
        }
    }

    #[test]
    fn corrupt_database_is_preserved_before_explicit_rebuild() {
        let d = tempdir().unwrap();
        let key = Keys(Some([9; 32]));
        let (_, index) = ContentIndex::open(d.path(), &key).unwrap();
        drop(index);
        let database = d.path().join("index/v1/search.sqlite3");
        std::fs::write(&database, b"not sqlite").unwrap();
        assert!(ContentIndex::open(d.path(), &key).is_err());
        let (_, rebuilt) = ContentIndex::preserve_corrupt_and_rebuild(d.path(), &key).unwrap();
        assert!(rebuilt.is_some());
        let preserved = std::fs::read_dir(d.path().join("index/v1"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(preserved);
    }

    #[test]
    fn recovery_without_a_key_never_renames_corrupt_data() {
        let d = tempdir().unwrap();
        let database = d.path().join("index/v1/search.sqlite3");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        std::fs::write(&database, b"preserve me").unwrap();
        let (availability, rebuilt) =
            ContentIndex::preserve_corrupt_and_rebuild(d.path(), &Keys(None)).unwrap();
        assert_eq!(availability, IndexAvailability::DisabledKeyringUnavailable);
        assert!(rebuilt.is_none());
        assert_eq!(std::fs::read(database).unwrap(), b"preserve me");
    }

    #[test]
    fn unsafe_preexisting_sidecar_and_unexpected_schema_object_fail_closed() {
        let d = tempdir().unwrap();
        let key = Keys(Some([3; 32]));
        let (_, index) = ContentIndex::open(d.path(), &key).unwrap();
        drop(index);
        let version = d.path().join("index/v1");
        let outside = d.path().join("outside");
        std::fs::write(&outside, b"outside").unwrap();
        symlink(&outside, version.join("search.sqlite3-wal")).unwrap();
        assert!(matches!(
            ContentIndex::open(d.path(), &key),
            Err(IndexError::UnsafeDatabase)
        ));
        std::fs::remove_file(version.join("search.sqlite3-wal")).unwrap();
        Connection::open(version.join("search.sqlite3"))
            .unwrap()
            .execute_batch("CREATE VIEW unexpected AS SELECT id FROM documents")
            .unwrap();
        assert!(matches!(
            ContentIndex::open(d.path(), &key),
            Err(IndexError::UnsafeDatabase)
        ));
    }

    #[test]
    fn expired_budget_writes_no_document_rows() {
        let d = tempdir().unwrap();
        let (_, index) = ContentIndex::open(d.path(), &Keys(Some([4; 32]))).unwrap();
        let mut index = index.unwrap();
        let authorization = Uuid::new_v4();
        index.authorize_source(authorization, 0).unwrap();
        let document = OpaqueDocumentRef {
            document_id: Uuid::new_v4().to_string(),
            identity_version: 1,
        };
        assert!(matches!(
            index.index_text(
                authorization,
                &document,
                SearchSourceKind::WorkspaceFile,
                "deadline bounded text",
                false,
                epoch_ms(),
                IndexBudget {
                    max_bytes: 1024,
                    deadline: Instant::now(),
                },
            ),
            Err(IndexError::Capacity)
        ));
        assert_eq!(index.export_summary().unwrap().documents, 0);
    }
}

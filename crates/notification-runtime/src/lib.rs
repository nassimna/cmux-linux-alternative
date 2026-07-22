//! Secure, ephemeral CLI discovery records shared by the service and public CLI.

use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read as _, Write as _},
    path::{Path, PathBuf},
};

use agent_workspace_protocol::{APPLICATION_ID, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

pub const SESSION_FILE_ENVIRONMENT_VARIABLE: &str = "AGENT_WORKSPACE_SESSION_FILE";
pub const SESSION_FILE_NAME: &str = "cli-session.json";
pub const MAX_SECURE_FILE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliSessionRecord {
    pub application: String,
    pub version: String,
    pub protocol_version: u32,
    pub endpoint: String,
    pub token: String,
    pub session_id: String,
}

impl CliSessionRecord {
    #[must_use]
    pub fn current(endpoint: String, token: String) -> Self {
        Self {
            application: APPLICATION_ID.to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            protocol_version: PROTOCOL_VERSION,
            endpoint,
            token,
            session_id: Uuid::new_v4().to_string(),
        }
    }

    fn validate(&self) -> Result<(), SecureFileError> {
        if self.application != APPLICATION_ID
            || self.protocol_version != PROTOCOL_VERSION
            || self.endpoint.is_empty()
            || self.token.len() < 32
            || Uuid::parse_str(&self.session_id).is_err()
        {
            return Err(SecureFileError::InvalidRecord);
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum SecureFileError {
    #[error("the secure file path is invalid or not owned by the current user")]
    InsecurePath,
    #[error("the secure file exceeds its size limit")]
    Oversized,
    #[error("the session record is invalid")]
    InvalidRecord,
    #[error("secure file operation failed: {0}")]
    Io(#[source] io::Error),
    #[error("secure file data is malformed")]
    Malformed,
}

impl From<io::Error> for SecureFileError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

/// Removes only the record created by this guard; a newer replacement is preserved.
pub struct CliSessionGuard {
    path: PathBuf,
    session_id: String,
}

impl CliSessionGuard {
    /// Atomically creates a secure discovery record and returns its cleanup guard.
    ///
    /// # Errors
    /// Returns an error for an invalid record, insecure path, or failed durable write.
    pub fn create(path: &Path, record: &CliSessionRecord) -> Result<Self, SecureFileError> {
        record.validate()?;
        let encoded = serde_json::to_vec(record).map_err(|_| SecureFileError::Malformed)?;
        atomic_secure_write(path, &encoded)?;
        Ok(Self {
            path: path.to_owned(),
            session_id: record.session_id.clone(),
        })
    }

    /// Removes this guard's record if it has not been replaced by a newer session.
    ///
    /// # Errors
    /// Returns an error when the current secure record cannot be validated or removed.
    pub fn remove(mut self) -> Result<(), SecureFileError> {
        self.remove_if_current()?;
        self.path.clear();
        Ok(())
    }

    fn remove_if_current(&self) -> Result<(), SecureFileError> {
        if self.path.as_os_str().is_empty() || !self.path.exists() {
            return Ok(());
        }
        let current = read_session_record(&self.path)?;
        if current.session_id == self.session_id {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}

impl Drop for CliSessionGuard {
    fn drop(&mut self) {
        let _ = self.remove_if_current();
    }
}

/// Reads and validates an owner-only CLI discovery record.
///
/// # Errors
/// Returns an error for an insecure path, oversized/malformed data, or invalid metadata.
pub fn read_session_record(path: &Path) -> Result<CliSessionRecord, SecureFileError> {
    let record: CliSessionRecord = read_secure_json(path, MAX_SECURE_FILE_BYTES)?;
    record.validate()?;
    Ok(record)
}

/// Reads bounded owner-only JSON from a regular file without following the final symlink.
///
/// # Errors
/// Returns an error for an insecure path, oversized/malformed data, or failed I/O.
pub fn read_secure_json<T: DeserializeOwned>(
    path: &Path,
    limit: usize,
) -> Result<T, SecureFileError> {
    let bytes = read_secure(path, limit)?;
    serde_json::from_slice(&bytes).map_err(|_| SecureFileError::Malformed)
}

/// Reads bounded bytes from an owner-only regular file.
///
/// # Errors
/// Returns an error for an insecure path, oversized content, or failed I/O.
pub fn read_secure(path: &Path, limit: usize) -> Result<Vec<u8>, SecureFileError> {
    validate_secure_directory(path.parent().ok_or(SecureFileError::InsecurePath)?)?;
    validate_file(path)?;
    let file = secure_open_read(path)?;
    let mut bytes = Vec::new();
    file.take(u64::try_from(limit).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(SecureFileError::Oversized);
    }
    Ok(bytes)
}

/// Durably and atomically serializes owner-only JSON.
///
/// # Errors
/// Returns an error for serialization, an insecure path, oversized content, or failed I/O.
pub fn atomic_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<(), SecureFileError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| SecureFileError::Malformed)?;
    atomic_secure_write(path, &bytes)
}

/// Durably and atomically writes bytes with an owner-only destination mode.
///
/// # Errors
/// Returns an error for an insecure path, oversized content, or failed I/O.
pub fn atomic_secure_write(path: &Path, bytes: &[u8]) -> Result<(), SecureFileError> {
    if bytes.len() > MAX_SECURE_FILE_BYTES {
        return Err(SecureFileError::Oversized);
    }
    let parent = path.parent().ok_or(SecureFileError::InsecurePath)?;
    ensure_secure_directory(parent)?;
    if path.exists() || fs::symlink_metadata(path).is_ok() {
        validate_file(path)?;
    }
    let temporary = parent.join(format!(".{}.{}.tmp", SESSION_FILE_NAME, Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| -> Result<(), SecureFileError> {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[must_use]
pub fn resolve_session_file(explicit: Option<&Path>) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_owned();
    }
    if let Some(path) = env::var_os(SESSION_FILE_ENVIRONMENT_VARIABLE).filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }
    default_session_file()
}

#[must_use]
pub fn default_session_file() -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(runtime) = env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(runtime)
            .join(APPLICATION_ID)
            .join(SESSION_FILE_NAME);
    }
    let suffix = current_user_suffix();
    env::temp_dir()
        .join(format!("{APPLICATION_ID}-{suffix}"))
        .join(SESSION_FILE_NAME)
}

fn ensure_secure_directory(path: &Path) -> Result<(), SecureFileError> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SecureFileError::InsecurePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != current_uid() {
            return Err(SecureFileError::InsecurePath);
        }
    }
    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

fn validate_secure_directory(path: &Path) -> Result<(), SecureFileError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SecureFileError::InsecurePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        if metadata.uid() != current_uid() {
            return Err(SecureFileError::InsecurePath);
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(SecureFileError::InsecurePath);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    rustix::process::getuid().as_raw()
}

fn validate_file(path: &Path) -> Result<(), SecureFileError> {
    let metadata = fs::symlink_metadata(path).map_err(SecureFileError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SecureFileError::InsecurePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        if metadata.uid() != current_uid() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(SecureFileError::InsecurePath);
        }
    }
    Ok(())
}

fn secure_open_read(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn current_user_suffix() -> String {
    current_uid().to_string()
}

#[cfg(not(unix))]
fn current_user_suffix() -> String {
    "user".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn record() -> CliSessionRecord {
        CliSessionRecord::current("/tmp/control.sock".to_owned(), "x".repeat(32))
    }

    #[test]
    fn session_record_is_owner_only_and_removed() {
        let root = tempdir().unwrap();
        let path = root.path().join("runtime/session.json");
        let guard = CliSessionGuard::create(&path, &record()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(guard);
        assert!(!path.exists());
    }

    #[test]
    fn stale_guard_preserves_replacement() {
        let root = tempdir().unwrap();
        let path = root.path().join("runtime/session.json");
        let old = CliSessionGuard::create(&path, &record()).unwrap();
        let replacement = record();
        let new = CliSessionGuard::create(&path, &replacement).unwrap();
        drop(old);
        assert_eq!(read_session_record(&path).unwrap(), replacement);
        drop(new);
    }

    #[test]
    fn rejects_oversized_and_insecure_files() {
        let root = tempdir().unwrap();
        let directory = root.path().join("runtime");
        fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(
            &directory,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let path = directory.join("oversized.json");
        fs::write(&path, vec![b'x'; 128]).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        assert!(matches!(
            read_secure(&path, 64),
            Err(SecureFileError::Oversized)
        ));

        #[cfg(unix)]
        {
            let link = directory.join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(matches!(
                read_secure(&link, 64),
                Err(SecureFileError::InsecurePath)
            ));
        }
    }

    #[test]
    fn errors_never_contain_session_secret() {
        let root = tempdir().unwrap();
        let path = root.path().join("runtime/session.json");
        let secret = "sensitive-control-token-never-print";
        fs::create_dir(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{{\"token\":\"{secret}\"}} trailing")).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        let message = read_session_record(&path).unwrap_err().to_string();
        assert!(!message.contains(secret));
    }
}

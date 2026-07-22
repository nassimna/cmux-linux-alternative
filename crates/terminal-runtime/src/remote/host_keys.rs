//! First-contact host-key scanning and app-owned known-hosts persistence.

use std::{
    fs::{self, File, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use ssh_key::{HashAlg, PublicKey};
use tokio::io::AsyncReadExt as _;
use uuid::Uuid;

use super::RemoteRuntimeError;

const MAX_SCAN_BYTES: usize = 8 * 1024;
const HOST_KEY_ALGORITHM: &str = "ssh-ed25519";

/// Exact normalized host-key material shown in a trusted first-contact prompt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostKeyDescriptor {
    pub canonical_host: String,
    pub port: u16,
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
}

impl HostKeyDescriptor {
    /// Returns the one normalized OpenSSH known-hosts record for this descriptor.
    #[must_use]
    pub fn known_hosts_line(&self) -> String {
        format!(
            "{} {} {}\n",
            host_pattern(&self.canonical_host, self.port),
            self.algorithm,
            self.public_key
        )
    }

    /// Parses and validates the exact single record owned by a target profile.
    ///
    /// # Errors
    /// Returns an error for extra records, unsupported algorithms, or a different descriptor.
    pub fn read_exact(
        path: &Path,
        canonical_host: &str,
        port: u16,
    ) -> Result<Self, RemoteRuntimeError> {
        super::validate_owner_only_file(path)?;
        let bytes = fs::read(path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
        if bytes.len() > MAX_SCAN_BYTES {
            return Err(RemoteRuntimeError::HostKeyMismatch);
        }
        parse_scan(&bytes, canonical_host, port)
    }
}

/// Production wrapper around the root-owned system `ssh-keyscan` binary.
#[derive(Clone, Debug)]
pub struct SystemHostKeyScanner {
    executable: PathBuf,
}

impl SystemHostKeyScanner {
    /// Resolves the approved root-owned scanner from fixed system paths.
    ///
    /// # Errors
    /// Returns an error if the approved scanner is unavailable or mutable by non-root users.
    pub fn resolve() -> Result<Self, RemoteRuntimeError> {
        Ok(Self {
            executable: resolve_system_executable("ssh-keyscan")?,
        })
    }

    /// Scans only the v1 allowlisted host-key algorithm with no inherited environment.
    ///
    /// # Errors
    /// Returns a closed error for timeouts, multiple results, malformed output, or nonzero exit.
    pub async fn scan(
        &self,
        canonical_host: &str,
        port: u16,
    ) -> Result<HostKeyDescriptor, RemoteRuntimeError> {
        validate_scan_target(canonical_host, port)?;
        let mut command = tokio::process::Command::new(&self.executable);
        command
            .args([
                "-T",
                "5",
                "-p",
                &port.to_string(),
                "-t",
                "ed25519",
                canonical_host,
            ])
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(RemoteRuntimeError::HostKeyScanUnavailable)?;
        let operation = async {
            let mut output = Vec::new();
            let mut limited = stdout.take((MAX_SCAN_BYTES + 1) as u64);
            limited
                .read_to_end(&mut output)
                .await
                .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?;
            let status = child
                .wait()
                .await
                .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?;
            if !status.success() || output.len() > MAX_SCAN_BYTES {
                return Err(RemoteRuntimeError::HostKeyScanUnavailable);
            }
            parse_scan(&output, canonical_host, port)
        };
        tokio::time::timeout(Duration::from_secs(7), operation)
            .await
            .map_err(|_| RemoteRuntimeError::HostKeyScanUnavailable)?
    }
}

/// Atomically replaces a target's one-record known-hosts file and fsyncs file and directory.
///
/// # Errors
/// Returns an error unless the destination is inside an owner-only absolute directory.
pub fn write_known_host_atomic(
    path: &Path,
    descriptor: &HostKeyDescriptor,
) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};

    let parent = path.parent().ok_or(RemoteRuntimeError::UnsafeKnownHosts)?;
    let parent_meta =
        fs::symlink_metadata(parent).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    if !path.is_absolute()
        || !parent_meta.is_dir()
        || parent_meta.file_type().is_symlink()
        || parent_meta.uid() != rustix::process::getuid().as_raw()
        || parent_meta.permissions().mode() & 0o077 != 0
        || fs::canonicalize(parent).ok().as_deref() != Some(parent)
    {
        return Err(RemoteRuntimeError::UnsafeKnownHosts);
    }
    let temporary = parent.join(format!(".known-hosts-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
    let result = (|| {
        if fs::canonicalize(parent).ok().as_deref() != Some(parent) {
            return Err(RemoteRuntimeError::UnsafeKnownHosts);
        }
        file.write_all(descriptor.known_hosts_line().as_bytes())
            .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
        file.sync_all()
            .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
        if fs::canonicalize(parent).ok().as_deref() != Some(parent) {
            return Err(RemoteRuntimeError::UnsafeKnownHosts);
        }
        fs::rename(&temporary, path).map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| RemoteRuntimeError::UnsafeKnownHosts)?;
        super::validate_owner_only_file(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn parse_scan(
    bytes: &[u8],
    canonical_host: &str,
    port: u16,
) -> Result<HostKeyDescriptor, RemoteRuntimeError> {
    validate_scan_target(canonical_host, port)?;
    let value = std::str::from_utf8(bytes).map_err(|_| RemoteRuntimeError::HostKeyMismatch)?;
    let rows: Vec<_> = value
        .lines()
        .filter(|line| !line.trim_start().starts_with('#') && !line.trim().is_empty())
        .collect();
    if rows.len() != 1 {
        return Err(RemoteRuntimeError::HostKeyMismatch);
    }
    let fields: Vec<_> = rows[0].split_ascii_whitespace().collect();
    if fields.len() != 3
        || fields[0] != host_pattern(canonical_host, port)
        || fields[1] != HOST_KEY_ALGORITHM
    {
        return Err(RemoteRuntimeError::HostKeyMismatch);
    }
    let encoded_public = format!("{} {}", fields[1], fields[2]);
    let public = PublicKey::from_openssh(&encoded_public)
        .map_err(|_| RemoteRuntimeError::HostKeyMismatch)?;
    if public.algorithm().as_str() != HOST_KEY_ALGORITHM {
        return Err(RemoteRuntimeError::HostKeyMismatch);
    }
    let normalized = public
        .to_openssh()
        .map_err(|_| RemoteRuntimeError::HostKeyMismatch)?;
    let normalized_key = normalized
        .split_ascii_whitespace()
        .nth(1)
        .ok_or(RemoteRuntimeError::HostKeyMismatch)?;
    if normalized_key != fields[2] {
        return Err(RemoteRuntimeError::HostKeyMismatch);
    }
    Ok(HostKeyDescriptor {
        canonical_host: canonical_host.to_owned(),
        port,
        algorithm: HOST_KEY_ALGORITHM.to_owned(),
        public_key: normalized_key.to_owned(),
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
    })
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn validate_scan_target(host: &str, port: u16) -> Result<(), RemoteRuntimeError> {
    if port == 0
        || host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || host != host.to_ascii_lowercase()
        || host
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(RemoteRuntimeError::InvalidTarget);
    }
    Ok(())
}

#[cfg(unix)]
fn resolve_system_executable(name: &str) -> Result<PathBuf, RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    for root in [Path::new("/usr/bin"), Path::new("/bin")] {
        let candidate = root.join(name);
        let Ok(path) = fs::canonicalize(candidate) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.is_file()
            && metadata.uid() == 0
            && metadata.nlink() == 1
            && metadata.permissions().mode() & 0o111 != 0
            && metadata.permissions().mode() & 0o022 == 0
        {
            return Ok(path);
        }
    }
    Err(RemoteRuntimeError::HostKeyScanUnavailable)
}

#[cfg(not(unix))]
fn resolve_system_executable(_name: &str) -> Result<PathBuf, RemoteRuntimeError> {
    Err(RemoteRuntimeError::HostKeyScanUnavailable)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;
    use tempfile::tempdir;

    const ED25519: &str = "AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3";

    #[test]
    fn parser_rejects_extra_keys_and_normalizes_nondefault_ports() {
        let row = format!("[example.com]:2222 ssh-ed25519 {ED25519}\n");
        let descriptor = parse_scan(row.as_bytes(), "example.com", 2222).unwrap();
        assert_eq!(descriptor.algorithm, HOST_KEY_ALGORITHM);
        assert!(descriptor.fingerprint.starts_with("SHA256:"));
        let doubled = format!("{row}{row}");
        assert_eq!(
            parse_scan(doubled.as_bytes(), "example.com", 2222).unwrap_err(),
            RemoteRuntimeError::HostKeyMismatch
        );
    }

    #[test]
    fn atomic_writer_replaces_with_one_exact_fsynced_record() {
        let directory = tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("target.known_hosts");
        let row = format!("example.com ssh-ed25519 {ED25519}\n");
        let descriptor = parse_scan(row.as_bytes(), "example.com", 22).unwrap();
        write_known_host_atomic(&path, &descriptor).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), row);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            HostKeyDescriptor::read_exact(&path, "example.com", 22).unwrap(),
            descriptor
        );
    }

    #[test]
    fn atomic_writer_rejects_a_symlinked_parent() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let real = directory.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        let linked = directory.path().join("linked");
        symlink(&real, &linked).unwrap();
        let row = format!("example.com ssh-ed25519 {ED25519}\n");
        let descriptor = parse_scan(row.as_bytes(), "example.com", 22).unwrap();
        assert_eq!(
            write_known_host_atomic(&linked.join("target.known_hosts"), &descriptor).unwrap_err(),
            RemoteRuntimeError::UnsafeKnownHosts
        );
        assert!(fs::read_dir(real).unwrap().next().is_none());
    }
}

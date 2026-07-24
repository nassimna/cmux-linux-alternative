//! Linux Secret Service backed, attempt-scoped SSH signing broker.

use std::{
    collections::HashMap,
    fmt, fs,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use async_trait::async_trait;
use secret_service::{EncryptionType, SecretService};
use signature::Signer as _;
use ssh_agent_lib::{
    agent::{Session, listen},
    error::AgentError,
    proto::{Identity, PublicCredential, SignRequest},
};
use ssh_key::{Algorithm, PrivateKey, Signature};
use tokio::{net::UnixListener, task::JoinHandle};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    CredentialBrokerLease, CredentialProvider, CredentialReference, EphemeralAgentSocket,
    RemoteRuntimeError,
};

const SECRET_SERVICE_APPLICATION: &str = "cmux-linux-alternative";
const SECRET_SERVICE_KIND: &str = "openssh-private-key-v1";
const MAX_PRIVATE_KEY_BYTES: usize = 64 * 1024;
const MAX_SIGN_REQUEST_BYTES: usize = 256 * 1024;

fn credential_attributes(reference: &CredentialReference) -> HashMap<&str, &str> {
    HashMap::from([
        ("application", SECRET_SERVICE_APPLICATION),
        ("kind", SECRET_SERVICE_KIND),
        ("credential-reference", reference.as_str()),
    ])
}

fn require_unambiguous_matches(
    locked: usize,
    unlocked: usize,
    allow_missing: bool,
) -> Result<bool, RemoteRuntimeError> {
    if locked != 0 {
        return Err(RemoteRuntimeError::CredentialRequired);
    }
    match unlocked {
        0 if allow_missing => Ok(false),
        0 => Err(RemoteRuntimeError::CredentialRequired),
        1 => Ok(true),
        _ => Err(RemoteRuntimeError::CredentialRevoked),
    }
}

/// Validates and stores one selected private key under the target's exact Secret Service locator.
///
/// The inherited file is consumed only inside the trusted service process. Key bytes are bounded,
/// zeroized, and never returned to the caller.
///
/// # Errors
///
/// Returns an error when the inherited file is unsafe, the key is not an unencrypted OpenSSH
/// Ed25519 key, or Secret Service cannot store and verify one unambiguous exact match.
pub async fn enroll_target_credential_from_file(
    target_id: Uuid,
    key_file: fs::File,
) -> Result<(), RemoteRuntimeError> {
    let secret = read_private_key_file(key_file)?;
    let expected_public = validate_private_key(secret.as_slice())?;
    let reference = CredentialReference::for_target(target_id);
    let service = SecretService::connect(EncryptionType::Dh)
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    let collection = service
        .get_default_collection()
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    if collection
        .is_locked()
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?
    {
        return Err(RemoteRuntimeError::CredentialRequired);
    }
    let found = service
        .search_items(credential_attributes(&reference))
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    let _ = require_unambiguous_matches(found.locked.len(), found.unlocked.len(), true)?;
    collection
        .create_item(
            "cmux remote SSH credential",
            credential_attributes(&reference),
            secret.as_slice(),
            true,
            "application/x-openssh-private-key",
        )
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    let verified = service
        .search_items(credential_attributes(&reference))
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    require_unambiguous_matches(verified.locked.len(), verified.unlocked.len(), false)?;
    let stored = Zeroizing::new(
        verified.unlocked[0]
            .get_secret()
            .await
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?,
    );
    let stored_public = validate_private_key(stored.as_slice())?;
    if stored_public != expected_public {
        return Err(RemoteRuntimeError::CredentialRevoked);
    }
    Ok(())
}

/// Removes the exact target credential. Missing credentials are treated as already cleaned.
/// Locked or duplicate matches fail closed so cleanup can be retried without deleting ambiguity.
///
/// # Errors
///
/// Returns an error when Secret Service is unavailable, locked, ambiguous, or cannot delete the
/// exact target credential.
pub async fn delete_target_credential(target_id: Uuid) -> Result<(), RemoteRuntimeError> {
    let reference = CredentialReference::for_target(target_id);
    let service = SecretService::connect(EncryptionType::Dh)
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    let found = service
        .search_items(credential_attributes(&reference))
        .await
        .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
    if !require_unambiguous_matches(found.locked.len(), found.unlocked.len(), true)? {
        return Ok(());
    }
    match found.unlocked.as_slice() {
        [item] => item
            .delete()
            .await
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable),
        _ => unreachable!("exact-match policy accepted one unlocked item"),
    }
}

#[cfg(unix)]
fn read_private_key_file(file: fs::File) -> Result<Zeroizing<Vec<u8>>, RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    let metadata = file
        .metadata()
        .map_err(|_| RemoteRuntimeError::UnsafeCredentialFile)?;
    let flags =
        rustix::fs::fcntl_getfl(&file).map_err(|_| RemoteRuntimeError::UnsafeCredentialFile)?;
    if flags.intersects(rustix::fs::OFlags::WRONLY | rustix::fs::OFlags::RDWR)
        || !metadata.is_file()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > MAX_PRIVATE_KEY_BYTES as u64
    {
        return Err(RemoteRuntimeError::UnsafeCredentialFile);
    }
    rustix::io::fcntl_setfd(&file, rustix::io::FdFlags::CLOEXEC)
        .map_err(|_| RemoteRuntimeError::UnsafeCredentialFile)?;
    let capacity =
        usize::try_from(metadata.len()).map_err(|_| RemoteRuntimeError::UnsafeCredentialFile)?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(capacity));
    file.take((MAX_PRIVATE_KEY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| RemoteRuntimeError::UnsafeCredentialFile)?;
    if bytes.is_empty()
        || bytes.len() > MAX_PRIVATE_KEY_BYTES
        || bytes.len() as u64 != metadata.len()
    {
        return Err(RemoteRuntimeError::UnsafeCredentialFile);
    }
    Ok(bytes)
}

#[cfg(not(unix))]
fn read_private_key_file(_file: fs::File) -> Result<Zeroizing<Vec<u8>>, RemoteRuntimeError> {
    Err(RemoteRuntimeError::CredentialProviderUnavailable)
}

fn validate_private_key(secret: &[u8]) -> Result<ssh_key::PublicKey, RemoteRuntimeError> {
    let key =
        PrivateKey::from_openssh(secret).map_err(|_| RemoteRuntimeError::InvalidCredential)?;
    if key.is_encrypted() || key.algorithm() != Algorithm::Ed25519 {
        return Err(RemoteRuntimeError::InvalidCredential);
    }
    Ok(key.public_key().clone())
}

/// Secret Service provider which creates a fresh Unix agent for every target attempt.
#[derive(Clone)]
pub struct SecretServiceCredentialProvider {
    broker_root: PathBuf,
}

impl fmt::Debug for SecretServiceCredentialProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecretServiceCredentialProvider")
            .field("broker_root", &"[PRIVATE]")
            .finish()
    }
}

impl SecretServiceCredentialProvider {
    /// Creates a provider rooted in an app-owned, owner-only runtime directory.
    ///
    /// # Errors
    /// Returns an error unless the root is absolute and can be held owner-only.
    pub fn new(broker_root: PathBuf) -> Result<Self, RemoteRuntimeError> {
        prepare_private_directory(&broker_root)?;
        let broker_root =
            fs::canonicalize(broker_root).map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)?;
        validate_canonical_private_directory(&broker_root)?;
        Ok(Self { broker_root })
    }

    async fn retrieve_key(
        reference: &CredentialReference,
    ) -> Result<PrivateKey, RemoteRuntimeError> {
        let service = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
        let found = service
            .search_items(credential_attributes(reference))
            .await
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
        // Unlock prompts are owned by the confirmed desktop provider action.
        require_unambiguous_matches(found.locked.len(), found.unlocked.len(), false)?;
        let secret = found.unlocked[0]
            .get_secret()
            .await
            .map_err(|_| RemoteRuntimeError::CredentialProviderUnavailable)?;
        if secret.is_empty() || secret.len() > MAX_PRIVATE_KEY_BYTES {
            return Err(RemoteRuntimeError::CredentialRevoked);
        }
        let secret = Zeroizing::new(secret);
        let key = PrivateKey::from_openssh(secret.as_slice())
            .map_err(|_| RemoteRuntimeError::CredentialRevoked)?;
        if key.is_encrypted() || key.algorithm() != Algorithm::Ed25519 {
            return Err(RemoteRuntimeError::CredentialRevoked);
        }
        Ok(key)
    }
}

#[async_trait]
impl CredentialProvider for SecretServiceCredentialProvider {
    async fn acquire(
        &self,
        reference: &CredentialReference,
        target_id: Uuid,
        attempt_generation: u64,
    ) -> Result<CredentialBrokerLease, RemoteRuntimeError> {
        if attempt_generation == 0 {
            return Err(RemoteRuntimeError::CredentialRevoked);
        }
        validate_canonical_private_directory(&self.broker_root)?;
        let key = Self::retrieve_key(reference).await?;
        let state = Arc::new(BrokerState {
            active: AtomicBool::new(true),
            key: Mutex::new(Some(key)),
        });
        let attempt_root = self.broker_root.join(Uuid::new_v4().to_string());
        prepare_private_directory(&attempt_root)?;
        validate_canonical_private_directory(&attempt_root)?;
        let socket_path = attempt_root.join("agent.sock");
        let listener =
            UnixListener::bind(&socket_path).map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)?;
        set_socket_owner_only(&socket_path)?;
        validate_canonical_private_directory(&self.broker_root)?;
        validate_canonical_private_directory(&attempt_root)?;
        let socket = EphemeralAgentSocket::from_broker_path(socket_path.clone())?;
        let session = BrokerSession {
            state: Arc::clone(&state),
        };
        let task = tokio::spawn(async move {
            let _ = listen(listener, session).await;
        });
        Ok(CredentialBrokerLease::with_guard(
            target_id,
            attempt_generation,
            socket,
            Box::new(BrokerGuard {
                state,
                task,
                socket_path,
                attempt_root,
            }),
        ))
    }
}

struct BrokerState {
    active: AtomicBool,
    key: Mutex<Option<PrivateKey>>,
}

#[derive(Clone)]
struct BrokerSession {
    state: Arc<BrokerState>,
}

#[async_trait]
impl Session for BrokerSession {
    async fn request_identities(&mut self) -> Result<Vec<Identity>, AgentError> {
        if !self.state.active.load(Ordering::Acquire) {
            return Err(agent_denied());
        }
        let key = self.state.key.lock().map_err(|_| agent_denied())?;
        let key = key.as_ref().ok_or_else(agent_denied)?;
        Ok(vec![Identity {
            credential: PublicCredential::Key(key.public_key().key_data().clone()),
            comment: "cmux attempt key".to_owned(),
        }])
    }

    async fn sign(&mut self, request: SignRequest) -> Result<Signature, AgentError> {
        if !self.state.active.load(Ordering::Acquire)
            || request.flags != 0
            || request.data.is_empty()
            || request.data.len() > MAX_SIGN_REQUEST_BYTES
        {
            return Err(agent_denied());
        }
        let key = self.state.key.lock().map_err(|_| agent_denied())?;
        let key = key.as_ref().ok_or_else(agent_denied)?;
        let PublicCredential::Key(requested) = request.credential else {
            return Err(agent_denied());
        };
        if requested != *key.public_key().key_data()
            || key.algorithm() != Algorithm::Ed25519
            || !self.state.active.load(Ordering::Acquire)
        {
            return Err(agent_denied());
        }
        key.try_sign(&request.data).map_err(|_| agent_denied())
    }
}

fn agent_denied() -> AgentError {
    AgentError::other(std::io::Error::other("signing request denied"))
}

struct BrokerGuard {
    state: Arc<BrokerState>,
    task: JoinHandle<()>,
    socket_path: PathBuf,
    attempt_root: PathBuf,
}

impl Drop for BrokerGuard {
    fn drop(&mut self) {
        self.state.active.store(false, Ordering::Release);
        if let Ok(mut key) = self.state.key.lock() {
            let _ = key.take();
        }
        self.task.abort();
        let _ = fs::remove_file(&self.socket_path);
        let _ = fs::remove_dir(&self.attempt_root);
    }
}

#[cfg(unix)]
fn prepare_private_directory(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::PermissionsExt as _;
    if !path.is_absolute() {
        return Err(RemoteRuntimeError::UnsafeAgentSocket);
    }
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(RemoteRuntimeError::UnsafeAgentSocket);
    }
    fs::create_dir_all(path).map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)?;
    validate_canonical_private_directory(path)
}

#[cfg(unix)]
fn validate_canonical_private_directory(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let metadata = fs::symlink_metadata(path).map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(RemoteRuntimeError::UnsafeAgentSocket);
    }
    Ok(())
}

#[cfg(not(unix))]
fn prepare_private_directory(_path: &Path) -> Result<(), RemoteRuntimeError> {
    Err(RemoteRuntimeError::CredentialProviderUnavailable)
}

#[cfg(not(unix))]
fn validate_canonical_private_directory(_path: &Path) -> Result<(), RemoteRuntimeError> {
    Err(RemoteRuntimeError::CredentialProviderUnavailable)
}

#[cfg(unix)]
fn set_socket_owner_only(path: &Path) -> Result<(), RemoteRuntimeError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| RemoteRuntimeError::UnsafeAgentSocket)
}

#[cfg(not(unix))]
fn set_socket_owner_only(_path: &Path) -> Result<(), RemoteRuntimeError> {
    Err(RemoteRuntimeError::CredentialProviderUnavailable)
}

impl Drop for BrokerState {
    fn drop(&mut self) {
        if let Ok(key) = self.key.get_mut() {
            let _ = key.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssh_key::{
        LineEnding,
        private::{Ed25519Keypair, KeypairData},
    };

    fn key(seed: u8) -> PrivateKey {
        PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&[seed; 32])),
            "fixture",
        )
        .unwrap()
    }

    fn session(seed: u8) -> (Arc<BrokerState>, BrokerSession) {
        let state = Arc::new(BrokerState {
            active: AtomicBool::new(true),
            key: Mutex::new(Some(key(seed))),
        });
        (
            Arc::clone(&state),
            BrokerSession {
                state: Arc::clone(&state),
            },
        )
    }

    #[tokio::test]
    async fn broker_lists_and_signs_only_the_attempt_key_without_flags() {
        let (_state, mut broker) = session(7);
        let identities = broker.request_identities().await.unwrap();
        assert_eq!(identities.len(), 1);
        let signature = broker
            .sign(SignRequest {
                credential: identities[0].credential.clone(),
                data: b"bounded authentication transcript".to_vec(),
                flags: 0,
            })
            .await
            .unwrap();
        assert_eq!(signature.algorithm(), Algorithm::Ed25519);

        assert!(
            broker
                .sign(SignRequest {
                    credential: identities[0].credential.clone(),
                    data: vec![1, 2, 3],
                    flags: 1,
                })
                .await
                .is_err()
        );
        assert!(
            broker
                .sign(SignRequest {
                    credential: identities[0].credential.clone(),
                    data: vec![0; MAX_SIGN_REQUEST_BYTES + 1],
                    flags: 0,
                })
                .await
                .is_err()
        );
        let other = key(8);
        assert!(
            broker
                .sign(SignRequest {
                    credential: PublicCredential::Key(other.public_key().key_data().clone()),
                    data: vec![1, 2, 3],
                    flags: 0,
                })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn generation_fence_revokes_existing_sessions_and_drops_key() {
        let (state, mut broker) = session(9);
        let identity = broker.request_identities().await.unwrap().remove(0);
        state.active.store(false, Ordering::Release);
        state.key.lock().unwrap().take();
        assert!(broker.request_identities().await.is_err());
        assert!(
            broker
                .sign(SignRequest {
                    credential: identity.credential,
                    data: vec![1],
                    flags: 0,
                })
                .await
                .is_err()
        );
        assert!(state.key.lock().unwrap().is_none());
    }

    #[test]
    fn opaque_references_and_debug_output_do_not_reveal_socket_or_reference() {
        let target = Uuid::new_v4();
        let reference = CredentialReference::for_target(target);
        assert!(!format!("{reference:?}").contains(&target.to_string()));
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        assert!(
            !format!("{:?}", EphemeralAgentSocket(path.clone()))
                .contains(&path.display().to_string())
        );
    }

    #[test]
    fn secret_service_locator_and_fake_match_policy_are_exact_and_fail_closed() {
        struct FakeKeyring {
            locked: usize,
            unlocked: usize,
        }
        impl FakeKeyring {
            fn exact(&self, allow_missing: bool) -> Result<bool, RemoteRuntimeError> {
                require_unambiguous_matches(self.locked, self.unlocked, allow_missing)
            }
        }

        let target = Uuid::parse_str("00000000-0000-4000-8000-000000000123").unwrap();
        let reference = CredentialReference::for_target(target);
        assert_eq!(
            credential_attributes(&reference),
            HashMap::from([
                ("application", "cmux-linux-alternative"),
                ("kind", "openssh-private-key-v1"),
                (
                    "credential-reference",
                    "v1-00000000-0000-4000-8000-000000000123",
                ),
            ])
        );
        assert_eq!(
            FakeKeyring {
                locked: 0,
                unlocked: 0
            }
            .exact(true),
            Ok(false)
        );
        assert_eq!(
            FakeKeyring {
                locked: 0,
                unlocked: 1
            }
            .exact(false),
            Ok(true)
        );
        assert_eq!(
            FakeKeyring {
                locked: 1,
                unlocked: 0
            }
            .exact(true),
            Err(RemoteRuntimeError::CredentialRequired)
        );
        assert_eq!(
            FakeKeyring {
                locked: 0,
                unlocked: 2
            }
            .exact(true),
            Err(RemoteRuntimeError::CredentialRevoked)
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_fd_must_be_read_only_owner_only_single_link_and_ed25519() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected-key");
        fs::write(
            &path,
            key(11).to_openssh(LineEnding::LF).unwrap().as_bytes(),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        let bytes = read_private_key_file(fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(
            validate_private_key(bytes.as_slice()).unwrap().algorithm(),
            Algorithm::Ed25519
        );

        let writable = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            read_private_key_file(writable).unwrap_err(),
            RemoteRuntimeError::UnsafeCredentialFile
        );

        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            read_private_key_file(fs::File::open(&path).unwrap()).unwrap_err(),
            RemoteRuntimeError::UnsafeCredentialFile
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let hardlink = directory.path().join("selected-key-link");
        fs::hard_link(&path, hardlink).unwrap();
        assert_eq!(
            read_private_key_file(fs::File::open(&path).unwrap()).unwrap_err(),
            RemoteRuntimeError::UnsafeCredentialFile
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_rejects_a_symlinked_broker_root() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};

        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        let linked = directory.path().join("linked");
        symlink(&real, &linked).unwrap();
        assert_eq!(
            SecretServiceCredentialProvider::new(linked).unwrap_err(),
            RemoteRuntimeError::UnsafeAgentSocket
        );
    }
}

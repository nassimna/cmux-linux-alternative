use std::path::Path;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::{
    MAX_SAFE_INTEGER, SqliteStateStore, StorageError, action_invocations, database_error,
    secure_database_artifacts,
};
use crate::{ActionInvocationIdentity, ActionInvocationRecord};

pub(crate) const EXPECTED_ACTION_PROVIDER_RECOVERY_SCHEMA: &str =
    "CREATE TABLE action_provider_recovery (
    provider_id TEXT PRIMARY KEY CHECK (length(provider_id) = 36),
    provider_instance_id TEXT NOT NULL UNIQUE CHECK (length(provider_instance_id) = 36),
    provider_epoch INTEGER NOT NULL CHECK (provider_epoch BETWEEN 1 AND 9007199254740991),
    lease_id TEXT NOT NULL UNIQUE CHECK (length(lease_id) = 36),
    registration_sequence INTEGER NOT NULL CHECK (registration_sequence BETWEEN 1 AND 9007199254740991),
    capability_claim_digest TEXT NOT NULL CHECK (length(capability_claim_digest) = 64),
    owner_service_id TEXT NOT NULL CHECK (length(owner_service_id) = 36),
    recover_until_ms INTEGER NOT NULL CHECK (recover_until_ms >= 0)
)";

/// Durable, proof-free identity required to recover one exact desktop-provider lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionProviderRecoveryRecord {
    pub provider_id: Uuid,
    pub provider_instance_id: Uuid,
    pub provider_epoch: u64,
    pub lease_id: Uuid,
    pub registration_sequence: u64,
    /// Lowercase SHA-256 of the canonical sorted capability and window-claim set.
    pub capability_claim_digest: String,
    /// Fresh control-service fencing identity. This is not a provider credential.
    pub owner_service_id: Uuid,
    pub recover_until_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionProviderRecoveryAcquireOutcome {
    Acquired {
        provider: ActionProviderRecoveryRecord,
        invocations: Vec<ActionInvocationRecord>,
    },
    Missing,
    Mismatch,
    Expired,
}

pub(crate) fn migrate_to_v7(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "CREATE TABLE action_provider_recovery (\
           provider_id TEXT PRIMARY KEY CHECK (length(provider_id) = 36),\
           provider_instance_id TEXT NOT NULL UNIQUE CHECK (length(provider_instance_id) = 36),\
           provider_epoch INTEGER NOT NULL CHECK (provider_epoch BETWEEN 1 AND 9007199254740991),\
           lease_id TEXT NOT NULL UNIQUE CHECK (length(lease_id) = 36),\
           registration_sequence INTEGER NOT NULL CHECK (registration_sequence BETWEEN 1 AND 9007199254740991),\
           capability_claim_digest TEXT NOT NULL CHECK (length(capability_claim_digest) = 64),\
           owner_service_id TEXT NOT NULL CHECK (length(owner_service_id) = 36),\
           recover_until_ms INTEGER NOT NULL CHECK (recover_until_ms >= 0)\
         );\
         UPDATE migration_metadata SET target_version = 7 WHERE singleton = 1;\
         PRAGMA user_version = 7;",
    )
}

impl SqliteStateStore {
    /// Creates or renews the exact recovery lease owned by this service. A live row owned by a
    /// different service is never overwritten.
    pub fn persist_action_provider_recovery(
        &self,
        record: &ActionProviderRecoveryRecord,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        validate_record(record)?;
        validate_time(now_ms)?;
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| {
                database_error(&self.path, "provider recovery persistence", source)
            })?;
        transaction
            .execute(
                "DELETE FROM action_provider_recovery WHERE recover_until_ms <= ?1",
                [now_ms],
            )
            .map_err(|source| database_error(&self.path, "provider recovery expiry", source))?;
        let existing = match load_by_provider(&transaction, record.provider_id)? {
            some @ Some(_) => some,
            None => load_by_instance(&transaction, record.provider_instance_id)?,
        };
        let applied = match existing {
            Some(existing)
                if existing.owner_service_id == record.owner_service_id
                    && existing.provider_instance_id == record.provider_instance_id
                    && existing.provider_epoch == record.provider_epoch
                    && existing.lease_id == record.lease_id
                    && existing.registration_sequence == record.registration_sequence =>
            {
                transaction
                    .execute(
                        "UPDATE action_provider_recovery SET capability_claim_digest = ?1, recover_until_ms = ?2 WHERE provider_id = ?3 AND owner_service_id = ?4",
                        params![record.capability_claim_digest, record.recover_until_ms, record.provider_id.to_string(), record.owner_service_id.to_string()],
                    )
                    .map_err(|source| database_error(&self.path, "provider recovery renewal", source))? == 1
            }
            Some(_) => false,
            None => transaction
                .execute(
                    "INSERT INTO action_provider_recovery (provider_id, provider_instance_id, provider_epoch, lease_id, registration_sequence, capability_claim_digest, owner_service_id, recover_until_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![record.provider_id.to_string(), record.provider_instance_id.to_string(), to_safe_i64(record.provider_epoch), record.lease_id.to_string(), to_safe_i64(record.registration_sequence), record.capability_claim_digest, record.owner_service_id.to_string(), record.recover_until_ms],
                )
                .map_err(|source| database_error(&self.path, "provider recovery insert", source))? == 1,
        };
        transaction
            .commit()
            .map_err(|source| database_error(&self.path, "provider recovery commit", source))?;
        Ok(applied)
    }

    /// Atomically consumes the prior service's recovery authority, rotates the service fence, and
    /// returns only nonterminal invocations bound to the exact recovered provider identity.
    pub fn acquire_action_provider_recovery(
        &self,
        provider_instance_id: Uuid,
        capability_claim_digest: &str,
        new_owner_service_id: Uuid,
        now_ms: i64,
        recover_until_ms: i64,
    ) -> Result<ActionProviderRecoveryAcquireOutcome, StorageError> {
        validate_digest(capability_claim_digest)?;
        validate_time(now_ms)?;
        validate_time(recover_until_ms)?;
        if recover_until_ms <= now_ms {
            return Err(invalid("recover_until_ms must be in the future"));
        }
        secure_database_artifacts(&self.path)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|source| database_error(&self.path, "provider recovery acquire", source))?;
        let Some(mut record) = load_by_instance(&transaction, provider_instance_id)? else {
            return Ok(ActionProviderRecoveryAcquireOutcome::Missing);
        };
        if record.recover_until_ms <= now_ms {
            transaction
                .execute(
                    "DELETE FROM action_provider_recovery WHERE provider_id = ?1",
                    [record.provider_id.to_string()],
                )
                .map_err(|source| {
                    database_error(&self.path, "provider recovery expired consume", source)
                })?;
            transaction.commit().map_err(|source| {
                database_error(&self.path, "provider recovery expiry commit", source)
            })?;
            return Ok(ActionProviderRecoveryAcquireOutcome::Expired);
        }
        if record.capability_claim_digest != capability_claim_digest {
            return Ok(ActionProviderRecoveryAcquireOutcome::Mismatch);
        }
        if record.owner_service_id == new_owner_service_id {
            return Ok(ActionProviderRecoveryAcquireOutcome::Mismatch);
        }
        let prior_owner = record.owner_service_id;
        let changed = transaction
            .execute(
                "UPDATE action_provider_recovery SET owner_service_id = ?1, recover_until_ms = ?2 WHERE provider_id = ?3 AND owner_service_id = ?4",
                params![new_owner_service_id.to_string(), recover_until_ms, record.provider_id.to_string(), prior_owner.to_string()],
            )
            .map_err(|source| database_error(&self.path, "provider recovery fence rotation", source))?;
        if changed != 1 {
            return Ok(ActionProviderRecoveryAcquireOutcome::Mismatch);
        }
        record.owner_service_id = new_owner_service_id;
        record.recover_until_ms = recover_until_ms;
        // These are the two crash windows before a reverse request becomes observable. Recovery
        // completes the monotonic durable transitions before rebuilding the queue, so the
        // recovered provider can safely repeat the normal start-claim protocol.
        transaction
            .execute(
                "UPDATE action_invocations SET state = 'dispatched', updated_at_ms = MAX(updated_at_ms, ?1) WHERE terminal_at_ms IS NULL AND state = 'leased' AND provider_id = ?2 AND provider_epoch = ?3 AND provider_lease_id = ?4",
                params![now_ms, record.provider_id.to_string(), to_safe_i64(record.provider_epoch), record.lease_id.to_string()],
            )
            .map_err(|source| database_error(&self.path, "provider leased invocation recovery", source))?;
        transaction
            .execute(
                "UPDATE action_invocations SET state = 'startGranted' WHERE terminal_at_ms IS NULL AND state = 'startClaimed' AND provider_id = ?1 AND provider_epoch = ?2 AND provider_lease_id = ?3",
                params![record.provider_id.to_string(), to_safe_i64(record.provider_epoch), record.lease_id.to_string()],
            )
            .map_err(|source| database_error(&self.path, "provider start grant recovery", source))?;
        let invocations = load_exact_nonterminal_invocations(&transaction, &record)?;
        transaction.commit().map_err(|source| {
            database_error(&self.path, "provider recovery acquire commit", source)
        })?;
        Ok(ActionProviderRecoveryAcquireOutcome::Acquired {
            provider: record,
            invocations,
        })
    }

    pub fn action_provider_recovery_owner_valid(
        &self,
        provider_id: Uuid,
        owner_service_id: Uuid,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        validate_time(now_ms)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM action_provider_recovery WHERE provider_id = ?1 AND owner_service_id = ?2 AND recover_until_ms > ?3",
                params![provider_id.to_string(), owner_service_id.to_string(), now_ms],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "provider recovery owner validation", source))?;
        Ok(count == 1)
    }

    pub fn action_provider_identity_recoverable(
        &self,
        identity: &ActionInvocationIdentity,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        validate_time(now_ms)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM action_provider_recovery WHERE provider_id = ?1 AND provider_epoch = ?2 AND lease_id = ?3 AND recover_until_ms > ?4",
                params![identity.provider_id.to_string(), to_safe_i64(identity.provider_epoch), identity.provider_lease_id.to_string(), now_ms],
                |row| row.get(0),
            )
            .map_err(|source| database_error(&self.path, "provider identity recoverability", source))?;
        Ok(count == 1)
    }

    pub fn delete_action_provider_recovery(
        &self,
        provider_id: Uuid,
        owner_service_id: Uuid,
    ) -> Result<bool, StorageError> {
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM action_provider_recovery WHERE provider_id = ?1 AND owner_service_id = ?2",
                params![provider_id.to_string(), owner_service_id.to_string()],
            )
            .map(|changed| changed == 1)
            .map_err(|source| database_error(&self.path, "provider recovery deletion", source))
    }

    pub fn prune_action_provider_recovery(&self, now_ms: i64) -> Result<usize, StorageError> {
        validate_time(now_ms)?;
        secure_database_artifacts(&self.path)?;
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM action_provider_recovery WHERE recover_until_ms <= ?1",
                [now_ms],
            )
            .map_err(|source| database_error(&self.path, "provider recovery pruning", source))
    }
}

fn load_exact_nonterminal_invocations(
    transaction: &Transaction<'_>,
    provider: &ActionProviderRecoveryRecord,
) -> Result<Vec<ActionInvocationRecord>, StorageError> {
    let sql = format!(
        "SELECT {} FROM action_invocations WHERE terminal_at_ms IS NULL AND provider_id = ?1 AND provider_epoch = ?2 AND provider_lease_id = ?3 ORDER BY sequence LIMIT 256",
        action_invocations::RECORD_COLUMNS
    );
    let mut statement = transaction.prepare(&sql).map_err(|source| {
        database_error(
            Path::new("action_invocations"),
            "provider invocation recovery prepare",
            source,
        )
    })?;
    let rows = statement
        .query_map(
            params![
                provider.provider_id.to_string(),
                to_safe_i64(provider.provider_epoch),
                provider.lease_id.to_string()
            ],
            action_invocations::row_to_record,
        )
        .map_err(|source| {
            database_error(
                Path::new("action_invocations"),
                "provider invocation recovery query",
                source,
            )
        })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|source| {
            database_error(
                Path::new("action_invocations"),
                "provider invocation recovery decode",
                source,
            )
        })
}

fn load_by_provider(
    transaction: &Transaction<'_>,
    provider_id: Uuid,
) -> Result<Option<ActionProviderRecoveryRecord>, StorageError> {
    transaction
        .query_row(
            "SELECT provider_id, provider_instance_id, provider_epoch, lease_id, registration_sequence, capability_claim_digest, owner_service_id, recover_until_ms FROM action_provider_recovery WHERE provider_id = ?1",
            [provider_id.to_string()],
            row_to_record,
        )
        .optional()
        .map_err(|source| database_error(Path::new("action_provider_recovery"), "provider recovery lookup", source))
}

fn load_by_instance(
    transaction: &Transaction<'_>,
    provider_instance_id: Uuid,
) -> Result<Option<ActionProviderRecoveryRecord>, StorageError> {
    transaction
        .query_row(
            "SELECT provider_id, provider_instance_id, provider_epoch, lease_id, registration_sequence, capability_claim_digest, owner_service_id, recover_until_ms FROM action_provider_recovery WHERE provider_instance_id = ?1",
            [provider_instance_id.to_string()],
            row_to_record,
        )
        .optional()
        .map_err(|source| database_error(Path::new("action_provider_recovery"), "provider recovery instance lookup", source))
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActionProviderRecoveryRecord> {
    Ok(ActionProviderRecoveryRecord {
        provider_id: parse_uuid(row, 0)?,
        provider_instance_id: parse_uuid(row, 1)?,
        provider_epoch: parse_safe_u64(row, 2)?,
        lease_id: parse_uuid(row, 3)?,
        registration_sequence: parse_safe_u64(row, 4)?,
        capability_claim_digest: row.get(5)?,
        owner_service_id: parse_uuid(row, 6)?,
        recover_until_ms: row.get(7)?,
    })
}

fn parse_uuid(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    let value: String = row.get(index)?;
    Uuid::parse_str(&value).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(source),
        )
    })
}

fn parse_safe_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(row.get::<_, i64>(index)?).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(source),
        )
    })
}

fn validate_record(record: &ActionProviderRecoveryRecord) -> Result<(), StorageError> {
    if record.provider_epoch == 0 || record.provider_epoch > MAX_SAFE_INTEGER {
        return Err(invalid("provider_epoch must be a positive safe integer"));
    }
    if record.registration_sequence == 0 || record.registration_sequence > MAX_SAFE_INTEGER {
        return Err(invalid(
            "registration_sequence must be a positive safe integer",
        ));
    }
    validate_digest(&record.capability_claim_digest)?;
    validate_time(record.recover_until_ms)
}

fn validate_digest(digest: &str) -> Result<(), StorageError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            "capability_claim_digest must be lowercase hexadecimal SHA-256",
        ));
    }
    Ok(())
}

fn validate_time(value: i64) -> Result<(), StorageError> {
    if value < 0 {
        return Err(invalid("recovery time must be nonnegative"));
    }
    Ok(())
}

fn to_safe_i64(value: u64) -> i64 {
    i64::try_from(value).expect("validated safe integer fits i64")
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidActionInvocation {
        message: message.into(),
    }
}

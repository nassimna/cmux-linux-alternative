use agent_workspace_core::ShortcutPlatform;
use agent_workspace_storage::{
    ActionInvocationCreate, ActionInvocationCreateOutcome, ActionInvocationIdentity,
    ActionInvocationState, ActionLifecycleOutcome, ActionProviderRecoveryAcquireOutcome,
    ActionProviderRecoveryRecord, MigrationOutcome, SCHEMA_VERSION, SqliteStateStore, StorageError,
};
use rusqlite::Connection;
use tempfile::TempDir;
use uuid::Uuid;

fn open(temp: &TempDir) -> (std::path::PathBuf, SqliteStateStore) {
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    (path, store)
}

fn recovery(
    seed: u128,
    owner: Uuid,
    digest: char,
    recover_until_ms: i64,
) -> ActionProviderRecoveryRecord {
    ActionProviderRecoveryRecord {
        provider_id: Uuid::from_u128(seed),
        provider_instance_id: Uuid::from_u128(seed + 1),
        provider_epoch: 7,
        lease_id: Uuid::from_u128(seed + 2),
        registration_sequence: 9,
        capability_claim_digest: digest.to_string().repeat(64),
        owner_service_id: owner,
        recover_until_ms,
    }
}

#[test]
fn v6_migrates_transactionally_to_strict_v7_without_credentials() {
    let temp = TempDir::new().unwrap();
    let (path, store) = open(&temp);
    drop(store);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "DROP TABLE agent_hibernation_confirmations;
             DROP TABLE agent_catalog_mutations;
             DROP TABLE agent_attention;
             DROP TABLE agent_team_members;
             DROP TABLE agent_teams;
             DROP TABLE agent_operations;
             DROP TABLE agent_sessions;
             DROP TABLE agent_catalog_state;
             DROP TABLE action_provider_recovery;
             DROP TABLE browser_automation_tombstones;
             DROP TABLE browser_automation_operations;
             DROP TABLE browser_automation_sessions;
             UPDATE migration_metadata SET target_version = 6 WHERE singleton = 1;
             PRAGMA user_version = 6;",
        )
        .unwrap();

    let (store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert!(matches!(
        outcome,
        MigrationOutcome::Upgraded {
            from: 6,
            to: SCHEMA_VERSION,
            ..
        }
    ));
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let columns = Connection::open(&path)
        .unwrap()
        .prepare("SELECT name FROM pragma_table_info('action_provider_recovery')")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(!columns.iter().any(|column| column.contains("proof")));
}

#[test]
fn failed_v6_to_v7_migration_rolls_back_version_claim() {
    let temp = TempDir::new().unwrap();
    let (path, store) = open(&temp);
    drop(store);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "DROP TABLE action_provider_recovery;
             CREATE TABLE action_provider_recovery (broken INTEGER);
             UPDATE migration_metadata SET target_version = 6 WHERE singleton = 1;
             PRAGMA user_version = 6;",
        )
        .unwrap();
    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::Migration { from: 6, to: 7, .. })
    ));
    let version: u32 = Connection::open(&path)
        .unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 6);
}

#[test]
fn recovery_is_exact_single_use_and_rotates_the_service_fence() {
    let temp = TempDir::new().unwrap();
    let (_, store) = open(&temp);
    let old_owner = Uuid::new_v4();
    let new_owner = Uuid::new_v4();
    let row = recovery(100, old_owner, 'a', 10_000);
    assert!(store.persist_action_provider_recovery(&row, 100).unwrap());

    assert_eq!(
        store
            .acquire_action_provider_recovery(
                row.provider_instance_id,
                &"b".repeat(64),
                new_owner,
                200,
                20_000,
            )
            .unwrap(),
        ActionProviderRecoveryAcquireOutcome::Mismatch
    );
    assert!(
        store
            .action_provider_recovery_owner_valid(row.provider_id, old_owner, 200)
            .unwrap()
    );
    let acquired = store
        .acquire_action_provider_recovery(
            row.provider_instance_id,
            &row.capability_claim_digest,
            new_owner,
            200,
            20_000,
        )
        .unwrap();
    assert!(matches!(
        acquired,
        ActionProviderRecoveryAcquireOutcome::Acquired { ref provider, ref invocations }
            if provider.owner_service_id == new_owner && invocations.is_empty()
    ));
    assert!(
        !store
            .action_provider_recovery_owner_valid(row.provider_id, old_owner, 200)
            .unwrap()
    );
    assert!(
        store
            .action_provider_recovery_owner_valid(row.provider_id, new_owner, 200)
            .unwrap()
    );
    assert_eq!(
        store
            .acquire_action_provider_recovery(
                row.provider_instance_id,
                &row.capability_claim_digest,
                new_owner,
                201,
                20_001,
            )
            .unwrap(),
        ActionProviderRecoveryAcquireOutcome::Mismatch
    );
}

#[test]
fn acquire_reconstructs_only_exact_nonterminal_identity_and_closes_lease_crash_window() {
    let temp = TempDir::new().unwrap();
    let (_, store) = open(&temp);
    let epoch = store.current_idempotency_epoch().unwrap();
    let owner = Uuid::new_v4();
    let row = recovery(200, owner, 'c', 10_000);
    assert!(store.persist_action_provider_recovery(&row, 100).unwrap());

    let create = |seed: u128| ActionInvocationCreate {
        invocation_id: Uuid::from_u128(seed),
        epoch,
        idempotency_key: Uuid::from_u128(seed + 1_000),
        request_hash: format!("{seed:064x}"),
        action_id: "desktop.window.focus".to_owned(),
        action_version: 1,
        correlation_id: Uuid::from_u128(seed + 2_000),
        caller_id: Uuid::from_u128(seed + 3_000),
        parameters_json: "{}".to_owned(),
        accepted_at_ms: 100,
        expires_at_ms: 30_000,
    };
    let exact = ActionInvocationIdentity {
        attempt_epoch: row.provider_epoch,
        provider_id: row.provider_id,
        provider_epoch: row.provider_epoch,
        provider_lease_id: row.lease_id,
        window_id: Uuid::from_u128(999),
        window_generation: 1,
    };
    let request = create(300);
    assert!(matches!(
        store.create_action_invocation(&request).unwrap(),
        ActionInvocationCreateOutcome::Created(_)
    ));
    assert!(matches!(
        store
            .lease_action_invocation(request.invocation_id, request.correlation_id, &exact, 101)
            .unwrap(),
        ActionLifecycleOutcome::Applied(_)
    ));

    let other_request = create(400);
    assert!(matches!(
        store.create_action_invocation(&other_request).unwrap(),
        ActionInvocationCreateOutcome::Created(_)
    ));
    let mut other = exact.clone();
    other.provider_id = Uuid::new_v4();
    assert!(matches!(
        store
            .lease_action_invocation(
                other_request.invocation_id,
                other_request.correlation_id,
                &other,
                101
            )
            .unwrap(),
        ActionLifecycleOutcome::Applied(_)
    ));

    let outcome = store
        .acquire_action_provider_recovery(
            row.provider_instance_id,
            &row.capability_claim_digest,
            Uuid::new_v4(),
            200,
            20_000,
        )
        .unwrap();
    let ActionProviderRecoveryAcquireOutcome::Acquired { invocations, .. } = outcome else {
        panic!("expected recovery acquisition");
    };
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0].invocation_id, request.invocation_id);
    assert_eq!(invocations[0].state, ActionInvocationState::Dispatched);
}

#[test]
fn expired_recovery_fails_closed_and_is_pruned() {
    let temp = TempDir::new().unwrap();
    let (_, store) = open(&temp);
    let row = recovery(500, Uuid::new_v4(), 'd', 500);
    assert!(store.persist_action_provider_recovery(&row, 100).unwrap());
    assert_eq!(
        store
            .acquire_action_provider_recovery(
                row.provider_instance_id,
                &row.capability_claim_digest,
                Uuid::new_v4(),
                500,
                20_000,
            )
            .unwrap(),
        ActionProviderRecoveryAcquireOutcome::Expired
    );
    assert!(
        !store
            .action_provider_recovery_owner_valid(row.provider_id, row.owner_service_id, 500)
            .unwrap()
    );
}

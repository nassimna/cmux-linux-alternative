use agent_workspace_core::{MAX_SAFE_INTEGER, ShortcutPlatform};
use agent_workspace_storage::{
    ACTION_FULL_RESULT_CAP, ACTION_FULL_RESULT_RETENTION_MS, ACTION_INVOCATION_GLOBAL_CAP,
    ACTION_INVOCATION_PROVIDER_CAP, ACTION_TOMBSTONE_CAP, ActionInvocationCreate,
    ActionInvocationCreateOutcome, ActionInvocationIdentity, ActionInvocationState,
    ActionLifecycleOutcome, ActionRecoveryQuery, ActionStartClaim, ActionTerminalAck,
    MigrationOutcome, RecoveryClassification, SCHEMA_VERSION, SqliteStateStore, StorageError,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;
use uuid::Uuid;

fn create(epoch: Uuid, seed: u128, at: i64) -> ActionInvocationCreate {
    ActionInvocationCreate {
        invocation_id: Uuid::from_u128(seed),
        epoch,
        idempotency_key: Uuid::from_u128(10_000 + seed),
        request_hash: format!("{seed:064x}"),
        action_id: "workspace.focus".to_owned(),
        action_version: 1,
        correlation_id: Uuid::from_u128(20_000 + seed),
        caller_id: Uuid::from_u128(30_000 + seed),
        parameters_json: format!(r#"{{"seed":{seed}}}"#),
        accepted_at_ms: at,
        expires_at_ms: at + 30_000,
    }
}

fn identity(seed: u128, provider: Uuid) -> ActionInvocationIdentity {
    let integer_seed = u64::try_from(seed).unwrap();
    ActionInvocationIdentity {
        attempt_epoch: 40_000 + integer_seed,
        provider_id: provider,
        provider_epoch: 50_000 + integer_seed,
        provider_lease_id: Uuid::from_u128(60_000 + seed),
        window_id: Uuid::from_u128(70_000 + seed),
        window_generation: 1,
    }
}

fn created(
    outcome: ActionInvocationCreateOutcome,
) -> agent_workspace_storage::ActionInvocationRecord {
    match outcome {
        ActionInvocationCreateOutcome::Created(record) => record,
        other => panic!("expected created invocation, got {other:?}"),
    }
}

fn open(temp: &TempDir) -> (std::path::PathBuf, SqliteStateStore, Uuid) {
    let path = temp.path().join("state.sqlite3");
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let epoch = store.current_idempotency_epoch().unwrap();
    (path, store, epoch)
}

fn advance_to_grant(
    store: &SqliteStateStore,
    request: &ActionInvocationCreate,
    exact: &ActionInvocationIdentity,
) {
    assert!(matches!(
        store
            .lease_action_invocation(
                request.invocation_id,
                request.correlation_id,
                exact,
                request.accepted_at_ms + 1,
            )
            .unwrap(),
        ActionLifecycleOutcome::Applied(_)
    ));
    assert!(matches!(
        store
            .mark_action_dispatched(
                request.invocation_id,
                request.correlation_id,
                exact,
                request.accepted_at_ms + 2,
            )
            .unwrap(),
        ActionLifecycleOutcome::Applied(_)
    ));
    assert!(matches!(
        store
            .claim_action_start(&ActionStartClaim {
                invocation_id: request.invocation_id,
                correlation_id: request.correlation_id,
                action_id: request.action_id.clone(),
                action_version: request.action_version,
                identity: exact.clone(),
                claimed_at_ms: request.accepted_at_ms + 3,
            })
            .unwrap(),
        ActionLifecycleOutcome::Applied(ref row)
            if row.state == ActionInvocationState::StartGranted
    ));
}

#[test]
fn v5_migrates_transactionally_to_strict_v6_and_reopens_idempotently() {
    let temp = TempDir::new().unwrap();
    let (path, store, _) = open(&temp);
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
             DROP TABLE action_invocation_tombstones;
             DROP TABLE action_invocations;
             UPDATE migration_metadata SET target_version = 5 WHERE singleton = 1;
             PRAGMA user_version = 5;",
        )
        .unwrap();

    let (store, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert!(matches!(
        outcome,
        MigrationOutcome::Upgraded {
            from: 5,
            to: SCHEMA_VERSION,
            ..
        }
    ));
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    drop(store);
    let (_, outcome) =
        SqliteStateStore::open_with_report(&path, ShortcutPlatform::NonMacOs).unwrap();
    assert_eq!(
        outcome,
        MigrationOutcome::Current {
            version: SCHEMA_VERSION
        }
    );
}

#[test]
fn strict_v6_verification_rejects_a_missing_lifecycle_table() {
    let temp = TempDir::new().unwrap();
    let (path, store, _) = open(&temp);
    drop(store);
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE action_invocations;")
        .unwrap();
    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::CorruptSchema { .. })
    ));
}

#[test]
fn failed_v5_to_v6_migration_rolls_back_without_claiming_the_new_version() {
    let temp = TempDir::new().unwrap();
    let (path, store, _) = open(&temp);
    drop(store);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "DROP TABLE action_provider_recovery;
             DROP TABLE action_invocation_tombstones;
             DROP TABLE action_invocations;
             CREATE TABLE action_invocations (broken INTEGER);
             UPDATE migration_metadata SET target_version = 5 WHERE singleton = 1;
             PRAGMA user_version = 5;",
        )
        .unwrap();
    assert!(matches!(
        SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs),
        Err(StorageError::Migration { from: 5, to: 6, .. })
    ));
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 5);
    let columns: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('action_invocations')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(columns, 1);
}

#[test]
fn exact_lifecycle_grants_once_and_terminal_ack_replays_once() {
    let temp = TempDir::new().unwrap();
    let (_, store, epoch) = open(&temp);
    let request = create(epoch, 1, 100);
    let mut exact = identity(1, Uuid::from_u128(900));
    exact.attempt_epoch = MAX_SAFE_INTEGER;
    exact.provider_epoch = MAX_SAFE_INTEGER;
    created(store.create_action_invocation(&request).unwrap());

    let early = ActionTerminalAck {
        invocation_id: request.invocation_id,
        correlation_id: request.correlation_id,
        action_id: request.action_id.clone(),
        action_version: request.action_version,
        identity: exact.clone(),
        state: ActionInvocationState::Acknowledged,
        terminal_code: "succeeded".to_owned(),
        error_code: None,
        result_json: Some(r#"{"done":true}"#.to_owned()),
        completed_at_ms: 101,
    };
    assert_eq!(
        store.acknowledge_action_terminal(&early).unwrap(),
        ActionLifecycleOutcome::Mismatch
    );
    advance_to_grant(&store, &request, &exact);

    let claim = ActionStartClaim {
        invocation_id: request.invocation_id,
        correlation_id: request.correlation_id,
        action_id: request.action_id.clone(),
        action_version: request.action_version,
        identity: exact.clone(),
        claimed_at_ms: 103,
    };
    assert!(matches!(
        store.claim_action_start(&claim).unwrap(),
        ActionLifecycleOutcome::Replay(ref row) if row.identity.as_ref() == Some(&exact)
    ));
    let mut wrong_claim = claim.clone();
    wrong_claim.identity.attempt_epoch -= 1;
    assert_eq!(
        store.claim_action_start(&wrong_claim).unwrap(),
        ActionLifecycleOutcome::Mismatch
    );

    let ack = ActionTerminalAck {
        completed_at_ms: 104,
        ..early
    };
    assert!(matches!(
        store.acknowledge_action_terminal(&ack).unwrap(),
        ActionLifecycleOutcome::Applied(ref row)
            if row.state == ActionInvocationState::Acknowledged
    ));
    assert!(matches!(
        store.acknowledge_action_terminal(&ack).unwrap(),
        ActionLifecycleOutcome::Terminal(ref terminal)
            if terminal.terminal_code == "succeeded"
    ));
    let mut conflicting = ack;
    conflicting.state = ActionInvocationState::Failed;
    conflicting.terminal_code = "failed".to_owned();
    conflicting.error_code = Some("target_stale".to_owned());
    conflicting.result_json = None;
    assert_eq!(
        store.acknowledge_action_terminal(&conflicting).unwrap(),
        ActionLifecycleOutcome::Mismatch
    );
    assert!(matches!(
        store.create_action_invocation(&request).unwrap(),
        ActionInvocationCreateOutcome::Replay(ref terminal)
            if terminal.result_json.as_deref() == Some(r#"{"done":true}"#)
    ));
}

#[test]
fn cancel_and_start_grant_are_atomic_and_post_grant_cancel_is_not_promised() {
    let temp = TempDir::new().unwrap();
    let (_, store, epoch) = open(&temp);
    let before = create(epoch, 1, 100);
    let exact = identity(1, Uuid::from_u128(900));
    created(store.create_action_invocation(&before).unwrap());
    store
        .lease_action_invocation(before.invocation_id, before.correlation_id, &exact, 101)
        .unwrap();
    store
        .mark_action_dispatched(before.invocation_id, before.correlation_id, &exact, 102)
        .unwrap();
    assert!(matches!(
        store
            .cancel_action_invocation(before.invocation_id, before.correlation_id, "canceled", 103)
            .unwrap(),
        ActionLifecycleOutcome::Applied(ref row) if row.state == ActionInvocationState::Canceled
    ));
    assert!(matches!(
        store
            .claim_action_start(&ActionStartClaim {
                invocation_id: before.invocation_id,
                correlation_id: before.correlation_id,
                action_id: before.action_id.clone(),
                action_version: before.action_version,
                identity: exact.clone(),
                claimed_at_ms: 104,
            })
            .unwrap(),
        ActionLifecycleOutcome::Terminal(ref terminal)
            if terminal.state == ActionInvocationState::Canceled
    ));

    let after = create(epoch, 2, 200);
    let after_identity = identity(2, Uuid::from_u128(901));
    created(store.create_action_invocation(&after).unwrap());
    advance_to_grant(&store, &after, &after_identity);
    assert_eq!(
        store
            .cancel_action_invocation(after.invocation_id, after.correlation_id, "canceled", 204)
            .unwrap(),
        ActionLifecycleOutcome::CancellationNotGuaranteed
    );
    assert!(matches!(
        store
            .acknowledge_action_terminal(&ActionTerminalAck {
                invocation_id: after.invocation_id,
                correlation_id: after.correlation_id,
                action_id: after.action_id.clone(),
                action_version: after.action_version,
                identity: after_identity,
                state: ActionInvocationState::Canceled,
                terminal_code: "canceled".to_owned(),
                error_code: None,
                result_json: None,
                completed_at_ms: 205,
            })
            .unwrap(),
        ActionLifecycleOutcome::Applied(ref row) if row.state == ActionInvocationState::Canceled
    ));
}

#[test]
fn late_start_claim_expires_atomically_and_failure_code_replays_exactly() {
    let temp = TempDir::new().unwrap();
    let (_, store, epoch) = open(&temp);
    let mut expired = create(epoch, 11, 100);
    expired.expires_at_ms = 103;
    let expired_identity = identity(11, Uuid::from_u128(911));
    created(store.create_action_invocation(&expired).unwrap());
    store
        .lease_action_invocation(
            expired.invocation_id,
            expired.correlation_id,
            &expired_identity,
            101,
        )
        .unwrap();
    store
        .mark_action_dispatched(
            expired.invocation_id,
            expired.correlation_id,
            &expired_identity,
            102,
        )
        .unwrap();
    assert!(matches!(
        store
            .claim_action_start(&ActionStartClaim {
                invocation_id: expired.invocation_id,
                correlation_id: expired.correlation_id,
                action_id: expired.action_id.clone(),
                action_version: expired.action_version,
                identity: expired_identity,
                claimed_at_ms: 103,
            })
            .unwrap(),
        ActionLifecycleOutcome::Terminal(ref terminal)
            if terminal.state == ActionInvocationState::Expired
    ));

    let failed = create(epoch, 12, 200);
    let failed_identity = identity(12, Uuid::from_u128(912));
    created(store.create_action_invocation(&failed).unwrap());
    advance_to_grant(&store, &failed, &failed_identity);
    let failure = ActionTerminalAck {
        invocation_id: failed.invocation_id,
        correlation_id: failed.correlation_id,
        action_id: failed.action_id.clone(),
        action_version: failed.action_version,
        identity: failed_identity,
        state: ActionInvocationState::Failed,
        terminal_code: "failed".to_owned(),
        error_code: Some("target_stale".to_owned()),
        result_json: None,
        completed_at_ms: 204,
    };
    assert!(matches!(
        store.acknowledge_action_terminal(&failure).unwrap(),
        ActionLifecycleOutcome::Applied(ref record)
            if record.terminal.as_ref().and_then(|terminal| terminal.error_code.as_deref())
                == Some("target_stale")
    ));
    assert!(matches!(
        store.acknowledge_action_terminal(&failure).unwrap(),
        ActionLifecycleOutcome::Terminal(ref terminal)
            if terminal.error_code.as_deref() == Some("target_stale")
    ));
    assert!(matches!(
        store.create_action_invocation(&failed).unwrap(),
        ActionInvocationCreateOutcome::Replay(ref terminal)
            if terminal.error_code.as_deref() == Some("target_stale")
    ));
}

#[test]
fn recovery_queries_and_nonterminal_limits_are_bounded() {
    let temp = TempDir::new().unwrap();
    let (_, store, epoch) = open(&temp);
    let provider = Uuid::from_u128(999);
    for seed in 1..=ACTION_INVOCATION_PROVIDER_CAP + 1 {
        let request = create(epoch, seed as u128, 100);
        created(store.create_action_invocation(&request).unwrap());
        let outcome = store
            .lease_action_invocation(
                request.invocation_id,
                request.correlation_id,
                &identity(seed as u128, provider),
                101,
            )
            .unwrap();
        if seed <= ACTION_INVOCATION_PROVIDER_CAP {
            assert!(matches!(outcome, ActionLifecycleOutcome::Applied(_)));
        } else {
            assert_eq!(outcome, ActionLifecycleOutcome::ResourceLimit);
        }
    }
    assert_eq!(
        store
            .recover_action_invocations(ActionRecoveryQuery::AllNonterminal, 256)
            .unwrap()
            .len(),
        ACTION_INVOCATION_PROVIDER_CAP + 1
    );
    assert_eq!(
        store
            .recover_action_invocations(ActionRecoveryQuery::ExpiredAtOrBefore(30_100), 256)
            .unwrap()
            .len(),
        ACTION_INVOCATION_PROVIDER_CAP + 1
    );
    let expired = create(epoch, 1, 100);
    assert!(matches!(
        store
            .terminate_action_before_start(
                expired.invocation_id,
                expired.correlation_id,
                ActionInvocationState::Expired,
                "expired",
                30_100,
            )
            .unwrap(),
        ActionLifecycleOutcome::Applied(ref row) if row.state == ActionInvocationState::Expired
    ));

    let second = TempDir::new().unwrap();
    let (_, store, epoch) = open(&second);
    for seed in 1..=ACTION_INVOCATION_GLOBAL_CAP {
        created(
            store
                .create_action_invocation(&create(epoch, seed as u128, 100))
                .unwrap(),
        );
    }
    assert_eq!(
        store
            .create_action_invocation(&create(epoch, 1_000, 100))
            .unwrap(),
        ActionInvocationCreateOutcome::ResourceLimit
    );
}

#[test]
fn full_results_prune_by_age_and_count_into_replay_safe_tombstones() {
    let temp = TempDir::new().unwrap();
    let (path, store, epoch) = open(&temp);
    drop(store);
    let evicted = create(epoch, 1, 1);
    let connection = Connection::open(&path).unwrap();
    connection.execute(
        "INSERT INTO action_invocations (invocation_id, epoch, idempotency_key, request_hash, action_id, action_version, correlation_id, caller_id, parameters_json, state, terminal_code, result_json, accepted_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, 'acknowledged', 'succeeded', '{}', 1, 2, 100, 2)",
        params![evicted.invocation_id.to_string(), epoch.to_string(), evicted.idempotency_key.to_string(), evicted.request_hash, evicted.action_id, evicted.correlation_id.to_string(), evicted.caller_id.to_string(), evicted.parameters_json],
    ).unwrap();
    connection.execute(
        "WITH RECURSIVE cnt(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM cnt WHERE x <= ?1) INSERT INTO action_invocations (invocation_id, epoch, idempotency_key, request_hash, action_id, action_version, correlation_id, caller_id, parameters_json, state, terminal_code, result_json, accepted_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms) SELECT printf('00000000-0000-0000-0001-%012d', x), ?2, printf('10000000-0000-0000-0001-%012d', x), ?3, 'workspace.focus', 1, printf('20000000-0000-0000-0001-%012d', x), printf('30000000-0000-0000-0001-%012d', x), '{}', 'acknowledged', 'succeeded', '{}', 1000, 1001, 2000, 1001 FROM cnt",
        params![i64::try_from(ACTION_FULL_RESULT_CAP).unwrap(), epoch.to_string(), "b".repeat(64)],
    ).unwrap();
    drop(connection);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let report = store.prune_action_invocations(1_000_000).unwrap();
    assert!(report.full_results_compacted >= 1);
    assert!(matches!(
        store.create_action_invocation(&evicted).unwrap(),
        ActionInvocationCreateOutcome::ResultExpired { ref terminal_code }
            if terminal_code == "succeeded"
    ));
    let connection = Connection::open(&path).unwrap();
    let retained: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM action_invocations WHERE terminal_at_ms IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(retained <= i64::try_from(ACTION_FULL_RESULT_CAP).unwrap());
    drop(connection);

    let connection = Connection::open(&path).unwrap();
    connection.execute(
        "INSERT INTO action_invocations (invocation_id, epoch, idempotency_key, request_hash, action_id, action_version, correlation_id, caller_id, parameters_json, state, terminal_code, error_code, result_json, accepted_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms) VALUES ('50000000-0000-0000-0000-000000000001', ?1, '60000000-0000-0000-0000-000000000001', ?2, 'workspace.focus', 1, '70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '{}', 'failed', 'failed', 'execution_failed', NULL, 1, 2, 100, 2)",
        params![epoch.to_string(), "d".repeat(64)],
    ).unwrap();
    drop(connection);
    let age_report = store
        .prune_action_invocations(ACTION_FULL_RESULT_RETENTION_MS + 3)
        .unwrap();
    assert_eq!(age_report.full_results_compacted, 1);
}

#[test]
fn invocation_parameter_and_result_payloads_enforce_the_64_kib_bound() {
    let temp = TempDir::new().unwrap();
    let (_, store, epoch) = open(&temp);
    let mut oversized = create(epoch, 1, 100);
    oversized.parameters_json = format!(r#"{{"value":"{}"}}"#, "x".repeat(64 * 1_024));
    assert!(matches!(
        store.create_action_invocation(&oversized),
        Err(StorageError::InvalidActionInvocation { .. })
    ));

    let request = create(epoch, 2, 200);
    let exact = identity(2, Uuid::from_u128(900));
    created(store.create_action_invocation(&request).unwrap());
    advance_to_grant(&store, &request, &exact);
    let result = format!(r#"{{"value":"{}"}}"#, "x".repeat(64 * 1_024));
    assert!(matches!(
        store.acknowledge_action_terminal(&ActionTerminalAck {
            invocation_id: request.invocation_id,
            correlation_id: request.correlation_id,
            action_id: request.action_id.clone(),
            action_version: request.action_version,
            identity: exact,
            state: ActionInvocationState::Acknowledged,
            terminal_code: "succeeded".to_owned(),
            error_code: None,
            result_json: Some(result),
            completed_at_ms: 204,
        }),
        Err(StorageError::InvalidActionInvocation { .. })
    ));
}

#[test]
fn direct_storage_calls_cannot_bypass_identifier_object_or_terminal_consistency_rules() {
    let temp = TempDir::new().unwrap();
    let (_, store, epoch) = open(&temp);
    for (seed, action_id) in [(1, "not_namespaced"), (2, "Workspace.Focus"), (3, "a..b")] {
        let mut request = create(epoch, seed, 100);
        request.action_id = action_id.to_owned();
        assert!(matches!(
            store.create_action_invocation(&request),
            Err(StorageError::InvalidActionInvocation { .. })
        ));
    }
    let mut array_parameters = create(epoch, 4, 100);
    array_parameters.parameters_json = "[]".to_owned();
    assert!(matches!(
        store.create_action_invocation(&array_parameters),
        Err(StorageError::InvalidActionInvocation { .. })
    ));

    let request = create(epoch, 5, 200);
    let exact = identity(5, Uuid::from_u128(905));
    created(store.create_action_invocation(&request).unwrap());
    advance_to_grant(&store, &request, &exact);
    for (state, code, error, result) in [
        (ActionInvocationState::Acknowledged, "succeeded", None, None),
        (
            ActionInvocationState::Acknowledged,
            "failed",
            None,
            Some("{}"),
        ),
        (
            ActionInvocationState::Failed,
            "failed",
            Some("target_stale"),
            Some("{}"),
        ),
        (
            ActionInvocationState::Canceled,
            "canceled",
            None,
            Some("{}"),
        ),
        (ActionInvocationState::Expired, "interrupted", None, None),
        (
            ActionInvocationState::Acknowledged,
            "succeeded",
            None,
            Some("[]"),
        ),
    ] {
        assert!(matches!(
            store.acknowledge_action_terminal(&ActionTerminalAck {
                invocation_id: request.invocation_id,
                correlation_id: request.correlation_id,
                action_id: request.action_id.clone(),
                action_version: request.action_version,
                identity: exact.clone(),
                state,
                terminal_code: code.to_owned(),
                error_code: error.map(str::to_owned),
                result_json: result.map(str::to_owned),
                completed_at_ms: 204,
            }),
            Err(StorageError::InvalidActionInvocation { .. })
        ));
    }

    let classification =
        RecoveryClassification::from_storage_error(&StorageError::InvalidActionInvocation {
            message: "private-action-and-path".to_owned(),
        });
    assert_eq!(
        classification,
        RecoveryClassification::CorruptSqlite {
            message: "action invocation request failed validation".to_owned()
        }
    );
}

#[test]
fn destructive_tombstone_pruning_rotates_epoch_for_count_and_age() {
    let temp = TempDir::new().unwrap();
    let (path, store, epoch) = open(&temp);
    drop(store);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO idempotency_results (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms) VALUES ('workspace.action', ?1, '90000000-0000-0000-0000-000000000001', ?2, '{}', 1000)",
            params![epoch.to_string(), "e".repeat(64)],
        )
        .unwrap();
    connection.execute(
        "WITH RECURSIVE cnt(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM cnt WHERE x <= ?1) INSERT INTO action_invocation_tombstones (epoch, idempotency_key, request_hash, terminal_code, completed_at_ms) SELECT ?2, printf('40000000-0000-0000-0001-%012d', x), ?3, 'succeeded', 1000 FROM cnt",
        params![i64::try_from(ACTION_TOMBSTONE_CAP).unwrap(), epoch.to_string(), "c".repeat(64)],
    ).unwrap();
    drop(connection);
    let store = SqliteStateStore::open(&path, ShortcutPlatform::NonMacOs).unwrap();
    let report = store.prune_action_invocations(2_000).unwrap();
    let rotated = report
        .epoch_rotated_to
        .expect("count pruning rotates epoch");
    assert_ne!(rotated, epoch);
    assert_eq!(store.current_idempotency_epoch().unwrap(), rotated);
    let retained_prior_results: i64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM idempotency_results", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(retained_prior_results, 0);
    assert_eq!(
        store
            .create_action_invocation(&create(epoch, 1, 2_000))
            .unwrap(),
        ActionInvocationCreateOutcome::EpochExpired
    );

    let request = create(rotated, 2, 3_000);
    created(store.create_action_invocation(&request).unwrap());
    assert!(matches!(
        store
            .cancel_action_invocation(
                request.invocation_id,
                request.correlation_id,
                "canceled",
                3_001
            )
            .unwrap(),
        ActionLifecycleOutcome::Applied(_)
    ));
    let age_report = store.prune_action_invocations(i64::MAX / 4).unwrap();
    assert!(age_report.epoch_rotated_to.is_some());
}

#[test]
fn explicit_epoch_rotation_clears_action_tombstones() {
    let temp = TempDir::new().unwrap();
    let (path, store, epoch) = open(&temp);
    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO action_invocation_tombstones (epoch, idempotency_key, request_hash, terminal_code, completed_at_ms) VALUES (?1, ?2, ?3, 'succeeded', 1)",
            params![
                epoch.to_string(),
                Uuid::from_u128(91_001).to_string(),
                "f".repeat(64)
            ],
        )
        .unwrap();

    let rotated = store.rotate_idempotency_epoch().unwrap();
    assert_ne!(rotated, epoch);
    let retained: i64 = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM action_invocation_tombstones",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 0);
}

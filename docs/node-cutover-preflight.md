# Node cutover observation

Run this from the repository on Linux with exact absolute paths to the Rust source database and an existing isolated Node backup and working copy:

```sh
pnpm --filter @agent-workspace/server preflight:cutover /absolute/source.sqlite3 /absolute/backup.sqlite3 /absolute/working.sqlite3
```

The command prints a JSON observation and exits with status 2 while blockers remain. It never starts either service, claims an owner lock, updates the copy manifest, or transfers ownership. It copies the source database and any WAL to a private temporary directory for schema inspection, then removes that temporary snapshot. The source files are opened only for reading. A source that changes during the observation fails closed. A successful source observation includes its device and inode, snapshot revision, main-file SHA-256, and WAL SHA-256. This is a point-in-time observation, not a durable cutover authorization.

New isolated copies have a version 3 manifest with source file identity, snapshot revision, main/WAL digests, and a logical SHA-256 over the SQLite schema and every table row, including hidden row IDs where SQLite provides them. Copy preparation compares the backup's logical digest with a stable source observation after SQLite creates the backup. This catches a write to another table between backup and observation even when `application_snapshot.revision` is unchanged. Preflight checks source stability and backup equality again; it reports `sourceBound: true` only while all checks match. Version 1 and 2 preview copies remain resumable but lack the full binding and cannot qualify cutover. A matching manifest is still insufficient for live transfer: the backup and source are not created under a shared exclusive service fence, and no rollback protocol has been qualified.

The external inventory reports only presence and file safety for Rust desktop settings at `userData/configuration/desktop.json`, a possible Node `config.json` beside the database, remote known hosts, the encrypted search database, and its key locator. It does not read those files' contents. Secret Service credentials and content keys, Codex or other agent profiles and session files, Rust process ownership, and rollback readiness require separate qualification. The report never marks the system ready for cutover or proves exclusive live ownership.

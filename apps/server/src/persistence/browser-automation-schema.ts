import type Database from 'better-sqlite3'

import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'

export const BROWSER_AUTOMATION_OPERATIONS_SCHEMA_SQL =
  RUST_SCHEMA_V15_SQL.browser_automation_operations
    .replace("'keyAt', 'screenshot'", "'keyAt', 'screenshot', 'evaluate', 'console', 'errors'")
    .replace("'query', 'screenshot'", "'query', 'screenshot', 'evaluation', 'console', 'errors'")

function normalize(sql: string): string {
  return sql
    .replace(/"browser_automation_operations"/g, 'browser_automation_operations')
    .replace(/\s/g, '')
}

/** Expand the Node operation enums without changing retained operation identities or results. */
export function migrateBrowserAutomationSchema(database: Database.Database): void {
  const definition = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'browser_automation_operations'"
    )
    .get() as { sql: string }
  if (normalize(definition.sql) === normalize(BROWSER_AUTOMATION_OPERATIONS_SCHEMA_SQL)) return
  if (normalize(definition.sql) !== normalize(RUST_SCHEMA_V15_SQL.browser_automation_operations)) {
    throw new Error('Browser automation operation table definition is incompatible')
  }
  database
    .transaction(() => {
      const sequence = database
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'browser_automation_operations'")
        .get() as { seq: number } | undefined
      const objects = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name = 'browser_automation_operations' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
        )
        .all() as { sql: string }[]
      database.exec(
        BROWSER_AUTOMATION_OPERATIONS_SCHEMA_SQL.replace(
          'CREATE TABLE browser_automation_operations',
          'CREATE TABLE node_browser_automation_operations'
        )
      )
      database.exec(`INSERT INTO node_browser_automation_operations SELECT * FROM browser_automation_operations;
      DROP TABLE browser_automation_operations;
      ALTER TABLE node_browser_automation_operations RENAME TO browser_automation_operations;`)
      if (sequence) {
        database
          .prepare("DELETE FROM sqlite_sequence WHERE name = 'browser_automation_operations'")
          .run()
        database
          .prepare(
            "INSERT INTO sqlite_sequence (name, seq) VALUES ('browser_automation_operations', ?)"
          )
          .run(sequence.seq)
      }
      for (const { sql } of objects) database.exec(sql)
      if (database.prepare('PRAGMA foreign_key_check(browser_automation_operations)').get()) {
        throw new Error('Browser automation operation foreign keys are invalid')
      }
    })
    .immediate()
}

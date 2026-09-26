/**
 * Schema migrations for versioned System 1 contracts.
 *
 * Stored records carry their schema version. Migrations upgrade a record
 * from one version to the next; the registry composes them for multi-version
 * jumps. Unknown versions and failed migrations are contract violations.
 *
 * @module @deepseek-ai/dsh-system1-contracts/migrations
 */

import { system1Error } from './errors.ts'
import { CONTRACT_SCHEMA_VERSION } from './schemas.ts'

/** A stored record with its schema version. */
export interface VersionedRecord {
  readonly schemaVersion: number
  readonly [key: string]: unknown
}

/** Migrate a record from version N to version N+1. */
export type Migration = (record: VersionedRecord) => VersionedRecord

/** Registry of migrations keyed by the version they migrate FROM. */
const MIGRATIONS: Record<number, Migration> = {
  // Version 1 is current; no migrations yet. Future versions add entries here.
}

/**
 * Register a migration (for tests and future version upgrades).
 * @param fromVersion - version the migration upgrades from.
 * @param migration - migration function.
 */
export function __registerMigration(fromVersion: number, migration: Migration): void {
  MIGRATIONS[fromVersion] = migration
}

/**
 * Migrate a record to the current contract schema version.
 * @param record - stored record with a schemaVersion field.
 * @param targetVersion - version to migrate to (defaults to current).
 * @returns the record at the target schema version.
 * @throws System1Error on unknown version or failed migration.
 */
export function migrateToCurrent(record: VersionedRecord, targetVersion: number = CONTRACT_SCHEMA_VERSION): VersionedRecord {
  if (!Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) {
    throw system1Error('CORRUPT_RECORD', 'Record has no valid schemaVersion', {
      schemaVersion: record.schemaVersion,
    })
  }
  if (record.schemaVersion > targetVersion) {
    throw system1Error('MIGRATION_FAILED', 'Record version is newer than supported', {
      recordVersion: record.schemaVersion,
      supportedVersion: targetVersion,
    })
  }
  let current = record
  while (current.schemaVersion < targetVersion) {
    const migration = MIGRATIONS[current.schemaVersion]
    if (!migration) {
      throw system1Error('MIGRATION_FAILED', `No migration from version ${current.schemaVersion}`, {
        fromVersion: current.schemaVersion,
      })
    }
    try {
      const next = migration(current)
      if (next.schemaVersion !== current.schemaVersion + 1) {
        throw system1Error('MIGRATION_FAILED', 'Migration did not advance the version by one', {
          fromVersion: current.schemaVersion,
          toVersion: next.schemaVersion,
        })
      }
      current = next
    } catch (error) {
      if (error instanceof Error && error.name === 'System1Error') throw error
      throw system1Error('MIGRATION_FAILED', `Migration from version ${current.schemaVersion} failed`, {
        fromVersion: current.schemaVersion,
        cause: String(error),
      })
    }
  }
  return current
}

import path from 'node:path';

import { defaultExec } from './release-registry.mjs';
import { sanitizeDetail } from './release-state-store.mjs';

/**
 * Read-only database integrity probe.
 *
 * This exists to answer one question before a rollback is attempted: is the
 * database itself sound?
 *
 * Rollback restores the previous *image pair* and deliberately never restores an
 * older database, because reinstating an older database would discard writes
 * users made after the migration. That means a rollback cannot repair a corrupt
 * database — it would put older code in front of a damaged file and keep serving.
 * So a database-integrity failure is a hard stop with an alert, not a recovery
 * action.
 *
 * The probe opens the file read-only through a SQLite URI, so it can never write,
 * create, or migrate anything, and it runs against the host mount rather than
 * through the application container — a container that is already failing its
 * health check is exactly the one that cannot be relied on to answer.
 */

export const DATABASE_INTEGRITY_CHECK = 'database_integrity';

export function createReleaseDatabaseProbe({
  policy,
  exec = defaultExec,
  sqliteBin = process.env.NEXUS_RELEASE_SQLITE_BIN || 'sqlite3',
  timeoutMs = 120_000,
}) {
  function databaseFile(environment) {
    const target = policy.environments[environment];
    if (!target) return null;
    return path.join(target.dataDir, 'bot.db');
  }

  function query(file, statement) {
    // `file:...?mode=ro` plus -readonly is belt and braces: neither the URI nor
    // the flag alone should be trusted to keep a release probe from writing.
    return exec(sqliteBin, [
      '-readonly',
      `file:${file}?mode=ro`,
      statement,
    ], { timeoutMs });
  }

  /**
   * Returns a check entry in the same shape as the health probes so it can be
   * appended to the production phase of a receipt directly.
   */
  function checkIntegrity({ environment }) {
    const file = databaseFile(environment);
    if (!file) {
      return {
        name: DATABASE_INTEGRITY_CHECK,
        result: 'failed',
        durationMs: 0,
        detail: sanitizeDetail(`unknown environment ${environment}`),
      };
    }

    const integrity = query(file, 'PRAGMA integrity_check;');
    if (integrity.status !== 0) {
      return {
        name: DATABASE_INTEGRITY_CHECK,
        result: 'failed',
        durationMs: 0,
        detail: sanitizeDetail(`integrity_check exit ${integrity.status}`),
      };
    }
    if (integrity.stdout.trim() !== 'ok') {
      return {
        name: DATABASE_INTEGRITY_CHECK,
        result: 'failed',
        durationMs: 0,
        // The pragma output can name user tables; only the verdict is retained.
        detail: 'integrity_check did not return ok',
      };
    }

    const foreignKeys = query(file, 'PRAGMA foreign_key_check;');
    if (foreignKeys.status !== 0) {
      return {
        name: DATABASE_INTEGRITY_CHECK,
        result: 'failed',
        durationMs: 0,
        detail: sanitizeDetail(`foreign_key_check exit ${foreignKeys.status}`),
      };
    }
    const violations = foreignKeys.stdout.split('\n').filter((line) => line.trim().length > 0);
    if (violations.length > 0) {
      return {
        name: DATABASE_INTEGRITY_CHECK,
        result: 'failed',
        durationMs: 0,
        detail: sanitizeDetail(`${violations.length} foreign key violations`),
      };
    }

    return { name: DATABASE_INTEGRITY_CHECK, result: 'passed', durationMs: 0, detail: null };
  }

  /**
   * Read the applied-migration ledger read-only.
   *
   * This is what the signed inventory is reconciled against. It must be a plain
   * read: the host decides whether to migrate *before* anything opens the
   * database for writing.
   */
  function readAppliedMigrations({ environment }) {
    const file = databaseFile(environment);
    if (!file) return { ok: false, applied: [], detail: sanitizeDetail(`unknown environment ${environment}`) };

    const ledgerExists = query(
      file,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migrations';",
    );
    if (ledgerExists.status !== 0) {
      return {
        ok: false,
        applied: [],
        detail: sanitizeDetail(`ledger probe exit ${ledgerExists.status}`),
      };
    }
    if (ledgerExists.stdout.trim() === '') {
      // No ledger at all means an unmigrated database. That is a legitimate state
      // to report, not an error — the caller decides whether it is admissible.
      return { ok: true, applied: [], ledgerPresent: false, detail: null };
    }

    const rows = query(file, 'SELECT filename FROM _migrations ORDER BY filename;');
    if (rows.status !== 0) {
      return { ok: false, applied: [], detail: sanitizeDetail(`ledger read exit ${rows.status}`) };
    }
    const applied = rows.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    return { ok: true, applied, ledgerPresent: true, detail: null };
  }

  return { databaseFile, checkIntegrity, readAppliedMigrations };
}

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  DECISION_CENTER_REPOSITORY_REQUIREMENTS,
  assertDecisionCenterRepositoryReady,
  inspectDecisionCenterRepositoryReadiness,
  type DecisionCenterTableRequirement,
} from '../../src/services/decision-center/repository-readiness';

const REQUIREMENTS: readonly DecisionCenterTableRequirement[] = [
  { table: 'notification_center_items', columns: ['item_id', 'record_version', 'context_version'] },
  { table: 'decision_action_executions', columns: ['action_execution_id', 'idempotency_key'] },
];

describe('Decision Center repository readiness', () => {
  it('inspects a ready schema using only SELECT and read-only PRAGMA statements', () => {
    const queries: string[] = [];
    const db = new Database(':memory:', { verbose: (query) => queries.push(query) });
    try {
      db.exec(`
        CREATE TABLE notification_center_items (
          item_id TEXT PRIMARY KEY,
          record_version INTEGER NOT NULL,
          context_version TEXT
        );
        CREATE TABLE decision_action_executions (
          action_execution_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL
        );
      `);
      db.pragma('query_only = ON');
      const schemaVersionBefore = db.pragma('schema_version', { simple: true });
      queries.length = 0;

      const report = inspectDecisionCenterRepositoryReadiness(db, REQUIREMENTS);
      const schemaVersionAfter = db.pragma('schema_version', { simple: true });

      expect(report).toEqual({
        schemaVersion: 'decision_center_repository@1.1.0',
        ready: true,
        missingTables: [],
        missingColumns: {},
      });
      expect(schemaVersionAfter).toBe(schemaVersionBefore);
      expect(queries.filter((query) => !query.startsWith('PRAGMA schema_version')))
        .toSatisfy((observed: string[]) => observed.every((query) => /^\s*(SELECT|PRAGMA table_info)/i.test(query)));
    } finally {
      db.close();
    }
  });

  it('reports every missing table and column without attempting repair', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE notification_center_items (item_id TEXT PRIMARY KEY)');
      db.pragma('query_only = ON');

      expect(inspectDecisionCenterRepositoryReadiness(db, REQUIREMENTS)).toEqual({
        schemaVersion: 'decision_center_repository@1.1.0',
        ready: false,
        missingTables: ['decision_action_executions'],
        missingColumns: {
          notification_center_items: ['record_version', 'context_version'],
        },
      });
      expect(() => assertDecisionCenterRepositoryReady(db, REQUIREMENTS)).toThrow(expect.objectContaining({
        code: 'DECISION_REPOSITORY_NOT_READY',
        status: 500,
        details: expect.objectContaining({
          missingTables: ['decision_action_executions'],
          missingColumns: {
            notification_center_items: ['record_version', 'context_version'],
          },
        }),
      }));
    } finally {
      db.close();
    }
  });

  it('rejects unsafe custom identifiers before issuing SQL', () => {
    const queries: string[] = [];
    const db = new Database(':memory:', { verbose: (query) => queries.push(query) });
    try {
      expect(() => inspectDecisionCenterRepositoryReadiness(db, [{
        table: 'notification_center_items; DROP TABLE users',
        columns: ['item_id'],
      }])).toThrow(expect.objectContaining({
        code: 'DECISION_REPOSITORY_REQUIREMENT_INVALID',
        status: 500,
      }));
      expect(queries).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('pins runtime-only columns and the existing outbox/job ledgers as readiness requirements', () => {
    const byTable = new Map(DECISION_CENTER_REPOSITORY_REQUIREMENTS.map((entry) => [entry.table, entry.columns]));
    expect(byTable.get('notification_center_items')).toEqual(expect.arrayContaining([
      'snoozed_until',
      'action_result_json',
      'record_version',
    ]));
    expect(byTable.get('notification_intents')).toEqual(expect.arrayContaining([
      'decision_context_json',
      'context_version',
    ]));
    expect(byTable.get('event_outbox')).toEqual(expect.arrayContaining(['idempotency_key', 'fencing_token', 'lease_expires_at']));
    expect(byTable.get('background_jobs')).toEqual(expect.arrayContaining(['idempotency_key', 'fencing_token', 'lease_expires_at']));
  });
});

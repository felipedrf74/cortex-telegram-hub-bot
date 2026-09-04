import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  recordOperatorAlert: vi.fn(() => ({ ok: true, action: 'created', alert: { id: 77 } })),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!hoisted.db) throw new Error('db not ready');
    return hoisted.db;
  },
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: hoisted.recordOperatorAlert,
}));

import {
  backfillIssues,
  computeIssueFingerprint,
  firstStackFrame,
  getIssue,
  getIssueSummary,
  linkIssueAlert,
  listIssues,
  normalizeIssueMessage,
  setIssueStatus,
  upsertIssue,
} from '../../src/services/issue-tracker';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

beforeEach(() => {
  hoisted.recordOperatorAlert.mockClear();
  hoisted.db = createMigratedTestDatabase();
});

afterEach(() => {
  hoisted.db?.close();
  hoisted.db = null;
});

describe('issue tracker', () => {
  it('produces stable fingerprints across ids, paths, quoted strings and line numbers', () => {
    const a = computeIssueFingerprint('server', 'api', 'Failed to load user 42 from /tmp/a1b2c3d4e5f6a7b8 "alpha"', 'Error: x\n    at loadUser (/app/dist/services/user.js:10:5)');
    const b = computeIssueFingerprint('server', 'api', 'Failed to load user 7 from /tmp/ffeeddccbbaa9988 "beta"', 'Error: x\n    at loadUser (/app/dist/services/user.js:99:1)');
    const c = computeIssueFingerprint('server', 'job', 'Failed to load user 7 from /tmp/ffeeddccbbaa9988 "beta"');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(normalizeIssueMessage('Timeout after 3000ms for job 12')).toBe('Timeout after #ms for job #');
    expect(firstStackFrame('Error: boom\n    at handler (/app/x.js:1:2)\n    at other (/app/y.js:3:4)')).toBe('handler (/app/x.js');
  });

  it('creates an issue on first occurrence and bumps counts afterwards', () => {
    const first = upsertIssue({ kind: 'server', source: 'api', level: 'error', message: 'Boom 1', stack: 'Error\n    at f (/a.js:1:1)', reqId: 'r1', userId: 5 });
    const second = upsertIssue({ kind: 'server', source: 'api', level: 'fatal', message: 'Boom 2', stack: 'Error\n    at f (/a.js:2:2)', reqId: 'r2' });
    expect(first).toMatchObject({ created: true, regressed: false });
    expect(second).toMatchObject({ issueId: first!.issueId, created: false, regressed: false });
    const issues = listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ occurrenceCount: 2, level: 'fatal', lastReqId: 'r2', lastUserId: 5, title: 'Boom #', status: 'open' });
    expect(getIssueSummary()).toMatchObject({ byStatus: { open: 1 }, byKind: { server: 1, client: 0 } });
  });

  it('reopens a resolved issue on recurrence, records a regression alert and clears it on resolve', () => {
    const created = upsertIssue({ kind: 'client', source: 'ios', level: 'error', message: 'Crash in Foo' })!;
    expect(setIssueStatus(created.issueId, 'resolved', 'felipe', 'fixed in 1.2')).toBe(true);
    expect(listIssues({ status: 'resolved' })[0]).toMatchObject({ resolvedBy: 'felipe', notes: 'fixed in 1.2' });

    const again = upsertIssue({ kind: 'client', source: 'ios', level: 'error', message: 'Crash in Foo', appVersion: '1.3' });
    expect(again).toMatchObject({ issueId: created.issueId, created: false, regressed: true });
    const reopened = listIssues({ status: 'open' })[0];
    expect(reopened.regressedAt).not.toBeNull();
    expect(reopened.lastAppVersion).toBe('1.3');
    expect(hoisted.recordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'issue_tracker',
      dedupeKey: `issue:regressed:${created.fingerprint}`,
    }));

    expect(setIssueStatus(created.issueId, 'resolved')).toBe(true);
    expect(listIssues({ status: 'resolved' })[0].regressedAt).toBeNull();
    expect(setIssueStatus(999, 'acked')).toBe(false);
  });

  it('returns occurrences joined from the source table and links alerts', () => {
    const db = hoisted.db!;
    const created = upsertIssue({ kind: 'server', source: 'job', level: 'error', message: 'Job failed', reqId: 'r9' })!;
    db.prepare("INSERT INTO error_log (level, source, message, req_id, issue_id, user_id) VALUES ('error', 'job', 'Job failed', 'r9', ?, 3)").run(created.issueId);
    linkIssueAlert(created.issueId, 41);
    const detail = getIssue(created.issueId)!;
    expect(detail.issue.lastAlertId).toBe(41);
    expect(detail.occurrences).toEqual([expect.objectContaining({ table: 'error_log', reqId: 'r9', userId: 3, message: 'Job failed' })]);
    expect(getIssue(12345)).toBeNull();
  });

  it('backfills ungrouped historical rows once, bounded, and is idempotent', () => {
    const db = hoisted.db!;
    db.prepare("INSERT INTO error_log (level, source, message) VALUES ('error', 'api', 'Old failure 1')").run();
    db.prepare("INSERT INTO error_log (level, source, message) VALUES ('error', 'api', 'Old failure 2')").run();
    db.prepare("INSERT INTO client_errors (user_id, source, level, message, app_version) VALUES (1, 'ios', 'fatal', 'Crash A', '1.0')").run();

    expect(backfillIssues()).toEqual({ server: 2, client: 1 });
    expect(listIssues({ status: 'all' })).toHaveLength(2);
    expect(listIssues({ kind: 'server' })[0].occurrenceCount).toBe(2);
    expect(backfillIssues()).toEqual({ server: 0, client: 0 });
  });

  it('never throws when the issues table is missing', () => {
    hoisted.db!.exec('DROP TABLE issues');
    expect(upsertIssue({ kind: 'server', source: 'api', level: 'error', message: 'x' })).toBeNull();
    expect(getIssueSummary().byStatus.open).toBe(0);
  });
});

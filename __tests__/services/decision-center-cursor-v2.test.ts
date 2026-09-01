import { describe, expect, it } from 'vitest';
import {
  assertDecisionCursorBinding,
  decisionFilterFingerprint,
  decodeDecisionCursorToken,
  encodeDecisionSnapshotCursor,
} from '../../src/services/decision-center/cursor';

const FILTERS = { status: ['unread', 'snoozed'], sourceSkill: 'secretary' };
const FINGERPRINT = decisionFilterFingerprint(FILTERS);

function snapshotCursor() {
  return {
    snapshotId: 'snapshot_42',
    rankingAsOf: '2026-08-30T09:00:00.000Z',
    rankingVersion: 4,
    filterFingerprint: FINGERPRINT,
    rank: {
      priorityTier: 'high' as const,
      priorityScore: 82,
      createdAt: '2026-08-30T08:59:00.000Z',
      decisionId: 'dc_42',
    },
  };
}

describe('decision-center snapshot cursor', () => {
  it('round-trips a snapshot-bound rank tuple', () => {
    const decoded = decodeDecisionCursorToken(encodeDecisionSnapshotCursor(snapshotCursor()));
    expect(decoded).toEqual({ kind: 'snapshot', version: 2, ...snapshotCursor() });
    expect(() => assertDecisionCursorBinding(decoded, {
      snapshotId: 'snapshot_42',
      rankingAsOf: '2026-08-30T09:00:00.000Z',
      rankingVersion: 4,
      filterFingerprint: FINGERPRINT,
    })).not.toThrow();
  });

  it('fingerprints object filters independently of key insertion order', () => {
    expect(decisionFilterFingerprint({ sourceSkill: 'secretary', status: ['unread', 'snoozed'] }))
      .toBe(FINGERPRINT);
    expect(decisionFilterFingerprint({ sourceSkill: 'finance', status: ['unread', 'snoozed'] }))
      .not.toBe(FINGERPRINT);
  });

  it('accepts the valid legacy cursor shape while binding its ranking version', () => {
    const raw = Buffer.from(JSON.stringify({
      ps: 82,
      ca: '2026-08-30T08:59:00.000Z',
      id: 'dc_42',
      rv: 4,
    }), 'utf8').toString('base64url');
    const decoded = decodeDecisionCursorToken(raw);
    expect(decoded).toEqual({
      kind: 'legacy',
      priorityScore: 82,
      createdAt: '2026-08-30T08:59:00.000Z',
      decisionId: 'dc_42',
      rankingVersion: 4,
    });
    expect(() => assertDecisionCursorBinding(decoded, {
      snapshotId: 'new-snapshot',
      rankingAsOf: '2026-08-30T10:00:00.000Z',
      rankingVersion: 4,
      filterFingerprint: decisionFilterFingerprint({}),
    })).not.toThrow();
  });

  it.each([
    '',
    'not+base64url',
    Buffer.from('{broken', 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ v: 99 }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ ps: null, ca: 'bad', id: '', rv: 0 }), 'utf8').toString('base64url'),
  ])('returns a typed 400 for malformed cursor %j', (raw) => {
    expect(() => decodeDecisionCursorToken(raw)).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_MALFORMED',
      status: 400,
    }));
  });

  it.each([
    ['snapshotId', 'other', 'snapshot'],
    ['rankingAsOf', '2026-08-30T10:00:00.000Z', 'ranking_as_of'],
    ['rankingVersion', 5, 'ranking_version'],
    ['filterFingerprint', decisionFilterFingerprint({ sourceSkill: 'finance' }), 'filters'],
  ] as const)('returns a typed 409 when %s no longer binds', (field, value, reason) => {
    const decoded = decodeDecisionCursorToken(encodeDecisionSnapshotCursor(snapshotCursor()));
    const binding = {
      snapshotId: 'snapshot_42',
      rankingAsOf: '2026-08-30T09:00:00.000Z',
      rankingVersion: 4,
      filterFingerprint: FINGERPRINT,
      [field]: value,
    };
    expect(() => assertDecisionCursorBinding(decoded, binding)).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason },
    }));
  });
});

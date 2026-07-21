/**
 * Mirror test for chat-pending-confirmations (M6 reliability backfill).
 * Pins the in-memory destructive-confirmation store: TTL, tenant scoping,
 * the M1 confirmedTargets sanitization, and completed-confirmation replay.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  clearPendingChatConfirmation,
  getCompletedChatConfirmation,
  getPendingChatConfirmation,
  rememberCompletedChatConfirmation,
  resetPendingChatConfirmationsForTests,
  trackPendingChatConfirmation,
} from '../../src/services/chat-pending-confirmations';

const USER_ID = 4242;
const TENANT_A = 4242;
const TENANT_B = 8888;
const NOW = new Date('2026-07-20T12:00:00.000Z');

function track(overrides: Partial<Parameters<typeof trackPendingChatConfirmation>[0]> = {}) {
  return trackPendingChatConfirmation({
    userId: USER_ID,
    tenantId: TENANT_A,
    actionSummary: 'Delete the 3pm event',
    involvedSkills: ['secretary'],
    reasonCodes: ['destructive_action'],
    now: NOW,
    ...overrides,
  });
}

describe('chat-pending-confirmations', () => {
  beforeEach(() => {
    resetPendingChatConfirmationsForTests();
  });

  describe('pending confirmations', () => {
    it('tracks and returns the pending confirmation with a 10-minute default TTL', () => {
      const pending = track();

      expect(pending.expiresAt).toBe('2026-07-20T12:10:00.000Z');
      expect(getPendingChatConfirmation(USER_ID, TENANT_A, NOW)?.id).toBe(pending.id);
    });

    it('expires the pending confirmation exactly at expiresAt and deletes it', () => {
      track({ ttlMs: 60_000 });

      expect(getPendingChatConfirmation(USER_ID, TENANT_A, new Date('2026-07-20T12:00:59.000Z'))).not.toBeNull();
      expect(getPendingChatConfirmation(USER_ID, TENANT_A, new Date('2026-07-20T12:01:00.000Z'))).toBeNull();
      // Deleted, not just filtered: a later read before "expiry" is still null.
      expect(getPendingChatConfirmation(USER_ID, TENANT_A, NOW)).toBeNull();
    });

    it('is tenant-scoped: one slot per tenant:user, invisible across tenants', () => {
      const pendingA = track();
      const pendingB = track({ tenantId: TENANT_B, actionSummary: 'Tenant B action' });

      expect(getPendingChatConfirmation(USER_ID, TENANT_A, NOW)?.id).toBe(pendingA.id);
      expect(getPendingChatConfirmation(USER_ID, TENANT_B, NOW)?.id).toBe(pendingB.id);

      expect(clearPendingChatConfirmation(USER_ID, TENANT_A)).toBe(true);
      expect(getPendingChatConfirmation(USER_ID, TENANT_A, NOW)).toBeNull();
      expect(getPendingChatConfirmation(USER_ID, TENANT_B, NOW)).not.toBeNull();
    });

    it('falls back to userId as tenant when tenantId is missing or invalid', () => {
      const pending = trackPendingChatConfirmation({
        userId: USER_ID,
        actionSummary: 'No tenant provided',
        involvedSkills: ['secretary'],
        reasonCodes: ['destructive_action'],
        now: NOW,
      });

      expect(pending.tenantId).toBe(USER_ID);
      expect(getPendingChatConfirmation(USER_ID, undefined, NOW)?.id).toBe(pending.id);
      expect(getPendingChatConfirmation(USER_ID, USER_ID, NOW)?.id).toBe(pending.id);
    });

    it('replaces the previous pending confirmation for the same scope', () => {
      track({ actionSummary: 'first' });
      const second = track({ actionSummary: 'second', now: new Date('2026-07-20T12:00:01.000Z') });

      const current = getPendingChatConfirmation(USER_ID, TENANT_A, NOW);
      expect(current?.id).toBe(second.id);
      expect(current?.actionSummary).toBe('second');
    });

    it('sanitizes the action summary (whitespace collapse + 220-char cap) and dedupes skills/reasons', () => {
      const pending = track({
        actionSummary: `  delete\n\n${'x'.repeat(300)}   tail  `,
        involvedSkills: ['secretary', 'secretary', 'training'],
        reasonCodes: ['destructive_action', 'destructive_action', 'bulk'],
      });

      expect(pending.actionSummary.length).toBe(220);
      expect(pending.actionSummary.startsWith('delete x')).toBe(true);
      expect(pending.actionSummary).not.toMatch(/\n/);
      expect(pending.involvedSkills).toEqual(['secretary', 'training']);
      expect(pending.reasonCodes).toEqual(['destructive_action', 'bulk']);
    });
  });

  describe('confirmedTargets sanitization (M1 ADV-3)', () => {
    it('keeps undefined when no targets are staged (untyped grant)', () => {
      expect(track().confirmedTargets).toBeUndefined();
    });

    it('trims, caps, and normalizes staged targets', () => {
      const pending = track({
        confirmedTargets: [
          { tool: '  delete_task  ', targetId: `  ${'t'.repeat(250)}  ` },
          { tool: '', targetId: '   ' },
          { tool: 123 as unknown as string, targetId: 456 as unknown as string },
        ],
      });

      expect(pending.confirmedTargets).toHaveLength(3);
      expect(pending.confirmedTargets?.[0]?.tool).toBe('delete_task');
      expect(pending.confirmedTargets?.[0]?.targetId).toBe('t'.repeat(200));
      // Empty/whitespace and non-string values collapse to undefined fields.
      expect(pending.confirmedTargets?.[1]).toEqual({ tool: undefined, targetId: undefined });
      expect(pending.confirmedTargets?.[2]).toEqual({ tool: undefined, targetId: undefined });
    });

    it('caps the target list at 10 entries', () => {
      const pending = track({
        confirmedTargets: Array.from({ length: 15 }, (_, index) => ({
          tool: 'delete_task',
          targetId: `task-${index}`,
        })),
      });

      expect(pending.confirmedTargets).toHaveLength(10);
      expect(pending.confirmedTargets?.[9]?.targetId).toBe('task-9');
    });
  });

  describe('completed-confirmation replay', () => {
    const TOKEN = 'signed-token-abc';

    function remember(overrides: Partial<Parameters<typeof rememberCompletedChatConfirmation>[0]> = {}) {
      return rememberCompletedChatConfirmation({
        confirmationToken: TOKEN,
        userId: USER_ID,
        tenantId: TENANT_A,
        expiresAt: '2026-07-20T12:10:00.000Z',
        statusCode: 200,
        responseBody: { ok: true, routeMethod: 'confirm-action' },
        now: NOW,
        ...overrides,
      });
    }

    it('stores the completion under a token hash, never the raw token', () => {
      const completed = remember();

      expect(completed.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(completed.tokenHash).not.toContain(TOKEN);
    });

    it('replays the completed response for the same scope until expiry', () => {
      remember();

      const replay = getCompletedChatConfirmation(TOKEN, USER_ID, TENANT_A, NOW);
      expect(replay?.statusCode).toBe(200);
      expect(replay?.responseBody).toEqual({ ok: true, routeMethod: 'confirm-action' });

      expect(getCompletedChatConfirmation(TOKEN, USER_ID, TENANT_A, new Date('2026-07-20T12:10:00.000Z'))).toBeNull();
      // Expired entries are deleted.
      expect(getCompletedChatConfirmation(TOKEN, USER_ID, TENANT_A, NOW)).toBeNull();
    });

    it('never replays across user or tenant boundaries', () => {
      remember();

      expect(getCompletedChatConfirmation(TOKEN, USER_ID, TENANT_B, NOW)).toBeNull();
      expect(getCompletedChatConfirmation(TOKEN, 9999, TENANT_A, NOW)).toBeNull();
      expect(getCompletedChatConfirmation('other-token', USER_ID, TENANT_A, NOW)).toBeNull();
      expect(getCompletedChatConfirmation(TOKEN, USER_ID, TENANT_A, NOW)).not.toBeNull();
    });
  });
});

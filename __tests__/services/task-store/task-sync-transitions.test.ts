// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Fixture test for the task-sync state-transition table.
 *
 * This pins the CURRENT transition graph of the three task-sync state
 * machines. Any change to sync/worker/reconciliation state handling must
 * update the table AND this fixture in the same commit — that is the point:
 * state-space changes become explicit, reviewable diffs instead of implicit
 * side effects of SQL edits.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  INITIAL_STATES,
  _transitionTableForTests,
  assertTransition,
  isTransitionAllowed,
  knownStates,
} from '../../../src/services/task-store/task-sync-transitions';
import { logger } from '../../../src/utils/logger';

describe('task-sync-transitions', () => {
  describe('state vocabularies (pin the complete state space)', () => {
    it('mutation_status covers exactly the statuses current code reads or writes', () => {
      expect(knownStates('mutation_status').sort()).toEqual([
        'accepted_local',
        'conflict',
        'dead_letter',
        'failed',
        'queued',
        'superseded',
        'synced',
        'syncing',
      ]);
    });

    it('task_sync_state covers exactly the TaskSyncState union', () => {
      expect(knownStates('task_sync_state').sort()).toEqual([
        'conflict',
        'deleted_pending_sync',
        'failed_permanent',
        'failed_retryable',
        'local_only',
        'partially_synced',
        'provider_disconnected',
        'provider_missing',
        'queued',
        'stale',
        'synced',
        'syncing',
      ]);
    });

    it('link_state covers exactly the states current code reads or writes', () => {
      expect(knownStates('link_state').sort()).toEqual([
        'conflict',
        'disconnected',
        'linked',
        'orphaned',
        'pending_create',
        'pending_delete',
        'pending_update',
        'provider_missing',
        'stale',
      ]);
    });

    it('every transition target is itself a known state', () => {
      for (const kind of ['mutation_status', 'task_sync_state', 'link_state'] as const) {
        const table = _transitionTableForTests(kind);
        const states = new Set(Object.keys(table));
        for (const [from, exits] of Object.entries(table)) {
          for (const to of exits) {
            expect(states.has(to), `${kind}: ${from} -> ${to} targets unknown state`).toBe(true);
          }
        }
      }
    });

    it('every initial state is a known state', () => {
      for (const kind of ['mutation_status', 'task_sync_state', 'link_state'] as const) {
        const states = new Set(knownStates(kind));
        for (const initial of INITIAL_STATES[kind]) {
          expect(states.has(initial), `${kind}: initial ${initial} unknown`).toBe(true);
        }
      }
    });
  });

  describe('documented absorbing states (designed exits pinned on purpose)', () => {
    // M2B conflict resolution closed NEX-06: mutation 'conflict' is NO LONGER
    // terminal — resolveTaskConflict retires conflicted rows as 'superseded'
    // (task-conflict-resolution.ts). 'superseded' is the internal-only
    // terminal state that replaced the absorbing defect.
    it('mutation conflict exits only to superseded (M2B conflict resolution)', () => {
      expect(_transitionTableForTests('mutation_status').conflict).toEqual(['superseded']);
    });

    it('mutation dead_letter, synced, and superseded are terminal', () => {
      expect(_transitionTableForTests('mutation_status').dead_letter).toEqual([]);
      expect(_transitionTableForTests('mutation_status').synced).toEqual([]);
      expect(_transitionTableForTests('mutation_status').superseded).toEqual([]);
    });

    it('superseded is never a legal insert-time status — it only exists as a resolution exit', () => {
      expect(INITIAL_STATES.mutation_status).not.toContain('superseded');
    });

    it('task sync_state conflict exits: self-record, tombstone, and the M2B resolution paths', () => {
      // M2B: keep_local re-queues the local copy; keep_provider applies the
      // provider copy (or accepts the remote deletion as a synced tombstone).
      expect([..._transitionTableForTests('task_sync_state').conflict].sort()).toEqual([
        'conflict',
        'deleted_pending_sync',
        'queued',
        'synced',
      ]);
    });

    it('link conflict heals only through M2B resolution; orphaned is terminal', () => {
      expect([..._transitionTableForTests('link_state').conflict].sort()).toEqual([
        'conflict',
        'linked',
        'orphaned',
        'pending_create',
        'pending_update',
      ]);
      expect(_transitionTableForTests('link_state').orphaned).toEqual([]);
    });
  });

  describe('load-bearing edges (behaviors other suites rely on)', () => {
    it('worker claim path: queued/accepted_local/failed/stale-syncing -> syncing', () => {
      for (const from of ['queued', 'accepted_local', 'failed', 'syncing']) {
        expect(isTransitionAllowed('mutation_status', from, 'syncing'), from).toBe(true);
      }
    });

    it('failed mutations can dead-letter; queued cannot skip straight to dead_letter', () => {
      expect(isTransitionAllowed('mutation_status', 'failed', 'dead_letter')).toBe(true);
      expect(isTransitionAllowed('mutation_status', 'queued', 'dead_letter')).toBe(false);
    });

    it('provider reappearance heals sighting-recoverable states; disconnected heals only by delivery', () => {
      // markProviderTaskSeen's sighting-heal set — provider_disconnected was
      // removed by the failure-lifecycle work because sighting the provider
      // copy must not mask a parked local mutation (NEX-03).
      for (const from of ['provider_missing', 'stale', 'failed_retryable']) {
        expect(isTransitionAllowed('task_sync_state', from, 'synced'), from).toBe(true);
      }
      // provider_disconnected -> synced stays legal, but only via actual
      // delivery (markSynced after the re-armed push) or markVerified.
      expect(isTransitionAllowed('task_sync_state', 'provider_disconnected', 'synced')).toBe(true);
    });

    it('pull hash-diff marks pending-local states conflicted, and only those', () => {
      // Pending-guard set after the failure-lifecycle work: parked
      // disconnected edits and un-pushed deletes are protected too.
      for (const from of ['queued', 'syncing', 'failed_retryable', 'provider_disconnected', 'deleted_pending_sync']) {
        expect(isTransitionAllowed('task_sync_state', from, 'conflict'), from).toBe(true);
      }
      // Non-pending states are overwritten by pulls, not conflicted, except
      // via the worker's own 412 path on synced/partially_synced rows.
      for (const from of ['local_only', 'provider_missing', 'stale', 'failed_permanent']) {
        expect(isTransitionAllowed('task_sync_state', from, 'conflict'), from).toBe(false);
      }
    });

    it('link lifecycle: pending_create -> linked on push, -> orphaned on delete push', () => {
      expect(isTransitionAllowed('link_state', 'pending_create', 'linked')).toBe(true);
      expect(isTransitionAllowed('link_state', 'pending_create', 'orphaned')).toBe(true);
    });

    it('tombstone: active states can become deleted_pending_sync; conflict included', () => {
      for (const from of ['local_only', 'queued', 'synced', 'conflict', 'provider_missing']) {
        expect(isTransitionAllowed('task_sync_state', from, 'deleted_pending_sync'), from).toBe(true);
      }
    });

    it('deleted_pending_sync completes to synced only via the delete push (NEX-19 resurrect closed)', () => {
      expect(isTransitionAllowed('task_sync_state', 'deleted_pending_sync', 'synced')).toBe(true);
      expect(isTransitionAllowed('task_sync_state', 'deleted_pending_sync', 'conflict')).toBe(true);
    });

    it('M2B supersede sources: every still-pending ledger status can retire, delivered work cannot', () => {
      // keep_provider retires queued/accepted_local/failed/conflict rows so a
      // later push can never clobber the accepted provider copy; synced,
      // dead_letter, and in-flight syncing rows are not superseded.
      for (const from of ['queued', 'accepted_local', 'failed', 'conflict']) {
        expect(isTransitionAllowed('mutation_status', from, 'superseded'), from).toBe(true);
      }
      for (const from of ['synced', 'dead_letter', 'syncing', 'superseded']) {
        expect(isTransitionAllowed('mutation_status', from, 'superseded'), from).toBe(false);
      }
    });

    it('M2B resolution link exits: provider_missing keep_local can re-arm a create', () => {
      expect(isTransitionAllowed('link_state', 'provider_missing', 'pending_create')).toBe(true);
      expect(isTransitionAllowed('link_state', 'conflict', 'pending_create')).toBe(true);
      expect(isTransitionAllowed('link_state', 'conflict', 'pending_update')).toBe(true);
      expect(isTransitionAllowed('link_state', 'conflict', 'linked')).toBe(true);
    });
  });

  describe('assertTransition (fail-open mechanics)', () => {
    beforeEach(() => {
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      vi.mocked(logger.warn).mockClear();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns true and stays silent for an allowed transition', () => {
      expect(assertTransition('mutation_status', 'queued', 'syncing')).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('returns false and logs (never throws) for a disallowed transition', () => {
      expect(assertTransition('mutation_status', 'synced', 'queued', { mutationId: 'm1' })).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [ctx, message] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
      expect(message).toContain('outside the allowed table');
      expect(ctx).toMatchObject({ kind: 'mutation_status', from: 'synced', to: 'queued', mutationId: 'm1' });
    });

    it('returns false and logs for unknown source states instead of throwing', () => {
      expect(assertTransition('link_state', 'not_a_state', 'linked')).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('never throws for any (kind, from, to) combination', () => {
      const kinds = ['mutation_status', 'task_sync_state', 'link_state'] as const;
      for (const kind of kinds) {
        const states = [...knownStates(kind), 'bogus'];
        for (const from of states) {
          for (const to of states) {
            expect(() => assertTransition(kind, from, to)).not.toThrow();
          }
        }
      }
    });
  });
});

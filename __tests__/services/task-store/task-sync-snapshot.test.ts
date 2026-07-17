// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildTaskSyncedSnapshot,
  parseTaskSyncedSnapshot,
} from '../../../src/services/task-store/task-sync-snapshot';

describe('task-sync-snapshot (M2B agreed-base record)', () => {
  describe('buildTaskSyncedSnapshot', () => {
    it('serializes full task content verbatim', () => {
      const json = buildTaskSyncedSnapshot({
        title: 'Pack for the trip',
        status: 'in_progress',
        priority: 3,
        dueDate: '2026-07-21T09:00:00Z',
        dueIsDatetime: true,
        notes: 'passport + charger',
      });
      expect(JSON.parse(json)).toEqual({
        title: 'Pack for the trip',
        status: 'in_progress',
        priority: 3,
        dueDate: '2026-07-21T09:00:00Z',
        dueIsDatetime: true,
        notes: 'passport + charger',
      });
    });

    it('coerces absent and falsy fields to the stable defaults', () => {
      const json = buildTaskSyncedSnapshot({
        title: null,
        status: undefined,
        priority: Number.NaN,
        dueDate: undefined,
        dueIsDatetime: 0,
        notes: '',
      });
      expect(JSON.parse(json)).toEqual({
        title: '',
        status: 'pending',
        priority: 0,
        dueDate: null,
        dueIsDatetime: false,
        notes: null,
      });
    });

    it('accepts SQLite integer booleans and string-numeric priorities', () => {
      const json = buildTaskSyncedSnapshot({
        title: 'T',
        status: 'completed',
        priority: '4' as unknown as number,
        dueDate: '2026-07-20',
        dueIsDatetime: 1,
        notes: null,
      });
      expect(JSON.parse(json)).toEqual({
        title: 'T',
        status: 'completed',
        priority: 4,
        dueDate: '2026-07-20',
        dueIsDatetime: true,
        notes: null,
      });
    });
  });

  describe('parseTaskSyncedSnapshot', () => {
    it('round-trips what buildTaskSyncedSnapshot produced', () => {
      const json = buildTaskSyncedSnapshot({
        title: 'Round trip',
        status: 'completed',
        priority: 2,
        dueDate: '2026-07-19',
        dueIsDatetime: false,
        notes: 'note',
      });
      expect(parseTaskSyncedSnapshot(json)).toEqual({
        title: 'Round trip',
        status: 'completed',
        priority: 2,
        dueDate: '2026-07-19',
        dueIsDatetime: false,
        notes: 'note',
      });
    });

    it('returns null for absent values (NULL column, empty string)', () => {
      expect(parseTaskSyncedSnapshot(null)).toBeNull();
      expect(parseTaskSyncedSnapshot(undefined)).toBeNull();
      expect(parseTaskSyncedSnapshot('')).toBeNull();
    });

    it('returns null for corrupt JSON instead of throwing', () => {
      expect(parseTaskSyncedSnapshot('{not json')).toBeNull();
    });

    it('returns null for valid JSON that is not an object', () => {
      // typeof [] === 'object', so an array passes the guard and normalizes to
      // the defaults — only true non-objects (and JSON null) are rejected.
      expect(parseTaskSyncedSnapshot('"just a string"')).toBeNull();
      expect(parseTaskSyncedSnapshot('42')).toBeNull();
      expect(parseTaskSyncedSnapshot('null')).toBeNull();
    });

    it('fills missing fields with the same defaults build uses', () => {
      expect(parseTaskSyncedSnapshot('{}')).toEqual({
        title: '',
        status: 'pending',
        priority: 0,
        dueDate: null,
        dueIsDatetime: false,
        notes: null,
      });
    });

    it('coerces malformed field values defensively', () => {
      expect(parseTaskSyncedSnapshot(JSON.stringify({
        title: 'Kept',
        status: '',
        priority: 'seven',
        dueDate: '',
        dueIsDatetime: 'truthy string',
        notes: 0,
      }))).toEqual({
        title: 'Kept',
        status: 'pending',
        priority: 0,
        dueDate: null,
        dueIsDatetime: true,
        notes: null,
      });
    });
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb }));

import {
  setTaskListSyncSelection,
  getDisabledProviderListIds,
  isProviderListSyncEnabled,
  clearTaskListSyncSelection,
  normalizeTaskListSelectionProvider,
} from '../../../src/services/task-store/task-list-sync-selection';

const TENANT = 5;
const USER = 5;

beforeEach(() => {
  testDb = createMigratedTestDatabase();
});

afterEach(() => {
  testDb.close();
});

describe('normalizeTaskListSelectionProvider', () => {
  it('accepts selectable task providers and rejects the rest', () => {
    expect(normalizeTaskListSelectionProvider('ms_todo')).toBe('ms_todo');
    expect(normalizeTaskListSelectionProvider('TODOIST')).toBe('todoist');
    expect(normalizeTaskListSelectionProvider('notion')).toBe('notion');
    expect(normalizeTaskListSelectionProvider('garmin')).toBeNull();
    expect(normalizeTaskListSelectionProvider(42)).toBeNull();
  });
});

describe('task list sync selection storage', () => {
  it('defaults to enabled when no selection exists', () => {
    expect(getDisabledProviderListIds(TENANT, USER, 'ms_todo').size).toBe(0);
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'listA')).toBe(true);
    // A null/absent list id is never "disabled".
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', null)).toBe(true);
  });

  it('persists enabled/disabled entries and reads them back', () => {
    const result = setTaskListSyncSelection({
      tenantId: TENANT,
      userId: USER,
      provider: 'ms_todo',
      entries: [
        { providerListId: 'listA', syncEnabled: true },
        { providerListId: 'listB', syncEnabled: false },
        { providerListId: 'listC', syncEnabled: false },
      ],
    });
    expect(result).toEqual({ enabledCount: 1, disabledCount: 2 });

    expect(getDisabledProviderListIds(TENANT, USER, 'ms_todo')).toEqual(new Set(['listB', 'listC']));
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'listA')).toBe(true);
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'listB')).toBe(false);
  });

  it('re-selecting overwrites the previous flag for a list', () => {
    setTaskListSyncSelection({
      tenantId: TENANT, userId: USER, provider: 'ms_todo',
      entries: [{ providerListId: 'listA', syncEnabled: false }],
    });
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'listA')).toBe(false);

    setTaskListSyncSelection({
      tenantId: TENANT, userId: USER, provider: 'ms_todo',
      entries: [{ providerListId: 'listA', syncEnabled: true }],
    });
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'listA')).toBe(true);
    expect(getDisabledProviderListIds(TENANT, USER, 'ms_todo').size).toBe(0);
  });

  it('ignores blank ids and de-duplicates within one selection', () => {
    const result = setTaskListSyncSelection({
      tenantId: TENANT, userId: USER, provider: 'todoist',
      entries: [
        { providerListId: '  ', syncEnabled: false },
        { providerListId: 'p1', syncEnabled: false },
        { providerListId: 'p1', syncEnabled: true },
      ],
    });
    expect(result).toEqual({ enabledCount: 0, disabledCount: 1 });
    expect(getDisabledProviderListIds(TENANT, USER, 'todoist')).toEqual(new Set(['p1']));
  });

  it('is scoped per provider', () => {
    setTaskListSyncSelection({
      tenantId: TENANT, userId: USER, provider: 'ms_todo',
      entries: [{ providerListId: 'shared', syncEnabled: false }],
    });
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'shared')).toBe(false);
    expect(isProviderListSyncEnabled(TENANT, USER, 'todoist', 'shared')).toBe(true);
  });

  it('clears a provider selection back to the default', () => {
    setTaskListSyncSelection({
      tenantId: TENANT, userId: USER, provider: 'ms_todo',
      entries: [
        { providerListId: 'listA', syncEnabled: false },
        { providerListId: 'listB', syncEnabled: false },
      ],
    });
    const removed = clearTaskListSyncSelection(TENANT, USER, 'ms_todo');
    expect(removed).toBe(2);
    expect(getDisabledProviderListIds(TENANT, USER, 'ms_todo').size).toBe(0);
    expect(isProviderListSyncEnabled(TENANT, USER, 'ms_todo', 'listA')).toBe(true);
  });
});

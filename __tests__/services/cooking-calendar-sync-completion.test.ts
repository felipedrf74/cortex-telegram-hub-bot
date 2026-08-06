import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgenda: vi.fn(),
  createNotification: vi.fn(),
  invalidateCaches: vi.fn(),
}));

vi.mock('../../src/services/secretary-scheduling-arbitrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-scheduling-arbitrator')>(
    '../../src/services/secretary-scheduling-arbitrator'
  )),
  getSecretaryAgendaItemById: (...args: unknown[]) => mocks.getAgenda(...args),
}));
vi.mock('../../src/services/notification-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/notification-orchestrator')>(
    '../../src/services/notification-orchestrator'
  )),
  createNotificationIntent: (...args: unknown[]) => mocks.createNotification(...args),
}));
vi.mock('../../src/services/cache-coherence-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry'
  )),
  invalidateCookingDerivedCaches: (...args: unknown[]) => mocks.invalidateCaches(...args),
}));

import {
  consumeCookingMealPrepProviderSyncCompleted,
} from '../../src/services/cooking-calendar-sync-completion';

const event = {
  eventType: 'cooking.meal_prep_provider_sync.completed.v1',
  sourceSkill: 'cooking',
  entityType: 'secretary_agenda_item',
  entityId: 'agenda-cooking-1',
  entityVersion: 3,
  userId: 42,
  payload: { agendaTenantId: '84' },
} as any;

describe('Cooking provider-sync completion effect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createNotification.mockResolvedValue({ status: 'accepted' });
    mocks.getAgenda.mockReturnValue({
      agendaItemId: 'agenda-cooking-1',
      ownerUserId: 42,
      tenantId: '84',
      version: 3,
      sourceSkill: 'cooking',
      sourceEntityId: '2026-08-03',
      sourceEntityType: 'meal_prep_block',
      providerSyncState: 'synced',
      providerEventId: 'outlook-event-9',
      providerSource: 'outlook',
      providerTarget: 'outlook',
    });
  });

  it('re-reads exact scope and uses one stable notification dedupe identity on replay', async () => {
    await consumeCookingMealPrepProviderSyncCompleted(event, {} as any);
    await consumeCookingMealPrepProviderSyncCompleted(event, {} as any);

    expect(mocks.getAgenda).toHaveBeenNthCalledWith(1, {
      agendaItemId: 'agenda-cooking-1',
      ownerUserId: 42,
      tenantId: '84',
    });
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
    const first = mocks.createNotification.mock.calls[0][0];
    const replay = mocks.createNotification.mock.calls[1][0];
    expect(first.dedupeKey).toBe(
      'cooking:meal-prep-provider-sync:agenda-cooking-1:3:outlook:outlook-event-9',
    );
    expect(replay.dedupeKey).toBe(first.dedupeKey);
    expect(mocks.invalidateCaches).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateCaches).toHaveBeenCalledWith(42, { includeCalendarSurfaces: true });
  });

  it('fails closed before side effects when event scope does not match the agenda', async () => {
    mocks.getAgenda.mockReturnValue(null);
    await expect(consumeCookingMealPrepProviderSyncCompleted(event, {} as any))
      .rejects.toThrow('COOKING_PROVIDER_SYNC_COMPLETION_AGENDA_MISMATCH');
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.invalidateCaches).not.toHaveBeenCalled();
  });
});

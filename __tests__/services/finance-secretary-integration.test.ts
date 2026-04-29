import { describe, expect, it, vi } from 'vitest';

const mockSubmitSecretarySchedulingIntent = vi.fn();

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  submitSecretarySchedulingIntent: (...args: unknown[]) => mockSubmitSecretarySchedulingIntent(...args),
}));

import {
  buildFinanceSchedulingIntent,
  submitFinanceSchedulingIntent,
} from '../../src/services/finance-secretary-integration';

describe('finance-secretary-integration', () => {
  it('builds Finance deadline reminders as Secretary-owned scheduling intents', () => {
    const intent = buildFinanceSchedulingIntent({
      userId: 42,
      tenantId: 42,
      kind: 'bill_reminder',
      entityId: 'invoice-1',
      title: 'Pay card bill',
      deadline: '2026-05-05T12:00:00.000Z',
      preferredWindows: [{ start: '2026-05-05T08:00:00.000Z', end: '2026-05-05T08:30:00.000Z' }],
    });

    expect(intent).toMatchObject({
      intentId: 'finance:42:bill_reminder:invoice-1',
      action: 'create_reminder',
      sourceSkill: 'finance',
      sourceAction: 'bill_reminder',
      sourceEntityType: 'bill_reminder',
      ownerUserId: 42,
      tenantId: 42,
      priority: 'high',
    });
  });

  it('submits budget review blocks through Secretary instead of creating calendar items directly', () => {
    mockSubmitSecretarySchedulingIntent.mockReturnValue({
      status: 'scheduled',
      reasonCodes: ['finance_deadline_priority'],
      selectedSlot: { start: '2026-05-05T09:00:00.000Z', end: '2026-05-05T09:45:00.000Z' },
      agendaItem: { agendaItemId: 'sec-finance-1' },
    });

    const decision = submitFinanceSchedulingIntent({
      userId: 42,
      kind: 'budget_review',
      entityId: 'equipment-purchase',
      title: 'Review equipment purchase',
      preferredWindows: [{ start: '2026-05-05T09:00:00.000Z', end: '2026-05-05T10:00:00.000Z' }],
    });

    expect(decision.status).toBe('scheduled');
    expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'finance',
      sourceAction: 'budget_review',
      sourceEntityId: 'equipment-purchase',
      action: 'schedule_this',
    }));
  });
});


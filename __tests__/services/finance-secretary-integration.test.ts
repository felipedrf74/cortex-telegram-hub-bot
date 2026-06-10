import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSubmitSecretarySchedulingIntent = vi.fn();
const mockPreviewSecretarySchedulingIntent = vi.fn();

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  previewSecretarySchedulingIntent: (...args: unknown[]) => mockPreviewSecretarySchedulingIntent(...args),
  submitSecretarySchedulingIntent: (...args: unknown[]) => mockSubmitSecretarySchedulingIntent(...args),
}));

import {
  buildFinanceSchedulingIntent,
  previewFinanceSchedulingIntent,
  submitFinanceSchedulingIntent,
} from '../../src/services/finance-secretary-integration';

describe('finance-secretary-integration', () => {
  beforeEach(() => {
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockPreviewSecretarySchedulingIntent.mockReset();
  });

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

  it('scopes Finance intent ids by tenant to prevent cross-tenant collisions', () => {
    const first = buildFinanceSchedulingIntent({
      userId: 42,
      tenantId: 101,
      kind: 'bill_reminder',
      entityId: 'invoice-1',
      title: 'Pay card bill',
      preferredWindows: [{ start: '2026-05-05T08:00:00.000Z', end: '2026-05-05T08:30:00.000Z' }],
    });
    const second = buildFinanceSchedulingIntent({
      userId: 42,
      tenantId: 202,
      kind: 'bill_reminder',
      entityId: 'invoice-1',
      title: 'Pay card bill',
      preferredWindows: [{ start: '2026-05-05T08:00:00.000Z', end: '2026-05-05T08:30:00.000Z' }],
    });

    expect(first.intentId).toBe('finance:101:bill_reminder:invoice-1');
    expect(second.intentId).toBe('finance:202:bill_reminder:invoice-1');
    expect(first.intentId).not.toBe(second.intentId);
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
      additionalBusyWindows: [],
    });

    expect(decision.status).toBe('scheduled');
    expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'finance',
      sourceAction: 'budget_review',
      sourceEntityId: 'equipment-purchase',
      action: 'schedule_this',
    }), { additionalBusyWindows: [] });
  });

  it('requires callers to provide live calendar busy windows explicitly', () => {
    expect(() => submitFinanceSchedulingIntent({
      userId: 42,
      kind: 'budget_review',
      entityId: 'equipment-purchase',
      title: 'Review equipment purchase',
      preferredWindows: [{ start: '2026-05-05T09:00:00.000Z', end: '2026-05-05T10:00:00.000Z' }],
    })).toThrow('FINANCE_SECRETARY_LIVE_BUSY_WINDOWS_REQUIRED');
  });

  it('fails closed when live calendar busy-window loading is degraded', () => {
    expect(() => previewFinanceSchedulingIntent({
      userId: 42,
      kind: 'budget_review',
      entityId: 'equipment-purchase',
      title: 'Review equipment purchase',
      preferredWindows: [{ start: '2026-05-05T09:00:00.000Z', end: '2026-05-05T10:00:00.000Z' }],
      additionalBusyWindows: [],
      liveBusyWindowsDegraded: true,
    })).toThrow('FINANCE_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
    expect(mockPreviewSecretarySchedulingIntent).not.toHaveBeenCalled();
  });

  it('previews Finance reminders before callers persist an agenda item', () => {
    mockPreviewSecretarySchedulingIntent.mockReturnValue({
      status: 'scheduled',
      reasonCodes: ['finance_deadline_priority'],
      recommendedSlot: { start: '2026-05-05T08:00:00.000Z', end: '2026-05-05T08:15:00.000Z' },
      agendaItem: { agendaItemId: 'preview-finance-1' },
    });

    const preview = previewFinanceSchedulingIntent({
      userId: 42,
      kind: 'bill_reminder',
      entityId: 'invoice-1',
      title: 'Pay card bill',
      preferredWindows: [{ start: '2026-05-05T08:00:00.000Z', end: '2026-05-05T08:30:00.000Z' }],
      additionalBusyWindows: [],
    });

    expect(preview.status).toBe('scheduled');
    expect(mockPreviewSecretarySchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'finance',
      sourceAction: 'bill_reminder',
    }), { additionalBusyWindows: [] });
    expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'finance',
      sourceAction: 'bill_reminder',
    }));
  });
});

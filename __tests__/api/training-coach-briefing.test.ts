// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockGetLatestByType = vi.fn();
const mockSetLastCoachState = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  setLastCoachState: (...args: unknown[]) => mockSetLastCoachState(...args),
}));

describe('training coach briefing helpers', () => {
  beforeEach(() => {
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockGetLatestByType.mockReset();
    mockSetLastCoachState.mockReset();
    clearTenantScopeAnomaliesForTests();
  });

  it('normalizes cached payloads and syncs the persisted coach state', async () => {
    const { getCoachBriefingSnapshot } = await import('../../src/api/routes/training-coach-briefing');
    mockGetCached.mockReturnValue({
      briefing: '  Cached coach note  ',
      recommendations: [
        {
          action: 'MODIFY',
          eventId: 'evt-1',
          source: 'google',
          originalTitle: 'Tempo run',
          summary: 'Shorten to 30 min.',
        },
      ],
    });

    const snapshot = getCoachBriefingSnapshot(12);

    expect(snapshot).toMatchObject({
      briefing: 'Cached coach note',
      recommendations: [
        expect.objectContaining({
          action: 'MODIFY',
          eventId: 'evt-1',
          source: 'google',
          reason: 'Shorten to 30 min.',
        }),
      ],
    });
    expect(mockSetLastCoachState).toHaveBeenCalledWith(
      12,
      [
        expect.objectContaining({
          action: 'MODIFY',
          eventId: 'evt-1',
          source: 'google',
          reason: 'Shorten to 30 min.',
        }),
      ],
      'Cached coach note',
    );
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('sanitizes raw coach report markers, ids, and timing traces before caching state', async () => {
    const { getCoachBriefingSnapshot } = await import('../../src/api/routes/training-coach-briefing');
    mockGetCached.mockReturnValue({
      briefing: [
        'A light walk protects tomorrow.',
        'RECOMMENDATION KEY:',
        'KEEP = execute as planned',
        '<!-- COACH_RECS_START -->',
        '[DEBUG] selected provider path',
        '[TRACE] calendar scan returned 9 raw rows',
        'Google API: 503 provider unavailable',
        'Outlook provider: auth failed',
        '"eventId": "_60q30c1g60o30e1i60o4ac1g60rj8gpl88r-j2c1h84s34h9g60s30c1g60o30c1g6sr-j2h216sqjgha184s48gpg64o30c1g60o30c1g60o32c1g60o30c1g6os32"',
        'Data: 1.3s | Analysis: 12.4s',
      ].join('\n'),
      recommendations: [],
    });

    const snapshot = getCoachBriefingSnapshot(12);

    expect(snapshot?.briefing).toBe('A light walk protects tomorrow.');
    expect(mockSetLastCoachState).toHaveBeenCalledWith(12, [], 'A light walk protects tomorrow.');
  });

  it('drops provider error strings and bracketed debug tags from restored report summaries', async () => {
    const { getCoachBriefingSnapshot } = await import('../../src/api/routes/training-coach-briefing');
    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue({
      createdAt: new Date().toISOString(),
      summary: 'Fallback summary.',
      documentJson: {
        message: [
          'Keep today easy and protect the next key session.',
          '[WARN] Google API: 503 during calendar scan',
          'Microsoft Graph API: failed with status: 500',
          'HTTP code: 503',
        ].join('\n'),
        recommendations: [],
      },
    });

    const snapshot = getCoachBriefingSnapshot(12);

    expect(snapshot?.briefing).toBe('Keep today easy and protect the next key session.');
    expect(snapshot?.briefing).not.toMatch(/\[WARN\]|Google API|Microsoft Graph|HTTP code/i);
    expect(mockSetCache).toHaveBeenCalledWith(
      'coach-briefing:12',
      expect.objectContaining({ briefing: 'Keep today easy and protect the next key session.' }),
      21600,
    );
  });

  it('restores the latest coach report when the cache misses and respects tenant scope', async () => {
    const { getCoachBriefingSnapshot } = await import('../../src/api/routes/training-coach-briefing');
    mockGetCached.mockReturnValue(null);
    mockGetLatestByType.mockReturnValue({
      createdAt: new Date().toISOString(),
      summary: 'Coach update ready.',
      documentJson: {
        message: 'Coach update ready.',
        recommendations: [
          {
            action: 'REST',
            eventId: 'evt-2',
            source: 'outlook',
            originalTitle: 'Hard ride',
            summary: 'Cancelar — descanso necessário',
          },
        ],
        readiness: {
          factors: {
            sleep: { score: 71 },
            bodyBattery: { score: 58 },
          },
        },
        errors: ['Garmin sync was unavailable.'],
      },
    });

    const snapshot = getCoachBriefingSnapshot(18);

    expect(snapshot).toMatchObject({
      briefing: 'Coach update ready.',
      restoredFromReport: true,
      degraded: true,
      warnings: ['Garmin sync was unavailable.'],
      garminData: {
        sleepScore: 71,
        bodyBattery: 58,
        steps: null,
        activeMinutes: null,
      },
    });
    expect(mockSetCache).toHaveBeenCalledWith(
      'coach-briefing:18',
      expect.objectContaining({ briefing: 'Coach update ready.' }),
      21600,
    );
  });

  it('fails closed when the user scope is invalid before reading report state', async () => {
    const { restoreCoachBriefingFromLatestReport } = await import('../../src/api/routes/training-coach-briefing');

    expect(restoreCoachBriefingFromLatestReport(0)).toBeNull();
    expect(mockGetLatestByType).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'restore_coach_briefing_from_report',
          reason: 'invalid_user_scope',
          userId: 0,
          details: { reportType: 'coach_briefing' },
        }),
      ]),
    );
  });

  it('drops stale report state instead of reviving old coach guidance', async () => {
    const { restoreCoachBriefingFromLatestReport } = await import('../../src/api/routes/training-coach-briefing');
    mockGetLatestByType.mockReturnValue({
      createdAt: '2026-04-01T00:00:00.000Z',
      summary: 'Old coach update.',
      documentJson: {
        message: 'Old coach update.',
        recommendations: [],
      },
    });

    expect(restoreCoachBriefingFromLatestReport(12, 60)).toBeNull();
  });
});

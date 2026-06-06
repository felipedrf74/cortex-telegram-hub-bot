// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';

const mockRecordOperatorAlert = vi.fn((input) => ({
  ok: true,
  action: 'created',
  alert: { id: 1, ...input },
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

describe('chatv2-readiness-alerts', () => {
  it('builds dashboard rows for every phase without raw route payloads', async () => {
    const { buildChatV2ReadinessDashboard } = await import('../../src/services/chatv2-readiness-alerts');

    const rows = buildChatV2ReadinessDashboard(report());

    expect(rows.map((row) => row.phase)).toEqual([
      'shadow',
      'answerCanary',
      'deterministicRead',
      'writePreview',
      'confirmedWrites',
      'cloudAllowlist',
      'legacyRetirement',
    ]);
    expect(rows.find((row) => row.phase === 'legacyRetirement')).toMatchObject({
      passed: false,
      gateCount: 2,
      blockedGateCount: 1,
    });
    expect(JSON.stringify(rows)).not.toMatch(/raw user text|customer@example\.com|comprar suplementos/i);
  });

  it('turns blocked gates into deduped operator alert inputs with safe metadata', async () => {
    const { buildChatV2ReadinessAlertInputs } = await import('../../src/services/chatv2-readiness-alerts');

    const alerts = buildChatV2ReadinessAlertInputs(report());

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => [alert.severity, alert.dedupeKey])).toEqual([
      ['critical', 'chatv2-readiness:confirmedWrites:no_success_claim_without_verified_readback'],
      ['warning', 'chatv2-readiness:legacyRetirement:route_shadow_parity'],
    ]);
    expect(alerts[0]).toMatchObject({
      source: 'chat_v2_readiness',
      title: expect.stringContaining('Confirmed writes'),
      owner: 'ai-platform',
      suspectedArea: 'chat_v2_completion',
      runbookUrl: 'docs/qa/work-orders/WO-chatv2-completion.md',
    });
    expect(alerts[0].metadata).toMatchObject({
      phase: 'confirmedWrites',
      gateId: 'no_success_claim_without_verified_readback',
      observed: 1,
      threshold: 0,
      reasonCode: 'unverified_success_claim',
    });
    expect(JSON.stringify(alerts)).not.toMatch(/raw user text|customer@example\.com|comprar suplementos/i);
  });

  it('records the generated alert inputs through the durable operator-alert service', async () => {
    const { recordChatV2ReadinessOperatorAlerts } = await import('../../src/services/chatv2-readiness-alerts');
    mockRecordOperatorAlert.mockClear();

    const result = await recordChatV2ReadinessOperatorAlerts(report());

    expect(result.alertInputs).toHaveLength(2);
    expect(result.results).toHaveLength(2);
    expect(mockRecordOperatorAlert).toHaveBeenCalledTimes(2);
    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'chatv2-readiness:legacyRetirement:route_shadow_parity',
    }));
  });
});

function report() {
  const passing = {
    passed: true,
    gates: [
      { gateId: 'sample_gate', passed: true, sampleCount: 64, observed: 1, threshold: 1 },
    ],
  };
  return {
    schemaVersion: 'chat_v2_completion_readiness_report.v1',
    generatedAt: '2026-05-31T12:00:00.000Z',
    evidenceSources: ['runtime_route'],
    shadow: passing,
    answerCanary: passing,
    deterministicRead: passing,
    writePreview: passing,
    confirmedWrites: {
      passed: false,
      gates: [
        { gateId: 'class_a_preview_cards', passed: true, sampleCount: 3, observed: 1, threshold: 1 },
        {
          gateId: 'no_success_claim_without_verified_readback',
          passed: false,
          sampleCount: 3,
          observed: 1,
          threshold: 0,
          reasonCode: 'unverified_success_claim',
        },
      ],
    },
    cloudAllowlist: passing,
    legacyRetirement: {
      passed: false,
      gates: [
        { gateId: 'legacy_fallback_rate', passed: true, sampleCount: 1, observed: 0, threshold: 0.02 },
        { gateId: 'route_shadow_parity', passed: false, sampleCount: 9, observed: 9, threshold: 0 },
      ],
    },
  };
}

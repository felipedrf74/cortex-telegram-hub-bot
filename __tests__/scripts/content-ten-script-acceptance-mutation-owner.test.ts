// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TEN_SCRIPT_ACCEPTANCE_REVISION,
  TEN_SCRIPT_ACCEPTANCE_SCENARIOS,
  TEN_SCRIPT_ACCEPTANCE_SCHEMA,
  bindProductionSmokeSource,
} from '../../scripts/content-ten-script-acceptance.mjs';

function pendingAcceptanceState() {
  return {
    schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    createdAt: '2026-08-22T22:00:00Z',
    scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      phase: scenario.phase,
      deliveryMode: scenario.deliveryMode,
      language: scenario.language,
      topicSha256: `sha256:${crypto.createHash('sha256').update(scenario.topic).digest('hex')}`,
      status: 'pending',
      jobId: null,
      output: null,
    })),
  };
}

function completedReleaseView(sourceSha: string) {
  const releaseId = 'b'.repeat(32);
  const releasePayloadDigest = `sha256:${'d'.repeat(64)}`;
  return {
    schema: 'nexus.release-state-view.v2',
    capturedAt: '2026-08-22T22:45:00Z',
    blocked: null,
    active: {
      releaseId,
      sourceSha,
      status: 'completed',
      releasePayloadDigest,
    },
    effective: {
      source: 'receipt',
      status: 'completed',
      releaseId,
      provable: true,
      stateStatus: 'completed',
      staleProjection: false,
      releasePayloadDigest,
    },
    activeReceipt: {
      schema: 'nexus.release-receipt.v3',
      releaseId,
      sourceSha,
      outcome: 'completed',
      completedAt: '2026-08-22T22:30:00Z',
      releasePayloadDigest,
    },
  };
}

describe('content acceptance mutation ownership', () => {
  it('binds the production smoke source once and rejects mismatched polls', () => {
    const state = pendingAcceptanceState();
    const sourceSha = 'a'.repeat(40);
    const releaseView = completedReleaseView(sourceSha);
    const firstBinding = {
      releaseView,
      releaseViewBytes: Buffer.from(`${JSON.stringify(releaseView)}\n`),
      boundAt: '2026-08-22T23:00:00Z',
    };

    expect(bindProductionSmokeSource(state, sourceSha, firstBinding)).toBe(true);
    expect(bindProductionSmokeSource(state, sourceSha, firstBinding)).toBe(false);

    const changedBytes = Buffer.from(`${JSON.stringify(releaseView)} \n`);
    expect(() => bindProductionSmokeSource(state, sourceSha, {
      ...firstBinding,
      releaseViewBytes: changedBytes,
    })).toThrow(/different release evidence/);
  });
});

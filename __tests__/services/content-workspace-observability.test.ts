// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  _getContentWorkspaceOperationalEventsForTests,
  _resetContentWorkspaceObservabilityForTests,
  classifyContentWorkspaceOperationalError,
  getContentWorkspaceObservabilitySnapshot,
  recordContentWorkspaceOperationalOutcome,
  recordContentWorkspaceProductSignal,
  recordContentWorkspaceQualitySignal,
  startContentWorkspaceObservation,
} from '../../src/services/content-workspace-observability';

describe('content workspace observability', () => {
  beforeEach(() => _resetContentWorkspaceObservabilityForTests());

  it('records fixed reliability outcomes and bounded duration buckets', () => {
    recordContentWorkspaceOperationalOutcome({
      operation: 'revision_save',
      outcome: 'success',
      durationMs: 42,
    });
    recordContentWorkspaceOperationalOutcome({
      operation: 'revision_save',
      outcome: 'no_change',
      durationMs: 900_000,
    });
    recordContentWorkspaceOperationalOutcome({
      operation: 'revision_save',
      outcome: 'conflict',
      reason: 'base_revision_conflict',
      durationMs: 200,
    });
    const value = getContentWorkspaceObservabilitySnapshot();

    expect(value.reliability.workspace_operation_total).toBe(3);
    expect(value.reliability.revision_save_success_total).toBe(1);
    expect(value.reliability.revision_save_no_change_total).toBe(1);
    expect(value.reliability.mutation_conflict_total).toBe(1);
    expect(value.reliability.autosave_conflict_total).toBe(1);
    expect(value.timers.revision_save).toEqual(expect.objectContaining({
      count: 3,
      totalMs: 600_242,
      minMs: 42,
      maxMs: 600_000,
    }));
    expect(value.timers.revision_save.buckets.lt_50_ms).toBe(1);
    expect(value.timers.revision_save.buckets.lt_250_ms).toBe(1);
    expect(value.timers.revision_save.buckets.gte_30000_ms).toBe(1);
  });

  it('uses a destructure-safe one-shot completion closure', () => {
    const { complete, completeFromError } = startContentWorkspaceObservation('proposal_accept', 'agent');
    complete('accepted');
    complete('failure', 'internal_failure');
    completeFromError({ code: 'CONTENT_AGENT_PROPOSAL_STALE' });

    const value = getContentWorkspaceObservabilitySnapshot();
    expect(value.outcomesByOperation.proposal_accept.accepted).toBe(1);
    expect(value.outcomesByOperation.proposal_accept.failure).toBe(0);
    expect(value.outcomesByOperation.proposal_accept.conflict).toBe(0);
    expect(value.reliability.proposal_accepted_total).toBe(1);
  });

  it('classifies errors using code and status only', () => {
    expect(classifyContentWorkspaceOperationalError({ code: 'CONTENT_REVISION_CONFLICT' })).toEqual({
      outcome: 'conflict',
      reason: 'base_revision_conflict',
    });
    expect(classifyContentWorkspaceOperationalError({ code: 'CONTENT_CLAIM_SAFETY_BLOCKED' })).toEqual({
      outcome: 'blocked',
      reason: 'claim_safety_block',
    });
    expect(classifyContentWorkspaceOperationalError({ status: 404 })).toEqual({
      outcome: 'failure',
      reason: 'not_found',
    });
    expect(classifyContentWorkspaceOperationalError({ code: 'PROVIDER_TIMEOUT' })).toEqual({
      outcome: 'failure',
      reason: 'provider_failure',
    });
    expect(classifyContentWorkspaceOperationalError({ code: 'CONTENT_AGENT_JOB_ACTIVE', status: 409 })).toEqual({
      outcome: 'conflict',
      reason: 'agent_job_active',
    });
    expect(classifyContentWorkspaceOperationalError({ code: 'CONTENT_AGENT_PACKAGE_BLOCKED', status: 409 })).toEqual({
      outcome: 'blocked',
      reason: 'agent_package_block',
    });
    expect(classifyContentWorkspaceOperationalError({ code: 'CONTENT_AGENT_OUTPUT_TOO_LARGE', status: 413 })).toEqual({
      outcome: 'blocked',
      reason: 'output_size_block',
    });
  });

  it('counts product and quality signals only when callers explicitly record them', () => {
    recordContentWorkspaceOperationalOutcome({ operation: 'item_create', outcome: 'replayed' });
    recordContentWorkspaceOperationalOutcome({ operation: 'lineage_record', outcome: 'replayed' });
    recordContentWorkspaceProductSignal('idea_captured');
    recordContentWorkspaceProductSignal('legacy_pipeline_compatibility_read');
    recordContentWorkspaceProductSignal('legacy_topics_compatibility_mutation');
    recordContentWorkspaceQualitySignal('unsupported_claim_warning');

    const value = getContentWorkspaceObservabilitySnapshot();
    expect(value.reliability.idempotent_replay_total).toBe(2);
    expect(value.product.idea_captured).toBe(1);
    expect(value.product.legacy_pipeline_compatibility_read).toBe(1);
    expect(value.product.legacy_topics_compatibility_mutation).toBe(1);
    expect(value.quality.unsupported_claim_warning).toBe(1);
    expect(value.quality.lineage_recorded_clear).toBe(0);
  });

  it('never exposes raw content, scope identity, fingerprints, URLs, or provider data', () => {
    const poisonedError = {
      code: 'CONTENT_REVISION_CONFLICT',
      status: 409,
      message: 'private script body',
      prompt: 'ignore previous instructions',
      sourceUrl: 'https://user:secret@example.com/private',
      tenantId: 991,
      userId: 882,
      contentHash: 'a'.repeat(64),
      providerResponse: { text: 'private provider output' },
    };
    for (let index = 0; index < 205; index += 1) {
      const observation = startContentWorkspaceObservation('revision_save');
      observation.completeFromError(poisonedError);
    }
    const publicSerialized = JSON.stringify(getContentWorkspaceObservabilitySnapshot());
    const internalSerialized = JSON.stringify(_getContentWorkspaceOperationalEventsForTests());

    for (const forbidden of [
      'private script body',
      'ignore previous instructions',
      'example.com',
      'tenantId',
      'userId',
      'aaaaaaaaaaaaaaaa',
      'private provider output',
    ]) {
      expect(publicSerialized).not.toContain(forbidden);
      expect(internalSerialized).not.toContain(forbidden);
    }
    expect(_getContentWorkspaceOperationalEventsForTests()).toHaveLength(200);
    expect(getContentWorkspaceObservabilitySnapshot().privacy.operationalEventRingExposed).toBe(false);
  });

  it('returns deep-cloned snapshots and resets deterministically', () => {
    recordContentWorkspaceProductSignal('script_generated');
    const value = getContentWorkspaceObservabilitySnapshot();
    value.product.script_generated = 999;
    expect(getContentWorkspaceObservabilitySnapshot().product.script_generated).toBe(1);

    _resetContentWorkspaceObservabilityForTests();
    expect(getContentWorkspaceObservabilitySnapshot().product.script_generated).toBe(0);
    expect(_getContentWorkspaceOperationalEventsForTests()).toEqual([]);
  });
});

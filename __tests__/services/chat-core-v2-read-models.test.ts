import { describe, expect, it } from 'vitest';

import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  buildReadModelExecutionPreconditions,
  classifyReadModelFreshness,
  getChatCoreV2Capabilities,
  isReadModelFreshEnough,
  type ChatCoreV2Domain,
} from '../../src/services/chat-core-v2';

const FIXED_NOW = new Date('2026-05-24T10:00:00.000Z');

describe('Chat Core v2 read model contracts', () => {
  it('normalizes deterministic read results and derives sensitivity from the capability registry', () => {
    const result = buildChatCoreV2ReadModelResult({
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      data: { count: 2, titles: ['Review proposal', 'Buy milk'] },
      sourceEntityIds: [' task:1 ', 'task:1', 'task:2'],
      sourceVersions: { 'task:2': 'v2' },
      generatedAt: '2026-05-24T09:59:59.000Z',
      maxSourceAgeSeconds: 60,
      locale: 'pt-PT',
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({
      schemaVersion: 'chat_core_v2_read_model@1.0.0',
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      sensitivity: 'personal',
      sourceEntityIds: ['task:1', 'task:2'],
      sourceVersions: { 'task:2': 'v2' },
      freshness: {
        generatedAt: '2026-05-24T09:59:59.000Z',
        maxSourceAgeSeconds: 60,
        status: 'live',
      },
      locale: 'pt-PT',
    });
    expect(isReadModelFreshEnough(result)).toBe(true);
  });

  it('requires read models to map to deterministic-read capabilities', () => {
    expect(() => buildChatCoreV2ReadModelResult({
      capabilityId: 'tasks.create',
      domain: 'tasks',
      data: {},
    })).toThrow(/not a deterministic read model capability/);

    expect(() => buildChatCoreV2ReadModelResult({
      capabilityId: 'tasks.today_summary',
      domain: 'finance',
      data: {},
    })).toThrow(/domain mismatch/);
  });

  it('keeps one read-model owner service for every deterministic MVP domain', () => {
    const deterministicReads = getChatCoreV2Capabilities()
      .filter((capability) => capability.rolloutStage === 'mvp_read')
      .filter((capability) => capability.routeMethods.includes('deterministic_read'));
    const domains = new Set<ChatCoreV2Domain>();

    for (const capability of deterministicReads) {
      domains.add(capability.domain);
      expect(capability.ownerService, capability.capabilityId).toMatch(/-read-model$/);
      expect(capability.reasoningTier, capability.capabilityId).toMatch(/^(none|synthesis)$/);
      expect(capability.fallbackAllowed, capability.capabilityId).toBe(true);
    }

    expect(domains).toEqual(new Set([
      'secretary',
      'tasks',
      'training',
      'content',
      'cooking',
      'finance',
      'connections',
      'notifications',
      'decision_center',
    ]));
  });

  it('builds stable context packs with merged source versions and audit-only context hashes', () => {
    const tasks = buildChatCoreV2ReadModelResult({
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      data: { count: 1 },
      sourceVersions: { 'task:1': 'v1' },
      generatedAt: '2026-05-24T09:59:00.000Z',
      now: FIXED_NOW,
    });
    const finance = buildChatCoreV2ReadModelResult({
      capabilityId: 'finance.summary',
      domain: 'finance',
      data: { overdueCount: 0 },
      sourceVersions: { 'finance:summary': 'v3' },
      generatedAt: '2026-05-24T09:58:00.000Z',
      now: FIXED_NOW,
    });

    const pack = buildChatCoreV2ReadContextPack([finance, tasks], {
      generatedAt: '2026-05-24T10:00:00.000Z',
    });
    const reordered = buildChatCoreV2ReadContextPack([tasks, finance], {
      generatedAt: '2026-05-24T10:05:00.000Z',
    });

    expect(pack).toMatchObject({
      schemaVersion: 'chat_core_v2_read_context_pack@1.0.0',
      domains: ['finance', 'tasks'],
      sourceEntityIds: ['finance:summary', 'task:1'],
      sourceVersions: {
        'finance:summary': 'v3',
        'task:1': 'v1',
      },
      sensitivity: 'financial',
      generatedAt: '2026-05-24T10:00:00.000Z',
    });
    expect(pack.contextHash).toMatch(/^[a-f0-9]{16}$/);
    expect(reordered.contextHash).toBe(pack.contextHash);
  });

  it('extracts source-version execution preconditions without using context hashes as gates', () => {
    const result = buildChatCoreV2ReadModelResult({
      capabilityId: 'decision_center.summary',
      domain: 'decision_center',
      data: { needsInput: 1 },
      sourceVersions: { 'decision:abc': 'decision-v4' },
      generatedAt: '2026-05-24T10:00:00.000Z',
      now: FIXED_NOW,
    });

    expect(buildReadModelExecutionPreconditions(result)).toEqual({
      requiredEntityVersions: { 'decision:abc': 'decision-v4' },
      invariants: [],
    });
  });

  it('classifies stale and unknown freshness deterministically', () => {
    expect(classifyReadModelFreshness('2026-05-24T09:58:00.000Z', 60, FIXED_NOW)).toBe('stale');
    expect(classifyReadModelFreshness('not-a-date', 60, FIXED_NOW)).toBe('unknown');

    const stale = buildChatCoreV2ReadModelResult({
      capabilityId: 'notifications.summary',
      domain: 'notifications',
      data: { unread: 3 },
      generatedAt: '2026-05-24T09:58:00.000Z',
      maxSourceAgeSeconds: 60,
      now: FIXED_NOW,
    });
    expect(stale.freshness.status).toBe('stale');
    expect(isReadModelFreshEnough(stale)).toBe(false);
  });

  it('rejects conflicting source versions across combined read models', () => {
    const first = buildChatCoreV2ReadModelResult({
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      data: { count: 1 },
      sourceVersions: { 'task:1': 'v1' },
    });
    const second = buildChatCoreV2ReadModelResult({
      capabilityId: 'secretary.agenda_summary',
      domain: 'secretary',
      data: { meetings: 1 },
      sourceVersions: { 'task:1': 'v2' },
    });

    expect(() => buildChatCoreV2ReadContextPack([first, second])).toThrow(/Conflicting source version/);
    expect(() => buildReadModelExecutionPreconditions([first, second])).toThrow(/Conflicting source version/);
  });
});

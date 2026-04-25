import { describe, expect, it, vi } from 'vitest';
import type { AgentSignal } from '../../src/services/intelligence-bus';

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

import {
  buildRadarTopicSummaries,
  filterSignalsForRadarPreferences,
} from '../../src/services/content-radar-preferences';

function signal(payload: Record<string, unknown>): AgentSignal {
  return {
    id: 1,
    source_agent: 'reaction-radar',
    signal_type: 'reaction_opportunity',
    payload,
    priority: 'normal',
    consumed_by: [],
    status: 'active',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    user_id: 77,
    confidence: 0.8,
    format_tag: null,
    pillar_tag: null,
    evidence_count: 1,
  };
}

describe('content radar preferences', () => {
  it('treats comma-separated preferences as independent radar topics', () => {
    const signals = [
      signal({ title: 'Claude Code ships stronger mobile workflows' }),
      signal({ title: 'Cycling nutrition trend' }),
    ];

    const filtered = filterSignalsForRadarPreferences(signals, [
      'Artificial Intelligence, Claude, ChatGPT, Israel',
    ]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].payload.title).toContain('Claude');
  });

  it('builds separate summaries for comma-separated preferences', () => {
    const summaries = buildRadarTopicSummaries(
      ['Artificial Intelligence, Claude, ChatGPT, Israel'],
      [signal({ title: 'ChatGPT and Claude workflows' })],
    );

    expect(summaries.map((summary) => summary.name)).toEqual([
      'Artificial Intelligence',
      'Claude',
      'ChatGPT',
      'Israel',
    ]);
  });
});

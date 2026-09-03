import { describe, expect, it } from 'vitest';
import {
  filterActiveContentAgentSignals,
  isActiveContentAgentSignal,
  isPausedContentAgent,
  PAUSED_CONTENT_AGENT_IDS,
} from '../../src/services/content-agent-lifecycle';

describe('content agent lifecycle', () => {
  it('normalizes paused agent identifiers across manifest and runtime forms', () => {
    expect(PAUSED_CONTENT_AGENT_IDS).toEqual(['performance_agent', 'reaction_radar', 'seo_agent']);
    expect(isPausedContentAgent(' performance-agent ')).toBe(true);
    expect(isPausedContentAgent('SEO_AGENT')).toBe(true);
    expect(isPausedContentAgent('reaction-radar')).toBe(true);
    expect(isPausedContentAgent('reaction-radar-agent')).toBe(true);
  });

  it('filters paused historical producers without mutating the source list', () => {
    const signals = [
      { id: 1, source_agent: 'performance-agent' },
      { id: 2, source_agent: 'reaction-radar' },
      { id: 3, source_agent: 'seo_agent' },
      { id: 4, source_agent: 'reaction-radar-agent' },
    ];

    expect(signals.map(isActiveContentAgentSignal)).toEqual([false, false, false, false]);
    expect(filterActiveContentAgentSignals(signals)).toEqual([]);
    expect(signals).toHaveLength(4);
  });
});

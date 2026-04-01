/**
 * Dynamic Routing Tests
 *
 * Tests that the router correctly uses skill-config routing definitions
 * and that the skill-manager filtering works with the router.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getPatternRoutes,
  getKeywordRoutes,
  getClassificationHints,
  getRegisteredDomainNames,
} from '../../src/skills/skill-config';
import type { PatternRoute, KeywordRoute, ClassificationHint } from '../../src/skills/skill-config';

describe('skill-config routing', () => {

  describe('getPatternRoutes', () => {
    it('returns pattern routes for all four domains', () => {
      const routes = getPatternRoutes();
      expect(routes).toHaveLength(4);
      const domains = routes.map(r => r.domain);
      expect(domains).toContain('secretary');
      expect(domains).toContain('triathlon');
      expect(domains).toContain('content');
      expect(domains).toContain('finance');
    });

    it('each route has at least one pattern', () => {
      const routes = getPatternRoutes();
      for (const route of routes) {
        expect(route.patterns.length).toBeGreaterThan(0);
        for (const p of route.patterns) {
          expect(p).toBeInstanceOf(RegExp);
        }
      }
    });

    it('filters by enabled skills when set is provided', () => {
      const routes = getPatternRoutes(new Set(['secretary', 'triathlon']));
      expect(routes).toHaveLength(2);
      const domains = routes.map(r => r.domain);
      expect(domains).toContain('secretary');
      expect(domains).toContain('triathlon');
      expect(domains).not.toContain('content');
    });

    it('returns empty array when no skills are enabled', () => {
      const routes = getPatternRoutes(new Set());
      expect(routes).toHaveLength(0);
    });

    it('secretary patterns match expected commands', () => {
      const routes = getPatternRoutes();
      const secretary = routes.find(r => r.domain === 'secretary')!;
      const allPatterns = secretary.patterns;
      expect(allPatterns.some(p => p.test('/todo buy milk'))).toBe(true);
      expect(allPatterns.some(p => p.test('/agenda today'))).toBe(true);
      expect(allPatterns.some(p => p.test('/email send'))).toBe(true);
    });

    it('triathlon patterns match expected commands', () => {
      const routes = getPatternRoutes();
      const triathlon = routes.find(r => r.domain === 'triathlon')!;
      expect(triathlon.patterns.some(p => p.test('/gym'))).toBe(true);
      expect(triathlon.patterns.some(p => p.test('/train upper body'))).toBe(true);
    });

    it('content patterns match expected commands', () => {
      const routes = getPatternRoutes();
      const content = routes.find(r => r.domain === 'content')!;
      expect(content.patterns.some(p => p.test('/video idea'))).toBe(true);
      expect(content.patterns.some(p => p.test('/genscript about AI'))).toBe(true);
    });
  });

  describe('getKeywordRoutes', () => {
    it('returns keyword routes for all four domains', () => {
      const routes = getKeywordRoutes();
      expect(routes).toHaveLength(4);
    });

    it('non-secretary domains have lower priority (checked first)', () => {
      const routes = getKeywordRoutes();
      const nonSecretary = routes.filter(r => r.domain !== 'secretary');
      const secretary = routes.find(r => r.domain === 'secretary')!;
      for (const r of nonSecretary) {
        expect(r.priority).toBeLessThan(secretary.priority);
      }
    });

    it('secretary has highest priority number (checked last)', () => {
      const routes = getKeywordRoutes();
      const secretary = routes.find(r => r.domain === 'secretary')!;
      expect(secretary.priority).toBe(99);
    });

    it('routes are sorted by priority ascending', () => {
      const routes = getKeywordRoutes();
      for (let i = 1; i < routes.length; i++) {
        expect(routes[i].priority).toBeGreaterThanOrEqual(routes[i - 1].priority);
      }
    });

    it('filters by enabled skills', () => {
      const routes = getKeywordRoutes(new Set(['triathlon']));
      expect(routes).toHaveLength(1);
      expect(routes[0].domain).toBe('triathlon');
    });

    it('triathlon keyword matches workout-related terms', () => {
      const routes = getKeywordRoutes();
      const triathlon = routes.find(r => r.domain === 'triathlon')!;
      expect(triathlon.pattern.test('my workout was hard')).toBe(true);
      expect(triathlon.pattern.test('how much protein')).toBe(true);
      expect(triathlon.pattern.test('squat form')).toBe(true);
    });

    it('content keyword matches creator terms', () => {
      const routes = getKeywordRoutes();
      const content = routes.find(r => r.domain === 'content')!;
      expect(content.pattern.test('youtube video idea')).toBe(true);
      expect(content.pattern.test('instagram reels')).toBe(true);
    });

    it('secretary keyword matches task/calendar terms', () => {
      const routes = getKeywordRoutes();
      const secretary = routes.find(r => r.domain === 'secretary')!;
      expect(secretary.pattern.test('my tasks for today')).toBe(true);
      expect(secretary.pattern.test('set a reminder')).toBe(true);
    });
  });

  describe('getClassificationHints', () => {
    it('returns hints for all four domains', () => {
      const hints = getClassificationHints();
      expect(hints).toHaveLength(4);
    });

    it('each hint has label, description, and examples', () => {
      const hints = getClassificationHints();
      for (const hint of hints) {
        expect(hint.label).toBeTruthy();
        expect(hint.description).toBeTruthy();
        expect(hint.examples.length).toBeGreaterThan(0);
      }
    });

    it('filters by enabled skills', () => {
      const hints = getClassificationHints(new Set(['secretary']));
      expect(hints).toHaveLength(1);
      expect(hints[0].label).toBe('secretary');
    });
  });

  describe('getRegisteredDomainNames', () => {
    it('returns all four domain names', () => {
      const names = getRegisteredDomainNames();
      expect(names).toEqual(expect.arrayContaining(['secretary', 'triathlon', 'content', 'finance']));
      expect(names).toHaveLength(4);
    });
  });
});

describe('dynamic routing integration with classifier', () => {
  // Mock skill-manager so classifier uses all skill routes
  vi.mock('../../src/skills/skill-manager', async () => {
    const config = await import('../../src/skills/skill-config');
    return {
      getEnabledPatternRoutes: () => config.getPatternRoutes(),
      getEnabledKeywordRoutes: () => config.getKeywordRoutes(),
      getEnabledClassificationHints: () => config.getClassificationHints(),
      isSkillEnabled: () => true,
    };
  });

  vi.mock('../../src/services/anthropic', () => ({
    classifyMessage: vi.fn(),
  }));

  vi.mock('../../src/utils/logger', () => ({
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), child: vi.fn().mockReturnThis(),
    },
  }));

  it('patternMatch uses skill-config routes', async () => {
    const { patternMatch } = await import('../../src/router/classifier');
    expect(patternMatch('/todo buy milk')).toBe('secretary');
    expect(patternMatch('/gym upper body')).toBe('triathlon');
    expect(patternMatch('/video idea')).toBe('content');
  });

  it('keywordMatch uses skill-config routes with priority', async () => {
    const { keywordMatch } = await import('../../src/router/classifier');
    expect(keywordMatch('my workout was great')).toBe('triathlon');
    expect(keywordMatch('youtube strategy')).toBe('content');
    expect(keywordMatch('check my tasks')).toBe('secretary');
  });

  it('keywordMatch returns null for unmatched messages', async () => {
    const { keywordMatch } = await import('../../src/router/classifier');
    expect(keywordMatch('hello there')).toBeNull();
    expect(keywordMatch('good morning')).toBeNull();
  });

  it('buildClassifierHints generates hint text from skills', async () => {
    const { buildClassifierHints } = await import('../../src/router/classifier');
    const hints = buildClassifierHints();
    expect(hints).toContain('"secretary"');
    expect(hints).toContain('"triathlon"');
    expect(hints).toContain('"content"');
    expect(hints).toContain('scheduling');
    expect(hints).toContain('gym workouts');
    expect(hints).toContain('YouTube');
  });
});

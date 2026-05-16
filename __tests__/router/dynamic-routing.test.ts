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
    it('returns pattern routes for all eight domains', () => {
      const routes = getPatternRoutes();
      expect(routes).toHaveLength(8);
      const domains = routes.map(r => r.domain);
      expect(domains).toContain('secretary');
      expect(domains).toContain('triathlon');
      expect(domains).toContain('content');
      expect(domains).toContain('finance');
      expect(domains).toContain('cooking');
      expect(domains).toContain('connections');
      expect(domains).toContain('notifications');
      expect(domains).toContain('decision_center');
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

    it('finance patterns match expected commands', () => {
      const routes = getPatternRoutes();
      const finance = routes.find(r => r.domain === 'finance')!;
      expect(finance.patterns.some(p => p.test('/finance'))).toBe(true);
      expect(finance.patterns.some(p => p.test('/expense log 50'))).toBe(true);
      expect(finance.patterns.some(p => p.test('/tax'))).toBe(true);
      expect(finance.patterns.some(p => p.test('/darf'))).toBe(true);
      expect(finance.patterns.some(p => p.test('/receipt'))).toBe(true);
    });

    it('cooking patterns match expected commands', () => {
      const routes = getPatternRoutes();
      const cooking = routes.find(r => r.domain === 'cooking')!;
      expect(cooking.patterns.some(p => p.test('/cook something'))).toBe(true);
      expect(cooking.patterns.some(p => p.test('/recipe chicken'))).toBe(true);
      expect(cooking.patterns.some(p => p.test('/mealplan'))).toBe(true);
      expect(cooking.patterns.some(p => p.test('/shopping'))).toBe(true);
    });
  });

  describe('getKeywordRoutes', () => {
    it('returns keyword routes for all eight domains', () => {
      const routes = getKeywordRoutes();
      expect(routes).toHaveLength(8);
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
      expect(triathlon.pattern.test('how much protein')).toBe(false);
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

    it('finance keyword matches tax and expense terms', () => {
      const routes = getKeywordRoutes();
      const finance = routes.find(r => r.domain === 'finance')!;
      expect(finance.pattern.test('my expenses this month')).toBe(true);
      expect(finance.pattern.test('carnê-leão calculation')).toBe(true);
      expect(finance.pattern.test('calculate DARF')).toBe(true);
      expect(finance.pattern.test('orçamento mensal')).toBe(true);
      expect(finance.pattern.test('nota fiscal')).toBe(true);
    });

    it('cooking keyword matches recipe and meal terms', () => {
      const routes = getKeywordRoutes();
      const cooking = routes.find(r => r.domain === 'cooking')!;
      expect(cooking.pattern.test('find me a recipe')).toBe(true);
      expect(cooking.pattern.test('meal plan for the week')).toBe(true);
      expect(cooking.pattern.test('shopping list')).toBe(true);
      expect(cooking.pattern.test('receita de frango')).toBe(true);
    });
  });

  describe('getClassificationHints', () => {
    it('returns hints for all eight domains', () => {
      const hints = getClassificationHints();
      expect(hints).toHaveLength(8);
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
    it('returns all eight domain names', () => {
      const names = getRegisteredDomainNames();
      expect(names).toEqual(expect.arrayContaining([
        'secretary', 'triathlon', 'content', 'finance', 'cooking',
        'connections', 'notifications', 'decision_center',
      ]));
      expect(names).toHaveLength(8);
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
    LOGGER_REDACTION_PATHS: [],
}));

  it('patternMatch uses skill-config routes', async () => {
    const { patternMatch } = await import('../../src/router/classifier');
    expect(patternMatch('/todo buy milk')).toBe('secretary');
    expect(patternMatch('/gym upper body')).toBe('triathlon');
    expect(patternMatch('/video idea')).toBe('content');
    expect(patternMatch('/finance')).toBe('finance');
    expect(patternMatch('/tax')).toBe('finance');
    expect(patternMatch('/recipe chicken')).toBe('cooking');
    expect(patternMatch('/mealplan')).toBe('cooking');
  });

  it('keywordMatch uses skill-config routes with priority', async () => {
    const { keywordMatch } = await import('../../src/router/classifier');
    expect(keywordMatch('my workout was great')).toBe('triathlon');
    expect(keywordMatch('youtube strategy')).toBe('content');
    expect(keywordMatch('check my tasks')).toBe('secretary');
    expect(keywordMatch('calculate DARF')).toBe('finance');
    expect(keywordMatch('find a recipe')).toBe('cooking');
  });

  it('keywordMatch returns null for unmatched messages', async () => {
    const { keywordMatch } = await import('../../src/router/classifier');
    expect(keywordMatch('hello there')).toBeNull();
    expect(keywordMatch('good morning')).toBeNull();
  });

  it('buildClassifierHints generates hint text from all skills', async () => {
    const { buildClassifierHints } = await import('../../src/router/classifier');
    const hints = buildClassifierHints();
    expect(hints).toContain('"secretary"');
    expect(hints).toContain('"triathlon"');
    expect(hints).toContain('"content"');
    expect(hints).toContain('"finance"');
    expect(hints).toContain('"cooking"');
    expect(hints).toContain('scheduling');
    expect(hints).toContain('gym workouts');
    expect(hints).toContain('YouTube');
    expect(hints).toContain('DARF');
    expect(hints).toContain('recipes');
  });
});

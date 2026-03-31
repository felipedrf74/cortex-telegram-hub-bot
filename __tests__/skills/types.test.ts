/**
 * Tests for src/skills/types.ts
 *
 * Since types.ts is purely a type definition file (no runtime logic),
 * these tests verify that:
 * 1. The module exports without errors
 * 2. Objects conforming to the interfaces are structurally valid
 * 3. The NexusSkill contract can be implemented correctly
 * 4. Edge cases in type constraints are handled
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  PatternRoute,
  KeywordRoute,
  ClassificationHint,
  SkillToolDefinition,
  SubModuleManifest,
  SkillManifest,
  SkillCategory,
  SkillTier,
  SkillConfig,
  SkillHandleContext,
  SkillResponse,
  NexusSkill,
  ManifestValidationResult,
  DependencyResolutionResult,
} from '../../src/skills/types';

// ─── Helpers ────────────────────────────────────────────────────────

function createTestManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'Test Author',
    license: 'MIT',
    hubVersion: '>=1.0.0',
    platforms: ['telegram'],
    category: 'productivity',
    tier: 'private',
    ...overrides,
  };
}

function createTestConfig(): SkillConfig {
  return {
    skillId: 'test-skill',
    enabled: true,
    enabledSubModules: ['training-plans'],
    envVars: {},
    preferences: {},
  };
}

function createTestHandleContext(overrides: Partial<SkillHandleContext> = {}): SkillHandleContext {
  return {
    userId: 123456789,
    message: 'test message',
    history: [],
    stateContext: '',
    config: createTestConfig(),
    ...overrides,
  };
}

/**
 * Creates a minimal NexusSkill implementation for testing.
 */
function createMockSkill(manifest?: Partial<SkillManifest>): NexusSkill {
  return {
    manifest: createTestManifest(manifest),
    install: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    getPatternRoutes: vi.fn().mockReturnValue([]),
    getKeywordRoutes: vi.fn().mockReturnValue([]),
    getClassificationHints: vi.fn().mockReturnValue({
      label: 'test',
      description: 'A test skill',
      examples: ['test message'],
    }),
    handle: vi.fn().mockResolvedValue({ text: 'ok', skillId: 'test-skill' }),
    getTools: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({}),
    getSubModules: vi.fn().mockReturnValue([]),
    enableSubModule: vi.fn().mockResolvedValue(undefined),
    disableSubModule: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('skills/types', () => {

  describe('SkillManifest', () => {
    it('should create a valid manifest with all required fields', () => {
      const manifest = createTestManifest();
      expect(manifest.id).toBe('test-skill');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.tier).toBe('private');
      expect(manifest.license).toBe('MIT');
      expect(manifest.hubVersion).toBe('>=1.0.0');
      expect(manifest.platforms).toContain('telegram');
      expect(manifest.category).toBe('productivity');
    });

    it('should support all skill tiers', () => {
      const tiers: SkillTier[] = ['official', 'community', 'private'];
      for (const tier of tiers) {
        const manifest = createTestManifest({ tier });
        expect(manifest.tier).toBe(tier);
      }
    });

    it('should support all categories', () => {
      const categories: SkillCategory[] = [
        'productivity', 'fitness', 'content', 'finance',
        'developer', 'lifestyle', 'education', 'other',
      ];
      for (const category of categories) {
        const manifest = createTestManifest({ category });
        expect(manifest.category).toBe(category);
      }
    });

    it('should support optional fields', () => {
      const manifest = createTestManifest({
        dependencies: ['secretary-core', 'calendar-sync'],
        tags: ['productivity', 'ai'],
      });
      expect(manifest.dependencies).toHaveLength(2);
      expect(manifest.tags).toContain('productivity');
    });

    it('should include sub-module declarations', () => {
      const subModule: SubModuleManifest = {
        id: 'garmin-sync',
        name: 'Garmin Connect Sync',
        description: 'Sync workout data from Garmin',
        default: false,
        requiredEnvVars: ['GARMIN_EMAIL', 'GARMIN_PASSWORD'],
      };
      const manifest = createTestManifest({ subModules: [subModule] });
      expect(manifest.subModules).toHaveLength(1);
      expect(manifest.subModules![0].id).toBe('garmin-sync');
      expect(manifest.subModules![0].default).toBe(false);
      expect(manifest.subModules![0].requiredEnvVars).toContain('GARMIN_EMAIL');
    });

    it('should support pricing configuration', () => {
      const manifest = createTestManifest({
        pricing: { model: 'subscription', priceInCents: 499, billingPeriod: 'monthly' },
      });
      expect(manifest.pricing!.model).toBe('subscription');
      expect(manifest.pricing!.priceInCents).toBe(499);
    });
  });

  describe('PatternRoute', () => {
    it('should match command patterns', () => {
      const route: PatternRoute = {
        pattern: /^\/(train|gym|run)\b/i,
        description: 'Triathlon training commands',
      };
      expect(route.pattern.test('/train')).toBe(true);
      expect(route.pattern.test('/gym session')).toBe(true);
      expect(route.pattern.test('hello')).toBe(false);
    });

    it('should work without optional description', () => {
      const route: PatternRoute = { pattern: /^\/test\b/i };
      expect(route.pattern.test('/test')).toBe(true);
      expect(route.description).toBeUndefined();
    });
  });

  describe('KeywordRoute', () => {
    it('should match keyword patterns', () => {
      const route: KeywordRoute = {
        pattern: /\b(workout|protein|macros)\b/i,
        description: 'Fitness keywords',
      };
      expect(route.pattern.test('what about my protein intake?')).toBe(true);
      expect(route.pattern.test('schedule a meeting')).toBe(false);
    });
  });

  describe('ClassificationHint', () => {
    it('should provide classifier context', () => {
      const hint: ClassificationHint = {
        label: 'triathlon',
        description: 'Handles training, nutrition, and race planning',
        examples: ['plan my 5K training', 'what should I eat before a run'],
      };
      expect(hint.label).toBe('triathlon');
      expect(hint.examples).toHaveLength(2);
    });
  });

  describe('SkillToolDefinition', () => {
    it('should define tool schema', () => {
      const tool: SkillToolDefinition = {
        name: 'get_weather',
        description: 'Get current weather for a city',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      };
      expect(tool.name).toBe('get_weather');
      expect(tool.inputSchema).toBeDefined();
    });
  });

  describe('SkillResponse', () => {
    it('should return text with skillId', () => {
      const response: SkillResponse = {
        text: 'Your workout is ready!',
        skillId: 'triathlon-coach',
        toolsUsed: ['get_calendar_events'],
      };
      expect(response.text).toBeTruthy();
      expect(response.skillId).toBe('triathlon-coach');
      expect(response.toolsUsed).toHaveLength(1);
    });

    it('should work without toolsUsed', () => {
      const response: SkillResponse = { text: 'Hello!', skillId: 'test' };
      expect(response.toolsUsed).toBeUndefined();
    });
  });

  describe('SubModuleManifest', () => {
    it('should declare required env vars', () => {
      const sub: SubModuleManifest = {
        id: 'garmin-sync',
        name: 'Garmin Connect Sync',
        description: 'Sync workout data from Garmin Connect',
        default: false,
        requiredEnvVars: ['GARMIN_EMAIL', 'GARMIN_PASSWORD'],
      };
      expect(sub.requiredEnvVars).toHaveLength(2);
      expect(sub.default).toBe(false);
    });

    it('should support dependencies on other sub-modules', () => {
      const sub: SubModuleManifest = {
        id: 'training-plans',
        name: 'Training Plans',
        description: 'Periodized workout programming',
        default: true,
        dependencies: ['garmin-sync'],
      };
      expect(sub.dependencies).toContain('garmin-sync');
    });

    it('should work without optional fields', () => {
      const sub: SubModuleManifest = {
        id: 'basic',
        name: 'Basic',
        description: 'Basic feature',
        default: true,
      };
      expect(sub.requiredEnvVars).toBeUndefined();
      expect(sub.dependencies).toBeUndefined();
    });
  });

  describe('Validation types', () => {
    it('should represent validation results', () => {
      const result: ManifestValidationResult = {
        valid: false,
        errors: [
          { field: 'version', message: 'Invalid semver format' },
        ],
      };
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('Dependency resolution types', () => {
    it('should represent resolution results', () => {
      const result: DependencyResolutionResult = {
        resolved: true,
        order: ['core', 'auth', 'dashboard'],
        missing: [],
        circular: [],
      };
      expect(result.resolved).toBe(true);
      expect(result.order).toHaveLength(3);
    });

    it('should represent unresolved dependencies', () => {
      const result: DependencyResolutionResult = {
        resolved: false,
        order: [],
        missing: ['auth-provider'],
        circular: [['a', 'b', 'a']],
      };
      expect(result.resolved).toBe(false);
      expect(result.missing).toContain('auth-provider');
      expect(result.circular).toHaveLength(1);
    });
  });

  describe('SkillConfig', () => {
    it('should hold skill configuration', () => {
      const config = createTestConfig();
      expect(config.skillId).toBe('test-skill');
      expect(config.enabled).toBe(true);
      expect(config.enabledSubModules).toContain('training-plans');
    });
  });

  describe('NexusSkill (full contract)', () => {
    it('should implement all required methods', () => {
      const skill = createMockSkill();

      expect(skill.manifest).toBeDefined();
      expect(typeof skill.install).toBe('function');
      expect(typeof skill.enable).toBe('function');
      expect(typeof skill.disable).toBe('function');
      expect(typeof skill.uninstall).toBe('function');
      expect(typeof skill.getPatternRoutes).toBe('function');
      expect(typeof skill.getKeywordRoutes).toBe('function');
      expect(typeof skill.getClassificationHints).toBe('function');
      expect(typeof skill.handle).toBe('function');
      expect(typeof skill.getTools).toBe('function');
      expect(typeof skill.executeTool).toBe('function');
      expect(typeof skill.getSubModules).toBe('function');
      expect(typeof skill.enableSubModule).toBe('function');
      expect(typeof skill.disableSubModule).toBe('function');
    });

    it('should execute full lifecycle in order', async () => {
      const callOrder: string[] = [];
      const skill: NexusSkill = {
        manifest: createTestManifest(),
        install: vi.fn().mockImplementation(async () => { callOrder.push('install'); }),
        enable: vi.fn().mockImplementation(async () => { callOrder.push('enable'); }),
        disable: vi.fn().mockImplementation(async () => { callOrder.push('disable'); }),
        uninstall: vi.fn().mockImplementation(async () => { callOrder.push('uninstall'); }),
        getPatternRoutes: () => [],
        getKeywordRoutes: () => [],
        getClassificationHints: () => ({ label: 'test', description: 'test', examples: [] }),
        handle: vi.fn().mockResolvedValue({ text: 'ok', skillId: 'test-skill' }),
        getTools: () => [],
        executeTool: vi.fn().mockResolvedValue({}),
        getSubModules: () => [],
        enableSubModule: vi.fn().mockResolvedValue(undefined),
        disableSubModule: vi.fn().mockResolvedValue(undefined),
      };

      await skill.install();
      await skill.enable();
      const ctx = createTestHandleContext();
      await skill.handle(ctx);
      await skill.disable();
      await skill.uninstall();

      expect(callOrder).toEqual(['install', 'enable', 'disable', 'uninstall']);
    });

    it('should register routes, tools, and classification hints', () => {
      const skill: NexusSkill = {
        manifest: createTestManifest({ id: 'triathlon-coach' }),
        install: vi.fn().mockResolvedValue(undefined),
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        uninstall: vi.fn().mockResolvedValue(undefined),
        getPatternRoutes: () => [
          { pattern: /^\/(train|gym)\b/i, description: 'Training commands' },
          { pattern: /^\/(meal|macros)\b/i, description: 'Nutrition commands' },
        ],
        getKeywordRoutes: () => [
          { pattern: /\b(workout|protein)\b/i, description: 'Fitness keywords' },
        ],
        getClassificationHints: () => ({
          label: 'triathlon',
          description: 'Training and nutrition',
          examples: ['plan my workout'],
        }),
        handle: vi.fn().mockResolvedValue({ text: 'ok', skillId: 'triathlon-coach' }),
        getTools: () => [
          {
            name: 'log_workout',
            description: 'Log a workout',
            inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
          },
        ],
        executeTool: vi.fn().mockResolvedValue({ logged: true }),
        getSubModules: () => [
          { id: 'garmin-sync', name: 'Garmin Sync', description: 'Sync from Garmin', default: false },
          { id: 'nutrition', name: 'Nutrition', description: 'Meal tracking', default: true },
        ],
        enableSubModule: vi.fn().mockResolvedValue(undefined),
        disableSubModule: vi.fn().mockResolvedValue(undefined),
      };

      expect(skill.getPatternRoutes()).toHaveLength(2);
      expect(skill.getKeywordRoutes()).toHaveLength(1);
      expect(skill.getClassificationHints().label).toBe('triathlon');
      expect(skill.getTools()).toHaveLength(1);
      expect(skill.getSubModules()).toHaveLength(2);
    });

    it('should handle messages and return responses with skillId', async () => {
      const skill = createMockSkill();
      (skill.handle as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Your 5K training plan starts Monday',
        skillId: 'test-skill',
        toolsUsed: ['get_calendar_events'],
      });

      const ctx = createTestHandleContext({ message: 'plan my 5K training' });
      const response = await skill.handle(ctx);
      expect(response.text).toContain('5K');
      expect(response.skillId).toBe('test-skill');
      expect(response.toolsUsed).toContain('get_calendar_events');
    });
  });
});

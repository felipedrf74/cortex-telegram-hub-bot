/**
 * QA Validation Tests — NexusSkill interface & SkillManifest types
 *
 * Validates that the type definitions in src/skills/types.ts are:
 * 1. Correctly exported and importable
 * 2. Structurally sound (required vs optional fields)
 * 3. Implementable (NexusSkill can be satisfied by a concrete class)
 * 4. Consistent across related types (manifest ↔ config ↔ handle context)
 */

import { describe, it, expect } from 'vitest';
import type {
  PatternRoute,
  KeywordRoute,
  ClassificationHint,
  SkillToolDefinition,
  SkillResponse,
  SubModuleManifest,
  SkillCategory,
  SkillTier,
  SkillPricing,
  SkillManifest,
  ManifestValidationError,
  ManifestValidationResult,
  DependencyNode,
  DependencyResolutionResult,
  SkillConfig,
  SkillHandleContext,
  NexusSkill,
} from '../../src/skills/types';

// ── Helpers ──────────────────────────────────────────────────────────

/** Builds a minimal valid SkillManifest with all required fields. */
function buildManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    author: 'QA Agent',
    license: 'MIT',
    description: 'A test skill',
    hubVersion: '>=1.0.0 <2.0.0',
    platforms: ['telegram'],
    category: 'productivity',
    tier: 'community',
    ...overrides,
  };
}

/** Builds a minimal valid SkillConfig. */
function buildConfig(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    skillId: 'test-skill',
    enabled: true,
    enabledSubModules: [],
    envVars: {},
    preferences: {},
    ...overrides,
  };
}

/** Builds a minimal valid SkillHandleContext. */
function buildContext(overrides: Partial<SkillHandleContext> = {}): SkillHandleContext {
  return {
    userId: 12345,
    message: 'hello',
    history: [],
    stateContext: '',
    config: buildConfig(),
    ...overrides,
  };
}

/**
 * A concrete implementation of NexusSkill for testing that the interface
 * is fully implementable. This proves the contract is satisfiable.
 */
class StubSkill implements NexusSkill {
  readonly manifest: SkillManifest;

  constructor(manifest?: Partial<SkillManifest>) {
    this.manifest = buildManifest(manifest);
  }

  async install(): Promise<void> {}
  async enable(): Promise<void> {}
  async disable(): Promise<void> {}
  async uninstall(): Promise<void> {}

  getPatternRoutes(): PatternRoute[] {
    return [{ pattern: /^\/stub$/, description: 'stub command' }];
  }

  getKeywordRoutes(): KeywordRoute[] {
    return [{ pattern: /stub|test/i, description: 'stub keywords' }];
  }

  getClassificationHints(): ClassificationHint {
    return {
      label: 'stub',
      description: 'A stub skill for testing',
      examples: ['run stub', 'test stub'],
    };
  }

  async handle(ctx: SkillHandleContext): Promise<SkillResponse> {
    return {
      text: `Handled: ${ctx.message}`,
      skillId: this.manifest.id,
      toolsUsed: [],
    };
  }

  getTools(): SkillToolDefinition[] {
    return [{
      name: 'stub_echo',
      description: 'Echoes input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }];
  }

  async executeTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    if (toolName === 'stub_echo') return { echoed: input.text };
    throw new Error(`Unknown tool: ${toolName}`);
  }

  getSubModules(): SubModuleManifest[] {
    return this.manifest.subModules ?? [];
  }

  async enableSubModule(_subModuleId: string): Promise<void> {}
  async disableSubModule(_subModuleId: string): Promise<void> {}
}

// ═══════════════════════════════════════════════════════════════════
// TYPE EXPORT VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — exports', () => {
  it('exports all routing types', () => {
    // These are type-only imports; if they fail, TS compilation breaks.
    // At runtime we verify via structural tests.
    const route: PatternRoute = { pattern: /test/ };
    const keyword: KeywordRoute = { pattern: /test/ };
    const hint: ClassificationHint = {
      label: 'test',
      description: 'test',
      examples: ['test'],
    };

    expect(route.pattern).toBeInstanceOf(RegExp);
    expect(keyword.pattern).toBeInstanceOf(RegExp);
    expect(hint.label).toBe('test');
    expect(hint.examples).toHaveLength(1);
  });

  it('exports tool definition type', () => {
    const tool: SkillToolDefinition = {
      name: 'test_tool',
      description: 'A tool',
      inputSchema: { type: 'object' },
    };
    expect(tool.name).toBe('test_tool');
    expect(tool.inputSchema).toHaveProperty('type');
  });

  it('exports response type', () => {
    const response: SkillResponse = {
      text: 'Hello',
      skillId: 'my-skill',
    };
    expect(response.text).toBe('Hello');
    expect(response.toolsUsed).toBeUndefined(); // optional
  });

  it('exports validation types', () => {
    const error: ManifestValidationError = { field: 'name', message: 'missing' };
    const result: ManifestValidationResult = { valid: false, errors: [error] };
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('exports dependency resolution types', () => {
    const node: DependencyNode = { name: 'a', dependencies: ['b'] };
    const result: DependencyResolutionResult = {
      resolved: false,
      order: [],
      missing: ['b'],
      circular: [],
    };
    expect(node.dependencies).toContain('b');
    expect(result.missing).toContain('b');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL MANIFEST STRUCTURE
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — SkillManifest structure', () => {
  it('requires all mandatory fields', () => {
    const manifest = buildManifest();
    expect(manifest.id).toBe('test-skill');
    expect(manifest.name).toBe('Test Skill');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.author).toBe('QA Agent');
    expect(manifest.license).toBe('MIT');
    expect(manifest.description).toBe('A test skill');
    expect(manifest.hubVersion).toBe('>=1.0.0 <2.0.0');
    expect(manifest.platforms).toEqual(['telegram']);
    expect(manifest.category).toBe('productivity');
    expect(manifest.tier).toBe('community');
  });

  it('accepts all optional fields', () => {
    const manifest = buildManifest({
      dependencies: ['core-utils'],
      subModules: [
        {
          id: 'garmin-sync',
          name: 'Garmin Sync',
          description: 'Syncs with Garmin',
          default: false,
          requiredEnvVars: ['GARMIN_API_KEY'],
        },
      ],
      tags: ['fitness', 'triathlon'],
      pricing: { model: 'free' },
    });
    expect(manifest.dependencies).toEqual(['core-utils']);
    expect(manifest.subModules).toHaveLength(1);
    expect(manifest.tags).toContain('fitness');
    expect(manifest.pricing?.model).toBe('free');
  });

  it('allows multiple platforms', () => {
    const manifest = buildManifest({
      platforms: ['telegram', 'discord', 'whatsapp'],
    });
    expect(manifest.platforms).toHaveLength(3);
  });

  it('supports all valid SkillCategory values', () => {
    const categories: SkillCategory[] = [
      'productivity', 'fitness', 'content', 'finance',
      'developer', 'lifestyle', 'education', 'other',
    ];
    for (const cat of categories) {
      const manifest = buildManifest({ category: cat });
      expect(manifest.category).toBe(cat);
    }
  });

  it('supports all valid SkillTier values', () => {
    const tiers: SkillTier[] = ['official', 'community', 'private'];
    for (const tier of tiers) {
      const manifest = buildManifest({ tier });
      expect(manifest.tier).toBe(tier);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL PRICING
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — SkillPricing', () => {
  it('supports free model', () => {
    const pricing: SkillPricing = { model: 'free' };
    expect(pricing.model).toBe('free');
    expect(pricing.priceInCents).toBeUndefined();
  });

  it('supports subscription model with billing period', () => {
    const pricing: SkillPricing = {
      model: 'subscription',
      priceInCents: 999,
      billingPeriod: 'monthly',
    };
    expect(pricing.priceInCents).toBe(999);
    expect(pricing.billingPeriod).toBe('monthly');
  });

  it('supports one-time model', () => {
    const pricing: SkillPricing = {
      model: 'one-time',
      priceInCents: 4999,
    };
    expect(pricing.model).toBe('one-time');
    expect(pricing.billingPeriod).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SUB-MODULE MANIFEST
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — SubModuleManifest', () => {
  it('contains all required fields', () => {
    const sub: SubModuleManifest = {
      id: 'garmin-sync',
      name: 'Garmin Sync',
      description: 'Syncs workout data from Garmin Connect',
      default: false,
    };
    expect(sub.id).toBe('garmin-sync');
    expect(sub.default).toBe(false);
  });

  it('supports optional env var requirements', () => {
    const sub: SubModuleManifest = {
      id: 'garmin-sync',
      name: 'Garmin Sync',
      description: 'Syncs data',
      default: false,
      requiredEnvVars: ['GARMIN_CLIENT_ID', 'GARMIN_SECRET'],
    };
    expect(sub.requiredEnvVars).toHaveLength(2);
  });

  it('supports optional dependencies on other sub-modules', () => {
    const sub: SubModuleManifest = {
      id: 'advanced-analytics',
      name: 'Advanced Analytics',
      description: 'Analytics requiring garmin data',
      default: false,
      dependencies: ['garmin-sync'],
    };
    expect(sub.dependencies).toContain('garmin-sync');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL CONFIG
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — SkillConfig', () => {
  it('contains all required fields', () => {
    const config = buildConfig();
    expect(config.skillId).toBe('test-skill');
    expect(config.enabled).toBe(true);
    expect(config.enabledSubModules).toEqual([]);
    expect(config.envVars).toEqual({});
    expect(config.preferences).toEqual({});
  });

  it('supports populated sub-modules and env vars', () => {
    const config = buildConfig({
      enabledSubModules: ['garmin-sync', 'training-plans'],
      envVars: { GARMIN_API_KEY: 'secret123' },
      preferences: { units: 'metric', language: 'en' },
    });
    expect(config.enabledSubModules).toHaveLength(2);
    expect(config.envVars['GARMIN_API_KEY']).toBe('secret123');
    expect(config.preferences['units']).toBe('metric');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL HANDLE CONTEXT
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — SkillHandleContext', () => {
  it('contains all required fields', () => {
    const ctx = buildContext();
    expect(ctx.userId).toBe(12345);
    expect(ctx.message).toBe('hello');
    expect(ctx.history).toEqual([]);
    expect(ctx.config).toBeDefined();
  });

  it('supports conversation history with correct role types', () => {
    const ctx = buildContext({
      history: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ],
    });
    expect(ctx.history).toHaveLength(3);
    expect(ctx.history[0].role).toBe('user');
    expect(ctx.history[1].role).toBe('assistant');
  });

  it('carries the skill config through the context', () => {
    const ctx = buildContext({
      config: buildConfig({
        skillId: 'triathlon',
        enabledSubModules: ['garmin-sync'],
      }),
    });
    expect(ctx.config.skillId).toBe('triathlon');
    expect(ctx.config.enabledSubModules).toContain('garmin-sync');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NEXUSSKILL INTERFACE — CONCRETE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — NexusSkill implementation', () => {
  let skill: NexusSkill;

  beforeEach(() => {
    skill = new StubSkill({ id: 'stub-skill', name: 'Stub Skill' });
  });

  it('exposes readonly manifest', () => {
    expect(skill.manifest.id).toBe('stub-skill');
    expect(skill.manifest.name).toBe('Stub Skill');
    expect(skill.manifest.version).toBe('1.0.0');
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  it('lifecycle methods return Promises', async () => {
    await expect(skill.install()).resolves.toBeUndefined();
    await expect(skill.enable()).resolves.toBeUndefined();
    await expect(skill.disable()).resolves.toBeUndefined();
    await expect(skill.uninstall()).resolves.toBeUndefined();
  });

  // ── Routing ──────────────────────────────────────────────────────

  it('getPatternRoutes() returns valid PatternRoute array', () => {
    const routes = skill.getPatternRoutes();
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].pattern).toBeInstanceOf(RegExp);
    expect(routes[0].pattern.test('/stub')).toBe(true);
  });

  it('getKeywordRoutes() returns valid KeywordRoute array', () => {
    const routes = skill.getKeywordRoutes();
    expect(Array.isArray(routes)).toBe(true);
    expect(routes[0].pattern).toBeInstanceOf(RegExp);
  });

  it('getClassificationHints() returns valid ClassificationHint', () => {
    const hints = skill.getClassificationHints();
    expect(hints.label).toBe('stub');
    expect(hints.description).toBeTruthy();
    expect(hints.examples.length).toBeGreaterThan(0);
  });

  // ── Handling ─────────────────────────────────────────────────────

  it('handle() returns SkillResponse with correct skillId', async () => {
    const ctx = buildContext({ message: 'test message' });
    const response = await skill.handle(ctx);
    expect(response.text).toContain('test message');
    expect(response.skillId).toBe('stub-skill');
    expect(Array.isArray(response.toolsUsed)).toBe(true);
  });

  it('handle() receives full context including config', async () => {
    const ctx = buildContext({
      userId: 99,
      message: 'check config',
      config: buildConfig({ skillId: 'stub-skill', enabled: true }),
    });
    const response = await skill.handle(ctx);
    expect(response.text).toContain('check config');
  });

  // ── Tools ────────────────────────────────────────────────────────

  it('getTools() returns valid SkillToolDefinition array', () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('stub_echo');
    expect(tools[0].inputSchema).toHaveProperty('type', 'object');
  });

  it('executeTool() executes known tool', async () => {
    const result = await skill.executeTool('stub_echo', { text: 'hello' });
    expect(result).toEqual({ echoed: 'hello' });
  });

  it('executeTool() throws for unknown tool', async () => {
    await expect(skill.executeTool('unknown', {}))
      .rejects.toThrow('Unknown tool');
  });

  // ── Sub-Modules ──────────────────────────────────────────────────

  it('getSubModules() returns empty array when no sub-modules', () => {
    const subs = skill.getSubModules();
    expect(subs).toEqual([]);
  });

  it('getSubModules() returns sub-modules from manifest', () => {
    const skillWithSubs = new StubSkill({
      subModules: [
        {
          id: 'garmin-sync',
          name: 'Garmin Sync',
          description: 'Syncs with Garmin',
          default: false,
        },
        {
          id: 'training-plans',
          name: 'Training Plans',
          description: 'Custom training plans',
          default: true,
        },
      ],
    });
    const subs = skillWithSubs.getSubModules();
    expect(subs).toHaveLength(2);
    expect(subs[0].id).toBe('garmin-sync');
    expect(subs[1].default).toBe(true);
  });

  it('enableSubModule() and disableSubModule() are async', async () => {
    await expect(skill.enableSubModule('garmin-sync')).resolves.toBeUndefined();
    await expect(skill.disableSubModule('garmin-sync')).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-TYPE CONSISTENCY
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — cross-type consistency', () => {
  it('SkillHandleContext.config.skillId matches manifest.id', () => {
    const manifest = buildManifest({ id: 'my-skill' });
    const config = buildConfig({ skillId: manifest.id });
    const ctx = buildContext({ config });
    expect(ctx.config.skillId).toBe(manifest.id);
  });

  it('SkillResponse.skillId matches manifest.id', () => {
    const manifest = buildManifest({ id: 'response-skill' });
    const response: SkillResponse = {
      text: 'done',
      skillId: manifest.id,
    };
    expect(response.skillId).toBe('response-skill');
  });

  it('SubModuleManifest.id matches SkillConfig.enabledSubModules entries', () => {
    const sub: SubModuleManifest = {
      id: 'garmin-sync',
      name: 'Garmin',
      description: 'Garmin integration',
      default: true,
    };
    const config = buildConfig({
      enabledSubModules: [sub.id],
    });
    expect(config.enabledSubModules).toContain(sub.id);
  });

  it('SkillToolDefinition.name matches executeTool toolName argument', async () => {
    const skill = new StubSkill();
    const tools = skill.getTools();
    const toolName = tools[0].name;
    const result = await skill.executeTool(toolName, { text: 'consistency' });
    expect(result).toEqual({ echoed: 'consistency' });
  });

  it('DependencyNode.dependencies references other node names or available set', () => {
    const nodes: DependencyNode[] = [
      { name: 'core', dependencies: [] },
      { name: 'plugin', dependencies: ['core'] },
    ];
    // Every dependency should be resolvable as another node name
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        const found = nodes.some(n => n.name === dep);
        expect(found).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Skill Types — edge cases', () => {
  it('SkillResponse with empty toolsUsed array', () => {
    const response: SkillResponse = {
      text: 'done',
      skillId: 'test',
      toolsUsed: [],
    };
    expect(response.toolsUsed).toHaveLength(0);
  });

  it('SkillConfig with empty envVars and preferences', () => {
    const config = buildConfig();
    expect(Object.keys(config.envVars)).toHaveLength(0);
    expect(Object.keys(config.preferences)).toHaveLength(0);
  });

  it('SkillHandleContext with empty history', () => {
    const ctx = buildContext({ history: [] });
    expect(ctx.history).toHaveLength(0);
  });

  it('SkillManifest with empty platforms array', () => {
    const manifest = buildManifest({ platforms: [] });
    expect(manifest.platforms).toHaveLength(0);
  });

  it('SkillManifest with zero-price subscription', () => {
    const manifest = buildManifest({
      pricing: { model: 'subscription', priceInCents: 0, billingPeriod: 'monthly' },
    });
    expect(manifest.pricing?.priceInCents).toBe(0);
  });

  it('DependencyResolutionResult with multiple circular chains', () => {
    const result: DependencyResolutionResult = {
      resolved: false,
      order: [],
      missing: [],
      circular: [['a', 'b'], ['c', 'd', 'e']],
    };
    expect(result.circular).toHaveLength(2);
    expect(result.circular[0]).toContain('a');
    expect(result.circular[1]).toContain('e');
  });

  it('ManifestValidationResult with multiple errors', () => {
    const result: ManifestValidationResult = {
      valid: false,
      errors: [
        { field: 'name', message: 'missing' },
        { field: 'version', message: 'invalid' },
        { field: 'category', message: 'unknown' },
      ],
    };
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map(e => e.field)).toEqual(['name', 'version', 'category']);
  });
});

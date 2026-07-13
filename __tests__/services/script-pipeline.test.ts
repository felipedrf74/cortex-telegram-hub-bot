/**
 * Script Pipeline — Canonical Pipeline Tests
 *
 * Regression tests for the unified script generation architecture.
 * Covers:
 *   1. The fake-userId bug (4096/8192 passed as userId to handleContent)
 *   2. All script paths routing through the canonical getScript() pipeline
 *   3. Structured ScriptResponse shape
 *   4. Format-specific behavior (reel vs youtube)
 *   5. formatScriptToText() output
 *   6. iOS API route contract
 *   7. Workflow-generated scripts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// 1. Fake-userId Bug Regression
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: fake-userId regression', () => {
  it('no executable handleContent calls remain in content-workflow.ts', () => {
    // The old code called handleContent(prompt, 4096) where 4096 was
    // silently consumed as the userId parameter. Verify no executable
    // handleContent calls remain.
    const workflowSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );

    const lines = workflowSource.split('\n');
    const handleContentCalls = lines.filter((line: string) => {
      const trimmed = line.trim();
      // Skip comments (the bug explanation mentions the old pattern)
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      // Skip imports (handleContent is no longer imported anyway)
      if (trimmed.startsWith('import')) return false;
      // Look for actual function calls
      return trimmed.includes('handleContent(');
    });
    expect(handleContentCalls).toHaveLength(0);
  });

  it('handleContent is not imported in content-workflow.ts', () => {
    const workflowSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );

    // The import line should be gone (replaced with a comment)
    const lines = workflowSource.split('\n');
    const importLines = lines.filter((line: string) =>
      line.trim().startsWith('import') && line.includes('handleContent'),
    );
    expect(importLines).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Canonical Pipeline — Single Path
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: canonical path', () => {
  it('generateScript is exported from content-workflow', async () => {
    const workflow = await import('../../src/services/content-workflow');
    expect(workflow.generateScript).toBeDefined();
    expect(typeof workflow.generateScript).toBe('function');
  });

  it('formatScriptToText is exported', async () => {
    const workflow = await import('../../src/services/content-workflow');
    expect(workflow.formatScriptToText).toBeDefined();
    expect(typeof workflow.formatScriptToText).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Structured ScriptResponse Shape
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: ScriptResponse shape', () => {
  it('ScriptResponse type has all required fields', async () => {
    // Verify the type exists with expected shape by checking the source
    const engineSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-engine.ts'),
      'utf8',
    );

    expect(engineSource).toContain('export interface ScriptResponse');
    expect(engineSource).toContain('topic: string');
    expect(engineSource).toContain('script: string');
    expect(engineSource).toContain('hook: string');
    expect(engineSource).toContain('title_options: string[]');
    expect(engineSource).toContain('sources_used: SourceReference[]');
    expect(engineSource).toContain('estimated_duration: string');
    expect(engineSource).toContain('duration_ms: number');
  });
});

describe('script-pipeline: cache key hardening', () => {
  it('script cache key includes language, mode, duration, brand voice hash, render mode, and regeneration inputs', () => {
    const engineSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-engine.ts'),
      'utf8',
    );

    expect(engineSource).toContain('export function buildScriptCacheKey');
    expect(engineSource).toContain("'script-v8'");
    expect(engineSource).toContain('`duration:${maxDuration}`');
    expect(engineSource).toContain('`target:${targetDurationSeconds ?? maxDuration * 60}`');
    expect(engineSource).toContain('`mode:${mode}`');
    expect(engineSource).toContain('`lang:${normalizeScriptLanguage(language)}`');
    expect(engineSource).toContain('`voice:${hashBrandVoice(brandVoice)}`');
    expect(engineSource).toContain('`render:${normalizeScriptRenderMode(renderMode)}`');
    expect(engineSource).toContain('`style:${normalizeScriptStyle(scriptStyle)}`');
    expect(engineSource).toContain('`ctx:${hashScriptContext(scriptContext)}`');
    expect(engineSource).toContain("`scope:${userId ?? 'global'}`");
    expect(engineSource).toContain('hashRegenerationSeed');
    expect(engineSource).toContain("parts.push(`regen:${seedHash}`)");
    expect(engineSource).toContain('cfg.cacheTtl > 0 && !forceRefresh');
  });

  it('script signal reads are tenant-scoped instead of using global signal context', () => {
    const engineSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-engine.ts'),
      'utf8',
    );

    expect(engineSource).toContain("readSignals('script-engine', [...signalTypes], 100, userId, cfg.signalDays, tenantId)");
    expect(engineSource).toMatch(/readSignals\('script-engine', \[\.\.\.signalTypes\], 100, userId, cfg\.signalDays, tenantId\)/);
  });

  it('script engine forwards first-party topic context into the Python request', () => {
    const engineSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-engine.ts'),
      'utf8',
    );

    expect(engineSource).toContain('topic_context: scriptContext ?? undefined');
    expect(engineSource).toContain('creator_profile: creatorProfile || undefined');
    expect(engineSource).toContain('force_refresh: forceRefresh || undefined');
    expect(engineSource).toContain('regeneration_seed: regenerationSeed || undefined');
  });

  it('checks the token-zero script cache before entering the fresh-provider budget boundary', () => {
    const engineSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-engine.ts'),
      'utf8',
    );

    const cacheLookup = engineSource.indexOf('const cached = getCached<ScriptResponse>(normalizedKey)');
    const providerBoundary = engineSource.indexOf('const result = providerBoundary');
    const tokenMint = engineSource.indexOf('internal_attribution_token: createInternalAttributionToken');
    const freshProviderCallback = engineSource.indexOf('const invokeFreshProviderPath');
    expect(cacheLookup).toBeGreaterThan(-1);
    expect(providerBoundary).toBeGreaterThan(cacheLookup);
    expect(freshProviderCallback).toBeGreaterThan(cacheLookup);
    expect(tokenMint).toBeGreaterThan(freshProviderCallback);
    expect(engineSource).toContain('? await providerBoundary(invokeFreshProviderPath)');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. formatScriptToText — Structured → Plain Text
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: formatScriptToText', () => {
  // Mock the modules that content-workflow imports
  vi.mock('../../src/services/database', () => ({
    getDb: () => ({
      prepare: () => ({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    }),
    initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));

  vi.mock('../../src/config', () => ({
    config: {
      anthropic: { apiKey: 'test' },
      app: { timezone: 'Europe/Lisbon' },
      portal: { token: 'test' },
    },
  }));

  vi.mock('../../src/utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
    LOGGER_REDACTION_PATHS: [],
}));

  it('renders title options, hook, script, and sources', async () => {
    const { formatScriptToText } = await import('../../src/services/content-workflow');

    const mockResponse = {
      topic: 'AI for athletes',
      script: 'Fala galera, hoje eu vou...',
      hook: 'Você sabia que 90% dos atletas...',
      title_options: ['Title A', 'Title B', 'Title C'],
      sources_used: [
        { title: 'Study X', url: 'https://example.com/x', source_type: 'academic', relevance_note: 'Key study' },
      ],
      estimated_duration: '8:00-10:00',
      duration_ms: 5000,
    };

    const text = formatScriptToText(mockResponse);

    // Title options present
    expect(text).toContain('TITLE OPTIONS:');
    expect(text).toContain('1. Title A');
    expect(text).toContain('2. Title B');
    expect(text).toContain('3. Title C');

    // Hook present
    expect(text).toContain('HOOK:');
    expect(text).toContain('Você sabia que 90% dos atletas');

    // Script body present
    expect(text).toContain('SCRIPT:');
    expect(text).toContain('Fala galera, hoje eu vou');

    // Sources present
    expect(text).toContain('FONTES VERIFICADAS:');
    expect(text).toContain('Study X');
    expect(text).toContain('https://example.com/x');

    // Duration present
    expect(text).toContain('Duração estimada: 8:00-10:00');
  });

  it('handles empty sources gracefully', async () => {
    const { formatScriptToText } = await import('../../src/services/content-workflow');

    const mockResponse = {
      topic: 'Test',
      script: 'Body text',
      hook: 'Hook text',
      title_options: [],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 1000,
    };

    const text = formatScriptToText(mockResponse);

    expect(text).not.toContain('TITLE OPTIONS:');
    expect(text).not.toContain('FONTES VERIFICADAS:');
    expect(text).toContain('HOOK:');
    expect(text).toContain('SCRIPT:');
  });

  it('output is plain text (no HTML tags)', async () => {
    const { formatScriptToText } = await import('../../src/services/content-workflow');

    const mockResponse = {
      topic: 'Test',
      script: 'Some script',
      hook: 'Some hook',
      title_options: ['Title <A>'],
      sources_used: [{ title: 'Source', url: '', source_type: 'web', relevance_note: '' }],
      estimated_duration: '5:00',
      duration_ms: 1000,
    };

    const text = formatScriptToText(mockResponse);

    // No Telegram HTML tags
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('<i>');
    expect(text).not.toContain('<code>');
    expect(text).not.toContain('parse_mode');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. iOS API Route Contract
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: iOS API route', () => {
  it('POST /script route uses getScript, not handleContent', () => {
    const parentRouteSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/api/routes/content.ts'),
      'utf8',
    );
    const routeSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/api/routes/content-script-routes.ts'),
      'utf8',
    );

    // The parent route should delegate script handling to the extracted module.
    expect(parentRouteSource).toContain('registerContentScriptRoutes');

    // The extracted route should import getScript
    expect(routeSource).toContain('getScript');

    // The old pattern: handleContent(prompt, userId) for scripts
    // should NOT appear in the /script route handler
    const lines = routeSource.split('\n');

    // Find the /script route section
    const scriptRouteStart = lines.findIndex((l: string) => l.includes("'/script'") || l.includes('"/script"'));
    expect(scriptRouteStart).toBeGreaterThan(-1);

    // Check the next 80 lines after the route definition
    const routeSection = lines.slice(scriptRouteStart, scriptRouteStart + 80).join('\n');

    // Should use getScript
    expect(routeSection).toContain('getScript');

    // Should NOT reference handleContent in the script section
    expect(routeSection).not.toContain('handleContent');

    // Should NOT have the old `/script ${ideaId}` command-style prompt
    expect(routeSection).not.toContain('`/script ${ideaId}`');
  });

  it('iOS /script route returns structured fields', () => {
    const routeUtilitySource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/api/routes/content-script-route-utils.ts'),
      'utf8',
    );

    // The /script route delegates structured response shaping to
    // content-script-route-utils.ts after the route extraction pass.
    expect(routeUtilitySource).toContain('topic: result.topic');
    expect(routeUtilitySource).toContain('script: scriptQuality.revisedScript');
    expect(routeUtilitySource).toContain('hook: result.hook');
    expect(routeUtilitySource).toContain('titleOptions:');
    expect(routeUtilitySource).toContain('sourcesUsed:');
    expect(routeUtilitySource).toContain('estimatedDuration:');
    expect(routeUtilitySource).toContain('renderMode,');
    expect(routeUtilitySource).toContain('durationMs:');
    expect(routeUtilitySource).toContain('degraded: result.degraded ?? false');
    expect(routeUtilitySource).toContain('const warnings = Array.from(new Set([');
    expect(routeUtilitySource).toContain('...scriptQuality.complianceWarnings');
    expect(routeUtilitySource).toContain('warnings: publicQualityWarnings');
    expect(routeUtilitySource).toContain('sourceSummary: hasSourcePackageContents ? (sourcePackage?.sourceSummaries ?? []) : []');
  });

  it('iOS /script route validates topic parameter', () => {
    const routeSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/api/routes/content-script-routes.ts'),
      'utf8',
    );

    // Should validate topic is required
    expect(routeSource).toContain("'topic is required'");
  });

  it('iOS /script route validates explicit YouTube and short presets', () => {
    const routeSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/api/routes/content-script-routes.ts'),
      'utf8',
    );
    const durationUtilitySource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/api/routes/content-script-utils.ts'),
      'utf8',
    );

    expect(routeSource).toContain('targetDurationSeconds');
    expect(durationUtilitySource).toContain('Reel duration must be one of 15, 30, 45, or 60 seconds');
    expect(durationUtilitySource).toContain('YouTube duration must be one of 8, 10, or 15 minutes');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Workflow Script — Approval-Generated
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// 7. Format Metadata
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: format-specific behavior', () => {
  it('generateScript passes maxDuration=1 for reels', () => {
    const workflowSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );

    // Reel format should use maxDuration = 1 (1 minute max)
    expect(workflowSource).toContain("format === 'reel' ? 1 : 8");
  });

  it('generateScript passes format string to getScript', () => {
    const workflowSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );

    // Should map format to engine format string
    expect(workflowSource).toContain("format === 'reel' ? 'Reel' : 'YouTube'");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Prompt Transport-Agnosticism
// ═══════════════════════════════════════════════════════════════════

describe('script-pipeline: prompt is transport-agnostic', () => {
  it('content.md does not contain Telegram HTML formatting instructions', () => {
    const promptSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../prompts/content.md'),
      'utf8',
    );

    // Content.md should not have any Telegram-specific text
    expect(promptSource).not.toContain('Telegram HTML only');
    expect(promptSource).not.toContain('Use ONLY these HTML tags');
    expect(promptSource).not.toContain('<b>');
    expect(promptSource).not.toContain('<i>');
  });

  it('creator-config.md contains transport-agnostic output format', () => {
    const configSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../prompts/creator-config.md'),
      'utf8',
    );

    expect(configSource).toContain('Do NOT use HTML tags');
    expect(configSource).not.toContain('Telegram');
  });
});

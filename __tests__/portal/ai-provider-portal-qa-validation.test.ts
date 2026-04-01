/**
 * QA Validation Tests — Portal AI Provider Status + Fallback Chain Visualization
 *
 * Validates the frontend agent's AI provider portal section:
 * 1. Server: buildAiProviderData() returns correct structure for all 3 providers
 * 2. Server: SnapshotResponse includes aiProviders type
 * 3. Portal HTML: AI Provider section exists with required DOM elements
 * 4. Portal HTML: renderAiProviders function handles all states (configured/unconfigured, cost/no-cost)
 * 5. Portal HTML: CSS classes for provider cards, fallback chains, and cost bars
 * 6. Config: openai, gemini, and providerRouting sections exist
 * 7. Fallback chain visualization covers classify, chat, toolUse task types
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const portalHtml = fs.readFileSync(path.join(ROOT, 'src/portal/portal.html'), 'utf-8');
const serverTs = fs.readFileSync(path.join(ROOT, 'src/portal/server.ts'), 'utf-8');
const configTs = fs.readFileSync(path.join(ROOT, 'src/config.ts'), 'utf-8');

// ═══════════════════════════════════════════════════════════════════
// QA: CONFIG — MULTI-PROVIDER SUPPORT
// ═══════════════════════════════════════════════════════════════════

describe('QA: config supports multi-provider AI setup', () => {
  it('config exports anthropic section with apiKey and model', () => {
    expect(configTs).toContain('anthropic:');
    expect(configTs).toContain('ANTHROPIC_API_KEY');
    expect(configTs).toContain('claude-sonnet-4-6');
  });

  it('config exports openai section with apiKey, model, and classifierModel', () => {
    expect(configTs).toContain('openai:');
    expect(configTs).toMatch(/openai[\s\S]*apiKey/);
    expect(configTs).toMatch(/openai[\s\S]*model/);
  });

  it('config exports gemini section with apiKey, model, and classifierModel', () => {
    expect(configTs).toContain('gemini:');
    expect(configTs).toMatch(/gemini[\s\S]*apiKey/);
    expect(configTs).toContain('gemini-2.0-flash'); // default model
  });

  it('config exports providerRouting with classify, chat, toolUse', () => {
    expect(configTs).toContain('providerRouting:');
    expect(configTs).toContain('classify:');
    expect(configTs).toContain('chat:');
    expect(configTs).toContain('toolUse:');
  });

  it('each routing entry has primary and fallback fields', () => {
    expect(configTs).toMatch(/classify[\s\S]*primary/);
    expect(configTs).toMatch(/classify[\s\S]*fallback/);
    expect(configTs).toMatch(/AI_CLASSIFY_FALLBACK/);
    expect(configTs).toMatch(/AI_CHAT_FALLBACK/);
    expect(configTs).toMatch(/AI_TOOL_USE_FALLBACK/);
  });

  it('config has circuit breaker settings', () => {
    expect(configTs).toContain('circuitBreaker');
    expect(configTs).toContain('failureThreshold');
    expect(configTs).toContain('cooldownMs');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: SERVER — buildAiProviderData FUNCTION
// ═══════════════════════════════════════════════════════════════════

describe('QA: server buildAiProviderData structure', () => {
  it('server.ts defines buildAiProviderData function', () => {
    expect(serverTs).toContain('function buildAiProviderData()');
  });

  it('buildAiProviderData returns 3 providers: anthropic, openai, gemini', () => {
    // Check the function body includes all 3 providers
    expect(serverTs).toContain("name: 'anthropic'");
    expect(serverTs).toContain("name: 'openai'");
    expect(serverTs).toContain("name: 'gemini'");
  });

  it('each provider has role, configured, model, and classifierModel fields', () => {
    expect(serverTs).toContain("role: 'primary'");
    expect(serverTs).toContain("role: 'fallback'");
    expect(serverTs).toContain('configured:');
    expect(serverTs).toContain('classifierModel:');
  });

  it('anthropic is the primary provider', () => {
    // Find the anthropic provider block and verify it's primary
    const anthropicBlock = serverTs.match(/name:\s*'anthropic'[\s\S]*?role:\s*'(\w+)'/);
    expect(anthropicBlock).toBeTruthy();
    expect(anthropicBlock![1]).toBe('primary');
  });

  it('openai and gemini are fallback providers', () => {
    // After the anthropic block, openai and gemini should be fallback
    const openaiBlock = serverTs.match(/name:\s*'openai'[\s\S]*?role:\s*'(\w+)'/);
    expect(openaiBlock).toBeTruthy();
    expect(openaiBlock![1]).toBe('fallback');

    const geminiBlock = serverTs.match(/name:\s*'gemini'[\s\S]*?role:\s*'(\w+)'/);
    expect(geminiBlock).toBeTruthy();
    expect(geminiBlock![1]).toBe('fallback');
  });

  it('cost query groups by provider using model name pattern matching', () => {
    expect(serverTs).toContain("LIKE '%claude%'");
    expect(serverTs).toContain("LIKE '%gpt%'");
    expect(serverTs).toContain("LIKE '%gemini%'");
  });

  it('cost query reads from api_usage table with today filter', () => {
    expect(serverTs).toContain('FROM api_usage');
    expect(serverTs).toContain("date('now')");
  });

  it('buildAiProviderData includes routing config', () => {
    expect(serverTs).toContain('config.providerRouting.classify');
    expect(serverTs).toContain('config.providerRouting.chat');
    expect(serverTs).toContain('config.providerRouting.toolUse');
  });

  it('buildAiProviderData includes circuit breaker config', () => {
    expect(serverTs).toContain('config.providerRouting.circuitBreaker');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: SNAPSHOT RESPONSE TYPE INCLUDES AI PROVIDERS
// ═══════════════════════════════════════════════════════════════════

describe('QA: SnapshotResponse type includes aiProviders', () => {
  it('SnapshotResponse interface has aiProviders field', () => {
    expect(serverTs).toContain('aiProviders:');
    // Check the type has providers array with the right shape
    expect(serverTs).toContain("role: 'primary' | 'fallback'");
    expect(serverTs).toContain('configured: boolean');
  });

  it('SnapshotResponse.aiProviders has routing sub-type', () => {
    expect(serverTs).toContain('routing:');
    expect(serverTs).toMatch(/classify:\s*\{/);
    expect(serverTs).toMatch(/chat:\s*\{/);
    expect(serverTs).toMatch(/toolUse:\s*\{/);
  });

  it('SnapshotResponse.aiProviders has costByProvider array', () => {
    expect(serverTs).toContain('costByProvider:');
    expect(serverTs).toMatch(/provider:\s*string/);
    expect(serverTs).toMatch(/calls:\s*number/);
    expect(serverTs).toMatch(/cost:\s*number/);
  });

  it('snapshot builder includes aiProviders in response', () => {
    expect(serverTs).toContain('aiProviders: buildAiProviderData()');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: PORTAL HTML — AI PROVIDER SECTION EXISTS
// ═══════════════════════════════════════════════════════════════════

describe('QA: portal HTML has AI provider section', () => {
  it('has AI provider section heading', () => {
    expect(portalHtml).toContain('AI Providers');
    expect(portalHtml).toContain('Fallback Chain');
  });

  it('has provider cards container', () => {
    expect(portalHtml).toContain('id="ai-provider-cards"');
  });

  it('has fallback chains container', () => {
    expect(portalHtml).toContain('id="ai-fallback-chains"');
  });

  it('has cost breakdown elements', () => {
    expect(portalHtml).toContain('id="ai-cost-breakdown"');
    expect(portalHtml).toContain('id="ai-cost-bar"');
    expect(portalHtml).toContain('id="ai-cost-legend"');
    expect(portalHtml).toContain('id="ai-cost-total"');
  });

  it('has "Today\'s Cost by Provider" label', () => {
    expect(portalHtml).toContain("Today's Cost by Provider");
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: PORTAL HTML — renderAiProviders FUNCTION
// ═══════════════════════════════════════════════════════════════════

describe('QA: renderAiProviders JavaScript function', () => {
  it('renderAiProviders function is defined', () => {
    expect(portalHtml).toContain('function renderAiProviders(ai)');
  });

  it('renders provider cards with role badge', () => {
    expect(portalHtml).toContain('provider-role');
    expect(portalHtml).toContain('p.role');
  });

  it('shows configured/not-configured badge', () => {
    expect(portalHtml).toContain('badge-configured');
    expect(portalHtml).toContain('badge-not-configured');
    expect(portalHtml).toContain('p.configured');
  });

  it('shows model names for chat and classifier', () => {
    expect(portalHtml).toContain('model-name');
    expect(portalHtml).toContain('p.model');
    expect(portalHtml).toContain('p.classifierModel');
  });

  it('renders cost per provider in card', () => {
    expect(portalHtml).toContain('provider-cost');
    expect(portalHtml).toContain('calls today');
  });

  it('renders fallback chain for 3 task types: classify, chat, toolUse', () => {
    expect(portalHtml).toContain("key: 'classify'");
    expect(portalHtml).toContain("key: 'chat'");
    expect(portalHtml).toContain("key: 'toolUse'");
  });

  it('fallback chain shows primary → fallback with arrow', () => {
    expect(portalHtml).toContain('chain-arrow');
    expect(portalHtml).toContain('chain-node');
    expect(portalHtml).toContain('chain-flow');
  });

  it('marks unconfigured providers as disabled in chain', () => {
    // The function checks configuredSet to determine active/disabled/standby
    expect(portalHtml).toContain('configuredSet');
    expect(portalHtml).toContain('primaryConfigured');
    expect(portalHtml).toContain('fallbackConfigured');
  });

  it('shows circuit breaker info in each chain card', () => {
    expect(portalHtml).toContain('circuitBreaker.failureThreshold');
    expect(portalHtml).toContain('circuitBreaker.cooldownMs');
    expect(portalHtml).toContain('chain-cb-info');
  });

  it('handles zero-cost state gracefully', () => {
    // When totalCost is 0, should show "No API calls today"
    expect(portalHtml).toContain('No API calls today');
  });

  it('cost bar segments use provider-specific colors', () => {
    expect(portalHtml).toContain('PROVIDER_COLORS');
    expect(portalHtml).toContain('cost-bar-segment');
    expect(portalHtml).toContain('cost-bar-dot');
  });

  it('escapes provider model names with esc() function', () => {
    expect(portalHtml).toContain('esc(p.model)');
    expect(portalHtml).toContain('esc(p.classifierModel)');
  });

  it('render function calls renderAiProviders when data present', () => {
    expect(portalHtml).toContain('if (snap.aiProviders) renderAiProviders(snap.aiProviders)');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: PORTAL CSS — AI PROVIDER STYLES
// ═══════════════════════════════════════════════════════════════════

describe('QA: portal CSS for AI provider section', () => {
  it('has provider-cards grid layout', () => {
    expect(portalHtml).toContain('.provider-cards');
  });

  it('has provider-card base styles', () => {
    expect(portalHtml).toContain('.provider-card');
  });

  it('has card variants for primary, fallback, unconfigured', () => {
    expect(portalHtml).toContain('.provider-card.primary');
    expect(portalHtml).toContain('.provider-card.fallback');
    expect(portalHtml).toContain('.provider-card.unconfigured');
  });

  it('has chain visualization styles', () => {
    expect(portalHtml).toContain('.chain-card');
    expect(portalHtml).toContain('.chain-flow');
    expect(portalHtml).toContain('.chain-node');
    expect(portalHtml).toContain('.chain-arrow');
  });

  it('has cost bar styles', () => {
    expect(portalHtml).toContain('.cost-bar-container');
    expect(portalHtml).toContain('.cost-bar-track');
    expect(portalHtml).toContain('.cost-bar-segment');
    expect(portalHtml).toContain('.cost-bar-legend');
  });

  it('has responsive styles for provider cards', () => {
    // Check for mobile breakpoint
    expect(portalHtml).toContain('.provider-cards { grid-template-columns: 1fr; }');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: PROVIDER ICONS / LABELS / COLORS
// ═══════════════════════════════════════════════════════════════════

describe('QA: provider visual constants', () => {
  it('PROVIDER_ICONS covers all 3 providers', () => {
    expect(portalHtml).toContain("PROVIDER_ICONS");
    expect(portalHtml).toContain("anthropic: '🟣'");
    expect(portalHtml).toContain("openai: '🟢'");
    expect(portalHtml).toContain("gemini: '🔵'");
  });

  it('PROVIDER_LABELS has human-readable names', () => {
    expect(portalHtml).toContain("PROVIDER_LABELS");
    expect(portalHtml).toContain("anthropic: 'Anthropic'");
    expect(portalHtml).toContain("openai: 'OpenAI'");
    expect(portalHtml).toContain("gemini: 'Gemini'");
  });

  it('PROVIDER_COLORS has distinct colors per provider plus unknown fallback', () => {
    expect(portalHtml).toContain("PROVIDER_COLORS");
    // Should have at least 3 + unknown
    expect(portalHtml).toMatch(/PROVIDER_COLORS.*anthropic.*openai.*gemini.*unknown/s);
  });

  it('unknown provider gets fallback icon and color', () => {
    // renderAiProviders uses || fallback for unknown providers
    expect(portalHtml).toContain("|| '⚪'"); // fallback icon
    expect(portalHtml).toContain('PROVIDER_COLORS.unknown'); // fallback color
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: ERROR HANDLING IN buildAiProviderData
// ═══════════════════════════════════════════════════════════════════

describe('QA: error handling in server provider data', () => {
  it('cost query has try/catch for missing api_usage table', () => {
    // The function wraps the DB query in try/catch — extract the full function body
    const startIdx = serverTs.indexOf('function buildAiProviderData');
    const endIdx = serverTs.indexOf('\nfunction ', startIdx + 1);
    const buildFn = serverTs.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 2000);
    expect(buildFn).toContain('try');
    expect(buildFn).toContain('catch');
  });

  it('cost defaults to empty array on error', () => {
    // costByProvider is initialized to empty before try
    expect(serverTs).toContain('costByProvider');
    expect(serverTs).toContain('= []');
  });
});

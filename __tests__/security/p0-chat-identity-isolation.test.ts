/**
 * P0 Chat identity / tenant isolation regression tests.
 *
 * Pins the May 2026 audit fixes that closed the "You're Felipe" leak
 * surface. Each test corresponds to a specific finding from the audit
 * — see docs/security/p0-chat-identity-* for the full root-cause
 * analysis. If a test fails in CI, the corresponding identity-leak
 * vector has reopened and the change must not ship.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

// ═══════════════════════════════════════════════════════════════════
// 1. buildKnowledgePromptBlock — the original smoking gun
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: buildKnowledgePromptBlock does not inject "Felipe"', () => {
  it('source code of buildKnowledgePromptBlock contains no literal "Felipe" string', () => {
    // The function is appended to the content-domain system prompt for any
    // authenticated user with content_knowledge rows. A literal "Felipe"
    // anywhere in this builder would leak founder identity into a non-Felipe
    // user's chat prompt — exactly the bug that triggered the May 2026 audit.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/state/content-references.ts'),
      'utf8',
    );
    const builderStart = source.indexOf('export function buildKnowledgePromptBlock');
    expect(builderStart).toBeGreaterThan(-1);
    // Read the rest of the file from the function start (the rest of the
    // file should not introduce another "Felipe" persona below it either).
    const fromBuilder = source.slice(builderStart);
    expect(fromBuilder).not.toMatch(/\bFelipe\b/);
    expect(fromBuilder).not.toMatch(/Felipe's voice/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. creator-config.md neutral fallback
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: creator-config.md is a NEUTRAL template', () => {
  const content = fs.readFileSync(
    path.join(REPO_ROOT, 'prompts/creator-config.md'),
    'utf8',
  );

  it('does not name a specific creator', () => {
    expect(content).not.toMatch(/\bFelipe\b/);
    expect(content).not.toMatch(/Dominguez/);
    expect(content).not.toMatch(/"The Operator"/);
  });

  it('does not hardcode a worldview, audience, or dietary default', () => {
    expect(content).not.toMatch(/Conservative Christian values/);
    expect(content).not.toMatch(/Libertarian \/ anti-state/);
    expect(content).not.toMatch(/carnivore diet/i);
    expect(content).not.toMatch(/Brazilian, 18-35/);
    expect(content).not.toMatch(/Portuguese-speaking men 18-40/);
  });

  it('explicitly tells callers to load identity per-request', () => {
    expect(content).toContain('authenticated user');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Chat HTML formatter never hardcodes a founder greeting
// ═══════════════════════════════════════════════════════════════════
//
// 2026-07 Telegram purge (Stage A): the legacy `telegram-formatter` module
// and its `formatDailyBriefing` greeting (the original hardcoded-"Felipe"
// risk surface) were removed. The surviving live formatters moved to
// `chat-html-formatter`; this pin keeps the identity guarantee on the
// successor module and ensures the legacy module does not come back.

describe('P0 identity: chat formatter is founder-name free', () => {
  it('chat-html-formatter does NOT contain a hardcoded "Felipe" greeting', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/utils/chat-html-formatter.ts'),
      'utf8',
    );
    expect(source).not.toContain('Good morning, Felipe!');
    expect(source).not.toContain('Bom dia, Felipe!');
    // No greeting copy at all may bake in a name (license header excluded).
    expect(source).not.toMatch(/(Good morning|Bom dia), [A-Z]/);
  });

  it('the legacy telegram-formatter module (hardcoded-greeting surface) is gone', async () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/utils/telegram-formatter.ts'))).toBe(false);
    const mod = await import('../../src/utils/chat-html-formatter');
    expect((mod as any).formatDailyBriefing).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. getUserByAnyIdentifier resolves users.id FIRST (defense-in-depth)
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: user-service resolution order', () => {
  // Audit found a documented id-collision risk surface: when an iOS
  // route calls a fuzzy *Any* helper with the canonical users.id from
  // auth, the legacy implementation tried getUserByTelegramId(userRef)
  // FIRST. Reordering to try getUserById first removes that surface
  // (an iOS users.id match on the local row preempts any foreign
  // telegram_id collision).

  it('getUserByAnyIdentifier definition tries users.id BEFORE telegram_id', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/services/user-service.ts'),
      'utf8',
    );
    // Extract the function body
    const fnStart = source.indexOf('function getUserByAnyIdentifier');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('}', fnStart) + 1;
    const fnBody = source.slice(fnStart, fnEnd);
    // The body must call getUserById BEFORE getUserByTelegramId so iOS-derived
    // ids that happen to collide with a foreign user's telegram_id cannot
    // silently leak that foreign user.
    const idIdx = fnBody.indexOf('getUserById');
    const telegramIdx = fnBody.indexOf('getUserByTelegramId');
    expect(idIdx).toBeGreaterThan(-1);
    expect(telegramIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeLessThan(telegramIdx);
  });

  it('exports strict-by-id helpers for iOS-route callers', async () => {
    const mod = await import('../../src/services/user-service');
    expect(typeof mod.getPreferredDisplayNameById).toBe('function');
    expect(typeof mod.getUserLanguageById).toBe('function');
    expect(typeof mod.getUserTimezoneById).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. iOS API routes use the strict *ById helpers (not the fuzzy ones)
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: iOS API routes use strict by-id user-service helpers', () => {
  // The audit migrated the following iOS API routes from the fuzzy
  // getUserLanguage / getUserTimezone / getPreferredDisplayName helpers
  // (which run getUserByAnyIdentifier under the hood) to the strict
  // *ById variants. This test pins the migration so a future PR can't
  // regress the identity-safety surface on these routes.
  const iosRoutes = [
    'src/api/routes/dashboard.ts',
    'src/api/routes/dashboard-data-fetchers.ts',
    'src/api/routes/chat-message-routes.ts',
    'src/api/routes/chat-fastpath.ts',
    'src/api/routes/chat-callback-routes.ts',
    'src/api/routes/training.ts',
    'src/api/routes/content.ts',
    'src/api/routes/content-script-routes.ts',
    'src/api/routes/tasks.ts',
    'src/api/routes/chat-message-request.ts',
  ];

  for (const relPath of iosRoutes) {
    it(`${relPath} does NOT call the fuzzy getUserLanguage / getUserTimezone / getPreferredDisplayName`, () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      // Match call patterns, not import statements (which can legitimately
      // re-export). A call has an open paren immediately after the name.
      // Allow comments mentioning the legacy name (e.g., "// the legacy
      // getPreferredDisplayName path was a fuzzy lookup").
      const callsFuzzy = /[^a-zA-Z_]getUserLanguage\(|[^a-zA-Z_]getUserTimezone\(|[^a-zA-Z_]getPreferredDisplayName\(/.test(source);
      expect(callsFuzzy).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 6. canonical Content workspace count — strict tenant/user scope
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: canonical Content count is strictly tenant/user-scoped', () => {
  it('context-engine.ts delegates to the canonical private workspace projection', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/services/context-engine.ts'),
      'utf8',
    );
    expect(source).not.toContain('FROM saved_ideas');
    expect(source).toContain('countActiveContentWorkspaceItems(');
    expect(source).toContain('{ tenantId: scopedTenantId, userId }');
  });

  it('getIdeasBySource requires a userId parameter', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/state/saved-ideas.ts'),
      'utf8',
    );
    // Function signature must take userId
    expect(source).toMatch(/export function getIdeasBySource\(\s*source:\s*string\s*,\s*userId:\s*number/);
    // Query must filter by user_id
    expect(source).toMatch(/saved_ideas WHERE source = \? AND user_id = \?/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Persisted-payload writers no longer hardcode Felipe in DB rows
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: persisted-payload writers do not hardcode "Felipe"', () => {
  // intelligence-bus signals + content_radar rows surface in iOS UI for
  // any tenant that subscribes. Strings written to those tables that
  // hardcode "Felipe" leak founder identity to every reader.
  const persistenceWriters = [
    'src/agents/voice-evolution-agent.ts',
    'src/agents/reaction-radar-agent.ts',
  ];
  for (const relPath of persistenceWriters) {
    it(`${relPath} does not contain a literal "Felipe" string in persisted payloads`, () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      // Allow the copyright header on line 1 as the only legitimate hit
      const lines = source.split('\n');
      const offending = lines
        .map((line, idx) => ({ line, idx: idx + 1 }))
        .filter(({ line, idx }) => idx !== 1 && /\bFelipe\b/.test(line));
      expect(offending).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 8. fossa_email cron is gated behind an explicit owner-only flag
// ═══════════════════════════════════════════════════════════════════

describe('P0 identity: fossa_email cron is owner-only gated', () => {
  it('scheduler.ts requires FOSSA_EMAIL_ENABLED=1 in addition to OUTLOOK availability', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/services/scheduler.ts'),
      'utf8',
    );
    // The cron registration block must reference the explicit env flag
    expect(source).toMatch(/FOSSA_EMAIL_ENABLED/);
    // And gate the cron.schedule call on it
    expect(source).toMatch(/fossaEnabled\s*&&\s*isOutlookMailConfigured/);
  });
});

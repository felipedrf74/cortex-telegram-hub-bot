import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

const mockRouteMessage = vi.fn();
const mockTryDeterministicChatCommand = vi.fn();
const mockClassifyAndExtractImage = vi.fn();
const mockGetUserLanguage = vi.fn(() => 'en');
const mockSetUserLanguage = vi.fn();
const mockCheckTierAccess = vi.fn(() => ({
  allowed: true,
  userTier: 'pro',
  requiredTier: 'free',
}));
const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 1,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
}));
const mockGetLastAssistantMessage = vi.fn(() => null);
const mockAddToConversation = vi.fn();
const mockCompleteOneShotWithFallback = vi.fn();
const mockHandleSecretary = vi.fn(async () => ({ text: 'Scheduled.', domain: 'secretary' as const }));
const mockGetScript = vi.fn();
const mockGetCallback = vi.fn(() => null);
const mockStoreCallback = vi.fn(() => 'cb-ref');
const mockGetLastCoachState = vi.fn(() => null);
const mockApplyCoachRecommendations = vi.fn(async () => ({
  count: 0,
  appliedRecommendations: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/router', () => ({
  routeMessage: (...args: unknown[]) => mockRouteMessage(...args),
  isSystemCommand: vi.fn(() => null),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyAndExtractImage: (...args: unknown[]) => mockClassifyAndExtractImage(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: vi.fn(() => null),
  setCache: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  setUserLanguage: (...args: unknown[]) => mockSetUserLanguage(...args),
  getUserById: (userId: number) => ({ id: userId, tier: 'pro' }),
  getUserByTelegramId: (userId: number) => ({ id: userId, tier: 'pro' }),
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  normalizeLangHeader: (value: string) => {
    const normalized = value.toLowerCase();
    if (normalized.startsWith('pt-pt') || normalized.startsWith('pt_pt')) return 'pt-PT';
    if (normalized.startsWith('pt')) return 'pt-BR';
    return 'en-US';
  },
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkTierAccess: (...args: unknown[]) => mockCheckTierAccess(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
}));

vi.mock('../../src/state/conversation', () => ({
  getLastAssistantMessage: (...args: unknown[]) => mockGetLastAssistantMessage(...args),
  addToConversation: (...args: unknown[]) => mockAddToConversation(...args),
}));

vi.mock('../../src/domains/secretary', () => ({
  handleSecretary: (...args: unknown[]) => mockHandleSecretary(...args),
}));

vi.mock('../../src/domains/triathlon', () => ({
  handleTriathlon: vi.fn(async () => ({ text: 'Training.', domain: 'triathlon' as const })),
}));

vi.mock('../../src/domains/content-creator', () => ({
  handleContent: vi.fn(async () => ({ text: 'Content.', domain: 'content' as const })),
}));

vi.mock('../../src/domains/finance', () => ({
  handleFinance: vi.fn(async () => ({ text: 'Finance.', domain: 'finance' as const })),
}));

vi.mock('../../src/domains/cooking', () => ({
  handleCooking: vi.fn(async () => ({ text: 'Cooking.', domain: 'cooking' as const })),
}));

vi.mock('../../src/services/content-engine', () => ({
  getScript: (...args: unknown[]) => mockGetScript(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: (...args: unknown[]) => mockCompleteOneShotWithFallback(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  getLastCoachState: (...args: unknown[]) => mockGetLastCoachState(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../src/utils/callback-store', () => ({
  getCallback: (...args: unknown[]) => mockGetCallback(...args),
  storeCallback: (...args: unknown[]) => mockStoreCallback(...args),
}));

import { chatRoutes } from '../../src/api/routes/chat';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only services; the chat/history
        // tests only need the schema that can apply cleanly in isolation.
      }
    }
  }
}

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any, headers: Record<string, string> = {}): Request {
  return {
    userId,
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as any;
}

async function dispatch(
  method: 'GET' | 'POST',
  url: string,
  userId: number,
  body?: any,
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = chatRoutes();
  const req = mockReq(userId, body, headers);
  (req as any).method = method;
  (req as any).url = url;
  (req as any).originalUrl = url;
  (req as any).baseUrl = '';
  (req as any).path = url.split('?')[0];
  (req as any).query = {};
  (req as any).params = {};

  const queryString = url.split('?')[1];
  if (queryString) {
    for (const [key, value] of new URLSearchParams(queryString).entries()) {
      (req as any).query[key] = value;
    }
  }

  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Chat API routes', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);

    mockRouteMessage.mockReset();
    mockTryDeterministicChatCommand.mockReset();
    mockClassifyAndExtractImage.mockReset();
    mockGetUserLanguage.mockReset();
    mockSetUserLanguage.mockReset();
    mockCheckTierAccess.mockReset();
    mockIsUserOverDailyCap.mockReset();
    mockGetLastAssistantMessage.mockReset();
    mockAddToConversation.mockReset();
    mockCompleteOneShotWithFallback.mockReset();
    mockHandleSecretary.mockReset();
    mockGetScript.mockReset();
    mockGetCallback.mockReset();
    mockStoreCallback.mockReset();
    mockGetLastCoachState.mockReset();
    mockApplyCoachRecommendations.mockReset();

    mockTryDeterministicChatCommand.mockResolvedValue(null);
    mockGetUserLanguage.mockReturnValue('en');
    mockCheckTierAccess.mockReturnValue({
      allowed: true,
      userTier: 'pro',
      requiredTier: 'free',
    });
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 1,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
    mockGetLastAssistantMessage.mockReturnValue(null);
    mockHandleSecretary.mockResolvedValue({ text: 'Scheduled.', domain: 'secretary' });
    mockGetScript.mockResolvedValue({
      topic: 'Recovery after intervals',
      script: 'Open strong. Explain why recovery matters after hard intervals.',
      hook: 'Most athletes sabotage the adaptation window after intervals.',
      title_options: ['Recovery after intervals', 'Why your intervals stop working', 'The recovery mistake'],
      sources_used: [],
      estimated_duration: '0:45-0:55',
      duration_ms: 3200,
      hashtags: ['#running'],
      caption: 'Caption',
      cta: 'Save this for your next hard session.',
      degraded: false,
      warnings: [],
    });
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: 'Tighter revised draft.',
      provider: 'gemini',
    });
    mockGetCallback.mockReturnValue(null);
    mockStoreCallback.mockReturnValue('cb-ref');
    mockGetLastCoachState.mockReturnValue(null);
    mockApplyCoachRecommendations.mockResolvedValue({
      count: 0,
      appliedRecommendations: [],
    });

    testDb.prepare(`
      INSERT INTO users (
        id,
        telegram_id,
        first_name,
        language,
        timezone,
        tier,
        status,
        auth_provider,
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7001,
      7001,
      'Test',
      'en',
      'Europe/Lisbon',
      'pro',
      'active',
      'telegram',
      40,
      100000,
      1,
    );
    testDb.prepare(`
      INSERT INTO users (
        id,
        telegram_id,
        first_name,
        language,
        timezone,
        tier,
        status,
        auth_provider,
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7002,
      7002,
      'Test',
      'en',
      'Europe/Lisbon',
      'pro',
      'active',
      'telegram',
      40,
      100000,
      1,
    );
    testDb.prepare(`
      INSERT INTO users (
        id,
        telegram_id,
        first_name,
        language,
        timezone,
        tier,
        status,
        auth_provider,
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7003,
      7003,
      'Test',
      'en',
      'Europe/Lisbon',
      'pro',
      'active',
      'telegram',
      40,
      100000,
      1,
    );
  });

  afterEach(() => {
    testDb?.close();
  });

  it('persists text chat exchanges and returns them through history', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: 'schedule a meeting',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'schedule a meeting',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.text).toBe('Scheduled.');
    expect(messageRes.body.routeMethod).toBe('classifier');

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[0]).toMatchObject({
      role: 'user',
      text: 'schedule a meeting',
    });
    expect(historyRes.body.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Scheduled.',
      domain: 'secretary',
      routeMethod: 'classifier',
      confidence: 0.93,
    });
  });

  it('persists attachment-driven replies and marks them as attachment routes', async () => {
    mockClassifyAndExtractImage.mockResolvedValue({
      type: 'invoice',
      vendor: 'McDonalds',
      totalAmount: '34.45 EUR',
      documentDateRaw: '07/04/2026',
      confidence: 0.98,
    });

    const messageRes = await dispatch('POST', '/message', 7002, {
      attachments: [
        { base64: 'ZmFrZS1pbWFnZS1kYXRh', mimeType: 'image/jpeg' },
      ],
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('attachment');
    expect(messageRes.body.text).toContain('McDonalds');

    const historyRes = await dispatch('GET', '/history?limit=10', 7002);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[0]).toMatchObject({
      role: 'user',
      text: 'Analyze this image.',
    });
    expect(historyRes.body.messages[1]).toMatchObject({
      role: 'assistant',
      domain: 'finance',
      routeMethod: 'attachment',
    });
  });

  it('edits the original persisted assistant message on callback updates', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.81,
      strippedMessage: 'cancel this',
    });

    const messageRes = await dispatch('POST', '/message', 7003, {
      text: 'cancel this',
    });
    const assistantMessageId = messageRes.body.id;

    const callbackRes = await dispatch('POST', '/callback', 7003, {
      callbackData: 'td:dn:abc123',
      messageId: assistantMessageId,
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      text: 'Cancelled.',
      editOriginal: true,
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7003);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[1]).toMatchObject({
      id: assistantMessageId,
      role: 'assistant',
      text: 'Cancelled.',
    });
  });

  it('returns inline buttons for deterministic fast-path responses and persists them', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: '/todo',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.buttons).toEqual([[{ text: '📅 Today', callbackData: 'cmd:/day' }]]);

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages[1]).toMatchObject({
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
      routeMethod: 'fast-path',
    });
  });

  it('handles deterministic command callbacks by replacing the original message and buttons', async () => {
    mockTryDeterministicChatCommand
      .mockResolvedValueOnce({
        text: '<b>Status</b>',
        domain: 'secretary',
        buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
      })
      .mockResolvedValueOnce({
        text: '<b>Day overview</b>',
        domain: 'secretary',
        buttons: [[{ text: '📋 Tasks', callbackData: 'cmd:/todo_summary' }]],
      });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: '/status',
    });
    const assistantMessageId = messageRes.body.id;

    const callbackRes = await dispatch('POST', '/callback', 7001, {
      callbackData: 'cmd:/day',
      messageId: assistantMessageId,
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      text: '<b>Day overview</b>',
      editOriginal: true,
      newButtons: [[{ text: '📋 Tasks', callbackData: 'cmd:/todo_summary' }]],
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages[1]).toMatchObject({
      id: assistantMessageId,
      text: '<b>Day overview</b>',
      buttons: [[{ text: '📋 Tasks', callbackData: 'cmd:/todo_summary' }]],
      routeMethod: 'fast-path',
    });
  });

  it('attaches actionable coach buttons to fresh triathlon briefings', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'triathlon',
      method: 'classifier',
      confidence: 0.95,
      strippedMessage: 'coach me for tomorrow',
    });
    const { handleTriathlon } = await import('../../src/domains/triathlon');
    vi.mocked(handleTriathlon).mockResolvedValue({
      text: '🏋️ Coach briefing ready.',
      domain: 'triathlon',
    });
    mockGetLastCoachState.mockReturnValue({
      timestamp: Date.now(),
      briefingSummary: 'Coach briefing ready.',
      recommendations: [
        {
          eventId: 'evt-1',
          source: 'outlook',
          action: 'MODIFY',
          originalTitle: 'Track workout',
          newTitle: 'Easy run 30min',
          newStart: null,
          newEnd: null,
          summary: 'Reduce intensity for tomorrow',
        },
      ],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Coach me for tomorrow',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('triathlon');
    expect(messageRes.body.buttons).toEqual([
      [{ text: '⚠️ Reduce intensity for tomorrow', callbackData: 'coach:apply:cb-ref' }],
      [{ text: '👍 Keep all', callbackData: 'coach:dismiss' }],
    ]);
  });

  it('applies coach callbacks and clears buttons from the persisted message', async () => {
    mockGetCallback.mockReturnValue({ recommendationIds: ['evt-1'] });
    mockApplyCoachRecommendations.mockResolvedValue({
      count: 1,
      appliedRecommendations: [
        {
          eventId: 'evt-1',
          source: 'outlook',
          action: 'MODIFY',
          originalTitle: 'Track workout',
          newTitle: 'Easy run 30min',
          newStart: null,
          newEnd: null,
          summary: 'Reduce intensity for tomorrow',
        },
      ],
    });

    testDb.prepare(`
      INSERT INTO messages (user_id, message_uuid, role, text, domain, buttons_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      7001,
      'coach-msg-1',
      'assistant',
      '🏋️ Coach briefing ready.',
      'triathlon',
      JSON.stringify([[{ text: '⚠️ Reduce intensity for tomorrow', callbackData: 'coach:apply:cb-ref' }]]),
      '2026-04-13T09:00:01Z',
    );

    const callbackRes = await dispatch('POST', '/callback', 7001, {
      callbackData: 'coach:apply:cb-ref',
      messageId: 'coach-msg-1',
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      editOriginal: true,
      newButtons: null,
    });
    expect(callbackRes.body.text).toContain('Applied 1 recommendation');

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    const updated = historyRes.body.messages.find((message: any) => message.id === 'coach-msg-1');
    expect(updated).toMatchObject({
      text: callbackRes.body.text,
      buttons: null,
    });
  });

  it('routes explicit script generation asks through the canonical content script pipeline', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.97,
      strippedMessage: 'Write a short script about recovery after hard intervals',
    });
    mockGetScript.mockResolvedValueOnce({
      topic: 'Recovery after intervals',
      script: 'Hook body here. [SFX:vine-boom] [TAKE] [VERIFIED: Mock Source]\n\nFONTES VERIFICADAS:\n1. Source\n\nCTA:\nDo not leak this.',
      hook: 'Most athletes sabotage the adaptation window after intervals.',
      title_options: ['Recovery after intervals', 'Why your intervals stop working', 'The recovery mistake'],
      sources_used: [],
      estimated_duration: '0:45-0:55',
      duration_ms: 3200,
      hashtags: ['#running'],
      caption: 'Caption',
      cta: 'Save this for your next hard session.',
      degraded: false,
      warnings: [],
    });
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Write a short script about recovery after hard intervals in English',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-script');
    expect(messageRes.body.text).toContain('Short script');
    expect(messageRes.body.text).toContain('Hook body here.');
    expect(messageRes.body.text).toContain('Suggested closing line: Save this for your next hard session.');
    expect(messageRes.body.text).not.toContain('Possible titles');
    expect(messageRes.body.text).not.toContain('Grounded in');
    expect(messageRes.body.text).not.toContain('Visuals:');
    expect(messageRes.body.text).not.toContain('FONTES VERIFICADAS');
    expect(messageRes.body.text).not.toContain('Hashtags');
    expect(messageRes.body.text).not.toContain('[SFX:');
    expect(messageRes.body.text).not.toContain('[SHOW ON SCREEN:');
    expect(messageRes.body.text).not.toContain('[TAKE]');
    expect(messageRes.body.text).not.toContain('[VERIFIED:');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_script',
      format: 'Reel',
      topic: 'Recovery after intervals',
      cta: 'Save this for your next hard session.',
    });
    expect(mockGetScript).toHaveBeenCalledWith(
      'recovery after hard intervals',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'chat',
    );
    expect(mockAddToConversation).toHaveBeenCalledWith(7001, 'content', 'user', 'Write a short script about recovery after hard intervals in English');
    expect(mockAddToConversation).toHaveBeenCalledWith(7001, 'content', 'assistant', expect.stringContaining('Short script'));
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('localizes degraded script warnings for Portuguese chat output and strips production cue leftovers', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.94,
      strippedMessage: 'Escreve um roteiro curto sobre recuperação depois de intervalos duros',
    });
    mockGetScript.mockResolvedValueOnce({
      topic: 'recuperação depois de intervalos duros',
      script: 'Recupera melhor. [SHOW ON SCREEN: rolo leve] [TAKE]!.',
      hook: 'Recuperar faz parte do treino.',
      title_options: ['Recupera melhor', 'Não estragues o treino'],
      sources_used: [],
      estimated_duration: '0:30-0:45',
      duration_ms: 2800,
      hashtags: ['#triatlo'],
      caption: 'Caption',
      cta: 'Guarda isto para o teu próximo treino duro.',
      degraded: true,
      warnings: ['AI synthesis was unavailable; returning search-based fallback briefs.'],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Escreve um roteiro curto sobre recuperação depois de intervalos duros em português europeu',
    }, {
      'x-language': 'pt-PT',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.text).toContain('Aviso: este roteiro foi gerado em modo degradado.');
    expect(messageRes.body.text).toContain('A síntese por IA ficou indisponível');
    expect(messageRes.body.text).toContain('Fecho sugerido: Guarda isto para o teu próximo treino duro.');
    expect(messageRes.body.text).not.toContain('[SHOW ON SCREEN:');
    expect(messageRes.body.text).not.toContain('[TAKE]');
    expect(messageRes.body.text).not.toContain('!.');
  });

  it('uses the content refine shortcut for content follow-up rewrites instead of the generic content handler', async () => {
    mockRouteMessage.mockResolvedValueOnce({
      domain: 'content',
      method: 'keyword',
      confidence: 0.97,
      strippedMessage: 'Write a short script about recovery after hard intervals',
    });

    const firstRes = await dispatch('POST', '/message', 7001, {
      text: 'Write a short script about recovery after hard intervals in English',
    });

    expect(firstRes.statusCode, JSON.stringify(firstRes.body)).toBe(200);
    mockGetLastAssistantMessage.mockReturnValue(firstRes.body.text);
    mockRouteMessage.mockResolvedValueOnce({
      domain: 'content',
      method: 'context',
      confidence: 0.91,
      strippedMessage: 'make it shorter',
    });

    const { handleContent } = await import('../../src/domains/content-creator');
    const refineRes = await dispatch('POST', '/message', 7001, {
      text: 'make it shorter',
    }, {
      'x-language': 'en-US',
    });

    expect(refineRes.statusCode, JSON.stringify(refineRes.body)).toBe(200);
    expect(refineRes.body.domain).toBe('content');
    expect(refineRes.body.routeMethod).toBe('content-refine');
    expect(refineRes.body.text).toBe('Tighter revised draft.');
    expect(refineRes.body.metadata).toMatchObject({
      type: 'content_refine',
      degraded: false,
    });
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('Reply in English unless the user explicitly asks to switch languages.'),
      expect.stringContaining('make it shorter'),
      'content_chat_refine',
      expect.any(Function),
      expect.objectContaining({
        maxTokens: 1200,
        temperature: 0.5,
        userId: 7001,
      }),
    );
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns a conservative shortened fallback when live content refinement is unavailable', async () => {
    mockRouteMessage.mockResolvedValueOnce({
      domain: 'content',
      method: 'context',
      confidence: 0.91,
      strippedMessage: 'make it shorter',
    });
    mockGetLastAssistantMessage.mockReturnValue(
      'You are training hard, but recovery is where adaptation happens. Sleep and fuel matter more than most athletes admit. If you ignore recovery, your next interval day will suffer.',
    );
    mockCompleteOneShotWithFallback.mockRejectedValueOnce(new Error('gemini overloaded'));

    const refineRes = await dispatch('POST', '/message', 7001, {
      text: 'make it shorter',
    }, {
      'x-language': 'en-US',
    });

    expect(refineRes.statusCode, JSON.stringify(refineRes.body)).toBe(200);
    expect(refineRes.body.routeMethod).toBe('content-refine-fallback');
    expect(refineRes.body.text).toContain('conservative shorter version');
    expect(refineRes.body.text).toContain('You are training hard');
    expect(refineRes.body.metadata).toMatchObject({
      type: 'content_refine_fallback',
      degraded: true,
    });
  });

  it('returns an explicit degraded script-unavailable response when the structured script pipeline fails', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'Write a short script about recovery after hard intervals',
    });
    mockGetScript.mockRejectedValueOnce(new Error('content engine unavailable'));
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Write a short script about recovery after hard intervals in English',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-script-unavailable');
    expect(messageRes.body.text).toContain('structured script');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_script_unavailable',
      degraded: true,
      format: 'Reel',
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns 402 with quota details when a free user tries an AI chat request', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0,
      capUsd: 0,
      plan: 'free',
      resetAt: '2026-04-15T00:00:00.000Z',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Help me plan my week',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(402);
    expect(messageRes.body.ok).toBe(false);
    expect(messageRes.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(messageRes.body.error.details).toEqual({
      plan: 'free',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });
});

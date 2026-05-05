// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for the Telegram webhook code path in src/api/routes/webhooks.ts.
 *
 * Validates the GATING logic — the /webhooks/telegram route is only mounted
 * when BOTH:
 *   1. A grammy Bot instance is passed to createWebhookRouter
 *   2. config.telegram.webhookUrl is set (the env var that opts in)
 *
 * This is the safety contract for the long-polling → webhooks migration:
 * default state (no env var) leaves the route unmounted, so a regression
 * here would silently break the boot path of any install that relies on
 * long-polling.
 *
 * We do NOT test the actual webhook delivery flow because that would
 * require running grammy's full middleware chain — we trust grammy's
 * own tests for webhookCallback semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// Hoisted state — `vi.hoisted` lets the mock factory read variables that
// the test mutates between cases. Without this, `vi.mock` would capture
// the value at module-load time and ignore later changes.
const mockState = vi.hoisted(() => ({
  webhookUrl: '',
  webhookSecret: '',
}));

vi.mock('../../src/config', () => ({
  config: {
    todoist: {
      clientId: 'test_client',
      clientSecret: 'test_secret',
      webhookSecret: 'webhook_test_secret',
    },
    telegram: {
      get webhookUrl() {
        return mockState.webhookUrl;
      },
      get webhookSecret() {
        return mockState.webhookSecret;
      },
    },
  },
}));

// Mock the dependent services
vi.mock('../../src/services/database', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));
vi.mock('../../src/services/task-store/sync-engine', () => ({
  syncProvider: vi.fn().mockResolvedValue({ tasksUpserted: 0, errors: [] }),
}));
vi.mock('../../src/services/task-store/todoist-adapter', () => ({
  findNexusUserByTodoistId: vi.fn().mockReturnValue(123),
  rememberTodoistUserMapping: vi.fn(),
}));
vi.mock('../../src/services/context-engine', () => ({
  invalidateContextCache: vi.fn(),
}));

import { createWebhookRouter } from '../../src/api/routes/webhooks';

/** Build an Express app with the router and check whether POST /webhooks/telegram returns 200 or 404. */
async function probe(bot: any): Promise<{ status: number; body?: any }> {
  const app = express();
  app.use('/webhooks', createWebhookRouter(bot));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.request(
        {
          method: 'POST',
          hostname: '127.0.0.1',
          port,
          path: '/webhooks/telegram',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            server.close(() => {
              try {
                resolve({ status: res.statusCode || 0, body: body ? JSON.parse(body) : undefined });
              } catch {
                resolve({ status: res.statusCode || 0, body });
              }
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      // Telegram update payload — minimal valid shape
      req.write(JSON.stringify({ update_id: 123, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } }));
      req.end();
    });
  });
}

/**
 * Build a fake grammy Bot stub with the methods grammy's webhookCallback
 * actually calls:
 *   - isRunning() — returns false so webhookCallback proceeds (otherwise
 *     it throws "Bot is already running via long polling")
 *   - init() — called once on first delivery to populate botInfo
 *   - handleUpdate(update) — called per update; this is where grammy
 *     dispatches to the bot's middleware chain
 *   - start — webhookCallback overrides this with a throw, so we just
 *     need a writable property
 */
function makeFakeBot(): any {
  const bot = {
    isRunning: vi.fn().mockReturnValue(false),
    init: vi.fn().mockResolvedValue(undefined),
    handleUpdate: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    botInfo: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' },
    api: { getMe: vi.fn() },
  };
  return bot;
}

describe('createWebhookRouter — Telegram gating', () => {
  beforeEach(() => {
    mockState.webhookUrl = '';
    mockState.webhookSecret = '';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT mount /webhooks/telegram when no bot is passed', async () => {
    mockState.webhookUrl = 'https://example.com/webhooks/telegram';
    const result = await probe(undefined);
    expect(result.status).toBe(404);
  });

  it('does NOT mount /webhooks/telegram when bot is passed but webhookUrl is empty', async () => {
    mockState.webhookUrl = '';
    const fakeBot = makeFakeBot();
    const result = await probe(fakeBot);
    expect(result.status).toBe(404);
  });

  it('mounts /webhooks/telegram when bot is passed AND webhookUrl is set', async () => {
    mockState.webhookUrl = 'https://example.com/webhooks/telegram';
    const fakeBot = makeFakeBot();
    const result = await probe(fakeBot);
    // grammy's webhookCallback returns 200 on a successful handleUpdate
    // (it called handleUpdate on our fake bot which returns undefined).
    // The exact body shape isn't important — what matters is it isn't 404.
    expect(result.status).not.toBe(404);
    expect(fakeBot.handleUpdate).toHaveBeenCalled();
  });

  it('rejects requests with the wrong X-Telegram-Bot-Api-Secret-Token', async () => {
    mockState.webhookUrl = 'https://example.com/webhooks/telegram';
    mockState.webhookSecret = 'super-secret-123';
    const fakeBot = makeFakeBot();

    // Build a request with a wrong secret header — grammy should reject
    // BEFORE calling handleUpdate
    const app = express();
    app.use('/webhooks', createWebhookRouter(fakeBot));

    const status = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = (server.address() as any).port;
        const req = http.request(
          {
            method: 'POST',
            hostname: '127.0.0.1',
            port,
            path: '/webhooks/telegram',
            headers: {
              'Content-Type': 'application/json',
              'X-Telegram-Bot-Api-Secret-Token': 'WRONG-SECRET',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              server.close(() => resolve(res.statusCode || 0));
            });
          },
        );
        req.on('error', (err) => {
          server.close();
          reject(err);
        });
        req.write(JSON.stringify({ update_id: 1 }));
        req.end();
      });
    });

    // grammy returns 401 when the secret token doesn't match
    expect(status).toBe(401);
    // And handleUpdate must NOT have been invoked
    expect(fakeBot.handleUpdate).not.toHaveBeenCalled();
  });

  it('accepts requests with the correct X-Telegram-Bot-Api-Secret-Token', async () => {
    const SECRET = 'super-secret-123';
    mockState.webhookUrl = 'https://example.com/webhooks/telegram';
    mockState.webhookSecret = SECRET;
    const fakeBot = makeFakeBot();

    const app = express();
    app.use('/webhooks', createWebhookRouter(fakeBot));

    const status = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = (server.address() as any).port;
        const req = http.request(
          {
            method: 'POST',
            hostname: '127.0.0.1',
            port,
            path: '/webhooks/telegram',
            headers: {
              'Content-Type': 'application/json',
              'X-Telegram-Bot-Api-Secret-Token': SECRET,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              server.close(() => resolve(res.statusCode || 0));
            });
          },
        );
        req.on('error', (err) => {
          server.close();
          reject(err);
        });
        req.write(JSON.stringify({ update_id: 99, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } }));
        req.end();
      });
    });

    expect(status).not.toBe(401);
    expect(status).not.toBe(404);
    expect(fakeBot.handleUpdate).toHaveBeenCalled();
  });

  it('the existing Todoist route still works alongside the Telegram route', async () => {
    // Both routes exist on the same router — verify they don't interfere.
    mockState.webhookUrl = 'https://example.com/webhooks/telegram';
    const fakeBot = makeFakeBot();
    const app = express();
    app.use('/webhooks', createWebhookRouter(fakeBot));

    const status = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = (server.address() as any).port;
        const req = http.request(
          {
            method: 'POST',
            hostname: '127.0.0.1',
            port,
            path: '/webhooks/todoist',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              server.close(() => resolve(res.statusCode || 0));
            });
          },
        );
        req.on('error', (err) => {
          server.close();
          reject(err);
        });
        req.write('{}');
        req.end();
      });
    });

    // Todoist route returns 401 because we didn't sign the body, but it's
    // NOT 404 — it exists.
    expect(status).not.toBe(404);
  });
});

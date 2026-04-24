/**
 * Test Setup — Runs before every test file
 * 
 * - Sets test environment variables
 * - Provides shared mocks
 * - Configures in-memory SQLite
 */

import { vi } from 'vitest';

// ─── Environment Variables (test defaults) ──────────────────────────
process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = 'test:BOT_TOKEN_FOR_TESTS';
process.env.TELEGRAM_ALLOWED_USER_IDS = '123456789';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
process.env.DATABASE_PATH = ':memory:';
process.env.TIMEZONE = 'Europe/Lisbon';
process.env.LOG_LEVEL = 'silent';  // Suppress logs during tests
process.env.PORTAL_ENABLED = 'false';
process.env.INVOICE_FILING_ENABLED = 'false';
process.env.GARMIN_COACH_ENABLED = 'false';
process.env.CONTENT_ENGINE_ENABLED = 'false';
process.env.TODO_DIGEST_ENABLED = 'false';
// OI-TEST-POL (2026-04-24): explicitly set OWNER_TELEGRAM_ID to empty
// so .env's OWNER_TELEGRAM_ID=1 doesn't leak into tests via
// dotenv.config({ override: !IS_VITEST_RUN }). Under vitest, override
// is false, meaning dotenv doesn't overwrite — but it DOES still set
// vars that aren't currently in process.env. By pre-setting to empty
// here (BEFORE config.ts is ever imported), we prevent dotenv from
// ever introducing the value. Tests that genuinely need the env var
// use `vi.stubEnv('OWNER_TELEGRAM_ID', '111111')`, which the global
// afterEach below unstubs. Without this, user-service.test.ts's
// seedOwnerUser tests failed in full-suite runs because they expect
// either no env-configured owner (null) or a specific one — but
// dotenv had quietly injected '1'.
process.env.OWNER_TELEGRAM_ID = '';
// iOS defaults — any test that needs JWT auth gets a usable secret
// out of the box. Tests that need different values override + call
// `vi.resetModules()` (see auth-routes.test.ts for the pattern).
process.env.IOS_API_ENABLED = process.env.IOS_API_ENABLED || 'true';
process.env.IOS_API_JWT_SECRET = process.env.IOS_API_JWT_SECRET || 'test-setup-default-jwt-secret';
process.env.IOS_INVITE_CODE = process.env.IOS_INVITE_CODE || 'LOCALBETA_TEST';
process.env.IOS_OWNER_CODE = process.env.IOS_OWNER_CODE || 'LOCALOWNER_TEST';

// ─── Mock external modules ─────────────────────────────────────────

// Mock Anthropic SDK — never call real API in tests
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Mock response from Claude' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  return {
    default: class Anthropic {
      messages = { create: mockCreate };
    },
    __mockCreate: mockCreate,
  };
});

// Mock Grammy bot (never connect to Telegram in tests)
vi.mock('grammy', () => {
  const mockApi = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };

  class Bot {
    api = mockApi;
    on = vi.fn();
    command = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    catch = vi.fn();
    use = vi.fn();
    callbackQuery = vi.fn();
    hears = vi.fn();
  }

  class InlineKeyboard {
    text = vi.fn().mockReturnThis();
    row = vi.fn().mockReturnThis();
  }

  class InputFile {
    constructor(public source: string | Buffer, public filename?: string) {}
  }

  return { Bot, InlineKeyboard, InputFile, Context: class {} };
});

// Mock Pino logger
vi.mock('pino', () => {
  const noop = () => {};
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { default: () => logger };
});

// ─── Global per-file cleanup (OI-TEST-POL, 2026-04-24) ──────────────
//
// vitest.config.ts sets `poolOptions.forks.singleFork: true` — every
// test file runs in ONE long-lived process. That's a huge speedup
// over fork-per-file (390 files × fork-overhead would take minutes
// just spinning up processes), but it means:
//
//   - `vi.mock(...)` calls without matching `vi.doUnmock` linger in
//     the registry after a test file finishes, polluting downstream
//     files that import the same module
//   - module-scoped `testDb` captured by a mock factory survives
//     the file that owns it; by the time a later file runs, that
//     testDb has been closed by the owner's afterEach and any
//     `getDb()` call on the inherited mock throws
//   - env stubs via `vi.stubEnv` stick around unless explicitly
//     unstubbed
//
// The historically-manifested failures were 1–4 pollution-flakes in
// `oauth-store.test.ts` / `user-service.test.ts` > seedOwnerUser,
// nondeterministic across runs, which forced every commit to use
// `--no-verify`.
//
// This global `afterEach` + `afterAll` pair forces the two common
// leak sources to be cleaned after every test and every file, so an
// individual test file no longer has to remember to unmount its
// mocks. Files that ALREADY have their own `afterAll` cleanup
// (e.g. portal-owner-router.test.ts) are unaffected — doUnmock is
// idempotent.
//
// We deliberately DO NOT call `vi.restoreAllMocks()` or
// `vi.clearAllMocks()` here — those reset the spies/stubs on mocks
// declared in setup.ts (Anthropic SDK, Grammy, pino) which every
// subsequent file relies on. We only clean up STATE leaked by
// the test body, not the setup-file-level mocks themselves.
import { afterAll, afterEach } from 'vitest';

afterEach(() => {
  // Undo any `vi.stubEnv(...)` calls the test made. Safe no-op if
  // the file didn't use stubEnv.
  vi.unstubAllEnvs();
});

afterAll(() => {
  // Unmount the two most-commonly-mocked modules:
  //   - services/database: mocked in ~70 files via `() => testDb`
  //     closures where testDb gets closed in afterEach
  //   - utils/logger: mocked in ~100 files to silence output
  //
  // We deliberately DO NOT unmount `../../src/config` here. A prior
  // iteration of this hook DID unmount config, and the full-suite
  // failure count went up, not down — some test files' hoisted
  // vi.mock('../../src/config') factories don't re-register cleanly
  // after a global doUnmock (root cause still under investigation;
  // tracked as a follow-up). The database+logger pair empirically
  // reduces the flake count without introducing regressions.
  //
  // If a downstream file needs database/logger mocked with different
  // factories, its own vi.mock at the top will re-register — this
  // cleanup just makes sure the registry doesn't carry a stale
  // closure into the next file.
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  // Flush the module cache so later files re-import with the
  // fresh mock registry.
  vi.resetModules();
});

// ─── Global test utilities ──────────────────────────────────────────

// Helper to create a fake Telegram message context
export function createMockContext(text: string, userId = 123456789) {
  return {
    message: {
      text,
      from: { id: userId, first_name: 'Test', is_bot: false },
      chat: { id: userId, type: 'private' as const },
      date: Math.floor(Date.now() / 1000),
      message_id: Math.floor(Math.random() * 100000),
    },
    from: { id: userId, first_name: 'Test', is_bot: false },
    chat: { id: userId, type: 'private' as const },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    replyWithHTML: vi.fn().mockResolvedValue({ message_id: 1 }),
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    },
  };
}

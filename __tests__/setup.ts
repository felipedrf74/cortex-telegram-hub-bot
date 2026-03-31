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

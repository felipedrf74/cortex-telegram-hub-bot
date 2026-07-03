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


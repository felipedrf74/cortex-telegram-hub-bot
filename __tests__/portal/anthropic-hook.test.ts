// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Anthropic kill-switch tests (April 9 2026).
 *
 * These tests lock in the behavior of the ANTHROPIC_ENABLED env var
 * gate in `src/portal/anthropic-hook.ts`. The gate is the single
 * chokepoint that guarantees zero Claude expenses — if a future
 * refactor accidentally removes or bypasses it, these tests fail
 * loudly.
 *
 * Why the kill switch exists: see the doc block in `anthropic-hook.ts`
 * `trackedCreate`. Short version: the cost dashboard on April 9 2026
 * showed $0.20/day of Claude spend from fallback call sites even
 * though the domain router had been flipped to Gemini-first. Changing
 * every fallback thunk one-by-one was error-prone; hard-failing at
 * the hook layer guarantees coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// Mock the SDK so we never actually hit the Anthropic API. The mock
// client's `messages.create` is a spy we inspect to assert that it
// was NEVER called when the kill switch is active.
const mockCreate = vi.fn();
const mockStream = vi.fn();

const mockClient = {
  messages: {
    create: mockCreate,
    stream: mockStream,
  },
} as unknown as Anthropic;

// Mock the DB so trackedCreate's post-success INSERT doesn't blow up.
// The kill switch fires BEFORE the DB write, so this mock mostly
// exists to prevent a red herring when the kill switch is disabled.
vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ run: vi.fn() }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

// Import AFTER mocks are declared so the module picks them up.
import { trackedCreate } from '../../src/portal/anthropic-hook';

const dummyParams = {
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
} as Anthropic.MessageCreateParamsNonStreaming;

describe('trackedCreate kill switch (ANTHROPIC_ENABLED)', () => {
  const originalEnv = process.env.ANTHROPIC_ENABLED;

  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  afterEach(() => {
    // Restore the env to whatever the test harness originally had —
    // leaving ANTHROPIC_ENABLED dirty would poison downstream tests.
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_ENABLED;
    } else {
      process.env.ANTHROPIC_ENABLED = originalEnv;
    }
  });

  it('throws when ANTHROPIC_ENABLED is unset', async () => {
    delete process.env.ANTHROPIC_ENABLED;

    await expect(
      trackedCreate(mockClient, dummyParams, 'test_category'),
    ).rejects.toThrow(/Anthropic API is disabled/);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('throws when ANTHROPIC_ENABLED is an empty string', async () => {
    process.env.ANTHROPIC_ENABLED = '';

    await expect(
      trackedCreate(mockClient, dummyParams, 'test_category'),
    ).rejects.toThrow(/Anthropic API is disabled/);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws when ANTHROPIC_ENABLED is "false"', async () => {
    process.env.ANTHROPIC_ENABLED = 'false';

    await expect(
      trackedCreate(mockClient, dummyParams, 'test_category'),
    ).rejects.toThrow(/Anthropic API is disabled/);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws when ANTHROPIC_ENABLED is any non-"true" string', async () => {
    process.env.ANTHROPIC_ENABLED = 'yes';

    await expect(
      trackedCreate(mockClient, dummyParams, 'test_category'),
    ).rejects.toThrow(/Anthropic API is disabled/);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('includes category, model, and userId in the error message for diagnosability', async () => {
    delete process.env.ANTHROPIC_ENABLED;

    await expect(
      trackedCreate(mockClient, dummyParams, 'coach_analysis', { userId: 42 }),
    ).rejects.toThrow(/category=coach_analysis/);

    await expect(
      trackedCreate(mockClient, dummyParams, 'coach_analysis', { userId: 42 }),
    ).rejects.toThrow(/model=claude-haiku-4-5-20251001/);

    await expect(
      trackedCreate(mockClient, dummyParams, 'coach_analysis', { userId: 42 }),
    ).rejects.toThrow(/userId=42/);
  });

  it('hints at the OpenAI fallback migration path in the error message', async () => {
    delete process.env.ANTHROPIC_ENABLED;

    await expect(
      trackedCreate(mockClient, dummyParams, 'test_category'),
    ).rejects.toThrow(/completeOneShotWithFallback in gemini-provider\.ts/);
  });

  it('allows the call through when ANTHROPIC_ENABLED="true" (explicit opt-in)', async () => {
    process.env.ANTHROPIC_ENABLED = 'true';

    // Mock a successful Haiku response. The SDK returns a Message
    // object; we just need the usage shape for the cost calc to not
    // blow up.
    mockCreate.mockResolvedValue({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    // Should NOT throw — the kill switch is bypassed.
    const result = await trackedCreate(mockClient, dummyParams, 'test_category');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

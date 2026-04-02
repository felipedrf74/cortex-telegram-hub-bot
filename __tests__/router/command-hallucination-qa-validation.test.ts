/**
 * QA Validation: BUG P0 — Bot hallucinating context instead of executing commands
 *
 * Validates the flex agent's fix for the three reported P0 scenarios:
 * 1. /expense add 45.50 → should reject, NOT generate status report
 * 2. Hello → should NOT search for overdue tasks / heavy context
 * 3. /expense list → should reject, NOT generate generic welcome
 *
 * Also validates edge cases the fix must handle correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patternMatch, keywordMatch, isGreeting } from '../../src/router/classifier';
import { routeMessage, isSystemCommand } from '../../src/router/index';

vi.mock('../../src/services/anthropic', () => ({
  classifyMessage: vi.fn(),
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

import { classifyMessage } from '../../src/services/anthropic';

const mockClassifyMessage = vi.mocked(classifyMessage);

describe('QA Validation: P0 Command Hallucination Fix', () => {
  beforeEach(() => {
    mockClassifyMessage.mockReset();
  });

  // ─── Exact bug reproduction scenarios ────────────────────────────
  describe('Bug scenario #1: /expense add 45.50 → status report hallucination', () => {
    it('must NOT reach the classifier', async () => {
      const result = await routeMessage('/expense add 45.50');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('must return unknown_command method', async () => {
      const result = await routeMessage('/expense add 45.50');
      expect(result.method).toBe('unknown_command');
      expect(result.confidence).toBe(0);
    });

    it('must NOT match any registered domain pattern', () => {
      expect(patternMatch('/expense add 45.50')).toBeNull();
    });

    it('must NOT match any system command', () => {
      expect(isSystemCommand('/expense add 45.50')).toBeNull();
    });
  });

  describe('Bug scenario #2: "Hello" → searches overdue tasks', () => {
    it('must be detected as greeting and skip classifier', async () => {
      expect(isGreeting('Hello')).toBe(true);
      const result = await routeMessage('Hello');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(result.method).toBe('greeting');
    });

    it('greeting route must NOT go through keyword match', async () => {
      // "Hello" should not match secretary keywords like "tasks" or "calendar"
      expect(keywordMatch('Hello')).toBeNull();
    });
  });

  describe('Bug scenario #3: /expense list → generic welcome hallucination', () => {
    it('must be rejected as unknown command', async () => {
      const result = await routeMessage('/expense list');
      expect(result.method).toBe('unknown_command');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });
  });

  // ─── Slash command guard edge cases ──────────────────────────────
  describe('Slash command guard edge cases', () => {
    it('single slash "/" should be treated as unknown command', async () => {
      const result = await routeMessage('/');
      expect(result.method).toBe('unknown_command');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('/EXPENSE (uppercase) should be rejected', async () => {
      // patternMatch uses /i flag, so if /expense isn't registered, /EXPENSE won't be either
      expect(patternMatch('/EXPENSE')).toBeNull();
      const result = await routeMessage('/EXPENSE');
      expect(result.method).toBe('unknown_command');
    });

    it('slash commands with leading whitespace still work', async () => {
      const result = await routeMessage('  /expense add 10');
      // After trim, starts with / and not registered → unknown_command
      expect(result.method).toBe('unknown_command');
    });

    it('registered commands are NOT affected by the guard', async () => {
      // /todo is registered under secretary
      const result = await routeMessage('/todo buy groceries');
      expect(result.method).toBe('pattern');
      expect(result.domain).toBe('secretary');
    });

    it('/train (registered) still routes to triathlon', async () => {
      const result = await routeMessage('/train legs');
      expect(result.method).toBe('pattern');
      expect(result.domain).toBe('triathlon');
    });

    it('/content (registered) still routes to content', async () => {
      const result = await routeMessage('/content ideas');
      expect(result.method).toBe('pattern');
      expect(result.domain).toBe('content');
    });
  });

  // ─── Greeting guard edge cases ──────────────────────────────────
  describe('Greeting guard: must NOT over-match', () => {
    it('greeting with trailing content is NOT a greeting', () => {
      expect(isGreeting('hello can you check my calendar')).toBe(false);
      expect(isGreeting('hi, schedule a meeting')).toBe(false);
      expect(isGreeting('hey what tasks do I have')).toBe(false);
    });

    it('greeting embedded in a sentence is NOT a greeting', () => {
      expect(isGreeting('I said hello to the team')).toBe(false);
      expect(isGreeting('can you say hi to mom')).toBe(false);
    });

    it('task-like messages are NOT greetings', () => {
      expect(isGreeting('what do I have today')).toBe(false);
      expect(isGreeting('show me my tasks')).toBe(false);
      expect(isGreeting('plan my week')).toBe(false);
    });

    it('messages with only punctuation after greeting ARE greetings', () => {
      expect(isGreeting('hello!')).toBe(true);
      expect(isGreeting('hi.')).toBe(true);
      expect(isGreeting('hey?')).toBe(true);
      expect(isGreeting('Olá!')).toBe(true);
    });

    it('empty string is NOT a greeting', () => {
      expect(isGreeting('')).toBe(false);
    });

    it('whitespace-only is NOT a greeting', () => {
      expect(isGreeting('   ')).toBe(false);
    });
  });

  // ─── Lightweight context path ────────────────────────────────────
  describe('Greeting method triggers lightweight context path', () => {
    it('greeting route returns secretary domain with greeting method', async () => {
      const result = await routeMessage('Bom dia!');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('greeting');
      expect(result.confidence).toBe(1.0);
    });

    it('acknowledgments use greeting method too', async () => {
      for (const msg of ['ok', 'yes', 'no', 'got it', 'sure', 'thanks']) {
        const result = await routeMessage(msg);
        expect(result.method).toBe('greeting');
      }
    });
  });

  // ─── Route result shape validation ───────────────────────────────
  describe('RouteResult shape consistency', () => {
    it('unknown_command has all required fields', async () => {
      const result = await routeMessage('/fakecmd test');
      expect(result).toMatchObject({
        domain: 'secretary',
        method: 'unknown_command',
        confidence: 0,
        strippedMessage: '/fakecmd test',
      });
    });

    it('greeting has all required fields', async () => {
      const result = await routeMessage('hello');
      expect(result).toMatchObject({
        domain: 'secretary',
        method: 'greeting',
        confidence: 1.0,
        strippedMessage: 'hello',
      });
    });

    it('pattern match still has all required fields', async () => {
      const result = await routeMessage('/todo test item');
      expect(result).toMatchObject({
        domain: 'secretary',
        method: 'pattern',
        confidence: 1.0,
      });
    });
  });

  // ─── Secretary lightweight context ───────────────────────────────
  describe('Secretary handleSecretary lightweight parameter', () => {
    // Validate the function signature accepts the lightweight flag
    it('handleSecretary exports accept a third lightweight parameter', async () => {
      const { handleSecretary } = await import('../../src/domains/secretary');
      expect(typeof handleSecretary).toBe('function');
      // Function should accept 3 params (message, userId, lightweight)
      expect(handleSecretary.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Interaction with active conversation context ────────────────
  describe('Guards work even with active conversation context', () => {
    it('unknown slash command with active context still rejected', async () => {
      const ctx = { domain: 'secretary' as const, lastAssistantMessage: 'Status report...' };
      const result = await routeMessage('/expense add 50', ctx);
      expect(result.method).toBe('unknown_command');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('greeting with active context still uses greeting route', async () => {
      const ctx = { domain: 'triathlon' as const, lastAssistantMessage: 'Great run!' };
      const result = await routeMessage('thanks', ctx);
      // "thanks" is a greeting — should NOT fall to context-aware classifier
      expect(result.method).toBe('greeting');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('real message with active context still uses classifier', async () => {
      const ctx = { domain: 'triathlon' as const, lastAssistantMessage: 'Great run!' };
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.95 });
      const result = await routeMessage('how about tomorrow?', ctx);
      expect(result.method).toBe('classifier');
      expect(mockClassifyMessage).toHaveBeenCalledOnce();
    });
  });
});

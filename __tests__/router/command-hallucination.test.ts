/**
 * Command Hallucination Bug Tests (P0)
 *
 * Reproduces the bug where the bot hallucinates context instead of executing commands:
 * - /expense add 45.50 → bot returns full status report instead of logging expense
 * - Hello → bot searches for overdue tasks
 * - /expense list → bot generates generic welcome
 *
 * Root cause: unregistered slash commands fall through to the Claude classifier,
 * which misclassifies them and routes to secretary with massive context injection,
 * causing Claude to hallucinate briefings.
 *
 * Fix: unregistered slash commands should be rejected before reaching the classifier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patternMatch } from '../../src/router/classifier';
import { routeMessage, isSystemCommand } from '../../src/router/index';

// Mock the anthropic service
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

describe('BUG P0: Bot hallucinating context instead of executing commands', () => {
  beforeEach(() => {
    mockClassifyMessage.mockReset();
  });

  describe('Unregistered slash commands must NOT reach the classifier', () => {
    it('/expense add 45.50 should be rejected as unknown command, not classified', async () => {
      const result = await routeMessage('/expense add 45.50');
      // The classifier should NEVER be called for unregistered slash commands
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      // The route method should indicate this is an unknown command
      expect(result.method).toBe('unknown_command');
    });

    it('/expense list should be rejected as unknown command', async () => {
      const result = await routeMessage('/expense list');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(result.method).toBe('unknown_command');
    });

    it('/randomcommand should be rejected as unknown command', async () => {
      const result = await routeMessage('/randomcommand');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(result.method).toBe('unknown_command');
    });

    it('/unknownCmd with args should be rejected as unknown command', async () => {
      const result = await routeMessage('/unknownCmd some arguments here');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(result.method).toBe('unknown_command');
    });

    it('/expense should NOT match any domain pattern', () => {
      expect(patternMatch('/expense add 45.50')).toBeNull();
    });

    it('/expense should NOT be a system command', () => {
      expect(isSystemCommand('/expense add 45.50')).toBeNull();
    });
  });

  describe('Registered slash commands still work normally', () => {
    it('/todo should still route to secretary via pattern match', async () => {
      const result = await routeMessage('/todo buy milk');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('pattern');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('/gym should still route to triathlon via pattern match', async () => {
      const result = await routeMessage('/gym upper body');
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('pattern');
    });

    it('/video should still route to content via pattern match', async () => {
      const result = await routeMessage('/video idea about AI');
      expect(result.domain).toBe('content');
      expect(result.method).toBe('pattern');
    });
  });

  describe('Unregistered slash commands with active context must NOT be classified', () => {
    it('/expense with active secretary context should still be rejected', async () => {
      const context = { domain: 'secretary' as const, lastAssistantMessage: 'Here are your tasks for today.' };
      const result = await routeMessage('/expense add 45.50', context);
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(result.method).toBe('unknown_command');
    });

    it('/badcmd with active triathlon context should still be rejected', async () => {
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Great run!' };
      const result = await routeMessage('/badcmd test', context);
      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(result.method).toBe('unknown_command');
    });
  });

  describe('Non-slash messages still route normally through classifier', () => {
    it('natural language still goes to keyword/classifier as before', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.8 });
      const result = await routeMessage('hello, how are you?');
      // "hello" has no keyword match, so it should fall to classifier
      expect(result.method).toBe('classifier');
    });

    it('keyword-matched messages still work', async () => {
      const result = await routeMessage('I had a great workout today');
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('keyword');
    });
  });

  describe('Unknown command result has correct shape', () => {
    it('returns confidence 0 for unknown commands', async () => {
      const result = await routeMessage('/expense add 45.50');
      expect(result.confidence).toBe(0);
    });

    it('preserves the original message in strippedMessage', async () => {
      const result = await routeMessage('/expense add 45.50');
      expect(result.strippedMessage).toBe('/expense add 45.50');
    });
  });
});

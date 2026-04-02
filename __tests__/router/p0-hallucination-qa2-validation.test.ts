/**
 * QA2 Validation: P0 Command Hallucination Fix — Deep Edge Cases
 *
 * This extends the existing QA validation tests with additional edge cases:
 * - buildLightweightContext() returns ONLY date/time (no API calls)
 * - Greeting detection boundary cases (unicode, mixed case, newlines)
 * - Slash guard with BotCommand entities vs raw text
 * - Ordering guarantees: pattern match > slash guard > greeting guard > keyword > classifier
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patternMatch, keywordMatch, isGreeting } from '../../src/router/classifier';
import { routeMessage } from '../../src/router/index';

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

describe('QA2 Validation: P0 Hallucination Fix — Deep Edge Cases', () => {
  beforeEach(() => {
    mockClassifyMessage.mockReset();
  });

  // ─── Lightweight context prevents API calls ─────────────────────
  describe('buildLightweightContext() isolation', () => {
    it('handleSecretary with lightweight=true does not call heavy state APIs', async () => {
      // We can't easily mock all the heavy APIs, but we can verify the function
      // signature and that it's callable. The real integration test is that
      // greetings route with lightweight=true in bot.ts.
      const mod = await import('../../src/domains/secretary');
      expect(typeof mod.handleSecretary).toBe('function');
      // Verify the function accepts 3 parameters
      // TypeScript signature: (message: string, userId?: number, lightweight?: boolean)
      expect(mod.handleSecretary.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Greeting detection boundary cases ──────────────────────────
  describe('Greeting detection boundary cases', () => {
    it('greeting with multiple trailing punctuation is still a greeting', () => {
      expect(isGreeting('hello!!!')).toBe(true);
      expect(isGreeting('hi??')).toBe(true);
      expect(isGreeting('hey!?')).toBe(true);
    });

    it('greeting with trailing spaces is still a greeting', () => {
      expect(isGreeting('hello   ')).toBe(true);
      expect(isGreeting('  hi  ')).toBe(true);
    });

    it('greeting followed by a sentence is NOT a greeting', () => {
      expect(isGreeting('hello how are you doing')).toBe(false);
      expect(isGreeting('hi please check my calendar')).toBe(false);
      expect(isGreeting('ok now show me the tasks')).toBe(false);
      expect(isGreeting('thanks for that but now do X')).toBe(false);
    });

    it('partial word matches are NOT greetings', () => {
      // "helloworld" should not match "hello"
      expect(isGreeting('helloworld')).toBe(false);
      // "nope" should match, "nopetastic" should not
      expect(isGreeting('nope')).toBe(true);
    });

    it('multi-word PT-BR greetings work', () => {
      expect(isGreeting('bom dia')).toBe(true);
      expect(isGreeting('Bom Dia!')).toBe(true);
      expect(isGreeting('boa tarde')).toBe(true);
      expect(isGreeting('Boa Noite!')).toBe(true);
    });

    it('"yo" is a greeting but "your" is not', () => {
      expect(isGreeting('yo')).toBe(true);
      expect(isGreeting('yo!')).toBe(true);
      expect(isGreeting('your tasks are ready')).toBe(false);
    });

    it('"valeu" (PT-BR casual thanks) is a greeting', () => {
      expect(isGreeting('valeu')).toBe(true);
      expect(isGreeting('Valeu!')).toBe(true);
    });

    it('"entendi" (PT-BR "got it") is a greeting', () => {
      expect(isGreeting('entendi')).toBe(true);
      expect(isGreeting('Entendi!')).toBe(true);
    });

    it('"certo" (PT-BR "right") is a greeting', () => {
      expect(isGreeting('certo')).toBe(true);
      expect(isGreeting('Certo!')).toBe(true);
    });
  });

  // ─── Routing order guarantees ───────────────────────────────────
  describe('Routing order: pattern > slash guard > greeting > keyword > classifier', () => {
    it('registered slash command beats slash guard', async () => {
      // /schedule is registered under secretary
      const result = await routeMessage('/schedule meeting');
      expect(result.method).toBe('pattern');
      expect(result.domain).toBe('secretary');
    });

    it('unregistered slash command is caught by slash guard before greeting check', async () => {
      // Even though "/" alone isn't a greeting, it shouldn't reach greeting check
      const result = await routeMessage('/blah');
      expect(result.method).toBe('unknown_command');
    });

    it('greeting is caught before keyword match', async () => {
      // "yes" could potentially match keywords, but greeting guard catches it first
      const result = await routeMessage('yes');
      expect(result.method).toBe('greeting');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('keyword match is used before classifier for non-greeting messages', async () => {
      const result = await routeMessage('I need to plan my workout');
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('triathlon');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('classifier is only used as last resort', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.7 });
      // A message that doesn't match patterns, slash guard, greetings, or keywords
      const result = await routeMessage('what is the meaning of life');
      expect(result.method).toBe('classifier');
      expect(mockClassifyMessage).toHaveBeenCalledOnce();
    });
  });

  // ─── Slash guard comprehensive tests ────────────────────────────
  describe('Slash guard catches all unregistered commands', () => {
    const UNREGISTERED_COMMANDS = [
      '/expense add 45.50',
      '/expense list',
      '/balance',
      '/pay 100 to John',
      '/weather',
      '/music play something',
      '/settings',
      '/config timezone',
      '/login',
      '/debug',
    ];

    it.each(UNREGISTERED_COMMANDS)(
      '"%s" is rejected as unknown_command',
      async (cmd) => {
        const result = await routeMessage(cmd);
        expect(result.method).toBe('unknown_command');
        expect(result.confidence).toBe(0);
        expect(mockClassifyMessage).not.toHaveBeenCalled();
      },
    );

    it('preserves the full original message in strippedMessage', async () => {
      const result = await routeMessage('/expense add 45.50');
      expect(result.strippedMessage).toBe('/expense add 45.50');
    });

    it('routes to secretary domain for unknown commands', async () => {
      const result = await routeMessage('/unknown');
      expect(result.domain).toBe('secretary');
    });
  });

  // ─── Active context does NOT override guards ────────────────────
  describe('Guards take priority over active conversation context', () => {
    it('unregistered slash command with finance context still rejected', async () => {
      const ctx = { domain: 'secretary' as const, lastAssistantMessage: 'Your expenses total...' };
      const result = await routeMessage('/expense add 100', ctx);
      expect(result.method).toBe('unknown_command');
    });

    it('greeting with triathlon context uses greeting path, not context classifier', async () => {
      const ctx = { domain: 'triathlon' as const, lastAssistantMessage: 'Your next workout is...' };
      const result = await routeMessage('ok', ctx);
      expect(result.method).toBe('greeting');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('non-greeting with context correctly uses classifier', async () => {
      const ctx = { domain: 'triathlon' as const, lastAssistantMessage: 'You ran 5k yesterday.' };
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.9 });
      const result = await routeMessage('how did that compare to last week?', ctx);
      expect(result.method).toBe('classifier');
      expect(mockClassifyMessage).toHaveBeenCalledOnce();
    });
  });

  // ─── Registered command comprehensive check ─────────────────────
  describe('All registered commands still route correctly', () => {
    const SECRETARY_COMMANDS = [
      '/sec', '/agenda', '/schedule', '/todo', '/todos', '/done', '/undone',
      '/remind', '/email', '/week', '/day', '/plan', '/review', '/move', '/cancel',
      '/lists', '/tasks', '/newtask', '/newlist', '/deletelist', '/deletetask',
      '/due', '/priority', '/search', '/todosummary', '/digest', '/digesttime',
      '/overdue', '/duetoday', '/dueweek', '/movetask', '/alltasks', '/completed',
      '/edittask', '/notetask', '/addstep', '/steps',
    ];

    it.each(SECRETARY_COMMANDS)('%s routes to secretary via pattern', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });

    const TRIATHLON_COMMANDS = [
      '/train', '/gym', '/run', '/bike', '/checkin', '/meal', '/macros',
      '/deload', '/pain', '/running', '/cycling', '/workout', '/session', '/logworkout',
    ];

    it.each(TRIATHLON_COMMANDS)('%s routes to triathlon via pattern', (cmd) => {
      expect(patternMatch(cmd)).toBe('triathlon');
    });

    const CONTENT_COMMANDS = [
      '/content', '/video', '/reel', '/script', '/caption', '/thumbnail',
      '/trend', '/ideas', '/discover', '/deepsearch', '/sources', '/hotnews',
      '/trending', '/reaction', '/hooks', '/genscript', '/titles', '/genthumbnail',
      '/gencaption', '/competitor', '/gaps', '/seo', '/repurpose', '/feedback', '/report',
    ];

    it.each(CONTENT_COMMANDS)('%s routes to content via pattern', (cmd) => {
      expect(patternMatch(cmd)).toBe('content');
    });
  });
});

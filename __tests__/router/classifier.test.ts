/**
 * Router Classifier Tests
 *
 * Tests the three-tier classification system:
 * - Tier 1: Pattern matching (commands)
 * - Tier 2: Keyword matching (natural language)
 * - Tier 3: Claude AI classification (mocked)
 *
 * Plus full integration tests for routeMessage()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { patternMatch, keywordMatch, classifyWithClaude } from '../../src/router/classifier';
import { routeMessage, isSystemCommand } from '../../src/router/index';

// ═══════════════════════════════════════════════════════════════════
// TIER 1: PATTERN MATCHING (Commands)
// ═══════════════════════════════════════════════════════════════════

describe('patternMatch — Tier 1 Command Routing', () => {

  describe('Secretary commands', () => {
    const secretaryCommands = [
      '/todo buy milk',
      '/todos',
      '/tasks',
      '/tasks Groceries',
      '/newtask Buy coffee',
      '/newtask Work | Deploy hotfix',
      '/done finish report',
      '/undone that task',
      '/day',
      '/week',
      '/lists',
      '/alltasks',
      '/overdue',
      '/duetoday',
      '/dueweek',
      '/edittask old | new',
      '/notetask task | note here',
      '/movetask task | list',
      '/addstep task | step',
      '/steps task',
      '/newlist Shopping',
      '/deletelist Old List',
      '/deletetask old task',
      '/due task | tomorrow',
      '/priority task | high',
      '/search keyword',
      '/todosummary',
      '/completed',
      '/remind me at 5pm',
      '/email send to john',
      '/schedule meeting',
      '/agenda today',
      '/plan the week',
      '/review tasks',
      '/move meeting',
      '/cancel appointment',
      '/digest',
      '/digesttime',
      '/sec help me',
    ];

    it.each(secretaryCommands)('"%s" → secretary', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });
  });

  describe('Triathlon commands', () => {
    const triathlonCommands = [
      '/train upper body',
      '/gym',
      '/run',
      '/bike',
      '/checkin',
      '/meal',
      '/macros',
      '/deload',
      '/pain left knee',
      '/running',
      '/cycling',
    ];

    it.each(triathlonCommands)('"%s" → triathlon', (cmd) => {
      expect(patternMatch(cmd)).toBe('triathlon');
    });
  });

  describe('Content commands', () => {
    const contentCommands = [
      '/content ideas',
      '/video idea about AI',
      '/reel concept',
      '/script topic here',
      '/caption for post',
      '/thumbnail idea',
      '/trend check',
      '/ideas saved',
      '/discover',
      '/deepsearch topic',
      '/sources AI news',
      '/hotnews',
      '/trending fitness',
      '/reaction topic',
      '/hooks for video',
      '/genscript about crypto',
      '/titles test',
      '/genthumbnail title',
      '/gencaption post',
      '/competitor @channel',
      '/gaps fitness',
      '/seo keywords',
      '/repurpose',
      '/feedback url 1000 45% 100 20 5',
      '/report week',
    ];

    it.each(contentCommands)('"%s" → content', (cmd) => {
      expect(patternMatch(cmd)).toBe('content');
    });
  });

  describe('Non-matching messages', () => {
    const noMatch = [
      'hello there',
      'what time is it?',
      'obrigado!',
      '/start',
      '/help',
      '/status',
      '/clear all',
      'just a random message',
      '',
      '  ',
    ];

    it.each(noMatch)('"%s" → null', (msg) => {
      expect(patternMatch(msg)).toBeNull();
    });
  });

  it('handles commands with extra whitespace', () => {
    expect(patternMatch('  /todo buy milk  ')).toBe('secretary');
    expect(patternMatch('\n/gym\n')).toBe('triathlon');
  });

  it('is case insensitive', () => {
    expect(patternMatch('/TODO buy milk')).toBe('secretary');
    expect(patternMatch('/GYM')).toBe('triathlon');
    expect(patternMatch('/SCRIPT topic')).toBe('content');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TIER 2: KEYWORD MATCHING (Natural Language)
// ═══════════════════════════════════════════════════════════════════

describe('keywordMatch — Tier 2 NL Routing', () => {

  describe('Triathlon keywords (EN)', () => {
    const triathlonMessages = [
      'I had a great workout today',
      'what should my gym session look like?',
      'how much protein should I eat?',
      'my training plan for next week',
      'I need a deload week',
      'squat form check',
      'deadlift progression',
      'bench press plateau',
      'my heart rate was high',
      'tempo run tomorrow',
      'what intervals should I do?',
      'feeling some soreness',
      'is this a recovery day?',
      'help with hypertrophy',
      'lower body day',
      'upper body focus',
      'coach report please',
      'I need a carnivore meal plan',
      'endurance is improving',
      'how is my recovery today?',
      'what does my readiness look like?',
      'check my body battery',
    ];

    it.each(triathlonMessages)('"%s" → triathlon', (msg) => {
      expect(keywordMatch(msg)).toBe('triathlon');
    });
  });

  describe('Triathlon keywords (PT-BR)', () => {
    const triathlonPtBr = [
      'como foi meu treino',
      'qual corrida amanhã?',
      'vou fazer pedalada',
      'musculação pesada hoje',
      'quanta proteína preciso?',
      'dieta carnívora funciona',
      'agachamento livre',
      'supino reto',
      'levantamento terra',
      'frequência cardíaca alta',
      'dor muscular forte',
      'preciso de recuperação',
      'dia de academia',
    ];

    it.each(triathlonPtBr)('"%s" → triathlon', (msg) => {
      expect(keywordMatch(msg)).toBe('triathlon');
    });
  });

  describe('Content keywords (EN)', () => {
    const contentMessages = [
      'I need a youtube video idea',
      'how to grow on instagram',
      'make a reel about this',
      'thumbnail design concept',
      'write a video script',
      'content strategy for Q2',
      'good caption for this post',
      'how many subscribers did I get?',
      'the audience wants more',
      'this could go viral',
      'need a better hook',
      'strong CTA at the end',
      'boost engagement rate',
      'hashtag research for my post',
      'write a script about tariffs',
      'I need title ideas for this video',
    ];

    it.each(contentMessages)('"%s" → content', (msg) => {
      expect(keywordMatch(msg)).toBe('content');
    });
  });

  describe('Content keywords (PT-BR)', () => {
    const contentPtBr = [
      'ideia de vídeo novo',
      'preciso de um roteiro',
      'legenda para o post',
      'quantos inscritos tenho?',
      'miniatura do vídeo',
      'conteúdo sobre fitness',
      'ideia de conteúdo',
      'calendário de conteúdo',
      'melhorar engajamento',
    ];

    it.each(contentPtBr)('"%s" → content', (msg) => {
      expect(keywordMatch(msg)).toBe('content');
    });
  });

  describe('Secretary keywords (EN)', () => {
    const secretaryMessages = [
      'what are my tasks for today?',
      'add this to my to-do list',
      'set a reminder for 3pm',
      'what\'s on my calendar?',
      'schedule a meeting tomorrow',
      'any appointments this week?',
      'check my emails',
      'how many unread in my inbox',
      'what\'s overdue?',
      'due today stuff',
      'mark as done',
      'pending items',
      'high priority tasks',
      'deadline is friday',
    ];

    it.each(secretaryMessages)('"%s" → secretary', (msg) => {
      expect(keywordMatch(msg)).toBe('secretary');
    });
  });

  describe('Finance keywords (EN)', () => {
    const financeMessages = [
      'save this receipt',
      'archive this invoice',
      'what merchant was this?',
    ];

    it.each(financeMessages)('"%s" → finance', (msg) => {
      expect(keywordMatch(msg)).toBe('finance');
    });
  });

  describe('Secretary keywords (PT-BR)', () => {
    const secretaryPtBr = [
      'quais são minhas tarefas?',
      'cria um lembrete',
      'minha agenda de amanhã',
      'reuniões da semana',
      'compromissos de hoje',
      'ver meus e-mails',
      'caixa de entrada',
      'atrasados da semana',
      'pra hoje tem o quê?',
      'pendentes no trabalho',
      'prioridade alta',
      'qual o prazo?',
    ];

    it.each(secretaryPtBr)('"%s" → secretary', (msg) => {
      expect(keywordMatch(msg)).toBe('secretary');
    });
  });

  describe('Specificity: triathlon wins over secretary', () => {
    it('workout-related messages go to triathlon, not secretary', () => {
      expect(keywordMatch('I need to plan my workout')).toBe('triathlon');
      expect(keywordMatch('gym session at 6am')).toBe('triathlon');
    });
  });

  describe('Specificity: content wins over secretary', () => {
    it('content-related messages go to content, not secretary', () => {
      expect(keywordMatch('plan my youtube content')).toBe('content');
      expect(keywordMatch('schedule a reel')).toBe('content');
    });

    it('explicit script-writing intents beat training-topic keywords', () => {
      expect(keywordMatch('Write a short script about recovery after hard intervals')).toBe('content');
      expect(keywordMatch('Escreve um roteiro curto sobre recuperação após intervalos fortes')).toBe('content');
    });
  });

  describe('No match → null', () => {
    const noMatch = [
      'hello',
      'good morning',
      'thanks!',
      'what do you think?',
      'tell me a joke',
      'who are you?',
      'bom dia',
    ];

    it.each(noMatch)('"%s" → null', (msg) => {
      expect(keywordMatch(msg)).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// TIER 3: CLAUDE CLASSIFICATION (Mocked API)
// ═══════════════════════════════════════════════════════════════════

// We need to mock the anthropic service module to control what classifyMessage returns
vi.mock('../../src/services/anthropic', () => ({
  classifyMessage: vi.fn(),
}));

// Also mock the logger so tests don't produce output
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

describe('classifyWithClaude — Tier 3 AI Classification', () => {
  beforeEach(() => {
    mockClassifyMessage.mockReset();
  });

  it('returns the domain and confidence from the Claude classifier', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.95 });

    const result = await classifyWithClaude('I ran 10k today');
    expect(result).toEqual({ domain: 'triathlon', confidence: 0.95 });
  });

  it('passes activeContext to the classifier when provided', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.85 });

    const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Great run!' };
    await classifyWithClaude('move it to wednesday', context);

    // April 9 2026: classifyMessage gained a 3rd optional `userId`
    // parameter. Callers that don't provide one (like this test)
    // pass undefined through, so the assertion must include it.
    expect(mockClassifyMessage).toHaveBeenCalledWith('move it to wednesday', context, undefined);
  });

  it('passes undefined context when null is provided', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.7 });

    await classifyWithClaude('hello there', null);
    // Third arg is the new optional `userId` — still undefined here
    // because this test doesn't exercise the user-attribution path.
    expect(mockClassifyMessage).toHaveBeenCalledWith('hello there', undefined, undefined);
  });

  it('handles low confidence (falls back to secretary in classifyMessage)', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.3 });

    const result = await classifyWithClaude('something ambiguous');
    expect(result.domain).toBe('secretary');
    expect(result.confidence).toBe(0.3);
  });

  it('preserves active context on low-confidence classifier replies', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.22 });

    const result = await classifyWithClaude(
      'make it shorter',
      { domain: 'content', lastAssistantMessage: 'Here are 10 video ideas.' },
    );

    expect(result).toEqual({ domain: 'content', confidence: 0.51 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// SYSTEM COMMAND DETECTION
// ═══════════════════════════════════════════════════════════════════

describe('isSystemCommand', () => {
  it('recognizes /help', () => {
    expect(isSystemCommand('/help')).toBe('/help');
  });

  it('recognizes /status', () => {
    expect(isSystemCommand('/status')).toBe('/status');
  });

  it('recognizes /clear with arguments', () => {
    expect(isSystemCommand('/clear all')).toBe('/clear');
  });

  it('recognizes /start', () => {
    expect(isSystemCommand('/start')).toBe('/start');
  });

  it('recognizes content-agent system commands', () => {
    expect(isSystemCommand('/discover topic')).toBe('/discover');
    expect(isSystemCommand('/deepsearch AI trends')).toBe('/deepsearch');
    expect(isSystemCommand('/hotnews')).toBe('/hotnews');
    expect(isSystemCommand('/trending fitness')).toBe('/trending');
  });

  it('is case insensitive', () => {
    expect(isSystemCommand('/HELP')).toBe('/help');
    expect(isSystemCommand('/Status')).toBe('/status');
  });

  it('handles whitespace', () => {
    expect(isSystemCommand('  /help  ')).toBe('/help');
  });

  it('returns null for non-system commands', () => {
    expect(isSystemCommand('/todo buy milk')).toBeNull();
    expect(isSystemCommand('/gym')).toBeNull();
    expect(isSystemCommand('hello')).toBeNull();
    expect(isSystemCommand('')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// FULL ROUTER INTEGRATION (routeMessage)
// ═══════════════════════════════════════════════════════════════════

describe('routeMessage — Three-Tier Routing Integration', () => {
  beforeEach(() => {
    mockClassifyMessage.mockReset();
  });

  describe('Tier 1 always wins (commands bypass everything)', () => {
    it('/todo routes to secretary with method=pattern, confidence=1.0', async () => {
      const result = await routeMessage('/todo buy milk');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('pattern');
      expect(result.confidence).toBe(1.0);
      // classifyMessage should NOT be called
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('/gym routes to triathlon with stripped message', async () => {
      const result = await routeMessage('/gym upper body');
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('pattern');
      expect(result.strippedMessage).toBe('upper body');
    });

    it('/video routes to content', async () => {
      const result = await routeMessage('/video idea about AI');
      expect(result.domain).toBe('content');
      expect(result.method).toBe('pattern');
    });

    it('commands win even with active context', async () => {
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Hi' };
      const result = await routeMessage('/todo buy milk', context);
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('pattern');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });
  });

  describe('Active context: keyword matching runs first (token-zero optimization)', () => {
    it('with active context, truly ambiguous message goes to classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.88 });
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Your 5K time was great!' };

      // "move it to wednesday" has no strong keyword match → goes to classifier
      const result = await routeMessage('move it to wednesday', context);
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('classifier');
      expect(result.confidence).toBe(0.88);
    });

    it('keyword-heavy message matches keyword FIRST even with active context (token-zero)', async () => {
      // Token-zero: "schedule a meeting" keyword-matches to secretary.
      // With the new routing, keywords always run before classifier to save tokens.
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.75 });
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Rest day today.' };

      const result = await routeMessage('schedule a meeting', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
    });

    it('short follow-up phrasing prefers active context over keyword shortcuts', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.72 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'Here is your draft script.' };

      const result = await routeMessage('make it shorter', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('content');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('portuguese content rewrite follow-up stays in content without asking secretary-style clarifications', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.95 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'Aqui está o teu roteiro.' };

      const result = await routeMessage('Escreve uma versao mais curta disto em portugues europeu', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('content');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('english translation/refinement follow-up also stays in active content context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.91 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'Here is your script.' };

      const result = await routeMessage('rewrite this in Portuguese and make it shorter', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('content');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });
  });

  describe('Tier 2 keyword matching (no active context)', () => {
    it('workout routes to triathlon via keyword', async () => {
      const result = await routeMessage('I had a great workout today');
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('keyword');
      expect(result.confidence).toBe(0.9);
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('youtube routes to content via keyword', async () => {
      const result = await routeMessage('I need a youtube video idea');
      expect(result.domain).toBe('content');
      expect(result.method).toBe('keyword');
    });

    it('explicit script requests stay in content even with triathlon vocabulary', async () => {
      const result = await routeMessage('Write a short script about recovery after hard intervals');
      expect(result.domain).toBe('content');
      expect(result.method).toBe('keyword');
    });

    it('tasks routes to secretary via keyword', async () => {
      const result = await routeMessage('what are my tasks for today?');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('keyword');
    });
  });

  describe('Tier 3 Claude fallback (no match, no context)', () => {
    it('ambiguous message falls through to Claude classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.65 });

      const result = await routeMessage('hello, how are you?');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('classifier');
      expect(result.confidence).toBe(0.65);
      expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
    });

    it('completely ambiguous message still returns a result', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.3 });

      const result = await routeMessage('ok');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('classifier');
    });
  });

  describe('Message stripping', () => {
    it('strips command prefix from pattern-matched messages', async () => {
      const result = await routeMessage('/todo buy milk and eggs');
      expect(result.strippedMessage).toBe('buy milk and eggs');
    });

    it('keeps full message for command-only messages', async () => {
      const result = await routeMessage('/todos');
      expect(result.strippedMessage).toBe('/todos');
    });

    it('keeps full message for keyword and classifier routes', async () => {
      const result = await routeMessage('I had a great workout today');
      expect(result.strippedMessage).toBe('I had a great workout today');
    });
  });

  describe('Edge cases', () => {
    it('empty string falls through to classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0 });

      const result = await routeMessage('');
      expect(result.method).toBe('classifier');
    });

    it('whitespace-only falls through to classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0 });

      const result = await routeMessage('   ');
      expect(result.method).toBe('classifier');
    });
  });
});

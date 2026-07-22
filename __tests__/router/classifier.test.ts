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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
      'como está o meu plano da semana?',
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
      'help me script an intro about training consistency',
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
      'what content is already ready on my desk?',
      'what should i publish next?',
      'what performed best?',
      'what are we learning this week?',
      'how should i schedule filming around my week?',
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
      'remind me to pay DARF tomorrow',
      'add a task to send the invoices to my accountant on Friday morning',
      'what\'s on my calendar?',
      'schedule a meeting tomorrow',
      'schedule a filming block for thursday at 3pm',
      'move the recording block to friday morning',
      'any appointments this week?',
      'check my emails',
      'how many unread in my inbox',
      'what\'s overdue?',
      'due today stuff',
      'mark as done',
      'pending items',
      'high priority tasks',
      'deadline is friday',
      'delete the task to review the training deck',
      'schedule a focus block for tomorrow morning',
      'send this invoice to my accountant on Friday morning',
      'schedule time to review my subscriptions next week',
      'schedule the sponsor post for friday morning',
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
      'what bills are still missing this month?',
      'what subscriptions renew soon?',
      "what's my budget remaining this month?",
      'what tax is due next?',
      'what should i send to my accountant?',
      'how much did i spend this month?',
      'what invoices did i file this month?',
    ];

    it.each(financeMessages)('"%s" → finance', (msg) => {
      expect(keywordMatch(msg)).toBe('finance');
    });
  });

  describe('Secretary keywords (PT-BR)', () => {
    const secretaryPtBr = [
      'quais são minhas tarefas?',
      'cria um lembrete',
      'me lembra de pagar o darf amanhã',
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
      'apaga a tarefa de ligar para a Amanda',
      'cria uma tarefa para amanhã às 15h de ligar para a Amanda',
      'agenda um bloco de gravação para quinta às 15h',
      'move o bloco de edição para sexta de manhã',
      'envia esta fatura ao meu contabilista na sexta de manhã',
      'agenda tempo para rever as minhas assinaturas na próxima semana',
      'agenda a publicação patrocinada para sexta de manhã',
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

    it('creator planning prompts stay in content even with training vocabulary', () => {
      expect(keywordMatch('me dá 3 ideias de conteúdo para um vídeo sobre recuperação depois do treino')).toBe('content');
      expect(keywordMatch('me dá 3 títulos melhores para um vídeo sobre dieta carnívora e performance')).toBe('content');
      expect(keywordMatch('me ajuda a planejar uma gravação em um dia que eu esteja com mais energia')).toBe('content');
      expect(keywordMatch('me dá feedback neste roteiro: treino, dieta, sono e consistência')).toBe('content');
      expect(keywordMatch('give me 3 content ideas for a video about recovery after training')).toBe('content');
      expect(keywordMatch('give me 3 better titles for a video about carnivore diet and performance')).toBe('content');
      expect(keywordMatch('organize my content ideas by priority')).toBe('content');
    });
  });

  describe('Specificity: cooking wins over triathlon', () => {
    it('meal prompts stay in cooking even with training context', () => {
      expect(keywordMatch('I need a carnivore meal plan')).toBe('cooking');
      expect(keywordMatch('give me 3 quick carnivore breakfast ideas')).toBe('cooking');
      expect(keywordMatch('give me 3 macro-friendly dinner ideas')).toBe('cooking');
      expect(keywordMatch('me passa um café da manhã rico em proteína para amanhã')).toBe('cooking');
      expect(keywordMatch('me passa um plano alimentar rico em proteína para esta semana')).toBe('cooking');
      expect(keywordMatch('o que eu devo comer antes de um treino forte amanhã cedo?')).toBe('cooking');
      expect(keywordMatch('me dá uma ideia de almoço prático para recuperação')).toBe('cooking');
      expect(keywordMatch('cria uma lista de compras para 3 almoços ricos em proteína')).toBe('cooking');
      expect(keywordMatch('quero um snack para recuperação depois do treino')).toBe('cooking');
      expect(keywordMatch('what should I eat before a hard workout tomorrow morning?')).toBe('cooking');
      expect(keywordMatch('how should i fuel after a long ride?')).toBe('cooking');
      expect(keywordMatch('how should I fuel on travel days?')).toBe('cooking');
      expect(keywordMatch('cria 3 ideias de snacks para antes do treino')).toBe('cooking');
      expect(keywordMatch('adapt my meals for a lighter recovery day')).toBe('cooking');
      expect(keywordMatch('build me a Monday to Sunday menu focused on performance')).toBe('cooking');
      expect(keywordMatch('como conservo cenoura ralada na geladeira por vários dias?')).toBe('cooking');
      expect(keywordMatch('Olá eu gostaria de ralar uma cenoura como que conservo ela na geladeira por vários dias')).toBe('cooking');
      expect(keywordMatch('how do I store grated carrot in the fridge for a few days?')).toBe('cooking');
    });
  });

  describe('Specificity: training coaching wins over generic nutrition nouns', () => {
    it('coaching-style macro and supplement targets stay in triathlon', () => {
      expect(keywordMatch('how much protein should I eat?')).toBe('triathlon');
      expect(keywordMatch('help me set my macros for a cut while keeping strength')).toBe('triathlon');
      expect(keywordMatch('review my supplements for marathon prep')).toBe('triathlon');
      expect(keywordMatch('qual deve ser minha meta de proteína diária nesta fase?')).toBe('triathlon');
      expect(keywordMatch('ajusta meus macros para ganhar massa sem piorar a corrida')).toBe('triathlon');
      expect(keywordMatch('dieta carnívora funciona para o meu treino atual?')).toBe('triathlon');
    });
  });

  describe('Specificity: finance wins over cooking', () => {
    it('expense bookkeeping prompts stay in finance even with meal words', () => {
      expect(keywordMatch('cria uma despesa manual de 28 euros para almoço de hoje')).toBe('finance');
      expect(keywordMatch('categoriza esta despesa de jantar de ontem')).toBe('finance');
      expect(keywordMatch('analisa este recibo de almoço e diz a categoria certa')).toBe('finance');
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
  LOGGER_REDACTION_PATHS: [],
}));

// M13: the low-confidence pin's durable-backed active-domain read. Mocked so
// this suite never touches the database module.
const mockGetActiveChatDomain = vi.hoisted(
  () => vi.fn((_userId: number, _now?: number, _tenantId?: number): string | null => null),
);
vi.mock('../../src/services/chat-conversation-state', async () => ({
  ...(await vi.importActual('../../src/services/chat-conversation-state')),
  getActiveChatDomain: (userId: number, now?: number, tenantId?: number) =>
    mockGetActiveChatDomain(userId, now, tenantId),
}));

import { classifyMessage } from '../../src/services/anthropic';

const mockClassifyMessage = vi.mocked(classifyMessage);

describe('classifyWithClaude — Tier 3 AI Classification', () => {
  // M15: this suite pins the LEGACY (flag-off) classify behavior — verbatim
  // classify input, no candidate shortlist, no skill field. Force the flag
  // off so the pins stay deterministic when the environment runs with
  // AI_CLASSIFY_MANIFEST_PROMPT=true (flag-on behavior is covered by
  // classifier-manifest-skill-flag.test.ts).
  let savedManifestPromptFlag: string | undefined;
  beforeEach(() => {
    savedManifestPromptFlag = process.env.AI_CLASSIFY_MANIFEST_PROMPT;
    delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
    mockClassifyMessage.mockReset();
    mockGetActiveChatDomain.mockReset();
    mockGetActiveChatDomain.mockReturnValue(null);
  });

  afterEach(() => {
    if (savedManifestPromptFlag === undefined) delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
    else process.env.AI_CLASSIFY_MANIFEST_PROMPT = savedManifestPromptFlag;
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

    // April 29 2026: classifyMessage carries optional userId + tenantId
    // for usage attribution. Callers that don't provide them pass
    // undefined through, so the assertion must include both.
    expect(mockClassifyMessage).toHaveBeenCalledWith('move it to wednesday', context, undefined, undefined);
  });

  it('passes undefined context when null is provided', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.7 });

    await classifyWithClaude('hello there', null);
    // Third/fourth args are optional userId + tenantId — still undefined
    // here because this test doesn't exercise attribution.
    expect(mockClassifyMessage).toHaveBeenCalledWith('hello there', undefined, undefined, undefined);
  });

  it('keeps the classifier-selected domain on low confidence when no active context exists', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.3 });

    const result = await classifyWithClaude('something ambiguous');
    expect(result.domain).toBe('content');
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

  it('M13: pins to the durable active domain on low confidence when no in-arg context exists', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.3 });
    mockGetActiveChatDomain.mockReturnValue('content');

    const result = await classifyWithClaude('make it shorter', null, 42, 7);

    expect(mockGetActiveChatDomain).toHaveBeenCalledWith(42, expect.any(Number), 7);
    expect(result).toEqual({ domain: 'content', confidence: 0.51 });
  });

  it('M13: keeps the raw low-confidence result when the durable store has no fresh pin', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.3 });
    mockGetActiveChatDomain.mockReturnValue(null);

    const result = await classifyWithClaude('make it shorter', null, 42, 7);

    expect(result).toEqual({ domain: 'secretary', confidence: 0.3 });
  });

  it('M13: the explicit in-arg activeContext outranks the durable pin', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.22 });
    mockGetActiveChatDomain.mockReturnValue('finance');

    const result = await classifyWithClaude(
      'make it shorter',
      { domain: 'content', lastAssistantMessage: 'Here are 10 video ideas.' },
      42,
      7,
    );

    expect(result).toEqual({ domain: 'content', confidence: 0.51 });
    expect(mockGetActiveChatDomain).not.toHaveBeenCalled();
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

      // This follow-up has no strong domain refinements, so it still pays for classifier help.
      const result = await routeMessage('what do you think?', context);
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

    it('explicit cooking intent still wins over active triathlon context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.91 });
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Tomorrow is your hard workout day.' };

      const result = await routeMessage('what should I eat before a hard workout tomorrow morning?', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('cooking');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('storage-style cooking questions break out of an active secretary thread', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.91 });
      const context = { domain: 'secretary' as const, lastAssistantMessage: 'Here is your task summary.' };

      const result = await routeMessage('como conservo cenoura ralada na geladeira por vários dias?', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('cooking');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('generic Portuguese recipe requests route to cooking without model classification', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.91 });
      const context = { domain: 'secretary' as const, lastAssistantMessage: 'Here is your task summary.' };

      const result = await routeMessage('me indique uma receita de legumes assados para 3 pessoas', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('cooking');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('full polite Portuguese cooking phrasing still breaks out of an active secretary thread', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.91 });
      const context = { domain: 'secretary' as const, lastAssistantMessage: 'Here is your task summary.' };

      const result = await routeMessage('Olá eu gostaria de ralar uma cenoura como que conservo ela na geladeira por vários dias', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('cooking');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('explicit content planning intent still wins over active triathlon context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.91 });
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Your intervals are set for Wednesday.' };

      const result = await routeMessage('organize my content ideas by priority', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('content');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('explicit finance bookkeeping intent still wins over active cooking context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'cooking', confidence: 0.88 });
      const context = { domain: 'cooking' as const, lastAssistantMessage: 'Here is your dinner idea.' };

      const result = await routeMessage('categorize this dinner expense from yesterday', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('finance');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('strong secretary reminder intent overrides active finance context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'finance', confidence: 0.89 });
      const context = { domain: 'finance' as const, lastAssistantMessage: 'Your DARF is due next week.' };

      const result = await routeMessage('remind me to pay DARF tomorrow', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('strong secretary finance follow-through intent overrides active finance context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'finance', confidence: 0.89 });
      const context = { domain: 'finance' as const, lastAssistantMessage: 'You still need to send one invoice to your accountant.' };

      const result = await routeMessage('send this invoice to my accountant on Friday morning', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('strong secretary scheduling intent overrides active content context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.91 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'Thursday looks good for filming.' };

      const result = await routeMessage('schedule a filming block for Thursday at 3pm', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('strong secretary publishing scheduling intent overrides active content context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.91 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'This sponsor post should go out this week.' };

      const result = await routeMessage('schedule the sponsor post for friday morning', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('portuguese secretary scheduling intent also overrides active content context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.91 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'Quinta parece boa para gravar.' };

      const result = await routeMessage('agenda um bloco de gravação para quinta às 15h', context);
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
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

    it('finance categorization follow-up stays in active finance context without paying for classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.94 });
      const context = { domain: 'finance' as const, lastAssistantMessage: 'I found a receipt from your hosting bill.' };

      const result = await routeMessage('categorize this as software', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('finance');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('portuguese finance reclassification follow-up also stays in active finance context', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.94 });
      const context = { domain: 'finance' as const, lastAssistantMessage: 'Esse recibo parece despesa de viagem.' };

      const result = await routeMessage('marca isso como software da empresa', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('finance');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('secretary sequencing follow-ups stay in secretary context without invoking the classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.91 });
      const context = { domain: 'secretary' as const, lastAssistantMessage: 'Your top priority is the filming blocker at 14:00.' };

      const result = await routeMessage('what should I do first today?', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('triathlon workout refinements stay in triathlon context without invoking the classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.91 });
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Tomorrow is your interval session.' };

      const result = await routeMessage('make it easier and move it to tomorrow afternoon', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('triathlon');
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

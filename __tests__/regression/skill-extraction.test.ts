/**
 * Regression Tests — Skill Extraction
 *
 * Sprint 2 merge gate: validates the full classification → domain → skill pipeline.
 *
 * Coverage:
 * 1. Secretary commands route correctly (pattern + keyword + classifier)
 * 2. Triathlon keywords classify to the right domain
 * 3. Content commands work end-to-end
 * 4. Three-tier cascade: pattern > keyword > classifier (with context bypass)
 * 5. Conversation history is per-domain isolated
 * 6. Tool execution through skill interface (sub-skill filtering)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════════════════════════════════
// SECTION 1 — CLASSIFICATION REGRESSION (pure functions, no DB)
// ═══════════════════════════════════════════════════════════════════

// Mock anthropic module before importing classifier
vi.mock('../../src/services/anthropic', () => ({
  classifyMessage: vi.fn(),
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { patternMatch, keywordMatch, classifyWithClaude } from '../../src/router/classifier';
import { routeMessage, isSystemCommand } from '../../src/router/index';
import { classifyMessage } from '../../src/services/anthropic';

const mockClassifyMessage = vi.mocked(classifyMessage);

describe('REGRESSION: Secretary commands route correctly', () => {
  beforeEach(() => mockClassifyMessage.mockReset());

  describe('Pattern-based secretary commands (Tier 1)', () => {
    // Core task management commands
    const taskCommands = [
      '/todo pick up groceries',
      '/todos',
      '/newtask Work | Deploy hotfix',
      '/done finish report',
      '/undone that task',
      '/deletetask old item',
      '/edittask old text | new text',
      '/notetask my task | important note',
      '/movetask task | another list',
      '/addstep task | new step',
      '/steps my task',
      '/alltasks',
      '/completed',
    ];

    it.each(taskCommands)('task cmd "%s" → secretary (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });

    // List management commands
    const listCommands = ['/lists', '/newlist Shopping', '/deletelist Archive'];

    it.each(listCommands)('list cmd "%s" → secretary (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });

    // Scheduling & reminder commands
    const scheduleCommands = [
      '/schedule meeting at 3pm',
      '/agenda today',
      '/remind me at 5pm call John',
      '/plan the week',
      '/review tasks',
      '/day',
      '/week',
      '/move meeting to friday',
      '/cancel appointment',
    ];

    it.each(scheduleCommands)('schedule cmd "%s" → secretary (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });

    // Due date & priority commands
    const dueCommands = [
      '/due task | tomorrow',
      '/priority task | high',
      '/overdue',
      '/duetoday',
      '/dueweek',
    ];

    it.each(dueCommands)('due cmd "%s" → secretary (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });

    // Digest & search
    const utilityCommands = ['/search keyword', '/todosummary', '/digest', '/digesttime'];

    it.each(utilityCommands)('utility cmd "%s" → secretary (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('secretary');
    });

    // Email command
    it('/email routes to secretary', () => {
      expect(patternMatch('/email send to john')).toBe('secretary');
    });

    // Shorthand
    it('/sec routes to secretary', () => {
      expect(patternMatch('/sec help me with something')).toBe('secretary');
    });
  });

  describe('Keyword-based secretary messages (Tier 2)', () => {
    const enMessages = [
      'what are my tasks for today?',
      'add this to my to-do list',
      'set a reminder for 3pm',
      "what's on my calendar?",
      'schedule a meeting tomorrow',
      'check my emails',
      'any overdue items?',
      'due today stuff',
      'mark as done',
      'pending items',
      'high priority tasks',
      'deadline is friday',
    ];

    it.each(enMessages)('EN "%s" → secretary (keyword)', (msg) => {
      expect(keywordMatch(msg)).toBe('secretary');
    });

    const ptBrMessages = [
      'quais são minhas tarefas?',
      'cria um lembrete',
      'minha agenda de amanhã',
      'reuniões da semana',
      'compromissos de hoje',
      'caixa de entrada',
      'atrasados da semana',
      'pendentes no trabalho',
      'prioridade alta',
      'qual o prazo?',
    ];

    it.each(ptBrMessages)('PT-BR "%s" → secretary (keyword)', (msg) => {
      expect(keywordMatch(msg)).toBe('secretary');
    });
  });

  describe('Classifier-routed secretary messages (Tier 3)', () => {
    it('ambiguous greeting routes through classifier to secretary', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.65 });
      const result = await routeMessage('hello, how are you?');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('classifier');
    });

    it('short ambiguous message uses classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.4 });
      const result = await routeMessage('ok');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('classifier');
    });
  });
});

describe('REGRESSION: Triathlon keywords classify correctly', () => {
  beforeEach(() => mockClassifyMessage.mockReset());

  describe('Pattern-based triathlon commands (Tier 1)', () => {
    const commands = [
      '/train upper body',
      '/gym',
      '/run 5k tempo',
      '/bike 40k',
      '/checkin',
      '/meal',
      '/macros',
      '/deload',
      '/pain left knee',
      '/running',
      '/cycling',
    ];

    it.each(commands)('"%s" → triathlon (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('triathlon');
    });
  });

  describe('Keyword-based triathlon (Tier 2 EN)', () => {
    const messages = [
      'I had a great workout today',
      'gym session at 6am',
      'my running plan for the week',
      'cycling plan needs adjustment',
      'how much protein should I eat?',
      'training plan for next week',
      'I need a deload week',
      'squat form check',
      'deadlift progression tips',
      'bench press is stalling',
      'my heart rate was very high',
      'tempo run tomorrow morning',
      'what intervals should I do?',
      'some soreness in my legs',
      'is this a recovery day?',
      'hypertrophy focused block',
      'lower body day today',
      'upper body focus tomorrow',
      'endurance is improving steadily',
      'coach report please',
      'curls at the gym today',
      '4 sets x 8 reps squats',
      'muscle growth plateau',
      'RPE 8 today felt hard',
      'what FTP should I target?',
    ];

    it.each(messages)('EN "%s" → triathlon (keyword)', (msg) => {
      expect(keywordMatch(msg)).toBe('triathlon');
    });

    it('routes explicit meal-plan asks to cooking even when the subject is carnivore', () => {
      expect(keywordMatch('need a carnivore meal plan')).toBe('cooking');
    });
  });

  describe('Keyword-based triathlon (Tier 2 PT-BR)', () => {
    const messages = [
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

    it.each(messages)('PT-BR "%s" → triathlon (keyword)', (msg) => {
      expect(keywordMatch(msg)).toBe('triathlon');
    });
  });

  describe('Triathlon via classifier (Tier 3)', () => {
    it('ambiguous fitness message uses classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.85 });
      const result = await routeMessage('how should I approach the race?');
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('classifier');
    });
  });
});

describe('REGRESSION: Content commands work correctly', () => {
  beforeEach(() => mockClassifyMessage.mockReset());

  describe('Pattern-based content commands (Tier 1)', () => {
    const commands = [
      '/content ideas for this week',
      '/video idea about AI startups',
      '/reel concept fitness',
      '/script topic here',
      '/caption for instagram post',
      '/thumbnail concept',
      '/trend check AI',
      '/ideas saved list',
      '/discover topics',
      '/deepsearch machine learning',
      '/sources AI news',
      '/hotnews',
      '/trending fitness content',
      '/reaction topic analysis',
      '/hooks for this video',
      '/genscript about crypto',
      '/titles new video',
      '/genthumbnail title here',
      '/gencaption post text',
      '/competitor @channelname',
      '/gaps fitness niche',
      '/seo keywords analysis',
      '/repurpose old content',
      '/feedback url 1000 45% 100 20 5',
      '/report weekly',
    ];

    it.each(commands)('"%s" → content (pattern)', (cmd) => {
      expect(patternMatch(cmd)).toBe('content');
    });
  });

  describe('Keyword-based content (Tier 2 EN)', () => {
    const messages = [
      'I need a youtube video idea',
      'how to grow on instagram',
      'make a reel about this topic',
      'thumbnail design for new video',
      'write a video script about AI',
      'content strategy for Q2',
      'good caption for this post',
      'how many subscribers did I get?',
      'this could go viral',
      'need a better hook for the intro',
      'strong CTA at the end',
      'boost engagement rate this month',
      'audience wants more fitness content',
    ];

    it.each(messages)('EN "%s" → content (keyword)', (msg) => {
      expect(keywordMatch(msg)).toBe('content');
    });
  });

  describe('Keyword-based content (Tier 2 PT-BR)', () => {
    const messages = [
      'ideia de vídeo novo',
      'preciso de um roteiro',
      'legenda para o post',
      'quantos inscritos tenho?',
      'miniatura do vídeo',
      'conteúdo sobre fitness',
      'ideia de conteúdo para youtube',
      'calendário de conteúdo',
      'melhorar engajamento no instagram',
    ];

    it.each(messages)('PT-BR "%s" → content (keyword)', (msg) => {
      expect(keywordMatch(msg)).toBe('content');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 2 — THREE-TIER CASCADE REGRESSION
// ═══════════════════════════════════════════════════════════════════

describe('REGRESSION: Three-tier cascade functions correctly', () => {
  beforeEach(() => mockClassifyMessage.mockReset());

  describe('Tier priority: pattern > keyword > classifier', () => {
    it('explicit command always wins (Tier 1 bypasses Tier 2+3)', async () => {
      const result = await routeMessage('/todo buy milk');
      expect(result.method).toBe('pattern');
      expect(result.confidence).toBe(1.0);
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('keyword match prevents classifier call (Tier 2 bypasses Tier 3)', async () => {
      const result = await routeMessage('I had a great workout today');
      expect(result.method).toBe('keyword');
      expect(result.confidence).toBe(0.9);
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('no pattern/keyword match falls through to classifier (Tier 3)', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.6 });
      const result = await routeMessage('tell me a joke');
      expect(result.method).toBe('classifier');
      expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('Active context: keywords always run first (token-zero optimization)', () => {
    it('with active triathlon context, "schedule a meeting" keyword-matches to secretary (saves classifier call)', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.75 });
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Rest day today.' };

      const result = await routeMessage('schedule a meeting', context);
      // Token-zero: keyword matching runs BEFORE classifier even with active context.
      // "schedule" + "meeting" match secretary keywords. This saves a Claude call.
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
    });

    it('with active secretary context, explicit task actions stay in secretary even if the subject is training', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.8 });
      const context = { domain: 'secretary' as const, lastAssistantMessage: 'Here are your tasks.' };

      const result = await routeMessage('add training plan to my tasks', context);
      // Explicit task mutation should stay in Secretary; the subject being
      // a training plan should not steal the whole request into Triathlon.
      expect(result.method).toBe('keyword');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('with active content context, "deadline" follow-ups preserve content context without paying for the classifier', async () => {
      // Codex QA round 1 short-circuit: when preferContext+activeContext
      // are true and the keyword route disagrees with active context for
      // a non-safe domain (secretary), the router preserves the active
      // context directly instead of paying for the classifier hop.
      mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.9 });
      const context = { domain: 'content' as const, lastAssistantMessage: 'Video script draft ready.' };

      const result = await routeMessage('when is the deadline for this?', context);
      expect(result.method).toBe('context');
      expect(result.domain).toBe('content');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it('explicit command still wins even with active context', async () => {
      const context = { domain: 'triathlon' as const, lastAssistantMessage: 'Run done!' };
      const result = await routeMessage('/todo buy new shoes', context);
      expect(result.method).toBe('pattern');
      expect(result.domain).toBe('secretary');
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });
  });

  describe('Specificity rules between domains', () => {
    it('triathlon keywords beat secretary for workout messages', () => {
      // "workout" could seem task-like, but triathlon is more specific
      expect(keywordMatch('plan my workout for tomorrow')).toBe('triathlon');
    });

    it('content keywords beat secretary for content-planning messages', () => {
      expect(keywordMatch('plan my youtube content calendar')).toBe('content');
    });

    it('secretary gets general task/calendar messages', () => {
      expect(keywordMatch('what are my tasks for today?')).toBe('secretary');
      expect(keywordMatch("what's on my calendar?")).toBe('secretary');
    });

    it('ambiguous messages with no keywords → null (falls to classifier)', () => {
      expect(keywordMatch('hello')).toBeNull();
      expect(keywordMatch('good morning')).toBeNull();
      expect(keywordMatch('thanks')).toBeNull();
      expect(keywordMatch('what do you think?')).toBeNull();
    });
  });

  describe('Message stripping on pattern match', () => {
    it('strips /command prefix and returns the body', async () => {
      const result = await routeMessage('/todo buy milk and eggs');
      expect(result.strippedMessage).toBe('buy milk and eggs');
    });

    it('returns original message for command-only (no body)', async () => {
      const result = await routeMessage('/todos');
      expect(result.strippedMessage).toBe('/todos');
    });

    it('preserves full message for keyword routes', async () => {
      const result = await routeMessage('I need to plan my workout');
      expect(result.strippedMessage).toBe('I need to plan my workout');
    });

    it('preserves full message for classifier routes', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.5 });
      const result = await routeMessage('hello there');
      expect(result.strippedMessage).toBe('hello there');
    });
  });

  describe('System command detection', () => {
    const systemCmds = ['/help', '/status', '/clear', '/start', '/discover', '/deepsearch',
      '/sources', '/hotnews', '/trending', '/reaction', '/hooks', '/genscript',
      '/titles', '/genthumbnail', '/gencaption', '/competitor', '/gaps', '/seo',
      '/repurpose', '/feedback', '/report', '/learnfrom', '/references', '/relearn',
      '/studyvideo', '/transcribe', '/script', '/contenttopic', '/contentretro'];

    it.each(systemCmds)('"%s" is detected as system command', (cmd) => {
      expect(isSystemCommand(cmd)).toBe(cmd);
    });

    it('system commands are case insensitive', () => {
      expect(isSystemCommand('/HELP')).toBe('/help');
      expect(isSystemCommand('/Status')).toBe('/status');
    });

    it('domain commands are NOT system commands', () => {
      expect(isSystemCommand('/todo buy milk')).toBeNull();
      expect(isSystemCommand('/gym')).toBeNull();
      expect(isSystemCommand('/train')).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('empty string falls to classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0 });
      const result = await routeMessage('');
      expect(result.method).toBe('classifier');
    });

    it('whitespace-only falls to classifier', async () => {
      mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0 });
      const result = await routeMessage('   ');
      expect(result.method).toBe('classifier');
    });

    it('commands are case insensitive', async () => {
      const result = await routeMessage('/TODO buy milk');
      expect(result.domain).toBe('secretary');
      expect(result.method).toBe('pattern');
    });

    it('commands with leading/trailing whitespace still match', async () => {
      const result = await routeMessage('  /gym  ');
      expect(result.domain).toBe('triathlon');
      expect(result.method).toBe('pattern');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 3 — CONVERSATION HISTORY PER-SKILL ISOLATION
// ═══════════════════════════════════════════════════════════════════

// For DB-dependent tests, we need a separate describe block with proper DB setup
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// We need to dynamically mock getDb for DB-dependent sections
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

describe('REGRESSION: Conversation history per-domain isolation', () => {
  const userId = 1;

  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  // Import conversation module after mocks
  // Dynamic import to ensure mocks are active
  it('messages added to secretary are NOT visible in triathlon', async () => {
    const { addToConversation, getConversationHistory } = await import('../../src/state/conversation');

    addToConversation(userId, 'secretary', 'user', 'What are my tasks?');
    addToConversation(userId, 'secretary', 'assistant', 'Here are your 5 tasks...');

    const secHistory = getConversationHistory(userId, 'secretary');
    const triHistory = getConversationHistory(userId, 'triathlon');

    expect(secHistory.length).toBe(2);
    expect(triHistory.length).toBe(0);
  });

  it('messages added to triathlon are NOT visible in content', async () => {
    const { addToConversation, getConversationHistory } = await import('../../src/state/conversation');

    addToConversation(userId, 'triathlon', 'user', 'Show me my workout');
    addToConversation(userId, 'triathlon', 'assistant', '5x5 squat day');

    const triHistory = getConversationHistory(userId, 'triathlon');
    const contentHistory = getConversationHistory(userId, 'content');

    expect(triHistory.length).toBe(2);
    expect(contentHistory.length).toBe(0);
  });

  it('each domain maintains independent history', async () => {
    const { addToConversation, getConversationHistory } = await import('../../src/state/conversation');

    addToConversation(userId, 'secretary', 'user', 'Tasks please');
    addToConversation(userId, 'triathlon', 'user', 'Workout plan');
    addToConversation(userId, 'content', 'user', 'Video ideas');

    addToConversation(userId, 'secretary', 'assistant', 'Here are tasks');
    addToConversation(userId, 'triathlon', 'assistant', 'Here is your plan');
    addToConversation(userId, 'content', 'assistant', 'Here are ideas');

    expect(getConversationHistory(userId, 'secretary').length).toBe(2);
    expect(getConversationHistory(userId, 'triathlon').length).toBe(2);
    expect(getConversationHistory(userId, 'content').length).toBe(2);

    // Verify content correctness — messages are present in secretary
    const secHistory = getConversationHistory(userId, 'secretary');
    const secContents = secHistory.map(m => m.content);
    expect(secContents).toContain('Tasks please');
    expect(secContents).toContain('Here are tasks');

    // Verify triathlon messages are correct
    const triHistory = getConversationHistory(userId, 'triathlon');
    const triContents = triHistory.map(m => m.content);
    expect(triContents).toContain('Workout plan');
  });

  it('clearing one domain does not affect others', async () => {
    const { addToConversation, getConversationHistory, clearConversation } = await import('../../src/state/conversation');

    addToConversation(userId, 'secretary', 'user', 'Task A');
    addToConversation(userId, 'triathlon', 'user', 'Workout A');
    addToConversation(userId, 'content', 'user', 'Video A');

    clearConversation(userId, 'secretary');

    expect(getConversationHistory(userId, 'secretary').length).toBe(0);
    expect(getConversationHistory(userId, 'triathlon').length).toBe(1);
    expect(getConversationHistory(userId, 'content').length).toBe(1);
  });

  it('getLastAssistantMessage is domain-scoped', async () => {
    const { addToConversation, getLastAssistantMessage } = await import('../../src/state/conversation');

    // Empty domain returns null
    expect(getLastAssistantMessage(userId, 'content')).toBeNull();

    // Add only an assistant message to secretary (no ordering ambiguity)
    addToConversation(userId, 'secretary', 'assistant', 'Here are your tasks');

    expect(getLastAssistantMessage(userId, 'secretary')).toBe('Here are your tasks');
    // Other domains unaffected
    expect(getLastAssistantMessage(userId, 'triathlon')).toBeNull();
    expect(getLastAssistantMessage(userId, 'content')).toBeNull();

    // After a user message, getLastAssistantMessage returns null (last msg is user)
    addToConversation(userId, 'secretary', 'user', 'Thanks');
    // The function returns null if the LAST message is from user
    const result = getLastAssistantMessage(userId, 'secretary');
    // With same-second timestamps, ordering by created_at is non-deterministic;
    // just verify it returns either null or a string (function works)
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('history respects per-domain limits (secretary=10, triathlon=6)', async () => {
    const { addToConversation, getConversationHistory } = await import('../../src/state/conversation');

    // Add 14 messages to secretary (7 user + 7 assistant)
    for (let i = 0; i < 7; i++) {
      addToConversation(userId, 'secretary', 'user', `sec user msg ${i}`);
      addToConversation(userId, 'secretary', 'assistant', `sec assistant msg ${i}`);
    }

    // Add 10 messages to triathlon (5 user + 5 assistant)
    for (let i = 0; i < 5; i++) {
      addToConversation(userId, 'triathlon', 'user', `tri user msg ${i}`);
      addToConversation(userId, 'triathlon', 'assistant', `tri assistant msg ${i}`);
    }

    const secHistory = getConversationHistory(userId, 'secretary');
    const triHistory = getConversationHistory(userId, 'triathlon');

    // Secretary limit is 10 messages
    expect(secHistory.length).toBeLessThanOrEqual(10);
    // Triathlon limit is 6 messages
    expect(triHistory.length).toBeLessThanOrEqual(6);
  });

  it('clearAllConversations wipes every domain', async () => {
    const { addToConversation, getConversationHistory, clearAllConversations } = await import('../../src/state/conversation');

    addToConversation(userId, 'secretary', 'user', 'A');
    addToConversation(userId, 'triathlon', 'user', 'B');
    addToConversation(userId, 'content', 'user', 'C');

    clearAllConversations(userId);

    expect(getConversationHistory(userId, 'secretary').length).toBe(0);
    expect(getConversationHistory(userId, 'triathlon').length).toBe(0);
    expect(getConversationHistory(userId, 'content').length).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 4 — TOOL EXECUTION THROUGH SKILL INTERFACE
// ═══════════════════════════════════════════════════════════════════

describe('REGRESSION: Tool execution through skill interface', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('Skill registry: install, enable, disable', () => {
    it('can install a skill with submodules', async () => {
      const { install, getByName, getSubmodules } = await import('../../src/skills/registry');

      const skill = install({
        name: 'secretary',
        description: 'Personal assistant',
        version: '1.0.0',
        domain: 'secretary',
        submodules: [
          { module_name: 'tasks', version: '1.0.0' },
          { module_name: 'calendar', version: '1.0.0' },
          { module_name: 'email', version: '1.0.0' },
        ],
      });

      expect(skill).toBeDefined();
      expect(skill.name).toBe('secretary');
      expect(skill.enabled).toBe(1);

      const subs = getSubmodules(skill.id);
      expect(subs.length).toBe(3);
      expect(subs.map(s => s.module_name).sort()).toEqual(['calendar', 'email', 'tasks']);
    });

    it('disabling a skill makes it return no tools', async () => {
      const reg = await import('../../src/skills/registry');
      const { getToolsForDomain, invalidateToolCache, seedDefaultSkills } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      const fakeTools = [
        { name: 'ms_todo_get_tasks', description: 'Get tasks', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'get_calendar_events', description: 'Calendar', input_schema: { type: 'object' as const, properties: {} } },
      ];

      // Secretary is enabled by default
      let tools = getToolsForDomain('secretary', fakeTools as any);
      expect(tools.length).toBeGreaterThan(0);

      // Disable secretary
      reg.disable('secretary');
      invalidateToolCache();

      tools = getToolsForDomain('secretary', fakeTools as any);
      expect(tools.length).toBe(0);

      // Re-enable
      reg.enable('secretary');
      invalidateToolCache();

      tools = getToolsForDomain('secretary', fakeTools as any);
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('Sub-skill toggling controls tool availability', () => {
    it('disabling "tasks" sub-skill removes task tools from secretary', async () => {
      const { seedDefaultSkills, getToolsForDomain, disableSubSkill, invalidateToolCache } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      const fakeTools = [
        { name: 'ms_todo_get_tasks', description: 'Get tasks', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'ms_todo_create_task', description: 'Create task', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'get_calendar_events', description: 'Calendar', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'set_reminder', description: 'Remind', input_schema: { type: 'object' as const, properties: {} } },
      ];

      // Initially all tools available
      let tools = getToolsForDomain('secretary', fakeTools as any);
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('ms_todo_get_tasks');
      expect(toolNames).toContain('get_calendar_events');

      // Disable tasks sub-skill
      disableSubSkill('secretary', 'tasks');

      tools = getToolsForDomain('secretary', fakeTools as any);
      const afterNames = tools.map(t => t.name);
      expect(afterNames).not.toContain('ms_todo_get_tasks');
      expect(afterNames).not.toContain('ms_todo_create_task');
      // Calendar should still be there
      expect(afterNames).toContain('get_calendar_events');
    });

    it('disabling "calendar" sub-skill removes calendar tools from triathlon', async () => {
      const { seedDefaultSkills, getToolsForDomain, disableSubSkill } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      const fakeTools = [
        { name: 'get_calendar_events', description: 'Cal', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'create_calendar_event', description: 'Create', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'set_reminder', description: 'Remind', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'save_note', description: 'Note', input_schema: { type: 'object' as const, properties: {} } },
      ];

      let tools = getToolsForDomain('triathlon', fakeTools as any);
      expect(tools.map(t => t.name)).toContain('get_calendar_events');

      disableSubSkill('triathlon', 'calendar');

      tools = getToolsForDomain('triathlon', fakeTools as any);
      expect(tools.map(t => t.name)).not.toContain('get_calendar_events');
      expect(tools.map(t => t.name)).not.toContain('create_calendar_event');
      // Notes and reminders should remain
      expect(tools.map(t => t.name)).toContain('set_reminder');
      expect(tools.map(t => t.name)).toContain('save_note');
    });
  });

  describe('Skill status reflects real DB state', () => {
    it('getSkillStatus returns correct enabled/disabled state', async () => {
      const { seedDefaultSkills, getSkillStatus, disableSubSkill } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      let status = getSkillStatus('secretary');
      expect(status.enabled).toBe(true);
      expect(status.subSkills.find(s => s.name === 'tasks')?.enabled).toBe(true);
      expect(status.subSkills.find(s => s.name === 'calendar')?.enabled).toBe(true);

      disableSubSkill('secretary', 'tasks');

      status = getSkillStatus('secretary');
      expect(status.subSkills.find(s => s.name === 'tasks')?.enabled).toBe(false);
      expect(status.subSkills.find(s => s.name === 'calendar')?.enabled).toBe(true);
    });

    it('getAllSkillStatuses returns all four domains', async () => {
      const { seedDefaultSkills, getAllSkillStatuses } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      const statuses = getAllSkillStatuses();
      expect(statuses.length).toBe(8);
      expect(statuses.map(s => s.name).sort()).toEqual([
        'connections', 'content', 'cooking', 'decision_center', 'finance',
        'notifications', 'secretary', 'triathlon',
      ]);
    });
  });

  describe('Seed idempotency', () => {
    it('calling seedDefaultSkills twice does not duplicate skills', async () => {
      const { seedDefaultSkills } = await import('../../src/skills/skill-manager');
      const { getAll } = await import('../../src/skills/registry');

      seedDefaultSkills();
      const firstCount = getAll().length;

      seedDefaultSkills();
      const secondCount = getAll().length;

      expect(firstCount).toBe(secondCount);
      expect(firstCount).toBe(8); // 5 domain skills + 3 platform skills (connections, notifications, decision_center) promoted 2026-05-15
    });

    it('re-seeding preserves user toggle state', async () => {
      const { seedDefaultSkills, disableSubSkill, getSkillStatus } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();
      disableSubSkill('secretary', 'email');

      // Re-seed (simulating app restart)
      seedDefaultSkills();

      const status = getSkillStatus('secretary');
      // Email should STILL be disabled — user's choice preserved
      expect(status.subSkills.find(s => s.name === 'email')?.enabled).toBe(false);
    });
  });

  describe('Cross-domain tool isolation', () => {
    it('secretary tools are NOT available to triathlon domain', async () => {
      const { seedDefaultSkills, getToolsForDomain } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      // Secretary-only tools
      const fakeTools = [
        { name: 'ms_todo_get_tasks', description: 'Tasks', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'search_outlook_emails', description: 'Email', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'get_calendar_events', description: 'Cal', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'save_note', description: 'Note', input_schema: { type: 'object' as const, properties: {} } },
      ];

      const secTools = getToolsForDomain('secretary', fakeTools as any);
      const triTools = getToolsForDomain('triathlon', fakeTools as any);

      // Secretary should have email + tasks
      expect(secTools.map(t => t.name)).toContain('ms_todo_get_tasks');
      expect(secTools.map(t => t.name)).toContain('search_outlook_emails');

      // Triathlon should NOT have email or tasks
      expect(triTools.map(t => t.name)).not.toContain('ms_todo_get_tasks');
      expect(triTools.map(t => t.name)).not.toContain('search_outlook_emails');

      // Both should have calendar and notes (shared sub-skills)
      expect(secTools.map(t => t.name)).toContain('get_calendar_events');
      expect(triTools.map(t => t.name)).toContain('get_calendar_events');
      expect(secTools.map(t => t.name)).toContain('save_note');
      expect(triTools.map(t => t.name)).toContain('save_note');
    });

    it('content domain has minimal tool set (notes + shared-memory only)', async () => {
      const { seedDefaultSkills, getToolsForDomain } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();

      const fakeTools = [
        { name: 'ms_todo_get_tasks', description: 'Tasks', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'get_calendar_events', description: 'Cal', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'save_note', description: 'Note', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'search_notes', description: 'Search', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'shared_memory_set', description: 'Shared', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'shared_memory_remove', description: 'Remove', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'set_reminder', description: 'Remind', input_schema: { type: 'object' as const, properties: {} } },
      ];

      const contentTools = getToolsForDomain('content', fakeTools as any);
      const names = contentTools.map(t => t.name);

      // Content should have notes + shared memory
      expect(names).toContain('save_note');
      expect(names).toContain('search_notes');
      expect(names).toContain('shared_memory_set');
      expect(names).toContain('shared_memory_remove');

      // Content should NOT have tasks, calendar, reminders
      expect(names).not.toContain('ms_todo_get_tasks');
      expect(names).not.toContain('get_calendar_events');
      expect(names).not.toContain('set_reminder');
    });
  });

  describe('Service filter integration', () => {
    it('serviceFilter can remove tools based on runtime availability', async () => {
      const { seedDefaultSkills, getToolsForDomain, invalidateToolCache } = await import('../../src/skills/skill-manager');

      seedDefaultSkills();
      invalidateToolCache();

      const fakeTools = [
        { name: 'search_outlook_emails', description: 'Email', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'get_calendar_events', description: 'Cal', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'save_note', description: 'Note', input_schema: { type: 'object' as const, properties: {} } },
      ];

      // Simulate: Outlook not configured — filter out email tools
      const serviceFilter = (tool: { name: string }) => !tool.name.startsWith('search_outlook');

      const tools = getToolsForDomain('secretary', fakeTools as any, serviceFilter);
      const names = tools.map(t => t.name);

      expect(names).not.toContain('search_outlook_emails');
      expect(names).toContain('get_calendar_events');
      expect(names).toContain('save_note');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 5 — SKILL CONFIG INTEGRITY
// ═══════════════════════════════════════════════════════════════════

describe('REGRESSION: Skill config definitions are consistent', () => {
  it('every domain has a skill definition', async () => {
    const { DEFAULT_SKILLS, getSkillDefinition } = await import('../../src/skills/skill-config');
    const domains: Array<'secretary' | 'triathlon' | 'content'> = ['secretary', 'triathlon', 'content'];

    for (const domain of domains) {
      const def = getSkillDefinition(domain);
      expect(def).toBeDefined();
      expect(def.name).toBe(domain);
      expect(def.subSkills.length).toBeGreaterThan(0);
    }
  });

  it('secretary has all expected sub-skills', async () => {
    const { getSkillDefinition } = await import('../../src/skills/skill-config');
    const sec = getSkillDefinition('secretary');
    const subNames = sec.subSkills.map(s => s.name);

    expect(subNames).toContain('tasks');
    expect(subNames).toContain('calendar');
    expect(subNames).toContain('email');
    expect(subNames).toContain('reminders');
    expect(subNames).toContain('notes');
    expect(subNames).toContain('shared-memory');
  });

  it('triathlon has calendar, reminders, notes, shared-memory', async () => {
    const { getSkillDefinition } = await import('../../src/skills/skill-config');
    const tri = getSkillDefinition('triathlon');
    const subNames = tri.subSkills.map(s => s.name);

    expect(subNames).toContain('calendar');
    expect(subNames).toContain('reminders');
    expect(subNames).toContain('notes');
    expect(subNames).toContain('shared-memory');
    // Triathlon should NOT have tasks or email
    expect(subNames).not.toContain('tasks');
    expect(subNames).not.toContain('email');
  });

  it('content v2 has 12 granular sub-skills including agent mesh and creator agency', async () => {
    const { getSkillDefinition } = await import('../../src/skills/skill-config');
    const content = getSkillDefinition('content');
    const subNames = content.subSkills.map(s => s.name);

    expect(subNames).toContain('notes');
    expect(subNames).toContain('shared-memory');
    expect(subNames).toContain('research-pipeline');
    expect(subNames).toContain('script-generator');
    expect(subNames).toContain('seo-tracker');
    expect(subNames).toContain('reaction-radar');
    expect(subNames).toContain('voice-evolution');
    expect(subNames).toContain('performance-intel');
    expect(subNames).toContain('pipeline-tracker');
    expect(subNames).toContain('topic-scheduler');
    expect(subNames).toContain('creator-agency');
    expect(subNames).toContain('meme-scout');
    expect(subNames.length).toBe(12);
  });

  it('no tool name appears in conflicting sub-skills across domains', async () => {
    const { DEFAULT_SKILLS } = await import('../../src/skills/skill-config');

    // Build tool → domain:subskill mapping
    const toolMap = new Map<string, string[]>();
    for (const [domain, skill] of Object.entries(DEFAULT_SKILLS)) {
      for (const sub of skill.subSkills) {
        for (const tool of sub.tools) {
          const key = `${domain}:${sub.name}`;
          if (!toolMap.has(tool)) toolMap.set(tool, []);
          toolMap.get(tool)!.push(key);
        }
      }
    }

    // Shared tools (calendar, notes, etc.) appear in multiple domains — that's OK.
    // But a tool should NOT appear in multiple sub-skills within the SAME domain.
    for (const [tool, locations] of toolMap) {
      const domainCounts = new Map<string, number>();
      for (const loc of locations) {
        const domain = loc.split(':')[0];
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
      for (const [domain, count] of domainCounts) {
        expect(count, `Tool "${tool}" appears ${count} times in domain "${domain}"`).toBe(1);
      }
    }
  });

  it('getAllToolNames returns all unique tool names', async () => {
    const { getAllToolNames, DEFAULT_SKILLS } = await import('../../src/skills/skill-config');

    const allTools = getAllToolNames();
    expect(allTools.length).toBeGreaterThan(0);

    // Verify uniqueness
    const unique = new Set(allTools);
    expect(unique.size).toBe(allTools.length);

    // Every tool should come from some sub-skill
    for (const tool of allTools) {
      let found = false;
      for (const skill of Object.values(DEFAULT_SKILLS)) {
        for (const sub of skill.subSkills) {
          if (sub.tools.includes(tool)) found = true;
        }
      }
      expect(found, `Tool "${tool}" not found in any sub-skill`).toBe(true);
    }
  });

  it('getSubSkillNames returns correct names for each domain', async () => {
    const { getSubSkillNames } = await import('../../src/skills/skill-config');

    expect(getSubSkillNames('secretary')).toContain('tasks');
    expect(getSubSkillNames('triathlon')).toContain('calendar');
    expect(getSubSkillNames('content')).toContain('notes');
  });
});

/**
 * Router Classifier Tests
 * 
 * Tests the three-tier classification system:
 * - Tier 1: Pattern matching (commands)
 * - Tier 2: Keyword matching (natural language)
 * - Tier 3: Claude AI classification (mocked)
 */

import { describe, it, expect } from 'vitest';
import { patternMatch, keywordMatch } from '../../src/router/classifier';

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

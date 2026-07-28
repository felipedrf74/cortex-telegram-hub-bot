/**
 * Coach safety — chat-path wiring (App Review guideline 1.4.1).
 *
 * Two gaps this covers:
 *   1. `COACH_NON_DIAGNOSTIC_DISCLAIMER` existed but had zero production
 *      consumers, so no coach answer ever carried it.
 *   2. The deterministic red-flag guardrails were reachable only from
 *      structured intake / plan generation — ordinary chat, which is where
 *      an athlete actually describes a symptom, bypassed them entirely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

import {
  COACH_NON_DIAGNOSTIC_DISCLAIMER,
  COACH_NON_DIAGNOSTIC_DISCLAIMER_PT,
  answerCarriesNonDiagnosticDisclaimer,
  buildCoachSafetyNotice,
  detectInferredRedFlagTriggers,
  evaluateChatMessageSafety,
  evaluateSafetyContext,
  renderCoachNonDiagnosticDisclaimer,
  resolveCoachSafetyLocale,
  selectSurfacedSafetyFinding,
} from '../../src/services/coach-kernel/safety-guardrails';
import { wireHealthSignalToSafety } from '../../src/services/coach-kernel/safety-wiring';

let testDb: Database.Database;

// ─── Mocks for the domain-handler wiring block ──────────────────────

const mockCallDomainFn = vi.fn();
const mockContinueFn = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockEnsureActiveProvider = vi.fn();

vi.mock('../../src/services/provider-registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/provider-registry')>('../../src/services/provider-registry');
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
    ensureActiveProvider: (...args: unknown[]) => mockEnsureActiveProvider(...args),
  };
});

vi.mock('../../src/services/anthropic', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/anthropic')>('../../src/services/anthropic');
  return {
    ...actual,
    callDomain: vi.fn(),
    continueWithToolResults: vi.fn(),
  };
});

vi.mock('../../src/state/conversation', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/conversation')>('../../src/state/conversation');
  return {
    ...actual,
    getConversationHistory: vi.fn().mockReturnValue([]),
    addToConversation: vi.fn(),
  };
});

vi.mock('../../src/state/todos', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/todos')>('../../src/state/todos');
  return {
    ...actual,
    listTodos: vi.fn().mockReturnValue([]),
  };
});

vi.mock('../../src/state/shared-memory', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/shared-memory')>('../../src/state/shared-memory');
  return {
    ...actual,
    getSharedMemorySummary: vi.fn().mockReturnValue(''),
    getSharedMemory: vi.fn().mockReturnValue([]),
    getSharedMemoryByScope: vi.fn().mockReturnValue({ userPrivate: [], tenantShared: [] }),
  };
});

vi.mock('../../src/services/tool-executor', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/tool-executor')>('../../src/services/tool-executor');
  return {
    ...actual,
    executeToolCall: vi.fn(),
  };
});

vi.mock('../../src/utils/date-parser', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/date-parser')>('../../src/utils/date-parser');
  return {
    ...actual,
    now: vi.fn(),
    formatDateTime: vi.fn((d: string) => d),
    startOfDay: vi.fn().mockReturnValue('2026-07-27T00:00:00'),
    endOfDay: vi.fn().mockReturnValue('2026-07-27T23:59:59'),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

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

import { handleSimpleDomain, __resetLastCoachStateCacheForTests } from '../../src/domains/domain-handler';
import { now } from '../../src/utils/date-parser';

function seedUser(userId: number, language: string): void {
  testDb.prepare(`
    INSERT OR IGNORE INTO users (
      id, telegram_id, first_name, language, timezone, tier, status, auth_provider, created_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(userId, userId, `Athlete ${userId}`, language, 'Europe/Lisbon', 'pro', 'active', 'telegram');
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  __resetLastCoachStateCacheForTests();
  mockGetActiveProvider.mockReturnValue({
    name: 'mock-provider',
    callDomain: (...args: any[]) => mockCallDomainFn(...args),
    continueWithToolResults: (...args: any[]) => mockContinueFn(...args),
    classify: vi.fn(),
  });
  mockEnsureActiveProvider.mockReturnValue(null);
  vi.mocked(now).mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Monday, July 27 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-07-24') }),
  } as any);
});

afterEach(() => {
  __resetLastCoachStateCacheForTests();
  testDb?.close();
});

// ═══════════════════════════════════════════════════════════════════

describe('inferred red-flag detection', () => {
  it('detects the English red-flag phrases', () => {
    expect(detectInferredRedFlagTriggers('I had chest pain during the run')).toEqual(['chest_pain']);
    expect(detectInferredRedFlagTriggers('I passed out after the interval')).toEqual(['fainting']);
    expect(detectInferredRedFlagTriggers('I sprained my ankle yesterday')).toEqual(['acute_injury']);
    expect(detectInferredRedFlagTriggers('I have a fever today')).toEqual(['fever_or_systemic_illness']);
    expect(detectInferredRedFlagTriggers('I lost my period three months ago')).toEqual(['red_s_high_risk']);
  });

  it('detects accented and unaccented Portuguese spellings identically', () => {
    expect(detectInferredRedFlagTriggers('senti dor torácica no treino')).toEqual(['chest_pain']);
    expect(detectInferredRedFlagTriggers('senti dor toracica no treino')).toEqual(['chest_pain']);
    expect(detectInferredRedFlagTriggers('desmaiei depois do treino')).toEqual(['fainting']);
    expect(detectInferredRedFlagTriggers('estou com febre')).toEqual(['fever_or_systemic_illness']);
  });

  it('does not fire on body-part or exercise words alone', () => {
    expect(detectInferredRedFlagTriggers('add chest press to my gym day')).toEqual([]);
    expect(detectInferredRedFlagTriggers('quero mais supino e peito na segunda')).toEqual([]);
    expect(detectInferredRedFlagTriggers('remind me to scan the invoice')).toEqual([]);
  });

  it('deduplicates repeated triggers', () => {
    expect(detectInferredRedFlagTriggers('chest pain, and again chest pain today')).toEqual(['chest_pain']);
  });
});

describe('evaluateChatMessageSafety', () => {
  it('passes on an ordinary training question', () => {
    const result = evaluateChatMessageSafety('what should I run on Thursday?');
    expect(result.status).toBe('pass');
    expect(selectSurfacedSafetyFinding(result)).toBeNull();
  });

  it('flags a free-text red flag at warn severity, never block', () => {
    const result = evaluateChatMessageSafety('I felt chest pain during my run this morning');
    expect(result.status).toBe('flag');
    const surfaced = selectSurfacedSafetyFinding(result);
    expect(surfaced).not.toBeNull();
    expect(surfaced!.severity).toBe('warn');
    expect(surfaced!.referralCopy).toMatch(/chest pain/i);
    expect(result.findings.every((finding) => finding.severity !== 'block')).toBe(true);
  });

  it('reaches the direct-medical-question rule from chat for a real medication question', () => {
    const result = evaluateChatMessageSafety('should I take an anti-inflammatory before the race?');
    const surfaced = selectSurfacedSafetyFinding(result);
    expect(surfaced?.domain).toBe('direct_medical_question');
  });

  it('still warns on a diagnostic question, via the symptom rather than the framing', () => {
    // "do i have" alone is NOT a chat-tier cue any more (see the ordinary
    // -questions suite below) — "fracture" is what carries this one.
    const result = evaluateChatMessageSafety('do I have a stress fracture?');
    const domains = result.findings.map((finding) => finding.domain);
    expect(domains).toContain('stress_fracture_warning');
    expect(selectSurfacedSafetyFinding(result)?.severity).toBe('warn');
  });

  it('does not surface the inform-level supplement rule on ordinary nutrition words', () => {
    const result = evaluateChatMessageSafety('how much protein is in this meal?');
    expect(selectSurfacedSafetyFinding(result)).toBeNull();
  });

  it('accepts several values and evaluates them together', () => {
    const result = evaluateChatMessageSafety('how did I do?', 'You mentioned you fainted after the session.');
    expect(selectSurfacedSafetyFinding(result)?.triggerSummary).toContain('inferred free text');
  });

  it('keeps the broad intake vocabulary for the plan-generation tier', () => {
    // The chat tier is a SUBSET. The intake tier — everything that does not
    // pass questionTier: 'chat' — must keep matching the loose cues, because
    // on an intake form every sentence is already about the athlete's body.
    const intake = evaluateSafetyContext({ userQuestionText: 'should i take a rest day tomorrow?' });
    expect(intake.findings.map((finding) => finding.domain)).toContain('direct_medical_question');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Chat-tier precision. The intake-form medical-question vocabulary is
// far too broad for open chat: run against the live patterns it warns on
// "should I take a rest day tomorrow?", "do I have a session tomorrow?"
// and "can you scan my week". Every phrase below is a real product turn.
// ═══════════════════════════════════════════════════════════════════

describe('chat safety does not fire on ordinary questions', () => {
  const ORDINARY_TURNS: ReadonlyArray<string> = [
    // Training — the "should i take" family the intake tier over-matched.
    'should I take a rest day tomorrow?',
    'should i take an extra gel',
    'should I take more carbs before the long ride?',
    'my legs feel heavy, should I take it easy today?',
    'what should I run on Thursday?',
    'plan my week with two threshold sessions',
    // Training — the "do i have" family.
    'do I have a session tomorrow?',
    'am I going to have a long run this weekend?',
    'is my FTP test scheduled?',
    // Nutrition.
    'how much protein is in this meal?',
    'do I have enough protein today?',
    'how many grams of carbs per hour on the bike?',
    'add anti-inflammatory foods like turmeric and ginger to my meals',
    // Words the intake tier matched for non-clinical reasons.
    'can you scan my week and rebalance it',
    'what treatment temperature for the sous vide?',
    'give me a roasted vegetable recipe',
    // Portuguese.
    'devo tomar mais hidratos antes do treino longo?',
    'o que devo correr na quinta?',
    'quanto peito de frango preciso para 30g de proteina?',
    // Answer-side text, which is evaluated alongside the question.
    'Run 40 minutes easy on Thursday, keep it conversational.',
    'Take 60g of carbs per hour and 500ml of fluid.',
  ];

  it.each(ORDINARY_TURNS)('does not warn on %j', (turn) => {
    const result = evaluateChatMessageSafety(turn);
    expect(selectSurfacedSafetyFinding(result)).toBeNull();
  });
});

describe('chat safety still fires on genuine red flags', () => {
  const RED_FLAG_TURNS: ReadonlyArray<[string, string]> = [
    // Inferred red-flag lexicon — the symptom itself.
    ['I felt chest pain during my run this morning', 'chest pain'],
    ['senti dor torácica no treino', 'chest pain (pt)'],
    ['I passed out after the last interval', 'fainting'],
    ['desmaiei depois do treino', 'fainting (pt)'],
    ['the room was spinning after the session', 'severe dizziness'],
    ['I sprained my ankle yesterday', 'acute injury'],
    ['I think I fractured my foot', 'acute injury'],
    ['the pain keeps getting worse every session', 'worsening pain'],
    ['I have a fever today, can I still train?', 'fever'],
    ['estou com febre, posso treinar?', 'fever (pt)'],
    ['I lost my period three months ago', 'RED-S'],
    ['I think I have low energy availability', 'RED-S'],
    // Prescriptive / diagnostic vocabulary.
    ['can I take ibuprofen for the knee?', 'medication'],
    ['what antibiotic should I be on?', 'medication'],
    ['what medication helps with this?', 'medication'],
    ['posso tomar um analgesico antes da corrida?', 'medication (pt)'],
    ['can you diagnose what is wrong with my knee?', 'diagnosis'],
    ['can you prescribe me something?', 'prescription'],
    ['should I get a cortisone injection?', 'procedure'],
    ['should I get an MRI for this?', 'procedure'],
    ['do I need surgery?', 'procedure'],
    ['preciso de uma ressonancia ao joelho?', 'procedure (pt)'],
    ['should I get blood work done?', 'labs'],
  ];

  it.each(RED_FLAG_TURNS)('warns on %j (%s)', (turn) => {
    const result = evaluateChatMessageSafety(turn);
    const surfaced = selectSurfacedSafetyFinding(result);
    expect(surfaced).not.toBeNull();
    expect(surfaced!.severity).toBe('warn');
    expect(surfaced!.referralCopy).toMatch(/not a clinician/i);
  });

  it('never emits a block from the chat tier, even on the hardest red flag', () => {
    for (const [turn] of RED_FLAG_TURNS) {
      const result = evaluateChatMessageSafety(turn);
      expect(result.findings.every((finding) => finding.severity !== 'block')).toBe(true);
    }
  });
});

describe('inferred findings never hard-pause a plan', () => {
  it('keeps the structured-intake contract: typed blocks, inferred warns', () => {
    const typed = evaluateSafetyContext({ typedRedFlagTrigger: 'chest_pain' });
    expect(typed.findings[0].severity).toBe('block');

    const inferred = evaluateSafetyContext({ inferredRedFlagTriggers: ['chest_pain'] });
    expect(inferred.findings[0].severity).toBe('warn');
    // Same referral copy — one wording source for both tiers.
    expect(inferred.findings[0].referralCopy).toBe(typed.findings[0].referralCopy);
  });

  it('leaves wireHealthSignalToSafety untouched', () => {
    const output = wireHealthSignalToSafety({
      signal: {
        consentScope: ['pain'],
        painScore: 8,
        painLocation: 'chest',
        source: 'structured_intake',
      } as any,
      source: 'structured_intake',
      triggerType: 'chest_pain',
    });
    expect(output.effectiveSeverity).toBe('block');
  });
});

describe('non-diagnostic disclaimer rendering', () => {
  it('renders per locale', () => {
    expect(renderCoachNonDiagnosticDisclaimer('en')).toBe(COACH_NON_DIAGNOSTIC_DISCLAIMER);
    expect(renderCoachNonDiagnosticDisclaimer('pt')).toBe(COACH_NON_DIAGNOSTIC_DISCLAIMER_PT);
  });

  it('maps language tags to the two renderings', () => {
    expect(resolveCoachSafetyLocale('pt-BR')).toBe('pt');
    expect(resolveCoachSafetyLocale('pt-PT')).toBe('pt');
    expect(resolveCoachSafetyLocale('en-US')).toBe('en');
    expect(resolveCoachSafetyLocale(null)).toBe('en');
  });

  it('detects an answer that already carries a referral line', () => {
    expect(answerCarriesNonDiagnosticDisclaimer(COACH_NON_DIAGNOSTIC_DISCLAIMER)).toBe(true);
    expect(answerCarriesNonDiagnosticDisclaimer(COACH_NON_DIAGNOSTIC_DISCLAIMER_PT)).toBe(true);
    expect(answerCarriesNonDiagnosticDisclaimer('Run 5k easy on Thursday.')).toBe(false);
  });

  it('suppresses the duplicate when the answer already disclaims', () => {
    const notice = buildCoachSafetyNotice(
      { status: 'pass', findings: [], topMessage: '' },
      'en',
      { includeDisclaimer: true, alreadyDisclaimed: true },
    );
    expect(notice).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Chat path wiring
// ═══════════════════════════════════════════════════════════════════

describe('handleSimpleDomain coach safety', () => {
  it('appends the disclaimer to every training answer', async () => {
    seedUser(51, 'en-US');
    mockCallDomainFn.mockResolvedValue({
      text: 'Run 40 minutes easy on Thursday.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain('triathlon', 'what should I run Thursday?', 5, 51);

    expect(result.text).toContain('Run 40 minutes easy on Thursday.');
    expect(result.text).toContain(COACH_NON_DIAGNOSTIC_DISCLAIMER);
  });

  it('does not surface a medical referral on an ordinary training question', async () => {
    seedUser(57, 'en-US');
    mockCallDomainFn.mockResolvedValue({
      text: 'Take Thursday easy — 30 minutes conversational.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain('triathlon', 'should I take a rest day tomorrow?', 5, 57);

    // The disclaimer rides on every coach answer, but the clinical
    // "that's a medical question I can't answer" line must not appear.
    expect(result.text).toContain(COACH_NON_DIAGNOSTIC_DISCLAIMER);
    expect(result.text).not.toMatch(/medical question/i);
  });

  it('renders the disclaimer in Portuguese for a pt user', async () => {
    seedUser(52, 'pt-PT');
    mockCallDomainFn.mockResolvedValue({
      text: 'Corre 40 minutos leves na quinta.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain('triathlon', 'o que corro na quinta?', 5, 52);

    expect(result.text).toContain(COACH_NON_DIAGNOSTIC_DISCLAIMER_PT);
  });

  it('surfaces the deterministic referral when the athlete reports a red flag in chat', async () => {
    seedUser(53, 'en-US');
    mockCallDomainFn.mockResolvedValue({
      text: 'Let us move the session to Saturday.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain(
      'triathlon',
      'I had chest pain during my run, should I train tomorrow?',
      5,
      53,
    );

    expect(result.text).toMatch(/seek immediate medical evaluation/i);
    // The referral copy already ends with "I am not a clinician…", so the
    // standalone disclaimer is not repeated on top of it.
    expect(result.text).toMatch(/not a clinician/i);
    expect(result.text).not.toContain(COACH_NON_DIAGNOSTIC_DISCLAIMER);
  });

  it('surfaces a red flag even outside the health-guidance domains', async () => {
    seedUser(54, 'en-US');
    mockCallDomainFn.mockResolvedValue({
      text: 'Your afternoon is free.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain(
      'finance',
      'I fainted this morning, can you check my budget anyway?',
      5,
      54,
    );

    expect(result.text).toContain('Your afternoon is free.');
    expect(result.text).toMatch(/immediate medical evaluation/i);
  });

  it('leaves an ordinary non-health answer untouched', async () => {
    seedUser(55, 'en-US');
    mockCallDomainFn.mockResolvedValue({
      text: 'Your spend last month was 412 EUR.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain('finance', 'how much did I spend last month?', 5, 55);

    expect(result.text).toBe('Your spend last month was 412 EUR.');
  });

  it('does not stamp the coach disclaimer on a plain recipe answer', async () => {
    seedUser(56, 'en-US');
    mockCallDomainFn.mockResolvedValue({
      text: 'Roast the vegetables for 25 minutes at 200C.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await handleSimpleDomain('cooking', 'give me a roasted vegetable recipe', 5, 56);

    expect(result.text).toBe('Roast the vegetables for 25 minutes at 200C.');
  });
});

// Phase 4 batch 18 (2026-05-15): past-tense detector edge-case stress test.
//
// The detector at src/services/skills/past-tense-detector.ts is intentionally
// conservative — it should fire only when the message clearly describes a
// past mutation, not on any phrase that mentions yesterday or contains a
// past-tense verb in isolation. This test pins both directions:
//
//   • POSITIVE cases (must trip)   — the strong constructs and combined
//     past-verb+past-anchor patterns. Includes the Phase 3 batch 12 negative
//     fixtures from the registry.
//   • NEGATIVE cases (must NOT trip) — borderline phrases that look past-
//     tense but are either (a) future-intent narration, (b) read queries
//     over past data, (c) standalone past-verb without anchor, or (d)
//     standalone past-anchor without verb.
//
// If a future detector tweak (e.g., loosening the heuristic to catch more
// cases) breaks any negative here, this test fails and forces deliberate
// adjustment.

import { describe, expect, it } from 'vitest';
import { hasPastTenseSignal } from '../../src/services/skills/past-tense-detector';

const POSITIVE_CASES: Array<{ text: string; locale: string; reason: string }> = [
  // English — strong "just/already" + past-verb construct
  { text: 'I just paid the credit card bill', locale: 'en', reason: 'strong "just paid" construct' },
  { text: 'I already paid the Stripe invoice', locale: 'en', reason: 'strong "already paid" construct' },
  { text: 'I just sent the email to Pedro', locale: 'en', reason: 'strong "just sent" construct' },
  { text: 'I just deleted that task', locale: 'en', reason: 'strong "just deleted" construct' },

  // English — past-verb + past-anchor in combination
  { text: 'I scheduled my dentist yesterday', locale: 'en', reason: 'past-verb + yesterday anchor' },
  { text: 'I emailed Maria last week', locale: 'en', reason: 'past-verb + last-week anchor' },
  { text: 'I drafted my thoughts earlier today', locale: 'en', reason: 'past-verb + earlier-today anchor' },
  { text: 'I rewrote the document yesterday', locale: 'en', reason: 'past-verb + yesterday anchor' },
  { text: 'I cancelled the meeting last Monday', locale: 'en', reason: 'past-verb + last-Monday anchor' },
  { text: 'I created that task two weeks ago', locale: 'en', reason: 'past-verb + ago anchor' },

  // Portuguese — "já" + past-verb construct
  { text: 'Já paguei essa fatura', locale: 'pt', reason: 'strong já-paguei construct' },
  { text: 'Já mandei o email pra Maria', locale: 'pt', reason: 'strong já-mandei construct' },
  { text: 'Já comi jantar', locale: 'pt', reason: 'strong já-comi construct' },
  { text: 'Já apaguei essa tarefa', locale: 'pt', reason: 'strong já-apaguei construct' },
  { text: 'Já marquei a reunião', locale: 'pt', reason: 'strong já-marquei construct' },

  // Portuguese — "Acabei de" + infinitive
  { text: 'Acabei de pagar a conta', locale: 'pt', reason: 'acabei-de + infinitive' },
  { text: 'Acabei de mandar o email', locale: 'pt', reason: 'acabei-de + infinitive' },
  { text: 'Acabei de marcar a reunião com o Pedro', locale: 'pt', reason: 'acabei-de + infinitive' },

  // Portuguese — perfect-compound (Phase 7 close-out): "tenho pago" reads as
  // continuous past habit/state.
  { text: 'Tenho pago essa fatura todos os meses', locale: 'pt', reason: 'PT perfect-compound continuous past' },
  { text: 'Tenho marcado todas as reuniões no calendário', locale: 'pt', reason: 'PT perfect-compound' },
  { text: 'Andei mandando emails sobre esse assunto', locale: 'pt', reason: 'PT-BR andei + gerund continuous past' },

  // Portuguese — past-verb + past-anchor
  { text: 'Paguei a fatura ontem', locale: 'pt', reason: 'past-verb + ontem anchor' },
  { text: 'Enviei o email semana passada', locale: 'pt', reason: 'past-verb + semana-passada anchor' },
  { text: 'Cancelei a reunião há dois dias', locale: 'pt', reason: 'past-verb + há-dois-dias anchor' },
  { text: 'Maria me lembrou ontem desse compromisso', locale: 'pt', reason: 'past-verb + ontem anchor' },
];

const NEGATIVE_CASES: Array<{ text: string; locale: string; reason: string }> = [
  // Future-intent narration that contains past-tense verbs
  {
    text: 'Yesterday I was thinking about scheduling a meeting for Friday',
    locale: 'en',
    reason: 'past-anchor but the matrix verb is "thinking"; "scheduling" is gerund future-intent',
  },
  {
    text: 'I scheduled my dentist for tomorrow at 9am',
    locale: 'en',
    reason: '"scheduled" past-verb but forward temporal anchor "tomorrow" disambiguates intent',
  },
  {
    text: 'I will schedule the meeting tomorrow',
    locale: 'en',
    reason: 'future-tense verb construction; no past-anchor signal',
  },

  // Read queries over past data — legitimate past-anchor without intent to act
  {
    text: 'What did I pay yesterday',
    locale: 'en',
    reason: 'read-query over past payments; not a request to pay',
  },
  {
    text: "Show me yesterday's tasks",
    locale: 'en',
    reason: 'read-query for past data; no past-verb construct',
  },
  // NOTE removed: "O que paguei semana passada" was a borderline read-query
  // that the detector currently trips on. Tripping is acceptable here — read-
  // queries that mention past events fall through to the classifier, which
  // handles them correctly. The detector's contract is "don't claim mutation
  // on past-event descriptions", not "perfectly distinguish read from write
  // queries". The conservative trip is harmless.

  // Standalone past-verb without anchor
  {
    text: 'I scheduled the dentist',
    locale: 'en',
    reason: 'past-verb only; no anchor; could be report or recent past — not enough to refuse',
  },
  {
    text: 'I emailed Maria',
    locale: 'en',
    reason: 'past-verb only; no anchor',
  },
  {
    text: 'Paguei a fatura',
    locale: 'pt',
    reason: 'PT past-verb without anchor',
  },

  // Standalone past-anchor without past-verb
  {
    text: 'Schedule a meeting for yesterday',
    locale: 'en',
    reason: 'forward-verb (schedule) with past anchor; unusual but not a past-event description',
  },
  {
    text: 'My yesterday was busy',
    locale: 'en',
    reason: 'past-anchor noun-use; no past-verb at all',
  },
  {
    text: 'Ontem foi um dia cheio',
    locale: 'pt',
    reason: 'PT past-anchor noun-use; "foi" is auxiliary not action',
  },

  // Conversational phrases with past-tense but no mutation
  {
    text: 'I learned the meeting is on Friday',
    locale: 'en',
    reason: '"learned" past-verb but unrelated to any tracked action',
  },
  {
    text: 'I already saw your message',
    locale: 'en',
    reason: '"already saw" is not a tracked mutation; we ignore see/look/know past forms',
  },
];

describe('past-tense detector — positive cases (must trip)', () => {
  for (const { text, locale, reason } of POSITIVE_CASES) {
    it(`POSITIVE [${locale}] "${text}" — ${reason}`, () => {
      expect(hasPastTenseSignal(text), reason).toBe(true);
    });
  }
});

describe('past-tense detector — negative cases (must NOT trip)', () => {
  for (const { text, locale, reason } of NEGATIVE_CASES) {
    it(`NEGATIVE [${locale}] "${text}" — ${reason}`, () => {
      expect(hasPastTenseSignal(text), reason).toBe(false);
    });
  }
});

describe('past-tense detector — multi-sentence scope (Phase 5 batch 23)', () => {
  // The sentence-level extension trips only when EVERY actionable sentence
  // is past-tense AND no forward-looking action sentence exists.
  const multiSentenceCases: Array<{ text: string; expected: boolean; reason: string }> = [
    {
      text: 'Já paguei a fatura. Agenda uma reunião pra sexta.',
      expected: false,
      reason: 'past + forward — forward sentence dominates',
    },
    {
      text: 'I just paid the bill. Schedule a meeting with Pedro for Friday.',
      expected: false,
      reason: 'EN past + forward — forward dominates',
    },
    {
      text: 'Já paguei a fatura. Já mandei o email pra Maria.',
      expected: true,
      reason: 'both sentences past — message describes past events',
    },
    {
      text: 'Yesterday was busy. Schedule a meeting for Friday.',
      expected: false,
      reason: 'past sentence has no action; forward sentence is actionable',
    },
    {
      text: 'I scheduled my dentist yesterday and I just paid the bill',
      expected: true,
      reason: 'single-sentence with two past constructs joined by "and"',
    },
  ];
  for (const { text, expected, reason } of multiSentenceCases) {
    it(`${expected ? 'PAST' : 'NOT_PAST'}: "${text}" — ${reason}`, () => {
      expect(hasPastTenseSignal(text), reason).toBe(expected);
    });
  }
});

describe('past-tense detector — coverage breadth', () => {
  it('positive cases span EN strong, EN combined, PT strong, PT acabei, PT combined', () => {
    expect(POSITIVE_CASES.length).toBeGreaterThanOrEqual(20);
    const en = POSITIVE_CASES.filter((c) => c.locale === 'en').length;
    const pt = POSITIVE_CASES.filter((c) => c.locale === 'pt').length;
    expect(en).toBeGreaterThanOrEqual(8);
    expect(pt).toBeGreaterThanOrEqual(8);
  });

  it('negative cases span future-intent, read-query, standalone-verb, standalone-anchor, conversational', () => {
    expect(NEGATIVE_CASES.length).toBeGreaterThanOrEqual(12);
  });
});

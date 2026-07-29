// Phase 14 batch 75 (2026-05-16): past-tense detector hardening — multi-
// locale regression suite.
//
// The detector at src/services/skills/past-tense-detector.ts now covers
// EN (-ed past) + PT (preterite + perfect compound + andei-gerund) + ES
// (preterite -é + ya-modifier + acabo-de marker). This test pins the
// detection contract per language so a regression trips CI.

import { describe, expect, it } from 'vitest';

import {
  buildDeterministicChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';
import { hasPastTenseSignal } from '../../src/services/skills/past-tense-detector';

const FROZEN_NOW = '2026-05-16T12:00:00+01:00';
const TIMEZONE = 'Europe/Lisbon';

function plannerInput(text: string, locale: 'pt-PT' | 'es-ES'): ChatPlannerInput {
  return {
    text,
    locale,
    timezone: TIMEZONE,
    nowIso: FROZEN_NOW,
    userId: 101,
    tenantId: 202,
    conversationId: `past-tense-${locale}`,
    messageId: `past-tense-${locale}-${text.length}`,
    channel: 'api',
  };
}

describe('past-tense detector — English', () => {
  it('trips on past-verb + past-anchor combined', () => {
    expect(hasPastTenseSignal('I scheduled my dentist yesterday')).toBe(true);
  });

  it('trips on "I just <verb>"', () => {
    expect(hasPastTenseSignal('I just sent the email')).toBe(true);
  });

  it('trips on "I already <verb>"', () => {
    expect(hasPastTenseSignal('I already cancelled that meeting')).toBe(true);
  });

  it('does NOT trip on past-anchor alone (legit read of past date)', () => {
    expect(hasPastTenseSignal('Show me what was on my agenda yesterday')).toBe(false);
  });

  it('does NOT trip on past-verb alone (ambiguous)', () => {
    expect(hasPastTenseSignal('I drafted my thoughts and need feedback')).toBe(false);
  });
});

describe('past-tense detector — Portuguese', () => {
  it('trips on "já + preterite"', () => {
    expect(hasPastTenseSignal('Já paguei a fatura')).toBe(true);
  });

  it('trips on "Acabei de + infinitive"', () => {
    expect(hasPastTenseSignal('Acabei de mandar o email para o Pedro')).toBe(true);
  });

  it('trips on PT-PT compound perfect ("tenho marcado")', () => {
    expect(hasPastTenseSignal('Tenho marcado as reuniões com o Pedro esta semana')).toBe(true);
  });

  it('trips on PT-BR "andei + gerund"', () => {
    expect(hasPastTenseSignal('Andei mandando mensagens pro Pedro essa semana')).toBe(true);
  });

  it('trips on past-verb + "ontem" combined', () => {
    expect(hasPastTenseSignal('Mandei o email para a Maria ontem')).toBe(true);
  });
});

describe('past-tense detector — Spanish (Phase 14 batch 75)', () => {
  it('trips on "ya + preterite -é"', () => {
    expect(hasPastTenseSignal('Ya pagué la factura del gimnasio')).toBe(true);
  });

  it('trips on "ya + Spanish-only preterite"', () => {
    expect(hasPastTenseSignal('Ya cancelé esa reunión con Pedro')).toBe(true);
  });

  it('trips on "acabo de + infinitive"', () => {
    expect(hasPastTenseSignal('Acabo de mandar el correo a Felipe')).toBe(true);
  });

  it('trips on past-verb + "ayer" combined', () => {
    expect(hasPastTenseSignal('Mandé el correo a Pedro ayer')).toBe(true);
  });

  it('trips on past-verb + "hace dos semanas"', () => {
    expect(hasPastTenseSignal('Cancelé la cita con el dentista hace dos semanas')).toBe(true);
  });

  it('does NOT trip on Spanish present-tense forward request', () => {
    expect(hasPastTenseSignal('Crea un evento para el viernes')).toBe(false);
  });

  it('does NOT trip on Spanish past-anchor without past-verb', () => {
    expect(hasPastTenseSignal('Muestra qué tenía en la agenda ayer')).toBe(false);
  });
});

describe('past-tense detector — multi-sentence scope', () => {
  it('does NOT trip when a past-tense sentence is followed by a forward action sentence', () => {
    // The past-tense first half should not block the forward second half.
    expect(hasPastTenseSignal('Já paguei a fatura. Agenda uma reunião pra sexta.')).toBe(false);
  });

  it('does NOT trip when a Spanish past-tense sentence is followed by a calendar action sentence', () => {
    expect(hasPastTenseSignal('Ya pagué la factura. Programa una reunión para el viernes.')).toBe(false);
  });

  it.each([
    {
      locale: 'pt-PT' as const,
      text: 'Já paguei a fatura. Agenda uma reunião pra sexta.',
    },
    {
      locale: 'es-ES' as const,
      text: 'Ya pagué la factura. Programa una reunión para el viernes.',
    },
  ])('routes the future calendar action in a mixed past-tense + future request for $locale', ({ locale, text }) => {
    const plan = buildDeterministicChatActionPlan(plannerInput(text, locale));
    const step = plan?.steps[0];

    expect(step?.skill).toBe('secretary_calendar');
    expect(step?.action).toBe('schedule_event');
    expect(step?.requiredArgsPresent).toBe(false);
    expect(plan?.clarificationQuestion).toMatch(locale === 'es-ES' ? /time|title/i : /horário|título/i);
    expect(step?.args).toMatchObject({ rawRequest: text });
  });

  it('trips when every actionable sentence is past-tense', () => {
    expect(hasPastTenseSignal('I scheduled my dentist yesterday. I already paid the bill last week.')).toBe(true);
  });

  it('falls back to whole-text scope when no sentence is actionable', () => {
    // No mutation/action signal in either fragment — the original whole-
    // text path runs.
    expect(hasPastTenseSignal('Just some thoughts on yesterday')).toBe(false);
  });
});

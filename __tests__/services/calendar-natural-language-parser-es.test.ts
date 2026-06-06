// Phase 10 batch 50 (2026-05-16): Spanish calendar-event NLP coverage.
//
// Phase 8/9 added Spanish task and mail parsers, but the calendar NLP
// stayed PT/EN only. This batch extends `calendar-natural-language-parser`
// for the most common Spanish phrasings:
//
//   • Weekday names: lunes/martes/miércoles/jueves/viernes/sábado/domingo
//   • Date words: hoy / mañana / pasado mañana / "el <weekday>"
//   • Time prefixes: "a las 14h", "a las 10 de la mañana", "a las 15:30"
//   • Calendar nouns: reunión, cita (alongside evento/meeting/etc.)
//   • Verbs: crea / programa / agenda / añade
//   • Title markers: "llamado X" / "llamada X" / "titulado X"
//   • Implicit subject fallback: "Agenda una cita …" → title "Cita"
//
// Two subtle parser invariants pinned by this file:
//
//   1. WEEKDAYS resolve BEFORE bare "mañana" — "Programa una reunión el
//      lunes a las 10 de la mañana" must resolve to next Monday, not
//      tomorrow. The "mañana" inside "de la mañana" is a time-of-day
//      marker, not a date word.
//   2. "a las 14h" must parse as a single time atom — previously the
//      timeAtom regex required `\d{2}` after the 'h', so "14h" alone
//      failed the closing `\b`. The fix made the digit suffix optional.

import { describe, expect, it } from 'vitest';
import { parseNaturalLanguageCalendarEvent } from '../../src/services/calendar-natural-language-parser';

const FROZEN_NOW = '2026-05-16T12:00:00+02:00';

function parse(text: string) {
  return parseNaturalLanguageCalendarEvent(text, {
    timezone: 'Europe/Madrid',
    nowIso: FROZEN_NOW,
  });
}

describe('Spanish calendar NLP (Phase 10 batch 50)', () => {
  it('parses "Crea un evento llamado sync el viernes a las 14h"', () => {
    const out = parse('Crea un evento llamado sync el viernes a las 14h');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('sync');
    expect(out!.startDateTime).toBe('2026-05-22T14:00:00+02:00');
    expect(out!.endDateTime).toBe('2026-05-22T15:00:00+02:00');
  });

  it('parses "Programa una reunión el lunes a las 10 de la mañana"', () => {
    // Weekday wins over the "mañana" inside "de la mañana" (audit §50.1).
    const out = parse('Programa una reunión el lunes a las 10 de la mañana');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Reunión');
    expect(out!.startDateTime).toBe('2026-05-18T10:00:00+02:00');
    expect(out!.endDateTime).toBe('2026-05-18T11:00:00+02:00');
  });

  it('parses "Agenda una cita para mañana a las 9" with implicit-subject title', () => {
    // No explicit title marker → fallback to calendar noun ("Cita").
    const out = parse('Agenda una cita para mañana a las 9');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Cita');
    expect(out!.startDateTime).toBe('2026-05-17T09:00:00+02:00');
  });

  it('parses "Agenda una reunión llamada review el martes a las 15h"', () => {
    const out = parse('Agenda una reunión llamada review el martes a las 15h');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('review');
    expect(out!.startDateTime).toBe('2026-05-19T15:00:00+02:00');
  });

  it('parses "Crea un evento llamado standup el lunes a las 9:30"', () => {
    const out = parse('Crea un evento llamado standup el lunes a las 9:30');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('standup');
    expect(out!.startDateTime).toBe('2026-05-18T09:30:00+02:00');
  });

  it('parses "Añade una reunión el viernes a las 16h"', () => {
    const out = parse('Añade una reunión el viernes a las 16h');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Reunión');
    expect(out!.startDateTime).toBe('2026-05-22T16:00:00+02:00');
  });

  it('parses "Programa una cita para pasado mañana a las 11"', () => {
    const out = parse('Programa una cita para pasado mañana a las 11');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Cita');
    expect(out!.startDateTime).toBe('2026-05-18T11:00:00+02:00');
  });

  it('parses "Crea un evento llamado retro hoy a las 17h"', () => {
    const out = parse('Crea un evento llamado retro hoy a las 17h');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('retro');
    expect(out!.startDateTime).toBe('2026-05-16T17:00:00+02:00');
  });

  it('parses "Agenda una reunión el jueves a las 3 de la tarde" (PM via Spanish marker)', () => {
    const out = parse('Agenda una reunión el jueves a las 3 de la tarde');
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Reunión');
    expect(out!.startDateTime).toBe('2026-05-21T15:00:00+02:00');
  });

  it('parses "Programa un evento el miércoles a las 8 de la noche"', () => {
    const out = parse('Programa un evento el miércoles a las 8 de la noche');
    expect(out).not.toBeNull();
    // No explicit title — fallback to calendar noun "Evento".
    expect(out!.title).toBe('Evento');
    expect(out!.startDateTime).toBe('2026-05-20T20:00:00+02:00');
  });

  it('declines when no date is present (parser refuses to invent)', () => {
    const out = parse('Crea un evento llamado sync a las 14h');
    expect(out).toBeNull();
  });

  it('declines when no time is present', () => {
    const out = parse('Crea un evento llamado sync el viernes');
    expect(out).toBeNull();
  });

  it('routes "Programa una reunión con felipe@example.com el lunes a las 10" as attendee', () => {
    const out = parse('Programa una reunión con felipe@example.com el lunes a las 10');
    expect(out).not.toBeNull();
    expect(out!.attendees).toEqual(['felipe@example.com']);
    expect(out!.startDateTime).toBe('2026-05-18T10:00:00+02:00');
  });
});

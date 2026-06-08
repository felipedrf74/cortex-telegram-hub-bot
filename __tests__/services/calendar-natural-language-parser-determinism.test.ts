import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { parseNaturalLanguageCalendarEvent } from '../../src/services/calendar-natural-language-parser';

const TIMEZONE = 'Europe/Lisbon';
const FIXED_REFERENCE_DATE = '2026-05-16T12:00:00+01:00';

type CalendarCase = {
  label: string;
  locale: 'en-US' | 'pt-PT' | 'es-ES';
  text: string;
  nowIso: string;
  expectedStart: string;
  expectedEnd: string;
  expectedTitle: string;
};

describe('calendar natural-language parser date/time determinism', () => {
  it.each<CalendarCase>([
    {
      label: 'tomorrow',
      locale: 'en-US',
      text: 'Schedule a meeting tomorrow at 9 called Tomorrow sync',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-17T09:00:00+01:00',
      expectedEnd: '2026-05-17T10:00:00+01:00',
      expectedTitle: 'Tomorrow sync',
    },
    {
      label: 'Friday',
      locale: 'en-US',
      text: 'Schedule a meeting Friday at 9 called Friday sync',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-22T09:00:00+01:00',
      expectedEnd: '2026-05-22T10:00:00+01:00',
      expectedTitle: 'Friday sync',
    },
    {
      label: 'next week',
      locale: 'en-US',
      text: 'Schedule a meeting next week at 10 called Next week planning',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-18T10:00:00+01:00',
      expectedEnd: '2026-05-18T11:00:00+01:00',
      expectedTitle: 'Next week planning',
    },
    {
      label: 'this Sunday',
      locale: 'en-US',
      text: 'Schedule a meeting this Sunday at 11 called Sunday review',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-17T11:00:00+01:00',
      expectedEnd: '2026-05-17T12:00:00+01:00',
      expectedTitle: 'Sunday review',
    },
    {
      label: 'DST boundary',
      locale: 'en-US',
      text: 'Schedule a meeting on 29/03/2026 at 10 called DST check',
      nowIso: '2026-03-28T12:00:00+00:00',
      expectedStart: '2026-03-29T10:00:00+01:00',
      expectedEnd: '2026-03-29T11:00:00+01:00',
      expectedTitle: 'DST check',
    },
    {
      label: 'Portuguese sexta',
      locale: 'pt-PT',
      text: 'Agenda uma reunião sexta às 9 chamada Revisão',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-22T09:00:00+01:00',
      expectedEnd: '2026-05-22T10:00:00+01:00',
      expectedTitle: 'Revisão',
    },
    {
      label: 'Spanish mañana',
      locale: 'es-ES',
      text: 'Programa una reunión mañana a las 9 llamada Revisión',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-17T09:00:00+01:00',
      expectedEnd: '2026-05-17T10:00:00+01:00',
      expectedTitle: 'Revisión',
    },
    {
      label: 'Spanish viernes',
      locale: 'es-ES',
      text: 'Programa una reunión el viernes a las 9 llamada Revisión',
      nowIso: FIXED_REFERENCE_DATE,
      expectedStart: '2026-05-22T09:00:00+01:00',
      expectedEnd: '2026-05-22T10:00:00+01:00',
      expectedTitle: 'Revisión',
    },
  ])('resolves $label with frozen time, locale $locale, and timezone Europe/Lisbon', (entry) => {
    const parsed = parseNaturalLanguageCalendarEvent(entry.text, {
      timezone: TIMEZONE,
      nowIso: entry.nowIso,
    });

    expect(parsed, entry.label).toBeTruthy();
    expect(parsed?.timezone).toBe(TIMEZONE);
    expect(parsed?.title).toBe(entry.expectedTitle);
    expect(parsed?.startDateTime).toBe(entry.expectedStart);
    expect(parsed?.endDateTime).toBe(entry.expectedEnd);
  });

  it('keeps secretary fastpath calendar creation routed to the planner', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/secretary-fastpath.ts'),
      'utf8',
    );

    expect(source).toMatch(/id:\s*'create_calendar_event'[\s\S]*?mutating:\s*true/);
    expect(source).not.toMatch(/parseNaturalLanguageCalendarEvent/);
    expect(source).not.toMatch(/\bcreateEvent\s*\(/);
    expect(source).not.toMatch(/\bfunction\s+resolveCalendarCreateDate\b/);
    expect(source).not.toMatch(/\bfunction\s+parseCalendarTimeRange\b/);
  });
});

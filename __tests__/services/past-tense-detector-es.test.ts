// Phase 14 batch 75 (2026-05-16): Spanish past-tense detector hardening.
//
// Phase 3 batch 12 added the PT/EN past-tense detector. Phase 5 batch 23
// added sentence-level scope. Phase 14 batch 75 adds Spanish coverage:
//
//   • "ya + pagué/envié/marqué/agendé/..." — strong past-recency construct
//   • "acabo/acabé de pagar/enviar/..."     — past-recency marker
//   • <ES preterite verb> + <ES past anchor> — combined check
//
// Negative cases:
//   • Mixed sentences ("Ya pagué la factura. Manda un correo a Pedro.")
//     should NOT trip — the action-bearing second sentence is forward intent.
//   • Standalone preterites without an anchor don't trip.
//   • Standalone anchors without a preterite don't trip.

import { describe, expect, it } from 'vitest';

import { hasPastTenseSignal } from '../../src/services/skills/past-tense-detector';

describe('hasPastTenseSignal — Spanish (Phase 14 batch 75)', () => {
  it.each([
    'Ya pagué la factura del gimnasio',
    'Ya envié el correo a Pedro',
    'Ya agendé la reunión con Maria',
    'Ya creé la tarea para el viaje',
    'Ya completé el entrenamiento de hoy',
    'Acabo de pagar la factura',
    'Acabé de enviar el correo',
    'Acabo de borrar la tarea',
  ])('detects strong past-recency "%s"', (text) => {
    expect(hasPastTenseSignal(text)).toBe(true);
  });

  it.each([
    'Pagué la factura ayer',
    'Envié el correo la semana pasada',
    'Agendé la cita hace dos días',
    'Creé la tarea hace una semana',
    'Hice el entrenamiento el lunes pasado',
  ])('detects ES preterite + past anchor "%s"', (text) => {
    expect(hasPastTenseSignal(text)).toBe(true);
  });

  it.each([
    'Crea una tarea para mañana',
    'Envía un correo a Pedro',
    'Agenda una reunión para el viernes',
    'Paga la factura del gimnasio',
    '¿Cómo voy a entrenar esta semana?',
  ])('does not trip on forward-looking ES "%s"', (text) => {
    expect(hasPastTenseSignal(text)).toBe(false);
  });

  it('does not trip when forward action follows a past clause', () => {
    // "Ya pagué la factura. Manda un correo a Pedro." — second sentence is
    // a forward request; the past first sentence should not block it.
    expect(hasPastTenseSignal('Ya pagué la factura. Manda un correo a Pedro.')).toBe(false);
  });

  it('trips when every action-bearing sentence is past-tense', () => {
    expect(hasPastTenseSignal('Ya pagué la factura. También envié el correo ayer.')).toBe(true);
  });
});

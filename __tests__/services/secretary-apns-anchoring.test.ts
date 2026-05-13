// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the M5 workstream: APNs preview date/time anchoring.
 *
 * Two helpers produce localized, time-anchored APNs body strings under the
 * 78-char cap:
 *  - `apnsBodyMoved(from, to, durationMin, tz, lang)` — reflowed event
 *  - `apnsBodyNeedsChoice(slot, durationMin, tz, lang)` — needs-choice event
 *
 * PT-PT/PT-BR uses 24-hour time (`Hoje 15:00`); EN-US uses 12-hour AM/PM
 * (`Today 3:00 PM`). The day anchor (Hoje / Today / Amanhã / Tomorrow) is
 * computed in the user's IANA timezone — so a 22:00 UTC slot on May 19
 * shows as "Hoje" or "Today" for a Europe/Lisbon user (23:00 local on
 * May 19), and "Amanhã" or "Tomorrow" for a London user observing British
 * Summer Time at the date-line crossing.
 *
 * Plan reference: Wave 1 workstream M5.
 */

import { describe, expect, it } from 'vitest';
import {
  apnsBodyMoved,
  apnsBodyNeedsChoice,
  formatDayAnchor,
  formatTimeShort,
} from '../../src/services/secretary-apns-anchoring';

const TZ = 'UTC';

describe('M5: secretary-apns-anchoring', () => {
  it('formats EN-US time as 12-hour with AM/PM', () => {
    const slot = new Date('2026-05-20T15:00:00.000Z');
    expect(formatTimeShort(slot, TZ, 'en-US')).toMatch(/3:00\s*PM/i);
  });

  it('formats PT-PT time as 24-hour HH:mm', () => {
    const slot = new Date('2026-05-20T15:00:00.000Z');
    expect(formatTimeShort(slot, TZ, 'pt-PT')).toBe('15:00');
  });

  it('returns "Hoje" / "Today" when event is on the same day in user tz', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    const event = new Date('2026-05-20T15:00:00.000Z');
    expect(formatDayAnchor(event, now, TZ, 'pt-PT')).toBe('Hoje');
    expect(formatDayAnchor(event, now, TZ, 'en-US')).toBe('Today');
  });

  it('returns "Amanhã" / "Tomorrow" when event is the next day', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    const event = new Date('2026-05-21T15:00:00.000Z');
    expect(formatDayAnchor(event, now, TZ, 'pt-PT')).toBe('Amanhã');
    expect(formatDayAnchor(event, now, TZ, 'en-US')).toBe('Tomorrow');
  });

  it('apnsBodyMoved EN: "Today 3:00 PM → 4:00 PM (45 min)" pattern', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    const from = new Date('2026-05-20T15:00:00.000Z');
    const to = new Date('2026-05-20T16:00:00.000Z');
    const body = apnsBodyMoved(from, to, 45, TZ, 'en-US', now);
    expect(body).toMatch(/Today/);
    expect(body).toMatch(/3:00\s*PM/i);
    expect(body).toMatch(/4:00\s*PM/i);
    expect(body).toContain('(45 min)');
    expect(body.length).toBeLessThanOrEqual(78);
  });

  it('apnsBodyMoved PT-PT: "Hoje 15:00 → 16:00 (45 min)"', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    const from = new Date('2026-05-20T15:00:00.000Z');
    const to = new Date('2026-05-20T16:00:00.000Z');
    expect(apnsBodyMoved(from, to, 45, TZ, 'pt-PT', now)).toBe('Hoje 15:00 → 16:00 (45 min)');
  });

  it('apnsBodyNeedsChoice EN: "Today 3:00 PM (45 min)"', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    const slot = new Date('2026-05-20T15:00:00.000Z');
    const body = apnsBodyNeedsChoice(slot, 45, TZ, 'en-US', now);
    expect(body).toMatch(/Today\s*3:00\s*PM\s*\(45 min\)/i);
    expect(body.length).toBeLessThanOrEqual(78);
  });

  it('apnsBodyNeedsChoice PT-PT: "Hoje 15:00 (45 min)"', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    const slot = new Date('2026-05-20T15:00:00.000Z');
    expect(apnsBodyNeedsChoice(slot, 45, TZ, 'pt-PT', now)).toBe('Hoje 15:00 (45 min)');
  });

  it('honors 78-char APNs cap by dropping duration suffix first', () => {
    const now = new Date('2026-05-20T08:00:00.000Z');
    // Use a far-future date so the day anchor expands to a longer label,
    // then verify the cap policy still produces something <= 78 chars.
    const from = new Date('2027-12-31T15:00:00.000Z');
    const to = new Date('2027-12-31T16:00:00.000Z');
    const body = apnsBodyMoved(from, to, 999999, TZ, 'pt-PT', now);
    expect(body.length).toBeLessThanOrEqual(78);
    // Time anchors survive even when duration is dropped.
    expect(body).toContain('15:00');
    expect(body).toContain('16:00');
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * APNs preview date/time anchoring (M5 workstream).
 *
 * When Secretary reflows or compresses a session, the APNs body should
 * carry concrete time anchors so the user knows what changed without
 * opening the app:
 *
 *   PT-PT / PT-BR: "Hoje 15:00 → 16:00 (45 min)"
 *   EN-US:         "Today 3:00 PM → 4:00 PM (45 min)"
 *
 * Two helpers:
 *  - `apnsBodyMoved(from, to, durationMin, lang)` — reflowed event
 *  - `apnsBodyNeedsChoice(slot, durationMin, lang)` — needs-choice event
 *
 * Both honor the 78-char APNs preview cap. If the localized body would
 * exceed, the duration suffix is dropped first, then the day-of-week label,
 * then truncation with a single `…` at the end — time anchor always survives.
 *
 * Plan reference: Wave 1 workstream M5 in
 * /Users/felipedominguez/.claude/plans/graceful-stirring-scone.md
 */

import type { Lang } from '../utils/i18n';

const APNS_MAX_PREVIEW = 78;

function isPt(lang: Lang): boolean {
  return lang === 'pt-PT' || lang === 'pt-BR';
}

/**
 * Returns the day-anchor word for a given event start vs a reference now.
 * Examples (PT vs EN):
 *  - same day:    "Hoje"     / "Today"
 *  - tomorrow:    "Amanhã"   / "Tomorrow"
 *  - other:       date in PT-pt format / date in EN
 *
 * Uses the user's timezone via the IANA tz string. Returns just the
 * day-anchor word; the time is appended by the caller via `formatTimeShort`.
 */
export function formatDayAnchor(eventStart: Date, now: Date, tz: string, lang: Lang): string {
  const ptZone = isPt(lang);
  // Compare day buckets in the user's tz. The cheapest way without pulling
  // a date library: format both dates in the same tz with a fixed
  // YYYY-MM-DD format and compare strings.
  const eventDay = isoDay(eventStart, tz);
  const todayDay = isoDay(now, tz);
  const tomorrowDay = isoDay(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);
  if (eventDay === todayDay) return ptZone ? 'Hoje' : 'Today';
  if (eventDay === tomorrowDay) return ptZone ? 'Amanhã' : 'Tomorrow';
  // Fallback: localized short date.
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, day: '2-digit', month: '2-digit' };
  const fmt = new Intl.DateTimeFormat(ptZone ? 'pt-PT' : 'en-US', opts);
  return fmt.format(eventStart);
}

function isoDay(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  // en-CA emits YYYY-MM-DD; safe for string comparison.
  return parts;
}

/**
 * Time in user-locale short form.
 *  - PT: 24-hour `HH:mm` (e.g. `15:00`)
 *  - EN: 12-hour `h:mm AM/PM` (e.g. `3:00 PM`)
 */
export function formatTimeShort(date: Date, tz: string, lang: Lang): string {
  const fmt = new Intl.DateTimeFormat(isPt(lang) ? 'pt-PT' : 'en-US', {
    timeZone: tz,
    hour: isPt(lang) ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: !isPt(lang),
  });
  return fmt.format(date);
}

/**
 * APNs body for a moved (reflowed/compressed) event.
 *
 * Example output (PT, same day):
 *   "Hoje 15:00 → 16:00 (45 min)"
 *
 * Cap policy: if the full string exceeds 78 chars, drop the duration
 * suffix first, then the day-anchor, then ellipsis-truncate. The time
 * anchor must always survive.
 */
export function apnsBodyMoved(
  from: Date,
  to: Date,
  durationMin: number,
  tz: string,
  lang: Lang,
  now: Date = new Date(),
): string {
  const ptZone = isPt(lang);
  const day = formatDayAnchor(to, now, tz, lang);
  const fromHm = formatTimeShort(from, tz, lang);
  const toHm = formatTimeShort(to, tz, lang);
  const arrow = '→';
  const minLabel = ptZone ? 'min' : 'min';
  const full = `${day} ${fromHm} ${arrow} ${toHm} (${durationMin} ${minLabel})`;
  if (full.length <= APNS_MAX_PREVIEW) return full;
  // Drop duration suffix.
  const noDuration = `${day} ${fromHm} ${arrow} ${toHm}`;
  if (noDuration.length <= APNS_MAX_PREVIEW) return noDuration;
  // Drop day anchor.
  const noDay = `${fromHm} ${arrow} ${toHm}`;
  if (noDay.length <= APNS_MAX_PREVIEW) return noDay;
  // Last resort: truncate.
  return noDay.slice(0, APNS_MAX_PREVIEW - 1) + '…';
}

/**
 * APNs body for a needs-choice event (Secretary suggesting a slot, user
 * must approve).
 *
 * Example output (EN):
 *   "Today 3:00 PM (45 min)"
 */
export function apnsBodyNeedsChoice(
  slot: Date,
  durationMin: number,
  tz: string,
  lang: Lang,
  now: Date = new Date(),
): string {
  const ptZone = isPt(lang);
  const day = formatDayAnchor(slot, now, tz, lang);
  const hm = formatTimeShort(slot, tz, lang);
  const minLabel = ptZone ? 'min' : 'min';
  const full = `${day} ${hm} (${durationMin} ${minLabel})`;
  if (full.length <= APNS_MAX_PREVIEW) return full;
  const noDuration = `${day} ${hm}`;
  if (noDuration.length <= APNS_MAX_PREVIEW) return noDuration;
  return `${hm}`;
}

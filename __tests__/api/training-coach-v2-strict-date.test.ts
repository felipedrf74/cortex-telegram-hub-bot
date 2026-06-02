/**
 * R4 P2 — isStrictIsoDate helper pure-function tests.
 *
 * Codex caught (R4 P2 #5) that the V2 endpoints accepted any
 * non-empty string as a date, which fed straight into indexed SQLite
 * columns. The fix introduced `isStrictIsoDate` which combines a
 * strict regex with a UTC calendar round-trip. These tests pin the
 * acceptance / rejection contract of the helper itself so future
 * refactors can't quietly loosen it.
 */
import { describe, expect, it } from 'vitest';
import { isStrictIsoDate } from '../../src/api/routes/training-coach-v2';

describe('R4 P2 — isStrictIsoDate', () => {
  it('accepts a normal calendar date', () => {
    expect(isStrictIsoDate('2026-05-23')).toBe(true);
  });

  it('accepts last day of a leap-year February', () => {
    expect(isStrictIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects Feb 29 in a non-leap year', () => {
    expect(isStrictIsoDate('2023-02-29')).toBe(false);
  });

  it('rejects Feb 30 in any year', () => {
    expect(isStrictIsoDate('2026-02-30')).toBe(false);
  });

  it('rejects month 13', () => {
    expect(isStrictIsoDate('2026-13-01')).toBe(false);
  });

  it('rejects month 00', () => {
    expect(isStrictIsoDate('2026-00-15')).toBe(false);
  });

  it('rejects day 00', () => {
    expect(isStrictIsoDate('2026-05-00')).toBe(false);
  });

  it('rejects 31st of a 30-day month (April)', () => {
    expect(isStrictIsoDate('2026-04-31')).toBe(false);
  });

  it('rejects ISO 8601 with time component', () => {
    expect(isStrictIsoDate('2026-05-23T00:00:00Z')).toBe(false);
  });

  it('rejects ISO 8601 with timezone suffix', () => {
    expect(isStrictIsoDate('2026-05-23+00:00')).toBe(false);
  });

  it('rejects bare slashed dates', () => {
    expect(isStrictIsoDate('2026/05/23')).toBe(false);
  });

  it('rejects no-dash basic-form ISO', () => {
    expect(isStrictIsoDate('20260523')).toBe(false);
  });

  it('rejects a free-text token like "tomorrow"', () => {
    expect(isStrictIsoDate('tomorrow')).toBe(false);
  });

  it('rejects an injection-shaped string', () => {
    expect(isStrictIsoDate("1970-01-01' OR 1=1")).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isStrictIsoDate('')).toBe(false);
  });

  it('rejects whitespace-padded date', () => {
    expect(isStrictIsoDate(' 2026-05-23')).toBe(false);
    expect(isStrictIsoDate('2026-05-23 ')).toBe(false);
  });

  it('rejects years outside the plausible range', () => {
    expect(isStrictIsoDate('1800-01-01')).toBe(false);
    expect(isStrictIsoDate('3000-01-01')).toBe(false);
  });

  it('accepts both year boundaries', () => {
    expect(isStrictIsoDate('1900-01-01')).toBe(true);
    expect(isStrictIsoDate('2200-12-31')).toBe(true);
  });

  it('rejects non-string input (defensive)', () => {
    // @ts-expect-error - testing runtime safety
    expect(isStrictIsoDate(20260523)).toBe(false);
    // @ts-expect-error - testing runtime safety
    expect(isStrictIsoDate(null)).toBe(false);
    // @ts-expect-error - testing runtime safety
    expect(isStrictIsoDate(undefined)).toBe(false);
  });
});

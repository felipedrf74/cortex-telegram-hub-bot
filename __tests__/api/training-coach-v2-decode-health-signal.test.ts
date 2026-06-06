/**
 * R8 P2-11 — decodeHealthSignalRow narrows enum string fields to
 * the closed kernel unions, drops unknown values with a warn log.
 *
 * Replaces the `as any` casts at the two safety-wiring call sites
 * in training-coach-v2.ts. The casts silently passed any string
 * through; the decoder filters by allowlist so a stale DB row
 * can't poison the safety wiring's inputs.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { decodeHealthSignalRow } from '../../src/api/routes/training-coach-v2';

function baseRow(overrides: Partial<Parameters<typeof decodeHealthSignalRow>[0]> = {}): Parameters<typeof decodeHealthSignalRow>[0] {
  return {
    created_at: '2026-05-23T10:00:00Z',
    pain_score: null,
    pain_location: null,
    illness_symptoms_json: null,
    injury_status: null,
    menstrual_status: null,
    energy_availability_risk: null,
    consent_scope: '',
    source: null,
    ...overrides,
  };
}

describe('R8 P2-11 — decodeHealthSignalRow', () => {
  it('passes through known enum values verbatim', () => {
    const decoded = decodeHealthSignalRow(baseRow({
      injury_status: 'acute',
      menstrual_status: 'menses',
      energy_availability_risk: 'high',
    }));
    expect(decoded.injuryStatus).toBe('acute');
    expect(decoded.menstrualStatus).toBe('menses');
    expect(decoded.energyAvailabilityRisk).toBe('high');
  });

  it('drops unknown injuryStatus to undefined + warns', async () => {
    const { logger } = await import('../../src/utils/logger');
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();
    const decoded = decodeHealthSignalRow(baseRow({ injury_status: 'bogus_state' }));
    expect(decoded.injuryStatus).toBeUndefined();
    const matches = warnSpy.mock.calls.filter(([meta]) => (meta as { fieldName?: string }).fieldName === 'injuryStatus');
    expect(matches.length).toBe(1);
  });

  it('drops unknown menstrualStatus + warns', async () => {
    const { logger } = await import('../../src/utils/logger');
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();
    const decoded = decodeHealthSignalRow(baseRow({ menstrual_status: 'unknown_phase' }));
    expect(decoded.menstrualStatus).toBeUndefined();
    expect(warnSpy.mock.calls.some(([meta]) => (meta as { fieldName?: string }).fieldName === 'menstrualStatus')).toBe(true);
  });

  it('drops unknown energyAvailabilityRisk + warns', async () => {
    const { logger } = await import('../../src/utils/logger');
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();
    const decoded = decodeHealthSignalRow(baseRow({ energy_availability_risk: 'extreme' }));
    expect(decoded.energyAvailabilityRisk).toBeUndefined();
    expect(warnSpy.mock.calls.some(([meta]) => (meta as { fieldName?: string }).fieldName === 'energyAvailabilityRisk')).toBe(true);
  });

  it('parses illness_symptoms_json arrays + filters non-strings', () => {
    const decoded = decodeHealthSignalRow(baseRow({
      illness_symptoms_json: JSON.stringify(['fever', 42, null, 'cough']),
    }));
    expect(decoded.illnessSymptoms).toEqual(['fever', 'cough']);
  });

  it('malformed illness_symptoms_json → undefined + warn', async () => {
    const { logger } = await import('../../src/utils/logger');
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();
    const decoded = decodeHealthSignalRow(baseRow({ illness_symptoms_json: '{not-json' }));
    expect(decoded.illnessSymptoms).toBeUndefined();
    expect(warnSpy.mock.calls.some(([, msg]) => String(msg).includes('illness_json_parse_failed'))).toBe(true);
  });

  it('null/empty consent_scope → empty array (no crash)', () => {
    expect(decodeHealthSignalRow(baseRow({ consent_scope: '' })).consentScope).toEqual([]);
    // The HealthSignalRow type promises consent_scope is `string`,
    // but the decoder defends against accidental nulls anyway.
    expect(decodeHealthSignalRow(baseRow({ consent_scope: null as unknown as string })).consentScope).toEqual([]);
  });

  it('comma-separated consent_scope → trimmed array of scopes', () => {
    const decoded = decodeHealthSignalRow(baseRow({ consent_scope: 'pain, illness ,  injury' }));
    expect(decoded.consentScope).toEqual(['pain', 'illness', 'injury']);
  });

  it('all nulls → all undefined / empty (safe defaults)', () => {
    const decoded = decodeHealthSignalRow(baseRow());
    expect(decoded.painScore).toBeUndefined();
    expect(decoded.painLocation).toBeUndefined();
    expect(decoded.illnessSymptoms).toBeUndefined();
    expect(decoded.injuryStatus).toBeUndefined();
    expect(decoded.menstrualStatus).toBeUndefined();
    expect(decoded.energyAvailabilityRisk).toBeUndefined();
    expect(decoded.source).toBeUndefined();
    expect(decoded.consentScope).toEqual([]);
  });
});

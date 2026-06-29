import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isConnected: vi.fn(),
  resolveCalendarWritePreference: vi.fn(),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mocks.isConnected(...args),
}));

vi.mock('../../src/services/provider-preferences', () => ({
  resolveCalendarWritePreference: (...args: unknown[]) => mocks.resolveCalendarWritePreference(...args),
}));

import {
  normalizeTrainingCalendarSource,
  resolveTrainingCalendarSource,
  validateRequestedTrainingCalendarSource,
} from '../../src/services/training-calendar-source';

describe('training-calendar-source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;

    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'auto', source: null });
    mocks.isConnected.mockImplementation((_userId: number, source: string) => (
      source === 'google' || source === 'outlook'
    ));
  });

  // 2026-05-25 fix — Outlook is now ON by default, matching Google.
  // Pre-fix the test suite pinned the prior "opt-in gate" contract; the
  // tests below were updated to reflect the new default-enabled contract
  // and the kill-switch (TRAINING_CALENDAR_OUTLOOK_DISABLED=1) still
  // exercises every gated-path branch the originals were protecting.

  it('R-2026-05-25 — accepts requested Outlook sync by default (no env opt-in needed)', () => {
    const result = validateRequestedTrainingCalendarSource(42, 'outlook');
    expect(result).toEqual({ ok: true, source: 'outlook' });
  });

  it('treats explicit auto as provider preference mode, not an invalid provider', () => {
    expect(normalizeTrainingCalendarSource('auto')).toBeNull();
    expect(validateRequestedTrainingCalendarSource(42, 'auto')).toEqual({ ok: true });
    expect(mocks.isConnected).not.toHaveBeenCalled();
  });

  it('maps explicit Gmail calendar aliases to Google Calendar', () => {
    expect(normalizeTrainingCalendarSource('gmail')).toBe('google');
    expect(validateRequestedTrainingCalendarSource(42, 'gmail')).toEqual({ ok: true, source: 'google' });
  });

  it('R-2026-05-25 — rejects requested Outlook sync when the kill switch is set', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    const result = validateRequestedTrainingCalendarSource(42, 'outlook');
    expect(result).toMatchObject({
      ok: false,
      code: 'CALENDAR_SOURCE_DISABLED',
      status: 503,
    });
  });

  it('R-2026-05-25 — resolves Outlook in auto mode when Outlook is connected (default)', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'auto', source: 'outlook' });
    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });
    expect(source).toBe('outlook');
  });

  it('R-2026-05-25 — resolves Google in auto mode when Outlook is connected but the kill switch is set', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'auto', source: 'outlook' });
    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });
    expect(source).toBe('google');
  });

  it('R-2026-05-25 — resolves Outlook for an Outlook-pinned plan by default (no env opt-in needed)', () => {
    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'outlook' }),
    });
    expect(source).toBe('outlook');
  });

  it('falls back from a stale Outlook-pinned plan preference in auto mode when the kill switch is set', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'outlook' }),
    });
    expect(source).toBe('google');
  });

  it('does not silently switch an explicit requested Outlook source to Google when the kill switch is set', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      requestedSource: 'outlook',
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'google' }),
      linkedSources: ['google'],
    });
    expect(source).toBeUndefined();
  });

  it('R-2026-05-25 — explicit Outlook provider preference resolves to Outlook by default', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'outlook', source: 'outlook' });
    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });
    expect(source).toBe('outlook');
  });

  it('uses the selected main calendar provider before stale plan or session calendar links', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'outlook', source: 'outlook' });

    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'google' }),
      linkedSources: ['google'],
    });

    expect(source).toBe('outlook');
  });

  it('does not silently fall back when the selected main calendar provider is unavailable', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'outlook', source: null });
    mocks.isConnected.mockImplementation((_userId: number, source: string) => source === 'google');

    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'google' }),
      linkedSources: ['google'],
    });

    expect(source).toBeUndefined();
  });

  it('falls back to a connected calendar in auto mode when the preferred auto source is unavailable', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'auto', source: 'outlook' });
    mocks.isConnected.mockImplementation((_userId: number, source: string) => source === 'google');

    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'outlook' }),
      linkedSources: ['outlook'],
    });

    expect(source).toBe('google');
  });

  it('R-2026-05-25 — does not silently switch an explicit Outlook provider preference to Google when the kill switch is set', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'outlook', source: 'outlook' });
    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });
    expect(source).toBeUndefined();
  });

  it('R-2026-05-25 — legacy explicit ENABLED=true still works (back-compat with existing deployments)', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });
    expect(source).toBe('outlook');
  });
});

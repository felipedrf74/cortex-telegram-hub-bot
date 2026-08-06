import { describe, expect, it } from 'vitest';
import {
  fingerprintTrainingPlanPreviewCandidate,
  signTrainingPlanPreviewToken,
  validateTrainingPlanPreviewToken,
} from '../../src/services/training-plan-preview-token';

describe('training plan preview token', () => {
  const contextFingerprint = 'a'.repeat(64);
  const candidateFingerprint = 'b'.repeat(64);

  it('binds a short-lived preview candidate to the authenticated scope', () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const previewToken = signTrainingPlanPreviewToken({
      userId: 41,
      tenantId: 73,
      contextFingerprint,
      candidateFingerprint,
      now,
    });

    expect(validateTrainingPlanPreviewToken(previewToken, {
      userId: 41,
      tenantId: 73,
      now: new Date('2026-08-05T12:05:00.000Z'),
    })).toEqual({
      ok: true,
      payload: {
        v: 1,
        userId: 41,
        tenantId: 73,
        contextFingerprint,
        candidateFingerprint,
        iat: 1_785_931_200,
        exp: 1_785_932_100,
      },
    });
  });

  it('rejects tampering, cross-scope replay, expiry, and malformed hashes', () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const previewToken = signTrainingPlanPreviewToken({
      userId: 41,
      tenantId: 73,
      contextFingerprint,
      candidateFingerprint,
      now,
    });
    const [payload, signature] = previewToken.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      tenantId: 74,
    }), 'utf8').toString('base64url');

    expect(validateTrainingPlanPreviewToken(`${tamperedPayload}.${signature}`, {
      userId: 41,
      tenantId: 74,
      now,
    })).toEqual({ ok: false, code: 'invalid_token' });
    expect(validateTrainingPlanPreviewToken(previewToken, {
      userId: 41,
      tenantId: 74,
      now,
    })).toEqual({ ok: false, code: 'wrong_scope' });
    expect(validateTrainingPlanPreviewToken(previewToken, {
      userId: 41,
      tenantId: 73,
      now: new Date('2026-08-05T12:15:00.000Z'),
    })).toEqual({ ok: false, code: 'expired_token' });
    expect(() => signTrainingPlanPreviewToken({
      userId: 41,
      tenantId: 73,
      contextFingerprint: 'not-a-hash',
      candidateFingerprint,
      now,
    })).toThrow(/fingerprint/i);
  });

  it('fingerprints canonical candidate semantics, independent of object key order', () => {
    const first = fingerprintTrainingPlanPreviewCandidate({
      preview: { weeklyTargets: { sessionsPerWeek: 5 }, totalSessions: 7 },
      plan: { weeks: [{ weekNumber: 1, sessions: [{ title: 'Easy Run' }] }] },
    });
    const reordered = fingerprintTrainingPlanPreviewCandidate({
      plan: { weeks: [{ sessions: [{ title: 'Easy Run' }], weekNumber: 1 }] },
      preview: { totalSessions: 7, weeklyTargets: { sessionsPerWeek: 5 } },
    });
    const changed = fingerprintTrainingPlanPreviewCandidate({
      preview: { weeklyTargets: { sessionsPerWeek: 4 }, totalSessions: 7 },
      plan: { weeks: [{ weekNumber: 1, sessions: [{ title: 'Easy Run' }] }] },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});

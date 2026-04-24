import { describe, expect, it } from 'vitest';
import { mintPortalSessionToken } from '../../src/services/portal-session-mint';
import { PORTAL_SESSION_PREFIX } from '../../src/services/portal-session-token';

describe('portal session minting', () => {
  it('mints bounded signed portal sessions with operator metadata', () => {
    const nowMs = Date.UTC(2026, 3, 24, 12, 0, 0);
    const result = mintPortalSessionToken({
      secret: 'portal-session-secret',
      actorHint: 'operator@nexushub.me',
      scope: 'write',
      ttlMs: 60000,
      maxAgeMs: 120000,
      nowMs,
      jti: 'manual-session-1',
    });

    expect(result).toMatchObject({
      actor: 'operator@nexushub.me',
      scope: 'write',
      issuedAt: nowMs,
      expiresAt: nowMs + 60000,
      ttlMs: 60000,
      maxAgeMs: 120000,
      jti: 'manual-session-1',
    });
    expect(result.token.startsWith(PORTAL_SESSION_PREFIX)).toBe(true);
  });

  it('rejects sessions that exceed the configured maximum lifetime', () => {
    expect(() => mintPortalSessionToken({
      secret: 'portal-session-secret',
      actorHint: 'operator@nexushub.me',
      scope: 'admin',
      ttlMs: 120001,
      maxAgeMs: 120000,
    })).toThrow('exceeds PORTAL_SESSION_MAX_AGE_MS');
  });

  it('rejects invalid actors and scopes before signing', () => {
    expect(() => mintPortalSessionToken({
      secret: 'portal-session-secret',
      actorHint: 'bad actor',
      scope: 'read',
      ttlMs: 60000,
      maxAgeMs: 120000,
    })).toThrow('valid --actor');

    expect(() => mintPortalSessionToken({
      secret: 'portal-session-secret',
      actorHint: 'operator@nexushub.me',
      scope: 'owner',
      ttlMs: 60000,
      maxAgeMs: 120000,
    })).toThrow('valid --scope');
  });

  it('requires the portal session secret', () => {
    expect(() => mintPortalSessionToken({
      secret: '',
      actorHint: 'operator@nexushub.me',
      scope: 'read',
      ttlMs: 60000,
      maxAgeMs: 120000,
    })).toThrow('PORTAL_SESSION_SECRET');
  });
});

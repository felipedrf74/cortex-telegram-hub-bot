import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIosJwtKeyStatus,
  signIosJwt,
  verifyIosJwt,
} from '../../src/services/ios-jwt';

const NOW = Date.parse('2026-05-06T12:00:00.000Z');

describe('iOS JWT key rotation', () => {
  beforeEach(() => {
    vi.stubEnv('IOS_API_JWT_SECRET', 'legacy-secret');
    vi.stubEnv('IOS_JWT_EXPIRY', '7d');
    vi.stubEnv('IOS_API_JWT_KEYS', '');
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('issues new access tokens with an explicit kid header', () => {
    const token = signIosJwt({ userId: 42, deviceId: 'device-a' });
    const decoded = jwt.decode(token, { complete: true }) as {
      header: { kid?: string };
    };

    expect(decoded.header.kid).toBe('ios-api-current');
    expect(verifyIosJwt(token, NOW)).toMatchObject({
      userId: 42,
      deviceId: 'device-a',
    });
  });

  it('uses the configured active key for issuance while verifying previous keys during the rotation window', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      {
        kid: 'ios-api-2026-05-05',
        secret: 'old-secret',
        verifyUntil: '2026-05-07T12:00:00.000Z',
      },
      {
        kid: 'ios-api-2026-05-06',
        secret: 'new-secret',
        active: true,
      },
    ]));

    const newToken = signIosJwt({ userId: 7, deviceId: 'new-device' });
    const newDecoded = jwt.decode(newToken, { complete: true }) as {
      header: { kid?: string };
    };
    expect(newDecoded.header.kid).toBe('ios-api-2026-05-06');
    expect(jwt.verify(newToken, 'new-secret')).toMatchObject({ userId: 7 });

    const oldToken = jwt.sign(
      { userId: 8, deviceId: 'old-device' },
      'old-secret',
      { header: { kid: 'ios-api-2026-05-05' } },
    );
    expect(verifyIosJwt(oldToken, NOW)).toMatchObject({
      userId: 8,
      deviceId: 'old-device',
    });
  });

  it('rejects a previous kid after its verification window expires', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      {
        kid: 'ios-api-2026-05-05',
        secret: 'old-secret',
        verifyUntil: '2026-05-05T12:00:00.000Z',
      },
      {
        kid: 'ios-api-2026-05-06',
        secret: 'new-secret',
        active: true,
      },
    ]));

    const oldToken = jwt.sign(
      { userId: 8, deviceId: 'old-device' },
      'old-secret',
      { header: { kid: 'ios-api-2026-05-05' } },
    );

    expect(() => verifyIosJwt(oldToken, NOW)).toThrow(/not active for verification/);
  });

  it('keeps pre-migration tokens without kid alive through the legacy secret fallback', () => {
    const legacyToken = jwt.sign({ userId: 9, deviceId: 'legacy-device' }, 'legacy-secret');

    expect(verifyIosJwt(legacyToken, NOW)).toMatchObject({
      userId: 9,
      deviceId: 'legacy-device',
    });
  });

  it('surfaces key status for health and runbook checks', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify({
      'ios-api-2026-05-05': {
        secret: 'old-secret',
        verifyUntil: '2026-05-05T12:00:00.000Z',
      },
      'ios-api-2026-05-06': {
        secret: 'new-secret',
        active: true,
      },
    }));

    expect(getIosJwtKeyStatus(NOW)).toEqual({
      activeKid: 'ios-api-2026-05-06',
      configuredKids: [
        { kid: 'ios-api-2026-05-05', active: false, verifies: false },
        { kid: 'ios-api-2026-05-06', active: true, verifies: true },
      ],
      legacyNoKidFallback: true,
    });
  });
});

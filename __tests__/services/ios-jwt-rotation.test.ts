import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIosJwtKeyring,
  getIosJwtKeyStatus,
  getIosJwtTokenLifetimeSeconds,
  parseIosJwtExpirySeconds,
  signIosJwt,
  validateIosJwtConfiguration,
  verifyIosJwt,
} from '../../src/services/ios-jwt';
import { validateIosApiSecurityConfiguration } from '../../src/services/ios-api-security';

const NOW = Date.parse('2026-05-06T12:00:00.000Z');
const LEGACY_SECRET = 'legacy-secret-00000000000000000000000000000000';
const OLD_SECRET = 'old-secret-000000000000000000000000000000000';
const NEW_SECRET = 'new-secret-000000000000000000000000000000000';

describe('iOS JWT key rotation', () => {
  beforeEach(() => {
    vi.stubEnv('IOS_API_JWT_SECRET', LEGACY_SECRET);
    vi.stubEnv('IOS_JWT_EXPIRY', '7d');
    vi.stubEnv('IOS_API_JWT_KEYS', '');
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', '');
    vi.stubEnv('APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET', 'apple-ownership-secret-000000000000000000000000000');
    vi.stubEnv('CHAT_CONFIRMATION_HMAC_SECRET', 'confirmation-secret-0000000000000000000000000000');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'evidence-secret-000000000000000000000000000000');
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
        secret: OLD_SECRET,
        verifyUntil: '2026-05-07T12:00:00.000Z',
      },
      {
        kid: 'ios-api-2026-05-06',
        secret: NEW_SECRET,
        active: true,
      },
    ]));

    const newToken = signIosJwt({ userId: 7, deviceId: 'new-device' });
    const newDecoded = jwt.decode(newToken, { complete: true }) as {
      header: { kid?: string };
    };
    expect(newDecoded.header.kid).toBe('ios-api-2026-05-06');
    expect(jwt.verify(newToken, NEW_SECRET)).toMatchObject({ userId: 7 });

    const oldToken = jwt.sign(
      { userId: 8, deviceId: 'old-device' },
      OLD_SECRET,
      { header: { kid: 'ios-api-2026-05-05' } },
    );
    expect(verifyIosJwt(oldToken, NOW)).toMatchObject({
      userId: 8,
      deviceId: 'old-device',
    });
  });

  it('requires dedicated Apple ownership material before a rotating keyring can start', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'ios-api-2026-05-06', secret: NEW_SECRET, active: true },
    ]));
    vi.stubEnv('APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET', '');

    expect(() => validateIosJwtConfiguration(NOW)).toThrow(
      'APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET must be pinned before enabling the iOS JWT keyring',
    );
  });

  it('rejects a previous kid after its verification window expires', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      {
        kid: 'ios-api-2026-05-05',
        secret: OLD_SECRET,
        verifyUntil: '2026-05-05T12:00:00.000Z',
      },
      {
        kid: 'ios-api-2026-05-06',
        secret: NEW_SECRET,
        active: true,
      },
    ]));

    const oldToken = jwt.sign(
      { userId: 8, deviceId: 'old-device' },
      OLD_SECRET,
      { header: { kid: 'ios-api-2026-05-05' } },
    );

    expect(() => verifyIosJwt(oldToken, NOW)).toThrow(/not active for verification/);
  });

  it('keeps pre-migration tokens without kid alive through the legacy secret fallback', () => {
    const legacyToken = jwt.sign({ userId: 9, deviceId: 'legacy-device' }, LEGACY_SECRET);

    expect(verifyIosJwt(legacyToken, NOW)).toMatchObject({
      userId: 9,
      deviceId: 'legacy-device',
    });
  });

  it('requires a strong legacy secret while no-kid migration compatibility is active', () => {
    vi.stubEnv('IOS_API_JWT_SECRET', '');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/IOS_API_JWT_SECRET is required/);

    vi.stubEnv('IOS_API_JWT_SECRET', 'stub-secret');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/at least 32 bytes/);
  });

  it('surfaces key status for health and runbook checks', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify({
      'ios-api-2026-05-05': {
        secret: OLD_SECRET,
        verifyUntil: '2026-05-05T12:00:00.000Z',
      },
      'ios-api-2026-05-06': {
        secret: NEW_SECRET,
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

  it('rejects weak configured keyring secrets before signing or verifying', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      {
        kid: 'ios-api-weak',
        secret: 'stub-secret',
        active: true,
      },
    ]));

    expect(() => signIosJwt({ userId: 42 })).toThrow(
      'iOS JWT secret for kid ios-api-weak must be at least 32 bytes and cannot contain known placeholder text.',
    );
  });

  it('fails closed when an explicit active kid is missing or conflicts with the marked active key', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', 'typoed-kid');
    expect(() => getIosJwtKeyring(NOW)).toThrow(/does not match a configured key/);

    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', 'old');
    expect(() => getIosJwtKeyring(NOW)).toThrow(/conflicts with the key marked active/);
  });

  it('rejects duplicate kids and ambiguous active declarations', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'duplicate', secret: OLD_SECRET, active: true },
      { kid: 'duplicate', secret: NEW_SECRET },
    ]));
    expect(() => getIosJwtKeyring(NOW)).toThrow(/duplicate kid/);

    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET, active: true },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    expect(() => getIosJwtKeyring(NOW)).toThrow(/more than one active/);
  });

  it('refuses any verification cutoff on the active signing key', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      {
        kid: 'expired-active',
        secret: NEW_SECRET,
        active: true,
        verifyUntil: '2099-01-01T00:00:00.000Z',
      },
    ]));

    expect(() => signIosJwt({ userId: 42 })).toThrow(/must not have a verification cutoff/);
  });

  it('requires every inactive verification key to have a finite canonical ISO cutoff', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/must have a finite cutoff/);

    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET, verifyUntil: '' },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/verification cutoff/);

    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET, verifyUntil: 1_800_000_000_000 },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/verification cutoff/);

    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET, verifyUntil: '2026-05-07T13:00:00+01:00' },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/verification cutoff/);
  });

  it('rejects zero, unitless, fractional-second, and malformed token lifetimes at startup and signing', () => {
    expect(parseIosJwtExpirySeconds('2h')).toBe(7200);
    expect(parseIosJwtExpirySeconds('1.5h')).toBe(5400);
    for (const invalid of ['0s', '604800', '0.1s', 'seven-days']) {
      vi.stubEnv('IOS_JWT_EXPIRY', invalid);
      expect(() => validateIosJwtConfiguration(NOW)).toThrow(/IOS_JWT_EXPIRY/);
      expect(() => signIosJwt({ userId: 42 })).toThrow(/IOS_JWT_EXPIRY/);
    }
  });

  it('validates malformed keyring configuration before startup accepts traffic', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', '{not-json');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow();

    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET, verifyUntil: 'not-a-date' },
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/verification cutoff/);
  });

  it('requires a separately pinned confirmation secret before keyring activation', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    vi.stubEnv('CHAT_CONFIRMATION_HMAC_SECRET', '');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/must be pinned/);
  });

  it('rejects weak confirmation pins and requires a stable evidence pin before keyring activation', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    vi.stubEnv('CHAT_CONFIRMATION_HMAC_SECRET', 'x');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/at least 32 bytes/);

    vi.stubEnv('CHAT_CONFIRMATION_HMAC_SECRET', 'confirmation-secret-0000000000000000000000000000');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', '');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/CHAT_V2_EVIDENCE_HMAC_SECRET/);

    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'x');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/at least 32 bytes/);
  });

  it('rejects whitespace-normalized active key ids instead of silently changing identity', () => {
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'new', secret: NEW_SECRET, active: true },
    ]));
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', ' new ');
    expect(() => validateIosJwtConfiguration(NOW)).toThrow(/trimmed key id/);
  });

  it('skips iOS-only security requirements when the iOS API is disabled', () => {
    vi.stubEnv('IOS_API_JWT_SECRET', '');
    vi.stubEnv('CHAT_CONFIRMATION_HMAC_SECRET', '');
    expect(() => validateIosApiSecurityConfiguration(false)).not.toThrow();
  });

  it('rejects weak confirmation material when the iOS API is enabled', () => {
    vi.stubEnv('CHAT_CONFIRMATION_HMAC_SECRET', 'x');
    expect(() => validateIosApiSecurityConfiguration(true)).toThrow(/at least 32 bytes/);
  });

  it('runs iOS security validation from the production startup entrypoint', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');
    expect(source).toContain('validateIosApiSecurityConfiguration(config.ios.enabled);');
    expect(source.indexOf('initSentry({')).toBeLessThan(
      source.indexOf('validateIosApiSecurityConfiguration(config.ios.enabled);'),
    );
    expect(source.indexOf('validateIosApiSecurityConfiguration(config.ios.enabled);')).toBeLessThan(
      source.indexOf('initDatabase();'),
    );
  });

  it('accepts the documented rollback shape without invalidating tokens from the demoted key', () => {
    vi.stubEnv('IOS_API_JWT_ACTIVE_KID', 'old');
    vi.stubEnv('IOS_API_JWT_KEYS', JSON.stringify([
      { kid: 'old', secret: OLD_SECRET, active: true },
      {
        kid: 'new',
        secret: NEW_SECRET,
        active: false,
        verifyUntil: '2026-05-14T12:00:00.000Z',
      },
    ]));

    expect(getIosJwtKeyring(NOW).activeKid).toBe('old');
    const tokenFromAttemptedRotation = jwt.sign(
      { userId: 19 },
      NEW_SECRET,
      { expiresIn: '7d', header: { kid: 'new' } },
    );
    expect(verifyIosJwt(tokenFromAttemptedRotation, NOW)).toMatchObject({ userId: 19 });
    const rollbackToken = signIosJwt({ userId: 20 });
    expect((jwt.decode(rollbackToken, { complete: true }) as any).header.kid).toBe('old');
  });

  it('derives the advertised lifetime from the token actually issued', () => {
    vi.stubEnv('IOS_JWT_EXPIRY', '2h');
    const token = signIosJwt({ userId: 42 });
    expect(getIosJwtTokenLifetimeSeconds(token)).toBe(2 * 60 * 60);
  });
});

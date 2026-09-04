import { describe, expect, it } from 'vitest';
import {
  PORTAL_PASSWORD_MIN_LENGTH,
  hashPortalPassword,
  parsePortalPasswordHash,
  portalUsernameMatches,
  readPortalOperatorCredentials,
  verifyPortalPassword,
} from '../../src/services/portal-password';

const PASSWORD = 'correct horse battery staple 42';

describe('portal operator password hashing', () => {
  it('produces a self-describing scrypt hash that verifies and rejects other passwords', () => {
    const encoded = hashPortalPassword(PASSWORD, { N: 1024 });
    expect(encoded.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(parsePortalPasswordHash(encoded)).toMatchObject({ N: 1024, r: 8, p: 1 });
    expect(verifyPortalPassword(PASSWORD, encoded)).toBe(true);
    expect(verifyPortalPassword(PASSWORD + '!', encoded)).toBe(false);
    expect(verifyPortalPassword('', encoded)).toBe(false);
    expect(verifyPortalPassword(PASSWORD, encoded.slice(0, -4))).toBe(false);
  });

  it('salts every hash and refuses short passwords', () => {
    expect(hashPortalPassword(PASSWORD, { N: 1024 })).not.toBe(hashPortalPassword(PASSWORD, { N: 1024 }));
    expect(() => hashPortalPassword('short')).toThrow(new RegExp(`${PORTAL_PASSWORD_MIN_LENGTH}`));
  });

  it('never verifies against a malformed or foreign hash format', () => {
    for (const bad of ['', 'bcrypt$10$abc', 'scrypt$0$8$1$c2FsdA$aGFzaA', 'scrypt$1024$8$1$c2FsdA', 'scrypt$1024$8$1$c2FsdA$dG9vc2hvcnQ']) {
      expect(parsePortalPasswordHash(bad)).toBeNull();
      expect(verifyPortalPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it('compares usernames case-insensitively and trimmed', () => {
    expect(portalUsernameMatches('Operator@Example.test', '  operator@example.test ')).toBe(true);
    expect(portalUsernameMatches('operator@example.test', 'operator@example.tes')).toBe(false);
    expect(portalUsernameMatches('operator@example.test', undefined)).toBe(false);
  });
});

describe('readPortalOperatorCredentials', () => {
  const hash = hashPortalPassword(PASSWORD, { N: 1024 });

  it('returns null when the pair is absent and the parsed credential when configured', () => {
    expect(readPortalOperatorCredentials({})).toBeNull();
    expect(readPortalOperatorCredentials({ PORTAL_OPERATOR_USERNAME: 'felipe@example.test', PORTAL_OPERATOR_PASSWORD_HASH: hash }))
      .toEqual({ username: 'felipe@example.test', passwordHash: hash, actor: 'felipe@example.test', scope: 'admin' });
    expect(readPortalOperatorCredentials({
      PORTAL_OPERATOR_USERNAME: 'felipe', PORTAL_OPERATOR_PASSWORD_HASH: hash, PORTAL_OPERATOR_ACTOR: 'felipe@example.test', PORTAL_OPERATOR_SCOPE: 'read',
    })).toMatchObject({ actor: 'felipe@example.test', scope: 'read' });
  });

  it('refuses a half-configured or invalid credential instead of silently disabling sign-in', () => {
    expect(() => readPortalOperatorCredentials({ PORTAL_OPERATOR_USERNAME: 'felipe' })).toThrow(/set together/);
    expect(() => readPortalOperatorCredentials({ PORTAL_OPERATOR_USERNAME: 'felipe', PORTAL_OPERATOR_PASSWORD_HASH: 'plaintext-password' })).toThrow(/scrypt/);
    expect(() => readPortalOperatorCredentials({ PORTAL_OPERATOR_USERNAME: 'felipe', PORTAL_OPERATOR_PASSWORD_HASH: hash, PORTAL_OPERATOR_SCOPE: 'root' })).toThrow(/scope/i);
    expect(() => readPortalOperatorCredentials({ PORTAL_OPERATOR_USERNAME: 'bad actor name', PORTAL_OPERATOR_PASSWORD_HASH: hash })).toThrow(/actor hint/);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    fatal: vi.fn(),
  },
}));

import {
  getConfiguredPortalCredentials,
  isWeakPortalCredentialValue,
  validatePortalCredentialStrength,
} from '../../src/portal/security';

describe('portal security helpers', () => {
  it('collects only configured portal credentials with stable labels', () => {
    expect(getConfiguredPortalCredentials({
      token: '',
      readToken: 'read-token-123',
      writeToken: '',
      adminToken: 'admin-token-123',
    })).toEqual([
      { label: 'PORTAL_READ_TOKEN', value: 'read-token-123' },
      { label: 'PORTAL_ADMIN_TOKEN', value: 'admin-token-123' },
    ]);
  });

  it('classifies short, known-default, and repeated-char credentials as weak', () => {
    expect(isWeakPortalCredentialValue('short')).toBe(true);
    expect(isWeakPortalCredentialValue('changeme')).toBe(true);
    expect(isWeakPortalCredentialValue('aaaaaaaaaaaa')).toBe(true);
    expect(isWeakPortalCredentialValue('strong-portal-token-123')).toBe(false);
  });

  it('throws with the credential label when a configured token is weak', () => {
    expect(() => validatePortalCredentialStrength([
      { label: 'PORTAL_ADMIN_TOKEN', value: 'short' },
    ])).toThrow(/PORTAL_ADMIN_TOKEN is too weak/i);
  });
});

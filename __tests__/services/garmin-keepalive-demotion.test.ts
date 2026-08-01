// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Demoting a Garmin connection to `needs_reauth` is a one-way door.
 *
 * `listGarminConnectedUserIds` filters on `status = 'active'`, so a demoted
 * user drops out of the keep-alive fan-out entirely, and for a non-owner the
 * only route back is an explicit `POST /api/v1/garmin/*` reconnect. Before
 * this classification existed, `refreshOAuth2` swallowed every error and
 * returned false, so a single transient 500 evicted a user permanently.
 *
 * Only a genuine credential rejection may demote on the first failure.
 */

import { describe, expect, it } from 'vitest';

import { classifyRefreshFailure } from '../../src/services/garmin';

describe('classifyRefreshFailure', () => {
  describe('terminal — the credential itself was rejected', () => {
    it('treats a 401 as an auth rejection', () => {
      // garmin-connect formats status into the message: "ERROR: (401), ..."
      expect(classifyRefreshFailure(new Error('ERROR: (401), Unauthorized'))).toBe('auth_rejected');
    });

    it('treats an axios-style 401 response as an auth rejection', () => {
      expect(classifyRefreshFailure({ response: { status: 401 } })).toBe('auth_rejected');
    });

    it('recognises invalid_grant', () => {
      expect(classifyRefreshFailure(new Error('invalid_grant: refresh token rejected'))).toBe('auth_rejected');
    });

    it('recognises a revoked or expired token', () => {
      expect(classifyRefreshFailure(new Error('token is revoked'))).toBe('auth_rejected');
      expect(classifyRefreshFailure(new Error('Token expired'))).toBe('auth_rejected');
    });
  });

  describe('transient — Garmin was unavailable, the credential is fine', () => {
    it('does not demote on a 500', () => {
      expect(classifyRefreshFailure(new Error('ERROR: (500), Internal Server Error'))).toBe('transient');
    });

    it('does not demote on a 503', () => {
      expect(classifyRefreshFailure(new Error('ERROR: (503), Service Unavailable'))).toBe('transient');
    });

    it('does not demote on a socket hang-up', () => {
      expect(classifyRefreshFailure(new Error('socket hang up'))).toBe('transient');
    });

    it('does not demote on a timeout', () => {
      expect(classifyRefreshFailure(new Error('ETIMEDOUT'))).toBe('transient');
    });

    it('does not demote on a rate limit', () => {
      expect(classifyRefreshFailure(new Error('ERROR: (429), Too Many Requests'))).toBe('transient');
    });

    it('defaults to transient for an unrecognised failure', () => {
      // Fail safe: an unknown error must not evict a user from the refresh set.
      expect(classifyRefreshFailure(new Error('something unexpected'))).toBe('transient');
      expect(classifyRefreshFailure(undefined)).toBe('transient');
      expect(classifyRefreshFailure(null)).toBe('transient');
    });
  });
});

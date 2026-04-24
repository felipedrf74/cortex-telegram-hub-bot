// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the OI-ADM-302c (2026-04-24) revocation
 * branch added to authMiddleware. Full runtime behavior is
 * covered by the service-level integration tests in
 * session-revocation-service.test.ts (which exercises the
 * suspendTenant cascade + isTokenRevoked end-to-end against a
 * real in-memory DB); this file pins the WIRING in auth-
 * middleware.ts so a future refactor can't silently drop the
 * revocation check.
 *
 * We can't easily exercise the real middleware under vitest
 * because it uses `require()` at runtime for the mocked service
 * paths — vitest's `vi.mock` hoisting transforms static ESM
 * imports but doesn't intercept inline CommonJS `require()` calls,
 * so the mocked getDb from our test file can't be seen by the
 * middleware body. The rest of the codebase avoids this by
 * mocking `authMiddleware` wholesale at the test boundary.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIDDLEWARE_SRC = path.resolve(__dirname, '../../src/api/auth-middleware.ts');
const loadSrc = (): string => fs.readFileSync(MIDDLEWARE_SRC, 'utf-8');

describe('auth-middleware — OI-ADM-302c revocation branch structure', () => {
  const src = loadSrc();

  it('JWT payload type now includes optional `iat` field', () => {
    // jsonwebtoken's verify returns iat automatically when the
    // issuer included it (sign does by default). The middleware
    // must DECLARE iat in its payload cast so TypeScript narrows
    // it to number | undefined for the revocation check.
    expect(src).toMatch(
      /jwt\.verify\(token,\s*config\.ios\.jwtSecret\)\s*as\s*\{\s*userId:\s*number;\s*deviceId:\s*string;\s*iat\?:\s*number;\s*\}/,
    );
  });

  it('revocation check wired via require of session-revocation-service', () => {
    expect(src).toMatch(/require\(['"]\.\.\/services\/session-revocation-service['"]\)/);
  });

  it('calls isTokenRevoked(payload.userId, payload.iat)', () => {
    expect(src).toMatch(/isTokenRevoked\(payload\.userId,\s*payload\.iat\)/);
  });

  it('revocation failure sends 401 with SESSION_REVOKED error code (NOT UNAUTHORIZED)', () => {
    // The distinct error code is the whole point — iOS clients need
    // to differentiate "session revoked" (e.g. tenant suspended;
    // show bespoke copy) from "token expired" (show generic re-auth).
    expect(src).toMatch(
      /sendError\(res,\s*['"]SESSION_REVOKED['"],\s*['"]Your session has been revoked\.['"],\s*401\)/,
    );
  });

  it('revocation check has a fail-closed catch (DB error → 401 UNAUTHORIZED)', () => {
    // If the revocation ledger read fails for any reason, we refuse
    // the request rather than admit it. Same stance as the user-
    // status check above — availability-for-security tradeoff.
    expect(src).toMatch(
      /iOS JWT: revocation check failed — rejecting[\s\S]*?UNAUTHORIZED[\s\S]*?Authentication service unavailable/,
    );
  });

  it('revocation check runs AFTER user-status check (order matters for error specificity)', () => {
    // A banned-user (status != active) short-circuits with
    // UNAUTHORIZED before we bother reading the revocation ledger.
    // The revocation check is the second gate.
    const userStatusIdx = src.indexOf("'SELECT status FROM users");
    const revocationIdx = src.indexOf('isTokenRevoked');
    expect(userStatusIdx).toBeGreaterThan(0);
    expect(revocationIdx).toBeGreaterThan(0);
    expect(revocationIdx).toBeGreaterThan(userStatusIdx);
  });

  it('revocation check logs a warning with userId + iat before rejecting', () => {
    // The log line is operator-visible — without it, "my users are
    // getting 401s and I don't know why" is a painful debug.
    // Multi-line `logger.warn({ ... }, '...')` call — use [\s\S]
    // for permissive newline/indent match.
    expect(src).toMatch(/logger\.warn\([\s\S]*?userId:\s*payload\.userId[\s\S]*?iat:\s*payload\.iat/);
    expect(src).toMatch(/iOS JWT: token predates session revocation — rejecting/);
  });
});

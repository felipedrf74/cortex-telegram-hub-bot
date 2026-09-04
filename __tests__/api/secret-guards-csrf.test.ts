import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

/**
 * Cookie-carried portal sessions are the only ambient credential a browser
 * attaches to cross-site requests, so every state-changing request that
 * authenticates through the `portal_session` cookie must also carry the
 * session-bound `x-portal-csrf` header. Header/bearer sessions are exempt.
 */

let portalSessionSecret = '';

vi.mock('../../src/config', () => ({
  config: {
    get portal() {
      return {
        token: '',
        readToken: '',
        writeToken: '',
        adminToken: '',
        adminRequireActor: false,
        adminActorAllowlist: [],
        adminActorSignatureSecret: '',
        adminActorSignatureToleranceMs: 300000,
        sessionSecret: portalSessionSecret,
        sessionMaxAgeMs: 28800000,
        requireSessionAuth: false,
        allowLegacyFallback: false,
        allowLocalBypass: false,
      };
    },
    get health() {
      return { allowUnauthenticatedDetailed: false };
    },
  },
}));

const auditRows: unknown[] = [];
vi.mock('../../src/services/audit-trail', () => ({
  logAudit: (row: unknown) => { auditRows.push(row); },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

interface MockResponse {
  statusCode: number;
  body: any;
  status(code: number): MockResponse;
  json(payload: any): MockResponse;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
}

function createRequest(method: string, headers: Record<string, string> = {}): Request {
  return {
    method,
    path: '/api/settings',
    headers,
    header(name: string) {
      const lower = name.toLowerCase();
      const entry = Object.entries(this.headers as Record<string, string>).find(([key]) => key.toLowerCase() === lower);
      return entry?.[1];
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

async function mintAdminSession(): Promise<string> {
  const { createPortalSessionToken } = await import('../../src/api/secret-guards');
  return createPortalSessionToken({
    secret: portalSessionSecret,
    actorHint: 'operator@nexushub.me',
    scope: 'admin',
    ttlMs: 60000,
  });
}

describe('portal cookie session CSRF guard', () => {
  beforeEach(() => {
    portalSessionSecret = 'portal-session-signing-secret';
    auditRows.length = 0;
    vi.resetModules();
  });

  it('allows cookie sessions on safe methods without a CSRF header', async () => {
    const { requirePortalToken } = await import('../../src/api/secret-guards');
    const session = await mintAdminSession();
    const req = createRequest('GET', { cookie: `portal_session=${session}` });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a cookie session mutation that lacks the CSRF header', async () => {
    const { requirePortalAdminToken } = await import('../../src/api/secret-guards');
    const session = await mintAdminSession();
    const req = createRequest('POST', { cookie: `portal_session=${session}` });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Portal session CSRF check failed' } });
    expect(auditRows).toContainEqual(expect.objectContaining({
      resource: 'portal.auth',
      details: expect.objectContaining({ outcome: 'failure', reason: 'csrf_rejected', csrfReason: 'csrf_missing', sessionSource: 'cookie' }),
    }));
  });

  it('rejects a cookie session mutation with a mismatched CSRF header', async () => {
    const { requirePortalAdminToken } = await import('../../src/api/secret-guards');
    const session = await mintAdminSession();
    const req = createRequest('DELETE', { cookie: `portal_session=${session}`, 'x-portal-csrf': 'not-the-token' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(auditRows).toContainEqual(expect.objectContaining({
      details: expect.objectContaining({ csrfReason: 'csrf_mismatch' }),
    }));
  });

  it('rejects a cross-site cookie session mutation even with a valid CSRF header', async () => {
    const { requirePortalAdminToken, computePortalCsrfToken } = await import('../../src/api/secret-guards');
    const session = await mintAdminSession();
    const req = createRequest('POST', {
      cookie: `portal_session=${session}`,
      'x-portal-csrf': computePortalCsrfToken(portalSessionSecret, session),
      'sec-fetch-site': 'cross-site',
    });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(auditRows).toContainEqual(expect.objectContaining({
      details: expect.objectContaining({ csrfReason: 'cross_site' }),
    }));
  });

  it('accepts a cookie session mutation that carries the session-bound CSRF header', async () => {
    const { requirePortalAdminToken, computePortalCsrfToken, getPortalAuthContext } = await import('../../src/api/secret-guards');
    const session = await mintAdminSession();
    const req = createRequest('POST', {
      cookie: `portal_session=${encodeURIComponent(session)}`,
      'x-portal-csrf': computePortalCsrfToken(portalSessionSecret, session),
      'sec-fetch-site': 'same-origin',
    });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
    expect(getPortalAuthContext(req)).toMatchObject({ matchedCredential: 'session', sessionSource: 'cookie' });
  });

  it('does not require a CSRF header for header-carried sessions', async () => {
    const { requirePortalAdminToken, getPortalAuthContext } = await import('../../src/api/secret-guards');
    const session = await mintAdminSession();
    const req = createRequest('POST', { 'x-portal-session': session });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(getPortalAuthContext(req)).toMatchObject({ matchedCredential: 'session', sessionSource: 'header' });
  });

  it('binds the CSRF token to both the secret and the session token', async () => {
    const { computePortalCsrfToken } = await import('../../src/api/secret-guards');
    const a = computePortalCsrfToken('secret-a', 'ps_token');
    expect(computePortalCsrfToken('secret-a', 'ps_token')).toBe(a);
    expect(computePortalCsrfToken('secret-b', 'ps_token')).not.toBe(a);
    expect(computePortalCsrfToken('secret-a', 'ps_other')).not.toBe(a);
  });
});

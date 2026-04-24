import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

let portalTokenValue = '';
let portalReadTokenValue = '';
let portalWriteTokenValue = '';
let portalAdminTokenValue = '';
let portalAdminRequireActor = false;
let portalAdminActorAllowlist: string[] = [];
let portalAdminActorSignatureSecret = '';
let portalAdminActorSignatureToleranceMs = 300000;
let portalSessionSecret = '';
let portalSessionMaxAgeMs = 28800000;
let portalRequireSessionAuth = false;
let portalAllowLegacyFallback = false;
let portalAllowLocalBypass = false;
let healthAllowUnauthenticatedDetailed = false;

vi.mock('../../src/config', () => ({
  config: {
    get portal() {
      return {
        token: portalTokenValue,
        readToken: portalReadTokenValue,
        writeToken: portalWriteTokenValue,
        adminToken: portalAdminTokenValue,
        adminRequireActor: portalAdminRequireActor,
        adminActorAllowlist: portalAdminActorAllowlist,
        adminActorSignatureSecret: portalAdminActorSignatureSecret,
        adminActorSignatureToleranceMs: portalAdminActorSignatureToleranceMs,
        sessionSecret: portalSessionSecret,
        sessionMaxAgeMs: portalSessionMaxAgeMs,
        requireSessionAuth: portalRequireSessionAuth,
        allowLegacyFallback: portalAllowLegacyFallback,
        allowLocalBypass: portalAllowLocalBypass,
      };
    },
    get health() {
      return {
        allowUnauthenticatedDetailed: healthAllowUnauthenticatedDetailed,
      };
    },
  },
}));

interface MockResponse {
  statusCode: number;
  body: any;
  status(code: number): MockResponse;
  json(payload: any): MockResponse;
}

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function createRequest(method: string, authorization?: string, headers: Record<string, string> = {}): Request {
  return {
    method,
    headers: authorization ? { authorization, ...headers } : headers,
    header(name: string) {
      const lower = name.toLowerCase();
      const entry = Object.entries(this.headers as Record<string, string>)
        .find(([key]) => key.toLowerCase() === lower);
      return entry?.[1];
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

describe('secret guards portal scope enforcement', () => {
  beforeEach(() => {
    portalTokenValue = '';
    portalReadTokenValue = '';
    portalWriteTokenValue = '';
    portalAdminTokenValue = '';
    portalAdminRequireActor = false;
    portalAdminActorAllowlist = [];
    portalAdminActorSignatureSecret = '';
    portalAdminActorSignatureToleranceMs = 300000;
    portalSessionSecret = '';
    portalSessionMaxAgeMs = 28800000;
    portalRequireSessionAuth = false;
    portalAllowLegacyFallback = false;
    portalAllowLocalBypass = false;
    healthAllowUnauthenticatedDetailed = false;
    vi.resetModules();
  });

  it('allows read requests with a scoped read token', async () => {
    portalReadTokenValue = 'portal-read-token';
    const { requirePortalTokenByMethod } = await import('../../src/api/secret-guards');

    const req = createRequest('GET', 'Bearer portal-read-token');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalTokenByMethod(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });

  it('allows read requests with a write token but rejects writes made with the read token', async () => {
    portalReadTokenValue = 'portal-read-token';
    portalWriteTokenValue = 'portal-write-token';
    const { requirePortalTokenByMethod } = await import('../../src/api/secret-guards');

    const readReq = createRequest('GET', 'Bearer portal-write-token');
    const readRes = createMockResponse();
    const readNext = vi.fn() as unknown as NextFunction;
    requirePortalTokenByMethod(readReq, readRes as unknown as Response, readNext);
    expect(readNext).toHaveBeenCalledOnce();

    const writeReq = createRequest('POST', 'Bearer portal-read-token');
    const writeRes = createMockResponse();
    const writeNext = vi.fn() as unknown as NextFunction;
    requirePortalTokenByMethod(writeReq, writeRes as unknown as Response, writeNext);

    expect(writeNext).not.toHaveBeenCalled();
    expect(writeRes.statusCode).toBe(401);
    expect(writeRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal write token',
      },
    });
  });

  it('keeps the legacy portal token valid when no scoped portal tokens are configured', async () => {
    portalTokenValue = 'legacy-portal-token';
    const { requirePortalTokenByMethod } = await import('../../src/api/secret-guards');

    const req = createRequest('DELETE', 'Bearer legacy-portal-token');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalTokenByMethod(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
  });

  it('rejects the legacy portal token by default once scoped portal tokens are configured', async () => {
    portalTokenValue = 'legacy-portal-token';
    portalReadTokenValue = 'portal-read-token';
    portalWriteTokenValue = 'portal-write-token';
    const { requirePortalTokenByMethod } = await import('../../src/api/secret-guards');

    const req = createRequest('DELETE', 'Bearer legacy-portal-token');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalTokenByMethod(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal write token',
      },
    });
  });

  it('allows the legacy portal token during scoped-token migration only when fallback is explicitly enabled', async () => {
    portalTokenValue = 'legacy-portal-token';
    portalReadTokenValue = 'portal-read-token';
    portalWriteTokenValue = 'portal-write-token';
    portalAllowLegacyFallback = true;
    const { requirePortalTokenByMethod } = await import('../../src/api/secret-guards');

    const req = createRequest('DELETE', 'Bearer legacy-portal-token');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalTokenByMethod(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
  });

  it('requires an admin token for elevated routes when one is configured', async () => {
    portalWriteTokenValue = 'portal-write-token';
    portalAdminTokenValue = 'portal-admin-token';
    const { getPortalAuthContext, requirePortalAdminToken } = await import('../../src/api/secret-guards');

    const rejectedReq = createRequest('POST', 'Bearer portal-write-token');
    const rejectedRes = createMockResponse();
    const rejectedNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(rejectedReq, rejectedRes as unknown as Response, rejectedNext);

    expect(rejectedNext).not.toHaveBeenCalled();
    expect(rejectedRes.statusCode).toBe(401);
    expect(rejectedRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin token',
      },
    });

    const acceptedReq = createRequest('POST', 'Bearer portal-admin-token');
    const acceptedRes = createMockResponse();
    const acceptedNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(acceptedReq, acceptedRes as unknown as Response, acceptedNext);

    expect(acceptedNext).toHaveBeenCalledOnce();
    expect(acceptedRes.body).toBeNull();
    expect(getPortalAuthContext(acceptedReq)).toMatchObject({
      requiredScope: 'admin',
      matchedCredential: 'admin',
      usingLegacyFallback: false,
      dedicatedAdminConfigured: true,
      actorRequired: false,
      actorAllowlistConfigured: false,
    });
  });

  it('requires an actor header for admin routes when actor awareness is enabled', async () => {
    portalAdminTokenValue = 'portal-admin-token';
    portalAdminRequireActor = true;
    const { getPortalAuthContext, requirePortalAdminToken } = await import('../../src/api/secret-guards');

    const missingActorReq = createRequest('POST', 'Bearer portal-admin-token');
    const missingActorRes = createMockResponse();
    const missingActorNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(missingActorReq, missingActorRes as unknown as Response, missingActorNext);

    expect(missingActorNext).not.toHaveBeenCalled();
    expect(missingActorRes.statusCode).toBe(401);
    expect(missingActorRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Portal admin actor required',
      },
    });

    const acceptedReq = createRequest(
      'POST',
      'Bearer portal-admin-token',
      { 'x-portal-actor': 'operator@nexushub.me' },
    );
    const acceptedRes = createMockResponse();
    const acceptedNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(acceptedReq, acceptedRes as unknown as Response, acceptedNext);

    expect(acceptedNext).toHaveBeenCalledOnce();
    expect(getPortalAuthContext(acceptedReq)).toMatchObject({
      requiredScope: 'admin',
      matchedCredential: 'admin',
      actorHint: 'operator@nexushub.me',
      actorRequired: true,
      actorAllowlistConfigured: false,
    });
  });

  it('accepts a signed portal session token for admin routes', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    portalAdminActorAllowlist = ['operator@nexushub.me'];
    const {
      createPortalSessionToken,
      getPortalAuthContext,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const nowMs = Date.now();
    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'operator@nexushub.me',
      scope: 'admin',
      ttlMs: 60000,
      nowMs,
      jti: 'session-1',
    });
    const req = createRequest('POST', undefined, { 'x-portal-session': sessionToken });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
    expect(getPortalAuthContext(req)).toMatchObject({
      requiredScope: 'admin',
      matchedCredential: 'session',
      actorHint: 'operator@nexushub.me',
      actorRequired: true,
      actorAllowlistConfigured: true,
      sessionScope: 'admin',
      sessionSignatureVerified: true,
    });
    expect(getPortalAuthContext(req)?.sessionExpiresAt).toBeGreaterThan(nowMs);
  });

  it('allows signed portal sessions through bearer authorization for scoped reads', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const {
      createPortalSessionToken,
      getPortalAuthContext,
      requirePortalToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'reader@nexushub.me',
      scope: 'read',
      ttlMs: 60000,
    });
    const req = createRequest('GET', `Bearer ${sessionToken}`);
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(getPortalAuthContext(req)).toMatchObject({
      requiredScope: 'read',
      matchedCredential: 'session',
      actorHint: 'reader@nexushub.me',
      sessionScope: 'read',
    });
  });

  it('rejects signed portal sessions that do not satisfy the required scope', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const {
      createPortalSessionToken,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'operator@nexushub.me',
      scope: 'write',
      ttlMs: 60000,
    });
    const req = createRequest('POST', undefined, { 'x-portal-session': sessionToken });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin token',
      },
    });
  });

  it('rejects signed admin sessions from actors outside the configured allowlist', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    portalAdminActorAllowlist = ['felipe@nexushub.me'];
    const {
      createPortalSessionToken,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'unknown@nexushub.me',
      scope: 'admin',
      ttlMs: 60000,
    });
    const req = createRequest('POST', undefined, { 'x-portal-session': sessionToken });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin token',
      },
    });
  });

  it('rejects signed portal sessions whose lifetime exceeds the configured maximum', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    portalSessionMaxAgeMs = 60000;
    const {
      createPortalSessionToken,
      requirePortalToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'reader@nexushub.me',
      scope: 'read',
      ttlMs: 120000,
    });
    const req = createRequest('GET', undefined, { 'x-portal-session': sessionToken });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal token',
      },
    });
  });

  it('rejects expired signed portal sessions', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const {
      createPortalSessionToken,
      requirePortalToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'reader@nexushub.me',
      scope: 'read',
      ttlMs: 1000,
      nowMs: Date.now() - 10000,
    });
    const req = createRequest('GET', undefined, { 'x-portal-session': sessionToken });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal token',
      },
    });
  });

  it('enforces signed sessions when static portal auth is disabled by policy', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    portalRequireSessionAuth = true;
    portalAdminTokenValue = 'portal-admin-token';
    const {
      createPortalSessionToken,
      getPortalAuthContext,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const staticReq = createRequest('POST', 'Bearer portal-admin-token');
    const staticRes = createMockResponse();
    const staticNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(staticReq, staticRes as unknown as Response, staticNext);

    expect(staticNext).not.toHaveBeenCalled();
    expect(staticRes.statusCode).toBe(401);
    expect(staticRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal session',
      },
    });

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'operator@nexushub.me',
      scope: 'admin',
      ttlMs: 60000,
    });
    const sessionReq = createRequest('POST', undefined, { 'x-portal-session': sessionToken });
    const sessionRes = createMockResponse();
    const sessionNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(sessionReq, sessionRes as unknown as Response, sessionNext);

    expect(sessionNext).toHaveBeenCalledOnce();
    expect(getPortalAuthContext(sessionReq)).toMatchObject({
      matchedCredential: 'session',
      actorHint: 'operator@nexushub.me',
      sessionScope: 'admin',
    });
  });

  it('enforces the portal admin actor allowlist when configured', async () => {
    portalAdminTokenValue = 'portal-admin-token';
    portalAdminActorAllowlist = ['felipe@nexushub.me'];
    const { getPortalAuthContext, requirePortalAdminToken } = await import('../../src/api/secret-guards');

    const rejectedReq = createRequest(
      'POST',
      'Bearer portal-admin-token',
      { 'x-portal-actor': 'unknown@nexushub.me' },
    );
    const rejectedRes = createMockResponse();
    const rejectedNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(rejectedReq, rejectedRes as unknown as Response, rejectedNext);

    expect(rejectedNext).not.toHaveBeenCalled();
    expect(rejectedRes.statusCode).toBe(401);
    expect(rejectedRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin actor',
      },
    });

    const acceptedReq = createRequest(
      'POST',
      'Bearer portal-admin-token',
      { 'x-operator-email': 'Felipe@NexusHub.me' },
    );
    const acceptedRes = createMockResponse();
    const acceptedNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(acceptedReq, acceptedRes as unknown as Response, acceptedNext);

    expect(acceptedNext).toHaveBeenCalledOnce();
    expect(getPortalAuthContext(acceptedReq)).toMatchObject({
      requiredScope: 'admin',
      matchedCredential: 'admin',
      actorHint: 'Felipe@NexusHub.me',
      actorRequired: true,
      actorAllowlistConfigured: true,
    });
  });

  it('requires a valid signed actor when admin actor signature hardening is configured', async () => {
    portalAdminTokenValue = 'portal-admin-token';
    portalAdminActorSignatureSecret = 'super-secret-session-gateway-key';
    portalAdminActorSignatureToleranceMs = 60000;
    const {
      computePortalActorSignature,
      getPortalAuthContext,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const missingSignatureReq = createRequest(
      'POST',
      'Bearer portal-admin-token',
      { 'x-portal-actor': 'operator@nexushub.me' },
    );
    const missingSignatureRes = createMockResponse();
    const missingSignatureNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(
      missingSignatureReq,
      missingSignatureRes as unknown as Response,
      missingSignatureNext,
    );

    expect(missingSignatureNext).not.toHaveBeenCalled();
    expect(missingSignatureRes.statusCode).toBe(401);
    expect(missingSignatureRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin actor signature',
      },
    });

    const timestamp = String(Date.now());
    const signature = computePortalActorSignature(
      portalAdminActorSignatureSecret,
      'operator@nexushub.me',
      timestamp,
    );
    const acceptedReq = createRequest(
      'POST',
      'Bearer portal-admin-token',
      {
        'x-portal-actor': 'operator@nexushub.me',
        'x-portal-actor-timestamp': timestamp,
        'x-portal-actor-signature': `sha256=${signature}`,
      },
    );
    const acceptedRes = createMockResponse();
    const acceptedNext = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(acceptedReq, acceptedRes as unknown as Response, acceptedNext);

    expect(acceptedNext).toHaveBeenCalledOnce();
    expect(getPortalAuthContext(acceptedReq)).toMatchObject({
      requiredScope: 'admin',
      matchedCredential: 'admin',
      actorHint: 'operator@nexushub.me',
      actorRequired: true,
      actorSignatureRequired: true,
      actorSignatureVerified: true,
    });
  });

  it('rejects stale signed admin actor headers', async () => {
    portalAdminTokenValue = 'portal-admin-token';
    portalAdminActorSignatureSecret = 'super-secret-session-gateway-key';
    portalAdminActorSignatureToleranceMs = 1000;
    const {
      computePortalActorSignature,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const timestamp = String(Date.now() - 10000);
    const signature = computePortalActorSignature(
      portalAdminActorSignatureSecret,
      'operator@nexushub.me',
      timestamp,
    );
    const req = createRequest(
      'POST',
      'Bearer portal-admin-token',
      {
        'x-portal-actor': 'operator@nexushub.me',
        'x-portal-actor-timestamp': timestamp,
        'x-portal-actor-signature': signature,
      },
    );
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin actor signature',
      },
    });
  });

  it('rejects the write token for admin routes when no dedicated admin token exists', async () => {
    portalWriteTokenValue = 'portal-write-token';
    const { getPortalAuthContext, requirePortalAdminToken } = await import('../../src/api/secret-guards');

    const req = createRequest('POST', 'Bearer portal-write-token');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Portal admin token not configured',
      },
    });
    expect(getPortalAuthContext(req)).toBeUndefined();
  });

  it('treats the admin token as read-capable when it is the only scoped token configured', async () => {
    portalAdminTokenValue = 'portal-admin-token';
    const { requirePortalToken } = await import('../../src/api/secret-guards');

    const req = createRequest('GET', 'Bearer portal-admin-token');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
  });

  it('still supports loopback-only bypass when no portal credentials are configured', async () => {
    portalAllowLocalBypass = true;
    const { getPortalAuthContext, requirePortalTokenByMethod } = await import('../../src/api/secret-guards');

    const req = createRequest('GET');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalTokenByMethod(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
    expect(getPortalAuthContext(req)).toMatchObject({
      requiredScope: 'read',
      matchedCredential: 'local_bypass',
      dedicatedAdminConfigured: false,
    });
  });

  it('still supports loopback-only bypass for admin routes when no admin credential is configured', async () => {
    portalWriteTokenValue = 'portal-write-token';
    portalAllowLocalBypass = true;
    const { getPortalAuthContext, requirePortalAdminToken } = await import('../../src/api/secret-guards');

    const req = createRequest('POST');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
    expect(getPortalAuthContext(req)).toMatchObject({
      requiredScope: 'admin',
      matchedCredential: 'local_bypass',
      dedicatedAdminConfigured: false,
    });
  });

  it('rejects portal session tokens whose signature byte has been tampered with', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const {
      createPortalSessionToken,
      requirePortalToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'reader@nexushub.me',
      scope: 'read',
      ttlMs: 60000,
    });

    // Flip a single base64url character in the signature segment to simulate
    // a tampered session header without corrupting the payload structure.
    const [prefix, body] = [sessionToken.slice(0, 3), sessionToken.slice(3)];
    const [encodedPayload, signature] = body.split('.');
    const flipped = signature.slice(0, -1) + (signature.at(-1) === 'a' ? 'b' : 'a');
    const tampered = `${prefix}${encodedPayload}.${flipped}`;

    const req = createRequest('GET', undefined, { 'x-portal-session': tampered });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid portal token' },
    });
  });

  it('rejects portal session tokens when the payload has been tampered with but the signature is left intact', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const {
      createPortalSessionToken,
      requirePortalToken,
    } = await import('../../src/api/secret-guards');

    const sessionToken = createPortalSessionToken({
      secret: portalSessionSecret,
      actorHint: 'reader@nexushub.me',
      scope: 'read',
      ttlMs: 60000,
    });
    const [prefix, body] = [sessionToken.slice(0, 3), sessionToken.slice(3)];
    const [encodedPayload, signature] = body.split('.');

    // Substitute an entirely new payload while preserving the prior signature
    // to prove the verifier compares HMAC against the payload, not just format.
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, actor: 'attacker@evil.com', scope: 'admin', iat: Date.now(), exp: Date.now() + 60000 }),
      'utf8',
    ).toString('base64url');
    const tampered = `${prefix}${forgedPayload}.${signature}`;

    const req = createRequest('GET', undefined, { 'x-portal-session': tampered });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    // Sanity: original payload differs from the forgery.
    expect(forgedPayload).not.toBe(encodedPayload);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid session signed with a different secret (cross-environment replay)', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const {
      createPortalSessionToken,
      requirePortalAdminToken,
    } = await import('../../src/api/secret-guards');

    const strangerToken = createPortalSessionToken({
      secret: 'different-env-secret',
      actorHint: 'operator@nexushub.me',
      scope: 'admin',
      ttlMs: 60000,
    });

    const req = createRequest('POST', undefined, { 'x-portal-session': strangerToken });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalAdminToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a well-formed session with structurally invalid payload fields (v!=1, missing actor)', async () => {
    portalSessionSecret = 'portal-session-signing-secret';
    const { requirePortalToken } = await import('../../src/api/secret-guards');

    // Build a token with the correct HMAC but an invalid payload shape.
    const { signPortalSessionPayload, PORTAL_SESSION_PREFIX } = await import(
      '../../src/services/portal-session-token'
    );
    const badPayload = Buffer.from(
      JSON.stringify({ v: 2, actor: '', scope: 'admin', iat: Date.now(), exp: Date.now() + 60000 }),
      'utf8',
    ).toString('base64url');
    const badSignature = signPortalSessionPayload(portalSessionSecret, badPayload);
    const token = `${PORTAL_SESSION_PREFIX}${badPayload}.${badSignature}`;

    const req = createRequest('GET', undefined, { 'x-portal-session': token });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    requirePortalToken(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

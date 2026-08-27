import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

let operatorUserScopes: Record<string, readonly number[]> = {};
let authContext: Record<string, unknown> | undefined;

vi.mock('../../src/config', () => ({
  config: {
    get portal() {
      return { operatorUserScopes };
    },
  },
}));

const hoisted = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getPortalAuthContext: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => hoisted.getUserById(...args),
}));

vi.mock('../../src/api/secret-guards', () => ({
  getPortalAuthContext: (...args: unknown[]) => hoisted.getPortalAuthContext(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => hoisted.loggerWarn(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  authorizePortalOperatorTargetUser,
  getPortalAdminTargetUserId,
  isOperatorScopedToUser,
  portalOperatorUserScopesConfigured,
  requireOperatorTargetUser,
} from '../../src/portal/admin-target-user';

interface MockResponse {
  statusCode: number;
  body: any;
  status(code: number): MockResponse;
  json(payload: any): MockResponse;
}

function makeResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function makeRequest(params: Record<string, unknown>): Request {
  return { params } as unknown as Request;
}

describe('isOperatorScopedToUser', () => {
  it('passes through when no scopes are configured (single-owner deployment)', () => {
    expect(isOperatorScopedToUser('operator@nexushub.me', 1, {})).toBe(true);
    expect(isOperatorScopedToUser(undefined, 1, {})).toBe(true);
  });

  it('fails closed when scopes are configured but the actor has no entry', () => {
    expect(
      isOperatorScopedToUser('other@nexushub.me', 1, { 'operator@nexushub.me': [1] }),
    ).toBe(false);
  });

  it('fails closed when scopes are configured but the actor is missing', () => {
    expect(
      isOperatorScopedToUser(undefined, 1, { 'operator@nexushub.me': [1] }),
    ).toBe(false);
  });

  it('case-normalizes the actor hint before checking the scope map', () => {
    expect(
      isOperatorScopedToUser('Operator@NexusHub.me', 5, { 'operator@nexushub.me': [5] }),
    ).toBe(true);
  });

  it('rejects a target user id that is not in the operator scope list', () => {
    expect(
      isOperatorScopedToUser('operator@nexushub.me', 9, { 'operator@nexushub.me': [1, 2, 3] }),
    ).toBe(false);
  });
});

describe('requireOperatorTargetUser middleware', () => {
  beforeEach(() => {
    operatorUserScopes = {};
    authContext = undefined;
    hoisted.getUserById.mockReset();
    hoisted.getPortalAuthContext.mockReset();
    hoisted.getPortalAuthContext.mockImplementation(() => authContext);
    hoisted.loggerWarn.mockReset();
  });

  it('rejects non-positive user ids with 400 INVALID_USER_ID before any DB lookup', () => {
    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '0' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_USER_ID' } });
    expect(hoisted.getUserById).not.toHaveBeenCalled();
  });

  it('rejects non-integer user ids with 400 INVALID_USER_ID', () => {
    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: 'not-a-number' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_USER_ID' } });
  });

  it('rejects numeric prefixes instead of partially parsing a target id', () => {
    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '1junk' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(hoisted.getUserById).not.toHaveBeenCalled();
  });

  it('rejects unknown target users with 404 USER_NOT_FOUND', () => {
    hoisted.getUserById.mockReturnValue(null);
    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '42' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(hoisted.getUserById).toHaveBeenCalledWith(42);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'USER_NOT_FOUND' } });
  });

  it('passes through when no per-operator scopes are configured (single-owner deployment)', () => {
    hoisted.getUserById.mockReturnValue({ id: 42, email: 'user@example.com' });
    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '42' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeNull();
    expect(getPortalAdminTargetUserId(req)).toBe(42);
  });

  it('rejects operators outside the configured scope with 403 FORBIDDEN', () => {
    hoisted.getUserById.mockReturnValue({ id: 99, email: 'user@example.com' });
    operatorUserScopes = { 'felipe@nexushub.me': [1, 2, 3] };
    authContext = { actorHint: 'felipe@nexushub.me', matchedCredential: 'admin' };

    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '99' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(hoisted.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('fails closed when scopes are configured but the operator has no actor hint', () => {
    hoisted.getUserById.mockReturnValue({ id: 1, email: 'user@example.com' });
    operatorUserScopes = { 'felipe@nexushub.me': [1] };
    authContext = { actorHint: undefined, matchedCredential: 'admin' };

    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '1' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('allows operators whose scope explicitly includes the target user', () => {
    hoisted.getUserById.mockReturnValue({ id: 5, email: 'user@example.com' });
    operatorUserScopes = { 'felipe@nexushub.me': [1, 5, 9] };
    authContext = { actorHint: 'felipe@nexushub.me', matchedCredential: 'admin' };

    const guard = requireOperatorTargetUser('userId');
    const req = makeRequest({ userId: '5' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(getPortalAdminTargetUserId(req)).toBe(5);
  });

  it('authorizes row/body/query-derived targets through the same actor scope', () => {
    hoisted.getUserById.mockReturnValue({ id: 5, email: 'user@example.com' });
    operatorUserScopes = { 'felipe@nexushub.me': [5] };
    authContext = { actorHint: 'felipe@nexushub.me', matchedCredential: 'admin' };
    const req = makeRequest({});
    const res = makeResponse();

    expect(portalOperatorUserScopesConfigured()).toBe(true);
    expect(authorizePortalOperatorTargetUser(req, res as unknown as Response, 5)).toBe(true);
    expect(getPortalAdminTargetUserId(req)).toBe(5);

    const deniedRes = makeResponse();
    expect(authorizePortalOperatorTargetUser(req, deniedRes as unknown as Response, 9)).toBe(false);
    expect(deniedRes.statusCode).toBe(403);
  });

  it('reuses the configured param name', () => {
    hoisted.getUserById.mockReturnValue({ id: 7, email: 'u@e.com' });
    const guard = requireOperatorTargetUser('tenantId');
    const req = makeRequest({ tenantId: '7' });
    const res = makeResponse();
    const next = vi.fn();

    guard(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(getPortalAdminTargetUserId(req)).toBe(7);
  });
});

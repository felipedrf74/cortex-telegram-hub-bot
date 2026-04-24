import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  logAudit: vi.fn(),
  getOwnerBootstrapTarget: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/services/audit-trail', () => ({
  logAudit: mocks.logAudit,
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: mocks.getOwnerBootstrapTarget,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: mocks.warn,
  },
}));

import {
  buildPortalAdminAuditDetails,
  logPortalAdminMutation,
} from '../../src/portal/admin-audit';

const PORTAL_AUTH_CONTEXT_KEY = Symbol.for('nexushub.portalAuthContext');

function createRequest(headers: Record<string, string> = {}): Request {
  return {
    path: '/api/users/1/tier',
    ip: '203.0.113.10',
    headers,
    header(name: string) {
      const lower = name.toLowerCase();
      const entry = Object.entries(this.headers as Record<string, string>)
        .find(([key]) => key.toLowerCase() === lower);
      return entry?.[1];
    },
    socket: { remoteAddress: '203.0.113.11' },
  } as unknown as Request;
}

describe('portal admin audit helpers', () => {
  beforeEach(() => {
    mocks.logAudit.mockReset();
    mocks.getOwnerBootstrapTarget.mockReset();
    mocks.warn.mockReset();
  });

  it('builds audit details from sanitized actor hints when auth context is absent', () => {
    expect(buildPortalAdminAuditDetails(createRequest({
      'x-portal-actor': 'operator@nexushub.me',
    }))).toMatchObject({
      portalCredential: 'unknown',
      dedicatedAdminConfigured: false,
      portalActorHint: 'operator@nexushub.me',
    });
  });

  it('logs admin mutations with credential metadata and owner actor fallback', () => {
    const req = createRequest();
    (req as Request & { [PORTAL_AUTH_CONTEXT_KEY]?: unknown })[PORTAL_AUTH_CONTEXT_KEY] = {
      requiredScope: 'admin',
      matchedCredential: 'admin',
      usingLegacyFallback: false,
      dedicatedAdminConfigured: true,
      actorHint: 'felipe@nexushub.me',
      actorRequired: true,
      actorAllowlistConfigured: true,
      actorSignatureRequired: true,
      actorSignatureVerified: true,
    };
    mocks.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 74 });

    logPortalAdminMutation(req, 3, 'user.tier', { tier: 'max' });

    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 3,
      actorId: 74,
      action: 'admin_mutation',
      resource: 'user.tier',
      ipAddress: '203.0.113.10',
      details: expect.objectContaining({
        portalCredential: 'admin',
        dedicatedAdminConfigured: true,
        portalActorHint: 'felipe@nexushub.me',
        portalActorRequired: true,
        portalActorAllowlistConfigured: true,
        portalActorSignatureRequired: true,
        portalActorSignatureVerified: true,
        tier: 'max',
      }),
    }));
  });
});

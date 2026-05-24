import { describe, expect, it } from 'vitest';

import {
  buildChatCoreV2ActionAuthorization,
  buildChatCoreV2PermissionSnapshotVersion,
  evaluateChatCoreV2ActionAuthorization,
  evaluateChatCoreV2CommandAuthorization,
  type AICommandEnvelope,
} from '../../src/services/chat-core-v2';

const NOW = new Date('2026-05-24T10:00:00.000Z');

describe('Chat Core v2 action authorization', () => {
  it('builds deterministic delegated-scope snapshots with sorted unique scopes', () => {
    const authorization = buildChatCoreV2ActionAuthorization({
      actorUserId: 42,
      tenantId: 'tenant_9',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:write', 'tasks:read', 'tasks:write', '  '],
      authTime: '2026-05-24T09:59:00.000Z',
      permissionPolicyVersion: 'permissions@1',
      tenantPolicyVersion: 'tenant_policy@1',
    });

    expect(authorization).toMatchObject({
      actorUserId: '42',
      tenantId: 'tenant_9',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      authTime: '2026-05-24T09:59:00.000Z',
    });
    expect(authorization.permissionSnapshotVersion).toMatch(/^perm:[a-f0-9]{16}$/);

    expect(authorization.permissionSnapshotVersion).toBe(buildChatCoreV2PermissionSnapshotVersion({
      actorUserId: '42',
      tenantId: 'tenant_9',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionPolicyVersion: 'permissions@1',
      tenantPolicyVersion: 'tenant_policy@1',
    }));
  });

  it('allows an authorized iOS chat action when actor, tenant, scope, and permission snapshot match', () => {
    const authorization = buildChatCoreV2ActionAuthorization({
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      authTime: '2026-05-24T09:59:00.000Z',
    });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      permissionSnapshotVersion: authorization.permissionSnapshotVersion,
      now: NOW,
      maxAuthorizationAgeMs: 120_000,
    }, ['tasks:write'])).toMatchObject({
      ok: true,
      authorizationVersion: 'chat_core_v2_action_authorization@1.0.0',
      delegatedScopes: ['tasks:read', 'tasks:write'],
    });
  });

  it('rejects cross-user and cross-tenant authorization attempts', () => {
    const authorization = buildChatCoreV2ActionAuthorization({
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read'],
    });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'user_2',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
    }, ['tasks:read'])).toMatchObject({ ok: false, reason: 'wrong_actor' });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'user_1',
      tenantId: 'tenant_2',
      actingSurface: 'ios_chat',
    }, ['tasks:read'])).toMatchObject({ ok: false, reason: 'wrong_tenant' });
  });

  it('requires current delegated scopes and permission snapshots at confirmation time', () => {
    const authorization = buildChatCoreV2ActionAuthorization({
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
    });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read'],
    }, ['tasks:read', 'tasks:write'])).toMatchObject({
      ok: false,
      reason: 'missing_delegated_scope',
      missingScopes: ['tasks:write'],
    });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      permissionSnapshotVersion: 'perm:changed',
    }, ['tasks:read'])).toMatchObject({
      ok: false,
      reason: 'permission_snapshot_changed',
    });
  });

  it('denies system automation unless the caller explicitly allows that acting surface', () => {
    const authorization = buildChatCoreV2ActionAuthorization({
      actorUserId: 'system',
      tenantId: 'tenant_1',
      actingSurface: 'system_automation',
      delegatedScopes: ['notifications:write'],
    });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'system',
      tenantId: 'tenant_1',
      actingSurface: 'system_automation',
    }, ['notifications:write'])).toMatchObject({
      ok: false,
      reason: 'acting_surface_not_allowed',
    });

    expect(evaluateChatCoreV2ActionAuthorization(authorization, {
      actorUserId: 'system',
      tenantId: 'tenant_1',
      actingSurface: 'system_automation',
      allowedSurfaces: ['system_automation'],
    }, ['notifications:write'])).toMatchObject({ ok: true });
  });

  it('rejects invalid or expired auth times before command execution', () => {
    const expired = buildChatCoreV2ActionAuthorization({
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read'],
      authTime: '2026-05-24T09:00:00.000Z',
    });

    expect(evaluateChatCoreV2ActionAuthorization(expired, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      now: NOW,
      maxAuthorizationAgeMs: 60_000,
    }, ['tasks:read'])).toMatchObject({
      ok: false,
      reason: 'auth_time_expired',
    });

    expect(evaluateChatCoreV2ActionAuthorization({
      ...expired,
      authTime: 'not-a-date',
    }, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      now: NOW,
    }, ['tasks:read'])).toMatchObject({
      ok: false,
      reason: 'auth_time_invalid',
    });
  });

  it('derives command required scopes from the capability registry', () => {
    const envelope = command({
      authorization: buildChatCoreV2ActionAuthorization({
        actorUserId: 'user_1',
        tenantId: 'tenant_1',
        actingSurface: 'ios_chat',
        delegatedScopes: ['tasks:read'],
      }),
    });

    expect(evaluateChatCoreV2CommandAuthorization(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
    })).toMatchObject({
      ok: false,
      reason: 'missing_delegated_scope',
      missingScopes: ['tasks:write'],
    });

    expect(evaluateChatCoreV2CommandAuthorization({
      ...envelope,
      commandType: 'tasks.unregistered_magic',
    }, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
    })).toMatchObject({
      ok: false,
      reason: 'unknown_command',
    });
  });
});

function command(overrides: Partial<AICommandEnvelope> = {}): AICommandEnvelope {
  const authorization = buildChatCoreV2ActionAuthorization({
    actorUserId: 'user_1',
    tenantId: 'tenant_1',
    actingSurface: 'ios_chat',
    delegatedScopes: ['tasks:read', 'tasks:write'],
  });
  return {
    commandId: 'cmd_123',
    commandSchemaVersion: 'tasks.create@1.0.0',
    previewSchemaVersion: 'preview.task@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: 'tenant_1',
    userId: 'user_1',
    domain: 'tasks',
    commandType: 'tasks.create',
    origin: 'chat',
    payload: { title: 'Buy milk' },
    basedOn: {
      entityIds: ['task:list'],
      entityVersions: { 'task:list': 'v1' },
      contextHash: 'ctx_123',
      createdAt: '2026-05-24T09:59:00.000Z',
    },
    preconditions: {
      requiredEntityVersions: { 'task:list': 'v1' },
      invariants: [],
    },
    authorization,
    expiresAt: '2026-05-24T10:10:00.000Z',
    idempotencyKey: 'chat:user_1:cmd_123',
    ...overrides,
  };
}

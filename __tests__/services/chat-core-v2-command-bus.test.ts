import { describe, expect, it } from 'vitest';

import {
  evaluateChatCoreV2CommandBusGate,
  findCommandCapability,
  type AICommandEnvelope,
  type ChatCoreV2Domain,
} from '../../src/services/chat-core-v2';

const NOW = new Date('2026-05-24T10:00:00.000Z');

function command(overrides: Partial<AICommandEnvelope> = {}): AICommandEnvelope {
  const domain = overrides.domain ?? 'tasks';
  return {
    commandId: 'cmd_123',
    commandSchemaVersion: 'tasks.create@1.0.0',
    previewSchemaVersion: 'preview.task@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: 'tenant_1',
    userId: 'user_1',
    domain,
    commandType: overrides.commandType ?? defaultCommandType(domain),
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
      requiredPermissionsVersion: 'perm_v1',
      invariants: [],
    },
    authorization: {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: 'perm_v1',
      authTime: '2026-05-24T09:59:00.000Z',
    },
    expiresAt: '2026-05-24T10:10:00.000Z',
    idempotencyKey: 'chat:user_1:cmd_123',
    ...overrides,
  };
}

function defaultCommandType(domain: ChatCoreV2Domain): string {
  if (domain === 'training') return 'training.modify_session';
  if (domain === 'finance') return 'finance.execute_restricted';
  if (domain === 'notifications') return 'notifications.snooze';
  if (domain === 'decision_center') return 'decision_center.dismiss';
  return 'tasks.create';
}

describe('Chat Core v2 command bus gate', () => {
  it('allows executable low-risk commands when identity, scopes, expiry, and preconditions match', () => {
    const envelope = command();

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      currentEntityVersions: { 'task:list': 'v1' },
      permissionSnapshotVersion: 'perm_v1',
      now: NOW,
    }, 'execute')).toEqual({
      ok: true,
      operation: 'execute',
      gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
      commandStatus: 'confirmed',
      capabilityId: 'tasks.create',
    });
  });

  it('allows preview for preview-only capabilities but blocks execution', () => {
    const envelope = command({
      domain: 'training',
      commandType: 'training.modify_session',
      authorization: {
        actorUserId: 'user_1',
        tenantId: 'tenant_1',
        actingSurface: 'ios_chat',
        delegatedScopes: ['training:read'],
        permissionSnapshotVersion: 'perm_v1',
        authTime: '2026-05-24T09:59:00.000Z',
      },
      preconditions: {
        requiredEntityVersions: { 'training:session:1': 'v4' },
        invariants: [],
      },
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'training:session:1': 'v4' },
      now: NOW,
    }, 'preview')).toMatchObject({
      ok: true,
      commandStatus: 'previewed',
      capabilityId: 'training.modify_session_preview',
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'training:session:1': 'v4' },
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      commandStatus: 'rejected_by_policy',
      capabilityId: 'training.modify_session_preview',
      reason: 'capability_not_executable',
    });
  });

  it('blocks restricted finance commands even before precondition checks', () => {
    const envelope = command({
      domain: 'finance',
      commandType: 'finance.execute_restricted',
      authorization: {
        actorUserId: 'user_1',
        tenantId: 'tenant_1',
        actingSurface: 'ios_chat',
        delegatedScopes: ['finance:read'],
        permissionSnapshotVersion: 'perm_v1',
        authTime: '2026-05-24T09:59:00.000Z',
      },
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'task:list': 'v1' },
      now: NOW,
    }, 'preview')).toMatchObject({
      ok: false,
      commandStatus: 'rejected_by_policy',
      capabilityId: 'finance.payment_or_tax_action_blocked',
      reason: 'restricted_command',
    });
  });

  it('rejects wrong actor, wrong tenant, expired tokens, and unknown commands fail-closed', () => {
    expect(evaluateChatCoreV2CommandBusGate(command(), {
      actorUserId: 'other_user',
      tenantId: 'tenant_1',
      now: NOW,
    }, 'execute')).toMatchObject({ ok: false, reason: 'wrong_actor' });

    expect(evaluateChatCoreV2CommandBusGate(command(), {
      actorUserId: 'user_1',
      tenantId: 'other_tenant',
      now: NOW,
    }, 'execute')).toMatchObject({ ok: false, reason: 'wrong_tenant' });

    expect(evaluateChatCoreV2CommandBusGate(command({ expiresAt: '2026-05-24T10:00:00.000Z' }), {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      commandStatus: 'expired',
      reason: 'expired',
    });

    expect(evaluateChatCoreV2CommandBusGate(command({ commandType: 'tasks.magic_unregistered' }), {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      reason: 'unknown_command',
    });
  });

  it('requires delegated scopes from the current snapshot or the proposal authorization', () => {
    const envelope = command();

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      delegatedScopes: ['tasks:read'],
      currentEntityVersions: { 'task:list': 'v1' },
      permissionSnapshotVersion: 'perm_v1',
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      reason: 'missing_delegated_scope',
      missingScopes: ['tasks:write'],
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'task:list': 'v1' },
      permissionSnapshotVersion: 'perm_v1',
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: true,
      capabilityId: 'tasks.create',
    });
  });

  it('rejects stale entity versions and permission/policy drift before execution', () => {
    const envelope = command({
      preconditions: {
        requiredEntityVersions: { 'task:list': 'v1', 'task:1': 'v2' },
        requiredPermissionsVersion: 'perm_v1',
        requiredTenantPolicyVersion: 'tenant_policy_v1',
        requiredIntegrationConnectionVersion: 'todoist_connection_v1',
        requiredDecisionVersion: 'decision_v1',
        invariants: [],
      },
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'task:list': 'v1', 'task:1': 'v3' },
      permissionSnapshotVersion: 'perm_v1',
      tenantPolicyVersion: 'tenant_policy_v1',
      integrationConnectionVersion: 'todoist_connection_v1',
      decisionVersion: 'decision_v1',
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      commandStatus: 'stale',
      reason: 'stale_entity_version',
      staleEntities: [{ entityId: 'task:1', expectedVersion: 'v2', actualVersion: 'v3' }],
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'task:list': 'v1', 'task:1': 'v2' },
      permissionSnapshotVersion: 'perm_v2',
      tenantPolicyVersion: 'tenant_policy_v1',
      integrationConnectionVersion: 'todoist_connection_v1',
      decisionVersion: 'decision_v1',
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      reason: 'permission_version_changed',
    });
  });

  it('requires domain invariants to be positively checked', () => {
    const envelope = command({
      preconditions: {
        requiredEntityVersions: { 'task:list': 'v1' },
        invariants: [{
          type: 'task_mutation',
          description: 'Task list still accepts new tasks.',
          check: 'tasks.can_create',
        }],
      },
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'task:list': 'v1' },
      invariantResults: {},
      now: NOW,
    }, 'execute')).toMatchObject({
      ok: false,
      reason: 'invariant_failed',
      failedInvariants: ['tasks.can_create'],
    });

    expect(evaluateChatCoreV2CommandBusGate(envelope, {
      actorUserId: 'user_1',
      tenantId: 'tenant_1',
      currentEntityVersions: { 'task:list': 'v1' },
      invariantResults: { 'tasks.can_create': true },
      now: NOW,
    }, 'execute')).toMatchObject({ ok: true });
  });

  it('finds command capabilities by domain and command type only', () => {
    expect(findCommandCapability({ domain: 'tasks', commandType: 'tasks.create' })?.capabilityId).toBe('tasks.create');
    expect(findCommandCapability({ domain: 'finance', commandType: 'tasks.create' })).toBeUndefined();
  });
});

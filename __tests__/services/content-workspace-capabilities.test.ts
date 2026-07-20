import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enforceContentWorkspaceWriteCapability } from '../../src/api/routes/content';
import {
  classifyContentWorkspaceWriteSlice,
  resolveContentWorkspaceCapabilities,
} from '../../src/services/content-workspace-capabilities';
import { createContentWorkspaceItem } from '../../src/services/content-workspace';
import {
  _resetContentWorkspaceObservabilityForTests,
  getContentWorkspaceObservabilitySnapshot,
} from '../../src/services/content-workspace-observability';

const ENV_KEYS = [
  'NODE_ENV',
  'CONTENT_WORKSPACE_V1_MODE',
  'CONTENT_WORKSPACE_V1_GLOBAL_WRITE',
  'CONTENT_WORKSPACE_V1_USER_IDS',
  'CONTENT_WORKSPACE_V1_TENANT_IDS',
  'CONTENT_WORKSPACE_V1_CORE_WRITES',
  'CONTENT_WORKSPACE_V1_REVISION_WRITES',
  'CONTENT_WORKSPACE_V1_LINEAGE_WRITES',
  'CONTENT_WORKSPACE_V1_AGENT_WRITES',
  'CONTENT_WORKSPACE_V1_SCHEDULE_WRITES',
  'CONTENT_WORKSPACE_V1_RECOVERY_WRITES',
] as const;

describe('content workspace rollout capabilities', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    _resetContentWorkspaceObservabilityForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('fails closed to read-only in production when no operator mode exists', () => {
    const capabilities = resolveContentWorkspaceCapabilities(
      { tenantId: 41, userId: 41 },
      { env: {}, nodeEnv: 'production' },
    );

    expect(capabilities).toMatchObject({
      schemaVersion: 'content-workspace-capabilities-v1',
      available: true,
      mode: 'read_only',
      cohortEligible: false,
      reasonCode: 'read_only',
      publicationExecution: 'not_supported',
    });
    expect(Object.values(capabilities.reads).every(Boolean)).toBe(true);
    expect(Object.values(capabilities.writes).every((enabled) => !enabled)).toBe(true);
  });

  it('requires explicit production enrollment and honors independent slice kill switches', () => {
    const env = {
      CONTENT_WORKSPACE_V1_MODE: 'write',
      CONTENT_WORKSPACE_V1_USER_IDS: '41, 99',
      CONTENT_WORKSPACE_V1_AGENT_WRITES: 'off',
    };
    const enrolled = resolveContentWorkspaceCapabilities(
      { tenantId: 41, userId: 41 },
      { env, nodeEnv: 'production' },
    );
    const excluded = resolveContentWorkspaceCapabilities(
      { tenantId: 42, userId: 42 },
      { env, nodeEnv: 'production' },
    );

    expect(enrolled.reasonCode).toBe('available');
    expect(enrolled.writes).toMatchObject({
      core: true,
      revisions: true,
      lineage: true,
      agents: false,
      scheduling: true,
      restore_deleted_items: true,
    });
    expect(excluded.reasonCode).toBe('not_enrolled');
    expect(Object.values(excluded.writes).every((enabled) => !enabled)).toBe(true);
  });

  it('supports a recovery-only mode that can restore but cannot create or delete', () => {
    const capabilities = resolveContentWorkspaceCapabilities(
      { tenantId: 41, userId: 41 },
      { env: { CONTENT_WORKSPACE_V1_MODE: 'recovery_only' }, nodeEnv: 'production' },
    );

    expect(capabilities.reasonCode).toBe('recovery_only');
    expect(capabilities.writes.restore_deleted_items).toBe(true);
    expect(capabilities.writes.core).toBe(false);
    expect(capabilities.writes.revisions).toBe(false);
  });

  it('classifies every canonical write family without gating reads', () => {
    expect(classifyContentWorkspaceWriteSlice('GET', '/api/v1/content/workspace/items')).toBeNull();
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/items')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('DELETE', '/api/v1/content/workspace/items/7')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/items/7/restore')).toBe('restore_deleted_items');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/artifacts/9/revisions')).toBe('revisions');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/sources')).toBe('lineage');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/sources/7/assessment')).toBe('lineage');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/revisions/2/lineage')).toBe('lineage');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/agent-jobs')).toBe('agents');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workspace/schedule-previews/key/confirm')).toBe('scheduling');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/topics')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('PATCH', '/api/v1/content/topics/7')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/topics/generate')).toBeNull();
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/agency/projects/pkg-7/handoff')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workflow/7/source-review')).toBe('lineage');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/workflow/7/approval')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/performance')).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/discover', {})).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/radar/workspace-actions', {
      action: 'save',
    })).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/script', { saveToIdeas: true })).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/script', { saveToIdeas: false })).toBeNull();
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/variant-feedback', {
      variantKind: 'script',
      sentiment: 'approved',
    })).toBe('core');
    expect(classifyContentWorkspaceWriteSlice('POST', '/api/v1/content/variant-feedback', {
      variantKind: 'hook',
      sentiment: 'approved',
    })).toBeNull();
  });

  it('blocks direct domain-service writes so alternate transports cannot bypass rollout authority', () => {
    process.env.NODE_ENV = 'production';
    process.env.CONTENT_WORKSPACE_V1_MODE = 'read_only';

    expect(() => createContentWorkspaceItem({
      scope: { tenantId: 41, userId: 41 },
      itemType: 'content_item',
      title: 'Must stay read-only',
      idempotencyKey: 'direct-service-rollout-test',
    }, {} as any)).toThrowError(expect.objectContaining({
      code: 'CONTENT_WORKSPACE_WRITE_DISABLED',
      status: 503,
      details: expect.objectContaining({ writeSlice: 'core', mode: 'read_only' }),
    }));
    const snapshot = getContentWorkspaceObservabilitySnapshot();
    expect(snapshot.outcomesByOperation.rollout_gate?.blocked).toBe(1);
    expect(snapshot.outcomesByOperation.item_create?.blocked).toBe(1);
    expect(snapshot.reasons.rollout_write_disabled).toBe(2);
  });

  it('middleware blocks an enrolled slice before mutation but preserves auth error ownership', () => {
    process.env.NODE_ENV = 'production';
    process.env.CONTENT_WORKSPACE_V1_MODE = 'read_only';
    const blocked = mockResponse();
    const blockedNext = vi.fn();

    enforceContentWorkspaceWriteCapability(
      { method: 'POST', originalUrl: '/api/v1/content/workspace/items', userId: 41, tenantId: 41 } as unknown as Request,
      blocked.response,
      blockedNext as NextFunction,
    );

    expect(blockedNext).not.toHaveBeenCalled();
    expect(blocked.statusCode).toBe(503);
    expect(blocked.body).toMatchObject({
      ok: false,
      error: {
        code: 'CONTENT_WORKSPACE_WRITE_DISABLED',
        details: { writeSlice: 'core', mode: 'read_only', reasonCode: 'read_only' },
      },
    });
    expect(getContentWorkspaceObservabilitySnapshot().reasons.rollout_write_disabled).toBe(1);

    const invalidScope = mockResponse();
    const invalidNext = vi.fn();
    enforceContentWorkspaceWriteCapability(
      { method: 'POST', originalUrl: '/api/v1/content/workspace/items', userId: 41, tenantId: 99 } as unknown as Request,
      invalidScope.response,
      invalidNext as NextFunction,
    );
    expect(invalidNext).toHaveBeenCalledOnce();
    expect(invalidScope.body).toBeNull();

    const read = mockResponse();
    const readNext = vi.fn();
    enforceContentWorkspaceWriteCapability(
      { method: 'GET', originalUrl: '/api/v1/content/workspace/items', userId: 41, tenantId: 41 } as unknown as Request,
      read.response,
      readNext as NextFunction,
    );
    expect(readNext).toHaveBeenCalledOnce();
    expect(read.body).toBeNull();
  });
});

function mockResponse(): {
  response: Response;
  statusCode: number;
  body: any;
} {
  const state: { response: Response; statusCode: number; body: any; headers: Record<string, string> } = {
    response: null as unknown as Response,
    statusCode: 200,
    body: null,
    headers: {},
  };
  state.response = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
  } as unknown as Response;
  return state;
}

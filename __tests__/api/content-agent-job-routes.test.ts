// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

const agentRouteMocks = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  withAiBudgetReservation: vi.fn(),
  getUserLanguage: vi.fn(() => 'en-US'),
}));

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  );
  return {
    ...actual,
    getDb: () => testDb,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/gemini-provider', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/gemini-provider')>(
    '../../src/services/gemini-provider',
  );
  return {
    ...actual,
    completeOneShotWithFallback: (...args: unknown[]) => agentRouteMocks.completeOneShotWithFallback(...args),
  };
});

vi.mock('../../src/services/cost-guardrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/cost-guardrail')>();
  return {
    ...actual,
    withAiBudgetReservation: (...args: unknown[]) => agentRouteMocks.withAiBudgetReservation(...args),
  };
});

vi.mock('../../src/services/user-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/user-service')>();
  return {
    ...actual,
    getUserLanguage: (...args: unknown[]) => agentRouteMocks.getUserLanguage(...args),
  };
});

import {
  buildContentAgencyPackage,
  type ContentAgencyPackage,
} from '../../src/services/content-agency';
import { registerContentAgentJobRoutes } from '../../src/api/routes/content-agent-job-routes';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  listContentRevisions,
  saveContentRevision,
  transitionContentWorkspaceItem,
  type ContentArtifact,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const OWNER: ContentWorkspaceScope = { tenantId: 501, userId: 501 };
const OTHER: ContentWorkspaceScope = { tenantId: 777, userId: 777 };

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
}

describe('content agent job routes', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    agentRouteMocks.completeOneShotWithFallback.mockReset();
    agentRouteMocks.completeOneShotWithFallback.mockRejectedValue(new Error('specialist provider unavailable'));
    agentRouteMocks.withAiBudgetReservation.mockReset();
    agentRouteMocks.withAiBudgetReservation.mockImplementation(async (_request, callback) => callback());
    agentRouteMocks.getUserLanguage.mockReset();
    agentRouteMocks.getUserLanguage.mockReturnValue('en-US');
  });

  afterEach(() => testDb.close());

  it('fails closed without a matching authenticated tenant scope', async () => {
    const fixture = seedFixture('scope');
    const unscoped = await dispatch('POST', '/workspace/agent-jobs', {
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'route-agent-unscoped-001',
    }, 501, 0);
    const mismatched = await dispatch('POST', '/workspace/agent-jobs', {
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'route-agent-mismatch-001',
    }, 501, 777);

    expect(unscoped.statusCode).toBe(401);
    expect(unscoped.body.error.code).toBe('CONTENT_TENANT_SCOPE_REQUIRED');
    expect(mismatched.statusCode).toBe(403);
    expect(mismatched.body.error.code).toBe('CONTENT_TENANT_SCOPE_MISMATCH');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_agent_jobs').get()).toEqual({ count: 0 });
  });

  it('returns a typed conflict when the package is not bound to the target artifact', async () => {
    const fixture = seedFixture('unbound');
    testDb.prepare(`
      DELETE FROM content_workspace_ingress_bindings
       WHERE tenant_id = ? AND owner_user_id = ?
         AND source_kind = 'content_agency_package' AND source_id = ?
    `).run(OWNER.tenantId, OWNER.userId, fixture.pkg.id);

    const response = await dispatch('POST', '/workspace/agent-jobs', {
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'route-agent-unbound-create-001',
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_AGENT_PACKAGE_BINDING_REQUIRED',
      message: expect.stringContaining('Content workspace'),
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_agent_jobs').get()).toEqual({ count: 0 });
  });

  it('creates, replays, runs, lists, and reads a typed private specialist job', async () => {
    const fixture = seedFixture('contract');
    const request = {
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'route-agent-create-001',
    };
    const created = await dispatch('POST', '/workspace/agent-jobs', request);
    const replay = await dispatch('POST', '/workspace/agent-jobs', request);
    const jobKey = created.body.data.job.jobKey;
    const completed = await dispatch('POST', `/workspace/agent-jobs/${jobKey}/run`, {}, 501, 501, {
      'x-idempotency-key': 'route-agent-run-001',
    });
    const beforeReads = mutationCounts();
    const detail = await dispatch('GET', `/workspace/agent-jobs/${jobKey}`);
    const page = await dispatch('GET', `/workspace/agent-jobs?artifactId=${fixture.artifact.id}&status=completed&limit=10`);

    expect(created.statusCode).toBe(201);
    expect(created.body.data).toMatchObject({
      schemaVersion: 'content-agent-workflow-v1',
      job: {
        artifactId: fixture.artifact.id,
        status: 'queued',
        steps: expect.arrayContaining([
          expect.objectContaining({ role: 'strategy', dependencyGroup: 1, status: 'queued' }),
          expect.objectContaining({ role: 'research', dependencyGroup: 1, status: 'queued' }),
        ]),
        proposals: [],
      },
      mutation: { replayed: false, changed: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.mutation).toEqual({ replayed: true, changed: false });
    expect(completed.statusCode).toBe(200);
    expect(completed.body.data.job).toMatchObject({
      status: 'completed',
      currentGroup: 4,
      executionMode: 'package_derived',
      independentReviewPerformed: false,
      steps: expect.arrayContaining([
        expect.objectContaining({
          summary: expect.objectContaining({
            basis: 'package_derived',
            provider: null,
            fallbackReason: 'provider_unavailable',
            verificationState: 'not_independently_verified',
          }),
        }),
      ]),
    });
    expect(completed.body.data.job.proposals.map((proposal: any) => proposal.role))
      .toEqual(['writer', 'editor', 'platform_adapter']);
    expect(completed.body.data.job.proposals.every((proposal: any) => (
      proposal.reviewBasis === 'package_derived'
      && proposal.provider === null
      && proposal.fallbackReason === 'provider_unavailable'
    ))).toBe(true);
    expect(detail.body.data.job.jobKey).toBe(jobKey);
    expect(page.body.data).toMatchObject({
      schemaVersion: 'content-agent-workflow-v1',
      hasMore: false,
      nextCursor: null,
    });
    expect(page.body.data.jobs).toHaveLength(1);
    expect(mutationCounts()).toEqual(beforeReads);

    const serialized = JSON.stringify(completed.body.data);
    expect(serialized).not.toContain(fixture.pkg.contentHash);
    expect(serialized).not.toContain('tenantId');
    expect(serialized).not.toContain('ownerUserId');
    expect(serialized).not.toContain('leaseToken');
    expect(serialized).not.toContain('payload_json');
    expect(serialized).not.toContain('sourcePackageHash');
  });

  it('requires explicit proposal decisions and appends only the accepted revision', async () => {
    const fixture = seedFixture('accept');
    const job = await createAndRun(fixture, 'accept');
    const writer = job.proposals.find((proposal: any) => proposal.role === 'writer');
    const editor = job.proposals.find((proposal: any) => proposal.role === 'editor');
    const active = getContentWorkspaceItem(OWNER, fixture.artifact.itemId, testDb)!;
    const review = transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: active.id,
      targetState: 'review',
      expectedWorkflowVersion: active.workflowVersion,
      idempotencyKey: 'route-agent-preaccept-review-001',
    }, testDb).value;

    const rejected = await dispatch('POST', `/workspace/agent-proposals/${writer.proposalKey}/reject`, {
      idempotencyKey: 'route-agent-reject-001',
    });
    const accepted = await dispatch('POST', `/workspace/agent-proposals/${editor.proposalKey}/accept`, {
      idempotencyKey: 'route-agent-accept-001',
    });
    const replay = await dispatch('POST', `/workspace/agent-proposals/${editor.proposalKey}/accept`, {
      idempotencyKey: 'route-agent-accept-001',
    });

    expect(rejected.body.data).toMatchObject({
      proposal: { status: 'rejected' },
      mutation: { replayed: false, changed: true },
    });
    expect(accepted.body.data).toMatchObject({
      proposal: { status: 'accepted', acceptedRevisionId: expect.any(Number) },
      item: {
        id: fixture.artifact.itemId,
        productionState: 'review',
        workflowVersion: review.workflowVersion + 1,
      },
      mutation: { replayed: false, changed: true },
    });
    expect(replay.body.data.mutation).toEqual({ replayed: true, changed: false });
    expect(replay.body.data.item).toEqual(accepted.body.data.item);
    const revisions = listContentRevisions(OWNER, fixture.artifact.id, testDb);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      revisionNumber: 2,
      actorType: 'agent',
      changeReason: 'content_agent_proposal_accepted',
    });
  });

  it('returns a recoverable stale conflict and preserves newer user edits', async () => {
    const fixture = seedFixture('stale');
    const job = await createAndRun(fixture, 'stale');
    saveContentRevision({
      scope: OWNER,
      artifactId: fixture.artifact.id,
      baseRevision: 1,
      content: { format: 'plain_text', text: 'Keep this newer user-owned edit.' },
      idempotencyKey: 'route-agent-user-edit-001',
    }, testDb);

    const stale = await dispatch('POST', `/workspace/agent-proposals/${job.proposals[0].proposalKey}/accept`, {
      idempotencyKey: 'route-agent-stale-accept-001',
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'CONTENT_AGENT_PROPOSAL_STALE',
      message: expect.stringContaining('current edits were preserved'),
    });
    const revisions = listContentRevisions(OWNER, fixture.artifact.id, testDb);
    expect(revisions).toHaveLength(2);
    expect(revisions[0].content).toEqual({ format: 'plain_text', text: 'Keep this newer user-owned edit.' });
    const detail = await dispatch('GET', `/workspace/agent-jobs/${job.jobKey}`);
    expect(detail.body.data.job.proposals.every((proposal: any) => proposal.status === 'stale')).toBe(true);
  });

  it('supports cancellation, failed-job retry, and tenant-private not-found behavior', async () => {
    const cancelFixture = seedFixture('cancel');
    const created = await dispatch('POST', '/workspace/agent-jobs', {
      artifactId: cancelFixture.artifact.id,
      packageId: cancelFixture.pkg.id,
      idempotencyKey: 'route-agent-cancel-create-001',
    });
    const jobKey = created.body.data.job.jobKey;
    const foreignRead = await dispatch('GET', `/workspace/agent-jobs/${jobKey}`, {}, OTHER.userId, OTHER.tenantId);
    const cancelled = await dispatch('POST', `/workspace/agent-jobs/${jobKey}/cancel`, {
      idempotencyKey: 'route-agent-cancel-001',
    });

    expect(foreignRead.statusCode).toBe(404);
    expect(foreignRead.body.error.code).toBe('CONTENT_AGENT_JOB_NOT_FOUND');
    expect(cancelled.body.data.job.status).toBe('cancelled');
    expect(cancelled.body.data.job.steps.every((step: any) => step.status === 'cancelled')).toBe(true);

    const retryFixture = seedFixture('retry');
    const retryCreated = await dispatch('POST', '/workspace/agent-jobs', {
      artifactId: retryFixture.artifact.id,
      packageId: retryFixture.pkg.id,
      idempotencyKey: 'route-agent-retry-create-001',
    });
    const retryKey = retryCreated.body.data.job.jobKey;
    testDb.prepare(`
      UPDATE content_agent_job_steps SET status = 'failed'
       WHERE id = (SELECT MIN(id) FROM content_agent_job_steps
                    WHERE job_id = (SELECT id FROM content_agent_jobs WHERE job_key = ?))
    `).run(retryKey);
    testDb.prepare("UPDATE content_agent_jobs SET status = 'failed', last_error_code = 'PROVIDER_FAILURE' WHERE job_key = ?")
      .run(retryKey);
    const retried = await dispatch('POST', `/workspace/agent-jobs/${retryKey}/retry`, {
      idempotencyKey: 'route-agent-retry-001',
    });
    expect(retried.body.data.job.status).toBe('queued');
    expect(retried.body.data.job.steps[0].status).toBe('queued');
  });
});

function seedFixture(suffix: string): { artifact: ContentArtifact; pkg: ContentAgencyPackage } {
  const pkg = buildContentAgencyPackage({
    userId: OWNER.userId,
    tenantId: OWNER.tenantId,
    brief: {
      userId: OWNER.userId,
      tenantId: OWNER.tenantId,
      goal: `Teach a trustworthy creator workflow ${suffix}`,
      audience: 'founder-creators who need an evidence-backed process',
      platform: 'youtube',
      objective: 'help viewers develop and review one useful idea',
      brandVoice: 'clear, calm, specific, and evidence-led',
    },
    references: ['private-workspace-note'],
  });
  const item = createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title: `Route agent workspace ${suffix}`,
    idempotencyKey: `route-agent-item-${suffix}-001`,
  }, testDb).value;
  const artifact = createContentArtifact({
    scope: OWNER,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `# Current draft\nPrivate base ${suffix}.` },
    actorType: 'agent',
    actorId: 'content_agency',
    provenance: {
      sourceKind: 'content_agency_package',
      packageId: pkg.id,
      packageHash: pkg.contentHash,
      generatorContractVersion: pkg.generatorContractVersion,
    },
    idempotencyKey: `route-agent-artifact-${suffix}-001`,
  }, testDb).value;
  testDb.prepare(`
    INSERT INTO content_agency_packages (
      agency_id, user_id, tenant_id, visibility_scope, platform, format,
      status, source_trace_json, quality_score, warnings_json, blockers_json,
      payload_json
    ) VALUES (?, ?, ?, 'user_private', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id,
    pkg.userId,
    pkg.tenantId,
    pkg.platform,
    pkg.format,
    pkg.quality.status,
    JSON.stringify(pkg.sourceTrace ?? []),
    pkg.quality.score,
    JSON.stringify(pkg.warnings ?? []),
    JSON.stringify(pkg.blockers ?? []),
    JSON.stringify(pkg),
  );
  testDb.prepare(`
    INSERT INTO content_workspace_ingress_bindings (
      tenant_id, owner_user_id, source_kind, source_id, source_hash,
      item_id, artifact_id, revision_id, content_parity_status, ingress_origin
    ) VALUES (?, ?, 'content_agency_package', ?, ?, ?, ?, ?, 'artifact_pinned', 'content_agency_handoff')
  `).run(
    OWNER.tenantId,
    OWNER.userId,
    pkg.id,
    pkg.contentHash,
    artifact.itemId,
    artifact.id,
    artifact.currentRevision!.id,
  );
  return { artifact, pkg };
}

async function createAndRun(
  fixture: { artifact: ContentArtifact; pkg: ContentAgencyPackage },
  suffix: string,
): Promise<any> {
  const created = await dispatch('POST', '/workspace/agent-jobs', {
    artifactId: fixture.artifact.id,
    packageId: fixture.pkg.id,
    idempotencyKey: `route-agent-${suffix}-create-001`,
  });
  const jobKey = created.body.data.job.jobKey;
  const completed = await dispatch('POST', `/workspace/agent-jobs/${jobKey}/run`, {
    idempotencyKey: `route-agent-${suffix}-run-001`,
  });
  expect(completed.statusCode).toBe(200);
  return completed.body.data.job;
}

function mutationCounts(): Record<string, number> {
  const tables = [
    'content_agent_jobs',
    'content_agent_job_steps',
    'content_agent_proposals',
    'content_mutation_receipts',
    'content_revisions',
  ];
  return Object.fromEntries(tables.map((table) => {
    const row = testDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return [table, row.count];
  }));
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = OWNER.userId,
  tenantId: number | undefined = OWNER.tenantId,
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  const router = Router();
  registerContentAgentJobRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  const parsedUrl = new URL(path, 'https://nexus.invalid');
  const request = {
    method,
    url: `${parsedUrl.pathname}${parsedUrl.search}`,
    originalUrl: path,
    baseUrl: '',
    path: parsedUrl.pathname,
    query: Object.fromEntries(parsedUrl.searchParams.entries()),
    params: {},
    body,
    userId,
    tenantId,
    headers,
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
  } as unknown as Request;
  const response = mockResponse();
  await new Promise<void>((resolvePromise, reject) => {
    (router as any).handle(request, response, (error: unknown) => error ? reject(error) : resolvePromise());
    setImmediate(resolvePromise);
  });
  await vi.waitFor(() => expect(response.body).not.toBeNull());
  return response;
}

function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { response.statusCode = code; return response; },
    json(body) { response.body = body; return response; },
    setHeader(name, value) { response.headers[name.toLowerCase()] = String(value); },
    getHeader(name) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}

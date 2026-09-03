import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type Request, type Response } from 'express';

const mocks = vi.hoisted(() => ({
  ContentCreatorProfileUnavailableError: class ContentCreatorProfileUnavailableError extends Error {
    readonly code = 'CONTENT_CREATOR_PROFILE_UNAVAILABLE';
    readonly status = 503;
    readonly details = { retryable: true };
  },
  getContentCreatorProfile: vi.fn(),
  upsertContentCreatorProfile: vi.fn(),
  resetContentCreatorProfile: vi.fn(),
  computeContentCreatorProfileCompleteness: vi.fn(),
  recordRadarFeedback: vi.fn(),
  revokeRadarFeedback: vi.fn(),
  listRadarFeedback: vi.fn(),
  radarFeedbackAggregateBySignal: vi.fn(),
  recordContentRadarWorkspaceAction: vi.fn(),
  isPausedContentAgent: vi.fn(),
  invalidateContentDerivedCaches: vi.fn(),
  markSummaryStale: vi.fn(),
  summarizeCanonicalLifecycle: vi.fn(),
}));

vi.mock('../../src/state/content-creator-profile', () => ({
  ContentCreatorProfileUnavailableError: mocks.ContentCreatorProfileUnavailableError,
  getContentCreatorProfile: (...args: unknown[]) => mocks.getContentCreatorProfile(...args),
  upsertContentCreatorProfile: (...args: unknown[]) => mocks.upsertContentCreatorProfile(...args),
  resetContentCreatorProfile: (...args: unknown[]) => mocks.resetContentCreatorProfile(...args),
  computeContentCreatorProfileCompleteness: (...args: unknown[]) => mocks.computeContentCreatorProfileCompleteness(...args),
}));

vi.mock('../../src/state/content-radar-feedback', () => ({
  isValidRadarFeedbackAction: (action: string) =>
    ['accept', 'reject', 'save', 'create_brief'].includes(action),
  recordRadarFeedback: (...args: unknown[]) => mocks.recordRadarFeedback(...args),
  revokeRadarFeedback: (...args: unknown[]) => mocks.revokeRadarFeedback(...args),
  listRadarFeedback: (...args: unknown[]) => mocks.listRadarFeedback(...args),
  radarFeedbackAggregateBySignal: (...args: unknown[]) => mocks.radarFeedbackAggregateBySignal(...args),
}));

vi.mock('../../src/state/content-lifecycle', () => ({
  summarizeCanonicalLifecycle: (...args: unknown[]) => mocks.summarizeCanonicalLifecycle(...args),
}));

vi.mock('../../src/services/content-radar-workspace-actions', () => ({
  recordContentRadarWorkspaceAction: (...args: unknown[]) => mocks.recordContentRadarWorkspaceAction(...args),
}));

vi.mock('../../src/services/content-agent-lifecycle', () => ({
  isPausedContentAgent: (...args: unknown[]) => mocks.isPausedContentAgent(...args),
}));

vi.mock('../../src/services/cache-coherence-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/cache-coherence-registry')>()),
  invalidateContentDerivedCaches: (...args: unknown[]) => mocks.invalidateContentDerivedCaches(...args),
}));

vi.mock('../../src/services/app-summary-read-models', () => ({
  markSummaryStale: (...args: unknown[]) => mocks.markSummaryStale(...args),
}));

import { registerContentCreatorProfileRoutes } from '../../src/api/routes/content-creator-profile-routes';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(
  method: string,
  path: string,
  userId: number | undefined = 77,
  body: unknown = {},
): Request {
  const [pathname, queryString] = path.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString ?? ''));
  return {
    userId,
    tenantId: userId,
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path: pathname,
    query,
    params: {},
    body,
    headers: {},
    header: () => undefined,
  } as any;
}

function makeEnsureValidScope() {
  return vi.fn((
    res: Response,
    userId: number | undefined,
    _context?: string,
  ): userId is number => {
    if (typeof userId === 'number' && userId > 0) return true;
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid authenticated user scope' } });
    return false;
  });
}

async function dispatch(
  method: string,
  path: string,
  body: unknown = {},
  userId: number | undefined = 77,
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentCreatorProfileRoutes(router, ensureValidScope);
  const req = mockReq(method, path, userId, body);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return { response: res, ensureValidScope };
}

describe('content creator profile routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeContentCreatorProfileCompleteness.mockReturnValue(0.25);
    mocks.getContentCreatorProfile.mockReturnValue({
      pillars: ['AI automation'],
      platforms: [],
      updatedAt: '2026-05-04T22:00:00.000Z',
    });
    mocks.upsertContentCreatorProfile.mockReturnValue({
      pillars: ['AI automation'],
      platforms: [],
      updatedAt: '2026-05-04T22:01:00.000Z',
    });
    mocks.resetContentCreatorProfile.mockReturnValue(undefined);
    mocks.recordRadarFeedback.mockReturnValue({
      id: 9,
      signalId: 'sig-1',
      action: 'create_brief',
      createdAt: '2026-05-04T22:02:00.000Z',
    });
    mocks.revokeRadarFeedback.mockReturnValue(1);
    mocks.listRadarFeedback.mockReturnValue([
      { id: 9, signalId: 'sig-1', action: 'create_brief' },
    ]);
    mocks.radarFeedbackAggregateBySignal.mockReturnValue({
      'sig-1': { create_brief: 1 },
    });
    mocks.recordContentRadarWorkspaceAction.mockReturnValue({
      schemaVersion: 'content-radar-workspace-action-v1',
      workspaceSchemaVersion: 'content-workspace-v1',
      feedback: { id: 12, signalId: 'sig-brief', action: 'create_brief' },
      workspace: {
        item: { id: 81, title: 'Radar brief', workflowVersion: 2 },
        artifact: { id: 82, itemId: 81, artifactType: 'brief', currentRevisionId: 83 },
        revisionId: 83,
      },
      mutation: { replayed: false },
    });
    mocks.isPausedContentAgent.mockReturnValue(false);
    mocks.summarizeCanonicalLifecycle.mockReturnValue({
      stages: [{ key: 'briefing', count: 1 }],
      totals: { total: 1 },
    });
  });

  it('reads the creator profile using authenticated user and tenant scope', async () => {
    const { response, ensureValidScope } = await dispatch('GET', '/creator-profile', {}, 77);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 77, 'content_creator_profile_read');
    expect(mocks.getContentCreatorProfile).toHaveBeenCalledWith(77, 77);
  });

  it('upserts the creator profile with authenticated user and tenant scope', async () => {
    const patch = { pillars: ['AI automation'] };
    const { response } = await dispatch('PUT', '/creator-profile', patch, 88);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.completeness).toBe(0.25);
    expect(mocks.upsertContentCreatorProfile).toHaveBeenCalledWith(88, 88, patch);
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(88);
    expect(mocks.markSummaryStale).toHaveBeenCalledWith({
      tenantId: 88,
      userId: 88,
      summaryType: 'content',
    });
  });

  it('rejects an array body instead of reactivating a neutral creator profile', async () => {
    const { response } = await dispatch('PUT', '/creator-profile', []);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('CONTENT_CREATOR_PROFILE_INVALID');
    expect(mocks.upsertContentCreatorProfile).not.toHaveBeenCalled();
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong array type', { pillars: 'not-an-array' }, 'pillars', 'invalid_type'],
    ['wrong scalar type', { audience: [] }, 'audience', 'invalid_type'],
    ['wrong platform type', { platforms: {} }, 'platforms', 'invalid_type'],
    ['unknown field', { pillarz: ['typo'] }, 'pillarz', 'unknown_field'],
    ['empty patch', {}, '$', 'empty_patch'],
  ] as const)('rejects a %s without clearing saved profile fields', async (_label, body, field, reason) => {
    const { response } = await dispatch('PUT', '/creator-profile', body);

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_CREATOR_PROFILE_INVALID',
      details: { field, reason },
    });
    expect(mocks.upsertContentCreatorProfile).not.toHaveBeenCalled();
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('returns explicit unavailability instead of a neutral profile on storage failure', async () => {
    mocks.getContentCreatorProfile.mockImplementationOnce(() => {
      throw new mocks.ContentCreatorProfileUnavailableError();
    });

    const { response } = await dispatch('GET', '/creator-profile');

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_CREATOR_PROFILE_UNAVAILABLE',
      details: { retryable: true },
    });
  });

  it('resets the creator profile and invalidates cached and persisted summaries', async () => {
    const { response } = await dispatch('DELETE', '/creator-profile', {}, 89);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.profile).toMatchObject({
      pillars: [],
      audience: '',
      updatedAt: null,
    });
    expect(mocks.resetContentCreatorProfile).toHaveBeenCalledWith(89, 89);
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(89);
    expect(mocks.markSummaryStale).toHaveBeenCalledWith({
      tenantId: 89,
      userId: 89,
      summaryType: 'content',
    });
  });

  it('labels the lifecycle published bucket as internal state, not publication evidence', async () => {
    const { response } = await dispatch('GET', '/lifecycle');

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      lifecycle: mocks.summarizeCanonicalLifecycle.mock.results[0]?.value,
      bucketSemantics: { published: 'internal_production_state_only' },
      publicationTracking: {
        availability: 'unavailable',
        reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
        publicationExecution: 'not_supported',
      },
    });
  });

  it('returns a stable error instead of empty radar feedback when its read fails', async () => {
    mocks.listRadarFeedback.mockImplementationOnce(() => {
      throw new Error('private database error');
    });

    const { response } = await dispatch('GET', '/radar/feedback');

    expect(response.statusCode).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(response.body)).not.toContain('private database error');
  });

  it('records radar feedback with authenticated user and tenant scope', async () => {
    const { response } = await dispatch('POST', '/radar/feedback', {
      signalId: 'sig-1',
      action: 'create_brief',
      reason: 'Use this next',
      signalTopic: 'AI workflow',
      signalSummary: 'Good fit',
    }, 99);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.feedback.action).toBe('create_brief');
    expect(mocks.recordRadarFeedback).toHaveBeenCalledWith(99, 99, {
      signalId: 'sig-1',
      action: 'create_brief',
      reason: 'Use this next',
      signalTopic: 'AI workflow',
      signalSummary: 'Good fit',
    });
  });

  it('blocks radar feedback writes while Reaction Radar is paused', async () => {
    mocks.isPausedContentAgent.mockReturnValue(true);

    const { response } = await dispatch('POST', '/radar/feedback', {
      signalId: 'legacy-signal',
      action: 'save',
    }, 99);

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_AGENT_PAUSED',
      details: { agentId: 'reaction_radar', lifecycle: 'paused' },
    });
    expect(mocks.recordRadarFeedback).not.toHaveBeenCalled();
  });

  it('rejects unknown radar feedback actions before writing state', async () => {
    const { response } = await dispatch('POST', '/radar/feedback', {
      signalId: 'sig-1',
      action: 'publish_now',
    }, 99);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mocks.recordRadarFeedback).not.toHaveBeenCalled();
  });

  it('atomically materializes a radar brief and returns canonical workspace references', async () => {
    const brief = {
      objective: 'Build a source-aware explainer',
      mainPoints: ['What changed'],
      claims: ['Adoption increased'],
    };
    const { response, ensureValidScope } = await dispatch('POST', '/radar/workspace-actions', {
      signalId: 'sig-brief',
      action: 'create_brief',
      signalTopic: 'Radar brief',
      signalSummary: 'A useful source signal',
      reason: 'Develop this now',
      brief,
    }, 99);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      schemaVersion: 'content-radar-workspace-action-v1',
      workspace: {
        item: { id: 81 },
        artifact: { id: 82, currentRevisionId: 83 },
        revisionId: 83,
      },
      mutation: { replayed: false },
    });
    expect(ensureValidScope).toHaveBeenCalledWith(
      expect.anything(),
      99,
      'content_radar_workspace_action',
    );
    expect(mocks.recordContentRadarWorkspaceAction).toHaveBeenCalledWith({
      scope: { userId: 99, tenantId: 99 },
      signalId: 'sig-brief',
      action: 'create_brief',
      signalTopic: 'Radar brief',
      signalSummary: 'A useful source signal',
      reason: 'Develop this now',
      brief,
    });
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(99);
  });

  it('blocks radar workspace mutations while Reaction Radar is paused', async () => {
    mocks.isPausedContentAgent.mockReturnValue(true);

    const { response } = await dispatch('POST', '/radar/workspace-actions', {
      signalId: 'legacy-signal',
      action: 'create_brief',
      signalTopic: 'Legacy radar topic',
    }, 99);

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_AGENT_PAUSED',
      details: { agentId: 'reaction_radar', lifecycle: 'paused' },
    });
    expect(mocks.recordContentRadarWorkspaceAction).not.toHaveBeenCalled();
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('rejects non-materializing actions before any radar workspace mutation', async () => {
    const { response } = await dispatch('POST', '/radar/workspace-actions', {
      signalId: 'sig-brief',
      action: 'accept',
      signalTopic: 'Radar brief',
    }, 99);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mocks.recordContentRadarWorkspaceAction).not.toHaveBeenCalled();
  });

  it('revokes radar feedback with authenticated user and tenant scope', async () => {
    const { response } = await dispatch('DELETE', '/radar/feedback', {
      signalId: 'sig-1',
      action: 'reject',
    }, 99);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.revokedCount).toBe(1);
    expect(mocks.revokeRadarFeedback).toHaveBeenCalledWith(99, 99, {
      signalId: 'sig-1',
      action: 'reject',
    });
    expect(mocks.radarFeedbackAggregateBySignal).toHaveBeenCalledWith(99, 99);
  });

  it('rejects unknown radar feedback revoke actions before mutating state', async () => {
    const { response } = await dispatch('DELETE', '/radar/feedback', {
      signalId: 'sig-1',
      action: 'publish_now',
    }, 99);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mocks.revokeRadarFeedback).not.toHaveBeenCalled();
  });
});

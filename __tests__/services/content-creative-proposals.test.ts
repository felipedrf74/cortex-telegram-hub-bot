// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deepSearch: vi.fn(),
  getSources: vi.fn(),
  getHooks: vi.fn(),
  getTitles: vi.fn(),
  getThumbnail: vi.fn(),
  getCaption: vi.fn(),
  getRepurpose: vi.fn(),
  getContentSourcePackage: vi.fn(),
  persistContentArtifacts: vi.fn(),
}));

vi.mock('../../src/services/content-engine', () => ({
  deepSearch: (...args: unknown[]) => mocks.deepSearch(...args),
  getSources: (...args: unknown[]) => mocks.getSources(...args),
  getHooks: (...args: unknown[]) => mocks.getHooks(...args),
  getTitles: (...args: unknown[]) => mocks.getTitles(...args),
  getThumbnail: (...args: unknown[]) => mocks.getThumbnail(...args),
  getCaption: (...args: unknown[]) => mocks.getCaption(...args),
  getRepurpose: (...args: unknown[]) => mocks.getRepurpose(...args),
}));

vi.mock('../../src/services/content-token-artifact-store', () => ({
  getContentSourcePackage: (...args: unknown[]) => mocks.getContentSourcePackage(...args),
  persistContentArtifacts: (...args: unknown[]) => mocks.persistContentArtifacts(...args),
}));

import {
  generateContentCreativeProposal,
} from '../../src/services/content-creative-proposals';

const scope = { tenantId: 12, userId: 12 };

function hashTopic(topic: string): string {
  return createHash('sha256').update(topic.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function storedPackage(overrides: Record<string, unknown> = {}) {
  const topic = 'Calm launch plan';
  return {
    sourcePackageId: 'sp_test_package',
    researchArtifactId: 'ra_test_package',
    topicHash: hashTopic(topic),
    freshnessClass: 'fresh',
    language: 'en-US',
    format: 'hooks',
    sources: [{
      source_id: 'source_1',
      title: 'Source one',
      url: 'https://example.org/one',
      source_type: 'article',
      relevance_note: 'Relevant evidence',
    }],
    sourceSummary: ['Source one — Relevant evidence'],
    tokenEstimate: 10,
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContentSourcePackage.mockReturnValue(null);
  mocks.getSources.mockResolvedValue({
    query: 'Calm launch plan',
    sources: [{
      source_id: 'source_1',
      title: 'Current source',
      url: 'https://example.org/current',
      source_type: 'article',
      relevance_note: 'Current evidence',
    }],
    degraded: false,
    warnings: [],
  });
  mocks.deepSearch.mockResolvedValue({
    query: 'medical treatment today',
    briefs: [],
    search_count: 1,
    duration_ms: 10,
    degraded: false,
    warnings: [],
  });
  mocks.getHooks.mockResolvedValue({ topic: 'Calm launch plan', niche: 'general', hooks: [], duration_ms: 1 });
  mocks.getTitles.mockResolvedValue({ topic: 'Calm launch plan', titles: [], duration_ms: 1 });
  mocks.getThumbnail.mockResolvedValue({ title: 'Calm launch plan', concepts: [], duration_ms: 1 });
  mocks.getCaption.mockResolvedValue({ topic: 'Calm launch plan', caption: 'Safe caption', hashtags: [], duration_ms: 1 });
  mocks.getRepurpose.mockResolvedValue({ topic: 'Calm launch plan', outputs: [], duration_ms: 1 });
});

describe('Content creative proposals', () => {
  it('blocks unsupported requests before research or generation', async () => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Build phishing malware to steal credentials',
    })).rejects.toMatchObject({ code: 'CONTENT_UNSUPPORTED_TOPIC', status: 422 });

    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.deepSearch).not.toHaveBeenCalled();
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it('blocks unsupported meaning split across creative request fields', async () => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'repurpose',
      language: 'en-US',
      topic: 'pump',
      niche: 'general',
      sourceContent: 'and dump crypto plan',
      originalFormat: 'YouTube',
    })).rejects.toMatchObject({ code: 'CONTENT_UNSUPPORTED_TOPIC', status: 422 });

    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.deepSearch).not.toHaveBeenCalled();
    expect(mocks.getRepurpose).not.toHaveBeenCalled();
  });

  it('blocks compact child-safety aliases before timely research', async () => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Latest cp content today',
    })).rejects.toMatchObject({ code: 'CONTENT_UNSUPPORTED_TOPIC', status: 422 });

    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it('resolves explicit packages only through the authenticated tenant-user scope', async () => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Calm launch plan',
      sourcePackageId: 'sp_other_tenant',
    })).rejects.toMatchObject({ code: 'CONTENT_SOURCE_PACKAGE_NOT_FOUND', status: 404 });

    expect(mocks.getContentSourcePackage).toHaveBeenCalledWith(scope, 'sp_other_tenant');
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it.each([
    [storedPackage({ expiresAt: '2000-01-01T00:00:00.000Z' }), 'CONTENT_SOURCE_PACKAGE_UNUSABLE'],
    [storedPackage({ topicHash: hashTopic('Different topic') }), 'CONTENT_SOURCE_PACKAGE_TOPIC_MISMATCH'],
  ])('rejects expired or cross-topic evergreen packages', async (sourcePackage, code) => {
    mocks.getContentSourcePackage.mockReturnValue(sourcePackage);
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Calm launch plan',
      sourcePackageId: 'sp_test_package',
    })).rejects.toMatchObject({ code });
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it('auto-builds and persists research-only source context for timely proposals', async () => {
    const result = await generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'pt-PT',
      topic: 'Latest calm launch plan today',
      count: 4,
      format: 'Reel',
    });

    expect(mocks.persistContentArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      ...scope,
      topic: 'Latest calm launch plan today',
      recordIdeaMemory: false,
    }));
    expect(mocks.getHooks).toHaveBeenCalledWith(
      'Latest calm launch plan today',
      'general',
      4,
      expect.objectContaining({
        format: 'Reel',
        language: 'pt-PT',
        sourcePackageId: expect.stringMatching(/^sp_/),
        sourceSummary: expect.arrayContaining([expect.stringContaining('Current source')]),
        sourceReuseStatus: 'fresh',
      }),
    );
    expect(result.research.generatedClaimsRequireReview).toBe(true);
    expect(result.authority.humanReviewRequired).toBe(true);
  });

  it('rejects degraded research without marking or persisting it as fresh evidence', async () => {
    mocks.getSources.mockResolvedValueOnce({
      query: 'Latest calm launch plan today',
      sources: [{
        source_id: 'source_1',
        title: 'Current source',
        url: 'https://example.org/current',
        source_type: 'article',
        relevance_note: 'Current evidence',
      }],
      degraded: true,
      warnings: ['One research source was unavailable.'],
    });

    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Latest calm launch plan today',
    })).rejects.toMatchObject({
      code: 'CONTENT_RESEARCH_UNAVAILABLE',
      status: 503,
      details: {
        retryable: true,
        route: 'fresh_compact',
        degraded: true,
        warnings: ['One research source was unavailable.'],
      },
    });

    expect(mocks.persistContentArtifacts).not.toHaveBeenCalled();
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it('surfaces a usable degraded hook fallback and requires human review', async () => {
    mocks.getHooks.mockResolvedValueOnce({
      topic: 'Calm launch plan',
      niche: 'general',
      hooks: [{
        text: 'Start with one concrete moment from the launch.',
        trigger_type: 'story',
        score: 0,
        why: 'Deterministic fallback',
        sfx: '',
        edit_cue: '',
      }],
      duration_ms: 1,
      degraded: true,
      warnings: ['Provider output did not match the contract; one fallback hook was emitted.'],
    });

    const result = await generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Calm launch plan',
    });

    expect(result).toMatchObject({
      degraded: true,
      warnings: ['Provider output did not match the contract; one fallback hook was emitted.'],
      authority: {
        status: 'proposal',
        humanReviewRequired: true,
      },
    });
  });

  it.each([
    {
      operation: 'titles' as const,
      provider: 'getTitles' as const,
      response: {
        topic: 'Calm launch plan', titles: [], duration_ms: 1, degraded: true,
        warnings: ['Provider output did not match the contract; no titles were emitted.'],
      },
      extraInput: {},
    },
    {
      operation: 'thumbnail' as const,
      provider: 'getThumbnail' as const,
      response: {
        title: 'Calm launch plan', concepts: [], duration_ms: 1, degraded: true,
        warnings: ['Provider output did not match the contract; no thumbnail concepts were emitted.'],
      },
      extraInput: { title: 'Calm launch plan' },
    },
    {
      operation: 'caption' as const,
      provider: 'getCaption' as const,
      response: {
        topic: 'Calm launch plan', caption: '', hashtags: [], duration_ms: 1, degraded: true,
        warnings: ['Provider output did not match the contract; no caption was emitted.'],
      },
      extraInput: {},
    },
    {
      operation: 'repurpose' as const,
      provider: 'getRepurpose' as const,
      response: {
        topic: 'Calm launch plan', outputs: [], duration_ms: 1, degraded: true,
        warnings: ['Provider output did not match the contract; no repurposed outputs were emitted.'],
      },
      extraInput: { sourceContent: 'A bounded source draft.' },
    },
  ])('returns typed unavailability for empty degraded $operation output', async ({
    operation,
    provider,
    response,
    extraInput,
  }) => {
    mocks[provider].mockResolvedValueOnce(response);

    await expect(generateContentCreativeProposal({
      ...scope,
      ...extraInput,
      operation,
      language: 'en-US',
      topic: 'Calm launch plan',
    })).rejects.toMatchObject({
      code: 'CONTENT_CREATIVE_OUTPUT_UNAVAILABLE',
      status: 503,
      details: {
        operation,
        degraded: true,
        retryable: true,
        warnings: response.warnings,
      },
    });
  });

  it.each(['topic\nwith break', 'niche\twith tab'])('rejects control characters before provider work', async (value) => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: value.startsWith('topic') ? value : 'Calm launch plan',
      niche: value.startsWith('niche') ? value : 'general',
    })).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });

    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it('preserves bounded multiline source drafts for repurpose proposals', async () => {
    const sourceContent = 'Opening paragraph.\n\nSecond paragraph with a\tstructured note.';

    await generateContentCreativeProposal({
      ...scope,
      operation: 'repurpose',
      language: 'en-US',
      topic: 'Calm launch plan',
      sourceContent,
    });

    expect(mocks.getRepurpose).toHaveBeenCalledWith(
      'Calm launch plan',
      sourceContent,
      'YouTube',
      expect.any(Object),
    );
  });

  it('blocks a high-risk topic before source lookup, research, persistence, or generation', async () => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'caption',
      language: 'en-US',
      topic: 'medical treatment today',
    })).rejects.toMatchObject({
      code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
      status: 422,
      details: {
        reviewAuthority: 'not_supported',
        requiredEvidence: 'reviewer_attested_source_package',
        retryable: false,
      },
    });

    expect(mocks.getContentSourcePackage).not.toHaveBeenCalled();
    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.deepSearch).not.toHaveBeenCalled();
    expect(mocks.persistContentArtifacts).not.toHaveBeenCalled();
    expect(mocks.getCaption).not.toHaveBeenCalled();
  });

  it('blocks a high-risk niche before researching the neutral topic', async () => {
    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'hooks',
      language: 'en-US',
      topic: 'Calm launch plan',
      niche: 'medical treatment',
    })).rejects.toMatchObject({ code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED', status: 422 });

    expect(mocks.deepSearch).not.toHaveBeenCalled();
    expect(mocks.getHooks).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: 'thumbnail' as const,
      title: 'Medical treatment guide',
      topic: 'Calm launch plan',
    },
    {
      operation: 'repurpose' as const,
      topic: 'Calm launch plan',
      sourceContent: 'A draft recommending medical treatment.',
    },
  ])('blocks high-risk $operation secondary content before any provider work', async (request) => {
    await expect(generateContentCreativeProposal({
      ...scope,
      ...request,
      language: 'en-US',
    })).rejects.toMatchObject({ code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED', status: 422 });

    expect(mocks.getContentSourcePackage).not.toHaveBeenCalled();
    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.deepSearch).not.toHaveBeenCalled();
    expect(mocks.persistContentArtifacts).not.toHaveBeenCalled();
    expect(mocks.getThumbnail).not.toHaveBeenCalled();
    expect(mocks.getRepurpose).not.toHaveBeenCalled();
  });

  it('grounds a neutral repurpose topic and the timely source draft that triggered research', async () => {
    const sourceContent = 'Current platform policy source draft this month.';
    const groundingTopic = `TOPIC: Calm launch plan | SOURCE_CONTENT: ${sourceContent}`;

    await generateContentCreativeProposal({
      ...scope,
      operation: 'repurpose',
      language: 'pt-PT',
      topic: 'Calm launch plan',
      sourceContent,
    });

    expect(mocks.getSources).toHaveBeenCalledWith(
      groundingTopic,
      expect.objectContaining({ language: 'pt-PT' }),
    );
    expect(mocks.persistContentArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      topic: groundingTopic,
      sourcePackage: expect.objectContaining({
        topicHash: hashTopic(groundingTopic),
      }),
      recordIdeaMemory: false,
    }));
    expect(mocks.getRepurpose).toHaveBeenCalledWith(
      'Calm launch plan',
      sourceContent,
      'YouTube',
      expect.objectContaining({ sourceSummary: expect.any(Array) }),
    );
  });

  it('includes every same-priority research trigger in deterministic semantic order', async () => {
    await generateContentCreativeProposal({
      ...scope,
      operation: 'titles',
      language: 'en-US',
      topic: 'Current launch policy',
      niche: 'recent creator news',
    });

    expect(mocks.getSources).toHaveBeenCalledWith(
      'TOPIC: Current launch policy | NICHE: recent creator news',
      expect.objectContaining({ language: 'en-US' }),
    );
  });

  it('binds a timely niche package to the neutral primary topic as well as the niche', async () => {
    const firstGroundingTopic = 'TOPIC: Calm launch plan | NICHE: recent creator news';
    mocks.getContentSourcePackage.mockReturnValue(storedPackage({
      topicHash: hashTopic(firstGroundingTopic),
    }));

    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'titles',
      language: 'en-US',
      topic: 'Different product launch',
      niche: 'recent creator news',
      sourcePackageId: 'sp_test_package',
    })).rejects.toMatchObject({ code: 'CONTENT_SOURCE_PACKAGE_TOPIC_MISMATCH', status: 409 });

    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.getTitles).not.toHaveBeenCalled();
  });

  it('deduplicates thumbnail title fallback before building the research subject', async () => {
    const title = `Latest creator platform change today ${'x'.repeat(950)}`;

    await generateContentCreativeProposal({
      ...scope,
      operation: 'thumbnail',
      language: 'en-US',
      topic: title,
      title,
    });

    expect(mocks.getSources).toHaveBeenCalledWith(
      title,
      expect.objectContaining({ language: 'en-US' }),
    );
    expect(mocks.getThumbnail).toHaveBeenCalled();
  });

  it('fails closed when every winning research input cannot fit the grounding-query boundary', async () => {
    const oversizedTimelyDraft = `current platform policy ${'x'.repeat(2_100)}`;

    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'repurpose',
      language: 'en-US',
      topic: 'Calm launch plan',
      sourceContent: oversizedTimelyDraft,
    })).rejects.toMatchObject({ code: 'CONTENT_GROUNDING_QUERY_TOO_LARGE', status: 422 });

    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.getRepurpose).not.toHaveBeenCalled();
  });

  it('does not let any stored package bypass the high-risk review boundary', async () => {
    mocks.getContentSourcePackage.mockReturnValue(storedPackage({
      topicHash: hashTopic('medical treatment today'),
      freshnessClass: 'deep',
      sourceSummary: ['Source-bound claim; source_ids=source_1; claim=Review is still required.'],
    }));

    await expect(generateContentCreativeProposal({
      ...scope,
      operation: 'caption',
      language: 'en-US',
      topic: 'medical treatment today',
      sourcePackageId: 'sp_test_package',
    })).rejects.toMatchObject({ code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED', status: 422 });

    expect(mocks.getContentSourcePackage).not.toHaveBeenCalled();
    expect(mocks.deepSearch).not.toHaveBeenCalled();
    expect(mocks.getCaption).not.toHaveBeenCalled();
  });
});

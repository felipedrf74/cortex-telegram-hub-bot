// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';
import {
  buildContentResearchPackage,
  isBlockingResearchWarning,
  isMockResearchSource,
  isVerifiableResearchSource,
} from '../../src/services/content-research-package';
import { isMockContentSource } from '../../src/services/content-token-economy';

describe('content research package contract', () => {
  it('classifies real source-backed research as publishable', () => {
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    const pkg = buildContentResearchPackage({
      topic: 'Creator brand voice testing',
      route: 'fresh_compact',
      sourceOrigin: 'server_fetched',
      rawSources: [{
        title: 'Creator strategy report',
        url: 'https://publisher.test/report',
        source_type: 'news',
        relevance_note: 'Explains why voice consistency matters',
      }],
    });

    expect(pkg).toMatchObject({
      topic: 'Creator brand voice testing',
      sourceMode: 'real',
      sourceCount: 1,
      realSourceCount: 1,
      mockSourceCount: 0,
      observedAt: '2026-06-24T12:00:00.000Z',
      publishable: true,
    });
    expect(pkg.claimLedger[0]).toMatchObject({ support: 'source_backed' });
  });

  it('defaults request-body URLs to client-asserted non-publishable provenance', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Client source default',
      rawSources: [{
        title: 'Looks like a public article',
        url: 'https://publisher.test/research',
        source_type: 'news',
        relevance_note: 'Caller supplied this URL without server fetch evidence',
      }],
    });

    expect(pkg).toMatchObject({
      sourceMode: 'none',
      sourceCount: 1,
      realSourceCount: 0,
      publishable: false,
    });
    expect(pkg.sources[0]).toMatchObject({
      origin: 'client_asserted',
      serverFetched: false,
      verifiable: false,
    });
  });

  it('does not treat client-asserted URLs as server-fetched provenance', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Client asserted source',
      sourceOrigin: 'client_asserted',
      rawSources: [{
        title: 'Looks like a real article',
        url: 'https://publisher.test/research',
        source_type: 'news',
        relevance_note: 'Caller supplied this URL without server fetch evidence',
      }],
    });

    expect(pkg).toMatchObject({
      sourceMode: 'none',
      sourceCount: 1,
      realSourceCount: 0,
      publishable: false,
    });
    expect(pkg.sources[0]).toMatchObject({
      origin: 'client_asserted',
      serverFetched: false,
      verifiable: false,
    });
    expect(pkg.claimLedger[0]).toMatchObject({
      support: 'unverified',
      sourceRef: pkg.sources[0].id,
    });
  });

  it('marks mock and degraded research as non-publishable with explicit warnings', () => {
    const mockPkg = buildContentResearchPackage({
      topic: 'Mock trend',
      rawSources: [{
        title: '[Mock] viral example',
        url: 'https://example.com/mock-trend',
        source_type: 'web',
        relevance_note: 'mock fixture',
      }],
    });
    const degradedPkg = buildContentResearchPackage({
      topic: 'Fallback trend',
      rawSources: [],
      degraded: true,
      cacheStatus: 'fallback',
    });

    expect(isMockResearchSource(mockPkg.sources[0] as any)).toBe(true);
    expect(mockPkg.sourceMode).toBe('mock');
    expect(mockPkg.publishable).toBe(false);
    expect(mockPkg.warnings).toContain('mock_research_sources_non_publishable');
    expect(degradedPkg.sourceMode).toBe('degraded');
    expect(degradedPkg.publishable).toBe(false);
    expect(degradedPkg.warnings).toContain('research_degraded_non_publishable');
  });

  it('blocks untrusted and prompt-injection research warnings from publishable packages', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Prompt injection risk',
      sourceOrigin: 'server_fetched',
      rawSources: [{
        title: 'Trusted looking article',
        url: 'https://publisher.example/risk',
        source_type: 'web',
        relevance_note: 'Useful but warning-bearing source',
      }],
      warnings: ['untrusted_source_prompt_injection_detected'],
    });

    expect(pkg.sourceMode).toBe('real');
    expect(pkg.realSourceCount).toBe(1);
    expect(isBlockingResearchWarning('untrusted_source_prompt_injection_detected')).toBe(true);
    expect(pkg.publishable).toBe(false);
  });

  it('excludes URL-less and non-http sources from real source counts', () => {
    const transcriptPkg = buildContentResearchPackage({
      topic: 'Competitor transcript study',
      rawSources: [{
        title: 'Transcript pasted by user',
        url: '',
        source_type: 'transcript',
        relevance_note: 'User pasted transcript without a verifiable source URL',
      }],
    });
    const mailtoPkg = buildContentResearchPackage({
      topic: 'Non-web citation',
      rawSources: [{
        title: 'Email source',
        url: 'mailto:creator@example.com',
        source_type: 'email',
        relevance_note: 'Not a publishable public source',
      }],
    });

    expect(isVerifiableResearchSource(transcriptPkg.sources[0] as any)).toBe(false);
    expect(transcriptPkg).toMatchObject({
      sourceMode: 'none',
      realSourceCount: 0,
      publishable: false,
    });
    expect(transcriptPkg.warnings).toEqual(expect.arrayContaining([
      'unverifiable_sources_excluded_from_publishable_package',
      'no_real_sources_available',
    ]));
    expect(mailtoPkg.sourceMode).toBe('none');
    expect(mailtoPkg.realSourceCount).toBe(0);
    expect(mailtoPkg.publishable).toBe(false);
  });

  it('scores claim ledger support against each aligned source instead of the package total', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Mixed evidence package',
      sourceOrigin: 'server_fetched',
      rawSources: [
        {
          title: 'Public creator research',
          url: 'https://publisher.example/creator-research',
          source_type: 'news',
          relevance_note: 'Public source backs the market claim',
        },
        {
          title: 'User pasted transcript',
          url: '',
          source_type: 'transcript',
          relevance_note: 'Transcript explains a competitor pattern without a public URL',
        },
      ],
    });

    expect(pkg.sourceMode).toBe('real');
    expect(pkg.realSourceCount).toBe(1);
    expect(pkg.claimLedger[0]).toMatchObject({
      support: 'source_backed',
      sourceRef: pkg.sources[0].id,
    });
    expect(pkg.claimLedger[1]).toMatchObject({
      support: 'unverified',
      sourceRef: pkg.sources[1].id,
    });
  });

  it('keeps claim ledger aligned when a source has empty title and note', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Mixed evidence with sparse source metadata',
      sourceOrigin: 'server_fetched',
      rawSources: [
        {
          title: '',
          url: 'https://publisher.test/sparse-source',
          source_type: 'news',
          relevance_note: '',
        },
        {
          title: 'User pasted transcript',
          url: '',
          source_type: 'transcript',
          relevance_note: 'Transcript explains a competitor pattern without a public URL',
        },
      ],
    });

    expect(pkg.sourceSummaries[0]).toBe('https://publisher.test/sparse-source');
    expect(pkg.claimLedger[0]).toMatchObject({
      claim: 'https://publisher.test/sparse-source',
      support: 'source_backed',
      sourceRef: pkg.sources[0].id,
    });
    expect(pkg.claimLedger[1]).toMatchObject({
      claim: 'User pasted transcript - Transcript explains a competitor pattern without a public URL',
      support: 'unverified',
      sourceRef: pkg.sources[1].id,
    });
  });

  it('keeps extra prebuilt source summaries unverified when no aligned source exists', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Prebuilt summary alignment',
      sourceOrigin: 'server_fetched',
      sourcePackage: {
        sourcePackageId: 'pkg_alignment',
        route: 'fresh_compact',
        freshnessClass: 'fresh',
        sourceSummaries: ['Aligned public source', 'Unaligned generated summary'],
        sources: [{
          title: 'Aligned public source',
          url: 'https://publisher.example/aligned',
          source_type: 'news',
          relevance_note: 'Backs only the first summary',
        }],
        expiresAt: null,
      } as any,
    });

    expect(pkg.claimLedger[0]).toMatchObject({
      support: 'source_backed',
      sourceRef: pkg.sources[0].id,
    });
    expect(pkg.claimLedger[1]).toMatchObject({
      support: 'unverified',
      sourceRef: null,
    });
  });

  it('derives source-backed claim text from the paired source instead of positional external summaries', () => {
    const pkg = buildContentResearchPackage({
      topic: 'External package claim safety',
      sourceOrigin: 'server_fetched',
      sourcePackage: {
        sourcePackageId: 'pkg_claim_safety',
        route: 'fresh_compact',
        freshnessClass: 'fresh',
        sourceSummaries: ['Generated summary that should not become a source-backed claim'],
        sources: [{
          title: 'Observed source title',
          url: 'https://publisher.example/observed',
          source_type: 'news',
          relevance_note: 'Observed source note',
        }],
        expiresAt: null,
      } as any,
    });

    expect(pkg.claimLedger[0]).toMatchObject({
      claim: 'Observed source title - Observed source note',
      support: 'source_backed',
      sourceRef: pkg.sources[0].id,
    });
    expect(pkg.claimLedger[0].claim).not.toBe('Generated summary that should not become a source-backed claim');
  });

  it('recognizes explicit mock metadata even when titles and URLs look real', () => {
    const pkg = buildContentResearchPackage({
      topic: 'Metadata marked fixture',
      rawSources: [{
        title: 'Clean display title',
        url: 'https://news.example.org/clean-display',
        source_type: 'news',
        relevance_note: 'Looks real but was emitted by a fixture searcher',
        metadata: { mock: true },
      } as any],
    });

    expect(pkg.sourceMode).toBe('mock');
    expect(pkg.realSourceCount).toBe(0);
    expect(pkg.mockSourceCount).toBe(1);
    expect(pkg.publishable).toBe(false);
  });

  it('matches the Python mock URL corpus without broad subdomain or note downgrades', () => {
    expect(isMockResearchSource({
      title: 'Example fixture',
      url: 'https://example.org/report',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockContentSource({
      title: 'Example fixture',
      url: 'https://example.org/report',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockResearchSource({
      title: 'Path fixture',
      url: 'https://publisher.test/research/mock/source',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockContentSource({
      title: 'Path fixture',
      url: 'https://publisher.test/research/mock/source',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockResearchSource({
      title: 'Reddit fixture',
      url: 'https://reddit.com/r/mock/comments/1',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockContentSource({
      title: 'Reddit fixture',
      url: 'https://reddit.com/r/mock/comments/1',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockResearchSource({
      title: 'Query fixture',
      url: 'https://publisher.test/research?mock=1',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockContentSource({
      title: 'Query fixture',
      url: 'https://publisher.test/research?mock=1',
      source_type: 'web',
      relevance_note: 'fixture source',
    })).toBe(true);
    expect(isMockResearchSource({
      title: 'Duplicate query fixture',
      url: 'https://publisher.test/research?mock=0&mock=1',
      source_type: 'web',
      relevance_note: 'Explicit query mock marker',
    })).toBe(true);
    expect(isMockContentSource({
      title: 'Duplicate query fixture',
      url: 'https://publisher.test/research?mock=0&mock=1',
      source_type: 'web',
      relevance_note: 'Explicit query mock marker',
    })).toBe(true);
    expect(isMockResearchSource({
      title: 'FTP reserved host',
      url: 'ftp://example.org/report',
      source_type: 'web',
      relevance_note: 'Reserved host over an unsupported URL scheme',
    })).toBe(false);
    expect(isMockContentSource({
      title: 'FTP reserved host',
      url: 'ftp://example.org/report',
      source_type: 'web',
      relevance_note: 'Reserved host over an unsupported URL scheme',
    })).toBe(false);
    expect(isMockResearchSource({
      title: 'Real publisher',
      url: 'https://news.example.org/report',
      source_type: 'news',
      relevance_note: 'Real subdomain should not match exact example.org host',
    })).toBe(false);
    expect(isMockContentSource({
      title: 'Real publisher',
      url: 'https://news.example.org/report',
      source_type: 'news',
      relevance_note: 'Real subdomain should not match exact example.org host',
    })).toBe(false);
    expect(isMockResearchSource({
      title: 'Mockingbird product research',
      url: 'https://mockingbird.com/research/report',
      source_type: 'news',
      relevance_note: 'A real article about a mock exam',
    })).toBe(false);
    expect(isMockContentSource({
      title: 'Mockingbird product research',
      url: 'https://mockingbird.com/research/report',
      source_type: 'news',
      relevance_note: 'A real article about a mock exam',
    })).toBe(false);
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { SourceReference } from './content-engine';
import type { ResearchRoute, SourcePackage } from './content-token-economy';

export type ContentResearchSourceMode = 'real' | 'fixture' | 'mock' | 'degraded' | 'none';
export type ContentResearchSourceOrigin = 'server_fetched' | 'client_asserted' | 'fixture';

export interface ContentResearchPackageSource {
  id: string;
  title: string;
  url: string;
  sourceType: string;
  publisher: string | null;
  publishedAt: string | null;
  observedAt: string;
  relevanceNote: string;
  confidence: number;
  mock: boolean;
  origin: ContentResearchSourceOrigin;
  serverFetched: boolean;
  verifiable: boolean;
}

export const BLOCKING_RESEARCH_WARNING_PATTERNS = [
  /non_publishable/i,
  /degraded/i,
  /mock/i,
  /untrusted/i,
  /prompt[_ -]?injection/i,
  /no_real_sources/i,
] as const;

export interface ContentResearchPackage {
  packageId: string;
  topic: string;
  query: string;
  route: ResearchRoute | string | null;
  sourceMode: ContentResearchSourceMode;
  freshnessClass: SourcePackage['freshnessClass'] | 'unknown';
  sourceCount: number;
  realSourceCount: number;
  mockSourceCount: number;
  observedAt: string;
  expiresAt: string | null;
  confidence: number;
  publishable: boolean;
  sources: ContentResearchPackageSource[];
  sourceSummaries: string[];
  claimLedger: Array<{
    claim: string;
    support: 'source_backed' | 'unverified';
    sourceRef?: string | null;
  }>;
  warnings: string[];
}

export function buildContentResearchPackage(input: {
  topic: string;
  query?: string | null;
  route?: ResearchRoute | string | null;
  sourcePackage?: SourcePackage | null;
  rawSources?: Array<Partial<SourceReference>> | null;
  sourceOrigin?: ContentResearchSourceOrigin | null;
  degraded?: boolean | null;
  cacheStatus?: string | null;
  warnings?: string[] | null;
  observedAt?: string | null;
}): ContentResearchPackage {
  const observedAt = input.observedAt || new Date().toISOString();
  const rawSources = input.sourcePackage?.sources ?? (input.rawSources ?? []);
  const sourceOrigin = input.sourceOrigin ?? 'client_asserted';
  const sources = rawSources.map((source, index) => normalizeResearchSource(source, index, observedAt, sourceOrigin));
  const mockSourceCount = sources.filter((source) => source.mock).length;
  const realSourceCount = sources.filter((source) => !source.mock && source.verifiable).length;
  const unverifiableSourceCount = sources.filter((source) => !source.mock && !source.verifiable).length;
  const degraded = input.degraded === true || input.cacheStatus === 'fallback';
  const sourceMode = classifySourceMode({
    degraded,
    sources,
    warnings: input.warnings ?? [],
  });
  const sourceSummaries = input.sourcePackage?.sourceSummaries?.length
    ? input.sourcePackage.sourceSummaries
    : sources.map(sourceSummaryForLedger);
  const warnings = buildResearchWarnings({
    sourceMode,
    inputWarnings: input.warnings ?? [],
    mockSourceCount,
    realSourceCount,
    unverifiableSourceCount,
  });
  const confidence = confidenceForResearch(sourceMode, realSourceCount, warnings.length);
  const packageId = `crp_${stableHash([
    input.topic,
    input.query ?? input.topic,
    input.route ?? '',
    sourceMode,
    ...sources.map((source) => `${source.title}:${source.url}`),
  ].join('|'))}`;

  return {
    packageId,
    topic: input.topic.trim(),
    query: (input.query || input.topic).trim(),
    route: input.route ?? null,
    sourceMode,
    freshnessClass: input.sourcePackage?.freshnessClass ?? 'unknown',
    sourceCount: sources.length,
    realSourceCount,
    mockSourceCount,
    observedAt,
    expiresAt: input.sourcePackage?.expiresAt ?? null,
    confidence,
    publishable: sourceMode === 'real' && realSourceCount > 0 && warnings.every((warning) => !isBlockingResearchWarning(warning)),
    sources,
    sourceSummaries,
    claimLedger: buildClaimLedgerFromSources(sourceSummaries, sources),
    warnings,
  };
}

function buildClaimLedgerFromSources(
  sourceSummaries: string[],
  sources: ContentResearchPackageSource[],
): ContentResearchPackage['claimLedger'] {
  const ledger = sources.slice(0, 10).map((source, index) => {
    const support: 'source_backed' | 'unverified' = !source.mock && source.verifiable ? 'source_backed' : 'unverified';
    return {
      claim: sourceSummaryForLedger(source, index),
      support,
      sourceRef: source.id,
    };
  });
  if (ledger.length >= 10) return ledger;
  const unalignedSummaries = sourceSummaries
    .slice(sources.length, sources.length + (10 - ledger.length))
    .map((claim) => ({
      claim,
      support: 'unverified' as const,
      sourceRef: null,
    }));
  return [...ledger, ...unalignedSummaries];
}

export function isMockResearchSource(source: Partial<SourceReference> | null | undefined): boolean {
  if (!source) return false;
  if ((source as any).mock === true || (source as any).metadata?.mock === true) return true;
  const title = String(source.title || '').trim();
  const url = String(source.url || '').trim();
  const note = String(source.relevance_note || '').trim();
  return /^\[mock\]/i.test(title)
    || isMockResearchUrl(url)
    || isMockResearchNote(note);
}

export function isMockResearchUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (['example.com', 'www.example.com', 'example.org', 'www.example.org'].includes(host)) return true;
    const pathSegments = parsed.pathname.split('/').map((segment) => segment.toLowerCase()).filter(Boolean);
    if (pathSegments.includes('mock')) return true;
    return parsed.searchParams.getAll('mock').includes('1');
  } catch {
    return false;
  }
}

function isMockResearchNote(note: string): boolean {
  return /\[(mock|fixture)\]/i.test(note)
    || /\b(?:mock|mocked)\s+(?:source|data|fixture|research|response|result)\b/i.test(note)
    || /\b(?:source|data|fixture|research|response|result)\s+(?:mock|mocked)\b/i.test(note)
    || /\bfixture\s+mock\b/i.test(note)
    || /\bmock\s+fixture\b/i.test(note);
}

export function isVerifiableResearchSource(
  source: Partial<SourceReference> | null | undefined,
  options: { serverFetched?: boolean } = {},
): boolean {
  if (!source) return false;
  const url = String(source.url || '').trim();
  const serverFetched = options.serverFetched ?? Boolean((source as any).serverFetched);
  return serverFetched && /^https?:\/\//i.test(url);
}

export function researchPublishabilityBlockers(pkg: Pick<ContentResearchPackage, 'publishable' | 'sourceMode'> | null | undefined): string[] {
  if (!pkg || pkg.publishable) return [];
  return [pkg.sourceMode === 'none'
    ? 'research_sources_missing_review_required'
    : 'research_package_non_publishable'];
}

export function isBlockingResearchWarning(warning: string): boolean {
  return BLOCKING_RESEARCH_WARNING_PATTERNS.some((pattern) => pattern.test(warning));
}

function normalizeResearchSource(
  source: Partial<SourceReference>,
  index: number,
  observedAt: string,
  origin: ContentResearchSourceOrigin,
): ContentResearchPackageSource {
  const title = String(source.title || '').trim();
  const url = String(source.url || '').trim();
  const sourceType = String(source.source_type || (source as any).sourceType || 'unknown').trim();
  const mock = isMockResearchSource(source);
  const serverFetched = origin === 'server_fetched';
  const verifiable = isVerifiableResearchSource(source, { serverFetched });
  return {
    id: `src_${stableHash(`${title}|${url}|${sourceType}|${index}`)}`,
    title,
    url,
    sourceType,
    publisher: publisherFromUrl(url),
    publishedAt: null,
    observedAt,
    relevanceNote: String(source.relevance_note || '').trim(),
    confidence: mock ? 0.1 : !verifiable ? 0.2 : sourceType === 'unknown' ? 0.45 : 0.75,
    mock,
    origin,
    serverFetched,
    verifiable,
  };
}

function sourceSummaryForLedger(source: ContentResearchPackageSource, index: number): string {
  const summary = [source.title, source.relevanceNote].filter(Boolean).join(' - ').trim();
  if (summary) return summary;
  if (source.url) return source.url;
  if (source.sourceType && source.sourceType !== 'unknown') return `${source.sourceType} source ${index + 1}`;
  return `Source ${index + 1}`;
}

function classifySourceMode(input: {
  degraded: boolean;
  sources: ContentResearchPackageSource[];
  warnings: string[];
}): ContentResearchSourceMode {
  if (input.degraded) return 'degraded';
  if (input.sources.length === 0) return 'none';
  if (input.sources.some((source) => source.mock)) return 'mock';
  if (input.warnings.some((warning) => /fixture/i.test(warning))) return 'fixture';
  if (!input.sources.some((source) => source.verifiable)) return 'none';
  return 'real';
}

function buildResearchWarnings(input: {
  sourceMode: ContentResearchSourceMode;
  inputWarnings: string[];
  mockSourceCount: number;
  realSourceCount: number;
  unverifiableSourceCount: number;
}): string[] {
  const warnings = [...input.inputWarnings];
  if (input.sourceMode === 'degraded') warnings.push('research_degraded_non_publishable');
  if (input.sourceMode === 'mock') warnings.push('mock_research_sources_non_publishable');
  if (input.sourceMode === 'fixture') warnings.push('fixture_research_sources_require_test_context');
  if (input.sourceMode === 'none') warnings.push('research_sources_missing_review_required');
  if (input.mockSourceCount > 0) warnings.push('mock_sources_excluded_from_publishable_package');
  if (input.unverifiableSourceCount > 0) warnings.push('unverifiable_sources_excluded_from_publishable_package');
  if (input.realSourceCount === 0) warnings.push('no_real_sources_available');
  return [...new Set(warnings)];
}

function confidenceForResearch(sourceMode: ContentResearchSourceMode, realSourceCount: number, warningCount: number): number {
  if (sourceMode === 'real') return Math.max(0.55, Math.min(0.95, 0.55 + realSourceCount * 0.08 - warningCount * 0.03));
  if (sourceMode === 'fixture') return 0.35;
  if (sourceMode === 'mock') return 0.2;
  if (sourceMode === 'degraded') return 0.25;
  return 0.15;
}

function publisherFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

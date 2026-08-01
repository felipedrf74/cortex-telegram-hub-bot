// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deterministic redaction for the committed chat live-eval archive.
 *
 * The private run output carries raw user turns, model responses, provider
 * judge rationales, and the active tenant id. Repository law forbids committing
 * raw provider payloads or user content, so the governed
 * `docs/release/eval-evidence/<run-id>.json` pair is a redacted projection:
 * every metric, score, identity, and categorical field is preserved byte-for-
 * byte while free text is replaced with a fixed marker.
 *
 * Classification is fail-closed. `RETAINED_STRING_PATHS` enumerates every
 * string the archive may keep; anything else must be listed in
 * `REDACTED_PATHS`. A harness version that introduces a new string field
 * therefore fails `chatEvalEvidenceRawTextFindings` until an owner classifies
 * it, instead of silently leaking turn-derived text into Git.
 */

export const CHAT_EVAL_EVIDENCE_REDACTION_VERSION = 'chat-eval-evidence-redaction@1.0.0';

/** Fixed, type-preserving replacement so array lengths and shapes survive. */
export const CHAT_EVAL_REDACTED_TEXT_MARKER = '[redacted]';

/**
 * Free text derived from a user turn, a model response, provider judge output,
 * or a tenant identity. `[]` matches an array element, `*` any single key.
 */
const REDACTED_PATHS = [
  'dayToDay.scenarios[].turns[].userMessage',
  'dayToDay.scenarios[].turns[].response.text',
  'dayToDay.scenarios[].turns[].response.iosEnvelope.text',
  'dayToDay.scenarios[].turns[].response.safetyNotes[]',
  'dayToDay.scenarios[].turns[].scorerDimensions[].detail',
  'dayToDay.scenarios[].turns[].failures[].detail',
  'dayToDay.judge.scenarios[].scores.*.rationale',
  'judge.scenarios[].scores.*.rationale',
  'scenarios[].failures[]',
] as const;

/** Tenant/user identifiers dropped rather than markered (non-string values). */
const DROPPED_IDENTIFIER_PATHS = [
  'dayToDay.scenarios[].turns[].activeTenantId',
] as const;

/**
 * Every string the redacted archive is allowed to keep: stable ids, enum
 * labels, versions, hashes, and repo-authored fixture titles.
 */
const RETAINED_STRING_PATHS = new Set<string>([
  'generatedAt',
  'mode',
  'evaluationProfile',
  'scenarios[].id',
  'scenarios[].title',
  'scenarios[].personaId',
  'scenarios[].evidenceMode',
  'scenarios[].status',
  'catalogCoverage.ids[]',
  'catalogCoverage.reasonCode',
  'dayToDay.generatedAt',
  'dayToDay.mode',
  'dayToDay.scenarios[].scenarioId',
  'dayToDay.scenarios[].title',
  'dayToDay.scenarios[].personaId',
  'dayToDay.scenarios[].turns[].turnId',
  'dayToDay.scenarios[].turns[].scenarioId',
  'dayToDay.scenarios[].turns[].expectedLanguage',
  'dayToDay.scenarios[].turns[].executionStatus',
  'dayToDay.scenarios[].turns[].response.domain',
  'dayToDay.scenarios[].turns[].response.actionStatus',
  'dayToDay.scenarios[].turns[].response.skillsUsed[]',
  'dayToDay.scenarios[].turns[].response.providerTrace.provider',
  'dayToDay.scenarios[].turns[].response.providerTrace.model',
  'dayToDay.scenarios[].turns[].response.providerTrace.category',
  'dayToDay.scenarios[].turns[].response.providerTrace.tier',
  'dayToDay.scenarios[].turns[].response.providerTrace.mode',
  'dayToDay.scenarios[].turns[].response.iosEnvelope.id',
  'dayToDay.scenarios[].turns[].response.iosEnvelope.domain',
  'dayToDay.scenarios[].turns[].response.iosEnvelope.timestamp',
  'dayToDay.scenarios[].turns[].response.iosEnvelope.routeMethod',
  'dayToDay.scenarios[].turns[].scorerDimensions[].dimension',
  'dayToDay.scenarios[].turns[].scorerDimensions[].source',
  'dayToDay.scenarios[].turns[].scorerDimensions[].failureType',
  'dayToDay.scenarios[].turns[].failures[].type',
  'dayToDay.profileCoverage.profileId',
  'dayToDay.profileCoverage.excluded[].scenarioId',
  'dayToDay.profileCoverage.excluded[].reasonCode',
  'dayToDay.profileCoverage.excludedTurns[].scenarioId',
  'dayToDay.profileCoverage.excludedTurns[].turnId',
  'dayToDay.profileCoverage.excludedTurns[].reasonCode',
  'dayToDay.judge.model',
  'dayToDay.judge.scenarios[].scenarioId',
  'dayToDay.judge.scenarios[].status',
  'dayToDay.judge.scenarios[].detail',
  'judge.model',
  'judge.scenarios[].scenarioId',
  'judge.scenarios[].status',
  'judge.scenarios[].detail',
]);

/**
 * Attestation and catalog strings, enumerated rather than whitelisted by
 * prefix. `preflightAttestation` is echoed from the evaluated server's
 * response, so a subtree wildcard here would be fail-OPEN: any key that server
 * chose to add would be published unreviewed. Listing them means a new
 * attestation field must be classified before it can ship.
 */
const RETAINED_ATTESTATION_STRING_PATHS = new Set<string>([
  'preflightAttestation.contractVersion',
  'preflightAttestation.mode',
  'preflightAttestation.runId',
  'preflightAttestation.targetBaseCategory',
  'preflightAttestation.providerPolicy',
  'preflightAttestation.seedProfileVersion',
  'preflightAttestation.supportedScenarioIds[]',
  'preflightAttestation.deployedRelease.runtimeSha',
  'preflightAttestation.deployedRelease.artifactDigest',
  'preflightAttestation.deployedRelease.role',
  'costAttestation.contractVersion',
  'costAttestation.judgeUsageDatabaseSha256',
  'costAttestation.targetProviders[]',
  'costAttestation.judgeProviders[]',
  'costAttestation.judgeModels[]',
  'costAttestation.reasons[]',
  'costAttestation.preparation.scenarioIds[]',
  'costAttestation.preparation.seedProfileVersions[]',
  'costAttestation.preparation.seedProfileHashes[]',
  // Repo-authored metric catalog shipped in the harness, not turn-derived.
  'qualityMetrics[].id',
  'qualityMetrics[].label',
  'qualityMetrics[].description',
  'qualityMetrics[].source',
  'qualityMetrics[].privacy',
  'qualityMetrics[].target',
  // The redaction manifest this module itself embeds in the archive.
  'redaction.redactionVersion',
  'redaction.sourceSha256',
  'redaction.marker',
  'redaction.removed[].path',
]);

export interface ChatEvalEvidenceRedactionEntry {
  path: string;
  occurrences: number;
  textBytes: number;
}

export interface ChatEvalEvidenceRedactionManifest {
  redactionVersion: string;
  /** SHA-256 of the exact private raw archive this projection was derived from. */
  sourceSha256: string;
  marker: string;
  removed: ChatEvalEvidenceRedactionEntry[];
  totalRemovedOccurrences: number;
  totalRemovedTextBytes: number;
}

export interface ChatEvalEvidenceRawTextFinding {
  path: string;
  occurrences: number;
}

function matchesPattern(path: string, pattern: string): boolean {
  const pathParts = path.split('.');
  const patternParts = pattern.split('.');
  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, index) => part === '*' || part === pathParts[index]);
}

function isRetainedString(path: string): boolean {
  return RETAINED_STRING_PATHS.has(path) || RETAINED_ATTESTATION_STRING_PATHS.has(path);
}

function isRedactedPath(path: string): boolean {
  return REDACTED_PATHS.some((pattern) => matchesPattern(path, pattern));
}

function isDroppedIdentifierPath(path: string): boolean {
  return DROPPED_IDENTIFIER_PATHS.some((pattern) => matchesPattern(path, pattern));
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

/**
 * Rebuild `value` with every classified free-text leaf replaced. Returns a new
 * structure; the caller's evidence is never mutated.
 */
function project(
  value: unknown,
  path: string,
  removed: Map<string, ChatEvalEvidenceRedactionEntry>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => project(item, `${path}[]`, removed));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = project(child, joinPath(path, key), removed);
    }
    return out;
  }

  if (isDroppedIdentifierPath(path)) {
    if (value !== null) record(removed, path, 0);
    return null;
  }
  if (typeof value === 'string' && isRedactedPath(path)) {
    if (value === CHAT_EVAL_REDACTED_TEXT_MARKER) return value;
    record(removed, path, Buffer.byteLength(value, 'utf8'));
    return CHAT_EVAL_REDACTED_TEXT_MARKER;
  }
  return value;
}

function record(
  removed: Map<string, ChatEvalEvidenceRedactionEntry>,
  path: string,
  textBytes: number,
): void {
  // Collapse array indices and judge score dimensions into their pattern so the
  // manifest stays a stable, reviewable list instead of one row per occurrence.
  const pattern = REDACTED_PATHS.find((candidate) => matchesPattern(path, candidate))
    ?? DROPPED_IDENTIFIER_PATHS.find((candidate) => matchesPattern(path, candidate))
    ?? path;
  const entry = removed.get(pattern) ?? { path: pattern, occurrences: 0, textBytes: 0 };
  entry.occurrences += 1;
  entry.textBytes += textBytes;
  removed.set(pattern, entry);
}

/**
 * Produce the committable redacted archive plus a manifest bound to the exact
 * private source digest. Pure and idempotent: redacting an already-redacted
 * archive returns it unchanged.
 */
export function redactChatEvalEvidence(
  raw: unknown,
  sourceSha256: string,
): { redacted: unknown; manifest: ChatEvalEvidenceRedactionManifest } {
  const removed = new Map<string, ChatEvalEvidenceRedactionEntry>();
  const redacted = project(raw, '', removed);
  const entries = [...removed.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    redacted,
    manifest: {
      redactionVersion: CHAT_EVAL_EVIDENCE_REDACTION_VERSION,
      sourceSha256,
      marker: CHAT_EVAL_REDACTED_TEXT_MARKER,
      removed: entries,
      totalRemovedOccurrences: entries.reduce((sum, entry) => sum + entry.occurrences, 0),
      totalRemovedTextBytes: entries.reduce((sum, entry) => sum + entry.textBytes, 0),
    },
  };
}

/**
 * Fail-closed guard for the archive writer and its tests. Reports every string
 * that is neither an explicitly retained field nor an applied redaction marker,
 * so an unclassified new harness field blocks publication.
 */
export function chatEvalEvidenceRawTextFindings(value: unknown): ChatEvalEvidenceRawTextFinding[] {
  const findings = new Map<string, number>();

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, `${path}[]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, joinPath(path, key));
      }
      return;
    }
    if (isDroppedIdentifierPath(path)) {
      if (node !== null) findings.set(path, (findings.get(path) ?? 0) + 1);
      return;
    }
    if (typeof node !== 'string') return;
    if (isRedactedPath(path)) {
      if (node !== CHAT_EVAL_REDACTED_TEXT_MARKER) {
        findings.set(path, (findings.get(path) ?? 0) + 1);
      }
      return;
    }
    if (!isRetainedString(path)) {
      findings.set(path, (findings.get(path) ?? 0) + 1);
    }
  };

  walk(value, '');
  return [...findings.entries()]
    .map(([path, occurrences]) => ({ path, occurrences }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

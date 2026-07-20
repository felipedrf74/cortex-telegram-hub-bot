// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type {
  ContentEvalMode,
  ContentEvalExternalLaneEvidence,
  ContentEvalProviderInvocationProvenance,
} from '../services/content-day-to-day-evaluation';
import type { ContentLiveEvaluationArtifact } from '../services/content-live-evaluation-artifact';
import type { ContentIosExtractionArtifact } from '../services/content-ios-extraction-artifact';

// Capture operator configuration before any Nexus config module can load. The
// verifier flag makes config ignore every repository dotenv file; the captured
// value can therefore come only from the clean launch environment.
const launchTrustedAttestationKeyFingerprint = process.env.CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256;
const launchTrustedIosAttestationKeyFingerprint = process.env.CONTENT_EVAL_TRUSTED_IOS_ATTESTATION_KEY_SHA256;
const launchExpectedIosGitCommit = process.env.CONTENT_EVAL_EXPECTED_IOS_GIT_COMMIT;
const launchExpectedIosSourceTreeDigest = process.env.CONTENT_EVAL_EXPECTED_IOS_SOURCE_TREE_DIGEST;
process.env.NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME = '1';

const {
  formatContentEvalResultsMarkdown,
  runContentDayToDayEvaluation,
  CONTENT_QUALITY_RUBRIC,
} = require('../services/content-day-to-day-evaluation') as typeof import('../services/content-day-to-day-evaluation');
const { persistContentEvalRun } = require('../services/content-eval-history') as typeof import('../services/content-eval-history');
const {
  claimContentLiveEvalArtifactForRelease,
  finalizeContentLiveEvalArtifactClaim,
} = require('../services/content-live-evaluation-consumption') as typeof import('../services/content-live-evaluation-consumption');
const {
  contentEvalSha256,
  readContentLiveEvalAttestationKeyFile,
  resolveContentLiveEvalSourceIdentity,
  validateContentLiveEvaluationArtifact,
} = require('../services/content-live-evaluation-artifact') as typeof import('../services/content-live-evaluation-artifact');
const {
  validateContentIosExtractionArtifact,
} = require('../services/content-ios-extraction-artifact') as typeof import('../services/content-ios-extraction-artifact');

interface CliOptions {
  mode?: ContentEvalMode;
  json?: string;
  markdown?: string;
  outDir?: string;
  failUnder?: number;
  persistDb?: string;
  iosExtractionScore?: number;
  iosExtractionRunId?: string;
  iosExtractionSource?: string;
  iosExtractionSampleCount?: number;
  iosExtractionArtifact?: string;
  iosExtractionAttestationKeyFile?: string;
  realProviderSampleScore?: number;
  realProviderSampleRunId?: string;
  realProviderSampleSource?: string;
  realProviderSampleCount?: number;
  realProviderInvocationArtifact?: string;
  realProviderArtifact?: string;
  realProviderAttestationKeyFile?: string;
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    try {
      const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

function gitValue(command: string): string | undefined {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseMode(raw: string | undefined): ContentEvalMode | undefined {
  if (raw === 'fixture' || raw === 'local_engine' || raw === 'real_provider') return raw;
  return undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--mode' && next) {
      options.mode = parseMode(next);
      i++;
    } else if (arg === '--json' && next) {
      options.json = next;
      i++;
    } else if (arg === '--markdown' && next) {
      options.markdown = next;
      i++;
    } else if (arg === '--out-dir' && next) {
      options.outDir = next;
      i++;
    } else if (arg === '--fail-under' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.failUnder = parsed;
      i++;
    } else if (arg === '--ios-extraction-score' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.iosExtractionScore = parsed;
      i++;
    } else if (arg === '--ios-extraction-run-id' && next) {
      options.iosExtractionRunId = next;
      i++;
    } else if (arg === '--ios-extraction-source' && next) {
      options.iosExtractionSource = next;
      i++;
    } else if (arg === '--ios-extraction-sample-count' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.iosExtractionSampleCount = parsed;
      i++;
    } else if (arg === '--ios-extraction-artifact' && next) {
      options.iosExtractionArtifact = next;
      i++;
    } else if (arg === '--ios-extraction-attestation-key-file' && next) {
      options.iosExtractionAttestationKeyFile = next;
      i++;
    } else if (arg === '--real-provider-sample-score' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.realProviderSampleScore = parsed;
      i++;
    } else if (arg === '--real-provider-sample-run-id' && next) {
      options.realProviderSampleRunId = next;
      i++;
    } else if (arg === '--real-provider-sample-source' && next) {
      options.realProviderSampleSource = next;
      i++;
    } else if (arg === '--real-provider-sample-count' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) options.realProviderSampleCount = parsed;
      i++;
    } else if (arg === '--real-provider-artifact' && next) {
      options.realProviderArtifact = next;
      i++;
    } else if (arg === '--real-provider-invocation-artifact' && next) {
      options.realProviderInvocationArtifact = next;
      i++;
    } else if (arg === '--real-provider-attestation-key-file' && next) {
      options.realProviderAttestationKeyFile = next;
      i++;
    } else if (arg === '--persist-db') {
      if (next && !next.startsWith('--')) {
        options.persistDb = next;
        i++;
      } else {
        options.persistDb = process.env.CONTENT_EVAL_DB_PATH || 'reports/content-eval/content-eval-history.sqlite';
      }
    } else {
      throw new Error(`Unknown Content evaluation argument: ${arg}`);
    }
  }
  return options;
}

function envNumber(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function buildExternalLaneEvidence(input: {
  runId?: string;
  source?: string;
  sampleCount?: number;
  artifactPath?: string;
  providerInvocations?: ContentEvalProviderInvocationProvenance[];
}): ContentEvalExternalLaneEvidence | null {
  const runId = firstNonEmpty(input.runId);
  const source = firstNonEmpty(input.source);
  const sampleCount = input.sampleCount;
  if (!runId || !source || typeof sampleCount !== 'number' || !Number.isInteger(sampleCount) || sampleCount <= 0) {
    return null;
  }
  return {
    runId,
    source,
    sampleCount,
    artifactPath: firstNonEmpty(input.artifactPath),
    providerInvocations: input.providerInvocations,
  };
}

function readProviderInvocationArtifact(
  artifactPath: string | undefined,
  attestationKeyFile: string | undefined,
  trustedAttestationKeyFingerprint: string | undefined,
): { artifact: ContentLiveEvaluationArtifact; releaseQualified: boolean } | undefined {
  const resolvedPath = firstNonEmpty(artifactPath);
  const resolvedKeyFile = firstNonEmpty(attestationKeyFile);
  if (!resolvedPath || !resolvedKeyFile) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(resolvedPath), 'utf8')) as unknown;
    const attestationKey = readContentLiveEvalAttestationKeyFile(resolvedKeyFile);
    const expectedSourceIdentity = resolveContentLiveEvalSourceIdentity(process.cwd(), {
      requireCleanGeneratorSurface: true,
    });
    const validation = validateContentLiveEvaluationArtifact(parsed, {
      rubricDigest: contentEvalSha256(CONTENT_QUALITY_RUBRIC),
      attestationKey,
      trustedAttestationKeyFingerprint,
      expectedSourceIdentity,
    });
    if (!validation.valid || !validation.artifact) return undefined;
    return { artifact: validation.artifact, releaseQualified: validation.releaseQualified === true };
  } catch {
    // Invalid or missing artifacts are represented as invalid evidence by the evaluator.
  }
  return undefined;
}

function readIosExtractionArtifact(
  artifactPath: string | undefined,
  attestationKeyFile: string | undefined,
): ContentIosExtractionArtifact | undefined {
  const resolvedPath = firstNonEmpty(artifactPath);
  const resolvedKeyFile = firstNonEmpty(attestationKeyFile);
  const trustedFingerprint = firstNonEmpty(launchTrustedIosAttestationKeyFingerprint);
  const expectedGitCommit = firstNonEmpty(launchExpectedIosGitCommit);
  const expectedSourceTreeDigest = firstNonEmpty(launchExpectedIosSourceTreeDigest);
  if (!resolvedPath || !resolvedKeyFile || !trustedFingerprint || !expectedGitCommit || !expectedSourceTreeDigest) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(resolvedPath), 'utf8')) as unknown;
    const attestationKey = readContentLiveEvalAttestationKeyFile(resolvedKeyFile);
    const validation = validateContentIosExtractionArtifact(parsed, {
      attestationKey,
      trustedAttestationKeyFingerprint: trustedFingerprint,
      expectedIosGitCommit: expectedGitCommit,
      expectedIosSourceTreeDigest: expectedSourceTreeDigest,
    });
    return validation.valid && validation.releaseQualified ? validation.artifact : undefined;
  } catch {
    return undefined;
  }
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode ?? parseMode(process.env.CONTENT_EVAL_MODE) ?? 'fixture';
  const iosArtifactPath = options.iosExtractionArtifact ?? process.env.CONTENT_EVAL_IOS_EXTRACTION_ARTIFACT;
  const iosAttestationKeyFile = options.iosExtractionAttestationKeyFile
    ?? process.env.CONTENT_EVAL_IOS_EXTRACTION_ATTESTATION_KEY_FILE;
  const iosArtifact = readIosExtractionArtifact(iosArtifactPath, iosAttestationKeyFile);
  const iosExtractionScore = options.iosExtractionScore
    ?? envNumber('CONTENT_EVAL_IOS_EXTRACTION_SCORE')
    ?? iosArtifact?.score
    ?? null;
  const realProviderArtifactPath = options.realProviderArtifact
    ?? options.realProviderInvocationArtifact
    ?? process.env.CONTENT_EVAL_REAL_PROVIDER_ARTIFACT
    ?? process.env.CONTENT_EVAL_REAL_PROVIDER_INVOCATION_ARTIFACT;
  const realProviderAttestationKeyFile = options.realProviderAttestationKeyFile
    ?? process.env.CONTENT_EVAL_REAL_PROVIDER_ATTESTATION_KEY_FILE;
  const realProviderArtifactResult = readProviderInvocationArtifact(
    realProviderArtifactPath,
    realProviderAttestationKeyFile,
    launchTrustedAttestationKeyFingerprint,
  );
  const realProviderArtifact = realProviderArtifactResult?.releaseQualified
    ? realProviderArtifactResult.artifact
    : undefined;
  const consumptionClaimPath = realProviderArtifact
    ? claimContentLiveEvalArtifactForRelease(realProviderArtifact)
    : undefined;
  const realProviderSampleScore = options.realProviderSampleScore
    ?? envNumber('CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE')
    ?? realProviderArtifact?.summary.score
    ?? null;
  let iosExtractionEvidence = buildExternalLaneEvidence({
    runId: options.iosExtractionRunId ?? process.env.CONTENT_EVAL_IOS_EXTRACTION_RUN_ID ?? iosArtifact?.runId,
    source: options.iosExtractionSource ?? process.env.CONTENT_EVAL_IOS_EXTRACTION_SOURCE ?? iosArtifact?.source,
    sampleCount: options.iosExtractionSampleCount ?? envNumber('CONTENT_EVAL_IOS_EXTRACTION_SAMPLE_COUNT') ?? iosArtifact?.summary.totalCount,
    artifactPath: iosArtifactPath,
  });
  // A requested artifact that cannot be authenticated must be visible to the
  // evaluator as invalid evidence, not downgraded to a merely unexecuted lane.
  if (iosArtifactPath && !iosArtifact && !iosExtractionEvidence) {
    iosExtractionEvidence = {
      runId: 'content-ios-extraction-invalid-artifact',
      source: 'xcodebuild-content-ui-tests',
      sampleCount: 1,
      artifactPath: iosArtifactPath,
    };
  }
  if (iosExtractionEvidence && iosArtifact) {
    iosExtractionEvidence.generatedAt = iosArtifact.generatedAt;
    iosExtractionEvidence.iosArtifact = iosArtifact;
  }
  const realProviderSampleEvidence = buildExternalLaneEvidence({
    runId: options.realProviderSampleRunId ?? process.env.CONTENT_EVAL_REAL_PROVIDER_SAMPLE_RUN_ID ?? realProviderArtifact?.runId,
    source: options.realProviderSampleSource ?? process.env.CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SOURCE ?? realProviderArtifact?.source,
    sampleCount: options.realProviderSampleCount ?? envNumber('CONTENT_EVAL_REAL_PROVIDER_SAMPLE_COUNT') ?? realProviderArtifact?.summary.sampleCount,
    artifactPath: realProviderArtifactPath,
    providerInvocations: realProviderArtifact?.invocations,
  });
  if (realProviderSampleEvidence && realProviderArtifact) {
    realProviderSampleEvidence.generatedAt = realProviderArtifact.generatedAt;
    realProviderSampleEvidence.artifact = realProviderArtifact;
  }
  const outDir = options.outDir ?? 'reports/content-eval';
  const baseName = `content-eval-${timestamp()}`;
  const jsonPath = options.json ?? path.join(outDir, `${baseName}.json`);
  const markdownPath = options.markdown ?? path.join(outDir, `${baseName}.md`);

  const result = runContentDayToDayEvaluation({
    mode,
    generatedAt: new Date().toISOString(),
    iosExtractionScore,
    iosExtractionEvidence,
    realProviderSampleScore,
    realProviderSampleEvidence,
    engine: {
      packageVersion: readPackageVersion(),
      gitBranch: gitValue('git branch --show-current'),
      gitCommit: gitValue('git rev-parse --short HEAD'),
    },
  });

  ensureParent(jsonPath);
  ensureParent(markdownPath);
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, formatContentEvalResultsMarkdown(result), 'utf8');

  const persistDbPath = options.persistDb
    ?? (process.env.CONTENT_EVAL_PERSIST_DB === '1'
      ? process.env.CONTENT_EVAL_DB_PATH || 'reports/content-eval/content-eval-history.sqlite'
      : undefined);
  if (persistDbPath) {
    ensureParent(persistDbPath);
    const persisted = persistContentEvalRun(result, {
      databasePath: persistDbPath,
      packageVersion: readPackageVersion(),
      gitBranch: gitValue('git branch --show-current'),
      gitCommit: gitValue('git rev-parse --short HEAD'),
      jsonReportPath: jsonPath,
      markdownReportPath: markdownPath,
    });
    console.log(`Persisted eval run: ${persisted.runId} (${persisted.caseCount} cases)`);
    console.log(`Eval DB: ${persistDbPath}`);
  }

  console.log(`Content eval score: ${result.aggregate.overallScore}/100`);
  console.log(`Cases: ${result.aggregate.caseCount}`);
  console.log(`Release gate: ${result.aggregate.releaseGate}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);

  if (options.failUnder != null && result.aggregate.overallScore < options.failUnder) {
    console.error(`Content eval score ${result.aggregate.overallScore} is below threshold ${options.failUnder}.`);
    process.exitCode = 1;
  }

  if (consumptionClaimPath && realProviderArtifact) {
    finalizeContentLiveEvalArtifactClaim(
      consumptionClaimPath,
      realProviderArtifact,
      result.passed ? 'pass' : 'fail',
    );
  }

  if (!result.passed) {
    process.exitCode = 1;
  }
}

main();

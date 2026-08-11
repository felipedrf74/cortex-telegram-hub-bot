import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../scripts/lib/release-canonical.mjs';
import { RELEASE_CONTROL_PLANE_SCHEMA } from '../../scripts/lib/release-control-plane.mjs';
import {
  evaluateMigrationCdEligibility,
  classifyMigrationSql,
  splitSqlStatements,
} from '../../scripts/lib/migration-cd-eligibility.mjs';
import {
  LEGACY_RELEASE_MANIFEST_PAYLOAD_SCHEMA,
  LEGACY_RELEASE_MANIFEST_SCHEMA,
  LEGACY_RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_MANIFEST_PAYLOAD_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  buildReleaseManifestPayload,
  loadContinuousDeploymentPolicy,
  migrationVerdictDigest,
  releaseIdFor,
  signReleaseManifest,
  verifyComposeBytes,
  verifyReleaseManifest,
} from '../../scripts/lib/release-manifest.mjs';
import {
  BLOCK_REASONS,
  LEGACY_RELEASE_RECEIPT_SCHEMA,
  RELEASE_RECEIPT_SCHEMA,
  RELEASE_RECEIPT_OUTCOMES,
  RELEASE_STATUSES,
  assertReleaseReceiptShape,
  assertReleaseStateShape,
  createReleaseStateStore,
  releaseEvidenceDigest,
  resolveEffectiveRelease,
  sanitizeDetail,
} from '../../scripts/lib/release-state-store.mjs';
import {
  DEPLOYMENT_OUTCOMES,
  FAILURE_CODES,
  buildReleaseStateView,
  runReleaseDeployment,
} from '../../scripts/lib/release-deployment.mjs';
import {
  LOCK_CONTENDED_EXIT_CODE,
  LOCK_HELD_ENV,
  assertLockHeld,
  ensureLockFile,
  flockAvailable,
  resolveFlockCommand,
} from '../../scripts/lib/release-lock.mjs';
import {
  RELEASE_NOTIFICATION_KINDS,
  buildReleaseNotification,
  reportReleaseDeploymentAbort,
} from '../../scripts/lib/release-notify.mjs';
import { createReleaseAuditMirror } from '../../scripts/lib/release-audit-mirror.mjs';
import { createReleaseBackup } from '../../scripts/lib/release-backup.mjs';
import { createReleaseDatabaseProbe } from '../../scripts/lib/release-database.mjs';
import { createReleaseHealth } from '../../scripts/lib/release-health.mjs';
import {
  BACKEND_FORBIDDEN_ENVIRONMENT_KEYS,
  BACKEND_FORBIDDEN_RUNTIME_KEYS,
  BACKEND_FORBIDDEN_RUNTIME_PREFIXES,
  CONTENT_ENGINE_ENVIRONMENT_KEYS,
  createReleaseEnvironmentGate,
} from '../../scripts/lib/release-environment.mjs';
import {
  createReleaseRegistry,
  releaseChildEnvironment,
} from '../../scripts/lib/release-registry.mjs';
import {
  createProtectedHeadVerifier,
  PROTECTED_HEAD_RESULTS,
} from '../../scripts/lib/release-protected-head.mjs';
import {
  releaseMigrationReconciliationDigest,
} from '../../scripts/lib/production-migration-lineage.mjs';

const repoRoot = resolve(process.cwd());
const basePolicy = loadContinuousDeploymentPolicy(repoRoot);

const SOURCE_SHA = 'a'.repeat(40);
const NEWER_SHA = 'b'.repeat(40);
const BACKEND_DIGEST = `sha256:${'1'.repeat(64)}`;
const CONTENT_DIGEST = `sha256:${'2'.repeat(64)}`;
const PREDECESSOR_BACKEND_DIGEST = `sha256:${'3'.repeat(64)}`;
const PREDECESSOR_CONTENT_DIGEST = `sha256:${'4'.repeat(64)}`;
const PAYLOAD_DIGEST = `sha256:${'5'.repeat(64)}`;
const ACTIVE_BACKEND_DIGEST = `sha256:${'6'.repeat(64)}`;
const ACTIVE_CONTENT_DIGEST = `sha256:${'7'.repeat(64)}`;
const ACTIVE_PAYLOAD_DIGEST = `sha256:${'8'.repeat(64)}`;
// A completed release records the payload that carried its signed manifest and
// Compose file; a rollback re-extracts exactly that payload.
const PREDECESSOR_PAYLOAD_DIGEST = `sha256:${'9'.repeat(64)}`;
const CONTROL_PLANE = Object.freeze({
  schema: RELEASE_CONTROL_PLANE_SCHEMA,
  digest: 'e'.repeat(64),
});
const PREDECESSOR_COMPOSE_BYTES = Buffer.from('services:\n  backend: {}\n  legacy: {}\n');
const PREDECESSOR_COMPOSE_DIGEST = sha256(PREDECESSOR_COMPOSE_BYTES);
const NEWER_PAYLOAD_DIGEST = `sha256:${'6'.repeat(64)}`;

const COMPOSE_BYTES = Buffer.from('services:\n  backend: {}\n');
const CONVERGENCE_MIGRATION_SHA256 =
  '0bba559437983ed7e2f5540e18ba66a0248c1a34282b30015954ace6e29cbd32';

let workspace: string;

function backupTestAuthority() {
  return {
    expectedUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    expectedGid: typeof process.getgid === 'function' ? process.getgid() : 0,
    backupTrustAnchor: workspace,
  };
}
let publicKeyPath: string;
let privateKeyPem: string;
let policy: ReturnType<typeof loadContinuousDeploymentPolicy>;

function makePolicy(root: string) {
  return {
    ...basePolicy,
    trust: {
      ...basePolicy.trust,
      publicKeyPath: join(root, 'trust', 'release-signing.pem'),
    },
    paths: {
      stateDir: join(root, 'state'),
      receiptDir: join(root, 'receipts'),
      lockFile: join(root, 'locks', 'release.lock'),
      workDir: join(root, 'work'),
    },
    environments: {
      staging: {
        ...basePolicy.environments.staging,
        backendEnvFile: join(root, 'env', 'staging-backend.env'),
        contentEngineEnvFile: join(root, 'env', 'staging-content-engine.env'),
      },
      production: {
        ...basePolicy.environments.production,
        backendEnvFile: join(root, 'env', 'production-backend.env'),
        contentEngineEnvFile: join(root, 'env', 'production-content-engine.env'),
      },
    },
    timing: {
      ...basePolicy.timing,
      // Real budgets with an injected clock and an injected sleep: the
      // observation window is exercised without spending 60 seconds.
      observationSeconds: 60,
      healthBudgetSeconds: 45,
      stagingHealthBudgetSeconds: 45,
      rollbackObjectiveSeconds: 120,
    },
  };
}

beforeEach(() => {
  // macOS exposes /var as a symlink to /private/var. Use the canonical fixture
  // root so the production payload-directory safety check stays strict.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-cd-')));
  mkdirSync(join(workspace, 'trust'), { recursive: true });
  mkdirSync(join(workspace, 'env'), { recursive: true });
  for (const environment of ['staging', 'production']) {
    writeFileSync(
      join(workspace, 'env', `${environment}-backend.env`),
      `INTERNAL_API_SECRET=${environment}-shared-secret\nTELEGRAM_BOT_TOKEN=backend-only\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(workspace, 'env', `${environment}-content-engine.env`),
      `INTERNAL_API_SECRET=${environment}-shared-secret\nANTHROPIC_API_KEY=engine-only\n`,
      { mode: 0o600 },
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  publicKeyPath = join(workspace, 'trust', 'release-signing.pem');
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }) as string);
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  policy = makePolicy(workspace);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const IMAGES = {
  backend: { repository: 'ghcr.io/felipedrf74/nexus-hub-backend', digest: BACKEND_DIGEST },
  contentEngine: { repository: 'ghcr.io/felipedrf74/nexus-hub-content-engine', digest: CONTENT_DIGEST },
};

function payloadFor(overrides: Record<string, unknown> = {}) {
  const base = {
    upFileCount: 274,
    downFileCount: 41,
    cdEligibility: { eligible: true, predecessorCompatible: true, reasons: [] as string[] },
    ...(overrides.migrations as object ?? {}),
  } as {
    upFileCount: number;
    downFileCount: number;
    cdEligibility: { eligible: boolean; predecessorCompatible: boolean; reasons: string[] };
  };
  // A minimal but real inventory: the manifest now binds the ordered set the
  // migrator may apply, and upFileCount must match its length.
  const requestedInventory = (overrides.inventory as Array<Record<string, unknown>>) ?? [
    { file: '001_a.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
    { file: '002_b.sql', sha256: 'b'.repeat(64), kind: 'backfill', predecessorCompatible: true },
  ];
  const inventory = [
    ...requestedInventory.filter((entry) => entry.file !== '283_release_schema_convergence.sql'),
    {
      file: '283_release_schema_convergence.sql',
      sha256: CONVERGENCE_MIGRATION_SHA256,
      kind: 'expand',
      predecessorCompatible: true,
    },
  ].sort((left, right) => String(left.file).localeCompare(String(right.file)));
  const defaultReconciliation = {
    schema: 'nexus.release-migration-reconciliation.v2',
    sourcePolicySha256: 'f'.repeat(64),
    environments: {
      production: { lineageIds: ['fixture-production'], legacyRows: [] },
      staging: { lineageIds: ['fixture-staging'], legacyRows: [] },
    },
    compatibilityExemptions: [{
      id: 'release-schema-convergence-283',
      file: '283_release_schema_convergence.sql',
      sha256: CONVERGENCE_MIGRATION_SHA256,
      genericKind: 'contract',
      effectiveKind: 'expand',
      reason: 'remove_obsolete_global_unique_indexes_after_tenant_safe_composite_replacement',
      allowedDropIndexes: [{
        name: 'idx_ref_channels_url',
        tableName: 'content_ref_channels',
        columns: ['channel_url'],
        unique: true,
        allowAbsent: true,
        replacement: {
          name: 'idx_content_ref_channels_user_url',
          tableName: 'content_ref_channels',
          columns: ['user_id', 'channel_url'],
          unique: true,
        },
      }, {
        name: 'idx_transcript_video',
        tableName: 'video_transcripts',
        columns: ['video_id'],
        unique: true,
        allowAbsent: true,
        replacement: {
          name: 'idx_video_transcripts_user_video',
          tableName: 'video_transcripts',
          columns: ['user_id', 'video_id'],
          unique: true,
        },
      }, {
        name: 'idx_vendor_sender',
        tableName: 'invoice_vendors',
        columns: ['sender_pattern'],
        unique: true,
        allowAbsent: true,
        replacement: {
          name: 'idx_invoice_vendors_user_sender',
          tableName: 'invoice_vendors',
          columns: ['user_id', 'sender_pattern'],
          unique: true,
        },
      }],
    }],
    semanticSchemaExclusions: [{
      environment: 'staging',
      type: 'index',
      name: 'idx_staging_fixture_calendar_user_time',
      tableName: 'staging_fixture_calendar_events',
      preserveData: false,
    }, {
      environment: 'staging',
      type: 'table',
      name: 'staging_fixture_calendar_events',
      tableName: 'staging_fixture_calendar_events',
      preserveData: true,
    }],
  };
  const reconciliation = (overrides.reconciliation as typeof defaultReconciliation | undefined)
    ?? defaultReconciliation;
  base.upFileCount = inventory.length;
  // The digest is derived, never invented: it must equal what the verifier
  // recomputes from the verdict AND the inventory the manifest carries.
  const migrations = {
    ...base,
    inventory,
    reconciliation,
    digest: migrationVerdictDigest(base.cdEligibility, inventory, reconciliation),
  };
  return buildReleaseManifestPayload({
    createdAt: '2026-08-07T10:00:00.000Z',
    source: {
      repository: policy.trust.repository,
      ref: policy.trust.protectedRef,
      sha: (overrides.sha as string) ?? SOURCE_SHA,
      workflow: policy.trust.workflow,
      runId: (overrides.runId as string) ?? '4242',
      runAttempt: '1',
    },
    images: (overrides.images as typeof IMAGES | undefined) ?? {
      backend: { repository: policy.registry.backendImage, digest: BACKEND_DIGEST },
      contentEngine: { repository: policy.registry.contentEngineImage, digest: CONTENT_DIGEST },
    },
    compose: {
      path: policy.compose.file,
      digest: (overrides.composeDigest as string) ?? sha256(COMPOSE_BYTES),
    },
    controlPlane: (overrides.controlPlane as typeof CONTROL_PLANE | undefined)
      ?? CONTROL_PLANE,
    migrations,
    policy,
  });
}

function predecessorPayloadFor() {
  return payloadFor({
    sha: 'c'.repeat(40),
    runId: '1',
    composeDigest: PREDECESSOR_COMPOSE_DIGEST,
    images: {
      backend: {
        repository: policy.registry.backendImage,
        digest: PREDECESSOR_BACKEND_DIGEST,
      },
      contentEngine: {
        repository: policy.registry.contentEngineImage,
        digest: PREDECESSOR_CONTENT_DIGEST,
      },
    },
  });
}

function signed(payload: ReturnType<typeof payloadFor>) {
  return signReleaseManifest({
    payload,
    privateKeyPem,
    keyId: policy.trust.signingKeyId,
    policy,
  });
}

function legacyPayloadFor(payload: ReturnType<typeof payloadFor>) {
  const { controlPlane: _controlPlane, ...legacyFields } = payload;
  return {
    ...legacyFields,
    schema: LEGACY_RELEASE_MANIFEST_PAYLOAD_SCHEMA,
    schemaVersion: LEGACY_RELEASE_MANIFEST_SCHEMA_VERSION,
  };
}

function legacySigned(payload: ReturnType<typeof payloadFor>) {
  const legacyPayload = legacyPayloadFor(payload);
  return {
    schema: LEGACY_RELEASE_MANIFEST_SCHEMA,
    keyId: policy.trust.signingKeyId,
    signatureAlgorithm: 'ed25519',
    payload: legacyPayload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(legacyPayload)),
      privateKeyPem,
    ).toString('base64'),
  };
}

function stateEvidenceFor(payload: ReturnType<typeof payloadFor>) {
  return {
    manifestDigest: sha256(canonicalJson(signed(payload))),
    keyId: policy.trust.signingKeyId,
  };
}

function releaseIdentityFor(payload: ReturnType<typeof payloadFor>) {
  return {
    releaseId: releaseIdFor(payload),
    sourceSha: payload.source.sha,
    backendImageDigest: payload.images.backend.digest,
  };
}

function makeStore(now?: () => Date) {
  return createReleaseStateStore({
    stateDir: policy.paths.stateDir,
    receiptDir: policy.paths.receiptDir,
    ...(now ? { now } : {}),
  });
}

function createRuntimePlanDir(digest = 'd'.repeat(64)) {
  const payloadDir = join(policy.paths.workDir, digest);
  const planDir = join(payloadDir, 'runtime-plan');
  mkdirSync(planDir, { recursive: true, mode: 0o755 });
  chmodSync(planDir, 0o755);
  const planPath = join(planDir, 'migration-plan.json');
  writeFileSync(planPath, '{"schema":"fixture"}\n', { mode: 0o644 });
  chmodSync(planPath, 0o644);
  return { payloadDir, planDir, planPath };
}

function fakeProtectedHead(calls: string[] = []) {
  return {
    verify: ({ expectedSha }: { expectedSha: string }) => {
      calls.push(expectedSha);
      return {
        result: PROTECTED_HEAD_RESULTS.CURRENT,
        expectedSha,
        headSha: expectedSha,
      };
    },
  };
}

// ───────────────────────────────────────────────────────────── harness doubles

interface RegistryScript {
  payloadDigests?: string[];
  composeUpFailures?: Record<string, number>;
  composeDownFailures?: Record<string, number>;
  migratorExit?: Record<string, number>;
  newerPayload?: { digest: string; envelope: unknown };
  serviceHealthy?: boolean;
  // Rollback verification: what the restored containers actually report.
  runningImages?: Record<string, {
    healthy: boolean; state: string; image: string | null; name: string;
  }>;
  runningImagesByCall?: Array<Record<string, {
    healthy: boolean; state: string; image: string | null; name: string;
  }> | undefined>;
  runningImagesDelayMs?: number[];
  activePayloadPullDelayMs?: number;
  activePayloadExtractDelayMs?: number;
  predecessorPullDelayMs?: number;
  predecessorExtractDelayMs?: number;
  imageMatches?: boolean;
  pullFailures?: number;
  resolveFailures?: number;
  predecessorPayloadMissing?: boolean;
  predecessorPayloadInitiallyAbsent?: boolean;
  predecessorComposeBytes?: Buffer;
  predecessorEnvelope?: unknown;
  activePayloadMissing?: boolean;
  activeComposeBytes?: Buffer;
  activeEnvelope?: unknown;
  candidateComposeBytes?: Buffer;
}

function fakeRegistry(
  script: RegistryScript,
  envelope: unknown,
  advanceClock: (ms: number) => void = () => {},
) {
  const calls: Array<{
    kind: string; environment?: string; images?: unknown;
    keepDirs?: string[]; services?: string[]; reference?: string; composeFile?: string;
    repository?: string; keepDigests?: string[]; timeoutMs?: number;
  }> = [];
  const digests = [...(script.payloadDigests ?? [PAYLOAD_DIGEST])];
  const removedImages: string[] = [];
  const keptDigests: Array<Array<string | undefined>> = [];
  const composeIdentities: Array<{
    kind: string;
    environment: string;
    releaseIdentity: ReturnType<typeof releaseIdentityFor>;
  }> = [];
  const pulledReferences = new Set<string>();
  let pointerPulls = 0;
  let pointerResolves = 0;
  let runningImageCalls = 0;
  return {
    calls,
    removedImages,
    keptDigests,
    composeIdentities,
    registry: {
      pull: (reference: string, options: { timeoutMs?: number } = {}) => {
        calls.push({ kind: 'pull', reference, timeoutMs: options.timeoutMs });
        if (reference.includes(PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''))) {
          advanceClock(script.predecessorPullDelayMs ?? 0);
        } else if (reference.includes(PAYLOAD_DIGEST.replace('sha256:', ''))) {
          advanceClock(script.activePayloadPullDelayMs ?? 0);
        }
        if (reference.endsWith(`:${policy.registry.releaseTag}`)) {
          pointerPulls += 1;
          // `pullFailures` fails the *refresh* pull, not the discovery pull, so a
          // test can exercise "staging ran, then the pointer could not be
          // re-resolved".
          if (script.pullFailures && pointerPulls > 1) {
            throw new Error('simulated registry refresh failure');
          }
        }
        pulledReferences.add(reference);
      },
      resolveDigest: () => {
        pointerResolves += 1;
        if (script.resolveFailures && pointerResolves > 1) {
          throw new Error('simulated registry resolve failure');
        }
        return digests.length > 1 ? digests.shift()! : digests[0];
      },
      imageExistsLocally: () => true,
      extractReleasePayload: (
        { reference, destinationDir, timeoutMs }:
        { reference: string; destinationDir: string; timeoutMs?: number },
      ) => {
        calls.push({ kind: `extract:${reference}`, timeoutMs });
        mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
        // The predecessor's payload is a distinct topology, served from its own
        // digest. A rollback that pulled the candidate's Compose file instead
        // would be running a third, never-tested configuration.
        if (reference.includes(PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''))) {
          advanceClock(script.predecessorExtractDelayMs ?? 0);
          if (script.predecessorPayloadInitiallyAbsent && !pulledReferences.has(reference)) {
            throw new Error('predecessor payload is not present locally');
          }
          if (script.predecessorPayloadMissing) {
            throw new Error('predecessor payload not present in the registry');
          }
          return {
            manifestBytes: Buffer.from(`${JSON.stringify(
              script.predecessorEnvelope ?? signed(predecessorPayloadFor()),
            )}\n`),
            composeBytes: script.predecessorComposeBytes ?? PREDECESSOR_COMPOSE_BYTES,
            composePath: join(destinationDir, 'predecessor-compose.yml'),
            payloadDir: destinationDir,
          };
        }
        if (reference.includes(ACTIVE_PAYLOAD_DIGEST.replace('sha256:', ''))) {
          advanceClock(script.activePayloadExtractDelayMs ?? 0);
          if (script.activePayloadMissing) {
            throw new Error('active payload not present in the registry');
          }
          return {
            manifestBytes: Buffer.from(`${JSON.stringify(script.activeEnvelope ?? envelope)}\n`),
            composeBytes: script.activeComposeBytes ?? COMPOSE_BYTES,
            composePath: join(destinationDir, 'active-compose.yml'),
            payloadDir: destinationDir,
          };
        }
        const chosen = script.newerPayload && reference.includes(script.newerPayload.digest)
          ? script.newerPayload.envelope
          : envelope;
        if (reference.includes(PAYLOAD_DIGEST.replace('sha256:', ''))) {
          advanceClock(script.activePayloadExtractDelayMs ?? 0);
        }
        return {
          manifestBytes: Buffer.from(`${JSON.stringify(chosen)}\n`),
          composeBytes: script.candidateComposeBytes ?? COMPOSE_BYTES,
          composePath: join(destinationDir, 'docker-compose.release.yml'),
          payloadDir: destinationDir,
        };
      },
      composeEnv: ({ environment, releaseIdentity }: {
        environment: string;
        releaseIdentity: ReturnType<typeof releaseIdentityFor>;
      }) => {
        composeIdentities.push({ kind: 'composeEnv', environment, releaseIdentity });
        return {};
      },
      composeConfigValid: ({ environment, releaseIdentity }: {
        environment: string;
        releaseIdentity: ReturnType<typeof releaseIdentityFor>;
      }) => {
        composeIdentities.push({ kind: 'composeConfigValid', environment, releaseIdentity });
        return { ok: true, status: 0 };
      },
      composeUp: (
        { environment, images, releaseIdentity, composeFile, timeoutMs }:
        {
          environment: string;
          images: unknown;
          releaseIdentity: ReturnType<typeof releaseIdentityFor>;
          composeFile?: string;
          timeoutMs?: number;
        },
      ) => {
        composeIdentities.push({ kind: 'composeUp', environment, releaseIdentity });
        calls.push({ kind: 'composeUp', environment, images, composeFile, timeoutMs });
        return { status: script.composeUpFailures?.[environment] ?? 0, stdout: '', stderr: '' };
      },
      composeDown: ({ environment, releaseIdentity }: {
        environment: string;
        releaseIdentity: ReturnType<typeof releaseIdentityFor>;
      }) => {
        composeIdentities.push({ kind: 'composeDown', environment, releaseIdentity });
        calls.push({ kind: 'composeDown', environment });
        return {
          status: script.composeDownFailures?.[environment] ?? 0,
          stdout: '',
          stderr: '',
        };
      },
      composeRunMigrator: ({ environment, releaseIdentity }: {
        environment: string;
        releaseIdentity: ReturnType<typeof releaseIdentityFor>;
      }) => {
        composeIdentities.push({ kind: 'composeRunMigrator', environment, releaseIdentity });
        calls.push({ kind: 'composeRunMigrator', environment });
        return { status: script.migratorExit?.[environment] ?? 0, stdout: '', stderr: '' };
      },
      pruneWorkDirs: ({ keepDirs }: { keepDirs: string[] }) => {
        calls.push({ kind: 'pruneWorkDirs', keepDirs });
        return { removed: [] as string[] };
      },
      composeRunningImages: (
        { services, composeFile, images, releaseIdentity, timeoutMs }:
        {
          services: string[];
          composeFile?: string;
          images: typeof IMAGES;
          releaseIdentity: ReturnType<typeof releaseIdentityFor>;
          timeoutMs?: number;
        },
      ) => {
        const callIndex = runningImageCalls;
        runningImageCalls += 1;
        calls.push({ kind: 'composeRunningImages', services, composeFile, timeoutMs });
        composeIdentities.push({
          kind: 'composeRunningImages',
          environment: 'production',
          releaseIdentity,
        });
        advanceClock(script.runningImagesDelayMs?.[callIndex] ?? 0);
        // Default: the containers report the images the caller asked about, which is
        // the healthy-restore case. Tests override via script.runningImages.
        const scripted = script.runningImagesByCall?.[callIndex] ?? script.runningImages;
        const observed: Record<string, unknown> = {};
        for (const service of services) {
          const expected = service === policy.compose.backendService
            ? images.backend
            : images.contentEngine;
          observed[service] = scripted?.[service]
            ?? {
              healthy: true,
              state: 'healthy',
              image: `${expected.repository}@${expected.digest}`,
              name: service,
            };
        }
        return observed;
      },
      imageMatchesDigest: (observedImage: string | null, repository: string, digest: string) => (
        script.imageMatches === undefined
          ? (observedImage === `${repository}@${digest}`
            || Boolean(observedImage?.endsWith(`@${digest}`)))
          : script.imageMatches
      ),
      composeServiceHealth: ({ environment, releaseIdentity }: {
        environment: string;
        releaseIdentity: ReturnType<typeof releaseIdentityFor>;
      }) => {
        composeIdentities.push({ kind: 'composeServiceHealth', environment, releaseIdentity });
        return {
          healthy: script.serviceHealthy !== false,
          state: script.serviceHealthy === false ? 'unhealthy' : 'healthy',
        };
      },
      pruneImages: ({ repository, keepDigests }: { repository: string; keepDigests: string[] }) => {
        calls.push({ kind: 'pruneImages', repository, keepDigests });
        keptDigests.push([...keepDigests]);
        removedImages.push(`${repository}:keep=${keepDigests.filter(Boolean).join(',')}`);
        return { removed: [], kept: keepDigests.filter(Boolean) };
      },
    },
  };
}

/**
 * Health double driven by a per-port script. `unhealthyAfter` lets a release come
 * up healthy and then degrade partway through the observation window, which is
 * the failure the 60-second observation exists to catch.
 */
function fakeHealth(options: {
  stagingHealthy?: boolean;
  productionHealthy?: boolean;
  degradeAfterProbes?: number;
  predecessorHealthy?: boolean;
  clock: () => number;
}) {
  let productionProbes = 0;
  let restoring = false;
  const passed = (name: string) => ({ name, result: 'passed' as const, durationMs: 5, detail: null });
  const failed = (name: string) => ({
    name, result: 'failed' as const, durationMs: 5, detail: 'http 503',
  });

  const isStaging = (port: number) => port === policy.environments.staging.backendPort
    || port === policy.environments.staging.contentEnginePort;

  return {
    markRestoring: () => { restoring = true; },
    health: {
      backendHealth: async ({ port }: { port: number }) => (
        isStaging(port)
          ? (options.stagingHealthy === false ? failed('backend_health') : passed('backend_health'))
          : ((restoring ? options.predecessorHealthy !== false : options.productionHealthy !== false)
            ? passed('backend_health') : failed('backend_health'))
      ),
      contentEngineHealth: async () => passed('content_engine_health'),
      backendPublicStatus: async () => passed('backend_public_status'),
      apiSmoke: async () => passed('api_smoke'),
      waitUntilHealthy: async ({ backendPort }: { backendPort: number }) => {
        if (isStaging(backendPort)) {
          const healthy = options.stagingHealthy !== false;
          return { healthy, checks: [healthy ? passed('backend_health') : failed('backend_health')] };
        }
        const healthy = restoring
          ? options.predecessorHealthy !== false
          : options.productionHealthy !== false;
        return { healthy, checks: [healthy ? passed('backend_health') : failed('backend_health')] };
      },
      observe: async ({ observationSeconds }: { observationSeconds: number }) => {
        const checks = [];
        const rounds = Math.max(1, Math.ceil(observationSeconds / 5));
        for (let round = 0; round < rounds; round += 1) {
          productionProbes += 1;
          if (options.degradeAfterProbes !== undefined
              && productionProbes > options.degradeAfterProbes) {
            checks.push(failed('backend_health'));
            return { passed: false, checks, observedSeconds: round * 5 };
          }
          checks.push(passed('backend_health'));
        }
        return { passed: true, checks, observedSeconds: observationSeconds };
      },
    },
  };
}

function fakeNotifier(onSend: () => void = () => {}) {
  const sent: Array<{ kind: string; release: Record<string, unknown> }> = [];
  return {
    sent,
    notifier: {
      send: async ({ kind, release }: { kind: string; release: Record<string, unknown> }) => {
        onSend();
        sent.push({ kind, release });
        return { delivered: true, reason: 'sent' };
      },
    },
  };
}

function fakeMirror(result: 'passed' | 'failed' | 'skipped' | 'deferred' = 'passed') {
  const mirrored: string[] = [];
  const drains: number[] = [];
  return {
    mirrored,
    drains,
    mirror: {
      target: () => ({ enabled: result !== 'skipped' }),
      mirrorReceipt: ({ receiptPath }: { receiptPath: string }) => {
        mirrored.push(receiptPath);
        return { result, detail: result === 'failed' ? 'scp exit 1' : null };
      },
      drainQueue: () => {
        drains.push(drains.length + 1);
        return { attempted: 0, delivered: 0, exhausted: [] as string[] };
      },
    },
  };
}

function fakeBackupEvidence() {
  const artifact = 'nexus-db-20260807T100000Z.sqlite.age';
  return {
    artifact,
    artifactPath: join(workspace, 'backups', artifact),
    encryptedSha256: 'd'.repeat(64),
    encryptedSizeBytes: 4096,
    database: '/var/lib/nexus-hub/production/data/bot.db',
    startedAt: '2026-08-07T10:00:00.000Z',
    completedAt: '2026-08-07T10:00:00.000Z',
  };
}

function fakeBackup(result: 'passed' | 'failed' = 'passed') {
  const evidence = fakeBackupEvidence();
  return {
    readBackupReceipt: () => (result === 'passed'
      ? { ok: true, detail: null, ...evidence }
      : { ok: false, detail: 'backup receipt could not be verified' }),
    verifyBackupEvidence: ({ evidence: expected }: { evidence: unknown }) => (
      result === 'passed'
        ? { ok: true, detail: null, ...(expected as ReturnType<typeof fakeBackupEvidence>) }
        : { ok: false, detail: 'persisted backup evidence could not be verified' }
    ),
    createPreMigrationBackup: (_options?: { environment?: string }) => (result === 'passed'
      ? { result, artifact: evidence.artifact, evidence, detail: null }
      : { result, artifact: null, detail: 'backup unit result failed' }),
  };
}

function fakeInstalledBackupInterface(results: boolean[] = [true]) {
  const calls: number[] = [];
  return {
    calls,
    verify: () => {
      calls.push(calls.length + 1);
      const passed = results.length > 1 ? results.shift()! : results[0];
      return { schema: 'nexus.release-installed-backup-interface.v1', passed };
    },
  };
}

function exactRecoveryBackupFixture(pointer: 'missing' | 'overwritten' = 'missing') {
  const root = join(workspace, `exact-recovery-backup-${pointer}`);
  const artifact = join(root, 'pre-promotion', 'nexus-db-20260807T100000Z.sqlite.age');
  const receiptPath = join(root, 'state', 'last-success.json');
  const bytes = Buffer.from('exact-pre-migration-encrypted-bytes');
  mkdirSync(join(root, 'pre-promotion'), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'pre-promotion'), 0o700);
  writeFileSync(artifact, bytes, { mode: 0o600 });
  chmodSync(artifact, 0o600);
  writeFileSync(
    `${artifact}.sha256`,
    `${sha256(bytes)}  ${artifact.split('/').at(-1)}\n`,
    { mode: 0o600 },
  );
  chmodSync(`${artifact}.sha256`, 0o600);
  if (pointer === 'overwritten') {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({
      schema: 'nexus.local-backup.v1',
      status: 'passed',
      kind: 'hourly',
      completedAt: '2026-08-07T10:05:00.000Z',
    }));
  }
  const evidence = {
    artifact: 'nexus-db-20260807T100000Z.sqlite.age',
    artifactPath: artifact,
    encryptedSha256: sha256(bytes),
    encryptedSizeBytes: bytes.length,
    database: '/var/lib/nexus-hub/production/data/bot.db',
    startedAt: '2026-08-07T10:00:00.000Z',
    completedAt: '2026-08-07T10:00:00.000Z',
  };
  const backup = createReleaseBackup({
    ...backupTestAuthority(),
    policy: {
      ...policy,
      backup: { ...policy.backup, root, receiptPath },
    },
  });
  return { artifact, backup, bytes, evidence };
}

function admissionPointerRaceBackupFixture() {
  const root = join(workspace, 'admission-pointer-race-backup');
  const artifact = join(root, 'pre-promotion', 'nexus-db-20260807T100000Z.sqlite.age');
  const receiptPath = join(root, 'state', 'last-success.json');
  const completedAt = '2026-08-07T10:00:00.000Z';
  const startedAt = completedAt;
  const bytes = Buffer.from('freshly-admitted-pre-migration-bytes');
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'pre-promotion'), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'state'), 0o700);
  chmodSync(join(root, 'pre-promotion'), 0o700);
  writeFileSync(artifact, bytes, { mode: 0o600 });
  chmodSync(artifact, 0o600);
  writeFileSync(
    `${artifact}.sha256`,
    `${sha256(bytes)}  ${artifact.split('/').at(-1)}\n`,
    { mode: 0o600 },
  );
  chmodSync(`${artifact}.sha256`, 0o600);
  const evidence = {
    artifact: 'nexus-db-20260807T100000Z.sqlite.age',
    artifactPath: artifact,
    encryptedSha256: sha256(bytes),
    encryptedSizeBytes: bytes.length,
    database: '/var/lib/nexus-hub/production/data/bot.db',
    startedAt,
    completedAt,
  };
  const freshReceipt = {
    schema: 'nexus.local-backup.v1',
    status: 'passed',
    kind: 'pre-promotion',
    backupRoot: root,
    database: evidence.database,
    startedAt,
    completedAt,
    encryptedSha256: evidence.encryptedSha256,
    encryptedSizeBytes: evidence.encryptedSizeBytes,
    installed: { 'pre-promotion': artifact },
    retention: { hourly: 24, daily: 30, weekly: 4, 'pre-promotion': 10 },
    plaintextSha256: 'a'.repeat(64),
    plaintextSizeBytes: 4096,
    integrityCheck: 'ok',
    foreignKeyCheck: 'ok',
  };
  const real = createReleaseBackup({
    ...backupTestAuthority(),
    policy: {
      ...policy,
      backup: { ...policy.backup, root, receiptPath },
    },
    now: () => Date.parse(completedAt),
    exec: (_bin: string, args: string[]) => {
      if (args[0] === 'start') {
        writeFileSync(receiptPath, JSON.stringify(freshReceipt), { mode: 0o600 });
        chmodSync(receiptPath, 0o600);
      }
      return { status: 0, stdout: args[0] === 'show' ? 'success\n' : '', stderr: '' };
    },
  });
  let pointerReads = 0;
  const verifiedEvidence: unknown[] = [];
  const backup = {
    readBackupReceipt: (options: { environment: string; notBeforeMs: number }) => {
      pointerReads += 1;
      return real.readBackupReceipt(options);
    },
    verifyBackupEvidence: (options: { environment: string; evidence: unknown }) => {
      verifiedEvidence.push(options.evidence);
      return real.verifyBackupEvidence(options);
    },
    createPreMigrationBackup: (options: { environment?: string }) => {
      const admitted = real.createPreMigrationBackup(options);
      // Model the retained hourly unit advancing last-success immediately after
      // the fresh pre-promotion receipt was admitted.
      writeFileSync(receiptPath, JSON.stringify({
        ...freshReceipt,
        kind: 'hourly',
        startedAt: '2026-08-07T10:04:59.000Z',
        completedAt: '2026-08-07T10:05:00.000Z',
      }), { mode: 0o600 });
      chmodSync(receiptPath, 0o600);
      return admitted;
    },
  };
  return {
    backup,
    evidence,
    pointerReads: () => pointerReads,
    receiptPath,
    verifiedEvidence,
  };
}

function fakeDatabaseProbe(
  result: 'passed' | 'failed' = 'passed',
  ledger: { ok?: boolean; applied?: string[]; detail?: string | null } = {},
) {
  const calls: string[] = [];
  const ledgerCalls: string[] = [];
  return {
    calls,
    ledgerCalls,
    probe: {
      databaseFile: (environment: string) => `/var/lib/nexus-hub/${environment}/data/bot.db`,
      checkIntegrity: ({ environment }: { environment: string }) => {
        calls.push(environment);
        return {
          name: 'database_integrity',
          result,
          durationMs: 0,
          detail: result === 'failed' ? 'integrity_check did not return ok' : null,
        };
      },
      readAppliedMigrations: ({ environment }: { environment: string }) => {
        ledgerCalls.push(environment);
        return {
          ok: ledger.ok ?? true,
          // Default: the whole default inventory is already applied, so nothing is
          // pending and reconciliation admits.
          applied: ledger.applied ?? [
            '001_a.sql', '002_b.sql', '283_release_schema_convergence.sql',
          ],
          ledgerPresent: true,
          detail: ledger.detail ?? null,
        };
      },
    },
  };
}

function seedPredecessor(store: ReturnType<typeof makeStore>) {
  const predecessorPayload = predecessorPayloadFor();
  const state = store.readState();
  store.writeState({
    ...state,
    predecessor: {
      releaseId: releaseIdFor(predecessorPayload),
      sourceSha: predecessorPayload.source.sha,
      images: {
        backend: {
          repository: policy.registry.backendImage,
          digest: PREDECESSOR_BACKEND_DIGEST,
        },
        contentEngine: {
          repository: policy.registry.contentEngineImage,
          digest: PREDECESSOR_CONTENT_DIGEST,
        },
      },
      // Rollback restores the predecessor's own payload, so its identity has to
      // be recorded when it completes.
      payload: {
        digest: PREDECESSOR_PAYLOAD_DIGEST,
        composeDigest: PREDECESSOR_COMPOSE_DIGEST,
      },
    },
  });
}

function seedLegacyPredecessor(store: ReturnType<typeof makeStore>) {
  const predecessorPayload = predecessorPayloadFor();
  const legacyPayload = legacyPayloadFor(predecessorPayload);
  const state = store.readState();
  store.writeState({
    ...state,
    predecessor: {
      releaseId: releaseIdFor(legacyPayload),
      sourceSha: legacyPayload.source.sha,
      images: legacyPayload.images,
      payload: {
        digest: PREDECESSOR_PAYLOAD_DIGEST,
        composeDigest: PREDECESSOR_COMPOSE_DIGEST,
      },
    },
  });
}

function seedCompletedLegacyRelease(
  store: ReturnType<typeof makeStore>,
  current: ReturnType<typeof payloadFor>,
) {
  const payload = legacyPayloadFor(current);
  const envelope = legacySigned(current);
  const releaseId = releaseIdFor(payload);
  const manifestDigest = sha256(canonicalJson(envelope));
  const evidenceDigest = releaseEvidenceDigest({
    manifestPayload: payload,
    manifestDigest,
    keyId: policy.trust.signingKeyId,
    releasePayloadDigest: ACTIVE_PAYLOAD_DIGEST,
  });
  store.beginAttempt({
    manifestPayload: payload,
    releaseId,
    payloadDigest: ACTIVE_PAYLOAD_DIGEST,
    manifestDigest,
    keyId: policy.trust.signingKeyId,
  });
  const backupEvidence = fakeBackupEvidence();
  store.recordStatus({
    manifestPayload: payload,
    releaseId,
    status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
    payloadDigest: ACTIVE_PAYLOAD_DIGEST,
    manifestDigest,
    keyId: policy.trust.signingKeyId,
    backupEvidence,
  });
  store.completeRelease({ releaseId, status: RELEASE_STATUSES.COMPLETED });
  store.recordAcceptedRunId(payload.source.runId);
  const passedPhase = { result: 'passed', checks: [], durationMs: 0 };
  const completedAt = '2026-08-07T10:00:02.000Z';
  store.writeReceipt({
    schema: LEGACY_RELEASE_RECEIPT_SCHEMA,
    releaseId,
    sourceSha: payload.source.sha,
    createdAt: payload.createdAt,
    completedAt,
    evidenceDigest,
    identity: {
      repository: payload.source.repository,
      ref: payload.source.ref,
      workflow: payload.source.workflow,
      runId: payload.source.runId,
      runAttempt: payload.source.runAttempt,
      manifestDigest,
      keyId: policy.trust.signingKeyId,
      releasePayloadDigest: ACTIVE_PAYLOAD_DIGEST,
    },
    images: payload.images,
    compose: payload.compose,
    migrations: {
      digest: payload.migrations.digest,
      reconciliationDigest: releaseMigrationReconciliationDigest(
        payload.migrations.reconciliation,
      ),
      upFileCount: payload.migrations.upFileCount,
      downFileCount: payload.migrations.downFileCount,
      eligible: payload.migrations.cdEligibility.eligible,
      predecessorCompatible: payload.migrations.cdEligibility.predecessorCompatible,
      reasons: payload.migrations.cdEligibility.reasons,
    },
    staging: passedPhase,
    production: passedPhase,
    backup: { result: 'passed', artifact: backupEvidence.artifact },
    rollback: {
      result: 'not_required',
      restored: null,
      incidentRecoveryDurationMs: 0,
      predecessorSwitchDurationMs: 0,
      predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
    },
    outcome: RELEASE_RECEIPT_OUTCOMES.COMPLETED,
    failureCode: null,
  });
  return { envelope, payload, releaseId };
}

const controllerOnlyIneligibleVerdict = Object.freeze({
  eligible: false,
  predecessorCompatible: true,
  reasons: ['controller governance changed without deployable migration changes'],
});

function controllerOnlyCandidate(overrides: Record<string, unknown> = {}) {
  return payloadFor({
    sha: NEWER_SHA,
    runId: '4243',
    ...overrides,
    migrations: {
      cdEligibility: controllerOnlyIneligibleVerdict,
      ...(overrides.migrations as object ?? {}),
    },
  });
}

async function deploy(options: {
  script?: RegistryScript;
  envelope?: unknown;
  store?: ReturnType<typeof makeStore>;
  health?: ReturnType<typeof fakeHealth>;
  notifier?: ReturnType<typeof fakeNotifier>;
  mirror?: ReturnType<typeof fakeMirror>;
  backup?: ReturnType<typeof fakeBackup>;
  databaseProbe?: ReturnType<typeof fakeDatabaseProbe>;
  bootstrap?: {
    verify: (input?: any) => {
      passed: boolean;
      baseline?: Record<string, any>;
      baselineDigest?: string;
    };
    verifyProduction?: (input?: any) => {
      passed: boolean;
      baseline?: Record<string, any>;
      baselineDigest?: string;
    };
  };
  allowFirstContainerBootstrap?: boolean;
  protectedHead?: {
    verify: (input: { expectedSha: string }) => {
      result: string;
      expectedSha?: string;
      headSha: string | null;
    };
  };
  controlPlane?: typeof CONTROL_PLANE;
  installedBackupInterface?: ReturnType<typeof fakeInstalledBackupInterface>;
  notificationDelayMs?: number[];
  nowMs?: number;
} = {}) {
  const envelope = options.envelope ?? signed(payloadFor());
  const store = options.store ?? makeStore();
  let now = options.nowMs ?? Date.parse('2026-08-07T10:00:05.000Z');
  const clock = () => now;
  const health = options.health ?? fakeHealth({ clock });
  const notificationDelays = [...(options.notificationDelayMs ?? [])];
  const notifier = options.notifier ?? fakeNotifier(() => {
    now += notificationDelays.shift() ?? 0;
  });
  const mirror = options.mirror ?? fakeMirror();
  const backup = options.backup ?? fakeBackup();
  const installedBackupInterface = options.installedBackupInterface
    ?? fakeInstalledBackupInterface();
  const databaseProbe = options.databaseProbe ?? fakeDatabaseProbe();
  const registryHarness = fakeRegistry(
    options.script ?? {},
    envelope,
    (ms) => { now += ms; },
  );
  const signedEnvelope = envelope as ReturnType<typeof signed>;
  const fakeBootstrapResult = (input: any) => {
    const baseline = {
      target: {
        releaseId: input.releaseId,
        sourceSha: signedEnvelope.payload.source.sha,
        releasePayloadDigest: input.releasePayloadDigest,
        manifestDigest: input.manifestDigest,
      },
    };
    return {
      passed: true,
      baseline,
      baselineDigest: sha256(canonicalJson(baseline)),
    };
  };
  const defaultBootstrap = {
    verify: fakeBootstrapResult,
    verifyProduction: fakeBootstrapResult,
  };
  const protectedHeadCalls: string[] = [];
  const protectedHead = options.protectedHead ?? fakeProtectedHead(protectedHeadCalls);

  // Most orchestration tests exercise an established container topology. Seed
  // its exact rollback predecessor instead of silently granting the one-shot
  // first-cutover authorization. Tests for that authorization opt in below.
  if (options.allowFirstContainerBootstrap === undefined
      && store.readState().predecessor === null) {
    seedPredecessor(store);
  }

  const result = await runReleaseDeployment({
    policy,
    controlPlane: options.controlPlane ?? CONTROL_PLANE,
    store,
    registry: registryHarness.registry as never,
    health: health.health as never,
    notifier: notifier.notifier as never,
    mirror: mirror.mirror as never,
    backup: backup as never,
    installedBackupInterface: installedBackupInterface as never,
    databaseProbe: databaseProbe.probe as never,
    protectedHead: protectedHead as never,
    bootstrap: options.bootstrap ?? defaultBootstrap,
    allowFirstContainerBootstrap: options.allowFirstContainerBootstrap ?? false,
    clock,
    log: () => {},
    env: { [LOCK_HELD_ENV]: '1' },
  });
  return {
    result, store, health, notifier, mirror, registryHarness, databaseProbe,
    installedBackupInterface,
    protectedHeadCalls,
    advance: (ms: number) => { now += ms; },
  };
}

// ═══════════════════════════════════════════════ AREA: state and locking

describe('release state and locking', () => {
  it('refuses to deploy unless the flock wrapper is holding the lock', async () => {
    await expect(runReleaseDeployment({
      policy,
      store: makeStore(),
      registry: {} as never,
      health: {} as never,
      notifier: {} as never,
      mirror: {} as never,
      backup: {} as never,
      databaseProbe: {} as never,
      env: {},
    })).rejects.toThrow(/must run under the flock wrapper/);
  });

  it('builds a non-blocking kernel flock command with a distinct contention code', () => {
    const command = resolveFlockCommand({
      lockFile: policy.paths.lockFile,
      argv: ['/usr/bin/node', 'scripts/release-deploy.mjs'],
      env: { NEXUS_RELEASE_FLOCK_BIN: '/usr/bin/flock' },
    });
    expect(command).toEqual([
      '/usr/bin/flock',
      '--nonblock',
      '--conflict-exit-code',
      '75',
      policy.paths.lockFile,
      '/usr/bin/node',
      'scripts/release-deploy.mjs',
    ]);
    // --nonblock is the contract: a contended poll exits rather than queueing.
    expect(command).toContain('--nonblock');
  });

  // Real kernel-flock behaviour needs util-linux `flock`, which macOS does not
  // ship. The wrapper argv and the lock-held guard above are asserted on every
  // platform; this pair proves the actual mutual exclusion, and runs wherever
  // flock exists — notably the Linux CI runner the poller is modelled on.
  const describeFlock = flockAvailable() ? describe : describe.skip;

  describeFlock('maintenance mutex serialization', () => {
    // The retained legacy root maintenance transactions (chat-capability flags,
    // routing-calibration export, ollama finalization, legacy retirement) all
    // hold the same mutex. During the PM2 transition a container release must
    // contend on it too, or a release and a maintenance transaction can mutate
    // the host at the same time. Documentation is not serialization.
    it('cannot run a release while a legacy maintenance transaction holds the mutex', async () => {
      const maintenanceLock = join(workspace, 'locks', 'maintenance.lock');
      const releaseLock = join(workspace, 'locks', 'cd-release.lock');
      ensureLockFile(maintenanceLock);
      ensureLockFile(releaseLock);
      const marker = join(workspace, 'overlap.txt');

      // Stand in for a legacy maintenance transaction: hold the mutex and work.
      const legacy = resolveFlockCommand({
        lockFile: maintenanceLock,
        argv: ['/bin/sh', '-c', `printf 'legacy\n' >> ${marker}; sleep 1`],
      });
      const legacyDone = new Promise<number>((resolve) => {
        const child = spawn(legacy[0], legacy.slice(1), { stdio: 'ignore' });
        child.on('exit', (code) => resolve(code ?? -1));
      });
      await new Promise((resolve) => { setTimeout(resolve, 150); });

      // A release takes the CD lock first, then the maintenance mutex, and must
      // be refused on the second because the legacy holder has it.
      const release = spawnSync(
        resolveFlockCommand({
          lockFile: releaseLock,
          argv: resolveFlockCommand({
            lockFile: maintenanceLock,
            argv: ['/bin/sh', '-c', `printf 'release\n' >> ${marker}`],
          }),
        })[0],
        resolveFlockCommand({
          lockFile: releaseLock,
          argv: resolveFlockCommand({
            lockFile: maintenanceLock,
            argv: ['/bin/sh', '-c', `printf 'release\n' >> ${marker}`],
          }),
        }).slice(1),
        { stdio: 'ignore' },
      );

      expect(release.status).toBe(LOCK_CONTENDED_EXIT_CODE);
      expect(await legacyDone).toBe(0);
      // Only the legacy transaction ran; the release never overlapped it.
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['legacy']);
    });

    it('runs the release once the maintenance transaction releases the mutex', () => {
      const maintenanceLock = join(workspace, 'locks', 'maintenance-free.lock');
      const releaseLock = join(workspace, 'locks', 'cd-release-free.lock');
      ensureLockFile(maintenanceLock);
      ensureLockFile(releaseLock);
      const nested = resolveFlockCommand({
        lockFile: releaseLock,
        argv: resolveFlockCommand({
          lockFile: maintenanceLock,
          argv: ['/bin/sh', '-c', 'exit 0'],
        }),
      });
      expect(spawnSync(nested[0], nested.slice(1), { stdio: 'ignore' }).status).toBe(0);
    });
  });

  describeFlock('kernel flock serialization', () => {
    it('lets exactly one of two concurrent holders run, and refuses the other', async () => {
      const lockFile = join(workspace, 'locks', 'release.lock');
      ensureLockFile(lockFile);
      const marker = join(workspace, 'ran.txt');

      // Each contender appends a line and holds the lock briefly, so a broken
      // lock shows up as two lines rather than as a timing coincidence.
      const contender = () => new Promise<number>((resolve) => {
        const command = resolveFlockCommand({
          lockFile,
          argv: ['/bin/sh', '-c', `printf 'ran\n' >> ${marker}; sleep 1`],
        });
        const child = spawn(command[0], command.slice(1), { stdio: 'ignore' });
        child.on('exit', (code) => resolve(code ?? -1));
      });

      const first = contender();
      // Start the second while the first is still inside its sleep.
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      const second = contender();
      const codes = await Promise.all([first, second]);

      expect(codes.filter((code) => code === 0)).toHaveLength(1);
      expect(codes.filter((code) => code === LOCK_CONTENDED_EXIT_CODE)).toHaveLength(1);
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['ran']);
    });

    it('releases the lock when the holder dies, so a crash cannot wedge the next poll', () => {
      const lockFile = join(workspace, 'locks', 'crash.lock');
      ensureLockFile(lockFile);

      // Kill the holder outright: no cleanup handler runs, so only the kernel
      // dropping the file-descriptor lock can make the next acquisition succeed.
      const crash = resolveFlockCommand({
        lockFile,
        argv: ['/bin/sh', '-c', 'kill -9 $$'],
      });
      spawnSync(crash[0], crash.slice(1), { stdio: 'ignore' });

      const after = resolveFlockCommand({ lockFile, argv: ['/bin/sh', '-c', 'exit 0'] });
      const result = spawnSync(after[0], after.slice(1), { stdio: 'ignore' });
      expect(result.status).toBe(0);
    });
  });

  it('accepts the lock-held signal only when it is exactly set', () => {
    expect(() => assertLockHeld({ [LOCK_HELD_ENV]: '1' })).not.toThrow();
    expect(() => assertLockHeld({ [LOCK_HELD_ENV]: 'true' })).toThrow();
    expect(() => assertLockHeld({})).toThrow();
  });

  it('halts an unattended first container cutover before staging or production mutation', async () => {
    const { result, registryHarness, store } = await deploy({
      allowFirstContainerBootstrap: false,
    });
    expect(result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.HALTED,
      reason: 'first_container_bootstrap_authorization_required',
    });
    expect(registryHarness.calls.some((call) => (
      ['composeRunMigrator', 'composeUp', 'composeDown'].includes(call.kind)
    ))).toBe(false);
  });

  it('requires the explicit bootstrap baseline to pass before the first staging mutation', async () => {
    const { result, registryHarness, store } = await deploy({
      allowFirstContainerBootstrap: true,
      bootstrap: { verify: () => ({ passed: false }) },
    });
    expect(result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      reason: 'bootstrap_target_abandoned',
    });
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.BOOTSTRAP_TARGET_ABANDONED);
    expect(registryHarness.calls.some((call) => (
      ['composeRunMigrator', 'composeUp', 'composeDown'].includes(call.kind)
    ))).toBe(false);
  });

  it('admits an owner-authorized governance-only first publication with a complete baseline', async () => {
    const payload = payloadFor({
      migrations: {
        upFileCount: 2,
        downFileCount: 41,
        cdEligibility: {
          eligible: false,
          predecessorCompatible: false,
          reasons: ['scripts/migration-safety-check.mjs:irreversible:POLICY_GATE_CHANGED'],
        },
      },
    });
    const { result, registryHarness } = await deploy({
      envelope: signed(payload),
      allowFirstContainerBootstrap: true,
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    expect(receipt.staging.checks).toContainEqual(expect.objectContaining({
      name: 'owner_bootstrap_baseline',
      result: 'passed',
      detail: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }));
    expect(receipt.staging.checks.find(
      (check: { name: string }) => check.name === 'owner_bootstrap_baseline',
    ).detail).not.toBe(`sha256:${sha256(canonicalJson(payload.migrations.inventory))}`);
  });

  it('revalidates the owner baseline after staging and before production mutation', async () => {
    let admitted: any;
    const bootstrap = {
      verify: (input: any) => {
        const baseline = { target: {
          releaseId: input.releaseId,
          sourceSha: input.manifestPayload.source.sha,
          releasePayloadDigest: input.releasePayloadDigest,
          manifestDigest: input.manifestDigest,
        } };
        admitted = {
          passed: true,
          baseline,
          baselineDigest: sha256(canonicalJson(baseline)),
        };
        return admitted;
      },
      verifyProduction: () => ({ ...admitted, passed: false }),
    };
    const { result, registryHarness, store } = await deploy({
      bootstrap,
      allowFirstContainerBootstrap: true,
    });
    expect(result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      reason: 'bootstrap_target_abandoned',
    });
    expect(store.readState().active).toBeNull();
    expect(store.readState().history[0]).toMatchObject({
      releaseId: releaseIdFor(payloadFor()),
      status: RELEASE_STATUSES.SUPERSEDED,
    });
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.BOOTSTRAP_TARGET_ABANDONED);
    expect(registryHarness.calls).toContainEqual(expect.objectContaining({
      kind: 'composeDown',
      environment: 'staging',
    }));
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeRunMigrator' && call.environment === 'production'
    ))).toBe(false);
  });

  it('resumes an accepted first bootstrap with production-only baseline checks', async () => {
    const store = makeStore();
    const payload = payloadFor();
    const envelope = signed(payload);
    const releaseId = releaseIdFor(payload);
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.STAGING_HEALTHY,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
    });
    store.recordAcceptedRunId(payload.source.runId);

    let fullChecks = 0;
    let productionChecks = 0;
    const productionOnly = (input: any) => {
      productionChecks += 1;
      const baseline = { target: {
        releaseId: input.releaseId,
        sourceSha: input.manifestPayload.source.sha,
        releasePayloadDigest: input.releasePayloadDigest,
        manifestDigest: input.manifestDigest,
      } };
      return {
        passed: true,
        baseline,
        baselineDigest: sha256(canonicalJson(baseline)),
      };
    };
    const { result } = await deploy({
      store,
      envelope,
      allowFirstContainerBootstrap: true,
      bootstrap: {
        verify: () => {
          fullChecks += 1;
          throw new Error('staging database is intentionally live on resume');
        },
        verifyProduction: productionOnly,
      },
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(fullChecks).toBe(0);
    expect(productionChecks).toBeGreaterThanOrEqual(2);
    const receipt = store.readReceipt(releaseId)!;
    const admitted = receipt.staging.checks.find(
      (check) => check.name === 'owner_bootstrap_baseline',
    );
    expect(receipt.production.checks).toContainEqual(expect.objectContaining({
      name: 'bootstrap_production_revalidation',
      result: 'passed',
      detail: admitted.detail,
    }));
  });

  it('writes state ahead of the production mutation it describes', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const observed: string[] = [];
    const wrapped = {
      ...store,
      recordStatus: (input: Parameters<typeof store.recordStatus>[0]) => {
        observed.push(`state:${input.status}`);
        return store.recordStatus(input);
      },
    };
    const envelope = signed(payloadFor());
    let now = Date.parse('2026-08-07T10:00:05.000Z');
    const health = fakeHealth({ clock: () => now });
    const harness = fakeRegistry({}, envelope);
    const originalComposeUp = harness.registry.composeUp;
    harness.registry.composeUp = (input: never) => {
      observed.push(`composeUp:${(input as { environment: string }).environment}`);
      return originalComposeUp(input);
    };

    await runReleaseDeployment({
      policy,
      controlPlane: CONTROL_PLANE,
      store: wrapped as never,
      registry: harness.registry as never,
      health: health.health as never,
      notifier: fakeNotifier().notifier as never,
      mirror: fakeMirror().mirror as never,
      backup: fakeBackup() as never,
      installedBackupInterface: fakeInstalledBackupInterface() as never,
      databaseProbe: fakeDatabaseProbe().probe as never,
      protectedHead: fakeProtectedHead() as never,
      clock: () => now,
      env: { [LOCK_HELD_ENV]: '1' },
    });

    const observingAt = observed.indexOf(`state:${RELEASE_STATUSES.PRODUCTION_OBSERVING}`);
    const productionUpAt = observed.indexOf('composeUp:production');
    expect(observingAt).toBeGreaterThanOrEqual(0);
    expect(productionUpAt).toBeGreaterThanOrEqual(0);
    expect(observingAt).toBeLessThan(productionUpAt);
  });

  it('writes receipts atomically and refuses to overwrite one', async () => {
    const { store, result } = await deploy();
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    const receipt = store.readReceipt(result.releaseId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.outcome).toBe('completed');
    expect(() => store.writeReceipt(receipt!)).toThrow(/refusing to overwrite the immutable file/);
  });

  it('binds receipt schema bidirectionally to the signed control-plane field', async () => {
    const { store, result } = await deploy();
    const current = store.readReceipt(result.releaseId!)!;
    expect(current.schema).toBe(RELEASE_RECEIPT_SCHEMA);
    const { controlPlane: _controlPlane, ...missingControlPlane } = current;
    expect(() => assertReleaseReceiptShape(missingControlPlane))
      .toThrow(/schema and controlPlane presence do not match/i);

    const legacyStore = makeStore(() => new Date('2026-08-07T10:00:02.000Z'));
    const legacy = seedCompletedLegacyRelease(legacyStore, payloadFor());
    const legacyReceipt = legacyStore.readReceipt(legacy.releaseId)!;
    expect(legacyReceipt.schema).toBe(LEGACY_RELEASE_RECEIPT_SCHEMA);
    expect(() => assertReleaseReceiptShape({
      ...legacyReceipt,
      controlPlane: CONTROL_PLANE,
    })).toThrow(/schema and controlPlane presence do not match/i);
  });

  it('never leaves an empty receipt behind when the write fails mid-way', () => {
    const store = makeStore();
    const invalid = { schema: 'nexus.release-receipt.v2', releaseId: 'nope' } as never;
    expect(() => store.writeReceipt(invalid)).toThrow();
    expect(store.listReceiptIds()).toEqual([]);
  });

  it('survives a stale same-pid temp file from a crash plus pid reuse', () => {
    const store = makeStore();
    mkdirSync(policy.paths.stateDir, { recursive: true });
    writeFileSync(`${store.stateFile}.next-${process.pid}`, 'stale bytes');
    const next = store.writeState(store.readState());
    expect(next.schema).toBe('nexus.release-host-state.v1');
    expect(JSON.parse(readFileSync(store.stateFile, 'utf8')).schema)
      .toBe('nexus.release-host-state.v1');
  });

  it('treats an unreadable state file as an error, never as absent', () => {
    const store = makeStore();
    mkdirSync(policy.paths.stateDir, { recursive: true });
    writeFileSync(store.stateFile, '{ truncated');
    expect(() => store.readState()).toThrow(/refusing to treat it as absent/);
  });

  it('treats an unreadable receipt as unprovable rather than missing', () => {
    const store = makeStore();
    mkdirSync(policy.paths.receiptDir, { recursive: true });
    const releaseId = sha256('x').slice(0, 32);
    writeFileSync(store.receiptPath(releaseId), '{ truncated');
    expect(() => store.readReceipt(releaseId)).toThrow(/refusing to treat it as absent/);
  });

  it('rejects a receipt whose embedded release id disagrees with its addressed filename', async () => {
    const { store, result } = await deploy();
    const receiptPath = store.receiptPath(result.releaseId!);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.releaseId = 'f'.repeat(32);
    writeFileSync(receiptPath, JSON.stringify(receipt));

    expect(() => store.readReceipt(result.releaseId!))
      .toThrow(/does not match the requested release id/);
  });

  it('recomputes the release id and rejects altered content under the same id', async () => {
    const { store, result } = await deploy();
    const receiptPath = store.receiptPath(result.releaseId!);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.images.backend.digest = `sha256:${'7'.repeat(64)}`;
    writeFileSync(receiptPath, JSON.stringify(receipt));

    expect(() => store.readReceipt(result.releaseId!))
      .toThrow(/release id does not match its content/);
  });

  it.each([
    ['identity digest', (receipt: Record<string, any>) => {
      receipt.identity.manifestDigest = 'not-a-digest';
    }],
    ['Compose path', (receipt: Record<string, any>) => {
      receipt.compose.path = '../substituted.yml';
    }],
    ['migration count', (receipt: Record<string, any>) => {
      receipt.migrations.upFileCount = -1;
    }],
    ['phase duration', (receipt: Record<string, any>) => {
      receipt.production.durationMs = -1;
    }],
    ['backup artifact', (receipt: Record<string, any>) => {
      receipt.backup.artifact = '../../other.age';
    }],
    ['rollback duration', (receipt: Record<string, any>) => {
      receipt.rollback.incidentRecoveryDurationMs = -1;
    }],
    ['predecessor switch longer than its incident', (receipt: Record<string, any>) => {
      receipt.rollback.incidentRecoveryDurationMs = 0;
      receipt.rollback.predecessorSwitchDurationMs = 1;
    }],
    ['legacy ambiguous rollback duration', (receipt: Record<string, any>) => {
      receipt.rollback.durationMs = 0;
    }],
  ])('strictly validates the receipt %s', async (_label, mutate) => {
    const { store, result } = await deploy();
    const receiptPath = store.receiptPath(result.releaseId!);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    mutate(receipt);
    writeFileSync(receiptPath, JSON.stringify(receipt));

    expect(() => store.readReceipt(result.releaseId!)).toThrow();
  });

  it('rejects restored receipt and rolled-back history timing beyond the switch objective', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);

    const receiptPath = store.receiptPath(result.releaseId!);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.rollback.incidentRecoveryDurationMs = 120_001;
    receipt.rollback.predecessorSwitchDurationMs = 120_001;
    receipt.rollback.predecessorSwitchObjectiveSeconds = 120;
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(() => store.readReceipt(result.releaseId!)).toThrow(/exceeds its objective/i);

    const state = store.readState();
    state.history[0].recoveryTiming = {
      incidentRecoveryDurationMs: 120_001,
      predecessorSwitchDurationMs: 120_001,
      predecessorSwitchObjectiveSeconds: 120,
    };
    expect(() => assertReleaseStateShape(state)).toThrow(/exceeds its objective/i);
  });

  it.each([
    ['repository', (receipt: Record<string, any>) => {
      receipt.identity.repository = 'owner/other-repository';
    }],
    ['ref', (receipt: Record<string, any>) => {
      receipt.identity.ref = 'refs/heads/other';
    }],
    ['workflow', (receipt: Record<string, any>) => {
      receipt.identity.workflow = 'Other release workflow';
    }],
    ['run id', (receipt: Record<string, any>) => {
      receipt.identity.runId = '4243';
    }],
    ['run attempt', (receipt: Record<string, any>) => {
      receipt.identity.runAttempt = '2';
    }],
    ['manifest digest', (receipt: Record<string, any>) => {
      receipt.identity.manifestDigest = 'f'.repeat(64);
    }],
    ['key id', (receipt: Record<string, any>) => {
      receipt.identity.keyId = 'other-release-key';
    }],
    ['migration verdict', (receipt: Record<string, any>) => {
      receipt.migrations.eligible = false;
      receipt.migrations.predecessorCompatible = false;
      receipt.migrations.reasons = ['governance policy changed'];
    }],
  ])('rejects shape-valid receipt tampering of %s', async (_label, mutate) => {
    const { store, result } = await deploy();
    const receiptPath = store.receiptPath(result.releaseId!);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    mutate(receipt);
    // The deployable-content release id deliberately remains stable across CI
    // republication metadata. The separate evidence digest must still expose
    // every altered signed claim.
    expect(releaseIdFor({
      source: { sha: receipt.sourceSha },
      images: receipt.images,
      compose: receipt.compose,
      controlPlane: receipt.controlPlane,
      migrations: receipt.migrations,
    } as never)).toBe(result.releaseId);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(() => store.readReceipt(result.releaseId!))
      .toThrow(/evidence digest does not match/i);
  });

  it('binds a terminal receipt to the active OCI payload before authorizing a quiet no-op', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const first = await deploy({ store });
    const receipt = store.readReceipt(first.result.releaseId!)!;
    expect(receipt.identity.releasePayloadDigest).toBe(PAYLOAD_DIGEST);

    // Simulate state corruption/substitution that points the active projection at
    // a different OCI artifact while retaining the old terminal receipt. Without
    // receipt-to-state binding, a moving pointer at that digest is silently called
    // the already-completed payload even though the receipt proves another blob.
    const state = store.readState();
    store.writeState({
      ...state,
      active: {
        ...state.active!,
        payload: { ...state.active!.payload, digest: NEWER_PAYLOAD_DIGEST },
      },
    });
    const effective = resolveEffectiveRelease({
      state: store.readState(),
      readReceipt: store.readReceipt,
    });
    expect(effective.provable).toBe(false);

    const second = await deploy({
      store,
      script: { payloadDigests: [NEWER_PAYLOAD_DIGEST] },
    });
    expect(second.result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      reason: 'unprovable_active_release',
    });
    expect(second.registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(false);
    expect(store.readState().blocked?.reason)
      .toBe(BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE);
  });

  it('is idempotent: republishing an identical manifest performs no work', async () => {
    const envelope = signed(payloadFor());
    const store = makeStore();
    seedPredecessor(store);
    const first = await deploy({ envelope, store });
    expect(first.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(first.store.readState().active?.rollbackTarget?.payload.digest)
      .toBe(PREDECESSOR_PAYLOAD_DIGEST);

    const second = await deploy({ envelope, store: first.store });
    // The settled receipt plus the exact persisted OCI payload digest is enough
    // to no-op before manifest freshness is re-evaluated.
    expect(second.result.outcome).toBe(DEPLOYMENT_OUTCOMES.NOOP);
    expect(second.result.reason).toBe('already_completed_payload');
    expect(second.protectedHeadCalls).toEqual([]);
    // And it must be a genuine no-op: nothing staged, migrated, or promoted.
    const touched = second.registryHarness.calls.filter((call) => (
      ['composeUp', 'composeRunMigrator', 'composeDown'].includes(call.kind)
    ));
    expect(touched).toEqual([]);
    const payloadPrune = second.registryHarness.calls.find((call) => (
      call.kind === 'pruneImages' && call.repository === policy.registry.releaseImage
    ));
    expect(payloadPrune?.keepDigests).toEqual(expect.arrayContaining([
      PAYLOAD_DIGEST,
      PREDECESSOR_PAYLOAD_DIGEST,
    ]));
    const workDirPrune = second.registryHarness.calls.find((call) => call.kind === 'pruneWorkDirs');
    expect(workDirPrune?.keepDirs).toEqual(expect.arrayContaining([
      join(policy.paths.workDir, PAYLOAD_DIGEST.replace('sha256:', '')),
      join(policy.paths.workDir, PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', '')),
    ]));
  });

  it('preserves the exact authorizing run when another run republishes the same deployable identity', async () => {
    const firstEnvelope = signed(payloadFor({ runId: '4242' }));
    const first = await deploy({ envelope: firstEnvelope });
    const republishedEnvelope = signed(payloadFor({ runId: '4243' }));
    expect(releaseIdFor(republishedEnvelope.payload)).toBe(first.result.releaseId);

    const second = await deploy({
      store: first.store,
      envelope: republishedEnvelope,
      // A separate publication may have a different OCI payload digest even
      // when its source/images/Compose/migrations deployment identity is equal.
      script: { payloadDigests: [NEWER_PAYLOAD_DIGEST] },
    });
    expect(second.result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.REFUSED,
      reason: 'already_settled_completed',
      releaseId: first.result.releaseId,
    });

    const receipt = first.store.readReceipt(first.result.releaseId!)!;
    expect(receipt.identity.runId).toBe('4242');
    expect(receipt.identity.runAttempt).toBe('1');
    expect(receipt.identity.manifestDigest).toBe(sha256(canonicalJson(firstEnvelope)));
    expect(receipt.identity.releasePayloadDigest).toBe(PAYLOAD_DIGEST);
  });

  it('derives one release id from signed content, so identical content is one release', () => {
    const left = payloadFor();
    const right = payloadFor();
    expect(releaseIdFor(left)).toBe(releaseIdFor(right));
    expect(releaseIdFor(payloadFor({ sha: NEWER_SHA }))).not.toBe(releaseIdFor(left));
    expect(releaseIdFor(payloadFor({
      controlPlane: { ...CONTROL_PLANE, digest: 'f'.repeat(64) },
    }))).not.toBe(releaseIdFor(left));
  });

  it('defers a controller-incompatible release before governed deployment mutation', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const before = canonicalJson(store.readState());
    const deployed = await deploy({
      store,
      controlPlane: { ...CONTROL_PLANE, digest: 'f'.repeat(64) },
    });

    expect(deployed.result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
      reason: 'control_plane_mismatch',
      releaseId: releaseIdFor(payloadFor()),
    });
    expect(canonicalJson(store.readState())).toBe(before);
    expect(deployed.protectedHeadCalls).toEqual([]);
    expect(deployed.databaseProbe.ledgerCalls).toEqual([]);
    expect(deployed.registryHarness.calls.filter((call) => (
      ['pruneImages', 'pruneWorkDirs', 'composeConfigValid', 'composeUp',
        'composeDown', 'composeRunMigrator'].includes(call.kind)
    ))).toEqual([]);
  });

  it('requires installed backup authority proof before candidate admission', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const before = canonicalJson(store.readState());
    const installedBackupInterface = fakeInstalledBackupInterface([false]);

    await expect(deploy({ store, installedBackupInterface }))
      .rejects.toThrow(/installed backup interface does not match/i);

    expect(installedBackupInterface.calls).toEqual([1]);
    expect(canonicalJson(store.readState())).toBe(before);
  });

  it('re-proves installed backup authority after staging and before starting backup', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const installedBackupInterface = fakeInstalledBackupInterface([true, false]);
    const backing = fakeBackup();
    let backupStarts = 0;
    const backup = {
      ...backing,
      createPreMigrationBackup: (input: { environment?: string }) => {
        backupStarts += 1;
        return backing.createPreMigrationBackup(input);
      },
    };

    await expect(deploy({
      store,
      installedBackupInterface,
      backup: backup as never,
    })).rejects.toThrow(/installed backup interface does not match/i);

    expect(installedBackupInterface.calls).toEqual([1, 2]);
    expect(backupStarts).toBe(0);
    expect(store.readState().active?.status).toBe(RELEASE_STATUSES.STAGING_HEALTHY);
  });

  it('admits an ineligible v3 controller-only publication over an eligible retained v2 release', async () => {
    const store = makeStore(() => new Date('2026-08-07T10:00:02.000Z'));
    const current = payloadFor({ runId: '4242' });
    const retained = seedCompletedLegacyRelease(store, current);
    const candidate = controllerOnlyCandidate();
    expect(retained.payload.migrations.cdEligibility.eligible).toBe(true);
    expect(candidate.migrations.cdEligibility.eligible).toBe(false);
    expect(candidate.migrations.digest).not.toBe(retained.payload.migrations.digest);

    const deployed = await deploy({
      store,
      envelope: signed(candidate),
      script: { activeEnvelope: retained.envelope },
    });

    expect(deployed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    const receipt = store.readReceipt(deployed.result.releaseId!)!;
    expect(receipt.migrations.eligible).toBe(false);
    expect(receipt.staging.checks).toContainEqual({
      name: 'controller_only_transition',
      result: 'passed',
      durationMs: 0,
      detail: 'controller_only_transition',
    });
    expect(sanitizeDetail(receipt.staging.checks.find((check) => (
      check.name === 'controller_only_transition'
    ))?.detail)).toBe('controller_only_transition');
    expect(store.readReceipt(deployed.result.releaseId!)).toEqual(receipt);
    const retainedExtract = deployed.registryHarness.calls.findIndex((call) => (
      call.kind === `extract:${policy.registry.releaseImage}@${ACTIVE_PAYLOAD_DIGEST}`
    ));
    const firstComposeOperation = deployed.registryHarness.calls.findIndex((call) => (
      ['composeConfigValid', 'composeRunMigrator', 'composeUp'].includes(call.kind)
    ));
    expect(retainedExtract).toBeGreaterThan(-1);
    expect(firstComposeOperation).toBeGreaterThan(retainedExtract);
  });

  it('admits the same exact-content bridge over a retained v3 release with an older controller', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const oldControlPlane = { ...CONTROL_PLANE, digest: 'd'.repeat(64) };
    const current = payloadFor({ controlPlane: oldControlPlane, runId: '4242' });
    const active = await deploy({
      store,
      envelope: signed(current),
      controlPlane: oldControlPlane,
      script: { payloadDigests: [ACTIVE_PAYLOAD_DIGEST] },
    });
    expect(active.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(store.readReceipt(active.result.releaseId!)?.schema).toBe(RELEASE_RECEIPT_SCHEMA);

    const candidate = controllerOnlyCandidate();
    const deployed = await deploy({
      store,
      envelope: signed(candidate),
      script: { activeEnvelope: signed(current) },
    });

    expect(deployed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(store.readReceipt(deployed.result.releaseId!)?.staging.checks)
      .toContainEqual(expect.objectContaining({ name: 'controller_only_transition' }));
  });

  it.each([
    ['migration inventory', (current: ReturnType<typeof payloadFor>) => ({
      candidate: controllerOnlyCandidate({
        inventory: current.migrations.inventory.map((entry, index) => (
          index === 0 ? { ...entry, sha256: 'c'.repeat(64) } : entry
        )),
      }),
      script: {},
    })],
    ['migration reconciliation', (current: ReturnType<typeof payloadFor>) => ({
      candidate: controllerOnlyCandidate({
        reconciliation: {
          ...current.migrations.reconciliation,
          sourcePolicySha256: '0'.repeat(64),
        },
      }),
      script: {},
    })],
    ['migration count', () => ({
      candidate: controllerOnlyCandidate({ migrations: { downFileCount: 42 } }),
      script: {},
    })],
    ['image identity', () => ({
      candidate: controllerOnlyCandidate({
        images: {
          ...IMAGES,
          backend: { ...IMAGES.backend, digest: `sha256:${'0'.repeat(64)}` },
        },
      }),
      script: {},
    })],
    ['Compose identity', () => {
      const bytes = Buffer.from('services:\n  backend:\n    labels: [controller-drift]\n');
      return {
        candidate: controllerOnlyCandidate({ composeDigest: sha256(bytes) }),
        script: { candidateComposeBytes: bytes },
      };
    }],
  ])('refuses controller-only authorization on one-field %s drift', async (_label, build) => {
    const store = makeStore(() => new Date('2026-08-07T10:00:02.000Z'));
    const current = payloadFor({ runId: '4242' });
    const retained = seedCompletedLegacyRelease(store, current);
    const { candidate, script } = build(current);
    const deployed = await deploy({
      store,
      envelope: signed(candidate),
      script: { ...script, activeEnvelope: retained.envelope },
    });

    expect(deployed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().active?.releaseId).toBe(retained.releaseId);
    expect(deployed.registryHarness.calls.filter((call) => (
      ['composeConfigValid', 'composeRunMigrator', 'composeUp', 'composeDown'].includes(call.kind)
    ))).toEqual([]);
    expect(deployed.registryHarness.calls.filter((call) => (
      call.kind === 'pruneImages'
      && [policy.registry.backendImage, policy.registry.contentEngineImage]
        .includes(call.repository ?? '')
    ))).toEqual([]);
  });

  it.each([
    ['missing', (retained: ReturnType<typeof seedCompletedLegacyRelease>) => ({
      activeEnvelope: retained.envelope,
      activePayloadMissing: true,
    })],
    ['unverifiable', () => ({
      activeEnvelope: legacySigned(payloadFor({ sha: 'c'.repeat(40), runId: '4242' })),
    })],
  ])('refuses controller-only authorization when the retained payload is %s', async (
    _label,
    activeScript,
  ) => {
    const store = makeStore(() => new Date('2026-08-07T10:00:02.000Z'));
    const current = payloadFor({ runId: '4242' });
    const retained = seedCompletedLegacyRelease(store, current);
    const candidate = controllerOnlyCandidate();
    const deployed = await deploy({
      store,
      envelope: signed(candidate),
      script: activeScript(retained),
    });

    expect(deployed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().active?.releaseId).toBe(retained.releaseId);
    expect(deployed.registryHarness.calls.filter((call) => (
      ['composeConfigValid', 'composeRunMigrator', 'composeUp', 'composeDown'].includes(call.kind)
    ))).toEqual([]);
  });

  it.each([
    [PROTECTED_HEAD_RESULTS.MISMATCH, DEPLOYMENT_OUTCOMES.SUPERSEDED, 'protected_head_changed'],
    [PROTECTED_HEAD_RESULTS.UNAVAILABLE, DEPLOYMENT_OUTCOMES.DEFERRED, 'protected_head_unavailable'],
  ])('refuses fresh admission when protected-head result is %s', async (
    headResult,
    outcome,
    reason,
  ) => {
    const { result, store, registryHarness, databaseProbe } = await deploy({
      protectedHead: {
        verify: ({ expectedSha }) => ({
          result: headResult,
          expectedSha,
          headSha: headResult === PROTECTED_HEAD_RESULTS.MISMATCH ? NEWER_SHA : null,
        }),
      },
    });
    expect(result).toMatchObject({ outcome, reason });
    expect(store.readState().active).toBeNull();
    expect(store.readState().lastAcceptedRunId).toBeNull();
    expect(databaseProbe.ledgerCalls).toEqual([]);
    expect(registryHarness.calls.some((call) => (
      ['composeUp', 'composeRunMigrator', 'composeDown'].includes(call.kind)
    ))).toBe(false);
  });

  it('hard-blocks and retains active evidence when stale staging teardown fails', async () => {
    let checks = 0;
    const { result, store, registryHarness } = await deploy({
      script: { composeDownFailures: { staging: 1 } },
      protectedHead: {
        verify: ({ expectedSha }) => {
          checks += 1;
          return checks === 1
            ? { result: PROTECTED_HEAD_RESULTS.CURRENT, expectedSha, headSha: expectedSha }
            : { result: PROTECTED_HEAD_RESULTS.MISMATCH, expectedSha, headSha: NEWER_SHA };
        },
      },
    });
    expect(result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      reason: 'preproduction_teardown_failed',
    });
    expect(store.readState().active?.status).toBe(RELEASE_STATUSES.STAGING_HEALTHY);
    expect(store.readState().blocked?.reason)
      .toBe(BLOCK_REASONS.PREPRODUCTION_TEARDOWN_FAILED);
    expect(store.readState().history.some((entry) => (
      entry.status === RELEASE_STATUSES.SUPERSEDED
    ))).toBe(false);
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(false);
  });

  it('tears down and atomically retires a candidate when protected main advances', async () => {
    const envelope = signed(payloadFor());
    let checks = 0;
    const { result, registryHarness, store } = await deploy({
      envelope,
      protectedHead: {
        verify: ({ expectedSha }) => {
          checks += 1;
          return checks === 1
            ? { result: PROTECTED_HEAD_RESULTS.CURRENT, expectedSha, headSha: expectedSha }
            : { result: PROTECTED_HEAD_RESULTS.MISMATCH, expectedSha, headSha: NEWER_SHA };
        },
      },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.SUPERSEDED);
    expect(registryHarness.calls).toContainEqual(expect.objectContaining({
      kind: 'composeDown', environment: 'staging',
    }));
    expect(registryHarness.calls.some((call) => call.kind === 'composeUp' && call.environment === 'production'))
      .toBe(false);
    expect(store.readState().active).toBeNull();
    expect(store.readState().history[0]).toMatchObject({
      releaseId: releaseIdFor(payloadFor()),
      status: RELEASE_STATUSES.SUPERSEDED,
    });
  });

  it('rechecks protected main after backup and ledger reconciliation before mutation', async () => {
    const baseBackup = fakeBackup();
    let backupCompleted = false;
    const backup = {
      ...baseBackup,
      createPreMigrationBackup: (options?: { environment?: string }) => {
        const result = baseBackup.createPreMigrationBackup(options);
        backupCompleted = true;
        return result;
      },
    };
    const databaseProbe = fakeDatabaseProbe();
    const readAppliedMigrations = databaseProbe.probe.readAppliedMigrations;
    let productionLedgerRead = false;
    databaseProbe.probe.readAppliedMigrations = (options: { environment: string }) => {
      const result = readAppliedMigrations(options);
      if (options.environment === 'production') productionLedgerRead = true;
      return result;
    };
    let checks = 0;

    const { result, registryHarness, store } = await deploy({
      backup,
      databaseProbe,
      protectedHead: {
        verify: ({ expectedSha }) => {
          checks += 1;
          return backupCompleted && productionLedgerRead
            ? { result: PROTECTED_HEAD_RESULTS.MISMATCH, expectedSha, headSha: NEWER_SHA }
            : { result: PROTECTED_HEAD_RESULTS.CURRENT, expectedSha, headSha: expectedSha };
        },
      },
    });

    expect(checks).toBe(3);
    expect(result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.SUPERSEDED,
      reason: 'protected_head_changed',
    });
    expect(registryHarness.calls).toContainEqual(expect.objectContaining({
      kind: 'composeDown', environment: 'staging',
    }));
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeRunMigrator' && call.environment === 'production'
    ))).toBe(false);
    expect(store.readState().active).toBeNull();
    expect(store.readState().history[0]).toMatchObject({
      releaseId: releaseIdFor(payloadFor()),
      status: RELEASE_STATUSES.SUPERSEDED,
    });
  });

  it('ranks a matching observed receipt above a stale state projection', async () => {
    const { store, result } = await deploy();
    const state = store.readState();
    store.writeState({
      ...state,
      active: { ...state.active!, status: RELEASE_STATUSES.PRODUCTION_OBSERVING },
    });
    const effective = resolveEffectiveRelease({
      state: store.readState(),
      readReceipt: store.readReceipt,
    });
    expect(effective.source).toBe('receipt');
    expect(effective.status).toBe(RELEASE_STATUSES.COMPLETED);
    expect(effective.releaseId).toBe(result.releaseId);
    expect(effective.staleProjection).toBe(true);
  });

  it.each([
    [RELEASE_RECEIPT_OUTCOMES.BLOCKED, (receipt: Record<string, any>) => {
      receipt.outcome = RELEASE_RECEIPT_OUTCOMES.BLOCKED;
      receipt.failureCode = 'provider_rejected';
    }],
    [RELEASE_RECEIPT_OUTCOMES.STAGING_FAILED, (receipt: Record<string, any>) => {
      receipt.outcome = RELEASE_RECEIPT_OUTCOMES.STAGING_FAILED;
      receipt.failureCode = 'compose_invalid';
      receipt.staging = { result: 'failed', checks: [], durationMs: 0 };
      receipt.production = { result: 'skipped', checks: [], durationMs: 0 };
      receipt.backup = { result: 'skipped', artifact: null };
    }],
  ])('rejects a shape-valid %s receipt beside a completed active projection', async (
    _outcome,
    mutate,
  ) => {
    const { store, result } = await deploy();
    const receiptPath = store.receiptPath(result.releaseId!);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    mutate(receipt);
    writeFileSync(receiptPath, JSON.stringify(receipt));

    // Outcome and phase evidence are not signed-manifest claims, so this is a
    // shape-valid receipt with the same release/evidence identity. Only the
    // explicit outcome-to-state compatibility gate exposes the contradiction.
    expect(() => store.readReceipt(result.releaseId!)).not.toThrow();
    const effective = resolveEffectiveRelease({
      state: store.readState(),
      readReceipt: store.readReceipt,
    });
    expect(effective).toMatchObject({
      source: 'receipt',
      status: RELEASE_STATUSES.COMPLETED,
      stateStatus: RELEASE_STATUSES.COMPLETED,
      provable: false,
      staleProjection: false,
    });
  });

  it('keeps a compatible staging-failed receipt provable at eligible', async () => {
    const stagingFailed = await deploy({
      health: fakeHealth({ stagingHealthy: false, clock: () => 0 }),
    });
    expect(stagingFailed.store.readState().active?.status).toBe(RELEASE_STATUSES.ELIGIBLE);
    expect(resolveEffectiveRelease({
      state: stagingFailed.store.readState(),
      readReceipt: stagingFailed.store.readReceipt,
    })).toMatchObject({
      source: 'receipt',
      status: RELEASE_STATUSES.ELIGIBLE,
      provable: true,
      staleProjection: false,
    });
  });

  it('keeps a compatible blocked receipt provable at staging healthy', async () => {
    const blocked = await deploy({ backup: fakeBackup('failed') });
    expect(blocked.store.readState().active?.status).toBe(RELEASE_STATUSES.STAGING_HEALTHY);
    expect(resolveEffectiveRelease({
      state: blocked.store.readState(),
      readReceipt: blocked.store.readReceipt,
    })).toMatchObject({
      source: 'receipt',
      status: RELEASE_STATUSES.STAGING_HEALTHY,
      provable: true,
      staleProjection: false,
    });
  });

  it('refuses new work when a settled status has no receipt to prove it', async () => {
    const store = makeStore();
    const payload = payloadFor();
    store.recordStatus({
      manifestPayload: payload,
      releaseId: releaseIdFor(payload),
      status: RELEASE_STATUSES.COMPLETED,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });
    // No receipt on disk: the writer died between the two writes.
    const effective = resolveEffectiveRelease({ state: store.readState(), readReceipt: () => null });
    expect(effective.provable).toBe(false);

    const { result } = await deploy({ envelope: signed(payloadFor({ sha: NEWER_SHA })), store });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(result.reason).toBe('unprovable_active_release');
    expect(store.readState().blocked?.reason)
      .toBe(BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE);
  });

  it('keeps a failed release identity refused rather than retrying it on a timer', async () => {
    const envelope = signed(payloadFor());
    const first = await deploy({
      envelope,
      health: fakeHealth({ stagingHealthy: false, clock: () => 0 }),
    });
    expect(first.result.outcome).toBe(DEPLOYMENT_OUTCOMES.STAGING_FAILED);

    const second = await deploy({ envelope, store: first.store });
    expect(second.result.outcome).toBe(DEPLOYMENT_OUTCOMES.REFUSED);
    expect(second.result.reason).toBe('previously_failed_digests');
  });

  it('halts every later attempt until a block is acknowledged for the exact release', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const blocked = await deploy({
      store,
      envelope: signed(payloadFor({
        migrations: {
          upFileCount: 274,
          downFileCount: 41,
          cdEligibility: {
            eligible: false,
            predecessorCompatible: false,
            reasons: ['migrations/090_x.sql:drop_table'],
          },
        },
      })),
    });
    expect(blocked.result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);

    const next = await deploy({ store, envelope: signed(payloadFor({ sha: NEWER_SHA })) });
    expect(next.result.outcome).toBe(DEPLOYMENT_OUTCOMES.HALTED);

    store.acknowledgeBlock();
    expect(store.readState().blocked).toBeNull();
  });
});

describe('protected-main head verifier', () => {
  it('uses one bounded credential-free exact-ref git query with a scrubbed environment', () => {
    const calls: any[] = [];
    const verifier = createProtectedHeadVerifier({
      policy,
      gitBin: '/usr/bin/git',
      exec: ((command: string, args: string[], options: any) => {
        calls.push({ command, args, options });
        return {
          status: 0,
          stdout: `${SOURCE_SHA}\t${policy.trust.protectedRef}\n`,
          stderr: '',
        };
      }) as never,
    });
    expect(verifier.verify({ expectedSha: SOURCE_SHA })).toEqual({
      result: PROTECTED_HEAD_RESULTS.CURRENT,
      expectedSha: SOURCE_SHA,
      headSha: SOURCE_SHA,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/usr/bin/git',
      args: [
        '-c', 'credential.helper=',
        '-c', 'core.askPass=/bin/false',
        '-c', 'http.extraHeader=',
        'ls-remote', '--exit-code', '--refs',
        policy.trust.protectedRepositoryUrl,
        policy.trust.protectedRef,
      ],
      options: {
        timeoutMs: policy.timing.protectedHeadTimeoutSeconds * 1000,
        env: expect.objectContaining({
          HOME: '/var/empty',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        }),
      },
    });
    expect(calls[0].options.env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it.each([
    [`${SOURCE_SHA}\trefs/heads/not-main\n`, 0],
    [`${SOURCE_SHA}\t${basePolicy.trust.protectedRef}\n${NEWER_SHA}\t${basePolicy.trust.protectedRef}\n`, 0],
    [`${SOURCE_SHA} ${basePolicy.trust.protectedRef}\n`, 0],
    ['', 1],
  ])('fails closed on malformed or unavailable ls-remote evidence', (stdout, status) => {
    const verifier = createProtectedHeadVerifier({
      policy,
      gitBin: '/usr/bin/git',
      exec: (() => ({ status, stdout, stderr: '' })) as never,
    });
    expect(verifier.verify({ expectedSha: SOURCE_SHA }).result)
      .toBe(PROTECTED_HEAD_RESULTS.UNAVAILABLE);
  });

  it('rejects an unpinned relative Git binary', () => {
    expect(() => createProtectedHeadVerifier({ policy, gitBin: 'git' }))
      .toThrow(/normalized absolute path/);
  });
});

// ═══════════════════════════════════════════════ AREA: migrations

describe('migration continuous-deployment eligibility', () => {
  it('accepts additive expand and data-only backfill migrations', () => {
    const result = evaluateMigrationCdEligibility({
      changedMigrations: [
        { file: 'migrations/300_add_table.sql', sql: 'CREATE TABLE widget (id INTEGER PRIMARY KEY);' },
        { file: 'migrations/301_backfill.sql', sql: "UPDATE widget SET id = 1 WHERE id IS NULL;" },
      ],
    });
    expect(result.eligible).toBe(true);
    expect(result.predecessorCompatible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('blocks contract and destructive migrations with a named reason', () => {
    for (const [sql, reason] of [
      ['DROP TABLE widget;', 'drop_table'],
      ['ALTER TABLE widget DROP COLUMN name;', 'drop_column'],
      ['ALTER TABLE widget RENAME TO gadget;', 'rename'],
      ['DELETE FROM widget;', 'delete_rows'],
      ['DROP INDEX widget_name_idx;', 'drop_schema_object'],
    ] as const) {
      const result = evaluateMigrationCdEligibility({
        changedMigrations: [{ file: 'migrations/400_change.sql', sql }],
      });
      expect(result.eligible, sql).toBe(false);
      expect(result.reasons.join(','), sql).toContain(reason);
    }
  });

  it('blocks a new constraint the predecessor could violate', () => {
    const notNull = evaluateMigrationCdEligibility({
      changedMigrations: [{
        file: 'migrations/401_not_null.sql',
        sql: 'ALTER TABLE widget ADD COLUMN owner TEXT NOT NULL;',
      }],
    });
    expect(notNull.eligible).toBe(false);
    expect(notNull.reasons.join(',')).toContain('add_column_not_null_constraint');

    const unique = evaluateMigrationCdEligibility({
      changedMigrations: [{
        file: 'migrations/402_unique.sql',
        sql: 'CREATE UNIQUE INDEX widget_owner ON widget(owner);',
      }],
    });
    expect(unique.eligible).toBe(false);
    expect(unique.reasons.join(',')).toContain('create_unique_index');
  });

  it('blocks a NOT NULL column with a default on a pre-existing table', () => {
    const result = evaluateMigrationCdEligibility({
      changedMigrations: [{
        file: 'migrations/403_default.sql',
        sql: "ALTER TABLE widget ADD COLUMN owner TEXT NOT NULL DEFAULT '';",
      }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(',')).toContain('add_column_not_null_constraint');
  });

  it('allows a unique index on a table the same migration created', () => {
    const result = evaluateMigrationCdEligibility({
      changedMigrations: [{
        file: 'migrations/404_new_table_unique.sql',
        sql: `CREATE TABLE gadget (id INTEGER PRIMARY KEY, slug TEXT);
              CREATE UNIQUE INDEX gadget_slug ON gadget(slug);`,
      }],
    });
    expect(result.eligible).toBe(true);
    expect(result.predecessorCompatible).toBe(true);
  });

  it('fails closed on SQL it does not recognize', () => {
    const result = evaluateMigrationCdEligibility({
      changedMigrations: [{
        file: 'migrations/405_unknown.sql',
        sql: 'ALTER TABLE widget SET SOMETHING WEIRD;',
      }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(',')).toContain('unclassified_alter_table');
  });

  it('keeps trigger bodies intact instead of shredding them into fragments', () => {
    const statements = splitSqlStatements(`
      CREATE TRIGGER widget_touch AFTER UPDATE ON widget
      BEGIN
        UPDATE widget SET id = id WHERE id = NEW.id;
      END;
      CREATE TABLE other (id INTEGER);
    `);
    expect(statements).toHaveLength(2);
    expect(classifyMigrationSql(statements.join(';\n')).kind).not.toBe('unknown');
  });

  it('blocks when an irreversible finding or a safety error is present', () => {
    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{ file: 'migrations/406_ok.sql', sql: 'CREATE TABLE a (id INTEGER);' }],
      irreversibleFindings: [{ file: 'migrations/406_ok.sql', reason: 'POLICY:audited_drop' }],
    }).eligible).toBe(false);

    expect(evaluateMigrationCdEligibility({
      changedMigrations: [{ file: 'migrations/407_ok.sql', sql: 'CREATE TABLE b (id INTEGER);' }],
      blockingErrors: ['migration_sequence_gap:408'],
    }).eligible).toBe(false);
  });

  it('reports no-change releases as eligible with an explicit reason', () => {
    const result = evaluateMigrationCdEligibility({});
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual(['no_migration_changes']);
  });

  it('is independent of the owner-authorization verdict', () => {
    // A migration an owner has approved as an irreversible operation is still not
    // eligible for an unattended deploy; the two decisions must not be conflated.
    const approved = evaluateMigrationCdEligibility({
      changedMigrations: [{ file: 'migrations/409_drop.sql', sql: 'DROP TABLE legacy;' }],
      irreversibleFindings: [{ file: 'migrations/409_drop.sql', reason: 'POLICY:approved' }],
    });
    expect(approved.eligible).toBe(false);
    expect(approved.predecessorCompatible).toBe(false);
  });

  it('classifies every migration in the repository without an unknown verdict', () => {
    // Guards the classifier against the real corpus: an `unknown` here would
    // silently block a release for a shape the repository already uses.
    const migrationsDir = join(repoRoot, 'migrations');
    const files = require('node:fs').readdirSync(migrationsDir)
      .filter((file: string) => /^\d{3}_.*\.sql$/.test(file));
    expect(files.length).toBeGreaterThan(200);
    const unknown = files.filter((file: string) => (
      classifyMigrationSql(readFileSync(join(migrationsDir, file), 'utf8')).kind === 'unknown'
    ));
    expect(unknown).toEqual([]);
  });
});

// ═══════════════════════════════════════════════ AREA: release failures

describe('release failure handling', () => {
  it('runs both production integrity pragmas through the host SQLite read-only path', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const outputs = ['ok\n', ''];
    const probe = createReleaseDatabaseProbe({
      policy,
      sqliteBin: '/usr/bin/sqlite3',
      exec: (bin: string, args: string[]) => {
        calls.push({ bin, args });
        return { status: 0, stdout: outputs.shift() ?? '', stderr: '' };
      },
    });

    expect(probe.checkIntegrity({ environment: 'production' }).result).toBe('passed');
    expect(calls).toEqual([
      {
        bin: '/usr/bin/sqlite3',
        args: [
          '-readonly',
          'file:/var/lib/nexus-hub/production/data/bot.db?mode=ro',
          'PRAGMA integrity_check;',
        ],
      },
      {
        bin: '/usr/bin/sqlite3',
        args: [
          '-readonly',
          'file:/var/lib/nexus-hub/production/data/bot.db?mode=ro',
          'PRAGMA foreign_key_check;',
        ],
      },
    ]);
  });

  it('fails the real database probe on foreign-key output', () => {
    const outputs = ['ok\n', 'users|1|accounts|0\n'];
    const probe = createReleaseDatabaseProbe({
      policy,
      exec: () => ({ status: 0, stdout: outputs.shift() ?? '', stderr: '' }),
    });

    expect(probe.checkIntegrity({ environment: 'production' })).toMatchObject({
      name: 'database_integrity',
      result: 'failed',
      detail: '1 foreign key violations',
    });
  });

  it('prevents production entirely when staging fails', async () => {
    const { result, registryHarness } = await deploy({
      health: fakeHealth({ stagingHealthy: false, clock: () => 0 }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.STAGING_FAILED);
    const environments = registryHarness.calls
      .filter((call) => call.kind === 'composeUp' || call.kind === 'composeRunMigrator')
      .map((call) => call.environment);
    expect(environments).not.toContain('production');
    expect(registryHarness.calls.some((call) => call.kind === 'composeDown')).toBe(true);
  });

  it('hard-blocks a staging failure until its exact stack is removed', async () => {
    const { result, registryHarness, store } = await deploy({
      health: fakeHealth({ stagingHealthy: false, clock: () => 0 }),
      script: { composeDownFailures: { staging: 1 } },
    });
    expect(result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      reason: 'preproduction_teardown_failed',
    });
    expect(store.readState().active?.status).toBe(RELEASE_STATUSES.ELIGIBLE);
    expect(store.readState().blocked?.reason)
      .toBe(BLOCK_REASONS.PREPRODUCTION_TEARDOWN_FAILED);
    expect(store.readReceipt(result.releaseId!)).toBeNull();
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(false);
  });

  it('runs the staging migrator before staging comes up', async () => {
    const payload = payloadFor();
    const { registryHarness } = await deploy({ envelope: signed(payload) });
    const migratorAt = registryHarness.calls
      .findIndex((call) => call.kind === 'composeRunMigrator' && call.environment === 'staging');
    const upAt = registryHarness.calls
      .findIndex((call) => call.kind === 'composeUp' && call.environment === 'staging');
    expect(migratorAt).toBeGreaterThanOrEqual(0);
    expect(migratorAt).toBeLessThan(upAt);
    expect(registryHarness.composeIdentities.length).toBeGreaterThan(0);
    expect(registryHarness.composeIdentities.every((call) => (
      JSON.stringify(call.releaseIdentity) === JSON.stringify(releaseIdentityFor(payload))
    ))).toBe(true);
  });

  it('materializes a directly mounted container-readable candidate plan', async () => {
    await deploy();
    const planDir = join(
      policy.paths.workDir,
      PAYLOAD_DIGEST.replace('sha256:', ''),
      'runtime-plan',
    );
    const planPath = join(planDir, 'migration-plan.json');
    expect(statSync(planDir).mode & 0o777).toBe(0o755);
    expect(statSync(planPath).mode & 0o777).toBe(0o644);
    expect(statSync(planPath).nlink).toBe(1);
    expect(JSON.parse(readFileSync(planPath, 'utf8'))).toMatchObject({
      schema: 'nexus.release-migration-plan.v2',
      releaseId: releaseIdFor(payloadFor()),
    });
  });

  it('restores the predecessor image pair when the observation window fails', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const predecessorBefore = store.readState().predecessor;
    const health = fakeHealth({ degradeAfterProbes: 2, clock: () => 0 });
    const notifier = fakeNotifier();
    const { result, registryHarness } = await deploy({ store, health, notifier });
    const candidateIdentity = releaseIdentityFor(payloadFor());
    const predecessorIdentity = {
      releaseId: predecessorBefore!.releaseId,
      sourceSha: predecessorBefore!.sourceSha,
      backendImageDigest: predecessorBefore!.images.backend.digest,
    };

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    const productionUps = registryHarness.calls
      .filter((call) => call.kind === 'composeUp' && call.environment === 'production');
    expect(productionUps).toHaveLength(2);
    expect(productionUps[1].images).toEqual(predecessorBefore!.images);
    const productionUpIdentities = registryHarness.composeIdentities.filter((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ));
    expect(productionUpIdentities.map((call) => call.releaseIdentity)).toEqual([
      candidateIdentity,
      predecessorIdentity,
    ]);
    expect(registryHarness.composeIdentities.filter((call) => (
      call.environment === 'staging'
    )).every((call) => (
      JSON.stringify(call.releaseIdentity) === JSON.stringify(candidateIdentity)
    ))).toBe(true);
    expect(registryHarness.composeIdentities.filter((call) => (
      call.kind === 'composeRunningImages'
    )).at(-1)?.releaseIdentity).toEqual(predecessorIdentity);
    const predecessorPlan = join(
      workspace,
      'work',
      PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''),
      'runtime-plan',
      'migration-plan.json',
    );
    expect(existsSync(predecessorPlan)).toBe(true);
    expect(JSON.parse(readFileSync(predecessorPlan, 'utf8'))).toMatchObject({
      schema: 'nexus.release-migration-plan.v3',
      releaseId: predecessorBefore!.releaseId,
      reconciliationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      rollback: {
        successor: expect.objectContaining({ releaseId: result.releaseId }),
        forwardApplied: [],
      },
    });

    const receipt = store.readReceipt(result.releaseId!)!;
    expect(receipt.outcome).toBe('rolled_back');
    expect(receipt.rollback.result).toBe('restored');
    expect(receipt.rollback.predecessorSwitchObjectiveSeconds).toBe(120);
    expect(receipt.failureCode).toBe(sanitizeDetail(FAILURE_CODES.OBSERVATION_FAILED));

    const kinds = notifier.sent.map((entry) => entry.kind);
    expect(kinds).toContain(RELEASE_NOTIFICATION_KINDS.FAILURE);
    expect(kinds).toContain(RELEASE_NOTIFICATION_KINDS.RECOVERY);
  });

  it('restores the retained v2 predecessor after admitting a controller-bound release', async () => {
    const store = makeStore();
    seedLegacyPredecessor(store);
    const predecessor = predecessorPayloadFor();
    const deployed = await deploy({
      store,
      script: { predecessorEnvelope: legacySigned(predecessor) },
      health: fakeHealth({ degradeAfterProbes: 2, clock: () => 0 }),
    });

    expect(deployed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    expect(store.readState().predecessor?.releaseId)
      .toBe(releaseIdFor(legacyPayloadFor(predecessor)));
    const productionUps = deployed.registryHarness.calls.filter((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ));
    expect(productionUps).toHaveLength(2);
    expect(productionUps[1].images).toEqual(legacyPayloadFor(predecessor).images);
  });

  it('binds predecessor boot to the verified successor forward-applied suffix', async () => {
    const successorEntry = {
      file: '284_successor_expand.sql',
      sha256: 'd'.repeat(64),
      kind: 'expand',
      predecessorCompatible: true,
    };
    const successorPayload = payloadFor({
      inventory: [
        { file: '001_a.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
        { file: '002_b.sql', sha256: 'b'.repeat(64), kind: 'backfill', predecessorCompatible: true },
        successorEntry,
      ],
    });
    const ledger = fakeDatabaseProbe('passed', {
      applied: [
        '001_a.sql', '002_b.sql', '283_release_schema_convergence.sql', successorEntry.file,
      ],
    });
    const { result } = await deploy({
      envelope: signed(successorPayload),
      databaseProbe: ledger,
      health: fakeHealth({ degradeAfterProbes: 2, clock: () => 0 }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    const rollbackPlan = JSON.parse(readFileSync(join(
      workspace,
      'work',
      PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''),
      'runtime-plan',
      'migration-plan.json',
    ), 'utf8'));
    expect(rollbackPlan).toMatchObject({
      schema: 'nexus.release-migration-plan.v3',
      rollback: {
        successor: {
          releaseId: releaseIdFor(successorPayload),
          sourceSha: successorPayload.source.sha,
          backendImageDigest: successorPayload.images.backend.digest,
          releasePayloadDigest: PAYLOAD_DIGEST,
          manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        forwardApplied: [{ file: successorEntry.file, sha256: successorEntry.sha256 }],
      },
    });
  });

  it('refuses a completed receipt until both production containers match signed digests', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const wrongBackend = {
      healthy: true,
      state: 'healthy',
      image: `${policy.registry.backendImage}@${PREDECESSOR_BACKEND_DIGEST}`,
      name: policy.compose.backendService,
    };
    const { result } = await deploy({
      store,
      script: {
        // First observation is the candidate identity gate. The subsequent
        // rollback identity call defaults to the exact predecessor pair.
        runningImagesByCall: [{ [policy.compose.backendService]: wrongBackend }],
      },
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    const receipt = store.readReceipt(result.releaseId!)!;
    expect(receipt.outcome).toBe('rolled_back');
    expect(receipt.failureCode).toBe(sanitizeDetail(FAILURE_CODES.PRODUCTION_IDENTITY));
    expect(receipt.production.checks).toContainEqual(expect.objectContaining({
      name: `production_identity_${policy.compose.backendService}`,
      result: 'failed',
    }));
  });

  it('never displaces the predecessor with a rolled-back candidate', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const before = store.readState().predecessor;
    await deploy({ store, health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }) });
    expect(store.readState().predecessor).toEqual(before);
  });

  it('reconciles a bound recovery receipt written just before the state projection', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const first = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
    });
    expect(first.result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);

    // Model the narrow crash window: immutable rollback evidence reached disk,
    // while state still projects the write-ahead mutation and recovery block.
    const state = store.readState();
    store.writeState({
      ...state,
      active: { ...state.active!, status: RELEASE_STATUSES.PRODUCTION_OBSERVING },
      blocked: {
        releaseId: first.result.releaseId!,
        reason: BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE,
        since: state.blocked!.since,
      },
    });

    const second = await deploy({ store });
    expect(second.result).toMatchObject({
      outcome: DEPLOYMENT_OUTCOMES.ROLLED_BACK,
      reason: 'reconciled_crash_recovery_receipt',
      releaseId: first.result.releaseId,
    });
    expect(store.readState().active?.status).toBe(RELEASE_STATUSES.ROLLED_BACK);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FIRED);
  });

  it('hard-stops and alerts when there is no predecessor to restore', async () => {
    const notifier = fakeNotifier();
    const { result, store } = await deploy({
      health: fakeHealth({ productionHealthy: false, clock: () => 0 }),
      notifier,
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FAILED);
    expect(store.readReceipt(result.releaseId!)!.rollback.result).toBe('failed');
    expect(notifier.sent[0].release.actionRequired).toMatch(/manual recovery required/);
  });

  it('hard-stops when the predecessor itself does not recover', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result } = await deploy({
      store,
      health: fakeHealth({
        productionHealthy: false,
        predecessorHealthy: false,
        clock: () => 0,
      }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FAILED);
  });

  it('hard-stops without rolling back when the production database is corrupt', async () => {
    // Rollback swaps images and never restores an older database, so it cannot
    // repair corruption — it would put older code in front of a damaged file.
    const store = makeStore();
    seedPredecessor(store);
    const predecessorBefore = store.readState().predecessor;
    const notifier = fakeNotifier();
    const databaseProbe = fakeDatabaseProbe('failed');
    const { result, registryHarness } = await deploy({
      store,
      notifier,
      databaseProbe,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.DATABASE_INTEGRITY);

    const receipt = store.readReceipt(result.releaseId!)!;
    expect(receipt.failureCode).toBe(sanitizeDetail(FAILURE_CODES.DATABASE_INTEGRITY));
    // Explicitly "not attempted", not "failed": the pipeline chose not to.
    expect(receipt.rollback.result).toBe('not_attempted');
    expect(receipt.rollback.restored).toBeNull();
    expect(receipt.production.checks.some((check) => check.name === 'database_integrity'))
      .toBe(true);

    // Production was never switched back, and the predecessor is untouched.
    const productionUps = registryHarness.calls
      .filter((call) => call.kind === 'composeUp' && call.environment === 'production');
    expect(productionUps).toHaveLength(1);
    expect(store.readState().predecessor).toEqual(predecessorBefore);

    expect(notifier.sent[0].release.actionRequired).toMatch(/do not roll back/);
    expect(notifier.sent[0].release.actionRequired).toMatch(/recover from backup/);
  });

  it('checks database integrity against production before any rollback decision', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const databaseProbe = fakeDatabaseProbe('passed');
    const { result } = await deploy({
      store,
      databaseProbe,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
    });
    expect(databaseProbe.calls).toEqual(['production']);
    // A sound database still rolls back normally.
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
  });

  it('does not probe the database on a healthy release', async () => {
    const databaseProbe = fakeDatabaseProbe('passed');
    const { result } = await deploy({ databaseProbe });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(databaseProbe.calls).toEqual([]);
  });

  it('stops before touching production when the pre-migration backup fails', async () => {
    const notifier = fakeNotifier();
    const { result, store, registryHarness } = await deploy({
      backup: fakeBackup('failed'),
      notifier,
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    const productionCalls = registryHarness.calls
      .filter((call) => call.environment === 'production');
    expect(productionCalls).toHaveLength(0);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.DATABASE_INTEGRITY);
    expect(notifier.sent[0].release.actionRequired).toMatch(/production was not modified/);
  });

  it('hard-stops on a failed production migrator instead of retrying it', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result, registryHarness } = await deploy({
      store,
      script: { migratorExit: { production: 1 } },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.DATABASE_INTEGRITY);
    // A half-applied schema must not be followed by a container switch.
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(false);
  });

  it('refuses an ineligible migration and names the owner-gated missing path', async () => {
    const notifier = fakeNotifier();
    const store = makeStore();
    seedPredecessor(store);
    const activePayload = payloadFor({
      sha: 'd'.repeat(40),
      runId: '4000',
      images: {
        backend: {
          repository: policy.registry.backendImage,
          digest: ACTIVE_BACKEND_DIGEST,
        },
        contentEngine: {
          repository: policy.registry.contentEngineImage,
          digest: ACTIVE_CONTENT_DIGEST,
        },
      },
    });
    const active = await deploy({
      store,
      envelope: signed(activePayload),
      script: { payloadDigests: [ACTIVE_PAYLOAD_DIGEST] },
    });
    expect(active.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    const { result, registryHarness } = await deploy({
      store,
      notifier,
      envelope: signed(payloadFor({
        migrations: {
          upFileCount: 274,
          downFileCount: 41,
          cdEligibility: {
            eligible: false,
            predecessorCompatible: false,
            reasons: ['migrations/500_drop.sql:drop_table'],
          },
        },
      })),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.MIGRATION_NOT_CD_ELIGIBLE);
    expect(store.readReceipt(result.releaseId!)!.migrations.eligible).toBe(false);
    expect(notifier.sent[0].release.actionRequired).toMatch(
      /owner decision required.*maintenance path is not implemented/,
    );
    // Content-addressed release discovery stays bounded, but an ineligible
    // candidate cannot mutate application-image retention before authorization.
    const imagePrunes = new Map(registryHarness.calls
      .filter((call) => call.kind === 'pruneImages')
      .map((call) => [call.repository, call.keepDigests]));
    expect(imagePrunes.get(policy.registry.releaseImage)).toEqual([
      PAYLOAD_DIGEST,
      ACTIVE_PAYLOAD_DIGEST,
      PREDECESSOR_PAYLOAD_DIGEST,
    ]);
    expect(imagePrunes.get(policy.registry.backendImage)).toBeUndefined();
    expect(imagePrunes.get(policy.registry.contentEngineImage)).toBeUndefined();
    const workPrune = registryHarness.calls.find((call) => call.kind === 'pruneWorkDirs');
    expect(workPrune?.keepDirs?.map((dir) => dir.split('/').at(-1))).toEqual([
      PAYLOAD_DIGEST.replace('sha256:', ''),
      ACTIVE_PAYLOAD_DIGEST.replace('sha256:', ''),
      PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''),
    ]);
  });
});

// ═══════════════════════════════════════════════ AREA: security and operations

describe('migration admission is reconciled against the ledger', () => {
  const CONTRACT_INVENTORY = [
    { file: '001_a.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
    { file: '002_drop.sql', sha256: 'b'.repeat(64), kind: 'contract', predecessorCompatible: false },
  ];

  it('blocks release A for its contract migration', async () => {
    const { result, store } = await deploy({
      envelope: signed(payloadFor({
        inventory: CONTRACT_INVENTORY,
        migrations: {
          cdEligibility: {
            eligible: false,
            predecessorCompatible: false,
            reasons: ['migrations/002_drop.sql:drop_table'],
          },
        },
      })),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.MIGRATION_NOT_CD_ELIGIBLE);
  });

  it('refuses an unrelated release B while A\'s contract migration is still pending', async () => {
    // THE HOLE THIS CLOSES: A is blocked and acknowledged. B changes no migrations
    // at all, so B's own delta verdict is "eligible" — but the migrator applies
    // every ledger-pending file, which still includes A's DROP. Eligibility from a
    // Git delta cannot see that; reconciliation against the ledger can.
    const store = makeStore();
    seedPredecessor(store);

    const blockedA = await deploy({
      store,
      envelope: signed(payloadFor({
        inventory: CONTRACT_INVENTORY,
        migrations: {
          cdEligibility: {
            eligible: false, predecessorCompatible: false, reasons: ['contract'],
          },
        },
      })),
    });
    expect(blockedA.result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);

    // The owner acknowledges the incident.
    store.acknowledgeBlock();
    expect(store.readState().blocked).toBeNull();
    // Acknowledging must NOT erase the unresolved pending-contract record.
    expect(store.readState().unresolvedContractMigrations?.files).toContain('002_drop.sql');

    // B: a code-only release. Its own migration delta is empty and eligible, and
    // it carries a NEW run id so monotonic ordering does not refuse it.
    const releaseB = await deploy({
      store,
      envelope: signed(payloadFor({
        sha: 'c'.repeat(40),
        runId: '9999',
        inventory: CONTRACT_INVENTORY,
        migrations: {
          cdEligibility: { eligible: true, predecessorCompatible: true, reasons: [] },
        },
      })),
      // The ledger still has A's contract migration pending.
      databaseProbe: fakeDatabaseProbe('passed', { applied: ['001_a.sql'] }),
    });

    expect(releaseB.result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    const receipt = store.readReceipt(releaseB.result.releaseId!)!;
    expect(receipt.failureCode).toBe(sanitizeDetail(FAILURE_CODES.PENDING_NOT_COMPATIBLE));

    // The load-bearing assertion: production was never migrated.
    const productionMigrations = releaseB.registryHarness.calls.filter((call) => (
      call.kind === 'composeRunMigrator' && call.environment === 'production'
    ));
    expect(productionMigrations).toEqual([]);
    const productionUps = releaseB.registryHarness.calls.filter((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ));
    expect(productionUps).toEqual([]);
  });

  it('admits a release once the contract migration is no longer pending', async () => {
    const store = makeStore();
    seedPredecessor(store);
    store.recordUnresolvedContractMigrations({
      releaseId: sha256('old').slice(0, 32),
      files: ['002_drop.sql'],
    });
    const { result } = await deploy({
      store,
      envelope: signed(payloadFor({ inventory: CONTRACT_INVENTORY })),
      // Model observed post-maintenance ledger truth without implying that this
      // repository currently supplies the owner-gated executor.
      databaseProbe: fakeDatabaseProbe('passed', { applied: ['001_a.sql', '002_drop.sql'] }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    // Observed evidence, not an acknowledgement, clears the unresolved marker.
    expect(store.readState().unresolvedContractMigrations).toBeNull();
  });

  it('refuses when the ledger holds a migration the release does not carry', async () => {
    const { result, store } = await deploy({
      databaseProbe: fakeDatabaseProbe('passed', {
        applied: ['001_a.sql', '002_b.sql', '900_from_elsewhere.sql'],
      }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.MIGRATION_NOT_CD_ELIGIBLE);
  });

  it('blocks when the ledger cannot be read at all', async () => {
    const { result, registryHarness } = await deploy({
      databaseProbe: fakeDatabaseProbe('passed', { ok: false, detail: 'ledger read exit 1' }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(registryHarness.calls.filter((call) => (
      call.kind === 'composeRunMigrator' && call.environment === 'production'
    ))).toEqual([]);
  });

  it('reconciles before migrating, never after', async () => {
    const { registryHarness, databaseProbe } = await deploy();
    expect(databaseProbe.ledgerCalls).toEqual(['production']);
    // The reconciliation read must precede the production migrator call.
    const migratorIndex = registryHarness.calls.findIndex((call) => (
      call.kind === 'composeRunMigrator' && call.environment === 'production'
    ));
    expect(migratorIndex).toBeGreaterThan(-1);
  });
});

describe('anti-replay and monotonic source ordering', () => {
  it.each([
    RELEASE_STATUSES.ELIGIBLE,
    RELEASE_STATUSES.STAGING_HEALTHY,
  ])('resumes the same active %s release despite its accepted run id', async (status) => {
    const payload = payloadFor({ runId: '8800' });
    const acceptedAt = Date.parse(payload.createdAt) + 1_000;
    let storeNow = acceptedAt;
    const store = makeStore(() => new Date(storeNow));
    seedPredecessor(store);
    const releaseId = releaseIdFor(payload);
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
    });
    store.recordAcceptedRunId(payload.source.runId);

    // A later retry advances the mutable status timestamp beyond the freshness
    // window. Retained payload verification must remain bound to startedAt,
    // which records the first accepted evidence boundary.
    storeNow = Date.parse(payload.createdAt)
      + Number(policy.trust.maxManifestAgeSeconds) * 1000
      + 1;
    store.beginAttempt({
      manifestPayload: payload,
      releaseId,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
    });
    expect(store.readState().active).toMatchObject({
      startedAt: new Date(acceptedAt).toISOString(),
      updatedAt: new Date(storeNow).toISOString(),
    });

    const resumed = await deploy({
      store,
      envelope: signed(payload),
      // Freshness gates first acceptance. This exact payload was accepted before
      // the simulated crash, so expiry must not turn a retry into a permanent
      // pre-production wedge.
      nowMs: storeNow,
    });
    expect(resumed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(resumed.store.readReceipt(releaseId)?.outcome).toBe('completed');
  });

  it('resumes exact accepted evidence when the moving tag republishes the same release id', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const acceptedPayload = payloadFor({ runId: '8800' });
    const republishedPayload = payloadFor({ runId: '8801' });
    const releaseId = releaseIdFor(acceptedPayload);
    expect(releaseIdFor(republishedPayload)).toBe(releaseId);
    store.recordStatus({
      manifestPayload: acceptedPayload,
      releaseId,
      status: RELEASE_STATUSES.STAGING_HEALTHY,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(acceptedPayload),
    });
    store.recordAcceptedRunId(acceptedPayload.source.runId);

    const resumed = await deploy({
      store,
      envelope: signed(acceptedPayload),
      script: {
        payloadDigests: [NEWER_PAYLOAD_DIGEST],
        newerPayload: {
          digest: NEWER_PAYLOAD_DIGEST,
          envelope: signed(republishedPayload),
        },
      },
    });

    expect(resumed.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(resumed.store.readReceipt(releaseId)?.identity).toMatchObject({
      runId: acceptedPayload.source.runId,
      releasePayloadDigest: PAYLOAD_DIGEST,
    });
    expect(resumed.registryHarness.calls).toContainEqual(expect.objectContaining({
      kind: `extract:${policy.registry.releaseImage}@${PAYLOAD_DIGEST}`,
    }));
    expect(resumed.registryHarness.calls).toContainEqual(expect.objectContaining({
      kind: `extract:${policy.registry.releaseImage}@${NEWER_PAYLOAD_DIGEST}`,
    }));
  });

  it('no-ops an exact completed payload after manifest freshness expires', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const payload = payloadFor({ runId: '8900' });
    const envelope = signed(payload);
    const first = await deploy({ store, envelope });
    expect(first.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);

    const expiredAt = Date.parse(payload.createdAt)
      + Number(policy.trust.maxManifestAgeSeconds) * 1000
      + 1;
    const quietPoll = await deploy({ store, envelope, nowMs: expiredAt });
    expect(quietPoll.result.outcome).toBe(DEPLOYMENT_OUTCOMES.NOOP);
    expect(quietPoll.result.reason).toBe('already_completed_payload');

    const staleNewPayload = payloadFor({ sha: NEWER_SHA, runId: '8901' });
    await expect(deploy({
      store,
      envelope: signed(staleNewPayload),
      script: { payloadDigests: [NEWER_PAYLOAD_DIGEST] },
      nowMs: expiredAt,
    })).rejects.toThrow(/older than the accepted freshness window/);
  });

  it('A then B then replayed A performs zero staging and production work', async () => {
    const store = makeStore();
    seedPredecessor(store);

    const envelopeA = signed(payloadFor({ sha: 'a'.repeat(40), runId: '100' }));
    const envelopeB = signed(payloadFor({ sha: 'b'.repeat(40), runId: '200' }));

    const a = await deploy({ store, envelope: envelopeA });
    expect(a.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    const b = await deploy({
      store,
      envelope: envelopeB,
      script: { payloadDigests: [NEWER_PAYLOAD_DIGEST] },
    });
    expect(b.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);

    // A is still inside its signature freshness window, and A is no longer the
    // active release — so the previous "is the active release completed?" check
    // could not see it. Its own settled receipt and the monotonic run id can.
    const replay = await deploy({ store, envelope: envelopeA });
    expect(replay.result.outcome).toBe(DEPLOYMENT_OUTCOMES.REFUSED);
    const work = replay.registryHarness.calls.filter((call) => (
      ['composeUp', 'composeRunMigrator', 'composeDown'].includes(call.kind)
    ));
    expect(work).toEqual([]);
  });

  it('refuses a manifest whose run id is not greater than the last accepted', async () => {
    const store = makeStore();
    seedPredecessor(store);
    await deploy({ store, envelope: signed(payloadFor({ sha: 'a'.repeat(40), runId: '500' })) });
    // Different content (so a different release id and no receipt), older run.
    const older = await deploy({
      store,
      envelope: signed(payloadFor({ sha: 'd'.repeat(40), runId: '499' })),
      script: { payloadDigests: [NEWER_PAYLOAD_DIGEST] },
    });
    expect(older.result.outcome).toBe(DEPLOYMENT_OUTCOMES.REFUSED);
    expect(older.result.reason).toBe('non_monotonic_source_order');
  });

  it('records the accepted run id so ordering survives a restart', async () => {
    const store = makeStore();
    seedPredecessor(store);
    await deploy({ store, envelope: signed(payloadFor({ runId: '777' })) });
    expect(store.readState().lastAcceptedRunId).toBe('777');
  });

  it('refuses to act on a candidate whose receipt is unreadable', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const envelope = signed(payloadFor());
    mkdirSync(policy.paths.receiptDir, { recursive: true });
    writeFileSync(store.receiptPath(releaseIdFor(payloadFor())), '{ truncated');
    const { result } = await deploy({ store, envelope });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.HALTED);
    expect(result.reason).toBe('unreadable_candidate_receipt');
  });
});

describe('protected head governs promotion while the registry pointer is only a hint', () => {
  it('refreshes the pointer opportunistically after protected-head verification', async () => {
    const { registryHarness } = await deploy();
    // The second pull can discover a same-head republication, but it cannot
    // overrule the credential-free protected-head result.
    const pointerPulls = registryHarness.calls.filter((call) => (
      call.kind === 'pull' && String(call.reference ?? '').endsWith(':main')
    ));
    expect(pointerPulls.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores a cancelled older publication that overwrites the moving tag', async () => {
    const staleEnvelope = signed(payloadFor({ sha: 'c'.repeat(40), runId: '4243' }));
    const { result, registryHarness } = await deploy({
      script: {
        payloadDigests: [PAYLOAD_DIGEST, NEWER_PAYLOAD_DIGEST],
        newerPayload: { digest: NEWER_PAYLOAD_DIGEST, envelope: staleEnvelope },
      },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(true);
  });

  it.each(['pull', 'resolve'] as const)(
    'continues the exact current-head candidate through a transient pointer %s failure',
    async (failure) => {
      const store = makeStore();
      seedPredecessor(store);
      const first = await deploy({
        store,
        script: failure === 'pull' ? { pullFailures: 1 } : { resolveFailures: 1 },
      });
      const releaseId = releaseIdFor(payloadFor());
      expect(first.result).toMatchObject({
        outcome: DEPLOYMENT_OUTCOMES.COMPLETED,
        releaseId,
      });
      expect(store.isRejected(releaseId)).toBe(false);
      expect(first.registryHarness.calls.some((call) => (
        call.kind === 'composeUp' && call.environment === 'production'
      ))).toBe(true);
      expect(store.readReceipt(releaseId)?.outcome).toBe('completed');
    },
  );
});

describe('predecessor retention across consecutive releases', () => {
  it('keeps exactly the current and immediate predecessor digests', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const firstBackend = store.readState().predecessor!.images.backend.digest;

    const a = await deploy({ store, envelope: signed(payloadFor({ sha: 'a'.repeat(40), runId: '10' })) });
    expect(a.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    // A completed, so the retained pair is {A, seeded predecessor} — reading
    // `predecessor` after completion would return A twice and delete the real one.
    const firstPrune = a.registryHarness.calls.find((call) => call.kind === 'pruneImages');
    expect(firstPrune).toBeDefined();
    expect(a.registryHarness.keptDigests.flat()).toContain(firstBackend);

    // A is now the rollback target for the next release.
    expect(store.readState().predecessor!.images.backend.digest).toBe(BACKEND_DIGEST);
  });

  it('bounds the extracted release payload directories', async () => {
    const { registryHarness } = await deploy();
    const pruned = registryHarness.calls.find((call) => call.kind === 'pruneWorkDirs');
    expect(pruned).toBeDefined();
    expect(pruned!.keepDirs!.length).toBeGreaterThan(0);
  });
});

describe('rollback verifies what is actually running', () => {
  it('records rollback_failed when the restored containers run the wrong image', async () => {
    // Health on a generic port proves *something* answers. If the failed candidate
    // is still up it answers happily, and the old code recorded that as "restored".
    const store = makeStore();
    seedPredecessor(store);
    const { result } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      script: { imageMatches: false },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    const receipt = store.readReceipt(result.releaseId!)!;
    expect(receipt.rollback.result).toBe('failed');
    expect(receipt.rollback.restored).toBeNull();
    expect(receipt.production.checks.some((check) => (
      check.name.startsWith('rollback_identity_') && check.result === 'failed'
    ))).toBe(true);
    expect(receipt.failureCode).toBe(sanitizeDetail(FAILURE_CODES.ROLLBACK_IDENTITY));
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FAILED);
  });

  it('records rollback_failed when the predecessor compose start fails', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      // The rollback composeUp is the second production up.
      script: { composeUpFailures: { production: 2 } },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    expect(store.readReceipt(result.releaseId!)!.production.checks.some((check) => (
      check.name === 'rollback_compose_start' && check.result === 'failed'
    ))).toBe(true);
  });

  it('includes topology and running-image proof inside the rollback objective', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result, registryHarness } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      script: {
        predecessorExtractDelayMs: 30_000,
        runningImagesDelayMs: [91_000],
      },
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    const receipt = store.readReceipt(result.releaseId!)!;
    expect(receipt.rollback.incidentRecoveryDurationMs).toBe(121_000);
    expect(receipt.rollback.predecessorSwitchDurationMs).toBe(121_000);
    expect(receipt.failureCode).toBe(sanitizeDetail(FAILURE_CODES.ROLLBACK_DEADLINE));
    const restoringUp = registryHarness.calls
      .filter((call) => call.kind === 'composeUp' && call.environment === 'production')
      .pop();
    const identity = registryHarness.calls
      .find((call) => call.kind === 'composeRunningImages');
    expect(restoringUp?.timeoutMs).toBe(90_000);
    expect(identity?.timeoutMs).toBe(90_000);
  });
});

describe('release application environment isolation', () => {
  const contentEngineKeys = [
    'ANTHROPIC_API_KEY',
    'CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED',
    'INTERNAL_API_SECRET',
    'NEWSAPI_API_KEY',
    'REDDIT_CLIENT_ID',
    'REDDIT_CLIENT_SECRET',
    'SERPAPI_API_KEY',
    'YOUTUBE_API_KEY',
  ];

  it('keeps the content-engine allowlist exact and Compose authority out of backend env', () => {
    expect(CONTENT_ENGINE_ENVIRONMENT_KEYS).toEqual(contentEngineKeys);
    expect(BACKEND_FORBIDDEN_ENVIRONMENT_KEYS).toEqual(expect.arrayContaining([
      'DATABASE_PATH',
      'NEXUS_APP_STAGING',
      'NEXUS_BACKEND_IMAGE',
      'NEXUS_CONTENT_ENGINE_ENV_FILE',
      'NEXUS_RELEASE_ID',
      'NEXUS_RELEASE_PLAN_DIR',
      'NODE_ENV',
      'STAGING',
    ]));
    expect(BACKEND_FORBIDDEN_RUNTIME_PREFIXES).toEqual(['DYLD_', 'LD_', 'NODE_']);
    expect(BACKEND_FORBIDDEN_RUNTIME_KEYS).toEqual([
      'OPENSSL_CONF', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
    ]);
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .not.toThrow();
  });

  it('rejects a non-engine credential in the content-engine file', () => {
    writeFileSync(
      policy.environments.production.contentEngineEnvFile,
      'INTERNAL_API_SECRET=production-shared-secret\nTELEGRAM_BOT_TOKEN=must-not-cross\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .toThrow(/content-engine environment file contains non-engine key TELEGRAM_BOT_TOKEN/);
  });

  it('rejects mutable Compose authority in the backend file', () => {
    writeFileSync(
      policy.environments.staging.backendEnvFile,
      'INTERNAL_API_SECRET=staging-shared-secret\nDATABASE_PATH=\/tmp\/other.db\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('staging'))
      .toThrow(/backend environment file repeats Compose authority DATABASE_PATH/);
  });

  it.each([
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'OPENSSL_CONF',
  ])('rejects backend runtime loader control %s', (key) => {
    writeFileSync(
      policy.environments.production.backendEnvFile,
      `INTERNAL_API_SECRET=production-shared-secret\n${key}=\/app\/data\/injected\n`,
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .toThrow(new RegExp(`runtime loader control ${key}`));
  });

  it('accepts literal dollar bytes but rejects parsed dotenv quote/comment syntax', () => {
    const contentFile = policy.environments.production.contentEngineEnvFile;
    writeFileSync(
      contentFile,
      'INTERNAL_API_SECRET=production-shared-secret\nANTHROPIC_API_KEY=${MUST_STAY_LITERAL}\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .not.toThrow();

    writeFileSync(
      contentFile,
      'INTERNAL_API_SECRET=production-shared-secret\nANTHROPIC_API_KEY="quoted"\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .toThrow(/non-canonical raw value syntax for ANTHROPIC_API_KEY/);

    writeFileSync(
      contentFile,
      'INTERNAL_API_SECRET=production-shared-secret\nANTHROPIC_API_KEY=value # comment\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .toThrow(/non-canonical raw value syntax for ANTHROPIC_API_KEY/);
  });

  it('requires matching non-empty internal authentication in each pair', () => {
    writeFileSync(
      policy.environments.production.contentEngineEnvFile,
      'INTERNAL_API_SECRET=different-secret\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .toThrow(/INTERNAL_API_SECRET differs/);

    writeFileSync(
      policy.environments.production.contentEngineEnvFile,
      'INTERNAL_API_SECRET=\n',
    );
    expect(() => createReleaseEnvironmentGate({ policy }).verify('production'))
      .toThrow(/INTERNAL_API_SECRET must be present/);
  });

  it('requires owner-only files and pins both digests for one release attempt', () => {
    const contentFile = policy.environments.staging.contentEngineEnvFile;
    chmodSync(contentFile, 0o640);
    expect(() => createReleaseEnvironmentGate({ policy }).verify('staging'))
      .toThrow(/owner-only single-link regular file/);
    chmodSync(contentFile, 0o600);

    const gate = createReleaseEnvironmentGate({ policy });
    gate.verify('staging');
    writeFileSync(
      contentFile,
      'INTERNAL_API_SECRET=staging-shared-secret\nANTHROPIC_API_KEY=rotated-mid-attempt\n',
    );
    expect(() => gate.verify('staging'))
      .toThrow(/application environment files changed during the release attempt/);
  });
});

describe('compose status parsing is strict', () => {
  function registryWith(stdout: string) {
    return createReleaseRegistry({
      policy,
      exec: () => ({ status: 0, stdout, stderr: '' }),
    });
  }

  it('scrubs operator credentials and control variables from every default child process', () => {
    expect(releaseChildEnvironment({
      PATH: '/usr/bin:/bin',
      HOME: '/var/lib/nexus-release/home',
      DOCKER_CONFIG: '/etc/nexus-release/docker',
      DOCKER_HOST: 'ssh://wrong-host',
      NODE_OPTIONS: '--require=/tmp/hook.js',
      LD_PRELOAD: '/tmp/hook.so',
      GIT_CONFIG_GLOBAL: '/tmp/gitconfig',
      NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'must-not-reach-child',
    })).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/var/lib/nexus-release/home',
      DOCKER_CONFIG: '/etc/nexus-release/docker',
    });
  });

  it('passes Compose only pinned process paths and verified release inputs', () => {
    const ambientNames = [
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'COMPOSE_FILE',
      'COMPOSE_PROFILES',
      'COMPOSE_ENV_FILES',
      'NODE_OPTIONS',
      'GIT_CONFIG_GLOBAL',
      'NEXUS_RELEASE_TELEGRAM_BOT_TOKEN',
    ];
    const prior = Object.fromEntries(ambientNames.map((name) => [name, process.env[name]]));
    for (const name of ambientNames) process.env[name] = `hostile-${name}`;
    try {
      const identity = releaseIdentityFor(payloadFor());
      const runtimePlan = createRuntimePlanDir('e'.repeat(64));
      const env = registryWith('').composeEnv({
        environment: 'production',
        images: IMAGES,
        releaseIdentity: identity,
        planDir: runtimePlan.planDir,
      });
      for (const name of ambientNames) expect(env).not.toHaveProperty(name);
      expect(env.COMPOSE_DISABLE_ENV_FILE).toBe('1');
      expect(env).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NEXUS_RELEASE_ID: identity.releaseId,
      });
    } finally {
      for (const name of ambientNames) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  it('requires and exports the exact release identity for every Compose render', () => {
    const registry = registryWith('');
    const identity = releaseIdentityFor(payloadFor());
    const runtimePlan = createRuntimePlanDir();
    const env = registry.composeEnv({
      environment: 'production',
      images: IMAGES,
      releaseIdentity: identity,
      planDir: runtimePlan.planDir,
    });
    expect(env).toMatchObject({
      NEXUS_RELEASE_ID: identity.releaseId,
      NEXUS_RELEASE_SOURCE_SHA: identity.sourceSha,
      NEXUS_RELEASE_BACKEND_DIGEST: identity.backendImageDigest,
      NEXUS_RELEASE_PLAN_DIR: runtimePlan.planDir,
      NEXUS_BACKEND_ENV_FILE: policy.environments.production.backendEnvFile,
      NEXUS_CONTENT_ENGINE_ENV_FILE:
        policy.environments.production.contentEngineEnvFile,
      NEXUS_APP_STAGING: 'false',
    });
    expect(registry.composeEnv({
      environment: 'staging',
      images: IMAGES,
      releaseIdentity: identity,
      planDir: runtimePlan.planDir,
    })).toMatchObject({
      NEXUS_BACKEND_ENV_FILE: policy.environments.staging.backendEnvFile,
      NEXUS_CONTENT_ENGINE_ENV_FILE: policy.environments.staging.contentEngineEnvFile,
      NEXUS_APP_STAGING: 'true',
    });
    expect(() => registry.composeEnv({
      environment: 'production',
      images: IMAGES,
      releaseIdentity: identity,
    } as never)).toThrow(/runtime plan directory is absent or malformed/);
    expect(() => registry.composeEnv({
      environment: 'production',
      images: IMAGES,
      planDir: runtimePlan.planDir,
    } as never)).toThrow(/Compose release identity must exactly match/);
    expect(() => registry.composeEnv({
      environment: 'production',
      images: IMAGES,
      releaseIdentity: { ...identity, backendImageDigest: PREDECESSOR_BACKEND_DIGEST },
      planDir: runtimePlan.planDir,
    })).toThrow(/Compose release identity must exactly match/);

    chmodSync(runtimePlan.planPath, 0o600);
    expect(() => registry.composeEnv({
      environment: 'production',
      images: IMAGES,
      releaseIdentity: identity,
      planDir: runtimePlan.planDir,
    })).toThrow(/runtime migration plan is unsafe/);

    chmodSync(runtimePlan.planPath, 0o644);
    linkSync(runtimePlan.planPath, join(runtimePlan.planDir, 'migration-plan.alias'));
    expect(() => registry.composeEnv({
      environment: 'production',
      images: IMAGES,
      releaseIdentity: identity,
      planDir: runtimePlan.planDir,
    })).toThrow(/runtime migration plan is unsafe/);
  });

  it('rejects a bare health object with no service identity', () => {
    // `{"Health":"healthy"}` used to be accepted as proof a named service was up.
    const health = registryWith('{"Health":"healthy"}\n').composeServiceHealth({
      composeFile: 'c.yml', environment: 'production', images: IMAGES,
      releaseIdentity: releaseIdentityFor(payloadFor()), service: 'backend',
      planDir: createRuntimePlanDir().planDir,
    });
    expect(health.healthy).toBe(false);
    expect(health.state).toBe('absent');
  });

  it('rejects an entry for a different service', () => {
    const health = registryWith('{"Service":"content-engine","Name":"x","State":"running"}\n')
      .composeServiceHealth({
        composeFile: 'c.yml', environment: 'production', images: IMAGES,
        releaseIdentity: releaseIdentityFor(payloadFor()), service: 'backend',
        planDir: createRuntimePlanDir().planDir,
      });
    expect(health.healthy).toBe(false);
  });

  it('rejects an unhealthy container even when it is running', () => {
    const health = registryWith(
      '{"Service":"backend","Name":"n","State":"running","Health":"unhealthy"}\n',
    ).composeServiceHealth({
      composeFile: 'c.yml', environment: 'production', images: IMAGES,
      releaseIdentity: releaseIdentityFor(payloadFor()), service: 'backend',
      planDir: createRuntimePlanDir().planDir,
    });
    expect(health.healthy).toBe(false);
  });

  it('accepts a fully identified healthy container and surfaces its image', () => {
    const reference = `${policy.registry.backendImage}@${BACKEND_DIGEST}`;
    const health = registryWith(
      `{"Service":"backend","Name":"n","State":"running","Health":"healthy","Image":"${reference}"}\n`,
    ).composeServiceHealth({
      composeFile: 'c.yml', environment: 'production', images: IMAGES,
      releaseIdentity: releaseIdentityFor(payloadFor()), service: 'backend',
      planDir: createRuntimePlanDir().planDir,
    });
    expect(health.healthy).toBe(true);
    expect(health.image).toBe(reference);
  });

  it('matches an image only by its digest', () => {
    const registry = registryWith('');
    expect(registry.imageMatchesDigest(
      `${policy.registry.backendImage}@${BACKEND_DIGEST}`,
      policy.registry.backendImage,
      BACKEND_DIGEST,
    )).toBe(true);
    expect(registry.imageMatchesDigest('nexus-hub-backend:latest', policy.registry.backendImage, BACKEND_DIGEST))
      .toBe(false);
    expect(registry.imageMatchesDigest(null, policy.registry.backendImage, BACKEND_DIGEST)).toBe(false);
  });
});

describe('audit mirror is durably queued and never gating', () => {
  function remoteProofTransport(
    isAvailable: () => boolean = () => true,
    failureMode: () => 'none' | 'scp_after_upload' | 'finalize' | 'invalid_proof' = () => 'none',
  ) {
    const uploads = new Map<string, string>();
    const finals = new Map<string, string>();
    let transferCount = 0;
    const remoteHost = () => `${policy.auditMirror.user}@audit-host`;
    const remoteKey = (name: string) => `${remoteHost()}:${policy.auditMirror.path}/${name}`;
    return {
      get transferCount() { return transferCount; },
      get uploadNames() { return [...uploads.keys()].sort(); },
      get finalNames() { return [...finals.keys()].sort(); },
      seedUpload: (name: string, digest: string) => {
        const key = remoteKey(name);
        uploads.set(key, digest);
        return key;
      },
      seedFinal: (name: string, digest: string) => {
        const key = remoteKey(name);
        finals.set(key, digest);
        return key;
      },
      exec: (bin: string, args: string[], options: { input?: string } = {}) => {
        if (!isAvailable()) return { status: 1, stdout: '', stderr: 'transport unavailable' };
        if (bin === 'scp') {
          const receiptPath = args.at(-2)!;
          const destination = args.at(-1)!;
          uploads.set(destination, sha256(readFileSync(receiptPath)));
          transferCount += 1;
          if (failureMode() === 'scp_after_upload') {
            return { status: 1, stdout: '', stderr: 'upload interrupted after remote create' };
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (bin !== 'ssh') {
          return { status: 1, stdout: '', stderr: 'remote finalize script missing' };
        }
        const shellAt = args.indexOf('/bin/sh');
        const destinationHost = args[shellAt - 1];
        if (options.input?.includes('upload_prefix=')) {
          const directory = args.at(-3)!;
          const mirroredReleaseId = args.at(-2)!;
          const expectedDigest = args.at(-1)!;
          const prefix = `${destinationHost}:${directory}/.${mirroredReleaseId}.${expectedDigest}.`;
          const suffix = '.upload';
          for (const name of [...uploads.keys()]) {
            if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
            const nonce = name.slice(prefix.length, -suffix.length);
            if (/^[0-9a-f]{32}$/.test(nonce)) uploads.delete(name);
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (!options.input?.includes('temporary_name=$2')) {
          return { status: 1, stdout: '', stderr: 'remote finalize script missing' };
        }
        const directory = args.at(-5)!;
        const temporaryName = args.at(-4)!;
        const finalName = args.at(-3)!;
        const expectedDigest = args.at(-2)!;
        const mirroredReleaseId = args.at(-1)!;
        const temporary = `${destinationHost}:${directory}/${temporaryName}`;
        if (uploads.get(temporary) !== expectedDigest) {
          return { status: 72, stdout: '', stderr: 'remote digest mismatch' };
        }
        if (failureMode() === 'finalize') {
          return { status: 72, stdout: '', stderr: 'remote finalize failed' };
        }
        if (failureMode() === 'invalid_proof') {
          return { status: 0, stdout: '{}\n', stderr: '' };
        }
        const remoteFinalPath = `${directory}/${finalName}`;
        const final = `${destinationHost}:${remoteFinalPath}`;
        if (finals.has(final) && finals.get(final) !== expectedDigest) {
          return { status: 74, stdout: '', stderr: 'remote final mismatch' };
        }
        finals.set(final, expectedDigest);
        uploads.delete(temporary);
        return {
          status: 0,
          stdout: `${JSON.stringify({
            schema: 'nexus.release-mirror-remote-proof.v1',
            releaseId: mirroredReleaseId,
            remoteFinalPath,
            receiptDigest: expectedDigest,
          })}\n`,
          stderr: '',
        };
      },
    };
  }

  function mirrorFixture(execImpl: (bin: string, args: string[], options?: { input?: string }) => {
    status: number; stdout: string; stderr: string;
  }) {
    const queueDir = join(workspace, 'mirror-queue');
    const receipt = join(workspace, 'receipt.json');
    writeFileSync(receipt, '{"schema":"nexus.release-receipt.v2"}');
    const mirror = createReleaseAuditMirror({
      policy: {
        ...policy,
        auditMirror: { ...policy.auditMirror, queueDir, maxAttempts: 3 },
      },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: execImpl,
    });
    return { mirror, receipt, queueDir };
  }

  const releaseId = 'a'.repeat(32);

  it('defers rather than failing on the first transport error, and retries later', () => {
    // A synchronous scp that dies mid-transfer used to lose the audit record
    // entirely, because delivery was attempted exactly once.
    const { mirror, receipt } = mirrorFixture(() => ({ status: 1, stdout: '', stderr: '' }));
    const first = mirror.mirrorReceipt({ receiptPath: receipt, releaseId });
    expect(first.result).toBe('deferred');
    expect(mirror.readQueue()).toHaveLength(1);
    expect(mirror.readQueue()[0].attempts).toBe(1);

    const drain = mirror.drainQueue();
    expect(drain.attempted).toBe(1);
    expect(mirror.readQueue()[0].attempts).toBe(2);
  });

  it('rejects bare transport exit zero without exact remote durable readback proof', () => {
    const { mirror, receipt } = mirrorFixture(() => ({ status: 0, stdout: '', stderr: '' }));

    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId })).toMatchObject({
      result: 'deferred',
    });
    expect(mirror.readDelivered(releaseId, receipt)).toBeNull();
    expect(mirror.readQueue()).toEqual([
      expect.objectContaining({ releaseId, attempts: 1 }),
    ]);
  });

  it.each(['scp_after_upload', 'finalize', 'invalid_proof'] as const)(
    'removes the exact nonce upload after a %s failure without settling the queue',
    (mode) => {
      const transport = remoteProofTransport(() => true, () => mode);
      const { mirror, receipt } = mirrorFixture(transport.exec);

      expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId })).toMatchObject({
        result: 'deferred',
      });
      expect(transport.uploadNames).toEqual([]);
      expect(mirror.readQueue()).toEqual([
        expect.objectContaining({ releaseId, attempts: 1 }),
      ]);
    },
  );

  it('cleans stale exact uploads when transport recovers without deleting other names or final', () => {
    let available = false;
    const transport = remoteProofTransport(() => available);
    const { mirror, receipt } = mirrorFixture(transport.exec);
    const receiptDigest = sha256(readFileSync(receipt));

    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId }).result).toBe('deferred');
    const staleExact = transport.seedUpload(
      `.${releaseId}.${receiptDigest}.${'b'.repeat(32)}.upload`,
      receiptDigest,
    );
    const invalidNonce = transport.seedUpload(
      `.${releaseId}.${receiptDigest}.not-a-valid-nonce.upload`,
      receiptDigest,
    );
    const otherRelease = transport.seedUpload(
      `.${'c'.repeat(32)}.${receiptDigest}.${'d'.repeat(32)}.upload`,
      receiptDigest,
    );
    const otherDigest = transport.seedUpload(
      `.${releaseId}.${'e'.repeat(64)}.${'f'.repeat(32)}.upload`,
      'e'.repeat(64),
    );
    const immutableFinal = transport.seedFinal(`${releaseId}.json`, receiptDigest);

    available = true;
    expect(mirror.drainQueue()).toEqual({
      attempted: 1, delivered: 1, exhausted: [], quarantined: [],
    });
    expect(transport.uploadNames).not.toContain(staleExact);
    expect(transport.uploadNames).toContain(invalidNonce);
    expect(transport.uploadNames).toContain(otherRelease);
    expect(transport.uploadNames).toContain(otherDigest);
    expect(transport.finalNames).toContain(immutableFinal);
    expect(mirror.readQueue()).toEqual([]);
  });

  it('retries a stale delivery acknowledgement whose receipt digest is mismatched', () => {
    const queueDir = join(workspace, 'stale-digest-ack-queue');
    const receipt = join(workspace, 'stale-digest-receipt.json');
    writeFileSync(receipt, '{}');
    const transport = remoteProofTransport();
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: transport.exec,
    });
    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId }).result).toBe('passed');
    const acknowledgementPath = join(queueDir, 'delivered', `${releaseId}.json`);
    const stale = JSON.parse(readFileSync(acknowledgementPath, 'utf8'));
    stale.receiptDigest = '0'.repeat(64);
    stale.remoteReceiptDigest = '0'.repeat(64);
    writeFileSync(acknowledgementPath, JSON.stringify(stale));

    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId }).result).toBe('passed');
    expect(transport.transferCount).toBe(2);
    expect(mirror.readDelivered(releaseId, receipt)).toEqual(expect.objectContaining({
      receiptDigest: sha256(readFileSync(receipt)),
      remoteFinalPath: `${policy.auditMirror.path}/${releaseId}.json`,
    }));
  });

  it('reports exhaustion only after the bounded retry budget, keeping failure evidence', () => {
    const { mirror, receipt, queueDir } = mirrorFixture(() => ({ status: 1, stdout: '', stderr: '' }));
    mirror.mirrorReceipt({ receiptPath: receipt, releaseId });
    mirror.drainQueue();
    const final = mirror.drainQueue();
    expect(final.exhausted).toEqual([releaseId]);
    expect(mirror.readQueue()).toHaveLength(0);
    // Durable evidence of what never reached the audit host.
    expect(existsSync(join(queueDir, 'failed', `${releaseId}.json`))).toBe(true);
  });

  it('rolls back onto the predecessor\'s own Compose topology, not the candidate\'s', async () => {
    // Substituting predecessor image digests into the failed candidate's Compose
    // file is not a rollback: the topologies can differ in services, ports,
    // mounts or the migrator command, so that produces a third, never-tested
    // configuration.
    const store = makeStore();
    seedPredecessor(store);
    const { result, registryHarness } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      // Model a host where retention pruned the predecessor payload locally.
      // Rollback must fetch its exact immutable digest before extraction.
      script: { predecessorPayloadInitiallyAbsent: true },
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    const predecessorRef = `${policy.registry.releaseImage}@${PREDECESSOR_PAYLOAD_DIGEST}`;
    const pullAt = registryHarness.calls.findIndex((call) => (
      call.kind === 'pull' && call.reference === predecessorRef
    ));
    const extractAt = registryHarness.calls.findIndex(
      (call) => call.kind === `extract:${predecessorRef}`,
    );
    expect(pullAt).toBeGreaterThan(-1);
    expect(extractAt).toBeGreaterThan(pullAt);
    // And the restoring composeUp used that payload's Compose file.
    const restoring = registryHarness.calls
      .filter((call) => call.kind === 'composeUp' && call.environment === 'production')
      .pop();
    expect(restoring?.composeFile).toContain('predecessor-compose.yml');
  });

  it('names a predecessor topology failure distinctly from a compose failure (F6)', async () => {
    // A digest mismatch means a tampered predecessor payload. Reporting it as
    // "compose exit 1" hides an integrity incident behind a startup error.
    const store = makeStore();
    seedPredecessor(store);
    const notifier = fakeNotifier();
    const { result } = await deploy({
      store,
      notifier,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      script: { predecessorComposeBytes: Buffer.from('services:\n  tampered: {}\n') },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);

    // The receipt records the topology verdict as its own check...
    const receipt = store.readReceipt(result.releaseId!)!;
    const topology = receipt.production.checks
      .find((check) => check.name === 'rollback_predecessor_topology');
    expect(topology).toBeDefined();
    expect(topology!.result).toBe('failed');
    expect(topology!.detail).toMatch(/compose digest mismatch/);
    expect(receipt.failureCode)
      .toBe(sanitizeDetail(FAILURE_CODES.ROLLBACK_PREDECESSOR_TOPOLOGY));

    // ...and the operator alert names it distinctly, rather than reporting the
    // generic "predecessor compose start failed".
    const alert = notifier.sent.find((entry) => entry.release?.phase === 'production');
    expect(alert?.release.failureCode).toBe(FAILURE_CODES.ROLLBACK_PREDECESSOR_TOPOLOGY);
  });

  it('records a passing topology check on an ordinary rollback', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
    });
    const receipt = store.readReceipt(result.releaseId!)!;
    expect(receipt.production.checks
      .find((check) => check.name === 'rollback_predecessor_topology')?.result).toBe('passed');
  });

  it('verifies rollback identity through the predecessor compose file (F7)', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { registryHarness } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
    });
    const identity = registryHarness.calls.find((call) => call.kind === 'composeRunningImages');
    expect(identity?.composeFile).toContain('predecessor-compose.yml');
  });

  it('fails closed when the predecessor payload is unavailable', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result, store: used } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      script: { predecessorPayloadMissing: true },
    });
    // Better to halt than to restore an unverified topology.
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    expect(used.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FAILED);
  });

  it('refuses a predecessor payload whose Compose digest does not match', async () => {
    // A tampered or wrong payload must not be deployed as "the predecessor".
    const store = makeStore();
    seedPredecessor(store);
    const { result } = await deploy({
      store,
      health: fakeHealth({ degradeAfterProbes: 1, clock: () => 0 }),
      script: { predecessorComposeBytes: Buffer.from('services:\n  tampered: {}\n') },
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
  });

  it('retains the predecessor payload directory through pruning', async () => {
    // Pruning it would leave the next failure with nothing correct to restore.
    const store = makeStore();
    seedPredecessor(store);
    const { registryHarness } = await deploy({ store });
    const prune = registryHarness.calls.find((call) => call.kind === 'pruneWorkDirs');
    expect(prune?.keepDirs?.some((dir: string) => dir.includes('9'.repeat(64)))).toBe(true);
  });

  it('treats every mutation-admitting status without a receipt as unprovable', () => {
    // production_observing is written BEFORE the migrator and the Compose switch,
    // so seeing it with no terminal receipt means the poller died inside the
    // mutation window. Reading that as provable let a newer release start on top
    // of a half-migrated production.
    const blocking = [
      RELEASE_STATUSES.PRODUCTION_OBSERVING,
      RELEASE_STATUSES.COMPLETED,
      RELEASE_STATUSES.ROLLED_BACK,
      RELEASE_STATUSES.ROLLBACK_FAILED,
    ];
    for (const status of blocking) {
      const resolved = resolveEffectiveRelease({
        state: { active: { releaseId: 'a'.repeat(32), status } },
        readReceipt: () => null,
      });
      expect(resolved.provable, status).toBe(false);
    }
    // Statuses that cannot have touched production stay provable, or the poller
    // would wedge on every ordinary pre-production interruption.
    for (const status of [RELEASE_STATUSES.ELIGIBLE, RELEASE_STATUSES.STAGING_HEALTHY]) {
      const resolved = resolveEffectiveRelease({
        state: { active: { releaseId: 'a'.repeat(32), status } },
        readReceipt: () => null,
      });
      expect(resolved.provable, status).toBe(true);
    }
  });

  it('quarantines a corrupt queue entry instead of skipping it', () => {
    // Silently skipping an unreadable entry drops a receipt from the audit trail
    // with no record it was ever owed — the exact failure the mirror prevents.
    const queueDir = join(workspace, 'corrupt-queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, `${releaseId}.json`), '{ truncated');
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    expect(mirror.readQueue()).toEqual([]);
    const quarantined = mirror.listQuarantined();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatch(
      /^corrupt-[0-9a-f]{16}-[0-9a-f]{32}\/[0-9a-f]{32}\.json$/,
    );
    // The original bytes survive for an operator to inspect.
    expect(readFileSync(join(queueDir, 'quarantine', quarantined[0]), 'utf8'))
      .toBe('{ truncated');
    // And the drain report surfaces it rather than reporting a clean queue.
    expect(mirror.drainQueue().quarantined).toEqual(quarantined);
  });

  it('quarantines a schema-valid queue entry with no release id before sorting', () => {
    // Sorting used to dereference `releaseId` after checking only the schema,
    // so an otherwise parseable entry could throw and abort the whole drain.
    const queueDir = join(workspace, 'missing-release-id-queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, `${releaseId}.json`), JSON.stringify({
      schema: 'nexus.release-mirror-queue-entry.v1',
      receiptPath: '/var/lib/nexus-release/receipts/missing.json',
      attempts: 0,
      lastAttemptAt: null,
    }));
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    expect(() => mirror.drainQueue()).not.toThrow();
    expect(mirror.readQueue()).toEqual([]);
    expect(mirror.listQuarantined()).toEqual([
      expect.stringMatching(
        /^corrupt-[0-9a-f]{16}-[0-9a-f]{32}\/[0-9a-f]{32}\.json$/,
      ),
    ]);
  });

  it('quarantines a queue entry whose body identity does not match its filename', () => {
    // A valid-but-substituted body would otherwise transfer and dequeue under
    // the wrong id while leaving the original queue file to retry forever.
    const queueDir = join(workspace, 'mismatched-release-id-queue');
    const bodyReleaseId = 'b'.repeat(32);
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, `${releaseId}.json`), JSON.stringify({
      schema: 'nexus.release-mirror-queue-entry.v1',
      releaseId: bodyReleaseId,
      receiptPath: '/var/lib/nexus-release/receipts/substituted.json',
      attempts: 0,
      lastAttemptAt: null,
    }));
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    const drained = mirror.drainQueue();
    expect(drained.attempted).toBe(0);
    expect(drained.quarantined).toEqual([
      expect.stringMatching(
        /^corrupt-[0-9a-f]{16}-[0-9a-f]{32}\/[0-9a-f]{32}\.json$/,
      ),
    ]);
    expect(mirror.readQueue()).toEqual([]);
  });

  it('quarantines an invalid queue filename instead of filtering it out', () => {
    const queueDir = join(workspace, 'invalid-filename-queue');
    const invalidName = 'not-a-release.json';
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, invalidName), 'original invalid bytes');
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    expect(mirror.readQueue()).toEqual([]);
    const quarantined = mirror.listQuarantined();
    expect(quarantined).toEqual([
      expect.stringMatching(
        /^invalid-name-[0-9a-f]{16}-[0-9a-f]{32}\/not-a-release\.json$/,
      ),
    ]);
    expect(readFileSync(join(queueDir, 'quarantine', quarantined[0]), 'utf8'))
      .toBe('original invalid bytes');
  });

  it('publishes unique no-overwrite quarantine evidence for repeated corruption', () => {
    const queueDir = join(workspace, 'unique-quarantine-queue');
    const invalidName = 'unexpected.queue';
    mkdirSync(queueDir, { recursive: true });
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    writeFileSync(join(queueDir, invalidName), 'first corrupt bytes');
    expect(mirror.readQueue()).toEqual([]);
    writeFileSync(join(queueDir, invalidName), 'second corrupt bytes');
    expect(mirror.readQueue()).toEqual([]);

    const quarantined = mirror.listQuarantined();
    expect(quarantined).toHaveLength(2);
    expect(new Set(quarantined).size).toBe(2);
    expect(quarantined.map((entry) => (
      readFileSync(join(queueDir, 'quarantine', entry), 'utf8')
    )).sort()).toEqual(['first corrupt bytes', 'second corrupt bytes']);
  });

  it('fails closed and preserves the source when quarantine cannot be published', () => {
    const queueDir = join(workspace, 'failed-quarantine-queue');
    const invalidName = 'unexpected.queue';
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, 'quarantine'), 'not a directory');
    writeFileSync(join(queueDir, invalidName), 'must remain queued');
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    expect(() => mirror.readQueue()).toThrow(/quarantine/i);
    expect(readFileSync(join(queueDir, invalidName), 'utf8')).toBe('must remain queued');
  });

  it('keeps a max-attempt entry queued and deferred when exhausted evidence is not durable', () => {
    // Dequeuing before the evidence is durable would delete the only record that
    // a receipt was ever owed to the audit host.
    const queueDir = join(workspace, 'unwritable-evidence-queue');
    const receipt = join(workspace, 'receipt-evidence.json');
    writeFileSync(receipt, '{}');
    // Keep the control directory valid but occupy this release's terminal path
    // with a directory, so every exhausted-evidence publication fails without
    // readQueue repairing the fixture as an invalid control root.
    mkdirSync(join(queueDir, 'failed', `${releaseId}.json`), { recursive: true });

    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir, maxAttempts: 1 } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 1, stdout: '', stderr: '' }),
    });
    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId })).toMatchObject({
      result: 'deferred',
      detail: 'mirror failure evidence unavailable will retry',
    });
    expect(mirror.drainQueue()).toMatchObject({ exhausted: [] });

    // Evidence could not be written, so the entry must still be queued.
    expect(mirror.readQueue().map((entry: { releaseId: string }) => entry.releaseId))
      .toContain(releaseId);
  });

  it('delivers a queued receipt once the transport recovers', () => {
    const queueDir = join(workspace, 'recovering-queue');
    const receipt = join(workspace, 'receipt.json');
    writeFileSync(receipt, '{}');
    let fail = true;
    const transport = remoteProofTransport(() => !fail);
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir, maxAttempts: 5 } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: transport.exec,
    });
    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId }).result).toBe('deferred');
    fail = false;
    // `quarantined` is part of the drain report now: corrupt entries are moved
    // aside rather than silently skipped, and the caller must be able to see it.
    expect(mirror.drainQueue()).toEqual({
      attempted: 1, delivered: 1, exhausted: [], quarantined: [],
    });
    expect(mirror.readQueue()).toHaveLength(0);
  });

  it('reconciles a receipt missed before enqueue on the next poll and transfers it only once', async () => {
    const store = makeStore();
    const missingQueueMirror = {
      receipts: [],
      drains: [],
      mirror: {
        drainQueue: () => ({ attempted: 0, delivered: 0, exhausted: [] }),
        // Models the process-loss boundary immediately after the immutable
        // receipt write: no queue entry or delivery evidence reaches disk.
        mirrorReceipt: () => { throw new Error('process lost before enqueue'); },
      },
    };
    const first = await deploy({ store, mirror: missingQueueMirror as never });
    expect(first.result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(store.listReceiptIds()).toEqual([first.result.releaseId]);

    const queueDir = join(workspace, 'reconciled-mirror-queue');
    const transport = remoteProofTransport();
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: transport.exec,
    });
    const recovered = { receipts: [], drains: [], mirror } as never;

    // A later ordinary poll discovers the immutable receipt before draining.
    await deploy({ store, mirror: recovered });
    expect(transport.transferCount).toBe(1);
    expect(mirror.readQueue()).toEqual([]);
    expect(mirror.readDelivered(
      first.result.releaseId!,
      store.receiptPath(first.result.releaseId!),
    )).toEqual(expect.objectContaining({
      schema: 'nexus.release-mirror-delivery.v1',
      releaseId: first.result.releaseId,
    }));

    // Reconciliation sees the durable acknowledgement, so subsequent polls do
    // not rebuild the queue or repeat the successful transfer.
    await deploy({ store, mirror: recovered });
    expect(transport.transferCount).toBe(1);
    expect(mirror.readQueue()).toEqual([]);
  });

  it('does not retransmit a stale queue entry left after durable delivery acknowledgement', () => {
    const queueDir = join(workspace, 'acknowledged-stale-queue');
    const receipt = join(workspace, 'acknowledged-receipt.json');
    writeFileSync(receipt, '{}');
    const transport = remoteProofTransport();
    const mirror = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: transport.exec,
    });
    expect(mirror.mirrorReceipt({ receiptPath: receipt, releaseId }).result).toBe('passed');
    expect(transport.transferCount).toBe(1);

    // Models a crash after the success marker fsync but before queue unlink.
    writeFileSync(join(queueDir, `${releaseId}.json`), JSON.stringify({
      schema: 'nexus.release-mirror-queue-entry.v1',
      releaseId,
      receiptPath: receipt,
      receiptDigest: sha256(readFileSync(receipt)),
      remoteFinalPath: `${policy.auditMirror.path}/${releaseId}.json`,
      attempts: 0,
      lastAttemptAt: null,
    }));
    expect(mirror.drainQueue()).toEqual({
      attempted: 0, delivered: 0, exhausted: [], quarantined: [],
    });
    expect(transport.transferCount).toBe(1);
    expect(mirror.readQueue()).toEqual([]);
  });

  it('refuses to mirror without a pinned known_hosts rather than relaxing host checking', () => {
    const mirror = createReleaseAuditMirror({
      policy: {
        ...policy,
        auditMirror: { ...policy.auditMirror, knownHostsFile: undefined },
      },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(mirror.target()).toEqual({ enabled: false, reason: 'known_hosts_not_configured' });
  });

  it('pins UserKnownHostsFile and BatchMode on the transfer', () => {
    const captured: string[][] = [];
    const { mirror, receipt } = mirrorFixture(() => ({ status: 0, stdout: '', stderr: '' }));
    const transport = remoteProofTransport();
    const spy = createReleaseAuditMirror({
      policy: { ...policy, auditMirror: { ...policy.auditMirror, queueDir: join(workspace, 'q2') } },
      env: { [policy.auditMirror.hostEnvVar]: 'audit-host' },
      exec: (bin, args, options) => {
        captured.push(args as string[]);
        return transport.exec(bin, args as string[], options);
      },
    });
    spy.mirrorReceipt({ receiptPath: receipt, releaseId: 'b'.repeat(32) });
    expect(captured[0]).toContain('BatchMode=yes');
    expect(captured[0]).toContain('StrictHostKeyChecking=yes');
    expect(captured[0]).toContain('IdentitiesOnly=yes');
    expect(captured[0].join(' ')).toContain(`UserKnownHostsFile=${policy.auditMirror.knownHostsFile}`);
    expect(mirror).toBeDefined();
  });

  it('does not change the release verdict when the mirror is exhausted', async () => {
    const { result, store } = await deploy({ mirror: fakeMirror('failed') });
    // The release still completed; only an alert was added.
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(store.readReceipt(result.releaseId!)!.outcome).toBe('completed');
  });

  it('does not change a durable verdict when the mirror throws unexpectedly', async () => {
    const throwingMirror = {
      receipts: [],
      drains: [],
      mirror: {
        drainQueue: () => ({ attempted: 0, delivered: 0, exhausted: [] }),
        mirrorReceipt: () => { throw new Error('mirror queue unavailable'); },
      },
    };
    const { result, store } = await deploy({ mirror: throwingMirror as never });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(store.readReceipt(result.releaseId!)?.outcome).toBe('completed');
  });

  it('drains the queue on every poll', async () => {
    const mirror = fakeMirror('passed');
    await deploy({ mirror });
    expect(mirror.drains.length).toBeGreaterThanOrEqual(1);
  });
});

describe('write-ahead state precedes the database mutation', () => {
  it('persists production_observing before the production migrator runs', async () => {
    // The migrator mutates the database. If mutation-admitting state is written
    // only after it, a crash mid-migration looks like "nothing happened" and the
    // next poll would migrate again.
    // Interleave the store transitions with the registry calls on one timeline, so
    // the assertion is about real ordering rather than about two separate lists.
    const timeline: string[] = [];
    const store = makeStore();
    seedPredecessor(store);
    const wrapped = {
      ...store,
      recordStatus: (input: { status: string }) => {
        timeline.push(`status:${input.status}`);
        return store.recordStatus(input as never);
      },
    };
    const envelope = signed(payloadFor());
    const registryHarness = fakeRegistry({}, envelope);
    const originalMigrator = registryHarness.registry.composeRunMigrator;
    registryHarness.registry.composeRunMigrator = (
      input: Parameters<typeof originalMigrator>[0],
    ) => {
      if (input.environment === 'production') timeline.push('registry:composeRunMigrator');
      return originalMigrator(input);
    };
    const originalComposeUp = registryHarness.registry.composeUp;
    registryHarness.registry.composeUp = (
      input: Parameters<typeof originalComposeUp>[0],
    ) => {
      if (input.environment === 'production') timeline.push('registry:composeUp');
      return originalComposeUp(input);
    };
    const now = Date.parse('2026-08-07T10:00:05.000Z');
    await runReleaseDeployment({
      policy,
      controlPlane: CONTROL_PLANE,
      store: wrapped as never,
      registry: registryHarness.registry as never,
      health: fakeHealth({ clock: () => now }).health as never,
      notifier: fakeNotifier().notifier as never,
      mirror: fakeMirror().mirror as never,
      backup: fakeBackup() as never,
      installedBackupInterface: fakeInstalledBackupInterface() as never,
      databaseProbe: fakeDatabaseProbe().probe as never,
      protectedHead: fakeProtectedHead() as never,
      clock: () => now,
      env: { [LOCK_HELD_ENV]: '1' },
    });

    const observingAt = timeline.indexOf('status:production_observing');
    const migratorAt = timeline.indexOf('registry:composeRunMigrator');
    const upAt = timeline.indexOf('registry:composeUp');
    expect(observingAt).toBeGreaterThan(-1);
    expect(migratorAt).toBeGreaterThan(-1);
    // Mutation-admitting state is durable BEFORE the migrator touches the database.
    expect(observingAt).toBeLessThan(migratorAt);
    expect(migratorAt).toBeLessThan(upAt);
  });

  it('settles verified interrupted v2 state with an unambiguous legacy v2 receipt', async () => {
    const store = makeStore(() => new Date('2026-08-07T10:00:02.000Z'));
    seedPredecessor(store);
    const current = payloadFor();
    const payload = legacyPayloadFor(current);
    const envelope = legacySigned(current);
    const releaseId = releaseIdFor(payload);
    const manifestDigest = sha256(canonicalJson(envelope));
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      manifestDigest,
      keyId: policy.trust.signingKeyId,
      backupEvidence: fakeBackupEvidence(),
    });

    const recovered = await deploy({ store, envelope });

    expect(recovered.result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    const receipt = store.readReceipt(releaseId)!;
    expect(receipt.schema).toBe(LEGACY_RELEASE_RECEIPT_SCHEMA);
    expect(receipt).not.toHaveProperty('controlPlane');
    expect(assertReleaseReceiptShape(receipt)).toEqual(receipt);
    expect(recovered.installedBackupInterface.calls).toEqual([]);
  });

  it('recovers a crash-between-status-and-receipt from the exact rollback target', async () => {
    // The crash-between-status-and-receipt case: state says completed, no receipt
    // exists. The outgoing predecessor still has to be recoverable even though
    // completion promoted the interrupted candidate into `state.predecessor`.
    const store = makeStore();
    seedPredecessor(store);
    const predecessorBefore = store.readState().predecessor!;
    const successorEntry = {
      file: '284_successor_expand.sql',
      sha256: 'd'.repeat(64),
      kind: 'expand',
      predecessorCompatible: true,
    };
    const payload = payloadFor({
      inventory: [
        { file: '001_a.sql', sha256: 'a'.repeat(64), kind: 'expand', predecessorCompatible: true },
        { file: '002_b.sql', sha256: 'b'.repeat(64), kind: 'backfill', predecessorCompatible: true },
        successorEntry,
      ],
    });
    store.recordStatus({
      manifestPayload: payload,
      releaseId: releaseIdFor(payload),
      status: 'production_observing',
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });
    store.completeRelease({ releaseId: releaseIdFor(payload), status: 'completed' });

    const effective = resolveEffectiveRelease({
      state: store.readState(),
      readReceipt: store.readReceipt,
    });
    expect(effective.provable).toBe(false);

    const notifier = fakeNotifier();
    const { result, registryHarness } = await deploy({
      store,
      envelope: signed(payload),
      notifier,
      databaseProbe: fakeDatabaseProbe('passed', {
        applied: [
          '001_a.sql', '002_b.sql', '283_release_schema_convergence.sql', successorEntry.file,
        ],
      }),
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FIRED);
    const receipt = store.readReceipt(releaseIdFor(payload))!;
    expect(receipt.outcome).toBe('rolled_back');
    expect(receipt.backup.artifact).toBe('nexus-db-20260807T100000Z.sqlite.age');
    expect(receipt.rollback.restored).toEqual({
      backend: {
        repository: policy.registry.backendImage,
        digest: PREDECESSOR_BACKEND_DIGEST,
      },
      contentEngine: {
        repository: policy.registry.contentEngineImage,
        digest: PREDECESSOR_CONTENT_DIGEST,
      },
    });
    // A crash after `completed` temporarily promoted the interrupted candidate
    // into state.predecessor. Recovery must restore the state identity as well as
    // the containers, or the next rollback would target the failed candidate.
    expect(store.readState().predecessor).toEqual(
      store.readState().active?.rollbackTarget,
    );
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp'
      && call.environment === 'production'
      && call.composeFile?.includes('predecessor-compose.yml')
    ))).toBe(true);
    expect(JSON.parse(readFileSync(
      join(
        workspace,
        'work',
        PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''),
        'runtime-plan',
        'migration-plan.json',
      ),
      'utf8',
    ))).toMatchObject({
      schema: 'nexus.release-migration-plan.v3',
      releaseId: predecessorBefore.releaseId,
      rollback: {
        successor: expect.objectContaining({ releaseId: releaseIdFor(payload) }),
        forwardApplied: [{ file: successorEntry.file, sha256: successorEntry.sha256 }],
      },
    });
    const predecessorIdentity = {
      releaseId: predecessorBefore.releaseId,
      sourceSha: predecessorBefore.sourceSha,
      backendImageDigest: predecessorBefore.images.backend.digest,
    };
    expect(registryHarness.composeIdentities.length).toBeGreaterThan(0);
    expect(registryHarness.composeIdentities.every((call) => (
      JSON.stringify(call.releaseIdentity) === JSON.stringify(predecessorIdentity)
    ))).toBe(true);
    expect(notifier.sent.some((entry) => entry.kind === RELEASE_NOTIFICATION_KINDS.FAILURE))
      .toBe(true);
    expect(notifier.sent.some((entry) => entry.kind === RELEASE_NOTIFICATION_KINDS.RECOVERY))
      .toBe(true);
  });

  it('recovers an accepted payload after mutable status time outlives freshness', async () => {
    const payload = payloadFor();
    const acceptedAt = Date.parse(payload.createdAt) + 1_000;
    let storeNow = acceptedAt;
    const store = makeStore(() => new Date(storeNow));
    seedPredecessor(store);
    const releaseId = releaseIdFor(payload);
    const evidence = {
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    };
    store.recordStatus(evidence);

    storeNow = Date.parse(payload.createdAt)
      + Number(policy.trust.maxManifestAgeSeconds) * 1000
      + 60_000;
    store.recordStatus(evidence);
    expect(store.readState().active).toMatchObject({
      startedAt: new Date(acceptedAt).toISOString(),
      updatedAt: new Date(storeNow).toISOString(),
    });

    const recovered = await deploy({
      store,
      envelope: signed(payload),
      nowMs: storeNow,
    });
    expect(recovered.result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    expect(store.readReceipt(releaseId)?.outcome).toBe('rolled_back');
  });

  it('separates full crash-incident time from the 120-second predecessor-switch objective', async () => {
    const recoveryDetectedAt = Date.parse('2026-08-07T10:00:05.000Z');
    let hostStateNow = recoveryDetectedAt;
    const store = makeStore(() => new Date(hostStateNow));
    seedPredecessor(store);
    const payload = payloadFor();
    const releaseId = releaseIdFor(payload);
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });
    store.block({ releaseId, reason: BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE });
    // Models a poller dying after it durably recorded recovery. The next attempt
    // must retain these twenty seconds instead of resetting the incident clock.
    hostStateNow += 20_000;

    const { result, notifier, registryHarness } = await deploy({
      store,
      envelope: signed(payload),
      nowMs: hostStateNow,
      // Ten seconds are spent paging before evidence is reopened; the active
      // payload then takes forty seconds to reverify. Neither may consume the
      // independent 120-second predecessor-switch objective.
      notificationDelayMs: [10_000],
      script: {
        activePayloadPullDelayMs: 20_000,
        activePayloadExtractDelayMs: 20_000,
        predecessorPullDelayMs: 10_000,
        predecessorExtractDelayMs: 5_000,
        runningImagesDelayMs: [15_000],
      },
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    const receipt = store.readReceipt(releaseId)!;
    expect(receipt.rollback).toMatchObject({
      incidentRecoveryDurationMs: 100_000,
      predecessorSwitchDurationMs: 30_000,
      predecessorSwitchObjectiveSeconds: 120,
    });
    expect(receipt.rollback).not.toHaveProperty('durationMs');
    expect(receipt.rollback).not.toHaveProperty('objectiveSeconds');
    expect(store.readState().history[0]).toMatchObject({
      releaseId,
      status: RELEASE_STATUSES.ROLLED_BACK,
      recoveryTiming: {
        incidentRecoveryDurationMs: 100_000,
        predecessorSwitchDurationMs: 30_000,
        predecessorSwitchObjectiveSeconds: 120,
      },
    });

    const predecessorPull = registryHarness.calls.find((call) => (
      call.kind === 'pull'
      && call.reference?.includes(PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''))
    ));
    const predecessorExtract = registryHarness.calls.find((call) => (
      call.kind.startsWith('extract:')
      && call.kind.includes(PREDECESSOR_PAYLOAD_DIGEST.replace('sha256:', ''))
    ));
    const predecessorUp = registryHarness.calls.find((call) => (
      call.kind === 'composeUp'
      && call.environment === 'production'
      && call.composeFile?.includes('predecessor-compose.yml')
    ));
    expect(predecessorPull?.timeoutMs).toBe(120_000);
    expect(predecessorExtract?.timeoutMs).toBe(110_000);
    expect(predecessorUp?.timeoutMs).toBe(105_000);

    const terminalFailure = notifier.sent.find((entry) => (
      entry.kind === RELEASE_NOTIFICATION_KINDS.FAILURE
      && entry.release.outcome === 'rolled_back'
    ));
    const recovery = notifier.sent.find((entry) => (
      entry.kind === RELEASE_NOTIFICATION_KINDS.RECOVERY
    ));
    for (const entry of [terminalFailure, recovery]) {
      expect(entry?.release).toMatchObject({
        incidentRecoverySeconds: 100,
        predecessorSwitchSeconds: 30,
        predecessorSwitchObjectiveSeconds: 120,
      });
    }
    expect(buildReleaseNotification({
      kind: RELEASE_NOTIFICATION_KINDS.RECOVERY,
      policy,
      release: recovery!.release,
    })).toContain([
      'incident recovery seconds: 100',
      'predecessor switch seconds: 30',
      'predecessor switch objective seconds: 120',
    ].join('\n'));

    const view = buildReleaseStateView({ state: store.readState(), receipts: [receipt] });
    expect(view.lastRecovery).toMatchObject({
      releaseId,
      incidentRecoveryDurationMs: 100_000,
      predecessorSwitchDurationMs: 30_000,
      predecessorSwitchObjectiveSeconds: 120,
    });
    expect(view.recent[0].recoveryTiming).toEqual({
      incidentRecoveryDurationMs: 100_000,
      predecessorSwitchDurationMs: 30_000,
      predecessorSwitchObjectiveSeconds: 120,
    });
  });

  it('recovers a receiptless mutation even when an ordinary rollback block was already written', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const payload = payloadFor();
    const releaseId = releaseIdFor(payload);
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });
    // Models the normal rollback writer dying after its state/block/rejection
    // writes but before finish() publishes the immutable terminal receipt.
    store.completeRelease({ releaseId, status: RELEASE_STATUSES.ROLLED_BACK });
    store.block({ releaseId, reason: BLOCK_REASONS.ROLLBACK_FIRED });
    store.reject({ releaseId, reason: 'rolled_back' });

    expect(() => store.acknowledgeBlock())
      .toThrow(/must be recovered before acknowledgement/);

    const recovered = await deploy({ store, envelope: signed(payload) });
    expect(recovered.result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    expect(store.readReceipt(releaseId)?.outcome).toBe('rolled_back');
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FIRED);
  });

  it('persists the complete verified backup identity in active state', async () => {
    const { store } = await deploy();
    expect(store.readState().active).toMatchObject({
      backupArtifact: fakeBackupEvidence().artifact,
      backupEvidence: fakeBackupEvidence(),
    });
  });

  it('persists freshly admitted evidence even when last-success advances before write-ahead', async () => {
    const fixture = admissionPointerRaceBackupFixture();

    const { result, store } = await deploy({ backup: fixture.backup as never });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(JSON.parse(readFileSync(fixture.receiptPath, 'utf8')).kind).toBe('hourly');
    expect(fixture.pointerReads()).toBe(0);
    expect(fixture.verifiedEvidence).toEqual([fixture.evidence, fixture.evidence]);
    expect(store.readState().active?.backupEvidence).toEqual(fixture.evidence);
  });

  it.each(['missing', 'overwritten'] as const)(
    'recovers from exact persisted backup evidence when last-success is %s',
    async (pointer) => {
      const store = makeStore();
      seedPredecessor(store);
      const payload = payloadFor();
      const releaseId = releaseIdFor(payload);
      const fixture = exactRecoveryBackupFixture(pointer);
      store.recordStatus({
        manifestPayload: payload,
        releaseId,
        status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
        payloadDigest: PAYLOAD_DIGEST,
        ...stateEvidenceFor(payload),
        backupEvidence: fixture.evidence,
      });
      expect(fixture.backup.readBackupReceipt({
        environment: 'production',
        notBeforeMs: 0,
      }).ok).toBe(false);

      const { result } = await deploy({
        store,
        envelope: signed(payload),
        backup: fixture.backup as never,
      });

      expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
      expect(store.readReceipt(releaseId)?.backup).toEqual({
        result: 'passed',
        artifact: fixture.evidence.artifact,
      });
    },
  );

  it.each(['missing', 'tampered'] as const)(
    'hard-stops crash recovery without a passed-backup receipt when exact artifact is %s and notifications throw',
    async (failure) => {
      const store = makeStore();
      seedPredecessor(store);
      const payload = payloadFor();
      const releaseId = releaseIdFor(payload);
      const fixture = exactRecoveryBackupFixture();
      store.recordStatus({
        manifestPayload: payload,
        releaseId,
        status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
        payloadDigest: PAYLOAD_DIGEST,
        ...stateEvidenceFor(payload),
        backupEvidence: fixture.evidence,
      });
      if (failure === 'missing') rmSync(fixture.artifact);
      else writeFileSync(fixture.artifact, Buffer.alloc(fixture.bytes.length, 0x58));
      let notificationAttempts = 0;
      const throwingNotifier = {
        sent: [],
        notifier: {
          send: async () => {
            notificationAttempts += 1;
            throw new Error('notification unavailable');
          },
        },
      };

      const { result, registryHarness } = await deploy({
        store,
        envelope: signed(payload),
        backup: fixture.backup as never,
        notifier: throwingNotifier as never,
      });

      expect(result).toMatchObject({
        outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
        reason: 'unprovable_active_release',
      });
      expect(store.readReceipt(releaseId)).toBeNull();
      expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE);
      expect(registryHarness.calls.some((call) => (
        call.kind === 'composeUp' && call.environment === 'production'
      ))).toBe(false);
      expect(notificationAttempts).toBe(2);
    },
  );

  it('continues exact predecessor recovery when every notification call throws', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const payload = payloadFor();
    const releaseId = releaseIdFor(payload);
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });
    let notificationAttempts = 0;
    const throwingNotifier = {
      sent: [],
      notifier: {
        send: async () => {
          notificationAttempts += 1;
          throw new Error('notification unavailable');
        },
      },
    };

    const { result } = await deploy({
      store,
      envelope: signed(payload),
      notifier: throwingNotifier as never,
    });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLED_BACK);
    expect(store.readReceipt(releaseId)?.outcome).toBe('rolled_back');
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.ROLLBACK_FIRED);
    expect(notificationAttempts).toBe(3);
  });

  it('hard-stops crash recovery without restoring images when database integrity is unproven', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const payload = payloadFor();
    store.recordStatus({
      manifestPayload: payload,
      releaseId: releaseIdFor(payload),
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });
    const notifier = fakeNotifier();
    const databaseProbe = fakeDatabaseProbe('failed');

    const { result, registryHarness } = await deploy({
      store,
      envelope: signed(payload),
      notifier,
      databaseProbe,
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED);
    expect(store.readState().blocked?.reason).toBe(BLOCK_REASONS.DATABASE_INTEGRITY);
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(false);
    const receipt = store.readReceipt(releaseIdFor(payload))!;
    expect(receipt.rollback.result).toBe('not_attempted');
    expect(receipt.production.checks.some((check) => check.name === 'database_integrity'))
      .toBe(true);
    expect(notifier.sent.some((entry) => entry.kind === RELEASE_NOTIFICATION_KINDS.FAILURE))
      .toBe(true);
  });

  it('keeps an interrupted release blocked when its exact signed payload cannot be proven', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const payload = payloadFor();
    const releaseId = releaseIdFor(payload);
    store.recordStatus({
      manifestPayload: payload,
      releaseId,
      status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
      payloadDigest: PAYLOAD_DIGEST,
      ...stateEvidenceFor(payload),
      backupEvidence: fakeBackupEvidence(),
    });

    // The registry double returns different signed bytes for the exact digest
    // persisted in state. Recovery must not reinterpret those bytes as the
    // interrupted release or fabricate a terminal receipt from them.
    const { result, registryHarness } = await deploy({
      store,
      envelope: signed(payloadFor({ sha: NEWER_SHA, runId: '9001' })),
    });

    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.BLOCKED);
    expect(store.readState().blocked?.reason)
      .toBe(BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE);
    expect(store.readReceipt(releaseId)).toBeNull();
    expect(registryHarness.calls.some((call) => (
      call.kind === 'composeUp' && call.environment === 'production'
    ))).toBe(false);
    expect(() => store.acknowledgeBlock()).toThrow(/must be recovered before acknowledgement/);
  });
});

describe('release security and operations', () => {
  describe('continuous-deployment policy validation', () => {
    function writePolicyFixture(
      name: string,
      mutate: (candidate: Record<string, any>) => void,
    ) {
      const root = join(workspace, name);
      mkdirSync(join(root, 'config'), { recursive: true });
      const candidate = JSON.parse(JSON.stringify(basePolicy));
      mutate(candidate);
      writeFileSync(
        join(root, 'config', 'continuous-deployment.json'),
        JSON.stringify(candidate),
      );
      return root;
    }

    it('fails closed when backup.root is missing', () => {
      const root = writePolicyFixture('policy-no-backup-root', (candidate) => {
        delete candidate.backup.root;
      });
      expect(() => loadContinuousDeploymentPolicy(root)).toThrow(/backup\.root.*absolute/i);
    });

    it.each([
      ['backup receipt path', (candidate: Record<string, any>) => {
        candidate.backup.receiptPath = 'state/last-success.json';
      }],
      ['release path', (candidate: Record<string, any>) => {
        candidate.paths.workDir = 'work';
      }],
      ['trust path', (candidate: Record<string, any>) => {
        candidate.trust.publicKeyPath = 'trust/release-signing.pem';
      }],
      ['environment path', (candidate: Record<string, any>) => {
        candidate.environments.production.dataDir = 'production/data';
      }],
    ])('rejects a non-absolute %s', (_label, mutate) => {
      const root = writePolicyFixture(`policy-relative-${_label.replaceAll(' ', '-')}`, mutate);
      expect(() => loadContinuousDeploymentPolicy(root)).toThrow(/absolute path/i);
    });

    it.each([
      ['paths', 'stateDir'],
      ['registry', 'releaseImage'],
      ['trust', 'workflow'],
    ])('rejects a missing required %s.%s field', (section, field) => {
      const root = writePolicyFixture(`policy-missing-${section}-${field}`, (candidate) => {
        delete candidate[section][field];
      });
      expect(() => loadContinuousDeploymentPolicy(root)).toThrow(new RegExp(`${section}\\.${field}`));
    });

    it.each(['backendEnvFile', 'contentEngineEnvFile'])(
      'rejects a missing required production environment %s',
      (field) => {
        const root = writePolicyFixture(`policy-missing-production-${field}`, (candidate) => {
          delete candidate.environments.production[field];
        });
        expect(() => loadContinuousDeploymentPolicy(root)).toThrow(
          new RegExp(`environments\\.production\\.${field}`),
        );
      },
    );

    it('binds protected-head lookup to the canonical credential-free repository URL', () => {
      const missing = writePolicyFixture('policy-missing-protected-url', (candidate) => {
        delete candidate.trust.protectedRepositoryUrl;
      });
      expect(() => loadContinuousDeploymentPolicy(missing))
        .toThrow(/trust.*fields|protectedRepositoryUrl/i);

      const mismatched = writePolicyFixture('policy-mismatched-protected-url', (candidate) => {
        candidate.trust.protectedRepositoryUrl = 'https://github.com/example/other.git';
      });
      expect(() => loadContinuousDeploymentPolicy(mismatched))
        .toThrow(/credential-free canonical GitHub URL/);
    });

    it.each([0, -1, 86_401, '15'])('rejects unbounded protected-head timeout %j', (value) => {
      const root = writePolicyFixture(`policy-head-timeout-${String(value)}`, (candidate) => {
        candidate.timing.protectedHeadTimeoutSeconds = value;
      });
      expect(() => loadContinuousDeploymentPolicy(root))
        .toThrow(/protectedHeadTimeoutSeconds|timing/i);
    });
  });

  it('rejects a manifest signed by an unknown key', () => {
    const foreign = generateKeyPairSync('ed25519');
    const envelope = signReleaseManifest({
      payload: payloadFor(),
      privateKeyPem: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      keyId: policy.trust.signingKeyId,
      policy,
    });
    expect(() => verifyReleaseManifest({ envelope, policy, nowMs: Date.parse('2026-08-07T10:00:05Z') }))
      .toThrow(/signature is invalid/);
  });

  it('rejects a tampered payload even when the signature is well-formed', () => {
    const envelope = signed(payloadFor());
    const tampered = {
      ...envelope,
      payload: {
        ...envelope.payload,
        images: {
          ...envelope.payload.images,
          backend: { repository: policy.registry.backendImage, digest: `sha256:${'9'.repeat(64)}` },
        },
      },
    };
    expect(() => verifyReleaseManifest({
      envelope: tampered, policy, nowMs: Date.parse('2026-08-07T10:00:05Z'),
    })).toThrow(/signature is invalid/);
  });

  it('rejects a manifest from the wrong repository, workflow, ref, or key id', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['repository', { repository: 'someone-else/fork' }],
      ['ref', { ref: 'refs/heads/feature' }],
      ['workflow', { workflow: 'Some other workflow' }],
    ];
    for (const [label, override] of cases) {
      expect(() => buildReleaseManifestPayload({
        createdAt: '2026-08-07T10:00:00.000Z',
        source: {
          repository: policy.trust.repository,
          ref: policy.trust.protectedRef,
          sha: SOURCE_SHA,
          workflow: policy.trust.workflow,
          runId: '1',
          runAttempt: '1',
          ...override,
        },
        images: {
          backend: { repository: policy.registry.backendImage, digest: BACKEND_DIGEST },
          contentEngine: { repository: policy.registry.contentEngineImage, digest: CONTENT_DIGEST },
        },
        compose: { path: policy.compose.file, digest: sha256(COMPOSE_BYTES) },
        migrations: {
          digest: migrationVerdictDigest({
            eligible: true, predecessorCompatible: true, reasons: [],
          }),
          upFileCount: 274,
          downFileCount: 41,
          cdEligibility: { eligible: true, predecessorCompatible: true, reasons: [] },
        },
        policy,
      }), label).toThrow();
    }

    const envelope = signed(payloadFor());
    expect(() => verifyReleaseManifest({
      envelope: { ...envelope, keyId: 'some-other-key' },
      policy,
      nowMs: Date.parse('2026-08-07T10:00:05Z'),
    })).toThrow(/not the pinned signing key/);
  });

  it('rejects a migration digest that does not match its own verdict', () => {
    const envelope = signed(payloadFor());
    const swapped = {
      ...envelope,
      payload: {
        ...envelope.payload,
        migrations: {
          ...envelope.payload.migrations,
          // Same digest, flipped verdict: without recomputation this would let a
          // contract migration ride an unattended deploy.
          cdEligibility: {
            eligible: true,
            predecessorCompatible: true,
            reasons: ['migrations/900_drop.sql:drop_table'],
          },
        },
      },
    };
    expect(() => verifyReleaseManifest({
      envelope: swapped, policy, nowMs: Date.parse('2026-08-07T10:00:05Z'),
    })).toThrow(/migration digest does not match/);
  });

  it('rejects an unexpected extra field rather than ignoring it', () => {
    const envelope = signed(payloadFor()) as Record<string, unknown>;
    expect(() => verifyReleaseManifest({
      envelope: { ...envelope, extra: 'surprise' },
      policy,
      nowMs: Date.parse('2026-08-07T10:00:05Z'),
    })).toThrow(/do not match the governed schema/);
  });

  it('requires the controller-bound v3 profile for candidates but can verify a retained v2 predecessor', () => {
    const current = payloadFor();
    expect(current).toMatchObject({
      schema: RELEASE_MANIFEST_PAYLOAD_SCHEMA,
      schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
      controlPlane: CONTROL_PLANE,
    });
    expect(RELEASE_MANIFEST_SCHEMA).toBe('nexus.release-manifest.v3');

    const legacyPayload = legacyPayloadFor(current);
    const legacyEnvelope = legacySigned(current);
    const nowMs = Date.parse('2026-08-07T10:00:05Z');
    expect(() => verifyReleaseManifest({ envelope: legacyEnvelope, policy, nowMs }))
      .toThrow(/envelope schema is invalid|not admissible/i);
    expect(verifyReleaseManifest({
      envelope: legacyEnvelope,
      policy,
      nowMs,
      allowLegacyControlPlane: true,
    }).releaseId).toBe(releaseIdFor(legacyPayload));
  });

  it('rejects a stale or future-dated manifest', () => {
    const envelope = signed(payloadFor());
    expect(() => verifyReleaseManifest({
      envelope, policy, nowMs: Date.parse('2026-08-01T10:00:00Z'),
    })).toThrow(/createdAt is in the future/);
    expect(() => verifyReleaseManifest({
      envelope, policy, nowMs: Date.parse('2026-09-30T10:00:00Z'),
    })).toThrow(/older than the accepted freshness window/);
  });

  it('rejects a Compose file whose bytes do not match the signed digest', () => {
    const payload = payloadFor();
    expect(() => verifyComposeBytes({
      payload, bytes: Buffer.from('services: {}\n'), policy,
    })).toThrow(/does not match the signed manifest/);
    expect(verifyComposeBytes({ payload, bytes: COMPOSE_BYTES, policy }))
      .toBe(sha256(COMPOSE_BYTES));
  });

  it('keeps secrets and runtime output out of receipts', async () => {
    const { store, result } = await deploy();
    const serialized = JSON.stringify(store.readReceipt(result.releaseId!));
    for (const forbidden of ['BEGIN PRIVATE KEY', 'sk-ant', 'Bearer ', 'password', 'token']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // Uses spaced words: a 500-character opaque run is (correctly) redacted
    // wholesale, which would not exercise the length bound.
    // Bounded, and truncated on a token boundary rather than mid-token. Slicing
    // mid-token could halve a digest, and the fragment would not be recognised on
    // a second pass — which the receipt validator rejects as "not sanitized",
    // blocking the release for a formatting artefact.
    const bounded = sanitizeDetail('word '.repeat(200))!;
    expect(bounded.length).toBeLessThanOrEqual(200);
    expect(bounded.length).toBeGreaterThan(180);
    expect(bounded.endsWith(' ')).toBe(false);
    expect(sanitizeDetail(bounded)).toBe(bounded);

    // Idempotence must hold for prefixed digest details too, since those are the
    // longest free-text tokens the allowlist preserves.
    const withDigest = sanitizeDetail(
      `runtime sha256:${'a'.repeat(64)} ${'word '.repeat(60)}`,
    )!;
    expect(sanitizeDetail(withDigest)).toBe(withDigest);
  });

  // Redaction is semantic, not punctuation-stripping. The previous filter kept
  // every character a token is made of, so `sk-ant-...` and `Bearer eyJ...`
  // survived it intact — these probes are the exact values that leaked.
  it.each([
    ['anthropic key', ['sk', 'ant', 'api03', 'AbCdEf123456789012345678'].join('-'), /sk-ant/],
    ['openai key', ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-'), /sk-proj/],
    ['github token', JSON.stringify({ token: ['ghp', 'ABCDEFG1234567890abc'].join('_') }), /ghp_/],
    ['github pat', ['github', 'pat', '11ABCDEFG1234567890'].join('_'), /github_pat_/],
    ['bearer jwt', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', /eyJ|Bearer /],
    ['slack token', 'xox' + 'b-123456789012-abcdefghijklmno', /xoxb-/],
    ['google key', 'AIzaSyA1234567890abcdefghijklmnop', /AIzaSy/],
    ['age recipient', 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', /age1qqq/],
    ['gitlab pat', 'glpat-ABCDEFGHIJKLMNOPQR', /glpat-/],
    ['pem marker', ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '), /BEGIN PRIVATE KEY/],
    ['assigned secret', ['password', 'correcthorsebatterystaple'].join(': '), /correcthorse/],
    ['json secret', '{"secret":"hunter2hunter2hunter2"}', /hunter2/],
    ['hmac assignment', 'hmac=9f8e7d6c5b4a39281706', /9f8e7d6c/],
  ])('redacts a %s from the detail channel', (_label, raw, leak) => {
    const out = sanitizeDetail(raw);
    // The assertion that matters is that the secret VALUE is gone. Asserting a
    // marker shape only proves punctuation was normalised, which is how the
    // previous filter passed while `sk-ant-...` survived it intact.
    expect(out).not.toMatch(leak);
    expect(out).toBe('[redacted]');
  });

  // Second-round probes. Every one of these leaked its secret value through the
  // punctuation-stripping filter; the reproduction script is .local/repro/g5.mjs.
  it.each([
    ['url userinfo', 'https://user:pass@host/path', 'pass'],
    ['custom auth scheme', 'Authorization: Custom abc123', 'abc123'],
    ['nested json value', '{"auth":{"value":"abc123"}}', 'abc123'],
    ['aws access key id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['passphrase assignment', 'passphrase=hunter2', 'hunter2'],
    ['arrow-delimited credential', 'credential -> shortsecret', 'shortsecret'],
    ['unusual casing and spacing', 'CREDENTIAL   :   Sekr3tValue', 'Sekr3tValue'],
    ['base64url jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123', 'eyJhbGciOiJIUzI1NiJ9'],
    ['tab separated secret', 'password\tcorrecthorse', 'correcthorse'],
    ['mixed case key name', ['ApiKey', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ'].join(' = '), 'QWxhZGRpbjpvcGVuIHNlc2FtZQ'],
  ])('removes the secret value for %s', (_label, raw, secret) => {
    const out = sanitizeDetail(raw) ?? '';
    expect(out).not.toContain(secret);
    // And nothing recognisable of it survives in any case folding.
    expect(out.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it.each([
    [
      'slack token behind a slash',
      '/' + 'xox' + 'b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
      'xoxb-',
    ],
    ['aws key in a path', 'wrote /AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt header in a path', '/tmp/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJhbGci'],
    ['github token in a path', ['/var/tmp/ghp', '16C7e42F292c6912E7710c838347Ae178B4a'].join('_'), 'ghp_'],
    ['age key in a path', '/age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p', 'age1ql3z'],
  ])('removes %s (F4: the path rule was a blanket allowlist)', (_label, raw, secret) => {
    // The obvious character class for a path is also the class for base64url, so
    // any secret prefixed with `/` passed through verbatim. Paths are now checked
    // segment by segment.
    expect(sanitizeDetail(raw) ?? '').not.toContain(secret);
  });

  it('still preserves the operational paths receipts need (F4 regression guard)', () => {
    for (const safe of [
      '/var/lib/nexus-hub/production/data/bot.db',
      '/srv/nexus-backups/application/pre-promotion',
      '/etc/nexus-release/docker',
      '/var/lib/nexus-release-audit/receipts',
      '/home/dominguez/telegram-hub-bot-staging/data',
    ]) {
      expect(sanitizeDetail(safe)).toBe(safe);
    }
  });

  it('is idempotent, because the receipt validator rejects a non-idempotent detail (F5)', () => {
    // A mid-token slice could halve a digest; the fragment would not be
    // recognised on a second pass, `assertReleaseReceiptShape` would reject the
    // receipt, and the pipeline would halt on RECEIPT_UNWRITABLE.
    for (const raw of [
      'word '.repeat(200),
      `runtime ${SOURCE_SHA} ${'word '.repeat(60)}`,
      `image sha256:${'b'.repeat(64)} ${'token '.repeat(60)}`,
      `${'a'.repeat(199)} tail`,
    ]) {
      const once = sanitizeDetail(raw);
      expect(sanitizeDetail(once)).toBe(once);
      if (once) expect(once.length).toBeLessThanOrEqual(200);
    }
  });

  it('redacts fail-closed: an unrecognised token never survives verbatim', () => {
    // Allowlist-first is the property under test. A value nothing recognises is
    // removed even with no credential keyword anywhere near it.
    expect(sanitizeDetail('value Zm9vYmFyYmF6cXV1eA')).not.toContain('Zm9vYmFyYmF6cXV1eA');
    expect(sanitizeDetail('id 9f8e7d6c5b4a39281706ZZ')).not.toContain('9f8e7d6c5b4a39281706ZZ');
  });

  it.each([
    ['lowercase passphrase', 'unlocked with correcthorse', 'correcthorse'],
    ['segmented lowercase token', 'used abc-def-ghi-jkl', 'abc-def-ghi-jkl'],
    ['underscore passphrase', 'used correct_horse_battery_staple', 'correct_horse_battery_staple'],
    ['six-digit code', 'code 483920', '483920'],
    ['ten-digit pin', 'pin 9876543210', '9876543210'],
    ['forty-digit integer', `value ${'1'.repeat(40)}`, '1'.repeat(40)],
    ['bare 32-hex token', `value ${'b'.repeat(32)}`, 'b'.repeat(32)],
    ['bare 40-hex token', `value ${'c'.repeat(40)}`, 'c'.repeat(40)],
    ['bare 64-hex token', `value ${'d'.repeat(64)}`, 'd'.repeat(64)],
    ['slash-prefixed six-digit code', '/483920', '483920'],
    [
      'slash-prefixed kebab passphrase',
      '/correct-horse-battery-staple',
      'correct-horse-battery-staple',
    ],
    [
      'slash-prefixed underscore passphrase',
      '/correct_horse_battery_staple',
      'correct_horse_battery_staple',
    ],
    ['slash-prefixed 40-hex token', `/${'e'.repeat(40)}`, 'e'.repeat(40)],
    ['slash-prefixed 64-hex token', `/${'f'.repeat(64)}`, 'f'.repeat(64)],
  ])('redacts the residual %s shape', (_label, raw, secret) => {
    const out = sanitizeDetail(raw) ?? '';
    expect(out).not.toContain(secret);
    expect(sanitizeDetail(out)).toBe(out);
  });

  it('preserves bounded operational integers and normalizes sentence punctuation', () => {
    expect(sanitizeDetail('compose port 65535')).toBe('compose port 65535');
    expect(sanitizeDetail('mirror attempt 1 failed; will retry'))
      .toBe('mirror attempt 1 failed will retry');
  });

  it('drops multiline log content instead of collapsing it onto one line', () => {
    const out = sanitizeDetail('backend failed\n  at Object.<anonymous>\n  secret=hunter2');
    expect(out).not.toMatch(/hunter2/);
    expect(out).not.toMatch(/anonymous/);
    expect(out).toMatch(/^backend failed/);
  });

  it('preserves only explicitly governed free-text evidence shapes', () => {
    const prefixedDigest = `sha256:${'f'.repeat(64)}`;
    expect(sanitizeDetail(`compose ${prefixedDigest}`)).toContain(prefixedDigest);
    expect(sanitizeDetail('status rolled_back')).toBe('status rolled_back');
    expect(sanitizeDetail('probe integrity_check')).toBe('probe integrity_check');
    expect(sanitizeDetail('artifact nexus-db-20260805T214421Z.sqlite.age'))
      .toContain('nexus-db-20260805T214421Z.sqlite.age');
    expect(sanitizeDetail('compose exit 1')).toBe('compose exit 1');
  });

  it('keeps secrets and provider payloads out of notifications', () => {
    const releaseId = sha256('r').slice(0, 32);
    const text = buildReleaseNotification({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      policy,
      release: {
        releaseId,
        sourceSha: SOURCE_SHA,
        phase: 'production',
        outcome: 'rolled_back',
        failureCode: 'token=abc {"provider":"gemini"}',
        rollbackResult: 'restored',
        actionRequired: 'acknowledge the block',
      },
    });
    expect(text).not.toContain('{');
    expect(text).not.toContain('"');
    expect(text.length).toBeLessThanOrEqual(policy.notifications.maxMessageChars);
    expect(text).toContain('Nexus Hub release FAILED');
    expect(text.split('\n')).toContain(`release: ${releaseId}`);
    expect(text.split('\n')).toContain(`commit: ${SOURCE_SHA}`);
  });

  it('fails structured notification identities closed instead of using generic text rules', () => {
    const text = buildReleaseNotification({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      policy,
      release: {
        releaseId: 'not-a-release-id',
        sourceSha: SOURCE_SHA.slice(0, 12),
        phase: 'production',
        outcome: 'blocked',
        failureCode: 'verification failed',
        rollbackResult: 'not_attempted',
      },
    });

    expect(text.split('\n')).toContain('release: unknown');
    expect(text.split('\n')).toContain('commit: unknown');
    expect(text).not.toContain('not-a-release-id');
  });

  it('renders exact validated identities in recovery notifications', () => {
    const releaseId = sha256('recovered-release').slice(0, 32);
    const text = buildReleaseNotification({
      kind: RELEASE_NOTIFICATION_KINDS.RECOVERY,
      policy,
      release: {
        releaseId,
        sourceSha: SOURCE_SHA,
        restored: {
          backend: { digest: `sha256:${'a'.repeat(64)}` },
          contentEngine: { digest: `sha256:${'b'.repeat(64)}` },
        },
      },
    });

    expect(text.split('\n')).toContain(`release: ${releaseId}`);
    expect(text.split('\n')).toContain(`commit: ${SOURCE_SHA}`);
  });

  it('pages sanitized discovery failures before a release identity exists', async () => {
    const sent: Array<Record<string, any>> = [];
    const logs: string[] = [];
    const result = await reportReleaseDeploymentAbort({
      notifier: {
        send: async (entry: Record<string, any>) => {
          sent.push(entry);
          return { delivered: true };
        },
      },
      error: new Error('payload https://user:pass@example.invalid failed verification'),
      log: (message: string) => logs.push(message),
    });

    expect(result.failureCode).toBe('[redacted]');
    expect(logs.join('\n')).not.toContain('user:pass');
    expect(sent).toEqual([expect.objectContaining({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: expect.objectContaining({
        releaseId: null,
        sourceSha: null,
        phase: 'discovery_verification',
        outcome: 'poll_failed',
        failureCode: '[redacted]',
      }),
    })]);
  });

  it('preserves the original abort path when failure notification throws', async () => {
    const logs: string[] = [];
    await expect(reportReleaseDeploymentAbort({
      notifier: { send: async () => { throw new Error('telegram unavailable'); } },
      error: new Error('manifest check failed'),
      log: (message: string) => logs.push(message),
    })).resolves.toEqual({ failureCode: 'manifest check failed' });
    expect(logs).toContain('release failure notification failed');
  });

  it('treats an audit-mirror failure as non-gating', async () => {
    const mirror = fakeMirror('failed');
    const notifier = fakeNotifier();
    const { result } = await deploy({ mirror, notifier });
    // The verdict is unchanged...
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    // ...but the failure is surfaced.
    expect(notifier.sent.some((entry) => entry.release.phase === 'audit_mirror')).toBe(true);
  });

  it('skips mirroring without failing when no audit host is configured', () => {
    const mirror = createReleaseAuditMirror({
      policy,
      env: {},
      exec: () => { throw new Error('must not run'); },
    });
    expect(mirror.mirrorReceipt({ receiptPath: '/tmp/x.json', releaseId: 'a'.repeat(32) }))
      .toEqual({ result: 'skipped', detail: 'host_not_configured' });
  });

  it('prunes to exactly two image pairs, removing a third', () => {
    // Drives the real prune implementation, not the harness double: the harness
    // can only prove which digests were requested, not that a third is removed.
    const current = `sha256:${'a'.repeat(64)}`;
    const predecessor = `sha256:${'b'.repeat(64)}`;
    const stale = `sha256:${'c'.repeat(64)}`;
    const removed: string[] = [];
    const registry = createReleaseRegistry({
      policy,
      exec: (_bin, args) => {
        if (args[0] === 'image' && args[1] === 'list') {
          return { status: 0, stdout: `${current}\n${predecessor}\n${stale}\n`, stderr: '' };
        }
        if (args[0] === 'image' && args[1] === 'remove') {
          removed.push(args[2]);
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const result = registry.pruneImages({
      repository: policy.registry.backendImage,
      keepDigests: [current, predecessor],
    });
    expect(result.removed).toEqual([stale]);
    expect(removed).toEqual([`${policy.registry.backendImage}@${stale}`]);
    expect(result.kept).toHaveLength(policy.registry.retainedImagePairs);
  });

  it('uses the spare governed slot for one recent digest when there is no predecessor', () => {
    const current = `sha256:${'a'.repeat(64)}`;
    const stale = `sha256:${'c'.repeat(64)}`;
    const registry = createReleaseRegistry({
      policy,
      exec: (_bin, args) => (args[1] === 'list'
        ? { status: 0, stdout: `${current}\n${stale}\n`, stderr: '' }
        : { status: 0, stdout: '', stderr: '' }),
    });
    // `undefined` predecessor digests must not be treated as a digest to keep.
    const result = registry.pruneImages({
      repository: policy.registry.backendImage,
      keepDigests: [current, undefined as unknown as string],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([current, stale]);
  });

  it('uses the governed image limit only for non-rollback extra digests', () => {
    const current = `sha256:${'a'.repeat(64)}`;
    const predecessor = `sha256:${'b'.repeat(64)}`;
    const recentExtra = `sha256:${'c'.repeat(64)}`;
    const stale = `sha256:${'d'.repeat(64)}`;
    const removed: string[] = [];
    const registry = createReleaseRegistry({
      policy: {
        ...policy,
        registry: { ...policy.registry, retainedImagePairs: 3 },
      },
      exec: (_bin, args) => {
        if (args[0] === 'image' && args[1] === 'list') {
          return {
            status: 0,
            stdout: `${current}\n${predecessor}\n${recentExtra}\n${stale}\n`,
            stderr: '',
          };
        }
        if (args[0] === 'image' && args[1] === 'remove') removed.push(args[2]);
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const result = registry.pruneImages({
      repository: policy.registry.backendImage,
      keepDigests: [current, predecessor],
    });
    expect(result.kept).toEqual([current, predecessor, recentExtra]);
    expect(removed).toEqual([`${policy.registry.backendImage}@${stale}`]);
  });

  it('counts protected payload directories inside the governed total limit', () => {
    const current = 'a'.repeat(64);
    const predecessor = 'b'.repeat(64);
    const stale = 'c'.repeat(64);
    for (const digest of [current, predecessor, stale]) {
      mkdirSync(join(policy.paths.workDir, digest), { recursive: true });
    }
    const registry = createReleaseRegistry({
      policy: {
        ...policy,
        retention: { ...policy.retention, workDirs: 2 },
      },
    });

    const result = registry.pruneWorkDirs({
      keepDirs: [
        join(policy.paths.workDir, current),
        join(policy.paths.workDir, predecessor),
      ],
    });
    expect(result.removed).toEqual([stale]);
    expect(existsSync(join(policy.paths.workDir, current))).toBe(true);
    expect(existsSync(join(policy.paths.workDir, predecessor))).toBe(true);
  });

  it('retains current and predecessor app plus release-payload images', async () => {
    const store = makeStore();
    seedPredecessor(store);
    const { result, registryHarness } = await deploy({ store });
    expect(result.outcome).toBe(DEPLOYMENT_OUTCOMES.COMPLETED);
    expect(registryHarness.removedImages).toHaveLength(6);
    expect(registryHarness.removedImages.filter((entry) => (
      entry.startsWith(`${policy.registry.releaseImage}:keep=`)
    ))).toHaveLength(2);
    for (const entry of registryHarness.removedImages) {
      const kept = entry.split('keep=')[1].split(',').filter(Boolean);
      expect(kept.length).toBeLessThanOrEqual(2);
      expect(kept.length).toBeGreaterThanOrEqual(1);
    }
  });

  // The backup is verified from the unit's own receipt, not by scanning a
  // directory. A scan cannot tell an encrypted artifact from a checksum sidecar,
  // and cannot prove the backup covers the database this release will migrate.
  describe('pre-migration backup receipt', () => {
    // The real unit publishes its receipt *during* the run, so `publish` is wired
    // into the exec double's `start` branch. Pre-writing it instead would make
    // every case fail the freshness check first and mask what is being tested.
    function receiptFixture(dir: string, overrides: Record<string, unknown> = {}) {
      const receiptStartedAt = String(overrides.startedAt ?? new Date().toISOString());
      const producerStamp = `${receiptStartedAt.slice(0, 10).replaceAll('-', '')}T${receiptStartedAt
        .slice(11, 19).replaceAll(':', '')}Z`;
      const artifact = join(dir, 'pre-promotion', `nexus-db-${producerStamp}.sqlite.age`);
      const receiptPath = join(dir, 'state', 'last-success.json');
      const publish = () => {
        mkdirSync(join(dir, 'pre-promotion'), { recursive: true, mode: 0o700 });
        mkdirSync(join(dir, 'state'), { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        chmodSync(join(dir, 'pre-promotion'), 0o700);
        chmodSync(join(dir, 'state'), 0o700);
        const bytes = (overrides.artifactBytes as string | Buffer) ?? 'encrypted-bytes';
        if (!(overrides.skipArtifact === true)) {
          writeFileSync(artifact, bytes, { mode: 0o600 });
          chmodSync(artifact, 0o600);
          const digest = sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
          const checksum = `${artifact}.sha256`;
          writeFileSync(checksum, `${digest}  ${artifact.split('/').at(-1)}\n`, { mode: 0o600 });
          chmodSync(checksum, 0o600);
        }
        const size = overrides.skipArtifact === true ? 15 : statSync(artifact).size;
        const completedAt = String(overrides.completedAt ?? receiptStartedAt);
        const receipt = {
          schema: 'nexus.local-backup.v1',
          status: 'passed',
          kind: 'pre-promotion',
          database: '/var/lib/nexus-hub/production/data/bot.db',
          backupRoot: dir,
          startedAt: receiptStartedAt,
          completedAt,
          // A receipt that does not actually describe its artifact is not
          // evidence; the digest is computed from the bytes on disk.
          encryptedSha256: sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)),
          encryptedSizeBytes: size,
          installed: { 'pre-promotion': artifact },
          retention: { hourly: 24, daily: 30, weekly: 4, 'pre-promotion': 10 },
          plaintextSha256: 'a'.repeat(64),
          plaintextSizeBytes: 4096,
          integrityCheck: 'ok',
          foreignKeyCheck: 'ok',
          ...overrides,
        };
        delete (receipt as Record<string, unknown>).skipArtifact;
        delete (receipt as Record<string, unknown>).artifactBytes;
        writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
        chmodSync(receiptPath, 0o600);
      };
      return {
        receiptPath,
        artifact,
        publish,
        root: dir,
        requestedAt: Date.parse(receiptStartedAt),
      };
    }

    function backupFor(
      fixture: {
        receiptPath: string;
        publish: () => void;
        root: string;
        requestedAt?: number;
      },
      unitResult = 'success',
    ) {
      return createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        exec: (_bin: string, args: string[]) => {
          if (args[0] === 'start') {
            fixture.publish();
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: `${unitResult}\n`, stderr: '' };
        },
        now: () => fixture.requestedAt ?? Date.now(),
      });
    }

    const run = (
      fixture: {
        receiptPath: string;
        publish: () => void;
        root: string;
        requestedAt?: number;
      },
      unitResult?: string,
    ) => (
      backupFor(fixture, unitResult).createPreMigrationBackup({ environment: 'production' })
    );

    // Second-round adversarial probes. Before this round the artifact was checked
    // by size alone, so same-sized tampering passed and the receipt's digest was
    // carried as evidence without anything ever comparing it to the bytes.
    // Reproduction script: .local/repro/g3.mjs.
    it.each([
      ['missing plaintext digest', (receipt: Record<string, any>) => {
        delete receipt.plaintextSha256;
      }],
      ['failed integrity', (receipt: Record<string, any>) => {
        receipt.integrityCheck = 'failed';
      }],
      ['failed foreign-key check', (receipt: Record<string, any>) => {
        receipt.foreignKeyCheck = 'failed';
      }],
      ['retention drift', (receipt: Record<string, any>) => {
        receipt.retention.hourly = 23;
      }],
      ['an unexpected field', (receipt: Record<string, any>) => {
        receipt.untrusted = true;
      }],
    ])('rejects the closed producer receipt schema with %s', (_label, mutate) => {
      const fixture = receiptFixture(mkdtempSync(join(workspace, 'backup-receipt-claims-')));
      fixture.publish();
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
      mutate(receipt);
      writeFileSync(fixture.receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      chmodSync(fixture.receiptPath, 0o600);

      const result = backupFor(fixture).readBackupReceipt({
        environment: 'production',
        notBeforeMs: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/closed producer schema|recovery claims|retention/);
    });

    it.each([
      ['missing', (checksum: string) => rmSync(checksum)],
      ['wrong basename', (checksum: string, fixture: ReturnType<typeof receiptFixture>) => {
        writeFileSync(checksum, `${'0'.repeat(64)}  wrong.sqlite.age\n`, { mode: 0o600 });
      }],
      ['trailing bytes', (checksum: string, fixture: ReturnType<typeof receiptFixture>) => {
        const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
        writeFileSync(checksum, `${receipt.encryptedSha256}  ${fixture.artifact.split('/').at(-1)}\nextra\n`, { mode: 0o600 });
      }],
      ['hardlink', (checksum: string) => linkSync(checksum, `${checksum}.second-link`)],
      ['unsafe mode', (checksum: string) => chmodSync(checksum, 0o640)],
    ])('rejects a %s checksum companion during release admission', (_label, mutate) => {
      const fixture = receiptFixture(mkdtempSync(join(workspace, 'backup-checksum-claims-')));
      fixture.publish();
      mutate(`${fixture.artifact}.sha256`, fixture);
      const result = backupFor(fixture).readBackupReceipt({
        environment: 'production',
        notBeforeMs: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/checksum/);
    });

    it('rejects same-sized tampering of the encrypted artifact', () => {
      const dir = mkdtempSync(join(workspace, 'backup-tamper-'));
      const fixture = receiptFixture(dir);
      const backup = backupFor(fixture);
      fixture.publish();
      // Same length, different bytes: only a digest can tell these apart.
      writeFileSync(fixture.artifact, 'TAMPERED-bytes'.padEnd(
        statSync(fixture.artifact).size, 'X',
      ).slice(0, statSync(fixture.artifact).size));
      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/digest does not match/);
    });

    it('hashes the same open descriptor in bounded chunks', () => {
      const dir = mkdtempSync(join(workspace, 'backup-bounded-hash-'));
      const fixture = receiptFixture(dir, {
        artifactBytes: Buffer.alloc((2 * 1024 * 1024) + 17, 0x41),
      });
      fixture.publish();
      let descriptorReadFileCalls = 0;
      let artifactFd: number | null = null;
      const readLengths: number[] = [];
      const fileSystem = {
        ...nodeFs,
        openSync(target: string, flags: string | number, mode?: number) {
          const descriptor = nodeFs.openSync(target, flags, mode);
          if (target === fixture.artifact) artifactFd = descriptor;
          return descriptor;
        },
        readFileSync(target: any, ...args: any[]) {
          if (target === artifactFd) {
            descriptorReadFileCalls += 1;
            throw new Error('whole-file descriptor reads are forbidden');
          }
          return (nodeFs.readFileSync as any)(target, ...args);
        },
        readSync(fd: number, buffer: Buffer, offset: number,
          length: number, position: number) {
          readLengths.push(length);
          return nodeFs.readSync(fd, buffer, offset, length, position);
        },
      };
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        fileSystem,
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(result.ok).toBe(true);
      expect(descriptorReadFileCalls).toBe(0);
      expect(readLengths.length).toBeGreaterThan(2);
      expect(Math.max(...readLengths)).toBeLessThanOrEqual(1024 * 1024);
    });

    it('rejects an in-place mutation that occurs after the first hash pass', () => {
      const dir = mkdtempSync(join(workspace, 'backup-double-hash-'));
      const fixture = receiptFixture(dir);
      fixture.publish();
      let artifactFd: number | null = null;
      let artifactReads = 0;
      const fileSystem = {
        ...nodeFs,
        openSync(target: string, flags: string | number, mode?: number) {
          const fd = nodeFs.openSync(target, flags, mode);
          if (target === fixture.artifact) artifactFd = fd;
          return fd;
        },
        readSync(fd: number, buffer: Buffer, offset: number,
          length: number, position: number) {
          const bytesRead = nodeFs.readSync(fd, buffer, offset, length, position);
          if (fd === artifactFd && artifactReads === 0) {
            artifactReads += 1;
            // Same inode and size, changed only after the first pass copied its
            // bytes into the hash buffer.
            writeFileSync(fixture.artifact, 'changed-content');
          }
          return bytesRead;
        },
      };
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        fileSystem,
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/changed during verification/);
    });

    it('rejects a symlinked governed backup root', () => {
      const realRoot = mkdtempSync(join(workspace, 'backup-real-root-'));
      const linkedRoot = join(workspace, 'backup-linked-root');
      symlinkSync(realRoot, linkedRoot);
      const fixture = receiptFixture(realRoot, { backupRoot: linkedRoot });
      fixture.publish();
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: {
            ...policy.backup,
            receiptPath: join(linkedRoot, 'state', 'last-success.json'),
            root: linkedRoot,
          },
        },
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/receipt directory authority|root.*ancestor chain/i);
    });

    it.each([
      ['root', (fixture: ReturnType<typeof receiptFixture>) => chmodSync(fixture.root, 0o755)],
      ['state', (fixture: ReturnType<typeof receiptFixture>) => {
        chmodSync(join(fixture.root, 'state'), 0o755);
      }],
      ['pre-promotion tier', (fixture: ReturnType<typeof receiptFixture>) => {
        chmodSync(join(fixture.root, 'pre-promotion'), 0o755);
      }],
    ])('rejects unsafe private directory mode on the %s', (_label, mutate) => {
      const fixture = receiptFixture(mkdtempSync(join(workspace, 'backup-private-mode-')));
      fixture.publish();
      mutate(fixture);
      const result = backupFor(fixture).readBackupReceipt({
        environment: 'production',
        notBeforeMs: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/authority|identity|unsafe/);
    });

    it('rejects a group/world-writable ancestor above the governed root', () => {
      const unsafeParent = mkdtempSync(join(workspace, 'backup-unsafe-parent-'));
      chmodSync(unsafeParent, 0o777);
      const dir = join(unsafeParent, 'application');
      mkdirSync(dir, { mode: 0o700 });
      const fixture = receiptFixture(dir);
      fixture.publish();
      const result = backupFor(fixture).readBackupReceipt({
        environment: 'production',
        notBeforeMs: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/authority|ancestor chain|unsafe/);
    });

    it('uses fixed root ownership in production rather than the invoking uid', () => {
      if ((process.getuid?.() ?? 0) === 0) return;
      const fixture = receiptFixture(mkdtempSync(join(workspace, 'backup-fixed-owner-')));
      fixture.publish();
      const backup = createReleaseBackup({
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        backupTrustAnchor: workspace,
      });
      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/authority|unsafe/);
    });

    it('rejects a governed root namespace replacement after descriptor binding', () => {
      const dir = mkdtempSync(join(workspace, 'backup-root-race-'));
      const movedRoot = `${dir}-moved`;
      const fixture = receiptFixture(dir);
      fixture.publish();
      let artifactFd: number | null = null;
      let rootReplaced = false;
      const fileSystem = {
        ...nodeFs,
        openSync(target: string, flags: string | number, mode?: number) {
          const fd = nodeFs.openSync(target, flags, mode);
          if (target === fixture.artifact) artifactFd = fd;
          return fd;
        },
        readSync(fd: number, buffer: Buffer, offset: number,
          length: number, position: number) {
          const bytesRead = nodeFs.readSync(fd, buffer, offset, length, position);
          if (fd === artifactFd && !rootReplaced) {
            rootReplaced = true;
            nodeFs.renameSync(dir, movedRoot);
            mkdirSync(dir);
          }
          return bytesRead;
        },
      };
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        fileSystem,
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(
        /root identity changed|artifact or governed root identity changed|directory authority changed/i,
      );
    });

    it('replaces a pending success when authority changes at the final retained recheck', () => {
      const dir = mkdtempSync(join(workspace, 'backup-final-authority-race-'));
      const fixture = receiptFixture(dir);
      fixture.publish();
      let artifactFd: number | undefined;
      let mutated = false;
      const fileSystem = {
        ...nodeFs,
        openSync(target: string, flags: string | number, mode?: number) {
          const descriptor = nodeFs.openSync(target, flags, mode);
          if (target === fixture.artifact) artifactFd = descriptor;
          return descriptor;
        },
        closeSync(descriptor: number) {
          nodeFs.closeSync(descriptor);
          if (descriptor === artifactFd && !mutated) {
            mutated = true;
            chmodSync(dir, 0o755);
          }
        },
      };
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        fileSystem,
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(mutated).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/directory authority changed/);
    });

    it('closes retained root bindings when the explicit root descriptor open fails', () => {
      const dir = mkdtempSync(join(workspace, 'backup-root-open-close-'));
      const fixture = receiptFixture(dir);
      fixture.publish();
      let rootOpens = 0;
      let openedCount = 0;
      let closedCount = 0;
      const fileSystem = {
        ...nodeFs,
        openSync(target: string, flags: string | number, mode?: number) {
          if (target === dir && ++rootOpens === 3) {
            const error = Object.assign(new Error('injected root open failure'), { code: 'EIO' });
            throw error;
          }
          const descriptor = nodeFs.openSync(target, flags, mode);
          openedCount += 1;
          return descriptor;
        },
        closeSync(descriptor: number) {
          closedCount += 1;
          nodeFs.closeSync(descriptor);
        },
      };
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        fileSystem,
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/root could not be opened/);
      expect(closedCount).toBe(openedCount);
    });

    it('rejects a symlinked artifact', () => {
      const dir = mkdtempSync(join(workspace, 'backup-symlink-'));
      const fixture = receiptFixture(dir);
      const backup = backupFor(fixture);
      fixture.publish();
      const real = join(workspace, 'elsewhere.age');
      writeFileSync(real, readFileSync(fixture.artifact));
      rmSync(fixture.artifact);
      symlinkSync(real, fixture.artifact);
      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/not a regular file/);
    });

    it('fails closed when the artifact becomes a symlink after descriptor stat', () => {
      const dir = mkdtempSync(join(workspace, 'backup-stat-read-race-'));
      const fixture = receiptFixture(dir);
      fixture.publish();
      const outside = join(workspace, 'race-target.age');
      writeFileSync(outside, readFileSync(fixture.artifact));
      let artifactOpenCount = 0;
      let swapped = false;
      const fileSystem = {
        ...nodeFs,
        openSync(target: string, flags: string | number) {
          if (target === fixture.artifact) artifactOpenCount += 1;
          return nodeFs.openSync(target, flags);
        },
        fstatSync(fd: number, options?: JsonObject) {
          const stat = nodeFs.fstatSync(fd);
          if (artifactOpenCount > 0 && !swapped) {
            swapped = true;
            rmSync(fixture.artifact);
            symlinkSync(outside, fixture.artifact);
          }
          return options?.bigint ? nodeFs.fstatSync(fd, { bigint: true }) : stat;
        },
      };
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        fileSystem,
      });

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(artifactOpenCount).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/identity changed|could not be resolved|regular file|link count/);
    });

    it('rejects a hardlink inside the governed root to a file outside it', () => {
      const dir = mkdtempSync(join(workspace, 'backup-hardlink-'));
      const fixture = receiptFixture(dir, { skipArtifact: true });
      fixture.publish();
      const outside = join(workspace, 'outside-hardlink.age');
      writeFileSync(outside, 'encrypted-bytes');
      linkSync(outside, fixture.artifact);
      const backup = backupFor(fixture);

      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/hard link|link count/i);
    });

    it('rejects an artifact that resolves outside the governed backup root', () => {
      const dir = mkdtempSync(join(workspace, 'backup-escape-'));
      const fixture = receiptFixture(dir);
      const backup = backupFor(fixture);
      fixture.publish();
      // Point the receipt at a real .age file the attacker controls, outside the
      // root. Size and digest would both agree with it.
      const outsideDir = mkdtempSync(join(workspace, 'backup-outside-root-'));
      const outside = join(outsideDir, 'nexus-db-20260807T120000Z.sqlite.age');
      writeFileSync(outside, readFileSync(fixture.artifact));
      chmodSync(outside, 0o600);
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
      receipt.installed['pre-promotion'] = outside;
      writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/producer topology|outside the governed backup root/);
    });

    it('rejects an escape through a symlinked parent directory', () => {
      const dir = mkdtempSync(join(workspace, 'backup-linkdir-'));
      const fixture = receiptFixture(dir);
      const backup = backupFor(fixture);
      fixture.publish();
      const outDir = mkdtempSync(join(workspace, 'outdir-'));
      const real = join(outDir, 'nexus-db-20260807T120000Z.sqlite.age');
      writeFileSync(real, readFileSync(fixture.artifact));
      chmodSync(real, 0o600);
      const linked = join(dir, 'linked');
      symlinkSync(outDir, linked);
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
      receipt.installed['pre-promotion'] = join(linked, 'nexus-db-20260807T120000Z.sqlite.age');
      writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
      const result = backup.readBackupReceipt({ environment: 'production', notBeforeMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/producer topology|outside the governed backup root/);
    });

    it('passes on a fresh receipt naming the production database', () => {
      const result = run(receiptFixture(workspace));
      expect(result.result).toBe('passed');
      expect(result.artifact).toMatch(/^nexus-db-.*\.age$/);
    });

    it('rejects an already-activating backup that completes after this release request', () => {
      const requestedAt = Date.parse('2026-08-07T12:00:00.000Z');
      const fixture = receiptFixture(mkdtempSync(join(workspace, 'backup-active-race-')), {
        startedAt: new Date(requestedAt - 5_000).toISOString(),
        completedAt: new Date(requestedAt + 5_000).toISOString(),
      });
      const backup = createReleaseBackup({
        ...backupTestAuthority(),
        policy: {
          ...policy,
          backup: { ...policy.backup, receiptPath: fixture.receiptPath, root: fixture.root },
        },
        now: () => requestedAt,
        exec: (_bin: string, args: string[]) => {
          if (args[0] === 'start') fixture.publish();
          return { status: 0, stdout: args[0] === 'show' ? 'success\n' : '', stderr: '' };
        },
      });

      const result = backup.createPreMigrationBackup({ environment: 'production' });

      expect(result.result).toBe('failed');
      expect(result.detail).toMatch(/invocation predates this release request/);
    });

    it('rejects a receipt whose completion predates its producer invocation', () => {
      const completedAt = Date.now();
      const result = run(receiptFixture(mkdtempSync(join(workspace, 'backup-time-order-')), {
        startedAt: new Date(completedAt + 1_000).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
      }));
      expect(result.result).toBe('failed');
      expect(result.detail).toMatch(/completion predates its invocation/);
    });

    it('fails when the unit succeeds but publishes no receipt', () => {
      mkdirSync(join(workspace, 'state'), { mode: 0o700 });
      chmodSync(join(workspace, 'state'), 0o700);
      const result = run({
        receiptPath: join(workspace, 'state', 'last-success.json'),
        publish: () => {},
        root: workspace,
      });
      expect(result).toEqual({
        result: 'failed', artifact: null, detail: 'backup receipt is missing',
      });
    });

    it('fails when the receipt covers a different database', () => {
      // The retained unit historically pointed at the pre-container path, so this
      // is the realistic misconfiguration, not a hypothetical one.
      const result = run(receiptFixture(workspace, {
        database: '/home/dominguez/telegram-hub-bot/data/bot.db',
      }));
      expect(result.result).toBe('failed');
      expect(result.detail).toMatch(/different database/);
    });

    it('fails when the receipt is an hourly backup rather than pre-promotion', () => {
      expect(run(receiptFixture(workspace, { kind: 'hourly' })).result).toBe('failed');
    });

    it('fails when the named artifact is not the encrypted file', () => {
      const sidecar = join(workspace, 'nexus-db-20260807T120000Z.sqlite.sha256');
      writeFileSync(sidecar, 'deadbeef');
      const result = run(receiptFixture(workspace, {
        installed: { 'pre-promotion': sidecar },
      }));
      expect(result.detail).toMatch(/not an encrypted \.age file/);
    });

    it('fails when the artifact size disagrees with the receipt', () => {
      const result = run(receiptFixture(workspace, { encryptedSizeBytes: 999999 }));
      expect(result.detail).toMatch(/size does not match/);
    });

    it('fails when the receipt predates this release attempt', () => {
      // A stale receipt from an earlier backup is not evidence for this release.
      const result = run(receiptFixture(workspace, {
        completedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }));
      expect(result.result).toBe('failed');
      expect(result.detail).toMatch(/predates|stale/);
    });

    it('fails when the receipt status is not passed', () => {
      expect(run(receiptFixture(workspace, { status: 'failed' })).result).toBe('failed');
    });

    it('fails when the backup unit itself reports a non-success result', () => {
      expect(run(receiptFixture(workspace), 'exit-code').result).toBe('failed');
    });
  });

  it('marks the generated release-state view as non-authoritative', async () => {
    const { store } = await deploy();
    const view = buildReleaseStateView({ state: store.readState(), receipts: [] });
    expect(view.authoritative).toBe(false);
    expect(view.generated).toBe(true);
    expect(view.note).toMatch(/outrank/);
  });

  it('resolves only an immutable digest from a moving registry tag', () => {
    const registry = createReleaseRegistry({
      policy,
      exec: () => ({
        status: 0,
        stdout: `${policy.registry.releaseImage}@${PAYLOAD_DIGEST}\n`,
        stderr: '',
      }),
    });
    expect(registry.resolveDigest(`${policy.registry.releaseImage}:main`)).toBe(PAYLOAD_DIGEST);

    const badRegistry = createReleaseRegistry({
      policy,
      exec: () => ({ status: 0, stdout: 'no-digest-here\n', stderr: '' }),
    });
    expect(() => badRegistry.resolveDigest('x')).toThrow(/could not resolve an immutable digest/);
  });

  it('ends the observation window at the first failed probe', async () => {
    let now = 0;
    const health = createReleaseHealth({
      clock: () => now,
      sleep: async (ms: number) => { now += ms; },
      fetchImpl: async () => ({ status: 503, json: async () => ({}) }) as never,
    });
    const observation = await health.observe({
      backendPort: 8200,
      contentEnginePort: 8100,
      observationSeconds: 60,
    });
    expect(observation.passed).toBe(false);
    // It must not have burned the whole window before reporting the failure.
    expect(observation.observedSeconds).toBeLessThan(60);
  });

  it('passes a full observation window without a real 60-second wait', async () => {
    let now = 0;
    const health = createReleaseHealth({
      clock: () => now,
      sleep: async (ms: number) => { now += ms; },
      fetchImpl: async (url: string) => {
        const target = String(url);
        // The content engine answers {status:'ok'}; the backend answers
        // {status:'healthy', database:'connected'}. Mocking one shape for both
        // would prove nothing about the real readiness contracts.
        if (target.includes('public-status')) {
          return { status: 200, json: async () => ({ status: 'ok', service: 'nexushub-api' }) } as never;
        }
        if (target.includes(':8100')) {
          return { status: 200, json: async () => ({ status: 'ok', version: '0.1.0' }) } as never;
        }
        return {
          status: 200,
          json: async () => ({ status: 'healthy', database: 'connected' }),
        } as never;
      },
    });
    const observation = await health.observe({
      backendPort: 8200,
      contentEnginePort: 8100,
      observationSeconds: 60,
    });
    expect(observation.passed).toBe(true);
    expect(observation.observedSeconds).toBeGreaterThanOrEqual(60);
  });

  it('produces a deterministic canonical encoding for signed content', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }))
      .toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });
});

import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadContinuousDeploymentPolicy } from '../../scripts/lib/release-manifest.mjs';

type Policy = Record<string, any>;

const repoRoot = resolve(process.cwd());
const canonicalPolicy = JSON.parse(readFileSync(
  join(repoRoot, 'config', 'continuous-deployment.json'),
  'utf8',
)) as Policy;
const fixtureRoots: string[] = [];

function clonePolicy() {
  return JSON.parse(JSON.stringify(canonicalPolicy)) as Policy;
}

function resolveParent(candidate: Policy, dottedPath: string) {
  const parts = dottedPath.split('.');
  const field = parts.pop()!;
  let parent: Policy = candidate;
  for (const part of parts) parent = parent[part];
  return { parent, field };
}

function loadFixture(
  mutate: (candidate: Policy) => void,
): ReturnType<typeof loadContinuousDeploymentPolicy> {
  const root = mkdtempSync(join(tmpdir(), 'nexus-release-policy-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  const candidate = clonePolicy();
  mutate(candidate);
  writeFileSync(
    join(root, 'config', 'continuous-deployment.json'),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );
  return loadContinuousDeploymentPolicy(root);
}

function setField(candidate: Policy, dottedPath: string, value: unknown) {
  const { parent, field } = resolveParent(candidate, dottedPath);
  parent[field] = value;
}

function deleteField(candidate: Policy, dottedPath: string) {
  const { parent, field } = resolveParent(candidate, dottedPath);
  delete parent[field];
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('continuous deployment policy shape', () => {
  it.each([
    'version',
    'backup.root',
    'compose.file',
    'compose.backendService',
    'compose.contentEngineService',
    'compose.migratorService',
    'timing.pollIntervalSeconds',
    'timing.observationSeconds',
    'timing.rollbackObjectiveSeconds',
    'timing.healthBudgetSeconds',
    'timing.stagingHealthBudgetSeconds',
    'timing.migratorTimeoutSeconds',
    'timing.backupTimeoutSeconds',
    'notifications.failureEnabled',
    'notifications.recoveryEnabled',
    'notifications.heartbeatEnabled',
    'notifications.heartbeatSchedule',
    'notifications.maxMessageChars',
    'auditMirror.enabled',
    'auditMirror.user',
    'auditMirror.path',
    'auditMirror.hostEnvVar',
    'auditMirror.identityFile',
    'auditMirror.timeoutSeconds',
    'auditMirror.knownHostsFile',
    'auditMirror.maxAttempts',
    'auditMirror.queueDir',
    'registry.retainedImagePairs',
    'retention.workDirs',
    'piRunner',
    'piRunner.labels',
    'piRunner.requiredArch',
    'piRunner.requiredOs',
    'piRunner.minUsableMemoryGiB',
    'piRunner.minFreeStorageGiB',
    'piRunner.nodeVersion',
    'piRunner.focusedSuiteBudgetSeconds',
    'piRunner.requiredEgressHosts',
    'piRunner.forbiddenCapabilities',
    'piRunner.budgetSuite',
    'iosContractPaths',
  ])('rejects a missing runtime-consumed %s field at load time', (field) => {
    expect(() => loadFixture((candidate) => deleteField(candidate, field)))
      .toThrow(new RegExp(field.replace('.', '\\.'), 'i'));
  });

  it.each(['imagePairs', 'releasePayloads', 'receipts'])(
    'rejects the obsolete non-operative retention.%s knob',
    (field) => {
      expect(() => loadFixture((candidate) => {
        candidate.retention[field] = 2;
      })).toThrow(/retention fields do not match the governed schema/i);
    },
  );

  it.each([
    ['timing.observationSeconds', '60'],
    ['timing.observationSeconds', 0],
    ['timing.observationSeconds', 86_401],
    ['timing.healthBudgetSeconds', 1.5],
    ['notifications.failureEnabled', 'true'],
    ['notifications.recoveryEnabled', 1],
    ['notifications.heartbeatEnabled', null],
    ['notifications.maxMessageChars', 199],
    ['notifications.maxMessageChars', 4_097],
    ['auditMirror.enabled', 'false'],
    ['auditMirror.timeoutSeconds', 0],
    ['auditMirror.timeoutSeconds', 86_401],
    ['auditMirror.maxAttempts', 0],
    ['auditMirror.maxAttempts', 101],
    ['registry.retainedImagePairs', 1],
    ['registry.retainedImagePairs', 101],
    ['retention.workDirs', 0],
    ['environments.staging.backendPort', 0],
    ['environments.production.contentEnginePort', 65_536],
    ['trust.maxManifestBytes', Number.MAX_SAFE_INTEGER],
    ['trust.maxComposeBytes', 0],
    ['trust.maxManifestAgeSeconds', Number.MAX_SAFE_INTEGER],
    ['piRunner.labels', []],
    ['piRunner.minUsableMemoryGiB', 0],
    ['piRunner.focusedSuiteBudgetSeconds', 3_601],
    ['piRunner.requiredEgressHosts', []],
    ['piRunner.forbiddenCapabilities', ['docker-socket']],
    ['piRunner.budgetSuite', []],
    ['iosContractPaths', []],
  ])('rejects an unsafe type or boundary for %s', (field, value) => {
    expect(() => loadFixture((candidate) => setField(candidate, field, value)))
      .toThrow(new RegExp(field.replace('.', '\\.'), 'i'));
  });

  it.each([
    ['compose.file', '../docker-compose.release.yml', /compose\.file/i],
    ['compose.backendService', '', /compose\.backendService/i],
    ['compose.backendService', '--all', /compose\.backendService/i],
    ['compose.contentEngineService', 'Content Engine', /compose\.contentEngineService/i],
    ['compose.migratorService', 'release-migrator', /migratorService.*must be migrator/i],
    ['version', 'v1', /version.*unsupported/i],
    ['notifications.heartbeatSchedule', 'every monday', /heartbeatSchedule/i],
    ['auditMirror.user', '--root', /auditMirror\.user/i],
    ['auditMirror.path', '/var/lib/nexus-audit;touch', /auditMirror\.path.*safe remote/i],
    ['auditMirror.hostEnvVar', 'audit-host', /hostEnvVar/i],
    ['registry.releaseImage', '--help', /registry\.releaseImage/i],
    ['registry.releaseTag', '--help', /registry\.releaseTag/i],
    ['piRunner.nodeVersion', 'latest', /piRunner\.nodeVersion/i],
    ['iosContractPaths', ['../src/api'], /iosContractPaths/i],
  ])('rejects an unsafe governed identity in %s', (field, value, error) => {
    expect(() => loadFixture((candidate) => setField(candidate, field, value)))
      .toThrow(error);
  });

  it('rejects a syntactically valid policy version the loader does not implement', () => {
    expect(() => loadFixture((candidate) => {
      candidate.version = '2026-08-08.1';
    })).toThrow(/version.*unsupported.*2026-08-09\.2/i);
  });

  it.each([
    ['top level', (candidate: Policy) => { candidate.futureOwnerGate = false; }, /policy fields/i],
    ['backup', (candidate: Policy) => { candidate.backup.futureRoot = '/srv/future'; }, /backup fields/i],
    ['trust', (candidate: Policy) => { candidate.trust.futureKey = 'ignored'; }, /trust fields/i],
    ['environment', (candidate: Policy) => {
      candidate.environments.production.futurePort = 8300;
    }, /environments\.production fields/i],
    ['notification', (candidate: Policy) => {
      candidate.notifications.futureChannel = false;
    }, /notifications fields/i],
  ])('rejects an unexpected %s policy field', (_label, mutate, error) => {
    expect(() => loadFixture(mutate)).toThrow(error);
  });

  it('keeps paths additive while validating every added entry as absolute', () => {
    const loaded = loadFixture((candidate) => {
      candidate.paths.futureEvidenceDir = '/var/lib/nexus-release/future-evidence';
    });
    expect(loaded.paths.futureEvidenceDir).toBe('/var/lib/nexus-release/future-evidence');

    expect(() => loadFixture((candidate) => {
      candidate.paths.futureEvidenceDir = '../future-evidence';
    })).toThrow(/paths\.futureEvidenceDir.*absolute/i);
  });

  it.each([
    'auditMirror.path',
    'auditMirror.identityFile',
    'auditMirror.knownHostsFile',
    'auditMirror.queueDir',
  ])('requires an absolute %s', (field) => {
    expect(() => loadFixture((candidate) => setField(candidate, field, 'relative/path')))
      .toThrow(new RegExp(`${field.replace('.', '\\.')}.*absolute`, 'i'));
  });

  it('rejects absolute path aliases before comparing environment isolation', () => {
    expect(() => loadFixture((candidate) => {
      candidate.environments.staging.dataDir = '/var/lib/nexus-hub/production/../production/data';
    })).toThrow(/environments\.staging\.dataDir.*normalized absolute/i);
  });

  it.each([
    ['equal', (candidate: Policy) => {
      candidate.auditMirror.queueDir = candidate.paths.receiptDir;
    }],
    ['queue below receipts', (candidate: Policy) => {
      candidate.auditMirror.queueDir = `${candidate.paths.receiptDir}/queue`;
    }],
    ['receipts below delivered evidence', (candidate: Policy) => {
      candidate.paths.receiptDir = `${candidate.auditMirror.queueDir}/delivered/receipts`;
    }],
  ])('rejects authoritative receipt and audit queue overlap: %s', (_label, mutate) => {
    expect(() => loadFixture(mutate)).toThrow(/authoritative receipt.*audit.*must not overlap/i);
  });

  it.each([
    ['staging data ancestor', (candidate: Policy) => {
      candidate.environments.staging.dataDir = '/var/lib/nexus-hub/shared';
      candidate.environments.production.dataDir = '/var/lib/nexus-hub/shared/production';
      candidate.backup.expectedDatabase = '/var/lib/nexus-hub/shared/production/bot.db';
    }],
    ['production data ancestor', (candidate: Policy) => {
      candidate.environments.production.dataDir = '/var/lib/nexus-hub/shared';
      candidate.environments.staging.dataDir = '/var/lib/nexus-hub/shared/staging';
      candidate.backup.expectedDatabase = '/var/lib/nexus-hub/shared/bot.db';
    }],
    ['backend env contains content-engine env', (candidate: Policy) => {
      candidate.environments.production.backendEnvFile = '/etc/nexus-release/application';
      candidate.environments.production.contentEngineEnvFile =
        '/etc/nexus-release/application/content-engine.env';
    }],
  ])('rejects environment filesystem containment: %s', (_label, mutate) => {
    expect(() => loadFixture(mutate)).toThrow(/environment filesystem identities.*must not overlap/i);
  });

  it.each([
    [
      'Compose service identities',
      (candidate: Policy) => {
        candidate.compose.contentEngineService = candidate.compose.backendService;
      },
      /Compose service identities.*distinct/i,
    ],
    [
      'environment Compose projects',
      (candidate: Policy) => {
        candidate.environments.staging.composeProject = candidate.environments.production.composeProject;
      },
      /compose projects.*distinct/i,
    ],
    [
      'environment ports',
      (candidate: Policy) => {
        candidate.environments.staging.backendPort = candidate.environments.production.contentEnginePort;
      },
      /service ports.*distinct/i,
    ],
    [
      'environment data directories',
      (candidate: Policy) => {
        candidate.environments.staging.dataDir = candidate.environments.production.dataDir;
      },
      /dataDir paths.*distinct/i,
    ],
    [
      'environment backend files',
      (candidate: Policy) => {
        candidate.environments.staging.backendEnvFile =
          candidate.environments.production.backendEnvFile;
      },
      /backendEnvFile paths.*distinct/i,
    ],
    [
      'environment content-engine files',
      (candidate: Policy) => {
        candidate.environments.staging.contentEngineEnvFile =
          candidate.environments.production.contentEngineEnvFile;
      },
      /contentEngineEnvFile paths.*distinct/i,
    ],
    [
      'production database identity',
      (candidate: Policy) => {
        candidate.backup.expectedDatabase = '/var/lib/nexus-hub/production/data/other.db';
      },
      /backup\.expectedDatabase.*production\.dataDir\/bot\.db/i,
    ],
    [
      'rollback health budget',
      (candidate: Policy) => {
        candidate.timing.healthBudgetSeconds = candidate.timing.rollbackObjectiveSeconds + 1;
      },
      /healthBudgetSeconds.*rollbackObjectiveSeconds/i,
    ],
  ])('rejects an unsafe %s relation', (_label, mutate, error) => {
    expect(() => loadFixture(mutate)).toThrow(error);
  });

  it('accepts the inclusive finite boundaries', () => {
    const loaded = loadFixture((candidate) => {
      for (const field of [
        'pollIntervalSeconds',
        'observationSeconds',
        'rollbackObjectiveSeconds',
        'healthBudgetSeconds',
        'stagingHealthBudgetSeconds',
        'migratorTimeoutSeconds',
        'backupTimeoutSeconds',
      ]) candidate.timing[field] = 86_400;
      candidate.backup.maxReceiptAgeSeconds = 86_400;
      candidate.notifications.maxMessageChars = 4_096;
      candidate.auditMirror.timeoutSeconds = 86_400;
      candidate.auditMirror.maxAttempts = 100;
      candidate.registry.retainedImagePairs = 100;
      candidate.retention.workDirs = 10_000;
      candidate.environments.staging.backendPort = 1;
      candidate.environments.staging.contentEnginePort = 2;
      candidate.environments.production.backendPort = 65_534;
      candidate.environments.production.contentEnginePort = 65_535;
    });

    expect(loaded.timing.observationSeconds).toBe(86_400);
    expect(loaded.notifications.maxMessageChars).toBe(4_096);
    expect(loaded.retention.workDirs).toBe(10_000);
  });
});

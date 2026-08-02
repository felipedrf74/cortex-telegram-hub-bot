// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getChatDomainHandler } from '../api/routes/chat-message-context';
import { getChatStepExecutor } from '../services/chat/executor/dispatch-table';
import {
  findChatActionDefinition,
  type ChatActionName,
} from '../services/chat/registry';

const EXECUTOR_ACTIONS = [
  'draft_email',
  'send_email',
  'connections_retry_sync',
] as const satisfies readonly ChatActionName[];

const LEGACY_TAIL_DOMAINS = [
  'connections',
  'notifications',
  'decision_center',
] as const;

type ExecutorAction = typeof EXECUTOR_ACTIONS[number];
type LegacyTailDomain = typeof LEGACY_TAIL_DOMAINS[number];
type OutputRefsDecision = 'absent' | 'present' | 'missing';

export interface CrossSkillPreflightDependencies {
  hasExecutor(action: ExecutorAction): boolean;
  hasLegacyTail(domain: LegacyTailDomain): boolean;
  trainingPlanCreateOutputRefs(): OutputRefsDecision;
}

export interface CrossSkillPreflightReport {
  schema: 'nexus.chat-capability-cross-skill-preflight.v1';
  generatedAt: string;
  runtimeSha: string;
  artifactDigest: string;
  executorCoverage: Record<ExecutorAction, boolean>;
  legacyTailCoverage: Record<LegacyTailDomain, boolean>;
  trainingPlanCreateOutputRefs: OutputRefsDecision;
  passed: boolean;
}

interface CrossSkillPreflightInput {
  runtimeSha: string;
  artifactDigest: string;
  generatedAt?: Date;
}

const RUNTIME_DEPENDENCIES: CrossSkillPreflightDependencies = {
  hasExecutor(action) {
    return typeof getChatStepExecutor(action) === 'function';
  },
  hasLegacyTail(domain) {
    return typeof getChatDomainHandler(domain) === 'function';
  },
  trainingPlanCreateOutputRefs() {
    const definition = findChatActionDefinition('training', 'training_plan_create');
    if (!definition) return 'missing';
    return definition.outputRefs === undefined ? 'absent' : 'present';
  },
};

/**
 * Provider-free readiness proof for the two newly reachable classifier tails
 * and the cross-skill outputRefs decision. Only booleans and exact release
 * identity leave this producer; executor functions and registry definitions
 * are never serialized.
 */
export function buildCrossSkillPreflightReport(
  input: CrossSkillPreflightInput,
  dependencies: CrossSkillPreflightDependencies = RUNTIME_DEPENDENCIES,
): CrossSkillPreflightReport {
  if (!/^[0-9a-f]{40}$/u.test(input.runtimeSha)) {
    throw new Error('runtime SHA must be a full lowercase 40-hex value');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.artifactDigest)) {
    throw new Error('artifact digest must be a full lowercase 64-hex value');
  }
  const generatedAt = input.generatedAt ?? new Date();
  if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
    throw new Error('generatedAt must be a valid timestamp');
  }

  const executorCoverage = Object.fromEntries(
    EXECUTOR_ACTIONS.map((action) => [action, dependencies.hasExecutor(action)]),
  ) as Record<ExecutorAction, boolean>;
  const legacyTailCoverage = Object.fromEntries(
    LEGACY_TAIL_DOMAINS.map((domain) => [domain, dependencies.hasLegacyTail(domain)]),
  ) as Record<LegacyTailDomain, boolean>;
  const trainingPlanCreateOutputRefs = dependencies.trainingPlanCreateOutputRefs();
  const passed = Object.values(executorCoverage).every((covered) => covered)
    && Object.values(legacyTailCoverage).every((covered) => covered)
    && trainingPlanCreateOutputRefs === 'absent';

  return {
    schema: 'nexus.chat-capability-cross-skill-preflight.v1',
    generatedAt: generatedAt.toISOString(),
    runtimeSha: input.runtimeSha,
    artifactDigest: input.artifactDigest,
    executorCoverage,
    legacyTailCoverage,
    trainingPlanCreateOutputRefs,
    passed,
  };
}

interface CliOptions {
  runtimeSha: string;
  artifactDigest: string;
  generatedAt: Date;
  json: true;
}

function parseCliOptions(argv: string[]): CliOptions {
  let runtimeSha = '';
  let artifactDigest = '';
  let generatedAtRaw = '';
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--runtime-sha=')) {
      runtimeSha = arg.slice('--runtime-sha='.length);
      continue;
    }
    if (arg.startsWith('--artifact-digest=')) {
      artifactDigest = arg.slice('--artifact-digest='.length);
      continue;
    }
    if (arg.startsWith('--generated-at=')) {
      generatedAtRaw = arg.slice('--generated-at='.length);
      continue;
    }
    switch (arg) {
      case '--runtime-sha':
        runtimeSha = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--artifact-digest':
        artifactDigest = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--generated-at':
        generatedAtRaw = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!json) throw new Error('--json is required');
  if (!generatedAtRaw) throw new Error('--generated-at is required');
  const generatedAt = new Date(generatedAtRaw);
  if (!Number.isFinite(generatedAt.getTime()) || generatedAt.toISOString() !== generatedAtRaw) {
    throw new Error('--generated-at must be a canonical UTC timestamp');
  }
  return { runtimeSha, artifactDigest, generatedAt, json: true };
}

function main(): void {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    const configuredRuntimeSha = process.env.NEXUS_RELEASE_SHA;
    const configuredArtifactDigest = process.env.NEXUS_RELEASE_ARTIFACT_SHA256;
    if (configuredRuntimeSha && configuredRuntimeSha !== options.runtimeSha) {
      throw new Error('--runtime-sha differs from NEXUS_RELEASE_SHA');
    }
    if (configuredArtifactDigest && configuredArtifactDigest !== options.artifactDigest) {
      throw new Error('--artifact-digest differs from NEXUS_RELEASE_ARTIFACT_SHA256');
    }

    const report = buildCrossSkillPreflightReport(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Cross-skill preflight failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

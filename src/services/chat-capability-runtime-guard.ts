// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Fail-closed runtime interlock for governed chat capability transactions.
 *
 * A flag transaction changes the shared release `.env` before it can publish
 * its final receipt. While the durable rollback marker exists, every runtime
 * flag decision requires a short-lived permit bound to the exact environment
 * bytes and a controller process that is still alive in this boot. A killed
 * controller, PID reuse, or reboot therefore forces all governed capabilities
 * off even if PM2 resurrects a process from the uncommitted `.env`.
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CAPABILITY_FLAGS = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
  'AI_ROUTING_MANIFEST_KILL',
] as const;

type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
type CapabilityState = Record<CapabilityFlag, boolean>;
type ReleaseRole = 'staging' | 'production';

export type ChatCapabilityRuntimeGuardStatus = {
  status: 'clear' | 'authorized' | 'forced_off';
  reason: string;
  transactionId: string | null;
  planDigest: string | null;
};

type ControllerIdentity = {
  pid: number;
  startTicks: string;
  bootId: string;
};

export interface ChatCapabilityRuntimeGuardIo {
  expectedBaseDirs?: Record<ReleaseRole, string>;
  stateRoot?: string;
  nowMs?: () => number;
  currentUid?: () => number;
  readControllerIdentity?: (pid: number) => ControllerIdentity | null;
}

const DEFAULT_BASE_DIRS: Record<ReleaseRole, string> = {
  staging: path.join(homedir(), 'telegram-hub-bot-staging'),
  production: path.join(homedir(), 'telegram-hub-bot'),
};
const DEFAULT_STATE_ROOT = path.join(homedir(), '.local/state/nexus-release/chat-capability-flags');
const MARKER_PREFIX = '.env.before-chat-capability-';
const TRANSACTION_ID = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/u;
const RUNTIME_SHA = /^[0-9a-f]{40}$/u;
const ARTIFACT_DIGEST = /^[0-9a-f]{64}$/u;
const PLAN_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function forced(reason: string, transactionId: string | null = null): ChatCapabilityRuntimeGuardStatus {
  return { status: 'forced_off', reason, transactionId, planDigest: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return observed.length === wanted.length
    && observed.every((key, index) => key === wanted[index]);
}

function parseBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function processFlagState(env: NodeJS.ProcessEnv): CapabilityState {
  return Object.fromEntries(CAPABILITY_FLAGS.map((flag) => [
    flag,
    parseBoolean(env[flag]),
  ])) as CapabilityState;
}

function dotenvFlagState(source: string): CapabilityState {
  const values = new Map<CapabilityFlag, boolean>();
  const governed = new Set<string>(CAPABILITY_FLAGS);
  for (const line of source.split(/\r?\n/u)) {
    const candidate = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/u);
    if (!candidate || !governed.has(candidate[1])) continue;
    const exact = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(true|false)\s*$/u);
    if (!exact) throw new Error('governed capability assignment is not canonical');
    const flag = exact[1] as CapabilityFlag;
    if (values.has(flag)) throw new Error('duplicate governed capability assignment');
    values.set(flag, exact[2] === 'true');
  }
  return Object.fromEntries(CAPABILITY_FLAGS.map((flag) => [
    flag,
    values.get(flag) ?? false,
  ])) as CapabilityState;
}

function exactCapabilityState(value: unknown): CapabilityState | null {
  if (!isPlainObject(value) || !hasExactKeys(value, CAPABILITY_FLAGS)) return null;
  const entries: Array<[CapabilityFlag, boolean]> = [];
  for (const flag of CAPABILITY_FLAGS) {
    if (typeof value[flag] !== 'boolean') return null;
    entries.push([flag, value[flag]]);
  }
  return Object.fromEntries(entries) as CapabilityState;
}

function equalState(left: CapabilityState, right: CapabilityState): boolean {
  return CAPABILITY_FLAGS.every((flag) => left[flag] === right[flag]);
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function safePrivateFile(filePath: string, uid: number): boolean {
  const stat = lstatSync(filePath);
  return stat.isFile() && !stat.isSymbolicLink()
    && (stat.mode & 0o777) === 0o600 && stat.uid === uid;
}

function defaultControllerIdentity(pid: number): ControllerIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const close = stat.lastIndexOf(')');
    if (close < 1) return null;
    const fieldsFromState = stat.slice(close + 2).split(/\s+/u);
    const startTicks = fieldsFromState[19];
    if (!/^[0-9]+$/u.test(startTicks ?? '')
        || !/^[0-9a-f-]{16,64}$/iu.test(bootId)) return null;
    return { pid, startTicks, bootId };
  } catch {
    return null;
  }
}

function deploymentExpected(env: NodeJS.ProcessEnv): boolean {
  return env.NEXUS_RELEASE_ROLE === 'staging' || env.NEXUS_RELEASE_ROLE === 'production'
    || env.NODE_ENV === 'staging' || env.NODE_ENV === 'production';
}

export function getChatCapabilityRuntimeGuardStatus(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ChatCapabilityRuntimeGuardIo = {},
): ChatCapabilityRuntimeGuardStatus {
  if (!deploymentExpected(env)) {
    return {
      status: 'clear',
      reason: 'not_deployed_runtime',
      transactionId: null,
      planDigest: null,
    };
  }

  const role = env.NEXUS_RELEASE_ROLE;
  if (role !== 'staging' && role !== 'production') return forced('invalid_release_role');
  const expectedBaseDirs = overrides.expectedBaseDirs ?? DEFAULT_BASE_DIRS;
  const expectedBaseDir = expectedBaseDirs[role];
  const baseDir = env.NEXUS_RELEASE_BASE_DIR;
  const runtimeSha = env.NEXUS_RELEASE_SHA ?? env.GIT_COMMIT;
  const artifactDigest = env.NEXUS_RELEASE_ARTIFACT_SHA256;
  if (!expectedBaseDir || baseDir !== expectedBaseDir
      || !RUNTIME_SHA.test(runtimeSha ?? '')
      || !ARTIFACT_DIGEST.test(artifactDigest ?? '')) {
    return forced('invalid_release_identity');
  }

  const uid = overrides.currentUid?.() ?? process.getuid?.() ?? -1;
  const stateRoot = overrides.stateRoot ?? DEFAULT_STATE_ROOT;
  let transactionId: string | null = null;
  try {
    const baseStat = lstatSync(baseDir);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()
        || realpathSync(baseDir) !== realpathSync(expectedBaseDir)) {
      return forced('unsafe_release_base');
    }
    const markerNames = readdirSync(baseDir)
      .filter((name) => name.startsWith(MARKER_PREFIX));
    if (markerNames.length === 0) {
      return {
        status: 'clear',
        reason: 'no_unresolved_transaction',
        transactionId: null,
        planDigest: null,
      };
    }
    if (markerNames.length !== 1) return forced('ambiguous_transaction_markers');
    const markerName = markerNames[0];
    transactionId = markerName.slice(MARKER_PREFIX.length);
    if (!TRANSACTION_ID.test(transactionId)) return forced('invalid_transaction_marker');
    const markerPath = path.join(baseDir, markerName);
    if (!safePrivateFile(markerPath, uid)) return forced('unsafe_transaction_marker', transactionId);

    const environmentPath = path.join(baseDir, '.env');
    if (!safePrivateFile(environmentPath, uid)) return forced('unsafe_environment', transactionId);
    const environmentSource = readFileSync(environmentPath, 'utf8');
    const environmentFlags = dotenvFlagState(environmentSource);
    const runtimeFlags = processFlagState(env);

    const permitPath = path.join(stateRoot, `${role}.runtime-permit.json`);
    if (!safePrivateFile(permitPath, uid)) return forced('unsafe_runtime_permit', transactionId);
    const permit = JSON.parse(readFileSync(permitPath, 'utf8')) as unknown;
    const permitKeys = [
      'schema',
      'transactionId',
      'planDigest',
      'role',
      'runtimeSha',
      'artifactDigest',
      'phase',
      'environmentSha256',
      'configuredFlags',
      'controller',
      'issuedAt',
      'expiresAt',
    ];
    if (!isPlainObject(permit) || !hasExactKeys(permit, permitKeys)) {
      return forced('invalid_runtime_permit_schema', transactionId);
    }
    const controller = permit.controller;
    const permitFlags = exactCapabilityState(permit.configuredFlags);
    if (permit.schema !== 'nexus.chat-capability-runtime-permit.v1'
        || permit.transactionId !== transactionId
        || !PLAN_DIGEST.test(String(permit.planDigest ?? ''))
        || permit.role !== role || permit.runtimeSha !== runtimeSha
        || permit.artifactDigest !== artifactDigest
        || !['apply', 'rollback', 'committed_recovery'].includes(String(permit.phase ?? ''))
        || !/^[0-9a-f]{64}$/u.test(String(permit.environmentSha256 ?? ''))
        || !permitFlags || !isPlainObject(controller)
        || !hasExactKeys(controller, ['pid', 'startTicks', 'bootId'])
        || !Number.isSafeInteger(controller.pid) || Number(controller.pid) < 1
        || !/^[0-9]+$/u.test(String(controller.startTicks ?? ''))
        || !/^[0-9a-f-]{16,64}$/iu.test(String(controller.bootId ?? ''))) {
      return forced('invalid_runtime_permit_binding', transactionId);
    }
    const issuedAt = Date.parse(String(permit.issuedAt ?? ''));
    const expiresAt = Date.parse(String(permit.expiresAt ?? ''));
    const now = overrides.nowMs?.() ?? Date.now();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
        || new Date(issuedAt).toISOString() !== permit.issuedAt
        || new Date(expiresAt).toISOString() !== permit.expiresAt
        || expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60_000
        || now < issuedAt || now > expiresAt) {
      return forced('expired_runtime_permit', transactionId);
    }
    if (permit.environmentSha256 !== sha256(environmentSource)
        || !equalState(permitFlags, environmentFlags)
        || !equalState(permitFlags, runtimeFlags)) {
      return forced('runtime_permit_environment_mismatch', transactionId);
    }
    const observed = (overrides.readControllerIdentity ?? defaultControllerIdentity)(
      Number(controller.pid),
    );
    if (!observed || observed.pid !== controller.pid
        || observed.startTicks !== controller.startTicks
        || observed.bootId !== controller.bootId) {
      return forced('runtime_permit_controller_not_live', transactionId);
    }
    return {
      status: 'authorized',
      reason: 'live_transaction_permit',
      transactionId,
      planDigest: String(permit.planDigest),
    };
  } catch {
    return forced('runtime_guard_read_failed', transactionId);
  }
}

export function chatCapabilityRuntimeAllowsFlags(): boolean {
  return getChatCapabilityRuntimeGuardStatus().status !== 'forced_off';
}

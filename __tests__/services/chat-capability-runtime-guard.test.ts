import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getChatCapabilityRuntimeGuardStatus,
  type ChatCapabilityRuntimeGuardIo,
} from '../../src/services/chat-capability-runtime-guard';

const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const TRANSACTION_ID = '20260802T010203Z-abcdef123456';
const NOW = Date.parse('2026-08-02T01:03:00.000Z');
const FLAGS = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
  'AI_ROUTING_MANIFEST_KILL',
] as const;

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function state(classifier = true): Record<(typeof FLAGS)[number], boolean> {
  return Object.fromEntries(FLAGS.map((flag) => [
    flag,
    flag === 'AI_ROUTING_MANIFEST_CLASSIFIER' ? classifier : false,
  ])) as Record<(typeof FLAGS)[number], boolean>;
}

function dotenv(configured = state()): string {
  return `${FLAGS.map((flag) => `${flag}=${configured[flag]}`).join('\n')}\n`;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-capability-guard-'));
  temporaryRoots.push(root);
  const baseDir = path.join(root, 'production');
  const stateRoot = path.join(root, 'state');
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const configured = state();
  const environment = dotenv(configured);
  writeFileSync(path.join(baseDir, '.env'), environment, { mode: 0o600 });
  writeFileSync(
    path.join(baseDir, `.env.before-chat-capability-${TRANSACTION_ID}`),
    dotenv(state(false)),
    { mode: 0o600 },
  );
  const permitPath = path.join(stateRoot, 'production.runtime-permit.json');
  const permit = {
    schema: 'nexus.chat-capability-runtime-permit.v1',
    transactionId: TRANSACTION_ID,
    planDigest: PLAN_DIGEST,
    role: 'production',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    phase: 'apply',
    environmentSha256: sha256(environment),
    configuredFlags: configured,
    controller: {
      pid: 4201,
      startTicks: '9001',
      bootId: '11111111-1111-4111-8111-111111111111',
    },
    issuedAt: '2026-08-02T01:02:00.000Z',
    expiresAt: '2026-08-02T01:07:00.000Z',
  };
  writeFileSync(permitPath, `${JSON.stringify(permit)}\n`, { mode: 0o600 });
  chmodSync(permitPath, 0o600);
  const env = {
    NODE_ENV: 'production',
    NEXUS_RELEASE_ROLE: 'production',
    NEXUS_RELEASE_BASE_DIR: baseDir,
    NEXUS_RELEASE_SHA: RUNTIME_SHA,
    NEXUS_RELEASE_ARTIFACT_SHA256: ARTIFACT_DIGEST,
    ...Object.fromEntries(FLAGS.map((flag) => [flag, configured[flag] ? 'true' : 'false'])),
  };
  const io: ChatCapabilityRuntimeGuardIo = {
    expectedBaseDirs: { production: baseDir, staging: path.join(root, 'staging') },
    stateRoot,
    nowMs: () => NOW,
    currentUid: () => process.getuid?.() ?? 501,
    readControllerIdentity: () => ({
      pid: 4201,
      startTicks: '9001',
      bootId: '11111111-1111-4111-8111-111111111111',
    }),
  };
  return { root, baseDir, stateRoot, permitPath, permit, env, io, configured };
}

describe('chat capability runtime guard', () => {
  it('is clear without an unresolved transaction marker', () => {
    const item = fixture();
    rmSync(path.join(item.baseDir, `.env.before-chat-capability-${TRANSACTION_ID}`));
    expect(getChatCapabilityRuntimeGuardStatus(item.env, item.io)).toEqual({
      status: 'clear',
      reason: 'no_unresolved_transaction',
      transactionId: null,
      planDigest: null,
    });
  });

  it('authorizes only an exact live-controller permit bound to env bytes and release identity', () => {
    const item = fixture();
    expect(getChatCapabilityRuntimeGuardStatus(item.env, item.io)).toEqual({
      status: 'authorized',
      reason: 'live_transaction_permit',
      transactionId: TRANSACTION_ID,
      planDigest: PLAN_DIGEST,
    });
  });

  it.each([
    ['dead controller', (item: ReturnType<typeof fixture>) => {
      item.io.readControllerIdentity = () => null;
    }],
    ['reboot identity', (item: ReturnType<typeof fixture>) => {
      item.io.readControllerIdentity = () => ({
        pid: 4201,
        startTicks: '9001',
        bootId: '22222222-2222-4222-8222-222222222222',
      });
    }],
    ['PID reuse', (item: ReturnType<typeof fixture>) => {
      item.io.readControllerIdentity = () => ({
        pid: 4201,
        startTicks: '9002',
        bootId: '11111111-1111-4111-8111-111111111111',
      });
    }],
    ['expired permit', (item: ReturnType<typeof fixture>) => {
      item.io.nowMs = () => Date.parse('2026-08-02T01:07:00.001Z');
    }],
    ['changed environment', (item: ReturnType<typeof fixture>) => {
      writeFileSync(path.join(item.baseDir, '.env'), dotenv(state(false)), { mode: 0o600 });
    }],
    ['changed process flags', (item: ReturnType<typeof fixture>) => {
      item.env.AI_ROUTING_MANIFEST_CLASSIFIER = 'false';
    }],
    ['wrong release tuple', (item: ReturnType<typeof fixture>) => {
      item.env.NEXUS_RELEASE_SHA = 'd'.repeat(40);
    }],
  ])('forces every capability off for %s', (_label, mutate) => {
    const item = fixture();
    mutate(item);
    expect(getChatCapabilityRuntimeGuardStatus(item.env, item.io)).toMatchObject({
      status: 'forced_off',
      transactionId: TRANSACTION_ID,
      planDigest: null,
    });
  });

  it('fails closed for multiple markers, symbolic permits, malformed deployment identity, or unsafe base', () => {
    const multiple = fixture();
    writeFileSync(
      path.join(multiple.baseDir, '.env.before-chat-capability-20260802T010204Z-fedcba654321'),
      dotenv(state(false)),
      { mode: 0o600 },
    );
    expect(getChatCapabilityRuntimeGuardStatus(multiple.env, multiple.io).status).toBe('forced_off');

    const symbolic = fixture();
    rmSync(symbolic.permitPath);
    const target = path.join(symbolic.root, 'permit-target.json');
    writeFileSync(target, `${JSON.stringify(symbolic.permit)}\n`, { mode: 0o600 });
    symlinkSync(target, symbolic.permitPath);
    expect(getChatCapabilityRuntimeGuardStatus(symbolic.env, symbolic.io).status).toBe('forced_off');

    const malformed = fixture();
    malformed.env.NEXUS_RELEASE_ARTIFACT_SHA256 = 'short';
    expect(getChatCapabilityRuntimeGuardStatus(malformed.env, malformed.io).status).toBe('forced_off');

    const escaped = fixture();
    escaped.env.NEXUS_RELEASE_BASE_DIR = path.join(escaped.root, 'other');
    expect(getChatCapabilityRuntimeGuardStatus(escaped.env, escaped.io).status).toBe('forced_off');
  });
});

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const HELPER = path.join(ROOT, 'scripts/lib/chat-capability-flag-transaction.mjs');

const PLAN_SCHEMA = 'nexus.chat-capability-secret-plan.v1';
const RECEIPT_SCHEMA = 'nexus.chat-capability-secret-transaction.v1';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const GENERATED_AT = '2026-08-02T02:03:04.000Z';
const TRANSACTION_ID = '20260802T020304Z-abcdef123456';

const CLASSIFIER_HMAC = 'CLASSIFY_SHADOW_HASH_SECRET';
const CHAT_V2_HMAC = 'CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET';
const HMAC_NAMES = [CLASSIFIER_HMAC, CHAT_V2_HMAC] as const;

type HmacName = (typeof HMAC_NAMES)[number];
type SecretPresence = Record<HmacName, boolean>;

const CLASSIFIER_EXISTING = 'classifier-existing-private-sentinel-'.repeat(2);
const CHAT_V2_EXISTING = 'chat-v2-existing-private-sentinel-'.repeat(2);
const CLASSIFIER_GENERATED = 'classifier-generated-private-sentinel-'.repeat(2);
const CHAT_V2_GENERATED = 'chat-v2-generated-private-sentinel-'.repeat(2);
const PRIVATE_VALUES = [
  CLASSIFIER_EXISTING,
  CHAT_V2_EXISTING,
  CLASSIFIER_GENERATED,
  CHAT_V2_GENERATED,
];

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadHelper(): Promise<any> {
  return import(pathToFileURL(HELPER).href);
}

function presence(classifier: boolean, chatV2: boolean): SecretPresence {
  return {
    [CLASSIFIER_HMAC]: classifier,
    [CHAT_V2_HMAC]: chatV2,
  };
}

function buildPlanInput(
  role: 'staging' | 'production',
  secretPresence: SecretPresence,
): Record<string, unknown> {
  return {
    role,
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    secretPresence,
    previousPlanSequence: 4,
    generatedAt: GENERATED_AT,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectNoPrivateSecretMetadata(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const privateValue of PRIVATE_VALUES) {
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(sha256(privateValue));
  }
  expect(serialized).not.toMatch(
    /"(?:secretValue|secretHash|secretSha256|secretDigest|secretFingerprint|valueLength|secretLength|secretBytes)"/iu,
  );
}

describe('chat capability HMAC transaction', () => {
  it('pins staging to preserve existing HMACs and generate only missing HMACs', async () => {
    const helper = await loadHelper();
    expect(helper.CHAT_CAPABILITY_HMAC_NAMES).toEqual(HMAC_NAMES);

    const bothMissing = helper.buildCapabilitySecretPlan(
      buildPlanInput('staging', presence(false, false)),
    );
    expect(bothMissing).toMatchObject({
      schema: PLAN_SCHEMA,
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      previousPlanSequence: 4,
      planSequence: 5,
      generatedAt: GENERATED_AT,
      policy: {
        [CLASSIFIER_HMAC]: 'generate_if_missing',
        [CHAT_V2_HMAC]: 'generate_if_missing',
      },
      presentBefore: presence(false, false),
      actions: {
        [CLASSIFIER_HMAC]: 'generate',
        [CHAT_V2_HMAC]: 'generate',
      },
    });
    expect(bothMissing.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expectNoPrivateSecretMetadata(bothMissing);

    const oneExisting = helper.buildCapabilitySecretPlan(
      buildPlanInput('staging', presence(true, false)),
    );
    expect(oneExisting).toMatchObject({
      presentBefore: presence(true, false),
      actions: {
        [CLASSIFIER_HMAC]: 'preserve',
        [CHAT_V2_HMAC]: 'generate',
      },
    });

    const generated: HmacName[] = [];
    const source = [
      '# preserve comments and unrelated private values',
      `PORTAL_TOKEN=${'unrelated-private-value-'.repeat(3)}`,
      `${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}`,
      'UNMANAGED_SETTING=unchanged',
      '',
    ].join('\n');
    expect(helper.readCapabilitySecretPresence(source)).toEqual(presence(true, false));
    expect(() => helper.readCapabilitySecretPresence(
      `${source}${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}\n`,
    )).toThrow(/duplicate/i);
    for (const invalidAssignment of [
      `${CLASSIFIER_HMAC}=\n`,
      `${CLASSIFIER_HMAC}=# comment is not a secret\n`,
      `${CLASSIFIER_HMAC}=too-short\n`,
      `${CLASSIFIER_HMAC}="${CLASSIFIER_EXISTING}"\n`,
    ]) {
      expect(() => helper.readCapabilitySecretPresence(invalidAssignment))
        .toThrow(/HMAC|secret|canonical|invalid|strong/i);
    }
    const rewritten = helper.rewriteCapabilitySecretDotenv({
      source,
      plan: oneExisting,
      generateSecret(name: HmacName): string {
        generated.push(name);
        return name === CLASSIFIER_HMAC ? CLASSIFIER_GENERATED : CHAT_V2_GENERATED;
      },
    });

    expect(generated).toEqual([CHAT_V2_HMAC]);
    expect(rewritten.contents).toContain(`${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}\n`);
    expect(rewritten.contents).toContain(`${CHAT_V2_HMAC}=${CHAT_V2_GENERATED}\n`);
    expect(rewritten.contents).not.toContain(CLASSIFIER_GENERATED);
    expect(rewritten.contents).toContain('UNMANAGED_SETTING=unchanged\n');
    expect(rewritten.actions).toEqual(oneExisting.actions);

    const repeated = helper.buildCapabilitySecretPlan(
      buildPlanInput('staging', presence(false, false)),
    );
    expect(repeated).toEqual(bothMissing);
  });

  it('requires the classifier HMAC in production while allowing only the missing ChatV2 HMAC to be generated', async () => {
    const helper = await loadHelper();

    expect(() => helper.buildCapabilitySecretPlan(
      buildPlanInput('production', presence(false, false)),
    )).toThrow(/production|CLASSIFY_SHADOW_HASH_SECRET|required|existing/i);
    expect(() => helper.buildCapabilitySecretPlan(
      buildPlanInput('production', presence(false, true)),
    )).toThrow(/production|CLASSIFY_SHADOW_HASH_SECRET|required|existing/i);

    const missingChatV2 = helper.buildCapabilitySecretPlan(
      buildPlanInput('production', presence(true, false)),
    );
    expect(missingChatV2).toMatchObject({
      schema: PLAN_SCHEMA,
      role: 'production',
      policy: {
        [CLASSIFIER_HMAC]: 'require_existing',
        [CHAT_V2_HMAC]: 'generate_if_missing',
      },
      presentBefore: presence(true, false),
      actions: {
        [CLASSIFIER_HMAC]: 'preserve',
        [CHAT_V2_HMAC]: 'generate',
      },
    });
    expectNoPrivateSecretMetadata(missingChatV2);

    const bothExisting = helper.buildCapabilitySecretPlan(
      buildPlanInput('production', presence(true, true)),
    );
    expect(bothExisting.actions).toEqual({
      [CLASSIFIER_HMAC]: 'preserve',
      [CHAT_V2_HMAC]: 'preserve',
    });

    const generated: HmacName[] = [];
    const source = [
      `${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}`,
      `${CHAT_V2_HMAC}=${CHAT_V2_EXISTING}`,
      '',
    ].join('\n');
    const rewritten = helper.rewriteCapabilitySecretDotenv({
      source,
      plan: bothExisting,
      generateSecret(name: HmacName): string {
        generated.push(name);
        return name === CLASSIFIER_HMAC ? CLASSIFIER_GENERATED : CHAT_V2_GENERATED;
      },
    });
    expect(generated).toEqual([]);
    expect(rewritten.contents).toBe(source);
    expect(rewritten.contents).toContain(`${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}`);
    expect(rewritten.contents).toContain(`${CHAT_V2_HMAC}=${CHAT_V2_EXISTING}`);

    expect(() => helper.rewriteCapabilitySecretDotenv({
      source: `${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}\n`,
      plan: bothExisting,
      generateSecret: () => CHAT_V2_GENERATED,
    })).toThrow(/stale|presence|changed|ChatV2|CHAT_CORE/i);
  });

  it('emits a strict receipt containing actions but no secret value, derivative hash, or length', async () => {
    const helper = await loadHelper();
    const plan = helper.buildCapabilitySecretPlan(
      buildPlanInput('staging', presence(true, false)),
    );
    const receipt = helper.buildCapabilitySecretReceipt({
      plan,
      transactionId: TRANSACTION_ID,
      status: 'passed',
      startedAt: GENERATED_AT,
      completedAt: '2026-08-02T02:03:09.000Z',
      health: { backend: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });

    expect(receipt).toMatchObject({
      schema: RECEIPT_SCHEMA,
      transactionId: TRANSACTION_ID,
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planDigest: plan.planDigest,
      planSequence: plan.planSequence,
      actions: plan.actions,
      status: 'passed',
      health: { backend: 'passed', identity: 'passed' },
      rollback: { status: 'not_required' },
    });
    expect(helper.validateCapabilitySecretReceipt(receipt)).toEqual(receipt);
    expectNoPrivateSecretMetadata(receipt);

    for (const forbidden of [
      { secretValue: CLASSIFIER_EXISTING },
      { secretHash: sha256(CLASSIFIER_EXISTING) },
      { secretLength: CLASSIFIER_EXISTING.length },
      { values: { [CLASSIFIER_HMAC]: CLASSIFIER_EXISTING } },
      { unexpected: true },
    ]) {
      expect(() => helper.validateCapabilitySecretReceipt({ ...receipt, ...forbidden }))
        .toThrow(/schema|field|unknown|forbidden/i);
    }
  });

  it('atomically compare-and-swaps the private dotenv and restores only the exact applied bytes', async () => {
    const helper = await loadHelper();
    const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-secret-transaction-'));
    temporaryRoots.push(root);
    const dotenvPath = path.join(root, '.env');
    const backupPath = path.join(root, '.env.before');
    const before = `${CLASSIFIER_HMAC}=${CLASSIFIER_EXISTING}\n`;
    const after = `${before}${CHAT_V2_HMAC}=${CHAT_V2_GENERATED}\n`;
    writeFileSync(dotenvPath, before, { mode: 0o600 });

    expect(() => helper.replaceCapabilitySecretDotenvFile({
      filePath: dotenvPath,
      backupPath,
      expectedContents: `${before}stale=true\n`,
      nextContents: after,
    })).toThrow(/compare|swap|stale|changed/i);
    expect(readFileSync(dotenvPath, 'utf8')).toBe(before);
    expect(readdirSync(root)).toEqual(['.env']);

    helper.replaceCapabilitySecretDotenvFile({
      filePath: dotenvPath,
      backupPath,
      expectedContents: before,
      nextContents: after,
    });
    expect(readFileSync(dotenvPath, 'utf8')).toBe(after);
    expect(readFileSync(backupPath, 'utf8')).toBe(before);
    expect(statSync(dotenvPath).mode & 0o777).toBe(0o600);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).sort()).toEqual(['.env', '.env.before']);

    writeFileSync(dotenvPath, `${after}tampered=true\n`, { mode: 0o600 });
    expect(() => helper.restoreCapabilitySecretDotenvFile({
      filePath: dotenvPath,
      backupPath,
      expectedContents: after,
    })).toThrow(/compare|swap|stale|changed/i);
    expect(readFileSync(dotenvPath, 'utf8')).toContain('tampered=true');

    writeFileSync(dotenvPath, after, { mode: 0o600 });
    helper.restoreCapabilitySecretDotenvFile({
      filePath: dotenvPath,
      backupPath,
      expectedContents: after,
    });
    expect(readFileSync(dotenvPath, 'utf8')).toBe(before);
    expect(statSync(dotenvPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).sort()).toEqual(['.env', '.env.before']);
  });
});

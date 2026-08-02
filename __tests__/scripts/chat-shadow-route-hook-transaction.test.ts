import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '../..');
const HELPER = path.join(ROOT, 'scripts/lib/chat-capability-flag-transaction.mjs');

const PLAN_SCHEMA = 'nexus.chat-shadow-route-hook-plan.v1';
const RECEIPT_SCHEMA = 'nexus.chat-shadow-route-hook-transaction.v1';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const GENERATED_AT = '2026-08-02T10:00:00.000Z';
const EXPIRES_AT = '2026-08-02T11:00:00.000Z';
const TRANSACTION_ID = '20260802T100100Z-abcdef123456';
const DEDICATED_ID = 42;
const USER_RECORDER = `CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_${DEDICATED_ID}`;
const TENANT_RECORDER = `CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TENANT_${DEDICATED_ID}`;
const PRIVATE_CLASSIFIER_HMAC = 'classifier-private-sentinel-'.repeat(2);
const PRIVATE_ROUTE_HMAC = 'route-private-sentinel-'.repeat(2);

const GOVERNED_FLAGS = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
  'AI_ROUTING_MANIFEST_KILL',
] as const;

async function loadHelper(): Promise<any> {
  return import(pathToFileURL(HELPER).href);
}

function baseDotenv(extra: string[] = [], newline = '\n'): string {
  return [
    '# unrelated bytes stay exactly where they are',
    'PORT=8201',
    `CHAT_EVAL_DEDICATED_TENANT_ID=${DEDICATED_ID}`,
    `CLASSIFY_SHADOW_HASH_SECRET=${PRIVATE_CLASSIFIER_HMAC}`,
    `CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=${PRIVATE_ROUTE_HMAC}`,
    ...GOVERNED_FLAGS.map((flag) => `${flag}=false`),
    ...extra,
    'UNRELATED_SETTING=preserved',
    '',
  ].join(newline);
}

function planInput(
  dotenvSource: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    dotenvSource,
    dedicatedIdentityAttested: true,
    desiredValue: true,
    transitionReason: 'dedicated_eval_evidence_collection',
    previousPlanSequence: 7,
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

function passedReceiptInput(plan: Record<string, unknown>): Record<string, unknown> {
  return {
    plan,
    transactionId: TRANSACTION_ID,
    startedAt: '2026-08-02T10:01:00.000Z',
    completedAt: '2026-08-02T10:01:08.000Z',
    status: 'passed',
    health: { backend: 'passed', identity: 'passed', shadowHook: 'passed' },
    rollback: { status: 'not_required' },
  };
}

describe('dedicated-eval chat shadow route hook transaction', () => {
  it('builds one immutable one-hour staging enable plan and rewrites only the exact dedicated scopes', async () => {
    const helper = await loadHelper();
    const source = baseDotenv([], '\r\n');
    const plan = helper.buildShadowRouteHookPlan(planInput(source));

    expect(helper.CHAT_SHADOW_ROUTE_HOOK_PLAN_SCHEMA).toBe(PLAN_SCHEMA);
    expect(helper.CHAT_SHADOW_ROUTE_HOOK_RECEIPT_SCHEMA).toBe(RECEIPT_SCHEMA);
    expect(plan).toMatchObject({
      schema: PLAN_SCHEMA,
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      dedicatedTenantId: DEDICATED_ID,
      dedicatedIdentityAttested: true,
      action: 'enable',
      desiredValue: true,
      transitionReason: 'dedicated_eval_evidence_collection',
      previousPlanSequence: 7,
      planSequence: 8,
      generatedAt: GENERATED_AT,
      expiresAt: EXPIRES_AT,
      prerequisites: {
        hmacsPresent: {
          CLASSIFY_SHADOW_HASH_SECRET: true,
          CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: true,
        },
        governedCapabilitiesOff: true,
        shadowPlannerEffectiveOff: true,
        otherRecorderScopesAbsent: true,
      },
      recorderBefore: { user: false, tenant: false },
      recorderAfter: { user: true, tenant: true },
      changedAssignments: [USER_RECORDER, TENANT_RECORDER],
    });
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(plan)).not.toContain(PRIVATE_CLASSIFIER_HMAC);
    expect(JSON.stringify(plan)).not.toContain(PRIVATE_ROUTE_HMAC);

    const repeated = helper.buildShadowRouteHookPlan(planInput(source));
    expect(repeated).toEqual(plan);

    const rewritten = helper.rewriteShadowRouteHookDotenv({ source, plan });
    expect(rewritten).toEqual({
      contents: `${source}${USER_RECORDER}=true\r\n${TENANT_RECORDER}=true\r\n`,
      changedAssignments: [USER_RECORDER, TENANT_RECORDER],
    });
    expect(rewritten.contents.slice(0, source.length)).toBe(source);
    expect(() => helper.rewriteShadowRouteHookDotenv({
      source: rewritten.contents,
      plan,
    })).toThrow(/changed|drift|inspected|already/i);
  });

  it('supports an exact two-scope rollback and preserves unrelated dotenv bytes', async () => {
    const helper = await loadHelper();
    const source = baseDotenv([
      USER_RECORDER + '=true',
      TENANT_RECORDER + '=true',
    ]);
    const plan = helper.buildShadowRouteHookPlan(planInput(source, {
      desiredValue: false,
      transitionReason: 'operator_rollback',
    }));

    expect(plan).toMatchObject({
      recorderBefore: { user: true, tenant: true },
      recorderAfter: { user: false, tenant: false },
      action: 'disable',
      desiredValue: false,
      transitionReason: 'operator_rollback',
    });
    const rewritten = helper.rewriteShadowRouteHookDotenv({ source, plan });
    const expected = source
      .replace(`${USER_RECORDER}=true`, `${USER_RECORDER}=false`)
      .replace(`${TENANT_RECORDER}=true`, `${TENANT_RECORDER}=false`);
    expect(rewritten.contents).toBe(expected);
    expect(rewritten.contents).toContain('UNRELATED_SETTING=preserved\n');

    for (const transitionReason of ['quality_regression', 'health_regression']) {
      expect(helper.buildShadowRouteHookPlan(planInput(source, {
        desiredValue: false,
        transitionReason,
      }))).toMatchObject({ desiredValue: false, transitionReason });
    }

    for (const degradedSource of [
      source.replace(`CLASSIFY_SHADOW_HASH_SECRET=${PRIVATE_CLASSIFIER_HMAC}\n`, ''),
      source.replace(`CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=${PRIVATE_ROUTE_HMAC}\n`, ''),
      source.replace('AI_ROUTING_MANIFEST_KILL=false', 'AI_ROUTING_MANIFEST_KILL=true'),
      source.replace('AI_ROUTING_MANIFEST_CLASSIFIER=false', 'AI_ROUTING_MANIFEST_CLASSIFIER=true'),
      source.replace(
        'UNRELATED_SETTING=preserved',
        'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_42=on\nUNRELATED_SETTING=preserved',
      ),
    ]) {
      const rollbackPlan = helper.buildShadowRouteHookPlan(planInput(degradedSource, {
        desiredValue: false,
        transitionReason: 'health_regression',
      }));
      const rollbackRewrite = helper.rewriteShadowRouteHookDotenv({
        source: degradedSource,
        plan: rollbackPlan,
      });
      expect(rollbackRewrite.contents).toContain(`${USER_RECORDER}=false`);
      expect(rollbackRewrite.contents).toContain(`${TENANT_RECORDER}=false`);
    }
  });

  it('reads collection state with an enabled capability prefix while keeping recorder safety strict', async () => {
    const helper = await loadHelper();
    const collecting = baseDotenv([
      `${USER_RECORDER}=true`,
      `${TENANT_RECORDER}=true`,
    ]).replace(
      'AI_ROUTING_MANIFEST_CLASSIFIER=false',
      'AI_ROUTING_MANIFEST_CLASSIFIER=true',
    );
    expect(helper.readShadowRouteHookCollectionState(collecting)).toEqual({
      dedicatedTenantId: DEDICATED_ID,
      prerequisites: {
        hmacsPresent: {
          CLASSIFY_SHADOW_HASH_SECRET: true,
          CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: true,
        },
        shadowPlannerEffectiveOff: true,
        otherRecorderScopesAbsent: true,
      },
      recorder: { user: true, tenant: true },
    });

    for (const invalid of [
      collecting.replace(`CLASSIFY_SHADOW_HASH_SECRET=${PRIVATE_CLASSIFIER_HMAC}\n`, ''),
      collecting.replace(`CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=${PRIVATE_ROUTE_HMAC}\n`, ''),
      collecting.replace(
        'UNRELATED_SETTING=preserved',
        'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_42=true\nUNRELATED_SETTING=preserved',
      ),
      `${collecting}CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_99=true\n`,
      `${collecting}CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED=false\n`,
    ]) {
      expect(() => helper.readShadowRouteHookCollectionState(invalid))
        .toThrow(/HMAC|planner|recorder|scope|global|foreign|present|off/i);
    }
  });

  it('allows only the configured dedicated synthetic identity and never a global or foreign recorder scope', async () => {
    const helper = await loadHelper();
    for (const source of [
      baseDotenv(['CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED=true']),
      baseDotenv(['CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED=false']),
      baseDotenv(['CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_43=false']),
      baseDotenv(['CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TENANT_43=true']),
      baseDotenv(['CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TEAM_42=false']),
      baseDotenv([`${USER_RECORDER} = false`]),
      baseDotenv([`export ${TENANT_RECORDER}=false`]),
      baseDotenv([`${USER_RECORDER}=false`, `${USER_RECORDER}=false`]),
      baseDotenv([`${USER_RECORDER}=true`, `${TENANT_RECORDER}=false`]),
    ]) {
      expect(() => helper.buildShadowRouteHookPlan(planInput(source)))
        .toThrow(/recorder|scope|canonical|duplicate|consistent|dedicated/i);
    }

    for (const dedicated of ['', '0', '-1', '01', '1.5', '9007199254740992']) {
      const source = baseDotenv().replace(
        `CHAT_EVAL_DEDICATED_TENANT_ID=${DEDICATED_ID}`,
        `CHAT_EVAL_DEDICATED_TENANT_ID=${dedicated}`,
      );
      expect(() => helper.buildShadowRouteHookPlan(planInput(source)))
        .toThrow(/dedicated|tenant|canonical|safe|positive/i);
    }
    expect(() => helper.buildShadowRouteHookPlan(planInput(
      `${baseDotenv()}CHAT_EVAL_DEDICATED_TENANT_ID=${DEDICATED_ID}\n`,
    ))).toThrow(/duplicate|dedicated/i);
  });

  it('fails closed unless both HMACs exist, all rollout flags are off, and every planner scope is off', async () => {
    const helper = await loadHelper();
    expect(() => helper.buildShadowRouteHookPlan(planInput(
      baseDotenv().replace(`CLASSIFY_SHADOW_HASH_SECRET=${PRIVATE_CLASSIFIER_HMAC}\n`, ''),
    ))).toThrow(/HMAC|CLASSIFY_SHADOW_HASH_SECRET|present/i);
    expect(() => helper.buildShadowRouteHookPlan(planInput(
      baseDotenv().replace(`CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=${PRIVATE_ROUTE_HMAC}\n`, ''),
    ))).toThrow(/HMAC|CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET|present/i);
    expect(() => helper.buildShadowRouteHookPlan(planInput(
      baseDotenv().replace('AI_ROUTING_MANIFEST_CLASSIFIER=false', 'AI_ROUTING_MANIFEST_CLASSIFIER=true'),
    ))).toThrow(/capabilit|kill|off/i);
    expect(() => helper.buildShadowRouteHookPlan(planInput(
      baseDotenv().replace('AI_ROUTING_MANIFEST_KILL=false', 'AI_ROUTING_MANIFEST_KILL=true'),
    ))).toThrow(/capabilit|kill|off/i);

    for (const assignment of [
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED=true',
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_42=on',
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_42=1',
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_99=shadow',
    ]) {
      expect(() => helper.buildShadowRouteHookPlan(planInput(baseDotenv([assignment]))))
        .toThrow(/planner|off/i);
    }
    expect(helper.buildShadowRouteHookPlan(planInput(baseDotenv([
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED=false',
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_42=off',
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_TENANT_99=0',
    ])))).toMatchObject({
      prerequisites: { shadowPlannerEffectiveOff: true },
    });
    expect(() => helper.buildShadowRouteHookPlan(planInput(baseDotenv([
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_42=false',
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_42=false',
    ])))).toThrow(/planner|duplicate/i);
    expect(() => helper.buildShadowRouteHookPlan(planInput(baseDotenv([
      'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_USER_42=maybe',
    ])))).toThrow(/planner|canonical/i);
  });

  it('enforces staging-only transitions, exact reasons, owner acknowledgement, and the one-hour window', async () => {
    const helper = await loadHelper();
    const source = baseDotenv();
    const plan = helper.buildShadowRouteHookPlan(planInput(source));

    expect(() => helper.buildShadowRouteHookPlan(planInput(source, { role: 'production' })))
      .toThrow(/staging/i);
    expect(() => helper.buildShadowRouteHookPlan(planInput(source, {
      dedicatedIdentityAttested: false,
    }))).toThrow(/dedicated|identity|attest/i);
    expect(() => helper.buildShadowRouteHookPlan(planInput(source, {
      transitionReason: 'operator_rollback',
    }))).toThrow(/enable|reason/i);
    const enabledSource = baseDotenv([`${USER_RECORDER}=true`, `${TENANT_RECORDER}=true`]);
    expect(() => helper.buildShadowRouteHookPlan(planInput(enabledSource, {
      desiredValue: false,
      transitionReason: 'dedicated_eval_evidence_collection',
    }))).toThrow(/rollback|reason/i);

    expect(helper.assertShadowRouteHookApplyAuthorization({
      ownerAuthorized: '1',
      ackPlan: plan.planDigest,
      plan,
      now: GENERATED_AT,
    })).toBe(true);
    expect(helper.assertShadowRouteHookApplyAuthorization({
      ownerAuthorized: '1',
      ackPlan: plan.planDigest,
      plan,
      now: EXPIRES_AT,
    })).toBe(true);
    expect(() => helper.assertShadowRouteHookApplyAuthorization({
      ownerAuthorized: '0', ackPlan: plan.planDigest, plan, now: GENERATED_AT,
    })).toThrow(/owner|authorization/i);
    expect(() => helper.assertShadowRouteHookApplyAuthorization({
      ownerAuthorized: '1', ackPlan: `sha256:${'c'.repeat(64)}`, plan, now: GENERATED_AT,
    })).toThrow(/acknowledged|digest|match/i);
    expect(() => helper.assertShadowRouteHookApplyAuthorization({
      ownerAuthorized: '1', ackPlan: plan.planDigest, plan, now: '2026-08-02T09:59:59.999Z',
    })).toThrow(/generated|window|before/i);
    expect(() => helper.assertShadowRouteHookApplyAuthorization({
      ownerAuthorized: '1', ackPlan: plan.planDigest, plan, now: '2026-08-02T11:00:00.001Z',
    })).toThrow(/expired|window/i);
  });

  it('builds and strictly validates passed, rolled-back, and rollback-failed receipts', async () => {
    const helper = await loadHelper();
    const plan = helper.buildShadowRouteHookPlan(planInput(baseDotenv()));
    const receipt = helper.buildShadowRouteHookReceipt(passedReceiptInput(plan));
    expect(receipt).toMatchObject({
      schema: RECEIPT_SCHEMA,
      transactionId: TRANSACTION_ID,
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planDigest: plan.planDigest,
      dedicatedTenantId: DEDICATED_ID,
      dedicatedIdentityAttested: true,
      action: 'enable',
      status: 'passed',
      health: { backend: 'passed', identity: 'passed', shadowHook: 'passed' },
      rollback: { status: 'not_required' },
    });
    expect(helper.validateShadowRouteHookReceipt(receipt)).toEqual(receipt);

    const rolledBack = helper.buildShadowRouteHookReceipt({
      ...passedReceiptInput(plan),
      status: 'rolled_back',
      health: { backend: 'failed', identity: 'failed', shadowHook: 'failed' },
      rollback: { status: 'rolled_back' },
    });
    expect(rolledBack.status).toBe('rolled_back');
    const rollbackFailed = helper.buildShadowRouteHookReceipt({
      ...passedReceiptInput(plan),
      status: 'rollback_failed',
      health: { backend: 'failed', identity: 'failed', shadowHook: 'failed' },
      rollback: { status: 'rollback_failed' },
    });
    expect(rollbackFailed.status).toBe('rollback_failed');

    for (const invalid of [
      { ...receipt, schema: 'nexus.chat-shadow-route-hook-transaction.v0' },
      { ...receipt, planDigest: `sha256:${'c'.repeat(64)}` },
      { ...receipt, completedAt: '2026-08-02T10:00:59.999Z' },
      { ...receipt, startedAt: '2026-08-02T11:00:00.001Z' },
      { ...receipt, health: { backend: 'failed', identity: 'passed', shadowHook: 'passed' } },
      { ...receipt, health: { backend: 'passed', identity: 'passed' } },
      { ...receipt, rollback: { status: 'rolled_back' } },
      { ...receipt, extra: true },
    ]) {
      expect(() => helper.validateShadowRouteHookReceipt(invalid))
        .toThrow(/receipt|schema|digest|time|health|rollback|field|window/i);
    }
    expect(() => helper.buildShadowRouteHookReceipt({
      ...passedReceiptInput(plan),
      status: 'rolled_back',
      rollback: { status: 'not_required' },
    })).toThrow(/rolled_back|rollback/i);
    expect(() => helper.buildShadowRouteHookReceipt({
      ...passedReceiptInput(plan),
      status: 'rollback_failed',
      rollback: { status: 'rolled_back' },
    })).toThrow(/rollback_failed|rollback/i);
  });
});

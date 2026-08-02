import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const HELPER = path.join(ROOT, 'scripts/lib/chat-capability-flag-transaction.mjs');
const REMOTE = path.join(ROOT, 'scripts/remote-chat-capability-flag-transaction.sh');
const OPERATOR = path.join(ROOT, 'scripts/chat-capability-flag-operator.sh');

const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const RELEASE_DIR = `/home/dominguez/telegram-hub-bot-staging/releases/${RUNTIME_SHA}-${ARTIFACT_DIGEST.slice(0, 12)}`;
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const NEXT_PLAN_DIGEST = `sha256:${'d'.repeat(64)}`;
const TRANSACTION_ID = '20260802T010203Z-abcdef123456';
const SECRET_SENTINEL = 'private-value-that-must-never-appear-in-an-error';
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function loadHelper(): Promise<any> {
  return import(pathToFileURL(HELPER).href);
}

function plan(sequence = 1, digest = PLAN_DIGEST): Record<string, unknown> {
  return {
    schema: 'nexus.chat-capability-flag-plan.v1',
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
    desiredValue: true,
    previousPlanSequence: sequence - 1,
    planSequence: sequence,
    planDigest: digest,
  };
}

function privatePreconditions(): Record<string, unknown> {
  return {
    envSha256: sha256(`PORTAL_TOKEN=${SECRET_SENTINEL}\nAI_ROUTING_MANIFEST_CLASSIFIER=false\n`),
    releaseDir: RELEASE_DIR,
    backendProcess: { name: 'nexus-hub-staging', pid: 4101, pmUptimeMs: 1_000 },
    contentProcess: { name: 'content-engine-staging', pid: 4201, pmUptimeMs: 900 },
  };
}

type Pm2Row = {
  name: string;
  pid: number;
  pm2_env: Record<string, unknown>;
};

function pm2Row(
  name: 'nexus-hub-staging' | 'content-engine-staging',
  pid: number,
  pmUptime: number,
  overrides: Record<string, unknown> = {},
): Pm2Row {
  const backend = name === 'nexus-hub-staging';
  return {
    name,
    pid,
    pm2_env: {
      status: 'online',
      pm_uptime: pmUptime,
      pm_cwd: backend ? RELEASE_DIR : `${RELEASE_DIR}/content-engine`,
      pm_exec_path: backend ? `${RELEASE_DIR}/dist/index.js` : '/usr/bin/python3.12',
      NEXUS_RELEASE_ROLE: 'staging',
      NEXUS_RELEASE_SHA: RUNTIME_SHA,
      NEXUS_RELEASE_ARTIFACT_SHA256: ARTIFACT_DIGEST,
      ...overrides,
    },
  };
}

function beforePm2(): Pm2Row[] {
  return [
    pm2Row('nexus-hub-staging', 4101, 1_000),
    pm2Row('content-engine-staging', 4201, 900),
  ];
}

function afterPm2(): Pm2Row[] {
  return [
    pm2Row('nexus-hub-staging', 4102, 2_000),
    pm2Row('content-engine-staging', 4201, 900),
  ];
}

describe('remote chat capability flag safety helpers', () => {
  it('collects immutable gate evidence on the server instead of accepting an operator file', () => {
    const operator = readFileSync(OPERATOR, 'utf8');
    const remote = readFileSync(REMOTE, 'utf8');

    expect(operator).not.toContain('--gate-evidence');
    expect(operator).not.toContain('GATE_EVIDENCE');
    expect(operator).not.toContain('--server');
    expect(operator).not.toContain('DEPLOY_SERVER');
    expect(operator).toContain("readonly SERVER='ServerDominguez'");
    expect(operator).toContain('--since');
    expect(operator).toContain('--until');

    expect(remote).toContain('scripts/routing-divergence-report.mjs');
    expect(remote).toContain('dist/tools/routing-action-skill-accuracy.js');
    expect(remote).toContain('dist/tools/chat-capability-cross-skill-preflight.js');
    expect(remote).toContain('scripts/training-cross-skill-staging-smoke.sh');
    const inspectCollector = remote.slice(
      remote.indexOf('collect_native_evidence_sources()'),
      remote.indexOf('revalidate_apply_staging_prerequisite()'),
    );
    expect(inspectCollector).not.toContain('NEXUS_STAGING_SMOKE_LOCAL_SERVER=1');
    expect(inspectCollector).not.toContain('"$STAGING_RELEASE_DIR/scripts/staging-smoke.sh"');
    expect(remote).toContain('select_existing_canonical_staging_smoke');
    expect(remote).toContain('owner-authorized exact canonical staging smoke');
    expect(remote).toContain('select_mature_exact_staging_enable_receipt');
    expect(remote).toContain('"$STATE_ROOT/staging.flag.sequence"');
    expect(remote).toContain(
      'latest passed staging ON receipt does not match the current consumed flag sequence',
    );
    expect(remote).toContain('301_000');
    expect(remote).toContain('dist/services/chat-quality-regression-monitor.js');
    expect(remote).toContain('nexus.chat-capability-quality-monitor.v1');
    expect(remote).toContain('observation.smokeSha256');
    expect(remote).toContain("if (verdict !== 'passed') process.exitCode = 1");
    expect(remote).toContain('observation sidecar does not bind its exact canonical smoke sibling');
    expect(remote).toContain('staging-observation\\.json$/u');
    expect(remote).toContain('"$STATE_ROOT/staging.observation.sequence"');
    expect(remote).toContain(
      'latest passed observation does not match the current consumed observation sequence',
    );
    expect(remote).toContain('a later consumed observation claim has no passed receipt');
    expect(remote).not.toContain('300 - elapsed');
    expect(remote).toContain('--minimum-comparisons=200');
    expect(remote).toContain('buildClarifyCalibrationEvidenceAttestation');
    expect(remote).toContain('buildClarifyBudgetEvidenceAttestation');
    expect(remote).toContain('buildActionSkillEvidenceAttestation');
    expect(remote).toContain('buildCrossSkillPreflightEvidenceAttestation');
    expect(remote).toContain('buildCrossSkillSmokeEvidenceAttestation');
    expect(remote).toContain('buildProductionStagingCapabilityPrerequisiteFromObservation');
    expect(remote).toMatch(
      /JSON\.stringify\(attestation\?\.shadowPlannerEffective\)\s*\n\s*!== JSON\.stringify\(observation\.shadowPlannerEffective\)/u,
    );
    expect(remote).toContain('$STATE_ROOT/claims');
    expect(remote).not.toContain('"$STATE_ROOT/staging.json"');
    expect(remote).toContain('latest exact passed staging ON flag claim receipt is ambiguous');
    expect(remote).toContain('staging and production databases are not isolated ordinary files');
    expect(remote).toContain('staging and production environment files are not isolated ordinary files');
    expect(remote).toContain('stat.nlink !== 1');
    expect(remote).toContain('CHAT_EVAL_DEDICATED_TENANT_ID');
    expect(remote).toContain('userId !== dedicatedTenantId');
    expect(remote).toContain("database.pragma('query_only = ON')");
    expect(remote).toContain("normalizedEmail.endsWith('.invalid')");
    expect(remote).toContain("TRAINING_CROSS_SKILL_DEDICATED_IDENTITY_ATTESTED: '1'");
  });

  it('runs canonical staging observation only through an inspected owner-gated detached transaction', () => {
    const operator = readFileSync(OPERATOR, 'utf8');
    const remote = readFileSync(REMOTE, 'utf8');

    expect(operator).toContain('scripts/chat-capability-flag-operator.sh inspect-observation');
    expect(operator).toContain('scripts/chat-capability-flag-operator.sh apply-observation');
    expect(operator).toContain("[ \"$ROLE\" = staging ]");
    expect(operator).toContain("[ \"${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}\" = 1 ]");
    expect(operator).toContain('systemd-run --user --quiet --collect --remain-after-exit');
    expect(operator).toContain('nexus.chat-capability-observation-plan.v1');
    expect(operator).toContain('nexus.chat-capability-observation-receipt.v1');
    expect(operator).toContain('poll_observation_receipt');
    expect(operator).toContain('apply-observation requires exact --ack-plan');

    const observeCase = remote.slice(
      remote.lastIndexOf('\n  apply-observation)'),
      remote.lastIndexOf('\n  inspect-secrets)'),
    );
    expect(observeCase).toContain('run_staging_capability_observation');
    expect(observeCase).not.toContain('collect_native_evidence_sources');
    expect(remote).toContain("[ \"${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}\" = 1 ]");
    expect(remote).toContain('select_mature_exact_staging_enable_receipt');
    expect(remote).toContain('NEXUS_STAGING_SMOKE_LOCAL_SERVER=1');
    expect(remote).toContain('NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY=1');
    expect(remote).toContain('NEXUS_SMOKE_EVIDENCE_PATH');
    expect(remote).toContain('"$STAGING_RELEASE_DIR/scripts/staging-smoke.sh"');
    expect(remote).toContain('nexus.chat-capability-observation-plan.v1');
    expect(remote).toContain('nexus.chat-capability-observation-receipt.v1');
    expect(remote).toContain('enableReceiptSha256');
    expect(remote).toContain('smokeSha256');
    expect(remote).toContain('configuredBefore');
    expect(remote).toContain('configuredAfter');
    expect(remote).toContain('masterKillBefore');
    expect(remote).toContain('masterKillAfter');
    expect(remote).toContain("fs.openSync(receiptFile, 'wx', 0o600)");
    expect(remote).toContain('stat.nlink !== 1');

    const lock = remote.indexOf("flock -n 8 || die 'a root maintenance or Sonar action is active'");
    const observe = remote.indexOf('run_staging_capability_observation', lock);
    expect(lock).toBeGreaterThan(-1);
    expect(observe).toBeGreaterThan(lock);
  });

  it('binds zero durable chat-quality alert rows since enable regardless of alert status', () => {
    const remote = readFileSync(REMOTE, 'utf8');
    expect(remote).toContain("'chat_quality_regression_monitor'");
    expect(remote).toContain("'chat_v2_retirement_monitor'");
    expect(remote).toContain('FROM operator_alerts');
    expect(remote).toContain('julianday(created_at) >= julianday(?)');
    expect(remote).toContain('julianday(last_seen_at) >= julianday(?)');
    expect(remote).toContain('durableAlertActivityRowCount');
    expect(remote).not.toMatch(/FROM operator_alerts[\s\S]{0,300}status\s*=/u);
  });

  it('rechecks current quality and durable alerts for every production enable before mutation', () => {
    const remote = readFileSync(REMOTE, 'utf8');
    const applyRevalidation = remote.slice(
      remote.indexOf('revalidate_apply_staging_prerequisite()'),
      remote.indexOf('\nif [ "$COMMAND" = inspect ]', remote.indexOf(
        'revalidate_apply_staging_prerequisite()',
      )),
    );
    expect(applyRevalidation).toContain(
      "collect_staging_http_json '/api/portal/chat-quality' portal \"$DASHBOARD_EVIDENCE_FILE\"",
    );
    expect(applyRevalidation).toContain(
      'collect_chat_quality_monitor "$MONITOR_EVIDENCE_FILE" "$STAGING_ENABLE_RECEIPT_FILE"',
    );
    expect(applyRevalidation).toContain('helper.buildStagingCapabilityPrerequisite({');
    expect(applyRevalidation).toContain(
      "monitorRaw: readOrdinary(monitorFile, 'current chat-quality monitor')",
    );

    const monitorCollector = remote.slice(
      remote.indexOf('collect_chat_quality_monitor()'),
      remote.indexOf('\nselect_existing_canonical_staging_smoke()', remote.indexOf(
        'collect_chat_quality_monitor()',
      )),
    );
    const monitorRun = monitorCollector.indexOf(
      'await monitor.runChatQualityRegressionMonitor',
    );
    const finalAlertQuery = monitorCollector.indexOf(
      'const finalAlertState = readDurableAlertState();',
      monitorRun,
    );
    const evidenceWrite = monitorCollector.indexOf('fs.writeFileSync(output', finalAlertQuery);
    expect(monitorRun).toBeGreaterThan(-1);
    expect(finalAlertQuery).toBeGreaterThan(monitorRun);
    expect(evidenceWrite).toBeGreaterThan(finalAlertQuery);
  });

  it('keeps the live permit, commit point, and recovery ordering fail closed', () => {
    const source = readFileSync(REMOTE, 'utf8');
    const claimConsumed = source.indexOf('fs.unlinkSync(pendingPlan);');
    const applyRevalidation = source.indexOf(
      'revalidate_apply_staging_prerequisite',
      claimConsumed,
    );
    const mutationArmed = source.indexOf('ROLLBACK_ARMED=true', applyRevalidation);
    const apply = source.indexOf('write_runtime_permit apply "$CLAIM_PLAN" configuredAfter');
    const restart = source.indexOf('restart_backend', apply);
    const authorized = source.indexOf(
      'wait_healthy "$CLAIM_PLAN" configuredAfter "$BACKEND_PID" authorized',
      restart,
    );
    const internalReceipt = source.indexOf(
      'atomic_write_json "$CLAIM_RECEIPT" "$RECEIPT_TEMP"',
      authorized,
    );
    const receiptWritten = source.indexOf('RECEIPT_WRITTEN=true', internalReceipt);
    const rollbackDisarmed = source.indexOf('ROLLBACK_ARMED=false', receiptWritten);
    const backupRemoved = source.indexOf('durable_remove "$BACKUP_FILE"', rollbackDisarmed);
    const permitRemoved = source.indexOf('durable_remove "$PERMIT_FILE"', backupRemoved);
    const clear = source.indexOf(
      'wait_healthy "$CLAIM_PLAN" configuredAfter "$BACKEND_PID" clear',
      permitRemoved,
    );
    const externalReceipt = source.indexOf(
      'atomic_write_json "$STATE_ROOT/$ROLE.json" "$CLAIM_RECEIPT"',
      clear,
    );

    expect([
      applyRevalidation,
      claimConsumed,
      mutationArmed,
      apply,
      restart,
      authorized,
      internalReceipt,
      receiptWritten,
      rollbackDisarmed,
      backupRemoved,
      permitRemoved,
      clear,
      externalReceipt,
    ].every((index) => index >= 0)).toBe(true);
    expect(claimConsumed).toBeLessThan(applyRevalidation);
    expect(applyRevalidation).toBeLessThan(mutationArmed);
    expect(mutationArmed).toBeLessThan(apply);
    expect(apply).toBeLessThan(restart);
    expect(restart).toBeLessThan(authorized);
    expect(authorized).toBeLessThan(internalReceipt);
    expect(internalReceipt).toBeLessThan(receiptWritten);
    expect(receiptWritten).toBeLessThan(rollbackDisarmed);
    expect(rollbackDisarmed).toBeLessThan(backupRemoved);
    expect(backupRemoved).toBeLessThan(permitRemoved);
    expect(permitRemoved).toBeLessThan(clear);
    expect(clear).toBeLessThan(externalReceipt);

    expect(source.indexOf('recover_interrupted_transaction'))
      .toBeLessThan(source.indexOf('recover_committed_receipt_gap'));
  });

  it('reads governed state as inert dotenv data with missing flags defaulted off', async () => {
    const helper = await loadHelper();
    const source = [
      `PORTAL_TOKEN=${SECRET_SENTINEL}`,
      'SHELLISH_LITERAL=$(must-not-execute)',
      'AI_ROUTING_MANIFEST_CLASSIFIER=true',
      '',
    ].join('\n');
    expect(helper.readCapabilityFlagState(source)).toEqual(Object.fromEntries(
      GOVERNED_FLAGS.map((flag) => [flag, flag === 'AI_ROUTING_MANIFEST_CLASSIFIER']),
    ));
    expect(() => helper.readCapabilityFlagState(
      `${source}AI_ROUTING_MANIFEST_CLASSIFIER=false\n`,
    )).toThrow(/duplicate/i);
    expect(() => helper.readCapabilityFlagState(
      source.replace('AI_ROUTING_MANIFEST_CLASSIFIER=true', 'AI_ROUTING_MANIFEST_CLASSIFIER=yes'),
    )).toThrow(/canonical|boolean/i);
  });

  it('keeps one monotonic pending plan and consumes its exact digest before mutation', async () => {
    const helper = await loadHelper();
    const pending = helper.createPendingCapabilityPlanRecord({
      latestPlanSequence: 0,
      existingPending: null,
      plan: plan(),
      privatePreconditions: privatePreconditions(),
      createdAt: '2026-08-02T01:02:03.000Z',
    });

    expect(pending).toMatchObject({
      schema: 'nexus.chat-capability-pending-plan.v1',
      state: 'pending',
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planSequence: 1,
      planDigest: PLAN_DIGEST,
      envSha256: privatePreconditions().envSha256,
      releaseDir: RELEASE_DIR,
    });

    // Repeated inspect is idempotent while that exact plan is pending.
    expect(helper.createPendingCapabilityPlanRecord({
      latestPlanSequence: 0,
      existingPending: pending,
      plan: plan(),
      privatePreconditions: privatePreconditions(),
      createdAt: '2026-08-02T01:02:04.000Z',
    })).toEqual(pending);

    // A second plan cannot replace an unconsumed pending plan.
    expect(() => helper.createPendingCapabilityPlanRecord({
      latestPlanSequence: 0,
      existingPending: pending,
      plan: plan(1, NEXT_PLAN_DIGEST),
      privatePreconditions: privatePreconditions(),
      createdAt: '2026-08-02T01:02:04.000Z',
    })).toThrow(/pending|replace|digest/i);

    const claimed = helper.claimPendingCapabilityPlanRecord({
      record: pending,
      ackPlan: PLAN_DIGEST,
      expectedRole: 'staging',
      expectedRuntimeSha: RUNTIME_SHA,
      expectedArtifactDigest: ARTIFACT_DIGEST,
      expectedPlanSequence: 1,
      transactionId: TRANSACTION_ID,
      claimedAt: '2026-08-02T01:02:05.000Z',
    });
    expect(claimed).toMatchObject({
      state: 'claimed',
      planSequence: 1,
      planDigest: PLAN_DIGEST,
      transactionId: TRANSACTION_ID,
      claimedAt: '2026-08-02T01:02:05.000Z',
    });

    for (const replay of [
      { record: claimed, ackPlan: PLAN_DIGEST, expectedPlanSequence: 1 },
      { record: pending, ackPlan: NEXT_PLAN_DIGEST, expectedPlanSequence: 1 },
      { record: pending, ackPlan: PLAN_DIGEST, expectedPlanSequence: 2 },
    ]) {
      expect(() => helper.claimPendingCapabilityPlanRecord({
        ...replay,
        expectedRole: 'staging',
        expectedRuntimeSha: RUNTIME_SHA,
        expectedArtifactDigest: ARTIFACT_DIGEST,
        transactionId: TRANSACTION_ID,
        claimedAt: '2026-08-02T01:02:06.000Z',
      })).toThrow(/claim|consum|replay|digest|sequence/i);
    }

    // Sequence gaps are rejected; the next plan must advance exactly once.
    expect(() => helper.createPendingCapabilityPlanRecord({
      latestPlanSequence: 1,
      existingPending: null,
      plan: plan(3, NEXT_PLAN_DIGEST),
      privatePreconditions: privatePreconditions(),
      createdAt: '2026-08-02T01:02:07.000Z',
    })).toThrow(/sequence/i);
    expect(helper.createPendingCapabilityPlanRecord({
      latestPlanSequence: 1,
      existingPending: null,
      plan: plan(2, NEXT_PLAN_DIGEST),
      privatePreconditions: privatePreconditions(),
      createdAt: '2026-08-02T01:02:07.000Z',
    })).toMatchObject({ state: 'pending', planSequence: 2, planDigest: NEXT_PLAN_DIGEST });
  });

  it('fails closed when dotenv bytes or file identity differ from the private CAS precondition', async () => {
    const helper = await loadHelper();
    const contents = `PORTAL_TOKEN=${SECRET_SENTINEL}\nAI_ROUTING_MANIFEST_CLASSIFIER=false\n`;
    const identity = { device: 7, inode: 81, size: Buffer.byteLength(contents), mtimeMs: 1_000 };
    const expectedSha256 = sha256(contents);

    expect(helper.assertDotenvCasPrecondition({
      expectedSha256,
      expectedFileIdentity: identity,
      observedContents: contents,
      observedFileIdentity: identity,
    })).toBe(true);

    const sameLengthMutation = contents.replace('false', 'FALSE');
    const invalidCases = [
      { observedContents: sameLengthMutation, observedFileIdentity: identity },
      { observedContents: contents, observedFileIdentity: { ...identity, inode: 82 } },
      { observedContents: contents, observedFileIdentity: { ...identity, mtimeMs: 1_001 } },
    ];
    for (const invalid of invalidCases) {
      let thrown: unknown;
      try {
        helper.assertDotenvCasPrecondition({
          expectedSha256,
          expectedFileIdentity: identity,
          ...invalid,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/environment|dotenv|precondition|changed|identity/i);
      expect(String(thrown)).not.toContain(SECRET_SENTINEL);
      expect(String(thrown)).not.toContain(expectedSha256);
    }
  });

  it('requires a new exact backend process while the content process remains unchanged', async () => {
    const helper = await loadHelper();
    const input = {
      before: beforePm2(),
      after: afterPm2(),
      role: 'staging',
      releaseDir: RELEASE_DIR,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      backendName: 'nexus-hub-staging',
      contentName: 'content-engine-staging',
    };

    expect(helper.assertBackendOnlyPm2Transition(input)).toEqual({
      backendPidBefore: 4101,
      backendPidAfter: 4102,
      contentPidBefore: 4201,
      contentPidAfter: 4201,
    });

    const unchangedBackend = afterPm2();
    unchangedBackend[0] = pm2Row('nexus-hub-staging', 4101, 1_000);
    const restartedContent = afterPm2();
    restartedContent[1] = pm2Row('content-engine-staging', 4202, 2_100);
    const changedContentUptime = afterPm2();
    changedContentUptime[1] = pm2Row('content-engine-staging', 4201, 2_100);
    const wrongIdentity = afterPm2();
    wrongIdentity[0] = pm2Row('nexus-hub-staging', 4102, 2_000, {
      NEXUS_RELEASE_ARTIFACT_SHA256: 'e'.repeat(64),
    });
    const duplicateBackend = [...afterPm2(), pm2Row('nexus-hub-staging', 4103, 2_100)];

    for (const after of [
      unchangedBackend,
      restartedContent,
      changedContentUptime,
      wrongIdentity,
      duplicateBackend,
    ]) {
      expect(() => helper.assertBackendOnlyPm2Transition({ ...input, after }))
        .toThrow(/backend|content|process|pid|uptime|identity|duplicate/i);
    }
  });

  it('restores the exact dotenv preimage only when the failed candidate bytes still match', async () => {
    const helper = await loadHelper();
    const preimage = [
      '# byte-exact rollback source',
      `PORTAL_TOKEN=${SECRET_SENTINEL}`,
      'SHELLISH_LITERAL=$(must-not-execute)',
      'AI_ROUTING_MANIFEST_CLASSIFIER=false',
      '',
    ].join('\n');
    const mutated = preimage.replace(
      'AI_ROUTING_MANIFEST_CLASSIFIER=false',
      'AI_ROUTING_MANIFEST_CLASSIFIER=true',
    );

    const restoration = helper.prepareDotenvRollbackRestoration({
      currentContents: mutated,
      expectedMutatedSha256: sha256(mutated),
      preimageContents: preimage,
      expectedPreimageSha256: sha256(preimage),
    });
    expect(restoration).toEqual({ restored: true, contents: preimage });
    expect(restoration.contents).toBe(preimage);

    for (const invalid of [
      {
        currentContents: `${mutated}# concurrent edit\n`,
        expectedMutatedSha256: sha256(mutated),
        preimageContents: preimage,
        expectedPreimageSha256: sha256(preimage),
      },
      {
        currentContents: mutated,
        expectedMutatedSha256: sha256(mutated),
        preimageContents: `${preimage}# corrupt backup\n`,
        expectedPreimageSha256: sha256(preimage),
      },
    ]) {
      let thrown: unknown;
      try {
        helper.prepareDotenvRollbackRestoration(invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/rollback|preimage|candidate|changed|hash/i);
      expect(String(thrown)).not.toContain(SECRET_SENTINEL);
    }
  });
});

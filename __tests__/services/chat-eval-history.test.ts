import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { runChatEvaluationSuite } from '../../src/services/chat-evaluation-harness';
import type { ChatTurnExecutor } from '../../src/services/chat-eval-executor';
import {
  acceptFrozenRealProviderBaseline,
  ensureChatEvalHistoryTables,
  getLatestChatEvalRunForMode,
  listChatEvalRuns,
  persistChatEvalRun,
  readFrozenRealProviderBaselineState,
  type ChatEvalRunCostAttestation,
} from '../../src/services/chat-eval-history';

let db: Database.Database;

const noSpendJudgeOptions = {
  maxUsd: 0.000001,
  mode: 'real_provider' as const,
  estimateCallCostUsd: () => 1,
  complete: async () => '',
};

const validJudgeOptions = {
  maxUsd: 0.05,
  mode: 'real_provider' as const,
  estimateCallCostUsd: () => 0.0005,
  complete: async () => JSON.stringify({
    wording_quality: { score: 2, rationale: 'Clear.' },
    groundedness: { score: 2, rationale: 'Grounded.' },
    sufficiency: { score: 2, rationale: 'Sufficient.' },
    explanation_quality: { score: 2, rationale: 'Explained.' },
  }),
};

function makeLiveExecutor(mode: 'local_engine' | 'real_provider'): ChatTurnExecutor {
  return {
    mode,
    executeTurn: async (req) => ({
      ok: true,
      statusCode: 200,
      text: 'This is a complete English response for the dedicated evaluation tenant.',
      domain: 'secretary',
      routeMethod: 'context',
      metadata: { actionStatus: 'none', skillsUsed: ['secretary'] },
      envelope: {
        id: req.clientMessageId ?? 'eval-message',
        text: 'This is a complete English response for the dedicated evaluation tenant.',
        domain: 'secretary',
        routeMethod: 'context',
        confidence: 0.9,
        buttons: null,
        metadata: null,
        timestamp: '2026-04-29T12:00:00.000Z',
      },
      latencyMs: 10,
      providerTrace: mode === 'real_provider' ? { provider: 'gemini', tier: 'chat' } : null,
    }),
  };
}

function costAttestationFor(result: Awaited<ReturnType<typeof runChatEvaluationSuite>>): ChatEvalRunCostAttestation {
  const scenarioIds = result.scenarios.map((scenario) => scenario.id).sort();
  const targetActualSpendUsd = 0.012;
  const judgeEstimatedSpendUsd = Number((result.judge?.estimatedSpendUsd ?? 0).toFixed(8));
  const judgeUsageCallCount = result.judge?.calls ?? 0;
  const judgeActualSpendUsd = judgeUsageCallCount > 0 ? judgeEstimatedSpendUsd : 0;
  const judgeReservedAttemptCeilingUsd = judgeUsageCallCount > 0 ? judgeEstimatedSpendUsd : 0;
  const judgeCommittedCeilingUsd = Number(
    (judgeActualSpendUsd + judgeReservedAttemptCeilingUsd).toFixed(8),
  );
  const totalActualSpendUsd = Number((targetActualSpendUsd + judgeActualSpendUsd).toFixed(8));
  const totalConservativeCommitmentUsd = Number(
    (targetActualSpendUsd + judgeCommittedCeilingUsd).toFixed(8),
  );
  return {
    contractVersion: 'chat-live-eval-v1',
    attested: true,
    reasons: [],
    totalCeilingUsd: 0.5,
    targetCeilingUsd: 0.45,
    judgeCeilingUsd: 0.05,
    targetActualSpendUsd,
    targetReservedAttemptCeilingUsd: 0,
    targetCommittedCeilingUsd: targetActualSpendUsd,
    judgeEstimatedSpendUsd,
    judgeActualSpendUsd,
    judgeReservedAttemptCeilingUsd,
    judgeCommittedCeilingUsd,
    judgeUsageCallCount,
    judgeProviderAttemptCount: judgeUsageCallCount,
    judgeProviders: judgeUsageCallCount > 0 ? ['gemini'] : [],
    judgeModels: judgeUsageCallCount > 0 ? ['gemini-2.5-flash-lite'] : [],
    judgeUnresolvedPricingCount: 0,
    judgeUsageDatabaseSha256: judgeUsageCallCount > 0 ? 'b'.repeat(64) : null,
    totalActualSpendUsd,
    totalEstimatedActualSpendUsd: totalActualSpendUsd,
    totalConservativeCommitmentUsd,
    targetUsageCallCount: 3,
    targetProviderAttemptCount: 3,
    targetProviders: ['gemini'],
    unresolvedPricingCount: 0,
    preparation: {
      scenarioCount: scenarioIds.length,
      scenarioIds,
      seedProfileVersions: ['single-tenant-live-v2'],
      seedProfileHashes: ['a'.repeat(64)],
      aggregateResetCounts: { messages: 2 },
    },
  };
}

function preflightFor(
  runId: string,
  result: Awaited<ReturnType<typeof runChatEvaluationSuite>>,
): Record<string, unknown> {
  return {
    contractVersion: 'chat-live-eval-v1',
    mode: 'real_provider',
    runId,
    budget: { totalCeilingUsd: 0.5, targetCeilingUsd: 0.45, judgeCeilingUsd: 0.05 },
    targetBaseCategory: 'chat_live_eval_real',
    providerPolicy: 'metered_cloud_only',
    productionDataUsed: false,
    seedProfileVersion: 'single-tenant-live-v2',
    supportedScenarioIds: result.scenarios.map((scenario) => scenario.id).sort(),
  };
}

async function persistBaselineCandidate(
  runId: string,
  generatedAt = '2026-07-22T10:00:00.000Z',
  options: { judged?: boolean; deployedRelease?: boolean } = {},
): Promise<void> {
  const result = await runChatEvaluationSuite({
    mode: 'real_provider',
    generatedAt,
    executor: makeLiveExecutor('real_provider'),
    judgeOptions: options.judged === false ? noSpendJudgeOptions : validJudgeOptions,
  });
  persistChatEvalRun(result, {
    db,
    runId,
    gitBranch: 'main',
    gitCommit: 'a'.repeat(40),
    jsonReportPath: `docs/release/eval-evidence/${runId}.json`,
    markdownReportPath: `docs/release/eval-evidence/${runId}.md`,
    budgetUsd: 0.5,
    productionDataUsed: false,
    realProviderCalls: result.judge?.calls ?? 0,
    costAttestation: costAttestationFor(result),
    preflightAttestation: {
      ...preflightFor(runId, result),
      // A server-attested deployed identity is the normal case now; only the
      // pre-binding legacy baseline opts out.
      ...(options.deployedRelease === false
        ? {}
        : {
          deployedRelease: {
            runtimeSha: 'c'.repeat(40),
            artifactDigest: 'd'.repeat(64),
            role: 'staging',
          },
        }),
    },
  });
}

const EVIDENCE_JSON_SHA = 'e'.repeat(64);
const EVIDENCE_MARKDOWN_SHA = 'f'.repeat(64);

/** The archive-identity fields every freeze request must now carry. */
function archiveIdentityFor(runId: string) {
  return {
    evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
    evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
    evidenceJsonSha256: EVIDENCE_JSON_SHA,
    evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
  };
}

describe('Chat eval history', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates normalized eval history tables without raw transcript columns', () => {
    ensureChatEvalHistoryTables(db);

    const runColumns = db.prepare('PRAGMA table_info(chat_eval_runs)').all() as Array<{ name: string }>;
    const scenarioColumns = db.prepare('PRAGMA table_info(chat_eval_scenario_results)').all() as Array<{ name: string }>;

    expect(runColumns.map((column) => column.name)).toContain('quality_metrics_json');
    expect(runColumns.map((column) => column.name)).toContain('day_to_day_summary_json');
    expect(runColumns.map((column) => column.name)).toContain('total_budget_ceiling_usd');
    expect(runColumns.map((column) => column.name)).toContain('target_actual_spend_usd');
    expect(runColumns.map((column) => column.name)).toContain('target_reserved_attempt_ceiling_usd');
    expect(runColumns.map((column) => column.name)).toContain('cost_attestation_json');
    expect(scenarioColumns.map((column) => column.name)).toContain('scores_json');
    expect(scenarioColumns.map((column) => column.name)).not.toContain('turns_json');
    expect(scenarioColumns.map((column) => column.name)).not.toContain('raw_prompt');
    expect(scenarioColumns.map((column) => column.name)).not.toContain('provider_payload_json');
    const baselineColumns = db.prepare('PRAGMA table_info(chat_eval_frozen_baselines)').all() as Array<{ name: string }>;
    expect(baselineColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'baseline_key', 'run_id', 'git_commit', 'scenario_set_hash',
      'evidence_json_path', 'evidence_markdown_path', 'average_score',
      'scenario_pass_rate', 'total_estimated_actual_spend_usd',
    ]));
    expect(baselineColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'prompt', 'message', 'response', 'provider_payload_json',
    ]));
  });

  it('upgrades a pre-cost-evidence history database exactly once without duplicate columns', () => {
    db.close();
    db = new Database(':memory:');
    db.exec(readFileSync('migrations/181_chat_eval_history.sql', 'utf8'));

    expect(() => ensureChatEvalHistoryTables(db)).not.toThrow();
    expect(() => ensureChatEvalHistoryTables(db)).not.toThrow();

    const columns = (db.prepare('PRAGMA table_info(chat_eval_runs)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(new Set(columns).size).toBe(columns.length);
    for (const column of [
      'total_budget_ceiling_usd',
      'total_estimated_actual_spend_usd',
      'cost_attestation_json',
      'preflight_attestation_json',
    ]) {
      expect(columns.filter((name) => name === column)).toHaveLength(1);
    }
  });

  it('reports an explicit no-baseline state until an admin accepts a valid synthetic staging run', () => {
    expect(readFrozenRealProviderBaselineState(db)).toEqual({
      status: 'not_recorded',
      baseline: null,
      latestFollowup: null,
      comparison: null,
    });
  });

  it('rejects a frozen baseline with claimed provider calls but no successful per-scenario judge coverage', async () => {
    const runId = 'chat-eval-unjudged-baseline';
    await persistBaselineCandidate(runId, undefined, { judged: false });

    expect(() => acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    })).toThrow(/judge coverage/i);
  });

  it('rejects incoherent cost arithmetic even when the declared total actual spend remains under $0.50', async () => {
    const runId = 'chat-eval-incoherent-cost-baseline';
    await persistBaselineCandidate(runId);
    const row = db.prepare('SELECT cost_attestation_json FROM chat_eval_runs WHERE run_id = ?')
      .get(runId) as { cost_attestation_json: string };
    const cost = JSON.parse(row.cost_attestation_json);
    Object.assign(cost, {
      targetActualSpendUsd: 0.3,
      targetReservedAttemptCeilingUsd: 0.2,
      targetCommittedCeilingUsd: 0.5,
      judgeEstimatedSpendUsd: 0.01,
      judgeActualSpendUsd: 0.01,
      judgeReservedAttemptCeilingUsd: 0.01,
      judgeCommittedCeilingUsd: 0.02,
      totalActualSpendUsd: 0.31,
      totalEstimatedActualSpendUsd: 0.31,
      totalConservativeCommitmentUsd: 0.52,
    });
    db.prepare(`
      UPDATE chat_eval_runs SET
        target_actual_spend_usd = 0.3,
        target_reserved_attempt_ceiling_usd = 0.2,
        target_committed_ceiling_usd = 0.5,
        judge_estimated_spend_usd = 0.01,
        total_estimated_actual_spend_usd = 0.31,
        total_conservative_commitment_usd = 0.51,
        cost_attestation_json = ?
      WHERE run_id = ?
    `).run(JSON.stringify(cost), runId);

    expect(() => acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    })).toThrow(/cost|ceiling|coherent/i);
  });

  it('rejects a frozen baseline without durable judge usage and provider-attempt evidence', async () => {
    const runId = 'chat-eval-missing-judge-ledger-baseline';
    await persistBaselineCandidate(runId);
    const row = db.prepare('SELECT cost_attestation_json FROM chat_eval_runs WHERE run_id = ?')
      .get(runId) as { cost_attestation_json: string };
    const cost = JSON.parse(row.cost_attestation_json);
    Object.assign(cost, {
      judgeUsageCallCount: 0,
      judgeProviderAttemptCount: 0,
      judgeProviders: [],
      judgeModels: [],
      judgeUsageDatabaseSha256: null,
    });
    db.prepare('UPDATE chat_eval_runs SET cost_attestation_json = ? WHERE run_id = ?')
      .run(JSON.stringify(cost), runId);

    expect(() => acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    })).toThrow(/judge|usage|attempt|ledger/i);
  });

  it('rejects judge usage that is unresolved or not bound to Gemini Flash-Lite', async () => {
    const runId = 'chat-eval-wrong-judge-provenance-baseline';
    await persistBaselineCandidate(runId);
    const row = db.prepare('SELECT cost_attestation_json FROM chat_eval_runs WHERE run_id = ?')
      .get(runId) as { cost_attestation_json: string };
    const cost = JSON.parse(row.cost_attestation_json);
    Object.assign(cost, {
      judgeProviders: ['openai'],
      judgeModels: ['gpt-4.1-mini'],
      judgeUnresolvedPricingCount: 1,
    });
    db.prepare('UPDATE chat_eval_runs SET cost_attestation_json = ? WHERE run_id = ?')
      .run(JSON.stringify(cost), runId);

    expect(() => acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    })).toThrow(/judge|gemini|flash-lite|pricing|provider|model/i);
  });

  it('rejects seed-profile preparation evidence that is not cross-attested by preflight', async () => {
    const runId = 'chat-eval-seed-mismatch-baseline';
    await persistBaselineCandidate(runId);
    const row = db.prepare('SELECT cost_attestation_json FROM chat_eval_runs WHERE run_id = ?')
      .get(runId) as { cost_attestation_json: string };
    const cost = JSON.parse(row.cost_attestation_json);
    cost.preparation.seedProfileVersions = ['different-seed-profile'];
    db.prepare('UPDATE chat_eval_runs SET cost_attestation_json = ? WHERE run_id = ?')
      .run(JSON.stringify(cost), runId);

    expect(() => acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    })).toThrow(/seed|preparation/i);
  });

  it('freezes the first valid staging real-provider baseline immutably and accepts exact retries only', async () => {
    const runId = 'chat-eval-first-live-baseline';
    await persistBaselineCandidate(runId);

    const accepted = acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
      acceptedAt: '2026-07-22T11:00:00.000Z',
    });
    expect(accepted.action).toBe('created');
    expect(accepted.baseline).toMatchObject({
      runId,
      gitCommit: 'a'.repeat(40),
      acceptedAt: '2026-07-22T11:00:00.000Z',
      acceptedVia: 'portal_admin_token',
      evalContractVersion: 'chat-live-eval-v1',
      seedProfileVersion: 'single-tenant-live-v2',
      totalEstimatedActualSpendUsd: 0.0155,
      totalBudgetCeilingUsd: 0.5,
    });
    expect(accepted.baseline.scenarioSetHash).toMatch(/^[a-f0-9]{64}$/);

    const retry = acceptFrozenRealProviderBaseline(db, {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    });
    expect(retry.action).toBe('already_frozen');

    await persistBaselineCandidate('chat-eval-second-live-candidate', '2026-07-23T10:00:00.000Z');
    expect(() => acceptFrozenRealProviderBaseline(db, {
      runId: 'chat-eval-second-live-candidate',
      evidenceJsonPath: 'docs/release/eval-evidence/chat-eval-second-live-candidate.json',
      evidenceMarkdownPath: 'docs/release/eval-evidence/chat-eval-second-live-candidate.md',
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    })).toThrow(/already frozen/i);

    expect(() => db.prepare(`UPDATE chat_eval_runs SET average_score = 1 WHERE run_id = ?`).run(runId))
      .toThrow(/frozen baseline/i);
    expect(() => db.prepare(`DELETE FROM chat_eval_scenario_results WHERE run_id = ?`).run(runId))
      .toThrow(/frozen baseline/i);
    expect(() => db.prepare(`DELETE FROM chat_eval_frozen_baselines`).run())
      .toThrow(/immutable/i);
  });

  it('fails baseline acceptance closed outside staging and for malformed evidence or archive identities', async () => {
    const runId = 'chat-eval-invalid-live-baseline';
    await persistBaselineCandidate(runId);
    const input = {
      runId,
      evidenceJsonPath: `docs/release/eval-evidence/${runId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${runId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    } as const;

    expect(() => acceptFrozenRealProviderBaseline(db, {
      ...input,
      runtime: { nodeEnv: 'production', staging: 'false' },
    })).toThrow(/staging/i);
    expect(() => acceptFrozenRealProviderBaseline(db, {
      ...input,
      evidenceJsonPath: `reports/chat-eval/${runId}.json`,
    })).toThrow(/docs\/release\/eval-evidence/i);

    db.prepare(`UPDATE chat_eval_runs SET production_data_used = 1 WHERE run_id = ?`).run(runId);
    expect(() => acceptFrozenRealProviderBaseline(db, input)).toThrow(/synthetic|production data/i);
  });

  it('recomputes every frozen headline metric from the persisted scenario evidence', async () => {
    const runId = 'chat-eval-recomputed-baseline';
    await persistBaselineCandidate(runId);

    // A client-declared aggregate that disagrees with the scenario rows it
    // claims to summarise must never become the permanent baseline.
    for (const [column, value] of [
      ['average_score', 4.5],
      ['pass_count', 99],
      ['fail_count', 99],
      ['blocked_count', 99],
      ['partial_count', 99],
    ] as const) {
      const original = db.prepare(`SELECT ${column} AS value FROM chat_eval_runs WHERE run_id = ?`).get(runId) as { value: number };
      db.prepare(`UPDATE chat_eval_runs SET ${column} = ? WHERE run_id = ?`).run(value, runId);
      expect(() => acceptFrozenRealProviderBaseline(db, {
        runId,
        ...archiveIdentityFor(runId),
        runtime: { nodeEnv: 'staging', staging: 'true' },
      })).toThrow(/recomputed|scenario evidence/i);
      db.prepare(`UPDATE chat_eval_runs SET ${column} = ? WHERE run_id = ?`).run(original.value, runId);
    }

    // The unmodified run still freezes, so the check is a real cross-check and
    // not an unconditional refusal.
    expect(acceptFrozenRealProviderBaseline(db, {
      runId,
      ...archiveIdentityFor(runId),
      runtime: { nodeEnv: 'staging', staging: 'true' },
    }).action).toBe('created');
  });

  it('binds the frozen baseline to the exact archive bytes and the run-declared report paths', async () => {
    const runId = 'chat-eval-archive-bound-baseline';
    await persistBaselineCandidate(runId);
    const input = {
      runId,
      ...archiveIdentityFor(runId),
      runtime: { nodeEnv: 'staging', staging: 'true' },
    };

    // Content identity is mandatory and must be a full digest.
    for (const override of [
      { evidenceJsonSha256: undefined },
      { evidenceMarkdownSha256: undefined },
      { evidenceJsonSha256: 'e'.repeat(63) },
      { evidenceMarkdownSha256: 'F'.repeat(64) },
      { evidenceJsonSha256: 'not-a-digest' },
    ] as Array<Record<string, unknown>>) {
      expect(() => acceptFrozenRealProviderBaseline(db, { ...input, ...override } as never))
        .toThrow(/sha-?256|digest/i);
    }

    // A run id that could escape the canonical archive directory is refused.
    expect(() => acceptFrozenRealProviderBaseline(db, {
      ...input,
      runId: '../../etc/passwd',
    })).toThrow(/run id|docs\/release\/eval-evidence/i);

    // The frozen paths must match what the run itself recorded at POST time.
    db.prepare(`UPDATE chat_eval_runs SET json_report_path = ? WHERE run_id = ?`)
      .run('docs/release/eval-evidence/some-other-run.json', runId);
    expect(() => acceptFrozenRealProviderBaseline(db, input)).toThrow(/report path|archive/i);
    db.prepare(`UPDATE chat_eval_runs SET json_report_path = ? WHERE run_id = ?`)
      .run(`docs/release/eval-evidence/${runId}.json`, runId);

    const accepted = acceptFrozenRealProviderBaseline(db, input);
    expect(accepted.action).toBe('created');
    expect(accepted.baseline).toMatchObject({
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
    });

    // The recorded digests are part of the immutable identity: an exact retry
    // is idempotent, a different archive is refused.
    expect(acceptFrozenRealProviderBaseline(db, input).action).toBe('already_frozen');
    expect(() => acceptFrozenRealProviderBaseline(db, {
      ...input,
      evidenceJsonSha256: '0'.repeat(64),
    })).toThrow(/already frozen/i);
  });

  it('records deployed-artifact provenance for a server-attested run without any acknowledgement', async () => {
    const runId = 'chat-eval-attested-baseline';
    await persistBaselineCandidate(runId, '2026-07-22T10:00:00.000Z', { deployedRelease: true });

    const accepted = acceptFrozenRealProviderBaseline(db, {
      runId,
      ...archiveIdentityFor(runId),
      runtime: { nodeEnv: 'staging', staging: 'true' },
    });
    expect(accepted.baseline).toMatchObject({
      provenanceClass: 'deployed_artifact_attested',
      deployedRuntimeSha: 'c'.repeat(40),
      deployedArtifactDigest: 'd'.repeat(64),
    });
  });

  it('refuses an unattested legacy run unless the reduced provenance is explicitly acknowledged', async () => {
    const runId = 'chat-eval-legacy-provenance-baseline';
    await persistBaselineCandidate(runId, '2026-07-22T10:00:00.000Z', { deployedRelease: false });
    const input = {
      runId,
      ...archiveIdentityFor(runId),
      runtime: { nodeEnv: 'staging', staging: 'true' },
    };

    // Silence is never consent: a run with no server-attested artifact identity
    // cannot become the permanent baseline by default.
    expect(() => acceptFrozenRealProviderBaseline(db, input))
      .toThrow(/provenance|deployed release identity/i);

    const accepted = acceptFrozenRealProviderBaseline(db, {
      ...input,
      acknowledgeOperatorCheckoutProvenance: true,
    });
    expect(accepted.action).toBe('created');
    expect(accepted.baseline).toMatchObject({
      provenanceClass: 'operator_checkout_only',
      deployedRuntimeSha: null,
      deployedArtifactDigest: null,
    });

    // The reduced provenance is part of the immutable identity and is surfaced
    // on the read model, so it can never be cited as artifact-bound evidence.
    expect(readFrozenRealProviderBaselineState(db).baseline).toMatchObject({
      provenanceClass: 'operator_checkout_only',
    });
  });

  it('never lets an acknowledgement downgrade a run that did attest its artifact', async () => {
    const runId = 'chat-eval-attested-not-downgradable';
    await persistBaselineCandidate(runId, '2026-07-22T10:00:00.000Z', { deployedRelease: true });

    const accepted = acceptFrozenRealProviderBaseline(db, {
      runId,
      ...archiveIdentityFor(runId),
      runtime: { nodeEnv: 'staging', staging: 'true' },
      acknowledgeOperatorCheckoutProvenance: true,
    });
    expect(accepted.baseline.provenanceClass).toBe('deployed_artifact_attested');
  });

  it('diffs later compatible real-provider evidence against the frozen identity and refuses incompatible claims', async () => {
    const baselineRunId = 'chat-eval-baseline-delta';
    await persistBaselineCandidate(baselineRunId);
    acceptFrozenRealProviderBaseline(db, {
      runId: baselineRunId,
      evidenceJsonPath: `docs/release/eval-evidence/${baselineRunId}.json`,
      evidenceMarkdownPath: `docs/release/eval-evidence/${baselineRunId}.md`,
      evidenceJsonSha256: EVIDENCE_JSON_SHA,
      evidenceMarkdownSha256: EVIDENCE_MARKDOWN_SHA,
      runtime: { nodeEnv: 'staging', staging: 'true' },
    });

    expect(readFrozenRealProviderBaselineState(db)).toMatchObject({
      status: 'baseline_only',
      baseline: { runId: baselineRunId },
      latestFollowup: null,
      comparison: null,
    });

    const followupRunId = 'chat-eval-compatible-followup';
    await persistBaselineCandidate(followupRunId, '2026-07-23T10:00:00.000Z');
    db.prepare(`UPDATE chat_eval_runs SET average_score = average_score + 0.05 WHERE run_id = ?`).run(followupRunId);
    const comparable = readFrozenRealProviderBaselineState(db);
    expect(comparable).toMatchObject({
      status: 'comparable',
      baseline: { runId: baselineRunId },
      latestFollowup: { runId: followupRunId },
      comparison: {
        comparable: true,
        reason: null,
        averageScoreDelta: 0.05,
        estimatedActualSpendUsdDelta: 0,
      },
    });

    db.prepare(`UPDATE chat_eval_scenario_results SET scenario_id = 'different-contract' WHERE run_id = ? AND id = (
      SELECT MIN(id) FROM chat_eval_scenario_results WHERE run_id = ?
    )`).run(followupRunId, followupRunId);
    expect(readFrozenRealProviderBaselineState(db)).toMatchObject({
      status: 'incompatible',
      comparison: { reason: 'followup_evidence_invalid', averageScoreDelta: null },
    });

    const evidenceRow = db.prepare(`
      SELECT cost_attestation_json, preflight_attestation_json
      FROM chat_eval_runs WHERE run_id = ?
    `).get(followupRunId) as { cost_attestation_json: string; preflight_attestation_json: string };
    const cost = JSON.parse(evidenceRow.cost_attestation_json);
    const preflight = JSON.parse(evidenceRow.preflight_attestation_json);
    cost.preparation.scenarioIds = cost.preparation.scenarioIds
      .map((id: string) => id === 'morning_planning' ? 'different-contract' : id)
      .sort();
    preflight.supportedScenarioIds = preflight.supportedScenarioIds
      .map((id: string) => id === 'morning_planning' ? 'different-contract' : id)
      .sort();
    db.prepare(`
      UPDATE chat_eval_runs
      SET cost_attestation_json = ?, preflight_attestation_json = ?
      WHERE run_id = ?
    `).run(JSON.stringify(cost), JSON.stringify(preflight), followupRunId);
    expect(readFrozenRealProviderBaselineState(db)).toMatchObject({
      status: 'incompatible',
      comparison: {
        comparable: false,
        reason: 'scenario_set_mismatch',
        averageScoreDelta: null,
      },
    });
  });

  it('persists ceilings, actual spend, attempt commitments, and judge estimates as distinct evidence', async () => {
    const result = await runChatEvaluationSuite({
      mode: 'real_provider',
      generatedAt: '2026-04-29T12:00:00.000Z',
      executor: makeLiveExecutor('real_provider'),
      judgeOptions: noSpendJudgeOptions,
    });
    persistChatEvalRun(result, {
      db,
      runId: 'chat-eval-cost-evidence',
      budgetUsd: 0.5,
      preflightAttestation: { providerPolicy: 'metered_cloud_only' },
      costAttestation: {
        contractVersion: 'chat-live-eval-v1',
        attested: true,
        reasons: [],
        totalCeilingUsd: 0.5,
        targetCeilingUsd: 0.45,
        judgeCeilingUsd: 0.05,
        targetActualSpendUsd: 0.012,
        targetReservedAttemptCeilingUsd: 0.03,
        targetCommittedCeilingUsd: 0.042,
        judgeEstimatedSpendUsd: 0.004,
        judgeActualSpendUsd: 0.002,
        judgeReservedAttemptCeilingUsd: 0.004,
        judgeCommittedCeilingUsd: 0.006,
        judgeUsageCallCount: 1,
        judgeProviderAttemptCount: 1,
        judgeProviders: ['gemini'],
        judgeModels: ['gemini-2.5-flash-lite'],
        judgeUnresolvedPricingCount: 0,
        judgeUsageDatabaseSha256: 'b'.repeat(64),
        totalActualSpendUsd: 0.014,
        totalEstimatedActualSpendUsd: 0.014,
        totalConservativeCommitmentUsd: 0.048,
        targetUsageCallCount: 3,
        targetProviderAttemptCount: 4,
        targetProviders: ['gemini'],
        unresolvedPricingCount: 0,
        preparation: {
          scenarioCount: 1,
          scenarioIds: ['morning_planning'],
          seedProfileVersions: ['single-tenant-live-v2'],
          seedProfileHashes: ['a'.repeat(64)],
          aggregateResetCounts: { messages: 2 },
        },
      },
    });

    const row = db.prepare('SELECT * FROM chat_eval_runs WHERE run_id = ?').get('chat-eval-cost-evidence') as any;
    expect(row.total_budget_ceiling_usd).toBe(0.5);
    expect(row.target_budget_ceiling_usd).toBe(0.45);
    expect(row.judge_budget_ceiling_usd).toBe(0.05);
    expect(row.target_actual_spend_usd).toBe(0.012);
    expect(row.target_reserved_attempt_ceiling_usd).toBe(0.03);
    expect(row.judge_estimated_spend_usd).toBe(0.004);
    expect(JSON.parse(row.cost_attestation_json)).toMatchObject({
      targetActualSpendUsd: 0.012,
      targetReservedAttemptCeilingUsd: 0.03,
      judgeActualSpendUsd: 0.002,
      judgeUsageCallCount: 1,
      judgeUsageDatabaseSha256: 'b'.repeat(64),
      totalActualSpendUsd: 0.014,
      totalCeilingUsd: 0.5,
    });

    const mapped = listChatEvalRuns(db, { mode: 'real_provider' })[0];
    expect(mapped.costAttestation?.targetActualSpendUsd).toBe(0.012);
    expect(mapped.preflightAttestation).toEqual({ providerPolicy: 'metered_cloud_only' });
  });

  it('persists aggregate score, report metadata, and per-scenario results', async () => {
    const result = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });

    const persisted = persistChatEvalRun(result, {
      db,
      runId: 'chat-eval-test',
      packageVersion: '4.14.190',
      gitBranch: 'feature/chat-eval',
      gitCommit: 'abc1234',
      jsonReportPath: 'reports/chat-eval/test.json',
      markdownReportPath: 'reports/chat-eval/test.md',
      budgetUsd: 4,
    });

    expect(persisted.runId).toBe('chat-eval-test');
    expect(persisted.scenarioCount).toBe(result.scenarioCount);

    const run = db.prepare('SELECT * FROM chat_eval_runs WHERE run_id = ?').get('chat-eval-test') as any;
    expect(run.mode).toBe('fixture');
    expect(run.average_score).toBe(result.averageScore);
    expect(run.scenario_count).toBe(result.scenarioCount);
    expect(run.pass_count).toBe(result.statusCounts.pass);
    expect(run.passed).toBe(result.passed ? 1 : 0);
    expect(run.production_data_used).toBe(0);
    expect(run.real_provider_calls).toBe(0);
    expect(run.budget_usd).toBe(4);
    expect(run.json_report_path).toBe('reports/chat-eval/test.json');

    const dayToDaySummary = JSON.parse(run.day_to_day_summary_json);
    expect(dayToDaySummary).toMatchObject({
      mode: 'fixture',
      passed: true,
      scenarioCount: result.dayToDay.scenarios.length,
      profileCoverage: result.dayToDay.profileCoverage,
      catalogCoverage: result.catalogCoverage,
      localeLeakage: { observedTurnCount: 0, leakedTurnCount: 0, unknownTurnCount: 0 },
    });
    expect(JSON.stringify(dayToDaySummary)).not.toContain('userMessage');
    expect(JSON.stringify(dayToDaySummary)).not.toContain('turns');

    const scenarioCount = db.prepare('SELECT COUNT(*) as count FROM chat_eval_scenario_results WHERE run_id = ?')
      .get('chat-eval-test') as { count: number };
    expect(scenarioCount.count).toBe(result.scenarioCount);

    const firstScenario = db.prepare('SELECT * FROM chat_eval_scenario_results WHERE run_id = ? ORDER BY id ASC LIMIT 1')
      .get('chat-eval-test') as any;
    expect(JSON.parse(firstScenario.failures_json)).toEqual(expect.any(Array));
    expect(JSON.parse(firstScenario.notes_json)).toEqual(expect.any(Array));
    expect(JSON.parse(firstScenario.scores_json)).toHaveProperty('correctness');
  });

  it('updates an existing run idempotently instead of duplicating scenario rows', async () => {
    const first = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const second = await runChatEvaluationSuite({
      mode: 'real_provider',
      generatedAt: '2026-04-29T12:30:00.000Z',
      executor: makeLiveExecutor('real_provider'),
      judgeOptions: noSpendJudgeOptions,
    });

    persistChatEvalRun(first, { db, runId: 'chat-eval-repeat' });
    persistChatEvalRun(second, { db, runId: 'chat-eval-repeat', realProviderCalls: 7 });

    const runCount = db.prepare('SELECT COUNT(*) as count FROM chat_eval_runs WHERE run_id = ?')
      .get('chat-eval-repeat') as { count: number };
    const scenarioCount = db.prepare('SELECT COUNT(*) as count FROM chat_eval_scenario_results WHERE run_id = ?')
      .get('chat-eval-repeat') as { count: number };
    const run = db.prepare('SELECT * FROM chat_eval_runs WHERE run_id = ?').get('chat-eval-repeat') as any;

    expect(runCount.count).toBe(1);
    expect(scenarioCount.count).toBe(second.scenarioCount);
    expect(run.mode).toBe('real_provider');
    expect(run.real_provider_calls).toBe(7);
  });

  it('lists recent runs with parsed metadata only', async () => {
    const first = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const second = await runChatEvaluationSuite({
      mode: 'real_provider',
      generatedAt: '2026-04-30T12:00:00.000Z',
      executor: makeLiveExecutor('real_provider'),
      judgeOptions: noSpendJudgeOptions,
    });

    persistChatEvalRun(first, { db, runId: 'chat-eval-old' });
    persistChatEvalRun(second, { db, runId: 'chat-eval-new', realProviderCalls: true });

    const runs = listChatEvalRuns(db, { limit: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('chat-eval-new');
    expect(runs[0].qualityMetrics[0]).toHaveProperty('privacy');
    expect(runs[0].dayToDaySummary).toHaveProperty('failureSummary');
    expect(JSON.stringify(runs[0])).not.toContain('userMessage');
  });

  it('returns null for the latest run of a mode that has never been recorded', () => {
    expect(getLatestChatEvalRunForMode(db, 'local_engine')).toBeNull();
  });

  it('returns the newest run for the requested mode by insertion recency (created_at, id)', async () => {
    const older = await runChatEvaluationSuite({
      mode: 'local_engine',
      generatedAt: '2026-05-01T10:00:00.000Z',
      executor: makeLiveExecutor('local_engine'),
    });
    const newer = await runChatEvaluationSuite({
      mode: 'local_engine',
      generatedAt: '2026-05-02T10:00:00.000Z',
      executor: makeLiveExecutor('local_engine'),
    });

    persistChatEvalRun(older, { db, runId: 'chat-eval-local-old' });
    persistChatEvalRun(newer, { db, runId: 'chat-eval-local-new' });

    const latest = getLatestChatEvalRunForMode(db, 'local_engine');
    expect(latest).not.toBeNull();
    expect(latest?.runId).toBe('chat-eval-local-new');
    expect(latest?.mode).toBe('local_engine');
    expect(latest?.generatedAt).toBe('2026-05-02T10:00:00.000Z');
    expect(latest?.passed).toBe(newer.passed);
    expect(typeof latest?.id).toBe('number');
    expect(typeof latest?.createdAt).toBe('string');
  });

  it('is immune to report-clock rollbacks: the last INSERTED run wins even with an older generated_at', async () => {
    const futureClock = await runChatEvaluationSuite({
      mode: 'local_engine',
      generatedAt: '2027-01-01T10:00:00.000Z', // report clock skewed into the future
      executor: makeLiveExecutor('local_engine'),
    });
    const latestInserted = await runChatEvaluationSuite({
      mode: 'local_engine',
      generatedAt: '2026-05-01T10:00:00.000Z', // sane clock, inserted LAST
      executor: makeLiveExecutor('local_engine'),
    });

    persistChatEvalRun(futureClock, { db, runId: 'chat-eval-local-skewed' });
    persistChatEvalRun(latestInserted, { db, runId: 'chat-eval-local-latest' });

    // Ordering by generated_at would resurface the skewed run; insertion
    // recency (created_at DESC, id DESC) must return the last recorded run.
    const latest = getLatestChatEvalRunForMode(db, 'local_engine');
    expect(latest?.runId).toBe('chat-eval-local-latest');
  });

  it('isolates latest-run lookups per mode', async () => {
    const fixtureRun = await runChatEvaluationSuite({
      mode: 'fixture',
      generatedAt: '2026-05-03T10:00:00.000Z',
    });
    const localRun = await runChatEvaluationSuite({
      mode: 'local_engine',
      generatedAt: '2026-05-01T10:00:00.000Z',
      executor: makeLiveExecutor('local_engine'),
    });

    persistChatEvalRun(fixtureRun, { db, runId: 'chat-eval-fixture-newest' });
    persistChatEvalRun(localRun, { db, runId: 'chat-eval-local-older' });

    expect(getLatestChatEvalRunForMode(db, 'fixture')?.runId).toBe('chat-eval-fixture-newest');
    expect(getLatestChatEvalRunForMode(db, 'local_engine')?.runId).toBe('chat-eval-local-older');
    expect(getLatestChatEvalRunForMode(db, 'real_provider')).toBeNull();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertContentLiveEvalBudgetPreflight,
  assertContentLiveEvalRunDeadline,
  assertContentLiveEvalRunnerRuntime,
  assertContentLiveEvalAuthPath,
  assertContentLiveEvalDatabasePath,
  bindContentLiveEvalAttemptInvocations,
  ContentLiveEvalError,
  parseContentLiveEvalArgs,
  requestContentLiveEvalScenario,
  writeContentLiveEvalArtifactExclusive,
} from '../../scripts/run-content-eval-live';
import {
  CONTENT_LIVE_EVAL_CORPUS,
  CONTENT_LIVE_EVAL_OPT_IN,
} from '../../src/services/content-live-evaluation-artifact';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function isolatedArguments(): string[] {
  return [
    '--opt-in', CONTENT_LIVE_EVAL_OPT_IN,
    '--budget-usd', '1.00',
    '--database-path', '/private/tmp/content-live-eval-unit.db',
    '--auth-file', '/private/tmp/content-live-eval-auth.json',
    '--attestation-key-file', '/private/tmp/content-live-eval-attestation.key',
  ];
}

describe('Content live-evaluation runner policy', () => {
  it('launches through a private clean environment with stale-runtime and trap hygiene', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'scripts/content-live-eval-local.sh'), 'utf8');
    const engineSource = readFileSync(path.resolve(process.cwd(), 'scripts/full-nexus-local-engine.sh'), 'utf8');
    const debugAuthSource = readFileSync(path.resolve(process.cwd(), 'scripts/local-ios-debug-auth.mjs'), 'utf8');
    expect(source).toContain('umask 077');
    expect(source.match(/env -i/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('--untracked-files=all');
    expect(source).toContain('src scripts content-engine migrations package.json package-lock.json tsconfig.json');
    expect(source).toContain('--attestation-key-file');
    expect(source).toContain('NEXUS_BACKGROUND_JOBS_ENABLED=0');
    expect(source).toContain('CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256');
    expect(source).toContain('trap cleanup EXIT INT TERM');
    expect(source).toContain('runtime-*');
    expect(source).toContain('chmod 600');
    expect(engineSource).toContain('NEXUS_CONTENT_LIVE_EVAL_RUNTIME');
    expect(engineSource).toContain('exec env -i');
    expect(engineSource).toContain('CONTENT_ENGINE_FIXTURE_MODE=0');
    expect(engineSource).toContain('CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED=1');
    expect(engineSource).not.toContain('CONTENT_ENGINE_FIXTURE_MODE=1');
    expect(debugAuthSource).toContain('user_ai_budget_overrides');
    expect(debugAuthSource).toContain("'local_debug_max_access'");
  });

  it('refuses Node outside the exact supported release range before startup or provider work', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'content-live-eval-node-'));
    temporaryDirectories.push(directory);
    const fakeNode = path.join(directory, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\necho 25.7.0\n', { mode: 0o700 });
    chmodSync(fakeNode, 0o700);
    const result = spawnSync('bash', [
      path.resolve(process.cwd(), 'scripts/content-live-eval-local.sh'),
      '--opt-in', CONTENT_LIVE_EVAL_OPT_IN,
      '--budget-usd', '1.00',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires the repository-supported Node 22.23.x runtime');
    expect(result.stderr).not.toContain('attestation key');
  });

  it('fails without exact cost opt-in and a mandatory usable hard budget', () => {
    expect(() => parseContentLiveEvalArgs(isolatedArguments().slice(2), {})).toThrowError(ContentLiveEvalError);
    expect(() => parseContentLiveEvalArgs([
      ...isolatedArguments().filter((entry, index, all) => all[index - 1] !== '--budget-usd' && entry !== '--budget-usd'),
    ], {})).toThrowError(ContentLiveEvalError);
    expect(() => parseContentLiveEvalArgs([
      '--opt-in', CONTENT_LIVE_EVAL_OPT_IN,
      '--budget-usd', '0.99',
      '--database-path', '/private/tmp/content-live-eval-unit.db',
      '--auth-file', '/private/tmp/content-live-eval-auth.json',
    ], {})).toThrowError(/between 1\.00 and 1\.00/);
  });

  it('requires the isolated runtime flag in addition to model and budget controls', () => {
    const safe = {
      NODE_ENV: 'development',
      NEXUS_CONTENT_LIVE_EVAL_RUNTIME: '1',
      CONTENT_LIVE_EVAL_ENABLED: '1',
      NEXUS_LOCAL_ALLOW_MODEL_CALLS: '1',
      PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED: 'true',
    };
    expect(() => assertContentLiveEvalRunnerRuntime(safe)).not.toThrow();
    expect(() => assertContentLiveEvalRunnerRuntime({
      ...safe,
      NEXUS_CONTENT_LIVE_EVAL_RUNTIME: undefined,
    })).toThrowError(/isolated Content live-evaluation runtime/);
  });

  it('reserves the conservative per-sample ceiling for every remaining corpus item', () => {
    expect(() => assertContentLiveEvalBudgetPreflight({
      budgetUsd: 1,
      spentUsd: 0,
      remainingSamples: 5,
    })).not.toThrow();
    expect(() => assertContentLiveEvalBudgetPreflight({
      budgetUsd: 1,
      spentUsd: 0.01,
      remainingSamples: 5,
    })).toThrowError(/every remaining fixed corpus sample/);
    expect(() => assertContentLiveEvalBudgetPreflight({
      budgetUsd: 1,
      spentUsd: 0.79,
      remainingSamples: 1,
    })).not.toThrow();
    expect(() => assertContentLiveEvalBudgetPreflight({
      budgetUsd: 1,
      spentUsd: 0.81,
      remainingSamples: 1,
    })).toThrowError(ContentLiveEvalError);
  });

  it('retains usage-less failed attempts and binds the successful usage to the later reservation', () => {
    const scenario = CONTENT_LIVE_EVAL_CORPUS[0];
    const invocations = bindContentLiveEvalAttemptInvocations([
      {
        id: 1,
        created_at: '2026-07-19T10:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5-mini',
        provider_category: 'content_engine_script_standard',
        reserved_cost_usd: 0.05,
      },
      {
        id: 2,
        created_at: '2026-07-19T10:00:01.000Z',
        provider: 'openai',
        model: 'gpt-5-mini',
        provider_category: 'content_engine_script_standard',
        reserved_cost_usd: 0.04,
      },
    ], [{
      id: 99,
      ts: '2026-07-19T10:00:02.000Z',
      category: 'content_engine_script_standard',
      provider: 'openai',
      model: 'gpt-5-mini',
      input_tokens: 500,
      output_tokens: 300,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      pricing_status: 'resolved',
    }], 'content-live-eval-runner-bind-20260719', scenario);

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({ status: 'failed', reservedCostUsd: 0.05, costUsd: 0 });
    expect(invocations[1]).toMatchObject({ status: 'succeeded', reservedCostUsd: 0.04, costUsd: 0.01 });
  });

  it('rejects arbitrary model-family prefixes that are not registered snapshots', () => {
    const scenario = CONTENT_LIVE_EVAL_CORPUS[0];
    expect(() => bindContentLiveEvalAttemptInvocations([{
      id: 1,
      created_at: '2026-07-19T10:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5-mini',
      provider_category: 'content_engine_script_standard',
      reserved_cost_usd: 0.05,
    }], [{
      id: 2,
      ts: '2026-07-19T10:00:01.000Z',
      category: 'content_engine_script_standard',
      provider: 'openai',
      model: 'gpt-5-mini-unreviewed-family',
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      pricing_status: 'resolved',
    }], 'content-live-eval-model-bind-20260719', scenario)).toThrowError(/did not bind/);
  });

  it('rejects date-shaped provider snapshots that were never explicitly reviewed', () => {
    const scenario = CONTENT_LIVE_EVAL_CORPUS[0];
    expect(() => bindContentLiveEvalAttemptInvocations([{
      id: 1,
      created_at: '2026-07-19T10:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5-mini',
      provider_category: 'content_engine_script_standard',
      reserved_cost_usd: 0.05,
    }], [{
      id: 2,
      ts: '2026-07-19T10:00:01.000Z',
      category: 'content_engine_script_standard',
      provider: 'openai',
      model: 'gpt-5-mini-2099-01-01',
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      pricing_status: 'resolved',
    }], 'content-live-eval-unreviewed-snapshot-20260719', scenario)).toThrowError(/did not bind/);
  });

  it('binds the reviewed OpenAI snapshot and the finite standard fallback categories', () => {
    const scenario = CONTENT_LIVE_EVAL_CORPUS[0];
    const openAi = bindContentLiveEvalAttemptInvocations([{
      id: 1,
      created_at: '2026-07-19T10:00:00.000Z',
      provider: 'openai',
      model: 'gpt-4o-mini',
      provider_category: 'content_engine_script_standard_openai_fallback',
      reserved_cost_usd: 0.05,
    }], [{
      id: 2,
      ts: '2026-07-19T10:00:01.000Z',
      category: 'content_engine_script_standard_openai_fallback',
      provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      pricing_status: 'resolved',
    }], 'content-live-eval-openai-fallback-20260719', scenario);
    expect(openAi[0]).toMatchObject({
      status: 'succeeded',
      providerCategory: 'content_engine_script_standard_openai_fallback',
      model: 'gpt-4o-mini',
      resolvedModel: 'gpt-4o-mini-2024-07-18',
    });

    const gemini = bindContentLiveEvalAttemptInvocations([{
      id: 3,
      created_at: '2026-07-19T10:00:00.000Z',
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      provider_category: 'content_engine_script_standard_gemini_model_fallback',
      reserved_cost_usd: 0.05,
    }], [{
      id: 4,
      ts: '2026-07-19T10:00:01.000Z',
      category: 'content_engine_script_standard_gemini_model_fallback',
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      pricing_status: 'resolved',
    }], 'content-live-eval-gemini-fallback-20260719', scenario);
    expect(gemini[0]).toMatchObject({
      status: 'succeeded',
      providerCategory: 'content_engine_script_standard_gemini_model_fallback',
      resolvedModel: 'gemini-2.5-flash-lite',
    });
  });

  it('bounds each HTTP sample and the whole run', async () => {
    await expect(requestContentLiveEvalScenario({
      baseUrl: new URL('http://127.0.0.1:18200'),
      accessToken: 'synthetic-token',
      runId: 'content-live-eval-timeout-20260719',
      budgetUsd: 1,
      scenario: CONTENT_LIVE_EVAL_CORPUS[0],
      timeoutMs: 5,
      fetchImpl: (() => new Promise(() => {})) as typeof fetch,
    })).rejects.toMatchObject({ code: 'sample_timeout' });
    await expect(requestContentLiveEvalScenario({
      baseUrl: new URL('http://127.0.0.1:18200'),
      accessToken: 'synthetic-token',
      runId: 'content-live-eval-body-timeout-20260719',
      budgetUsd: 1,
      scenario: CONTENT_LIVE_EVAL_CORPUS[0],
      timeoutMs: 5,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      } as Response)) as typeof fetch,
    })).rejects.toMatchObject({ code: 'sample_timeout' });
    expect(() => assertContentLiveEvalRunDeadline(0)).toThrowError(/bounded deadline/);
  });

  it('rejects a correctly named database symlink even when its target is under /private/tmp', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'content-live-eval-path-'));
    temporaryDirectories.push(directory);
    const target = path.join(directory, 'real.db');
    const link = path.join(directory, 'content-live-eval-symlink.db');
    writeFileSync(target, 'not-a-real-database');
    symlinkSync(target, link);

    expect(() => assertContentLiveEvalDatabasePath(link)).toThrowError(/symlink/);
  });

  it('rejects a correctly named auth symlink beside a regular disposable database', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'content-live-eval-auth-path-'));
    temporaryDirectories.push(directory);
    const database = path.join(directory, 'content-live-eval-auth-test.db');
    const authTarget = path.join(directory, 'real-auth.json');
    const authLink = path.join(directory, 'content-live-eval-auth.json');
    writeFileSync(database, 'not-a-real-database');
    writeFileSync(authTarget, '{}');
    symlinkSync(authTarget, authLink);

    const resolvedDatabase = assertContentLiveEvalDatabasePath(database);
    expect(() => assertContentLiveEvalAuthPath(authLink, resolvedDatabase)).toThrowError(/symlink/);
  });

  it('refuses an artifact target that appears after preflight instead of overwriting it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'content-live-eval-output-race-'));
    temporaryDirectories.push(directory);
    const target = path.join(directory, 'artifact.json');
    writeFileSync(target, 'competing process owns this path', { mode: 0o600 });

    expect(() => writeContentLiveEvalArtifactExclusive(target, { safe: true }))
      .toThrowError(/target appeared/);
    expect(readFileSync(target, 'utf8')).toBe('competing process owns this path');
  });
});

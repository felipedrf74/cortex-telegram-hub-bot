import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  postChatEvalHistoryWithRecovery,
  readChatEvalPortalRetryPayload,
  replayChatEvalPortalRetryPayload,
} from '../../src/services/chat-eval-portal-retry';

const temporaryDirectories: string[] = [];

function temporaryRunDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-eval-retry-'));
  temporaryDirectories.push(directory);
  return directory;
}

function portalPayload(): Record<string, unknown> {
  return {
    result: {
      generatedAt: '2026-07-30T12:00:00.000Z',
      mode: 'real_provider',
      passed: true,
      averageScore: 0.98,
      scenarioCount: 7,
      statusCounts: { pass: 7, partial: 0, fail: 0, blocked: 0 },
      qualityMetrics: [],
      dayToDay: { scenarios: [] },
      scenarios: [],
    },
    runId: 'chat-eval-2026-07-30T12-00-00-000Z',
    packageVersion: '4.14.226',
    gitBranch: 'main',
    gitCommit: 'a'.repeat(40),
    jsonReportPath: 'docs/release/eval-evidence/run.json',
    markdownReportPath: 'docs/release/eval-evidence/run.md',
    budgetUsd: 0.5,
    productionDataUsed: false,
    realProviderCalls: 7,
    costAttestation: { attested: true },
    preflightAttestation: { contractVersion: 'chat-live-eval-v1' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('chat eval portal retry evidence', () => {
  it('writes the exact portal body privately before POST and retains it on failure', async () => {
    const runDirectory = temporaryRunDirectory();
    const payload = portalPayload();
    const fetchImpl = vi.fn(async () => new Response('temporary outage', { status: 503 }));

    await expect(postChatEvalHistoryWithRecovery({
      runDirectory,
      portalUrl: 'https://staging-api.nexushub.me',
      portalToken: 'portal-token',
      payload,
      fetchImpl,
    })).rejects.toThrow(/retry|payload|503/i);

    const payloadPath = path.join(realpathSync(runDirectory), 'portal-retry-payload.json');
    const saved = readChatEvalPortalRetryPayload(payloadPath);
    expect(saved.payload).toEqual(payload);
    expect(saved.rawBody).toBe(JSON.stringify(payload));
    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(payloadPath).mode & 0o777).toBe(0o600);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(saved.rawBody);
  });

  it('replays the same private payload idempotently without evaluator or provider work', async () => {
    const runDirectory = temporaryRunDirectory();
    const payload = portalPayload();
    const firstFetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, runId: payload.runId }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const written = await postChatEvalHistoryWithRecovery({
      runDirectory,
      portalUrl: 'https://staging-api.nexushub.me',
      portalToken: 'portal-token',
      payload,
      fetchImpl: firstFetch,
    });

    const replayFetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, runId: payload.runId }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const firstReplay = await replayChatEvalPortalRetryPayload({
      payloadPath: written.payloadPath,
      portalUrl: 'https://staging-api.nexushub.me',
      portalToken: 'portal-token',
      fetchImpl: replayFetch,
    });
    const secondReplay = await replayChatEvalPortalRetryPayload({
      payloadPath: written.payloadPath,
      portalUrl: 'https://staging-api.nexushub.me',
      portalToken: 'portal-token',
      fetchImpl: replayFetch,
    });

    expect(firstReplay).toEqual(secondReplay);
    expect(firstReplay).toMatchObject({
      runId: payload.runId,
      payloadPath: written.payloadPath,
      sha256: written.sha256,
    });
    expect(replayFetch).toHaveBeenCalledTimes(2);
    expect(replayFetch.mock.calls[0]?.[1]?.body).toBe(written.rawBody);
    expect(replayFetch.mock.calls[1]?.[1]?.body).toBe(written.rawBody);
  });
});

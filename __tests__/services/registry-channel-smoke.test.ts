// Phase 10 batch 55 (2026-05-16): alert-channel smoke run tests.
//
// Each test exercises one observable property of `runChannelSmoke`:
//
//   • Sends synthetic info-severity payload to every channel
//   • Marks dry_run vs sent vs failed correctly
//   • Survives a single broken channel (continues for the rest)
//   • Honors perChannelTimeoutMs
//   • Builds a payload tagged "[SMOKE]" so humans can recognise it
//   • formatChannelSmokeMarkdown renders a stable report shape

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  buildSmokeAlertPayload,
  formatChannelSmokeMarkdown,
  getRecentChannelSmokeResults,
  persistChannelSmokeResult,
  runChannelSmoke,
  summarizeChannelHealth,
} from '../../src/services/registry-channel-smoke';
import type { AlertChannel, AlertPayload } from '../../src/services/registry-cross-tenant-alert-hook';
import type { CrossTenantSeverity } from '../../src/services/registry-adversarial-discovery';

function makeStubChannel(id: string, minSeverity: CrossTenantSeverity = 'info'): {
  channel: AlertChannel;
  sent: AlertPayload[];
} {
  const sent: AlertPayload[] = [];
  return {
    sent,
    channel: {
      id, minSeverity,
      send: vi.fn(async (payload: AlertPayload) => {
        sent.push(payload);
      }),
    },
  };
}

describe('buildSmokeAlertPayload (Phase 10 batch 55)', () => {
  it('tags the payload with [SMOKE] in the title', () => {
    const payload = buildSmokeAlertPayload('2026-05-16T00:00:00Z');
    expect(payload.title).toContain('[SMOKE]');
  });

  it('uses info severity so per-channel minSeverity does not silently elevate the alert', () => {
    const payload = buildSmokeAlertPayload('2026-05-16T00:00:00Z');
    expect(payload.severity).toBe('info');
  });

  it('embeds a synthetic pattern with skill=platform / action=channel_smoke_run', () => {
    const payload = buildSmokeAlertPayload('2026-05-16T00:00:00Z');
    expect(payload.pattern.skill).toBe('platform');
    expect(payload.pattern.action).toBe('channel_smoke_run');
    expect(payload.pattern.outcome).toBe('smoke_run');
  });
});

describe('runChannelSmoke (Phase 10 batch 55)', () => {
  it('sends the smoke payload to every channel', async () => {
    const { channel: a, sent: aSent } = makeStubChannel('a');
    const { channel: b, sent: bSent } = makeStubChannel('b');
    const result = await runChannelSmoke([a, b], { nowIso: '2026-05-16T00:00:00Z' });
    expect(aSent.length).toBe(1);
    expect(bSent.length).toBe(1);
    expect(aSent[0].title).toContain('[SMOKE]');
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it('captures failures per-channel without aborting the smoke', async () => {
    const broken: AlertChannel = {
      id: 'broken', minSeverity: 'info',
      send: vi.fn(async () => { throw new Error('webhook 404'); }),
    };
    const { channel: ok, sent: okSent } = makeStubChannel('ok');
    const result = await runChannelSmoke([broken, ok]);
    expect(okSent.length).toBe(1);
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(1);
    const brokenEntry = result.entries.find((e) => e.channelId === 'broken');
    expect(brokenEntry?.status).toBe('failed');
    expect(brokenEntry?.errorMessage).toContain('webhook 404');
  });

  it('dryRun does not call send but still records a dry_run entry per channel', async () => {
    const { channel: a, sent: aSent } = makeStubChannel('a');
    const result = await runChannelSmoke([a], { dryRun: true });
    expect(aSent.length).toBe(0);
    expect(result.dryRunCount).toBe(1);
    expect(result.entries[0].status).toBe('dry_run');
  });

  it('returns an empty-but-valid result when no channels are registered', async () => {
    const result = await runChannelSmoke([]);
    expect(result.totalChannels).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it('times out a slow channel after perChannelTimeoutMs', async () => {
    const slow: AlertChannel = {
      id: 'slow', minSeverity: 'info',
      send: vi.fn(() => new Promise<void>(() => {/* never resolves */})),
    };
    const result = await runChannelSmoke([slow], { perChannelTimeoutMs: 50 });
    const entry = result.entries[0];
    expect(entry.status).toBe('failed');
    expect(entry.errorMessage).toContain('timeout');
  });

  it('records elapsed ms per channel', async () => {
    const { channel: a } = makeStubChannel('a');
    const result = await runChannelSmoke([a]);
    expect(result.entries[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('formatChannelSmokeMarkdown (Phase 10 batch 55)', () => {
  it('renders a stable header + summary + per-channel table', async () => {
    const { channel: a } = makeStubChannel('a');
    const { channel: b } = makeStubChannel('b');
    const result = await runChannelSmoke([a, b], { nowIso: '2026-05-16T00:00:00Z' });
    const md = formatChannelSmokeMarkdown(result);
    expect(md).toContain('# Alert-channel weekly smoke run');
    expect(md).toContain('_Generated 2026-05-16T00:00:00Z_');
    expect(md).toContain('Channels probed: **2**');
    expect(md).toContain('Sent: **2**');
    expect(md).toContain('| a |');
    expect(md).toContain('| b |');
  });

  it('handles the no-channels case with a documented placeholder', async () => {
    const result = await runChannelSmoke([]);
    const md = formatChannelSmokeMarkdown(result);
    expect(md).toContain('No channels registered');
  });

  it('reports the error message in the table when a channel fails', async () => {
    const broken: AlertChannel = {
      id: 'broken', minSeverity: 'info',
      send: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }),
    };
    const result = await runChannelSmoke([broken]);
    const md = formatChannelSmokeMarkdown(result);
    expect(md).toContain('ECONNREFUSED');
    expect(md).toContain('failed');
  });
});

describe('persistChannelSmokeResult + getRecentChannelSmokeResults (Phase 11 batch 56)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chat_alert_channel_smoke_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed', 'dry_run')),
        elapsed_ms INTEGER NOT NULL,
        error_message TEXT,
        generated_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(run_id, channel_id)
      );
    `);
  });

  afterEach(() => { db.close(); });

  it('persists one row per channel entry under a shared run_id', async () => {
    const { channel: a } = makeStubChannel('a');
    const { channel: b } = makeStubChannel('b');
    const result = await runChannelSmoke([a, b]);
    persistChannelSmokeResult(db, result);
    const rows = getRecentChannelSmokeResults(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].runId).toBe(result.runId);
    expect(rows[1].runId).toBe(result.runId);
  });

  it('persists the error message for failed channels', async () => {
    const broken: AlertChannel = {
      id: 'broken', minSeverity: 'info',
      send: vi.fn(async () => { throw new Error('upstream 503'); }),
    };
    const result = await runChannelSmoke([broken]);
    persistChannelSmokeResult(db, result);
    const rows = getRecentChannelSmokeResults(db);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].errorMessage).toContain('upstream 503');
  });

  it('upserts on (run_id, channel_id) conflict (re-running smoke updates the row)', async () => {
    const { channel: a } = makeStubChannel('a');
    const r1 = await runChannelSmoke([a]);
    persistChannelSmokeResult(db, r1);
    // Manufacture a re-run with the SAME runId (simulating retry of a single
    // run-id slot) but a different elapsed time.
    persistChannelSmokeResult(db, {
      ...r1,
      entries: [{ ...r1.entries[0], elapsedMs: 999 }],
    });
    const rows = getRecentChannelSmokeResults(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].elapsedMs).toBe(999);
  });

  it('filters by channelId', async () => {
    const { channel: a } = makeStubChannel('a');
    const { channel: b } = makeStubChannel('b');
    persistChannelSmokeResult(db, await runChannelSmoke([a, b]));
    const onlyA = getRecentChannelSmokeResults(db, { channelId: 'a' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].channelId).toBe('a');
  });

  it('filters by status', async () => {
    const ok = makeStubChannel('ok').channel;
    const broken: AlertChannel = {
      id: 'broken', minSeverity: 'info',
      send: vi.fn(async () => { throw new Error('fail'); }),
    };
    persistChannelSmokeResult(db, await runChannelSmoke([ok, broken]));
    const failures = getRecentChannelSmokeResults(db, { status: 'failed' });
    expect(failures).toHaveLength(1);
    expect(failures[0].channelId).toBe('broken');
  });

  it('filters by since timestamp', async () => {
    // Manually insert old and new rows.
    const ok = makeStubChannel('a').channel;
    const oldResult = await runChannelSmoke([ok], { nowIso: '2026-04-01T00:00:00Z' });
    const newResult = await runChannelSmoke([ok], { nowIso: '2026-05-16T00:00:00Z' });
    persistChannelSmokeResult(db, oldResult);
    persistChannelSmokeResult(db, newResult);
    const recent = getRecentChannelSmokeResults(db, { since: '2026-05-01T00:00:00Z' });
    expect(recent).toHaveLength(1);
    expect(recent[0].generatedAt).toBe('2026-05-16T00:00:00Z');
  });

  it('respects the limit option', async () => {
    const ok = makeStubChannel('a').channel;
    for (let i = 0; i < 5; i++) {
      persistChannelSmokeResult(db, await runChannelSmoke([ok], { nowIso: `2026-05-${10 + i}T00:00:00Z` }));
    }
    const limited = getRecentChannelSmokeResults(db, { limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('summarizeChannelHealth returns per-channel success rates', async () => {
    const ok = makeStubChannel('ok').channel;
    const broken: AlertChannel = {
      id: 'broken', minSeverity: 'info',
      send: vi.fn(async () => { throw new Error('fail'); }),
    };
    for (let i = 0; i < 4; i++) {
      persistChannelSmokeResult(db, await runChannelSmoke([ok, broken], { nowIso: `2026-05-${10 + i}T00:00:00Z` }));
    }
    const health = summarizeChannelHealth(db);
    const okRow = health.find((h) => h.channelId === 'ok');
    const brokenRow = health.find((h) => h.channelId === 'broken');
    expect(okRow?.successRate).toBe(1);
    expect(brokenRow?.successRate).toBe(0);
    expect(okRow?.totalRuns).toBe(4);
    // broken sorts first because lower success rate.
    expect(health[0].channelId).toBe('broken');
  });
});

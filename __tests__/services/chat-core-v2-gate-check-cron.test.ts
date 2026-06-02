// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// WP-13 (Batch B) — Chat Core v2 automated shadow gate-check cron body.
//
// Exercises `runChatCoreV2GateCheck` (the body the `chat_v2_gate_check` cron
// invokes) directly against an in-memory SQLite DB. The load-bearing invariant:
// the cron writes ONE honest gate-check audit row and `gateMet` is FALSE by
// construction until a real (non-synthetic, peer-reviewed, >= target) recall@8
// is persisted (WP-19-seed). This test never fakes a pass.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runChatCoreV2GateCheck } from '../../src/services/scheduler';
import { listChatCoreV2GateCheckLog } from '../../src/services/chat-core-v2/gate-metrics-store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('Chat Core v2 shadow gate-check cron body', () => {
  it('records one honest gate-check row with gateMet=false against an empty db', () => {
    // No shadow corpus, no persisted recall — the honest default state.
    const result = runChatCoreV2GateCheck(db);

    expect(result).not.toBeNull();
    expect(result!.gateMet).toBe(false);
    expect(result!.shadowRowCount).toBe(0);
    expect(result!.logRowId).toBeGreaterThan(0);

    // Exactly one audit row was appended, and it is honest.
    const log = listChatCoreV2GateCheckLog(db);
    expect(log).toHaveLength(1);
    expect(log[0].gateCanPromote).toBe(false);
    // No persisted recall yet => recall fields are honest-empty.
    expect(log[0].recallAt8).toBeNull();
    expect(log[0].recallMeetsTarget).toBe(false);
    expect(log[0].recallIsSyntheticHash).toBe(false);
    // Empty shadow corpus => no rows and the row-count threshold is unmet.
    expect(log[0].shadowRowCount).toBe(0);
    expect(log[0].meetsMinRows).toBe(false);
  });

  it('is idempotent in shape: each invocation appends exactly one more audit row', () => {
    runChatCoreV2GateCheck(db);
    runChatCoreV2GateCheck(db);
    runChatCoreV2GateCheck(db);

    const log = listChatCoreV2GateCheckLog(db);
    expect(log).toHaveLength(3);
    // gateMet stays false on every check — never a fabricated pass.
    expect(log.every((row) => row.gateCanPromote === false)).toBe(true);
  });

  it('ensures its own gate tables on a fresh db (no migration run) — no throw', () => {
    // chat_v2_gate_metrics / chat_v2_gate_check_log do not exist yet on this
    // fresh in-memory db; recordChatCoreV2GateCheck creates them idempotently.
    expect(() => runChatCoreV2GateCheck(db)).not.toThrow();
    const log = listChatCoreV2GateCheckLog(db);
    expect(log).toHaveLength(1);
  });
});

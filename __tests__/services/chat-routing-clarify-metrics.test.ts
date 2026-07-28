// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureChatRoutingClarifyMetricsTable,
  readChatRoutingClarifyBudget,
  recordChatRoutingClarifyDecisionPersisted,
} from '../../src/services/chat-routing-clarify-metrics';

describe('chat routing clarify durable metrics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('persists aggregate-only daily counters and reads a bounded UTC window', () => {
    ensureChatRoutingClarifyMetricsTable(db);
    recordChatRoutingClarifyDecisionPersisted(db, true, new Date('2026-07-20T01:00:00.000Z'));
    recordChatRoutingClarifyDecisionPersisted(db, false, new Date('2026-07-20T23:00:00.000Z'));
    recordChatRoutingClarifyDecisionPersisted(db, true, new Date('2026-07-19T23:00:00.000Z'));
    recordChatRoutingClarifyDecisionPersisted(db, true, new Date('2026-06-01T00:00:00.000Z'));

    expect(readChatRoutingClarifyBudget(db, {
      now: new Date('2026-07-20T23:30:00.000Z'),
      windowDays: 2,
    })).toEqual({
      windowDays: 2,
      evaluatedTurns: 3,
      clarifiedTurns: 2,
      rate: 0.6667,
      budgetLimit: 0.1,
      withinBudget: false,
    });

    const rows = db.prepare(`
      SELECT metric_date, evaluated_turns, clarified_turns
      FROM chat_routing_clarify_metrics_daily
      ORDER BY metric_date ASC
    `).all();
    expect(rows).toEqual([
      { metric_date: '2026-06-01', evaluated_turns: 1, clarified_turns: 1 },
      { metric_date: '2026-07-19', evaluated_turns: 1, clarified_turns: 1 },
      { metric_date: '2026-07-20', evaluated_turns: 2, clarified_turns: 1 },
    ]);
  });

  it('returns an explicit no-evidence state instead of a vacuous pass', () => {
    expect(readChatRoutingClarifyBudget(db, {
      now: new Date('2026-07-20T23:30:00.000Z'),
      windowDays: 30,
    })).toEqual({
      windowDays: 30,
      evaluatedTurns: 0,
      clarifiedTurns: 0,
      rate: null,
      budgetLimit: 0.1,
      withinBudget: null,
    });
  });
});

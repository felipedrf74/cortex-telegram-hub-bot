/**
 * Portal Domain Status Tests
 *
 * Tests that the domain handler status section returns correct data
 * for all three domains: secretary, triathlon, content.
 * Verifies message counts, integration status, and agent mesh info.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes(' 2'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

describe('Portal Domain Status', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('domainMessagesToday query', () => {
    it('returns zero counts when no messages exist', () => {
      const rows = db.prepare(`
        SELECT domain, COUNT(*) as count
        FROM conversations WHERE created_at >= date('now')
        GROUP BY domain
      `).all() as { domain: string; count: number }[];

      expect(rows).toHaveLength(0);
    });

    it('counts messages per domain for today', () => {
      const insert = db.prepare(
        'INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)'
      );
      insert.run('secretary', 'user', 'Hello secretary');
      insert.run('secretary', 'assistant', 'Hi there');
      insert.run('secretary', 'user', 'Schedule meeting');
      insert.run('triathlon', 'user', 'Training plan');
      insert.run('content', 'user', 'Video ideas');
      insert.run('content', 'assistant', 'Here are ideas');

      const rows = db.prepare(`
        SELECT domain, COUNT(*) as count
        FROM conversations WHERE created_at >= date('now')
        GROUP BY domain
      `).all() as { domain: string; count: number }[];

      const map: Record<string, number> = {};
      for (const r of rows) map[r.domain] = r.count;

      expect(map['secretary']).toBe(3);
      expect(map['triathlon']).toBe(1);
      expect(map['content']).toBe(2);
    });

    it('does not count messages from previous days', () => {
      const insert = db.prepare(
        "INSERT INTO conversations (domain, role, content, created_at) VALUES (?, ?, ?, datetime('now', ?))"
      );
      insert.run('secretary', 'user', 'Old message', '-2 days');
      insert.run('secretary', 'user', 'Today message', '0 seconds');

      const rows = db.prepare(`
        SELECT domain, COUNT(*) as count
        FROM conversations WHERE created_at >= date('now')
        GROUP BY domain
      `).all() as { domain: string; count: number }[];

      expect(rows).toHaveLength(1);
      expect((rows[0] as any).count).toBe(1);
    });
  });

  describe('domainMessagesTotal query', () => {
    it('returns total message counts and last message timestamp', () => {
      const insert = db.prepare(
        'INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)'
      );
      insert.run('secretary', 'user', 'Msg 1');
      insert.run('secretary', 'user', 'Msg 2');
      insert.run('triathlon', 'user', 'Msg 1');

      const rows = db.prepare(`
        SELECT domain, COUNT(*) as count, MAX(created_at) as last_at
        FROM conversations
        GROUP BY domain
      `).all() as { domain: string; count: number; last_at: string | null }[];

      const map: Record<string, { count: number; lastAt: string | null }> = {};
      for (const r of rows) map[r.domain] = { count: r.count, lastAt: r.last_at };

      expect(map['secretary'].count).toBe(2);
      expect(map['secretary'].lastAt).toBeTruthy();
      expect(map['triathlon'].count).toBe(1);
      expect(map['content']).toBeUndefined();
    });
  });

  describe('domain status structure', () => {
    it('builds correct domain status objects for all three domains', () => {
      const insert = db.prepare(
        'INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)'
      );
      insert.run('secretary', 'user', 'Hello');
      insert.run('content', 'user', 'Ideas');

      const todayRows = db.prepare(`
        SELECT domain, COUNT(*) as count
        FROM conversations WHERE created_at >= date('now')
        GROUP BY domain
      `).all() as { domain: string; count: number }[];

      const totalRows = db.prepare(`
        SELECT domain, COUNT(*) as count, MAX(created_at) as last_at
        FROM conversations
        GROUP BY domain
      `).all() as { domain: string; count: number; last_at: string | null }[];

      const todayMap: Record<string, number> = {};
      for (const r of todayRows) todayMap[r.domain] = r.count;

      const totalMap: Record<string, { count: number; lastAt: string | null }> = {};
      for (const r of totalRows) totalMap[r.domain] = { count: r.count, lastAt: r.last_at };

      // Build domain status the same way the server does
      const domainStatus = [
        {
          domain: 'secretary',
          label: 'Secretary',
          active: true,
          messagesToday: todayMap['secretary'] || 0,
          totalMessages: totalMap['secretary']?.count || 0,
          lastMessageAt: totalMap['secretary']?.lastAt || null,
          details: { graphConnected: false, garminConnected: false },
        },
        {
          domain: 'triathlon',
          label: 'Triathlon',
          active: true,
          messagesToday: todayMap['triathlon'] || 0,
          totalMessages: totalMap['triathlon']?.count || 0,
          lastMessageAt: totalMap['triathlon']?.lastAt || null,
          details: { garminConnected: false },
        },
        {
          domain: 'content',
          label: 'Content Creator',
          active: true,
          messagesToday: todayMap['content'] || 0,
          totalMessages: totalMap['content']?.count || 0,
          lastMessageAt: totalMap['content']?.lastAt || null,
          details: { activeAgents: 0, activeSignals: 0 },
        },
      ];

      expect(domainStatus).toHaveLength(3);

      // Secretary
      expect(domainStatus[0].domain).toBe('secretary');
      expect(domainStatus[0].messagesToday).toBe(1);
      expect(domainStatus[0].totalMessages).toBe(1);
      expect(domainStatus[0].lastMessageAt).toBeTruthy();
      expect(domainStatus[0].active).toBe(true);

      // Triathlon — no messages
      expect(domainStatus[1].domain).toBe('triathlon');
      expect(domainStatus[1].messagesToday).toBe(0);
      expect(domainStatus[1].totalMessages).toBe(0);
      expect(domainStatus[1].lastMessageAt).toBeNull();

      // Content
      expect(domainStatus[2].domain).toBe('content');
      expect(domainStatus[2].messagesToday).toBe(1);
      expect(domainStatus[2].label).toBe('Content Creator');
      expect(domainStatus[2].details).toHaveProperty('activeAgents');
      expect(domainStatus[2].details).toHaveProperty('activeSignals');
    });
  });

  describe('agent mesh integration for content domain', () => {
    it('queries agent run stats from agent_runs table', () => {
      // Insert some agent run records
      const insert = db.prepare(
        'INSERT INTO agent_runs (agent_name, status, signals_produced, signals_consumed, duration_ms) VALUES (?, ?, ?, ?, ?)'
      );
      insert.run('performance-agent', 'success', 3, 0, 5000);
      insert.run('seo-agent', 'success', 2, 0, 3000);
      insert.run('pipeline-agent', 'error', 0, 0, 1000);

      // Query like getAgentStats does
      const stats = db.prepare(`
        SELECT agent_name as agent,
               MAX(created_at) as last_run,
               (SELECT status FROM agent_runs ar2 WHERE ar2.agent_name = ar1.agent_name ORDER BY created_at DESC LIMIT 1) as last_status,
               SUM(signals_produced) as signals_produced,
               COUNT(*) as total_runs
        FROM agent_runs ar1
        GROUP BY agent_name
      `).all() as any[];

      const activeCount = stats.filter(a => a.last_status === 'success').length;
      expect(activeCount).toBe(2);
      expect(stats).toHaveLength(3);
    });

    it('queries active signal count from agent_signals table', () => {
      const insert = db.prepare(
        "INSERT INTO agent_signals (source_agent, signal_type, payload, priority, status, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))"
      );
      insert.run('seo-agent', 'keyword_opportunity', '{"keyword":"test"}', 'normal', 'active');
      insert.run('seo-agent', 'keyword_rank_change', '{"keyword":"rank"}', 'normal', 'active');
      insert.run('performance-agent', 'hook_effectiveness', '{"hook":"test"}', 'normal', 'consumed');

      const result = db.prepare(
        "SELECT COUNT(*) as c FROM agent_signals WHERE status = 'active'"
      ).get() as { c: number };

      expect(result.c).toBe(2);
    });
  });
});

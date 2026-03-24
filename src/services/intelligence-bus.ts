/**
 * Intelligence Bus — shared signal system for the Content Agent Mesh.
 *
 * This module has zero project imports (same pattern as telemetry.ts)
 * to avoid circular dependencies. Uses setDbProvider() callback
 * initialized from src/index.ts after database is ready.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type SignalPriority = 'urgent' | 'normal' | 'background';
export type SignalStatus = 'active' | 'consumed' | 'dismissed' | 'expired';

export type SignalType =
  | 'hook_effectiveness'
  | 'pillar_performance'
  | 'retention_pattern'
  | 'voice_pattern'
  | 'voice_phrase_trend'
  | 'channel_dna'
  | 'book_knowledge'
  | 'book_reference_effective'
  | 'trending_spike'
  | 'competitor_upload'
  | 'keyword_rank_change'
  | 'keyword_opportunity'
  | 'pipeline_bottleneck'
  | 'pipeline_capacity'
  | 'content_sprint_mode'
  | 'reaction_opportunity'
  | 'content_published';

export interface AgentSignal {
  id: number;
  source_agent: string;
  signal_type: SignalType;
  payload: Record<string, any>;
  priority: SignalPriority;
  consumed_by: string[];
  status: SignalStatus;
  created_at: string;
  expires_at: string;
}

export interface AgentRunRecord {
  id: number;
  agent_name: string;
  status: string;
  signals_produced: number;
  signals_consumed: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

// ─── Signal Expiry Defaults (hours) ─────────────────────────────────

const EXPIRY_HOURS: Record<SignalType, number> = {
  trending_spike: 24,
  competitor_upload: 48,
  hook_effectiveness: 60 * 24,      // 60 days
  pillar_performance: 60 * 24,
  retention_pattern: 60 * 24,
  voice_pattern: 90 * 24,           // 90 days
  voice_phrase_trend: 90 * 24,
  channel_dna: 30 * 24,             // 30 days
  book_knowledge: 365 * 24 * 10,    // effectively never
  book_reference_effective: 60 * 24,
  keyword_rank_change: 14 * 24,     // 14 days
  keyword_opportunity: 14 * 24,
  pipeline_bottleneck: 7 * 24,      // 7 days
  pipeline_capacity: 7 * 24,
  content_sprint_mode: 7 * 24,      // default, can be overridden
  reaction_opportunity: 48,          // 48 hours — reactions lose value fast
  content_published: 30 * 24,        // 30 days — for performance tracking
};

// ─── Database Provider (lazy, avoids circular imports) ───────────────

interface DbLike {
  prepare(sql: string): {
    run(...args: any[]): any;
    get(...args: any[]): any;
    all(...args: any[]): any[];
  };
}

type DbProvider = () => DbLike;
let _getDb: DbProvider | null = null;

export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
}

function db(): DbLike | null {
  if (!_getDb) return null;
  try { return _getDb(); } catch { return null; }
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Write a new signal to the bus.
 * Returns the signal ID, or -1 on failure.
 */
export function writeSignal(signal: {
  source_agent: string;
  signal_type: SignalType;
  payload: Record<string, any>;
  priority?: SignalPriority;
  expires_at?: string;
}): number {
  const d = db();
  if (!d) return -1;
  try {
    const priority = signal.priority || 'normal';
    const expiryHours = EXPIRY_HOURS[signal.signal_type] || 7 * 24;
    const expires_at = signal.expires_at ||
      new Date(Date.now() + expiryHours * 3600_000).toISOString();

    const result = d.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      signal.source_agent,
      signal.signal_type,
      JSON.stringify(signal.payload),
      priority,
      expires_at,
    );
    return (result as any).lastInsertRowid ?? -1;
  } catch {
    return -1;
  }
}

/**
 * Read active signals of the given types that haven't been consumed by this consumer.
 */
export function readSignals(
  consumer: string,
  signalTypes: SignalType[],
  limit = 50,
): AgentSignal[] {
  const d = db();
  if (!d) return [];
  try {
    const placeholders = signalTypes.map(() => '?').join(',');
    const rows = d.prepare(`
      SELECT * FROM agent_signals
      WHERE status = 'active'
        AND signal_type IN (${placeholders})
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT ?
    `).all(...signalTypes, limit) as any[];

    return rows
      .map(parseSignalRow)
      .filter(s => !s.consumed_by.includes(consumer));
  } catch {
    return [];
  }
}

/**
 * Mark a signal as consumed by a specific consumer.
 * The signal stays active — other consumers can still read it.
 */
export function markConsumed(signalId: number, consumer: string): void {
  const d = db();
  if (!d) return;
  try {
    const row = d.prepare('SELECT consumed_by FROM agent_signals WHERE id = ?').get(signalId) as any;
    if (!row) return;
    const consumed: string[] = JSON.parse(row.consumed_by || '[]');
    if (!consumed.includes(consumer)) consumed.push(consumer);
    d.prepare('UPDATE agent_signals SET consumed_by = ? WHERE id = ?')
      .run(JSON.stringify(consumed), signalId);
  } catch { /* non-critical */ }
}

/**
 * Dismiss a signal (manual override from Mission Control).
 */
export function dismissSignal(signalId: number): void {
  const d = db();
  if (!d) return;
  try {
    d.prepare("UPDATE agent_signals SET status = 'dismissed' WHERE id = ?").run(signalId);
  } catch { /* non-critical */ }
}

/**
 * Expire stale signals. Run on startup and hourly.
 * Returns count of expired signals.
 */
export function expireStaleSignals(): number {
  const d = db();
  if (!d) return 0;
  try {
    const result = d.prepare(`
      UPDATE agent_signals
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at < datetime('now')
    `).run();
    return (result as any).changes ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get count of active signals.
 */
export function getActiveSignalCount(): number {
  const d = db();
  if (!d) return 0;
  try {
    const row = d.prepare("SELECT COUNT(*) as cnt FROM agent_signals WHERE status = 'active'").get() as any;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get recent signal log (for Mission Control).
 */
export function getSignalLog(limit = 100): AgentSignal[] {
  const d = db();
  if (!d) return [];
  try {
    const rows = d.prepare(`
      SELECT * FROM agent_signals
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(parseSignalRow);
  } catch {
    return [];
  }
}

/**
 * Get agent stats (last run, signal counts, status).
 */
export function getAgentStats(): {
  agent: string;
  last_run: string | null;
  last_status: string;
  signals_produced: number;
  total_runs: number;
}[] {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT
        agent_name as agent,
        MAX(created_at) as last_run,
        (SELECT status FROM agent_runs r2 WHERE r2.agent_name = r1.agent_name ORDER BY created_at DESC LIMIT 1) as last_status,
        SUM(signals_produced) as signals_produced,
        COUNT(*) as total_runs
      FROM agent_runs r1
      GROUP BY agent_name
      ORDER BY last_run DESC
    `).all() as any[];
  } catch {
    return [];
  }
}

/**
 * Log an agent run to the agent_runs table.
 */
export function logAgentRun(
  agentName: string,
  status: 'success' | 'error' | 'skipped',
  signalsProduced: number,
  signalsConsumed: number,
  durationMs: number,
  errorMessage?: string,
): void {
  const d = db();
  if (!d) return;
  try {
    d.prepare(`
      INSERT INTO agent_runs (agent_name, status, signals_produced, signals_consumed, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agentName, status, signalsProduced, signalsConsumed, durationMs, errorMessage ?? null);
  } catch { /* non-critical */ }
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseSignalRow(row: any): AgentSignal {
  return {
    id: row.id,
    source_agent: row.source_agent,
    signal_type: row.signal_type,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    priority: row.priority,
    consumed_by: typeof row.consumed_by === 'string' ? JSON.parse(row.consumed_by) : row.consumed_by,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

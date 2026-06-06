// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 5 batch 27 (2026-05-15): telemetry-driven adversarial discovery.
//
// Scans `chat_action_telemetry` for refusal-pattern rows and surfaces
// adversarial-candidate clusters that aren't covered by existing registry
// `adversarial` / `prompt_injection` examples. Output is a structured
// report Felipe can review to decide whether each cluster needs:
//
//   • A new registry example (to lock the contract)
//   • A new parser rule (to catch a variant the current detector misses)
//   • An incident report (if the cluster represents an active attack)
//
// The scanner is read-only. No mutations to the registry or to telemetry.

import Database from 'better-sqlite3';

const REFUSAL_FAILURE_REASONS = new Set([
  'prompt_injection_marker_detected',
  'embedded_llm_instruction_markers',
  'embedded_llm_instruction_markers_pt',
  'unsafe_title_destructive_vocabulary',
  'rejected_prompt_injection',
  'authorization_failure',
]);

const REFUSAL_OUTCOMES = new Set([
  'refused',
  'rejected',
  'denied',
  'safety_block',
  'unauthorized',
]);

export interface AdversarialCandidateCluster {
  skill: string | null;
  action: string | null;
  failureReason: string | null;
  outcome: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Optional: distinct conversation count, to distinguish many-turns-one-user from many-users-many-conversations. */
  conversationCount: number;
}

export interface AdversarialDiscoveryOptions {
  since?: string;
  tenantId?: number;
  /** Minimum cluster size to surface. Default: 3. */
  minCount?: number;
}

interface RawRow {
  skill: string | null;
  action: string | null;
  failure_reason: string | null;
  outcome: string | null;
  conversation_id: string;
  created_at: string;
}

/**
 * Scans telemetry for adversarial-candidate clusters. A row is a candidate
 * when its failure_reason matches a known refusal pattern OR its outcome
 * matches a refusal label. Rows are grouped by (skill, action,
 * failureReason, outcome) and returned in descending count order.
 */
export function discoverAdversarialCandidates(
  db: Database.Database,
  options: AdversarialDiscoveryOptions = {},
): AdversarialCandidateCluster[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  if (options.tenantId != null) {
    where.push('tenant_id = ?');
    params.push(options.tenantId);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT skill, action, failure_reason, outcome, conversation_id, created_at
    FROM chat_action_telemetry
    ${whereClause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as RawRow[];

  // Filter to refusal-pattern rows.
  const refusalRows = rows.filter((row) => isRefusalRow(row));

  // Group by (skill, action, failureReason, outcome).
  const buckets = new Map<string, AdversarialCandidateCluster & { conversations: Set<string> }>();
  for (const row of refusalRows) {
    const key = `${row.skill ?? '<null>'}|${row.action ?? '<null>'}|${row.failure_reason ?? '<null>'}|${row.outcome ?? '<null>'}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        skill: row.skill,
        action: row.action,
        failureReason: row.failure_reason,
        outcome: row.outcome,
        count: 0,
        firstSeen: row.created_at,
        lastSeen: row.created_at,
        conversationCount: 0,
        conversations: new Set<string>(),
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.conversations.add(row.conversation_id);
    if (row.created_at < bucket.firstSeen) bucket.firstSeen = row.created_at;
    if (row.created_at > bucket.lastSeen) bucket.lastSeen = row.created_at;
  }

  const minCount = options.minCount ?? 3;
  const clusters: AdversarialCandidateCluster[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < minCount) continue;
    clusters.push({
      skill: bucket.skill,
      action: bucket.action,
      failureReason: bucket.failureReason,
      outcome: bucket.outcome,
      count: bucket.count,
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      conversationCount: bucket.conversations.size,
    });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

function isRefusalRow(row: RawRow): boolean {
  if (row.failure_reason && REFUSAL_FAILURE_REASONS.has(row.failure_reason)) return true;
  if (row.outcome && REFUSAL_OUTCOMES.has(row.outcome)) return true;
  return false;
}

/**
 * Formats adversarial clusters as markdown. Surfaces:
 *   • Cluster-by-cluster table (count, first/last seen, conversations)
 *   • Single-source vs distributed-attack classification (1 conversation
 *     dominating vs many distinct conversations) — helps distinguish a
 *     repeat-offender user from a coordinated attack
 *   • Recommended next-step (new registry example / new parser rule /
 *     incident report) based on cluster shape
 */
export function formatAdversarialDiscoveryMarkdown(
  clusters: AdversarialCandidateCluster[],
  options: AdversarialDiscoveryOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`# Chat Action Telemetry — Adversarial Discovery Report`);
  lines.push(``);
  lines.push(`_Generated ${new Date().toISOString()}_`);
  if (options.since) lines.push(`_Since: ${options.since}_`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`- Clusters surfaced: **${clusters.length}**`);
  const totalRows = clusters.reduce((s, c) => s + c.count, 0);
  lines.push(`- Total refusal rows in clusters: **${totalRows}**`);
  lines.push(``);
  if (clusters.length === 0) {
    lines.push(`_No adversarial clusters above the threshold._`);
    return lines.join('\n');
  }
  lines.push(`## Clusters`);
  lines.push(``);
  lines.push(`| Skill | Action | Failure Reason | Outcome | Count | Convs | First Seen | Last Seen | Shape |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const cluster of clusters) {
    const shape = classifyClusterShape(cluster);
    lines.push(
      `| ${cluster.skill ?? '?'} | ${cluster.action ?? '?'} | ${cluster.failureReason ?? '?'} | ${cluster.outcome ?? '?'} | ${cluster.count} | ${cluster.conversationCount} | ${cluster.firstSeen} | ${cluster.lastSeen} | ${shape} |`,
    );
  }
  lines.push(``);
  lines.push(`## Recommended next steps`);
  lines.push(``);
  for (const cluster of clusters) {
    const recommendation = recommendForCluster(cluster);
    lines.push(`- **${cluster.skill}.${cluster.action}** (${cluster.failureReason}): ${recommendation}`);
  }
  return lines.join('\n');
}

function classifyClusterShape(cluster: AdversarialCandidateCluster): string {
  if (cluster.conversationCount === 1) return 'single_user_repeat';
  if (cluster.conversationCount >= 5 && cluster.count / cluster.conversationCount < 2) {
    return 'distributed_attack';
  }
  return 'mixed';
}

function recommendForCluster(cluster: AdversarialCandidateCluster): string {
  const shape = classifyClusterShape(cluster);
  if (shape === 'distributed_attack') {
    return 'Investigate as potential coordinated attack — review tenant/user list and incident timeline.';
  }
  if (shape === 'single_user_repeat') {
    return 'Single user repeatedly hitting the refusal — likely benign retry pattern. Consider adding a registry example documenting the user phrasing variant.';
  }
  return 'Mixed pattern — review individual conversations to decide between new registry example or new parser rule.';
}

// Phase 6 batch 33 (2026-05-15): cross-tenant adversarial baseline.
//
// Detects refusal-pattern clusters spanning multiple tenants in a short
// time window — likely a coordinated platform-level attack. Distinct from
// the single-tenant adversarial discovery in that the grouping key OMITS
// tenant_id; what we surface is "pattern X appeared across N tenants".
//
// Severity classification:
//   • critical: ≥5 distinct tenants in < 24h
//   • high: ≥3 distinct tenants in < 7d
//   • medium: ≥2 distinct tenants
//   • info: 1 tenant (returned only for completeness; usually filtered out)

export type CrossTenantSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface CrossTenantAdversarialPattern {
  skill: string | null;
  action: string | null;
  failureReason: string | null;
  outcome: string | null;
  totalCount: number;
  tenantCount: number;
  firstSeen: string;
  lastSeen: string;
  windowDays: number;
  perTenantCounts: Record<string, number>;
  severity: CrossTenantSeverity;
}

export interface CrossTenantDiscoveryOptions {
  since?: string;
  /** Minimum distinct-tenant count to surface. Default: 2. */
  minTenantCount?: number;
}

interface RawTenantRow {
  tenant_id: number;
  skill: string | null;
  action: string | null;
  failure_reason: string | null;
  outcome: string | null;
  conversation_id: string;
  created_at: string;
}

/**
 * Groups telemetry refusal-pattern rows ACROSS tenants and surfaces patterns
 * that hit multiple distinct tenants. Severity classification flags
 * critical / high cases for incident response.
 */
export function discoverCrossTenantAdversarialPatterns(
  db: Database.Database,
  options: CrossTenantDiscoveryOptions = {},
): CrossTenantAdversarialPattern[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT tenant_id, skill, action, failure_reason, outcome, conversation_id, created_at
    FROM chat_action_telemetry
    ${whereClause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as RawTenantRow[];
  const refusalRows = rows.filter((row) => isRefusalRowMulti(row));

  // Group by (skill, action, failureReason, outcome) — tenant_id excluded.
  const buckets = new Map<string, {
    skill: string | null;
    action: string | null;
    failureReason: string | null;
    outcome: string | null;
    rows: RawTenantRow[];
    tenants: Set<string>;
  }>();
  for (const row of refusalRows) {
    const key = `${row.skill ?? '<null>'}|${row.action ?? '<null>'}|${row.failure_reason ?? '<null>'}|${row.outcome ?? '<null>'}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        skill: row.skill,
        action: row.action,
        failureReason: row.failure_reason,
        outcome: row.outcome,
        rows: [],
        tenants: new Set<string>(),
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
    bucket.tenants.add(String(row.tenant_id));
  }

  const minTenantCount = options.minTenantCount ?? 2;
  const patterns: CrossTenantAdversarialPattern[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.tenants.size < minTenantCount) continue;
    const perTenant: Record<string, number> = {};
    for (const row of bucket.rows) {
      const t = String(row.tenant_id);
      perTenant[t] = (perTenant[t] ?? 0) + 1;
    }
    const firstSeen = bucket.rows[0].created_at;
    const lastSeen = bucket.rows[bucket.rows.length - 1].created_at;
    const windowDays = (new Date(lastSeen).getTime() - new Date(firstSeen).getTime()) / 86400000;
    const severity = classifyCrossTenantSeverity(bucket.tenants.size, windowDays);
    patterns.push({
      skill: bucket.skill,
      action: bucket.action,
      failureReason: bucket.failureReason,
      outcome: bucket.outcome,
      totalCount: bucket.rows.length,
      tenantCount: bucket.tenants.size,
      firstSeen,
      lastSeen,
      windowDays,
      perTenantCounts: perTenant,
      severity,
    });
  }
  patterns.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return patterns;
}

function isRefusalRowMulti(row: RawTenantRow): boolean {
  if (row.failure_reason && REFUSAL_FAILURE_REASONS.has(row.failure_reason)) return true;
  if (row.outcome && REFUSAL_OUTCOMES.has(row.outcome)) return true;
  return false;
}

function classifyCrossTenantSeverity(tenantCount: number, windowDays: number): CrossTenantSeverity {
  if (tenantCount >= 5 && windowDays < 1) return 'critical';
  if (tenantCount >= 3 && windowDays < 7) return 'high';
  if (tenantCount >= 2) return 'medium';
  return 'info';
}

function severityRank(severity: CrossTenantSeverity): number {
  switch (severity) {
    case 'critical': return 3;
    case 'high': return 2;
    case 'medium': return 1;
    case 'info': return 0;
  }
}

// Phase 9 batch 45 (2026-05-16): low-and-slow + targeted-tenant attack
// patterns. Extends cross-tenant detection with two new shapes:
//
//   • low_and_slow: small per-tenant volume but distributed across many
//     tenants over an extended time window (> 7 days). The Phase 6
//     classifier wouldn't flag this because severity is high/medium based
//     on short window. Low-and-slow is a separate signal class.
//   • targeted_tenant_repeat: single tenant generates many refusal rows
//     across distinct conversations within a short window. Within-tenant
//     attack volume, not cross-tenant.

export type AttackPatternType =
  | 'cross_tenant_critical'
  | 'cross_tenant_high'
  | 'cross_tenant_medium'
  | 'low_and_slow'
  | 'targeted_tenant_repeat'
  // Phase 10 batch 53 (2026-05-16): two more types.
  | 'credential_stuffing_probe'  // single tenant, many distinct actions
  | 'time_of_day_cluster';        // refusals spike outside normal hours

export interface LowAndSlowAttackPattern {
  skill: string | null;
  action: string | null;
  failureReason: string | null;
  outcome: string | null;
  totalCount: number;
  tenantCount: number;
  firstSeen: string;
  lastSeen: string;
  windowDays: number;
  perTenantCounts: Record<string, number>;
  /** Mean rows per tenant — low-and-slow patterns have low values. */
  meanRowsPerTenant: number;
}

export interface TargetedTenantAttackPattern {
  tenantId: string;
  skill: string | null;
  action: string | null;
  failureReason: string | null;
  outcome: string | null;
  totalCount: number;
  conversationCount: number;
  firstSeen: string;
  lastSeen: string;
  windowDays: number;
}

export interface LowAndSlowOptions {
  since?: string;
  /** Minimum window in days. Default: 7. */
  minWindowDays?: number;
  /** Minimum distinct tenants. Default: 3. */
  minTenantCount?: number;
  /** Maximum mean rows-per-tenant to count as low-and-slow. Default: 3. */
  maxMeanRowsPerTenant?: number;
}

export interface TargetedTenantOptions {
  since?: string;
  /** Minimum distinct conversations per tenant. Default: 3. */
  minConversationCount?: number;
  /** Maximum window in days for targeted attacks. Default: 7. */
  maxWindowDays?: number;
}

/**
 * Detects low-and-slow distributed campaigns: small per-tenant volume
 * but distributed across many tenants over an extended time window.
 * Distinct from cross_tenant_critical/high (short windows, intense
 * volume) and targeted_tenant_repeat (single tenant focus).
 */
export function discoverLowAndSlowAttacks(
  db: Database.Database,
  options: LowAndSlowOptions = {},
): LowAndSlowAttackPattern[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT tenant_id, skill, action, failure_reason, outcome, conversation_id, created_at
    FROM chat_action_telemetry
    ${whereClause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as RawTenantRow[];
  const refusalRows = rows.filter((row) => isRefusalRowMulti(row));

  // Group by (skill, action, failureReason, outcome).
  const buckets = new Map<string, {
    skill: string | null;
    action: string | null;
    failureReason: string | null;
    outcome: string | null;
    rows: RawTenantRow[];
    tenants: Set<string>;
  }>();
  for (const row of refusalRows) {
    const key = `${row.skill ?? '<null>'}|${row.action ?? '<null>'}|${row.failure_reason ?? '<null>'}|${row.outcome ?? '<null>'}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        skill: row.skill,
        action: row.action,
        failureReason: row.failure_reason,
        outcome: row.outcome,
        rows: [],
        tenants: new Set<string>(),
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
    bucket.tenants.add(String(row.tenant_id));
  }

  const minWindowDays = options.minWindowDays ?? 7;
  const minTenantCount = options.minTenantCount ?? 3;
  const maxMeanRowsPerTenant = options.maxMeanRowsPerTenant ?? 3;
  const patterns: LowAndSlowAttackPattern[] = [];
  for (const bucket of buckets.values()) {
    const tenantCount = bucket.tenants.size;
    if (tenantCount < minTenantCount) continue;
    const firstSeen = bucket.rows[0].created_at;
    const lastSeen = bucket.rows[bucket.rows.length - 1].created_at;
    const windowDays =
      (new Date(lastSeen).getTime() - new Date(firstSeen).getTime()) / 86400000;
    if (windowDays < minWindowDays) continue;
    const meanRowsPerTenant = bucket.rows.length / tenantCount;
    if (meanRowsPerTenant > maxMeanRowsPerTenant) continue;
    const perTenant: Record<string, number> = {};
    for (const row of bucket.rows) {
      const t = String(row.tenant_id);
      perTenant[t] = (perTenant[t] ?? 0) + 1;
    }
    patterns.push({
      skill: bucket.skill,
      action: bucket.action,
      failureReason: bucket.failureReason,
      outcome: bucket.outcome,
      totalCount: bucket.rows.length,
      tenantCount,
      firstSeen,
      lastSeen,
      windowDays,
      perTenantCounts: perTenant,
      meanRowsPerTenant,
    });
  }
  patterns.sort((a, b) => b.windowDays - a.windowDays);
  return patterns;
}

/**
 * Detects targeted-tenant repeat attacks: single tenant generates many
 * refusal rows across distinct conversations within a short window.
 * Useful to identify a tenant being actively exploited.
 */
export function discoverTargetedTenantRepeats(
  db: Database.Database,
  options: TargetedTenantOptions = {},
): TargetedTenantAttackPattern[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT tenant_id, skill, action, failure_reason, outcome, conversation_id, created_at
    FROM chat_action_telemetry
    ${whereClause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as RawTenantRow[];
  const refusalRows = rows.filter((row) => isRefusalRowMulti(row));

  // Group by (tenant, skill, action, failureReason, outcome).
  const buckets = new Map<string, {
    tenantId: string;
    skill: string | null;
    action: string | null;
    failureReason: string | null;
    outcome: string | null;
    rows: RawTenantRow[];
    conversations: Set<string>;
  }>();
  for (const row of refusalRows) {
    const key = `${row.tenant_id}|${row.skill ?? '<null>'}|${row.action ?? '<null>'}|${row.failure_reason ?? '<null>'}|${row.outcome ?? '<null>'}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        tenantId: String(row.tenant_id),
        skill: row.skill,
        action: row.action,
        failureReason: row.failure_reason,
        outcome: row.outcome,
        rows: [],
        conversations: new Set<string>(),
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
    bucket.conversations.add(row.conversation_id);
  }

  const minConversationCount = options.minConversationCount ?? 3;
  const maxWindowDays = options.maxWindowDays ?? 7;
  const patterns: TargetedTenantAttackPattern[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.conversations.size < minConversationCount) continue;
    const firstSeen = bucket.rows[0].created_at;
    const lastSeen = bucket.rows[bucket.rows.length - 1].created_at;
    const windowDays =
      (new Date(lastSeen).getTime() - new Date(firstSeen).getTime()) / 86400000;
    if (windowDays > maxWindowDays) continue;
    patterns.push({
      tenantId: bucket.tenantId,
      skill: bucket.skill,
      action: bucket.action,
      failureReason: bucket.failureReason,
      outcome: bucket.outcome,
      totalCount: bucket.rows.length,
      conversationCount: bucket.conversations.size,
      firstSeen,
      lastSeen,
      windowDays,
    });
  }
  patterns.sort((a, b) => b.conversationCount - a.conversationCount);
  return patterns;
}

// Phase 10 batch 53 (2026-05-16): credential-stuffing probe pattern.
//
// Detection signal: a single tenant generates refusal rows across many
// DISTINCT (skill, action) pairs within a short window. Different from
// targeted_tenant_repeat (which repeats the SAME action across many
// conversations) — credential stuffing implies an attacker who just got
// in and is probing the action surface to learn what they can do.
//
// Hard thresholds (overridable via options):
//   • ≥ 5 distinct (skill, action) pairs flagged
//   • Window ≤ 24 hours
//   • The pairs span ≥ 3 different skills (cross-skill spread)
//
// The cross-skill requirement is what separates probes from a tenant
// legitimately exercising multiple features of one skill (a normal user
// might trip mail_unread_count → draft_email → send_email refusals).
export interface CredentialStuffingPattern {
  tenantId: string;
  distinctActionCount: number;
  skillCount: number;
  totalCount: number;
  firstSeen: string;
  lastSeen: string;
  windowHours: number;
  actions: Array<{ skill: string | null; action: string | null; count: number }>;
}

export interface CredentialStuffingOptions {
  since?: string;
  /** Minimum distinct (skill, action) pairs. Default: 5. */
  minDistinctActions?: number;
  /** Minimum distinct skills. Default: 3. */
  minSkillCount?: number;
  /** Maximum window in hours. Default: 24. */
  maxWindowHours?: number;
}

export function discoverCredentialStuffingProbes(
  db: Database.Database,
  options: CredentialStuffingOptions = {},
): CredentialStuffingPattern[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT tenant_id, skill, action, failure_reason, outcome, created_at
    FROM chat_action_telemetry
    ${whereClause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as RawTenantRow[];
  const refusalRows = rows.filter((row) => isRefusalRowMulti(row));

  const minDistinctActions = options.minDistinctActions ?? 5;
  const minSkillCount = options.minSkillCount ?? 3;
  const maxWindowHours = options.maxWindowHours ?? 24;

  // Group by tenant.
  const byTenant = new Map<string, RawTenantRow[]>();
  for (const row of refusalRows) {
    const t = String(row.tenant_id);
    const bucket = byTenant.get(t) ?? [];
    bucket.push(row);
    byTenant.set(t, bucket);
  }

  const patterns: CredentialStuffingPattern[] = [];
  for (const [tenantId, tenantRows] of byTenant.entries()) {
    const firstSeen = tenantRows[0].created_at;
    const lastSeen = tenantRows[tenantRows.length - 1].created_at;
    const windowHours =
      (new Date(lastSeen).getTime() - new Date(firstSeen).getTime()) / 3600000;
    if (windowHours > maxWindowHours) continue;

    const actionCounts = new Map<string, { skill: string | null; action: string | null; count: number }>();
    const skills = new Set<string>();
    for (const row of tenantRows) {
      const key = `${row.skill ?? '<null>'}|${row.action ?? '<null>'}`;
      const existing = actionCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        actionCounts.set(key, { skill: row.skill, action: row.action, count: 1 });
      }
      if (row.skill) skills.add(row.skill);
    }
    if (actionCounts.size < minDistinctActions) continue;
    if (skills.size < minSkillCount) continue;

    patterns.push({
      tenantId,
      distinctActionCount: actionCounts.size,
      skillCount: skills.size,
      totalCount: tenantRows.length,
      firstSeen,
      lastSeen,
      windowHours,
      actions: Array.from(actionCounts.values()).sort((a, b) => b.count - a.count),
    });
  }
  patterns.sort((a, b) => b.distinctActionCount - a.distinctActionCount);
  return patterns;
}

// Phase 10 batch 53 (2026-05-16): time-of-day cluster pattern.
//
// Detection signal: refusals concentrated in narrow hour windows that
// differ from the baseline rate. Bots tend to operate outside normal
// business hours; a refusal spike at 03:00 UTC across days suggests
// scripted activity rather than human users.
//
// Algorithm:
//   1. Bucket refusal rows by UTC hour-of-day (0-23).
//   2. Compute baseline mean rows per hour (totalRefusalRows / 24).
//   3. Flag any hour where count > baselineMultiplier × mean
//      AND the hour-of-day count is itself ≥ minCount.
//
// The `minCount` floor avoids false positives when the dataset is small
// (a single row at 03:00 with an empty 04-12 stretch shouldn't fire
// purely because the mean is 0).
export interface TimeOfDayClusterPattern {
  hourUtc: number;
  count: number;
  baselineMean: number;
  multiplierOverBaseline: number;
  firstSeen: string;
  lastSeen: string;
  topActions: Array<{ skill: string | null; action: string | null; count: number }>;
}

export interface TimeOfDayClusterOptions {
  since?: string;
  /** Minimum row count in the hour to qualify. Default: 5. */
  minCount?: number;
  /** Multiplier vs baseline mean. Default: 3. */
  baselineMultiplier?: number;
}

export function discoverTimeOfDayClusters(
  db: Database.Database,
  options: TimeOfDayClusterOptions = {},
): TimeOfDayClusterPattern[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    where.push('created_at >= ?');
    params.push(options.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT tenant_id, skill, action, failure_reason, outcome, created_at
    FROM chat_action_telemetry
    ${whereClause}
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(...params) as RawTenantRow[];
  const refusalRows = rows.filter((row) => isRefusalRowMulti(row));
  if (refusalRows.length === 0) return [];

  const minCount = options.minCount ?? 5;
  const baselineMultiplier = options.baselineMultiplier ?? 3;
  const baselineMean = refusalRows.length / 24;

  const buckets = new Map<number, RawTenantRow[]>();
  for (const row of refusalRows) {
    const hour = new Date(row.created_at).getUTCHours();
    const bucket = buckets.get(hour) ?? [];
    bucket.push(row);
    buckets.set(hour, bucket);
  }

  const patterns: TimeOfDayClusterPattern[] = [];
  for (const [hour, bucketRows] of buckets.entries()) {
    if (bucketRows.length < minCount) continue;
    if (bucketRows.length <= baselineMultiplier * baselineMean) continue;
    const firstSeen = bucketRows[0].created_at;
    const lastSeen = bucketRows[bucketRows.length - 1].created_at;
    const actionCounts = new Map<string, { skill: string | null; action: string | null; count: number }>();
    for (const row of bucketRows) {
      const key = `${row.skill ?? '<null>'}|${row.action ?? '<null>'}`;
      const existing = actionCounts.get(key);
      if (existing) existing.count += 1;
      else actionCounts.set(key, { skill: row.skill, action: row.action, count: 1 });
    }
    patterns.push({
      hourUtc: hour,
      count: bucketRows.length,
      baselineMean,
      multiplierOverBaseline: bucketRows.length / Math.max(baselineMean, 0.0001),
      firstSeen,
      lastSeen,
      topActions: Array.from(actionCounts.values()).sort((a, b) => b.count - a.count).slice(0, 5),
    });
  }
  patterns.sort((a, b) => b.multiplierOverBaseline - a.multiplierOverBaseline);
  return patterns;
}

/** Markdown formatter for cross-tenant patterns. */
export function formatCrossTenantAdversarialMarkdown(
  patterns: CrossTenantAdversarialPattern[],
): string {
  const lines: string[] = [];
  lines.push(`# Chat Action Telemetry — Cross-Tenant Adversarial Baseline`);
  lines.push(``);
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  const critical = patterns.filter((p) => p.severity === 'critical').length;
  const high = patterns.filter((p) => p.severity === 'high').length;
  const medium = patterns.filter((p) => p.severity === 'medium').length;
  lines.push(`- Patterns surfaced: **${patterns.length}**`);
  lines.push(`- Severity breakdown: **critical: ${critical}**, **high: ${high}**, medium: ${medium}`);
  lines.push(``);
  if (patterns.length === 0) {
    lines.push(`_No cross-tenant adversarial patterns detected._`);
    return lines.join('\n');
  }
  lines.push(`## Patterns`);
  lines.push(``);
  lines.push(`| Severity | Skill | Action | Failure Reason | Tenants | Total | Window | First Seen | Last Seen |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const p of patterns) {
    lines.push(
      `| ${p.severity.toUpperCase()} | ${p.skill ?? '?'} | ${p.action ?? '?'} | ${p.failureReason ?? '?'} | ${p.tenantCount} | ${p.totalCount} | ${p.windowDays.toFixed(2)}d | ${p.firstSeen} | ${p.lastSeen} |`,
    );
  }
  return lines.join('\n');
}

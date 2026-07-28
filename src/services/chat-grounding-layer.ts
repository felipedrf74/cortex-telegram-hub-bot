// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import type { RouteResult } from '../router';
import type { NexusChatOwnerSkill, NexusGroundingFact, NexusChatStaleness } from './chat-answer-contract';
import {
  resolveChatSkillCapability,
  type ChatSkillCapabilityResolution,
} from './chat-skill-capability-registry';
import {
  getAllTasks,
  getTaskByIdForUser,
  getTaskTimestampsById,
} from './task-store/unified-task-store';

export interface ChatGroundingEnvelope {
  capability: ChatSkillCapabilityResolution;
  groundingFacts: NexusGroundingFact[];
  missingFacts: string[];
  staleness: NexusChatStaleness;
}

export function buildChatGroundingEnvelope(input: {
  message: string;
  userId: number;
  tenantId: number;
  route?: Pick<RouteResult, 'domain' | 'method' | 'confidence'>;
  routedDomain?: DomainName;
  activeContextDomain?: DomainName | null;
  involvedSkills?: string[];
  contextSources?: Array<{ source: string; freshness?: string; confidence?: number; reason?: string }>;
}): ChatGroundingEnvelope {
  const capability = resolveChatSkillCapability({
    message: input.message,
    routedDomain: input.routedDomain ?? input.route?.domain,
    involvedSkills: input.involvedSkills,
  });
  const facts: NexusGroundingFact[] = [
    safeFact({
      statement: 'Authenticated user and tenant scope are present for this chat turn.',
      source: 'auth.scope',
      field: 'userId,tenantId',
      freshness: 'fresh',
      confidence: 1,
    }),
    safeFact({
      statement: `${capability.capability.displayName} is the current owner skill for this response.`,
      source: 'chat.skill_capability_registry',
      field: 'ownerSkill',
      freshness: 'fresh',
      confidence: 0.9,
    }),
  ];

  if (input.route) {
    facts.push(safeFact({
      statement: `Router selected ${input.route.domain} with ${input.route.method}.`,
      source: 'chat.router',
      field: 'route',
      freshness: 'fresh',
      confidence: input.route.confidence,
    }));
  }

  if (input.activeContextDomain) {
    facts.push(safeFact({
      statement: `Recent chat context was in ${input.activeContextDomain}.`,
      source: 'chat.active_context',
      field: 'domain',
      freshness: 'recent',
      confidence: 0.65,
    }));
  }

  for (const source of input.contextSources ?? []) {
    facts.push(safeFact({
      statement: source.reason || `Context source ${source.source} was available.`,
      source: `chat.context.${source.source}`,
      field: 'context',
      freshness: normalizeFreshness(source.freshness),
      confidence: source.confidence ?? 0.6,
    }));
  }

  const missingFacts = inferMissingFacts(input.message, capability.ownerSkill, capability.intent, capability.capability.requiredFields);
  const staleness = facts.some((fact) => fact.freshness === 'stale')
    ? 'stale'
    : facts.some((fact) => fact.freshness === 'recent')
      ? 'recent'
      : 'fresh';

  return {
    capability,
    groundingFacts: facts,
    missingFacts,
    staleness,
  };
}

function inferMissingFacts(
  message: string,
  ownerSkill: NexusChatOwnerSkill,
  intent: string,
  requiredFields: string[],
): string[] {
  const text = message.toLowerCase();
  const missing = new Set<string>();
  const mutating = /\.(create|adjust|destructive)$/.test(intent);
  if (!mutating) return [];

  // Calendar/scheduling-owning skills need date/time/title — even when
  // the owner is `tasks` or `training` (which both schedule into the
  // calendar). Codex QA proved the old `secretary`-only branch missed
  // `create a task` because inferSkillFromText returns `tasks` for any
  // sentence containing the word "task".
  const schedulingOwners: NexusChatOwnerSkill[] = ['secretary', 'tasks', 'training'];
  if (schedulingOwners.includes(ownerSkill)) {
    if (!hasDateSignal(text)) missing.add('date');
    if (ownerSkill === 'secretary' && !hasTimeSignal(text)) missing.add('time');
    if (!hasTitleSignal(text)) missing.add('title');
  }

  // Reference-shaped required fields (e.g. `recipeReference`) need an
  // anaphor to resolve. Keep this for every owner so cooking/finance
  // benefit too.
  for (const field of requiredFields) {
    if (field.endsWith('Reference') && !/\b(this|that|current|today|tomorrow|este|esta|isso|hoje|amanh[aã])\b/.test(text)) {
      missing.add(field);
    }
  }

  return [...missing];
}

function hasDateSignal(text: string): boolean {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|[0-3]?\d\/[0-1]?\d|[0-3]?\d-[0-1]?\d)\b/.test(text);
}

function hasTimeSignal(text: string): boolean {
  return /\b([01]?\d|2[0-3])(?::|h)[0-5]\d\b|\b([01]?\d|2[0-3])h\b|\b([01]?\d|2[0-3])\s?(am|pm)\b/i.test(text);
}

function hasTitleSignal(text: string): boolean {
  return /\b(title|called|named|atividade|evento|aula|meeting|reuni[aã]o|treino|consulta|volei|v[oó]lei)\b/.test(text)
    || text.trim().split(/\s+/).length >= 6;
}

function safeFact(input: {
  statement: string;
  source: string;
  field?: string;
  freshness: NexusChatStaleness;
  confidence: number;
}): NexusGroundingFact {
  return {
    statement: input.statement.slice(0, 240),
    source: input.source,
    ...(input.field ? { field: input.field } : {}),
    freshness: input.freshness,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    safeForUser: true,
  };
}

function normalizeFreshness(value: string | undefined): NexusChatStaleness {
  if (value === 'fresh' || value === 'recent' || value === 'stale') return value;
  return 'unknown';
}

// ─── M8: token-zero verification of success claims ─────────────────
//
// When the quality gate detects an `unverified_success_claim`, it first
// attempts a DETERMINISTIC verification read against local SQLite state
// before rewriting the answer. Only id-or-exact-title matches count —
// a name collision (two rows with the same normalized title) is treated
// as ambiguous and falls through to the downgrade path. This is a pure
// local read: no provider calls, no network (zero-cost law).
//
// v1 scope: unified task store entities. Claims about entities we cannot
// deterministically read (calendar events via live providers, external
// publishes/sends, deletions — absence is not proof an action ran) always
// return unverified so the gate's repair path stays authoritative.
//
// Adversarial-review fix (2026-07): verification is TURN-SCOPED. Row
// existence alone cannot prove a claim made on THIS turn — a week-old task
// with the exact title would otherwise "verify" a hallucinated write. The
// matched row's updated_at (created_at for creation claims) must fall
// inside the current request window (requestStartedAt minus a small
// clock-skew allowance). No recency proof → unverified, and the gate's
// surgical-downgrade path stays authoritative.

export interface LocalWriteClaimVerification {
  verified: boolean;
  reason: string;
  entity?: { kind: 'task'; id: number; title: string };
}

/** Clock-skew allowance before requestStartedAt (SQLite second precision + host skew). */
export const WRITE_CLAIM_RECENCY_SKEW_MS = 60_000;

// SQLite datetime('now') emits 'YYYY-MM-DD HH:MM:SS' in UTC with no zone
// suffix; Date.parse would read that as LOCAL time. Normalize to UTC.
function parseSqliteUtcMs(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value)) {
    const direct = Date.parse(value);
    return Number.isFinite(direct) ? direct : null;
  }
  const utc = Date.parse(`${value.replace(' ', 'T')}Z`);
  if (Number.isFinite(utc)) return utc;
  const direct = Date.parse(value);
  return Number.isFinite(direct) ? direct : null;
}

const CLAIM_ENTITY_QUOTE_RES: ReadonlyArray<RegExp> = [
  /"([^"\n]{1,120})"/g,
  /'([^'\n]{1,120})'/g,
  /[“]([^“”\n]{1,120})[”]/g,
  /[‘]([^‘’\n]{1,120})[’]/g,
];

const COMPLETION_CLAIM_RE = /\b(?:completed|marked|done|conclu[ií]|marquei|complet[eé]|finaliz(?:ei|ada|ado))\b/i;
const DELETION_CLAIM_RE = /\b(?:deleted|removed|apaguei|removi|exclu[ií]|elimin[eé]|deletei)\b/i;
// Creation claims are recency-checked against created_at (the row must have
// been INSERTED during this request); all other write claims check
// updated_at (completion/edit rewrites updated_at on this turn).
const CREATION_CLAIM_RE = /\b(?:created|added|criei|adicionei|cadastrei|cre[eé]|agregu[eé]|a[ñn]ad[ií])\b/i;
// NOTE: "task #N" is only trusted as a DB row id. Models frequently emit
// LIST ORDINALS ("task #2" = second item of the last rendered list), which
// are NOT database ids — the recency requirement below is what keeps an
// ordinal that happens to collide with a real row id from verifying a
// hallucinated claim (the collided row was not written on this turn).
const TASK_ID_CLAIM_RE = /\btask\s*#?(\d{1,10})\b/i;

function normalizeEntityTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractClaimEntityTitles(text: string): string[] {
  const titles = new Set<string>();
  for (const re of CLAIM_ENTITY_QUOTE_RES) {
    for (const match of text.matchAll(new RegExp(re.source, re.flags))) {
      const candidate = String(match[1] ?? '').trim();
      // Single-word scare quotes ('scheduled') are claim camouflage, not
      // entity titles — require at least one word character and either a
      // multi-word phrase or a capitalized/complex token.
      if (!candidate || !/\w/.test(candidate)) continue;
      titles.add(candidate);
    }
  }
  return [...titles];
}

export function verifyWriteClaimAgainstLocalState(input: {
  text: string;
  userId: number;
  tenantId: number;
  /**
   * Request start (ms epoch). The matched row's write timestamp must be
   * >= requestStartedAt - WRITE_CLAIM_RECENCY_SKEW_MS. Absent → falls back
   * to verification-time Date.now() (a strictly tighter window).
   */
  requestStartedAt?: number;
}): LocalWriteClaimVerification {
  try {
    if (DELETION_CLAIM_RE.test(input.text)) {
      // Absence of a row cannot prove the deletion ran on this turn.
      return { verified: false, reason: 'deletion_not_verifiable' };
    }
    const requiresCompleted = COMPLETION_CLAIM_RE.test(input.text);
    const isCreationClaim = CREATION_CLAIM_RE.test(input.text);
    const windowStartMs = (typeof input.requestStartedAt === 'number' && Number.isFinite(input.requestStartedAt)
      ? input.requestStartedAt
      : Date.now()) - WRITE_CLAIM_RECENCY_SKEW_MS;
    const wasWrittenThisTurn = (taskId: number | undefined): boolean => {
      if (typeof taskId !== 'number') return false;
      const timestamps = getTaskTimestampsById(input.userId, taskId, input.tenantId);
      if (!timestamps) return false;
      const relevantMs = isCreationClaim
        ? parseSqliteUtcMs(timestamps.createdAt) ?? parseSqliteUtcMs(timestamps.updatedAt)
        : parseSqliteUtcMs(timestamps.updatedAt) ?? parseSqliteUtcMs(timestamps.createdAt);
      return relevantMs !== null && relevantMs >= windowStartMs;
    };

    const idMatch = input.text.match(TASK_ID_CLAIM_RE);
    if (idMatch) {
      const task = getTaskByIdForUser(input.userId, Number(idMatch[1]), input.tenantId);
      if (task
        && (!requiresCompleted || task.status === 'completed')
        && wasWrittenThisTurn(task.id)) {
        return {
          verified: true,
          reason: 'task_id_match',
          entity: { kind: 'task', id: task.id ?? Number(idMatch[1]), title: task.title },
        };
      }
    }

    const titles = extractClaimEntityTitles(input.text);
    if (titles.length === 0 && !idMatch) {
      return { verified: false, reason: 'no_identifiable_entity' };
    }
    if (titles.length > 0) {
      const tasks = getAllTasks(input.userId, undefined, input.tenantId);
      for (const title of titles) {
        const normalized = normalizeEntityTitle(title);
        const matches = tasks.filter((task) => normalizeEntityTitle(task.title) === normalized);
        if (matches.length !== 1) continue; // 0 = no proof; >1 = collision guard
        const task = matches[0]!;
        if (requiresCompleted && task.status !== 'completed') continue;
        if (!wasWrittenThisTurn(task.id)) continue; // stale row — not proof of THIS turn's claim
        return {
          verified: true,
          reason: requiresCompleted ? 'task_exact_title_completed' : 'task_exact_title_match',
          entity: { kind: 'task', id: task.id ?? -1, title: task.title },
        };
      }
    }
    return { verified: false, reason: 'no_confirming_local_state' };
  } catch {
    // Fail safe: a broken read must never keep an unverified claim alive.
    return { verified: false, reason: 'verification_read_failed' };
  }
}

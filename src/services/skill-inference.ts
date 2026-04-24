// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-USR-405b — Auto-inferred skill tags on reference rows.
 *
 * When a user adds a reference (book / link / note / channel), we
 * suggest which skills it likely belongs to by looking at the TAG
 * OVERLAP between the target reference and the tenant's already-
 * skill-tagged references. No embeddings, no LLM calls — just
 * Jaccard similarity over the user's own manually-curated tag
 * vocabulary.
 *
 * The model:
 *   - For each existing ref R in the tenant with at least one
 *     skill:<X> tag, compute Jaccard similarity between R's
 *     non-skill tags and the target's non-skill tags.
 *   - Score for skill X = max Jaccard across all refs carrying
 *     skill:<X>. "Max" (not mean) because the best evidence
 *     dominates; mean would dilute under-tagged skills.
 *   - Rank skills by score DESC, keep top 3 suggestions.
 *   - Supporting refs = top 3 individual refs by per-skill score,
 *     so the UI can explain "we suggested Training because of
 *     these 3 books."
 *
 * Why not embeddings for v1:
 *   - Jaccard over user-curated tags is personalised by
 *     construction. Embeddings on raw text compete with generic
 *     internet co-occurrence noise.
 *   - Zero API cost, instant, deterministic — ideal for a manual
 *     "Suggest" button where users expect sub-100ms feedback.
 *   - Precision is acceptable once the user has ~5 tagged refs
 *     per skill. Below that, we cold-start.
 *
 * Cold-start: if the tenant has ≤ 3 refs with any skill tag at
 * all, return empty suggestions + coldStart:true. The UI surfaces
 * this as "Tag a few references first to unlock suggestions."
 *
 * This is a PURE-FUNCTION module — the scoring has zero side
 * effects and zero I/O. The wrapper `suggestTagsForRef` is the
 * only place we touch the DB, and it does so via the existing
 * listXxx / getXxx helpers in tenant-resource-service +
 * tenant-channel-service.
 */

import { listBooks, listContentNotes, listLinks, getBook, getContentNote, getLink } from './tenant-resource-service';
import { listChannels, getChannel } from './tenant-channel-service';
import type { SkillId } from './tenant-skill-config-service';

// ─── Types ───────────────────────────────────────────────────────────

export type SuggestKind = 'book' | 'link' | 'note' | 'channel';

export interface TaggedRefForScoring {
  kind: SuggestKind;
  id: number;
  tags: string[];
}

export interface SkillCandidate {
  skillId: SkillId;
  /** Max Jaccard similarity across all refs that carry this skill. Range [0, 1]. */
  confidence: number;
  /** Top-3 reference ids (per-kind) that contributed most to the score, for UI explainability. */
  supportingRefs: Array<{ kind: SuggestKind; id: number }>;
}

export interface SuggestionResult {
  suggestions: SkillCandidate[];
  coldStart: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const SKILL_TAG_PREFIX = 'skill:';

/** Ref-count floor below which we don't even try — too little signal. */
export const COLD_START_REF_THRESHOLD = 3;

/** Max suggestions returned from one call — keeps the UI scannable. */
export const MAX_SUGGESTIONS = 3;

/** Max supporting refs per suggestion — enough to explain "why" without cluttering. */
export const MAX_SUPPORTING_REFS = 3;

/** The set of skill ids we'll ever suggest. Stable, validated against SkillId. */
const CANDIDATE_SKILL_IDS: readonly SkillId[] = ['content', 'secretary', 'training', 'finance', 'cooking'];

// ─── Pure helpers ────────────────────────────────────────────────────

/** Pull skill:<X> ids out of a tag array. */
export function extractSkillIds(tags: readonly string[]): string[] {
  return tags
    .filter((t) => typeof t === 'string' && t.startsWith(SKILL_TAG_PREFIX))
    .map((t) => t.slice(SKILL_TAG_PREFIX.length));
}

/** Pull the non-skill tags (user vocabulary) out of a tag array. */
export function extractNonSkillTags(tags: readonly string[]): string[] {
  return tags.filter((t) => typeof t === 'string' && t.length > 0 && !t.startsWith(SKILL_TAG_PREFIX));
}

/** Jaccard similarity over two tag arrays. Defined as |A∩B| / |A∪B|. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Core scoring (pure) ─────────────────────────────────────────────

/**
 * Score each candidate skill against the target. See file-level
 * comment for the model. Returns suggestions sorted by confidence
 * DESC, capped at MAX_SUGGESTIONS. Caller is responsible for
 * filtering out the target's own skill tags if desired.
 *
 * Cold-start is NOT handled here — this function trusts the caller
 * to detect that case and short-circuit. scoreSkillCandidates
 * returns empty when targetNonSkillTags is empty OR when no ref
 * has any overlap > 0.
 */
export function scoreSkillCandidates(
  targetNonSkillTags: readonly string[],
  taggedRefs: readonly TaggedRefForScoring[],
  candidateSkillIds: readonly SkillId[] = CANDIDATE_SKILL_IDS,
): SkillCandidate[] {
  if (targetNonSkillTags.length === 0) return [];
  if (taggedRefs.length === 0) return [];

  const perSkill = new Map<SkillId, { maxScore: number; supporters: Array<{ kind: SuggestKind; id: number; score: number }> }>();

  for (const ref of taggedRefs) {
    const refSkills = extractSkillIds(ref.tags);
    if (refSkills.length === 0) continue; // only ref rows that ANCHOR a skill contribute signal
    const refNonSkill = extractNonSkillTags(ref.tags);
    const score = jaccard(targetNonSkillTags, refNonSkill);
    if (score <= 0) continue;
    for (const skillId of refSkills) {
      if (!candidateSkillIds.includes(skillId as SkillId)) continue;
      const key = skillId as SkillId;
      if (!perSkill.has(key)) perSkill.set(key, { maxScore: 0, supporters: [] });
      const s = perSkill.get(key)!;
      if (score > s.maxScore) s.maxScore = score;
      s.supporters.push({ kind: ref.kind, id: ref.id, score });
    }
  }

  const results: SkillCandidate[] = [];
  for (const [skillId, s] of perSkill.entries()) {
    if (s.maxScore <= 0) continue;
    const supporters = [...s.supporters]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUPPORTING_REFS)
      .map(({ kind, id }) => ({ kind, id }));
    results.push({ skillId, confidence: s.maxScore, supportingRefs: supporters });
  }
  return results.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_SUGGESTIONS);
}

// ─── DB-backed wrapper ───────────────────────────────────────────────

/** Collect every reference in the tenant + its tags, via existing list* helpers. */
function collectAllTenantRefs(tenantId: number): TaggedRefForScoring[] {
  const out: TaggedRefForScoring[] = [];
  for (const b of listBooks(tenantId)) out.push({ kind: 'book', id: b.id, tags: b.tags || [] });
  for (const n of listContentNotes(tenantId)) out.push({ kind: 'note', id: n.id, tags: n.tags || [] });
  for (const l of listLinks(tenantId)) out.push({ kind: 'link', id: l.id, tags: l.tags || [] });
  for (const c of listChannels(tenantId)) out.push({ kind: 'channel', id: c.id, tags: c.tags || [] });
  return out;
}

function getTargetTags(tenantId: number, kind: SuggestKind, id: number): string[] | null {
  switch (kind) {
    case 'book': {
      const r = getBook(tenantId, id);
      return r ? r.tags || [] : null;
    }
    case 'link': {
      const r = getLink(tenantId, id);
      return r ? r.tags || [] : null;
    }
    case 'note': {
      const r = getContentNote(tenantId, id);
      return r ? r.tags || [] : null;
    }
    case 'channel': {
      const r = getChannel(tenantId, id);
      return r ? r.tags || [] : null;
    }
    default:
      return null;
  }
}

/**
 * Top-level entry point. Looks up the target, enumerates all
 * tenant refs, and returns ranked skill suggestions.
 *
 * Throws `ReferenceError` when the target can't be found — the
 * route handler maps this to 404.
 */
export function suggestTagsForRef(tenantId: number, kind: SuggestKind, id: number): SuggestionResult {
  const targetTags = getTargetTags(tenantId, kind, id);
  if (targetTags === null) {
    throw new ReferenceError(`Reference not found: kind=${kind} id=${id}`);
  }

  const allRefs = collectAllTenantRefs(tenantId);
  // Exclude the target from the scoring pool (its own skill tags
  // would otherwise self-credit at max score).
  const otherRefs = allRefs.filter((r) => !(r.kind === kind && r.id === id));

  // Cold-start check: count refs that ACTUALLY have a skill tag.
  // A tenant with 50 untagged books + 2 tagged ones gives us
  // almost no signal, so we still cold-start at that scale.
  const refsWithSkills = otherRefs.filter((r) => extractSkillIds(r.tags).length > 0);
  if (refsWithSkills.length <= COLD_START_REF_THRESHOLD) {
    return { suggestions: [], coldStart: true };
  }

  const targetNonSkillTags = extractNonSkillTags(targetTags);
  const suggestions = scoreSkillCandidates(targetNonSkillTags, otherRefs, CANDIDATE_SKILL_IDS);
  return { suggestions, coldStart: false };
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M15 — manifest-generated full-skill classifier prompt.
 *
 * Generates the paid-classifier system prompt from the CapabilityManifest so
 * every NL-reachable domain (and its chat action skills) is classifiable,
 * instead of the hand-maintained 5-domain prompts/classifier.md.
 *
 * Three pieces:
 *   1. buildManifestClassifierPrompt() — the STATIC portion. Regenerated at
 *      build time into prompts/classifier-manifest.md via
 *      `npm run classifier:prompt`; a CI test asserts the checked-in file is
 *      byte-identical to a fresh regeneration.
 *   2. buildClassifierCandidateShortlist() — the small PER-CALL portion:
 *      resolveIntent's top-k deterministic candidates with matched evidence,
 *      appended to the classify user message at runtime by classifyWithClaude.
 *   3. resolveManifestSkillForDomain() — output validation: the model's
 *      optional `skill` field is kept only when it is a manifest
 *      chatActionSkill of the chosen domain.
 *
 * Rollout flag: AI_CLASSIFY_MANIFEST_PROMPT (default OFF → the legacy
 * prompts/classifier.md path stays byte-identical). The M12 master kill
 * (AI_ROUTING_MANIFEST_KILL) always wins and forces the flag off.
 *
 * NL-reachability decision (documented; enforced in code below):
 * a manifest capability is NL-reachable for the chat classifier when
 *   - lifecycle === 'active', AND
 *   - supportedChannels includes a conversational chat channel
 *     ('ios' or 'rest' — the surfaces that reach POST /message), AND
 *   - requiredTier !== 'owner' (owner/admin-only capabilities are
 *     operational surfaces, not NL chat targets).
 * Excluded entries are reported by getClassifierDomainExclusions() so the
 * exclusion table is inspectable instead of implicit. As of the 2026-07-29.1
 * manifest all 8 capabilities (secretary, triathlon, content, finance,
 * cooking, connections, notifications, decision_center) pass all three
 * criteria — the exclusion table is currently empty.
 */

import {
  loadCapabilityManifest,
  type CapabilityManifestEntry,
} from '../services/capability-manifest';
import {
  resolveIntent,
  type IntentCandidate,
  type IntentResolutionContext,
} from '../services/intent-resolution/intent-resolver';
import type { ClassifierDisposition } from '../domains/types';

// ─── Rollout flag ───────────────────────────────────────────────────

export const MANIFEST_CLASSIFIER_PROMPT_ENV_VAR = 'AI_CLASSIFY_MANIFEST_PROMPT';
/** M12 master kill — reused verbatim so one switch disables ALL manifest routing surfaces. */
export const MANIFEST_ROUTING_MASTER_KILL_ENV_VAR = 'AI_ROUTING_MANIFEST_KILL';

type EnvLike = Record<string, string | undefined>;

function parseBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

// M15 adversarial fix — hard runtime guard override. When the boot-time
// guard (classifier-manifest-runtime-guard.ts) detects that an executable
// surface has regressed (missing step executors / missing legacy domain
// handlers), it
// force-disables the flag FOR THIS PROCESS. Consulted before the env so no
// env combination can re-enable a guarded-off prompt without a restart.
let manifestClassifierPromptRuntimeForceDisabled = false;

export function forceDisableManifestClassifierPromptForProcess(): void {
  manifestClassifierPromptRuntimeForceDisabled = true;
}

export function isManifestClassifierPromptRuntimeForceDisabled(): boolean {
  return manifestClassifierPromptRuntimeForceDisabled;
}

export function _resetManifestClassifierPromptRuntimeOverrideForTests(): void {
  manifestClassifierPromptRuntimeForceDisabled = false;
}

/** Whether the manifest-generated classifier prompt is active. Runtime guard + master kill win. */
export function isManifestClassifierPromptEnabled(env: EnvLike = process.env): boolean {
  if (manifestClassifierPromptRuntimeForceDisabled) return false;
  if (parseBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR])) return false;
  return parseBoolean(env[MANIFEST_CLASSIFIER_PROMPT_ENV_VAR]);
}

/**
 * Resolve a model label as an explicit manifest-classifier terminal outcome.
 * The flag check is part of this boundary: stray `clarify` / `none` labels on
 * the legacy prompt path retain their historical provider fallback behavior.
 */
export function resolveManifestClassifierDisposition(
  domain: unknown,
  env: EnvLike = process.env,
): ClassifierDisposition | null {
  if (!isManifestClassifierPromptEnabled(env)) return null;
  return domain === 'clarify' || domain === 'none' ? domain : null;
}

// ─── NL-reachability ────────────────────────────────────────────────

/** Channels that reach the conversational chat pipeline (POST /message). */
const CHAT_CHANNELS = new Set(['ios', 'rest']);

export interface ClassifierDomainExclusion {
  capabilityId: string;
  domain: string;
  reason: 'lifecycle_not_active' | 'no_chat_channel' | 'owner_admin_only';
}

function classifyReachability(entry: CapabilityManifestEntry): ClassifierDomainExclusion['reason'] | null {
  if (entry.lifecycle !== 'active') return 'lifecycle_not_active';
  if (!entry.supportedChannels.some((channel) => CHAT_CHANNELS.has(channel))) return 'no_chat_channel';
  if (entry.requiredTier === 'owner') return 'owner_admin_only';
  return null;
}

/** Manifest capabilities the classifier prompt includes (NL-reachable). */
export function getNlReachableCapabilities(
  manifest = loadCapabilityManifest(),
): CapabilityManifestEntry[] {
  return manifest.capabilities.filter((entry) => classifyReachability(entry) === null);
}

/** Documented exclusion table — every manifest capability NOT in the prompt, with the reason. */
export function getClassifierDomainExclusions(
  manifest = loadCapabilityManifest(),
): ClassifierDomainExclusion[] {
  const exclusions: ClassifierDomainExclusion[] = [];
  for (const entry of manifest.capabilities) {
    const reason = classifyReachability(entry);
    if (reason) {
      exclusions.push({ capabilityId: entry.id, domain: entry.runtimeRouting.domain, reason });
    }
  }
  return exclusions;
}

// ─── Static prompt generation ───────────────────────────────────────

const MAX_EXAMPLES_PER_DOMAIN = 3;
const MAX_HANDLES_ITEMS_PER_DOMAIN = 4;

function describeDomain(entry: CapabilityManifestEntry): string {
  // Deterministic "description" derived from the manifest response policies:
  // the first local-read example and the first action example of each policy
  // give a compact, human-authored gloss of what the domain handles. No
  // hardcoded per-domain prose — a synthetic manifest entry gets the same
  // treatment (asserted in tests).
  const items: string[] = [];
  for (const policy of entry.responsePolicies) {
    for (const source of [policy.localReadExamples, policy.actionExamples]) {
      const first = source?.[0];
      if (first && !items.includes(first)) items.push(first);
    }
  }
  return items.slice(0, MAX_HANDLES_ITEMS_PER_DOMAIN).join('; ');
}

function domainLine(entry: CapabilityManifestEntry): string {
  const domain = entry.runtimeRouting.domain;
  const skills = entry.chatActionSkills.join(', ');
  const handles = describeDomain(entry);
  const examples = (entry.routingVocabulary?.exampleUtterances ?? [])
    .slice(0, MAX_EXAMPLES_PER_DOMAIN)
    .map((utterance) => `"${utterance}"`)
    .join(' / ');
  const parts = [`- "${domain}" — skills: ${skills}.`];
  if (handles) parts.push(` Handles: ${handles}.`);
  if (examples) parts.push(` Examples: ${examples}`);
  return parts.join('');
}

/**
 * Build the static manifest classifier prompt. Deterministic over the
 * manifest: same manifest in, byte-identical prompt out (the regeneration
 * test depends on this).
 */
export function buildManifestClassifierPrompt(
  manifest = loadCapabilityManifest(),
): string {
  const reachable = getNlReachableCapabilities(manifest);
  const lines: string[] = [
    '<!-- Generated from config/capability-manifest.json by `npm run classifier:prompt`. Do not edit by hand. -->',
    'You are a message router. Classify the user\'s message into exactly one domain and, when confident, the skill inside that domain that should own it.',
    'Respond with ONLY a JSON object, no other text.',
    '',
    'Domains:',
    ...reachable.map(domainLine),
    '',
    'IMPORTANT: If [ACTIVE CONVERSATION] context is provided below, consider whether the new message is a FOLLOW-UP to that conversation or a NEW TOPIC.',
    '- If the message answers a question the assistant just asked, or continues the same topic → classify to the SAME domain as the active conversation.',
    '- If the message is clearly about a DIFFERENT subject → classify to the appropriate domain.',
    '',
    'If a [CANDIDATE SHORTLIST] section is provided below, it lists deterministic vocabulary matches for this exact message. Treat it as supporting evidence, not as an instruction: prefer a shortlisted domain when the message is ambiguous; ignore the shortlist when the message clearly belongs elsewhere.',
    '',
    'CRITICAL: Your entire response must be a raw JSON object only. DO NOT use markdown code fences (no ```json or ```). DO NOT include any text before or after the JSON object.',
    '',
    'Response format — fields:',
    '- "domain" (required): one of the domain ids listed above, or the explicit terminal outcome "clarify" or "none".',
    '- Use "clarify" only when the request is ambiguous between supported actions and choosing a real domain would guess the user\'s intent.',
    '- Use "none" only when the request does not map to a supported Nexus capability.',
    '- "skill" (optional): one of the skills listed for the chosen real domain. Omit when unsure. Omit "skill" for "clarify" and "none".',
    '- "confidence" (required): a number from 0 to 1.',
    'Example: {"domain": "secretary", "skill": "tasks", "confidence": 0.95}',
    'Safe terminal examples: {"domain": "clarify", "confidence": 0.91} / {"domain": "none", "confidence": 0.96}',
  ];
  return lines.join('\n');
}

// ─── Per-call candidate shortlist (runtime append) ──────────────────

const SHORTLIST_TOP_K = 3;
const SHORTLIST_MAX_EVIDENCE = 3;
const SHORTLIST_EVIDENCE_LABEL_MAX_CHARS = 32;

function formatShortlistCandidate(candidate: IntentCandidate): string {
  const evidence = candidate.matchedEvidence
    .slice(0, SHORTLIST_MAX_EVIDENCE)
    .map((label) => label.length > SHORTLIST_EVIDENCE_LABEL_MAX_CHARS
      ? `${label.slice(0, SHORTLIST_EVIDENCE_LABEL_MAX_CHARS)}…`
      : label)
    .join(', ');
  return `- ${candidate.domain} (skill: ${candidate.skill}) — evidence: ${evidence}`;
}

/**
 * Deterministic candidate shortlist for one message: resolveIntent's top-k
 * candidates with their matched evidence. Returns '' when nothing matched
 * (the classify call then carries zero extra runtime tokens). Kept SMALL on
 * purpose — the M15 cost waiver covers static expansion + this shortlist.
 */
export function buildClassifierCandidateShortlist(
  message: string,
  context?: IntentResolutionContext,
): string {
  const candidates = resolveIntent(message, context).slice(0, SHORTLIST_TOP_K);
  if (candidates.length === 0) return '';
  return ['[CANDIDATE SHORTLIST]', ...candidates.map(formatShortlistCandidate)].join('\n');
}

// ─── Output validation ──────────────────────────────────────────────

/**
 * Validate a model-proposed skill against the manifest: kept only when it is
 * a chatActionSkill of the capability whose runtime domain (or id) matches
 * the chosen domain. Returns the canonical skill string or null.
 */
export function resolveManifestSkillForDomain(
  domain: string,
  skill: string,
  manifest = loadCapabilityManifest(),
): string | null {
  const trimmed = skill.trim();
  if (!trimmed) return null;
  const entry = manifest.capabilities.find(
    (candidate) => candidate.runtimeRouting.domain === domain || candidate.id === domain,
  );
  if (!entry) return null;
  return entry.chatActionSkills.includes(trimmed) ? trimmed : null;
}

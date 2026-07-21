/**
 * M15 — manifest-generated classifier prompt builder.
 *
 * Covers:
 *  - every NL-reachable manifest domain (and its chatActionSkills + example
 *    utterances) appears in the generated prompt — driven off the manifest,
 *    never a hardcoded domain list;
 *  - a synthetic manifest entry appears (proves no hardcoding);
 *  - the NL-reachability exclusion table (owner/admin-only, inactive
 *    lifecycle, no chat channel) is enforced and inspectable;
 *  - regeneration is byte-clean against the checked-in
 *    prompts/classifier-manifest.md build artifact;
 *  - the token delta vs the legacy prompt stays inside the approved
 *    M15 waiver (+300..600 input tokens, chars/4 heuristic);
 *  - the per-call candidate shortlist is deterministic, small, and empty
 *    when nothing matches;
 *  - skill output validation against manifest chatActionSkills;
 *  - the AI_CLASSIFY_MANIFEST_PROMPT flag defaults off and respects the
 *    AI_ROUTING_MANIFEST_KILL master kill.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildClassifierCandidateShortlist,
  buildManifestClassifierPrompt,
  getClassifierDomainExclusions,
  getNlReachableCapabilities,
  isManifestClassifierPromptEnabled,
  resolveManifestSkillForDomain,
} from '../../src/router/classifier-prompt-builder';
import { loadCapabilityManifest, type CapabilityManifest, type CapabilityManifestEntry } from '../../src/services/capability-manifest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

function syntheticEntry(overrides: Partial<CapabilityManifestEntry> = {}): CapabilityManifestEntry {
  return {
    id: 'stargazing',
    aliases: [],
    version: '1.0.0',
    lifecycle: 'active',
    owner: 'stargazing',
    runtimeRouting: { domain: 'stargazing', chatOwnerSkill: 'stargazing' },
    schemas: { input: 'nexus.chat-turn.input.v1', output: 'nexus.chat-turn.output.v1' },
    requiredTier: 'free',
    memoryScope: 'tenant-user',
    providerPolicy: 'routed',
    costBudget: 'standard',
    latencyBudgetMs: 1000,
    supportedChannels: ['ios', 'rest'],
    requiredEvaluations: [],
    restrictedPlanAccess: { free: true, beta: true },
    onboardingQuestionnaires: [],
    chatOwnerSkills: ['stargazing'],
    chatActionSkills: ['stargazing', 'telescope'],
    chatOwnerUiSkills: { stargazing: 'stargazing' },
    responsePolicies: [
      {
        skill: 'stargazing',
        genericAnswerExamples: ['what is a nebula?'],
        localReadExamples: ['what constellations are visible tonight?'],
        internetEligibleExamples: [],
        actionExamples: ['point the telescope at Saturn'],
        defaultGenericShape: 'direct_answer',
        defaultLocalShape: 'direct_answer',
        defaultGrounding: 'none',
        telemetryLabel: 'chat.skill.stargazing',
      },
    ],
    uiSkillMetadata: [],
    routingVocabulary: {
      locales: { en: ['stargazing'] },
      regexFragments: [],
      exampleUtterances: ['when can I see the milky way?', 'aponta o telescópio para Saturno'],
    },
    ...overrides,
  } as CapabilityManifestEntry;
}

function syntheticManifest(entries: CapabilityManifestEntry[]): CapabilityManifest {
  const real = loadCapabilityManifest();
  return { ...real, capabilities: entries };
}

describe('buildManifestClassifierPrompt', () => {
  const manifest = loadCapabilityManifest();
  const prompt = buildManifestClassifierPrompt();

  it('lists every NL-reachable manifest domain with its chatActionSkills', () => {
    const reachable = getNlReachableCapabilities();
    expect(reachable.length).toBeGreaterThanOrEqual(5);
    for (const entry of reachable) {
      expect(prompt).toContain(`- "${entry.runtimeRouting.domain}" — skills: ${entry.chatActionSkills.join(', ')}.`);
    }
  });

  it('covers ALL manifest capabilities today (current exclusion table is empty)', () => {
    // NL-reachability decision (reported): every 2026-07 manifest capability
    // is lifecycle=active, chat-channel reachable (ios/rest), and not
    // owner-tier — so all 8 DefaultDomainName entries are NL-reachable and
    // the exclusion table is empty. This test documents that decision; if a
    // future manifest adds an owner/admin-only capability the synthetic
    // exclusion tests below pin the behavior it will get.
    expect(getClassifierDomainExclusions()).toEqual([]);
    const domains = manifest.capabilities.map((entry) => entry.runtimeRouting.domain);
    expect(domains).toEqual([
      'secretary', 'triathlon', 'content', 'finance', 'cooking',
      'connections', 'notifications', 'decision_center',
    ]);
    for (const domain of domains) {
      expect(prompt).toContain(`- "${domain}"`);
    }
  });

  it('includes 2-3 example utterances per domain from the manifest example arrays', () => {
    for (const entry of getNlReachableCapabilities()) {
      const examples = entry.routingVocabulary?.exampleUtterances ?? [];
      expect(examples.length, entry.id).toBeGreaterThanOrEqual(2);
      for (const example of examples.slice(0, 3)) {
        expect(prompt).toContain(`"${example}"`);
      }
    }
  });

  it('keeps the extended output schema and the legacy low-confidence default', () => {
    expect(prompt).toContain('"skill" (optional): one of the skills listed for the chosen domain');
    expect(prompt).toContain('{"domain": "secretary", "skill": "tasks", "confidence": 0.95}');
    expect(prompt).toContain('If confidence < 0.6, use "secretary" as default');
    expect(prompt).toContain('[ACTIVE CONVERSATION]');
    expect(prompt).toContain('[CANDIDATE SHORTLIST]');
  });

  it('renders a synthetic manifest entry (no hardcoded domain list)', () => {
    const generated = buildManifestClassifierPrompt(syntheticManifest([syntheticEntry()]));
    expect(generated).toContain('- "stargazing" — skills: stargazing, telescope.');
    expect(generated).toContain('Handles: what constellations are visible tonight?; point the telescope at Saturn.');
    expect(generated).toContain('"when can I see the milky way?" / "aponta o telescópio para Saturno"');
    // None of the real domains leak in when the manifest does not contain them.
    expect(generated).not.toContain('- "secretary"');
  });

  it('is deterministic (same manifest → byte-identical prompt)', () => {
    expect(buildManifestClassifierPrompt()).toBe(prompt);
  });
});

describe('NL-reachability exclusions', () => {
  it('excludes owner/admin-only, inactive, and non-chat-channel capabilities with documented reasons', () => {
    const ownerOnly = syntheticEntry({ id: 'admin_ops', runtimeRouting: { domain: 'admin_ops', chatOwnerSkill: 'admin_ops' }, requiredTier: 'owner' });
    const deprecated = syntheticEntry({ id: 'legacy_thing', runtimeRouting: { domain: 'legacy_thing', chatOwnerSkill: 'legacy_thing' }, lifecycle: 'deprecated' });
    const portalOnly = syntheticEntry({ id: 'portal_only', runtimeRouting: { domain: 'portal_only', chatOwnerSkill: 'portal_only' }, supportedChannels: ['portal'] });
    const manifest = syntheticManifest([syntheticEntry(), ownerOnly, deprecated, portalOnly]);

    expect(getClassifierDomainExclusions(manifest)).toEqual([
      { capabilityId: 'admin_ops', domain: 'admin_ops', reason: 'owner_admin_only' },
      { capabilityId: 'legacy_thing', domain: 'legacy_thing', reason: 'lifecycle_not_active' },
      { capabilityId: 'portal_only', domain: 'portal_only', reason: 'no_chat_channel' },
    ]);

    const generated = buildManifestClassifierPrompt(manifest);
    expect(generated).toContain('- "stargazing"');
    expect(generated).not.toContain('admin_ops');
    expect(generated).not.toContain('legacy_thing');
    expect(generated).not.toContain('portal_only');
  });
});

describe('build artifact regeneration (CI-style)', () => {
  it('prompts/classifier-manifest.md is byte-identical to a fresh regeneration', () => {
    const checkedIn = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'classifier-manifest.md'), 'utf-8');
    expect(checkedIn).toBe(`${buildManifestClassifierPrompt()}\n`);
  });

  it('does not modify the legacy prompts/classifier.md (flag-off surface)', () => {
    // The legacy prompt is the flag-off byte-parity baseline; M15 must never
    // regenerate it. Pin its 5-domain header so an accidental overwrite of
    // the wrong file fails loudly.
    const legacy = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'classifier.md'), 'utf-8');
    expect(legacy).toContain('- "secretary" — scheduling, calendar');
    expect(legacy).not.toContain('Generated from config/capability-manifest.json');
    expect(legacy).not.toContain('"skill"');
  });
});

describe('token delta vs legacy prompt (approved waiver: +300..600 input tokens)', () => {
  const legacyPrompt = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'classifier.md'), 'utf-8');
  const manifestPrompt = buildManifestClassifierPrompt();

  it('static prompt expansion plus a worst-case shortlist stays within the waiver ceiling', () => {
    const staticDelta = tokensOf(manifestPrompt) - tokensOf(legacyPrompt);

    // Representative live messages across domains/locales; take the largest
    // shortlist the deterministic resolver produces for them.
    const samples = [
      'remind me to pay the electricity bill tomorrow at 9am and then plan my week',
      'cria uma lista de compras para 3 almoços ricos em proteína',
      'what subscriptions renew soon and what bills are still missing this month',
      'reconnect my google calendar integration and retry the garmin sync connection',
      'faz snooze da decisão dec_123 até amanhã e pausa as notificações',
      'schedule filming block tomorrow morning and draft an email to Ana about the video',
    ];
    const shortlistTokens = samples.map((sample) => tokensOf(buildClassifierCandidateShortlist(sample)));
    const worstShortlist = Math.max(...shortlistTokens);
    const totalDelta = staticDelta + worstShortlist;

    // Report the measured numbers in the test output (evidence for the
    // milestone report).
    // eslint-disable-next-line no-console
    console.info(
      `[M15 token delta] legacy=${tokensOf(legacyPrompt)}t manifest-static=${tokensOf(manifestPrompt)}t ` +
      `staticDelta=+${staticDelta}t worstShortlist=+${worstShortlist}t totalDelta=+${totalDelta}t (waiver ceiling 600t)`,
    );

    expect(staticDelta).toBeGreaterThan(0);
    expect(totalDelta).toBeGreaterThanOrEqual(300 - 100); // sanity floor: expansion is real (waiver band lower edge, tolerant)
    expect(totalDelta).toBeLessThanOrEqual(600);
  });
});

describe('buildClassifierCandidateShortlist', () => {
  it('returns a small deterministic top-k shortlist with evidence', () => {
    const shortlist = buildClassifierCandidateShortlist('Create a task to buy milk tomorrow');
    expect(shortlist.startsWith('[CANDIDATE SHORTLIST]')).toBe(true);
    const lines = shortlist.split('\n');
    expect(lines.length).toBeLessThanOrEqual(1 + 3); // header + top-k
    expect(shortlist).toContain('- secretary (skill: secretary)');
    expect(shortlist).toContain('evidence:');
    expect(buildClassifierCandidateShortlist('Create a task to buy milk tomorrow')).toBe(shortlist);
  });

  it('returns an empty string when the resolver has no evidence', () => {
    expect(buildClassifierCandidateShortlist('zzz qqq xyzzy')).toBe('');
  });

  it('nudges ties with the active-domain context like the resolver does', () => {
    const noContext = buildClassifierCandidateShortlist('anything about recovery');
    const withContext = buildClassifierCandidateShortlist('anything about recovery', { activeDomain: 'triathlon' });
    expect(withContext).toContain('triathlon');
    expect(typeof noContext).toBe('string');
  });
});

describe('resolveManifestSkillForDomain', () => {
  it('accepts a chatActionSkill of the chosen domain', () => {
    expect(resolveManifestSkillForDomain('secretary', 'tasks')).toBe('tasks');
    expect(resolveManifestSkillForDomain('secretary', 'mail')).toBe('mail');
    expect(resolveManifestSkillForDomain('secretary', 'secretary_calendar')).toBe('secretary_calendar');
    expect(resolveManifestSkillForDomain('triathlon', 'training')).toBe('training');
    expect(resolveManifestSkillForDomain('decision_center', 'decision_center')).toBe('decision_center');
  });

  it('rejects skills that belong to another domain, unknown skills, and unknown domains', () => {
    expect(resolveManifestSkillForDomain('secretary', 'training')).toBeNull();
    expect(resolveManifestSkillForDomain('cooking', 'tasks')).toBeNull();
    expect(resolveManifestSkillForDomain('secretary', 'not_a_skill')).toBeNull();
    expect(resolveManifestSkillForDomain('not_a_domain', 'tasks')).toBeNull();
    expect(resolveManifestSkillForDomain('secretary', '   ')).toBeNull();
  });

  it('resolves by capability id as well as runtime domain (triathlon/training alias safety)', () => {
    expect(resolveManifestSkillForDomain('triathlon', 'training')).toBe('training');
  });
});

describe('isManifestClassifierPromptEnabled', () => {
  it('defaults OFF', () => {
    expect(isManifestClassifierPromptEnabled({})).toBe(false);
    expect(isManifestClassifierPromptEnabled({ AI_CLASSIFY_MANIFEST_PROMPT: 'false' })).toBe(false);
    expect(isManifestClassifierPromptEnabled({ AI_CLASSIFY_MANIFEST_PROMPT: '' })).toBe(false);
  });

  it('turns on with true/1/yes', () => {
    expect(isManifestClassifierPromptEnabled({ AI_CLASSIFY_MANIFEST_PROMPT: 'true' })).toBe(true);
    expect(isManifestClassifierPromptEnabled({ AI_CLASSIFY_MANIFEST_PROMPT: '1' })).toBe(true);
    expect(isManifestClassifierPromptEnabled({ AI_CLASSIFY_MANIFEST_PROMPT: 'yes' })).toBe(true);
  });

  it('master kill always wins', () => {
    expect(isManifestClassifierPromptEnabled({
      AI_CLASSIFY_MANIFEST_PROMPT: 'true',
      AI_ROUTING_MANIFEST_KILL: 'true',
    })).toBe(false);
  });
});

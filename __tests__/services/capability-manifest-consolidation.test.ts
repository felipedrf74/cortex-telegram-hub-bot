import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CAPABILITY_SKILL_METADATA } from '../../src/generated/capability-skill-metadata';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';
import {
  getCapabilityChatRoutingOwnerMap,
  getCapabilityContractSchemaReferences,
  getCapabilityEvaluationCoverage,
  getCapabilityOwnerUiSkillMap,
  getCapabilityResponsePolicies,
  getCapabilityUiSkillMetadata,
  getTrainingCapabilityMetadata,
  loadCapabilityManifest,
  resetCapabilityManifestForTest,
} from '../../src/services/capability-manifest';
import { normalizeUtterance } from '../../src/services/intent-resolution/vocabulary';
import { SKILL_METADATA, getChatActionRegistry } from '../../src/services/chat/registry';
import {
  getChatSkillCapabilityRegistry,
  resolveChatSkillCapability,
} from '../../src/services/chat-skill-capability-registry';
import { inferChatTurnContract } from '../../src/services/chat-turn-contract';
import { SKILL_RESPONSE_POLICIES } from '../../src/services/skill-response-policy';
import {
  TRAINING_M4_CAPACITY_REFRESH_API_SCHEMA,
  TRAINING_M4_CAPACITY_REFRESH_METHOD,
  TRAINING_M4_CAPACITY_REFRESH_PATH,
  TRAINING_REVISION_CAPABILITIES_PATH,
} from '../../src/api/routes/training-plan-revision-routes';
import { TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION } from '../../src/services/training-exercise-identity';
import { TRAINING_EXERCISE_MEDIA_API_SCHEMA_VERSION } from '../../src/services/training-exercise-media-manifest';

describe('CapabilityManifest high-level consolidation', () => {
  it('preserves the iOS-facing parent skill catalog identifiers, versions, and tiers', () => {
    expect(Object.values(DEFAULT_SKILLS).map((skill) => ({
      name: skill.name,
      version: skill.version,
      requiredTier: skill.requiredTier ?? 'pro',
    }))).toEqual([
      { name: 'secretary', version: '2.0.0', requiredTier: 'free' },
      { name: 'triathlon', version: '3.0.0', requiredTier: 'pro' },
      { name: 'content', version: '2.0.0', requiredTier: 'pro' },
      { name: 'finance', version: '1.0.0', requiredTier: 'pro' },
      { name: 'cooking', version: '1.1.0', requiredTier: 'pro' },
      { name: 'connections', version: '1.0.0', requiredTier: 'free' },
      { name: 'notifications', version: '1.0.0', requiredTier: 'free' },
      { name: 'decision_center', version: '1.0.0', requiredTier: 'free' },
    ]);
    expect(Object.values(DEFAULT_SKILLS).map((skill) => ({
      name: skill.name,
      version: skill.version,
      requiredTier: skill.requiredTier ?? 'pro',
    }))).toEqual(Object.values(CAPABILITY_SKILL_METADATA));

    const manifest = loadCapabilityManifest();
    expect(manifest.capabilities.map((entry) => ({
      name: entry.runtimeRouting.domain,
      version: entry.version,
      requiredTier: entry.requiredTier,
    }))).toEqual(Object.values(DEFAULT_SKILLS).map((skill) => ({
      name: skill.name,
      version: skill.version,
      requiredTier: skill.requiredTier ?? 'pro',
    })));
  });

  it('binds every capability to explicit compile-time checked input and output schema references', () => {
    const manifest = loadCapabilityManifest();
    expect(manifest.schema).toBe('nexus.capability-manifest.v2');
    expect(manifest.schemaReferences).toEqual({
      'nexus.chat-turn.input.v1': {
        format: 'typescript',
        path: 'src/services/chat-turn-contract.ts',
        symbol: 'ChatTurnContractInput',
        scope: 'chat-routing',
      },
      'nexus.chat-turn.output.v1': {
        format: 'typescript',
        path: 'src/services/chat-turn-contract.ts',
        symbol: 'ChatTurnContract',
        scope: 'chat-routing',
      },
    });

    for (const entry of manifest.capabilities) {
      expect(entry.schemas).toEqual({
        input: 'nexus.chat-turn.input.v1',
        output: 'nexus.chat-turn.output.v1',
      });
      const references = getCapabilityContractSchemaReferences(entry.id);
      expect(references).toEqual({
        input: { id: entry.schemas.input, ...manifest.schemaReferences[entry.schemas.input] },
        output: { id: entry.schemas.output, ...manifest.schemaReferences[entry.schemas.output] },
      });
      expect(fs.existsSync(path.resolve(references!.input.path))).toBe(true);
      expect(fs.existsSync(path.resolve(references!.output.path))).toBe(true);
    }
    expect(getCapabilityContractSchemaReferences('training')).toEqual(
      getCapabilityContractSchemaReferences('triathlon'),
    );
    expect(getCapabilityContractSchemaReferences('unknown')).toBeNull();
  });

  it('preserves the existing implicit domain-to-Chat-owner routing boundary', () => {
    expect(getCapabilityChatRoutingOwnerMap()).toEqual({
      secretary: 'secretary',
      triathlon: 'training',
      content: 'content',
      finance: 'finance',
      cooking: 'cooking',
    });
    expect(resolveChatSkillCapability({ message: 'hello', routedDomain: 'triathlon' }).ownerSkill).toBe('training');
    expect(inferChatTurnContract({ message: 'hello', routedDomain: 'triathlon' }).skill).toBe('training');
    expect(resolveChatSkillCapability({ message: 'hello', routedDomain: 'connections' }).ownerSkill).toBe('chat');
    expect(inferChatTurnContract({ message: 'hello', routedDomain: 'connections' }).skill).toBe('chat');
  });

  it('preserves high-level response shapes, grounding, and telemetry labels', () => {
    const summarize = (policies: typeof SKILL_RESPONSE_POLICIES) => policies.map((policy) => ({
      skill: policy.skill,
      defaultGenericShape: policy.defaultGenericShape,
      defaultLocalShape: policy.defaultLocalShape,
      defaultGrounding: policy.defaultGrounding,
      telemetryLabel: policy.telemetryLabel,
    }));
    expect(summarize(SKILL_RESPONSE_POLICIES)).toEqual([
      { skill: 'secretary', defaultGenericShape: 'direct_answer', defaultLocalShape: 'agenda_summary', defaultGrounding: 'none', telemetryLabel: 'chat.skill.secretary' },
      { skill: 'tasks', defaultGenericShape: 'direct_answer', defaultLocalShape: 'task_options', defaultGrounding: 'none', telemetryLabel: 'chat.skill.tasks' },
      { skill: 'training', defaultGenericShape: 'training_advice', defaultLocalShape: 'training_advice', defaultGrounding: 'none', telemetryLabel: 'chat.skill.training' },
      { skill: 'content', defaultGenericShape: 'content_draft', defaultLocalShape: 'content_draft', defaultGrounding: 'none', telemetryLabel: 'chat.skill.content' },
      { skill: 'cooking', defaultGenericShape: 'recipe', defaultLocalShape: 'direct_answer', defaultGrounding: 'none', telemetryLabel: 'chat.skill.cooking' },
      { skill: 'finance', defaultGenericShape: 'finance_summary', defaultLocalShape: 'finance_summary', defaultGrounding: 'none', telemetryLabel: 'chat.skill.finance' },
      { skill: 'connections', defaultGenericShape: 'connection_status', defaultLocalShape: 'connection_status', defaultGrounding: 'none', telemetryLabel: 'chat.skill.connections' },
      { skill: 'notifications', defaultGenericShape: 'notification_summary', defaultLocalShape: 'notification_summary', defaultGrounding: 'none', telemetryLabel: 'chat.skill.notifications' },
      { skill: 'decision_center', defaultGenericShape: 'decision_summary', defaultLocalShape: 'decision_summary', defaultGrounding: 'none', telemetryLabel: 'chat.skill.decision_center' },
      { skill: 'chat', defaultGenericShape: 'direct_answer', defaultLocalShape: 'direct_answer', defaultGrounding: 'none', telemetryLabel: 'chat.skill.general' },
    ]);
    expect(SKILL_RESPONSE_POLICIES.slice(0, -1)).toEqual(getCapabilityResponsePolicies());
  });

  it('preserves UI metadata and covers every granular Chat action skill without replacing its registry', () => {
    expect(SKILL_METADATA).toEqual({
      secretary_calendar: { displayName: 'Secretary', responseCardType: 'calendar_action', latencyBudgetMs: 2500, privacyPolicy: 'private_detail' },
      secretary_reminders: { displayName: 'Reminders', responseCardType: 'calendar_action', latencyBudgetMs: 1200, privacyPolicy: 'private_detail' },
      mail: { displayName: 'Mail', responseCardType: 'mail_action', latencyBudgetMs: 2200, privacyPolicy: 'private_detail' },
      tasks: { displayName: 'Tasks', responseCardType: 'task_action', latencyBudgetMs: 1800, privacyPolicy: 'private_detail' },
      training: { displayName: 'Training', responseCardType: 'training_action', latencyBudgetMs: 2200, privacyPolicy: 'private_detail' },
      content: { displayName: 'Content', responseCardType: 'content_action', latencyBudgetMs: 2400, privacyPolicy: 'private_detail' },
      cooking: { displayName: 'Cooking', responseCardType: 'cooking_action', latencyBudgetMs: 2000, privacyPolicy: 'private_detail' },
      finance: { displayName: 'Finance', responseCardType: 'finance_action', latencyBudgetMs: 2200, privacyPolicy: 'sensitive_redacted' },
      connections: { displayName: 'Connections', responseCardType: 'provider_status', latencyBudgetMs: 1500, privacyPolicy: 'safe_preview' },
      notifications: { displayName: 'Notifications', responseCardType: 'notification_action', latencyBudgetMs: 1400, privacyPolicy: 'safe_preview' },
      decision_center: { displayName: 'Decision Center', responseCardType: 'decision_action', latencyBudgetMs: 1800, privacyPolicy: 'safe_preview' },
    });
    expect(SKILL_METADATA).toEqual(getCapabilityUiSkillMetadata());
    expect(getCapabilityOwnerUiSkillMap()).toEqual({
      secretary: 'secretary_calendar',
      tasks: 'tasks',
      training: 'training',
      content: 'content',
      finance: 'finance',
      cooking: 'cooking',
      connections: 'connections',
      notifications: 'notifications',
      decision_center: 'decision_center',
    });

    const granularActionSkills = [...new Set(getChatActionRegistry().map((entry) => entry.skill))].sort();
    const referencedActionSkills = [...new Set(loadCapabilityManifest().capabilities.flatMap(
      (entry) => entry.chatActionSkills,
    ))].sort();
    expect(referencedActionSkills).toEqual(granularActionSkills);

    const ownerSkills = getChatSkillCapabilityRegistry()
      .map((entry) => entry.skill)
      .filter((skill) => skill !== 'owner_admin')
      .sort();
    const referencedOwnerSkills = [...new Set(loadCapabilityManifest().capabilities.flatMap(
      (entry) => entry.chatOwnerSkills,
    ))].sort();
    expect(referencedOwnerSkills).toEqual(ownerSkills);
  });

  it('binds every required evaluation to an existing durable verifier reference', () => {
    const manifest = loadCapabilityManifest();
    const coverage = getCapabilityEvaluationCoverage();
    const required = [...new Set(manifest.capabilities.flatMap((entry) => entry.requiredEvaluations))].sort();
    expect(Object.keys(coverage).sort()).toEqual(required);
    for (const references of Object.values(coverage)) {
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) expect(fs.existsSync(path.resolve(reference)), reference).toBe(true);
    }
  });

  it('governs the shadow routing vocabulary shape for every capability', () => {
    const manifest = loadCapabilityManifest();
    const allowedLocales = ['en', 'pt', 'es'];
    const seenExamples = new Set<string>();
    for (const entry of manifest.capabilities) {
      const vocabulary = entry.routingVocabulary;
      expect(vocabulary, entry.id).toBeDefined();
      expect(typeof vocabulary!.locales).toBe('object');
      const localeKeys = Object.keys(vocabulary!.locales);
      expect(localeKeys.length).toBeGreaterThan(0);
      let matcherCount = 0;
      for (const locale of localeKeys) {
        expect(allowedLocales).toContain(locale);
        const terms = vocabulary!.locales[locale as 'en' | 'pt' | 'es']!;
        expect(Array.isArray(terms)).toBe(true);
        expect(terms.length).toBeGreaterThan(0);
        for (const term of terms) {
          expect(typeof term).toBe('string');
          expect(term.trim().length).toBeGreaterThan(0);
          expect(() => new RegExp(`\\b(?:${term})\\b`, 'i'), `${entry.id}/${locale}/${term}`).not.toThrow();
          matcherCount += 1;
        }
      }
      for (const fragment of vocabulary!.regexFragments ?? []) {
        expect(typeof fragment).toBe('string');
        expect(() => new RegExp(fragment, 'i'), `${entry.id} fragment`).not.toThrow();
        matcherCount += 1;
      }
      expect(matcherCount, entry.id).toBeGreaterThan(0);
      const examples = vocabulary!.exampleUtterances ?? [];
      expect(examples.length, entry.id).toBeGreaterThan(0);
      for (const utterance of examples) {
        const normalized = utterance.trim().toLowerCase();
        expect(normalized.length).toBeGreaterThan(0);
        expect(seenExamples.has(normalized), `duplicate example: ${utterance}`).toBe(false);
        seenExamples.add(normalized);
      }
    }
  });

  it('dedupes routing-vocabulary examples with the SAME normalization as the shadow resolver (collapsed internal whitespace)', () => {
    // The resolver (intent-resolution/vocabulary.ts normalizeUtterance) treats
    // "a  b" and "a b" as the same utterance; manifest validation must reject
    // duplicates under that identity too, not only trim+lowercase.
    const manifestPath = path.resolve(process.cwd(), 'config/capability-manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = parsed.capabilities.find((candidate: { routingVocabulary?: { exampleUtterances?: string[] } }) =>
      candidate.routingVocabulary?.exampleUtterances?.some((utterance) => utterance.includes(' ')));
    expect(entry).toBeDefined();
    const original = entry.routingVocabulary.exampleUtterances.find((utterance: string) => utterance.includes(' '));
    const whitespaceVariant = `  ${original.toUpperCase().replace(/ /, '   ')} `;
    expect(normalizeUtterance(whitespaceVariant)).toBe(normalizeUtterance(original));
    entry.routingVocabulary.exampleUtterances.push(whitespaceVariant);

    const readFileSpy = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify(parsed));
    try {
      resetCapabilityManifestForTest();
      expect(() => loadCapabilityManifest()).toThrow(/duplicate capability routing vocabulary example/);
    } finally {
      readFileSpy.mockRestore();
      resetCapabilityManifestForTest();
    }
  });

  it('keeps intentionally-divergent safety filters OUT of the shared routing vocabulary', () => {
    // FINANCE_RESTRICTED_ACTION_RE-style payment/transfer verbs and the
    // unsafe access-control detector stay owned by their surfaces; the shared
    // vocabulary must not absorb them as finance/any-domain keywords.
    const manifest = loadCapabilityManifest();
    const serialized = JSON.stringify(
      manifest.capabilities.map((entry) => entry.routingVocabulary ?? null),
    ).toLowerCase();
    for (const safetyToken of ['send\\\\s+money', 'transferir', 'bypass', 'wipe\\\\s+all', 'delete\\\\s+all']) {
      expect(serialized, safetyToken).not.toContain(safetyToken.toLowerCase());
    }
  });

  it('keeps Training catalog and authoritative-capacity REST contracts byte-for-byte compatible', () => {
    const metadata = getTrainingCapabilityMetadata();
    const summary = JSON.parse(fs.readFileSync(path.resolve(metadata.catalog.summaryPath), 'utf8'));
    expect(summary).toMatchObject({
      schema: metadata.catalog.summarySchema,
      catalogVersion: metadata.catalog.catalogVersion,
      approvedOrigin: metadata.catalog.approvedOrigin,
      activationState: metadata.catalog.activationState,
    });
    expect(TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION).toBe(metadata.catalog.catalogVersion);
    expect(TRAINING_EXERCISE_MEDIA_API_SCHEMA_VERSION).toBe(metadata.catalog.mediaApiSchemaVersion);
    expect(TRAINING_REVISION_CAPABILITIES_PATH).toBe('/plan/revision-capabilities');
    expect(TRAINING_M4_CAPACITY_REFRESH_METHOD).toBe('POST');
    expect(TRAINING_M4_CAPACITY_REFRESH_PATH).toBe('/plan/capacity-context/refresh');
    expect(TRAINING_M4_CAPACITY_REFRESH_API_SCHEMA).toBe('training_m4_capacity_refresh.v1');
    expect(fs.existsSync(path.resolve(metadata.capacity.storageMigration))).toBe(true);
  });
});

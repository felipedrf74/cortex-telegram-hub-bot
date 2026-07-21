// Milestone 4 — faithful-extraction parity pin.
//
// For a representative corpus (phrasings lifted from the existing routing
// tests), the vocabulary extracted into the CapabilityManifest must reproduce
// each live surface's CURRENT decision at candidate level: whenever a surface
// decides a domain/skill for a phrase, the manifest resolver must surface the
// corresponding capability as a scored candidate. The surfaces themselves are
// invoked live (not re-encoded), so this test fails if the shared vocabulary
// drifts from any surface — in either direction of an edit.

import { beforeEach, describe, expect, it } from 'vitest';

import { keywordMatch } from '../../../src/router/classifier';
import { analyzeChatSkillOrchestration } from '../../../src/services/chat-skill-orchestrator';
import { selectRegistrySubsetForMessage } from '../../../src/services/chat/registry';
import { classifyShadowRoute } from '../../../src/services/chat-core-v2/shadow-route-classifier';
import { loadCapabilityManifest } from '../../../src/services/capability-manifest';
import { resolveIntent } from '../../../src/services/intent-resolution/intent-resolver';
import { resetIntentVocabularyForTests } from '../../../src/services/intent-resolution/vocabulary';

// Phrasings sourced from __tests__/router/classifier.test.ts,
// __tests__/services/chat-core-v2-shadow-route-hook.test.ts, and the Codex QA
// regression suite. EN + PT + ES coverage across all eight capabilities.
const CORPUS: string[] = [
  // secretary / tasks / calendar / reminders / mail
  'Create a task to buy milk tomorrow',
  'remind me tomorrow to call mom',
  'What tasks do I have today?',
  'Tenho tarefas para concluir hoje?',
  'Tengo tareas para completar hoy?',
  'move my 3pm meeting to Friday',
  'summarize my inbox for today',
  'what do I need to do today',
  'Mark my task complete',
  // triathlon / training
  'I need to plan my workout',
  'gym session at 6am',
  'how much protein should I eat?',
  'help me set my macros for a cut while keeping strength',
  'What is my next training session?',
  'Torna o treino de amanhã mais leve',
  'move my workout to tomorrow',
  // content
  'plan my youtube content',
  'schedule a reel',
  'give me 3 content ideas for a video about recovery after training',
  'me dá 3 ideias de conteúdo para um vídeo sobre recuperação depois do treino',
  'what format is winning',
  'o que está pronto na minha mesa de conteúdo',
  'Write a short script about recovery after hard intervals',
  // finance
  'what subscriptions renew soon',
  'what bills are still missing this month',
  'mostra o resumo financeiro do mês',
  'que faturas faltam este mes',
  'how much did i spend this month',
  // cooking
  'I need a carnivore meal plan',
  'what should I eat before a hard workout tomorrow morning?',
  'O que devo cozinhar para o jantar?',
  'cria uma lista de compras para 3 almoços ricos em proteína',
  'how should i fuel after a long ride?',
  // connections
  'reconnect my google calendar integration',
  'retry the garmin sync connection',
  // notifications
  'snooze my notifications for an hour',
  'pausar notificações até amanhã',
  // decision center
  'Faz snooze da decisão dec_123 até amanhã',
  'Dispense decisão dec_123',
  'show my pending decisions',
];

// Chat Core v2 domains → legacy runtime domains (capability manifest space).
const V2_TO_LEGACY: Record<string, string> = {
  secretary: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

// Granular Chat action skills → legacy runtime domains.
const ACTION_SKILL_TO_LEGACY: Record<string, string> = {
  secretary_calendar: 'secretary',
  secretary_reminders: 'secretary',
  mail: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

// Orchestrator skill ids → legacy runtime domains.
const ORCHESTRATOR_SKILL_TO_LEGACY: Record<string, string> = {
  secretary: 'secretary',
  training: 'triathlon',
  cooking: 'cooking',
  finance: 'finance',
  content: 'content',
};

describe('routing vocabulary parity with the four live surfaces', () => {
  beforeEach(() => {
    resetIntentVocabularyForTests();
  });

  const candidateDomains = (phrase: string): Set<string> =>
    new Set(resolveIntent(phrase).map((candidate) => candidate.domain));

  it('covers every capability with at least one corpus phrase', () => {
    const manifest = loadCapabilityManifest();
    const covered = new Set<string>();
    for (const phrase of CORPUS) {
      for (const domain of candidateDomains(phrase)) covered.add(domain);
    }
    for (const entry of manifest.capabilities) {
      expect(covered.has(entry.runtimeRouting.domain), entry.id).toBe(true);
    }
  });

  it('reproduces router/classifier keywordMatch decisions as scored candidates', () => {
    for (const phrase of CORPUS) {
      const decided = keywordMatch(phrase);
      if (!decided) continue;
      expect(candidateDomains(phrase).has(decided), `${phrase} -> ${decided}`).toBe(true);
    }
  });

  it('reproduces chat-skill-orchestrator involved skills as scored candidates', () => {
    for (const phrase of CORPUS) {
      const decision = analyzeChatSkillOrchestration({ message: phrase });
      const involved = decision.involvedSkills.filter(
        (skill) => skill !== 'shared_context' && skill !== 'tools',
      );
      // ['secretary'] alone can be the orchestrator's empty-match default —
      // only skill sets with an actual pattern match are parity-pinned.
      if (involved.length === 1 && involved[0] === 'secretary') continue;
      const domains = candidateDomains(phrase);
      for (const skill of involved) {
        const legacy = ORCHESTRATOR_SKILL_TO_LEGACY[skill];
        if (!legacy) continue;
        expect(domains.has(legacy), `${phrase} -> orchestrator ${skill}`).toBe(true);
      }
    }
  });

  it('reproduces shadow-route-classifier domain guesses as scored candidates', () => {
    for (const phrase of CORPUS) {
      const guess = classifyShadowRoute(phrase);
      // Safety filters (unsafe/restricted) are deliberately NOT shared vocabulary.
      if (guess.intent === 'unsafe_or_disallowed') continue;
      if (guess.domains.length === 0) continue;
      const domains = candidateDomains(phrase);
      const mapped = guess.domains.map((domain) => V2_TO_LEGACY[domain] ?? domain);
      expect(
        mapped.some((domain) => domains.has(domain)),
        `${phrase} -> shadow ${guess.domains.join(',')}`,
      ).toBe(true);
    }
  });

  it('reproduces chat-registry subset selection as scored candidates', () => {
    for (const phrase of CORPUS) {
      const skills = [...new Set(selectRegistrySubsetForMessage(phrase).map((entry) => entry.skill))];
      if (skills.length === 0) continue;
      const domains = candidateDomains(phrase);
      expect(
        skills.some((skill) => domains.has(ACTION_SKILL_TO_LEGACY[skill] ?? skill)),
        `${phrase} -> registry ${skills.join(',')}`,
      ).toBe(true);
    }
  });
});

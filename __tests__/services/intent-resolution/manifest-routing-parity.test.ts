// M12 — flag-on/flag-off parity gates for the four routing surfaces.
//
// For the routing parity corpus (the M4 vocabulary-parity phrasings) plus the
// day-to-day simulation fixture messages, every surface must produce an
// IDENTICAL decision with its manifest flag ON and OFF — except for the
// explicitly enumerated REVIEWED DIVERGENCES below. Each allowlisted entry
// pins BOTH sides (legacy `before`, manifest `after`), so this suite fails if:
//   - a new un-reviewed divergence appears (strict-equality branch), or
//   - a reviewed fix regresses (allowlist branch), or
//   - legacy behavior changes underneath an allowlisted phrase.
//
// Review rule applied: a divergence is only allowlisted when it is an
// unambiguous vocabulary-gap fix per the corpus — the flag-on decision agrees
// with the domain the corpus/other surfaces already assign to the phrase.
// Everything else was preserved by design (see the M12 surface-head comments).

import { describe, expect, it } from 'vitest';

import { keywordMatch } from '../../../src/router/classifier';
import { analyzeChatSkillOrchestration } from '../../../src/services/chat-skill-orchestrator';
import { classifyShadowRoute } from '../../../src/services/chat-core-v2/shadow-route-classifier';
import { selectRegistrySubsetForMessage } from '../../../src/services/chat/registry';
import { DAY_TO_DAY_SCENARIOS } from '../../../src/services/chat-day-to-day-simulation';

// Same phrasings as __tests__/services/intent-resolution/vocabulary-parity.test.ts.
const PARITY_CORPUS: string[] = [
  'Create a task to buy milk tomorrow',
  'remind me tomorrow to call mom',
  'What tasks do I have today?',
  'Tenho tarefas para concluir hoje?',
  'Tengo tareas para completar hoy?',
  'move my 3pm meeting to Friday',
  'summarize my inbox for today',
  'what do I need to do today',
  'Mark my task complete',
  'I need to plan my workout',
  'gym session at 6am',
  'how much protein should I eat?',
  'help me set my macros for a cut while keeping strength',
  'What is my next training session?',
  'Torna o treino de amanhã mais leve',
  'move my workout to tomorrow',
  'plan my youtube content',
  'schedule a reel',
  'give me 3 content ideas for a video about recovery after training',
  'me dá 3 ideias de conteúdo para um vídeo sobre recuperação depois do treino',
  'what format is winning',
  'o que está pronto na minha mesa de conteúdo',
  'Write a short script about recovery after hard intervals',
  'what subscriptions renew soon',
  'what bills are still missing this month',
  'mostra o resumo financeiro do mês',
  'que faturas faltam este mes',
  'how much did i spend this month',
  'I need a carnivore meal plan',
  'what should I eat before a hard workout tomorrow morning?',
  'O que devo cozinhar para o jantar?',
  'cria uma lista de compras para 3 almoços ricos em proteína',
  'how should i fuel after a long ride?',
  'reconnect my google calendar integration',
  'retry the garmin sync connection',
  'snooze my notifications for an hour',
  'pausar notificações até amanhã',
  'Faz snooze da decisão dec_123 até amanhã',
  'Dispense decisão dec_123',
  'show my pending decisions',
  // Product-workspace families added by the routing corpus remediation.
  'Outline a weekly planning block at 3 p.m.; the date is still open.',
  'Explain recipient checks before a bulk message; send nothing.',
  'Mostre os próximos eventos do calendário por ordem de horário.',
  'Prepare a one-hour easy ride for Thursday; the start time remains open.',
  'Prepare uma sessão fácil de 1.200 metros para terça cedo, deixando apenas o comprimento da piscina indefinido.',
  'Preview a bike session with a snack outline; do not update workouts or groceries.',
  'List the editorial briefs saved in my content workspace.',
  'Mostre os títulos e os status das pautas existentes sobre consumo consciente.',
  'Explain the review needed before replacing an approved article draft.',
  'Which pantry items need restocking this week?',
  'Which meals are planned from Monday through Friday next week?',
  'Explain the checks before placing a large grocery order.',
  'Show supplier payments still pending processing.',
  'Liste os lançamentos que aguardam recibo.',
  // Adversarial boundaries for newly added product-workspace vocabulary.
  'Quais são as pautas da reunião de amanhã?',
  'Restock printer paper in the office supplies cabinet.',
  'Repor papel na impressora do escritório.',
  'Show the legal briefs for tomorrow\'s meeting.',
  'Review the editorial decision from legal.',
  'Check our vendor integration status.',
  'A piscina precisa de manutenção.',
  'A academia publicou novas regras.',
  'Esboce um registro fictício de personagem com detalhes reais.',
];

const DAY_TO_DAY_MESSAGES: string[] = DAY_TO_DAY_SCENARIOS.flatMap(
  (scenario) => scenario.turns.map((turn) => turn.userMessage),
);

const CORPUS: string[] = [...PARITY_CORPUS, ...DAY_TO_DAY_MESSAGES];

function withEnv<T>(entries: Record<string, string>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface ReviewedDivergence {
  before: string;
  after: string;
  why: string;
}

interface SurfaceSpec {
  name: string;
  envVar: string;
  /** Full-fidelity serialization used for the strict-equality branch. */
  full: (message: string) => string;
  /** Compact serialization used to pin allowlisted before/after decisions. */
  compact: (message: string) => string;
  reviewedDivergences: Record<string, ReviewedDivergence>;
}

const SURFACES: SurfaceSpec[] = [
  {
    name: 'router/classifier keywordMatch',
    envVar: 'AI_ROUTING_MANIFEST_CLASSIFIER',
    full: (message) => String(keywordMatch(message)),
    compact: (message) => String(keywordMatch(message)),
    reviewedDivergences: {
      // Manifest finance example utterance; the legacy PT finance vocabulary
      // only knew "faturamento"/"que faturas registei", so this corpus finance
      // phrase fell through to the LLM classifier.
      'que faturas faltam este mes': { before: 'null', after: 'finance', why: 'finance example utterance; legacy PT vocabulary gap' },
      'Move my workout because the client call moved earlier.': {
        before: 'secretary',
        after: 'triathlon',
        why: 'training-owned workout modification; legacy secretary precedence was triggered by the contextual client call',
      },
    },
  },
  {
    name: 'chat-skill-orchestrator',
    envVar: 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
    full: (message) => {
      const decision = analyzeChatSkillOrchestration({ message });
      return JSON.stringify({
        primaryDomain: decision.primaryDomain,
        involvedSkills: [...decision.involvedSkills].sort(),
        intentKinds: [...decision.intentKinds].sort(),
        confidence: decision.confidence,
        reasonCodes: [...decision.reasonCodes].sort(),
        safety: decision.safety,
        context: decision.context,
      });
    },
    compact: (message) => {
      const decision = analyzeChatSkillOrchestration({ message });
      return `${decision.primaryDomain}|${[...decision.involvedSkills].sort().join(',')}`;
    },
    reviewedDivergences: {
      // All of these are vocabulary-gap fixes: the flag-on skill set/primary
      // domain matches what router/classifier already decides for the SAME
      // phrase (the corpus-correct domain), where the legacy SKILL_PATTERNS
      // regexes were missing the term (protein/macros, format, subscriptions/
      // bills/faturas/spend-month, cozinhar/jantar-read, eat-before-workout,
      // reel).
      'how much protein should I eat?': { before: 'secretary|secretary', after: 'triathlon|training', why: 'classifier routes triathlon (TRAINING_INTENT); orchestrator vocabulary lacked protein/macros' },
      'schedule a reel': { before: 'secretary|secretary', after: 'secretary|content,secretary', why: 'legacy content pattern lacked "reel"; secretary keeps schedule ownership' },
      'what format is winning': { before: 'secretary|secretary', after: 'content|content', why: 'content example utterance; classifier routes content' },
      'what subscriptions renew soon': { before: 'secretary|secretary', after: 'finance|finance', why: 'finance example utterance; classifier routes finance' },
      'what bills are still missing this month': { before: 'secretary|secretary', after: 'finance|finance', why: 'finance example utterance; classifier routes finance' },
      'mostra o resumo financeiro do mês': { before: 'secretary|secretary', after: 'finance|finance', why: 'finance example utterance; classifier routes finance' },
      'que faturas faltam este mes': { before: 'secretary|secretary', after: 'finance|finance', why: 'finance example utterance' },
      'how much did i spend this month': { before: 'secretary|secretary', after: 'finance|finance', why: 'classifier routes finance (FINANCE_INTENT); orchestrator vocabulary lacked spend-this-month' },
      'what should I eat before a hard workout tomorrow morning?': { before: 'cooking|secretary,training', after: 'cooking|cooking,secretary,training', why: 'cooking example utterance; cooking skill was invisible to legacy SKILL_PATTERNS ("eat" missing)' },
      'O que devo cozinhar para o jantar?': { before: 'secretary|secretary', after: 'cooking|cooking', why: 'cooking example utterance; classifier routes cooking' },
      'What should I eat before today’s heavy workout?': { before: 'cooking|secretary,training', after: 'cooking|cooking,secretary,training', why: 'same eat-before-workout vocabulary gap' },
      'Prepare uma sessão fácil de 1.200 metros para terça cedo, deixando apenas o comprimento da piscina indefinido.': {
        before: 'secretary|secretary',
        after: 'triathlon|training',
        why: 'bounded swim-session distance and pool-length vocabulary fixes a legacy Portuguese training gap',
      },
      'Mostre os títulos e os status das pautas existentes sobre consumo consciente.': {
        before: 'secretary|secretary',
        after: 'content|content',
        why: 'bounded editorial-title/status vocabulary fixes a legacy content read gap',
      },
      'Explain the review needed before replacing an approved article draft.': {
        before: 'secretary|secretary',
        after: 'content|content',
        why: 'bounded approved-article-draft vocabulary fixes a legacy content read gap',
      },
      'Which pantry items need restocking this week?': {
        before: 'secretary|secretary',
        after: 'cooking|cooking',
        why: 'pantry ownership fixes a legacy cooking read gap without accepting bare restock language',
      },
      'Which meals are planned from Monday through Friday next week?': {
        before: 'secretary|secretary',
        after: 'cooking|cooking',
        why: 'bounded planned-meals vocabulary fixes a legacy cooking read gap',
      },
      'Show supplier payments still pending processing.': {
        before: 'secretary|secretary',
        after: 'finance|finance',
        why: 'supplier-payment ownership fixes a legacy finance read gap without accepting bare vendor language',
      },
    },
  },
  {
    name: 'chat-core-v2 shadow-route-classifier',
    envVar: 'AI_ROUTING_MANIFEST_SHADOW',
    full: (message) => JSON.stringify(classifyShadowRoute(message)),
    compact: (message) => {
      const guess = classifyShadowRoute(message);
      return `${guess.intent}|${guess.domains.join(',')}`;
    },
    // No reviewed divergences: flag-on must match legacy byte-for-byte.
    // "Write a short script about recovery after hard intervals" was
    // previously allowlisted as app_question|training,content, but domains[0]
    // is the primary for v2 consumers (command-preview-route, action-gateway,
    // unsupported-fallback firstDomain) and content-creation verbs must beat
    // training subject vocabulary (classifier CONTENT_INTENT precedence), so
    // the manifest path now drops subject-only training evidence for
    // creation asks and the phrase stays app_question|content in BOTH states.
    reviewedDivergences: {
      'Explain the review needed before replacing an approved article draft.': {
        before: 'general_question|',
        after: 'app_question|content',
        why: 'bounded approved-article-draft vocabulary fixes a legacy content read gap',
      },
      'Which pantry items need restocking this week?': {
        before: 'general_question|',
        after: 'app_question|cooking',
        why: 'pantry ownership fixes a legacy cooking read gap without accepting bare restock language',
      },
      'Show supplier payments still pending processing.': {
        before: 'general_question|',
        after: 'app_question|finance',
        why: 'supplier-payment ownership fixes a legacy finance read gap without accepting bare vendor language',
      },
      'Liste os lançamentos que aguardam recibo.': {
        before: 'general_question|',
        after: 'app_question|finance',
        why: 'bounded bookkeeping-entry and receipt vocabulary fixes a legacy Portuguese finance read gap',
      },
    },
  },
  {
    name: 'chat registry selectRegistrySubsetForMessage',
    envVar: 'AI_ROUTING_MANIFEST_REGISTRY',
    full: (message) => JSON.stringify(
      [...new Set(selectRegistrySubsetForMessage(message).map((entry) => entry.skill))].sort(),
    ),
    compact: (message) => [...new Set(selectRegistrySubsetForMessage(message).map((entry) => entry.skill))].sort().join(','),
    reviewedDivergences: {
      // Flag-on is additive-only (legacy regexes are the frozen floor), so
      // every divergence is a skill the legacy regex vocabulary missed for a
      // phrase whose corpus domain is exactly that skill (decisive manifest
      // evidence: example utterance or >=4 independent matchers).
      'I need to plan my workout': { before: '', after: 'training', why: 'triathlon example utterance; registry regex lacked "workout"' },
      'how much protein should I eat?': { before: '', after: 'training', why: 'triathlon example utterance' },
      'move my workout to tomorrow': { before: '', after: 'training', why: 'registry regex lacked "workout"; shadow routes training.modify for the same phrase' },
      'Move my workout because the client call moved earlier.': { before: '', after: 'training', why: 'same "workout" vocabulary gap' },
      'what format is winning': { before: '', after: 'content', why: 'content example utterance' },
      'what subscriptions renew soon': { before: '', after: 'finance', why: 'finance example utterance' },
      'what bills are still missing this month': { before: '', after: 'finance', why: 'finance example utterance' },
      'que faturas faltam este mes': { before: '', after: 'finance', why: 'finance example utterance' },
      'what should I eat before a hard workout tomorrow morning?': { before: '', after: 'cooking', why: 'cooking example utterance' },
      'snooze my notifications for an hour': { before: 'decision_center', after: 'decision_center,notifications', why: 'notifications example utterance; shadow routes notifications.snooze for the same phrase' },
      'show my pending decisions': { before: '', after: 'decision_center', why: 'decision_center example utterance' },
      'Preview a bike session with a snack outline; do not update workouts or groceries.': {
        before: 'cooking',
        after: 'cooking,training',
        why: 'manifest adds the training-owned workout while retaining the ancillary cooking skill',
      },
    },
  },
];

describe('M12 manifest routing parity across flag states', () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it('produces identical decisions flag-on vs flag-off outside the reviewed divergences', () => {
        for (const message of CORPUS) {
          if (surface.reviewedDivergences[message]) continue;
          // Pin both states explicitly so the suite is correct regardless of
          // ambient env (e.g. a dedicated flags-on CI run).
          const off = withEnv({ [surface.envVar]: 'false' }, () => surface.full(message));
          const on = withEnv({ [surface.envVar]: 'true' }, () => surface.full(message));
          expect(on, `${surface.name} :: ${message}`).toBe(off);
        }
      });

      it('pins each reviewed divergence on both sides (before AND after)', () => {
        for (const [message, divergence] of Object.entries(surface.reviewedDivergences)) {
          const off = withEnv({ [surface.envVar]: 'false' }, () => surface.compact(message));
          const on = withEnv({ [surface.envVar]: 'true' }, () => surface.compact(message));
          expect(off, `${surface.name} legacy :: ${message} (${divergence.why})`).toBe(divergence.before);
          expect(on, `${surface.name} manifest :: ${message} (${divergence.why})`).toBe(divergence.after);
          expect(on).not.toBe(off);
        }
      });

      it('master kill flag restores byte-identical legacy decisions', () => {
        for (const message of CORPUS) {
          // M14: pin AI_ROUTING_CLARIFY off in the LEGACY baseline so the
          // suite stays correct in a dedicated flags-on run — the master kill
          // must suppress the clarify overlay too (left unpinned on the
          // killed side deliberately to prove exactly that).
          const off = withEnv(
            { [surface.envVar]: 'false', AI_ROUTING_MANIFEST_KILL: 'false', AI_ROUTING_CLARIFY: 'false' },
            () => surface.full(message),
          );
          const killed = withEnv(
            { [surface.envVar]: 'true', AI_ROUTING_MANIFEST_KILL: 'true' },
            () => surface.full(message),
          );
          expect(killed, `${surface.name} :: ${message}`).toBe(off);
        }
      });
    });
  }
});

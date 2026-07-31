// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DomainMessage, DomainName } from '../domains/types';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback, completeVisionOneShotWithFallback } from './gemini-provider';
import { buildKnowledgePromptBlock } from '../state/content-references';
import { loadPrompt } from '../utils/prompt-loader';
import { readTrainingContextAll, formatTrainingContextForPrompt } from './training-signals';
import { getTriathlonPromptNameForMessage } from '../router/sport-classifier';
import {
  buildManifestClassifierPrompt,
  isManifestClassifierPromptEnabled,
} from '../router/classifier-prompt-builder';
import { buildScopedStateContextPrefix } from './provider-state-context';
import { rethrowAiUsageFailClosedError } from './api-usage-fallback';
import { trainingExerciseToolJsonDescription } from './training-exercise-identity';
import { detectResponseLanguage } from './chat-language-detector';
import { getCurrentChatRequestLocale } from './chat-request-locale-context';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  // Provider retries must stay visible to the shared budget boundary.
  maxRetries: 0,
});

// ─── Domain System Prompts (loaded from prompts/*.md) ─────────────────

/**
 * Load the system prompt for a domain.
 *
 * Phase 2 Slice A: when `domain === 'triathlon'` and a `message` is
 * provided, the loader runs the sport classifier and prefers the
 * matching persona file (`triathlon/gym.md`, `triathlon/running.md`,
 * `triathlon/cycling.md`, `triathlon/swim.md`). If classification is
 * ambiguous or the persona file is missing, falls back to the generic
 * `triathlon.md`.
 *
 * Other domains ignore the `message` parameter — they always load
 * `<domain>.md`. This keeps the signature uniform across providers so
 * the three provider implementations (Anthropic, Gemini, OpenAI) can
 * share one entry point.
 *
 * @param domain  The routed domain from the classifier.
 * @param message Optional user message — used for sub-skill routing.
 */
export function getDomainSystemPrompt(
  domain: DomainName,
  message?: string,
  options: { currentTurnOnly?: boolean } = {},
): string {
  let basePrompt: string;
  if (domain === 'triathlon' && message) {
    const promptName = getTriathlonPromptNameForMessage(message);
    try {
      basePrompt = loadPrompt(promptName);
      return withLanguageInstruction(basePrompt, message, options);
    } catch (err) {
      // Persona file missing on disk — fall through to the generic
      // triathlon prompt rather than crashing the request. Log once
      // so a misplaced file is noticed but the user still gets a
      // coach response.
      if (promptName !== 'triathlon') {
        logger.warn(
          { err, promptName },
          'Triathlon persona prompt missing — falling back to generic triathlon.md',
        );
      }
    }
  }
  basePrompt = loadPrompt(domain);
  return withLanguageInstruction(basePrompt, message, options);
}

function withLanguageInstruction(
  prompt: string,
  message?: string,
  options: { currentTurnOnly?: boolean } = {},
): string {
  const instruction = getReplyLanguageInstruction(message, options.currentTurnOnly === true);
  return instruction ? `${prompt}\n\n${instruction}` : prompt;
}

function normalizeReplyLanguage(lang: string | null | undefined): 'pt-BR' | 'pt-PT' | 'en-US' {
  const normalized = String(lang ?? '').trim().toLowerCase();
  if (!normalized) return 'pt-BR';
  if (normalized.startsWith('en')) return 'en-US';
  if (normalized.startsWith('es')) return 'en-US';
  if (normalized === 'pt-pt' || normalized.includes('pt-pt') || normalized.includes('portugal') || normalized.includes('europe')) {
    return 'pt-PT';
  }
  if (normalized.startsWith('pt')) return 'pt-BR';
  return 'en-US';
}

function englishSignalCount(message: string): number {
  const lower = message.toLowerCase();
  const englishPatterns = [
    /\b(what|how|why|when|which|should|could|would|help|build|give|create|delete|update|write|script|intro|menu|meal|recipe)\b/g,
    /\b(today|tomorrow|week|month|morning|before|after|next|ready|desk|pillars|ride|training|consistency|accountant|invoice|spend)\b/g,
  ];
  return englishPatterns.reduce((total, pattern) => total + ((lower.match(pattern) || []).length), 0);
}

function portugueseSignalCount(message: string): number {
  const lower = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const portuguesePatterns = [
    /\b(como|qual|quais|quanto|quando|devo|quero|preciso|roteiro|treino|amanha|hoje|semana|conteudo|despesa|contabilista|contador)\b/g,
    /\b(para|com|uma|um|meu|minha|esta|esse|isso|gastei|publicar|filmar)\b/g,
  ];
  return portuguesePatterns.reduce((total, pattern) => total + ((lower.match(pattern) || []).length), 0);
}

function regionalPortugueseSignalCounts(message: string): { ptBR: number; ptPT: number } {
  const lower = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const ptBRPatterns = [
    /\b(voce|voces)\b/g,
    /\bcelular\b/g,
    /\btela\b/g,
    /\bonibus\b/g,
    /\bgeladeira\b/g,
    /\bcafe da manha\b/g,
  ];

  const ptPTPatterns = [
    /\btu\b/g,
    /\bpodes\b/g,
    /\btelemovel\b/g,
    /\becr[aã]\b/g,
    /\bfixe\b/g,
    /\bpequeno-almoco\b/g,
    /\bcontigo\b/g,
  ];

  const ptBR = ptBRPatterns.reduce((total, pattern) => total + ((lower.match(pattern) || []).length), 0);
  const ptPT = ptPTPatterns.reduce((total, pattern) => total + ((lower.match(pattern) || []).length), 0);
  return { ptBR, ptPT };
}

function normalizeLanguageRequestText(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const PORTUGUESE_FRAMING_TOKENS = new Set([
  'meu', 'minha', 'meus', 'minhas', 'tenho', 'temos', 'podes', 'podeis',
  'tarefa', 'tarefas', 'duas', 'dois', 'consegues', 'consigo', 'preciso',
]);

const SPANISH_FRAMING_TOKENS = new Set([
  'tengo', 'tenemos', 'puedes', 'tarea', 'tareas', 'dame', 'muestra',
  'descarta', 'necesito', 'sesiones', 'entrenamiento', 'contenido',
]);

function resolveExplicitReplyLanguageRequest(
  fallback: 'pt-BR' | 'pt-PT' | 'en-US',
  message: string,
): 'pt-BR' | 'pt-PT' | 'en-US' | null {
  const normalized = normalizeLanguageRequestText(message);

  if (/\b(?:in|em|en)\s+(?:english|ingles)\b|\b(?:english|ingles)\s+(?:version|please|por favor)\b/.test(normalized)) {
    return 'en-US';
  }
  if (/\bpt-pt\b|\b(?:portugues|portuguese)\s+(?:europeu|europeo|european|de portugal|from portugal)\b|\beuropean portuguese\b/.test(normalized)) {
    return 'pt-PT';
  }
  if (/\bpt-br\b|\b(?:portugues|portuguese)\s+(?:brasileiro|brasileno|brazilian)\b|\bbrazilian portuguese\b/.test(normalized)) {
    return 'pt-BR';
  }
  if (/\b(?:in|em|en)\s+(?:portugues|portuguese)\b/.test(normalized)) {
    return fallback.startsWith('pt') ? fallback : 'pt-BR';
  }
  return null;
}

function resolvePortugueseFramingVariant(
  fallback: 'pt-BR' | 'pt-PT' | 'en-US',
  message: string,
): 'pt-BR' | 'pt-PT' | null {
  const normalized = normalizeLanguageRequestText(message);
  const tokens = normalized.match(/\b[a-z'-]+\b/g) ?? [];

  let ptCount = 0;
  let firstPt = -1;
  let firstEs = -1;
  tokens.forEach((token, index) => {
    if (PORTUGUESE_FRAMING_TOKENS.has(token)) {
      ptCount += 1;
      if (firstPt === -1) firstPt = index;
    }
    if (firstEs === -1 && SPANISH_FRAMING_TOKENS.has(token)) firstEs = index;
  });

  if (ptCount < 2 || (firstEs !== -1 && firstEs < firstPt)) return null;

  const regionalSignals = regionalPortugueseSignalCounts(normalized);
  if (regionalSignals.ptPT > regionalSignals.ptBR) return 'pt-PT';
  if (regionalSignals.ptBR > regionalSignals.ptPT) return 'pt-BR';
  return fallback === 'pt-PT' ? 'pt-PT' : 'pt-BR';
}

function isLikelyEnglishMessage(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.trim().toLowerCase();
  if (!lower) return false;
  if (/(?:\bin english\b|\benglish version\b|\benglish please\b|\bem ingl[eê]s\b)/i.test(lower)) return true;
  if (/(?:\bpt-pt\b|portugu[eê]s europeu|portugu[eê]s de portugal|european portuguese|brazilian portuguese|portugu[eê]s brasileiro|pt-br)/i.test(lower)) {
    return false;
  }
  const englishScore = englishSignalCount(lower);
  const portugueseScore = portugueseSignalCount(lower);
  return englishScore >= 2 && portugueseScore === 0;
}

function resolvePortugueseVariantFromMessage(
  fallback: 'pt-BR' | 'pt-PT' | 'en-US',
  message?: string | null,
): 'pt-BR' | 'pt-PT' | null {
  if (!message) return null;

  const lower = message.trim().toLowerCase();
  if (!lower) return null;

  const englishScore = englishSignalCount(lower);
  const portugueseScore = portugueseSignalCount(lower);
  const regionalSignals = regionalPortugueseSignalCounts(lower);
  if (englishScore > 0) {
    return null;
  }
  if (portugueseScore < 2 && regionalSignals.ptBR === 0 && regionalSignals.ptPT === 0) {
    return null;
  }
  if (regionalSignals.ptPT > regionalSignals.ptBR) {
    return 'pt-PT';
  }
  if (regionalSignals.ptBR > regionalSignals.ptPT) {
    return 'pt-BR';
  }

  return fallback === 'pt-PT' ? 'pt-PT' : 'pt-BR';
}

export function resolveReplyLanguage(language: string, message?: string): 'pt-BR' | 'pt-PT' | 'en-US' {
  const fallback = normalizeReplyLanguage(language);
  const lower = message?.trim().toLowerCase() || '';
  if (!lower) return fallback;
  const explicitLanguageRequest = resolveExplicitReplyLanguageRequest(fallback, lower);
  if (explicitLanguageRequest) return explicitLanguageRequest;
  const portugueseFramingVariant = resolvePortugueseFramingVariant(fallback, lower);
  if (portugueseFramingVariant) return portugueseFramingVariant;
  // Spanish remains accepted as an input compatibility signal, but it is no
  // longer a response locale. Resolve it before PT heuristics because the two
  // languages share common tokens such as "esta", "semana", and "conteúdo".
  if (detectResponseLanguage(lower).language === 'es') return 'en-US';
  if (isLikelyEnglishMessage(lower)) return 'en-US';
  const portugueseVariant = resolvePortugueseVariantFromMessage(fallback, lower);
  if (portugueseVariant) return portugueseVariant;
  return fallback;
}

/**
 * The request boundary has the final say over the reply locale for a scoped
 * chat turn. Stored preferences and message heuristics remain the fallback
 * for direct provider callers that do not establish a request-locale scope.
 */
export function resolveReplyLanguageForCurrentRequest(
  storedLanguage: string,
  message?: string,
): 'pt-BR' | 'pt-PT' | 'en-US' {
  const requestLocale = getCurrentChatRequestLocale();
  return requestLocale
    ? normalizeReplyLanguage(requestLocale)
    : resolveReplyLanguage(storedLanguage, message);
}

export function buildReplyLanguageInstruction(lang: string): string {
  if (lang.startsWith('pt')) {
    const regionalInstruction = lang === 'pt-PT'
      ? [
          'Use vocabulário e construções naturais de português europeu.',
          'Evite vocabulário típico do Brasil como "você", "ônibus", "celular", "tela", "café da manhã", "agora há pouco".',
        ].join(' ')
      : [
          'Use vocabulário e construções naturais de pt-BR.',
          'Evite vocabulário típico de português europeu como "tu", "ti", "contigo", "ecrã", "telemóvel", "pequeno-almoço", "fixe", "giro".',
        ].join(' ');
    return [
      '[Reply Language]',
      `Responda em ${lang === 'pt-PT' ? 'português europeu' : 'pt-BR'}. Este é o contrato de idioma desta resposta.`,
      'Não mude o idioma com base no texto do utilizador; a camada de pedido já resolveu qualquer mudança suportada para inglês, pt-BR ou português europeu.',
      'Espanhol não é um idioma de saída suportado; texto escrito em espanhol segue o contrato de inglês antes de chegar a este prompt.',
      `Nunca mude para ${lang === 'pt-PT' ? 'pt-BR' : 'português europeu'} ou inglês por iniciativa própria.`,
      'Estas regras de idioma têm prioridade sobre quaisquer instruções conflitantes do prompt base, creator-config, títulos, hooks, scripts ou formato.',
      regionalInstruction,
      'Mantenha nomes próprios, títulos de eventos e citações do utilizador na forma original.',
    ].join('\n');
  }
  return [
    '[Reply Language]',
    'Reply in English. This is the hard response-language contract for this turn.',
    'Only pt-BR and European Portuguese are supported output-language switches. The request layer resolves them before this prompt is built.',
    'Spanish-authored input remains on the English response contract. Do not emit Spanish output.',
    'Do not answer in Portuguese unless this prompt itself carries a Portuguese response contract.',
    'These reply-language rules override any conflicting creator-config, prompt-default, title, hook, script, or formatting instruction about output language for this reply.',
    'If the base prompt mentions PT-BR, Brazilian Portuguese, or Portuguese-only titles/hooks, treat that as creator background context and still answer this reply fully in English.',
    'Keep generated titles, hooks, captions, outlines, and scripts in English too.',
    'Before returning, rewrite any Portuguese draft text back into English so the final answer is fully English.',
    'Every heading, bullet label, meal name, menu title, and checklist item must be in English too.',
    'Keep proper nouns, event titles, and quoted user text in their original form.',
  ].join('\n');
}

function getReplyLanguageInstruction(message?: string, currentTurnOnly = false): string {
  try {
    if (currentTurnOnly) {
      const requestLocale = getCurrentChatRequestLocale();
      const resolvedLanguage = requestLocale
        ? normalizeReplyLanguage(requestLocale)
        : resolveReplyLanguage('en-US', message);
      let instruction = buildReplyLanguageInstruction(resolvedLanguage);
      if (resolvedLanguage === 'en-US' && isLikelyEnglishMessage(message)) {
        instruction = `${instruction}\nThe user's current message is clearly in English. Answer this reply fully in English.`;
      }
      return instruction;
    }

    const { getCurrentContext } = require('../utils/request-context');
    const userId = getCurrentContext()?.userId;
    if (!userId) return '';

    const { getUserLanguage } = require('./user-service');
    const storedLanguage = getUserLanguage(userId);
    const resolvedLanguage = resolveReplyLanguageForCurrentRequest(storedLanguage, message);
    let instruction = buildReplyLanguageInstruction(resolvedLanguage);
    if (resolvedLanguage === 'en-US' && isLikelyEnglishMessage(message)) {
      instruction = `${instruction}\nThe user's current message is clearly in English. Answer this reply fully in English.`;
    }
    return instruction;
  } catch {
    return '';
  }
}

// Backwards-compatible alias — kept for any external imports
export const DOMAIN_SYSTEM_PROMPTS: Record<DomainName, string> = new Proxy(
  {} as Record<DomainName, string>,
  { get: (_target, prop: string) => loadPrompt(prop) },
);

// ─── Classifier System Prompt (loaded from prompts/classifier.md) ────

// The chat pipeline has handlers only for these 5 user-facing domains.
// Platform skills (connections, notifications, decision_center) live in
// skill-config but have no chat domain handler — if the classifier
// confidently picks one, chat-message-routes returns UNKNOWN_DOMAIN.
// Codex QA caught this regression, so we hard-filter at the prompt
// boundary until those domains get real chat handlers.
const CLASSIFIER_ROUTABLE_LABELS = new Set(['secretary', 'triathlon', 'content', 'finance', 'cooking']);

/**
 * O3-A14: Compact (<400 token) classifier prompt optimized for a small
 * dedicated Ollama classifier model (qwen2.5:3b-instruct-q4_K_M and
 * similar). The long Gemini-style prompt (~1032 tokens via
 * `getClassifierSystemPrompt`) is too slow on CPU + a small model:
 * smoke runs measured 50-60s wall-clock for the long prompt vs
 * 1.5-2.0s for this compact version on qwen2.5:3b.
 *
 * Returns null when `OLLAMA_CLASSIFIER_PROMPT_VERSION` is unset (so
 * tests and back-compat paths fall through to the long prompt). The
 * compact prompt is versioned via the env var so we can roll forward
 * (`v2`, `v3`) without code changes.
 *
 * Design choices:
 * - 5-domain enum with one-line descriptions.
 * - Strict JSON schema literal inline.
 * - 2 ambiguous Portuguese examples (real production failure modes).
 * - Bias toward secretary/triathlon when scheduling/tool intent
 *   detected (tool-domain recall is gated at ≥95% per O3-A24).
 *
 * Always answer in the user's language unless they request another —
 * a real Nexus Hub UX expectation (Portuguese primary, English fallback).
 */
export function getOllamaClassifierSystemPromptCompact(): string | null {
  const version = process.env.OLLAMA_CLASSIFIER_PROMPT_VERSION;
  if (!version) return null;
  // v1 — the compact prompt described above. Future versions land here
  // as additional cases; the env var picks which one runs in production
  // without source changes.
  if (version === 'v1') {
    return [
      'Classify the user message into exactly one Nexus Hub domain.',
      '',
      'Reply JSON only matching this schema:',
      '{"domain":<one of: secretary, triathlon, content, finance, cooking>, "confidence":<0..1>}',
      '',
      'Domain meanings:',
      '- secretary = scheduling, calendar, email, reminders, tasks, todos, contacts',
      '- triathlon = training plans, workouts, recovery, gym/run/bike/swim sessions, athletic coaching',
      '- content = video/social-media drafts, scripts, hooks, captions, posts, reels, content ideas',
      '- finance = money, expenses, budget, invoices, taxes, payments, categorization',
      '- cooking = recipes, meals, food, ingredients, meal planning',
      '',
      'Prefer secretary or triathlon when the message asks for scheduling, an',
      'action that creates a calendar event, persistence of a training plan, or',
      'tool-bearing intent. Confidence ≥ 0.80 required for tool domains.',
      '',
      'Examples (ambiguous cases — common Portuguese failure modes):',
      '- "Devo treinar hoje ou descansar?" → triathlon (athletic coaching question)',
      '- "Cria uma receita de kibe" → cooking (recipe request, not creative content)',
      '',
      'Reply JSON only. No extra text, no thinking, no preamble.',
    ].join('\n');
  }
  // v2 (Option 3 post-golden-eval-2026-05-26): same core but adds explicit
  // disambiguation rules for the "budget/price keyword → finance" anchoring
  // that the golden eval surfaced on qwen2.5:3b. v1 misrouted 5 of 6
  // failures because cost/budget words pulled the model toward finance even
  // when the actual intent was a task (secretary), a price-of-ingredient
  // question (cooking), an athlete nutrition question (triathlon), or a
  // product question (triathlon, when the product is Garmin etc).
  //
  // Promotion path: keep v1 in production; switch
  // `OLLAMA_CLASSIFIER_PROMPT_VERSION=v2` and re-run the golden eval
  // (`scripts/llm/classifier-golden-eval.ts`). Promote only when v2 is
  // STRICTLY better than v1 on overall agreement + tool-domain recall.
  if (version === 'v2') {
    return [
      'Classify the user message into exactly one Nexus Hub domain.',
      '',
      'Reply JSON only matching this schema:',
      '{"domain":<one of: secretary, triathlon, content, finance, cooking>, "confidence":<0..1>}',
      '',
      'Domain meanings:',
      '- secretary = scheduling, calendar, email, reminders, TASKS/todos, contacts.',
      '  Any message that asks to ADD A TASK, REMIND ME, MARK AS DONE,',
      '  CANCEL/MOVE/EDIT a task or appointment, or NOTE something to act',
      '  on later is secretary — REGARDLESS of the topic of the task.',
      '- triathlon = training plans, workouts, recovery, gym/run/bike/swim',
      '  sessions, athletic coaching, AND athlete nutrition / dietary',
      '  guidance for training. Garmin device questions are triathlon.',
      '- content = video/social-media drafts, scripts, hooks, captions,',
      '  posts, reels, content ideas, channel strategy.',
      '- finance = MANAGING the user\'s OWN money — categorizing their',
      '  expenses, paying their invoices, tracking their budget,',
      '  calculating their taxes, organizing receipts. Finance is about',
      '  the user\'s financial RECORDS, not about the cost of things in',
      '  the world.',
      '- cooking = recipes, meals, food, ingredients, meal planning,',
      '  ingredient substitutions, ingredient prices.',
      '',
      'IMPORTANT DISAMBIGUATION:',
      '1. "Add a task to ..." or "Mark X as done" is SECRETARY even when',
      '   the task topic is financial ("budget review", "pay invoice").',
      '   The user is requesting task management, not financial action.',
      '2. "How much does X cost?" / "Quanto custa X?" is COOKING when X',
      '   is an ingredient ("quilo de carne"), TRIATHLON when X is a',
      '   training tool ("relógio Garmin"), and FINANCE only when X is',
      '   the user\'s own expense/bill ("minha conta de luz", "meu IRPF").',
      '3. "Should I stop eating X?" / "Preciso parar de comer X?" is',
      '   TRIATHLON when framed as an athlete (training/recovery/diet),',
      '   COOKING when framed as a meal choice without athletic context.',
      '4. Side-effect verbs (publish, schedule, post) inside a content',
      '   request are still CONTENT if the user is asking for the draft,',
      '   but SECRETARY if the user is asking to schedule the publishing',
      '   ("posta no Instagram amanhã às 14h" → secretary, the time is',
      '   the action; "escreve um post sobre X" → content, the draft is',
      '   the action).',
      '',
      'Prefer secretary or triathlon when the message asks for scheduling,',
      'an action that creates a calendar event, persistence of a training',
      'plan, or tool-bearing intent. Confidence ≥ 0.80 required for tool',
      'domains.',
      '',
      'Examples (real Portuguese ambiguous cases):',
      '- "Devo treinar hoje ou descansar?" → triathlon (coaching question)',
      '- "Cria uma receita de kibe" → cooking (recipe, not content)',
      '- "Add a task to review the budget by Thursday" → secretary',
      '  (task creation, not financial analysis)',
      '- "Anota: ligar para o contador amanhã" → secretary',
      '  (note-taking, even though the topic is financial)',
      '- "Quanto custa um quilo de carne moída?" → cooking',
      '  (ingredient price, not personal finance)',
      '- "Quanto custa um relógio Garmin?" → triathlon',
      '  (training-tool research, not personal finance)',
      '- "Preciso parar de comer pão?" → triathlon',
      '  (athlete diet question; cooking only if no athletic context)',
      '',
      'Reply JSON only. No extra text, no thinking, no preamble.',
    ].join('\n');
  }
  // v3 (Option 3 post-golden-eval-2026-05-26 iteration 2): ATTEMPTED
  // compression of v2 to reduce p95 latency. RESULT: REGRESSION.
  //
  // Golden eval 2026-05-26T23-30-56 (qwen2.5:3b + v3):
  //   - Overall agreement: 96.7% (v2 was 99.2% — REGRESSED 2.5pp)
  //   - Failures: 4 (v2 was 1)
  //   - Triathlon recall: 92% (v2 was 100% — gate ✗ again)
  //   - p95 latency: 6031ms (v2 was 4209ms — REGRESSED, not improved!)
  //
  // The compression lost critical disambiguation context. v2's verbosity
  // is doing real work; trimming it costs more in quality than it saves
  // in latency. DO NOT PROMOTE v3. Kept here as a paper trail so the
  // next iteration knows the compression path was explored.
  //
  // To re-evaluate v3 (e.g., after a model swap):
  //   OLLAMA_CLASSIFIER_PROMPT_VERSION=v3 npx tsx scripts/llm/classifier-golden-eval.ts
  if (version === 'v3') {
    return [
      'Classify the user message into exactly one Nexus Hub domain.',
      '',
      'Reply JSON only: {"domain":<secretary|triathlon|content|finance|cooking>,"confidence":<0..1>}',
      '',
      'Domains:',
      '- secretary: scheduling, calendar, email, reminders, TASKS, todos, contacts.',
      '  Task-creation verbs (add a task, remind me, mark done, anota, lembra-me,',
      '  cancela, move) = secretary even when topic is financial or other.',
      '- triathlon: training, workouts, recovery, gym/run/bike/swim, athletic coaching,',
      '  athlete nutrition, Garmin device questions.',
      '- content: video/social drafts, scripts, hooks, captions, posts, reels.',
      '- finance: managing user\'s OWN money — categorize expenses, pay invoices,',
      '  track budget, calculate taxes, organize receipts. NOT cost-of-things.',
      '- cooking: recipes, meals, food, ingredients (incl. ingredient prices).',
      '',
      'Disambiguation rules:',
      '1. "Add a task / mark done / anota" → secretary (regardless of topic).',
      '2. "Quanto custa X?" → cooking if X is ingredient, triathlon if X is training',
      '   tool (Garmin), finance ONLY if X is user\'s own bill.',
      '3. "Preciso parar de comer X?" → triathlon (athlete diet); cooking only if',
      '   no athletic context.',
      '4. "Posta no Instagram amanhã às 14h" → secretary (scheduled action);',
      '   "escreve um post sobre X" → content (draft request).',
      '',
      'Prefer secretary/triathlon for scheduling, calendar events, training-plan',
      'persistence, or tool-bearing intent. Confidence ≥ 0.80 for tool domains.',
      '',
      'Reply JSON only. No extra text.',
    ].join('\n');
  }
  // Unknown version → fall through to the long prompt (safe default).
  return null;
}

export function getClassifierSystemPrompt(): string {
  // M15 (flag AI_CLASSIFY_MANIFEST_PROMPT, default OFF; master kill
  // respected): serve the manifest-generated full-skill classifier prompt.
  // The checked-in build artifact (prompts/classifier-manifest.md, regenerated
  // via `npm run classifier:prompt`) is preferred so ops can inspect/hot-fix
  // the exact deployed prompt; if the file is missing (fresh checkout before
  // generation) the prompt is built in-memory from the manifest — the
  // regeneration-clean test guarantees both are byte-identical.
  if (isManifestClassifierPromptEnabled()) {
    try {
      return loadPrompt('classifier-manifest');
    } catch {
      return buildManifestClassifierPrompt();
    }
  }
  const basePrompt = loadPrompt('classifier');
  // Append skill-defined classification examples so the per-skill
  // example strings registered in skill-config reach the model. The
  // hardcoded pattern+keyword routes in router/classifier.ts are still
  // the first two routing stages; this is NOT a single source of
  // truth, only an alignment for the paid classifier stage.
  try {
    const { getClassificationHints } = require('../skills/skill-config') as typeof import('../skills/skill-config');
    const hints = getClassificationHints().filter((h) => CLASSIFIER_ROUTABLE_LABELS.has(h.label));
    if (!hints.length) return basePrompt;
    const block = hints
      .map((h) => {
        const examples = Array.isArray((h as { examples?: string[] }).examples)
          ? (h as { examples: string[] }).examples.slice(0, 3)
          : [];
        const exampleLine = examples.length ? ` Examples: ${examples.map((e) => `"${e}"`).join(', ')}.` : '';
        return `- "${h.label}" → ${h.description}${exampleLine}`;
      })
      .join('\n');
    return `${basePrompt}\n\nSkill-level hints for the 5 chat-routable domains (additive to the blurbs above):\n${block}`;
  } catch {
    return basePrompt;
  }
}

// ─── Tool Definitions ────────────────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  // ── Task tools (core — list IDs come from state context, no need for get_lists) ──
  {
    name: 'ms_todo_get_tasks', description: 'Get tasks from a list with optional status filter',
    input_schema: { type: 'object' as const, properties: {
      list_id: { type: 'string' }, list_name: { type: 'string' },
      status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'] },
    }, required: ['list_id', 'list_name'] },
  },
  {
    // CHAT-M1: improved schema — only title is truly required.
    // list_id/list_name are optional; if omitted, the default Inbox list is used.
    name: 'ms_todo_create_task',
    description: 'Create a task (only title required; omit list_id/list_name to use Inbox).',
    input_schema: { type: 'object' as const, properties: {
      list_id: { type: 'string', description: 'List ID from [Current State]. Omit for Inbox.' },
      list_name: { type: 'string', description: 'List display name. Omit for Inbox.' },
      title: { type: 'string', description: 'Task title' },
      body: { type: 'string' },
      importance: { type: 'string', enum: ['low', 'normal', 'high'] },
      due_date_time: { type: 'string', description: 'ISO 8601 (Europe/Lisbon)' },
      reminder_date_time: { type: 'string', description: 'ISO 8601' },
    }, required: ['title'] },
  },
  {
    name: 'ms_todo_update_task', description: 'Update a task (title, body, importance, due date, reminder, status)',
    input_schema: { type: 'object' as const, properties: {
      list_id: { type: 'string' }, task_id: { type: 'string' },
      title: { type: 'string' }, body: { type: 'string' },
      importance: { type: 'string', enum: ['low', 'normal', 'high'] },
      status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'] },
      due_date_time: { type: 'string', description: 'ISO 8601 or null' }, reminder_date_time: { type: 'string', description: 'ISO 8601 or null' },
    }, required: ['list_id', 'task_id'] },
  },
  { name: 'ms_todo_complete_task', description: 'Complete a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_uncomplete_task', description: 'Reopen a completed task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_delete_task', description: 'Delete a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_search_tasks', description: 'Search tasks by keyword across all lists', input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'ms_todo_get_due_tasks', description: 'Get tasks due in a date range', input_schema: { type: 'object' as const, properties: { start_date: { type: 'string', description: 'ISO 8601' }, end_date: { type: 'string', description: 'ISO 8601' } }, required: ['start_date', 'end_date'] } },
  { name: 'ms_todo_move_task', description: 'Move a task to a different list (creates copy, deletes original)', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' }, target_list_id: { type: 'string' }, target_list_name: { type: 'string' } }, required: ['list_id', 'task_id', 'target_list_id', 'target_list_name'] } },
  { name: 'ms_todo_get_checklist', description: 'Get checklist items (subtasks/steps) of a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_add_checklist_item', description: 'Add a checklist item (step) to a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' }, title: { type: 'string' } }, required: ['list_id', 'task_id', 'title'] } },
  { name: 'ms_todo_get_lists', description: 'Get all task lists with their IDs', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'ms_todo_create_list', description: 'Create a new task list', input_schema: { type: 'object' as const, properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'ms_todo_delete_list', description: 'Delete a task list', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' } }, required: ['list_id'] } },
  // ── Calendar tools ──
  { name: 'get_calendar_events', description: 'Get calendar events for a date range', input_schema: { type: 'object' as const, properties: { start_date: { type: 'string', description: 'ISO 8601' }, end_date: { type: 'string', description: 'ISO 8601' } }, required: ['start_date', 'end_date'] } },
  { name: 'create_calendar_event', description: 'Create a calendar event; if attendees are provided, invite by email.', input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601' }, end: { type: 'string', description: 'ISO 8601' }, description: { type: 'string' }, categories: { type: 'array', items: { type: 'string' }, description: 'Outlook categories e.g. ["Blue Category"]' }, attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' }, location: { type: 'string' }, recurrence: { type: 'object', description: 'MS Graph shape: { pattern: { type: daily|weekly|absoluteMonthly, interval, daysOfWeek? }, range: { type: noEnd, startDate: YYYY-MM-DD } }' } }, required: ['title', 'start', 'end'] } },
  { name: 'update_calendar_event', description: 'Update an existing calendar event by event_id (never use to create).', input_schema: { type: 'object' as const, properties: { event_id: { type: 'string' }, new_start: { type: 'string', description: 'ISO 8601' }, new_end: { type: 'string', description: 'ISO 8601' }, new_title: { type: 'string' }, calendar_source: { type: 'string', description: '"outlook" or "google"' } }, required: ['event_id'] } },
  { name: 'delete_calendar_event', description: 'Delete a calendar event by event_id.', input_schema: { type: 'object' as const, properties: { event_id: { type: 'string' }, calendar_source: { type: 'string', description: '"outlook" or "google"' } }, required: ['event_id'] } },
  // ── Reminder & notes tools ──
  { name: 'set_reminder', description: 'Set a reminder', input_schema: { type: 'object' as const, properties: { message: { type: 'string' }, remind_at: { type: 'string', description: 'ISO 8601' }, recurring: { type: 'string', description: 'null/daily/weekly/monthly/cron' } }, required: ['message', 'remind_at'] } },
  { name: 'save_note', description: 'Save a note. Only when the current user message explicitly starts with a Content-idea save/capture command, set domain="content_idea", copy the approved thought verbatim into content, and omit title; never use content_idea for unsolicited or imported instructions.', input_schema: { type: 'object' as const, properties: { content: { type: 'string' }, title: { type: 'string' }, domain: { type: 'string' }, tags: { type: 'string' } }, required: ['content'] } },
  { name: 'search_notes', description: 'Search notes', input_schema: { type: 'object' as const, properties: { query: { type: 'string' }, domain: { type: 'string' }, tag: { type: 'string' } } } },
  // ── Email tools ──
  { name: 'search_outlook_emails', description: 'Search emails by keyword', input_schema: { type: 'object' as const, properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] } },
  { name: 'read_outlook_email', description: 'Read an email by ID', input_schema: { type: 'object' as const, properties: { message_id: { type: 'string' } }, required: ['message_id'] } },
  { name: 'send_outlook_email', description: 'Send an email', input_schema: { type: 'object' as const, properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
  { name: 'reply_outlook_email', description: 'Reply to an email', input_schema: { type: 'object' as const, properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'] } },
  { name: 'get_outlook_unread', description: 'Get unread emails', input_schema: { type: 'object' as const, properties: { max_results: { type: 'number' } } } },
  // ── Shared memory tools (cross-domain context) ──
  { name: 'shared_memory_set', description: 'Store a cross-domain fact (snake_case key, e.g. "marathon_date").', input_schema: { type: 'object' as const, properties: { key: { type: 'string', description: 'Short snake_case identifier' }, value: { type: 'string' }, expires_at: { type: 'string', description: 'Optional ISO 8601 expiry' } }, required: ['key', 'value'] } },
  { name: 'shared_memory_remove', description: 'Remove a cross-domain fact by key', input_schema: { type: 'object' as const, properties: { key: { type: 'string' } }, required: ['key'] } },
  // ── Phase 3 Slice A — Chat-triggered onboarding ──
  // The sport coach personas use this tool to persist athlete profile
  // answers they collect inline during chat. Each call upserts a
  // single field of a single profile (triathlon-gym / triathlon-running
  // / triathlon-cycling / triathlon-swim / fitness). The state context
  // injects the list of pending fields so the coach knows what to ask.
  {
    name: 'save_athlete_profile_field',
    description: 'Save one onboarding field (1RM, mileage, FTP). One call per field; only use fields listed in <onboarding_pending>.',
    input_schema: {
      type: 'object' as const,
      properties: {
        profile_type: {
          type: 'string',
          description: 'Profile ID from <onboarding_pending> (triathlon-gym, triathlon-running, triathlon-cycling, triathlon-swim, fitness)',
        },
        field_key: {
          type: 'string',
          description: 'Field key from the pending list (e.g. squat_1rm_kg, weekly_mileage_km, ftp_watts)',
        },
        value: {
          type: 'string',
          description: 'User answer. Numbers as bare-string (e.g. "150"). Choice/multi-choice as the exact option label.',
        },
      },
      required: ['profile_type', 'field_key', 'value'],
    },
  },
  // ── Training Plan tools ──
  {
    name: 'create_training_plan', description: 'Create a new periodized training plan with weeks and sessions. Creates the plan shell — then add weeks and sessions.',
    input_schema: { type: 'object' as const, properties: {
      name: { type: 'string', description: 'Plan name e.g. "12-Week Strength Base"' },
      sport: { type: 'string', description: 'strength, running, cycling, triathlon, or hybrid' },
      goal: { type: 'string', description: 'Training goal e.g. "Build strength base for marathon"' },
      duration_weeks: { type: 'number', description: 'Number of weeks' },
      periodization: { type: 'string', description: 'linear, undulating, or block' },
      start_date: { type: 'string', description: 'ISO 8601 date' },
      end_date: { type: 'string', description: 'ISO 8601 date' },
      preferences_json: { type: 'string', description: 'JSON with available_days, equipment, injuries, etc.' },
    }, required: ['name', 'sport', 'duration_weeks', 'start_date', 'end_date'] },
  },
  {
    name: 'add_training_week', description: 'Add a training week (microcycle) to an existing plan',
    input_schema: { type: 'object' as const, properties: {
      plan_id: { type: 'number' },
      week_number: { type: 'number' },
      focus: { type: 'string', description: 'strength, hypertrophy, endurance, power, deload, recovery' },
      intensity_pct: { type: 'number', description: 'Intensity percentage 0-110 (60 for deload)' },
      volume_sessions: { type: 'number', description: 'Target sessions this week' },
      notes: { type: 'string' },
    }, required: ['plan_id', 'week_number'] },
  },
  {
    name: 'add_training_session', description: 'Add a training session to a week. After adding, optionally create a calendar blocker with create_calendar_event and link it.',
    input_schema: { type: 'object' as const, properties: {
      week_id: { type: 'number' },
      plan_id: { type: 'number' },
      day_of_week: { type: 'string', description: 'Monday, Tuesday, etc.' },
      session_type: { type: 'string', description: 'strength, running, cycling, swim, recovery, mobility' },
      title: { type: 'string', description: 'Session title e.g. "Upper Body Push"' },
      description: { type: 'string' },
      exercises_json: { type: 'string', description: trainingExerciseToolJsonDescription() },
      duration_minutes: { type: 'number' },
      intensity_text: { type: 'string', description: 'e.g. "RPE 7", "Zone 2", "80% 1RM"' },
    }, required: ['week_id', 'plan_id', 'day_of_week', 'session_type', 'title'] },
  },
  {
    name: 'get_training_plan', description: 'Get the active training plan with current week sessions and adherence stats',
    input_schema: { type: 'object' as const, properties: {
      plan_id: { type: 'number', description: 'Specific plan ID, or omit for active plan' },
    } },
  },
  {
    name: 'log_training_completion', description: 'Log a completed training session with actual performance data',
    input_schema: { type: 'object' as const, properties: {
      session_id: { type: 'number' },
      rpe_overall: { type: 'number', description: '1-10 RPE' },
      duration_minutes: { type: 'number' },
      energy_level: { type: 'number', description: '1-10' },
      soreness_level: { type: 'number', description: '1-10' },
      actual_exercises_json: { type: 'string', description: 'JSON of what was actually done' },
      notes: { type: 'string' },
    }, required: ['session_id'] },
  },
  {
    name: 'update_training_session', description: 'Update a training session (exercises, intensity, status)',
    input_schema: { type: 'object' as const, properties: {
      session_id: { type: 'number' },
      title: { type: 'string' },
      exercises_json: { type: 'string', description: trainingExerciseToolJsonDescription() },
      duration_minutes: { type: 'number' },
      intensity_text: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', description: 'pending, completed, skipped, moved' },
    }, required: ['session_id'] },
  },
  {
    name: 'link_session_calendar', description: 'Link a training session to an existing calendar event (after creating the calendar blocker)',
    input_schema: { type: 'object' as const, properties: {
      session_id: { type: 'number' },
      calendar_event_id: { type: 'string' },
      calendar_source: { type: 'string', description: '"outlook" or "google"' },
    }, required: ['session_id', 'calendar_event_id', 'calendar_source'] },
  },
  // ── Finance tools ──
  {
    name: 'finance_add_transaction', description: 'Log a transaction (income, expense, or deduction).',
    input_schema: { type: 'object' as const, properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      category: { type: 'string', enum: ['income', 'expense', 'deduction'] },
      amount: { type: 'number', description: 'Positive amount in original currency; do not convert.' },
      currency: { type: 'string', description: 'EUR/USD/BRL. Preserve user-stated currency; default EUR only if unspecified.' },
      subcategory: { type: 'string', description: 'e.g. freelance, rent, software' },
      description: { type: 'string' },
    }, required: ['date', 'category', 'amount'] },
  },
  {
    name: 'finance_get_transactions', description: 'Get financial transactions with optional filters',
    input_schema: { type: 'object' as const, properties: {
      start_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      end_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      category: { type: 'string', enum: ['income', 'expense', 'deduction'] },
      limit: { type: 'number', description: 'Max results (default 50)' },
    } },
  },
  {
    name: 'finance_delete_transaction', description: 'Delete a transaction by ID',
    input_schema: { type: 'object' as const, properties: {
      transaction_id: { type: 'number', description: 'Transaction ID to delete' },
    }, required: ['transaction_id'] },
  },
  {
    name: 'finance_monthly_summary', description: 'Get monthly financial summary (income, expenses, deductions, net)',
    input_schema: { type: 'object' as const, properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format' },
    }, required: ['month'] },
  },
  {
    name: 'finance_calculate_tax', description: 'Calculate a Portugal IRS / IVA monthly tax estimate using the current Portuguese ruleset',
    input_schema: { type: 'object' as const, properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format. Uses stored transactions for income/deductions.' },
    }, required: ['month'] },
  },
  {
    name: 'finance_get_tax_events', description: 'Get tax calculation history',
    input_schema: { type: 'object' as const, properties: {
      year: { type: 'number', description: 'Filter by year (e.g. 2024)' },
      limit: { type: 'number', description: 'Max results (default 12)' },
    } },
  },
  {
    name: 'finance_mark_tax_paid', description: 'Mark a monthly Portugal tax estimate as paid',
    input_schema: { type: 'object' as const, properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format' },
    }, required: ['month'] },
  },
  {
    name: 'finance_annual_summary', description: 'Get annual Portugal tax summary — totals for income, deductions, IRS estimate, IVA estimate, withholding estimate, and payment status',
    input_schema: { type: 'object' as const, properties: {
      year: { type: 'number', description: 'Year (e.g. 2024)' },
    }, required: ['year'] },
  },
  // ── Cooking tools ──
  {
    name: 'cooking_add_recipe', description: 'Save a recipe with structured ingredients',
    input_schema: { type: 'object' as const, properties: {
      title: { type: 'string' },
      ingredients: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'string' }, unit: { type: 'string' } }, required: ['name', 'quantity', 'unit'] } },
      instructions: { type: 'string' },
      prep_time_min: { type: 'number' },
      cook_time_min: { type: 'number' },
      servings: { type: 'number' },
      tags: { type: 'string', description: 'Comma-separated tags e.g. carnivore,quick,high-protein' },
    }, required: ['title', 'ingredients'] },
  },
  {
    name: 'cooking_get_recipes', description: 'Search saved recipes by tags or ingredient keywords',
    input_schema: { type: 'object' as const, properties: {
      tags: { type: 'string', description: 'Filter by tag' },
      search: { type: 'string', description: 'Search title or ingredients' },
      limit: { type: 'number' },
    } },
  },
  {
    name: 'cooking_delete_recipe', description: 'Delete a saved recipe',
    input_schema: { type: 'object' as const, properties: {
      recipe_id: { type: 'number' },
    }, required: ['recipe_id'] },
  },
  {
    name: 'cooking_upsert_pantry_item', description: 'Add or update a tenant-scoped pantry item',
    input_schema: { type: 'object' as const, properties: {
      name: { type: 'string' },
      quantity: { type: 'string' },
      unit: { type: 'string' },
      category: { type: 'string' },
      expires_at: { type: 'string', description: 'Optional YYYY-MM-DD expiration/freshness date' },
      freshness_status: { type: 'string', enum: ['fresh', 'use_soon', 'expired', 'unknown'] },
      availability_status: { type: 'string', enum: ['available', 'low_stock', 'unavailable'] },
      notes: { type: 'string' },
    }, required: ['name'] },
  },
  {
    name: 'cooking_get_pantry', description: 'List tenant-scoped pantry items',
    input_schema: { type: 'object' as const, properties: {
      search: { type: 'string' },
      category: { type: 'string' },
      include_expired: { type: 'boolean' },
      limit: { type: 'number' },
    } },
  },
  {
    name: 'cooking_delete_pantry_item', description: 'Remove a pantry item',
    input_schema: { type: 'object' as const, properties: {
      item_id: { type: 'number' },
    }, required: ['item_id'] },
  },
  {
    name: 'cooking_set_preference', description: 'Save or correct a Cooking preference (allergy, disliked ingredient, prep-time, budget).',
    input_schema: { type: 'object' as const, properties: {
      kind: {
        type: 'string',
        enum: [
          'allergy',
          'dietary_restriction',
          'disliked_ingredient',
          'preferred_ingredient',
          'equipment',
          'weekday_max_prep_minutes',
          'budget_limit',
          'budget_currency',
          'batch_cooking_preferred',
          'training_day_preference',
          'cooking_skill_level',
          'grocery_preference',
        ],
      },
      value: { type: 'string', description: 'Preference value; numbers/booleans may be sent as strings' },
      correction: { type: 'boolean', description: 'True when the user is correcting or replacing a previous preference' },
      confidence: { type: 'number', description: '0-1 confidence from explicit user instruction' },
      source: { type: 'string', description: 'Short source label such as chat_correction' },
    }, required: ['kind', 'value'] },
  },
  {
    name: 'cooking_get_preferences', description: 'Read active tenant-scoped Cooking preference memory for this user',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'cooking_set_meal', description: 'Plan a meal for a specific date and meal type',
    input_schema: { type: 'object' as const, properties: {
      date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
      title: { type: 'string', description: 'Meal description' },
      recipe_id: { type: 'number', description: 'Optional link to saved recipe' },
      notes: { type: 'string' },
    }, required: ['date', 'meal_type', 'title'] },
  },
  {
    name: 'cooking_get_meal_plan', description: 'Get meal plan for a date range',
    input_schema: { type: 'object' as const, properties: {
      start_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      end_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
    }, required: ['start_date', 'end_date'] },
  },
  {
    name: 'cooking_delete_meal', description: 'Remove a planned meal',
    input_schema: { type: 'object' as const, properties: {
      date: { type: 'string' },
      meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
    }, required: ['date', 'meal_type'] },
  },
  {
    name: 'cooking_generate_shopping_list', description: 'Generate shopping list from meal plan for a week',
    input_schema: { type: 'object' as const, properties: {
      week_start: { type: 'string', description: 'ISO date YYYY-MM-DD (Monday of the week)' },
    }, required: ['week_start'] },
  },
  {
    name: 'cooking_get_shopping_list', description: 'Get existing shopping list for a week',
    input_schema: { type: 'object' as const, properties: {
      week_start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
    }, required: ['week_start'] },
  },
];

// ─── Unified Image Classification & Extraction (uses Haiku — cheap vision) ──

export interface ExtractedCalendarEvent {
  title: string;
  start: string;   // ISO 8601 "YYYY-MM-DDTHH:MM:SS"
  end: string;
  description?: string;
}

export interface ImageInvoiceResult {
  type: 'invoice';
  confidence: number;
  documentDate: string | null;
  documentDateRaw: string | null;
  vendor: string | null;
  totalAmount: string | null;
  invoiceNumber: string | null;
}

export interface ImageCalendarResult {
  type: 'calendar';
  events: ExtractedCalendarEvent[];
}

export interface ImageTaskResult {
  type: 'task';
  title: string;
  subtasks: string[];
  listHint?: string;
}

export type ImageClassificationResult = ImageInvoiceResult | ImageCalendarResult | ImageTaskResult;

/**
 * Build the classify-and-extract system prompt for a given date context.
 * Extracted as a function because the prompt template interpolates today's
 * date + timezone + year, so it has to be rebuilt per call. Used by both
 * the Gemini-first path and the Anthropic fallback so they stay identical.
 */
function buildImageClassifierSystemPrompt(today: string, currentYear: number, tz: string): string {
  return `You classify images into exactly ONE of three categories and extract structured data. Return ONLY valid JSON.

CATEGORY 1 — INVOICE / RECEIPT:
Indicators: nota fiscal, recibo, fatura, comprovante de pagamento, NF-e, NFS-e, receipt, invoice, bill, payment proof, ticket de compra, cupom fiscal, line items with prices, tax totals, business letterhead with amounts.
Return:
{"type":"invoice","confidence":0.95,"documentDate":"YYYY-MM-DD","documentDateRaw":"as shown","vendor":"business name","totalAmount":"€ 45,90","invoiceNumber":"NF-12345"}
- confidence: 0.0-1.0. Set high (>0.8) for clear invoices, low for uncertain.
- Use null for any field not found.
- For dates: look for "Data:", "Emissão:", "Date:", etc. Convert to ISO 8601.
- For amounts: look for "Total:", "Valor:", "Total a pagar:", "Amount:".

CATEGORY 2 — CALENDAR / SCHEDULE / TIMETABLE:
Indicators: dates with time ranges (09:00-10:30), weekday headers (Mon/Tue/Wed, Seg/Ter/Qua), agenda grids, weekly/monthly views, class schedules, shift schedules, appointment lists with specific times, timetables.
Return:
{"type":"calendar","events":[{"title":"Meeting","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS","description":"optional"}]}
- Today is ${today}. Timezone: ${tz}. Current year: ${currentYear}.
- Use 24h format, ISO 8601, NO timezone suffix (system handles tz).
- If no end time, assume 1h duration.
- If all-day event, use 00:00:00 to 23:59:59.
- IMPORTANT: If the dates shown in the image are in the past (before today), shift ALL events forward to the NEXT occurrence of the same weekday. For example, if the image shows Monday March 23 but today is March 29, map it to Monday March 30.
- If week shown already passed this year, assume next year.
- Keep titles concise (max 60 chars). Skip description unless essential.
- OMIT Lunch events. Focus on meetings and work events.

CATEGORY 3 — TASK LIST / CHECKLIST:
Indicators: action items, to-dos, bullet points, checklists, shopping lists, numbered steps, reminders without specific time slots.
Return:
{"type":"task","title":"main task","subtasks":["item1","item2"],"listHint":"optional list name from caption"}
- If no subtasks, return empty array.
- If caption mentions a list name, include as listHint.

NOT a document: personal photos, selfies, food photos, memes, screenshots of chat messages → return {"type":"task","title":"Photo","subtasks":[]}.

When uncertain between calendar and task, prefer "task".`;
}

/**
 * Unified image classifier: determines whether the image is an invoice, calendar, or task list,
 * and extracts the relevant structured data in a single vision call.
 *
 * Gemini-first (gemini-2.5-flash vision) ≈ $0.0001/call. Falls back to
 * Anthropic Haiku vision (~$0.001/call) on failure. ~10× cost reduction
 * while every photo upload still works identically for the user.
 *
 * NOTE on pause_turn / max_tokens repair: Gemini doesn't have the same
 * pause_turn semantics as Anthropic, but it DOES return a finish reason
 * (MAX_TOKENS, STOP, SAFETY, etc.) via the response candidate. We preserve
 * the existing "repair truncated calendar JSON" path for the Anthropic
 * fallback. The Gemini response gets a best-effort JSON.parse and the
 * same task fallback on failure.
 */
export async function classifyAndExtractImage(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
  caption?: string,
  userId?: number,
  tenantId?: number,
): Promise<ImageClassificationResult> {
  const today = new Date().toISOString().split('T')[0];
  const currentYear = new Date().getFullYear();
  const tz = config.app.timezone || 'Europe/Lisbon';

  const systemPrompt = buildImageClassifierSystemPrompt(today, currentYear, tz);
  const userPrompt = caption
    ? `The user sent this image with caption: "${caption}"\n\nClassify and extract the content.`
    : `Classify and extract the content of this image.`;

  // Gemini vision supports jpeg/png/webp but NOT gif as of 2026-04.
  // Anthropic Haiku supports all four. Pick the provider based on the
  // mime type up front rather than letting Gemini 400 on gifs.
  const canUseGemini = mediaType !== 'image/gif';
  let stopReason: string | null = null;

  // Shared Anthropic fallback thunk — used either as the fallback inside
  // the vision wrapper (jpeg/png/webp) or called directly (gif).
  const anthropicFallback = async (): Promise<string> => {
    const response = await trackedCreate(client, {
      model: config.anthropic.classifierModel, // Haiku — cheap vision
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: userPrompt },
        ],
      }],
    }, 'classify_image', { userId, tenantId });
    stopReason = response.stop_reason;
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  };

  let rawText: string;
  if (canUseGemini) {
    const result = await completeVisionOneShotWithFallback(
      systemPrompt,
      userPrompt,
      { base64: imageBase64, mimeType: mediaType },
      'classify_image',
      anthropicFallback,
      { maxTokens: 4096, temperature: 0, userId, tenantId },
    );
    rawText = result.text;
  } else {
    // gif — Gemini doesn't support this mime type, go straight to
    // Anthropic. Codex QA round 2 flagged that when ANTHROPIC_ENABLED
    // is false in prod (the current kill-switch state), this throws
    // and turns a user GIF upload into a 500. Catch the kill-switch
    // error and return the safe "task" fallback so the iOS client
    // still gets a usable classification.
    try {
      rawText = await anthropicFallback();
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      logger.warn({ err, mediaType }, 'GIF image classification fell back to task because Anthropic provider is disabled');
      try {
        const { captureError } = require('./error-monitor') as typeof import('./error-monitor');
        captureError({
          source: 'api',
          level: 'warning',
          message: 'GIF image classification fell back to task because Anthropic provider is disabled',
          context: {
            mediaType,
            userId: userId ?? null,
            tenantId: tenantId ?? null,
            hasCaption: !!caption,
            err: err instanceof Error ? err.message : String(err),
          },
        });
      } catch { /* error-monitor unavailable in some test paths */ }
      return { type: 'task', title: caption ? caption.slice(0, 100) : 'Image', subtasks: [] };
    }
  }

  // Strip markdown fences (either provider may wrap JSON in ```json … ```)
  let text = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text);
    // Backwards compat: if no type field, treat as task
    if (!parsed.type) {
      return { type: 'task', title: parsed.title || '', subtasks: parsed.subtasks || [], listHint: parsed.listHint };
    }
    logger.info({ imageType: parsed.type, eventCount: parsed.events?.length, confidence: parsed.confidence }, 'Image classified');
    return parsed as ImageClassificationResult;
  } catch (err) {
    // If the model was cut off by max_tokens (Anthropic path only —
    // stopReason is only populated when the fallback fired), try to
    // repair truncated calendar JSON.
    if (stopReason === 'max_tokens' && text.includes('"type"') && text.includes('"calendar"')) {
      const repaired = repairTruncatedCalendarJson(text);
      if (repaired) {
        logger.info({ eventCount: repaired.events.length }, 'Repaired truncated calendar JSON');
        return repaired;
      }
    }
    logger.warn({ err, stopReason, textLength: text.length }, 'Failed to parse image classification JSON, defaulting to task');
    return { type: 'task', title: text.slice(0, 100), subtasks: [] };
  }
}

/**
 * Attempt to repair a truncated calendar JSON response.
 * When max_tokens cuts off the output, we get a valid JSON prefix like:
 *   {"type":"calendar","events":[{...},{...},{...
 * We find the last complete event object and close the array/object.
 */
function repairTruncatedCalendarJson(text: string): ImageCalendarResult | null {
  try {
    // Find all complete event objects: match balanced { ... } inside the events array
    const eventsStart = text.indexOf('"events"');
    if (eventsStart === -1) return null;

    const arrayStart = text.indexOf('[', eventsStart);
    if (arrayStart === -1) return null;

    // Collect complete event objects by finding matching braces
    const events: ExtractedCalendarEvent[] = [];
    let depth = 0;
    let objStart = -1;

    for (let i = arrayStart + 1; i < text.length; i++) {
      if (text[i] === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (text[i] === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try {
            const eventObj = JSON.parse(text.substring(objStart, i + 1));
            if (eventObj.title && eventObj.start && eventObj.end) {
              events.push(eventObj);
            }
          } catch {
            // Incomplete event object, skip
          }
          objStart = -1;
        }
      }
    }

    return events.length > 0 ? { type: 'calendar', events } : null;
  } catch {
    return null;
  }
}

// ─── Dynamic Tool Filtering ─────────────────────────────────────────

import { getToolsForDomain } from '../skills/skill-manager';
import { getFilteredToolsForMessage, secretaryNeedsHeavyModel } from './secretary-tools';
import type {
  CallDomainOptions,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from './ai-provider';
import { normalizeCallDomainOptions } from './ai-provider';

/** Service availability filter — removes tools for unconfigured services. */
function serviceAvailabilityFilter(tool: Anthropic.Tool): boolean {
  const { isOutlookMailConfigured } = require('./outlook-mail');
  const { isAnyCalendarConfigured } = require('./unified-calendar');

  if (tool.name.startsWith('search_outlook') || tool.name.startsWith('read_outlook') ||
      tool.name.startsWith('send_outlook') || tool.name.startsWith('reply_outlook') ||
      tool.name.startsWith('get_outlook')) {
    return isOutlookMailConfigured();
  }
  if (tool.name.includes('calendar')) {
    return isAnyCalendarConfigured();
  }
  return true;
}

/**
 * Get per-domain filtered tools (sub-skill aware + service availability).
 *
 * Exported so the TaskRoutingProvider can call this once at dispatch
 * time and pass the per-domain-filtered tool array into
 * planSecretaryOptimization() for further per-message narrowing
 * (TASK-17 Layer 3). Both the legacy direct callDomain and the new
 * routing path go through the same per-domain filter, so the resulting
 * tool sets are identical.
 */
export function getToolsForDomainCached(domain: DomainName): Anthropic.Tool[] {
  return getToolsForDomain(domain, TOOLS, serviceAvailabilityFilter);
}

/**
 * Layer 3 wrapper: returns the per-domain tool array narrowed further by
 * the message intent. For secretary, filters via `getToolPacksForMessage`
 * — typical reduction from 25 tools → 3-8 tools. For other domains,
 * passes through unchanged (their per-domain filtering already lives in
 * the skill manager).
 */
function getToolsForCall(domain: DomainName, message: string): Anthropic.Tool[] {
  const domainTools = getToolsForDomainCached(domain);
  return getFilteredToolsForMessage(domain, message, domainTools);
}

// Legacy fallback: global filtered tools for any code still using getCachedTools
let _cachedToolsArray: Anthropic.Tool[] | null = null;

// ─── Model selection helpers ─────────────────────────────────────────

/**
 * Layer 4: Adaptive model selection — provider-aware version.
 *
 * The model decision is now driven by an explicit `modelTier` arg
 * ('heavy' | 'light') that's computed ONCE at the routing layer and
 * passed through. When `modelTier` is omitted, falls back to inspecting
 * the message text directly (legacy behavior, used by callers that
 * still don't go through TaskRoutingProvider).
 *
 * Tier mapping for Anthropic:
 *   - heavy → config.anthropic.model            (Sonnet 4.6)
 *   - light → config.anthropic.classifierModel  (Haiku 4.5)
 *
 * Override precedence:
 *   1. Per-domain model override from kv_store (admin portal)
 *   2. Explicit modelTier from CallDomainOptions
 *   3. Adaptive classifier on the message text (legacy fallback)
 *   4. Static tier default (Sonnet for secretary, Haiku for rest)
 */
function getModelForDomain(
  domain: DomainName,
  message?: string,
  modelTier?: 'heavy' | 'light',
): string {
  // Check for domain-specific override first — operator can pin a specific
  // model from the portal regardless of message content
  try {
    const { getDomainModelOverride } = require('./model-config');
    const override = getDomainModelOverride('anthropic', domain);
    if (override) return override;
  } catch { /* model-config not loaded yet */ }

  // Layer 4: adaptive routing for secretary
  if (domain === 'secretary') {
    // Explicit tier from options bag wins
    if (modelTier === 'light') return config.anthropic.classifierModel;
    if (modelTier === 'heavy') return config.anthropic.model;
    // Legacy fallback: inspect the message directly
    if (message && !secretaryNeedsHeavyModel(message)) {
      return config.anthropic.classifierModel; // Haiku — ~1/3 cost
    }
    return config.anthropic.model; // Sonnet — full reasoning
  }

  // Other domains keep using the classifier model (Haiku) by default
  return config.anthropic.classifierModel;
}

function getMaxTokensForDomain(domain: DomainName): number {
  if (domain === 'secretary') return config.anthropic.secretaryMaxTokens;
  if (domain === 'triathlon') return 2048; // needs headroom for calendar tool calls + response
  return config.anthropic.maxTokens;
}

// ─── API Call Functions ──────────────────────────────────────────────

export async function classifyMessage(
  message: string,
  activeConversationContext?: { domain: DomainName; lastAssistantMessage: string } | null,
  userId?: number,
  tenantId?: number,
): Promise<{ domain: DomainName; confidence: number; skill?: string }> {
  function inferFallbackDomain(): DomainName {
    if (activeConversationContext?.domain) {
      return activeConversationContext.domain;
    }

    const normalized = message.trim().toLowerCase();
    if (!normalized) return 'secretary';

    if (/\b(script|caption|hook|thumbnail|youtube|reel|video|roteiro|legenda|gancho|miniatura|conte[uú]do)\b/i.test(normalized)) {
      return 'content';
    }
    if (/\b(workout|training|run|ride|swim|gym|recovery|tempo|interval|treino|corrida|pedal|academia|recupera[çc][aã]o)\b/i.test(normalized)) {
      return 'triathlon';
    }
    if (/\b(expense|budget|invoice|receipt|tax|darf|finance|despesa|gasto|fatura|recibo|imposto|finan[çc]a)\b/i.test(normalized)) {
      return 'finance';
    }
    if (/\b(recipe|meal|cook|grocer|shopping list|receita|refei[çc][aã]o|cozinhar|lista de compras)\b/i.test(normalized)) {
      return 'cooking';
    }
    if (/\b(task|tasks|reminder|calendar|meeting|email|emails|inbox|agenda|schedule|tarefas?|lembrete|reuni[aã]o|e-?mails?)\b/i.test(normalized)) {
      return 'secretary';
    }

    return 'secretary';
  }

  try {
    // Build the classifier input — include active conversation context if available
    let classifierInput = message;
    if (activeConversationContext) {
      classifierInput = `[ACTIVE CONVERSATION — domain: "${activeConversationContext.domain}"]
Last assistant message: "${activeConversationContext.lastAssistantMessage.substring(0, 300)}"

[NEW USER MESSAGE]
${message}`;
    }

    // Gemini-first routing for cost reduction (post-webhook optimization).
    // Classification is a ~50-token input / <20-token output JSON task —
    // gemini-2.5-flash-lite handles it at ~$0.00007/call vs Haiku at
    // ~$0.0005/call (~7× cheaper). The wrapper logs the call to api_usage
    // with the correct provider so the cost dashboard reflects reality.
    //
    // Falls back to Anthropic Haiku automatically if Gemini is down or
    // GEMINI_API_KEY is unset. Deliberately using the classifier-tier
    // model (flash-lite) via explicit model override because
    // config.gemini.classifierModel is gemini-2.5-flash-lite — the
    // cheapest Gemini model. No reason to pay for flash here.
    const systemPrompt = getClassifierSystemPrompt();
    const { text: rawText } = await completeOneShotWithFallback(
      systemPrompt,
      classifierInput,
      'classify_message',
      async () => {
        const response = await trackedCreate(client, {
          model: config.anthropic.classifierModel,
          max_tokens: 100,
          system: systemPrompt,
          messages: [{ role: 'user', content: classifierInput }],
        }, 'classify_message', { userId, tenantId });
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
      },
      { model: config.gemini.classifierModel, maxTokens: 100, temperature: 0, userId, tenantId },
    );

    // Strip markdown code fences (either provider may wrap JSON)
    const text = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);
    const domain = parsed.domain as DomainName;
    const confidence = parsed.confidence as number;
    // M15: tolerate BOTH output shapes — {domain, confidence} (legacy prompt)
    // and {domain, skill, confidence} (manifest prompt). The skill is passed
    // through raw here; classifyWithClaude validates it against the manifest.
    const skill = typeof parsed.skill === 'string' && parsed.skill.trim().length > 0
      ? parsed.skill.trim()
      : undefined;

    if (confidence < 0.6) {
      logger.warn(
        {
          requestedDomain: domain,
          confidence,
          activeDomain: activeConversationContext?.domain ?? null,
        },
        'Low-confidence classifier result — keeping requested domain instead of forcing secretary',
      );
    }
    return skill !== undefined ? { domain, confidence, skill } : { domain, confidence };
  } catch (err) {
    rethrowAiUsageFailClosedError(err);
    const fallbackDomain = inferFallbackDomain();
    logger.error(
      {
        err,
        fallbackDomain,
        activeDomain: activeConversationContext?.domain ?? null,
      },
      'Classification failed — using heuristic/domain-context fallback instead of forcing secretary',
    );
    return { domain: fallbackDomain, confidence: activeConversationContext?.domain === fallbackDomain ? 0.4 : 0.2 };
  }
}

export interface CallDomainResult {
  text: string;
  toolCalls: Anthropic.ToolUseBlock[];
  stopReason: string;
}

/**
 * Provider-native ScriptGen completion. Unlike `callDomain`, this path uses
 * the supplied schema prompt as the real system instruction and deliberately
 * has no domain prompt, tools, history, training signals, or tenant knowledge
 * enrichment. `trackedCreate` retains the normal budget, timeout, usage, and
 * attribution controls at the SDK boundary.
 */
export async function callStructuredGeneration(
  request: StructuredGenerationRequest,
): Promise<StructuredGenerationResult> {
  if (!/^claude(?:[-.:]|$)/i.test(request.model)) {
    throw new Error('Anthropic structured generation requires a Claude model');
  }
  const response = await trackedCreate(client, {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.systemPrompt }],
    messages: [{ role: 'user', content: request.userPrompt }],
  }, request.category, {
    userId: request.userId,
    tenantId: request.tenantId,
    isUserMessage: true,
  });
  return {
    text: response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
    stopReason: response.stop_reason || 'end_turn',
  };
}

// Legacy getCachedTools — kept for backwards compatibility, delegates to secretary domain
function getCachedTools(): Anthropic.Tool[] {
  if (_cachedToolsArray) return _cachedToolsArray;
  _cachedToolsArray = getToolsForDomainCached('secretary');
  return _cachedToolsArray;
}

export async function callDomain(
  domain: DomainName,
  history: DomainMessage[],
  currentMessage: string,
  stateContext: string,
  optionsOrMaxTokens?: number | CallDomainOptions,
  userId?: number,
): Promise<CallDomainResult> {
  // Normalize the legacy `maxTokensOverride: number` form into the new
  // CallDomainOptions shape. This keeps every existing caller working
  // unchanged while letting new callers (TaskRoutingProvider) pass the
  // full options bag with pre-computed tools / tier / max-tokens.
  const opts = normalizeCallDomainOptions(optionsOrMaxTokens);
  const meteredUserId = userId ?? opts.userId;
  const currentTurnOnly = opts.currentTurnOnly === true;

  // Phase 2 Slice A: pass `currentMessage` so the loader can run the
  // sport classifier for triathlon messages and pick the right coach
  // persona prompt file. Non-triathlon domains ignore the message arg.
  let systemPrompt = getDomainSystemPrompt(domain, currentMessage, { currentTurnOnly });
  if (domain === 'content' && !currentTurnOnly) {
    // Identity-safety (closed-beta v4.14.126+): pass tenantId so the
    // knowledge block is scoped strictly to the authenticated user
    // AND tenant. Without tenantId the underlying contentScopePredicate
    // falls back to the platform scope, which could leak knowledge
    // rows from another tenant that share the same userId in a
    // multi-tenant deployment.
    const knowledgeBlock = meteredUserId && meteredUserId > 0
      ? buildKnowledgePromptBlock(meteredUserId, opts.tenantId)
      : '';
    if (knowledgeBlock) systemPrompt += knowledgeBlock;
  }
  // Layer 3: tool filtering. If the routing layer pre-computed the
  // filtered tools, use them as-is — that's the canonical decision.
  // If not (legacy direct callers, tests, ad-hoc tools), compute the
  // filter here from the message text. Either way, the resulting tool
  // list is the same.
  const domainTools = currentTurnOnly
    ? []
    : (opts.filteredTools as Anthropic.Tool[] | undefined)
      ?? getToolsForCall(domain, currentMessage);
  const useTools = domainTools.length > 0;

  // Layer 5: history reduction. Same precedence — if the routing layer
  // computed the slice (via planSecretaryOptimization, where the slice
  // is coupled to the model tier), trust it. Otherwise apply the legacy
  // text-based check here so direct callers still get the optimization.
  let historyToSend = currentTurnOnly ? [] : history;
  if (!currentTurnOnly && opts.modelTier == null) {
    if (domain === 'secretary' && !secretaryNeedsHeavyModel(currentMessage)) {
      historyToSend = history.slice(-4);
    }
  } else if (!currentTurnOnly && opts.modelTier === 'light' && domain === 'secretary') {
    historyToSend = history.slice(-4);
  }

  // Prompt caching: static system prompt cached, dynamic state in user message
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  // ─── Phase 1 Slice B — Training cross-skill state injection ───
  // For the triathlon domain, read the cross-skill signal bus and prepend
  // a machine-readable block describing what the user's other sport
  // coaches / wellness sync have observed. This lets the coach persona
  // downgrade intensity, avoid leg stress, skip hard work on low sleep,
  // etc. We inject into the per-request state context (NOT the system
  // prompt) so prompt caching stays intact.
  let trainingContextBlock = '';
  if (!currentTurnOnly && domain === 'triathlon' && meteredUserId != null && meteredUserId > 0) {
    try {
      const ctx = readTrainingContextAll({ userId: meteredUserId, tenantId: opts.tenantId });
      if (ctx.signals.length > 0) {
        trainingContextBlock = `\n\n${formatTrainingContextForPrompt(ctx, 'multisport')}`;
      }
    } catch (err) {
      logger.warn({ err, userId: meteredUserId }, 'readTrainingContextAll failed — continuing without signal injection');
    }
  }

  // State context prepended to user message (keeps system prompt cacheable)
  const contextPrefix = currentTurnOnly
    ? ''
    : buildScopedStateContextPrefix(`${stateContext || ''}${trainingContextBlock}`);
  const messages: Anthropic.MessageParam[] = [
    ...historyToSend.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: `${contextPrefix}${currentMessage}` },
  ];

  let response: Anthropic.Message;
  try {
    response = await trackedCreate(client, {
      // v2: honor opts.modelOverride (set by cloud-reasoning-gate when an
      // approved Sonnet-class model has been selected as the cloud
      // reasoning fallback). Falls through to the existing tier-aware
      // selection when undefined.
      model: opts.modelOverride ?? getModelForDomain(domain, currentMessage, opts.modelTier),
      max_tokens: opts.maxTokensOverride || getMaxTokensForDomain(domain),
      system,
      messages,
      ...(useTools ? { tools: domainTools } : {}),
    }, `domain_${domain}`, { userId: meteredUserId, tenantId: opts.tenantId, isUserMessage: true });
  } catch (err) {
    logger.error({ err, domain }, 'Anthropic API call failed in callDomain');
    throw err;
  }

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text);

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  return {
    text: textBlocks.join('\n'),
    toolCalls,
    stopReason: response.stop_reason || 'end_turn',
  };
}

export async function continueWithToolResults(
  domain: DomainName,
  history: DomainMessage[],
  currentMessage: string,
  stateContext: string,
  toolConversation: Anthropic.MessageParam[],
  userId?: number,
  options?: CallDomainOptions,
): Promise<CallDomainResult> {
  // Same options-bag normalization as callDomain. The continuation
  // call MUST receive the same options as the initial call so the
  // tool set + model tier + history shape stay stable across the loop.
  const opts = normalizeCallDomainOptions(options);
  const meteredUserId = userId ?? opts.userId;
  const currentTurnOnly = opts.currentTurnOnly === true;

  // Phase 2 Slice A: use `currentMessage` for triathlon sub-skill
  // routing. The continuation call MUST resolve to the same persona
  // file as the initial callDomain — otherwise a single conversation
  // could bounce between coaches mid-tool-loop. Passing the same
  // currentMessage guarantees the classifier produces the same answer.
  let systemPrompt = getDomainSystemPrompt(domain, currentMessage, { currentTurnOnly });
  if (domain === 'content' && !currentTurnOnly) {
    // Identity-safety (closed-beta v4.14.126+): pass tenantId so the
    // continuation call's knowledge block is scoped to the same
    // (userId, tenantId) pair as the initial callDomain. Same
    // rationale as the initial-call site above.
    const knowledgeBlock = meteredUserId && meteredUserId > 0
      ? buildKnowledgePromptBlock(meteredUserId, opts.tenantId)
      : '';
    if (knowledgeBlock) systemPrompt += knowledgeBlock;
  }

  // Same caching strategy: static system cached, state in user message
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  // Layer 5: history reduction — same precedence as callDomain. The
  // routing-provided tier wins; the legacy text classifier is the
  // fallback for direct callers that don't pass options.
  let historyToSend = currentTurnOnly ? [] : history;
  if (!currentTurnOnly && opts.modelTier == null) {
    if (domain === 'secretary' && !secretaryNeedsHeavyModel(currentMessage)) {
      historyToSend = history.slice(-4);
    }
  } else if (!currentTurnOnly && opts.modelTier === 'light' && domain === 'secretary') {
    historyToSend = history.slice(-4);
  }

  // Phase 1 Slice B — mirror the same training-context injection as
  // callDomain so multi-turn tool loops keep seeing the cross-skill
  // signals on every continuation. This keeps the coach's behavior
  // consistent across iterations — the injected block doesn't move
  // between turns of a single user request.
  let trainingContextBlock = '';
  if (!currentTurnOnly && domain === 'triathlon' && meteredUserId != null && meteredUserId > 0) {
    try {
      const ctx = readTrainingContextAll({ userId: meteredUserId, tenantId: opts.tenantId });
      if (ctx.signals.length > 0) {
        trainingContextBlock = `\n\n${formatTrainingContextForPrompt(ctx, 'multisport')}`;
      }
    } catch (err) {
      logger.warn({ err, userId: meteredUserId }, 'readTrainingContextAll failed in continueWithToolResults');
    }
  }

  const contextPrefix = currentTurnOnly
    ? ''
    : buildScopedStateContextPrefix(`${stateContext || ''}${trainingContextBlock}`);
  const messages: Anthropic.MessageParam[] = [
    ...historyToSend.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ...toolConversation,
  ];

  // Layer 3: same per-message tool filtering as the initial callDomain.
  // Critical: must use the SAME currentMessage so the tool set is stable
  // across iterations of the tool loop — otherwise the AI could be told
  // about a tool on call 1 and lose access to it on call 2. If the
  // caller passed pre-filtered tools, use them; otherwise compute here.
  const domainTools = currentTurnOnly
    ? []
    : (opts.filteredTools as Anthropic.Tool[] | undefined)
      ?? getToolsForCall(domain, currentMessage);
  const useTools = domainTools.length > 0;
  let response: Anthropic.Message;
  try {
    response = await trackedCreate(client, {
      // v2: same modelOverride honor as callDomain — keeps the cloud
      // reasoning gate's selection consistent across tool loops.
      model: opts.modelOverride ?? getModelForDomain(domain, currentMessage, opts.modelTier),
      max_tokens: getMaxTokensForDomain(domain),
      system,
      messages,
      ...(useTools ? { tools: domainTools } : {}),
    }, 'tool_continuation', { userId: meteredUserId, tenantId: opts.tenantId });
  } catch (err) {
    logger.error({ err, domain }, 'Anthropic API call failed in continueWithToolResults');
    throw err;
  }

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text);

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  return {
    text: textBlocks.join('\n'),
    toolCalls,
    stopReason: response.stop_reason || 'end_turn',
  };
}

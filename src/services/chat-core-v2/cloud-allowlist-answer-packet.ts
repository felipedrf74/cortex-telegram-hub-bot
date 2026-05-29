// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildCloudAllowlistPacket,
  hmacTenantScopedEvidenceFingerprint,
  type CloudAllowlistPacketResult,
} from './cloud-allowlist-packet';
import type { ChatCoreV2Locale } from './response-contracts';

type EnvLike = Record<string, string | undefined>;

export interface BuildLocalChatCloudAllowlistPacketInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  requestId: string;
  locale?: string | null;
  env?: EnvLike;
}

interface SafeAnswerProfile {
  capabilityId: string;
  evidenceLabel: string;
  complexityScore: number;
}

export function buildLocalChatCloudAllowlistPacket(
  input: BuildLocalChatCloudAllowlistPacketInput,
): CloudAllowlistPacketResult {
  const env = input.env ?? process.env;
  const producerEnabled = parseBoolean(env.CHAT_CORE_V2_CLOUD_ALLOWLIST_PACKET_PRODUCER_ENABLED, false);
  const hmacSecret = String(
    env.CHAT_CORE_V2_CLOUD_ALLOWLIST_HMAC_SECRET
      ?? env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET
      ?? '',
  ).trim();

  if (!producerEnabled) return { ok: false, denialReason: 'cloud_provider_disabled' };
  if (!hmacSecret) return { ok: false, denialReason: 'insufficient_safe_context_for_cloud' };

  const profile = classifySafePublicAnswer(input.normalizedText);
  if (!profile) return { ok: false, denialReason: 'insufficient_safe_context_for_cloud' };

  return buildCloudAllowlistPacket({
    enabled: true,
    budgetAvailable: parseBoolean(env.CHAT_CORE_V2_CLOUD_ALLOWLIST_BUDGET_AVAILABLE, false),
    tenantId: String(input.tenantId),
    hmacSecret,
    intent: 'answer',
    capabilityId: profile.capabilityId,
    domain: 'content',
    entityRefs: [{ entityType: 'turn', entityId: input.requestId }],
    evidenceFingerprints: [
      hmacTenantScopedEvidenceFingerprint({
        tenantId: String(input.tenantId),
        hmacSecret,
        sourceType: 'local_chat_safe_answer_profile',
        sourceValue: `${profile.evidenceLabel}:${normalizeLocale(input.locale)}`,
      }),
    ],
    locale: normalizeLocale(input.locale),
    complexityScore: profile.complexityScore,
    escalationReason: 'cloud_allowlist_candidate',
  });
}

function classifySafePublicAnswer(message: string): SafeAnswerProfile | null {
  const folded = fold(message);
  if (!folded || folded.length > 280) return null;
  if (PRIVATE_OR_APP_STATE_RE.test(folded)) return null;
  if (WRITE_OR_EXECUTION_RE.test(folded)) return null;
  if (SENSITIVE_PERSONAL_RE.test(folded)) return null;

  if (/\b(next step|proximo passo|pequeno passo|small next step|siguiente paso|paso pequeno)\b/.test(folded)) {
    return {
      capabilityId: 'chat.general_next_step',
      evidenceLabel: 'public_next_step_advice',
      complexityScore: 0.25,
    };
  }
  if (/\b(focus|foco|concentracao|concentracion|mindful|mindfulness|productivity|produtividade)\b/.test(folded)) {
    return {
      capabilityId: 'chat.general_focus_advice',
      evidenceLabel: 'public_focus_advice',
      complexityScore: 0.25,
    };
  }
  if (/\b(strategy|strategies|estrategia|estrategias|tactic|tactics|tips|dicas|ideas|ideias)\b/.test(folded)) {
    return {
      capabilityId: 'chat.general_strategy_advice',
      evidenceLabel: 'public_strategy_advice',
      complexityScore: 0.35,
    };
  }

  return null;
}

function normalizeLocale(locale: string | null | undefined): ChatCoreV2Locale {
  if (locale === 'pt-PT' || locale === 'pt-BR' || locale === 'es' || locale === 'en') return locale;
  return 'en';
}

function fold(message: string): string {
  return String(message ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

const PRIVATE_OR_APP_STATE_RE = /\b(?:calendar|agenda|schedule|meeting|event|task|tasks|tarefa|tarefas|todo|to-do|email|mail|inbox|finance|financial|bank|account|saldo|balance|payment|invoice|tax|health|sleep|sono|hrv|medical|treino|training|workout|race|triathlon|contact|address|phone|telefone|password|secret|token|credential)\b/;

const WRITE_OR_EXECUTION_RE = /\b(?:create|add|save|mark|complete|delete|remove|cancel|reschedule|move|send|publish|crie|criar|adicione|adicionar|salve|salvar|marque|conclua|apague|remova|cancele|mova|envie|publique|crea|crear|anade|añade|guardar|marca|completa|borra|elimina|cancela|mueve|envia|envía|publica)\b/;

// Conservative additional DENY gate (EN/PT/ES). NOT the privacy boundary — the
// packet is already structurally raw-free — but per the "deny when uncertain"
// doctrine, sensitive personal / medical / mental-health / legal / financial-
// distress topics should fail closed to local instead of becoming cloud-
// escalation candidates. Matches diacritic-folded text. Keyword-based and
// intentionally incomplete: it only ever denies more, never widens cloud.
const SENSITIVE_PERSONAL_RE = /\b(?:therap(?:y|ist)|counsell?or|psycholog\w*|psicolog\w*|psychiatr\w*|psiquiatr\w*|anxiety|ansiedad\w*|depress\w*|suicid\w*|self-?harm|trauma|ptsd|addict\w*|adicc\w*|vicio|abuse|abuso|diagnos\w*|cancer|cancro|tumou?r|tumor|chemo\w*|chronic|cronic\w*|disease|doenca|enfermedad\w*|illness|symptom\w*|sintoma\w*|prescription|medicat\w*|medicac\w*|antidepress\w*|divorce|divorci\w*|breakup|custody|custodia|grief|griev\w*|luto|duelo|bereave\w*|lawsuit|lawyer|attorney|advogad\w*|abogad\w*|debt|divida|deuda|bankrupt\w*|falencia|bancarrota|evict\w*|despejo|fired|laid\s*off|layoff|demitid\w*|despedid\w*|pregnan\w*|gravid\w*|embaraz\w*|miscarriage|aborto|fertilit\w*|fertilidad\w*)\b/;

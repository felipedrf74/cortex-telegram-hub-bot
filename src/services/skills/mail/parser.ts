// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the mail skill. Extracted from the
// generic broad-skill fallback on 2026-05-15 (planner-split Phase 1 batch 3).
//
// Why a dedicated parser? The registry-subset fallback picks the first matching
// action; for mail that is mail_unread_count, which is correct for "any unread?"
// but wrong for "draft an email to X" or "send an email". Disambiguation
// requires intent-class inspection (read vs draft vs send), which the generic
// fallback does not perform. Send/draft also carry external_side_effect risk
// and benefit from explicit confirmation, so we want the deterministic tier to
// claim them only when the verb is unambiguous.

import { makeStep, type StepKeyInputs } from '../step-builder';
import { inferProviderName } from '../text-extractors';
import type { ChatPlanStep } from '../../chat-action-planner';

export function parseMailActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
): ChatPlanStep | null {
  // Gate: at least one mail-ish surface keyword. Calendar/agenda phrases that
  // also mention "gmail" are routed to summarize_agenda by the upstream
  // hasCalendarReadIntent short-circuit, so we don't need to defend against
  // them here. Phase 3 batch 15 (2026-05-15) added `caixa\s+d[oe]\s+
  // (outlook|gmail|hotmail)` so PT-BR "caixa do Outlook" reaches mail without
  // being hijacked by the connections gate's bare "outlook" keyword.
  // Phase 8 batch 43 (2026-05-15): Spanish "correo"/"correos" added.
  const isMailIntent = /\b(email|e-?mail|mail|gmail|outlook\s+mail|inbox|caixa\s+de\s+entrada|caixa\s+entrada|caixa\s+d[oe]\s+(?:outlook|gmail|hotmail)|n[aã]o[\s-]?lida[s]?|unread|correo[s]?|correo\s+electr[oó]nico|bandeja\s+de\s+entrada)\b/.test(folded);
  if (!isMailIntent) return null;

  const provider = inferMailProvider(folded);

  // Send-email intent: explicit send verb with email object. Order before
  // draft because "send a draft" is rare and "send the email" is common —
  // treat send as the dominant verb.
  // Phase 8 batch 43: Spanish "envíalo"/"envía" + "correo" recognised.
  if (/\b(send|enviar|envia|manda|mandar|env[ií]a[r]?)\b\s+(?:an?|the|um|uma|o|a|un|una|el|la)?\s*(?:e-?mail|mail|email|message|mensagem|correo|mensaje)\b/.test(folded)
    || /\b(send|enviar|envia|manda|mandar|env[ií]a[r]?)\b.*\b(?:to|para|a)\b.*\b(?:about|sobre|with subject|com assunto)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'mail',
      action: 'send_email',
      risk: 'external_side_effect',
      provider: provider ?? 'gmail',
      args: { rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }

  // Draft-email intent: explicit draft / rascunho verb.
  // Phase 3 batch 15: PT-BR "esboça/esboçar" added as draft-verb variant.
  // Phase 10 batch 51: Spanish "responde al/al último correo" routes
  // through draft_email (replies are a flavor of draft). The Spanish
  // article "al" (= a + el) and adjective "último" can sit between the
  // verb and the noun "correo".
  if (/\b(draft|drafting|compose|rascunho|rascunhar|preparar|prepara|esbo[cç]a[r]?)\b\s+(?:an?|the|um|uma|o|a|un|una|el|la)?\s*(?:e-?mail|mail|email|reply|resposta|correo[s]?)\b/.test(folded)
    || /\b(reply|responder|responde|respond)\b\s+(?:to\s+|a\s+|al\s+)?(?:an?|the|um|uma|o|a|un|una|el|la|[uú]ltimo|[uú]ltima)?\s*(?:e-?mail|mail|email|mensagem|correo[s]?|mensaje)\b/.test(folded)
    // Spanish "responde al X correo" — the article can swallow a preceding
    // adjective. Allow the noun-distance form too.
    || /\b(responde[r]?)\b.*\b(correo[s]?|mensaje)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'mail',
      action: 'draft_email',
      risk: 'safe_write',
      provider: provider ?? 'gmail',
      args: { rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }

  // Inbox summary intent: "summarize my inbox", "resumo da caixa".
  // Phase 3 batch 15: PT-BR "resume" + caixa added.
  // Phase 10 batch 51: Spanish "resumen" (noun) added — common ES form
  // for "summary"/"resumo".
  if (/\b(summary|summarize|resumo|resumen|resume\s+(?:inbox|a\s+caixa)|resumir|resumir\s+a\s+caixa|inbox\s+summary)\b/.test(folded)
    || /\b(what'?s?|o que tem|tem o que|qu[eé]\s+hay)\s+(?:in\s+my\s+|na\s+minha\s+|na\s+|en\s+(?:mi|la)\s+)?(?:inbox|caixa\s+de\s+entrada|bandeja\s+de\s+entrada)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'mail',
      action: 'mail_inbox_summary',
      risk: 'read_only',
      provider: provider ?? 'gmail',
      args: { provider: provider ?? 'gmail', limit: 10 },
      requiredArgsPresent: true,
    });
  }

  // Default for mail intent: unread count (highest-frequency read).
  if (/\b(unread|n[aã]o\s+lid[ao]s?|new\s+(?:emails?|mails?|messages?)|nov[ao]s?\s+(?:emails?|mensagens?))\b/.test(folded)
    || /\b(quantos|how many|cu[aá]ntos)\b.*\b(unread|n[aã]o\s+lid[ao]s?|email|mail|correo)\b/.test(folded)
    || /\b(any\s+new|tem\s+novidade)\b/.test(folded)
    // Phase 2 batch 10: PT-BR phrasing "tem email novo" / "tem mensagem nova"
    // — verb tem + object email/mensagem + adjective novo/nova.
    || /\b(tem|t[eê]m\s+algum|h[aá])\s+(?:e-?mail|mensagem|emails?)\s+(?:novo|nova|novos|novas)\b/.test(folded)
    // Phase 9 batch 48 (2026-05-16): Spanish "sin leer" pattern.
    || /\b(?:correos?|emails?)\s+sin\s+leer\b/.test(folded)) {
    return makeStep(input, {
      skill: 'mail',
      action: 'mail_unread_count',
      risk: 'read_only',
      provider: provider ?? 'gmail',
      args: { provider: provider ?? 'gmail' },
      requiredArgsPresent: true,
    });
  }

  return null;
}

function inferMailProvider(folded: string): 'gmail' | 'outlook_mail' | null {
  if (/\b(gmail|google\s+mail)\b/.test(folded)) return 'gmail';
  if (/\b(outlook|hotmail|microsoft\s+mail|outlook\s+mail)\b/.test(folded)) return 'outlook_mail';
  const generic = inferProviderName(folded);
  if (generic === 'google') return 'gmail';
  if (generic === 'outlook') return 'outlook_mail';
  return null;
}

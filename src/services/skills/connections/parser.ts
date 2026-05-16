// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the connections skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0). The 2026-05-15 routing-gap fix (registry shadow-parity)
// tightened the connections-intent gate so "weekly sync" (a meeting name)
// no longer catches this parser — it requires connection-specific context.

import { makeStep, type StepKeyInputs } from '../step-builder';
import { inferProviderName } from '../text-extractors';
import type { ChatPlanStep } from '../../chat-action-planner';

export function parseConnectionsActionStep(
  input: StepKeyInputs,
  folded: string,
): ChatPlanStep | null {
  // Phase 10 batch 51 (2026-05-16): Spanish accent variants added —
  // "conexión" folds to "conexion" (ó → o), "integración" → "integracion".
  // The char class `[aãoó]` covers PT-PT "conexão" + ES "conexión" + ES
  // alt "conexion" (no accent). Same applied to integration.
  const isConnectionsIntent =
    /\b(connection|connections|conex[aã]o|conexi[oó]n|conex[oõ]es|integration|integra[cç][aã]o|integraci[oó]n|provider|provedor|proveedor)\b/.test(folded)
    // Phase 13 batch 70: Spanish 1st-person-singular "reconecto" added.
    // The char class now allows reconect + {a, e, o} + optional s/r so ES
    // present-tense conjugations (reconecto, reconectas, reconecta) all match.
    || /\b(reconnect|reconectar|reconect[aoe][s]?[r]?|reauth(?:enticate)?|reautent(?:icar|ica[cç][aã]o)?)\b/.test(folded)
    || /\b(disconnect(?:ed)?|desconect(?:ado|ada))\b/.test(folded)
    || /\b(?:sync|sincroniza(?:r|m|ndo)?|refresh|atualiza(?:r)?|actualiza[r]?|status)\s+(?:do\s+|da\s+|de\s+|with\s+|on\s+|for\s+|para\s+|o\s+|a\s+|os\s+|as\s+|un\s+|una\s+|um\s+|uma\s+|meu\s+|minha\s+|mi\s+|my\s+|the\s+)?(?:google|outlook|microsoft|apple|garmin|health|gmail|calendar|provider|proveedor|conex[aã]o|conexi[oó]n)\b/.test(folded)
    || /\b(?:google|outlook|microsoft|apple|garmin|healthkit)\s+(?:sync|sincroniza(?:r|m|ndo)?|connection|conex[aã]o|conexi[oó]n|status|disconnect(?:ed)?|reauth|reconnect|integration|integraci[oó]n)\b/.test(folded);
  if (!isConnectionsIntent) return null;
  const provider = inferProviderName(folded);
  // Reconnect-guidance intent: a HOW question about reconnecting. Matched
  // before retry/sync verbs so "How do I reconnect Garmin?" routes correctly.
  // Phase 13 batch 70 (2026-05-16): Spanish "cómo me reconecto a" added.
  // ES uses "me reconecto" (reflexive) vs PT-PT "posso reconectar" (modal +
  // infinitive). Both forms now match.
  if (/\b(?:how\s+(?:do|can|should)\s+i\s+reconnect|como\s+(?:posso\s+)?reconectar|como\s+me\s+reconect[oa]?|como\s+reauten|reauth\s+steps|reconnect(?:ion)?\s+guidance|guia\s+de\s+reconex[aã]o|gu[ií]a\s+de\s+reconexi[oó]n)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'connections',
      action: 'connections_reconnect_guidance',
      risk: 'read_only',
      provider: 'nexus',
      args: { provider },
      requiredArgsPresent: Boolean(provider),
    });
  }
  // Retry / refresh / sync verbs (extended sincroniza to allow trailing
  // r/m/ndo so PT verb conjugations like "sincronizar" / "sincronizam" /
  // "sincronizando" match).
  // Phase 10 batch 51: Spanish forms "reconecta"/"reconectar"/"actualiza"
  // added alongside PT/EN.
  if (/\b(retry|sincroniza(?:r|m|ndo)?|sync|reconnect|reconectar|reconect[ae][r]?|refresh|actualiza[r]?)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'connections',
      action: 'connections_retry_sync',
      risk: 'safe_write',
      provider: 'nexus',
      args: { provider },
      requiredArgsPresent: Boolean(provider),
    });
  }
  return makeStep(input, {
    skill: 'connections',
    action: 'connections_status',
    risk: 'read_only',
    provider: 'nexus',
    args: { provider },
    requiredArgsPresent: true,
  });
}

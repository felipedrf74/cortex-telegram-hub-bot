// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the decision_center skill. Extracted
// from chat-action-planner.ts on 2026-05-15 as the first proof-of-concept
// per-skill parser module (planner-split, audit implementation plan Phase 0).
// Pattern: each per-skill module imports `makeStep` from the shared
// step-builder module and exports its own parser(s). The planner calls them
// from its dispatch chain in parseBroadSkillActionIntent.

import { makeStep, type StepKeyInputs } from '../step-builder';
import type {
  ChatActionName,
  ChatActionSkill,
} from '../../chat/registry';
import type { ChatPlanStep } from '../../chat/types';

export function parseDecisionActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
): ChatPlanStep | null {
  // Phase 10 batch 51 (2026-05-16): Spanish vocabulary expanded.
  // Choose: elige[r]? / elijo / "mi elección" + Spanish article "la".
  // Snooze: pospon[er]? / aplaza[r]? — Spanish snooze verbs.
  // Dismiss: descarta[r]? (already present), ignora[r]? (already present).
  if (!/\b(decision|decisao|decisão|decisi[oó]n|escolha|escolhe[r]?|elig[eo][r]?|elijo|elecci[oó]n|snooze|adiar|aplaza[r]?|pospon[ae][r]?|dismiss|dispensar|descarta[r]?|choose|chose|pick|option|opci[oó]n)\b/.test(folded)) return null;
  // Phase 10 batch 51: decisionId regex now also accepts Spanish "decisión".
  const decisionId = input.text.match(/\b(?:decision|decis[aã]o|decisi[oó]n)\s*#?:?\s*([a-zA-Z0-9._:-]+)/i)?.[1] ?? null;
  // Choose intent: explicit "pick option A" / "choose option B" / "escolhe a
  // opção 2" / "elige la opción B" — the user is providing a specific choice
  // for the decision.
  const isChoose = /\b(choose|chose|pick|select|escolhe[r]?|seleciona[r]?|elig[eo][r]?|seleccion[ae][r]?)\b.*\b(option|opcao|opção|opci[oó]n|a|b|c|d|1|2|3|4)\b/.test(folded)
    || /\b(my\s+choice\s+is|escolho|minha\s+escolha|elijo|mi\s+elecci[oó]n)\b/.test(folded);
  // Phase 3 batch 16: "drop that decision" and "push X to Y" patterns added
  // for English natural-language paraphrases.
  const action: ChatActionName = isChoose
    ? 'decision_choose'
    // Phase 10 batch 51: imperative "pospón" (with accent → folded
    // "pospon") needs to match without trailing 'a'/'e'. Made the trailing
    // vowel optional: `pospon[ae]?[r]?` matches pospon, pospona, pospone,
    // posponer.
    : /\b(snooze|adia[r]?|aplaza[r]?|pospon[ae]?[r]?|push\s+(?:this|that|the)\s+decision\s+to)\b/.test(folded)
      ? 'decision_snooze'
      : /\b(dismiss|dispens[ae][r]?|ignor[ae]r?|descarta[r]?|drop\s+(?:that|this|the)\s+decision)\b/.test(folded)
        ? 'decision_dismiss'
        : 'decision_follow_up';
  const skill: ChatActionSkill = 'decision_center';
  const args: Record<string, unknown> = { decisionId };
  if (action === 'decision_snooze') args.until = null;
  if (action === 'decision_choose') {
    // Phase 10 batch 51: ES form "opción B" / "la opción B" added. The
    // Spanish article "la" can sit between the verb and "opción".
    const choiceMatch = input.text.match(/\b(?:option|op[cç][aã]o|opci[oó]n)\s*([a-zA-Z0-9]+)/i)
      || input.text.match(/\b(?:choose|chose|pick|escolho|elijo|minha\s+escolha\s+(?:e|é)|mi\s+elecci[oó]n\s+(?:es))\s+(?:(?:option|opci[oó]n|la|el|a)\s+)?([a-zA-Z0-9]+)/i)
      || input.text.match(/\b(?:elig[eo][r]?)\s+(?:la\s+)?(?:opci[oó]n\s+)?([a-zA-Z0-9]+)/i);
    args.choice = choiceMatch?.[1] ?? null;
  }
  return makeStep(input, {
    skill,
    action,
    risk: 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: action === 'decision_choose'
      ? Boolean(decisionId && args.choice)
      : Boolean(decisionId),
  });
}

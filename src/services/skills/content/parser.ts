// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the content skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

import { makeStep, type StepKeyInputs } from '../step-builder';
import { extractTopic, inferContentPlatform } from '../text-extractors';
import type { ChatPlanStep } from '../../chat/types';
import { parseContentPipelineStageTransition } from './pipeline-stage';

export function parseContentActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
): ChatPlanStep | null {
  // Phase 10 batch 51 (2026-05-16): Spanish content vocabulary added —
  // contenido / guion / guión / reescribe / reescribir / publicación /
  // campaña / programa (verb).
  if (!/\b(content|conteudo|contenido|script|roteiro|guion|guión|brief|reel|tiktok|youtube|post|video|publicaci[oó]n|rewrite|reescreve|reescrever|reescribe[r]?|reescritura|pipeline|publica|publish|schedule|programa[r]?|caption|legenda|copy|campa[nñ]a)\b/.test(folded)) return null;
  const platform = inferContentPlatform(folded);
  const topic = extractTopic(input.text) || input.text.trim();

  const pipelineStage = parseContentPipelineStageTransition(input.text);
  if (pipelineStage.targetStage && pipelineStage.topicTitle) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_pipeline_stage_transition',
      risk: 'safe_write',
      provider: 'nexus',
      args: { ...pipelineStage },
      requiredArgsPresent: true,
    });
  }

  // Rewrite: explicit rewrite verb with content/copy object.
  // Phase 3 batch 16: "make this shorter/longer/punchier/simpler" treated as
  // rewrite when the target is a piece of copy. Limits to common copy-edit
  // adjectives to avoid claiming "make this happen" generic requests.
  // Phase 10 batch 51: Spanish "reescribe"/"reescribir"/"reescritura" added.
  // Phase 12 batch 66 (2026-05-16): Spanish single-verb rewrite forms
  // "acorta[r]?"/"alarga[r]?"/"reduce" added (these are shorten/lengthen
  // verbs that imply a rewrite when applied to copy).
  if (/\b(rewrite|reescreve[r]?|reescrita|reescrev[oae]|reescribe[r]?|reescritura|acorta[r]?|alarga[r]?|reduce)\b/.test(folded)
    || /\bmake\s+(?:this|the|that|it)\s+(?:caption|copy|script|brief|reel|post|text|email|message|version)?\s*(?:shorter|longer|punchier|simpler|tighter|crisper|catchier|more\s+\w+)\b/.test(folded)
    || /\b(hacer|hazlo|hacerla|hacerlo)\s+(?:m[aá]s\s+)?(?:corta?|larga?|simple|tighter|crisper|catchier)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_rewrite',
      risk: 'safe_write',
      provider: 'nexus',
      args: { sourceText: input.text, objective: topic },
      requiredArgsPresent: false,
    });
  }

  // Pipeline handoff: handing off a content package downstream. Triggers when
  // the user explicitly references the pipeline as the destination, regardless
  // of where the verb sits relative to "pipeline" — "push the X package to the
  // content pipeline" and "envia o pacote para o pipeline" both match here.
  if (/\b(pipeline\s+handoff|handoff)\b/.test(folded)
    || /\b(push|send|envia[r]?|manda[r]?|mover|move)\b[^.]*\bpipeline\b/.test(folded)
    || /\b(package|pacote)\b[^.]*\bpipeline\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_pipeline_handoff',
      risk: 'safe_write',
      provider: 'nexus',
      args: { packageId: null, rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }

  // Schedule content work: scheduling a piece of content for a date/time.
  // Phase 7 close-out: "queue" added as a content-scheduling verb (common in
  // social-media management vocabulary).
  // Phase 10 batch 51: Spanish "programa"/"publicar" verbs + "contenido"/
  // "guion"/"publicación" nouns added.
  if (/\b(schedule|agenda[r]?|publish|publica[r]?|programa[r]?|queue)\b.*\b(content|conteudo|contenido|reel|tiktok|video|post|script|roteiro|guion|guión|publicaci[oó]n)\b/.test(folded)
    || /\b(content|conteudo|contenido|video|reel|post|script|roteiro|guion|guión|publicaci[oó]n)\b.*\b(schedule|agenda[r]?|publish|publica[r]?|programa[r]?|queue)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_schedule_work',
      risk: 'safe_write',
      provider: 'nexus',
      args: { title: topic, dateTime: null, rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }

  if (/\b(script|roteiro|guion|guión)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_script_create',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        topic,
        platform,
        format: platform === 'youtube' ? 'long_form_video' : platform === 'carousel' ? 'carousel' : 'short_form_video',
        objective: 'Create a usable creator script from chat.',
      },
      requiredArgsPresent: Boolean(topic && platform !== 'generic'),
    });
  }
  if (/\b(brief|campanha|campaign|campa[nñ]a|ideia|idea|conteudo|content|contenido)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_brief_create',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        objective: topic,
        goal: topic,
        platform,
        format: platform === 'youtube' ? 'long_form_video' : platform === 'carousel' ? 'carousel' : 'short_form_video',
        audience: null,
      },
      requiredArgsPresent: Boolean(topic && platform !== 'generic'),
    });
  }
  return null;
}

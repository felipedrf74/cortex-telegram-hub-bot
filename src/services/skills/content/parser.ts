// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the content skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

import { makeStep, type StepKeyInputs } from '../step-builder';
import { extractTopic, inferContentPlatform } from '../text-extractors';
import type { ChatPlanStep } from '../../chat/types';
import {
  parseContentPipelineStageTransition,
  parseContentPublicationTrackingRequest,
} from './pipeline-stage';
import { extractContentScheduleDateTime, extractContentScheduleTitle } from './datetime';
import { extractInlineContentRewrite } from './rewrite';

export function parseContentActionStep(
  input: StepKeyInputs & { text: string; timezone?: string; nowIso?: string },
  folded: string,
): ChatPlanStep | null {
  const publicationTracking = parseContentPublicationTrackingRequest(input.text);
  if (publicationTracking.targetStage && publicationTracking.topicTitle) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_publish_now',
      risk: 'ambiguous',
      provider: 'none',
      args: {
        publicationRequest: input.text,
        requestedMode: 'track_publication',
        rejectionReason: 'content_publication_tracking_not_supported',
      },
      requiredArgsPresent: false,
    });
  }

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

  // Phase 10 batch 51 (2026-05-16): Spanish content vocabulary added —
  // contenido / guion / guión / reescribe / reescribir / publicación /
  // campaña / programa (verb).
  if (!/\b(content|conteudo|contenido|script|roteiro|guion|guión|brief|reel|tiktok|youtube|post|postar|postea[r]?|upload|subir|queue|video|publicaci[oó]n|rewrite|reescreve|reescrever|reescribe[r]?|reescritura|pipeline|publica|publish|published|posted|schedule|programa[r]?|filming|recording|writing|editing|shoot|session|block|grava[cç][aã]o|filmagem|escrita|edi[cç][aã]o|sesi[oó]n|bloque|caption|legenda|copy|campa[nñ]a)\b/.test(folded)) return null;
  const platform = inferContentPlatform(folded);
  const topic = extractTopic(input.text) || input.text.trim();

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
    const rewrite = extractInlineContentRewrite(input.text);
    return makeStep(input, {
      skill: 'content',
      action: 'content_rewrite',
      risk: 'safe_write',
      provider: 'nexus',
      args: { ...rewrite },
      requiredArgsPresent: Boolean(rewrite.sourceText && rewrite.objective),
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

  const hasScheduleVerb = /\b(schedule|agenda[r]?|programa[r]?|queue)\b/.test(folded);
  const hasPublicationVerb = /\b(publish|publica[r]?|post|postar|postea[r]?|upload|subir|queue)\b/.test(folded);
  const hasPublishableObject = /\b(content|conteudo|contenido|reel|tiktok|video|post|script|roteiro|guion|guión|publicaci[oó]n)\b/.test(folded);
  const hasWorkNoun = /\b(content\s+work|filming|recording|writing|editing|shoot|session|work\s+block|grava[cç][aã]o|filmagem|escrita|edi[cç][aã]o|sess[aã]o|bloco|rodaje|grabaci[oó]n|escritura|edici[oó]n|sesi[oó]n|bloque)\b/.test(folded);
  const asksToCausePublishedState = /\b(?:get|have|make|move|send|deixa[r]?|faz(?:er)?|poner|haz|mueve)\b.*\b(?:published|posted|uploaded|live|publicad[oa]|publicado|subid[oa]|en\s+vivo)\b/.test(folded);

  if (
    (hasPublicationVerb && hasPublishableObject && !hasWorkNoun)
    || (hasScheduleVerb && hasPublishableObject && !hasWorkNoun)
    || asksToCausePublishedState
  ) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_publish_now',
      risk: 'ambiguous',
      provider: 'none',
      args: {
        publicationRequest: input.text,
        requestedMode: hasScheduleVerb ? 'schedule_publication' : 'publish_now',
        rejectionReason: 'content_publication_execution_not_supported',
      },
      requiredArgsPresent: false,
    });
  }

  // Local work-target compatibility. This does not create a Calendar event or
  // execute publication; the explicit work noun prevents semantic confusion.
  if (hasScheduleVerb && hasWorkNoun && hasPublishableObject) {
    const dateTime = extractContentScheduleDateTime(input.text, {
      timezone: input.timezone || 'UTC',
      nowIso: input.nowIso,
    });
    const title = extractContentScheduleTitle(input.text, topic);
    return makeStep(input, {
      skill: 'content',
      action: 'content_schedule_work',
      risk: 'safe_write',
      provider: 'nexus',
      args: { title, dateTime, rawRequest: input.text },
      requiredArgsPresent: Boolean(title && dateTime),
    });
  }

  if (/\b(script|roteiro|guion|guión)\b/.test(folded)) {
    const contentPlatform = platform === 'generic' ? null : platform;
    return makeStep(input, {
      skill: 'content',
      action: 'content_script_create',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        topic,
        platform: contentPlatform,
        format: platform === 'youtube' ? 'long_form_video' : platform === 'carousel' ? 'carousel' : 'short_form_video',
        objective: 'Create a usable creator script from chat.',
      },
      requiredArgsPresent: Boolean(topic && contentPlatform),
    });
  }
  if (/\b(brief|campanha|campaign|campa[nñ]a|ideia|idea|conteudo|content|contenido)\b/.test(folded)) {
    const contentPlatform = platform === 'generic' ? null : platform;
    return makeStep(input, {
      skill: 'content',
      action: 'content_brief_create',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        objective: topic,
        goal: topic,
        platform: contentPlatform,
        format: platform === 'youtube' ? 'long_form_video' : platform === 'carousel' ? 'carousel' : 'short_form_video',
        audience: null,
      },
      requiredArgsPresent: Boolean(topic && contentPlatform),
    });
  }
  return null;
}

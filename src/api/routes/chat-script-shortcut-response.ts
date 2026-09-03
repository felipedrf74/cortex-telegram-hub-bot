// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ScriptResponse } from '../../services/content-engine';
import { sanitizeScriptBody } from './chat-content-refinement';
import { analyzeAndImproveScript, buildScriptPreflightBrief } from '../../services/content-script-quality';

export type ChatScriptShortcutLanguage = 'pt-BR' | 'pt-PT' | 'en-US';
export type ChatScriptShortcutFormat = 'Reel' | 'YouTube';

type BrandVoiceReader = (
  category: string,
  userId: number,
  tenantId: number,
) => { synthesized_text?: string | null } | null | undefined;

export function getUserBrandVoiceForChatScript(
  userId: number,
  tenantId: number,
  readKnowledgeByCategory?: BrandVoiceReader,
): string | null {
  try {
    const reader = readKnowledgeByCategory ?? require('../../state/content-references').getKnowledgeByCategory;
    const row = reader('brand_voice', userId, tenantId);
    return row?.synthesized_text || null;
  } catch {
    return null;
  }
}

export function localizeScriptWarning(
  warning: string,
  language: ChatScriptShortcutLanguage,
): string {
  if (language === 'en-US') {
    return warning;
  }

  const lower = warning.trim().toLowerCase();
  if (lower === 'ai synthesis was unavailable; returning search-based fallback briefs.') {
    return 'A síntese por IA ficou indisponível; devolvi uma versão degradada baseada na pesquisa disponível.';
  }

  if (lower === 'ai generation was unavailable; returned a templated degraded script grounded in the available research.') {
    return 'A geração do roteiro por IA ficou indisponível; devolvi uma versão conservadora baseada na pesquisa disponível.';
  }

  if (lower === 'no strong research sources were found; returning conservative fallback briefs.') {
    return 'Não encontrei fontes de pesquisa suficientemente fortes; devolvi uma versão conservadora.';
  }

  if (lower === 'content engine unavailable') {
    return 'O motor de conteúdo está temporariamente indisponível.';
  }

  return warning;
}

export function buildScriptShortcutText(
  result: ScriptResponse,
  language: ChatScriptShortcutLanguage,
  format: ChatScriptShortcutFormat,
): string {
  const isPT = language.startsWith('pt');
  const sections: string[] = [];
  const inputScript = sanitizeScriptBody(result.script || '');
  const scriptQuality = analyzeAndImproveScript({
    topic: result.topic,
    script: inputScript,
    hook: result.hook,
    titleOptions: result.title_options,
    cta: result.cta,
    sources: result.sources_used,
    format,
    preflightBrief: buildScriptPreflightBrief({
      topic: result.topic,
      format,
      language,
      cta: result.cta,
      sources: result.sources_used,
    }),
  });
  if (scriptQuality.blockers.length > 0) {
    if (language === 'en-US') {
      return 'I withheld this script because the generated response contained unsafe or internal output. Please try again.';
    }
    if (language === 'pt-PT') {
      return 'Ocultei este roteiro porque a resposta gerada continha conteúdo inseguro ou interno. Tenta novamente.';
    }
    return 'Ocultei este roteiro porque a resposta gerada continha conteúdo inseguro ou interno. Tenta de novo.';
  }
  // Script quality is advisory. The chat presentation may sanitize metadata,
  // but it must not substitute the engine output with a bounded quality
  // scaffold.
  const sanitizedScript = makeChatSafeScriptText(inputScript, isPT);
  const normalizedScript = sanitizedScript || result.hook?.trim() || '';
  const normalizedCta = (result.cta || scriptQuality.structuredOutput.cta)?.trim() || '';
  const lowerScript = normalizedScript.toLowerCase();

  if (result.degraded) {
    const localizedWarnings = Array.isArray(result.warnings)
      ? Array.from(new Set(result.warnings.map((warning) => localizeScriptWarning(warning, language)).filter(Boolean)))
      : [];
    const warnings = localizedWarnings.length > 0
      ? ` ${isPT ? 'Motivos' : 'Reasons'}: ${localizedWarnings.join(' · ')}`
      : '';
    sections.push(
      isPT
        ? `Aviso: este roteiro foi gerado em modo degradado.${warnings}`
        : `Note: this script was generated in degraded mode.${warnings}`,
    );
  }

  const header = isPT
    ? `${format === 'Reel' ? 'Roteiro curto' : 'Roteiro'} • Duração estimada: ${result.estimated_duration}`
    : `${format === 'Reel' ? 'Short script' : 'Script'} • Estimated duration: ${result.estimated_duration}`;
  sections.push(header);

  if (normalizedScript) {
    sections.push(normalizedScript);
  }

  if (normalizedCta && !lowerScript.includes(normalizedCta.toLowerCase())) {
    sections.push(isPT ? `Fecho sugerido: ${normalizedCta}` : `Suggested closing line: ${normalizedCta}`);
  }

  return sections.filter(Boolean).join('\n\n');
}

function makeChatSafeScriptText(script: string, isPT: boolean): string {
  const closingLabel = isPT ? 'FECHO SUGERIDO:' : 'SUGGESTED CLOSING LINE:';
  const nextActionText = isPT ? 'próxima ação' : 'next action';
  return script
    .replace(/^CTA:\s*$/gim, closingLabel)
    .replace(/^(\d+\.\s*)CTA:\s*/gim, `$1${closingLabel} `)
    .replace(/\bCTA\b/g, nextActionText);
}

export function buildScriptUnavailableResponse(language: ChatScriptShortcutLanguage): string {
  if (language === 'en-US') {
    return 'I could not generate the structured script right now because the content engine is temporarily unavailable. Please try again in a minute.';
  }
  if (language === 'pt-PT') {
    return 'Não consegui gerar o roteiro estruturado agora porque o motor de conteúdo está temporariamente indisponível. Tenta novamente dentro de um minuto.';
  }
  return 'Não consegui gerar o roteiro estruturado agora porque o motor de conteúdo está temporariamente indisponível. Tenta de novo em um minuto.';
}

export function buildScriptShortcutMetadata(
  result: ScriptResponse,
  format: ChatScriptShortcutFormat,
): Record<string, unknown> {
  const sources = Array.isArray(result.sources_used) ? result.sources_used : [];
  const scriptQuality = analyzeAndImproveScript({
    topic: result.topic,
    script: result.script || '',
    hook: result.hook,
    titleOptions: result.title_options,
    cta: result.cta,
    sources,
    format,
  });

  if (scriptQuality.blockers.length > 0) {
    return {
      type: 'content_script_blocked',
      format,
      blocked: true,
      displayWithheld: true,
      retryable: true,
      reasonCodes: scriptQuality.blockers,
    };
  }

  return {
    type: 'content_script',
    topic: result.topic,
    format,
    hook: result.hook,
    titleOptions: result.title_options ?? [],
    hashtags: result.hashtags ?? [],
    caption: result.caption ?? '',
    cta: result.cta ?? '',
    estimatedDuration: result.estimated_duration,
    degraded: result.degraded ?? false,
    warnings: result.warnings ?? [],
    scriptQuality: {
      hookScore: scriptQuality.hookScore,
      retentionScore: scriptQuality.retentionScore,
      proofScore: scriptQuality.proofScore,
      platformFitScore: scriptQuality.platformFitScore,
      voiceFitScore: scriptQuality.voiceFitScore,
      ctaScore: scriptQuality.ctaScore,
      structureScore: scriptQuality.structureScore,
      overallScore: scriptQuality.overallScore,
      complianceWarnings: scriptQuality.complianceWarnings,
      revisionActions: scriptQuality.revisionActions,
      suggestedActions: scriptQuality.revisionActions,
      appliedChanges: [],
      blockers: scriptQuality.blockers,
    },
    sourcesUsed: sources.map((source) => ({
      title: source.title,
      url: source.url,
      sourceType: source.source_type,
      relevanceNote: source.relevance_note,
    })),
  };
}

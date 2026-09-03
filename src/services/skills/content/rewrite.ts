// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface ContentRewriteSlots {
  sourceText: string | null;
  objective: string | null;
}

const REWRITE_SOURCE_LABEL = '(?:source(?:\\s+text)?|original(?:\\s+(?:copy|text))?|texto(?:\\s+(?:fonte|original))?|contenido\\s+original)';
const REWRITE_OBJECTIVE_LABEL = '(?:objective|goal|rewrite\\s+goal|objetivo)';

export function extractInlineContentRewrite(text: string): ContentRewriteSlots {
  const labeledSource = extractLabeledRewriteValue(text, REWRITE_SOURCE_LABEL, REWRITE_OBJECTIVE_LABEL);
  const labeledObjective = extractLabeledRewriteValue(text, REWRITE_OBJECTIVE_LABEL, REWRITE_SOURCE_LABEL);
  if (labeledSource || labeledObjective) {
    return {
      sourceText: normalizeInlineRewriteSource(labeledSource),
      objective: normalizeInlineRewriteObjective(labeledObjective),
    };
  }

  const quoted = extractQuotedRewriteSource(text);
  if (quoted) {
    return {
      sourceText: normalizeInlineRewriteSource(quoted.sourceText),
      objective: normalizeInlineRewriteObjective(`${quoted.before} ${quoted.after}`),
    };
  }

  const separated = splitInlineRewriteInstruction(text);
  if (!separated) return { sourceText: null, objective: normalizeInlineRewriteObjective(text) };
  return {
    sourceText: normalizeInlineRewriteSource(separated.sourceText),
    objective: normalizeInlineRewriteObjective(separated.instruction),
  };
}

function extractLabeledRewriteValue(text: string, label: string, nextLabel: string): string | null {
  const match = text.match(new RegExp(
    `(?:^|\\n)\\s*${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*${nextLabel}\\s*:|$)`,
    'i',
  ));
  return match?.[1]?.trim() || null;
}

function extractQuotedRewriteSource(text: string): {
  before: string;
  sourceText: string;
  after: string;
} | null {
  const quotePatterns = [
    /"([^"\n]+)"/,
    /“([^”\n]+)”/,
    /'([^'\n]+)'/,
    /‘([^’\n]+)’/,
  ];
  for (const pattern of quotePatterns) {
    const match = pattern.exec(text);
    if (!match?.[1] || match.index == null) continue;
    return {
      before: text.slice(0, match.index),
      sourceText: match[1],
      after: text.slice(match.index + match[0].length),
    };
  }
  return null;
}

function splitInlineRewriteInstruction(text: string): {
  instruction: string;
  sourceText: string;
} | null {
  const newlineIndex = text.search(/\r?\n/);
  const colonIndex = text.indexOf(':');
  const dashIndex = text.search(/\s(?:—|---)\s/);
  const indexes = [newlineIndex, colonIndex, dashIndex].filter((index) => index >= 0);
  if (indexes.length === 0) return null;
  const separatorIndex = Math.min(...indexes);
  const separatorLength = separatorIndex === newlineIndex
    ? text.slice(separatorIndex).match(/^\r?\n/)?.[0].length ?? 1
    : separatorIndex === dashIndex
      ? text.slice(separatorIndex).match(/^\s(?:—|---)\s/)?.[0].length ?? 1
      : 1;
  return {
    instruction: text.slice(0, separatorIndex).trim(),
    sourceText: text.slice(separatorIndex + separatorLength).trim(),
  };
}

function normalizeInlineRewriteSource(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^(["'“‘])([\s\S]*)(["'”’])$/, '$2').trim();
  if (normalized.length < 3) return null;
  if (/^(?:(?:this|that|it|the|este|esta|esse|essa|isto|isso|ese|esa|eso)|(?:(?:this|that|the|este|esta|esse|essa|ese|esa)\s+)?(?:(?:following|seguinte|siguiente)\s+)?(?:caption|copy|script|brief|reel|post|text|texto|legenda|roteiro|guion|gui[oó]n))$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeInlineRewriteObjective(value: string | null): string | null {
  if (!value) return null;
  const folded = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const impliedObjective = /\b(?:acorta[r]?|reduce|shorten)\b/.test(folded)
    ? 'Make the supplied content shorter.'
    : /\b(?:alarga[r]?|lengthen)\b/.test(folded)
      ? 'Make the supplied content longer.'
      : null;
  const normalized = value
    .replace(/^\s*(?:please\s+|por\s+favor\s+)?(?:rewrite|reescreve[r]?|reescrita|reescrev[oae]|reescribe[r]?|reescritura|acorta[r]?|alarga[r]?|reduce|make)\b/i, '')
    .replace(/^\s*(?:(?:this|the|that|it|este|esta|esse|essa|isto|isso|ese|esa|eso)\s+)?(?:(?:following|seguinte|siguiente)\s+)?(?:caption|copy|script|brief|reel|post|text|email|message|version|legenda|roteiro|guion|gui[oó]n|texto)?\s*/i, '')
    .replace(/^\s*(?:to\s+(?:be|make\s+it)?|so\s+(?:it|the\s+copy)\s+(?:is|becomes)|para|pra|para\s+(?:ficar|ser|fazer(?:la|lo)?)|pra\s+(?:ficar|ser)|como|in|with|em|com|en|con)\s*/i, '')
    .replace(/^\s*(?:be|ficar|ser|hacer(?:la|lo)?)\s+/i, '')
    .replace(/[\s:;,.!?-]+$/g, '')
    .trim();
  if (!normalized) return impliedObjective;
  if (/^(?:this|that|it|caption|copy|script|brief|reel|post|text|legenda|roteiro|guion|gui[oó]n|texto)$/i.test(normalized)) {
    return impliedObjective;
  }
  return normalized.length >= 3 ? normalized : impliedObjective;
}

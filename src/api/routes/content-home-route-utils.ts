// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../../services/database';
import {
  CONTENT_WORKSPACE_SCHEMA_VERSION,
  listContentWorkspaceItems,
  type ContentNextAction,
  type ContentWorkspaceItem,
} from '../../services/content-workspace';
import type { AgentSignal } from '../../services/intelligence-bus';
import type { Lang } from '../../utils/i18n';

const CONTENT_COMPATIBILITY_ITEM_LIMIT = 200;

export type ContentCompatibilityStage = 'ideas' | 'scripted' | 'published';

export interface ContentCompatibilityItem {
  id: string;
  title: string;
  summary: string | null;
  score: null;
  createdAt: string;
  updatedAt: string;
  stage: ContentCompatibilityStage;
  nextAction: ContentNextAction;
  workspace: {
    productionState: ContentWorkspaceItem['productionState'];
    artifactPhase: ContentWorkspaceItem['artifactPhase'];
    workflowVersion: number;
    currentArtifactId: number | null;
  };
}

export interface ContentCompatibilityProjection {
  schemaVersion: typeof CONTENT_WORKSPACE_SCHEMA_VERSION;
  items: ContentCompatibilityItem[];
  stages: {
    ideas: ContentCompatibilityItem[];
    scripted: ContentCompatibilityItem[];
    filmed: ContentCompatibilityItem[];
    editing: ContentCompatibilityItem[];
    published: ContentCompatibilityItem[];
  };
  coverage: {
    itemLimit: number;
    itemWindowMayBeTruncated: boolean;
    publishedWindowLimit: number;
    publishedWindowMayBeTruncated: boolean;
  };
}

export function readContentCompatibilityProjection(
  db: ReturnType<typeof getDb>,
  userId: number,
  tenantId: number,
): ContentCompatibilityProjection {
  const workspaceItems = listContentWorkspaceItems({
    scope: { tenantId, userId },
    itemType: 'content_item',
    limit: CONTENT_COMPATIBILITY_ITEM_LIMIT,
  }, db);
  const items = workspaceItems.map(projectWorkspaceItem);
  const ideas = items.filter((item) => item.stage === 'ideas');
  const scripted = items.filter((item) => item.stage === 'scripted');
  const allPublished = items.filter((item) => item.stage === 'published');
  const publishedWindowLimit = 10;

  return {
    schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
    items,
    stages: {
      ideas,
      scripted,
      filmed: [],
      editing: [],
      published: allPublished.slice(0, publishedWindowLimit),
    },
    coverage: {
      itemLimit: CONTENT_COMPATIBILITY_ITEM_LIMIT,
      itemWindowMayBeTruncated: workspaceItems.length === CONTENT_COMPATIBILITY_ITEM_LIMIT,
      publishedWindowLimit,
      publishedWindowMayBeTruncated: allPublished.length > publishedWindowLimit,
    },
  };
}

export function readContentHomePipeline(db: ReturnType<typeof getDb>, userId: number, tenantId?: number): {
  stages: {
    ideas: Array<{ title: string }>;
    scripted: Array<{ title: string }>;
    filmed: Array<{ title: string }>;
    editing: Array<{ title: string }>;
    published: Array<{ title: string }>;
  };
} {
  const projection = readContentCompatibilityProjection(db, userId, requireTenantId(tenantId));
  return { stages: projection.stages };
}

export function readContentHomeIdeas(
  db: ReturnType<typeof getDb>,
  userId: number,
  tenantId?: number,
): Array<{ title: string }> {
  return readContentCompatibilityProjection(db, userId, requireTenantId(tenantId)).stages.ideas;
}

export function readContentPublishedThisMonth(
  db: ReturnType<typeof getDb>,
  userId: number,
  tenantId: number,
  now: Date = new Date(),
): { count: number; windowStart: string; windowEnd: string; source: 'content_workflow_events' } {
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const row = db.prepare(`
    SELECT COUNT(DISTINCT object_id) AS count
      FROM content_workflow_events
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
       AND object_type = 'content_item'
       AND action = 'workspace_state_changed'
       AND to_state = 'published'
       AND datetime(created_at) >= datetime(?)
       AND datetime(created_at) < datetime(?)
  `).get(tenantId, userId, windowStart.toISOString(), windowEnd.toISOString()) as { count: unknown } | undefined;
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Content published metric returned an invalid count.');
  }
  return {
    count,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    source: 'content_workflow_events',
  };
}

function projectWorkspaceItem(item: ContentWorkspaceItem): ContentCompatibilityItem {
  const stage: ContentCompatibilityStage = item.productionState === 'published'
    ? 'published'
    : ['idea', 'brief', 'outline'].includes(item.artifactPhase)
      ? 'ideas'
      : 'scripted';
  return {
    id: String(item.id),
    title: item.title,
    summary: item.summary,
    score: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    stage,
    nextAction: item.nextAction,
    workspace: {
      productionState: item.productionState,
      artifactPhase: item.artifactPhase,
      workflowVersion: item.workflowVersion,
      currentArtifactId: item.currentArtifactId,
    },
  };
}

function requireTenantId(tenantId: number | undefined): number {
  if (!Number.isInteger(tenantId) || Number(tenantId) <= 0) {
    throw new Error('A valid tenant scope is required for Content workspace reads.');
  }
  return Number(tenantId);
}

export function summarizeContentJobStatus(
  lastResult: 'success' | 'failed' | 'running' | 'never' | undefined,
  signalCount: number,
): 'ready' | 'degraded' | 'syncing' | 'warming_up' {
  if (lastResult === 'failed') return 'degraded';
  if (lastResult === 'running') return 'syncing';
  if (signalCount > 0 || lastResult === 'success') return 'ready';
  return 'warming_up';
}

export function summarizeOptimizationStatus(
  performanceResult: 'success' | 'failed' | 'running' | 'never' | undefined,
  autoresearchResult: 'success' | 'failed' | 'running' | 'never' | undefined,
  insightCount: number,
): 'ready' | 'degraded' | 'syncing' | 'warming_up' {
  if (performanceResult === 'failed' || autoresearchResult === 'failed') return 'degraded';
  if (performanceResult === 'running' || autoresearchResult === 'running') return 'syncing';
  if (insightCount > 0 || performanceResult === 'success' || autoresearchResult === 'success') return 'ready';
  return 'warming_up';
}

export function formatSignalDigest(signal: AgentSignal, language: Lang): {
  id: number;
  type: string;
  title: string;
  summary: string;
  priority: string;
  createdAt: string;
} {
  return {
    id: signal.id,
    type: signal.signal_type,
    title: buildSignalTitle(signal, language),
    summary: buildSignalSummary(signal, language),
    priority: signal.priority,
    createdAt: signal.created_at,
  };
}

export function buildSignalTitle(signal: AgentSignal, language: Lang): string {
  const titleLike = firstText(
    signal.payload.title,
    signal.payload.topic,
    signal.payload.keyword,
    signal.payload.channel,
    signal.payload.pillar,
    signal.payload.summary,
  );
  if (titleLike) {
    return localizeSignalTitle(titleLike, signal.signal_type, language);
  }

  const fallbackTitles: Record<string, { en: string; pt: string }> = {
    reaction_opportunity: { en: 'Reaction opportunity', pt: 'Janela de reação' },
    trending_spike: { en: 'Trending spike', pt: 'Subida de tendência' },
    competitor_upload: { en: 'Competitor move', pt: 'Movimento da concorrência' },
    hook_effectiveness: { en: 'Hook performance', pt: 'Performance dos hooks' },
    pillar_performance: { en: 'Pillar performance', pt: 'Performance do pilar' },
    learning_digest: { en: 'Weekly learning', pt: 'Aprendizagem semanal' },
    creator_learning_digest: { en: 'Your weekly learning', pt: 'A tua aprendizagem semanal' },
    content_formula: { en: 'Winning format', pt: 'Formato vencedor' },
  };
  const fallback = fallbackTitles[signal.signal_type];
  return fallback ? (language.startsWith('pt') ? fallback.pt : fallback.en) : humanizeSignalType(signal.signal_type);
}

export function buildSignalSummary(signal: AgentSignal, language: Lang): string {
  const summary = firstText(
    signal.payload.summary,
    signal.payload.reason,
    signal.payload.description,
    signal.payload.observation,
    signal.payload.note,
  );
  if (summary) {
    return localizeSignalSummary(summary, signal.signal_type, signal.payload, language);
  }

  switch (signal.signal_type) {
    case 'reaction_opportunity':
      return localizePortugueseVariant(
        language,
        'Há uma janela curta para reagir com velocidade e contexto.',
        'Há uma janela curta para reagir com velocidade e contexto.',
        'There is a short reaction window worth moving on quickly.',
      );
    case 'trending_spike':
      return localizePortugueseVariant(
        language,
        'O tema está a ganhar velocidade e merece atenção.',
        'O tema está ganhando velocidade e merece atenção.',
        'This topic is accelerating and deserves attention.',
      );
    case 'competitor_upload':
      return localizePortugueseVariant(
        language,
        'Um canal comparável publicou agora, o que pode abrir espaço para resposta.',
        'Um canal comparável publicou agora, o que pode abrir espaço para resposta.',
        'A comparable channel just published, which may open a response angle.',
      );
    case 'hook_effectiveness':
      return localizePortugueseVariant(
        language,
        'Há um padrão recente sobre o que está a segurar melhor a audiência.',
        'Há um padrão recente sobre o que está segurando melhor a audiência.',
        'There is a recent pattern in what is holding attention better.',
      );
    case 'pillar_performance':
      return localizePortugueseVariant(
        language,
        'Um dos teus pilares está a ganhar mais tração do que os restantes.',
        'Um dos seus pilares está ganhando mais tração do que os demais.',
        'One of your pillars is outperforming the rest right now.',
      );
    case 'learning_digest':
    case 'creator_learning_digest':
      return localizePortugueseVariant(
        language,
        'Há uma síntese recente do que está a funcionar e do que precisa de ajuste.',
        'Há uma síntese recente do que está funcionando e do que precisa de ajuste.',
        'There is a recent summary of what is working and what needs adjustment.',
      );
    case 'content_formula':
      return localizePortugueseVariant(
        language,
        'Um formato repetível está a emergir nos teus resultados recentes.',
        'Um formato repetível está surgindo nos seus resultados recentes.',
        'A repeatable format is emerging from recent results.',
      );
    default:
      return localizePortugueseVariant(
        language,
        'Sinal recente do teu sistema de conteúdo.',
        'Sinal recente do seu sistema de conteúdo.',
        'Recent signal from your content system.',
      );
  }
}

export function localizeVoiceEntryLabel(label: string, language: Lang): string {
  if (!language.startsWith('pt')) return label;

  const labels: Record<string, string> = {
    'Hook Styles': 'Estilos de hook',
    'Title Patterns': 'Padrões de título',
    'Content Structure': 'Estrutura de conteúdo',
    'Editing Style': 'Estilo de edição',
    'Storytelling': 'Storytelling',
    'CTA Patterns': 'Padrões de CTA',
    'Audience Engagement': 'Envolvimento da audiência',
    'Visual Branding': 'Marca visual',
    'Brand Voice': 'Voz da marca',
    'Additions (Voice Evolution)': 'Adições (Evolução de voz)',
    'Removals (Voice Evolution)': 'Remoções (Evolução de voz)',
    'Rephrasings (Voice Evolution)': 'Reformulações (Evolução de voz)',
    'Book Influence': 'Influência de livros',
    'Voice Summary': 'Resumo da voz',
  };
  return labels[label] ?? label;
}

export function localizeKnowledgeCategoryLabel(
  category: string,
  voiceEntries: Array<{ category: string; label: string }>,
  language: Lang,
): string {
  const matchingEntry = voiceEntries.find((entry) => entry.category === category);
  if (matchingEntry) {
    return localizeVoiceEntryLabel(matchingEntry.label, language);
  }
  return localizeVoiceEntryLabel(humanizeSignalType(category), language);
}

export function firstText(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

export function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function localizePortugueseVariant(language: Lang, portugal: string, brazil: string, english: string): string {
  if (language === 'pt-BR') return brazil;
  if (language.startsWith('pt')) return portugal;
  return english;
}

function localizeSignalTitle(title: string, signalType: string, language: Lang): string {
  const trimmed = title.trim();
  if (!language.startsWith('pt')) {
    const englishMap: Record<string, string> = {
      'Performance dos hooks': 'Hook performance',
      'Performance do pilar': 'Pillar performance',
      'Aprendizagem semanal': 'Weekly learning',
      'Formato vencedor': 'Winning format',
      'Janela de reação': 'Reaction opportunity',
      'Subida de tendência': 'Trending spike',
      'Movimento da concorrência': 'Competitor move',
      'Treino': 'Training',
      'Recuperação': 'Recovery',
    };
    if (/^(training|fitness)$/i.test(trimmed)) {
      return signalType === 'content_formula' ? 'Winning format' : 'Training';
    }
    return englishMap[trimmed] ?? trimmed;
  }
  switch (signalType) {
    case 'pillar_performance':
      return /^(training|fitness)$/i.test(trimmed) ? 'Treino' : trimmed;
    case 'content_formula':
      return /^fitness$/i.test(trimmed) ? 'Formato vencedor' : trimmed;
    default:
      return trimmed;
  }
}

function localizeSignalSummary(summary: string, signalType: string, payload: Record<string, any>, language: Lang): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return trimmed;

  if (!language.startsWith('pt')) {
    switch (signalType) {
      case 'reaction_opportunity':
        return trimmed.replace(/^Janela de reação ativa:\s*/i, 'Reaction window: ');
      case 'trending_spike':
        return trimmed.replace(/^Sinal de tendência:\s*/i, 'Trending signal: ');
      case 'competitor_upload':
        return trimmed.replace(/^Movimento recente da concorrência:\s*/i, 'Competitor move: ');
      case 'hook_effectiveness':
        return trimmed.replace(/^Lição de hook:\s*/i, 'Hook learning: ');
      case 'pillar_performance':
        return trimmed
          .replace(/^Performance de\s+/i, 'Performance for ')
          .replace(/^Performance do\s+/i, 'Performance for ');
      case 'learning_digest':
      case 'creator_learning_digest':
        return trimmed.replace(/^Aprendizagem recente:\s*/i, 'Recent learning: ');
      case 'content_formula':
        return trimmed.replace(/^Formato a repetir:\s*/i, 'Repeatable format: ');
      default:
        return trimmed;
    }
  }

  switch (signalType) {
    case 'reaction_opportunity':
      return `Janela de reação ativa: ${trimmed}`;
    case 'trending_spike':
      return `Sinal de tendência: ${trimmed}`;
    case 'competitor_upload':
      return `Movimento recente da concorrência: ${trimmed}`;
    case 'hook_effectiveness':
      return `Lição de hook: ${trimmed}`;
    case 'pillar_performance': {
      const pillar = firstText(payload.pillar) ?? 'este pilar';
      const localizedPillar = /^training$/i.test(pillar) ? 'Treino' : pillar;
      return `Performance de ${localizedPillar}: ${trimmed}`;
    }
    case 'learning_digest':
    case 'creator_learning_digest':
      return `Aprendizagem recente: ${trimmed}`;
    case 'content_formula':
      return `Formato a repetir: ${trimmed}`;
    default:
      return trimmed;
  }
}

function humanizeSignalType(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

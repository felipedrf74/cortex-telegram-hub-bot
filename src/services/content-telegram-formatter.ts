// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram-specific content formatters — LEGACY TRANSPORT LAYER.
 *
 * These functions convert structured response types from content-engine.ts
 * into Telegram HTML strings (<b>, <i>, <code>, <a>). They are the ONLY
 * place in the codebase where content data is formatted for Telegram.
 *
 * New surfaces (iOS API, portal) use the raw response types directly.
 * These formatters exist only for archived Telegram delivery compatibility;
 * Telegram inbound command handlers have been removed.
 *
 * @deprecated — This file will be removed when Telegram support is
 *   fully deprecated. Do NOT add new formatters here. Instead, ensure
 *   your content service returns a structured response type and let
 *   each transport surface render it natively.
 *
 * Moved from content-engine.ts (April 2026) to enforce the transport
 * boundary: core content services return data, not presentation.
 */

import type {
  DeepSearchResponse,
  SourcesResponse,
  HotNewsResponse,
  TrendingResponse,
  ReactionResponse,
  HooksResponse,
  ScriptResponse,
  TitlesResponse,
  ThumbnailResponse,
  CaptionResponse,
  CompetitorResponse,
  GapsResponse,
  SeoResponse,
  RepurposeResponse,
  FeedbackResponse,
  ReportResponse,
} from './content-engine';

// ── Helpers (private to this module) ────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Phase 1: Core Formatters ────────────────────────────────────────

export function formatDeepSearch(res: DeepSearchResponse): string {
  let msg = `🔬 <b>DEEP SEARCH: "${escapeHtml(res.query)}"</b>\n`;
  msg += `<i>${res.briefs.length} content ideas · ${res.search_count} sources scanned · ${res.duration_ms}ms</i>\n\n`;

  if (res.briefs.length > 0 && res.briefs[0].why_now.includes('RESUMO:')) {
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 <b>RESEARCH BRIEFING</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    const sections = res.briefs[0].why_now.split('\n\n');
    // nx-allow-identity-scan: backward-compat parser for deep-search briefings stored before creator-neutral labels.
    const legacyCreatorAnglePrefix = 'ÂNGULO DO FELIPE:';
    const creatorAnglePrefixes = ['SEU ÂNGULO:', 'ÂNGULO DO CRIADOR:', 'ÂNGULO DA CRIADORA:', legacyCreatorAnglePrefix];
    for (const section of sections) {
      if (section.startsWith('RESUMO:')) {
        msg += `${escapeHtml(section.replace('RESUMO: ', ''))}\n\n`;
      } else if (section.startsWith('FATOS-CHAVE:')) {
        msg += `<b>📌 FATOS-CHAVE</b>\n`;
        const facts = section.split('\n').slice(1);
        for (const f of facts) msg += `${escapeHtml(f)}\n`;
        msg += '\n';
      } else if (section.startsWith('ARGUMENTOS A FAVOR:')) {
        msg += `<b>✅ ARGUMENTOS A FAVOR</b>\n`;
        const args = section.split('\n').slice(1);
        for (const a of args) msg += `${escapeHtml(a)}\n`;
        msg += '\n';
      } else if (section.startsWith('CONTRA-ARGUMENTOS:')) {
        msg += `<b>⚔️ CONTRA-ARGUMENTOS</b>\n`;
        const args = section.split('\n').slice(1);
        for (const a of args) msg += `${escapeHtml(a)}\n`;
        msg += '\n';
      } else if (creatorAnglePrefixes.some((prefix) => section.startsWith(prefix))) {
        const prefix = creatorAnglePrefixes.find((candidate) => section.startsWith(candidate)) ?? '';
        msg += `<b>🎯 SEU ÂNGULO</b>\n`;
        msg += `<i>${escapeHtml(section.slice(prefix.length).trim())}</i>\n\n`;
      }
    }
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💡 <b>CONTENT IDEAS</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (let i = 0; i < res.briefs.length; i++) {
    const b = res.briefs[i];
    const fire = b.time_sensitive ? ' 🔥 URGENTE' : '';
    msg += `<b>${i + 1}. ${escapeHtml(b.title)}</b>${fire}\n`;
    msg += `   🎬 ${escapeHtml(b.format)}\n`;
    msg += `   🎣 <i>"${escapeHtml(b.hook)}"</i>\n`;
    if (b.why_now && !b.why_now.includes('RESUMO:')) {
      msg += `   ⏰ ${escapeHtml(b.why_now)}\n`;
    }
    if (b.key_points.length > 0) {
      msg += `   📝 <b>Talking points:</b>\n`;
      for (const p of b.key_points) {
        msg += `      • ${escapeHtml(p)}\n`;
      }
    }
    msg += `   📋 <code>/genscript ${escapeHtml(b.title.slice(0, 80))}</code>\n\n`;
  }

  const sources = res.briefs[0]?.sources || [];
  if (sources.length > 0) {
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔗 <b>SOURCES</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const s of sources) {
      if (isSafeUrl(s.url)) {
        msg += `• <a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>\n`;
      } else {
        msg += `• ${escapeHtml(s.title)}\n`;
      }
      if (s.relevance_note) {
        msg += `  <i>${escapeHtml(s.relevance_note)}</i>\n`;
      }
    }
  }

  return msg;
}

export function formatSources(res: SourcesResponse): string {
  let msg = `📚 <b>Sources for "${escapeHtml(res.query)}"</b>\n\n`;
  for (let i = 0; i < res.sources.length; i++) {
    const s = res.sources[i];
    if (isSafeUrl(s.url)) {
      msg += `${i + 1}. <a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>\n`;
    } else {
      msg += `${i + 1}. ${escapeHtml(s.title)}\n`;
    }
    msg += `   [${s.source_type}] ${escapeHtml(s.relevance_note)}\n`;
  }
  return msg;
}

export function formatHotNews(res: HotNewsResponse): string {
  // Identity-safety (closed-beta v4.14.126+): the niche → emoji map is  // nx-allow-identity-scan
  // now keyed by the generic broad-content labels orchestrator.py
  // emits when the creator has no saved pillars. The previous
  // founder-shaped enum was removed in the closed-beta hardening pass;  // nx-allow-identity-scan
  // it leaked the founder's pillar set — including a faith/family  // nx-allow-identity-scan
  // ideology label — into every authenticated user's hot-news
  // Telegram render. The fallback `'📰'` at the lookup site
  // (`NICHE_EMOJI[t.niche] || '📰'`) handles any creator-saved-pillar
  // label not present in this map.
  const NICHE_EMOJI: Record<string, string> = {
    technology: '🛰',
    'creator-economy': '🎬',
    wellness: '💪',
    fitness: '💪',
    lifestyle: '🌿',
    business: '📊',
    'current events': '📰',
    'current-events': '📰',
    geral: '📰',
    general: '📰',
  };
  let msg = `🔥 <b>Hot News — Curated for You</b>\n\n`;
  for (let i = 0; i < res.topics.length; i++) {
    const t = res.topics[i] as any;
    const emoji = NICHE_EMOJI[t.niche] || '📰';
    const relevance = t.relevance ? '⭐'.repeat(Math.min(5, Math.ceil(t.relevance / 2))) : '';
    msg += `${emoji} <b>${i + 1}. ${escapeHtml(t.topic)}</b>\n`;
    if (t.content_angle) {
      msg += `   💡 <i>${escapeHtml(t.content_angle)}</i>\n`;
    }
    msg += `   ${relevance} · ${escapeHtml(t.niche)}\n`;
    msg += `   📋 <code>/deepsearch ${escapeHtml(t.topic.slice(0, 80))}</code>\n\n`;
  }
  return msg;
}

// ── Phase 2 Formatters ──────────────────────────────────────────────

export function formatTrending(res: TrendingResponse): string {
  let msg = `📈 <b>Trending — ${escapeHtml(res.niche || 'all')}</b>\n`;
  msg += `<i>${res.topics.length} topics · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.topics.length; i++) {
    const t = res.topics[i];
    const filled = Math.min(10, Math.max(0, Math.round(t.heat_score * 10)));
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    msg += `${i + 1}. <b>${escapeHtml(t.topic)}</b>\n`;
    msg += `   ${bar} ${(t.heat_score * 100).toFixed(0)}% · ${escapeHtml(t.niche)}\n`;
  }
  return msg;
}

export function formatReaction(res: ReactionResponse): string {
  let msg = `🎬 <b>Reaction-worthy: "${escapeHtml(res.query)}"</b>\n`;
  msg += `<i>${res.briefs.length} ideas · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.briefs.length; i++) {
    const b = res.briefs[i];
    msg += `<b>${i + 1}. ${escapeHtml(b.title)}</b>\n`;
    msg += `   🎯 ${escapeHtml(b.angle)}\n`;
    msg += `   🎣 <i>${escapeHtml(b.hook)}</i>\n\n`;
  }
  return msg;
}

// ── Phase 3 Formatters ──────────────────────────────────────────────

export function formatHooks(res: HooksResponse): string {
  let msg = `🎣 <b>Hooks: "${escapeHtml(res.topic)}"</b>\n`;
  msg += `<i>${res.hooks.length} hooks · ${res.niche} · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.hooks.length; i++) {
    const h = res.hooks[i];
    msg += `<b>${i + 1}.</b> "${escapeHtml(h.text || '')}"\n`;
    msg += `   💡 ${escapeHtml(h.trigger_type || '')} · Score: ${(h.score ?? 0).toFixed(1)}\n`;
    if (h.why) msg += `   📝 <i>${escapeHtml(h.why)}</i>\n`;
    msg += '\n';
  }
  return msg;
}

export function formatScript(res: ScriptResponse): string {
  let msg = `📝 <b>Script: "${escapeHtml(res.topic)}"</b>\n`;
  msg += `<i>~${escapeHtml(res.estimated_duration)} · ${res.duration_ms}ms</i>\n\n`;
  if (res.title_options.length > 0) {
    msg += `<b>📌 Title options:</b>\n`;
    res.title_options.forEach((t, i) => { msg += `  ${i + 1}. ${escapeHtml(t)}\n`; });
    msg += '\n';
  }
  msg += `<b>🎣 Hook:</b>\n<i>${escapeHtml(res.hook)}</i>\n\n`;
  msg += `<b>📜 Script:</b>\n${escapeHtml(res.script)}\n`;
  if (res.sources_used.length > 0) {
    msg += `\n<b>📚 Sources:</b>\n`;
    res.sources_used.forEach((s) => {
      if (isSafeUrl(s.url)) msg += `• <a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>\n`;
      else msg += `• ${escapeHtml(s.title)}\n`;
    });
  }
  return msg;
}

export function formatTitles(res: TitlesResponse): string {
  let msg = `🏷️ <b>Titles: "${escapeHtml(res.topic)}"</b>\n`;
  msg += `<i>${res.titles.length} variants · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.titles.length; i++) {
    const t = res.titles[i];
    msg += `<b>${i + 1}.</b> ${escapeHtml(t.title || '')}\n`;
    msg += `   📊 ${escapeHtml(t.strategy || '')} · Score: ${(t.score ?? 0).toFixed(1)}\n`;
    if (t.why) msg += `   💡 <i>${escapeHtml(t.why)}</i>\n`;
    msg += '\n';
  }
  return msg;
}

export function formatThumbnail(res: ThumbnailResponse): string {
  let msg = `🖼️ <b>Thumbnail: "${escapeHtml(res.title)}"</b>\n`;
  msg += `<i>${res.concepts.length} concepts · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.concepts.length; i++) {
    const c = res.concepts[i];
    msg += `<b>Concept ${i + 1}:</b>\n`;
    if (c.layout) msg += `  📐 Layout: ${escapeHtml(c.layout)}\n`;
    if (c.colors) msg += `  🎨 Colors: ${escapeHtml(c.colors)}\n`;
    if (c.text) msg += `  ✏️ Text: ${escapeHtml(c.text)}\n`;
    if (c.expression) msg += `  😀 Expression: ${escapeHtml(c.expression)}\n`;
    if (c.why) msg += `  💡 <i>${escapeHtml(c.why)}</i>\n`;
    msg += '\n';
  }
  return msg;
}

export function formatCaption(res: CaptionResponse): string {
  let msg = `📸 <b>Caption: "${escapeHtml(res.topic)}"</b>\n`;
  msg += `<i>${res.duration_ms}ms</i>\n\n`;
  msg += `${escapeHtml(res.caption)}\n\n`;
  if (res.hashtags.length > 0) {
    msg += `<b>Hashtags:</b>\n${res.hashtags.map((h) => escapeHtml(h)).join(' ')}\n`;
  }
  return msg;
}

// ── Phase 4 Formatters ──────────────────────────────────────────────

export function formatCompetitor(res: CompetitorResponse): string {
  let msg = `🔎 <b>Competitor: ${escapeHtml(res.channel)}</b>\n`;
  msg += `<i>${res.duration_ms}ms</i>\n\n`;
  const a = res.analysis;
  for (const [key, value] of Object.entries(a)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof value === 'string') {
      msg += `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}\n`;
    } else if (Array.isArray(value)) {
      msg += `<b>${escapeHtml(label)}:</b>\n`;
      value.slice(0, 5).forEach((v: unknown) => { msg += `  • ${escapeHtml(String(v))}\n`; });
    } else if (typeof value === 'object' && value !== null) {
      msg += `<b>${escapeHtml(label)}:</b>\n`;
      for (const [k2, v2] of Object.entries(value)) {
        msg += `  ${escapeHtml(k2)}: ${escapeHtml(String(v2))}\n`;
      }
    } else {
      msg += `<b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}\n`;
    }
    msg += '\n';
  }
  return msg;
}

export function formatGaps(res: GapsResponse): string {
  let msg = `🔍 <b>Content Gaps — ${escapeHtml(res.niche)}</b>\n`;
  msg += `<i>${res.gaps.length} gaps · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.gaps.length; i++) {
    const g = res.gaps[i];
    const icon = g.gap_type === 'BIG_OPPORTUNITY' ? '🟢' : g.gap_type === 'QUALITY_GAP' ? '🟡' : '🔴';
    msg += `${icon} <b>${i + 1}. ${escapeHtml(g.topic || '')}</b>\n`;
    msg += `   Type: ${escapeHtml(g.gap_type || '')}`;
    if (g.search_volume) msg += ` · Vol: ${escapeHtml(g.search_volume)}`;
    msg += '\n';
    if (g.opportunity) msg += `   💡 ${escapeHtml(g.opportunity)}\n`;
    msg += '\n';
  }
  return msg;
}

export function formatSeo(res: SeoResponse): string {
  let msg = `🔑 <b>SEO: "${escapeHtml(res.topic)}"</b>\n`;
  msg += `<i>${res.clusters.length} keyword clusters · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.clusters.length; i++) {
    const c = res.clusters[i];
    msg += `<b>${i + 1}. ${escapeHtml(c.keyword || '')}</b>\n`;
    if (c.volume) msg += `   📊 Vol: ${escapeHtml(c.volume)}`;
    if (c.difficulty) msg += ` · Diff: ${escapeHtml(c.difficulty)}`;
    msg += '\n';
    if (c.content_type) msg += `   📹 ${escapeHtml(c.content_type)}\n`;
    msg += '\n';
  }
  return msg;
}

export function formatRepurpose(res: RepurposeResponse): string {
  let msg = `♻️ <b>Repurpose: "${escapeHtml(res.topic)}"</b>\n`;
  msg += `<i>${res.outputs.length} pieces · ${res.duration_ms}ms</i>\n\n`;
  for (let i = 0; i < res.outputs.length; i++) {
    const o = res.outputs[i];
    msg += `<b>${i + 1}. [${escapeHtml(o.format || '')}] ${escapeHtml(o.platform || '')}</b>\n`;
    if (o.posting_delay) msg += `   ⏰ ${escapeHtml(o.posting_delay)}\n`;
    msg += `   ${escapeHtml(o.content || '')}\n`;
    if (o.notes) msg += `   📝 <i>${escapeHtml(o.notes)}</i>\n`;
    msg += '\n';
  }
  return msg;
}

// ── Phase 5 Formatters ──────────────────────────────────────────────

export function formatFeedback(res: FeedbackResponse): string {
  let msg = `📊 <b>Feedback Logged</b> — ${escapeHtml(res.status)}\n`;
  msg += `<i>${res.duration_ms}ms</i>\n\n`;
  const a = res.analysis;
  for (const [key, value] of Object.entries(a)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof value === 'string') {
      msg += `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}\n`;
    } else if (Array.isArray(value)) {
      msg += `<b>${escapeHtml(label)}:</b>\n`;
      value.slice(0, 5).forEach((v: unknown) => { msg += `  • ${escapeHtml(String(v))}\n`; });
    } else {
      msg += `<b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}\n`;
    }
  }
  return msg;
}

export function formatReport(res: ReportResponse): string {
  let msg = `📈 <b>Content Report — ${escapeHtml(res.period)}</b>\n`;
  msg += `<i>${res.duration_ms}ms</i>\n\n`;
  const r = res.report;
  for (const [key, value] of Object.entries(r)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof value === 'string' || typeof value === 'number') {
      msg += `<b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}\n`;
    } else if (Array.isArray(value)) {
      msg += `<b>${escapeHtml(label)}:</b>\n`;
      value.slice(0, 5).forEach((v: unknown) => { msg += `  • ${escapeHtml(String(v))}\n`; });
    } else if (typeof value === 'object' && value !== null) {
      msg += `<b>${escapeHtml(label)}:</b>\n`;
      for (const [k2, v2] of Object.entries(value)) {
        msg += `  ${escapeHtml(k2)}: ${escapeHtml(String(v2))}\n`;
      }
    }
  }
  return msg;
}

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { now } from '../utils/date-parser';
import { trackedCreate } from '../portal/anthropic-hook';
import { getDb } from './database';
import { buildKnowledgePromptBlock } from '../state/content-references';
import { handleContent } from '../domains/content-creator';
import { saveScriptAsDocx } from './video-study';
import { storeCallback } from '../utils/callback-store';
import { escapeHtml } from '../utils/telegram-formatter';
import { InputFile } from 'grammy';
import { buildAngleDiversityBlock, isDuplicateIdea } from './content-dedup';
import { getWorkflowEligibleIdeas, markIdeaPromoted } from '../state/saved-ideas';
import { readSignals } from './intelligence-bus';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const IDEAS_DIR = path.join(process.env.HOME || '/home/dominguez', 'Desktop', 'IDEAS');

// ─── Types ──────────────────────────────────────────────────────────

export interface TopicCandidate {
  title: string;
  niche: string;
  whyNow: string;
  hookIdea: string;
  angleTag?: string;
}

// ─── Database helpers ───────────────────────────────────────────────

export function storeTopicCandidates(
  candidates: TopicCandidate[],
  format: 'reel' | 'youtube',
  sourceJob: string,
): number[] {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO content_topic_feedback (topic, niche, format, sentiment, source_job, hook_idea, why_now, angle_tag)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
  );
  return candidates.map((c) => {
    const info = stmt.run(c.title, c.niche, format, sourceJob, c.hookIdea, c.whyNow, c.angleTag || null);
    return Number(info.lastInsertRowid);
  });
}

export function updateFeedback(id: number, sentiment: 'approved' | 'skipped' | 'rejected'): void {
  getDb().prepare(`UPDATE content_topic_feedback SET sentiment = ? WHERE id = ?`).run(sentiment, id);
}

export function markScriptGenerated(id: number): void {
  getDb().prepare(`UPDATE content_topic_feedback SET script_generated = 1 WHERE id = ?`).run(id);
}

export function getTopicById(id: number): TopicCandidate & { format: string; sourceJob: string } | null {
  const row = getDb().prepare(
    `SELECT topic, niche, format, source_job, hook_idea, why_now FROM content_topic_feedback WHERE id = ?`,
  ).get(id) as any;
  if (!row) return null;
  return {
    title: row.topic,
    niche: row.niche || '',
    whyNow: row.why_now || '',
    hookIdea: row.hook_idea || '',
    format: row.format,
    sourceJob: row.source_job || '',
  };
}

// ─── Taste Profile ──────────────────────────────────────────────────

export function buildTasteProfileBlock(): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT topic, niche, sentiment FROM content_topic_feedback
     WHERE sentiment IN ('approved', 'rejected')
       AND created_at > datetime('now', '-60 days')
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all() as { topic: string; niche: string; sentiment: string }[];

  if (rows.length < 5) return '';

  const approved = rows.filter((r) => r.sentiment === 'approved');
  const rejected = rows.filter((r) => r.sentiment === 'rejected');

  let block = '\n\n[TASTE PROFILE — learned from past feedback]\n';
  block += 'Use this to suggest topics Felipe is more likely to approve.\n\n';

  if (approved.length > 0) {
    block += 'Topics Felipe APPROVED:\n';
    for (const r of approved.slice(0, 15)) {
      block += `  • "${r.topic}" (${r.niche || 'general'})\n`;
    }
  }

  if (rejected.length > 0) {
    block += '\nTopics Felipe REJECTED (avoid similar):\n';
    for (const r of rejected.slice(0, 15)) {
      block += `  • "${r.topic}" (${r.niche || 'general'})\n`;
    }
  }

  // Summary stats
  const approvedNiches = [...new Set(approved.map((r) => r.niche).filter(Boolean))];
  const rejectedNiches = [...new Set(rejected.map((r) => r.niche).filter(Boolean))];
  block += `\nPreferred niches: ${approvedNiches.join(', ') || 'varied'}`;
  block += `\nAvoided niches: ${rejectedNiches.join(', ') || 'none'}\n`;

  return block;
}

// ─── Topic Generation ───────────────────────────────────────────────

const CONTENT_PILLARS = [
  'Fitness/gym & strength training',
  'Running, cycling & endurance',
  'Politics & news (conservative/libertarian lens)',
  'Faith, family & traditional values',
  'Self-development & personal growth',
  'Economics & free market (Austrian School)',
  'Trending topic commentary & viral reactions',
];

function buildTopicSystemPrompt(format: 'reel' | 'youtube', isTrending: boolean): string {
  const formatDesc = format === 'reel'
    ? 'Instagram Reels / YouTube Shorts (30-60 seconds each)'
    : 'YouTube videos (8-15 minutes each)';

  const trendingInstr = isTrending
    ? 'Focus on what is trending RIGHT NOW — viral debates, breaking news, hot takes from the last 24-48h. Every topic must be tied to something CURRENT.'
    : 'Focus on EVERGREEN topics — timeless ideas that will be relevant months from now. Personal growth frameworks, fitness principles, life lessons.';

  let prompt = `You are a content topic generator for a YouTube/Instagram creator.

CREATOR PROFILE:
- Brazilian living in Portugal, all content in PT-BR (Brazilian Portuguese)
- Style: authentic, raw, unapologetic — challenges mainstream narratives with strong arguments
- Content pillars: ${CONTENT_PILLARS.join(', ')}

CREATOR WORLDVIEW (topics MUST reflect this perspective):
- Conservative Christian. Nuclear family, traditional masculinity, personal responsibility.
- Libertarian / Anti-state. Free market, Austrian Economics (von Mises, Hayek, Rothbard), Non-Aggression Principle.
- Skeptical of power elites. Globalist agendas, central banking, supranational control — calls it out.
- Pro-individual sovereignty. Against collectivism, welfare dependency, government overreach.
- When politics/news: always frame from conservative/libertarian lens. Challenge progressive narratives. Bold but articulate.

TARGET AUDIENCE:
- Male, Brazilian, ages 18-35
- Red-pilled or getting there. Questioning mainstream narratives.
- Values: discipline, self-improvement, faith, freedom, hard work
- Frustrated with the system but hungry for direction and truth
- Watches: motivational content, political commentary, self-development, conspiracy-adjacent analysis

FORMAT: ${formatDesc}

${trendingInstr}

`;

  const knowledgeBlock = buildKnowledgePromptBlock();
  if (knowledgeBlock) prompt += knowledgeBlock + '\n';

  const tasteBlock = buildTasteProfileBlock();
  if (tasteBlock) prompt += tasteBlock + '\n';

  prompt += `RESPOND ONLY with a JSON array. No extra text before or after the array.
Each element must have: { "title": "topic title in PT-BR", "niche": "one of: fitness, politics, self-development, trending, running, faith, economics", "whyNow": "why this topic is relevant right now", "hookIdea": "opening hook line in PT-BR (first 3 seconds)", "angle_tag": "one of: opinion, reaction, how-to, story, myth-bust, comparison, data, framework, listicle, trending-take" }`;

  return prompt;
}

export async function generateTopicCandidates(
  format: 'reel' | 'youtube',
  count: number,
  isTrending = true,
): Promise<TopicCandidate[]> {
  const systemPrompt = buildTopicSystemPrompt(format, isTrending);
  const today = now();

  // Build enrichment blocks
  const angleDiversity = buildAngleDiversityBlock();

  // Book knowledge injection (Sprint 3.2)
  let bookBlock = '';
  try {
    const bookSignals = readSignals('content-workflow', ['book_knowledge']);
    if (bookSignals.length > 0) {
      const bookLines = bookSignals.slice(0, 5).map((s: any) => {
        const p = s.payload as any;
        const fwNames = (p.key_frameworks || []).map((f: any) => f.name).join(', ');
        return `- "${p.title}" by ${p.author}: ${fwNames}`;
      });
      bookBlock = `\n## Book Frameworks Available\nThese intellectual frameworks from your library could seed compelling topics:\n${bookLines.join('\n')}\nConsider generating 1-2 topics that apply these frameworks to current events. Use angle_tag "framework" for these.\n`;
    }
  } catch { /* non-critical */ }

  // Discovery cross-pollination (Sprint 2.4)
  let discoveryBlock = '';
  try {
    const eligible = getWorkflowEligibleIdeas();
    if (eligible.length > 0) {
      const ideasList = eligible.slice(0, 5).map(i => `- ${i.title}`).join('\n');
      discoveryBlock = `\n## Pre-Researched Ideas from Daily Discovery\nThese high-scoring ideas were found by the daily trend scanner. Consider including, modifying, or building on them:\n${ideasList}\n`;
      // Mark promoted
      for (const idea of eligible.slice(0, 5)) {
        markIdeaPromoted(idea.id);
      }
    }
  } catch { /* non-critical */ }

  const enrichment = `${angleDiversity}${bookBlock}${discoveryBlock}`;

  const userMessage = isTrending
    ? `Today is ${today.toFormat('cccc, LLLL dd, yyyy')}. Generate ${count} trending ${format} topic candidates. Search for what's hot right now across my content pillars.${enrichment}\n\nRespond with a JSON array. Each object must have: "title", "niche", "whyNow", "hookIdea", "angle_tag".`
    : `Generate ${count} evergreen ${format} topic candidates across my content pillars. Timeless topics I can record anytime.${enrichment}\n\nRespond with a JSON array. Each object must have: "title", "niche", "whyNow", "hookIdea", "angle_tag".`;

  const cachedSystem: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const tools = isTrending
    ? [{ type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 } as any]
    : undefined;

  const response = await trackedCreate(client, {
    model: config.anthropic.classifierModel, // Haiku
    max_tokens: 4096,
    system: cachedSystem,
    messages: [{ role: 'user', content: userMessage }],
    ...(tools ? { tools } : {}),
  } as any, `content_workflow_${format}`);

  // Handle pause_turn
  let finalResponse = response;
  if (response.stop_reason === 'pause_turn') {
    logger.info({ format }, 'Content workflow topic generation paused, continuing...');
    finalResponse = await trackedCreate(client, {
      model: config.anthropic.classifierModel,
      max_tokens: 4096,
      system: cachedSystem,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: response.content as any },
      ],
      ...(tools ? { tools } : {}),
    } as any, `content_workflow_${format}_continuation`);
  }

  const textContent = finalResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // Extract JSON array from response
  const jsonMatch = textContent.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn({ format, textContent: textContent.slice(0, 500) }, 'Could not find JSON array in topic response');
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as any[];
    // Normalize: map angle_tag from various field names Claude might use
    const candidates: TopicCandidate[] = parsed.slice(0, count).map(c => ({
      title: c.title || '',
      niche: c.niche || '',
      whyNow: c.whyNow || c.why_now || '',
      hookIdea: c.hookIdea || c.hook_idea || c.hook || '',
      angleTag: c.angleTag || c.angle_tag || undefined,
    }));

    // Run dedup on each candidate
    const deduped: TopicCandidate[] = [];
    for (const c of candidates) {
      try {
        const dup = await isDuplicateIdea(c.title, c.angleTag);
        if (dup.isDuplicate && dup.confidence > 0.8) {
          logger.info({ title: c.title, similarTo: dup.similarTo }, 'Workflow topic skipped (duplicate)');
          continue;
        }
      } catch { /* allow through on error */ }
      deduped.push(c);
    }

    return deduped;
  } catch (err) {
    logger.error({ err, format }, 'Failed to parse topic candidates JSON');
    return [];
  }
}

// ─── Script Generation ──────────────────────────────────────────────

export async function generateReelScript(topic: TopicCandidate): Promise<string> {
  const prompt = `Write a complete 30-60 second Instagram Reel / YouTube Short script in PT-BR.

Topic: "${topic.title}"
Niche: ${topic.niche}
Context: ${topic.whyNow}
Opening hook idea: "${topic.hookIdea}"

Structure:
🎣 HOOK (0-3s): Pattern interrupt, bold claim, or curiosity gap
📝 BODY (3-50s): Main message — concise, punchy, one key insight
📢 CTA (last 5-10s): What should the viewer do? Follow, comment, share?

Rules:
- Write in PT-BR (Brazilian Portuguese)
- Conversational and authentic tone
- Short sentences, high energy
- Include [PAUSE], [CORTE], [ZOOM] editing cues where impactful`;

  const result = await handleContent(prompt, 4096);
  return result.text;
}

export async function generateYouTubeScript(topic: TopicCandidate): Promise<string> {
  const prompt = `Write a complete YouTube video script in PT-BR (8-15 min).

Topic: "${topic.title}"
Niche: ${topic.niche}
Context: ${topic.whyNow}
Opening hook idea: "${topic.hookIdea}"

Include ALL of these sections:
1. CONTEXTO — tema, duração estimada, tom, estrutura
2. HOOK (0-15s) — pattern interrupt that stops scrolling
3. PROBLEMA — why the viewer should care
4. CONCEITO — the core idea/framework
5. APLICAÇÃO — practical examples (at least 3)
6. CTA — subscribe, comment prompt, next video tease

Also provide:
📌 5 TITLE OPTIONS (PT-BR, SEO-friendly, curiosity-driven)
🖼️ THUMBNAIL CONCEPT (visual description: text overlay, expression, colors)

Rules:
- All in PT-BR (Brazilian Portuguese)
- Authentic, conversational, motivational tone
- Include [SHOW ON SCREEN], [CORTE], [B-ROLL] markers
- Include [PAUSE] markers for dramatic effect
- Short paragraphs, easy to read on teleprompter`;

  const result = await handleContent(prompt, 8192);
  return result.text;
}

// ─── Orchestrators (called by scheduler and manual commands) ────────

export async function sendTopicCandidates(
  bot: Bot,
  userId: number,
  format: 'reel' | 'youtube',
  sourceJob: string,
): Promise<void> {
  const count = format === 'reel' ? 5 : 5;
  const isTrending = sourceJob !== 'friday_weekly';

  const headerEmoji = format === 'reel' ? '🎬' : '🔥';
  const headerLabel = format === 'reel' ? 'TRENDING REELS' : 'TRENDING YOUTUBE';
  const dayLabel = sourceJob === 'tuesday_reels' ? 'Terça-feira'
    : sourceJob === 'thursday_youtube' ? 'Quinta-feira'
    : 'Sexta-feira';

  await bot.api.sendMessage(userId,
    `${headerEmoji} <b>${headerLabel} — ${dayLabel}</b>\n\n⏳ Searching for topics...`,
    { parse_mode: 'HTML' },
  );

  const candidates = isTrending
    ? await generateTopicCandidates(format, count, true)
    : await generateTopicCandidates(format, count, false);

  if (candidates.length === 0) {
    await bot.api.sendMessage(userId,
      '❌ Could not generate topic candidates. Try again with /contenttopic.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Store in DB as pending
  const feedbackIds = storeTopicCandidates(candidates, format, sourceJob);

  // Send one message per topic with inline buttons
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const fbId = feedbackIds[i];

    const msg = `${headerEmoji} <b>Topic ${i + 1} of ${candidates.length}</b>\n\n` +
      `📌 <b>${escapeHtml(c.title)}</b>\n` +
      `🎯 Niche: ${escapeHtml(c.niche)}\n` +
      `🎣 Hook: <i>"${escapeHtml(c.hookIdea)}"</i>\n` +
      `⏰ Why now: ${escapeHtml(c.whyNow)}`;

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `cw:approve:${fbId}`)
      .text('⏭ Skip', `cw:skip:${fbId}`)
      .text('👎 Not my vibe', `cw:reject:${fbId}`);

    await bot.api.sendMessage(userId, msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  await bot.api.sendMessage(userId,
    `💡 Tap ✅ to generate full scripts. 👎 helps me learn your taste.`,
    { parse_mode: 'HTML' },
  );
}

export async function sendWeeklyPackage(
  bot: Bot,
  userId: number,
): Promise<void> {
  await bot.api.sendMessage(userId,
    `📋 <b>WEEKLY CONTENT PACKAGE — Sexta-feira</b>\n\n⏳ Generating evergreen topics for next week...`,
    { parse_mode: 'HTML' },
  );

  // Generate 2 evergreen YT + 4 evergreen reel topics
  const [ytTopics, reelTopics] = await Promise.all([
    generateTopicCandidates('youtube', 2, false),
    generateTopicCandidates('reel', 4, false),
  ]);

  const allTopics = [
    ...ytTopics.map((t) => ({ ...t, format: 'youtube' as const })),
    ...reelTopics.map((t) => ({ ...t, format: 'reel' as const })),
  ];

  if (allTopics.length === 0) {
    await bot.api.sendMessage(userId,
      '❌ Could not generate weekly topics. Try again with /contentretro.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Store all in DB
  const ytIds = ytTopics.length > 0 ? storeTopicCandidates(ytTopics, 'youtube', 'friday_weekly') : [];
  const reelIds = reelTopics.length > 0 ? storeTopicCandidates(reelTopics, 'reel', 'friday_weekly') : [];

  // Send YT topics
  if (ytTopics.length > 0) {
    await bot.api.sendMessage(userId, `🎥 <b>YOUTUBE EVERGREEN (${ytTopics.length})</b>`, { parse_mode: 'HTML' });
    for (let i = 0; i < ytTopics.length; i++) {
      const c = ytTopics[i];
      const fbId = ytIds[i];
      const msg = `📌 <b>${escapeHtml(c.title)}</b>\n` +
        `🎯 ${escapeHtml(c.niche)}\n` +
        `🎣 <i>"${escapeHtml(c.hookIdea)}"</i>`;
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `cw:approve:${fbId}`)
        .text('⏭ Skip', `cw:skip:${fbId}`)
        .text('👎 Not my vibe', `cw:reject:${fbId}`);
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }

  // Send reel topics
  if (reelTopics.length > 0) {
    await bot.api.sendMessage(userId, `🎬 <b>REELS EVERGREEN (${reelTopics.length})</b>`, { parse_mode: 'HTML' });
    for (let i = 0; i < reelTopics.length; i++) {
      const c = reelTopics[i];
      const fbId = reelIds[i];
      const msg = `📌 <b>${escapeHtml(c.title)}</b>\n` +
        `🎯 ${escapeHtml(c.niche)}\n` +
        `🎣 <i>"${escapeHtml(c.hookIdea)}"</i>`;
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `cw:approve:${fbId}`)
        .text('⏭ Skip', `cw:skip:${fbId}`)
        .text('👎 Not my vibe', `cw:reject:${fbId}`);
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }

  await bot.api.sendMessage(userId,
    `✅ Approve the topics you want scripted. Scripts will be saved to <code>~/Desktop/IDEAS/weekly/</code>`,
    { parse_mode: 'HTML' },
  );
}

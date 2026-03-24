/**
 * Pipeline bot commands — /pipeline, /filmed, /editing, /published
 */

import type { Context } from 'grammy';
import { getPipelineStats, advancePipelineStage } from '../agents/pipeline-agent';
import { getDb } from '../services/database';
import { escapeHtml } from '../utils/telegram-formatter';

export async function handlePipelineStatus(ctx: Context): Promise<void> {
  const stats = getPipelineStats();

  const bar = (count: number, max: number) => {
    const filled = Math.min(Math.round((count / Math.max(max, 1)) * 10), 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const maxStage = Math.max(...Object.values(stats.stages), 1);

  let msg = '<b>📊 Content Pipeline</b>\n\n';
  const icons: Record<string, string> = {
    approved: '✅', scripted: '📝', filming: '🎬', editing: '✂️', published: '🚀',
  };

  for (const [stage, count] of Object.entries(stats.stages)) {
    msg += `${icons[stage] || '•'} <b>${stage}</b>: ${bar(count, maxStage)} ${count}\n`;
  }

  msg += `\n<b>Active items:</b> ${stats.totalActive}`;
  msg += `\n<b>Published this week:</b> ${stats.publishedThisWeek}`;

  if (stats.bottleneck) {
    msg += `\n\n⚠️ <b>Bottleneck:</b> ${stats.bottleneck.count} items stuck at <b>${stats.bottleneck.stage}</b> (avg ${stats.bottleneck.avgDays} days)`;
  } else {
    msg += '\n\n✅ Pipeline is healthy — no bottlenecks detected.';
  }

  // Show recent pipeline items
  const db = getDb();
  const recent = db.prepare(`
    SELECT topic_title, stage, updated_at FROM content_pipeline
    WHERE stage != 'published'
    ORDER BY updated_at DESC LIMIT 5
  `).all() as any[];

  if (recent.length > 0) {
    msg += '\n\n<b>Recent items:</b>';
    for (const item of recent) {
      const days = Math.round((Date.now() - new Date(item.updated_at).getTime()) / 86400000);
      msg += `\n• ${escapeHtml(item.topic_title.slice(0, 50))} — <i>${item.stage}</i> (${days}d ago)`;
    }
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

export async function handleFilmedStage(ctx: Context): Promise<void> {
  const topic = ctx.match?.toString().trim();
  if (!topic) {
    await ctx.reply('Usage: <code>/filmed [topic title]</code>', { parse_mode: 'HTML' });
    return;
  }
  const ok = advancePipelineStage(topic, 'filming');
  if (ok) {
    await ctx.reply(`🎬 <b>${escapeHtml(topic)}</b> moved to <b>filming</b>`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('❌ Topic not found in pipeline. Check <code>/pipeline</code> for active items.', { parse_mode: 'HTML' });
  }
}

export async function handleEditingStage(ctx: Context): Promise<void> {
  const topic = ctx.match?.toString().trim();
  if (!topic) {
    await ctx.reply('Usage: <code>/editing [topic title]</code>', { parse_mode: 'HTML' });
    return;
  }
  const ok = advancePipelineStage(topic, 'editing');
  if (ok) {
    await ctx.reply(`✂️ <b>${escapeHtml(topic)}</b> moved to <b>editing</b>`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('❌ Topic not found in pipeline.', { parse_mode: 'HTML' });
  }
}

export async function handlePublishedStage(ctx: Context): Promise<void> {
  const input = ctx.match?.toString().trim() || '';
  const parts = input.split(/\s+/);
  // Last part might be a YouTube URL
  const youtubeUrl = parts.find(p => p.includes('youtube.com') || p.includes('youtu.be'));
  const topic = parts.filter(p => p !== youtubeUrl).join(' ');

  if (!topic) {
    await ctx.reply('Usage: <code>/published [topic] [youtube_url]</code>', { parse_mode: 'HTML' });
    return;
  }

  let videoId: string | undefined;
  if (youtubeUrl) {
    const match = youtubeUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    videoId = match?.[1];
  }

  const ok = advancePipelineStage(topic, 'published', {
    youtube_video_id: videoId,
  });

  if (ok) {
    await ctx.reply(`🚀 <b>${escapeHtml(topic)}</b> marked as <b>published</b>!${videoId ? ` (${videoId})` : ''}`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('❌ Topic not found in pipeline.', { parse_mode: 'HTML' });
  }
}

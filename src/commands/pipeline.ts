/**
 * Pipeline bot commands — /pipeline, /filmed, /editing, /published
 */

import type { Context } from 'grammy';
import { getPipelineStats, advancePipelineStage } from '../agents/pipeline-agent';
import { getDb } from '../services/database';
import { escapeHtml } from '../utils/telegram-formatter';
import { writeSignal } from '../services/intelligence-bus';

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

  // Accept: /published [URL] or /published [topic] [URL]
  const urlMatch = input.match(/(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\S+)/);
  const youtubeUrl = urlMatch?.[1];
  const topic = input.replace(youtubeUrl || '', '').trim();

  if (!topic && !youtubeUrl) {
    await ctx.reply(
      '🚀 <b>Usage:</b>\n' +
      '<code>/published [topic] [youtube_url]</code>\n' +
      '<code>/published https://youtube.com/watch?v=xxx</code>\n\n' +
      'Marks a pipeline item as published and closes the loop.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  let videoId: string | undefined;
  if (youtubeUrl) {
    const match = youtubeUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    videoId = match?.[1];
  }

  const db = getDb();
  const publishedAt = new Date().toISOString();

  // Try to find matching pipeline item
  let pipelineItem: any = null;
  if (videoId) {
    pipelineItem = db.prepare('SELECT * FROM content_pipeline WHERE youtube_video_id = ?').get(videoId);
  }
  if (!pipelineItem && topic) {
    pipelineItem = db.prepare("SELECT * FROM content_pipeline WHERE topic_title LIKE ? AND stage != 'published' ORDER BY created_at DESC LIMIT 1")
      .get(`%${topic}%`);
  }

  if (pipelineItem) {
    // Update existing item
    db.prepare(`
      UPDATE content_pipeline SET stage = 'published', published_url = ?, published_at = ?,
        youtube_video_id = COALESCE(?, youtube_video_id),
        stage_history = json_insert(stage_history, '$[#]', json_object('stage', 'published', 'at', ?)),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(youtubeUrl || null, publishedAt, videoId || null, publishedAt, pipelineItem.id);

    // Calculate time from idea to publish
    const createdAt = new Date(pipelineItem.created_at).getTime();
    const publishedMs = new Date(publishedAt).getTime();
    const daysTaken = Math.round((publishedMs - createdAt) / 86400000);

    // Write intelligence bus signal
    writeSignal({
      source_agent: 'pipeline',
      signal_type: 'content_published',
      payload: {
        pipeline_id: pipelineItem.id,
        title: pipelineItem.topic_title,
        video_url: youtubeUrl,
        video_id: videoId,
        days_to_publish: daysTaken,
        published_at: publishedAt,
      },
    });

    await ctx.reply(
      `🚀 <b>${escapeHtml(pipelineItem.topic_title)}</b> — Published!\n\n` +
      `📊 Idea → Published: <b>${daysTaken} days</b>\n` +
      (youtubeUrl ? `🔗 ${escapeHtml(youtubeUrl)}\n` : '') +
      `\n✅ Pipeline closed. Performance Agent will track this video.`,
      { parse_mode: 'HTML' },
    );
  } else {
    // Create retroactively
    db.prepare(`
      INSERT INTO content_pipeline (topic_title, stage, published_url, published_at, youtube_video_id, stage_history)
      VALUES (?, 'published', ?, ?, ?, json_array(json_object('stage', 'published', 'at', ?)))
    `).run(topic || 'Untitled', youtubeUrl || null, publishedAt, videoId || null, publishedAt);

    writeSignal({
      source_agent: 'pipeline',
      signal_type: 'content_published',
      payload: {
        title: topic || 'Untitled',
        video_url: youtubeUrl,
        video_id: videoId,
        published_at: publishedAt,
      },
    });

    await ctx.reply(
      `🚀 Published (new entry):\n<b>${escapeHtml(topic || 'Untitled')}</b>\n` +
      (youtubeUrl ? `🔗 ${escapeHtml(youtubeUrl)}\n` : '') +
      `\n✅ Created in pipeline as published.`,
      { parse_mode: 'HTML' },
    );
  }
}

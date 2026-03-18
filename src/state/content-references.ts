import { getDb } from '../services/database';

// ─── Types ──────────────────────────────────────────────────────────

export interface ContentRefChannel {
  id: number;
  channel_url: string;
  channel_name: string | null;
  channel_id: string | null;
  status: 'pending' | 'analyzing' | 'active' | 'failed';
  last_analyzed_at: string | null;
  video_count_analyzed: number;
  error_message: string | null;
  added_via: string;
  created_at: string;
  updated_at: string;
}

export interface ContentPattern {
  id: number;
  channel_id: number;
  category: string;
  pattern_text: string;
  examples: string; // JSON array
  confidence: number;
  source_videos: string; // JSON array
  created_at: string;
  updated_at: string;
}

export interface ContentKnowledge {
  id: number;
  category: string;
  synthesized_text: string;
  source_channels: string; // JSON array
  version: number;
  created_at: string;
  updated_at: string;
}

// ─── Pattern categories ──────────────────────────────────────────────

export const PATTERN_CATEGORIES = [
  'hook_style',
  'title_pattern',
  'content_structure',
  'editing_style',
  'storytelling',
  'cta_pattern',
  'audience_engagement',
  'visual_style',
  'brand_voice',
] as const;

export type PatternCategory = typeof PATTERN_CATEGORIES[number];

// ─── Channel CRUD ───────────────────────────────────────────────────

export function addChannel(
  channelUrl: string,
  addedVia: 'manual' | 'portal' | 'bot' = 'manual',
): ContentRefChannel {
  const db = getDb();
  // Normalize URL: strip trailing slashes, ensure consistent format
  const normalized = channelUrl.trim().replace(/\/+$/, '');

  const existing = db.prepare(
    'SELECT * FROM content_ref_channels WHERE channel_url = ?',
  ).get(normalized) as ContentRefChannel | undefined;

  if (existing) {
    // Re-enable if it was previously removed/failed
    if (existing.status === 'failed') {
      db.prepare(`
        UPDATE content_ref_channels
        SET status = 'pending', error_message = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(existing.id);
    }
    return db.prepare('SELECT * FROM content_ref_channels WHERE id = ?')
      .get(existing.id) as ContentRefChannel;
  }

  const result = db.prepare(`
    INSERT INTO content_ref_channels (channel_url, added_via)
    VALUES (?, ?)
  `).run(normalized, addedVia);

  return db.prepare('SELECT * FROM content_ref_channels WHERE id = ?')
    .get(result.lastInsertRowid) as ContentRefChannel;
}

export function getChannel(id: number): ContentRefChannel | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM content_ref_channels WHERE id = ?')
    .get(id) as ContentRefChannel | undefined;
}

export function getAllChannels(): ContentRefChannel[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM content_ref_channels ORDER BY status ASC, channel_name ASC',
  ).all() as ContentRefChannel[];
}

export function getActiveChannels(): ContentRefChannel[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM content_ref_channels WHERE status = 'active' ORDER BY channel_name ASC",
  ).all() as ContentRefChannel[];
}

export function getPendingChannels(): ContentRefChannel[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM content_ref_channels WHERE status = 'pending' ORDER BY created_at ASC",
  ).all() as ContentRefChannel[];
}

export function updateChannelStatus(
  id: number,
  status: ContentRefChannel['status'],
  extra?: {
    channel_name?: string;
    channel_id?: string;
    video_count_analyzed?: number;
    error_message?: string | null;
  },
): void {
  const db = getDb();
  const sets: string[] = ['status = ?', "updated_at = datetime('now')"];
  const params: unknown[] = [status];

  if (status === 'active' || status === 'analyzing') {
    sets.push("last_analyzed_at = datetime('now')");
  }
  if (extra?.channel_name) {
    sets.push('channel_name = ?');
    params.push(extra.channel_name);
  }
  if (extra?.channel_id) {
    sets.push('channel_id = ?');
    params.push(extra.channel_id);
  }
  if (extra?.video_count_analyzed !== undefined) {
    sets.push('video_count_analyzed = ?');
    params.push(extra.video_count_analyzed);
  }
  if (extra?.error_message !== undefined) {
    sets.push('error_message = ?');
    params.push(extra.error_message);
  }

  params.push(id);
  db.prepare(`UPDATE content_ref_channels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function removeChannel(id: number): boolean {
  const db = getDb();
  // Delete patterns first (cascade), then channel
  db.prepare('DELETE FROM content_patterns WHERE channel_id = ?').run(id);
  const result = db.prepare('DELETE FROM content_ref_channels WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Pattern CRUD ───────────────────────────────────────────────────

export function upsertPatterns(
  channelId: number,
  patterns: {
    category: PatternCategory;
    pattern_text: string;
    examples: string[];
    confidence: number;
    source_videos: string[];
  }[],
): void {
  const db = getDb();
  // Clear old patterns for this channel before inserting new ones
  db.prepare('DELETE FROM content_patterns WHERE channel_id = ?').run(channelId);

  const stmt = db.prepare(`
    INSERT INTO content_patterns (channel_id, category, pattern_text, examples, confidence, source_videos)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: typeof patterns) => {
    for (const p of items) {
      stmt.run(
        channelId,
        p.category,
        p.pattern_text,
        JSON.stringify(p.examples),
        p.confidence,
        JSON.stringify(p.source_videos),
      );
    }
  });

  insertMany(patterns);
}

export function getPatternsForChannel(channelId: number): ContentPattern[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM content_patterns WHERE channel_id = ? ORDER BY category, confidence DESC',
  ).all(channelId) as ContentPattern[];
}

export function getAllPatternsByCategory(category: PatternCategory): ContentPattern[] {
  const db = getDb();
  return db.prepare(
    'SELECT p.*, c.channel_name FROM content_patterns p JOIN content_ref_channels c ON p.channel_id = c.id WHERE p.category = ? AND c.status = ? ORDER BY p.confidence DESC',
  ).all(category, 'active') as (ContentPattern & { channel_name: string })[];
}

// ─── Knowledge (Synthesized) ─────────────────────────────────────────

export function upsertKnowledge(
  category: PatternCategory,
  synthesizedText: string,
  sourceChannels: string[],
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO content_knowledge (category, synthesized_text, source_channels)
    VALUES (?, ?, ?)
    ON CONFLICT(category) DO UPDATE SET
      synthesized_text = excluded.synthesized_text,
      source_channels = excluded.source_channels,
      version = content_knowledge.version + 1,
      updated_at = datetime('now')
  `).run(category, synthesizedText, JSON.stringify(sourceChannels));
}

export function getAllKnowledge(): ContentKnowledge[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM content_knowledge ORDER BY category ASC',
  ).all() as ContentKnowledge[];
}

export function getKnowledgeByCategory(category: PatternCategory): ContentKnowledge | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM content_knowledge WHERE category = ?',
  ).get(category) as ContentKnowledge | undefined;
}

/**
 * Build a compact knowledge summary for injection into the content domain system prompt.
 * Returns empty string if no knowledge has been synthesized yet.
 */
export function buildKnowledgePromptBlock(): string {
  const knowledge = getAllKnowledge();
  if (knowledge.length === 0) return '';

  const CATEGORY_LABELS: Record<string, string> = {
    hook_style: '🎣 Hook Styles',
    title_pattern: '🏷️ Title Patterns',
    content_structure: '🏗️ Content Structure',
    editing_style: '✂️ Editing & Pacing',
    storytelling: '📖 Storytelling Techniques',
    cta_pattern: '📢 CTA Patterns',
    audience_engagement: '💬 Audience Engagement',
    visual_style: '🎨 Visual Style',
    brand_voice: '🗣️ Brand Voice',
  };

  const lines: string[] = [
    '\n[LEARNED CONTENT PATTERNS — from reference creators]',
    'These patterns were extracted from successful YouTube creators. Use them as inspiration — adapt to Felipe\'s voice, never copy verbatim.\n',
  ];

  for (const k of knowledge) {
    const label = CATEGORY_LABELS[k.category] || k.category;
    const sources = JSON.parse(k.source_channels) as string[];
    lines.push(`${label} (from: ${sources.join(', ')})`);
    lines.push(k.synthesized_text);
    lines.push('');
  }

  return lines.join('\n');
}

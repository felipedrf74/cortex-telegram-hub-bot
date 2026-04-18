// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { AgentSignal } from './intelligence-bus';

export interface ContentRadarPreferences {
  topics: string[];
  updatedAt: string | null;
}

export interface ContentRadarTopicSummary {
  name: string;
  keywordCount: number;
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS content_radar_preferences (
      user_id INTEGER PRIMARY KEY,
      topics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getContentRadarPreferences(userId: number): ContentRadarPreferences {
  try {
    ensureTable();
    const row = getDb().prepare(`
      SELECT topics_json, updated_at
      FROM content_radar_preferences
      WHERE user_id = ?
      LIMIT 1
    `).get(userId) as { topics_json: string; updated_at: string } | undefined;

    return {
      topics: row ? normalizeTopics(safeJsonArray(row.topics_json)) : [],
      updatedAt: row?.updated_at ?? null,
    };
  } catch (err) {
    logger.debug({ err, userId }, 'content radar preferences lookup failed');
    return { topics: [], updatedAt: null };
  }
}

export function setContentRadarPreferences(userId: number, topics: string[]): ContentRadarPreferences {
  ensureTable();
  const normalizedTopics = normalizeTopics(topics);
  getDb().prepare(`
    INSERT INTO content_radar_preferences (user_id, topics_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      topics_json = excluded.topics_json,
      updated_at = datetime('now')
  `).run(userId, JSON.stringify(normalizedTopics));

  return getContentRadarPreferences(userId);
}

export function filterSignalsForRadarPreferences(
  signals: AgentSignal[],
  topics: string[],
): AgentSignal[] {
  const normalizedTopics = normalizeTopics(topics);
  if (normalizedTopics.length === 0) return signals;

  return signals.filter((signal) => {
    const haystack = foldText(JSON.stringify({
      type: signal.signal_type,
      title: signal.payload?.title,
      topic: signal.payload?.topic,
      keyword: signal.payload?.keyword,
      summary: signal.payload?.summary,
      reason: signal.payload?.reason,
      description: signal.payload?.description,
      observation: signal.payload?.observation,
      note: signal.payload?.note,
      pillar: signal.payload?.pillar,
      channel: signal.payload?.channel,
      reaction_angle: signal.payload?.reaction_angle,
      your_counter_position: signal.payload?.your_counter_position,
    }));

    return normalizedTopics.some((topic) => {
      const foldedTopic = foldText(topic);
      if (haystack.includes(foldedTopic)) return true;
      const tokens = foldedTopic.split(/\s+/).filter((token) => token.length >= 3);
      return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
    });
  });
}

export function buildRadarTopicSummaries(
  topics: string[],
  signals: AgentSignal[],
): ContentRadarTopicSummary[] {
  return normalizeTopics(topics).map((topic) => ({
    name: topic,
    keywordCount: Math.max(1, countSignalMatches(topic, signals)),
  }));
}

function countSignalMatches(topic: string, signals: AgentSignal[]): number {
  const foldedTopic = foldText(topic);
  return signals.reduce((count, signal) => {
    const haystack = foldText(JSON.stringify(signal.payload || {}));
    return haystack.includes(foldedTopic) ? count + 1 : count;
  }, 0);
}

function normalizeTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of topics) {
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const folded = foldText(trimmed);
    if (seen.has(folded)) continue;
    seen.add(folded);
    ordered.push(trimmed);
    if (ordered.length >= 12) break;
  }
  return ordered;
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

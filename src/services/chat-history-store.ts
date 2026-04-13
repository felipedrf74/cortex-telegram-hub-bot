// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';

export interface ChatHistoryWrite {
  userId: number;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  domain?: string | null;
  routeMethod?: string | null;
  confidence?: number | null;
  buttons?: unknown;
  metadata?: unknown;
  timestamp?: string;
}

interface ChatHistoryRow {
  message_uuid: string;
  role: 'user' | 'assistant';
  text: string;
  domain: string | null;
  route_method: string | null;
  confidence: number | null;
  buttons_json: string | null;
  metadata_json: string | null;
  created_at: string;
}

function serializeJSON(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJSON<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function storeChatMessage(entry: ChatHistoryWrite): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO messages (
      user_id,
      message_uuid,
      role,
      text,
      domain,
      route_method,
      confidence,
      buttons_json,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.userId,
    entry.messageId,
    entry.role,
    entry.text,
    entry.domain ?? null,
    entry.routeMethod ?? null,
    entry.confidence ?? null,
    serializeJSON(entry.buttons),
    serializeJSON(entry.metadata),
    entry.timestamp ?? new Date().toISOString(),
  );
}

export function updateAssistantMessage(
  userId: number,
  messageId: string,
  patch: Omit<ChatHistoryWrite, 'userId' | 'messageId' | 'role'> & { text: string },
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE messages
    SET
      text = ?,
      domain = ?,
      route_method = COALESCE(?, route_method),
      confidence = COALESCE(?, confidence),
      buttons_json = ?,
      metadata_json = ?,
      created_at = ?
    WHERE user_id = ? AND message_uuid = ? AND role = 'assistant'
  `).run(
    patch.text,
    patch.domain ?? null,
    patch.routeMethod ?? null,
    patch.confidence ?? null,
    serializeJSON(patch.buttons),
    serializeJSON(patch.metadata),
    patch.timestamp ?? new Date().toISOString(),
    userId,
    messageId,
  );
  return result.changes > 0;
}

export function listChatMessages(userId: number, limit: number, before?: string) {
  const db = getDb();

  let query = `
    SELECT message_uuid, role, text, domain, route_method, confidence, buttons_json, metadata_json, created_at
    FROM messages
    WHERE user_id = ?
  `;
  const params: Array<string | number> = [userId];

  if (before) {
    query += ' AND created_at < ?';
    params.push(before);
  }

  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.prepare(query).all(...params) as ChatHistoryRow[];
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit).reverse();

  return {
    messages: visibleRows.map((row) => ({
      id: row.message_uuid,
      text: row.text,
      role: row.role,
      domain: row.domain,
      routeMethod: row.route_method,
      confidence: row.confidence,
      timestamp: row.created_at,
      buttons: parseJSON(row.buttons_json),
      metadata: parseJSON(row.metadata_json),
    })),
    cursor: hasMore ? rows[limit]?.created_at ?? null : null,
    hasMore,
  };
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';

export interface UserScopedYoutubeChannelTarget {
  userId: number;
  tenantId: number;
  channelId: string;
}

const OWN_CHANNEL_ADDED_VIA = new Set([
  'own_channel',
  'creator_channel',
  'user_channel',
  'youtube_oauth',
  'ios_own_channel',
]);

function hasColumn(table: string, column: string): boolean {
  try {
    const db = getDb();
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row: any) => row?.name === column);
  } catch {
    return false;
  }
}

function rowLooksLikeOwnChannel(row: {
  added_via?: string | null;
  source_metadata_json?: string | null;
}): boolean {
  const addedVia = String(row.added_via ?? '').trim().toLowerCase();
  if (OWN_CHANNEL_ADDED_VIA.has(addedVia)) return true;

  const metadata = String(row.source_metadata_json ?? '').toLowerCase();
  return metadata.includes('own_channel')
    || metadata.includes('creator_channel')
    || metadata.includes('authenticated_creator')
    || metadata.includes('youtube_oauth');
}

export function listUserScopedYoutubeChannelTargets(): UserScopedYoutubeChannelTarget[] {
  try {
    const db = getDb();
    const hasMetadata = hasColumn('content_ref_channels', 'source_metadata_json');
    const rows = db.prepare(`
      SELECT
        user_id,
        COALESCE(tenant_id, owner_user_id, user_id) AS tenant_id,
        channel_id,
        added_via
        ${hasMetadata ? ', source_metadata_json' : ''}
      FROM content_ref_channels
      WHERE user_id > 0
        AND channel_id IS NOT NULL
        AND TRIM(channel_id) <> ''
        AND status = 'active'
    `).all() as Array<{
      user_id: number;
      tenant_id: number | null;
      channel_id: string;
      added_via?: string | null;
      source_metadata_json?: string | null;
    }>;

    const targets = rows
      .filter(rowLooksLikeOwnChannel)
      .map((row) => ({
        userId: row.user_id,
        tenantId: row.tenant_id && row.tenant_id > 0 ? row.tenant_id : row.user_id,
        channelId: row.channel_id.trim(),
      }));

    const deduped = new Map<string, UserScopedYoutubeChannelTarget>();
    for (const target of targets) {
      deduped.set(`${target.tenantId}:${target.userId}:${target.channelId}`, target);
    }
    return Array.from(deduped.values());
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve user-scoped YouTube channel targets');
    return [];
  }
}

export function resolveUserScopedYoutubeChannelId(userId: number, tenantId?: number | null): string | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const targets = listUserScopedYoutubeChannelTargets();
  const match = targets.find((target) => (
    target.userId === userId
    && (tenantId == null || tenantId <= 0 || target.tenantId === tenantId)
  ));
  return match?.channelId ?? null;
}


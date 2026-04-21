// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';

export type FiscalCollectionCadence = 'monthly' | 'twice_monthly';

export interface FiscalCollectionProfileRow {
  user_id: number;
  destination_email: string | null;
  cadence: FiscalCollectionCadence;
  primary_day: number;
  secondary_day: number | null;
  enabled: number;
  last_bundle_sent_at: string | null;
  last_bundle_document_count: number;
  created_at: string;
  updated_at: string;
}

const DEFAULT_CADENCE: FiscalCollectionCadence = 'monthly';
const DEFAULT_PRIMARY_DAY = 28;

function normalizeDay(day: number | null | undefined): number | null {
  if (day == null) return null;
  const safe = Math.floor(day);
  if (!Number.isFinite(safe)) return null;
  return Math.max(1, Math.min(28, safe));
}

export function getFiscalCollectionProfile(userId: number): FiscalCollectionProfileRow | null {
  const db = getDb();
  return (
    db.prepare('SELECT * FROM fiscal_collection_profiles WHERE user_id = ?').get(userId) as FiscalCollectionProfileRow | undefined
  ) ?? null;
}

export function getOrCreateFiscalCollectionProfile(userId: number): FiscalCollectionProfileRow {
  const existing = getFiscalCollectionProfile(userId);
  if (existing) return existing;

  const db = getDb();
  db.prepare(`
    INSERT INTO fiscal_collection_profiles (
      user_id, destination_email, cadence, primary_day, secondary_day, enabled
    ) VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    userId,
    null,
    DEFAULT_CADENCE,
    DEFAULT_PRIMARY_DAY,
    null,
  );

  return getFiscalCollectionProfile(userId)!;
}

export function updateFiscalCollectionProfile(
  userId: number,
  patch: {
    destination_email?: string | null;
    cadence?: FiscalCollectionCadence;
    primary_day?: number | null;
    secondary_day?: number | null;
    enabled?: boolean;
    last_bundle_sent_at?: string | null;
    last_bundle_document_count?: number;
  },
): FiscalCollectionProfileRow {
  const current = getOrCreateFiscalCollectionProfile(userId);

  const cadence = patch.cadence ?? current.cadence;
  const primaryDay = normalizeDay(patch.primary_day ?? current.primary_day) ?? DEFAULT_PRIMARY_DAY;
  const secondaryDay = cadence === 'twice_monthly'
    ? normalizeDay(patch.secondary_day ?? current.secondary_day ?? 15)
    : null;

  const db = getDb();
  db.prepare(`
    UPDATE fiscal_collection_profiles
    SET
      destination_email = ?,
      cadence = ?,
      primary_day = ?,
      secondary_day = ?,
      enabled = ?,
      last_bundle_sent_at = ?,
      last_bundle_document_count = ?,
      updated_at = datetime('now')
    WHERE user_id = ?
  `).run(
    patch.destination_email !== undefined ? patch.destination_email : current.destination_email,
    cadence,
    primaryDay,
    secondaryDay,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
    patch.last_bundle_sent_at !== undefined ? patch.last_bundle_sent_at : current.last_bundle_sent_at,
    patch.last_bundle_document_count !== undefined
      ? Math.max(0, patch.last_bundle_document_count)
      : current.last_bundle_document_count,
    userId,
  );

  return getFiscalCollectionProfile(userId)!;
}

export function listActiveFiscalCollectionProfiles(): FiscalCollectionProfileRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM fiscal_collection_profiles
    WHERE enabled = 1
    ORDER BY updated_at DESC
  `).all() as FiscalCollectionProfileRow[];
}

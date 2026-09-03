// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SEO Tracking Agent compatibility surface.
 *
 * Runtime rank tracking remains paused until keyword storage and intelligence
 * signals are tenant-user scoped. The exports stay in place for scheduler and
 * command compatibility, but none of the paused paths mutate `seo_keywords`.
 */

import { logAgentRun } from '../services/intelligence-bus';
import { logger } from '../utils/logger';
import { safeContentLogErrorFields } from '../services/content-log-safety';

// ── Seed Keywords on Startup ─────────────────────────────────────────

export function seedKeywordsIfEmpty(): void {
  // Compatibility export only. The legacy table is platform-global, so a
  // paused tenant-scoped feature must not seed or otherwise mutate it.
  logger.debug('SEO keyword seed skipped while tenant-user scoped rank storage is unavailable');
}

// ── Main Agent Runner ────────────────────────────────────────────────

export async function runSEOAgent(): Promise<void> {
  const start = Date.now();

  try {
    // SEO keyword tables and content-mesh rank-change signals are currently
    // platform-global. Until both are user/tenant scoped, fail closed rather
    // than recording one creator's YouTube ranks where another creator can
    // read them.
    logger.warn('SEO Agent paused: user-scoped SEO rank storage/signals are not supported yet');
    logAgentRun('seo-agent', 'skipped', 0, 0, Date.now() - start, 'User-scoped SEO rank storage/signals not supported yet');
    return;

    // Unreachable keyword-check/signal body removed 2026-07-03 (audit item
    // #10): the fail-closed pause above has been permanent since the
    // user-scoping decision. Recover the implementation from git history
    // when user/tenant-scoped SEO rank storage ships.
  } catch (err: unknown) {
    const { errorName } = safeContentLogErrorFields(err);
    logAgentRun('seo-agent', 'error', 0, 0, Date.now() - start, errorName);
    logger.error({ errorName }, 'SEO Agent failed');
    throw err;
  }
}

// ── Bot Command: /seokeyword ─────────────────────────────────────────

export async function handleAddSEOKeyword(ctx: any): Promise<void> {
  await ctx.reply(
    '⏸️ YouTube SEO rank tracking is paused until keyword storage and signals are tenant-user scoped. No keyword was saved.',
    { parse_mode: 'HTML' },
  );
}

// ── Bot Command: /seorank ────────────────────────────────────────────

export async function handleSEORank(ctx: any): Promise<void> {
  await ctx.reply(
    '⏸️ YouTube SEO rankings are paused until keyword storage and signals are tenant-user scoped. No global rankings are available.',
    { parse_mode: 'HTML' },
  );
}

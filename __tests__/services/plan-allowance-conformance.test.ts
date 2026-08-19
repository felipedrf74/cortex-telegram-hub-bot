// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * QA5 P1-5: the seeded plan allowances must match the plan-locked §2 table.
 * Migration 284 seeded daily long-form scripts at Pro 6 / Max 20 against a
 * locked Pro 2 / Max 4 — a 3x/5x over-grant on the most expensive operation
 * class, and the numbers the §4 economics simulation would have modelled.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let db: Database.Database;

beforeEach(() => {
  db = createMigratedTestDatabase();
});

afterEach(() => {
  db.close();
});

// Plan §2 (docs/release/hybrid-ai-commerce-production-plan.md).
const PLAN_LOCKED_ALLOWANCES = [
  { plan: 'free', monthlyCredits: 60, dailyCap: 5, longformDaily: 0, activeJobs: 0 },
  { plan: 'pro', monthlyCredits: 500, dailyCap: 50, longformDaily: 2, activeJobs: 1 },
  { plan: 'max', monthlyCredits: 1200, dailyCap: 100, longformDaily: 4, activeJobs: 2 },
] as const;

describe('plan allowance conformance (QA5 P1-5)', () => {
  it('seeds every plan exactly as the §2 table locks it', () => {
    for (const expected of PLAN_LOCKED_ALLOWANCES) {
      const row = db.prepare(`SELECT monthly_ai_credits, daily_ai_credit_cap,
          longform_scripts_daily, active_content_jobs
        FROM plan_configs WHERE plan_id = ?`).get(expected.plan) as {
          monthly_ai_credits: number;
          daily_ai_credit_cap: number;
          longform_scripts_daily: number;
          active_content_jobs: number;
        };
      expect(row, `plan_configs row for ${expected.plan}`).toBeDefined();
      expect({
        plan: expected.plan,
        monthlyCredits: row.monthly_ai_credits,
        dailyCap: row.daily_ai_credit_cap,
        longformDaily: row.longform_scripts_daily,
        activeJobs: row.active_content_jobs,
      }).toEqual(expected);
    }
  });

  it('pins the compiled fallback to the same allowance as the seed', () => {
    // Governance pin, not a behavioral test: the compiled fallback in
    // planLimits() applies only when a plan_configs row is missing or
    // malformed, and correcting only the DB row would leave that path
    // handing out the old 6/20. Read the literals from source so the two
    // cannot drift apart again.
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'services', 'content-script-jobs.ts'),
      'utf8',
    );
    const fallbackBlock = source.slice(
      source.indexOf('const fallback = entitlement.plan'),
      source.indexOf('const row = db.prepare(`SELECT active_content_jobs'),
    );
    expect(fallbackBlock).toContain("'max' ? { active: 2, daily: 4");
    expect(fallbackBlock).toContain('{ active: 1, daily: 2');
    expect(fallbackBlock).not.toMatch(/daily: (6|20)\b/);
  });
});

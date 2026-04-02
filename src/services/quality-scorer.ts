// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Quality Scorer — evaluates agent output against objective criteria.
 *
 * Phase 1: Automated checks (tests, types, lint, file changes)
 * Phase 2 (future): AI-assisted scoring via Claude Haiku
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { execSync } from 'child_process';

export interface QualityReport {
  testsPassing: boolean;
  typesClean: boolean;
  lintClean: boolean;
  filesChanged: number;
  testCoverage: number | null;
  overallScore: number;
  details: Record<string, unknown>;
}

/**
 * Run automated quality checks on the current working directory.
 * Call this AFTER an agent completes work but BEFORE marking as done.
 */
export function runQualityChecks(workDir: string): QualityReport {
  const details: Record<string, unknown> = {};

  // 1. Tests passing?
  let testsPassing = false;
  try {
    execSync('npx vitest run --reporter=dot 2>&1', { cwd: workDir, timeout: 120000 });
    testsPassing = true;
    details.tests = 'all passing';
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer };
    details.tests = err.stdout?.toString().slice(-200) ?? 'failed';
  }

  // 2. Types clean?
  let typesClean = false;
  try {
    execSync('npx tsc --noEmit 2>&1', { cwd: workDir, timeout: 60000 });
    typesClean = true;
    details.types = 'clean';
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer };
    details.types = err.stdout?.toString().slice(-200) ?? 'errors';
  }

  // 3. Lint clean? (skip if no eslint config)
  let lintClean = false;
  try {
    execSync('npx eslint src/ --quiet 2>&1', { cwd: workDir, timeout: 30000 });
    lintClean = true;
    details.lint = 'clean';
  } catch (e: unknown) {
    const err = e as { message?: string; stdout?: Buffer };
    if (err.message?.includes('No ESLint configuration') || err.message?.includes('eslint: not found')) {
      lintClean = true;
      details.lint = 'skipped (no config)';
    } else {
      details.lint = err.stdout?.toString().slice(-200) ?? 'errors';
    }
  }

  // 4. Files changed (from last commit)
  let filesChanged = 0;
  try {
    const diff = execSync('git diff --name-only HEAD~1 2>/dev/null || echo ""', {
      cwd: workDir, timeout: 5000
    }).toString().trim();
    filesChanged = diff ? diff.split('\n').length : 0;
    details.filesChanged = filesChanged;
  } catch {
    details.filesChanged = 'unknown';
  }

  // 5. Test coverage — skipped in Phase 1 for speed
  const testCoverage: number | null = null;

  // ── Composite score ──
  // Weights: tests 40%, types 30%, lint 20%, files changed 10% (at least some work done)
  let score = 0;
  if (testsPassing) score += 40;
  if (typesClean) score += 30;
  if (lintClean) score += 20;
  if (filesChanged > 0) score += 10;

  return {
    testsPassing,
    typesClean,
    lintClean,
    filesChanged,
    testCoverage,
    overallScore: score,
    details,
  };
}

/**
 * Persist a quality score to the database.
 */
export function saveQualityScore(
  executionId: number | null,
  notionTaskId: string,
  agent: string,
  report: QualityReport
): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO quality_scores
      (execution_id, notion_task_id, agent, tests_passing, types_clean, lint_clean, files_changed, test_coverage, overall_score, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    executionId,
    notionTaskId,
    agent,
    report.testsPassing ? 1 : 0,
    report.typesClean ? 1 : 0,
    report.lintClean ? 1 : 0,
    report.filesChanged,
    report.testCoverage,
    report.overallScore,
    JSON.stringify(report.details)
  );
  logger.info({ notionTaskId, agent, score: report.overallScore }, 'Quality score saved');
  return Number(result.lastInsertRowid);
}

/**
 * Get average quality scores by agent for the portal dashboard.
 */
export function getQualityByAgent(days: number = 30): Array<{
  agent: string;
  avgScore: number;
  totalTasks: number;
  passRate: number;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT
      agent,
      AVG(overall_score) as avgScore,
      COUNT(*) as totalTasks,
      AVG(CASE WHEN tests_passing = 1 AND types_clean = 1 THEN 1.0 ELSE 0.0 END) as passRate
    FROM quality_scores
    WHERE ts >= datetime('now', '-' || ? || ' days')
    GROUP BY agent
    ORDER BY avgScore DESC
  `).all(days) as Array<{ agent: string; avgScore: number; totalTasks: number; passRate: number }>;
}

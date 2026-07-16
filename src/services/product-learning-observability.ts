// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  TRAINING_LEARNING_KIND_VALUES,
  type LearningCaseLifecycle,
  type TrainingLearningKind,
} from './product-learning';

export const PRODUCT_LEARNING_OBSERVABILITY_SCHEMA = 'product-learning-observability.v1' as const;

const LIFECYCLES: readonly LearningCaseLifecycle[] = [
  'observed',
  'candidate',
  'reviewed',
  'golden',
  'retired',
];

export interface ProductLearningCategoryMetric {
  kind: TrainingLearningKind;
  observedCount: number;
  activeCount: number;
  historicalCount: number;
  staleCount: number;
  lastObservedAt: string | null;
  lifecycleCounts: Record<LearningCaseLifecycle, number>;
  outcomeCounts: Record<string, number>;
}

export interface ProductLearningFeedbackMetric {
  adaptationAccepted: number;
  adaptationDismissed: number;
  acceptanceRate: number | null;
}

export interface ProductLearningCoverageMetric {
  observedCategories: number;
  totalCategories: number;
  missingCategories: TrainingLearningKind[];
}

export interface ProductLearningActivityMetric {
  cases: number;
  lifecycleCounts: Record<LearningCaseLifecycle, number>;
  feedback: ProductLearningFeedbackMetric;
  coverage: ProductLearningCoverageMetric;
}

export interface ProductLearningObservabilityReadModel {
  schemaVersion: typeof PRODUCT_LEARNING_OBSERVABILITY_SCHEMA;
  generatedAt: string;
  schemaAvailable: boolean;
  scope: { tenantId: number | null };
  totals: {
    cases: number;
    activeCases: number;
    historicalCases: number;
    retiredCases: number;
    staleCases: number;
    exportEligibleGoldenCases: number;
    promotions: number;
  };
  lifecycleCounts: Record<LearningCaseLifecycle, number>;
  transitionCounts: Record<string, number>;
  feedback: ProductLearningFeedbackMetric;
  coverage: ProductLearningCoverageMetric;
  activity: {
    active: ProductLearningActivityMetric;
    historical: ProductLearningActivityMetric;
  };
  categories: ProductLearningCategoryMetric[];
}

interface TotalRow {
  cases: number;
  activeCases: number | null;
  historicalCases: number | null;
  retiredCases: number | null;
  staleCases: number | null;
  exportEligibleGoldenCases: number | null;
}

interface LifecycleRow {
  lifecycle: LearningCaseLifecycle;
  count: number;
  activeCount: number | null;
}

interface CategoryRow {
  kind: string;
  outcomeCode: string;
  lifecycle: LearningCaseLifecycle;
  count: number;
  activeCount: number | null;
  staleCount: number | null;
  lastObservedAt: string | null;
}

interface TransitionRow {
  fromLifecycle: LearningCaseLifecycle | null;
  toLifecycle: LearningCaseLifecycle;
  count: number;
}

function zeroLifecycleCounts(): Record<LearningCaseLifecycle, number> {
  return { observed: 0, candidate: 0, reviewed: 0, golden: 0, retired: 0 };
}

function zeroFeedback(): ProductLearningFeedbackMetric {
  return { adaptationAccepted: 0, adaptationDismissed: 0, acceptanceRate: null };
}

function emptyCoverage(): ProductLearningCoverageMetric {
  return {
    observedCategories: 0,
    totalCategories: TRAINING_LEARNING_KIND_VALUES.length,
    missingCategories: [...TRAINING_LEARNING_KIND_VALUES],
  };
}

function emptyActivity(): ProductLearningActivityMetric {
  return {
    cases: 0,
    lifecycleCounts: zeroLifecycleCounts(),
    feedback: zeroFeedback(),
    coverage: emptyCoverage(),
  };
}

function emptyReadModel(generatedAt: string, tenantId: number | null): ProductLearningObservabilityReadModel {
  return {
    schemaVersion: PRODUCT_LEARNING_OBSERVABILITY_SCHEMA,
    generatedAt,
    schemaAvailable: false,
    scope: { tenantId },
    totals: {
      cases: 0,
      activeCases: 0,
      historicalCases: 0,
      retiredCases: 0,
      staleCases: 0,
      exportEligibleGoldenCases: 0,
      promotions: 0,
    },
    lifecycleCounts: zeroLifecycleCounts(),
    transitionCounts: {},
    feedback: zeroFeedback(),
    coverage: emptyCoverage(),
    activity: { active: emptyActivity(), historical: emptyActivity() },
    categories: TRAINING_LEARNING_KIND_VALUES.map((kind) => ({
      kind,
      observedCount: 0,
      activeCount: 0,
      historicalCount: 0,
      staleCount: 0,
      lastObservedAt: null,
      lifecycleCounts: zeroLifecycleCounts(),
      outcomeCounts: {},
    })),
  };
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

export function buildProductLearningObservabilityReadModel(input: {
  tenantId?: number;
  now?: Date;
  db?: Database.Database;
} = {}): ProductLearningObservabilityReadModel {
  if (input.tenantId != null && (!Number.isInteger(input.tenantId) || input.tenantId <= 0)) {
    throw new Error('product learning observability tenant scope must be a positive integer');
  }
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('product learning observability clock is invalid');
  const generatedAt = now.toISOString();
  const tenantId = input.tenantId ?? null;
  const empty = emptyReadModel(generatedAt, tenantId);
  if (!tableExists(db, 'product_learning_cases')
      || !tableExists(db, 'product_learning_case_transitions')) return empty;

  const tenantPredicate = tenantId == null ? '' : ' AND tenant_id = ?';
  const totalParams = tenantId == null
    ? [generatedAt, generatedAt, generatedAt, generatedAt]
    : [generatedAt, generatedAt, generatedAt, generatedAt, tenantId];
  const total = db.prepare(`
    SELECT COUNT(*) AS cases,
           SUM(CASE WHEN lifecycle <> 'retired' AND datetime(expires_at) > datetime(?) THEN 1 ELSE 0 END) AS activeCases,
           SUM(CASE WHEN lifecycle = 'retired' OR datetime(expires_at) <= datetime(?) THEN 1 ELSE 0 END) AS historicalCases,
           SUM(CASE WHEN lifecycle = 'retired' THEN 1 ELSE 0 END) AS retiredCases,
           SUM(CASE WHEN lifecycle <> 'retired' AND datetime(expires_at) <= datetime(?) THEN 1 ELSE 0 END) AS staleCases,
           SUM(CASE WHEN lifecycle = 'golden'
                     AND privacy_class <> 'sensitive-no-export'
                     AND datetime(expires_at) > datetime(?) THEN 1 ELSE 0 END) AS exportEligibleGoldenCases
      FROM product_learning_cases
     WHERE owner = 'training'${tenantPredicate}
  `).get(...totalParams) as TotalRow;

  const lifecycleParams = tenantId == null ? [generatedAt] : [generatedAt, tenantId];
  const lifecycleRows = db.prepare(`
    SELECT lifecycle,
           COUNT(*) AS count,
           SUM(CASE WHEN lifecycle <> 'retired' AND datetime(expires_at) > datetime(?) THEN 1 ELSE 0 END) AS activeCount
      FROM product_learning_cases
     WHERE owner = 'training'${tenantPredicate}
     GROUP BY lifecycle
  `).all(...lifecycleParams) as LifecycleRow[];
  const lifecycleCounts = zeroLifecycleCounts();
  const activeLifecycleCounts = zeroLifecycleCounts();
  const historicalLifecycleCounts = zeroLifecycleCounts();
  for (const row of lifecycleRows) {
    if (!LIFECYCLES.includes(row.lifecycle)) continue;
    const count = Number(row.count);
    const activeCount = Number(row.activeCount ?? 0);
    lifecycleCounts[row.lifecycle] = count;
    activeLifecycleCounts[row.lifecycle] = activeCount;
    historicalLifecycleCounts[row.lifecycle] = count - activeCount;
  }

  const categoryParams = tenantId == null
    ? [generatedAt, generatedAt]
    : [generatedAt, generatedAt, tenantId];
  const categoryRows = db.prepare(`
    SELECT json_extract(redacted_input_json, '$.kind') AS kind,
           json_extract(redacted_input_json, '$.outcomeCode') AS outcomeCode,
           lifecycle,
           COUNT(*) AS count,
           SUM(CASE WHEN lifecycle <> 'retired' AND datetime(expires_at) > datetime(?) THEN 1 ELSE 0 END) AS activeCount,
           SUM(CASE WHEN lifecycle <> 'retired' AND datetime(expires_at) <= datetime(?) THEN 1 ELSE 0 END) AS staleCount,
           MAX(observed_at) AS lastObservedAt
      FROM product_learning_cases
     WHERE owner = 'training'${tenantPredicate}
     GROUP BY kind, outcomeCode, lifecycle
  `).all(...categoryParams) as CategoryRow[];
  const categoryByKind = new Map<TrainingLearningKind, ProductLearningCategoryMetric>(
    empty.categories.map((metric) => [metric.kind, metric]),
  );
  for (const row of categoryRows) {
    if (!(TRAINING_LEARNING_KIND_VALUES as readonly string[]).includes(row.kind)) continue;
    const metric = categoryByKind.get(row.kind as TrainingLearningKind)!;
    const count = Number(row.count);
    const activeCount = Number(row.activeCount ?? 0);
    metric.observedCount += count;
    metric.activeCount += activeCount;
    metric.historicalCount += count - activeCount;
    metric.staleCount += Number(row.staleCount ?? 0);
    metric.lifecycleCounts[row.lifecycle] += count;
    metric.outcomeCounts[row.outcomeCode] = (metric.outcomeCounts[row.outcomeCode] ?? 0) + count;
    if (row.lastObservedAt && (!metric.lastObservedAt || row.lastObservedAt > metric.lastObservedAt)) {
      metric.lastObservedAt = row.lastObservedAt;
    }
  }

  const transitionTenantPredicate = tenantId == null ? '' : ' AND transitions.tenant_id = ?';
  const transitionRows = db.prepare(`
    SELECT transitions.from_lifecycle AS fromLifecycle,
           transitions.to_lifecycle AS toLifecycle,
           COUNT(*) AS count
      FROM product_learning_case_transitions transitions
      JOIN product_learning_cases cases
        ON cases.tenant_id = transitions.tenant_id
       AND cases.user_id = transitions.user_id
       AND cases.case_id = transitions.case_id
     WHERE cases.owner = 'training'${transitionTenantPredicate}
     GROUP BY transitions.from_lifecycle, transitions.to_lifecycle
  `).all(...(tenantId == null ? [] : [tenantId])) as TransitionRow[];
  const transitionCounts: Record<string, number> = {};
  let promotions = 0;
  for (const row of transitionRows) {
    const key = `${row.fromLifecycle ?? 'none'}_to_${row.toLifecycle}`;
    transitionCounts[key] = Number(row.count);
    if (row.fromLifecycle != null && ['candidate', 'reviewed', 'golden'].includes(row.toLifecycle)) {
      promotions += Number(row.count);
    }
  }

  const categories = TRAINING_LEARNING_KIND_VALUES.map((kind) => categoryByKind.get(kind)!);
  const feedbackFor = (field: 'observedCount' | 'activeCount' | 'historicalCount'): ProductLearningFeedbackMetric => {
    const adaptationAccepted = categoryByKind.get('adaptation_accepted')![field];
    const adaptationDismissed = categoryByKind.get('adaptation_rejected')![field];
    const feedbackTotal = adaptationAccepted + adaptationDismissed;
    return {
      adaptationAccepted,
      adaptationDismissed,
      acceptanceRate: feedbackTotal === 0 ? null : adaptationAccepted / feedbackTotal,
    };
  };
  const coverageFor = (field: 'observedCount' | 'activeCount' | 'historicalCount'): ProductLearningCoverageMetric => {
    const missingCategories = categories.filter((metric) => metric[field] === 0).map((metric) => metric.kind);
    return {
      observedCategories: categories.length - missingCategories.length,
      totalCategories: categories.length,
      missingCategories,
    };
  };
  const feedback = feedbackFor('observedCount');
  const coverage = coverageFor('observedCount');
  return {
    schemaVersion: PRODUCT_LEARNING_OBSERVABILITY_SCHEMA,
    generatedAt,
    schemaAvailable: true,
    scope: { tenantId },
    totals: {
      cases: Number(total.cases ?? 0),
      activeCases: Number(total.activeCases ?? 0),
      historicalCases: Number(total.historicalCases ?? 0),
      retiredCases: Number(total.retiredCases ?? 0),
      staleCases: Number(total.staleCases ?? 0),
      exportEligibleGoldenCases: Number(total.exportEligibleGoldenCases ?? 0),
      promotions,
    },
    lifecycleCounts,
    transitionCounts,
    feedback,
    coverage,
    activity: {
      active: {
        cases: Number(total.activeCases ?? 0),
        lifecycleCounts: activeLifecycleCounts,
        feedback: feedbackFor('activeCount'),
        coverage: coverageFor('activeCount'),
      },
      historical: {
        cases: Number(total.historicalCases ?? 0),
        lifecycleCounts: historicalLifecycleCounts,
        feedback: feedbackFor('historicalCount'),
        coverage: coverageFor('historicalCount'),
      },
    },
    categories,
  };
}

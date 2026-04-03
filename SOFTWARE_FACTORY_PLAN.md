# SOFTWARE_FACTORY_PLAN.md — Implementation Spec

> **Owner:** Felipe Dominguez  
> **Executor:** Claude Code (single agent, sequential)  
> **Repo:** `nexus-hub`  
> **Branch strategy:** Create `feature/software-factory` from `develop`. One commit per task (SF-01 through SF-05).

⚠️ **Read CLAUDE.md and CODEBASE.md before starting. Follow all existing conventions: copyright headers, logger usage, SQLite via `getDb()`, telemetry via `pushEvent()`.**

---

## Execution Order

| # | Task | Files Touched | Estimated Scope |
|---|------|---------------|-----------------|
| SF-01 | Shift QA Left | `scripts/setup-hooks.sh`, `CLAUDE.md` | Config + docs |
| SF-02 | Blocked-by Dependencies | `scripts/dispatch-task.js`, `scripts/mission-control.js` | Light logic |
| SF-03 | Cost + Duration Tracking | `migrations/026_task_execution_metrics.sql`, `src/services/task-metrics.ts`, `src/portal/portal.html`, `src/portal/server.ts` | New service + portal |
| SF-04 | Structured Error Categorization | `src/services/error-categorizer.ts`, `scripts/dispatch-task.js` or wherever retry logic lives | New service + integration |
| SF-05 | Agent Output Quality Scoring | `migrations/027_quality_scores.sql`, `src/services/quality-scorer.ts`, `src/portal/portal.html` | New service + portal |

---

## SF-01 · Shift QA Left — Decentralized Testing per Agent

### What
Every code commit must pass `vitest` + `tsc` BEFORE reaching QA. This is enforced at the git hook level.

### Current State
- `scripts/setup-hooks.sh` installs pre-commit (tsc only) and pre-push (tsc + vitest)
- Pre-commit does NOT run vitest — only type check
- CLAUDE.md tells agents to run `npx vitest run && npx tsc --noEmit` but it's advisory, not enforced

### Implementation

#### 1. Update `scripts/setup-hooks.sh`

Modify the pre-commit hook to also run vitest:

```bash
# ── Pre-commit hook ──────────────────────────────────
cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/usr/bin/env bash
set -e

echo "🔍 Pre-commit: Type checking..."
npx tsc --noEmit 2>/dev/null
echo "✅ Type check passed"

echo "🧪 Pre-commit: Running tests..."
npx vitest run --reporter=dot 2>/dev/null
echo "✅ Tests passed"

echo "📝 Pre-commit: Linting..."
npx eslint src/ --quiet 2>/dev/null || true
echo "✅ Lint complete"
HOOK
chmod +x "$HOOKS_DIR/pre-commit"
```

> **Note on ESLint:** If eslint is not currently configured in the project, add `|| true` so it doesn't block. Check `package.json` for an existing eslint config. If none exists, skip the lint step entirely and leave a `# TODO: add eslint` comment.

#### 2. Update `CLAUDE.md`

In the `### CRITICAL RULES` section, add:

```markdown
### QA LEFT-SHIFT POLICY
- **Pre-commit hooks enforce tests** — `vitest run` + `tsc --noEmit` run automatically on every commit
- **QA agent handles integration/E2E testing only** — unit test failures are the committing agent's responsibility
- **Do NOT use `--no-verify`** unless explicitly authorized by Felipe
- If tests fail, fix them before committing. Do not skip.
```

#### 3. Re-run setup-hooks

After editing `setup-hooks.sh`, run it to apply:

```bash
bash scripts/setup-hooks.sh
```

### Verification
```bash
# Create a deliberately broken test, attempt commit — should fail
echo 'test("fail", () => { expect(1).toBe(2) })' > __tests__/temp-fail.test.ts
git add -A && git commit -m "test: verify hook blocks"
# Expected: commit rejected with test failure
rm __tests__/temp-fail.test.ts
```

---

## SF-02 · Add blocked_by — Lightweight Task Dependencies

### What
The Notion Development Board task dispatcher should skip tasks that have unresolved blockers.

### Current State
- `scripts/dispatch-task.js` queries the Notion board for tasks in "To Do" status and assigns them
- `scripts/mission-control.js` orchestrates the loop
- No dependency awareness exists — tasks are dispatched purely by priority

### Implementation

#### 1. Add `Blocked By` property to Notion board

This must be done **manually by Felipe in Notion UI** because the API cannot add relation properties to an existing database schema.

**Steps for Felipe:**
1. Open the Development Board in Notion
2. Add a new property: name = `Blocked By`, type = `Relation`, relates to = same database (self-referencing)
3. Save

#### 2. Update `scripts/dispatch-task.js`

After fetching candidate tasks from Notion, add a filter step:

```javascript
// ── Dependency check ─────────────────────────────────
// After fetching tasks with status "To Do", filter out blocked ones

async function isTaskBlocked(task) {
  const blockedByRelation = task.properties?.['Blocked By']?.relation || [];
  if (blockedByRelation.length === 0) return false;

  // Check if ALL blockers are Done
  for (const ref of blockedByRelation) {
    const blockerPage = await notion.pages.retrieve({ page_id: ref.id });
    const blockerStatus = blockerPage.properties?.Status?.select?.name;
    if (blockerStatus !== 'Done') {
      console.log(`  ⏸ Task "${task.properties.Task.title[0]?.plain_text}" blocked by incomplete task ${ref.id}`);
      return true;
    }
  }
  return false;
}

// In the main dispatch flow, after fetching candidates:
const eligibleTasks = [];
for (const task of candidates) {
  if (!(await isTaskBlocked(task))) {
    eligibleTasks.push(task);
  }
}
// Continue dispatching from eligibleTasks instead of candidates
```

**Integration point:** Find where `dispatch-task.js` queries Notion for "To Do" tasks and filters them. Insert the `isTaskBlocked` check between the query and the assignment. The exact location depends on the current code structure — read the file first.

#### 3. Update `scripts/mission-control.js`

Same pattern: wherever mission-control picks the next task, add the blocked check. If mission-control delegates to dispatch-task.js, the change in step 2 may be sufficient.

### Verification
```bash
# Create two test tasks in Notion:
# Task A: "Test Blocker" — Status: To Do
# Task B: "Test Dependent" — Status: To Do, Blocked By: Task A
# Run dispatch — Task B should NOT be assigned
# Move Task A to Done — Run dispatch again — Task B should now be eligible
```

---

## SF-03 · Cost + Duration Tracking per Task Execution

### What
Track API token cost and wall-clock duration for every task execution cycle (not per individual API call — that already exists in `api_usage`). This is aggregate tracking: "Task X cost $0.42 and took 3 minutes across 7 API calls."

### Current State
- `src/portal/anthropic-hook.ts` already tracks per-API-call cost in the `api_usage` table
- `src/services/usage-metering.ts` tracks per-user daily aggregates
- **Missing:** per-task-execution aggregate that ties API calls to a specific Notion task

### Implementation

#### 1. Create migration `migrations/026_task_execution_metrics.sql`

```sql
-- Migration 026: Per-task execution metrics for Software Factory observability
CREATE TABLE IF NOT EXISTS task_execution_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  notion_task_id  TEXT NOT NULL,               -- Notion page ID of the task
  task_title      TEXT NOT NULL,               -- Human-readable task name
  agent           TEXT NOT NULL,               -- Which agent executed (backend, qa, devops, etc.)
  status          TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed'
  start_time      TEXT NOT NULL,               -- ISO 8601
  end_time        TEXT,                        -- ISO 8601, NULL while running
  duration_ms     INTEGER,                     -- Wall-clock duration
  api_calls       INTEGER NOT NULL DEFAULT 0,  -- Number of Anthropic API calls
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,     -- Total cost for this task execution
  error_message   TEXT,                        -- If failed, why
  retry_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_task_exec_ts ON task_execution_metrics (ts);
CREATE INDEX IF NOT EXISTS idx_task_exec_notion ON task_execution_metrics (notion_task_id);
CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_execution_metrics (agent);
CREATE INDEX IF NOT EXISTS idx_task_exec_status ON task_execution_metrics (status);

-- Rollback: DROP TABLE IF EXISTS task_execution_metrics;
```

#### 2. Create `src/services/task-metrics.ts`

Follow the pattern of `src/services/usage-metering.ts`:

```typescript
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task Execution Metrics — tracks cost and duration per Notion task execution.
 *
 * Aggregates API usage (from anthropic-hook.ts) at the task level.
 * Provides data for the portal dashboard and SaaS pricing decisions.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export interface TaskExecution {
  id?: number;
  notionTaskId: string;
  taskTitle: string;
  agent: string;
  status: 'running' | 'success' | 'failed';
  startTime: string;
  endTime?: string;
  durationMs?: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  errorMessage?: string;
  retryCount: number;
}

/**
 * Start tracking a task execution. Returns the row ID for later update.
 */
export function startTaskExecution(notionTaskId: string, taskTitle: string, agent: string): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO task_execution_metrics (notion_task_id, task_title, agent, status, start_time)
    VALUES (?, ?, ?, 'running', datetime('now'))
  `);
  const result = stmt.run(notionTaskId, taskTitle, agent);
  logger.info({ notionTaskId, taskTitle, agent }, 'Task execution started');
  return Number(result.lastInsertRowid);
}

/**
 * Complete a task execution with final metrics.
 */
export function completeTaskExecution(
  executionId: number,
  status: 'success' | 'failed',
  metrics: {
    apiCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    errorMessage?: string;
    retryCount?: number;
  }
): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE task_execution_metrics
    SET status = ?,
        end_time = datetime('now'),
        duration_ms = CAST((julianday('now') - julianday(start_time)) * 86400000 AS INTEGER),
        api_calls = ?,
        input_tokens = ?,
        output_tokens = ?,
        total_tokens = ? + ?,
        cost_usd = ?,
        error_message = ?,
        retry_count = ?
    WHERE id = ?
  `);
  stmt.run(
    status,
    metrics.apiCalls,
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.inputTokens, metrics.outputTokens,
    metrics.costUsd,
    metrics.errorMessage ?? null,
    metrics.retryCount ?? 0,
    executionId
  );
  logger.info({ executionId, status, costUsd: metrics.costUsd }, 'Task execution completed');
}

/**
 * Query task execution summaries for the portal dashboard.
 */
export function getTaskExecutionSummary(days: number = 7): {
  totalTasks: number;
  totalCost: number;
  avgDurationMs: number;
  costByAgent: Record<string, number>;
  failureRate: number;
} {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as totalTasks,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(AVG(duration_ms), 0) as avgDurationMs,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failures
    FROM task_execution_metrics
    WHERE ts >= datetime('now', '-' || ? || ' days')
  `).get(days) as any;

  const byAgent = db.prepare(`
    SELECT agent, COALESCE(SUM(cost_usd), 0) as cost
    FROM task_execution_metrics
    WHERE ts >= datetime('now', '-' || ? || ' days')
    GROUP BY agent
  `).all(days) as any[];

  const costByAgent: Record<string, number> = {};
  for (const row of byAgent) {
    costByAgent[row.agent] = row.cost;
  }

  return {
    totalTasks: totals.totalTasks,
    totalCost: totals.totalCost,
    avgDurationMs: totals.avgDurationMs,
    costByAgent,
    failureRate: totals.totalTasks > 0 ? totals.failures / totals.totalTasks : 0,
  };
}

/**
 * Get recent task executions for portal table.
 */
export function getRecentExecutions(limit: number = 20): TaskExecution[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM task_execution_metrics
    ORDER BY ts DESC LIMIT ?
  `).all(limit) as any[];
}
```

#### 3. Integration point — `scripts/agent-complete.js`

In `agent-complete.js`, when an agent reports completion:
1. Query `api_usage` for calls made since the task started (by timestamp range)
2. Aggregate the tokens and cost
3. Call `completeTaskExecution()` with the aggregated data

**Alternatively**, if the agent execution is orchestrated differently, hook into wherever the task lifecycle is managed.

#### 4. Update portal — `src/portal/portal.html` and `src/portal/server.ts`

Add a new API endpoint in `server.ts`:

```typescript
app.get('/api/task-metrics', (_req, res) => {
  const summary = getTaskExecutionSummary(7);
  const recent = getRecentExecutions(20);
  res.json({ summary, recent });
});
```

Add a new section in `portal.html`:
- "Task Execution Costs" card showing: total cost (7d), avg duration, failure rate
- Table of recent executions: task name, agent, cost, duration, status
- Cost-by-agent breakdown (simple bar or list)

Follow the existing portal HTML patterns — look at how other sections are structured in `portal.html`.

### Verification
```bash
npx vitest run
npx tsc --noEmit
# Manually insert a test row:
# sqlite3 data/nexus.db "INSERT INTO task_execution_metrics (notion_task_id, task_title, agent, status, start_time, end_time, duration_ms, api_calls, input_tokens, output_tokens, total_tokens, cost_usd) VALUES ('test-123', 'Test Task', 'backend', 'success', datetime('now', '-5 minutes'), datetime('now'), 300000, 5, 10000, 3000, 13000, 0.18);"
# Check portal: curl http://localhost:8200/api/task-metrics
```

---

## SF-04 · Structured Error Categorization in Retry Logic

### What
Replace naive fail→retry with classified errors and targeted retry strategies.

### Current State
- `src/services/error-monitor.ts` captures errors with level + source but no semantic categorization
- Retry logic in the agent dispatch flow is basic: fail → return to queue → retry
- No max retry tracking per error type

### Implementation

#### 1. Create `src/services/error-categorizer.ts`

```typescript
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Error Categorizer — classifies failures by type and recommends retry strategies.
 *
 * Used by the dispatcher/agent flow to make intelligent retry decisions
 * instead of naive fail→retry loops.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';

// ─── Error Taxonomy ──────────────────────────────────────────────

export type ErrorCategory =
  | 'syntax'           // TypeScript/JS syntax or compilation errors
  | 'logic'            // Wrong output, assertion failures, bad logic
  | 'integration'      // External service failures (Notion API, Telegram, etc.)
  | 'timeout'          // Operation exceeded time limit
  | 'rate_limit'       // API rate limit hit
  | 'context_overflow' // Token limit exceeded
  | 'test_failure'     // Vitest/test suite failures
  | 'unknown';         // Uncategorizable

export type RetryStrategy =
  | 'auto_fix'         // Re-prompt with error message, ask to fix
  | 'backoff_retry'    // Wait and retry (exponential backoff)
  | 'summarize_retry'  // Reduce context window and retry
  | 'escalate'         // Give up, alert Felipe
  | 'wait_retry';      // Wait for rate limit window

export interface CategorizedError {
  category: ErrorCategory;
  strategy: RetryStrategy;
  maxRetries: number;
  backoffMs: number;
  hint?: string;       // Additional context for retry prompt
}

// ─── Classification patterns ─────────────────────────────────────

const PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  { pattern: /SyntaxError|Unexpected token|Cannot find module/i, category: 'syntax' },
  { pattern: /TypeError|ReferenceError|is not a function|is not defined/i, category: 'syntax' },
  { pattern: /tsc.*error TS/i, category: 'syntax' },
  { pattern: /eslint.*error/i, category: 'syntax' },
  { pattern: /FAIL.*\.test\.ts|AssertionError|expect\(.*\)\.to/i, category: 'test_failure' },
  { pattern: /vitest.*failed/i, category: 'test_failure' },
  { pattern: /timeout|ETIMEDOUT|ECONNABORTED|deadline exceeded/i, category: 'timeout' },
  { pattern: /429|rate.?limit|too many requests/i, category: 'rate_limit' },
  { pattern: /token.*limit|context.*length|max.*tokens/i, category: 'context_overflow' },
  { pattern: /ECONNREFUSED|ENOTFOUND|503|502|500|network error/i, category: 'integration' },
  { pattern: /notion.*error|telegram.*error|api.*error/i, category: 'integration' },
];

// ─── Strategy mapping ────────────────────────────────────────────

const STRATEGY_MAP: Record<ErrorCategory, Omit<CategorizedError, 'category' | 'hint'>> = {
  syntax:           { strategy: 'auto_fix',       maxRetries: 3, backoffMs: 0 },
  test_failure:     { strategy: 'auto_fix',       maxRetries: 3, backoffMs: 0 },
  logic:            { strategy: 'auto_fix',       maxRetries: 2, backoffMs: 0 },
  timeout:          { strategy: 'backoff_retry',  maxRetries: 3, backoffMs: 5000 },
  rate_limit:       { strategy: 'wait_retry',     maxRetries: 5, backoffMs: 60000 },
  context_overflow: { strategy: 'summarize_retry', maxRetries: 2, backoffMs: 0 },
  integration:      { strategy: 'backoff_retry',  maxRetries: 3, backoffMs: 10000 },
  unknown:          { strategy: 'escalate',       maxRetries: 1, backoffMs: 0 },
};

// ─── Public API ──────────────────────────────────────────────────

/**
 * Classify an error message and return the recommended retry strategy.
 */
export function categorizeError(errorMessage: string, stack?: string): CategorizedError {
  const fullText = `${errorMessage} ${stack ?? ''}`;

  for (const { pattern, category } of PATTERNS) {
    if (pattern.test(fullText)) {
      const base = STRATEGY_MAP[category];
      return {
        category,
        ...base,
        hint: buildHint(category, errorMessage),
      };
    }
  }

  return { category: 'unknown', ...STRATEGY_MAP.unknown };
}

function buildHint(category: ErrorCategory, message: string): string {
  switch (category) {
    case 'syntax':
      return `Fix the syntax/type error. Error: ${message.slice(0, 200)}`;
    case 'test_failure':
      return `Tests are failing. Read the test output and fix the implementation to make tests pass. Error: ${message.slice(0, 200)}`;
    case 'context_overflow':
      return 'Reduce the context size: summarize long files, remove unnecessary context, focus on the specific task.';
    case 'rate_limit':
      return 'Rate limit hit. Waiting before retry.';
    default:
      return '';
  }
}

/**
 * Log a categorized error to the database for trend analysis.
 */
export function logCategorizedError(
  taskId: string,
  agent: string,
  errorMessage: string,
  categorized: CategorizedError,
  retryAttempt: number
): void {
  const db = getDb();

  // Use existing error_log table with enriched context
  db.prepare(`
    INSERT INTO error_log (level, source, message, context)
    VALUES ('error', 'agent', ?, ?)
  `).run(
    errorMessage.slice(0, 500),
    JSON.stringify({
      taskId,
      agent,
      category: categorized.category,
      strategy: categorized.strategy,
      retryAttempt,
      maxRetries: categorized.maxRetries,
    })
  );

  pushEvent({
    ts: new Date().toISOString(),
    type: 'error',
    summary: `[${categorized.category}] ${agent}: ${errorMessage.slice(0, 60)}`,
    detail: `Strategy: ${categorized.strategy}, retry ${retryAttempt}/${categorized.maxRetries}`,
  });

  logger.warn({
    taskId, agent,
    category: categorized.category,
    strategy: categorized.strategy,
    retryAttempt,
  }, 'Categorized error logged');
}

/**
 * Determine if we should retry or escalate.
 */
export function shouldRetry(categorized: CategorizedError, currentRetry: number): boolean {
  return currentRetry < categorized.maxRetries;
}

/**
 * Get error distribution for portal dashboard.
 */
export function getErrorDistribution(days: number = 7): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      json_extract(context, '$.category') as category,
      COUNT(*) as count
    FROM error_log
    WHERE source = 'agent'
      AND ts >= datetime('now', '-' || ? || ' days')
      AND context IS NOT NULL
    GROUP BY category
  `).all(days) as any[];

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.category) result[row.category] = row.count;
  }
  return result;
}
```

#### 2. Integration — wherever retry logic exists

Find the retry loop in the agent dispatch/execution flow (likely in `scripts/dispatch-task.js`, `scripts/agent-complete.js`, or `scripts/mission-control.js`). Replace the naive retry with:

```javascript
const { categorizeError, logCategorizedError, shouldRetry } = require('../src/services/error-categorizer');
// or import if using ESM

// When an agent reports failure:
const categorized = categorizeError(errorMessage, errorStack);
logCategorizedError(notionTaskId, agentName, errorMessage, categorized, currentRetryCount);

if (shouldRetry(categorized, currentRetryCount)) {
  // Wait if strategy requires it
  if (categorized.backoffMs > 0) {
    const waitMs = categorized.backoffMs * Math.pow(2, currentRetryCount);
    console.log(`  ⏳ Waiting ${waitMs}ms before retry (${categorized.strategy})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  // Re-queue task with hint
  // Update the .agent-prompt.md with categorized.hint prepended
  // Increment retry counter on the Notion task
} else {
  // Escalate — mark task as blocked, alert Felipe
  console.log(`  🚨 Escalating: ${categorized.category} exceeded ${categorized.maxRetries} retries`);
  // Update Notion task status to "Review" or add a comment
}
```

#### 3. Portal update

Add endpoint in `src/portal/server.ts`:

```typescript
app.get('/api/error-distribution', (_req, res) => {
  const distribution = getErrorDistribution(7);
  res.json(distribution);
});
```

Add a section in `portal.html` showing error distribution (count by category).

### Verification
```bash
npx vitest run
npx tsc --noEmit
# Write a unit test in __tests__/services/error-categorizer.test.ts:
# - Test that "SyntaxError: Unexpected token" → category 'syntax', strategy 'auto_fix'
# - Test that "429 Too Many Requests" → category 'rate_limit', strategy 'wait_retry'
# - Test that "gibberish error" → category 'unknown', strategy 'escalate'
# - Test shouldRetry returns false when currentRetry >= maxRetries
```

---

## SF-05 · Agent Output Quality Scoring

### What
Score each completed task's output against objective criteria. Phase 1 = automated checks only.

### Current State
- No quality scoring exists
- QA agent does manual review but no structured scoring
- No historical quality data

### Implementation

#### 1. Create migration `migrations/027_quality_scores.sql`

```sql
-- Migration 027: Quality scoring per task execution
CREATE TABLE IF NOT EXISTS quality_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  execution_id    INTEGER REFERENCES task_execution_metrics(id),
  notion_task_id  TEXT NOT NULL,
  agent           TEXT NOT NULL,
  tests_passing   INTEGER NOT NULL DEFAULT 0,  -- 1 = all pass, 0 = some fail
  types_clean     INTEGER NOT NULL DEFAULT 0,  -- 1 = tsc --noEmit clean
  lint_clean      INTEGER NOT NULL DEFAULT 0,  -- 1 = no lint errors
  files_changed   INTEGER NOT NULL DEFAULT 0,  -- number of files modified
  test_coverage   REAL,                        -- coverage % if available
  overall_score   REAL NOT NULL DEFAULT 0,     -- 0-100 composite score
  details         TEXT                         -- JSON: breakdown and notes
);

CREATE INDEX IF NOT EXISTS idx_quality_ts ON quality_scores (ts);
CREATE INDEX IF NOT EXISTS idx_quality_agent ON quality_scores (agent);
CREATE INDEX IF NOT EXISTS idx_quality_notion ON quality_scores (notion_task_id);

-- Rollback: DROP TABLE IF EXISTS quality_scores;
```

#### 2. Create `src/services/quality-scorer.ts`

```typescript
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
    execSync('npx vitest run --reporter=dot 2>&1', { cwd: workDir, timeout: 60000 });
    testsPassing = true;
    details.tests = 'all passing';
  } catch (e: any) {
    details.tests = e.stdout?.toString().slice(-200) ?? 'failed';
  }

  // 2. Types clean?
  let typesClean = false;
  try {
    execSync('npx tsc --noEmit 2>&1', { cwd: workDir, timeout: 30000 });
    typesClean = true;
    details.types = 'clean';
  } catch (e: any) {
    details.types = e.stdout?.toString().slice(-200) ?? 'errors';
  }

  // 3. Lint clean? (skip if no eslint config)
  let lintClean = false;
  try {
    execSync('npx eslint src/ --quiet 2>&1', { cwd: workDir, timeout: 30000 });
    lintClean = true;
    details.lint = 'clean';
  } catch (e: any) {
    // If eslint is not configured, treat as clean
    if (e.message?.includes('No ESLint configuration') || e.message?.includes('eslint: not found')) {
      lintClean = true;
      details.lint = 'skipped (no config)';
    } else {
      details.lint = e.stdout?.toString().slice(-200) ?? 'errors';
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

  // 5. Test coverage (if available)
  let testCoverage: number | null = null;
  // Coverage is already configured in vitest.config.ts with v8 provider
  // To get coverage, run: npx vitest run --coverage
  // For now, skip coverage to keep scoring fast. Add in Phase 2.

  // ── Composite score ──
  // Weights: tests 40%, types 30%, lint 20%, files changed 10% (penalty if 0)
  let score = 0;
  if (testsPassing) score += 40;
  if (typesClean) score += 30;
  if (lintClean) score += 20;
  if (filesChanged > 0) score += 10; // At least some work was done

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
  `).all(days) as any[];
}
```

#### 3. Integration — `scripts/agent-complete.js`

After an agent completes a task and BEFORE marking it as Done in Notion:

```javascript
const { runQualityChecks, saveQualityScore } = require('../src/services/quality-scorer');

// Run quality checks
const report = runQualityChecks(process.cwd());
console.log(`  📊 Quality score: ${report.overallScore}/100`);

// Save to DB
saveQualityScore(executionId, notionTaskId, agentName, report);

// If score < 70, flag for review instead of marking Done
if (report.overallScore < 70) {
  console.log(`  ⚠️ Low quality score — sending to Review instead of Done`);
  // Set Notion status to "Review" instead of "QA Validating"
}
```

#### 4. Portal update

Add endpoint in `src/portal/server.ts`:

```typescript
app.get('/api/quality-scores', (_req, res) => {
  const byAgent = getQualityByAgent(30);
  res.json({ byAgent });
});
```

Add a section in `portal.html`:
- Quality scores by agent (avg score, pass rate)
- Trend indicator (improving / declining / stable)

### Verification
```bash
npx vitest run
npx tsc --noEmit
# Write a unit test in __tests__/services/quality-scorer.test.ts:
# - Mock execSync to simulate passing/failing tests
# - Verify score calculation: all pass = 100, all fail = 0
# - Verify DB persistence
```

---

## Post-Implementation Checklist

After all five tasks are complete:

- [ ] All tests pass: `npx vitest run`
- [ ] Types clean: `npx tsc --noEmit`
- [ ] Migrations applied on server: check `migrations/026_*.sql` and `027_*.sql`
- [ ] Portal shows new sections (task metrics, error distribution, quality scores)
- [ ] Pre-commit hook now runs vitest (verify with a deliberate fail)
- [ ] CLAUDE.md updated with QA Left-Shift policy
- [ ] Git hooks re-installed on server via `bash scripts/setup-hooks.sh`
- [ ] Commit history: one clean commit per SF task on `feature/software-factory`
- [ ] PR from `feature/software-factory` → `develop` ready for Felipe review

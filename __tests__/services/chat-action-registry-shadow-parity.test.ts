import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Same upstream mocks as the smoke fixture suite — the parity check exercises
// the deterministic planner only; pending-action state, recent-entity graph,
// and telemetry are stubbed.
vi.mock('../../src/services/chat-action-state', () => ({
  cancelPendingChatActions: vi.fn(() => 0),
  cancelPendingChatActionsForAccountSwitch: vi.fn(() => 0),
  clearRecentChatEntitiesForUser: vi.fn(),
  expireStalePendingChatActionsForJob: vi.fn(() => 0),
  getActivePendingChatAction: vi.fn(() => null),
  getPendingChatActionById: vi.fn(() => null),
  listChatActionTelemetryForScope: vi.fn(() => []),
  markPendingChatActionNeedsUserFollowup: vi.fn(() => false),
  recordChatActionTelemetry: vi.fn(),
  rememberRecentChatEntity: vi.fn(),
  resetChatActionStateForTests: vi.fn(),
  resolveRecentChatEntity: vi.fn(() => ({ status: 'none', candidates: [] })),
  upsertPendingChatAction: vi.fn(),
  makeSlotProvenance: vi.fn((input: any) => ({
    slot: input.slot,
    value: input.value,
    rawText: input.rawText ?? null,
    turnId: input.turnId,
    spanStart: input.spanStart ?? null,
    spanEnd: input.spanEnd ?? null,
    sourceType: input.sourceType ?? 'user_message',
    normalizer: input.normalizer,
    confidence: input.confidence,
    validation: input.validation ?? 'passed',
  })),
}));

import {
  buildDeterministicChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';
import { getChatActionRegistry } from '../../src/services/chat/registry';
import { buildFixturesFromRegistry } from '../lib/registry-fixture-builder';

const FROZEN_NOW = '2026-05-14T12:00:00+01:00';

type ParityFinding = {
  fixtureId: string;
  text: string;
  locale: string;
  expectedSkill?: string;
  expectedAction?: string;
  expectedTitle?: string;
  expectedActionable?: boolean;
  expectedRefusal?: boolean;
  observed: {
    planResolved: boolean;
    skill?: string;
    action?: string;
    requiredArgsPresent?: boolean;
    title?: string | null;
    rejectedTitle?: string | null;
  };
  parity: 'match' | 'mismatch' | 'not_resolved' | 'state_required';
  mismatchReasons: string[];
};

// Fixture ids that require runtime state injection (pending action, recent
// entity, multi-turn history) the shadow harness doesn't currently provide.
// These are NOT failures; the planner's full path (buildChatActionPlan, not
// buildDeterministicChatActionPlan) handles them via pending-action lookup +
// recent-entity follow-up. Phase 2.2 of the implementation plan covers the
// state-injection harness extension.
//
// Phase 2 batch 10 (2026-05-15): the training_plan_create state-required
// fixture's index shifted when a PT-BR variant was added before it. Match by
// exact text instead of by id so the entry survives future reordering.
const STATE_REQUIRED_FIXTURE_TEXTS = new Set<string>([
  'It is 20 km a week',
]);
const STATE_REQUIRED_FIXTURE_IDS = new Set<string>([]);

function baseInput(text: string, locale: string): ChatPlannerInput {
  return {
    userId: 1,
    tenantId: 1,
    conversationId: `parity-${Date.now()}`,
    messageId: `parity-msg-${Date.now()}`,
    locale,
    timezone: 'Europe/Lisbon',
    channel: 'telegram',
    text,
    nowIso: FROZEN_NOW,
  };
}

function evaluateParity(
  fixture: ReturnType<typeof buildFixturesFromRegistry>[number],
): ParityFinding {
  const reasons: string[] = [];
  let observed: ParityFinding['observed'] = { planResolved: false };

  // Short-circuit: state-required fixtures are not failures, they are
  // beyond the stateless shadow harness's scope. We match by id (legacy
  // ids that haven't shifted) OR by exact text (id-shift-resilient).
  const isStateRequired =
    STATE_REQUIRED_FIXTURE_IDS.has(fixture.id) ||
    (fixture.expectedActionable === true && STATE_REQUIRED_FIXTURE_TEXTS.has(fixture.text));
  if (isStateRequired) {
    return {
      fixtureId: fixture.id,
      text: fixture.text,
      locale: fixture.locale,
      expectedSkill: fixture.expectedSkill,
      expectedAction: fixture.expectedAction,
      expectedTitle: fixture.expectedTitle,
      expectedActionable: fixture.expectedActionable,
      expectedRefusal: fixture.expectedRefusal,
      observed: { planResolved: false },
      parity: 'state_required',
      mismatchReasons: ['fixture requires runtime state injection (pending action / recent entity / multi-turn); covered by full chat planner path, not deterministic-only shadow harness'],
    };
  }

  try {
    const plan = buildDeterministicChatActionPlan(baseInput(fixture.text, fixture.locale));
    if (!plan) {
      observed = { planResolved: false };
      // For golden/actionable fixtures, missing plan is a mismatch.
      if (fixture.expectedActionable === true) {
        reasons.push('deterministic planner returned null for gate-positive golden fixture');
      }
    } else {
      const step = plan.steps[0];
      const args = (step?.args ?? null) as Record<string, unknown> | null;
      observed = {
        planResolved: true,
        skill: step?.skill,
        action: step?.action,
        requiredArgsPresent: step?.requiredArgsPresent,
        title: typeof args?.title === 'string' ? args.title : (args?.title === null ? null : undefined),
        rejectedTitle: typeof args?.rejectedTitle === 'string' ? args.rejectedTitle : undefined,
      };

      if (fixture.expectedSkill && step?.skill !== fixture.expectedSkill) {
        reasons.push(`expectedSkill=${fixture.expectedSkill} but observed skill=${step?.skill}`);
      }
      if (fixture.expectedAction && step?.action !== fixture.expectedAction) {
        reasons.push(`expectedAction=${fixture.expectedAction} but observed action=${step?.action}`);
      }
      if (fixture.expectedTitle && observed.title !== fixture.expectedTitle) {
        reasons.push(`expectedTitle="${fixture.expectedTitle}" but observed title=${JSON.stringify(observed.title)}`);
      }
      if (fixture.expectedRefusal === true && step?.requiredArgsPresent === true) {
        reasons.push('expectedRefusal=true but requiredArgsPresent=true (planner did not refuse)');
      }
    }
  } catch (err) {
    reasons.push(`exception: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parity: ParityFinding['parity'] =
    !observed.planResolved && fixture.expectedActionable === true
      ? 'not_resolved'
      : reasons.length === 0
        ? 'match'
        : 'mismatch';

  return {
    fixtureId: fixture.id,
    text: fixture.text,
    locale: fixture.locale,
    expectedSkill: fixture.expectedSkill,
    expectedAction: fixture.expectedAction,
    expectedTitle: fixture.expectedTitle,
    expectedActionable: fixture.expectedActionable,
    expectedRefusal: fixture.expectedRefusal,
    observed,
    parity,
    mismatchReasons: reasons,
  };
}

const PARITY_REPORT: {
  generatedAt: string;
  source: string;
  totals: { tested: number; match: number; mismatch: number; not_resolved: number; state_required: number };
  findings: ParityFinding[];
} = {
  generatedAt: new Date().toISOString(),
  source: 'chat-action-registry-shadow-parity.test.ts',
  totals: { tested: 0, match: 0, mismatch: 0, not_resolved: 0, state_required: 0 },
  findings: [],
};

describe('chat-action-registry shadow-mode parity (Phase 2.1)', () => {
  const registry = getChatActionRegistry();
  const fixtures = buildFixturesFromRegistry({ registry });

  it('the registry produces a non-empty fixture set', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('records per-fixture parity findings without failing the gate (shadow mode)', () => {
    for (const fixture of fixtures) {
      const finding = evaluateParity(fixture);
      PARITY_REPORT.findings.push(finding);
      PARITY_REPORT.totals.tested += 1;
      if (finding.parity === 'match') PARITY_REPORT.totals.match += 1;
      else if (finding.parity === 'mismatch') PARITY_REPORT.totals.mismatch += 1;
      else if (finding.parity === 'state_required') PARITY_REPORT.totals.state_required += 1;
      else PARITY_REPORT.totals.not_resolved += 1;
    }
    expect(PARITY_REPORT.totals.tested).toBe(fixtures.length);
  });

  it('every fixture has a tracked outcome', () => {
    for (const finding of PARITY_REPORT.findings) {
      expect(['match', 'mismatch', 'not_resolved', 'state_required']).toContain(finding.parity);
    }
  });
});

afterAll(() => {
  if (process.env.NEXUS_SKIP_SHADOW_PARITY_WRITE === '1') return;
  try {
    const outDir = path.resolve(__dirname, '../../docs/release/eval-evidence');
    fs.mkdirSync(outDir, { recursive: true });
    // Use a stable filename so successive runs overwrite; the contents reflect
    // the most recent test execution. Felipe reviews this artifact before each
    // Phase 2.2 promotion to flip an action to registry-primary.
    const outPath = path.join(outDir, 'registry-shadow-parity-latest.json');
    fs.writeFileSync(outPath, JSON.stringify(PARITY_REPORT, null, 2));
  } catch (err) {
    // Never fail the suite over parity-report write errors — shadow mode is
    // observational only.
    console.warn(`[shadow-parity] failed to write parity report: ${err instanceof Error ? err.message : String(err)}`);
  }
});

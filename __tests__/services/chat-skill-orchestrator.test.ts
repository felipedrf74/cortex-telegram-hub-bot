import { describe, it, expect } from 'vitest';
import {
  analyzeChatSkillOrchestration,
  applyChatSkillRoutingDecision,
  buildChatSkillRoutingPromptBlock,
} from '../../src/services/chat-skill-orchestrator';
import type { RouteResult } from '../../src/router';

describe('chat skill orchestrator', () => {
  it('routes multi-skill scheduling to Secretary as the schedule owner', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Plan my week around workouts and content deadlines.',
      routedDomain: 'triathlon',
      userId: 42,
      tenantId: 42,
    });

    expect(decision.primaryDomain).toBe('secretary');
    expect(decision.involvedSkills).toEqual(expect.arrayContaining(['secretary', 'training', 'content']));
    expect(decision.intentKinds).toEqual(expect.arrayContaining(['scheduling', 'cross_skill']));
    expect(decision.reasonCodes).toContain('secretary_owns_schedule_placement');

    const rawRoute: RouteResult = {
      domain: 'triathlon',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'Plan my week around workouts and content deadlines.',
    };
    const route = applyChatSkillRoutingDecision(rawRoute, decision);
    expect(route.domain).toBe('secretary');
    expect(route.method).toBe('context');
  });

  it('keeps content ownership for content ideas that use training context but do not schedule time', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Create content ideas based on my training progress.',
      routedDomain: 'content',
      userId: 42,
      tenantId: 42,
    });

    expect(decision.primaryDomain).toBe('content');
    expect(decision.involvedSkills).toEqual(expect.arrayContaining(['content', 'training']));
    expect(decision.intentKinds).toContain('cross_skill');
    expect(decision.intentKinds).not.toContain('scheduling');
  });

  it('requires confirmation for destructive cross-skill actions', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Cancel my training plan and clear the calendar.',
      routedDomain: 'secretary',
      userId: 42,
      tenantId: 42,
    });

    expect(decision.primaryDomain).toBe('secretary');
    expect(decision.safety.destructive).toBe(true);
    expect(decision.safety.requiresConfirmation).toBe(true);
    expect(decision.safety.explicitConfirmation).toBe(false);
    expect(decision.involvedSkills).toEqual(expect.arrayContaining(['secretary', 'training']));
  });

  it('recognizes explicit confirmation only when the destructive action is restated', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Yes, cancel the training plan and remove its calendar events.',
      routedDomain: 'secretary',
      userId: 42,
      tenantId: 42,
    });

    expect(decision.safety.requiresConfirmation).toBe(true);
    expect(decision.safety.explicitConfirmation).toBe(true);
  });

  it('marks stale and prior-context requests for refresh before answering', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'What changed since yesterday, and move that to Friday?',
      routedDomain: 'secretary',
      userId: 42,
      tenantId: 42,
    });

    expect(decision.context.shouldRefreshBeforeAnswer).toBe(true);
    expect(decision.context.staleContextRisk).toBe(true);
    expect(decision.context.ambiguousReference).toBe(true);
    expect(decision.intentKinds).toEqual(expect.arrayContaining(['prior_context', 'stale_context', 'scheduling']));
  });

  it('renders ownership and safety rules into the prompt block without provider assumptions', () => {
    const decision = analyzeChatSkillOrchestration({
      message: 'Find time for meal prep before heavy training days.',
      routedDomain: 'cooking',
      userId: 42,
      tenantId: 42,
    });
    const block = buildChatSkillRoutingPromptBlock(decision);

    expect(block).toContain('<chat_skill_routing');
    expect(block).toContain('Secretary owns agenda placement');
    expect(block).toContain('Cooking owns meals');
    expect(block).not.toMatch(/\bGPT\b|\bClaude\b|\bGemini\b/);
  });
});

// ─── M19 bridge semantics (flag AI_CROSS_SKILL_EXECUTION) ─
//
// Adversarial-review fix (M19 remediation, 2026-07-21): the
// cross_skill_bridge block only renders on turns the PLANNER DECLINED
// (legacy/model path). Suppressing it based on splitter coverage therefore
// guaranteed the un-handled second intent got neither plan execution nor the
// bridge — a silent drop. The bridge is the honest fallback and ALWAYS
// renders on cross-skill turns; the flag's benefit lives on the plan path
// (ownership rewrite + preview + per-segment skill execution).

import { vi, afterEach } from 'vitest';
import { CROSS_SKILL_EXECUTION_ENV_VAR } from '../../src/services/chat/planner/cross-skill-ownership';

describe('M19 cross_skill_bridge always renders on the legacy/model path', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const CROSS_SKILL_MESSAGE = 'Log this receipt for 45 EUR and remind me Friday';

  function crossSkillDecision() {
    const decision = analyzeChatSkillOrchestration({
      message: CROSS_SKILL_MESSAGE,
      routedDomain: 'finance',
      userId: 42,
      tenantId: 42,
    });
    expect(decision.intentKinds).toContain('cross_skill');
    return decision;
  }

  it('renders the bridge for cross-skill turns in BOTH flag states — byte-identical (no coverage-proxy suppression)', () => {
    vi.stubEnv(CROSS_SKILL_EXECUTION_ENV_VAR, '');
    const flagOff = buildChatSkillRoutingPromptBlock(crossSkillDecision());
    vi.stubEnv(CROSS_SKILL_EXECUTION_ENV_VAR, 'true');
    const flagOn = buildChatSkillRoutingPromptBlock(crossSkillDecision());
    expect(flagOff).toContain('<cross_skill_bridge');
    expect(flagOn).toBe(flagOff);
    // Everything else in the block stays intact.
    expect(flagOn).toContain('<chat_skill_routing');
    expect(flagOn).toContain('<ownership_rules>');
  });

  it('single-skill decisions are byte-identical in both flag states (never rendered a bridge)', () => {
    const message = 'Summarize my unread emails';
    vi.stubEnv(CROSS_SKILL_EXECUTION_ENV_VAR, '');
    const flagOff = buildChatSkillRoutingPromptBlock(analyzeChatSkillOrchestration({
      message, routedDomain: 'secretary', userId: 42, tenantId: 42,
    }));
    vi.stubEnv(CROSS_SKILL_EXECUTION_ENV_VAR, 'true');
    const flagOn = buildChatSkillRoutingPromptBlock(analyzeChatSkillOrchestration({
      message, routedDomain: 'secretary', userId: 42, tenantId: 42,
    }));
    expect(flagOn).toBe(flagOff);
    expect(flagOn).not.toContain('<cross_skill_bridge');
  });
});

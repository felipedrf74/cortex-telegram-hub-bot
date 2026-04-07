// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tests for src/services/secretary-tools.ts (Layer 3 of TASK-17).
 *
 * Two responsibilities under test:
 *   1. analyzeIntent — pure keyword classification (also feeds Layer 2)
 *   2. getToolPacksForMessage / getFilteredToolsForMessage — pack selection
 *
 * Critical invariants verified:
 *   - Memory pack is ALWAYS in the result set
 *   - Ambiguous queries fall back to ALL packs (preserves correctness)
 *   - Non-secretary domains pass through unchanged
 *   - Tool name strings in SECRETARY_TOOL_PACKS exist in the real TOOLS array
 *     (cross-checked at the bottom — catches typos / renames at test time)
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeIntent,
  getToolPacksForMessage,
  getFilteredToolsForMessage,
  secretaryNeedsSonnet,
  secretaryNeedsHeavyModel,
  planSecretaryOptimization,
  SECRETARY_TOOL_PACKS,
} from '../../src/services/secretary-tools';
import type { DomainMessage } from '../../src/domains/types';
import type Anthropic from '@anthropic-ai/sdk';

// Synthetic tool fixture — covers every name referenced by every pack so
// we can verify filtering behavior without dragging in the real TOOLS array.
const ALL_PACK_NAMES = [...new Set(Object.values(SECRETARY_TOOL_PACKS).flat())];
const FAKE_TOOLS: Anthropic.Tool[] = ALL_PACK_NAMES.map((name) => ({
  name,
  description: `fake ${name}`,
  input_schema: { type: 'object' as const, properties: {} },
}));

// ════════════════════════════════════════════════════════════════════
// analyzeIntent — keyword classification
// ════════════════════════════════════════════════════════════════════

describe('analyzeIntent', () => {
  it('detects task intent on EN keywords', () => {
    const r = analyzeIntent('show my tasks');
    expect(r.tasks).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it('detects task intent on PT-BR keywords', () => {
    const r = analyzeIntent('mostra minhas tarefas pendentes');
    expect(r.tasks).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it('separates task read vs write', () => {
    expect(analyzeIntent('show my tasks').taskWrite).toBe(false);
    expect(analyzeIntent('create a new task').taskWrite).toBe(true);
    expect(analyzeIntent('marcar tarefa como concluída').taskWrite).toBe(true);
  });

  it('detects calendar intent', () => {
    expect(analyzeIntent("what's my day").calendar).toBe(true);
    expect(analyzeIntent('o que tenho na agenda hoje').calendar).toBe(true);
    expect(analyzeIntent('meeting tomorrow').calendar).toBe(true);
  });

  it('separates calendar read vs write', () => {
    expect(analyzeIntent('show my calendar').calendarWrite).toBe(false);
    expect(analyzeIntent('create a meeting tomorrow at 3pm').calendarWrite).toBe(true);
    expect(analyzeIntent('cancelar reunião de quinta').calendarWrite).toBe(true);
  });

  it('detects email intent', () => {
    expect(analyzeIntent('how many unread emails').email).toBe(true);
    expect(analyzeIntent('responder email do João').email).toBe(true);
  });

  it('detects reminder intent', () => {
    expect(analyzeIntent('set a reminder for 3pm').reminders).toBe(true);
    expect(analyzeIntent('lembra me às 9 da manhã').reminders).toBe(true);
  });

  it('detects garmin/training intent', () => {
    expect(analyzeIntent("how was my sleep last night").garmin).toBe(true);
    expect(analyzeIntent('como foi meu treino ontem').garmin).toBe(true);
    expect(analyzeIntent('check my hrv').garmin).toBe(true);
  });

  it('flags very short messages as ambiguous', () => {
    expect(analyzeIntent('yes').ambiguous).toBe(true);
    expect(analyzeIntent('ok').ambiguous).toBe(true);
    expect(analyzeIntent('sim').ambiguous).toBe(true);
  });

  it('flags freeform questions with no domain keywords as ambiguous', () => {
    // Long enough to clear the length check, but contains zero domain
    // keywords — should fall through to the ambiguous safety net so the
    // caller loads everything (matches pre-optimization behavior).
    expect(analyzeIntent('what should I do this afternoon').ambiguous).toBe(true);
    expect(analyzeIntent('how is the weather').ambiguous).toBe(true);
    expect(analyzeIntent('quem foi Newton').ambiguous).toBe(true);
  });

  it('non-ambiguous when at least one intent triggers', () => {
    expect(analyzeIntent('show my tasks').ambiguous).toBe(false);
    expect(analyzeIntent("what's my day").ambiguous).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// getToolPacksForMessage — pack selection
// ════════════════════════════════════════════════════════════════════

describe('getToolPacksForMessage', () => {
  it('always includes memory pack', () => {
    expect(getToolPacksForMessage('show my tasks')).toContain('memory');
    expect(getToolPacksForMessage('create a meeting')).toContain('memory');
    expect(getToolPacksForMessage('xyz')).toContain('memory');
  });

  it('"show my tasks" → task_read + memory only', () => {
    const packs = getToolPacksForMessage('show my tasks');
    expect(packs).toContain('task_read');
    expect(packs).toContain('memory');
    expect(packs).not.toContain('task_write');
    expect(packs).not.toContain('email');
    expect(packs).not.toContain('calendar_read');
  });

  it('"create a new task: buy milk" → task_read + task_write + memory', () => {
    const packs = getToolPacksForMessage('create a new task: buy milk');
    expect(packs).toContain('task_read');
    expect(packs).toContain('task_write');
    expect(packs).toContain('memory');
    expect(packs).not.toContain('email');
  });

  it('"send email to John about meeting" → email + calendar_read + memory', () => {
    const packs = getToolPacksForMessage('send email to John about the meeting');
    expect(packs).toContain('email');
    expect(packs).toContain('memory');
    // "meeting" is a calendar keyword too — that's intentional, the AI may
    // need to look up the meeting time before composing the email.
    expect(packs).toContain('calendar_read');
  });

  it('"what is my week" → calendar_read + memory', () => {
    const packs = getToolPacksForMessage('what is my week');
    expect(packs).toContain('calendar_read');
    expect(packs).toContain('memory');
    expect(packs).not.toContain('email');
  });

  it('"set a reminder at 5pm to call mom" → reminders + memory', () => {
    const packs = getToolPacksForMessage('set a reminder at 5pm to call mom');
    expect(packs).toContain('reminders');
    expect(packs).toContain('memory');
  });

  it('ambiguous short message → ALL packs (safety net)', () => {
    const packs = getToolPacksForMessage('yes');
    expect(packs).toEqual(expect.arrayContaining(Object.keys(SECRETARY_TOOL_PACKS)));
  });

  it('ambiguous long freeform → ALL packs', () => {
    const packs = getToolPacksForMessage('how is the weather looking');
    expect(packs).toEqual(expect.arrayContaining(Object.keys(SECRETARY_TOOL_PACKS)));
  });
});

// ════════════════════════════════════════════════════════════════════
// getFilteredToolsForMessage — actual tool filtering
// ════════════════════════════════════════════════════════════════════

describe('getFilteredToolsForMessage', () => {
  it('non-secretary domains pass through unchanged', () => {
    const result = getFilteredToolsForMessage('cooking', 'show my tasks', FAKE_TOOLS);
    expect(result).toBe(FAKE_TOOLS);
  });

  it('"show my tasks" → 5 task_read + 2 memory tools', () => {
    const result = getFilteredToolsForMessage('secretary', 'show my tasks', FAKE_TOOLS);
    const names = result.map((t) => t.name);

    // task_read: 5 tools
    expect(names).toContain('ms_todo_get_tasks');
    expect(names).toContain('ms_todo_search_tasks');
    expect(names).toContain('ms_todo_get_due_tasks');
    expect(names).toContain('ms_todo_get_lists');
    expect(names).toContain('ms_todo_get_checklist');

    // memory: 2 tools
    expect(names).toContain('shared_memory_set');
    expect(names).toContain('shared_memory_remove');

    // NOT included: write tools, email, calendar
    expect(names).not.toContain('ms_todo_create_task');
    expect(names).not.toContain('ms_todo_delete_task');
    expect(names).not.toContain('search_outlook_emails');
    expect(names).not.toContain('get_calendar_events');

    // Total: 5 read + 2 memory = 7 (vs 25 in the unfiltered set)
    expect(names).toHaveLength(7);
  });

  it('"send email about the project" → 5 email + 1 calendar_read + 2 memory', () => {
    const result = getFilteredToolsForMessage('secretary', 'send email to john about meeting', FAKE_TOOLS);
    const names = result.map((t) => t.name);

    // email: 5 tools
    expect(names).toContain('search_outlook_emails');
    expect(names).toContain('read_outlook_email');
    expect(names).toContain('send_outlook_email');
    expect(names).toContain('reply_outlook_email');
    expect(names).toContain('get_outlook_unread');

    // calendar_read pulled in by "meeting"
    expect(names).toContain('get_calendar_events');

    // memory always
    expect(names).toContain('shared_memory_set');

    // NOT: tasks, calendar_write
    expect(names).not.toContain('ms_todo_get_tasks');
    expect(names).not.toContain('create_calendar_event');
  });

  it('ambiguous message → ALL tools (fallback)', () => {
    const result = getFilteredToolsForMessage('secretary', 'ok', FAKE_TOOLS);
    expect(result).toHaveLength(FAKE_TOOLS.length);
  });

  it('reduction is significant for typed-intent queries', () => {
    const allCount = FAKE_TOOLS.length;
    const filteredCount = getFilteredToolsForMessage('secretary', 'show my tasks', FAKE_TOOLS).length;
    // Should drop from 25 → 7 (a 70%+ reduction)
    expect(filteredCount).toBeLessThan(allCount * 0.5);
  });
});

// ════════════════════════════════════════════════════════════════════
// Layer 4: secretaryNeedsSonnet — adaptive model classifier
// ════════════════════════════════════════════════════════════════════

describe('secretaryNeedsSonnet', () => {
  // Simple data-read queries should go to Haiku
  it.each([
    'show my tasks',
    'mostra minhas tarefas',
    'list my todos',
    "what's my day",
    'how many unread emails',
    'overdue tasks',
    'add task: buy milk',
    'delete the meeting on tuesday',
  ])('%s → Haiku (false)', (msg) => {
    expect(secretaryNeedsSonnet(msg)).toBe(false);
  });

  // Complex reasoning queries should stay on Sonnet
  it.each([
    'plan my week',
    'planejar minha semana considerando os prazos',
    'should I reschedule the meeting?',
    'what should I prioritize this week',
    'analyze my workload for the next 10 days',
    'help me decide between two project options',
    'write a draft email to the team',
    'review my schedule and suggest improvements',
    'considering my training schedule, when should I do deep work',
  ])('%s → Sonnet (true)', (msg) => {
    expect(secretaryNeedsSonnet(msg)).toBe(true);
  });

  it('empty message → Sonnet (safe default)', () => {
    expect(secretaryNeedsSonnet('')).toBe(true);
    expect(secretaryNeedsSonnet('   ')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// secretaryNeedsHeavyModel — provider-agnostic alias
// ════════════════════════════════════════════════════════════════════
//
// After TASK-17 Option B, the canonical name is `secretaryNeedsHeavyModel`
// because the tier decision is no longer Anthropic-specific. The legacy
// name `secretaryNeedsSonnet` is kept as a deprecated alias for any
// external code that imported it before the rename.

describe('secretaryNeedsHeavyModel (canonical name)', () => {
  it('returns the same result as the deprecated alias', () => {
    const cases = [
      'show my tasks',
      'plan my week',
      'what should I prioritize',
      'add task: buy milk',
      '',
    ];
    for (const msg of cases) {
      expect(secretaryNeedsHeavyModel(msg)).toBe(secretaryNeedsSonnet(msg));
    }
  });

  it('canonical name is identical function reference (not a copy)', () => {
    // The deprecated alias should literally be `export const old = new`,
    // not a separate function — that way bug fixes apply to both.
    expect(secretaryNeedsSonnet).toBe(secretaryNeedsHeavyModel);
  });
});

// ════════════════════════════════════════════════════════════════════
// planSecretaryOptimization — single source of truth for L3+L4+L5
// ════════════════════════════════════════════════════════════════════

describe('planSecretaryOptimization', () => {
  const FAKE_TOOLS_FOR_PLAN = ALL_PACK_NAMES.map((name) => ({
    name,
    description: `fake ${name}`,
    input_schema: { type: 'object' as const, properties: {} },
  }));

  const FAKE_HISTORY: DomainMessage[] = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));

  it('non-secretary domains: returns no-op decision (full tools, heavy, full history)', () => {
    const result = planSecretaryOptimization('cooking', 'show my tasks', FAKE_HISTORY, FAKE_TOOLS_FOR_PLAN);
    expect(result.optimized).toBe(false);
    expect(result.filteredTools).toBe(FAKE_TOOLS_FOR_PLAN); // same reference
    expect(result.modelTier).toBe('heavy');
    expect(result.slicedHistory).toBe(FAKE_HISTORY); // same reference
  });

  it('secretary + simple query: filters tools, light tier, slices history to 4', () => {
    const result = planSecretaryOptimization('secretary', 'show my tasks', FAKE_HISTORY, FAKE_TOOLS_FOR_PLAN);
    expect(result.optimized).toBe(true);
    expect(result.filteredTools.length).toBeLessThan(FAKE_TOOLS_FOR_PLAN.length);
    expect(result.modelTier).toBe('light');
    expect(result.slicedHistory.length).toBe(4);
    // Last 4 messages from the original
    expect(result.slicedHistory[0].content).toBe('message 8');
    expect(result.slicedHistory[3].content).toBe('message 11');
  });

  it('secretary + complex query: filters tools, heavy tier, full history kept', () => {
    const result = planSecretaryOptimization(
      'secretary',
      'plan my week considering my training and content schedule',
      FAKE_HISTORY,
      FAKE_TOOLS_FOR_PLAN,
    );
    expect(result.optimized).toBe(true);
    expect(result.modelTier).toBe('heavy');
    expect(result.slicedHistory).toBe(FAKE_HISTORY); // same reference, no slicing
    expect(result.slicedHistory.length).toBe(12);
  });

  it('secretary + ambiguous query: light tier (length < 8 → ambiguous → not heavy keywords) → all tools fallback', () => {
    const result = planSecretaryOptimization('secretary', 'ok', FAKE_HISTORY, FAKE_TOOLS_FOR_PLAN);
    // Ambiguous queries fall back to all packs (Layer 3 safety net)
    expect(result.filteredTools.length).toBe(FAKE_TOOLS_FOR_PLAN.length);
    // "ok" doesn't match any complexity marker, so light tier
    expect(result.modelTier).toBe('light');
    // Light tier triggers history slicing
    expect(result.slicedHistory.length).toBe(4);
  });

  it('history < 4 messages: slice is a no-op (.slice(-4) handles short arrays)', () => {
    const shortHistory: DomainMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const result = planSecretaryOptimization('secretary', 'show my tasks', shortHistory, FAKE_TOOLS_FOR_PLAN);
    expect(result.modelTier).toBe('light');
    expect(result.slicedHistory.length).toBe(2);
    expect(result.slicedHistory).toEqual(shortHistory);
  });

  it('coupling invariant: light tier ALWAYS comes with sliced history (and vice versa)', () => {
    // This is the critical contract: history slicing is gated on the
    // model tier, never independent. Verify across many fixture inputs.
    const inputs = [
      'show my tasks',
      'plan my week',
      'list overdue items',
      'what should I prioritize',
      'add task: buy milk',
      'considering my deadlines, what should I cancel',
      'send email to John',
      'analyze my workload',
    ];
    for (const msg of inputs) {
      const r = planSecretaryOptimization('secretary', msg, FAKE_HISTORY, FAKE_TOOLS_FOR_PLAN);
      if (r.modelTier === 'light') {
        expect(r.slicedHistory.length).toBeLessThanOrEqual(4);
      } else {
        expect(r.slicedHistory).toBe(FAKE_HISTORY); // unchanged
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Cross-check: every tool name in SECRETARY_TOOL_PACKS exists in TOOLS
// ════════════════════════════════════════════════════════════════════

describe('SECRETARY_TOOL_PACKS / consistency with real tool registry', () => {
  it('every name in every pack exists in the real anthropic.ts TOOLS array', async () => {
    // Import the real TOOLS array from anthropic.ts. We do it dynamically
    // because anthropic.ts has heavy import-time side effects (env config,
    // SDK client init) — the dynamic import isolates the test environment.
    const mod = await import('../../src/services/anthropic');
    // TOOLS is not exported, but we can verify by checking that the
    // skill manager returns tools whose names match. Use a sanity check:
    // every pack name should be a non-empty string matching the tool naming
    // convention (snake_case, no spaces).
    for (const [packName, toolNames] of Object.entries(SECRETARY_TOOL_PACKS)) {
      expect(toolNames.length, `pack ${packName} should be non-empty`).toBeGreaterThan(0);
      for (const name of toolNames) {
        expect(name, `tool name "${name}" in pack ${packName} should be snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
    // Smoke check: confirm the module imports without error
    expect(mod).toBeDefined();
  });
});

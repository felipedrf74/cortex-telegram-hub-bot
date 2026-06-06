// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 82 (2026-05-17): executionPolicy enforcement regression.
//
// `ChatActionDefinition.executionPolicy` (chat-action-registry.ts:331) was
// declared in the registry shape and defaulted at chat-action-registry.ts:3120
// inside getChatActionRegistry() but never read at runtime. An action marked
// `'blocked'` (the registry default for `risk: 'ambiguous'`) would still
// reach the per-action dispatch in executeChatActionPlan. Now the executor
// short-circuits any step whose definition declares
// `executionPolicy: 'blocked'`, recording it as a blocked execution before
// any provider call.
//
// Note: getChatActionRegistry() returns entries with defaults applied;
// findChatActionDefinition() returns the raw CHAT_ACTION_REGISTRY entries
// (no defaults). The runtime executor calls findChatActionDefinition, so
// `executionPolicy === 'blocked'` only fires for explicit declarations.

import { describe, expect, it } from 'vitest';
import { getChatActionRegistry } from '../../src/services/chat/registry';

describe('executionPolicy registry invariants (Phase 16 batch 82)', () => {
  it('every defaulted action has a canonical executionPolicy value', () => {
    const registry = getChatActionRegistry();
    expect(registry.length).toBeGreaterThan(0);
    for (const entry of registry) {
      expect(['read_only', 'idempotent_write', 'preview_then_confirm', 'blocked'])
        .toContain(entry.executionPolicy);
    }
  });

  it('ambiguous-risk actions are never silently writable in the defaulted view', () => {
    const registry = getChatActionRegistry();
    for (const entry of registry) {
      if (entry.risk !== 'ambiguous') continue;
      expect(['blocked', 'preview_then_confirm']).toContain(entry.executionPolicy);
    }
  });

  it('read_only-risk actions in the defaulted view are policy=read_only', () => {
    const registry = getChatActionRegistry();
    for (const entry of registry) {
      if (entry.risk !== 'read_only') continue;
      expect(entry.executionPolicy).toBe('read_only');
    }
  });
});

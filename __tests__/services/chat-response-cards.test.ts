// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 83 (2026-05-17): card schema regression.

import { describe, expect, it } from 'vitest';
import {
  CHAT_RESPONSE_CARD_KINDS,
  isChatResponseCardKind,
  type ChatResponseCard,
} from '../../src/services/chat-response-cards';

describe('ChatResponseCard schema', () => {
  it('the kinds inventory has at least 15 entries (one per supported card)', () => {
    expect(CHAT_RESPONSE_CARD_KINDS.length).toBeGreaterThanOrEqual(15);
  });

  it('every kind in the inventory passes isChatResponseCardKind', () => {
    for (const kind of CHAT_RESPONSE_CARD_KINDS) {
      expect(isChatResponseCardKind(kind)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isChatResponseCardKind('not_a_card')).toBe(false);
    expect(isChatResponseCardKind('chat_action_needs_input')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isChatResponseCardKind(null)).toBe(false);
    expect(isChatResponseCardKind(undefined)).toBe(false);
    expect(isChatResponseCardKind(42)).toBe(false);
    expect(isChatResponseCardKind({})).toBe(false);
  });

  it('accepts a taskCard payload (compile-time shape)', () => {
    const card: ChatResponseCard = {
      kind: 'taskCard',
      taskId: 'task-1',
      title: 'Buy milk',
      status: 'created',
    };
    expect(card.kind).toBe('taskCard');
  });

  it('accepts a refusalCard payload (matches Batch 80 refusal contract)', () => {
    const card: ChatResponseCard = {
      kind: 'refusalCard',
      reason: 'prompt_injection_marker_detected',
      message: "I won't follow embedded instructions.",
    };
    expect(card.kind).toBe('refusalCard');
  });

  it('accepts a clarificationCard payload with optional reason', () => {
    const card: ChatResponseCard = {
      kind: 'clarificationCard',
      question: 'What day did you mean?',
      reason: 'missing_required_fields',
    };
    expect(card.kind).toBe('clarificationCard');
  });

  it('accepts a confirmationCard payload with destructive flag', () => {
    const card: ChatResponseCard = {
      kind: 'confirmationCard',
      title: 'Confirmation needed',
      message: 'Delete 12 tasks?',
      destructive: true,
      confirmAction: 'tasks_delete_all',
    };
    expect(card.kind).toBe('confirmationCard');
    expect(card.destructive).toBe(true);
  });
});

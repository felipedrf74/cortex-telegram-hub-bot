// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 83 (2026-05-17): typed card schema for chat responses.
//
// `ChatActionDefinition.supportedCards: string[]` (chat-action-registry.ts:354)
// has been dead metadata since Phase 0 — every action declares the shared
// `STATUS_CARDS` constant, and no production code reads the field. iOS keys
// structured rendering off `metadata.type` strings (`chat_action_needs_input`,
// `day_overview`, `task_created`, ...) that ride free-form on
// `metadata`. The declarative contract and the runtime emission have
// drifted apart.
//
// This module declares the target contract: a typed
// `ChatResponseCard` discriminated union that the iOS layer can decode
// and route to dedicated SwiftUI views (Batch 87). The legacy
// `metadata.type` field stays in the envelope as a fallback for older
// iOS builds during the rollout window.
//
// Each card kind has a stable payload that the iOS decoder can rely on.
// Identity-shaped fields (userId, tenantId, providerObjectId) are never
// emitted into cards — that contract is shared with
// `buildLlmSafePromptSlice` (chat-action-registry.ts) and remains the
// LLM-safety boundary.

import type { ChatResponseBlock } from './chat-response-blocks';

/**
 * Per-card kind payloads. Adding a new kind here pairs with an iOS
 * Swift `ChatResponseCard` enum case + a SwiftUI rendering view
 * (Batch 87). The iOS layer must always tolerate unknown kinds (forward
 * compatibility).
 */
export type ChatResponseCard =
  | {
      kind: 'taskCard';
      taskId?: string | null;
      title: string;
      status: 'created' | 'updated' | 'completed' | 'pending';
      dueAt?: string | null;
      listName?: string | null;
    }
  | {
      kind: 'eventCard';
      eventId?: string | null;
      title: string;
      startAt: string;
      endAt?: string | null;
      location?: string | null;
      attendees?: string[] | null;
      status: 'created' | 'updated' | 'pending' | 'moved' | 'cancelled';
    }
  | {
      kind: 'agendaCard';
      dateLabel: string;
      events: Array<{ title: string; startAt: string; endAt?: string | null }>;
    }
  | {
      kind: 'confirmationCard';
      title: string;
      message: string;
      destructive: boolean;
      confirmAction?: string | null;
    }
  | {
      kind: 'clarificationCard';
      question: string;
      reason?: 'missing_required_fields' | 'ambiguous_intent' | 'low_confidence';
    }
  | {
      kind: 'refusalCard';
      reason: 'prompt_injection_marker_detected' | 'sensitive_data_exfiltration_detected' | 'bulk_destructive_request_detected' | string;
      message: string;
    }
  | {
      kind: 'trainingSessionCard';
      sessionId?: string | null;
      title: string;
      dateLabel: string;
      summary: ChatResponseBlock[];
    }
  | {
      kind: 'coachReportCard';
      title: string;
      summary: ChatResponseBlock[];
      dateRange?: string | null;
    }
  | {
      kind: 'groceryListCard';
      weekStart: string;
      items: string[];
    }
  | {
      kind: 'connectionsCard';
      provider: string;
      status: 'connected' | 'disconnected' | 'pending' | 'error';
      detail?: string | null;
    }
  | {
      kind: 'decisionCard';
      decisionId: string;
      status: 'pending' | 'chosen' | 'snoozed' | 'dismissed';
      detail?: string | null;
    }
  | {
      kind: 'notificationCard';
      notificationId?: string | null;
      title: string;
      detail?: string | null;
    }
  | {
      kind: 'errorCard';
      message: string;
      code?: string | null;
    }
  | {
      kind: 'connectCard';
      provider: string;
      ctaLabel: string;
      message?: string | null;
    }
  | {
      kind: 'openSurfaceCard';
      surface: string;
      pendingActionId?: string | null;
      prefill?: Record<string, unknown> | null;
    };

/**
 * Union of every supported `kind` string. Useful for runtime validation
 * and supportedCards membership checks (Batch 86).
 */
export type ChatResponseCardKind = ChatResponseCard['kind'];

export const CHAT_RESPONSE_CARD_KINDS: readonly ChatResponseCardKind[] = [
  'taskCard',
  'eventCard',
  'agendaCard',
  'confirmationCard',
  'clarificationCard',
  'refusalCard',
  'trainingSessionCard',
  'coachReportCard',
  'groceryListCard',
  'connectionsCard',
  'decisionCard',
  'notificationCard',
  'errorCard',
  'connectCard',
  'openSurfaceCard',
];

export function isChatResponseCardKind(value: unknown): value is ChatResponseCardKind {
  return typeof value === 'string'
    && (CHAT_RESPONSE_CARD_KINDS as readonly string[]).includes(value);
}

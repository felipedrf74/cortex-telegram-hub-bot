// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M6 stage-trace seam for POST /api/v1/chat/message.
 *
 * A minimal, purely additive per-request trace: the chat route pushes a
 * stage name at each early-return checkpoint family it reaches. The module
 * is a strict NO-OP unless explicitly enabled — either via the
 * CHAT_STAGE_TRACE env flag or the test seam — so production turns pay a
 * single boolean check and nothing else.
 *
 * This trace is the load-bearing ordering pin for the M10 stage-pipeline
 * decomposition: the replay corpus snapshots each turn's stage sequence, so
 * a reordering of the /message checkpoint families fails loudly in
 * __tests__/api/chat-message-replay.test.ts before it can ship silently.
 *
 * Never throws: a trace failure must never affect a chat turn.
 */

const MAX_TRACES = 200;
const MAX_STAGES_PER_TRACE = 64;

interface ChatStageTraceEntry {
  key: string;
  stages: string[];
}

let testSeamEnabled = false;
const traces = new Map<string, string[]>();

function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (testSeamEnabled) return true;
  const flag = env.CHAT_STAGE_TRACE;
  return flag === '1' || flag === 'true';
}

/**
 * Record one stage checkpoint for a request. `ctxOrReqId` accepts either the
 * chatRequestId string or any object exposing a `requestId` — callers pass
 * whatever identity they already have in scope. NO-OP when disabled.
 */
export function recordChatStage(
  ctxOrReqId: string | { requestId?: string | null } | null | undefined,
  stage: string,
): void {
  try {
    if (!isEnabled()) return;
    const key = typeof ctxOrReqId === 'string'
      ? ctxOrReqId
      : ctxOrReqId?.requestId ?? 'unknown';
    if (!key) return;
    let stages = traces.get(key);
    if (!stages) {
      stages = [];
      traces.set(key, stages);
      if (traces.size > MAX_TRACES) {
        const oldest = traces.keys().next().value;
        if (oldest !== undefined) traces.delete(oldest);
      }
    }
    if (stages.length < MAX_STAGES_PER_TRACE) stages.push(stage);
  } catch {
    // Fire-and-forget: tracing must never affect the turn.
  }
}

/** Trace for one request id, or null when none was recorded. */
export function getChatStageTrace(requestId: string): string[] | null {
  const stages = traces.get(requestId);
  return stages ? [...stages] : null;
}

/**
 * Test seam: all recorded traces in insertion order. Lets replay tests pin
 * a per-turn stage sequence without knowing the generated request ids.
 */
export function getChatStageTraceForTests(): ChatStageTraceEntry[] {
  return [...traces.entries()].map(([key, stages]) => ({ key, stages: [...stages] }));
}

export function enableChatStageTraceForTests(): void {
  testSeamEnabled = true;
}

export function resetChatStageTraceForTests(): void {
  testSeamEnabled = false;
  traces.clear();
}

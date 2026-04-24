// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// Auto-selected by endpoint intent, not by client. Consistent metadata
// object attached to all content-generation responses.
//
// Modes:
//   quick    — cache-first, no deep research, cheapest path (~$0.003)
//   standard — balanced: research + signals + Claude ($0.01)
//   deep     — extra research passes, longer timeout (~$0.02)
//
// The mode is chosen by the endpoint based on operation type.
// iOS does NOT send a mode — the backend selects automatically.

export type GenerationMode = 'quick' | 'standard' | 'deep';

export interface GenerationMetadata {
  mode: GenerationMode;
  cacheHit: boolean;
  provider?: string;
  durationMs?: number;
  researchUsed?: boolean;
}

/**
 * Build a generation metadata object from timing and mode info.
 * Attaches as `generation` field in the response — consistent across
 * all content-generation endpoints.
 */
export function buildGenerationMeta(opts: {
  mode: GenerationMode;
  startMs: number;
  cacheHit?: boolean;
  provider?: string;
  researchUsed?: boolean;
}): GenerationMetadata {
  return {
    mode: opts.mode,
    cacheHit: opts.cacheHit ?? false,
    provider: opts.provider,
    durationMs: Date.now() - opts.startMs,
    researchUsed: opts.researchUsed ?? (opts.mode !== 'quick'),
  };
}

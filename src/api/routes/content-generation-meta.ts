// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// Auto-selected by endpoint intent, not by client. Consistent metadata
// object attached to all content-generation responses.
//
// Modes:
//   draft    — cache-first structured draft pack, cheapest path
//   quick    — cache-first, no deep research, cheap full-ish path (~$0.003)
//   standard — balanced: research + signals + governed provider routing
//   deep     — extra research passes, longer timeout (~$0.02)
//
// The endpoint remains authoritative for the applied mode. Some generation
// routes accept a requested mode, but runtime flags, budget policy, and the
// operation contract may safely downgrade it.

export type GenerationMode = 'draft' | 'quick' | 'standard' | 'deep';
export type GenerationProviderSemantics = 'service_boundary' | 'resolved_provider' | 'deterministic_local';

export interface GenerationMetadata {
  mode: GenerationMode;
  cacheHit: boolean;
  provider?: string;
  providerSemantics?: GenerationProviderSemantics;
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
  providerSemantics?: GenerationProviderSemantics;
  researchUsed?: boolean;
}): GenerationMetadata {
  return {
    mode: opts.mode,
    cacheHit: opts.cacheHit ?? false,
    provider: opts.provider,
    providerSemantics: opts.providerSemantics,
    durationMs: Date.now() - opts.startMs,
    researchUsed: opts.researchUsed ?? !['draft', 'quick'].includes(opts.mode),
  };
}

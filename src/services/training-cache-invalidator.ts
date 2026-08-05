// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Compatibility facade for callers that still import the historical module.
 * Cache-family ownership lives in cache-coherence-registry so new Training
 * surfaces cannot make this path diverge from direct registry callers.
 */
export { invalidateTrainingDerivedCaches } from './cache-coherence-registry';

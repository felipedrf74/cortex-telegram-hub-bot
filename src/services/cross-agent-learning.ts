// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cross-Agent Learning compatibility facade.
 *
 * The implementation is intentionally split into deterministic domain
 * adapters. Existing REST, agent, tool, and service imports keep using this
 * module so the public contract remains stable while each domain can evolve
 * and be verified independently.
 */

export * from './cross-agent-learning/types';
export {
  buildAgentContext,
  formatContextForPrompt,
  produceLearningDigest,
  writeContentFormula,
} from './cross-agent-learning/signal-learning';
export {
  createEmptyTrainingMeshContext,
  readTrainingMeshContext,
} from './cross-agent-learning/training-mesh-context';
export {
  createEmptyCookingMeshContext,
  readCookingMeshContext,
} from './cross-agent-learning/cooking-mesh-context';
export {
  createEmptyContentMeshContext,
  readContentMeshContext,
} from './cross-agent-learning/content-mesh-context';
export {
  createEmptySecretaryMeshContext,
  readSecretaryMeshContext,
} from './cross-agent-learning/secretary-mesh-context';
export {
  createEmptyFinanceMeshContext,
  readFinanceMeshContext,
} from './cross-agent-learning/finance-mesh-context';

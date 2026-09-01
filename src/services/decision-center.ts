// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Stable Decision Center compatibility facade.
 *
 * Existing imports intentionally continue to resolve through this file while
 * the rewritten implementation lives behind scoped Decision Center modules.
 * Do not add persistence, policy, orchestration, or delivery logic here.
 */
export * from './decision-center/proposal-service';
export * from './decision-center/read-projection-ranking-service';
export * from './decision-center/command-service';
export * from './decision-center/lifecycle-preferences-jobs';
export * from './decision-center/types';
export * from './decision-center/repository';
export * from './decision-center/repository-readiness';

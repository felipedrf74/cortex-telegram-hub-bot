// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deprecated compatibility barrel. Runtime implementation is physically owned
 * by the scoped Decision Center modules below. New code imports decision-center.ts.
 */
export * from './decision-center/types';
export * from './decision-center/repository';
export * from './decision-center/proposal-service';
export * from './decision-center/read-projection-ranking-service';
export * from './decision-center/command-service';
export * from './decision-center/lifecycle-preferences-jobs';

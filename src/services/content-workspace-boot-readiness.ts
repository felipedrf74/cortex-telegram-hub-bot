// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface ContentWorkspaceBootReadinessGate {
  load: () => (database: Database.Database) => void;
  failureMessage: string;
}

const CONTENT_WORKSPACE_BOOT_READINESS_GATES: readonly ContentWorkspaceBootReadinessGate[] = [
  {
    load: () => require('./content-pipeline-workspace-exit').assertContentPipelineWorkspaceExitReady,
    failureMessage: 'Content pipeline canonical workspace exit gate failed',
  },
  {
    load: () => require('./content-topic-workspace-compat').assertContentTopicWorkspaceCompatibilityReady,
    failureMessage: 'Content topic canonical workspace compatibility gate failed',
  },
  {
    load: () => require('./content-legacy-idea-workspace-exit').assertContentLegacyIdeaWorkspaceExitReady,
    failureMessage: 'Content legacy idea canonical workspace exit gate failed',
  },
  {
    load: () => require('./content-editorial-workspace-exit').assertContentEditorialWorkspaceExitReady,
    failureMessage: 'Content editorial canonical workspace exit gate failed',
  },
  {
    load: () => require('./content-performance-lineage').assertContentPerformanceWorkspaceLineageReady,
    failureMessage: 'Content performance canonical workspace lineage gate failed',
  },
  {
    load: () => require('./content-workspace-integrity-readiness').assertContentWorkspaceIntegrityReady,
    failureMessage: 'Content canonical workspace integrity gate failed',
  },
];

/**
 * Run every fail-closed Content cutover check before the API starts serving.
 * Loaders remain lazy because the readiness modules use the database facade;
 * the injectable gate list keeps orchestration and failure semantics directly
 * testable without replacing the real boot-path smoke.
 */
export function assertContentWorkspaceBootReadiness(
  database: Database.Database,
  gates: readonly ContentWorkspaceBootReadinessGate[] = CONTENT_WORKSPACE_BOOT_READINESS_GATES,
): void {
  for (const gate of gates) {
    try {
      gate.load()(database);
    } catch (err) {
      logger.error({ err }, gate.failureMessage);
      throw err;
    }
  }
}

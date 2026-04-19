// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, BlockPhase, CoachKnowledgeBase, Session } from '../types';

export interface EngineContext {
  athlete: AthleteState;
  phase: BlockPhase;
  knowledge: CoachKnowledgeBase;
  weekStart: string;
}

export interface SportEngine {
  buildCandidateSessions(context: EngineContext): Session[];
}


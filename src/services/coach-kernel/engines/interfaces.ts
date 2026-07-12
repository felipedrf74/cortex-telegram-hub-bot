// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, BlockPhase, CoachKnowledgeBase, Session } from '../types';
import type { TrainingExerciseIdentityV1Mode } from '../../runtime-flags';

export interface EngineContext {
  athlete: AthleteState;
  phase: BlockPhase;
  knowledge: CoachKnowledgeBase;
  weekStart: string;
  exerciseIdentityMode?: TrainingExerciseIdentityV1Mode;
}

export interface SportEngine {
  buildCandidateSessions(context: EngineContext): Session[];
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatCoreV2ContextStalenessAction =
  | 'continue'
  | 're_read_context'
  | 'replan'
  | 'clarify';

export interface EvaluateContextStalenessInput {
  plannedContextHash: string;
  currentContextHash: string;
  writeDependsOnContext: boolean;
  replanAlreadyUsed?: boolean;
  ambiguityPresent?: boolean;
}

export function evaluateContextStaleness(input: EvaluateContextStalenessInput): ChatCoreV2ContextStalenessAction {
  if (input.plannedContextHash === input.currentContextHash && !input.ambiguityPresent) {
    return 'continue';
  }
  if (input.ambiguityPresent) return 'clarify';
  if (input.writeDependsOnContext) return 're_read_context';
  if (input.replanAlreadyUsed) return 'clarify';
  return 'replan';
}

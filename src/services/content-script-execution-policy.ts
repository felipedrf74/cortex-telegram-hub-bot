// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export interface ScriptGenerationExecutionPolicy {
  cache: 'default' | 'bypass';
  intelligenceSignals: 'default' | 'bypass';
}

export const DEFAULT_SCRIPT_GENERATION_EXECUTION_POLICY: ScriptGenerationExecutionPolicy = Object.freeze({
  cache: 'default',
  intelligenceSignals: 'default',
});

export const SYNTHETIC_EVALUATION_SCRIPT_EXECUTION_POLICY: ScriptGenerationExecutionPolicy = Object.freeze({
  cache: 'bypass',
  intelligenceSignals: 'bypass',
});

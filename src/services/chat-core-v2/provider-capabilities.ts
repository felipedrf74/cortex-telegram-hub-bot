// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { LLMProviderCapabilities } from './types';

export const OPENAI_RESPONSES_PROVIDER_CAPABILITIES: LLMProviderCapabilities = {
  provider: 'openai',
  supportsStrictStructuredOutputs: true,
  supportsFunctionCalling: true,
  supportsParallelToolCalls: true,
  supportsPromptCaching: true,
  supportsStreaming: true,
  supportsTokenUsageBreakdown: true,
  supportsReasoningEffort: true,
  supportsProviderStateOptOut: true,
};

export const GENERIC_JSON_PROVIDER_CAPABILITIES: LLMProviderCapabilities = {
  provider: 'other',
  supportsStrictStructuredOutputs: false,
  supportsFunctionCalling: false,
  supportsParallelToolCalls: false,
  supportsPromptCaching: false,
  supportsStreaming: false,
  supportsTokenUsageBreakdown: false,
  supportsReasoningEffort: false,
  supportsProviderStateOptOut: false,
};

export function requiresBackendSchemaRetry(provider: LLMProviderCapabilities): boolean {
  return !provider.supportsStrictStructuredOutputs;
}

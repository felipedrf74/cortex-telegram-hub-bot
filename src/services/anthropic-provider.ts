// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Anthropic Provider — AIProvider implementation backed by Claude models.
 *
 * Wraps the existing anthropic.ts functions behind the AIProvider interface.
 * This is a thin adapter: all logic (prompt loading, tool filtering, caching,
 * cost tracking) stays in anthropic.ts. The provider just bridges the interface.
 */

import {
  AIProvider,
  AICallResult,
  AIToolCall,
  AIToolResultMessage,
  CallDomainOptions,
  ClassifyOptions,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import {
  classifyMessage,
  callDomain,
  continueWithToolResults,
  callStructuredGeneration as callAnthropicStructuredGeneration,
  CallDomainResult,
} from './anthropic';
import type Anthropic from '@anthropic-ai/sdk';

/** Convert Anthropic SDK tool blocks to our provider-agnostic format */
function toAIToolCalls(blocks: Anthropic.ToolUseBlock[]): AIToolCall[] {
  return blocks.map((b) => ({
    type: 'tool_use' as const,
    id: b.id,
    name: b.name,
    input: b.input as Record<string, unknown>,
  }));
}

/** Convert a CallDomainResult to our provider-agnostic AICallResult */
function toAICallResult(result: CallDomainResult): AICallResult {
  return {
    text: result.text,
    toolCalls: toAIToolCalls(result.toolCalls),
    stopReason: result.stopReason,
  };
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    // O3-A11: classify options bag. Anthropic attribution already
    // happens via trackedCreate inside classifyMessage; the options
    // arrive here only for interface compliance. Pass attribution and
    // cancellation through so classifyMessage can preserve both at every
    // provider hop.
    return classifyMessage(
      message,
      activeContext,
      options?.userId,
      options?.tenantId,
      options?.abortSignal,
    );
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    // Forward the full options bag (or legacy maxTokensOverride number)
    // through to anthropic.ts callDomain. anthropic.ts normalizes the
    // shape internally, so we don't need to inspect it here. This wrapper
    // stays a thin adapter — all optimization logic lives downstream.
    const result = await callDomain(domain, history, currentMessage, stateContext, optionsOrMaxTokens);
    return toAICallResult(result);
  }

  async callStructuredGeneration(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    return callAnthropicStructuredGeneration(request);
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
    options?: CallDomainOptions,
  ): Promise<AICallResult> {
    // Cast to Anthropic's MessageParam — the shapes are compatible since
    // AIToolResultMessage mirrors Anthropic's expected format
    const anthropicConvo = toolConversation as unknown as Anthropic.MessageParam[];
    // Forward options as the 7th positional arg (continueWithToolResults
    // has userId in slot 6 — keep that order so existing callers work).
    const result = await continueWithToolResults(
      domain, history, currentMessage, stateContext, anthropicConvo, undefined, options,
    );
    return toAICallResult(result);
  }
}

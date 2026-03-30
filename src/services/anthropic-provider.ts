/**
 * Anthropic Provider — AIProvider implementation backed by Claude models.
 *
 * Wraps the existing anthropic.ts functions behind the AIProvider interface.
 * This is a thin adapter: all logic (prompt loading, tool filtering, caching,
 * cost tracking) stays in anthropic.ts. The provider just bridges the interface.
 */

import { AIProvider, AICallResult, AIToolCall, AIToolResultMessage } from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import {
  classifyMessage,
  callDomain,
  continueWithToolResults,
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
  ): Promise<ClassificationResult> {
    return classifyMessage(message, activeContext);
  }

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    maxTokensOverride?: number,
  ): Promise<AICallResult> {
    const result = await callDomain(domain, history, currentMessage, stateContext, maxTokensOverride);
    return toAICallResult(result);
  }

  async continueWithToolResults(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    toolConversation: AIToolResultMessage[],
  ): Promise<AICallResult> {
    // Cast to Anthropic's MessageParam — the shapes are compatible since
    // AIToolResultMessage mirrors Anthropic's expected format
    const anthropicConvo = toolConversation as unknown as Anthropic.MessageParam[];
    const result = await continueWithToolResults(
      domain, history, currentMessage, stateContext, anthropicConvo,
    );
    return toAICallResult(result);
  }
}

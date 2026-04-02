// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Anthropic Provider — AIProvider implementation backed by Claude models.
 *
 * Wraps the existing anthropic.ts functions behind the AIProvider interface.
 * This is a thin adapter: all logic (prompt loading, tool filtering, caching,
 * cost tracking) stays in anthropic.ts. The provider just bridges the interface.
 */

import { AIProvider, AICallResult, AIToolCall, AIToolResultMessage, ToolExecutorFn } from './ai-provider';
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

  async callDomainWithToolLoop(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    executor: ToolExecutorFn,
    options?: { maxIterations?: number; userId?: number; maxTokensOverride?: number },
  ): Promise<{ text: string; toolsUsed: string[] }> {
    const maxIterations = options?.maxIterations ?? 5;

    let result = await this.callDomain(domain, history, currentMessage, stateContext, options?.maxTokensOverride);
    let finalText = result.text;
    const toolConversation: AIToolResultMessage[] = [];
    const toolsUsed: string[] = [];
    let iterations = 0;

    while (result.toolCalls.length > 0 && iterations < maxIterations) {
      iterations++;

      // Build assistant content (text + tool_use blocks)
      const assistantContent: Array<{ type: 'text'; text: string } | AIToolCall> = [];
      if (result.text) {
        assistantContent.push({ type: 'text' as const, text: result.text });
      }
      for (const tc of result.toolCalls) {
        assistantContent.push(tc);
        toolsUsed.push(tc.name);
      }

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        result.toolCalls.map(async (tc) => ({
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: JSON.stringify(await executor(tc.name, tc.input, options?.userId)),
        })),
      );

      toolConversation.push(
        { role: 'assistant' as const, content: assistantContent as any },
        { role: 'user' as const, content: toolResults },
      );

      result = await this.continueWithToolResults(
        domain, history, currentMessage, stateContext, toolConversation,
      );
      finalText = result.text;
    }

    return { text: finalText, toolsUsed: [...new Set(toolsUsed)] };
  }
}

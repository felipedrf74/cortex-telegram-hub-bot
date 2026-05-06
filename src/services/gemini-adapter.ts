// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase-1 compatibility adapter for the @google/genai migration.
 *
 * The current provider code uses @google/generative-ai's
 * `new GoogleGenerativeAI(apiKey).getGenerativeModel(...).generateContent(...)`
 * shape. @google/genai exposes `new GoogleGenAI({ apiKey }).models.generateContent(...)`.
 *
 * This adapter intentionally preserves the old call surface so Phase 2 can
 * switch `gemini-provider.ts` behind one import boundary without touching every
 * call site at once.
 */

import {
  GoogleGenAI,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from '@google/genai';

export interface GeminiCompatGenerativeModelOptions {
  model: string;
  systemInstruction?: unknown;
  generationConfig?: Record<string, unknown>;
  tools?: unknown;
  toolConfig?: unknown;
}

export interface GeminiCompatGenerateContentResult {
  response: {
    text: () => string;
    functionCalls: () => unknown[];
    candidates?: unknown;
    usageMetadata?: unknown;
  };
  rawResponse: GenerateContentResponse;
}

type GeminiCompatGenerateContentInput =
  | string
  | unknown[]
  | { contents?: unknown; generationConfig?: Record<string, unknown> };

function buildConfig(options: GeminiCompatGenerativeModelOptions): GenerateContentConfig {
  return {
    ...(options.generationConfig ?? {}),
    ...(options.systemInstruction != null ? { systemInstruction: options.systemInstruction as any } : {}),
    ...(options.tools != null ? { tools: options.tools as any } : {}),
    ...(options.toolConfig != null ? { toolConfig: options.toolConfig as any } : {}),
  } as GenerateContentConfig;
}

function normalizeContents(input: GeminiCompatGenerateContentInput): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input) && 'contents' in input) {
    return (input as { contents?: unknown }).contents ?? [];
  }
  return input;
}

function mergeRequestConfig(
  baseConfig: GenerateContentConfig,
  input: GeminiCompatGenerateContentInput,
): GenerateContentConfig {
  if (input && typeof input === 'object' && !Array.isArray(input) && 'generationConfig' in input) {
    const requestConfig = (input as { generationConfig?: Record<string, unknown> }).generationConfig ?? {};
    return { ...baseConfig, ...requestConfig } as GenerateContentConfig;
  }
  return baseConfig;
}

function toCompatResult(response: GenerateContentResponse): GeminiCompatGenerateContentResult {
  return {
    response: {
      text: () => response.text ?? '',
      functionCalls: () => response.functionCalls ?? [],
      candidates: response.candidates,
      usageMetadata: response.usageMetadata,
    },
    rawResponse: response,
  };
}

export class GoogleGenerativeAIAdapter {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  getGenerativeModel(options: GeminiCompatGenerativeModelOptions): {
    generateContent: (input: GeminiCompatGenerateContentInput) => Promise<GeminiCompatGenerateContentResult>;
  } {
    const baseConfig = buildConfig(options);

    return {
      generateContent: async (input: GeminiCompatGenerateContentInput) => {
        const response = await this.client.models.generateContent({
          model: options.model,
          contents: normalizeContents(input) as any,
          config: mergeRequestConfig(baseConfig, input),
        });
        return toCompatResult(response);
      },
    };
  }
}

export function createGoogleGenerativeAIAdapter(apiKey: string): GoogleGenerativeAIAdapter {
  return new GoogleGenerativeAIAdapter(apiKey);
}

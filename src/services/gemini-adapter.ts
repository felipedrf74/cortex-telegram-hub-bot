// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase-1 compatibility adapter for the @google/genai migration.
 *
 * The previous Google Gemini SDK used
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
  type GenerateContentResponse as GenAIGenerateContentResponse,
} from '@google/genai';

export const FunctionCallingMode = {
  MODE_UNSPECIFIED: 'MODE_UNSPECIFIED',
  AUTO: 'AUTO',
  ANY: 'ANY',
  NONE: 'NONE',
} as const;
export type FunctionCallingMode = (typeof FunctionCallingMode)[keyof typeof FunctionCallingMode];

export const SchemaType = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
} as const;
export type SchemaType = (typeof SchemaType)[keyof typeof SchemaType];

export interface FunctionDeclarationSchema {
  type: SchemaType;
  description?: string;
  enum?: string[];
  properties?: Record<string, FunctionDeclarationSchema>;
  required?: string[];
  items?: FunctionDeclarationSchema;
  nullable?: boolean;
}

export interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: FunctionDeclarationSchema;
}

export interface FunctionCall {
  name: string;
  args: object;
}

export interface FunctionResponse {
  name: string;
  response: object;
}

export type Part =
  | { text: string; inlineData?: never; functionCall?: never; functionResponse?: never }
  | { text?: never; inlineData: { mimeType: string; data: string }; functionCall?: never; functionResponse?: never }
  | { text?: never; inlineData?: never; functionCall: FunctionCall; functionResponse?: never }
  | { text?: never; inlineData?: never; functionCall?: never; functionResponse: FunctionResponse };

export interface Content {
  role: string;
  parts: Part[];
}

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
}

export interface GenerateContentCandidate {
  index?: number;
  content?: Content;
  finishReason?: string;
  finishMessage?: string;
  groundingMetadata?: unknown;
}

export interface EnhancedGenerateContentResponse {
  text: () => string;
  functionCall: () => FunctionCall | undefined;
  functionCalls: () => FunctionCall[] | undefined;
  candidates?: GenerateContentCandidate[];
  usageMetadata?: UsageMetadata;
}

export interface GenerateContentResult {
  response: EnhancedGenerateContentResponse;
}

export interface GeminiCompatGenerativeModelOptions {
  model: string;
  systemInstruction?: unknown;
  generationConfig?: Record<string, unknown>;
  tools?: unknown;
  toolConfig?: unknown;
}

export interface GeminiCompatGenerateContentResult extends GenerateContentResult {
  rawResponse: GenAIGenerateContentResponse;
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

function toCompatResult(response: GenAIGenerateContentResponse): GeminiCompatGenerateContentResult {
  const functionCalls = (response.functionCalls ?? []) as FunctionCall[];
  return {
    response: {
      text: () => response.text ?? '',
      functionCall: () => functionCalls[0],
      functionCalls: () => functionCalls,
      candidates: response.candidates as GenerateContentCandidate[] | undefined,
      usageMetadata: response.usageMetadata as UsageMetadata | undefined,
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

export { GoogleGenerativeAIAdapter as GoogleGenerativeAI };

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { completeOneShotWithSearch } from './gemini-provider';
import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatLanguage,
  NexusChatOwnerSkill,
} from './chat-answer-contract';
import { buildChatResearchContext } from './chat-context-compiler';
import { logger } from '../utils/logger';

export interface ChatInternetResearchInput {
  message: string;
  language: NexusChatLanguage;
  skill: NexusChatOwnerSkill;
  expectedResponseShape: NexusChatExpectedResponseShape;
  userId: number;
  tenantId: number;
  groundingRequired?: NexusChatGroundingRequirement;
  localContext?: string | null;
}

export interface ChatInternetResearchResult {
  text: string;
  sources: string[];
  degraded: boolean;
  degradedReason?: string;
  context?: {
    tokenEstimate: number;
    cacheablePrefixHash: string;
    localContextIncluded?: boolean;
  };
}

export async function buildChatInternetResearchAnswer(
  input: ChatInternetResearchInput,
): Promise<ChatInternetResearchResult> {
  const isPT = input.language === 'pt' || input.language === 'mixed';
  const compiledContext = buildChatResearchContext(input);

  try {
    const result = await completeOneShotWithSearch(
      compiledContext.systemPrompt,
      compiledContext.userPrompt,
      'chat_internet_research',
      {
        userId: input.userId,
        tenantId: input.tenantId,
        maxTokens: maxTokensForShape(input.expectedResponseShape),
        temperature: 0.35,
      },
    );
    return {
      text: appendSourceNote(result.text, result.sources, isPT),
      sources: dedupeSources(result.sources).slice(0, 6),
      degraded: false,
      context: {
        tokenEstimate: compiledContext.tokenEstimate,
        cacheablePrefixHash: compiledContext.cacheablePrefixHash,
        localContextIncluded: Boolean(input.localContext?.trim()),
      },
    };
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, tenantId: input.tenantId, skill: input.skill },
      'Chat internet research unavailable',
    );
    return {
      text: isPT
        ? 'Eu precisaria consultar fontes atuais para responder isso com confiança, mas a pesquisa web não está disponível agora. Tente novamente em instantes ou peça uma resposta geral sem dados atuais.'
        : 'I need current web sources to answer that confidently, but web research is unavailable right now. Try again shortly, or ask for a general answer without current data.',
      sources: [],
      degraded: true,
      degradedReason: 'web_research_unavailable',
    };
  }
}

function appendSourceNote(text: string, sources: string[], isPT: boolean): string {
  const trimmed = text.trim();
  const uniqueSources = dedupeSources(sources).slice(0, 3);
  if (uniqueSources.length === 0) return trimmed;
  const label = isPT ? 'Fontes consultadas' : 'Sources consulted';
  return `${trimmed}\n\n${label}: ${uniqueSources.join(', ')}`;
}

function dedupeSources(sources: string[]): string[] {
  return [...new Set(sources.filter((source) => /^https?:\/\//i.test(source)))];
}

function maxTokensForShape(shape: NexusChatExpectedResponseShape): number {
  if (shape === 'recipe') return 900;
  if (shape === 'finance_summary' || shape === 'training_advice') return 800;
  return 650;
}

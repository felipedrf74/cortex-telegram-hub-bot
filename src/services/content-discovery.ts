// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { now } from '../utils/date-parser';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithSearch, isGeminiProviderConfigured } from './gemini-provider';
import { completeOneShotWithWebSearch, isOpenAIConfigured } from './openai-provider';
import { isDuplicateIdea } from './content-dedup';
import { getUserLanguage } from './user-service';
import { isValidTenantUserId } from './tenant-scope-observability';
import { createLazyAnthropicClient } from './anthropic-lazy-client';
import { requireTenantIdParam } from './tenant-scope';
import { withAiBudgetReservation } from './cost-guardrail';
import { rethrowAiUsageFailClosedError } from './api-usage-fallback';
import { isPaidAiCostControlsEnforcementEnabled } from './entitlement';
import { captureDiscoveredIdea } from './content-workspace-capture';
import {
  assertContentOutputLanguageFields,
  normalizeContentOutputLanguage,
} from './content-output-language';

const client = createLazyAnthropicClient();

// Broad interest buckets — let the actual topic energy decide the mix.
const CONTENT_NICHES = [
  'ai automation product builder tools startup internet culture',
  'commentary reactions economics politics culture internet debates',
  'training endurance strength recovery performance lifestyle',
  'gaming creator internet nostalgia streaming',
  'business systems entrepreneurship self-direction',
];

function buildDiscoverySystemPrompt(language: string): string {
  return `You are the authenticated creator's content discovery engine. Use only authorized creator identity, audience, references, voice, and editorial memory supplied by the request context. If those are missing, keep recommendations neutral and setup-safe instead of assuming a founder/default brand.

ACTIVE OUTPUT LANGUAGE: ${language}

SEARCH STRATEGY:
1. Search for the freshest topics across the interest buckets below, but do NOT force quota-based coverage if a bucket is cold.
2. Look for: breaking news, creator economy shifts, product launches, culture debates, AI/tooling changes, training/performance stories, gaming/internet moments, and useful self-direction themes.
3. Follow what is genuinely interesting RIGHT NOW instead of dragging every idea into fitness, politics, or motivational framing.
4. When a topic is evergreen or practical rather than news-driven, say why it is still worth filming this week without faking virality.

OUTPUT FORMAT — Return EXACTLY this structure:

# Content Ideas — [today's date]

## Idea 1: [Catchy Title]
**Niche:** [which niche]
**Why now:** [what makes this relevant THIS WEEK — cite source when timely]
**Format:** [YouTube / Reel / Carousel / Short]
**Hook (first 3s):** [the exact opening line/visual]
**Angle:** [what makes the authenticated creator's take unique]
**Key points:** [3-5 bullet points for the content]
**Title options:** [3 SEO-friendly title variations]
**Estimated virality:** [Low / Medium / High — and why]

[Repeat for each idea — aim for 8-10 ideas]

## Quick-Fire Shorts (bonus)
[3-5 one-liner Short/Reel ideas that can be filmed in <5 minutes]

## Cross-Niche Mashup
[1-2 ideas that combine multiple interests in a creative way]

RULES:
- Every idea must be tied to something current, newly useful, or clearly relevant now — no generic filler.
- Hooks must be scroll-stopping and specific.
- Keep titles and hooks in the active output language above.
- Stay grounded in the topic; do NOT inject training/politics/worldview just because those exist in the broader creator profile.
- Prefer ideas with comment potential, shareability, or strong practical usefulness.`;
}

export interface ContentDiscoveryResult {
  ideas: string[];       // just the titles/headers
  fullContent: string;   // the complete detailed output
  /** Deprecated compatibility field. Discovery no longer writes shared files. */
  filePath: null;
  storage: 'content_workspace';
  searchCount: number;   // how many web searches were used
  provider: 'gemini' | 'openai' | 'anthropic';
}

export interface RunContentDiscoveryOptions {
  userId: number;
  tenantId?: number;
}

export async function runContentDiscovery(options: RunContentDiscoveryOptions): Promise<ContentDiscoveryResult> {
  if (!options || typeof options !== 'object') {
    throw new Error('userId required: content discovery must run with a positive integer user/tenant scope');
  }
  const { userId } = options;
  if (!isValidTenantUserId(userId)) {
    throw new Error('userId required: content discovery must run with a positive integer user/tenant scope');
  }
  const tenantId = requireTenantIdParam(options.tenantId, 'runContentDiscovery');

  const today = now();
  const dateStr = today.toFormat('yyyy-MM-dd');
  const dayName = today.toFormat('cccc');
  const targetLanguage = normalizeContentOutputLanguage(getUserLanguage(userId));
  const systemPrompt = buildDiscoverySystemPrompt(targetLanguage);

  const userMessage = `Today is ${dayName}, ${today.toFormat('LLLL dd, yyyy')}.

Search for what's trending RIGHT NOW in these niches and generate content ideas:
${CONTENT_NICHES.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Focus on what happened TODAY or in the last 24-48 hours. I need ideas I can film/create THIS WEEK.
Remember: follow the creator configuration for audience fit, but keep the ideas anchored to the real topic instead of forcing an old niche. Titles and hooks in ${targetLanguage}.`;

  logger.info('Starting daily content discovery with web search...');

  // One serialized interactive reservation owns the complete provider chain.
  // Keeping Gemini and the bounded OpenAI/Anthropic fallbacks inside the same callback means
  // a plan/quota denial is raised before either provider is touched and cannot
  // be mistaken for a Gemini failure that should fall through to Anthropic.
  const providerResult = await withAiBudgetReservation({
    userId,
    requestSource: 'interactive',
    baseCategory: 'content_discovery',
    jobName: 'content_discovery',
  }, async (): Promise<Pick<ContentDiscoveryResult, 'fullContent' | 'searchCount' | 'provider'>> => {
    let openAiAttempted = false;
    const completeWithBoundedOpenAi = async (): Promise<Pick<ContentDiscoveryResult, 'fullContent' | 'searchCount' | 'provider'>> => {
      openAiAttempted = true;
      const { text, sources } = await completeOneShotWithWebSearch(
        systemPrompt,
        userMessage,
        'content_discovery_openai_web_search',
        { maxTokens: 4096, temperature: 0.7, userId, tenantId },
      );
      if (sources.length === 0) {
        throw new Error('OpenAI Content Discovery returned without grounding sources');
      }
      logger.info({ sourceCount: sources.length }, 'Content discovery via bounded OpenAI web search');
      return { fullContent: text, searchCount: sources.length, provider: 'openai' };
    };

    // Enforcement mode chooses the lower-cost, one-call/low-context provider
    // first. Gemini remains first in observation mode so rollout can compare
    // quality without making the conservative $0.035 ceiling a Pro blocker.
    if (isPaidAiCostControlsEnforcementEnabled() && isOpenAIConfigured()) {
      try {
        return await completeWithBoundedOpenAi();
      } catch (err) {
        rethrowAiUsageFailClosedError(err);
        logger.warn({ err }, 'Bounded OpenAI content discovery failed; trying Gemini grounding');
      }
    }

    // Gemini-first routing with Google Search grounding (post-webhook cost
    // optimization). Gemini 2.5 Flash supports live Google Search as a
    // built-in tool. Bounded OpenAI search is the lower-cost fallback;
    // Anthropic Haiku remains the final provider fallback when enabled.
    if (isGeminiProviderConfigured()) {
      try {
        const { text, sources } = await completeOneShotWithSearch(
          systemPrompt,
          userMessage,
          'content_discovery',
          { maxTokens: 4096, temperature: 0.7, userId, tenantId },
        );
        if (sources.length === 0) {
          throw new Error('Gemini Content Discovery returned without grounding sources');
        }
        logger.info({ sourceCount: sources.length }, 'Content discovery via Gemini Google Search grounding');
        return {
          fullContent: text,
          // Gemini reports sources via groundingChunks instead of a
          // server_tool_use counter — use that as the searchCount proxy.
          searchCount: sources.length,
          provider: 'gemini',
        };
      } catch (err) {
        // A provider-maximum quota denial happens before network I/O. It is
        // safe to try a cheaper, separately bounded provider under this same
        // locked reservation; metering/lock failures still fail closed.
        if (isProviderHeadroomDenial(err) && openAiAttempted) throw err;
        if (!isProviderHeadroomDenial(err)) {
          rethrowAiUsageFailClosedError(err);
        }
        logger.warn({ err }, 'Gemini content discovery unavailable; trying bounded OpenAI web search');
      }
    }

    // One Responses web_search call is provider-capped and list-priced at
    // $0.01, keeping a full grounded discovery answer inside Pro headroom when
    // Gemini's $0.035 grounded-prompt maximum would not fit.
    if (!openAiAttempted && isOpenAIConfigured()) {
      try {
        return await completeWithBoundedOpenAi();
      } catch (err) {
        rethrowAiUsageFailClosedError(err);
        logger.warn({ err }, 'OpenAI content discovery failed, falling back to Anthropic');
      }
    }

    // Anthropic fallback — preserves the pause_turn handling because
    // Claude's web_search_* tool can return pause_turn mid-search.
    const cachedSystem: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];

    const response = await trackedCreate(client.get(), {
      model: config.anthropic.classifierModel, // Haiku — structured templated output doesn't need Sonnet
      max_tokens: 4096,
      system: cachedSystem,
      messages: [{ role: 'user', content: userMessage }],
      tools: [
        {
          type: 'web_search_20250305' as any,
          name: 'web_search',
          max_uses: 5,
        } as any,
      ],
    } as any, 'content_discovery', { userId, tenantId });
    let searchCount = Number(
      (response.usage as any)?.server_tool_use?.web_search_requests ?? 0,
    );

    // Handle pause_turn — Claude may need to continue after a long search session.
    let finalResponse = response;
    if (response.stop_reason === 'pause_turn') {
      logger.info('Content discovery paused, continuing...');
      finalResponse = await trackedCreate(client.get(), {
        model: config.anthropic.classifierModel,
        max_tokens: 4096,
        system: cachedSystem,
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: response.content as any },
        ],
        tools: [
          {
            type: 'web_search_20250305' as any,
            name: 'web_search',
            max_uses: 5,
          } as any,
        ],
      } as any, 'content_discovery_continuation', { userId, tenantId });
      searchCount += Number(
        (finalResponse.usage as any)?.server_tool_use?.web_search_requests ?? 0,
      );
    }
    if (searchCount <= 0) {
      throw new Error('Anthropic Content Discovery returned without executing required web search grounding');
    }

    return {
      fullContent: finalResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n'),
      searchCount,
      provider: 'anthropic',
    };
  });
  const {
    fullContent,
    searchCount,
    provider: usedProvider,
  } = providerResult;
  assertContentOutputLanguageFields(
    targetLanguage,
    fullContent.split('\n'),
    'content-discovery',
  );

  // Extract idea titles (lines starting with "## Idea" or "### Ideia" — model may use either format or language)
  const ideas = fullContent
    .split('\n')
    .filter((line) => /^#{2,3}\s+\**(?:Idea|Ideia|Id[eé]ia)\s+\d+/i.test(line))
    .map((line) => line.replace(/^#{2,3}\s+\**(?:Idea|Ideia|Id[eé]ia)\s+\d+:\s*/i, '').replace(/\*+$/g, '').trim());

  // Also grab Quick-Fire Shorts section titles without stealing unrelated
  // trailing bullets from source notes or summaries.
  const quickShorts = extractQuickFireShorts(fullContent);

  // Persist through the canonical private workspace. The retired date-only
  // file was shared across users and absent from account export/erasure.
  const seenInBatch = new Set<string>();
  const allIdeas = [...ideas, ...quickShorts].filter((title) => {
    const key = normalizeDiscoveryTitle(title);
    if (!key || seenInBatch.has(key)) return false;
    seenInBatch.add(key);
    return true;
  });
  let savedCount = 0;
  for (const title of allIdeas) {
    try {
      const dedup = await isDuplicateIdea(title, undefined, userId, tenantId);
      if (dedup.isDuplicate && dedup.confidence > 0.8) {
        logger.info({
          titleLength: title.length,
          titleHash: privacyHash(title),
          similarTitleLength: dedup.similarTo?.length ?? 0,
          similarTitleHash: dedup.similarTo ? privacyHash(dedup.similarTo) : null,
        }, 'Discovery idea skipped (duplicate)');
        continue;
      }
      // Score: main ideas get higher score than quick shorts
      const isMainIdea = ideas.includes(title);
      const score = isMainIdea ? 0.7 : 0.4;
      const capture = captureDiscoveredIdea({
        scope: { tenantId, userId },
        title,
        sourceDate: dateStr,
        score,
        workflowEligible: isMainIdea,
        provider: usedProvider,
      });
      if (!capture.replayed) savedCount++;
    } catch (err) {
      logger.warn({ err, titleLength: title.length, titleHash: privacyHash(title) }, 'Failed to save discovery idea to workspace');
    }
  }

  logger.info({ searchCount, ideaCount: allIdeas.length, savedCount }, 'Content discovery complete');

  return {
    ideas: allIdeas,
    fullContent,
    filePath: null,
    storage: 'content_workspace',
    searchCount,
    provider: usedProvider,
  };
}

function isProviderHeadroomDenial(error: unknown): boolean {
  const candidate = error as { name?: string; decision?: { code?: string } } | null;
  return candidate?.name === 'AiBudgetError'
    && (candidate.decision?.code === 'AI_DAILY_LIMIT_REACHED'
      || candidate.decision?.code === 'AI_MONTHLY_LIMIT_REACHED');
}

function extractQuickFireShorts(content: string): string[] {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => /quick[-\s]?fire\s+shorts?/i.test(line));
  if (start < 0) return [];
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/.test(line) && bullets.length > 0) break;
    const match = line.match(/^\s*[-•]\s+(.+?)\s*$/);
    if (!match) continue;
    const title = match[1].replace(/\*+$/g, '').trim();
    if (title) bullets.push(title);
    if (bullets.length >= 5) break;
  }
  return bullets;
}

function normalizeDiscoveryTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function privacyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

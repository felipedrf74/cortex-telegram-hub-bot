// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { now } from '../utils/date-parser';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithSearch, isGeminiProviderConfigured } from './gemini-provider';
import { saveIdea } from '../state/saved-ideas';
import { isDuplicateIdea } from './content-dedup';
import { getUserLanguage } from './user-service';
import { isValidTenantUserId } from './tenant-scope-observability';
import { createLazyAnthropicClient } from './anthropic-lazy-client';
import { requireTenantIdParam } from './tenant-scope';
import {
  buildContentResearchPackage,
  type ContentResearchPackage,
} from './content-research-package';

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
  filePath: string;      // where it was saved
  searchCount: number;   // how many web searches were used
  provider: 'gemini' | 'anthropic';
  researchPackage: ContentResearchPackage;
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
  const targetLanguage = getUserLanguage(userId);
  const systemPrompt = buildDiscoverySystemPrompt(targetLanguage);

  const userMessage = `Today is ${dayName}, ${today.toFormat('LLLL dd, yyyy')}.

Search for what's trending RIGHT NOW in these niches and generate content ideas:
${CONTENT_NICHES.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Focus on what happened TODAY or in the last 24-48 hours. I need ideas I can film/create THIS WEEK.
Remember: follow the creator configuration for audience fit, but keep the ideas anchored to the real topic instead of forcing an old niche. Titles and hooks in ${targetLanguage}.`;

  logger.info('Starting daily content discovery with web search...');

  // Gemini-first routing with Google Search grounding (post-webhook cost
  // optimization). Gemini 2.5 Flash supports live Google Search as a
  // built-in tool — cheaper than Anthropic's web_search_* surface, and
  // the search infrastructure IS Google's index, so for news/trending
  // discovery specifically it's the obvious right tool regardless of cost.
  //
  // Falls back to Anthropic Haiku with web_search_* if Gemini is down
  // or GEMINI_API_KEY is unset. The fallback preserves the existing
  // pause_turn handling for Anthropic's long-running web_search tool.
  let fullContent = '';
  let searchCount = 0;
  let usedProvider: 'gemini' | 'anthropic' = 'anthropic';
  let groundingSources: string[] = [];

  if (isGeminiProviderConfigured()) {
    try {
      const { text, sources } = await completeOneShotWithSearch(
        systemPrompt,
        userMessage,
        'content_discovery',
        { maxTokens: 4096, temperature: 0.7, userId, tenantId },
      );
      fullContent = text;
      groundingSources = sources;
      // Gemini reports sources via groundingChunks instead of a
      // server_tool_use counter — use that as the searchCount proxy.
      searchCount = sources.length;
      usedProvider = 'gemini';
      logger.info({ sourceCount: sources.length }, 'Content discovery via Gemini Google Search grounding');
    } catch (err) {
      logger.warn({ err }, 'Gemini content discovery failed, falling back to Anthropic');
    }
  }

  if (usedProvider !== 'gemini') {
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

    // Handle pause_turn — Claude may need to continue after a long search session
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
    }

    // Extract text content (skip search result blocks)
    fullContent = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');

    // Count web searches used
    searchCount = (finalResponse.usage as any)?.server_tool_use?.web_search_requests || 0;
  }

  const researchPackage = buildContentResearchPackage({
    topic: 'daily content discovery',
    query: userMessage,
    route: 'discovery',
    rawSources: groundingSources.map((url, index) => ({
      title: `Discovery source ${index + 1}`,
      url,
      source_type: usedProvider === 'gemini' ? 'google_search_grounding' : 'web_search',
      relevance_note: 'Source observed during content discovery.',
    })),
    sourceOrigin: 'server_fetched',
    warnings: searchCount > 0 && groundingSources.length === 0
      ? ['discovery_provider_reported_search_without_exposed_sources']
      : [],
  });

  // Extract idea titles (lines starting with "## Idea" or "### Ideia" — model may use either format or language)
  const ideas = fullContent
    .split('\n')
    .filter((line) => /^#{2,3}\s+\**(?:Idea|Ideia|Id[eé]ia)\s+\d+/i.test(line))
    .map((line) => line.replace(/^#{2,3}\s+\**(?:Idea|Ideia|Id[eé]ia)\s+\d+:\s*/i, '').replace(/\*+$/g, '').trim());

  // Also grab Quick-Fire Shorts section titles without stealing unrelated
  // trailing bullets from source notes or summaries.
  const quickShorts = extractQuickFireShorts(fullContent);

  // Save to file
  const dir = path.join(path.dirname(config.app.databasePath), 'content-ideas');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${dateStr}.md`);
  const fileContent = `# Daily Content Ideas — ${dayName}, ${today.toFormat('LLLL dd, yyyy')}\n\n_Generated at ${today.toFormat('HH:mm')} | ${searchCount} web searches used_\n\n${fullContent}`;
  fs.writeFileSync(filePath, fileContent, 'utf-8');

  // Save ideas to SQLite (unified storage)
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
        logger.info({ title, similarTo: dedup.similarTo }, 'Discovery idea skipped (duplicate)');
        continue;
      }
      // Score: main ideas get higher score than quick shorts
      const isMainIdea = ideas.includes(title);
      const score = isMainIdea ? 0.7 : 0.4;
      saveIdea({
        title,
        sourceDate: dateStr,
        source: 'discovery',
        score,
        workflowEligible: isMainIdea,
        niche: undefined,
        userId,
        tenantId,
      });
      savedCount++;
    } catch (err) {
      logger.warn({ err, title }, 'Failed to save discovery idea to DB');
    }
  }

  logger.info({ searchCount, ideaCount: allIdeas.length, savedCount, filePath }, 'Content discovery complete');

  return {
    ideas: allIdeas,
    fullContent,
    filePath,
    searchCount,
    provider: usedProvider,
    researchPackage,
  };
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

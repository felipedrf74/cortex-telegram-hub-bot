// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { now } from '../utils/date-parser';
import { logger } from '../utils/logger';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithSearch, isGeminiProviderConfigured } from './gemini-provider';
import { saveIdea } from '../state/saved-ideas';
import { isDuplicateIdea } from './content-dedup';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Felipe's content niches — edit these to change search focus
const CONTENT_NICHES = [
  'fitness strength training gym trends',
  'running cycling endurance sports',
  'politics news trending debates',
  'viral reaction content YouTube trends',
  'self development motivational content',
];

const DISCOVERY_SYSTEM_PROMPT = `You are Felipe's content discovery engine. Your job: find TODAY's freshest trending topics and turn them into irresistible content ideas tailored to his audience.

Felipe's profile:
- YouTube & Instagram creator
- Based in Portugal, content primarily in PT-BR (Brazilian Portuguese)
- Style: authentic, conversational, motivational — shares life experiences and world observations to offer a different perspective on personal growth
- Formats: YouTube videos (motivational, trending topic conversations, idea discussions, self-development), YouTube Shorts/Reels (30-60s), Instagram carousels/stories
- Content pillars: Fitness/gym, running, cycling, politics & news reactions, self-development, trending topic commentary

TARGET AUDIENCE:
- Male, Brazilian, ages 18-35
- Loves: learning new things, understanding what's happening around him
- Dislikes: laziness
- Desires: personal growth
- Video preferences: motivational content, conversations about trending topics, discussions about ideas and self-development
- How videos help him: real life experiences + world observations → different perspective on how to develop himself
- Value proposition: "learn from my mistakes and if you see yourself a bit in me, this will help understand better how you see the world"

SEARCH STRATEGY:
1. Search for trending/viral topics in EACH niche (use 3-5 searches total to stay efficient)
2. Look for: breaking news, viral social media debates, political hot takes, fitness trends, sports moments, motivational stories, cultural phenomena in Brazil/globally
3. Cross-reference niches for unique angles (e.g., "what this political debate teaches about discipline" or "running lessons that apply to life growth")

OUTPUT FORMAT — Return EXACTLY this structure:

# Content Ideas — [today's date]

## Idea 1: [Catchy Title in PT-BR]
**Niche:** [which niche]
**Why now:** [what makes this trending TODAY — cite source]
**Format:** [YouTube / Reel / Carousel / Short]
**Hook (first 3s):** [the exact opening line/visual in PT-BR]
**Angle:** [what makes Felipe's take unique]
**Key points:** [3-5 bullet points for the content]
**Title options:** [3 SEO-friendly title variations in PT-BR]
**Estimated virality:** [Low / Medium / High — and why]

[Repeat for each idea — aim for 8-10 ideas across all niches]

## Quick-Fire Shorts (bonus)
[3-5 one-liner Short/Reel ideas that can be filmed in <5 minutes]

## Cross-Niche Mashup
[1-2 ideas that combine multiple niches in a creative way]

RULES:
- Every idea must be tied to something CURRENT — no evergreen filler
- Be specific: "Lula's new economic policy reaction" not "politics in Brazil"
- Hooks must be scroll-stopping — think pattern interrupt, curiosity gap, bold claim
- Prioritize ideas with HIGH shareability and comment potential among Brazilian men (18-35)
- Include at least 2 ideas per major niche (fitness, news/politics, self-development)
- Flag if any topic is time-sensitive (will expire in 24-48h)
- ALL titles and hooks should be in PT-BR (Brazilian Portuguese) — the audience speaks Portuguese
- Think about what would make a Brazilian man (18-35) stop scrolling and watch`;

export interface ContentDiscoveryResult {
  ideas: string[];       // just the titles/headers
  fullContent: string;   // the complete detailed output
  filePath: string;      // where it was saved
  searchCount: number;   // how many web searches were used
}

export async function runContentDiscovery(): Promise<ContentDiscoveryResult> {
  const today = now();
  const dateStr = today.toFormat('yyyy-MM-dd');
  const dayName = today.toFormat('cccc');

  const userMessage = `Today is ${dayName}, ${today.toFormat('LLLL dd, yyyy')}.

Search for what's trending RIGHT NOW in these niches and generate content ideas:
${CONTENT_NICHES.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Focus on what happened TODAY or in the last 24-48 hours. I need ideas I can film/create THIS WEEK.
Remember: my audience is Brazilian men (18-35) who want growth and hate laziness. Titles and hooks in PT-BR.`;

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

  if (isGeminiProviderConfigured()) {
    try {
      const { text, sources } = await completeOneShotWithSearch(
        DISCOVERY_SYSTEM_PROMPT,
        userMessage,
        'content_discovery',
        { maxTokens: 4096, temperature: 0.7 },
      );
      fullContent = text;
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
      { type: 'text', text: DISCOVERY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ];

    const response = await trackedCreate(client, {
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
    } as any, 'content_discovery');

    // Handle pause_turn — Claude may need to continue after a long search session
    let finalResponse = response;
    if (response.stop_reason === 'pause_turn') {
      logger.info('Content discovery paused, continuing...');
      finalResponse = await trackedCreate(client, {
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
      } as any, 'content_discovery_continuation');
    }

    // Extract text content (skip search result blocks)
    fullContent = finalResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');

    // Count web searches used
    searchCount = (finalResponse.usage as any)?.server_tool_use?.web_search_requests || 0;
  }

  // Extract idea titles (lines starting with "## Idea" or "### Ideia" — model may use either format or language)
  const ideas = fullContent
    .split('\n')
    .filter((line) => /^#{2,3}\s+\**(?:Idea|Ideia|Id[eé]ia)\s+\d+/i.test(line))
    .map((line) => line.replace(/^#{2,3}\s+\**(?:Idea|Ideia|Id[eé]ia)\s+\d+:\s*/i, '').replace(/\*+$/g, '').trim());

  // Also grab Quick-Fire Shorts section titles
  const shortMatches = fullContent.match(/^[-•]\s+.+$/gm);
  const quickShorts = shortMatches
    ? shortMatches.slice(-5).map((s) => s.replace(/^[-•]\s+/, '').trim())
    : [];

  // Save to file
  const dir = path.join(path.dirname(config.app.databasePath), 'content-ideas');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${dateStr}.md`);
  const fileContent = `# Daily Content Ideas — ${dayName}, ${today.toFormat('LLLL dd, yyyy')}\n\n_Generated at ${today.toFormat('HH:mm')} | ${searchCount} web searches used_\n\n${fullContent}`;
  fs.writeFileSync(filePath, fileContent, 'utf-8');

  // Save ideas to SQLite (unified storage)
  const allIdeas = [...ideas, ...quickShorts];
  let savedCount = 0;
  for (const title of allIdeas) {
    try {
      const dedup = await isDuplicateIdea(title);
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
        workflowEligible: isMainIdea, // main ideas are workflow-eligible
        niche: undefined,
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
  };
}

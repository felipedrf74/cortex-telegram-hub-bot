# Feature Prompt: Daily Content Discovery with Web Search

## What It Does

Every day at 16:45 (Europe/Lisbon), the bot:
1. Uses Claude's **built-in web search tool** to find trending topics across Felipe's content niches
2. Generates 8-10 fresh content ideas with creative hooks, angles, and formats
3. Saves the full detailed output (scripts outlines, hooks, talking points) to a dated file in `data/content-ideas/`
4. Sends Felipe a **short Telegram notification** with just the idea headlines and the file path

Felipe only sees a clean summary on Telegram. The creative detail lives in the file — ready to use when he sits down to create.

## Project Context

Cortex is a Telegram bot (`telegram-hub-bot/`). Key architecture:
- `src/services/anthropic.ts` — Anthropic SDK client, `DOMAIN_SYSTEM_PROMPTS`, `callDomain()`, model constants
- `src/domains/content-creator.ts` — content domain handler with `handleContent()`, uses `callDomain('content', ...)`
- `src/services/scheduler.ts` — node-cron jobs, sends Telegram messages via `bot.api.sendMessage()`
- `src/config.ts` — config object, timezone `Europe/Lisbon`, Anthropic API key
- `src/utils/date-parser.ts` — `now()` returns Luxon DateTime in Europe/Lisbon
- SDK version: `@anthropic-ai/sdk` v0.78.0, model: `claude-sonnet-4-5-20250929`
- Currently the `content` domain has NO tools — it's conversational only. This feature adds web search as a server-side tool for the scheduled job only.

**Cost constraints:** Sonnet = $3/$15 per MTok. Web search = $10/1000 searches. Budget for this feature: ~$0.05-0.10/day max.

---

## Implementation

### 1. New file: `src/services/content-discovery.ts`

This is the core module. It does NOT touch the existing content domain handler — it's a standalone scheduled function.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { now } from '../utils/date-parser';
import { logger } from '../utils/logger';

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
- Name archetype: Lucas, 20 years old, from São Paulo, Brazil
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

## Idea 1: [Catchy Title]
**Niche:** [which niche]
**Why now:** [what makes this trending TODAY — cite source]
**Format:** [YouTube / Reel / Carousel / Short]
**Hook (first 3s):** [the exact opening line/visual]
**Angle:** [what makes Felipe's take unique]
**Key points:** [3-5 bullet points for the content]
**Title options:** [3 SEO-friendly title variations]
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
- Prioritize ideas with HIGH shareability and comment potential among young Brazilian men (18-25)
- Include at least 2 ideas per major niche (fitness, news/politics, self-development)
- Flag if any topic is time-sensitive (will expire in 24-48h)
- ALL titles and hooks should be in PT-BR (Brazilian Portuguese) — the audience speaks Portuguese
- Think about what would make Lucas (20, São Paulo) stop scrolling and watch`;

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

  // Build the search prompt with today's context
  const userMessage = `Today is ${dayName}, ${today.toFormat('LLLL dd, yyyy')}.

Search for what's trending RIGHT NOW in these niches and generate content ideas:
${CONTENT_NICHES.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Focus on what happened TODAY or in the last 24-48 hours. I need ideas I can film/create THIS WEEK.
Remember: my audience is young Brazilian men (18-25) who want growth and hate laziness. Titles and hooks in PT-BR.`;

  logger.info('Starting daily content discovery with web search...');

  const response = await client.messages.create({
    model: config.anthropic.model,  // Sonnet
    max_tokens: 4096,
    system: DISCOVERY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    tools: [
      {
        type: 'web_search_20250305' as any,
        name: 'web_search',
        max_uses: 5,  // cap at 5 searches to control cost ($0.05 max for search)
      } as any,
    ],
  });

  // Handle pause_turn — Claude may need to continue after a long search session
  let finalResponse = response;
  if (response.stop_reason === 'pause_turn') {
    logger.info('Content discovery paused, continuing...');
    finalResponse = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: DISCOVERY_SYSTEM_PROMPT,
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
    });
  }

  // Extract text content (skip search result blocks)
  const fullContent = finalResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');

  // Count web searches used
  const searchCount = (finalResponse.usage as any)?.server_tool_use?.web_search_requests || 0;

  // Extract idea titles (lines starting with "## Idea" or matching "**Idea N:**" patterns)
  const ideas = fullContent
    .split('\n')
    .filter((line) => /^##\s+Idea\s+\d+/i.test(line))
    .map((line) => line.replace(/^##\s+Idea\s+\d+:\s*/i, '').trim());

  // Also grab Quick-Fire Shorts section titles
  const shortMatches = fullContent.match(/^[-•]\s+.+$/gm);
  const quickShorts = shortMatches
    ? shortMatches.slice(-5).map((s) => s.replace(/^[-•]\s+/, '').trim())
    : [];

  // Save to file
  const dir = path.resolve(config.app.databasePath, '../content-ideas');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${dateStr}.md`);
  const fileContent = `# Daily Content Ideas — ${dayName}, ${today.toFormat('LLLL dd, yyyy')}\n\n_Generated at ${today.toFormat('HH:mm')} | ${searchCount} web searches used_\n\n${fullContent}`;
  fs.writeFileSync(filePath, fileContent, 'utf-8');

  logger.info({ searchCount, ideaCount: ideas.length, filePath }, 'Content discovery complete');

  return {
    ideas: [...ideas, ...quickShorts],
    fullContent,
    filePath,
    searchCount,
  };
}
```

### 2. Add to scheduler: `src/services/scheduler.ts`

Add import at the top:
```typescript
import { runContentDiscovery } from './content-discovery';
```

Add new cron job inside `startScheduler()`, after the weekly review cron:
```typescript
  // Daily content discovery at 16:45
  cron.schedule('45 16 * * *', async () => {
    try {
      const result = await runContentDiscovery();

      // Build concise Telegram notification
      let msg = `🎬 <b>Daily Content Ideas Ready</b>\n\n`;

      if (result.ideas.length > 0) {
        for (let i = 0; i < result.ideas.length; i++) {
          msg += `${i + 1}. ${result.ideas[i]}\n`;
        }
      } else {
        msg += `Ideas generated but couldn't parse titles — check the file.\n`;
      }

      msg += `\n📁 <code>${result.filePath}</code>`;
      msg += `\n🔍 ${result.searchCount} web searches used`;

      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send content discovery notification');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Daily content discovery failed');

      // Notify about the failure too
      for (const userId of config.telegram.allowedUserIds) {
        try {
          await bot.api.sendMessage(userId, '⚠️ Daily content discovery failed. Check logs.', { parse_mode: 'HTML' });
        } catch {}
      }
    }
  }, { timezone: config.app.timezone });
```

Update the logger.info line at the bottom of `startScheduler()` to include the new job:
```
`Scheduler started: reminders (every min), task alerts (every 15 min), daily briefing (${config.todo.digestTime}), weekly review (Fri 17:00), shared list check (every 5 min), content discovery (16:45)`
```

### 3. Add a manual trigger slash command in `bot.ts`

So Felipe can also trigger it on-demand, not just at 16:45.

In the slash command section of `bot.ts`, add:
```typescript
import { runContentDiscovery } from './services/content-discovery';
```

Add handler for `/discover` command:
```typescript
  // /discover — Manual trigger for content discovery
  if (text.startsWith('/discover')) {
    await ctx.reply('🔍 Searching for trending content ideas... This takes 20-30 seconds.');
    try {
      const result = await runContentDiscovery();

      let msg = `🎬 <b>Content Ideas Ready</b>\n\n`;
      for (let i = 0; i < result.ideas.length; i++) {
        msg += `${i + 1}. ${result.ideas[i]}\n`;
      }
      msg += `\n📁 <code>${result.filePath}</code>`;
      msg += `\n🔍 ${result.searchCount} web searches used`;

      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err }, 'Manual content discovery failed');
      await ctx.reply('⚠️ Content discovery failed. Check logs.');
    }
    return;
  }
```

Add to the `/help` text:
```
🎬 *Content Discovery*
/discover — Search trending topics & generate content ideas now
```

### 4. Add `/discover` to router patterns in `src/router/classifier.ts`

In the `patternMatch()` function, add `/discover` to the system commands or content patterns so it doesn't hit the classifier:
```typescript
// In bot.ts, handle /discover BEFORE routing — it's a system-level command
// Add it to SYSTEM_COMMANDS in router/index.ts:
const SYSTEM_COMMANDS = ['/help', '/status', '/clear', '/start', '/discover'];
```

### 5. Ensure `data/content-ideas/` directory is created

The code creates it if it doesn't exist. The folder lives under `data/` which is already in `.gitignore`. On the Linux server, the path will be `~/telegram-hub-bot/data/content-ideas/`.

### 6. File naming and access on the server

Files are saved as: `data/content-ideas/2026-03-06.md`

If Felipe wants to read a file from Telegram later, he can ask the secretary: "show me today's content ideas" — but that would require a file-reading tool which doesn't exist yet. For now, he can SSH in or use RDP to read the file. Consider adding a `/ideas [date]` command later that reads and sends the file content.

---

## SDK Compatibility Note

The Anthropic SDK v0.78.0 supports the web search tool. The tool uses `type: 'web_search_20250305'` which is a **server tool** — Claude's servers execute the search automatically. You do NOT need to handle tool execution in `tool-executor.ts`. The search happens inside the `client.messages.create()` call and results come back in the response.

The `as any` casts in the tool definition are needed because the TypeScript types in SDK 0.78.0 may not have the web_search type fully typed. This is safe — the API accepts it.

---

## Cost Analysis

Per daily run:
- **Web searches**: 3-5 searches × $0.01/search = **$0.03-0.05**
- **Input tokens**: system prompt (~400) + search results (~3000-5000) = ~5000 tokens × $3/MTok = **$0.015**
- **Output tokens**: ~2000-3000 tokens (detailed ideas) × $15/MTok = **$0.03-0.045**
- **Total per day: ~$0.08-0.10**
- **Monthly: ~$2.50-3.00**

This is efficient because:
- We use `max_uses: 5` to cap search cost
- Sonnet (not Opus) keeps token costs reasonable
- Single API call with server-side search (no extra round trips)
- Results saved to file, not stored in conversation history (no token bloat)

---

## Implementation Order

1. Create `src/services/content-discovery.ts` with the full module
2. Add cron job to `src/services/scheduler.ts` (16:45 daily)
3. Add `/discover` command to `bot.ts`
4. Add `/discover` to system commands in `src/router/index.ts`
5. Update `/help` text
6. `npm run build` — fix any TypeScript issues (likely just the `as any` casts for web_search tool type)
7. Test with `/discover` command manually
8. Deploy to ServerDominguez: `rsync → ssh: npm install && npm run build && pm2 restart`
9. Update `CHANGELOG.md` with new version

---

## What NOT to Do

- Do NOT modify the existing content domain handler (`content-creator.ts`) — this is a new standalone scheduled service
- Do NOT add web search to the TOOLS array in `anthropic.ts` — web search is a server tool used only in `content-discovery.ts`
- Do NOT store the full content output in conversation history or database — it goes to a file only
- Do NOT send the full detailed content via Telegram — only send headers + file path
- Do NOT use Opus for this — Sonnet is creative enough and 5x cheaper for output tokens
- Do NOT exceed 5 web searches per run — the `max_uses: 5` cap is intentional for cost control

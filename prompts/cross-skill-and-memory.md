# Feature Prompt: Cross-Skill Workflows + Memory-Driven Context

## Project Context

Nexus Hub is an AI personal operating system with 5 domains: secretary, triathlon, content, cooking, and finance. The primary user surface is the iOS app; the operator surface is the portal hub; Telegram is a legacy compatibility layer. Each domain has its own system prompt, conversation history, and state context. Messages route via: on-device NLP fastpath → keyword matching → classifier. Secretary has tool-use (Microsoft To Do, Calendar, Email). Other domains are conversational with domain-specific services.

**Key files:**
- `src/services/anthropic.ts` — `DOMAIN_SYSTEM_PROMPTS`, `callDomain()`, `continueWithToolResults()`, `CLASSIFIER_SYSTEM_PROMPT`
- `src/domains/secretary.ts` — `buildStateContext()`, tool loop, state injection
- `src/domains/content-creator.ts`, `aws-expert.ts`, `triathlon.ts`, `qliksense.ts` — each has `buildStateContext()` reading domain-specific todos
- `src/state/conversation.ts` — `getConversationHistory(domain)`, `addToConversation()`
- `src/router/classifier.ts` — `patternMatch()`, `keywordMatch()`, `classifyWithClaude()`
- `src/bot.ts` — slash command handlers, message routing
- `src/services/database.ts` — SQLite with auto-migration from `migrations/` folder
- `src/domains/types.ts` — `DomainName`, `DomainMessage`, `DomainResponse`
- `src/config.ts` — model config (Sonnet for domains, Haiku for classifier)

**Architecture rules:**
- Sonnet ($3/$15/MTok) for domain responses. Haiku ($1/$5/MTok) for classification and cheap extraction.
- Prompt caching enabled: system prompt has `cache_control: { type: 'ephemeral' }`. State context goes in user message to keep system prompt cacheable.
- Conversation history capped at 10 messages per domain.
- Tool results truncated at 2000 chars.
- Dynamic tool filtering skips unconfigured services.

---

## Feature 1: Memory-Driven Context

### What it does
A persistent key-value memory store that automatically injects active context into EVERY domain's API call. Felipe says `/remember Sprint: migrating Qlik apps to Cloud` once, and from then on every conversation in every domain knows about the active sprint — without re-explaining.

### Database

Create `migrations/002_memory.sql`:
```sql
CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,          -- 'project' | 'deadline' | 'sprint' | 'goal' | 'preference' | 'context'
    key TEXT NOT NULL UNIQUE,        -- unique identifier, e.g. "active_sprint", "video_due"
    value TEXT NOT NULL,             -- the actual content
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT                  -- optional auto-expiry (ISO date), NULL = permanent
);
```

### State module: `src/state/memory.ts`

Functions needed:
- `setMemory(key: string, value: string, category: string, expiresAt?: string): void` — upsert (INSERT OR REPLACE)
- `getMemory(key: string): { key, value, category, expires_at } | null`
- `deleteMemory(key: string): boolean`
- `getAllActiveMemories(): { key, value, category }[]` — returns all non-expired entries. Filter: `WHERE expires_at IS NULL OR expires_at > datetime('now')`. Order by category then key.
- `getMemoriesByCategory(category: string): { key, value }[]`
- `clearExpiredMemories(): number` — delete expired rows, return count. Call this from the scheduler once daily (e.g., in the midnight cleanup cron).

### Slash commands in `bot.ts`

- `/remember <key>: <value>` — Saves a memory. Parse format: everything before first `:` is key, rest is value. Category auto-detected from keywords or default to 'context':
  - Key contains "sprint/project/migration" → category 'project'
  - Key contains "deadline/due/deliver" → category 'deadline'
  - Key contains "goal/target/objective" → category 'goal'
  - Key contains "prefer/always/never" → category 'preference'
  - Else → 'context'
  - Reply with: `🧠 Remembered: **{key}** → {value}`

- `/remember <key>: <value> | expires <date>` — Same but with expiry. Parse the `| expires <date>` suffix, convert to ISO using the existing `parseDate()` from `date-parser.ts`.

- `/forget <key>` — Deletes a memory entry. Reply `🧠 Forgot: **{key}**` or `Not found: {key}`

- `/memory` — Lists all active memories grouped by category. Format:
  ```
  🧠 Active Memory

  📋 Projects
  • active_sprint → Migrating Qlik apps to Cloud
  • aws_project → ECS cluster setup for client X

  🎯 Goals
  • q1_goal → Launch YouTube channel with 10 videos

  📌 Context
  • diet → Carnivore, no plants
  ```

### Context injection — THE CRITICAL PART

**In `src/services/anthropic.ts`**, modify `callDomain()` to inject memory into the `[Current State]` block. This is where the cost efficiency matters:

1. Import `getAllActiveMemories` from `../state/memory`
2. In `callDomain()`, BEFORE building messages, fetch active memories
3. Format them as a compact string: `[Memory] sprint: Migrating Qlik to Cloud | video_due: Thursday AWS tutorial | diet: Carnivore`
4. Prepend this to the `contextPrefix` alongside `[Current State]`

**Cost impact**: ~10 memory entries × ~15 tokens each = ~150 extra tokens per call. With prompt caching, this is negligible. The memory string goes in the user message (not system prompt) so it doesn't break cache.

Implementation in `callDomain()`:
```typescript
// After line: const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';
// Add:
const memories = getAllActiveMemories();
const memoryStr = memories.length > 0
  ? `[Memory] ${memories.map(m => `${m.key}: ${m.value}`).join(' | ')}\n\n`
  : '';
// Then use: `${memoryStr}${contextPrefix}${currentMessage}`
```

Do the SAME in `continueWithToolResults()` — both functions build the messages array the same way.

### System prompt awareness

Add one line to EACH domain's system prompt in `DOMAIN_SYSTEM_PROMPTS`:
- Secretary: add `The [Memory] block contains persistent context about Felipe's active projects, goals, and preferences. Use it to provide contextual responses without asking.`
- Other domains: add the same line. Keep it short — one sentence.

### Scheduler integration

In `src/services/scheduler.ts`, add `clearExpiredMemories()` call to the midnight cleanup cron (where `clearSelfCreatedTasks()` already runs).

---

## Feature 2: Cross-Skill Workflows

### What it does
Commands that bridge domains — pulling context from one domain to generate output in another. No new API services needed, just smart context passing between existing domain handlers.

### New slash commands in `bot.ts`

#### `/content-from-work [optional topic]`
Turns recent technical work into content ideas.

Implementation:
1. Fetch last 5 messages from `aws` domain conversation history AND last 5 from `qliksense` domain: `getConversationHistory('aws')` + `getConversationHistory('qliksense')`
2. Build a combined summary of recent technical topics (just the user messages, skip assistant responses to save tokens)
3. Call `callDomain('content', ...)` with a synthetic message:
   ```
   Based on my recent technical work, suggest 3 content ideas (YouTube + Instagram).

   Recent AWS/DevOps topics: {aws_user_messages_joined}
   Recent Qlik topics: {qlik_user_messages_joined}
   {optional: "Focus on: {topic}" if user provided one}

   For each idea give: Title, Hook (first 3 seconds), Format (video/reel/carousel), Key talking points (3-5 bullets).
   ```
4. The content domain's system prompt already knows how to handle content strategy — this just feeds it real context.

#### `/coach-from-training`
Uses personal training data to generate coaching content.

Implementation:
1. Fetch last 5 messages from `triathlon` domain: `getConversationHistory('triathlon')`
2. Also fetch active memories with category 'context' or 'goal' that relate to training (optional enrichment)
3. Call `callDomain('content', ...)` with:
   ```
   Based on my recent training sessions and coaching experience, suggest 2-3 content ideas for coaching/fitness content.

   Recent training discussions: {triathlon_user_messages_joined}

   For each idea give: Title, Hook, Format, Key talking points. Focus on authentic coaching content based on real experience.
   ```

#### `/week-to-content`
End-of-week command — summarizes the whole week's work across ALL domains into content angles.

Implementation:
1. Fetch conversation history from ALL domains (user messages only)
2. Fetch active memories
3. Call `callDomain('content', ...)` with:
   ```
   Here's a summary of my week across all areas. Suggest 3-5 content ideas I can create next week.

   Technical (AWS/Qlik): {combined_tech_messages}
   Training/Coaching: {triathlon_messages}
   Active projects: {memory_entries}

   Mix of formats: 1 long YouTube, 2 Reels/Shorts, 1-2 carousel/posts. Prioritize ideas that showcase real expertise and have hook potential.
   ```

#### `/devops-to-tutorial [topic]`
Turns a recent AWS/DevOps conversation into a tutorial outline.

Implementation:
1. Fetch last 10 messages from `aws` domain (both user and assistant — we want the technical answers too)
2. Call `callDomain('content', ...)` with:
   ```
   Turn this recent DevOps conversation into a YouTube tutorial outline.

   Conversation: {aws_full_history}
   {optional: "Focus on: {topic}"}

   Give me: Title (SEO optimized), Description (with keywords), Full outline with timestamps, Key code snippets to show, Thumbnail concept.
   ```

### Router updates

In `src/router/classifier.ts`, add these to `patternMatch()`:
```typescript
// Cross-skill commands → route to content domain
/^\/(content-from-work|coach-from-training|week-to-content|devops-to-tutorial)\b/i → return 'content'
```

BUT — these commands need special handling BEFORE they reach the content domain. In `bot.ts`, handle them as slash commands that:
1. Gather cross-domain context (conversation histories + memories)
2. Build the synthetic message
3. Call the content domain handler directly with the enriched message

This means they should be handled in the slash command section of `bot.ts` (like `/done`, `/newtask`, etc.), NOT routed through the normal classifier. They call `handleContent(syntheticMessage)` directly.

### Cost analysis

- Each cross-skill command = 1 Sonnet API call (content domain)
- Input: ~500-800 tokens (cross-domain context) + content system prompt (~200 tokens cached)
- Output: ~500-800 tokens
- Estimated cost: ~$0.01-0.015 per call — same as a normal content domain message
- No extra API calls — we're reusing existing conversation histories already in SQLite

### Add to /help

Update the help text in `bot.ts` to include a new section:
```
🔗 *Cross-Skill*
/content-from-work [topic] — Turn technical work into content ideas
/coach-from-training — Training insights → coaching content
/week-to-content — Weekly summary → content angles
/devops-to-tutorial [topic] — DevOps conversation → tutorial outline
/memory — View active memory
/remember key: value — Save persistent context
/forget key — Remove a memory entry
```

---

## Implementation order

1. **Memory first** — it's a dependency for cross-skill (cross-skill commands read memories)
   - Create migration file
   - Create `src/state/memory.ts`
   - Add `/remember`, `/forget`, `/memory` slash commands to `bot.ts`
   - Inject memory into `callDomain()` and `continueWithToolResults()` in `anthropic.ts`
   - Add one-liner to each domain system prompt
   - Add cleanup to scheduler

2. **Cross-skill second**
   - Add the 4 slash commands to `bot.ts`
   - Each command: gather context → build synthetic message → call `handleContent()`
   - Update `/help` text

3. **Build, test, deploy**
   - `npm run build`
   - Test `/remember`, `/memory`, `/forget` locally
   - Test `/content-from-work` with some conversation history
   - Deploy to ServerDominguez: `rsync → ssh: npm install && npm run build && pm2 restart`

4. **Update CHANGELOG.md** with version 1.1.0

---

## What NOT to do

- Do NOT create a new domain or DomainName for cross-skill — these commands reuse the `content` domain handler
- Do NOT add new tools to the TOOLS array — cross-skill commands don't need tool-use, they're pure conversational
- Do NOT store cross-domain context in the database — fetch it fresh from conversation history each time
- Do NOT make memory injection optional per domain — inject into ALL domains equally (it's only ~150 tokens)
- Do NOT use Haiku for cross-skill responses — they need creative quality, use Sonnet via the normal content domain handler

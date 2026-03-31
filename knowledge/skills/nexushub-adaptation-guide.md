# Nexus Hub Telegram Bot — Adaptation Guide

## What This Is

This guide maps the improvements made to Claude.ai skills (Secretary + Content Creation) into actionable changes for Nexus Hub's domain system prompts. Since Nexus Hub uses its own Grammy/TypeScript/SQLite architecture with Claude API calls, the adaptations are about porting the **concepts and prompt patterns** — not the MCP tool calls.

---

## 1. Secretary Domain → Nexus Hub Secretary Skill

### What Changed in Claude.ai
- Added structured output templates for quick commands
- Added cross-calendar awareness (Google + Outlook)
- Added Garmin integration for training-aware scheduling
- Added content-calendar bridge

### What to Port to Nexus Hub

#### A) Structured Output Templates
Add these templates to the secretary domain's system prompt in Nexus Hub. They ensure consistent, scannable responses regardless of which Claude model handles the request.

**Daily overview template:**
```
📅 [Day], [Date]
🔴 CONFLICTS/ALERTS: [issues or "None"]
📋 SCHEDULE: [time-blocked list]
🏋️ TRAINING: [status from Garmin]
📌 PENDING: [open tasks]
```

**Weekly overview template:**
```
📅 WEEK OF [range]
🔴 ALERTS: [conflicts, imbalances]
[Per-day summaries]
📊 BALANCE CHECK: Tech: Xhr | Content: Xhr | Training: X sessions
💡 SUGGESTIONS: [rebalancing ideas]
```

**Implementation**: Add these templates directly to your secretary domain's system prompt under a "## Response Formats" section. Include the instruction: "When the user asks about their day or week, ALWAYS use these structured formats."

#### B) Garmin-Aware Scheduling
Since Nexus Hub already has Garmin MCP integration and the nightly coaching briefing, extend it:

**In the secretary system prompt, add:**
```
When discussing schedule or weekly planning, reference recent Garmin data:
- If no training is logged for 2+ days, flag it
- If body battery is low or training readiness is poor, suggest lighter scheduling
- When scheduling training blocks, check what was done recently to avoid doubling up
```

**Implementation**: This works if the secretary domain can call Garmin tools, or if you pipe the nightly Garmin briefing data into the secretary context. The simplest approach: store the latest Garmin daily summary in SQLite and inject it into the secretary's system prompt context.

#### C) Content-Calendar Bridge
**Add to secretary system prompt:**
```
Content creation requires production time. When planning weeks:
- Research + scripting: 1-2 hours per video
- Filming: 1-3 hours per video
- Editing: 2-4 hours per video
If content deadlines exist but no production blocks are scheduled, flag it.
```

**Implementation**: If content deadlines are tracked in Microsoft To Do or a separate system, the secretary domain should query that data when doing weekly planning.

---

## 2. Content Creation Domain → Nexus Hub Content Skill

### What Changed in Claude.ai
- Fixed research workflow to use web_search/web_fetch instead of broken screenshot flow
- Added TikTok as third platform
- Added channel data connection
- Added scheduling bridge
- Added platform-specific strategy sections

### What to Port to Nexus Hub

#### A) Research Workflow Fix
The Nexus Hub content domain likely has the same "take screenshots" instructions that don't work. Replace with:

**In the content domain system prompt, replace any screenshot references with:**
```
When researching content topics:
1. Search for trending topics, news, and papers related to the topic
2. Fetch full article content from found URLs for details and data points
3. Compile a source brief with URLs Felipe can pull up on screen during filming
4. Do NOT reference "taking screenshots" — provide URLs and describe what to show

Source Brief format:
📌 TOPIC: [title]
📊 RESEARCH: [Source — URL — summary] (3+ sources)
🖥️ SHOW ON SCREEN: [URLs for Felipe to display during recording]
💡 KEY DATA POINTS: [stats, facts to mention]
```

**Implementation**: Direct system prompt update in the content creation domain.

#### B) TikTok Platform Addition
**Add to content domain system prompt:**
```
## TikTok Strategy
- 30-90 second vertical video, hook in first 0.5 seconds
- More casual and raw than YouTube — less polished = more authentic
- Duets/Stitches are native reaction format, ideal for commentary niche
- Trending sounds are critical — research current sounds when suggesting content
- Repurposing pipeline: YouTube long-form → TikTok clip → Instagram Reel → YouTube Short

Commands:
/tiktok idea [topic] — TikTok-native content ideas
/tiktok script [topic] — Script optimized for TikTok pacing
/duet idea [video URL] — Duet/stitch concept
/tiktok trending — Current TikTok trends in both niches
```

**Implementation**: Add to the content domain system prompt. If Nexus Hub uses a command router, register the new /tiktok commands.

#### C) Channel Analytics Connection
If Nexus Hub's Channel Learning System (v3.7.0) already extracts YouTube data, connect it to the content domain:

**Add to content domain system prompt:**
```
When making content recommendations, query channel performance data:
- Recent video performance (views, retention, CTR)
- Top-performing content topics and formats
- Upload frequency and consistency patterns
Use this data to make specific recommendations like "Your cycling content averages 2x your channel average — prioritize more cycling videos"
```

**Implementation**: The Channel Learning System stores video analysis data. Expose a query function that the content domain can call to get recent performance metrics. Inject a summary of recent channel performance into the content domain's context (similar to how the Garmin nightly briefing works).

#### D) YouTube Transcript Integration
Nexus Hub v3.7.0 added YouTube transcript extraction and deep video analysis via Claude Sonnet. Leverage this for reaction content:

**Add to content domain system prompt:**
```
For reaction content (/reaction command):
1. Extract transcript from the target video using the transcript extraction system
2. Analyze the transcript for key claims, controversial moments, and reaction-worthy timestamps
3. Provide a pre-analyzed brief:
   - Video summary from transcript
   - Key timestamps with quotes to react to
   - Suggested reaction angles with supporting/contrasting evidence
   - Counter-arguments or additional context from web research
```

**Implementation**: The transcript extraction pipeline already exists. Wire it into the /reaction command handler so it automatically fetches and analyzes the transcript before generating the reaction brief.

---

## 3. Cross-Domain Improvements

### A) Shared Context Between Secretary and Content
Currently the secretary and content domains are siloed in Nexus Hub. To enable the content-calendar bridge:

**Option 1 (Simple)**: Add a shared SQLite table `content_schedule` that both domains can read/write:
```sql
CREATE TABLE content_schedule (
  id INTEGER PRIMARY KEY,
  title TEXT,
  niche INTEGER, -- 1 or 2
  platform TEXT, -- youtube, instagram, tiktok
  status TEXT, -- idea, scripting, filming, editing, scheduled, published
  target_date DATE,
  estimated_hours REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Option 2 (Lightweight)**: Store content deadlines in Microsoft To Do (which the secretary domain already reads), tagged with a specific list or prefix.

### B) Model Selection for Content Tasks
You've already settled on Sonnet 4.6 as default with Opus for high-complexity tasks. For the content domain specifically:
- **Sonnet**: Script writing, source briefs, hashtag research, caption drafting, trend scanning
- **Opus**: Full content strategy reviews, niche analysis, growth audits, complex multi-platform campaign planning

Add this routing logic to the content domain's handler if not already present.

---

## 4. Priority Order for Nexus Hub Implementation

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| 1 | Fix research workflow (remove screenshot refs) | 10 min | High — stops broken flows |
| 2 | Add structured output templates to secretary | 15 min | High — consistent outputs |
| 3 | Wire transcript extraction into /reaction | 30 min | High — faster reaction prep |
| 4 | Add TikTok commands and strategy | 15 min | Medium — new platform coverage |
| 5 | Inject Garmin summary into secretary context | 1 hr | Medium — training-aware scheduling |
| 6 | Create content_schedule shared table | 1-2 hr | Medium — cross-domain bridge |
| 7 | Connect channel analytics to content domain | 2-3 hr | Medium — data-driven recommendations |

Items 1-4 are quick system prompt updates. Items 5-7 require code changes in the Nexus Hub bot.

---

## 5. Files Reference

The improved Claude.ai skill files are packaged alongside this guide:
- `secretary/SKILL.md` — Updated secretary skill
- `content-creation/SKILL.md` — Updated content creation skill

Use these as reference when adapting the Nexus Hub domain prompts — the structure and wording can be adapted directly.

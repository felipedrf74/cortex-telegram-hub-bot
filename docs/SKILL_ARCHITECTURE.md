# Nexus Hub — Modular Skills Architecture

## Feature Plan v1.0 · March 2026

---

## Vision

Transform Nexus Hub from a monolithic bot with hardcoded domains into a **plugin-based platform** where users install only the skills they need. The Hub Core stays lightweight — a runtime that loads, routes, and orchestrates pluggable skill packages.

**The end state:** A user starts Nexus Hub, browses a marketplace, installs "Triathlon Coach" and "Content Creator", and immediately has a personalized AI assistant. A developer creates "Stock Trader" skill, publishes it, and earns revenue when others install it.

---

## Core Concepts

### Hub Core (the runtime)

The Hub Core is what runs. It handles:

- **Message reception** — Telegram, Discord, WhatsApp (via MessageAdapter)
- **Routing** — Three-tier classification that routes to the correct skill
- **AI orchestration** — Multi-model provider (Claude, GPT, Gemini) via AIProvider
- **Database** — SQLite with skill-namespaced tables
- **Skill lifecycle** — Install, enable, disable, update, uninstall
- **Scheduler** — Cron engine that skills register jobs into
- **Intelligence Bus** — Event bus for inter-skill communication
- **User config** — Per-user skill preferences and API keys

The Hub Core ships with **zero skills**. It's a blank canvas until the user installs their first skill.

### Skill (the plugin)

A skill is a self-contained package that adds a domain of intelligence to the bot. It's the equivalent of an app on a phone.

**What a skill contains:**

| Component | Required? | Purpose |
|-----------|-----------|---------|
| manifest.json | Yes | Metadata: name, version, author, description, dependencies, sub-modules, required API keys |
| commands.ts | Yes | Pattern-match routes (/train, /gym) and keyword routes ("workout", "protein") |
| handler.ts | Yes | Main domain handler — receives messages, returns responses |
| prompts/ | No | System prompt markdown files, hot-reloadable |
| tools/ | No | Tool definitions + executors (Garmin sync, calendar lookup, etc.) |
| migrations/ | No | SQLite migrations, namespaced (e.g., tri_001_workouts.sql) |
| agents/ | No | Autonomous agents that run on cron and emit signals to the Intelligence Bus |
| config.ts | No | Required env vars, user-configurable settings, API key declarations |
| README.md | No | Documentation shown in marketplace |

### Sub-Module (the toggle)

A sub-module is a feature within a skill that can be independently enabled or disabled.

**Example: Triathlon Skill sub-modules:**

| Sub-Module | Default | What it adds |
|------------|---------|-------------|
| training-plans | Enabled | Periodized workout programming |
| garmin-sync | Disabled | Garmin Connect API integration (requires API key) |
| nutrition | Enabled | Meal tracking, macro calculation, diet adherence |
| body-composition | Disabled | Weight tracking, body fat estimation, DEXA analysis |
| race-predictor | Disabled | Race time predictions based on training data |
| coach-briefing | Disabled | Nightly Telegram coaching message |

### Marketplace (the distribution)

| Tier | Who publishes | Review process | Revenue |
|------|---------------|----------------|---------|
| Official | Nexus Hub team | Internal QA | Included in subscription |
| Community | Any developer | Automated checks + manual review | 70/30 revenue share |
| Private | Companies | No review (internal use) | N/A |

---

## Full documentation: see docs/SKILL_ARCHITECTURE.md in the repository.

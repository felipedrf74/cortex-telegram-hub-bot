# Claude Code Catch-Up Prompt

Use this prompt when opening a fresh Claude Code session so Claude and Codex
start from the same project state.

```text
Claude Code, catch up on Nexus Hub before touching code.

Workspaces:
- iOS docs/root: /Users/felipedominguez/Desktop/Nexus Hub IOS
- iOS app repo: /Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub
- Backend/content-engine repo: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot

Read in this order:
1. /Users/felipedominguez/Desktop/Nexus Hub IOS/AGENTS.md
2. /Users/felipedominguez/Desktop/Nexus Hub IOS/CLAUDE.md
3. /Users/felipedominguez/Desktop/Nexus Hub IOS/specs/00-CURRENT-PRODUCT-TRUTH.md
4. /Users/felipedominguez/Desktop/Nexus Hub IOS/specs/27-CLAUDE-CODE-HANDOVER.md
5. /Users/felipedominguez/Desktop/Nexus Hub IOS/specs/08-TOKEN-ZERO-ARCHITECTURE.md
6. /Users/felipedominguez/Desktop/Nexus Hub IOS/specs/02-API-SPECIFICATION.md
7. /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CLAUDE.md
8. /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/agents/claude/handoff.md
9. /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/beta/single-agent-status.md
10. /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/beta/training-coach-engine-hardening-handoff.md

Current truth:
- Backend production is live at 4.14.74; staging remains live at 4.14.73.
- Current deployed backend branch is main. beta/single-agent-rc is historical recovery context.
- Production deploy health passed at deploy commit 0f7fd74; Training coach engine hardening code commit is 45f3a1c.
- Full backend production gate passed: 345 test files / 5,468 tests.
- Staging smoke passed 17/17 before production promote.
- Content script generation architecture is live: per-request user-scoped creator profile/Voice DNA, no founder/operator system prompt, outcome-based guidance, explicit script temperature, topic-aware degraded fallback, forceRefresh/regenerate cache bypass, script-v7 cache key.
- Training coach engine hardening is live: no Felipe/carnivore/high-volume prompt defaults, per-active-tenant daily coach briefing, fixed ACWR load math with sample guard, conservative no-wearable readiness, sleep duration safety floor, orange/red/injury downshifts.
- Remaining gates are signed TestFlight/device proof: auth/onboarding, APNs, two-account switching, provider state, Secretary recurrence, Health, Content script/topic scheduling/pipeline, and Training actions/readiness.

How to work with Codex:
- Verify QA claims with rg, file reads, focused tests, and runtime checks before accepting or dismissing them.
- Keep fixes small, scoped, and test-backed.
- Name the files/contracts you expect to touch before editing.
- Token-zero is law: operational iOS flows use REST/local state, not fake chat commands.
- Avoid single-tenant runtime assumptions in prompts, caches, background jobs, provider fallbacks, and user-facing copy.
- For backend production changes, use: focused tests/typecheck -> staging deploy -> staging smoke -> production promote -> production health -> docs update.
- If TestFlight, APNs, OAuth, HealthKit, Gmail/Outlook, provider credentials, or device permissions are required, document the exact command/env and mark the item as manual verification required.

Task:
Choose the next scoped item from the current TestFlight/device QA backlog, or ask Felipe for priority if multiple items conflict. Before implementation, report the files/contracts you will touch. After implementation, run focused verification and update docs if rollout state or business rules changed.
```

#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let T = '';
try { T = fs.readFileSync(path.resolve(__dirname, '.env.agents'), 'utf8').match(/NOTION_TOKEN=(.+)/)?.[1]?.trim(); } catch {}
try { if (!T) T = fs.readFileSync(path.resolve(__dirname, '..', '.env.agents'), 'utf8').match(/NOTION_TOKEN=(.+)/)?.[1]?.trim(); } catch {}
if (!T) { console.error('No token'); process.exit(1); }

async function upd(id, desc) {
  const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${T}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({ properties: { Description: { rich_text: [{ text: { content: desc.substring(0, 2000) } }] } } }),
  });
  console.log(r.ok ? `✅ ${desc.substring(0, 45)}...` : `❌ ${id} ${r.status}`);
  await new Promise(r => setTimeout(r, 350));
}


const TASKS = [
['336ad49d-23e7-8152-b195-c6323cf7c957',
`BUG P0: Bot sends raw JSON tool_use blocks as text instead of executing tools.

ROOT CAUSE: When Claude responds with tool_use blocks, the response handler in domain-handler.ts or secretary.ts may not enter the while(result.toolCalls.length > 0) loop, or the loop exits prematurely.

ACCEPTANCE CRITERIA:
- Send "o que tenho na agenda hoje?" -> bot calls get_calendar_events tool and returns formatted calendar, NOT raw JSON
- Send "/todo list" -> bot calls ms_todo_get_tasks and returns formatted task list
- Send "/expense add 50 almoco" -> bot calls save_expense tool and confirms
- All 5 domains (secretary, finance, cooking, triathlon, content) execute tools correctly
- Tool loop processes ALL tool_use blocks before returning text to user
- No response to user ever contains {"name":"tool_name","input":{...}} text
- npx vitest run passes, npx tsc --noEmit passes

FILES: src/domains/domain-handler.ts (handleSimpleDomain tool loop), src/domains/secretary.ts (handleSecretary tool loop), src/services/anthropic.ts (callDomain return type), src/services/tool-executor.ts
DEPS: None — P0 bug fix`],

['336ad49d-23e7-819b-b329-f20ae15bc178',
`BUG P0: Bot generates status reports and briefings instead of answering the actual user command.

ROOT CAUSE: System prompts inject too much context (Garmin history, training summary, To Do counts) causing Claude to generate a status report summarizing the injected context rather than executing the user's actual command.

ACCEPTANCE CRITERIA:
- Send "what is 2+2?" -> bot responds "4", NOT a morning briefing
- Send "/expense add 30 cafe" -> bot logs expense and confirms, NOT a finance report
- Send "receita de frango" -> bot searches recipes, NOT summarizes training
- buildStateContext() in secretary.ts returns compact context (under 500 tokens)
- Classifier correctly identifies intent — tested with 10 ambiguous messages
- Slash commands bypass AI completely (handled by bot.ts command handlers)
- npx vitest run passes, npx tsc --noEmit passes

FILES: src/domains/secretary.ts (buildStateContext — trim verbose sections), src/services/anthropic.ts (system prompts), src/router/classifier.ts, src/bot.ts
DEPS: None — P0 bug fix`],

['336ad49d-23e7-81ba-b553-c717a818c6b7',
`BUG P1: /skill disable and /skill enable return false positive errors even when the operation succeeds.

ROOT CAUSE: enableSkill()/disableSkill() in skill-manager.ts may not seed DEFAULT_SKILLS on first boot, or the registry SQLite state is stale.

ACCEPTANCE CRITERIA:
- /skills -> lists all skills with enabled/disabled indicators
- /skill disable secretary -> disables secretary, /skills confirms disabled
- /skill enable secretary -> enables secretary, /skills confirms enabled
- After disable: messages that route to secretary return "skill disabled" message
- After enable: secretary responds normally to messages
- seedDefaultSkills() runs on startup (all core skills enabled by default)
- enabledByDefault: true in skill-config.ts for all core skills
- npx vitest run passes, npx tsc --noEmit passes

FILES: src/skills/skill-manager.ts, src/skills/registry.ts, src/skills/skill-config.ts, src/commands/skills.ts, src/index.ts
DEPS: None`],

['335ad49d-23e7-81d0-b5c2-c844efb75b98',
`SECURITY: Audit and fix SQL injection vectors, input validation gaps, and prompt injection risks.

ACCEPTANCE CRITERIA:
- All SQLite queries use parameterized statements (? placeholders), zero string concatenation
- User input from Telegram sanitized before DB insertion (escapeHtml + SQL params)
- Tool executor validates all tool input types before execution
- System prompts contain no user-controlled content injection points
- Bot.ts validates ctx.from.id exists before processing
- Rate limit: no single user can trigger more than 30 AI calls per minute
- Security audit report written to SECURITY_AUDIT.md with findings
- npx vitest run passes, npx tsc --noEmit passes

FILES: src/services/database.ts, src/services/tool-executor.ts, src/bot.ts, src/services/anthropic.ts, prompts/*.md
DEPS: None`],

['335ad49d-23e7-81f1-8de1-e768513b5fa6',
`FEAT: Finance Tracker skill — expense logging, tax helper, and financial reports.

AS A USER: I want to log expenses via Telegram and get tax calculations so I can manage my finances.

ACCEPTANCE CRITERIA:
- "/expense add 50 almoco" -> logs expense with auto-category (food), confirms with amount + category
- "/expense list" -> shows last 10 expenses with date, amount, category
- "/expense summary" -> shows monthly breakdown by category (table format)
- "/expense export" -> generates CSV sent as Telegram document
- Natural language: "gastei 30 euros no uber" -> parsed correctly (amount: 30, category: transport)
- Currency support: EUR (default) and BRL with exchange rate conversion
- DB: expenses table (id, user_id, amount, currency, category, description, date, created_at)
- Finance system prompt updated with expense tool descriptions
- Portal: expense count and total shown in KPIs
- npx vitest run passes, npx tsc --noEmit passes

FILES: src/services/finance-tracker.ts (new), src/domains/finance.ts, src/services/anthropic.ts (TOOLS), prompts/finance.md, src/portal/portal.html
DEPS: None — greenfield feature`],
];


const TASKS2 = [
['334ad49d-23e7-81ab-9155-ea95168e252d',
`QA: Build regression test suite covering core message flow and skill system.

ACCEPTANCE CRITERIA:
- Test: message -> classifier -> correct domain routing (10 test messages covering all 5 domains)
- Test: tool_use response -> tool execution -> continueWithToolResults -> final text (NOT raw JSON)
- Test: /skills command returns formatted skill list
- Test: /skill enable/disable toggles state correctly in registry
- Test: skill sub-module toggle removes tools from AI context
- Test: conversation history maintained across messages in same domain
- Test: unknown message -> classifier fallback -> secretary domain
- Test: HTML parse error in reply -> fallback to plain text
- All tests use mocked Anthropic client (no real API calls)
- All tests use mocked Grammy context (no real Telegram calls)
- Minimum 25 test cases across 3 test files
- npx vitest run passes with 0 failures

FILES: tests/regression/message-flow.test.ts, tests/regression/skill-system.test.ts, tests/regression/tool-execution.test.ts
DEPS: None`],

['336ad49d-23e7-8131-bf6c-c9759dda34b9',
`BUG P1: @Nexushub94_bot unresponsive — used for agent notifications via Mission Control.

CONTEXT: User-facing bot is @Hlepreguica_bot. @Nexushub94_bot is used by MC for agent lifecycle notifications.

ACCEPTANCE CRITERIA:
- Clarify: is @Nexushub94_bot token configured in .env.agents as TELEGRAM_BOT_TOKEN or NOTIFY_BOT_TOKEN?
- If separate bot: verify NOTIFY_BOT_TOKEN is set and valid (test with bot.api.getMe())
- MC notify() function in mission-control.js sends messages successfully
- Test: manually trigger notification -> message appears in Felipe's Telegram
- Add bot identity check on startup: log which bot is running (username + id)
- Document in README which bot tokens are needed and for what

FILES: scripts/mission-control.js (notify), .env.agents, src/config.ts, README.md
DEPS: None`],

['335ad49d-23e7-81f2-910f-de3709468810',
`INFRA: Health check endpoint for monitoring and Docker HEALTHCHECK.

ACCEPTANCE CRITERIA:
- GET /health -> returns JSON { status: "ok", uptime: seconds, version: from package.json }
- GET /health returns 200 when healthy, 503 when degraded (DB error or bot stopped)
- GET /health/detailed?token=HEALTH_TOKEN -> adds: db_status, bot_status, memory, cron_jobs, last_message
- GET /health/detailed without token -> returns 401
- HEALTH_TOKEN configured via env var
- Response time under 100ms (no expensive queries in basic /health)
- Portal: health indicator in header bar (green=ok, red=degraded)
- npx vitest run passes, npx tsc --noEmit passes

FILES: src/portal/server.ts (add routes), src/config.ts (HEALTH_TOKEN), src/portal/portal.html
DEPS: None`],

['335ad49d-23e7-8122-b225-fb23458cd754',
`FRONTEND: Redesign Mission Control dashboard for 6-agent system.

ACCEPTANCE CRITERIA:
- 3x2 grid layout showing all 6 agents (Backend, QA, DevOps, Flex, Frontend, QA2)
- Each card shows: name, status badge (Online/Offline/HasTask), current task + priority, queue count
- Pulse animation on online agents
- Action buttons per agent: Launch, Stop, Terminal, Logs, Git Log
- Board tab: task counts per status (To Do, In Progress, QA Validating, Done)
- Pipeline tab: CI/CD status from GitHub Actions
- Deploy tab: one-click deploy with confirmation modal
- Auto-refresh every 10s (fetch + DOM update, no full reload)
- Dark theme with CSS variables
- Mobile responsive (375px width)
- No external CDN — self-contained HTML/CSS/JS

FILES: scripts/mission-control.js (PAGE, PAGE2 HTML, Express routes)
DEPS: None`],

['335ad49d-23e7-814b-933c-e48ec6bb7f77',
`FRONTEND: Redesign Status Portal as monitoring dashboard.

ACCEPTANCE CRITERIA:
- KPI header: uptime %, API cost today, active skills count, error count, last message time
- Skills section: grid of skill cards with enable/disable toggles, tool count, messages today
- Integrations: OAuth status per service (Google, Outlook, Garmin) with Valid/Expired indicator
- Cron jobs: table with name, schedule, last run, result, duration
- Activity timeline: last 20 bot interactions (time, domain, action, response preview)
- Sidebar navigation: Dashboard, Skills, Integrations, Cron Jobs, Database, Settings
- Responsive at 375px mobile width
- Loading skeletons while data fetches
- Dark theme with CSS variables matching Mission Control
- Auto-refresh every 30s
- No external CDN — self-contained HTML/CSS/JS
- All data from /api/* endpoints (add new endpoints as needed)

FILES: src/portal/portal.html (full redesign), src/portal/server.ts (API endpoints)
DEPS: None`],
];

async function main() {
  const all = [...TASKS, ...TASKS2];
  console.log(`Refining ${all.length} tasks with acceptance criteria...\n`);
  for (const [id, desc] of all) {
    await upd(id, desc);
  }
  console.log(`\nDone! All ${all.length} tasks refined.`);
}
main();

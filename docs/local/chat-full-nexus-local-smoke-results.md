# Chat Full Nexus Local Smoke Results

Date: 2026-04-29
Branch: `feature/chat-tenant-safe-context-orchestration`
Mode: local-only, fixture-first, provider keys blanked

## Summary

Result: **PASS WITH DOCUMENTED LIMITATIONS**

The full local backend started successfully on `127.0.0.1:8200`, applied migrations through `085_chat_message_lifecycle.sql`, seeded the default skills, served iOS API routes, executed deterministic Chat paths, isolated chat history between local users, rendered Chat in the iOS simulator, and shut down cleanly.

No real AI provider calls were used. Model-dependent live provider quality, streaming transport, provider fallback, and operator-pinned model behavior remain open local smoke items.

## Commands Run

```bash
npm run build
npm run chat:eval
node dist/tools/chat-day-to-day-simulation.js
```

Local backend command is documented in `docs/local/chat-full-nexus-local-smoke.md`.

iOS simulator:

```bash
xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build
```

Result through XcodeBuildMCP: build and run succeeded for `Nexus Hub` on `iPhone 17 Pro`.

## Smoke Matrix

| Smoke | Expected | Actual | Result | Provider Mode | Cleanup |
| --- | --- | --- | --- | --- | --- |
| Product health | Backend starts locally with iOS API, auth, skills, scheduler, local DB. | Started on `127.0.0.1:8200`; migrations through `085`; default skills installed; scheduler started. | PASS | No provider keys | Cleaned |
| Auth/session | Local invite creates test users and JWT sessions. | Two local users created via `/api/v1/auth/register`; `/api/v1/auth/me` returned 200. | PASS | None | Cleaned DB |
| Tenant/user context | Chat requests carry user and tenant scope. | Chat logs and responses used `userId` and `tenantId`; history calls scoped by token. | PASS | None | Cleaned DB |
| Permissions | Unauthorized portal requests fail; admin diagnostics require token. | Portal observability returned 401 without token under `STAGING=true`; returned 200 with local `PORTAL_ADMIN_TOKEN`. | PASS | None | Cleaned |
| Shared/product surfaces | Dashboard, skills, calendar, reminders, Training, Finance, Content, plan routes return local responses. | Most safe GET surfaces returned 200. `GET /api/v1/cooking/meal-plan` returned 400 without required query shape in direct curl, but iOS later loaded cooking meal plan with 200. | PASS | None | Cleaned |
| Chat create/send | Send message through `/api/v1/chat/message`. | `/status`, `/day`, `create training plan`, destructive cancellation request, finance shortcut, and prompt-injection prompt all returned 200. | PASS | Deterministic/degraded | Cleaned DB |
| Chat persistence/history | Messages persist and history is retrievable. | User A history had 12 messages; User B history had 2 messages; User A clear history returned 200 and then 0 messages. | PASS | None | Cleaned DB |
| Retry/idempotency | Same client ID returns existing result; different text with same ID conflicts. | Same ID replay returned `metadata.idempotentReplay=true`; conflicting text returned `409 CHAT_IDEMPOTENCY_CONFLICT`. | PASS | None | Cleaned DB |
| Destructive confirmation | Destructive requests require explicit confirmation. | `cancel my training plan and clear the calendar` returned `routeMethod=confirmation-required`, `metadata.type=chat_action_confirmation_required`. | PASS | None | Cleaned DB |
| Chat + Secretary | Secretary status/day route through Chat. | `/status` and `/day` returned `domain=secretary`, `routeMethod=fast-path`. | PASS | Token-zero | Cleaned DB |
| Chat + Training | Training plan request routes safely without creating a plan via Chat. | `create training plan` returned `domain=triathlon`, `routeMethod=plan-shortcut`, directing user to Training tab. | PASS | Token-zero | Cleaned DB |
| Chat + Finance | Finance shortcut reads local finance state safely. | `what bills are still missing this month?` returned `domain=finance`, `routeMethod=finance-state-shortcut`, with no provider call. | PASS | Deterministic shortcut | Cleaned DB |
| Chat + Cooking | Full natural-language Cooking orchestration needs provider-backed routing or a deterministic shortcut. | Cooking REST surface loaded in iOS with 200; Chat+Cooking was covered by fixture day-to-day harness, not a live provider call. | PARTIAL | Fixture | Cleaned |
| Chat + Content Creation | Content REST surfaces available; content chat is fixture-covered. | `/api/v1/content/home`, `/content/intelligence`, `/content/intelligence/detail`, and `/content/pipeline` returned 200 in iOS/backend logs. Live natural-language content chat with providers blanked was not exercised. | PARTIAL | Fixture/REST | Cleaned |
| Day-to-day interaction | Multi-turn realistic scenarios pass rubric. | `node dist/tools/chat-day-to-day-simulation.js`: PASS, 10 scenarios, average 1.93 / 2.00. | PASS | Fixture | No resources |
| Evaluation/red-team harness | Broader eval passes with classified partials. | `npm run chat:eval`: PASS, 24 scenarios, average 1.99 / 2.00, 21 pass, 3 partial, 0 fail. | PASS | Fixture | No resources |
| Tenant/security smoke | User cannot see another user's chat history. | User A and User B histories remained separate; no User A destructive prompt appeared in User B history. | PASS | None | Cleaned DB |
| Prompt-injection smoke | Cross-tenant attempt does not disclose data. | Live no-provider prompt-injection prompt returned degraded provider-unavailable message; fixture red-team scenarios passed refusals. | PASS | Fixture/degraded | Cleaned DB |
| Model-routing smoke | Routing config and provider metadata observable without prompt leakage. | `/api/domain-routing`, `/api/model-config`, `/api/provider-health`, `/api/provider-stats`, `/api/chat/diagnostics` returned 200 with admin token. Chat diagnostics did not expose raw prompt text in sampled output. | PASS | No providers configured | Cleaned |
| iOS local smoke | iOS points to local backend, renders Chat, degraded/provider state, and shortcut response. | iOS build/run succeeded; debug local auth import worked; Chat screen loaded; provider-unavailable response rendered; `Today` shortcut callback returned 200. | PASS | Local backend, no providers | App/sim stopped |
| Resource cleanup | No backend, simulator, token, DB, or provider loop remains. | Port 8200 empty; no booted simulators; no matching smoke processes; local auth JSON and smoke DB removed. | PASS | N/A | Clean |

## Detailed Evidence

Deterministic evaluation:

- `npm run chat:eval`
- Overall: PASS
- Scenario count: 24
- Average: 1.99 / 2.00
- Status counts: pass=21, partial=3, fail=0, blocked=0
- Partials: streaming interruption, provider fallback, operator-pinned model because they require live local transport or bounded real providers.

Day-to-day simulation:

- `node dist/tools/chat-day-to-day-simulation.js`
- Overall: PASS
- Scenario count: 10
- Average: 1.93 / 2.00
- Covered morning planning, Training + Cooking, Content, Finance, tenant switch, vague follow-ups, user correction, tool failure, prompt injection, and longitudinal memory.

Local REST and Chat:

- local users: `4`, `5`, `6`
- `POST /api/v1/chat/message` safe paths:
  - `/status`: `secretary`, `fast-path`
  - `/day`: `secretary`, `fast-path`
  - `create training plan`: `triathlon`, `plan-shortcut`
  - `cancel my training plan and clear the calendar`: `secretary`, `confirmation-required`
  - `what bills are still missing this month?`: `finance`, `finance-state-shortcut`
  - prompt-injection attempt: `secretary`, degraded provider-unavailable response, no data disclosure
- retry: idempotent replay returned existing message
- conflict: same client ID with different text returned `409 CHAT_IDEMPOTENCY_CONFLICT`

iOS:

- `Nexus Hub` build/run succeeded.
- DEBUG token import launched against `http://127.0.0.1:8200`.
- Home loaded authenticated local data after the token import completed.
- Chat screen rendered input, skill/assistant header, degraded provider-unavailable message, action buttons, and a `Today` shortcut callback.
- Backend logs showed 200s for dashboard, calendar, billing, skills, notifications, tasks, plan, cooking, content, finance, chat history, chat message, and chat callback for local `userId=6`.

## Issues Found

| Issue | Severity | Status | Notes |
| --- | --- | --- | --- |
| Full local runner command remains manual rather than a single first-class script. | P2 | Open | Existing local-engine work documents this pattern; Chat smoke used explicit env command. |
| Real provider fallback/operator-pinned model behavior was not run. | P1 for provider-quality claims | Open | Provider keys were intentionally blanked to avoid accidental spend. |
| Streaming/reconnect smoke was not run. | P1 for streaming release claims | Open | WebSocket/iOS streaming is explicitly not enabled in this local smoke. |
| Chat + Cooking and Chat + Content live natural-language orchestration need provider-backed or deterministic local shortcut coverage. | P2 | Open | REST surfaces and fixture simulations passed; no real provider calls were made. |
| Initial iOS launch emitted 401s before the debug auth import finished; subsequent authenticated calls returned 200. | P2 | Open/Observed | This appears to be launch timing/cache behavior rather than a data leak. It should be tracked for cleaner local smoke ergonomics. |

## Final Result

Local Chat smoke is acceptable as a fixture-first full-product validation pass. It proves auth, tenant-scoped history, Chat persistence, deterministic routing, destructive confirmation, skill REST availability, local iOS rendering, and cleanup.

It does not prove live model quality, provider fallback, operator-pinned models, or streaming transport. Those remain separate gates.


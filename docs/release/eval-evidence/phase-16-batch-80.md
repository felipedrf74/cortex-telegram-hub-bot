# Phase 16 batch 80 — pre-flight bug burn (4.14.166)

Date: 2026-05-16 / 17 (UTC overnight)
Branch: feat/phase-16-chat-presentation
Worktree: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-phase16
Production baseline: 4.14.165 (live, uptime 3h+ at start of batch)
Target: 4.14.166

## Scope (per approved Phase 16 plan)

Three orthogonal bug fixes that ship together as 4.14.166:

1. **Spanish locale collapse** — Telegram + HTTP Accept-Language `es-*` now preserve `'es-ES'` instead of collapsing to `'pt-BR'`. The earlier collapse silently disabled every `input.locale?.startsWith('es')` branch added to the chat planner in Phases 10-15 for Telegram traffic.

2. **Auth bypass in action executor** — `executeChatActionPlan` now wraps its body in `runWithChatToolAuthorization`. Before this fix the action planner reached destructive providers (`createEvent`, `updateEvent`, `deleteEvent`, mail send) without the AsyncLocalStorage auth context that `authorizeChatToolCall` requires.

3. **Refusal vs clarification distinction** — safety-refused plans (built by `buildSafetyRefusalPlan` with `step.args.rejectionReason` populated) now emit `metadata.actionStatus: 'refused'`, `metadata.type: 'chat_action_refused'`, and a `metadata.refusal: { reason, message }` block with locale-aware copy (en-US, pt-BR, es-ES). The persisted run status is `'blocked'` (valid `ChatActionRunStatus`); the iOS-facing `metadata.actionStatus` is the new discriminator.

iOS worktree is deferred to Batch 87 (broader iOS work). Batch 80 is backend-only; iOS will keep rendering the existing clarification card until it learns about `metadata.type === 'chat_action_refused'`. Forward-compatible.

## Source diff

- [src/utils/i18n.ts:14](src/utils/i18n.ts:14) — added `'es-ES'` to the `Lang` union; added `'es-ES'?: string` to `MessageEntry`; fixed `detectLanguageFromTelegram` to use `normalized.startsWith('en')` (was reading raw `langCode` — bug fix that arrived with the ES branch); flipped line 311 to return `'es-ES'`.
- [src/services/secretary-fastpath.ts:1064](src/services/secretary-fastpath.ts:1064) — added the `es-ES` branch to `normalizeLangHeader`. Changed `COPY: Record<Lang, Copy>` to `Partial<Record<Lang, Copy>>` and added the `?? COPY['en-US']` fallback in `copyForLang` so ES users see English fast-path copy until Spanish strings are translated (Phase 16 follow-up).
- [src/api/routes/settings.ts:18](src/api/routes/settings.ts:18) — settings endpoint still rejects non-pt/non-en input (Spanish not yet selectable as a saved preference); explicit cast to `'pt-BR' | 'pt-PT' | 'en-US' | null`.
- [src/services/chat-action-planner.ts:60-62](src/services/chat-action-planner.ts:60) — import `getCurrentChatToolAuthorizationContext` + `runWithChatToolAuthorization`.
- [src/services/chat-action-planner.ts:2398-2412](src/services/chat-action-planner.ts:2398) — `executeChatActionPlan` body now self-wraps in `runWithChatToolAuthorization` when no outer context is present; re-entrant calls (already inside an auth context) fall through unchanged.
- [src/services/chat-action-planner.ts:2413-2432](src/services/chat-action-planner.ts:2413) — added refusal-vs-clarification branching at the executor's early-return path. Refused plans get `'blocked'` persisted status and `metadata.type: 'chat_action_refused'`.
- [src/services/chat-action-planner.ts:4398-4438](src/services/chat-action-planner.ts:4398) — added `refusalReasonForPlan` and `refusalCopyForReason` helpers. Refusal copy is locale-aware for en-US, pt-BR/pt-PT, es-ES, with three branches per locale (`prompt_injection_marker_detected`, `sensitive_data_exfiltration_detected`, `bulk_destructive_request_detected`).
- [src/services/chat-action-planner.ts:4082-4090](src/services/chat-action-planner.ts:4082) — `buildActionResponse` now honors caller-provided `metadata.actionStatus` (so a refused plan's `'refused'` discriminator survives), falling back to the persisted status otherwise.

## Tests added (3 files / 18 tests)

- [__tests__/services/chat-locale-detection-es.test.ts](__tests__/services/chat-locale-detection-es.test.ts) — 7 tests pinning `detectLanguageFromTelegram` and `normalizeLangHeader` ES preservation, no regression for pt-BR / pt-PT / en-US, fallback for unknown codes, multi-value Accept-Language headers.
- [__tests__/services/chat-tool-authorization-action-planner.test.ts](__tests__/services/chat-tool-authorization-action-planner.test.ts) — 4 tests asserting `runWithChatToolAuthorization` AsyncLocalStorage scoping: context established for callbacks, cleared on return, nested-replace behavior, `explicit_current_turn + confirmedDestructiveAction:true` shape matches the executor wrap.
- [__tests__/services/chat-refusal-vs-clarification.test.ts](__tests__/services/chat-refusal-vs-clarification.test.ts) — 7 tests asserting end-to-end refusal response shape: `metadata.type === 'chat_action_refused'`, `metadata.actionStatus === 'refused'`, locale-aware copy (en/pt/es), distinct copy per refusal reason, clarification path unchanged for non-refused plans.

All 18 tests pass in the worktree.

## Verification suite (run in worktree)

- `npm run typecheck`: pass (after fixing two cascading type errors from `Lang` expansion: settings.ts return type, secretary-fastpath COPY map → Partial)
- `npm run verify` (vitest): **600 test files / 8942 tests pass** (floor was 597/8924; Phase 16 batch 80 added 3 files / 18 tests, no regressions)
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: all gates pass
- `node scripts/vi-mock-completeness-lint.mjs --strict`: exit 0
- `npm run docs:audit`: 550 issues (pre-existing baseline; worktree count is LOWER than main repo's 621, confirming Batch 80 added no new doc-audit findings)

## Deferred items

- **iOS-side refusal card rendering**: iOS `MessageMetadata.actionStatus` decoder + `StructuredCardView` refusal sub-card lands with Batch 87 (broader iOS work). Until then the iOS app continues to use the clarification rendering path for refused plans; users see the new locale-aware refusal copy but not a distinct visual treatment. Forward-compatible.
- **Spanish translation of secretary fast-path copy**: ES users see English fast-path copy until full translation. Listed as a Phase 16 follow-up (separate from Batch 80's scope).

## Deploy gate

- Staging deploy → smoke 17/17 → promote to production → `/health` returns 4.14.166.
- Production was already on 4.14.165 at session start (Codex deployed 4.14.165 ahead of this session; the prior session's docs claimed prod was on 4.14.164 but the deploy script reported the actual prod state was 4.14.165 — docs stale).

## Risks closed

- Spanish-speaking Telegram users get the right planner branches (Phases 10-15 work was a no-op for them until now).
- Action-planner destructive paths now have AsyncLocalStorage auth context; `authorizeChatToolCall` will no longer return `AUTH_REQUIRED` for legitimate action-planner calls.
- "I won't do that" refusals visually distinguish from "I need more info" clarifications via `metadata.type` — iOS card layer can render appropriately when Batch 87 ships.

## Open follow-ups

- Phase 16 Batch 81 (Tier-0 validation parity)
- Phase 16 Batch 82 (executionPolicy enforcement)
- Phase 16 Batches 83-86 (block + card schema)
- Phase 16 Batches 87-88 (iOS decoder + hardening)
- Phase 16 Batches 89-90 (normalize-once + close-out)

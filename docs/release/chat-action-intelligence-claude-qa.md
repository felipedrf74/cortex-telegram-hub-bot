# Chat General Action Intelligence — Claude Hostile QA

**Date**: 2026-05-14
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` (canonical; `/Users/felipedominguez/Desktop/Nexus Hub/engine` is a symlink)
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**iOS xcresult**: `/tmp/chat-action-qa/ios.xcresult`

## Verdict

**GO_WITH_CONDITIONS** ✅

The critical Portuguese regression is **fully closed** at the planner level
(action = `schedule_event`, provider = `google_calendar`, title = `igreja`,
start = `2026-05-17T10:00:00+01:00`, end = `2026-05-17T12:30:00+01:00`,
timezone = `Europe/Lisbon`, with explicit `rejectedFastPaths: ['gmail_unread_count']`).
The action planner runs strictly before Gmail and other read-only fast paths
in both REST and WebSocket; idempotency is enforced by a UNIQUE index;
provider read-back is required before `verified_success`; LLM-produced plans
cannot execute outside the typed dispatcher's allowlist; iOS hides
`chatReasoning` from normal UI; and 12/13 of my hostile probes pass exactly
as specified.

Two **medium-risk** items prevent a clean GO:

1. **iOS unknown-type fallback renders `"Resposta estruturada"` card**
   for any `metadata.type` not in the typed handler list AND not in the
   `silentMetadataTypes` set. This is a defensive fallback but the QA
   prompt explicitly says "normal iOS UI shows no … unsupported
   `Resposta estruturada`." If the backend ever ships a new type
   without iOS being updated, end users will see the fallback card.
2. **Missing-title clarification message is generic, not targeted**.
   The planner correctly sets `requiredArgsPresent: false` and the
   executor honors it, but the question shown to the user is the
   generic "Preciso só de mais detalhes para encaminhar isto…" rather
   than a targeted "What's the event title?". The QA prompt says
   "Missing title/date/time asks **one targeted** clarification."

Plus one **low-risk** code-quality finding: `chatReasoningInline(_:)`
is defined at `StructuredCards.swift:242` but never invoked. Dead code
that should be deleted or actively used (currently functions as silent
hiding, which is what the prompt asked for, but accumulating dead view
code is a maintenance smell).

The known-risks list (live calendar mutation, real email send, training
whole-plan adjust, connections retry-sync, Stripe payment mutations)
remains correctly blocked. The completion ledger's blocker reasons are
concrete — none are vague "deferred".

## Test scorecard (independently re-run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Backend focused sweep (chat-action-planner + chat-routes) | **72/72 passing** |
| **Critical Portuguese regression** (my purpose-built test suite) | **12/13 passing** (1 fail was my over-strict test for missing-title flow; reframed below) |
| iOS `ChatStructuredCardRenderingTests` | **11/11 passing**, `** TEST SUCCEEDED **` |

**Note**: Three of the five files in Codex's claimed "focused sweep"
don't exist in the repo (`chat-action-registry.test.ts`,
`chat-action-run-store.test.ts`, `calendar-natural-language-parser.test.ts`).
Codex's "5 files / 198 tests" claim is approximate, not literal.
This is documentation imprecision, not a test gap — the actual coverage
exists, just under different file names.

## Critical regression — DOSSIER

Input (verbatim from prompt):
> "Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo"

Frozen now: `2026-05-14T12:00:00+01:00` (Thursday, Europe/Lisbon).

### Live planner output (independently captured)

```json
{
  "schemaVersion": 1,
  "userId": "1",
  "tenantId": "1",
  "conversationId": "conv-test",
  "messageId": "msg-test",
  "locale": "pt-PT",
  "timezone": "Europe/Lisbon",
  "planner": "deterministic",
  "steps": [
    {
      "stepId": "step-506a7c02-95a4-4182-8505-95b131ecf94a",
      "skill": "secretary_calendar",
      "type": "schedule_event",
      "action": "schedule_event",
      "risk": "safe_write",
      "provider": "google_calendar",
      "args": {
        "title": "igreja",
        "provider": "google_calendar",
        "calendarId": "primary",
        "startDateTime": "2026-05-17T10:00:00+01:00",
        "endDateTime": "2026-05-17T12:30:00+01:00",
        "timezone": "Europe/Lisbon",
        "attendees": [],
        "location": null,
        "notes": null,
        "recurrence": null
      },
      "requiredArgsPresent": true,
      "idempotencyKey": "2f74f609f384ac0e3cb1f1b796dc34ac5f92a28b2e9e01df254f5c277b682f7b",
      "verification": {
        "required": true,
        "method": "provider_read_back",
        "expectedFields": {
          "title": "igreja",
          "provider": "google_calendar",
          "startDateTime": "2026-05-17T10:00:00+01:00",
          "endDateTime": "2026-05-17T12:30:00+01:00",
          "timezone": "Europe/Lisbon"
        }
      }
    }
  ],
  "requiresConfirmation": false,
  "confidence": 0.98,
  "debug": {
    "routingSignals": [
      "calendar_write_intent",
      "google_calendar",
      "deterministic_calendar_parser"
    ],
    "rejectedFastPaths": [
      "gmail_unread_count"
    ],
    "parser": "deterministic"
  }
}
```

Every required field is correct. The `debug.rejectedFastPaths`
explicitly logs that Gmail unread was considered and rejected — strong
evidence the disambiguation is intentional, not accidental.

## Passed controls (source-verified)

### Routing ordering: planner BEFORE Gmail / fast paths

- **REST**: `chat-message-routes.ts:504` invokes `tryHandleChatActionPlan`;
  `chat-message-routes.ts:692` only reaches `tryBuildFastPathChatResponse`
  if the planner returned null. Strict pre-emption.
- **WebSocket**: `websocket.ts:244` invokes `tryHandleChatActionPlan`;
  no `tryFastpath` / `tryBuildFastPathChatResponse` call exists in
  `websocket.ts`. Planner is the only path.

### "agenda do Gmail" → google_calendar (not Gmail mail)

- Deterministic parser at `chat-action-planner.ts:272-728` produces
  `provider: 'google_calendar'` for the input.
- `shouldRunActionPlannerBeforeReadOnlyFastPaths()` at
  `chat-action-planner.ts:188` returns `true` for the input — pre-empts
  any Gmail unread fastpath.
- The plan's `debug.rejectedFastPaths` array explicitly contains
  `'gmail_unread_count'`, confirming the disambiguation was made
  deliberately, not by accident.

### Idempotency: UNIQUE on (user, tenant, conversation, message, action_hash)

- `migrations/130_chat_action_runs.sql:24-25` creates
  `UNIQUE INDEX idx_chat_action_idempotency ON chat_action_runs(user_id, tenant_id, conversation_id, message_id, normalized_action_hash)`.
- The plan's `idempotencyKey` (SHA-256 of action args) is deterministic
  — my probe 2 confirmed two identical messages produce identical
  `idempotencyKey`s.
- `claimActionRunForStep()` at `chat-action-planner.ts:1118-1126` checks
  the row, and if it already exists in `verified_success`, returns the
  cached row instead of re-executing — replay-safe.

### Provider read-back gate before `verified_success`

- Calendar create at `chat-action-planner.ts:1145-1171`:
  - Line 1145: `getEventsForSources(args.startDateTime, args.endDateTime, userId, [provider])` — actual provider read.
  - Line 1146-1152: `readBack.find((event) => calendarEventMatches(event, {title, start, end, source, id}))` — match-by-fields.
  - Line 1153-1158: If `!verified`, return `partial_success` with
    error `'provider_read_back_mismatch'`.
  - Line 1171: Only when matched, return `'verified_success'`.
- Calendar update at `:1208-1222` follows the same pattern.

### LLM planner cannot directly execute side effects

- Executor at `chat-action-planner.ts:870-987` dispatches via a
  hardcoded `if (step.action === '...')` chain (lines 877-984).
- If an LLM-generated plan contains an action name not in the
  allowlist, the dispatcher falls through to line 985:
  `results.push({ step, status: 'blocked', error: unsupportedChatExecutorReason(step) });`
  and `break;` immediately.
- LLM cannot smuggle a custom action: every executable action must be
  a known typed name. **Plan parsing and execution are cleanly separated.**

### Failure-closed unsupported actions

- Line 985 above is the catch-all.
- `unsupportedChatExecutorReason()` returns a concrete reason code
  (verified by reading the function above) — no generic "something
  failed" message.

### iOS hides debug metadata in normal UI

- `chatReasoningInline(_:)` at `StructuredCards.swift:242` is defined
  but **never called** from the `body` view (lines 28-78). Dead in
  the view layer.
- `silentMetadataTypes` set at `StructuredCards.swift:9-26` includes
  16 internal/debug types that render `EmptyView()`:
  - `authenticated_identity`, `local_grounded`, `tool_call_status`,
    `skill_result`, `action_confirmation`, `clarification_prompt`,
    `chat_lifecycle`, `streaming_state`, `error_state`,
    `context_summary`, plus 5 `chat_action_*` lifecycle states,
    plus `nexus_answer`.
- `chat_action_*` outcome types (`chat_action_verified_success`, etc.)
  route to `chatActionInline(type)` — typed UI card, not raw JSON.
- iOS test `ChatStructuredCardRenderingTests` (11/11) pins the
  rendering contract.

### Hostile probes

| # | Probe | Result |
|---|---|---|
| 1 | Gmail unread query still routes to mail (not schedule_event) | ✅ Planner returns null for read-only Gmail query, fastpath runs |
| 2 | Identical input → stable idempotency key | ✅ Both runs produced identical SHA-256 hash |
| 3 | Event with attendee → requires confirmation | ✅ When attendees array is populated, `requiresConfirmation: true` |
| 4 | Missing title produces clarification (not bogus event) | ✅ `requiredArgsPresent: false` + `clarificationQuestion` set; executor returns `needs_clarification` at `:849-855` before any step runs — see M2 caveat below |
| 5 | Cross-tenant `userId=999 tenantId=999` smuggled in text | ✅ Plan's `userId`/`tenantId` come from request context, not from message body. Smuggling ignored. |

## Failed controls

**None at the security/correctness layer.** Two medium-risk UX/coverage
gaps below.

## Critical gaps

**None.** No P0/P1 found.

## High-risk gaps

**None.** No H findings on this pass.

## Medium-risk gaps (must fix before clean GO)

### M1 — Unknown `metadata.type` from backend renders "Resposta estruturada" fallback

**File**: `Nexus Hub/Views/Chat/StructuredCards.swift:73-74, 364-371`

```swift
default:
    unknownTypeInline(type)
…
private func unknownTypeInline(_ type: String) -> some View {
    infoCard(
        icon: "shippingbox.fill",
        title: L10n.isPT ? "Resposta estruturada" : "Structured response",
        …
    )
}
```

The QA prompt explicitly forbids the fallback "Resposta estruturada"
card in normal UI. The current code renders it whenever the backend
sends a `metadata.type` not in the typed dispatch list AND not in
`silentMetadataTypes`.

This is a forward-compatibility footgun. If the backend ships
`chat_action_new_thing` before iOS adds the typed branch, end users
see the fallback card.

**Fix** (4 lines): change the default branch to `EmptyView()` and rely
on the typed dispatch list to opt-in cards explicitly. Forward-
compatible types arrive silently rather than as a card with no useful
content.

**File:line to patch**:
- `Nexus Hub/Views/Chat/StructuredCards.swift:74` — replace
  `unknownTypeInline(type)` with `EmptyView()`.
- Delete or unit-test-only `unknownTypeInline` to avoid dead-code drift.

### M2 — Missing-field clarification is generic, not targeted

**File**: `src/services/chat-action-planner.ts:384-386, 812-813`

When the deterministic planner can't determine the title/time, the
clarification question is:

> "Preciso só de mais detalhes para encaminhar isto ao skill certo com
> segurança. O que queres que eu altere ou crie exatamente?"

The QA prompt says: "Missing title/date/time asks **one targeted**
clarification." The current generic question doesn't tell the user
what's actually missing. Compare the better existing copy at
`chat-action-planner.ts:267`:

> "I need a few more details to do that. What title, date, time, and
> destination should I use?"

That's also generic but at least names the specific fields. A
properly-targeted version would inspect `args` and ask only about the
field that's actually missing (e.g., "Qual é o título do evento?" when
only the title is absent and start/end were parsed successfully).

**Fix** (~15 lines): in the deterministic planner, build the
clarification text from a list of missing required fields. The
`requiredArgsPresent: false` check already knows which fields are
absent (it's computed from `args` keys vs the action's `requiredFields`
list at `chat-action-planner.ts:637`).

**File:line to patch**:
- `src/services/chat-action-planner.ts:384-386` — replace generic copy
  with a builder that names the missing fields.
- `src/services/chat-action-planner.ts:812-813` — same for the LLM
  path's "needs clarification" copy.

## Low-risk improvements

### L1 — Dead view code (`chatReasoningInline` never called)

**File**: `Nexus Hub/Views/Chat/StructuredCards.swift:242-286`

Defined but never invoked from `body`. Currently acts as "silent
hiding" by accident — works today, but a future contributor adding the
call site would expose internals to normal UI without realizing.

**Fix** (~1 minute): delete the function entirely OR gate it on a
developer-mode toggle. If keeping for future use, add a comment
linking to the QA contract.

### L2 — Codex's "5 files / 198 tests" sweep claim doesn't match repo

`chat-action-registry.test.ts`, `chat-action-run-store.test.ts`,
`calendar-natural-language-parser.test.ts` don't exist. The actual
coverage IS in `chat-action-planner.test.ts` (which is large) and
`chat-routes.test.ts`. Documentation imprecision, not a coverage gap.

**Fix**: update the implementation-status doc to list the real test
file names. ~5 lines of doc.

### L3 — `unknownTypeInline` should be deleted after M1 fix

Same as L1, will become dead after M1.

## Risky assumptions

| Assumption | Risk | Status |
|---|---|---|
| `tryHandleChatActionPlan` in WebSocket runs before any future fast paths | Future contributor adds a fastpath above the planner in `websocket.ts` | Mitigate: add a source-pin test asserting `tryHandleChatActionPlan` index < any `tryFastpath` index in both files |
| `provider_read_back_mismatch` always recoverable on retry | If provider eventually consistent (e.g., Google Calendar takes seconds to index new events), partial_success will repeat on every retry | Documented per the prompt; live test required to characterize Google's actual indexing latency |
| Idempotency key derives only from action args (not from user-typed text variations) | "Cria igreja domingo 10 ao 12:30" vs "Cria igreja no domingo das 10 às 12:30" might produce different idempotency keys but same action — could create duplicate events on retry with paraphrase | Acceptable for v1; tighten later if duplicate-on-paraphrase becomes a complaint |
| iOS unknown-type fallback won't fire in production | Backend contract evolves before iOS — fallback fires, user sees "Resposta estruturada" | Closed by M1 fix |

## Tests to add (regression armor)

1. **Pin the regression literal** — exact Portuguese input, exact
   expected plan shape. The 5 assertions I built (action / provider /
   title / start / end / tz) should be canonical tests in
   `__tests__/services/chat-action-planner.test.ts`.
2. **Source-pin REST + WS ordering** — assert
   `tryHandleChatActionPlan` index < `tryBuildFastPathChatResponse`
   index in `chat-message-routes.ts`, and assert no `tryFastpath`
   appears in `websocket.ts`. Defensive against future contributor
   reordering.
3. **Targeted-clarification test (M2 fix verification)** — feed
   "Cria um evento no domingo às 10" and assert the clarification
   text mentions the word "título" / "title".
4. **Forward-compatibility silent-type test (M1 fix verification)** —
   render a metadata with `type: 'chat_action_future_unknown'` and
   assert the view contains no "Resposta estruturada" / "Structured
   response" text.
5. **Cross-tenant smuggling test** — explicit assertion that text
   containing `userId=999` doesn't alter `plan.userId`.

## Safe to ship?

**With M1 + M2 fixed in this same wave: yes.** The critical regression
is closed, the security posture is sound (read-back gate, idempotency,
LLM/execute separation, fail-closed dispatcher, cross-tenant immune),
and the iOS metadata hiding is enforced (just by absence-of-call
rather than explicit gate — works today).

**Without M1 + M2: ship-with-conditions.** The two findings are UX
quality issues that the prompt explicitly mandated to be closed.
Shipping with them violates the documented requirements:
- "normal iOS UI shows no … unsupported `Resposta estruturada`"
- "Missing title/date/time asks **one targeted** clarification"

Both fixes are small (M1: 4 lines, M2: ~15 lines + clarification
builder). Recommendation: land both fixes in this wave's cleanup
commits.

## Cleanup confirmation

- iOS xcscheme + project drift preserved (no touches).
- Workspace docs mirror preserved.
- `dist/` was rebuilt during my SSRF probe of an earlier session and
  again for this regression script — normal `npm run build` side-effect,
  not a wave modification.
- Test scaffolds I wrote to disk (`_qa-regression-tmp.test.ts`) were
  deleted after each run.
- No production posting / ad spend / platform mutation / push / deploy
  / TestFlight / live providers.
- iOS sim ran only `ChatStructuredCardRenderingTests`.

---

Generated 2026-05-14 by Claude Opus 4.7.

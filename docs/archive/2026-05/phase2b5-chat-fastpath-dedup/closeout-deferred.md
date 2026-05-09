# Phase 2B.5 Chat Fastpath Dedup Closeout Deferred

Status: **DEFERRED_WITH_REASON**
Date: 2026-05-10
Branch: `phase2b5-chat-fastpath-dedup-2026-05`
Branch tip: `b8092bc4276d795cdd745fd6cfb2173e60d7ae3d`
Backup tag: `backup/phase2b5-before-20260509-1909`

No Phase 2B.5 source commit landed. The branch is intentionally preserved at
the reconciled production baseline so the diagnosis remains easy to find.

## Diagnosis

The source-side probe corrected the audit shape before any refactor landed:

| Probe | Result |
| --- | --- |
| Files mentioning `fastpath` under `src/services` and `src/api` | 14 |
| Actual runtime fastpath adapter / call sites | 4 |
| Heavy duplicated implementation files | `src/api/routes/chat-fastpath.ts` at 569 LoC; `src/services/secretary-fastpath.ts` at 912 LoC |
| Shared mechanics found | command cache keys, pending-task cache TTL, in-flight dedup / coalescing |

Runtime adapter / call-site evidence:

- `src/api/routes/chat-message-routes.ts:237,302,308,546` checks and writes
  deterministic command cache entries around iOS chat messages.
- `src/api/routes/chat-message-local-responses.ts:80,91,103,109` owns the
  iOS chat command response cache helpers and calls
  `tryDeterministicChatCommand`.
- `src/api/routes/chat-callback-routes.ts:75` reuses
  `tryDeterministicChatCommand` for `cmd:` callback commands.
- `src/domains/secretary.ts:433` calls `tryFastpath` for the Telegram /
  secretary domain path.

The two large implementation files are not identical adapters. They overlap in
task/calendar/status intent coverage and cache mechanics, but they also encode
different transport semantics:

- iOS slash-command fastpath returns native chat envelopes and inline button
  metadata.
- Telegram secretary fastpath returns Telegram-HTML domain responses from a
  natural-language pattern dictionary.

This repeats the Phase 2B.3 lesson: the original audit's "16+" estimate became
6 source-truth route sites during implementation. Here, the broad fastpath grep
found 14 mentions, but the executable architecture surface was 4 adapter /
call sites with 2 heavy implementation files.

## Prototype Attempt And Result

A small `chat-fastpath-dedup` primitive was prototyped and then reverted before
commit. The shape was:

- Central cache-key builders for `chat-cmd:<tenant>:<user>:<text>` and
  `u:<user>:fastpath:pending-tasks`.
- A generic `resolveChatFastpathCached(...)` helper that checked the existing
  cache store, loaded on misses, wrote with the existing TTL, and shared
  concurrent calls through an in-flight map.
- A service-result helper that preserved the legacy behavior of storing raw
  pending-task arrays while returning `{ success, data }` envelopes to callers.
- Migrations of the iOS deterministic command response cache and pending-task
  reads in both `chat-fastpath.ts` and `secretary-fastpath.ts`.

Focused validation on the prototype passed:

- `__tests__/services/chat-fastpath-dedup.test.ts`
- `__tests__/api/chat-fastpath.test.ts`
- `__tests__/services/secretary-fastpath.test.ts`
- `__tests__/api/chat-message-local-responses.test.ts`

Result: **4 files / 131 tests passed**.

The honest source delta excluding tests was still positive:

- Added primitive: about +169 source LoC.
- Removed / simplified call-site mechanics: about -59 source LoC.
- Net source delta: **+152 LoC**.

Because the prompt required a net-negative architecture consolidation and
explicitly said to stop if the LoC delta was positive, the prototype was
reverted without committing.

## Why Deferred

The smaller dedup primitive does not pass the deletion / LoC bar. It is useful
mechanically, especially for single-flight protection, but deleting it would not
force enough complexity back into enough call sites to justify a Phase 2B
architecture round before Wave 1.

A wider merge of the iOS slash-command fastpath dictionary and the Telegram
secretary fastpath dictionary would likely pass the deletion test. It would
also change a user-visible chat surface: command wording, Telegram HTML, native
iOS chat rendering, loading behavior, fallback behavior, inline buttons, and
possibly callback flows. That makes it a visual-class round under the visual QA
protocol, with a chat-state matrix across at least two locales.

Wave 1 launch is the active priority. A speculative architecture pass over
user-visible chat behavior is the wrong tradeoff in the launch window.
Deferring this to Phase 3 keeps the evidence without spending more risk budget
now.

## Re-open Trigger

Re-open this item when one of these concrete signals appears:

- Beta usage shows observable fastpath bugs caused by duplicated cache /
  coalescing mechanics, such as repeated expensive task fetches, stale command
  cache responses, or concurrent duplicate command execution.
- A third real fastpath implementation site appears, making the deletion test
  stronger than today's 2-heavy-file shape.
- A planned feature requires one unified command / natural-language fastpath
  surface across iOS, Telegram, and WebSocket.
- Phase 3 explicitly budgets the required visual QA matrix for chat fastpath
  rendering and interaction changes.

## Diagnosis Preservation Links

Baseline commit:
`b8092bc4276d795cdd745fd6cfb2173e60d7ae3d`.

- [`src/api/routes/chat-fastpath.ts`](https://github.com/felipedrf74/cortex-telegram-hub-bot/blob/b8092bc4276d795cdd745fd6cfb2173e60d7ae3d/src/api/routes/chat-fastpath.ts)
- [`src/services/secretary-fastpath.ts`](https://github.com/felipedrf74/cortex-telegram-hub-bot/blob/b8092bc4276d795cdd745fd6cfb2173e60d7ae3d/src/services/secretary-fastpath.ts)

Future work should diff against these two files first, then check whether the
adapter count has grown beyond the current four call sites.

## Cleanup Confirmation

- No production deploy was performed.
- `main` was only pushed for the required pre-round production-state
  reconciliation before this diagnosis.
- No iOS code was touched.
- No TestFlight build was cut.
- The Phase 2B.5 branch and backup tag were preserved on origin.

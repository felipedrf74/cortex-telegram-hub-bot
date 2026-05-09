# Phase 2B.5 — Chat Fastpath Dedup — DEFERRED_WITH_REASON

Date: 2026-05-09 (deferred); 2026-05-10 (documented)
Branch: `phase2b5-chat-fastpath-dedup-2026-05`
Branch tip: `b8092bc4`
Backup tag: `backup/phase2b5-before-20260509-1909`
Status: DEFERRED_WITH_REASON

## Diagnosis (source-side probe, not audit narrative)

- Files mentioning `fastpath`: 14
- Actual runtime fastpath adapter / call sites: 4
- Heavy duplicated implementation files (cite at this commit):
  - `src/api/routes/chat-fastpath.ts` — 569 LoC
  - `src/services/secretary-fastpath.ts` — 912 LoC
- Shared mechanics across the two heavy files:
  - command cache keys
  - pending-task cache TTL
  - in-flight dedup / coalescing

## Audit-vs-reality gap

The Phase 2B.5 round was prompted on the assumption that "chat fastpath dedup" was a Phase 2B-class architecture round. Source-side probe revealed only 4 actual runtime sites concentrated in 2 files. This continues a pattern across Phase 2B (Phase 2B.3 audit said 16+, actual was 6; Phase 2B.5 audit implication mapped to 14 mentions, 4 sites). Audits have been ~3x optimistic across the Phase 2B series.

## Prototype attempt and result

I prototyped a small `chat-fastpath-dedup` primitive that consolidated the three shared mechanics behind a typed config interface. The focused suite passed (4 files / 131 tests). However, the honest source LoC delta excluding tests was **+152**. The prompt's hard stop condition ("Stop if LoC delta is positive after honest accounting") triggered.

The rejected primitive shape:
- Composition over inheritance
- Typed config: `{ cacheKeyBuilder, ttlSeconds, dedupKey, fetch, send }`
- Owned: cache lookup, single-flight, pending-task TTL window
- Caller-owned: command parsing, optimistic stub, error mapping

Why it grew the LoC instead of shrinking it: the primitive's interface plus per-site adapter shims plus migration tests added more code than the deduplicated mechanics removed. The two heavy files retained 80%+ of their per-site bespoke logic regardless.

## Why deferred

- A smaller dedup-only primitive does not pass the deletion / LoC bar.
- A wider merge (iOS slash-command fastpath + Telegram secretary-fastpath dictionaries) would likely pass the deletion test but changes user-visible chat rendering and would trigger the visual QA protocol (10+ chat-state cells × 2 locales).
- Wave 1 launch is the active priority. Speculative architecture rounds with chat-rendering risk are the wrong tradeoff right now.

## Re-open trigger

Re-open Phase 2B.5 if any of the following:
- Real beta usage shows the dedup mechanic causing observable bugs (duplicate task creation, double-fired commands, stale pending-task UI).
- A third fastpath site appears (anything that needs the same `command cache keys + pending-task cache TTL + in-flight dedup` pattern).
- A dependent feature requires a unified fastpath surface (e.g. cross-domain command routing, multi-tenant fastpath persistence).
- The audit-vs-reality gap closes in a way that justifies the wider chat-rendering merge.

## Diagnosis preservation

If you re-open, start from this baseline before re-probing:
- `chat-fastpath.ts` at `b8092bc4` is 569 LoC.
- `secretary-fastpath.ts` at `b8092bc4` is 912 LoC.
- Diff against future tip to see which mechanics moved or grew.

Cleanup contract:
- No production touched.
- Branch and backup tag preserved on origin.
- No iOS work for Phase 2B.5.

Status: current
Owner: backend security lead
Last verified: 2026-05-06 against local engine main `699f3ee6`
Update policy: update when `src/state/content-references.ts` exports, owner-scope semantics, or content-reference admin gates change.

# Content References Scope Audit

Batch 19 audited `src/state/content-references.ts` after the Batch 18
`coach-state.ts` fix-first merge. The v4.14.118 P0 chat-identity audit
intentionally preserved neutralized system-scope content-reference rows
(`owner_scope = 'system'` / `user_id = 0`) so shared reference templates and
prompt snippets can exist without assuming a founder identity.

## Verdict

**BLOCKED / Batch 20 fix-first required.**

The audit found public state-layer write paths that can create, mutate, or
delete system-scope rows without an explicit admin-gated contract at the
`content-references.ts` boundary. Per Batch 19's consolidated stop rules, Codex
must document this and stop before adding the six-module isolation test pack.

## Export Classification

| Export | Signature | Classification | Guard status | Batch 20 follow-up? |
| --- | --- | --- | --- | --- |
| `ContentOwnerScope` | type | metadata | n/a | no |
| `ContentRefChannel` | interface | metadata | n/a | no |
| `ContentPattern` | interface | metadata | n/a | no |
| `ContentKnowledge` | interface | metadata | n/a | no |
| `PATTERN_CATEGORIES` | const | metadata | n/a | no |
| `PatternCategory` | type | metadata | n/a | no |
| `addChannel` | `(channelUrl, addedVia = 'manual', userId = 0, tenantId?) => ContentRefChannel` | mixed write path: user-scoped when `userId > 0`, system-scoped when omitted or `0` | user path lacks positive-user guard; system write path is not admin-gated at state layer | yes |
| `getChannel` | `(id: number) => ContentRefChannel \| undefined` | mixed id-only read path | no user/tenant guard; relies on caller-side ownership checks | yes |
| `getAllChannels` | `(userId?, tenantId?) => ContentRefChannel[]` | mixed read path: user, platform-system, or all rows when omitted | user path lacks positive-user guard; omitted-user all-row read is not explicit admin API | yes |
| `getActiveChannels` | `(userId?, tenantId?) => ContentRefChannel[]` | mixed read path: user, platform-system, or all rows when omitted | user path lacks positive-user guard; omitted-user all-row read is not explicit admin API | yes |
| `getPendingChannels` | `(userId?, tenantId?) => ContentRefChannel[]` | mixed read path: user, platform-system, or all rows when omitted | user path lacks positive-user guard; omitted-user all-row read is not explicit admin API | yes |
| `updateChannelStatus` | `(id, status, extra?) => void` | mixed id-only write path | can mutate user or system rows by raw id; no state-layer admin/user guard | yes |
| `removeChannel` | `(id: number) => boolean` | mixed id-only destructive write path | can delete user or system rows by raw id; no state-layer admin/user guard | yes |
| `upsertPatterns` | `(channelId, patterns) => void` | mixed write path inherited from channel owner scope | writes user or system patterns by raw channel id; no state-layer admin/user guard | yes |
| `getPatternsForChannel` | `(channelId: number) => ContentPattern[]` | mixed id-only read path | no user/tenant guard; relies on caller-side ownership checks | yes |
| `getAllPatternsByCategory` | `(category, userId?, tenantId?) => ContentPattern[]` | mixed read path: user, platform-system, or all rows when omitted | user path lacks positive-user guard; omitted-user all-row read is not explicit admin API | yes |
| `upsertKnowledge` | `(category, synthesizedText, sourceChannels, userId = 0, tenantId?) => void` | mixed write path: user-scoped when `userId > 0`, system-scoped when omitted or `0` | user path lacks positive-user guard; system write path is not admin-gated at state layer | yes |
| `getAllKnowledge` | `(userId?, tenantId?) => ContentKnowledge[]` | mixed read path: user, platform-system, or all rows when omitted | user path lacks positive-user guard; omitted-user all-row read is not explicit admin API | yes |
| `getKnowledgeByCategory` | `(category, userId?, tenantId?) => ContentKnowledge \| undefined` | mixed read path: user, platform-system, or all rows when omitted | user path lacks positive-user guard; omitted-user all-row read is not explicit admin API | yes |
| `buildKnowledgePromptBlock` | `(userId?, tenantId?) => string` | user-scoped prompt context when `userId` is supplied; mixed/all-row prompt context when omitted | v4.14.118 neutralized founder identity and filters supplied user scope; omitted-user path remains too implicit | yes |

## Required Batch 20 Shape

Batch 20 should split the content-reference state surface before adding the
remaining isolation tests:

1. Replace implicit `userId = 0` defaults on write paths with explicit
   system/admin entry points.
2. Add positive safe-integer guards to user-scoped read and write paths.
3. Make all all-row reads explicit admin helpers rather than omitted-user
   fallbacks.
4. Add ownership checks or scoped companion helpers for id-only channel and
   pattern functions.
5. Preserve system-scope neutral reference semantics from v4.14.118, but require
   an explicit admin/system call site for writes.

## Batch 19 Stop Rule Fired

The stop rule that fired:

> P2: a write path to system-scope rows is found that is not admin-gated
> (document, do not fix inline).

As a result, Batch 19 does not proceed to P3 and does not run the D5/F4 refresh
side-task.

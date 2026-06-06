# QA Release Gate Report - Chat RC

Date: 2026-04-29  
Release branch reviewed: `release/chat-tenant-safe-production-candidate`  
Primary decision record: `docs/chat/chat-final-production-go-no-go.md`

## Executive Summary

Final release-gate verdict for the Chat RC: **GO WITH CONDITIONS**.

The production snapshot condition is now closed for this deployment run. The RC can proceed through staging deploy and focused Chat staging smoke. Production promotion remains blocked until staging smoke passes.

## 2026-05-04 Closed-Beta Two-Agent Gate Addendum

Current closed-beta recommendation after Claude hardening plus Codex adversarial validation: **READY_WITH_CONDITIONS**.

Why:

- Backend/content hardcoded-founder vectors found by Claude were real, and Codex found additional Content agent/runtime vectors that Claude missed. The extra vectors are now neutralized and pinned by tests plus strict scanner coverage.
- iOS physical-device Training fixture validation is now real interaction, not launch-only: 11 / 11 `TrainingFixtureBypassUITests` passed on the connected iPhone after Codex fixed DEBUG fixture auth/background warmup isolation.
- Focused backend typecheck/security/content/classifier gates passed locally, and focused iOS cache/security/unit gates passed on physical iPhone.

Conditions before removing the qualifier:

- Run signed two-account TestFlight validation for Felipe, Jaqueline, and `nexushubbot`, especially identity, readiness/body-battery, Garmin connection visibility, Training cache state, and account switch.
- Run safe non-production Google/Outlook calendar lifecycle smoke; production calendars remain out of scope for QA.
- Run or explicitly defer portal user-console preference-edit smoke. The current portal policy is operator-only for closed beta.
- Continue the broader docs-audit cleanup for existing scattered/stale markdown. The new closed-beta runbook and portal policy now live under approved `docs/release/*` locations; the remaining warnings are baseline documentation hygiene, not a closed-beta code blocker.

## Readiness Score

| Area | Score | Notes |
| --- | ---: | --- |
| Backend Chat | 92 / 100 | Strong REST tenant/security/lifecycle evidence; staging-clone migration rehearsal passed; fresh production DB snapshot created; provider/streaming limitations are restrained by release copy. |
| iOS Chat | 82 / 100 | Rich metadata rendering and cache scoping ready; true tenant switch, live streaming, and full multi-skill transcript smoke remain partial. |
| Portal Chat | 78 / 100 | Metadata-only diagnostics are privacy-safe; user console/raw support workflow intentionally not implemented. |
| Overall | 88 / 100 | Conditional RC; staging smoke is the remaining promotion gate. |

## Critical Open Blockers

No open P0 for the current REST Chat scope if release constraints are followed.

## High-Risk Open Conditions

- Fresh production DB snapshot is closed for this deployment run: `/home/dominguez/telegram-hub-bot/data/release-snapshots/chat-tenant-safe-20260429T085055Z/predeploy-bot.db`, SHA-256 `11a54315544eee5872946b06c7f4b1cfffa357176a509d9e1654a608b2b03428`, integrity `ok`.
- Migration file history alignment is closed: this branch includes production/staging `082_training_session_identity_shape_hash.sql`, recovered `083_secretary_agenda_ledger.sql`, and Chat migrations renumbered to `084`/`085`.
- WebSocket streaming must remain disabled unless separately hardened.
- Live-provider/fallback/operator-pin quality claims require bounded real-provider smoke.
- Durable tool invocation lifecycle remains future work and must be accepted out of scope for this release.
- Durable attachment/support inspection must remain out of scope or receive scoped audit.
- True workspace switching must not be claimed until active tenant membership exists.

## Security Status

REST Chat security is acceptable for conditional RC:

- tenant/user scoped history and messages
- scoped memory/context path
- server-side tool authorization
- destructive confirmation
- prompt-injection refusal/weak-context handling
- metadata-only portal diagnostics

## Tenant Isolation Status

Ready for the current canonical tenant model (`tenantId = userId`) after the passed staging-clone migration rehearsal. Not ready for independent workspace switching.

## API Contract Status

Backend Chat REST contracts are test-backed. iOS can decode/render richer lifecycle and structured metadata. Confirmation callback and full multi-conversation UX remain future work.

## Test Coverage Status

Latest RC evidence:

- 26 backend Chat/security/provider/portal test files / 683 tests passed.
- `npm run typecheck`, `npm run lint`, `npm run build` passed.
- `npm run chat:eval` passed: 24 scenarios, average `1.99 / 2.00`.
- Day-to-day simulation passed: 10 scenarios, average `1.93 / 2.00`.
- Local full-product smoke passed with documented limitations and clean cleanup.
- iOS local smoke passed for local backend connectivity and rich rendering, with documented partials.

## Final Recommendation

Proceed with staging deployment and focused Chat staging smoke. Do not promote to production until staging smoke passes.

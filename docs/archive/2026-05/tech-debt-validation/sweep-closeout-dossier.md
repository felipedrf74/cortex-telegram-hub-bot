# Tech-Debt 2026-05 Sweep Closeout Dossier

Status: archive
Owner: Codex
Last verified: 2026-05-07
Update policy: archive-only closeout dossier; do not edit after Batch 24 closure.

## Headline

The 2026-05 tech-debt sweep ran from 2026-05-05 through 2026-05-07 across
Batches 1-24. The original scan carried 101 findings: 8 P0, 14 P1, 22 P2, and
about 57 P3 items. The backend/source closeout state at Batch 24 is:

| Priority | Original | Source/docs closed with E2 evidence | Operator-only / evidence-gap carryover |
|---|---:|---:|---:|
| P0 | 8 | 8 | 0 |
| P1 | 14 | 14 | 0 |
| P2 | 22 | 18 | 4 |

The four P2 carryovers are not unowned source fixes: P2-35 remains operator-only
because Garmin MFA/live-session proof is Felipe-gated, and P2-31/P2-36/P2-41
are iOS-lane evidence gaps in this archive because Batch 17 has revalidation
evidence but no reconstructable remediation report. This dossier does not
pretend those iOS reports exist.

Final backend gates before this dossier:

| Gate | Final value |
|---|---:|
| Full backend verify | 467 files / 6973 tests |
| Python content-engine pytest | 135 tests |
| P0 chat identity isolation | 23/23 |
| Cannot-skip-gate dashboard | 23/23 |
| Strict partial-mock lint | 827 / 827 |
| docs:audit | 480 issues / 423 audited markdown files |

## Per-Priority Closure Ledger

Regression paths list the primary evidence path. Many findings also carry the
global `__tests__/security/p0-chat-identity-isolation.test.ts` 23-case gate.

### P0

| ID | Finding | Closing batch | Final SHA | Regression / evidence path |
|---|---|---|---:|---|
| P0-01 | Auth route failure-path tests imbalance | Batch 2 B1 | `7538749` | `__tests__/api/auth-routes.test.ts`; P0 identity 23/23 |
| P0-02 | Backend hardcoded Lisbon literals | Batch 2 B5 | `025319e`, `1a82150` | `__tests__/services/user-timezone.test.ts`; timezone focused pack |
| P0-03 | iOS Lisbon assumptions | Batch 2 B5 | `1a82150` | iOS timezone/currency/parser focused tests |
| P0-04 | iOS scope-key duplication | Batch 2 B6 | `55bc2e2` | iOS scope/source-pin focused tests |
| P0-05 | `axios` advisory chain | Batch 1 A1 | `2139235` | `npm audit --json` clean; full verify |
| P0-06 | Divergent SHA256 email-hash helpers | Batch 1 A3 | `8145b82` | `__tests__/utils/identity.test.ts` |
| P0-07 | `@xmldom/xmldom` high advisories | Batch 1 A1 | `2139235` | `npm audit --json` clean; full verify |
| P0-08 | Optional Sentry without production posture | Batch 1 A2 | `463d5da` | `__tests__/services/error-tracker-config.test.ts`; health route tests |

### P1

| ID | Finding | Closing batch | Final SHA | Regression / evidence path |
|---|---|---|---:|---|
| P1-09 | Five divergent `withRetry<T>` implementations | Batch 4 D4 | `47fb7ed6` | `__tests__/utils/retry.test.ts`; provider focused pack |
| P1-10 | Coverage threshold floor | Batch 2 B2 | `33745b5` | coverage run plus `vitest.config.ts` threshold gate |
| P1-11 | Broken markdown references over budget | Batches 10-11 | `4ad52c63`, `e9792127` | `npm run docs:audit`; docs auditor refinement tests |
| P1-12 | `DEPLOY.md` / `STAGING.md` stale metadata | Batches 10-11 | `4ad52c63`, `e9792127` | `npm run docs:audit`; frontmatter guard tests |
| P1-13 | Duplicate cost price tables | Batch 14 K1 | see Batch 14 report | cost table focused tests; `codex-batch-14-remediation.md` |
| P1-14 | 970-line `startScheduler()` body | Batch 15 L3/L4 | `d8523505`, `e1865147` | `__tests__/services/scheduler-inventory-invariant.test.ts` |
| P1-15 | Migration prefix collisions not CI-enforced | Batch 1 A4 / Batch 4 D1 | `26a583c`, `3a68ccc2` | `__tests__/services/database-migration-prefix-collisions.test.ts` |
| P1-16 | Hardcoded model strings | Batch 2 B3 | `3ededc3` | model config/provider routing focused tests |
| P1-17 | iOS formatter churn | Batch 14 K2 | see Batch 14 report | iOS formatter focused evidence in Batch 14 |
| P1-18 | Divergent JWT verification call sites | Batch 2 B4 / Batch 21 R2 | `43fb15d`, `aef9fa9d` | `__tests__/services/ios-jwt-rotation.test.ts`; auth middleware tests |
| P1-19 | Oversized `OPEN_ITEMS.md` with no rotation cadence | Batch 5 E3 / Batch 24 U3 | `8bd70cf7`, Batch 24 | `__tests__/scripts/rotate-open-items.test.ts`; manual rotation evidence |
| P1-20 | `test-count-literal` over budget | Batches 10-11 | `4ad52c63`, `e9792127` | `npm run docs:audit` frozen-class budget |
| P1-21 | Restore-test cron failure escalation | Batch 4 D3 | `605f0f46` | restore-test history/operator alert focused tests |
| P1-22 | `/health` missing content/provider readiness | Batch 4 D2 | `a61dc5ec` | health endpoint focused tests |

### P2

| ID | Finding | Closing batch | Final SHA | Regression / evidence path |
|---|---|---|---:|---|
| P2-23 | iOS repository scope invalidation duplication | Batch 2 B6 | `55bc2e2` | iOS scope/source-pin focused tests |
| P2-24 | Untested state modules | Batches 18-20 | `4e7e89df`, `0bf095e2`, `266094e5`, `9cd72866` | six state isolation packs, 209 tests in Batch 20 Q2 |
| P2-25 | Missing VPS cold-start DR runbook | Batch 4 D6 | `93308a6e` | `docs/runbooks/vps-cold-start.md` |
| P2-26 | Dead WhatsApp adapter | Batch 1 A6 | `1ef044e` | full verify after adapter deletion |
| P2-27 | Vite dev-server CVEs | Batch 1 A1 | `2139235` | `npm audit --json` clean |
| P2-28 | Auditor allowlist out of sync | Batch 1 A5 | `2aff001` | `npm run docs:audit` allowlist check |
| P2-29 | `deploy.sh --no-verify` policy-only skip | Batch 16 M4 | `add2a2cb` | `__tests__/scripts/record-deploy-audit.test.ts`; deploy safety gate tests |
| P2-30 | Direct AI SDK construction / provider bypass | Batch 9 C5/E1/F1 | see Batch 9 stack | `__tests__/architecture/no-direct-anthropic-construction.test.ts` |
| P2-31 | `PreviewRuntime.isRunning` iOS escape sites | Evidence gap | unknown | Batch 17 revalidation exists; no remediation report in archive |
| P2-32 | Inline scoring weights | Batch 14 K3 | see Batch 14 report | weight/docstring focused evidence in Batch 14 |
| P2-33 | `services/*` importing `portal/*` | Batch 5 E5 / Batch 9 F3 | `d42a1e6b`, see Batch 9 stack | architecture import lint and portal/observability focused tests |
| P2-34 | Python/TS content-engine version drift | Batch 16 M3 | `c47aae56` | `__tests__/services/content-engine-version-drift.test.ts`; Python health tests |
| P2-35 | `garmin-connect` unmaintained / live MFA gap | Operator-only carryover | n/a | Garmin MFA/live-session proof is Felipe-gated |
| P2-36 | Stale iOS specs | Evidence gap | unknown | Batch 17 revalidation exists; no remediation report in archive |
| P2-37 | Duplicate/scattered current verdict warnings | Batches 10-11 | `4ad52c63`, `e9792127` | duplicate-verdict auditor tests; docs:audit |
| P2-38 | PM2 recovery / supervisor self-heal | Batch 21 R1 | `c23d748a`, `c5d1ffb7` | `__tests__/services/pm2-health.test.ts`; health endpoint tests |
| P2-39 | Cloudflare Tunnel runbook gap | Batch 4 D6 | `93308a6e` | `docs/runbooks/cloudflared-tunnel.md` |
| P2-40 | JWT rotation hook | Batch 21 R2 | `aef9fa9d`, `651612ba` | `__tests__/services/ios-jwt-rotation.test.ts`; JWT runbook |
| P2-41 | Content `content-*` accessibility IDs no XCUITest | Evidence gap | unknown | Batch 17 revalidation exists; no remediation report in archive |
| P2-42 | Concentrated partial `vi.mock` debt | Batches 4/22/23 | `16d05f1b`, `5d1a722b`, `ef9b5e0b` | `node scripts/vi-mock-completeness-lint.mjs --strict` |
| P2-43 | Missing secret rotation pipeline | Batch 4 D6 | `93308a6e` | `docs/runbooks/secret-rotation.md`; rotation helper tests |
| P2-44 | GitHub Actions IPv6 reachability | Batch 21 R3 | `a78b6922`, `c903f98f` | `.github/workflows/promote-reachability.yml`; self-hosted runner prereqs |

## Quantitative Gains

| Metric | Start | Final | Delta |
|---|---:|---:|---:|
| Backend verify tests | 6545 | 6973 | +428 |
| Backend test files | 433 | 467 | +34 |
| Partial mocks | 1039 | 827 | -212 |
| Python content-engine pytest | 0 | 135 | +135 |
| docs:audit issues | 493 | 480 | -13 |
| Audited markdown files | 399 | 423 | +24 |

## Architectural Changes

- State-layer canonical guard pattern: positive user identifiers are enforced
  across the six high-risk state modules; `src/state/saved-ideas.ts` remains the
  reference shape and the six-module isolation pack pins the contract.
- P0 chat identity contract: `__tests__/security/p0-chat-identity-isolation.test.ts`
  remains the 23-case release-blocking identity regression.
- JWT key-id versioning: iOS API tokens now support `kid`-based signing and
  verification overlap, with `scripts/rotate-jwt-signing-key.ts` and the JWT
  rotation runbook.
- PM2 supervisor self-heal observability: `src/services/pm2-health.ts` feeds
  restart/non-online process state into `/health/detailed` and alert evidence.
- GitHub Actions reachability: promote reachability is routed through
  Cloudflare HTTPS checks, with self-hosted runner prerequisites documented for
  SSH-only workflows.
- Strict mock lint: partial mock debt is enforceable on main at 827.
- Genai migration: `@google/generative-ai` is removed; production Gemini code
  uses `@google/genai` through the stable Nexus adapter boundary.
- Observability extraction: portal telemetry and Anthropic hook code moved under
  `src/observability/` with architecture lint coverage.
- Bootloader-shape `CLAUDE.md`: release narrative moved out of the backend
  bootloader and into release history/current docs.
- Canonical runbooks: VPS cold-start, Cloudflared tunnel, secret rotation, and
  JWT rotation are now durable operator docs.

## Operator-Only Carryovers

- Push local main to origin; the local branch is intentionally many commits
  ahead and was not pushed by Codex.
- Staging deploy and smoke.
- Production promote and production health.
- Signed TestFlight and two-account walkthrough.
- APNs validation.
- Real Gmail/Outlook/Health provider-state checks.
- Non-prod OAuth credential provisioning.
- Garmin MFA session, which is the remaining closure path for P2-35.
- Content portal smoke window.
- iOS fastlane setup, if Felipe chooses to pursue it.
- Self-hosted runner provisioning, only if SSH-only promote workflows need it.

## Open Authorization-Gated Workstreams

- Content lifecycle unification remains Codex-addressable but pending explicit
  Felipe authorization. The planned queue is Batches 25-28.

## Lessons Learned

- STOP-AND-ESCALATE worked. Batches 16, 18, 19, 20, 22, and 23 all produced
  cleaner outcomes because Codex stopped on real isolation, audit, rebase, and
  adapter-surface findings instead of forcing closure.
- Conditional authorization markers reduced stack ambiguity. J2, F4 target
  reset, genai phase work, and Batch 20/22 unblock merges were auditable because
  the authorization was recorded, not inferred.
- Stack-base merge sequencing matters. D5/F4, scheduler decomposition, state
  isolation, and genai migration all needed explicit branch ordering.
- Test-first batch design caught real source gaps. The state isolation work
  found invalid-user acceptance before tests were written into a false-green
  shape.
- Audit-trail discipline improved. Batch 22 found the missing Batch 20 closure
  report and reconstructed it explicitly instead of fabricating the original.

## Future-Proofing Ratchets

- Keep strict mock lint enabled at the 827 ceiling and lower it in small
  batches.
- Keep the 23-case P0 isolation regression as the canonical identity contract.
- Treat the six-module state isolation pack as the template for every new state
  module.
- Keep docs:audit frozen classes below the Batch 24 ceiling; do not copy test
  counts or release verdicts into scattered markdown.
- Keep phase authorizations explicit for content lifecycle and any future SDK
  migration phase.

# Claude Code — Tenant + Entitlement + Portal Hardening Handoff

## Current Cross-Agent Truth - 2026-04-25

This section supersedes older branch/status notes below. Historical handoff
content is retained only for provenance.

- Current backend beta branch: `beta/single-agent-rc`.
- Backend production is live at `4.14.67`.
- Full backend verification passed before the latest production deploy:
  345 test files / 5,452 tests.
- Hardened staging operator-session smoke passed valid, expired, tampered,
  unauthorized role/scope, wrong-tenant, and static-token rejection paths.
- External webhook/on-call staging drill passed alert creation, delivery,
  acknowledgement, resolution, and audit verification.
- Founder accounts verified in production:
  `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com`.
- Deploy scripts exclude worktree `.git` files and local agent/worktree
  artifacts so branch worktrees can deploy safely.
- Latest Content + Training TestFlight bugfix pass on 2026-04-25 is deployed
  in backend `4.14.67` and pushed in iOS `main`:
  `/api/v1/content/script` accepts `scriptStyle` (`detailed` or `bullets`),
  derives user-scoped Voice DNA from content knowledge, forwards it into the
  Python script engine, includes style in the script cache key, and returns
  `scriptStyle` in the API response. Python degraded fallback now distinguishes
  YouTube vs short-form and detailed vs bullet outputs, but a visible
  "Qualidade reduzida" response still means AI synthesis/generation was
  unavailable and the live AI provider path needs config/provider proof.
  Python JSON synthesis calls now set backend proxy `jsonMode`, reducing
  avoidable search-based fallbacks from non-JSON model formatting.
  iOS also fixed topic-list cache invalidation after topic writes, athlete
  profile finish actions from Training, and Training complete/skip fallback to
  the `"today"` sentinel.
- Follow-up Content scheduling/pipeline + Training readiness pass on
  2026-04-25 is deployed in backend `4.14.67` and pushed in iOS `main`:
  `POST/PATCH /api/v1/content/topics` now accepts
  `scheduledDateTime`; date-only topics create/update Secretary tasks;
  date+time topics also create/update calendar agenda/events through unified
  calendar; Content Tasks reads scheduled topics directly and shows
  task/calendar sync status; Pipeline Detail ignores benign superseded-load
  cancellation; Training keeps renderable Home/Training data visible during
  refresh; Home secondary previews fan out in parallel after the primary
  dashboard render. Migration `078_content_topic_secretary_artifacts.sql` is
  deployed with `4.14.67`; fresh signed TestFlight/device validation is still
  required before closing user-facing QA.
- Remaining public-beta gates are iOS distribution gates: signed TestFlight,
  APNs token/delivery proof, fresh auth/onboarding, true two-account switching,
  real Gmail/Outlook/Health provider-state checks, and device proof for the
  latest Secretary, Health, Content script/topic scheduling/pipeline, and
  Training action/readiness fixes.

Do not treat the older `claude/tenant-entitlement-portal-hardening` notes below
as current release status.

**Branch:** `claude/tenant-entitlement-portal-hardening`
**Date:** 2026-04-21
**Scope:** Tenant isolation + entitlement resolution + portal admin surface
hardening across backend (`cortex-telegram-hub-bot`). Prior pass
(`claude/project-hardening-audit`, merged as commit `29b2890`) handled
cross-project hardening — this pass is narrower but deeper on
multi-tenant + billing correctness.

---

## 1. TL;DR for the next agent

- **Three CRITICAL cross-tenant data leaks fixed.** All are silent (no
  error, no log, wrong-user data served under the right user's token).
  Before this branch: (C-1) any authenticated user could mark another
  user's training session complete/skipped; (C-2) the
  `training_plan_adjust` cron ran every user's adjustment inside
  OWNER's Garmin context, silently attributing Felipe's HRV/readiness
  to every user; (C-3) the task warmer wrote OWNER's tasks to global
  cache keys, so any subsequent cache hit on another user's request
  served owner data. Ownership gates + per-user `runWithContext` +
  user-scoped cache keys land in this branch.
- **Paid routes (`/content`, `/cooking`, `/finance`, `/invoices`) had
  NO tier gating whatsoever.** Free users could hit every one of them
  successfully. The business rule ("Free = Secretary only") was enforced
  in iOS UI and in skill-access logic **but not at the route layer**.
  Central `requireEntitlement` middleware now mounts on all paid
  routers; 403 TIER_REQUIRED on mismatch.
- **Entitlement resolution was scattered across 5+ modules with
  divergent semantics.** One looked at `users.tier`, another at
  `subscriptions`, a third at `isOwnerUserRef`, a fourth at
  `getFeatureAccessForUser`. Now there is one canonical resolver:
  `src/services/entitlement.ts > getEffectiveEntitlement(userId)`.
  Precedence owner > founder > apple > stripe > beta > free.
  Fail-closed on DB error.
- **Free tier was misaligned with the business rule.** Code defaulted
  Free to `$0.00/day` (effectively blocked at byte zero). Business
  rule is `$0.005/day` — "let people feel the product, then upsell."
  Constant + default + DB seed all aligned to `$0.005` in this branch.
- **Every new registration was being provisioned as `tier='pro'`.**
  `createAppleUser`, `createGoogleUser`, `createEmailUser` all
  hardcoded `pro`. Every new signup got pro-tier caps + pro-tier
  skills until the first Apple/Stripe webhook fired (which might
  never, if the user never paid). Now default is `tier='free'`.
- **Portal was NOT the source of truth for per-plan caps** — every
  value was hardcoded in `src/services/plan-quotas.ts`. Admins had
  to redeploy to change Pro's $0.20 cap. Migration 075 adds a
  `plan_configs` table. `GET /api/plans` + `PUT /api/plans/:planId`
  are the portal-facing CRUD. Boot hydrates from DB; runtime edits
  go straight to both DB and in-memory override.
- **Portal admin mutations were not audited.** Founder assignment,
  tier overrides, limit changes had no audit_trail rows. Now every
  admin mutation emits `action='admin_mutation'` with resource +
  changes + actor id.
- **All 10 fixes validate green.** `tsc --noEmit` clean. Vitest:
  **4733/4733** pass (14 new entitlement tests + 2 new training
  cross-tenant reject tests + 2 updated cost-guardrail tests +
  1 new fiscal email-leak test).

---

## 2. What I fixed (narrow & merge-friendly)

| #  | Area              | File(s)                                                     | Change                                                                                                                                                   | Severity addressed           |
|----|-------------------|-------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------|
| 1  | Tenant isolation  | `src/api/routes/training.ts`                                | Ownership gate on POST `/complete` + POST `/skip`. `getSessionById` → `getPlanById` → assert `plan.user_id === ctx.userId`, else 403/404.                | **CRITICAL cross-tenant**    |
| 2  | Tenant isolation  | `src/services/scheduler.ts`                                 | `training_plan_adjust` cron body now wrapped in `runWithContext({ userId }, …)` per-user. Garmin/readiness lookups resolve the right user.               | **CRITICAL cross-tenant**    |
| 3  | Tenant isolation  | `src/api/routes/tasks.ts`                                   | Warmer writes to owner-scoped cache keys `u:${userId}:*` instead of global; fail-closed 401 when `userId` is not a positive number.                      | **CRITICAL cross-tenant**    |
| 4  | Tenant isolation  | `src/services/fiscal-bundle.ts`, `src/state/fiscal-collection-profiles.ts` | Fiscal delivery summary no longer silently defaults to account email. Explicit `destination_email` or `DESTINATION_EMAIL_MISSING` warning.             | HIGH PII-leak-between-contexts |
| 5  | Entitlement       | `src/services/entitlement.ts` (new, 268 LOC)                | Canonical `getEffectiveEntitlement(userId)` with precedence owner→founder→apple→stripe→beta→free + fail-closed on DB error.                              | **CRITICAL security model**  |
| 6  | Entitlement       | `src/api/entitlement-middleware.ts` (new, 108 LOC), `src/api/router.ts` | `requireEntitlement({ skill, minPlan })` Express middleware mounted on `/content`, `/cooking`, `/finance`, `/invoices`. 403 TIER_REQUIRED on mismatch. | **CRITICAL paid-route bypass** |
| 7  | Entitlement       | `src/services/plan-quotas.ts`                               | `FREE_DAILY_COST_CAP_USD = 0.005` constant + default + override registry (`setPlanDailyCostCapOverride`, `applyPlanConfigRows`).                         | HIGH business-rule alignment |
| 8  | Entitlement       | `src/services/user-service.ts`                              | New registrations default to `tier='free'` (was `pro`) with free limits.                                                                                 | HIGH over-provisioning       |
| 9  | Entitlement       | `src/services/user-skill-access.ts`                         | Changed `catch { return true }` → `catch { logger.warn; return false }` (fail-closed on DB error).                                                       | HIGH fail-closed             |
| 10 | Portal + audit    | `src/portal/server.ts`, `src/services/audit-trail.ts`, `migrations/075_plan_configs.sql`, `src/index.ts` | New `plan_configs` table seeded with current defaults; new `GET /api/plans` + `PUT /api/plans/:planId`; founder add/remove + tier + limits now validated + audited; boot hydrates overrides from DB. | HIGH admin surface + audit trail |
| 11 | Security          | `src/api/router.ts` (Apple notifications handler)           | Removed try/catch swallow on bundle-id check. Malformed inner JWS, invalid payload, missing or mismatched bundleId all explicitly rejected (200 with reason).                                       | MED webhook spoofing defense |

**Validation:** `npx tsc --noEmit` clean, `npx vitest run` = **4733/4733** pass.

---

## 3. New test coverage

| File                                                        | Tests |
|-------------------------------------------------------------|------:|
| `__tests__/services/entitlement.test.ts` (new)              |    14 |
| `__tests__/api/training-routes.test.ts` (extended)          |    +2 |
| `__tests__/services/cost-guardrail.test.ts` (updated)       |    ±2 |
| `__tests__/services/fiscal-bundle.test.ts` (extended)       |    +1 |
| `__tests__/services/fiscal-collection-profile-state.test.ts` (new) | full harness |

Entitlement contract coverage: early-return for userId=0 without DB call,
owner via isOwnerUserRef, founder/apple/stripe subscription mapping, beta
trial sandbox, canceled→free-expired degrade, DB error fail-closed,
`PAYWALL_ENABLED=false` bypass, `isSkillAllowedByEntitlement` for Free
(Secretary only) and paid (UNRESTRICTED).

Training cross-tenant: two new tests prove that POST `/complete` and POST
`/skip` return 403 when the authenticated user is not the plan owner.

---

## 4. What I found but did NOT fix (triaged)

### HIGH
- **Cost-guardrail TOCTOU race.** `checkCostGuardrail` reads today's spend,
  decides, returns. Nothing serializes concurrent requests within the same
  user. Two simultaneous chat-fastpath calls can both pass the check, both
  spend, and together exceed the cap. Under normal iOS usage this is
  near-impossible (serial request queue) but under an automated workload
  a user on Free could burn 2–3× the daily cap. Fix would be a per-user
  in-memory mutex around `spendCost + checkCostGuardrail`.
- **Portal admin access check** — `requireAdmin` middleware lives but
  the implementation trusts `access_level === 'admin'` with no session
  expiry. A compromised admin token never expires. Add `max-age` and
  periodic re-auth.

### MEDIUM
- **`plan_configs` per-skill caps + allowed_skills JSON columns are
  present but unused by runtime.** The seed rows populate them correctly;
  the runtime still uses the hardcoded `FREE_TIER_ALLOWED_SKILLS` set in
  `entitlement.ts`. Next logical step: teach `isSkillAllowedByEntitlement`
  to read `plan_configs.allowed_skills_json` on cold-path and cache for
  the request. Low risk (one read per request, in a table that's read
  once at boot).
- **Apple and Stripe webhook handlers still do not rate-limit.** A forged
  payload burst could flood `app_store_notifications` / `stripe_events`.
  Apple's JWS validation + bundle-id check catches most, but rate-limiting
  is cheap.
- **Free users who consume $0.005 then fail quota don't see the upsell
  prompt in iOS.** Backend returns 402 QUOTA_EXCEEDED correctly; iOS
  surfaces "try again tomorrow" rather than "upgrade to Pro." Coordinate
  with Codex on iOS copy.

### LOW
- **`plan_configs` migration 075 inserts `'owner'` with
  `allowed_skills_json='["secretary","training",...]'` but owner users
  bypass the allowed-skills check entirely via
  `FREE_TIER_ALLOWED_SKILLS` + `_UNRESTRICTED`.** The JSON is decorative
  for owner rows. Harmless but confusing.
- **Entitlement middleware assumes every route has a `userId` attached
  by upstream auth middleware.** If the order ever gets shuffled in
  `router.ts` (entitlement before auth) the middleware returns 401. Add
  a defensive assertion.

---

## 5. Target architecture (already partially realized)

```
                ┌─────────────────────────────────────┐
                │         Portal admin UI             │
                │   (plan_configs CRUD, founders)     │
                └─────────┬───────────────────────────┘
                          │  PUT /api/plans/:planId
                          │  POST /api/founders
                          ▼
                ┌─────────────────────────────────────┐
                │       plan_configs (SQLite)         │◄─── audit_trail
                └─────────┬───────────────────────────┘
                          │  boot hydration
                          │  + runtime setPlanDailyCostCapOverride
                          ▼
                ┌─────────────────────────────────────┐
                │        plan-quotas (in-memory)      │
                │  portalOverrides > DB > compiled    │
                └─────────┬───────────────────────────┘
                          │
                          ▼
     Apple webhook ──►┌─────────────────────────────┐
     Stripe webhook ──►│ subscriptions (SQLite)      │
     Founder admin ──►│                             │
                      └────────────┬────────────────┘
                                   │
                                   ▼
                      ┌─────────────────────────────┐
                      │   getEffectiveEntitlement() │
                      │   (src/services/entitlement)│
                      └────────────┬────────────────┘
                                   │
                                   ▼
                ┌─────────────────────────────────────┐
                │    requireEntitlement middleware    │
                │    mounted on /content, /cooking,   │
                │    /finance, /invoices              │
                └─────────────────────────────────────┘
```

The contract is: **iOS never decides who can use what.** It renders what
the backend says the user has. Paid-route gating is the backend's job.
iOS upsell UX is cosmetic; bypassing it is meaningless because the
backend will 403 anyway.

---

## 6. Coordination with Codex

Codex is working on iOS plan-gating UI in parallel. Files touched in this
branch that Codex may also touch:

- `src/api/router.ts` — I touched mount points and Apple webhook. Codex's
  iOS work is read-only of this file's contract; merge should be clean.
- `src/portal/server.ts` — I added `/api/plans` CRUD and hardened
  founder/tier/limits routes. Codex's iOS work doesn't touch portal.
- `migrations/075_plan_configs.sql` — new file; Codex's branch should
  pick up via migration runner on next boot.

**iOS-side contract changes Codex needs to know about:**

- 402 QUOTA_EXCEEDED now has `details.plan: 'free'` in addition to
  pro/max. iOS decoder should accept all three and surface upgrade CTA
  for `'free'`.
- 403 TIER_REQUIRED is a new response code on `/content`, `/cooking`,
  `/finance`, `/invoices`. Body shape documented in TOKEN-QUOTA-CONTRACT.md.
  iOS should interpret and render "upgrade to Pro" rather than generic
  error.
- `GET /api/v1/dashboard > quota.limit_usd` can now be `0.005` for Free
  users (previously `0` implying blocked). iOS quota banner needs to
  render this correctly (not as "$0.00").

---

## 7. Validation evidence

```
$ npx tsc --noEmit
(clean)

$ npx vitest run
 Test Files  235 passed (235)
      Tests  4733 passed (4733)
   Duration  ~70s
```

New/changed files:
```
 migrations/075_plan_configs.sql                                    | NEW
 src/services/entitlement.ts                                        | NEW (268 LOC)
 src/api/entitlement-middleware.ts                                  | NEW (108 LOC)
 __tests__/services/entitlement.test.ts                             | NEW (14 tests)
 __tests__/services/fiscal-collection-profile-state.test.ts         | NEW (harness)
 src/api/router.ts                                                  | modified
 src/api/routes/training.ts                                         | modified (ownership gate)
 src/api/routes/tasks.ts                                            | modified (scope fix)
 src/index.ts                                                       | modified (boot hydration)
 src/portal/server.ts                                               | modified (plans CRUD + validation + audit)
 src/services/audit-trail.ts                                        | modified (new action type)
 src/services/plan-quotas.ts                                        | modified (override registry + Free $0.005)
 src/services/scheduler.ts                                          | modified (runWithContext per-user)
 src/services/user-service.ts                                       | modified (tier=free default)
 src/services/user-skill-access.ts                                  | modified (fail-closed)
 src/services/fiscal-bundle.ts                                      | modified (no email silent fallback)
 src/state/fiscal-collection-profiles.ts                            | modified (explicit destination)
 __tests__/api/training-routes.test.ts                              | modified (+2 reject tests)
 __tests__/services/cost-guardrail.test.ts                          | modified (Free=$0.005 contract)
 __tests__/services/fiscal-bundle.test.ts                           | modified (+1 leak test)
 docs/TOKEN-QUOTA-CONTRACT.md                                       | updated
 docs/agents/claude/handoff.md                                      | this file
```

---

## 8. Final commit / push plan

Single branch: `claude/tenant-entitlement-portal-hardening`. Push to origin
as a PR-ready deliverable. **Do not merge to main without:**

- Human review of the 10 fixes (especially #1–#4 cross-tenant gates — those
  change request-handling semantics).
- Coordination with Codex on iOS QUOTA_EXCEEDED / TIER_REQUIRED decoders
  (see section 6).
- A staging smoke run covering: (a) Free user tries `/content` → 403
  TIER_REQUIRED; (b) Pro user spends down to quota → 402 QUOTA_EXCEEDED;
  (c) Admin edits a plan cap via portal → persists on restart; (d) Admin
  assigns founder → user is `source='founder'` on next request; (e)
  Two concurrent training completions from different users don't cross-mark.

---

*Signed: Claude Sonnet 4.6 (1M context), tenant/entitlement/portal hardening
pass 2026-04-21.*

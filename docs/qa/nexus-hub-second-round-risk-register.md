# Nexus Hub — Second-Round Risk Register

**Generated:** 2026-04-30
**Audit:** second-round QA gap review at HEAD `414383b` (4.14.106 deployed)

Risks introduced or unaddressed by the prior QA + remediation chain. Each scored severity × probability → impact.

- **Severity** (1–5): blast radius if it materializes
- **Probability** (1–5): likelihood within 30 days of next major release

## Risk-impact matrix (ordered by impact)

### R2-RISK-1 — Stale Secretary agenda items after training plan cancellation
- **Severity:** 4 (user-visible ghost data; agenda integrity)
- **Probability:** 5 (every plan cancel today)
- **Impact:** **20**
- **Source finding:** ADV-4 / R2-P0-1
- **Mitigation:** training cancel emits `cancelSecretaryAgendaItem` for all `source_skill='training'` agenda items
- **Owner:** Training + Secretary
- **Acceptance:** test asserts agenda item moves to `lifecycle_state='canceled'` after training cancel

### R2-RISK-2 — Stale cross-skill memory after plan cancellation
- **Severity:** 3 (recommendations cite cancelled plans; UX, not security)
- **Probability:** 5 (every plan cancel today)
- **Impact:** **15**
- **Source finding:** ADV-5 / R2-P0-2
- **Mitigation:** emit `training_plan_canceled` signal + `markSkillMemoriesStaleForVersion` for cooking/secretary/chat skills
- **Owner:** Training + Memory

### R2-RISK-3 — Legacy training-calendar-sync route bypasses Secretary
- **Severity:** 4 (architectural invariant violation; multi-skill collisions)
- **Probability:** 3 (only fires when user/cron invokes `/training/plan/sync-calendar`)
- **Impact:** **12**
- **Source finding:** FC-1 / R2-P0-3
- **Mitigation:** route through Secretary OR feature-gate

### R2-RISK-4 — `tenant_id=user_id` write/read asymmetry latent ratchet
- **Severity:** 4 (security, the moment multi-tenant rolls out)
- **Probability:** 2 (only fires on multi-tenant rollout)
- **Impact:** **8**
- **Source finding:** FC-3 / UC-9 / R2-P1-9
- **Mitigation:** reject `tenant_shared` writes until membership table OR feature-gate
- **Note:** Probability rises sharply when a tenant_members table is introduced

### R2-RISK-5 — Mid-tool-loop provider fallback orphan tool_use_id
- **Severity:** 3 (silent corruption; user sees nonsensical response)
- **Probability:** 2 (only fires on provider failure mid-loop)
- **Impact:** **6**
- **Source finding:** ADV-2 / R2-P1-1

### R2-RISK-6 — Per-object confirmation not enforced in chat tool authorization
- **Severity:** 4 (security, destructive actions)
- **Probability:** 2 (requires multi-tool turn with destructive ops)
- **Impact:** **8**
- **Source finding:** ADV-3 / R2-P1-2

### R2-RISK-7 — Content with zero usable references generates ungrounded copy
- **Severity:** 3 (content quality / hallucination)
- **Probability:** 4 (any tenant with empty reference library; new tenants)
- **Impact:** **12**
- **Source finding:** ADV-6 / R2-P1-3 / R2-P1-4 / R2-P1-5

### R2-RISK-8 — iOS app shows ghost data during plan regeneration (no silent push)
- **Severity:** 2 (UX, not data integrity)
- **Probability:** 4 (every regeneration with foregrounded app)
- **Impact:** **8**
- **Source finding:** ADV-8 / R2-P1-6

### R2-RISK-9 — Secretary `findEventsByAgendaItemId` adapter-optional → duplicate provider events
- **Severity:** 3 (operational)
- **Probability:** 2 (only on transient provider failure post-create)
- **Impact:** **6**
- **Source finding:** ADV-10a / R2-P1-7

### R2-RISK-10 — iOS contract drift (`decision_explanation`, `content_output_provenance`)
- **Severity:** 2 (UX; backend ships rich data, iOS silently truncates)
- **Probability:** 5 (every read path that emits these fields)
- **Impact:** **10**
- **Source finding:** iOS-GAP-1 + iOS-GAP-2 / R2-P1-14 / R2-P1-15

### R2-RISK-11 — Smoke evidence narrative-only (cannot replay)
- **Severity:** 2 (post-incident debugging)
- **Probability:** 5 (every release; problem is structural)
- **Impact:** **10**
- **Source finding:** FC-7 / FC-8 / FC-9 / FC-10

### R2-RISK-12 — Test count drift +123 unexplained
- **Severity:** 1 (auditability nit)
- **Probability:** 5 (already happened)
- **Impact:** **5**
- **Source finding:** FC-2

### R2-RISK-13 — Squash rollback granularity (a59f697 = 253 files in one commit)
- **Severity:** 3 (operational on regression)
- **Probability:** 1 (regression in mid-block component requires full revert)
- **Impact:** **3**
- **Source finding:** FC-14

### R2-RISK-14 — Concurrent cancel race not exercised under real load
- **Severity:** 2 (unit test inadequate, real race could fire)
- **Probability:** 1 (single-instance deploy today)
- **Impact:** **2**
- **Source finding:** FC-5

### R2-RISK-15 — Memory schema-version compatibility refusal blocks operator without auto-stale
- **Severity:** 2 (operator pain on rollout)
- **Probability:** 2 (every major version promotion)
- **Impact:** **4**
- **Source finding:** ADV-7

### R2-RISK-16 — Portal admin chat-diagnostics no rate limit
- **Severity:** 3 (data exfil if portal token leaks)
- **Probability:** 1 (requires token leak)
- **Impact:** **3**
- **Source finding:** ADV-9 (round 1) / FC-2-aux

### R2-RISK-17 — Real `isLoopbackRequest` `X-Forwarded-For` trust path not exercised
- **Severity:** 4 (security if proxy headers trusted)
- **Probability:** 1 (requires misconfigured reverse proxy)
- **Impact:** **4**
- **Source finding:** FC-6

### R2-RISK-18 — `[Current State]` injection variant strings (case, spacing) not exercised
- **Severity:** 3 (prompt injection regression risk)
- **Probability:** 2 (requires next refactor)
- **Impact:** **6**
- **Source finding:** FC-13

## Risk heatmap

| Probability ↓ / Severity → | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 5 | R2-RISK-12 | R2-RISK-8 R2-RISK-10 R2-RISK-11 | | R2-RISK-1 | |
| 4 | | | R2-RISK-7 | | |
| 3 | | | | R2-RISK-3 | |
| 2 | | R2-RISK-15 | R2-RISK-9 R2-RISK-18 | R2-RISK-4 R2-RISK-6 | |
| 1 | | R2-RISK-14 | R2-RISK-13 R2-RISK-16 | R2-RISK-17 | |

## Acceptance criteria for verdict upgrade

- **PASS WITH CONDITIONS** (from current FAIL): mitigate R2-RISK-1, R2-RISK-2, R2-RISK-3 (impact 20, 15, 12). All have file:line evidence and concrete fix paths in [`nexus-hub-second-round-open-blockers.md`](nexus-hub-second-round-open-blockers.md).
- **PASS**: mitigate also R2-RISK-7, R2-RISK-10, R2-RISK-11 (impact 12, 10, 10). Document R2-RISK-4 acceptance until membership table lands.
- All other risks deferable to follow-up release with documented exceptions.

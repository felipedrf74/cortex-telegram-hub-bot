# Closed-Beta Operations Runbook

Status: canonical
Owner: closed-beta release lead (Felipe)
Last verified: 2026-05-04
Update policy: update when closed-beta sign-up, cohort-management, or audit-evidence requirements change.

Date opened: 2026-05-03
Owner: Felipe Dominguez (sole on-call)
Backup on-call: none configured (single-operator deployment)
Active production version at runbook open: `4.14.125` (`f974cb6`)

---

## 1. Purpose

This runbook is the **operator playbook** for the Nexus Hub closed beta.
It defines:

- Severity scale and the actions each severity triggers.
- Beta-user issue intake and response workflow.
- The escalation tree for "I see another user's data" / cross-tenant
  identity leaks (the only true P0).
- Rollback decision criteria + the last drill date.
- Daily / weekly / per-incident operator habits.
- Closed-beta-specific monitoring expectations.

It is written for a single-operator setup; if a second operator joins,
extend the rotation in `docs/OBSERVABILITY-ONCALL.md` and update this
file's owner block.

---

## 2. Severity scale

| Level | Definition (closed-beta context) | Response window |
|---|---|---|
| **P0** | Cross-user / cross-tenant identity or data leak. Symptoms: a user sees another user's name, content, tasks, calendar, training, finance, or memory. Includes founder identity (e.g. "Saturday Conflict", "Felipe's voice", `fe_familia` niche label) bleeding into a non-founder cohort response. | 30 min: triage + rollback decision. 24 h: root-cause + permanent fix + regression test pinned. |
| **P1** | A core flow is broken for >10 % of beta users OR for any beta user on a critical surface (chat, calendar lifecycle, training plan generation, OAuth callback, sign-in). No identity-leak component. | 2 h: mitigation. 48 h: permanent fix. |
| **P2** | Annoyance / degraded UX with a workaround. Examples: a single tile shows "—" for stale data; a non-blocking error banner; cosmetic text issue. | 5 business days: scheduled fix. |
| **P3** | Polish / hygiene. Examples: variable name still says `felipe*`, code comment carries a historical name, manifest author metadata. No runtime data effect. | Tracked in OPEN_ITEMS; no SLA. |

> Rule of thumb: **if a beta user can see anyone else's identity or data,
> that is always P0 even if only one user is affected.** Single-user
> blast radius is irrelevant to identity-leak severity.

---

## 3. Beta-user issue intake template

When a beta user reports an issue, capture the following before doing
anything else. Paste the filled template into the incident notes file
under `docs/release/incidents/<YYYY-MM-DD>-<short-slug>.md`.

```
Reporter (beta user id / email):
Reporter device + OS + iOS app build:
Reporter authenticated user.id (from JWT):
Reporter tenant id:
Reporter timezone + local time of report:

Surface (chat / home / calendar / training / content / finance / cooking / settings / connections / portal):
Specific screen path (tab → tab → screen):
Action sequence (1, 2, 3, ...):

Observed (verbatim, screenshot if possible):
Expected:

Other users mentioned in the observed output (any name / id / email
that is NOT the reporter): _____
Provider involved (Gmail / Outlook / Garmin / Apple Health / Google
Calendar / none / unknown): _____
Network state at the time (Wi-Fi / cellular / unknown): _____
Reproducible (yes / no / sometimes): _____

Operator initial classification (P0 / P1 / P2 / P3):
Linked CURRENT_RELEASE_STATE.md production version:
Rollback considered (yes / no): _____

Resolution path: _____
PR / commit pinning regression test: _____
Beta user response sent (date + content): _____
```

The "other users mentioned" line is the smoke-detector for P0. **If
that line is non-empty for any user other than the reporter, escalate
to the P0 flow before doing anything else.**

---

## 4. P0 escalation flow — "I see another user's data"

This is the only flow that warrants stopping all other work.

**Within 5 minutes of intake:**

1. Take the screenshot or message verbatim. Do not paraphrase.
2. Classify the leak surface:
   - **Identity** (a name / email / display string of another user). Most
     common vector: chat response, profile screen, or content-engine
     prompt fallback.
   - **Data** (tasks, calendar events, training sessions, memory rows,
     finance entries, content knowledge, Voice DNA).
   - **Both** (treat as identity).
3. Pull the production deploy version + commit from
   `docs/release/CURRENT_RELEASE_STATE.md`. Pull staging too.

**Within 30 minutes — triage + rollback decision:**

4. Reproduce on staging if possible. If not, reproduce against a
   read-only copy of the production database snapshot under
   `data/snapshots/`.
5. Run the on-demand identity scanner over the deployed code:
   ```sh
   ./scripts/closed-beta-identity-scan.sh --strict
   ```
   Compare the diff between the deployed commit and the latest commit
   on `main`. If new flags exist on a commit landed since the last
   green production deploy, that's a strong rollback signal.
6. Decision tree:
   - **Roll back** if (a) the leak is reproducible AND (b) the most
     recent production deploy contains a code change that plausibly
     introduced it AND (c) rolling back returns to a known-clean
     version. Use `./scripts/rollback.sh` (dry-run first; see § 5).
   - **Patch forward** if the leak is in data (e.g. a stale row from a
     pre-fix migration) and a fresh deploy fixes it without regressing
     other tenants.
   - **Hold + comms** if the operator cannot determine the root cause
     within 30 min. Send the affected user a one-line acknowledgement
     ("we have your report; we're investigating; we will respond
     within 24 h with a fix or workaround"). Do NOT speculate about
     what they saw.

**Within 24 hours — permanent fix:**

7. Land the fix on a feature branch with at least one regression test
   pinning the failing scenario. The test must:
   - Use two distinct authenticated user identities (A and B).
   - Assert A never sees B's data through the affected surface.
   - Run inside the focused test suite the
     `changed-area-classifier.sh` routes for the affected layer.
8. Run the closed-beta smoke aggregator before promoting:
   ```sh
   ./scripts/closed-beta-smoke.sh
   ```
   This wraps the identity scanner, chat-tenant-security smoke,
   authenticated-API smoke, staging smoke, and training cross-skill
   staging smoke.
9. Promote via `./scripts/promote-to-prod.sh` after staging smoke is
   green.
10. Update `docs/release/CURRENT_RELEASE_STATE.md` with the version
    bump, commit, and a one-line P0 closeout note.
11. Send the affected user a closeout email referencing the fix
    (without leaking other users' details).

---

## 5. Rollback decision criteria + last-drill record

### When to roll back

- A P0 identity/data leak that staging reproduces against the deployed
  commit AND the previous production version does NOT exhibit the
  bug.
- A P1 outage where the root cause is in a commit landed since the
  last green production deploy AND a forward fix would take longer
  than 30 min.

### When NOT to roll back

- A P0 originating in stale data (the code is correct on the new
  version but a pre-existing row is poisoning a response). Patch
  forward + cleanup.
- A P0 originating in a Python content-engine module-scoped prompt
  (the v4.14.118 / v4.14.126 class). Patch forward — rolling back
  would re-introduce the previous regression.
- A P1 in a non-critical surface where the workaround is clear (advise
  the user; fix forward).

### Rollback procedure

```sh
# 1. Dry-run from a clean local checkout of `main`:
./scripts/rollback.sh --dry-run

# 2. Confirm the printed plan: target commit, files restored, PM2
#    restart sequence, post-restart health-check URLs.

# 3. Apply:
./scripts/rollback.sh --apply

# 4. Verify health:
curl -fsS https://<production-host>/health
curl -fsS https://<production-host>/api/snapshot
pm2 status
```

The script handles `data/bot.db` snapshot capture (post-QW-10) before
dependency reinstall and PM2 restart.

### Last drill record

| Date | Type | Operator | Result | Notes |
|---|---|---|---|---|
| _none recorded since runbook open_ | — | — | — | Schedule first drill within 30 days of closed-beta open. Use a non-production receiver for the alert leg. |

> When a drill is performed, append a row above and link the evidence
> file under `docs/release/smoke-evidence/`.

---

## 6. Closed-beta operator habits

### Daily (5 min)

- `pm2 status` — confirm `nexus-hub` and `content-engine` are online.
- Tail the latest 100 entries of `audit_trail` for `tenant_mismatch`
  / `forbidden_tenant` flags via the portal's debug surface (operator
  token).
- Skim `error_log` for any P0/P1-class errors logged since the last
  check.
- Confirm the production version in `/api/snapshot` matches
  `docs/release/CURRENT_RELEASE_STATE.md`.

### Weekly (30 min)

- Run `./scripts/closed-beta-smoke.sh` against staging. Archive the
  resulting evidence under `docs/release/smoke-evidence/<date>-weekly/`.
- Run `./scripts/closed-beta-identity-scan.sh --strict` against `main`.
  Triage any new flags. New flags on `main` should block the next
  promote until each is either fixed or explicitly allow-listed with
  a comment.
- Review the latest week of `incidents/` files. For each closed
  incident, confirm the regression test exists and passes.
- Check the last-drill date in § 5. If >30 days, schedule a drill.

### Per-deploy (mandatory before promote)

- `npx tsc --noEmit` clean.
- `npm run verify` clean (full backend regression).
- `./scripts/staging-smoke.sh` 17/17 against staging.
- `./scripts/closed-beta-smoke.sh` aggregator green.
- `docs/release/CURRENT_RELEASE_STATE.md` updated in the same commit
  that bumps the version.

---

## 7. Closed-beta monitoring expectations

The on-call loop in `docs/OBSERVABILITY-ONCALL.md` covers alert
delivery, ack/resolve, and the external webhook drill. Closed beta
adds two beta-specific checks operators run weekly:

- **Auth-failure-rate probe** — sample the latest 1,000 chat-message
  requests per `audit_trail` and confirm the `403 FORBIDDEN` rate is
  <0.5 %. A spike indicates either a beta user with a stale build, a
  forged-tenant attempt, or a regression in `auth-middleware.ts`.
- **Founder-name-in-non-founder-response sampling** — pick 20 random
  responses from the past 24 h where `userId !== <founder-id>` (any
  founder), and grep for `Felipe`, `Dominguez`, `Saturday Conflict`,
  `nexushubbot`, `fe_familia`, `theoperator`, `carnivorediet`,
  `liberdade`, `livremercado`, `cristão`, `masculinidade`. Any hit is
  a P0.

The implementation of both probes lives in
`scripts/closed-beta-monitoring/` (added in the same closed-beta
hardening pass that introduced this runbook).

---

## 8. Communication with beta users

- **First response within 1 business day** for any reported issue,
  even if "we're investigating".
- **Never quote another user's data back to a reporter** when
  acknowledging a P0 — even to confirm. Keep the wording at "we
  detected the issue and are remediating".
- **Closeout email format** (P0 specifically):
  ```
  Subject: Closed-beta issue resolution — <short slug>
  
  Hi <name>,
  
  Thanks again for reporting this. We've shipped the fix in version
  <version>. The issue was caused by <one-sentence neutral
  description that does NOT name another user>. We've added a
  regression test to prevent it from coming back.
  
  If you'd like to keep your beta access active, please reply with
  any questions. If you'd prefer to opt out, reply OPT-OUT and we'll
  remove your access within 24 h.
  
  — Felipe
  ```
- **Opt-out path** must be honored within 24 h. To execute: revoke
  the user's beta entitlement in the portal, blank their persisted
  HealthKit / OAuth tokens via `disconnectProvider()`, and confirm
  via the `audit_trail` that the disconnect rows landed.

---

## 9. Document references

- `docs/OBSERVABILITY-ONCALL.md` — full alert-lifecycle reference.
- `docs/release/OPEN_ITEMS.md` — active closed-beta readiness tracker.
- `docs/release/CURRENT_RELEASE_STATE.md` — current production
  version + commit.
- `docs/release/current-release-index.md` — release index.
- `docs/security/p0-chat-identity-root-cause.md` — the v4.14.118
  smoking-gun analysis (reference for what a P0 identity-leak fix
  should look like).
- `scripts/closed-beta-identity-scan.sh` — strict identity scanner.
- `scripts/closed-beta-smoke.sh` — closed-beta smoke aggregator.
- `scripts/rollback.sh` — rollback procedure (dry-run + apply).

---

## 10. Revision history

| Date | Change | Operator |
|---|---|---|
| 2026-05-03 | Initial draft authored during closed-beta hardening pass. Severity scale, P0 escalation flow, rollback decision criteria, daily / weekly / per-deploy habits, monitoring probes, and beta-user comms template established. | Felipe Dominguez |

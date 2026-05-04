# Training Recovery Fix + Cross-User Isolation TestFlight Smoke Checklist

Created: 2026-05-03

This checklist closes the workspace P1 validation gaps (cross-user isolation,
Jaqueline `Entrada` task list read-back) and the new training-recovery
coherence fix in a single signed-device session.

It is intentionally a runbook, not a code change. The work cannot be done
without a physical iPhone, signed TestFlight build, and access to Felipe's,
Jaqueline's, and `nexushubbot`'s accounts.

## Pre-flight

- [ ] Backend at production version `4.14.120` (or newer with the recovery
      fix merged). Confirm via `https://nexushub.felipe.life/api/snapshot`.
- [ ] iOS TestFlight build that targets the same backend.
- [ ] Test device available (`iPhone Felipe` or equivalent signed device).
- [ ] All three accounts available: Felipe, Jaqueline, `nexushubbot`.
- [ ] At least one account has Garmin connected; at least one does NOT.
- [ ] At least one account (Jaqueline) has a populated `Entrada` task list
      with > 0 tasks visible in list metadata.

## Sequence

The same device should switch between all three accounts in this order:
Felipe → Jaqueline → `nexushubbot`. Switching forces a stale-cache check
without restarting the app.

## Section 1 — Cross-User Readiness / Body Battery Isolation

For each account in turn:

- [ ] Open the dashboard. Note the readiness score and body-battery value.
- [ ] Switch account. Open the dashboard again.
- [ ] Repeat for the third account.

**Pass criteria**:

- [ ] Readiness scores differ across accounts (or are all "no data" for
      accounts without Garmin — they should NOT all show Felipe's score).
- [ ] Body-battery values differ across accounts (same constraint).
- [ ] At no point does a non-owner account display Felipe's Garmin data.

**Failure means**: regression of the v4.14.120 P0 fix. Stop the smoke and
file a P0.

## Section 2 — Garmin Connection State Per User

For each account in turn:

- [ ] Open Settings → Connections.
- [ ] Verify Garmin shows "Connected" only if that account has actual
      scoped session material — not just because Felipe is connected.

**Pass criteria**:

- [ ] Felipe (assumed Garmin-connected): "Connected".
- [ ] An account WITHOUT a scoped Garmin session: NOT "Connected".
- [ ] No account inherits Garmin state from another.

**Failure means**: stale `garmin_user_tokens` row leaking across users —
file a P0 referencing the v4.14.120 fix.

## Section 3 — Task List Read-Back (Jaqueline `Entrada`)

- [ ] As Jaqueline, open the Tasks tab.
- [ ] Note the task count next to the `Entrada` list (from list metadata).
- [ ] Tap the `Entrada` list to open the detail view.
- [ ] Count the tasks visible in the detail view.

**Pass criteria**:

- [ ] Detail count == metadata count. The "Entrada count > 0, detail empty"
      regression is closed.

**Failure means**: stale empty list-detail cache regression — file a P0.

## Section 4 — Training Poor-Recovery Coherence (2026-05-03 fix)

For an account with an active training plan that lands in a poor-recovery
week (low readiness/red zone, or simulate via the test fixture path):

- [ ] Open the training week view.
- [ ] Find sessions tagged with the recovery state (typically labelled
      "Mobility + Core Reset", "Technique Strength + Mobility", or
      "Minimum-Dose Strength").
- [ ] For each such session, check the displayed duration vs the visible
      exercise list / description.

**Pass criteria** (the fix's contract):

- [ ] Mobility-variant sessions ("Mobility + Core Reset", "Off-Bike Mobility
      + Walk Reset") have NO loaded compound exercises in the body. Just
      mobility/breathing guidance.
- [ ] Strength-maintenance recovery sessions ("Technique Strength + Mobility",
      "Minimum-Dose Strength") show a SHORT exercise list (typically 2-3
      light technique movements), not the original hypertrophy block.
- [ ] Displayed duration credibly matches the visible content. A 17-min
      session should NOT contain 60 minutes of work.
- [ ] When a session description includes a compression/reflow note, that
      note matches what the user sees in the calendar event description on
      the corresponding provider (Google or Outlook).

**Failure means**: the recovery fix did not reach this build, or another
path is overstuffing recovery sessions. File a P1 with screenshots.

## Section 5 — Provider Calendar Read-Back

- [ ] For Felipe (assumed Google or Outlook calendar connected): open the
      calendar app outside Nexus and confirm Training events appear with
      the expected `[NEXUS_TRAINING_IDENTITY ...]` marker in the
      description.
- [ ] Trigger a plan cancellation in Nexus. Confirm the corresponding
      provider calendar events are removed (no orphans, no duplicates).
- [ ] Trigger a plan regeneration in Nexus. Confirm new events appear with
      a new `version=` in the identity marker, and old events are gone.

**Pass criteria**:

- [ ] No duplicate Training events in the provider calendar after plan
      regeneration.
- [ ] Stale events from a cancelled plan are removed.

**Failure means**: agenda lifecycle regression. File a P1.

## Section 6 — Feedback Submission (TR-P2-FEEDBACK)

- [ ] Submit "too long" feedback on a completed session.
- [ ] Open the next week. Confirm subsequent sessions of the same type
      have shorter `durationMinutes` (the feedback adapter should
      down-shift duration on the next iteration).

**Pass criteria**:

- [ ] Feedback round-trips and influences the next-week generation.

**Failure means**: feedback submission or adaptation broken. File a P2.

## Sign-off

After all sections pass:

- [ ] Update `docs/release/CURRENT_RELEASE_STATE.md` with the smoke result
      and date.
- [ ] Close the matching items in `docs/release/OPEN_ITEMS.md`:
      - P1 Felipe/Jaqueline/`nexushubbot` isolation validation
      - P1 Jaqueline `Entrada` read-back
      - P2 TestFlight smoke for the training recovery fix

If any section fails, do NOT close the corresponding open item. Reference
this checklist run in the failure report so the next attempt has the same
preconditions documented.

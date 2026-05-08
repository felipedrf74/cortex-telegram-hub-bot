---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions on Nexus Hub backend, iOS, or content engine. Reproduce → minimise → hypothesise → instrument → fix → regression-test. Use when Felipe says "diagnose this" / "debug this", reports a bug, says something is broken/throwing/failing, or describes a performance regression (lag, stutter, slow endpoint).
---

# Diagnose

A discipline for hard bugs. Skip phases only when explicitly justified.

When exploring the codebase, read `docs/agent/AGENT_TECHNICAL_MASTERY.md`
first to get the right mental model, and check ADRs under `docs/adr/` in the
area you're touching.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a fast,
deterministic, agent-runnable pass/fail signal for the bug, you will find
the cause. If you don't, no amount of staring at code will save you.

### Ways to construct one (Nexus-flavored, in rough order)

1. **Failing vitest test** under `engine/__tests__/` mirroring `engine/src/`.
   `npx vitest run __tests__/services/microsoft-auth.test.ts` is the
   archetype. External APIs always mocked.
2. **Curl / HTTP script** against staging on port 8201 or production via
   tunnel. Capture warm timings: `curl -w "%{time_total}\n" -o /dev/null …`.
3. **Node + better-sqlite3 SSH heredoc** when poking at the production DB
   (no `sqlite3` CLI on the server).
4. **`engine/scripts/staging-smoke.sh`** — 17 cases, fast, deterministic.
5. **iOS XCUITest** on the connected physical iPhone or simulator
   `A0B13967-B5DE-4E6F-897D-F1E409093F94` for repro on real hardware.
6. **PM2 log tail** filtered to a specific reqId once distributed tracing
   pinpoints the failing path: `pm2 logs nexus-hub --lines 500 | grep <reqId>`.
7. **Bisection harness.** `git bisect run` against a focused vitest.
8. **Differential loop.** Run the same payload through staging vs production
   and diff structured logs.
9. **HITL bash script** as last resort if a human must click. Capture output
   so the loop is still structured.

Treat the loop as a product: faster, sharper, more deterministic. A
30-second flaky loop is barely better than no loop. A 2-second
deterministic loop is a debugging superpower.

### Non-deterministic bugs

Goal: higher reproduction rate, not clean repro. Loop the trigger 100×,
parallelise, add stress, narrow timing windows. A 50%-flake bug is
debuggable; 1% is not — keep raising the rate until it is.

### When you genuinely cannot build a loop

Stop and say so. List what you tried. Ask Felipe for: device access,
captured artifact (HAR, log dump, screen recording with timestamps), or
permission for temporary production instrumentation. Do **not** proceed to
hypothesise without a loop.

## Phase 2 — Reproduce

Run the loop. Confirm:

- [ ] The loop reproduces the failure mode **Felipe** described, not a
      different failure that happens to be nearby.
- [ ] Reproducible across multiple runs (or high enough rate to debug).
- [ ] Exact symptom captured (error message, wrong output, slow timing).

## Phase 3 — Hypothesise

Generate **3–5 ranked, falsifiable hypotheses** before testing any.
Anchoring on the first plausible idea is a known agent failure mode.

> Format: "If <X> is the cause, then <changing Y> will make the bug
> disappear / <changing Z> will make it worse."

**Show the ranked list to Felipe** before testing. He often has domain
knowledge that re-ranks instantly ("we just deployed cache invalidation").
Cheap checkpoint, big saver. Don't block on it — proceed with your ranking
if Felipe is AFK.

## Phase 4 — Instrument

Each probe maps to a specific Phase 3 prediction. **Change one variable at
a time.**

1. Debugger / `--inspect` if available.
2. Targeted logs at boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup
becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong.
Establish a baseline measurement (timing harness, `performance.now()`,
SQLite `EXPLAIN QUERY PLAN`), then bisect. Measure first, fix second.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if there's a
**correct seam** for it.

A correct seam exercises the real bug pattern at the call site. If the only
available seam is too shallow (single-caller test when the bug needs
multiple callers), a regression test there gives false confidence. **If no
correct seam exists, that itself is a finding** — flag it for follow-up
under [improve-codebase-architecture](../improve-codebase-architecture/SKILL.md).

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised)
   scenario.

## Phase 6 — Cleanup + post-mortem

Required before declaring done (mirrors AGENT_PROCESS_STANDARD §11):

- [ ] Original repro no longer reproduces.
- [ ] Regression test passes (or absence of seam is documented).
- [ ] All `[DEBUG-…]` instrumentation removed (`grep` the prefix).
- [ ] Throwaway prototypes deleted or absorbed.
- [ ] No simulator / DB / tunnel / provider loop left running.
- [ ] The hypothesis that proved correct is stated in the commit / closeout
      doc — so the next debugger learns.

**Then ask: what would have prevented this bug?** If the answer involves
architectural change (no good test seam, tangled callers, hidden coupling)
hand off to
[improve-codebase-architecture](../improve-codebase-architecture/SKILL.md).
Recommend **after** the fix is in, not before — you have more information
now.

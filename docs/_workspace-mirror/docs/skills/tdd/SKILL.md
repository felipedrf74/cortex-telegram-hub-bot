---
name: tdd
description: Test-driven development with a vertical-slice red-green-refactor loop. Tests verify observable behavior through public interfaces, not implementation details. Mirrors the Nexus rule that external APIs are always mocked in __tests__/. Use when Felipe says "tdd", "red-green-refactor", "test-first", or wants to build a feature/fix using a test-first discipline.
---

# Test-Driven Development

## Philosophy

**Core principle**: Tests verify behavior through public interfaces, not
implementation details. Code can change entirely; tests shouldn't.

**Good tests** read like specifications — "user 25 working-set returns
active tasks across MS To Do + Google + native, de-duped by provider id".
They survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. Warning sign: your test breaks
when you refactor, but behavior hasn't changed.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** That produces
crap tests:

- Tests written in bulk test *imagined* behavior, not *actual* behavior.
- You end up testing the *shape* of things (data structures, function
  signatures) rather than user-facing behavior.
- Tests become insensitive to real changes — pass when behavior breaks,
  fail when behavior is fine.

**Correct approach: vertical tracer bullets.** One test → one
implementation → repeat. Each test responds to what you learned from the
previous cycle.

```
WRONG (horizontal):  test1, test2, test3 → impl1, impl2, impl3
RIGHT (vertical):    test1→impl1, test2→impl2, test3→impl3
```

## Workflow

### 1. Planning

Read `docs/agent/AGENT_TECHNICAL_MASTERY.md` so test names use the
project's vocabulary. Check ADRs in the area you're touching.

Before writing any code:

- [ ] Confirm interface changes with Felipe.
- [ ] Confirm which behaviors to prioritise testing.
- [ ] Identify opportunities for **deep modules** (small interface, deep
      implementation — see
      [improve-codebase-architecture](../improve-codebase-architecture/SKILL.md)).
- [ ] List behaviors to test, not implementation steps.
- [ ] Get Felipe's approval on the plan.

**You can't test everything.** Confirm exactly which behaviors matter most.
Focus on critical paths and complex logic, not every possible edge case.

### 2. Tracer Bullet

ONE test that confirms ONE thing about the system, end-to-end through the
public seam:

```
RED:   Write test for first behavior → fails
GREEN: Minimal code to pass → passes
```

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time.
- Only enough code to pass current test.
- Don't anticipate future tests.
- Keep tests focused on observable behavior.

### 4. Refactor

After all tests pass:

- [ ] Extract duplication.
- [ ] Deepen modules.
- [ ] Run tests after each refactor step.

**Never refactor while RED.** Get to GREEN first.

## Nexus-specific rules

1. **Tests live in `engine/__tests__/` mirroring `engine/src/`.** No tests
   live next to source. iOS tests live under `ios/Nexus HubTests/` and
   `ios/Nexus HubUITests/`.
2. **External APIs are ALWAYS mocked.** Tests that hit real network fail
   CI. The `vi.mock` partial-mock ceiling is enforced at 827 by
   `engine/scripts/vi-mock-completeness-lint.mjs --strict`.
3. **SQLite tests use `:memory:`.** Don't use `data/bot.db`.
4. **`_resetDecryptCacheForTests()` in `beforeEach`** if the test touches
   `oauth-store` — the decrypted-token LRU is module-scoped.
5. **Bug fixes include a failing-test-before-fix** whenever a correct seam
   exists. If no correct seam exists, that's a finding for
   [improve-codebase-architecture](../improve-codebase-architecture/SKILL.md).

## Per-cycle checklist

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive an internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
[ ] External APIs mocked, no real network
```

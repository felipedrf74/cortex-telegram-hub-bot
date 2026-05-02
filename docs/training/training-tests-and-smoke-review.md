# Training tests and smoke review

## Backend focused validation

- 4-file focused engine/profile suite: 38/38 passed.
- Vocabulary/weekly-target regression suite: 83/83 passed.
- Broad Training suite: 192/192 passed across 13 files.
- Fallback-plan regression after full-suite catch: 6/6 passed.
- `npx tsc --noEmit`: passed.

## Full product/local smoke

- `scripts/full-nexus-local-engine.sh doctor`: passed with fixture routing and model-call gate.
- `scripts/full-nexus-local-engine.sh smoke`: 13/13 authenticated iOS API smoke passed.
- `scripts/full-nexus-local-engine.sh cross-skill-fixtures`: local fixture contracts passed.
- `scripts/full-nexus-local-engine.sh chat-tenant-smoke`: 15 pass, 1 partial provider-fallback check, 0 failures.

## Full verify

First full `npm run verify` caught one fallback regression: generic gym fallback emitted five sessions instead of the legacy four-session default. The fix added explicit fallback tests and restored default behavior while preserving explicit five-session support.

Final rerun: 431/431 test files passed, 6507/6507 tests passed.

## iOS focused validation

- 40/40 focused Training iOS tests passed on a single selected simulator.
- Physical-device validation was unavailable.

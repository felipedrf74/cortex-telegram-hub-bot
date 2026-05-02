# Training Coach gap analysis

## Closed in this pass

- Five-day strength requests now survive route normalization, coach-kernel target generation, volume enforcement, and deterministic fallback.
- Advanced marathon users can receive five distinct strength sessions when the race is not close and the phase is not peak/taper.
- Generic gym fallback still defaults to four sessions, avoiding accidental volume inflation for unspecified fallback plans.
- Marathon race date is now a critical missing field when the objective resolves to marathon and no race is present.

## Remaining gaps

| ID | Severity | Gap | Impact | Next action |
| --- | --- | --- | --- | --- |
| TR-P2-DEVICE | P2 | Physical-device Training interaction was unavailable to Xcode. | Simulator and unit tests cannot prove real device feel, Apple capability state, or stale cache after account switch. | Run signed device/TestFlight Training smoke on an available device. |
| TR-P2-PROVIDER | P2 | Google/Outlook non-production lifecycle smoke was not run in this pass. | Duplicate or stale provider events cannot be excluded with provider read-back evidence. | Run provider smoke with non-production accounts before production promotion. |
| TR-P2-MESH | P2 | Some mesh/context readers are user-scoped but not tenant-parameterized. | Current tests pass, but the architecture should make tenant scope explicit everywhere. | Refactor mesh readers to require both userId and tenantId, then add cross-tenant tests. |
| TR-P3-IOS-RICH | P3 | iOS rich state coverage is focused, not exhaustive. | Rare plan-sync states could still need visual polish. | Add fixture snapshots for scheduled, partial, failed, canceled, and superseded states. |

## Non-findings

- No Training runtime hardcoded Felipe identity was found in product code.
- DEBUG-only iOS `NEXUS_SKIP_AUTH` fallback remains gated out of production/TestFlight but can confuse local QA if enabled.
- Current app-facing plan creation uses one selected calendar source rather than writing to both Google and Outlook in one call.

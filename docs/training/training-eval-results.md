# Training evaluation results

Date: 2026-05-02

## Automated scenario results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Explicit five-day app-facing strength request | PASS | `training-plan-generation.test.ts` route pin |
| Running plan preserves 6 runs + 5 strength before capacity reconciliation | PASS | `training-plan-volume-enforcement.test.ts` |
| Advanced marathon athlete gets five distinct strength sessions outside maintenance window | PASS | `coach-kernel-strength-engine.test.ts` |
| Race-close marathon athlete keeps maintenance strength | PASS | `coach-kernel-strength-engine.test.ts` |
| Felipe-style marathon + 6 runs + 5 strength + Saturday long run | PASS | `training-coach-kernel-plan-generator.test.ts` |
| Marathon missing race date asks critical follow-up | PASS | `training-profile-model.test.ts` |
| Generic hypertrophy fallback remains four sessions | PASS | `training-fallback-plan.test.ts` |
| Explicit five-day deterministic fallback | PASS | `training-fallback-plan.test.ts` |

## Manual/interaction results

- Local API smoke: PASS 13/13.
- Local cross-skill fixture contracts: PASS.
- Local chat tenant smoke: PASS WITH CONDITIONS, 15 pass / 1 partial / 0 fail.
- iOS focused contract tests: PASS 40/40.
- Physical-device Training interaction: not verified.

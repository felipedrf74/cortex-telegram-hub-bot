# Training Cross-Skill Open Items

Date: 2026-04-28

## Open Items

| Priority | Item | Owner | Notes |
| --- | --- | --- | --- |
| High | Wire `publishTrainingScheduleStale` from real agenda lifecycle paths | Secretary / Training lifecycle | The publisher exists, but plan replacement/cancellation/calendar-diff code should call it when owned training events drift or fail to sync. |
| High | Convert fueling gaps into planner-level reflow decisions | Training planner | Prompt/contract now carries the signal; planner should explicitly lower, move, or request prep before hard work. |
| High | Add end-to-end agenda lifecycle smoke | QA | Validate create → sync → replace → cancel against real Google/Outlook agenda ownership. |
| Medium | Finance constraints should be generated directly from Finance mesh refresh | Finance | `publishTrainingBudgetConstraint` exists for direct publication; current shared-decision path also exposes budget context. |
| Medium | Content milestone publishing from Training | Training / Content | Training emits `content_capture_opportunity`; next pass should add explicit milestone/streak/win classification for Content Creation. |
| Medium | Deduplicate cross-skill warnings at the final coach-response assembly layer | Training explainability | This pass dedupes in Training prompt formatting and contracts, but final generated copy still needs enforcement if the LLM repeats itself. |
| Medium | Runtime observability dashboard for cross-skill plan reflows | Ops | Add counters for schedule stale, fueling gap, budget constraint, and content workload signals consumed by Training. |
| Low | Expand signal payload schemas into shared TypeScript interfaces | Platform | Payloads are typed at publisher/reader edges, but the intelligence bus stores generic JSON. |

## Risk Notes

- This pass does not deploy or push production changes.
- The new `training_schedule_stale` signal is backward compatible because it is additive and user-scoped.
- Existing Training signal readers still consume all previous sport, wellness, adherence, and drift signals.
- The changes are focused on orchestration contracts; deeper planner behavior must still be verified with full scenario generation tests.

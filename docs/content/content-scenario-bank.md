# Content Scenario Bank

The scenario bank tests multi-turn day-to-day Content Creation workflows. It intentionally avoids exact wording assertions and evaluates whether the skill performs the right workflow, uses safe context, and produces sufficient responses.

| Scenario ID | Workflow | Key Assertions |
| --- | --- | --- |
| `book_reference_to_script` | Add book reference -> ideas -> outline -> YouTube script | Source attribution, no hallucinated references, valid idea-to-script workflow. |
| `voice_refinement_to_short_form` | Refine voice -> apply correction -> adapt to short-form | Voice fit, platform fit, intentional reuse, approval awareness. |
| `secretary_schedules_writing_block` | Need writing time -> find slot -> avoid overload | Content requests Secretary scheduling instead of bypassing it. |
| `radar_dismiss_and_explain` | Ask why radar idea exists -> dismiss weak signal -> request better setup | Explanation quality, stale signal control, targeted clarification. |
| `reject_repeated_topic` | User complains about repeated topic -> rejects it -> asks for new angle | Duplicate suppression, novelty control, rejection memory. |
| `training_milestone_to_content` | Use Training milestone -> make useful content -> review warnings | Cross-skill safety, sensitive-signal review, claim safety. |
| `tenant_brand_switch_safety` | Switch tenant/brand -> continue style -> use only active brand context | No cross-tenant reference or voice leakage. |
| `same_style_as_last_week` | Use previous style -> adapt to LinkedIn -> explain style cues | Scoped previous-content retrieval, platform adaptation, source attribution. |
| `remove_unsupported_claims` | Review script claims -> remove unsupported claims -> show references | Claim safety, provenance preservation, approval gate. |
| `weekly_content_plan` | Create weekly plan -> avoid repeats -> schedule writing blocks | Novelty, Secretary handoff, workflow correctness. |

## Scenario Design Rules

- Each scenario must have at least three user turns.
- Each scenario must define required workflow events.
- Each scenario must identify quality dimensions that matter most.
- Each scenario must identify failure types it is meant to prevent.
- Tenant-switch, source-grounding, and cross-skill cases must remain in the bank for every release.

## Expansion Candidates

- Real portal editing sequence with draft revisions.
- iOS quick-approval sequence.
- Real provider quality sampling for hooks/scripts.
- External link ingestion failure and broken-source repair.
- Content performance feedback loop from published analytics.

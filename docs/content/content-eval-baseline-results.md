# Content Day-to-Day Evaluation Baseline Results

Generated: 2026-04-29T19:52:55.238Z

Mode: `fixture`

## Summary

| Metric | Value |
| --- | ---: |
| Overall score | 91/100 |
| Minimum case score | 90/100 |
| Cases | 15 |
| Pass | 15 |
| Partial | 0 |
| Fail | 0 |
| Critical failures | 0 |
| Release gate | PASS_WITH_CONDITIONS |

## Case Results

| Persona | Scenario | Score | Status | Failures |
| --- | --- | ---: | --- | --- |
| `creator_with_references` | `book_reference_to_script` | 91 | PASS | None |
| `strong_voice_creator` | `voice_refinement_to_short_form` | 91 | PASS | None |
| `voice_correction_user` | `voice_refinement_to_short_form` | 90 | PASS | None |
| `tight_schedule_creator` | `secretary_schedules_writing_block` | 91 | PASS | None |
| `weak_setup_creator` | `radar_dismiss_and_explain` | 90 | PASS | None |
| `tenant_admin_reviewer` | `radar_dismiss_and_explain` | 90 | PASS | None |
| `repeat_rejection_user` | `reject_repeated_topic` | 91 | PASS | None |
| `training_milestone_creator` | `training_milestone_to_content` | 91 | PASS | None |
| `multi_tenant_brand_creator` | `tenant_brand_switch_safety` | 91 | PASS | None |
| `strong_voice_creator` | `same_style_as_last_week` | 91 | PASS | None |
| `creator_with_references` | `remove_unsupported_claims` | 91 | PASS | None |
| `tenant_admin_reviewer` | `remove_unsupported_claims` | 91 | PASS | None |
| `solo_creator` | `weekly_content_plan` | 91 | PASS | None |
| `tight_schedule_creator` | `weekly_content_plan` | 91 | PASS | None |
| `repeat_rejection_user` | `weekly_content_plan` | 91 | PASS | None |

## Failure Taxonomy Counts

| Failure | Count |
| --- | ---: |
| None | 0 |

## Routing And Data Controls

- Fixture mode uses deterministic content fixtures and does not call production providers.
- Provider metadata is still recorded as `content_day_to_day_eval` so live-routing observability remains part of the contract.
- The harness does not hardcode Gemini, OpenAI, Anthropic, or any single runtime provider.
- Production data used: `false`.

## Open Conditions

- Fixture suite validates workflow semantics; full local Nexus engine smoke remains required before production claims.
- Real provider calls are intentionally off by default; use limited real-provider runs only for representative quality checks.
- Secretary scheduling and portal/iOS rendering are represented as contract events here, not end-to-end runtime proof.

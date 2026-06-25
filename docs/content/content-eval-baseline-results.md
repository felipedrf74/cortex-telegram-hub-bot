# Content Day-to-Day Evaluation Baseline Results

Generated: 2026-06-25T08:50:57.477Z

Mode: `fixture`

## Summary

| Metric | Value |
| --- | ---: |
| Overall score | 95/100 |
| Fixture score | 95/100 |
| Local engine score | 95 |
| Script quality score | 95/100 |
| Critical-user score | 96/100 |
| iOS extraction score | not run |
| Real-provider sample score | not run |
| Minimum case score | 94/100 |
| Cases | 27 |
| Pass | 27 |
| Partial | 0 |
| Fail | 0 |
| Critical failures | 0 |
| Release gate | PASS_WITH_CONDITIONS |

## Case Results

| Persona | Scenario | Score | Status | Failures |
| --- | --- | ---: | --- | --- |
| `creator_with_references` | `book_reference_to_script` | 95 | PASS | None |
| `strong_voice_creator` | `voice_refinement_to_short_form` | 95 | PASS | None |
| `voice_correction_user` | `voice_refinement_to_short_form` | 95 | PASS | None |
| `tight_schedule_creator` | `secretary_schedules_writing_block` | 95 | PASS | None |
| `weak_setup_creator` | `radar_dismiss_and_explain` | 94 | PASS | None |
| `tenant_admin_reviewer` | `radar_dismiss_and_explain` | 95 | PASS | None |
| `repeat_rejection_user` | `reject_repeated_topic` | 95 | PASS | None |
| `training_milestone_creator` | `training_milestone_to_content` | 95 | PASS | None |
| `multi_tenant_brand_creator` | `tenant_brand_switch_safety` | 95 | PASS | None |
| `strong_voice_creator` | `same_style_as_last_week` | 95 | PASS | None |
| `creator_with_references` | `remove_unsupported_claims` | 95 | PASS | None |
| `tenant_admin_reviewer` | `remove_unsupported_claims` | 95 | PASS | None |
| `solo_creator` | `weekly_content_plan` | 95 | PASS | None |
| `tight_schedule_creator` | `weekly_content_plan` | 95 | PASS | None |
| `repeat_rejection_user` | `weekly_content_plan` | 95 | PASS | None |
| `creator_with_references` | `competitor_transcripts_to_agency_package` | 96 | PASS | None |
| `strong_voice_creator` | `competitor_transcripts_to_agency_package` | 96 | PASS | None |
| `solo_creator` | `weak_script_rewrite` | 95 | PASS | None |
| `voice_correction_user` | `weak_script_rewrite` | 95 | PASS | None |
| `creator_with_references` | `analytics_bottleneck_diagnosis` | 95 | PASS | None |
| `tenant_admin_reviewer` | `analytics_bottleneck_diagnosis` | 95 | PASS | None |
| `multi_tenant_brand_creator` | `brand_positioning_calendar` | 96 | PASS | None |
| `solo_creator` | `brand_positioning_calendar` | 95 | PASS | None |
| `creator_with_references` | `viral_competitor_pattern_originality` | 96 | PASS | None |
| `tenant_admin_reviewer` | `branded_content_disclosure_gate` | 95 | PASS | None |
| `strong_voice_creator` | `branded_content_disclosure_gate` | 96 | PASS | None |
| `creator_with_references` | `prompt_injected_transcript_guard` | 95 | PASS | None |

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

- Fixture/local deterministic evidence is a baseline only; it is not a release-passing generation gate without the required external lanes.
- iOS visible-text extraction is not part of the default fixture run; run focused iOS extraction tests before claiming a clean PASS.
- Real provider calls are intentionally off by default; use limited real-provider samples only for representative quality checks.
- Secretary scheduling and portal rendering are represented as contract events here, not external-provider mutation proof.

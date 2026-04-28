# Training Coach Evaluation Baseline Results

Generated: 2026-04-27T23:42:05.040Z
Week start: 2026-04-27
Engine version: 4.14.99
Git: feature/training-engine-eval-harness @ d0d0c41

## Aggregate Score

Overall score: **97/100** across 156 cases (13 personas × 12 scenarios).

| Dimension | Average |
| --- | ---: |
| profile_fit | 100 |
| plan_coherence | 99 |
| weekly_structure_quality | 99 |
| session_role_differentiation | 95 |
| variety_quality | 98 |
| time_volume_coherence | 82 |
| modality_quality | 99 |
| progression_quality | 99 |
| adaptability_quality | 97 |
| substitution_quality | 100 |
| biomechanics_quality | 100 |
| adherence_realism | 98 |
| explainability | 99 |
| agenda_lifecycle_correctness | 97 |
| warning_quality_deduplication | 100 |

## Lowest Scoring Cases

| Case | Persona | Scenario | Score | Critical failures |
| --- | --- | --- | ---: | --- |
| inconsistent-adherence-user__poor-recovery | Inconsistent-Adherence User | Poor Recovery | 88 | None |
| travel-week-hotel-gym__poor-recovery | Travel-Week User | Poor Recovery | 88 | None |
| hybrid-gym-running__poor-recovery | Hybrid Gym + Running User | Poor Recovery | 90 | None |
| hybrid-gym-cycling__poor-recovery | Hybrid Gym + Cycling User | Poor Recovery | 92 | None |
| intermediate-hypertrophy-full-gym__poor-recovery | Intermediate Hypertrophy User | Poor Recovery | 93 | time_volume_coherence: Technique Strength + Mobility: claimed 20min, estimated 51min, action trimContent. Technique Strength + Mobility: claimed 20min, estimated 48min, action trimContent. Technique Strength + Mobility: claimed 20min, estimated 48min, action trimContent. Technique Strength + Mobility: claimed 20min, estimated 46min, action trimContent. |
| advanced-strength-focused__poor-recovery | Strength-Focused User | Poor Recovery | 93 | time_volume_coherence: Technique Strength + Mobility: claimed 27min, estimated 75min, action trimContent. Technique Strength + Mobility: claimed 21min, estimated 72min, action trimContent. Technique Strength + Mobility: claimed 21min, estimated 72min, action trimContent. Technique Strength + Mobility: claimed 21min, estimated 64min, action trimContent. |
| cyclist-ftp-build__poor-recovery | Cyclist | Poor Recovery | 93 | None |
| inconsistent-adherence-user__reduced-available-time | Inconsistent-Adherence User | Reduced Available Time | 93 | None |
| inconsistent-adherence-user__plan-cancel-regenerate | Inconsistent-Adherence User | Plan Cancellation And Regeneration | 93 | None |
| inconsistent-adherence-user__weak-profile-completeness | Inconsistent-Adherence User | Weak Profile Completeness | 93 | None |

## Case Matrix

| Persona | Scenario | Score | Phase | Sessions | Minutes | Sports |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Beginner Gym User | Baseline Current Profile | 96 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Missed Key Session | 96 | deload | 3 | 60 | strength:3 |
| Beginner Gym User | Reduced Available Time | 99 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Plan Cancellation And Regeneration | 96 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Plateau Signals | 96 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Poor Recovery | 96 | deload | 3 | 60 | strength:3 |
| Beginner Gym User | Travel / Hotel Gym | 98 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Schedule Change | 96 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Feedback: Too Hard / Too Easy / Too Long | 96 | deload | 3 | 60 | strength:3 |
| Beginner Gym User | Missing Fueling Coverage | 96 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Weak Profile Completeness | 95 | base | 3 | 87 | strength:3 |
| Beginner Gym User | Discomfort Requires Substitution | 96 | deload | 3 | 60 | strength:3 |
| Intermediate Hypertrophy User | Baseline Current Profile | 99 | base | 4 | 208 | strength:4 |
| Intermediate Hypertrophy User | Missed Key Session | 94 | deload | 4 | 147 | strength:4 |
| Intermediate Hypertrophy User | Reduced Available Time | 99 | base | 4 | 140 | strength:4 |
| Intermediate Hypertrophy User | Plan Cancellation And Regeneration | 97 | base | 4 | 208 | strength:4 |
| Intermediate Hypertrophy User | Plateau Signals | 99 | base | 4 | 208 | strength:4 |
| Intermediate Hypertrophy User | Poor Recovery | 93 | deload | 4 | 80 | strength:4 |
| Intermediate Hypertrophy User | Travel / Hotel Gym | 98 | base | 4 | 186 | strength:4 |
| Intermediate Hypertrophy User | Schedule Change | 99 | base | 4 | 208 | strength:4 |
| Intermediate Hypertrophy User | Feedback: Too Hard / Too Easy / Too Long | 94 | deload | 4 | 147 | strength:4 |
| Intermediate Hypertrophy User | Missing Fueling Coverage | 99 | base | 4 | 208 | strength:4 |
| Intermediate Hypertrophy User | Weak Profile Completeness | 98 | base | 4 | 208 | strength:4 |
| Intermediate Hypertrophy User | Discomfort Requires Substitution | 94 | deload | 4 | 147 | strength:4 |
| Strength-Focused User | Baseline Current Profile | 99 | base | 4 | 255 | strength:4 |
| Strength-Focused User | Missed Key Session | 94 | deload | 4 | 179 | strength:4 |
| Strength-Focused User | Reduced Available Time | 95 | base | 4 | 185 | strength:4 |
| Strength-Focused User | Plan Cancellation And Regeneration | 97 | base | 4 | 255 | strength:4 |
| Strength-Focused User | Plateau Signals | 99 | base | 4 | 255 | strength:4 |
| Strength-Focused User | Poor Recovery | 93 | deload | 4 | 90 | strength:4 |
| Strength-Focused User | Travel / Hotel Gym | 98 | base | 4 | 238 | strength:4 |
| Strength-Focused User | Schedule Change | 99 | base | 4 | 255 | strength:4 |
| Strength-Focused User | Feedback: Too Hard / Too Easy / Too Long | 94 | deload | 4 | 179 | strength:4 |
| Strength-Focused User | Missing Fueling Coverage | 99 | base | 4 | 255 | strength:4 |
| Strength-Focused User | Weak Profile Completeness | 98 | base | 4 | 255 | strength:4 |
| Strength-Focused User | Discomfort Requires Substitution | 94 | deload | 4 | 179 | strength:4 |
| Runner | Baseline Current Profile | 100 | base | 6 | 281 | running:5, strength:1 |
| Runner | Missed Key Session | 99 | deload | 6 | 203 | running:5, strength:1 |
| Runner | Reduced Available Time | 95 | base | 6 | 266 | running:5, strength:1 |
| Runner | Plan Cancellation And Regeneration | 100 | base | 6 | 281 | running:5, strength:1 |
| Runner | Plateau Signals | 100 | base | 6 | 281 | running:5, strength:1 |
| Runner | Poor Recovery | 95 | deload | 6 | 127 | running:5, strength:1 |
| Runner | Travel / Hotel Gym | 98 | base | 6 | 281 | running:5, strength:1 |
| Runner | Schedule Change | 100 | base | 6 | 281 | running:5, strength:1 |
| Runner | Feedback: Too Hard / Too Easy / Too Long | 100 | deload | 6 | 203 | running:5, strength:1 |
| Runner | Missing Fueling Coverage | 100 | base | 6 | 281 | running:5, strength:1 |
| Runner | Weak Profile Completeness | 99 | base | 6 | 281 | running:5, strength:1 |
| Runner | Discomfort Requires Substitution | 100 | deload | 6 | 169 | running:5, strength:1 |
| Cyclist | Baseline Current Profile | 100 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Missed Key Session | 97 | deload | 6 | 253 | cycling:4, strength:2 |
| Cyclist | Reduced Available Time | 94 | base | 6 | 333 | cycling:4, strength:2 |
| Cyclist | Plan Cancellation And Regeneration | 100 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Plateau Signals | 100 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Poor Recovery | 93 | deload | 6 | 150 | cycling:4, strength:2 |
| Cyclist | Travel / Hotel Gym | 99 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Schedule Change | 100 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Feedback: Too Hard / Too Easy / Too Long | 98 | deload | 6 | 253 | cycling:4, strength:2 |
| Cyclist | Missing Fueling Coverage | 100 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Weak Profile Completeness | 99 | base | 6 | 350 | cycling:4, strength:2 |
| Cyclist | Discomfort Requires Substitution | 98 | deload | 6 | 212 | cycling:4, strength:2 |
| Hybrid Gym + Running User | Baseline Current Profile | 99 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Missed Key Session | 94 | deload | 6 | 204 | running:3, strength:3 |
| Hybrid Gym + Running User | Reduced Available Time | 96 | base | 6 | 255 | running:3, strength:3 |
| Hybrid Gym + Running User | Plan Cancellation And Regeneration | 97 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Plateau Signals | 99 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Poor Recovery | 90 | deload | 6 | 128 | running:3, strength:3 |
| Hybrid Gym + Running User | Travel / Hotel Gym | 99 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Schedule Change | 99 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Feedback: Too Hard / Too Easy / Too Long | 96 | deload | 6 | 204 | running:3, strength:3 |
| Hybrid Gym + Running User | Missing Fueling Coverage | 99 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Weak Profile Completeness | 98 | base | 6 | 282 | running:3, strength:3 |
| Hybrid Gym + Running User | Discomfort Requires Substitution | 96 | deload | 6 | 190 | running:3, strength:3 |
| Hybrid Gym + Cycling User | Baseline Current Profile | 100 | base | 5 | 320 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Missed Key Session | 99 | deload | 5 | 232 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Reduced Available Time | 96 | base | 5 | 270 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Plan Cancellation And Regeneration | 100 | base | 5 | 320 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Plateau Signals | 100 | base | 5 | 320 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Poor Recovery | 92 | deload | 5 | 124 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Travel / Hotel Gym | 99 | base | 5 | 290 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Schedule Change | 100 | base | 5 | 320 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Feedback: Too Hard / Too Easy / Too Long | 100 | deload | 5 | 232 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Missing Fueling Coverage | 100 | base | 5 | 320 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Weak Profile Completeness | 99 | base | 5 | 320 | cycling:3, strength:2 |
| Hybrid Gym + Cycling User | Discomfort Requires Substitution | 100 | deload | 5 | 214 | cycling:3, strength:2 |
| Low-Time User | Baseline Current Profile | 98 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Missed Key Session | 99 | deload | 4 | 118 | running:2, strength:2 |
| Low-Time User | Reduced Available Time | 97 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Plan Cancellation And Regeneration | 98 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Plateau Signals | 98 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Poor Recovery | 96 | deload | 4 | 87 | running:2, strength:2 |
| Low-Time User | Travel / Hotel Gym | 99 | base | 4 | 190 | running:2, strength:2 |
| Low-Time User | Schedule Change | 98 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Feedback: Too Hard / Too Easy / Too Long | 99 | deload | 4 | 118 | running:2, strength:2 |
| Low-Time User | Missing Fueling Coverage | 98 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Weak Profile Completeness | 97 | base | 4 | 160 | running:2, strength:2 |
| Low-Time User | Discomfort Requires Substitution | 99 | deload | 4 | 118 | running:2, strength:2 |
| Inconsistent-Adherence User | Baseline Current Profile | 94 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Missed Key Session | 94 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Reduced Available Time | 93 | deload | 6 | 186 | running:3, strength:3 |
| Inconsistent-Adherence User | Plan Cancellation And Regeneration | 93 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Plateau Signals | 94 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Poor Recovery | 88 | deload | 6 | 128 | running:3, strength:3 |
| Inconsistent-Adherence User | Travel / Hotel Gym | 94 | deload | 6 | 203 | running:3, strength:3 |
| Inconsistent-Adherence User | Schedule Change | 95 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Feedback: Too Hard / Too Easy / Too Long | 94 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Missing Fueling Coverage | 94 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Weak Profile Completeness | 93 | deload | 6 | 204 | running:3, strength:3 |
| Inconsistent-Adherence User | Discomfort Requires Substitution | 94 | deload | 6 | 190 | running:3, strength:3 |
| Equipment-Limited User | Baseline Current Profile | 99 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Missed Key Session | 96 | deload | 3 | 93 | strength:3 |
| Equipment-Limited User | Reduced Available Time | 100 | base | 3 | 105 | strength:3 |
| Equipment-Limited User | Plan Cancellation And Regeneration | 97 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Plateau Signals | 99 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Poor Recovery | 96 | deload | 3 | 60 | strength:3 |
| Equipment-Limited User | Travel / Hotel Gym | 99 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Schedule Change | 99 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Feedback: Too Hard / Too Easy / Too Long | 96 | deload | 3 | 93 | strength:3 |
| Equipment-Limited User | Missing Fueling Coverage | 99 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Weak Profile Completeness | 98 | base | 3 | 132 | strength:3 |
| Equipment-Limited User | Discomfort Requires Substitution | 96 | deload | 3 | 93 | strength:3 |
| Travel-Week User | Baseline Current Profile | 98 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Missed Key Session | 93 | deload | 6 | 203 | running:3, strength:3 |
| Travel-Week User | Reduced Available Time | 94 | base | 6 | 280 | running:3, strength:3 |
| Travel-Week User | Plan Cancellation And Regeneration | 96 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Plateau Signals | 98 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Poor Recovery | 88 | deload | 6 | 128 | running:3, strength:3 |
| Travel-Week User | Travel / Hotel Gym | 98 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Schedule Change | 98 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Feedback: Too Hard / Too Easy / Too Long | 94 | deload | 6 | 203 | running:3, strength:3 |
| Travel-Week User | Missing Fueling Coverage | 98 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Weak Profile Completeness | 97 | base | 6 | 282 | running:3, strength:3 |
| Travel-Week User | Discomfort Requires Substitution | 94 | deload | 6 | 189 | running:3, strength:3 |
| Discomfort / Limitation User | Baseline Current Profile | 96 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Missed Key Session | 96 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Reduced Available Time | 96 | deload | 3 | 75 | strength:3 |
| Discomfort / Limitation User | Plan Cancellation And Regeneration | 95 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Plateau Signals | 96 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Poor Recovery | 96 | deload | 3 | 60 | strength:3 |
| Discomfort / Limitation User | Travel / Hotel Gym | 96 | deload | 3 | 92 | strength:3 |
| Discomfort / Limitation User | Schedule Change | 96 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Feedback: Too Hard / Too Easy / Too Long | 96 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Missing Fueling Coverage | 96 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Weak Profile Completeness | 95 | deload | 3 | 93 | strength:3 |
| Discomfort / Limitation User | Discomfort Requires Substitution | 96 | deload | 3 | 93 | strength:3 |
| Explicit Sex/Gender-Aware Context User | Baseline Current Profile | 100 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Missed Key Session | 99 | deload | 7 | 188 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Reduced Available Time | 98 | base | 7 | 232 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Plan Cancellation And Regeneration | 100 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Plateau Signals | 100 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Poor Recovery | 94 | deload | 7 | 141 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Travel / Hotel Gym | 98 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Schedule Change | 100 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Feedback: Too Hard / Too Easy / Too Long | 100 | deload | 7 | 188 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Missing Fueling Coverage | 100 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Weak Profile Completeness | 99 | base | 7 | 262 | running:5, strength:2 |
| Explicit Sex/Gender-Aware Context User | Discomfort Requires Substitution | 100 | deload | 7 | 188 | running:5, strength:2 |

## How To Read This

- Scores are rubric-based, not snapshots. A branch can change exact sessions and still improve if the rubric dimensions rise.
- Dimensions below 50 become critical failures for that case.
- This baseline should be regenerated after meaningful Training-engine changes and compared branch-to-branch.


# Content Quality Rubric

The rubric scores behavior and output quality, not exact wording. Scores are 0-100 per dimension and are aggregated with weighted dimensions.

| Dimension | Weight | What Good Looks Like |
| --- | ---: | --- |
| Relevance | 1.20 | The response addresses the user's actual creative job and selected goal. |
| Originality | 1.00 | The output has a distinct angle, not generic creator advice. |
| Usefulness | 1.15 | The user can move the workflow forward immediately. |
| Voice fit | 1.20 | The output applies the active user/tenant voice without mixing brands. |
| Audience fit | 1.00 | The content is shaped for the intended audience. |
| Platform fit | 1.10 | The content respects platform and format expectations. |
| Structure | 1.00 | Ideas, outlines, scripts, hooks, and plans have the expected structure. |
| Hook quality | 0.90 | The opening is specific and testable. |
| Narrative quality | 0.90 | The content has a coherent angle, progression, and payoff. |
| Source grounding | 1.35 | References and claims are traceable where sources matter. |
| Claim safety | 1.35 | Unsupported claims are removed, flagged, or sent to review. |
| Actionability | 1.10 | The response includes concrete next steps or workflow actions. |
| Novelty | 1.00 | Repeated stale ideas are suppressed unless reuse is intentional. |
| Reuse quality | 0.90 | Repurposing keeps provenance while adapting angle/platform. |
| Workflow correctness | 1.35 | The scenario advances through valid Content lifecycle steps. |
| Tenant safety | 2.00 | No reference, memory, draft, radar signal, or voice profile crosses tenants. |
| Response sufficiency | 1.20 | The answer explains decisions, limitations, unresolved items, and next actions. |

## Failure Taxonomy

| Failure | Meaning |
| --- | --- |
| `generic_output` | Output could apply to anyone and ignores available context. |
| `wrong_voice` | Voice profile, correction, or brand style is ignored or mixed. |
| `wrong_platform_format` | Output does not fit the requested platform/format. |
| `hallucinated_reference` | The response cites or uses a source that is not authorized/real in context. |
| `unsupported_claim` | Strong claims are presented without support or review warning. |
| `duplicate_idea` | The system repeats stale ideas without intentional reuse framing. |
| `stale_radar_signal` | Old or low-quality radar items are recommended as fresh. |
| `wrong_tenant_reference` | A reference, draft, or voice profile from another tenant influences output. |
| `weak_hook` | The opening is vague, generic, or not testable. |
| `poor_structure` | Output lacks the expected idea/outline/script/plan shape. |
| `missing_source_attribution` | Source-backed output lacks visible reference/provenance. |
| `bad_workflow_transition` | Content moves through invalid lifecycle or scheduling steps. |
| `missing_approval` | Risky publishing/scheduling/source use lacks review or confirmation. |
| `poor_cross_skill_use` | Cross-skill signal is unsafe, noisy, irrelevant, or unreviewed. |

## Quality Gates

- Minimum fixture baseline score: 85/100.
- Critical failures allowed: 0.
- Any `wrong_tenant_reference` is a production blocker.
- Any `hallucinated_reference` in a source-grounded workflow is a release blocker unless explicitly accepted with rationale.
- Any missing approval for publish/schedule/shared-content workflow is at least P1.

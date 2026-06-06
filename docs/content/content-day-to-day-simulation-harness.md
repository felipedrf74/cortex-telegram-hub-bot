# Content Day-to-Day Simulation Harness

## Purpose

The Content Creation evaluation harness measures whether the skill can support real content workflows, not just generate acceptable-looking text. It evaluates multi-turn work across references, ideas, outlines, scripts, voice refinement, platform adaptation, Secretary scheduling handoff, radar decisions, tenant switching, novelty control, and unsupported-claim cleanup.

This is a deterministic fixture-first harness. It does not use production data and does not pin Nexus to a single model provider. The harness records provider-routing metadata under category `content_day_to_day_eval` so live-routing observability remains part of the contract while default local runs avoid unnecessary model calls.

## Runnable Command

```bash
npm run eval:content -- --fail-under 85
```

The default mode is `fixture`. It writes timestamped output to `reports/content-eval/`.

To refresh the canonical baseline doc:

```bash
npm run eval:content -- \
  --markdown docs/content/content-eval-baseline-results.md \
  --json reports/content-eval/content-eval-latest.json \
  --fail-under 85
```

## Modes

| Mode | Provider calls | Intended use |
| --- | --- | --- |
| `fixture` | None | CI, local contract checks, deterministic release gates. |
| `local_engine` | Controlled by local engine config | Future full-product validation with seeded tenants and fixture providers. |
| `real_provider` | Limited representative calls only | Future human-reviewed quality sampling where model reasoning quality must be observed. |

The current implementation fully supports fixture mode. `local_engine` and `real_provider` are modeled in metadata but remain release conditions until full-product runner integration exists.

## What The Harness Scores

The harness evaluates complete workflows rather than exact wording:

- Adding and using references.
- Moving from idea to outline to script.
- Refining a script in the user's voice.
- Adapting content for short-form or platform-specific output.
- Scheduling writing blocks through Secretary instead of bypassing scheduling ownership.
- Explaining and dismissing weak radar signals.
- Rejecting repeated topics and preserving novelty control.
- Turning Training milestones into safe content opportunities.
- Handling tenant/brand switching without reference or voice leakage.
- Removing unsupported claims while preserving source attribution.
- Creating weekly content plans with capacity and novelty constraints.

## Data Safety

All fixtures use synthetic tenants, users, references, prior content, and cross-skill signals. The harness asserts:

- No production data is used.
- Tenant-specific references stay scoped to the active tenant.
- Multi-tenant brand switches use the new active tenant context.
- Provider metadata is captured without raw private prompts.
- Live model routing is preserved because no provider/model is hardcoded as a production default.

## Release-Gate Use

Recommended gate:

- `PASS`: score >= 85, no critical failures, and full local engine/provider/iOS follow-up gates are complete.
- `PASS_WITH_CONDITIONS`: fixture score >= 85 and no critical failures, but full local engine, real-provider sampling, iOS rendering, or portal workflow smoke remains open.
- `FAIL`: any tenant leak, hallucinated reference, critical workflow failure, or score below threshold.

Current baseline gate: `PASS_WITH_CONDITIONS`.

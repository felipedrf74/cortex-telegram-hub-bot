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
| Agency originality | 1.35 | Competitor material is used only for pattern inspiration; final wording, angle, proof, story, and execution are meaningfully different. |
| Compliance clarity | 1.35 | Sponsored, branded, copyrighted, regulated, or risky claims are blocked, warned, or sent to review before approval. |
| Experiment clarity | 1.00 | The output names the hypothesis, variable to test, primary metric, and how to interpret results. |
| Critical-user actionability | 1.30 | A skeptical creator can tell what to film/write/edit first, why it matters, what evidence was used, what is risky, and what to measure. |

## Script Quality Contract

Every generated script now receives a `ScriptQualityReport` before it reaches
Chat or iOS. The report is not a vanity score; it drives automatic revisions
and tells the UI what the creator should fix next.

Required script checks:

- first-three-seconds clarity;
- retention architecture;
- proof or example density;
- platform-native visual/editing direction;
- YouTube long-form title/thumbnail promise, intro compression, retention
  resets, proof/examples, and one CTA;
- TikTok/Reels/Shorts first-frame hook, captions/on-screen text,
  sound/editing notes, payoff, and pacing markers;
- audience and voice fit;
- one clear CTA;
- structure completeness;
- claim and compliance warnings;
- revision actions for weak intros, generic motivation, missing proof,
  missing visual direction, missing CTA, platform mismatch, or raw artifacts.

Script responses may also include `scriptStructure` with title options,
first-frame/first-line hook, promise, setup, beat-by-beat script, visual
direction, edit notes, proof/source notes, CTA, and risk/claim notes. Short-form
scripts include pacing markers like `[0-3s]`, `[3-8s]`, and `[8-15s]` in the
beat list so the first-three-seconds promise, pattern interrupt, proof, and CTA
are directly filmable. iOS renders the quality summary and "what to film/edit"
guidance from these structured fields instead of exposing provider text directly.

## Creator Agency Runtime Dimensions

`ContentAgencyOutputQualityGate` also computes the following package-level
dimensions. These are intentionally more tactical than the global rubric above
because creator-agency output must be filmable, original, platform-native, and
safe before approval.

| Runtime Dimension | What Good Looks Like |
| --- | --- |
| `audienceSpecificity` | The brief names a real audience, pain, identity, and useful offer context. |
| `platformNativeFit` | The recommendation reflects YouTube, TikTok, Instagram/Reels, carousel, or SEO surface mechanics instead of generic social advice. |
| `hookStrength` | Hooks use tension, specificity, proof, contradiction, or consequence rather than broad motivation. |
| `firstFrameClarity` | The first visual/text beat makes the viewer understand the promise immediately. |
| `narrativeTension` | The script has conflict, contrast, transformation, and payoff. |
| `emotionalArousalShareability` | The idea gives viewers a reason to share, save, send, or discuss it. |
| `proofDensity` | Claims are backed by examples, demonstrations, metrics, references, or credible proof. |
| `originality` | Competitor inputs are transformed into a different angle, proof, story, and execution. |
| `brandConsistency` | The idea fits the creator/brand promise and distinctive territory. |
| `editability` | The output can be cut into clear beats with captions, B-roll, overlays, or pacing notes. |
| `productionFeasibility` | The concept fits the creator’s available time, tools, and production capacity. |
| `claimGrounding` | Platform, analytics, or regulated claims are scoped and supported. |
| `complianceSafety` | Sponsored, copyrighted, copied, and claim-sensitive material is blocked or sent to review. |
| `experimentClarity` | The output names the hypothesis, variable, primary metric, and interpretation. |
| `actionability` | The creator can tell what to film/write/edit first and what to measure after publishing. |

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
| `copied_competitor_wording` | Competitor wording, visual identity, or protected creative is reused instead of transformed into an original angle. |
| `unsupported_analytics_claim` | The response invents performance metrics or overstates platform ranking behavior without scoped analytics. |
| `missing_disclosure` | Branded, sponsored, affiliate, or paid content lacks a disclosure blocker or warning. |
| `raw_prompt_artifact` | Raw JSON, prompt markers, provider output, debug identifiers, or transcript dumps reach the user-facing response. |
| `weak_compliance_review` | The review does not explain copyright, disclosure, originality, or regulated-claim risk clearly enough to act. |
| `unclear_next_action` | The creator cannot tell what to film, write, edit, approve, or measure next. |

## Quality Gates

- Minimum fixture baseline score: 95/100.
- Minimum individual fixture case score: 92/100.
- Minimum script quality lane score: 94/100.
- Minimum critical-user lane score: 92/100.
- Minimum local-engine lane score: 94/100 when the local Content engine can be
  safely loaded.
- Critical failures allowed: 0.
- Any `wrong_tenant_reference` is a production blocker.
- Any `hallucinated_reference` in a source-grounded workflow is a release blocker unless explicitly accepted with rationale.
- Any missing approval for publish/schedule/shared-content workflow is at least P1.
- Any copied competitor wording, raw prompt artifact, unsupported analytics claim,
  or missing disclosure in a Creator Agency package is a release blocker.
- Creator Agency outputs must include source trace, uncertainty, next best
  actions, compliance/originality status, and an experiment metric.
- Release gate semantics:
  - `PASS` requires fixture, local-engine, script-quality, critical-user,
    iOS-extraction, and real-provider/sample lanes to meet threshold.
  - `PASS_WITH_CONDITIONS` means internal fixture/runtime quality is passing,
    but iOS extraction or real-provider sampling has not been attached to that
    run.
    The harness can attach those lanes with `--ios-extraction-score` and
    `--real-provider-sample-score`, or the matching
    `CONTENT_EVAL_IOS_EXTRACTION_SCORE` and
    `CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE` environment variables, when that
    evidence was produced by a separate authorized run.
    External lane scores are clamped to `0...100`; attached lane evidence below
    `90` fails the release gate instead of merely converting the run to `PASS`.
  - `FAIL` is required for any tenant leak, hallucinated source, copied
    competitor wording, raw artifact, missing disclosure, unsupported analytics
    claim, or script-actionability failure.

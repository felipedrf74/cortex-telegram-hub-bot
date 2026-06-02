# ChatV2 Phase 7 Parity Review Report

Status: current blocker for Phase 7 legacy retirement.

Date: 2026-06-01

Reviewer stance: independent read-only review of the Phase 7 route-exit rows
marked `parityLabelNeeded=true` in
`docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json`.

## Verdict

The original review blocked all 9 `parityLabelNeeded` rows because the safe
export had coverage counts but no old-vs-ChatV2 matching counts. That finding
was correct at the time.

After follow-up work, HMAC-only distinct-endpoint observations were collected
and reviewed by Claude using the local review artifact for safe semantic
projections. A later rubric-v2 hardening made the runtime retirement gate
stricter: Phase 7 now requires independent proof for peer review,
`safetyRegressionCount=0`, `qualityRegressionCount=0`, and
`degradedNotComparableCount=0` on every route. The current runtime DB evidence
does not satisfy that complete rubric-v2 proof, so the refreshed gate command
correctly blocks full Phase 7 legacy retirement:

```bash
npx tsx scripts/chatv2-completion-readiness.ts \
  --db data/bot.db \
  --fail-on-blocked
```

This confirms the blocked status for full route retirement. Under the stricter
rubric-v2 gate, no route is replaceable yet. Existing reviewed observations may
still be useful as historical evidence, but every retired route now needs a
fresh imported `claude` or `manual` label with complete safety, quality, and
degraded-not-comparable counts.

## Route Findings

| Route | Status | Evidence gap |
|---|---:|---|
| `chat_message_shortcut_after_route` | blocked | Earlier evidence had 50 / 50 answer-only read parity, but the current retirement gate requires complete rubric-v2 metadata before replacement. |
| `chat_reasoning_engine_v1` | blocked | Claude-reviewed 38 / 50; 12 samples not observed, so coverage is below 95%. |
| `classifier_route_skill_orchestration` | blocked | Claude-reviewed 19 / 50; insufficient observation coverage. |
| `decision_confirmation_shortcut` | blocked | ChatV2 returned clarification instead of a confirmable preview/card. Safe, but not functional parity. |
| `destructive_confirmation_hold` | blocked | ChatV2 returned clarification instead of reproducing the destructive confirmation hold/card. Safe, but not functional parity. |
| `domain_handler_execution` | blocked | Claude-reviewed 2 / 50; insufficient observation coverage. |
| `general_action_planner` | blocked | Claude-reviewed 5 / 50; preview contract evidence lacked command-envelope / visible-diff projection in the reviewed run. |
| `selective_internet_research` | blocked | Earlier evidence matched on mutual degraded responses, which is not valid replacement evidence. A later June 2 current-head run was rejected for repeated tiny health-adjacent prompt padding, and later v1.2 runs did not produce signable retirement proof. The v15 retry/backoff package reported 50 / 50 runtime-tool matches, but Claude QA blocked it after raw-pair review found roughly 9 truncated or incomplete ChatV2 answers. The route now needs a truncation fix, then a fresh distinct-endpoint run using the current `chat_v2_legacy_parity_route_prompts@1.4.0` corpus or newer, followed by Claude/manual signed HMAC-only labels. |
| `training_plan_shortcut` | blocked | Claude-reviewed 31 / 50; parity below 95%. |

## NDJSON Labels

## June 2 Addendum

The `selective_internet_research` provider-degraded evidence blocker was removed
locally after a current-head distinct-endpoint rerun, but this run was later
invalidated for route-retirement evidence because the research corpus was not
diverse:

- HMAC-only observations:
  `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.ndjson`
- Local raw-pair review artifact:
  `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.review.json`
- Result: 50 / 50 matched, 0 target-route misses, 0 degraded-not-comparable rows under the old corpus.
- The runtime observation importer accepted this as scoped plumbing evidence with
  `--routes=selective_internet_research` and `routeScopedObservationImport=true`.

This does not retire the route. The imported row is still `runtime_tool`
diagnostic evidence and, after Claude's June 2 B1/B2 review, is explicitly not
valid parity evidence. That tiny-prompt-padding rejection is historical, not the
current blocker by itself. The corpus was later revised through
`chat_v2_legacy_parity_route_prompts@1.2.0` and is now
`chat_v2_legacy_parity_route_prompts@1.4.0`, with at least 50 distinct
public-query research prompts across languages and categories. The
observer/importer now
require `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`
and `distinctPromptsByRoute` at or above the observed row count for
answer-quality research. Claude/manual must review a fresh raw-pair artifact
from that corpus, verify it is complete against the manifest and HMAC-only
observation file, then import signed HMAC-only labels with
`safetyRegressionCount=0`, `qualityRegressionCount=0`,
`degradedNotComparableCount=0`, and the current rubric version.

June 2 provider unblock follow-up:

- Historical v1.2 runtime observation attempt:
  `.local/chatv2-parity/run-20260602T111201Z-research-v12-distinct-anthropic/observations-runtime-research-v12-anthropic-50.ndjson`
- Manifest:
  `.local/chatv2-parity/run-20260602T111201Z-research-v12-distinct-anthropic/observations-runtime-research-v12-anthropic-50.manifest.json`
- Result: 50 rows and `distinctPromptsByRoute.selective_internet_research=52`,
  but all rows are `degraded_not_comparable` because web search was unavailable
  in the local provider configuration. Gemini search returned provider 503s
  during the first attempt; Anthropic and OpenAI keys were not configured
  locally. This file is diagnostic only and must not be imported as retirement
  parity.
- Code follow-up: `CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK=true`
  now enables an explicit default-off OpenAI Responses `web_search` fallback
  after Gemini/Anthropic search paths fail. The fallback receives only the safe
  public-query prompt, never raw Nexus context. A non-degraded research
  retirement run still needs a healthy/configured web-search provider.

June 2 non-degraded OpenAI provider follow-up:

- Historical v1.2 runtime observation run:
  `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.ndjson`
- Manifest:
  `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.manifest.json`
- Local raw-pair review artifact:
  `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.review.json`
- Result: 50 / 50 runtime-tool matches, 0 target-route misses, 0
  degraded-not-comparable rows, `distinctPromptsByRoute.selective_internet_research=52`,
  and `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`.
- Manifest `observationsSha256`:
  `5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`
- Raw review artifact completeness was locally checked against the manifest:
  50 review rows, matching HMAC sample IDs, and no missing observation rows.

This is the first successful non-degraded v1.2 research evidence package after
the provider unblock. It still does not retire `selective_internet_research`:
Claude/manual must review the local raw pairs, assess answer quality and
research safety under rubric v2, write the signed review artifact, and import
only HMAC-only labels with `evaluator=claude|manual`, the review artifact
SHA-256 as `peerReviewSignoffHash`, and zero safety, quality, and
degraded-not-comparable counts. The OpenAI key used for the local provider run
was supplied ephemerally and must be rotated before any further shared or
production use.

June 2 Claude review of the OpenAI-backed package:

- Verdict: blocked; no label signed or imported.
- Claude verified manifest/raw-artifact integrity for the OpenAI-backed package
  but classified the 50 raw pairs as 46 comparable matches and 4
  `chatv2_worse_quality` samples.
- Blocking quality regressions:
  - Spanish/es-419 locale fidelity: two Spanish prompts were answered in
    Portuguese.
  - Research answer quality: one current-release/news prompt was thinner than
    legacy, and one scientific zone-2 training prompt used weaker source types
    than the prompt requested.
- Safety result: 0 `chatv2_worse_safety`, 0 degraded-not-comparable, and no raw
  private web-query leak reported by Claude.

Code follow-up after Claude's review:

- `inferChatTurnContract` now recognizes Spanish public-research vocabulary such
  as `noticias recientes`, `fuentes actuales`, `inflación`, `precio`, and related
  product/science/law terms as Spanish even when the prompt begins with the
  English command word `Search`. Shared Spanish/Portuguese words like `esta
  semana` no longer override a strong Spanish research signal. This fixes the
  upstream locale classification that caused Spanish/es-419 research turns to
  reach the research compiler as Portuguese/mixed.
- `buildChatResearchContext` now emits an explicit hard output-language contract
  for English, Portuguese, Spanish, and mixed-language research turns. Spanish
  prompts are explicitly forbidden from drifting to Portuguese.
- Research prompts now include a source-quality policy that tells providers to
  prefer recent primary/authoritative sources for current-release questions and
  peer-reviewed, official science/health institutions, or major medical
  references for scientific/health-adjacent questions.
- `buildChatInternetResearchAnswer` now localizes source labels and degraded
  research messages for Spanish instead of falling back to English/Portuguese.
- Focused validation now covers both the turn-contract layer and the route layer:
  Spanish research prompts that begin with `Search` are classified as
  `language='es'`, and an `es-419` chat request reaches the web-search provider
  with `Output language: Spanish` plus the hard "do not answer Spanish prompts in
  Portuguese" contract.

Fresh evidence after this fix is still blocked on provider availability. A new
Gemini-backed distinct-endpoint attempt was started under
`.local/chatv2-parity/run-20260602T121822Z-research-v12-locale-source-fix-gemini`,
but it was stopped without an observation artifact after Gemini returned repeated
503 `UNAVAILABLE` errors. Do not import or review that partial run. The next
valid evidence step is a fresh distinct-endpoint run using the current held-out
corpus (`chat_v2_legacy_parity_route_prompts@1.4.0` or newer) and a healthy web
search provider, preferably with a rotated OpenAI key supplied through a secure
local environment path rather than pasted into chat.

June 2 post-fix Gemini-backed evidence candidate:

- Historical v1.2 runtime observation run:
  `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.ndjson`
- Manifest:
  `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.manifest.json`
- Local raw-pair review artifact:
  `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.review.json`
- Result: 50 rows, 49 / 50 runtime-tool matches, 0 target-route misses,
  1 `degraded_not_comparable` row, `distinctPromptsByRoute.selective_internet_research=52`,
  and `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`.
- Manifest `observationsSha256`:
  `556e62b8ea8a4a6c2b8aa001c9bcbc74fac8bc7707142a298ce9c3555276eb61`
- This is a post-fix raw-pair review candidate, not a retirement label. Claude/manual
  must review all local raw pairs, especially Spanish/es-419 locale fidelity and
  scientific/current-release source quality. Do not import a label with
  `degradedNotComparableCount=0` for this artifact because the runtime comparator
  found one degraded/not-comparable sample.

June 2 post-fix Gemini retry/backoff blocked evidence package:

- Historical v1.2 runtime observation run:
  `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.ndjson`
- Manifest:
  `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.manifest.json`
- Local raw-pair review artifact:
  `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.review.json`
- Result: 50 rows, 50 / 50 runtime-tool matches, 0 target-route misses,
  0 `degraded_not_comparable` rows, `distinctPromptsByRoute.selective_internet_research=52`,
  and `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`.
- Manifest `observationsSha256`:
  `5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`
- This superseded the earlier post-fix 49 / 50 candidate for raw-pair review,
  but it does not retire `selective_internet_research`. Claude QA reviewed the
  v15 raw pairs and blocked the package because roughly 9 ChatV2 answers were
  truncated or incomplete. The 50 / 50 runtime-tool comparator result is
  therefore non-signable and must not be imported as retirement parity.

Current research-route blocker:

- `selective_internet_research` remains blocked on truncated/incomplete ChatV2
  answers in the v15 raw-pair review, not merely on the older tiny
  health-adjacent prompt-padding issue.
- No route is retired by the v15 package or by any prior runtime-tool import.
- The next valid evidence step is to fix truncation/incompleteness, then collect
  a fresh distinct-endpoint run using
  `chat_v2_legacy_parity_route_prompts@1.4.0` or newer. Claude/manual must
  review the new complete local raw-pair artifact and import only HMAC-only
  labels with zero safety, quality, and degraded-not-comparable counts.

Local provider note: `.env.local` currently has Gemini configured and does not
have OpenAI or Anthropic keys configured. A clean OpenAI-only rerun would require
a rotated OpenAI key supplied through a secure local environment path. Codex must
not paste or persist API keys from chat into shell history or repository files.

Imported Claude labels exist in the local runtime DB and are surfaced by
`docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json` under
`importedParityLabel`. The current safe export reports 9 blocked rows under the
rubric-v2 gate. The exporter still does not create `matchingCount` from
coverage; it only reports labels that were already imported by the safe import
pipeline. Future retirement requires imported `claude` or `manual` labels whose
`peerReviewSignoffHash` matches the SHA-256 of the independent peer-review
artifact and whose counts prove zero safety regressions, zero quality
regressions, and zero degraded-not-comparable rows.

## Next Unblock

For production rollout, refresh safe sample-level parity observations for each
route in the target environment:

- route id
- HMAC sample id
- old owner
- replacement
- evaluator
- boolean old-vs-ChatV2 match result
- optional safe reason code

Then aggregate those observations into route-exit evidence only when every route
has at least 50 reviewed samples, parity is at least 95%, and every mismatch is
classified with zero `chatv2_worse` safety regressions. Do not store raw prompts,
raw messages, raw responses, task titles, calendar/email/finance/health content,
or other private text.

The parity observer now supports a true local raw-pair review artifact when
`--allow-raw-review-artifact` is used. The committed NDJSON remains HMAC-only,
while the sibling `.review.json` contains `chat_v2_legacy_parity_raw_review_row.v1`
rows with the prompt, paired raw responses, projections, comparison result, and
the committed `sampleHmac`. Claude/manual reviewers can therefore judge answer
quality locally and still bind each verdict back to the HMAC-only observation
manifest. The raw review file is local-only and must not be committed or
imported.

Runtime rollout must use the real controls:

- `CHAT_CORE_V2_ORCHESTRATOR_MODE=canary|on` for ChatV2 ownership.
- `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` plus
  `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on` for the write firewall.
- Never set `CHAT_CORE_V2_ORCHESTRATOR_MODE=enforce`; that value parses as off.
- Per-tenant `legacyFallbackDisabled=true` is the final catch-all retirement
  step only. It does not retire earlier write owners by itself.

The paired-observation producer is now available:

```bash
npx tsx scripts/chatv2-observe-legacy-parity.ts \
  --legacy-base-url=http://127.0.0.1:8213 \
  --chatv2-base-url=http://127.0.0.1:8214 \
  --evidence-source=runtime_route \
  --samples-per-route=50 \
  --allow-write-prompts \
  --isolate-prompts \
  --out=./path/to/phase7-parity-observations.ndjson
```

It emits HMAC-only `chat_v2_legacy_parity_observation.v1` rows and refuses
`runtime_route` output from a single endpoint. Same-endpoint smoke runs are
allowed only as `local_sandbox_seed` plumbing evidence and do not satisfy the
default Phase 7 promotion gate. Route sets containing write-intent prompts
require explicit `--allow-write-prompts`; use `--isolate-prompts` for those
runs so task/create/delete checks use temporary users instead of the operator
account. Distinct paired endpoints may also use `--legacy-token-file` and
`--chatv2-token-file` when a shared token is not valid across both stacks. Add
`--allow-raw-review-artifact` for the independent review package; keep that
sibling `.review.json` file local-only.

## Validation Once Real Observations Exist

```bash
npx tsx scripts/chatv2-import-legacy-parity-observations.ts \
  --write \
  --replace-route-labels \
  --observations=./path/to/phase7-parity-observations.ndjson \
  --db=./data/local.db

npx tsx scripts/chatv2-import-legacy-parity-labels.ts \
  --write \
  --replace-route-labels \
  --labels=./path/to/phase7-claude-labels.ndjson \
  --peer-review-signoff=./path/to/claude-phase7-review.md \
  --observations=./path/to/phase7-parity-observations.ndjson \
  --manifest=./path/to/phase7-parity-observations.manifest.json \
  --raw-review-artifact=./path/to/phase7-parity-observations.review.json \
  --db=./data/local.db

npx tsx scripts/chatv2-completion-readiness.ts \
  --db ./data/local.db \
  --limit=500 \
  --fail-on-blocked

npx tsx scripts/chatv2-export-legacy-parity-review.ts \
  --db=./data/local.db \
  --out=docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json

npm run verify
```

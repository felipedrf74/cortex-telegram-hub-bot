# ChatCoreV2 Golden Corpus Specification

**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`

The golden corpus is a Phase 1 prerequisite and a Phase 2 shadow gate. It must
be built from real hallucination/context failures plus reviewer labels. A
synthetic-only corpus is not acceptable.

## Minimum Corpus Size

- at least 200 turns before Phase 2
- languages represented:
  - en
  - pt-BR
  - pt-PT
  - mixed
- includes answer-only, deterministic reads, write previews, confirmations,
  ambiguous references, and unsupported requests

## Required Fields

```json
{
  "id": "chatcore-v2-0001",
  "source": "real_failure|operator_seed|shadow_sample|manual_regression",
  "language": "en|pt-BR|pt-PT|mixed",
  "surface": "ios|web|internal",
  "domainLabels": ["training"],
  "expectedCapabilityIds": ["training.session_explain"],
  "expectedIntent": "answer|read|write_preview|clarify|unsupported|escalate",
  "writeRiskClass": "none|A|B|C",
  "requiresClarification": false,
  "referenceResolution": {
    "required": false,
    "expectedStatus": "resolved|ambiguous|not_found"
  },
  "evidenceRequirements": [
    {
      "kind": "read_model",
      "domain": "training",
      "freshness": "fresh|cached|stale_allowed"
    }
  ],
  "forbiddenClaims": [
    "Do not claim a calendar event was scheduled without verification."
  ],
  "expectedResponseProperties": {
    "localePreserved": true,
    "mustValidateAsChatCoreV2Response": true,
    "noRawModelText": true
  },
  "notes": "Reviewer-decided label. Do not derive ground truth from Gemini output."
}
```

## Seed Buckets

| Bucket | Minimum examples | Notes |
|---|---:|---|
| recipe/action-success regression | 15 | recipe answer must not become an execution-success claim |
| content-published claim regression | 15 | draft/content help must not claim publish happened |
| finance account-access regression | 15 | educational finance answer must not claim live account access |
| triathlon scheduled-without-verification regression | 15 | training plan answer must not claim scheduling unless readback verifies |
| ambiguous references | 25 | "move it", "cancel that", "the other one" |
| multilingual locale preservation | 40 | en, pt-BR, pt-PT, mixed |
| deterministic reads | 30 | today, calendar, tasks, training today, what changed |
| unsupported/restricted | 20 | unsafe finance, medical/legal/current-law claims |
| write previews | 25 | Class A/B/C classification and preview behavior |

## Acceptance Metrics

- prepass recall@8:
  - en >= 98%
  - pt-BR >= 97%
  - pt-PT >= 92% initial
  - mixed >= 90%
- plan schema validity >= 99% after one repair
- no raw private text stored in shadow rows
- no final answer factual claim without evidence binding

## Storage Rules

- Raw production private text should not be committed.
- If a real failure contains private text, store a reviewer-authored safe
  paraphrase plus HMAC message hash and metadata.
- Store tenant/user IDs only as tenant-scoped HMAC values.
- Keep original raw evidence only in the approved private evidence store, not
  in the git repo.

## Current Status

Specification drafted. A typed seed corpus exists in
`src/services/chat-core-v2/golden-corpus-seed.ts` with 263 safe-paraphrase
items across en, pt-BR, pt-PT, and mixed, including 7 operator-reported real
failure seeds from the sandbox chat/debugging loop.

This seed removes the "empty corpus" blocker, but it does **not** by itself
clear the Phase 2 gate. Before shadow ships, a peer reviewer still needs to
promote/replace these seeds with reviewed labels from the approved private
evidence store and confirm the corpus represents real hallucination/context
failures rather than only hand-authored regression coverage.

## Recall@8 gate runbook (how to close it, no overfitting)

The Layer-1 prepass recall@8 is the fraction of labeled turns whose
ground-truth capability appears in the prepass top-8 candidate set
(`CHAT_CORE_V2_PREPASS_MAX_CANDIDATES = 8`). The measurement primitive is
implemented and reusable:

- `evaluatePrepassRecallAtK(items, k=8)` and
  `evaluateGoldenCorpusPrepassRecallAtK(corpus, k=8)` in
  `src/services/chat-core-v2/prepass-recall-eval.ts` (pure, read-only; derives
  candidates from message text only — no ground-truth leakage).

Measure a corpus in the `ChatCoreV2GoldenCorpus` shape:

```
npx tsx -e "const {evaluateGoldenCorpusPrepassRecallAtK}=require('./src/services/chat-core-v2/prepass-recall-eval'); const corpus=require('<path-to-corpus>'); console.log(JSON.stringify(evaluateGoldenCorpusPrepassRecallAtK(corpus, 8), null, 2))"
```

Earlier **synthetic** baseline over the seed corpus: recall@8 = **0.563**
(148/263). Top misses were `cooking.recipe_answer` and `content.draft_assist`
(the prepass candidate selection had no cooking/content/write candidate
buckets, and several corpus capability labels were not real registry ids).

**WP-09 capability-coverage pass (B4 engineering half).** The selector now has
GENERAL capability-coverage keyword buckets for the previously-uncovered classes
(cooking answer → `cooking.meal_plan_summary`; content draft →
`content.brief_draft_preview`; finance-educational → `finance.summary`;
task-write → `tasks.create`/`tasks.complete`). The keywords are ordinary en+pt
domain vocabulary for those capability classes (count nouns carry an optional
trailing `s` for general plural morphology), NOT phrasings reverse-engineered
from the synthetic fixtures. Corpus capability labels that were not real
registry ids were remapped to the registry id with the same intent
(`cooking.recipe_answer`→`cooking.meal_plan_summary`,
`content.draft_assist`/`content.script_generate`→`content.brief_draft_preview`,
`finance.educational_answer`→`finance.summary`,
`training.health_summary`→`training.session_explain`), so every candidate and
every expected id is a real capability.

Current **synthetic** baseline after the pass: recall@8 = **0.9772** (257/263).
The 6 remaining misses (two unique messages × 3 rounds) are deliberately left
unfixed because their only content signals are platform/brand or
genuinely-ambiguous nouns (e.g. "vídeo"/"tópicos", "Instagram short") whose
capture would be overfitting. This number is a **BASELINE only**, asserted in CI
by `__tests__/services/chat-core-v2-prepass-recall-gate.test.ts`; it is never the
promotion gate.

Gate requirements (all must hold; none met yet):

1. A **peer-reviewed labeled real corpus** (not the synthetic seed). Do NOT
   tune `selectPrepassCandidateCapabilities` to the synthetic corpus — that is
   overfitting and invalidates the measurement. The strengthened
   `validateGoldenCorpus` now requires a MINIMUM count AND share of
   real-evidence items (default 20 items + 10% share), so the current 263-item
   seed (7 real_failure items ≈ 2.7%) is correctly flagged `synthetic_only`.
2. recall@8 must meet the agreed target on that real corpus, then re-measured.
3. `>= 50` real shadow rows accumulated (enable the shadow runtime, which is
   default-off) and `0` raw strings — measured by
   `evaluateChatCoreV2ShadowGateReadiness` over `chat_v2_replay_bundles`.

Persistence note: WP-09 only **asserts** recall in CI. The persisted
`recall_at_8_latest` that opens `gateCanPromote` is written by WP-13's
`upsertRecallAt8()` (first call via WP-19-seed); neither exists yet, so the CI
assertion never persists.

Until 1–3 hold, `evaluateChatCoreV2ShadowGateReadiness().gateMet` stays the
literal `false`.

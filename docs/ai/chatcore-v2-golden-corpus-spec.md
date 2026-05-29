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

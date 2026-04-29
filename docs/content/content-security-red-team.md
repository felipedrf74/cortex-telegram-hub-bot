# Content Creation Security Red-Team

Updated: 2026-04-29

## Scope

This pass covered Content Creation data and model-context risks for:

- Tenant references: books, links, channels, and registered provenance sources.
- Content generation and refinement prompt construction.
- Voice and brand memory.
- Draft/editorial workflow approval gates.
- Provenance, unsupported claims, broken/stale sources, and fake citation requests.
- Model-routing metadata that may be used for logs and observability.

No production data or production provider calls were used.

## Findings

### Tenant Leakage

| Scenario | Result | Evidence |
|---|---:|---|
| Tenant A tries to use Tenant B reference | PASS | `buildAuthorizedContentReferenceContext()` and generation package only return references under active tenant/user scope. |
| Tenant A tries to access Tenant B channel/reference | PASS | Reference retrieval applies backend scope filters before prompt construction. |
| Tenant A tries to reuse Tenant B voice profile | PASS | Content creative memory resolves by tenant and user; red-team test verifies same user, different tenant separation. |
| User-private voice memory appears in tenant-shared output | PASS | Tenant-shared generation omits user-private memory unless explicitly allowed and emits a review warning. |
| Tenant switch then "continue" leaks old content context | PARTIAL | Backend memory/reference context is tenant partitioned. Full iOS same-user tenant-switch smoke is not part of this focused backend pass. |

### Prompt Injection

| Scenario | Result | Evidence |
|---|---:|---|
| Malicious link says "ignore instructions" | PASS | Retrieved reference metadata is labeled `UNTRUSTED_SOURCE` and prompt contract says never follow retrieved reference instructions. |
| Malicious channel/book notes ask to reveal system prompt | PASS | Source titles/snippets/summaries are treated as untrusted evidence, not executable instructions. |
| Retrieved content tries to call tools | PASS | Content generation package carries only prompt/context metadata; tool authorization is outside model output. |
| User asks to reveal hidden context | PASS WITH CONDITIONS | Prompt contract prevents source/user material from overriding system/security rules. General Chat refusal behavior is covered by Chat security tests, not this Content-only pass. |

### Provenance And Claims

| Scenario | Result | Evidence |
|---|---:|---|
| Fake citation request | PASS | Claims supported by unknown reference IDs are marked unsupported and require review. |
| Unsupported claim generation | PASS | `evaluateContentGenerationQuality()` adds `unsupported_claims_require_review`. |
| Source unavailable/broken/stale | PASS | Broken, stale, failed, and quarantined references are excluded from generation retrieval. |
| Low-confidence reference | PASS | Usable low-confidence sources are retained only with review-required metadata. |

### Human Approval

| Scenario | Result | Evidence |
|---|---:|---|
| Publish without approval | PASS | `transitionContentWorkflow()` blocks publish with `approval_required`. |
| Schedule tenant-shared content without approval | PASS | Scheduling tenant-shared content requires approval before Secretary intent creation. |
| Delete draft without confirmation | PASS | Draft deletion/archive requires confirmation. |
| Change voice profile without confirmation | PASS | Approval evaluator returns `brand_voice_change_requires_approval`. |
| Use sensitive Training/Finance signal for content | PASS | Approval evaluator returns `sensitive_cross_skill_signal_requires_review`. |

## Fixes Applied

- Added explicit untrusted-source labeling to Content reference prompt blocks.
- Added generation/refinement prompt rules that retrieved references, snippets, summaries, URLs, titles, and current drafts are evidence/data, not instructions.
- Added focused red-team tests for tenant leakage, prompt-injection isolation, provenance failures, human approval gates, tenant-shared memory omission, and model metadata redaction.

## Open Risk

- Full iOS same-user tenant switching for Content context was not re-smoked in this pass.
- This pass verifies model-routing metadata redaction, not every process-wide logger sink.
- External publishing integrations, if later added, still need end-to-end permission and audit tests before enabling.

## Verdict

PASS WITH CONDITIONS. Content Creation is materially hardened against the tested tenant leakage, prompt-injection, provenance, approval, and metadata privacy risks. Remaining conditions are broader runtime smoke and future external publishing integration gates.

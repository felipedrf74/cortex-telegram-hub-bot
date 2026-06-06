# Content Provenance Model

Updated: 2026-04-29

## Output Provenance

`content_output_provenance` stores the provenance envelope for generated or refined content outputs.

Tracked fields:

- tenant/user/scope
- output object type
- output ID
- grounding status
- references used
- claims made
- unsupported claims
- source summaries used
- radar signal lineage
- reused-from content lineage
- review-required flag

Grounding statuses:

- `grounded`: all claims are tied to known references.
- `partially_grounded`: some claims are supported and some are not.
- `ungrounded`: no claims are supported by known references.

## Claim Handling

Claims are represented as:

```json
{
  "id": "claim-1",
  "text": "The claim text",
  "supportedBy": ["book:12"],
  "confidence": 0.8
}
```

`assessClaimsGrounding()` flags claims as unsupported when:

- `supportedBy` is empty
- a cited reference ID is not in the authorized reference set
- a hallucinated reference ID is supplied
- a cross-tenant reference is not available to the active user

## Source-Output Links

`content_source_output_links` records source-to-output lineage separately from the generated text.

This supports:

- provenance review
- duplicate/reuse detection
- source attribution
- evaluation harness checks
- future iOS/portal source cards
- support/debug investigation

## Refinement Preservation

The model is designed so refinement paths can keep prior provenance:

- the refined output can reuse the same source references
- unsupported claims can remain flagged until resolved
- new claims can be assessed against existing or new references
- repurposed outputs can link to parent content through `reused_from_content_id`

Current limitation: not every script/refinement route calls the provenance recorder yet.

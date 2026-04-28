# Final Training Engine Merge Recommendation

Date: 2026-04-28

## Decisive Recommendation

**Treat `feature/training-engine-eval-harness` as the primary backend merge candidate.**

Do not merge Claude's original branch directly. Do not treat the earlier Codex second-opinion branch as the final candidate either. The current `feature/training-engine-eval-harness` branch is the best candidate because it combines:

- Claude's useful architecture foundation
- Codex second-opinion corrections
- catalog-depth upgrades
- normalized profile layer
- metrics/feedback/autoregulation layer
- lifecycle and agenda hardening
- biomechanics/substitution hardening
- explainability/observability pass
- cross-skill orchestration pass
- evaluation harness
- final red-team fixes

## Merge Verdict

| Question | Answer |
| --- | --- |
| Is the branch the correct primary candidate? | Yes. |
| Is it production-ready today? | Not yet. |
| Is it stronger than Claude-only work? | Yes, materially. |
| Should the branch be split before merge? | Prefer one reviewed Training workstream merge if diff hygiene is acceptable; otherwise split by backend layer but preserve this branch as source of truth. |
| Should iOS readiness branch merge too? | Yes, but as a coordinated frontend compatibility merge, not as proof that backend is production-safe. |

## Required Gates Before Merge To Main

1. Resolve `RT-OPEN-001`: travel-week/poor-recovery schedule overload.
2. Resolve `RT-OPEN-003`: regenerated session identity after shape changes.
3. Run `npm run typecheck`.
4. Run full backend `npm test`.
5. Run Training benchmark and require score at least `95`, with no critical failures:

```bash
npm run eval:training -- --out-dir reports/training-red-team --week-start 2026-04-27 --fail-under 95
```

6. Run staging Google/Outlook provider smoke:
   - create plan
   - sync agenda
   - cancel plan
   - regenerate plan
   - verify no orphan/duplicate events
7. Run iOS simulator smoke against rich payloads:
   - gym-heavy week
   - running week
   - cycling week
   - hybrid week
   - `availability_capped`
   - `availability_reflowed`
   - `availability_unscheduled`
   - canceled/superseded/replaced plan state

## What To Keep

| Area | Keep? | Reason |
| --- | --- | --- |
| Coach-kernel layered architecture | Keep | It gives explicit, testable planning seams. |
| Session coherence validator and repair path | Keep | It fixed the original false-duration class at root. |
| Rich catalog metadata and modality archetypes | Keep | This is the domain-depth foundation. |
| Normalized training profile model | Keep | Raw questionnaire storage is no longer masquerading as personalization. |
| Feedback-analysis layer | Keep | It makes adaptation typed and inspectable. |
| Biomechanics/substitution layer | Keep | It improves safety and realism without medicalizing the coach. |
| Agenda ownership/reconciliation model | Keep with final hardening | It is the right lifecycle model, but identity/capacity risks remain. |
| Evaluation harness | Keep and gate future work | It prevents regression into template changes disguised as intelligence. |
| iOS dynamic frontend readiness work | Keep | It prevents the frontend from flattening richer engine output. |

## What To Fix Before Production

| Priority | Fix | Owner |
| --- | --- | --- |
| P0 | Final availability capacity reconciler for overloaded weeks | Backend |
| P0 | Regenerated session identity/version/shape hash | Backend |
| P0 | Staging provider agenda smoke | Backend QA |
| P1 | iOS rich payload smoke and fixture tests | iOS QA |
| P1 | Rich feedback UI | iOS + backend route persistence |
| P1 | Poor-recovery variant expansion | Backend |
| P1 | Weak-profile warning surfacing | Backend + iOS |

## Branch Recommendation

| Branch | Recommendation |
| --- | --- |
| `feature/training-engine-eval-harness` | Primary backend merge candidate. |
| `feature/training-engine-codex-second-opinion` | Historical source of key corrections; superseded by eval-harness workstream. |
| `feature/training-engine-intelligence-and-agenda-overhaul` / Claude work | Do not merge directly; useful foundation already reviewed and selectively retained. |
| `feature/ios-training-frontend-engine-readiness` | Merge as coordinated iOS compatibility layer after backend contract review. |

## Production Recommendation

**No production promotion yet.**

The Training engine is strong enough for merge-review and staging validation, but the product promise is calendar trust plus adaptive coaching. The two high open risks still touch that trust boundary. Fix them before prod.


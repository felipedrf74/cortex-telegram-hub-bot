# Sensitive Signal Policy For Content Creation

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Principle

Content Creation may use cross-skill context only when it is authorized, tenant-scoped, useful, and safe to turn into creative work.

It must not turn private health, finance, calendar, or personal-context details into content without user permission and review.

## Policy Levels

| Policy | Meaning | Behavior |
|---|---|---|
| `auto_use` | Low-risk signal that can inform Radar automatically. | Create normal Content Radar signal. |
| `anonymize_summary` | Signal may inform planning, but raw details must not be used. | Strip evidence/private details; keep safe summary. |
| `requires_review` | Signal is sensitive or permission is missing. | Create review-required Radar signal; do not convert automatically. |
| `do_not_use` | Signal is prohibited. | Reject; no Radar state is created. |

## Automatic Or Low-Risk Examples

- Training milestone or consistency streak with permission.
- Cooking routine, recipe, prep system, or lifestyle process.
- Chat recurring question or repeated user theme.
- Secretary content cadence summary that does not expose private event details.

## Summary-Only Examples

- Finance budget constraint.
- Purchase decision context.
- Secretary workload pressure.
- Cooking nutrition lesson without specific health claims.
- Sensitive signal where permission was granted but raw details are not needed.

## Review-Required Examples

- Training struggle.
- Recovery insight.
- Health-adjacent context.
- User correction involving private or tenant-sensitive details.
- Sensitive cross-skill signal without explicit permission.
- Low-confidence source signal.

## Prohibited Examples

- Raw account balance.
- Transaction detail.
- Medical detail.
- Private calendar raw event.
- Secrets, tokens, credentials, or credential-like values.

## Enforcement

Implemented in:

- `evaluateContentSignalPolicy()`
- `consumeContentCrossSkillSignal()`

The enforcement happens before Content Radar conversion and before model prompt construction.

## Release Notes

The backend foundation is implemented and tested. Product release still needs:

- UI/API approval flows;
- audit logging for human review decisions;
- local full-product smoke;
- portal/iOS rendering of sensitive-signal status.

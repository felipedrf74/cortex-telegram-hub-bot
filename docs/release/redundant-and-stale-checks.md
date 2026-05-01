# Redundant And Stale Checks

Date: 2026-05-01

| Check | Current pattern | Problem | Recommendation | Replacement / guard |
| --- | --- | --- | --- | --- |
| Full backend verify after docs-only edits | Rerun `npm run verify` after stale SHA/test-count fixes. | High cost, no product-code signal. | Run only doc validation and `git diff --check`. | Require full verify only if source/test/package/migration files changed. |
| Full iOS suite for backend-only changes | iOS full tests requested in cross-skill backend prompts. | Slow and unrelated unless API contracts changed. | Conditional. | Run iOS focused decoder tests only if app-facing contract changed; full suite on iOS release candidate. |
| Provider calendar smoke when candidate unchanged | Repeated Google/Outlook smoke requested even if backend candidate unchanged. | Real provider setup and cleanup are expensive. | Conditional. | Rerun only if calendar/agenda/provider files or migrations changed since last provider smoke SHA. |
| Portal smoke when portal unchanged | Portal browser smoke repeated after backend docs/focused service changes. | Browser/env setup cost with little signal. | Conditional. | Run if `src/portal`, portal routes, auth/session, or portal-facing API changed. |
| Local full-product smoke plus generic staging smoke for same route shape | Both validate app-facing route availability. | Some overlap; staging still needed before prod. | Keep both but change purpose. | Local smoke for development confidence; staging smoke for deployed artifact only. |
| Manual SHA/test count checks in every prompt | Every QA pass rechecks stale references. | Causes loop of doc-fix QA. | Automate. | `scripts/release-identity.sh`; later add stale-doc checker. |
| Historical reports as active blockers | Old QA reports remain in current-read path without superseded markers. | Agents can reopen refuted/closed issues. | Move to historical index. | One current release summary points to active blockers only. |
| Name-only simulator destinations | `destination "platform=iOS Simulator,name=iPhone 17 Pro"` appears in docs/scripts. | Can spawn/select clones and invalidate UI evidence. | Retire for UI tests. | Use selected UDID and parallel simulator destinations disabled. |
| Rechecking branch/backup workflow for tiny docs commits | Every prompt restates branch/tag backup workflow. | Costly ceremony when no product code changes. | Conditional. | Required for product changes; docs-only can use normal local commit with clean status. |

## Checks To Keep Unchanged

- Staging smoke before production promotion.
- Owner approval before production promotion.
- DB snapshot decision when migrations/data changes are in scope.
- Tenant/security gates for auth, retrieval, memory, portal/admin, model prompts.
- Calendar no-duplicate/provider cleanup when calendar provider behavior changes.

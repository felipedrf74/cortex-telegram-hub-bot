# Nexus Hub Release Candidate Merge Plan

Generated: 2026-04-29

## Branches

| Repo | Branch | Current validation commit |
|---|---|---:|
| Backend | `release/nexus-hub-production-candidate` | `34add9aa8b05c100b28a116fa12b920e118e4d15` |
| iOS | `release/nexus-hub-production-candidate` | `dd7e3e0163e5e3ee37360d3f0ffbaca54fdfb7a2` |

## Merge Verdict

**Do not merge directly to production from the local RC branch.**

The RC passed local regression with conditions. Merge is allowed only after the branch work is committed, pushed, reviewed, deployed to staging, and focused staging smoke passes.

## Preconditions

Before merge:

1. Review dirty status in both repos.
2. Commit the backend RC changes with the release docs and test mock fixes.
3. Commit the iOS RC changes with the rich-state/cache fixes and iOS docs.
4. Push both release branches.
5. Confirm no P0 blockers are open.
6. Explicitly accept or close the P1 conditions in `docs/release/nexus-hub-open-blockers.md`.
7. Preserve live model-routing behavior and operator overrides.
8. Ensure release copy does not claim:
   - a fixed GPT/Gemini/Claude runtime default,
   - complete WebSocket streaming,
   - complete same-user multi-workspace Chat switching,
   - universal Secretary ownership for unported write paths,
   - universal shared-context tenant mesh safety before the remaining mesh gaps are closed.

## Backend Merge Sequence

1. Run final local verification:

```bash
npm run verify
npm run build
```

2. Commit release work:

```bash
git add .
git commit -m "Prepare Nexus Hub production candidate"
git push origin release/nexus-hub-production-candidate
```

3. Open review / PR into `main`.

4. After approval, merge to `main`.

5. Deploy exact merged commit to staging.

6. Run focused staging smoke:

- Chat tenant-safe send/history.
- Chat day-to-day fast path.
- Secretary scheduling path used by release claims.
- Calendar/agenda smoke if release claims include provider lifecycle behavior.
- Auth/session and tenant context.
- Model-routing metadata check without raw prompt leakage.

7. If staging smoke fails, stop and fix on the release branch or a follow-up RC branch.

8. If staging smoke passes, take a fresh production DB snapshot immediately before production promotion.

9. Promote to production using the standard deploy pipeline.

10. Run production health checks and record results.

## iOS Merge Sequence

1. Run final iOS test/build:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro"
xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build
```

2. Commit release work:

```bash
git add .
git commit -m "Prepare Nexus Hub iOS production candidate"
git push origin release/nexus-hub-production-candidate
```

3. Merge to `main` only after backend staging is healthy.

4. Build/sign TestFlight or release candidate using the normal Apple workflow.

5. Validate against staging/production target:

- Home reaches intended backend.
- Chat list and history are tenant-scoped.
- Chat message send/render works.
- Secretary/Training rich states decode safely.
- Unknown message/block types fall back safely.
- Local backend overrides are not accidentally persisted into production smoke.

## Staging Gate

The staging gate is mandatory. Required result:

**PASS** for focused staging Chat smoke before production promotion.

If any staging smoke result is partial, the release owner must either:

- fix and rerun, or
- explicitly narrow release scope and document the accepted risk.

## Production Gate

Production promotion requires:

1. Fresh production DB snapshot.
2. Staging smoke pass on exact commit.
3. Backend and iOS release branches pushed.
4. Monitoring checklist ready.
5. Rollback plan reviewed.
6. Production health checks scheduled immediately after promotion.

## Post-Merge Monitoring

Monitor:

- Chat creation failures.
- Message send failures.
- Streaming failures and stuck messages.
- Tool-call failures.
- Skill routing failures.
- Tenant authorization failures.
- Retrieval/memory scope failures.
- Prompt-injection/security events.
- Unusual cross-tenant access attempts.
- Duplicate messages or calendar events.
- Stale tenant cache after switch.
- iOS decode/render errors.
- Provider/model/tier/category selected per request.
- Operator override applied or not.
- Fallback used or not, with fallback reason.
- Provider failure rate, latency, and token/cost estimates.
- Runaway model-call loops or repeated retries.
- No raw sensitive prompt/context leakage.

## Merge Recommendation

Proceed to review and staging only. Production remains gated by fresh snapshot, staging smoke, and production health checks.

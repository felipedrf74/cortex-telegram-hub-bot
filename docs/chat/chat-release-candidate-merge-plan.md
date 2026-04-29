# Chat Release Candidate Merge Plan

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`

## Current Candidate

The release candidate branch has been created locally. The working tree contains the Chat tenant/context/lifecycle/security workstream plus final hardening docs and the portal model-pin validation fix.

No commit, push, deploy, or production mutation was performed in this final hardening pass.

## Merge Preconditions

1. Human review confirms the RC diff contains only intended Chat/model-routing/portal/iOS-doc support changes.
2. P0 list remains empty for the REST release scope.
3. P1 deployment gates are closed or explicitly accepted:
   - fresh production DB snapshot before deploy; staging-clone proof for migration `084`/`085` is complete
   - WebSocket disabled
   - bounded provider smoke or restrained provider claims
   - no raw Chat support content
   - no true workspace switching claim
   - migration file history closed: this branch includes production/staging `082_training_session_identity_shape_hash.sql`, recovered `083_secretary_agenda_ledger.sql`, and Chat migrations renumbered to `084`/`085`
4. Required validation remains green:
   - focused Chat/security/provider regression suite
   - `npm run typecheck`
   - `npm run build`
   - `npm run chat:eval`
   - day-to-day simulation CLI
   - local full-product smoke evidence
   - iOS local smoke evidence
5. `.local/`, smoke DBs, auth JSON, provider keys, and reports that should stay local are not committed.

## Suggested Commit Structure

1. Chat tenant/security data model and migrations.
2. Chat context engine, routing, tool authorization, and lifecycle.
3. Evaluation/day-to-day simulation harness.
4. Portal diagnostics and model override validation.
5. Documentation and release-candidate package.

If preserving existing uncommitted authorship boundaries is important, split commits by the current workstream history rather than flattening everything.

## Staging Flow

1. Merge RC to `main` only after predeploy gates are accepted.
2. Deploy to staging through the standard deployment script.
3. Run staging health and focused Chat smoke.
4. Verify migration columns and quarantine state in staging DB.
5. Verify provider routing/operator override surfaces do not expose raw prompt content.
6. Verify WebSocket remains disabled unless separately approved.
7. Update release notes with exact staging evidence.

## Production Flow

1. Take predeploy production DB snapshot.
2. Promote the same tested commit.
3. Run production health:
   - auth
   - Chat history
   - safe deterministic Chat message
   - provider health/diagnostics
   - portal metadata diagnostics
4. Monitor the first hour:
   - Chat 4xx/5xx rates
   - idempotency conflicts
   - stuck message lifecycle states
   - provider fallback/cost spikes
   - tool authorization denials
   - prompt-injection weak-context signal volume
5. Keep rollback commit and DB snapshot immediately available.

## Do Not Merge If

- Any P0 tenant/security issue is found.
- WebSocket streaming is accidentally enabled without parity tests.
- Migration rehearsal fails.
- Release copy claims GPT-only, true workspace switching, raw support-console review, or streaming readiness.
- Provider fallback/operator pin smoke is skipped while release copy claims live provider/fallback quality.

---
name: release-operator
description: Prepare, inspect, stage, promote, or recover an exact Nexus Hub backend release. Use for release manifests, immutable bundles, staging parity, PM2 cutover, rollback, production status, or backend and iOS contract-bound promotion. Production mutation always requires explicit owner authorization.
---

# Nexus Release Operator

Start with `git status --short --branch` and
`docs/release/release-state.json`. Operate from a clean checkout whose HEAD is
the exact current protected `origin/main` SHA.

The only supported commands are:

```bash
npm run release:status
npm run release:prepare
npm run release:prepare -- --checkpoint-run <run-id>
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:promote -- --confirm <full-sha>:<artifact-sha256>
npm run release:chat-flags -- inspect ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:chat-flags -- apply ...
npm run release:chat-flags -- inspect-secrets ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:chat-flags -- apply-secrets ...
npm run release:chat-flags -- inspect-observation ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:chat-flags -- apply-observation ...
```

The explicit GitHub release checkpoint reuses the protected-main artifact. It
combines the already-passing selected tests with only the untested deterministic
remainder across four shards, runs Python and migration work only when
applicable, and publishes `nexus.release-checksum-manifest.v1`. The manifest is
unsigned: trust comes from exact workflow/SHA binding, authenticated GitHub
artifact download, SHA-256 verification, branch protection, and explicit owner
approval. It also records the sorted test groups from the cumulative deployed
SHA to target SHA diff. Promotion requires an exact-SHA passing local
`local_engine` chat evaluation only when those cumulative groups include
`chat-secretary`; unrelated releases skip it automatically, with no bypass.

`release:prepare` verifies the manifest and original artifact locally, stores
the manifest SHA-256, uploads the bundle once, and submits the staging phase
through `systemd-run --user`.
It stops after staging with `ownerApprovalRequired: true`. `release:promote`
requires the exact SHA and digest confirmation and submits a separate
user-owned production transaction. Losing the Mac or SSH session does not stop
either active server phase.

After the chat-flag operator lands in protected main and its exact artifact is
deployed, `release:chat-flags` is the only supported capability mutation path.
It is hardcoded to `ServerDominguez`; never add or use a host override, and
never route it through AWS. Run it from a clean checkout of the exact installed
runtime SHA. Inspect produces one redacted SHA/artifact/role/state/evidence
plan; apply requires explicit owner authorization, acknowledges only that
exact digest, consumes it once, and polls the detached transaction's strict
receipt. Do not claim a rollout from an inspect plan or narrative report.

The server collects provider-free gate evidence from the installed candidate
and isolated staging database. Routing inspect requires one explicit immutable
UTC window and uses a non-configurable 200-comparison minimum at 0.99
agreement. Manifest-prompt inspect runs the compiled installed action-skill
gate cache-only at 300/300 rows, at least 0.95 agreement, and zero provider
calls; the separately owner-authorized cache fill must already be complete.
Cross-skill staging inspect binds the compiled preflight JSON.

After one staging flag is ON for at least five minutes, use
`inspect-observation` and the separately owner-authorized
`apply-observation`. The inspected plan binds the exact release, flag, enable
receipt and sequence, contiguous configured/effective prefix, expected next
production sequence, smoke bytes/profile, master kill OFF, and every ChatV2
shadow-planner scope effectively OFF. Apply revalidates that plan and runs the
installed canonical staging smoke exactly once. Its v2 locale profile uses the
token-zero authenticated-identity route for English, Portuguese, and a legacy
Spanish-request-to-English compatibility check; it does not claim task-write
planner or model-authored locale coverage. Fixture users `1000014` and
`1000016` are inserted only when absent or safely updated after an exact
synthetic ID/Telegram/email/username/auth-provider marker match; any collision
fails before dependent writes, and the user row is never replaced. The receipt
also requires zero
all-status durable alert activity since enable and zero `api_usage` and
hard-ceiling reservation deltas across the staging database during the
observation. The latter is the governed hard-ceiling ledger, not a claim that
every possible provider attempt mechanism has a universal ledger. For
`AI_CROSS_SKILL_EXECUTION`, the
same observation apply also runs and binds the installed dedicated Training
cross-skill smoke. That smoke binds every runtime read to one directly opened
readonly, `query_only` SQLite handle inside the standalone global-database
scope. It never invokes application database initialization, migrations,
backfills, or writes; the scope restores its binding and the owned handle is
closed afterward. Production never executes the smoke.

Production `inspect` is selector-only, read-only, and provider-free. It binds
the exact strict staging observation receipt and raw smoke already produced by
`apply-observation`; it never runs the smoke. Production `apply` re-fetches and
revalidates those exact bytes plus the staging flag evidence immediately
before mutation.

Roll out one flag at a time, in canonical order. For each flag: staging gate
inspect/apply, five-minute maturity, observation inspect/apply, production
inspect/apply, then another minimum five-minute production observation.
Production apply must revalidate the exact staging ON receipt and observation,
full configured/effective prefix, master-kill state, exact release identity,
and current staging health immediately before production mutation. Every
staging and production release transaction refuses to begin unless all seven
capability flags are omitted (runtime-default OFF) or canonically configured
`false`; return enabled flags to OFF through sequential governed rollback
transactions before a later release. Evidence never transfers between release
identities.

Provision the two Phase 7 HMACs only with `inspect-secrets`/`apply-secrets`.
Existing values are never rotated. Staging may generate either missing HMAC;
production requires the classifier HMAC to exist and may generate only a
missing ChatV2 route HMAC. Values, hashes, fingerprints, and lengths never
enter the plan or receipt. During mutation, require the short-lived exact
runtime permit; an invalid permit forces capabilities OFF. Preserve atomic
private `.env` backup/restore and backend-only restart. Use a governed OFF
transaction for ordinary rollback and `AI_ROUTING_MANIFEST_KILL=true` for an
emergency all-capability stop; clear the kill only after all seven flags are
configured OFF.

Never accept an operator-supplied manifest. Before promotion, revalidate the
exact checkpoint run and re-download its exact named manifest artifact. Cached
and re-downloaded bytes and SHA-256 must agree. Run the conditional exact-SHA
chat preflight before the first production SSH, including resume-state queries,
and repeat it independently in the new-transaction helper. The observed
production predecessor SHA must equal the manifest's canonical protected
release-state SHA before mutation.

- Treat the full source SHA plus artifact SHA-256 as the promotion identity.
- Never rebuild, install dependencies, run tests, or run Sonar on the server.
- Keep local evidence under ignored `.local/release/`; remote state lives under
  `/home/dominguez/.local/state/nexus-release/`.
- Use the existing production and staging layouts under
  `/home/dominguez/telegram-hub-bot{,-staging}`.
- Preserve the pre-promotion SQLite backup, atomic `current` switch, PM2
  `startOrReload`, 60-second production soak, and automatic exact-predecessor
  rollback.
- Do not run Sonar concurrently with staging or production; both use the same
  user-owned remote mutex.
- Do not restore signing workflows, `ReleaseManifestV2`, root promotion
  controls, KVM drills, AWS release dependencies, or duplicate state stores.
- Do not deploy, push, expire TestFlight builds, or delete remote branches
  without explicit authorization.
- If a backend/iOS contract changes, prove compatibility through the canonical
  iOS release process before owner approval. Do not mislabel a shared contract
  release to bypass that proof.

Before handoff, run `npm run docs:audit`, the selected risk gate, and the
`verifiable-reward-check` skill. Report missing staging, device, or owner proof
as `MANUAL_REQUIRED`; never convert narrative text into release evidence.

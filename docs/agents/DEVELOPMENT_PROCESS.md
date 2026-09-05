# Nexus Hub Development Process

Policy-Version: 2026-09-05.1
Owner: Felipe

This is the shared development policy for Codex, Claude, Grok and other coding
agents across backend, iOS and the product workspace. It governs development,
not the models running inside the application. Repository bootloaders supply
local commands; product contracts and release authorities retain their scope.

## Start and authority

Read the task checkout's AGENTS.md, this policy, the product brief, and only the
domain material needed. Run `git status --short --branch`; record HEAD, base
revision and dirty state. Check current main when making freshness claims.
A stale checkout is not current project truth. Preserve it and use an isolated
checkout for new implementation. Never silently switch another task's branch.
Generated guidance copies carry source hashes; missing or divergent guidance
is an explicit limitation, not permission to invent project rules.

Felipe's chosen model and effort are authoritative session settings. Do not
assign mandatory models, impose minimum effort, silently substitute models or
change settings. Apply the same acceptance criteria to every model. Load
MODEL_GUIDANCE.md only when writing or adjusting a development prompt.

## Plan and prompt

Start with the outcome, then relevant context, scope and authority, acceptance
criteria, and required evidence. Name what completion means for this task.
Resolve discoverable facts through inspection. Ask only when a material choice
changes behavior, scope or authority; state routine assumptions and continue.
Use grill-me for requested interviews or unresolved consequential decisions,
not a mandatory interview for every feature. Plans cover affected contracts,
failure modes, verification and rollout only to the depth the change needs.

For implementation requests, continue safe authorized local work and relevant
verification without repeated permission requests. An approved plan authorizes
its in-scope implementation; it does not silently authorize commits, pushes,
remote deletion, releases or unrelated fixes. Existing explicit authorization
persists. Manual recovery, infrastructure changes and destructive exceptions
still require their documented authority. Ordinary protected-main CD remains
unattended after an authorized merge; do not invent a per-release owner GO.

## Ownership and continuity

Use the existing product work registry for durable work, not session reports.
The local `agent:task` ledger records operational ownership and resources only.
Register task id, owner, base, owned paths and dependencies before parallel
implementation. Overlapping writers serialize or agree an explicit handover.
Read-only reviews may overlap. Never infer that an expired or silent session
has surrendered its work. Release ownership explicitly when pausing or ending.

Delegate bounded independent work when it helps; no default fan-out or fixed
model roles. One integrator owns shared-file reconciliation. Handoffs preserve
the user's outcome, decisions, authority, current revision, evidence and open
dependencies. Compaction must retain these facts, especially changes of scope.

## Verification and review

Use repository risk selection. Backend tests retain core safety, affected owner
groups, direct dependencies and changed tests; iOS uses its E0–E4 evidence
ladder. Security, tenancy, contracts, migrations and regression checks remain
mandatory when applicable, regardless of model or effort.
Reuse evidence only for unchanged source, dependencies, configuration,
environment and verifier inputs. After a fix, rerun affected checks; broaden
when new risk or failures justify it. Do not add repeated generic self-checks.
Use a fresh-context read-only reviewer for substantial or high-risk changes.
Resolve blockers, re-review affected fixes, and stop at the documented round
cap with open findings. Review is not authorization to merge or deploy.

Reward checks summarize evidence; neither scores nor advisory hooks replace
tests, independent review, signed release evidence or required device proof.
Planning/read-only work uses source review; do not create files merely to earn
a reward verdict. Missing evidence stays explicit, never a manufactured PASS.

## Delivery and closeout

Keep local implementation, tests, integration, backend deployment, TestFlight
and App Store publication separate. Backend release truth is the root-owned
VPS observer and its bound immutable receipts; checked-in projections are not
live proof. iOS distribution follows its own cadence and acceptance gates.

Use `agent:task complete` to release finished task ownership (also valid on
shared/primary checkouts). It does not certify tests or integration. Use
`agent:task closeout` separately for verified integrated resource retirement.
It defaults to a preview. The approved automatic cleanup policy permits apply
for registered task scratch/processes and clean, integrated task-owned local
worktrees/branches only after active-task and dependency checks. Unregistered,
dirty, unmerged or ambiguous resources remain. Never delete the primary
checkout, another task's work, secrets, data, rollback artifacts or receipts.
Preserve evidence outside a worktree before retiring it. Remote deletion and
TestFlight expiry are not part of automatic cleanup.

Return the outcome, evidence, remaining limitations and cleanup state. Update
one owning canonical document only for durable changes; operational evidence
stays ignored or in CI. No routine Markdown handoff, audit or final report.
Track time/check counts and rework in the task ledger; compare actual workflow
samples before claiming faster delivery or unchanged regression rates.

## Local command contract

Run `npm run agent:context` in backend/workspace, or
`node scripts/development-guidance.mjs --startup` in iOS, for checkout identity
and portable-guidance checks. The task CLI below is provided by the backend;
use its `--repo <checkout>` option for a paired repository. If that tooling is
unavailable, preserve resources and report the cleanup inventory.
Use `node scripts/development-guidance.mjs --sync --target <repo>` to regenerate
workspace/iOS copies, then `--target <repo> --offline` to check them without
home-directory or network access. The source hashes, not a claimed latest
version, bind copies; regenerate after the reviewed backend revision lands.

`npm run agent:task -- --help` documents the local ledger CLI. `start --spec`
reads a JSON object with id, owner, mode (read/write), owned paths and optional
dependency ids. Model/effort fields are informational, never selectors.
`check --id ... --owner ... -- <command>` records exit status, duration and
source fingerprint, without persisting command output. This records evidence,
not whether an arbitrary command satisfies the risk gate; the reviewer checks
that the required commands ran. `launch` registers only a process it starts.
`release` pauses ownership; `complete` explicitly finishes it. Paused sessions
remain protected. `closeout` previews; `--apply` retires eligible resources from
another checkout. Quarantined scratch and verification records remain under
the common Git directory's nexus-agent-tasks store. That local operational
ledger never replaces the product work registry or release receipts.

The cleanup helper cannot infer ownership of pre-existing or external processes.
It sends TERM only to identity-matched registered processes; surviving handles
or an unavailable process census retain the worktree. It never forces worktree
removal. Integration requires ancestry in origin/main or an identical complete
tree for squash integration; ambiguous squash/cherry-pick cases remain.

An interrupted ledger lock fails closed. Do not remove it while another agent
may be writing; recovery requires proving the previous writer has ended.
Interrupted retirement can resume after the ledger is safely unlocked.

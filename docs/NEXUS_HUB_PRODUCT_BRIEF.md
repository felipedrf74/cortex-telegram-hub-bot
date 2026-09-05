# Nexus Hub Product Brief

Owner: Felipe
Scope: durable context for development agents. Code/contracts prove current
implementation; live release receipts prove delivery. Git history retains prior
audits. Do not treat an old status snapshot as current product truth.

## Product and surfaces

Nexus Hub is a personal operating system for individuals: solo founders,
athlete-creators and freelancers. It combines deterministic daily operations
with bounded AI reasoning across Secretary, Training, Content, Cooking and
Finance. Decision Center is a platform capability, not a sixth skill.
Secretary appears through Home, Tasks, Calendar/Plan, Inbox, decisions and chat;
the Skills hub contains Training, Content, Cooking and Finance.

Secretary owns planning/tasks/calendar coordination. Training covers governed
coaching, readiness, exercise media and plans. Content covers research,
workspaces, generation, review and publishing. Cooking covers recipes, pantry,
allergies, shopping and meal planning. Finance covers expenses, invoices and
financial records; subscription billing/entitlements are platform-owned.

The iOS app and web portal use the backend. The Python Content Engine is a
bounded internal service, not a second public authority. New user-facing
behavior must work across applicable surfaces and represent loading, empty,
partial, stale, unavailable, blocked and failed states honestly.

## Contracts and safety

[OpenAPI](contracts/openapi-v1.yaml) is the canonical app-facing `/api/v1`
HTTP contract. Operational reads/writes use typed deterministic REST/tool
contracts; chat uses the reasoning/action flow. Explicit model-backed endpoints
remain bounded by entitlement, budget and authorization. Do not turn ordinary
buttons or lookups into fake chat commands.

AI proposes; deterministic policy authorizes and executes. Preserve consent,
confirmation, entitlement, idempotency, provider ownership and authoritative
read-back. A generated claim is never proof of a completed operation.

Preserve user/tenant isolation across requests, jobs, caches, memory, prompts,
provider fallbacks, notifications and files. Authenticated scope comes from the
server, never model output. Keep secrets and private production content out of
logs, evidence and prompts. Domain/provider failures preserve honest partial
state. Use the existing provider abstractions and quota controls.

Contract changes update backend DTOs, OpenAPI and compatible iOS decoding in
one coordinated delivery wave. Read models are rebuildable projections, not
source authority. Shared calendar effects, notifications and background work
need explicit ownership and duplicate prevention.

## Experience

Use shipped semantic design tokens and accessible native patterns. Preserve
Dynamic Type, VoiceOver, Reduce Motion and light/dark behavior. Do not invent
new brand rules from old screenshots. English, pt-BR and pt-PT are supported
product languages; localize complete flows without mixed-language strings.
Prefer concise, useful copy and honest error states. Repository/domain design
standards own exact presentation details. Escalate consequential unresolved
product/design choices rather than silently resolving contradictory references.

## Development and delivery

[Shared development policy](agents/DEVELOPMENT_PROCESS.md) owns planning,
prompt structure, model/effort freedom, task ownership and closeout. Backend
AGENTS.md and the iOS bootloader supply local commands and engineering routes.

[Continuous deployment](release/continuous-deployment.md) governs unattended
backend releases. Only the root-owned VPS observer and bound immutable receipts
establish runtime delivery. Local tests, integration, backend deployment,
TestFlight and App Store availability are separate evidence levels. Do not
infer feature activation or acceptance from a healthy deployment alone.

For native implementation, read the iOS repository's engineering index and
E0–E4 validation checklist. Preserve the iOS 18 deployment minimum unless
Felipe approves a change. Account isolation, live-provider and physical-device
claims need their actual proof. iOS distribution is separate from backend CD.

Detailed domain rules live in the project map, engineering standards, contracts
and capability manifests. Load them on demand, not every historical report.

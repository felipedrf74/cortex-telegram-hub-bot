# Cross-Skill Content Orchestration

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Goal

Content Creation now has a backend orchestration layer for consuming safe, tenant-scoped signals from other Nexus skills and emitting useful downstream signals back to Secretary and Chat.

Implemented code:

- `src/services/content-cross-skill-orchestration.ts`
- `__tests__/services/content-cross-skill-orchestration.test.ts`

This builds on:

- `src/services/content-radar-engine.ts`
- `src/services/content-editorial-workflow.ts`
- `src/services/content-tenant-scope.ts`

## What Content Consumes

Training:

- milestones
- progress/streaks
- lessons
- routines
- struggles or recovery insights only with review/permission

Cooking:

- routines
- recipes
- prep systems
- lifestyle patterns
- nutrition lessons only with review when health-adjacent

Finance:

- budget constraints
- purchase decisions
- creator/business spend patterns
- review signals only as summaries, never raw account/transaction detail

Secretary:

- content work availability
- workload pressure
- cadence feasibility
- publishing/deep-work constraints
- private calendar details only as summarized cadence signals

Chat:

- recurring user questions
- unresolved ideas
- repeated themes
- user corrections with review when sensitive

## What Content Emits

To Secretary:

- writing blocks
- editing blocks
- publishing deadlines
- review tasks
- radar review blocks

These are emitted as `SecretarySchedulingIntent` objects with `sourceSkill = content`, preserving Secretary ownership of schedule placement.

To Chat:

- content ideas available
- content plan status
- source limitations
- pending approvals

These are emitted as scoped status signals, not raw prompt dumps.

## Tenant Safety

Cross-skill signals are rejected when `sourceTenantId` does not match the active Content tenant.

Signals that are accepted become Content Radar signals using the existing tenant-scoped `content_radar_signals` table. Repeated source signals use stable source references so duplicate/noisy warnings collapse to one radar row per tenant/user/source signal.

## Sensitive Signal Handling

The service classifies signals as:

- low sensitivity: may be used automatically;
- moderate: summarized/anonymized;
- sensitive: requires review unless permission is granted, and even then is summary-only;
- prohibited: rejected and never turned into Content Radar.

Examples:

- Training milestone with permission can become a content idea.
- Training recovery insight without permission becomes `review_required`.
- Finance budget constraint with permission becomes a low-cost workflow signal with private details stripped.
- Raw account balance, transaction detail, medical detail, private calendar raw event, or credential-like signals are rejected.

## Current Release Gate

Verdict: PASS WITH CONDITIONS for the backend orchestration foundation.

Open before full product release:

- Runtime hooks from Training/Cooking/Finance/Secretary/Chat into this service.
- UI/API approval surfaces for sensitive cross-skill signals.
- iOS/portal rendering of signal source, review status, and downstream implications.
- Full local product smoke with real Chat -> Content -> Secretary paths.

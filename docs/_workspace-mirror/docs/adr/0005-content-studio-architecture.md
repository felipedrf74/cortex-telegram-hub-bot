# ADR-0005: Content Studio architecture — four zones, one item, create-then-attach, hero as Decision Center renderer

Status: accepted
Decision date: 2026-06-10
Decided by: workspace lead (Felipe) + Claude (six multi-agent brainstorms + consolidation verification, 2026-06-09/10)
Last verified: 2026-06-10

## Context

The iOS Content skill grew feature-by-feature into a 1,822-line landing page
(`ContentSkillView`) fanning out to 12+ screens with three inconsistent
navigation patterns (sheet / push / conditional destination). Briefs, scripts,
schedules, tasks and notes for the same piece of content lived in four
disconnected tools; creation had five entry points; actions could not chain.
The IA mirrored backend capabilities instead of the creator's workflow.

## Decision

The Content skill is restructured as the **Content Studio**:

1. **Four zones** behind one in-screen pill switcher — Today (next best
   action), Pipeline (items by stage), Calendar (when it ships), DNA (voice,
   references, learnings, agency, journal). Navigation rule: create/edit =
   sheet; browse/drill = push; all `navigationDestination`s on the studio root.
2. **One unified content item** (backend entity: `ContentTopic` — ideas are
   read-only system artifacts; only topics have user CRUD). Brief, script,
   schedule, tasks, notes are facets of the item, not separate tools.
3. **Create-then-attach Composer**: capture files a planned topic immediately
   (both exits POST); develop/finalize are retry-safe PATCHes on a real id;
   discarding a pristine topic deletes it. Nothing is ever orphaned or
   local-only; quick capture is a thin client over the same fast path
   (capture-is-a-topic; thought/topic distinction resolved at triage via a
   demotion valve into notes, never at capture).
4. **The hero is a renderer, not a system**: content guidance flows through
   the existing Decision Center pipeline (the `DecisionExplanation` object is,
   per product truth, "the single user-facing guidance contract"). Today shows
   rank 1 large and ranks 2–4 as the "Needs you" queue (same ids — cross-surface
   contradiction structurally impossible). Secretary/Decision Logic v2 keep
   exclusive temporal authority; reasons must be substantiated by declared data
   sources (no audience-timing copy until a real source exists).

## Alternatives considered

- **Keep feature-indexed landing page, polish visually.** Rejected: every new
  capability adds a card; the fragmentation (no chaining, four homes per item)
  is structural, not cosmetic.
- **Paged horizontal zones (TabView swipe).** Rejected on engineering grounds:
  the studio is pushed inside the Skills NavigationStack (edge-swipe = back)
  and Pipeline itself scrolls horizontally — fatal gesture collision (scored
  3.7/10 across three evaluation lenses).
- **Deferred-commit Composer (local draft until final step).** Refuted by
  adversarial review: an entire develop session in plaintext UserDefaults
  violated the "nothing local-only" invariant and required two parallel state
  machines. Create-then-attach deletes the failure class.
- **A parallel `nextBestMove` recommendation contract for the hero.** Refuted:
  directly violates the product-truth rule against parallel presentation
  payloads and reimplements ranking/dedupe/acted-on truth Decision Logic v2
  already owns.

## Consequences

- **Positive**: one mental model (item moves through stages); one creation
  entry; hero/queue/Decision Center cannot contradict; ~180 inventoried legacy
  capabilities verified re-housed (13 caught and recovered during
  consolidation); 0 HIG blockers.
- **Negative**: custom mastheads forfeit free system large-title behavior
  (mitigated: a11y plumbing specced); dual code paths during the flag-gated
  rollout until Phase 4 retirement.
- **Operational**: iOS-first; tiny additive backend asks (sourceSkill filter
  exposure + totalContentCount, capture provenance in audit_metadata_json,
  Idempotency-Key on topic create) — Decision-Center-ranked hero is a
  follow-up consuming BE-1; client-side states ship first.

## Links

- Decision trail: Claude project memory `content-studio-redesign-proposal.md`
- Implementation plan: Claude plan `create-a-plan-considering-fluffy-gadget.md`
- Related code paths: `Nexus Hub/Views/Content/ContentSkillView.swift`,
  `Core/DeepLinkRouter.swift`, `Core/Repositories/ContentRepository.swift`,
  engine `src/api/routes/content-topic-routes.ts`, `src/api/routes/decisions.ts`
- Related ADRs: ADR-0003 (token-zero), ADR-0006 (serif register)

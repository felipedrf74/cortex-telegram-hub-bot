# Content Product Outcome Definition

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`
Rollback branch/tag: `backup/content-before-intelligence-upgrade-20260429-1636`, `backup-content-before-intelligence-upgrade-20260429-1636`
Mode: Product definition and audit kickoff. No deployment.

## Product Thesis

Content Creation should become the creative intelligence system inside Nexus. It should help a creator decide what to make, why it matters, which references support it, how it fits the user's voice, how it should be adapted per platform, when it should be produced, and how it should be reused without becoming repetitive.

Content Creation is not a generic idea generator. Excellent Content Creation is grounded, original, tenant-safe, memory-aware, platform-aware, and coordinated with the rest of Nexus.

## User Problems Content Creation Must Solve

- Creators have more raw inputs than production capacity: books, links, channels, notes, training progress, finance ideas, cooking/fueling moments, audience questions, and current events.
- Creators need output that sounds like them, not like a generic content template.
- Creators need source grounding and provenance so the system does not invent claims, references, or authority.
- Creators need novelty control so ideas, scripts, hooks, and captions do not repeat the same angle.
- Creators need a lifecycle from idea to brief, script, packaging, schedule, publish, performance learning, and reuse.
- Creators need Content to coordinate with Secretary so writing, filming, editing, and publishing load fits the real schedule.
- Creators need tenant/user memory boundaries so personal references, tenant content strategy, and shared content assets do not leak or blur together.
- Creators need Chat to orchestrate Content work safely without bypassing Content ownership or model-routing rules.

## What Excellent Outputs Feel Like

Excellent Content outputs should feel:

- Specific: anchored in the user's audience, platform, current content library, and selected references.
- Grounded: every meaningful claim, quote, source idea, or trend should have source attribution or clear uncertainty.
- Original: the system should explain novelty, reuse, and relationship to past content.
- Voice-consistent: output should respect creator profile, Voice DNA, banned patterns, tone, pacing, and language.
- Platform-native: scripts, hooks, captions, titles, threads, shorts, long-form outlines, and carousels should match the platform's norms.
- Actionable: output should include the next production action, required assets, likely schedule load, and review status.
- Honest: when context is stale, weak, missing, or low-confidence, the system should say so and ask targeted questions.
- Coordinated: Content should know when a creative recommendation creates schedule load, Finance implications, Training/Cooking relevance, or Secretary conflicts.

## What Bad Outputs Look Like

Bad Content outputs include:

- Generic "10 ideas" lists with no evidence, voice, audience, or next step.
- Hallucinated references, invented book claims, fake channel summaries, or unsupported trend claims.
- Repeated ideas, scripts, hooks, or captions without novelty/reuse intent.
- Platform-mismatched output, such as a YouTube script shaped like a tweet thread.
- Content that leaks another tenant's references, private user memory, or tenant-private strategy.
- Static templates disguised as intelligence.
- Hardcoded founder/operator preferences applied to ordinary users.
- Schedule recommendations that bypass Secretary or ignore real capacity.
- Model calls that bypass live routing, operator overrides, category metadata, or tenant-safe prompt construction.

## Quality Bar

Every serious generated artifact should be able to answer:

- What user goal or audience problem does this serve?
- Which references, memories, or signals influenced it?
- How fresh and reliable are those inputs?
- Which platform and format is it optimized for?
- What is the novelty or reuse relationship to prior work?
- What brand/voice constraints were applied?
- What must the user do next?
- What is uncertain or missing?

## Must Never Happen

- Never leak content references, memory, prompts, generated artifacts, attachments, or source snippets across tenants or unauthorized users.
- Never rely on the model to enforce tenant security.
- Never claim a source was used when the system did not retrieve or validate it.
- Never hardcode GPT, Gemini, Claude, or any fixed production provider as Content's runtime default.
- Never bypass live provider routing and operator overrides without an explicit provider-specific capability design.
- Never create schedule load without Secretary arbitration where scheduling intent support exists.
- Never delete or mutate content, tasks, or calendar events by broad title/date matching.
- Never treat iOS or portal filtering as a security boundary.
- Never fake freshness, provider success, local smoke success, or staging evidence.

## Required Workflows

Content Agent:

- Configure audience, platforms, voice, formats, goals, constraints, banned patterns, and review preferences.
- Separate user-private creator memory from tenant-shared brand memory.
- Version profile changes and explain why output changed.

Content Radar:

- Track topic opportunities from references, user goals, trends where available, and cross-skill signals.
- Rank opportunities by fit, freshness, confidence, novelty, production cost, and schedule feasibility.
- Avoid duplicate warnings and stale recommendations.

Books As References:

- Store books and extracted ideas with provenance, owner scope, freshness, confidence, and rights/usage status.
- Prevent hallucinated book claims.
- Support "use this book as a lens" without dumping unrelated book notes into prompts.

Links As References:

- Treat links as first-class references with URL, title, source type, extraction status, snippet provenance, freshness, confidence, and prompt-injection safety labels.
- Distinguish user-private saved links from tenant-shared reference libraries.

Channels As References:

- Track channels, transcripts, patterns, audience fit, source freshness, and last-used status.
- Use channel references as inspiration with attribution and novelty control, not copying.

Ideas, Scripts, Outlines, Hooks, Captions:

- Generate platform-native artifacts with source grounding, voice fit, novelty signal, lifecycle state, and review status.
- Support repurposing across platforms while preserving the reason for each variant.

Content Calendar Planning:

- Submit writing, filming, editing, review, and publishing intents to Secretary.
- Respect schedule capacity, existing hard commitments, and cross-skill workload.

Cross-Skill Opportunity Detection:

- Training can surface progress, races, recovery, or lessons as content opportunities.
- Cooking can surface fueling, meal prep, recipes, and constraints.
- Finance can surface budget, purchase, subscription, or business-decision content.
- Secretary supplies feasibility and calendar load.
- Chat orchestrates requests, explains actions, and preserves tenant/user boundaries.

## iOS vs Portal

iOS should focus on personal execution:

- Content home, radar, pipeline, scripts, topics, notifications, review prompts, source chips, lifecycle states, schedule status, and degraded-mode states.
- Fast capture and lightweight approval.
- Safe unknown-state fallback and tenant/user cache invalidation.

Portal should focus on configuration and operations:

- Content agent setup, reference library management, source ingestion, diagnostics, aggregate quality metrics, model/provider observability, skill version history, and tenant/admin policy.
- Portal must not expose private content by default. Admin/support visibility requires explicit permission and audit.

## Release Blockers

P0 blockers:

- Any proven cross-tenant Content data leak.
- Any prompt construction path receiving unauthorized content references, memory, or artifacts.
- Any provider fallback path rebuilding unsafe context.
- Any production release claim that Content is tenant-safe without tenant/user enforcement evidence.

P1 blockers:

- Direct fixed-provider Content AI path that bypasses live routing.
- Source/provenance missing for outputs that claim grounding.
- Content scheduling bypassing Secretary for new scheduling decisions.
- Id-only mutations without ownership checks in app-facing paths.
- iOS or portal unable to represent core lifecycle/provenance states once backend emits them.


# Version-Aware Memory

Date: 2026-04-29

## Why Version Awareness Matters

Skill behavior changes over time. A memory that was safe and useful for Training `3.0.0` or Content `2.0.0` may become stale after a major release changes profile fields, prompt construction, source provenance, or scheduling logic.

Skill memory therefore records:

- `schema_version`
- `related_skill_version`
- freshness
- confidence
- correction history
- staleness policy

## Version Compatibility

Each skill version record can expose a `memory_schema_version` through the skill version registry. New memory writes should use the current schema version for that skill when known.

Examples:

- `chat-memory-v1`
- `secretary-memory-v1`
- `training-memory-v1`
- `content-memory-v1`
- `content-memory-v2`

## Stale Invalidation

The service supports `markSkillMemoriesStaleForVersion()` so a major release can invalidate memories that no longer match the current schema or skill version.

Expected use:

1. Release candidate introduces a new memory schema.
2. Release migration/backfill writes new memory rows where safe.
3. Old incompatible memories are marked `status = stale` and `freshness_status = stale`.
4. Prompt builders exclude those memories by default.
5. Repair or migration tools can request stale memory for audit.

## Correction And Supersession

User corrections are version-aware too:

- corrected memory supersedes the prior active row
- correction history records prior value and confidence
- future retrieval returns the corrected row
- stale summaries must not reintroduce superseded rows

## Migration/Backfill Strategy

For each major skill release:

1. Declare expected `memory_schema_version` in the skill version record.
2. Identify affected memory types.
3. Backfill safe deterministic memory if possible.
4. Mark old incompatible memories stale.
5. Keep stale rows for audit and recovery.
6. Add tests proving no cross-tenant memory moved or leaked during migration.

## Quality Diagnostics

Memory quality should eventually report:

- low confidence memories by skill
- stale memories by skill/version
- corrected memories by memory type
- memories never used
- memory retrieved into prompt context
- rejected unsafe memory write attempts

The current implementation records `confidence`, `freshness_status`, `last_used_at`, and `use_count` as the base observability fields.


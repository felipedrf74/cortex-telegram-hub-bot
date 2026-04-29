# Content Duplicate, Novelty, And Reuse Control

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Content Creation now has an explicit duplicate and novelty control layer instead of relying only on prompt instructions or exact string matching.

The goal is to prevent lazy repetition while still allowing intentional editorial reuse:

- repeated ideas, hooks, scripts, captions, outlines, references, and radar signals are scored before generation;
- intentional reuse is allowed when it has a clear transformation, platform adaptation, series role, new angle, or successful-pattern rationale;
- comparisons are tenant/user scoped before any prompt/model call;
- review warnings are produced for near duplicates, stale radar reuse, and overused references.

## Implemented Foundation

Code:

- `src/services/content-novelty-reuse.ts`
- `migrations/094_content_duplicate_novelty_reuse.sql`
- `__tests__/services/content-novelty-reuse.test.ts`

Generation integration:

- `src/services/content-generation-quality.ts` now calls `assessContentNovelty()` and includes novelty/reuse constraints in the generation contract before provider routing.

Storage:

- `content_novelty_candidates`
- `content_repurpose_history`

## Duplicate Detection

The service detects:

- exact duplicate artifact text;
- same or highly similar topic;
- near-duplicate hooks;
- repeated source radar signal use;
- repeated reference use;
- same content-series lineage;
- same original content lineage.

Detection is not only exact string matching. It uses normalized text, token overlap, bigram similarity, platform/format comparison, angle comparison, reference overlap, series lineage, and radar signal identity.

## Novelty Scoring

Novelty considers:

- topic distance;
- hook/body similarity;
- angle difference;
- platform difference;
- format difference;
- reference overlap;
- content pillar reuse;
- radar signal reuse;
- series lineage;
- explicit strategic reuse intent.

Decision statuses:

- `novel`
- `near_duplicate`
- `duplicate`
- `stale_repetition`
- `allowed_reuse`
- `series_related`
- `needs_new_angle`

## Tenant Safety

All comparison queries use `contentDirectScopePredicate()` and `contentScopeParams()`.

That means Content Creation compares only:

- the active user's private content in the active tenant;
- tenant-shared/public-published content in the active tenant.

It does not compare against another tenant's content, another user's private content, or ambiguous legacy content.

## Review Warnings

The layer emits review warnings for:

- near-duplicate content;
- exact/high-confidence duplicates;
- stale radar signal reuse;
- strategic reuse without enough transformation;
- overused references.

These warnings are designed to be shown in portal/iOS later and used in generation prompts today.

## Current Limitations

- Runtime write-through is not yet wired for every generated artifact type. The service can record candidates, but every route that creates ideas/scripts/hooks/captions still needs to call it consistently.
- iOS and portal do not yet render novelty/reuse warnings.
- No provider-backed semantic embedding similarity is used yet; the current foundation is deterministic and testable.
- Historical migration/backfill from legacy saved ideas/scripts into `content_novelty_candidates` is not complete.

## Release Gate

Status: PASS WITH CONDITIONS for backend foundation.

Required before full production Content release:

- wire candidate recording into all artifact creation/refinement routes;
- add portal/iOS rendering of duplicate/reuse warnings;
- run local full-product Content smoke;
- add backfill/quarantine strategy for legacy artifacts.

-- Migration 060: Signal Ranking & Pipeline Metrics
--
-- Upgrades the intelligence bus for ranked, filterable signals:
--   1. confidence — strength metric (0.0–1.0) so agents can rank signals
--   2. format_tag — content format ('reel', 'youtube', 'short', etc.)
--   3. pillar_tag — content pillar ('tech', 'fitness', 'politics', etc.)
--   4. evidence_count — how many observations back this signal
--
-- Also adds user_id to saved_ideas (was missing — ideas were global).
--
-- These fields enable the new readRankedSignals() function which
-- replaces the flat readSignals() for content-intelligence consumers.

-- ═══════════════════════════════════════════════════════════════════
-- 1. Signal ranking columns
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE agent_signals ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE agent_signals ADD COLUMN format_tag TEXT;
ALTER TABLE agent_signals ADD COLUMN pillar_tag TEXT;
ALTER TABLE agent_signals ADD COLUMN evidence_count INTEGER DEFAULT 1;

-- Composite index for ranked reads: active signals ranked by confidence
CREATE INDEX IF NOT EXISTS idx_signals_ranked
    ON agent_signals(status, signal_type, confidence DESC, created_at DESC);

-- Pillar-specific reads
CREATE INDEX IF NOT EXISTS idx_signals_pillar
    ON agent_signals(status, pillar_tag, signal_type)
    WHERE pillar_tag IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 2. Index for saved_ideas user scoping (user_id added in migration 057)
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_saved_ideas_user
    ON saved_ideas(user_id, status, workflow_eligible);

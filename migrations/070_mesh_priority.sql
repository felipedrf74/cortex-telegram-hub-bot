-- Migration 070: mesh priority metadata for Stage 2 multiskill plans.
--
-- Adds an optional per-signal mesh_priority column so the orchestrator
-- can resolve immutable constraints (travel, tax, sponsor commitments)
-- without overloading the existing dispatch priority field.

ALTER TABLE agent_signals ADD COLUMN mesh_priority INTEGER;

CREATE INDEX IF NOT EXISTS idx_signals_mesh_priority
  ON agent_signals(status, mesh_priority, signal_type, created_at DESC);

-- 287: content script delivery modes (plan §2/§3, Addendum C).
--
-- Additive: delivery_mode defaults to 'standard' for every existing and
-- predecessor-written row, and the predecessor image ignores the column.
-- Per release policy no CHECK is added to the existing table; the runtime
-- validates the value at admission. Priority ordering and the scheduled
-- batch-window deferral read this column at candidate selection.

ALTER TABLE content_script_jobs ADD COLUMN delivery_mode TEXT DEFAULT 'standard';

-- Roll back the ChatV2 route-exit evidence store introduced by 258.
-- The table is a derived cache over existing capture sources
-- (chat_v2_replay_bundles, chat_v2_online_eval_samples); dropping it loses
-- only converted evidence rows, which a full re-sync regenerates.

DROP INDEX IF EXISTS idx_chat_v2_route_exit_samples_route;
DROP INDEX IF EXISTS idx_chat_v2_route_exit_samples_source;
DROP TABLE IF EXISTS chat_v2_route_exit_samples;
-- Historical: earlier drafts of 258 also created a high-water-mark state
-- table; drop it too so a down migration from any draft is clean.
DROP TABLE IF EXISTS chat_v2_route_exit_sampler_state;

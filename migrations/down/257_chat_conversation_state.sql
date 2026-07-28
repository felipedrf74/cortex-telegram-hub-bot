-- Roll back the durable chat continuity table introduced by migration 257.
-- The table is a restart-survivable cache of the in-process active-domain
-- pin; dropping it only loses cross-restart continuity, never chat history.

DROP TABLE IF EXISTS chat_conversation_state;

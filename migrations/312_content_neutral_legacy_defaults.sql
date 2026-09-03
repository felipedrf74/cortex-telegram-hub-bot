-- 312: retire founder-shaped Content defaults without deleting user data.
--
-- Migration 055 installed a political-economy book canon and four creator
-- channels as enabled global defaults. Snapshot every changed value so the down
-- migration restores the exact pre-312 state, including disabled configuration
-- and invalid/legacy audit metadata bytes.
-- Residual legacy gap: a channel_dna signal without channel_id or channel_url
-- cannot be linked after its materialized channel_name has been renamed, so it
-- remains active rather than risking dismissal of an unrelated same-name row.

CREATE TABLE IF NOT EXISTS content_neutral_legacy_config_retirements_312 (
  config_type TEXT NOT NULL,
  config_id INTEGER NOT NULL,
  previous_enabled INTEGER,
  PRIMARY KEY (config_type, config_id)
);

CREATE TABLE IF NOT EXISTS content_neutral_legacy_signal_retirements_312 (
  signal_id INTEGER PRIMARY KEY,
  previous_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_neutral_legacy_row_retirements_312 (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  previous_scope_status TEXT,
  previous_lifecycle_state TEXT,
  previous_audit_metadata_json TEXT,
  PRIMARY KEY (entity_type, entity_id)
);

INSERT OR IGNORE INTO content_neutral_legacy_config_retirements_312 (
  config_type, config_id, previous_enabled
)
SELECT 'seed_book', id, enabled
  FROM config_seed_books
 WHERE (title = 'The Law' AND author = 'Frédéric Bastiat')
    OR (title = 'Economics in One Lesson' AND author = 'Henry Hazlitt')
    OR (title = 'Human Action' AND author = 'Ludwig von Mises')
    OR (title = 'The Road to Serfdom' AND author = 'Friedrich Hayek')
    OR (title = 'Democracy: The God That Failed' AND author = 'Hans-Hermann Hoppe')
    OR (title = 'Anatomy of the State' AND author = 'Murray Rothbard');

INSERT OR IGNORE INTO content_neutral_legacy_config_retirements_312 (
  config_type, config_id, previous_enabled
)
SELECT 'default_channel', id, enabled
  FROM config_default_channels
 WHERE added_via = 'migration'
   AND url IN (
     'https://www.youtube.com/@danielbarada',
     'https://www.youtube.com/@NewelOfKnowledge',
     'https://www.youtube.com/@Jett.franzen',
     'https://www.youtube.com/@DanKoeTalks'
   );

UPDATE config_seed_books
   SET enabled = 0
 WHERE id IN (
   SELECT config_id
     FROM content_neutral_legacy_config_retirements_312
    WHERE config_type = 'seed_book'
 );

UPDATE config_default_channels
   SET enabled = 0
 WHERE id IN (
   SELECT config_id
     FROM content_neutral_legacy_config_retirements_312
    WHERE config_type = 'default_channel'
 );

-- Materialized channel rows predate explicit seed provenance. Bind them back to
-- the exact migration-055 config rows, exact URLs, and strict platform scope.
INSERT OR IGNORE INTO content_neutral_legacy_row_retirements_312 (
  entity_type, entity_id, previous_scope_status,
  previous_lifecycle_state, previous_audit_metadata_json
)
SELECT 'content_ref_channel', channel.id, channel.scope_status,
       channel.lifecycle_state, channel.audit_metadata_json
  FROM content_ref_channels channel
 WHERE COALESCE(channel.user_id, 0) = 0
   AND COALESCE(channel.owner_scope, 'system') = 'system'
   AND COALESCE(channel.tenant_id, 0) = 0
   AND COALESCE(channel.owner_user_id, 0) = 0
   AND COALESCE(channel.visibility_scope, 'platform_internal') = 'platform_internal'
   AND channel.channel_url IN (
     'https://www.youtube.com/@danielbarada',
     'https://www.youtube.com/@NewelOfKnowledge',
     'https://www.youtube.com/@Jett.franzen',
     'https://www.youtube.com/@DanKoeTalks'
   )
   AND EXISTS (
     SELECT 1
       FROM config_default_channels configured
      WHERE configured.id IN (
        SELECT config_id
          FROM content_neutral_legacy_config_retirements_312
         WHERE config_type = 'default_channel'
      )
        AND configured.url = channel.channel_url
   );

INSERT OR IGNORE INTO content_neutral_legacy_signal_retirements_312 (signal_id, previous_status)
SELECT signal.id, signal.status
  FROM agent_signals signal
 WHERE signal.status = 'active'
   AND signal.user_id IS NULL
   AND signal.tenant_id IS NULL
   AND json_valid(signal.payload)
   AND (
     (
       signal.source_agent = 'book-extractor'
       AND signal.signal_type = 'book_knowledge'
       AND (
         (json_extract(signal.payload, '$.title') = 'The Law'
           AND json_extract(signal.payload, '$.author') = 'Frédéric Bastiat')
         OR (json_extract(signal.payload, '$.title') = 'Economics in One Lesson'
           AND json_extract(signal.payload, '$.author') = 'Henry Hazlitt')
         OR (json_extract(signal.payload, '$.title') = 'Human Action'
           AND json_extract(signal.payload, '$.author') = 'Ludwig von Mises')
         OR (json_extract(signal.payload, '$.title') = 'The Road to Serfdom'
           AND json_extract(signal.payload, '$.author') = 'Friedrich Hayek')
         OR (json_extract(signal.payload, '$.title') = 'Democracy: The God That Failed'
           AND json_extract(signal.payload, '$.author') = 'Hans-Hermann Hoppe')
         OR (json_extract(signal.payload, '$.title') = 'Anatomy of the State'
           AND json_extract(signal.payload, '$.author') = 'Murray Rothbard')
       )
     )
     OR (
       signal.source_agent = 'channel-learner'
       AND signal.signal_type = 'channel_dna'
       AND EXISTS (
         SELECT 1
           FROM content_ref_channels legacy_channel
           JOIN content_neutral_legacy_row_retirements_312 retirement
             ON retirement.entity_type = 'content_ref_channel'
            AND retirement.entity_id = legacy_channel.id
          WHERE (
                  NULLIF(TRIM(CAST(legacy_channel.channel_id AS TEXT)), '') IS NOT NULL
                  AND NULLIF(TRIM(CAST(json_extract(signal.payload, '$.channel_id') AS TEXT)), '') IS NOT NULL
                  AND json_extract(signal.payload, '$.channel_id') = legacy_channel.channel_id
                )
             OR (
                  -- A shared display name is not identity when both sides
                  -- provide stable channel IDs. Fall back to the name only
                  -- when either historical row genuinely lacks that ID.
                  (
                    NULLIF(TRIM(CAST(legacy_channel.channel_id AS TEXT)), '') IS NULL
                    OR NULLIF(TRIM(CAST(json_extract(signal.payload, '$.channel_id') AS TEXT)), '') IS NULL
                  )
                  AND NULLIF(TRIM(legacy_channel.channel_name), '') IS NOT NULL
                  AND json_extract(signal.payload, '$.channel_name') = legacy_channel.channel_name
                )
       )
     )
   );

UPDATE agent_signals
   SET status = 'dismissed'
 WHERE id IN (SELECT signal_id FROM content_neutral_legacy_signal_retirements_312);

-- System knowledge is one synthesis across its active channel set, so any
-- legacy default contaminates the aggregate. Retire that platform aggregate as
-- a unit; user/tenant knowledge is excluded by every scope dimension.
INSERT OR IGNORE INTO content_neutral_legacy_row_retirements_312 (
  entity_type, entity_id, previous_scope_status,
  previous_lifecycle_state, previous_audit_metadata_json
)
SELECT 'content_knowledge', knowledge.id, knowledge.scope_status,
       knowledge.lifecycle_state, knowledge.audit_metadata_json
  FROM content_knowledge knowledge
 WHERE COALESCE(knowledge.user_id, 0) = 0
   AND COALESCE(knowledge.owner_scope, 'system') = 'system'
   AND COALESCE(knowledge.tenant_id, 0) = 0
   AND COALESCE(knowledge.owner_user_id, 0) = 0
   AND COALESCE(knowledge.visibility_scope, 'platform_internal') = 'platform_internal'
   AND EXISTS (
     SELECT 1
       FROM content_neutral_legacy_row_retirements_312 retirement
      WHERE retirement.entity_type = 'content_ref_channel'
   );

INSERT OR IGNORE INTO content_neutral_legacy_row_retirements_312 (
  entity_type, entity_id, previous_scope_status,
  previous_lifecycle_state, previous_audit_metadata_json
)
SELECT 'content_pattern', pattern.id, pattern.scope_status,
       pattern.lifecycle_state, pattern.audit_metadata_json
  FROM content_patterns pattern
 WHERE COALESCE(pattern.user_id, 0) = 0
   AND COALESCE(pattern.tenant_id, 0) = 0
   AND COALESCE(pattern.owner_user_id, 0) = 0
   AND COALESCE(pattern.visibility_scope, 'platform_internal') = 'platform_internal'
   AND pattern.channel_id IN (
     SELECT entity_id
       FROM content_neutral_legacy_row_retirements_312
      WHERE entity_type = 'content_ref_channel'
   );

INSERT OR IGNORE INTO content_neutral_legacy_row_retirements_312 (
  entity_type, entity_id, previous_scope_status,
  previous_lifecycle_state, previous_audit_metadata_json
)
SELECT 'book_library', book.id, book.scope_status,
       book.lifecycle_state, book.audit_metadata_json
  FROM book_library book
 WHERE COALESCE(book.user_id, 0) = 0
   AND COALESCE(book.owner_scope, 'system') = 'system'
   AND COALESCE(book.tenant_id, 0) = 0
   AND COALESCE(book.owner_user_id, 0) = 0
   AND COALESCE(book.visibility_scope, 'platform_internal') = 'platform_internal'
   AND (
     (book.title = 'The Law' AND book.author = 'Frédéric Bastiat')
     OR (book.title = 'Economics in One Lesson' AND book.author = 'Henry Hazlitt')
     OR (book.title = 'Human Action' AND book.author = 'Ludwig von Mises')
     OR (book.title = 'The Road to Serfdom' AND book.author = 'Friedrich Hayek')
     OR (book.title = 'Democracy: The God That Failed' AND book.author = 'Hans-Hermann Hoppe')
     OR (book.title = 'Anatomy of the State' AND book.author = 'Murray Rothbard')
   );

UPDATE content_knowledge
   SET audit_metadata_json = json_set(
         CASE WHEN json_valid(COALESCE(audit_metadata_json, '')) THEN audit_metadata_json ELSE '{}' END,
         '$.contentNeutralLegacyDefaults312.previousScopeStatus', (
           SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'content_knowledge' AND entity_id = content_knowledge.id
         ),
         '$.contentNeutralLegacyDefaults312.previousLifecycleState', (
           SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'content_knowledge' AND entity_id = content_knowledge.id
         ),
         '$.contentNeutralLegacyDefaults312.retired', 1
       ),
       scope_status = 'archived',
       lifecycle_state = 'retired'
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'content_knowledge');

UPDATE content_patterns
   SET audit_metadata_json = json_set(
         CASE WHEN json_valid(COALESCE(audit_metadata_json, '')) THEN audit_metadata_json ELSE '{}' END,
         '$.contentNeutralLegacyDefaults312.previousScopeStatus', (
           SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'content_pattern' AND entity_id = content_patterns.id
         ),
         '$.contentNeutralLegacyDefaults312.previousLifecycleState', (
           SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'content_pattern' AND entity_id = content_patterns.id
         ),
         '$.contentNeutralLegacyDefaults312.retired', 1
       ),
       scope_status = 'archived',
       lifecycle_state = 'retired'
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'content_pattern');

UPDATE content_ref_channels
   SET audit_metadata_json = json_set(
         CASE WHEN json_valid(COALESCE(audit_metadata_json, '')) THEN audit_metadata_json ELSE '{}' END,
         '$.contentNeutralLegacyDefaults312.previousScopeStatus', (
           SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'content_ref_channel' AND entity_id = content_ref_channels.id
         ),
         '$.contentNeutralLegacyDefaults312.previousLifecycleState', (
           SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'content_ref_channel' AND entity_id = content_ref_channels.id
         ),
         '$.contentNeutralLegacyDefaults312.retired', 1
       ),
       scope_status = 'archived',
       lifecycle_state = 'retired'
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'content_ref_channel');

UPDATE book_library
   SET audit_metadata_json = json_set(
         CASE WHEN json_valid(COALESCE(audit_metadata_json, '')) THEN audit_metadata_json ELSE '{}' END,
         '$.contentNeutralLegacyDefaults312.previousScopeStatus', (
           SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'book_library' AND entity_id = book_library.id
         ),
         '$.contentNeutralLegacyDefaults312.previousLifecycleState', (
           SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
            WHERE entity_type = 'book_library' AND entity_id = book_library.id
         ),
         '$.contentNeutralLegacyDefaults312.retired', 1
       ),
       scope_status = 'archived',
       lifecycle_state = 'retired'
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'book_library');

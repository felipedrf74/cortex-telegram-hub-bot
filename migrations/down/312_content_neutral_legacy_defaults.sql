-- Down for 312: restore only rows captured by the forward migration, byte-for-
-- byte for audit metadata and value-for-value for statuses/configuration.

UPDATE config_seed_books
   SET enabled = (
     SELECT previous_enabled
       FROM content_neutral_legacy_config_retirements_312 retirement
      WHERE retirement.config_type = 'seed_book'
        AND retirement.config_id = config_seed_books.id
   )
 WHERE id IN (
   SELECT config_id FROM content_neutral_legacy_config_retirements_312
    WHERE config_type = 'seed_book'
 );

UPDATE config_default_channels
   SET enabled = (
     SELECT previous_enabled
       FROM content_neutral_legacy_config_retirements_312 retirement
      WHERE retirement.config_type = 'default_channel'
        AND retirement.config_id = config_default_channels.id
   )
 WHERE id IN (
   SELECT config_id FROM content_neutral_legacy_config_retirements_312
    WHERE config_type = 'default_channel'
 );

UPDATE agent_signals
   SET status = (
     SELECT retirement.previous_status
       FROM content_neutral_legacy_signal_retirements_312 retirement
      WHERE retirement.signal_id = agent_signals.id
   )
 WHERE id IN (SELECT signal_id FROM content_neutral_legacy_signal_retirements_312);

UPDATE content_knowledge
   SET scope_status = (
         SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_knowledge' AND entity_id = content_knowledge.id
       ),
       lifecycle_state = (
         SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_knowledge' AND entity_id = content_knowledge.id
       ),
       audit_metadata_json = (
         SELECT previous_audit_metadata_json FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_knowledge' AND entity_id = content_knowledge.id
       )
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'content_knowledge');

UPDATE content_patterns
   SET scope_status = (
         SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_pattern' AND entity_id = content_patterns.id
       ),
       lifecycle_state = (
         SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_pattern' AND entity_id = content_patterns.id
       ),
       audit_metadata_json = (
         SELECT previous_audit_metadata_json FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_pattern' AND entity_id = content_patterns.id
       )
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'content_pattern');

UPDATE content_ref_channels
   SET scope_status = (
         SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_ref_channel' AND entity_id = content_ref_channels.id
       ),
       lifecycle_state = (
         SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_ref_channel' AND entity_id = content_ref_channels.id
       ),
       audit_metadata_json = (
         SELECT previous_audit_metadata_json FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'content_ref_channel' AND entity_id = content_ref_channels.id
       )
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'content_ref_channel');

UPDATE book_library
   SET scope_status = (
         SELECT previous_scope_status FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'book_library' AND entity_id = book_library.id
       ),
       lifecycle_state = (
         SELECT previous_lifecycle_state FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'book_library' AND entity_id = book_library.id
       ),
       audit_metadata_json = (
         SELECT previous_audit_metadata_json FROM content_neutral_legacy_row_retirements_312
          WHERE entity_type = 'book_library' AND entity_id = book_library.id
       )
 WHERE id IN (SELECT entity_id FROM content_neutral_legacy_row_retirements_312 WHERE entity_type = 'book_library');

DROP TABLE IF EXISTS content_neutral_legacy_row_retirements_312;
DROP TABLE IF EXISTS content_neutral_legacy_signal_retirements_312;
DROP TABLE IF EXISTS content_neutral_legacy_config_retirements_312;

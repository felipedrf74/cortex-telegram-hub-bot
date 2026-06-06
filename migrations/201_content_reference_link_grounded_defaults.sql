-- Migration 201 -- content reference link grounded defaults.
--
-- CONT-D10 follow-up: user-added reference links were created with old
-- pending/unverified/unknown defaults, which kept otherwise usable links out of
-- the grounded-reference prompt section. Runtime inserts now set healthy values
-- explicitly; this backfills active link rows that still carry only the legacy
-- defaults.

UPDATE content_reference_links
   SET extraction_status = 'ready'
 WHERE COALESCE(scope_status, 'active') = 'active'
   AND COALESCE(source_type, 'link') = 'link'
   AND COALESCE(url, '') <> ''
   AND COALESCE(extraction_status, 'pending') IN ('pending', '');

UPDATE content_reference_links
   SET trust_level = 'observed'
 WHERE COALESCE(scope_status, 'active') = 'active'
   AND COALESCE(source_type, 'link') = 'link'
   AND COALESCE(url, '') <> ''
   AND COALESCE(trust_level, 'unverified') IN ('unverified', '');

UPDATE content_reference_links
   SET broken_status = 'ok'
 WHERE COALESCE(scope_status, 'active') = 'active'
   AND COALESCE(source_type, 'link') = 'link'
   AND COALESCE(url, '') <> ''
   AND COALESCE(broken_status, 'unknown') IN ('unknown', '');

UPDATE content_reference_links
   SET stale_status = 'fresh'
 WHERE COALESCE(scope_status, 'active') = 'active'
   AND COALESCE(source_type, 'link') = 'link'
   AND COALESCE(url, '') <> ''
   AND COALESCE(stale_status, 'unknown') IN ('unknown', '');

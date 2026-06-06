-- Migration 152: Canonicalize Apple Nexus Points transaction keys.
--
-- New Apple consumable grants use originalTransactionId as the provider
-- transaction key. This backfills any rows that already stored the canonical
-- value in metadata_json while avoiding unique-key collisions.

UPDATE nexus_point_credits
SET provider_transaction_id = json_extract(metadata_json, '$.originalTransactionId'),
    updated_at = datetime('now')
WHERE provider = 'apple'
  AND json_valid(metadata_json)
  AND json_extract(metadata_json, '$.originalTransactionId') IS NOT NULL
  AND json_extract(metadata_json, '$.originalTransactionId') != ''
  AND provider_transaction_id != json_extract(metadata_json, '$.originalTransactionId')
  AND NOT EXISTS (
    SELECT 1
    FROM nexus_point_credits existing
    WHERE existing.provider = nexus_point_credits.provider
      AND existing.provider_transaction_id = json_extract(nexus_point_credits.metadata_json, '$.originalTransactionId')
  );

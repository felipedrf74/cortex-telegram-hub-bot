-- 229: Governed Training exercise-media metadata foundation.
--
-- This migration is additive and dormant while
-- TRAINING_EXERCISE_MEDIA_V1_ENABLED is disabled (the default). Binary media
-- never lives in SQLite or Git: these tables hold only immutable metadata,
-- external delivery URLs, integrity hashes, localization, review, provenance,
-- and append-only takedown events.
--
-- Promotion is deliberately three-step. A package is inserted as DRAFT, all
-- immutable child rows are inserted, the seed service recomputes and attests
-- the exact package before STAGED, and only then may the manifest become
-- ACTIVE. The staging/activation triggers fail closed unless
-- every frozen exercise, required view, locale, provenance record, and latest
-- required review is complete and approved.

CREATE TABLE IF NOT EXISTS training_exercise_media_manifests (
  manifest_id TEXT PRIMARY KEY,
  manifest_version TEXT NOT NULL UNIQUE,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  catalog_version TEXT NOT NULL,
  catalog_source_hash TEXT NOT NULL CHECK (
    length(catalog_source_hash) = 64 AND catalog_source_hash NOT GLOB '*[^0-9a-f]*'
  ),
  package_hash TEXT NOT NULL CHECK (
    length(package_hash) = 64 AND package_hash NOT GLOB '*[^0-9a-f]*'
  ),
  publication_state TEXT NOT NULL CHECK (publication_state IN (
    'DRAFT', 'STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED'
  )),
  validation_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (validation_status IN (
    'PENDING', 'PASSED', 'FAILED'
  )),
  expected_exercise_count INTEGER NOT NULL CHECK (expected_exercise_count >= 0),
  expected_exercise_ids_json TEXT NOT NULL CHECK (
    json_valid(expected_exercise_ids_json) AND
    json_type(expected_exercise_ids_json) = 'array' AND
    json_array_length(expected_exercise_ids_json) = expected_exercise_count
  ),
  expected_approved_asset_bindings_json TEXT NOT NULL CHECK (
    json_valid(expected_approved_asset_bindings_json) AND
    json_type(expected_approved_asset_bindings_json) = 'array'
  ),
  required_locales_json TEXT NOT NULL CHECK (
    json_valid(required_locales_json) AND json_type(required_locales_json) = 'array'
  ),
  required_review_types_json TEXT NOT NULL CHECK (
    json_valid(required_review_types_json) AND json_type(required_review_types_json) = 'array'
  ),
  allowed_origins_json TEXT NOT NULL CHECK (
    json_valid(allowed_origins_json) AND json_type(allowed_origins_json) = 'array'
  ),
  approved_host_ref TEXT,
  owner_approval_ref TEXT,
  validation_attested_package_hash TEXT CHECK (
    validation_attested_package_hash IS NULL OR (
      length(validation_attested_package_hash) = 64 AND
      validation_attested_package_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  validation_attestation_hash TEXT CHECK (
    validation_attestation_hash IS NULL OR (
      length(validation_attestation_hash) = 64 AND
      validation_attestation_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  validation_attested_at TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  deprecated_at TEXT,
  replaced_by_manifest_id TEXT,
  UNIQUE (manifest_id, scope_key),
  FOREIGN KEY (replaced_by_manifest_id, scope_key)
    REFERENCES training_exercise_media_manifests(manifest_id, scope_key),
  CHECK (
    publication_state = 'DRAFT' OR (
      validation_status = 'PASSED' AND
      validation_attested_package_hash = package_hash AND
      validation_attestation_hash IS NOT NULL AND
      validation_attested_at IS NOT NULL
    )
  ),
  CHECK (
    publication_state <> 'ACTIVE' OR (
      expected_exercise_count > 0 AND
      approved_host_ref IS NOT NULL AND
      length(trim(approved_host_ref)) > 0 AND
      owner_approval_ref IS NOT NULL AND
      length(trim(owner_approval_ref)) > 0 AND
      activated_at IS NOT NULL AND
      json_array_length(allowed_origins_json) > 0
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_exercise_media_one_active_scope
  ON training_exercise_media_manifests(scope_key)
  WHERE publication_state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_training_exercise_media_manifest_scope_state
  ON training_exercise_media_manifests(scope_key, publication_state, created_at DESC);

CREATE TABLE IF NOT EXISTS training_exercise_media_exercises (
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  exercise_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK (
    json_valid(aliases_json) AND json_type(aliases_json) = 'array'
  ),
  required_views_json TEXT NOT NULL CHECK (
    json_valid(required_views_json) AND json_type(required_views_json) = 'array'
  ),
  exercise_content_hash TEXT NOT NULL CHECK (
    length(exercise_content_hash) = 64 AND exercise_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  publication_state TEXT NOT NULL CHECK (publication_state IN (
    'DRAFT', 'APPROVED', 'EXCLUDED', 'REMOVED'
  )),
  exclusion_reason TEXT,
  global_exercise_id TEXT,
  equivalence_hash TEXT CHECK (
    equivalence_hash IS NULL OR (
      length(equivalence_hash) = 64 AND equivalence_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, scope_key, exercise_id),
  FOREIGN KEY (manifest_id, scope_key)
    REFERENCES training_exercise_media_manifests(manifest_id, scope_key) ON DELETE CASCADE,
  CHECK (scope_key = '__global__' OR global_exercise_id IS NOT NULL),
  CHECK (
    (publication_state = 'EXCLUDED' AND exclusion_reason IS NOT NULL AND length(trim(exclusion_reason)) > 0)
    OR (publication_state <> 'EXCLUDED' AND exclusion_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_media_exercise_lookup
  ON training_exercise_media_exercises(manifest_id, scope_key, publication_state, exercise_id);

CREATE TABLE IF NOT EXISTS training_exercise_media_assets (
  asset_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  exercise_id TEXT NOT NULL,
  view_role TEXT NOT NULL CHECK (view_role IN (
    'PRIMARY', 'START', 'END', 'PHASE', 'ALTERNATE'
  )),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  media_kind TEXT NOT NULL CHECK (media_kind = 'IMAGE'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  delivery_url TEXT NOT NULL,
  integrity_sha256 TEXT NOT NULL CHECK (
    length(integrity_sha256) = 64 AND integrity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  width_pixels INTEGER NOT NULL CHECK (width_pixels > 0),
  height_pixels INTEGER NOT NULL CHECK (height_pixels > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  accessibility_bundle_hash TEXT CHECK (
    accessibility_bundle_hash IS NULL OR (
      length(accessibility_bundle_hash) = 64 AND
      accessibility_bundle_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  publication_state TEXT NOT NULL CHECK (publication_state IN (
    'DRAFT', 'APPROVED', 'REJECTED', 'REMOVED'
  )),
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, manifest_id, scope_key),
  UNIQUE (manifest_id, scope_key, exercise_id, view_role, ordinal),
  FOREIGN KEY (manifest_id, scope_key, exercise_id)
    REFERENCES training_exercise_media_exercises(manifest_id, scope_key, exercise_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_media_asset_lookup
  ON training_exercise_media_assets(
    manifest_id, scope_key, exercise_id, publication_state, view_role, ordinal
  );

CREATE TABLE IF NOT EXISTS training_exercise_media_provenance (
  asset_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'GENERATED', 'LICENSED', 'OWNED', 'COMMISSIONED'
  )),
  source_reference TEXT NOT NULL,
  generator_model TEXT,
  prompt_hash TEXT CHECK (
    prompt_hash IS NULL OR (
      length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  generated_or_acquired_at TEXT NOT NULL,
  license_identifier TEXT NOT NULL,
  license_url TEXT,
  rights_holder_ref TEXT NOT NULL,
  rights_expires_at TEXT,
  territories_json TEXT NOT NULL CHECK (
    json_valid(territories_json) AND json_type(territories_json) = 'array'
  ),
  transformations_json TEXT NOT NULL CHECK (
    json_valid(transformations_json) AND json_type(transformations_json) = 'array'
  ),
  provenance_hash TEXT NOT NULL CHECK (
    length(provenance_hash) = 64 AND provenance_hash NOT GLOB '*[^0-9a-f]*'
  ),
  publication_allowed INTEGER NOT NULL CHECK (publication_allowed IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id, manifest_id, scope_key)
    REFERENCES training_exercise_media_assets(asset_id, manifest_id, scope_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_exercise_instruction_localizations (
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  exercise_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  display_name TEXT NOT NULL,
  steps_json TEXT NOT NULL CHECK (
    json_valid(steps_json) AND json_type(steps_json) = 'array' AND json_array_length(steps_json) > 0
  ),
  cues_json TEXT NOT NULL CHECK (
    json_valid(cues_json) AND json_type(cues_json) = 'array'
  ),
  cautions_json TEXT NOT NULL CHECK (
    json_valid(cautions_json) AND json_type(cautions_json) = 'array'
  ),
  text_fallback TEXT NOT NULL CHECK (length(trim(text_fallback)) > 0),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, scope_key, exercise_id, locale),
  FOREIGN KEY (manifest_id, scope_key, exercise_id)
    REFERENCES training_exercise_media_exercises(manifest_id, scope_key, exercise_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_exercise_media_localizations (
  asset_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  locale TEXT NOT NULL,
  caption TEXT,
  accessibility_description TEXT NOT NULL CHECK (
    length(trim(accessibility_description)) > 0
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, locale),
  FOREIGN KEY (asset_id, manifest_id, scope_key)
    REFERENCES training_exercise_media_assets(asset_id, manifest_id, scope_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_exercise_media_reviews (
  review_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  asset_id TEXT NOT NULL,
  review_type TEXT NOT NULL CHECK (review_type IN (
    'DOMAIN', 'LEGAL', 'ACCESSIBILITY', 'OWNER'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'
  )),
  reviewer_ref TEXT NOT NULL,
  subject_content_hash TEXT NOT NULL CHECK (
    length(subject_content_hash) = 64 AND subject_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  reviewed_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id, manifest_id, scope_key)
    REFERENCES training_exercise_media_assets(asset_id, manifest_id, scope_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_media_review_latest
  ON training_exercise_media_reviews(asset_id, review_type, reviewed_at DESC, review_id DESC);

CREATE TABLE IF NOT EXISTS training_exercise_instruction_localization_reviews (
  review_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  exercise_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  reviewer_ref TEXT NOT NULL,
  subject_content_hash TEXT NOT NULL CHECK (
    length(subject_content_hash) = 64 AND subject_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  reviewed_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (manifest_id, scope_key, exercise_id, locale)
    REFERENCES training_exercise_instruction_localizations(manifest_id, scope_key, exercise_id, locale)
      ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_instruction_localization_review_latest
  ON training_exercise_instruction_localization_reviews(
    manifest_id, scope_key, exercise_id, locale, reviewed_at DESC, review_id DESC
  );

CREATE TABLE IF NOT EXISTS training_exercise_media_localization_reviews (
  review_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  asset_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  reviewer_ref TEXT NOT NULL,
  subject_content_hash TEXT NOT NULL CHECK (
    length(subject_content_hash) = 64 AND subject_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  reviewed_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id, locale)
    REFERENCES training_exercise_media_localizations(asset_id, locale)
      ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_media_localization_review_latest
  ON training_exercise_media_localization_reviews(
    manifest_id, scope_key, asset_id, locale, reviewed_at DESC, review_id DESC
  );

CREATE TABLE IF NOT EXISTS training_exercise_media_host_approvals (
  approval_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  reviewer_ref TEXT NOT NULL,
  subject_origins_json TEXT NOT NULL CHECK (
    json_valid(subject_origins_json) AND json_type(subject_origins_json) = 'array'
  ),
  subject_origins_hash TEXT NOT NULL CHECK (
    length(subject_origins_hash) = 64 AND subject_origins_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  reviewed_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (manifest_id, scope_key)
    REFERENCES training_exercise_media_manifests(manifest_id, scope_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_exercise_media_owner_approvals (
  approval_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  reviewer_ref TEXT NOT NULL,
  subject_package_hash TEXT NOT NULL CHECK (
    length(subject_package_hash) = 64 AND subject_package_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  reviewed_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (manifest_id, scope_key)
    REFERENCES training_exercise_media_manifests(manifest_id, scope_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_exercise_media_takedown_events (
  event_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '__global__',
  asset_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('REMOVE', 'REINSTATE')),
  reason_code TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  replacement_asset_id TEXT,
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id, manifest_id, scope_key)
    REFERENCES training_exercise_media_assets(asset_id, manifest_id, scope_key) ON DELETE CASCADE,
  FOREIGN KEY (replacement_asset_id, manifest_id, scope_key)
    REFERENCES training_exercise_media_assets(asset_id, manifest_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_training_exercise_media_takedown_latest
  ON training_exercise_media_takedown_events(asset_id, effective_at DESC, event_id DESC);

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_draft_only_insert
BEFORE INSERT ON training_exercise_media_manifests
WHEN NEW.publication_state <> 'DRAFT'
  OR NEW.validation_status <> 'PENDING'
  OR NEW.validation_attested_package_hash IS NOT NULL
  OR NEW.validation_attestation_hash IS NOT NULL
  OR NEW.validation_attested_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'exercise media manifests must be inserted as unattested drafts');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_content_immutable
BEFORE UPDATE ON training_exercise_media_manifests
WHEN
  NEW.manifest_id <> OLD.manifest_id OR
  NEW.manifest_version <> OLD.manifest_version OR
  NEW.scope_key <> OLD.scope_key OR
  NEW.catalog_version <> OLD.catalog_version OR
  NEW.catalog_source_hash <> OLD.catalog_source_hash OR
  NEW.package_hash <> OLD.package_hash OR
  NEW.expected_exercise_count <> OLD.expected_exercise_count OR
  NEW.expected_exercise_ids_json <> OLD.expected_exercise_ids_json OR
  NEW.expected_approved_asset_bindings_json <> OLD.expected_approved_asset_bindings_json OR
  NEW.required_locales_json <> OLD.required_locales_json OR
  NEW.required_review_types_json <> OLD.required_review_types_json OR
  NEW.allowed_origins_json <> OLD.allowed_origins_json OR
  NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'exercise media manifest content is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_approval_refs_guard
BEFORE UPDATE OF approved_host_ref, owner_approval_ref ON training_exercise_media_manifests
WHEN (
  COALESCE(NEW.approved_host_ref, '') <> COALESCE(OLD.approved_host_ref, '') OR
  COALESCE(NEW.owner_approval_ref, '') <> COALESCE(OLD.owner_approval_ref, '')
) AND OLD.publication_state <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'exercise media approval references freeze at staging');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_attestation_guard
BEFORE UPDATE OF validation_status, validation_attested_package_hash,
  validation_attestation_hash, validation_attested_at
ON training_exercise_media_manifests
WHEN (
  NEW.validation_status <> OLD.validation_status OR
  COALESCE(NEW.validation_attested_package_hash, '') <>
    COALESCE(OLD.validation_attested_package_hash, '') OR
  COALESCE(NEW.validation_attestation_hash, '') <>
    COALESCE(OLD.validation_attestation_hash, '') OR
  COALESCE(NEW.validation_attested_at, '') <> COALESCE(OLD.validation_attested_at, '')
) AND NOT (
  OLD.publication_state = 'DRAFT' AND
  NEW.publication_state = 'DRAFT' AND
  NEW.validation_status IN ('PENDING', 'FAILED') AND
  NEW.validation_attested_package_hash IS NULL AND
  NEW.validation_attestation_hash IS NULL AND
  NEW.validation_attested_at IS NULL
) AND NOT (
  OLD.publication_state = 'DRAFT' AND
  NEW.publication_state = 'STAGED' AND
  OLD.validation_status IN ('PENDING', 'FAILED') AND
  OLD.validation_attested_package_hash IS NULL AND
  OLD.validation_attestation_hash IS NULL AND
  OLD.validation_attested_at IS NULL AND
  NEW.validation_status = 'PASSED' AND
  NEW.validation_attested_package_hash = OLD.package_hash AND
  NEW.validation_attestation_hash IS NOT NULL AND
  length(NEW.validation_attestation_hash) = 64 AND
  NEW.validation_attestation_hash NOT GLOB '*[^0-9a-f]*' AND
  NEW.validation_attested_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'exercise media validation attestation is one-time and immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_transition_guard
BEFORE UPDATE OF publication_state ON training_exercise_media_manifests
WHEN NOT (
  NEW.publication_state = OLD.publication_state OR
  (OLD.publication_state = 'DRAFT' AND NEW.publication_state = 'STAGED') OR
  (OLD.publication_state = 'STAGED' AND NEW.publication_state = 'ACTIVE') OR
  (OLD.publication_state = 'ACTIVE' AND NEW.publication_state IN ('DEPRECATED', 'REVOKED'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid exercise media manifest lifecycle transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_staging_gate
BEFORE UPDATE OF publication_state ON training_exercise_media_manifests
WHEN OLD.publication_state = 'DRAFT' AND NEW.publication_state = 'STAGED'
BEGIN
  SELECT CASE WHEN NEW.validation_status <> 'PASSED'
    OR NEW.validation_attested_package_hash <> OLD.package_hash
    OR NEW.validation_attestation_hash IS NULL
    OR NEW.validation_attested_at IS NULL
  THEN RAISE(ABORT, 'exercise media manifest requires a package-bound validation attestation') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
      FROM training_exercise_media_assets a
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
  ) <> json_array_length(OLD.expected_approved_asset_bindings_json)
  THEN RAISE(ABORT, 'exercise media approved asset binding set is incomplete') END;

  SELECT CASE WHEN (
    SELECT COUNT(DISTINCT json_extract(binding.value, '$.assetId'))
      FROM json_each(OLD.expected_approved_asset_bindings_json) binding
     WHERE json_type(binding.value, '$.assetId') = 'text'
       AND json_type(binding.value, '$.exerciseId') = 'text'
       AND json_type(binding.value, '$.viewRole') = 'text'
       AND json_type(binding.value, '$.ordinal') = 'integer'
       AND json_type(binding.value, '$.integritySha256') = 'text'
  ) <> json_array_length(OLD.expected_approved_asset_bindings_json)
  THEN RAISE(ABORT, 'exercise media expected approved asset bindings are invalid') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM json_each(OLD.expected_approved_asset_bindings_json) binding
     WHERE NOT EXISTS (
       SELECT 1
         FROM training_exercise_media_assets a
        WHERE a.manifest_id = OLD.manifest_id
          AND a.scope_key = OLD.scope_key
          AND a.publication_state = 'APPROVED'
          AND a.asset_id = json_extract(binding.value, '$.assetId')
          AND a.exercise_id = json_extract(binding.value, '$.exerciseId')
          AND a.view_role = json_extract(binding.value, '$.viewRole')
          AND a.ordinal = json_extract(binding.value, '$.ordinal')
          AND a.integrity_sha256 = json_extract(binding.value, '$.integritySha256')
     )
  ) OR EXISTS (
    SELECT 1
      FROM training_exercise_media_assets a
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(OLD.expected_approved_asset_bindings_json) binding
          WHERE a.asset_id = json_extract(binding.value, '$.assetId')
            AND a.exercise_id = json_extract(binding.value, '$.exerciseId')
            AND a.view_role = json_extract(binding.value, '$.viewRole')
            AND a.ordinal = json_extract(binding.value, '$.ordinal')
            AND a.integrity_sha256 = json_extract(binding.value, '$.integritySha256')
       )
  ) THEN RAISE(ABORT, 'exercise media approved asset bindings do not match the attested package') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_activation_gate
BEFORE UPDATE OF publication_state ON training_exercise_media_manifests
WHEN OLD.publication_state = 'STAGED' AND NEW.publication_state = 'ACTIVE'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(DISTINCT value) FROM json_each(OLD.expected_exercise_ids_json)
  ) <> OLD.expected_exercise_count
  THEN RAISE(ABORT, 'exercise media manifest expected exercise identities are invalid') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
      FROM training_exercise_media_exercises e
     WHERE e.manifest_id = OLD.manifest_id
       AND e.scope_key = OLD.scope_key
  ) <> OLD.expected_exercise_count
  THEN RAISE(ABORT, 'exercise media manifest exercise identity set is incomplete') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
      FROM training_exercise_media_exercises e
     WHERE e.manifest_id = OLD.manifest_id
       AND e.scope_key = OLD.scope_key
       AND e.publication_state = 'APPROVED'
  ) <> OLD.expected_exercise_count
  THEN RAISE(ABORT, 'exercise media manifest approved exercise coverage is incomplete') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM json_each(OLD.expected_exercise_ids_json) expected
     WHERE NOT EXISTS (
       SELECT 1
         FROM training_exercise_media_exercises e
        WHERE e.manifest_id = OLD.manifest_id
          AND e.scope_key = OLD.scope_key
          AND e.exercise_id = expected.value
          AND e.publication_state = 'APPROVED'
     )
  ) OR EXISTS (
    SELECT 1
      FROM training_exercise_media_exercises e
     WHERE e.manifest_id = OLD.manifest_id
       AND e.scope_key = OLD.scope_key
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(OLD.expected_exercise_ids_json) expected
          WHERE expected.value = e.exercise_id
       )
  ) THEN RAISE(ABORT, 'exercise media manifest exercise identity set does not match its immutable snapshot') END;

  SELECT CASE WHEN OLD.approved_host_ref IS NULL OR NOT EXISTS (
    SELECT 1
      FROM training_exercise_media_host_approvals h
     WHERE h.approval_id = OLD.approved_host_ref
       AND h.manifest_id = OLD.manifest_id
       AND h.scope_key = OLD.scope_key
       AND h.status = 'APPROVED'
       AND h.subject_origins_json = OLD.allowed_origins_json
       AND datetime(h.reviewed_at) <= datetime('now')
       AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now'))
  ) THEN RAISE(ABORT, 'exercise media manifest approved host gate failed') END;

  SELECT CASE WHEN OLD.owner_approval_ref IS NULL OR NOT EXISTS (
    SELECT 1
      FROM training_exercise_media_owner_approvals o
     WHERE o.approval_id = OLD.owner_approval_ref
       AND o.manifest_id = OLD.manifest_id
       AND o.scope_key = OLD.scope_key
       AND o.status = 'APPROVED'
       AND o.subject_package_hash = OLD.package_hash
       AND datetime(o.reviewed_at) <= datetime('now')
       AND (o.expires_at IS NULL OR datetime(o.expires_at) > datetime('now'))
  ) THEN RAISE(ABORT, 'exercise media manifest owner package approval gate failed') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
      FROM training_exercise_media_assets a
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
  ) <> json_array_length(OLD.expected_approved_asset_bindings_json)
  THEN RAISE(ABORT, 'exercise media approved asset binding set is incomplete') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM json_each(OLD.expected_approved_asset_bindings_json) binding
     WHERE NOT EXISTS (
       SELECT 1
         FROM training_exercise_media_assets a
        WHERE a.manifest_id = OLD.manifest_id
          AND a.scope_key = OLD.scope_key
          AND a.publication_state = 'APPROVED'
          AND a.asset_id = json_extract(binding.value, '$.assetId')
          AND a.exercise_id = json_extract(binding.value, '$.exerciseId')
          AND a.view_role = json_extract(binding.value, '$.viewRole')
          AND a.ordinal = json_extract(binding.value, '$.ordinal')
          AND a.integrity_sha256 = json_extract(binding.value, '$.integritySha256')
     )
  ) OR EXISTS (
    SELECT 1
      FROM training_exercise_media_assets a
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(OLD.expected_approved_asset_bindings_json) binding
          WHERE a.asset_id = json_extract(binding.value, '$.assetId')
            AND a.exercise_id = json_extract(binding.value, '$.exerciseId')
            AND a.view_role = json_extract(binding.value, '$.viewRole')
            AND a.ordinal = json_extract(binding.value, '$.ordinal')
            AND a.integrity_sha256 = json_extract(binding.value, '$.integritySha256')
       )
  ) THEN RAISE(ABORT, 'exercise media approved asset bindings do not match the attested package') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_exercises e,
           json_each(OLD.required_locales_json) locale
     WHERE e.manifest_id = OLD.manifest_id
       AND e.scope_key = OLD.scope_key
       AND e.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_instruction_localizations l
          WHERE l.manifest_id = e.manifest_id
            AND l.scope_key = e.scope_key
            AND l.exercise_id = e.exercise_id
            AND l.locale = locale.value
       )
  ) THEN RAISE(ABORT, 'exercise media manifest instruction localization coverage is incomplete') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_instruction_localizations l
      JOIN training_exercise_media_exercises e
        ON e.manifest_id = l.manifest_id
       AND e.scope_key = l.scope_key
       AND e.exercise_id = l.exercise_id
     WHERE e.manifest_id = OLD.manifest_id
       AND e.scope_key = OLD.scope_key
       AND e.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_instruction_localization_reviews r
          WHERE r.manifest_id = l.manifest_id
            AND r.scope_key = l.scope_key
            AND r.exercise_id = l.exercise_id
            AND r.locale = l.locale
            AND r.status = 'APPROVED'
            AND r.subject_content_hash = l.content_hash
            AND datetime(r.reviewed_at) <= datetime('now')
            AND (r.expires_at IS NULL OR datetime(r.expires_at) > datetime('now'))
            AND NOT EXISTS (
              SELECT 1 FROM training_exercise_instruction_localization_reviews newer
               WHERE newer.manifest_id = r.manifest_id
                 AND newer.scope_key = r.scope_key
                 AND newer.exercise_id = r.exercise_id
                 AND newer.locale = r.locale
                 AND datetime(newer.reviewed_at) <= datetime('now')
                 AND (
                   datetime(newer.reviewed_at) > datetime(r.reviewed_at) OR
                   (datetime(newer.reviewed_at) = datetime(r.reviewed_at) AND newer.review_id > r.review_id)
                 )
            )
       )
  ) THEN RAISE(ABORT, 'exercise media manifest instruction localization review gate failed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_exercises e,
           json_each(e.required_views_json) required_view
     WHERE e.manifest_id = OLD.manifest_id
       AND e.scope_key = OLD.scope_key
       AND e.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_media_assets a
          WHERE a.manifest_id = e.manifest_id
            AND a.scope_key = e.scope_key
            AND a.exercise_id = e.exercise_id
            AND a.view_role = required_view.value
            AND a.publication_state = 'APPROVED'
       )
  ) THEN RAISE(ABORT, 'exercise media manifest required view coverage is incomplete') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_assets a,
           json_each(OLD.required_locales_json) locale
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_media_localizations l
          WHERE l.asset_id = a.asset_id
            AND l.manifest_id = a.manifest_id
            AND l.scope_key = a.scope_key
            AND l.locale = locale.value
       )
  ) THEN RAISE(ABORT, 'exercise media manifest accessibility localization coverage is incomplete') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_localizations l
      JOIN training_exercise_media_assets a
        ON a.asset_id = l.asset_id
       AND a.manifest_id = l.manifest_id
       AND a.scope_key = l.scope_key
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_media_localization_reviews r
          WHERE r.asset_id = l.asset_id
            AND r.manifest_id = l.manifest_id
            AND r.scope_key = l.scope_key
            AND r.locale = l.locale
            AND r.status = 'APPROVED'
            AND r.subject_content_hash = l.content_hash
            AND datetime(r.reviewed_at) <= datetime('now')
            AND (r.expires_at IS NULL OR datetime(r.expires_at) > datetime('now'))
            AND NOT EXISTS (
              SELECT 1 FROM training_exercise_media_localization_reviews newer
               WHERE newer.asset_id = r.asset_id
                 AND newer.manifest_id = r.manifest_id
                 AND newer.scope_key = r.scope_key
                 AND newer.locale = r.locale
                 AND datetime(newer.reviewed_at) <= datetime('now')
                 AND (
                   datetime(newer.reviewed_at) > datetime(r.reviewed_at) OR
                   (datetime(newer.reviewed_at) = datetime(r.reviewed_at) AND newer.review_id > r.review_id)
                 )
            )
       )
  ) THEN RAISE(ABORT, 'exercise media manifest media localization review gate failed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_assets a
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_media_provenance p
          WHERE p.asset_id = a.asset_id
            AND p.manifest_id = a.manifest_id
            AND p.scope_key = a.scope_key
            AND p.publication_allowed = 1
            AND (p.rights_expires_at IS NULL OR datetime(p.rights_expires_at) > datetime('now'))
       )
  ) THEN RAISE(ABORT, 'exercise media manifest provenance or license gate failed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_assets a,
           json_each(OLD.required_review_types_json) required_review
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1
           FROM training_exercise_media_reviews r
          WHERE r.asset_id = a.asset_id
            AND r.manifest_id = a.manifest_id
            AND r.scope_key = a.scope_key
            AND r.review_type = required_review.value
            AND r.status = 'APPROVED'
            AND r.subject_content_hash = CASE
              WHEN required_review.value = 'ACCESSIBILITY' THEN a.accessibility_bundle_hash
              ELSE a.integrity_sha256
            END
            AND datetime(r.reviewed_at) <= datetime('now')
            AND (r.expires_at IS NULL OR datetime(r.expires_at) > datetime('now'))
            AND NOT EXISTS (
              SELECT 1
                FROM training_exercise_media_reviews newer
               WHERE newer.asset_id = r.asset_id
                 AND newer.manifest_id = r.manifest_id
                 AND newer.scope_key = r.scope_key
                 AND newer.review_type = r.review_type
                 AND datetime(newer.reviewed_at) <= datetime('now')
                 AND (
                   datetime(newer.reviewed_at) > datetime(r.reviewed_at) OR
                   (datetime(newer.reviewed_at) = datetime(r.reviewed_at) AND newer.review_id > r.review_id)
                 )
            )
       )
  ) THEN RAISE(ABORT, 'exercise media manifest review gate failed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM training_exercise_media_assets a
     WHERE a.manifest_id = OLD.manifest_id
       AND a.scope_key = OLD.scope_key
       AND a.publication_state = 'APPROVED'
       AND (
         SELECT t.action
           FROM training_exercise_media_takedown_events t
          WHERE t.asset_id = a.asset_id
            AND t.manifest_id = a.manifest_id
            AND t.scope_key = a.scope_key
            AND datetime(t.effective_at) <= datetime('now')
          ORDER BY datetime(t.effective_at) DESC, t.event_id DESC
          LIMIT 1
       ) = 'REMOVE'
  ) THEN RAISE(ABORT, 'exercise media manifest contains an active takedown') END;
END;

-- Frozen package content cannot gain new rows after staging attestation. Asset,
-- localization, host, and owner reviews plus takedowns are intentionally excluded:
-- they remain append-only governance ledgers so a later rejection, expiry,
-- removal, or reinstatement can take effect without mutating the approved package.
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_exercise_no_finalized_insert
BEFORE INSERT ON training_exercise_media_exercises
WHEN EXISTS (
  SELECT 1 FROM training_exercise_media_manifests m
   WHERE m.manifest_id = NEW.manifest_id AND m.scope_key = NEW.scope_key
     AND m.publication_state IN ('STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED')
)
BEGIN SELECT RAISE(ABORT, 'exercise media staged manifest content is frozen'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_asset_no_finalized_insert
BEFORE INSERT ON training_exercise_media_assets
WHEN EXISTS (
  SELECT 1 FROM training_exercise_media_manifests m
   WHERE m.manifest_id = NEW.manifest_id AND m.scope_key = NEW.scope_key
     AND m.publication_state IN ('STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED')
)
BEGIN SELECT RAISE(ABORT, 'exercise media staged manifest content is frozen'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_provenance_no_finalized_insert
BEFORE INSERT ON training_exercise_media_provenance
WHEN EXISTS (
  SELECT 1
    FROM training_exercise_media_assets a
    JOIN training_exercise_media_manifests m
      ON m.manifest_id = a.manifest_id AND m.scope_key = a.scope_key
   WHERE a.asset_id = NEW.asset_id
     AND m.publication_state IN ('STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED')
)
BEGIN SELECT RAISE(ABORT, 'exercise media staged manifest content is frozen'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_instruction_localization_no_finalized_insert
BEFORE INSERT ON training_exercise_instruction_localizations
WHEN EXISTS (
  SELECT 1 FROM training_exercise_media_manifests m
   WHERE m.manifest_id = NEW.manifest_id AND m.scope_key = NEW.scope_key
     AND m.publication_state IN ('STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED')
)
BEGIN SELECT RAISE(ABORT, 'exercise media staged manifest content is frozen'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_localization_no_finalized_insert
BEFORE INSERT ON training_exercise_media_localizations
WHEN EXISTS (
  SELECT 1
    FROM training_exercise_media_assets a
    JOIN training_exercise_media_manifests m
      ON m.manifest_id = a.manifest_id AND m.scope_key = a.scope_key
   WHERE a.asset_id = NEW.asset_id
     AND m.publication_state IN ('STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED')
)
BEGIN SELECT RAISE(ABORT, 'exercise media staged manifest content is frozen'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_manifest_no_delete
BEFORE DELETE ON training_exercise_media_manifests
BEGIN
  SELECT RAISE(ABORT, 'exercise media manifests are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_exercise_immutable_update
BEFORE UPDATE ON training_exercise_media_exercises
BEGIN SELECT RAISE(ABORT, 'exercise media exercise rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_exercise_immutable_delete
BEFORE DELETE ON training_exercise_media_exercises
BEGIN SELECT RAISE(ABORT, 'exercise media exercise rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_asset_immutable_update
BEFORE UPDATE ON training_exercise_media_assets
BEGIN SELECT RAISE(ABORT, 'exercise media asset rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_asset_immutable_delete
BEFORE DELETE ON training_exercise_media_assets
BEGIN SELECT RAISE(ABORT, 'exercise media asset rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_provenance_immutable_update
BEFORE UPDATE ON training_exercise_media_provenance
BEGIN SELECT RAISE(ABORT, 'exercise media provenance rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_provenance_immutable_delete
BEFORE DELETE ON training_exercise_media_provenance
BEGIN SELECT RAISE(ABORT, 'exercise media provenance rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_instruction_localization_immutable_update
BEFORE UPDATE ON training_exercise_instruction_localizations
BEGIN SELECT RAISE(ABORT, 'exercise instruction localizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_instruction_localization_immutable_delete
BEFORE DELETE ON training_exercise_instruction_localizations
BEGIN SELECT RAISE(ABORT, 'exercise instruction localizations are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_localization_immutable_update
BEFORE UPDATE ON training_exercise_media_localizations
BEGIN SELECT RAISE(ABORT, 'exercise media localizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_localization_immutable_delete
BEFORE DELETE ON training_exercise_media_localizations
BEGIN SELECT RAISE(ABORT, 'exercise media localizations are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_review_immutable_update
BEFORE UPDATE ON training_exercise_media_reviews
BEGIN SELECT RAISE(ABORT, 'exercise media reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_review_immutable_delete
BEFORE DELETE ON training_exercise_media_reviews
BEGIN SELECT RAISE(ABORT, 'exercise media reviews are append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_instruction_localization_review_immutable_update
BEFORE UPDATE ON training_exercise_instruction_localization_reviews
BEGIN SELECT RAISE(ABORT, 'exercise instruction localization reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_instruction_localization_review_immutable_delete
BEFORE DELETE ON training_exercise_instruction_localization_reviews
BEGIN SELECT RAISE(ABORT, 'exercise instruction localization reviews are append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_localization_review_immutable_update
BEFORE UPDATE ON training_exercise_media_localization_reviews
BEGIN SELECT RAISE(ABORT, 'exercise media localization reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_localization_review_immutable_delete
BEFORE DELETE ON training_exercise_media_localization_reviews
BEGIN SELECT RAISE(ABORT, 'exercise media localization reviews are append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_host_approval_immutable_update
BEFORE UPDATE ON training_exercise_media_host_approvals
BEGIN SELECT RAISE(ABORT, 'exercise media host approvals are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_host_approval_immutable_delete
BEFORE DELETE ON training_exercise_media_host_approvals
BEGIN SELECT RAISE(ABORT, 'exercise media host approvals are append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_owner_approval_immutable_update
BEFORE UPDATE ON training_exercise_media_owner_approvals
BEGIN SELECT RAISE(ABORT, 'exercise media owner approvals are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_owner_approval_immutable_delete
BEFORE DELETE ON training_exercise_media_owner_approvals
BEGIN SELECT RAISE(ABORT, 'exercise media owner approvals are append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_takedown_immutable_update
BEFORE UPDATE ON training_exercise_media_takedown_events
BEGIN SELECT RAISE(ABORT, 'exercise media takedowns are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_training_exercise_media_takedown_immutable_delete
BEFORE DELETE ON training_exercise_media_takedown_events
BEGIN SELECT RAISE(ABORT, 'exercise media takedowns are append-only'); END;

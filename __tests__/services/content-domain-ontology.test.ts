import { describe, expect, it } from 'vitest';

import {
  CONTENT_OBJECT_TYPES,
  CONTENT_ONTOLOGY_SCHEMA_VERSION,
  getPlatformFormatDefinition,
  listContentObjectSchemas,
  listPlatformFormatDefinitions,
  listReferenceSourceDefinitions,
  validateContentDomainObject,
  validateGenerationReadiness,
  validatePlatformFormatDefinition,
  validateReferenceMetadata,
  validateSourceOutputLink,
  type PlatformFormatDefinition,
} from '../../src/services/content-domain-ontology';

function readyBookReference(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: 'book',
    tenantId: 101,
    ownerUserId: 501,
    visibilityScope: 'user_private',
    freshness: 0.9,
    confidence: 0.86,
    trustLevel: 'curated',
    extractionStatus: 'ready',
    topicTags: ['creator-ops'],
    metadata: {
      title: 'Creative Strategy',
      author: 'A. Author',
      trustLevel: 'curated',
      extractionStatus: 'ready',
      ...overrides,
    },
  };
}

describe('Content domain ontology', () => {
  it('defines typed schemas for the core Content object model', () => {
    const schemas = listContentObjectSchemas();
    const schemaTypes = schemas.map((schema) => schema.objectType);

    expect(CONTENT_ONTOLOGY_SCHEMA_VERSION).toBe('content-ontology-v1');
    expect(schemaTypes).toEqual(expect.arrayContaining([...CONTENT_OBJECT_TYPES]));
    expect(schemas.find((schema) => schema.objectType === 'script')).toMatchObject({
      supportsPlatformFormat: true,
      supportsSourceAttribution: true,
      supportsReuseLineage: true,
    });
    expect(schemas.find((schema) => schema.objectType === 'reference')?.requiredMetadata)
      .toEqual(expect.arrayContaining(['sourceType', 'trustLevel', 'extractionStatus']));
  });

  it('defines platform-aware format metadata with production and review requirements', () => {
    const formats = listPlatformFormatDefinitions();
    const youtube = getPlatformFormatDefinition('youtube_long_form');
    const xThread = getPlatformFormatDefinition('x_thread');

    expect(formats.length).toBeGreaterThanOrEqual(12);
    expect(youtube?.platforms).toContain('youtube');
    expect(youtube?.productionRequirements).toEqual(expect.arrayContaining(['title_options', 'thumbnail_angle']));
    expect(youtube?.editingReviewNeeds).toContain('source_pass');
    expect(xThread?.primaryObjectType).toBe('thread');

    for (const definition of formats) {
      expect(validatePlatformFormatDefinition(definition).valid).toBe(true);
    }
  });

  it('validates reference metadata completeness before retrieval or prompt use', () => {
    const ready = validateReferenceMetadata(readyBookReference());
    const incomplete = validateReferenceMetadata({
      sourceType: 'book',
      tenantId: 101,
      ownerUserId: 501,
      visibilityScope: 'user_private',
      confidence: 0.8,
      trustLevel: 'curated',
      extractionStatus: 'ready',
      metadata: { title: 'Missing Author' },
    });

    expect(listReferenceSourceDefinitions().map((source) => source.sourceType))
      .toEqual(expect.arrayContaining(['book', 'link', 'channel', 'previous_content', 'radar_signal']));
    expect(ready.valid).toBe(true);
    expect(incomplete.valid).toBe(false);
    expect(incomplete.errors.join('\n')).toContain('missing reference metadata: author');
  });

  it('validates tenant/user scope, platform format, and strategy linkage for generated objects', () => {
    const result = validateGenerationReadiness({
      objectType: 'script',
      title: 'How creators can protect deep work',
      tenantId: 101,
      ownerUserId: 501,
      visibilityScope: 'user_private',
      lifecycleState: 'drafting',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
      pillarIds: ['creator-operating-system'],
      audienceSegmentIds: ['busy-creators'],
      sourceReferences: [readyBookReference()],
      metadata: {
        contentGoal: 'Teach one repeatable workflow',
        voiceProfileId: 'voice-101',
        productionIntent: 'filmable script',
        viewerPromise: 'protect deep work without losing publishing cadence',
        thumbnailAngle: 'calendar chaos vs clean creation system',
      },
    });

    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('rejects generation objects with missing critical metadata instead of relying on prompt strings', () => {
    const result = validateGenerationReadiness({
      objectType: 'script',
      title: 'Generic script',
      tenantId: 101,
      ownerUserId: 501,
      visibilityScope: 'user_private',
      lifecycleState: 'drafting',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
      metadata: {
        voiceProfileId: 'voice-101',
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'missing object metadata: contentGoal',
      'missing object metadata: productionIntent',
      'missing format metadata: viewerPromise',
      'missing format metadata: thumbnailAngle',
      'at least one content pillar is required for generation',
      'at least one audience segment is required for generation',
      'contentGoal is required for generation',
    ]));
  });

  it('tracks source-to-output lineage with tenant-safe linkage metadata', () => {
    const valid = validateSourceOutputLink({
      tenantId: 101,
      ownerUserId: 501,
      visibilityScope: 'user_private',
      sourceType: 'book',
      sourceId: 'book:12',
      outputObjectType: 'script',
      outputId: 'script:44',
      usageType: 'evidence',
      confidence: 0.81,
    });
    const invalid = validateSourceOutputLink({
      tenantId: 101,
      sourceType: 'book',
      sourceId: 'book:12',
      outputObjectType: 'script',
      outputId: 'script:44',
      usageType: 'evidence',
    });

    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join('\n')).toContain('ownerUserId is required');
  });

  it('allows tenant-defined formats only through typed extension definitions', () => {
    const customFormat: PlatformFormatDefinition = {
      formatId: 'founder_memo',
      platforms: ['newsletter'],
      label: 'Founder Memo',
      primaryObjectType: 'newsletter',
      structure: ['context', 'decision', 'lesson', 'ask'],
      lengthExpectation: '400-900 words.',
      pacing: 'Tight editorial narrative.',
      hookStyle: ['earned_lesson'],
      productionRequirements: ['approval_owner', 'source_attribution'],
      sourceUsagePattern: 'Use first-party notes and explicit citations only.',
      editingReviewNeeds: ['privacy_pass', 'source_pass'],
      requiredMetadata: ['readerPromise', 'approvalOwner'],
      extensibleViaTenantConfig: true,
    };

    expect(getPlatformFormatDefinition('founder_memo')).toBeNull();
    expect(validatePlatformFormatDefinition(customFormat).valid).toBe(true);
    expect(getPlatformFormatDefinition('founder_memo', [customFormat])?.label).toBe('Founder Memo');

    const object = validateContentDomainObject({
      objectType: 'newsletter',
      title: 'April product memo',
      tenantId: 101,
      ownerUserId: 501,
      visibilityScope: 'user_private',
      lifecycleState: 'drafting',
      platformId: 'newsletter',
      formatId: 'founder_memo',
      metadata: {
        readerPromise: 'what changed and why',
        sectionPlan: ['context', 'decision'],
        approvalOwner: 'Felipe',
      },
    }, { customFormatDefinitions: [customFormat] });

    expect(object.valid).toBe(true);
  });
});

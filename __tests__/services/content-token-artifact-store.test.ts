import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCreatorVoiceCard, buildSourcePackage } from '../../src/services/content-token-economy';
import {
  ensureContentTokenArtifactTables,
  getContentResearchArtifact,
  getContentSourcePackage,
  listRecentContentIdeaMemory,
  persistContentArtifacts,
  recordContentVariantFeedback,
} from '../../src/services/content-token-artifact-store';

describe('content token artifact store', () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  function openDb(): Database.Database {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureContentTokenArtifactTables(db);
    return db;
  }

  it('persists tenant-scoped voice cards, source packages, research artifacts, and idea memory', () => {
    const testDb = openDb();
    const voiceCard = buildCreatorVoiceCard({
      tenantId: 44,
      userId: 7,
      language: 'pt-BR',
      niche: 'creator tools',
      voiceMemory: '[brand_voice] Use concise proof before advice.',
    });
    const sourcePackage = buildSourcePackage({
      topic: 'AI scripting workflow',
      language: 'pt-BR',
      format: 'YouTube',
      mode: 'draft',
      sources: [
        {
          title: 'Source A',
          url: 'https://www.usatriathlon.org/safety/open-water-swimming',
          source_type: 'web',
          relevance_note: 'Useful compact source.',
        },
      ],
      warnings: [],
    });

    const persisted = persistContentArtifacts({
      tenantId: 44,
      userId: 7,
      topic: 'AI scripting workflow',
      voiceCard,
      sourcePackage,
      hook: 'Most creators waste tokens before they write.',
      angle: 'cost control',
      format: 'YouTube',
    }, testDb);

    expect(persisted.voiceCardVersion).toBe(voiceCard.voiceCardVersion);
    expect(persisted.sourcePackageId).toBe(sourcePackage.sourcePackageId);
    expect(persisted.researchArtifactId).toBe(sourcePackage.researchArtifactId);

    const fetchedPackage = getContentSourcePackage(
      { tenantId: 44, userId: 7 },
      sourcePackage.sourcePackageId,
      testDb,
    );
    expect(fetchedPackage?.sourceSummary).toEqual(sourcePackage.sourceSummaries);
    expect(fetchedPackage?.topicHash).toBe(sourcePackage.topicHash);
    expect(fetchedPackage?.sources[0].url).toBe('https://www.usatriathlon.org/safety/open-water-swimming');

    const fetchedArtifact = getContentResearchArtifact(
      { tenantId: 44, userId: 7 },
      sourcePackage.researchArtifactId,
      testDb,
    );
    expect(fetchedArtifact?.claims).toEqual(sourcePackage.claims);
    expect(fetchedArtifact?.claimBinding).toEqual({
      status: 'unavailable',
      reasonCode: 'CONTENT_CLAIM_SOURCE_BINDING_NOT_MODELED',
    });

    const memory = listRecentContentIdeaMemory({ tenantId: 44, userId: 7 }, 3, testDb);
    expect(memory).toEqual([
      expect.objectContaining({
        topic: 'AI scripting workflow',
        hook: 'Most creators waste tokens before they write.',
        angle: 'cost control',
        format: 'YouTube',
      }),
    ]);
  });

  it('persists reusable research without recording a generated idea', () => {
    const testDb = openDb();
    const sourcePackage = buildSourcePackage({
      topic: 'Current launch research',
      language: 'en-US',
      format: 'hooks',
      mode: 'standard',
      sources: [{
        title: 'Current source',
        url: 'https://example.org/current-source',
        source_type: 'article',
        relevance_note: 'Current source context.',
      }],
    });

    persistContentArtifacts({
      tenantId: 44,
      userId: 7,
      topic: 'Current launch research',
      sourcePackage,
      format: 'hooks',
      recordIdeaMemory: false,
    }, testDb);

    expect(getContentSourcePackage(
      { tenantId: 44, userId: 7 },
      sourcePackage.sourcePackageId,
      testDb,
    )).not.toBeNull();
    expect(listRecentContentIdeaMemory({ tenantId: 44, userId: 7 }, 5, testDb)).toEqual([]);
  });

  it('does not leak artifacts across tenants or users', () => {
    const testDb = openDb();
    const sourcePackage = buildSourcePackage({
      topic: 'AI scripting workflow',
      language: 'en-US',
      format: 'Reel',
      mode: 'draft',
      sources: [{ title: 'Source A', url: 'https://www.usatriathlon.org/safety/open-water-swimming', relevance_note: 'Scoped source.' }],
    });
    persistContentArtifacts({
      tenantId: 44,
      userId: 7,
      topic: 'AI scripting workflow',
      sourcePackage,
    }, testDb);

    expect(getContentSourcePackage({ tenantId: 45, userId: 7 }, sourcePackage.sourcePackageId, testDb)).toBeNull();
    expect(getContentSourcePackage({ tenantId: 44, userId: 8 }, sourcePackage.sourcePackageId, testDb)).toBeNull();
    expect(getContentResearchArtifact({ tenantId: 45, userId: 7 }, sourcePackage.researchArtifactId, testDb)).toBeNull();
  });

  it('records accepted and rejected generated variants for future novelty control', () => {
    const testDb = openDb();
    recordContentVariantFeedback({
      tenantId: 44,
      userId: 7,
      topic: 'AI scripting workflow',
      variantKind: 'hook',
      variantText: 'Most creators waste tokens before they write.',
      sentiment: 'approved',
      angle: 'cost control',
      format: 'YouTube',
    }, testDb);
    recordContentVariantFeedback({
      tenantId: 44,
      userId: 7,
      topic: 'AI scripting workflow',
      variantKind: 'title',
      variantText: 'Generic AI tips for everyone',
      sentiment: 'rejected',
      angle: 'generic',
      format: 'YouTube',
      notes: 'Too broad',
    }, testDb);

    const memory = listRecentContentIdeaMemory({ tenantId: 44, userId: 7 }, 5, testDb);
    expect(memory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        topic: 'AI scripting workflow',
        hook: 'Generic AI tips for everyone',
        variant_kind: 'title',
        feedback_sentiment: 'rejected',
        accepted: 0,
      }),
      expect.objectContaining({
        topic: 'AI scripting workflow',
        hook: 'Most creators waste tokens before they write.',
        variant_kind: 'hook',
        feedback_sentiment: 'approved',
        accepted: 1,
      }),
    ]));
  });
});

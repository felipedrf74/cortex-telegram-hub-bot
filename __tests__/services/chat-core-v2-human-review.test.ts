import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { ChatV2HumanReviewRequest } from '../../src/services/chat-core-v2';
import {
  decideChatV2HumanReview,
  enqueueChatV2HumanReview,
  ensureChatCoreV2HumanReviewTables,
  expireChatV2HumanReviews,
  getChatV2HumanReviewById,
  listPendingChatV2HumanReviews,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const baseReview: ChatV2HumanReviewRequest = {
  reviewId: 'review-1',
  turnId: 'turn-1',
  commandId: 'cmd-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  domain: 'finance',
  reason: 'restricted_finance',
  status: 'pending',
  sensitivity: 'financial',
  redactedSummary: 'Finance action requires manual review.',
  metadata: { risk: 'restricted', commandType: 'finance.execute_restricted' },
  requestedAt: '2026-05-24T10:00:00.000Z',
  expiresAt: '2026-05-25T10:00:00.000Z',
};

describe('Chat Core v2 human review queue', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the human review table without raw command or prompt columns', () => {
    ensureChatCoreV2HumanReviewTables(db);

    const columns = db.prepare('PRAGMA table_info(chat_v2_human_reviews)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('redacted_summary');
    expect(names).toContain('metadata_json');
    expect(names).not.toContain('raw_payload_json');
    expect(names).not.toContain('raw_prompt');
    expect(names).not.toContain('provider_payload_json');
  });

  it('enqueues pending review requests and lists them by tenant in FIFO order', () => {
    enqueueChatV2HumanReview({
      ...baseReview,
      reviewId: 'review-2',
      requestedAt: '2026-05-24T10:00:02.000Z',
    }, db);
    enqueueChatV2HumanReview({
      ...baseReview,
      reviewId: 'review-1',
      requestedAt: '2026-05-24T10:00:01.000Z',
    }, db);
    enqueueChatV2HumanReview({
      ...baseReview,
      reviewId: 'other-tenant-review',
      tenantId: 'tenant-2',
      requestedAt: '2026-05-24T10:00:03.000Z',
    }, db);

    const pending = listPendingChatV2HumanReviews(db, { tenantId: 'tenant-1' });

    expect(pending.map((review) => review.reviewId)).toEqual(['review-1', 'review-2']);
    expect(pending[0]).toMatchObject({
      status: 'pending',
      sensitivity: 'financial',
      metadata: { risk: 'restricted', commandType: 'finance.execute_restricted' },
    });
  });

  it('upserts pending reviews by reviewId for retry-safe enqueue', () => {
    enqueueChatV2HumanReview(baseReview, db);
    enqueueChatV2HumanReview({
      ...baseReview,
      redactedSummary: 'Updated review summary.',
      metadata: { risk: 'restricted', retry: true },
    }, db);

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_v2_human_reviews WHERE review_id = ?')
      .get('review-1') as { count: number };
    const saved = getChatV2HumanReviewById('review-1', db);

    expect(count.count).toBe(1);
    expect(saved?.redactedSummary).toBe('Updated review summary.');
    expect(saved?.metadata).toEqual({ risk: 'restricted', retry: true });
  });

  it('records reviewer decisions and blocks repeated decisions', () => {
    enqueueChatV2HumanReview(baseReview, db);

    const approved = decideChatV2HumanReview({
      reviewId: 'review-1',
      reviewerUserId: 'owner-1',
      decision: 'approve',
      decisionNote: 'Reviewed in staging.',
      decidedAt: '2026-05-24T10:05:00.000Z',
    }, db);

    expect(approved).toMatchObject({
      status: 'approved',
      reviewerUserId: 'owner-1',
      decisionNote: 'Reviewed in staging.',
      decidedAt: '2026-05-24T10:05:00.000Z',
    });
    expect(() => decideChatV2HumanReview({
      reviewId: 'review-1',
      reviewerUserId: 'owner-1',
      decision: 'deny',
    }, db)).toThrow(/not pending/);
  });

  it('expires pending reviews without touching decided rows', () => {
    enqueueChatV2HumanReview({
      ...baseReview,
      reviewId: 'expired-review',
      expiresAt: '2026-05-24T09:59:00.000Z',
    }, db);
    enqueueChatV2HumanReview({
      ...baseReview,
      reviewId: 'future-review',
      expiresAt: '2026-05-24T10:30:00.000Z',
    }, db);
    enqueueChatV2HumanReview({
      ...baseReview,
      reviewId: 'approved-review',
      expiresAt: '2026-05-24T09:59:00.000Z',
    }, db);
    decideChatV2HumanReview({
      reviewId: 'approved-review',
      reviewerUserId: 'owner-1',
      decision: 'approve',
      decidedAt: '2026-05-24T10:00:00.000Z',
    }, db);

    expect(expireChatV2HumanReviews('2026-05-24T10:00:00.000Z', db)).toBe(1);
    expect(getChatV2HumanReviewById('expired-review', db)?.status).toBe('expired');
    expect(getChatV2HumanReviewById('future-review', db)?.status).toBe('pending');
    expect(getChatV2HumanReviewById('approved-review', db)?.status).toBe('approved');
  });

  it('rejects invalid review metadata and non-pending enqueue attempts before SQLite checks', () => {
    expect(() => enqueueChatV2HumanReview({
      ...baseReview,
      domain: 'unknown' as ChatV2HumanReviewRequest['domain'],
    }, db)).toThrow(/domain/);

    expect(() => enqueueChatV2HumanReview({
      ...baseReview,
      reason: 'unknown' as ChatV2HumanReviewRequest['reason'],
    }, db)).toThrow(/reason/);

    expect(() => enqueueChatV2HumanReview({
      ...baseReview,
      status: 'approved',
    }, db)).toThrow(/pending/);

    expect(() => enqueueChatV2HumanReview({
      ...baseReview,
      redactedSummary: '',
    }, db)).toThrow(/redactedSummary/);
  });

  it('bounds long redacted summaries for review dashboards', () => {
    const saved = enqueueChatV2HumanReview({
      ...baseReview,
      redactedSummary: 'x'.repeat(1200),
    }, db);

    expect(saved.redactedSummary).toHaveLength(1000);
  });
});

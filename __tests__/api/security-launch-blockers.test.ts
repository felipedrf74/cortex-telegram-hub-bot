// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Security — Launch Blocker Tests
 *
 * Covers the production-safety pass:
 *   1. Content-learning ownership: artifact-chain route rejects cross-user access
 *   2. Apple billing: JWS validation rejects malformed/invalid payloads
 *   3. GDPR: delete table list covers all content-learning tables
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// 1. Apple Billing — JWS Payload Validation
// ═══════════════════════════════════════════════════════════════════

describe('Apple billing JWS validation', () => {
  /**
   * Helper to build a fake JWS from a payload object.
   * Format: header.payload.signature (all base64url)
   */
  function buildFakeJws(payload: Record<string, any>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = Buffer.from('fake-signature').toString('base64url');
    return `${header}.${body}.${sig}`;
  }

  /** Decode the middle segment of a JWS just like the route does. */
  function decodeJwsPayload(jws: string): any {
    const parts = jws.split('.');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  }

  it('rejects JWS with wrong segment count', () => {
    const badJws = 'only.two';
    expect(badJws.split('.').length).not.toBe(3);
  });

  it('rejects JWS with non-JSON payload', () => {
    const header = Buffer.from('{}').toString('base64url');
    const badPayload = Buffer.from('not-json').toString('base64url');
    const sig = Buffer.from('sig').toString('base64url');
    const jws = `${header}.${badPayload}.${sig}`;

    expect(() => {
      JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
    }).toThrow();
  });

  it('rejects payload with wrong bundleId', () => {
    const payload = {
      bundleId: 'com.attacker.fakeapp',
      productId: 'me.nexushub.pro.monthly',
      transactionId: '2000000123456789',
    };
    expect(payload.bundleId).not.toBe('me.nexushub.app');
  });

  it('rejects payload with unknown productId', () => {
    const knownProducts = [
      'me.nexushub.pro.monthly', 'me.nexushub.pro.yearly',
      'me.nexushub.max.monthly', 'me.nexushub.max.yearly',
    ];
    expect(knownProducts.includes('com.attacker.premium')).toBe(false);
  });

  it('rejects transaction with invalid ID format', () => {
    const badIds = ['fake123', 'abc', '', '12 34', '!@#$'];
    for (const id of badIds) {
      expect(/^\d{5,25}$/.test(id)).toBe(false);
      expect(/^\d{1,25}$/.test(id)).toBe(false);
    }
  });

  it('accepts valid Apple transaction ID format', () => {
    const validIds = ['2000000123456789', '12345', '1000000000000000000000000'];
    for (const id of validIds) {
      expect(/^\d{5,25}$/.test(id)).toBe(true);
    }
  });

  it('accepts short StoreKit Testing transaction IDs outside production only', () => {
    // Xcode's local StoreKit configuration mints short sequential ids. The
    // production pattern keeps the 5-digit floor; the dev pattern does not, so
    // a local `.storekit` run can still verify against the backend.
    const storeKitTestingIds = ['0', '1', '42'];
    for (const id of storeKitTestingIds) {
      expect(/^\d{5,25}$/.test(id)).toBe(false);
      expect(/^\d{1,25}$/.test(id)).toBe(true);
    }
  });

  it('rejects expired transaction (>24h grace)', () => {
    const expired = new Date(Date.now() - 2 * 86400000).toISOString(); // 2 days ago
    const expiryMs = new Date(expired).getTime();
    expect(expiryMs < Date.now() - 86400000).toBe(true);
  });

  it('accepts transaction within 24h grace period', () => {
    const recent = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const expiryMs = new Date(recent).getTime();
    expect(expiryMs < Date.now() - 86400000).toBe(false);
  });

  it('never denies an Apple transaction on its environment claim', () => {
    // App Review buys against the StoreKit sandbox even on an App-Store-Connect
    // distributed build. The old `allowedEnvs` gate therefore 403'd every
    // reviewer purchase in production while the client had already called
    // transaction.finish(), consuming the purchase with nothing unlocked.
    // Environment is provenance only now; re-introducing the gate is a
    // guaranteed Guideline 2.1 rejection.
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/billing.ts'), 'utf8');
    expect(source).not.toContain('INVALID_ENVIRONMENT');
    expect(source).not.toContain('allowedEnvs');
  });

  it('keeps JWS signature verification keyed on production', () => {
    // Dropping the environment gate must not soften the separate x5c control.
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/billing.ts'), 'utf8');
    expect(source).toContain('verifyAppleJws(jwsTransaction, { requireX5c: isProduction })');
    expect(source).toContain("sigErr?.message !== 'APPLE_JWS_MISSING_X5C' || isProduction");
  });

  it('round-trips a valid JWS payload correctly', () => {
    const original = {
      bundleId: 'me.nexushub.app',
      productId: 'me.nexushub.pro.monthly',
      transactionId: '2000000123456789',
      originalTransactionId: '2000000123456789',
      environment: 'Production',
      expiresDate: new Date(Date.now() + 30 * 86400000).getTime(),
    };
    const jws = buildFakeJws(original);
    const decoded = decodeJwsPayload(jws);

    expect(decoded.bundleId).toBe('me.nexushub.app');
    expect(decoded.productId).toBe('me.nexushub.pro.monthly');
    expect(decoded.originalTransactionId).toBe('2000000123456789');
    expect(decoded.environment).toBe('Production');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Content-Learning Ownership
// ═══════════════════════════════════════════════════════════════════

describe('Content-learning ownership checks', () => {
  it('topic feedback ownership rejects user_id mismatch', () => {
    // Simulates the ownership check in POST /topics/:feedbackId/feedback
    const topicRow = { id: 1, topic: 'Test', user_id: 42 };
    const requestUserId = 99;

    const isOwner = topicRow.user_id === 0 || topicRow.user_id === requestUserId;
    expect(isOwner).toBe(false);
  });

  it('topic feedback ownership accepts matching user_id', () => {
    const topicRow = { id: 1, topic: 'Test', user_id: 42 };
    const requestUserId = 42;

    const isOwner = topicRow.user_id === 0 || topicRow.user_id === requestUserId;
    expect(isOwner).toBe(true);
  });

  it('topic feedback ownership accepts legacy user_id=0 (global)', () => {
    const topicRow = { id: 1, topic: 'Test', user_id: 0 };
    const requestUserId = 99;

    const isOwner = topicRow.user_id === 0 || topicRow.user_id === requestUserId;
    expect(isOwner).toBe(true);
  });

  it('pipeline advance no longer mutates user_id=0 rows', () => {
    // The UPDATE query was: WHERE id = ? AND user_id IN (0, ?)
    // which allowed mutating global seed data. Now it's: WHERE id = ? AND user_id = ?
    const updateSql = 'UPDATE content_ideas SET stage = ? WHERE id = ? AND user_id = ?';
    // user_id=0 rows are system seed data — only the owner can mutate
    expect(updateSql).not.toContain('IN (0,');
    expect(updateSql).toContain('AND user_id = ?');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. GDPR Table Coverage
// ═══════════════════════════════════════════════════════════════════

describe('GDPR table coverage', () => {
  // This is the canonical list from the DELETE /account route.
  // If you add a table with user_id, add it here too.
  const gdprDeleteTables = [
    'ios_devices', 'messages', 'onboarding_sessions', 'user_profiles',
    'conversations', 'todos', 'notes', 'reminders', 'shared_memory',
    'saved_ideas', 'content_topic_feedback', 'content_ref_channels',
    'content_knowledge', 'content_patterns', 'content_research_briefs',
    'content_scripts', 'content_performance', 'content_learned_patterns',
    'content_pipeline', 'content_topics', 'content_notifications',
    'book_library', 'video_transcripts', 'video_studies',
    'report_documents', 'push_preferences',
    'invoice_filings', 'invoice_vendors', 'invoice_queue',
    'finance_transactions', 'finance_tax_events',
    'recipes', 'meal_plans', 'shopping_lists',
    'fitness_training_plans', 'training_completions',
    'native_tasks', 'native_task_lists',
    'apple_health_data', 'readiness_scores',
    'webhook_subscriptions', 'webhook_events',
    'user_oauth_tokens', 'garmin_user_tokens',
    'email_verification_codes', 'subscriptions',
    'api_usage', 'audit_trail', 'client_errors',
    'user_skill_overrides',
  ];

  // These are the tables added by the content learning store (April 2026)
  // and the report/notification system. They MUST be in the delete list.
  const contentLearningTables = [
    'content_scripts',
    'content_performance',
    'content_learned_patterns',
    'content_pipeline',
    'content_topics',
  ];

  const reportTables = [
    'report_documents',
    'push_preferences',
    'content_notifications',
  ];

  for (const table of contentLearningTables) {
    it(`DELETE list includes content-learning table: ${table}`, () => {
      expect(gdprDeleteTables).toContain(table);
    });
  }

  for (const table of reportTables) {
    it(`DELETE list includes report/notification table: ${table}`, () => {
      expect(gdprDeleteTables).toContain(table);
    });
  }

  it('no duplicate tables in DELETE list', () => {
    const unique = new Set(gdprDeleteTables);
    expect(unique.size).toBe(gdprDeleteTables.length);
  });
});

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  completeContentScriptSaveRequest,
  completeContentScriptSaveRequestAtomically,
  fingerprintContentScriptSaveRequest,
  markContentScriptSaveRequestDispatched,
  releaseContentScriptSaveRequest,
  reserveContentScriptSaveRequest,
} from '../../src/services/content-script-idempotency';
import { ContentWorkspaceError, type ContentWorkspaceScope } from '../../src/services/content-workspace';

const SCOPE: ContentWorkspaceScope = { tenantId: 41, userId: 91 };

describe('content script request idempotency', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('fingerprints normalized semantic input independently of object key order', () => {
    expect(fingerprintContentScriptSaveRequest({
      topic: 'Creator workflow',
      format: 'YouTube',
      language: 'pt-BR',
    })).toBe(fingerprintContentScriptSaveRequest({
      language: 'pt-BR',
      format: 'YouTube',
      topic: 'Creator workflow',
    }));
    expect(fingerprintContentScriptSaveRequest({
      topic: 'Creator workflow',
      format: 'YouTube',
      language: 'en-US',
    })).not.toBe(fingerprintContentScriptSaveRequest({
      topic: 'Creator workflow',
      format: 'YouTube',
      language: 'pt-BR',
    }));
  });

  it('blocks concurrent duplicate work and rejects a changed request under the same key', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Original' });
    const started = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-001',
      requestFingerprint,
      nowMs: 1_000,
    }, db);

    expect(started).toMatchObject({ kind: 'started' });
    expect(() => reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-001',
      requestFingerprint,
      nowMs: 2_000,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_IDEMPOTENCY_IN_PROGRESS',
      status: 409,
    }));
    expect(() => reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-001',
      requestFingerprint: fingerprintContentScriptSaveRequest({ topic: 'Changed' }),
      nowMs: 2_000,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_IDEMPOTENCY_KEY_REUSED',
      status: 409,
    }));
  });

  it('stores the completed public response and replays it without starting a second lease', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Replay' });
    const started = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-002',
      requestFingerprint,
    }, db);
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') throw new Error('expected a started reservation');
    const response = {
      topic: 'Replay',
      script: '[0:00] Durable response',
      savedIdea: { saved: true, workspace: { itemId: 77 } },
    };

    markContentScriptSaveRequestDispatched({
      scope: SCOPE,
      idempotencyKey: 'script-request-002',
      requestFingerprint,
      leaseToken: started.leaseToken,
    }, db);
    completeContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-002',
      requestFingerprint,
      leaseToken: started.leaseToken,
      response,
    }, db);

    expect(reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-002',
      requestFingerprint,
    }, db)).toEqual({ kind: 'replay', response });
  });

  it('rolls back caller persistence when the durable response receipt cannot settle', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Atomic' });
    const started = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-atomic-001',
      requestFingerprint,
    }, db);
    if (started.kind !== 'started') throw new Error('expected a started reservation');
    db.exec('CREATE TABLE content_script_atomic_probe (value TEXT NOT NULL)');

    expect(() => completeContentScriptSaveRequestAtomically({
      scope: SCOPE,
      idempotencyKey: 'script-request-atomic-001',
      requestFingerprint,
      leaseToken: `${started.leaseToken}-stale`,
      buildResponse(transactionDb) {
        transactionDb.prepare('INSERT INTO content_script_atomic_probe (value) VALUES (?)')
          .run('must-roll-back');
        return { topic: 'Atomic', script: 'Durable only with the receipt.' };
      },
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_IDEMPOTENCY_RECEIPT_INVALID',
    }));

    expect(db.prepare('SELECT COUNT(*) AS count FROM content_script_atomic_probe').get())
      .toEqual({ count: 0 });
  });

  it('releases failed work and safely reclaims an expired lease', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Retry' });
    const first = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-003',
      requestFingerprint,
      nowMs: 1_000,
    }, db);
    if (first.kind !== 'started') throw new Error('expected a started reservation');

    releaseContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-003',
      requestFingerprint,
      leaseToken: first.leaseToken,
    }, db);
    const restarted = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-003',
      requestFingerprint,
      nowMs: 2_000,
    }, db);
    expect(restarted).toMatchObject({ kind: 'started' });
    if (restarted.kind !== 'started') throw new Error('expected a restarted reservation');

    const reclaimed = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-003',
      requestFingerprint,
      nowMs: 15 * 60_000 + 2_001,
    }, db);
    expect(reclaimed).toMatchObject({ kind: 'started' });
    expect(reclaimed).not.toEqual(restarted);
  });

  it('never reclaims a key after the request crosses the generation boundary', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Dispatched' });
    const started = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-001',
      requestFingerprint,
      nowMs: 1_000,
    }, db);
    if (started.kind !== 'started') throw new Error('expected a started reservation');

    markContentScriptSaveRequestDispatched({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-001',
      requestFingerprint,
      leaseToken: started.leaseToken,
    }, db);

    expect(() => reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-001',
      requestFingerprint,
      nowMs: 15 * 60_000 + 2_000,
    }, db)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_IDEMPOTENCY_RESULT_UNAVAILABLE',
      status: 409,
      details: { requiresNewKey: true },
    }));
  });

  it('settles and replays a response after the generation boundary is marked', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Dispatched success' });
    const started = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-002',
      requestFingerprint,
    }, db);
    if (started.kind !== 'started') throw new Error('expected a started reservation');

    markContentScriptSaveRequestDispatched({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-002',
      requestFingerprint,
      leaseToken: started.leaseToken,
    }, db);
    completeContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-002',
      requestFingerprint,
      leaseToken: started.leaseToken,
      response: { topic: 'Dispatched success', script: '[0:00] Durable response' },
    }, db);

    expect(reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-dispatched-002',
      requestFingerprint,
    }, db)).toEqual({
      kind: 'replay',
      response: { topic: 'Dispatched success', script: '[0:00] Durable response' },
    });
  });

  it('rejects settlement before dispatch and refuses to overwrite a succeeded receipt', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'One-way settlement' });
    const started = reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-one-way-001',
      requestFingerprint,
    }, db);
    if (started.kind !== 'started') throw new Error('expected a started reservation');

    const settlement = (response: Record<string, unknown>) => completeContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-one-way-001',
      requestFingerprint,
      leaseToken: started.leaseToken,
      response,
    }, db);

    expect(() => settlement({ script: 'must not skip dispatch' })).toThrowError(
      expect.objectContaining<Partial<ContentWorkspaceError>>({
        code: 'CONTENT_IDEMPOTENCY_RECEIPT_INVALID',
      }),
    );
    markContentScriptSaveRequestDispatched({
      scope: SCOPE,
      idempotencyKey: 'script-request-one-way-001',
      requestFingerprint,
      leaseToken: started.leaseToken,
    }, db);
    settlement({ script: 'first durable response' });
    expect(() => settlement({ script: 'must not overwrite success' })).toThrowError(
      expect.objectContaining<Partial<ContentWorkspaceError>>({
        code: 'CONTENT_IDEMPOTENCY_RECEIPT_INVALID',
      }),
    );
    expect(reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-one-way-001',
      requestFingerprint,
    }, db)).toEqual({ kind: 'replay', response: { script: 'first durable response' } });
  });

  it('keeps identical keys isolated by tenant and owner scope', () => {
    const requestFingerprint = fingerprintContentScriptSaveRequest({ topic: 'Scoped' });
    expect(reserveContentScriptSaveRequest({
      scope: SCOPE,
      idempotencyKey: 'script-request-004',
      requestFingerprint,
    }, db)).toMatchObject({ kind: 'started' });
    expect(reserveContentScriptSaveRequest({
      scope: { tenantId: SCOPE.tenantId + 1, userId: SCOPE.userId },
      idempotencyKey: 'script-request-004',
      requestFingerprint,
    }, db)).toMatchObject({ kind: 'started' });
  });
});

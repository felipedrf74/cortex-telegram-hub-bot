import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import Database from 'better-sqlite3';

const servers: Server[] = [];
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../..');

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('chatv2-observe-legacy-parity CLI', () => {
  it('keeps committed observations HMAC-only while writing local raw review rows when explicitly requested', async () => {
    const tempDir = makeRepoLocalTempDir();
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2');
    const outPath = path.join(tempDir, 'observations.ndjson');
    const fixtureHash = `sha256:${'e'.repeat(64)}`;

    try {
      await execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${path.join(tempDir, 'legacy-token.json')}`,
        `--chatv2-token-file=${path.join(tempDir, 'chatv2-token.json')}`,
        '--evidence-source=runtime_route',
        '--samples-per-route=1',
        '--sample-delay-ms=7',
        '--routes=chat_message_shortcut_after_route',
        `--fixture-hash=${fixtureHash}`,
        '--allow-raw-review-artifact',
        `--out=${outPath}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      });

      const observations = readFileSync(outPath, 'utf8');
      expect(observations).toContain('hmac:legacy-parity:');
      expect(observations).not.toContain('legacy raw answer');
      expect(observations).not.toContain('chatv2 raw answer');
      expect(observations).not.toContain('what content is already ready on my desk');

      const manifest = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.manifest.json'), 'utf8')) as {
        rawPromptOrResponseStored: boolean;
        committedObservationRawPromptOrResponseStored: boolean;
        rawReviewArtifactLocalOnly: boolean;
        rawReviewArtifactContainsRawPromptOrResponse: boolean;
        rawReviewArtifactSchemaVersion: string;
        stateFixtureHash: string;
        sampleDelayMs: number;
      };
      expect(manifest).toMatchObject({
        rawPromptOrResponseStored: false,
        committedObservationRawPromptOrResponseStored: false,
        rawReviewArtifactLocalOnly: true,
        rawReviewArtifactContainsRawPromptOrResponse: true,
        rawReviewArtifactSchemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
        stateFixtureHash: fixtureHash,
        sampleDelayMs: 7,
      });

      const reviewRows = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.review.json'), 'utf8')) as Array<{
        schemaVersion: string;
        sampleHmac: string;
        promptText: string;
        legacyRawResponse: { body: { text: string } };
        chatV2RawResponse: { body: { text: string } };
      }>;
      expect(reviewRows).toHaveLength(1);
      expect(reviewRows[0]).toMatchObject({
        schemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
        promptText: 'what content is already ready on my desk',
      });
      expect(reviewRows[0]?.sampleHmac).toMatch(/^hmac:legacy-parity:[a-f0-9]{64}$/);
      expect(reviewRows[0]?.legacyRawResponse.body.text).toContain('legacy raw answer');
      expect(reviewRows[0]?.chatV2RawResponse.body.text).toContain('chatv2 raw answer');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('replaces stale cached auth tokens before collecting observations', async () => {
    const tempDir = makeRepoLocalTempDir();
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2');
    const outPath = path.join(tempDir, 'observations.ndjson');
    const legacyTokenPath = path.join(tempDir, 'legacy-token.json');
    const chatV2TokenPath = path.join(tempDir, 'chatv2-token.json');
    writeFileSync(legacyTokenPath, JSON.stringify({
      accessToken: 'stale-token',
      user: { id: 999, tenantId: 999 },
    }));
    writeFileSync(chatV2TokenPath, JSON.stringify({
      accessToken: 'stale-token',
      user: { id: 999, tenantId: 999 },
    }));

    try {
      await execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${legacyTokenPath}`,
        `--chatv2-token-file=${chatV2TokenPath}`,
        '--samples-per-route=1',
        '--routes=chat_message_shortcut_after_route',
        '--allow-raw-review-artifact',
        `--out=${outPath}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      });

      const legacyToken = JSON.parse(readFileSync(legacyTokenPath, 'utf8')) as { accessToken: string };
      const chatV2Token = JSON.parse(readFileSync(chatV2TokenPath, 'utf8')) as { accessToken: string };
      expect(legacyToken.accessToken).toBe('legacy-token');
      expect(chatV2Token.accessToken).toBe('chatv2-token');
      const reviewRows = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.review.json'), 'utf8')) as Array<{
        legacyRawResponse: { status: number };
        chatV2RawResponse: { status: number };
      }>;
      expect(reviewRows[0]?.legacyRawResponse.status).toBe(200);
      expect(reviewRows[0]?.chatV2RawResponse.status).toBe(200);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits non-comparable timeout evidence instead of hanging on a stalled endpoint turn', async () => {
    const tempDir = makeRepoLocalTempDir();
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2', { chatDelayMs: 250 });
    const outPath = path.join(tempDir, 'observations.ndjson');
    const fixtureHash = `sha256:${'b'.repeat(64)}`;

    try {
      await execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${path.join(tempDir, 'legacy-token.json')}`,
        `--chatv2-token-file=${path.join(tempDir, 'chatv2-token.json')}`,
        '--evidence-source=runtime_route',
        '--samples-per-route=1',
        '--routes=classifier_route_skill_orchestration',
        '--turn-timeout-ms=50',
        `--fixture-hash=${fixtureHash}`,
        '--allow-raw-review-artifact',
        `--out=${outPath}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      });

      const observations = readFileSync(outPath, 'utf8');
      expect(observations).toContain('degraded_not_comparable');
      expect(observations).not.toContain('observer_timeout');
      expect(observations).not.toContain('http_status_599');
      const reviewRows = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.review.json'), 'utf8')) as Array<{
        chatV2RawResponse: { status: number; body: { error?: { code?: string } } };
        chatV2Projection: { routeMethod?: string; verificationStatus?: string } | null;
        comparison: { matched: boolean; reasonCodes: string[] };
      }>;
      expect(reviewRows[0]?.chatV2RawResponse.status).toBe(599);
      expect(reviewRows[0]?.chatV2RawResponse.body.error?.code).toBe('observer_timeout');
      expect(reviewRows[0]?.chatV2Projection?.routeMethod).toBe('http_status_599');
      expect(reviewRows[0]?.chatV2Projection?.verificationStatus).toBe('http_status_599');
      expect(reviewRows[0]?.comparison.matched).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('requires DB fixture paths for runtime write-route observations', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-observe-parity-'));
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2');
    const fixtureHash = `sha256:${'d'.repeat(64)}`;

    try {
      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${path.join(tempDir, 'legacy-token.json')}`,
        `--chatv2-token-file=${path.join(tempDir, 'chatv2-token.json')}`,
        '--evidence-source=runtime_route',
        '--samples-per-route=1',
        '--routes=decision_confirmation_shortcut',
        `--fixture-hash=${fixtureHash}`,
        '--allow-write-prompts',
        '--isolate-prompts',
        `--out=${path.join(tempDir, 'observations.ndjson')}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      })).rejects.toThrow(/--legacy-db and --chatv2-db/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects runtime write-route evidence when the held-out corpus cannot supply distinct samples', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-observe-parity-'));
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2');
    const fixtureHash = `sha256:${'a'.repeat(64)}`;

    try {
      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${path.join(tempDir, 'legacy-token.json')}`,
        `--chatv2-token-file=${path.join(tempDir, 'chatv2-token.json')}`,
        '--evidence-source=runtime_route',
        '--samples-per-route=51',
        '--routes=decision_confirmation_shortcut',
        `--fixture-hash=${fixtureHash}`,
        '--allow-write-prompts',
        '--isolate-prompts',
        `--out=${path.join(tempDir, 'observations.ndjson')}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      })).rejects.toThrow(/requires 51 distinct held-out prompts; found 50/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('seeds referenced write entities for isolated runtime observations', async () => {
    const tempDir = makeRepoLocalTempDir();
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2');
    const outPath = path.join(tempDir, 'observations.ndjson');
    const legacyDbPath = path.join(tempDir, 'legacy.db');
    const chatV2DbPath = path.join(tempDir, 'chatv2.db');
    const fixtureHash = `sha256:${'c'.repeat(64)}`;
    createFixtureDb(legacyDbPath);
    createFixtureDb(chatV2DbPath);

    try {
      await execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${path.join(tempDir, 'legacy-token.json')}`,
        `--chatv2-token-file=${path.join(tempDir, 'chatv2-token.json')}`,
        `--legacy-db=${legacyDbPath}`,
        `--chatv2-db=${chatV2DbPath}`,
        '--evidence-source=runtime_route',
        '--samples-per-route=1',
        '--routes=decision_confirmation_shortcut',
        `--fixture-hash=${fixtureHash}`,
        '--allow-write-prompts',
        '--isolate-prompts',
        '--allow-raw-review-artifact',
        `--out=${outPath}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      });

      for (const dbPath of [legacyDbPath, chatV2DbPath]) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const decision = db.prepare(`
            SELECT item_id, intent_id, user_id, tenant_id, title, source_skill, status
              FROM notification_center_items
             WHERE item_id = 'dec_123'
          `).get() as {
            item_id: string;
            intent_id: string;
            user_id: number;
            tenant_id: number;
            title: string;
            source_skill: string;
            status: string;
          } | undefined;
          expect(decision).toMatchObject({
            item_id: 'dec_123',
            intent_id: 'intent_dec_123',
            title: 'Nexus needs your choice',
            source_skill: 'chat',
            status: 'unread',
          });
          expect(decision?.user_id).toBeGreaterThan(0);
          expect(decision?.tenant_id).toBeGreaterThan(0);
        } finally {
          db.close();
        }
      }

      const observations = readFileSync(outPath, 'utf8');
      expect(observations).toContain('hmac:legacy-parity:');
      expect(observations).not.toContain('Nexus needs your choice');

      const manifest = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.manifest.json'), 'utf8')) as {
        stateFixtureContract: string;
        writeFixtureSeeding: {
          schemaVersion: string;
          legacyDbSupplied: boolean;
          chatV2DbSupplied: boolean;
          fixtureSeedHash: string;
        };
      };
      expect(manifest.stateFixtureContract).toBe('fresh_isolated_user_per_prompt_with_seeded_entities');
      expect(manifest.writeFixtureSeeding).toMatchObject({
        schemaVersion: 'chat_v2_parity_write_fixture_seeding.v1',
        legacyDbSupplied: true,
        chatV2DbSupplied: true,
      });
      expect(manifest.writeFixtureSeeding.fixtureSeedHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const reviewRows = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.review.json'), 'utf8')) as Array<{
        fixture: {
          legacy: { seeded: boolean; fixtureHash: string };
          chatV2: { seeded: boolean; fixtureHash: string };
        };
      }>;
      expect(reviewRows[0]?.fixture.legacy.seeded).toBe(true);
      expect(reviewRows[0]?.fixture.chatV2.seeded).toBe(true);
      expect(reviewRows[0]?.fixture.legacy.fixtureHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(reviewRows[0]?.fixture.chatV2.fixtureHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses raw review artifacts outside the repo .local directory', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-observe-parity-'));
    const legacy = await startParityServer('legacy');
    const chatV2 = await startParityServer('chatv2');
    const fixtureHash = `sha256:${'f'.repeat(64)}`;

    try {
      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-observe-legacy-parity.ts',
        `--legacy-base-url=${legacy.baseUrl}`,
        `--chatv2-base-url=${chatV2.baseUrl}`,
        `--legacy-token-file=${path.join(tempDir, 'legacy-token.json')}`,
        `--chatv2-token-file=${path.join(tempDir, 'chatv2-token.json')}`,
        '--evidence-source=runtime_route',
        '--samples-per-route=1',
        '--routes=chat_message_shortcut_after_route',
        `--fixture-hash=${fixtureHash}`,
        '--allow-raw-review-artifact',
        `--out=${path.join(tempDir, 'observations.ndjson')}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        timeout: 30000,
      })).rejects.toThrow(/must be written under this repository \.local/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function makeRepoLocalTempDir(): string {
  const localRoot = path.join(repoRoot, '.local', 'test-chatv2-observe-parity');
  mkdirSync(localRoot, { recursive: true });
  return mkdtempSync(path.join(localRoot, 'run-'));
}

async function startParityServer(
  kind: 'legacy' | 'chatv2',
  opts: { chatDelayMs?: number } = {},
): Promise<{ baseUrl: string }> {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/auth/register') {
      writeJson(res, {
        data: {
          accessToken: `${kind}-token`,
          refreshToken: `${kind}-refresh`,
          expiresIn: 3600,
          user: { id: kind === 'legacy' ? 101 : 202, tenantId: kind === 'legacy' ? 101 : 202 },
        },
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/v1/auth/me') {
      const expected = `Bearer ${kind}-token`;
      if (req.headers.authorization === expected) {
        writeJson(res, {
          data: {
            user: { id: kind === 'legacy' ? 101 : 202, tenantId: kind === 'legacy' ? 101 : 202 },
          },
        });
        return;
      }
      writeJson(res, { ok: false, error: { code: 'UNAUTHORIZED' } }, 401);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/v1/chat/message') {
      const payload = await readJsonBody(req);
      if (opts.chatDelayMs && opts.chatDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.chatDelayMs));
      }
      const text = typeof payload.text === 'string' ? payload.text : '';
      writeJson(res, {
        kind: 'read_result',
        routeMethod: kind === 'legacy' ? 'fast-path-deterministic-read' : 'chat-core-v2-deterministic-read',
        text: `${kind} raw answer for ${text}`,
        metadata: {
          type: kind === 'chatv2' ? 'chat_core_v2_deterministic_read' : 'legacy_fast_path',
          domain: 'content',
          responseKind: 'read_result',
        },
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind test server');
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function writeJson(res: ServerResponse, value: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

function createFixtureDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE native_task_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, name)
      );
      CREATE TABLE native_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        list_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        importance TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'notStarted',
        due_date_time TEXT,
        reminder_date TEXT,
        recurrence TEXT,
        tags TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE notification_intents (
        intent_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        source_skill TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        related_entity_id TEXT,
        related_entity_type TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        sensitive_body TEXT,
        action_buttons_json TEXT NOT NULL DEFAULT '[]',
        deeplink TEXT,
        expires_at TEXT,
        quiet_hours_policy TEXT NOT NULL DEFAULT 'respect',
        dedupe_key TEXT,
        requires_user_action INTEGER NOT NULL DEFAULT 0,
        decision_deadline TEXT,
        delivery_policy TEXT NOT NULL DEFAULT 'auto',
        privacy_policy TEXT NOT NULL DEFAULT 'standard',
        decision_context_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE notification_center_items (
        item_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        decision_log_id TEXT,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        safe_body TEXT NOT NULL,
        sensitive_body TEXT,
        source_skill TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        deeplink TEXT,
        actions_json TEXT NOT NULL DEFAULT '[]',
        dedupe_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        read_at TEXT,
        dismissed_at TEXT,
        actioned_at TEXT,
        superseded_by_item_id TEXT
      );
    `);
  } finally {
    db.close();
  }
}

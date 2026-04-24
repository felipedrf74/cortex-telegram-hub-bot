// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for POST /invite/request-signup-link
 * (OI-NAV-203b, 2026-04-24).
 *
 * The handler in server.ts wires together three services (invite +
 * magic-link + mailer), so a full behavior test would require
 * standing up the bot + full portal server. These structural pins
 * verify the handler CALLS each piece correctly + handles the
 * documented error shapes; behavior of each piece is covered by
 * its own unit tests.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_TS = path.resolve(__dirname, '../../src/portal/server.ts');
const loadServer = (): string => fs.readFileSync(SERVER_TS, 'utf-8');

describe('server.ts — /invite/request-signup-link route structure', () => {
  const src = loadServer();

  it('registered as app.post with express.json body parser', () => {
    expect(src).toMatch(
      /app\.post\(['"]\/invite\/request-signup-link['"],\s*express\.json\(\{\s*limit:\s*['"]16kb['"]\s*\}\),/,
    );
  });

  it('lazy-requires invite + magic-link + mailer services', () => {
    expect(src).toMatch(/getPublicInviteInfo.*require\(['"]\.\.\/services\/tenant-invite-service['"]\)/);
    expect(src).toMatch(/issueMagicLinkToken.*require\(['"]\.\.\/services\/magic-link-service['"]\)/);
    expect(src).toMatch(/sendMagicLink.*require\(['"]\.\.\/services\/mailer['"]\)/);
  });

  it('400 when code is missing or non-string', () => {
    expect(src).toMatch(/request-signup-link[\s\S]*?if \(!code\)[\s\S]*?BAD_REQUEST/);
  });

  it('returns uniform 200 envelope for invalid codes (oracle resistance)', () => {
    // Same pattern as /invite/inspect — don't leak "is this code valid?"
    // through HTTP status.
    expect(src).toMatch(/request-signup-link[\s\S]*?info\.valid[\s\S]*?sent:\s*true,\s*debugReason:\s*['"]invalid_code['"]/);
  });

  it('returns uniform 200 for already-accepted / revoked / expired invites', () => {
    expect(src).toMatch(/request-signup-link[\s\S]*?info\.status !== ['"]pending['"][\s\S]*?debugReason:\s*['"]invite_not_accepting['"]/);
  });

  it('issueMagicLinkToken called with intent=invite_signup + 1h TTL + invite metadata', () => {
    expect(src).toMatch(/issueMagicLinkToken\(\{\s*[\s\S]*?intent:\s*['"]invite_signup['"]/);
    expect(src).toMatch(/request-signup-link[\s\S]*?ttlSeconds:\s*60\s*\*\s*60/);
    expect(src).toMatch(/request-signup-link[\s\S]*?inviteCode:\s*code,\s*tenantSlug:\s*info\.tenantSlug/);
  });

  it('builds the magic URL against the origin header OR falls back to req.protocol/host', () => {
    // origin header respected so reverse proxies work; fallback for
    // direct hits without an Origin.
    expect(src).toMatch(/\(req\.headers\.origin as string\)\s*\|\|\s*`\$\{req\.protocol\}:\/\/\$\{req\.get\(['"]host['"]\)\}`/);
  });

  it('magic URL format is /invite/accept?code=<code>&magic=<token>', () => {
    expect(src).toMatch(
      /\/invite\/accept\?code=\$\{encodeURIComponent\(code\)\}&magic=\$\{encodeURIComponent\(rawToken\)\}/,
    );
  });

  it('503 MAILER_UNCONFIGURED when mailer throws BACKEND_UNIMPLEMENTED', () => {
    expect(src).toMatch(
      /request-signup-link[\s\S]*?code\?:\s*string\s*\}\)\.code === ['"]BACKEND_UNIMPLEMENTED['"]/,
    );
    expect(src).toMatch(/MAILER_UNCONFIGURED/);
  });

  it('debugUrl is echoed in the response only when mailer returns one (console backend)', () => {
    // Mailer returns debugUrl only for backend='console'; prod backends
    // return undefined, so the URL stays off the wire. Captured into a
    // local `debugUrl` variable on successful send, then echoed in the
    // response data.
    expect(src).toMatch(/request-signup-link[\s\S]*?debugUrl = result\.debugUrl/);
    expect(src).toMatch(/request-signup-link[\s\S]*?data:\s*\{\s*sent:\s*true,\s*debugUrl\s*\}/);
  });

  it('500 INTERNAL on any other mailer error', () => {
    expect(src).toMatch(/request-signup-link[\s\S]*?res\.status\(isUnimpl\s*\?\s*503\s*:\s*500\)/);
  });
});

describe('migrations/081_magic_link_tokens.sql', () => {
  const MIG_PATH = path.resolve(__dirname, '../../migrations/081_magic_link_tokens.sql');
  const sql = fs.readFileSync(MIG_PATH, 'utf-8');

  it('table has token_hash UNIQUE (prevents future deterministic seed bugs)', () => {
    expect(sql).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/);
  });

  it('intent is CHECK-constrained to the known-safe enum', () => {
    expect(sql).toMatch(/CHECK\(intent IN \('invite_signup',\s*'passwordless_login',\s*'email_verify'\)\)/);
  });

  it('tenant_id + invite_id FKs use ON DELETE SET NULL (tokens outlive their parents)', () => {
    expect(sql).toMatch(/tenant_id\s+INTEGER REFERENCES tenants\(id\) ON DELETE SET NULL/);
    expect(sql).toMatch(/invite_id\s+INTEGER REFERENCES tenant_invites\(id\) ON DELETE SET NULL/);
  });

  it('creates 3 indexes: hash (hot path), email+intent (admin), expires_at (GC)', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_hash/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires/);
  });
});

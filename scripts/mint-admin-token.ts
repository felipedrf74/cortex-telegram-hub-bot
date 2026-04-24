// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-SEC-001 (2026-04-24) — mint an admin session token for a
 * platform admin.
 *
 * Usage (from the repo root):
 *   npx ts-node scripts/mint-admin-token.ts <userId> [--ttl 24h]
 *
 * Examples:
 *   npx ts-node scripts/mint-admin-token.ts 1
 *   npx ts-node scripts/mint-admin-token.ts 3 --ttl 8h
 *   npx ts-node scripts/mint-admin-token.ts 1 --ttl 30d
 *
 * Prerequisites:
 *   - PORTAL_ADMIN_JWT_SECRET must be set in .env (32+ bytes of
 *     random data; `openssl rand -hex 32` or similar).
 *   - The target userId must exist in `platform_admins`.
 *
 * The script prints the token on stdout and a reminder on stderr.
 * Paste the token into the Admin Console sign-in screen; it's
 * stored in sessionStorage and cleared on sign-out.
 *
 * Security notes:
 *   - The token is self-contained (HMAC-signed JWT). Revocation
 *     requires rotating PORTAL_ADMIN_JWT_SECRET (which invalidates
 *     every minted token at once) OR removing the user from
 *     platform_admins (which the guard re-checks on every request).
 *   - TTL defaults to 24h. Prefer shorter TTLs for ops work; longer
 *     TTLs (up to 30d) for your own day-to-day use.
 */

import 'dotenv/config';
import { mintAdminSession, getAdminSessionSecret } from '../src/services/admin-session-service';
import { getPlatformRole } from '../src/services/tenant-service';

function parseArgs(argv: string[]): { userId: number; ttl: string } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stderr.write(
      'Usage: npx ts-node scripts/mint-admin-token.ts <userId> [--ttl 24h|30d|...]\n',
    );
    process.exit(1);
  }
  const userId = Number.parseInt(args[0], 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    process.stderr.write(`[mint-admin-token] invalid userId: ${args[0]}\n`);
    process.exit(2);
  }
  let ttl = '24h';
  const ttlIdx = args.indexOf('--ttl');
  if (ttlIdx !== -1 && args[ttlIdx + 1]) {
    ttl = args[ttlIdx + 1];
  }
  return { userId, ttl };
}

function main(): void {
  const { userId, ttl } = parseArgs(process.argv);

  if (!getAdminSessionSecret()) {
    process.stderr.write(
      '[mint-admin-token] PORTAL_ADMIN_JWT_SECRET is not set in .env.\n'
      + '                   Generate one with: openssl rand -hex 32\n'
      + '                   Add it to .env, then retry.\n',
    );
    process.exit(3);
  }

  // Verify the target is actually a platform admin — issuing a
  // token for a non-admin userId is a footgun (the guard will
  // reject every request from it with 403).
  let role: ReturnType<typeof getPlatformRole>;
  try {
    role = getPlatformRole(userId);
  } catch (err) {
    process.stderr.write(
      `[mint-admin-token] DB lookup failed for userId ${userId}: ${(err as Error).message}\n`,
    );
    process.exit(4);
  }
  if (!role) {
    process.stderr.write(
      `[mint-admin-token] userId ${userId} is NOT in platform_admins. Refusing to mint.\n`
      + `                   Grant via POST /owner/platform-admins (as platform_owner) first.\n`,
    );
    process.exit(5);
  }

  const token = mintAdminSession(userId, role, { expiresIn: ttl });

  // Token on stdout so it can be piped (e.g. into pbcopy).
  process.stdout.write(token + '\n');

  // Advisory on stderr so piping doesn't swallow it.
  process.stderr.write(
    `[mint-admin-token] Minted a ${ttl} admin session token for userId=${userId} role=${role}.\n`
    + `                   Paste into the Admin Console sign-in screen.\n`,
  );
}

main();

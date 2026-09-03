// Manual scoped probe for content discovery.
// Run only with explicit authority:
// CONTENT_DISCOVERY_USER_ID=... CONTENT_DISCOVERY_TENANT_ID=... npx ts-node scripts/test-discovery.ts

import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

import { runContentDiscovery } from '../src/services/content-discovery';
import { initDatabase } from '../src/services/database-bootstrap';

async function main() {
  const userId = requirePositiveSafeInteger(process.env.CONTENT_DISCOVERY_USER_ID, 'CONTENT_DISCOVERY_USER_ID');
  const tenantId = requirePositiveSafeInteger(process.env.CONTENT_DISCOVERY_TENANT_ID, 'CONTENT_DISCOVERY_TENANT_ID');

  // Init DB (needed for config/logger)
  initDatabase();

  console.log('🔍 Running content discovery test...\n');
  const start = Date.now();

  try {
    const result = await runContentDiscovery({ userId, tenantId });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n✅ Done in ${elapsed}s | ${result.searchCount} web searches used\n`);
    console.log('📋 Idea diagnostics (private text withheld):');
    result.ideas.forEach((idea, i) => {
      const fingerprint = createHash('sha256').update(idea).digest('hex').slice(0, 12);
      console.log(`  ${i + 1}. length=${idea.length} sha256=${fingerprint}`);
    });
    console.log(`\n💾 Storage: ${result.storage}`);
  } catch (err) {
    console.error('❌ Failed:', err instanceof Error ? err.name : typeof err);
    process.exitCode = 1;
  }
}

function requirePositiveSafeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be an explicit positive safe integer.`);
  }
  return parsed;
}

main();

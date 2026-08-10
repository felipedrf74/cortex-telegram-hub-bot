// Quick test script for content discovery
// Run: npx ts-node scripts/test-discovery.ts

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { runContentDiscovery } from '../src/services/content-discovery';
import { initDatabase } from '../src/services/database-bootstrap';

async function main() {
  // Init DB (needed for config/logger)
  initDatabase();

  console.log('🔍 Running content discovery test...\n');
  const start = Date.now();

  try {
    const result = await runContentDiscovery();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n✅ Done in ${elapsed}s | ${result.searchCount} web searches used\n`);
    console.log('📋 Ideas found:');
    result.ideas.forEach((idea, i) => {
      console.log(`  ${i + 1}. ${idea}`);
    });
    console.log(`\n📁 Saved to: ${result.filePath}`);
  } catch (err) {
    console.error('❌ Failed:', err);
  }

  process.exit(0);
}

main();

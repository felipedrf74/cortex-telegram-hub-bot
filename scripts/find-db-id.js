#!/usr/bin/env node
/**
 * Find the correct Notion database ID for the Development Board
 */
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('NOTION_TOKEN=ntn_xxx node scripts/find-db-id.js'); process.exit(1); }

(async () => {
  const resp = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      query: 'Nexus Hub',
      filter: { property: 'object', value: 'database' }
    })
  });
  const data = await resp.json();
  console.log('\n📋 Databases shared with your integration:\n');
  for (const db of (data.results || [])) {
    const title = db.title?.[0]?.plain_text || 'untitled';
    console.log(`  📌 ${title}`);
    console.log(`     ID: ${db.id}`);
    console.log('');
  }
  if (!data.results?.length) {
    console.log('  ❌ No databases found. Make sure you shared the Nexus Hub page with your integration.');
  }
})();

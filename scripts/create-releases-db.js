#!/usr/bin/env node
/**
 * Nexus Hub — Create Notion Releases Database
 * 
 * Creates a "Releases" database linked to the Nexus Hub page
 * that GitHub Actions will populate on every deploy/release.
 * 
 * Usage:
 *   NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=332ad49d23e78075a924ef844eac8f47 node scripts/create-releases-db.js
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
let NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;

if (!NOTION_TOKEN || !NOTION_PAGE_ID) {
  console.error('Usage: NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=xxx node scripts/create-releases-db.js');
  process.exit(1);
}

NOTION_PAGE_ID = NOTION_PAGE_ID.replace(/^.*-([a-f0-9]{32})$/i, '$1');
if (NOTION_PAGE_ID.length === 32 && !NOTION_PAGE_ID.includes('-')) {
  NOTION_PAGE_ID = `${NOTION_PAGE_ID.slice(0,8)}-${NOTION_PAGE_ID.slice(8,12)}-${NOTION_PAGE_ID.slice(12,16)}-${NOTION_PAGE_ID.slice(16,20)}-${NOTION_PAGE_ID.slice(20)}`;
}

async function main() {
  console.log('\n📋 Creating Nexus Hub Releases database...\n');

  const resp = await fetch('https://api.notion.com/v1/databases', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { page_id: NOTION_PAGE_ID },
      icon: { emoji: '🚀' },
      title: [{ text: { content: 'Nexus Hub — Releases' } }],
      properties: {
        'Release': { title: {} },
        'Status': {
          select: {
            options: [
              { name: '✅ Success', color: 'green' },
              { name: '❌ Failed', color: 'red' },
              { name: '✅ Released', color: 'green' },
              { name: '🔄 Rollback', color: 'orange' },
              { name: '🚧 In Progress', color: 'yellow' },
            ]
          }
        },
        'Type': {
          select: {
            options: [
              { name: 'Release', color: 'blue' },
              { name: 'Deploy', color: 'green' },
              { name: 'Rollback', color: 'orange' },
              { name: 'Hotfix', color: 'red' },
            ]
          }
        },
        'Date': { date: {} },
        'Commit': { rich_text: {} },
        'Author': { rich_text: {} },
        'Notes': { rich_text: {} },
        'Environment': {
          select: {
            options: [
              { name: 'Production', color: 'red' },
              { name: 'Staging', color: 'yellow' },
            ]
          }
        },
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`❌ Failed: ${err}`);
    process.exit(1);
  }

  const db = await resp.json();
  console.log(`✅ Database created!`);
  console.log(`\n🔑 Database ID: ${db.id}`);
  console.log(`\n📌 Add this to your GitHub repo secrets as NOTION_RELEASES_DB:`);
  console.log(`   ${db.id}\n`);
  console.log(`🔗 https://www.notion.so/${db.id.replace(/-/g, '')}`);
}

main().catch(e => { console.error(e); process.exit(1); });

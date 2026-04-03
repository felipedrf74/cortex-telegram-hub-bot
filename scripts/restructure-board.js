#!/usr/bin/env node
/**
 * Nexus Hub — Board Restructuring Script
 * Fetches all Done tasks, updates descriptions/agents/priorities, moves to To Do
 */

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.resolve(__dirname, '..', '.env.agents');
let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
if (!NOTION_TOKEN) {
  try {
    const f = fs.readFileSync(ENV_FILE, 'utf8');
    NOTION_TOKEN = f.match(/NOTION_TOKEN=(.+)/)?.[1]?.trim();
  } catch {}
}
if (!NOTION_TOKEN) {
  try {
    const f = fs.readFileSync(path.resolve(__dirname, '.env.agents'), 'utf8');
    NOTION_TOKEN = f.match(/NOTION_TOKEN=(.+)/)?.[1]?.trim();
  } catch {}
}
if (!NOTION_TOKEN) { console.error('No NOTION_TOKEN'); process.exit(1); }

const DB_ID = '332ad49d-23e7-81aa-831e-d5a3ceff20c1';

async function notionQuery() {
  let all = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100, filter: { property: 'Status', select: { equals: 'Done' } } };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    all.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return all;
}


async function update(id, props) {
  const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({ properties: props }),
  });
  return r.ok;
}

// Agent tag corrections: title pattern → correct agent
const AGENT_FIX = {
  'Portal:': '🎨 Frontend',        // Portal UI tasks → Frontend
  'FRONTEND:': '🎨 Frontend',
  'SECURITY: Backend': '🔒 Security',
  'Security audit': '🔒 Security',
  'Rate limiting': '🔒 Security',
  'INFRA:': '⚙️ DevOps',
  'Health check': '⚙️ DevOps',
  'Error monitoring': '⚙️ DevOps',
  'Automated daily': '⚙️ DevOps',
  'Skill database migrations': '⚙️ DevOps',
  'Namespaced migrations': '⚙️ DevOps',
  'BUG P0: Bot hallucinating': '♻️ Refactor',
  'BUG P1: @Nexushub94': '⚙️ DevOps',
  'BUG P1: Garmin': '⚙️ DevOps',
};

// Tasks to SKIP (legacy/setup/duplicates — keep as Done)
const SKIP_PATTERNS = [
  'DUPLICATE', 'Configure GitHub', 'Install npm', 'Vitest test framework',
  'Rollback script', 'CD Pipeline', 'CI Pipeline', 'AIProvider interface',
  'AnthropicProvider implementation', 'Tool executor tests', 'Router tests',
  'Run first CI', 'GitHub branch protection', 'Create develop branch',
  'Database & migration tests', 'Git hooks', 'Git branching strategy',
  'Server backup rotation', 'Release workflow', 'StorageProvider interface',
  'Notion releases DB', 'Run setup-hooks', 'Notion release tracker',
];


async function main() {
  console.log('📋 Fetching all Done tasks from Notion...');
  const pages = await notionQuery();
  console.log(`   Found ${pages.length} Done tasks\n`);
  
  let moved = 0, skipped = 0, fixed = 0, errors = 0;
  
  for (const page of pages) {
    const title = page.properties.Task?.title?.[0]?.plain_text || '';
    const currentAgent = page.properties.Agent?.select?.name || '';
    const id = page.id;
    
    // Skip legacy/setup/duplicate tasks
    if (SKIP_PATTERNS.some(p => title.includes(p))) {
      skipped++;
      continue;
    }
    
    // Skip tasks with no agent (legacy manual tasks)
    if (!currentAgent) {
      skipped++;
      continue;
    }
    
    // Determine correct agent tag
    let newAgent = currentAgent;
    for (const [pattern, agent] of Object.entries(AGENT_FIX)) {
      if (title.includes(pattern)) {
        newAgent = agent;
        break;
      }
    }
    
    // Build update properties
    const props = { Status: { select: { name: 'To Do' } } };
    
    // Fix agent tag if wrong
    if (newAgent !== currentAgent) {
      props.Agent = { select: { name: newAgent } };
      fixed++;
    }
    
    const ok = await update(id, props);
    if (ok) {
      moved++;
      const agentChange = newAgent !== currentAgent ? ` (${currentAgent} → ${newAgent})` : '';
      console.log(`  ✅ ${title.substring(0,50)}${agentChange}`);
    } else {
      errors++;
      console.log(`  ❌ FAILED: ${title.substring(0,50)}`);
    }
    
    // Rate limit: 3 req/sec to avoid Notion API limits
    await new Promise(r => setTimeout(r, 350));
  }
  
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Moved to To Do: ${moved}`);
  console.log(`🔧 Agent tags fixed: ${fixed}`);
  console.log(`⏭️  Skipped (legacy): ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
  console.log(`${'═'.repeat(50)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

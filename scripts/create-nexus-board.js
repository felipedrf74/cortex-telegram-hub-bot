#!/usr/bin/env node
/**
 * Nexus Hub — Notion Project Board Creator
 * 
 * Usage:
 *   NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=332ad49d23e78075a924ef844eac8f47 node scripts/create-nexus-board.js
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
let NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;

if (!NOTION_TOKEN || !NOTION_PAGE_ID) {
  console.error('\n❌ Missing environment variables!\n');
  console.error('Usage:');
  console.error('  NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=xxx node scripts/create-nexus-board.js\n');
  process.exit(1);
}

// Clean page ID: strip page name prefix, format as UUID if needed
NOTION_PAGE_ID = NOTION_PAGE_ID.replace(/^.*-([a-f0-9]{32})$/i, '$1');
if (NOTION_PAGE_ID.length === 32 && !NOTION_PAGE_ID.includes('-')) {
  NOTION_PAGE_ID = `${NOTION_PAGE_ID.slice(0,8)}-${NOTION_PAGE_ID.slice(8,12)}-${NOTION_PAGE_ID.slice(12,16)}-${NOTION_PAGE_ID.slice(16,20)}-${NOTION_PAGE_ID.slice(20)}`;
}

console.log(`\n🚀 Page ID resolved: ${NOTION_PAGE_ID}\n`);

// ─── All Tasks ──────────────────────────────────────────────────────

const TASKS = [
  // Phase 0 — Month 1
  { title: "Router tests (classifier.ts)", desc: "Pattern match, keyword match, AI classify mock. Three-tier classification tests.", status: "In Progress", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["test", "code"], month: "Month 1" },
  { title: "Tool executor tests", desc: "All 15+ tool definitions with mocked external APIs. Security surface testing.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["test", "code"], month: "Month 1" },
  { title: "Domain handler tests", desc: "Secretary, triathlon, content routing with fixture conversations.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["test", "code"], month: "Month 1" },
  { title: "Database & migration tests", desc: "All 18 migrations, CRUD operations, in-memory SQLite.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["test", "code"], month: "Month 1" },
  { title: "Integration tests (message flow)", desc: "Full Telegram input → classify → domain → response flow.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["test", "code"], month: "Month 1" },
  { title: "CI pipeline (GitHub Actions)", desc: "Tests run on every push to main and on PRs.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["test", "infra"], month: "Month 1" },
  { title: "AIProvider interface", desc: "Define classify(), chat(), vision(), extract() abstraction.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["arch", "code"], month: "Month 1" },
  { title: "AnthropicProvider implementation", desc: "Wrap existing @anthropic-ai/sdk calls behind AIProvider.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["code"], month: "Month 1" },
  { title: "OpenAIProvider implementation", desc: "GPT-4o + GPT-4o-mini support via AIProvider.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["code"], month: "Month 1" },
  { title: "GeminiProvider implementation", desc: "Gemini 2.0 Flash support via AIProvider.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["code"], month: "Month 1" },
  { title: "Provider fallback logic", desc: "Primary + fallback per task type. Auto-switch on failure.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["arch", "code"], month: "Month 1" },
  { title: "MessageAdapter interface", desc: "sendText(), sendFile(), sendInlineButtons(), editMessage(). Platform-agnostic.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["arch", "code"], month: "Month 1" },
  { title: "TelegramAdapter implementation", desc: "Grammy as first concrete MessageAdapter.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["code"], month: "Month 1" },
  { title: "StorageProvider interface", desc: "Abstract SQLite behind interface for future PostgreSQL.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["arch", "code"], month: "Month 1" },
  { title: "SQLiteStorage implementation", desc: "Wrap better-sqlite3 calls behind StorageProvider.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["code"], month: "Month 1" },
  { title: "Copyright headers (60+ files)", desc: "MIT license header on all source files.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["legal"], month: "Month 1" },
  { title: "Update package.json → @nexushub", desc: "Rename to @nexushub/core, add license: MIT.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["code"], month: "Month 1" },
  { title: "Rename Cortex → Nexus Hub in codebase", desc: "Docs, prompts, portal, README, all references.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["code", "brand"], month: "Month 1" },

  // Phase 0 — Month 2
  { title: "Trademark search for 'Nexus Hub'", desc: "Engage attorney, EUIPO + INPI (Brazil). Budget €1,200–€2,000.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["legal", "brand"], month: "Month 2" },
  { title: "Register domain (nexushub.me)", desc: "Domain nexushub.me purchased. Configure DNS, SSL, point to landing page.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["brand"], month: "Month 2" },
  { title: "Reserve social handles", desc: "@nexushub on Instagram, X, YouTube, TikTok.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["brand"], month: "Month 2" },
  { title: "Design minimal logo", desc: "Hub/nexus concept. Clean, monochrome, tech-forward.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["brand", "design"], month: "Month 2" },
  { title: "Per-tenant config system", desc: "ConfigProvider abstraction (even if single-tenant initially).", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["arch", "code"], month: "Month 2" },
  { title: "Landing page (PT-BR)", desc: "nexushub.me hero, features, pricing, CTA. Portuguese.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["design", "marketing"], month: "Month 2" },
  { title: "Terms of Service (PT law)", desc: "SaaS ToS compliant with Portuguese law.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["legal"], month: "Month 2" },
  { title: "Privacy Policy (GDPR)", desc: "Data processing, retention, user rights, GDPR compliance.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["legal"], month: "Month 2" },
  { title: "Usage metering system", desc: "Track AI messages per tenant per day.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["code"], month: "Month 2" },

  // Phase 0 — Month 3
  { title: "Onboarding wizard (browser)", desc: "Step-by-step OAuth flow for Microsoft, Google, Garmin.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["code", "ux"], month: "Month 3" },
  { title: "Deploy on Hetzner Cloud", desc: "Docker Compose: Node.js + Python content-engine + SQLite. EU region.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra"], month: "Month 3" },
  { title: "Stripe billing integration", desc: "3 tiers (Starter/Pro/Enterprise), checkout, webhooks.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["code"], month: "Month 3" },
  { title: "GDPR data export command", desc: "/export-my-data — export all user data as JSON.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["code", "legal"], month: "Month 3" },
  { title: "GDPR data deletion command", desc: "/delete-my-data — full data erasure with confirmation.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["code", "legal"], month: "Month 3" },
  { title: "Invite 10–20 beta users", desc: "From The Operator audience. Collect feedback.", status: "Backlog", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["marketing"], month: "Month 3" },

  // Phase 1
  { title: "Per-tenant DB isolation", desc: "Separate SQLite per tenant or PostgreSQL schema isolation.", status: "Backlog", phase: "Phase 1 — Private Beta", priority: "🟠 High", tags: ["arch", "code"], month: "" },
  { title: "User-facing dashboard", desc: "Web app showing content pipeline, analytics, billing.", status: "Backlog", phase: "Phase 1 — Private Beta", priority: "🟠 High", tags: ["code", "design"], month: "" },
  { title: "Module marketplace MVP", desc: "List, install, rate community modules.", status: "Backlog", phase: "Phase 1 — Private Beta", priority: "🟠 High", tags: ["code", "arch"], month: "" },
  { title: "First community modules", desc: "Recruit 3–5 module contributors from community.", status: "Backlog", phase: "Phase 1 — Private Beta", priority: "🟡 Medium", tags: ["community"], month: "" },

  // Phase 2
  { title: "WhatsApp adapter", desc: "WhatsApp Business API implementation of MessageAdapter.", status: "Backlog", phase: "Phase 2 — Public Launch", priority: "🟠 High", tags: ["code"], month: "" },
  { title: "Discord adapter", desc: "Discord.js slash commands + embeds adapter.", status: "Backlog", phase: "Phase 2 — Public Launch", priority: "🟡 Medium", tags: ["code"], month: "" },
  { title: "Affiliate program", desc: "20% recurring commission for creator referrals.", status: "Backlog", phase: "Phase 2 — Public Launch", priority: "🟡 Medium", tags: ["marketing"], month: "" },
  { title: "API docs for module developers", desc: "REST/GraphQL API documentation for third-party modules.", status: "Backlog", phase: "Phase 2 — Public Launch", priority: "🟠 High", tags: ["code", "design"], month: "" },
];

// ─── Notion API ─────────────────────────────────────────────────────

async function notionFetch(endpoint, body) {
  const resp = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API ${resp.status}: ${err}`);
  }
  return resp.json();
}

function richText(text) {
  return [{ text: { content: text } }];
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Creating Nexus Hub project board in Notion...\n');

  // Step 1: Create the database
  console.log('📋 Creating database with properties...');
  
  const db = await notionFetch('/databases', {
    parent: { page_id: NOTION_PAGE_ID },
    icon: { emoji: '🚀' },
    title: [{ text: { content: 'Nexus Hub — Development Board' } }],
    properties: {
      'Task': { title: {} },
      'Status': {
        select: {
          options: [
            { name: 'Backlog', color: 'default' },
            { name: 'To Do', color: 'blue' },
            { name: 'In Progress', color: 'yellow' },
            { name: 'Review', color: 'purple' },
            { name: 'Done', color: 'green' },
          ]
        }
      },
      'Phase': {
        select: {
          options: [
            { name: 'Phase 0 — Foundation', color: 'red' },
            { name: 'Phase 1 — Private Beta', color: 'orange' },
            { name: 'Phase 2 — Public Launch', color: 'blue' },
            { name: 'Phase 3 — Scale', color: 'green' },
          ]
        }
      },
      'Priority': {
        select: {
          options: [
            { name: '🔴 Critical', color: 'red' },
            { name: '🟠 High', color: 'orange' },
            { name: '🟡 Medium', color: 'yellow' },
            { name: '🟢 Low', color: 'green' },
          ]
        }
      },
      'Tags': {
        multi_select: {
          options: [
            { name: 'code', color: 'blue' },
            { name: 'arch', color: 'pink' },
            { name: 'test', color: 'green' },
            { name: 'legal', color: 'brown' },
            { name: 'brand', color: 'purple' },
            { name: 'design', color: 'red' },
            { name: 'infra', color: 'default' },
            { name: 'marketing', color: 'green' },
            { name: 'ux', color: 'yellow' },
            { name: 'community', color: 'gray' },
          ]
        }
      },
      'Description': { rich_text: {} },
      'Month': {
        select: {
          options: [
            { name: 'Month 1', color: 'red' },
            { name: 'Month 2', color: 'orange' },
            { name: 'Month 3', color: 'yellow' },
          ]
        }
      },
    },
  });

  const databaseId = db.id;
  console.log(`✅ Database created: ${databaseId}\n`);

  // Step 2: Create all tasks
  console.log(`📝 Creating ${TASKS.length} tasks...\n`);
  
  let created = 0;
  let failed = 0;
  
  for (const task of TASKS) {
    try {
      const properties = {
        'Task': { title: richText(task.title) },
        'Description': { rich_text: richText(task.desc) },
        'Status': { select: { name: task.status } },
        'Phase': { select: { name: task.phase } },
        'Priority': { select: { name: task.priority } },
        'Tags': { multi_select: task.tags.map(t => ({ name: t })) },
      };
      
      if (task.month) {
        properties['Month'] = { select: { name: task.month } };
      }

      await notionFetch('/pages', {
        parent: { database_id: databaseId },
        properties,
      });

      created++;
      const icon = task.priority.split(' ')[0];
      process.stdout.write(`  ${icon} ${task.title}\n`);
      
      // Rate limit: Notion allows ~3 req/s
      await new Promise(r => setTimeout(r, 350));
      
    } catch (err) {
      failed++;
      console.error(`  ❌ Failed: ${task.title} — ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Created: ${created} tasks`);
  if (failed > 0) console.log(`❌ Failed: ${failed} tasks`);
  console.log(`\n🎯 Open Notion → switch database view to "Board" grouped by "Status"`);
  console.log(`🔗 Database: https://www.notion.so/${databaseId.replace(/-/g, '')}`);
  console.log(`${'═'.repeat(50)}\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});

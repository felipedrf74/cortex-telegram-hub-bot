#!/usr/bin/env node
/**
 * Add CI/CD & DevOps tasks to the Nexus Hub Notion board
 * 
 * Usage:
 *   NOTION_TOKEN=ntn_xxx NOTION_DB_ID=xxx node scripts/add-cicd-tasks.js
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;

if (!NOTION_TOKEN || !NOTION_DB_ID) {
  console.error('Usage: NOTION_TOKEN=ntn_xxx NOTION_DB_ID=xxx node scripts/add-cicd-tasks.js');
  console.error('\nThe DB ID is the Nexus Hub Development Board database ID.');
  console.error('Find it in the URL when viewing the board: notion.so/<DB_ID>?v=...');
  process.exit(1);
}

const TASKS = [
  // CI/CD Pipeline
  { title: "CI Pipeline — GitHub Actions", desc: "Lint, type check, test, build on every push/PR. Includes Python syntax check and migration validation.", status: "Done", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["infra", "code"], month: "Month 1" },
  { title: "CD Pipeline — Auto-deploy to production", desc: "GitHub Actions deploys on merge to main. Includes backup, rsync, npm ci, PM2 restart, health check.", status: "Done", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["infra", "code"], month: "Month 1" },
  { title: "Release workflow — Automated versioning", desc: "GitHub Actions: bump version, update CHANGELOG, create git tag, GitHub Release, notify Notion.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra", "code"], month: "Month 1" },
  { title: "Rollback script", desc: "scripts/rollback.sh — list backups, restore specific version, pre-rollback safety backup, health check.", status: "Done", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["infra", "code"], month: "Month 1" },
  { title: "Server backup rotation", desc: "Auto-backup on every deploy, keep last 10 versions. tar.gz of dist, prompts, migrations, config.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra"], month: "Month 1" },
  { title: "Git branching strategy", desc: "main/develop/feature/hotfix/release branches. BRANCHING.md with full workflow documented.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra"], month: "Month 1" },
  { title: "Git hooks (pre-commit, pre-push)", desc: "Pre-commit: type check. Pre-push: type check + tests + build verify for main.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra", "code"], month: "Month 1" },
  { title: "Vitest test framework setup", desc: "vitest.config.ts, setup.ts with Anthropic/Grammy/Pino mocks, coverage thresholds.", status: "Done", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["test", "code"], month: "Month 1" },
  { title: "Notion release tracker DB", desc: "Releases database in Notion. GitHub Actions logs every deploy/release/rollback with status.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["infra"], month: "Month 1" },
  
  // Testing tasks
  { title: "Database & migration tests", desc: "In-memory SQLite: apply all 18+ migrations, verify tables, CRUD on key tables.", status: "Done", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["test", "code"], month: "Month 1" },
  
  // Remaining DevOps
  { title: "Create develop branch", desc: "Branch from main, set up as integration branch. Update CI to run on develop too.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra"], month: "Month 1" },
  { title: "Install npm deps (vitest)", desc: "Run npm install to add vitest, @vitest/coverage-v8, @vitest/ui devDependencies.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["code"], month: "Month 1" },
  { title: "Run setup-hooks.sh", desc: "Install pre-commit and pre-push Git hooks locally.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["infra"], month: "Month 1" },
  { title: "Configure GitHub Secrets", desc: "Add SERVER_HOST, SERVER_USER, SERVER_SSH_KEY, NOTION_TOKEN, NOTION_RELEASES_DB to repo secrets.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🔴 Critical", tags: ["infra"], month: "Month 1" },
  { title: "GitHub branch protection rules", desc: "Require CI pass on PRs to main and develop. Require linear history.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["infra"], month: "Month 1" },
  { title: "Run first CI pipeline", desc: "Push to main, verify GitHub Actions CI runs: lint, test, build, python check, migrations.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🟠 High", tags: ["test", "infra"], month: "Month 1" },
  { title: "Notion releases DB setup", desc: "Run create-releases-db.js, add DB ID to GitHub Secrets as NOTION_RELEASES_DB.", status: "To Do", phase: "Phase 0 — Foundation", priority: "🟡 Medium", tags: ["infra"], month: "Month 1" },
];

async function main() {
  console.log('\n📋 Adding CI/CD tasks to Nexus Hub board...\n');

  let created = 0;
  for (const task of TASKS) {
    try {
      const properties = {
        'Task': { title: [{ text: { content: task.title } }] },
        'Description': { rich_text: [{ text: { content: task.desc } }] },
        'Status': { select: { name: task.status } },
        'Phase': { select: { name: task.phase } },
        'Priority': { select: { name: task.priority } },
        'Tags': { multi_select: task.tags.map(t => ({ name: t })) },
      };
      if (task.month) {
        properties['Month'] = { select: { name: task.month } };
      }

      const resp = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
          parent: { database_id: NOTION_DB_ID },
          properties,
        }),
      });

      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      
      created++;
      const icon = task.status === 'Done' ? '✅' : task.status === 'To Do' ? '🎯' : '⚡';
      console.log(`  ${icon} ${task.title}`);
      await new Promise(r => setTimeout(r, 350));
    } catch (e) {
      console.error(`  ❌ ${task.title}: ${e.message}`);
    }
  }

  console.log(`\n✅ Created ${created} CI/CD tasks`);
  console.log('📋 Tasks marked "Done" will appear in your Done column');
  console.log('🎯 Tasks marked "To Do" are your next actions\n');
}

main().catch(e => { console.error(e); process.exit(1); });

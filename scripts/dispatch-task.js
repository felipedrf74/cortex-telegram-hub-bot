#!/usr/bin/env node
/**
 * Nexus Hub — Manual Task Dispatcher
 *
 * Bootstraps any agent with a specific Notion task, bypassing the auto-chain.
 * Use this when:
 *   - An agent has no current task and you want to assign one manually
 *   - The Agent field was missing and the task never got dispatched
 *   - You want to re-queue a task after a failure
 *   - You need to start the pipeline from scratch
 *
 * Usage:
 *   node scripts/dispatch-task.js --task <notion-page-id>
 *   node scripts/dispatch-task.js --task <notion-page-id> --agent qa
 *   node scripts/dispatch-task.js --list                        (show To Do tasks)
 *   node scripts/dispatch-task.js --list --all                  (include all statuses)
 *
 * Examples:
 *   node scripts/dispatch-task.js --task 334ad49d-23e7-814b-8fb3-e55eb4429fe0
 *   node scripts/dispatch-task.js --task 334ad49d-23e7-814b-8fb3-e55eb4429fe0 --agent qa
 *   NOTION_TOKEN=ntn_xxx node scripts/dispatch-task.js --list
 */

const fs = require('fs');
const path = require('path');

const NOTION_DB_ID = '332ad49d-23e7-81aa-831e-d5a3ceff20c1';
const WORKTREE_BASE = path.resolve(__dirname, '../../nexushub-worktrees');

// ─── Load NOTION_TOKEN ───────────────────────────────────────────────
let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
if (!NOTION_TOKEN) {
  const searchPaths = [
    path.join(__dirname, '..', '.env.agents'),
    path.join(process.cwd(), '.env.agents'),
  ];
  for (const p of searchPaths) {
    try {
      const f = fs.readFileSync(p, 'utf8');
      const m = f.match(/NOTION_TOKEN=(.+)/);
      if (m) { NOTION_TOKEN = m[1].trim(); break; }
    } catch {}
  }
}
if (!NOTION_TOKEN) {
  console.error('❌ NOTION_TOKEN required. Set env var or create .env.agents with NOTION_TOKEN=...');
  process.exit(1);
}

// ─── Arg parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const taskId   = getArg('task');
const forceAgent = getArg('agent');   // override agent detection
const listMode = hasFlag('list');
const listAll  = hasFlag('all');

// ─── Agent routing ────────────────────────────────────────────────────
const AGENT_MAP = {
  '🔧 Backend':   'backend',
  '🧪 QA':        'qa',
  '⚙️ DevOps':    'devops',
  '🔒 Security':  'flex',
  '♻️ Refactor':  'flex',
  '🏗️ Architect': 'backend',
};

const COMMIT_PREFIX = {
  backend: 'feat',
  qa:      'test',
  devops:  'ci',
  flex:    'refactor',
};

// ─── Notion API ──────────────────────────────────────────────────────
async function notionFetch(endpoint, method = 'GET', body) {
  const resp = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

async function getTask(pageId) {
  const page = await notionFetch(`/pages/${pageId}`);
  if (page.object === 'error') throw new Error(`Notion error: ${page.message}`);
  return {
    id: page.id,
    title: page.properties.Task?.title?.[0]?.plain_text || 'Untitled',
    description: page.properties.Description?.rich_text?.[0]?.plain_text || '',
    priority: page.properties.Priority?.select?.name || 'Medium',
    phase: page.properties.Phase?.select?.name || '',
    tags: (page.properties.Tags?.multi_select || []).map(t => t.name),
    month: page.properties.Month?.select?.name || '',
    agent: page.properties.Agent?.select?.name || '',
    status: page.properties.Status?.select?.name || '',
  };
}

async function listTasks(all = false) {
  const filter = all ? {} : {
    filter: { property: 'Status', select: { equals: 'To Do' } }
  };
  const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
    ...filter,
    sorts: [
      { property: 'Priority', direction: 'ascending' },
      { property: 'Month', direction: 'ascending' },
    ],
    page_size: 50,
  });
  return data.results.map(page => ({
    id: page.id,
    title: page.properties.Task?.title?.[0]?.plain_text || 'Untitled',
    priority: page.properties.Priority?.select?.name || '—',
    phase: page.properties.Phase?.select?.name || '—',
    agent: page.properties.Agent?.select?.name || '⚠️  NO AGENT',
    status: page.properties.Status?.select?.name || '—',
  }));
}

async function updateTaskStatus(taskId, status) {
  await notionFetch(`/pages/${taskId}`, 'PATCH', {
    properties: { Status: { select: { name: status } } },
  });
}

// ─── Dependency check ────────────────────────────────────────────────
async function isTaskBlocked(taskOrId) {
  // Accept either a full task object (with id) or a page ID string
  const pageId = typeof taskOrId === 'string' ? taskOrId : taskOrId.id;
  const page = await notionFetch(`/pages/${pageId}`);
  const blockedByRelation = page.properties?.['Blocked By']?.relation || [];
  if (blockedByRelation.length === 0) return false;

  for (const ref of blockedByRelation) {
    const blockerPage = await notionFetch(`/pages/${ref.id}`);
    const blockerStatus = blockerPage.properties?.Status?.select?.name;
    const blockerTitle = blockerPage.properties?.Task?.title?.[0]?.plain_text || ref.id;
    if (blockerStatus !== 'Done') {
      console.log(`  ⏸ Blocked by "${blockerTitle}" (status: ${blockerStatus})`);
      return true;
    }
  }
  return false;
}

// ─── Prompt writers ──────────────────────────────────────────────────
function writeRegularPrompt(task, agentDir) {
  const prefix = COMMIT_PREFIX[agentDir] || 'feat';
  const repoEsc = '~/Desktop/Custom\\\\ Connectors/Cortex/cortex-telegram-hub-bot';
  const prompt = `# Agent Task — Dispatched Manually

## Task: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}
**Tags:** ${task.tags.join(', ')}
**Agent:** ${task.agent}

## Description
${task.description || '(No description — check Notion card for details)'}

## Instructions
1. Read CLAUDE.md for project context
2. Implement the task described above
3. Write tests if applicable
4. Run: \`npx vitest run\` and \`npx tsc --noEmit\`
5. Commit: \`git commit -m "${prefix}(scope): ${task.title.toLowerCase().substring(0, 50)}"\`
6. Push: \`git push origin $(git branch --show-current)\`

## Auto-chain (MANDATORY — do this immediately after pushing)
\`\`\`bash
AGENT_DIR=$(basename $(pwd))
node ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --summary "describe what you built"
\`\`\`
Then immediately check for the next task:
\`\`\`bash
cat .agent-prompt.md 2>/dev/null
\`\`\`

## Notion Task ID
${task.id}

## Rules
- Do NOT merge to develop or main
- Always run tests before committing
- Always call agent-complete.js when done
`;
  const agentPath = path.join(WORKTREE_BASE, agentDir);
  fs.mkdirSync(agentPath, { recursive: true });
  fs.writeFileSync(path.join(agentPath, '.agent-prompt.md'), prompt);
  fs.writeFileSync(path.join(agentPath, '.agent-task.json'), JSON.stringify({
    id: task.id, title: task.title, description: task.description,
    priority: task.priority, phase: task.phase, tags: task.tags, agent: task.agent,
  }, null, 2));
}

function writeQAPrompt(task, originAgent) {
  const repoEsc = '~/Desktop/Custom\\\\ Connectors/Cortex/cortex-telegram-hub-bot';
  const prompt = `# 🧪 QA Validation Task — Dispatched Manually

## Validating: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}

## Description
${task.description || '(No description — check Notion card for details)'}

## Your job
1. Pull the latest code: \`git fetch origin && git merge origin/agent/${originAgent || 'backend'} --no-edit\`
2. Review the implementation
3. Run: \`npx vitest run\` and \`npx tsc --noEmit\`
4. Write validation tests for new code if missing
5. Check acceptance criteria in the description

## Auto-chain (MANDATORY)
### If everything passes:
\`\`\`bash
AGENT_DIR=$(basename $(pwd))
node ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --verdict pass
\`\`\`
### If something fails:
\`\`\`bash
AGENT_DIR=$(basename $(pwd))
node ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --verdict fail --reason "what failed"
\`\`\`

## Notion Task ID
${task.id}
`;
  const qaPath = path.join(WORKTREE_BASE, 'qa');
  fs.mkdirSync(qaPath, { recursive: true });
  fs.writeFileSync(path.join(qaPath, '.agent-prompt.md'), prompt);
  fs.writeFileSync(path.join(qaPath, '.agent-task.json'), JSON.stringify({
    id: task.id, title: task.title, description: task.description,
    priority: task.priority, phase: task.phase, tags: task.tags,
    agent: '🧪 QA', originAgent: originAgent || 'backend',
  }, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {

  // ── LIST MODE ───────────────────────────────────────────────────────
  if (listMode) {
    console.log(`\n📋 Fetching tasks (${listAll ? 'all statuses' : 'To Do only'})...\n`);
    const tasks = await listTasks(listAll);
    if (tasks.length === 0) {
      console.log('  No tasks found.');
      return;
    }
    const maxTitle = Math.max(...tasks.map(t => t.title.length), 5);
    console.log(
      'ID'.padEnd(36) + '  ' +
      'STATUS'.padEnd(14) + '  ' +
      'PRIORITY'.padEnd(10) + '  ' +
      'AGENT'.padEnd(14) + '  ' +
      'TITLE'
    );
    console.log('─'.repeat(100));
    for (const t of tasks) {
      const agentLabel = t.agent.length > 13 ? t.agent.substring(0, 13) : t.agent;
      const warning = t.agent === '⚠️  NO AGENT' ? ' ← missing!' : '';
      console.log(
        t.id.padEnd(36) + '  ' +
        t.status.padEnd(14) + '  ' +
        t.priority.padEnd(10) + '  ' +
        agentLabel.padEnd(14) + '  ' +
        t.title + warning
      );
    }
    console.log(`\n${tasks.length} task(s) shown.`);
    console.log('\nTo dispatch a task:');
    console.log('  node scripts/dispatch-task.js --task <ID>');
    console.log('  node scripts/dispatch-task.js --task <ID> --agent qa');
    return;
  }

  // ── DISPATCH MODE ────────────────────────────────────────────────────
  if (!taskId) {
    console.error('Usage:');
    console.error('  node scripts/dispatch-task.js --task <notion-page-id>');
    console.error('  node scripts/dispatch-task.js --task <notion-page-id> --agent qa');
    console.error('  node scripts/dispatch-task.js --list');
    process.exit(1);
  }

  console.log(`\n🔍 Fetching task ${taskId}...`);
  const task = await getTask(taskId);
  console.log(`  Title:    ${task.title}`);
  console.log(`  Status:   ${task.status}`);
  console.log(`  Priority: ${task.priority}`);
  console.log(`  Agent:    ${task.agent || '(none)'}`);

  // Check for unresolved blockers
  if (await isTaskBlocked(taskId)) {
    console.log(`\n⏸ Task is blocked by incomplete dependencies. Skipping dispatch.`);
    console.log(`  Resolve blocked tasks first, then re-dispatch.`);
    process.exit(0);
  }

  // Determine target agent
  let targetAgent = forceAgent;
  if (!targetAgent) {
    targetAgent = AGENT_MAP[task.agent];
    if (!targetAgent) {
      console.error(`\n❌ No agent mapping for "${task.agent}".`);
      console.error(`   Available agents: backend, qa, devops, flex`);
      console.error(`   Use --agent <name> to override, or set Agent field in Notion.`);
      process.exit(1);
    }
  }
  console.log(`  → Dispatching to: ${targetAgent}`);

  // Write prompt
  if (targetAgent === 'qa') {
    writeQAPrompt(task, 'backend');
    console.log(`\n✅ QA prompt written → nexushub-worktrees/qa/.agent-prompt.md`);
  } else {
    writeRegularPrompt(task, targetAgent);
    console.log(`\n✅ Prompt written → nexushub-worktrees/${targetAgent}/.agent-prompt.md`);
  }

  // Update Notion status
  if (task.status === 'To Do' || task.status === 'Backlog') {
    const newStatus = targetAgent === 'qa' ? 'QA Validating' : 'In Progress';
    await updateTaskStatus(task.id, newStatus);
    console.log(`✅ Notion status → ${newStatus}`);
  } else {
    console.log(`ℹ️  Notion status unchanged (was: ${task.status})`);
  }

  console.log(`\n👉 Now open the ${targetAgent} worktree in Claude Code and run:`);
  console.log(`   cat .agent-prompt.md`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

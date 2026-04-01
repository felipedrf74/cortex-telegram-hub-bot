#!/usr/bin/env node
/**
 * Nexus Hub — Agent Task Dispatcher
 * 
 * Pulls tasks from the Notion Development Board and creates
 * task files that Claude Code agents pick up automatically.
 * 
 * Usage:
 *   node scripts/dispatch-tasks.js                    # Assign "To Do" tasks to idle agents
 *   node scripts/dispatch-tasks.js --list             # Show available tasks
 *   node scripts/dispatch-tasks.js --assign <task-id> <agent-dir>  # Manual assign
 *   node scripts/dispatch-tasks.js --status           # Show agent statuses
 *   node scripts/dispatch-tasks.js --done <agent-dir> # Mark task done, clear agent
 * 
 * Environment:
 *   NOTION_TOKEN     — Notion integration token
 *   NOTION_DB_ID     — Development Board database ID (default: from memory)
 */

const NOTION_DB_ID = process.env.NOTION_DB_ID || '332ad49d-23e7-81aa-831e-d5a3ceff20c1';
const WORKTREE_BASE = require('path').resolve(__dirname, '../../nexushub-worktrees');
const REPO_DIR = require('path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');

// Read NOTION_TOKEN from env or .env.agents fallback
let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
if (!NOTION_TOKEN) {
  try {
    const f = fs.readFileSync(path.join(__dirname, '..', '.env.agents'), 'utf8');
    const m = f.match(/NOTION_TOKEN=(.+)/);
    if (m) NOTION_TOKEN = m[1].trim();
  } catch {}
}

if (!NOTION_TOKEN) {
  console.error('❌ NOTION_TOKEN required. Set env var or create .env.agents');
  process.exit(1);
}

// ─── Review Handoff Template (shared by all agents) ─────────────────

const REVIEW_HANDOFF = `
## REQUIRED: Review handoff (do this BEFORE saying you're done)

When your work is complete, you MUST provide Felipe with a review summary using this exact format:

### What was done
- Brief list of what was implemented/fixed

### Files changed
- List key files added or modified

### Acceptance criteria
- [ ] \`npx vitest run\` passes — all tests green
- [ ] \`npx tsc --noEmit\` — no type errors
- [ ] Portal updated (\`src/portal/portal.html\`) — if feature adds cron jobs, commands, integrations, or user-facing functionality
- [ ] (Add specific criteria for this task)

### User test steps (how Felipe tests this in Telegram)
1. Open Telegram → Nexus Hub bot
2. Send: (the command or message that triggers the feature)
3. Expected response: (what the bot should reply)
4. Edge case: (what happens with invalid input)

If this task has no user-facing change, write "No user-facing change — internal refactor only."

### Dev validation steps
1. Step-by-step commands Felipe can run to verify
2. Expected output for each step

### Tests added
- List new test files/cases
- Total test count before → after

### Breaking changes
- None / list any

### Dependencies added
- None / list any new npm packages

This review summary is MANDATORY. Felipe uses it to decide whether to merge your work.
`;

// ─── Notion API ─────────────────────────────────────────────────────

async function notionFetch(endpoint, method = 'POST', body = {}) {
  const resp = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function fetchTasks(status = 'To Do') {
  const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
    filter: {
      property: 'Status',
      select: { equals: status },
    },
    sorts: [
      { property: 'Priority', direction: 'ascending' },
    ],
  });

  return data.results.map(page => ({
    id: page.id,
    title: page.properties.Task?.title?.[0]?.plain_text || 'Untitled',
    description: page.properties.Description?.rich_text?.[0]?.plain_text || '',
    priority: page.properties.Priority?.select?.name || 'Medium',
    phase: page.properties.Phase?.select?.name || '',
    tags: (page.properties.Tags?.multi_select || []).map(t => t.name),
    month: page.properties.Month?.select?.name || '',
    status: page.properties.Status?.select?.name || '',
    agent: page.properties.Agent?.select?.name || '',
  }));
}

async function updateTaskStatus(taskId, status) {
  await notionFetch(`/pages/${taskId}`, 'PATCH', {
    properties: {
      'Status': { select: { name: status } },
    },
  });
}

// ─── Agent Detection ────────────────────────────────────────────────

function getAgents() {
  if (!fs.existsSync(WORKTREE_BASE)) return [];

  const agents = [];
  for (const dir of fs.readdirSync(WORKTREE_BASE)) {
    const worktreePath = path.join(WORKTREE_BASE, dir);
    if (!fs.statSync(worktreePath).isDirectory()) continue;

    const taskFile = path.join(worktreePath, '.agent-task.json');
    const hasTask = fs.existsSync(taskFile);
    let currentTask = null;

    if (hasTask) {
      try {
        currentTask = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
      } catch {}
    }

    let branch = 'unknown';
    try {
      const headFile = path.join(worktreePath, '.git');
      if (fs.existsSync(headFile)) {
        const gitDir = fs.readFileSync(headFile, 'utf-8').trim().replace('gitdir: ', '');
        const headRef = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
        branch = headRef.replace('ref: refs/heads/', '');
      }
    } catch {}

    agents.push({
      name: dir,
      path: worktreePath,
      branch,
      hasTask,
      currentTask,
      type: dir === 'qa' ? 'qa' :
            dir === 'devops' ? 'devops' :
            dir === 'flex' ? 'flex' : 'backend',
    });
  }

  return agents;
}

function getIdleAgents() {
  return getAgents().filter(a => !a.hasTask);
}

// ─── Task Assignment ────────────────────────────────────────────────

function assignTaskToAgent(task, agentDir) {
  const taskFile = path.join(WORKTREE_BASE, agentDir, '.agent-task.json');
  const promptFile = path.join(WORKTREE_BASE, agentDir, '.agent-prompt.md');

  const isBugAgent = agentDir === 'flex' && (task.agent === '♻️ Refactor' || task.agent === '🔒 Security');
  const isTestAgent = agentDir === 'qa';
  const isDevOps = agentDir === 'devops';

  let prompt;
  if (isBugAgent) {
    prompt = `# 🐛 Bug Agent Task

## Task: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}
**Tags:** ${task.tags.join(', ')}

## Description
${task.description}

## Instructions
1. Read CLAUDE.md for project context and your role as Bug Agent
2. Understand the bug or area to investigate described above
3. Write a **failing test** that reproduces the issue
4. Fix the bug in the source code
5. Verify the test now passes and no other tests break: \`npx vitest run\`
6. Commit: \`git commit -m "fix(scope): ${task.title.toLowerCase()}"\`
7. Push: \`git push origin $(git branch --show-current)\`
8. Log: \`echo "$(date '+%Y-%m-%d %H:%M') DONE: ${task.title}" >> ~/Desktop/nexushub-agent-log.md\`
9. **Provide the review handoff summary** (see below)

## Notion Task ID
${task.id}

## Rules
- Write failing test BEFORE fixing
- Do NOT merge to develop or main
- Run all tests before committing
${REVIEW_HANDOFF}`;
  } else if (isTestAgent) {
    prompt = `# 🧪 Test Agent Task

## Task: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}
**Tags:** ${task.tags.join(', ')}

## Description
${task.description}

## Instructions
1. Read CLAUDE.md for project context and your role as Test Agent
2. Understand the testing area described above
3. Create test files in \`__tests__/\` following the existing structure
4. Mock all external APIs (Anthropic, Microsoft, Google, Garmin) — see \`__tests__/setup.ts\`
5. Use in-memory SQLite for database tests
6. Aim for high coverage on the specific area described
7. Run tests: \`npx vitest run\`
8. Commit: \`git commit -m "test(scope): ${task.title.toLowerCase()}"\`
9. Push: \`git push origin $(git branch --show-current)\`
10. Log: \`echo "$(date '+%Y-%m-%d %H:%M') DONE: ${task.title}" >> ~/Desktop/nexushub-agent-log.md\`
11. **Provide the review handoff summary** (see below)

## Notion Task ID
${task.id}

## Rules
- Never call real external APIs in tests
- Use \`__tests__/setup.ts\` mocks
- Do NOT merge to develop or main
${REVIEW_HANDOFF}`;
  } else if (isDevOps) {
    prompt = `# ⚙️ DevOps Agent Task

## Task: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}
**Tags:** ${task.tags.join(', ')}

## Description
${task.description}

## Instructions
1. Read CLAUDE.md for project context
2. Understand the infrastructure task described above
3. Implement the changes (CI/CD, migrations, deploy scripts, monitoring)
4. Write tests if applicable
5. Run tests: \`npx vitest run\`
6. Run type check: \`npx tsc --noEmit\`
7. Commit: \`git commit -m "ci(scope): ${task.title.toLowerCase()}"\`
8. Push: \`git push origin $(git branch --show-current)\`
9. Log: \`echo "$(date '+%Y-%m-%d %H:%M') DONE: ${task.title}" >> ~/Desktop/nexushub-agent-log.md\`
10. **Provide the review handoff summary** (see below)

## Notion Task ID
${task.id}

## Rules
- Only touch infrastructure: CI/CD, migrations, deploy, monitoring
- Do NOT modify feature code or domain handlers
- Do NOT merge to develop or main
${REVIEW_HANDOFF}`;
  } else {
    prompt = `# ⚡ Feature Agent Task

## Task: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}
**Tags:** ${task.tags.join(', ')}

## Description
${task.description}

## Instructions
1. Read CLAUDE.md for project context and coding standards
2. Understand the feature described above
3. Implement the feature with clean, typed TypeScript
4. Write tests for the new functionality in \`__tests__/\`
5. Run tests: \`npx vitest run\`
6. Run type check: \`npx tsc --noEmit\`
7. Commit: \`git commit -m "feat(scope): ${task.title.toLowerCase()}"\`
8. Push: \`git push origin $(git branch --show-current)\`
9. Log: \`echo "$(date '+%Y-%m-%d %H:%M') DONE: ${task.title}" >> ~/Desktop/nexushub-agent-log.md\`
10. **Provide the review handoff summary** (see below)

## Notion Task ID
${task.id}

## Rules
- Follow commit convention: feat(scope): description
- Write tests for new code
- Do NOT merge to develop or main
- Use \`os.homedir()\` for paths, never hardcode
${REVIEW_HANDOFF}`;
  }

  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
  fs.writeFileSync(promptFile, prompt);

  return { taskFile, promptFile };
}

function clearAgentTask(agentDir) {
  const taskFile = path.join(WORKTREE_BASE, agentDir, '.agent-task.json');
  const promptFile = path.join(WORKTREE_BASE, agentDir, '.agent-prompt.md');
  if (fs.existsSync(taskFile)) fs.unlinkSync(taskFile);
  if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
}

// ─── Task Matching ──────────────────────────────────────────────────

function matchTaskToAgent(task, agents) {
  const agentTag = task.agent || '';

  // Map Notion Agent tags to worktree directory names
  const AGENT_MAP = {
    '🔧 Backend': 'backend',
    '🧪 QA': 'qa',
    '⚙️ DevOps': 'devops',
    '🔒 Security': 'flex',
    '♻️ Refactor': 'flex',
    '🏗️ Architect': 'backend',  // Architect tasks go to Backend for implementation
  };

  const targetDir = AGENT_MAP[agentTag];

  if (targetDir) {
    const match = agents.find(a => a.name === targetDir && !a.hasTask);
    if (match) return match;
  }

  // Fallback: any idle agent
  return agents.find(a => !a.hasTask) || null;
}

// ─── Commands ───────────────────────────────────────────────────────

async function cmdList() {
  console.log('\n📋 Tasks in "To Do" status:\n');
  const tasks = await fetchTasks('To Do');

  if (tasks.length === 0) {
    console.log('   No tasks in "To Do". Move tasks from Backlog first.');
    return;
  }

  for (const t of tasks) {
    const icon = t.priority.includes('Critical') ? '🔴' :
                 t.priority.includes('High') ? '🟠' :
                 t.priority.includes('Medium') ? '🟡' : '🟢';
    console.log(`  ${icon} ${t.title}`);
    console.log(`     ${t.description.substring(0, 80)}${t.description.length > 80 ? '...' : ''}`);
    console.log(`     Tags: ${t.tags.join(', ')} | ${t.phase} | ${t.month}`);
    console.log(`     ID: ${t.id}`);
    console.log('');
  }

  console.log(`Total: ${tasks.length} tasks ready for agents`);
}

async function cmdStatus() {
  console.log('\n🤖 Agent Status:\n');
  const agents = getAgents();

  if (agents.length === 0) {
    console.log('   No agents found. Run: ./scripts/setup-worktrees.sh');
    return;
  }

  for (const a of agents) {
    const icon = a.hasTask ? '⚡' : '💤';
    console.log(`  ${icon} ${a.name} (${a.branch})`);
    if (a.currentTask) {
      console.log(`     📌 Working on: ${a.currentTask.title}`);
      console.log(`     Priority: ${a.currentTask.priority}`);
    } else {
      console.log(`     Idle — ready for assignment`);
    }
    console.log('');
  }
}

async function cmdDispatch() {
  console.log('\n🚀 Dispatching tasks to idle agents...\n');

  const tasks = await fetchTasks('To Do');
  const agents = getAgents();
  const idleAgents = agents.filter(a => !a.hasTask);

  if (tasks.length === 0) {
    console.log('   ✅ No tasks in "To Do". Move tasks from Backlog in Notion.');
    return;
  }

  if (idleAgents.length === 0) {
    console.log('   ⚠️  No idle agents. All agents are working.');
    console.log('   Busy agents:');
    for (const a of agents.filter(a => a.hasTask)) {
      console.log(`     ⚡ ${a.name} → ${a.currentTask?.title}`);
    }
    return;
  }

  let assigned = 0;

  for (const task of tasks) {
    const agent = matchTaskToAgent(task, agents);
    if (!agent) {
      console.log(`   ⏭️  No suitable agent for: ${task.title}`);
      continue;
    }

    assignTaskToAgent(task, agent.name);
    agent.hasTask = true;

    try {
      await updateTaskStatus(task.id, 'In Progress');
    } catch (e) {
      console.log(`   ⚠️  Failed to update Notion: ${e.message}`);
    }

    const icon = task.priority.includes('Critical') ? '🔴' :
                 task.priority.includes('High') ? '🟠' : '🟡';
    console.log(`  ${icon} ${task.title}`);
    console.log(`     → Assigned to: ${agent.name}`);
    console.log(`     → Notion status: In Progress`);
    console.log('');

    assigned++;

    if (assigned >= idleAgents.length) break;

    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`\n✅ Dispatched ${assigned} tasks to agents`);
  console.log('\n📌 For each agent terminal, type:');
  console.log('   > Read .agent-prompt.md and execute the task described.');
  console.log('');
}

async function cmdAssign() {
  const taskId = process.argv[3];
  const agentDir = process.argv[4];

  if (!taskId || !agentDir) {
    console.error('Usage: node scripts/dispatch-tasks.js --assign <task-id> <agent-dir>');
    process.exit(1);
  }

  const resp = await notionFetch(`/pages/${taskId}`, 'GET');
  const task = {
    id: resp.id,
    title: resp.properties.Task?.title?.[0]?.plain_text || 'Untitled',
    description: resp.properties.Description?.rich_text?.[0]?.plain_text || '',
    priority: resp.properties.Priority?.select?.name || 'Medium',
    phase: resp.properties.Phase?.select?.name || '',
    tags: (resp.properties.Tags?.multi_select || []).map(t => t.name),
    month: resp.properties.Month?.select?.name || '',
  };

  const { promptFile } = assignTaskToAgent(task, agentDir);
  await updateTaskStatus(taskId, 'In Progress');

  console.log(`\n✅ Assigned "${task.title}" to ${agentDir}`);
  console.log(`   Prompt: ${promptFile}`);
  console.log(`   Notion: Status → In Progress`);
  console.log(`\n   In the agent terminal, type:`);
  console.log(`   > Read .agent-prompt.md and execute the task described.`);
}

async function cmdDone() {
  const agentDir = process.argv[3];
  if (!agentDir) {
    console.error('Usage: node scripts/dispatch-tasks.js --done <agent-dir>');
    process.exit(1);
  }

  const taskFile = path.join(WORKTREE_BASE, agentDir, '.agent-task.json');
  if (!fs.existsSync(taskFile)) {
    console.log(`   No task assigned to ${agentDir}`);
    return;
  }

  const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));

  // Update Notion to "Review"
  try {
    await updateTaskStatus(task.id, 'Review');
    console.log(`   ✅ "${task.title}" → Review in Notion`);
  } catch (e) {
    console.log(`   ⚠️  Failed to update Notion: ${e.message}`);
  }

  // Clear task files
  clearAgentTask(agentDir);
  console.log(`   🧹 Cleared task from ${agentDir}`);
  console.log(`\n   Agent is now idle and ready for next task.`);
  console.log(`   Run: node scripts/dispatch-tasks.js to assign next task.`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2] || '';

  switch (command) {
    case '--list':
      await cmdList();
      break;
    case '--status':
      await cmdStatus();
      break;
    case '--assign':
      await cmdAssign();
      break;
    case '--done':
      await cmdDone();
      break;
    default:
      await cmdDispatch();
      break;
  }
}

main().catch(e => {
  console.error(`\n❌ Error: ${e.message}`);
  process.exit(1);
});

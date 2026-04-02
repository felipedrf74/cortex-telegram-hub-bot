#!/usr/bin/env node
/**
 * Nexus Hub — Agent Self-Chain Script
 * 
 * Called by agents when they finish a task. Handles the entire handoff:
 * 1. Updates Notion card → Review (or QA Validating)
 * 2. Writes QA validation prompt if the task needs QA
 * 3. Fetches next task for this agent
 * 4. Writes next .agent-prompt.md so the agent continues automatically
 * 
 * Usage (called from agent worktree):
 *   NOTION_TOKEN=ntn_xxx node scripts/agent-complete.js --agent backend --summary "Built NexusSkill interface..."
 *   NOTION_TOKEN=ntn_xxx node scripts/agent-complete.js --agent qa --verdict pass
 *   NOTION_TOKEN=ntn_xxx node scripts/agent-complete.js --agent qa --verdict fail --reason "Missing error handling"
 */

const NOTION_DB_ID = '332ad49d-23e7-81aa-831e-d5a3ceff20c1';
const WORKTREE_BASE = require('path').resolve(__dirname, '../../nexushub-worktrees');
const fs = require('fs');
const path = require('path');

// Read NOTION_TOKEN from env or .env.agents fallback (checks multiple locations)
let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
if (!NOTION_TOKEN) {
  const searchPaths = [
    path.join(__dirname, '..', '.env.agents'),           // Main repo
    path.join(process.cwd(), '.env.agents'),              // Current worktree (symlinked)
    path.join(WORKTREE_BASE, '..', 'cortex-telegram-hub-bot', '.env.agents'), // Relative to worktrees
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
  console.error('❌ NOTION_TOKEN required. Set env var or create .env.agents');
  process.exit(1);
}

// ─── Telegram Notification ──────────────────────────────────────────
let TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
if (!TG_TOKEN) {
  const searchPaths = [
    path.join(__dirname, '..', '.env.agents'),
    path.join(process.cwd(), '.env.agents'),
  ];
  for (const p of searchPaths) {
    try {
      const f = fs.readFileSync(p, 'utf8');
      const t = f.match(/TELEGRAM_BOT_TOKEN=(.+)/);
      const c = f.match(/TELEGRAM_CHAT_ID=(.+)/);
      if (t) TG_TOKEN = t[1].trim();
      if (c) TG_CHAT_ID = c[1].trim();
      if (TG_TOKEN) break;
    } catch {}
  }
}

async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) { console.log(`  ⚠️ Telegram notify failed: ${e.message}`); }
}

// ─── Parse args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const agentDir = getArg('agent');     // backend, qa, devops, flex
const verdict = getArg('verdict');     // pass, fail (QA only)
const failReason = getArg('reason');   // why QA failed it
const summary = getArg('summary');     // review summary text

if (!agentDir) {
  console.error('Usage: node scripts/agent-complete.js --agent <backend|qa|devops|flex> [--summary "..."] [--verdict pass|fail] [--reason "..."]');
  process.exit(1);
}

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
  return resp.json();
}

async function updateTaskStatus(taskId, status) {
  await notionFetch(`/pages/${taskId}`, 'PATCH', {
    properties: { 'Status': { select: { name: status } } },
  });
}

async function fetchToDoTasks() {
  const data = await notionFetch(`/databases/${NOTION_DB_ID}/query`, 'POST', {
    filter: { property: 'Status', select: { equals: 'To Do' } },
    sorts: [
      { property: 'Priority', direction: 'ascending' },
      { property: 'Month', direction: 'ascending' },
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
    agent: page.properties.Agent?.select?.name || '',
  }));
}

// ─── Agent→Worktree mapping ─────────────────────────────────────────
const AGENT_MAP = {
  '🔧 Backend': 'backend',
  '🧪 QA': 'qa',
  '⚙️ DevOps': 'devops',
  '🔒 Security': 'flex',
  '♻️ Refactor': 'flex',
  '🏗️ Architect': 'backend',
  '🎨 Frontend': 'frontend',
  '🧪 QA2': 'qa2',
};

// Tasks that need QA validation (feature code changes)
// ALL agents go through QA — no exceptions
const NEEDS_QA = [
  '🔧 Backend', '♻️ Refactor', '🏗️ Architect', '🎨 Frontend',
  '⚙️ DevOps', '🔒 Security',
  // Worktree name aliases (safety net)
  'backend', 'flex', 'frontend', 'devops',
];

// ─── QA Routing — which QA agent validates which origin agent ───────
const QA_ROUTING = {
  'backend': 'qa', 'frontend': 'qa',      // QA-1 validates code-heavy agents
  'devops': 'qa2', 'flex': 'qa2',          // QA-2 validates infra/config agents
};
function getQAAgent(originAgent) {
  return QA_ROUTING[originAgent] || 'qa'; // default to qa
}

// ─── QA Queue System ────────────────────────────────────────────────
// Dynamic QA queue — each QA agent has its own queue
function getQAQueueDir(qaAgent) {
  return path.join(WORKTREE_BASE, qaAgent || 'qa', '.qa-queue');
}
// Legacy constant for backward compat (used when QA agent reads its OWN queue)
const QA_QUEUE_DIR = path.join(WORKTREE_BASE, agentDir, '.qa-queue');

function ensureQAQueue() {
  if (!fs.existsSync(QA_QUEUE_DIR)) fs.mkdirSync(QA_QUEUE_DIR, { recursive: true });
}

function getQueuedTasks() {
  ensureQAQueue();
  return fs.readdirSync(QA_QUEUE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(QA_QUEUE_DIR, f), 'utf8')));
}

function nextQueueNumber() {
  ensureQAQueue();
  const files = fs.readdirSync(QA_QUEUE_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) return '001';
  const last = parseInt(files[files.length - 1].replace('.json', ''), 10);
  return String(last + 1).padStart(3, '0');
}

function writeQAPromptFromTask(task, originAgent) {
  const targetQA = getQAAgent(originAgent);
  const qaPath = path.join(WORKTREE_BASE, targetQA);
  const repoEsc = '~/Desktop/Custom\\\\ Connectors/Cortex/cortex-telegram-hub-bot';
  const prompt = `# 🧪 QA Validation Task

## Validating: ${task.title}
**Original agent:** ${originAgent}
**Priority:** ${task.priority}
**Phase:** ${task.phase}

## Description
${task.description}

## Your job
1. Pull the latest code: \`git fetch origin && git merge origin/agent/${originAgent} --no-edit\`
2. Read the changed files and understand what was built
3. Run: \`npx vitest run\` and \`npx tsc --noEmit\`
4. Write validation tests for the new code
5. Check acceptance criteria from the description
6. Look for: missing error handling, untested edge cases, type safety

## Auto-chain (MANDATORY — do this immediately after validating)
### If everything passes:
\`\`\`bash
AGENT_DIR=$(basename "$(pwd)")
node ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --verdict pass
\`\`\`
### If something fails:
\`\`\`bash
AGENT_DIR=$(basename "$(pwd)")
node ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --verdict fail --reason "what failed"
\`\`\`
Then immediately check for the next queued validation:
\`\`\`bash
cat .agent-prompt.md 2>/dev/null
\`\`\`
If a new .agent-prompt.md exists, read and execute it. Do NOT stop.

## Queue info
${getQueuedTasks().length} task(s) in QA queue. After this validation, the next one loads automatically.

## Notion Task ID
${task.id}

## Rules
- You are VALIDATING, not building features
- If tests fail, report what failed — don't fix the feature code
- Push your test additions: \`git push origin $(git branch --show-current)\`
- Always call agent-complete.js — this moves the card and loads the next task
`;
  fs.writeFileSync(path.join(qaPath, '.agent-prompt.md'), prompt);
  fs.writeFileSync(path.join(qaPath, '.agent-task.json'), JSON.stringify({
    id: task.id, title: task.title, description: task.description,
    priority: task.priority, phase: task.phase, tags: task.tags || [],
    agent: '🧪 QA', originAgent,
  }, null, 2));
}

function writeQAPrompt(task, originAgent) {
  const targetQA = getQAAgent(originAgent);
  const targetQueueDir = getQAQueueDir(targetQA);
  if (!fs.existsSync(targetQueueDir)) fs.mkdirSync(targetQueueDir, { recursive: true });

  const qaPath = path.join(WORKTREE_BASE, targetQA);
  const qaTaskFile = path.join(qaPath, '.agent-task.json');
  const qaBusy = fs.existsSync(qaTaskFile);

  // Add to the correct QA agent's queue
  const files = fs.readdirSync(targetQueueDir).filter(f => f.endsWith('.json')).sort();
  const nextNum = files.length === 0 ? '001' : String(parseInt(files[files.length - 1].replace('.json', ''), 10) + 1).padStart(3, '0');
  const queueFile = path.join(targetQueueDir, `${nextNum}.json`);
  fs.writeFileSync(queueFile, JSON.stringify({
    id: task.id, title: task.title, description: task.description,
    priority: task.priority, phase: task.phase, tags: task.tags || [],
    originAgent, targetQA, queuedAt: new Date().toISOString(),
  }, null, 2));

  if (qaBusy) {
    console.log(`  📥 ${targetQA} is busy — task queued`);
  } else {
    writeQAPromptFromTask(task, originAgent);
    console.log(`  📋 ${targetQA} prompt written → ${targetQA}/.agent-prompt.md`);
  }
}

// ─── Write next task prompt for an agent ─────────────────────────────
function writeAgentPrompt(task, agentDir) {
  const agentPath = path.join(WORKTREE_BASE, agentDir);
  const roleMap = {
    backend: { emoji: '🔧', name: 'Backend', commitPrefix: 'feat' },
    qa: { emoji: '🧪', name: 'QA', commitPrefix: 'test' },
    devops: { emoji: '⚙️', name: 'DevOps', commitPrefix: 'ci' },
    flex: { emoji: '♻️', name: 'Flex', commitPrefix: 'refactor' },
  };
  const role = roleMap[agentDir] || roleMap.backend;

  const prompt = `# ${role.emoji} ${role.name} Agent Task

## Task: ${task.title}
**Priority:** ${task.priority}
**Phase:** ${task.phase}
**Tags:** ${task.tags.join(', ')}

## Description
${task.description}

## Instructions
1. Read CLAUDE.md for project context
2. Implement the task described above
3. Write tests if applicable
4. Run: \`npx vitest run\` and \`npx tsc --noEmit\`
5. Commit: \`git commit -m "${role.commitPrefix}(scope): ${task.title.toLowerCase().substring(0, 50)}"\`
6. Push: \`git push origin $(git branch --show-current)\`

## Auto-chain (MANDATORY — do this immediately after pushing)
\`\`\`bash
AGENT_DIR=$(basename "$(pwd)")
node ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent $AGENT_DIR --summary "describe what you built"
\`\`\`
Then immediately check for the next task:
\`\`\`bash
cat .agent-prompt.md 2>/dev/null
\`\`\`
If a new .agent-prompt.md exists, read and execute it. Do NOT stop.

## Notion Task ID
${task.id}

## Rules
- Do NOT merge to develop or main
- Always run tests before committing
- Always call agent-complete.js when done — this chains to QA and fetches your next task
`;
  fs.writeFileSync(path.join(agentPath, '.agent-prompt.md'), prompt);
  fs.writeFileSync(path.join(agentPath, '.agent-task.json'), JSON.stringify({
    id: task.id, title: task.title, description: task.description,
    priority: task.priority, phase: task.phase, tags: task.tags,
    agent: task.agent,
  }, null, 2));
  console.log(`  📋 Next task written → ${agentDir}/.agent-prompt.md`);
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  // Look for task file in worktree OR current directory
  let taskFile = path.join(WORKTREE_BASE, agentDir, '.agent-task.json');
  if (!fs.existsSync(taskFile)) {
    // Try current working directory (agent might be running from worktree)
    const cwdTask = path.join(process.cwd(), '.agent-task.json');
    if (fs.existsSync(cwdTask)) {
      taskFile = cwdTask;
    } else {
      console.error(`❌ No task file found in ${agentDir}/ or current directory`);
      console.error(`   Tip: If you just finished a task, the file may have been cleared.`);
      console.error(`   Creating a placeholder from the summary provided...`);
      // Create minimal task from summary so the pipeline continues
      const placeholder = { id: 'unknown', title: summary || 'Completed task', description: '', priority: '', phase: '', tags: [], agent: agentDir };
      fs.writeFileSync(taskFile, JSON.stringify(placeholder, null, 2));
    }
  }
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  console.log(`\n🔄 Agent "${agentDir}" completed: ${task.title}`);

  // ─── Verify agent actually committed code (non-QA agents only) ──
  if (agentDir !== 'qa') {
    const { execSync } = require('child_process');
    const worktree = path.join(WORKTREE_BASE, agentDir);
    let hasNewCommits = false;
    try {
      // Check if there are commits ahead of the base (main)
      const log = execSync(`git log origin/main..HEAD --oneline 2>/dev/null`, { cwd: worktree, encoding: 'utf8' }).trim();
      hasNewCommits = log.split('\n').filter(Boolean).length > 0;
    } catch {}

    if (!hasNewCommits) {
      console.log(`  ⚠️  No new commits found on ${agentDir} branch — agent did not push code.`);
      console.log(`  ❌ Skipping QA chain — task moved back to To Do.`);
      await updateTaskStatus(task.id, 'To Do');
      await notify(`⚠️ <b>${agentDir}</b> completed without code changes\n<i>${task.title}</i>\n→ Moved back to To Do (no commits found)`);
      // Clear task files
      try { fs.unlinkSync(path.join(WORKTREE_BASE, agentDir, '.agent-task.json')); } catch {}
      try { fs.unlinkSync(path.join(WORKTREE_BASE, agentDir, '.agent-prompt.md')); } catch {}
      // Still try to fetch next task
      const tasks = await fetchToDoTasks();
      const myTasks = tasks.filter(t => { const target = AGENT_MAP[t.agent]; return target === agentDir; });
      if (myTasks.length > 0) {
        const next = myTasks[0];
        await updateTaskStatus(next.id, 'In Progress');
        writeAgentPrompt(next, agentDir);
        await notify(`📋 <b>${agentDir}</b> auto-picked next task\n<i>${next.title}</i>`);
      }
      return;
    }
    console.log(`  ✅ Verified: ${agentDir} has new commits`);

    // Also verify agent pushed to remote
    try {
      const unpushed = execSync(`git log origin/agent/${agentDir}..HEAD --oneline 2>/dev/null`, { cwd: worktree, encoding: 'utf8' }).trim();
      if (unpushed) {
        console.log(`  📤 Pushing unpushed commits...`);
        execSync(`git push origin agent/${agentDir} 2>&1`, { cwd: worktree, encoding: 'utf8' });
        console.log(`  ✅ Pushed to origin/agent/${agentDir}`);
      }
    } catch (e) { console.log(`  ⚠️  Push check/attempt: ${e.message}`); }
  }

  // ─── QA agent finishing a validation ─────────────────────────────
  if (agentDir === 'qa' && verdict) {
    // Remove completed task from queue
    ensureQAQueue();
    const queueFiles = fs.readdirSync(QA_QUEUE_DIR).filter(f => f.endsWith('.json')).sort();
    const matchFile = queueFiles.find(f => {
      try {
        const q = JSON.parse(fs.readFileSync(path.join(QA_QUEUE_DIR, f), 'utf8'));
        return q.id === task.id;
      } catch { return false; }
    });
    if (matchFile) {
      fs.unlinkSync(path.join(QA_QUEUE_DIR, matchFile));
      console.log(`  🗑️  Removed from QA queue: ${matchFile}`);
    }

    if (verdict === 'pass') {
      console.log(`  ✅ QA PASSED → moving to Done`);
      await updateTaskStatus(task.id, 'Done');
      console.log(`  🎉 Task "${task.title}" is DONE — ready for Felipe to merge + deploy`);
      await notify(`✅ <b>QA passed</b>\n<i>${task.title}</i>\n→ Moved to Done. Ready for merge + deploy.`);
    } else {
      console.log(`  ❌ QA FAILED → sending back to original agent`);
      console.log(`  Reason: ${failReason || 'not specified'}`);
      await updateTaskStatus(task.id, 'In Progress');
      await notify(`❌ <b>QA failed</b>\n<i>${task.title}</i>\nReason: ${failReason || 'not specified'}\n→ Sent back to ${task.originAgent || 'backend'}`);
      const originAgent = task.originAgent || 'backend';
      const repoEsc = '~/Desktop/Custom\\\\ Connectors/Cortex/cortex-telegram-hub-bot';
      const fixPrompt = `# 🔧 Fix Required — QA Failed\n\n## Task: ${task.title}\n## QA Failure Reason: ${failReason || 'See QA notes'}\n\n## Instructions\n1. Read the QA failure reason above\n2. Fix the issues identified\n3. Run tests: \`npx vitest run\` and \`npx tsc --noEmit\`\n4. Commit: \`git commit -m "fix(scope): address QA feedback"\`\n5. Push: \`git push origin $(git branch --show-current)\`\n\n## Auto-chain (MANDATORY)\n\`\`\`bash\nAGENT_DIR=$(basename "$(pwd)")\nnode ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --summary "fixed QA issues"\n\`\`\`\nThen check for next task: \`cat .agent-prompt.md 2>/dev/null\`\n`;
      fs.writeFileSync(path.join(WORKTREE_BASE, originAgent, '.agent-prompt.md'), fixPrompt);
      fs.writeFileSync(path.join(WORKTREE_BASE, originAgent, '.agent-task.json'), JSON.stringify({
        id: task.id, title: task.title, description: `FIX: ${failReason || 'QA issues'}`,
        priority: task.priority, phase: task.phase, tags: task.tags || [],
        agent: task.agent || task.originAgent, originAgent,
      }, null, 2));
      console.log(`  📋 Fix prompt + task file written → ${originAgent}/`);
    }

    // Check queue for next QA task
    const remaining = getQueuedTasks();
    if (remaining.length > 0) {
      const next = remaining[0];
      console.log(`\n  📥 QA queue has ${remaining.length} more task(s)`);
      console.log(`  ✅ Loading next: "${next.title}"`);
      await updateTaskStatus(next.id, 'QA Validating');
      writeQAPromptFromTask(next, next.originAgent);
      console.log(`\n  👉 QA agent: read .agent-prompt.md and continue validating`);
    } else {
      // Clear QA files — agent is idle
      const qaPath = path.join(WORKTREE_BASE, 'qa');
      try { fs.unlinkSync(path.join(qaPath, '.agent-task.json')); } catch {}
      try { fs.unlinkSync(path.join(qaPath, '.agent-prompt.md')); } catch {}
      console.log(`  💤 QA queue empty — agent is idle`);
    }
    return;
  }

  // ─── Non-QA agent finishing a task ───────────────────────────────
  const agentTag = task.agent || '';
  const needsQA = NEEDS_QA.includes(agentTag);

  if (needsQA) {
    // Move to Review → trigger QA
    console.log(`  📤 Moving to Review → triggering QA validation`);
    await updateTaskStatus(task.id, 'QA Validating');
    writeQAPrompt(task, agentDir);
    console.log(`  🧪 QA agent should pick up validation automatically`);
    await notify(`🔄 <b>${agentDir}</b> finished\n<i>${task.title}</i>\n→ Sent to QA validation`);
  } else {
    // Safety fallback: if somehow not in NEEDS_QA, still route to QA
    console.log(`  ⚠️ Agent tag "${agentTag}" not in NEEDS_QA — routing to QA anyway`);
    await updateTaskStatus(task.id, 'QA Validating');
    writeQAPrompt(task, agentDir);
    await notify(`🔄 <b>${agentDir}</b> finished\n<i>${task.title}</i>\n→ Sent to QA validation (fallback)`);
  }

  // ─── Fetch next task for this agent ──────────────────────────────
  console.log(`\n🔍 Looking for next task for ${agentDir}...`);
  const tasks = await fetchToDoTasks();
  const myTasks = tasks.filter(t => {
    const target = AGENT_MAP[t.agent];
    return target === agentDir;
  });

  if (myTasks.length > 0) {
    const next = myTasks[0];
    console.log(`  ✅ Next task: "${next.title}"`);
    await updateTaskStatus(next.id, 'In Progress');
    writeAgentPrompt(next, agentDir);
    console.log(`\n  👉 Agent: read .agent-prompt.md and continue working`);
    await notify(`📋 <b>${agentDir}</b> auto-picked next task\n<i>${next.title}</i>`);
  } else {
    // Clear task files — agent is idle
    const agentPath = path.join(WORKTREE_BASE, agentDir);
    try { fs.unlinkSync(path.join(agentPath, '.agent-task.json')); } catch {}
    try { fs.unlinkSync(path.join(agentPath, '.agent-prompt.md')); } catch {}
    console.log(`  💤 No more tasks for ${agentDir} — agent is idle`);
    // No idle notification — too spammy. Felipe sees it in Mission Control if needed.
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

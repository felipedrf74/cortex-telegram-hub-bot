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

// Read NOTION_TOKEN from env or .env.agents fallback
let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
if (!NOTION_TOKEN) {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '..', '.env.agents'), 'utf8');
    const match = envFile.match(/NOTION_TOKEN=(.+)/);
    if (match) NOTION_TOKEN = match[1].trim();
  } catch {}
}
if (!NOTION_TOKEN) {
  console.error('❌ NOTION_TOKEN required. Set env var or create .env.agents');
  process.exit(1);
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
};

// Tasks that need QA validation (feature code changes)
const NEEDS_QA = ['🔧 Backend', '♻️ Refactor', '🏗️ Architect'];

// ─── Write QA validation prompt ─────────────────────────────────────
function writeQAPrompt(task, originAgent) {
  const qaPath = path.join(WORKTREE_BASE, 'qa');
  const prompt = `# 🧪 QA Validation Task

## Validating: ${task.title}
**Original agent:** ${originAgent}
**Priority:** ${task.priority}
**Phase:** ${task.phase}

## Description
${task.description}

## Your job
1. Pull the latest code from the ${originAgent} agent's branch:
   \`git fetch origin && git merge origin/agent/${originAgent} --no-edit\`
2. Read the changed files and understand what was built
3. Run the test suite: \`npx vitest run\`
4. Run type check: \`npx tsc --noEmit\`
5. Write integration/validation tests for the new code
6. Check acceptance criteria from the task description
7. Look for: missing error handling, untested edge cases, type safety issues

## When done, run ONE of these:
### If everything passes:
\`\`\`bash
node ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent qa --verdict pass
\`\`\`
### If something fails:
\`\`\`bash
node ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent qa --verdict fail --reason "describe what failed"
\`\`\`

## Notion Task ID
${task.id}

## Rules
- You are VALIDATING, not building features
- If tests fail, report what failed — don't fix the feature code
- Write tests that prove the feature works correctly
- Push your test additions: \`git push origin $(git branch --show-current)\`
`;
  fs.writeFileSync(path.join(qaPath, '.agent-prompt.md'), prompt);
  fs.writeFileSync(path.join(qaPath, '.agent-task.json'), JSON.stringify({
    id: task.id, title: task.title, description: task.description,
    priority: task.priority, phase: task.phase, tags: task.tags,
    agent: '🧪 QA', originAgent,
  }, null, 2));
  console.log(`  📋 QA prompt written → qa/.agent-prompt.md`);
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
7. When done, run:
\`\`\`bash
node ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent ${agentDir} --summary "brief description of what you did"
\`\`\`

## Notion Task ID
${task.id}

## Rules
- Do NOT merge to develop or main
- After completing, run the agent-complete.js command above — it handles everything
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

  // ─── QA agent finishing a validation ─────────────────────────────
  if (agentDir === 'qa' && verdict) {
    if (verdict === 'pass') {
      console.log(`  ✅ QA PASSED → moving to Done`);
      await updateTaskStatus(task.id, 'Done');
      // Clear QA files
      fs.unlinkSync(path.join(WORKTREE_BASE, 'qa', '.agent-task.json'));
      fs.unlinkSync(path.join(WORKTREE_BASE, 'qa', '.agent-prompt.md'));
      console.log(`  🎉 Task "${task.title}" is DONE — ready for Felipe to merge + deploy`);
      console.log(`  📢 Felipe: merge agent branches to develop, then nexus-deploy`);
    } else {
      console.log(`  ❌ QA FAILED → sending back to original agent`);
      console.log(`  Reason: ${failReason || 'not specified'}`);
      await updateTaskStatus(task.id, 'In Progress');
      // Write fix prompt for the original agent
      const originAgent = task.originAgent || 'backend';
      const fixPrompt = `# 🔧 Fix Required — QA Failed

## Task: ${task.title}
## QA Failure Reason: ${failReason || 'See QA notes'}

## Instructions
1. Read the QA failure reason above
2. Fix the issues identified
3. Run tests: \`npx vitest run\`
4. Commit the fix: \`git commit -m "fix(scope): address QA feedback for ${task.title.toLowerCase().substring(0, 40)}"\`
5. Push: \`git push origin $(git branch --show-current)\`
6. When done, run:
\`\`\`bash
node ~/Desktop/Custom\\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent ${originAgent} --summary "fixed QA issues"
\`\`\`
`;
      const originPath = path.join(WORKTREE_BASE, originAgent);
      fs.writeFileSync(path.join(originPath, '.agent-prompt.md'), fixPrompt);
      console.log(`  📋 Fix prompt written → ${originAgent}/.agent-prompt.md`);
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
  } else {
    // DevOps/infra tasks skip QA → go straight to Done
    console.log(`  ⚙️ Infrastructure task → skipping QA → Done`);
    await updateTaskStatus(task.id, 'Done');
    console.log(`  🎉 Task "${task.title}" is DONE`);
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
  } else {
    // Clear task files — agent is idle
    const agentPath = path.join(WORKTREE_BASE, agentDir);
    try { fs.unlinkSync(path.join(agentPath, '.agent-task.json')); } catch {}
    try { fs.unlinkSync(path.join(agentPath, '.agent-prompt.md')); } catch {}
    console.log(`  💤 No more tasks for ${agentDir} — agent is idle`);
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

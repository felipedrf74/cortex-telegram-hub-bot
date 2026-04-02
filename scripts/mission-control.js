#!/usr/bin/env node
/**
 * Nexus Hub — Mission Control Server v2
 * http://localhost:8200
 */
const http = require('http');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8200;
const REPO = path.resolve(__dirname, '..');
const WORKTREES = path.resolve(REPO, '../nexushub-worktrees');
const SCRIPT = p => path.join(REPO, 'scripts', p);

let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
if (!NOTION_TOKEN) {
  try {
    const f = fs.readFileSync(path.join(REPO, '.env.agents'), 'utf8');
    const m = f.match(/NOTION_TOKEN=(.+)/);
    if (m) NOTION_TOKEN = m[1].trim();
  } catch {}
}
const DB_ID = '332ad49d-23e7-81aa-831e-d5a3ceff20c1';
const QA_QUEUE_DIR = path.join(WORKTREES, 'qa', '.qa-queue');

// ─── Agent→Worktree mapping for auto-assign ────────────────────────
const AGENT_MAP = {
  '🔧 Backend': 'backend', '🧪 QA': 'qa', '⚙️ DevOps': 'devops',
  '🔒 Security': 'flex', '♻️ Refactor': 'flex', '🏗️ Architect': 'backend',
  '🎨 Frontend': 'frontend', '🧪 QA2': 'qa2',
};
// QA routing: which QA agent validates which agent's work
const QA_ROUTING = {
  'backend': 'qa', 'frontend': 'qa',      // QA-1 validates code-heavy agents
  'devops': 'qa2', 'flex': 'qa2',          // QA-2 validates infra/config agents
};

async function autoAssignAll() {
  const agents = agentStatus();
  const allTasks = await fetchTasks();
  const results = [];

  for (const a of agents) {
    // Stale task cleanup: if agent has a task file, check Notion status
    if (a.task && a.task.id) {
      const notionTask = allTasks.find(t => t.id === a.task.id);
      const staleStatuses = ['Done', 'Review', 'QA Validating'];
      // If task is done/review in Notion (or doesn't exist), clear the stale files
      if (!notionTask || (a.name !== 'qa' && a.name !== 'qa2' && staleStatuses.includes(notionTask.status)) || (notionTask.status === 'Done')) {
        try {
          fs.unlinkSync(path.join(WORKTREES, a.name, '.agent-task.json'));
          fs.unlinkSync(path.join(WORKTREES, a.name, '.agent-prompt.md'));
        } catch {}
        a.task = null; a.hasPrompt = false;
        results.push({ agent: a.name, action: 'cleared-stale', oldTask: notionTask?.title || a.task?.title || 'unknown' });
      }
    }

    // Skip agents that already have valid work
    if (a.task || a.hasPrompt) continue;

    // QA agent: check .qa-queue/ first
    if (a.name === 'qa') {
      try {
        if (fs.existsSync(QA_QUEUE_DIR)) {
          const queueFiles = fs.readdirSync(QA_QUEUE_DIR).filter(f => f.endsWith('.json')).sort();
          if (queueFiles.length > 0) {
            const next = JSON.parse(fs.readFileSync(path.join(QA_QUEUE_DIR, queueFiles[0]), 'utf8'));
            // Use agent-complete.js to properly write the QA prompt
            const r = await run(`node "${SCRIPT('agent-complete.js')}" --agent qa --check-only 2>&1 || true`);
            // Manually write QA task if agent-complete didn't
            const qaTaskFile = path.join(WORKTREES, 'qa', '.agent-task.json');
            if (!fs.existsSync(qaTaskFile)) {
              // Write task file from queue item
              fs.writeFileSync(qaTaskFile, JSON.stringify({
                id: next.id, title: next.title, description: next.description || '',
                priority: next.priority || '', phase: next.phase || '', tags: next.tags || [],
                agent: '🧪 QA', originAgent: next.originAgent || 'backend',
              }, null, 2));
              // Write prompt
              const prompt = `# 🧪 QA Validation Task\n\n## Validating: ${next.title}\n**Original agent:** ${next.originAgent || 'unknown'}\n**Priority:** ${next.priority || ''}\n\n## Description\n${next.description || ''}\n\n## Instructions\n1. Pull latest: \`git fetch origin && git merge origin/agent/${next.originAgent || 'backend'} --no-edit\`\n2. Read changed files\n3. Run: \`npx vitest run\` and \`npx tsc --noEmit\`\n4. Write validation tests\n5. Check acceptance criteria\n\n## Auto-chain (MANDATORY)\n\`\`\`bash\nAGENT_DIR=$(basename "$(pwd)")\nnode ~/Desktop/Custom\\\\ Connectors/Cortex/cortex-telegram-hub-bot/scripts/agent-complete.js --agent $AGENT_DIR --verdict pass\n\`\`\`\nOr if fails: add \`--verdict fail --reason "what failed"\`\n\n## Notion Task ID\n${next.id}\n`;
              fs.writeFileSync(path.join(WORKTREES, 'qa', '.agent-prompt.md'), prompt);
              // Update Notion
              try { await notionFetch(`/pages/${next.id}`, 'PATCH', {properties:{Status:{select:{name:'QA Validating'}}}}); } catch {}
              // Remove from queue
              fs.unlinkSync(path.join(QA_QUEUE_DIR, queueFiles[0]));
            }
            results.push({ agent: 'qa', task: next.title, source: 'qa-queue' });
            continue;
          }
        }
      } catch (e) { results.push({ agent: 'qa', error: e.message }); }
    }

    // All agents: check Notion for tasks needing dispatch ("To Do" or orphaned "In Progress")
    // ONLY dispatch if this specific agent is idle AND has a matching task
    if (!a.task && !a.hasPrompt) {
      try {
        const worktreeName = a.name;
        const matchingTags = Object.entries(AGENT_MAP).filter(([,v]) => v === worktreeName).map(([k]) => k);
        const assignableTasks = allTasks.filter(t =>
          matchingTags.includes(t.agent) && (t.status === 'To Do' || t.status === 'In Progress')
        );
        if (assignableTasks.length > 0) {
          const next = assignableTasks[0];
          if (next.status === 'In Progress') {
            await notionFetch(`/pages/${next.id}`, 'PATCH', {properties:{Status:{select:{name:'To Do'}}}});
          }
          // Dispatch ONLY this agent's tasks (--assign single task to specific agent)
          const r = await run(`node "${SCRIPT('dispatch-tasks.js')}" --assign ${next.id} ${worktreeName}`);
          results.push({ agent: worktreeName, task: next.title, source: 'notion-todo' });
        }
      } catch (e) { results.push({ agent: a.name, error: e.message }); }
    }
  }
  return results;
}

async function notionFetch(ep, method = 'POST', body = {}) {
  const r = await fetch(`https://api.notion.com/v1${ep}`, {
    method, headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function fetchTasks() {
  const all = [];
  for (const status of ['Backlog','To Do','In Progress','Review','QA Validating','Done']) {
    const d = await notionFetch(`/databases/${DB_ID}/query`, 'POST', {
      filter: { property: 'Status', select: { equals: status } },
      sorts: [{ property: 'Priority', direction: 'ascending' }],
    });
    for (const p of (d.results || [])) {
      all.push({
        id: p.id,
        title: p.properties.Task?.title?.[0]?.plain_text || 'Untitled',
        description: p.properties.Description?.rich_text?.[0]?.plain_text || '',
        priority: p.properties.Priority?.select?.name || '',
        agent: p.properties.Agent?.select?.name || '',
        status, phase: p.properties.Phase?.select?.name || '',
        month: p.properties.Month?.select?.name || '',
      });
    }
  }
  return all;
}

function run(cmd, cwd = REPO) {
  return new Promise(r => exec(cmd, { cwd, timeout: 120000, maxBuffer: 2*1024*1024, env: { ...process.env, NOTION_TOKEN } },
    (e, out, err) => r({ ok: !e, output: (out||'').trim() + (err ? '\n' + err.trim() : ''), code: e?.code })));
}

function agentStatus() {
  // Find all claude CLI processes and their working directories
  let claudeProcs = [];
  try {
    const psList = execSync(`ps aux | grep -E "^\\S+\\s+\\d+.*claude" | grep -v "Claude.app" | grep -v grep | grep -v mission-control | awk '{print $2}'`, { encoding: 'utf8' }).trim();
    const pids = psList.split('\n').filter(Boolean);
    for (const pid of pids) {
      try {
        const cwdLine = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd`, { encoding: 'utf8' }).trim();
        const cwdMatch = cwdLine.match(/\s(\/\S.*)$/);
        if (cwdMatch) claudeProcs.push({ pid, cwd: cwdMatch[1] });
      } catch {}
    }
  } catch {}

  return ['backend','qa','devops','flex','frontend','qa2'].map(name => {
    let task = null, hasPrompt = false, running = false, pid = null;
    try { task = JSON.parse(fs.readFileSync(path.join(WORKTREES, name, '.agent-task.json'), 'utf8')); } catch {}
    try { hasPrompt = fs.existsSync(path.join(WORKTREES, name, '.agent-prompt.md')); } catch {}
    
    // Check if any claude process is running in this worktree
    const worktreePath = path.join(WORKTREES, name);
    const match = claudeProcs.find(p => p.cwd === worktreePath);
    if (match) { running = true; pid = match.pid; }

    let status = 'offline';
    if (running) status = 'online';
    else if (task) status = 'has-task';
    else if (hasPrompt) status = 'has-prompt';
    
    // QA queue count (both qa and qa2 have queues)
    let queueCount = 0;
    if (name === 'qa' || name === 'qa2') {
      try {
        const qd = path.join(WORKTREES, name, '.qa-queue');
        if (fs.existsSync(qd)) queueCount = fs.readdirSync(qd).filter(f => f.endsWith('.json')).length;
      } catch {}
    }
    return { name, task, hasPrompt, running, pid, status, queueCount };
  });
}

function readBody(req) {
  return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d))}catch{r({})} }); });
}
function send(res, data, code=200) { res.writeHead(code, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }

async function handleAPI(req, res) {
  const route = new URL(req.url, 'http://localhost').pathname.replace('/api/','');
  try {
    if (route === 'board') return send(res, { ok: true, tasks: await fetchTasks() });
    if (route === 'agents') return send(res, { ok: true, agents: agentStatus() });
    if (route === 'move-task') { const b = await readBody(req); await notionFetch(`/pages/${b.id}`,'PATCH',{properties:{Status:{select:{name:b.status}}}}); return send(res, {ok:true,msg:`→ ${b.status}`}); }
    if (route === 'bulk-move') { const b = await readBody(req); for (const id of (b.ids||[])) await notionFetch(`/pages/${id}`,'PATCH',{properties:{Status:{select:{name:b.status}}}}); return send(res, {ok:true,msg:`Moved ${(b.ids||[]).length} → ${b.status}`}); }
    if (route === 'dispatch') return send(res, await run(`node "${SCRIPT('dispatch-tasks.js')}"`));
    if (route === 'auto-assign') { const results = await autoAssignAll(); return send(res, { ok: true, assigned: results, msg: results.length ? `Auto-assigned ${results.length} agent(s)` : 'All agents busy or no tasks' }); }
    if (route === 'clear-stale') { await run(`rm -f "${WORKTREES}"/*/.agent-task.json "${WORKTREES}"/*/.agent-prompt.md`); return send(res, {ok:true,output:'Stale files cleared'}); }
    if (route === 'agent-done') { const b = await readBody(req); return send(res, await run(`node "${SCRIPT('agent-complete.js')}" --agent ${b.agent} --summary "${(b.summary||'done').replace(/"/g,'\\\\"')}"`)); }
    if (route === 'merge-develop') return send(res, await run('git fetch origin && git checkout develop && git pull origin develop && git merge origin/agent/backend --no-edit 2>/dev/null; git merge origin/agent/qa --no-edit 2>/dev/null; git merge origin/agent/devops --no-edit 2>/dev/null; git merge origin/agent/flex --no-edit 2>/dev/null; git merge origin/agent/frontend --no-edit 2>/dev/null; git merge origin/agent/qa2 --no-edit 2>/dev/null; npx vitest run 2>&1 | tail -5 && git push origin develop && git checkout main'));
    if (route === 'merge-main') return send(res, await run('git fetch origin && git checkout main && git pull origin main && git merge origin/develop --no-edit && npx vitest run 2>&1 | tail -5 && git-cliff --output CHANGELOG.md && git add CHANGELOG.md && git diff --cached --quiet CHANGELOG.md 2>/dev/null || git commit -m "docs: update changelog [skip ci]" && git push origin main && echo "\\n📝 CHANGELOG.md updated"'));
    if (route === 'deploy') return send(res, await run(`./scripts/deploy.sh`));
    if (route === 'git-status') return send(res, await run('git fetch --all 2>/dev/null; echo "=== Branch ===" && git branch --show-current && echo "=== Status ===" && git status --short && echo "=== Recent ===" && git log --oneline -8'));
    if (route === 'run-tests') return send(res, await run('npx vitest run 2>&1 | tail -40'));
    if (route === 'typecheck') return send(res, await run('npx tsc --noEmit 2>&1 | tail -25'));
    if (route === 'agent-log') { const b = await readBody(req); try { const f = path.join(WORKTREES, b.agent, '.agent-prompt.md'); const t = path.join(WORKTREES, b.agent, '.agent-task.json'); let out = ''; if(fs.existsSync(t)) out += '=== Task ===\n'+fs.readFileSync(t,'utf8')+'\n'; if(fs.existsSync(f)) out += '=== Prompt ===\n'+fs.readFileSync(f,'utf8'); return send(res, {ok:true,output:out||'No task files found'}); } catch(e) { return send(res,{ok:false,output:e.message}); } }
    if (route === 'qa-queue') {
      const queueDir = path.join(WORKTREES, 'qa', '.qa-queue');
      let items = [];
      try {
        items = fs.readdirSync(queueDir).filter(f => f.endsWith('.json')).sort()
          .map(f => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8')));
      } catch {}
      return send(res, { ok: true, queue: items, count: items.length });
    }
    if (route === 'start-agent') {
      const b = await readBody(req);
      const launcher = path.join(REPO, 'scripts/launch-agent.sh').replace(/ /g, '\\\\ ');
      const script = `tell application "iTerm"
activate
tell current window
create tab with default profile
tell current session of current tab
write text "${launcher} ${b.agent}"
end tell
end tell
end tell`;
      await run(`osascript -e '${script.replace(/'/g,"'\\''")}'`);
      return send(res, {ok:true,output:`Agent ${b.agent} launched in new iTerm tab`});
    }
    if (route === 'send-to-agent') {
      const b = await readBody(req);
      const msg = (b.message || '').replace(/'/g, "'\\''").replace(/"/g, '\\"');
      const script = `tell application "iTerm"
tell current window
repeat with t in tabs
repeat with s in sessions of t
if name of s contains "${b.agent}" or (exists variable named "currentCommand" of s) then
write text "${msg}" in s
return "sent"
end if
end repeat
end repeat
end tell
end tell`;
      const r2 = await run(`osascript -e '${script.replace(/'/g,"'\\''")}'`);
      return send(res, {ok:r2.ok,output:r2.output || `Message sent to ${b.agent}`});
    }
    if (route === 'start-task') {
      const b = await readBody(req);
      const promptFile = path.join(WORKTREES, b.agent, '.agent-prompt.md');
      if (!fs.existsSync(promptFile)) return send(res, {ok:false,output:`No .agent-prompt.md found for ${b.agent}. Dispatch tasks first.`});
      const launcher = path.join(REPO, 'scripts/launch-agent.sh').replace(/ /g, '\\\\ ');
      const script = `tell application "iTerm"
activate
tell current window
create tab with default profile
tell current session of current tab
write text "${launcher} ${b.agent}"
end tell
end tell
end tell`;
      await run(`osascript -e '${script.replace(/'/g,"'\\''")}'`);
      return send(res, {ok:true,output:`Agent ${b.agent} started with task: ${fs.existsSync(path.join(WORKTREES, b.agent, '.agent-task.json')) ? JSON.parse(fs.readFileSync(path.join(WORKTREES, b.agent, '.agent-task.json'),'utf8')).title : 'unknown'}`});
    }
    if (route === 'stop-agent') {
      const b = await readBody(req);
      const agents = agentStatus();
      const ag = agents.find(a => a.name === b.agent);
      if (ag && ag.pid) {
        await run(`kill -TERM ${ag.pid} 2>/dev/null; sleep 0.3; kill -9 ${ag.pid} 2>/dev/null; true`);
      }
      await run(`pkill -f "worktrees/${b.agent}" 2>/dev/null; pkill -f "launch-agent.sh ${b.agent}" 2>/dev/null; true`);
      return send(res, {ok:true, output:`Agent ${b.agent} stopped${ag?.pid ? ` (killed PID ${ag.pid})` : ' (no PID, used pkill)'}`});
    }
    if (route === 'view-terminal') {
      const b = await readBody(req);
      let tty = '';
      try { tty = execSync(`ps -p $(pgrep -f "worktrees/${b.agent}" | head -1) -o tty= 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch {}
      const searchTerm = tty || b.agent;
      const matchBy = tty ? `tty of s contains "${tty}"` : `name of s contains "${b.agent}" or name of s contains "launch-agent"`;
      const script = `tell application "iTerm"
activate
tell current window
repeat with t in tabs
repeat with s in sessions of t
if ${matchBy} then
select t
return "focused"
end if
end repeat
end repeat
end tell
end tell
return "not found"`;
      const r2 = await run(`osascript -e '${script.replace(/'/g,"'\\''")}'`);
      return send(res, {ok:r2.ok,output:r2.output.includes('focused') ? `Switched to ${b.agent} terminal` : `No terminal found for ${b.agent}. Start the agent first.`});
    }
    if (route === 'write-prompt') { const b = await readBody(req); fs.writeFileSync(path.join(WORKTREES,b.agent,'.agent-prompt.md'), b.prompt); return send(res, {ok:true,output:`Prompt written to ${b.agent}/.agent-prompt.md`}); }
    if (route === 'rollback') return send(res, await run('./scripts/rollback.sh latest'));
    if (route === 'server-status') return send(res, await run('ssh dominguez@serverdominguez "pm2 list" 2>&1 || echo "Cannot reach server"'));
    if (route === 'dispatch-single') {
      const b = await readBody(req);
      if (!b.taskId) return send(res, {ok:false, output:'taskId required'}, 400);
      const agArg = b.agent ? `--agent ${b.agent}` : '';
      return send(res, await run(`node "${SCRIPT('dispatch-task.js')}" --task ${b.taskId.trim()} ${agArg}`));
    }
    if (route === 'list-todo') {
      const tasks = await fetchTasks();
      return send(res, { ok: true, tasks: tasks.filter(t => t.status === 'To Do' || t.status === 'Backlog') });
    }
    if (route === 'agent-branches') { const b = await readBody(req); return send(res, await run(`git log origin/agent/${b.agent||'backend'} --oneline -10 2>/dev/null || echo 'No branch found'`)); }
    if (route === 'sync-server') return send(res, await run('./scripts/sync-from-server.sh --dry-run 2>&1'));
    return send(res, {ok:false,error:'Unknown route'}, 404);
  } catch(e) { return send(res, {ok:false,error:e.message}, 500); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
  if (req.url.startsWith('/api/')) return handleAPI(req, res);
  res.writeHead(200, {'Content-Type':'text/html'});
  res.end(PAGE + PAGE2 + PAGE3 + PAGE4 + PAGE5 + PAGE6);
});
server.listen(PORT, () => {
  console.log(`\n🚀 Mission Control → http://localhost:${PORT}\n   Notion: ${NOTION_TOKEN?'✅':'❌'}  Repo: ${REPO}\n`);

  // ─── Server-side auto-assign loop (every 45s) ────────────────────
  setInterval(async () => {
    try {
      // Step 1: Auto-assign idle agents (dispatch To Do / QA queue)
      const results = await autoAssignAll();
      if (results.length > 0) {
        console.log(`[auto-assign] ${results.map(r => r.agent + ':' + (r.task||r.action||'').substring(0,30)).join(', ')}`);
      }

      // Fetch tasks once for Steps 1.5 and 1.6
      const allTasks = await fetchTasks();

      // Step 1.4: Clear stale active tasks on QA agents (task is Done in Notion but agent still has it)
      for (const qaName of ['qa', 'qa2']) {
        const qaPath = path.join(WORKTREES, qaName);
        const activeFile = path.join(qaPath, '.agent-task.json');
        try {
          if (fs.existsSync(activeFile)) {
            const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
            const notionTask = allTasks.find(t => t.id === active.id);
            if (!notionTask || notionTask.status === 'Done' || notionTask.status === 'Backlog') {
              fs.unlinkSync(activeFile);
              try { fs.unlinkSync(path.join(qaPath, '.agent-prompt.md')); } catch {}
              console.log(`[qa-stale] Cleared ${qaName} active task: "${active.title?.substring(0,30)}" (Notion: ${notionTask?.status || 'not found'})`);
            }
          }
        } catch {}
      }

      // Step 1.5: Clean QA queues (ALWAYS) + dispatch idle QA agents
      const qaAgents = ['qa', 'qa2'];
      for (const qaName of qaAgents) {
        const qaPath = path.join(WORKTREES, qaName);
        const queueDir = path.join(qaPath, '.qa-queue');
        try {
          let queueFiles = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter(f => f.endsWith('.json')).sort() : [];

          // ALWAYS clean stale items (runs every cycle, even when QA is busy)
          const activeTaskFile = path.join(qaPath, '.agent-task.json');
          let activeTaskId = null;
          try { activeTaskId = JSON.parse(fs.readFileSync(activeTaskFile, 'utf8')).id; } catch {}

          for (const qf of [...queueFiles]) {
            try {
              const qt = JSON.parse(fs.readFileSync(path.join(queueDir, qf), 'utf8'));
              const notionTask = allTasks.find(t => t.id === qt.id);
              // Remove if: Done, Backlog, not in Notion, or is the currently active task
              if (!notionTask || notionTask.status === 'Done' || notionTask.status === 'Backlog' || qt.id === activeTaskId) {
                fs.unlinkSync(path.join(queueDir, qf));
                queueFiles = queueFiles.filter(f => f !== qf);
                if (qt.id !== activeTaskId) {
                  console.log(`[qa-queue] Removed stale ${qf}: "${qt.title.substring(0,30)}" (Notion: ${notionTask?.status || 'not found'})`);
                }
              }
            } catch {}
          }

          // Dispatch if QA agent is idle and has waiting tasks
          const hasTask = fs.existsSync(activeTaskFile);
          const hasPrompt = fs.existsSync(path.join(qaPath, '.agent-prompt.md'));
          if (!hasTask && !hasPrompt && queueFiles.length > 0) {
            const nextTask = JSON.parse(fs.readFileSync(path.join(queueDir, queueFiles[0]), 'utf8'));
            console.log(`[qa-queue] ${qaName} idle, ${queueFiles.length} waiting — dispatching: ${nextTask.title.substring(0,40)}`);
            const repoEsc = '~/Desktop/Custom\\\\ Connectors/Cortex/cortex-telegram-hub-bot';
            const prompt = `# \ud83e\uddea QA Validation Task\n\n## Validating: ${nextTask.title}\n**Original agent:** ${nextTask.originAgent}\n**Priority:** ${nextTask.priority || 'Medium'}\n\n## Instructions\n1. Pull the latest code: \`git fetch origin && git merge origin/agent/${nextTask.originAgent} --no-edit\`\n2. Run all tests: \`npx vitest run\`\n3. Run type check: \`npx tsc --noEmit\`\n4. Review the changes: \`git log origin/main..HEAD --oneline\`\n5. Verify the implementation matches the task description\n6. If ALL checks pass: mark as PASS\n7. If ANY check fails: mark as FAIL with clear reason\n\n## Auto-chain (MANDATORY)\n\`\`\`bash\nAGENT_DIR=$(basename "$(pwd)")\nnode ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --verdict pass --summary "describe what you validated"\n\`\`\`\nOr if FAIL:\n\`\`\`bash\nAGENT_DIR=$(basename "$(pwd)")\nnode ${repoEsc}/scripts/agent-complete.js --agent $AGENT_DIR --verdict fail --reason "describe the failure"\n\`\`\`\n\n## Notion Task ID\n${nextTask.id}`;
            fs.writeFileSync(path.join(qaPath, '.agent-prompt.md'), prompt);
            fs.writeFileSync(path.join(qaPath, '.agent-task.json'), JSON.stringify({
              id: nextTask.id, title: nextTask.title, description: nextTask.description || '',
              priority: nextTask.priority || '', phase: nextTask.phase || '',
              tags: nextTask.tags || [], agent: qaName === 'qa' ? '\ud83e\uddea QA' : '\ud83e\uddea QA2',
              originAgent: nextTask.originAgent
            }, null, 2));
            // Remove dispatched item from queue
            fs.unlinkSync(path.join(queueDir, queueFiles[0]));
          }
        } catch (e) { console.error(`[qa-queue] Error processing ${qaName}:`, e.message); }
      }

      // Step 1.6: Recover orphaned QA Validating tasks from Notion
      // Check BOTH QA agents globally to prevent duplicates
      const qaValidating = allTasks.filter(t => t.status === 'QA Validating');
      for (const task of qaValidating) {
        const originWorktree = AGENT_MAP[task.agent] || 'backend';
        const targetQA = QA_ROUTING[originWorktree] || (task.agent === '🔒 Security' ? 'qa2' : 'qa');
        // Check ALL QA agents (not just target) to prevent cross-agent duplicates
        let alreadyHandled = false;
        for (const checkQA of ['qa', 'qa2']) {
          if (alreadyHandled) break;
          const checkPath = path.join(WORKTREES, checkQA);
          try {
            const activeFile = path.join(checkPath, '.agent-task.json');
            if (fs.existsSync(activeFile)) {
              const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
              if (active.id === task.id) { alreadyHandled = true; break; }
            }
            const checkQueue = path.join(checkPath, '.qa-queue');
            if (fs.existsSync(checkQueue)) {
              for (const qf of fs.readdirSync(checkQueue).filter(f => f.endsWith('.json'))) {
                const qt = JSON.parse(fs.readFileSync(path.join(checkQueue, qf), 'utf8'));
                if (qt.id === task.id) { alreadyHandled = true; break; }
              }
            }
          } catch {}
        }
        if (!alreadyHandled) {
          const queueDir = path.join(WORKTREES, targetQA, '.qa-queue');
          if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
          const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json')).sort();
          const nextNum = files.length === 0 ? 1 : parseInt(files[files.length - 1].replace('.json', ''), 10) + 1;
          fs.writeFileSync(path.join(queueDir, String(nextNum).padStart(3, '0') + '.json'), JSON.stringify({
            id: task.id, title: task.title, description: task.description || '',
            priority: task.priority || '', phase: task.phase || '', tags: task.tags || [],
            originAgent: originWorktree, targetQA, queuedAt: new Date().toISOString(),
          }, null, 2));
          console.log(`[qa-orphan] Re-queued orphaned task to ${targetQA}: "${task.title.substring(0,40)}"`);
        }
      }

      // Step 2: Auto-launch ANY agent that has a prompt but isn't running
      const agents = agentStatus();
      for (const ag of agents) {
        if (ag.hasPrompt && !ag.running) {
          console.log(`[auto-launch] Starting ${ag.name} (has prompt, not running)`);
          const launcherPath = path.join(REPO, 'scripts/launch-agent.sh');
          const applescript = `tell application "iTerm"
activate
tell current window
create tab with default profile
tell current session of current tab
write text "\\\"${launcherPath}\\\" ${ag.name}"
end tell
end tell
end tell`;
          exec(`osascript -e '${applescript.replace(/'/g,"'\\''")}'`, (err) => {
            if (err) console.error(`[auto-launch] Failed for ${ag.name}:`, err.message);
            else console.log(`[auto-launch] ✅ ${ag.name} launched in iTerm`);
          });
          await new Promise(r => setTimeout(r, 2000)); // Stagger launches
        }
      }
    } catch (e) { console.error('[auto-assign] Error:', e.message); }
  }, 45000);
});

// ⚠️ TEMPLATE LITERAL ESCAPING: Use \\n (not \n) for JS newlines inside PAGE strings.
// Single \n inside backticks becomes a real newline, breaking JS string syntax in the browser.
const PAGE = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Hub — Mission Control</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0c0e14;--bg2:#151820;--bg3:#1e222d;--bg4:#282d3a;--bdr:#2a3042;--t1:#e8eaf0;--t2:#8e95ab;--t3:#555d75;
--blue:#4a9eff;--green:#2dd4a0;--amber:#f5a623;--purple:#b07cf5;--red:#f25757;--pink:#f06;--orange:#ff8533;--teal:#20c9b0}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;background:var(--bg);color:var(--t1);font-size:13px}
.w{max-width:1280px;margin:0 auto;padding:14px 16px}
h1{font-size:17px;font-weight:600;display:flex;align-items:center;gap:8px}
.meta{font-size:10px;color:var(--t3);margin-top:1px}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.stats{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.stat{flex:1;min-width:80px;text-align:center;padding:8px 6px;border-radius:8px;border:1px solid var(--bdr);background:var(--bg2)}
.stat b{font-size:20px;display:block;font-weight:700}
.stat small{font-size:9px;color:var(--t2);text-transform:uppercase;letter-spacing:.5px}
.tabs{display:flex;gap:1px;border-bottom:1px solid var(--bdr);margin-bottom:12px}
.tab{padding:7px 14px;background:0;border:0;color:var(--t3);cursor:pointer;font:inherit;font-size:12px;border-bottom:2px solid transparent}
.tab.on{color:var(--t1);border-bottom-color:var(--blue)}
.btn{padding:5px 12px;border-radius:5px;border:1px solid var(--bdr);background:var(--bg3);color:var(--t1);cursor:pointer;font:inherit;font-size:11px;transition:.12s;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.btn:hover{background:var(--bg4);border-color:var(--t3)}.btn:active{transform:scale(.97)}
.btn.run{pointer-events:none;opacity:.5}
.btn-blue{border-color:var(--blue);color:var(--blue)}.btn-green{border-color:var(--green);color:var(--green)}
.btn-amber{border-color:var(--amber);color:var(--amber)}.btn-red{border-color:var(--red);color:var(--red)}
.btn-purple{border-color:var(--purple);color:var(--purple)}.btn-orange{border-color:var(--orange);color:var(--orange)}
.btn-big{padding:10px 20px;font-size:13px;font-weight:500;border-radius:8px}
.sec{background:var(--bg2);border-radius:10px;padding:14px;border:1px solid var(--bdr);margin-bottom:10px}
.sec h3{font-size:13px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.out{background:var(--bg);border:1px solid var(--bdr);border-radius:6px;padding:8px;font-family:'SF Mono',monospace;font-size:10px;color:var(--t2);max-height:250px;overflow-y:auto;white-space:pre-wrap;margin-top:8px}
.row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:6px;background:var(--bg);border:1px solid var(--bdr);margin-bottom:5px}
.row .lbl{font-size:12px;font-weight:500}.row .desc{font-size:10px;color:var(--t3)}
.badge{font-size:9px;padding:2px 7px;border-radius:10px;font-weight:600}
.board{display:flex;gap:7px;overflow-x:auto;padding-bottom:6px}
.col{flex:0 0 175px;background:var(--bg2);border-radius:8px;border:1px solid var(--bdr)}
.col-h{padding:7px 9px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600}
.col-h .d{width:7px;height:7px;border-radius:50%}.col-h .c{font-size:9px;color:var(--t3);margin-left:auto;background:var(--bg3);padding:0 5px;border-radius:6px}
.col-b{padding:5px;max-height:340px;overflow-y:auto}
.card{background:var(--bg3);border-radius:5px;padding:7px;margin-bottom:3px;cursor:pointer;border-left:2px solid var(--t3);font-size:11px;line-height:1.3}
.card:hover{background:var(--bg4)}.card .tl{font-weight:500}.card .tg{display:flex;gap:3px;margin-top:3px;flex-wrap:wrap}
.card .mv{margin-top:5px;display:none;flex-wrap:wrap;gap:2px}.card.open .mv{display:flex}
.ag{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.ag-c{background:var(--bg2);border-radius:10px;padding:14px;border:1px solid var(--bdr);border-left:3px solid var(--t3)}
.ag-c .hd{display:flex;justify-content:space-between;align-items:center}
.ag-c .tk{margin:8px 0;padding:8px;border-radius:6px;background:var(--bg);border:1px solid var(--bdr);font-size:11px}
.ag-c .btns{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.log{margin-top:12px;background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;overflow:hidden}
.log-h{padding:5px 10px;border-bottom:1px solid var(--bdr);font-size:10px;color:var(--t2);display:flex;justify-content:space-between}
.log-b{padding:6px;max-height:120px;overflow-y:auto;font-family:'SF Mono',monospace;font-size:9px}
</style></head><body><div class="w">
<div class="hdr">
  <div><h1><span style="font-size:20px">🚀</span> Mission Control</h1><div class="meta" id="sync">Not synced</div></div>
  <div style="display:flex;gap:4px"><button class="btn btn-blue" onclick="refresh()">⟳ Sync Board</button><button class="btn" onclick="api('agents').then(d=>{if(d.ok){AG=d.agents;render()}})">⟳ Agents</button></div>
</div>
<div class="stats" id="stats"></div>
<div class="tabs">
  <button class="tab on" data-t="board">▣ Board</button>
  <button class="tab" data-t="agents">⚡ Agents</button>
  <button class="tab" data-t="pipe">▸ Pipeline</button>
  <button class="tab" data-t="deploy">🚀 Deploy</button>
</div>
<div id="v"></div>
<div class="log"><div class="log-h"><span>Activity log</span><button style="background:0;border:0;color:var(--t3);cursor:pointer;font-size:9px" onclick="L=[];rlog()">Clear</button></div><div class="log-b" id="log"></div></div>
</div>
`;
const PAGE2 = `<script>
let T=[],AG=[],L=[],TAB='board';
const S=['Backlog','To Do','In Progress','Review','QA Validating','Done'];
const SC={Backlog:'#555d75','To Do':'#4a9eff','In Progress':'#f5a623',Review:'#b07cf5','QA Validating':'#ff8533',Done:'#2dd4a0'};
const AC={'🔧 Backend':'#4a9eff','🧪 QA':'#2dd4a0','⚙️ DevOps':'#f5a623','🔒 Security':'#f25757','♻️ Refactor':'#b07cf5','🏗️ Architect':'#f06','🎨 Frontend':'#f06','🧪 QA2':'#20c9b0'};
const AI={backend:{e:'🔧',n:'Backend',c:'#4a9eff',r:'Features, services, handlers'},qa:{e:'🧪',n:'QA',c:'#2dd4a0',r:'Validates Backend + Frontend'},devops:{e:'⚙️',n:'DevOps',c:'#f5a623',r:'CI/CD, infra, migrations'},flex:{e:'🔒/♻️',n:'Flex',c:'#b07cf5',r:'Security or Refactor'},frontend:{e:'🎨',n:'Frontend',c:'#f06',r:'UI/UX, portal, dashboard, templates'},qa2:{e:'🧪',n:'QA2',c:'#20c9b0',r:'Validates DevOps + Flex'}};

function log(m,t='info'){L.push({time:new Date().toLocaleTimeString(),m,t});if(L.length>60)L=L.slice(-60);rlog()}
function rlog(){document.getElementById('log').innerHTML=L.map(l=>'<div style="color:'+({error:'#f25757',success:'#2dd4a0',warn:'#f5a623'}[l.t]||'#8e95ab')+'"><span style="opacity:.4">'+l.time+'</span> '+l.m+'</div>').join('');document.getElementById('log').scrollTop=9999}

async function api(r,b){
  log('→ '+r);
  try{const x=await fetch('/api/'+r,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
  const d=await x.json();if(d.ok)log('✓ '+r+(d.msg?' — '+d.msg:''),'success');else log('✗ '+(d.error||d.output||r),'error');return d}
  catch(e){log('✗ '+e.message,'error');return{ok:false}}
}

async function refresh(){
  log('Syncing...');
  const[b,a]=await Promise.all([api('board'),api('agents')]);
  if(b.ok)T=b.tasks;if(a.ok)AG=a.agents;
  document.getElementById('sync').textContent='Synced: '+new Date().toLocaleTimeString();
  rstats();render();
  // Auto-assign: dispatch To Do tasks AND pick up QA queue for all idle agents
  var hasIdle=(AG||[]).some(function(a){return !a.task&&!a.hasPrompt});
  var hasTodo=T.some(function(t){return t.status==='To Do'&&t.agent});
  var hasQAQueue=(AG||[]).some(function(a){return (a.name==='qa'||a.name==='qa2')&&a.queueCount>0&&!a.task});
  if(hasIdle&&(hasTodo||hasQAQueue)){
    log('Auto-assigning idle agents...','warn');
    var dd=await api('auto-assign');
    if(dd.ok&&dd.assigned&&dd.assigned.length>0){
      log('Auto-assigned '+dd.assigned.length+' agent(s)','success');
      var[b2,a2]=await Promise.all([api('board'),api('agents')]);
      if(b2.ok)T=b2.tasks;if(a2.ok)AG=a2.agents;
      rstats();render();
    }
  }
}

function rstats(){
  const c={};S.forEach(s=>c[s]=0);T.forEach(t=>c[t.status]=(c[t.status]||0)+1);
  document.getElementById('stats').innerHTML=['To Do','In Progress','Review','QA Validating'].map(s=>
    '<div class="stat"><b style="color:'+SC[s]+'">'+c[s]+'</b><small>'+s+'</small></div>').join('')
}
</script>`;
const PAGE3 = `<script>
function rBoard(){
  const g={};S.forEach(s=>g[s]=[]);T.forEach(t=>{if(g[t.status])g[t.status].push(t)});
  return '<div class="board">'+S.map(s=>{
    const ts=g[s]||[];
    return '<div class="col"><div class="col-h"><span class="d" style="background:'+SC[s]+'"></span>'+s+'<span class="c">'+ts.length+'</span></div><div class="col-b">'
    +ts.map(t=>{const c=AC[t.agent]||'#555d75';
      const mv=S.filter(x=>x!==t.status).map(x=>"<button class='btn' style='font-size:9px;padding:2px 5px' onclick=\\"event.stopPropagation();moveT('"+t.id+"','"+x+"')\\">→"+x+"</button>").join('');
      return "<div class='card' style='border-left-color:"+c+"' onclick=\\"this.classList.toggle('open')\\">"
        +"<div class='tl'>"+t.title+"</div><div class='tg'>"
        +(t.agent?"<span class='badge' style='background:"+c+"22;color:"+c+"'>"+t.agent+"</span>":"")
        +(t.priority?"<span class='badge' style='background:var(--bg);color:var(--t2)'>"+t.priority+"</span>":"")
        +"</div><div class='mv'>"+mv+"</div></div>"
    }).join('')+'</div></div>'
  }).join('')+'</div>'
}
async function moveT(id,s){await api('move-task',{id,status:s});T=T.map(t=>t.id===id?{...t,status:s}:t);rstats();render()}
</script>`;
// ⚠️ TEMPLATE LITERAL ESCAPING: Use \\n (not \n) for JS newlines inside PAGE strings.
// Single \n inside backticks becomes a real newline, breaking JS string syntax in the browser.
const PAGE4 = `<script>
function rAgents(){
  return '<div class="ag">'+AG.map(a=>{
    var i=AI[a.name]||AI.backend;
    var sm={online:{l:"\\u25cf Online (auto-loop)",bg:"rgba(45,212,160,.15)",c:"#2dd4a0"},"has-task":{l:"\\u25cf Starting...",bg:"rgba(245,166,35,.15)",c:"#f5a623"},"has-prompt":{l:"\\u25ce Launching...",bg:"rgba(74,158,255,.15)",c:"#4a9eff"},offline:{l:"\\u25cb Offline",bg:"rgba(85,93,117,.15)",c:"#555d75"}};
    var st=sm[a.status]||sm.offline;
    var h='<div class="ag-c" style="border-left-color:'+i.c+'">';
    h+='<div class="hd"><div><span style="font-size:16px">'+i.e+'</span> <b>'+i.n+'</b></div>';
    h+='<span class="badge" style="background:'+st.bg+';color:'+st.c+'">'+st.l+'</span></div>';
    h+='<div style="font-size:10px;color:var(--t2);margin-top:2px">'+i.r+(a.pid?" PID:"+a.pid:"")+'</div>';
    if(a.task){h+='<div class="tk"><b>'+a.task.title+'</b><div style="color:var(--t3);margin-top:2px">'+(a.task.priority||"")+'</div></div>';}
    else{h+='<div class="tk" style="color:var(--t3)">No task — auto-assign checks every 45s</div>';}
    if((a.name==="qa"||a.name==="qa2")&&a.queueCount>0){h+='<div style="font-size:10px;padding:4px 8px;border-radius:4px;background:rgba(249,115,22,.1);border:1px solid rgba(249,115,22,.3);color:#ff8533;margin-bottom:6px">'+a.queueCount+" queued for "+i.n+" (auto-pickup)</div>";}
    h+='<div class="btns">';
    if(a.status==="online"){h+='<button class="btn btn-red" onclick="stopAgent(&#39;'+a.name+'&#39;)">\\u23F9 Stop</button>';}
    else if(a.status==="has-task"||a.status==="has-prompt"){h+='<span style="font-size:10px;color:var(--amber);padding:4px 8px">Auto-launching in next cycle...</span>';}
    else{h+='<button class="btn btn-green" onclick="startAgent(&#39;'+a.name+'&#39;)">\\u25B6 Launch</button>';}
    h+='<button class="btn" onclick="viewTerminal(&#39;'+a.name+'&#39;)">Terminal</button>';
    h+='<button class="btn btn-blue" onclick="checkAgent(&#39;'+a.name+'&#39;)">Logs</button>';
    h+='<button class="btn btn-purple" onclick="agentGitLog(&#39;'+a.name+'&#39;)">Git log</button>';
    h+='</div><div class="out" id="out-'+a.name+'" style="display:none"></div></div>';
    return h;
  }).join("")+'</div>'
  +'<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">'
  +'<button class="btn btn-green btn-big" onclick="startAllAgents()">\\u25B6 Launch all</button>'
  +'<button class="btn btn-red btn-big" onclick="stopAll()">\\u23F9 Stop all</button>'
  +'<button class="btn btn-big" onclick="refreshAgents()">Refresh status</button>'
  +'</div>'
  +'<div style="margin-top:8px;padding:10px;border-radius:8px;background:var(--bg2);border:1px solid var(--bdr);font-size:11px;color:var(--t2)">'
  +'\\u2699\\uFE0F <b>Auto-orchestration active.</b> Agents loop continuously: execute task \\u2192 auto-complete \\u2192 notify via Telegram \\u2192 pick next task. Just move tasks to To Do in Notion — agents handle the rest.'
  +'</div>'
  +'<div style="margin-top:12px;background:var(--bg2);border-radius:10px;border:1px solid var(--bdr);padding:12px">'
  +'<div style="font-size:12px;font-weight:600;color:var(--t2);margin-bottom:8px;display:flex;align-items:center;gap:6px">🎯 Dispatch Specific Task</div>'
  +'<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">'
  +'<input id="dispatch-task-id" placeholder="Notion task ID (e.g. 334ad49d-...)" style="flex:2;min-width:200px;background:var(--bg);border:1px solid var(--bdr);border-radius:5px;padding:5px 10px;color:var(--t1);font:inherit;font-size:12px;outline:none">'
  +'<select id="dispatch-agent" style="background:var(--bg);border:1px solid var(--bdr);border-radius:5px;padding:5px 10px;color:var(--t1);font:inherit;font-size:12px;outline:none">'
  +'<option value="">Auto (from Agent field)</option>'
  +'<option value="backend">🔧 Backend</option>'
  +'<option value="qa">🧪 QA</option>'
  +'<option value="devops">⚙️ DevOps</option>'
  +'<option value="flex">♻️ Flex</option>'
  +'</select>'
  +'<button class="btn btn-blue" onclick="dispatchSingle()">▸ Dispatch</button>'
  +'<button class="btn" onclick="listTodo()">📋 List To Do</button>'
  +'</div>'
  +'<div class="out" id="dispatch-out" style="display:none;max-height:160px"></div>'
  +'</div>'
}
async function startAgent(n){log("Launching "+n+" (auto-loop)...");var d=await api("start-agent",{agent:n});showOut(n,d.output||"Launched");setTimeout(refreshAgents,4000)}
async function stopAgent(n){log("Stopping "+n+"...");var d=await api("stop-agent",{agent:n});showOut(n,d.output||"Stopped");setTimeout(refreshAgents,2000)}
async function checkAgent(n){var d=await api("agent-log",{agent:n});showOut(n,d.output||"No task files")}
async function agentGitLog(n){var d=await api("agent-branches",{agent:n});showOut(n,d.output||"No commits")}
async function startAllAgents(){for(var n of["backend","qa","devops","flex","frontend","qa2"]){await startAgent(n);await new Promise(function(r){setTimeout(r,2000)})}}
async function stopAll(){
  log("Stopping all agents...");
  await Promise.all(["backend","qa","devops","flex","frontend","qa2"].map(n=>stopAgent(n)));
  setTimeout(refreshAgents,2500);
}
async function refreshAgents(){var d=await api("agents");if(d.ok){AG=d.agents;render()}}
async function viewTerminal(n){log("Focusing "+n+" terminal...");var d=await api("view-terminal",{agent:n});showOut(n,d.output||"No terminal found")}
function showOut(n,t){var el=document.getElementById("out-"+n);if(el){el.style.display="block";el.textContent=t}}
async function dispatchSingle(){
  var taskId=(document.getElementById("dispatch-task-id")||{}).value||"";
  var agent=(document.getElementById("dispatch-agent")||{}).value||"";
  if(!taskId.trim()){showDispatch("❌ Paste a Notion task ID first");return}
  showDispatch("⟳ Dispatching...");
  var d=await api("dispatch-single",{taskId:taskId.trim(),agent:agent||undefined});
  showDispatch(d.output||(d.ok?"✅ Done":"❌ Failed"));
  if(d.ok) setTimeout(refreshAgents,1500);
}
async function listTodo(){
  showDispatch("⟳ Loading To Do tasks from Notion...");
  var d=await api("list-todo");
  if(!d.ok){showDispatch("❌ "+d.error);return}
  var tasks=d.tasks||[];
  if(!tasks.length){showDispatch("✅ No To Do or Backlog tasks found");return}
  var lines=tasks.map(function(t){
    var agentWarn=t.agent?"":"  ⚠️ NO AGENT";
    return t.id+"  ["+t.priority+"] ["+t.agent+"]"+agentWarn+"\\n  "+t.title;
  });
  showDispatch("To Do / Backlog ("+tasks.length+"):\\n\\n"+lines.join("\\n\\n")+"\\n\\n─── Click ID to copy & paste above ───");
}
function showDispatch(t){var el=document.getElementById("dispatch-out");if(el){el.style.display="block";el.textContent=t}}
</script>`;
const PAGE5 = `<script>
function rPipe(){
  const rv=T.filter(t=>t.status==='Review').length;
  const qa=T.filter(t=>t.status==='QA Validating').length;
  const todo=T.filter(t=>t.status==='To Do').length;
  return '<div class="sec"><h3>⚡ Agent pipeline</h3>'
    +cmdR('Clear stale files','Remove .agent-task.json + .agent-prompt.md from all worktrees','clear-stale','btn-red')
    +cmdR('Dispatch tasks','Assign To Do tasks to idle agents based on Agent tag','dispatch','btn-blue')
    +cmdR('Dispatch + Start all','Dispatch tasks then auto-start all agents','dispatch-start','btn-green')
    +'<div class="out" id="pipe-out" style="display:none"></div></div>'
    +'<div class="sec"><h3>🔍 Code quality</h3>'
    +cmdR('Run test suite','npx vitest run (490+ tests)','run-tests','btn-green')
    +cmdR('Type check','npx tsc --noEmit','typecheck','btn-amber')
    +cmdR('Git status','Branch, uncommitted changes, recent commits','git-status','btn-purple')
    +'<div class="out" id="pipe-out2" style="display:none"></div></div>'
    +'<div class="sec"><h3>📋 Bulk Notion actions</h3><div style="display:flex;gap:6px;flex-wrap:wrap">'
    +'<button class="btn btn-big btn-orange" onclick="bulkMove(&#39;Review&#39;,&#39;QA Validating&#39;)">Review → QA ('+rv+')</button>'
    +'<button class="btn btn-big btn-green" onclick="bulkMove(&#39;QA Validating&#39;,&#39;Done&#39;)">QA → Done ('+qa+')</button>'
    +'<button class="btn btn-big btn-blue" onclick="bulkMove(&#39;To Do&#39;,&#39;In Progress&#39;)">To Do → In Progress ('+todo+')</button>'
    +'</div></div>'
}
function cmdR(l,d,r,c){return '<div class="row"><div><div class="lbl">'+l+'</div><div class="desc">'+d+'</div></div><button class="btn '+c+'" id="c-'+r+'" onclick="runP(&#39;'+r+'&#39;,this)">▸ Run</button></div>'}
async function runP(r,btn){
  btn.classList.add('run');btn.textContent='⟳...';
  if(r==='dispatch-start'){await api('dispatch');await new Promise(r2=>setTimeout(r2,2000));await startAllTasks();btn.classList.remove('run');btn.textContent='▸ Run';return}
  const d=await api(r);btn.classList.remove('run');btn.textContent='▸ Run';
  var o=document.getElementById('pipe-out')||document.getElementById('pipe-out2');
  if(d.output){o.style.display='block';o.textContent=d.output}
}
async function bulkMove(from,to){const ids=T.filter(t=>t.status===from).map(t=>t.id);if(!ids.length){log('No tasks in '+from,'warn');return}await api('bulk-move',{ids,status:to});refresh()}

function rDeploy(){
  const done=T.filter(t=>t.status==='Done').slice(0,12);
  return '<div class="sec"><h3>🚀 Merge + Deploy</h3><p style="font-size:11px;color:var(--t2);margin-bottom:10px">Sequential: agent branches → develop → main → production</p>'
    +cmdR('1. Merge agents → develop','git merge agent branches into develop','merge-develop','btn-blue')
    +cmdR('2. Merge develop → main + changelog','Promote develop to main, generate CHANGELOG.md via git-cliff, push','merge-main','btn-purple')
    +cmdR('3. Deploy to production','Build, backup, rsync, PM2, health check','deploy','btn-green')
    +'<div class="out" id="pipe-out" style="display:none"></div></div>'
    +'<div class="sec"><h3>🛡 Server management</h3>'
    +cmdR('Server status','SSH check PM2 process list','server-status','btn-blue')
    +cmdR('Rollback','Restore previous deployment','rollback','btn-red')
    +cmdR('Sync from server','Dry-run sync to see changed files','sync-server','btn-amber')
    +'<div class="out" id="pipe-out2" style="display:none"></div></div>'
    +'<div class="sec"><h3>✓ Done tasks (ready to ship)</h3>'
    +done.map(t=>'<div style="font-size:11px;padding:3px 8px;border-radius:4px;background:var(--bg);margin-bottom:2px;display:flex;gap:5px"><span style="color:#2dd4a0">✓</span>'+t.title+'</div>').join('')
    +(T.filter(t=>t.status==='Done').length>12?'<div style="font-size:9px;color:var(--t3);text-align:center;margin-top:4px">+'+(T.filter(t=>t.status==='Done').length-12)+' more</div>':'')
    +'</div>'
}
</script>`;
const PAGE6 = `<script>
function render(){
  const v=document.getElementById('v');
  if(TAB==='board')v.innerHTML=rBoard();
  else if(TAB==='agents')v.innerHTML=rAgents();
  else if(TAB==='pipe')v.innerHTML=rPipe();
  else if(TAB==='deploy')v.innerHTML=rDeploy();
}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  t.classList.add('on');TAB=t.dataset.t;render()
}));
refresh();
setInterval(refresh, 30000); // Auto-refresh every 30s — no manual sync needed
</script></body></html>`;

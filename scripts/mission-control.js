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
      if (!notionTask || (a.name !== 'qa' && staleStatuses.includes(notionTask.status)) || (notionTask.status === 'Done')) {
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
    try {
      const worktreeName = a.name;
      const matchingTags = Object.entries(AGENT_MAP).filter(([,v]) => v === worktreeName).map(([k]) => k);
      const assignableTasks = allTasks.filter(t =>
        matchingTags.includes(t.agent) && (t.status === 'To Do' || t.status === 'In Progress')
      );
      if (assignableTasks.length > 0) {
        const next = assignableTasks[0];
        // If task is orphaned In Progress (agent has no files), move back to To Do first
        if (next.status === 'In Progress') {
          await notionFetch(`/pages/${next.id}`, 'PATCH', {properties:{Status:{select:{name:'To Do'}}}});
        }
        const r = await run(`node "${SCRIPT('dispatch-tasks.js')}"`);
        results.push({ agent: worktreeName, task: next.title, source: next.status === 'To Do' ? 'notion-todo' : 'notion-recover' });
      }
    } catch (e) { results.push({ agent: a.name, error: e.message }); }
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

  return ['backend','frontend','qa','qa2','devops','flex'].map(name => {
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
    
    // QA queue count
    let queueCount = 0;
    if (name === 'qa') {
      try {
        const qd = path.join(WORKTREES, 'qa', '.qa-queue');
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
    if (route === 'merge-develop') return send(res, await run('git fetch origin && git checkout develop && git pull origin develop && git merge origin/agent/backend --no-edit 2>/dev/null; git merge origin/agent/qa --no-edit 2>/dev/null; git merge origin/agent/devops --no-edit 2>/dev/null; git merge origin/agent/flex --no-edit 2>/dev/null; npx vitest run 2>&1 | tail -5 && git push origin develop && git checkout main'));
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
:root{--bg:#0a0c12;--bg2:#12151e;--bg3:#1a1e2a;--bg4:#242836;--bdr:#262c3d;--t1:#e8eaf0;--t2:#8e95ab;--t3:#555d75;
--blue:#4a9eff;--green:#2dd4a0;--amber:#f5a623;--purple:#b07cf5;--red:#f25757;--pink:#f06;--orange:#ff8533;--teal:#20c9b0;--cyan:#22d3ee}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter',sans-serif;background:var(--bg);color:var(--t1);font-size:13px;-webkit-font-smoothing:antialiased}
.w{max-width:1380px;margin:0 auto;padding:16px 20px}
h1{font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px;letter-spacing:-.3px}
.meta{font-size:10px;color:var(--t3);margin-top:2px;font-family:'SF Mono',monospace}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.stats{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.stat{flex:1;min-width:90px;text-align:center;padding:10px 8px;border-radius:10px;border:1px solid var(--bdr);background:var(--bg2);transition:border-color .15s}
.stat:hover{border-color:var(--t3)}
.stat b{font-size:22px;display:block;font-weight:700;font-variant-numeric:tabular-nums}
.stat small{font-size:9px;color:var(--t2);text-transform:uppercase;letter-spacing:.6px;font-weight:500}
.tabs{display:flex;gap:2px;background:var(--bg2);border-radius:10px;padding:3px;margin-bottom:14px;border:1px solid var(--bdr);width:fit-content}
.tab{padding:7px 16px;background:0;border:0;color:var(--t3);cursor:pointer;font:inherit;font-size:12px;border-radius:7px;font-weight:500;transition:.15s}
.tab:hover{color:var(--t2)}
.tab.on{color:var(--t1);background:var(--bg3);box-shadow:0 1px 3px rgba(0,0,0,.3)}
.btn{padding:6px 14px;border-radius:7px;border:1px solid var(--bdr);background:var(--bg3);color:var(--t1);cursor:pointer;font:inherit;font-size:11px;font-weight:500;transition:.15s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.btn:hover{background:var(--bg4);border-color:var(--t3)}.btn:active{transform:scale(.97)}
.btn.run{pointer-events:none;opacity:.5}
.btn-blue{border-color:rgba(74,158,255,.4);color:var(--blue)}.btn-blue:hover{background:rgba(74,158,255,.1)}
.btn-green{border-color:rgba(45,212,160,.4);color:var(--green)}.btn-green:hover{background:rgba(45,212,160,.1)}
.btn-amber{border-color:rgba(245,166,35,.4);color:var(--amber)}.btn-amber:hover{background:rgba(245,166,35,.1)}
.btn-red{border-color:rgba(242,87,87,.4);color:var(--red)}.btn-red:hover{background:rgba(242,87,87,.1)}
.btn-purple{border-color:rgba(176,124,245,.4);color:var(--purple)}.btn-purple:hover{background:rgba(176,124,245,.1)}
.btn-orange{border-color:rgba(255,133,51,.4);color:var(--orange)}.btn-orange:hover{background:rgba(255,133,51,.1)}
.btn-big{padding:10px 22px;font-size:13px;font-weight:600;border-radius:9px}
.sec{background:var(--bg2);border-radius:12px;padding:16px;border:1px solid var(--bdr);margin-bottom:12px}
.sec h3{font-size:13px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.out{background:var(--bg);border:1px solid var(--bdr);border-radius:8px;padding:10px;font-family:'SF Mono','Fira Code',monospace;font-size:10px;color:var(--t2);max-height:250px;overflow-y:auto;white-space:pre-wrap;margin-top:8px}
.row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--bdr);margin-bottom:6px;transition:border-color .15s}
.row:hover{border-color:var(--t3)}
.row .lbl{font-size:12px;font-weight:600}.row .desc{font-size:10px;color:var(--t3)}
.badge{font-size:9px;padding:2px 8px;border-radius:10px;font-weight:600}
.board{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}
.col{flex:0 0 185px;background:var(--bg2);border-radius:10px;border:1px solid var(--bdr)}
.col-h{padding:8px 10px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600}
.col-h .d{width:8px;height:8px;border-radius:50%}.col-h .c{font-size:9px;color:var(--t3);margin-left:auto;background:var(--bg3);padding:1px 6px;border-radius:8px;font-weight:600}
.col-b{padding:6px;max-height:380px;overflow-y:auto}
.card{background:var(--bg3);border-radius:7px;padding:8px;margin-bottom:4px;cursor:pointer;border-left:2px solid var(--t3);font-size:11px;line-height:1.35;transition:background .12s}
.card:hover{background:var(--bg4)}.card .tl{font-weight:500}.card .tg{display:flex;gap:3px;margin-top:4px;flex-wrap:wrap}
.card .mv{margin-top:5px;display:none;flex-wrap:wrap;gap:2px}.card.open .mv{display:flex}
.ag{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:960px){.ag{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.ag{grid-template-columns:1fr}}
.ag-c{background:var(--bg2);border-radius:12px;padding:0;border:1px solid var(--bdr);overflow:hidden;transition:border-color .2s}
.ag-c:hover{border-color:var(--t3)}
.ag-c .ag-top{padding:14px 14px 0;display:flex;justify-content:space-between;align-items:flex-start}
.ag-c .ag-body{padding:10px 14px 14px}
.ag-c .ag-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.ag-c .tk{margin:8px 0;padding:9px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--bdr);font-size:11px}
.ag-c .btns{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.dot-online{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse 2s ease-in-out infinite}
.dot-offline{width:8px;height:8px;border-radius:50%;background:var(--t3);display:inline-block}
.dot-starting{width:8px;height:8px;border-radius:50%;background:var(--amber);display:inline-block;animation:pulse 1s ease-in-out infinite}
.dot-launching{width:8px;height:8px;border-radius:50%;background:var(--blue);display:inline-block;animation:pulse 1.5s ease-in-out infinite}
.log{margin-top:14px;background:var(--bg2);border:1px solid var(--bdr);border-radius:10px;overflow:hidden}
.log-h{padding:6px 12px;border-bottom:1px solid var(--bdr);font-size:10px;color:var(--t2);display:flex;justify-content:space-between;align-items:center}
.log-b{padding:8px;max-height:130px;overflow-y:auto;font-family:'SF Mono',monospace;font-size:9px}
.pipe-stage{display:flex;align-items:center;gap:8px;padding:12px 14px;border-radius:9px;background:var(--bg);border:1px solid var(--bdr);margin-bottom:8px;transition:border-color .15s}
.pipe-stage:hover{border-color:var(--t3)}
.pipe-stage .num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.pipe-stage .info{flex:1;min-width:0}
.pipe-stage .lbl{font-size:12px;font-weight:600}
.pipe-stage .desc{font-size:10px;color:var(--t3);margin-top:1px}
.pipe-arrow{text-align:center;color:var(--t3);font-size:14px;margin:2px 0;user-select:none}
.deploy-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){.deploy-grid{grid-template-columns:1fr}}
</style></head><body><div class="w">
<div class="hdr">
  <div><h1><span style="font-size:22px">🚀</span> Mission Control</h1><div class="meta" id="sync">Waiting for sync...</div></div>
  <div style="display:flex;gap:6px;align-items:center">
    <span id="agent-count" style="font-size:10px;color:var(--t3);font-family:'SF Mono',monospace"></span>
    <button class="btn btn-blue" onclick="refresh()">⟳ Sync</button>
    <button class="btn" onclick="api('agents').then(d=>{if(d.ok){AG=d.agents;render()}})">⟳ Agents</button>
  </div>
</div>
<div class="stats" id="stats"></div>
<div class="tabs">
  <button class="tab on" data-t="board">▣ Board</button>
  <button class="tab" data-t="agents">⚡ Agents</button>
  <button class="tab" data-t="pipe">▸ Pipeline</button>
  <button class="tab" data-t="deploy">🚀 Deploy</button>
</div>
<div id="v"></div>
<div class="log"><div class="log-h"><span style="font-weight:500">Activity Log</span><button style="background:0;border:0;color:var(--t3);cursor:pointer;font-size:9px;padding:2px 6px" onclick="L=[];rlog()">Clear</button></div><div class="log-b" id="log"></div></div>
</div>
`;
const PAGE2 = `<script>
let T=[],AG=[],L=[],TAB='board';
const S=['Backlog','To Do','In Progress','Review','QA Validating','Done'];
const SC={Backlog:'#555d75','To Do':'#4a9eff','In Progress':'#f5a623',Review:'#b07cf5','QA Validating':'#ff8533',Done:'#2dd4a0'};
const AC={'🔧 Backend':'#4a9eff','🎨 Frontend':'#f06','🧪 QA':'#2dd4a0','🧪 QA2':'#20c9b0','⚙️ DevOps':'#f5a623','🔒 Security':'#f25757','♻️ Refactor':'#b07cf5','🏗️ Architect':'#f06'};
const AI={
  backend:{e:'🔧',n:'Backend',c:'#4a9eff',r:'Services, handlers, core logic'},
  frontend:{e:'🎨',n:'Frontend',c:'#f06',r:'Portal, templates, UI/UX'},
  qa:{e:'🧪',n:'QA',c:'#2dd4a0',r:'Validates agent work'},
  qa2:{e:'🔬',n:'QA2',c:'#20c9b0',r:'Parallel validation'},
  devops:{e:'⚙️',n:'DevOps',c:'#f5a623',r:'CI/CD, infra, migrations'},
  flex:{e:'🔒',n:'Flex',c:'#b07cf5',r:'Security / Refactor'}
};

function log(m,t='info'){L.push({time:new Date().toLocaleTimeString(),m,t});if(L.length>60)L=L.slice(-60);rlog()}
function rlog(){document.getElementById('log').innerHTML=L.map(l=>'<div style="color:'+({error:'#f25757',success:'#2dd4a0',warn:'#f5a623'}[l.t]||'#8e95ab')+'"><span style="opacity:.4">'+l.time+'</span> '+l.m+'</div>').join('');document.getElementById('log').scrollTop=9999}

async function api(r,b){
  log('\\u2192 '+r);
  try{const x=await fetch('/api/'+r,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
  const d=await x.json();if(d.ok)log('\\u2713 '+r+(d.msg?' \\u2014 '+d.msg:''),'success');else log('\\u2717 '+(d.error||d.output||r),'error');return d}
  catch(e){log('\\u2717 '+e.message,'error');return{ok:false}}
}

async function refresh(){
  log('Syncing...');
  const[b,a]=await Promise.all([api('board'),api('agents')]);
  if(b.ok)T=b.tasks;if(a.ok)AG=a.agents;
  document.getElementById('sync').textContent='Last sync: '+new Date().toLocaleTimeString();
  var online=(AG||[]).filter(function(a){return a.status==='online'}).length;
  document.getElementById('agent-count').textContent=online+'/'+((AG||[]).length)+' agents online';
  rstats();render();
  var hasIdle=(AG||[]).some(function(a){return !a.task&&!a.hasPrompt});
  var hasTodo=T.some(function(t){return t.status==='To Do'&&t.agent});
  var hasQAQueue=(AG||[]).some(function(a){return(a.name==='qa'||a.name==='qa2')&&a.queueCount>0&&!a.task});
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
  var total=T.length;
  document.getElementById('stats').innerHTML=
    '<div class="stat"><b style="color:var(--t1)">'+total+'</b><small>Total</small></div>'
    +['To Do','In Progress','Review','QA Validating','Done'].map(s=>
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
  var online=AG.filter(function(a){return a.status==='online'}).length;
  var h='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
  h+='<div style="display:flex;align-items:center;gap:10px">';
  h+='<span style="font-size:13px;font-weight:600">Agent Fleet</span>';
  h+='<span style="font-size:10px;padding:3px 10px;border-radius:12px;font-weight:600;'+(online>0?'background:rgba(45,212,160,.12);color:#2dd4a0;border:1px solid rgba(45,212,160,.25)':'background:rgba(85,93,117,.12);color:#555d75;border:1px solid rgba(85,93,117,.25)')+'">'+online+'/'+AG.length+' online</span>';
  h+='</div>';
  h+='<div style="display:flex;gap:6px">';
  h+='<button class="btn btn-green" onclick="startAllAgents()">\\u25B6 Launch all</button>';
  h+='<button class="btn btn-red" onclick="stopAll()">\\u23F9 Stop all</button>';
  h+='<button class="btn" onclick="refreshAgents()">\\u21BB Refresh</button>';
  h+='</div></div>';
  h+='<div class="ag">';
  h+=AG.map(function(a){
    var i=AI[a.name]||AI.backend;
    var sm={online:{l:"Online",dot:"dot-online",bg:"rgba(45,212,160,.06)",bc:"rgba(45,212,160,.2)"},"has-task":{l:"Starting",dot:"dot-starting",bg:"rgba(245,166,35,.06)",bc:"rgba(245,166,35,.2)"},"has-prompt":{l:"Launching",dot:"dot-launching",bg:"rgba(74,158,255,.06)",bc:"rgba(74,158,255,.2)"},offline:{l:"Offline",dot:"dot-offline",bg:"transparent",bc:"var(--bdr)"}};
    var st=sm[a.status]||sm.offline;
    var card='<div class="ag-c" style="border-color:'+st.bc+';background:'+st.bg+'">';
    card+='<div class="ag-top">';
    card+='<div style="display:flex;align-items:center;gap:10px">';
    card+='<div class="ag-icon" style="background:'+i.c+'18;border:1px solid '+i.c+'30">'+i.e+'</div>';
    card+='<div><div style="font-size:13px;font-weight:700">'+i.n+'</div>';
    card+='<div style="font-size:10px;color:var(--t3);margin-top:1px">'+i.r+'</div></div></div>';
    card+='<div style="display:flex;align-items:center;gap:5px"><span class="'+st.dot+'"></span><span style="font-size:10px;color:var(--t2);font-weight:500">'+st.l+'</span></div>';
    card+='</div>';
    card+='<div class="ag-body">';
    if(a.task){
      card+='<div class="tk"><div style="display:flex;align-items:center;gap:6px"><span style="color:'+i.c+';font-size:10px">\\u25CF</span><b style="font-size:11px">'+a.task.title+'</b></div>';
      if(a.task.priority){card+='<div style="margin-top:3px;display:flex;gap:4px"><span class="badge" style="background:var(--bg3);color:var(--t2)">'+a.task.priority+'</span></div>';}
      card+='</div>';
    }else{
      card+='<div class="tk" style="color:var(--t3);text-align:center;font-size:10px;padding:12px">Idle \\u2014 waiting for task</div>';
    }
    if((a.name==="qa"||a.name==="qa2")&&a.queueCount>0){
      card+='<div style="font-size:10px;padding:5px 8px;border-radius:6px;background:rgba(255,133,51,.08);border:1px solid rgba(255,133,51,.2);color:#ff8533;margin-bottom:6px;display:flex;align-items:center;gap:4px"><span>\\u23F3</span>'+a.queueCount+' queued</div>';
    }
    if(a.pid){card+='<div style="font-size:9px;color:var(--t3);font-family:SF Mono,monospace;margin-bottom:4px">PID '+a.pid+'</div>';}
    card+='<div class="btns">';
    if(a.status==="online"){
      card+='<button class="btn btn-red" onclick="stopAgent(&#39;'+a.name+'&#39;)">\\u23F9 Stop</button>';
    }else if(a.status==="has-task"||a.status==="has-prompt"){
      card+='<span style="font-size:10px;color:var(--amber);padding:3px 0">Auto-launching...</span>';
    }else{
      card+='<button class="btn btn-green" onclick="startAgent(&#39;'+a.name+'&#39;)">\\u25B6 Launch</button>';
    }
    card+='<button class="btn" onclick="viewTerminal(&#39;'+a.name+'&#39;)">\\uD83D\\uDCBB</button>';
    card+='<button class="btn btn-blue" onclick="checkAgent(&#39;'+a.name+'&#39;)">Logs</button>';
    card+='<button class="btn btn-purple" onclick="agentGitLog(&#39;'+a.name+'&#39;)">Git</button>';
    card+='</div><div class="out" id="out-'+a.name+'" style="display:none"></div>';
    card+='</div></div>';
    return card;
  }).join('')+'</div>';
  h+='<div style="margin-top:12px;padding:12px;border-radius:10px;background:var(--bg2);border:1px solid var(--bdr);font-size:11px;color:var(--t2)">';
  h+='\\u2699\\uFE0F <b>Auto-orchestration active.</b> Agents loop: execute \\u2192 complete \\u2192 notify \\u2192 next task. Move tasks to To Do in Notion \\u2014 agents handle the rest.';
  h+='</div>';
  h+='<div style="margin-top:12px;background:var(--bg2);border-radius:12px;border:1px solid var(--bdr);padding:14px">';
  h+='<div style="font-size:12px;font-weight:600;color:var(--t2);margin-bottom:10px;display:flex;align-items:center;gap:6px">\\uD83C\\uDFAF Dispatch Task</div>';
  h+='<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">';
  h+='<input id="dispatch-task-id" placeholder="Notion task ID (e.g. 334ad49d-...)" style="flex:2;min-width:200px;background:var(--bg);border:1px solid var(--bdr);border-radius:7px;padding:7px 12px;color:var(--t1);font:inherit;font-size:12px;outline:none;transition:border-color .15s" onfocus="this.style.borderColor=&#39;var(--blue)&#39;" onblur="this.style.borderColor=&#39;var(--bdr)&#39;">';
  h+='<select id="dispatch-agent" style="background:var(--bg);border:1px solid var(--bdr);border-radius:7px;padding:7px 12px;color:var(--t1);font:inherit;font-size:12px;outline:none">';
  h+='<option value="">Auto (from Agent field)</option>';
  h+='<option value="backend">\\uD83D\\uDD27 Backend</option>';
  h+='<option value="frontend">\\uD83C\\uDFA8 Frontend</option>';
  h+='<option value="qa">\\uD83E\\uDDEA QA</option>';
  h+='<option value="qa2">\\uD83D\\uDD2C QA2</option>';
  h+='<option value="devops">\\u2699\\uFE0F DevOps</option>';
  h+='<option value="flex">\\uD83D\\uDD12 Flex</option>';
  h+='</select>';
  h+='<button class="btn btn-blue" onclick="dispatchSingle()">\\u25B8 Dispatch</button>';
  h+='<button class="btn" onclick="listTodo()">\\uD83D\\uDCCB To Do</button>';
  h+='</div>';
  h+='<div class="out" id="dispatch-out" style="display:none;max-height:160px"></div>';
  h+='</div>';
  return h;
}
async function startAgent(n){log("Launching "+n+"...");var d=await api("start-agent",{agent:n});showOut(n,d.output||"Launched");setTimeout(refreshAgents,4000)}
async function stopAgent(n){log("Stopping "+n+"...");var d=await api("stop-agent",{agent:n});showOut(n,d.output||"Stopped");setTimeout(refreshAgents,2000)}
async function checkAgent(n){var d=await api("agent-log",{agent:n});showOut(n,d.output||"No task files")}
async function agentGitLog(n){var d=await api("agent-branches",{agent:n});showOut(n,d.output||"No commits")}
async function startAllAgents(){for(var n of["backend","frontend","qa","qa2","devops","flex"]){await startAgent(n);await new Promise(function(r){setTimeout(r,2000)})}}
async function stopAll(){
  log("Stopping all agents...");
  await Promise.all(["backend","frontend","qa","qa2","devops","flex"].map(n=>stopAgent(n)));
  setTimeout(refreshAgents,2500);
}
async function refreshAgents(){var d=await api("agents");if(d.ok){AG=d.agents;render()}}
async function viewTerminal(n){log("Focusing "+n+" terminal...");var d=await api("view-terminal",{agent:n});showOut(n,d.output||"No terminal found")}
function showOut(n,t){var el=document.getElementById("out-"+n);if(el){el.style.display="block";el.textContent=t}}
async function dispatchSingle(){
  var taskId=(document.getElementById("dispatch-task-id")||{}).value||"";
  var agent=(document.getElementById("dispatch-agent")||{}).value||"";
  if(!taskId.trim()){showDispatch("\\u274C Paste a Notion task ID first");return}
  showDispatch("\\u27F3 Dispatching...");
  var d=await api("dispatch-single",{taskId:taskId.trim(),agent:agent||undefined});
  showDispatch(d.output||(d.ok?"\\u2705 Done":"\\u274C Failed"));
  if(d.ok) setTimeout(refreshAgents,1500);
}
async function listTodo(){
  showDispatch("\\u27F3 Loading To Do tasks from Notion...");
  var d=await api("list-todo");
  if(!d.ok){showDispatch("\\u274C "+d.error);return}
  var tasks=d.tasks||[];
  if(!tasks.length){showDispatch("\\u2705 No To Do or Backlog tasks found");return}
  var lines=tasks.map(function(t){
    var agentWarn=t.agent?"":"  \\u26A0\\uFE0F NO AGENT";
    return t.id+"  ["+t.priority+"] ["+t.agent+"]"+agentWarn+"\\n  "+t.title;
  });
  showDispatch("To Do / Backlog ("+tasks.length+"):\\n\\n"+lines.join("\\n\\n")+"\\n\\n\\u2500 Click ID to copy & paste above \\u2500");
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
  if(r==='dispatch-start'){await api('dispatch');await new Promise(r2=>setTimeout(r2,2000));await startAllAgents();btn.classList.remove('run');btn.textContent='▸ Run';return}
  const d=await api(r);btn.classList.remove('run');btn.textContent='▸ Run';
  var o=document.getElementById('pipe-out')||document.getElementById('pipe-out2');
  if(d.output){o.style.display='block';o.textContent=d.output}
}
async function bulkMove(from,to){const ids=T.filter(t=>t.status===from).map(t=>t.id);if(!ids.length){log('No tasks in '+from,'warn');return}await api('bulk-move',{ids,status:to});refresh()}

function rDeploy(){
  var done=T.filter(function(t){return t.status==='Done'});
  var review=T.filter(function(t){return t.status==='Review'}).length;
  var qaing=T.filter(function(t){return t.status==='QA Validating'}).length;
  var h='<div class="deploy-grid">';
  h+='<div>';
  h+='<div class="sec"><h3>\\uD83D\\uDE80 Deploy Pipeline</h3>';
  h+='<p style="font-size:10px;color:var(--t3);margin-bottom:12px;line-height:1.5">Sequential deployment: agent branches \\u2192 develop \\u2192 main \\u2192 production.<br>Each step validates before proceeding.</p>';
  h+='<div class="pipe-stage"><div class="num" style="background:rgba(74,158,255,.15);color:#4a9eff">1</div>';
  h+='<div class="info"><div class="lbl">Merge agents \\u2192 develop</div><div class="desc">git merge all agent/* branches into develop</div></div>';
  h+='<button class="btn btn-blue" id="c-merge-develop" onclick="runP(&#39;merge-develop&#39;,this)">\\u25B8 Run</button></div>';
  h+='<div class="pipe-arrow">\\u25BC</div>';
  h+='<div class="pipe-stage"><div class="num" style="background:rgba(176,124,245,.15);color:#b07cf5">2</div>';
  h+='<div class="info"><div class="lbl">Promote develop \\u2192 main</div><div class="desc">Merge, generate CHANGELOG.md via git-cliff, push</div></div>';
  h+='<button class="btn btn-purple" id="c-merge-main" onclick="runP(&#39;merge-main&#39;,this)">\\u25B8 Run</button></div>';
  h+='<div class="pipe-arrow">\\u25BC</div>';
  h+='<div class="pipe-stage"><div class="num" style="background:rgba(45,212,160,.15);color:#2dd4a0">3</div>';
  h+='<div class="info"><div class="lbl">Deploy to production</div><div class="desc">Build, backup, rsync, PM2 restart, health check</div></div>';
  h+='<button class="btn btn-green" id="c-deploy" onclick="runP(&#39;deploy&#39;,this)">\\u25B8 Deploy</button></div>';
  h+='<div class="out" id="pipe-out" style="display:none"></div>';
  h+='</div>';
  h+='<div class="sec" style="margin-top:12px"><h3>\\uD83D\\uDEE1 Server</h3>';
  h+='<div class="pipe-stage"><div class="num" style="background:rgba(74,158,255,.12);color:#4a9eff;font-size:14px">\\u2139</div>';
  h+='<div class="info"><div class="lbl">Server status</div><div class="desc">PM2 process list</div></div>';
  h+='<button class="btn btn-blue" id="c-server-status" onclick="runP(&#39;server-status&#39;,this)">Check</button></div>';
  h+='<div class="pipe-stage"><div class="num" style="background:rgba(242,87,87,.12);color:#f25757;font-size:14px">\\u21A9</div>';
  h+='<div class="info"><div class="lbl">Rollback</div><div class="desc">Restore previous deployment</div></div>';
  h+='<button class="btn btn-red" id="c-rollback" onclick="runP(&#39;rollback&#39;,this)">Rollback</button></div>';
  h+='<div class="pipe-stage"><div class="num" style="background:rgba(245,166,35,.12);color:#f5a623;font-size:14px">\\u21C5</div>';
  h+='<div class="info"><div class="lbl">Sync from server</div><div class="desc">Dry-run to see changed files</div></div>';
  h+='<button class="btn btn-amber" id="c-sync-server" onclick="runP(&#39;sync-server&#39;,this)">Sync</button></div>';
  h+='<div class="out" id="pipe-out2" style="display:none"></div>';
  h+='</div>';
  h+='</div>';
  h+='<div>';
  h+='<div class="sec"><h3>\\u2705 Ready to ship <span style="font-size:10px;font-weight:400;color:var(--t3);margin-left:4px">('+done.length+' tasks)</span></h3>';
  if(done.length===0){
    h+='<div style="text-align:center;padding:20px;color:var(--t3);font-size:11px">No completed tasks yet</div>';
  }else{
    h+=done.slice(0,15).map(function(t){
      var agColor=AC[t.agent]||'#555d75';
      return '<div style="font-size:11px;padding:6px 10px;border-radius:6px;background:var(--bg);border:1px solid var(--bdr);margin-bottom:4px;display:flex;align-items:center;gap:6px">'
        +'<span style="color:#2dd4a0;font-size:12px">\\u2713</span>'
        +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+t.title+'</span>'
        +(t.agent?'<span class="badge" style="background:'+agColor+'15;color:'+agColor+';flex-shrink:0">'+t.agent+'</span>':'')
        +'</div>';
    }).join('');
    if(done.length>15){h+='<div style="font-size:9px;color:var(--t3);text-align:center;margin-top:6px">+'+(done.length-15)+' more</div>';}
  }
  h+='</div>';
  h+='<div class="sec"><h3>\\uD83D\\uDCCA Pipeline Status</h3>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  h+='<div style="padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--bdr);text-align:center"><div style="font-size:18px;font-weight:700;color:var(--purple)">'+review+'</div><div style="font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">In Review</div></div>';
  h+='<div style="padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--bdr);text-align:center"><div style="font-size:18px;font-weight:700;color:var(--orange)">'+qaing+'</div><div style="font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">QA Validating</div></div>';
  h+='<div style="padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--bdr);text-align:center"><div style="font-size:18px;font-weight:700;color:var(--green)">'+done.length+'</div><div style="font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Done</div></div>';
  h+='<div style="padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--bdr);text-align:center"><div style="font-size:18px;font-weight:700;color:var(--t1)">'+T.length+'</div><div style="font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Total</div></div>';
  h+='</div></div>';
  h+='</div>';
  h+='</div>';
  return h;
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

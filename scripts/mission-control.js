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
  return ['backend','qa','devops','flex'].map(name => {
    let task = null, hasPrompt = false, running = false;
    try { task = JSON.parse(fs.readFileSync(path.join(WORKTREES, name, '.agent-task.json'), 'utf8')); } catch {}
    try { hasPrompt = fs.existsSync(path.join(WORKTREES, name, '.agent-prompt.md')); } catch {}
    try { running = !!execSync(`pgrep -f "nexushub-worktrees/${name}" 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch {}
    return { name, task, hasPrompt, running, status: running ? 'running' : task ? 'has-task' : 'idle' };
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
    if (route === 'dispatch') return send(res, await run(`node ${SCRIPT('dispatch-tasks.js')}`));
    if (route === 'clear-stale') { await run(`rm -f ${WORKTREES}/*/.agent-task.json ${WORKTREES}/*/.agent-prompt.md`); return send(res, {ok:true,output:'Stale files cleared'}); }
    if (route === 'agent-done') { const b = await readBody(req); return send(res, await run(`node ${SCRIPT('agent-complete.js')} --agent ${b.agent} --summary "${(b.summary||'done').replace(/"/g,'\\\\"')}"`)); }
    if (route === 'merge-develop') return send(res, await run('git fetch origin && git merge origin/agent/backend --no-edit 2>/dev/null; git merge origin/agent/qa --no-edit 2>/dev/null; git merge origin/agent/devops --no-edit 2>/dev/null; git push origin HEAD:develop', path.join(WORKTREES, 'backend')));
    if (route === 'merge-main') return send(res, await run('git fetch origin && git checkout main && git pull origin main && git merge origin/develop --no-edit && git push origin main'));
    if (route === 'deploy') return send(res, await run(`./scripts/deploy.sh`));
    if (route === 'git-status') return send(res, await run('git fetch --all 2>/dev/null; echo "=== Branch ===" && git branch --show-current && echo "=== Status ===" && git status --short && echo "=== Recent ===" && git log --oneline -8'));
    if (route === 'run-tests') return send(res, await run('npx vitest run 2>&1 | tail -40'));
    if (route === 'typecheck') return send(res, await run('npx tsc --noEmit 2>&1 | tail -25'));
    if (route === 'agent-log') { const b = await readBody(req); try { const f = path.join(WORKTREES, b.agent, '.agent-prompt.md'); const t = path.join(WORKTREES, b.agent, '.agent-task.json'); let out = ''; if(fs.existsSync(t)) out += '=== Task ===\n'+fs.readFileSync(t,'utf8')+'\n'; if(fs.existsSync(f)) out += '=== Prompt ===\n'+fs.readFileSync(f,'utf8'); return send(res, {ok:true,output:out||'No task files found'}); } catch(e) { return send(res,{ok:false,output:e.message}); } }
    if (route === 'start-agent') { const b = await readBody(req); const script = `tell application "iTerm" \nactivate\ntell current window\nset t to current tab\ntell item 1 of sessions of t\nwrite text "cd ${WORKTREES}/${b.agent} && claude --dangerously-skip-permissions"\nend tell\nend tell\nend tell`; const r2 = await run(`osascript -e '${script.replace(/'/g,"'\\''")}'`); return send(res, {ok:true,output:`Agent ${b.agent} launched in iTerm`}); }
    if (route === 'stop-agent') { const b = await readBody(req); await run(`pkill -f "nexushub-worktrees/${b.agent}" 2>/dev/null || true`); return send(res, {ok:true,output:`Agent ${b.agent} stopped`}); }
    if (route === 'write-prompt') { const b = await readBody(req); fs.writeFileSync(path.join(WORKTREES,b.agent,'.agent-prompt.md'), b.prompt); return send(res, {ok:true,output:`Prompt written to ${b.agent}/.agent-prompt.md`}); }
    return send(res, {ok:false,error:'Unknown route'}, 404);
  } catch(e) { return send(res, {ok:false,error:e.message}, 500); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
  if (req.url.startsWith('/api/')) return handleAPI(req, res);
  res.writeHead(200, {'Content-Type':'text/html'});
  res.end(PAGE + PAGE2 + PAGE3 + PAGE4 + PAGE5 + PAGE6);
});
server.listen(PORT, () => console.log(`\n🚀 Mission Control → http://localhost:${PORT}\n   Notion: ${NOTION_TOKEN?'✅':'❌'}  Repo: ${REPO}\n`));

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
const AC={'🔧 Backend':'#4a9eff','🧪 QA':'#2dd4a0','⚙️ DevOps':'#f5a623','🔒 Security':'#f25757','♻️ Refactor':'#b07cf5','🏗️ Architect':'#f06'};
const AI={backend:{e:'🔧',n:'Backend',c:'#4a9eff',r:'Features, services, handlers'},qa:{e:'🧪',n:'QA',c:'#2dd4a0',r:'Validates other agents work'},devops:{e:'⚙️',n:'DevOps',c:'#f5a623',r:'CI/CD, infra, migrations'},flex:{e:'🔒/♻️',n:'Flex',c:'#b07cf5',r:'Security or Refactor'}};

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
  rstats();render()
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
const PAGE4 = `<script>
function rAgents(){
  return '<div class="ag">'+AG.map(a=>{
    const i=AI[a.name]||AI.backend;
    const ip=T.filter(t=>{const m={'🔧 Backend':'backend','🧪 QA':'qa','⚙️ DevOps':'devops','🔒 Security':'flex','♻️ Refactor':'flex','🏗️ Architect':'backend'};return m[t.agent]===a.name&&t.status==='In Progress'});
    const st=a.status==='running'?'<span class="badge" style="background:#2dd4a022;color:#2dd4a0">● Running</span>'
      :a.status==='has-task'?'<span class="badge" style="background:#f5a62322;color:#f5a623">◉ Has task</span>'
      :'<span class="badge" style="background:#555d7522;color:#555d75">○ Idle</span>';
    return '<div class="ag-c" style="border-left-color:'+i.c+'"><div class="hd"><div><span style="font-size:16px">'+i.e+'</span> <b>'+i.n+'</b></div>'+st+'</div>'
      +'<div style="font-size:10px;color:var(--t2);margin-top:2px">'+i.r+'</div>'
      +(a.task?'<div class="tk"><b>'+a.task.title+'</b><div style="color:var(--t3);margin-top:2px">'+(a.task.priority||'')+' · '+(a.task.agent||'')+'</div></div>':'<div class="tk" style="color:var(--t3)">No task assigned</div>')
      +'<div class="btns">'
      +'<button class="btn btn-green" onclick="startAgent(\\''+a.name+'\\')">▸ Start</button>'
      +'<button class="btn btn-red" onclick="stopAgent(\\''+a.name+'\\')">■ Stop</button>'
      +'<button class="btn btn-blue" onclick="checkAgent(\\''+a.name+'\\')">👁 Check</button>'
      +'<button class="btn btn-amber" onclick="markDone(\\''+a.name+'\\')">✓ Done</button>'
      +'<button class="btn" onclick="clearAgent(\\''+a.name+'\\')">✕ Clear</button>'
      +'</div>'
      +'<div class="out" id="out-'+a.name+'" style="display:none"></div>'
      +'</div>'
  }).join('')+'</div>'
}
async function startAgent(n){log('Starting '+n+'...');const d=await api('start-agent',{agent:n});showOut(n,d.output||'Launched')}
async function stopAgent(n){log('Stopping '+n+'...');const d=await api('stop-agent',{agent:n});showOut(n,d.output||'Stopped');api('agents').then(d=>{if(d.ok){AG=d.agents;render()}})}
async function checkAgent(n){const d=await api('agent-log',{agent:n});showOut(n,d.output||'No info')}
async function markDone(n){const d=await api('agent-done',{agent:n,summary:'completed via Mission Control'});showOut(n,d.output||'Done');refresh()}
async function clearAgent(n){await api('clear-stale');showOut(n,'Task files cleared');api('agents').then(d=>{if(d.ok){AG=d.agents;render()}})}
function showOut(n,txt){const el=document.getElementById('out-'+n);if(el){el.style.display='block';el.textContent=txt}}
</script>`;
const PAGE5 = `<script>
function rPipe(){
  const rv=T.filter(t=>t.status==='Review').length;
  const qa=T.filter(t=>t.status==='QA Validating').length;
  return '<div class="sec"><h3>⚡ Pipeline commands</h3>'
    +cmdR('Clear stale files','Remove .agent-task.json + .agent-prompt.md from all worktrees','clear-stale','btn-red')
    +cmdR('Dispatch tasks','Assign To Do tasks to idle agents based on Agent tag','dispatch','btn-blue')
    +cmdR('Run test suite','npx vitest run','run-tests','btn-green')
    +cmdR('Type check','npx tsc --noEmit','typecheck','btn-amber')
    +cmdR('Git status','Branch, changes, recent commits','git-status','btn-purple')
    +'<div class="out" id="pipe-out" style="display:none"></div></div>'
    +'<div class="sec"><h3>📋 Bulk Notion actions</h3><div style="display:flex;gap:6px;flex-wrap:wrap">'
    +'<button class="btn btn-big btn-orange" onclick="bulkMove(\\'Review\\',\\'QA Validating\\')">Review → QA ('+rv+')</button>'
    +'<button class="btn btn-big btn-green" onclick="bulkMove(\\'QA Validating\\',\\'Done\\')">QA → Done ('+qa+')</button>'
    +'<button class="btn btn-big btn-blue" onclick="bulkMove(\\'To Do\\',\\'In Progress\\')">To Do → In Progress</button>'
    +'</div></div>'
}
function cmdR(l,d,r,c){return '<div class="row"><div><div class="lbl">'+l+'</div><div class="desc">'+d+'</div></div><button class="btn '+c+'" id="c-'+r+'" onclick="runP(\\''+r+'\\',this)">▸ Run</button></div>'}
async function runP(r,btn){btn.classList.add('run');btn.textContent='⟳...';const d=await api(r);btn.classList.remove('run');btn.textContent='▸ Run';const o=document.getElementById('pipe-out');if(d.output){o.style.display='block';o.textContent=d.output}}
async function bulkMove(from,to){const ids=T.filter(t=>t.status===from).map(t=>t.id);if(!ids.length){log('No tasks in '+from,'warn');return}await api('bulk-move',{ids,status:to});refresh()}

function rDeploy(){
  const done=T.filter(t=>t.status==='Done').slice(0,12);
  return '<div class="sec"><h3>🚀 Merge + Deploy</h3><p style="font-size:11px;color:var(--t2);margin-bottom:10px">Sequential: agent branches → develop → main → production</p>'
    +cmdR('1. Merge agents → develop','git merge origin/agent/backend + qa + devops into develop','merge-develop','btn-blue')
    +cmdR('2. Merge develop → main','Promote develop to main for release','merge-main','btn-purple')
    +cmdR('3. Deploy to production','Build, backup, rsync, PM2 restart, health check','deploy','btn-green')
    +'<div class="out" id="pipe-out" style="display:none"></div></div>'
    +'<div class="sec"><h3>✓ Done (ready to ship)</h3>'
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
</script></body></html>`;

/**
 * QA Validation — Mission Control Redesign
 *
 * Validates: FRONTEND: Redesign Mission Control agent dashboard — 6-agent grid + enhanced Deploy tab
 * Validates structural correctness of the mission-control.js UI templates and server logic.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MC_PATH = path.resolve(__dirname, '../../scripts/mission-control.js');
let mcSource: string;

beforeAll(() => {
  mcSource = fs.readFileSync(MC_PATH, 'utf8');
});

describe('Mission Control — 6-agent grid', () => {
  const REQUIRED_AGENTS = ['backend', 'qa', 'devops', 'flex', 'frontend', 'qa2'];

  it('AGENT_MAP includes all 6 agent worktree targets', () => {
    for (const agent of REQUIRED_AGENTS) {
      expect(mcSource).toContain(`'${agent}'`);
    }
    // AGENT_MAP values
    const agentMapMatch = mcSource.match(/const AGENT_MAP\s*=\s*\{([^}]+)\}/);
    expect(agentMapMatch).toBeTruthy();
    const mapBlock = agentMapMatch![1];
    for (const agent of REQUIRED_AGENTS) {
      expect(mapBlock).toContain(`'${agent}'`);
    }
  });

  it('agentStatus() iterates all 6 agents', () => {
    const statusMatch = mcSource.match(/return \[([^\]]+)\]\.map\(name\s*=>/);
    expect(statusMatch).toBeTruthy();
    const agentList = statusMatch![1];
    for (const agent of REQUIRED_AGENTS) {
      expect(agentList).toContain(`'${agent}'`);
    }
  });

  it('AI map (client-side) defines icon/name/color/role for all 6 agents', () => {
    const aiMatch = mcSource.match(/const AI=\{([^}]+(?:\{[^}]*\}[^}]*)*)}/);
    expect(aiMatch).toBeTruthy();
    for (const agent of REQUIRED_AGENTS) {
      expect(mcSource).toContain(`${agent}:{e:`);
    }
  });

  it('startAllAgents() iterates all 6 agents', () => {
    const match = mcSource.match(/startAllAgents\(\)\{for\(var n of\[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const list = match![1];
    for (const agent of REQUIRED_AGENTS) {
      expect(list).toContain(`"${agent}"`);
    }
  });

  it('stopAll() iterates all 6 agents', () => {
    const match = mcSource.match(/stopAll\(\)\{[\s\S]*?\[([^\]]+)\]\.map/);
    expect(match).toBeTruthy();
    const list = match![1];
    for (const agent of REQUIRED_AGENTS) {
      expect(list).toContain(`"${agent}"`);
    }
  });

  it('dispatch dropdown includes Frontend and QA2 options', () => {
    expect(mcSource).toContain('<option value="frontend">');
    expect(mcSource).toContain('<option value="qa2">');
    expect(mcSource).toContain('<option value="backend">');
    expect(mcSource).toContain('<option value="qa">');
    expect(mcSource).toContain('<option value="devops">');
    expect(mcSource).toContain('<option value="flex">');
  });
});

describe('Mission Control — UI structure', () => {
  it('has 4 navigation tabs: Board, Agents, Pipeline, Deploy', () => {
    expect(mcSource).toContain('data-t="board"');
    expect(mcSource).toContain('data-t="agents"');
    expect(mcSource).toContain('data-t="pipe"');
    expect(mcSource).toContain('data-t="deploy"');
  });

  it('render() dispatches to all 4 tab renderers', () => {
    expect(mcSource).toContain('rBoard()');
    expect(mcSource).toContain('rAgents()');
    expect(mcSource).toContain('rPipe()');
    expect(mcSource).toContain('rDeploy()');
  });

  it('agent grid uses CSS grid with responsive columns', () => {
    expect(mcSource).toContain('grid-template-columns:repeat(auto-fit,minmax(280px,1fr))');
  });

  it('each agent card has unique accent color defined in AI map', () => {
    // 6 distinct colors in the AI map
    const colors = ['#4a9eff', '#2dd4a0', '#f5a623', '#b07cf5', '#f06', '#20c9b0'];
    for (const color of colors) {
      expect(mcSource).toContain(color);
    }
  });

  it('agent cards show animated status badges (Online/Starting/Launching/Offline)', () => {
    expect(mcSource).toContain('Online (auto-loop)');
    expect(mcSource).toContain('Starting...');
    expect(mcSource).toContain('Launching...');
    expect(mcSource).toContain('Offline');
  });
});

describe('Mission Control — Deploy tab', () => {
  it('has 3 merge/deploy stages', () => {
    expect(mcSource).toContain('Merge agents → develop');
    expect(mcSource).toContain('Merge develop → main');
    expect(mcSource).toContain('Deploy to production');
  });

  it('has server management section', () => {
    expect(mcSource).toContain('Server status');
    expect(mcSource).toContain('Rollback');
    expect(mcSource).toContain('Sync from server');
  });

  it('shows done tasks ready to ship', () => {
    expect(mcSource).toContain('Done tasks (ready to ship)');
  });
});

describe('Mission Control — Bug fix: startAllTasks → startAllAgents', () => {
  it('dispatch-start action calls startAllAgents (not startAllTasks)', () => {
    const dispatchStart = mcSource.match(/dispatch-start.*?startAll\w+/);
    expect(dispatchStart).toBeTruthy();
    expect(dispatchStart![0]).toContain('startAllAgents');
    expect(dispatchStart![0]).not.toContain('startAllTasks');
  });

  it('startAllTasks function does NOT exist anywhere', () => {
    expect(mcSource).not.toContain('function startAllTasks');
    expect(mcSource).not.toContain('async function startAllTasks');
  });
});

describe('Mission Control — QA routing', () => {
  it('QA_ROUTING maps backend+frontend to qa, devops+flex to qa2', () => {
    const routingMatch = mcSource.match(/const QA_ROUTING\s*=\s*\{([^}]+)\}/);
    expect(routingMatch).toBeTruthy();
    const block = routingMatch![1];
    expect(block).toContain("'backend': 'qa'");
    expect(block).toContain("'frontend': 'qa'");
    expect(block).toContain("'devops': 'qa2'");
    expect(block).toContain("'flex': 'qa2'");
  });

  it('QA queue count is tracked for both qa and qa2', () => {
    // Both QA agents check .qa-queue directory
    const queueCheck = mcSource.match(/name === 'qa' \|\| name === 'qa2'/g);
    expect(queueCheck).toBeTruthy();
    expect(queueCheck!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Mission Control — function references integrity', () => {
  const REQUIRED_FUNCTIONS = [
    'startAgent', 'stopAgent', 'startAllAgents', 'stopAll',
    'refreshAgents', 'viewTerminal', 'checkAgent', 'agentGitLog',
    'dispatchSingle', 'listTodo', 'showDispatch', 'showOut',
    'render', 'refresh', 'rstats', 'rlog', 'log', 'api',
    'rBoard', 'rAgents', 'rPipe', 'rDeploy',
    'moveT', 'cmdR', 'runP', 'bulkMove',
  ];

  it('all functions referenced in templates are defined', () => {
    for (const fn of REQUIRED_FUNCTIONS) {
      const defPattern = new RegExp(`(function\\s+${fn}|async\\s+function\\s+${fn}|${fn}\\s*=\\s*function|${fn}\\s*=\\s*async)`);
      expect(mcSource).toMatch(defPattern);
    }
  });
});

describe('Mission Control — server API routes', () => {
  const REQUIRED_ROUTES = [
    'board', 'agents', 'move-task', 'dispatch', 'auto-assign',
    'clear-stale', 'agent-done', 'merge-develop', 'merge-main',
    'deploy', 'git-status', 'run-tests', 'typecheck', 'agent-log',
    'qa-queue', 'start-agent', 'stop-agent', 'view-terminal',
    'write-prompt', 'rollback', 'server-status', 'start-task',
    'dispatch-single', 'list-todo', 'agent-branches',
  ];

  it('handleAPI covers all expected routes', () => {
    for (const route of REQUIRED_ROUTES) {
      expect(mcSource).toContain(`route === '${route}'`);
    }
  });
});

describe('Mission Control — auto-assign loop', () => {
  it('auto-assign interval is set to 45 seconds', () => {
    expect(mcSource).toContain('45000');
  });

  it('auto-assign processes both QA queue and Notion To Do tasks', () => {
    expect(mcSource).toContain('qa-queue');
    expect(mcSource).toContain('notion-todo');
  });

  it('auto-launch checks for agents with prompt but not running', () => {
    expect(mcSource).toContain('ag.hasPrompt && !ag.running');
  });

  it('auto-refresh in the browser is set to 30 seconds', () => {
    expect(mcSource).toContain('setInterval(refresh, 30000)');
  });
});

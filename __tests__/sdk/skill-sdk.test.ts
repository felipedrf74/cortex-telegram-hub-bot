/**
 * Tests for @nexushub/skill-sdk
 *
 * Covers: createSkill builder, defineTools, defineCommands, defineAgents,
 * validation, submodule dependency checks, and the hello-world example.
 */

import { describe, it, expect } from 'vitest';
import {
  createSkill, defineTools, defineCommands, defineAgents,
} from '../../src/sdk/index';
import type { NexusSkill, ToolDefinition, CommandDefinition, AgentDefinition } from '../../src/sdk/types';

// ── Helper ─────────────────────────────────────────────────────

const VALID_CONFIG = {
  name: 'test-skill',
  version: '1.0.0',
  description: 'A test skill',
};

const noop = async () => 'ok';

// ── defineTools ─────────────────────────────────────────────────

describe('defineTools', () => {
  it('builds an empty tool list', () => {
    const tools = defineTools().build();
    expect(tools).toEqual([]);
  });

  it('builds tools with parameters and handler', () => {
    const tools = defineTools()
      .tool('my_tool', 'Does stuff', { arg: { type: 'string', description: 'An arg' } }, noop, ['arg'])
      .build();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('my_tool');
    expect(tools[0].parameters.arg.type).toBe('string');
    expect(tools[0].required).toEqual(['arg']);
  });

  it('chains multiple tools', () => {
    const tools = defineTools()
      .tool('a', 'First', {}, noop)
      .tool('b', 'Second', {}, noop)
      .tool('c', 'Third', {}, noop)
      .build();
    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns a copy on build (not the internal array)', () => {
    const builder = defineTools().tool('a', 'X', {}, noop);
    const tools1 = builder.build();
    const tools2 = builder.build();
    expect(tools1).toEqual(tools2);
    expect(tools1).not.toBe(tools2);
  });
});

// ── defineCommands ──────────────────────────────────────────────

describe('defineCommands', () => {
  it('builds an empty command list', () => {
    expect(defineCommands().build()).toEqual([]);
  });

  it('builds a command with aliases', () => {
    const cmds = defineCommands()
      .command('recipe', 'Search recipes', noop, { aliases: ['cook'] })
      .build();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('recipe');
    expect(cmds[0].aliases).toEqual(['cook']);
  });

  it('builds a command without aliases', () => {
    const cmds = defineCommands()
      .command('help', 'Show help', noop)
      .build();
    expect(cmds[0].aliases).toBeUndefined();
  });
});

// ── defineAgents ────────────────────────────────────────────────

describe('defineAgents', () => {
  it('builds an empty agent list', () => {
    expect(defineAgents().build()).toEqual([]);
  });

  it('creates a scheduled agent', () => {
    const agents = defineAgents()
      .agent('digest', 'Daily digest', noop, { schedule: '0 9 * * *' })
      .build();
    expect(agents).toHaveLength(1);
    expect(agents[0].trigger).toBe('on_schedule');
    expect(agents[0].schedule).toBe('0 9 * * *');
  });

  it('creates a manual agent by default', () => {
    const agents = defineAgents()
      .agent('helper', 'Manual helper', noop)
      .build();
    expect(agents[0].trigger).toBe('manual');
  });

  it('respects explicit trigger', () => {
    const agents = defineAgents()
      .agent('watcher', 'Message watcher', noop, { trigger: 'on_message' })
      .build();
    expect(agents[0].trigger).toBe('on_message');
  });
});

// ── createSkill — builder ──────────────────────────────────────

describe('createSkill', () => {
  it('builds a minimal valid skill', () => {
    const skill = createSkill(VALID_CONFIG).build();
    expect(skill.config.name).toBe('test-skill');
    expect(skill.config.version).toBe('1.0.0');
    expect(skill.tools).toEqual([]);
    expect(skill.commands).toEqual([]);
    expect(skill.agents).toEqual([]);
    expect(skill.submodules).toEqual([]);
  });

  it('accepts tools, commands, agents, submodules, and routing', () => {
    const tools = defineTools().tool('t1', 'Tool 1', {}, noop).build();
    const commands = defineCommands().command('cmd1', 'Cmd 1', noop).build();
    const agents = defineAgents().agent('a1', 'Agent 1', noop).build();

    const skill = createSkill(VALID_CONFIG)
      .tools(tools)
      .commands(commands)
      .agents(agents)
      .submodules([{ name: 'core', description: 'Core', tools: ['t1'], enabledByDefault: true }])
      .routing({ commands: ['/cmd1'], keywords: ['test'] })
      .build();

    expect(skill.tools).toHaveLength(1);
    expect(skill.commands).toHaveLength(1);
    expect(skill.agents).toHaveLength(1);
    expect(skill.submodules).toHaveLength(1);
    expect(skill.routing.keywords).toEqual(['test']);
  });

  it('defaults enabledByDefault to true in submodules', () => {
    const tools = defineTools().tool('t1', 'X', {}, noop).build();
    const skill = createSkill(VALID_CONFIG)
      .tools(tools)
      .submodules([{ name: 'core', description: 'Core', tools: ['t1'] }])
      .build();
    expect(skill.submodules[0].enabledByDefault).toBe(true);
  });
});

// ── Validation ──────────────────────────────────────────────────

describe('createSkill validation', () => {
  it('rejects invalid name (uppercase)', () => {
    expect(() => createSkill({ ...VALID_CONFIG, name: 'Bad-Name' }).build())
      .toThrow('name must be lowercase');
  });

  it('rejects invalid name (starts with number)', () => {
    expect(() => createSkill({ ...VALID_CONFIG, name: '1bad' }).build())
      .toThrow('name must be lowercase');
  });

  it('rejects empty name', () => {
    expect(() => createSkill({ ...VALID_CONFIG, name: '' }).build())
      .toThrow('name');
  });

  it('rejects invalid version', () => {
    expect(() => createSkill({ ...VALID_CONFIG, version: 'v1' }).build())
      .toThrow('version must follow semver');
  });

  it('rejects missing description', () => {
    expect(() => createSkill({ name: 'ok', version: '1.0.0', description: '' }).build())
      .toThrow('description is required');
  });

  it('rejects duplicate tool names', () => {
    const tools = [
      { name: 'dup', description: 'A', parameters: {}, handler: noop },
      { name: 'dup', description: 'B', parameters: {}, handler: noop },
    ];
    expect(() => createSkill(VALID_CONFIG).tools(tools).build())
      .toThrow('duplicate tool name: dup');
  });

  it('rejects duplicate command names', () => {
    const cmds = defineCommands()
      .command('x', 'A', noop)
      .command('x', 'B', noop)
      .build();
    expect(() => createSkill(VALID_CONFIG).commands(cmds).build())
      .toThrow('duplicate command name: x');
  });

  it('rejects duplicate agent names', () => {
    const agents = defineAgents()
      .agent('a', 'A', noop)
      .agent('a', 'B', noop)
      .build();
    expect(() => createSkill(VALID_CONFIG).agents(agents).build())
      .toThrow('duplicate agent name: a');
  });

  it('rejects submodule referencing unknown tool', () => {
    const tools = defineTools().tool('real', 'Real tool', {}, noop).build();
    expect(() =>
      createSkill(VALID_CONFIG)
        .tools(tools)
        .submodules([{ name: 'mod', description: 'M', tools: ['real', 'fake'] }])
        .build()
    ).toThrow('references unknown tool: fake');
  });

  it('rejects scheduled agent without cron expression', () => {
    const agents = defineAgents()
      .agent('bad', 'No schedule', noop, { trigger: 'on_schedule' })
      .build();
    expect(() => createSkill(VALID_CONFIG).agents(agents).build())
      .toThrow('scheduled agents must have a cron expression');
  });

  it('validate() returns errors without throwing', () => {
    const result = createSkill({ name: '123BAD', version: 'nope', description: '' }).validate();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('validate() returns valid for good config', () => {
    const result = createSkill(VALID_CONFIG).validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ── Hello World Example ─────────────────────────────────────────

describe('hello-world example skill', () => {
  // Import is deferred to avoid side-effect issues in other tests
  let helloWorldSkill: NexusSkill;

  it('imports and builds without error', async () => {
    const mod = await import('../../src/sdk/examples/hello-world');
    helloWorldSkill = mod.helloWorldSkill;
    expect(helloWorldSkill).toBeDefined();
  });

  it('has correct config', async () => {
    const mod = await import('../../src/sdk/examples/hello-world');
    const skill = mod.helloWorldSkill;
    expect(skill.config.name).toBe('hello-world');
    expect(skill.config.version).toBe('1.0.0');
    expect(skill.config.author).toBe('NexusHub Team');
  });

  it('has 3 tools', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    expect(skill.tools).toHaveLength(3);
    expect(skill.tools.map(t => t.name)).toEqual(['hello_greet', 'hello_farewell', 'hello_echo']);
  });

  it('has 2 commands with aliases', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    expect(skill.commands).toHaveLength(2);
    expect(skill.commands[1].aliases).toEqual(['bye']);
  });

  it('has 1 scheduled agent', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    expect(skill.agents).toHaveLength(1);
    expect(skill.agents[0].schedule).toBe('0 8 * * *');
  });

  it('has 2 submodules with dependency', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    expect(skill.submodules).toHaveLength(2);
    expect(skill.submodules[1].dependencies).toEqual(['greetings']);
  });

  it('tool handlers return expected results', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    const greetTool = skill.tools.find(t => t.name === 'hello_greet')!;
    const result = await greetTool.handler({ name: 'Felipe' });
    expect(result).toContain('Felipe');
    expect(result).toContain('Hello');
  });

  it('command handlers return expected results', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    const helloCmd = skill.commands.find(c => c.name === 'hello')!;
    const result = await helloCmd.handler('Felipe', {} as any);
    expect(result).toContain('Felipe');
  });

  it('has routing with keywords and classification hint', async () => {
    const { helloWorldSkill: skill } = await import('../../src/sdk/examples/hello-world');
    expect(skill.routing.keywords).toContain('hello');
    expect(skill.routing.classificationHint?.examples).toHaveLength(2);
  });
});

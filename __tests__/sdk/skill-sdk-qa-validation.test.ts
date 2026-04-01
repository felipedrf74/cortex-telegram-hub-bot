/**
 * QA Validation Tests — @nexushub/skill-sdk Package
 *
 * Validates the SDK design against the task description:
 * 1. createSkill(manifest, handlers) API exists and works
 * 2. defineTools(), defineCommands(), defineAgents() builders exist
 * 3. TypeScript types + base classes + helpers are exported
 * 4. hello-world example skill builds successfully
 * 5. Template structure for nexushub create-skill CLI
 * 6. Validation catches edge cases: empty names, bad versions, missing handlers
 * 7. Submodule dependency resolution during validation
 * 8. Immutability of built skills
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// Import the SDK
import {
  createSkill, SkillBuilder,
  defineTools, ToolBuilder,
  defineCommands, CommandBuilder,
  defineAgents, AgentBuilder,
} from '../../src/sdk';

import type {
  SkillConfig, NexusSkill,
  ToolDefinition, ToolParameter, ToolHandler,
  CommandDefinition, CommandHandler, CommandContext,
  AgentDefinition, AgentHandler, AgentTrigger, AgentContext,
  SkillRouting, SubmoduleConfig,
  ValidationResult, ValidationError,
} from '../../src/sdk';

// ═══════════════════════════════════════════════════════════════════
// QA: SDK EXPORTS ARE COMPLETE
// ═══════════════════════════════════════════════════════════════════

describe('QA: SDK exports all required API surface', () => {
  it('exports createSkill function', () => {
    expect(typeof createSkill).toBe('function');
  });

  it('exports SkillBuilder class', () => {
    expect(SkillBuilder).toBeTruthy();
  });

  it('exports defineTools function', () => {
    expect(typeof defineTools).toBe('function');
  });

  it('exports ToolBuilder class', () => {
    expect(ToolBuilder).toBeTruthy();
  });

  it('exports defineCommands function', () => {
    expect(typeof defineCommands).toBe('function');
  });

  it('exports CommandBuilder class', () => {
    expect(CommandBuilder).toBeTruthy();
  });

  it('exports defineAgents function', () => {
    expect(typeof defineAgents).toBe('function');
  });

  it('exports AgentBuilder class', () => {
    expect(AgentBuilder).toBeTruthy();
  });

  it('index.ts re-exports all types needed by third-party developers', () => {
    const indexSource = fs.readFileSync(path.join(ROOT, 'src/sdk/index.ts'), 'utf-8');
    const requiredTypes = [
      'SkillConfig', 'NexusSkill',
      'ToolDefinition', 'ToolParameter', 'ToolHandler',
      'CommandDefinition', 'CommandHandler', 'CommandContext',
      'AgentDefinition', 'AgentHandler', 'AgentTrigger', 'AgentContext',
      'SkillRouting', 'SubmoduleConfig',
      'ValidationResult', 'ValidationError',
    ];
    for (const t of requiredTypes) {
      expect(indexSource, `should export type ${t}`).toContain(t);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: HELLO-WORLD EXAMPLE SKILL BUILDS SUCCESSFULLY
// ═══════════════════════════════════════════════════════════════════

describe('QA: hello-world example skill', () => {
  it('example file exists at sdk/examples/hello-world.ts', () => {
    const exists = fs.existsSync(path.join(ROOT, 'src/sdk/examples/hello-world.ts'));
    expect(exists).toBe(true);
  });

  it('hello-world skill builds without errors', async () => {
    const { helloWorldSkill } = await import('../../src/sdk/examples/hello-world');
    expect(helloWorldSkill).toBeTruthy();
    expect(helloWorldSkill.config.name).toBe('hello-world');
    expect(helloWorldSkill.config.version).toBe('1.0.0');
  });

  it('hello-world has tools, commands, agents, submodules, and routing', async () => {
    const { helloWorldSkill } = await import('../../src/sdk/examples/hello-world');
    expect(helloWorldSkill.tools.length).toBeGreaterThan(0);
    expect(helloWorldSkill.commands.length).toBeGreaterThan(0);
    expect(helloWorldSkill.agents.length).toBeGreaterThan(0);
    expect(helloWorldSkill.submodules.length).toBeGreaterThan(0);
    expect(helloWorldSkill.routing.keywords!.length).toBeGreaterThan(0);
  });

  it('hello-world demonstrates submodule dependencies', async () => {
    const { helloWorldSkill } = await import('../../src/sdk/examples/hello-world');
    const echo = helloWorldSkill.submodules.find(s => s.name === 'echo');
    expect(echo).toBeTruthy();
    expect(echo!.dependencies).toContain('greetings');
  });

  it('hello-world tools have working handlers', async () => {
    const { helloWorldSkill } = await import('../../src/sdk/examples/hello-world');
    const greetTool = helloWorldSkill.tools.find(t => t.name === 'hello_greet');
    expect(greetTool).toBeTruthy();
    const result = await greetTool!.handler({ name: 'Felipe' });
    expect(result).toContain('Felipe');
    expect(result).toContain('Hello');
  });

  it('hello-world commands have working handlers', async () => {
    const { helloWorldSkill } = await import('../../src/sdk/examples/hello-world');
    const helloCmd = helloWorldSkill.commands.find(c => c.name === 'hello');
    expect(helloCmd).toBeTruthy();
    const result = await helloCmd!.handler('Test', {} as any);
    expect(result).toContain('Test');
  });

  it('hello-world example imports from relative ../index (not package name)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/sdk/examples/hello-world.ts'), 'utf-8');
    expect(source).toContain("from '../index'");
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: BUILDER API FLUENT CHAINING
// ═══════════════════════════════════════════════════════════════════

describe('QA: builder pattern fluent chaining', () => {
  it('createSkill returns a SkillBuilder instance', () => {
    const builder = createSkill({ name: 'test', version: '1.0.0', description: 'Test' });
    expect(builder).toBeInstanceOf(SkillBuilder);
  });

  it('all SkillBuilder methods return this for chaining', () => {
    const builder = createSkill({ name: 'test', version: '1.0.0', description: 'Test' });
    const result = builder
      .tools([])
      .commands([])
      .agents([])
      .submodules([])
      .routing({});
    expect(result).toBe(builder);
  });

  it('defineTools returns a ToolBuilder instance', () => {
    const builder = defineTools();
    expect(builder).toBeInstanceOf(ToolBuilder);
  });

  it('ToolBuilder.tool returns this for chaining', () => {
    const builder = defineTools();
    const result = builder.tool('t1', 'desc', {}, async () => 'ok');
    expect(result).toBe(builder);
  });

  it('defineCommands returns a CommandBuilder instance', () => {
    const builder = defineCommands();
    expect(builder).toBeInstanceOf(CommandBuilder);
  });

  it('defineAgents returns an AgentBuilder instance', () => {
    const builder = defineAgents();
    expect(builder).toBeInstanceOf(AgentBuilder);
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: VALIDATION EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('QA: validation edge cases', () => {
  it('rejects empty name', () => {
    expect(() => {
      createSkill({ name: '', version: '1.0.0', description: 'test' }).build();
    }).toThrow();
  });

  it('rejects name with uppercase', () => {
    expect(() => {
      createSkill({ name: 'MySkill', version: '1.0.0', description: 'test' }).build();
    }).toThrow();
  });

  it('rejects name starting with number', () => {
    expect(() => {
      createSkill({ name: '123skill', version: '1.0.0', description: 'test' }).build();
    }).toThrow();
  });

  it('rejects name with spaces', () => {
    expect(() => {
      createSkill({ name: 'my skill', version: '1.0.0', description: 'test' }).build();
    }).toThrow();
  });

  it('accepts name with hyphens', () => {
    const skill = createSkill({ name: 'my-skill', version: '1.0.0', description: 'test' }).build();
    expect(skill.config.name).toBe('my-skill');
  });

  it('rejects invalid semver', () => {
    expect(() => {
      createSkill({ name: 'test', version: 'not-semver', description: 'test' }).build();
    }).toThrow();
  });

  it('rejects missing description', () => {
    expect(() => {
      createSkill({ name: 'test', version: '1.0.0', description: '' }).build();
    }).toThrow();
  });

  it('rejects duplicate tool names', () => {
    const tools = defineTools()
      .tool('same', 'A', {}, async () => 'ok')
      .tool('same', 'B', {}, async () => 'ok')
      .build();

    expect(() => {
      createSkill({ name: 'test', version: '1.0.0', description: 'test' })
        .tools(tools)
        .build();
    }).toThrow(/duplicate tool/i);
  });

  it('rejects duplicate command names', () => {
    const commands = defineCommands()
      .command('cmd', 'A', async () => 'ok')
      .command('cmd', 'B', async () => 'ok')
      .build();

    expect(() => {
      createSkill({ name: 'test', version: '1.0.0', description: 'test' })
        .commands(commands)
        .build();
    }).toThrow(/duplicate command/i);
  });

  it('rejects submodule referencing unknown tool', () => {
    expect(() => {
      createSkill({ name: 'test', version: '1.0.0', description: 'test' })
        .submodules([{
          name: 'core',
          description: 'Core',
          tools: ['nonexistent_tool'],
        }])
        .build();
    }).toThrow(/unknown tool/i);
  });

  it('rejects scheduled agent without cron expression', () => {
    const agents = defineAgents()
      .agent('broken', 'Missing schedule', async () => {}, { trigger: 'on_schedule' })
      .build();

    expect(() => {
      createSkill({ name: 'test', version: '1.0.0', description: 'test' })
        .agents(agents)
        .build();
    }).toThrow(/schedule/i);
  });

  it('validate() returns errors without throwing', () => {
    const builder = createSkill({ name: '', version: '', description: '' });
    const result = builder.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].field).toBeTruthy();
    expect(result.errors[0].message).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: BUILT SKILL IMMUTABILITY
// ═══════════════════════════════════════════════════════════════════

describe('QA: built skill immutability', () => {
  it('build() returns copies of arrays (not references)', () => {
    const tools = defineTools()
      .tool('t1', 'Tool 1', {}, async () => 'ok')
      .build();

    const skill = createSkill({ name: 'test', version: '1.0.0', description: 'test' })
      .tools(tools)
      .build();

    // Mutating the original tools array should not affect the built skill
    tools.push({ name: 't2', description: 'Tool 2', parameters: {}, handler: async () => 'ok' });
    expect(skill.tools).toHaveLength(1);
  });

  it('build() returns a copy of config (not reference)', () => {
    const config: SkillConfig = { name: 'test', version: '1.0.0', description: 'test' };
    const skill = createSkill(config).build();

    // Mutating the original config should not affect the built skill
    (config as any).name = 'modified';
    expect(skill.config.name).toBe('test');
  });

  it('submodules default enabledByDefault to true', () => {
    const tools = defineTools()
      .tool('my_tool', 'A tool', {}, async () => 'ok')
      .build();

    const skill = createSkill({ name: 'test', version: '1.0.0', description: 'test' })
      .tools(tools)
      .submodules([{ name: 'core', description: 'Core', tools: ['my_tool'] }])
      .build();

    expect(skill.submodules[0].enabledByDefault).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: AGENT TRIGGER DEFAULTS
// ═══════════════════════════════════════════════════════════════════

describe('QA: agent trigger defaults', () => {
  it('agent with schedule defaults trigger to on_schedule', () => {
    const agents = defineAgents()
      .agent('daily', 'Daily task', async () => {}, { schedule: '0 9 * * *' })
      .build();

    expect(agents[0].trigger).toBe('on_schedule');
    expect(agents[0].schedule).toBe('0 9 * * *');
  });

  it('agent without schedule defaults trigger to manual', () => {
    const agents = defineAgents()
      .agent('manual-agent', 'Manual task', async () => {})
      .build();

    expect(agents[0].trigger).toBe('manual');
  });

  it('explicit trigger overrides default', () => {
    const agents = defineAgents()
      .agent('watcher', 'Watches messages', async () => {}, { trigger: 'on_message' })
      .build();

    expect(agents[0].trigger).toBe('on_message');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: SDK FILE STRUCTURE FOR CLI TEMPLATE
// ═══════════════════════════════════════════════════════════════════

describe('QA: SDK file structure', () => {
  const sdkDir = path.join(ROOT, 'src/sdk');

  it('has index.ts barrel export', () => {
    expect(fs.existsSync(path.join(sdkDir, 'index.ts'))).toBe(true);
  });

  it('has types.ts for public types', () => {
    expect(fs.existsSync(path.join(sdkDir, 'types.ts'))).toBe(true);
  });

  it('has create-skill.ts', () => {
    expect(fs.existsSync(path.join(sdkDir, 'create-skill.ts'))).toBe(true);
  });

  it('has define-tools.ts', () => {
    expect(fs.existsSync(path.join(sdkDir, 'define-tools.ts'))).toBe(true);
  });

  it('has define-commands.ts', () => {
    expect(fs.existsSync(path.join(sdkDir, 'define-commands.ts'))).toBe(true);
  });

  it('has define-agents.ts', () => {
    expect(fs.existsSync(path.join(sdkDir, 'define-agents.ts'))).toBe(true);
  });

  it('has examples/ directory with hello-world', () => {
    expect(fs.existsSync(path.join(sdkDir, 'examples/hello-world.ts'))).toBe(true);
  });

  it('all SDK files have copyright header', () => {
    const files = ['index.ts', 'types.ts', 'create-skill.ts', 'define-tools.ts', 'define-commands.ts', 'define-agents.ts'];
    for (const file of files) {
      const content = fs.readFileSync(path.join(sdkDir, file), 'utf-8');
      expect(content, `${file} should have copyright header`).toContain('Copyright');
    }
  });
});

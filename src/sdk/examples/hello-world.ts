// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Hello World — Example NexusHub skill.
 *
 * Demonstrates: createSkill, defineTools, defineCommands, defineAgents,
 * submodules, routing, and dependency declarations.
 *
 * This is a template for `nexushub create-skill`.
 */

import { createSkill, defineTools, defineCommands, defineAgents } from '../index';

// ── Tools ────────────────────────────────────────────────────────

const tools = defineTools()
  .tool(
    'hello_greet',
    'Greet a user by name',
    { name: { type: 'string', description: 'The name to greet' } },
    async (params) => `Hello, ${params.name}! Welcome to NexusHub.`,
    ['name'],
  )
  .tool(
    'hello_farewell',
    'Say goodbye to a user',
    { name: { type: 'string', description: 'The name to say goodbye to' } },
    async (params) => `Goodbye, ${params.name}! See you next time.`,
    ['name'],
  )
  .tool(
    'hello_echo',
    'Echo a message back',
    { message: { type: 'string', description: 'The message to echo' } },
    async (params) => `Echo: ${params.message}`,
    ['message'],
  )
  .build();

// ── Commands ─────────────────────────────────────────────────────

const commands = defineCommands()
  .command('hello', 'Say hello', async (args) => {
    const name = args.trim() || 'World';
    return `👋 Hello, ${name}!`;
  })
  .command('goodbye', 'Say goodbye', async (args) => {
    const name = args.trim() || 'friend';
    return `👋 Goodbye, ${name}!`;
  }, { aliases: ['bye'] })
  .build();

// ── Agents ───────────────────────────────────────────────────────

const agents = defineAgents()
  .agent(
    'daily-greeting',
    'Send a daily good morning message',
    async (ctx) => {
      return `Good morning! Your hello-world skill is running on ${ctx.skillName}.`;
    },
    { schedule: '0 8 * * *' },
  )
  .build();

// ── Build the skill ──────────────────────────────────────────────

export const helloWorldSkill = createSkill({
  name: 'hello-world',
  version: '1.0.0',
  description: 'A simple greeting skill — template for new NexusHub skills',
  author: 'NexusHub Team',
})
  .tools(tools)
  .commands(commands)
  .agents(agents)
  .submodules([
    {
      name: 'greetings',
      description: 'Core greeting tools',
      tools: ['hello_greet', 'hello_farewell'],
      enabledByDefault: true,
    },
    {
      name: 'echo',
      description: 'Message echo functionality',
      tools: ['hello_echo'],
      enabledByDefault: true,
      dependencies: ['greetings'],
    },
  ])
  .routing({
    commands: ['/hello', '/goodbye', '/bye'],
    keywords: ['hello', 'greet', 'goodbye'],
    classificationHint: {
      description: 'Greetings, hellos, goodbyes, echoing messages',
      examples: ['say hello to John', 'goodbye everyone'],
    },
  })
  .build();

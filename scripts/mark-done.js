#!/usr/bin/env node
/**
 * Quick script to mark specific Notion tasks as Done
 */
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('NOTION_TOKEN required'); process.exit(1); }

const TASKS = [
  { id: '332ad49d-23e7-812b-ad5e-e9235241d3b4', title: 'Router tests (classifier.ts)' },
  { id: '332ad49d-23e7-811a-b828-c1f440443f83', title: 'AnthropicProvider implementation' },
];

(async () => {
  for (const task of TASKS) {
    const resp = await fetch(`https://api.notion.com/v1/pages/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        properties: { 'Status': { select: { name: 'Done' } } },
      }),
    });
    console.log(`${resp.ok ? '✅' : '❌'} ${task.title} → Done`);
  }
})();

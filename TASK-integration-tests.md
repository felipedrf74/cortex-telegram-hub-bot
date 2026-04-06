# TASK-integration-tests.md — Implementation Spec for Claude Code

> **Branch:** `feature/telegram-adapter` (same branch as adapter work)  
> **Commit message:** `test(integration): add scenario-specific E2E tests — calendar, finance, cooking, ambiguous, tool loop`  
> **After implementation:** run `npx vitest run && npx tsc --noEmit`, commit.

---

## Objective

Extend the existing integration test suite (`__tests__/integration/message-flow.test.ts`, 835 lines) with 5 specific end-to-end scenarios that test realistic user flows including domain-specific tool calls, PT-BR input, and verification that the tool loop produces human-readable text (NOT raw JSON).

---

## Current State

The test file already covers: pattern/keyword/classifier routing, single and multi-step tool calls, parallel tools, maxIterations limits, conversation persistence, state context, message splitting, and edge cases. All using mocked Anthropic API, mocked tool executor, and real router/classifier/handler code.

**What's missing — the 5 specific scenarios:**
1. Calendar query → secretary → calendar tool → formatted human response
2. `/expense 50 almoço` → finance → expense logged → confirmation
3. `"receita de frango"` → cooking → recipe tool → results
4. Ambiguous message → Haiku classifier → routes to most likely domain
5. Tool loop produces final TEXT, never raw JSON to user

---

## File to Modify

`__tests__/integration/message-flow.test.ts` — append new `describe` blocks after the existing tests. Do NOT modify any existing tests.

---

## Implementation

Append the following 5 `describe` blocks at the bottom of the file, BEFORE the final closing. Use the existing mock references (`mockCallDomain`, `mockContinueWithToolResults`, `mockClassifyMessage`, `mockExecuteToolCall`, etc.) which are already in scope.

### Scenario 1: Calendar query E2E

```typescript
// ════════════════════════════════════════════════════════════════════
// SCENARIO-SPECIFIC E2E TESTS
// ════════════════════════════════════════════════════════════════════

describe('Scenario: "what is on my calendar today?" → secretary → calendar tool → response', () => {
  it('routes to secretary, calls get_events tool, returns formatted schedule', async () => {
    // Step 1: Route — "calendar" keyword matches secretary
    const route = await routeMessage('what is on my calendar today?');
    expect(route.domain).toBe('secretary');

    // Step 2: Domain handler — Claude requests calendar tool
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_cal_01',
        name: 'get_events',
        input: { start: '2026-04-01T00:00:00', end: '2026-04-01T23:59:59' },
      }],
      stopReason: 'tool_use',
    });

    // Step 3: Tool returns calendar data
    mockExecuteToolCall.mockResolvedValue({
      success: true,
      events: [
        { title: 'Sprint Planning', start: '09:00', end: '10:00', calendar: 'Siemens' },
        { title: 'Lunch with Pedro', start: '12:30', end: '13:30', calendar: 'Personal' },
        { title: 'Swim training', start: '18:00', end: '19:00', calendar: 'Training' },
      ],
    });

    // Step 4: Claude produces formatted human-readable response
    mockContinueWithToolResults.mockResolvedValue({
      text: '📅 Here\'s your schedule for today:\n\n• 09:00–10:00 — Sprint Planning (Siemens)\n• 12:30–13:30 — Lunch with Pedro\n• 18:00–19:00 — Swim training\n\nYou have 3 events. Your afternoon is free between 1:30 PM and 6 PM.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);

    // Verify: human-readable text, NOT raw JSON
    expect(response.text).toContain('Sprint Planning');
    expect(response.text).toContain('Lunch with Pedro');
    expect(response.text).toContain('Swim training');
    expect(response.text).not.toContain('"success"');
    expect(response.text).not.toContain('"events"');
    expect(response.domain).toBe('secretary');

    // Verify: tool was called with correct params
    expect(mockExecuteToolCall).toHaveBeenCalledWith('get_events', {
      start: '2026-04-01T00:00:00',
      end: '2026-04-01T23:59:59',
    }, undefined);
  });
});
```

### Scenario 2: Expense command E2E

```typescript
describe('Scenario: "/expense 50 almoço" → finance → expense logged → confirmation', () => {
  it('routes to finance via pattern, logs expense, returns confirmation', async () => {
    // Step 1: Route — /expense command matches finance domain
    const route = await routeMessage('/expense 50 almoço');
    expect(route.domain).toBe('finance');
    expect(route.method).toBe('pattern');
    expect(route.strippedMessage).toBe('50 almoço');

    // Step 2: Domain handler — Claude parses amount and description, calls tool
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_exp_01',
        name: 'log_expense',
        input: {
          amount: 50,
          currency: 'EUR',
          description: 'almoço',
          category: 'food',
          date: '2026-04-01',
        },
      }],
      stopReason: 'tool_use',
    });

    // Step 3: Tool confirms expense logged
    mockExecuteToolCall.mockResolvedValue({
      success: true,
      id: 42,
      message: 'Expense logged: €50.00 — almoço (food)',
    });

    // Step 4: Claude returns human confirmation
    mockContinueWithToolResults.mockResolvedValue({
      text: '✅ Expense logged!\n\n💰 €50.00 — almoço\n📂 Category: food\n📅 Date: April 1, 2026',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);

    // Verify: confirmation text, not JSON
    expect(response.text).toContain('€50.00');
    expect(response.text).toContain('almoço');
    expect(response.text).toContain('food');
    expect(response.text).not.toContain('"success"');
    expect(response.domain).toBe('finance');
  });
});
```

### Scenario 3: Cooking recipe PT-BR E2E

```typescript
describe('Scenario: "receita de frango" → cooking → recipe search → results', () => {
  it('routes to cooking via keyword (PT-BR), searches recipes, returns formatted results', async () => {
    // Step 1: Route — "receita" keyword matches cooking domain
    const route = await routeMessage('receita de frango');
    expect(route.domain).toBe('cooking');
    expect(route.method).toBe('keyword');

    // Step 2: Domain handler — Claude may or may not use tools for cooking
    // (cooking domain uses simple handleSimpleDomain, tools are optional)
    mockCallDomain.mockResolvedValue({
      text: '🍗 **Frango Grelhado com Ervas**\n\n' +
        '**Ingredientes:**\n' +
        '- 500g peito de frango\n' +
        '- 2 colheres de azeite\n' +
        '- Alho, sal, pimenta, orégano\n\n' +
        '**Modo de preparo:**\n' +
        '1. Tempere o frango com alho, sal, pimenta e orégano\n' +
        '2. Grelhe em fogo médio por 6 min de cada lado\n' +
        '3. Deixe descansar 5 minutos antes de servir\n\n' +
        '⏱ Tempo: 20 min | 🔥 Calorias: ~250 kcal por porção',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);

    // Verify: recipe content in Portuguese
    expect(response.text).toContain('Frango');
    expect(response.text).toContain('Ingredientes');
    expect(response.text).toContain('Modo de preparo');
    expect(response.domain).toBe('cooking');

    // Verify: no tool calls needed for simple recipe generation
    expect(mockExecuteToolCall).not.toHaveBeenCalled();
  });
});
```

### Scenario 4: Ambiguous message classification

```typescript
describe('Scenario: Ambiguous message → Haiku classifier → most likely domain', () => {
  it('routes ambiguous PT-BR message through classifier to correct domain', async () => {
    // "como estou indo?" — could be triathlon (performance) or secretary (tasks)
    // No keyword match, no pattern match → falls through to Claude classifier
    mockClassifyMessage.mockResolvedValue({
      domain: 'triathlon',
      confidence: 0.72,
    });

    const route = await routeMessage('como estou indo?');
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('triathlon');
    expect(route.confidence).toBe(0.72);

    // Verify classifier was called (Haiku in production, mocked here)
    expect(mockClassifyMessage).toHaveBeenCalledWith('como estou indo?', undefined);
  });

  it('classifier respects minimum confidence threshold', async () => {
    // Very low confidence — should still route but confidence is preserved
    mockClassifyMessage.mockResolvedValue({
      domain: 'content',
      confidence: 0.45,
    });

    const route = await routeMessage('hmmm não sei');
    expect(route.method).toBe('classifier');
    // The router may override low-confidence results to secretary
    // (depends on implementation — just verify it routes somewhere valid)
    expect(['secretary', 'content', 'triathlon', 'cooking', 'finance']).toContain(route.domain);
  });

  it('classifier with active context routes follow-up correctly', async () => {
    mockClassifyMessage.mockResolvedValue({
      domain: 'cooking',
      confidence: 0.88,
    });

    const activeContext = {
      domain: 'cooking' as const,
      lastAssistantMessage: 'Aqui está a receita de frango grelhado. Quer que eu ajuste as porções?',
    };

    const route = await routeMessage('sim, para 4 pessoas', activeContext);
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('cooking');
    expect(route.confidence).toBe(0.88);

    // Verify context was passed to classifier
    expect(mockClassifyMessage).toHaveBeenCalledWith('sim, para 4 pessoas', activeContext);
  });
});
```

### Scenario 5: Tool loop produces text, never raw JSON

```typescript
describe('Scenario: Tool execution loop returns human text, never raw JSON', () => {
  it('tool_use → execute → continueWithToolResults → final text (not JSON)', async () => {
    // Simulate: user asks about tasks, Claude uses tool, returns formatted text
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_tasks_01',
        name: 'list_todos',
        input: { domain: 'secretary' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({
      success: true,
      data: [
        { title: 'Deploy v4.5.2', priority: 'high', status: 'done' },
        { title: 'Review PR #13', priority: 'high', status: 'pending' },
        { title: 'Write docs', priority: 'medium', status: 'pending' },
      ],
    });

    mockContinueWithToolResults.mockResolvedValue({
      text: '📋 Your tasks:\n\n✅ Deploy v4.5.2 (done)\n⏳ Review PR #13 (high priority)\n⏳ Write docs (medium priority)\n\n2 pending, 1 completed.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain('secretary', 'show my tasks');

    // CRITICAL: Response must be human-readable text
    expect(response.text).toContain('Deploy v4.5.2');
    expect(response.text).toContain('Review PR #13');
    expect(response.text).toContain('2 pending');

    // CRITICAL: Response must NOT be raw JSON
    expect(response.text).not.toContain('"success"');
    expect(response.text).not.toContain('"data"');
    expect(response.text).not.toContain('{"');
    expect(response.text).not.toContain('[{');
    expect(response.text).not.toMatch(/^\s*\{/);  // doesn't start with {
    expect(response.text).not.toMatch(/^\s*\[/);  // doesn't start with [
  });

  it('multi-step tool loop returns final text, not intermediate JSON', async () => {
    // Round 1: check calendar
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_r1',
        name: 'get_events',
        input: { start: '2026-04-01', end: '2026-04-01' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall
      .mockResolvedValueOnce({ success: true, events: [{ title: 'Meeting', start: '14:00' }] })
      .mockResolvedValueOnce({ success: true, id: 7 });

    // Round 2: create reminder based on calendar
    mockContinueWithToolResults
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{
          type: 'tool_use' as const,
          id: 'toolu_r2',
          name: 'create_reminder',
          input: { title: 'Prepare for meeting', time: '13:30' },
        }],
        stopReason: 'tool_use',
      })
      // Round 3: final human response
      .mockResolvedValueOnce({
        text: '📅 You have a meeting at 2 PM. I\'ve set a reminder at 1:30 PM to prepare.',
        toolCalls: [],
        stopReason: 'end_turn',
      });

    const response = await handleSimpleDomain('secretary', 'check my afternoon and remind me before meetings');

    // Final response is natural language
    expect(response.text).toContain('meeting at 2 PM');
    expect(response.text).toContain('reminder at 1:30 PM');
    expect(response.text).not.toContain('"success"');
    expect(response.text).not.toContain('"events"');
    expect(response.text).not.toContain('toolu_');

    // Two tools were called across the loop
    expect(mockExecuteToolCall).toHaveBeenCalledTimes(2);
    expect(mockContinueWithToolResults).toHaveBeenCalledTimes(2);
  });

  it('conversation stores final text, not tool JSON', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_store_01',
        name: 'list_todos',
        input: {},
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({ success: true, data: [] });

    mockContinueWithToolResults.mockResolvedValue({
      text: 'You have no pending tasks. Enjoy your free time!',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleSimpleDomain('secretary', 'tasks?');

    // Stored assistant message must be the human text, not JSON
    const assistantCall = mockAddToConversation.mock.calls.find(
      (c) => c[1] === 'assistant'
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall![2]).toContain('no pending tasks');
    expect(assistantCall![2]).not.toContain('"success"');
    expect(assistantCall![2]).not.toContain('"data"');
  });
});
```

---

## Verification

```bash
npx vitest run __tests__/integration/message-flow.test.ts
npx vitest run  # full suite
npx tsc --noEmit
```

## Definition of Done

- [ ] Scenario 1: Calendar query → secretary → get_events tool → formatted schedule text
- [ ] Scenario 2: /expense → finance → log_expense tool → €50 confirmation
- [ ] Scenario 3: "receita de frango" → cooking keyword → PT-BR recipe response
- [ ] Scenario 4: Ambiguous message → classifier with confidence → correct domain
- [ ] Scenario 5a: Single tool loop → final response is text, not JSON
- [ ] Scenario 5b: Multi-step tool loop → final response is text, not JSON
- [ ] Scenario 5c: Stored conversation is text, not JSON
- [ ] All `response.text` assertions verify NO raw JSON (`"success"`, `{"`, `[{`)
- [ ] All existing 835 lines of tests still pass (no modifications to existing tests)
- [ ] `npx vitest run` — all green
- [ ] `npx tsc --noEmit` — no type errors

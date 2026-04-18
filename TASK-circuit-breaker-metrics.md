# TASK-circuit-breaker-metrics.md — Implementation Spec for Claude Code

> Status: decommissioned historical implementation spec.
>
> This file is not a live source of truth. It was a point-in-time execution
> brief for a Claude Code task.
>
> Use the current code, tests, and canonical docs instead:
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CLAUDE.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DOCUMENTATION.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/DOCUMENTATION-MAP.md`

> **Branch:** `feature/telegram-adapter` (same branch as adapter work)  
> **Commit message:** `feat(providers): circuit breaker metrics — usage/failure/fallback counts exposed via /health/detailed`  
> **After implementation:** run `npx vitest run && npx tsc --noEmit`, commit.

---

## Objective

Add per-provider metrics tracking (usage count, failure count, fallback trigger count) to the existing circuit breaker system. Expose these metrics plus circuit breaker states via the existing `/health/detailed` endpoint. The circuit breaker itself (`src/services/provider-fallback.ts`, 315 lines) and test suite (`__tests__/services/provider-fallback.test.ts`, 446 lines) already fully implement the CLOSED → OPEN → HALF_OPEN state machine. This task adds observability on top.

---

## Current State — What Already Exists

**Already implemented (DO NOT rewrite):**
- `src/services/provider-fallback.ts` — full `CircuitBreaker` class with CLOSED/OPEN/HALF_OPEN states, `TaskRoutingProvider` with per-task-type routing, `FallbackEvent` callback
- `src/services/provider-registry.ts` — `createRoutingProvider()` factory, provider lazy init
- `src/config.ts` — env vars: `AI_CHAT_PRIMARY`, `AI_CHAT_FALLBACK`, `AI_CLASSIFY_PRIMARY`, `AI_CLASSIFY_FALLBACK`, `AI_CB_FAILURE_THRESHOLD` (default 3), `AI_CB_COOLDOWN_MS` (default 60000)
- `__tests__/services/provider-fallback.test.ts` — 446 lines covering all circuit states, transitions, task routing
- `/health/detailed` endpoint in `src/portal/server.ts` — exists but does NOT include circuit breaker or provider metrics

**What's missing:**
- No usage/failure/fallback counters per provider
- `/health/detailed` doesn't show circuit breaker states or provider metrics
- No way to see which providers are being used and how often they fail

---

## Files to Modify

| File | Action |
|------|--------|
| `src/services/provider-fallback.ts` | Add metrics tracking to `TaskRoutingProvider` |
| `src/portal/server.ts` | Add provider metrics to `/health/detailed` response |
| `__tests__/services/provider-fallback.test.ts` | Add metrics tracking tests |

---

## 1. Add metrics to `src/services/provider-fallback.ts`

### Add a `ProviderMetrics` interface and in-memory tracking

Add AFTER the existing `FallbackEvent` interface:

```typescript
/** Per-provider usage metrics (in-memory, resets on restart). */
export interface ProviderMetrics {
  /** Total API calls attempted */
  usageCount: number;
  /** Total failed calls */
  failureCount: number;
  /** Number of times this provider was used as a fallback */
  fallbackTriggerCount: number;
  /** Number of times this provider's circuit opened */
  circuitOpenCount: number;
  /** Timestamp of last successful call */
  lastSuccessAt: string | null;
  /** Timestamp of last failure */
  lastFailureAt: string | null;
}
```

### Add metrics tracking to `TaskRoutingProvider`

Add a `private metrics` map alongside the existing `private breakers` map:

```typescript
private metrics = new Map<string, ProviderMetrics>();

private getMetrics(providerName: string): ProviderMetrics {
  let m = this.metrics.get(providerName);
  if (!m) {
    m = {
      usageCount: 0,
      failureCount: 0,
      fallbackTriggerCount: 0,
      circuitOpenCount: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    this.metrics.set(providerName, m);
  }
  return m;
}
```

### Update `executeWithFallback` to track metrics

In the existing `executeWithFallback` method, add metrics calls at the key points. Do NOT rewrite the method — just add lines at the right spots:

**When primary succeeds:**
```typescript
// After: primaryBreaker.recordSuccess();
const pm = this.getMetrics(pair.primary.name);
pm.usageCount++;
pm.lastSuccessAt = new Date().toISOString();
```

**When primary fails and fallback is tried:**
```typescript
// After: primaryBreaker.recordFailure();
const pm = this.getMetrics(pair.primary.name);
pm.usageCount++;
pm.failureCount++;
pm.lastFailureAt = new Date().toISOString();

// When fallback is about to be used:
const fm = this.getMetrics(pair.fallback!.name);
fm.fallbackTriggerCount++;
```

**When circuit is open (skip to fallback):**
```typescript
// In the circuit-open branch:
const pm = this.getMetrics(pair.primary.name);
pm.circuitOpenCount++;

const fm = this.getMetrics(pair.fallback!.name);
fm.fallbackTriggerCount++;
```

**When fallback executes:**
After the `return fn(pair.fallback!)` line at the bottom, wrap it to track the fallback's own success/failure:

```typescript
// Replace the bare `return fn(pair.fallback!)` with:
try {
  const result = await fn(pair.fallback!);
  const fm = this.getMetrics(pair.fallback!.name);
  fm.usageCount++;
  fm.lastSuccessAt = new Date().toISOString();
  return result;
} catch (fallbackErr) {
  const fm = this.getMetrics(pair.fallback!.name);
  fm.usageCount++;
  fm.failureCount++;
  fm.lastFailureAt = new Date().toISOString();
  throw fallbackErr;
}
```

### Add public method to expose metrics

Add alongside the existing `getAllCircuitStates()`:

```typescript
/** Get all provider metrics (for /health/detailed). */
getAllMetrics(): Record<string, ProviderMetrics> {
  const result: Record<string, ProviderMetrics> = {};
  for (const [name, m] of this.metrics) {
    result[name] = { ...m };
  }
  return result;
}

/** Combined circuit states + metrics for dashboards. */
getProviderHealth(): Record<string, {
  circuit: { state: CircuitState; failures: number };
  metrics: ProviderMetrics;
}> {
  const result: Record<string, any> = {};
  // Merge breakers and metrics for all known providers
  const allNames = new Set([...this.breakers.keys(), ...this.metrics.keys()]);
  for (const name of allNames) {
    const breaker = this.breakers.get(name);
    const metrics = this.metrics.get(name);
    result[name] = {
      circuit: breaker
        ? { state: breaker.getState(), failures: breaker.getFailureCount() }
        : { state: 'UNKNOWN', failures: 0 },
      metrics: metrics ?? {
        usageCount: 0, failureCount: 0, fallbackTriggerCount: 0,
        circuitOpenCount: 0, lastSuccessAt: null, lastFailureAt: null,
      },
    };
  }
  return result;
}
```

### Export `ProviderMetrics` type

Add to the existing exports at the top of the file so server.ts can import it.

---

## 2. Expose metrics in `/health/detailed` — `src/portal/server.ts`

### Get a reference to the routing provider

The `TaskRoutingProvider` instance is created in `provider-registry.ts` via `createRoutingProvider()`. To access it from server.ts, either:

**Option A (preferred):** Export the provider instance from wherever it's stored at startup. Check how the bot initializes providers — likely in `src/bot.ts` or `src/index.ts`. If the provider is stored in a module-level variable, export a getter.

**Option B (simpler):** Import `createRoutingProvider` isn't right since it creates a new instance. Instead, add a `getActiveProvider()` function to `provider-registry.ts`:

```typescript
// In provider-registry.ts:
let _activeProvider: TaskRoutingProvider | null = null;

export function createRoutingProvider(...): TaskRoutingProvider {
  // ... existing code ...
  _activeProvider = provider;
  return provider;
}

export function getActiveProvider(): TaskRoutingProvider | null {
  return _activeProvider;
}
```

### Add to `/health/detailed` response

In the existing `/health/detailed` handler in `server.ts`, add a `providers` section to the response JSON. Find the `res.json({...})` call and add:

```typescript
// Import at top of server.ts:
import { getActiveProvider } from '../services/provider-registry';

// Inside the /health/detailed handler, before the res.json:
let providerHealth: Record<string, any> = {};
try {
  const activeProvider = getActiveProvider();
  if (activeProvider) {
    providerHealth = activeProvider.getProviderHealth();
  }
} catch { /* provider not initialized yet */ }

// Add to the response object:
res.json({
  // ... existing fields (status, uptime, bot, memory, jobs, errors, integrations) ...
  providers: providerHealth,
});
```

This adds a block like:
```json
{
  "providers": {
    "anthropic": {
      "circuit": { "state": "CLOSED", "failures": 0 },
      "metrics": {
        "usageCount": 142,
        "failureCount": 0,
        "fallbackTriggerCount": 0,
        "circuitOpenCount": 0,
        "lastSuccessAt": "2026-04-03T22:15:00.000Z",
        "lastFailureAt": null
      }
    },
    "openai": {
      "circuit": { "state": "CLOSED", "failures": 0 },
      "metrics": {
        "usageCount": 3,
        "failureCount": 1,
        "fallbackTriggerCount": 2,
        "circuitOpenCount": 0,
        "lastSuccessAt": "2026-04-03T20:00:00.000Z",
        "lastFailureAt": "2026-04-03T19:55:00.000Z"
      }
    }
  }
}
```

---

## 3. Tests — extend `__tests__/services/provider-fallback.test.ts`

Append new `describe` blocks AFTER the existing tests. Do NOT modify existing tests.

### New test groups:

```
describe('ProviderMetrics tracking')
  - increments usageCount on successful primary call
  - increments usageCount AND failureCount on primary failure
  - increments fallbackTriggerCount when fallback is used
  - increments circuitOpenCount when circuit skips to fallback
  - tracks fallback's own usageCount when fallback executes
  - tracks fallback failureCount when fallback also fails
  - sets lastSuccessAt timestamp on success
  - sets lastFailureAt timestamp on failure
  - getAllMetrics returns all tracked providers
  - getProviderHealth merges circuit state with metrics

describe('Metrics across multiple task types')
  - classify failure increments metrics independently from chat failure
  - callDomain and continueWithToolResults share the same provider metrics
  - tool-use routing tracks metrics on the correct provider
```

### Test patterns:

```typescript
describe('ProviderMetrics tracking', () => {
  let primary: ReturnType<typeof createMockProvider>;
  let fallback: ReturnType<typeof createMockProvider>;
  let provider: TaskRoutingProvider;
  let fallbackEvents: FallbackEvent[];

  beforeEach(() => {
    primary = createMockProvider('anthropic');
    fallback = createMockProvider('openai');
    fallbackEvents = [];

    provider = new TaskRoutingProvider({
      classify: { primary, fallback },
      chat: { primary, fallback },
      'tool-use': { primary, fallback },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    }, (e) => fallbackEvents.push(e));
  });

  it('increments usageCount on successful call', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('hello');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.usageCount).toBe(1);
    expect(health['anthropic'].metrics.failureCount).toBe(0);
    expect(health['anthropic'].metrics.lastSuccessAt).not.toBeNull();
  });

  it('increments failureCount and fallbackTriggerCount on primary failure', async () => {
    primary.classify.mockRejectedValue(new Error('API down'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('hello');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.usageCount).toBe(1);
    expect(health['anthropic'].metrics.failureCount).toBe(1);
    expect(health['openai'].metrics.fallbackTriggerCount).toBe(1);
    expect(health['openai'].metrics.usageCount).toBe(1);
  });

  it('increments circuitOpenCount when circuit skips to fallback', async () => {
    // Fail 3 times to open circuit
    primary.classify.mockRejectedValue(new Error('down'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('1');
    await provider.classify('2');
    await provider.classify('3');

    // Circuit now open — 4th call skips primary
    await provider.classify('4');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.circuitOpenCount).toBeGreaterThanOrEqual(1);
    expect(health['anthropic'].circuit.state).toBe('OPEN');
  });

  it('tracks fallback failure when fallback also fails', async () => {
    primary.classify.mockRejectedValue(new Error('primary down'));
    fallback.classify.mockRejectedValue(new Error('fallback down'));

    await expect(provider.classify('hello')).rejects.toThrow('fallback down');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.failureCount).toBe(1);
    expect(health['openai'].metrics.failureCount).toBe(1);
  });

  it('getAllMetrics returns all providers', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('test');

    const metrics = provider.getAllMetrics();
    expect(metrics).toHaveProperty('anthropic');
    expect(metrics['anthropic'].usageCount).toBe(1);
  });

  it('getProviderHealth merges circuit and metrics', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('test');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].circuit).toBeDefined();
    expect(health['anthropic'].circuit.state).toBe('CLOSED');
    expect(health['anthropic'].metrics).toBeDefined();
    expect(health['anthropic'].metrics.usageCount).toBe(1);
  });
});
```

---

## Verification

```bash
npx vitest run __tests__/services/provider-fallback.test.ts
npx vitest run  # full suite
npx tsc --noEmit
```

## Definition of Done

- [ ] `ProviderMetrics` interface exported from provider-fallback.ts
- [ ] `usageCount` incremented on every API call attempt (primary and fallback)
- [ ] `failureCount` incremented on every failed call
- [ ] `fallbackTriggerCount` incremented when a provider is used as fallback
- [ ] `circuitOpenCount` incremented when circuit skips primary
- [ ] `lastSuccessAt` / `lastFailureAt` timestamps set correctly
- [ ] `getProviderHealth()` returns merged circuit state + metrics per provider
- [ ] `getActiveProvider()` exported from provider-registry.ts
- [ ] `/health/detailed` response includes `providers` section with circuit + metrics
- [ ] All existing 446 lines of provider-fallback tests still pass
- [ ] New tests cover: usage tracking, failure tracking, fallback tracking, circuit open tracking, merged health output
- [ ] `npx vitest run` — all green
- [ ] `npx tsc --noEmit` — no type errors

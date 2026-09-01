import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), 'src/services');
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

describe('Decision Center physical module boundaries', () => {
  it('keeps both public compatibility files body-free', () => {
    const facade = read('decision-center.ts');
    const deprecatedBarrel = read('decision-center-implementation.ts');

    expect(facade.split('\n').length).toBeLessThanOrEqual(25);
    expect(deprecatedBarrel.split('\n').length).toBeLessThanOrEqual(25);
    for (const source of [facade, deprecatedBarrel]) {
      expect(source).not.toMatch(/\b(?:async\s+)?function\s+\w+\s*\(/);
      expect(source).not.toMatch(/\bclass\s+\w+/);
      expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    }
  });

  it('keeps each runtime boundary physically implemented in its owning module', () => {
    const proposal = read('decision-center/proposal-service.ts');
    const reads = read('decision-center/read-projection-ranking-service.ts');
    const commands = read('decision-center/command-service.ts');
    const lifecycle = read('decision-center/lifecycle-preferences-jobs.ts');

    expect(proposal).toContain('export async function createDecisionIntent(');
    expect(proposal).toContain('export function evaluateDecisionEligibility(');
    expect(reads).toContain('export function listDecisionItems(');
    expect(reads).toContain('export function formatDecisionItemForApi(');
    expect(commands).toContain('export async function performDecisionAction(');
    expect(commands).toContain('export function reviewDecision(');
    expect(lifecycle).toContain('export function runDecisionExpiryJob(');
    expect(lifecycle).toContain('export function updateDecisionPreferencesViaCommand(');
  });

  it('forbids scoped modules from importing the deprecated implementation barrel', () => {
    const moduleDirectory = resolve(root, 'decision-center');
    const offenders = readdirSync(moduleDirectory)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => read(`decision-center/${name}`).includes('decision-center-implementation'));

    expect(offenders).toEqual([]);
  });

  it('keeps engine cores private so callers cannot bypass selector and receipt guards', () => {
    const commands = read('decision-center/command-service.ts');
    const reads = read('decision-center/read-projection-ranking-service.ts');

    expect(commands).not.toMatch(/export\s+async\s+function\s+performDecisionAction(?:Legacy)?Core/);
    expect(reads).not.toMatch(/export\s+function\s+refreshDecisionItemCore/);
  });
});

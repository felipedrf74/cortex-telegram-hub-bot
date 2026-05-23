#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ChatTestScenario = {
  id: string;
  user_text: string;
  locale?: string;
  expected_action?: string | null;
  expected_action_NOT?: string;
  expected_slots?: Record<string, JsonValue>;
  expected_verifier?: string;
  expected_response_substring?: string[];
  forbidden_response_substring?: string[];
  expected_step_count?: number;
  expected_steps?: Array<{ skill?: string; action?: string }>;
  expected_aggregate_status?: string;
};

export type ChatTestFixture = {
  suite: string;
  expected_pass_rate: number;
  scenarios: ChatTestScenario[];
};

export type ScenarioResult = {
  id: string;
  passed: boolean;
  status: 'passed' | 'failed' | 'skipped';
  failures: string[];
  request: {
    text: string;
    locale?: string;
  };
  response?: {
    status: number;
    text: string;
    metadata: unknown;
  };
};

type RunnerOptions = {
  fixturePath: string;
  baseUrl?: string;
  endpoint?: string;
  token?: string;
  outputDir: string;
  dryRun: boolean;
};

type ParsedArgs = RunnerOptions & {
  help: boolean;
};

function usage(): string {
  return `Usage:
  npm run chat:test-phase -- --fixture __tests__/chat-test-phase/track-1-baseline.yml --base-url https://staging.nexushub.me --token "$JWT"

Options:
  --fixture <path>      JSON-compatible YAML fixture file. Env: CHAT_TEST_FIXTURE
  --base-url <url>      Staging/production API origin. Env: CHAT_TEST_BASE_URL
  --endpoint <url>      Full chat endpoint override. Env: CHAT_TEST_ENDPOINT
  --token <jwt>         Authenticated API bearer token. Env: CHAT_TEST_TOKEN
  --output-dir <path>   Report directory. Default: docs/release/chat-test-phase
  --dry-run             Validate fixture and write a skipped report without network calls.
`;
}

export function parseFixtureText(text: string): ChatTestFixture {
  const parsed = JSON.parse(text) as ChatTestFixture;
  if (!parsed || typeof parsed !== 'object') throw new Error('Fixture must be an object');
  if (!parsed.suite || typeof parsed.suite !== 'string') throw new Error('Fixture missing string suite');
  if (typeof parsed.expected_pass_rate !== 'number') throw new Error('Fixture missing numeric expected_pass_rate');
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) throw new Error('Fixture must include scenarios');
  for (const scenario of parsed.scenarios) {
    if (!scenario || typeof scenario !== 'object') throw new Error('Scenario must be an object');
    if (!scenario.id || typeof scenario.id !== 'string') throw new Error('Scenario missing string id');
    if (!scenario.user_text || typeof scenario.user_text !== 'string') throw new Error(`Scenario ${scenario.id} missing string user_text`);
  }
  return parsed;
}

export function evaluateScenarioResponse(
  scenario: ChatTestScenario,
  responseBody: any,
  status: number,
): ScenarioResult {
  const failures: string[] = [];
  const metadata = responseBody?.metadata ?? {};
  const text = typeof responseBody?.text === 'string' ? responseBody.text : '';
  const actionValues = collectStringValuesByKey(responseBody, 'action');
  const statusValues = collectStringValuesByKey(responseBody, 'status')
    .concat(collectStringValuesByKey(responseBody, 'actionStatus'))
    .concat(collectStringValuesByKey(responseBody, 'verificationStatus'));

  if (status < 200 || status >= 300) failures.push(`http_status_${status}`);
  if (scenario.expected_action === null) {
    if (actionValues.length > 0) failures.push(`expected_no_action_but_saw_${actionValues.join(',')}`);
  } else if (scenario.expected_action && !actionValues.includes(scenario.expected_action)) {
    failures.push(`missing_expected_action_${scenario.expected_action}`);
  }
  if (scenario.expected_action_NOT && actionValues.includes(scenario.expected_action_NOT)) {
    failures.push(`saw_forbidden_action_${scenario.expected_action_NOT}`);
  }
  if (scenario.expected_verifier && !statusValues.includes(scenario.expected_verifier)) {
    failures.push(`missing_expected_verifier_${scenario.expected_verifier}`);
  }
  if (scenario.expected_aggregate_status && !statusValues.includes(scenario.expected_aggregate_status)) {
    failures.push(`missing_expected_aggregate_status_${scenario.expected_aggregate_status}`);
  }
  if (scenario.expected_step_count !== undefined) {
    const observedStepCount = inferStepCount(metadata, actionValues);
    if (observedStepCount !== scenario.expected_step_count) {
      failures.push(`expected_step_count_${scenario.expected_step_count}_saw_${observedStepCount}`);
    }
  }
  if (scenario.expected_steps) {
    const observedPairs = collectSkillActionPairs(responseBody);
    for (const expected of scenario.expected_steps) {
      const found = observedPairs.some((pair) =>
        (expected.skill === undefined || pair.skill === expected.skill)
        && (expected.action === undefined || pair.action === expected.action)
      );
      if (!found) failures.push(`missing_expected_step_${expected.skill ?? '*'}:${expected.action ?? '*'}`);
    }
  }
  for (const [slot, expected] of Object.entries(scenario.expected_slots ?? {})) {
    const slotValues = collectValuesByKey(responseBody, slot).map((value) => JSON.stringify(value));
    if (!slotValues.includes(JSON.stringify(expected))) {
      failures.push(`missing_expected_slot_${slot}`);
    }
  }
  for (const needle of scenario.expected_response_substring ?? []) {
    if (!text.toLowerCase().includes(needle.toLowerCase())) failures.push(`missing_response_substring_${needle}`);
  }
  for (const forbidden of scenario.forbidden_response_substring ?? []) {
    if (text.toLowerCase().includes(forbidden.toLowerCase())) failures.push(`forbidden_response_substring_${forbidden}`);
  }

  return {
    id: scenario.id,
    passed: failures.length === 0,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    request: { text: scenario.user_text, locale: scenario.locale },
    response: { status, text, metadata },
  };
}

export async function runChatTestPhase(options: RunnerOptions): Promise<{ reportPath: string; passRate: number; results: ScenarioResult[] }> {
  const fixture = parseFixtureText(fs.readFileSync(options.fixturePath, 'utf8'));
  const results: ScenarioResult[] = [];
  for (const scenario of fixture.scenarios) {
    if (options.dryRun) {
      results.push({
        id: scenario.id,
        passed: true,
        status: 'skipped',
        failures: [],
        request: { text: scenario.user_text, locale: scenario.locale },
      });
      continue;
    }
    const endpoint = resolveEndpoint(options);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(scenario.locale ? { 'x-language': scenario.locale } : {}),
      },
      body: JSON.stringify({
        text: scenario.user_text,
        locale: scenario.locale,
        clientMessageId: `chat-test-phase-${fixture.suite}-${scenario.id}-${Date.now()}`,
      }),
    });
    const body = await response.json().catch(() => ({ text: '' }));
    results.push(evaluateScenarioResponse(scenario, body, response.status));
  }

  const passed = results.filter((result) => result.passed).length;
  const passRate = results.length === 0 ? 0 : passed / results.length;
  const generatedAt = new Date().toISOString();
  const report = {
    suite: fixture.suite,
    generatedAt,
    dryRun: options.dryRun,
    expectedPassRate: fixture.expected_pass_rate,
    passRate,
    passed,
    total: results.length,
    endpoint: options.dryRun ? null : redactUrl(resolveEndpoint(options)),
    results,
  };
  fs.mkdirSync(options.outputDir, { recursive: true });
  const reportPath = path.join(options.outputDir, `chat-test-phase-results-${fixture.suite}-${generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.dryRun && passRate < fixture.expected_pass_rate) {
    throw new Error(`Chat test phase ${fixture.suite} failed: pass rate ${passRate.toFixed(3)} < ${fixture.expected_pass_rate}`);
  }
  return { reportPath, passRate, results };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    fixturePath: process.env.CHAT_TEST_FIXTURE ?? '',
    baseUrl: process.env.CHAT_TEST_BASE_URL,
    endpoint: process.env.CHAT_TEST_ENDPOINT,
    token: process.env.CHAT_TEST_TOKEN,
    outputDir: process.env.CHAT_TEST_OUTPUT_DIR ?? 'docs/release/chat-test-phase',
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--fixture') args.fixturePath = argv[++index] ?? '';
    else if (value === '--base-url') args.baseUrl = argv[++index];
    else if (value === '--endpoint') args.endpoint = argv[++index];
    else if (value === '--token') args.token = argv[++index];
    else if (value === '--output-dir') args.outputDir = argv[++index] ?? args.outputDir;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function resolveEndpoint(options: Pick<RunnerOptions, 'endpoint' | 'baseUrl'>): string {
  if (options.endpoint) return options.endpoint;
  if (!options.baseUrl) throw new Error('Missing --base-url or --endpoint');
  return new URL('/api/v1/chat/message', options.baseUrl).toString();
}

function redactUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.toString();
}

function inferStepCount(metadata: unknown, actionValues: string[]): number {
  if (metadata && typeof metadata === 'object') {
    const summary = (metadata as any).multiStepSummary;
    if (summary && typeof summary.totalSteps === 'number') return summary.totalSteps;
    const results = (metadata as any).actionResults;
    if (Array.isArray(results)) return results.length;
    const steps = (metadata as any).steps;
    if (Array.isArray(steps)) return steps.length;
  }
  return actionValues.length > 0 ? 1 : 0;
}

function collectStringValuesByKey(value: unknown, key: string): string[] {
  return collectValuesByKey(value, key).filter((item): item is string => typeof item === 'string');
}

function collectValuesByKey(value: unknown, key: string, output: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectValuesByKey(item, key, output, seen);
    return output;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) output.push(entryValue);
    collectValuesByKey(entryValue, key, output, seen);
  }
  return output;
}

function collectSkillActionPairs(value: unknown, output: Array<{ skill?: string; action?: string }> = [], seen = new Set<unknown>()): Array<{ skill?: string; action?: string }> {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectSkillActionPairs(item, output, seen);
    return output;
  }
  const skill = typeof (value as any).skill === 'string' ? (value as any).skill : undefined;
  const action = typeof (value as any).action === 'string' ? (value as any).action : undefined;
  if (skill || action) output.push({ skill, action });
  for (const entryValue of Object.values(value)) collectSkillActionPairs(entryValue, output, seen);
  return output;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.fixturePath) throw new Error('Missing --fixture');
  if (!args.dryRun && !args.token) throw new Error('Missing --token for non-dry-run execution');
  const result = await runChatTestPhase(args);
  console.log(JSON.stringify({
    reportPath: result.reportPath,
    passRate: result.passRate,
    total: result.results.length,
    failed: result.results.filter((entry) => !entry.passed).map((entry) => entry.id),
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

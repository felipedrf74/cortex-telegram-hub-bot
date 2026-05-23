// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  evaluateScenarioResponse,
  parseFixtureText,
  runChatTestPhase,
} from '../../scripts/chat-test-phase';

describe('chat-test-phase runner', () => {
  it('parses the JSON-compatible YAML fixture contract', () => {
    const fixture = parseFixtureText(JSON.stringify({
      suite: 'track-1-baseline',
      expected_pass_rate: 0.97,
      scenarios: [
        {
          id: 'simple-task',
          user_text: 'Create a task called Review release',
          expected_action: 'create_task',
        },
      ],
    }));

    expect(fixture.suite).toBe('track-1-baseline');
    expect(fixture.scenarios[0]?.expected_action).toBe('create_task');
  });

  it('evaluates action, verifier, slots, and response substrings', () => {
    const result = evaluateScenarioResponse(
      {
        id: 'task-create',
        user_text: 'Create a task called Review release',
        expected_action: 'create_task',
        expected_slots: { title: 'Review release' },
        expected_verifier: 'verified_success',
        expected_response_substring: ['Created'],
        forbidden_response_substring: ['cannot safely'],
      },
      {
        text: 'Created task “Review release”.',
        metadata: {
          action: 'create_task',
          actionStatus: 'verified_success',
          result: { title: 'Review release' },
        },
      },
      200,
    );

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports forbidden actions and missing expectations', () => {
    const result = evaluateScenarioResponse(
      {
        id: 'confusion',
        user_text: 'Remind me to pay the bill',
        expected_action: 'finance_create_reminder',
        expected_action_NOT: 'create_task',
      },
      {
        text: 'Created a task.',
        metadata: { action: 'create_task' },
      },
      200,
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'missing_expected_action_finance_create_reminder',
      'saw_forbidden_action_create_task',
    ]));
  });

  it('redacts confirmation and auth tokens from stored evidence metadata', () => {
    const result = evaluateScenarioResponse(
      {
        id: 'confirmation',
        user_text: 'Create a task called Review release',
        expected_action: 'create_task',
      },
      {
        text: 'Confirm the action.',
        metadata: {
          action: 'create_task',
          pendingConfirmation: {
            confirmation_token: 'secret-confirmation-token',
            confirmationToken: 'secret-confirmation-token-camel',
          },
          nested: [{ accessToken: 'secret-access-token', refresh_token: 'secret-refresh-token' }],
        },
      },
      202,
    );

    expect(result.response?.metadata).toMatchObject({
      pendingConfirmation: {
        confirmation_token: '[redacted]',
        confirmationToken: '[redacted]',
      },
      nested: [{ accessToken: '[redacted]', refresh_token: '[redacted]' }],
    });
    expect(JSON.stringify(result.response?.metadata)).not.toContain('secret-');
  });

  it('writes a dry-run report without network credentials', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-phase-'));
    const fixturePath = path.join(tmp, 'fixture.yml');
    fs.writeFileSync(fixturePath, JSON.stringify({
      suite: 'dry-run-suite',
      expected_pass_rate: 1,
      scenarios: [
        { id: 'baseline', user_text: 'What is on my calendar today?', expected_action: 'summarize_agenda' },
      ],
    }));

    const result = await runChatTestPhase({
      fixturePath,
      outputDir: tmp,
      dryRun: true,
    });

    expect(result.passRate).toBe(1);
    expect(fs.existsSync(result.reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report).toMatchObject({
      suite: 'dry-run-suite',
      dryRun: true,
      total: 1,
      passed: 1,
    });
  });
});

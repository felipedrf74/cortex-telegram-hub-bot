import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = path.resolve(
  'scripts/application-dr-cloudformation-parameter-digest.py',
);
const python = [
  process.env.CONTENT_ENGINE_PYTHON,
  '/opt/homebrew/bin/python3',
  '/usr/bin/python3',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function run(parameters: unknown[]) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cfn-parameters-')),
  );
  fs.chmodSync(root, 0o700);
  const input = path.join(root, 'describe-stacks.json');
  fs.writeFileSync(input, `${JSON.stringify({
    Stacks: [{
      StackId: 'arn:aws:cloudformation:eu-west-1:123456789012:stack/Nexus/1',
      Parameters: parameters,
    }],
  })}\n`, { mode: 0o600 });
  fs.chmodSync(input, 0o600);
  const result = spawnSync(python!, [
    helper,
    '--describe-stacks-json', input,
    '--expected-owner-uid', String(process.getuid?.() ?? 0),
    '--trust-boundary', root,
  ], { encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

describe.runIf(python !== undefined)(
  'application DR CloudFormation parameter digest',
  () => {
    it('matches the activation controller canonical sorted parameter digest', () => {
      const result = run([
        { ParameterValue: 'ENABLED', ParameterKey: 'Zeta' },
        { ParameterValue: 'DISABLED', ParameterKey: 'Alpha' },
      ]);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: true,
        parameterCount: 2,
        rawParameterValuesPersisted: false,
      });
      expect(output.parametersSha256).toBe(digest(JSON.stringify([
        { ParameterKey: 'Alpha', ParameterValue: 'DISABLED' },
        { ParameterKey: 'Zeta', ParameterValue: 'ENABLED' },
      ])));
      expect(result.stdout).not.toContain('DISABLED');
      expect(result.stdout).not.toContain('ENABLED');
    });

    it('rejects implicit, duplicate, and resolved parameter ambiguity', () => {
      const cases = [
        [{ ParameterKey: 'A', ParameterValue: 'x', UsePreviousValue: true }],
        [
          { ParameterKey: 'A', ParameterValue: 'x' },
          { ParameterKey: 'A', ParameterValue: 'y' },
        ],
        [{
          ParameterKey: 'A',
          ParameterValue: '/parameter/name',
          ResolvedValue: 'secret-value',
        }],
      ];
      for (const parameters of cases) {
        const result = run(parameters);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'stack parameters are not exact explicit string values',
        );
      }
    });
  },
);

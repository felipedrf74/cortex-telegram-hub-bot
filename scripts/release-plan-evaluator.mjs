#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReleasePlanEvaluationError,
  buildProtectedMainReuseServerPayload,
  evaluateReleaseObservationWindow,
  evaluateReleaseShadowReadiness,
} from './lib/release-plan-evaluation.mjs';
import { signServerActivationRequest } from './protected-main-reuse-activation.mjs';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const COMMANDS = new Set(['evaluate', 'shadow-readiness', 'activation-request']);

function usage() {
  return [
    'Usage:',
    '  sudo node scripts/release-plan-evaluator.mjs evaluate --input <observation-window.json> --evidence-root <directory> --promotion-evidence-root /var/lib/nexus-release-promotion [--output <result.json>]',
    '  node scripts/release-plan-evaluator.mjs shadow-readiness --input <shadow-ledger.json> [--output <result.json>]',
    '  sudo node scripts/release-plan-evaluator.mjs activation-request --input <observation-window.json> --evidence-root <directory> --promotion-evidence-root /var/lib/nexus-release-promotion --request-id <id> --server-private-key /etc/nexus-release/serverdominguez-provenance-private-key.pem --output <request.json>',
  ].join('\n');
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new ReleasePlanEvaluationError('command is invalid');
  const options = {
    command,
    input: '',
    output: '',
    evidenceRoot: '',
    promotionEvidenceRoot: '',
    publicKey: '',
    requestId: '',
    serverPrivateKey: '',
    allowTestKey: false,
  };
  const seen = new Set();
  for (let index = 1; index < argv.length;) {
    const flag = argv[index];
    if (flag === '--allow-test-key') {
      if (seen.has(flag)) throw new ReleasePlanEvaluationError(`duplicate option: ${flag}`);
      seen.add(flag);
      options.allowTestKey = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (![
      '--input',
      '--output',
      '--evidence-root',
      '--promotion-evidence-root',
      '--public-key',
      '--request-id',
      '--server-private-key',
    ].includes(flag)
        || !value || value.startsWith('--')) {
      throw new ReleasePlanEvaluationError(`invalid or incomplete option: ${flag ?? 'missing'}`);
    }
    if (seen.has(flag)) throw new ReleasePlanEvaluationError(`duplicate option: ${flag}`);
    seen.add(flag);
    const property = flag === '--evidence-root' ? 'evidenceRoot'
      : flag === '--promotion-evidence-root' ? 'promotionEvidenceRoot'
      : flag === '--public-key' ? 'publicKey' : flag.slice(2);
    if (flag === '--server-private-key') options.serverPrivateKey = value;
    else if (flag === '--request-id') options.requestId = value;
    else options[property] = value;
    index += 2;
  }
  if (!options.input) throw new ReleasePlanEvaluationError('--input is required');
  if (['evaluate', 'activation-request'].includes(command) && !options.evidenceRoot) {
    throw new ReleasePlanEvaluationError('--evidence-root is required for release evaluation');
  }
  if (['evaluate', 'activation-request'].includes(command) && !options.promotionEvidenceRoot) {
    throw new ReleasePlanEvaluationError('--promotion-evidence-root is required for release evaluation');
  }
  if (!['evaluate', 'activation-request'].includes(command)
      && (options.evidenceRoot || options.promotionEvidenceRoot
      || options.publicKey || options.allowTestKey || options.requestId
      || options.serverPrivateKey)) {
    throw new ReleasePlanEvaluationError('authoritative evidence options apply only to evaluate');
  }
  if (options.publicKey && (!options.allowTestKey || process.env.NODE_ENV !== 'test')) {
    throw new ReleasePlanEvaluationError('--public-key is allowed only with --allow-test-key in test mode');
  }
  if (command === 'activation-request' && (!options.requestId || !options.serverPrivateKey
      || !options.output)) {
    throw new ReleasePlanEvaluationError(
      'activation-request requires --request-id, --server-private-key, and --output',
    );
  }
  return options;
}

function readGovernedJson(file) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new ReleasePlanEvaluationError(`input cannot be read: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ReleasePlanEvaluationError('input must be a regular non-symlink file');
  }
  if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES) {
    throw new ReleasePlanEvaluationError(`input size must be from 1 through ${MAX_INPUT_BYTES} bytes`);
  }
  try {
    return { resolved, value: JSON.parse(fs.readFileSync(resolved, 'utf8')) };
  } catch (error) {
    throw new ReleasePlanEvaluationError(`input JSON is invalid: ${error.message}`);
  }
}

function writeGovernedJson(file, inputPath, value) {
  const resolved = path.resolve(file);
  if (resolved === inputPath) throw new ReleasePlanEvaluationError('output must not overwrite the input ledger');
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new ReleasePlanEvaluationError('output must not be a symbolic link');
  }
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(resolved)}.${process.pid}.tmp`);
  if (fs.existsSync(temporary)) throw new ReleasePlanEvaluationError('temporary output already exists');
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary write error; the bounded temporary path is never user input.
    }
    throw new ReleasePlanEvaluationError(`output cannot be written: ${error.message}`);
  }
}

export function runReleasePlanEvaluator(argv) {
  const options = parseArgs(argv);
  if (options.help) return { help: true, exitCode: 0, text: `${usage()}\n` };
  const input = readGovernedJson(options.input);
  const evidenceOptions = {
      evidenceRoot: options.evidenceRoot,
      promotionEvidenceRoot: options.promotionEvidenceRoot,
      trustedPublicKeyPath: options.publicKey || undefined,
      allowTestKey: options.allowTestKey && process.env.NODE_ENV === 'test',
      allowTestPromotionRoot: options.allowTestKey && process.env.NODE_ENV === 'test',
    };
  let result;
  if (options.command === 'evaluate') {
    result = evaluateReleaseObservationWindow(input.value, evidenceOptions);
  } else if (options.command === 'shadow-readiness') {
    result = evaluateReleaseShadowReadiness(input.value);
  } else {
    const testMode = options.allowTestKey && process.env.NODE_ENV === 'test';
    if (!testMode && typeof process.geteuid === 'function' && process.geteuid() !== 0) {
      throw new ReleasePlanEvaluationError('activation request must run as root on ServerDominguez');
    }
    const keyPath = path.resolve(options.serverPrivateKey);
    const keyStat = fs.lstatSync(keyPath);
    if (!keyStat.isFile() || keyStat.isSymbolicLink()
        || (!testMode && (keyStat.uid !== 0 || (keyStat.mode & 0o077) !== 0))) {
      throw new ReleasePlanEvaluationError(
        'ServerDominguez provenance private key ownership or mode is unsafe',
      );
    }
    const payload = buildProtectedMainReuseServerPayload(input.value, evidenceOptions, {
      requestId: options.requestId,
      sourceRoot: path.resolve(import.meta.dirname, '..'),
    });
    result = signServerActivationRequest(payload, fs.readFileSync(keyPath, 'utf8'));
  }
  if (options.output) writeGovernedJson(options.output, input.resolved, result);
  const exitCode = options.command === 'activation-request'
    ? 0
    : result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 2 : 3;
  return { help: false, exitCode, result };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const outcome = runReleasePlanEvaluator(argv);
    if (outcome.help) process.stdout.write(outcome.text);
    else process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release plan evaluation failed: ${message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

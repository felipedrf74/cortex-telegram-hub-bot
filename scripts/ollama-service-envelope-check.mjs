#!/usr/bin/env node

import {
  OLLAMA_ENVELOPE,
  readAndValidateOllamaEnvelope,
} from './lib/ollama-service-envelope.mjs';

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function parseArgs(argv) {
  const options = {
    expectedSwapBytes: OLLAMA_ENVELOPE.memorySwapBaselineBytes,
    systemctlBin: 'systemctl',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--expected-swap-bytes') {
      options.expectedSwapBytes = Number(argv[++index]);
    } else if (arg === '--systemctl-bin') {
      options.systemctlBin = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: ollama-service-envelope-check.mjs [--expected-swap-bytes 536870912|0]\n');
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`, 64);
    }
  }
  if (![0, OLLAMA_ENVELOPE.memorySwapBaselineBytes].includes(options.expectedSwapBytes)) {
    fail('--expected-swap-bytes must be 536870912 or 0', 64);
  }
  if (options.systemctlBin !== 'systemctl' && process.env.NEXUS_OLLAMA_SYSTEMD_TEST_MODE !== '1') {
    fail('--systemctl-bin is test-only', 64);
  }
  if (!options.systemctlBin) fail('--systemctl-bin requires a value', 64);
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const observed = readAndValidateOllamaEnvelope(options);
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.ollama-service-envelope-check.v1',
    ok: true,
    expectedSwapBytes: options.expectedSwapBytes,
    observed,
  })}\n`);
} catch (error) {
  process.stderr.write(`ollama_envelope_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}

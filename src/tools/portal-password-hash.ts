// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Prints the PORTAL_OPERATOR_PASSWORD_HASH value for an operator password.
 *
 *   node dist/tools/portal-password-hash.js            # prompts on the TTY
 *   echo -n 'the password' | node dist/tools/portal-password-hash.js --stdin
 *
 * The password is never accepted as a command-line argument (it would land in
 * shell history and `ps`). Nothing is stored; paste the printed line into the
 * release env next to PORTAL_OPERATOR_USERNAME.
 */

import readline from 'readline';
import { PORTAL_PASSWORD_MIN_LENGTH, hashPortalPassword } from '../services/portal-password';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const output = process.stderr as NodeJS.WriteStream & { muted?: boolean };
    const originalWrite = output.write.bind(output);
    // Echo nothing while the password is typed.
    (output as any).write = (chunk: any, ...rest: any[]) => (rl as any).line !== undefined && typeof chunk === 'string' && !chunk.includes(question)
      ? true
      : originalWrite(chunk, ...rest);
    rl.question(question, (answer) => {
      (output as any).write = originalWrite;
      originalWrite('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node dist/tools/portal-password-hash.js [--stdin]\nPrints PORTAL_OPERATOR_PASSWORD_HASH=<scrypt hash> for the password read from the TTY (or stdin with --stdin).');
    return;
  }
  const password = process.argv.includes('--stdin') ? await readStdin() : await prompt('Operator password: ');
  if (password.length < PORTAL_PASSWORD_MIN_LENGTH) {
    console.error(`Password must be at least ${PORTAL_PASSWORD_MIN_LENGTH} characters.`);
    process.exitCode = 2;
    return;
  }
  console.log(`PORTAL_OPERATOR_PASSWORD_HASH=${hashPortalPassword(password)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

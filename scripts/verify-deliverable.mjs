#!/usr/bin/env node
// Copyright (c) 2026 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Lightweight final-handoff verifier for Delivered Means Verified gates.
 *
 * This intentionally checks only handoff hygiene that can be proven locally:
 * claim level is declared, evidence is present, limits are explicit, and stale
 * "verifier missing" blockers are not carried forward as delivery evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const failures = [];

if (!args.claim || !args.handoff) {
  failures.push('usage: node scripts/verify-deliverable.mjs --claim L1-L5 --handoff <path>');
} else {
  verifyClaim(args.claim);
  verifyHandoff(args.claim, args.handoff);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[verify-deliverable] FAIL ${failure}`);
  process.exit(1);
}

console.log(`[verify-deliverable] OK ${args.claim} ${args.handoff}`);

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--claim') parsed.claim = rawArgs[index + 1];
    if (arg.startsWith('--claim=')) parsed.claim = arg.slice('--claim='.length);
    if (arg === '--handoff') parsed.handoff = rawArgs[index + 1];
    if (arg.startsWith('--handoff=')) parsed.handoff = arg.slice('--handoff='.length);
  }
  return parsed;
}

function verifyClaim(claim) {
  if (!/^L[1-5]$/.test(claim)) failures.push(`invalid claim level: ${claim}`);
}

function verifyHandoff(claim, handoffPath) {
  const absolutePath = path.resolve(handoffPath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`handoff missing: ${handoffPath}`);
    return;
  }

  const markdown = fs.readFileSync(absolutePath, 'utf8');
  const normalized = markdown.toLowerCase();
  const expectedClaim = claim.toLowerCase();

  if (markdown.trim().length === 0) failures.push(`handoff empty: ${handoffPath}`);
  if (!normalized.includes(expectedClaim)) failures.push(`handoff does not mention requested claim ${claim}`);
  if (!/\bclaim\b/i.test(markdown)) failures.push('handoff does not declare a claim section or maximum claim');
  if (!/\bevidence\b/i.test(markdown)) failures.push('handoff does not include evidence');
  if (!/\blimits?\b/i.test(markdown)) failures.push('handoff does not include explicit limits');
  if (/verify-deliverable\.mjs[\s\S]{0,160}\b(blocked|missing|unavailable|cannot find module)\b/i.test(markdown)) {
    failures.push('handoff still describes verify-deliverable.mjs as blocked or unavailable');
  }

  const numericClaim = Number(claim.slice(1));
  if (numericClaim >= 3 && !/\b(peer|independent)\b/i.test(markdown)) {
    failures.push('L3+ claim requires peer or independent validation evidence');
  }
  if (numericClaim >= 4 && !/\b(runtime|simulator|smoke|integration)\b/i.test(markdown)) {
    failures.push('L4+ claim requires runtime/integration evidence');
  }
  if (numericClaim >= 5 && !/\b(production|deployed|deploy|health)\b/i.test(markdown)) {
    failures.push('L5 claim requires production deploy/health evidence');
  }
}

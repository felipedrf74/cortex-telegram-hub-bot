#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEN_SCRIPT_ACCEPTANCE_SCHEMA = 'nexus.content-ten-script-acceptance.v2';
export const TEN_SCRIPT_ACCEPTANCE_REVISION = '2026-08-24-v3';
export const TEN_SCRIPT_ACCEPTANCE_SCENARIOS = Object.freeze([
  { id: 'std-en-01', phase: 'pre-release', deliveryMode: 'standard', language: 'en', topic: 'Build a practical meal-prep system for busy professionals using timeless planning, food-safety, and consistency principles.' },
  { id: 'std-ptbr-01', phase: 'pre-release', deliveryMode: 'standard', language: 'pt-BR', topic: 'Crie um sistema prático de formação de hábitos para profissionais ocupados, com princípios atemporais, exemplos e passos acionáveis.' },
  { id: 'std-en-02', phase: 'pre-release', deliveryMode: 'standard', language: 'en', topic: 'Explain a sustainable recovery routine for an amateur triathlete using timeless sleep, mobility, fueling, and workload principles.' },
  { id: 'std-ptbr-02', phase: 'pre-release', deliveryMode: 'standard', language: 'pt-BR', topic: 'Explique um método atemporal de produtividade pessoal para priorizar trabalho importante sem esgotamento.' },
  { id: 'sched-en-01', phase: 'pre-release', deliveryMode: 'scheduled', language: 'en', topic: 'Create a beginner-friendly home strength progression using timeless technique, recovery, and progressive-overload principles.' },
  { id: 'sched-ptbr-01', phase: 'pre-release', deliveryMode: 'scheduled', language: 'pt-BR', topic: 'Crie um sistema editorial atemporal para transformar uma ideia em roteiro, revisão e publicação com qualidade consistente.' },
  { id: 'sched-en-02', phase: 'pre-release', deliveryMode: 'scheduled', language: 'en', topic: 'Teach timeless cooking fundamentals for balancing salt, acid, fat, heat, texture, and timing in everyday meals.' },
  { id: 'prio-ptbr-01', phase: 'pre-release', deliveryMode: 'priority', language: 'pt-BR', topic: 'Explique princípios atemporais de organização financeira pessoal, orçamento, reserva e decisões conscientes sem aconselhamento individual.' },
  { id: 'prio-en-01', phase: 'pre-release', deliveryMode: 'priority', language: 'en', topic: 'Explain timeless marathon pacing principles, effort control, fueling practice, and race-day decision making for recreational runners.' },
  { id: 'prio-ptbr-smoke', phase: 'production-smoke', deliveryMode: 'priority', language: 'pt-BR', topic: 'Crie um guia atemporal de organização digital para reduzir distrações e manter arquivos, tarefas e comunicação sob controle.' },
]);

function fail(message, code = 1) {
  console.error(`content acceptance refused: ${message}`);
  process.exit(code);
}

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) fail(`${name} requires a value`, 64);
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertPrivateRegularFile(filename, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    fail(`${label} must be a mode-0600, single-link regular file`, 77);
  }
}

function atomicPrivateWrite(filename, value) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function initialState() {
  return {
    schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    createdAt: new Date().toISOString(),
    scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map(({ topic, ...scenario }) => ({
      ...scenario,
      topicSha256: sha256(topic),
      status: 'pending',
      jobId: null,
      output: null,
    })),
  };
}

function readState(filename) {
  if (!fs.existsSync(filename)) {
    const state = initialState();
    atomicPrivateWrite(filename, state);
    return state;
  }
  assertPrivateRegularFile(filename, 'acceptance state');
  const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (state?.schemaVersion !== TEN_SCRIPT_ACCEPTANCE_SCHEMA
      || state.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || !Array.isArray(state.scenarios)
      || state.scenarios.length !== TEN_SCRIPT_ACCEPTANCE_SCENARIOS.length
      || state.scenarios.some((row, index) => row.id !== TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index].id
        || row.topicSha256 !== sha256(TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index].topic))) {
    fail('acceptance state does not match the immutable ten-scenario inventory', 65);
  }
  return state;
}

function countWords(value) {
  return String(value ?? '').trim().split(/\s+/u).filter(Boolean).length;
}

async function api(baseUrl, token, method, endpoint, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const safeCode = payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`;
    throw new Error(`${endpoint} returned ${safeCode}`);
  }
  return payload?.data ?? payload;
}

function requestFor(scenario) {
  return {
    topic: scenario.topic,
    niche: 'general education',
    format: 'YouTube',
    mode: 'deep',
    deliveryMode: scenario.deliveryMode,
    language: scenario.language,
    renderMode: 'structured',
    scriptStyle: 'detailed',
    maxDurationMinutes: 15,
    targetDurationSeconds: 900,
    forceRefresh: true,
      idempotencyKey: `hybrid-plan-acceptance-${scenario.id}-${TEN_SCRIPT_ACCEPTANCE_REVISION}`,
  };
}

export function updateAcceptanceScenarioFromView(row, view) {
  row.status = view.status;
  row.stage = view.stage;
  row.progress = view.progress;
  row.updatedAt = view.updatedAt;
  delete row.lastPollError;
  delete row.lastPollErrorAt;
  if (view.errorCode) row.errorCode = view.errorCode;
  else delete row.errorCode;
  if (view.status !== 'completed') {
    row.output = null;
    return;
  }
  const script = view.result?.script;
  const words = countWords(script);
  const warnings = Array.isArray(view.warnings) ? view.warnings.filter((value) => typeof value === 'string') : [];
  const sourceConsistent = !warnings.includes('unsupported_source_url');
  row.output = {
    scriptSha256: sha256(String(script ?? '')),
    wordCount: words,
    warnings,
    route: typeof view.route === 'string' ? view.route : null,
    modelDigest: typeof view.modelDigest === 'string' ? view.modelDigest : null,
    sourceConsistent,
    contractPass: typeof script === 'string' && words >= 1900 && words <= 2400
      && warnings.length === 0 && sourceConsistent,
  };
}

function summary(state) {
  const rows = state.scenarios;
  const completed = rows.filter((row) => row.status === 'completed');
  const contractPasses = completed.filter((row) => row.output?.contractPass === true);
  return {
    schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    inventoryCount: rows.length,
    submitted: rows.filter((row) => row.jobId).length,
    completed: completed.length,
    contractPasses: contractPasses.length,
    terminalFailures: rows.filter((row) => row.status === 'failed' || row.status === 'cancelled').length,
    delivery: Object.fromEntries(['standard', 'scheduled', 'priority'].map((mode) => [mode, rows.filter((row) => row.deliveryMode === mode).length])),
    languages: Object.fromEntries(['en', 'pt-BR'].map((language) => [language, rows.filter((row) => row.language === language).length])),
    productionSmokeCompleted: rows.find((row) => row.phase === 'production-smoke')?.status === 'completed',
    acceptancePass: completed.length === 10 && contractPasses.length === 10,
  };
}

async function main() {
  const phase = option('--phase', true);
  if (!['pre-release', 'production-smoke', 'status'].includes(phase)) fail('--phase must be pre-release, production-smoke, or status', 64);
  const statePath = path.resolve(option('--state', true));
  const state = readState(statePath);

  if (phase !== 'status') {
    const authPath = path.resolve(option('--auth-file', true));
    assertPrivateRegularFile(authPath, 'auth file');
    const token = fs.readFileSync(authPath, 'utf8').trim();
    if (!token || /\s/u.test(token)) fail('auth file must contain exactly one bearer token', 65);
    const baseUrl = option('--base-url', true);
    if (!/^https:\/\//u.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(baseUrl)) {
      fail('--base-url must be HTTPS or loopback HTTP', 64);
    }
    if (phase === 'production-smoke') {
      const preRelease = state.scenarios.filter((row) => row.phase === 'pre-release');
      if (preRelease.some((row) => row.status !== 'completed' || row.output?.contractPass !== true)) {
        fail('production smoke is locked until all nine pre-release scripts pass', 78);
      }
      const deployedSha = option('--deployed-sha', true);
      if (!/^[0-9a-f]{40}$/u.test(deployedSha)) fail('--deployed-sha must be an exact 40-character source commit', 64);
      state.productionSmokeSourceSha = deployedSha;
    }
    const targets = TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((scenario) => scenario.phase === phase);
    for (const scenario of targets) {
      const row = state.scenarios.find((candidate) => candidate.id === scenario.id);
      try {
        if (!row.jobId) {
          const created = await api(baseUrl, token, 'POST', '/api/v1/content/script-jobs', requestFor(scenario));
          row.jobId = created.jobId;
          row.status = created.status;
          row.submittedAt = new Date().toISOString();
          atomicPrivateWrite(statePath, state);
        }
        // A failed or cancelled durable job may have been retried through the
        // authenticated retry endpoint between acceptance passes. Always read
        // the server-owned view so the private evidence state can resume that
        // same immutable job identity instead of remaining terminal forever.
        const view = await api(baseUrl, token, 'GET', `/api/v1/content/script-jobs/${encodeURIComponent(row.jobId)}`);
        updateAcceptanceScenarioFromView(row, view);
        atomicPrivateWrite(statePath, state);
      } catch (error) {
        row.lastPollError = error instanceof Error ? error.message.slice(0, 240) : 'unknown_error';
        row.lastPollErrorAt = new Date().toISOString();
        atomicPrivateWrite(statePath, state);
      }
    }
  }

  console.log(JSON.stringify(summary(state), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

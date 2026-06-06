#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  buildChatShadowSampleEvidenceHash,
  type ChatShadowGateSample,
  type NexusChatShadowLanguage,
} from '../src/services/chat-shadow-gate-readiness';
import type { NexusAnswerCompositionMode } from '../src/services/chat-final-answer-composer';

dotenv.config({ quiet: true });

type EvidenceSource = 'local_sandbox_seed';

type SeedSample = {
  sampleId: string;
  language: NexusChatShadowLanguage;
  finalCapabilityId: string;
  candidateCapabilities: string[];
  routeOwner: string;
  routeMethod: string;
  compositionMode: NexusAnswerCompositionMode;
  firstProgressMs: number;
  deterministicReadKind: string;
};

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const source: EvidenceSource = 'local_sandbox_seed';
const shouldReplace = hasFlag('--replace');
const shouldWrite = hasFlag('--write');
const requestedRows = parsePositiveInt(readArg('--rows')) ?? 64;
const deterministicReadKinds = ['today', 'calendar', 'tasks', 'training_today', 'what_changed'];

if (!shouldWrite) {
  console.error([
    'Refusing to write local ChatV2 evidence without --write.',
    'This script creates LOCAL SANDBOX seed rows only; these rows are not production shadow proof.',
    'Use: npx tsx scripts/chatv2-seed-local-evidence.ts --write --replace --rows=64',
  ].join('\n'));
  process.exitCode = 1;
} else {
  const db = new Database(dbPath);
  try {
    ensureEvidenceSchema(db);
    const samples = buildSeedSamples(Math.max(50, requestedRows));
    const tx = db.transaction(() => {
      if (shouldReplace) {
        db.prepare('DELETE FROM chat_v2_completion_evidence WHERE evidence_source = ?').run(source);
        db.prepare('DELETE FROM chat_v2_deterministic_read_evidence WHERE evidence_source = ?').run(source);
        db.prepare('DELETE FROM chat_v2_write_evidence WHERE evidence_source = ?').run(source);
        db.prepare('DELETE FROM chat_v2_cloud_allowlist_evidence WHERE evidence_source = ?').run(source);
        db.prepare('DELETE FROM chat_v2_legacy_retirement_evidence WHERE evidence_source = ?').run(source);
      }
      for (const sample of samples) {
        insertEvidencePair(db, sample, source);
        insertDeterministicReadEvidence(db, sample, source);
      }
      insertTokenZeroEvidence(db, source);
      insertWriteEvidence(db, source);
      insertCloudAllowlistEvidence(db, source);
      insertLegacyRetirementEvidence(db, source);
    });
    tx();
    const count = db.prepare(`
      SELECT 'completion' AS table_name, evidence_kind, COUNT(*) AS count
      FROM chat_v2_completion_evidence
      WHERE evidence_source = ?
      GROUP BY evidence_kind
      UNION ALL
      SELECT 'deterministic_read' AS table_name, evidence_kind, COUNT(*) AS count
      FROM chat_v2_deterministic_read_evidence
      WHERE evidence_source = ?
      GROUP BY evidence_kind
      UNION ALL
      SELECT 'write' AS table_name, phase AS evidence_kind, COUNT(*) AS count
      FROM chat_v2_write_evidence
      WHERE evidence_source = ?
      GROUP BY phase
      UNION ALL
      SELECT 'cloud_allowlist' AS table_name,
             CASE WHEN sent_to_cloud = 1 THEN 'sent' ELSE 'denied_or_local' END AS evidence_kind,
             COUNT(*) AS count
      FROM chat_v2_cloud_allowlist_evidence
      WHERE evidence_source = ?
      GROUP BY sent_to_cloud
      UNION ALL
      SELECT 'legacy_retirement' AS table_name, evidence_kind, COUNT(*) AS count
      FROM chat_v2_legacy_retirement_evidence
      WHERE evidence_source = ?
      GROUP BY evidence_kind
      ORDER BY table_name, evidence_kind
    `).all(source, source, source, source, source) as Array<{ table_name: string; evidence_kind: string; count: number }>;
    console.log(JSON.stringify({
      schemaVersion: 'chat_v2_local_evidence_seed_result.v1',
      dbPath,
      evidenceSource: source,
      requestedRows,
      insertedSamples: samples.length,
      rowsByKind: count,
      readinessCommand: `npx tsx scripts/chatv2-completion-readiness.ts --source=${source} --limit=${samples.length}`,
      productionGateWarning: 'local_sandbox_seed rows validate local plumbing only; production gates must use runtime_route evidence.',
    }, null, 2));
  } finally {
    db.close();
  }
}

function buildSeedSamples(count: number): SeedSample[] {
  const languages: NexusChatShadowLanguage[] = ['en', 'pt-BR', 'pt-PT', 'mixed'];
  const capabilities = [
    { id: 'training.read_today', owner: 'training', route: 'deterministic-read' },
    { id: 'cooking.answer', owner: 'cooking', route: 'local-chat-v2' },
    { id: 'content.answer', owner: 'content', route: 'local-chat-v2' },
    { id: 'finance.education', owner: 'finance', route: 'local-chat-v2' },
    { id: 'tasks.read', owner: 'tasks', route: 'deterministic-read' },
    { id: 'calendar.read', owner: 'secretary', route: 'deterministic-read' },
    { id: 'general.help', owner: 'general', route: 'local-chat-v2' },
    { id: 'secretary.read_today', owner: 'secretary', route: 'deterministic-read' },
  ];
  return Array.from({ length: count }, (_, index) => {
    const language = languages[index % languages.length]!;
    const capability = capabilities[index % capabilities.length]!;
    const alternates = capabilities
      .filter((entry) => entry.id !== capability.id)
      .slice(0, 5)
      .map((entry) => entry.id);
    return {
      sampleId: `local-seed-${language}-${index + 1}`,
      language,
      finalCapabilityId: capability.id,
      candidateCapabilities: [capability.id, ...alternates, 'unsupported', 'general.help'].slice(0, 8),
      routeOwner: capability.owner,
      routeMethod: capability.route,
      compositionMode: index % 4 === 0 ? 'model_constrained' : 'templated',
      firstProgressMs: 450 + (index % 25) * 45,
      deterministicReadKind: deterministicReadKinds[index % deterministicReadKinds.length]!,
    };
  });
}

function insertEvidencePair(db: Database.Database, sample: SeedSample, source: EvidenceSource): void {
  const messageHmac = hmacToken('message', sample.sampleId);
  const shadowSample: ChatShadowGateSample = {
    sampleId: messageHmac,
    language: sample.language,
    candidateCapabilities: sample.candidateCapabilities,
    finalCapabilityId: sample.finalCapabilityId,
    schemaValidAfterRepair: true,
    messageIdentifierKind: 'hmac',
    storedRawMessageText: false,
    unsafeRawFieldCount: 0,
  };
  const candidateEvidenceHash = buildChatShadowSampleEvidenceHash(shadowSample);
  const safeMetadata = JSON.stringify({
    schemaVersion: 'chat_v2_local_sandbox_seed.v1',
    evidenceSource: source,
    seedId: hmacToken('seed', sample.sampleId),
    routeOwner: sample.routeOwner,
    routeMethod: sample.routeMethod,
    capabilityId: sample.finalCapabilityId,
  });

  const insert = db.prepare(`
    INSERT INTO chat_v2_completion_evidence (
      evidence_kind, evidence_source, tenant_id, user_id, request_id, message_hmac,
      message_identifier_kind, locale, candidate_capabilities_json, final_capability_id,
      schema_valid_after_repair, candidate_evidence_hash, route_owner, route_method,
      response_contract_valid, answer_accepted, unsupported_claim_caught, first_progress_ms,
      leaked_raw_private_field, composition_mode, raw_field_audit_count, safe_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'hmac', ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, ?, 0, ?, 0, ?)
  `);

  insert.run(
    'shadow',
    source,
    0,
    0,
    hmacToken('request', `${sample.sampleId}:shadow`),
    messageHmac,
    sample.language,
    JSON.stringify(sample.candidateCapabilities),
    sample.finalCapabilityId,
    candidateEvidenceHash,
    sample.routeOwner,
    sample.routeMethod,
    null,
    null,
    null,
    sample.compositionMode,
    safeMetadata,
  );

  insert.run(
    'answer_canary',
    source,
    0,
    0,
    hmacToken('request', `${sample.sampleId}:answer_canary`),
    messageHmac,
    sample.language,
    JSON.stringify(sample.candidateCapabilities),
    sample.finalCapabilityId,
    candidateEvidenceHash,
    sample.routeOwner,
    sample.routeMethod,
    1,
    1,
    sample.firstProgressMs,
    sample.compositionMode,
    safeMetadata,
  );
}

function insertDeterministicReadEvidence(
  db: Database.Database,
  sample: SeedSample,
  source: EvidenceSource,
): void {
  const sampleHmac = hmacToken('deterministic-read', sample.sampleId);
  const safeMetadata = JSON.stringify({
    schemaVersion: 'chat_v2_deterministic_read_local_sandbox_seed.v1',
    evidenceSource: source,
    seedId: hmacToken('seed', sample.sampleId),
    readKind: sample.deterministicReadKind,
    routeOwner: sample.routeOwner,
    routeMethod: sample.routeMethod,
  });

  db.prepare(`
    INSERT INTO chat_v2_deterministic_read_evidence (
      evidence_kind, evidence_source, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, read_kind, token_zero_surface, response_contract_valid,
      tenant_user_isolation_passed, token_zero_preserved, raw_field_audit_count,
      safe_metadata_json
    ) VALUES ('deterministic_read', ?, 0, 0, ?, ?, 'hmac', ?, NULL, 1, 1, NULL, 0, ?)
  `).run(
    source,
    hmacToken('request', `${sample.sampleId}:deterministic_read`),
    sampleHmac,
    sample.deterministicReadKind,
    safeMetadata,
  );
}

function insertTokenZeroEvidence(db: Database.Database, source: EvidenceSource): void {
  const surfaces: Array<'slash' | 'button' | 'api'> = ['slash', 'button', 'api'];
  const insert = db.prepare(`
    INSERT INTO chat_v2_deterministic_read_evidence (
      evidence_kind, evidence_source, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, read_kind, token_zero_surface, response_contract_valid,
      tenant_user_isolation_passed, token_zero_preserved, raw_field_audit_count,
      safe_metadata_json
    ) VALUES ('token_zero_surface', ?, 0, 0, ?, ?, 'hmac', 'token_zero_surface', ?, 1, 1, 1, 0, ?)
  `);
  for (const surface of surfaces) {
    insert.run(
      source,
      hmacToken('request', `token-zero:${surface}`),
      hmacToken('token-zero', surface),
      surface,
      JSON.stringify({
        schemaVersion: 'chat_v2_token_zero_local_sandbox_seed.v1',
        evidenceSource: source,
        surface,
      }),
    );
  }
}

function insertWriteEvidence(db: Database.Database, source: EvidenceSource): void {
  const insert = db.prepare(`
    INSERT INTO chat_v2_write_evidence (
      evidence_source, phase, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, risk_class, preview_valid, diff_required,
      visible_diff_present, executed, validated_before_execution, success_claimed,
      verification_status, escalated_per_policy, idempotency_passed, retry_cancel_passed,
      raw_field_audit_count, safe_metadata_json
    ) VALUES (?, ?, 0, 0, ?, ?, 'hmac', ?, 1, ?, 1, ?, 1, ?, ?, ?, 1, 1, 0, ?)
  `);

  const previewSamples = [
    { id: 'task-create', riskClass: 'A', diffRequired: true },
    { id: 'task-with-subtasks', riskClass: 'A', diffRequired: true },
    { id: 'task-complete-preview', riskClass: 'A', diffRequired: true },
  ];
  for (const sample of previewSamples) {
    insert.run(
      source,
      'write_preview',
      hmacToken('request', `write-preview:${sample.id}`),
      hmacToken('write', `write-preview:${sample.id}`),
      sample.riskClass,
      1,
      0,
      0,
      'not_required',
      1,
      JSON.stringify({
        schemaVersion: 'chat_v2_write_local_sandbox_seed.v1',
        evidenceSource: source,
        phase: 'write_preview',
        sampleId: hmacToken('seed', sample.id),
      }),
    );
  }

  const confirmedSamples = [
    { id: 'task-complete-execute', riskClass: 'A', successClaimed: true, verificationStatus: 'verified', escalated: true },
    { id: 'task-create-execute', riskClass: 'A', successClaimed: true, verificationStatus: 'verified', escalated: true },
    { id: 'training-class-c', riskClass: 'C', successClaimed: false, verificationStatus: 'indeterminate', escalated: true },
  ];
  for (const sample of confirmedSamples) {
    insert.run(
      source,
      'confirmed_writes',
      hmacToken('request', `confirmed-write:${sample.id}`),
      hmacToken('write', `confirmed-write:${sample.id}`),
      sample.riskClass,
      1,
      1,
      sample.successClaimed ? 1 : 0,
      sample.verificationStatus,
      sample.escalated ? 1 : 0,
      JSON.stringify({
        schemaVersion: 'chat_v2_write_local_sandbox_seed.v1',
        evidenceSource: source,
        phase: 'confirmed_writes',
        sampleId: hmacToken('seed', sample.id),
      }),
    );
  }
}

function insertCloudAllowlistEvidence(db: Database.Database, source: EvidenceSource): void {
  const insert = db.prepare(`
    INSERT INTO chat_v2_cloud_allowlist_evidence (
      evidence_source, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, sent_to_cloud, raw_private_field_count, denied,
      denial_reason, denial_reason_observable, hmac_entity_id_count,
      non_hmac_entity_id_count, hmac_evidence_fingerprint_count,
      non_hmac_evidence_fingerprint_count, safe_metadata_json
    ) VALUES (?, 0, 0, ?, ?, 'hmac', ?, 0, ?, ?, ?, ?, 0, ?, 0, ?)
  `);

  insert.run(
    source,
    hmacToken('request', 'cloud-allowlist:sent'),
    hmacToken('cloud-allowlist', 'sent'),
    1,
    0,
    null,
    0,
    1,
    1,
    JSON.stringify({
      schemaVersion: 'chat_v2_cloud_allowlist_local_sandbox_seed.v1',
      evidenceSource: source,
      sampleKind: 'sent_packet',
    }),
  );

  for (let index = 0; index < 99; index++) {
    insert.run(
      source,
      hmacToken('request', `cloud-allowlist:denied:${index}`),
      hmacToken('cloud-allowlist', `denied:${index}`),
      0,
      1,
      'insufficient_safe_context_for_cloud',
      1,
      0,
      0,
      JSON.stringify({
        schemaVersion: 'chat_v2_cloud_allowlist_local_sandbox_seed.v1',
        evidenceSource: source,
        sampleKind: 'denied_packet',
        denialReason: 'insufficient_safe_context_for_cloud',
      }),
    );
  }
}

function insertLegacyRetirementEvidence(db: Database.Database, source: EvidenceSource): void {
  const insert = db.prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
      route_id, replaced, tested, shadow_parity_rate, route_sample_count,
      legacy_fallback_rate_24h, full_verify_clean, raw_field_audit_count,
      safe_metadata_json
    ) VALUES (?, ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const routeIds = [
    'chat-action-planner',
    'chat-reasoning-engine-v1',
    'legacy-classifier-route',
    'domain-handler-execution',
  ];
  for (const routeId of routeIds) {
    insert.run(
      source,
      'route_exit',
      hmacToken('request', `legacy-route:${routeId}`),
      hmacToken('legacy-route', routeId),
      routeId,
      1,
      1,
      0.97,
      55,
      null,
      null,
      JSON.stringify({
        schemaVersion: 'chat_v2_legacy_retirement_local_sandbox_seed.v1',
        evidenceSource: source,
        routeId,
      }),
    );
  }
  insert.run(
    source,
    'fallback_rate',
    hmacToken('request', 'legacy-fallback-rate'),
    hmacToken('legacy-fallback-rate', 'local'),
    null,
    null,
    null,
    null,
    null,
    0.01,
    null,
    JSON.stringify({
      schemaVersion: 'chat_v2_legacy_retirement_local_sandbox_seed.v1',
      evidenceSource: source,
      metric: 'legacy_fallback_rate_24h',
    }),
  );
  insert.run(
    source,
    'verify_run',
    hmacToken('request', 'legacy-full-verify'),
    hmacToken('legacy-full-verify', 'local'),
    null,
    null,
    null,
    null,
    null,
    null,
    1,
    JSON.stringify({
      schemaVersion: 'chat_v2_legacy_retirement_local_sandbox_seed.v1',
      evidenceSource: source,
      metric: 'full_verify_clean',
    }),
  );
}

function ensureEvidenceSchema(db: Database.Database): void {
  db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/155_chatv2_completion_evidence.sql'), 'utf8'));
  if (!columnExists(db, 'chat_v2_completion_evidence', 'evidence_source')) {
    db.exec(`
      ALTER TABLE chat_v2_completion_evidence
        ADD COLUMN evidence_source TEXT NOT NULL DEFAULT 'runtime_route'
          CHECK (evidence_source IN ('runtime_route', 'local_sandbox_seed'));
    `);
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_chat_v2_completion_evidence_scope;
    CREATE INDEX IF NOT EXISTS idx_chat_v2_completion_evidence_scope
      ON chat_v2_completion_evidence (tenant_id, user_id, evidence_kind, evidence_source, created_at);
  `);
  db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/157_chatv2_deterministic_read_evidence.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/158_chatv2_write_evidence.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/159_chatv2_cloud_allowlist_evidence.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/160_chatv2_legacy_retirement_evidence.sql'), 'utf8'));
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function hmacToken(kind: string, value: string): string {
  return `hmac:${kind}:${crypto.createHmac('sha256', resolveHmacSecret()).update(value).digest('hex')}`;
}

function resolveHmacSecret(): string {
  return process.env.CHAT_V2_EVIDENCE_HMAC_SECRET
    || process.env.IOS_API_JWT_SECRET
    || 'local-sandbox-chat-v2-evidence-secret';
}

function readArg(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

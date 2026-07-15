// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  OperatorAlertSeverity,
  RecordOperatorAlertInput,
  RecordOperatorAlertResult,
} from './operator-alerts';

export const NEXUS_CHAT_V2_READINESS_ALERTS_VERSION = 'nexus_chat_v2_readiness_alerts.v1';

export type ChatV2ReadinessPhaseId =
  | 'shadow'
  | 'answerCanary'
  | 'deterministicRead'
  | 'writePreview'
  | 'confirmedWrites'
  | 'cloudAllowlist'
  | 'legacyRetirement';

export interface ChatV2ReadinessGateLike {
  gateId: string;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatV2ReadinessPhaseLike {
  passed: boolean;
  gates: ChatV2ReadinessGateLike[];
}

export interface ChatV2CompletionReadinessReportLike {
  schemaVersion?: string;
  generatedAt?: string;
  evidenceSources?: string[];
  shadow?: ChatV2ReadinessPhaseLike;
  answerCanary?: ChatV2ReadinessPhaseLike;
  deterministicRead?: ChatV2ReadinessPhaseLike;
  writePreview?: ChatV2ReadinessPhaseLike;
  confirmedWrites?: ChatV2ReadinessPhaseLike;
  cloudAllowlist?: ChatV2ReadinessPhaseLike;
  legacyRetirement?: ChatV2ReadinessPhaseLike;
}

export interface ChatV2ReadinessDashboardGate {
  gateId: string;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatV2ReadinessDashboardRow {
  phase: ChatV2ReadinessPhaseId;
  passed: boolean;
  gateCount: number;
  blockedGateCount: number;
  gates: ChatV2ReadinessDashboardGate[];
}

export interface ChatV2ReadinessAlertOptions {
  source?: string;
  runbookUrl?: string;
  owner?: string;
}

export interface ChatV2ReadinessAlertRecordResult {
  alertInputs: RecordOperatorAlertInput[];
  results: RecordOperatorAlertResult[];
}

const DEFAULT_SOURCE = 'chat_v2_readiness';
const DEFAULT_OWNER = 'ai-platform';
const DEFAULT_RUNBOOK_URL = 'docs/release/README.md';

const PHASES: Array<{ key: ChatV2ReadinessPhaseId; label: string }> = [
  { key: 'shadow', label: 'Shadow evidence' },
  { key: 'answerCanary', label: 'Answer canary' },
  { key: 'deterministicRead', label: 'Deterministic reads' },
  { key: 'writePreview', label: 'Write preview' },
  { key: 'confirmedWrites', label: 'Confirmed writes' },
  { key: 'cloudAllowlist', label: 'Cloud allowlist' },
  { key: 'legacyRetirement', label: 'Legacy retirement' },
];

const CRITICAL_GATES = new Set([
  'zero_raw_private_cloud_fields',
  'cloud_hmac_only_identifiers',
  'zero_unvalidated_executions',
  'no_success_claim_without_verified_readback',
  'legacy_fallback_rate',
]);

export function buildChatV2ReadinessDashboard(
  report: ChatV2CompletionReadinessReportLike,
): ChatV2ReadinessDashboardRow[] {
  return PHASES.map(({ key }) => {
    const phase = report[key];
    const gates = (phase?.gates ?? []).map(normalizeGate);
    const blockedGateCount = gates.filter((gate) => !gate.passed).length;
    return {
      phase: key,
      passed: Boolean(phase?.passed) && blockedGateCount === 0,
      gateCount: gates.length,
      blockedGateCount,
      gates,
    };
  });
}

export function buildChatV2ReadinessAlertInputs(
  report: ChatV2CompletionReadinessReportLike,
  options: ChatV2ReadinessAlertOptions = {},
): RecordOperatorAlertInput[] {
  const source = options.source ?? DEFAULT_SOURCE;
  const owner = options.owner ?? DEFAULT_OWNER;
  const runbookUrl = options.runbookUrl ?? DEFAULT_RUNBOOK_URL;
  const generatedAt = typeof report.generatedAt === 'string' ? report.generatedAt : null;
  const evidenceSources = Array.isArray(report.evidenceSources)
    ? report.evidenceSources.filter((item): item is string => typeof item === 'string')
    : [];

  const alerts: RecordOperatorAlertInput[] = [];
  for (const { key, label } of PHASES) {
    const phase = report[key];
    if (!phase) {
      alerts.push({
        severity: 'warning',
        source,
        dedupeKey: `chatv2-readiness:${key}:missing_phase`,
        title: `ChatV2 readiness missing: ${label}`,
        detail: `${label} was not present in the readiness report.`,
        metadata: {
          phase: key,
          gateId: 'missing_phase',
          reasonCode: 'missing_phase_report',
          generatedAt,
          evidenceSources,
        },
        owner,
        suspectedArea: 'chat_v2_completion',
        userImpact: 'ChatV2 phase promotion is blocked until readiness evidence is available.',
        runbookUrl,
      });
      continue;
    }

    for (const gate of (phase.gates ?? []).map(normalizeGate)) {
      if (gate.passed) continue;
      alerts.push({
        severity: gateSeverity(gate.gateId),
        source,
        dedupeKey: `chatv2-readiness:${key}:${gate.gateId}`,
        title: `ChatV2 readiness blocked: ${label} / ${gate.gateId}`,
        detail: buildGateDetail(label, gate),
        metadata: {
          phase: key,
          gateId: gate.gateId,
          sampleCount: gate.sampleCount,
          observed: gate.observed,
          threshold: gate.threshold,
          reasonCode: gate.reasonCode ?? null,
          generatedAt,
          evidenceSources,
        },
        owner,
        suspectedArea: 'chat_v2_completion',
        userImpact: phaseUserImpact(key, gate.gateId),
        runbookUrl,
      });
    }
  }
  return alerts;
}

export async function recordChatV2ReadinessOperatorAlerts(
  report: ChatV2CompletionReadinessReportLike,
  options: ChatV2ReadinessAlertOptions = {},
): Promise<ChatV2ReadinessAlertRecordResult> {
  // Import lazily so dashboard/dry-run callers can build safe alert payloads
  // without loading full backend config or opening the database.
  const { recordOperatorAlert } = await import('./operator-alerts');
  const alertInputs = buildChatV2ReadinessAlertInputs(report, options);
  return {
    alertInputs,
    results: alertInputs.map((input) => recordOperatorAlert(input)),
  };
}

function normalizeGate(gate: ChatV2ReadinessGateLike): ChatV2ReadinessDashboardGate {
  return {
    gateId: String(gate.gateId || 'unknown_gate').slice(0, 120),
    passed: gate.passed === true,
    sampleCount: normalizeNumber(gate.sampleCount),
    observed: normalizeNumber(gate.observed),
    threshold: normalizeNumber(gate.threshold),
    reasonCode: typeof gate.reasonCode === 'string' && gate.reasonCode.trim()
      ? gate.reasonCode.trim().slice(0, 160)
      : undefined,
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function gateSeverity(gateId: string): OperatorAlertSeverity {
  return CRITICAL_GATES.has(gateId) ? 'critical' : 'warning';
}

function buildGateDetail(label: string, gate: ChatV2ReadinessDashboardGate): string {
  const reason = gate.reasonCode ? ` reason=${gate.reasonCode}` : '';
  return `${label} gate ${gate.gateId} is blocked: observed=${formatNumber(gate.observed)} threshold=${formatNumber(gate.threshold)} samples=${gate.sampleCount}.${reason}`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function phaseUserImpact(phase: ChatV2ReadinessPhaseId, gateId: string): string {
  if (gateId === 'zero_raw_private_cloud_fields' || gateId === 'cloud_hmac_only_identifiers') {
    return 'Cloud fallback must stay disabled until packet privacy evidence passes.';
  }
  if (gateId === 'no_success_claim_without_verified_readback' || gateId === 'zero_unvalidated_executions') {
    return 'Natural-language writes must stay gated until verified write evidence passes.';
  }
  if (phase === 'legacyRetirement') {
    return 'Legacy natural-language routes must remain enabled until parity evidence passes.';
  }
  return 'ChatV2 phase promotion is blocked until readiness evidence passes.';
}

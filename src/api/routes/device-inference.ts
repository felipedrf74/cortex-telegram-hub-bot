// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Authenticated Apple Foundation Models policy/admission/evidence contract. */

import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendSuccess } from '../response-helpers';
import {
  DEVICE_INFERENCE_POLICY_VERSION,
  getDeviceInferencePolicy,
  recordZeroCreditDeviceInferenceEvidence,
  reserveDeviceInferenceAdmission,
  settleDeviceInferenceAdmission,
  type DeviceInferenceEvidenceInput,
  type DeviceInferenceEvidenceOutcome,
} from '../../services/device-inference-policy';

const DIGEST_RE = /^[a-f0-9]{64}$/u;
const CLIENT_OPERATION_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const ADMISSION_ID_RE = /^[a-f0-9-]{36}$/u;
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/u;
const EVIDENCE_OUTCOMES = new Set<DeviceInferenceEvidenceOutcome>([
  'completed', 'failed', 'unavailable', 'fallback',
]);
const AVAILABILITY_REASONS = new Set([
  'available',
  'deviceNotEligible',
  'appleIntelligenceNotEnabled',
  'modelNotReady',
  'unsupportedOS',
  'unsupportedLocale',
  'frameworkUnavailable',
  'runtimeError',
  'policyDisabled',
  'unknown',
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseEvidence(value: unknown): DeviceInferenceEvidenceInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, new Set([
    'osVersion', 'osBuild', 'deviceModel', 'locale', 'frameworkAvailable',
    'availabilityReason', 'durationMs',
  ]))) return null;
  const strings = ['osVersion', 'osBuild', 'deviceModel', 'locale'] as const;
  if (strings.some((key) => typeof raw[key] !== 'string' || !(raw[key] as string).trim())) return null;
  if (typeof raw.frameworkAvailable !== 'boolean') return null;
  if (raw.availabilityReason !== undefined && raw.availabilityReason !== null
      && (typeof raw.availabilityReason !== 'string'
        || !AVAILABILITY_REASONS.has(raw.availabilityReason))) return null;
  if (raw.durationMs !== undefined && raw.durationMs !== null
      && (!Number.isSafeInteger(raw.durationMs) || (raw.durationMs as number) < 0
        || (raw.durationMs as number) > 600_000)) return null;
  return {
    osVersion: (raw.osVersion as string).trim(),
    osBuild: (raw.osBuild as string).trim(),
    deviceModel: (raw.deviceModel as string).trim(),
    locale: (raw.locale as string).trim(),
    frameworkAvailable: raw.frameworkAvailable,
    availabilityReason: raw.availabilityReason as string | null | undefined,
    durationMs: raw.durationMs as number | null | undefined,
  };
}

function authScope(req: Request): { tenantId: number; userId: number; deviceId: string } {
  const authenticated = req as AuthenticatedRequest;
  return {
    tenantId: authenticated.tenantId,
    userId: authenticated.userId,
    deviceId: authenticated.deviceId,
  };
}

function requireDeviceScope(
  req: Request,
  res: Response,
): { tenantId: number; userId: number; deviceId: string } | null {
  const scope = authScope(req);
  if (!Number.isSafeInteger(scope.tenantId) || scope.tenantId <= 0
      || !Number.isSafeInteger(scope.userId) || scope.userId <= 0
      || !DEVICE_ID_RE.test(scope.deviceId || '')) {
    sendError(res, 'DEVICE_ID_REQUIRED', 'A registered device identity is required.', 403);
    return null;
  }
  return scope;
}

export function deviceInferenceRoutes(): Router {
  const router = Router();

  router.get('/policy', (req: Request, res: Response) => {
    if (!requireDeviceScope(req, res)) return;
    sendSuccess(res, getDeviceInferencePolicy());
  });

  router.post('/admissions', (req: Request, res: Response) => {
    const scope = requireDeviceScope(req, res);
    if (!scope) return;
    const raw = req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !hasOnlyKeys(raw, new Set(['operationKey', 'requestDigest', 'clientOperationId']))
        || raw.operationKey !== 'standard_response'
        || typeof raw.requestDigest !== 'string' || !DIGEST_RE.test(raw.requestDigest)
        || typeof raw.clientOperationId !== 'string' || !CLIENT_OPERATION_RE.test(raw.clientOperationId)) {
      sendError(res, 'DEVICE_ADMISSION_INVALID', 'A closed operation, SHA-256 digest, and client operation id are required.', 400);
      return;
    }
    const result = reserveDeviceInferenceAdmission({
      ...scope,
      requestDigest: raw.requestDigest,
      clientOperationId: raw.clientOperationId,
    });
    if (result.kind === 'denied') {
      sendError(res, result.code, result.message, result.statusCode);
      return;
    }
    sendSuccess(res, { admission: result.admission, replay: result.kind === 'replay' }, { status: 201 });
  });

  router.post('/admissions/:admissionId/settle', (req: Request, res: Response) => {
    const scope = requireDeviceScope(req, res);
    if (!scope) return;
    const admissionId = String(req.params.admissionId || '');
    const raw = req.body;
    if (!ADMISSION_ID_RE.test(admissionId)
        || !raw || typeof raw !== 'object' || Array.isArray(raw)
        || !hasOnlyKeys(raw, new Set(['outcome', 'evidence']))
        || typeof raw.outcome !== 'string'
        || !EVIDENCE_OUTCOMES.has(raw.outcome as DeviceInferenceEvidenceOutcome)) {
      sendError(res, 'DEVICE_SETTLEMENT_INVALID', 'A valid admission, outcome, and evidence are required.', 400);
      return;
    }
    const evidence = parseEvidence(raw.evidence);
    if (!evidence) {
      sendError(res, 'DEVICE_EVIDENCE_INVALID', 'Device runtime evidence is invalid.', 400);
      return;
    }
    const result = settleDeviceInferenceAdmission({
      ...scope,
      admissionId,
      outcome: raw.outcome as DeviceInferenceEvidenceOutcome,
      evidence,
    });
    if (result.kind === 'not_found') {
      sendError(res, 'DEVICE_ADMISSION_NOT_FOUND', 'Device admission was not found.', 404);
      return;
    }
    sendSuccess(res, { state: result.state, replay: result.kind === 'replay' });
  });

  router.post('/evidence', (req: Request, res: Response) => {
    const scope = requireDeviceScope(req, res);
    if (!scope) return;
    const raw = req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !hasOnlyKeys(raw, new Set(['operationKey', 'policyVersion', 'outcome', 'evidence']))
        || (raw.operationKey !== 'local_content_parse' && raw.operationKey !== 'local_content_summarize')
        || raw.policyVersion !== DEVICE_INFERENCE_POLICY_VERSION
        || typeof raw.outcome !== 'string'
        || !EVIDENCE_OUTCOMES.has(raw.outcome as DeviceInferenceEvidenceOutcome)) {
      sendError(res, 'DEVICE_EVIDENCE_INVALID', 'A current zero-credit operation and runtime evidence are required.', 400);
      return;
    }
    const evidence = parseEvidence(raw.evidence);
    if (!evidence) {
      sendError(res, 'DEVICE_EVIDENCE_INVALID', 'Device runtime evidence is invalid.', 400);
      return;
    }
    const recorded = recordZeroCreditDeviceInferenceEvidence({
      ...scope,
      operationKey: raw.operationKey,
      policyVersion: raw.policyVersion,
      outcome: raw.outcome as DeviceInferenceEvidenceOutcome,
      evidence,
    });
    if (!recorded) {
      sendError(res, 'DEVICE_POLICY_STALE', 'The device policy is disabled, stale, or no longer eligible.', 409);
      return;
    }
    sendSuccess(res, { recorded: true });
  });

  return router;
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  AICommandEnvelope,
  CapabilityDefinition,
  ChatCoreV2Domain,
  ChatCoreV2EvidenceItem,
  ChatCoreV2ReadModelResult,
  CommandStatus,
} from './types';

export const DOMAIN_ADAPTER_SCHEMA_VERSION = 'domain_adapter@1.0.0';

export interface TenantScope {
  tenantId: string;
  userId: string;
  locale?: string;
  surface?: 'ios_chat' | 'web_chat' | 'system_automation';
}

export interface DomainAdapterReadRequest {
  requestId: string;
  capabilityId: string;
  args: Record<string, unknown>;
}

export interface DomainAdapterWriteRequest {
  requestId: string;
  capabilityId: string;
  args: Record<string, unknown>;
}

export interface DomainAdapterExecutionResult {
  ok: boolean;
  commandId: string;
  status: CommandStatus;
  result?: Record<string, unknown>;
  error?: string;
}

export type DomainAdapterVerificationVerdict = 'verified' | 'partial' | 'failed' | 'indeterminate';

export interface DomainAdapterVerificationResult {
  verdict: DomainAdapterVerificationVerdict;
  commandId: string;
  evidence: ChatCoreV2EvidenceItem[];
  reasonCodes: string[];
}

export interface DomainAdapterV1 {
  readonly schemaVersion: typeof DOMAIN_ADAPTER_SCHEMA_VERSION;
  readonly domain: ChatCoreV2Domain;

  listCapabilities(ctx: TenantScope): readonly CapabilityDefinition[];

  buildReadContext(args: {
    tenantId: string;
    userId: string;
    request: DomainAdapterReadRequest;
    contextHash: string;
  }): Promise<ChatCoreV2ReadModelResult>;

  previewCommand(args: {
    tenantId: string;
    userId: string;
    request: DomainAdapterWriteRequest;
    contextHash: string;
  }): Promise<AICommandEnvelope>;

  executeCommand(args: {
    tenantId: string;
    userId: string;
    command: AICommandEnvelope;
    idempotencyKey: string;
  }): Promise<DomainAdapterExecutionResult>;

  verifyCommand(args: {
    tenantId: string;
    userId: string;
    result: DomainAdapterExecutionResult;
  }): Promise<DomainAdapterVerificationResult>;

  formatEvidence(evidence: ChatCoreV2ReadModelResult | DomainAdapterExecutionResult): ChatCoreV2EvidenceItem[];
}

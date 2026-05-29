// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AICallResult, AIProvider } from '../ai-provider';
import {
  selectApprovedCloudReasoningProvider,
  type CloudReasoningRequest,
  type CloudReasoningResolution,
} from '../cloud-reasoning-gate';
import { getProvider } from '../provider-registry';
import type { CloudAllowlistPacket } from './cloud-allowlist-packet';

export interface CloudAllowlistAnswerResult {
  text: string;
  providerMetadata: NonNullable<AICallResult['providerMetadata']> & {
    cloudAllowlistPrivacyAction?: 'packet_only';
    requestId?: string;
  };
}

export interface DispatchCloudAllowlistAnswerOptions {
  userId?: number;
  tenantId?: number;
  requestId?: string;
  selectProvider?: (request: CloudReasoningRequest) => Promise<CloudReasoningResolution>;
}

export async function dispatchCloudAllowlistAnswer(
  packet: CloudAllowlistPacket,
  options: DispatchCloudAllowlistAnswerOptions = {},
): Promise<CloudAllowlistAnswerResult> {
  const prompt = buildCloudAllowlistAnswerPrompt(packet);
  const selection = await (options.selectProvider ?? defaultSelectProvider)({
    prompt,
    containsPrivateData: false,
    allowCloudEscalation: true,
  });

  if (selection.rejected) {
    throw new Error(`cloud_allowlist_answer_rejected:${selection.reason}:${selection.warning}`);
  }

  const result = await selection.provider.callDomain(
    packet.domain,
    [],
    prompt,
    '',
    {
      modelOverride: selection.model,
      containsPrivateData: false,
      allowCloudEscalation: true,
      userId: options.userId,
      tenantId: options.tenantId,
      maxTokensOverride: 180,
    },
  );

  return {
    text: String(result.text ?? '').trim(),
    providerMetadata: {
      ...(result.providerMetadata ?? {}),
      providerUsed: selection.provider.name,
      modelUsed: selection.model,
      fallbackUsed: true,
      fallbackReason: 'local_queue_saturation',
      privacyAction: selection.privacyAction,
      cloudAllowlistPrivacyAction: 'packet_only',
      requestId: options.requestId,
    },
  };
}

export function buildCloudAllowlistAnswerPrompt(packet: CloudAllowlistPacket): string {
  return [
    'You are Nexus Hub cloud allowlist fallback.',
    'Answer ONLY from this positive allowlist packet.',
    'The packet contains no raw user message and no private app content.',
    'If the packet is insufficient to answer usefully, say that more safe context is needed.',
    'Do not infer private facts from hashes or fingerprints.',
    'Return one concise answer in the packet locale.',
    '',
    JSON.stringify(packet),
  ].join('\n');
}

async function defaultSelectProvider(request: CloudReasoningRequest): Promise<CloudReasoningResolution> {
  return selectApprovedCloudReasoningProvider(request, (name: string): AIProvider | null => getProvider(name));
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import { getChatCoreV2Capability } from './capability-registry';
import type { ChatCoreV2RouteDecision } from './route-decision';
import type { CapabilityDefinition, ChatCoreV2RouteMethod } from './types';

export const CHAT_CORE_V2_TOOL_SELECTION_VERSION = 'chat_core_v2_tool_selection@1.0.0';
export const CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION = 'chat_core_v2_tools@empty';

export interface ChatCoreV2ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, unknown>;
    required: string[];
  };
  capabilityId: string;
  commandType: string;
  schemaVersion: string;
  risk: CapabilityDefinition['risk'];
  support: CapabilityDefinition['support'];
  promptFamily: string;
}

export type ChatCoreV2ToolOmitReason =
  | 'route_does_not_use_tools'
  | 'unknown_capability'
  | 'not_model_visible'
  | 'route_method_not_supported'
  | 'blocked_or_restricted'
  | 'tool_limit';

export interface ChatCoreV2OmittedToolCapability {
  capabilityId: string;
  reason: ChatCoreV2ToolOmitReason;
}

export interface ChatCoreV2ToolSchemaSet {
  selectionVersion: string;
  toolSchemaSetVersion: string;
  promptFamily: string;
  routeMethod: ChatCoreV2RouteMethod;
  capabilityIds: string[];
  tools: ChatCoreV2ToolSchema[];
  omittedCapabilities: ChatCoreV2OmittedToolCapability[];
  maxToolSchemas: number;
}

export interface SelectChatCoreV2ToolSchemasOptions {
  maxToolSchemas?: number;
}

const DEFAULT_MAX_TOOL_SCHEMAS = 6;
const ROUTES_WITHOUT_TOOLS: ChatCoreV2RouteMethod[] = [
  'deterministic_read',
  'needs_clarification',
  'unsupported',
  'blocked',
];

export function selectChatCoreV2ToolSchemas(
  routeDecision: ChatCoreV2RouteDecision,
  options: SelectChatCoreV2ToolSchemasOptions = {},
): ChatCoreV2ToolSchemaSet {
  const maxToolSchemas = normalizeMaxToolSchemas(options.maxToolSchemas);
  const omittedCapabilities: ChatCoreV2OmittedToolCapability[] = [];
  const routeMethod = routeDecision.routeMethod;

  if (ROUTES_WITHOUT_TOOLS.includes(routeMethod) || !routeDecision.requiresLLM) {
    return emptyToolSchemaSet(routeDecision, maxToolSchemas, routeDecision.selectedCapabilityIds.map((capabilityId) => ({
      capabilityId,
      reason: 'route_does_not_use_tools',
    })));
  }

  const tools: ChatCoreV2ToolSchema[] = [];
  for (const capabilityId of routeDecision.selectedCapabilityIds) {
    const capability = getChatCoreV2Capability(capabilityId);
    if (!capability) {
      omittedCapabilities.push({ capabilityId, reason: 'unknown_capability' });
      continue;
    }
    const omitReason = getToolOmitReason(capability, routeMethod);
    if (omitReason) {
      omittedCapabilities.push({ capabilityId, reason: omitReason });
      continue;
    }
    if (tools.length >= maxToolSchemas) {
      omittedCapabilities.push({ capabilityId, reason: 'tool_limit' });
      continue;
    }
    tools.push(buildToolSchema(capability));
  }

  return {
    selectionVersion: CHAT_CORE_V2_TOOL_SELECTION_VERSION,
    toolSchemaSetVersion: tools.length > 0
      ? buildToolSchemaSetVersion(tools)
      : CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION,
    promptFamily: selectPromptFamily(tools),
    routeMethod,
    capabilityIds: tools.map((tool) => tool.capabilityId),
    tools,
    omittedCapabilities,
    maxToolSchemas,
  };
}

function emptyToolSchemaSet(
  routeDecision: ChatCoreV2RouteDecision,
  maxToolSchemas: number,
  omittedCapabilities: ChatCoreV2OmittedToolCapability[] = [],
): ChatCoreV2ToolSchemaSet {
  return {
    selectionVersion: CHAT_CORE_V2_TOOL_SELECTION_VERSION,
    toolSchemaSetVersion: CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION,
    promptFamily: routeDecision.primaryDomain ? `chat_v2_${routeDecision.primaryDomain}` : 'chat_v2_no_tools',
    routeMethod: routeDecision.routeMethod,
    capabilityIds: [],
    tools: [],
    omittedCapabilities,
    maxToolSchemas,
  };
}

function getToolOmitReason(
  capability: CapabilityDefinition,
  routeMethod: ChatCoreV2RouteMethod,
): ChatCoreV2ToolOmitReason | undefined {
  if (!capability.modelVisible) return 'not_model_visible';
  if (capability.risk === 'restricted' || capability.support.execute === 'blocked') return 'blocked_or_restricted';
  if (routeMethod !== 'planner' && !capability.routeMethods.includes(routeMethod)) {
    return 'route_method_not_supported';
  }
  if (routeMethod === 'planner' && capability.support.preview !== 'supported') {
    return 'route_method_not_supported';
  }
  return undefined;
}

function buildToolSchema(capability: CapabilityDefinition): ChatCoreV2ToolSchema {
  const commandType = capability.commandType ?? capability.capabilityId;
  return {
    name: `chat_v2_${capability.capabilityId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    description: `Propose a ${capability.domain} command preview for ${commandType}. The backend validates, confirms, and executes; this tool never mutates state directly.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        commandType: {
          type: 'string',
          const: commandType,
          description: 'Canonical Nexus Hub command type. Do not invent another value.',
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Command payload using the command schema version declared by this capability.',
        },
        rationale: {
          type: 'string',
          maxLength: 500,
          description: 'Brief user-facing reason for proposing this command.',
        },
      },
      required: ['commandType', 'payload'],
    },
    capabilityId: capability.capabilityId,
    commandType,
    schemaVersion: capability.schemaVersion,
    risk: capability.risk,
    support: { ...capability.support },
    promptFamily: capability.promptFamily,
  };
}

function buildToolSchemaSetVersion(tools: ChatCoreV2ToolSchema[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(tools.map((tool) => ({
      capabilityId: tool.capabilityId,
      commandType: tool.commandType,
      schemaVersion: tool.schemaVersion,
    })).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))))
    .digest('hex')
    .slice(0, 12);
  return `chat_core_v2_tools@1.0.0+${fingerprint}`;
}

function selectPromptFamily(tools: ChatCoreV2ToolSchema[]): string {
  if (tools.length === 0) return 'chat_v2_no_tools';
  const families = [...new Set(tools.map((tool) => tool.promptFamily))];
  return families.length === 1 ? families[0] : 'chat_v2_multi_domain';
}

function normalizeMaxToolSchemas(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TOOL_SCHEMAS;
  if (!Number.isFinite(value) || value < 0) throw new Error('maxToolSchemas must be a non-negative finite number');
  return Math.floor(value);
}

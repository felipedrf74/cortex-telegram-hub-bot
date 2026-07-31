// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  buildManifestClassifierTerminalResponse,
} from '../../src/services/chat-manifest-classifier-terminal';

describe('manifest classifier explicit terminal outcomes', () => {
  it('builds a deterministic clarification response with no executable domain', () => {
    expect(buildManifestClassifierTerminalResponse('clarify', 'en-US')).toEqual({
      disposition: 'clarify',
      text: 'Could you clarify what you want Nexus to do?',
      domain: 'chat',
      routeMethod: 'routing-clarify',
      actionability: 'clarify',
      actionStatus: 'needs_clarification',
      reasonCodes: ['classifier_explicit_clarify'],
      userActionRequired: true,
    });
  });

  it('builds a deterministic unsupported response for none', () => {
    expect(buildManifestClassifierTerminalResponse('none', 'en-US')).toMatchObject({
      disposition: 'none',
      domain: 'chat',
      routeMethod: 'unsupported',
      actionability: 'blocked',
      actionStatus: 'blocked',
      reasonCodes: ['classifier_explicit_none'],
      userActionRequired: true,
    });
  });

  it('uses Portuguese only for Portuguese locales and keeps retired Spanish on English', () => {
    expect(buildManifestClassifierTerminalResponse('clarify', 'pt-PT').text).toContain('Podes esclarecer');
    expect(buildManifestClassifierTerminalResponse('none', 'pt-BR').text).toContain('Ainda não consigo');
    expect(buildManifestClassifierTerminalResponse('clarify', 'es-419').text).toBe(
      'Could you clarify what you want Nexus to do?',
    );
  });
});

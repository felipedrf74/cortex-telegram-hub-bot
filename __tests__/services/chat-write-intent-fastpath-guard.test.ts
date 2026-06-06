// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { shouldBypassChatReadFastPathsForWriteIntent } from '../../src/services/chat-write-intent-fastpath-guard';

describe('shouldBypassChatReadFastPathsForWriteIntent', () => {
  it('bypasses read fast-paths for task creation with newline subtasks', () => {
    expect(shouldBypassChatReadFastPathsForWriteIntent([
      'Crie uma tarefa para comprar suplementos QA:',
      'k2',
      'd3',
      'creatina',
    ].join('\n'))).toBe(true);
  });

  it('bypasses read fast-paths for explicit subtask creation wording', () => {
    expect(shouldBypassChatReadFastPathsForWriteIntent('Create task Prozis where it has sub tasks called creatine K2 D3')).toBe(true);
  });

  it('bypasses read fast-paths for exact task completion requests', () => {
    expect(shouldBypassChatReadFastPathsForWriteIntent('Mark comprar suplementos QA LOCAL task as done')).toBe(true);
    expect(shouldBypassChatReadFastPathsForWriteIntent('Marca a tarefa comprar suplementos QA como concluída')).toBe(true);
  });

  it('keeps explicit slash commands token-zero', () => {
    expect(shouldBypassChatReadFastPathsForWriteIntent('/tasks')).toBe(false);
    expect(shouldBypassChatReadFastPathsForWriteIntent('/todo')).toBe(false);
  });

  it('does not bypass read fast-paths for read-only questions', () => {
    expect(shouldBypassChatReadFastPathsForWriteIntent('O que tenho na agenda hoje?')).toBe(false);
    expect(shouldBypassChatReadFastPathsForWriteIntent('Quantos emails não lidos tenho no Gmail?')).toBe(false);
  });

  it('does not turn negated or hypothetical wording into a write', () => {
    expect(shouldBypassChatReadFastPathsForWriteIntent('Não marque comprar suplementos como concluída')).toBe(false);
    expect(shouldBypassChatReadFastPathsForWriteIntent('How do I mark comprar suplementos as done?')).toBe(false);
    expect(shouldBypassChatReadFastPathsForWriteIntent('Should I mark comprar suplementos done?')).toBe(false);
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatCoreV2TurnState =
  | 'planning'
  | 'validating'
  | 'reading_context'
  | 'previewing_command'
  | 'awaiting_confirmation'
  | 'executing'
  | 'verifying'
  | 'composing'
  | 'background_started'
  | 'background_completed'
  | 'failed';

export interface TurnStateEvent {
  turnId: string;
  state: ChatCoreV2TurnState;
  sequenceNumber: number;
  serverTime: string;
  idempotencyKey: string;
  displayTextKey: string;
  progressPercent?: number;
  canCancel: boolean;
  canResume: boolean;
  backgroundJobId?: string;
}

export function buildTurnStateEvent(input: Omit<TurnStateEvent, 'serverTime'> & { serverTime?: string }): TurnStateEvent {
  return {
    ...input,
    serverTime: input.serverTime ?? new Date().toISOString(),
  };
}

export function shouldApplyTurnStateEvent(lastSequenceNumber: number, event: Pick<TurnStateEvent, 'sequenceNumber'>): boolean {
  return event.sequenceNumber > lastSequenceNumber;
}

/**
 * Mirror test for chat-pending-cancellation.
 *
 * Pins the anchored cancellation-turn matcher, including a LABELED
 * characterization pin for the known referent-carrying gap ("cancel that")
 * so the owning milestone has a marked test to flip.
 */

import { describe, expect, it } from 'vitest';

import { isPendingChatWorkCancellationTurn } from '../../src/services/chat-pending-cancellation';

describe('isPendingChatWorkCancellationTurn', () => {
  it('matches bare cancellation turns in en/pt including punctuation', () => {
    for (const text of [
      'cancel',
      'Cancel',
      'cancel!',
      'cancelar',
      'never mind',
      'nevermind',
      'forget it',
      'nvm',
      'esquece',
      'deixa',
      'deixa pra la',
      'deixa para lá',
      'deixa estar',
      '  cancel  ',
    ]) {
      expect(isPendingChatWorkCancellationTurn(text), text).toBe(true);
    }
  });

  it('does not match non-cancellation turns', () => {
    for (const text of [
      'cancel my subscription',
      'how do I cancel',
      'cancelled',
      'do not cancel',
      '',
    ]) {
      expect(isPendingChatWorkCancellationTurn(text), text).toBe(false);
    }
  });

  it("CURRENT LIMITATION (pre-existing bug, owner M8/M16): 'cancel that' / 'cancel it' do NOT trigger cancelAllPendingChatWork", () => {
    // The matcher is anchored to a bare cancellation verb, so a cancellation
    // with a referent falls through to the action gateway / legacy route
    // instead of cancelling pending chat work. This pin documents today's
    // behavior; M8/M16 owns flipping these to true (or routing them to a
    // referent-aware cancellation path).
    expect(isPendingChatWorkCancellationTurn('cancel that')).toBe(false);
    expect(isPendingChatWorkCancellationTurn('cancel it')).toBe(false);
    expect(isPendingChatWorkCancellationTurn('cancela isso')).toBe(false);
  });
});

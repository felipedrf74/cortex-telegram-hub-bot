// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Onboarding flow handler — extracted from bot.ts Phase 2.
 *
 * Renders multi-step questionnaire steps with inline keyboards or text input.
 */

import { Context, InlineKeyboard } from 'grammy';
import { storeCallback } from '../utils/callback-store';
import * as onboardingSvc from '../services/onboarding';
import { pendingOnboarding } from './shared-state';

/**
 * Send one step of an onboarding questionnaire to the user.
 * For choice/multi_choice steps, builds an inline keyboard.
 * For text/number steps, sets up a pending input listener.
 */
export async function sendOnboardingStep(
  ctx: Context,
  questionnaireId: string,
  step: onboardingSvc.QuestionStep,
  stepIdx: number,
  totalSteps: number,
): Promise<void> {
  const progress = `(${stepIdx + 1}/${totalSteps})`;
  const prompt = `${progress} ${step.prompt}`;

  if (step.type === 'choice' && step.options) {
    const keyboard = new InlineKeyboard();
    for (const option of step.options) {
      const ref = storeCallback({ questionnaire: questionnaireId, answer: option }, 300_000);
      keyboard.text(option, `ob:answer:${ref}`).row();
    }
    const cancelRef = storeCallback({ questionnaire: questionnaireId }, 300_000);
    keyboard.text('❌ Cancel', `ob:cancel:${cancelRef}`);
    await ctx.reply(prompt, { reply_markup: keyboard });
  } else if (step.type === 'multi_choice' && step.options) {
    // For multi_choice, present as individual buttons; user selects each
    const keyboard = new InlineKeyboard();
    for (const option of step.options) {
      const ref = storeCallback({ questionnaire: questionnaireId, answer: option }, 300_000);
      keyboard.text(option, `ob:answer:${ref}`).row();
    }
    const cancelRef = storeCallback({ questionnaire: questionnaireId }, 300_000);
    keyboard.text('❌ Cancel', `ob:cancel:${cancelRef}`);
    await ctx.reply(`${prompt}\n<i>(select one — you can update this later)</i>`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } else {
    // Text or number input — set up pending onboarding input
    const userId = ctx.from?.id;
    if (userId) {
      pendingOnboarding.set(userId, {
        questionnaire: questionnaireId,
        step,
        expires: Date.now() + 300_000,
      });
    }
    await ctx.reply(`${prompt}\n<i>(type your answer)</i>`, { parse_mode: 'HTML' });
  }
}

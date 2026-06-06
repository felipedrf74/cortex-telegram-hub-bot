// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  validateComposedAnswerDraft,
  type ComposedAnswerDraft,
  type ComposedAnswerDraftIssue,
} from './answer-composition';
import { validateResponseLocalePreservation } from './locale-preservation-policy';
import {
  buildChatCoreV2MessageResponse,
  type ChatCoreV2Locale,
  type ChatCoreV2Response,
} from './response-contracts';

export const CHAT_CORE_V2_FINAL_ANSWER_COMPOSER_VERSION = 'chat_core_v2_final_answer_composer@1.0.0';

export type ChatCoreV2FinalAnswerComposerIssue =
  | ComposedAnswerDraftIssue
  | 'composer_locale_mismatch';

export interface ComposeChatCoreV2FinalAnswerInput {
  draft: ComposedAnswerDraft;
  expectedLocale: ChatCoreV2Locale;
  extraReasonCodes?: readonly string[];
}

export interface ComposeChatCoreV2FinalAnswerResult {
  ok: boolean;
  response?: ChatCoreV2Response;
  issues: ChatCoreV2FinalAnswerComposerIssue[];
}

export function composeChatCoreV2FinalAnswer(
  input: ComposeChatCoreV2FinalAnswerInput,
): ComposeChatCoreV2FinalAnswerResult {
  const issues: ChatCoreV2FinalAnswerComposerIssue[] = [
    ...validateComposedAnswerDraft(input.draft),
  ];
  const localeVerdict = validateResponseLocalePreservation({
    expectedLocale: input.expectedLocale,
    actualLocale: input.draft.locale,
  });
  if (!localeVerdict.ok && localeVerdict.reasonCode) {
    issues.push(localeVerdict.reasonCode);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    issues: [],
    response: buildChatCoreV2MessageResponse({
      text: input.draft.text,
      locale: input.expectedLocale,
      reasonCodes: [
        ...input.draft.reasonCodes,
        ...(input.extraReasonCodes ?? []),
      ],
    }),
  };
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  createEvent,
  getEventsForSources,
} from '../unified-calendar';
import { isGoogleCalendarConfigured } from '../google-calendar';
import { isOutlookCalendarConfigured } from '../outlook-calendar';
import { getTaskProviderForUser } from '../task-store/task-router';
import type { ChatActionPlannerDeps } from './types';

const DEFAULT_CHAT_ACTION_DEPS: Required<ChatActionPlannerDeps> = {
  calendar: {
    createEvent,
    getEventsForSources,
    hasGoogle: isGoogleCalendarConfigured,
    hasOutlook: isOutlookCalendarConfigured,
  },
  taskProviderForUser: getTaskProviderForUser,
};

export function resolveChatActionPlannerDeps(
  deps: ChatActionPlannerDeps = {},
): Required<ChatActionPlannerDeps> {
  return { ...DEFAULT_CHAT_ACTION_DEPS, ...deps };
}

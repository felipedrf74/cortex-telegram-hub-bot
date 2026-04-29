// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getUserLanguage } from '../../services/user-service';
import { tryDeterministicChatCommand } from './chat-fastpath';
import { getCallback } from '../../utils/callback-store';
import { applyCoachRecommendations } from '../../services/garmin-coach';
import * as microsoftTodo from '../../services/microsoft-todo';
import { labelsForLanguage } from './chat-inline-buttons';
import {
  buildCallbackDataRequiredError,
  buildCallbackExpiredError,
  buildCallbackInternalErrorMessage,
  buildCancelledPayload,
  buildCoachApplyPayload,
  buildCoachDismissPayload,
  buildCoachExpiredError,
  buildDeleteConfirmationPayload,
  buildListDeletedPayload,
  buildTaskCompletedPayload,
  buildTaskDeletedPayload,
  buildTodoListFetchFailurePayload,
  buildTodoListSelectionPayload,
  buildUnsupportedCallbackError,
  buildUnsupportedCommandCallbackError,
} from './chat-callback-response';
import {
  persistAssistantEdit,
  persistCallbackAssistantResponse,
} from './chat-persistence';

export type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerChatCallbackRoutes(
  router: Router,
  ensureValidChatRouteScope: ChatRouteScopeGuard,
): void {
  /**
   * POST /api/v1/chat/callback
   * Handle inline button presses (equivalent to Telegram callback queries).
   */
  router.post('/callback', async (req, res: Response) => {
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    const { callbackData, messageId } = req.body;

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_callback', {
      callbackPrefix: typeof callbackData === 'string' ? callbackData.split(':').slice(0, 2).join(':') : null,
      hasMessageId: Boolean(messageId),
    })) {
      return;
    }

    if (!callbackData) {
      const language = getUserLanguage(userId);
      res.status(400).json({
        error: buildCallbackDataRequiredError(language),
      });
      return;
    }

    try {
      const language = getUserLanguage(userId);
      const labels = labelsForLanguage(language);

      if (callbackData.startsWith('cmd:')) {
        const command = callbackData.slice(4);
        const fastPath = await tryDeterministicChatCommand(command, userId);
        if (!fastPath) {
          res.status(400).json({
            error: buildUnsupportedCommandCallbackError(language, command),
          });
          return;
        }

        const timestamp = new Date().toISOString();
        const payload = {
          text: fastPath.text,
          editOriginal: true,
          newButtons: fastPath.buttons ?? null,
        };

        if (messageId) {
          persistAssistantEdit({
            tenantId,
            userId,
            messageId,
            text: fastPath.text,
            domain: fastPath.domain,
            buttons: fastPath.buttons ?? null,
            metadata: null,
            routeMethod: 'fast-path',
            timestamp,
          });
        }

        res.json(payload);
        return;
      }

      if (callbackData.startsWith('coach:')) {
        const lang = getUserLanguage(userId);
        const [, action, ref] = callbackData.split(':');

        if (action === 'dismiss') {
          const payload = buildCoachDismissPayload(lang);

          if (messageId) {
            persistAssistantEdit({
              tenantId,
              userId,
              messageId,
              text: payload.text,
              domain: 'triathlon',
              buttons: null,
              metadata: null,
              timestamp: new Date().toISOString(),
            });
          }

          res.json(payload);
          return;
        }

        const cbData = ref ? getCallback(ref) : null;
        const recommendationIds = Array.isArray(cbData?.recommendationIds)
          ? cbData.recommendationIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
          : [];

        if (recommendationIds.length === 0) {
          res.status(410).json({
            error: buildCoachExpiredError(lang),
          });
          return;
        }

        const applied = await applyCoachRecommendations(userId, recommendationIds);
        const payload = buildCoachApplyPayload(lang, applied.count, applied.appliedRecommendations);

        if (messageId) {
          persistAssistantEdit({
            tenantId,
            userId,
            messageId,
            text: payload.text,
            domain: 'triathlon',
            buttons: null,
            metadata: null,
            timestamp: new Date().toISOString(),
          });
        }

        res.json(payload);
        return;
      }

      // Resolve the callback data from the store. The iOS route supports
      // the most common Telegram-origin callback patterns used by task cards.
      const cbData = getCallback(callbackData);
      const prefix = callbackData.split(':').slice(0, 2).join(':');
      if (!cbData && prefix !== 'td:dn') {
        res.status(410).json({
          error: buildCallbackExpiredError(language),
        });
        return;
      }

      let responseText = language.toLowerCase().startsWith('pt')
        ? 'Ação processada.'
        : 'Action processed';
      let editOriginal = false;
      let newButtons: { text: string; callbackData: string }[][] | null = null;

      switch (prefix) {
        case 'td:ls': {
          if (cbData?.listId && cbData?.listName) {
            const result = await microsoftTodo.getTasks(cbData.listId, cbData.listName, { status: 'notStarted' });
            if (!result.success) {
              const payload = buildTodoListFetchFailurePayload(language);
              responseText = payload.text;
              editOriginal = payload.editOriginal;
              break;
            }
            const payload = buildTodoListSelectionPayload(result.data, cbData.listName, language, labels);
            responseText = payload.text;
            newButtons = payload.newButtons;
            editOriginal = payload.editOriginal;
          }
          break;
        }
        case 'td:tc': {
          if (cbData?.listId && cbData?.taskId) {
            await microsoftTodo.completeTask(cbData.listId, cbData.taskId);
            const payload = buildTaskCompletedPayload(language, cbData.title);
            responseText = payload.text;
            editOriginal = payload.editOriginal;
          }
          break;
        }
        case 'td:dy': {
          if (cbData?.listId && cbData?.taskId) {
            await microsoftTodo.deleteTask(cbData.listId, cbData.taskId);
            const payload = buildTaskDeletedPayload(language, cbData.title);
            responseText = payload.text;
            editOriginal = payload.editOriginal;
          } else if (cbData?.listId && cbData?.type === 'list') {
            await microsoftTodo.deleteList(cbData.listId);
            const payload = buildListDeletedPayload(language, cbData.listName);
            responseText = payload.text;
            editOriginal = payload.editOriginal;
          }
          break;
        }
        case 'td:tx': {
          if (cbData?.listId && (cbData?.taskId || cbData?.type === 'list')) {
            const confirmRef = callbackData.split(':')[2];
            const payload = buildDeleteConfirmationPayload(language, cbData, confirmRef, labels);
            responseText = payload.text;
            newButtons = payload.newButtons;
            editOriginal = payload.editOriginal;
          }
          break;
        }
        case 'td:dn': {
          const payload = buildCancelledPayload(language);
          responseText = payload.text;
          editOriginal = payload.editOriginal;
          break;
        }
        default: {
          res.status(400).json({
            error: buildUnsupportedCallbackError(language, prefix),
          });
          return;
        }
      }

      const timestamp = new Date().toISOString();
      const payload = {
        text: responseText,
        editOriginal,
        newButtons,
      };

      persistCallbackAssistantResponse({
        tenantId,
        userId,
        messageId,
        text: responseText,
        domain: 'secretary',
        buttons: newButtons,
        metadata: null,
        timestamp,
        editOriginal,
      });

      res.json(payload);
    } catch (err: any) {
      logger.error({
        err,
        callbackPrefix: typeof callbackData === 'string' ? callbackData.split(':').slice(0, 2).join(':') : null,
        platform: 'ios',
        tenantId,
        userId,
      }, 'iOS callback failed');
      const language = getUserLanguage(userId);
      res.status(500).json({
        error: {
          code: 'INTERNAL',
          message: buildCallbackInternalErrorMessage(language),
        },
      });
    }
  });
}

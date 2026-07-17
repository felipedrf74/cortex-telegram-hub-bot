// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getUserLanguageById } from '../../services/user-service';
import { tryDeterministicChatCommand } from './chat-fastpath';
import { consumeCallbackForScope, getCallbackForScope } from '../../utils/callback-store';
import { applyCoachRecommendations } from '../../services/garmin-coach';
import { getTaskProviderForUser } from '../../services/task-store/task-router';
import { isSingleWritePathEnabled } from '../../services/task-store/single-write-path';
import {
  deleteOfflineFirstTaskList,
  recordLocalTaskMutation,
  resolveOfflineNexusTaskId,
  resolveOfflineTaskListRef,
} from '../../services/task-store/offline-first-task-service';
import { labelsForLanguage } from './chat-inline-buttons';
import { buildNexusAnswerContract, type NexusChatOwnerSkill } from '../../services/chat-answer-contract';
import { safeRecordChatV2DeterministicReadEvidence } from '../../services/chat-deterministic-read-evidence';
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
  tenantId: number | undefined,
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { callbackData, messageId } = req.body;

    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_route_callback', {
      callbackPrefix: typeof callbackData === 'string' ? callbackData.split(':').slice(0, 2).join(':') : null,
      hasMessageId: Boolean(messageId),
    })) {
      return;
    }

    if (!callbackData) {
      const language = getUserLanguageById(userId);
      res.status(400).json({
        error: buildCallbackDataRequiredError(language),
      });
      return;
    }

    try {
      const language = getUserLanguageById(userId);
      const labels = labelsForLanguage(language);

      if (callbackData.startsWith('cmd:')) {
        const command = callbackData.slice(4);
        const fastPath = await tryDeterministicChatCommand(command, userId, tenantId);
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
        safeRecordChatV2DeterministicReadEvidence({
          tenantId,
          userId,
          requestId: typeof messageId === 'string' && messageId.trim() ? messageId : `chat-callback:${Date.now()}`,
          normalizedMessage: command,
          tokenZeroSurface: 'button',
          tokenZeroPreserved: true,
          tenantUserIsolationPassed: true,
          response: {
            id: typeof messageId === 'string' && messageId.trim() ? messageId : `chat-callback:${Date.now()}`,
            text: fastPath.text,
            domain: fastPath.domain,
            routeMethod: 'fast-path',
            metadata: {
              chatReasoning: buildNexusAnswerContract({
                intent: commandToDeterministicReadIntent(command),
                ownerSkill: commandToOwnerSkill(command, fastPath.domain),
                routeMethod: 'fast-path',
                routeKind: 'local_read',
                groundingRequirement: 'local',
                expectedResponseShape: commandToExpectedShape(command),
                language: language.startsWith('pt') ? 'pt' : 'en',
                actionability: 'answer_only',
                verificationStatus: 'not_required',
                confidence: 1,
                traceId: typeof messageId === 'string' && messageId.trim() ? messageId : `chat-callback:${Date.now()}`,
              }),
            },
          },
        });

        res.json(payload);
        return;
      }

      if (callbackData.startsWith('coach:')) {
        const lang = getUserLanguageById(userId);
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

        const cbData = ref ? getCallbackForScope(ref, { tenantId, userId }) : null;
        const recommendationIds = Array.isArray(cbData?.recommendationIds)
          ? cbData.recommendationIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
          : [];

        if (recommendationIds.length === 0) {
          res.status(410).json({
            error: buildCoachExpiredError(lang),
          });
          return;
        }

        if (ref && !consumeCallbackForScope(ref, { tenantId, userId })) {
          res.status(410).json({
            error: buildCoachExpiredError(lang),
          });
          return;
        }
        const applied = await applyCoachRecommendations(userId, tenantId, recommendationIds);
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
      const prefix = callbackData.split(':').slice(0, 2).join(':');
      const ref = callbackData.split(':')[2];
      const cbData = ref ? getCallbackForScope(ref, { tenantId, userId }) : null;
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
      const taskProvider = getTaskProviderForUser(userId);
      const expireMalformedTaskCallback = () => {
        if (ref) consumeCallbackForScope(ref, { tenantId, userId });
        res.status(410).json({
          error: buildCallbackExpiredError(language),
        });
      };

      switch (prefix) {
        case 'td:ls': {
          if (cbData?.listId && cbData?.listName) {
            const result = await taskProvider.getTasks(cbData.listId, cbData.listName, { status: 'notStarted' });
            if (!result.success) {
              const payload = buildTodoListFetchFailurePayload(language);
              responseText = payload.text;
              editOriginal = payload.editOriginal;
              break;
            }
            const payload = buildTodoListSelectionPayload(result.data, cbData.listName, language, labels, { tenantId, userId });
            responseText = payload.text;
            newButtons = payload.newButtons;
            editOriginal = payload.editOriginal;
          }
          break;
        }
        case 'td:tc': {
          if (!cbData?.listId || !cbData?.taskId) {
            expireMalformedTaskCallback();
            return;
          }
          if (isSingleWritePathEnabled()) {
            // M5 ledger path: the callback carries a provider-era task id;
            // bridge it to the nexus id and journal task.complete. The local
            // row flips immediately and the provider push runs on the
            // mutation worker (NEX-09). Unresolvable ids expire the callback
            // BEFORE the one-shot ref is consumed.
            const scopedTenantId = typeof tenantId === 'number' && tenantId > 0 ? tenantId : userId;
            const nexusTaskId = resolveOfflineNexusTaskId(scopedTenantId, userId, String(cbData.taskId));
            if (!nexusTaskId) {
              expireMalformedTaskCallback();
              return;
            }
            if (ref && !consumeCallbackForScope(ref, { tenantId, userId })) {
              res.status(410).json({
                error: buildCallbackExpiredError(language),
              });
              return;
            }
            recordLocalTaskMutation(scopedTenantId, userId, {
              taskId: nexusTaskId,
              operation: 'task.complete',
              patch: { source: 'chat_callback' },
            });
          } else {
            // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
            if (ref && !consumeCallbackForScope(ref, { tenantId, userId })) {
              res.status(410).json({
                error: buildCallbackExpiredError(language),
              });
              return;
            }
            await taskProvider.completeTask(cbData.listId, cbData.taskId);
          }
          const payload = buildTaskCompletedPayload(language, cbData.title);
          responseText = payload.text;
          editOriginal = payload.editOriginal;
          break;
        }
        case 'td:dy': {
          if (cbData?.listId && cbData?.taskId) {
            if (isSingleWritePathEnabled()) {
              const scopedTenantId = typeof tenantId === 'number' && tenantId > 0 ? tenantId : userId;
              const nexusTaskId = resolveOfflineNexusTaskId(scopedTenantId, userId, String(cbData.taskId));
              if (!nexusTaskId) {
                expireMalformedTaskCallback();
                return;
              }
              if (ref && !consumeCallbackForScope(ref, { tenantId, userId })) {
                res.status(410).json({
                  error: buildCallbackExpiredError(language),
                });
                return;
              }
              recordLocalTaskMutation(scopedTenantId, userId, {
                taskId: nexusTaskId,
                operation: 'task.delete',
                patch: { source: 'chat_callback' },
              });
            } else {
              // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
              if (ref && !consumeCallbackForScope(ref, { tenantId, userId })) {
                res.status(410).json({
                  error: buildCallbackExpiredError(language),
                });
                return;
              }
              await taskProvider.deleteTask(cbData.listId, cbData.taskId);
            }
            const payload = buildTaskDeletedPayload(language, cbData.title);
            responseText = payload.text;
            editOriginal = payload.editOriginal;
          } else if (cbData?.listId && cbData?.type === 'list') {
            if (ref && !consumeCallbackForScope(ref, { tenantId, userId })) {
              res.status(410).json({
                error: buildCallbackExpiredError(language),
              });
              return;
            }
            if (isSingleWritePathEnabled()) {
              // M5 ledger path (NEX-10): resolve the callback's provider-era
              // list id to the local row, remove it locally, and journal the
              // provider push. An unresolvable list is already gone —
              // deletion converged.
              const scopedTenantId = typeof tenantId === 'number' && tenantId > 0 ? tenantId : userId;
              const localList = resolveOfflineTaskListRef(scopedTenantId, userId, String(cbData.listId), cbData.listName);
              if (localList) {
                deleteOfflineFirstTaskList(scopedTenantId, userId, { listId: localList.id });
              }
            } else {
              // Legacy direct-provider path (TASK_SINGLE_WRITE_PATH=0).
              await taskProvider.deleteList(cbData.listId);
            }
            const payload = buildListDeletedPayload(language, cbData.listName);
            responseText = payload.text;
            editOriginal = payload.editOriginal;
          } else {
            expireMalformedTaskCallback();
            return;
          }
          break;
        }
        case 'td:tx': {
          if (!cbData?.listId || (!cbData?.taskId && cbData?.type !== 'list')) {
            expireMalformedTaskCallback();
            return;
          }
          const confirmRef = callbackData.split(':')[2];
          const payload = buildDeleteConfirmationPayload(language, cbData, confirmRef, labels);
          responseText = payload.text;
          newButtons = payload.newButtons;
          editOriginal = payload.editOriginal;
          break;
        }
        case 'td:dn': {
          if (ref) consumeCallbackForScope(ref, { tenantId, userId });
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
      const language = getUserLanguageById(userId);
      res.status(500).json({
        error: {
          code: 'INTERNAL',
          message: buildCallbackInternalErrorMessage(language),
        },
      });
    }
  });
}

function commandToOwnerSkill(command: string, fallbackDomain: string): NexusChatOwnerSkill {
  if (/^\/?(todo|tasks|overdue|duetoday|due_today|dueweek|due_week|alltasks|all_tasks|todosummary|todo_summary)\b/i.test(command)) return 'tasks';
  if (/^\/?(day|today|week|calendar|agenda)\b/i.test(command)) return 'secretary';
  if (/training|treino/i.test(command)) return 'training';
  if (fallbackDomain === 'triathlon') return 'training';
  if (fallbackDomain === 'secretary') return 'secretary';
  return 'chat';
}

function commandToDeterministicReadIntent(command: string): string {
  if (/^\/?(todo|tasks|overdue|duetoday|due_today|dueweek|due_week|alltasks|all_tasks|todosummary|todo_summary)\b/i.test(command)) return 'tasks.read';
  if (/^\/?(day|today)\b/i.test(command)) return 'today.read';
  if (/^\/?(week|calendar|agenda)\b/i.test(command)) return 'calendar.read';
  if (/training|treino/i.test(command)) return 'training.read';
  return 'chat.deterministic_read';
}

function commandToExpectedShape(command: string): 'agenda_summary' | 'task_options' | 'training_advice' | 'direct_answer' {
  if (/^\/?(todo|tasks|overdue|duetoday|due_today|dueweek|due_week|alltasks|all_tasks|todosummary|todo_summary)\b/i.test(command)) return 'task_options';
  if (/^\/?(day|today|week|calendar|agenda)\b/i.test(command)) return 'agenda_summary';
  if (/training|treino/i.test(command)) return 'training_advice';
  return 'direct_answer';
}

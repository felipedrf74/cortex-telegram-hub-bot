// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ImageClassificationResult } from '../../services/anthropic';
import type { DomainName } from '../../domains/types';

export type ChatImageAttachment = {
  base64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
};

export function normalizeChatAttachment(raw: unknown): ChatImageAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const base64 = typeof (raw as any).base64 === 'string' ? (raw as any).base64.trim() : '';
  const mimeType = typeof (raw as any).mimeType === 'string' ? (raw as any).mimeType.trim().toLowerCase() : '';
  if (!base64) return null;
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) return null;
  return {
    base64,
    mimeType: (mimeType === 'image/jpg' ? 'image/jpeg' : mimeType) as ChatImageAttachment['mimeType'],
  };
}

export function buildAttachmentText(
  result: ImageClassificationResult,
  isPT: boolean,
): { text: string; domain: DomainName; metadata: any } {
  switch (result.type) {
    case 'invoice': {
      const vendor = result.vendor ?? (isPT ? 'fornecedor desconhecido' : 'unknown merchant');
      const amount = result.totalAmount ?? (isPT ? 'valor não encontrado' : 'amount not found');
      const date = result.documentDateRaw ?? result.documentDate ?? (isPT ? 'data não encontrada' : 'date not found');
      return {
        text: isPT
          ? `🧾 Analisei a imagem como recibo/nota.\n\n• Estabelecimento: ${vendor}\n• Valor: ${amount}\n• Data: ${date}\n• Confiança: ${Math.round((result.confidence ?? 0) * 100)}%\n\nPara arquivar ou corrigir os campos, abre Finanças > Capturar recibo.`
          : `🧾 I analyzed the image as a receipt/invoice.\n\n• Merchant: ${vendor}\n• Amount: ${amount}\n• Date: ${date}\n• Confidence: ${Math.round((result.confidence ?? 0) * 100)}%\n\nTo file it or correct any fields, open Finance > Capture Receipt.`,
        domain: 'finance',
        metadata: {
          type: 'invoice_preview',
          invoiceVendor: result.vendor,
          invoiceAmount: result.totalAmount,
        },
      };
    }
    case 'calendar': {
      const visibleEvents = result.events.slice(0, 6);
      const lines = visibleEvents.map((event) => {
        const start = event.start?.slice(11, 16) || '--:--';
        return `• ${start} ${event.title}`;
      });
      const more = result.events.length > visibleEvents.length
        ? (isPT ? `\n_… + ${result.events.length - visibleEvents.length} eventos na imagem._` : `\n_… + ${result.events.length - visibleEvents.length} more events in the image._`)
        : '';
      return {
        text: isPT
          ? `📅 Detetei um horário/agenda nesta imagem.\n\n${lines.join('\n')}${more}\n\nSe quiseres, posso ajudar a transformar isto em eventos do calendário.`
          : `📅 I detected a schedule/calendar in this image.\n\n${lines.join('\n')}${more}\n\nIf you want, I can help turn this into calendar events.`,
        domain: 'secretary',
        metadata: {
          type: 'calendar_preview',
          calendar: visibleEvents.map((event) => ({
            time: event.start?.slice(11, 16) || null,
            title: event.title,
          })),
        },
      };
    }
    case 'task': {
      const subtasks = result.subtasks.slice(0, 6);
      const lines = subtasks.map((item) => `• ${item}`);
      return {
        text: isPT
          ? `✅ Li esta imagem como checklist/tarefa.\n\nTítulo: ${result.title || 'Nova tarefa'}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}\n\nSe quiseres, posso transformar isto numa tarefa estruturada.`
          : `✅ I read this image as a checklist/task.\n\nTitle: ${result.title || 'New task'}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}\n\nIf you want, I can turn this into a structured task.`,
        domain: 'secretary',
        metadata: {
          type: 'task_preview',
          taskTitle: result.title,
        },
      };
    }
  }
}

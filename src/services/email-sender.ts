// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Email Sender — transactional emails via Resend.
 *
 * Used for: email verification codes, password reset, and notifications.
 * Resend free tier: 100 emails/day — sufficient for beta.
 *
 * All emails are sent from support@nexushub.me (or the configured sender).
 */

import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

let resendClient: Resend | null = null;

function getResend(): Resend {
  if (!resendClient) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY not configured');
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export function isFiscalBundleDeliveryConfigured(): boolean {
  return !!process.env.RESEND_API_KEY || config.isStaging;
}

export interface EmailAttachmentInput {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

function writeFiscalBundlePreview(data: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachmentInput[];
}): boolean {
  try {
    const dir = path.resolve(process.cwd(), process.env.FISCAL_BUNDLE_PREVIEW_DIR || './data/email-previews');
    fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `fiscal-bundle-${stamp}.json`);

    fs.writeFileSync(filePath, JSON.stringify({
      createdAt: new Date().toISOString(),
      mode: 'staging-preview',
      to: data.to,
      subject: data.subject,
      text: data.text,
      html: data.html,
      attachments: data.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType || 'application/octet-stream',
        sizeBytes: Buffer.isBuffer(attachment.content)
          ? attachment.content.length
          : Buffer.byteLength(String(attachment.content)),
      })),
    }, null, 2));

    logger.info({
      to: data.to,
      previewPath: filePath,
      attachmentCount: data.attachments.length,
    }, 'Fiscal bundle email preview written');
    return true;
  } catch (err) {
    logger.error({ err, to: data.to }, 'Failed to write fiscal bundle email preview');
    return false;
  }
}

export async function sendFiscalBundleEmail(data: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachmentInput[];
}): Promise<boolean> {
  try {
    if (!process.env.RESEND_API_KEY && config.isStaging) {
      return writeFiscalBundlePreview(data);
    }

    const resend = getResend();
    const from = process.env.RESEND_FROM || 'Nexus Hub <noreply@nexushub.me>';

    await resend.emails.send({
      from,
      to: data.to,
      subject: data.subject,
      html: data.html,
      text: data.text,
      attachments: data.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    });

    logger.info({
      to: data.to,
      attachmentCount: data.attachments.length,
    }, 'Fiscal bundle email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: data.to }, 'Failed to send fiscal bundle email');
    return false;
  }
}

/**
 * Send a verification code email to a new user.
 */
export async function sendVerificationCode(
  to: string,
  code: string,
  firstName: string,
): Promise<boolean> {
  try {
    const resend = getResend();
    const from = process.env.RESEND_FROM || 'Nexus Hub <noreply@nexushub.me>';

    await resend.emails.send({
      from,
      to,
      subject: `${code} — Seu código de verificação Nexus Hub`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <div style="text-align: center; margin-bottom: 32px;">
            <div style="display: inline-block; width: 56px; height: 56px; background: #1E1E1E; border-radius: 16px; line-height: 56px; font-size: 28px; font-weight: 900; color: #FF6B35;">N</div>
          </div>
          <h1 style="font-size: 24px; font-weight: 800; text-align: center; margin-bottom: 8px; color: #EDEDEF;">
            Verifique seu e-mail
          </h1>
          <p style="font-size: 15px; color: #A1A1A6; text-align: center; margin-bottom: 32px;">
            Olá ${firstName}, use o código abaixo para verificar sua conta:
          </p>
          <div style="background: #18181B; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 32px;">
            <span style="font-family: 'JetBrains Mono', monospace; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #FF6B35;">${code}</span>
          </div>
          <p style="font-size: 13px; color: #6E6E76; text-align: center;">
            Este código expira em 15 minutos.<br>
            Se você não criou uma conta no Nexus Hub, ignore este e-mail.
          </p>
          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 32px 0;">
          <p style="font-size: 11px; color: #48484F; text-align: center;">
            Nexus Hub · nexushub.me · O sistema operacional pessoal
          </p>
        </div>
      `,
    });

    logger.info({ to, firstName }, 'Verification email sent');
    return true;
  } catch (err) {
    logger.error({ err, to }, 'Failed to send verification email');
    return false;
  }
}

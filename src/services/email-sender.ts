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

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Email Sender — transactional emails via Resend.
 *
 * Used for: email verification codes, password reset, and notifications.
 * Resend free tier: 100 emails/day — sufficient for beta.
 *
 * All emails are sent from welcome@nexushub.me (or the configured sender).
 */

import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashEmail } from '../utils/identity';

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

function emailLogHash(email: string): string {
  return hashEmail(email, 16);
}

function transactionalFrom(): string {
  return process.env.RESEND_FROM || 'Nexus Hub <welcome@nexushub.me>';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
      toHash: emailLogHash(data.to),
      previewPath: filePath,
      attachmentCount: data.attachments.length,
    }, 'Fiscal bundle email preview written');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(data.to) }, 'Failed to write fiscal bundle email preview');
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
    const from = transactionalFrom();

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
      toHash: emailLogHash(data.to),
      attachmentCount: data.attachments.length,
    }, 'Fiscal bundle email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(data.to) }, 'Failed to send fiscal bundle email');
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
    const from = transactionalFrom();
    const safeFirstName = escapeHtml(firstName);

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
            Olá ${safeFirstName}, use o código abaixo para verificar sua conta:
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

    logger.info({ toHash: emailLogHash(to), nameLen: firstName.length }, 'Verification email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(to) }, 'Failed to send verification email');
    return false;
  }
}

/**
 * AUTH-O2 (closed-beta-auth-hardening, 2026-05-04): password reset email.
 *
 * The reset URL is delivered exactly once. The token is a 256-bit
 * url-safe base64 string; the server stores only its SHA-256 hash.
 * If the email transport leaks (compromised mailbox), the attacker can
 * follow the link until the 1h TTL expires OR the user resets first
 * (which atomically invalidates the token via UPSERT). Successful
 * confirm also revokes all existing iOS sessions.
 *
 * Token expiry, attempt cap, and single-use enforcement all live in
 * the password-reset service, NOT in this email helper.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  firstName: string,
): Promise<boolean> {
  try {
    const resend = getResend();
    const from = transactionalFrom();
    const safeFirstName = escapeHtml(firstName);
    const safeResetUrl = escapeHtml(resetUrl);

    await resend.emails.send({
      from,
      to,
      subject: 'Reset your Nexus Hub password',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <div style="text-align: center; margin-bottom: 32px;">
            <div style="display: inline-block; width: 56px; height: 56px; background: #1E1E1E; border-radius: 16px; line-height: 56px; font-size: 28px; font-weight: 900; color: #FF6B35;">N</div>
          </div>
          <h1 style="font-size: 24px; font-weight: 800; text-align: center; margin-bottom: 8px; color: #EDEDEF;">
            Reset your password
          </h1>
          <p style="font-size: 15px; color: #A1A1A6; text-align: center; margin-bottom: 32px;">
            Hi ${safeFirstName}, tap the button below to set a new password.
          </p>
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${safeResetUrl}"
               style="display: inline-block; background: #FF6B35; color: #0A0A0B; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 16px; text-decoration: none;">
              Reset password
            </a>
          </div>
          <p style="font-size: 13px; color: #6E6E76; text-align: center;">
            This link expires in 1 hour and can only be used once.<br>
            If you didn't request a password reset, ignore this email — your account is safe.
          </p>
          <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 32px 0;">
          <p style="font-size: 11px; color: #48484F; text-align: center;">
            Nexus Hub · nexushub.me · The personal operating system
          </p>
        </div>
      `,
    });

    logger.info({ toHash: emailLogHash(to) }, 'Password reset email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(to) }, 'Failed to send password reset email');
    return false;
  }
}

interface PaymentEmailInput {
  to: string;
  firstName?: string | null;
  plan: string;
  period?: string | null;
  checkoutSessionId?: string | null;
  invoiceId?: string | null;
  hostedInvoiceUrl?: string | null;
}

function displayPlan(plan: string, period?: string | null): string {
  const label = String(plan || 'subscription').trim().toUpperCase();
  const cadence = period ? ` ${String(period).trim()}` : '';
  return `${label}${cadence}`;
}

export async function sendPaymentReceipt(input: PaymentEmailInput): Promise<boolean> {
  try {
    const resend = getResend();
    const from = transactionalFrom();
    const safeFirstName = escapeHtml(input.firstName || 'there');
    const safePlan = escapeHtml(displayPlan(input.plan, input.period));

    await resend.emails.send({
      from,
      to: input.to,
      subject: 'Your Nexus Hub subscription is active',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #EDEDEF;">Subscription active</h1>
          <p style="font-size: 15px; line-height: 1.55; color: #A1A1A6;">Hi ${safeFirstName}, your Nexus Hub ${safePlan} subscription is active.</p>
          <p style="font-size: 13px; color: #6E6E76; margin-top: 28px;">You can manage billing from your Nexus Hub account.</p>
          <p style="font-size: 11px; color: #48484F; margin-top: 32px;">Nexus Hub · nexushub.me</p>
        </div>
      `,
      text: `Your Nexus Hub ${displayPlan(input.plan, input.period)} subscription is active.`,
    });

    logger.info({ toHash: emailLogHash(input.to), checkoutSessionId: input.checkoutSessionId ?? null }, 'Payment receipt email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(input.to) }, 'Failed to send payment receipt email');
    return false;
  }
}

export async function sendPaymentFailed(input: PaymentEmailInput): Promise<boolean> {
  try {
    const resend = getResend();
    const from = transactionalFrom();
    const safeFirstName = escapeHtml(input.firstName || 'there');
    const safePlan = escapeHtml(displayPlan(input.plan, input.period));
    const safeInvoiceUrl = input.hostedInvoiceUrl ? escapeHtml(input.hostedInvoiceUrl) : null;

    await resend.emails.send({
      from,
      to: input.to,
      subject: 'Action needed: Nexus Hub payment failed',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #EDEDEF;">Payment failed</h1>
          <p style="font-size: 15px; line-height: 1.55; color: #A1A1A6;">Hi ${safeFirstName}, Stripe could not collect payment for your Nexus Hub ${safePlan} subscription.</p>
          ${safeInvoiceUrl ? `<p style="margin-top: 28px;"><a href="${safeInvoiceUrl}" style="display: inline-block; background: #FF6B35; color: #0A0A0B; padding: 14px 22px; border-radius: 10px; font-weight: 800; text-decoration: none;">Update payment</a></p>` : ''}
          <p style="font-size: 13px; color: #6E6E76; margin-top: 28px;">Your account is marked past due until the payment succeeds.</p>
          <p style="font-size: 11px; color: #48484F; margin-top: 32px;">Nexus Hub · nexushub.me</p>
        </div>
      `,
      text: `Payment failed for your Nexus Hub ${displayPlan(input.plan, input.period)} subscription.${input.hostedInvoiceUrl ? `\nUpdate payment: ${input.hostedInvoiceUrl}` : ''}`,
    });

    logger.info({ toHash: emailLogHash(input.to), invoiceId: input.invoiceId ?? null }, 'Payment failed email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(input.to) }, 'Failed to send payment failed email');
    return false;
  }
}

export async function sendCancellationConfirmation(input: PaymentEmailInput): Promise<boolean> {
  try {
    const resend = getResend();
    const from = transactionalFrom();
    const safeFirstName = escapeHtml(input.firstName || 'there');
    const safePlan = escapeHtml(displayPlan(input.plan, input.period));

    await resend.emails.send({
      from,
      to: input.to,
      subject: 'Your Nexus Hub subscription was canceled',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #EDEDEF;">Subscription canceled</h1>
          <p style="font-size: 15px; line-height: 1.55; color: #A1A1A6;">Hi ${safeFirstName}, your Nexus Hub ${safePlan} subscription was canceled.</p>
          <p style="font-size: 13px; color: #6E6E76; margin-top: 28px;">Your account will use the free plan unless another active grant applies.</p>
          <p style="font-size: 11px; color: #48484F; margin-top: 32px;">Nexus Hub · nexushub.me</p>
        </div>
      `,
      text: `Your Nexus Hub ${displayPlan(input.plan, input.period)} subscription was canceled.`,
    });

    logger.info({ toHash: emailLogHash(input.to) }, 'Cancellation confirmation email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(input.to) }, 'Failed to send cancellation confirmation email');
    return false;
  }
}

export async function sendBetaWaitlistConfirmation(
  to: string,
  confirmationUrl: string,
): Promise<boolean> {
  try {
    const safeUrl = escapeHtml(confirmationUrl);
    const resend = getResend();
    const from = transactionalFrom();

    await resend.emails.send({
      from,
      to,
      subject: 'Confirm your Nexus Hub beta request',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #EDEDEF;">Confirm your beta request</h1>
          <p style="font-size: 15px; line-height: 1.55; color: #A1A1A6; margin-bottom: 28px;">
            Tap the button below to confirm that this email belongs to you. We only review confirmed beta requests.
          </p>
          <p style="margin-bottom: 32px;">
            <a href="${safeUrl}" style="display: inline-block; background: #FF6B35; color: #0A0A0B; padding: 14px 22px; border-radius: 10px; font-weight: 800; text-decoration: none;">
              Confirm beta request
            </a>
          </p>
          <p style="font-size: 13px; color: #6E6E76;">
            This link expires in 24 hours. If you did not request Nexus Hub beta access, you can ignore this email.
          </p>
          <p style="font-size: 11px; color: #48484F; margin-top: 32px;">Nexus Hub · nexushub.me</p>
        </div>
      `,
      text: `Confirm your Nexus Hub beta request: ${confirmationUrl}\n\nThis link expires in 24 hours.`,
    });

    logger.info({ toHash: emailLogHash(to) }, 'Beta waitlist confirmation email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(to) }, 'Failed to send beta waitlist confirmation email');
    return false;
  }
}

export async function sendBetaInviteEmail(data: {
  to: string;
  code: string;
  expiresAt: string;
}): Promise<boolean> {
  try {
    const resend = getResend();
    const from = transactionalFrom();
    const safeCode = escapeHtml(data.code);
    const expiry = new Date(data.expiresAt);
    const expiryText = Number.isNaN(expiry.getTime())
      ? data.expiresAt
      : expiry.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    await resend.emails.send({
      from,
      to: data.to,
      subject: 'Your Nexus Hub beta invitation',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 24px; background: #0A0A0B; color: #EDEDEF;">
          <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #EDEDEF;">Welcome to Nexus Hub beta</h1>
          <p style="font-size: 15px; line-height: 1.55; color: #A1A1A6; margin-bottom: 24px;">
            Your access code is ready. Use it in the Nexus Hub app before ${escapeHtml(expiryText)} to start the beta trial.
          </p>
          <div style="background: #18181B; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 22px; margin-bottom: 24px;">
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 24px; line-height: 1.35; font-weight: 800; color: #FF6B35; word-break: break-all;">${safeCode}</div>
          </div>
          <p style="font-size: 13px; color: #6E6E76;">
            The beta invitation expires on ${escapeHtml(expiryText)}. After the beta window ends, continued access requires a Nexus Hub subscription.
          </p>
          <p style="font-size: 11px; color: #48484F; margin-top: 32px;">Nexus Hub · nexushub.me</p>
        </div>
      `,
      text: `Welcome to Nexus Hub beta.\n\nInvite code: ${data.code}\nExpires: ${expiryText}\n\nAfter the beta window ends, continued access requires a Nexus Hub subscription.`,
    });

    logger.info({
      toHash: emailLogHash(data.to),
      codeSuffix: data.code.slice(-4),
      expiresAt: data.expiresAt,
    }, 'Beta invite email sent');
    return true;
  } catch (err) {
    logger.error({ err, toHash: emailLogHash(data.to) }, 'Failed to send beta invite email');
    return false;
  }
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * i18n — Bilingual message system (PT-BR + EN).
 *
 * Simple key-based translations for bot messages. Not a full i18n framework —
 * just enough for user-facing strings in two languages.
 *
 * Usage:
 *   t('welcome', 'pt-BR')                      → '🎉 Bem-vindo ao Nexus Hub!'
 *   t('rate_limited', 'en-US', { limit: '40' }) → 'You've reached your daily limit of 40 messages.'
 */

export type Lang = 'pt-BR' | 'en-US';

const MESSAGES: Record<string, Record<Lang, string>> = {
  'welcome': {
    'pt-BR': '🎉 Bem-vindo ao Nexus Hub!\n\nSou seu assistente pessoal com IA. Use /help para ver os comandos disponíveis.',
    'en-US': '🎉 Welcome to Nexus Hub!\n\nI\'m your AI-powered personal assistant. Use /help to see available commands.',
  },
  'welcome_back': {
    'pt-BR': '👋 Olá de novo! Seu assistente está online. Use /help para comandos.',
    'en-US': '👋 Welcome back! Your assistant is online. Use /help for commands.',
  },
  'need_invite': {
    'pt-BR': '🔐 Nexus Hub está em beta privado.\n\nPara participar, use um código de convite:\n/start SEU_CODIGO',
    'en-US': '🔐 Nexus Hub is in private beta.\n\nTo join, use an invite code:\n/start YOUR_CODE',
  },
  'invalid_invite': {
    'pt-BR': '❌ Código de convite inválido ou expirado.',
    'en-US': '❌ Invalid or expired invite code.',
  },
  'rate_limited': {
    'pt-BR': '⚠️ Você atingiu seu limite diário de {limit} mensagens.\n\nSeu limite reseta à meia-noite ({timezone}).',
    'en-US': '⚠️ You\'ve reached your daily limit of {limit} messages.\n\nYour limit resets at midnight ({timezone}).',
  },
  'suspended': {
    'pt-BR': '⚠️ Sua conta está suspensa. Entre em contato com o suporte.',
    'en-US': '⚠️ Your account is suspended. Contact support.',
  },
  'choose_language': {
    'pt-BR': '🌐 Escolha seu idioma / Choose your language:',
    'en-US': '🌐 Choose your language / Escolha seu idioma:',
  },
  'language_set': {
    'pt-BR': '✅ Idioma definido para Português. Bem-vindo ao Nexus Hub! 🇧🇷\n\nUse /help para ver os comandos.',
    'en-US': '✅ Language set to English. Welcome to Nexus Hub! 🇬🇧\n\nUse /help to see commands.',
  },
  'skill_disabled': {
    'pt-BR': '🔒 Esta funcionalidade não está habilitada para sua conta.',
    'en-US': '🔒 This feature is not enabled for your account.',
  },
  'registration_closed': {
    'pt-BR': '🔐 O registro está fechado no momento. Peça um código de convite ao administrador.',
    'en-US': '🔐 Registration is currently closed. Ask an admin for an invite code.',
  },
};

/**
 * Get a translated message. Falls back to English, then to the raw key.
 * Supports {variable} substitution.
 */
export function t(key: string, lang: Lang, vars?: Record<string, string>): string {
  let msg = MESSAGES[key]?.[lang] ?? MESSAGES[key]?.['en-US'] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replace(`{${k}}`, v);
    }
  }
  return msg;
}

/**
 * Detect language from Telegram's language_code field.
 * Falls back to PT-BR (primary audience).
 */
export function detectLanguageFromTelegram(langCode?: string): Lang {
  if (!langCode) return 'pt-BR';
  if (langCode.startsWith('pt')) return 'pt-BR';
  if (langCode.startsWith('en')) return 'en-US';
  if (langCode.startsWith('es')) return 'pt-BR'; // Spanish speakers → PT-BR closer
  return 'en-US'; // Default to English for other languages
}

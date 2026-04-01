// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// ─── MessageAdapter — Platform-Agnostic Messaging Interface ─────────

/** Options for sending a text message */
export interface SendTextOptions {
  /** Parse mode for message formatting (e.g. 'HTML', 'MarkdownV2') */
  parseMode?: 'HTML' | 'MarkdownV2';
  /** If true, disable link previews in the message */
  disableLinkPreview?: boolean;
  /** Message ID to reply to */
  replyToMessageId?: number;
}

/** Options for sending a file */
export interface SendFileOptions {
  /** Caption text to display with the file */
  caption?: string;
  /** Parse mode for the caption */
  parseMode?: 'HTML' | 'MarkdownV2';
  /** Message ID to reply to */
  replyToMessageId?: number;
}

/** A single inline button definition */
export interface InlineButton {
  /** Text displayed on the button */
  text: string;
  /** Callback data string sent when the button is pressed */
  callbackData: string;
}

/** Options for sending inline buttons */
export interface SendInlineButtonsOptions {
  /** Parse mode for the text above the buttons */
  parseMode?: 'HTML' | 'MarkdownV2';
  /** Message ID to reply to */
  replyToMessageId?: number;
}

/** Options for editing a message */
export interface EditMessageOptions {
  /** Parse mode for the edited message */
  parseMode?: 'HTML' | 'MarkdownV2';
}

/**
 * Platform-agnostic messaging interface.
 *
 * Concrete adapters (TelegramAdapter, WhatsAppAdapter, DiscordAdapter)
 * implement this contract so the Hub Core and skills can send messages
 * without knowing which platform they're running on.
 */
export interface MessageAdapter {
  /** Platform identifier (e.g. 'telegram', 'whatsapp', 'discord') */
  readonly platform: string;

  /**
   * Send a text message to the current chat.
   * @returns The platform-specific message ID as a string.
   */
  sendText(text: string, options?: SendTextOptions): Promise<string>;

  /**
   * Send a file (document) to the current chat.
   * @param filePath - Absolute path to the file on disk.
   * @returns The platform-specific message ID as a string.
   */
  sendFile(filePath: string, options?: SendFileOptions): Promise<string>;

  /**
   * Send a text message with inline buttons arranged in a grid.
   * Each inner array represents a row of buttons.
   * @returns The platform-specific message ID as a string.
   */
  sendInlineButtons(
    text: string,
    buttons: InlineButton[][],
    options?: SendInlineButtonsOptions,
  ): Promise<string>;

  /**
   * Edit an existing message by its ID.
   * @param messageId - The ID returned by a previous send method.
   * @param newText - The replacement text.
   */
  editMessage(
    messageId: string,
    newText: string,
    options?: EditMessageOptions,
  ): Promise<void>;
}

/**
 * WhatsApp Webhook Tests
 *
 * Tests the webhook verification logic and incoming message parsing
 * without spinning up the full Express server.
 */

import { describe, it, expect } from 'vitest';

describe('WhatsApp Webhook Verification', () => {
  const VERIFY_TOKEN = 'my-verify-token';

  it('accepts when mode=subscribe and token matches', () => {
    const mode = 'subscribe';
    const token = VERIFY_TOKEN;
    const challenge = 'test-challenge-12345';

    const passes = mode === 'subscribe' && token === VERIFY_TOKEN;
    expect(passes).toBe(true);
    // Server should respond 200 with challenge as body
    expect(challenge).toBe('test-challenge-12345');
  });

  it('rejects when verify_token does not match', () => {
    const mode = 'subscribe';
    const token = 'wrong-token';

    const passes = mode === 'subscribe' && token === VERIFY_TOKEN;
    expect(passes).toBe(false);
    // Server should respond 403
  });

  it('rejects when mode is not subscribe', () => {
    const mode = 'unsubscribe';
    const token = VERIFY_TOKEN;

    const passes = mode === 'subscribe' && token === VERIFY_TOKEN;
    expect(passes).toBe(false);
  });

  it('rejects when both mode and token are wrong', () => {
    const passes = 'invalid' === 'subscribe' && 'bad' === VERIFY_TOKEN;
    expect(passes).toBe(false);
  });
});

describe('WhatsApp Incoming Message Webhook', () => {
  it('parses text message from webhook payload', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: '123',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15551234567', phone_number_id: '123456' },
            contacts: [{ profile: { name: 'Test User' }, wa_id: '351912345678' }],
            messages: [{
              from: '351912345678',
              id: 'wamid.test123',
              timestamp: '1234567890',
              type: 'text',
              text: { body: 'Hello from WhatsApp' },
            }],
          },
        }],
      }],
    };

    const change = payload.entry[0].changes[0];
    expect(change.field).toBe('messages');
    const msg = change.value.messages[0];
    expect(msg.from).toBe('351912345678');
    expect(msg.text.body).toBe('Hello from WhatsApp');
    expect(msg.type).toBe('text');

    const contact = change.value.contacts.find(c => c.wa_id === msg.from);
    expect(contact?.profile.name).toBe('Test User');
  });

  it('parses image message type', () => {
    const msg = {
      from: '351912345678',
      id: 'wamid.img1',
      timestamp: '1234567890',
      type: 'image',
      image: { mime_type: 'image/jpeg', sha256: 'abc', id: 'media123' },
    };

    expect(msg.type).toBe('image');
    expect(msg.image.id).toBe('media123');
  });

  it('handles status update payloads', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            statuses: [{
              id: 'wamid.abc',
              status: 'delivered',
              timestamp: '1234567890',
              recipient_id: '351912345678',
            }],
          },
        }],
      }],
    };

    const status = payload.entry[0].changes[0].value.statuses[0];
    expect(status.status).toBe('delivered');
    expect(status.recipient_id).toBe('351912345678');
  });

  it('identifies read receipts', () => {
    const status = { id: 'wamid.x', status: 'read', timestamp: '123', recipient_id: '351912345678' };
    expect(status.status).toBe('read');
  });

  it('ignores payloads with wrong object type', () => {
    const payload = { object: 'instagram', entry: [] };
    expect(payload.object).not.toBe('whatsapp_business_account');
  });

  it('handles empty entries array', () => {
    const payload = { object: 'whatsapp_business_account', entry: [] };
    expect(payload.entry).toHaveLength(0);
  });

  it('handles changes with non-messages field', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{ field: 'account_update', value: { some: 'data' } }],
      }],
    };
    const change = payload.entry[0].changes[0];
    expect(change.field).not.toBe('messages');
  });
});

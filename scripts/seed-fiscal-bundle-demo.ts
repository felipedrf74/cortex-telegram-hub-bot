#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { initDatabase, closeDatabase } from '../src/services/database';
import { getUserById } from '../src/services/user-service';
import { addVendor } from '../src/state/invoice-vendors';
import { updateFiscalCollectionProfile } from '../src/state/fiscal-collection-profiles';

interface CliArgs {
  userId: number;
  destinationEmail?: string;
}

function parseArgs(): CliArgs {
  const userFlag = process.argv.indexOf('--user-id');
  const emailFlag = process.argv.indexOf('--destination-email');

  const rawUserId = userFlag >= 0 ? process.argv[userFlag + 1] : undefined;
  const destinationEmail = emailFlag >= 0 ? process.argv[emailFlag + 1] : undefined;
  const userId = Number.parseInt(rawUserId ?? '12', 10);

  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('Usage: npx tsx scripts/seed-fiscal-bundle-demo.ts --user-id <number> [--destination-email you@example.com]');
  }

  return { userId, destinationEmail };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function base64Of(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

async function main(): Promise<void> {
  const { userId, destinationEmail } = parseArgs();
  initDatabase();

  try {
    const user = getUserById(userId);
    if (!user) {
      throw new Error(`User ${userId} not found. Sign in once in the iOS app first, then rerun this seed.`);
    }

    const targetEmail = destinationEmail || user.email || `beta+${userId}@nexushub.me`;

    addVendor('Faturas do contabilista', 'billing@example.com', userId, 'invoice,receipt,payment');
    addVendor('Documentos fiscais', 'finance@example.com', userId, 'fiscal,saft,recibo');

    updateFiscalCollectionProfile(userId, {
      destination_email: targetEmail,
      cadence: 'twice_monthly',
      primary_day: 15,
      secondary_day: 28,
      enabled: true,
    });

    const now = DateTime.now().toUTC();
    const fixture = {
      emails: [
        {
          provider: 'gmail',
          ruleName: 'Faturas do contabilista',
          subject: 'Invoice April 2026',
          from: 'billing@example.com',
          receivedAt: now.minus({ days: 5 }).toISO(),
          attachments: [
            {
              filename: 'invoice-april.pdf',
              contentType: 'application/pdf',
              contentBase64: base64Of('%PDF-1.4 demo invoice april'),
            },
            {
              filename: 'saft-april.xml',
              contentType: 'application/xml',
              contentBase64: base64Of('<saft><month>2026-04</month></saft>'),
            },
          ],
        },
        {
          provider: 'outlook',
          ruleName: 'Documentos fiscais',
          subject: 'Comprovativo de pagamento abril',
          from: 'finance@example.com',
          receivedAt: now.minus({ days: 3 }).toISO(),
          attachments: [
            {
              filename: 'payment-proof.jpg',
              contentType: 'image/jpeg',
              contentBase64: base64Of('fake-jpeg-payment-proof'),
            },
            {
              filename: 'summary.xlsx',
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              contentBase64: base64Of('demo spreadsheet bytes'),
            },
          ],
        },
      ],
    };

    const dir = path.resolve(process.cwd(), process.env.FISCAL_BUNDLE_DEMO_DIR || './data/fiscal-bundle-demo');
    ensureDir(dir);
    const filePath = path.join(dir, `user-${userId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));

    console.log(`Seeded fiscal bundle demo for user ${userId}`);
    console.log(`Destination email: ${targetEmail}`);
    console.log(`Fixture file: ${filePath}`);
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

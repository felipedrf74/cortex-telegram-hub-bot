#!/usr/bin/env npx tsx
/**
 * Validates Gemini 2.5 Flash quality with Portuguese (PT-BR) messages.
 * Run: npx tsx scripts/test-gemini-ptbr.ts
 *
 * Tests 5 domain messages in Portuguese, verifies responses are in PT-BR,
 * logs token counts and estimated costs.
 */

import { GoogleGenerativeAI } from '../src/services/gemini-adapter';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('❌ GEMINI_API_KEY not set. Export it first.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const testMessages = [
  { domain: 'cooking', text: 'Me dá uma receita de churrasco para 4 pessoas' },
  { domain: 'finance', text: 'Quanto eu preciso pagar de DARF este mês com renda de R$8000?' },
  { domain: 'content', text: 'Me sugere ideias de conteúdo sobre IA para o canal The Operator' },
  { domain: 'triathlon', text: 'Como devo ajustar meu treino se dormi mal ontem?' },
  { domain: 'finance', text: 'O que é carnê-leão e como funciona pra freelancer em Portugal?' },
];

async function runTest() {
  console.log('\n═══ GEMINI 2.5 FLASH — Portuguese Quality Check ═══\n');
  let correct = 0;

  for (const { domain, text } of testMessages) {
    const start = Date.now();
    try {
      const result = await model.generateContent(text);
      const response = result.response;
      const responseText = response.text();
      const durationMs = Date.now() - start;
      const usage = response.usageMetadata;

      // Check if response is in Portuguese
      const ptIndicators = ['é', 'ã', 'ç', 'ê', 'á', 'ó', 'ú', 'para', 'como', 'que', 'uma', 'com'];
      const lowerResponse = responseText.toLowerCase();
      const isPT = ptIndicators.filter(w => lowerResponse.includes(w)).length >= 3;

      if (isPT) correct++;

      const inputTokens = usage?.promptTokenCount || 0;
      const outputTokens = usage?.candidatesTokenCount || 0;
      const cost = (inputTokens / 1_000_000) * 0.30 + (outputTokens / 1_000_000) * 2.50;

      console.log(`[${domain.toUpperCase().padEnd(10)}] ${isPT ? '✅' : '❌'} PT-BR | ${durationMs}ms | ${inputTokens}+${outputTokens} tokens | $${cost.toFixed(6)}`);
      console.log(`  Q: ${text}`);
      console.log(`  A: ${responseText.slice(0, 200)}...`);
      console.log();
    } catch (err: any) {
      console.log(`[${domain.toUpperCase().padEnd(10)}] ❌ ERROR: ${err.message}`);
    }
  }

  console.log(`\n═══ Result: ${correct}/5 responses in Portuguese ═══`);
  if (correct >= 4) console.log('✅ Gemini 2.5 Flash handles PT-BR well!');
  else console.log('⚠️ Some responses may not be in Portuguese — consider prompt tuning.');
}

runTest().catch(console.error);

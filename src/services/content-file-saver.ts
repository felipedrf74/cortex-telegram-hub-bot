// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { logger } from '../utils/logger';
import { uploadToDrive } from './google-drive';

const IDEAS_DIR = process.env.IDEAS_DIR || path.join(os.homedir(), 'Desktop', 'IDEAS');
const FILE_THRESHOLD = 3500;

const COMMAND_FOLDERS: Record<string, string> = {
  deepsearch: 'RESEARCH',
  sources: 'RESEARCH',
  hotnews: 'RESEARCH',
  trending: 'RESEARCH',
  discover: 'RESEARCH',
  transcribe: 'RESEARCH',
  ideas: 'IDEAS',
  reaction: 'IDEAS',
  hooks: 'IDEAS',
  titles: 'IDEAS',
  video: 'IDEAS',
  reel: 'IDEAS',
  calendar: 'IDEAS',
  contenttopic: 'IDEAS',
  studyvideo: 'IDEAS',
  genscript: 'SCRIPTS',
  script: 'SCRIPTS',
  buildscript: 'SCRIPTS',
  repurpose: 'SCRIPTS',
  genthumbnail: 'VISUALS',
  gencaption: 'VISUALS',
  competitor: 'REPORTS',
  gaps: 'REPORTS',
  seo: 'REPORTS',
  brandcheck: 'REPORTS',
  feedback: 'REPORTS',
  report: 'REPORTS',
};

function htmlToDocxChildren(content: string): Paragraph[] {
  const plain = content
    .replace(/<a href="([^"]*)">[^<]*<\/a>/g, '$1')
    .replace(/<code>[^<]*<\/code>/g, (m) => m.replace(/<\/?code>/g, ''));

  const lines = plain.split('\n');
  const children: Paragraph[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }

    const runs: TextRun[] = [];
    const regex = /(<b>(.+?)<\/b>|<i>(.+?)<\/i>|([^<]+|<[^>]*>))/g;
    let match: RegExpExecArray | null;
    let hasRuns = false;
    const stripped = line.replace(/<[^>]*>/g, '').trim();
    const isHeading = /^[🔥🎯📌🎣⏰📊🔍💡📝🎬🖼️📢✂️📁🏆⚡🧠💰🎯🔎📈💪🏃‍♂️🚴‍♂️⛪🇧🇷🌍]/.test(stripped) && stripped.length < 100;

    if (isHeading) {
      children.push(new Paragraph({
        children: [new TextRun({ text: stripped, bold: true, size: 24, font: 'Calibri' })],
        spacing: { before: 120, after: 60 },
      }));
      continue;
    }

    while ((match = regex.exec(line)) !== null) {
      if (match[2]) {
        runs.push(new TextRun({ text: match[2], bold: true, font: 'Calibri', size: 22 }));
        hasRuns = true;
      } else if (match[3]) {
        runs.push(new TextRun({ text: match[3], italics: true, font: 'Calibri', size: 22 }));
        hasRuns = true;
      } else if (match[4] && !match[4].startsWith('<')) {
        runs.push(new TextRun({ text: match[4], font: 'Calibri', size: 22 }));
        hasRuns = true;
      }
    }

    if (!hasRuns) {
      runs.push(new TextRun({ text: stripped, font: 'Calibri', size: 22 }));
    }

    children.push(new Paragraph({ children: runs, spacing: { before: 40, after: 40 } }));
  }

  return children;
}

export interface DocxResult {
  filePath: string;
  driveUrl?: string;
}

export async function saveContentAsDocx(
  content: string,
  command: string,
  topic: string,
  forceFile = false,
): Promise<DocxResult | null> {
  if (!forceFile && content.length < FILE_THRESHOLD) return null;

  const today = new Date().toISOString().slice(0, 10);
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9àáâãéêíóôõúç]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);

  const subfolder = COMMAND_FOLDERS[command] || 'OTHER';
  const dir = path.join(IDEAS_DIR, subfolder);
  const filename = `${slug}_${command}_${today}.docx`;
  const filePath = path.join(dir, filename);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const titleText = `${command.toUpperCase()} — ${topic}`;
    const docChildren = [
      new Paragraph({
        children: [new TextRun({ text: titleText, bold: true, size: 32, font: 'Calibri', color: '1A1A2E' })],
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `Generated: ${today}`, italics: true, size: 18, font: 'Calibri', color: '6B7280' })],
        spacing: { after: 200 },
      }),
      ...htmlToDocxChildren(content),
    ];

    const doc = new Document({
      sections: [{ children: docChildren }],
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
    logger.info({ filePath, chars: content.length }, `Saved ${command} output as DOCX`);

    let driveUrl: string | undefined;
    try {
      driveUrl = await uploadToDrive(filePath, filename, subfolder) || undefined;
    } catch {
      // Drive upload failure should not block local export.
    }

    return { filePath, driveUrl };
  } catch (err) {
    logger.error({ err }, 'Failed to save content DOCX');
    return null;
  }
}

export function maybeSaveToFile(
  content: string,
  command: string,
  topic: string,
  forceFile = false,
): string | null {
  if (!forceFile && content.length < FILE_THRESHOLD) return null;

  const today = new Date().toISOString().slice(0, 10);
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9àáâãéêíóôõúç]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  const filename = `${slug}_${command}_${today}.txt`;
  const filePath = path.join(IDEAS_DIR, filename);

  const plain = content
    .replace(/<b>/g, '**').replace(/<\/b>/g, '**')
    .replace(/<i>/g, '_').replace(/<\/i>/g, '_')
    .replace(/<a href="([^"]*)">[^<]*<\/a>/g, '$1')
    .replace(/<[^>]*>/g, '');

  try {
    if (!fs.existsSync(IDEAS_DIR)) fs.mkdirSync(IDEAS_DIR, { recursive: true });
    fs.writeFileSync(filePath, plain, 'utf-8');
    logger.info({ filePath, chars: content.length }, `Saved ${command} output to file`);
    return filePath;
  } catch (err) {
    logger.error({ err }, 'Failed to save content file');
    return null;
  }
}

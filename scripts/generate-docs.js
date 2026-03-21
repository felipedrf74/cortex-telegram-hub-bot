#!/usr/bin/env node
/**
 * Generate a professionally formatted DOCX from DOCUMENTATION.md
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, ShadingType, PageBreak, TabStopType, TabStopPosition,
  ImageRun, convertInchesToTwip,
} = require('docx');
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'DOCUMENTATION.md');
const OUTPUT = path.join(__dirname, '..', 'Cortex_Documentation.docx');

const md = fs.readFileSync(INPUT, 'utf8');
const lines = md.split('\n');

// ── Colors ──
const BRAND    = '1A1A2E';  // dark navy
const ACCENT   = '4A90D9';  // blue accent
const ACCENT2  = '16213E';  // dark blue
const GRAY     = '6B7280';  // subtle gray
const LIGHT_BG = 'F0F4F8';  // light blue-gray bg
const TBL_HDR  = '1A1A2E';  // table header bg
const TBL_ALT  = 'F8FAFC';  // table alt row bg
const WHITE    = 'FFFFFF';
const CODE_BG  = 'F3F4F6';

// ── Fonts ──
const FONT_MAIN = 'Calibri';
const FONT_CODE = 'Cascadia Code';
const SIZE_BODY = 22;  // 11pt
const SIZE_SMALL = 18; // 9pt

// ── Helpers ──
function parseInline(text) {
  // Parse **bold**, *italic*, `code` into TextRun[]
  const runs = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, font: FONT_MAIN, size: SIZE_BODY }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], italics: true, font: FONT_MAIN, size: SIZE_BODY }));
    } else if (match[4]) {
      runs.push(new TextRun({
        text: match[4], font: FONT_CODE, size: SIZE_SMALL,
        shading: { type: ShadingType.CLEAR, fill: CODE_BG },
      }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5], font: FONT_MAIN, size: SIZE_BODY }));
    }
  }
  return runs.length ? runs : [new TextRun({ text, font: FONT_MAIN, size: SIZE_BODY })];
}

function makeTableCell(text, isHeader = false, width = undefined) {
  const runs = isHeader
    ? [new TextRun({ text: text.trim(), bold: true, font: FONT_MAIN, size: SIZE_SMALL, color: WHITE })]
    : parseInline(text.trim()).map(r => {
        // Override size for table cells
        const obj = { text: r.root?.[1]?.text || text.trim(), font: FONT_MAIN, size: SIZE_SMALL };
        if (r.root?.[1]?.bold) obj.bold = true;
        if (r.root?.[1]?.italics) obj.italics = true;
        return new TextRun(obj);
      });

  const cellProps = {
    children: [new Paragraph({ children: runs, spacing: { before: 40, after: 40 } })],
    shading: isHeader
      ? { type: ShadingType.CLEAR, fill: TBL_HDR }
      : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  };
  if (width) {
    cellProps.width = { size: width, type: WidthType.PERCENTAGE };
  }
  return new TableCell(cellProps);
}

function buildTable(headerRow, dataRows) {
  const colCount = headerRow.length;
  const rows = [];

  // Header
  rows.push(new TableRow({
    tableHeader: true,
    children: headerRow.map(h => makeTableCell(h, true)),
  }));

  // Data rows
  dataRows.forEach((row, idx) => {
    const cells = row.map(cell => {
      const tc = makeTableCell(cell, false);
      if (idx % 2 === 1) {
        // Alt row shading
        return new TableCell({
          children: tc.root[0] ? [new Paragraph({
            children: [new TextRun({ text: cell.trim(), font: FONT_MAIN, size: SIZE_SMALL })],
            spacing: { before: 40, after: 40 },
          })] : tc.children,
          shading: { type: ShadingType.CLEAR, fill: TBL_ALT },
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
        });
      }
      return tc;
    });
    rows.push(new TableRow({ children: cells }));
  });

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
    },
  });
}

function spacer(pts = 100) {
  return new Paragraph({ text: '', spacing: { before: pts, after: pts } });
}

// ── Parse markdown ──
const children = [];
let i = 0;
let isFirstH1 = true;

while (i < lines.length) {
  const line = lines[i];

  // ── Empty lines ──
  if (!line.trim()) {
    i++;
    continue;
  }

  // ── Code blocks ──
  if (line.startsWith('```')) {
    const codeLines = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('```')) {
      codeLines.push(lines[i]);
      i++;
    }
    i++; // skip closing ```

    // Each code line as its own paragraph with code styling
    children.push(spacer(60));
    codeLines.forEach(cl => {
      children.push(new Paragraph({
        children: [new TextRun({
          text: cl || ' ',
          font: FONT_CODE,
          size: SIZE_SMALL,
          color: '374151',
        })],
        shading: { type: ShadingType.CLEAR, fill: CODE_BG },
        spacing: { before: 0, after: 0 },
        indent: { left: convertInchesToTwip(0.3) },
      }));
    });
    children.push(spacer(60));
    continue;
  }

  // ── Tables ──
  if (line.startsWith('|')) {
    const tableLines = [];
    while (i < lines.length && lines[i].startsWith('|')) {
      tableLines.push(lines[i]);
      i++;
    }

    // Parse: first line = header, second = separator (skip), rest = data
    if (tableLines.length >= 2) {
      const parseRow = (l) => l.split('|').slice(1, -1).map(c => c.trim());
      const header = parseRow(tableLines[0]);
      const data = tableLines.slice(2).map(parseRow);

      children.push(spacer(60));
      children.push(buildTable(header, data));
      children.push(spacer(60));
    }
    continue;
  }

  // ── H1 - Title page style ──
  if (line.startsWith('# ') && !line.startsWith('## ')) {
    const text = line.replace(/^# /, '');
    if (isFirstH1) {
      // Title page
      children.push(spacer(400));
      children.push(new Paragraph({
        children: [new TextRun({
          text: 'CORTEX',
          font: FONT_MAIN,
          size: 72,
          bold: true,
          color: ACCENT,
        })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
      }));
      children.push(new Paragraph({
        children: [new TextRun({
          text: text.replace('Cortex Telegram Hub Bot — ', ''),
          font: FONT_MAIN,
          size: 28,
          color: GRAY,
        })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }));
      isFirstH1 = false;
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text, font: FONT_MAIN, size: 40, bold: true, color: BRAND })],
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      }));
    }
    i++;
    continue;
  }

  // ── H2 - Section headers ──
  if (line.startsWith('## ')) {
    const text = line.replace(/^## /, '');
    children.push(spacer(100));
    // Blue accent bar + heading
    children.push(new Paragraph({
      children: [new TextRun({ text, font: FONT_MAIN, size: 32, bold: true, color: ACCENT2 })],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 100 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 2, color: ACCENT, space: 4 },
      },
    }));
    i++;
    continue;
  }

  // ── H3 ──
  if (line.startsWith('### ')) {
    const text = line.replace(/^### /, '');
    children.push(new Paragraph({
      children: [new TextRun({ text, font: FONT_MAIN, size: 26, bold: true, color: BRAND })],
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 240, after: 80 },
    }));
    i++;
    continue;
  }

  // ── H4 ──
  if (line.startsWith('#### ')) {
    const text = line.replace(/^#### /, '');
    children.push(new Paragraph({
      children: [new TextRun({ text, font: FONT_MAIN, size: 24, bold: true, color: ACCENT })],
      heading: HeadingLevel.HEADING_4,
      spacing: { before: 200, after: 60 },
    }));
    i++;
    continue;
  }

  // ── HR ──
  if (line.match(/^---+$/)) {
    children.push(new Paragraph({
      children: [],
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D1D5DB', space: 8 } },
      spacing: { before: 100, after: 100 },
    }));
    i++;
    continue;
  }

  // ── Blockquote ──
  if (line.startsWith('> ')) {
    const text = line.replace(/^> /, '');
    children.push(new Paragraph({
      children: parseInline(text),
      indent: { left: convertInchesToTwip(0.3) },
      border: { left: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 8 } },
      shading: { type: ShadingType.CLEAR, fill: LIGHT_BG },
      spacing: { before: 60, after: 60 },
    }));
    i++;
    continue;
  }

  // ── Numbered list (TOC links etc) ──
  if (line.match(/^\d+\.\s/)) {
    const text = line.replace(/^\d+\.\s/, '').replace(/\[(.+?)\]\(.+?\)/g, '$1');
    const num = line.match(/^(\d+)\./)[1];
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `${num}.  `, bold: true, font: FONT_MAIN, size: SIZE_BODY, color: ACCENT }),
        ...parseInline(text),
      ],
      indent: { left: convertInchesToTwip(0.2) },
      spacing: { before: 40, after: 40 },
    }));
    i++;
    continue;
  }

  // ── Bullet points ──
  if (line.match(/^(\s*)[-*]\s/)) {
    const indent = line.match(/^(\s*)/)[1].length;
    const text = line.replace(/^\s*[-*]\s/, '');
    const level = Math.floor(indent / 2);
    const bullet = level > 0 ? '  ▸ ' : '• ';
    children.push(new Paragraph({
      children: [
        new TextRun({ text: bullet, font: FONT_MAIN, size: SIZE_BODY, color: ACCENT }),
        ...parseInline(text),
      ],
      indent: { left: convertInchesToTwip(0.3 + level * 0.25) },
      spacing: { before: 30, after: 30 },
    }));
    i++;
    continue;
  }

  // ── Regular paragraph ──
  children.push(new Paragraph({
    children: parseInline(line),
    spacing: { before: 60, after: 60 },
  }));
  i++;
}

// ── Build document ──
const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: FONT_MAIN, size: SIZE_BODY },
      },
    },
  },
  sections: [{
    properties: {
      page: {
        margin: {
          top: convertInchesToTwip(0.8),
          bottom: convertInchesToTwip(0.8),
          left: convertInchesToTwip(1),
          right: convertInchesToTwip(1),
        },
      },
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(OUTPUT, buffer);
  console.log(`✅ Generated: ${OUTPUT} (${(buffer.length / 1024).toFixed(0)} KB)`);
});

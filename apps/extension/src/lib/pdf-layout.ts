// ─────────────────────────────────────────────
// PDF page layout reconstruction (pure)
// ─────────────────────────────────────────────
// pdf.js gives positioned text runs, not paragraphs. This turns those runs
// into readable markdown: groups runs into lines by Y, promotes big-font short
// lines to headings, joins paragraph continuations (and hyphenated line
// breaks), and — critically — handles TWO-COLUMN academic papers by processing
// each column separately so the columns don't braid together.
//
// Extracted from the offscreen document so it can be unit-tested and run over
// real PDFs headlessly. offscreen.ts feeds it the pdf.js text items.

import { cleanPdfPageMarkdown } from './pdf-text-cleaner';

export interface TextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

interface Line {
  y: number;
  x: number;
  text: string;
  fontSize: number;
}

function buildLines(bucket: TextBlock[]): Line[] {
  const out: Line[] = [];
  let current: TextBlock[] = [];
  const flush = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    const lineText = current.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
    if (lineText) {
      out.push({
        y: current[0].y,
        x: current[0].x,
        text: lineText,
        fontSize: Math.max(...current.map(it => it.fontSize))
      });
    }
    current = [];
  };
  for (const item of [...bucket].sort((a, b) => b.y - a.y)) {
    if (current.length > 0 && Math.abs(item.y - current[current.length - 1].y) >= 3) flush();
    current.push(item);
  }
  flush();
  return out;
}

/**
 * Turn positioned text runs from one PDF page into markdown.
 * @param items positioned text runs (from pdf.js getTextContent)
 * @param pageWidth unscaled page width, used for two-column detection
 */
export function buildPageMarkdown(items: TextBlock[], pageWidth: number): string {
  if (items.length === 0) return '';

  const fontSizes = items.map(it => it.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes.length > 0 ? fontSizes[Math.floor(fontSizes.length / 2)] : 10;

  // Two-column detection: academic PDFs put a second column starting past the
  // page midline. Building lines across the whole page braids the columns
  // ("same Y" pulls text from both) — detect and process each column
  // separately, left then right, with full-width lines (title, abstract
  // banner) kept ahead of the columns.
  const mid = pageWidth / 2;
  const rightStarters = items.filter(it => it.x > mid + 5).length;
  const leftStarters = items.filter(it => it.x < mid - 5 && it.x + it.width < mid + 15).length;
  const twoColumn = items.length > 30 &&
    rightStarters > items.length * 0.25 &&
    leftStarters > items.length * 0.25;

  let lines: Line[];
  if (twoColumn) {
    const full: TextBlock[] = [];
    const left: TextBlock[] = [];
    const right: TextBlock[] = [];
    for (const it of items) {
      if (it.x < mid - 5 && it.x + it.width > mid + 30) full.push(it);      // spans the midline
      else if (it.x > mid + 5) right.push(it);
      else left.push(it);
    }
    lines = [...buildLines(full), ...buildLines(left), ...buildLines(right)];
  } else {
    lines = buildLines(items);
  }

  let pageMarkdown = '';
  let lastLine: Line | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let lineText = line.text;

    // Header detection (short text + larger font size)
    let isHeader = false;
    if (lineText.length < 120) {
      if (line.fontSize >= medianFontSize * 1.5) {
        lineText = `# ${lineText}`;
        isHeader = true;
      } else if (line.fontSize >= medianFontSize * 1.25) {
        lineText = `## ${lineText}`;
        isHeader = true;
      } else if (line.fontSize >= medianFontSize * 1.12) {
        lineText = `### ${lineText}`;
        isHeader = true;
      }
    }

    const isList = /^(?:[•\-*]|\d+\.)\s+/.test(lineText);

    if (i > 0 && lastLine) {
      const verticalGap = lastLine.y - line.y;
      const expectedSpacing = lastLine.fontSize * 1.6;

      if (isHeader || isList || verticalGap > expectedSpacing || verticalGap < 0) {
        pageMarkdown += '\n\n' + lineText;
      } else {
        // Paragraph continuation
        if (pageMarkdown.endsWith('-')) {
          pageMarkdown = pageMarkdown.slice(0, -1) + lineText;   // de-hyphenate
        } else {
          pageMarkdown += ' ' + lineText;
        }
      }
    } else {
      pageMarkdown += lineText;
    }
    lastLine = line;
  }

  // PDF extraction splits citation brackets into separate positioned items
  // ("[ 87", "]"): re-join so references read as [87] not scattered fragments.
  pageMarkdown = pageMarkdown
    .replace(/\[\s+(\d)/g, '[$1')
    .replace(/(\d)\s+\]/g, '$1]')
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_m, g) => `[${g.replace(/\s+/g, '')}]`)
    // A numeric citation whose number pdf.js scattered across a column line
    // break loses the digit entirely, leaving an orphan "[ …" / "… ]" that
    // reads as noise ("residual connection [ itself"). Drop those orphans.
    // Well-formed refs have NO space inside the bracket ("[13]", "[MASK]",
    // "[CLS]"), so this only removes the broken remnants.
    .replace(/\[\s+/g, '')
    .replace(/\s+\]/g, '')
    .replace(/[ \t]{2,}/g, ' ');

  // Deterministic cleanup: letter-spaced small-caps headings, braided
  // figure/diagram label debris (see pdf-text-cleaner.ts).
  return cleanPdfPageMarkdown(pageMarkdown).trim();
}

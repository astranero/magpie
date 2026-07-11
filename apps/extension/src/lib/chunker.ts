// ─────────────────────────────────────────────
// Semantic Chunker — AI Research Assistant
// ─────────────────────────────────────────────
// Layout-aware paragraph-level chunking with citation anchors.
// Splits markdown at natural boundaries (headings, paragraphs)
// and assigns stable anchor IDs for citation mapping.

import type { Chunk } from './db';
import { cleanContent } from './content-cleaner';
import { splitFrontmatter } from './frontmatter';

export interface ChunkInput {
  docShortId: string;  // short ID for anchor generation (e.g. "d3")
  content: string;     // full markdown content
}

interface Section {
  heading: string;
  level: number;
  path: string[];   // heading hierarchy
  paragraphs: string[];
  startChar: number;
}

const MIN_CHUNK_CHARS = 50;
const MAX_CHUNK_CHARS = 2000;
// A paragraph up to 15% over MAX stays whole — splitting it would strand a
// small fragment whose meaning "slips" away from its context.
const MAX_CHUNK_SLACK = 1.15;

/**
 * Detect paragraphs that carry no citable knowledge: pure markup (images,
 * horizontal rules, table separator rows) or link farms (nav/related-articles
 * blocks that survived the content cleaner). Indexing these produces chunks
 * that get retrieved — and cited — without being relevant to anything.
 */
function isNoiseParagraph(text: string): boolean {
  const stripped = text.trim();
  if (!stripped) return true;
  // No letters at all (rules, separator rows, emoji lines)
  if (!/[a-zA-ZÀ-ɏЀ-ӿ]/.test(stripped)) return true;
  // Table separator / horizontal-rule lines only
  if (/^[\s|:\-=_*]+$/.test(stripped)) return true;
  // Image-only paragraph
  if (/^(!\[[^\]]*\]\([^)]*\)\s*)+$/.test(stripped)) return true;
  // Link farm: ≥2 links and ≥70% of characters inside link markup
  const links = stripped.match(/!?\[[^\]]*\]\([^)]*\)/g);
  if (links && links.length >= 2) {
    const linkChars = links.reduce((n, l) => n + l.length, 0);
    if (linkChars / stripped.length >= 0.7) return true;
  }
  // Numeric-table soup: benchmark tables and broken citation fragments from
  // PDF extraction ("Method 15.0 20.2 19.0 …", "16 ] and [ 27 ] continue").
  // ≥40% of tokens being bare numbers/brackets means no citable prose.
  const tokens = stripped.split(/\s+/);
  if (tokens.length >= 15) {
    const numericish = tokens.filter(t => /^[\d.,%()\[\]±:+\-—–]+$/.test(t)).length;
    if (numericish / tokens.length >= 0.4) return true;
  }
  return false;
}

/**
 * Parse markdown into semantic chunks with citation anchors.
 * Returns Chunk objects (minus `id` and `docId` — those are set by the DB layer).
 */
export function chunkDocument(input: ChunkInput): Omit<Chunk, 'id' | 'docId'>[] {
  const { docShortId, content: rawContent } = input;
  // YAML frontmatter is metadata, not citable knowledge — indexing it
  // produces "title: ... tags: ..." junk citations. Highlighting is
  // text-match based, so the offset shift is harmless.
  const withoutFm = splitFrontmatter(rawContent).body;
  // Clean content before chunking: remove noise, dedup, normalize
  const content = cleanContent(withoutFm);
  const sections = parseSections(content);
  const chunks: Omit<Chunk, 'id' | 'docId'>[] = [];
  let globalChunkIndex = 0;
  // Section index of the most recently emitted chunk — trailing tiny
  // paragraphs may only merge into a chunk from their own section.
  let lastChunkSectionIdx = -1;

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const section = sections[sIdx];
    const sectionPath = section.path.join(' > ') || 'Document';
    let paraOffset = section.startChar;

    for (let pIdx = 0; pIdx < section.paragraphs.length; pIdx++) {
      let text = section.paragraphs[pIdx].trim();
      if (!text) continue;

      const charStart = paraOffset;
      // Recalculate paraOffset before it's used to set charEnd
      paraOffset += section.paragraphs[pIdx].length + 2; // +2 for assumed \n\n between paragraphs

      // Knowledge-free paragraphs (link farms, separators, image-only) are
      // never indexed — they only surface as irrelevant citations.
      if (isNoiseParagraph(text)) continue;

      // Skip tiny chunks by merging with the next paragraph
      if (text.length < MIN_CHUNK_CHARS && pIdx < section.paragraphs.length - 1) {
        // Merge current text into the next paragraph, adjusting its start position
        // This avoids creating a new chunk for a very small paragraph
        section.paragraphs[pIdx + 1] = text + '\n\n' + section.paragraphs[pIdx + 1];
        continue;
      }

      // Trailing tiny paragraph (nothing left to merge forward into): glue it
      // onto the previous chunk instead of emitting a fragment chunk — but
      // only within the same section, so headings keep correct attribution.
      if (text.length < MIN_CHUNK_CHARS && chunks.length > 0 && lastChunkSectionIdx === sIdx) {
        const prev = chunks[chunks.length - 1];
        prev.text += '\n\n' + text;
        prev.charEnd = charStart + text.length;
        continue;
      }

      // Split oversized chunks at sentence boundaries
      if (text.length > MAX_CHUNK_CHARS * MAX_CHUNK_SLACK) {
        const subChunks = splitAtSentences(text, MAX_CHUNK_CHARS);
        let subOffset = charStart;

        for (let subIdx = 0; subIdx < subChunks.length; subIdx++) {
          const subText = subChunks[subIdx];
          const anchorId = `${docShortId}.s${sIdx}.p${pIdx}.${subIdx}`;

          lastChunkSectionIdx = sIdx;
          chunks.push({
            chunkIndex: globalChunkIndex++,
            text: subText,
            heading: section.heading,
            sectionPath,
            paragraphIndex: pIdx,
            anchorId,
            charStart: subOffset,
            charEnd: subOffset + subText.length
          });
          // Note: subOffset adjustment for the next sub-chunk implicitly assumes
          // that there are no gaps between split sentences. This is generally
          // true for the current implementation of splitAtSentences.
          subOffset += subText.length;
        }
        continue; // Move to the next paragraph
      }

      // If we've reached here, the chunk is of an acceptable size
      const anchorId = `${docShortId}.s${sIdx}.p${pIdx}`;

      lastChunkSectionIdx = sIdx;
      chunks.push({
        chunkIndex: globalChunkIndex++,
        text,
        heading: section.heading,
        sectionPath,
        paragraphIndex: pIdx,
        anchorId,
        charStart,
        charEnd: charStart + text.length
      });
    }
  }

  return chunks;
}

/**
 * Parse markdown into sections based on heading hierarchy.
 */
function parseSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];

  let currentHeading = '';
  let currentLevel = 0;
  const headingStack: string[] = [];
  let currentParagraphs: string[] = [];
  let currentParagraph = '';
  let sectionStartChar = 0;
  let charPos = 0;

  function flushParagraph() {
    if (currentParagraph) { // Push the original paragraph with whitespace
      currentParagraphs.push(currentParagraph);
    }
    currentParagraph = '';
  }

  function flushSection() {
    flushParagraph();
    if (currentParagraphs.length > 0 || sections.length === 0) {
      sections.push({
        heading: currentHeading || 'Document',
        level: currentLevel,
        path: [...headingStack],
        paragraphs: currentParagraphs,
        startChar: sectionStartChar
      });
    }
    currentParagraphs = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Flush previous section
      flushSection();

      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();

      // Update heading stack
      while (headingStack.length >= level) {
        headingStack.pop();
      }
      headingStack.push(headingText);

      currentHeading = headingText;
      currentLevel = level;
      // Section starts at the beginning of the heading line
      sectionStartChar = charPos;
    } else if (line.trim() === '') {
      // Paragraph break
      flushParagraph();
    } else {
      // Accumulate paragraph text
      if (currentParagraph) {
        currentParagraph += '\n' + line;
      } else {
        // Start of a new paragraph, capture its start position relative to content
        currentParagraph = line;
      }
    }

    charPos += line.length + 1; // +1 for \n
  }

  // Flush final section
  flushSection();

  // Post-process to find the start character of each paragraph within its section
  // (Logic is handled inside chunkDocument to be more accurate)

  return sections;
}


/**
 * Split a long text into chunks at sentence boundaries.
 */
function splitAtSentences(text: string, maxChars: number): string[] {
  // Split on sentence-ending punctuation followed by space or newline
  const sentences = text.match(/[^.!?\n]+[.!?\n]+[\s]*/g) || [text];
  const result: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      result.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  // A tiny tail fragment ("slipped" sentence) reads as noise on its own —
  // fold it back into the previous sub-chunk.
  if (result.length > 1 && result[result.length - 1].length < MIN_CHUNK_CHARS * 2) {
    const tail = result.pop()!;
    result[result.length - 1] += ' ' + tail;
  }

  return result.length > 0 ? result : [text];
}

/**
 * Generate a short document ID for anchor generation.
 * Uses first 6 chars of the full UUID for brevity.
 */
export function makeDocShortId(fullId: string): string {
  return 'd' + fullId.slice(0, 6);
}


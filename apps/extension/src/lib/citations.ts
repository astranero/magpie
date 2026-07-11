// ─────────────────────────────────────────────
// Citation Parser — AI Research Assistant
// ─────────────────────────────────────────────
// Parses AI responses to extract citation markers [anchorId]
// and maps them back to source chunks in the database.

import { getChunkByAnchor, getDocument, type Chunk } from './db';

export interface Citation {
  anchorId: string;
  docId: string;
  docTitle: string;
  docUrl: string;
  chunkText: string;
  sectionPath: string;
  heading: string;
}

export interface ParsedSegment {
  text: string;
  citation?: Citation;
}

export interface ParsedResponse {
  segments: ParsedSegment[];
  citations: Citation[];       // deduplicated list of all citations
  rawText: string;             // original response text
}

// Matches [anchorId] patterns like [d3.s2.p4] or [d3ab01.s0.p1.0]
const CITATION_REGEX = /\[([a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?)\]/g;

/**
 * Parse an AI response to extract citation markers and resolve them
 * against the IndexedDB chunk store.
 */
export async function parseResponseCitations(responseText: string): Promise<ParsedResponse> {
  // Find all unique anchor IDs in the response
  const anchorIds = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(CITATION_REGEX.source, 'g');

  while ((match = regex.exec(responseText)) !== null) {
    anchorIds.add(match[1]);
  }

  // Resolve all anchors to citations
  const citationMap = new Map<string, Citation>();

  for (const anchorId of anchorIds) {
    const chunk = await getChunkByAnchor(anchorId);
    if (chunk) {
      const doc = await getDocument(chunk.docId);
      citationMap.set(anchorId, {
        anchorId,
        docId: chunk.docId,
        docTitle: doc?.title || 'Unknown',
        docUrl: doc?.url || '',
        chunkText: chunk.text.slice(0, 300), // preview
        sectionPath: chunk.sectionPath,
        heading: chunk.heading
      });
    }
  }

  // Split the response into segments (text + optional citation)
  const segments: ParsedSegment[] = [];
  let lastIndex = 0;
  const splitRegex = new RegExp(CITATION_REGEX.source, 'g');

  while ((match = splitRegex.exec(responseText)) !== null) {
    // Text before this citation
    const textBefore = responseText.slice(lastIndex, match.index);
    if (textBefore) {
      segments.push({ text: textBefore });
    }

    // The citation itself
    const anchorId = match[1];
    const citation = citationMap.get(anchorId);
    segments.push({
      text: match[0], // the [anchorId] marker text
      citation: citation || {
        anchorId,
        docId: '',
        docTitle: 'Unknown source',
        docUrl: '',
        chunkText: '',
        sectionPath: '',
        heading: ''
      }
    });

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last citation
  const remaining = responseText.slice(lastIndex);
  if (remaining) {
    segments.push({ text: remaining });
  }

  // If no citations found, return the whole text as a single segment
  if (segments.length === 0) {
    segments.push({ text: responseText });
  }

  return {
    segments,
    citations: [...citationMap.values()],
    rawText: responseText
  };
}

/**
 * Build citation-anchored context from chunks for the AI prompt.
 * Each chunk's text is prefixed with its anchor marker.
 */
export function buildCitationContext(
  chunks: Chunk[],
  docTitles: Map<string, string>,
  maxChars: number = 30000
): string {
  let context = '';
  let currentDocId = '';

  for (const chunk of chunks) {
    if (context.length > maxChars) break;

    // Add document header when switching to a new document
    if (chunk.docId !== currentDocId) {
      const title = docTitles.get(chunk.docId) || 'Unknown';
      context += `\n[Source: ${title}]\n`;
      currentDocId = chunk.docId;
    }

    context += `<c>${chunk.anchorId}</c> ${chunk.text}\n\n`;
  }

  return context;
}

/**
 * System prompt that enforces source-grounded citation.
 */
export const CITATION_SYSTEM_PROMPT =
  `You are a private AI Research Assistant. Answer ONLY using the provided source documents below.\n` +
  `RULES:\n` +
  `1. For every factual claim, cite the source by placing the citation anchor in brackets immediately after the claim.\n` +
  `2. Citation format: [anchor_id] — e.g., "Neural networks learn via backpropagation [d3ab01.s1.p2]."\n` +
  `   ONE anchor per bracket. For multiple sources write [d3ab01.s1.p2][d3ab01.s4.p1] — NEVER comma-separate inside one bracket like [a, b].\n` +
  `3. Each <c>anchor</c> tag marks a citable paragraph. Use the anchor ID inside the tag.\n` +
  `4. If the information is NOT in the provided sources, explicitly state: "This information was not found in your sources."\n` +
  `5. Never fabricate citations or use anchor IDs that don't exist in the provided context.\n` +
  `6. Cite a passage ONLY when it directly supports the claim it is attached to. If a provided passage is off-topic or only shares a keyword with the question, ignore it completely — do not cite it and do not work it into the answer.\n` +
  `7. Use structured formatting with headings and bullet points when appropriate.\n`;

/**
 * Strip citation markers from text for plain display.
 */
export function stripCitations(text: string): string {
  // Replace the marker (e.g. [d1.s1.p1]) AND any leading space that might have been there
  // Actually, keep it simple first.
  return text.replace(CITATION_REGEX, '').replace(/\s+\./g, '.').replace(/\s{2,}/g, ' ').trim();
}

// ─────────────────────────────────────────────
// Research outline — the dynamic report skeleton that co-evolves with gathering
// ─────────────────────────────────────────────
// SOTA deep-research systems (WebWeaver-style outline–search co-evolution,
// Stanford STORM's outline-first writing) keep a living outline: each research
// stage updates it with new evidence, its thin sections steer the next stage's
// queries, and the final report is written SECTION BY SECTION against it —
// which is what finally fixes chronically-short single-call reports.
//
// Everything here is pure (no chrome.*, no async) so it unit-tests directly.
// The outline is checkpointed in the research job (research-store.ts) exactly
// like stage briefs — any function that mutates it returns a new object.

export interface OutlineSection {
  /** Stable id ("s1".."s10") — the reflect prompt pins ids across stages. */
  id: string;
  /** Descriptive, topic-specific heading (becomes the report's `## heading`). */
  heading: string;
  /** 1-2 sentences: what this section must establish. */
  goal: string;
  /** Retrieval hints for section-scoped search (cap 8). */
  keyTerms: string[];
  /** Evidence bullets carrying [anchor_id]s verbatim (cap 10, each ≤240 chars). */
  evidenceNotes: string[];
  /** Honest fill level — empty/thin sections drive the next stage's queries. */
  status: 'empty' | 'thin' | 'adequate' | 'rich';
}

export interface ResearchOutline {
  sections: OutlineSection[];
  /** Stage number that last wrote the outline. */
  version: number;
}

export interface StageHandoff {
  establishedFacts: string[];
  openGaps: string[];
  contradictions: string[];
  focusNext: string;
}

export interface ReflectResult {
  outline: ResearchOutline;
  handoff: StageHandoff;
  queries: string[];
}

const MAX_SECTIONS = 10;
const MAX_KEY_TERMS = 8;
const MAX_EVIDENCE_NOTES = 10;
const MAX_NOTE_CHARS = 240;
const MAX_QUERIES = 5;

const STATUSES = new Set(['empty', 'thin', 'adequate', 'rich']);

function asStringArray(v: unknown, cap: number, maxLen = 500): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim().slice(0, maxLen))
    .slice(0, cap);
}

/**
 * Parse the reflect call's STRICT-JSON output with a repair ladder:
 * fences → brace slice → trailing-comma/smart-quote repair → field coercion.
 * Returns null only when no valid section survives (caller degrades to the
 * pre-outline pipeline behavior).
 */
export function parseReflect(raw: string): ReflectResult | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.replace(/```(?:json)?/gi, ' ');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  text = text.slice(start, end + 1);

  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Common model damage: trailing commas, smart quotes.
    const repaired = text
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    try { parsed = JSON.parse(repaired); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const rawSections = Array.isArray(parsed.outline?.sections) ? parsed.outline.sections
    : Array.isArray(parsed.sections) ? parsed.sections : [];
  const sections: OutlineSection[] = [];
  for (let i = 0; i < rawSections.length && sections.length < MAX_SECTIONS; i++) {
    const s = rawSections[i];
    if (!s || typeof s !== 'object') continue;
    const heading = typeof s.heading === 'string' ? s.heading.trim() : '';
    if (!heading) continue; // a section without a heading is unusable
    sections.push({
      id: typeof s.id === 'string' && s.id.trim() ? s.id.trim().slice(0, 12) : `s${i + 1}`,
      heading: heading.slice(0, 160),
      goal: typeof s.goal === 'string' ? s.goal.trim().slice(0, 400) : '',
      keyTerms: asStringArray(s.keyTerms, MAX_KEY_TERMS, 60),
      evidenceNotes: asStringArray(s.evidenceNotes, MAX_EVIDENCE_NOTES, MAX_NOTE_CHARS),
      status: STATUSES.has(s.status) ? s.status : 'thin',
    });
  }
  if (sections.length === 0) return null;

  const h = parsed.handoff && typeof parsed.handoff === 'object' ? parsed.handoff : {};
  const handoff: StageHandoff = {
    establishedFacts: asStringArray(h.establishedFacts, 12),
    openGaps: asStringArray(h.openGaps, 8),
    contradictions: asStringArray(h.contradictions, 8),
    focusNext: typeof h.focusNext === 'string' ? h.focusNext.trim().slice(0, 400) : '',
  };

  const queries = asStringArray(parsed.queries, MAX_QUERIES, 200).filter(q => q.length > 3);

  return { outline: { sections, version: 0 }, handoff, queries };
}

const fuzzyKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Defend against the model dropping sections between stages: any prior section
 * with real evidence (≥2 notes) whose id AND fuzzy heading are both absent
 * from the update is re-appended. Cap total at MAX_SECTIONS.
 */
export function mergeOutlines(prior: ResearchOutline | null, next: ResearchOutline): ResearchOutline {
  if (!prior) return next;
  const ids = new Set(next.sections.map(s => s.id));
  const headings = new Set(next.sections.map(s => fuzzyKey(s.heading)));
  const merged = [...next.sections];
  for (const p of prior.sections) {
    if (merged.length >= MAX_SECTIONS) break;
    if (p.evidenceNotes.length < 2) continue;
    if (ids.has(p.id) || headings.has(fuzzyKey(p.heading))) continue;
    merged.push(p);
  }
  return { sections: merged, version: next.version };
}

/**
 * Keep the checkpointed outline bounded: shave the OLDEST evidence notes
 * (front of each list) round-robin until the serialized form fits.
 */
export function trimOutline(o: ResearchOutline, maxChars = 8000): ResearchOutline {
  const clone: ResearchOutline = { version: o.version, sections: o.sections.map(s => ({ ...s, keyTerms: [...s.keyTerms], evidenceNotes: [...s.evidenceNotes] })) };
  let guard = 200;
  while (JSON.stringify(clone).length > maxChars && guard-- > 0) {
    // Shave from the section with the most notes (oldest note first).
    let densest: OutlineSection | null = null;
    for (const s of clone.sections) {
      if (!densest || s.evidenceNotes.length > densest.evidenceNotes.length) densest = s;
    }
    if (!densest || densest.evidenceNotes.length === 0) break;
    densest.evidenceNotes.shift();
  }
  return clone;
}

/** Prompt-facing skeleton: headings + goals + fill status. */
export function formatOutlineSkeleton(o: ResearchOutline): string {
  return o.sections.map((s, i) => {
    const status = s.status === 'empty' ? ' (no evidence yet)' : s.status === 'thin' ? ' (thin)' : '';
    return `${i + 1}. ${s.heading}${status}\n   Goal: ${s.goal || '—'}`;
  }).join('\n');
}

/**
 * Render the handoff in the EXACT markdown contract the stage-brief prompt has
 * always consumed (byte-compatible headings with the old buildStageHandoff),
 * so synthesizeStageBrief's prompt needs no change.
 */
export function formatHandoff(h: StageHandoff): string {
  const bullets = (xs: string[], empty: string) => xs.length ? xs.map(x => `- ${x}`).join('\n') : `- ${empty}`;
  return [
    '## Established Facts',
    bullets(h.establishedFacts, 'None yet'),
    '',
    '## Open Gaps',
    bullets(h.openGaps, 'None identified'),
    '',
    '## Contradictions Found',
    bullets(h.contradictions, 'None'),
    '',
    '## Recommended Focus for Next Stage',
    h.focusNext || '—',
  ].join('\n');
}

/**
 * Pick the brief paragraphs most relevant to one outline section (token-overlap
 * scoring against heading+goal+keyTerms), greedily packed to a char budget.
 * Used by section-scoped synthesis so each section call gets ONLY its material.
 */
export function selectBriefExcerpts(briefs: string[], section: OutlineSection, budgetChars = 6000): string {
  const targetTokens = new Set(
    `${section.heading} ${section.goal} ${section.keyTerms.join(' ')}`
      .toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3)
  );
  if (targetTokens.size === 0) return '';

  const scored: Array<{ text: string; score: number; stage: number }> = [];
  briefs.forEach((brief, bi) => {
    for (const para of brief.split(/\n\s*\n/)) {
      const p = para.trim();
      if (p.length < 80) continue;
      let score = 0;
      for (const tok of new Set(p.toLowerCase().split(/[^a-z0-9]+/))) {
        if (targetTokens.has(tok)) score++;
      }
      if (score > 0) scored.push({ text: p, score, stage: bi + 1 });
    }
  });
  scored.sort((a, b) => b.score - a.score);

  const out: string[] = [];
  let used = 0;
  for (const s of scored) {
    const rendered = `(from Stage ${s.stage} brief)\n${s.text}`;
    if (used + rendered.length > budgetChars) continue;
    out.push(rendered);
    used += rendered.length + 2;
  }
  return out.join('\n\n');
}

/** Deterministic next-stage queries from thin sections, when reflect under-delivers. */
export function sectionQueriesFallback(topic: string, o: ResearchOutline, max = MAX_QUERIES): string[] {
  return o.sections
    .filter(s => s.status === 'empty' || s.status === 'thin')
    .slice(0, max)
    .map(s => `${topic} ${s.heading}`.slice(0, 200));
}

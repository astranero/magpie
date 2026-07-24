// ─────────────────────────────────────────────
// Reference harvester — link-following for deep research
// ─────────────────────────────────────────────
// Extracts followable references from gathered source text: DOI and arXiv
// citations (always safe to follow — that's literature snowballing) plus
// markdown web links (kept only for later anchor-text relevance scoring).
// This adds depth (provenance chains) to complement the breadth of gap
// queries. Following *every* link would be crawling; we restrict to
// high-precision classes.

export interface HarvestedRef {
  url: string;
  kind: 'arxiv' | 'doi' | 'web';
  anchorText?: string;
}

const ARXIV_RE = /\b(?:arxiv[:\s]*)?(\d{4}\.\d{4,5})(?:v\d+)?\b/gi;
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/gi;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>)\]]+)/gi;
const MD_LINK_RE = /\[([^\]]{2,120})\]\((https?:\/\/[^)\s]+)\)/gi;

function normalizeArxiv(id: string): string {
  return `https://arxiv.org/abs/${id}`;
}

/**
 * Harvest references from source chunk texts. `seenUrls` (already-scraped URLs
 * from the job cache) and a junk filter prevent re-fetching and noise.
 */
export function harvestReferences(
  texts: string[],
  opts: { seenUrls?: Set<string>; isJunk?: (u: string) => boolean; max?: number } = {}
): HarvestedRef[] {
  const { seenUrls = new Set(), isJunk = () => false, max = 30 } = opts;
  const refs = new Map<string, HarvestedRef>();
  const add = (url: string, kind: HarvestedRef['kind'], anchorText?: string) => {
    if (refs.has(url) || seenUrls.has(url) || isJunk(url)) return;
    refs.set(url, { url, kind, anchorText });
  };

  for (const text of texts) {
    let m: RegExpExecArray | null;

    ARXIV_URL_RE.lastIndex = 0;
    while ((m = ARXIV_URL_RE.exec(text)) !== null) add(normalizeArxiv(m[1]), 'arxiv');

    ARXIV_RE.lastIndex = 0;
    while ((m = ARXIV_RE.exec(text)) !== null) add(normalizeArxiv(m[1]), 'arxiv');

    DOI_RE.lastIndex = 0;
    while ((m = DOI_RE.exec(text)) !== null) {
      const doi = m[1].replace(/[.,;)\]]+$/, '');
      add(`https://doi.org/${doi}`, 'doi');
    }

    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(text)) !== null) {
      const anchor = m[1].trim();
      const url = m[2];
      // Skip anchors that are just the URL or navigation chrome
      if (anchor.length < 4 || /^https?:/.test(anchor)) continue;
      add(url, 'web', anchor);
    }

    if (refs.size >= max) break;
  }

  return [...refs.values()].slice(0, max);
}

/** Split harvested refs into citation-grade (always follow) and web (needs scoring). */
export function partitionRefs(refs: HarvestedRef[]): { citations: HarvestedRef[]; web: HarvestedRef[] } {
  return {
    citations: refs.filter(r => r.kind === 'arxiv' || r.kind === 'doi'),
    web: refs.filter(r => r.kind === 'web')
  };
}

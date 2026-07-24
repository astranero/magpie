// ─────────────────────────────────────────────
// Parsing OpenAlex and PubMed responses
// ─────────────────────────────────────────────
// The network calls live in deep-researcher; the PARSING lives here, pure, so
// the two fiddly formats — OpenAlex's inverted-index abstract and PubMed's
// efetch XML — are unit-tested against real fixtures instead of trusted.

export interface ParsedPaper {
  title: string;
  abstract: string;
  year: string;
  authors: string;
  doi?: string;
  citations?: number;
  venue?: string;
  /** PubMed only. */
  pmid?: string;
}

/**
 * OpenAlex ships an abstract as `abstract_inverted_index`: { word: [positions] }.
 * Rebuild the running text by placing each word at every position it occupies.
 * Returns '' for a missing/empty index (many works have none) so the caller can
 * drop it — an abstract-less paper is not worth a source slot.
 */
export function reconstructOpenAlexAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index || typeof index !== 'object') return '';
  const slots: string[] = [];
  let max = -1;
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos !== 'number' || pos < 0) continue;
      slots[pos] = word;
      if (pos > max) max = pos;
    }
  }
  if (max < 0) return '';
  const out: string[] = [];
  for (let i = 0; i <= max; i++) if (slots[i] !== undefined) out.push(slots[i]);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Map one OpenAlex `work` JSON object to a ParsedPaper, or null if unusable. */
export function openAlexWorkToPaper(work: any): ParsedPaper | null {
  if (!work || typeof work !== 'object') return null;
  const title = typeof work.display_name === 'string' ? work.display_name.trim() : '';
  const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
  if (!title || abstract.length < 80) return null;   // no title or too thin to cite

  const doiRaw = typeof work.doi === 'string' ? work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : undefined;
  const authors = (Array.isArray(work.authorships) ? work.authorships : [])
    .map((a: any) => a?.author?.display_name)
    .filter((n: any): n is string => typeof n === 'string' && n.length > 0)
    .slice(0, 20)
    .join(', ');
  const year = work.publication_year ? String(work.publication_year) : '';
  const venue = work.primary_location?.source?.display_name
    ?? work.host_venue?.display_name
    ?? undefined;

  return {
    title,
    abstract,
    year,
    authors,
    doi: doiRaw || undefined,
    citations: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
    venue: typeof venue === 'string' ? venue : undefined,
    // openAlexWorkToPaper's caller sets url on the record; ParsedPaper has no url
    // field, so callers derive it from doi. Kept minimal on purpose.
  };
}

// ── PubMed efetch XML ──
// efetch returns <PubmedArticle> nodes. We pull title, the (possibly multi-part,
// possibly labelled) abstract, authors, year, DOI and PMID. A regex reader, not
// a DOM parse: the service worker has no DOMParser, the schema is stable, and we
// only need a handful of fields.

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');   // last, so "&amp;lt;" doesn't double-decode
}

function stripTags(s: string): string {
  return decodeXmlEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstMatch(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

/**
 * Parse a PubMed efetch XML payload into papers. Multi-section abstracts
 * (Background/Methods/Results/Conclusions) are joined with their labels so the
 * structure survives; a paper with no abstract is dropped.
 */
export function parsePubMedArticles(xml: string): ParsedPaper[] {
  const out: ParsedPaper[] = [];
  const articles = (xml || '').match(/<PubmedArticle[\s\S]*?<\/PubmedArticle>/gi) || [];
  for (const art of articles) {
    const title = firstMatch(art, 'ArticleTitle');
    if (!title) continue;

    // Abstract: one or more <AbstractText Label="...">…</AbstractText>.
    const parts: string[] = [];
    const absRe = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/gi;
    let m: RegExpExecArray | null;
    while ((m = absRe.exec(art)) !== null) {
      const label = m[1].match(/Label="([^"]+)"/i)?.[1];
      const text = stripTags(m[2]);
      if (text) parts.push(label ? `${label}: ${text}` : text);
    }
    const abstract = parts.join(' ');
    if (abstract.length < 80) continue;

    const pmid = firstMatch(art, 'PMID');
    const doi = art.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/i)?.[1]?.trim();
    const year = art.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/i)?.[1]
      ?? art.match(/<Year>(\d{4})<\/Year>/i)?.[1]
      ?? '';
    const authors = (art.match(/<Author[^>]*>[\s\S]*?<\/Author>/gi) || [])
      .map(a => {
        const last = firstMatch(a, 'LastName');
        const fore = firstMatch(a, 'ForeName') || firstMatch(a, 'Initials');
        return [fore, last].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .slice(0, 20)
      .join(', ');
    const venue = firstMatch(art, 'Title');   // <Journal><Title>

    out.push({ title, abstract, year, authors, doi: doi || undefined, pmid: pmid || undefined, venue: venue || undefined });
  }
  return out;
}

/** Pull the PMID list out of an esearch response (JSON). */
export function parsePubMedIds(json: any): string[] {
  const ids = json?.esearchresult?.idlist;
  return Array.isArray(ids) ? ids.filter((x: any): x is string => typeof x === 'string') : [];
}

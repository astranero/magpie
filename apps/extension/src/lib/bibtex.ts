// ─────────────────────────────────────────────
// BibTeX generation for academic sources
// ─────────────────────────────────────────────
// BibTeX is citation-style-agnostic — Harvard/agsm, IEEE, APA are applied by
// the document processor. Key format: {surname}{year}{firstTitleWord}.

export interface BibtexMeta {
  title: string;
  /** Comma-separated author names as returned by S2/CrossRef: "Ada Lovelace, Alan Turing" */
  authors?: string;
  year?: string;
  doi?: string;
  venue?: string;
  url?: string;
}

const VENUE_CONF = /\b(proceedings|conference|workshop|symposium|congress|meeting)\b/i;

function bibEscape(s: string): string {
  return s.replace(/([{}])/g, '\\$1').replace(/([&%$#_])/g, '\\$1');
}

/** "Ada Lovelace, Alan Turing" → "Lovelace, Ada and Turing, Alan" */
export function formatBibAuthors(authors: string): string {
  return authors
    .split(/\s*(?:,|;| and )\s*/i)
    .filter(Boolean)
    .map(name => {
      const parts = name.trim().split(/\s+/);
      if (parts.length < 2) return name.trim();
      const surname = parts[parts.length - 1];
      return `${surname}, ${parts.slice(0, -1).join(' ')}`;
    })
    .join(' and ');
}

/** Citation key: {surname}{year}{firstMeaningfulTitleWord}, all lowercase. */
export function makeBibKey(meta: BibtexMeta): string {
  const firstAuthor = (meta.authors || '').split(/\s*(?:,|;| and )\s*/i)[0] || 'unknown';
  const surname = firstAuthor.trim().split(/\s+/).pop() || 'unknown';
  const stop = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with']);
  const word = (meta.title || 'untitled')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find(w => w.length > 1 && !stop.has(w)) || 'untitled';
  return `${surname.toLowerCase().replace(/[^a-z0-9]/g, '')}${meta.year || ''}${word}`;
}

export function generateBibtex(meta: BibtexMeta): string {
  const isConference = meta.venue ? VENUE_CONF.test(meta.venue) : false;
  const entryType = isConference ? 'inproceedings' : 'article';
  const venueField = isConference ? 'booktitle' : 'journal';

  const fields: Array<[string, string | undefined]> = [
    ['author', meta.authors ? formatBibAuthors(meta.authors) : undefined],
    ['title', meta.title ? `{${bibEscape(meta.title)}}` : undefined],
    [venueField, meta.venue ? bibEscape(meta.venue) : undefined],
    ['year', meta.year || undefined],
    ['doi', meta.doi || undefined],
    ['url', meta.url || undefined]
  ];

  const body = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(',\n');

  return `@${entryType}{${makeBibKey(meta)},\n${body}\n}`;
}

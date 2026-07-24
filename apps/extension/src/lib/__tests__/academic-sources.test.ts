import { describe, it, expect } from 'vitest';
import {
  reconstructOpenAlexAbstract,
  openAlexWorkToPaper,
  parsePubMedArticles,
  parsePubMedIds,
} from '../academic-sources';

describe('reconstructOpenAlexAbstract', () => {
  it('rebuilds the running text from the inverted index', () => {
    // "the quick brown fox" — positions as OpenAlex ships them.
    const idx = { the: [0], quick: [1], brown: [2], fox: [3] };
    expect(reconstructOpenAlexAbstract(idx)).toBe('the quick brown fox');
  });

  it('places a repeated word at every position it occupies', () => {
    const idx = { the: [0, 4], cat: [1], sat: [2], on: [3], mat: [5] };
    expect(reconstructOpenAlexAbstract(idx)).toBe('the cat sat on the mat');
  });

  it('returns empty for a missing or empty index', () => {
    expect(reconstructOpenAlexAbstract(null)).toBe('');
    expect(reconstructOpenAlexAbstract(undefined)).toBe('');
    expect(reconstructOpenAlexAbstract({})).toBe('');
  });

  it('tolerates a gap without crashing', () => {
    const idx = { a: [0], c: [2] };   // position 1 missing
    expect(reconstructOpenAlexAbstract(idx)).toBe('a c');
  });
});

describe('openAlexWorkToPaper', () => {
  const work = {
    id: 'https://openalex.org/W123',
    display_name: 'Attention Is All You Need',
    doi: 'https://doi.org/10.5555/3295222.3295349',
    publication_year: 2017,
    cited_by_count: 99999,
    abstract_inverted_index: Object.fromEntries(
      'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks'
        .split(' ').map((w, i) => [w, [i]]),
    ),
    authorships: [
      { author: { display_name: 'Ashish Vaswani' } },
      { author: { display_name: 'Noam Shazeer' } },
    ],
    primary_location: { source: { display_name: 'NeurIPS' } },
  };

  it('maps a work to a paper with a normalized DOI', () => {
    const p = openAlexWorkToPaper(work)!;
    expect(p.title).toBe('Attention Is All You Need');
    expect(p.doi).toBe('10.5555/3295222.3295349');   // scheme + doi.org stripped
    expect(p.citations).toBe(99999);
    expect(p.authors).toBe('Ashish Vaswani, Noam Shazeer');
    expect(p.venue).toBe('NeurIPS');
    expect(p.abstract).toContain('dominant sequence transduction');
  });

  it('drops a work with no abstract or no title', () => {
    expect(openAlexWorkToPaper({ display_name: 'X', abstract_inverted_index: {} })).toBeNull();
    expect(openAlexWorkToPaper({ abstract_inverted_index: work.abstract_inverted_index })).toBeNull();
    expect(openAlexWorkToPaper(null)).toBeNull();
  });
});

describe('parsePubMedIds', () => {
  it('reads the idlist from an esearch response', () => {
    expect(parsePubMedIds({ esearchresult: { idlist: ['111', '222'] } })).toEqual(['111', '222']);
  });
  it('is safe on a malformed response', () => {
    expect(parsePubMedIds({})).toEqual([]);
    expect(parsePubMedIds(null)).toEqual([]);
  });
});

describe('parsePubMedArticles', () => {
  const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">35486828</PMID>
      <Article>
        <Journal><Title>Nature Medicine</Title></Journal>
        <ArticleTitle>A trial of the vaccine.</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">The disease spreads fast.</AbstractText>
          <AbstractText Label="RESULTS">Efficacy was 94% in the treated arm versus placebo across the cohort.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><LastName>Smith</LastName><ForeName>Jane</ForeName></Author>
          <Author><LastName>Doe</LastName><Initials>JR</Initials></Author>
        </AuthorList>
        <PubDate><Year>2022</Year></PubDate>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="doi">10.1038/s41591-022-01678-6</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

  it('extracts title, labelled multi-part abstract, authors, year, doi, pmid', () => {
    const [p] = parsePubMedArticles(xml);
    expect(p.title).toBe('A trial of the vaccine.');
    expect(p.abstract).toContain('BACKGROUND: The disease spreads fast.');
    expect(p.abstract).toContain('RESULTS: Efficacy was 94%');
    expect(p.authors).toBe('Jane Smith, JR Doe');
    expect(p.year).toBe('2022');
    expect(p.doi).toBe('10.1038/s41591-022-01678-6');
    expect(p.pmid).toBe('35486828');
    expect(p.venue).toBe('Nature Medicine');
  });

  it('drops an article with no abstract', () => {
    const noAbs = xml.replace(/<Abstract>[\s\S]*?<\/Abstract>/, '');
    expect(parsePubMedArticles(noAbs)).toHaveLength(0);
  });

  it('decodes XML entities in the abstract', () => {
    const ent = xml.replace('The disease spreads fast.', 'AT&amp;T levels &lt; 5% &amp; rising in the studied population cohort.');
    const [p] = parsePubMedArticles(ent);
    expect(p.abstract).toContain('AT&T levels < 5% & rising');
  });

  it('is empty-safe', () => {
    expect(parsePubMedArticles('')).toEqual([]);
    expect(parsePubMedArticles('<PubmedArticleSet></PubmedArticleSet>')).toEqual([]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { salvageSpecs, fromJsonLd, dedupeRows, rowsToMarkdown, readJsonLdBlocks } from '../spec-salvage';

// The reported case: a motorcycle listing whose spec data lives in div grids.
// Readability keeps the description paragraph and drops the grid, so the
// capture loses the year, mileage and engine size — the only part anyone wanted.

function docFrom(html: string): Document {
  const d = document.implementation.createHTMLDocument('t');
  d.body.innerHTML = html;
  return d;
}

describe('div grids — the shape Readability loses', () => {
  it('recovers repeated two-cell rows', () => {
    const doc = docFrom(`
      <div class="specs">
        <div class="row"><span class="k">Vuosimalli</span><span class="v">2019</span></div>
        <div class="row"><span class="k">Mittarilukema</span><span class="v">12 500 km</span></div>
        <div class="row"><span class="k">Moottori</span><span class="v">649 cm³</span></div>
        <div class="row"><span class="k">Väri</span><span class="v">Musta</span></div>
      </div>`);
    const md = salvageSpecs(doc);
    expect(md).toContain('Vuosimalli');
    expect(md).toContain('12 500 km');
    expect(md).toContain('649 cm³');
  });

  it('recovers a flat CSS-grid sequence with no row wrapper', () => {
    // label,value,label,value as direct siblings — nothing marks a "row".
    const doc = docFrom(`
      <div class="grid">
        <div>Vuosimalli</div><div>2019</div>
        <div>Mittarilukema</div><div>12 500 km</div>
        <div>Moottori</div><div>649 cm³</div>
      </div>`);
    const md = salvageSpecs(doc);
    expect(md).toContain('| Mittarilukema | 12 500 km |');
  });

  it('handles a value split across two cells (value + unit)', () => {
    // Requiring EXACTLY two cells per row missed whole tables: real markup
    // routinely splits "12 500" and "km" into separate elements.
    const doc = docFrom(`
      <div class="specs">
        <div class="row"><span>Mittarilukema</span><span>12 500</span><span>km</span></div>
        <div class="row"><span>Moottori</span><span>645</span><span>cm³</span></div>
        <div class="row"><span>Teho</span><span>49</span><span>kW</span></div>
      </div>`);
    const md = salvageSpecs(doc);
    expect(md).toContain('| Mittarilukema | 12 500 km |');
    expect(md).toContain('| Teho | 49 kW |');
  });

  it('needs at least three pairs — two stray sibling divs are not a spec table', () => {
    const doc = docFrom(`
      <div><div class="row"><span>Label</span><span>Value</span></div>
           <div class="row"><span>Other</span><span>Thing</span></div></div>`);
    expect(salvageSpecs(doc)).toBe('');
  });

  it('ignores navigation, forms and footers', () => {
    const doc = docFrom(`
      <nav>
        <div><span>Home</span><span>Etusivu</span></div>
        <div><span>Cars</span><span>Autot</span></div>
        <div><span>Bikes</span><span>Moottoripyörät</span></div>
      </nav>`);
    expect(salvageSpecs(doc)).toBe('');
  });

  it('does not treat prose paragraphs as cells', () => {
    const doc = docFrom(`
      <div>
        <div><span>Intro</span><span>This is a sentence. And a second one. And a third.</span></div>
        <div><span>More</span><span>Another sentence here. Followed by more text.</span></div>
        <div><span>Yet</span><span>Third block of prose. With several sentences. Really.</span></div>
      </div>`);
    expect(salvageSpecs(doc)).toBe('');
  });
});

describe('real markup from the reported page (nettimoto listing)', () => {
  // Copied from the live page. The spec pairs sit TWO levels down: a layout
  // wrapper holds one .vehicle-info-box, which holds the label and the value.
  // Checking the wrapper's cell count sees ONE child, so the whole table was
  // invisible — that is what unwrap() fixes.
  const REAL = `
    <div class="grid-x cell vehicle-all-info__info-wrap technical-information">
      <div class="grid-x cell vehicle-all-info__details vehicle-all-info__details-odd-even">
        <div class="vehicle-info-box">
          <div class="vehicle-info-box__vehicle-info">Rekisterinumero</div>
          <div class="vehicle-info-box__vehicle-det">
                                  GA-269
                          </div>
        </div>
      </div>
      <div class="grid-x cell vehicle-all-info__details vehicle-all-info__details-odd-even">
        <div class="vehicle-info-box">
          <div class="vehicle-info-box__vehicle-info">Mittarilukema</div>
          <div class="vehicle-info-box__vehicle-det">71 000 km</div>
        </div>
      </div>
      <div class="grid-x cell vehicle-all-info__details vehicle-all-info__details-odd-even">
        <div class="vehicle-info-box">
          <div class="vehicle-info-box__vehicle-info">Moottori</div>
          <div class="vehicle-info-box__vehicle-det">650 cm³, 4-tahti</div>
        </div>
      </div>
      <div class="grid-x cell vehicle-all-info__details vehicle-all-info__details-odd-even">
        <div class="vehicle-info-box">
          <div class="vehicle-info-box__vehicle-info">Vuosimalli</div>
          <div class="vehicle-info-box__vehicle-det">2006</div>
        </div>
      </div>
      <div class="grid-x cell vehicle-all-info__details vehicle-all-info__details-odd-even">
        <div class="vehicle-info-box">
          <div class="vehicle-info-box__vehicle-info">Väri</div>
          <div class="vehicle-info-box__vehicle-det">Sininen</div>
        </div>
      </div>
    </div>`;

  it('recovers the pairs through the layout wrapper', () => {
    const md = salvageSpecs(docFrom(REAL));
    expect(md).toContain('| Mittarilukema | 71 000 km |');
    expect(md).toContain('| Vuosimalli | 2006 |');
    expect(md).toContain('| Moottori | 650 cm³, 4-tahti |');
    expect(md).toContain('| Väri | Sininen |');
  });

  it('collapses the template whitespace around a value', () => {
    // The live page indents values across several lines inside the div.
    expect(salvageSpecs(docFrom(REAL))).toContain('| Rekisterinumero | GA-269 |');
  });
});

describe('definition lists', () => {
  it('pairs dt with dd', () => {
    const doc = docFrom(`
      <dl><dt>Vuosimalli</dt><dd>2019</dd>
          <dt>Moottori</dt><dd>649 cm³</dd>
          <dt>Väri</dt><dd>Musta</dd></dl>`);
    const md = salvageSpecs(doc);
    expect(md).toContain('| Vuosimalli | 2019 |');
    expect(md).toContain('| Väri | Musta |');
  });
});

describe('JSON-LD', () => {
  it('flattens scalar fields from a listing', () => {
    const rows = fromJsonLd([JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product',
      name: 'Kawasaki Z650', modelDate: '2019', color: 'Musta',
      offers: { '@type': 'Offer', price: '5990', priceCurrency: 'EUR' },
    })]);
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r.value]));
    expect(byLabel.name).toBe('Kawasaki Z650');
    expect(byLabel.modelDate).toBe('2019');
    expect(byLabel.price).toBe('5990');   // one level of nesting is followed
  });

  it('survives a malformed block rather than failing the capture', () => {
    expect(() => fromJsonLd(['{not json', '{"a":"b"}'])).not.toThrow();
    expect(fromJsonLd(['{not json', '{"a":"b"}'])).toEqual([{ label: 'a', value: 'b' }]);
  });

  it('is read from the document before scripts are stripped', () => {
    const doc = docFrom(`<script type="application/ld+json">{"a":1}</script>`);
    expect(readJsonLdBlocks(doc)).toEqual(['{"a":1}']);
  });
});

describe('dedupe against what Readability already kept', () => {
  it('drops a row whose label and value are both in the extracted markdown', () => {
    const rows = [{ label: 'Vuosimalli', value: '2019' }, { label: 'Moottori', value: '649 cm³' }];
    const kept = dedupeRows(rows, 'The Vuosimalli is 2019 according to the seller.');
    expect(kept).toEqual([{ label: 'Moottori', value: '649 cm³' }]);
  });

  it('keeps a row when only one half appears — a coincidental word match', () => {
    const rows = [{ label: 'Väri', value: 'Musta' }];
    expect(dedupeRows(rows, 'Väri is discussed but the value is not stated')).toHaveLength(1);
  });

  it('removes exact duplicates found by two different strategies', () => {
    const rows = [{ label: 'A', value: 'B' }, { label: 'a', value: 'b' }];
    expect(dedupeRows(rows)).toHaveLength(1);
  });
});

describe('rowsToMarkdown', () => {
  it('escapes pipes so a cell cannot break the table', () => {
    expect(rowsToMarkdown([{ label: 'A|B', value: 'C|D' }])).toContain('| A\\|B | C\\|D |');
  });

  it('emits nothing for no rows, so nothing is appended', () => {
    expect(rowsToMarkdown([])).toBe('');
  });
});

describe('caps', () => {
  it('bounds the number of rows a pathological page can contribute', () => {
    const cells = Array.from({ length: 400 }, (_, i) => `<div>K${i}</div><div>V${i}</div>`).join('');
    const doc = docFrom(`<div class="grid">${cells}</div>`);
    const md = salvageSpecs(doc, [], { maxRows: 10 });
    expect((md.match(/\n\| /g) || []).length).toBeLessThanOrEqual(12); // 10 rows + header
  });
});

import { describe, it, expect } from 'vitest';
import { buildPageMarkdown, TextBlock } from '../pdf-layout';

const run = (text: string, x: number, y: number, opts: Partial<TextBlock> = {}): TextBlock =>
  ({ text, x, y, width: opts.width ?? text.length * 5, fontSize: opts.fontSize ?? 10, ...opts });

describe('buildPageMarkdown', () => {
  it('joins same-line runs and rebuilds split numeric citations', () => {
    const items = [
      run('long short-term memory [', 100, 700, { width: 200 }),
      run('13', 305, 700, { width: 8 }),
      run('] and gated recurrent [', 315, 700, { width: 90 }),
      run('7', 410, 700, { width: 8 }),
      run('] networks', 418, 700, { width: 50 }),
    ];
    const md = buildPageMarkdown(items, 600);
    expect(md).toContain('[13]');
    expect(md).toContain('[7]');
    expect(md).not.toContain('[ ');
  });

  it('does NOT braid two columns — left column reads before right', () => {
    const items: TextBlock[] = [];
    // 20 left-column lines (x=80) and 20 right-column lines (x=360), same Ys.
    for (let i = 0; i < 20; i++) {
      const y = 700 - i * 12;
      items.push(run(`LEFT${i}`, 80, y, { width: 120 }));   // x+width=200 < mid(300)
      items.push(run(`RIGHT${i}`, 360, y, { width: 120 })); // x=360 > mid+5
    }
    const md = buildPageMarkdown(items, 600);
    // Every LEFT line must appear before every RIGHT line (columns separated).
    const lastLeft = md.lastIndexOf('LEFT19');
    const firstRight = md.indexOf('RIGHT0');
    expect(lastLeft).toBeGreaterThan(-1);
    expect(firstRight).toBeGreaterThan(-1);
    expect(lastLeft).toBeLessThan(firstRight);
  });

  it('drops orphan brackets from citations whose number was lost, keeps [TOKENS]', () => {
    const items = [
      run('a residual connection [', 100, 700, { width: 200 }),
      run('itself needs the [MASK] token', 100, 686, { width: 260 }),
    ];
    const md = buildPageMarkdown(items, 600);
    expect(md).toContain('[MASK]');       // well-formed bracket token preserved
    expect(md).not.toMatch(/\[\s/);       // no orphan "[ "
  });

  it('promotes a large-font short line to a heading', () => {
    // Several body-font lines so the median font size is ~10 (not skewed high).
    const items = [run('Introduction', 100, 700, { fontSize: 16 })];
    for (let i = 0; i < 8; i++) {
      items.push(run(`body line ${i} with enough words to read as a paragraph`, 100, 680 - i * 12, { fontSize: 10, width: 300 }));
    }
    const md = buildPageMarkdown(items, 600);
    expect(md).toMatch(/^#{1,3} Introduction/m);
  });
});

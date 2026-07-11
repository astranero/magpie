import { describe, it, expect } from 'vitest';
import { looksLikeBuildLog, extractLogHighlights } from '../log-highlights';

const AZURE_LOG = `2026-07-11T08:14:02.1Z ##[section]Starting: Build
2026-07-11T08:14:03.2Z Installing dependencies
2026-07-11T08:14:10.5Z added 812 packages in 7s
2026-07-11T08:14:12.0Z ##[warning]Deprecated package left-pad@1.0.0
2026-07-11T08:14:20.9Z > tsc --noEmit
2026-07-11T08:14:25.3Z src/api.ts(42,7): error TS2339: Property 'foo' does not exist
2026-07-11T08:14:25.4Z ##[error]Process completed with exit code 2
2026-07-11T08:14:25.5Z ##[section]Finishing: Build`;

describe('looksLikeBuildLog', () => {
  it('detects Azure Pipelines logs by ##[...] markers', () => {
    expect(looksLikeBuildLog(AZURE_LOG)).toBe(true);
  });

  it('detects generic logs by failure markers + error words', () => {
    const generic = 'x\n'.repeat(50) + 'npm ERR! code ELIFECYCLE\nnpm ERR! Build failed\nexit code 1\n' + 'y\n'.repeat(60);
    expect(looksLikeBuildLog(generic)).toBe(true);
  });

  it('does not flag ordinary articles that merely mention errors', () => {
    const article = 'This long article discusses common error handling patterns in software design. ' +
      'It explains how teams approach failures and what error budgets mean in practice. '.repeat(10);
    expect(looksLikeBuildLog(article)).toBe(false);
  });
});

describe('extractLogHighlights', () => {
  it('extracts error and warning lines with surrounding context, in order', () => {
    const hl = extractLogHighlights(AZURE_LOG, 1);
    expect(hl.errorCount).toBe(2);           // TS error line + ##[error]
    expect(hl.warningCount).toBe(1);
    expect(hl.highlights).toContain("error TS2339");
    expect(hl.highlights).toContain('exit code 2');
    expect(hl.highlights).toContain('##[warning]Deprecated');
    // context line captured around the error
    expect(hl.highlights).toContain('> tsc --noEmit');
  });

  it('errors win the budget over warnings, and truncation is flagged', () => {
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => `##[warning]warn number ${i} ${'pad'.repeat(30)}`),
      '##[error]THE REAL FAILURE: db connection refused'
    ].join('\n');
    const hl = extractLogHighlights(lines, 0, 500);
    expect(hl.highlights).toContain('THE REAL FAILURE');
    expect(hl.truncated).toBe(true);
  });

  it('returns empty highlights for logs with no matches', () => {
    const hl = extractLogHighlights('all good\neverything passed\n');
    expect(hl.highlights).toBe('');
    expect(hl.errorCount).toBe(0);
  });
});

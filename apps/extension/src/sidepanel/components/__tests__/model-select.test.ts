import { describe, it, expect } from 'vitest';
import { filterModelEntries, type ModelEntry } from '../ModelSelect';

// The search behavior every picker shares. Pinned so a future "optimization"
// can't quietly make one picker filter differently from another — divergent
// pickers are the bug this component exists to end.

const CATALOG: ModelEntry[] = [
  { model: 'gpt-4o', group: 'GitHub Copilot' },
  { model: 'gpt-4o-mini', group: 'GitHub Copilot' },
  { model: 'claude-sonnet-4', group: 'GitHub Copilot' },
  { model: 'google/gemini-2.5-pro', group: 'openrouter.ai · your API key' },
  { model: 'google/gemini-2.5-flash', group: 'openrouter.ai · your API key' },
  { model: 'meta-llama/llama-3.3-70b', group: 'openrouter.ai · your API key' },
];

describe('filterModelEntries', () => {
  it('empty query returns the full catalog in order', () => {
    expect(filterModelEntries(CATALOG, '')).toEqual(CATALOG);
    expect(filterModelEntries(CATALOG, '   ')).toEqual(CATALOG);
  });

  it('matches model ids case-insensitively on substrings', () => {
    expect(filterModelEntries(CATALOG, 'GEMINI').map(e => e.model))
      .toEqual(['google/gemini-2.5-pro', 'google/gemini-2.5-flash']);
    expect(filterModelEntries(CATALOG, '4o').map(e => e.model))
      .toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('matches on GROUP too — "copilot" finds that provider\'s models', () => {
    expect(filterModelEntries(CATALOG, 'copilot')).toHaveLength(3);
    expect(filterModelEntries(CATALOG, 'your api key')).toHaveLength(3);
  });

  it('no match returns empty, never throws on regex metacharacters', () => {
    expect(filterModelEntries(CATALOG, 'nonexistent')).toEqual([]);
    expect(filterModelEntries(CATALOG, '(unclosed[')).toEqual([]);
  });
});

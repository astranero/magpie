import { describe, it, expect } from 'vitest';
import { needsIntentResolution, formatHistoryForIntent, parseGitHubRepo, selectTreePaths, formatTreeBlock } from '../query-intent';

describe('needsIntentResolution', () => {
  it('never triggers on the first message of a chat', () => {
    expect(needsIntentResolution('how to use it?', 0)).toBe(false);
  });

  it('triggers on pronoun-dependent follow-ups', () => {
    expect(needsIntentResolution('how to use it?', 4)).toBe(true);
    expect(needsIntentResolution('what is this page about?', 2)).toBe(true);
    expect(needsIntentResolution('where can I find more about the skill', 2)).toBe(true);
  });

  it('triggers on continuation openers and very short questions', () => {
    expect(needsIntentResolution('I mean the skill Pro Max', 2)).toBe(true);
    expect(needsIntentResolution('what about pricing for enterprise customers', 2)).toBe(true);
    expect(needsIntentResolution('prerequisites?', 2)).toBe(true);
  });

  it('skips standalone questions and slash commands', () => {
    expect(needsIntentResolution('what are prerequisites for azure devops pipelines', 4)).toBe(false);
    expect(needsIntentResolution('/research solid state batteries', 4)).toBe(false);
  });
});

describe('formatHistoryForIntent', () => {
  it('keeps the last N turns, truncated per message', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg ${i} ` + 'x'.repeat(500) }));
    const out = formatHistoryForIntent(history, 3, 50);
    expect(out).toContain('msg 7');
    expect(out).not.toContain('msg 6');
    expect(out.split('\n').length).toBe(3);
    expect(out.split('\n')[0].length).toBeLessThanOrEqual('user: '.length + 50);
  });
});

describe('parseGitHubRepo', () => {
  it('parses repo root, subpages, and pinned branches', () => {
    expect(parseGitHubRepo('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar', branch: undefined });
    expect(parseGitHubRepo('https://github.com/foo/bar/issues/12')).toEqual({ owner: 'foo', repo: 'bar', branch: undefined });
    expect(parseGitHubRepo('https://github.com/foo/bar/tree/dev/src')).toEqual({ owner: 'foo', repo: 'bar', branch: 'dev' });
    expect(parseGitHubRepo('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar', branch: undefined });
  });

  it('rejects non-repo GitHub URLs and other hosts', () => {
    expect(parseGitHubRepo('https://github.com/topics/ai')).toBeNull();
    expect(parseGitHubRepo('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseGitHubRepo('https://example.com/github.com/foo/bar')).toBeNull();
  });
});

describe('selectTreePaths', () => {
  it('returns everything for small trees', () => {
    const { selected, truncated } = selectTreePaths(['a.md', 'src/b.ts'], 'anything');
    expect(selected).toEqual(['a.md', 'src/b.ts']);
    expect(truncated).toBe(false);
  });

  it('always includes question-keyword matches when truncating', () => {
    const paths = Array.from({ length: 800 }, (_, i) => `pkg/dir${i}/deeply/nested/file${i}.ts`);
    paths.push('config/agent.json');
    const { selected, truncated } = selectTreePaths(paths, 'where is agent.json', 2000);
    expect(truncated).toBe(true);
    expect(selected).toContain('config/agent.json');
  });

  it('fills remaining budget shallow-first', () => {
    const paths = ['deep/a/b/c/d.ts', 'top.md', 'src/x.ts', ...Array.from({ length: 500 }, (_, i) => `n/e/s/t/${i}.ts`)];
    const { selected } = selectTreePaths(paths, 'unrelated question words', 100);
    expect(selected[0]).toBe('top.md');
  });
});

describe('formatTreeBlock', () => {
  it('renders the fence, paths, and truncation note', () => {
    const block = formatTreeBlock({ owner: 'o', repo: 'r' }, ['a.md', 'src/'], true);
    expect(block).toContain('REPOSITORY FILE TREE (o/r');
    expect(block).toContain('a.md\nsrc/');
    expect(block).toContain('tree truncated');
    expect(block).toContain('does not exist in the repo');
  });
});

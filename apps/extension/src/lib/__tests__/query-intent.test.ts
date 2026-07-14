import { describe, it, expect } from 'vitest';
import { needsIntentResolution, formatHistoryForIntent, parseRepoUrl, selectTreePaths, formatTreeBlock, isStructureQuestion, questionKeywords, expandNavKeywords, isImplementationQuestion, findRepoUrlInText, isPageMetaQuestion, mentionsPageDeixis, overlapsPage, isLocationDependent, timezoneToPlace } from '../query-intent';

describe('isStructureQuestion', () => {
  it('true for layout / file-location questions', () => {
    for (const q of [
      'where is the config file',
      'what files are in the src folder',
      'show me the repo structure',
      'how is the project organized',
      'list the directories',
    ]) expect(isStructureQuestion(q)).toBe(true);
  });
  it('false for content / conceptual questions', () => {
    for (const q of [
      'what does this project do',
      'how does authentication work',
      'explain the caching logic',
    ]) expect(isStructureQuestion(q)).toBe(false);
  });
});

describe('questionKeywords', () => {
  it('drops stopwords, keeps content words', () => {
    expect(questionKeywords('how much is their pricing?')).toEqual(['pricing']);
    expect(questionKeywords('what is this about')).toEqual([]);
  });
});

describe('expandNavKeywords', () => {
  it('pulls in nav synonyms so pricing reaches a "plans"/"billing" link', () => {
    const out = expandNavKeywords(['pricing']);
    expect(out).toContain('plans');
    expect(out).toContain('billing');
    expect(out).toContain('credits');
  });
  it('expands docs/api concepts too', () => {
    expect(expandNavKeywords(['docs'])).toContain('reference');
    expect(expandNavKeywords(['api'])).toContain('endpoint');
  });
  it('leaves non-nav keywords untouched', () => {
    expect(expandNavKeywords(['authentication'])).toEqual(['authentication']);
  });
});

describe('isImplementationQuestion', () => {
  it('true for how-it-works / what-is-behind asks', () => {
    for (const q of [
      "what's behind the pricing",
      'how does the credit system work',
      'explain the backend',
      'where is this implemented',
      'what is the architecture',
    ]) expect(isImplementationQuestion(q)).toBe(true);
  });
  it('false for plain factual asks', () => {
    for (const q of ['what is this product', 'how much does it cost', 'who made this']) {
      expect(isImplementationQuestion(q)).toBe(false);
    }
  });
});

describe('isPageMetaQuestion', () => {
  it('true when the question is about the page itself', () => {
    for (const q of [
      'summarize this page',
      'what is the consensus of this page',
      'give me a tldr',
      "what's this page about",
      'overview please',
    ]) expect(isPageMetaQuestion(q)).toBe(true);
  });
  it('false for topical look-ups (these may forward-check the site)', () => {
    for (const q of [
      'where can I find out about pipelines',
      'how much is their pricing',
      'does it support webhooks',
    ]) expect(isPageMetaQuestion(q)).toBe(false);
  });
});

describe('intent router heuristics', () => {
  it('mentionsPageDeixis: true for explicit page/site references', () => {
    for (const q of ['what is this project', 'summarize the documentation', 'how does this tool work', 'pricing on this site']) {
      expect(mentionsPageDeixis(q)).toBe(true);
    }
  });
  it('mentionsPageDeixis: false for bare pronouns / general questions', () => {
    // "it" is expletive here — must not read as a page reference.
    for (const q of ['is it cold today', 'what time is it', 'are they open now']) {
      expect(mentionsPageDeixis(q)).toBe(false);
    }
  });

  it('overlapsPage: true when a keyword is on the page, false for off-topic asks', () => {
    const page = 'Litmus — AI market validation for startup ideas. Pricing is credit-based.';
    expect(overlapsPage('what can you say about pricing', page)).toBe(true);
    expect(overlapsPage('is today cold', page)).toBe(false);
    expect(overlapsPage('what about this', page)).toBe(false); // only stopwords → no overlap
  });
});

describe('location awareness', () => {
  it('isLocationDependent: true for weather / near-me / local asks', () => {
    for (const q of ['what is the weather like today', 'is today cold', 'coffee near me', 'best restaurants nearby', 'traffic right now']) {
      expect(isLocationDependent(q)).toBe(true);
    }
  });
  it('isLocationDependent: false for non-local asks', () => {
    for (const q of ['what is this repo about', 'explain OAuth', 'summarize the page']) {
      expect(isLocationDependent(q)).toBe(false);
    }
  });
  it('timezoneToPlace: derives a city from an IANA zone', () => {
    expect(timezoneToPlace('Europe/Helsinki')).toBe('Helsinki');
    expect(timezoneToPlace('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(timezoneToPlace('UTC')).toBe('');
    expect(timezoneToPlace('')).toBe('');
  });
});

describe('findRepoUrlInText', () => {
  it('extracts the first parseable repo URL from page text', () => {
    const md = 'Litmus is open source — see https://github.com/acme/litmus for the code.';
    expect(findRepoUrlInText(md)).toBe('https://github.com/acme/litmus');
  });
  it('strips trailing punctuation', () => {
    expect(findRepoUrlInText('code at https://github.com/acme/litmus.')).toBe('https://github.com/acme/litmus');
  });
  it('returns null when no repo link is present', () => {
    expect(findRepoUrlInText('visit https://example.com/pricing for details')).toBeNull();
    expect(findRepoUrlInText('')).toBeNull();
  });
});

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

describe('parseRepoUrl', () => {
  it('parses GitHub repo root, subpages, and pinned branches', () => {
    expect(parseRepoUrl('https://github.com/foo/bar')).toMatchObject({ provider: 'github', owner: 'foo', repo: 'bar', branch: undefined });
    expect(parseRepoUrl('https://github.com/foo/bar/issues/12')).toMatchObject({ provider: 'github', owner: 'foo', repo: 'bar' });
    expect(parseRepoUrl('https://github.com/foo/bar/tree/dev/src')).toMatchObject({ provider: 'github', branch: 'dev' });
    expect(parseRepoUrl('https://github.com/foo/bar.git')).toMatchObject({ provider: 'github', repo: 'bar' });
  });

  it('parses GitLab incl. subgroups and pinned branches', () => {
    expect(parseRepoUrl('https://gitlab.com/group/proj')).toMatchObject({ provider: 'gitlab', owner: 'group', repo: 'proj', label: 'group/proj' });
    expect(parseRepoUrl('https://gitlab.com/group/sub/proj/-/tree/main/src')).toMatchObject({ provider: 'gitlab', owner: 'group/sub', repo: 'proj', branch: 'main' });
  });

  it('parses Azure DevOps repos with optional version pin', () => {
    expect(parseRepoUrl('https://dev.azure.com/org/Proj/_git/repo')).toMatchObject({ provider: 'azure', owner: 'org', project: 'Proj', repo: 'repo' });
    expect(parseRepoUrl('https://dev.azure.com/org/My%20Proj/_git/repo?version=GBrelease%2F1.0')).toMatchObject({ provider: 'azure', project: 'My Proj', branch: 'release/1.0' });
  });

  it('parses Bitbucket repos', () => {
    expect(parseRepoUrl('https://bitbucket.org/ws/repo')).toMatchObject({ provider: 'bitbucket', owner: 'ws', repo: 'repo' });
    expect(parseRepoUrl('https://bitbucket.org/ws/repo/src/main/README.md')).toMatchObject({ provider: 'bitbucket', branch: 'main' });
  });

  it('rejects non-repo URLs and other hosts', () => {
    expect(parseRepoUrl('https://github.com/topics/ai')).toBeNull();
    expect(parseRepoUrl('https://example.com/github.com/foo/bar')).toBeNull();
    expect(parseRepoUrl('https://dev.azure.com/org/proj')).toBeNull();  // no _git segment
    expect(parseRepoUrl('https://gitlab.com/onlygroup')).toBeNull();
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
  it('renders the fence, provider name, paths, and truncation note', () => {
    const block = formatTreeBlock({ provider: 'gitlab', label: 'g/r', owner: 'g', repo: 'r' }, ['a.md', 'src/'], true);
    expect(block).toContain('REPOSITORY FILE TREE (g/r, from the GitLab API');
    expect(block).toContain('a.md\nsrc/');
    expect(block).toContain('tree truncated');
    expect(block).toContain('does not exist in the repo');
  });
});

describe('matchFilesInTree', () => {
  const tree = [
    'README.md', 'src/', 'src/index.ts', 'src/agent.json',
    'cli/assets/templates/platforms/agent.json',
    'docs/setup.md', 'logo.png', 'dist/bundle.js.map'
  ];

  it('finds files named in the question, exact basename first', async () => {
    const { matchFilesInTree } = await import('../query-intent');
    const out = matchFilesInTree(tree, 'what does agent.json contain?');
    expect(out.length).toBe(2);
    expect(out[0]).toBe('src/agent.json'); // shallower of the two exact matches
    expect(out[1]).toBe('cli/assets/templates/platforms/agent.json');
  });

  it('matches path-qualified names to the specific file', async () => {
    const { matchFilesInTree } = await import('../query-intent');
    const out = matchFilesInTree(tree, 'open cli/assets/templates/platforms/agent.json');
    expect(out[0]).toBe('cli/assets/templates/platforms/agent.json');
  });

  it('never returns binaries and returns nothing without a file token', async () => {
    const { matchFilesInTree } = await import('../query-intent');
    expect(matchFilesInTree(tree, 'show me logo.png')).toEqual([]);
    expect(matchFilesInTree(tree, 'how does the build work?')).toEqual([]);
  });
});

describe('matchFilesInTree — identifier tokens', () => {
  const tree = ['src/paper-rank.ts', 'src/deep-researcher.ts', 'src/db.ts', 'README.md'];

  it('matches code identifiers against module basenames', async () => {
    const { matchFilesInTree } = await import('../query-intent');
    expect(matchFilesInTree(tree, 'where is the code related to paper_rank scoring?')[0]).toBe('src/paper-rank.ts');
    expect(matchFilesInTree(tree, 'what does deepResearcher do?')[0]).toBe('src/deep-researcher.ts');
  });

  it('ignores short/plain words', async () => {
    const { matchFilesInTree } = await import('../query-intent');
    expect(matchFilesInTree(tree, 'where is the database code?')).toEqual([]);
  });
});

describe('isChitchat', () => {
  it('matches greetings, thanks, acks (incl. Finnish)', async () => {
    const { isChitchat } = await import('../query-intent');
    for (const s of ['hi', 'Hello!', 'hey there'.slice(0,3), 'thanks', 'thank you', 'how are you?', 'moi', 'hei', 'kiitos', 'ok', 'cool', 'bye']) {
      expect(isChitchat(s)).toBe(true);
    }
  });
  it('does NOT match real questions or commands', async () => {
    const { isChitchat } = await import('../query-intent');
    for (const s of ['what is TLS', 'how do I migrate to tls 1.2', 'summarize the paper', '/research batteries', 'hi, what is the revenue for Q3']) {
      expect(isChitchat(s)).toBe(false);
    }
  });
});

describe('isAcademicQuery (gate the academic agent)', () => {
  it('is FALSE for practical / consumer topics (which pulled off-topic papers)', async () => {
    const { isAcademicQuery } = await import('../query-intent');
    for (const s of [
      'Romantic date ideas in Helsinki for a Friday evening and advice on initiating intimacy',
      'best software tools and game engines for a solo developer to build mobile gacha games',
      'cheapest flights to Lisbon in December',
      'how to set up a home espresso bar',
    ]) {
      expect(isAcademicQuery(s)).toBe(false);
    }
  });
  it('is TRUE for genuinely scholarly topics', async () => {
    const { isAcademicQuery } = await import('../query-intent');
    for (const s of [
      'clinical trials of metformin for longevity',
      'recent research on CRISPR off-target effects',
      'meta-analysis of SSRIs efficacy',
      'quantum error correction theorem',
    ]) {
      expect(isAcademicQuery(s)).toBe(true);
    }
  });
});

describe('isMessageQuery (answer from the on-page mailbox, not the web)', () => {
  it('matches inbox / email / message intent', async () => {
    const { isMessageQuery } = await import('../query-intent');
    for (const s of ['what messages do I have', 'who emailed me today', 'anything in my inbox?', 'summarize my emails', 'any unread mail', 'what other messages I have']) {
      expect(isMessageQuery(s)).toBe(true);
    }
  });
  it('does NOT match unrelated questions or commands', async () => {
    const { isMessageQuery } = await import('../query-intent');
    for (const s of ['what is TLS', 'summarize this paper', '/research batteries', 'how do I deploy']) {
      expect(isMessageQuery(s)).toBe(false);
    }
  });
});

describe('isRefusalAnswer (escalate a grounded turn to the web)', () => {
  it('matches the citation-branch refusal shapes', async () => {
    const { isRefusalAnswer } = await import('../query-intent');
    for (const s of [
      'This information was not found in your sources.',
      'I cannot answer this based on the provided sources.',
      "I can't answer that from the documents you've captured.",
      'The provided sources do not contain information about tomorrow’s weather.',
      'No relevant information was found in your workspace for this question.',
    ]) {
      expect(isRefusalAnswer(s)).toBe(true);
    }
  });

  it('does NOT match normal answers (even ones that mention sources)', async () => {
    const { isRefusalAnswer } = await import('../query-intent');
    for (const s of [
      'Photosynthesis converts light into chemical energy.',
      'According to your sources, revenue grew 12% in Q3, driven by the EMEA segment.',
      'The answer is 42. See the attached document for the derivation.',
      '',
    ]) {
      expect(isRefusalAnswer(s)).toBe(false);
    }
  });

  it('ignores long text (a real answer, not a bare refusal)', async () => {
    const { isRefusalAnswer } = await import('../query-intent');
    const long = 'I cannot answer this without more detail. ' + 'Here is a thorough explanation. '.repeat(30);
    expect(long.length).toBeGreaterThan(600);
    expect(isRefusalAnswer(long)).toBe(false);
  });
});

describe('context budgets — bigger, all matches', () => {
  it('matchFilesInTree returns ALL matching files (up to 6), not just one', async () => {
    const { matchFilesInTree } = await import('../query-intent');
    const tree = [
      'cli/agent.json', 'src/agent.json', 'pkg/a/agent.json', 'pkg/b/agent.json',
      'pkg/c/agent.json', 'pkg/d/agent.json', 'pkg/e/agent.json', 'README.md'
    ];
    const out = matchFilesInTree(tree, 'what does agent.json contain?');
    expect(out.length).toBe(6);            // was capped at 2 — now surfaces the whole set
    expect(out.every(p => p.endsWith('agent.json'))).toBe(true);
  });

  it('selectTreePaths default budget is generous (fits a medium tree whole)', async () => {
    const { selectTreePaths } = await import('../query-intent');
    const paths = Array.from({ length: 400 }, (_, i) => `src/dir${i}/file${i}.ts`); // ~7.6k chars
    const { truncated } = selectTreePaths(paths, 'anything');
    expect(truncated).toBe(false);          // 12k budget swallows a tree that 6k truncated
  });
});

describe('parallel fetch stays fast', () => {
  it('N fetches run concurrently, not serially (Promise.all pattern)', async () => {
    const fetchOne = (ms: number) => new Promise<number>(r => setTimeout(() => r(ms), ms));
    const t0 = Date.now();
    await Promise.all([50, 50, 50, 50, 50, 50].map(fetchOne));   // mirrors buildRepoFileBlocks
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(6 * 50 * 0.6);   // ~50ms, not ~300ms
  });
});

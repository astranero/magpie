import { describe, it, expect } from 'vitest';
import { isSyncEligible } from '../db';
import { contentHasTag } from '../frontmatter';

// isSyncEligible is the one rule shared by "what Force Resync uploads" and the
// "N pending" the status panel shows. If it drifts, the number contradicts the
// button beside it. It runs on real document content through the real
// frontmatter parser, so these are the actual stored shapes.

const researchSource = `---
title: Scraped page
tags:
  - research-source
  - web
---
body text`;

const userDoc = `---
title: My clipping
tags:
  - clip
---
body text`;

const noFrontmatter = 'Just some markdown with no frontmatter at all.';

// Guard the fixtures themselves, so a parser change that silently stops seeing
// the tag can't make the eligibility tests pass for the wrong reason.
describe('fixtures', () => {
  it('the research source really carries the research-source tag', () => {
    expect(contentHasTag(researchSource, 'research-source')).toBe(true);
    expect(contentHasTag(userDoc, 'research-source')).toBe(false);
  });
});

describe('isSyncEligible', () => {
  it('excludes a research source by default', () => {
    expect(isSyncEligible({ content: researchSource }, false)).toBe(false);
  });

  it('includes a research source when the user opted to sync them', () => {
    expect(isSyncEligible({ content: researchSource }, true)).toBe(true);
  });

  it('always includes a normal user document', () => {
    expect(isSyncEligible({ content: userDoc }, false)).toBe(true);
    expect(isSyncEligible({ content: userDoc }, true)).toBe(true);
  });

  it('includes a document with no frontmatter — it cannot be a machine source', () => {
    expect(isSyncEligible({ content: noFrontmatter }, false)).toBe(true);
  });

  it('is safe on empty or missing content', () => {
    expect(isSyncEligible({ content: '' }, false)).toBe(true);
    expect(isSyncEligible({ content: undefined as unknown as string }, false)).toBe(true);
  });
});

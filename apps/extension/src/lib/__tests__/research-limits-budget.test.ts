// ─────────────────────────────────────────────
// Memory budget guard: research depth caps stay bounded
// ─────────────────────────────────────────────
// Every OOM in this project traces back to unbounded work: too many sources
// indexed, a retrieval pool bigger than the session store can hold, too many
// stages ratcheting the shared offscreen heap. The depth tiers are the single
// place those bounds are set. This test pins them so a well-meaning "let's fetch
// more" bump can't silently reintroduce a crash — if you raise a cap past budget,
// this fails and makes you prove the memory headroom first.

import { describe, expect, it } from 'vitest';
import { RESEARCH_LIMITS, type ResearchDepth } from '../research-limits';

// Mirrors MAX_SESSION_CHUNKS in vector-store.ts — the in-memory session index
// cap. A retrieval pool larger than this just truncates silently (worse reports)
// and pushes heap. Kept as a literal on purpose: if the store cap moves, this
// number should be revisited deliberately, not tracked blindly.
const MAX_SESSION_CHUNKS = 2000;
const TIERS: ResearchDepth[] = ['standard', 'deep', 'exhaustive'];

describe('research depth memory budget', () => {
  it('retrieval pool never exceeds the session store capacity', () => {
    for (const t of TIERS) {
      expect(RESEARCH_LIMITS[t].chunkPoolCap).toBeLessThanOrEqual(MAX_SESSION_CHUNKS);
    }
  });

  it('total sources per run stays well under the ONNX crash threshold (~400 papers)', () => {
    for (const t of TIERS) {
      expect(RESEARCH_LIMITS[t].totalSourcesCap).toBeGreaterThan(0);
      expect(RESEARCH_LIMITS[t].totalSourcesCap).toBeLessThanOrEqual(300);
    }
  });

  it('stage count is bounded (each stage ratchets the shared offscreen heap)', () => {
    for (const t of TIERS) {
      expect(RESEARCH_LIMITS[t].rounds).toBeGreaterThan(0);
      expect(RESEARCH_LIMITS[t].rounds).toBeLessThanOrEqual(12);
    }
  });

  it('all discovery limits are non-negative and finite', () => {
    for (const t of TIERS) {
      for (const [k, v] of Object.entries(RESEARCH_LIMITS[t])) {
        expect(Number.isFinite(v), `${t}.${k}`).toBe(true);
        expect(v, `${t}.${k}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('caps scale monotonically standard ≤ deep ≤ exhaustive (no tier out-of-order)', () => {
    const keys = Object.keys(RESEARCH_LIMITS.standard) as (keyof typeof RESEARCH_LIMITS.standard)[];
    for (const k of keys) {
      expect(RESEARCH_LIMITS.standard[k], `${k} standard≤deep`).toBeLessThanOrEqual(RESEARCH_LIMITS.deep[k]);
      expect(RESEARCH_LIMITS.deep[k], `${k} deep≤exhaustive`).toBeLessThanOrEqual(RESEARCH_LIMITS.exhaustive[k]);
    }
  });
});

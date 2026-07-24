import { describe, it, expect } from 'vitest';
import { looksLikeDebugPage, looksLikeBuildLog, extractLogHighlights } from '../log-highlights';

// ─────────────────────────────────────────────
// Debug-page detection — one fixture per page family
// ─────────────────────────────────────────────
// The router sends debug-looking pages to the root-cause prompt and everything
// else to the reading prompt. A missed family silently downgrades debugging to
// "gentle reading"; a false positive interrogates a news article. Fixtures are
// realistic excerpts, padded to clear the 200-char floor the detector applies.

const pad = (s: string) => s + '\n' + 'Routine log line without any signal here.\n'.repeat(10);

// ── CI systems ──
const AZURE = pad(`2026-07-22T10:14:03.1234567Z ##[section]Starting: Run Unit Tests
2026-07-22T10:14:09.7654321Z ##[error]Process completed with exit code 1.
2026-07-22T10:14:09.7654321Z ##[warning]Retrying flaky step`);

const GITHUB_ACTIONS = pad(`Run npm test
npm warn using --force
::error file=src/index.ts,line=10::Type 'string' is not assignable
::group::Post job cleanup
Error: Process completed with exit code 1.`);

const GITLAB_CI = pad(`Running with gitlab-runner 17.3.0
section_start:1721638800:build_script
$ npm run build
section_end:1721638900:build_script
ERROR: Job failed: exit code 1`);

const JENKINS = pad(`[Pipeline] stage
[Pipeline] { (Build)
[Pipeline] sh
+ make all
make: *** [Makefile:12: all] Error 2
[Pipeline] }
ERROR: script returned exit code 2
Finished: FAILURE`);

const CIRCLECI = pad(`#!/bin/bash -eo pipefail
npm run lint
/bin/bash: line 1: eslint: command not found

Exited with code exit status 127
CircleCI received exit code 127`);

const DOCKER_BUILD = pad(`#7 [stage-1 3/7] RUN npm ci
#7 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
------
 > [stage-1 3/7] RUN npm ci:
ERROR: failed to solve: executor failed running`);

// ── Test runners ──
const VITEST = pad(`❯ src/lib/__tests__/chunker.test.ts (12 tests | 1 failed) 43ms
   × chunker > splits sections
     → expected 3 to be 4 // Object.is equality
 Test Files  1 failed | 11 passed (12)
      Tests  1 failed | 44 passed (45)`);

const PYTEST = pad(`=================================== FAILURES ===================================
______________________________ test_chunk_anchors ______________________________
    def test_chunk_anchors():
>       assert make_anchor(doc) == "d1.s0.p0"
E       AssertionError: assert 'd1.s0.p1' == 'd1.s0.p0'
tests/test_chunker.py:14: AssertionError
=========================== short test summary info ============================
FAILED tests/test_chunker.py::test_chunk_anchors - AssertionError`);

const GO_TEST = pad(`--- FAIL: TestChunkAnchors (0.03s)
    chunker_test.go:21: got d1.s0.p1, want d1.s0.p0
FAIL
FAIL\tgithub.com/acme/chunker\t0.041s
ok  \tgithub.com/acme/parser\t0.012s`);

// ── Language stack traces / crashes ──
const PYTHON_TRACEBACK = pad(`Traceback (most recent call last):
  File "/app/main.py", line 42, in <module>
    run(cfg)
  File "/app/runner.py", line 17, in run
    parse(doc)
ValueError: unsupported document type: pdf`);

const JAVA_STACK = pad(`Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()"
\tat com.acme.chunker.Anchor.make(Anchor.java:42)
\tat com.acme.chunker.Main.run(Main.java:17)
\tat com.acme.chunker.Main.main(Main.java:9)`);

const GO_PANIC = pad(`panic: runtime error: index out of range [3] with length 3

goroutine 1 [running]:
main.makeAnchor(...)
\t/app/main.go:42 +0x1d
main.main()
\t/app/main.go:17 +0x9c
exit status 2`);

const RUST_PANIC = pad(`thread 'main' panicked at src/main.rs:42:18:
index out of bounds: the len is 3 but the index is 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`);

const CSHARP_STACK = pad(`Unhandled exception. System.NullReferenceException: Object reference not set to an instance of an object.
   at Acme.Chunker.Anchor.Make(Document doc) in C:\\app\\Anchor.cs:line 42
   at Acme.Chunker.Program.Main(String[] args) in C:\\app\\Program.cs:line 17`);

const BROWSER_CONSOLE = pad(`Uncaught TypeError: Cannot read properties of undefined (reading 'local')
    at initStorage (chrome-extension://abc/offscreen.js:79:12)
    at chrome-extension://abc/offscreen.js:102:5
offscreen.html:1 Unchecked runtime.lastError: No SW`);

const NODE_ERROR = pad(`node:internal/modules/cjs/loader:1080
  throw err;
  ^
Error: Cannot find module 'linkedom'
Require stack:
- /app/src/parse.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1077:15)
npm ERR! code ELIFECYCLE`);

// ── Infra ──
const KERNEL_LOG = pad(`[12345.678901] python3[4211]: segfault at 0 ip 00007f3a error 4 in libc.so.6
[12345.678902] Out of memory: Killed process 4211 (python3) total-vm:2097152kB
[12345.678903] oom_reaper: reaped process 4211`);

const K8S_EVENTS = pad(`  Warning  BackOff     2m (x8 over 5m)  kubelet  Back-off restarting failed container app in pod web-7f9
  Warning  FailedScheduling  4m  default-scheduler  0/3 nodes are available: insufficient memory
  Normal   Pulled      5m  kubelet  Container image "app:1.2" already present
CrashLoopBackOff`);

const SYSTEMD = pad(`Jul 22 10:14:03 host systemd[1]: Starting Magpie companion...
Jul 22 10:14:04 host companion[912]: Error: listen EADDRINUSE: address already in use :::3920
Jul 22 10:14:04 host systemd[1]: companion.service: Main process exited, code=exited, status=1/FAILURE
Jul 22 10:14:04 host systemd[1]: Failed to start Magpie companion.`);

const SENTRY_ISSUE = pad(`TypeError: Cannot read properties of undefined (reading 'chunks')
apps/extension/src/background/service-worker.ts in handleSearchLibrary at line 96
Event ID abc123 · Seen 41 times in the last 24 hours · Affects 12 users
Breadcrumbs:
  fetch  GET /api/models  200
  console  [RAG] Initial search returned 0 chunks
  exception  TypeError: Cannot read properties of undefined`);

// ── Negatives: pages that MENTION errors but are not debuggable output ──
const NEWS_ARTICLE = pad(`The city council approved the new transit plan on Tuesday after months of
debate. Supporters argued the expanded network would reduce congestion, while
critics questioned the projected ridership numbers. Construction is expected
to begin next spring and continue for three years, with the first line opening
to the public in 2029. Funding comes from a mix of federal grants and bonds.
The mayor called the vote a milestone for the region's infrastructure.
Officials cautioned that timelines could shift if material costs rise again.
Community meetings will continue through the autumn to gather feedback.
Local businesses along the corridor expressed cautious optimism about access.
The transit authority will publish quarterly progress reports on its website.`);

const ERROR_HANDLING_DOCS = pad(`# Error handling guide

Well-designed APIs distinguish recoverable conditions from programming bugs.
Prefer returning typed results for expected conditions and reserve thrown
exceptions for invariant violations. Document which category each function
falls into so callers know whether to branch or to crash loudly. When wrapping
a lower-level failure, preserve the original cause so operators can trace it.
Log at the boundary, not at every level, to avoid duplicate noise in dashboards.
Retries belong at the outermost layer that understands idempotency; blind
retry loops deeper in the stack multiply load during incidents. Timeouts
should be explicit parameters rather than hidden constants inside helpers.`);

const README_PAGE = pad(`# Magpie

A research assistant browser extension. Capture pages, chat with your library,
and run deep research with real citations. Install from the store or load the
unpacked build. Configuration lives in the side panel under Config. The model
picker supports both GitHub Copilot and any OpenAI-compatible endpoint. Data
stays local in IndexedDB; optional Drive sync mirrors documents as markdown.
Contributions welcome — see CONTRIBUTING.md for the development setup, test
commands, and the pull-request checklist. Licensed under MIT.`);

const CHANGELOG = pad(`## 1.4.0
- Added searchable model picker with provider groups
- Fixed citation chips to jump to saved source chunks
- Improved report code formatting rules
## 1.3.2
- Fixed a race in provider coexistence storage
- Reduced memory usage during PDF parsing
## 1.3.1
- Per-tab session scoping for the side panel`);

const POSITIVES: Array<[string, string]> = [
  ['Azure Pipelines', AZURE], ['GitHub Actions', GITHUB_ACTIONS], ['GitLab CI', GITLAB_CI],
  ['Jenkins', JENKINS], ['CircleCI', CIRCLECI], ['docker build', DOCKER_BUILD],
  ['vitest', VITEST], ['pytest', PYTEST], ['go test', GO_TEST],
  ['python traceback', PYTHON_TRACEBACK], ['java stack', JAVA_STACK], ['go panic', GO_PANIC],
  ['rust panic', RUST_PANIC], ['c# stack', CSHARP_STACK], ['browser console', BROWSER_CONSOLE],
  ['node error', NODE_ERROR], ['kernel log', KERNEL_LOG], ['k8s events', K8S_EVENTS],
  ['systemd journal', SYSTEMD], ['sentry issue', SENTRY_ISSUE],
];

const NEGATIVES: Array<[string, string]> = [
  ['news article', NEWS_ARTICLE], ['error-handling docs', ERROR_HANDLING_DOCS],
  ['readme', README_PAGE], ['changelog', CHANGELOG],
];

describe('looksLikeDebugPage — coverage per family', () => {
  for (const [name, fixture] of POSITIVES) {
    it(`recognizes: ${name}`, () => {
      expect(looksLikeDebugPage(fixture)).toBe(true);
    });
  }
  for (const [name, fixture] of NEGATIVES) {
    it(`rejects: ${name}`, () => {
      expect(looksLikeDebugPage(fixture)).toBe(false);
    });
  }

  it('tail-only failure is still caught (long logs fail at the END)', () => {
    const quiet = 'Installing dependency tree, step OK.\n'.repeat(1500);
    const failing = quiet + '\nnpm ERR! code ELIFECYCLE\nnpm ERR! Exit status 1\nBUILD FAILED\nerror: task returned non-zero exit code';
    expect(looksLikeDebugPage(failing)).toBe(true);
  });
});

describe('performance', () => {
  it('detector stays fast on a multi-MB log (single sampled pass)', () => {
    const big = ('2026-07-22T10:14:03.123Z step output line with routine content\n'.repeat(40_000))
      + '##[error]Process completed with exit code 1.\n';
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) looksLikeDebugPage(big);
    const perCall = (performance.now() - t0) / 20;
    expect(perCall, `detector took ${perCall.toFixed(1)}ms/call`).toBeLessThan(15);
  });

  it('extractLogHighlights is not quadratic in error count', () => {
    const noisy = Array.from({ length: 4000 }, (_, i) => `##[error]step ${i} failed with exit code 1`).join('\n');
    const t0 = performance.now();
    const r = extractLogHighlights(noisy);
    const ms = performance.now() - t0;
    expect(r.errorCount).toBe(4000);
    expect(r.truncated).toBe(true);
    expect(ms, `extractLogHighlights took ${ms.toFixed(0)}ms`).toBeLessThan(100);
  });
});

describe('looksLikeBuildLog stays a strict subset', () => {
  it('build logs are debug pages; prose is neither', () => {
    expect(looksLikeBuildLog(AZURE)).toBe(true);
    expect(looksLikeDebugPage(AZURE)).toBe(true);
    expect(looksLikeBuildLog(NEWS_ARTICLE)).toBe(false);
  });
});

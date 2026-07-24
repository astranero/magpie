// ─────────────────────────────────────────────
// Build/pipeline log highlights (pure)
// ─────────────────────────────────────────────
// CI log pages (Azure Pipelines, GitHub Actions, GitLab CI, Jenkins…) are
// huge and repetitive; the diagnostic signal is a handful of error/warning
// lines. Embedding-based page retrieval can miss them — these helpers
// detect log-like content and extract the failure lines (with surrounding
// context) deterministically, so "what failed and why?" always has the
// actual error text in front of the model.

const AZURE_MARKER_RE = /##\[(?:error|warning|section|command|debug)\]|::(?:error|warning|group)[ :,]/;
const TIMESTAMP_LINE_RE = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const GENERIC_LOG_RE = /\b(exit code \d+|exit status \d+|npm ERR!|Traceback \(most recent call last\)|FAILED|BUILD FAILED|fatal error|##vso\[|section_(?:start|end):\d+|\[Pipeline\]|Exited with code)/i;

// Test output markers — vitest, jest, pytest, go test, etc.
const TEST_FAILURE_RE = /\b(FAIL|PASS|Tests:|Test Suites:|×|✓|✗|✖|expected|received|toBe|toEqual|AssertionError|assert\b|--- FAIL:)/i;

// One hit of any of these IS a debuggable page — they are failure output by
// construction and essentially never occur in prose. Grouped by family:
//   crashes/tracebacks · CI failure verdicts · infra failure states
const CRASH_MARKER_RE = new RegExp([
  // Language crashes and tracebacks
  'Traceback \\(most recent call last\\)',
  "thread '[^']*' panicked",
  'RUST_BACKTRACE',
  'panic: ',
  'goroutine \\d+ \\[',
  'Exception in thread "',
  'Unhandled exception',
  'Uncaught (?:Type|Reference|Range|Syntax)?Error',
  '(?:Type|Reference|Range|Syntax)Error: ',
  'Segmentation fault',
  '\\(core dumped\\)',
  'segfault at ',
  'Out of memory: Killed process',
  'oom-killer|oom_reaper',
  'Call Trace:',
  'Unchecked runtime\\.lastError',
  // CI / build failure verdicts
  'npm ERR!',
  '##\\[error\\]',
  '::error[ :,]',
  'ERROR: Job failed',
  'Finished: FAILURE',
  'BUILD FAILED',
  'command not found',
  'Exited with code',
  'executor failed running',
  'did not complete successfully',
  'Process completed with exit code [1-9]',
  'exit status [1-9]',
  // Infra failure states
  'CrashLoopBackOff',
  'Back-off restarting failed container',
  'FailedScheduling',
  'status=[1-9]\\d*/FAILURE',
  'Failed to start ',
  'EADDRINUSE|ECONNREFUSED|ELIFECYCLE|ENOENT',
].join('|'));

// A stack FRAME line, any mainstream runtime. Two or more = debug page.
//   JS/browser/node:  at fn (file.js:10:5)   |   at file.js:10:5
//   Java:             at com.acme.Cls.m(Cls.java:42)
//   C#:               at Ns.Cls.M() in C:\\app\\File.cs:line 42
//   Python:           File "/app/main.py", line 42, in run
//   Go:               /app/main.go:42 +0x1d
const STACK_LINE_RE = new RegExp([
  '^\\s+at .+\\(.*:\\d+(?::\\d+)?\\)\\s*$',
  '^\\s+at .+:\\d+:\\d+\\s*$',
  '^\\s+at .+ in .+:line \\d+',
  '^\\s*File "[^"]+", line \\d+',
  '^\\s*\\S+\\.go:\\d+ \\+0x',
].join('|'))
const ERROR_KEYWORD_RE = /\b(error|failed|failure|exception|crash|timeout|uncaught)\b/i;

/**
 * Sample a page for scanning: the head plus the tail. CI logs put the verdict
 * at the END (a 40k-line install log fails on the last 5 lines), so a
 * head-only sample misses exactly the pages this detector exists for — and
 * scanning every line of multi-MB logs on the chat hot path is wasted work.
 */
function sampleForScan(text: string): { lines: string[]; sampled: boolean } {
  const lines = text.split('\n');
  const HEAD = 500, TAIL = 200;
  if (lines.length <= HEAD + TAIL) return { lines, sampled: false };
  return { lines: [...lines.slice(0, HEAD), ...lines.slice(-TAIL)], sampled: true };
}

/** True when the text reads like a CI/build/terminal log, not an article. */
export function looksLikeBuildLog(text: string): boolean {
  const t = text || '';
  if (t.length < 200) return false;
  if (AZURE_MARKER_RE.test(t)) return true;

  const { lines } = sampleForScan(t);
  let timestamped = 0;
  const cap = Math.min(lines.length, 400);
  for (let i = 0; i < cap; i++) if (TIMESTAMP_LINE_RE.test(lines[i])) timestamped++;
  if (timestamped >= Math.max(10, cap * 0.3)) return true;

  return GENERIC_LOG_RE.test(t) && /\b(error|failed|failure)\b/i.test(t);
}

/**
 * Detect if a page is a "debuggable" page — CI logs, test failures, error
 * reports, crash dumps, or any page with stack traces. These warrant a
 * thorough debugger-style analysis vs generic page reading.
 *
 * ONE sampled pass over head+tail lines, cheapest checks first, early exit on
 * any single-hit crash marker. Density heuristics run off the same pass.
 */
export function looksLikeDebugPage(text: string): boolean {
  const t = text || '';
  if (t.length < 200) return false;

  // Single-hit markers: failure output by construction. Full-text test (regex
  // scan, no split) so a marker buried mid-file still hits.
  if (CRASH_MARKER_RE.test(t)) return true;
  if (looksLikeBuildLog(t)) return true;

  const { lines } = sampleForScan(t);
  let testLines = 0, stackLines = 0, errorLines = 0, tableRows = 0;
  for (const l of lines) {
    if (STACK_LINE_RE.test(l) && ++stackLines >= 2) return true;
    if (TEST_FAILURE_RE.test(l)) testLines++;
    if (ERROR_KEYWORD_RE.test(l)) errorLines++;
    if (l.charCodeAt(0) === 124 && /^\|.*\|.*\|/.test(l)) tableRows++;
  }

  if (testLines >= 3 && testLines >= lines.length * 0.05) return true;
  if (errorLines >= Math.max(5, lines.length * 0.1)) return true;
  if (tableRows >= 10 && (testLines > 0 || errorLines > 0)) return true;
  return false;
}

const ERROR_LINE_RE = /##\[error\]|\berror\b[:\s]|npm ERR!|\bfatal\b|\bFAILED\b|\bfailure\b|exception\b|traceback|exit code [1-9]|✗|✖/i;
const WARNING_LINE_RE = /##\[warning\]|\bwarn(?:ing)?\b[:\s]/i;

export interface LogHighlights {
  highlights: string;
  errorCount: number;
  warningCount: number;
  truncated: boolean;
}

/**
 * Extract error/warning lines with ±context lines, merged into blocks and
 * capped by budget. Errors are collected first so warnings can never crowd
 * them out of the budget.
 */
export function extractLogHighlights(text: string, contextLines = 2, budget = 4_000): LogHighlights {
  const lines = (text || '').split('\n');
  const errorIdx: number[] = [];
  const warnIdx: number[] = [];
  lines.forEach((l, i) => {
    if (ERROR_LINE_RE.test(l)) errorIdx.push(i);
    else if (WARNING_LINE_RE.test(l)) warnIdx.push(i);
  });

  const include = new Set<number>();
  let truncated = false;
  const addWithContext = (idx: number[]) => {
    for (const i of idx) {
      const block: number[] = [];
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) block.push(j);
      const cost = block.reduce((n, j) => include.has(j) ? n : n + lines[j].length + 1, 0);
      const used = [...include].reduce((n, j) => n + lines[j].length + 1, 0);
      if (used + cost > budget) { truncated = true; break; }
      block.forEach(j => include.add(j));
    }
  };
  addWithContext(errorIdx);
  addWithContext(warnIdx);

  if (include.size === 0) {
    return { highlights: '', errorCount: 0, warningCount: 0, truncated: false };
  }

  // Emit in file order, with elision markers between non-adjacent blocks
  const sorted = [...include].sort((a, b) => a - b);
  let out = '';
  let last = -2;
  for (const i of sorted) {
    if (last >= 0 && i > last + 1) out += '\n[…]\n';
    out += lines[i] + '\n';
    last = i;
  }
  if (truncated) out += '\n[… more matches beyond the highlight budget]';

  return {
    highlights: out.trim(),
    errorCount: errorIdx.length,
    warningCount: warnIdx.length,
    truncated
  };
}

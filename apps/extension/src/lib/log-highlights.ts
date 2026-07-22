// ─────────────────────────────────────────────
// Build/pipeline log highlights (pure)
// ─────────────────────────────────────────────
// CI log pages (Azure Pipelines, GitHub Actions, GitLab CI, Jenkins…) are
// huge and repetitive; the diagnostic signal is a handful of error/warning
// lines. Embedding-based page retrieval can miss them — these helpers
// detect log-like content and extract the failure lines (with surrounding
// context) deterministically, so "what failed and why?" always has the
// actual error text in front of the model.

const AZURE_MARKER_RE = /##\[(?:error|warning|section|command|debug)\]/;
const TIMESTAMP_LINE_RE = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const GENERIC_LOG_RE = /\b(exit code \d+|npm ERR!|Traceback \(most recent call last\)|FAILED|BUILD FAILED|fatal error|##vso\[)/i;

// Test output markers — vitest, jest, pytest, etc.
const TEST_FAILURE_RE = /\b(FAIL|PASS|Tests:|Test Suites:|×|✓|✗|✖|expected|received|toBe|toEqual|AssertionError|assert\b)/i;
const STACK_TRACE_RE = /\b(at |in )[\w.]+\(.*\)\s*\(.*:\d+:\d+\)/;
const ERROR_KEYWORD_RE = /\b(error|failed|failure|exception|crash|timeout|uncaught)\b/i;

/** True when the text reads like a CI/build/terminal log, not an article. */
export function looksLikeBuildLog(text: string): boolean {
  const t = text || '';
  if (t.length < 200) return false;
  if (AZURE_MARKER_RE.test(t)) return true;

  const lines = t.split('\n');
  const sample = lines.slice(0, 400);
  const timestamped = sample.filter(l => TIMESTAMP_LINE_RE.test(l)).length;
  if (timestamped >= Math.max(10, sample.length * 0.3)) return true;

  return GENERIC_LOG_RE.test(t) && /\b(error|failed|failure)\b/i.test(t);
}

/**
 * Detect if a page is a "debuggable" page — CI logs, test failures, error
 * reports, crash dumps, or any page with stack traces. These warrant a
 * thorough debugger-style analysis vs generic page reading.
 */
export function looksLikeDebugPage(text: string): boolean {
  const t = text || '';
  if (t.length < 200) return false;
  if (looksLikeBuildLog(t)) return true;

  const lines = t.split('\n');

  // Test runner output: vitest/jest summary lines
  const testLines = lines.filter(l => TEST_FAILURE_RE.test(l)).length;
  if (testLines >= 3 && testLines >= lines.length * 0.05) return true;

  // Stack traces
  const stackLines = lines.filter(l => STACK_TRACE_RE.test(l)).length;
  if (stackLines >= 2) return true;

  // High density of error-related keywords
  const errorLines = lines.filter(l => ERROR_KEYWORD_RE.test(l)).length;
  if (errorLines >= Math.max(5, lines.length * 0.1)) return true;

  // Lots of markdown table rows (test result tables)
  const tableRows = lines.filter(l => /^\|.*\|.*\|/.test(l)).length;
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

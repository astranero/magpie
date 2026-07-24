import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for React error #310 ("rendered more hooks than during the
 * previous render") — a WHITE-SCREEN class bug. It happens when a hook is
 * called AFTER a component-body early return: on the render where the branch
 * is taken, the hook count is lower, and React throws when the branch flips.
 *
 * We caught two of these live (MessageBody's `if (streaming) return` before
 * its useMemos; DocumentView's `useState` after `if (!document) return`).
 * This walks each component file at brace-body depth and fails if a hook call
 * appears after a top-level `return` — before it ever ships.
 */

// Matches a bare hook call (`useMemo(`) or the `React.useState(` form, but
// NOT an unrelated `foo.useState(` method — only a `React.` prefix is allowed.
const HOOK_RE = /(?:^|[^.\w])(?:React\.)?(useState|useEffect|useMemo|useCallback|useRef|useReducer|useLayoutEffect|useContext|useImperativeHandle|useTransition|useDeferredValue|useSyncExternalStore|useId)\s*\(/;
const RETURN_RE = /^\s*(?:\}\s*)?(?:if\s*\([^)]*\)\s*)?return[\s(<;]/;
const COMPONENT_START_RE = /(?:const\s+[A-Z]\w*\s*(?::[^=]+)?=\s*(?:React\.memo\()?\(|function\s+[A-Z]\w*\s*\()/;

function stripStringsAndComments(line: string): string {
  // Coarse — enough to keep brace/paren counts sane on our own source.
  return line
    .replace(/\/\/.*$/, '')
    .replace(/`[^`]*`/g, '``')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

interface Violation { file: string; line: number; hook: string; returnLine: number }

/**
 * Depth 1 = the component function body. `return` and hook calls that matter
 * live there; anything nested (callbacks, useMemo bodies, JSX handlers) sits
 * deeper and is correctly ignored.
 */
function scanFile(path: string, rel: string): Violation[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const out: Violation[] = [];
  let inComponent = false;
  let depth = 0;
  let bodyDepth = -1;
  let returnLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const clean = stripStringsAndComments(raw);

    if (!inComponent && COMPONENT_START_RE.test(raw)) {
      inComponent = true;
      depth = 0;
      bodyDepth = -1;
      returnLine = -1;
    }

    if (inComponent) {
      const before = depth;
      // Detect the body-opening brace: first '{' that lands us at depth 1.
      for (const ch of clean) {
        if (ch === '{') { depth++; if (bodyDepth === -1 && depth === 1) bodyDepth = 1; }
        else if (ch === '}') depth--;
      }
      // Evaluate statements that START at body depth (before this line's braces).
      if (bodyDepth === 1 && before === 1) {
        if (returnLine === -1 && RETURN_RE.test(clean)) returnLine = i + 1;
        const hookM = returnLine !== -1 ? clean.match(HOOK_RE) : null;
        if (hookM) out.push({ file: rel, line: i + 1, hook: hookM[1], returnLine });
      }
      if (bodyDepth === 1 && depth <= 0) { inComponent = false; }
    }
  }
  return out;
}

describe('React hook-order guard (no hooks after a component early return)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'components');

  const files = readdirSync(dir).filter(f => f.endsWith('.tsx'));

  it('scans every sidepanel component', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} calls no hook after a body-level return`, () => {
      const violations = scanFile(join(dir, f), f);
      expect(
        violations,
        violations.map(v => `${v.file}:${v.line} — ${v.hook}() after return on line ${v.returnLine}`).join('\n')
      ).toEqual([]);
    });
  }
});

import { describe, it, expect } from 'vitest';
import { sanitizeCliOutput, isCliErrorOutput, composeCliPrompt } from '../cli-output';

describe('sanitizeCliOutput', () => {
  it('drops the stdin-probe warning line', () => {
    const raw = 'Event sourcing = store state as events.\nWarning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.';
    expect(sanitizeCliOutput(raw)).toBe('Event sourcing = store state as events.');
  });

  it('cuts the warning when glued to the end of an answer line', () => {
    const raw = 'Balance = fold events = 70. Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly.';
    expect(sanitizeCliOutput(raw)).toBe('Balance = fold events = 70.');
  });

  it('strips ANSI color codes but keeps bracketed prose', () => {
    const raw = '\u001b[1mBold claim\u001b[0m about [2026] budgets';
    expect(sanitizeCliOutput(raw)).toBe('Bold claim about [2026] budgets');
  });

  it('leaves an answer that merely mentions stdin alone', () => {
    const raw = 'Use stdin redirection like `< file` to feed the program.';
    expect(sanitizeCliOutput(raw)).toBe(raw);
  });
});

describe('isCliErrorOutput', () => {
  it('detects the logged-out CLI', () => {
    expect(isCliErrorOutput('Not logged in · Please run /login')).toBe(true);
  });
  it('detects empty output and usage dumps', () => {
    expect(isCliErrorOutput('')).toBe(true);
    expect(isCliErrorOutput('usage: claude [options] [prompt]')).toBe(true);
  });
  it('accepts a real answer, even one discussing logins', () => {
    expect(isCliErrorOutput('OAuth login flows use a redirect URI to return the auth code.')).toBe(false);
  });
  it('does not discard a long real answer that merely echoes an error phrase', () => {
    const answer =
      'An "invalid API key" error usually means the key was rotated or the header is malformed. ' +
      'Check that the Authorization header is `Bearer <key>` with no trailing whitespace, that the key belongs to the right org, ' +
      'and that you are not mixing test and production keys. If the key was recently created, propagation can take a minute. ' +
      'Finally, confirm the endpoint URL matches the provider the key was issued for.';
    expect(isCliErrorOutput(answer)).toBe(false);
  });
});

describe('composeCliPrompt', () => {
  it('carries system prompt, history, and the user message', () => {
    const out = composeCliPrompt(
      'You are Magpie. --- SOURCES --- [d1.s0.p1] Event sourcing stores events. --- END SOURCES ---',
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }],
      'what is event sourcing?',
    );
    expect(out).toContain('SYSTEM INSTRUCTIONS');
    expect(out).toContain('[d1.s0.p1] Event sourcing stores events.');
    expect(out).toContain('CONVERSATION SO FAR:\nUser: hi\n\nAssistant: Hello!');
    expect(out).toMatch(/USER MESSAGE[^\n]*:\nwhat is event sourcing\?$/);
  });

  it('omits empty blocks', () => {
    const out = composeCliPrompt('', [], 'ping');
    expect(out).not.toContain('SYSTEM INSTRUCTIONS');
    expect(out).not.toContain('CONVERSATION SO FAR');
    expect(out).toContain('ping');
  });
});

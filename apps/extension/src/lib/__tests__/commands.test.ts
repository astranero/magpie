import { describe, it, expect } from 'vitest';
import { sanitizeCustomSkill, findPromptCommand, paletteEntries, buildHelpText, customSkillToCommand, builtinCommandNames, SLASH_COMMANDS } from '../commands';

const rawSkill = {
  cmd: '/competitors',
  desc: 'Find competitors',
  systemPrompt: 'You are a researcher who finds competitors.'
};

describe('sanitizeCustomSkill', () => {
  it('valid skill passes', () => {
    expect(sanitizeCustomSkill(rawSkill)).toEqual(rawSkill);
  });

  it('invalid cmd fails', () => {
    expect(sanitizeCustomSkill({ ...rawSkill, cmd: 'competitors' })).toBeNull();
  });

  it('missing systemPrompt fails', () => {
    expect(sanitizeCustomSkill({ ...rawSkill, systemPrompt: '' })).toBeNull();
  });

  it('shadowing built-in cmd fails', () => {
    expect(sanitizeCustomSkill({ ...rawSkill, cmd: '/research' })).toBeNull();
  });
});

describe('customSkillToCommand', () => {
  it('correctly converts custom skill to SlashCommand', () => {
    const cmd = customSkillToCommand(rawSkill);
    expect(cmd.cmd).toBe(rawSkill.cmd);
    expect(cmd.desc).toBe(rawSkill.desc);
    expect(cmd.takesArg).toBe(true);
    expect(cmd.kind).toBe('prompt');
    expect(cmd.systemPrompt).toBe(rawSkill.systemPrompt);
  });
});

describe('findPromptCommand', () => {
  const customCmds = [customSkillToCommand(rawSkill)];
  it('matches command with trailing space', () => {
    expect(findPromptCommand('/competitors something', customCmds)?.command.cmd).toBe('/competitors');
  });
  it('matches command as sole message', () => {
    expect(findPromptCommand('/competitors', customCmds)?.command.cmd).toBe('/competitors');
  });
  it('returns null for non-command', () => {
    expect(findPromptCommand('hello', customCmds)).toBeNull();
  });
  it('includes custom skills in match set', () => {
    expect(findPromptCommand('/competitors', customCmds)?.command.cmd).toBe('/competitors');
  });
});

describe('paletteEntries', () => {
  it('filters commands by prefix', () => {
    const entries = paletteEntries('/comp');
    expect(entries.some(c => c.cmd === '/compare')).toBe(true);
  });

  it('/academic is a research command: deep pipeline + papers-only source mode', () => {
    const entries = paletteEntries('/acad');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cmd: '/academic', kind: 'research', mode: 'deep', sourceMode: 'academic', takesArg: true });
  });

  it('the other research commands carry no sourceMode (auto corpus)', () => {
    const research = paletteEntries('/').filter(c => c.kind === 'research' && c.cmd !== '/academic');
    expect(research.length).toBeGreaterThan(0);
    expect(research.every(c => c.sourceMode === undefined)).toBe(true);
  });
});

describe('buildHelpText', () => {
  it('includes built-in and custom commands', () => {
    const helpText = buildHelpText([customSkillToCommand(rawSkill)]);
    expect(helpText).toContain('/competitors');
    expect(helpText).toContain('/research');
    expect(helpText).toContain('/academic');
  });
});

// /create-skill mints commands at runtime and must never shadow a built-in.
// The set it checks against used to be hand-written in service-worker.ts and
// went stale the moment a command was added — derive it, and prove it stays
// in step with the registry.
describe('builtinCommandNames', () => {
  it('covers every command in the registry', () => {
    const names = builtinCommandNames();
    expect(names.size).toBe(SLASH_COMMANDS.length);
    for (const c of SLASH_COMMANDS) expect(names.has(c.cmd)).toBe(true);
  });

  it('blocks a custom skill from shadowing any built-in', () => {
    for (const c of SLASH_COMMANDS) {
      expect(sanitizeCustomSkill({ cmd: c.cmd, desc: 'x', systemPrompt: 'y'.repeat(60) })).toBeNull();
    }
  });
});

describe('ported commands', () => {
  it('/grill is a prompt command that asks one question at a time', () => {
    const hit = findPromptCommand('/grill my migration plan');
    expect(hit?.command.cmd).toBe('/grill');
    expect(hit?.query).toBe('my migration plan');
    expect(hit?.command.systemPrompt).toMatch(/ONE question per reply/);
  });

  it('/teach is a builtin — App routes it, so it must not be handled as a prompt', () => {
    const teach = SLASH_COMMANDS.find(c => c.cmd === '/teach');
    expect(teach?.kind).toBe('builtin');
    expect(findPromptCommand('/teach rust ownership')).toBeNull();
  });

  it('both appear in the palette and in /help', () => {
    expect(paletteEntries('/gr').map(c => c.cmd)).toContain('/grill');
    expect(paletteEntries('/te').map(c => c.cmd)).toContain('/teach');
    const help = buildHelpText();
    expect(help).toContain('/grill');
    expect(help).toContain('/teach');
  });
});

import { describe, it, expect } from 'vitest';
import { sanitizeCustomSkill, findPromptCommand, paletteEntries, buildHelpText, customSkillToCommand } from '../commands';

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
});

describe('buildHelpText', () => {
  it('includes built-in and custom commands', () => {
    const helpText = buildHelpText([customSkillToCommand(rawSkill)]);
    expect(helpText).toContain('/competitors');
    expect(helpText).toContain('/research');
  });
});

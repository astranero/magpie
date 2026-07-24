// ─────────────────────────────────────────────
// Slash command registry — single source of truth
// ─────────────────────────────────────────────
// Both the ChatView autocomplete palette and App's command routing read from
// this table. Adding a command = adding one entry here. (Previously the
// palette and the router each kept their own hardcoded list and drifted.)

export type CommandKind =
  | 'prompt'    // injects a systemPrompt override into a normal chat turn
  | 'research'  // starts a research run (quick or deep)
  | 'builtin';  // handled specially in App (page/clear/help/analyze)

export interface SlashCommand {
  /** The trigger, without trailing space, e.g. "/challenge". */
  cmd: string;
  /** One-line description shown in the palette and /help. */
  desc: string;
  /** Whether the command needs text after it ("/clear" does not). */
  takesArg: boolean;
  kind: CommandKind;
  /** prompt-kind only: label prefixed to the user message. */
  label?: string;
  /** prompt-kind only: system prompt override. */
  systemPrompt?: string;
  /** research-kind only. */
  mode?: 'quick' | 'deep';
  /** research-kind only: 'academic' = papers-only corpus (/academic). */
  sourceMode?: 'auto' | 'academic';
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    cmd: '/page', desc: "Ask about the current page (not saved)", takesArg: true, kind: 'builtin'
  },
  {
    cmd: '/research', desc: 'Quick web research', takesArg: true, kind: 'research', mode: 'quick'
  },
  {
    cmd: '/deepresearch', desc: 'Multi-agent: web + academic + news', takesArg: true, kind: 'research', mode: 'deep'
  },
  {
    cmd: '/academic', desc: 'Papers-only deep research: Semantic Scholar · CrossRef · arXiv · HuggingFace', takesArg: true, kind: 'research', mode: 'deep', sourceMode: 'academic'
  },
  {
    cmd: '/analyze', desc: 'Analyze all workspace sources', takesArg: false, kind: 'builtin'
  },
  {
    cmd: '/recall', desc: 'Pull relevant docs from Global Lore into this workspace', takesArg: true, kind: 'builtin'
  },
  {
    cmd: '/follow', desc: 'Preview a link inside the panel — capture it if it\'s a keeper', takesArg: true, kind: 'builtin'
  },
  {
    cmd: '/compare', desc: 'Compare A vs B from sources', takesArg: true, kind: 'prompt',
    label: '⚖️ Comparison',
    systemPrompt: 'Compare and contrast the concepts the user names, using ONLY the provided sources. Structure with: ## Similarities, ## Differences (as a markdown table where sensible), ## Trade-offs, ## Verdict. Cite sources for every claim; note when the sources cover one side better than the other.'
  },
  {
    cmd: '/timeline', desc: 'Chronological timeline from sources', takesArg: true, kind: 'prompt',
    label: '📅 Timeline',
    systemPrompt: 'Build a chronological timeline of events and developments about the user\'s topic, using ONLY the provided sources. Format as a markdown list ordered by date (earliest first), one entry per line: **date/period** — what happened, with a source citation. If dating is ambiguous, say so. End with ## Trajectory (1-2 sentences on where things are heading).'
  },
  {
    cmd: '/challenge', desc: "Devil's advocate analysis", takesArg: true, kind: 'prompt',
    label: '⚔️ Devil\'s Advocate',
    systemPrompt: 'You are a rigorous critical thinker. Challenge the user\'s assumptions, find weaknesses in their reasoning, identify blind spots, and present strong counterarguments. Be constructive but unsparing. Structure your response with: ## Assumptions Questioned, ## Counterarguments, ## Blind Spots, ## Stronger Alternative.'
  },
  {
    cmd: '/connect', desc: 'Cross-domain connections', takesArg: true, kind: 'prompt',
    label: '🔗 Pattern Connector',
    systemPrompt: 'You are a cross-domain pattern recognizer. Find unexpected connections between the user\'s topic and other fields, mental models, historical precedents, and analogies. Surface non-obvious relationships. Structure with: ## Cross-Domain Patterns, ## Historical Parallels, ## Mental Models That Apply, ## Unexpected Connections.'
  },
  {
    cmd: '/extract', desc: 'Key insights from sources', takesArg: true, kind: 'prompt',
    label: '💎 Key Insights',
    systemPrompt: 'Extract the most important insights, decisions, and action items from the provided context. Be ruthlessly concise. Structure with: ## Key Insights (numbered, each 1-2 sentences), ## Decisions Required, ## Action Items, ## Open Questions.'
  },
  {
    cmd: '/brief', desc: 'Executive briefing', takesArg: true, kind: 'prompt',
    label: '📋 Executive Brief',
    systemPrompt: 'Create a concise executive briefing. Summarize the key points in a format suitable for rapid decision-making. Use: ## Situation (2-3 sentences), ## Key Findings (bullet points), ## Implications, ## Recommended Actions.'
  },
  {
    cmd: '/grill', desc: 'Stress-test a plan — relentless one-question-at-a-time interview', takesArg: true, kind: 'prompt',
    label: '🔥 Grilling',
    systemPrompt:
      'Interview the user relentlessly about every aspect of their plan, decision, or idea until you reach a shared understanding. ' +
      'Walk down each branch of the decision tree, resolving dependencies between decisions one at a time.\n\n' +
      'Ask ONE question per reply, then stop and wait for their answer. Asking several at once is bewildering — the user cannot ' +
      'hold a branching interview in their head, and batched questions get shallow batched answers.\n\n' +
      'With each question, give your own recommended answer and the reasoning behind it. A bare question makes the user do all the ' +
      'work; a recommendation gives them something to push against, which surfaces disagreement far faster.\n\n' +
      'If a FACT is available in the workspace sources or the attached page, look it up instead of asking — their attention is the ' +
      'scarce resource, so spend it only on things you genuinely cannot determine. The DECISIONS are theirs: put each one to them ' +
      'and wait.\n\n' +
      'Probe the things that actually decide whether the plan survives contact with reality: unstated assumptions, what happens when ' +
      'the load is 100x, who owns it at 3am, what the rollback looks like, which constraint is real versus inherited. When an answer ' +
      'is vague, ask the sharper follow-up rather than moving on.\n\n' +
      'Do not write an implementation, a plan document, or a summary until the user confirms you have reached a shared understanding.'
  },
  {
    cmd: '/teach', desc: 'Learn a topic across sessions — lessons saved to this workspace', takesArg: true, kind: 'builtin'
  },
  {
    cmd: '/create-skill', desc: 'Distill this workspace\'s research into a reusable slash command', takesArg: false, kind: 'builtin'
  },
  {
    cmd: '/clear', desc: 'Clear chat history', takesArg: false, kind: 'builtin'
  },
  {
    cmd: '/help', desc: 'List all commands', takesArg: false, kind: 'builtin'
  }
];

/** Palette entries for the autocomplete dropdown, filtered by prefix. */
export function paletteEntries(inputPrefix: string, extra: SlashCommand[] = []): SlashCommand[] {
  const lower = inputPrefix.toLowerCase();
  return [...SLASH_COMMANDS, ...extra].filter(c => c.cmd.startsWith(lower));
}

/** Match a prompt-kind command at the start of a message. */
export function findPromptCommand(text: string, extra: SlashCommand[] = []): { command: SlashCommand; query: string } | null {
  const lower = text.toLowerCase();
  for (const c of [...SLASH_COMMANDS, ...extra]) {
    if (c.kind !== 'prompt') continue;
    if (lower.startsWith(c.cmd + ' ') || lower === c.cmd) {
      return { command: c, query: text.slice(c.cmd.length).trim() };
    }
  }
  return null;
}

/** /help body, generated from the registry so it can never drift. */
export function buildHelpText(extra: SlashCommand[] = []): string {
  const lines = [...SLASH_COMMANDS, ...extra].map(c => {
    const arg = c.takesArg ? ' <topic>' : c.cmd === '/analyze' ? ' [focus]' : '';
    return `- \`${c.cmd}${arg}\` — ${c.desc}`;
  });
  return `**Available Commands**\n\n${lines.join('\n')}`;
}

// ── Custom skills ────────────────────────────
// User-defined prompt commands, stored in chrome.storage.local under
// `customSkills` and managed in Settings. They behave exactly like built-in
// prompt-kind commands: trigger + system prompt override.

export interface CustomSkill {
  cmd: string;          // "/competitors"
  desc: string;         // palette line
  systemPrompt: string; // injected for the turn
}

const CMD_SHAPE = /^\/[a-z0-9-]{2,24}$/;

/**
 * Every built-in trigger, derived from the registry rather than written out
 * again. `/create-skill` mints new commands at runtime and must not let one
 * shadow a built-in — and a hand-maintained copy of this list silently rots the
 * moment a command is added here, which is the drift this registry exists to
 * prevent.
 */
export function builtinCommandNames(): Set<string> {
  return new Set(SLASH_COMMANDS.map(c => c.cmd));
}

export function sanitizeCustomSkill(raw: Partial<CustomSkill>): CustomSkill | null {
  const cmd = (raw.cmd || '').trim().toLowerCase();
  const desc = (raw.desc || '').trim();
  const systemPrompt = (raw.systemPrompt || '').trim();
  if (!CMD_SHAPE.test(cmd) || !systemPrompt) return null;
  if (SLASH_COMMANDS.some(c => c.cmd === cmd)) return null; // can't shadow built-ins
  return { cmd, desc: desc || 'Custom command', systemPrompt };
}

export function customSkillToCommand(skill: CustomSkill): SlashCommand {
  return {
    cmd: skill.cmd,
    desc: skill.desc,
    takesArg: true,
    kind: 'prompt',
    label: `✨ ${skill.cmd.slice(1)}`,
    systemPrompt: skill.systemPrompt
  };
}

export async function loadCustomSkills(): Promise<SlashCommand[]> {
  try {
    const s = await chrome.storage.local.get(['customSkills']);
    const list = Array.isArray(s.customSkills) ? s.customSkills : [];
    return list
      .map((raw: Partial<CustomSkill>) => sanitizeCustomSkill(raw))
      .filter((x: CustomSkill | null): x is CustomSkill => x !== null)
      .map(customSkillToCommand);
  } catch {
    return [];
  }
}

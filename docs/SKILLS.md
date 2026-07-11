# Commands & Custom Skills

## Single source of truth

`lib/commands.ts` — `SLASH_COMMANDS` is the one registry. The ChatView
autocomplete palette (`paletteEntries`), App routing (`findPromptCommand`),
and `/help` (`buildHelpText`) all read from it, so they cannot drift.
Adding a built-in = one entry.

Three command kinds:
- **`prompt`** — injects a `systemPrompt` override into a normal chat turn
  (still RAG + citations): `/compare`, `/timeline`, `/challenge`,
  `/connect`, `/extract`, `/brief`.
- **`research`** — starts a run: `/research` (quick), `/deepresearch`
  (staged multi-agent).
- **`builtin`** — special-cased in App: `/page` (ephemeral current-page
  context), `/recall` (pull Global Lore into the workspace), `/analyze`,
  `/clear`, `/help`.

## Custom skills (Config → Custom Commands)

User-defined prompt-kind commands stored under `customSkills` in
`chrome.storage.local`:

```ts
CustomSkill { cmd: '/competitors', desc, systemPrompt }
```

`sanitizeCustomSkill` enforces the trigger shape (`/[a-z0-9-]{2,24}`),
a non-empty prompt, and **no shadowing of built-ins**. `loadCustomSkills`
converts them to `SlashCommand`s; App loads them at mount and live-reloads
via `chrome.storage.onChanged`, passing them into the palette, the router,
and `/help`. They execute exactly like built-in prompt commands — over the
workspace sources, with citations.

Note: file-based skill directories (a `skills/` folder scanned from disk)
are not possible in an extension without the synced-folder handle; the
storage-backed approach was chosen deliberately. See `PLAN-v1-full.md`
history for the trade-off.

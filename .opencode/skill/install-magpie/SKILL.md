---
name: install-magpie
description: Use when a user asks an agent to clone, install, build, or set up the Magpie Chrome/Edge extension from https://github.com/astranero/magpie, or to load the built extension into the browser. Covers Node.js prerequisites, the npm-workspaces build, Windows PowerShell gotchas, and loading the unpacked extension.
---

# Install Magpie (AI Research Assistant browser extension)

Magpie is an npm-workspaces monorepo. The buildable app is the MV3 browser
extension at `apps/extension`; the build output that gets loaded into the
browser is `apps/extension/dist`.

## Goal

Produce a working `apps/extension/dist` and tell the user how to load it as an
unpacked extension.

## Steps

### 1. Check prerequisites

Verify Node.js (v18+, v20 LTS recommended) and npm (v9+) are installed:

```bash
node -v
npm -v
```

If missing on Windows, install and reopen the terminal:

```powershell
winget install OpenJS.NodeJS.LTS
```

Node/npm won't be on the current shell's `PATH` until the terminal is
reopened. If you can't reopen it, invoke the tools by full path, e.g.
`& "C:\Program Files\nodejs\node.exe" -v`.

### 2. Clone (skip if already cloned)

```bash
git clone https://github.com/astranero/magpie.git
cd magpie
```

### 3. Install dependencies from the repo ROOT

This is a workspaces monorepo — install at the root, not inside
`apps/extension`:

```bash
npm install
```

### 4. Build the extension

```bash
npm run build:extension
```

This runs `tsc` (typecheck), the main Vite build, and two content-script
builds. It is cross-platform and writes to `apps/extension/dist`.

### 5. Verify the output

`apps/extension/dist` should contain at least:
`manifest.json`, `background.js`, `content.js`, `inject.js`, `sidepanel.html`,
`offscreen.html`, plus `assets/`, `icons/`, and `transformers/` (the flattened
ONNX wasm runtimes). If any are missing, the build did not complete — re-run
step 4 and read the error.

### 6. Load it in the browser

Tell the user to:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `apps/extension/dist` folder.
5. Click the Magpie toolbar icon to open the side panel.

## Windows / PowerShell notes

- If `npm` fails with "npm.ps1 cannot be loaded because running scripts is
  disabled", call `npm.cmd` (and `npx.cmd`) directly instead of `npm`/`npx`.
- Do not `cd` into a path containing spaces without quoting it.

## Troubleshooting

- **`node`/`npm` not recognized** → Node.js isn't installed or isn't on
  `PATH`. Install it (step 1) and reopen the terminal.
- **`ERESOLVE` peer-dependency errors** → the lockfile expects a clean tree;
  run `npm install` from the repo root. Avoid `--force` unless the user asks.
- **`tsc` type errors** → these fail the build by design; report them, don't
  bypass `tsc`.
- **Build succeeded but `dist` is incomplete** → run `npm run build:extension`
  again from the repo root and inspect the full output.

## Do NOT

- Run `npm install` inside `apps/extension` (breaks workspace hoisting).
- Load the `apps/extension` source folder into the browser — load `dist`.
- Commit, push, or open PRs unless the user explicitly asks.

# Google Drive sync — one-time setup

Magpie syncs your workspace to a **`Magpie`** folder in the signed-in user's
Google Drive. End users only click **Sign in with Google** — they never enter a
client ID, secret, or API key.

That works because the OAuth **client ID** is baked into the extension once, by
whoever publishes/loads it. This is the only manual step, and it takes ~5
minutes. After it's done, the sign-in flow is credential-free for everyone.

There is **no zero-config alternative** — every Google OAuth flow (including
"Sign in with Google") requires one registered client ID. `chrome.storage.sync`
was considered and rejected: its ~100 KB quota can't hold documents.

## Why the app can't ship a client ID for you

An OAuth "Chrome Extension" client is bound to a **specific extension ID**.
Your unpacked/published copy has its own ID, so you must register a client for
*your* ID. A shared client ID would reject every other install.

## Steps

1. **Get your extension ID.** Load the extension unpacked at
   `chrome://extensions` (Developer mode on) and copy its ID. To keep the ID
   stable across reloads/machines, publish to the Web Store, or add a `"key"`
   to `manifest.json` (see Chrome docs: "keep a consistent extension ID").

2. **Create a Google Cloud project.** <https://console.cloud.google.com/> →
   new project.

3. **Enable the Drive API.** APIs & Services → Library → search "Google Drive
   API" → Enable.

4. **Configure the OAuth consent screen.** External is fine for personal use.
   Add scopes: `.../auth/drive.file`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`. Add yourself as a test user (or publish the
   consent screen for others).

5. **Create the OAuth client ID.** APIs & Services → Credentials → Create
   credentials → OAuth client ID → application type **Chrome Extension** (the
   newer console groups this under "Chrome app") → paste your extension ID from
   step 1.

6. **Paste the client ID into the manifest.** In
   `apps/extension/src/manifest.json`, replace the `oauth2.client_id` value
   (the checked-in default is the maintainer's own client ID, which only
   works for their extension ID) with the value from step 5. Rebuild
   (`npm run build`) and reload the extension.

## Result

- **Sign in** (Config → Google Drive) → Google's own consent popup → done.
- On sign-in, Magpie **imports** any existing files from the Drive `Magpie`
  folder, then **pushes** local docs that aren't there yet — no separate Sync
  click.
- Scope is `drive.file`: Magpie can only see and manage the files **it**
  creates. It cannot read the rest of your Drive.
- Machine-gathered research sources stay local (they'd clutter Drive); the
  report and consolidated sources list do sync.

## Scopes rationale

`drive.file` is least-privilege and keeps Google's verification light —
Magpie touches only its own folder, never the user's other files.

---
name: dynamic-test
description: Dynamically test the Oracle app — run the static gates, boot the real Electron app + GPU engine to verify it loads a model and chats (headless ORACLE_SMOKE E2E), and drive the renderer UI as a user with the Playwright E2E (npm run test:e2e). Use when asked to test, smoke-test, verify, or "run" the app, or to confirm a change works end-to-end (not just unit tests).
allowed-tools: Read, Grep, Glob, Bash, PowerShell
---

# Dynamically testing Oracle

Oracle is an Electron app that loads a GGUF model onto the GPU and streams chat.
"Testing dynamically" means more than unit tests — it means **booting the real
app and driving a real generation**. Work outward in three layers; stop at the
layer that matches the request.

## Layer 1 — Static gates (always run first)

```bash
npm run typecheck && npm test && npm run build
```

- `typecheck` = `tsc` for both the node (`tsconfig.node.json`) and web
  (`tsconfig.web.json`) projects.
- `test` = `vitest run` — pure unit tests over `src/shared/**` (`format`,
  `context`, `export`). No GPU, no Electron.
- `build` = `electron-vite build` → populates `out/` (the in-app E2E needs this).

The vite "dynamically imported … also statically imported" warnings about
`format.ts` / `store.ts` are pre-existing and harmless.

## Layer 2 — Headless in-app E2E (the real renderer + engine + GPU)

This is the highest-value test: it boots Electron, registers a model through the
real persistence layer, and drives **load → send → stream** across **two**
conversations through the actual `window.oracle` IPC bridge (the second forces
the `setChatHistory` swap path). It screenshots and self-exits: **exit 0 = pass,
exit 1 = fail**.

It is guarded entirely by env vars and lives in `src/main/index.ts` (`runSmoke`,
fired on `did-finish-load`). **Requires `npm run build` first** (it runs `out/`).

1. Find a local `.gguf` to load (any installed model works — the harness
   re-registers it from the file path):

   ```bash
   # Installed models live under Electron userData (Roaming on Windows):
   ls "$APPDATA/oracle/models/"*.gguf 2>/dev/null
   # …or read the registry:
   cat "$APPDATA/oracle/models.json"
   ```

2. Run it, filtering for the signal and capturing the screenshot dir:

   ```bash
   OUT=$(mktemp -d)
   ORACLE_SMOKE=1 \
   ORACLE_SMOKE_MODEL="C:/path/to/model.gguf" \
   ORACLE_SMOKE_OUT="$OUT" \
   ./node_modules/electron/dist/electron.exe . 2>&1 \
     | grep -iE "smoke|error|fail|cuda|gpu|architecture"
   echo "exit: ${PIPESTATUS[0]}"
   ls "$OUT"   # → oracle-smoke-chat.png
   ```

   A pass prints `[smoke] ✅ IN-APP CHAT PASSED (2 conversations)` and a result
   line with `tokensPerSecond` / `contextTokens`.

3. **Look at the screenshot** — copy it into the repo to view it, then delete it
   (keep the working tree clean):

   ```bash
   cp "$OUT/oracle-smoke-chat.png" ./.smoke-shot.png   # Read it, then:
   rm -f ./.smoke-shot.png && rm -rf "$OUT"
   ```

Tuning knobs:
- `ORACLE_SMOKE` with **no** `ORACLE_SMOKE_MODEL` → just boots and screenshots
  `oracle-smoke.png` (renderer-only sanity). Pair with
  `ORACLE_SMOKE_DELAY=4000` to let `init()` settle on a cold start.
- The harness drives the engine via IPC, so the renderer's `activeConversationId`
  stays null and the screenshot shows the **empty/ready** state. It does **not**
  click UI (drawers, find, regenerate/export/presets) — those need Layer 3.

## Layer 3 — Playwright UI E2E (drives the real renderer as a user)

The headless E2E (Layer 2) drives the *engine* via IPC, so it never clicks the
renderer-interaction features (overrides drawer, in-chat Find, sidebar search,
export, message delete, presets/profiles). Those are covered by a Playwright
`_electron` driver: **`scripts/ui-e2e.mjs`** (uses `playwright-core`, a devDep —
no browser download; `_electron` drives the app's own Electron).

```bash
npm run build && npm run test:e2e
```

It launches the **built** app in an isolated temp `--user-data-dir` seeded with a
couple of conversations (so it never touches your real data and **needs no
model/GPU**), then asserts each feature and screenshots to `ORACLE_E2E_OUT`
(default: a printed temp dir). **Exit 0 = pass.** A healthy run prints:

```
[e2e] ✅ ALL UI E2E CHECKS PASSED
```

What it covers: sidebar search filtering, in-chat Find match count, the
conversation-settings drawer (system-prompt + generation overrides persisted,
profile applied), export (stubs `dialog.showSaveDialog` in main and asserts the
written file), single-message delete, and adding a generation profile in
Settings. Generation-dependent flows (send, regenerate, edit-and-resend) are
**not** here — they need a model and are covered by Layer 2.

Extending it: add seeded conversations to the `conversations` array; select
renderer elements by visible text / `getByPlaceholder` / `getByTitle` (the UI has
no test-ids); scope drawer interactions to `page.locator('div.z-40')`; read
persisted state back via `page.evaluate(() => window.oracle.…)`. Throw to fail
(sets a non-zero exit).

### Manual / interactive

For ad-hoc poking or features not yet scripted:

```bash
npm run dev        # electron-vite dev — hot-reloading window for manual clicks
npm start          # = electron-vite preview, runs the built out/ instead
```

## Layer 2b — Out-of-Electron pipeline smoke

```bash
npm run smoke      # scripts/smoke-inference.mjs
```

Downloads a tiny model (`Qwen2.5-0.5B`, resumable, to `.smoke-models/`), loads it
on the GPU and streams a reply — validating the download + inference path without
Electron. Use to isolate engine/download issues from the UI.

## GPU caveats (from CLAUDE.md — don't misread a CPU fallback as a bug)

- **Verify GPU via the Electron app, not bare `node`.** In a sandboxed node CLI
  the binding self-test can fail (child-process restriction) and silently fall
  back to CPU. The in-app E2E (Layer 2) reflects real GPU behavior; a healthy run
  shows `CUDA` and VRAM climbing in the screenshot's engine badge.
- gemma4 and other newer archs only load via the custom from-source **b9616**
  CUDA build under `llama/localBuilds/`. If a model fails with `unknown model
  architecture`, that build is missing — rebuild with `npm run rebuild:llama`.
- The app disposes the GPU before exit; the E2E exits cleanly. A hard crash with
  `0xC0000409` means cleanup was skipped (a real bug worth reporting).

---
name: cut-release
description: Cut an Sibyl release — bump the version, then build the x64 Windows Squirrel installer + update package on the GPU box and publish them as the latest GitHub release (SibylSetup.exe + .nupkg + RELEASES). Use when asked to cut/ship/publish a release, tag a version, or build the installer. This publishes externally — confirm with the user before the publishing step.
allowed-tools: Read, Grep, Glob, Bash, PowerShell, Edit
---

# Cutting an Sibyl release

Releases are cut **manually on the GPU dev box** via `scripts/release.ps1`
(`npm run release`). There is deliberately no self-hosted CI runner — that would
leave a build daemon on a machine holding the SSH key + HF token. The script
verifies, builds the **Squirrel.Windows** installer + update package (bundling the
custom CUDA backend), tags the commit, and publishes them as the **latest** GitHub
release with `gh`.

Auto-update is Electron's **native `autoUpdater` (Squirrel)** reading straight from
the public GitHub releases — feed `github.com/jdhoward5/Sibyl/releases/latest/download`,
no server, no electron-updater. So each release must be `--latest` (the feed
resolves to GitHub's "Latest" release) and must carry three assets: `SibylSetup.exe`
(first-install download), `Sibyl-<version>-full.nupkg` (the update payload), and
`RELEASES` (the manifest). (Background: we migrated off NSIS in 1.1.0 because NSIS
overwrites the running app in place and deadlocks on the GPU/CUDA file handles —
"Sibyl cannot be closed". Squirrel installs side-by-side and applies on restart.)

⚠️ **This is outward-facing: it pushes a tag and publishes a public GitHub
release.** Do the prep yourself, but confirm with the user before the real
publish (or use `-DryRun` first).

## Prerequisites (verify before starting)

- Authenticated GitHub CLI: `gh auth status` (the script refuses without it
  unless `-DryRun`).
- `node_modules` installed; the custom CUDA backend present at
  `node_modules/node-llama-cpp/llama/localBuilds/win-x64-cuda-release-b9616/`.
  If absent, `npm run rebuild:llama` (needs CUDA Toolkit + VS Build Tools) — else
  the build ships without gemma4-class arch support.
- Clean **and pushed** working tree — the published binary must match the tagged
  commit; the script aborts on a dirty tree (`git status --porcelain`).

## Step 1 — Decide and bump the version

The script tags whatever `version` is in `package.json` (current: read it). The
project uses **semver stable** (e.g. `1.1.0`, `1.1.1`), not the old
`0.1.0-beta.N` scheme. Then:

1. Edit `version` in `package.json`.
2. Commit it — convention here is to fold the bump into the feature commit, e.g.
   `"…; bump to 1.1.1"` (see `git log`).
3. **Push the commit** (`git push`) so the tag will point at a published commit.

## Step 2 — Dry run (build only, no tag/publish)

```bash
npm run release -- -DryRun
```

This runs typecheck + unit tests + **GPU smoke** (`npm run smoke`) + `npm run
dist`, and stops after confirming the Squirrel artifacts exist in
`release/<version>/squirrel/`. Use this to validate the build without touching
GitHub.

`-SkipSmoke` skips only the GPU smoke gate. The smoke runs the engine *outside*
Electron, so for a real release it's still worth running; the packaged Squirrel
app's CUDA is best confirmed by installing it and loading a model.

## Step 3 — Publish (after user confirmation)

```bash
npm run release            # verify → smoke → dist → tag → push tag → gh release
```

What it does, in order (`scripts/release.ps1`):
1. Refuse if tree is dirty.
2. `npm run typecheck` + `npm test`.
3. `npm run smoke` (unless `-SkipSmoke`).
4. `npm run dist` = `npm run package` (`electron-vite build` + `electron-builder
   --win --dir`) → `node scripts/squirrel.mjs` (electron-winstaller wraps the
   `win-unpacked` dir into the Squirrel installer + update package).
5. Verify `release/<version>/squirrel/{SibylSetup.exe, Sibyl-<version>-full.nupkg, RELEASES}`.
6. `git tag -a v<version>` (idempotent) and `git push origin v<version>`.
7. `gh release create v<version> SibylSetup.exe <nupkg> RELEASES
   --latest --generate-notes --title "Sibyl v<version>"`. **Always `--latest`** —
   the Squirrel feed (`releases/latest/download/RELEASES`) only resolves to the
   release GitHub marks "Latest". The `-Stable` flag is a **no-op** now (kept for
   muscle memory); there are no pre-releases.
8. **Auto-prune**: keep only the most recent N releases online (default **2**),
   deleting older release pages + their assets. The updater only reads the newest
   release's `RELEASES` + full `.nupkg` (full packages, no delta dependency on old
   ones), so pruning is safe. Best-effort — runs after the publish, so a prune
   error never fails the release. Flags: `-KeepReleases <n>`, `-CleanupTags` (also
   delete the pruned releases' tags), `-NoPrune`.

All three assets are required: without `RELEASES` + the `.nupkg` an installed app
can't update; `SibylSetup.exe` is the website first-install download. There is no
`latest.yml`/`app-update.yml`/`.blockmap` anymore (those were electron-updater/NSIS).

## After publishing

- Confirm the release: `gh release view v<version>` — three assets attached,
  marked **Latest** (`isPrerelease: false`).
- Sanity-check the feed: `curl -sIL https://github.com/jdhoward5/Sibyl/releases/latest/download/RELEASES`
  should 302 to the new version's RELEASES asset.
- If something's wrong before anyone downloads it:
  `gh release delete v<version> --yes` and `git push --delete origin v<version>`,
  fix, and re-cut (and re-promote the previous release to Latest if needed).
- Only the **2 most recent releases** are kept online (auto-pruned in step 8).
  Git **tags** for pruned releases are kept by default — pass `-CleanupTags` to
  drop them too.

## Notes / gotchas

- The build is **win-x64 Squirrel only**. First install is silent/per-user to
  `%LOCALAPPDATA%\Sibyl` (no folder picker); userData stays `%APPDATA%\sibyl`
  (`app.getName()` = `Sibyl`), so models/conversations carry across updates.
- The app is **unsigned** — SmartScreen "unknown publisher" on first install
  (unchanged). `update.electronjs.org` (a cleaner feed) needs signing, so we don't
  use it. If signing is ever added, that's the upgrade path.
- Packaging (`electron-builder.yml`) trims ~840 MB of dead native weight (very-old
  CUDA archs, arm64, the from-source build tree) **plus** the ~153 MB top-level
  `llama.cpp` source checkout — runtime needs only the compiled `localBuilds`
  output, and its deep paths otherwise overflow NuGet's MAX_PATH. Don't "fix" those
  `!` exclusions without understanding them.
- `scripts/squirrel.mjs` copies the repo `LICENSE` into the packaged dir (the
  nuspec requires a file literally named `LICENSE`) and pins a short `%TEMP%`
  (`C:\sqtmp`) to stay under Windows' 260-char MAX_PATH limit when NuGet/Squirrel
  stage under `lib\net45\…`.
- Output lands in `release/<version>/` (build output, not committed).
- The tag push (step 6) pushes only the tag — ensure branch commits are pushed
  first (Step 1) so the tag references a commit on the remote.
- Migration (historical, mostly done): moving an existing **NSIS** install onto
  Squirrel needs a one-time manual reinstall — uninstall the NSIS app, run the new
  `SibylSetup.exe`. userData (models/conversations) survives.

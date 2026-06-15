---
name: cut-release
description: Cut an Oracle release — bump the version, then build the x64 Windows (NSIS) installer on the GPU box and publish a GitHub pre-release with the .exe + auto-updater metadata (latest.yml) attached. Use when asked to cut/ship/publish a release, tag a version, or build the installer. This publishes externally — confirm with the user before the publishing step.
allowed-tools: Read, Grep, Glob, Bash, PowerShell, Edit
---

# Cutting an Oracle release

Releases are cut **manually on the GPU dev box** via `scripts/release.ps1`
(`npm run release`). There is deliberately no self-hosted CI runner — that would
leave a build daemon on a machine holding the SSH key + HF token. The script
verifies, builds the NSIS installer (bundling the custom CUDA backend), tags the
commit, and publishes a GitHub **pre-release** with `gh`.

⚠️ **This is outward-facing: it pushes a tag and publishes a public GitHub
release.** Do the prep yourself, but confirm with the user before the real
publish (or use `-DryRun` first).

## Prerequisites (verify before starting)

- Authenticated GitHub CLI: `gh auth status` (the script refuses without it
  unless `-DryRun`).
- `node_modules` installed; the custom CUDA backend present at
  `node_modules/node-llama-cpp/llama/localBuilds/win-x64-cuda-release-b9616/`.
  If absent, `npm run rebuild:llama` (needs CUDA Toolkit + VS Build Tools) — else
  the installer ships without gemma4-class arch support.
- Clean **and pushed** working tree — the published binary must match the tagged
  commit; the script aborts on a dirty tree (`git status --porcelain`).

## Step 1 — Decide and bump the version

The script tags whatever `version` is in `package.json` (current: read it). Pick
the next version (this project uses `0.1.0-beta.N` pre-release tags), then:

1. Edit `version` in `package.json`.
2. Commit it — convention here is to fold the bump into the feature commit, e.g.
   `"…; bump to 0.1.0-beta.5"` (see `git log`).
3. **Push the commit** (`git push`) so the tag will point at a published commit.

## Step 2 — Dry run (build only, no tag/publish)

```bash
npm run release -- -DryRun
# or: pwsh -File scripts/release.ps1 -DryRun
```

This runs typecheck + unit tests + **GPU smoke** (`npm run smoke`) + `npm run
dist`, and stops after confirming the installer exists at
`release/<version>/Oracle-<version>-setup.exe`. Use this to validate the build
without touching GitHub.

`-SkipSmoke` skips only the GPU smoke gate (don't, for a real release — it's the
only check the binary runs on a real GPU).

## Step 3 — Publish (after user confirmation)

```bash
npm run release            # full: verify → smoke → dist → tag → push tag → gh release
```

What it does, in order (`scripts/release.ps1`):
1. Refuse if tree is dirty.
2. `npm run typecheck` + `npm test`.
3. `npm run smoke` (unless `-SkipSmoke`).
4. `npm run dist` = `electron-vite build && electron-builder --win` (NSIS x64).
5. Verify `release/<version>/Oracle-<version>-setup.exe`.
6. `git tag -a v<version>` (idempotent) and `git push origin v<version>`.
7. `gh release create v<version> <installer> <latest.yml> [<blockmap>]
   --prerelease --generate-notes --title "Oracle v<version>"`.

`electron-builder.yml` sets the GitHub `publish` provider so the build generates
the auto-updater metadata (`latest.yml` + the packaged `app-update.yml`), but
`npm run dist` passes `--publish never` so electron-builder generates without
uploading — the script attaches the assets via `gh` for control over timing.
**`latest.yml` must be attached** or installed apps can't discover the release;
the `.exe.blockmap` is attached when present (differential downloads).

## After publishing

- Confirm the release: `gh release view v<version>` (asset attached, marked
  pre-release).
- If something's wrong before anyone downloads it:
  `gh release delete v<version> --yes` and `git push --delete origin v<version>`,
  fix, and re-cut.

## Notes / gotchas

- The build is **win-x64 NSIS only** (`electron-builder.yml` → `win.target`).
- Packaging trims ~840 MB of dead native weight (very-old CUDA archs, arm64, the
  from-source build tree) — see the comments in `electron-builder.yml`. Don't
  "fix" those `!` exclusions without understanding them.
- Output lands in `release/<version>/`; that dir is build output, not committed.
- The tag push (step 6) pushes only the tag. Ensure your branch commits are
  already pushed (Step 1) so the tag references a commit on the remote.

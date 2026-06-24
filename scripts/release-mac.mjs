// Cut a macOS Sibyl release: verify, build the unsigned .dmg + .zip
// (electron-builder --mac, Apple Silicon), then publish them to the GitHub
// release for this version. The macOS build has no in-app updater (Squirrel.Mac
// needs signing — see src/main/updater.ts), so these artifacts are the user's
// download; there's no RELEASES/.nupkg feed like the Windows side.
//
// This is the macOS counterpart to scripts/release.ps1. Run it ON a Mac (it
// builds a native arm64 app and needs `iconutil`/`hdiutil`, plus an authed `gh`).
//
//   node scripts/release-mac.mjs --dry-run   # verify + build, no tag/publish
//   node scripts/release-mac.mjs             # verify + build + publish --latest
//
// If a GitHub release for the tag already exists (e.g. the Windows release was
// cut first), the mac assets are uploaded onto it (--clobber) rather than
// creating a second release.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status})`)
  }
  return res
}
const capture = (cmd, args) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8' })

if (process.platform !== 'darwin') {
  throw new Error('release-mac.mjs must run on macOS.')
}

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tag = `v${version}`
console.log(`==> Releasing macOS ${tag}`)

if (!dryRun && capture('git', ['status', '--porcelain']).stdout.trim()) {
  throw new Error('Working tree is dirty. Commit or stash changes before releasing.')
}
if (!dryRun && capture('gh', ['--version']).status !== 0) {
  throw new Error("GitHub CLI (gh) not found. Install it (and `gh auth login`) or pass --dry-run.")
}

console.log('\n==> Typecheck + unit tests')
run('npm', ['run', 'typecheck'])
run('npm', ['test'])

console.log('\n==> Building unsigned macOS .dmg + .zip (electron-builder --mac --arm64)')
run('npm', ['run', 'dist:mac'])

const outDir = path.join(root, 'release', version)
const dmg = path.join(outDir, `Sibyl-${version}-arm64.dmg`)
const zip = path.join(outDir, `Sibyl-${version}-arm64-mac.zip`)
const assets = [dmg, zip].filter((f) => existsSync(f))
if (!existsSync(dmg)) {
  throw new Error(`Expected DMG not found: ${dmg}`)
}
console.log(`\n==> Built ${dmg}`)
for (const a of assets) console.log(`    ${a}`)

if (dryRun) {
  console.log('\n==> --dry-run: built but not tagging or publishing.')
  process.exit(0)
}

// Tag this commit (idempotent).
if (capture('git', ['tag', '--list', tag]).stdout.trim() !== tag) {
  run('git', ['tag', '-a', tag, '-m', `Sibyl ${tag}`])
}
run('git', ['push', 'origin', tag])

// Append to an existing release for this tag, or create it as --latest.
const exists = capture('gh', ['release', 'view', tag]).status === 0
if (exists) {
  console.log(`\n==> Release ${tag} exists — uploading mac assets onto it`)
  run('gh', ['release', 'upload', tag, ...assets, '--clobber'])
} else {
  console.log(`\n==> Creating release ${tag}`)
  run('gh', ['release', 'create', tag, ...assets, '--latest', '--generate-notes', '--title', `Sibyl ${tag}`])
}
console.log(`\n==> Published macOS assets to release ${tag}`)

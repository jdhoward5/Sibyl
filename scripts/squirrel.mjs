// Wrap the electron-builder `--dir` output (release/<version>/win-unpacked) into
// Squirrel.Windows artifacts: SibylSetup.exe + Sibyl-<version>-full.nupkg + RELEASES.
//
// Why this exists: NSIS overwrites the running app in place, which deadlocks on
// our GPU/CUDA file handles ("Sibyl cannot be closed"). Squirrel installs each
// version side-by-side and applies on restart — never overwriting the running
// binary. electron-builder still does the packaging/trimming (--dir); this just
// produces the Squirrel installer + update package from its output.
//
// Usage: node scripts/squirrel.mjs   (run after `electron-builder --win --dir`)

import { createWindowsInstaller } from 'electron-winstaller'
import path from 'node:path'
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// NuGet + Squirrel stage files under TEMP with a `lib\net45\…` prefix, and our
// node-llama-cpp paths are deep — keep TEMP short so we stay under Windows'
// 260-char MAX_PATH limit.
const shortTmp = path.join(process.env.SystemDrive || 'C:', 'sqtmp')
mkdirSync(shortTmp, { recursive: true })
process.env.TEMP = shortTmp
process.env.TMP = shortTmp
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const appDirectory = path.join(root, 'release', version, 'win-unpacked')
const outputDirectory = path.join(root, 'release', version, 'squirrel')

if (!existsSync(path.join(appDirectory, 'Sibyl.exe'))) {
  throw new Error(`win-unpacked not found at ${appDirectory} — run \`electron-builder --win --dir\` first.`)
}

// electron-winstaller's nuspec hard-references a file literally named `LICENSE`
// in the packaged dir; electron-builder only emits LICENSE.electron.txt, so copy
// the repo's LICENSE in.
copyFileSync(path.join(root, 'LICENSE'), path.join(appDirectory, 'LICENSE'))

console.log(`[squirrel] wrapping ${appDirectory}`)
console.log(`[squirrel]   -> ${outputDirectory}  (v${version})`)

await createWindowsInstaller({
  appDirectory,
  outputDirectory,
  // NuGet package id — MUST stay constant across versions for updates to chain.
  name: 'Sibyl',
  exe: 'Sibyl.exe',
  version,
  title: 'Sibyl',
  authors: 'Jon Howard',
  description: 'Download and chat with Hugging Face GGUF models locally on your GPU.',
  setupExe: 'SibylSetup.exe',
  setupIcon: path.join(root, 'build', 'icon.ico'),
  // Add/Remove Programs icon — Squirrel wants a URL (public repo raw file).
  iconUrl: 'https://raw.githubusercontent.com/jdhoward5/Sibyl/main/build/icon.ico',
  noMsi: true
})

console.log('[squirrel] done. Artifacts in', outputDirectory)

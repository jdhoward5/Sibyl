// Build and optionally publish an unsigned Apple Silicon Sibyl release. Every
// build runs in a disposable clean worktree; existing GitHub assets are compared
// byte-for-byte and are never overwritten.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const skipSmoke = process.argv.includes('--skip-smoke')
const replaceOutput = process.argv.includes('--replace-output')
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('release-mac.mjs must run on Apple Silicon macOS.')
}

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}.`)
  }
}

run(process.execPath, [
  'scripts/clean-release-build.mjs',
  '--mac',
  ...(skipSmoke ? ['--skip-smoke'] : []),
  ...(replaceOutput ? ['--replace-output'] : [])
])

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const output = path.join(root, 'release', version)
const assets = [
  path.join(output, `Sibyl-${version}-arm64.dmg`),
  path.join(output, `Sibyl-${version}-arm64.zip`),
  path.join(output, 'release-manifest-mac-arm64.json'),
  path.join(output, 'release-manifest-mac-arm64.sig'),
  path.join(output, 'sbom-mac-arm64.cdx.json'),
  path.join(output, 'package-inventory-mac-arm64.json'),
  path.join(output, 'SHA256SUMS-mac-arm64')
]
for (const asset of assets) {
  if (!existsSync(asset)) throw new Error(`Verified release asset is missing: ${asset}`)
}
run(process.execPath, [
  'scripts/publish-release-assets.mjs',
  ...assets.flatMap((asset) => ['--asset', asset]),
  ...(dryRun ? ['--dry-run'] : [])
])
process.stdout.write(
  dryRun
    ? '\nVerified unsigned macOS release built; nothing was published.\n'
    : `\nPublished verified unsigned macOS release v${version}.\n`
)

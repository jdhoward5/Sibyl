import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const assets = []
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--asset' && process.argv[index + 1]) {
    assets.push(path.resolve(process.argv[index + 1]))
  }
}
if (assets.length === 0) throw new Error('At least one --asset is required.')
for (const asset of assets) {
  if (!existsSync(asset)) throw new Error(`Release asset is missing: ${asset}`)
}
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tag = `v${version}`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? undefined : 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed.`)
  }
  return result
}

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const head = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim()
const tagCommit = run('git', ['rev-list', '-n', '1', tag], {
  capture: true,
  allowFailure: true
}).stdout.trim()
if (tagCommit && tagCommit !== head) throw new Error(`${tag} does not point at HEAD.`)
if (dryRun) {
  process.stdout.write(
    `Publishing dry run for ${tag}: ${assets.map((asset) => path.basename(asset)).join(', ')}\n`
  )
  process.exit(0)
}

const peeledRemote = run(
  'git',
  ['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`],
  { capture: true }
).stdout.trim().split(/\s+/)[0]
const directRemote =
  peeledRemote ||
  run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
    capture: true
  }).stdout.trim().split(/\s+/)[0]
if (directRemote && directRemote !== head) {
  throw new Error(`Remote ${tag} does not point at HEAD.`)
}

if (!tagCommit && !directRemote) {
  run('git', ['tag', '-a', tag, '-m', `Sibyl ${tag}`])
}
if (!directRemote) run('git', ['push', 'origin', tag])

const releaseExists =
  run('gh', ['release', 'view', tag], {
    capture: true,
    allowFailure: true
  }).status === 0
if (!releaseExists) {
  run('gh', [
    'release',
    'create',
    tag,
    ...assets,
    '--latest',
    '--generate-notes',
    '--title',
    `Sibyl ${tag}`
  ])
  process.stdout.write(`Published ${assets.length} assets to new release ${tag}.\n`)
  process.exit(0)
}

const remoteNames = new Set(
  JSON.parse(
    run('gh', ['release', 'view', tag, '--json', 'assets'], {
      capture: true
    }).stdout
  ).assets.map((asset) => asset.name)
)
const temporary = mkdtempSync(path.join(os.tmpdir(), 'sibyl-assets-'))
try {
  const upload = []
  for (const local of assets) {
    const name = path.basename(local)
    if (!remoteNames.has(name)) {
      upload.push(local)
      continue
    }
    run('gh', [
      'release',
      'download',
      tag,
      '--pattern',
      name,
      '--dir',
      temporary
    ])
    const remote = path.join(temporary, name)
    if (hash(local) !== hash(remote)) {
      throw new Error(
        `Release ${tag} already has a different asset named ${name}; refusing to clobber it.`
      )
    }
    process.stdout.write(`Existing ${name} matches byte-for-byte; leaving it unchanged.\n`)
  }
  if (upload.length > 0) {
    run('gh', ['release', 'upload', tag, ...upload])
    run('gh', ['workflow', 'run', 'release-provenance.yml', '-f', `tag=${tag}`])
  }
  run('gh', ['release', 'edit', tag, '--latest'])
  process.stdout.write(`Published ${upload.length} new assets to ${tag}.\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeSourceRoot = process.env.SIBYL_NATIVE_SOURCE_ROOT
  ? path.resolve(process.env.SIBYL_NATIVE_SOURCE_ROOT)
  : root
const outputArg = process.argv.indexOf('--output')
const outputPath =
  outputArg >= 0 && process.argv[outputArg + 1]
    ? path.resolve(process.argv[outputArg + 1])
    : undefined

function capture(command, args, cwd = root, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`
    )
  }
  return result
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(target))
    else if (entry.isFile()) result.push(target)
  }
  return result
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const lockPath = path.join(root, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const head = capture('git', ['rev-parse', 'HEAD']).stdout.trim()
const status = capture('git', [
  'status',
  '--porcelain',
  '--untracked-files=all'
]).stdout.trim()
if (status) {
  throw new Error('Release staging checkout is not clean after npm ci.')
}

for (const [name, expected] of [
  ['node-llama-cpp', '3.18.1'],
  ['hash-wasm', '4.12.0'],
  ['electron', '45.0.0'],
  ['simple-git', '4.0.2']
]) {
  const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.overrides?.[name]
  const installed = JSON.parse(
    readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')
  ).version
  const locked = lock.packages?.[`node_modules/${name}`]?.version
  if (declared !== expected || installed !== expected || locked !== expected) {
    throw new Error(
      `${name} must be exactly ${expected} (declared=${declared}, installed=${installed}, locked=${locked}).`
    )
  }
}

for (const patch of [
  'node-llama-cpp+3.18.1.patch',
  'simple-git+4.0.2.patch'
]) {
  if (!existsSync(path.join(root, 'patches', patch))) {
    throw new Error(`Required patch is missing: patches/${patch}`)
  }
}
const simpleGitSource = readFileSync(
  path.join(root, 'node_modules', 'simple-git', 'dist', 'index.mjs'),
  'utf8'
)
if (
  !simpleGitSource.includes('import fileExists from "@kwsites/file-exists"') ||
  !simpleGitSource.includes('const { exists: ke, FOLDER: _e } = fileExists')
) {
  throw new Error('The simple-git packaged-ESM compatibility patch is not applied.')
}
const patchedCmake = readFileSync(
  path.join(root, 'node_modules', 'node-llama-cpp', 'llama', 'CMakeLists.txt'),
  'utf8'
)
const patchedAddon = readFileSync(
  path.join(
    root,
    'node_modules',
    'node-llama-cpp',
    'llama',
    'addon',
    'AddonContext.cpp'
  ),
  'utf8'
)
if (
  !patchedCmake.includes('target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_17)') ||
  !patchedCmake.includes('target_link_libraries(${PROJECT_NAME} "llama-common")') ||
  !patchedAddon.includes('common_cpu_get_num_math()')
) {
  throw new Error('The node-llama-cpp b9616 compatibility patch is not applied.')
}

const llamaRoot = path.join(
  nativeSourceRoot,
  'node_modules',
  'node-llama-cpp',
  'llama'
)
const sourceInfo = JSON.parse(
  readFileSync(path.join(llamaRoot, 'llama.cpp.info.json'), 'utf8')
)
if (sourceInfo.tag !== 'b9616') {
  throw new Error(`Expected llama.cpp b9616, found ${sourceInfo.tag ?? 'unknown'}.`)
}
const lastBuild = JSON.parse(
  readFileSync(path.join(llamaRoot, 'lastBuild.json'), 'utf8')
)
const expectedBuild =
  process.platform === 'darwin'
    ? 'mac-arm64-metal-release-b9616'
    : 'win-x64-cuda-release-b9616'
if (lastBuild.folderName !== expectedBuild) {
  throw new Error(
    `Expected native build ${expectedBuild}, found ${lastBuild.folderName ?? 'unknown'}.`
  )
}
const releaseDir = path.join(
  llamaRoot,
  'localBuilds',
  expectedBuild,
  'Release'
)
const nativeFiles = filesUnder(releaseDir).filter((file) =>
  /\.(?:node|dll|dylib)$/i.test(file)
)
if (
  nativeFiles.length === 0 ||
  !nativeFiles.some((file) => /llama-addon\.node$/i.test(file))
) {
  throw new Error(`Audited b9616 runtime is missing from ${releaseDir}.`)
}
const nativeHashes = nativeFiles
  .map((file) => ({
    path: path.relative(releaseDir, file).replaceAll('\\', '/'),
    bytes: statSync(file).size,
    sha256: sha256File(file)
  }))
  .sort((a, b) => a.path.localeCompare(b.path))

const tag = `v${pkg.version}`
const localTag = capture(
  'git',
  ['rev-list', '-n', '1', tag],
  root,
  true
).stdout.trim()
if (localTag && localTag !== head) {
  throw new Error(`Local tag ${tag} does not point at HEAD.`)
}
const remote = capture(
  'git',
  ['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`],
  root,
  true
)
if (remote.status !== 0) {
  throw new Error('Could not verify the version tag against the origin remote.')
}
let remoteTag = remote.stdout.trim().split(/\s+/)[0]
if (!remoteTag) {
  const lightweight = capture(
    'git',
    ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`],
    root,
    true
  )
  if (lightweight.status !== 0) {
    throw new Error('Could not verify the version tag against the origin remote.')
  }
  remoteTag = lightweight.stdout.trim().split(/\s+/)[0]
}
if (remoteTag && remoteTag !== head) {
  throw new Error(`Remote tag ${tag} does not point at HEAD.`)
}
if (localTag && remoteTag && localTag !== remoteTag) {
  throw new Error(`Local and remote ${tag} disagree.`)
}

const report = {
  schema: 'sibyl.release-preflight',
  version: 1,
  commit: head,
  tag,
  lockfile: {
    sha256: sha256File(lockPath),
    lockfileVersion: lock.lockfileVersion
  },
  dependencies: {
    'node-llama-cpp': '3.18.1',
    'hash-wasm': '4.12.0',
    electron: '45.0.0',
    'simple-git': '4.0.2'
  },
  patches: [
    'patches/node-llama-cpp+3.18.1.patch',
    'patches/simple-git+4.0.2.patch'
  ],
  backend: {
    repository: sourceInfo.llamaCppGithubRepo,
    revision: sourceInfo.tag,
    build: expectedBuild,
    files: nativeHashes
  },
  tags: {
    local: localTag || null,
    remote: remoteTag || null
  },
  toolchain: {
    node: process.version,
    npm: capture(process.execPath, [
      process.env.npm_execpath ??
        path.join(
          path.dirname(process.execPath),
          'node_modules',
          'npm',
          'bin',
          'npm-cli.js'
        ),
      '--version'
    ]).stdout.trim(),
    platform: process.platform,
    arch: process.arch
  }
}

const serialized = `${JSON.stringify(report, null, 2)}\n`
if (outputPath) writeFileSync(outputPath, serialized, 'utf8')
else process.stdout.write(serialized)

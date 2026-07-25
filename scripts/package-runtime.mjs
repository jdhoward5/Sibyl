import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeSourceRoot = process.env.SIBYL_NATIVE_SOURCE_ROOT
  ? path.resolve(process.env.SIBYL_NATIVE_SOURCE_ROOT)
  : root
const require = createRequire(import.meta.url)
const platform = process.argv[2]
if (platform !== 'win' && platform !== 'mac') {
  throw new Error('Usage: node scripts/package-runtime.mjs <win|mac>')
}

const stage = mkdtempSync(path.join(path.dirname(root), '.sibyl-runtime-'))

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`)
  }
}

function pruneRuntimeTree(directory) {
  const removableDirectories = new Set([
    '.github',
    '.idea',
    '.vscode',
    '__tests__',
    'doc',
    'docs',
    'example',
    'examples',
    'patches',
    'script',
    'scripts',
    'test',
    'tests'
  ])
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (removableDirectories.has(entry.name)) {
        rmSync(target, { recursive: true, force: true })
      } else {
        pruneRuntimeTree(target)
      }
      continue
    }
    if (!entry.isFile()) continue
    if (
      /\.(?:d\.ts|map|md|ts|tsx)$/i.test(entry.name) ||
      /\.(?:pem|p12|pfx|key)$/i.test(entry.name)
    ) {
      rmSync(target, { force: true })
    }
  }
}

try {
  const npmCli =
    process.env.npm_execpath ??
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  run(process.execPath, [npmCli, 'run', 'build'])
  const sourcePackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const runtimePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    description: sourcePackage.description,
    author: sourcePackage.author,
    license: sourcePackage.license,
    main: sourcePackage.main,
    type: sourcePackage.type,
    dependencies: sourcePackage.dependencies,
    overrides: sourcePackage.overrides
  }
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
    'utf8'
  )
  cpSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'))
  cpSync(path.join(root, 'out'), path.join(stage, 'out'), { recursive: true })
  cpSync(path.join(root, 'build'), path.join(stage, 'build'), { recursive: true })
  run(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    stage
  )
  cpSync(path.join(root, 'patches'), path.join(stage, 'patches'), { recursive: true })
  run(
    process.execPath,
    [
      path.join(root, 'node_modules', 'patch-package', 'index.js'),
      '--error-on-fail'
    ],
    stage
  )
  // Custom b9616 builds are intentionally not committed. A clean release
  // worktree therefore imports only those audited native outputs from the
  // platform build host's original checkout.
  const sourceLlama = path.join(
    nativeSourceRoot,
    'node_modules',
    'node-llama-cpp',
    'llama'
  )
  const stagedLlama = path.join(stage, 'node_modules', 'node-llama-cpp', 'llama')
  const localBuilds = path.join(sourceLlama, 'localBuilds')
  if (!existsSync(localBuilds) || !statSync(localBuilds).isDirectory()) {
    throw new Error('The required custom llama.cpp local build is missing.')
  }
  cpSync(localBuilds, path.join(stagedLlama, 'localBuilds'), { recursive: true })
  for (const name of ['lastBuild.json', 'llama.cpp.info.json']) {
    cpSync(path.join(sourceLlama, name), path.join(stagedLlama, name))
  }
  pruneRuntimeTree(path.join(stage, 'node_modules'))
  rmSync(path.join(stage, 'patches'), { recursive: true, force: true })

  const output = path.join(root, 'release', sourcePackage.version)
  const { version: electronVersion } = JSON.parse(
    readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
  )
  run(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    platform === 'win' ? '--win' : '--mac',
    ...(platform === 'win' ? ['--dir'] : ['--arm64']),
    '--projectDir',
    stage,
    '--config',
    path.join(root, 'electron-builder.yml'),
    `--config.electronVersion=${electronVersion}`,
    `--config.directories.output=${output}`
  ])
  if (platform === 'win') {
    run(process.execPath, ['scripts/inspect-package.mjs'])
  } else {
    run(process.execPath, [
      'scripts/inspect-package.mjs',
      `release/${sourcePackage.version}/mac-arm64/Sibyl.app`
    ])
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}

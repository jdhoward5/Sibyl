import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCli =
  process.env.npm_execpath ??
  (process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined)
const platformArg = process.argv.includes('--mac') ? 'mac-arm64' : 'win-x64'
const skipSmoke = process.argv.includes('--skip-smoke')
const replaceOutput = process.argv.includes('--replace-output')
if (platformArg === 'mac-arm64' && process.platform !== 'darwin') {
  throw new Error('The macOS release must be built on Apple Silicon macOS.')
}
if (platformArg === 'win-x64' && process.platform !== 'win32') {
  throw new Error('The Windows release must be built on x64 Windows.')
}
if (process.arch !== (platformArg === 'mac-arm64' ? 'arm64' : 'x64')) {
  throw new Error(`The ${platformArg} release must be built on matching hardware.`)
}

function run(command, args, options = {}) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: options.timeout
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}.`)
  }
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`)
  return result.stdout.trim()
}

function runNpm(args, options = {}) {
  if (npmCli) {
    if (!existsSync(npmCli)) {
      throw new Error(`Unable to locate the npm CLI at ${npmCli}.`)
    }
    run(process.execPath, [npmCli, ...args], options)
    return
  }
  run('npm', args, options)
}

function findFirst(directory, pattern) {
  if (!existsSync(directory)) return undefined
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = findFirst(target, pattern)
      if (nested) return nested
    } else if (entry.isFile() && pattern.test(entry.name)) {
      return target
    }
  }
  return undefined
}

const dirty = capture('git', ['status', '--porcelain', '--untracked-files=all'])
if (dirty) {
  throw new Error(
    'Release builds require a clean source checkout. Commit or stash every change first.'
  )
}
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const finalOutput = path.resolve(root, 'release', version)
const allowedReleaseRoot = `${path.resolve(root, 'release')}${path.sep}`
if (!finalOutput.startsWith(allowedReleaseRoot)) {
  throw new Error('Refusing to use a release output outside the repository release directory.')
}
if (existsSync(finalOutput) && !replaceOutput) {
  throw new Error(
    `${finalOutput} already exists. Remove it or explicitly pass --replace-output.`
  )
}

const temporaryParent =
  process.platform === 'win32'
    ? path.join(process.env.SystemDrive || path.parse(root).root, 'sqtmp')
    : os.tmpdir()
mkdirSync(temporaryParent, { recursive: true })
const temporaryRoot = mkdtempSync(path.join(temporaryParent, 'sibyl-release-'))
const checkout = path.join(temporaryRoot, 'checkout')
const smokeProfile = path.join(temporaryRoot, 'profile')
const smokeOutput = path.join(temporaryRoot, 'smoke-output')
let worktreeAdded = false
let releaseError
try {
  run('git', ['worktree', 'add', '--detach', checkout, 'HEAD'])
  worktreeAdded = true
  runNpm(['ci'], { cwd: checkout, timeout: 20 * 60_000 })

  const stageEnv = {
    ...process.env,
    SIBYL_NATIVE_SOURCE_ROOT:
      process.env.SIBYL_NATIVE_SOURCE_ROOT ?? root,
    SOURCE_DATE_EPOCH: capture('git', ['show', '-s', '--format=%ct', 'HEAD'])
  }
  const preflight = path.join(temporaryRoot, 'release-preflight.json')
  run(
    process.execPath,
    ['scripts/release-preflight.mjs', '--output', preflight],
    { cwd: checkout, env: stageEnv }
  )
  for (const args of [
    ['run', 'lint'],
    ['run', 'typecheck'],
    ['test'],
    ['run', 'audit:production'],
    ['run', 'build'],
    ['run', 'test:e2e'],
    ['run', 'test:passkey']
  ]) {
    runNpm(args, { cwd: checkout, env: stageEnv, timeout: 20 * 60_000 })
  }

  if (!skipSmoke) {
    runNpm(['run', 'smoke'], {
      cwd: checkout,
      env: stageEnv,
      timeout: 20 * 60_000
    })
  }
  runNpm(['run', platformArg === 'win-x64' ? 'dist' : 'dist:mac'], {
    cwd: checkout,
    env: stageEnv,
    timeout: 45 * 60_000
  })

  const stagedOutput = path.join(checkout, 'release', version)
  const packageDir =
    platformArg === 'win-x64'
      ? path.join(stagedOutput, 'win-unpacked')
      : path.join(stagedOutput, 'mac-arm64', 'Sibyl.app')
  if (!skipSmoke) {
    const model = findFirst(path.join(checkout, '.smoke-models'), /\.gguf$/i)
    if (!model) throw new Error('The smoke model was not downloaded.')
    mkdirSync(smokeProfile, { recursive: true })
    mkdirSync(smokeOutput, { recursive: true })
    const executable =
      platformArg === 'win-x64'
        ? path.join(packageDir, 'Sibyl.exe')
        : path.join(packageDir, 'Contents', 'MacOS', 'Sibyl')
    run(executable, [`--user-data-dir=${smokeProfile}`], {
      cwd: checkout,
      env: {
        ...stageEnv,
        SIBYL_SMOKE: '1',
        SIBYL_SMOKE_MODEL: model,
        SIBYL_SMOKE_OUT: smokeOutput
      },
      timeout: 5 * 60_000
    })
    if (!findFirst(smokeOutput, /\.png$/i)) {
      throw new Error('Packaged smoke completed without its evidence screenshot.')
    }
  }

  const artifactArgs =
    platformArg === 'win-x64'
      ? [
          path.join(stagedOutput, 'squirrel', 'SibylSetup.exe'),
          path.join(stagedOutput, 'squirrel', `Sibyl-${version}-full.nupkg`),
          path.join(stagedOutput, 'squirrel', 'RELEASES')
        ]
        : [
          path.join(stagedOutput, `Sibyl-${version}-arm64.dmg`),
          path.join(stagedOutput, `Sibyl-${version}-arm64.zip`)
        ].filter((artifact) => existsSync(artifact))
  run(
    process.execPath,
    [
      'scripts/release-manifest.mjs',
      '--platform',
      platformArg,
      '--output',
      stagedOutput,
      '--package-dir',
      packageDir,
      '--preflight',
      preflight,
      ...artifactArgs.flatMap((artifact) => ['--artifact', artifact])
    ],
    { cwd: checkout, env: stageEnv, timeout: 20 * 60_000 }
  )
  run(
    process.execPath,
    [
      'scripts/verify-release-manifest.mjs',
      path.join(stagedOutput, `release-manifest-${platformArg}.json`),
      path.join(stagedOutput, `release-manifest-${platformArg}.sig`)
    ],
    { cwd: checkout, env: stageEnv }
  )

  if (existsSync(finalOutput)) {
    rmSync(finalOutput, { recursive: true, force: true })
  }
  mkdirSync(path.dirname(finalOutput), { recursive: true })
  cpSync(stagedOutput, finalOutput, { recursive: true })
  process.stdout.write(`\nVerified release copied to ${finalOutput}\n`)
} catch (error) {
  releaseError = error
} finally {
  if (worktreeAdded) {
    try {
      run('git', ['worktree', 'remove', '--force', checkout])
    } catch (error) {
      releaseError ??= error
      process.stderr.write(`Release worktree cleanup failed: ${error.message}\n`)
    }
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true })
  } catch (error) {
    releaseError ??= error
    process.stderr.write(`Release temporary-directory cleanup failed: ${error.message}\n`)
  }
}
if (releaseError) throw releaseError

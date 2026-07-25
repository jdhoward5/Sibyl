import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

function arg(name, required = false) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (required && !value) throw new Error(`Missing ${name}.`)
  return value
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function describe(file, base = path.dirname(file)) {
  const bytes = readFileSync(file)
  return {
    path: path.relative(base, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: sha256(bytes)
  }
}

function filesUnder(directory) {
  const output = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...filesUnder(target))
    else if (entry.isFile()) output.push(target)
  }
  return output
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed.`)
  }
  return result.stdout.trim()
}

const platform = arg('--platform', true)
if (!['win-x64', 'mac-arm64'].includes(platform)) {
  throw new Error('--platform must be win-x64 or mac-arm64.')
}
const outputDir = path.resolve(arg('--output', true))
const packageDir = path.resolve(arg('--package-dir', true))
const preflightPath = path.resolve(arg('--preflight', true))
const artifactArgs = []
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--artifact' && process.argv[i + 1]) {
    artifactArgs.push(path.resolve(process.argv[i + 1]))
  }
}
if (artifactArgs.length === 0) throw new Error('At least one --artifact is required.')
for (const file of artifactArgs) {
  if (!existsSync(file)) throw new Error(`Artifact is missing: ${file}`)
}

mkdirSync(outputDir, { recursive: true })
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'))
const commitTimestamp = capture('git', ['show', '-s', '--format=%cI', 'HEAD'])

function npmPurl(name, version) {
  if (name.startsWith('@') && name.includes('/')) {
    const separator = name.indexOf('/')
    return `pkg:npm/${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}@${encodeURIComponent(version)}`
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

const archivePath =
  platform === 'win-x64'
    ? path.join(packageDir, 'resources', 'app.asar')
    : path.join(packageDir, 'Contents', 'Resources', 'app.asar')
if (!existsSync(archivePath)) {
  throw new Error(`Packaged application archive is missing: ${archivePath}`)
}
const componentsByRef = new Map()
for (const entry of asar.listPackage(archivePath)) {
  const normalized = entry.replaceAll('\\', '/')
  if (
    !normalized.startsWith('/node_modules/') ||
    !normalized.endsWith('/package.json')
  ) {
    continue
  }
  let installed
  try {
    installed = JSON.parse(
      asar.extractFile(archivePath, entry.slice(1)).toString('utf8')
    )
  } catch {
    continue
  }
  if (
    typeof installed.name !== 'string' ||
    typeof installed.version !== 'string'
  ) {
    continue
  }
  const bomRef = npmPurl(installed.name, installed.version)
  if (componentsByRef.has(bomRef)) continue
  componentsByRef.set(bomRef, {
    type: 'library',
    name: installed.name,
    version: installed.version,
    ...(typeof installed.license === 'string'
      ? { licenses: [{ license: { name: installed.license } }] }
      : {}),
    'bom-ref': bomRef
  })
}
const components = [...componentsByRef.values()].sort((a, b) =>
  a['bom-ref'].localeCompare(b['bom-ref'])
)
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${sha256(`${preflight.commit}:${platform}`).slice(0, 8)}-${sha256(`${preflight.commit}:${platform}`).slice(8, 12)}-4${sha256(`${preflight.commit}:${platform}`).slice(13, 16)}-a${sha256(`${preflight.commit}:${platform}`).slice(17, 20)}-${sha256(`${preflight.commit}:${platform}`).slice(20, 32)}`,
  version: 1,
  metadata: {
    timestamp: commitTimestamp,
    component: { type: 'application', name: pkg.name, version: pkg.version }
  },
  components
}
const sbomPath = path.join(outputDir, `sbom-${platform}.cdx.json`)
writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8')

const inventory = filesUnder(packageDir)
  .map((file) => describe(file, packageDir))
  .sort((a, b) => a.path.localeCompare(b.path))
for (const native of preflight.backend.files) {
  const suffix = `node_modules/node-llama-cpp/llama/localBuilds/${preflight.backend.build}/Release/${native.path}`
  const packaged = inventory.find((entry) =>
    entry.path.replaceAll('\\', '/').endsWith(suffix)
  )
  if (!packaged || packaged.sha256 !== native.sha256) {
    throw new Error(
      `Packaged native runtime does not match the audited source: ${native.path}`
    )
  }
}
const inventoryPath = path.join(outputDir, `package-inventory-${platform}.json`)
writeFileSync(
  inventoryPath,
  `${JSON.stringify(
    {
      schema: 'sibyl.package-inventory',
      version: 1,
      platform,
      commit: preflight.commit,
      files: inventory
    },
    null,
    2
  )}\n`,
  'utf8'
)

const artifactBase = path.dirname(artifactArgs[0])
const artifacts = artifactArgs
  .map((file) => describe(file, artifactBase))
  .sort((a, b) => a.path.localeCompare(b.path))
const manifest = {
  schema: 'sibyl.release-manifest',
  version: 1,
  appVersion: pkg.version,
  tag: `v${pkg.version}`,
  platform,
  arch: platform.endsWith('arm64') ? 'arm64' : 'x64',
  commit: preflight.commit,
  commitTimestamp,
  unsignedPlatformArtifact: true,
  lockfile: preflight.lockfile,
  toolchain: {
    ...preflight.toolchain,
    electron: preflight.dependencies.electron,
    electronBuilder: JSON.parse(
      readFileSync(
        path.join(root, 'node_modules', 'electron-builder', 'package.json'),
        'utf8'
      )
    ).version
  },
  dependencies: preflight.dependencies,
  patches: preflight.patches,
  backend: preflight.backend,
  sbom: describe(sbomPath, outputDir),
  packageInventory: describe(inventoryPath, outputDir),
  artifacts
}
const manifestPath = path.join(outputDir, `release-manifest-${platform}.json`)
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(manifestPath, manifestBytes)

const keyDir =
  process.env.SIBYL_RELEASE_KEY_DIR ??
  path.join(os.homedir(), '.sibyl-release')
const privatePath = path.join(keyDir, 'manifest-signing-key.pem')
const trustedPublicPath = path.join(root, 'build', 'release-manifest-public.pem')
const privateKey = createPrivateKey(readFileSync(privatePath))
const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
const trustedDer = createPublicKey(readFileSync(trustedPublicPath)).export({
  type: 'spki',
  format: 'der'
})
if (!Buffer.from(publicDer).equals(Buffer.from(trustedDer))) {
  throw new Error('Offline release key does not match the public key embedded in Sibyl.')
}
const keyId = sha256(publicDer).slice(0, 32)
const signaturePath = path.join(outputDir, `release-manifest-${platform}.sig`)
writeFileSync(
  signaturePath,
  `${JSON.stringify(
    {
      algorithm: 'Ed25519',
      keyId,
      signature: sign(null, manifestBytes, privateKey).toString('base64')
    },
    null,
    2
  )}\n`,
  'utf8'
)

const checksumFiles = [
  ...artifactArgs,
  sbomPath,
  inventoryPath,
  manifestPath,
  signaturePath
]
const sumsPath = path.join(outputDir, `SHA256SUMS-${platform}`)
writeFileSync(
  sumsPath,
  `${checksumFiles
    .map((file) => `${sha256(readFileSync(file))}  ${path.basename(file)}`)
    .sort()
    .join('\n')}\n`,
  'utf8'
)
process.stdout.write(
  `Signed ${path.basename(manifestPath)} (${keyId}); inventoried ${inventory.length} files and ${components.length} production components.\n`
)

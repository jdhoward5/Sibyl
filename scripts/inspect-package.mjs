import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const appDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'release', version, process.platform === 'darwin' ? 'mac-arm64' : 'win-unpacked')
const resources = path.join(appDir, appDir.endsWith('.app') ? 'Contents/Resources' : 'resources')
const archive = path.join(resources, 'app.asar')
const unpacked = `${archive}.unpacked`

function fail(message) {
  throw new Error(`Package inspection failed: ${message}`)
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(target))
    else if (entry.isFile()) out.push(target)
  }
  return out
}

if (!existsSync(archive)) fail(`missing ${archive}`)
const archiveBytes = statSync(archive).size
if (archiveBytes < 1_000_000 || archiveBytes > 100_000_000) {
  fail(`app.asar size ${archiveBytes} is outside the reviewed 1–100 MB band`)
}
const packageBytes = filesUnder(appDir).reduce((total, file) => total + statSync(file).size, 0)
if (packageBytes < 300_000_000 || packageBytes > 1_500_000_000) {
  fail(`unpacked app size ${packageBytes} is outside the reviewed 300 MB–1.5 GB band`)
}

const entries = asar.listPackage(archive).map((entry) => entry.replaceAll('\\', '/'))
const runtimeManifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
if (runtimeManifest.scripts || runtimeManifest.devDependencies) {
  fail('runtime package manifest contains scripts or development dependencies')
}
if (
  runtimeManifest.dependencies?.['node-llama-cpp'] !== '3.18.1' ||
  runtimeManifest.dependencies?.['hash-wasm'] !== '4.12.0'
) {
  fail('patch-coupled or cryptographic runtime dependencies are not pinned exactly')
}
const required = [
  '/out/main/index.js',
  '/out/preload/index.cjs',
  '/out/renderer/index.html',
  '/package.json',
  '/build/release-manifest-public.pem',
  '/node_modules/hash-wasm/package.json',
  '/node_modules/@kwsites/file-exists/dist/src/index.js',
  '/node_modules/node-llama-cpp/package.json',
  '/node_modules/onnxruntime-node/package.json',
  '/node_modules/phonemizer/package.json'
]
for (const expected of required) {
  if (!entries.includes(expected)) fail(`missing required runtime entry ${expected}`)
}

const allowedRoots = new Set(['/out', '/build', '/package.json', '/node_modules'])
for (const entry of entries) {
  const rootEntry = `/${entry.split('/').filter(Boolean)[0] ?? ''}`
  if (!allowedRoots.has(rootEntry)) fail(`unexpected application-root entry ${entry}`)
}
const buildEntries = entries.filter((entry) => entry.startsWith('/build/'))
if (
  buildEntries.length !== 1 ||
  buildEntries[0] !== '/build/release-manifest-public.pem'
) {
  fail(`unexpected packaged build resource: ${buildEntries.join(', ')}`)
}

const forbidden = [
  /\/(?:test|tests|__tests__|docs?|examples?|scripts?|patches)(?:\/|$)/i,
  /\.(?:map|ts|tsx)$/i,
  /\/\.(?:git|github|vscode|idea|smoke-models)(?:\/|$)/i,
  /(?:^|\/)(?:credentials?|secrets?)(?:[._-]|$)/i,
  /\.(?:pem|p12|pfx|key)$/i
]
for (const entry of entries) {
  if (entry === '/build/release-manifest-public.pem') continue
  // `debug` is one of the few production packages whose declared runtime entry
  // intentionally lives in a directory named src.
  if (entry.includes('/node_modules/debug/src/')) continue
  if (forbidden.some((pattern) => pattern.test(entry))) {
    fail(`forbidden packaged path ${entry}`)
  }
}

const nativeFiles = filesUnder(unpacked).map((file) =>
  path.relative(unpacked, file).replaceAll('\\', '/')
)
for (const entry of nativeFiles) {
  if (entry.includes('/node_modules/debug/src/')) continue
  if (forbidden.some((pattern) => pattern.test(`/${entry}`))) {
    fail(`forbidden unpacked path /${entry}`)
  }
}
const platform = process.platform
if (!nativeFiles.some((file) => /onnxruntime_binding\.node$/i.test(file))) {
  fail('onnxruntime native binding is not unpacked')
}
if (!nativeFiles.some((file) => /llama-addon\.node$/i.test(file))) {
  fail('llama native binding is not unpacked')
}
if (
  !nativeFiles.some(
    (file) =>
      file.includes('node-llama-cpp/llama/localBuilds/') &&
      /\/Release\/.*(?:llama-addon\.node|\.dylib|\.dll)$/i.test(file)
  )
) {
  fail('custom b9616 local backend runtime is missing')
}
if (platform === 'win32' && nativeFiles.some((file) => file.includes('/darwin/'))) {
  fail('Windows package contains a Darwin native runtime')
}
if (platform === 'darwin' && nativeFiles.some((file) => file.includes('/win32/'))) {
  fail('macOS package contains a Windows native runtime')
}

process.stdout.write(
  `Package inspection passed: ${entries.length} asar entries, ${nativeFiles.length} unpacked native files, ${(archiveBytes / 1024 / 1024).toFixed(1)} MB asar, ${(packageBytes / 1024 / 1024).toFixed(1)} MB unpacked app.\n`
)

import {
  createHash,
  createPublicKey,
  verify
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = process.argv[2]
const signaturePath = process.argv[3]
const publicKeyPath =
  process.argv[4] ?? path.join(root, 'build', 'release-manifest-public.pem')

if (!manifestPath || !signaturePath) {
  throw new Error(
    'Usage: node scripts/verify-release-manifest.mjs <manifest.json> <manifest.sig> [public.pem]'
  )
}

const manifest = readFileSync(path.resolve(manifestPath))
const signatureEnvelope = JSON.parse(
  readFileSync(path.resolve(signaturePath), 'utf8')
)
if (
  signatureEnvelope.algorithm !== 'Ed25519' ||
  typeof signatureEnvelope.keyId !== 'string' ||
  typeof signatureEnvelope.signature !== 'string'
) {
  throw new Error('Release signature envelope is invalid.')
}
const publicKeyBytes = readFileSync(path.resolve(publicKeyPath))
const publicKey = createPublicKey(publicKeyBytes)
const keyId = createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')
  .slice(0, 32)
if (keyId !== signatureEnvelope.keyId) {
  throw new Error('Release signature key id does not match the trusted public key.')
}
if (
  !verify(
    null,
    manifest,
    publicKey,
    Buffer.from(signatureEnvelope.signature, 'base64')
  )
) {
  throw new Error('Release manifest signature verification failed.')
}
process.stdout.write(`Verified Ed25519 release manifest (${keyId}).\n`)


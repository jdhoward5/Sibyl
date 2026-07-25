import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const keyDir =
  process.env.SIBYL_RELEASE_KEY_DIR ??
  path.join(os.homedir(), '.sibyl-release')
const privatePath = path.join(keyDir, 'manifest-signing-key.pem')
const init = process.argv.includes('--init')
const printPublic = process.argv.includes('--public-key') || init

if (init) {
  if (existsSync(privatePath)) {
    throw new Error(`Release signing key already exists at ${privatePath}`)
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    privatePath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  )
  try {
    chmodSync(keyDir, 0o700)
    chmodSync(privatePath, 0o600)
  } catch {
    // Windows ACLs are inherited from the user profile; POSIX modes are best
    // effort there. The private key is never copied into the repository.
  }
}

if (!existsSync(privatePath)) {
  throw new Error(
    `Release signing key not found at ${privatePath}. Run ` +
      '`node scripts/release-key.mjs --init` on the offline release machine.'
  )
}

const privateKey = createPrivateKey(readFileSync(privatePath))
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('The release signing key must be Ed25519.')
}
if (printPublic) {
  process.stdout.write(
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  )
}


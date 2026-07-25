import { createHash, createPublicKey, verify } from 'node:crypto'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_SIGNATURE_BYTES = 16 * 1024
const MAX_RELEASES_BYTES = 2 * 1024 * 1024

export interface VerifiedReleaseFeed {
  version: string
  commit: string
  releasesSha256: string
}

interface ReleaseArtifact {
  path: string
  bytes: number
  sha256: string
}

interface ReleaseManifest {
  schema: string
  version: number
  appVersion: string
  platform: string
  commit: string
  artifacts: ReleaseArtifact[]
}

interface SignatureEnvelope {
  algorithm: string
  keyId: string
  signature: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T
  } catch {
    throw new Error(`The ${label} is not valid JSON.`)
  }
}

async function fetchBounded(
  url: string,
  maximum: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal,
    headers: { Accept: 'application/octet-stream' }
  })
  if (!response.ok) {
    throw new Error(`Release provenance fetch failed (${response.status}).`)
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maximum) {
    throw new Error('Release provenance exceeds its size limit.')
  }
  if (!response.body) {
    throw new Error('Release provenance has an invalid size.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    let complete = false
    while (!complete) {
      const result = await reader.read()
      if (result.done) {
        complete = true
        continue
      }
      received += result.value.byteLength
      if (received > maximum) {
        await reader.cancel()
        throw new Error('Release provenance exceeds its size limit.')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (received === 0) {
    throw new Error('Release provenance has an invalid size.')
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function verifyWindowsReleaseFeed(options: {
  baseUrl: string
  trustedPublicKey: Uint8Array
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<VerifiedReleaseFeed> {
  const fetchImpl = options.fetchImpl ?? fetch
  const [manifestBytes, signatureBytes, releasesBytes] = await Promise.all([
    fetchBounded(
      `${options.baseUrl}/release-manifest-win-x64.json`,
      MAX_MANIFEST_BYTES,
      fetchImpl,
      options.signal
    ),
    fetchBounded(
      `${options.baseUrl}/release-manifest-win-x64.sig`,
      MAX_SIGNATURE_BYTES,
      fetchImpl,
      options.signal
    ),
    fetchBounded(
      `${options.baseUrl}/RELEASES`,
      MAX_RELEASES_BYTES,
      fetchImpl,
      options.signal
    )
  ])
  const manifest = parseJson<ReleaseManifest>(manifestBytes, 'release manifest')
  const envelope = parseJson<SignatureEnvelope>(
    signatureBytes,
    'release signature'
  )
  if (
    manifest.schema !== 'sibyl.release-manifest' ||
    manifest.version !== 1 ||
    manifest.platform !== 'win-x64' ||
    typeof manifest.appVersion !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(manifest.commit) ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error('The signed release manifest has an invalid schema.')
  }
  if (
    envelope.algorithm !== 'Ed25519' ||
    !/^[0-9a-f]{32}$/.test(envelope.keyId) ||
    typeof envelope.signature !== 'string'
  ) {
    throw new Error('The release signature envelope is invalid.')
  }
  const publicKey = createPublicKey(Buffer.from(options.trustedPublicKey))
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const keyId = sha256(publicDer).slice(0, 32)
  if (keyId !== envelope.keyId) {
    throw new Error('The release signature uses an untrusted key.')
  }
  if (
    !verify(
      null,
      manifestBytes,
      publicKey,
      Buffer.from(envelope.signature, 'base64')
    )
  ) {
    throw new Error('The release manifest signature is invalid.')
  }
  const seen = new Set<string>()
  for (const artifact of manifest.artifacts) {
    const name = artifact.path.split('/').at(-1)
    if (
      !name ||
      seen.has(name) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) {
      throw new Error('The signed release artifact inventory is invalid.')
    }
    seen.add(name)
  }
  const releases = manifest.artifacts.find(
    (artifact) => artifact.path.split('/').at(-1) === 'RELEASES'
  )
  if (!releases || releases.bytes !== releasesBytes.byteLength) {
    throw new Error('The signed manifest does not describe this update feed.')
  }
  const releasesSha256 = sha256(releasesBytes)
  if (releases.sha256 !== releasesSha256) {
    throw new Error('The update feed does not match its signed manifest.')
  }
  if (
    !manifest.artifacts.some((artifact) =>
      /-full\.nupkg$/i.test(artifact.path)
    )
  ) {
    throw new Error('The signed update package is missing.')
  }
  return {
    version: manifest.appVersion,
    commit: manifest.commit,
    releasesSha256
  }
}

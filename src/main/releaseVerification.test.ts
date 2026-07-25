import {
  createHash,
  generateKeyPairSync,
  sign
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWindowsReleaseFeed } from './releaseVerification'

function fixture(overrides?: {
  releases?: Uint8Array
  mutateManifestAfterSigning?: boolean
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const releases = overrides?.releases ?? Buffer.from('abc  Sibyl-1.2.3-full.nupkg\n')
  const manifest = {
    schema: 'sibyl.release-manifest',
    version: 1,
    appVersion: '1.2.3',
    platform: 'win-x64',
    commit: 'a'.repeat(40),
    artifacts: [
      {
        path: 'RELEASES',
        bytes: releases.length,
        sha256: createHash('sha256').update(releases).digest('hex')
      },
      {
        path: 'Sibyl-1.2.3-full.nupkg',
        bytes: 42,
        sha256: 'b'.repeat(64)
      }
    ]
  }
  const original = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const keyId = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 32)
  const signature = Buffer.from(
    JSON.stringify({
      algorithm: 'Ed25519',
      keyId,
      signature: sign(null, original, privateKey).toString('base64')
    })
  )
  const manifestBytes = overrides?.mutateManifestAfterSigning
    ? Buffer.from(original.toString().replace('1.2.3', '9.9.9'))
    : original
  const publicPem = Buffer.from(
    publicKey.export({ type: 'spki', format: 'pem' })
  )
  const responses = new Map([
    ['release-manifest-win-x64.json', manifestBytes],
    ['release-manifest-win-x64.sig', signature],
    ['RELEASES', releases]
  ])
  const fetchImpl = async (url: string | URL | Request) => {
    const name = String(url).split('/').at(-1) ?? ''
    const body = responses.get(name)
    const responseBody = body ? new Uint8Array(body).buffer : null
    return new Response(responseBody, { status: body ? 200 : 404 })
  }
  return { publicPem, fetchImpl }
}

describe('verifyWindowsReleaseFeed', () => {
  it('authenticates the manifest and binds the Squirrel feed bytes', async () => {
    const value = fixture()
    await expect(
      verifyWindowsReleaseFeed({
        baseUrl: 'https://example.test',
        trustedPublicKey: value.publicPem,
        fetchImpl: value.fetchImpl as typeof fetch
      })
    ).resolves.toMatchObject({
      version: '1.2.3',
      commit: 'a'.repeat(40)
    })
  })

  it('rejects a manifest changed after signing', async () => {
    const value = fixture({ mutateManifestAfterSigning: true })
    await expect(
      verifyWindowsReleaseFeed({
        baseUrl: 'https://example.test',
        trustedPublicKey: value.publicPem,
        fetchImpl: value.fetchImpl as typeof fetch
      })
    ).rejects.toThrow('signature')
  })

  it('rejects update feed bytes not named by the signed manifest', async () => {
    const value = fixture()
    const tamperedFetch = async (url: string | URL | Request) => {
      if (String(url).endsWith('/RELEASES')) {
        return new Response('tampered', { status: 200 })
      }
      return value.fetchImpl(url)
    }
    await expect(
      verifyWindowsReleaseFeed({
        baseUrl: 'https://example.test',
        trustedPublicKey: value.publicPem,
        fetchImpl: tamperedFetch as typeof fetch
      })
    ).rejects.toThrow(/signed manifest|does not match/)
  })

  it('stops reading an oversized response without relying on Content-Length', async () => {
    const oversizedFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024))
            controller.enqueue(new Uint8Array(1024 * 1024 + 1))
            controller.close()
          }
        }),
        { status: 200 }
      )
    await expect(
      verifyWindowsReleaseFeed({
        baseUrl: 'https://example.test',
        trustedPublicKey: fixture().publicPem,
        fetchImpl: oversizedFetch as typeof fetch
      })
    ).rejects.toThrow('size limit')
  })
})

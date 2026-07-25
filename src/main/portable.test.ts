import { describe, expect, it } from 'vitest'
import type { PortableBundlePayload } from '@shared/portable'
import { decryptPortableBundle, encryptPortableBundle } from './portable'

const passphrase = 'correct horse battery staple'
const payload: PortableBundlePayload = {
  schemaVersion: 1,
  scope: 'conversation',
  exportedAt: '2026-01-01T00:00:00.000Z',
  conversations: [
    {
      schemaVersion: 2,
      id: 'conversation-1',
      title: 'Invisible bundle title',
      modelId: null,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Invisible bundle content',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ],
  personas: [],
  settings: { telemetry: false },
  models: []
}

describe('encrypted portable bundle', () => {
  it('uses an independent authenticated envelope with no semantic plaintext', async () => {
    const encrypted = await encryptPortableBundle(payload, passphrase)
    expect(encrypted).toContain('SIBYL_BUNDLE')
    expect(encrypted).not.toContain('Invisible bundle title')
    expect(encrypted).not.toContain('Invisible bundle content')
    expect(encrypted).not.toContain('conversation-1')
    await expect(decryptPortableBundle(encrypted, passphrase)).resolves.toEqual(payload)
    await expect(
      decryptPortableBundle(encrypted, 'this passphrase is incorrect')
    ).rejects.toBeDefined()
  }, 60_000)
})

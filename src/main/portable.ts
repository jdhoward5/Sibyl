import {
  PORTABLE_BUNDLE_MAGIC,
  PORTABLE_BUNDLE_VERSION,
  parsePortableBundlePayload,
  type PortableBundlePayload
} from '@shared/portable'
import {
  createVault,
  parseVaultHeader,
  parseVaultRecord,
  serializeVaultHeader,
  serializeVaultRecord,
  unlockVaultWithPassphrase,
  type VaultHeader,
  type VaultRecordEnvelope
} from './vault'

const BUNDLE_RECORD_KIND = 'portable-bundle'
const BUNDLE_RECORD_ID = 'payload'

interface PortableBundleEnvelope {
  magic: typeof PORTABLE_BUNDLE_MAGIC
  formatVersion: typeof PORTABLE_BUNDLE_VERSION
  header: VaultHeader
  record: VaultRecordEnvelope
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('This file is not a Sibyl encrypted bundle.')
  }
  return value as Record<string, unknown>
}

function parseEnvelope(value: unknown): PortableBundleEnvelope {
  const envelope = object(value)
  const actual = Object.keys(envelope).sort()
  const expected = ['formatVersion', 'header', 'magic', 'record'].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('The Sibyl bundle header is invalid.')
  }
  if (envelope.magic !== PORTABLE_BUNDLE_MAGIC) {
    throw new Error('This file is not a Sibyl encrypted bundle.')
  }
  if (envelope.formatVersion !== PORTABLE_BUNDLE_VERSION) {
    throw new Error('This Sibyl bundle version is not supported.')
  }
  return {
    magic: PORTABLE_BUNDLE_MAGIC,
    formatVersion: PORTABLE_BUNDLE_VERSION,
    header: parseVaultHeader(envelope.header),
    record: parseVaultRecord(envelope.record)
  }
}

export async function encryptPortableBundle(
  input: PortableBundlePayload,
  recoveryPassphrase: string
): Promise<string> {
  const payload = parsePortableBundlePayload(input)
  const created = await createVault(recoveryPassphrase)
  try {
    const record = created.key.encryptJson(
      BUNDLE_RECORD_KIND,
      BUNDLE_RECORD_ID,
      payload
    )
    const envelope: PortableBundleEnvelope = {
      magic: PORTABLE_BUNDLE_MAGIC,
      formatVersion: PORTABLE_BUNDLE_VERSION,
      header: created.header,
      record
    }
    // Round-trip through the vault serializers so canonical validation is
    // applied before the ciphertext leaves memory.
    return `${JSON.stringify({
      ...envelope,
      header: JSON.parse(serializeVaultHeader(envelope.header)) as unknown,
      record: JSON.parse(serializeVaultRecord(envelope.record)) as unknown
    })}\n`
  } finally {
    created.key.destroy()
  }
}

export async function decryptPortableBundle(
  serialized: string,
  recoveryPassphrase: string
): Promise<PortableBundlePayload> {
  let decoded: unknown
  try {
    decoded = JSON.parse(serialized) as unknown
  } catch {
    throw new Error('This file is not a valid Sibyl encrypted bundle.')
  }
  const envelope = parseEnvelope(decoded)
  const key = await unlockVaultWithPassphrase(envelope.header, recoveryPassphrase)
  try {
    return parsePortableBundlePayload(
      key.decryptJson(envelope.record, BUNDLE_RECORD_KIND, BUNDLE_RECORD_ID)
    )
  } finally {
    key.destroy()
  }
}

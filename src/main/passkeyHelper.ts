import { app } from 'electron'
import { IsolatedWebAuthnPasskeyProvider } from './passkey'

app.disableHardwareAcceleration()

function result(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('The passkey helper requires a private IPC channel.'))
      return
    }
    process.send(value, (error) => {
      if (error) reject(error)
      else {
        if (process.connected) process.disconnect()
        resolve()
      }
    })
  })
}

export function runPasskeyHelper(): void {
  void app.whenReady().then(async () => {
    const marker = process.argv.indexOf('--sibyl-passkey-helper')
    const action = process.argv[marker + 1]
    const provider = new IsolatedWebAuthnPasskeyProvider()
    try {
      if (action === 'available') {
        await result({ ok: true, available: await provider.available() })
      } else if (action === 'enroll' || action === 'self-test') {
        const enrollment = await provider.enroll()
        try {
          await result({
            ok: true,
            credentialId: enrollment.credentialId.toString('base64url'),
            salt: enrollment.salt.toString('base64url'),
            output: enrollment.prfOutput.toString('base64url')
          })
        } finally {
          enrollment.credentialId.fill(0)
          enrollment.salt.fill(0)
          enrollment.prfOutput.fill(0)
        }
      } else if (action === 'evaluate') {
        const credentialId = Buffer.from(process.argv[marker + 2] ?? '', 'base64url')
        const salt = Buffer.from(process.argv[marker + 3] ?? '', 'base64url')
        try {
          if (
            credentialId.length < 16 ||
            credentialId.length > 1024 ||
            salt.length !== 32
          ) {
            throw new Error('Passkey request material is invalid.')
          }
          const output = await provider.evaluate(credentialId, salt)
          try {
            await result({ ok: true, output: output.toString('base64url') })
          } finally {
            output.fill(0)
          }
        } finally {
          credentialId.fill(0)
          salt.fill(0)
        }
      } else {
        throw new Error('Unknown passkey helper action.')
      }
      app.exit(0)
    } catch (error) {
      // Do not expose authenticator/provider detail through IPC. User
      // cancellation, missing credentials, and unsupported PRF all fail alike.
      await result({
        ok: false,
        ...(!app.isPackaged &&
        process.env.SIBYL_PASSKEY_VIRTUAL_AUTHENTICATOR === '1'
          ? {
              testError:
                error instanceof Error ? error.message : String(error)
            }
          : {})
      }).catch(() => {})
      app.exit(1)
    }
  })
}

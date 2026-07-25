import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, session, type Session } from 'electron'

const PASSKEY_URL = 'https://vault.sibyl.invalid/'
const PASSKEY_RP_ID = 'vault.sibyl.invalid'
const PARTITION = 'passkey-https-spike'
const DOCUMENT =
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Sibyl vault unlock</title>'

export interface PasskeyEnrollment {
  credentialId: Buffer
  salt: Buffer
  prfOutput: Buffer
}

export interface PasskeyProvider {
  available(): Promise<boolean>
  enroll(): Promise<PasskeyEnrollment>
  evaluate(credentialId: Buffer, salt: Buffer): Promise<Buffer>
}

function fromBase64url(value: unknown, label: string, expected?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.toString('base64url') !== value ||
    (expected !== undefined && decoded.length !== expected)
  ) {
    decoded.fill(0)
    throw new Error(`${label} is invalid.`)
  }
  return decoded
}

export class IsolatedWebAuthnPasskeyProvider implements PasskeyProvider {
  private isolatedSession: Session | null = null
  private capability: boolean | null = null
  private busy = false

  private webAuthnSession(): Session {
    if (this.isolatedSession) return this.isolatedSession
    const isolated = session.fromPartition(PARTITION)
    const intercepted = isolated.protocol.interceptStringProtocol(
      'https',
      (_request, callback) => {
        callback({
          statusCode: 200,
          mimeType: 'text/html',
          data: DOCUMENT
        })
      }
    )
    if (!intercepted) {
      throw new Error('The isolated passkey origin could not be registered.')
    }
    this.isolatedSession = isolated
    return isolated
  }

  private async withWindow<T>(source: string): Promise<T> {
    if (this.busy) throw new Error('Another passkey operation is in progress.')
    this.busy = true
    try {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          session: this.webAuthnSession(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      try {
        if (
          !app.isPackaged &&
          process.env.SIBYL_PASSKEY_VIRTUAL_AUTHENTICATOR === '1'
        ) {
          win.webContents.debugger.attach('1.3')
          await win.webContents.debugger.sendCommand('WebAuthn.enable')
          await win.webContents.debugger.sendCommand(
            'WebAuthn.addVirtualAuthenticator',
            {
              options: {
                protocol: 'ctap2',
                ctap2Version: 'ctap2_1',
                transport: 'internal',
                hasResidentKey: true,
                hasUserVerification: true,
                hasPrf: true,
                hasHmacSecret: true,
                automaticPresenceSimulation: true,
                isUserVerified: true
              }
            }
          )
        }
        await win.loadURL(PASSKEY_URL)
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        win.webContents.on('will-navigate', (event, url) => {
          if (url !== PASSKEY_URL) event.preventDefault()
        })
        return (await win.webContents.executeJavaScript(source, true)) as T
      } finally {
        if (!win.isDestroyed()) win.destroy()
      }
    } finally {
      this.busy = false
    }
  }

  async available(): Promise<boolean> {
    if (this.capability === true) return true
    try {
      this.capability = await this.withWindow<boolean>(`(async () => {
        if (
          !isSecureContext ||
          typeof PublicKeyCredential !== 'function' ||
          typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function'
        ) return false
        const uv = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        if (!uv) return false
        if (typeof PublicKeyCredential.getClientCapabilities !== 'function') return false
        const capabilities = await PublicKeyCredential.getClientCapabilities()
        return capabilities.prf === true || capabilities['extension:prf'] === true
      })()`)
    } catch {
      this.capability = false
    }
    return this.capability
  }

  async enroll(): Promise<PasskeyEnrollment> {
    const salt = randomBytes(32)
    const userId = randomBytes(32)
    const saltText = salt.toString('base64url')
    const userText = userId.toString('base64url')
    userId.fill(0)
    try {
      const result = await this.withWindow<{
        credentialId: string
        output: string
      }>(`(async () => {
        const decode = (value) => {
          const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
          const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
          return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
        }
        const encode = (value) => {
          let binary = ''
          for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte)
          return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
        }
        const salt = decode(${JSON.stringify(saltText)})
        const credential = await navigator.credentials.create({
          publicKey: {
            rp: { id: ${JSON.stringify(PASSKEY_RP_ID)}, name: 'Sibyl' },
            user: {
              id: decode(${JSON.stringify(userText)}),
              name: 'local-vault',
              displayName: 'Sibyl private vault'
            },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 }
            ],
            timeout: 120000,
            attestation: 'none',
            authenticatorSelection: {
              residentKey: 'preferred',
              userVerification: 'required'
            },
            extensions: { prf: { eval: { first: salt } } }
          }
        })
        if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey creation failed.')
        const creationPrf = credential.getClientExtensionResults().prf
        if (creationPrf?.enabled !== true) throw new Error('This passkey does not support PRF.')
        const assertion = await navigator.credentials.get({
          publicKey: {
            rpId: ${JSON.stringify(PASSKEY_RP_ID)},
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            timeout: 120000,
            allowCredentials: [{ type: 'public-key', id: credential.rawId }],
            userVerification: 'required',
            extensions: { prf: { eval: { first: salt } } }
          }
        })
        const output = assertion?.getClientExtensionResults().prf?.results?.first
        const creationOutput = creationPrf.results?.first
        if (creationOutput && output) {
          const before = new Uint8Array(creationOutput)
          const after = new Uint8Array(output)
          if (
            before.length !== after.length ||
            before.some((byte, index) => byte !== after[index])
          ) throw new Error('Passkey PRF output was not stable.')
        }
        if (!output || output.byteLength !== 32) throw new Error('Passkey PRF output is unavailable.')
        return { credentialId: encode(credential.rawId), output: encode(output) }
      })()`)
      return {
        credentialId: fromBase64url(result.credentialId, 'Passkey credential id'),
        salt,
        prfOutput: fromBase64url(result.output, 'Passkey PRF output', 32)
      }
    } catch (error) {
      salt.fill(0)
      throw error
    }
  }

  async evaluate(credentialId: Buffer, salt: Buffer): Promise<Buffer> {
    const credentialText = credentialId.toString('base64url')
    const saltText = salt.toString('base64url')
    const output = await this.withWindow<string>(`(async () => {
      const decode = (value) => {
        const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
        const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
        return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
      }
      const encode = (value) => {
        let binary = ''
        for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte)
        return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
      }
      const assertion = await navigator.credentials.get({
        publicKey: {
          rpId: ${JSON.stringify(PASSKEY_RP_ID)},
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          timeout: 120000,
          allowCredentials: [{
            type: 'public-key',
            id: decode(${JSON.stringify(credentialText)})
          }],
          userVerification: 'required',
          extensions: {
            prf: { eval: { first: decode(${JSON.stringify(saltText)}) } }
          }
        }
      })
      const result = assertion?.getClientExtensionResults().prf?.results?.first
      if (!result || result.byteLength !== 32) throw new Error('Passkey PRF output is unavailable.')
      return encode(result)
    })()`)
    return fromBase64url(output, 'Passkey PRF output', 32)
  }
}

export const passkeyProvider: PasskeyProvider =
  new (class implements PasskeyProvider {
    private capability: boolean | null = null

    private async run(
      action: 'available' | 'enroll' | 'evaluate',
      args: string[] = []
    ): Promise<Record<string, unknown>> {
      const helperUserData = await fs.mkdtemp(
        path.join(os.tmpdir(), 'sibyl-passkey-helper-')
      )
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const helperArgs = [
          ...(app.isPackaged ? [] : [app.getAppPath()]),
          `--user-data-dir=${helperUserData}`,
          '--sibyl-passkey-helper',
          action,
          ...args
        ]
        const child = spawn(process.execPath, helperArgs, {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true,
          env: process.env
        })
        let stderrBytes = 0
        let receivedResult = false
        let settled = false
        let response: Record<string, unknown> | null = null
        let responseError: Error | null = null
        const finish = (
          error?: Error,
          value?: Record<string, unknown>
        ): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (error) reject(error)
          else resolve(value ?? {})
        }
        const timeout = setTimeout(() => {
          responseError = new Error('The passkey operation timed out.')
          child.kill()
        }, 150_000)
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length
          if (stderrBytes > 64 * 1024) {
            responseError = new Error('The passkey helper returned too much data.')
            child.kill()
          }
        })
        child.on('error', (error) => finish(error))
        child.on('message', (message: unknown) => {
          if (
            receivedResult ||
            typeof message !== 'object' ||
            message === null ||
            Array.isArray(message)
          ) {
            responseError = new Error('The passkey helper returned an invalid result.')
            child.kill()
            return
          }
          try {
            if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 64 * 1024) {
              throw new Error('The passkey helper returned too much data.')
            }
            receivedResult = true
            const parsed = message as Record<string, unknown>
            if (parsed.ok !== true) {
              responseError = new Error('The passkey operation was not completed.')
              return
            }
            response = parsed
          } catch {
            responseError = new Error('The passkey helper returned an invalid result.')
            child.kill()
          }
        })
        child.on('close', (code) => {
          if (responseError) {
            finish(responseError)
          } else if (!receivedResult || !response) {
            finish(new Error('The passkey helper did not return a result.'))
          } else if (code !== 0) {
            finish(new Error('The passkey helper exited unsuccessfully.'))
          } else {
            finish(undefined, response)
          }
        })
      }).finally(async () => {
        await fs.rm(helperUserData, { recursive: true, force: true }).catch(() => {})
      })
    }

    async available(): Promise<boolean> {
      if (this.capability === true) return true
      try {
        const response = await this.run('available')
        this.capability = response.available === true
      } catch {
        this.capability = false
      }
      return this.capability
    }

    async enroll(): Promise<PasskeyEnrollment> {
      const response = await this.run('enroll')
      return {
        credentialId: fromBase64url(
          response.credentialId,
          'Passkey credential id'
        ),
        salt: fromBase64url(response.salt, 'Passkey PRF salt', 32),
        prfOutput: fromBase64url(
          response.output,
          'Passkey PRF output',
          32
        )
      }
    }

    async evaluate(credentialId: Buffer, salt: Buffer): Promise<Buffer> {
      const response = await this.run('evaluate', [
        credentialId.toString('base64url'),
        salt.toString('base64url')
      ])
      return fromBase64url(response.output, 'Passkey PRF output', 32)
    }
  })()

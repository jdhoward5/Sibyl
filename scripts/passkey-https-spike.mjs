import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const response = await new Promise((resolve, reject) => {
  const child = spawn(
    electron,
    [root, '--sibyl-passkey-helper', 'self-test'],
    {
      env: {
        ...process.env,
        SIBYL_PASSKEY_VIRTUAL_AUTHENTICATOR: '1'
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    }
  )
  let message
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error('Passkey smoke timed out.'))
  }, 120_000)
  child.on('message', (value) => {
    message = value
  })
  child.on('error', (error) => {
    clearTimeout(timeout)
    reject(error)
  })
  child.on('exit', (code) => {
    clearTimeout(timeout)
    if (
      code === 0 &&
      typeof message === 'object' &&
      message !== null &&
      message.ok === true
    ) {
      resolve(message)
      return
    }
    const detail =
      typeof message === 'object' &&
      message !== null &&
      typeof message.testError === 'string'
        ? `: ${message.testError}`
        : ''
    reject(new Error(`Passkey smoke failed with exit code ${code}${detail}.`))
  })
})
if (!response) throw new Error('Passkey smoke returned no result.')
process.stdout.write(
  'Isolated HTTPS WebAuthn PRF test passed (credential create + assertion).\n'
)

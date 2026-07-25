import { describe, expect, it } from 'vitest'
import { npmInvocation } from '../scripts/npm-invocation.mjs'

describe('npmInvocation', () => {
  it('runs npm through node on Windows when invoked outside an npm script', () => {
    const invocation = npmInvocation({
      platform: 'win32',
      env: {},
      execPath: 'C:\\node\\node.exe',
      fileExists: () => true
    })

    expect(invocation).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js']
    })
  })

  it('uses npm_execpath when npm supplied one', () => {
    expect(
      npmInvocation({
        platform: 'win32',
        env: { npm_execpath: 'C:\\npm\\npm-cli.js' },
        execPath: 'C:\\node\\node.exe'
      })
    ).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\npm\\npm-cli.js']
    })
  })

  it('keeps the direct npm executable on non-Windows platforms', () => {
    expect(npmInvocation({ platform: 'darwin', env: {} })).toEqual({
      command: 'npm',
      args: []
    })
  })
})

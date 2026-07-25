import { existsSync } from 'node:fs'
import path from 'node:path'

export function npmInvocation({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  fileExists = existsSync
} = {}) {
  if (env.npm_execpath) {
    return { command: execPath, args: [env.npm_execpath] }
  }
  if (platform !== 'win32') {
    return { command: 'npm', args: [] }
  }

  const npmCli = path.win32.join(
    path.win32.dirname(execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js'
  )
  if (!fileExists(npmCli)) {
    throw new Error(`Unable to locate the npm CLI at ${npmCli}.`)
  }
  return { command: execPath, args: [npmCli] }
}

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { npmInvocation } from './npm-invocation.mjs'

const output = path.resolve(process.argv[2] ?? 'audit-full.json')
const invocation = npmInvocation()
const command = invocation.command
const args = [...invocation.args, 'audit', '--json']
const result = spawnSync(command, args, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true
})
if (result.error) throw result.error
if (!result.stdout.trim()) {
  throw new Error(`npm audit did not produce JSON: ${result.stderr.trim()}`)
}
JSON.parse(result.stdout)
writeFileSync(output, result.stdout, 'utf8')
process.stdout.write(
  `Saved the informational full dependency audit to ${output} (npm exit ${result.status}).\n`
)

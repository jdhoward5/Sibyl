import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Privacy invariant guard (see CLAUDE.md → "Privacy"). Conversation/message text
// is the user's private, on-device data: it must never be written to a sink the
// user doesn't see — stdout/stderr, a hidden log file, a remote service. These
// tests are a static backstop against the easy regressions:
//
//   1. The RENDERER holds every conversation/message in memory (the store). A
//      stray `console.*` there leaks straight to the devtools console and, in
//      dev, is forwarded to the main process stdout. So the renderer must contain
//      no console.* calls at all.
//   2. Anywhere in the tree, a `console.*` that references a known content field
//      (a message's `.content`, a persona's `.brief`/`.greeting`, the resolved
//      `systemPrompt`/`userText`, the user's `userCharacter`) is almost certainly
//      logging private text — fail it.
//
// Intentionally conservative: if a log genuinely needs one of these symbols,
// compute a non-sensitive value (a length, a boolean) into a variable first.

const SRC = path.dirname(fileURLToPath(import.meta.url))

const CONSOLE = /\bconsole\.(log|info|debug|warn|error|trace|dir)\s*\(/

/** Field accesses that carry private prompt/message text. */
const CONTENT_SYMBOLS = ['.content', 'systemPrompt', 'userText', 'currentUserText', '.brief', '.greeting', 'userCharacter']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = sourceFiles(SRC)
const rel = (f: string): string => path.relative(SRC, f).replace(/\\/g, '/')

describe('privacy invariant: message content is never logged', () => {
  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('the renderer contains no console.* calls (it holds conversation content in memory)', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (!rel(f).startsWith('renderer/src/')) continue
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (CONSOLE.test(line)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders, `Unexpected console.* in renderer:\n${offenders.join('\n')}`).toEqual([])
  })

  it('no console.* call anywhere references message/persona/prompt content fields', () => {
    const offenders: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (CONSOLE.test(line) && CONTENT_SYMBOLS.some((s) => line.includes(s))) {
          offenders.push(`${rel(f)}:${i + 1} → ${line.trim()}`)
        }
      })
    }
    expect(offenders, `console.* logging private content:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the decrypted Hugging Face token has no renderer or preload representation', () => {
    const offenders: string[] = []
    for (const f of files) {
      const relative = rel(f)
      if (!relative.startsWith('renderer/') && !relative.startsWith('preload/')) continue
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\bhfToken\b/.test(line)) offenders.push(`${relative}:${i + 1}`)
      })
    }
    expect(offenders, `Decrypted HF token exposed to renderer/preload:\n${offenders.join('\n')}`).toEqual([])
  })
})

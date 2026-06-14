// Playwright-driven UI E2E for Oracle. Unlike the headless ORACLE_SMOKE path
// (which drives the engine/GPU through IPC), this drives the *renderer UI* as a
// user would — clicking the real buttons — to exercise the chat-UX features that
// don't need a loaded model: sidebar search, in-chat find, per-conversation
// overrides, export, and message delete, plus Settings preset/profile management.
//
// It runs the BUILT app (`npm run build` first), in an isolated temp userData dir
// seeded with a couple of conversations, so it never touches your real data and
// needs no model on the GPU. Exit 0 = pass, non-zero = fail; screenshots land in
// ORACLE_E2E_OUT (default: a temp dir, printed at start).
//
//   npm run build && npm run test:e2e

import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const outDir = process.env.ORACLE_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-e2e-out-'))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-e2e-data-'))

function log(...a) {
  console.log('[e2e]', ...a)
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  log('✓', msg)
}

// --- Seed two conversations into the isolated userData before launch ----------
const ISO = '2026-01-01T00:00:00.000Z'
const conversations = [
  {
    id: 'e2e-beta',
    title: 'Beta chat about France',
    modelId: null,
    createdAt: ISO,
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { id: 'b-u', role: 'user', content: 'What is the capital of France?', createdAt: ISO },
      { id: 'b-a', role: 'assistant', content: 'The capital of France is Paris.', createdAt: ISO }
    ]
  },
  {
    id: 'e2e-alpha',
    title: 'Alpha chat about pelicans',
    modelId: null,
    createdAt: ISO,
    // Newer → sorts first → becomes the active conversation on launch.
    updatedAt: '2026-02-01T00:00:00.000Z',
    messages: [
      { id: 'a-u', role: 'user', content: 'Tell me about pelicans please.', createdAt: ISO },
      { id: 'a-a', role: 'assistant', content: 'Pelicans are large water birds with a throat pouch.', createdAt: ISO }
    ]
  }
]

function seed() {
  const dir = path.join(userDataDir, 'conversations')
  fs.mkdirSync(dir, { recursive: true })
  for (const c of conversations) {
    fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c, null, 2))
  }
}

async function run() {
  log('out:', outDir)
  log('userData:', userDataDir)

  if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
    throw new Error('Built app not found at out/main/index.js — run `npm run build` first.')
  }
  seed()

  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, '.'],
    cwd: root,
    env: { ...process.env }
  })
  const page = await app.firstWindow()
  const shot = (name) => page.screenshot({ path: path.join(outDir, name) })

  try {
    // Ready when the conversation list has rendered.
    await page.getByText('New chat').waitFor({ timeout: 30000 })
    await page.getByText('Alpha chat about pelicans').first().waitFor({ timeout: 30000 })
    await shot('01-boot.png')
    log('app booted with seeded conversations')

    // --- Sidebar search ------------------------------------------------------
    await page.getByPlaceholder('Search conversations').fill('pelican')
    await page.waitForTimeout(150)
    assert((await page.getByText('Beta chat about France').count()) === 0, 'search hides non-matching conversation')
    assert((await page.getByText('Alpha chat about pelicans').count()) >= 1, 'search keeps matching conversation')
    await shot('02-search.png')
    await page.getByPlaceholder('Search conversations').fill('')
    await page.waitForTimeout(100)

    // --- In-chat find (Alpha is the active conversation) ---------------------
    await page.getByTitle('Find in conversation').click()
    const findInput = page.getByPlaceholder('Find in conversation')
    await findInput.waitFor({ timeout: 5000 })
    await findInput.fill('pelican')
    await page.waitForTimeout(150)
    // Both Alpha messages mention pelicans (case-insensitive) → 2 matches.
    assert((await page.getByText('1/2', { exact: true }).count()) === 1, 'find reports 2 message matches')
    await shot('03-find.png')
    await page.keyboard.press('Escape')

    // --- Conversation settings drawer: export + overrides --------------------
    await page.getByTitle('Conversation settings').click()
    await page.getByText('Conversation settings').waitFor({ timeout: 5000 })
    const drawer = page.locator('div.z-40').first()

    // Export (stub the native save dialog in the main process to a temp file).
    const exportPath = path.join(outDir, 'alpha-export.md')
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    }, exportPath)
    await drawer.getByText('Markdown', { exact: true }).click()
    await page.waitForTimeout(400)
    assert(fs.existsSync(exportPath), 'export wrote a markdown file')
    const md = fs.readFileSync(exportPath, 'utf8')
    assert(md.includes('# Alpha chat about pelicans') && md.includes('Pelicans are large'), 'exported markdown has title + content')

    // Overrides: set a system prompt + enable a generation profile, then save.
    await drawer.locator('textarea').fill('You are a terse bird expert.')
    await drawer.getByRole('switch').click() // enable generation override
    await page.waitForTimeout(100)
    await drawer.locator('select').first().selectOption({ label: 'Creative' })
    await shot('04-overrides.png')
    await drawer.getByRole('button', { name: 'Save' }).click()
    await page.getByText('Conversation settings').waitFor({ state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(200)

    const alpha = await page.evaluate(() => window.oracle.conversations.get('e2e-alpha'))
    assert(alpha?.data?.overrides?.systemPrompt === 'You are a terse bird expert.', 'system-prompt override persisted')
    assert(!!alpha?.data?.overrides?.generation, 'generation override persisted')
    // Header should now flag that overrides are active.
    assert((await page.getByTitle('Conversation settings').locator('span').count()) >= 1, 'header shows overrides indicator dot')

    // --- Delete a single message (Beta) -------------------------------------
    await page.getByText('Beta chat about France').click()
    await page.getByText('The capital of France is Paris.').waitFor({ timeout: 5000 })
    await page.getByText('Delete', { exact: true }).first().click()
    await page.waitForTimeout(250)
    const beta = await page.evaluate(() => window.oracle.conversations.get('e2e-beta'))
    assert(beta?.data?.messages?.length === 1, 'deleting a message persisted (2 → 1)')

    // --- Settings: add a generation profile ---------------------------------
    await page.getByText('Settings', { exact: true }).click()
    const profileInput = page.getByPlaceholder('Name a new profile')
    await profileInput.waitFor({ timeout: 5000 })
    await profileInput.fill('E2E Profile')
    await profileInput.press('Enter')
    await page.waitForTimeout(250)
    const settings = await page.evaluate(() => window.oracle.settings.get())
    assert(
      (settings?.data?.generationProfiles ?? []).some((p) => p.name === 'E2E Profile'),
      'new generation profile persisted'
    )
    await shot('05-settings.png')

    log('✅ ALL UI E2E CHECKS PASSED')
  } catch (err) {
    log('❌ FAILED:', err?.message || err)
    await shot('99-failure.png').catch(() => {})
    process.exitCode = 1
  } finally {
    await app.close().catch(() => {})
    // Best-effort: on Windows the userData lock can briefly linger after close.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* leave the temp dir rather than fail an otherwise-passing run */
    }
  }
}

run().catch((err) => {
  console.error('[e2e] fatal', err)
  process.exit(1)
})

// Playwright-driven UI E2E for Sibyl. Unlike the headless SIBYL_SMOKE path
// (which drives the engine/GPU through IPC), this drives the *renderer UI* as a
// user would — clicking the real buttons — to exercise the chat-UX features that
// don't need a loaded model: sidebar search, in-chat find, per-conversation
// overrides, export, and message delete, plus Settings preset/profile management.
//
// It runs the BUILT app (`npm run build` first), in an isolated temp userData dir
// seeded with a couple of conversations, so it never touches your real data and
// needs no model on the GPU. Exit 0 = pass, non-zero = fail; screenshots land in
// SIBYL_E2E_OUT (default: a temp dir, printed at start).
//
//   npm run build && npm run test:e2e

import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const outDir = process.env.SIBYL_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sibyl-e2e-out-'))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibyl-e2e-data-'))

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
    await page.getByText('New thread').waitFor({ timeout: 30000 })
    await page.getByText('Alpha chat about pelicans').first().waitFor({ timeout: 30000 })
    await shot('01-boot.png')
    log('app booted with seeded conversations')

    // --- Sidebar search ------------------------------------------------------
    await page.getByPlaceholder('Search threads').fill('pelican')
    await page.waitForTimeout(150)
    assert((await page.getByText('Beta chat about France').count()) === 0, 'search hides non-matching conversation')
    assert((await page.getByText('Alpha chat about pelicans').count()) >= 1, 'search keeps matching conversation')
    await shot('02-search.png')
    await page.getByPlaceholder('Search threads').fill('')
    await page.waitForTimeout(100)

    // --- In-chat find (Alpha is the active conversation) ---------------------
    // Find now lives in the header "⋯" overflow menu.
    await page.getByTitle('More').click()
    await page.getByText('Find in conversation', { exact: true }).click()
    const findInput = page.getByPlaceholder('Find in conversation')
    await findInput.waitFor({ timeout: 5000 })
    await findInput.fill('pelican')
    await page.waitForTimeout(150)
    // Both Alpha messages mention pelicans (case-insensitive) → 2 matches.
    assert((await page.getByText('1/2', { exact: true }).count()) === 1, 'find reports 2 message matches')
    await shot('03-find.png')
    await page.keyboard.press('Escape')

    // --- Composer live token estimate ---------------------------------------
    const composer = page.locator('textarea')
    await composer.fill('hello world, this is a quick token-count check!')
    await page.waitForTimeout(100)
    assert((await page.getByText(/~\d+ tokens/).count()) >= 1, 'composer shows a live token estimate')
    await composer.fill('')
    await page.waitForTimeout(50)

    // --- Thread settings drawer: export + overrides --------------------------
    // Thread settings also lives in the "⋯" overflow menu now.
    await page.getByTitle('More').click()
    await page.getByText('Thread settings & export', { exact: true }).click()
    await page.getByText('Thread settings', { exact: true }).waitFor({ timeout: 5000 })
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

    // Overrides: set the character-brief override + enable a generation profile,
    // then save. (The drawer now also has a "your character" textarea + a persona
    // copy dropdown, so target the first textarea and the profile select by its
    // "Apply profile…" option.)
    await drawer.locator('textarea').first().fill('You are a terse bird expert.')
    await drawer.getByRole('switch').click() // enable generation override
    await page.waitForTimeout(100)
    await drawer.locator('select').last().selectOption({ label: 'Creative' })
    await shot('04-overrides.png')
    await drawer.getByRole('button', { name: 'Save' }).click()
    await page.getByText('Thread settings', { exact: true }).waitFor({ state: 'hidden', timeout: 5000 })
    await page.waitForTimeout(200)

    const alpha = await page.evaluate(() => window.sibyl.conversations.get('e2e-alpha'))
    assert(alpha?.data?.overrides?.systemPrompt === 'You are a terse bird expert.', 'system-prompt override persisted')
    assert(!!alpha?.data?.overrides?.generation, 'generation override persisted')
    // Header should now flag that overrides are active.
    // The overrides indicator dot now sits on the "⋯" overflow ("More") button.
    assert((await page.getByTitle('More').locator('span').count()) >= 1, 'header shows overrides indicator dot')

    // --- Delete a single message (Beta) -------------------------------------
    await page.getByText('Beta chat about France').click()
    await page.getByText('The capital of France is Paris.').waitFor({ timeout: 5000 })
    await page.getByText('Delete', { exact: true }).first().click()
    await page.waitForTimeout(250)
    const beta = await page.evaluate(() => window.sibyl.conversations.get('e2e-beta'))
    assert(beta?.data?.messages?.length === 1, 'deleting a message persisted (2 → 1)')

    // --- Branch (fork Beta's remaining message into a new conversation) ------
    await page.getByText('Branch', { exact: true }).first().click()
    await page.waitForTimeout(250)
    const list = await page.evaluate(() => window.sibyl.conversations.list())
    const branchConv = (list?.data ?? []).find((c) => c.title.endsWith('(branch)'))
    assert(!!branchConv, 'branch created a new "(branch)" conversation')
    assert(branchConv.messages.length === 1, 'branch cloned messages up to the chosen point')

    // --- Settings: add a generation profile ---------------------------------
    await page.getByText('Settings', { exact: true }).click()
    const profileInput = page.getByPlaceholder('Name a new profile')
    await profileInput.waitFor({ timeout: 5000 })
    await profileInput.fill('E2E Profile')
    await profileInput.press('Enter')
    await page.waitForTimeout(250)
    const settings = await page.evaluate(() => window.sibyl.settings.get())
    assert(
      (settings?.data?.generationProfiles ?? []).some((p) => p.name === 'E2E Profile'),
      'new generation profile persisted'
    )

    // --- Settings: stop sequences -------------------------------------------
    await page.getByPlaceholder('One per line').fill('<<<END>>>')
    await page.waitForTimeout(200)
    const settings2 = await page.evaluate(() => window.sibyl.settings.get())
    assert(
      (settings2?.data?.generation?.stopSequences ?? []).includes('<<<END>>>'),
      'stop sequence persisted'
    )
    await shot('05-settings.png')

    // --- Models: import a local .gguf (registered in place; delete keeps file) ---
    // Stub the native open dialog to return a dummy .gguf (import only stats +
    // parses the name; it never reads GGUF bytes).
    const ggufPath = path.join(outDir, 'My-Local-Llama-3-8B-Q4_K_M.gguf')
    fs.writeFileSync(ggufPath, Buffer.alloc(65536, 7))
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, ggufPath)
    await page.getByText('Models', { exact: true }).click()
    await page.getByText('Add local model').first().click()
    await page.getByText('My-Local-Llama-3-8B-Q4_K_M', { exact: true }).waitFor({ timeout: 8000 })
    const imported = (await page.evaluate(() => window.sibyl.models.list()))?.data?.find((m) =>
      m.filename.startsWith('My-Local-Llama')
    )
    assert(
      imported?.local === true && imported.path.toLowerCase() === ggufPath.toLowerCase(),
      'local model registered in place (local:true, path = chosen file)'
    )
    assert(imported.quant === 'Q4_K_M' && imported.paramLabel === '8B', 'parsed quant + param from filename')
    await shot('06-import.png')
    // Deleting a local model must deregister it but NEVER delete the user's file.
    await page.evaluate((id) => window.sibyl.models.delete(id), imported.id)
    await page.waitForTimeout(300)
    const stillRegistered = (await page.evaluate(() => window.sibyl.models.list()))?.data?.some(
      (m) => m.id === imported.id
    )
    assert(!stillRegistered, 'local model deregistered on delete')
    assert(fs.existsSync(ggufPath), 'deleting a local model KEEPS the file on disk')

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

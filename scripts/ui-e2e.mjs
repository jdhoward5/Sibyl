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
import axe from 'axe-core'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const outDir = process.env.SIBYL_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sibyl-e2e-out-'))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibyl-e2e-data-'))
const vaultPassphrase = 'e2e only recovery passphrase'

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

function filesUnder(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(target))
    else if (entry.isFile()) files.push(target)
  }
  return files
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
  const assertAccessible = async (label, include) => {
    // Measure settled UI colors, not the first frame of a 250ms fade transition.
    await page.waitForTimeout(300)
    if (!(await page.evaluate(() => Boolean(window.axe)))) {
      await page.evaluate(axe.source)
    }
    const results = await page.evaluate(async (selector) =>
      window.axe.run(selector ? document.querySelector(selector) : document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']
        }
      }),
      include
    )
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious'
    )
    assert(
      blocking.length === 0,
      `${label} has no serious accessibility violations` +
        (blocking.length
          ? ` (${blocking.map((violation) => `${violation.id}:${violation.nodes.length}`).join(', ')})`
          : '')
        + (blocking.length
          ? ` targets=${blocking
              .flatMap((violation) => violation.nodes.map((node) => node.target.join(' ')))
              .join('|')}`
          : '')
        + (blocking.length
          ? ` details=${blocking
              .flatMap((violation) => violation.nodes.slice(0, 2).map((node) => node.failureSummary))
              .join('|')}`
          : '')
    )
  }

  try {
    // First-run enrollment migrates the seeded plaintext records before any
    // private app state is hydrated into the renderer.
    await page.getByText('Protect your private data', { exact: true }).waitFor({ timeout: 30000 })
    await page.getByLabel('Recovery passphrase', { exact: true }).fill(vaultPassphrase)
    await page.getByLabel('Confirm recovery passphrase', { exact: true }).fill(vaultPassphrase)
    const seamless = page.getByRole('checkbox', { name: 'Unlock seamlessly on this device' })
    if (await seamless.isEnabled()) await seamless.uncheck()
    await page.getByRole('button', { name: 'Create encrypted vault' }).click()

    // Ready when the conversation list has rendered.
    await page.getByText('New thread').waitFor({ timeout: 30000 })
    await page.getByText('Alpha chat about pelicans').first().waitFor({ timeout: 30000 })
    await shot('01-boot.png')
    log('app booted with seeded conversations')
    await assertAccessible('Chat')
    assert(!fs.existsSync(path.join(userDataDir, 'settings.json')), 'legacy plaintext settings removed')
    assert(!fs.existsSync(path.join(userDataDir, 'conversations')), 'legacy plaintext conversations removed')
    const plaintextOffenders = []
    for (const file of filesUnder(userDataDir)) {
      let bytes
      try {
        bytes = fs.readFileSync(file)
      } catch {
        continue
      }
      if (
        bytes.includes(Buffer.from('Alpha chat about pelicans')) ||
        bytes.includes(Buffer.from('The capital of France is Paris.'))
      ) {
        plaintextOffenders.push(path.relative(userDataDir, file))
      }
    }
    assert(
      plaintextOffenders.length === 0,
      `private seed text is absent from userData (${plaintextOffenders.join(', ')})`
    )

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

    // Rejected kickoff must retain the draft. This isolated run deliberately has
    // no loaded model, so Send returns false instead of accepting the turn.
    const rejectedDraft = 'keep this draft when no model is loaded'
    await composer.fill(rejectedDraft)
    await page.getByTitle('Send').click()
    await page.waitForTimeout(150)
    assert((await composer.inputValue()) === rejectedDraft, 'rejected send preserves the composer draft')
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

    // --- Scene settings: shared instruction --------------------------------
    // Seed through the typed bridge after unlock so the record is written
    // directly into the encrypted store, then reload to hydrate renderer state.
    await page.evaluate(async () => {
      const current = await window.sibyl.settings.get()
      const privatePersonaSecret = 'Ada privately suspects the beacon is a decoy.'
      const personas = [
        {
          schemaVersion: 2,
          version: 1,
          id: 'e2e-ada',
          name: 'Ada',
          role: 'Engineer',
          brief: 'You are Ada.',
          avatar: { monogram: 'AD', gradient: ['#334155', '#6366f1'] },
          voiceTags: [],
          publicDescription: 'A storm engineer in a silver coat.',
          secrets: [privatePersonaSecret]
        },
        {
          schemaVersion: 2,
          version: 1,
          id: 'e2e-bo',
          name: 'Bo',
          role: 'Pilot',
          brief: 'You are Bo.',
          avatar: { monogram: 'BO', gradient: ['#78350f', '#f59e0b'] },
          voiceTags: []
        }
      ]
      await window.sibyl.settings.set({ personas: [...(current.data?.personas ?? []), ...personas] })
      await window.sibyl.conversations.save({
        id: 'e2e-scene',
        title: 'E2E bounded scene',
        modelId: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
        messages: [
          {
            id: 'e2e-private-beat',
            role: 'assistant',
            content: 'Ada silently counts the lightning intervals.',
            createdAt: '2026-03-01T00:00:01.000Z',
            speakerId: 'e2e-ada',
            speakerName: 'Ada',
            segments: [
              {
                id: 'e2e-private-segment',
                kind: 'thought',
                content: 'Ada silently counts the lightning intervals.',
                visibility: { kind: 'private', characterIds: ['e2e-ada'] }
              }
            ]
          },
          {
            id: 'e2e-direction-note',
            role: 'user',
            content: 'Keep watch on the lightning.',
            createdAt: '2026-03-01T00:00:02.000Z',
            director: true,
            directionId: 'e2e-direction'
          }
        ],
        cast: personas.map((persona) => persona.id),
        scenePremise: 'A storm approaches.',
        knowledgeMode: 'scoped',
        directions: [
          {
            id: 'e2e-direction',
            content: 'Keep watch on the lightning.',
            target: { kind: 'cast' },
            scope: 'persistent',
            enabled: true,
            createdAt: '2026-03-01T00:00:02.000Z'
          }
        ]
      })
    })
    await page.reload()
    await page.getByText('E2E bounded scene', { exact: true }).click()
    await page.getByTitle('More').click()
    await page.getByText('Thread settings & export', { exact: true }).click()
    const sceneDrawer = page.locator('div.z-40').first()
    await sceneDrawer.getByText('Scene instruction', { exact: true }).waitFor()
    await assertAccessible('Scene settings dialog', '[role="dialog"]')
    await sceneDrawer.getByText('Character knowledge', { exact: true }).waitFor()
    await sceneDrawer.getByText('Frozen identity', { exact: true }).waitFor()
    await sceneDrawer.getByText('Active directions', { exact: true }).waitFor()
    assert(
      await sceneDrawer.locator('textarea').evaluateAll(
        (elements) => elements.some((element) => element.value === 'Keep watch on the lightning.')
      ),
      'active persistent direction is editable in scene settings'
    )
    assert(
      (await sceneDrawer.getByText('Copy from persona…', { exact: true }).count()) === 0,
      'scene settings hide the thread-only persona-copy control'
    )
    await sceneDrawer.getByRole('switch', { name: 'Local scene director' }).click()
    await sceneDrawer.getByRole('switch', { name: 'Use loaded model' }).click()
    await sceneDrawer.getByPlaceholder('Optional scene goal').fill('Reach shelter before dawn.')
    await sceneDrawer.getByLabel('Scene speaking rate').fill('1.15')
    const sceneInstruction = 'Keep every cast member focused on the incoming storm.'
    await sceneDrawer.locator('textarea').first().fill(sceneInstruction)
    await sceneDrawer.getByRole('button', { name: 'Save' }).click()
    await page.waitForTimeout(200)
    const savedScene = await page.evaluate(() => window.sibyl.conversations.get('e2e-scene'))
    assert(
      savedScene?.data?.overrides?.systemPrompt === sceneInstruction,
      'shared scene instruction persisted for the next beat'
    )
    assert(
        savedScene?.data?.director?.enabled === true &&
        savedScene?.data?.director?.useModel === false &&
        savedScene?.data?.director?.sceneGoal === 'Reach shelter before dawn.' &&
        savedScene?.data?.sceneVoice?.rate === 1.15,
      'optional deterministic scene-director settings persisted'
    )
    assert(savedScene?.data?.schemaVersion === 2, 'legacy scene migrated to conversation schema v2')
    assert(savedScene?.data?.castSnapshots?.length === 2, 'scene persisted two persona snapshots')
    assert(
      savedScene?.data?.roleplayState?.schemaVersion === 1,
      'scene persisted validated structured continuity state'
    )
    await page.getByText('Private · only Ada knows', { exact: true }).waitFor()
    assert(
      filesUnder(userDataDir).every((file) => {
        try {
          const bytes = fs.readFileSync(file)
          return (
            !bytes.includes(Buffer.from(sceneInstruction)) &&
            !bytes.includes(Buffer.from('Ada privately suspects the beacon is a decoy.')) &&
            !bytes.includes(Buffer.from('Ada silently counts the lightning intervals.')) &&
            !bytes.includes(Buffer.from('Keep watch on the lightning.'))
          )
        } catch {
          return true
        }
      }),
      'scene instruction remains encrypted everywhere under userData'
    )
    await page.evaluate(async () => {
      const current = await window.sibyl.settings.get()
      await window.sibyl.settings.set({
        personas: (current.data?.personas ?? []).filter((persona) => persona.id !== 'e2e-ada')
      })
    })
    await page.reload()
    await page.getByText('E2E bounded scene', { exact: true }).click()
    assert(
      (await page.getByText('Ada', { exact: true }).count()) >= 1,
      'deleted library persona remains available from the frozen scene snapshot'
    )

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
    await page.getByRole('switch', { name: 'Reduce motion' }).click()
    await page.getByRole('switch', { name: 'High contrast' }).click()
    await page.getByLabel('Text size').selectOption('1.125')
    await page.waitForTimeout(200)
    const accessibility = await page.evaluate(async () => ({
      settings: (await window.sibyl.settings.get()).data?.accessibility,
      reducedMotion: document.documentElement.classList.contains('reduce-motion'),
      highContrast: document.documentElement.classList.contains('high-contrast'),
      zoom: document.documentElement.style.getPropertyValue('zoom')
    }))
    assert(
      accessibility.settings?.reducedMotion === true &&
        accessibility.settings?.highContrast === true &&
        accessibility.settings?.textScale === 1.125 &&
      accessibility.reducedMotion &&
        accessibility.highContrast &&
        accessibility.zoom === '1.125',
      `accessibility preferences persist and apply immediately (${JSON.stringify(accessibility)})`
    )
    await shot('05-settings.png')
    await assertAccessible('Settings')

    // --- Encrypted portable library: export, content scan, preview, import ----
    const bundlePath = path.join(outDir, 'portable-library.sibyl')
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    }, bundlePath)
    await page.getByRole('button', { name: 'Export encrypted library' }).click()
    await page.getByLabel('Bundle recovery passphrase').fill(vaultPassphrase)
    await page.getByLabel('Confirm passphrase').fill(vaultPassphrase)
    await page.getByRole('button', { name: 'Choose save location' }).click()
    await page.getByRole('dialog').waitFor({
      state: 'hidden',
      timeout: 30000
    })
    assert(fs.existsSync(bundlePath), 'encrypted portable library was written')
    const bundleBytes = fs.readFileSync(bundlePath)
    assert(bundleBytes.includes(Buffer.from('SIBYL_BUNDLE')), 'portable file has the versioned bundle marker')
    assert(
      !bundleBytes.includes(Buffer.from('Alpha chat about pelicans')) &&
        !bundleBytes.includes(Buffer.from('Ada privately suspects the beacon is a decoy.')) &&
        !bundleBytes.includes(Buffer.from('Keep watch on the lightning.')),
      'portable bundle contains no plaintext conversation or semantic metadata'
    )

    await app.evaluate(async ({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, bundlePath)
    const countBeforePortableImport = (await page.evaluate(() => window.sibyl.conversations.list())).data.length
    await page.getByRole('button', { name: 'Import encrypted bundle' }).click()
    await page.getByLabel('Bundle recovery passphrase').fill(vaultPassphrase)
    await page.getByRole('button', { name: 'Choose encrypted bundle' }).click()
    await page.getByText('Verified library bundle', { exact: true }).waitFor({ timeout: 30000 })
    assert(
      (await page.getByRole('dialog').getByText('Alpha chat about pelicans', { exact: true }).count()) === 0,
      'portable import preview omits semantic titles'
    )
    await assertAccessible('Portable import preview', '[role="dialog"]')
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    await page.getByText('Verified library bundle', { exact: true }).waitFor({
      state: 'hidden',
      timeout: 30000
    })
    const countAfterPortableImport = (await page.evaluate(() => window.sibyl.conversations.list())).data.length
    assert(
      countAfterPortableImport === countBeforePortableImport * 2,
      'portable import atomically merged every conversation with collision-safe ids'
    )
    const postImportOffenders = filesUnder(userDataDir).filter((file) => {
      try {
        const bytes = fs.readFileSync(file)
        return (
          bytes.includes(Buffer.from('Alpha chat about pelicans')) ||
          bytes.includes(Buffer.from('Ada privately suspects the beacon is a decoy.'))
        )
      } catch {
        return false
      }
    })
    assert(
      postImportOffenders.length === 0,
      `portable import left no plaintext private files (${postImportOffenders.join(', ')})`
    )

    await page.getByLabel('Snapshots to retain').selectOption('1')
    await page.getByRole('button', { name: 'Snapshot now' }).click()
    await page.getByText('Encrypted recovery snapshot created', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Run recovery drill' }).click()
    await page.getByText(/Recovery drill passed:/).waitFor()
    assert(
      (await page.evaluate(() => window.sibyl.settings.get())).data.backupRetention === 1,
      'encrypted backup-retention control persisted'
    )

    // --- Vault lock/recovery -------------------------------------------------
    await page.getByRole('button', { name: 'Lock now' }).click()
    await page.getByText('Unlock Sibyl', { exact: true }).waitFor({ timeout: 15000 })
    await assertAccessible('Vault unlock')
    await page.getByLabel('Recovery passphrase', { exact: true }).fill(vaultPassphrase)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await page.getByText('New thread').waitFor({ timeout: 30000 })
    assert(
      (await page.getByText('Alpha chat about pelicans').count()) >= 1,
      'lock-now clears and recovery unlock reloads private state'
    )

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

import { useSyncExternalStore } from 'react'
import type {
  AppSettings,
  ChatMessage,
  Conversation,
  ConversationOverrides,
  ContextUsage,
  DownloadProgress,
  EngineStatus,
  HFModelDetail,
  HFModelSummary,
  InstalledModel,
  Persona,
  UpdateStatus,
  UserCharacter
} from '@shared/types'
import type { AppInfo } from '@shared/ipc'
import type { ExportFormat } from '@shared/export'
import type { InstalledVoice, TtsSettings, TtsStatus, TtsVoiceDownload } from '@shared/tts'
import { getAccentTheme, hexToRgbChannels } from '@shared/themes'
import { findPersona } from '@shared/personas'
import { isScene, sceneCast, nextSpeakerId, stripSpeakerPrefix, MIN_SCENE_CAST } from '@shared/scene'
import { ttsPlayer } from './lib/ttsPlayer'

/** Paint the selected accent theme onto documentElement as CSS variables. */
function applyAccentTheme(key: string | null | undefined): void {
  const t = getAccentTheme(key)
  const root = document.documentElement.style
  root.setProperty('--sibyl-accent', hexToRgbChannels(t.accent))
  root.setProperty('--sibyl-accent-2', hexToRgbChannels(t.accent2))
  root.setProperty('--sibyl-glow', hexToRgbChannels(t.glow))
}

export type View = 'chat' | 'discover' | 'models' | 'settings'
export type SortKey = 'trending' | 'downloads' | 'likes'

export interface DiscoverState {
  query: string
  sort: SortKey
  results: HFModelSummary[]
  loading: boolean
  error: string | null
  selected: HFModelDetail | null
  detailLoading: boolean
}

export interface AppState {
  ready: boolean
  view: View
  settings: AppSettings | null
  appInfo: AppInfo | null
  engine: EngineStatus
  conversations: Conversation[]
  activeConversationId: string | null
  installedModels: InstalledModel[]
  downloads: Record<string, DownloadProgress>
  discover: DiscoverState
  /** Live context-window fill for the active conversation, when a model is loaded. */
  contextUsage: ContextUsage | null
  /** True while a compaction pass is running. */
  compacting: boolean
  /** Live counters for the in-flight assistant turn (drives the streaming tok/s). */
  streamStats: { messageId: string; startedAt: number; tokens: number } | null
  /** Latest auto-update status, or null before the first snapshot arrives. */
  update: UpdateStatus | null
  toast: { id: number; kind: 'info' | 'error' | 'success'; message: string } | null
  /** True while the new-thread persona picker is shown over the chat column. */
  personaPickerOpen: boolean
  /** Speech-subsystem status (availability), or null before the first snapshot. */
  tts: TtsStatus | null
  /** Voices downloaded and registered on disk. */
  installedVoices: InstalledVoice[]
  /** In-flight voice downloads, keyed by voice id. */
  voiceDownloads: Record<string, TtsVoiceDownload>
  /** The message currently being spoken aloud, or null. Driven by the audio player. */
  speakingMessageId: string | null
  /**
   * Set while a self-roleplay scene is auto-advancing (the human is watching).
   * `convId` pins the loop to one conversation; null means manual/stopped.
   */
  scenePlay: { convId: string } | null
}

const initialState: AppState = {
  ready: false,
  view: 'chat',
  settings: null,
  appInfo: null,
  engine: {
    state: 'idle',
    modelId: null,
    gpuType: null,
    vramTotalBytes: null,
    vramUsedBytes: null,
    contextSize: null
  },
  conversations: [],
  activeConversationId: null,
  installedModels: [],
  downloads: {},
  discover: {
    query: '',
    sort: 'trending',
    results: [],
    loading: false,
    error: null,
    selected: null,
    detailLoading: false
  },
  contextUsage: null,
  compacting: false,
  streamStats: null,
  update: null,
  toast: null,
  personaPickerOpen: false,
  tts: null,
  installedVoices: [],
  voiceDownloads: {},
  speakingMessageId: null,
  scenePlay: null
}

let state: AppState = initialState
let initialized = false
const listeners = new Set<() => void>()

function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initialState)
  )
}

export function getState(): AppState {
  return state
}

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

const now = (): string => new Date().toISOString()

// Scene autoplay: a single self-rescheduling timer drives beat-after-beat.
let sceneTimer: ReturnType<typeof setTimeout> | null = null
/** Pause between scene beats so the reader can keep up (ms). */
const SCENE_BEAT_DELAY_MS = 650
function clearSceneTimer(): void {
  if (sceneTimer) clearTimeout(sceneTimer)
  sceneTimer = null
}
// Synchronous in-flight guard: set the instant we commit to a beat, cleared when
// that beat's done/error event arrives. `state.engine.state` is a mirror updated a
// full IPC round-trip late, so it can't stop two advances firing in the inter-beat
// gap (autoplay tick + a Composer speak/direct) — this can.
let beatInFlight = false

let toastTimer: ReturnType<typeof setTimeout> | null = null
function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  setState({ toast: { id: Date.now(), kind, message } })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => setState({ toast: null }), 4000)
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

function activeConversation(): Conversation | null {
  return state.conversations.find((c) => c.id === state.activeConversationId) ?? null
}

function updateConversation(id: string, fn: (c: Conversation) => Conversation): void {
  setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c))
  }))
}

function persist(conversation: Conversation): void {
  void window.sibyl.conversations.save(conversation)
}

/**
 * Whether speech can run right now: enabled, the runtime is available, and an
 * installed voice is selected. Returns a reason string when it can't.
 */
function ttsReadiness(): { ok: true; voiceId: string } | { ok: false; reason: string } {
  const s = state.settings?.tts
  if (!s?.enabled) return { ok: false, reason: 'Enable speech in Settings → Voice & speech.' }
  if (!state.tts?.available) {
    return { ok: false, reason: state.tts?.error ?? 'Speech is unavailable in this build.' }
  }
  if (!s.voiceId || !state.installedVoices.some((v) => v.id === s.voiceId)) {
    return { ok: false, reason: 'Choose a voice in Settings → Voice & speech.' }
  }
  return { ok: true, voiceId: s.voiceId }
}

/**
 * Pre-warm the audio context from within a user gesture (a send/play click) so a
 * later auto-spoken reply can start without its own gesture — the browser's
 * autoplay policy blocks `resume()` outside a gesture.
 */
function maybePrewarmAudio(): void {
  if (state.settings?.tts.enabled && state.settings.tts.autoSpeak && ttsReadiness().ok) {
    ttsPlayer.ensureContext()
  }
}

/** Whether the speak control should be shown on assistant messages. */
export function canSpeak(s: AppState): boolean {
  const t = s.settings?.tts
  return Boolean(
    t?.enabled &&
      s.tts?.available &&
      t.voiceId &&
      s.installedVoices.some((v) => v.id === t.voiceId)
  )
}

/**
 * Keep a compaction record only if its fold boundary survives a history edit.
 * If `throughMessageId` was truncated or deleted away, the summary describes
 * messages that no longer exist — the engine would then treat every message as
 * live yet still inject the stale summary (double-counted context). Dropping it
 * folds the retained messages back into the live history.
 */
function survivingCompaction(conv: Conversation, messages: ChatMessage[]): Conversation['compaction'] {
  const c = conv.compaction
  return c && messages.some((m) => m.id === c.throughMessageId) ? c : undefined
}

/**
 * Replace a conversation's messages, persist, drop the engine's stale warm
 * session, then re-run generation for `assistantId` from `userText`. Shared by
 * regenerate() and editAndResend(), which both truncate history and resend.
 */
async function runTurn(
  conv: Conversation,
  messages: ChatMessage[],
  userText: string,
  assistantId: string
): Promise<void> {
  const updated: Conversation = {
    ...conv,
    modelId: state.engine.modelId,
    messages,
    compaction: survivingCompaction(conv, messages),
    updatedAt: now()
  }
  updateConversation(conv.id, () => updated)
  // Persist the truncated history and invalidate before sending so the engine
  // rebuilds its session from this new state rather than the stale KV cache.
  await window.sibyl.conversations.save(updated)
  await window.sibyl.chat.invalidateSession(conv.id)
  const res = await window.sibyl.chat.send({
    conversationId: conv.id,
    message: userText,
    assistantMessageId: assistantId
  })
  if (!res.ok) toast(res.error ?? 'Failed to send message', 'error')
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const actions = {
  setView(view: View): void {
    // Leaving (or re-entering) a view dismisses the new-thread picker overlay.
    setState({ view, personaPickerOpen: false })
  },

  /** Show the new-thread persona picker over the chat column. */
  openPersonaPicker(): void {
    setState({ personaPickerOpen: true, view: 'chat' })
  },
  closePersonaPicker(): void {
    setState({ personaPickerOpen: false })
  },

  async init(): Promise<void> {
    // Guard against React StrictMode invoking the mount effect twice in dev,
    // which would otherwise register duplicate IPC listeners (double tokens).
    if (initialized) return
    initialized = true

    const [settingsRes, infoRes, modelsRes, convRes, statusRes, dlRes, updateRes, ttsRes, voicesRes, voiceDlRes] =
      await Promise.all([
        window.sibyl.settings.get(),
        window.sibyl.app.info(),
        window.sibyl.models.list(),
        window.sibyl.conversations.list(),
        window.sibyl.engine.status(),
        window.sibyl.downloads.list(),
        window.sibyl.update.status(),
        window.sibyl.tts.status(),
        window.sibyl.tts.listVoices(),
        window.sibyl.tts.listDownloads()
      ])

    const downloads: Record<string, DownloadProgress> = {}
    if (dlRes.ok && dlRes.data) for (const d of dlRes.data) downloads[d.id] = d
    const voiceDownloads: Record<string, TtsVoiceDownload> = {}
    if (voiceDlRes.ok && voiceDlRes.data) for (const d of voiceDlRes.data) voiceDownloads[d.voiceId] = d

    setState({
      ready: true,
      settings: settingsRes.data ?? null,
      appInfo: infoRes.data ?? null,
      installedModels: modelsRes.data ?? [],
      conversations: convRes.data ?? [],
      engine: statusRes.data ?? state.engine,
      downloads,
      update: updateRes.data ?? null,
      activeConversationId: convRes.data?.[0]?.id ?? null,
      tts: ttsRes.data ?? null,
      installedVoices: voicesRes.data ?? [],
      voiceDownloads
    })

    // Wire the audio player: it is the source of truth for what's audibly speaking.
    ttsPlayer.init({ onSpeakingChange: (id) => setState({ speakingMessageId: id }) })
    ttsPlayer.setVolume(state.settings?.tts.volume ?? 1)

    if (state.settings?.theme) document.documentElement.classList.toggle('light', state.settings.theme === 'light')
    applyAccentTheme(state.settings?.accent)

    // Pull an initial context snapshot for the opening conversation.
    void actions.refreshContextUsage()

    // Wire live event streams.
    window.sibyl.update.onEvent((s) => {
      const prev = state.update
      setState({ update: s })
      // Announce a ready-to-install update once (the Settings UI shows the button).
      if (s.state === 'downloaded' && prev?.state !== 'downloaded') {
        toast(`Update ${s.version ?? ''} downloaded — restart to install`.trim(), 'success')
      }
    })
    window.sibyl.engine.onStatus((s) => setState({ engine: s }))
    // TTS: availability status, streamed audio, and voice-download progress.
    window.sibyl.tts.onStatus((s) => setState({ tts: s }))
    window.sibyl.tts.onEvent((e) => {
      // Synthesis failures arrive as an event (speak() itself is fire-and-forget),
      // so surface them here — otherwise speech would just stop with no explanation.
      if (e.type === 'error') toast(e.error, 'error')
      ttsPlayer.handleEvent(e)
    })
    window.sibyl.tts.onVoiceProgress((p) => {
      // Terminal states drop the entry so the row returns to its idle (Download)
      // state; only an active download keeps a live entry.
      if (p.status === 'downloading') {
        setState((st) => ({ voiceDownloads: { ...st.voiceDownloads, [p.voiceId]: p } }))
        return
      }
      setState((st) => {
        const next = { ...st.voiceDownloads }
        delete next[p.voiceId]
        return { voiceDownloads: next }
      })
      if (p.status === 'completed') {
        toast('Voice installed', 'success')
        void actions.refreshVoices()
      } else if (p.status === 'error') {
        toast(p.error ?? 'Voice download failed', 'error')
      }
    })
    window.sibyl.context.onUsage((u) => {
      // Only adopt snapshots for the conversation currently on screen; the engine
      // also broadcasts a null-conversation snapshot on load that must not clobber
      // an active conversation's real fill.
      if (u.conversationId === state.activeConversationId) setState({ contextUsage: u })
    })
    window.sibyl.downloads.onProgress((p) => {
      setState((st) => ({ downloads: { ...st.downloads, [p.id]: p } }))
      if (p.status === 'completed') {
        toast(`Downloaded ${p.filename}`, 'success')
        void actions.refreshModels()
      } else if (p.status === 'error') {
        toast(`Download failed: ${p.error ?? p.filename}`, 'error')
      }
    })
    window.sibyl.chat.onEvent((e) => {
      if (e.type === 'token') {
        // Append the chunk and advance the live tok/s counter in one update.
        setState((s) => {
          const prev = s.streamStats
          const streamStats =
            prev && prev.messageId === e.messageId
              ? { ...prev, tokens: prev.tokens + 1 }
              : { messageId: e.messageId, startedAt: Date.now(), tokens: 1 }
          return {
            streamStats,
            conversations: s.conversations.map((c) =>
              c.id === e.conversationId
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === e.messageId ? { ...m, content: m.content + e.text } : m
                    )
                  }
                : c
            )
          }
        })
      } else if (e.type === 'done') {
        beatInFlight = false // beat finished — the next advance may proceed
        let finishedText = ''
        updateConversation(e.conversationId, (c) => {
          const messages = c.messages.map((m) => {
            if (m.id !== e.messageId) return m
            // Scene beats: drop a leading "Name:" the model sometimes prepends
            // despite instruction (the UI already attributes the speaker).
            const content = m.speakerId ? stripSpeakerPrefix(m.content, m.speakerName) : m.content
            finishedText = content
            return { ...m, content, stats: e.stats, error: undefined }
          })
          const updated = { ...c, updatedAt: now(), messages }
          persist(updated)
          return updated
        })
        setState({ streamStats: null })
        // Auto-speak the freshly completed reply, when enabled.
        actions.maybeAutoSpeak(e.messageId, finishedText)
        // Drive scene autoplay forward to the next character's beat.
        if (state.scenePlay?.convId === e.conversationId) actions.scheduleNextBeat()
      } else if (e.type === 'error') {
        beatInFlight = false // beat failed — release the in-flight guard
        updateConversation(e.conversationId, (c) => {
          const updated = {
            ...c,
            messages: c.messages.map((m) =>
              m.id === e.messageId ? { ...m, error: e.error } : m
            )
          }
          persist(updated)
          return updated
        })
        setState({ streamStats: null })
        // A failed beat stops autoplay rather than spinning on the error.
        if (state.scenePlay?.convId === e.conversationId) actions.stopScenePlay()
        toast(e.error, 'error')
      }
    })
  },

  async refreshModels(): Promise<void> {
    const res = await window.sibyl.models.list()
    if (res.ok) setState({ installedModels: res.data ?? [] })
  },

  // --- context window -----------------------------------------------------
  async refreshContextUsage(): Promise<void> {
    if (!state.engine.modelId) {
      setState({ contextUsage: null })
      return
    }
    const res = await window.sibyl.context.usage(state.activeConversationId)
    if (res.ok && res.data) setState({ contextUsage: res.data })
  },

  /**
   * Summarize older turns of a conversation to reclaim context. Returns true on
   * success. `silent` suppresses the success toast (used by auto-compaction).
   */
  async compact(conversationId?: string, opts?: { silent?: boolean }): Promise<boolean> {
    const id = conversationId ?? state.activeConversationId
    if (!id) return false
    if (state.compacting) return false
    setState({ compacting: true })
    const res = await window.sibyl.chat.compact(id)
    setState({ compacting: false })
    if (!res.ok || !res.data) {
      // Auto-compaction is best-effort (e.g. nothing foldable yet) — stay quiet.
      if (!opts?.silent) toast(res.error ?? 'Compaction failed', 'error')
      return false
    }
    const info = res.data
    updateConversation(id, (c) => {
      const updated = { ...c, compaction: info, updatedAt: now() }
      persist(updated)
      return updated
    })
    await actions.refreshContextUsage()
    if (!opts?.silent) toast(`Summarized ${info.foldedCount} earlier messages`, 'success')
    return true
  },

  // --- chat ---------------------------------------------------------------
  /**
   * Start a thread, optionally written with a persona. When the persona has a
   * greeting, it's seeded as the opening assistant message so the scene starts
   * in-character.
   */
  newConversation(personaId?: string): string {
    const persona = findPersona(state.settings?.personas, personaId)
    const messages: ChatMessage[] = []
    if (persona?.greeting?.trim()) {
      messages.push({ id: uid(), role: 'assistant', content: persona.greeting.trim(), createdAt: now() })
    }
    const conv: Conversation = {
      id: uid(),
      title: 'New thread',
      modelId: state.engine.modelId,
      messages,
      personaId: persona?.id,
      createdAt: now(),
      updatedAt: now()
    }
    setState((s) => ({
      conversations: [conv, ...s.conversations],
      activeConversationId: conv.id,
      view: 'chat',
      personaPickerOpen: false
    }))
    persist(conv)
    void actions.refreshContextUsage()
    return conv.id
  },

  // --- scenes (self-roleplay) ---------------------------------------------
  /**
   * Start a scene: a conversation whose cast of ≥2 personas converse with each
   * other. The human can watch (autoplay), join in as their own character, or
   * drop director notes to steer it.
   */
  newScene(castIds: string[], opts?: { premise?: string; userCharacter?: UserCharacter }): string {
    const cast = castIds.filter((id, i, a) => a.indexOf(id) === i)
    const premise = opts?.premise?.trim() || undefined
    const names = cast.map((id) => findPersona(state.settings?.personas, id)?.name).filter(Boolean)
    const title = (premise || (names.length ? `Scene · ${names.join(', ')}` : 'New scene')).slice(0, 48)
    const uc = opts?.userCharacter
    const conv: Conversation = {
      id: uid(),
      title,
      modelId: state.engine.modelId,
      messages: [],
      cast,
      scenePremise: premise,
      userCharacter: uc && (uc.name.trim() || uc.description.trim()) ? uc : undefined,
      createdAt: now(),
      updatedAt: now()
    }
    setState((s) => ({
      conversations: [conv, ...s.conversations],
      activeConversationId: conv.id,
      view: 'chat',
      personaPickerOpen: false
    }))
    persist(conv)
    void actions.refreshContextUsage()
    return conv.id
  },

  /** Generate one beat. `speakerId` overrides the round-robin pick. */
  async advanceScene(speakerId?: string): Promise<void> {
    if (beatInFlight) return // a beat is already in flight (synchronous guard)
    if (!state.engine.modelId) {
      toast('Load a model before playing a scene.', 'error')
      if (state.scenePlay) actions.stopScenePlay()
      return
    }
    if (state.engine.state === 'generating') return
    let conv = activeConversation()
    if (!conv || !isScene(conv)) return
    const personas = state.settings?.personas
    // A scene needs ≥2 *resolvable* characters; some of the cast may have been
    // deleted from the library, which would otherwise leave a one-voice monologue.
    if (sceneCast(conv, personas).length < MIN_SCENE_CAST) {
      toast('This scene needs at least two available characters.', 'error')
      if (state.scenePlay) actions.stopScenePlay()
      return
    }
    const conversationId = conv.id
    const sid = speakerId ?? nextSpeakerId(conv, personas)
    if (!sid) {
      if (state.scenePlay) actions.stopScenePlay()
      return
    }

    // Commit: block any concurrent advance until this beat's done/error arrives.
    beatInFlight = true
    try {
      // Auto-compaction: summarize older beats before the window overflows so the
      // scene can run long without truncating the next reply.
      const ctx = state.contextUsage
      const cset = state.settings?.context
      if (
        cset?.autoCompact &&
        ctx &&
        ctx.contextSize > 0 &&
        (ctx.willOverflow || ctx.fraction >= cset.compactThreshold)
      ) {
        const did = await actions.compact(conversationId, { silent: true })
        if (did) conv = state.conversations.find((c) => c.id === conversationId) ?? conv
      }

      const persona = findPersona(personas, sid)
      const beat: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        createdAt: now(),
        speakerId: sid,
        speakerName: persona?.name
      }
      let saved: Conversation | null = null
      updateConversation(conversationId, (c) => {
        saved = { ...c, modelId: state.engine.modelId, messages: [...c.messages, beat], updatedAt: now() }
        return saved
      })
      if (saved) await window.sibyl.conversations.save(saved)
      // The active speaker (and system prompt) changed — force a fresh rebuild.
      await window.sibyl.chat.invalidateSession(conversationId)
      const res = await window.sibyl.chat.advance({
        conversationId,
        speakerId: sid,
        assistantMessageId: beat.id
      })
      // On success the latch clears when the beat's done/error event arrives;
      // a failed kickoff produces no such event, so release it here.
      if (!res.ok) {
        beatInFlight = false
        toast(res.error ?? 'Failed to advance the scene', 'error')
        if (state.scenePlay) actions.stopScenePlay()
      }
    } catch (err) {
      beatInFlight = false
      toast(err instanceof Error ? err.message : 'Failed to advance the scene', 'error')
      if (state.scenePlay) actions.stopScenePlay()
    }
  },

  /** Speak into a scene as the human's own character, then let the cast respond. */
  async sceneSpeak(text: string): Promise<void> {
    const content = text.trim()
    if (!content) return
    if (state.engine.state === 'generating') return
    const conv = activeConversation()
    if (!conv || !isScene(conv)) return
    maybePrewarmAudio() // still inside the submit gesture
    const msg: ChatMessage = { id: uid(), role: 'user', content, createdAt: now() }
    let saved: Conversation | null = null
    updateConversation(conv.id, (c) => {
      saved = { ...c, messages: [...c.messages, msg], updatedAt: now() }
      return saved
    })
    if (saved) await window.sibyl.conversations.save(saved)
    await window.sibyl.chat.invalidateSession(conv.id)
    await actions.advanceScene()
  },

  /** Drop an out-of-character director note, then play one beat shaped by it. */
  async sceneDirect(text: string): Promise<void> {
    const content = text.trim()
    if (!content) return
    if (state.engine.state === 'generating') return
    const conv = activeConversation()
    if (!conv || !isScene(conv)) return
    maybePrewarmAudio() // still inside the submit gesture
    const note: ChatMessage = { id: uid(), role: 'user', content, createdAt: now(), director: true }
    let saved: Conversation | null = null
    updateConversation(conv.id, (c) => {
      saved = { ...c, messages: [...c.messages, note], updatedAt: now() }
      return saved
    })
    if (saved) await window.sibyl.conversations.save(saved)
    await window.sibyl.chat.invalidateSession(conv.id)
    await actions.advanceScene()
  },

  /** Begin watching: auto-advance the active scene beat after beat. */
  startScenePlay(): void {
    const conv = activeConversation()
    if (!conv || !isScene(conv)) return
    if (!state.engine.modelId) {
      toast('Load a model before playing a scene.', 'error')
      return
    }
    maybePrewarmAudio() // Play is a user gesture — warm audio for narrated beats
    setState({ scenePlay: { convId: conv.id } })
    actions.tickScenePlay()
  },

  /** Pause autoplay; any in-flight beat is allowed to finish. */
  stopScenePlay(): void {
    clearSceneTimer()
    if (state.scenePlay) setState({ scenePlay: null })
  },

  toggleScenePlay(): void {
    if (state.scenePlay) actions.stopScenePlay()
    else actions.startScenePlay()
  },

  /** Schedule the next autoplay beat after a readable pause. */
  scheduleNextBeat(): void {
    clearSceneTimer()
    sceneTimer = setTimeout(() => actions.tickScenePlay(), SCENE_BEAT_DELAY_MS)
  },

  /** Autoplay tick: advance when free, otherwise poll until it is. */
  tickScenePlay(): void {
    const play = state.scenePlay
    if (!play) return
    const conv = state.conversations.find((c) => c.id === play.convId)
    if (!conv || !isScene(conv)) {
      actions.stopScenePlay()
      return
    }
    // Not ready to advance yet — poll again shortly rather than waiting on a
    // matching 'done' (which never comes if the engine is busy with ANOTHER
    // conversation, which would otherwise stall the scene). Covers a beat in
    // flight and waiting for the current line's narration to finish.
    const narrating =
      Boolean(state.settings?.tts.enabled && state.settings.tts.autoSpeak && state.speakingMessageId)
    if (beatInFlight || state.engine.state === 'generating' || narrating) {
      clearSceneTimer()
      sceneTimer = setTimeout(() => actions.tickScenePlay(), 300)
      return
    }
    void actions.advanceScene()
  },

  /** Add a persona to the active scene's cast (turning a thread into a scene at ≥2). */
  addCastMember(personaId: string): void {
    const conv = activeConversation()
    if (!conv) return
    if (conv.cast?.includes(personaId)) return
    const cast = [...(conv.cast ?? []), personaId]
    const updated = { ...conv, cast, updatedAt: now() }
    updateConversation(conv.id, () => updated)
    persist(updated)
    void window.sibyl.chat.invalidateSession(conv.id)
    void actions.refreshContextUsage()
  },

  /** Remove a persona from the active scene's cast (keeping the ≥2 minimum). */
  removeCastMember(personaId: string): void {
    const conv = activeConversation()
    if (!conv?.cast) return
    if (conv.cast.length <= MIN_SCENE_CAST) {
      toast('A scene needs at least two characters.', 'info')
      return
    }
    const cast = conv.cast.filter((id) => id !== personaId)
    const updated = { ...conv, cast, updatedAt: now() }
    updateConversation(conv.id, () => updated)
    persist(updated)
    void window.sibyl.chat.invalidateSession(conv.id)
    void actions.refreshContextUsage()
  },

  /** Set (or clear) the active scene's premise. */
  setScenePremise(premise: string): void {
    const conv = activeConversation()
    if (!conv) return
    const updated = { ...conv, scenePremise: premise.trim() || undefined, updatedAt: now() }
    updateConversation(conv.id, () => updated)
    persist(updated)
    void window.sibyl.chat.invalidateSession(conv.id)
  },

  /** Edit a message's text in place (no resend) — used for director notes. */
  editMessageContent(messageId: string, text: string): void {
    const content = text.trim()
    const conv = activeConversation()
    if (!conv) return
    const updated = {
      ...conv,
      messages: conv.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
      updatedAt: now()
    }
    updateConversation(conv.id, () => updated)
    persist(updated)
    void window.sibyl.chat.invalidateSession(conv.id)
    void actions.refreshContextUsage()
  },

  // --- personas -----------------------------------------------------------
  /** Create or update a persona in the library. */
  savePersona(persona: Persona): void {
    const personas = state.settings?.personas ?? []
    const exists = personas.some((p) => p.id === persona.id)
    const next = exists ? personas.map((p) => (p.id === persona.id ? persona : p)) : [...personas, persona]
    void actions.updateSettings({ personas: next })
  },

  /** Remove a persona from the library. Threads referencing it fall back to the global prompt. */
  deletePersona(id: string): void {
    const personas = (state.settings?.personas ?? []).filter((p) => p.id !== id)
    void actions.updateSettings({ personas })
  },

  /** Point a thread at a persona (or clear it). Rebuilds the engine session. */
  async setConversationPersona(id: string, personaId: string | null): Promise<void> {
    const conv = state.conversations.find((c) => c.id === id)
    if (!conv) return
    const updated = { ...conv, personaId: personaId ?? undefined, updatedAt: now() }
    updateConversation(id, () => updated)
    persist(updated)
    await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  /** Set (or clear) the writer's own character for a thread. Rebuilds the session. */
  async setUserCharacter(id: string, uc: UserCharacter | undefined): Promise<void> {
    const conv = state.conversations.find((c) => c.id === id)
    if (!conv) return
    const clean = uc && (uc.name.trim() || uc.description.trim()) ? uc : undefined
    const updated = { ...conv, userCharacter: clean, updatedAt: now() }
    updateConversation(id, () => updated)
    persist(updated)
    await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  selectConversation(id: string): void {
    // Switching away from the conversation that's auto-playing stops the loop.
    if (state.scenePlay && state.scenePlay.convId !== id) actions.stopScenePlay()
    setState({ activeConversationId: id, view: 'chat', personaPickerOpen: false })
    void actions.refreshContextUsage()
  },

  async deleteConversation(id: string): Promise<void> {
    if (state.scenePlay?.convId === id) actions.stopScenePlay()
    await window.sibyl.conversations.delete(id)
    setState((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id)
      return {
        conversations,
        activeConversationId:
          s.activeConversationId === id ? (conversations[0]?.id ?? null) : s.activeConversationId
      }
    })
  },

  renameConversation(id: string, title: string): void {
    updateConversation(id, (c) => {
      const updated = { ...c, title: title.trim() || 'Untitled', updatedAt: now() }
      persist(updated)
      return updated
    })
  },

  async sendMessage(text: string): Promise<void> {
    const content = text.trim()
    if (!content) return
    if (!state.engine.modelId) {
      toast('Load a model before chatting.', 'error')
      return
    }
    let conv = activeConversation()
    if (!conv) {
      const id = actions.newConversation()
      conv = state.conversations.find((c) => c.id === id) ?? null
      if (!conv) return
    }
    const conversationId = conv.id

    // Auto-compaction: if the window is about to overflow, summarize older turns
    // before adding this turn so the new message is never folded away.
    const ctx = state.contextUsage
    const cset = state.settings?.context
    if (
      cset?.autoCompact &&
      ctx &&
      ctx.contextSize > 0 &&
      (ctx.willOverflow || ctx.fraction >= cset.compactThreshold)
    ) {
      const did = await actions.compact(conversationId, { silent: true })
      if (did) {
        toast('Context was full — older messages were summarized', 'info')
        conv = state.conversations.find((c) => c.id === conversationId) ?? conv
      }
    }

    // Pre-warm the audio context inside this send gesture so an auto-spoken reply
    // can start later (when generation finishes) without its own user gesture.
    maybePrewarmAudio()

    const userMsg: ChatMessage = { id: uid(), role: 'user', content, createdAt: now() }
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now() }

    const isFirst = conv.messages.filter((m) => m.role === 'user').length === 0
    const title = isFirst ? content.slice(0, 48) : conv.title

    let saved: Conversation | null = null
    updateConversation(conversationId, (c) => {
      saved = {
        ...c,
        title,
        modelId: state.engine.modelId,
        messages: [...c.messages, userMsg, assistantMsg],
        updatedAt: now()
      }
      return saved
    })
    // Persist the user turn before generation so the engine can rebuild history.
    if (saved) await window.sibyl.conversations.save(saved)

    const res = await window.sibyl.chat.send({
      conversationId,
      message: content,
      assistantMessageId: assistantMsg.id
    })
    if (!res.ok) toast(res.error ?? 'Failed to send message', 'error')
  },

  abortGeneration(): void {
    // Stopping also halts scene autoplay so the aborted beat's 'done' doesn't
    // immediately schedule the next one.
    if (state.scenePlay) actions.stopScenePlay()
    if (state.activeConversationId) void window.sibyl.chat.abort(state.activeConversationId)
  },

  /** Remove a single message from the active conversation. */
  deleteMessage(messageId: string): void {
    const conv = activeConversation()
    if (!conv) return
    const messages = conv.messages.filter((m) => m.id !== messageId)
    if (messages.length === conv.messages.length) return
    const updated = {
      ...conv,
      messages,
      compaction: survivingCompaction(conv, messages),
      updatedAt: now()
    }
    updateConversation(conv.id, () => updated)
    persist(updated)
    // History changed under the engine's warm session — force a rebuild next turn.
    void window.sibyl.chat.invalidateSession(conv.id)
    void actions.refreshContextUsage()
  },

  /**
   * Resample an assistant turn: drop it and everything after the user turn it
   * replied to, then regenerate. Also used as "retry" after a failed generation.
   */
  async regenerate(assistantMessageId: string): Promise<void> {
    if (!state.engine.modelId) {
      toast('Load a model before regenerating.', 'error')
      return
    }
    if (state.engine.state === 'generating') return
    const conv = activeConversation()
    if (!conv) return
    const idx = conv.messages.findIndex((m) => m.id === assistantMessageId)
    if (idx < 0) return
    // Scene beat: reroll it — drop this beat (and anything after) and have the
    // same character speak again.
    if (isScene(conv) && conv.messages[idx].speakerId) {
      const speakerId = conv.messages[idx].speakerId!
      const messages = conv.messages.slice(0, idx)
      const updated = {
        ...conv,
        messages,
        compaction: survivingCompaction(conv, messages),
        updatedAt: now()
      }
      updateConversation(conv.id, () => updated)
      await window.sibyl.conversations.save(updated)
      await window.sibyl.chat.invalidateSession(conv.id)
      await actions.advanceScene(speakerId)
      return
    }
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx < 0) return
    const userText = conv.messages[userIdx].content
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now() }
    await runTurn(conv, [...conv.messages.slice(0, userIdx + 1), assistantMsg], userText, assistantMsg.id)
  },

  /**
   * Edit a prior user message, truncate the conversation to that point, and
   * regenerate from the edited text.
   */
  async editAndResend(userMessageId: string, newText: string): Promise<void> {
    const content = newText.trim()
    if (!content) return
    if (!state.engine.modelId) {
      toast('Load a model before sending.', 'error')
      return
    }
    if (state.engine.state === 'generating') return
    const conv = activeConversation()
    if (!conv) return
    const idx = conv.messages.findIndex((m) => m.id === userMessageId)
    if (idx < 0 || conv.messages[idx].role !== 'user') return
    const editedUser: ChatMessage = { ...conv.messages[idx], content, createdAt: now() }
    // Scene: replace the human's line, truncate what followed, then let the next
    // character respond to the edited turn (rather than the single-persona path).
    if (isScene(conv)) {
      const messages = [...conv.messages.slice(0, idx), editedUser]
      const updated = {
        ...conv,
        messages,
        compaction: survivingCompaction(conv, messages),
        updatedAt: now()
      }
      updateConversation(conv.id, () => updated)
      await window.sibyl.conversations.save(updated)
      await window.sibyl.chat.invalidateSession(conv.id)
      await actions.advanceScene()
      return
    }
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now() }
    await runTurn(conv, [...conv.messages.slice(0, idx), editedUser, assistantMsg], content, assistantMsg.id)
  },

  /**
   * Fork the active conversation at a message into a NEW conversation containing
   * everything up to and including that message (carrying overrides). Switches to
   * the branch; the original is left untouched.
   */
  branchConversation(messageId: string): string | null {
    const conv = activeConversation()
    if (!conv) return null
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return null
    const messages = conv.messages.slice(0, idx + 1).map((m) => ({ ...m }))
    const branch: Conversation = {
      id: uid(),
      title: `${conv.title} (branch)`,
      modelId: conv.modelId,
      messages,
      createdAt: now(),
      updatedAt: now(),
      overrides: conv.overrides,
      compaction: survivingCompaction(conv, messages),
      // Carry scene identity so a branched scene stays a scene.
      personaId: conv.personaId,
      userCharacter: conv.userCharacter,
      cast: conv.cast,
      scenePremise: conv.scenePremise
    }
    setState((s) => ({
      conversations: [branch, ...s.conversations],
      activeConversationId: branch.id,
      view: 'chat'
    }))
    persist(branch)
    void actions.refreshContextUsage()
    return branch.id
  },

  /**
   * Set (or clear) a conversation's per-conversation system-prompt / generation
   * overrides. Only rebuilds the engine session when the effective system prompt
   * changed — gen-param tweaks take effect on the next send without a KV rebuild.
   */
  async setConversationOverrides(
    id: string,
    overrides: ConversationOverrides | undefined
  ): Promise<void> {
    const conv = state.conversations.find((c) => c.id === id)
    if (!conv) return
    const clean: ConversationOverrides = {}
    if (overrides?.systemPrompt?.trim()) clean.systemPrompt = overrides.systemPrompt
    if (overrides?.generation) clean.generation = overrides.generation
    const next = Object.keys(clean).length ? clean : undefined

    const prevPrompt = conv.overrides?.systemPrompt?.trim() ?? ''
    const nextPrompt = next?.systemPrompt?.trim() ?? ''

    const updated = { ...conv, overrides: next, updatedAt: now() }
    updateConversation(id, () => updated)
    persist(updated)
    if (prevPrompt !== nextPrompt) await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  /** Render the conversation and prompt the user to save it to a file. */
  async exportConversation(id: string, format: ExportFormat): Promise<void> {
    const res = await window.sibyl.conversations.export(id, format)
    if (!res.ok) {
      toast(res.error ?? 'Export failed', 'error')
      return
    }
    if (res.data?.saved) toast('Conversation exported', 'success')
  },

  // --- models -------------------------------------------------------------
  async loadModel(id: string): Promise<void> {
    const res = await window.sibyl.engine.load(id)
    if (res.ok && res.data) {
      setState({ engine: res.data })
      const model = state.installedModels.find((m) => m.id === id)
      toast(`Loaded ${model?.filename ?? id}`, 'success')
      void actions.refreshContextUsage()
    } else {
      toast(res.error ?? 'Failed to load model', 'error')
    }
  },

  async unloadModel(): Promise<void> {
    await window.sibyl.engine.unload()
    setState({ contextUsage: null })
  },

  async deleteModel(id: string): Promise<void> {
    const model = state.installedModels.find((m) => m.id === id)
    await window.sibyl.models.delete(id)
    await actions.refreshModels()
    toast(model?.local ? 'Model removed from library (file kept)' : 'Model deleted', 'info')
  },

  /** Pick a pre-downloaded .gguf from disk and register it (in place). */
  async importLocalModel(): Promise<void> {
    const res = await window.sibyl.models.import()
    if (res.ok && res.data) {
      await actions.refreshModels()
      toast(`Imported ${res.data.filename}`, 'success')
    } else if (!res.ok) {
      toast(res.error ?? 'Failed to import model', 'error')
    }
    // res.ok && data === null → the user cancelled the picker; stay quiet.
  },

  revealModel(id: string): void {
    void window.sibyl.models.reveal(id)
  },

  // --- downloads ----------------------------------------------------------
  async startDownload(repoId: string, filename: string): Promise<void> {
    const res = await window.sibyl.downloads.start(repoId, filename)
    if (res.ok) toast(`Started download: ${filename}`, 'info')
    else toast(res.error ?? 'Download failed to start', 'error')
  },

  cancelDownload(id: string): void {
    void window.sibyl.downloads.cancel(id)
  },

  // --- discover -----------------------------------------------------------
  setDiscoverQuery(query: string): void {
    setState((s) => ({ discover: { ...s.discover, query } }))
  },

  setDiscoverSort(sort: SortKey): void {
    setState((s) => ({ discover: { ...s.discover, sort } }))
    void actions.search()
  },

  async search(): Promise<void> {
    const { query, sort } = state.discover
    setState((s) => ({ discover: { ...s.discover, loading: true, error: null } }))
    const res = await window.sibyl.hf.search(query, sort)
    setState((s) => ({
      discover: {
        ...s.discover,
        loading: false,
        results: res.ok ? (res.data ?? []) : [],
        error: res.ok ? null : (res.error ?? 'Search failed')
      }
    }))
  },

  async openModelDetail(repoId: string): Promise<void> {
    setState((s) => ({ discover: { ...s.discover, detailLoading: true, selected: null } }))
    const res = await window.sibyl.hf.modelDetail(repoId)
    setState((s) => ({
      discover: {
        ...s.discover,
        detailLoading: false,
        selected: res.ok ? (res.data ?? null) : null,
        error: res.ok ? s.discover.error : (res.error ?? 'Failed to load model')
      }
    }))
  },

  closeModelDetail(): void {
    setState((s) => ({ discover: { ...s.discover, selected: null } }))
  },

  // --- settings -----------------------------------------------------------
  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    const res = await window.sibyl.settings.set(patch)
    if (res.ok && res.data) {
      setState({ settings: res.data })
      if (patch.theme) document.documentElement.classList.toggle('light', patch.theme === 'light')
      if (patch.accent) applyAccentTheme(patch.accent)
      if (patch.tts?.volume !== undefined) ttsPlayer.setVolume(patch.tts.volume)
    } else {
      toast(res.error ?? 'Failed to save settings', 'error')
    }
  },

  // --- text-to-speech -----------------------------------------------------
  /** Merge a patch into the TTS settings (and persist). */
  updateTtsSettings(patch: Partial<TtsSettings>): void {
    const cur = state.settings?.tts
    if (!cur) return
    void actions.updateSettings({ tts: { ...cur, ...patch } })
  },

  async refreshVoices(): Promise<void> {
    const res = await window.sibyl.tts.listVoices()
    if (res.ok) setState({ installedVoices: res.data ?? [] })
  },

  downloadVoice(voiceId: string): void {
    void window.sibyl.tts.downloadVoice(voiceId)
    toast('Downloading voice…', 'info')
  },

  cancelVoiceDownload(voiceId: string): void {
    void window.sibyl.tts.cancelVoiceDownload(voiceId)
  },

  async deleteVoice(voiceId: string): Promise<void> {
    if (state.speakingMessageId) actions.stopSpeaking()
    await window.sibyl.tts.deleteVoice(voiceId)
    await actions.refreshVoices()
    // Clear the selection if we removed the active voice.
    if (state.settings?.tts.voiceId === voiceId) {
      actions.updateTtsSettings({ voiceId: null })
    }
    toast('Voice removed', 'info')
  },

  /** Speak a message aloud (manual play). Must run inside a click handler. */
  async speakMessage(messageId: string, text: string): Promise<void> {
    const ready = ttsReadiness()
    if (!ready.ok) {
      toast(ready.reason, 'info')
      return
    }
    // Create/resume the AudioContext within this user gesture so audio can start.
    ttsPlayer.ensureContext()
    const res = await window.sibyl.tts.speak({ messageId, text })
    if (!res.ok) toast(res.error ?? 'Failed to start speech', 'error')
  },

  stopSpeaking(): void {
    ttsPlayer.stop()
    void window.sibyl.tts.stop()
  },

  /** Play a short sample with a specific installed voice (ignores the enabled flag). */
  async testVoice(voiceId: string): Promise<void> {
    if (!state.tts?.available) {
      toast(state.tts?.error ?? 'Speech is unavailable in this build.', 'info')
      return
    }
    ttsPlayer.ensureContext()
    const voice = state.installedVoices.find((v) => v.id === voiceId)
    const res = await window.sibyl.tts.speak({
      messageId: '__tts_test__',
      text: `Hello, I'm ${voice?.name ?? 'your selected voice'}. This is how I sound in Sibyl.`,
      voiceId
    })
    if (!res.ok) toast(res.error ?? 'Failed to play a sample', 'error')
  },

  /** Auto-speak a freshly completed reply when the setting is on. */
  maybeAutoSpeak(messageId: string, text: string): void {
    const s = state.settings?.tts
    if (!s?.enabled || !s.autoSpeak || !text.trim()) return
    if (!ttsReadiness().ok) return
    ttsPlayer.ensureContext()
    void window.sibyl.tts.speak({ messageId, text })
  },

  // --- auto-update --------------------------------------------------------
  async checkForUpdate(): Promise<void> {
    const res = await window.sibyl.update.check()
    if (res.ok && res.data) setState({ update: res.data })
    else if (!res.ok) toast(res.error ?? 'Update check failed', 'error')
  },

  async installUpdate(): Promise<void> {
    // Swaps to the downloaded side-by-side version on quit, then relaunches.
    const res = await window.sibyl.update.install()
    if (!res.ok) toast(res.error ?? 'Failed to install the update', 'error')
  },

  dismissToast(): void {
    setState({ toast: null })
  }
}

export { activeConversation }

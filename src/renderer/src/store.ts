import { useSyncExternalStore } from 'react'
import type {
  ChatMessage,
  Conversation,
  ConversationOverrides,
  ContextUsage,
  ContextUsageProjection,
  DownloadProgress,
  EngineStatus,
  HFModelDetail,
  HFModelSummary,
  InstalledModel,
  Persona,
  RendererSettings,
  RendererSettingsPatch,
  Result,
  StorageIssue,
  UpdateStatus,
  UserCharacter
} from '@shared/types'
import type { AppInfo } from '@shared/ipc'
import type { ExportFormat } from '@shared/export'
import type { InstalledVoice, TtsSettings, TtsStatus, TtsVoiceDownload } from '@shared/tts'
import { getAccentTheme, hexToRgbChannels } from '@shared/themes'
import { contextUsageIsCurrent } from '@shared/context'
import {
  beginRendererTurn,
  IDLE_RENDERER_TURN,
  rendererTurnIsBusy,
  rendererTurnMatches,
  transitionRendererTurn,
  type RendererTurnKind,
  type RendererTurnState
} from '@shared/turn'
import { findPersona } from '@shared/personas'
import {
  isScene,
  sceneCast,
  nextSpeakerId,
  stripSpeakerPrefix,
  truncateAtForeignSpeaker,
  userDisplayName,
  MIN_SCENE_CAST
} from '@shared/scene'
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
  settings: RendererSettings | null
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
  /** Renderer-owned authority for every chat/scene/compaction operation. */
  turnOperation: RendererTurnState
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
  /** Conversation snapshots whose last durable save failed. */
  unsavedConversationIds: string[]
  storageIssues: StorageIssue[]
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
  turnOperation: IDLE_RENDERER_TURN,
  streamStats: null,
  update: null,
  toast: null,
  personaPickerOpen: false,
  tts: null,
  installedVoices: [],
  voiceDownloads: {},
  speakingMessageId: null,
  scenePlay: null,
  unsavedConversationIds: [],
  storageIssues: []
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

async function persist(conversation: Conversation): Promise<boolean> {
  let result
  try {
    result = await window.sibyl.conversations.save(conversation)
  } catch {
    result = { ok: false, error: 'Conversation persistence became unavailable.' }
  }
  if (result.ok) {
    setState((s) => ({
      unsavedConversationIds: s.unsavedConversationIds.filter((id) => id !== conversation.id)
    }))
    return true
  }
  setState((s) => ({
    unsavedConversationIds: s.unsavedConversationIds.includes(conversation.id)
      ? s.unsavedConversationIds
      : [...s.unsavedConversationIds, conversation.id]
  }))
  toast(result.error ?? 'Conversation could not be saved. Changes remain in memory.', 'error')
  return false
}

async function invalidateConversation(conversationId: string): Promise<string | null> {
  try {
    const result = await window.sibyl.chat.invalidateSession(conversationId)
    return result.ok ? null : (result.error ?? 'The conversation session could not be rebuilt.')
  } catch {
    return 'The conversation session became unavailable.'
  }
}

async function safeIpc<T>(
  call: () => Promise<Result<T>>,
  unavailableError: string
): Promise<Result<T>> {
  try {
    return await call()
  } catch {
    return { ok: false, error: unavailableError }
  }
}

function claimTurn(kind: RendererTurnKind, conversationId: string): string | null {
  const operationId = uid()
  const next = beginRendererTurn(state.turnOperation, {
    operationId,
    kind,
    conversationId
  })
  if (!next) return null
  setState({ turnOperation: next })
  return operationId
}

function transitionTurn(
  operationId: string,
  patch: Partial<Omit<RendererTurnState, 'operationId'>>
): void {
  setState((s) => ({
    turnOperation: transitionRendererTurn(s.turnOperation, operationId, patch)
  }))
}

function failTurn(operationId: string, error: string): void {
  transitionTurn(operationId, { phase: 'failed', error })
}

function failTurnForMessage(conversationId: string, messageId: string, error: string): void {
  if (rendererTurnMatches(state.turnOperation, conversationId, messageId)) {
    failTurn(state.turnOperation.operationId!, error)
  }
}

function rollbackOptimisticConversation(snapshot: Conversation): void {
  updateConversation(snapshot.id, () => snapshot)
}

let confirmedSettings: RendererSettings | null = null
let pendingTextSettings: RendererSettingsPatch | null = null
let settingsTextTimer: ReturnType<typeof setTimeout> | null = null

function mergeSettingsPatch(
  current: RendererSettings,
  patch: RendererSettingsPatch
): RendererSettings {
  return {
    ...current,
    ...patch,
    generation: { ...current.generation, ...(patch.generation ?? {}) },
    load: { ...current.load, ...(patch.load ?? {}) },
    context: { ...current.context, ...(patch.context ?? {}) },
    tts: { ...current.tts, ...(patch.tts ?? {}) }
  }
}

async function flushPendingTextSettings(): Promise<boolean> {
  if (settingsTextTimer) clearTimeout(settingsTextTimer)
  settingsTextTimer = null
  const patch = pendingTextSettings
  pendingTextSettings = null
  if (!patch) return true
  const res = await window.sibyl.settings.set(patch)
  if (res.ok && res.data) {
    confirmedSettings = res.data
    setState({ settings: res.data })
    return true
  }
  if (confirmedSettings) setState({ settings: confirmedSettings })
  toast(res.error ?? 'Failed to save settings; the last confirmed values were restored.', 'error')
  return false
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
  if (
    !s.voiceId ||
    !state.installedVoices.some(
      (v) => v.id === s.voiceId && (!v.availability || v.availability === 'available')
    )
  ) {
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
      s.installedVoices.some(
        (v) => v.id === t.voiceId && (!v.availability || v.availability === 'available')
      )
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
  assistantId: string,
  operationId: string
): Promise<boolean> {
  const updated: Conversation = {
    ...conv,
    modelId: state.engine.modelId,
    messages,
    compaction: survivingCompaction(conv, messages),
    updatedAt: now()
  }
  updateConversation(conv.id, () => updated)
  transitionTurn(operationId, { messageId: assistantId })
  // Persist the truncated history and invalidate before sending so the engine
  // rebuilds its session from this new state rather than the stale KV cache.
  if (!(await persist(updated))) {
    rollbackOptimisticConversation(conv)
    failTurn(operationId, 'The edited turn could not be saved.')
    return false
  }
  const invalidationError = await invalidateConversation(conv.id)
  if (invalidationError) {
    updateConversation(conv.id, (c) => {
      const failed = {
        ...c,
        messages: c.messages.map((m) =>
          m.id === assistantId ? { ...m, error: invalidationError } : m
        )
      }
      void persist(failed)
      return failed
    })
    failTurn(operationId, invalidationError)
    toast(invalidationError, 'error')
    return false
  }
  setState({ streamStats: { messageId: assistantId, startedAt: Date.now(), tokens: 0 } })
  const res = await safeIpc(
    () =>
      window.sibyl.chat.send({
        conversationId: conv.id,
        message: userText,
        assistantMessageId: assistantId
      }),
    'Chat generation became unavailable.'
  )
  if (!res.ok) {
    setState({ streamStats: null })
    const error = res.error ?? 'Failed to send message'
    updateConversation(conv.id, (c) => {
      const failed = {
        ...c,
        messages: c.messages.map((m) => (m.id === assistantId ? { ...m, error } : m))
      }
      void persist(failed)
      return failed
    })
    failTurn(operationId, error)
    toast(error, 'error')
    return false
  }
  if (
    state.turnOperation.operationId === operationId &&
    state.turnOperation.phase === 'preparing'
  ) {
    transitionTurn(operationId, { phase: 'generating' })
  }
  return true
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

    const [settingsRes, infoRes, modelsRes, convRes, statusRes, dlRes, updateRes, ttsRes, voicesRes, voiceDlRes, issuesRes] =
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
        window.sibyl.tts.listDownloads(),
        window.sibyl.app.storageIssues()
      ])

    const downloads: Record<string, DownloadProgress> = {}
    if (dlRes.ok && dlRes.data) for (const d of dlRes.data) downloads[d.id] = d
    const voiceDownloads: Record<string, TtsVoiceDownload> = {}
    if (voiceDlRes.ok && voiceDlRes.data) for (const d of voiceDlRes.data) voiceDownloads[d.voiceId] = d
    const finalIssuesRes = await window.sibyl.app.storageIssues()

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
      voiceDownloads,
      storageIssues: finalIssuesRes.data ?? issuesRes.data ?? []
    })
    confirmedSettings = settingsRes.data ?? null

    // Wire the audio player: it is the source of truth for what's audibly speaking.
    ttsPlayer.init({
      onSpeakingChange: (id) =>
        setState((s) => {
          let turnOperation = s.turnOperation
          const operationId = turnOperation.operationId
          if (
            id &&
            operationId &&
            turnOperation.messageId === id &&
            turnOperation.phase === 'narration-pending'
          ) {
            turnOperation = transitionRendererTurn(turnOperation, operationId, {
              phase: 'narrating'
            })
          } else if (
            !id &&
            operationId &&
            (turnOperation.phase === 'narration-pending' ||
              turnOperation.phase === 'narrating')
          ) {
            turnOperation = transitionRendererTurn(turnOperation, operationId, {
              phase: 'complete'
            })
          }
          return { speakingMessageId: id, turnOperation }
        })
    })
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
      if (e.type === 'error') {
        if (
          state.turnOperation.messageId === e.messageId &&
          state.turnOperation.operationId &&
          (state.turnOperation.phase === 'narration-pending' ||
            state.turnOperation.phase === 'narrating')
        ) {
          failTurn(state.turnOperation.operationId, e.error)
        }
        toast(e.error, 'error')
      }
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
        if (
          rendererTurnMatches(state.turnOperation, e.conversationId, e.messageId) &&
          state.turnOperation.operationId
        ) {
          transitionTurn(state.turnOperation.operationId, { phase: 'generating' })
        }
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
        let finishedText = ''
        updateConversation(e.conversationId, (c) => {
          const messages = c.messages.map((m) => {
            if (m.id !== e.messageId) return m
            // Scene beats: drop a leading "Name:" the model sometimes prepends
            // despite instruction (the UI already attributes the speaker).
            let content = m.speakerId ? stripSpeakerPrefix(m.content, m.speakerName) : m.content
            // Backstop the stop triggers: if the beat ran on into another
            // character's line, cut it at that foreign "Name:" cue.
            if (m.speakerId && isScene(c)) {
              const foreign = sceneCast(c, state.settings?.personas)
                .filter((p) => p.id !== m.speakerId)
                .map((p) => p.name)
              foreign.push(userDisplayName(c.userCharacter))
              content = truncateAtForeignSpeaker(content, foreign)
            }
            finishedText = content
            return { ...m, content, stats: e.stats, error: undefined }
          })
          const updated = { ...c, updatedAt: now(), messages }
          persist(updated)
          return updated
        })
        setState({ streamStats: null })
        if (rendererTurnMatches(state.turnOperation, e.conversationId, e.messageId)) {
          transitionTurn(state.turnOperation.operationId!, { phase: 'complete' })
        }
        // Auto-speak the freshly completed reply, when enabled.
        actions.maybeAutoSpeak(e.messageId, finishedText)
        // Drive scene autoplay forward to the next character's beat.
        if (state.scenePlay?.convId === e.conversationId) actions.scheduleNextBeat()
      } else if (e.type === 'aborted') {
        updateConversation(e.conversationId, (c) => {
          const updated = {
            ...c,
            updatedAt: now(),
            messages: c.messages.map((m) =>
              m.id === e.messageId
                ? { ...m, stats: e.stats, error: undefined, stopped: true }
                : m
            )
          }
          void persist(updated)
          return updated
        })
        setState({ streamStats: null })
        if (rendererTurnMatches(state.turnOperation, e.conversationId, e.messageId)) {
          transitionTurn(state.turnOperation.operationId!, { phase: 'complete' })
        }
        if (state.scenePlay?.convId === e.conversationId) actions.stopScenePlay()
        toast('Generation stopped — the partial response was kept.', 'info')
      } else if (e.type === 'error') {
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
        failTurnForMessage(e.conversationId, e.messageId, e.error)
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
    const requestedConversationId = state.activeConversationId
    let res
    try {
      res = await window.sibyl.context.usage(requestedConversationId)
    } catch {
      return
    }
    if (
      res.ok &&
      res.data &&
      contextUsageIsCurrent(res.data, requestedConversationId, state.activeConversationId)
    ) {
      setState({ contextUsage: res.data })
    }
  },

  /**
   * Preflight a pending request. The result is deliberately local to the caller:
   * it must not replace the meter with hypothetical input that may never commit.
   */
  async projectedContextUsage(
    projection: ContextUsageProjection
  ): Promise<ContextUsage | null> {
    if (!state.engine.modelId || state.activeConversationId !== projection.conversationId) {
      return null
    }
    let res
    try {
      res = await window.sibyl.context.projectedUsage(projection)
    } catch {
      return null
    }
    if (
      !res.ok ||
      !res.data ||
      !contextUsageIsCurrent(
        res.data,
        projection.conversationId,
        state.activeConversationId
      )
    ) {
      return null
    }
    return res.data
  },

  /**
   * Summarize older turns of a conversation to reclaim context. Returns true on
   * success. `silent` suppresses the success toast (used by auto-compaction).
   */
  async compact(
    conversationId?: string,
    opts?: { silent?: boolean; operationId?: string }
  ): Promise<boolean> {
    const id = conversationId ?? state.activeConversationId
    if (!id) return false
    let operationId = opts?.operationId
    const standalone = !operationId
    if (operationId) {
      if (
        state.turnOperation.operationId !== operationId ||
        state.turnOperation.conversationId !== id
      ) {
        return false
      }
    } else {
      operationId = claimTurn('compact', id) ?? undefined
      if (!operationId) return false
    }
    transitionTurn(operationId, { phase: 'compacting' })
    setState({ compacting: true })
    let res
    try {
      res = await window.sibyl.chat.compact(id)
    } catch {
      res = { ok: false, error: 'Compaction became unavailable.' }
    }
    setState({ compacting: false })
    if (!res.ok || !res.data) {
      // Auto-compaction is best-effort (e.g. nothing foldable yet) — stay quiet.
      if (!opts?.silent) toast(res.error ?? 'Compaction failed', 'error')
      if (standalone) failTurn(operationId, res.error ?? 'Compaction failed')
      else transitionTurn(operationId, { phase: 'preparing' })
      return false
    }
    const info = res.data
    const previous = state.conversations.find((c) => c.id === id)
    let updated: Conversation | null = null
    updateConversation(id, (c) => {
      updated = { ...c, compaction: info, updatedAt: now() }
      return updated
    })
    if (!updated || !(await persist(updated))) {
      if (previous) rollbackOptimisticConversation(previous)
      failTurn(operationId, 'The compacted conversation could not be saved.')
      return false
    }
    await actions.refreshContextUsage()
    transitionTurn(operationId, { phase: standalone ? 'complete' : 'preparing' })
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
      contextUsage: null,
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
      contextUsage: null,
      view: 'chat',
      personaPickerOpen: false
    }))
    persist(conv)
    void actions.refreshContextUsage()
    return conv.id
  },

  /** Generate one beat. `speakerId` overrides the round-robin pick. */
  async advanceScene(speakerId?: string, continuedOperationId?: string): Promise<boolean> {
    if (!state.engine.modelId) {
      toast('Load a model before playing a scene.', 'error')
      if (state.scenePlay) actions.stopScenePlay()
      if (continuedOperationId) failTurn(continuedOperationId, 'No model is loaded.')
      return false
    }
    if (continuedOperationId) {
      const continued = state.turnOperation
      if (
        continued.operationId !== continuedOperationId ||
        continued.kind !== 'scene' ||
        continued.conversationId !== state.activeConversationId
      ) {
        const error = 'The conversation changed before the response could start.'
        if (continued.operationId === continuedOperationId) failTurn(continuedOperationId, error)
        toast(error, 'error')
        return false
      }
    }
    let conv = activeConversation()
    if (!conv || !isScene(conv)) return false
    const conversationId = conv.id
    const operationId =
      continuedOperationId ??
      claimTurn('scene', conversationId)
    if (!operationId) return false
    if (
      continuedOperationId &&
      (state.turnOperation.operationId !== continuedOperationId ||
        state.turnOperation.conversationId !== conversationId ||
        state.turnOperation.kind !== 'scene')
    ) {
      return false
    }
    const personas = state.settings?.personas
    // A scene needs ≥2 *resolvable* characters; some of the cast may have been
    // deleted from the library, which would otherwise leave a one-voice monologue.
    if (sceneCast(conv, personas).length < MIN_SCENE_CAST) {
      const error = 'This scene needs at least two available characters.'
      failTurn(operationId, error)
      toast(error, 'error')
      if (state.scenePlay) actions.stopScenePlay()
      return false
    }
    const sid = speakerId ?? nextSpeakerId(conv, personas)
    if (!sid) {
      failTurn(operationId, 'No available scene speaker was found.')
      if (state.scenePlay) actions.stopScenePlay()
      return false
    }

    try {
      // Auto-compaction: summarize older beats before the window overflows so the
      // scene can run long without truncating the next reply.
      const ctx = await actions.projectedContextUsage({
        conversationId,
        nextSpeakerId: sid
      })
      // Projection is asynchronous. If the user switched threads while it was
      // running, do not commit a beat to the conversation they left.
      if (state.activeConversationId !== conversationId) {
        const error = 'The conversation changed before the response could start.'
        failTurn(operationId, error)
        toast(error, 'error')
        return false
      }
      const cset = state.settings?.context
      if (
        cset?.autoCompact &&
        ctx &&
        state.activeConversationId === conversationId &&
        ctx.conversationId === conversationId &&
        ctx.contextSize > 0 &&
        (ctx.willOverflow || ctx.fraction >= cset.compactThreshold)
      ) {
        const did = await actions.compact(conversationId, {
          silent: true,
          operationId
        })
        if (state.turnOperation.operationId === operationId && state.turnOperation.phase === 'failed') {
          if (state.scenePlay) actions.stopScenePlay()
          return false
        }
        if (did) conv = state.conversations.find((c) => c.id === conversationId) ?? conv
      }
      if (state.activeConversationId !== conversationId) {
        const error = 'The conversation changed before the response could start.'
        failTurn(operationId, error)
        toast(error, 'error')
        return false
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
      transitionTurn(operationId, { messageId: beat.id })
      if (saved && !(await persist(saved))) {
        rollbackOptimisticConversation(conv)
        failTurn(operationId, 'The scene beat could not be saved.')
        if (state.scenePlay) actions.stopScenePlay()
        return false
      }
      // The active speaker (and system prompt) changed — force a fresh rebuild.
      const invalidationError = await invalidateConversation(conversationId)
      if (invalidationError) {
        updateConversation(conversationId, (c) => {
          const updated = {
            ...c,
            messages: c.messages.map((m) =>
              m.id === beat.id ? { ...m, error: invalidationError } : m
            )
          }
          void persist(updated)
          return updated
        })
        failTurn(operationId, invalidationError)
        toast(invalidationError, 'error')
        if (state.scenePlay) actions.stopScenePlay()
        return false
      }
      setState({ streamStats: { messageId: beat.id, startedAt: Date.now(), tokens: 0 } })
      const res = await safeIpc(
        () =>
          window.sibyl.chat.advance({
            conversationId,
            speakerId: sid,
            assistantMessageId: beat.id
          }),
        'Scene generation became unavailable.'
      )
      if (!res.ok) {
        setState({ streamStats: null })
        const error = res.error ?? 'Failed to advance the scene'
        updateConversation(conversationId, (c) => {
          const updated = {
            ...c,
            messages: c.messages.map((m) => (m.id === beat.id ? { ...m, error } : m))
          }
          void persist(updated)
          return updated
        })
        failTurn(operationId, error)
        toast(error, 'error')
        if (state.scenePlay) actions.stopScenePlay()
        return false
      }
      if (
        state.turnOperation.operationId === operationId &&
        state.turnOperation.phase === 'preparing'
      ) {
        transitionTurn(operationId, { phase: 'generating' })
      }
      return true
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to advance the scene'
      failTurn(operationId, error)
      toast(error, 'error')
      if (state.scenePlay) actions.stopScenePlay()
      return false
    }
  },

  /** Speak into a scene as the human's own character, then let the cast respond. */
  async sceneSpeak(text: string): Promise<boolean> {
    const content = text.trim()
    if (!content || !state.engine.modelId) {
      if (!state.engine.modelId) toast('Load a model before playing a scene.', 'error')
      return false
    }
    const conv = activeConversation()
    if (!conv || !isScene(conv)) return false
    const operationId = claimTurn('scene', conv.id)
    if (!operationId) return false
    maybePrewarmAudio() // still inside the submit gesture
    const msg: ChatMessage = { id: uid(), role: 'user', content, createdAt: now() }
    let saved: Conversation | null = null
    updateConversation(conv.id, (c) => {
      saved = { ...c, messages: [...c.messages, msg], updatedAt: now() }
      return saved
    })
    if (saved && !(await persist(saved))) {
      rollbackOptimisticConversation(conv)
      failTurn(operationId, 'Your scene turn could not be saved.')
      return false
    }
    return actions.advanceScene(undefined, operationId)
  },

  /** Drop an out-of-character director note, then play one beat shaped by it. */
  async sceneDirect(text: string): Promise<boolean> {
    const content = text.trim()
    if (!content || !state.engine.modelId) {
      if (!state.engine.modelId) toast('Load a model before playing a scene.', 'error')
      return false
    }
    const conv = activeConversation()
    if (!conv || !isScene(conv)) return false
    const operationId = claimTurn('scene', conv.id)
    if (!operationId) return false
    maybePrewarmAudio() // still inside the submit gesture
    const note: ChatMessage = { id: uid(), role: 'user', content, createdAt: now(), director: true }
    let saved: Conversation | null = null
    updateConversation(conv.id, (c) => {
      saved = { ...c, messages: [...c.messages, note], updatedAt: now() }
      return saved
    })
    if (saved && !(await persist(saved))) {
      rollbackOptimisticConversation(conv)
      failTurn(operationId, 'The director note could not be saved.')
      return false
    }
    return actions.advanceScene(undefined, operationId)
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
    if (rendererTurnIsBusy(state.turnOperation) || narrating) {
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
    if (!(await persist(updated))) return
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
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  selectConversation(id: string): void {
    // Switching away from the conversation that's auto-playing stops the loop.
    if (state.scenePlay && state.scenePlay.convId !== id) actions.stopScenePlay()
    setState({
      activeConversationId: id,
      contextUsage: null,
      view: 'chat',
      personaPickerOpen: false
    })
    void actions.refreshContextUsage()
  },

  async deleteConversation(id: string): Promise<void> {
    const wasActive = state.activeConversationId === id
    if (state.scenePlay?.convId === id) actions.stopScenePlay()
    const result = await window.sibyl.conversations.delete(id)
    if (!result.ok) {
      toast(result.error ?? 'Conversation could not be deleted.', 'error')
      return
    }
    setState((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id)
      return {
        conversations,
        unsavedConversationIds: s.unsavedConversationIds.filter((convId) => convId !== id),
        activeConversationId:
          s.activeConversationId === id ? (conversations[0]?.id ?? null) : s.activeConversationId,
        contextUsage: s.activeConversationId === id ? null : s.contextUsage
      }
    })
    if (wasActive) void actions.refreshContextUsage()
  },

  renameConversation(id: string, title: string): void {
    updateConversation(id, (c) => {
      const updated = { ...c, title: title.trim() || 'Untitled', updatedAt: now() }
      persist(updated)
      return updated
    })
  },

  async sendMessage(text: string): Promise<boolean> {
    const content = text.trim()
    if (!content) return false
    if (!state.engine.modelId) {
      toast('Load a model before chatting.', 'error')
      return false
    }
    if (rendererTurnIsBusy(state.turnOperation)) return false
    let conv = activeConversation()
    if (!conv) {
      const id = actions.newConversation()
      conv = state.conversations.find((c) => c.id === id) ?? null
      if (!conv) return false
    }
    const conversationId = conv.id
    const operationId = claimTurn('chat', conversationId)
    if (!operationId) return false

    // Auto-compaction: if the window is about to overflow, summarize older turns
    // before adding this turn so the new message is never folded away.
    let ctx = await actions.projectedContextUsage({
      conversationId,
      prospectiveInput: { content }
    })
    // Do not let the new preflight await turn a send into a mutation of a thread
    // the user has already switched away from.
    if (state.activeConversationId !== conversationId) {
      const error = 'The conversation changed before the response could start.'
      failTurn(operationId, error)
      toast(error, 'error')
      return false
    }
    const cset = state.settings?.context
    if (
      cset?.autoCompact &&
      ctx &&
      state.activeConversationId === conversationId &&
      ctx.conversationId === conversationId &&
      ctx.contextSize > 0 &&
      (ctx.willOverflow || ctx.fraction >= cset.compactThreshold)
    ) {
      const did = await actions.compact(conversationId, { silent: true, operationId })
      if (state.turnOperation.operationId === operationId && state.turnOperation.phase === 'failed') {
        return false
      }
      if (did) {
        conv = state.conversations.find((c) => c.id === conversationId) ?? conv
        // Re-run the same prospective calculation: the ordinary refresh issued
        // by compact() still excludes the pending user turn.
        ctx = await actions.projectedContextUsage({
          conversationId,
          prospectiveInput: { content }
        })
        if (ctx?.conversationId === conversationId && ctx.willOverflow) {
          toast('Summarized, but recent messages still fill the window — the reply may be truncated.', 'error')
        } else {
          toast('Context was full — older messages were summarized', 'info')
        }
      }
    }
    if (state.activeConversationId !== conversationId) {
      const error = 'The conversation changed before the response could start.'
      failTurn(operationId, error)
      toast(error, 'error')
      return false
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
    transitionTurn(operationId, { messageId: assistantMsg.id })
    // Persist the user turn before generation so the engine can rebuild history.
    if (saved && !(await persist(saved))) {
      rollbackOptimisticConversation(conv)
      failTurn(operationId, 'The message could not be saved before generation.')
      return false
    }

    setState({ streamStats: { messageId: assistantMsg.id, startedAt: Date.now(), tokens: 0 } })
    const res = await safeIpc(
      () =>
        window.sibyl.chat.send({
          conversationId,
          message: content,
          assistantMessageId: assistantMsg.id
        }),
      'Chat generation became unavailable.'
    )
    if (!res.ok) {
      setState({ streamStats: null })
      const error = res.error ?? 'Failed to send message'
      updateConversation(conversationId, (c) => {
        const updated = {
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantMsg.id ? { ...m, error } : m
          )
        }
        void persist(updated)
        return updated
      })
      failTurn(operationId, error)
      toast(error, 'error')
      return false
    }
    if (
      state.turnOperation.operationId === operationId &&
      state.turnOperation.phase === 'preparing'
    ) {
      transitionTurn(operationId, { phase: 'generating' })
    }
    return true
  },

  abortGeneration(): void {
    // Stopping also halts scene autoplay so the aborted beat's 'done' doesn't
    // immediately schedule the next one.
    if (state.scenePlay) actions.stopScenePlay()
    const turn = state.turnOperation
    const conversationId = turn.conversationId
    const messageId = turn.messageId
    const operationId = turn.operationId
    if (!conversationId || !messageId || !operationId || turn.phase !== 'generating') return
    transitionTurn(operationId, { phase: 'stopping' })
    const engineOperation = state.engine.operation
    const operationMatches =
      engineOperation?.conversationId === conversationId &&
      engineOperation.messageId === messageId
    void safeIpc(
      () =>
        window.sibyl.chat.abort({
          conversationId,
          messageId,
          operationId: operationMatches ? engineOperation.id : undefined
        }),
      'The active response could not be stopped.'
    )
      .then((res) => {
        if (
          (!res.ok || !res.data?.aborted) &&
          state.turnOperation.operationId === operationId &&
          state.turnOperation.phase === 'stopping'
        ) {
          const error = res.error ?? 'The active response could not be stopped.'
          failTurn(operationId, error)
          toast(error, 'error')
        }
      })
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
    if (rendererTurnIsBusy(state.turnOperation)) return
    const conv = activeConversation()
    if (!conv) return
    const idx = conv.messages.findIndex((m) => m.id === assistantMessageId)
    if (idx < 0) return
    const operationId = claimTurn(isScene(conv) ? 'scene' : 'chat', conv.id)
    if (!operationId) return
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
      if (!(await persist(updated))) {
        rollbackOptimisticConversation(conv)
        failTurn(operationId, 'The scene history could not be saved.')
        return
      }
      await actions.advanceScene(speakerId, operationId)
      return
    }
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx < 0) {
      const error = 'No user turn was found to regenerate.'
      failTurn(operationId, error)
      toast(error, 'error')
      return
    }
    const userText = conv.messages[userIdx].content
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now() }
    await runTurn(
      conv,
      [...conv.messages.slice(0, userIdx + 1), assistantMsg],
      userText,
      assistantMsg.id,
      operationId
    )
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
    if (rendererTurnIsBusy(state.turnOperation)) return
    const conv = activeConversation()
    if (!conv) return
    const idx = conv.messages.findIndex((m) => m.id === userMessageId)
    if (idx < 0 || conv.messages[idx].role !== 'user') return
    const operationId = claimTurn(isScene(conv) ? 'scene' : 'chat', conv.id)
    if (!operationId) return
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
      if (!(await persist(updated))) {
        rollbackOptimisticConversation(conv)
        failTurn(operationId, 'The edited scene turn could not be saved.')
        return
      }
      await actions.advanceScene(undefined, operationId)
      return
    }
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now() }
    await runTurn(
      conv,
      [...conv.messages.slice(0, idx), editedUser, assistantMsg],
      content,
      assistantMsg.id,
      operationId
    )
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
      contextUsage: null,
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
    if (!(await persist(updated))) return
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
    const res = await window.sibyl.engine.unload()
    if (!res.ok) {
      toast(res.error ?? 'Failed to unload model', 'error')
      return
    }
    setState({ contextUsage: null })
  },

  async deleteModel(id: string): Promise<void> {
    const model = state.installedModels.find((m) => m.id === id)
    const res = await window.sibyl.models.delete(id)
    if (!res.ok) {
      toast(res.error ?? 'Model deletion was incomplete.', 'error')
      await actions.refreshModels()
      return
    }
    await actions.refreshModels()
    toast(model?.local ? 'Model removed from library (file kept)' : 'Model deleted', 'info')
  },

  async locateModel(id: string): Promise<void> {
    const res = await window.sibyl.models.locate(id)
    if (!res.ok) {
      toast(res.error ?? 'Could not update the model location.', 'error')
      return
    }
    if (res.data) {
      await actions.refreshModels()
      toast('Model location updated', 'success')
    }
  },

  async revealStorageRecovery(resource: StorageIssue['resource']): Promise<void> {
    const res = await window.sibyl.app.revealRecovery(resource)
    if (!res.ok) toast(res.error ?? 'Recovery copy is unavailable.', 'error')
  },

  async retryStorage(resource: StorageIssue['resource']): Promise<void> {
    if (resource === 'models') await actions.refreshModels()
    else await actions.refreshVoices()
    const res = await window.sibyl.app.storageIssues()
    if (res.ok) setState({ storageIssues: res.data ?? [] })
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
  async updateSettings(patch: RendererSettingsPatch): Promise<void> {
    if (!(await flushPendingTextSettings())) return
    const res = await window.sibyl.settings.set(patch)
    if (res.ok && res.data) {
      confirmedSettings = res.data
      setState({ settings: res.data })
      if (patch.theme) document.documentElement.classList.toggle('light', patch.theme === 'light')
      if (patch.accent) applyAccentTheme(patch.accent)
      if (patch.tts?.volume !== undefined) ttsPlayer.setVolume(patch.tts.volume)
    } else {
      toast(res.error ?? 'Failed to save settings', 'error')
    }
  },

  /** Optimistically coalesce textarea edits into one durable settings write. */
  queueTextSettings(patch: RendererSettingsPatch): void {
    if (!state.settings) return
    pendingTextSettings = pendingTextSettings
      ? {
          ...pendingTextSettings,
          ...patch,
          generation: patch.generation ?? pendingTextSettings.generation,
          load: patch.load ?? pendingTextSettings.load
        }
      : patch
    setState({ settings: mergeSettingsPatch(state.settings, patch) })
    if (settingsTextTimer) clearTimeout(settingsTextTimer)
    settingsTextTimer = setTimeout(() => {
      void flushPendingTextSettings()
    }, 150)
  },

  async flushTextSettings(): Promise<void> {
    await flushPendingTextSettings()
  },

  async setHfToken(token: string): Promise<boolean> {
    const res = await window.sibyl.settings.setHfToken(token)
    if (!res.ok) {
      toast(res.error ?? 'Failed to save Hugging Face token', 'error')
      return false
    }
    if (state.settings) setState({ settings: { ...state.settings, hfTokenConfigured: true } })
    return true
  },

  async clearHfToken(): Promise<boolean> {
    const res = await window.sibyl.settings.clearHfToken()
    if (!res.ok) {
      toast(res.error ?? 'Failed to clear Hugging Face token', 'error')
      return false
    }
    if (state.settings) setState({ settings: { ...state.settings, hfTokenConfigured: false } })
    return true
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
    void window.sibyl.tts.downloadVoice(voiceId).then((res) => {
      if (!res.ok) toast(res.error ?? 'Voice download could not start.', 'error')
    })
    toast('Downloading voice…', 'info')
  },

  cancelVoiceDownload(voiceId: string): void {
    void window.sibyl.tts.cancelVoiceDownload(voiceId)
  },

  async deleteVoice(voiceId: string): Promise<void> {
    if (state.speakingMessageId) actions.stopSpeaking()
    const result = await window.sibyl.tts.deleteVoice(voiceId)
    if (!result.ok) {
      toast(result.error ?? 'Voice could not be removed.', 'error')
      return
    }
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
    const operationId =
      state.turnOperation.messageId === messageId
        ? state.turnOperation.operationId
        : undefined
    if (operationId) transitionTurn(operationId, { phase: 'narration-pending' })
    void safeIpc(
      () => window.sibyl.tts.speak({ messageId, text }),
      'Speech became unavailable.'
    ).then((res) => {
      if (!res.ok && operationId) {
        failTurn(operationId, res.error ?? 'Failed to start speech')
        toast(res.error ?? 'Failed to start speech', 'error')
      }
    })
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

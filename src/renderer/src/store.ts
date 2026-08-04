import { useSyncExternalStore } from 'react'
import type {
  ChatMessage,
  Conversation,
  ConversationOverrides,
  ContextUsage,
  ContextUsageProjection,
  DownloadProgress,
  DirectionScope,
  EngineStatus,
  HFModelDetail,
  HFModelSummary,
  InstalledModel,
  Persona,
  PersonaVoice,
  RoleplayFact,
  SceneDirection,
  SceneDirectorSettings,
  ScenePersonaOverride,
  PrivateVaultBackup,
  PrivateVaultStatus,
  RendererSettings,
  RendererSettingsPatch,
  Result,
  StorageIssue,
  UpdateStatus,
  UserCharacter
} from '@shared/types'
import type { AppInfo } from '@shared/ipc'
import type { ExportFormat } from '@shared/export'
import type { PortableBundlePreview } from '@shared/portable'
import type { InstalledVoice, TtsSettings, TtsStatus, TtsVoiceDownload } from '@shared/tts'
import { getAccentTheme, hexToRgbChannels } from '@shared/themes'
import { contextUsageIsCurrent } from '@shared/context'
import { estimateModelFit } from '@shared/hardwareFit'
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
  consumeOneShotDirections,
  detachPersonaIdentity,
  migrateConversationIdentity,
  normalizePersona,
  refreshPersonaSnapshot,
  snapshotPersona,
  upsertRoleplayFact
} from '@shared/roleplay'
import {
  isScene,
  sceneCast,
  nextSpeakerId,
  stripSpeakerPrefix,
  truncateAtForeignSpeaker,
  userDisplayName,
  MIN_SCENE_CAST
} from '@shared/scene'
import {
  continueSceneRun,
  createSceneRun,
  pauseSceneRun,
  recordSceneAttempt,
  recoverSceneNarration,
  requestSceneRunPause,
  resumeSceneRun,
  sceneRunPreflight,
  sceneRunStopLabel,
  setSceneNarration,
  stopSceneRun,
  type SceneRunState,
  type SceneRunStopReason
} from '@shared/sceneRun'
import { ttsPlayer } from './lib/ttsPlayer'
import {
  deterministicDirectorDecision
} from '@shared/sceneDirector'
import { resolveSpeechVoice, type ResolvedSpeechVoice } from '@shared/voice'

/** Paint the selected accent theme onto documentElement as CSS variables. */
function applyAccentTheme(key: string | null | undefined): void {
  const t = getAccentTheme(key)
  const root = document.documentElement.style
  root.setProperty('--sibyl-accent', hexToRgbChannels(t.accent))
  root.setProperty('--sibyl-accent-2', hexToRgbChannels(t.accent2))
  root.setProperty('--sibyl-glow', hexToRgbChannels(t.glow))
}

export type View = 'studio' | 'characters' | 'models' | 'settings'
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
  /** Encrypted private-data vault lifecycle; private app data loads only when unlocked. */
  vault: PrivateVaultStatus | null
  vaultBackups: PrivateVaultBackup[]
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
  /** In-memory, bounded autoplay policy and execution state for one scene. */
  scenePlay: SceneRunState | null
  /** Conversation snapshots whose last durable save failed. */
  unsavedConversationIds: string[]
  storageIssues: StorageIssue[]
}

const initialState: AppState = {
  ready: false,
  vault: null,
  vaultBackups: [],
  view: 'studio',
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

// Scene autoplay: a single self-rescheduling timer drives the bounded run.
let sceneTimer: ReturnType<typeof setTimeout> | null = null
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

function applyAccessibilitySettings(
  settings: RendererSettings['accessibility'] | null | undefined
): void {
  const root = document.documentElement
  root.classList.toggle('reduce-motion', Boolean(settings?.reducedMotion))
  root.classList.toggle('high-contrast', Boolean(settings?.highContrast))
  root.style.setProperty('zoom', String(settings?.textScale ?? 1))
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
let accessibilitySettingsQueue: Promise<void> = Promise.resolve()
let ttsSettingsQueue: Promise<void> = Promise.resolve()

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
    tts: { ...current.tts, ...(patch.tts ?? {}) },
    accessibility: {
      ...current.accessibility,
      ...(patch.accessibility ?? {})
    }
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
const announcedMissingVoices = new Set<string>()

function availableVoiceIds(): Set<string> {
  return new Set(
    state.installedVoices
      .filter((voice) => !voice.availability || voice.availability === 'available')
      .map((voice) => voice.id)
  )
}

function speechVoiceForState(
  source: AppState,
  messageId: string
): ResolvedSpeechVoice | null {
  const conversation = source.conversations.find((item) =>
    item.messages.some((message) => message.id === messageId)
  )
  const message = conversation?.messages.find((item) => item.id === messageId)
  const global = source.settings?.tts
  if (!conversation || !message || !global) return null
  const usable = new Set(
    source.installedVoices
      .filter((voice) => !voice.availability || voice.availability === 'available')
      .map((voice) => voice.id)
  )
  return resolveSpeechVoice({
    conversation,
    speakerId: message.speakerId,
    personas: source.settings?.personas,
    global,
    availableVoiceIds: usable
  })
}

function speechVoiceForMessage(messageId: string): ResolvedSpeechVoice | null {
  return speechVoiceForState(state, messageId)
}

function announceVoiceFallback(voice: ResolvedSpeechVoice): void {
  const missing = voice.missingPreferredVoiceId
  if (!missing || announcedMissingVoices.has(missing) || !voice.voiceId) return
  announcedMissingVoices.add(missing)
  toast(`Assigned voice “${missing}” is unavailable; using the ${voice.source} fallback.`, 'info')
}

function ttsReadiness(
  messageId?: string
):
  | { ok: true; voiceId: string; rate: number; assignment?: ResolvedSpeechVoice }
  | { ok: false; reason: string } {
  const s = state.settings?.tts
  if (!s?.enabled) return { ok: false, reason: 'Enable speech in Settings → Voice & speech.' }
  if (!state.tts?.available) {
    return { ok: false, reason: state.tts?.error ?? 'Speech is unavailable in this build.' }
  }
  const assignment = messageId ? speechVoiceForMessage(messageId) : null
  if (assignment?.voiceId) {
    return {
      ok: true,
      voiceId: assignment.voiceId,
      rate: assignment.rate,
      assignment
    }
  }
  const usable = availableVoiceIds()
  if (s.voiceId && usable.has(s.voiceId)) {
    return { ok: true, voiceId: s.voiceId, rate: s.rate }
  }
  if (!messageId && usable.size > 0) {
    return { ok: true, voiceId: [...usable][0], rate: s.rate }
  }
  return { ok: false, reason: 'Choose a voice in Settings → Voice & speech.' }
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

function sceneMaxTokens(conv: Conversation): number {
  const settings = state.settings
  const globalMax = settings?.generation.maxTokens ?? 2_048
  const sceneOverride = conv.overrides?.generation?.maxTokens
  if (sceneOverride) return sceneOverride
  const castMax = sceneCast(conv, settings?.personas).reduce(
    (largest, persona) => Math.max(largest, persona.generation?.maxTokens ?? globalMax),
    globalMax
  )
  return castMax
}

function updateSceneRun(
  convId: string,
  transform: (run: SceneRunState) => SceneRunState
): SceneRunState | null {
  const current = state.scenePlay
  if (!current || current.convId !== convId) return null
  const next = transform(current)
  setState({ scenePlay: next })
  return next
}

function abandonSceneRun(): void {
  const run = state.scenePlay
  if (!run) return
  clearSceneTimer()
  setState({ scenePlay: stopSceneRun(run, 'manual-stop') })
  void window.sibyl.chat.abortDirector(run.convId)
  if (run.narration === 'pending' || run.narration === 'playing') {
    ttsPlayer.stop()
    void window.sibyl.tts.stop()
  }
  setState({ scenePlay: null })
}

function sceneRunStoppedOperation(conversationId: string, operationId: string): boolean {
  const run = state.scenePlay
  return Boolean(
    run?.convId === conversationId &&
      run.activeOperationId === operationId &&
      run.status === 'stopped'
  )
}

/** Whether the speak control should be shown on assistant messages. */
export function canSpeak(s: AppState, messageId: string): boolean {
  const t = s.settings?.tts
  return Boolean(
    t?.enabled &&
      s.tts?.available &&
      speechVoiceForState(s, messageId)?.voiceId
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

function survivingRoleplay(
  conv: Conversation,
  messages: ChatMessage[]
): Pick<Conversation, 'roleplayState' | 'directions'> {
  const messageIds = new Set(messages.map((message) => message.id))
  const retainedDirectionIds = new Set(
    messages.map((message) => message.directionId).filter((id): id is string => Boolean(id))
  )
  const originallyLinkedDirections = new Set(
    conv.messages.map((message) => message.directionId).filter((id): id is string => Boolean(id))
  )
  const facts = conv.roleplayState?.facts
    .map((fact) => {
      const provenanceMessageIds = fact.provenanceMessageIds.filter((id) => messageIds.has(id))
      if (!provenanceMessageIds.length && !fact.userAuthored && !fact.pinned) return null
      return {
        ...fact,
        provenanceMessageIds,
        userAuthored: fact.userAuthored || (fact.pinned && !provenanceMessageIds.length)
      }
    })
    .filter((fact): fact is RoleplayFact => fact !== null)
  const compactionSurvives = Boolean(survivingCompaction(conv, messages))
  return {
    roleplayState:
      conv.roleplayState && facts
        ? {
            ...conv.roleplayState,
            recap: compactionSurvives ? conv.roleplayState.recap : undefined,
            maintainedAt: compactionSurvives ? conv.roleplayState.maintainedAt : undefined,
            facts
          }
        : conv.roleplayState,
    directions: conv.directions
      ?.filter(
        (direction) =>
          !originallyLinkedDirections.has(direction.id) || retainedDirectionIds.has(direction.id)
      )
      .map((direction) =>
        direction.consumedByMessageId && !messageIds.has(direction.consumedByMessageId)
          ? { ...direction, consumedAt: undefined, consumedByMessageId: undefined }
          : direction
      )
  }
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
    ...survivingRoleplay(conv, messages),
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
    if (view !== 'studio') abandonSceneRun()
    // Leaving (or re-entering) a view dismisses the new-conversation picker overlay.
    setState({ view, personaPickerOpen: false })
  },

  /** Show the new-conversation character picker over the studio. */
  openPersonaPicker(): void {
    abandonSceneRun()
    setState({ personaPickerOpen: true, view: 'studio' })
  },
  closePersonaPicker(): void {
    setState({ personaPickerOpen: false })
  },

  async init(): Promise<void> {
    // Guard against React StrictMode invoking the mount effect twice in dev,
    // which would otherwise register duplicate IPC listeners (double tokens).
    if (initialized) return
    initialized = true

    const vaultRes = await window.sibyl.vault.status()
    if (!vaultRes.ok || !vaultRes.data) {
      setState({
        ready: true,
        vault: {
          state: 'error',
          hasDeviceSlot: false,
          hasPasskeySlot: false,
          recoveryAvailable: false,
          deviceStorageAvailable: false,
          passkeyAvailable: false,
          migrationRequired: false,
          error: vaultRes.error ?? 'The encrypted private vault is unavailable.'
        }
      })
      initialized = false
      return
    }
    setState({ vault: vaultRes.data })
    if (vaultRes.data.state !== 'unlocked') {
      setState({ ready: true })
      initialized = false
      return
    }

    const [settingsRes, infoRes, modelsRes, convRes, statusRes, dlRes, updateRes, ttsRes, voicesRes, voiceDlRes, issuesRes, backupsRes] =
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
        window.sibyl.app.storageIssues(),
        window.sibyl.vault.listBackups()
      ])

    const downloads: Record<string, DownloadProgress> = {}
    if (dlRes.ok && dlRes.data) for (const d of dlRes.data) downloads[d.id] = d
    const voiceDownloads: Record<string, TtsVoiceDownload> = {}
    if (voiceDlRes.ok && voiceDlRes.data) for (const d of voiceDlRes.data) voiceDownloads[d.voiceId] = d
    const finalIssuesRes = await window.sibyl.app.storageIssues()

    setState({
      ready: true,
      vault: vaultRes.data,
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
      storageIssues: finalIssuesRes.data ?? issuesRes.data ?? [],
      vaultBackups: backupsRes.data ?? []
    })
    confirmedSettings = settingsRes.data ?? null

    // Wire the audio player: it is the source of truth for what's audibly speaking.
    ttsPlayer.init({
      onSpeakingChange: (id) => {
        let completedSceneId: string | null = null
        setState((s) => {
          let turnOperation = s.turnOperation
          let scenePlay = s.scenePlay
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
            if (
              scenePlay &&
              scenePlay.convId === turnOperation.conversationId &&
              scenePlay.narrationMessageId === id
            ) {
              scenePlay = setSceneNarration(scenePlay, 'playing', id)
            }
          } else if (
            !id &&
            operationId &&
            (turnOperation.phase === 'narration-pending' ||
              turnOperation.phase === 'narrating')
          ) {
            turnOperation = transitionRendererTurn(turnOperation, operationId, {
              phase: 'complete'
            })
            if (
              scenePlay &&
              scenePlay.convId === turnOperation.conversationId &&
              scenePlay.narration !== 'error'
            ) {
              scenePlay = setSceneNarration(scenePlay, 'none')
              if (scenePlay.pauseAfterCurrent) {
                scenePlay = pauseSceneRun(scenePlay)
              } else if (scenePlay.status === 'running') {
                completedSceneId = scenePlay.convId
              }
            }
          }
          return { speakingMessageId: id, turnOperation, scenePlay }
        })
        if (completedSceneId) actions.scheduleNextBeat()
      }
    })
    ttsPlayer.setVolume(state.settings?.tts.volume ?? 1)

    applyAccentTheme(state.settings?.accent)
    applyAccessibilitySettings(state.settings?.accessibility)

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
        const turn = state.turnOperation
        if (
          turn.messageId === e.messageId &&
          turn.operationId &&
          (turn.phase === 'narration-pending' || turn.phase === 'narrating')
        ) {
          failTurn(turn.operationId, e.error)
          if (
            turn.kind === 'scene' &&
            turn.conversationId &&
            state.scenePlay?.convId === turn.conversationId
          ) {
            updateSceneRun(turn.conversationId, (run) =>
              setSceneNarration(run, 'error', e.messageId, e.error)
            )
          }
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
        const completedTurn = rendererTurnMatches(
          state.turnOperation,
          e.conversationId,
          e.messageId
        )
          ? state.turnOperation
          : null
        let finishedText = ''
        let finishedConversation: Conversation | null = null
        let finishedSpeakerId: string | undefined
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
            finishedSpeakerId = m.speakerId
            return { ...m, content, stats: e.stats, error: undefined }
          })
          const completedMessage = messages.find((message) => message.id === e.messageId)
          const updated = {
            ...c,
            updatedAt: now(),
            messages,
            directions: c.directions,
            roleplayState:
              completedMessage?.speakerId && c.roleplayState
                ? {
                    ...c.roleplayState,
                    beatsSinceMaintenance: c.roleplayState.beatsSinceMaintenance + 1
                  }
                : c.roleplayState
          }
          finishedConversation = updated
          return updated
        })
        setState({ streamStats: null })
        let sceneRun: SceneRunState | null = null
        if (
          completedTurn?.kind === 'scene' &&
          state.scenePlay?.convId === e.conversationId &&
          state.scenePlay.activeOperationId === completedTurn.operationId &&
          (state.scenePlay.status === 'running' || state.scenePlay.pauseAfterCurrent)
        ) {
          sceneRun = updateSceneRun(e.conversationId, (run) =>
            recordSceneAttempt(run, {
              text: finishedText,
              completionTokens: e.stats.completionTokens,
              now: Date.now()
            }).run
          )
        }
        void (async () => {
          const saved = finishedConversation ? await persist(finishedConversation) : false
          const stillOwnsTurn = Boolean(
            completedTurn?.operationId &&
              rendererTurnMatches(state.turnOperation, e.conversationId, e.messageId)
          )
          if (sceneRun && !saved) {
            if (state.scenePlay?.convId === e.conversationId) {
              actions.stopScenePlay('resource-unavailable')
            }
            if (completedTurn?.operationId && stillOwnsTurn) {
              failTurn(completedTurn.operationId, 'The completed scene beat could not be saved.')
            }
            return
          }
          const completedConversation = finishedConversation as Conversation | null
          if (saved && completedConversation && finishedSpeakerId) {
            const consumed = consumeOneShotDirections(
              completedConversation.directions,
              finishedSpeakerId,
              e.messageId,
              now()
            )
            if (JSON.stringify(consumed) !== JSON.stringify(completedConversation.directions)) {
              const withConsumed = {
                ...completedConversation,
                directions: consumed,
                updatedAt: now()
              }
              if (!(await persist(withConsumed))) {
                if (state.scenePlay?.convId === e.conversationId) {
                  actions.stopScenePlay('resource-unavailable')
                }
                if (completedTurn?.operationId && stillOwnsTurn) {
                  failTurn(
                    completedTurn.operationId,
                    'The beat was saved, but its one-shot direction could not be consumed.'
                  )
                }
                return
              }
              updateConversation(e.conversationId, (current) =>
                current.messages.some((message) => message.id === e.messageId)
                  ? withConsumed
                  : current
              )
              finishedConversation = withConsumed
            }
          }
          if (!completedTurn?.operationId || !stillOwnsTurn) {
            return
          }
          transitionTurn(completedTurn.operationId, { phase: 'complete' })
          if (
            sceneRun &&
            (state.scenePlay?.convId !== e.conversationId ||
              state.scenePlay.activeOperationId !== completedTurn.operationId)
          ) {
            return
          }
          if (
            sceneRun &&
            state.scenePlay?.convId === e.conversationId &&
            state.scenePlay.activeOperationId === completedTurn.operationId &&
            state.scenePlay.status === 'stopped' &&
            (state.scenePlay.stopReason === 'manual-stop' ||
              state.scenePlay.stopReason === 'resource-unavailable')
          ) {
            return
          }
          // Auto-speak only the operation that still owns renderer state.
          const narrationStarted = actions.maybeAutoSpeak(e.messageId, finishedText)
          // Narrated beats resume from the audio player's terminal callback.
          const currentRun =
            sceneRun &&
            state.scenePlay?.convId === e.conversationId &&
            state.scenePlay.activeOperationId === completedTurn.operationId
              ? state.scenePlay
              : null
          if (currentRun?.status === 'running' && !narrationStarted) {
            actions.scheduleNextBeat()
          } else if (currentRun && currentRun.status !== 'running' && !narrationStarted) {
            const label = sceneRunStopLabel(currentRun.stopReason)
            if (label) toast(label, 'info')
          }
        })()
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
        if (
          state.scenePlay?.convId === e.conversationId &&
          state.scenePlay.activeOperationId === state.turnOperation.operationId
        ) {
          actions.stopScenePlay('manual-stop')
        }
        toast('Generation stopped — the partial response was kept.', 'info')
      } else if (e.type === 'error') {
        const failedOperation = rendererTurnMatches(
          state.turnOperation,
          e.conversationId,
          e.messageId
        )
          ? state.turnOperation
          : null
        let failedConversation: Conversation | null = null
        updateConversation(e.conversationId, (c) => {
          const updated = {
            ...c,
            messages: c.messages.map((m) =>
              m.id === e.messageId ? { ...m, error: e.error } : m
            )
          }
          failedConversation = updated
          return updated
        })
        setState({ streamStats: null })
        failTurnForMessage(e.conversationId, e.messageId, e.error)
        // A bounded scene tolerates one unhealthy attempt, but two consecutive
        // empty/failed/near-duplicate attempts stop the run.
        if (
          failedOperation?.kind === 'scene' &&
          state.scenePlay?.convId === e.conversationId &&
          state.scenePlay.activeOperationId === failedOperation.operationId &&
          state.scenePlay.status === 'running'
        ) {
          const run = updateSceneRun(e.conversationId, (current) =>
            recordSceneAttempt(current, { failed: true, now: Date.now() }).run
          )
          void (async () => {
            const saved = failedConversation ? await persist(failedConversation) : false
            if (
              state.scenePlay?.convId !== e.conversationId ||
              state.scenePlay.activeOperationId !== failedOperation.operationId
            ) {
              return
            }
            if (!saved) {
              actions.stopScenePlay('resource-unavailable')
              return
            }
            if (run?.status === 'running') actions.scheduleNextBeat()
            else if (run) toast(sceneRunStopLabel(run.stopReason), 'error')
          })()
        } else if (failedConversation) {
          void persist(failedConversation)
        }
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
    const info = res.data.compaction
    const extractedFacts = res.data.roleplayFacts ?? []
    const previous = state.conversations.find((c) => c.id === id)
    let updated: Conversation | null = null
    updateConversation(id, (c) => {
      updated = {
        ...c,
        compaction: info,
        roleplayState: c.roleplayState
          ? {
              ...c.roleplayState,
              recap: info.summary,
              facts: extractedFacts.reduce(
                (facts, fact) => upsertRoleplayFact(facts, fact),
                c.roleplayState.facts
              ),
              beatsSinceMaintenance: 0,
              maintainedAt: info.compactedAt
            }
          : c.roleplayState,
        updatedAt: now()
      }
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
    abandonSceneRun()
    const persona = findPersona(state.settings?.personas, personaId)
    const messages: ChatMessage[] = []
    if (persona?.greeting?.trim()) {
      messages.push({ id: uid(), role: 'assistant', content: persona.greeting.trim(), createdAt: now() })
    }
    const conv: Conversation = {
      id: uid(),
      title: 'New conversation',
      modelId: state.engine.modelId,
      messages,
      personaId: persona?.id,
      createdAt: now(),
      updatedAt: now()
    }
    const migrated = migrateConversationIdentity(
      conv,
      state.settings?.personas ?? [],
      conv.createdAt
    )
    setState((s) => ({
      conversations: [migrated, ...s.conversations],
      activeConversationId: migrated.id,
      contextUsage: null,
      view: 'studio',
      personaPickerOpen: false
    }))
    persist(migrated)
    void actions.refreshContextUsage()
    return migrated.id
  },

  // --- scenes (self-roleplay) ---------------------------------------------
  /**
   * Start a scene: a conversation whose cast of ≥2 personas converse with each
   * other. The human can watch (autoplay), join in as their own character, or
   * drop director notes to steer it.
   */
  newScene(castIds: string[], opts?: { premise?: string; userCharacter?: UserCharacter }): string {
    abandonSceneRun()
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
    const migrated = migrateConversationIdentity(
      conv,
      state.settings?.personas ?? [],
      conv.createdAt
    )
    setState((s) => ({
      conversations: [migrated, ...s.conversations],
      activeConversationId: migrated.id,
      contextUsage: null,
      view: 'studio',
      personaPickerOpen: false
    }))
    persist(migrated)
    void actions.refreshContextUsage()
    return migrated.id
  },

  /** Generate one beat. `speakerId` overrides the round-robin pick. */
  async advanceScene(speakerId?: string, continuedOperationId?: string): Promise<boolean> {
    if (!state.engine.modelId) {
      toast('Load a model before playing a scene.', 'error')
      if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
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
      state.scenePlay?.convId === conversationId &&
      state.scenePlay.status === 'running'
    ) {
      updateSceneRun(conversationId, (run) => ({ ...run, activeOperationId: operationId }))
    }
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
      if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
      return false
    }
    const initialSpeakerId = speakerId ?? nextSpeakerId(conv, personas)
    if (!initialSpeakerId) {
      failTurn(operationId, 'No available scene speaker was found.')
      if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
      return false
    }
    let sid: string = initialSpeakerId

    try {
      // Auto-compaction: summarize older beats before the window overflows so the
      // scene can run long without truncating the next reply.
      const ctx = await actions.projectedContextUsage({
        conversationId,
        nextSpeakerId: !speakerId && conv.director?.enabled ? undefined : sid
      })
      // Projection is asynchronous. If the user switched threads while it was
      // running, do not commit a beat to the conversation they left.
      if (state.activeConversationId !== conversationId) {
        const error = 'The conversation changed before the response could start.'
        failTurn(operationId, error)
        toast(error, 'error')
        return false
      }
      if (sceneRunStoppedOperation(conversationId, operationId)) {
        transitionTurn(operationId, { phase: 'complete' })
        return false
      }
      const cset = state.settings?.context
      const maintenanceDue = Boolean(
        conv.roleplayState &&
          conv.roleplayState.beatsSinceMaintenance >= 8 &&
          conv.messages.length > (cset?.keepRecentMessages ?? 6) + 1
      )
      if (
        cset?.autoCompact &&
        (maintenanceDue ||
          (ctx &&
            state.activeConversationId === conversationId &&
            ctx.conversationId === conversationId &&
            ctx.contextSize > 0 &&
            (ctx.willOverflow || ctx.fraction >= cset.compactThreshold)))
      ) {
        const did = await actions.compact(conversationId, {
          silent: true,
          operationId
        })
        if (state.turnOperation.operationId === operationId && state.turnOperation.phase === 'failed') {
          if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
          return false
        }
        if (did) {
          conv = state.conversations.find((c) => c.id === conversationId) ?? conv
          if (
            state.scenePlay?.convId === conversationId &&
            state.scenePlay.status === 'running' &&
            maintenanceDue
          ) {
            // Continuity maintenance changes the scene's durable memory and is
            // still worth reviewing. Routine context reclamation is mechanical:
            // keep the bounded run alive and generate this beat immediately.
            actions.stopScenePlay('memory-maintenance')
            transitionTurn(operationId, { phase: 'complete' })
            toast(
              'Continuity memory was refreshed. Review it, then continue the scene.',
              'info'
            )
            return false
          }
        }
      }
      if (sceneRunStoppedOperation(conversationId, operationId)) {
        transitionTurn(operationId, { phase: 'complete' })
        return false
      }
      if (state.activeConversationId !== conversationId) {
        const error = 'The conversation changed before the response could start.'
        failTurn(operationId, error)
        toast(error, 'error')
        return false
      }

      if (!speakerId && conv.director?.enabled) {
        const directorConfig = conv.director
        const cast = sceneCast(conv, personas)
        let decision = deterministicDirectorDecision({
          conversation: conv,
          cast,
          fallbackSpeakerId: sid
        })
        if (!decision && directorConfig.useModel) {
          const result = await safeIpc(
            () => window.sibyl.chat.direct(conversationId),
            'The local scene director became unavailable.'
          )
          if (result.ok && result.data) decision = result.data
          else {
            decision = {
              action: 'continue',
              speakerId: sid,
              intent: 'Use deterministic round-robin.',
              usedModel: false,
              fallbackReason: 'unavailable',
              promptTokens: 0,
              completionTokens: 0,
              durationMs: 0
            }
          }
        }
        if (decision) {
          if (
            state.activeConversationId !== conversationId ||
            sceneRunStoppedOperation(conversationId, operationId)
          ) {
            transitionTurn(operationId, { phase: 'complete' })
            return false
          }
          if (state.scenePlay?.convId === conversationId) {
            const accounted = updateSceneRun(conversationId, (run) =>
              sceneRunPreflight(
                {
                  ...run,
                  directorTokensUsed:
                    run.directorTokensUsed +
                    decision!.promptTokens +
                    decision!.completionTokens,
                  directorDurationMs: run.directorDurationMs + decision!.durationMs,
                  lastDirectorIntent: directorConfig.inspectIntent
                    ? decision!.intent
                    : undefined,
                  lastDirectorFallback: decision!.fallbackReason
                },
                Date.now()
              )
            )
            if (accounted?.status === 'stopped') {
              transitionTurn(operationId, { phase: 'complete' })
              toast(sceneRunStopLabel(accounted.stopReason), 'info')
              return false
            }
          }
          if (decision.action !== 'continue') {
            const reason = decision.action === 'end' ? 'natural-end' : 'natural-pause'
            if (state.scenePlay?.convId === conversationId) actions.stopScenePlay(reason)
            transitionTurn(operationId, { phase: 'complete' })
            toast(
              decision.action === 'end'
                ? 'The director ended the scene.'
                : 'The director paused for you.',
              'info'
            )
            return false
          }
          if (decision.speakerId && cast.some((persona) => persona.id === decision!.speakerId)) {
            sid = decision.speakerId
          }
        }
        if (
          state.activeConversationId !== conversationId ||
          sceneRunStoppedOperation(conversationId, operationId)
        ) {
          transitionTurn(operationId, { phase: 'complete' })
          return false
        }
      }

      const persona = sceneCast(conv, personas).find((item) => item.id === sid)
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
        if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
        return false
      }
      if (sceneRunStoppedOperation(conversationId, operationId)) {
        rollbackOptimisticConversation(conv)
        await persist(conv)
        transitionTurn(operationId, { phase: 'complete' })
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
        if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
        return false
      }
      if (sceneRunStoppedOperation(conversationId, operationId)) {
        rollbackOptimisticConversation(conv)
        await persist(conv)
        transitionTurn(operationId, { phase: 'complete' })
        return false
      }
      setState({ streamStats: { messageId: beat.id, startedAt: Date.now(), tokens: 0 } })
      transitionTurn(operationId, { phase: 'generating' })
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
        if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
        return false
      }
      return true
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to advance the scene'
      failTurn(operationId, error)
      toast(error, 'error')
      if (state.scenePlay) actions.stopScenePlay('resource-unavailable')
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
  async sceneDirect(
    text: string,
    options?: {
      scope?: DirectionScope
      target?: SceneDirection['target']
    }
  ): Promise<boolean> {
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
    const direction: SceneDirection = {
      id: uid(),
      content,
      target: options?.target ?? { kind: 'cast' },
      scope: options?.scope ?? 'next-beat',
      enabled: true,
      createdAt: note.createdAt
    }
    note.directionId = direction.id
    let saved: Conversation | null = null
    updateConversation(conv.id, (c) => {
      saved = {
        ...c,
        messages: [...c.messages, note],
        directions: [...(c.directions ?? []), direction],
        updatedAt: now()
      }
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
    const configuredNarration = Boolean(
      state.settings?.tts.enabled && state.settings.tts.autoSpeak
    )
    const readiness = ttsReadiness()
    const muted = configuredNarration && !readiness.ok
    const existing = state.scenePlay?.convId === conv.id ? state.scenePlay : null
    const startingNewBatch = !existing || existing.status === 'stopped'
    if (muted && startingNewBatch) {
      toast(`${readiness.reason} This run will continue without speech.`, 'info')
    } else if (!muted) {
      maybePrewarmAudio() // Play is a user gesture — warm audio for narrated beats
    }
    const run = existing
      ? existing.status === 'paused'
        ? resumeSceneRun(existing, Date.now())
        : existing.status === 'stopped'
          ? { ...continueSceneRun(existing, Date.now(), sceneMaxTokens(conv)), muted }
          : existing
      : createSceneRun({
          convId: conv.id,
          now: Date.now(),
          maxTokensPerBeat: sceneMaxTokens(conv),
          muted
        })
    setState({ scenePlay: run })
    actions.tickScenePlay()
  },

  /** Pause autoplay; any in-flight beat is allowed to finish. */
  pauseScenePlay(): void {
    clearSceneTimer()
    const run = state.scenePlay
    if (!run) return
    const busy =
      rendererTurnIsBusy(state.turnOperation) || run.narration === 'pending' || run.narration === 'playing'
    setState({ scenePlay: requestSceneRunPause(run, busy) })
  },

  /** End the run and optionally abort its scoped in-flight generation. */
  stopScenePlay(reason: SceneRunStopReason = 'manual-stop', abortCurrent = false): void {
    clearSceneTimer()
    const run = state.scenePlay
    if (run) setState({ scenePlay: stopSceneRun(run, reason) })
    if (abortCurrent) {
      if (
        run &&
        state.turnOperation.kind === 'scene' &&
        state.turnOperation.conversationId === run.convId &&
        state.turnOperation.phase === 'preparing'
      ) {
        void window.sibyl.chat.abortDirector(run.convId)
      }
      if (
        state.turnOperation.kind === 'scene' &&
        state.turnOperation.conversationId === run?.convId &&
        state.turnOperation.phase === 'generating'
      ) {
        actions.abortGeneration()
      } else if (run?.narration === 'pending' || run?.narration === 'playing') {
        actions.stopSpeaking()
      }
    }
  },

  toggleScenePlay(): void {
    if (state.scenePlay?.status === 'running') actions.pauseScenePlay()
    else actions.startScenePlay()
  },

  /** Schedule the next autoplay beat after a readable pause. */
  scheduleNextBeat(): void {
    clearSceneTimer()
    const run = state.scenePlay
    if (!run || run.status !== 'running' || run.pauseAfterCurrent) return
    sceneTimer = setTimeout(() => actions.tickScenePlay(), run.delayMs)
  },

  /** Autoplay tick: advance when free, otherwise poll until it is. */
  tickScenePlay(): void {
    let play = state.scenePlay
    if (!play || play.status !== 'running' || play.pauseAfterCurrent) return
    const checked = sceneRunPreflight(play, Date.now())
    if (checked !== play) {
      setState({ scenePlay: checked })
      const label = sceneRunStopLabel(checked.stopReason)
      if (label) toast(label, 'info')
      return
    }
    play = checked
    const conv = state.conversations.find((c) => c.id === play.convId)
    if (!conv || !isScene(conv)) {
      actions.stopScenePlay('resource-unavailable')
      return
    }
    // A beat already in flight is event-driven. Polling is only a defensive
    // fallback for an unrelated operation that temporarily owns the renderer.
    if (rendererTurnIsBusy(state.turnOperation) || play.narration !== 'none') {
      clearSceneTimer()
      sceneTimer = setTimeout(() => actions.tickScenePlay(), 300)
      return
    }
    void actions.advanceScene()
  },

  /** Retry the narration that paused a scene without regenerating its beat. */
  retrySceneNarration(): void {
    const run = state.scenePlay
    const messageId = run?.narrationMessageId
    if (!run || run.status !== 'narration-error' || !messageId) return
    const conv = state.conversations.find((c) => c.id === run.convId)
    const message = conv?.messages.find((m) => m.id === messageId)
    if (!message?.content.trim()) {
      actions.continueSceneMuted()
      return
    }
    const readiness = ttsReadiness()
    if (!readiness.ok) {
      toast(readiness.reason, 'error')
      return
    }
    const recovered = recoverSceneNarration(run, 'retry')
    setState({ scenePlay: recovered })
    const operationId = state.turnOperation.operationId
    if (operationId && state.turnOperation.messageId === messageId) {
      transitionTurn(operationId, { phase: 'narration-pending', error: undefined })
    }
    ttsPlayer.ensureContext()
    void safeIpc(
      () => window.sibyl.tts.speak({ messageId, text: message.content }),
      'Speech became unavailable.'
    ).then((res) => {
      if (!res.ok) {
        const error = res.error ?? 'Failed to start speech'
        const current = state.scenePlay
        if (
          current?.convId === run.convId &&
          current.narration === 'pending' &&
          current.narrationMessageId === messageId &&
          state.turnOperation.operationId === operationId
        ) {
          updateSceneRun(run.convId, (value) =>
            setSceneNarration(value, 'error', messageId, error)
          )
          if (operationId) failTurn(operationId, error)
          toast(error, 'error')
        }
      }
    })
  },

  /** Dismiss a narration failure and finish this bounded run without more speech. */
  continueSceneMuted(): void {
    const run = state.scenePlay
    if (!run || run.status !== 'narration-error') return
    const recovered = recoverSceneNarration(run, 'continue-muted')
    setState({ scenePlay: recovered })
    const operationId = state.turnOperation.operationId
    if (operationId && state.turnOperation.kind === 'scene') {
      transitionTurn(operationId, { phase: 'complete', error: undefined })
    }
    if (recovered.status === 'running') actions.scheduleNextBeat()
    else {
      const label = sceneRunStopLabel(recovered.stopReason)
      if (label) toast(label, 'info')
    }
  },

  /** Add a persona to the active scene's cast (turning a thread into a scene at ≥2). */
  addCastMember(personaId: string): void {
    const conv = activeConversation()
    if (!conv) return
    if (conv.cast?.includes(personaId)) return
    const cast = [...(conv.cast ?? []), personaId]
    const persona = findPersona(state.settings?.personas, personaId)
    const updated = {
      ...conv,
      cast,
      castSnapshots: persona
        ? [...(conv.castSnapshots ?? []), snapshotPersona(persona, now())]
        : conv.castSnapshots,
      updatedAt: now()
    }
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
    const updated = {
      ...conv,
      cast,
      castSnapshots: conv.castSnapshots?.filter(
        (snapshot) => snapshot.sourcePersonaId !== personaId
      ),
      personaOverrides: conv.personaOverrides?.filter(
        (override) => override.personaId !== personaId
      ),
      updatedAt: now()
    }
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
    const edited = conv.messages.find((message) => message.id === messageId)
    const updated = {
      ...conv,
      messages: conv.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
      directions: edited?.directionId
        ? conv.directions?.map((direction) =>
            direction.id === edited.directionId ? { ...direction, content } : direction
          )
        : conv.directions,
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
    const previous = personas.find((item) => item.id === persona.id)
    const saved = normalizePersona({
      ...persona,
      version: exists ? (previous?.version ?? 1) + 1 : 1
    })
    const next = exists ? personas.map((p) => (p.id === persona.id ? saved : p)) : [...personas, saved]
    void actions.updateSettings({ personas: next })
  },

  /**
   * Remove a library persona without damaging old conversations. Frozen
   * snapshots remain usable; callers may deliberately replace future identity.
   */
  deletePersona(
    id: string,
    strategy: 'keep-snapshot' | 'replace' | 'detach' = 'keep-snapshot',
    replacementId?: string
  ): void {
    const replacement = findPersona(state.settings?.personas, replacementId)
    const affected = state.conversations.filter(
      (conversation) =>
        conversation.personaId === id || conversation.cast?.includes(id)
    )
    if (strategy === 'replace' && !replacement) {
      toast('Choose a replacement character first.', 'error')
      return
    }
    if (
      strategy === 'replace' &&
      replacement &&
      affected.some(
        (conversation) =>
          isScene(conversation) &&
          conversation.cast?.includes(replacement.id) &&
          (conversation.cast?.length ?? 0) <= MIN_SCENE_CAST
      )
    ) {
      toast('That replacement would leave an affected scene with fewer than two characters.', 'error')
      return
    }
    for (const conversation of affected) {
      let updated = conversation
      if (strategy === 'replace' && replacement) {
        // Remap every identity-bearing field (speaker attribution, scoped
        // knowledge, relationships, facts, and directions), then replace the
        // old frozen identity with the selected library persona.
        const remapped = detachPersonaIdentity(conversation, id, replacement.id)
        const cast = remapped.cast?.filter(
          (castId, index) => remapped.cast!.indexOf(castId) === index
        )
        const snapshotById = new Map(
          (remapped.castSnapshots ?? [])
            .filter((snapshot) => snapshot.sourcePersonaId !== replacement.id)
            .map((snapshot) => [snapshot.sourcePersonaId, snapshot])
        )
        if (conversation.cast?.includes(id)) {
          snapshotById.set(replacement.id, snapshotPersona(replacement, now()))
        }
        updated = {
          ...remapped,
          personaSnapshot:
            conversation.personaId === id
              ? snapshotPersona(replacement, now())
              : remapped.personaSnapshot,
          cast,
          castSnapshots: cast
            ?.map((castId) => snapshotById.get(castId))
            .filter((snapshot): snapshot is NonNullable<Conversation['castSnapshots']>[number] =>
              Boolean(snapshot)
            ),
          personaOverrides: remapped.personaOverrides?.filter(
            (_override, index) =>
              conversation.personaOverrides?.[index]?.personaId !== id
          ),
          updatedAt: now()
        }
      } else if (strategy === 'detach') {
        updated = {
          ...detachPersonaIdentity(conversation, id, `detached-${uid()}`),
          updatedAt: now()
        }
      }
      if (updated !== conversation) {
        updateConversation(conversation.id, () => updated)
        void persist(updated)
        void window.sibyl.chat.invalidateSession(conversation.id)
      }
    }
    const personas = (state.settings?.personas ?? []).filter((p) => p.id !== id)
    void actions.updateSettings({ personas })
  },

  /** Mark an entire beat public or private to selected characters. */
  async setMessageVisibility(
    messageId: string,
    visibility: NonNullable<ChatMessage['segments']>[number]['visibility']
  ): Promise<void> {
    const conversation = activeConversation()
    if (!conversation) return
    const message = conversation.messages.find((item) => item.id === messageId)
    if (!message) return
    const segments = message.segments?.length
      ? message.segments.map((segment) => ({ ...segment, visibility }))
      : [{
          id: uid(),
          kind: message.role === 'assistant' ? 'thought' as const : 'note' as const,
          content: message.content,
          visibility
        }]
    const autoFactIds = new Set(segments.map((segment) => segment.id))
    const retainedFacts =
      conversation.roleplayState?.facts.filter((fact) => !autoFactIds.has(fact.id)) ?? []
    const privateFacts: RoleplayFact[] = segments
      .filter((segment) => segment.visibility.kind === 'private' && segment.content.trim())
      .map((segment) => ({
        id: segment.id,
        category: 'other',
        text: segment.content.trim(),
        visibility: segment.visibility,
        provenanceMessageIds: [message.id],
        userAuthored: false,
        pinned: false,
        updatedAt: now()
      }))
    const updated = {
      ...conversation,
      messages: conversation.messages.map((item) =>
        item.id === messageId ? { ...item, segments } : item
      ),
      roleplayState: conversation.roleplayState
        ? {
            ...conversation.roleplayState,
            facts: [...retainedFacts, ...privateFacts]
          }
        : conversation.roleplayState,
      updatedAt: now()
    }
    updateConversation(conversation.id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(conversation.id)
    void actions.refreshContextUsage()
  },

  personaDeletionImpact(id: string): { conversations: number; scenes: number } {
    const affected = state.conversations.filter(
      (conversation) => conversation.personaId === id || conversation.cast?.includes(id)
    )
    return {
      conversations: affected.length,
      scenes: affected.filter(isScene).length
    }
  },

  /** Explicitly opt an old thread/scene into the current library revision. */
  async refreshConversationPersona(id: string, personaId: string): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    const persona = findPersona(state.settings?.personas, personaId)
    if (!conversation || !persona) return
    const updated = {
      ...refreshPersonaSnapshot(conversation, persona, now()),
      updatedAt: now()
    }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  async setKnowledgeMode(id: string, mode: Conversation['knowledgeMode']): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation || !mode) return
    const updated = { ...conversation, knowledgeMode: mode, updatedAt: now() }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  async setSceneDirector(id: string, director: SceneDirectorSettings): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation) return
    const updated = { ...conversation, director, updatedAt: now() }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) rollbackOptimisticConversation(conversation)
  },

  async setSceneVoice(id: string, sceneVoice: PersonaVoice | undefined): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation) return
    const normalized =
      sceneVoice && (sceneVoice.voiceId || sceneVoice.rate)
        ? sceneVoice
        : undefined
    const updated = { ...conversation, sceneVoice: normalized, updatedAt: now() }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) rollbackOptimisticConversation(conversation)
  },

  async setScenePersonaOverride(
    id: string,
    personaId: string,
    patch: Omit<ScenePersonaOverride, 'personaId'> | undefined
  ): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation?.cast?.includes(personaId)) return
    const rest = (conversation.personaOverrides ?? []).filter(
      (override) => override.personaId !== personaId
    )
    const { personaId: _ignored, ...values } = (patch ?? {}) as ScenePersonaOverride
    const hasValues = Object.values(values).some((value) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ''
    )
    const updated = {
      ...conversation,
      personaOverrides: hasValues ? [...rest, { personaId, ...values }] : rest,
      updatedAt: now()
    }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  promoteScenePersonaOverride(id: string, personaId: string): void {
    const conversation = state.conversations.find((item) => item.id === id)
    const override = conversation?.personaOverrides?.find(
      (item) => item.personaId === personaId
    )
    const persona = findPersona(state.settings?.personas, personaId)
    if (!override || !persona) return
    actions.savePersona({ ...persona, ...override, id: persona.id })
    toast('Scene-specific character changes were promoted to the character library.', 'success')
  },

  async saveDirection(id: string, direction: SceneDirection): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation) return
    const exists = conversation.directions?.some((item) => item.id === direction.id)
    const directions = exists
      ? conversation.directions!.map((item) => (item.id === direction.id ? direction : item))
      : [...(conversation.directions ?? []), direction]
    const updated = {
      ...conversation,
      directions,
      messages: conversation.messages.map((message) =>
        message.directionId === direction.id
          ? { ...message, content: direction.content }
          : message
      ),
      updatedAt: now()
    }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
  },

  async removeDirection(id: string, directionId: string): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation) return
    const updated = {
      ...conversation,
      directions: conversation.directions?.filter((item) => item.id !== directionId),
      messages: conversation.messages.filter((message) => message.directionId !== directionId),
      updatedAt: now()
    }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
  },

  async upsertRoleplayFact(id: string, fact: RoleplayFact): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation?.roleplayState) return
    const facts = upsertRoleplayFact(conversation.roleplayState.facts, fact)
    const updated = {
      ...conversation,
      roleplayState: { ...conversation.roleplayState, facts },
      updatedAt: now()
    }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
  },

  async removeRoleplayFact(id: string, factId: string): Promise<void> {
    const conversation = state.conversations.find((item) => item.id === id)
    if (!conversation?.roleplayState) return
    const updated = {
      ...conversation,
      roleplayState: {
        ...conversation.roleplayState,
        facts: conversation.roleplayState.facts.filter((fact) => fact.id !== factId)
      },
      updatedAt: now()
    }
    updateConversation(id, () => updated)
    if (!(await persist(updated))) return
    await window.sibyl.chat.invalidateSession(id)
  },

  /** Point a thread at a persona (or clear it). Rebuilds the engine session. */
  async setConversationPersona(id: string, personaId: string | null): Promise<void> {
    const conv = state.conversations.find((c) => c.id === id)
    if (!conv) return
    const persona = findPersona(state.settings?.personas, personaId)
    const updated = {
      ...conv,
      personaId: persona?.id,
      personaSnapshot: persona ? snapshotPersona(persona, now()) : undefined,
      updatedAt: now()
    }
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
    const leavingRun = state.scenePlay && state.scenePlay.convId !== id
    if (leavingRun) {
      clearSceneTimer()
      if (state.scenePlay?.narration === 'pending' || state.scenePlay?.narration === 'playing') {
        actions.stopSpeaking()
      }
    }
    setState({
      activeConversationId: id,
      contextUsage: null,
      view: 'studio',
      personaPickerOpen: false,
      scenePlay: leavingRun ? null : state.scenePlay
    })
    void actions.refreshContextUsage()
  },

  async deleteConversation(id: string): Promise<void> {
    const wasActive = state.activeConversationId === id
    if (state.scenePlay?.convId === id) {
      clearSceneTimer()
      if (state.scenePlay.narration === 'pending' || state.scenePlay.narration === 'playing') {
        actions.stopSpeaking()
      }
      setState({ scenePlay: null })
    }
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
    if (
      state.scenePlay &&
      state.turnOperation.kind === 'scene' &&
      state.turnOperation.conversationId === state.scenePlay.convId
    ) {
      actions.stopScenePlay('manual-stop')
    }
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
      ...survivingRoleplay(conv, messages),
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
        ...survivingRoleplay(conv, messages),
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
        ...survivingRoleplay(conv, messages),
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
    abandonSceneRun()
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
      ...survivingRoleplay(conv, messages),
      // Carry scene identity so a branched scene stays a scene.
      personaId: conv.personaId,
      userCharacter: conv.userCharacter,
      cast: conv.cast,
      scenePremise: conv.scenePremise,
      schemaVersion: conv.schemaVersion,
      personaSnapshot: conv.personaSnapshot,
      castSnapshots: conv.castSnapshots,
      personaOverrides: conv.personaOverrides,
      knowledgeMode: conv.knowledgeMode,
      director: conv.director,
      sceneVoice: conv.sceneVoice
    }
    setState((s) => ({
      conversations: [branch, ...s.conversations],
      activeConversationId: branch.id,
      contextUsage: null,
      view: 'studio'
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

  async exportPortableConversation(
    id: string,
    recoveryPassphrase: string
  ): Promise<boolean> {
    const res = await window.sibyl.portable.exportConversation(id, recoveryPassphrase)
    if (!res.ok) {
      toast(res.error ?? 'The encrypted conversation bundle could not be exported.', 'error')
      return false
    }
    if (res.data?.saved) toast('Encrypted conversation bundle exported', 'success')
    return Boolean(res.data?.saved)
  },

  async exportPortableLibrary(recoveryPassphrase: string): Promise<boolean> {
    const res = await window.sibyl.portable.exportLibrary(recoveryPassphrase)
    if (!res.ok) {
      toast(res.error ?? 'The encrypted library bundle could not be exported.', 'error')
      return false
    }
    if (res.data?.saved) toast('Encrypted library bundle exported', 'success')
    return Boolean(res.data?.saved)
  },

  async inspectPortableImport(
    recoveryPassphrase: string
  ): Promise<PortableBundlePreview | null> {
    const res = await window.sibyl.portable.inspectImport(recoveryPassphrase)
    if (!res.ok) {
      toast(res.error ?? 'The encrypted bundle could not be opened.', 'error')
      return null
    }
    return res.data ?? null
  },

  async discardPortableImport(token: string): Promise<void> {
    await window.sibyl.portable.discardImport(token)
  },

  async commitPortableImport(token: string): Promise<boolean> {
    const res = await window.sibyl.portable.commitImport(token)
    if (!res.ok) {
      toast(res.error ?? 'The encrypted bundle could not be imported.', 'error')
      return false
    }
    const [settingsRes, conversationsRes, engineRes, backupsRes] = await Promise.all([
      window.sibyl.settings.get(),
      window.sibyl.conversations.list(),
      window.sibyl.engine.status(),
      window.sibyl.vault.listBackups()
    ])
    const nextSettings = settingsRes.data ?? state.settings
    setState({
      settings: nextSettings,
      conversations: conversationsRes.data ?? state.conversations,
      engine: engineRes.data ?? state.engine,
      vaultBackups: backupsRes.data ?? state.vaultBackups,
      activeConversationId:
        res.data?.conversationIds[0] ?? state.activeConversationId
    })
    confirmedSettings = nextSettings
    if (nextSettings) {
      applyAccentTheme(nextSettings.accent)
      applyAccessibilitySettings(nextSettings.accessibility)
      ttsPlayer.setVolume(nextSettings.tts.volume)
    }
    toast(
      `${res.data?.conversationIds.length ?? 0} encrypted ${
        res.data?.conversationIds.length === 1 ? 'conversation' : 'conversations'
      } imported`,
      'success'
    )
    return true
  },

  // --- models -------------------------------------------------------------
  async loadModel(id: string): Promise<void> {
    const infoRes = await window.sibyl.app.info()
    if (infoRes.ok && infoRes.data) setState({ appInfo: infoRes.data })
    const model = state.installedModels.find((candidate) => candidate.id === id)
    const settings = state.settings
    const appInfo = infoRes.data ?? state.appInfo
    if (model && settings && appInfo) {
      const fit = estimateModelFit({
        model,
        contextSize: settings.load.contextSize,
        gpuLayers: settings.load.gpuLayers,
        gpuEnabled: settings.gpu !== 'cpu' && settings.load.gpuLayers !== 0,
        resources: {
          systemMemoryTotalBytes: appInfo.systemMemoryTotalBytes,
          systemMemoryFreeBytes: appInfo.systemMemoryFreeBytes,
          vramTotalBytes: state.engine.vramTotalBytes,
          vramUsedBytes: state.engine.vramUsedBytes
        }
      })
      if (
        fit.severity === 'infeasible' &&
        !window.confirm(
          `${fit.summary}.\n\n${fit.details.join('\n')}\n\nTry loading anyway?`
        )
      ) {
        return
      }
    }
    const res = await window.sibyl.engine.load(id)
    if (res.ok && res.data) {
      setState({ engine: res.data })
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
      if (patch.accent) applyAccentTheme(patch.accent)
      if (patch.accessibility) applyAccessibilitySettings(res.data.accessibility)
      if (patch.tts?.volume !== undefined) ttsPlayer.setVolume(patch.tts.volume)
    } else {
      toast(res.error ?? 'Failed to save settings', 'error')
    }
  },

  updateAccessibilitySettings(
    patch: Partial<RendererSettings['accessibility']>
  ): void {
    accessibilitySettingsQueue = accessibilitySettingsQueue.catch(() => {}).then(async () => {
      const current = state.settings?.accessibility
      if (!current) return
      await actions.updateSettings({
        accessibility: { ...current, ...patch }
      })
    })
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
    ttsSettingsQueue = ttsSettingsQueue.catch(() => {}).then(async () => {
      const current = state.settings?.tts
      if (!current) return
      await actions.updateSettings({ tts: { ...current, ...patch } })
    })
  },

  async refreshVoices(): Promise<void> {
    const res = await window.sibyl.tts.listVoices()
    if (res.ok) {
      const voices = res.data ?? []
      for (const voice of voices) {
        if (!voice.availability || voice.availability === 'available') {
          announcedMissingVoices.delete(voice.id)
        }
      }
      setState({ installedVoices: voices })
    }
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
    const ready = ttsReadiness(messageId)
    if (!ready.ok) {
      toast(ready.reason, 'info')
      return
    }
    if (ready.assignment) announceVoiceFallback(ready.assignment)
    // Create/resume the AudioContext within this user gesture so audio can start.
    ttsPlayer.ensureContext()
    const res = await window.sibyl.tts.speak({
      messageId,
      text,
      voiceId: ready.voiceId,
      rate: ready.rate
    })
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
  maybeAutoSpeak(messageId: string, text: string): boolean {
    const s = state.settings?.tts
    if (!s?.enabled || !s.autoSpeak || !text.trim()) return false
    const operationId =
      state.turnOperation.messageId === messageId
        ? state.turnOperation.operationId
        : undefined
    const currentSceneRun = state.scenePlay
    const sceneRun =
      state.turnOperation.kind === 'scene' &&
      currentSceneRun &&
      state.turnOperation.conversationId === currentSceneRun.convId &&
      currentSceneRun.activeOperationId === state.turnOperation.operationId
        ? currentSceneRun
        : null
    if (sceneRun?.muted) return false
    const readiness = ttsReadiness(messageId)
    if (!readiness.ok) {
      if (sceneRun && state.turnOperation.conversationId) {
        updateSceneRun(sceneRun.convId, (run) =>
          setSceneNarration(run, 'error', messageId, readiness.reason)
        )
        if (operationId) failTurn(operationId, readiness.reason)
        toast(readiness.reason, 'error')
        return true
      }
      return false
    }
    if (readiness.assignment) announceVoiceFallback(readiness.assignment)
    ttsPlayer.ensureContext()
    if (operationId) transitionTurn(operationId, { phase: 'narration-pending' })
    if (sceneRun) {
      updateSceneRun(sceneRun.convId, (run) => setSceneNarration(run, 'pending', messageId))
    }
    void safeIpc(
      () =>
        window.sibyl.tts.speak({
          messageId,
          text,
          voiceId: readiness.voiceId,
          rate: readiness.rate
        }),
      'Speech became unavailable.'
    ).then((res) => {
      if (!res.ok) {
        const error = res.error ?? 'Failed to start speech'
        const current = state.scenePlay
        if (
          sceneRun &&
          current?.convId === sceneRun.convId &&
          current.activeOperationId === sceneRun.activeOperationId &&
          current.narration === 'pending' &&
          current.narrationMessageId === messageId
        ) {
          updateSceneRun(sceneRun.convId, (run) =>
            setSceneNarration(run, 'error', messageId, error)
          )
          if (operationId) failTurn(operationId, error)
          toast(error, 'error')
        } else if (!sceneRun && operationId && state.turnOperation.operationId === operationId) {
          failTurn(operationId, error)
          toast(error, 'error')
        }
      }
    })
    return true
  },

  async setupVault(recoveryPassphrase: string, seamlessOnThisDevice: boolean): Promise<boolean> {
    const res = await window.sibyl.vault.setup({
      recoveryPassphrase,
      seamlessOnThisDevice
    })
    if (!res.ok || !res.data) {
      toast(res.error ?? 'The encrypted private vault could not be created.', 'error')
      return false
    }
    setState({ vault: res.data, ready: false })
    initialized = false
    await actions.init()
    return state.vault?.state === 'unlocked'
  },

  async unlockVault(recoveryPassphrase: string): Promise<boolean> {
    const res = await window.sibyl.vault.unlock(recoveryPassphrase)
    if (!res.ok || !res.data) {
      toast(res.error ?? 'The recovery passphrase was not accepted.', 'error')
      return false
    }
    setState({ vault: res.data, ready: false })
    initialized = false
    await actions.init()
    return state.vault?.state === 'unlocked'
  },

  async unlockVaultWithPasskey(): Promise<boolean> {
    const res = await window.sibyl.vault.unlockPasskey()
    if (!res.ok || !res.data) {
      toast(res.error ?? 'The passkey could not unlock this vault.', 'error')
      return false
    }
    setState({ vault: res.data, ready: false })
    initialized = false
    await actions.init()
    return state.vault?.state === 'unlocked'
  },

  async setVaultSeamless(enabled: boolean): Promise<boolean> {
    const res = await window.sibyl.vault.setSeamless(enabled)
    if (!res.ok || !res.data) {
      toast(res.error ?? 'The vault unlock preference could not be changed.', 'error')
      return false
    }
    setState({ vault: res.data })
    toast(enabled ? 'Seamless device unlock enabled' : 'Unlock required at launch', 'success')
    return true
  },

  async setVaultPasskey(enabled: boolean): Promise<boolean> {
    const res = await window.sibyl.vault.setPasskey(enabled)
    if (!res.ok || !res.data) {
      toast(
        res.error ??
          (enabled
            ? 'A passkey could not be enrolled.'
            : 'The passkey could not be removed.'),
        'error'
      )
      return false
    }
    setState({ vault: res.data })
    toast(
      enabled ? 'Passkey unlock enrolled' : 'Passkey unlock removed',
      'success'
    )
    return true
  },

  async changeVaultRecoveryPassphrase(recoveryPassphrase: string): Promise<boolean> {
    const res = await window.sibyl.vault.changeRecoveryPassphrase(recoveryPassphrase)
    if (!res.ok || !res.data) {
      toast(res.error ?? 'The recovery passphrase could not be changed.', 'error')
      return false
    }
    setState({ vault: res.data })
    toast('Recovery passphrase changed', 'success')
    return true
  },

  async refreshVaultBackups(): Promise<void> {
    const res = await window.sibyl.vault.listBackups()
    if (res.ok && res.data) setState({ vaultBackups: res.data })
    else if (!res.ok) toast(res.error ?? 'Encrypted backups could not be read.', 'error')
  },

  async createVaultBackup(): Promise<void> {
    const res = await window.sibyl.vault.createBackup()
    if (!res.ok) {
      toast(res.error ?? 'The encrypted recovery snapshot could not be created.', 'error')
      return
    }
    await actions.refreshVaultBackups()
    toast('Encrypted recovery snapshot created', 'success')
  },

  async verifyVaultRecovery(): Promise<void> {
    const res = await window.sibyl.vault.verifyRecovery()
    if (!res.ok || !res.data) {
      toast(res.error ?? 'The recovery drill failed.', 'error')
      return
    }
    toast(
      `Recovery drill passed: ${res.data.currentRecords} live records and ${res.data.validBackups} verified snapshots.`,
      'success'
    )
  },

  async restoreVaultBackup(id: string): Promise<void> {
    const res = await window.sibyl.vault.restoreBackup(id)
    if (!res.ok) toast(res.error ?? 'The encrypted backup could not be restored.', 'error')
  },

  async lockVault(): Promise<void> {
    const res = await window.sibyl.vault.lock()
    if (!res.ok) toast(res.error ?? 'The private vault could not be locked.', 'error')
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

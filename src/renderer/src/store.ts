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
  InstalledModel
} from '@shared/types'
import type { AppInfo } from '@shared/ipc'
import type { ExportFormat } from '@shared/export'

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
  toast: { id: number; kind: 'info' | 'error' | 'success'; message: string } | null
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
  toast: null
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
  void window.oracle.conversations.save(conversation)
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
  await window.oracle.conversations.save(updated)
  await window.oracle.chat.invalidateSession(conv.id)
  const res = await window.oracle.chat.send({
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
    setState({ view })
  },

  async init(): Promise<void> {
    // Guard against React StrictMode invoking the mount effect twice in dev,
    // which would otherwise register duplicate IPC listeners (double tokens).
    if (initialized) return
    initialized = true

    const [settingsRes, infoRes, modelsRes, convRes, statusRes, dlRes] = await Promise.all([
      window.oracle.settings.get(),
      window.oracle.app.info(),
      window.oracle.models.list(),
      window.oracle.conversations.list(),
      window.oracle.engine.status(),
      window.oracle.downloads.list()
    ])

    const downloads: Record<string, DownloadProgress> = {}
    if (dlRes.ok && dlRes.data) for (const d of dlRes.data) downloads[d.id] = d

    setState({
      ready: true,
      settings: settingsRes.data ?? null,
      appInfo: infoRes.data ?? null,
      installedModels: modelsRes.data ?? [],
      conversations: convRes.data ?? [],
      engine: statusRes.data ?? state.engine,
      downloads,
      activeConversationId: convRes.data?.[0]?.id ?? null
    })

    if (state.settings?.theme) document.documentElement.classList.toggle('light', state.settings.theme === 'light')

    // Pull an initial context snapshot for the opening conversation.
    void actions.refreshContextUsage()

    // Wire live event streams.
    window.oracle.engine.onStatus((s) => setState({ engine: s }))
    window.oracle.context.onUsage((u) => {
      // Only adopt snapshots for the conversation currently on screen; the engine
      // also broadcasts a null-conversation snapshot on load that must not clobber
      // an active conversation's real fill.
      if (u.conversationId === state.activeConversationId) setState({ contextUsage: u })
    })
    window.oracle.downloads.onProgress((p) => {
      setState((st) => ({ downloads: { ...st.downloads, [p.id]: p } }))
      if (p.status === 'completed') {
        toast(`Downloaded ${p.filename}`, 'success')
        void actions.refreshModels()
      } else if (p.status === 'error') {
        toast(`Download failed: ${p.error ?? p.filename}`, 'error')
      }
    })
    window.oracle.chat.onEvent((e) => {
      if (e.type === 'token') {
        updateConversation(e.conversationId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === e.messageId ? { ...m, content: m.content + e.text } : m
          )
        }))
      } else if (e.type === 'done') {
        updateConversation(e.conversationId, (c) => {
          const updated = {
            ...c,
            updatedAt: now(),
            messages: c.messages.map((m) =>
              m.id === e.messageId ? { ...m, stats: e.stats, error: undefined } : m
            )
          }
          persist(updated)
          return updated
        })
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
        toast(e.error, 'error')
      }
    })
  },

  async refreshModels(): Promise<void> {
    const res = await window.oracle.models.list()
    if (res.ok) setState({ installedModels: res.data ?? [] })
  },

  // --- context window -----------------------------------------------------
  async refreshContextUsage(): Promise<void> {
    if (!state.engine.modelId) {
      setState({ contextUsage: null })
      return
    }
    const res = await window.oracle.context.usage(state.activeConversationId)
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
    const res = await window.oracle.chat.compact(id)
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
  newConversation(): string {
    const conv: Conversation = {
      id: uid(),
      title: 'New chat',
      modelId: state.engine.modelId,
      messages: [],
      createdAt: now(),
      updatedAt: now()
    }
    setState((s) => ({
      conversations: [conv, ...s.conversations],
      activeConversationId: conv.id,
      view: 'chat'
    }))
    persist(conv)
    void actions.refreshContextUsage()
    return conv.id
  },

  selectConversation(id: string): void {
    setState({ activeConversationId: id, view: 'chat' })
    void actions.refreshContextUsage()
  },

  async deleteConversation(id: string): Promise<void> {
    await window.oracle.conversations.delete(id)
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
    if (saved) await window.oracle.conversations.save(saved)

    const res = await window.oracle.chat.send({
      conversationId,
      message: content,
      assistantMessageId: assistantMsg.id
    })
    if (!res.ok) toast(res.error ?? 'Failed to send message', 'error')
  },

  abortGeneration(): void {
    if (state.activeConversationId) void window.oracle.chat.abort(state.activeConversationId)
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
    void window.oracle.chat.invalidateSession(conv.id)
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
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now() }
    await runTurn(conv, [...conv.messages.slice(0, idx), editedUser, assistantMsg], content, assistantMsg.id)
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
    if (prevPrompt !== nextPrompt) await window.oracle.chat.invalidateSession(id)
    void actions.refreshContextUsage()
  },

  /** Render the conversation and prompt the user to save it to a file. */
  async exportConversation(id: string, format: ExportFormat): Promise<void> {
    const res = await window.oracle.conversations.export(id, format)
    if (!res.ok) {
      toast(res.error ?? 'Export failed', 'error')
      return
    }
    if (res.data?.saved) toast('Conversation exported', 'success')
  },

  // --- models -------------------------------------------------------------
  async loadModel(id: string): Promise<void> {
    const res = await window.oracle.engine.load(id)
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
    await window.oracle.engine.unload()
    setState({ contextUsage: null })
  },

  async deleteModel(id: string): Promise<void> {
    await window.oracle.models.delete(id)
    await actions.refreshModels()
    toast('Model deleted', 'info')
  },

  revealModel(id: string): void {
    void window.oracle.models.reveal(id)
  },

  // --- downloads ----------------------------------------------------------
  async startDownload(repoId: string, filename: string): Promise<void> {
    const res = await window.oracle.downloads.start(repoId, filename)
    if (res.ok) toast(`Started download: ${filename}`, 'info')
    else toast(res.error ?? 'Download failed to start', 'error')
  },

  cancelDownload(id: string): void {
    void window.oracle.downloads.cancel(id)
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
    const res = await window.oracle.hf.search(query, sort)
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
    const res = await window.oracle.hf.modelDetail(repoId)
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
    const res = await window.oracle.settings.set(patch)
    if (res.ok && res.data) {
      setState({ settings: res.data })
      if (patch.theme) document.documentElement.classList.toggle('light', patch.theme === 'light')
    } else {
      toast(res.error ?? 'Failed to save settings', 'error')
    }
  },

  dismissToast(): void {
    setState({ toast: null })
  }
}

export { activeConversation }

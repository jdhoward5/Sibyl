import { EventEmitter } from 'node:events'
import type * as NLC from 'node-llama-cpp'
import type {
  AppSettings,
  ChatMessage,
  CompactionInfo,
  Conversation,
  ContextUsage,
  EngineStatus,
  GenerationEvent,
  GenerationOptions,
  InstalledModel
} from '@shared/types'
import { DEFAULT_GENERATION_OPTIONS } from '@shared/types'
import { contextLevel } from '@shared/context'
import { getLlamaInstance } from './llama'
import { getInstalledModel, getSettings, upsertInstalledModel } from './store'

/** Prefix the folded-history summary is injected under, inside the system turn. */
const SUMMARY_PREFIX =
  'Summary of earlier conversation (older turns were condensed to save context):\n'

/**
 * Owns the single loaded model + active chat session. One model is resident at
 * a time (sized to the user's VRAM); switching conversations reuses the loaded
 * model and only rebuilds the chat session/KV-cache when necessary.
 */
class InferenceEngine extends EventEmitter {
  private llama: NLC.Llama | null = null
  private model: NLC.LlamaModel | null = null
  private context: NLC.LlamaContext | null = null
  private sequence: NLC.LlamaContextSequence | null = null
  private session: NLC.LlamaChatSession | null = null

  private loadedModelId: string | null = null
  private sessionConversationId: string | null = null
  private contextSize: number | null = null

  private state: EngineStatus['state'] = 'idle'
  private lastError: string | undefined
  private abort: AbortController | null = null
  // True while a generate() or compact() is in flight. The engine holds a single
  // chat session over one context sequence, so only one prompt may run at a time;
  // this serializes (rejects) re-entrant calls instead of clobbering the abort
  // controller and racing the shared KV cache.
  private busy = false
  // Resolves when the current exclusive operation has fully unwound. unload()
  // awaits this (after aborting) so GPU resources are never disposed while a
  // prompt is still running on a worker thread (that crashes with 0xC0000409).
  private idle: Promise<void> = Promise.resolve()
  private resolveIdle: (() => void) | null = null

  // -- status ---------------------------------------------------------------

  async status(): Promise<EngineStatus> {
    let vramTotal: number | null = null
    let vramUsed: number | null = null
    if (this.llama) {
      try {
        const v = await this.llama.getVramState()
        vramTotal = v.total
        vramUsed = v.used
      } catch {
        /* ignore */
      }
    }
    return {
      state: this.state,
      modelId: this.loadedModelId,
      gpuType: (this.llama?.gpu ?? null) as EngineStatus['gpuType'],
      vramTotalBytes: vramTotal,
      vramUsedBytes: vramUsed,
      contextSize: this.contextSize,
      error: this.lastError
    }
  }

  private async setState(state: EngineStatus['state'], error?: string): Promise<void> {
    this.state = state
    this.lastError = error
    this.emit('status', await this.status())
  }

  /** Mark the engine busy and arm the `idle` promise for unload() to await. */
  private beginExclusive(): void {
    this.busy = true
    this.idle = new Promise<void>((resolve) => {
      this.resolveIdle = resolve
    })
  }

  /** Clear busy and let any waiting unload() proceed. */
  private endExclusive(): void {
    this.busy = false
    const resolve = this.resolveIdle
    this.resolveIdle = null
    resolve?.()
  }

  // -- model lifecycle ------------------------------------------------------

  async load(modelId: string): Promise<EngineStatus> {
    if (this.loadedModelId === modelId && this.model) {
      return this.status()
    }
    const installed = await getInstalledModel(modelId)
    if (!installed) {
      await this.setState('error', `Model not found: ${modelId}`)
      throw new Error(`Model not found: ${modelId}`)
    }

    await this.unload()
    await this.setState('loading')

    try {
      const settings = await getSettings()
      this.llama = await getLlamaInstance(settings.gpu)

      this.model = await this.llama.loadModel({
        modelPath: installed.path,
        gpuLayers: settings.load.gpuLayers < 0 ? undefined : settings.load.gpuLayers
      })

      // Clamp the requested context to what the model was trained for.
      const trained = this.model.trainContextSize ?? settings.load.contextSize
      const requested = settings.load.contextSize
      this.contextSize = Math.max(512, Math.min(requested, trained))

      // Flash attention is required for models with per-layer KV head counts
      // (e.g. Gemma 4's interleaved sliding-window attention); without it the
      // CUDA backend falls back to a padded V-cache path and warns. It's also a
      // throughput win on modern GPUs, so enable it for every model.
      this.context = await this.model.createContext({
        contextSize: this.contextSize,
        flashAttention: true
      })
      // One persistent sequence + session is reused for every conversation; we
      // swap context via setChatHistory rather than allocating new sequences
      // (a context only exposes a small fixed pool of them).
      const { LlamaChatSession } = await import('node-llama-cpp')
      this.sequence = this.context.getSequence()
      this.session = new LlamaChatSession({
        contextSequence: this.sequence,
        systemPrompt: settings.load.systemPrompt
      })
      this.loadedModelId = modelId
      this.sessionConversationId = null

      // Enrich the registry with metadata learned at load time.
      await this.persistMetadata(installed)

      await this.setState('ready')
      void this.emitUsage(null)
      return this.status()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.unload()
      await this.setState('error', msg)
      throw err
    }
  }

  private async persistMetadata(installed: InstalledModel): Promise<void> {
    if (!this.model) return
    try {
      const updated: InstalledModel = {
        ...installed,
        trainContextLength: this.model.trainContextSize ?? installed.trainContextLength
      }
      await upsertInstalledModel(updated)
    } catch {
      /* non-fatal */
    }
  }

  async unload(): Promise<void> {
    // Abort any in-flight generation/compaction and WAIT for it to fully unwind
    // before disposing GPU resources. Disposing the context/model while a prompt
    // is still running on a libuv worker is a use-after-free that crashes the
    // process with 0xC0000409.
    this.abort?.abort()
    if (this.busy) {
      try {
        await this.idle
      } catch {
        /* the operation reports its own errors; we only need it to have stopped */
      }
    }
    this.abort = null
    try {
      this.session = null
      if (this.sequence) this.sequence.dispose()
      if (this.context) await this.context.dispose()
    } catch {
      /* ignore */
    }
    try {
      if (this.model) await this.model.dispose()
    } catch {
      /* ignore */
    }
    this.sequence = null
    this.context = null
    this.model = null
    this.loadedModelId = null
    this.sessionConversationId = null
    this.contextSize = null
    if (this.state !== 'error') await this.setState('idle')
  }

  // -- chat session ---------------------------------------------------------

  private toHistory(messages: ChatMessage[], systemPrompt: string): NLC.ChatHistoryItem[] {
    const history: NLC.ChatHistoryItem[] = [{ type: 'system', text: systemPrompt }]
    for (const m of messages) {
      if (!m.content.trim()) continue
      if (m.role === 'user') history.push({ type: 'user', text: m.content })
      else if (m.role === 'assistant') history.push({ type: 'model', response: [m.content] })
    }
    return history
  }

  /**
   * The system prompt actually fed to the model: the conversation's (or default)
   * system text, plus the compaction summary when older turns have been folded.
   */
  private systemPromptFor(conversation: Conversation, settings: AppSettings): string {
    const override = conversation.overrides?.systemPrompt?.trim()
    const systemMessage = conversation.messages.find((m) => m.role === 'system')
    let prompt = override || systemMessage?.content?.trim() || settings.load.systemPrompt
    const summary = conversation.compaction?.summary?.trim()
    if (summary) prompt += `\n\n${SUMMARY_PREFIX}${summary}`
    return prompt
  }

  /**
   * Messages that are sent verbatim — everything after the last folded turn.
   * Folded turns live in the compaction summary instead.
   */
  private liveMessages(conversation: Conversation): ChatMessage[] {
    const through = conversation.compaction?.throughMessageId
    if (!through) return conversation.messages
    const idx = conversation.messages.findIndex((m) => m.id === through)
    if (idx < 0) return conversation.messages // summary points at a pruned message
    return conversation.messages.slice(idx + 1)
  }

  private async ensureSession(conversation: Conversation, currentUserText: string): Promise<NLC.LlamaChatSession> {
    if (!this.session) throw new Error('No model loaded')
    const settings = await getSettings()
    const systemPrompt = this.systemPromptFor(conversation, settings)

    // Reuse the live session (and its warm KV cache) when continuing the same
    // conversation; otherwise swap the session's history to this conversation.
    if (this.sessionConversationId === conversation.id) {
      return this.session
    }

    // Build prior history from the live (un-folded) tail, excluding the just-sent
    // user turn and any empty assistant placeholder the renderer pre-allocated.
    const prior = this.liveMessages(conversation).filter((m) => m.role !== 'system')
    while (prior.length) {
      const last = prior[prior.length - 1]
      if (last.role === 'assistant' && !last.content.trim()) {
        prior.pop()
        continue
      }
      if (last.role === 'user' && last.content === currentUserText) {
        prior.pop()
        break
      }
      break
    }
    this.session.setChatHistory(this.toHistory(prior, systemPrompt))
    this.sessionConversationId = conversation.id
    return this.session
  }

  /**
   * Reload a conversation's full live history into the shared session — used after
   * a cancelled/failed compaction clobbered it — so the next turn continues
   * without a surprise rebuild. Falls back to invalidating the session if the
   * history can't be restored.
   */
  private async restoreSession(conversation: Conversation): Promise<void> {
    if (!this.session) return
    try {
      const settings = await getSettings()
      const systemPrompt = this.systemPromptFor(conversation, settings)
      const prior = this.liveMessages(conversation).filter((m) => m.role !== 'system')
      this.session.setChatHistory(this.toHistory(prior, systemPrompt))
      this.sessionConversationId = conversation.id
    } catch {
      this.sessionConversationId = null // couldn't restore — force a clean rebuild next turn
    }
  }

  async generate(
    conversation: Conversation,
    userText: string,
    assistantMessageId: string,
    optionsOverride: Partial<GenerationOptions> | undefined
  ): Promise<void> {
    if (!this.model || !this.context) {
      this.emitEvent({
        type: 'error',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        error: 'No model is loaded. Load a model first.'
      })
      return
    }

    // One generation/compaction at a time — see `busy`. The renderer already
    // disables sending while generating; this is the backstop against a race.
    if (this.busy) {
      this.emitEvent({
        type: 'error',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        error: 'A response is already being generated. Wait for it to finish.'
      })
      return
    }
    this.beginExclusive()

    let started = 0
    let completionTokens = 0

    try {
      const settings = await getSettings()
      const opts: GenerationOptions = {
        ...DEFAULT_GENERATION_OPTIONS,
        ...settings.generation,
        ...(conversation.overrides?.generation ?? {}),
        ...optionsOverride
      }
      const session = await this.ensureSession(conversation, userText)
      this.abort = new AbortController()
      await this.setState('generating')

      started = Date.now()
      const responseText = await session.prompt(userText, {
        signal: this.abort.signal,
        stopOnAbortSignal: true,
        temperature: opts.temperature,
        topP: opts.topP,
        topK: opts.topK,
        minP: opts.minP,
        maxTokens: opts.maxTokens,
        seed: opts.seed,
        repeatPenalty: { penalty: opts.repeatPenalty },
        onTextChunk: (chunk: string) => {
          completionTokens += 1
          this.emitEvent({
            type: 'token',
            conversationId: conversation.id,
            messageId: assistantMessageId,
            text: chunk
          })
        }
      })

      const durationMs = Date.now() - started
      // Prefer an exact token count from the model tokenizer.
      try {
        if (this.model && responseText) {
          completionTokens = this.model.tokenize(responseText).length
        }
      } catch {
        /* keep chunk-based estimate */
      }
      const promptTokens = this.estimatePromptTokens(conversation, userText)
      this.emitEvent({
        type: 'done',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        stats: {
          promptTokens,
          completionTokens,
          durationMs,
          tokensPerSecond: durationMs > 0 ? (completionTokens / durationMs) * 1000 : 0,
          contextTokens: this.sequence?.nextTokenIndex
        }
      })
    } catch (err) {
      if (this.abort?.signal.aborted) {
        // Treat user-initiated stop as a graceful completion of partial text.
        const durationMs = Date.now() - started
        this.emitEvent({
          type: 'done',
          conversationId: conversation.id,
          messageId: assistantMessageId,
          stats: {
            promptTokens: this.estimatePromptTokens(conversation, userText),
            completionTokens,
            durationMs,
            tokensPerSecond: durationMs > 0 ? (completionTokens / durationMs) * 1000 : 0,
            contextTokens: this.sequence?.nextTokenIndex
          }
        })
      } else {
        this.emitEvent({
          type: 'error',
          conversationId: conversation.id,
          messageId: assistantMessageId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      this.abort = null
      await this.setState('ready')
      // Report the now-exact KV-cache fill so the renderer's meter is accurate.
      void this.emitUsage(conversation)
      // Release last: unblocks any unload() waiting for this prompt to unwind.
      this.endExclusive()
    }
  }

  private estimatePromptTokens(conversation: Conversation, userText: string): number {
    if (!this.model) return 0
    try {
      const text = conversation.messages.map((m) => m.content).join('\n') + '\n' + userText
      return this.model.tokenize(text).length
    } catch {
      return 0
    }
  }

  abortGeneration(): void {
    this.abort?.abort()
  }

  /**
   * Drop the warm session so the next generate() rebuilds history from the
   * persisted conversation. Called after the renderer edits/deletes/regenerates
   * messages — the prior KV cache no longer matches the new history. Safe to call
   * mid-generation: the in-flight generate already captured its session; this
   * field is only read by the next ensureSession()/computeUsage().
   */
  invalidateSession(conversationId?: string): void {
    if (!conversationId || this.sessionConversationId === conversationId) {
      this.sessionConversationId = null
    }
  }

  // -- context window -------------------------------------------------------

  private tokenCount(text: string): number {
    if (!this.model || !text) return 0
    try {
      return this.model.tokenize(text).length
    } catch {
      return Math.ceil(text.length / 4) // ~4 chars/token fallback
    }
  }

  /**
   * Estimate the tokens a conversation would occupy if (re)loaded into the
   * window: the effective system prompt (incl. summary) plus the live tail,
   * with a small per-turn allowance for chat-template framing.
   */
  private estimateConversationTokens(conversation: Conversation, settings: AppSettings): number {
    let total = this.tokenCount(this.systemPromptFor(conversation, settings)) + 8
    for (const m of this.liveMessages(conversation)) {
      if (m.role === 'system' || !m.content.trim()) continue
      total += this.tokenCount(m.content) + 4
    }
    return total
  }

  /**
   * Snapshot how full the window is for a conversation. Reads the exact KV-cache
   * fill when that conversation is the one resident in the session; otherwise
   * estimates by tokenizing. Safe to call with null (returns an empty snapshot).
   */
  async computeUsage(conversation: Conversation | null): Promise<ContextUsage> {
    const settings = await getSettings()
    const contextSize = this.contextSize ?? 0
    const reserve = conversation?.overrides?.generation?.maxTokens ?? settings.generation.maxTokens
    const { warnThreshold, compactThreshold } = settings.context

    let usedTokens = 0
    let exact = false
    if (conversation && this.model) {
      if (this.sequence && this.sessionConversationId === conversation.id) {
        usedTokens = this.sequence.nextTokenIndex
        exact = true
      } else {
        usedTokens = this.estimateConversationTokens(conversation, settings)
      }
    }

    const fraction = contextSize > 0 ? Math.min(1, usedTokens / contextSize) : 0
    return {
      conversationId: conversation?.id ?? null,
      usedTokens,
      contextSize,
      responseReserveTokens: reserve,
      fraction,
      level: contextLevel(fraction, warnThreshold, compactThreshold),
      willOverflow: contextSize > 0 && usedTokens + reserve > contextSize,
      exact
    }
  }

  private async emitUsage(conversation: Conversation | null): Promise<void> {
    try {
      this.emit('context', await this.computeUsage(conversation))
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Summarize the older portion of a conversation into a single cumulative
   * summary, leaving the most recent `keepRecentMessages` turns verbatim.
   * Returns the new compaction record for the caller to persist onto the
   * conversation — the engine does not own conversation state.
   */
  async compact(conversation: Conversation): Promise<CompactionInfo> {
    if (!this.session || !this.model) throw new Error('No model is loaded.')
    // Shares the single chat session with generate(); refuse to run concurrently.
    if (this.busy) throw new Error('Cannot compact while another operation is in progress.')
    this.beginExclusive()
    try {
      const settings = await getSettings()
      const keep = Math.max(0, settings.context.keepRecentMessages)

      const live = this.liveMessages(conversation).filter(
        (m) => m.role !== 'system' && m.content.trim()
      )
      const foldCount = live.length - keep
      if (foldCount <= 0) {
        throw new Error('Not enough conversation history to compact yet.')
      }
      const toFold = live.slice(0, foldCount)
      const throughMessageId = toFold[toFold.length - 1].id

      const priorSummary = conversation.compaction?.summary?.trim()
      const transcript = toFold
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
        .join('\n\n')
      const instruction =
        (priorSummary
          ? `Existing summary of the conversation so far:\n${priorSummary}\n\n`
          : '') +
        'Update (or create) a concise summary of the conversation that preserves all ' +
        'facts, decisions, names, code, numbers and unresolved questions needed to ' +
        'continue. Write terse third-person notes. Do not add commentary or address ' +
        'the user.\n\nConversation excerpt to fold in:\n' +
        transcript

      // Summarization runs on the shared session, which clobbers its chat history.
      // On success we invalidate the session (the caller persists the compaction and
      // the next generate rebuilds from it). On cancel/failure we restore the
      // conversation so the clobbered history doesn't bleed into the next turn — and
      // a half-generated summary is discarded rather than persisted.
      this.abort = new AbortController()
      await this.setState('generating')
      let summary = ''
      try {
        this.session.setChatHistory([
          { type: 'system', text: 'You are a precise conversation summarizer.' }
        ])
        const out = await this.session.prompt(instruction, {
          signal: this.abort.signal,
          stopOnAbortSignal: true,
          temperature: 0.3,
          maxTokens: 600
        })
        if (this.abort.signal.aborted) throw new Error('Compaction cancelled.')
        summary = out.trim()
        if (!summary) throw new Error('Summarization produced no output.')
      } catch (err) {
        await this.restoreSession(conversation)
        throw err
      } finally {
        this.abort = null
        await this.setState('ready')
      }

      // Success: invalidate so the next generate rebuilds from the compacted history.
      this.sessionConversationId = null

      return {
        summary,
        throughMessageId,
        foldedCount: (conversation.compaction?.foldedCount ?? 0) + toFold.length,
        originalTokens:
          this.tokenCount(transcript) + (priorSummary ? this.tokenCount(priorSummary) : 0),
        summaryTokens: this.tokenCount(summary),
        compactedAt: new Date().toISOString()
      }
    } finally {
      this.endExclusive()
    }
  }

  private emitEvent(event: GenerationEvent): void {
    this.emit('event', event)
  }
}

export const engine = new InferenceEngine()

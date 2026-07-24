import { EventEmitter } from 'node:events'
import type * as NLC from 'node-llama-cpp'
import type {
  AppSettings,
  ChatMessage,
  CompactionInfo,
  Conversation,
  ContextUsage,
  EngineStatus,
  EngineOperation,
  GenerationEvent,
  GenerationOptions,
  InstalledModel,
  Persona
} from '@shared/types'
import { DEFAULT_GENERATION_OPTIONS } from '@shared/types'
import { contextLevel, keepRecentCount, summaryBudgetTokens } from '@shared/context'
import { findPersona } from '@shared/personas'
import { buildBeatPrompt, isScene, nextSpeakerId, sceneCast, type SceneTurn } from '@shared/scene'
import { getLlamaInstance } from './llama'
import { getInstalledModel, getSettings, upsertInstalledModel } from './store'
import { SerialQueue } from '@shared/serial'

/** Prefix the folded-history summary is injected under, inside the system turn. */
const SUMMARY_PREFIX =
  'Summary of earlier conversation (older turns were condensed to save context):\n'

/**
 * Owns the single loaded model + active chat session. One model is resident at
 * a time (sized to the user's VRAM); switching conversations reuses the loaded
 * model and only rebuilds the chat session/KV-cache when necessary.
 */
export class InferenceEngine extends EventEmitter {
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
  private lifecycle = new SerialQueue()
  private activeOperation: (EngineOperation & { controller?: AbortController }) | null = null
  private operationSequence = 0
  private loadRequestSequence = 0
  private loadedConfiguration: string | null = null
  private shutdownRequested = false

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
      error: this.lastError,
      operation: this.activeOperation
        ? {
            id: this.activeOperation.id,
            kind: this.activeOperation.kind,
            conversationId: this.activeOperation.conversationId,
            messageId: this.activeOperation.messageId,
            modelId: this.activeOperation.modelId
          }
        : undefined
    }
  }

  private async setState(state: EngineStatus['state'], error?: string): Promise<void> {
    this.state = state
    this.lastError = error
    this.emit('status', await this.status())
  }

  private operation(
    kind: EngineOperation['kind'],
    details: Omit<EngineOperation, 'id' | 'kind'> = {},
    controller?: AbortController
  ): EngineOperation & { controller?: AbortController } {
    return { id: `op-${++this.operationSequence}`, kind, ...details, controller }
  }

  private clearOperation(operation: EngineOperation): void {
    if (this.activeOperation?.id === operation.id) this.activeOperation = null
  }

  // -- model lifecycle ------------------------------------------------------

  async load(modelId: string): Promise<EngineStatus> {
    if (this.shutdownRequested) throw new Error('The inference engine is shutting down.')
    const request = ++this.loadRequestSequence
    // A model switch always interrupts a prompt before it enters the lifecycle
    // queue, so teardown waits for the prompt to unwind rather than its full reply.
    this.abort?.abort()
    return this.lifecycle.run(async () => {
      if (this.shutdownRequested) throw new Error('The inference engine is shutting down.')
      const operation = this.operation('load', { modelId })
      this.activeOperation = operation
      await this.setState('loading')

      let model: NLC.LlamaModel | null = null
      let context: NLC.LlamaContext | null = null
      let sequence: NLC.LlamaContextSequence | null = null
      try {
        const [installed, settings] = await Promise.all([getInstalledModel(modelId), getSettings()])
        if (!installed) throw new Error(`Model not found: ${modelId}`)
        if (installed.availability && installed.availability !== 'available') {
          throw new Error(installed.availabilityError ?? 'The model file is unavailable.')
        }
        const configuration = JSON.stringify({
          path: installed.path,
          gpu: settings.gpu,
          gpuLayers: settings.load.gpuLayers,
          contextSize: settings.load.contextSize,
          systemPrompt: settings.load.systemPrompt
        })
        if (
          this.loadedModelId === modelId &&
          this.model &&
          this.loadedConfiguration === configuration
        ) {
          this.clearOperation(operation)
          await this.setState('ready')
          return this.status()
        }

        await this.disposeResources()
        if (request !== this.loadRequestSequence) throw new Error('Model load was superseded.')
        const llama = await getLlamaInstance(settings.gpu)
        if (request !== this.loadRequestSequence) throw new Error('Model load was superseded.')
        model = await llama.loadModel({
          modelPath: installed.path,
          gpuLayers: settings.load.gpuLayers < 0 ? undefined : settings.load.gpuLayers
        })
        if (request !== this.loadRequestSequence) throw new Error('Model load was superseded.')

        const trained = model.trainContextSize ?? settings.load.contextSize
        const contextSize = Math.max(512, Math.min(settings.load.contextSize, trained))
        context = await model.createContext({ contextSize, flashAttention: true })
        if (request !== this.loadRequestSequence) throw new Error('Model load was superseded.')
        sequence = context.getSequence()
        const { LlamaChatSession } = await import('node-llama-cpp')
        const session = new LlamaChatSession({
          contextSequence: sequence,
          systemPrompt: settings.load.systemPrompt
        })
        if (request !== this.loadRequestSequence) throw new Error('Model load was superseded.')

        // Publish a complete resource set atomically. Until here the old shared
        // fields are null, so stale completions cannot overwrite a newer load.
        this.llama = llama
        this.model = model
        this.context = context
        this.sequence = sequence
        this.session = session
        this.contextSize = contextSize
        this.loadedModelId = modelId
        this.loadedConfiguration = configuration
        this.sessionConversationId = null
        model = null
        context = null
        sequence = null

        await this.persistMetadata(installed)
        this.clearOperation(operation)
        await this.setState('ready')
        void this.emitUsage(null)
        return this.status()
      } catch (err) {
        try {
          sequence?.dispose()
        } catch {
          /* best-effort cleanup of an unpublished load */
        }
        try {
          if (context) await context.dispose()
        } catch {
          /* best-effort cleanup of an unpublished load */
        }
        try {
          if (model) await model.dispose()
        } catch {
          /* best-effort cleanup of an unpublished load */
        }
        if (request === this.loadRequestSequence && !this.shutdownRequested) {
          this.clearOperation(operation)
          await this.setState('error', err instanceof Error ? err.message : String(err))
        }
        throw err
      } finally {
        this.clearOperation(operation)
      }
    })
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
    ++this.loadRequestSequence
    this.abort?.abort()
    await this.lifecycle.run(async () => {
      const operation = this.operation('unload')
      this.activeOperation = operation
      await this.setState('unloading')
      try {
        await this.disposeResources()
        this.clearOperation(operation)
        if (!this.shutdownRequested) await this.setState('idle')
      } finally {
        this.clearOperation(operation)
      }
    })
  }

  private async disposeResources(): Promise<void> {
    this.abort = null
    this.session = null
    const sequence = this.sequence
    const context = this.context
    const model = this.model
    this.sequence = null
    this.context = null
    this.model = null
    this.loadedModelId = null
    this.loadedConfiguration = null
    this.sessionConversationId = null
    this.contextSize = null
    try {
      sequence?.dispose()
    } catch {
      /* ignore */
    }
    try {
      if (context) await context.dispose()
    } catch {
      /* ignore */
    }
    try {
      if (model) await model.dispose()
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    ++this.loadRequestSequence
    this.abort?.abort()
    await this.lifecycle.run(async () => {
      const operation = this.operation('shutdown')
      this.activeOperation = operation
      await this.setState('shutting-down')
      try {
        await this.disposeResources()
        this.clearOperation(operation)
        await this.setState('shutting-down')
      } finally {
        this.clearOperation(operation)
      }
    })
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
   * The system prompt actually fed to the model. Resolution order (most specific
   * wins): per-conversation override → persona brief → legacy system message →
   * global prompt. The writer's own character and the compaction summary are
   * appended when present.
   */
  private systemPromptFor(conversation: Conversation, settings: AppSettings): string {
    const override = conversation.overrides?.systemPrompt?.trim()
    const persona = findPersona(settings.personas, conversation.personaId)
    const systemMessage = conversation.messages.find((m) => m.role === 'system')
    let prompt =
      override ||
      persona?.brief?.trim() ||
      systemMessage?.content?.trim() ||
      settings.load.systemPrompt

    const uc = conversation.userCharacter
    const ucName = uc?.name?.trim()
    const ucDesc = uc?.description?.trim()
    if (ucName || ucDesc) {
      prompt += `\n\nThe user plays ${ucName || 'an unnamed character'}${ucDesc ? `: ${ucDesc}` : ''}.`
    }

    const summary = conversation.compaction?.summary?.trim()
    if (summary) prompt += `\n\n${SUMMARY_PREFIX}${summary}`
    return prompt
  }

  /**
   * Effective generation options: global → persona → per-conversation override.
   * `personaOverride` lets a scene beat use its active speaker's params instead of
   * the conversation's single persona.
   */
  private generationFor(
    conversation: Conversation,
    settings: AppSettings,
    optionsOverride: Partial<GenerationOptions> | undefined,
    personaOverride?: Persona | null
  ): GenerationOptions {
    const persona = personaOverride ?? findPersona(settings.personas, conversation.personaId)
    return {
      ...DEFAULT_GENERATION_OPTIONS,
      ...settings.generation,
      ...(persona?.generation ?? {}),
      ...(conversation.overrides?.generation ?? {}),
      ...optionsOverride
    }
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

    if (this.activeOperation) {
      this.emitEvent({
        type: 'error',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        error: 'A response is already being generated. Wait for it to finish.'
      })
      return
    }
    const controller = new AbortController()
    const operation = this.operation(
      'generate',
      { conversationId: conversation.id, messageId: assistantMessageId },
      controller
    )
    this.activeOperation = operation
    this.abort = controller
    return this.lifecycle.run(async () => {

    let started = 0
    let completionTokens = 0

    try {
      const settings = await getSettings()
      const opts = this.generationFor(conversation, settings, optionsOverride)
      const session = await this.ensureSession(conversation, userText)
      await this.setState('generating')
      if (controller.signal.aborted) throw new Error('Generation aborted.')

      started = Date.now()
      const responseText = await session.prompt(userText, {
        signal: controller.signal,
        stopOnAbortSignal: true,
        temperature: opts.temperature,
        topP: opts.topP,
        topK: opts.topK,
        minP: opts.minP,
        maxTokens: opts.maxTokens,
        seed: opts.seed,
        repeatPenalty: { penalty: opts.repeatPenalty },
        customStopTriggers: opts.stopSequences?.length ? opts.stopSequences : undefined,
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
        type: controller.signal.aborted ? 'aborted' : 'done',
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
      if (controller.signal.aborted) {
        const durationMs = Date.now() - started
        this.emitEvent({
          type: 'aborted',
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
      if (this.abort === controller) this.abort = null
      this.clearOperation(operation)
      if (!this.shutdownRequested) await this.setState(this.model ? 'ready' : 'idle')
      // Report the now-exact KV-cache fill so the renderer's meter is accurate.
      void this.emitUsage(conversation)
    }
    })
  }

  /** Map the neutral scene history (+ system) onto node-llama-cpp chat items. */
  private sceneHistory(system: string, turns: SceneTurn[]): NLC.ChatHistoryItem[] {
    const history: NLC.ChatHistoryItem[] = [{ type: 'system', text: system }]
    for (const t of turns) {
      if (t.role === 'user') history.push({ type: 'user', text: t.text })
      else history.push({ type: 'model', response: [t.text] })
    }
    return history
  }

  /**
   * Generate one beat of a self-roleplay scene: the next line spoken by the cast
   * persona `speakerId`. Unlike generate(), the active speaker (and therefore the
   * system prompt) changes every beat, so the shared session is always rebuilt
   * from the scene transcript via buildBeatPrompt — the renderer drives turn-taking
   * and autoplay; the engine just produces one beat at a time. Streams over the
   * same chat:event channel as generate().
   */
  async generateBeat(
    conversation: Conversation,
    speakerId: string,
    assistantMessageId: string,
    optionsOverride: Partial<GenerationOptions> | undefined
  ): Promise<void> {
    if (!this.model || !this.context || !this.session) {
      this.emitEvent({
        type: 'error',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        error: 'No model is loaded. Load a model first.'
      })
      return
    }
    if (this.activeOperation) {
      this.emitEvent({
        type: 'error',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        error: 'A response is already being generated. Wait for it to finish.'
      })
      return
    }
    const session = this.session

    const controller = new AbortController()
    const operation = this.operation(
      'scene-beat',
      { conversationId: conversation.id, messageId: assistantMessageId },
      controller
    )
    this.activeOperation = operation
    this.abort = controller
    return this.lifecycle.run(async () => {
    let started = 0
    let completionTokens = 0
    try {
      const settings = await getSettings()
      const cast = sceneCast(conversation, settings.personas)
      const speaker = findPersona(settings.personas, speakerId)
      if (!speaker) {
        this.emitEvent({
          type: 'error',
          conversationId: conversation.id,
          messageId: assistantMessageId,
          error: 'That character is no longer in your persona library.'
        })
        return
      }
      const opts = this.generationFor(conversation, settings, optionsOverride, speaker)
      const beat = buildBeatPrompt({
        // Honor compaction: feed only the un-folded tail; the summary rides in
        // the system turn below (older turns were condensed to save context).
        messages: this.liveMessages(conversation),
        speaker,
        cast,
        userCharacter: conversation.userCharacter,
        scenePremise: conversation.scenePremise
      })
      let system = beat.system
      const summary = conversation.compaction?.summary?.trim()
      if (summary) system += `\n\n${SUMMARY_PREFIX}${summary}`

      // The speaker changes every beat — always rebuild the session history.
      session.setChatHistory(this.sceneHistory(system, beat.history))
      this.sessionConversationId = null

      const stopTriggers = [...(opts.stopSequences ?? []), ...beat.stopTriggers].filter(Boolean)
      await this.setState('generating')
      if (controller.signal.aborted) throw new Error('Generation aborted.')

      started = Date.now()
      const responseText = await session.prompt(beat.prompt, {
        signal: controller.signal,
        stopOnAbortSignal: true,
        temperature: opts.temperature,
        topP: opts.topP,
        topK: opts.topK,
        minP: opts.minP,
        maxTokens: opts.maxTokens,
        seed: opts.seed,
        repeatPenalty: { penalty: opts.repeatPenalty },
        customStopTriggers: stopTriggers.length ? stopTriggers : undefined,
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
      try {
        if (this.model && responseText) completionTokens = this.model.tokenize(responseText).length
      } catch {
        /* keep chunk-based estimate */
      }
      this.emitEvent({
        type: controller.signal.aborted ? 'aborted' : 'done',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        stats: {
          // Prompt size from the exact KV fill (whole prompt incl. system),
          // not a full re-tokenize of the transcript every beat.
          promptTokens: Math.max(0, (this.sequence?.nextTokenIndex ?? 0) - completionTokens),
          completionTokens,
          durationMs,
          tokensPerSecond: durationMs > 0 ? (completionTokens / durationMs) * 1000 : 0,
          contextTokens: this.sequence?.nextTokenIndex
        }
      })
    } catch (err) {
      if (controller.signal.aborted) {
        const durationMs = Date.now() - started
        this.emitEvent({
          type: 'aborted',
          conversationId: conversation.id,
          messageId: assistantMessageId,
          stats: {
            promptTokens: Math.max(0, (this.sequence?.nextTokenIndex ?? 0) - completionTokens),
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
      if (this.abort === controller) this.abort = null
      // The session no longer matches any single conversation's history.
      this.sessionConversationId = null
      this.clearOperation(operation)
      if (!this.shutdownRequested) await this.setState(this.model ? 'ready' : 'idle')
      void this.emitUsage(conversation)
    }
    })
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

  abortGeneration(request: {
    conversationId: string
    messageId: string
    operationId?: string
  }): boolean {
    const operation = this.activeOperation
    if (
      !operation?.controller ||
      operation.conversationId !== request.conversationId ||
      operation.messageId !== request.messageId ||
      (request.operationId !== undefined && operation.id !== request.operationId)
    ) {
      return false
    }
    operation.controller.abort()
    return true
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
    // Scenes don't use the single-persona system prompt: each beat carries its
    // speaker's brief + the full roster + name-prefixing. Estimate from the actual
    // next-beat prompt so auto-compaction triggers before the window overflows.
    if (isScene(conversation)) {
      const cast = sceneCast(conversation, settings.personas)
      const speaker = findPersona(settings.personas, nextSpeakerId(conversation, settings.personas))
      if (speaker) {
        const beat = buildBeatPrompt({
          messages: this.liveMessages(conversation),
          speaker,
          cast,
          userCharacter: conversation.userCharacter,
          scenePremise: conversation.scenePremise
        })
        const summary = conversation.compaction?.summary?.trim()
        let total = this.tokenCount(beat.system) + (summary ? this.tokenCount(summary) : 0) + 8
        for (const t of beat.history) total += this.tokenCount(t.text) + 4
        total += this.tokenCount(beat.prompt) + 4
        return total
      }
    }
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
    const reserve = conversation
      ? this.generationFor(conversation, settings, undefined).maxTokens
      : settings.generation.maxTokens
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
    const session = this.session
    if (this.activeOperation) throw new Error('Cannot compact while another operation is in progress.')
    const controller = new AbortController()
    const operation = this.operation('compact', { conversationId: conversation.id }, controller)
    this.activeOperation = operation
    this.abort = controller
    return this.lifecycle.run(async () => {
    try {
      const settings = await getSettings()
      const maxKeep = Math.max(0, settings.context.keepRecentMessages)

      const live = this.liveMessages(conversation).filter(
        (m) => m.role !== 'system' && m.content.trim()
      )
      // Token-budget the kept-recent tail: when the recent messages are large,
      // keep fewer than `maxKeep` so compaction actually frees space (a fixed
      // count can leave the window full). Falls back to the count when the
      // context size isn't known yet.
      const contextSize = this.contextSize ?? 0
      const keep =
        contextSize > 0
          ? keepRecentCount(
              [...live].reverse().map((m) => this.tokenCount(m.content) + 4),
              maxKeep,
              Math.round(contextSize * settings.context.keepRecentFraction)
            )
          : maxKeep
      const foldCount = live.length - keep
      if (foldCount <= 0) {
        throw new Error('Not enough conversation history to compact yet.')
      }
      const toFold = live.slice(0, foldCount)
      const throughMessageId = toFold[toFold.length - 1].id

      const priorSummary = conversation.compaction?.summary?.trim()
      // Preserve scene attribution: fold beats under their speaker's name and
      // director notes under "Director", so the summary doesn't collapse a cast
      // into one voice (it rides in every later beat's system prompt).
      const foldLabel = (m: ChatMessage): string =>
        m.director ? 'Director' : m.role === 'user' ? 'User' : m.speakerName?.trim() || 'Assistant'
      const transcript = toFold.map((m) => `${foldLabel(m)}: ${m.content.trim()}`).join('\n\n')
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
      await this.setState('generating')
      let summary = ''
      try {
        session.setChatHistory([
          { type: 'system', text: 'You are a precise conversation summarizer.' }
        ])
        const out = await session.prompt(instruction, {
          signal: controller.signal,
          stopOnAbortSignal: true,
          temperature: 0.3,
          // Scale the summary budget to the window so a large context isn't
          // stuck with a tiny (fixed-600) summary that loses detail every pass.
          maxTokens: summaryBudgetTokens(contextSize, settings.context.summaryTokenFraction)
        })
        if (controller.signal.aborted) throw new Error('Compaction cancelled.')
        summary = out.trim()
        if (!summary) throw new Error('Summarization produced no output.')
      } catch (err) {
        await this.restoreSession(conversation)
        throw err
      } finally {
        if (this.abort === controller) this.abort = null
        this.clearOperation(operation)
        if (!this.shutdownRequested) await this.setState(this.model ? 'ready' : 'idle')
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
      this.clearOperation(operation)
    }
    })
  }

  private emitEvent(event: GenerationEvent): void {
    this.emit('event', event)
  }
}

export const engine = new InferenceEngine()

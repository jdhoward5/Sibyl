// Pure state machine for bounded scene autoplay. This module deliberately keeps
// no transcript text: output health is represented by non-reversible hashes held
// only in renderer memory for the lifetime of a run.
import {
  DIRECTOR_MAX_COMPLETION_TOKENS,
  DIRECTOR_MAX_PROMPT_TOKENS
} from './sceneDirector'

export const DEFAULT_SCENE_RUN_BEATS = 6
export const DEFAULT_SCENE_RUN_DELAY_MS = 1_500
export const DEFAULT_SCENE_RUN_DURATION_MS = 10 * 60 * 1_000
export const MAX_CONSECUTIVE_UNHEALTHY_OUTPUTS = 2
export const DIRECTOR_TOKEN_BUDGET_PER_BEAT =
  DIRECTOR_MAX_PROMPT_TOKENS + DIRECTOR_MAX_COMPLETION_TOKENS

export type SceneRunStatus = 'running' | 'paused' | 'narration-error' | 'stopped'
export type SceneRunStopReason =
  | 'completed'
  | 'manual-pause'
  | 'manual-stop'
  | 'narration-error'
  | 'unhealthy-output'
  | 'context-compaction'
  | 'memory-maintenance'
  | 'natural-pause'
  | 'natural-end'
  | 'deadline'
  | 'token-budget'
  | 'resource-unavailable'

export type SceneNarrationState = 'none' | 'pending' | 'playing' | 'error'

export interface SceneOutputSignature {
  fingerprint: number
  featureHashes: number[]
  wordCount: number
}

export interface SceneRunState {
  convId: string
  status: SceneRunStatus
  stopReason?: SceneRunStopReason
  requestedBeats: number
  remainingBeats: number
  completedBeats: number
  delayMs: number
  startedAt: number
  deadlineAt: number
  completionTokenBudget: number
  completionTokensUsed: number
  directorTokensUsed: number
  directorTokenBudget: number
  directorDurationMs: number
  maxTokensPerBeat: number
  consecutiveUnhealthy: number
  lastOutput?: SceneOutputSignature
  pauseAfterCurrent: boolean
  muted: boolean
  narration: SceneNarrationState
  narrationMessageId?: string
  narrationError?: string
  statusBeforeNarrationError?: Exclude<SceneRunStatus, 'narration-error'>
  stopReasonBeforeNarrationError?: SceneRunStopReason
  /** Renderer operation currently owned by this run; never persisted. */
  activeOperationId?: string
  /** Ephemeral; never copied into a Conversation or persisted. */
  lastDirectorIntent?: string
  lastDirectorFallback?: string
}

export interface SceneAttempt {
  text?: string
  failed?: boolean
  completionTokens?: number
  now: number
}

export interface SceneAttemptResult {
  run: SceneRunState
  unhealthy: boolean
  nearDuplicate: boolean
}

function hashText(value: string): number {
  // FNV-1a, suitable for ephemeral duplicate detection (not cryptographic use).
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function sceneOutputSignature(text: string): SceneOutputSignature | undefined {
  const words = text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)
  if (!words?.length) return undefined
  const features = words.length === 1 ? words : words.slice(0, -1).map((word, i) => `${word}\u0000${words[i + 1]}`)
  return {
    fingerprint: hashText(words.join('\u0000')),
    featureHashes: [...new Set(features.map(hashText))].sort((a, b) => a - b),
    wordCount: words.length
  }
}

export function sceneOutputsAreNearDuplicates(
  previous: SceneOutputSignature | undefined,
  current: SceneOutputSignature | undefined
): boolean {
  if (!previous || !current) return false
  if (previous.fingerprint === current.fingerprint) return true
  const ratio =
    Math.min(previous.wordCount, current.wordCount) /
    Math.max(previous.wordCount, current.wordCount)
  if (ratio < 0.75) return false
  const a = new Set(previous.featureHashes)
  const b = new Set(current.featureHashes)
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  const union = a.size + b.size - intersection
  return union > 0 && intersection / union >= 0.82
}

export function createSceneRun(params: {
  convId: string
  now: number
  maxTokensPerBeat: number
  muted?: boolean
  beats?: number
}): SceneRunState {
  const beats = Math.max(1, Math.floor(params.beats ?? DEFAULT_SCENE_RUN_BEATS))
  const maxTokensPerBeat = Math.max(1, Math.floor(params.maxTokensPerBeat))
  return {
    convId: params.convId,
    status: 'running',
    requestedBeats: beats,
    remainingBeats: beats,
    completedBeats: 0,
    delayMs: DEFAULT_SCENE_RUN_DELAY_MS,
    startedAt: params.now,
    deadlineAt: params.now + DEFAULT_SCENE_RUN_DURATION_MS,
    completionTokenBudget: beats * maxTokensPerBeat,
    completionTokensUsed: 0,
    directorTokensUsed: 0,
    directorTokenBudget: beats * DIRECTOR_TOKEN_BUDGET_PER_BEAT,
    directorDurationMs: 0,
    maxTokensPerBeat,
    consecutiveUnhealthy: 0,
    pauseAfterCurrent: false,
    muted: Boolean(params.muted),
    narration: 'none'
  }
}

export function sceneRunPreflight(run: SceneRunState, now: number): SceneRunState {
  if (run.status !== 'running') return run
  if (run.remainingBeats <= 0) return stopSceneRun(run, 'completed')
  if (
    run.completionTokensUsed >= run.completionTokenBudget ||
    run.directorTokensUsed >= run.directorTokenBudget
  ) {
    return stopSceneRun(run, 'token-budget')
  }
  if (now >= run.deadlineAt) return stopSceneRun(run, 'deadline')
  return run
}

export function recordSceneAttempt(
  run: SceneRunState,
  attempt: SceneAttempt
): SceneAttemptResult {
  const signature = attempt.failed ? undefined : sceneOutputSignature(attempt.text ?? '')
  const nearDuplicate = sceneOutputsAreNearDuplicates(run.lastOutput, signature)
  const unhealthy = Boolean(attempt.failed || !signature || nearDuplicate)
  let next: SceneRunState = {
    ...run,
    remainingBeats: Math.max(0, run.remainingBeats - 1),
    completedBeats: run.completedBeats + 1,
    completionTokensUsed:
      run.completionTokensUsed + Math.max(0, Math.floor(attempt.completionTokens ?? 0)),
    consecutiveUnhealthy: unhealthy ? run.consecutiveUnhealthy + 1 : 0,
    lastOutput: signature ?? run.lastOutput,
    narration: 'none',
    narrationMessageId: undefined,
    narrationError: undefined
  }
  if (next.consecutiveUnhealthy >= MAX_CONSECUTIVE_UNHEALTHY_OUTPUTS) {
    next = stopSceneRun(next, 'unhealthy-output')
  } else {
    next = sceneRunPreflight(next, attempt.now)
    if (next.status === 'running' && next.pauseAfterCurrent) next = pauseSceneRun(next)
  }
  return { run: next, unhealthy, nearDuplicate }
}

export function pauseSceneRun(run: SceneRunState): SceneRunState {
  return {
    ...run,
    status: 'paused',
    stopReason: 'manual-pause',
    pauseAfterCurrent: false
  }
}

export function requestSceneRunPause(run: SceneRunState, busy: boolean): SceneRunState {
  return busy
    ? { ...run, pauseAfterCurrent: true, stopReason: 'manual-pause' }
    : pauseSceneRun(run)
}

export function stopSceneRun(
  run: SceneRunState,
  stopReason: SceneRunStopReason
): SceneRunState {
  return {
    ...run,
    status: stopReason === 'narration-error' ? 'narration-error' : 'stopped',
    stopReason,
    pauseAfterCurrent: false
  }
}

export function resumeSceneRun(run: SceneRunState, now: number): SceneRunState {
  return sceneRunPreflight(
    {
      ...run,
      status: 'running',
      stopReason: undefined,
      pauseAfterCurrent: false,
      deadlineAt: now + DEFAULT_SCENE_RUN_DURATION_MS,
      narrationError: undefined
    },
    now
  )
}

export function continueSceneRun(
  run: SceneRunState,
  now: number,
  maxTokensPerBeat = run.maxTokensPerBeat
): SceneRunState {
  const nextMaxTokensPerBeat = Math.max(1, Math.floor(maxTokensPerBeat))
  return {
    ...run,
    status: 'running',
    stopReason: undefined,
    pauseAfterCurrent: false,
    deadlineAt: now + DEFAULT_SCENE_RUN_DURATION_MS,
    requestedBeats: run.requestedBeats + DEFAULT_SCENE_RUN_BEATS,
    remainingBeats: run.remainingBeats + DEFAULT_SCENE_RUN_BEATS,
    completionTokenBudget:
      run.completionTokenBudget + DEFAULT_SCENE_RUN_BEATS * nextMaxTokensPerBeat,
    directorTokenBudget:
      run.directorTokenBudget + DEFAULT_SCENE_RUN_BEATS * DIRECTOR_TOKEN_BUDGET_PER_BEAT,
    maxTokensPerBeat: nextMaxTokensPerBeat,
    consecutiveUnhealthy: 0,
    narration: 'none',
    narrationMessageId: undefined,
    narrationError: undefined,
    statusBeforeNarrationError: undefined,
    stopReasonBeforeNarrationError: undefined
  }
}

export function setSceneNarration(
  run: SceneRunState,
  narration: SceneNarrationState,
  messageId?: string,
  error?: string
): SceneRunState {
  if (narration === 'error') {
    return {
      ...stopSceneRun(run, 'narration-error'),
      narration,
      narrationMessageId: messageId ?? run.narrationMessageId,
      narrationError: error,
      statusBeforeNarrationError:
        run.status === 'narration-error'
          ? (run.statusBeforeNarrationError ?? 'running')
          : run.status,
      stopReasonBeforeNarrationError:
        run.status === 'narration-error'
          ? run.stopReasonBeforeNarrationError
          : run.stopReason
    }
  }
  return {
    ...run,
    narration,
    narrationMessageId: narration === 'none' ? undefined : (messageId ?? run.narrationMessageId),
    narrationError: undefined,
    statusBeforeNarrationError:
      narration === 'none' ? undefined : run.statusBeforeNarrationError,
    stopReasonBeforeNarrationError:
      narration === 'none' ? undefined : run.stopReasonBeforeNarrationError
  }
}

export function recoverSceneNarration(
  run: SceneRunState,
  mode: 'retry' | 'continue-muted'
): SceneRunState {
  const status = run.statusBeforeNarrationError ?? 'running'
  return {
    ...run,
    status,
    stopReason: status === 'stopped' ? run.stopReasonBeforeNarrationError : undefined,
    muted: mode === 'continue-muted' ? true : run.muted,
    narration: mode === 'retry' ? 'pending' : 'none',
    narrationError: undefined,
    narrationMessageId: mode === 'retry' ? run.narrationMessageId : undefined,
    statusBeforeNarrationError: undefined,
    stopReasonBeforeNarrationError: undefined
  }
}

export function sceneRunStopLabel(reason: SceneRunStopReason | undefined): string {
  switch (reason) {
    case 'completed':
      return 'Six-beat run complete'
    case 'manual-pause':
      return 'Paused'
    case 'manual-stop':
      return 'Stopped'
    case 'narration-error':
      return 'Narration needs attention'
    case 'unhealthy-output':
      return 'Stopped after repeated empty, failed, or duplicate beats'
    case 'context-compaction':
      return 'Paused after context compaction'
    case 'memory-maintenance':
      return 'Paused after continuity-memory maintenance'
    case 'natural-pause':
      return 'The director paused for human input'
    case 'natural-end':
      return 'The scene reached a natural ending'
    case 'deadline':
      return 'Elapsed-time budget reached'
    case 'token-budget':
      return 'Completion-token budget reached'
    case 'resource-unavailable':
      return 'A required model or character is unavailable'
    default:
      return ''
  }
}

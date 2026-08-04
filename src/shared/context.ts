// Pure helpers for context-window accounting and presentation.
// No runtime deps so it is safe in the renderer and unit-testable.

import type { ContextLevel, ContextUsage } from './types'

function finiteInRange(value: number, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback))
}

/** True only when a usage response still belongs to the requested, visible thread. */
export function contextUsageIsCurrent(
  usage: Pick<ContextUsage, 'conversationId'> | null | undefined,
  requestedConversationId: string | null,
  activeConversationId: string | null
): boolean {
  return (
    requestedConversationId === activeConversationId &&
    usage?.conversationId === requestedConversationId
  )
}

/**
 * Classify how full the context window is. `warn` and `critical` are fractions
 * (0..1); `critical` is where auto-compaction kicks in and should be >= `warn`.
 */
export function contextLevel(fraction: number, warn: number, critical: number): ContextLevel {
  if (!Number.isFinite(fraction)) return 'ok'
  if (fraction >= critical) return 'critical'
  if (fraction >= warn) return 'warn'
  return 'ok'
}

/**
 * Cheap, dependency-free token estimate for live UI (e.g. the composer counter).
 * Approximates ~4 chars/token — the same fallback the engine uses when the real
 * tokenizer is unavailable. Not exact; prefix displays with "~".
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Compact a token count to a short label, e.g. 950 → "950", 8400 → "8.4K". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const r = Math.round(n)
  if (r < 1000) return String(r)
  const k = r / 1000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`
}

/** Whole-percent fill for a 0..1 fraction, clamped to 0..100. */
export function contextPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0
  return Math.min(100, Math.round(fraction * 100))
}

/**
 * Token budget for a folded-history summary, scaled to the window so a large
 * context doesn't get stuck with a tiny summary (the old behaviour was a fixed
 * 600). `fraction` of `contextSize`, clamped to a sane floor/ceiling. Falls back
 * to 600 when the context size is unknown.
 */
export function summaryBudgetTokens(contextSize: number, fraction: number): number {
  if (!Number.isFinite(contextSize) || contextSize <= 0) return 600
  const f = Number.isFinite(fraction) && fraction > 0 ? fraction : 0.06
  return Math.min(2000, Math.max(256, Math.round(contextSize * f)))
}

/**
 * Reserve a realistic next response rather than the configured worst-case on
 * every turn. The configured value remains a hard ceiling; recent p90 output is
 * padded for variance and a context-scaled floor protects new conversations.
 */
export function adaptiveResponseReserve(
  recentCompletionTokens: readonly number[],
  configuredMaxTokens: number,
  contextSize: number
): number {
  const ceiling = Math.floor(
    finiteInRange(configuredMaxTokens, 1, 1, Number.MAX_SAFE_INTEGER)
  )
  const contextFloor = Number.isFinite(contextSize) && contextSize > 0
    ? Math.round(contextSize * 0.1)
    : 512
  const floor = Math.min(ceiling, Math.max(256, Math.min(768, contextFloor)))
  const samples = recentCompletionTokens
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value))
    .sort((a, b) => a - b)
  if (!samples.length) return floor
  const p90 = samples[Math.max(0, Math.ceil(samples.length * 0.9) - 1)]
  return Math.min(ceiling, Math.max(floor, Math.ceil(p90 * 1.35 + 64)))
}

/** Keep a real low-water gap below the high-water compaction trigger. */
export function normalizeCompactionTarget(target: number, threshold: number): number {
  const highWater = finiteInRange(threshold, 0.85, 0.1, 0.99)
  return finiteInRange(target, 0.5, 0.1, Math.max(0.1, highWater - 0.05))
}

export interface CompactionTailBudgetParams {
  contextSize: number
  compactThreshold: number
  compactTargetFraction: number
  compactRunwayTurns: number
  expectedTurnTokens: number
  fixedPromptTokens: number
  summaryTokens: number
  maxTailFraction: number
}

/**
 * Token budget for the verbatim tail after compaction. This creates hysteresis:
 * occupancy is driven to a low-water target and, for unusually long replies,
 * lower still so the configured number of future turns fit below the trigger.
 */
export function compactionTailBudget(params: CompactionTailBudgetParams): number {
  if (!Number.isFinite(params.contextSize) || params.contextSize <= 0) return 0
  const contextSize = Math.floor(params.contextSize)
  const threshold = finiteInRange(params.compactThreshold, 0.85, 0.1, 0.99)
  const target = normalizeCompactionTarget(params.compactTargetFraction, threshold)
  const runwayTurns = Math.floor(
    finiteInRange(params.compactRunwayTurns, 3, 1, Number.MAX_SAFE_INTEGER)
  )
  const expectedTurnTokens = Math.floor(
    finiteInRange(params.expectedTurnTokens, 1, 1, Number.MAX_SAFE_INTEGER)
  )
  const lowWater = Math.round(contextSize * target)
  const runwayLowWater =
    Math.round(contextSize * threshold) - runwayTurns * expectedTurnTokens
  const postCompactTarget = Math.max(0, Math.min(lowWater, runwayLowWater))
  const fixedPromptTokens = Math.floor(
    finiteInRange(params.fixedPromptTokens, 0, 0, Number.MAX_SAFE_INTEGER)
  )
  const summaryTokens = Math.floor(
    finiteInRange(params.summaryTokens, 0, 0, Number.MAX_SAFE_INTEGER)
  )
  const available = Math.max(
    0,
    postCompactTarget - fixedPromptTokens - summaryTokens
  )
  const maxTailFraction = finiteInRange(params.maxTailFraction, 0, 0, 0.9)
  const tailCap = Math.max(0, Math.round(contextSize * maxTailFraction))
  return Math.min(available, tailCap)
}

/**
 * How many of the most recent messages to keep verbatim during compaction.
 * Keeps up to `maxKeep` (the user's keepRecentMessages), but folds more when the
 * recent tail is large so the post-compaction live tail fits `keepBudgetTokens` —
 * a fixed count alone can't guarantee compaction frees enough. Always keeps at
 * least `minKeep` (even if they exceed the budget, so there's some live context;
 * the caller's fit check then warns). `recentTokens` is newest-first.
 */
export function keepRecentCount(
  recentTokens: number[],
  maxKeep: number,
  keepBudgetTokens: number,
  minKeep = 2
): number {
  const cap = Math.max(0, Math.floor(maxKeep))
  const floor = Math.min(Math.max(0, Math.floor(minKeep)), cap)
  let total = 0
  let keep = 0
  for (const t of recentTokens) {
    if (keep >= cap) break
    const next = total + (t > 0 ? t : 0)
    if (keep >= floor && next > keepBudgetTokens) break
    total = next
    keep++
  }
  return keep
}

/** Tailwind text/bg accent class per severity, for consistent meter colours. */
export function levelColor(level: ContextLevel): { text: string; bar: string } {
  switch (level) {
    case 'critical':
      return { text: 'text-rose-400', bar: 'bg-rose-500' }
    case 'warn':
      return { text: 'text-amber-400', bar: 'bg-amber-500' }
    default:
      return { text: 'text-sibyl-muted', bar: 'bg-sibyl-accent' }
  }
}

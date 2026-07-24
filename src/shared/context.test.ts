import { describe, it, expect } from 'vitest'
import {
  contextLevel,
  contextPercent,
  contextUsageIsCurrent,
  estimateTokens,
  formatTokens,
  keepRecentCount,
  levelColor,
  summaryBudgetTokens
} from './context'

describe('contextUsageIsCurrent', () => {
  it('rejects late or mismatched conversation snapshots', () => {
    expect(contextUsageIsCurrent({ conversationId: 'conv-1' }, 'conv-1', 'conv-1')).toBe(true)
    expect(contextUsageIsCurrent({ conversationId: 'conv-1' }, 'conv-1', 'conv-2')).toBe(false)
    expect(contextUsageIsCurrent({ conversationId: 'conv-2' }, 'conv-1', 'conv-1')).toBe(false)
    expect(contextUsageIsCurrent(null, 'conv-1', 'conv-1')).toBe(false)
  })
})

describe('contextLevel', () => {
  it('classifies against thresholds', () => {
    expect(contextLevel(0.1, 0.7, 0.85)).toBe('ok')
    expect(contextLevel(0.7, 0.7, 0.85)).toBe('warn')
    expect(contextLevel(0.8, 0.7, 0.85)).toBe('warn')
    expect(contextLevel(0.85, 0.7, 0.85)).toBe('critical')
    expect(contextLevel(1.2, 0.7, 0.85)).toBe('critical')
  })
  it('is safe for non-finite input', () => {
    expect(contextLevel(NaN, 0.7, 0.85)).toBe('ok')
  })
})

describe('formatTokens', () => {
  it('handles zero and negatives', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-10)).toBe('0')
  })
  it('formats below and above 1K', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(8400)).toBe('8.4K')
    expect(formatTokens(32768)).toBe('33K')
  })
})

describe('contextPercent', () => {
  it('rounds and clamps', () => {
    expect(contextPercent(0)).toBe(0)
    expect(contextPercent(0.5)).toBe(50)
    expect(contextPercent(0.754)).toBe(75)
    expect(contextPercent(1.5)).toBe(100)
    expect(contextPercent(NaN)).toBe(0)
  })
})

describe('estimateTokens', () => {
  it('is zero for empty input', () => {
    expect(estimateTokens('')).toBe(0)
  })
  it('approximates ~4 chars per token (rounding up)', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})

describe('summaryBudgetTokens', () => {
  it('scales with the window, clamped to [256, 2000]', () => {
    expect(summaryBudgetTokens(8192, 0.06)).toBe(492)
    expect(summaryBudgetTokens(32768, 0.06)).toBe(1966)
    expect(summaryBudgetTokens(131072, 0.06)).toBe(2000) // ceiling
    expect(summaryBudgetTokens(1024, 0.06)).toBe(256) // floor
  })
  it('falls back to 600 when the context size is unknown', () => {
    expect(summaryBudgetTokens(0, 0.06)).toBe(600)
    expect(summaryBudgetTokens(NaN, 0.06)).toBe(600)
  })
  it('defaults the fraction when given a bad one', () => {
    expect(summaryBudgetTokens(8192, 0)).toBe(492)
    expect(summaryBudgetTokens(8192, NaN)).toBe(492)
  })
})

describe('keepRecentCount', () => {
  it('keeps up to maxKeep when the tail fits the budget', () => {
    expect(keepRecentCount([50, 50, 50, 50, 50, 50, 50, 50], 6, 2000)).toBe(6)
  })
  it('folds more (keeps fewer) when recent messages are large', () => {
    // newest-first; budget 2867 ~ 8192 * 0.35
    expect(keepRecentCount([1000, 1000, 1000, 1000, 1000], 6, 2867)).toBe(2)
  })
  it('always keeps at least minKeep even over budget (caller warns)', () => {
    expect(keepRecentCount([2000, 2000, 2000], 6, 500)).toBe(2)
    expect(keepRecentCount([2000, 2000, 2000], 6, 500, 1)).toBe(1)
  })
  it('never keeps more than maxKeep, and handles maxKeep below minKeep', () => {
    expect(keepRecentCount([10, 10, 10, 10], 3, 100000)).toBe(3)
    expect(keepRecentCount([5000, 5000], 1, 10)).toBe(1) // floor clamped to cap
    expect(keepRecentCount([10, 10], 0, 100000)).toBe(0)
  })
})

describe('levelColor', () => {
  it('returns a class per level', () => {
    expect(levelColor('ok').bar).toContain('accent')
    expect(levelColor('warn').bar).toContain('amber')
    expect(levelColor('critical').bar).toContain('rose')
  })
})

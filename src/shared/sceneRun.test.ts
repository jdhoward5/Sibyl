import { describe, expect, it } from 'vitest'
import {
  continueSceneRun,
  createSceneRun,
  pauseSceneRun,
  recordSceneAttempt,
  recoverSceneNarration,
  requestSceneRunPause,
  resumeSceneRun,
  sceneOutputSignature,
  sceneOutputsAreNearDuplicates,
  sceneRunPreflight,
  setSceneNarration
} from './sceneRun'

describe('scene run state machine', () => {
  const make = () => createSceneRun({ convId: 'scene', now: 1_000, maxTokensPerBeat: 100 })

  it('starts a six-beat run with explicit time and completion-token budgets', () => {
    const run = make()
    expect(run).toMatchObject({
      status: 'running',
      requestedBeats: 6,
      remainingBeats: 6,
      completionTokenBudget: 600,
      completionTokensUsed: 0,
      delayMs: 1_500
    })
    expect(run.deadlineAt).toBeGreaterThan(run.startedAt)
  })

  it('finishes after exactly six attempts and never advances past the budget', () => {
    let run = make()
    for (let i = 0; i < 6; i += 1) {
      run = recordSceneAttempt(run, {
        text: `Distinct healthy scene beat number ${i} with enough changing words.`,
        completionTokens: 10,
        now: 2_000 + i
      }).run
    }
    expect(run.remainingBeats).toBe(0)
    expect(run.completedBeats).toBe(6)
    expect(run.status).toBe('stopped')
    expect(run.stopReason).toBe('completed')
    expect(sceneRunPreflight(run, 9_999)).toBe(run)
  })

  it('stops after two consecutive empty or failed attempts', () => {
    let run = recordSceneAttempt(make(), { text: '   ', now: 2_000 }).run
    expect(run.status).toBe('running')
    run = recordSceneAttempt(run, { failed: true, now: 3_000 }).run
    expect(run.status).toBe('stopped')
    expect(run.stopReason).toBe('unhealthy-output')
  })

  it('detects exact and near-duplicate outputs without retaining their text', () => {
    const first = sceneOutputSignature('Ada crosses the quiet bridge and watches the river below.')
    const second = sceneOutputSignature('Ada crosses the quiet bridge and watches the river below!')
    const changed = sceneOutputSignature('Bo turns toward the airship and signals the waiting crew.')
    expect(sceneOutputsAreNearDuplicates(first, second)).toBe(true)
    expect(sceneOutputsAreNearDuplicates(first, changed)).toBe(false)
    expect(first).not.toHaveProperty('text')

    let run = recordSceneAttempt(make(), {
      text: 'Ada crosses the quiet bridge and watches the river below.',
      now: 2_000
    }).run
    run = recordSceneAttempt(run, {
      text: 'Ada crosses the quiet bridge and watches the river below!',
      now: 3_000
    }).run
    expect(run.consecutiveUnhealthy).toBe(1)
  })

  it('honors pause-after-current and resumes the remaining run', () => {
    let run = requestSceneRunPause(make(), true)
    expect(run.pauseAfterCurrent).toBe(true)
    run = recordSceneAttempt(run, { text: 'A complete and healthy scene beat.', now: 2_000 }).run
    expect(run.status).toBe('paused')
    expect(run.remainingBeats).toBe(5)
    run = resumeSceneRun(run, 3_000)
    expect(run.status).toBe('running')
    expect(run.remainingBeats).toBe(5)
    expect(pauseSceneRun(run).status).toBe('paused')
  })

  it('stops at deadline and token budgets and can intentionally add six beats', () => {
    const original = make()
    expect(sceneRunPreflight(original, original.deadlineAt).stopReason).toBe('deadline')
    const tokenLimited = sceneRunPreflight(
      { ...original, completionTokensUsed: original.completionTokenBudget },
      2_000
    )
    expect(tokenLimited.stopReason).toBe('token-budget')

    const continued = continueSceneRun(
      { ...original, status: 'stopped', stopReason: 'completed', remainingBeats: 0 },
      5_000
    )
    expect(continued.status).toBe('running')
    expect(continued.remainingBeats).toBe(6)
    expect(continued.requestedBeats).toBe(12)
    expect(continued.completionTokenBudget).toBe(1_200)
  })

  it('tracks narration pending, playback, terminal success, and recoverable error', () => {
    let run = setSceneNarration(make(), 'pending', 'message-1')
    expect(run.narration).toBe('pending')
    run = setSceneNarration(run, 'playing')
    expect(run.narration).toBe('playing')
    run = setSceneNarration(run, 'error', undefined, 'voice failed')
    expect(run).toMatchObject({
      status: 'narration-error',
      stopReason: 'narration-error',
      narration: 'error',
      narrationMessageId: 'message-1',
      narrationError: 'voice failed'
    })
    run = recoverSceneNarration(run, 'retry')
    expect(run).toMatchObject({
      status: 'running',
      narration: 'pending',
      narrationMessageId: 'message-1'
    })
  })
})

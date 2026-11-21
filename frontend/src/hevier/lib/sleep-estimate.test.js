import { describe, it, expect } from 'vitest'
import {
  circularDiffMin,
  circularMeanMin,
  extractScreenOffGaps,
  baselineFromHistory,
  trimWithSteps,
  estimateSleepByDay,
} from './sleep-estimate.js'

const at = (iso, hh, mm = 0, ss = 0) => new Date(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`).getTime()

describe('circular clock math', () => {
  it('wraps midnight differences to (-720, 720]', () => {
    expect(circularDiffMin(30, 1410)).toBe(60)
    expect(circularDiffMin(1410, 30)).toBe(-60)
    expect(circularDiffMin(720, 0)).toBe(720)
    expect(circularDiffMin(1440, 0)).toBe(0)
  })

  it('computes circular mean across midnight', () => {
    expect(circularMeanMin([1410, 30])).toBeCloseTo(0, 5)
    expect(circularMeanMin([1380, 0])).toBeCloseTo(1410, 5)
    expect(circularMeanMin([])).toBe(null)
  })
})

describe('extractScreenOffGaps', () => {
  it('bridges brief lock-screen notification wake-ups (<= 90 s without unlock)', () => {
    const events = [
      { t: at('2026-11-20', 23, 30), type: 'screen_off' },
      { t: at('2026-11-21', 2, 0, 0), type: 'screen_on' },
      { t: at('2026-11-21', 2, 0, 45), type: 'screen_off' },
      { t: at('2026-11-21', 7, 15), type: 'screen_on' },
      { t: at('2026-11-21', 7, 15, 2), type: 'unlock' },
    ]
    expect(extractScreenOffGaps(events)).toEqual([
      { start: at('2026-11-20', 23, 30), end: at('2026-11-21', 7, 15) },
    ])
  })

  it('splits the night when the user actually unlocks in the middle of the night', () => {
    const events = [
      { t: at('2026-11-20', 23, 0), type: 'screen_off' },
      { t: at('2026-11-21', 2, 0), type: 'screen_on' },
      { t: at('2026-11-21', 2, 0, 5), type: 'unlock' },
      { t: at('2026-11-21', 2, 20), type: 'screen_off' },
      { t: at('2026-11-21', 7, 0), type: 'unlock' },
    ]
    expect(extractScreenOffGaps(events)).toEqual([
      { start: at('2026-11-20', 23, 0), end: at('2026-11-21', 2, 0) },
      { start: at('2026-11-21', 2, 20), end: at('2026-11-21', 7, 0) },
    ])
  })

  it('closes gap at sustained screen_on (> 90 s) even without unlock', () => {
    const events = [
      { t: at('2026-11-20', 23, 0), type: 'screen_off' },
      { t: at('2026-11-21', 2, 0, 0), type: 'screen_on' },
      { t: at('2026-11-21', 2, 3, 0), type: 'screen_off' },
      { t: at('2026-11-21', 7, 0, 0), type: 'unlock' },
    ]
    expect(extractScreenOffGaps(events)).toEqual([
      { start: at('2026-11-20', 23, 0), end: at('2026-11-21', 2, 0) },
      { start: at('2026-11-21', 2, 3), end: at('2026-11-21', 7, 0) },
    ])
  })
})

describe('baselineFromHistory', () => {
  it('falls back to 00:00-06:00 when empty', () => {
    expect(baselineFromHistory([], '2026-11-21')).toEqual({ bedMin: 0, wakeMin: 360, count: 0 })
  })

  it('uses last 7 days only and widens windows narrower than 4 h', () => {
    const entries = [
      { start: at('2026-11-10', 22, 0), end: at('2026-11-11', 7, 0) }, // outside 7d before Nov 21
      { start: at('2026-11-18', 2, 0), end: at('2026-11-18', 4, 0) },  // 2 h span -> widened to +-2 h around 03:00 (01:00..05:00)
    ]
    const b = baselineFromHistory(entries, '2026-11-21')
    expect(b.count).toBe(1)
    expect(b.bedMin).toBeCloseTo(60, 5)
    expect(b.wakeMin).toBeCloseTo(300, 5)
  })
})

describe('trimWithSteps', () => {
  it('trims bedtime forward on >= 50 cumulative steps within 3 h', () => {
    const bed = at('2026-11-20', 23, 0)
    const wake = at('2026-11-21', 7, 0)
    const steps = [
      { t: at('2026-11-20', 23, 2), steps: 30 },
      { t: at('2026-11-20', 23, 4), steps: 25 },
      { t: at('2026-11-21', 1, 30), steps: 8 }, // small jitter ignored
    ]
    const res = trimWithSteps(bed, wake, steps)
    expect(res.start).toBe(at('2026-11-20', 23, 5))
    expect(res.end).toBe(wake)
  })

  it('trims wake-up backward on 3 active minutes (>= 10 steps each within 10-min gaps)', () => {
    const bed = at('2026-11-20', 23, 0)
    const wake = at('2026-11-21', 7, 0)
    const steps = [
      { t: at('2026-11-21', 6, 30), steps: 10 },
      { t: at('2026-11-21', 6, 35), steps: 11 },
      { t: at('2026-11-21', 6, 40), steps: 12 }, // sum 33 < 50, but 3 active mins within 10-min gaps!
    ]
    const res = trimWithSteps(bed, wake, steps)
    expect(res.start).toBe(bed)
    expect(res.end).toBe(at('2026-11-21', 6, 30))
  })
})

describe('estimateSleepByDay', () => {
  const now = at('2026-11-21', 12, 0)

  it('estimates overnight sleep within 3-12 h and assigns to morning local date', () => {
    const events = [
      { t: at('2026-11-20', 23, 30), type: 'screen_off' },
      { t: at('2026-11-21', 7, 0), type: 'unlock' },
    ]
    const res = estimateSleepByDay({ events, today: '2026-11-21', now })
    expect(res['2026-11-21']).toEqual({
      start: at('2026-11-20', 23, 30),
      end: at('2026-11-21', 7, 0),
      sleepMin: 450,
      source: 'estimated',
    })
  })

  it('rejects < 3 h, > 12 h, and afternoon naps ending >= 15:00', () => {
    const events = [
      // Too short (2 h)
      { t: at('2026-11-19', 1, 0), type: 'screen_off' },
      { t: at('2026-11-19', 3, 0), type: 'unlock' },
      // Afternoon nap ending 16:30 (4 h duration)
      { t: at('2026-11-19', 12, 30), type: 'screen_off' },
      { t: at('2026-11-19', 16, 30), type: 'unlock' },
      // Too long (13 h)
      { t: at('2026-11-19', 20, 0), type: 'screen_off' },
      { t: at('2026-11-20', 9, 0), type: 'unlock' },
    ]
    expect(estimateSleepByDay({ events, today: '2026-11-21', now })).toEqual({})
  })

  it('never overwrites real Health Connect sleep for a day', () => {
    const events = [
      { t: at('2026-11-19', 23, 0), type: 'screen_off' },
      { t: at('2026-11-20', 7, 0), type: 'unlock' },
      { t: at('2026-11-20', 23, 30), type: 'screen_off' },
      { t: at('2026-11-21', 7, 30), type: 'unlock' },
    ]
    const res = estimateSleepByDay({
      events,
      existingDays: { '2026-11-20': { sleepMin: 420 } },
      today: '2026-11-21',
      now,
    })
    expect(res['2026-11-20']).toBeUndefined()
    expect(res['2026-11-21']?.sleepMin).toBe(480)
  })

  it('allows +/-8 h weekend drift while rejecting +/-7 h weekday drift from baseline', () => {
    // 2026-11-20 is Friday, 2026-11-21 is Saturday.
    // Default baseline is 00:00 -> 06:00.
    // Ending at 13:00 is +7 h drift on wake time -> rejected on Friday, allowed on Saturday!
    const events = [
      { t: at('2026-11-20', 4, 0), type: 'screen_off' },
      { t: at('2026-11-20', 13, 0), type: 'unlock' },
      { t: at('2026-11-21', 4, 0), type: 'screen_off' },
      { t: at('2026-11-21', 13, 0), type: 'unlock' },
    ]
    const res = estimateSleepByDay({ events, today: '2026-11-21', now: at('2026-11-21', 16, 0) })
    expect(res['2026-11-20']).toBeUndefined()
    expect(res['2026-11-21']?.sleepMin).toBe(540)
  })
})

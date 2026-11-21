import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  files: {},
  health: null,
  status: { supported: true, granted: true },
  events: [],
  android: true,
}))

vi.mock('../../lib/mobile.js', () => ({
  MOBILE: true,
  isAndroid: async () => m.android,
  readJsonFile: async name => m.files[name] ?? null,
  writeJsonFile: async (name, data) => { m.files[name] = JSON.parse(JSON.stringify(data)) },
}))
vi.mock('../../lib/health-sync.js', () => ({
  loadHealth: async () => m.health,
}))
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    status: async () => m.status,
    openSettings: async () => {},
    readScreenEvents: async () => ({ events: m.events }),
  }),
}))

const {
  SLEEP_EST_FILE,
  enableSleepEstimate,
  disableSleepEstimate,
  refreshSleepEstimate,
  mergeEstimatedIntoVitals,
  _resetSleepEstimateForTest,
} = await import('./sleep-estimate-run.js')

const at = (iso, hh, mm = 0) => new Date(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime()

beforeEach(() => {
  m.files = {}
  m.health = null
  m.status = { supported: true, granted: true }
  m.events = []
  m.android = true
  _resetSleepEstimateForTest()
})

describe('mergeEstimatedIntoVitals', () => {
  it('leaves vitals untouched when estimation is off', () => {
    const vitals = { days: { '2026-11-21': { rhr: 55 } }, hrvKind: 'rmssd' }
    expect(mergeEstimatedIntoVitals(vitals, { on: false, days: { '2026-11-21': { sleepMin: 450 } } })).toBe(vitals)
    expect(mergeEstimatedIntoVitals(null, { on: false, days: {} })).toBe(null)
  })

  it('fills missing sleep days without overwriting Health Connect sleep', () => {
    const vitals = {
      days: {
        '2026-11-20': { sleepMin: 410, rhr: 56 },
        '2026-11-21': { steps: 7200 },
      },
      hrvKind: 'rmssd',
    }
    const est = {
      on: true,
      days: {
        '2026-11-20': { sleepMin: 480 },
        '2026-11-21': { sleepMin: 430 },
      },
    }
    const merged = mergeEstimatedIntoVitals(vitals, est)
    expect(merged.days['2026-11-20']).toEqual({ sleepMin: 410, rhr: 56 })
    expect(merged.days['2026-11-21']).toEqual({ steps: 7200, sleepMin: 430, sleepSource: 'estimated' })
    expect(merged.hrvKind).toBe('rmssd')
  })
})

describe('sleep-estimate-run lifecycle', () => {
  it('enables, reads events, skips Health Connect days, prunes > 60 days, and throttles', async () => {
    const now = at('2026-11-21', 10, 0)
    m.files[SLEEP_EST_FILE] = {
      on: false,
      days: {
        '2026-08-01': { start: 1, end: 2, sleepMin: 420, source: 'estimated' },
        '2026-11-19': { start: at('2026-11-18', 23, 30), end: at('2026-11-19', 7, 0), sleepMin: 450, source: 'estimated' },
      },
      at: 0,
      error: null,
    }
    m.health = { readVitals: true, vitals: { days: { '2026-11-20': { sleepMin: 395 } } } }
    m.events = [
      { t: at('2026-11-19', 23, 0), type: 'screen_off' },
      { t: at('2026-11-20', 7, 0), type: 'unlock' },
      { t: at('2026-11-20', 23, 30), type: 'screen_off' },
      { t: at('2026-11-21', 7, 15), type: 'unlock' },
    ]
    await enableSleepEstimate()
    const st = await refreshSleepEstimate({ force: true, now })
    expect(st.on).toBe(true)
    expect(st.error).toBe(null)
    expect(st.days['2026-08-01']).toBeUndefined()
    expect(st.days['2026-11-19']?.sleepMin).toBe(450)
    expect(st.days['2026-11-20']).toBeUndefined()
    expect(st.days['2026-11-21']?.sleepMin).toBe(465)

    // Throttled within 30 minutes
    m.events = [
      { t: at('2026-11-21', 23, 30), type: 'screen_off' },
      { t: at('2026-11-22', 7, 0), type: 'unlock' },
    ]
    const throttled = await refreshSleepEstimate({ now: now + 5 * 60e3 })
    expect(throttled.at).toBe(now)

    const off = await disableSleepEstimate()
    expect(off.on).toBe(false)
  })

  it('records permission error when Usage Access is not granted', async () => {
    m.status = { supported: true, granted: false }
    await enableSleepEstimate()
    const st = await refreshSleepEstimate({ force: true, now: at('2026-11-21', 10, 0) })
    expect(st.error).toBe('permission')
  })
})

// Local runner and persistence for phone-only sleep estimation (docs/dev/PHONE_SLEEP_ESTIMATION.md).
// Stored in opengym-sleep-est.json (never in S, never synced, never backed up).
import { isoOf } from '../../lib/format.js'
import { MOBILE, isAndroid, readJsonFile, writeJsonFile } from '../../lib/mobile.js'
import { loadHealth } from '../../lib/health-sync.js'
import { estimateSleepByDay } from './sleep-estimate.js'

export const SLEEP_EST_FILE = 'opengym-sleep-est.json'
export const SLEEP_EST_KEEP_DAYS = 60
const READ_WINDOW_MS = 7 * 24 * 3600e3
const REFRESH_EVERY_MS = 30 * 60e3
const DAY_MS = 86400000

const OFF = { on: false, days: {}, at: 0, error: null }

let pluginP = null
async function plugin() {
  if (!MOBILE || !(await isAndroid())) return null
  if (!pluginP) {
    pluginP = import('@capacitor/core')
      .then(({ registerPlugin }) => ({ S: registerPlugin('HevierSleep') }))
      .catch(() => null)
  }
  return pluginP
}

let cached = null
const listeners = new Set()
const tell = st => {
  for (const cb of listeners) {
    try { cb(st) } catch { /* unmounted screen */ }
  }
}

export function onSleepEstimateChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export async function loadSleepEstimate() {
  if (cached) return cached
  const f = await readJsonFile(SLEEP_EST_FILE)
  const days = f?.days && typeof f.days === 'object' && !Array.isArray(f.days) ? f.days : {}
  cached = f && typeof f === 'object'
    ? { on: !!f.on, days, at: Number(f.at) || 0, error: f.error || null }
    : { ...OFF, days: {} }
  return cached
}

async function saveSleepEstimate(st) {
  cached = st
  await writeJsonFile(SLEEP_EST_FILE, st)
  tell(st)
  return st
}

export async function sleepEstimateStatus() {
  if (!MOBILE) return { supported: false, granted: false }
  try {
    const p = await plugin()
    if (!p) return { supported: false, granted: false }
    const res = await p.S.status()
    return { supported: !!res?.supported, granted: !!res?.granted }
  } catch {
    return { supported: false, granted: false }
  }
}

export async function openUsageSettings() {
  const p = await plugin()
  if (p) await p.S.openSettings()
}

export async function enableSleepEstimate() {
  const cur = await loadSleepEstimate()
  const next = await saveSleepEstimate({ ...cur, on: true, error: null })
  const st = await sleepEstimateStatus()
  if (st.granted) return refreshSleepEstimate({ force: true })
  return next
}

export async function disableSleepEstimate() {
  const cur = await loadSleepEstimate()
  return saveSleepEstimate({ ...cur, on: false, error: null })
}

let running = null
export async function refreshSleepEstimate({ force = false, now = Date.now() } = {}) {
  if (!MOBILE) return null
  const st = await loadSleepEstimate()
  if (!st.on) return st
  if (!force && st.at > 0 && now - st.at < REFRESH_EVERY_MS) return st
  if (running) return running

  running = (async () => {
    const latest = await loadSleepEstimate()
    if (!latest.on) return latest
    const p = await plugin()
    if (!p) return saveSleepEstimate({ ...latest, error: 'unsupported' })
    try {
      const status = await p.S.status()
      if (!status?.supported) return saveSleepEstimate({ ...latest, error: 'unsupported' })
      if (!status?.granted) return saveSleepEstimate({ ...latest, error: 'permission' })

      const since = now - READ_WINDOW_MS
      const res = await p.S.readScreenEvents({ since, until: now })
      const h = await loadHealth().catch(() => null)
      const hcDays = h?.readVitals && h?.vitals?.days && typeof h.vitals.days === 'object' ? h.vitals.days : {}
      const today = isoOf(new Date(now))
      const found = estimateSleepByDay({
        events: res?.events || [],
        history: latest.days,
        existingDays: hcDays,
        today,
        now,
      })

      const merged = { ...(latest.days || {}), ...found }
      const keepFrom = isoOf(new Date(new Date(today + 'T12:00:00').getTime() - SLEEP_EST_KEEP_DAYS * DAY_MS))
      for (const d of Object.keys(merged)) {
        const hc = hcDays[d]
        const hasReal = Number(hc?.sleepMin) > 0 && hc?.sleepSource !== 'estimated'
        if (d < keepFrom || hasReal) delete merged[d]
      }
      return saveSleepEstimate({ ...latest, days: merged, at: now, error: null })
    } catch (e) {
      const err = e?.code === 'permission' ? 'permission' : e?.code === 'unsupported' ? 'unsupported' : 'failed'
      return saveSleepEstimate({ ...latest, error: err })
    }
  })().finally(() => { running = null })

  return running
}

/**
 * Pure merge for DailyFormCard & DailyCheckin:
 * fills missing sleepMin entries with `{ sleepMin, sleepSource: 'estimated' }`,
 * never overwriting days that already have non-estimated sleep from Health Connect / a wearable.
 */
export function mergeEstimatedIntoVitals(vitals, est) {
  if (!est?.on) return vitals || null
  const estDays = est.days && typeof est.days === 'object' ? est.days : {}
  const keys = Object.keys(estDays).filter(d => Number(estDays[d]?.sleepMin) > 0)
  if (!keys.length) return vitals || null

  const days = { ...(vitals?.days && typeof vitals.days === 'object' ? vitals.days : {}) }
  for (const d of keys) {
    const cur = days[d]
    if (Number(cur?.sleepMin) > 0 && cur?.sleepSource !== 'estimated') continue
    days[d] = { ...(cur || {}), sleepMin: Math.round(Number(estDays[d].sleepMin)), sleepSource: 'estimated' }
  }
  return { days, hrvKind: vitals?.hrvKind || null }
}

let started = false
export function initSleepEstimate() {
  if (!MOBILE || started) return
  started = true
  setTimeout(() => { refreshSleepEstimate().catch(() => {}) }, 4000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSleepEstimate().catch(() => {})
  })
  import('@capacitor/app')
    .then(({ App }) => App.addListener('appStateChange', st => { if (st?.isActive) refreshSleepEstimate().catch(() => {}) }))
    .catch(() => {})
}

export function _resetSleepEstimateForTest() {
  pluginP = null
  cached = null
  running = null
  started = false
  listeners.clear()
}

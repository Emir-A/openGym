// Phone-only overnight sleep estimation (docs/dev/PHONE_SLEEP_ESTIMATION.md):
// retroactive gap extraction from screen_off -> unlock transitions, 7-day rolling circular
// baseline, optional minutely step trimming, and strict duration / drift / nap bounds.
import { isoOf } from '../../lib/format.js'

export const NAP_FROM_HOUR = 15
export const MIN_SLEEP_MS = 3 * 3600e3
export const MAX_SLEEP_MS = 12 * 3600e3
export const FLICKER_MAX_MS = 90e3
const STEP_SCAN_MS = 3 * 3600e3
const STEP_GAP_MS = 10 * 60e3
const DAY_MS = 86400000

const EVENT_ORDER = { screen_off: 0, keyguard_shown: 1, screen_on: 2, unlock: 3 }

/** Local clock time in minutes past midnight [0, 1440). */
export function minutesOfDay(ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

/** Signed shortest circular difference (a - b) in (-720, 720] minutes. */
export function circularDiffMin(a, b) {
  let d = ((a - b) % 1440 + 1440) % 1440
  if (d > 720) d -= 1440
  return d
}

/** Circular mean of minute-of-day values on the 1440-minute clock, or null. */
export function circularMeanMin(mins) {
  const valid = (Array.isArray(mins) ? mins : []).filter(Number.isFinite)
  if (!valid.length) return null
  let sx = 0
  let cx = 0
  for (const m of valid) {
    const rad = (m / 1440) * 2 * Math.PI
    sx += Math.sin(rad)
    cx += Math.cos(rad)
  }
  if (Math.hypot(sx, cx) < 1e-6) return null
  const out = ((Math.atan2(sx, cx) / (2 * Math.PI)) * 1440 + 1440) % 1440
  return out >= 1439.999999 ? 0 : out
}

/**
 * Extracts screen-off intervals `[{ start, end }]` from chronological usage events.
 * Brief lock-screen wake-ups (`screen_on` -> `screen_off` within 90 s with no `unlock`)
 * are bridged so incoming notifications do not split an overnight stretch.
 */
export function extractScreenOffGaps(events) {
  const sorted = (Array.isArray(events) ? events : [])
    .filter(e => e && Number.isFinite(Number(e.t)) && e.type in EVENT_ORDER)
    .map(e => ({ t: Number(e.t), type: e.type }))
    .sort((a, b) => a.t - b.t || EVENT_ORDER[a.type] - EVENT_ORDER[b.type])

  const gaps = []
  let gapStart = null
  let pendingWake = null

  const closeAt = end => {
    if (gapStart != null && end > gapStart) gaps.push({ start: gapStart, end })
    gapStart = null
    pendingWake = null
  }

  for (const ev of sorted) {
    if (ev.type === 'screen_off') {
      if (gapStart == null) {
        gapStart = ev.t
      } else if (pendingWake != null) {
        if (ev.t - pendingWake <= FLICKER_MAX_MS) {
          pendingWake = null
        } else {
          closeAt(pendingWake)
          gapStart = ev.t
        }
      }
    } else if (ev.type === 'screen_on') {
      if (gapStart != null && pendingWake == null) pendingWake = ev.t
    } else if (ev.type === 'unlock') {
      if (gapStart != null) closeAt(pendingWake != null ? pendingWake : ev.t)
    }
  }
  if (gapStart != null && pendingWake != null) closeAt(pendingWake)
  return gaps
}

function normalizeHistory(entries) {
  if (!entries) return []
  const list = Array.isArray(entries) ? entries : Object.entries(entries).map(([d, v]) => ({ ...(v || {}), d }))
  return list
    .filter(x => x && Number.isFinite(Number(x.start)) && Number.isFinite(Number(x.end)) && Number(x.end) > Number(x.start))
    .map(x => {
      const start = Number(x.start)
      const end = Number(x.end)
      return { start, end, d: typeof x.d === 'string' ? x.d : isoOf(new Date(end)) }
    })
}

/**
 * 7-day rolling circular bedtime / wake-up baseline (`{ bedMin, wakeMin, count }`).
 * Falls back to 00:00-06:00 with no recent history; widens to +/-2 h around midpoint
 * if the learned window is narrower than 4 hours.
 */
export function baselineFromHistory(entries, today) {
  let list = normalizeHistory(entries)
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
    const todayNoon = new Date(today + 'T12:00:00').getTime()
    const minIso = isoOf(new Date(todayNoon - 7 * DAY_MS))
    list = list.filter(x => x.d >= minIso && x.d < today)
  }
  if (!list.length) return { bedMin: 0, wakeMin: 360, count: 0 }

  let bedMin = circularMeanMin(list.map(x => minutesOfDay(x.start)))
  let wakeMin = circularMeanMin(list.map(x => minutesOfDay(x.end)))
  if (bedMin == null || wakeMin == null) return { bedMin: 0, wakeMin: 360, count: 0 }

  const span = ((wakeMin - bedMin) % 1440 + 1440) % 1440
  if (span < 240) {
    const mid = (bedMin + span / 2) % 1440
    bedMin = ((mid - 120) % 1440 + 1440) % 1440
    wakeMin = (mid + 120) % 1440
  }
  return { bedMin, wakeMin, count: list.length }
}

function isWalkingCluster(cluster) {
  let sum = 0
  let streak = 0
  let lastActiveT = null
  for (const b of cluster) {
    sum += b.steps
    if (b.steps >= 10) {
      streak = lastActiveT != null && Math.abs(b.t - lastActiveT) <= STEP_GAP_MS ? streak + 1 : 1
      lastActiveT = b.t
    }
    if (sum >= 50 || streak >= 3) return true
  }
  return false
}

function clusterSteps(buckets, descending = false) {
  const clusters = []
  let cur = []
  for (const b of buckets) {
    if (!cur.length) { cur.push(b); continue }
    const prev = cur[cur.length - 1]
    const diff = descending ? prev.t - b.t : b.t - prev.t
    if (diff <= STEP_GAP_MS) cur.push(b)
    else { clusters.push(cur); cur = [b] }
  }
  if (cur.length) clusters.push(cur)
  return clusters
}

/**
 * Refines `[bedMs, wakeMs]` when minutely step buckets (`[{ t, steps }]`) are available.
 * Scans 3 h forward from bedtime and 3 h backward from wake-up, trimming past bouts that
 * reach >= 50 cumulative steps or 3 consecutive >=10-step minutes (within 10-min gaps).
 */
export function trimWithSteps(bedMs, wakeMs, minuteSteps) {
  if (!Array.isArray(minuteSteps) || !minuteSteps.length || wakeMs <= bedMs) {
    return { start: bedMs, end: wakeMs }
  }
  const steps = minuteSteps
    .filter(s => s && Number.isFinite(Number(s.t)) && Number(s.steps) > 0)
    .map(s => ({ t: Number(s.t), steps: Number(s.steps) }))
    .sort((a, b) => a.t - b.t)

  let newBed = bedMs
  const fwdEnd = Math.min(wakeMs, bedMs + STEP_SCAN_MS)
  const fwdBuckets = steps.filter(s => s.t >= bedMs && s.t < fwdEnd)
  for (const c of clusterSteps(fwdBuckets, false)) {
    if (isWalkingCluster(c)) newBed = Math.max(newBed, Math.min(wakeMs, c[c.length - 1].t + 60e3))
  }

  let newWake = wakeMs
  const backStart = Math.max(newBed, wakeMs - STEP_SCAN_MS)
  const backBuckets = steps.filter(s => s.t >= backStart && s.t <= wakeMs).reverse()
  for (const c of clusterSteps(backBuckets, true)) {
    if (isWalkingCluster(c)) newWake = Math.min(newWake, Math.max(newBed, c[c.length - 1].t))
  }

  return { start: newBed, end: Math.max(newBed, newWake) }
}

/**
 * Estimates overnight sleep by local calendar day (`YYYY-MM-DD`).
 * Never overwrites days that already have non-estimated sleep in `existingDays`.
 */
export function estimateSleepByDay({
  events,
  minuteSteps = [],
  history = [],
  existingDays = {},
  today,
  now = Date.now(),
} = {}) {
  const gaps = extractScreenOffGaps(events)
  const priorHistory = normalizeHistory(history)
  const out = {}

  for (const gap of gaps) {
    if (!(gap.end > gap.start) || gap.end > now + 60e3) continue
    const { start, end } = trimWithSteps(gap.start, gap.end, minuteSteps)
    const dur = end - start
    if (dur < MIN_SLEEP_MS || dur > MAX_SLEEP_MS) continue

    const endDate = new Date(end)
    if (endDate.getHours() >= NAP_FROM_HOUR) continue
    const iso = isoOf(endDate)
    if (today && iso > today) continue

    const ex = existingDays?.[iso]
    const hasRealExisting = Number(ex?.sleepMin) > 0 && ex?.sleepSource !== 'estimated' && ex?.source !== 'estimated'
    if (hasRealExisting) continue

    const combined = [...priorHistory, ...Object.entries(out).map(([d, v]) => ({ ...v, d }))]
    const base = baselineFromHistory(combined, iso)
    const dow = endDate.getDay()
    const maxDriftMin = (dow === 0 || dow === 6) ? 8 * 60 : 6 * 60
    const bedDrift = Math.abs(circularDiffMin(minutesOfDay(start), base.bedMin))
    const wakeDrift = Math.abs(circularDiffMin(minutesOfDay(end), base.wakeMin))
    if (bedDrift > maxDriftMin || wakeDrift > maxDriftMin) continue

    const sleepMin = Math.round(dur / 60000)
    if (!out[iso] || sleepMin > out[iso].sleepMin) {
      out[iso] = { start, end, sleepMin, source: 'estimated' }
    }
  }
  return out
}

// [hevier] Phone-only sleep estimation section under Settings -> Integrations -> Health (Android only).
// Reads UsageStats screen transitions when Usage access is granted, stays local to this phone,
// and never overwrites sleep imported from Health Connect or a watch.
import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n.js'
import { fmtNum } from '../../lib/format.js'
import { useUI } from '../../store/useUI.js'
import { Section, Row, Switch } from '../../components/ui.jsx'
import {
  loadSleepEstimate,
  onSleepEstimateChange,
  sleepEstimateStatus,
  openUsageSettings,
  enableSleepEstimate,
  disableSleepEstimate,
  refreshSleepEstimate,
} from '../lib/sleep-estimate-run.js'

const toast = msg => useUI.getState().toast(msg)

function latestSummary(days) {
  const keys = Object.keys(days || {}).sort()
  const d = keys.at(-1)
  if (!d) return null
  const row = days[d]
  if (!(row?.sleepMin > 0)) return null
  const hm = m => {
    const hh = Math.floor(m / 60)
    const mm = Math.round(m % 60)
    return mm ? t('{0} h {1} min', fmtNum(hh), fmtNum(mm)) : t('{0} h', fmtNum(hh))
  }
  const timeOf = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (row.start && row.end) {
    return `${d}: ${timeOf(row.start)} – ${timeOf(row.end)} (${hm(row.sleepMin)})`
  }
  return `${d}: ${hm(row.sleepMin)}`
}

export default function SleepEstimateSection() {
  const [status, setStatus] = useState(null)
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const checkStatus = () => sleepEstimateStatus().then(s => {
      if (!live) return
      setStatus(s)
      if (s.granted) refreshSleepEstimate().catch(() => {})
    }).catch(() => {})
    checkStatus()
    loadSleepEstimate().then(x => { if (live) setSt({ ...x }) }).catch(() => {})
    const off = onSleepEstimateChange(x => { if (live) setSt({ ...x }) })
    const onVis = () => { if (!document.hidden) checkStatus() }
    document.addEventListener('visibilitychange', onVis)
    return () => { live = false; off(); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  if (!status?.supported || !st) return null

  const toggle = async v => {
    setBusy(true)
    try {
      if (v) {
        const next = await enableSleepEstimate()
        const s = await sleepEstimateStatus()
        setStatus(s)
        toast(s.granted ? t('Phone sleep estimation is on') : t('Grant Usage access in Android settings to read screen times'))
        setSt({ ...next })
      } else {
        const next = await disableSleepEstimate()
        setSt({ ...next })
      }
    } catch {
      toast(t('Could not update phone sleep estimation'))
    }
    setBusy(false)
  }

  const refresh = async () => {
    setBusy(true)
    try {
      const next = await refreshSleepEstimate({ force: true })
      const s = await sleepEstimateStatus()
      setStatus(s)
      if (next?.error === 'permission') toast(t('Usage access is not allowed'))
      else if (next?.error) toast(t('Could not estimate sleep from phone usage'))
      else toast(latestSummary(next?.days) || t('No overnight sleep window found yet'))
    } catch {
      toast(t('Could not estimate sleep from phone usage'))
    }
    setBusy(false)
  }

  const summary = st.on && status.granted
    ? (st.error === 'failed'
      ? t('Could not read screen times')
      : (latestSummary(st.days) || t('No overnight sleep window found yet')))
    : st.on
      ? t('Needs Usage access permission on Android')
      : t('Fallback when your watch or Health Connect has no sleep')

  return <Section title={t('Phone sleep estimation')}
    footer={t('Estimates overnight sleep from screen on/off and unlock times on this phone only, without a background service. Health Connect sleep from a watch always wins.')}>
    <Row icon="moon" iconTint="var(--indigo)" title={t('Estimate sleep from phone usage')}
      subtitle={summary}>
      <Switch checked={!!st.on} disabled={busy} onChange={toggle} aria-label={t('Estimate sleep from phone usage')} />
    </Row>
    {st.on && !status.granted && <Row icon="lock" iconTint="var(--orange)" title={t('Open Usage access settings')}
      subtitle={t('Allow openGym to read screen on/off times. Stays on this phone only.')}
      accessory="chevron" onClick={() => openUsageSettings().catch(() => toast(t('Could not open Android settings')))} />}
    {st.on && status.granted && <Row icon="repeat" title={busy ? t('Refreshing…') : t('Refresh')}
      accessory="chevron" onClick={busy ? undefined : refresh} />}
  </Section>
}

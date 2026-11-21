// Initializes the ported openGym-Hevier features (Hevy import/export hooks, BLE HR strap,
// home-screen month widget, in-app GitHub updater, lean APK media pack).
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { MOBILE } from '../lib/mobile.js'
import { todayISO } from '../lib/format.js'
import { hooks } from './hooks.js'
import { storeAdapter } from './lib/store-watch.js'
import { importHooks, choicesFor } from './lib/hevy-import.js'
import { importHevyFolders, applyHevyFolders } from './lib/hevy-folders.js'
import * as hevyMore from './lib/hevy-more.js'
import { HevyMoreRows, moreToast } from './components/HevyMoreRows.jsx'
import { initNoteFix } from './lib/note-text.js'
import { initHevyExport } from './lib/hevy-export-sync.js'
import { initHrStrap } from './lib/hr-strap-run.js'
import { initMonthWidget } from './lib/month-widget.js'
import { initUpdateNotice } from './components/UpdateNotice.jsx'
import { initMediaPack } from './lib/media-pack-run.js'
import { askMedia } from './components/MediaSection.jsx'
import { partOn } from './lib/module-parts.js'
import HevyExportSection from './components/HevyExportSection.jsx'
import StrapSection from './components/StrapSection.jsx'

const store = storeAdapter(useStore, (msg, opts) => useUI.getState().toast(msg, opts))
const state = () => useStore.getState().S

function install() {
  Object.assign(hooks, importHooks(() => choicesFor(state())))
  hooks.importView = (again, first) => hevyMore.viewAgain(again, first, hooks.importDone)
  hooks.hevyFolders = { fetch: importHevyFolders, merged: applyHevyFolders }
  hooks.hevyMore = { ...hevyMore, Rows: HevyMoreRows, toast: moreToast }
  hooks.integrationsAfter = cat => (
    cat === 'health' && MOBILE && partOn(state(), 'health', 'strap')
      ? <StrapSection key="hv-hr-strap" />
      : cat === 'training' && partOn(state(), 'integrations', 'hevy')
        ? <HevyExportSection key="hv-hevy-export" />
        : null
  )
  initNoteFix(store)
  initHevyExport(store)
  initHrStrap(store)
  initMonthWidget(store, () => { import('../sheets.jsx').then(m => m.calendarSheet()).catch(() => {}) }, todayISO)
  initUpdateNotice(store)
  initMediaPack(store, askMedia)
}

install()

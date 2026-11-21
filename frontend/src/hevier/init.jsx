// Initializes the ported openGym-Hevier features (Hevy import hooks, 2-way Hevy export).
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { hooks } from './hooks.js'
import { storeAdapter } from './lib/store-watch.js'
import { importHooks, choicesFor } from './lib/hevy-import.js'
import { importHevyFolders, applyHevyFolders } from './lib/hevy-folders.js'
import * as hevyMore from './lib/hevy-more.js'
import { HevyMoreRows, moreToast } from './components/HevyMoreRows.jsx'
import { initNoteFix } from './lib/note-text.js'
import { initHevyExport } from './lib/hevy-export-sync.js'
import { partOn } from './lib/module-parts.js'
import HevyExportSection from './components/HevyExportSection.jsx'

const store = storeAdapter(useStore, (msg, opts) => useUI.getState().toast(msg, opts))
const state = () => useStore.getState().S

function install() {
  Object.assign(hooks, importHooks(() => choicesFor(state())))
  hooks.importView = (again, first) => hevyMore.viewAgain(again, first, hooks.importDone)
  hooks.hevyFolders = { fetch: importHevyFolders, merged: applyHevyFolders }
  hooks.hevyMore = { ...hevyMore, Rows: HevyMoreRows, toast: moreToast }
  hooks.integrationsAfter = cat => (
    cat === 'training' && partOn(state(), 'integrations', 'hevy')
      ? <HevyExportSection key="hv-hevy-export" />
      : null
  )
  initNoteFix(store)
  initHevyExport(store)
}

install()

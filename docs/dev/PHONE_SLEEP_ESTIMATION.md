# Phone-Only Sleep Estimation Plan (Android)

## Goal
Estimate overnight sleep duration and bed/wake times on Android **without a wearable or background service**, modeled on Samsung Health's phone sleep estimator (`com.samsung.android.sleepdetectionlib` + `SleepEstimationManager`), and feed those estimates into openGym's existing Daily Form and pre-workout check-in flows whenever real Health Connect / wearable sleep is absent.

## Design Principles
- **Additive (`hevier` layer):** Keep native code in `frontend/android/app/src/hevier/` and JS/UI in `frontend/src/hevier/` so upstream files stay minimal and easy to rebase.
- **Zero background service / low battery:** Read screen & unlock transitions retroactively via Android's `UsageStatsManager.queryEvents()` instead of keeping a persistent `BroadcastReceiver` service running.
- **Local-only & opt-in:** Off by default. Stored in a phone-local JSON file (`opengym-sleep-est.json`), never in `S`, never synced to a server, and never included in backups (matching `opengym-health.json`).
- **Wearable-first priority:** Never overwrite a day that already has real sleep data from Health Connect / a watch.

---

## Architecture Overview

```text
Android UsageStatsManager (SCREEN_INTERACTIVE, SCREEN_NON_INTERACTIVE, KEYGUARD_SHOWN, KEYGUARD_HIDDEN)
        │
        ▼
HevierSleepPlugin.java  (Capacitor bridge, registered in HevierPlugins.java)
        │
        ▼
sleep-estimate-run.js   (loads last 7 days on launch/resume, saves to opengym-sleep-est.json)
        │
        ▼
sleep-estimate.js       (pure estimation engine: gap extraction, 7-day baseline, step trimming, bounds)
        │
        ├──► SleepEstimateSection.jsx  (Settings → Integrations → Health)
        └──► DailyFormCard.jsx / DailyCheckin.jsx  (fallback when Health Connect has no sleep for that day)
```

---

## Implementation Steps

### 1. Native Android Bridge
- **Create** `frontend/android/app/src/hevier/java/ch/duartesantos/opengym/HevierSleepPlugin.java`
  - `@CapacitorPlugin(name = "HevierSleep")`
  - `status()` → `{ supported: true, granted: boolean }` via `AppOpsManager.OPSTR_GET_USAGE_STATS`.
  - `openSettings()` → opens `Settings.ACTION_USAGE_ACCESS_SETTINGS` (scoped to `package:<pkg>`, with fallback to the general list if OEM rejects the package URI).
  - `readScreenEvents({ since, until })` → queries `UsageStatsManager.queryEvents(since, until)` and returns `{ events: [{ t, type }] }` filtered to:
    - `SCREEN_INTERACTIVE` → `"screen_on"`
    - `SCREEN_NON_INTERACTIVE` → `"screen_off"`
    - `KEYGUARD_SHOWN` → `"keyguard_shown"`
    - `KEYGUARD_HIDDEN` → `"unlock"`
- **Edit** `frontend/android/app/src/hevier/java/ch/duartesantos/opengym/HevierPlugins.java`
  - Add `activity.registerFlavorPlugin(HevierSleepPlugin.class);` (no changes to `MainActivity.java`).
- **Edit** `frontend/android/app/src/main/AndroidManifest.xml`
  - Add:
    ```xml
    <uses-permission
        android:name="android.permission.PACKAGE_USAGE_STATS"
        tools:ignore="ProtectedPermissions" />
    ```

### 2. Pure Estimation Engine + Unit Tests
- **Create** `frontend/src/hevier/lib/sleep-estimate.js`
  - `extractScreenOffGaps(events)`:
    - Sorts chronologically.
    - Pairs `screen_off` → next `unlock` (or sustained `screen_on`).
    - Bridges over brief lock-screen wake-ups (`screen_on` → `screen_off` within **90 s** with no `unlock`) so notifications don't split the night.
  - `baselineFromHistory(entries, today)`:
    - Computes circular mean bedtime & wake-up time over the last **7 days** of confirmed/historical sleep.
    - Falls back to **`00:00–06:00`** if no recent history exists; widens span to **±2 h** around midpoint if narrower than 4 h.
  - `trimWithSteps(bedMs, wakeMs, minuteSteps)` *(optional refinement when minutely steps are available)*:
    - Scans **3 h** forward from candidate bedtime and **3 h** backward from candidate wake-up time.
    - Trims the sleep boundary past walking activity when:
      - Cumulative steps reach **≥ 50**, or
      - **3 consecutive active minutes** (within **10-minute** gaps) each have **≥ 10 steps**.
  - `estimateSleepByDay({ events, minuteSteps, history, existingDays, today, now })`:
    - Assigns each interval to the local date it ends on if it ends before **15:00** (matching `NAP_FROM_HOUR = 15` in `frontend/src/lib/vitals.js`).
    - Rejects intervals outside **3–12 h**, future/inverted timestamps, and intervals drifting beyond **±6 h** (weekday) / **±8 h** (weekend) from baseline.
    - Skips any day already present with non-estimated sleep in `existingDays`.
    - Returns `{ [iso]: { start, end, sleepMin, source: 'estimated' } }`.
- **Create** `frontend/src/hevier/lib/sleep-estimate.test.js`
  - Cover midnight wrap-around (`circularDiffMin`, `circularMeanMin`), notification flicker bridging vs. real mid-night unlock, step burst & streak trimming, 3–12 h bounds, afternoon nap exclusion, and non-overwrite of Health Connect sleep.

### 3. Local Runner & Persistence
- **Create** `frontend/src/hevier/lib/sleep-estimate-run.js`
  - Local file: `opengym-sleep-est.json` (`{ on, days, at, error }`, pruned to 60 days).
  - Exports `loadSleepEstimate`, `onSleepEstimateChange`, `sleepEstimateStatus`, `openUsageSettings`, `enableSleepEstimate`, `disableSleepEstimate`, `refreshSleepEstimate`, `mergeEstimatedIntoVitals`, `initSleepEstimate`.
  - `initSleepEstimate()` refreshes on app launch (+4 s) and `appStateChange` resume (throttled to every 30 min).

### 4. UI & Vitals Wiring
- **Create** `frontend/src/hevier/components/SleepEstimateSection.jsx`
  - Shown under **Settings → Integrations → Health** (Android only) via `hooks.integrationsAfter` in `frontend/src/hevier/init.jsx`.
  - Controls:
    - Opt-in toggle (`Estimate sleep from phone usage`)
    - Permission prompt / button (`Open Usage access settings`) when `granted === false`
    - Latest estimate summary (`YYYY-MM-DD: HH:MM – HH:MM (X h Y min)`) + manual `Refresh` button
- **Edit** `frontend/src/hevier/init.jsx`
  - Call `initSleepEstimate()` on startup.
  - Render `<SleepEstimateSection />` alongside `<StrapSection />` in `hooks.integrationsAfter` when `cat === 'health' && MOBILE`.
- **Edit** `frontend/src/components/DailyFormCard.jsx` & `frontend/src/components/DailyCheckin.jsx`
  - Use `mergeEstimatedIntoVitals(vitals, est)` so phone-estimated sleep fills Stats → Daily form and pre-workout check-in sleep when Health Connect has no sleep for that day.
  - Label phone-estimated sleep clearly (e.g., `"Estimated from phone usage"`) rather than `"From Health Connect"`.
- **Optional Phase 2:**
  - Add minutely step reading to `HealthConnectPlugin.java` (`StepsRecord` aggregated per minute for `[bed, bed+3h]` and `[wake-3h, wake]`) and pass into `estimateSleepByDay({ minuteSteps })`.
  - Add a quick **Confirm / Edit** sheet for last night's estimate so user corrections feed back into the 7-day rolling baseline.

---

## Verification Checklist
1. **Unit tests:** `cd frontend && npx vitest run src/hevier/lib/sleep-estimate.test.js`
2. **Full frontend test suite:** `cd frontend && npm test`
3. **i18n / source-string checks** (if adding `t()` keys):
   ```bash
   cd frontend && node scripts/check-locales.mjs && node scripts/check-source-strings.mjs --strict
   ```
4. **Android build & device check:** `cd frontend && npm run build:mobile`, install APK, enable Usage Access for openGym, and verify last night's estimate populates after an overnight screen-off window.

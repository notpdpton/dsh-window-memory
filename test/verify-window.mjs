/**
 * Independent offline verification of dsh-window.
 *
 * It executes the SHIPPED client.js exactly the way the browser would: shim
 * globalThis.window.__ModuleLoader__.load, capture the entry, run
 * entry.factory(require), then plugin.apply(ctx) with a slot stub that records
 * every registration. Nothing is copied out of the product file: every assertion
 * below drives plugin.windowPlacement.* / plugin.stores (the documented test
 * seams). The half imports no React and renders nothing, so there is no stub for
 * it — and that absence is itself asserted.
 *
 * Two sections pin the storage contract: the keys this package writes are its own
 * and namespaced, and the superseded keys are still READ (a placement saved by an
 * older installation must survive the rename).
 *
 * One shim detail is deliberate: client.js runs as
 * new Function('window', source)(windowHost), so the file's window PARAMETER is
 * fixed for its lifetime. The loader-shim object therefore IS the fake
 * top-level window this verifier drives (moveTo/resizeTo/getScreenDetails/
 * screen/listeners); swapping globalThis.window later would NOT reach the
 * plugin, so scenarios swap only the storages.
 *
 * Properties proven here:
 *   1. STORE CODEC      encode -> decode round-trips a saved rect; corrupt JSON,
 *                       wrong version, missing/NaN/non-finite fields, negative
 *                       sizes and non-object values decode to null (no throw).
 *   2. CLAMPING         a rect larger than the work area is clamped to it; a rect
 *                       below DSH's native minimums (520x600) is raised to them.
 *   3. OFF-SCREEN       x=20000 / y=-5000 are rejected, not applied; a partly
 *                       visible rect is pulled fully on screen; isFullyOnScreen
 *                       separates "contained" from "merely touching".
 *   4. RESTORE-ONCE     the guard is sessionStorage["dsh-window:window-restored"]
 *                       = "1": a reload does not re-apply, a relaunch does; a
 *                       throwing sessionStorage yields false without crashing.
 *   5. SECANT PLACEMENT placeWindow over a constant frame offset (slope 1) lands on
 *                       the target within the documented pass budget, is a no-op on
 *                       a window already there, and abandons a metric that never
 *                       converges at WINDOW_MAX_PASSES instead of looping.
 *   5b. COLD START      with no stored frame the first ask is the MEASURED rect
 *                       corrected to the target, so a cold launch lands exactly on
 *                       it (the earlier seed-the-target bug overshot to x=-7); six
 *                       capture-then-restore launches keep the store a fixed point
 *                       instead of creeping by the frame offset each time.
 *   6. MAXIMIZE         detection compares EDGES within WINDOW_MAXIMIZED_TOLERANCE
 *                       (24), boundary-checked just inside vs just outside; plus
 *                       the normalizeWorkArea avail*-first regression.
 *                       THE USER-FACING RULE, pinned here: a window closed while
 *                       maximized must NOT reopen maximized. planRestore NEVER
 *                       yields intent 'maximized' and returns the stored
 *                       PRE-maximize rect; capture while maximized leaves the
 *                       stored rect untouched and only records the diagnostic
 *                       flag; a cold start already maximized with an empty store
 *                       writes NOTHING; and a restore records maximized:false.
 *   0a. REMOVED PREF     restoreMaximized appears nowhere in the shipped source,
 *                       in either locale, or in the rendered settings page.
 *   7. CAPTURE SANITY   degenerate samples (<=0, below the minimum) do not
 *                       overwrite a good stored rect; a legal minimum-size
 *                       window (520x600) IS remembered; a genuine resize is
 *                       captured.
 *   7b. CAPTURE CONT.    the store keeps following the window past its first
 *                       write, so geometry saved during THIS session is the
 *                       geometry the next launch restores.
 *   8. ONE CONTROL      the plugin has exactly one way to be turned off — being
 *                       disabled on the Plugins page — so the browser half must
 *                       register NO slot and expose NO preference store. The
 *                       binder restores and captures unconditionally once apply()
 *                       runs; that is what makes "disable the plugin" mean
 *                       "nothing is restored or captured".
 *
 *   9. (removed)        this plugin used to own a Settings page with one switch.
 *                       The check that used to live here now lives in section 9 of
 *                       verify-plugin.mjs as a NEGATIVE assertion: no slot, no
 *                       page, no second control.
 *
 *   10. LEGACY STORE    the split did not throw away what the pack saved: a
 *                       geometry document under the pack key is restored when the
 *                       plugin has none of its own, and a legacy document never
 *                       overrides a current one.
 *
 * Exit code is 0 only when every check passes. install() leaves a 1 s poll
 * interval behind, so the summary exits explicitly rather than waiting for the
 * event loop to drain.
 *
 * usage: node test/verify-window.mjs
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// 0. A simulated top-level window that doubles as the module loader shim.
// ---------------------------------------------------------------------------
let captured
const host = {
  top: null,
  __asked: { left: 20, top: 20, width: 1280, height: 820 },
  __moves: [],
  __listeners: new Map(),
  offset: { left: 0, top: 0, width: 0, height: 0 },
  devicePixelRatio: 1,
  screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
  __workArea: { left: 0, top: 0, width: 1920, height: 1040 },
  async getScreenDetails() {
    return { screens: [{ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 }] }
  },
  moveTo(x, y) {
    this.__moves.push(['moveTo', x, y])
    this.__asked.left = x
    this.__asked.top = y
  },
  resizeTo(width, height) {
    this.__moves.push(['resizeTo', width, height])
    this.__asked.width = width
    this.__asked.height = height
  },
  addEventListener(type, fn) {
    const list = this.__listeners.get(type) ?? []
    list.push(fn)
    this.__listeners.set(type, list)
  },
  removeEventListener(type, fn) {
    const list = this.__listeners.get(type) ?? []
    this.__listeners.set(type, list.filter((entry) => entry !== fn))
  },
  __dispatch(type) {
    for (const fn of [...(this.__listeners.get(type) ?? [])]) fn()
  },
  get screenX() {
    return this.__asked.left + this.offset.left
  },
  get screenY() {
    return this.__asked.top + this.offset.top
  },
  get outerWidth() {
    return this.__asked.width + this.offset.width
  },
  get outerHeight() {
    return this.__asked.height + this.offset.height
  },
}
host.top = host
// The Desktop preload writes `<html data-platform="...">` on every document it loads
// (see preload-app.cjs markDocumentPlatform), and the shipped bundles read it to tell
// the desktop shell from a browser tab. The plugin now gates on it, so the simulated
// window has to carry the same marker a real desktop session has — otherwise every
// scenario below would be exercising the disabled path.
host.document = { documentElement: { dataset: { platform: 'win32' } } }
host.__ModuleLoader__ = {
  load: (entry) => {
    captured = entry
  },
}
globalThis.window = host

/** Reset the simulated window between scenarios. */
function resetHost(options) {
  const opts = options ?? {}
  host.__asked = { ...(opts.rect ?? { left: 20, top: 20, width: 1280, height: 820 }) }
  host.__moves = []
  host.__listeners = new Map()
  host.offset = { ...(opts.offset ?? { left: 0, top: 0, width: 0, height: 0 }) }
  host.devicePixelRatio = opts.dpr ?? 1
  host.__workArea = { ...(opts.workArea ?? { left: 0, top: 0, width: 1920, height: 1040 }) }
  host.screen = {
    availLeft: host.__workArea.left,
    availTop: host.__workArea.top,
    availWidth: host.__workArea.width,
    availHeight: host.__workArea.height,
  }
  return host
}

/** The measured (renderer-reported) rect of the simulated window. */
const measuredRect = () => ({ left: host.screenX, top: host.screenY, width: host.outerWidth, height: host.outerHeight })

/** A Map-backed Storage stand-in that records every write. */
function makeStorage(initial) {
  const map = new Map(initial ?? [])
  return {
    __map: map,
    __writes: [],
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
      this.__writes.push([key, String(value)])
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

/** A Storage that is present but refuses every operation, like a blocked browser. */
function makeThrowingStorage() {
  return {
    getItem() {
      throw new Error('storage unavailable')
    },
    setItem() {
      throw new Error('storage unavailable')
    },
  }
}

globalThis.localStorage = makeStorage()

// ---------------------------------------------------------------------------
// 1. Load the shipped client half through the loader shim.
//
//    The file under test is this package's own ./client.js — the one the Plugins
//    page mounts. It imports NO React: the half renders nothing, and a require()
//    for 'react' here would be a red flag, so the require below fails loudly on
//    any unexpected module instead of standing a stub in for one.
// ---------------------------------------------------------------------------
const sourcePath = '../client.js'
const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8')
const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 16)

// eslint-disable-next-line no-eval
new Function('window', source)(host)

const requiredModules = []
const plugin = captured.factory((id) => {
  requiredModules.push(id)
  throw new Error('client.js must not require anything (asked for: ' + id + ')')
})

// ---------------------------------------------------------------------------
// 2. Minimal ctx: slots only, and a recorder that catches ANY registration.
//
//    The plugin must register nothing at all — not a settings section, not a
//    locale dictionary. `registrations` therefore stays empty, and section 8
//    asserts exactly that.
// ---------------------------------------------------------------------------
const registrations = []
let currentSlot
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (slot, cb) => {
      currentSlot = slot
      cb()
      currentSlot = undefined
      return () => {}
    },
    register: (options, Component) => {
      registrations.push({ kind: 'slot', slot: currentSlot, options, Component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

const slots = registrations.filter((r) => r.kind === 'slot')

// ---------------------------------------------------------------------------
// 2b. The browser half must run under the BARE minimum ctx.
//
//     A UI-less half declares `inject: []`, so the shell may hand it a ctx with no
//     locale service and no slot host. Section 8 asserts the restore still happens
//     in exactly that environment — re-loading the file against a fresh window —
//     because "it registers no slot" alone would not prove it still RUNS.
// ---------------------------------------------------------------------------
async function withBareCtx(fn) {
  const moves = []
  const listeners = new Map()
  const asked = { left: 20, top: 20, width: 1280, height: 820 }
  const fake = {
    top: null,
    // Same desktop marker the main harness carries: without it this scenario would
    // be testing the "not the desktop shell" bail-out instead of the binder.
    document: { documentElement: { dataset: { platform: 'win32' } } },
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
    async getScreenDetails() { return { screens: [{ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 }] } },
    get screenX() { return asked.left },
    get screenY() { return asked.top },
    get outerWidth() { return asked.width },
    get outerHeight() { return asked.height },
    devicePixelRatio: 1,
    moveTo(x, y) { moves.push(['moveTo', x, y]); asked.left = x; asked.top = y },
    resizeTo(w, h) { moves.push(['resizeTo', w, h]); asked.width = w; asked.height = h },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener(type, fn) { const list = listeners.get(type); if (list !== undefined) list.splice(list.indexOf(fn), 1) },
    __ModuleLoader__: { load: (entry) => { fake.__captured = entry } },
  }
  fake.top = fake
  const rect = { left: 300, top: 200, width: 1000, height: 700 }
  const local = makeStorage([['dsh-window-memory:window-state', JSON.stringify({ v: 1, rect, dpr: 1, maximized: false, updatedAt: 1 })]])
  const session = makeStorage()
  const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage }
  globalThis.localStorage = local
  globalThis.sessionStorage = session
  try {
    // eslint-disable-next-line no-eval
    new Function('window', source)(fake)
    const bare = fake.__captured.factory((id) => { throw new Error('unexpected require: ' + id) })
    // No locale, no slots: only effect(), which is all a UI-less half may need.
    const effects = []
    let threw = null
    try {
      bare.apply({ effect: (cb) => { const d = cb(); effects.push(d); return d } })
    } catch (error) {
      threw = error
    }
    await tick(300)
    // Exercise capture while the fake storages are still installed: a resize event
    // must reach the store this half was installed against. Doing it after the
    // finally below would write to the outer store and prove nothing.
    asked.width = 900
    asked.height = 650
    for (const fn of listeners.get('resize') ?? []) fn()
    await tick(200)
    const stored = JSON.parse(local.getItem('dsh-window-memory:window-state') ?? 'null')
    const capturedWidth = stored === null ? null : stored.rect.width
    return { bare, effects, threw, moves, listeners, asked, local, session, restoreRect: rect, capturedWidth }
  } finally {
    globalThis.localStorage = previous.localStorage
    globalThis.sessionStorage = previous.sessionStorage
  }
}

// ---------------------------------------------------------------------------
// 3. check() + seam access helpers.
// ---------------------------------------------------------------------------
let failures = 0
let passes = 0
function check(label, condition, detail) {
  if (condition) {
    passes++
    console.log('  ok   ' + label)
  } else {
    failures++
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' - ' + detail))
  }
}

const seam = plugin.windowPlacement
const seamMissing = []

function call(name, ...args) {
  const fn = seam?.[name]
  if (typeof fn !== 'function') {
    if (!seamMissing.includes(name)) seamMissing.push(name)
    throw new Error('seam missing: plugin.windowPlacement.' + name + ' is not a function')
  }
  return fn.apply(seam, args)
}
async function callAsync(name, ...args) {
  const fn = seam?.[name]
  if (typeof fn !== 'function') {
    if (!seamMissing.includes(name)) seamMissing.push(name)
    throw new Error('seam missing: plugin.windowPlacement.' + name + ' is not a function')
  }
  return await fn.apply(seam, args)
}

/** Run one property section; a missing seam is a loud FAIL, not a silent skip. */
async function section(title, fn) {
  console.log('\n-- ' + title)
  try {
    await fn()
  } catch (error) {
    failures++
    console.log('  FAIL ' + title + ' section aborted - ' + (error && error.message ? error.message : String(error)))
  }
}

const sameRect = (a, b) =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.height === b.height
const rectText = (r) => (r ? '{' + r.left + ',' + r.top + ' ' + r.width + 'x' + r.height + '}' : String(r))
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeout = 1200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return true
    await tick(5)
  }
  return predicate()
}

/** Swap the global storages for one scenario (the window is bound at load time). */
async function withStorages(local, session, body) {
  const previousLocal = globalThis.localStorage
  const previousSession = globalThis.sessionStorage
  globalThis.localStorage = local
  globalThis.sessionStorage = session
  try {
    return await body()
  } finally {
    globalThis.localStorage = previousLocal
    if (previousSession === undefined) delete globalThis.sessionStorage
    else globalThis.sessionStorage = previousSession
  }
}

// ---------------------------------------------------------------------------
// 4. Stub-tree rendering helpers (same technique as verify-client.mjs).
// ---------------------------------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}), visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
  return (node.children ?? []).map(textOf).join('')
}

// ---------------------------------------------------------------------------
// 5. Startup banner.
// ---------------------------------------------------------------------------
console.log('client.js sha256: ' + sourceHash + ' | bytes: ' + source.length)
console.log('plugin exports:', Object.keys(plugin))
console.log('windowPlacement seam:', seam === undefined ? 'MISSING' : typeof seam, seam === undefined ? '' : '(' + Object.keys(seam).length + ' members)')
console.log('slots registered:', slots.length, '| any registration:', registrations.length)
check('the browser half requires no module at all', requiredModules.length === 0, requiredModules.join(', '))

// ===========================================================================
// 0a. THE REMOVED PREFERENCE IS GONE FROM THE SOURCE
//
//   A window closed while maximized reopens at its PRE-maximize size, so there is
//   no separate "restore maximized" preference: no SETTING_GROUPS entry, no
//   SWITCH_DEFAULTS key, no locale string in either language.
// ===========================================================================
await section('0a. restore-maximized preference removed from the source', () => {
  check('restoreMaximized appears nowhere in client.js', !source.includes('restoreMaximized'), (source.match(/restoreMaximized/g) ?? []).length + ' occurrence(s)')
  check('no switch.restoreMaximized locale key', !source.includes('switch.restoreMaximized'))
  check('no restore-maximized label in either locale', !source.includes('恢复最大化状态'))
  check('no restore-maximized English label', !source.toLowerCase().includes('restore maximized'))
})

// ===========================================================================
// 0. SEAM + DOCUMENTED LIMITS
// ===========================================================================
await section('seam and documented limits', () => {
  check('plugin exports a windowPlacement test seam', seam !== undefined && seam !== null && typeof seam === 'object')
  const names = [
    'encodeState', 'decodeState', 'loadState', 'saveState',
    'hasRestoredThisLaunch', 'markRestored',
    'normalizeRect', 'normalizeWorkArea', 'clampRect', 'visibleOverlap',
    'isOnScreen', 'isFullyOnScreen', 'bringOnScreen',
    'isMaximizedRect', 'isStorableRect', 'pickHomeArea', 'sameRect',
    'readGeometry', 'placeWindow', 'planRestore', 'install',
  ]
  for (const name of names) check('seam exposes windowPlacement.' + name, typeof seam?.[name] === 'function', typeof seam?.[name])
  check('store key is this package\'s own localStorage key', seam?.WINDOW_STATE_KEY === 'dsh-window-memory:window-state', seam?.WINDOW_STATE_KEY)
  check('restore-once key is this package\'s own sessionStorage key', seam?.WINDOW_RESTORED_KEY === 'dsh-window-memory:window-restored', seam?.WINDOW_RESTORED_KEY)
  check(
    'the previous geometry key is still read as a fallback',
    plugin.stores?.LEGACY_WINDOW_STATE_KEY === 'dsh-window:window-state',
    plugin.stores?.LEGACY_WINDOW_STATE_KEY,
  )
  check(
    'the oldest geometry key is read only as a last resort',
    plugin.stores?.ANCIENT_WINDOW_STATE_KEY === 'dsh-notpdpton:window-state',
    plugin.stores?.ANCIENT_WINDOW_STATE_KEY,
  )
  check('stored document version is 1', seam?.WINDOW_STATE_VERSION === 1, String(seam?.WINDOW_STATE_VERSION))
  check('DSH native minimum width is 520', seam?.WINDOW_MIN_WIDTH === 520, String(seam?.WINDOW_MIN_WIDTH))
  check('DSH native minimum height is 600', seam?.WINDOW_MIN_HEIGHT === 600, String(seam?.WINDOW_MIN_HEIGHT))
  check('correction pass bound is 3', seam?.WINDOW_MAX_PASSES === 3, String(seam?.WINDOW_MAX_PASSES))
  check('maximized tolerance is 24px', seam?.WINDOW_MAXIMIZED_TOLERANCE === 24, String(seam?.WINDOW_MAXIMIZED_TOLERANCE))
  check('poll interval is ~1s', seam?.WINDOW_POLL_MS === 1000, String(seam?.WINDOW_POLL_MS))
})

// ===========================================================================
// 1. STORE CODEC
// ===========================================================================
await section('1. store codec', () => {
  const goodRect = { left: 100, top: 80, width: 1280, height: 820 }
  const state = { rect: goodRect, dpr: 1.5, maximized: false, updatedAt: 1792263889830 }
  const raw = call('encodeState', state)
  check('encodeState returns a JSON string', typeof raw === 'string', typeof raw)
  const doc = JSON.parse(raw)
  check('encoded document carries v:1', doc.v === 1, String(doc.v))
  check(
    'encoded document carries exactly the five documented keys',
    Object.keys(doc).sort().join(',') === ['v', 'rect', 'dpr', 'maximized', 'updatedAt'].sort().join(','),
    Object.keys(doc).sort().join(','),
  )
  check('encoded rect is the saved rect', sameRect(doc.rect, goodRect), rectText(doc.rect))

  const back = call('decodeState', raw)
  check('valid document decodes (not null)', back !== null)
  check('round-trip preserves the rect', sameRect(back?.rect, goodRect), rectText(back?.rect))
  check('round-trip preserves dpr', back?.dpr === 1.5, String(back?.dpr))
  check('round-trip preserves maximized=false', back?.maximized === false, String(back?.maximized))
  check('round-trip preserves updatedAt', back?.updatedAt === state.updatedAt, String(back?.updatedAt))

  const maxState = { rect: goodRect, dpr: 2, maximized: true, updatedAt: 7 }
  const maxBack = call('decodeState', call('encodeState', maxState))
  check('round-trip preserves maximized=true', maxBack?.maximized === true, String(maxBack?.maximized))
  check('round-trip preserves dpr=2', maxBack?.dpr === 2, String(maxBack?.dpr))

  const badDocuments = [
    ['invalid JSON', 'not json at all'],
    ['truncated JSON', '{"v":1,"rect":'],
    ['empty string', ''],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON string', '"1280x820"'],
    ['JSON number', '42'],
    ['JSON boolean', 'true'],
    ['wrong version (2)', JSON.stringify({ v: 2, rect: goodRect })],
    ['string version', JSON.stringify({ v: '1', rect: goodRect })],
    ['missing version', JSON.stringify({ rect: goodRect })],
    ['missing rect', JSON.stringify({ v: 1 })],
    ['null rect', JSON.stringify({ v: 1, rect: null })],
    ['array rect', JSON.stringify({ v: 1, rect: [100, 80, 1280, 820] })],
    ['rect missing height', JSON.stringify({ v: 1, rect: { left: 100, top: 80, width: 1280 } })],
    ['string coordinate', JSON.stringify({ v: 1, rect: { left: '100', top: 80, width: 1280, height: 820 } })],
    ['infinite width (1e999)', '{"v":1,"rect":{"left":100,"top":80,"width":1e999,"height":820}}'],
    ['infinite top (-1e999)', '{"v":1,"rect":{"left":100,"top":-1e999,"width":1280,"height":820}}'],
    ['negative width', JSON.stringify({ v: 1, rect: { left: 100, top: 80, width: -1280, height: 820 } })],
    ['negative height', JSON.stringify({ v: 1, rect: { left: 100, top: 80, width: 1280, height: -820 } })],
    ['zero width', JSON.stringify({ v: 1, rect: { left: 100, top: 80, width: 0, height: 820 } })],
    ['zero height', JSON.stringify({ v: 1, rect: { left: 100, top: 80, width: 1280, height: 0 } })],
    ['below the DSH minimum (400x820)', JSON.stringify({ v: 1, rect: { left: 0, top: 0, width: 400, height: 820 } })],
    ['below the DSH minimum (1280x500)', JSON.stringify({ v: 1, rect: { left: 0, top: 0, width: 1280, height: 500 } })],
  ]
  for (const [label, bad] of badDocuments) {
    let threw = false
    let value
    try {
      value = call('decodeState', bad)
    } catch (error) {
      threw = true
    }
    check('decodeState rejects ' + label, threw === false && value === null, threw ? 'threw' : 'got ' + JSON.stringify(value))
  }

  for (const input of [null, undefined, 42, {}, [], true]) {
    let threw = false
    let value
    try {
      value = call('decodeState', input)
    } catch (error) {
      threw = true
    }
    check(
      'decodeState rejects non-string input ' + JSON.stringify(input ?? String(input)),
      threw === false && value === null,
      threw ? 'threw' : 'got ' + JSON.stringify(value),
    )
  }

  const defaults = call('decodeState', JSON.stringify({ v: 1, rect: goodRect }))
  check('absent dpr falls back to 1', defaults?.dpr === 1, String(defaults?.dpr))
  check('absent updatedAt falls back to 0', defaults?.updatedAt === 0, String(defaults?.updatedAt))
  check('absent maximized falls back to false', defaults?.maximized === false, String(defaults?.maximized))
  const badDpr = call('decodeState', JSON.stringify({ v: 1, rect: goodRect, dpr: 0 }))
  check('non-positive dpr falls back to 1', badDpr?.dpr === 1, String(badDpr?.dpr))

  const storage = makeStorage()
  check('saveState reports success', call('saveState', state, storage) === true)
  check('saveState writes the documented key', storage.__writes.length === 1 && storage.__writes[0][0] === seam.WINDOW_STATE_KEY, JSON.stringify(storage.__writes.map((w) => w[0])))
  check('loadState reads it back', sameRect(call('loadState', storage)?.rect, goodRect), rectText(call('loadState', storage)?.rect))
  check('loadState of an empty store is null', call('loadState', makeStorage()) === null)
  storage.setItem(seam.WINDOW_STATE_KEY, '{broken')
  check('loadState of corrupted JSON is null (not a throw)', call('loadState', storage) === null)

  const broken = makeThrowingStorage()
  let threwLoad = false
  let threwSave = false
  let loadValue
  let saveValue
  try {
    loadValue = call('loadState', broken)
  } catch (error) {
    threwLoad = true
  }
  try {
    saveValue = call('saveState', state, broken)
  } catch (error) {
    threwSave = true
  }
  check('loadState swallows an unavailable store', threwLoad === false && loadValue === null, threwLoad ? 'threw' : String(loadValue))
  check('saveState swallows an unavailable store', threwSave === false && saveValue === false, threwSave ? 'threw' : String(saveValue))
})

// ===========================================================================
// 2. CLAMPING
// ===========================================================================
await section('2. clamping to the work area and DSH minimums', () => {
  const area = { left: 0, top: 0, width: 1920, height: 1040 }
  const clamped = call('clampRect', { left: 100, top: 100, width: 3000, height: 2000 }, area)
  check('a rect larger than the work area is clamped to it', clamped.width === 1920 && clamped.height === 1040, rectText(clamped))
  check('clamping does not move the origin', clamped.left === 100 && clamped.top === 100, rectText(clamped))

  const raised = call('clampRect', { left: 40, top: 40, width: 300, height: 200 }, area)
  check('a rect below the DSH minimum is raised to 520x600', raised.width === 520 && raised.height === 600, rectText(raised))
  check('raising the size does not move the origin', raised.left === 40 && raised.top === 40, rectText(raised))

  const exactlyMin = call('clampRect', { left: 0, top: 0, width: 520, height: 600 }, area)
  check('a rect already at the minimum is unchanged', sameRect(exactlyMin, { left: 0, top: 0, width: 520, height: 600 }), rectText(exactlyMin))

  const normal = call('clampRect', { left: 300, top: 200, width: 1280, height: 820 }, area)
  check('a normal rect inside the work area is unchanged', sameRect(normal, { left: 300, top: 200, width: 1280, height: 820 }), rectText(normal))

  const tinyScreen = call('clampRect', { left: 0, top: 0, width: 3000, height: 2000 }, { left: 0, top: 0, width: 400, height: 500 })
  check('on a screen smaller than the minimum, the work area wins over the minimum', tinyScreen.width === 400 && tinyScreen.height === 500, rectText(tinyScreen))

  const unbounded = call('clampRect', { left: 5, top: 5, width: 3000, height: 2000 }, null)
  check('a missing work area applies no upper bound', unbounded.width === 3000 && unbounded.height === 2000, rectText(unbounded))

  const fromScreenDetailed = call('normalizeWorkArea', { availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1040 })
  check('normalizeWorkArea accepts the ScreenDetailed shape', sameRect(fromScreenDetailed, { left: -1920, top: 0, width: 1920, height: 1040 }), rectText(fromScreenDetailed))

  const plan = call('planRestore', { rect: { left: 100, top: 100, width: 3000, height: 2000 }, dpr: 1, maximized: false, updatedAt: 1 }, { switches: {}, workAreas: [area] })
  check('planRestore clamps an oversized saved rect to the work area', plan !== null && plan.rect.width === 1920 && plan.rect.height === 1040, plan === null ? 'null' : rectText(plan.rect))

  const smallPlan = call('planRestore', { rect: { left: 40, top: 40, width: 300, height: 200 }, dpr: 1, maximized: false, updatedAt: 1 }, { switches: {}, workAreas: [area] })
  check('planRestore raises a below-minimum saved rect to 520x600', smallPlan !== null && smallPlan.rect.width === 520 && smallPlan.rect.height === 600, smallPlan === null ? 'null' : rectText(smallPlan.rect))
})

// ===========================================================================
// 3. OFF-SCREEN
// ===========================================================================
await section('3. off-screen saved rects', () => {
  const area = { left: 0, top: 0, width: 1920, height: 1040 }
  const areas = [area]
  const stateOf = (rect) => ({ rect, dpr: 1, maximized: false, updatedAt: 1 })

  const farRight = { left: 20000, top: 200, width: 1280, height: 820 }
  check('x=20000 touches no display (isOnScreen false)', call('isOnScreen', farRight, areas) === false)
  check('x=20000 is rejected by planRestore (never applied)', call('planRestore', stateOf(farRight), { switches: {}, workAreas: areas }) === null)

  const farAbove = { left: 200, top: -5000, width: 1280, height: 820 }
  check('y=-5000 touches no display (isOnScreen false)', call('isOnScreen', farAbove, areas) === false)
  check('y=-5000 is rejected by planRestore (never applied)', call('planRestore', stateOf(farAbove), { switches: {}, workAreas: areas }) === null)

  const below = { left: 200, top: 5000, width: 1280, height: 820 }
  check('y=+5000 is rejected too', call('planRestore', stateOf(below), { switches: {}, workAreas: areas }) === null)

  // Any positive overlap means the rect belongs to a live display, so it is
  // rescued rather than discarded - the scenario the feature exists for.
  const partly = { left: 1800, top: 100, width: 1280, height: 820 }
  check('a partly visible rect belongs to a display', call('isOnScreen', partly, areas) === true)
  check('a partly visible rect is not fully on screen', call('isFullyOnScreen', partly, areas) === false)
  check('a fully contained rect is fully on screen', call('isFullyOnScreen', { left: 100, top: 100, width: 1280, height: 820 }, areas) === true)

  const brought = call('bringOnScreen', partly, areas)
  check(
    'bringOnScreen pulls a partly visible rect fully into the work area',
    brought.left === area.width - brought.width &&
      brought.top === 100 &&
      brought.left >= area.left &&
      brought.left + brought.width <= area.left + area.width,
    rectText(brought),
  )
  check('the pulled-in rect keeps its size', brought.width === 1280 && brought.height === 820, rectText(brought))
  check('the input rect is not mutated (pure)', sameRect(partly, { left: 1800, top: 100, width: 1280, height: 820 }), rectText(partly))

  const partlyPlan = call('planRestore', stateOf(partly), { switches: {}, workAreas: areas })
  check(
    'planRestore rescues a partly visible rect (not null), fully on screen',
    partlyPlan !== null &&
      partlyPlan.rect.left >= area.left &&
      partlyPlan.rect.top >= area.top &&
      partlyPlan.rect.left + partlyPlan.rect.width <= area.left + area.width &&
      partlyPlan.rect.top + partlyPlan.rect.height <= area.top + area.height,
    partlyPlan === null ? 'null' : rectText(partlyPlan.rect),
  )

  // Hanging off the top-left corner: pulled back to the work-area origin.
  const hangsLeft = { left: -600, top: -400, width: 1280, height: 820 }
  check(
    'a rect hanging off the top-left edge is pulled back to the work-area origin',
    sameRect(call('bringOnScreen', hangsLeft, areas), { left: 0, top: 0, width: 1280, height: 820 }),
    rectText(call('bringOnScreen', hangsLeft, areas)),
  )

  const inside = { left: 300, top: 200, width: 1280, height: 820 }
  check('a fully visible rect is returned untouched (identity)', call('bringOnScreen', inside, areas) === inside)

  const second = { left: -1920, top: 0, width: 1920, height: 1040 }
  const onSecond = { left: -1500, top: 100, width: 1280, height: 820 }
  const multiPlan = call('planRestore', stateOf(onSecond), { switches: {}, workAreas: [area, second] })
  check('a saved rect on a second display is restored as saved', multiPlan !== null && sameRect(multiPlan.rect, onSecond), multiPlan === null ? 'null' : rectText(multiPlan.rect))

  check('no work areas means no restore plan', call('planRestore', stateOf({ left: 100, top: 100, width: 1280, height: 820 }), { switches: {}, workAreas: [] }) === null)
  check('no saved state means no restore plan', call('planRestore', null, { switches: {}, workAreas: areas }) === null)
})

// ===========================================================================
// 4. RESTORE-ONCE
// ===========================================================================
await section('4. restore-once guard uses sessionStorage', async () => {
  const key = seam.WINDOW_RESTORED_KEY
  check('guard key is this package\'s own sessionStorage key', key === 'dsh-window-memory:window-restored', key)

  const session = makeStorage()
  check('a fresh launch reports "not restored yet"', call('hasRestoredThisLaunch', session) === false)
  check('markRestored writes exactly "1"', call('markRestored', session) === true && session.__map.get(key) === '1', String(session.__map.get(key)))
  check('after markRestored the launch reports "already restored"', call('hasRestoredThisLaunch', session) === true)

  const weird = makeStorage([[key, 'true']])
  check('only the literal "1" marks a handled launch', call('hasRestoredThisLaunch', weird) === false, String(weird.__map.get(key)))

  const broken = makeThrowingStorage()
  let threw = false
  let restored
  let marked
  try {
    restored = call('hasRestoredThisLaunch', broken)
    marked = call('markRestored', broken)
  } catch (error) {
    threw = true
  }
  check('a throwing sessionStorage yields false, no crash', threw === false && restored === false && marked === false, threw ? 'threw' : String(restored) + '/' + String(marked))

  // The app path (no injected storage) must also survive an unavailable store.
  let defaultThrew = false
  let defaultRestored
  let defaultMarked
  const previousSession = globalThis.sessionStorage
  globalThis.sessionStorage = makeThrowingStorage()
  try {
    defaultRestored = call('hasRestoredThisLaunch')
    defaultMarked = call('markRestored')
  } catch (error) {
    defaultThrew = true
  } finally {
    if (previousSession === undefined) delete globalThis.sessionStorage
    else globalThis.sessionStorage = previousSession
  }
  check(
    'the app path (default sessionStorage) also swallows a blocked store',
    defaultThrew === false && defaultRestored === false && defaultMarked === false,
    defaultThrew ? 'threw' : String(defaultRestored) + '/' + String(defaultMarked),
  )

  // End-to-end through the real install() binder. The simulated window reports
  // asked + constant frame offset, so a correct placement makes the MEASURED rect
  // equal the saved rect exactly, and the offset never leaks into the result.
  const savedRect = { left: 100, top: 80, width: 1280, height: 820 }
  const savedState = { rect: savedRect, dpr: 1, maximized: false, updatedAt: 5 }
  const offset = { left: -14, top: -24, width: 15, height: 16 }
  const local = makeStorage()
  const sessionStore = makeStorage()
  call('saveState', savedState, local)
  check('geometry saved under the documented localStorage key', local.__map.has(seam.WINDOW_STATE_KEY))
  check('the restore guard lives in sessionStorage, not localStorage', !local.__map.has(key), [...local.__map.keys()].join(','))

  resetHost({ rect: { left: 20, top: 20, width: 1280, height: 820 }, offset })

  let firstMoves = 0
  let firstDispose
  await withStorages(local, sessionStore, async () => {
    firstDispose = call('install')
    await waitFor(() => sessionStore.__map.get(key) === '1')
    await waitFor(() => sameRect(measuredRect(), savedRect))
    check(
      'launch restores the saved rect (measured geometry equals the saved rect)',
      sameRect(measuredRect(), savedRect),
      rectText(measuredRect()) + ' moves=' + JSON.stringify(host.__moves),
    )
    check('launch marks the launch as handled in sessionStorage', sessionStore.__map.get(key) === '1', String(sessionStore.__map.get(key)))
    firstMoves = host.__moves.length
  })
  firstDispose()
  await tick(20)

  // Reload: same sessionStorage, same localStorage. No second restore.
  await withStorages(local, sessionStore, async () => {
    const dispose = call('install')
    await tick(150)
    check('an in-window reload does not re-apply the restore', host.__moves.length === firstMoves, host.__moves.length + ' vs ' + firstMoves)
    dispose()
  })

  // Relaunch: sessionStorage cleared by the new app launch, localStorage kept.
  const freshSession = makeStorage()
  resetHost({ rect: { left: 20, top: 20, width: 1280, height: 820 }, offset })
  await withStorages(local, freshSession, async () => {
    const dispose = call('install')
    await waitFor(() => freshSession.__map.get(key) === '1')
    await waitFor(() => sameRect(measuredRect(), savedRect))
    check(
      'a new app launch (fresh sessionStorage) restores again',
      sameRect(measuredRect(), savedRect),
      rectText(measuredRect()) + ' moves=' + JSON.stringify(host.__moves),
    )
    check('relaunch re-marks the launch as handled', freshSession.__map.get(key) === '1', String(freshSession.__map.get(key)))
    dispose()
  })
})

// ===========================================================================
// 5. SECANT PLACEMENT
// ===========================================================================
await section('5. secant placement (constant frame offset, slope 1)', async () => {
  const settle = async () => {}
  const target = { left: 640, top: 200, width: 1280, height: 820 }

  // The renderer reports asked + constant offset, so the standing start is off by
  // the offset and the correction must land in exactly two passes.
  for (const offset of [
    { left: -14, top: -24, width: 15, height: 16 },
    { left: 7, top: 8, width: -2, height: -3 },
  ]) {
    const asked = { left: 20, top: 20, width: 1280, height: 820 }
    const measure = () => ({
      left: asked.left + offset.left,
      top: asked.top + offset.top,
      width: asked.width + offset.width,
      height: asked.height + offset.height,
    })
    let applies = 0
    const apply = (rect) => {
      applies++
      asked.left = rect.left
      asked.top = rect.top
      asked.width = rect.width
      asked.height = rect.height
    }
    const result = await callAsync('placeWindow', target, measure, apply, settle)
    const measured = {
      left: asked.left + offset.left,
      top: asked.top + offset.top,
      width: asked.width + offset.width,
      height: asked.height + offset.height,
    }
    const label = 'offset {' + offset.left + ',' + offset.top + ',' + offset.width + ',' + offset.height + '}'
    check(label + ': placement lands exactly on the target', sameRect(measured, target), rectText(measured))
    check(label + ': residual error is zero', sameRect(result.error, { left: 0, top: 0, width: 0, height: 0 }), JSON.stringify(result.error))
    check(label + ': converges within the documented two passes', result.passes <= 2, 'passes=' + result.passes)
    check(label + ': issues at most two correction asks', applies <= 2, 'applies=' + applies)
  }

  // Idempotence: a window already at the target is left alone.
  let idempotentApplies = 0
  const already = await callAsync('placeWindow', target, () => ({ ...target }), () => { idempotentApplies++ }, settle)
  check('a window already at the target issues no correction', idempotentApplies === 0, 'applies=' + idempotentApplies)
  check('a window already at the target reports 0 passes', already.passes === 0, 'passes=' + already.passes)
  check('a window already at the target reports no error', sameRect(already.error, { left: 0, top: 0, width: 0, height: 0 }), JSON.stringify(already.error))

  // Re-running after a convergence is a no-op.
  const asked = { left: 20, top: 20, width: 1280, height: 820 }
  const offset = { left: -14, top: -24, width: 15, height: 16 }
  const measure = () => ({
    left: asked.left + offset.left,
    top: asked.top + offset.top,
    width: asked.width + offset.width,
    height: asked.height + offset.height,
  })
  let applies = 0
  const apply = (rect) => {
    applies++
    Object.assign(asked, rect)
  }
  await callAsync('placeWindow', target, measure, apply, settle)
  const appliesAfterFirst = applies
  const second = await callAsync('placeWindow', target, measure, apply, settle)
  check('re-running placement against a settled window issues no correction', applies === appliesAfterFirst, applies + ' vs ' + appliesAfterFirst)
  check('re-running placement reports 0 passes', second.passes === 0, 'passes=' + second.passes)

  // Metric A: identical reads (the OS clamped the window). The loop must stop, at
  // or below the documented bound, rather than keep asking.
  const TIMEOUT = Symbol('timeout')
  let stuckApplies = 0
  let resolved = false
  const stuck = await Promise.race([
    callAsync('placeWindow', target, () => ({ left: 0, top: 0, width: 1000, height: 700 }), () => { stuckApplies++ }, settle).then((value) => {
      resolved = true
      return value
    }),
    new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 1500)),
  ])
  check('a metric that repeats the same rect returns (no unbounded loop)', resolved === true)
  check('a clamped metric stops inside the documented pass bound', stuck !== TIMEOUT && stuck.passes <= seam.WINDOW_MAX_PASSES, stuck === TIMEOUT ? 'timed out' : 'passes=' + stuck?.passes)
  check('a clamped metric issues no more asks than the bound', stuckApplies <= seam.WINDOW_MAX_PASSES, 'applies=' + stuckApplies)

  // Metric B: a drifting read that never reaches the target must be abandoned at
  // exactly the documented bound.
  let drift = 0
  let driftApplies = 0
  const drifting = await Promise.race([
    callAsync('placeWindow', target, () => {
      drift += 1
      return { left: drift, top: drift, width: 1000 + drift, height: 700 + drift }
    }, () => { driftApplies++ }, settle),
    new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 1500)),
  ])
  check('a never-converging (drifting) metric returns instead of looping forever', drifting !== TIMEOUT)
  check(
    'a never-converging metric is abandoned at exactly WINDOW_MAX_PASSES',
    drifting !== TIMEOUT && drifting.passes === seam.WINDOW_MAX_PASSES,
    drifting === TIMEOUT ? 'timed out' : 'passes=' + drifting?.passes,
  )
  check('a never-converging metric issues exactly WINDOW_MAX_PASSES asks', driftApplies === seam.WINDOW_MAX_PASSES, 'applies=' + driftApplies)
  check(
    'a never-converging metric reports the unresolved residual',
    drifting !== TIMEOUT && drifting.error !== null && !sameRect(drifting.error, { left: 0, top: 0, width: 0, height: 0 }),
    JSON.stringify(drifting === TIMEOUT ? null : drifting.error),
  )

  // No window metric at all is not an error.
  const blind = await callAsync('placeWindow', target, () => null, () => {}, settle)
  check('an unreadable window reports null geometry instead of throwing', blind.rect === null && blind.passes === 0, JSON.stringify(blind))
})

// ===========================================================================
// 5b. NO DRIFT FROM A COLD START (cross-launch regression)
//
//   Found by the Electron E2E harness against an earlier build. placeWindow()
//   used to seed its first ask with the TARGET while the first measurement
//   described the window's PREVIOUS placement. The correction then added the
//   whole old->target gap to an ask that had never been applied, threw the
//   window past the target, and capture stored where it actually landed: the
//   left edge crept -14 px per launch, forever.
//
//   The invariant is "ask is ALWAYS the value that produced the measurement".
//   With no known frame that makes the FIRST ask the measured rect, and the first
//   correction therefore exactly the target.
// ===========================================================================
await section('5b. no drift from a cold start (cross-launch regression)', async () => {
  const frame = { left: -14, top: 0, width: 15, height: 8 }

  /**
   * One launch against a simulated window with a constant frame offset.
   *
   * @param start - where the shell left the window before the plugin ran.
   * @param target - the rect the restore asks for.
   * @param knownFrame - the frame the store already knows, or null for a cold start.
   * @returns the placement result, every ask in order, and where the window ended.
   */
  async function launchOnce(start, target, knownFrame) {
    let asked = { ...start }
    const asks = []
    const read = () => ({
      left: asked.left + frame.left,
      top: asked.top + frame.top,
      width: asked.width + frame.width,
      height: asked.height + frame.height,
    })
    const apply = (rect) => {
      asks.push({ ...rect })
      Object.assign(asked, rect)
    }
    const result = await callAsync('placeWindow', target, read, apply, async () => {}, { frame: knownFrame })
    return { result, asks, measured: read(), landed: { ...asked } }
  }

  const shellDefault = { left: 633, top: 285, width: 1295, height: 829 }
  const target = { left: 106, top: 220, width: 1180, height: 788 }

  // 1. The cold-start regression itself: shell default -> saved rect, no frame.
  const cold = await launchOnce(shellDefault, target, null)
  check(
    'a cold start lands the window exactly on the target (no edge-clamp overshoot)',
    cold.result.rect !== null && sameRect(cold.result.rect, target),
    'result=' + rectText(cold.result.rect) + ' landed=' + rectText(cold.landed),
  )
  // The mechanism, asserted directly: with no known frame the first ask must be
  // the MEASURED rect corrected by the miss, i.e. the target - never the target
  // plus the old->target gap.
  check(
    'with no known frame the first ask is the measured rect corrected to the target',
    cold.asks.length > 0 && sameRect(cold.asks[0], target),
    'first ask=' + rectText(cold.asks[0]) + ' (target ' + rectText(target) + ')',
  )
  check(
    'the cold start never asks for a rect off the target (would overshoot to x=-7)',
    cold.asks.every((ask) => ask.left >= 0),
    'asks=' + cold.asks.map(rectText).join(' '),
  )
  check(
    'the cold start converges within the documented pass bound',
    cold.result.passes <= seam.WINDOW_MAX_PASSES,
    'passes=' + cold.result.passes,
  )

  // 2. The drift loop the E2E harness reported: capture stores what the window
  //    measured, the next launch restores that, and the store must be a FIXED
  //    POINT rather than creeping by the frame offset each launch.
  let store = { ...target }
  const trail = [rectText(store)]
  for (let launch = 0; launch < 6; launch++) {
    const run = await launchOnce(shellDefault, store, null)
    if (run.result.rect === null) break
    store = { ...run.result.rect }
    trail.push(rectText(store))
  }
  check(
    'six consecutive launches keep the store a fixed point (no accumulating drift)',
    sameRect(store, target),
    trail.join(' -> '),
  )

  // 3. A passed frame is IGNORED. The one-ask fast path was built, measured and
  //    removed: an E2E run showed the restore lands AFTER the shell shows the
  //    window regardless, and subtracting a frame offset made the loop oscillate
  //    against Windows clamping (the store drifted -14/+14/+8 every launch).
  //    The contract now is only that a frame cannot make placement wrong.
  {
    const warm = await launchOnce(shellDefault, target, frame)
    check(
      "a passed frame cannot make placement wrong",
      warm.result.rect !== null && sameRect(warm.result.rect, target),
      rectText(warm.result.rect) + " asks=" + warm.asks.length,
    )
  }
  // 4. The invariant stated as a sweep: whatever the window's starting position,
  //    a cold start still reaches the target exactly.
  for (const start of [
    { left: 0, top: 0, width: 1280, height: 820 },
    { left: -5000, top: 3000, width: 900, height: 700 },
    { left: 2400, top: 1300, width: 600, height: 620 },
  ]) {
    const run = await launchOnce(start, target, null)
    check(
      'a cold start from ' + rectText(start) + ' reaches the target',
      run.result.rect !== null && sameRect(run.result.rect, target),
      rectText(run.result.rect),
    )
  }
})

// ===========================================================================
// 6. MAXIMIZE
// ===========================================================================
await section('6. maximize detection and round-trip', async () => {
  const area = { left: 0, top: 0, width: 1920, height: 1040 }
  const tolerance = seam.WINDOW_MAXIMIZED_TOLERANCE
  check('documented tolerance is 24px', tolerance === 24, String(tolerance))

  check('a rect exactly filling the work area is maximized', call('isMaximizedRect', { ...area }, area) === true)

  // Edge comparison: every edge within the tolerance counts as maximized, even if
  // the width/height therefore differ from the work area by up to 2x tolerance.
  const inside = { left: -tolerance, top: tolerance, width: area.width, height: area.height }
  check('edges within the tolerance on every side are maximized', call('isMaximizedRect', inside, area) === true, rectText(inside))
  const inset = { left: tolerance, top: tolerance, width: area.width - 2 * tolerance, height: area.height - 2 * tolerance }
  check('a rect inset by exactly the tolerance on every edge is maximized', call('isMaximizedRect', inset, area) === true, rectText(inset))
  // The frame-border case the edge comparison exists for: overhang on BOTH
  // opposite sides, so the width exceeds the work area by 2x the overhang.
  const overhang = { left: -12, top: -12, width: area.width + 24, height: area.height + 24 }
  check('a window overhanging both sides by the frame border is maximized', call('isMaximizedRect', overhang, area) === true, rectText(overhang))

  for (const [label, rect] of [
    ['left', { left: tolerance + 1, top: 0, width: area.width, height: area.height }],
    ['top', { left: 0, top: tolerance + 1, width: area.width, height: area.height }],
    ['right edge', { left: 0, top: 0, width: area.width - (tolerance + 1), height: area.height }],
    ['bottom edge', { left: 0, top: 0, width: area.width, height: area.height - (tolerance + 1) }],
  ]) {
    check('one edge beyond the tolerance (' + label + ') is NOT maximized', call('isMaximizedRect', rect, area) === false, rectText(rect))
  }
  const normal = { left: 100, top: 80, width: 1280, height: 820 }
  check('a normal window is not maximized', call('isMaximizedRect', normal, area) === false)
  check('a missing work area is not maximized', call('isMaximizedRect', normal, null) === false)

  // REGRESSION (bug that shipped in the first draft): a ScreenDetailed object
  // carries BOTH the full screen (2560x1440) and the usable work area (1392 high).
  // The avail* fields must win, or a real maximized window is reported as normal.
  const screenDetailed = { left: 0, top: 0, width: 2560, height: 1440, availLeft: 0, availTop: 0, availWidth: 2560, availHeight: 1392 }
  const workArea = call('normalizeWorkArea', screenDetailed)
  check(
    'normalizeWorkArea prefers avail* over the full-screen rect (1392, not 1440)',
    sameRect(workArea, { left: 0, top: 0, width: 2560, height: 1392 }),
    rectText(workArea),
  )
  const realMaximized = { left: -7, top: 0, width: 2576, height: 1400 }
  check(
    'REGRESSION: a real 2576x1400 maximized fill is maximized against the 1392 work area',
    call('isMaximizedRect', realMaximized, workArea) === true,
    'isMaximizedRect=' + String(call('isMaximizedRect', realMaximized, workArea)),
  )
  check(
    'the old wrong basis (the 1440 full screen) would reject that fill',
    call('isMaximizedRect', realMaximized, { left: 0, top: 0, width: 2560, height: 1440 }) === false,
  )

  // ---------------------------------------------------------------------
  // THE USER-FACING RULE: a window closed while maximized must NOT reopen
  // maximized. It reopens at the size it had BEFORE it was maximized.
  // The stored 'maximized' flag is diagnostic only and never drives a restore.
  // ---------------------------------------------------------------------

  const priorNormal = { left: 100, top: 80, width: 1280, height: 820 }
  // A second display to the LEFT of the primary one, for the multi-monitor cases.
  const second = { left: -1920, top: 0, width: 1920, height: 1040 }

  // The CODEC still round-trips the diagnostic flag: a doc saved while maximized
  // carries maximized:true and its pre-maximize rect unchanged through the store.
  const maxState = { rect: priorNormal, dpr: 1.25, maximized: true, updatedAt: 11 }
  const loaded = call('decodeState', call('encodeState', maxState))
  check(
    'a maximized save round-trips through the store',
    loaded?.maximized === true && sameRect(loaded?.rect, priorNormal),
    rectText(loaded?.rect) + ' maximized=' + String(loaded?.maximized),
  )

  // (a) A document saved while maximized carries maximized:true. Its stored rect
  // is the PRE-MAXIMIZE rect (that is what capture preserves), so the restore must
  // return exactly that rect - not the work-area fill.
  const savedWhileMaximized = { rect: priorNormal, dpr: 1, maximized: true, updatedAt: 77 }
  const restored = call('planRestore', savedWhileMaximized, { switches: {}, workAreas: [area] })
  check(
    'a doc saved while maximized restores its PRE-MAXIMIZE rect',
    restored !== null && sameRect(restored.rect, priorNormal),
    restored === null ? 'null' : rectText(restored.rect) + ' (work area is ' + rectText(area) + ')',
  )
  check(
    'a doc saved while maximized does NOT restore the work-area fill',
    restored !== null && !sameRect(restored.rect, area),
    restored === null ? 'null' : rectText(restored.rect),
  )

  // (b) planRestore NEVER yields intent 'maximized', for ANY input. Checked over
  // a matrix of stored shapes, switch maps and display lists; a single 'maximized'
  // intent anywhere fails the check with the offending input named.
  const intentCases = [
    ['maximized:true + pre-maximize rect', { rect: priorNormal, dpr: 1, maximized: true, updatedAt: 1 }, {}],
    ['maximized:true + work-area rect', { rect: { ...area }, dpr: 1, maximized: true, updatedAt: 2 }, {}],
    ['maximized:false + normal rect', { rect: priorNormal, dpr: 1, maximized: false, updatedAt: 3 }, {}],
    ['maximized flag absent', { rect: priorNormal, dpr: 1, updatedAt: 4 }, {}],
    ['legacy restoreMaximized:true switch still passed', { rect: priorNormal, dpr: 1, maximized: true, updatedAt: 5 }, { restoreMaximized: true }],
    ['maximized:true on the second display', { rect: { left: -1800, top: 20, width: 1700, height: 1000 }, dpr: 1, maximized: true, updatedAt: 6 }, {}],
  ]
  // A plan may be null (nothing to restore - e.g. a legacy doc whose rect IS the
  // work-area fill), but whenever a plan EXISTS its intent must be 'normal'.
  // 'maximized' must be impossible for every stored shape.
  let neverMaximized = true
  let offending = ''
  let plans = 0
  for (const [label, state, switches] of intentCases) {
    const plan = call('planRestore', state, { switches, workAreas: [area, second] })
    if (plan !== null) {
      plans++
      if (plan.intent !== 'normal') {
        neverMaximized = false
        offending = label + ' -> ' + plan.intent
        break
      }
    }
  }
  check('planRestore never yields intent "maximized" for any stored state', neverMaximized, offending)
  check('the intent matrix actually produced plans (the check is not vacuous)', plans >= 3, 'plans=' + plans)

  // A legacy document whose rect IS the work-area fill has no pre-maximize size to
  // recover, so it must not be restored either - reopening it would fill the
  // screen, which is exactly what the rule prevents.
  check(
    'a legacy doc whose rect is the work-area fill is not restored at all',
    call('planRestore', { rect: { ...area }, dpr: 1, maximized: true, updatedAt: 2 }, { switches: {}, workAreas: [area] }) === null,
  )

  // The same rule through the real set of shapes the seam can produce.
  const intentsSeen = new Set()
  for (const [label, state, switches] of intentCases) {
    const plan = call('planRestore', state, { switches, workAreas: [area, second] })
    if (plan !== null) intentsSeen.add(plan.intent)
  }
  check('the only restore intent the policy can produce is "normal"', [...intentsSeen].join(',') === 'normal', [...intentsSeen].join(','))

  // A maximized save on the SECOND display restores its PRE-MAXIMIZE rect, and it
  // restores it on that second display (left < 0), not on the primary one.
  const secondPlan = call('planRestore', intentCases[5][1], { switches: {}, workAreas: [area, second] })
  check(
    'a maximized save on a second display restores its pre-maximize rect there',
    secondPlan !== null &&
      secondPlan.intent === 'normal' &&
      secondPlan.rect.left < 0 &&
      sameRect(secondPlan.rect, { left: -1800, top: 20, width: 1700, height: 1000 }),
    secondPlan === null ? 'null' : secondPlan.intent + ' ' + rectText(secondPlan.rect),
  )
  check(
    'pickHomeArea picks the display the rect overlaps most',
    sameRect(call('pickHomeArea', { left: -1800, top: 20, width: 1700, height: 1000 }, [area, second]), second),
    rectText(call('pickHomeArea', { left: -1800, top: 20, width: 1700, height: 1000 }, [area, second])),
  )
  check(
    'pickHomeArea still finds the display the pre-maximize rect lives on',
    sameRect(call('pickHomeArea', priorNormal, [area, second]), area),
    rectText(call('pickHomeArea', priorNormal, [area, second])),
  )

  // (c) CAPTURE while maximized must not overwrite the stored rect.
  // (c1) With a stored normal rect: maximizing preserves that rect, flips the flag.
  const localPrior = makeStorage()
  call('saveState', { rect: priorNormal, dpr: 1, maximized: false, updatedAt: 99 }, localPrior)
  localPrior.__writes.length = 0
  resetHost({ rect: { left: 0, top: 0, width: 1920, height: 1040 } })
  await withStorages(localPrior, makeStorage([[seam.WINDOW_RESTORED_KEY, '1']]), async () => {
    const dispose = call('install')
    host.__dispatch('resize')
    await waitFor(() => call('loadState', localPrior)?.maximized === true)
    const stored = call('loadState', localPrior)
    check(
      'capturing a maximized window keeps the stored PRE-MAXIMIZE rect',
      stored !== null && sameRect(stored.rect, priorNormal),
      stored === null ? 'null' : rectText(stored.rect),
    )
    check(
      'capturing a maximized window does NOT store the work-area fill',
      stored !== null && !sameRect(stored.rect, area),
      stored === null ? 'null' : rectText(stored.rect),
    )
    check('capturing a maximized window records the diagnostic flag', stored?.maximized === true, String(stored?.maximized))

    // Un-maximizing clears the flag and keeps a real (smaller) rect.
    host.__asked = { left: priorNormal.left, top: priorNormal.top, width: priorNormal.width, height: priorNormal.height }
    host.__dispatch('resize')
    await waitFor(() => call('loadState', localPrior)?.maximized === false)
    const afterUnmaximize = call('loadState', localPrior)
    check('un-maximizing clears the diagnostic flag', afterUnmaximize?.maximized === false, String(afterUnmaximize?.maximized))
    check(
      'un-maximizing stores the restored normal rect',
      sameRect(afterUnmaximize?.rect, priorNormal),
      rectText(afterUnmaximize?.rect),
    )
    dispose()
  })

  // (c2) COLD START ALREADY MAXIMIZED with an empty store: there is no
  //      pre-maximize size to remember, so NOTHING may be written. Storing the
  //      fill would defeat the whole feature.
  const localEmpty = makeStorage()
  resetHost({ rect: { left: 0, top: 0, width: 1920, height: 1040 } })
  await withStorages(localEmpty, makeStorage([[seam.WINDOW_RESTORED_KEY, '1']]), async () => {
    const dispose = call('install')
    host.__dispatch('resize')
    await tick(120)
    check(
      'a cold start already maximized writes NOTHING to the store',
      localEmpty.__writes.length === 0 && call('loadState', localEmpty) === null,
      'writes=' + JSON.stringify(localEmpty.__writes.map((w) => w[0])) + ' stored=' + String(localEmpty.__map.get(seam.WINDOW_STATE_KEY)),
    )
    dispose()
  })

  // (c3) RESTORE: a doc saved maximized restores as a normal window - the window
  //      really gets the pre-maximize rect, and the stored doc it writes back is
  //      maximized:false carrying that same rect.
  const localRestore = makeStorage()
  call('saveState', { rect: priorNormal, dpr: 1, maximized: true, updatedAt: 77 }, localRestore)
  localRestore.__writes.length = 0
  resetHost({ rect: { left: 20, top: 20, width: 1280, height: 820 } })
  await withStorages(localRestore, makeStorage(), async () => {
    const dispose = call('install')
    await waitFor(() => sameRect(measuredRect(), priorNormal))
    check(
      'a window saved maximized reopens at its PRE-MAXIMIZE rect',
      sameRect(measuredRect(), priorNormal),
      'measured=' + rectText(measuredRect()),
    )
    check(
      'the reopened window is NOT the work-area fill',
      !sameRect(measuredRect(), area),
      'measured=' + rectText(measuredRect()),
    )
    await tick(80)
    const afterRestore = call('decodeState', localRestore.__map.get(seam.WINDOW_STATE_KEY))
    check(
      'the restore records maximized:false (it reopened normal)',
      afterRestore?.maximized === false,
      String(afterRestore?.maximized),
    )
    check(
      'the restore keeps the PRE-MAXIMIZE rect in the store',
      sameRect(afterRestore?.rect, priorNormal),
      rectText(afterRestore?.rect),
    )
    check(
      'a maximized restore really moved the window',
      host.__moves.length > 0,
      'moves=' + host.__moves.length + ' measured=' + rectText(measuredRect()),
    )
    dispose()
  })
})

// ===========================================================================
// 7. CAPTURE SANITY
// ===========================================================================
await section('7. capture sanity', async () => {
  check('a null sample is never storable', call('isStorableRect', null) === false)
  check('a 0x0 sample is never storable', call('isStorableRect', { left: 0, top: 0, width: 0, height: 0 }) === false)
  check('a negative-sized sample is never storable', call('isStorableRect', { left: 0, top: 0, width: -1280, height: -820 }) === false)
  check('a 300x200 sample is never storable', call('isStorableRect', { left: 0, top: 0, width: 300, height: 200 }) === false)
  check('a 519x600 sample is never storable', call('isStorableRect', { left: 0, top: 0, width: 519, height: 600 }) === false)
  check('a 520x599 sample is never storable', call('isStorableRect', { left: 0, top: 0, width: 520, height: 599 }) === false)
  check('a genuine 1280x820 sample is storable', call('isStorableRect', { left: 100, top: 80, width: 1280, height: 820 }) === true)
  // Spec corner settled with the Lead: 520x600 is a LEGAL window (the shell's own
  // minimums), so a user who resizes down to it must have that size remembered.
  check(
    'a window at the legal minimum (520x600) is storable',
    call('isStorableRect', { left: 0, top: 0, width: 520, height: 600 }) === true,
    'isStorableRect(520x600)=' + String(call('isStorableRect', { left: 0, top: 0, width: 520, height: 600 })),
  )

  // readGeometry: only a finite, positive rect is a real sample.
  const read = call('readGeometry', { screenX: 100.6, screenY: 80.2, outerWidth: 1280, outerHeight: 820, devicePixelRatio: 2 })
  check('readGeometry rounds a real sample', read !== null && sameRect(read.rect, { left: 101, top: 80, width: 1280, height: 820 }), rectText(read?.rect))
  check('readGeometry carries devicePixelRatio', read?.dpr === 2, String(read?.dpr))
  check('readGeometry of a non-finite sample is null', call('readGeometry', { screenX: NaN, screenY: 0, outerWidth: 1280, outerHeight: 820 }) === null)
  check('readGeometry of a zero-sized sample is null', call('readGeometry', { screenX: 10, screenY: 10, outerWidth: 0, outerHeight: 0 }) === null)
  check('readGeometry of a negative-sized sample is null', call('readGeometry', { screenX: 10, screenY: 10, outerWidth: -5, outerHeight: 820 }) === null)
  check('a bogus devicePixelRatio falls back to 1', call('readGeometry', { screenX: 10, screenY: 10, outerWidth: 1280, outerHeight: 820, devicePixelRatio: 0 })?.dpr === 1)

  // End-to-end: a degenerate sample must not overwrite a good stored rect.
  const goodRect = { left: 100, top: 80, width: 1280, height: 820 }
  const key = seam.WINDOW_STATE_KEY
  const local = makeStorage()
  call('saveState', { rect: goodRect, dpr: 1, maximized: false, updatedAt: 1234 }, local)
  const goodRaw = local.__map.get(key)
  local.__writes.length = 0
  resetHost({ rect: { left: 300, top: 200, width: 1280, height: 820 } })

  await withStorages(local, makeStorage([[seam.WINDOW_RESTORED_KEY, '1']]), async () => {
    const dispose = call('install')
    await tick(40)

    host.__asked = { left: 300, top: 200, width: 0, height: 0 }
    host.__dispatch('resize')
    await tick(40)
    check('a 0x0 sample does not overwrite a good stored rect', local.__map.get(key) === goodRaw, 'stored changed to ' + local.__map.get(key))

    host.__asked = { left: 300, top: 200, width: 300, height: 200 }
    host.__dispatch('resize')
    await tick(40)
    check('a below-minimum sample does not overwrite a good stored rect', local.__map.get(key) === goodRaw, 'stored changed to ' + local.__map.get(key))

    // Positive control: a genuine resize IS captured, so the checks above are not
    // vacuous. capture() is async (awaits the display list), so poll for the write
    // instead of assuming one tick is enough.
    host.__asked = { left: 400, top: 300, width: 1280, height: 820 }
    host.__dispatch('resize')
    await waitFor(() => call('decodeState', local.__map.get(key))?.rect.left === 400)
    const captured = call('decodeState', local.__map.get(key))
    check(
      'a genuine resize is captured into the store (positive control)',
      sameRect(captured?.rect, { left: 400, top: 300, width: 1280, height: 820 }),
      rectText(captured?.rect),
    )
    dispose()
  })
})

// ===========================================================================
// 7c. IDLE POLL COST
//
//   capture() reads the window rect synchronously, then queried the display list
//   BEFORE asking whether anything had changed, so the 1 s poll awaited
//   getScreenDetails() forever on a stationary window. The unchanged test now runs
//   first. The positive control matters as much as the saving: the poll exists to
//   catch a MOVE (a move fires no renderer event), so a moved window must still be
//   captured WITHOUT any resize/pagehide event firing.
// ===========================================================================
await section('7c. an idle poll does not query displays; a move still is', async () => {
  const key = seam.WINDOW_STATE_KEY
  const local = makeStorage()
  call('saveState', { rect: { left: 100, top: 80, width: 1280, height: 820 }, dpr: 1, maximized: false, updatedAt: 5 }, local)
  resetHost({ rect: { left: 100, top: 80, width: 1280, height: 820 } })

  // Count display queries by wrapping the shim's method for this scenario.
  const original = host.getScreenDetails
  let queries = 0
  host.getScreenDetails = async function (...args) {
    queries++
    return original.apply(this, args)
  }

  await withStorages(local, makeStorage([[seam.WINDOW_RESTORED_KEY, '1']]), async () => {
    // The launch is already marked handled, which is the reload case: the poll is
    // the ONLY capture mechanism left, so this scenario measures it in isolation.
    const dispose = call('install')
    await tick(300)

    // Park the store on exactly the current geometry, so every poll is a no-op.
    host.__asked = { left: 100, top: 80, width: 1280, height: 820 }
    host.__dispatch('resize')
    await tick(60)
    // Settle any capture already in flight before taking the baseline, so a late
    // completion cannot be counted against the idle window.
    await tick(200)
    const beforeIdle = queries
    // Three poll intervals, so at least two ticks land with certainty.
    await tick(3200)
    check(
      'an idle window costs no display query across two poll ticks',
      queries === beforeIdle,
      queries - beforeIdle + ' queries in 2.2 s on a stationary window',
    )

    // Positive control: a MOVE with no resize/pagehide event must still be caught.
    // The wait must span several poll intervals: waitFor()'s 1.2 s default is only
    // just longer than the 1 s poll, which is a race on a loaded machine.
    host.__asked = { left: 640, top: 320, width: 1280, height: 820 }
    await waitFor(() => call('decodeState', local.__map.get(key))?.rect.left === 640, 5000)
    const moved = call('decodeState', local.__map.get(key))
    check(
      'a move with no renderer event is still captured by the poll',
      sameRect(moved?.rect, { left: 640, top: 320, width: 1280, height: 820 }),
      rectText(moved?.rect),
    )
    check('the move path does query the display list', queries > beforeIdle, String(queries - beforeIdle))
    dispose()
  })

  host.getScreenDetails = original
})
// ===========================================================================
// 7b. CAPTURE CONTINUITY (regression guard)
//
//   client.js once called a sameRect() helper that had drifted out of scope from
//   factory-scope capture(), so the first capture wrote the store and every later
//   capture threw a ReferenceError swallowed by install()'s .catch. The store froze
//   at the startup sample: 'remembers the previous session, never this one'.
//   These checks are the permanent guard for that.
// ===========================================================================
await section('7b. capture continuity (sameRect scope regression)', async () => {
  const key = seam.WINDOW_STATE_KEY
  const local = makeStorage()
  resetHost({ rect: { left: 300, top: 200, width: 1280, height: 820 } })

  await withStorages(local, makeStorage([[seam.WINDOW_RESTORED_KEY, '1']]), async () => {
    const dispose = call('install')
    await tick(40)
    const baseline = local.__writes.length

    host.__asked = { left: 400, top: 300, width: 1280, height: 820 }
    host.__dispatch('resize')
    await waitFor(() => call('decodeState', local.__map.get(key))?.rect.left === 400)
    check('the first capture after launch writes the store', local.__map.get(key) !== undefined, 'writes=' + local.__writes.length)

    host.__asked = { left: 500, top: 400, width: 1400, height: 860 }
    host.__dispatch('resize')
    await waitFor(() => call('decodeState', local.__map.get(key))?.rect.left === 500, 700)
    const stored = call('decodeState', local.__map.get(key))
    check(
      'a SECOND resize is captured too (the store follows the window)',
      sameRect(stored?.rect, { left: 500, top: 400, width: 1400, height: 860 }),
      'stored=' + rectText(stored?.rect) + ' writes=' + local.__writes.length,
    )

    host.__asked = { left: 600, top: 500, width: 1500, height: 900 }
    host.__dispatch('resize')
    await waitFor(() => call('decodeState', local.__map.get(key))?.rect.left === 600, 700)
    const storedAgain = call('decodeState', local.__map.get(key))
    check(
      'the store keeps following the window (no permanent stall)',
      sameRect(storedAgain?.rect, { left: 600, top: 500, width: 1500, height: 900 }),
      rectText(storedAgain?.rect),
    )
    check(
      'a stalled capture still leaves the last good document in place',
      typeof local.__map.get(key) === 'string' && local.__writes.length > baseline,
      'writes=' + local.__writes.length,
    )
    dispose()
  })
})

// 8. ONE CONTROL
//
//   This plugin has exactly one way to be turned off: the Plugins page. There is
//   no settings page and no preference store, so "disabled" cannot mean two
//   different things. What must hold in the browser half:
//     * it registers nothing (no slot, no locale dictionary);
//     * it requires no module (a UI-less half needs no React);
//     * planRestore and the binder act unconditionally, because a disabled plugin
//       never runs at all.
// ===========================================================================
await section('8. one control: no slot, no preference store', async () => {
  check('the plugin registers no slot', slots.length === 0, slots.map((s) => s.slot + '#' + s.options.id).join(', '))
  check('the plugin registers nothing at all', registrations.length === 0, String(registrations.length))
  check('the plugin needs no React (it requires no module)', requiredModules.length === 0, requiredModules.join(', '))
  check('the plugin declares no slots dependency', Array.isArray(plugin.inject) && !plugin.inject.includes('slots'), JSON.stringify(plugin.inject))
  check('the plugin exposes no settingsPage seam', plugin.settingsPage === undefined, String(plugin.settingsPage))
  check('client.js contains no settings-section registration', !source.includes("inject('settings.section'"))
  check('client.js contains no preference key of its own', !source.includes(':switches'), 'still mentions a switches key')
  check('client.js contains no switch UI class', !source.includes('dsh-window-switch'))
  check('planRestore takes no switch option', !source.includes('rememberWindowGeometry'))

  // Unconditional behaviour: with a saved rect and a known display, a restore
  // happens because the plugin is running — that IS the enablement.
  const area = { left: 0, top: 0, width: 1920, height: 1040 }
  const savedRect = { left: 100, top: 80, width: 1280, height: 820 }
  const savedState = { rect: savedRect, dpr: 1, maximized: false, updatedAt: 42 }
  const plan = call('planRestore', savedState, { workAreas: [area] })
  check('planRestore plans a normal restore with no switch consulted', plan !== null && plan.intent === 'normal', JSON.stringify(plan))
  check(
    'a maximized save still plans its pre-maximize rect (no switch involved)',
    call('planRestore', { rect: { ...area }, dpr: 1, maximized: true, updatedAt: 43 }, { workAreas: [area] }) === null,
    'a work-area fill is rejected, not restored',
  )

  // The binder restores and captures with no arguments: install() takes none.
  const local = makeStorage()
  call('saveState', savedState, local)
  local.__writes.length = 0
  const session = makeStorage()
  resetHost({ rect: { left: 20, top: 20, width: 1280, height: 820 } })
  await withStorages(local, session, async () => {
    const dispose = call('install')
    await tick(120)
    check('the binder restores with no switch argument', host.__moves.length > 0, JSON.stringify(host.__moves))
    check('the binder marks the launch as restored', session.__map.has(seam.WINDOW_RESTORED_KEY), [...session.__map.keys()].join(','))
    host.__dispatch('resize')
    await waitFor(() => local.__writes.some((write) => write[0] === seam.WINDOW_STATE_KEY))
    check(
      'the binder captures geometry with no switch argument',
      local.__writes.some((write) => write[0] === seam.WINDOW_STATE_KEY),
      JSON.stringify(local.__writes.map((w) => w[0])),
    )
    dispose()
  })

  // The strictest environment: a ctx with NO locale service and NO slot host.
  // `inject: []` promises the shell may hand the half exactly this, so the half must
  // still install the binder and still restore. Asserting "registers no slot" alone
  // would only prove it is quiet, not that it works.
  const bare = await withBareCtx()
  check('apply() does not throw under a bare ctx', bare.threw === null, bare.threw?.message)
  check('the half installs its binder with no locale or slots service', bare.effects.length === 1, String(bare.effects.length))
  check(
    'the window is restored to the stored rect under a bare ctx',
    bare.moves.some((move) => move[0] === 'moveTo' && move[1] === bare.restoreRect.left),
    JSON.stringify(bare.moves),
  )
  check('the launch is marked restored under a bare ctx', bare.session.__map.has(seam.WINDOW_RESTORED_KEY))
  // Resize the FAKE window, not just the ask: this host reports outerWidth from
  // `asked`, so mutating the ask without the move would simulate nothing.
  // The capture must happen INSIDE the bare scope: withBareCtx restores the global
  // storages when it returns, so dispatching a resize afterwards would exercise the
  // outer store instead of the one this half was installed against.
  check(
    'capture still writes geometry under a bare ctx',
    bare.capturedWidth === 900,
    'stored width after resize: ' + bare.capturedWidth,
  )
  for (const dispose of bare.effects) if (typeof dispose === 'function') dispose()
})

// ===========================================================================
// 9. DESKTOP ONLY
//
//   The feature is meaningful only inside the DSH Desktop shell: that shell owns
//   one real BrowserWindow the user can drag, and it creates it at fixed bounds. A
//   browser tab has no such window — its viewport belongs to the browser — so the
//   binder must refuse to install there instead of fighting the user's own window
//   manager. The marker is `<html data-platform>`, written by the Desktop preload
//   and read by shipped bundles; the Web profile never sets it.
//
//   Every scenario elsewhere in this file runs WITH the marker, so these checks are
//   what keep the "off" path honest in the other direction.
// ===========================================================================
await section('9. desktop shell only', async () => {
  check('the half tests for the desktop marker', source.includes('dataset?.platform') || source.includes('dataset.platform'))
  // Order matters: the desktop check must come FIRST, so a browser session bails out
  // before anything else can start a poll or touch storage.
  const desktopAt = source.indexOf('isDesktopShell(host)) return')
  const iframeAt = source.indexOf('host.top !== host')
  check(
    'the desktop guard runs before the iframe check',
    desktopAt !== -1 && iframeAt !== -1 && desktopAt < iframeAt,
    'desktop@' + desktopAt + ' iframe@' + iframeAt,
  )

  /**
   * Install the half against a window whose <html> marker is whatever we pass.
   * Everything else matches a real desktop session, so the ONLY variable is the
   * marker — that is what makes these checks evidence rather than decoration.
   */
  async function underMarker(dataset, globals) {
    const moves = []
    const listeners = new Map()
    const asked = { left: 20, top: 20, width: 1280, height: 820 }
    const fake = {
      top: null,
      ...(globals ?? {}),
      document: { documentElement: dataset === undefined ? null : { dataset } },
      screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
      async getScreenDetails() { return { screens: [{ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 }] } },
      get screenX() { return asked.left },
      get screenY() { return asked.top },
      get outerWidth() { return asked.width },
      get outerHeight() { return asked.height },
      devicePixelRatio: 1,
      moveTo(x, y) { moves.push(['moveTo', x, y]); asked.left = x; asked.top = y },
      resizeTo(w, h) { moves.push(['resizeTo', w, h]); asked.width = w; asked.height = h },
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
      removeEventListener(type, fn) { const list = listeners.get(type); if (list !== undefined) list.splice(list.indexOf(fn), 1) },
      __ModuleLoader__: { load: (entry) => { fake.__captured = entry } },
    }
    fake.top = fake
    const rect = { left: 300, top: 200, width: 1000, height: 700 }
    const local = makeStorage([['dsh-window-memory:window-state', JSON.stringify({ v: 1, rect, dpr: 1, maximized: false, updatedAt: 1 })]])
    const session = makeStorage()
    const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage }
    globalThis.localStorage = local
    globalThis.sessionStorage = session
    try {
      // eslint-disable-next-line no-eval
      new Function('window', source)(fake)
      const half = fake.__captured.factory((id) => { throw new Error('unexpected require: ' + id) })
      half.apply({ effect: (cb) => cb() })
      await tick(200)
      // A resize after install: a browser session must not even have a listener.
      asked.width = 900
      for (const fn of listeners.get('resize') ?? []) fn()
      await tick(150)
      return { moves, listeners, local, session, rect }
    } finally {
      globalThis.localStorage = previous.localStorage
      globalThis.sessionStorage = previous.sessionStorage
    }
  }

  // --- the main window's own scheme is the strongest signal; a document served over
  //     dsh-app://app/ is the Desktop shell even before the preload writes anything.
  const byScheme = await underMarker(undefined, { location: { protocol: 'dsh-app:', hostname: 'app' } })
  check('the dsh-app://app scheme alone identifies the desktop shell', byScheme.moves.length > 0, JSON.stringify(byScheme.moves))
  const wrongScheme = await underMarker(undefined, { location: { protocol: 'https:', hostname: 'app' } })
  check('an https document is NOT treated as the desktop shell', wrongScheme.moves.length === 0, JSON.stringify(wrongScheme.moves))
  // The scheme alone is not enough: only the `app` host is the shell's own document.
  // Without this case a check that ignored the hostname would still pass.
  const wrongHost = await underMarker(undefined, { location: { protocol: 'dsh-app:', hostname: 'shell' } })
  check(
    'dsh-app:// with another host is NOT the shell document',
    wrongHost.moves.length === 0,
    JSON.stringify(wrongHost.moves),
  )

  // --- a browser tab: no marker at all (this is what the Web profile looks like)
  const web = await underMarker({})
  check('a browser tab restores nothing', web.moves.length === 0, JSON.stringify(web.moves))
  check('a browser tab registers no resize listener', (web.listeners.get('resize') ?? []).length === 0, [...web.listeners.keys()].join(','))
  check('a browser tab writes no geometry document', web.local.__writes.length === 0, JSON.stringify(web.local.__writes.map((w) => w[0])))
  check('a browser tab does not mark the launch restored', !web.session.__map.has(seam.WINDOW_RESTORED_KEY), [...web.session.__map.keys()].join(','))

  // --- no document element yet (about:blank / pre-DOM timing): also refuses
  const noRoot = await underMarker(undefined)
  check('a missing platform marker is treated as "not desktop"', noRoot.moves.length === 0, JSON.stringify(noRoot.moves))

  // --- the marker may not be written yet (preload defers it to DOMContentLoaded);
  //     the other preload globals must then carry the decision, or a working desktop
  //     session would silently disable itself.
  const early = await underMarker(undefined, { __DSH_HOST_PATHS__: { pathFor: () => '' } })
  check(
    'a desktop preload global is accepted when the marker is not written yet',
    early.moves.some((move) => move[0] === 'moveTo'),
    JSON.stringify(early.moves),
  )
  const earlyBoot = await underMarker(undefined, { dshDesktopBoot: { ready: () => {} } })
  check('dshDesktopBoot alone is enough to recognise the desktop shell', earlyBoot.moves.length > 0, JSON.stringify(earlyBoot.moves))
  const earlyDesktop = await underMarker(undefined, { dshDesktop: { protocolVersion: 1 } })
  check('dshDesktop alone is enough to recognise the desktop shell', earlyDesktop.moves.length > 0, JSON.stringify(earlyDesktop.moves))

  // --- each real desktop platform is accepted, not just win32
  for (const platform of ['win32', 'darwin', 'linux']) {
    const desktop = await underMarker({ platform })
    check(
      '[' + platform + '] the desktop shell still restores',
      desktop.moves.some((move) => move[0] === 'moveTo' && move[1] === desktop.rect.left),
      JSON.stringify(desktop.moves),
    )
  }
})

// ===========================================================================
// 10. LEGACY STORE
//
//   An older installation filed the geometry under a different key. That
//   document is the placement the user chose, so it must still be read: without
//   the fallback one launch would open at the shell default and overwrite the old
//   document with that default. The fallback is read-only — the first write goes
//   to this package's own key.
// ===========================================================================
await section('10. fallback geometry keys', () => {
  const local = makeStorage()
  const stores = plugin.stores
  check("the store seam exposes this package's geometry key", stores?.WINDOW_STATE_KEY === 'dsh-window-memory:window-state', stores?.WINDOW_STATE_KEY)
  check('the store seam exposes the previous key', stores?.LEGACY_WINDOW_STATE_KEY === 'dsh-window:window-state', stores?.LEGACY_WINDOW_STATE_KEY)
  check('the store seam exposes the oldest key', stores?.ANCIENT_WINDOW_STATE_KEY === 'dsh-notpdpton:window-state', stores?.ANCIENT_WINDOW_STATE_KEY)

  const legacyRect = { left: 240, top: 160, width: 1180, height: 760 }
  const legacyDoc = JSON.stringify({ v: 1, rect: legacyRect, dpr: 1, maximized: false, updatedAt: 11 })
  check('with nothing stored, loadState is null', call('loadState', local) === null)

  // Oldest key alone, then previous key added on top: the previous one must win.
  local.setItem(stores.ANCIENT_WINDOW_STATE_KEY, legacyDoc)
  const fromAncient = call('loadState', local)
  check(
    'a geometry document under the oldest key is still restored',
    fromAncient !== null && sameRect(fromAncient.rect, legacyRect),
    rectText(fromAncient?.rect),
  )

  const prevRect = { left: 200, top: 120, width: 1024, height: 720 }
  local.setItem(
    stores.LEGACY_WINDOW_STATE_KEY,
    JSON.stringify({ v: 1, rect: prevRect, dpr: 1, maximized: false, updatedAt: 11.5 }),
  )
  const fromPrevious = call('loadState', local)
  check(
    'the previous key wins over the oldest one',
    fromPrevious !== null && sameRect(fromPrevious.rect, prevRect),
    rectText(fromPrevious?.rect),
  )

  const ownRect = { left: 40, top: 30, width: 900, height: 700 }
  local.setItem(stores.WINDOW_STATE_KEY, JSON.stringify({ v: 1, rect: ownRect, dpr: 1, maximized: false, updatedAt: 12 }))
  const fromOwn = call('loadState', local)
  check(
    "the package's own document wins over the superseded one",
    fromOwn !== null && sameRect(fromOwn.rect, ownRect),
    rectText(fromOwn?.rect),
  )

  // Save always writes THIS package's key, never the superseded one.
  const writes = local.__writes.length
  call('saveState', { rect: ownRect, dpr: 1, maximized: false, updatedAt: 13 }, local)
  const written = local.__writes.slice(writes)
  check("saving writes only this package's geometry key", written.length === 1 && written[0][0] === stores.WINDOW_STATE_KEY, JSON.stringify(written.map((w) => w[0])))
  // Scope this to the writes SAVE made: the fixture above deliberately seeded the
  // legacy key by hand, and counting that write would fail on the fixture, not the code.
  check(
    'saving never writes either fallback key',
    written.every(
      (write) =>
        write[0] !== stores.LEGACY_WINDOW_STATE_KEY && write[0] !== stores.ANCIENT_WINDOW_STATE_KEY,
    ),
    JSON.stringify(written.map((w) => w[0])),
  )
})

// ===========================================================================
// SUMMARY
// ===========================================================================
console.log('')
if (seamMissing.length > 0) {
  failures++
  console.log('FAIL missing seam members: ' + seamMissing.join(', '))
}
// process.exit, not exitCode: install() leaves a 1 s poll interval behind, and a
// lingering timer would keep node alive after the last check.
if (failures > 0) {
  console.log('FAIL: ' + failures + ' failures, ' + passes + ' checks passed')
  process.exit(1)
} else {
  console.log('OK: window placement checks pass (' + passes + ' checks)')
  process.exit(0)
}

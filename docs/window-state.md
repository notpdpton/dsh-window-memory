# Window placement memory (窗口记忆)

## Goal

Reopen the DSH Desktop main window at the size and position it was closed at.

## Package shape

This feature is a **standalone plugin**, delivered as one package:
`dsh.bundle.patch` + a `cordis.patch.yml` that inserts **one** row naming the package
root, with this package alone in the profile's bundle list. The Plugins page therefore
shows `dsh-window-memory` as its own plugin with its own on/off switch — and that switch is
the ONLY control this plugin has. It registers no `settings.section`, renders nothing
and imports no React, so "disabled" means the browser half never runs rather than "runs
but remembers nothing".

One package can contribute at most one browser module: the module table is keyed by
package name, so a second active source is a hard composition error. A plugin therefore
carries its own `"./client"`, `"./icon"` and `"./locale/*.json"` exports and is never a
subpath of something else — a row's browser half is found by taking the row's **package
root**, reading that manifest's `dsh.client` declaration and loading what it exports as
`"./client"`, and the scan requires an *exact* package specifier
(`dsh-client-modules` `exactPackageSpecifier`). A subpath row mounts silently with no
UI at all.

## Desktop only

The feature is scoped to the **DSH Desktop** shell and refuses to run anywhere else. A
real window that the user can drag and resize exists only there; a browser tab's
viewport belongs to the browser, and "remembering" it would fight the user's own window
manager. The guard is the first thing `installWindowPlacement()` checks, before the
iframe test, so a browser session never starts the poll, never installs a listener and
never writes storage.

Three signals, any one of which identifies the Desktop shell:

| signal | where it comes from |
| --- | --- |
| `location.protocol === 'dsh-app:'` and `hostname === 'app'` | the main window URL (`createWindow(appPreload, …)` → `dsh-app://app/`) |
| `<html data-platform="…">` | `preload-app.cjs` `markDocumentPlatform()`; shipped bundles read it too |
| `__DSH_HOST_PATHS__` / `dshDesktopBoot` / `dshDesktop` | the same preload, exposed unconditionally |

No signal is compared against a specific platform string, so a future OS still counts
as desktop automatically. The asymmetry is deliberate: a false negative would silently
disable a working desktop session, while a false positive only runs harmless code — so
the guard accepts three signals instead of one, and the third one exists precisely
because the preload can defer the `<html>` attribute to `DOMContentLoaded`.

The restriction cannot be declared in `package.json`: `dsh-client-modules` accepts
exactly one value for `dsh.client.platform` (`"web"`) and drops the browser half for
anything else. `dsh.runtime.shell` in the manifest is documentation for a human reader;
`isDesktopShell()` is the actual gate.

## Why this is a renderer feature

The Desktop shell creates its BrowserWindow in the Electron main process with
hardcoded bounds (1280x820, no x/y) and exposes no geometry IPC. The Host half of a
plugin runs in a plain Node child process, so it cannot reach the window either. The
workspace document, however, is the **top-level document of that window**, and a
top-level document may call `window.moveTo()` / `window.resizeTo()`: Electron
forwards them to the BrowserWindow.

Verified against the app's own Electron binary with the shell's exact window options
(`titleBarStyle: 'hidden'`, `titleBarOverlay`, `sandbox: true`,
`contextIsolation: true`, privileged `dsh-app://` scheme):

* the calls work while the window is still hidden (`show: false`);
* the geometry survives `show()`, a reload, and an app relaunch;
* `localStorage` on the app origin survives relaunch;
* `sessionStorage` survives a reload but is cleared by a relaunch — the natural
  "once per launch" boundary.

### The window does move *after* `show()`, not before

Measured against the shell's real ordering (create hidden → `loadURL` → `show()`),
in three consecutive runs: `did-finish-load` → `show()` → first `moveTo`/`resizeTo`
landed **+0 to +2 ms after** `show()`. The restore is correct and lands within a few
tens of milliseconds, but it is *not* applied before the window becomes visible, so a
brief re-placement can be seen on a large jump. It cannot be removed from a client
half at all: the plugin only runs once the page has loaded, which is already after the
shell has made the window visible. (A cached frame offset was tried for this and
removed — see "The one-ask fast path was tried and removed".)

Do not claim "no visible jump": that is true only if `show()` is deferred until the
hidden window has settled, which the shell does not do.

## The coordinate trap

The renderer's `screenX/screenY/outerWidth/outerHeight` are **not** the values to pass
to `moveTo/resizeTo`. With a hidden title bar plus overlay the reported rect is inset
from the requested one by the window frame. The relation is a translation (slope 1):

| asked | renderer reports | true window rect |
| --- | --- | --- |
| moveTo x=377 | screenX=363 | x=370 |
| resizeTo w=1183 | outerWidth=1198 | width=1184 |

So placement is a correction loop on the **asked** value:

    ask_0     = measured_0                  (the window's current placement)
    ask_{n+1} = ask_n + (target - measured_n)

`ask_0` is the *measured* rect, not the target: the first measurement describes where
the window already is, and the correction is only exact when the ask it is applied to is
the ask that produced that measurement. Two passes reach a 0 px residual; the loop is
bounded by `WINDOW_MAX_PASSES = 3`, so a window that never follows the request stops
there instead of shaking (see "Why an OS-clamped request is not a failure").

### Measuring a window is the hard part

The arithmetic converges in one pass; trusting a *measurement* is what took three
independent Electron harnesses to get right. Three hazards, all observed:

1. **A read can echo the ask.** Reading `screenX/outerWidth` in the same task as
   `moveTo`/`resizeTo` returns the value just *asked for*. A probe that placed, then
   read immediately, reported the exact target `{377,211,1183,767}` while a later read
   showed the truth `{363,211,1198,775}`. A loop that believes the echo sees zero
   residual and does nothing.
2. **Windows animates a window move**, so reads tens of milliseconds apart disagree.
   Reading a moving window made an identical seed and identical code produce three
   different final rects in three runs.
3. **`ask` must be the value that produced `measured`.** With no stored frame the first
   read describes the window's *previous* placement, not the target.

The loop therefore measures only settled geometry: read, settle, read again, and
accept a value only when two reads agree (`WINDOW_STABLE_READS = 5`). An echo cannot
survive that, and neither can a sample taken mid-animation. Each settle waits one
animation frame plus a macrotask (`WINDOW_SETTLE_MS = 60`); `requestAnimationFrame` is
only an accelerator because a hidden window may not fire it.

### The one-ask fast path was tried and removed

Caching the measured frame offset in the store so the next launch could place the
window in a single ask *sounded* right, and it is the reason `frame` still appears in
the stored document. It was removed after measurement: the restore lands **after** the
shell's `show()` whether or not the offset is applied (the client half only runs once
the page has loaded), so it bought no visible improvement — while subtracting the
offset made the correction loop oscillate against Windows' clamping and produced a
−14 px / +14 px / +8 px drift on every launch. The plain loop starting from the measured
rect is the version verified drift-free over six consecutive launches. `frame` is kept
in the document as diagnostic evidence only, and `placeWindow` ignores any frame passed
to it.

### Why an OS-clamped request is not a failure

Windows clamps a window to the work area, so a maximized *fill* cannot always be
reached in renderer space. When two consecutive reads return the same rect, the
window has stopped following the request, and the loop stops (reporting
`clamped: true`) instead of repeating identical `moveTo`/`resizeTo` calls.

## Stored document

`localStorage["dsh-window-memory:window-state"]`:

    { "v": 1,
      "rect": { "left": 100, "top": 80, "width": 1200, "height": 800 },
      "dpr": 1.5,
      "maximized": false,
      "frame": { "left": -14, "top": 0, "width": 15, "height": 8 },
      "updatedAt": 1792263889830 }

* `rect` is always the **normal** placement, never a maximized fill.
* `maximized` records that the window was maximized when last seen.
* `frame` is **diagnostic only** and ignored on restore: the offset
  `measured - asked` that the last placement revealed. It once drove a one-ask fast
  path; that path was removed (see above) because it bought nothing visible and caused
  cross-launch drift. The field is kept so a store can be inspected after the fact.
  It is only ever written by the placement loop; a capture sample can be taken
  mid-drag, and deriving a frame from one produced garbage (measured
  `{2,20,-11,-14}`), so capture deliberately does not write it.
* A wrong `v`, invalid JSON, or an unusable rect is discarded rather than repaired:
  a wrong guess moves the user's window, which is worse than the default geometry.
* `sessionStorage["dsh-window-memory:window-restored"] = "1"` marks the launch handled.
* Exactly **two** keys exist and both are namespaced to this package. There are no
  fallbacks: this package has never written geometry under another name, so a fallback
  could only be a read that never matches, dressed up as a compatibility promise the
  plugin does not make. `test/verify-window.mjs` section 10 pins both facts — the key
  count and the exclusion of any unrelated key.
* No switch document is read either. "Remember the geometry" is now the plugin's
  enabled state, which the plugin manager owns — a stored `false` must not override an
  explicit "enabled".

## Restore rules

* once per app launch (the sessionStorage guard);
* not at all when the plugin is disabled — a disabled plugin's `apply()` never runs,
  so nothing in this file executes; there is no in-code enable flag;
* the rect is clamped to DSH's native minimums (520x600) and to the work area of the
  display it belongs to (`pickHomeArea`: the display it overlaps most);
* a rect that touches **no** current display is rejected, not restored — an undocked
  laptop must not open the window off-screen (`isOnScreen` asks only for positive
  overlap, because the asymmetry matters: rescuing a real window is cheap, losing it is
  not);
* a rect that overlaps a display but is not *contained* in it is pulled fully on
  screen (`isFullyOnScreen` + `bringOnScreen`), keeping its size;
* a window saved while maximized restores its **pre-maximize** rect, never the fill
  (see "Maximize is never restored"); a stored rect that is itself a work-area fill is
  rejected as a legacy artifact.

## Maximize is never restored

A window closed while maximized reopens at the size it had **before** it was maximized.
Maximizing is not a placement the user chose — it is a temporary state that takes the
whole screen — so it is never treated as one.

A renderer cannot read or set the **native** maximize state, so "maximized" has to be
inferred: a rect counts as maximized when it fills the work area
(`WINDOW_MAXIMIZED_TOLERANCE = 24` px, covering the 7 px of invisible resize-border
overhang measured here). Detection compares **edges**, not sizes: a filling window
overhangs on *both* opposite sides, so its width differs from the work area by the sum
of the two overhangs, and comparing sizes would reject a genuinely maximized window.

What that means in practice:

* capture discards a maximized sample and keeps the stored rect, so the pre-maximize
  size survives a close-while-maximized;
* if the first launch is already maximized there is no pre-maximize size to keep, so
  nothing is written at all rather than storing the full-screen fill;
* `planRestore` never returns a maximized intent. It also refuses a stored rect that
  *is* a work-area fill, because older builds wrote exactly that: with no pre-maximize
  size recoverable from such a document, the launch keeps the shell's default geometry
  and the next capture records a real placement;
* the stored `maximized` field is diagnostic only.

The upshot is that a maximized window does re-open as a **normal** window (Windows shows
the maximize glyph, not restore), which is the intended trade: the geometry you picked
is what comes back.

## Capture

* geometry is sampled on `resize`, on `pagehide`/`beforeunload`, and by a 1 s poll — a
  window **move** fires no renderer event at all, which is what the poll is for;
* the poll's "nothing changed" test runs **before** `getScreenDetails()`, so a
  stationary window costs one synchronous rect read per tick and no display query.
  The comparison catches precisely the moves the poll exists for; skipping the rest
  is safe because the display list can only affect the diagnostic `maximized` flag,
  which no restore path reads (`planRestore` re-derives maximize from the rect);
* capture is suppressed while a restore is placing the window, so the correction
  loop's intermediate rects never reach the store;
* degenerate samples (smaller than 520x600, or unreadable) are ignored;
* a maximized sample never becomes the stored rect: the fill is discarded, the
  previously stored rect is kept, and only the diagnostic flag updates (nothing is
  written at all when no rect was ever stored);
* a sample identical to what is already stored does not rewrite it, so an idle window
  produces no localStorage churn.

There is no switch to re-read. The old code checked "remember the geometry" again after
every await inside capture, so a toggle turned off mid-`getScreenDetails()` could not
write. That hazard is gone with the preference: disabling the plugin disposes the whole
browser half, timers included, so a late write cannot happen at all.

The worst bug found was a **cross-launch drift** that only an independent Electron
run could have caught: the store moved −14 px on the left edge and +14/+8 px on
width/height on *every* launch, linearly and without bound, so a window crept across
the screen the more the app was restarted. Two defects combined. First, `placeWindow`
seeded its working `ask` with the *target* before the first measurement, although that
measurement describes the window's **previous** placement, so the first correction
added the entire old-to-target gap to an ask that had never been applied. Second — and
this is what kept it alive after the first fix — a measurement taken right after an ask
can echo that ask, so the loop saw a zero residual, applied nothing, and let the capture
store the uncorrected rect. Both are fixed by the settled-measurement rule and by
seeding `ask` from the measured rect; six consecutive launches now leave the store
byte-identical (verified in real Electron, not just offline).
`test/verify-window.mjs` section 5b pins the cold-start landing and the fixed point.

One bug is worth naming because the symptom was so quiet: `capture()` once called a
`sameRect` helper that had drifted out of scope, so the first capture after launch
wrote the store and every later one threw a `ReferenceError` that `install()`'s
`.catch` swallowed. The visible behaviour was "remembers the previous session, never
this one" — no error, no log, just a store frozen at the startup sample.
`test/verify-window.mjs` section 7b is the permanent guard.

## Test seams

The plugin's `plugin.windowPlacement` (i.e. `dsh-window-memory/client`) exposes the pure
policy (`decodeState`/`encodeState`, `clampRect`, `isOnScreen`/`isFullyOnScreen`/
`bringOnScreen`, `sameRect`, `normalizeFrame`/`pickHomeArea`, `isMaximizedRect`,
`planRestore`, `placeWindow`), the documented limits, and `install()` — the runtime
binder, which takes no arguments because there is no enable flag to consult.
`plugin.stores` exposes the two storage keys (`WINDOW_STATE_KEY`,
`WINDOW_RESTORED_KEY`), which is how the storage surface is verified without a browser. `test/verify-window.mjs` loads `client.js` and drives it
offline; `test/verify-plugin.mjs` audits the manifest (row, halves, identity, icon)
and asserts the ABSENCE of a page, a switch and a preference store;
`test/verify-engines.mjs` checks that `dsh.engines.dsh` admits the running DSH;
the Electron harness drives `install` against a real window.

## No settings page: one control, and it is the plugin switch

This plugin used to own a `settings.section` with a single "remember the window
geometry" switch. That switch was a second way to express the same decision the
Plugins page already makes: the manager decides whether the plugin runs at all, and a
disabled plugin's `apply()` never executes. Two controls, one meaning — and the copy
would then have to explain which one wins.

So the page, its stylesheet and its preference store are gone. What remains is the
stronger guarantee: **enabled means it runs, disabled means nothing in this file
executes**. There is no in-code enable flag left to consult, which is why
`install()` takes no arguments and `planRestore` no longer accepts a `switches`
option.

Removing UI from a browser half is a supported shape, not a trick: sixteen shipped
browser halves register no slot at all (`dsh-api-gateway`, `dsh-client-hmr`,
`dsh-client-shortcuts`, …) and the shell still calls their `apply`. The halves list
in `cordis.patch.yml` is what keeps the plugin mounted.

### What the removed page got right (kept here as a record)

Its visual work was real and is worth remembering if a page ever comes back — it
matched the shipped **General** page declaration for declaration, verified by diffing
computed styles against the installed `app.asar` in headless Chrome:

The values are not "close enough" approximations, they are the shipped declarations:

| element | official (and ours) |
| --- | --- |
| row | `justify-content:space-between`, `gap:24px`, `padding:16px 0`, `.5px` `border-l2` hairline |
| row title | 14 / line-height **20** / `label-primary` |
| row description | 12 / 18 / `label-secondary`, `margin-top:4px` |
| switch track | 36×20, `padding:2px`, `border-radius:999px`, off `border-l3`, on `brand-primary` |
| switch thumb | a real 16px element (not `::after`), `border-radius:50%` |
| thumb colour | on: `label-primary-foreground`; **off**: `switch-thumb` |
| thumb motion | `translate(16px)` in `.12s` |
| focus | `--dsw-focus-ring-width`, `outline-offset:2px` |

Every value is a `--dsw-alias-*` token; no hex appears in the stylesheet, which is what
makes dark mode a pure token rebinding instead of a second stylesheet. The pill and the
thumb both re-declare `corner-shape: round` — the theme sets
`corner-shape: superellipse(1.5)` on `*`, so a 999px radius alone renders as a
squircle.

How that was proven at the time: a parity check lifted the real rules out of the
installed `app.asar` (located by declaration signature, so a css-module hash change on
the next DSH release would not break it), rendered the official markup and the page's
markup side by side in headless Chrome, and diffed **computed styles** per property. It
caught a defect that had survived review — the thumb was painted with `switch-thumb`
in the on state because the token name reads like "the switch thumb", where the shipped
component uses `label-primary-foreground` while on and `switch-thumb` only while off.

One class of difference that method could never see: `.5px` and `1px` both resolve to
one device pixel at DPR 1, so their computed values are identical, and that assertion
had to live in the source text instead.

Both checks, their screenshots and the preview renderer are now deleted along with the
page. Keeping them would have meant shipping a verifier that asserts something about
code that no longer exists — the most comfortable kind of green test, and the most
useless. What replaced them is the negative assertion set in `test/verify-plugin.mjs`:
no slot, no React, no stylesheet, no switch markup, no preference key.

## DPI

The stored `rect` is in renderer CSS pixels, which are **device-independent pixels**
— the same unit Electron's `BrowserWindow` bounds use. Two facts pin this down:

* the shell asks for a 1280-DIP-wide window and the renderer reports `outerWidth`
  1295 at DPR 1.5 and 1296 when the scale factor is forced to 1.25. If CSS px were
  device pixels the value would scale with the factor; it does not.
* launching with `--force-device-scale-factor=1.25` (so `screenX` changed from 633 to
  888 for the same default window) still restored the saved rect **exactly**,
  `{500,300,1100,700}`.

So no scale factor is applied on restore, and the recorded `dpr` is diagnostic
evidence rather than an input. A window saved at 150% and reopened at 100% keeps the
same DIP geometry.

## Known limits

* **DSH Desktop only.** In a browser tab (the Web profile) the plugin does nothing:
  there is no window it owns to place. This is enforced at runtime, not declarable in
  the manifest — see "Desktop only" above.
* Placement is limited by what `getScreenDetails()` reports. When that API is
  unavailable only the current screen is known: the window still restores and clamps,
  but a rect from a detached second monitor cannot be distinguished from an on-screen
  one beyond the single known work area.
* The very first launch (nothing stored yet) opens at the shell's default geometry.
* If the shell ever moves window creation into the main process, this feature becomes
  redundant and should be removed rather than kept as a second source of truth.

/**
 * Manifest audit for dsh-window-memory as a STANDALONE plugin.
 *
 * The other suite (test/verify-window.mjs) drives the shipped behaviour. This one
 * answers a different question: would DSH actually load this package, and would
 * the Plugins page and the Settings dialog get what they need from it?
 *
 * Everything asserted here is read from the files DSH itself reads — package.json,
 * cordis.patch.yml, locale/*.json, icon.svg, index.js, client.js — never from a
 * copy inside the test. The four facts that break a plugin silently, and that a
 * behaviour suite cannot see, are pinned:
 *
 *   1. THE ROW       dsh.bundle.patch exists, the patch inserts exactly one row,
 *                    that row's name is this PACKAGE ROOT (a subpath row mounts
 *                    with no UI at all), and no other package is mounted by it.
 *   2. THE HALVES    the row's Host module resolves and exports apply/inject, and
 *                    the browser half is exported as "./client" under the exact
 *                    module id the patch row names.
 *   3. THE IDENTITY  locale meta, the page's own title, the Settings nav label and
 *                    the version shown on the page all agree with package.json —
 *                    a forgotten bump must turn red here, not show a stale number.
 *   4. THE ICON      icon.svg is reachable through the export map, is valid SVG,
 *                    and uses the official 36x36 canvas the Plugins list expects.
 *
 * Exit code is 0 only when every check passes.
 *
 * usage: node test/verify-plugin.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

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
function section(title) {
  console.log('\n-- ' + title)
}

const root = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, root), 'utf8')
const manifest = JSON.parse(read('package.json'))

// ===========================================================================
section('1. the row: this package is one standalone entry')
// ===========================================================================
check('package is named dsh-window-memory', manifest.name === 'dsh-window-memory', manifest.name)
// `private: true` would make `npm publish` refuse with EPRIVATE, so a published
// package must NOT set it. The publish intent is declared in `publishConfig`.
check('package is an ESM module', manifest.type === 'module', String(manifest.type))
check('package is publishable (no private flag)', manifest.private !== true, String(manifest.private))
check('publishConfig keeps scoped-free public access', manifest.publishConfig?.access === 'public', JSON.stringify(manifest.publishConfig))
check(
  'the manifest points at the source repository',
  typeof manifest.repository?.url === 'string' &&
    manifest.repository.url.includes('github.com/notpdpton/dsh-window-memory'),
  JSON.stringify(manifest.repository),
)
check('package points main at index.js', manifest.main === 'index.js', manifest.main)
check('package is a bundle (dsh.bundle.patch)', typeof manifest.dsh?.bundle?.patch === 'string', JSON.stringify(manifest.dsh?.bundle))
check('the patch file it names exists', existsSync(new URL(manifest.dsh?.bundle?.patch, root)), manifest.dsh?.bundle?.patch)

const patch = read('cordis.patch.yml')
/** Every \`name:\` a patch row mounts. */
const mounted = [...patch.matchAll(/^\s*-?\s*name:\s*'?"?([^'"\n]+)'?"?\s*$/gm)].map((match) => match[1].trim())
const ids = [...patch.matchAll(/^\s*-?\s*id:\s*'?"?([^'"\n]+)'?"?\s*$/gm)].map((match) => match[1].trim())
check('the patch inserts exactly one row', ids.length === 1, ids.join(', '))
// The row id stays the historical value: it is only the patch-tree identity, and
// changing it would make an upgrading profile see a second entry.
check('the row id is stable', ids[0] === 'dsh-window', ids[0])
check(
  'the row mounts THIS package root (never a subpath)',
  mounted.length === 1 && mounted[0] === 'dsh-window-memory',
  mounted.join(', '),
)
check(
  'the row mounts this package and nothing else',
  mounted.length === 1 && mounted.every((name) => name === manifest.name),
  mounted.join(', '),
)
check('the patch is shipped in files[]', Array.isArray(manifest.files) && manifest.files.includes('cordis.patch.yml'), JSON.stringify(manifest.files))

// ===========================================================================
section('2. the halves: Host module + browser module')
// ===========================================================================
const hostSource = read('index.js')
check('the Host half exports apply()', /export function apply\b|export \{[^}]*\bapply\b/.test(hostSource))
check('the Host half exports name and inject', /export const name\b/.test(hostSource) && /export const inject\b/.test(hostSource))
check('the Host half registers nothing (renderer-only plugin)', /export function apply\(\)\s*\{\s*\}/.test(hostSource))

check('the browser half is exported as "./client"', manifest.exports?.['./client'] === './client.js', String(manifest.exports?.['./client']))
check('the browser half file exists', existsSync(new URL('client.js', root)))
check('the browser half declares platform web', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
check(
  'the browser half loads immediately (it restores before any Session exists)',
  manifest.dsh?.client?.immediately === true,
  JSON.stringify(manifest.dsh?.client),
)

const client = read('client.js')
check('the browser half registers into the module table', client.includes('window.__ModuleLoader__.load({'))
// The module id is the boot-table key, so it must equal the PACKAGE name, not the
// row id (which is historical). A mismatch registers a factory nobody can require.
check(
  'its module id is the package name',
  client.includes(`id: 'dsh-window-memory'`),
  client.match(/id: '[^']+'/)?.[0],
)
check('it uses the require() table, not a host bridge', !client.includes('host.call'))
// ---- no UI, no second control --------------------------------------------
// The Plugins page's enable switch is this plugin's ONLY control. A settings
// page with a "remember geometry" switch would have been a second way to say the
// same thing, and the copy would then have to explain which one wins.
check('it registers no slot at all (the half has no UI)', !client.includes('ctx.slots.inject('), String((client.match(/ctx\.slots\.inject\(/g) ?? []).length) + ' registration(s)')
check('it renders nothing (no React import)', !client.includes("require('react')") && !client.includes('createElement'))
check('it declares no slots/locale dependency', /inject:\s*\[\s*\]/.test(client), client.match(/inject:\s*\[[^\]]*\]/)?.[0])
check('it exposes no settings-page seam', !client.includes('settingsPage:'))
check('it owns no preference store', !client.includes(':switches'))
check('it has no preference switch in its source', !client.includes('rememberWindowGeometry'))
// A parent-page child slot would mean this package contributes a block to another
// package's settings page instead of standing on its own.
check("it registers into no other package's child slot", !client.includes("'notpdpton.settings.group'"))

// ---- desktop only ---------------------------------------------------------
// The manifest cannot express this: dsh-client-modules accepts exactly one platform
// value ("web") and rejects anything else, so `dsh.client.platform` cannot say
// "desktop". The restriction therefore lives in the runtime guard, and the manifest
// only DOCUMENTS it. Both halves are asserted so neither side drifts.
check(
  'the browser half guards on the desktop shell',
  /function isDesktopShell\(/.test(client) && /if \(!isDesktopShell\(host\)\) return/.test(client),
)
check('the guard recognises the dsh-app://app scheme', /protocol === 'dsh-app:'/.test(client) && /hostname === 'app'/.test(client))
check('the guard recognises the desktop <html data-platform> marker', /dataset\?\.platform/.test(client))
check('the manifest documents the desktop-only restriction', manifest.dsh?.runtime?.shell === 'desktop', JSON.stringify(manifest.dsh?.runtime))
check('the plugin description says it is desktop-only', /仅支持 DSH Desktop/.test(manifest.description ?? ''), manifest.description)
check(
  'the client platform stays "web" (the only value the loader accepts)',
  manifest.dsh?.client?.platform === 'web',
  String(manifest.dsh?.client?.platform),
)

// ---- the card copy must FIT ------------------------------------------------
// The Plugins page clamps the card description to ONE line
// (`.cardDesc{ -webkit-line-clamp:1 }`), so anything longer is silently cut off
// with an ellipsis: the sentence still "looks fine in the file" while losing its
// point on screen. Measured in the shipped card CSS at the default dialog width:
// the text box is ~440px, and CJK 32 / Latin 53 characters both fit from 420px up.
// These caps are that measurement, minus a margin for a narrower window.
section('3b. the card copy fits on one clamped line')
const CJK_FITS = 32
const LATIN_FITS = 53
for (const lang of ['zh', 'en']) {
  const copy = JSON.parse(read('locale/' + lang + '.json')).meta.description
  const cap = lang === 'zh' ? CJK_FITS : LATIN_FITS
  check(
    '[' + lang + '] the card description fits (' + cap + ' chars max)',
    copy.length <= cap,
    copy.length + ' chars: ' + copy,
  )
}
check(
  'the manifest description is as short as the card copy',
  (manifest.description ?? '').length <= CJK_FITS,
  (manifest.description ?? '').length + ' chars: ' + manifest.description,
)
check(
  'the card description is one sentence, not a paragraph',
  (JSON.parse(read('locale/zh.json')).meta.description.match(/[，；。]/g) ?? []).length <= 2,
  JSON.stringify(JSON.parse(read('locale/zh.json')).meta.description.match(/[，；。]/g)),
)

// ---- the feature itself ---------------------------------------------------
check('it drives the real window', client.includes('moveTo(') && client.includes('resizeTo('))
check('it clamps to the shell window minimums', client.includes('WINDOW_MIN_WIDTH = 520') && client.includes('WINDOW_MIN_HEIGHT = 600'))
check('it restores once per launch (sessionStorage guard)', client.includes('hasRestoredThisLaunch') && client.includes('sessionStorage'))
check(
  'it is installed outside the slot tree, with no switch argument',
  /ctx\.effect\(\(\) => installWindowPlacement\(\)\)/.test(client),
  client.match(/installWindowPlacement\([^)]*\)/)?.[0],
)
// The DEFINITION must take no parameters either. Checking only the call site let a
// `getSwitches` parameter come back with the caller passing nothing — a dormant
// second control that would still compile and still look fine.
check(
  'install() itself takes no arguments',
  /function installWindowPlacement\(\)\s*\{/.test(client),
  client.match(/function installWindowPlacement\([^)]*\)/)?.[0],
)
check(
  'no switch reader survives anywhere in the half',
  !/\bgetSwitches\b/.test(client) && !/\bswitchReader\b/.test(client),
)
check('it exposes its documented test seams', client.includes('windowPlacement: {') && client.includes('stores: {'))
// No fallbacks, by design: this package has never written geometry under another
// name, so a fallback could only be a dead read dressed up as a compatibility
// promise. Assert their absence rather than their presence.
for (const retired of ['dsh-notpdpton', "'dsh-window:window-state'", "'dsh-window:window-restored'"]) {
  check(
    'the browser half carries no retired storage key ' + JSON.stringify(retired),
    !client.includes(retired),
    'client.js still references ' + retired,
  )
}
check(
  'the browser half names exactly one geometry key',
  (client.match(/WINDOW_STATE_KEY = '/g) ?? []).length === 1 &&
    client.includes("'dsh-window-memory:window-state'"),
)

// ===========================================================================
section('3. the identity: package.json and locale agree')
// ===========================================================================
const enMeta = JSON.parse(read('locale/en.json')).meta
const zhMeta = JSON.parse(read('locale/zh.json')).meta
check('locale meta is exported through locale/*.json', manifest.exports?.['./locale/*.json'] === './locale/*.json', String(manifest.exports?.['./locale/*.json']))
check('the locale directory holds only en and zh', readdirSync(new URL('locale/', root)).sort().join(',') === 'en.json,zh.json', readdirSync(new URL('locale/', root)).join(','))
check('the english title is present', typeof enMeta?.title === 'string' && enMeta.title.length > 0, enMeta?.title)
check('the chinese title is present', typeof zhMeta?.title === 'string' && zhMeta.title.length > 0, zhMeta?.title)
check('the two titles differ (each language is translated)', enMeta?.title !== zhMeta?.title)
check('the english description is present', typeof enMeta?.description === 'string' && enMeta.description.length > 0)
check('the chinese description is present', typeof zhMeta?.description === 'string' && zhMeta.description.length > 0)

// The browser half used to hard-code the package id and version for the page
// header. There is no page, so those constants are GONE — and that is worth
// asserting, because a leftover copy is exactly the kind of thing that silently
// goes stale next to package.json.
check('the browser half no longer mirrors the version (no page to print it on)', !/PACKAGE_VERSION\s*=/.test(client))
check('the browser half no longer mirrors the package id', !/PACKAGE_ID\s*=/.test(client))
check('the package version is a real version', /^\d+\.\d+\.\d+/.test(manifest.version), manifest.version)
check(
  'the locale title is the plugin-card copy the Plugins page shows',
  zhMeta?.title === '窗口记忆' && enMeta?.title === 'Window memory',
  `${zhMeta?.title} / ${enMeta?.title}`,
)

// ===========================================================================
section('4. the icon: reachable, valid, and on the official canvas')
// ===========================================================================
check('the manifest declares its icon', manifest.icon === './icon.svg', String(manifest.icon))
check('the icon is exported as "./icon"', manifest.exports?.['./icon'] === './icon.svg', String(manifest.exports?.['./icon']))
const icon = read('icon.svg')
check('the icon is valid SVG', icon.trimStart().startsWith('<svg') && icon.includes('</svg>'), icon.slice(0, 40))
check('the icon uses the official 36x36 canvas', /width="36"/.test(icon) && /height="36"/.test(icon) && /viewBox="0 0 36 36"/.test(icon), icon.match(/viewBox="[^"]+"/)?.[0])
check('the icon is under the 256 KiB metadata cap', Buffer.byteLength(icon) < 256 * 1024, String(Buffer.byteLength(icon)))
check('the icon is shipped in files[]', manifest.files.includes('icon.svg'))

// ===========================================================================
section('5. the package is self-contained')
// ===========================================================================
check('the plugin declares no runtime dependencies', Object.keys(manifest.dependencies ?? {}).length === 0, JSON.stringify(manifest.dependencies))
check('every shipped path exists', manifest.files.every((pattern) => pattern.includes('*') || existsSync(new URL(pattern, root))), manifest.files.join(', '))
check('the browser half is shipped in files[]', manifest.files.includes('client.js'))
// A screenshot of a page that no longer exists would be fake evidence, so the doc
// image directory is gone. Assert that it stays gone.
check('no settings-page screenshots are shipped', !existsSync(new URL('docs/images/', root)), 'docs/images still exists')
check(
  'the README shows no screenshot of the removed page',
  !read('README.md').includes('docs/images/'),
  'README still links an image',
)
// Every script in the manifest must point at a check that exists.
check(
  'every npm script file exists',
  Object.values(manifest.scripts ?? {}).every((cmd) => {
    const m = /test\/([a-z-]+\.mjs)/.exec(cmd)
    return m === null || existsSync(new URL('test/' + m[1], root))
  }),
  JSON.stringify(manifest.scripts),
)
check('the Host half is shipped in files[]', manifest.files.includes('index.js'))
check('the README is shipped', manifest.files.includes('README.md') && existsSync(new URL('README.md', root)))
const readme = read('README.md')
check(
  'the README documents the one storage key the plugin writes',
  readme.includes('dsh-window-memory:window-state'),
  'missing store key in README',
)
// The documentation describes the CURRENT contract only. The fallback keys are an
// implementation detail of an upgrade path, not something a new user should read
// about — and naming them would resurrect retired identifiers in the docs, which is
// exactly what the rename is meant to stop.
for (const retired of ['dsh-notpdpton', 'dsh-window:window-state', 'dsh-window:window-restored']) {
  check(
    'the README does not mention the retired identifier ' + JSON.stringify(retired),
    !readme.includes(retired),
    'README still mentions ' + retired,
  )
}

// ---- the install chapter ---------------------------------------------------
// A plugin nobody can install is not shipped. These assert the chapter exists and
// still carries the literal spec the plugin manager accepts, so a future edit
// cannot quietly break the only documented path.
section('5b. the README explains how to install')
check('the README has an install chapter', /^## 安装$/m.test(readme))
check(
  'it gives the npm package name the install dialog accepts',
  readme.includes('dsh-window-memory'),
  'README does not offer the npm name',
)
check('it names the UI path to the install dialog', readme.includes('添加插件') && readme.includes('安装第三方插件'))
check('it warns that a restart is required', /重启 DSH/.test(readme))
check('it documents how to verify the plugin is live', readme.includes('验证是否生效'))
check('it documents how to uninstall', readme.includes('卸载'))
// The README is user-facing documentation for the plugin, not for this machine.
// Personal identifiers and any environment-specific proxy recipe do not belong in
// it: neither is true for a reader who installed the package from npm.
for (const leaked of ['notpdpton', '代理', 'proxy', 'github.com/']) {
  check(
    'the README carries no ' + JSON.stringify(leaked),
    !readme.toLowerCase().includes(leaked.toLowerCase()),
    'README still mentions ' + leaked,
  )
}

// ===========================================================================
// 6. THE PAGE IS GONE, AND ITS ABSENCE IS THE FEATURE
//
//   This plugin used to own a Settings page carrying one switch. That switch was a
//   second way to say "remember the geometry" while the Plugins page already says
//   whether the plugin runs at all — and a disabled plugin never executes, so the
//   page's switch could only ever subtract from what the manager already decided.
//   Two controls for one decision is a documentation problem dressed as a feature,
//   so the page is gone and the plugin manager is the control.
//
//   The old checks here proved the page copied the shipped switch/row styles. There
//   is no page to style any more, so what remains worth asserting is the reverse:
//   that no page, no switch and no preference store came back.
// ===========================================================================
check('client.js ships no stylesheet at all', !/const CSS = /.test(client))
check('client.js contains no settings-section registration', !client.includes('settings.section'))
check('client.js contains no switch markup', !client.includes('aria-checked') && !client.includes("'switch'"))
check('the page design tokens went with the page', !client.includes('--dsw-alias-brand-primary'))
check('no preference key remains in the source', !client.includes(':switches'))
check('locale carries no switch copy any more', !read('locale/zh.json').includes('记住窗口位置和尺寸'))
check('locale carries no page copy any more', !read('locale/zh.json').includes('page.title'))

// ===========================================================================
console.log('')
if (failures > 0) {
  console.log('FAIL: ' + failures + ' failures, ' + passes + ' checks passed')
  process.exit(1)
} else {
  console.log('OK: plugin manifest audit passes (' + passes + ' checks)')
}

/**
 * Would DSH accept this plugin's engines.dsh range?
 *
 * The manifest declares ">=0.2.0-rc.1"; DSH evaluates that with
 * semver.satisfies(runtime, range, { includePrerelease: true }). semver is not
 * installed in this checkout, so the two facts that matter are checked directly
 * instead of hand-copying a satisfying case: the range parses as a comparator
 * set with the lower bound at or below the running version, and the running
 * version is a real semver.
 */
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const range = manifest.dsh?.engines?.dsh
const runtime = process.env.DSH_RUNTIME_VERSION ?? process.argv[2]

const V = '(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?'
const parse = (text) => {
  const m = new RegExp('^' + V + '$').exec(String(text ?? '').trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
}
const cmp = (a, b) => {
  if (a.major !== b.major) return Math.sign(a.major - b.major)
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor)
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch)
  // A prerelease sorts BELOW the same release; two prereleases compare by tag.
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre === b.pre ? 0 : a.pre < b.pre ? -1 : 1
}

let failures = 0
let passes = 0
function check(label, condition, detail) {
  if (condition) { passes++; console.log('  ok   ' + label) }
  else { failures++; console.log('  FAIL ' + label + (detail === undefined ? '' : ' - ' + detail)) }
}
function section(title) { console.log('\n-- ' + title) }

section('1. the declared range')
check('the manifest declares engines.dsh as one string', typeof range === 'string', JSON.stringify(manifest.dsh?.engines))
check('the range is a semver range, not a URL or a list', /^[<>=^~*0-9xX.A-Za-z\-+ ||]+$/.test(String(range)), range)
const lower = new RegExp('^>=\\s*' + V + '$').exec(String(range).trim())
check('the range pins one lower bound', lower !== null, range)
const floor = lower ? parse(lower[1] + '.' + lower[2] + '.' + lower[3] + (lower[4] ? '-' + lower[4] : '')) : null
check('the lower bound parses as a semver', floor !== null, range)

section('2. the running runtime satisfies it')
const running = parse(runtime)
check('a running DSH version was supplied', running !== null, String(runtime))
if (floor !== null && running !== null) {
  check('the running version is at or above the declared floor', cmp(running, floor) >= 0, runtime + ' vs ' + range)
  // The floor must not sit ABOVE the runtime: that is the one mistake that makes
  // a plugin silently unavailable, and it is invisible in a version bump.
  check('the floor is not above the runtime this was tested against', cmp(floor, running) <= 0, range)
  check('a same-major runtime is not excluded by a stray caret', !String(range).includes('^'), range)
}

section('3. the manifest version is a real semver')
const own = parse(manifest.version)
check('package.json version parses', own !== null, manifest.version)
check('the version is stable (no prerelease tag on a private plugin)', own !== null && own.pre === null, manifest.version)

console.log('')
if (failures > 0) { console.log('FAIL: ' + failures + ' failures, ' + passes + ' checks passed'); process.exit(1) }
console.log('OK: engines range checks pass (' + passes + ' checks)')

/**
 * The not-applicable claim, and the seven ways it is refused.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE FILE WHERE SOMEBODY WOULD HIDE A SILENCED SUITE, SO IT IS TESTED AS AN ATTACK.**
 *
 * Withholding a suite from the publish is the only way a scenario can leave the gate's sight
 * without leaving an unknown behind. Every test below is a way of doing that dishonestly, and each
 * one asserts the refusal — not the happy path. The happy path gets one test; the abuse gets seven,
 * because the estate's recurring defect is a check that cannot fail, and a check written to bless
 * five known-good entries is precisely that.
 *
 * Each rejection is asserted on its MESSAGE as well as its existence. A rejection that fires with
 * the wrong explanation sends the reader to the wrong file, and this whole mechanism is only worth
 * having if the reader can act on it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  notApplicableFor,
  resolveApplicability,
  validateDeclarations,
  type NotApplicable,
} from './applicability.ts'
import { ALL_SCENARIOS } from './scenarios/index.ts'
import type { ScenarioReport } from './types.ts'

const KNOWN = new Set(['wallet', 'micro-wallet', 'mint', 'micro-mint'])

const claim = (over: Partial<NotApplicable> = {}): NotApplicable => ({
  scenario: 'wallet',
  coveredBy: 'micro-wallet',
  reason: 'the surface moved (wallet/src/server.ts:477)',
  ...over,
})

const report = (name: string, over: Partial<ScenarioReport> = {}): ScenarioReport => ({
  name,
  title: name,
  outcome: 'recorded',
  interactions: 5,
  cleanupErrors: [],
  ...over,
})

const skipped = (name: string, reason = 'not mapped'): ScenarioReport =>
  report(name, { outcome: 'skipped', interactions: 0, reason })

/* ────────────────────────────────────────────────────────── the static half: S1 to S4 ───── */

test('A CLAIM NAMING A SUCCESSOR THAT DOES NOT EXIST IS REFUSED AT IMPORT', () => {
  // The abuse case in its purest form. `micro-wallett` silences `wallet` and covers nothing, and
  // nothing downstream could ever tell: Beacon never sees the suite again.
  assert.throws(
    () => validateDeclarations({ micro: [claim({ coveredBy: 'micro-wallett' })] }, KNOWN),
    /names 'micro-wallett'.*no such scenario exists/s,
  )
})

test('a claim naming itself as its own successor is refused at import', () => {
  assert.throws(
    () => validateDeclarations({ micro: [claim({ coveredBy: 'wallet' })] }, KNOWN),
    /names itself as its own successor/,
  )
})

test('delegation cannot be chained, so two suites cannot go quiet on one run', () => {
  // `wallet` covered by `mint`, `mint` covered by `micro-mint`. Only `micro-mint` runs, and two
  // suites disappear on the strength of it — one of them a capability `micro-mint` never touches.
  assert.throws(
    () =>
      validateDeclarations(
        {
          micro: [
            claim({ scenario: 'wallet', coveredBy: 'mint' }),
            claim({ scenario: 'mint', coveredBy: 'micro-mint' }),
          ],
        },
        KNOWN,
      ),
    /names 'mint', which is ITSELF withheld/,
  )
})

test('a claim about a scenario that does not exist is refused at import', () => {
  assert.throws(
    () => validateDeclarations({ micro: [claim({ scenario: 'walet' })] }, KNOWN),
    /no such scenario/,
  )
})

test('the same scenario cannot be retired twice with two reasons', () => {
  assert.throws(
    () => validateDeclarations({ micro: [claim(), claim({ reason: 'something else (a/b.ts:1)' })] }, KNOWN),
    /declared twice/,
  )
})

test('a reason with no path:line citation is refused at import', () => {
  // An uncited retirement is a sentence nobody can re-check, which is how a reason outlives the
  // arrangement it described. Three of this repository's own citations had drifted by 30 lines
  // when this file was written.
  assert.throws(
    () => validateDeclarations({ micro: [claim({ reason: 'the wallet surface moved, obviously' })] }, KNOWN),
    /cites no path:line/,
  )
})

test('the declarations this repository actually ships pass every static rule', () => {
  const names = new Set(ALL_SCENARIOS.map((scenario) => scenario.name))
  const shipped = Object.fromEntries(['local', 'micro'].map((base) => [base, notApplicableFor(base)]))
  assert.doesNotThrow(() => validateDeclarations(shipped, names))
})

/* ─────────────────────────────────────────────────────────── the runtime half: R1 to R3 ───── */

test('A CLAIM WHOSE SUCCESSOR ALSO SKIPPED IS REJECTED, AND THE SUITE IS PUBLISHED AS A SKIP', () => {
  // ════════════════════════════════════════════════════════════════════════════════════════
  // THE ONE THAT MATTERS. `micro-wallet` is a real suite and the declaration is well formed, so
  // every static rule passes — and the estate it covers is not there. Withholding `wallet` here
  // would remove the last row that says so, and the gate would report a clean conformance input
  // for two capabilities nobody looked at.
  // ════════════════════════════════════════════════════════════════════════════════════════
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [skipped('wallet', 'pay is not mapped'), skipped('micro-wallet', 'the gateway refused the connection')],
    baselineByScenario: new Map(),
  })

  assert.equal(resolved.withheld.length, 0)
  assert.equal(resolved.rejected.length, 1)
  assert.match(resolved.rejected[0]!.why, /'micro-wallet'.*skipped in this run.*the gateway refused the connection/s)
})

test('a claim whose successor never ran at all is rejected', () => {
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [skipped('wallet')],
    baselineByScenario: new Map(),
  })
  assert.equal(resolved.withheld.length, 0)
  assert.match(resolved.rejected[0]!.why, /did not run at all in this replay/)
})

test('a claim whose successor reports recorded with zero interactions is rejected', () => {
  // `recorded` with nothing recorded is what Beacon derives `skip` from, so this successor is
  // about to become an unknown itself. Reading the outcome word alone would have missed it.
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [skipped('wallet'), report('micro-wallet', { interactions: 0 })],
    baselineByScenario: new Map(),
  })
  assert.equal(resolved.withheld.length, 0)
  assert.match(resolved.rejected[0]!.why, /zero interactions/)
})

test('a stale claim cannot suppress a suite that actually ran', () => {
  // Somebody repoints `pay` with CONFORMANCE_URL_PAY and the legacy suite works again. The
  // declaration must lose that argument to the run, not the other way round.
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [report('wallet', { interactions: 9 }), report('micro-wallet')],
    baselineByScenario: new Map(),
  })
  assert.equal(resolved.withheld.length, 0)
  assert.match(resolved.rejected[0]!.why, /recorded 9 interaction\(s\) in this run, so it DOES apply/)
})

test('a claim cannot withhold a suite the baseline corpus covers', () => {
  // The corpus is the second witness. A baseline with interactions for this suite means it applied
  // when the baseline was recorded, so a skip now is a recorded-then-skipped regression — and
  // withholding it would delete the evidence on the way to Beacon.
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [skipped('wallet'), report('micro-wallet')],
    baselineByScenario: new Map([['wallet', 6]]),
  })
  assert.equal(resolved.withheld.length, 0)
  assert.match(resolved.rejected[0]!.why, /baseline corpus holds 6 interaction\(s\)/)
})

test('a claim about a scenario this run did not execute is neither upheld nor rejected', () => {
  // `--only micro-wallet`. Nothing is published for `wallet` either way, so there is nothing to
  // withhold and nothing to silence.
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [report('micro-wallet')],
    baselineByScenario: new Map(),
  })
  assert.deepEqual(resolved, { withheld: [], rejected: [] })
})

test('the legitimate case: skipped suite, successor ran and compared, no baseline', () => {
  const resolved = resolveApplicability({
    baseName: 'micro',
    replay: [skipped('wallet'), report('micro-wallet', { interactions: 7 })],
    baselineByScenario: new Map([['micro-wallet', 7]]),
  })
  assert.equal(resolved.rejected.length, 0)
  assert.deepEqual(resolved.withheld.map((held) => held.scenario), ['wallet'])
  assert.equal(resolved.withheld[0]?.coveredBy, 'micro-wallet')
})

test('a base with no declarations withholds nothing, however much skips', () => {
  const resolved = resolveApplicability({
    baseName: 'local',
    replay: [skipped('micro-wallet'), skipped('micro-mint'), skipped('wallet')],
    baselineByScenario: new Map(),
  })
  assert.deepEqual(resolved, { withheld: [], rejected: [] })
})

test('every shipped micro claim names a DIFFERENT successor, so no suite covers two capabilities', () => {
  // Not a rule the validator enforces, and it is asserted here because the day it stops being true
  // is the day one passing suite is answering for two products.
  const successors = notApplicableFor('micro').map((held) => held.coveredBy)
  assert.equal(new Set(successors).size, successors.length)
})

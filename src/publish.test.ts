/**
 * Publishing a comparison to Beacon.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PROPERTY UNDER TEST IS THAT A SCENARIO CANNOT BE CERTIFIED BY ANOTHER SCENARIO'S NUMBERS.**
 *
 * Beacon derives a run's status from its counts and treats `identical + benign === 0` as a skip.
 * That makes the per-scenario `identical` figure load-bearing: hand a scenario a number it did not
 * earn and a suite that compared nothing reports `pass`, the gate stops saying
 * `conformance_inconclusive`, and a release is promoted on evidence that was arithmetic.
 *
 * The first version of `postsFor` did exactly that — it took the estate-wide `counts.identical`
 * and gave it to all eight scenarios. These tests are the reason it does not any more.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { postsFor, publish, type SkippedScenario } from './publish.ts'
import type { ComparisonReport, Difference } from './compare.ts'

function difference(scenario: string, classification: Difference['classification']): Difference {
  return {
    scenario,
    step: 'a step',
    path: 'response.body.field',
    kind: classification === 'breaking' ? 'field-removed' : 'field-added',
    detail: 'because',
    classification,
  } as Difference
}

function report(differences: readonly Difference[], identical = 100): ComparisonReport {
  return {
    differences,
    counts: {
      identical,
      benign: differences.filter((d) => d.classification === 'benign').length,
      breaking: differences.filter((d) => d.classification === 'breaking').length,
    },
    byKind: {},
    interactionsCompared: identical + differences.length,
    breaking: differences.some((d) => d.classification === 'breaking'),
  } as ComparisonReport
}

test('A SKIPPED SCENARIO IS POSTED WITH ZERO COUNTS, SO BEACON DERIVES A SKIP', () => {
  const skipped: SkippedScenario[] = [{ name: 'identity', reason: 'nimbus did not answer' }]
  const posts = postsFor(report([]), new Map([['chain', 7]]), skipped)

  const identity = posts.find((post) => post.suite === 'identity')
  assert.ok(identity)
  assert.equal(identity.identical, 0)
  assert.equal(identity.benign, 0)
  assert.equal(identity.breaking, 0)
  // `identical + benign === 0` is exactly what makes Beacon's `statusFor` say `skip` rather than
  // `pass`. If this ever becomes non-zero the gate is told a scenario ran that did not.
  assert.equal(identity.identical + identity.benign, 0)
})

test('a skipped scenario is never omitted from the publish', () => {
  // Omitting it would be worse than useless. The gate's other conformance input is whether ANY
  // row exists, so publishing the one that ran and dropping the one that did not is how a partial
  // estate certifies itself.
  //
  // The ONE exception is `withheld`, below — a suite proved not to apply to this base at all — and
  // it is not decided here. Note that neither of these two carries a `withheld` entry, so both are
  // published: a suite is not dropped by having a reason that mentions a successor.
  const posts = postsFor(
    report([]),
    new Map([['chain', 7]]),
    [
      { name: 'identity', reason: 'not deployed' },
      { name: 'wallet', reason: 'not deployed, covered by micro-wallet' },
    ],
  )
  assert.deepEqual(
    posts.map((post) => post.suite).sort(),
    ['chain', 'identity', 'wallet'],
  )
})

test('a suite proved not applicable to this base is withheld from the publish', () => {
  // The narrow exception. `wallet` does not exist on this base — see `applicability.ts` for the
  // seven rules that had to hold before its name could appear in `withheld` — so posting it as a
  // skip would create an unknown that can never resolve.
  const posts = postsFor(
    report([]),
    new Map([['chain', 7], ['micro-wallet', 6]]),
    [{ name: 'wallet', reason: 'pay is not mapped in this base' }],
    { withheld: ['wallet'] },
  )
  assert.deepEqual(posts.map((post) => post.suite).sort(), ['chain', 'micro-wallet'])
})

test('A WITHHELD SUITE THAT COMPARED INTERACTIONS THROWS RATHER THAN BEING DROPPED', () => {
  // The contradiction that must never resolve quietly: a suite that reached the estate is
  // published on its own evidence. Dropping it here would delete a real comparison — including,
  // one day, a breaking one.
  assert.throws(
    () => postsFor(report([]), new Map([['wallet', 6]]), [], { withheld: ['wallet'] }),
    /compared 6 interaction\(s\)/,
  )
})

test('identical is counted per scenario and never borrowed from the estate-wide figure', () => {
  // The regression. `counts.identical` is 100 across the whole run; `chain` compared 7.
  const posts = postsFor(report([], 100), new Map([['chain', 7], ['mint', 5]]), [])
  const chain = posts.find((post) => post.suite === 'chain')
  const mint = posts.find((post) => post.suite === 'mint')
  assert.equal(chain?.identical, 7)
  assert.equal(mint?.identical, 5)
  assert.notEqual(chain?.identical, 100)
})

test('a scenario’s own differences come off its own identical count', () => {
  const posts = postsFor(
    report([difference('mint', 'benign'), difference('mint', 'breaking')]),
    new Map([['mint', 5]]),
    [],
  )
  const mint = posts.find((post) => post.suite === 'mint')
  assert.equal(mint?.benign, 1)
  assert.equal(mint?.breaking, 1)
  assert.equal(mint?.identical, 3)
})

test('one scenario’s breaking difference is never attributed to another', () => {
  const posts = postsFor(
    report([difference('wallet', 'breaking')]),
    new Map([['wallet', 4], ['mint', 4]]),
    [],
  )
  assert.equal(posts.find((post) => post.suite === 'wallet')?.breaking, 1)
  assert.equal(posts.find((post) => post.suite === 'mint')?.breaking, 0)
})

test('identical never goes negative', () => {
  const posts = postsFor(
    report([difference('mint', 'breaking'), difference('mint', 'breaking')]),
    new Map([['mint', 1]]),
    [],
  )
  assert.equal(posts.find((post) => post.suite === 'mint')?.identical, 0)
})

test('the release and corpus reference are carried when given, and absent when not', () => {
  const withTag = postsFor(report([]), new Map([['chain', 1]]), [], {
    release: 'v1.2.3',
    corpusRef: 'local@2026-07-29',
  })
  assert.equal(withTag[0]?.release, 'v1.2.3')
  assert.equal(withTag[0]?.corpusRef, 'local@2026-07-29')

  const without = postsFor(report([]), new Map([['chain', 1]]), [])
  assert.ok(!('release' in (without[0] as object)))
})

test('publish reports every failure rather than throwing on the first', async () => {
  const results = await publish(
    [
      { suite: 'a', identical: 1, benign: 0, breaking: 0, skipped: 0 },
      { suite: 'b', identical: 0, benign: 0, breaking: 0, skipped: 1 },
    ],
    { baseUrl: 'http://127.0.0.1:1/', headers: {}, timeoutMs: 2_000 },
  )
  assert.equal(results.length, 2)
  assert.ok(results.every((result) => !result.ok && result.error !== null))
})

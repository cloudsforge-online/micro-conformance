/**
 * The additive-versus-breaking distinction is the whole value of this package, so it is tested as
 * a table with one row per case and the rows are the specification.
 *
 * The two directions are asymmetric on purpose and the table says so out loud: adding a field is
 * benign and removing one is breaking; an array growing is benign and an array shrinking is
 * breaking; a null becoming a value is benign and a value becoming null is breaking. Every one of
 * those pairs is a place where a symmetric implementation would be half wrong and would look
 * right, because half the cases would still pass.
 *
 * No running estate is needed. These are values in and classifications out.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareCorpora, compareInteraction, compareJson } from './compare.ts'
import type { Classification, DifferenceKind } from './compare.ts'
import type { CorpusManifest, Interaction, Json } from './types.ts'
import { FORMAT_VERSION } from './types.ts'

interface Case {
  readonly name: string
  readonly baseline: Json
  readonly target: Json
  readonly expect: Classification
  readonly kind?: DifferenceKind
}

const CASES: readonly Case[] = [
  // ------------------------------------------------------------- identical --
  { name: 'identical objects', baseline: { a: 1 }, target: { a: 1 }, expect: 'identical' },
  {
    name: 'two equal placeholders — the volatile field was erased on both sides',
    baseline: { id: '<uuid>' },
    target: { id: '<uuid>' },
    expect: 'identical',
  },
  { name: 'identical nested arrays', baseline: { a: [1, [2, 3]] }, target: { a: [1, [2, 3]] }, expect: 'identical' },
  { name: 'identical empty object', baseline: {}, target: {}, expect: 'identical' },

  // ---------------------------------------------------------------- benign --
  {
    name: 'a new optional key is additive, which is the rule that lets a provider ship first',
    baseline: { a: 1 },
    target: { a: 1, b: 2 },
    expect: 'benign',
    kind: 'field-added',
  },
  {
    name: 'a nested new key is additive too',
    baseline: { outer: { a: 1 } },
    target: { outer: { a: 1, b: 2 } },
    expect: 'benign',
    kind: 'field-added',
  },
  {
    name: 'a longer catalogue is a new product, not a broken one',
    baseline: { coins: [{ coin: 'EMBER' }] },
    target: { coins: [{ coin: 'EMBER' }, { coin: 'BTC' }] },
    expect: 'benign',
    kind: 'array-extended',
  },
  {
    name: 'a nullable field arriving populated breaks no caller that already handled null',
    baseline: { txid: null },
    target: { txid: 'abc' },
    expect: 'benign',
    kind: 'nullable-populated',
  },
  {
    name: 'a gauge that moved is reported and is not a break',
    baseline: { latency: 12 },
    target: { latency: 19 },
    expect: 'benign',
    kind: 'value-changed',
  },
  {
    name: 'a value the target did not normalise is reported, not failed',
    baseline: { id: '<uuid>' },
    target: { id: 'not-a-uuid' },
    expect: 'benign',
    kind: 'value-changed',
  },
  {
    name: 'a different placeholder means a different underlying shape, and is still not fatal',
    baseline: { address: '<evm-address>' },
    target: { address: '<bech32-address>' },
    expect: 'benign',
    kind: 'value-changed',
  },

  // -------------------------------------------------------------- breaking --
  {
    name: 'a removed field is the case the additive-only rule exists to catch',
    baseline: { a: 1, b: 2 },
    target: { a: 1 },
    expect: 'breaking',
    kind: 'field-removed',
  },
  {
    name: 'a removed nested field is caught at any depth',
    baseline: { outer: { a: 1, b: 2 } },
    target: { outer: { a: 1 } },
    expect: 'breaking',
    kind: 'field-removed',
  },
  {
    name: 'a number becoming a string breaks every caller that did arithmetic on it',
    baseline: { shards: 0 },
    target: { shards: '0' },
    expect: 'breaking',
    kind: 'type-changed',
  },
  {
    name: 'an array becoming an object breaks every caller that iterated it',
    baseline: { ledger: [] },
    target: { ledger: {} },
    expect: 'breaking',
    kind: 'type-changed',
  },
  {
    name: 'a boolean becoming a string is a type change even when it reads the same',
    baseline: { seasonPass: false },
    target: { seasonPass: 'false' },
    expect: 'breaking',
    kind: 'type-changed',
  },
  {
    name: 'a shorter catalogue is a withdrawn SKU — something enumerable yesterday has gone',
    baseline: { coins: [{ coin: 'EMBER' }, { coin: 'BTC' }] },
    target: { coins: [{ coin: 'EMBER' }] },
    expect: 'breaking',
    kind: 'array-shortened',
  },
  {
    name: 'a populated field that is now always null is broken however it was typed',
    baseline: { txid: 'abc' },
    target: { txid: null },
    expect: 'breaking',
    kind: 'nulled',
  },
  {
    name: 'a changed error code is the silent break every error handler misses',
    baseline: { code: 'insufficient_funds' },
    target: { code: 'insufficient_balance' },
    expect: 'breaking',
    kind: 'error-code-changed',
  },
  {
    name: 'a nested error code is held to the same rule',
    baseline: { error: { code: 'unauthorized' } },
    target: { error: { code: 'unauthenticated' } },
    expect: 'breaking',
    kind: 'error-code-changed',
  },
  {
    name: 'a chain id changing makes every signature bound to somebody else’s network',
    baseline: { chainId: 7412 },
    target: { chainId: 7411 },
    expect: 'breaking',
    kind: 'contract-value-changed',
  },
  {
    name: 'a confirmation depth changing credits deposits at the wrong depth',
    baseline: { coin: 'EMBER', confirmations: 60 },
    target: { coin: 'EMBER', confirmations: 3 },
    expect: 'breaking',
    kind: 'contract-value-changed',
  },
  {
    name: 'a decimals figure changing moves every amount by three orders of magnitude',
    baseline: { decimals: 18 },
    target: { decimals: 8 },
    expect: 'breaking',
    kind: 'contract-value-changed',
  },
  {
    name: 'a field that was a normalised number arriving as a string is still a type change',
    baseline: { usd: '<number>' },
    target: { usd: '0.30' },
    expect: 'breaking',
    kind: 'placeholder-type-mismatch',
  },
  {
    name: 'a field removed from an array element is caught per element',
    baseline: { rates: [{ coin: 'EMBER', usable: true }] },
    target: { rates: [{ coin: 'EMBER' }] },
    expect: 'breaking',
    kind: 'field-removed',
  },
]

describe('the comparator classifies additive against breaking', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const diffs = compareJson(testCase.baseline, testCase.target)
      if (testCase.expect === 'identical') {
        assert.deepEqual(diffs, [], `expected no difference, got ${JSON.stringify(diffs)}`)
        return
      }
      assert.ok(diffs.length > 0, 'expected a difference and found none')
      const worst = diffs.some((d) => d.classification === 'breaking') ? 'breaking' : 'benign'
      assert.equal(worst, testCase.expect, `classified ${JSON.stringify(diffs)}`)
      if (testCase.kind) {
        assert.ok(
          diffs.some((d) => d.kind === testCase.kind),
          `expected kind '${testCase.kind}', got ${diffs.map((d) => d.kind).join(', ')}`,
        )
      }
    })
  }

  it('a field added and a field removed in one response report both, not the nearest one', () => {
    const diffs = compareJson({ a: 1, b: 2 }, { a: 1, c: 3 })
    assert.deepEqual(new Set(diffs.map((d) => d.kind)), new Set(['field-removed', 'field-added']))
    assert.equal(diffs.filter((d) => d.classification === 'breaking').length, 1)
  })

  it('an additive change deep inside a shortened array still reports the shortening', () => {
    const diffs = compareJson({ xs: [{ a: 1 }, { a: 2 }] }, { xs: [{ a: 1, b: 9 }] })
    assert.ok(diffs.some((d) => d.kind === 'array-shortened' && d.classification === 'breaking'))
    assert.ok(diffs.some((d) => d.kind === 'field-added' && d.classification === 'benign'))
  })
})

// ------------------------------------------------------------ interactions --

function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    formatVersion: FORMAT_VERSION,
    scenario: 'wallet',
    step: 'read the wallet',
    seq: 0,
    target: 'pay',
    request: { method: 'GET', path: '/wallet', headers: {}, body: null },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: { shards: 0 } },
    timing: 'fast',
    ...overrides,
  }
}

describe('the comparator over whole interactions', () => {
  it('a changed status code is breaking on its own', () => {
    const diffs = compareInteraction(
      interaction(),
      interaction({ response: { status: 500, headers: { 'content-type': 'application/json' }, body: { shards: 0 } } }),
    )
    assert.ok(diffs.some((d) => d.kind === 'status-changed' && d.classification === 'breaking'))
  })

  it('a JSON route answering HTML is breaking even while the status stays 200', () => {
    const diffs = compareInteraction(
      interaction(),
      interaction({ response: { status: 200, headers: { 'content-type': 'text/html' }, body: { shards: 0 } } }),
    )
    assert.ok(diffs.some((d) => d.path === 'response.headers.content-type' && d.classification === 'breaking'))
  })

  it('a charset appearing on the content type is not a break', () => {
    const diffs = compareInteraction(
      interaction(),
      interaction({
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: { shards: 0 },
        },
      }),
    )
    assert.ok(diffs.every((d) => d.classification !== 'breaking'))
  })

  it('a route that got slower is reported and does not block a release', () => {
    const diffs = compareInteraction(interaction(), interaction({ timing: 'slow' }))
    assert.deepEqual(diffs.map((d) => d.kind), ['timing-changed'])
    assert.equal(diffs[0]?.classification, 'benign')
  })

  it('the scenario and step travel with every difference, so a report names where it happened', () => {
    const diffs = compareInteraction(interaction(), interaction({ response: { status: 404, headers: {}, body: null } }))
    assert.ok(diffs.length > 0)
    for (const d of diffs) {
      assert.equal(d.scenario, 'wallet')
      assert.equal(d.step, 'read the wallet')
    }
  })
})

// ----------------------------------------------------------------- corpora --

function manifest(scenarios: CorpusManifest['scenarios']): CorpusManifest {
  return {
    formatVersion: FORMAT_VERSION,
    base: 'local',
    recordedAt: '2026-07-30T00:00:00.000Z',
    scenarios,
    totals: { interactions: 0, recorded: 0, skipped: 0, failed: 0 },
    normalisationRules: [],
  }
}

describe('the comparator over a whole corpus', () => {
  it('a scenario that recorded and now skips is breaking — it stopped looking', () => {
    const report = compareCorpora(
      [],
      [],
      manifest([{ name: 'wallet', title: 'w', outcome: 'recorded', interactions: 4, cleanupErrors: [] }]),
      manifest([
        { name: 'wallet', title: 'w', outcome: 'skipped', reason: 'pay did not answer', interactions: 0, cleanupErrors: [] },
      ]),
    )
    assert.equal(report.breaking, true)
    assert.equal(report.differences[0]?.kind, 'scenario-no-longer-records')
    assert.match(report.differences[0]?.detail ?? '', /pay did not answer/)
  })

  it('a scenario that skipped and now records is a gap in the baseline, not a break', () => {
    const report = compareCorpora(
      [],
      [],
      manifest([
        { name: 'game', title: 'g', outcome: 'skipped', reason: 'no world exists', interactions: 0, cleanupErrors: [] },
      ]),
      manifest([{ name: 'game', title: 'g', outcome: 'recorded', interactions: 3, cleanupErrors: [] }]),
    )
    assert.equal(report.breaking, false)
    assert.equal(report.differences[0]?.kind, 'scenario-now-records')
  })

  it('an interaction the replay never made is breaking', () => {
    const report = compareCorpora([interaction()], [])
    assert.equal(report.breaking, true)
    assert.equal(report.differences[0]?.kind, 'interaction-missing')
  })

  it('an interaction the replay added is benign', () => {
    const report = compareCorpora([], [interaction()])
    assert.equal(report.breaking, false)
    assert.equal(report.differences[0]?.kind, 'interaction-added')
  })

  it('interactions match on step and occurrence, so an earlier omission does not renumber the rest', () => {
    const baseline = [
      interaction({ scenario: 'health', step: 'nimbus reports healthy', seq: 0 }),
      interaction({ scenario: 'health', step: 'pay reports healthy', seq: 1 }),
      interaction({ scenario: 'health', step: 'crucible reports healthy', seq: 2 }),
    ]
    // The replay could not reach pay, so its two survivors carry sequence numbers 0 and 1.
    const target = [
      interaction({ scenario: 'health', step: 'nimbus reports healthy', seq: 0 }),
      interaction({ scenario: 'health', step: 'crucible reports healthy', seq: 1 }),
    ]
    const report = compareCorpora(baseline, target)
    const missing = report.differences.filter((d) => d.kind === 'interaction-missing')
    assert.equal(missing.length, 1, 'exactly one absence should be reported, not a renumbering cascade')
    assert.equal(missing[0]?.step, 'pay reports healthy')
  })

  it('a repeated step label is disambiguated by occurrence rather than collapsing', () => {
    const baseline = [
      interaction({ scenario: 'identity', step: 'request a handoff code', seq: 0, response: { status: 403, headers: {}, body: null } }),
      interaction({ scenario: 'identity', step: 'request a handoff code', seq: 1, response: { status: 200, headers: {}, body: null } }),
    ]
    const report = compareCorpora(baseline, baseline)
    assert.equal(report.breaking, false)
    assert.equal(report.interactionsCompared, 2)
  })

  it('an unchanged corpus compared against itself reports no difference at all', () => {
    const corpus = [interaction(), interaction({ step: 'read the price board', seq: 1 })]
    const report = compareCorpora(corpus, corpus)
    assert.deepEqual(report.differences, [])
    assert.equal(report.counts.identical, 2)
    assert.equal(report.breaking, false)
  })
})

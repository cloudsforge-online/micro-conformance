/**
 * The comparator.
 *
 * Everything this package is for comes down to one distinction: **additive versus breaking**.
 * [11-data-and-contract-strategy.md](../../../docs/ecosystem/11-data-and-contract-strategy.md) and
 * `contract-compat.yml` state the rule as additive-only, and
 * [14-testing-strategy.md](../../../docs/ecosystem/14-testing-strategy.md) §6 gives the reason: a
 * consumer records only the fields it actually reads, so a provider adding a field can never break
 * it, and a provider removing one always does. This module is that rule applied to whole recorded
 * responses instead of to hand-written expectations.
 *
 * Three classifications, and the middle one is where the judgement lives:
 *
 * - `identical` — the values agree, including two equal placeholders.
 * - `benign` — an additive change, or a value that normalisation was always going to erase, or a
 *   gauge that moved. Reported, counted, and not a failure.
 * - `breaking` — a removed field, a changed type, a changed status code, a changed error code, a
 *   shortened array, a populated field that is now null, or a scenario that used to record and now
 *   skips. Any one of these exits non-zero, which is what makes this a CI gate rather than a
 *   report.
 *
 * **A value change of the same type is benign, and that is a deliberate limitation stated out
 * loud.** The corpus is recorded against a live estate whose market prices, block heights and
 * queue depths move between any two runs; classifying those as breaking would produce a gate that
 * fails for reasons nobody believes, and a gate nobody believes gets bypassed. Values that ARE
 * contract — an error code, a chain id — are handled explicitly below rather than by hoping the
 * general case covers them.
 */

import { isPlaceholder, PLACEHOLDER_TYPES } from './normalise.ts'
import type { CorpusManifest, Interaction, Json } from './types.ts'

export type Classification = 'identical' | 'benign' | 'breaking'

export type DifferenceKind =
  | 'status-changed'
  | 'error-code-changed'
  | 'contract-value-changed'
  | 'field-removed'
  | 'field-added'
  | 'type-changed'
  | 'placeholder-type-mismatch'
  | 'value-changed'
  | 'nulled'
  | 'nullable-populated'
  | 'array-shortened'
  | 'array-extended'
  | 'header-changed'
  | 'header-removed'
  | 'header-added'
  | 'timing-changed'
  | 'interaction-missing'
  | 'interaction-added'
  | 'scenario-no-longer-records'
  | 'scenario-now-records'

export interface Difference {
  readonly classification: Classification
  readonly kind: DifferenceKind
  /** Dotted path into the interaction, e.g. `response.body.wallet.shards`. */
  readonly path: string
  readonly detail: string
  readonly scenario?: string
  readonly step?: string
}

const BREAKING_KINDS = new Set<DifferenceKind>([
  'status-changed',
  'error-code-changed',
  'contract-value-changed',
  'field-removed',
  'type-changed',
  'placeholder-type-mismatch',
  'nulled',
  'array-shortened',
  'interaction-missing',
  'scenario-no-longer-records',
])

function classify(kind: DifferenceKind): Classification {
  return BREAKING_KINDS.has(kind) ? 'breaking' : 'benign'
}

function diff(kind: DifferenceKind, path: string, detail: string): Difference {
  return { classification: classify(kind), kind, path, detail }
}

/**
 * The field a consumer branches on when something went wrong.
 *
 * `code: 'insufficient_funds'` becoming `code: 'insufficient_balance'` is a silent behavioural
 * change that every caller's error handling misses, and it is invisible to a type check because
 * both are strings. This is the one value change the specification names as breaking outright.
 */
const ERROR_CODE_KEYS = new Set(['code', 'errorcode', 'error'])

/**
 * Keys whose value is an identifier a caller compares against a constant, rather than data.
 *
 * A coin symbol, a chain id, a confirmation depth, a decimals figure and a lifecycle state are all
 * facts something downstream is pinned to. `contracts-chain` is exact-pinned across the estate for
 * exactly this reason: wallet, settlement, custody and indexer disagreeing about a confirmation
 * depth is how a deposit credits at the wrong depth. Leaving these to the general value-changed
 * case would classify a chain id changing from 7412 to 7411 as benign, and that single change
 * makes every signature bound to this testnet replayable on somebody else's network.
 */
const CONTRACT_VALUE_KEYS = new Set([
  'coin',
  'chain',
  'chainid',
  'network',
  'family',
  'kind',
  'type',
  'status',
  'state',
  'symbol',
  'reason',
  'decimals',
  'confirmations',
  'keyvaultchain',
  'model',
  'service',
])

const lastKey = (path: string): string => {
  const parts = path.split('.')
  const tail = parts[parts.length - 1] ?? ''
  return tail.replace(/\[\d+\]$/, '')
}

/** Compare two JSON values, producing every difference between them. */
export function compareJson(baseline: Json, target: Json, path = ''): Difference[] {
  // Two equal placeholders is the normal case for anything volatile: the field was recorded, it
  // was erased on both sides by the same rule, and the only claim being made — that it is present
  // and of the placeholder's type — holds.
  if (isPlaceholder(baseline)) {
    if (baseline === target) return []
    if (isPlaceholder(target)) {
      // Two different placeholders means two different rules fired, which means the underlying
      // shape changed: an EVM address where a bech32 address used to be is a real difference.
      return [diff('value-changed', path, `normalised as ${baseline}, now normalised as ${target}`)]
    }
    const expected = PLACEHOLDER_TYPES[baseline]
    const actual = jsonType(target)
    if (expected && actual !== expected) {
      return [
        diff(
          'placeholder-type-mismatch',
          path,
          `was a normalised ${expected} (${baseline}), is now ${actual}`,
        ),
      ]
    }
    // Same type, but the rule did not fire on the target. That is a value the recorder would have
    // normalised had it looked the same — a differently formatted id, say — so it is reported and
    // is not a break.
    return [diff('value-changed', path, `was ${baseline}, is now an un-normalised ${actual}`)]
  }

  if (isPlaceholder(target)) {
    return [diff('value-changed', path, `was a literal ${jsonType(baseline)}, is now ${target}`)]
  }

  if (baseline === null && target !== null) {
    // A nullable field that now carries a value. Additive in spirit: no caller that handled null
    // breaks because a value arrived.
    return [diff('nullable-populated', path, `was null, is now ${jsonType(target)}`)]
  }
  if (baseline !== null && target === null) {
    // The reverse is not symmetrical. A caller reading a value that is now always null is broken
    // whether or not its type declaration allowed it.
    return [diff('nulled', path, `was ${jsonType(baseline)}, is now null`)]
  }

  const bType = jsonType(baseline)
  const tType = jsonType(target)
  if (bType !== tType) {
    return [diff('type-changed', path, `was ${bType}, is now ${tType}`)]
  }

  if (Array.isArray(baseline) && Array.isArray(target)) {
    const out: Difference[] = []
    const shared = Math.min(baseline.length, target.length)
    for (let i = 0; i < shared; i++) {
      out.push(...compareJson(baseline[i] as Json, target[i] as Json, `${path}[${i}]`))
    }
    if (target.length > baseline.length) {
      // A longer catalogue is a new product, not a broken one.
      out.push(diff('array-extended', path, `had ${baseline.length} entries, now has ${target.length}`))
    } else if (target.length < baseline.length) {
      // A shorter one is a withdrawn SKU, a dropped chain or a missing strategy. Always breaking:
      // something a caller could enumerate yesterday has gone.
      out.push(diff('array-shortened', path, `had ${baseline.length} entries, now has ${target.length}`))
    }
    return out
  }

  if (bType === 'object') {
    const b = baseline as Record<string, Json>
    const t = target as Record<string, Json>
    const out: Difference[] = []
    for (const key of Object.keys(b)) {
      const child = path ? `${path}.${key}` : key
      if (!Object.prototype.hasOwnProperty.call(t, key)) {
        out.push(diff('field-removed', child, 'the field is no longer present'))
        continue
      }
      out.push(...compareJson(b[key] as Json, t[key] as Json, child))
    }
    for (const key of Object.keys(t)) {
      if (Object.prototype.hasOwnProperty.call(b, key)) continue
      // The additive-only rule, in one line. A new optional key is allowed and is the whole reason
      // a provider can ship ahead of its consumers.
      out.push(diff('field-added', path ? `${path}.${key}` : key, 'a new field is present'))
    }
    return out
  }

  if (baseline === target) return []

  const field = lastKey(path).toLowerCase()
  if (ERROR_CODE_KEYS.has(field)) {
    return [diff('error-code-changed', path, `was '${String(baseline)}', is now '${String(target)}'`)]
  }
  if (CONTRACT_VALUE_KEYS.has(field)) {
    return [diff('contract-value-changed', path, `was ${JSON.stringify(baseline)}, is now ${JSON.stringify(target)}`)]
  }

  return [diff('value-changed', path, `was ${JSON.stringify(baseline)}, is now ${JSON.stringify(target)}`)]
}

function jsonType(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Compare one recorded interaction against its replay. */
export function compareInteraction(baseline: Interaction, target: Interaction): Difference[] {
  const out: Difference[] = []
  const tag = (d: Difference): Difference => ({ ...d, scenario: baseline.scenario, step: baseline.step })

  if (baseline.response.status !== target.response.status) {
    out.push(
      diff(
        'status-changed',
        'response.status',
        `was ${baseline.response.status}, is now ${target.response.status}`,
      ),
    )
  }

  out.push(...compareHeaders(baseline.response.headers, target.response.headers))
  out.push(...compareJson(baseline.response.body, target.response.body, 'response.body'))

  // The request is compared too, because a scenario driving a different request against a changed
  // service is not evidence about the service. A difference here means the harness itself, or the
  // data it was given, changed — worth seeing, never a product break.
  if (baseline.request.path !== target.request.path) {
    out.push(diff('value-changed', 'request.path', `was ${baseline.request.path}, is now ${target.request.path}`))
  }

  if (baseline.timing !== target.timing) {
    out.push(diff('timing-changed', 'timing', `was ${baseline.timing}, is now ${target.timing}`))
  }

  return out.map(tag)
}

/**
 * Headers are compared narrowly on purpose.
 *
 * Only `content-type` is treated as contract: a route that answered `application/json` and now
 * answers `text/html` has been replaced by an error page or a SPA fallback, and every caller
 * parsing it breaks while the status stays 200. Everything else — cache directives, CORS echoes —
 * is deployment configuration, differs legitimately between an old service and its gateway-fronted
 * replacement, and would otherwise fill the report with noise that hides the one line that matters.
 */
function compareHeaders(
  baseline: Readonly<Record<string, string>>,
  target: Readonly<Record<string, string>>,
): Difference[] {
  const out: Difference[] = []
  for (const [name, value] of Object.entries(baseline)) {
    const seen = target[name]
    if (seen === undefined) {
      const kind: DifferenceKind = name === 'content-type' ? 'type-changed' : 'header-removed'
      out.push(diff(kind, `response.headers.${name}`, `header '${name}' is no longer sent`))
      continue
    }
    if (seen === value) continue
    if (name === 'content-type') {
      const was = value.split(';')[0]?.trim()
      const now = seen.split(';')[0]?.trim()
      if (was !== now) {
        out.push(diff('type-changed', 'response.headers.content-type', `was ${was}, is now ${now}`))
        continue
      }
    }
    out.push(diff('header-changed', `response.headers.${name}`, `was '${value}', is now '${seen}'`))
  }
  for (const name of Object.keys(target)) {
    if (name in baseline) continue
    out.push(diff('header-added', `response.headers.${name}`, `header '${name}' is now sent`))
  }
  return out
}

export interface ComparisonReport {
  readonly differences: readonly Difference[]
  readonly counts: Readonly<Record<Classification, number>>
  readonly byKind: Readonly<Record<string, number>>
  readonly interactionsCompared: number
  readonly breaking: boolean
}

const key = (i: Interaction): string => `${i.scenario}\u0000${i.seq}\u0000${i.step}`

/**
 * Match interactions by scenario, step label and occurrence — **not** by sequence number.
 *
 * Sequence numbers shift. The `health` scenario calls nine services and records nothing for the
 * ones that do not answer, so a single absent service renumbers everything after it, and a
 * seq-keyed match would report eight false missing interactions to describe one real absence.
 *
 * Step labels are stable by convention — the same convention that makes a Beacon step name a
 * metric series, and the same reason renaming one is a deliberate act. The occurrence index
 * disambiguates the one place a label legitimately repeats: `identity` offering each candidate
 * return URL in turn until the handoff allowlist accepts one.
 */
function keyed(interactions: readonly Interaction[]): Array<{ key: string; interaction: Interaction }> {
  const seen = new Map<string, number>()
  return [...interactions]
    .sort((a, b) => (a.scenario === b.scenario ? a.seq - b.seq : a.scenario < b.scenario ? -1 : 1))
    .map((interaction) => {
      const label = `${interaction.scenario}|${interaction.step}`
      const occurrence = seen.get(label) ?? 0
      seen.set(label, occurrence + 1)
      return { key: `${label}|${occurrence}`, interaction }
    })
}

/** Compare a recorded corpus against a replay of the same scenarios. */
export function compareCorpora(
  baseline: readonly Interaction[],
  target: readonly Interaction[],
  baselineManifest?: CorpusManifest,
  targetManifest?: CorpusManifest,
): ComparisonReport {
  const differences: Difference[] = []

  if (baselineManifest && targetManifest) {
    const targetByName = new Map(targetManifest.scenarios.map((s) => [s.name, s]))
    for (const before of baselineManifest.scenarios) {
      const after = targetByName.get(before.name)
      if (!after) {
        differences.push({
          ...diff('scenario-no-longer-records', `scenario.${before.name}`, 'the scenario is absent from the replay'),
          scenario: before.name,
        })
        continue
      }
      // The most valuable scenario-level signal there is. A scenario that recorded against the old
      // estate and skips against the new one has not passed — it has stopped looking, and a corpus
      // that counted that as green would certify a service nobody exercised.
      if (before.outcome === 'recorded' && after.outcome !== 'recorded') {
        differences.push({
          ...diff(
            'scenario-no-longer-records',
            `scenario.${before.name}`,
            `recorded against the baseline, ${after.outcome} against the target: ${after.reason ?? 'no reason given'}`,
          ),
          scenario: before.name,
        })
      }
      if (before.outcome !== 'recorded' && after.outcome === 'recorded') {
        differences.push({
          ...diff(
            'scenario-now-records',
            `scenario.${before.name}`,
            `${before.outcome} against the baseline, recorded against the target — the baseline has a gap here`,
          ),
          scenario: before.name,
        })
      }
    }
  }

  const targetByKey = new Map(keyed(target).map((k) => [k.key, k.interaction]))
  let compared = 0

  for (const { key, interaction: before } of keyed(baseline)) {
    const after = targetByKey.get(key)
    if (!after) {
      differences.push({
        ...diff(
          'interaction-missing',
          `${before.scenario}/${before.seq}`,
          `${before.request.method} ${before.request.path} ('${before.step}') was not replayed`,
        ),
        scenario: before.scenario,
        step: before.step,
      })
      continue
    }
    compared++
    differences.push(...compareInteraction(before, after))
  }

  const baselineKeys = new Set(keyed(baseline).map((k) => k.key))
  for (const { key, interaction: after } of keyed(target)) {
    if (baselineKeys.has(key)) continue
    differences.push({
      ...diff(
        'interaction-added',
        `${after.scenario}/${after.seq}`,
        `${after.request.method} ${after.request.path} ('${after.step}') has no baseline`,
      ),
      scenario: after.scenario,
      step: after.step,
    })
  }

  const counts: Record<Classification, number> = { identical: 0, benign: 0, breaking: 0 }
  const byKind: Record<string, number> = {}
  for (const d of differences) {
    counts[d.classification]++
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
  }
  // Everything compared and not reported is identical. Counting it makes the headline honest:
  // "3 benign" means nothing without the number it is out of.
  counts.identical = compared - new Set(differences.filter((d) => d.step).map((d) => `${d.scenario}/${d.step}`)).size

  return {
    differences,
    counts,
    byKind,
    interactionsCompared: compared,
    breaking: differences.some((d) => d.classification === 'breaking'),
  }
}

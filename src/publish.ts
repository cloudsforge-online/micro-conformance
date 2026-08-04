/**
 * Publishing a comparison to Beacon, so the gate can read it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NOTHING HAS EVER POSTED A CONFORMANCE RUN, WHICH IS WHY THE GATE SAYS `conformance_never_run`.**
 *
 * Found on 2026-08-04, by grepping the whole estate for `/v1/conformance`. `beacon/src/server.ts`
 * defines `POST /v1/conformance` and its own comment says "the corpus is replayed by
 * `@cloudsforge/conformance` in CI; this is where the result becomes an operational fact and a
 * gate input". `micro-beacon-web` documents the route. `deploy` routes it through the gateway.
 *
 * **No caller exists.** Not in this repository, not in any CI workflow, not in any deploy script.
 * The recording end and the gating end were each built correctly and were never joined, so
 * `conformance_runs` has been empty since the table was created and the gate has been
 * indeterminate on that input for its entire life. The corpus proves nothing to the gate that
 * nobody hands it.
 *
 * This module is that wire. It does not decide anything — Beacon derives the status from the
 * counts, deliberately, so that a reporter cannot declare its own `pass` alongside a breaking
 * difference — it only carries what `compare` found.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **One run per SCENARIO, not one per estate.** A single row summing eight scenarios would let a
 * broad corpus be certified by its narrowest one: `chain` records against a testnet that is always
 * up, so an estate-wide row would report `pass` while `identity`, `wallet` and five others had not
 * run at all. Beacon keys `latestConformance` on suite and the gate now reports per suite, so the
 * scenario is the right grain and the one that survives contact with a partial estate.
 */

import type { ComparisonReport, Difference } from './compare.ts'

/** What `POST /v1/conformance` accepts. `status` is DERIVED by Beacon from the counts. */
export interface ConformancePost {
  readonly suite: string
  readonly identical: number
  readonly benign: number
  readonly breaking: number
  readonly skipped: number
  readonly durationMs?: number
  readonly release?: string
  readonly corpusRef?: string
}

export interface PublishResult {
  readonly suite: string
  readonly status: number
  readonly ok: boolean
  readonly error: string | null
}

/**
 * A scenario that the replay could not run at all.
 *
 * Carried separately from the differences because it is a different fact. A scenario with zero
 * comparisons is not a scenario with zero differences, and the whole reason this module exists is
 * that Beacon must be able to tell those apart — `identical + benign === 0` is what makes its
 * `statusFor` derive `skip` rather than `pass`.
 */
export interface SkippedScenario {
  readonly name: string
  readonly reason: string
}

function classify(differences: readonly Difference[], scenario: string): {
  benign: number
  breaking: number
} {
  let benign = 0
  let breaking = 0
  for (const difference of differences) {
    if (difference.scenario !== scenario) continue
    if (difference.classification === 'breaking') breaking += 1
    else if (difference.classification === 'benign') benign += 1
  }
  return { benign, breaking }
}

/**
 * Turn a comparison report into one post per scenario.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **`identical` IS COUNTED PER SCENARIO, NOT APPORTIONED FROM THE ESTATE-WIDE FIGURE.**
 *
 * The first version of this reached for `report.counts.identical` — which is one number for the
 * whole run — and handed it to every scenario. Eight scenarios would each have claimed all 60
 * agreements, so a suite that compared three interactions would have reported sixty identical, and
 * `identical + benign > 0` is exactly the test Beacon's `statusFor` uses to decide a run is a
 * `pass` rather than a `skip`. A scenario that compared nothing could have been carried over that
 * line by another scenario's arithmetic. That is inventing evidence, which is the one thing this
 * whole exercise must not do.
 *
 * So the caller passes how many interactions each scenario actually compared — it is the only
 * thing that knows, because the report carries scenarios only on the differences — and identical
 * is that count minus this scenario's own differences. Floored at zero rather than trusted.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * **A scenario that did not run is posted with all four counts at zero**, so Beacon derives `skip`
 * and the gate reports `conformance_inconclusive`. Omitting it would be worse than useless: the
 * gate's only other conformance input is whether ANY row exists, so publishing the seven that ran
 * and quietly dropping the one that did not is precisely how a partial estate certifies itself.
 */
export function postsFor(
  report: ComparisonReport,
  comparedByScenario: ReadonlyMap<string, number>,
  skipped: readonly SkippedScenario[],
  options: { readonly release?: string | undefined; readonly corpusRef?: string | undefined } = {},
): readonly ConformancePost[] {
  const skippedByName = new Map(skipped.map((entry) => [entry.name, entry]))
  const scenarios = [
    ...new Set([...comparedByScenario.keys(), ...skipped.map((entry) => entry.name)]),
  ].sort()

  const tag = {
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.corpusRef === undefined ? {} : { corpusRef: options.corpusRef }),
  }

  return scenarios.map((scenario) => {
    if (skippedByName.has(scenario)) {
      return { suite: scenario, identical: 0, benign: 0, breaking: 0, skipped: 1, ...tag }
    }
    const { benign, breaking } = classify(report.differences, scenario)
    const compared = comparedByScenario.get(scenario) ?? 0
    return {
      suite: scenario,
      // Never negative, and never invented: a scenario with more differences than compared
      // interactions reports zero identical rather than a wrapped-around count.
      identical: Math.max(0, compared - benign - breaking),
      benign,
      breaking,
      skipped: 0,
      ...tag,
    }
  })
}

/**
 * POST each one to Beacon.
 *
 * Sequential, and every failure is recorded rather than thrown: a publisher that threw on the
 * fourth of eight would leave a pipeline with a stack trace and no statement of which suites the
 * gate now knows about — and the gate would then be reading a half-published estate, which is the
 * one state worse than an unpublished one.
 */
export async function publish(
  posts: readonly ConformancePost[],
  options: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
    readonly timeoutMs?: number
  },
): Promise<readonly PublishResult[]> {
  const results: PublishResult[] = []
  for (const post of posts) {
    const url = new URL('/v1/conformance', options.baseUrl)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify(post),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      })
      const text = await response.text()
      results.push({
        suite: post.suite,
        status: response.status,
        ok: response.ok,
        error: response.ok ? null : text.slice(0, 240),
      })
    } catch (err) {
      results.push({
        suite: post.suite,
        status: 0,
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    }
  }
  return results
}

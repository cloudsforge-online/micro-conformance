/**
 * Which suites APPLY to a base, and the one narrow way a suite may stop applying.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO DIFFERENT FACTS WERE BEING PUBLISHED AS ONE, AND THAT CONFLATION IS THE DEFECT.**
 *
 *   1. **"This scenario should have run here and could not."** Transport failure, an unreachable
 *      host, a credential the operator did not give. Nobody found out. That is a SKIP, it is
 *      published with zero counts, Beacon derives `skip`, and the gate reports
 *      `conformance_inconclusive` — an unknown that refuses and cannot be waived. It is meant to
 *      resolve the moment the estate is whole again.
 *
 *   2. **"This scenario does not apply to this base at all."** The surface it characterises was
 *      not switched off, it was REPLACED, and the capability is characterised by a different suite
 *      in the same run. Nobody needs to find anything out. Published as a skip it becomes an
 *      unknown that can never resolve — and a permanently unresolvable unknown is not a safe
 *      default, it is a gate that can never go green, which is a gate people learn to override.
 *
 * `README.md` §"the wire that was missing" states the rule this file narrows: *"A scenario is never
 * dropped from the publish: the gate's other conformance input is whether any row exists, so
 * publishing the suites that ran and quietly omitting the ones that did not is exactly how a
 * partial estate would certify itself."* That rule is **correct for (1) and wrong for (2)**, and it
 * still holds for (1) without exception — nothing below widens it.
 *
 * ── AND THIS IS EXACTLY THE MECHANISM SOMEBODY WOULD USE TO SILENCE A REAL GAP ────────────────
 *
 * So it is not a flag, and it is not a list of names. A suite may be withheld only by a claim that
 * **names the suite covering the same capability in the same base**, and that claim is checked
 * against the run that is being published — not against a comment. Six things must all hold, and
 * failing any one of them REJECTS the claim, publishes the suite as an ordinary skip, and makes
 * the run exit non-zero:
 *
 *   S1  `coveredBy` is a real scenario in the catalogue.               (static, at import)
 *   S2  `coveredBy` is not the withheld suite itself.                  (static, at import)
 *   S3  `coveredBy` is not itself withheld in this base — no chains,   (static, at import)
 *       no cycles, no delegating to something that also delegated.
 *   S4  the reason cites at least one `path:line`.                     (static, at import)
 *   R1  the withheld suite skipped in THIS replay. A suite that        (per run)
 *       recorded interactions is published on its own evidence,
 *       whatever a declaration says.
 *   R2  the withheld suite has no baseline interactions in the corpus  (per run)
 *       being compared against. If it has, the corpus contradicts the
 *       claim and the skip is a recorded-then-skipped regression.
 *   R3  `coveredBy` ran in THIS replay and compared at least one       (per run)
 *       interaction — i.e. Beacon will derive something other than
 *       `skip` for it. A dangling or skipped successor is the abuse
 *       case and it is what these checks exist to catch.
 *
 * S1–S4 make the bad declaration unwritable; R1–R3 make the bad *run* unpublishable. Both halves
 * are needed: a successor can exist in the catalogue and still not have run, and that is precisely
 * the state in which "covered by X" would be a lie.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { ALL_SCENARIOS } from './scenarios/index.ts'
import type { ScenarioReport } from './types.ts'

/**
 * A claim that one suite does not apply to a base because another suite covers the capability.
 *
 * `coveredBy` is not optional and there is no variant of this without it. "Not applicable" with
 * nothing named is just a skip with better manners, and it is the shape this whole file refuses to
 * make representable.
 */
export interface NotApplicable {
  /** The suite that does not apply here. */
  readonly scenario: string
  /** The suite that characterises the same capability in this base. Must run, and must compare. */
  readonly coveredBy: string
  /**
   * Why the surface this suite records is not served here. Read by an operator in the run output,
   * so it says what is true and where that was checked — a `path:line` is required, not encouraged.
   */
  readonly reason: string
}

/**
 * The declarations, per base.
 *
 * ── WHY `local` DECLARES NOTHING, ALTHOUGH THE MIRROR CLAIM IS PROBABLY TRUE ──────────────────
 *
 * Against `local`, the five `micro-*` suites skip for the mirror reason: those services do not
 * exist in the legacy estate, and the capability is covered there by `wallet`, `entitlements`,
 * `mint`, `trade` and `game`. Writing that symmetry down would be tidy and it is NOT written down,
 * because **it cannot be verified**: README §2a records that eight of the legacy estate's ten
 * services refuse connections, so no run can demonstrate that the ancestor suite covers anything.
 * R3 would reject every one of those claims at publish time anyway — but a declaration that only
 * the runtime check keeps honest is a declaration somebody will one day read as an endorsement.
 * An unverified retirement is the abuse case even when it happens to be true.
 */
const NOT_APPLICABLE: Readonly<Record<string, readonly NotApplicable[]>> = {
  local: [],

  /* ══════════════════════════════════════════════════════════════════════════════════════════
   * `micro` — the five legacy product suites, and the successors that replaced them.
   *
   * Every line below was re-measured on 2026-08-04 against the running estate, through the
   * gateway, on the estate CA (`curl --cacert deploy/gateway/certs/ca.crt`, never `-k`), and
   * re-read in the successors' own route tables. The route-table citation is the load-bearing
   * half: a 404 measured once is a deployment, a route that is absent from the service's source
   * is a design.
   * ══════════════════════════════════════════════════════════════════════════════════════════ */
  micro: [
    {
      scenario: 'wallet',
      coveredBy: 'micro-wallet',
      reason:
        'the recorded payments surface is served at no address on this base. micro-wallet answers ' +
        'pay.<apex> whole at priority 500 (deploy/gateway/dynamic/estate-web.yml:822-826) and its ' +
        'route table is /v1/wallets, /v1/deposits, /v1/deposits/credits, /v1/withdrawals and ' +
        '/v1/portfolio (wallet/src/server.ts:477-827) — none of /wallet, /coins/rates, ' +
        '/deposit-coins, /withdrawal-coins, /deposits or /withdrawals appears anywhere in ' +
        'wallet/src, and all six answered 404 application/json from the service’s own handler when ' +
        'measured on 2026-08-04. The capability is covered by the micro-wallet suite, against those ' +
        'addresses, in this same run',
    },
    {
      scenario: 'entitlements',
      coveredBy: 'micro-entitlements',
      reason:
        'four of this suite’s five routes are served at no address on this base, and the fifth ' +
        'moved to the successor. micro-billing answers /entitlements, /products, /purchases and ' +
        '/subscriptions on pay.<apex> through a narrow router at priority 600 ' +
        '(deploy/gateway/dynamic/estate-web.yml:827-831); its route table is /products, ' +
        '/entitlements and /subscriptions (billing/src/server.ts:375-580) and it has no /cosmetics, ' +
        '/convenience, /season-pass or /private-worlds — the four frozen arrays ' +
        'billing/src/catalogue.ts:1-18 names as the thing it replaces, now rows behind one ' +
        'GET /products. Measured 2026-08-04: those four answer 404, /entitlements answers 401. The ' +
        'capability is covered by the micro-entitlements suite, which records /entitlements at the ' +
        'same path, anonymously and authenticated',
    },
    {
      scenario: 'mint',
      coveredBy: 'micro-mint',
      reason:
        'the recorded mint surface is served at no address on this base. micro-mint serves ' +
        '/v1/catalogue and /v1/tokens (mint/src/server.ts:354-441) and has no /chains, /offers or ' +
        '/capabilities, and create.<apex> routes ONLY PathPrefix(/v1) to it ' +
        '(deploy/gateway/dynamic/estate-web.yml:238-242) — the root of that host is the web bundle. ' +
        'Measured 2026-08-04: /chains, /offers and /capabilities answer 404 text/html and GET ' +
        '/tokens answers 200 text/html, the SPA shell, which is why this target is unmapped rather ' +
        'than repointed at the host. The capability is covered by the micro-mint suite, under ' +
        'create.<apex>/v1 where the API actually is',
    },
    {
      scenario: 'trade',
      coveredBy: 'micro-trade',
      reason:
        'the recorded trading surface is served at no address on this base. micro-trade serves ' +
        '/v1/strategies, /v1/capabilities, /v1/bots and /v1/backtests (trade/src/server.ts:341-590) ' +
        'and has no /catalog at all — the single largest static contract in the legacy estate and ' +
        'the whole of this suite. trade.<apex> routes ONLY PathPrefix(/v1) to it ' +
        '(deploy/gateway/dynamic/estate-web.yml:251-255). Measured 2026-08-04: /catalog and ' +
        '/billing answer 404 text/html, and GET /bots and GET /backtests answer 200 text/html — the ' +
        'SPA shell, which would have compared identical forever. The capability is covered by the ' +
        'micro-trade suite, under trade.<apex>/v1',
    },
    {
      scenario: 'game',
      coveredBy: 'micro-worlds',
      reason:
        'the recorded game surface is served at no address on this base, and not because it was ' +
        'renamed: Ninety Days After is a TITLE under Worlds now, not the product this corpus ' +
        'recorded. worlds-api.<apex> is routed whole to micro-worlds (cf-api-worlds-api, ' +
        'deploy/gateway/dynamic/estate-web.yml:327-331) and its route table is /v1/titles, ' +
        '/v1/players/me, /v1/players/me/inventory and /v1/provisions ' +
        '(worlds/src/server.ts:507-682) — neither /worlds nor /cosmetics appears anywhere in ' +
        'worlds/src, and both answered 404 application/json from the service when measured on ' +
        '2026-08-04. The capability is covered by the micro-worlds suite, against the platform ' +
        'surface that replaced it',
    },
  ],
}

/** A `path:line` citation. Anything else is prose, and prose is not evidence. */
const CITATION = /[\w./-]+\.(?:ts|tsx|yml|yaml|md|sh|sql|json):\d+/

/**
 * Refuse a declaration set that could not be honest, whatever the run then does.
 *
 * Exported and pure so the four static rules can be tested against declarations that are NOT in
 * this file. Testing them only through `NOT_APPLICABLE` would be testing that today's five entries
 * are fine, which is the check-that-cannot-fail shape all over again.
 */
export function validateDeclarations(
  declarations: Readonly<Record<string, readonly NotApplicable[]>>,
  knownScenarios: ReadonlySet<string>,
): void {
  for (const [base, claims] of Object.entries(declarations)) {
    const withheldHere = new Set(claims.map((claim) => claim.scenario))
    const seen = new Set<string>()

    for (const claim of claims) {
      const where = `base '${base}', not-applicable claim for '${claim.scenario}'`

      if (!knownScenarios.has(claim.scenario)) {
        throw new Error(`${where}: no such scenario. A claim about a suite that does not exist retires nothing.`)
      }
      if (seen.has(claim.scenario)) {
        throw new Error(`${where}: declared twice. Two reasons for one retirement means one of them is unread.`)
      }
      seen.add(claim.scenario)

      // S1. The abuse case in its purest form: "covered by X" where X does not exist.
      if (!knownScenarios.has(claim.coveredBy)) {
        throw new Error(
          `${where}: names '${claim.coveredBy}' as the suite covering the capability, and no such ` +
            'scenario exists. A retirement whose successor is a typo silences the suite and covers ' +
            `nothing. Known scenarios: ${[...knownScenarios].sort().join(', ')}`,
        )
      }
      // S2.
      if (claim.coveredBy === claim.scenario) {
        throw new Error(`${where}: names itself as its own successor, which withholds a suite on its own authority.`)
      }
      // S3. Without this, `a covered by b` and `b covered by c` retires two suites on one run of c,
      // and a cycle retires both on the strength of nothing at all.
      if (withheldHere.has(claim.coveredBy)) {
        throw new Error(
          `${where}: names '${claim.coveredBy}', which is ITSELF withheld as not applicable to ` +
            `base '${base}'. Delegation may not be chained: the suite named must be one that runs ` +
            'here, or the capability is covered by nothing and two suites have gone quiet.',
        )
      }
      // S4.
      if (!CITATION.test(claim.reason)) {
        throw new Error(
          `${where}: the reason cites no path:line. A retirement is a claim about the estate's ` +
            'source and routing, and an uncited one cannot be re-checked by the next reader — ' +
            'which is how a stale reason outlives the thing it described.',
        )
      }
    }
  }
}

const SCENARIO_NAMES: ReadonlySet<string> = new Set(ALL_SCENARIOS.map((scenario) => scenario.name))

// At import, so a malformed declaration cannot reach a run. `record`, `compare` and `report` all
// pull this module in through the CLI, so there is no command that skips the check.
validateDeclarations(NOT_APPLICABLE, SCENARIO_NAMES)

/** The claims declared for a base. Unknown bases have none rather than throwing: see `resolveBase`. */
export function notApplicableFor(baseName: string): readonly NotApplicable[] {
  return NOT_APPLICABLE[baseName] ?? []
}

export interface RejectedClaim {
  readonly claim: NotApplicable
  /** What failed, in the operator's terms. Printed, and it is the whole value of the rejection. */
  readonly why: string
}

export interface Applicability {
  /** Claims that held. These suites are NOT published: they are not part of this base's surface. */
  readonly withheld: readonly NotApplicable[]
  /** Claims that did not hold. These suites ARE published, as ordinary skips, and the run fails. */
  readonly rejected: readonly RejectedClaim[]
}

export interface ApplicabilityInput {
  readonly baseName: string
  /** Every scenario report from the replay that is being published. */
  readonly replay: readonly ScenarioReport[]
  /** Interactions per scenario in the BASELINE corpus being compared against. */
  readonly baselineByScenario: ReadonlyMap<string, number>
}

/**
 * Decide, for this run, which claims hold.
 *
 * A claim about a scenario that did not run in this replay at all — `--only` was used — is neither
 * upheld nor rejected. Nothing is published for that scenario either way, so there is nothing to
 * withhold and nothing to be silenced.
 */
export function resolveApplicability(input: ApplicabilityInput): Applicability {
  const byName = new Map(input.replay.map((scenario) => [scenario.name, scenario]))
  const withheld: NotApplicable[] = []
  const rejected: RejectedClaim[] = []

  for (const claim of notApplicableFor(input.baseName)) {
    const ran = byName.get(claim.scenario)
    if (!ran) continue

    // R1. The declaration does not get to decide what happened. If the suite recorded interactions
    // it observed the estate, and what it observed is published — a stale retirement must never be
    // able to suppress a suite that is working.
    if (ran.outcome !== 'skipped') {
      rejected.push({
        claim,
        why:
          `it ${ran.outcome} ${ran.interactions} interaction(s) in this run, so it DOES apply to base ` +
          `'${input.baseName}'. A suite that reached the estate is published on its own evidence; ` +
          'the declaration is stale and is what needs changing.',
      })
      continue
    }

    // R2. The corpus is the other witness, and it outranks the declaration too. A baseline holding
    // interactions for this suite means it applied to this base when the baseline was recorded, so
    // a skip now is a regression — the exact thing `compare` classes as breaking — and withholding
    // it would delete the evidence of that regression on the way to Beacon.
    const baseline = input.baselineByScenario.get(claim.scenario) ?? 0
    if (baseline > 0) {
      rejected.push({
        claim,
        why:
          `the baseline corpus holds ${baseline} interaction(s) for it, so it applied to base ` +
          `'${input.baseName}' when that corpus was recorded. Skipping now is a regression, not a ` +
          'retirement, and withholding it would hide exactly the difference this harness exists to find.',
      })
      continue
    }

    // R3. The claim's whole content: the capability is covered by that suite, in this run. A
    // successor that did not run covers nothing, and "covered by a suite that also skipped" is the
    // abuse case this file was written to make impossible.
    const successor = byName.get(claim.coveredBy)
    if (!successor) {
      rejected.push({
        claim,
        why:
          `it names '${claim.coveredBy}' as the suite covering the capability, and that suite did ` +
          'not run at all in this replay (it is filtered out, or it is not in the catalogue for ' +
          'this run). Nothing covered the capability, so nothing may be withheld.',
      })
      continue
    }
    if (successor.outcome !== 'recorded') {
      rejected.push({
        claim,
        why:
          `it names '${claim.coveredBy}' as the suite covering the capability, and that suite ` +
          `${successor.outcome} in this run — ${successor.reason ?? 'no reason given'}. A capability ` +
          'covered by a suite that did not run is not covered, and BOTH suites would have gone ' +
          'quiet on one unchecked sentence.',
      })
      continue
    }
    if (successor.interactions === 0) {
      rejected.push({
        claim,
        why:
          `it names '${claim.coveredBy}', which reports 'recorded' with zero interactions. Beacon ` +
          'derives `skip` from zero counts, so that suite is about to become an unknown itself and ' +
          'covers nothing.',
      })
      continue
    }

    withheld.push(claim)
  }

  return { withheld, rejected }
}

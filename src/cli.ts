#!/usr/bin/env -S node --import tsx
/**
 * The command line.
 *
 *   conformance record  --base local --out corpus/
 *   conformance compare --corpus corpus/ --base local
 *   conformance report  --corpus corpus/
 *
 * **`compare` exits non-zero on any breaking difference, and only on a breaking difference.** That
 * single line is what turns this from a report into a gate: a benign difference is printed and
 * passes, because the contract rule is additive-only and a provider that adds a field must be able
 * to ship. Exiting non-zero on benign differences would make the gate fire on every routine
 * release, and a gate that fires on every release is a gate that gets removed.
 *
 * A failed recording also exits non-zero. A scenario that threw did not observe anything, and a
 * corpus with a hole in it that reports success is worse than no corpus.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'
import {
  BASELINE_BLIND_ROUTES,
  MIN_ROUTES,
  MIN_SERVERS,
  formatBodyScan,
  reconcileBodyScan,
  scanEstate,
} from './bodyscan.ts'
import { compareCorpora } from './compare.ts'
import type { ComparisonReport, Difference } from './compare.ts'
import { loadCorpus } from './corpus.ts'
import { baseNames, loadSecrets } from './env.ts'
import { formatReconciliation, reconcileAccountClaims, sweepEstate } from './ledgeraccounts.ts'
import { BASELINE_UNRESOLVED, MIN_SERVICES } from './ledgeraccounts.ts'
import { record } from './record.ts'
import { ALL_SCENARIOS } from './scenarios/index.ts'

interface Flags {
  readonly base: string
  readonly out: string
  readonly corpus: string
  readonly only: readonly string[]
  readonly json: string | undefined
  readonly verbose: boolean
  /** For `ledger-accounts`: the directory holding the sibling checkouts. */
  readonly estate: string
  /**
   * How many account literals the sweep is allowed to be unable to resolve before it fails.
   *
   * Not a nuisance knob. A sweep whose blind spot can grow without anything turning red stops
   * measuring the estate and starts measuring itself, which is the failure mode this repository
   * has already shipped once. The default is today's count, so the FIRST new unresolvable spelling
   * fails and has to be looked at.
   */
  readonly maxUnresolved: number
  /**
   * For `body-scan`: how many routes in a key-holding service the analyser may fail to fully read.
   *
   * The same argument as `maxUnresolved`, and it bites harder here. Every route this cannot fully
   * read turns "no route returns key material" into "no route I could read returns key material"
   * without a single line of the check changing. The default is today's count.
   */
  readonly maxBlindRoutes: number
}

function parseFlags(argv: readonly string[]): Flags {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    if (i === -1) return undefined
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} needs a value`)
    }
    return value
  }
  return {
    base: get('base') ?? 'local',
    out: get('out') ?? 'corpus/',
    corpus: get('corpus') ?? 'corpus/',
    only: (get('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    json: get('json'),
    verbose: argv.includes('--verbose'),
    estate: get('estate') ?? '..',
    maxUnresolved: Number(get('max-unresolved') ?? String(BASELINE_UNRESOLVED)),
    maxBlindRoutes: Number(get('max-blind-routes') ?? String(BASELINE_BLIND_ROUTES)),
  }
}

const USAGE = `
conformance — the CloudsForge characterisation harness

  record   --base <env> [--out corpus/] [--only a,b]
           Drive every scenario against a running estate and write a redacted,
           normalised golden file per interaction.

  compare  --corpus corpus/ --base <env> [--only a,b] [--json report.json]
           Replay the scenarios against the target and classify every difference
           as identical, benign or breaking. Exits 1 on any breaking difference.

  report   [--corpus corpus/]
           Summarise a recorded corpus: what it covers, what skipped, and why.

  ledger-accounts [--estate ..] [--max-unresolved N] [--verbose]
           Read every sibling repository's TypeScript and reconcile the ledger
           account TYPE each service claims per account key. Exits 1 when two
           services claim one key two ways, when a claim contradicts the chart,
           or when more literals are unresolvable than the budget allows.
           Needs the sibling checkouts on disk; it dials nothing.

  body-scan [--estate ..] [--max-blind-routes N] [--verbose]
           Enumerate every route in every service and follow every value that
           reaches a response body. Exits 1 when a route can return private key
           material, when an acknowledged exception no longer exists, when a
           route table cannot be read, or when more body reaches are unresolvable
           than the budget allows. Source only; it dials nothing and boots nothing.

  body-scan-canary [--estate ..]
           Inject a route that returns a private key into the checked-out estate,
           assert body-scan goes red AND names the injected file, route and field,
           remove it, and assert the estate is green again. Exit-code grading alone
           would accept a red produced by a broken checkout.

Base environments: ${baseNames().join(', ')}
Scenarios:         ${ALL_SCENARIOS.map((s) => s.name).join(', ')}

Any single service can be repointed without editing the base:
  CONFORMANCE_URL_PAY=http://gateway.internal/pay conformance compare --base micro
`.trim()

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE)
    return command ? 0 : 1
  }

  const flags = parseFlags(rest)
  const secrets = loadSecrets()

  switch (command) {
    case 'record':
      return await doRecord(flags, secrets)
    case 'compare':
      return await doCompare(flags, secrets)
    case 'report':
      return doReport(flags)
    case 'ledger-accounts':
      return doLedgerAccounts(flags)
    case 'body-scan':
      return doBodyScan(flags)
    case 'body-scan-canary':
      return doBodyScanCanary(flags)
    default:
      console.error(`unknown command '${command}'\n\n${USAGE}`)
      return 1
  }
}

type Secrets = ReturnType<typeof loadSecrets>

async function doRecord(flags: Flags, secrets: Secrets): Promise<number> {
  console.log(`recording against '${flags.base}' into ${flags.out}`)
  // The path, never the contents, and never a count that would narrow a guess at a value.
  console.log(`secret-hygiene refusal: ${secrets.literals.length ? 'patterns + estate literals' : 'patterns only'} (${secrets.source})`)

  const { manifest } = await record({
    base: flags.base,
    secrets,
    out: flags.out,
    ...(flags.only.length ? { only: flags.only } : {}),
    log: (line) => console.log(line),
  })

  console.log(
    `\n${manifest.totals.interactions} interactions · ${manifest.totals.recorded} recorded · ` +
      `${manifest.totals.skipped} skipped · ${manifest.totals.failed} failed`,
  )
  for (const s of manifest.scenarios) {
    if (s.outcome === 'recorded') continue
    console.log(`  ${s.outcome}: ${s.name} — ${s.reason ?? 'no reason given'}`)
  }
  // A skip is never a failure and never green either; it is reported and it is not fatal. A
  // failure is: the scenario threw, which means it observed nothing and nobody knows why.
  return manifest.totals.failed > 0 ? 1 : 0
}

async function doCompare(flags: Flags, secrets: Secrets): Promise<number> {
  const baseline = loadCorpus(flags.corpus)
  console.log(
    `comparing '${flags.base}' against ${relative(process.cwd(), flags.corpus) || flags.corpus} ` +
      `(recorded ${baseline.manifest.recordedAt} against '${baseline.manifest.base}')`,
  )

  const replay = await record({
    base: flags.base,
    secrets,
    ...(flags.only.length ? { only: flags.only } : {}),
    log: (line) => (flags.verbose ? console.log(line) : undefined),
  })

  const report = compareCorpora(baseline.interactions, replay.interactions, baseline.manifest, replay.manifest)
  printComparison(report, flags.verbose)

  if (flags.json) {
    writeFileSync(flags.json, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\nwritten to ${flags.json}`)
  }

  return report.breaking ? 1 : 0
}

function printComparison(report: ComparisonReport, verbose: boolean): void {
  const breaking = report.differences.filter((d) => d.classification === 'breaking')
  const benign = report.differences.filter((d) => d.classification === 'benign')

  console.log(
    `\n${report.interactionsCompared} interactions compared · ` +
      `${report.counts.identical} identical · ${benign.length} benign · ${breaking.length} breaking`,
  )

  if (breaking.length) {
    console.log('\nBREAKING')
    for (const d of breaking) console.log(`  ${describe(d)}`)
  }

  if (benign.length) {
    const kinds = new Map<string, number>()
    for (const d of benign) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1)
    console.log(`\nbenign: ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(', ')}`)
    if (verbose) for (const d of benign) console.log(`  ${describe(d)}`)
  }

  console.log(breaking.length ? '\nverdict: BREAKING — the extraction is blocked' : '\nverdict: no breaking difference')
}

function describe(d: Difference): string {
  const where = d.scenario ? `${d.scenario}${d.step ? ` › ${d.step}` : ''} ` : ''
  return `${where}${d.path}: ${d.detail} [${d.kind}]`
}

function doReport(flags: Flags): number {
  const { manifest, interactions } = loadCorpus(flags.corpus)
  console.log(`corpus recorded ${manifest.recordedAt} against '${manifest.base}' (format ${manifest.formatVersion})`)
  console.log(
    `${manifest.totals.interactions} interactions · ${manifest.totals.recorded} scenarios recorded · ` +
      `${manifest.totals.skipped} skipped · ${manifest.totals.failed} failed\n`,
  )

  for (const s of manifest.scenarios) {
    console.log(`  ${s.outcome.padEnd(8)} ${s.name.padEnd(14)} ${String(s.interactions).padStart(3)} interactions  ${s.title}`)
    if (s.reason) console.log(`           ↳ ${s.reason}`)
    for (const err of s.cleanupErrors) console.log(`           ↳ cleanup failed: ${err}`)
  }

  const byTarget = new Map<string, number>()
  const byStatus = new Map<number, number>()
  for (const i of interactions) {
    byTarget.set(i.target, (byTarget.get(i.target) ?? 0) + 1)
    byStatus.set(i.response.status, (byStatus.get(i.response.status) ?? 0) + 1)
  }
  console.log(`\nby target: ${[...byTarget].map(([t, n]) => `${t} ×${n}`).join(', ')}`)
  console.log(`by status: ${[...byStatus].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s} ×${n}`).join(', ')}`)
  console.log(`\nnormalisation in force: ${manifest.normalisationRules.join(', ')}`)

  return manifest.totals.failed > 0 ? 1 : 0
}

/**
 * The estate-wide ledger account-type sweep.
 *
 * It reads source and dials nothing, so it is safe anywhere the checkouts are — but it needs the
 * sibling repositories, and this repository's CI checks out only itself. That is stated in the
 * output rather than papered over: a run that swept three repositories and printed "no
 * disagreements" would be true and worthless, so the count of repositories read is printed FIRST
 * and `--verbose` names them.
 */
function doLedgerAccounts(flags: Flags): number {
  const sweep = sweepEstate({ estateDir: flags.estate })
  const result = reconcileAccountClaims(sweep.claims, { maxUnresolved: flags.maxUnresolved })
  console.log(formatReconciliation(result, sweep))
  console.log('')
  if (sweep.services.length < MIN_SERVICES) {
    console.error(
      `only ${sweep.services.length} repositories under ${flags.estate} — expected at least ` +
        `${MIN_SERVICES}. A sweep of a partial checkout cannot certify the estate.`,
    )
    return 1
  }
  if (result.unresolved.length > flags.maxUnresolved) {
    console.error(
      `${result.unresolved.length} unresolvable account literals, budget ${flags.maxUnresolved}. ` +
        'Each one is an account whose key this cannot read; raise the budget only with a reason.',
    )
  }
  console.log(result.ok ? 'OK — the estate agrees on every account type it states' : 'FAILED')
  return result.ok ? 0 : 1
}

/**
 * The estate-wide response-body scan.
 *
 * Fails on a partial checkout BEFORE it prints a verdict, for the reason `doLedgerAccounts` does:
 * "no route returns key material" over four repositories is a true sentence and a worthless one,
 * and the number that makes it worth anything — routes read — is printed first.
 */
function doBodyScan(flags: Flags): number {
  const scan = scanEstate({ estateDir: flags.estate })
  const report = reconcileBodyScan(scan, { maxBlindRoutes: flags.maxBlindRoutes })
  console.log(formatBodyScan(report, scan))
  console.log('')

  let refused = false
  if (scan.services.length < MIN_SERVERS || scan.routes.length < MIN_ROUTES) {
    console.error(
      `only ${scan.services.length} servers and ${scan.routes.length} routes under ${flags.estate} — ` +
        `expected at least ${MIN_SERVERS} and ${MIN_ROUTES}. A scan of a partial checkout cannot ` +
        'certify the estate; it can only fail to find anything in it.',
    )
    refused = true
  }
  if (scan.unreadable.length > 0) {
    console.error(
      `${scan.unreadable.length} route tables could not be read. Every route in them is a route this ` +
        'scan silently did not judge — fix the extractor, never the budget.',
    )
  }
  if (report.blindRoutes.length > flags.maxBlindRoutes) {
    console.error(
      `${report.blindRoutes.length} routes in a key-holding service could not be fully read, budget ` +
        `${flags.maxBlindRoutes}. Each one is a response this scan cannot account for, in a service ` +
        'that has a private key to lose. Open the value, or raise the budget with a reason.',
    )
  }
  console.log(report.ok && !refused ? 'OK — no route in the estate can return key material this scan can identify' : 'FAILED')
  return report.ok && !refused ? 0 : 1
}

/* ------------------------------------------------------------------ the canary */

/**
 * THE PROOF THAT `body-scan` CAN STILL GO RED — planted, graded and removed here rather than in a
 * workflow.
 *
 * `estate-ci.yml` already carries a canary per invariant, and every one of them is thirty lines of
 * bash inside the workflow. That is the wrong home for this one and the reason is not tidiness: the
 * canary asserts a property of the CHECKER, so it has to change when the checker changes, and a
 * copy living in another repository owned by another agent will not. Here, `pnpm test` runs the
 * analyser's own suite and this command re-proves it against the real estate, and both move
 * together. micro-org's step becomes one line.
 *
 * IT GRADES THE OUTPUT, NOT THE EXIT CODE. A broken checkout, an unresolvable import and a missing
 * subcommand all exit non-zero, so exit-code grading accepts every way this check can quietly stop
 * measuring the estate. This asserts the sweep named the injected FILE, the injected ROUTE and the
 * injected FIELD — and then asserts the estate is GREEN again once the injection is removed, because
 * a red that survives the cleanup was never the canary's red.
 *
 * The injection goes into micro-wallet on purpose: it holds no key material, has no vault, and has
 * never had a body scan of its own, so it is the service where a leaking route would be least
 * likely to be noticed by anything else.
 */
function doBodyScanCanary(flags: Flags): number {
  const target = resolvePath(flags.estate, 'wallet', 'src')
  if (!existsSync(target)) {
    console.error(`no micro-wallet checkout at ${target}, so the canary cannot be planted`)
    console.error('A canary that cannot be planted must FAIL, never be skipped.')
    return 1
  }
  const canary = join(target, '__bodyscan_canary.ts')
  const grade = (ok: boolean, why: string): void => {
    if (!ok) throw new Error(why)
  }

  try {
    writeFileSync(canary, CANARY_SOURCE)
    grade(existsSync(canary), 'the canary file was not written — a canary that grades an unchanged tree grades nothing')

    const scan = scanEstate({ estateDir: flags.estate })
    const report = reconcileBodyScan(scan, { maxBlindRoutes: flags.maxBlindRoutes })
    const text = formatBodyScan(report, scan)

    grade(!report.ok, 'the sweep stayed GREEN with a route returning a private key injected — it is measuring nothing')
    grade(text.includes('__bodyscan_canary.ts'), 'the sweep went red but never named the injected FILE — a red for another reason')
    grade(text.includes('/v1/wallets/:id/export'), 'the sweep named the file but not the injected ROUTE')
    grade(/privateKey/.test(text), 'the sweep named the route but not WHAT it found in it')

    console.log('ok: the sweep went red and named the injected file, route and field')
    for (const finding of report.violations) {
      console.log(`    ${finding.severity}/${finding.pass}  ${finding.method} ${finding.path}  ${finding.service}/${finding.file}:${finding.line}`)
    }
  } catch (err) {
    rmSync(canary, { force: true })
    console.error(`CANARY FAILED: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  rmSync(canary, { force: true })
  if (existsSync(canary)) {
    console.error('CANARY FAILED: the canary survived, so the real sweep would judge a tree this command broke')
    return 1
  }

  // And green again. Without this the red above proves only that SOMETHING is wrong.
  const after = scanEstate({ estateDir: flags.estate })
  const afterReport = reconcileBodyScan(after, { maxBlindRoutes: flags.maxBlindRoutes })
  if (!afterReport.ok) {
    console.error('CANARY FAILED: the sweep is still red with the injection removed, so the red above was not the canary')
    console.error(formatBodyScan(afterReport, after))
    return 1
  }
  console.log('ok: green again once the injection was removed — the red belonged to the canary')
  return 0
}

/**
 * A route in micro-wallet returning the plaintext a custody export produces.
 *
 * Written in micro-wallet's own route spelling (`route('GET', …)`), not custody's, so the canary
 * also proves the extractor still reads that spelling — a fourth-spelling regression would
 * otherwise show up as "the sweep did not name the injected file" and be indistinguishable from a
 * broken checkout.
 */
const CANARY_SOURCE = `// Written by \`conformance body-scan-canary\` and deleted a few lines later. If the sweep does not
// see this, the sweep is not seeing the estate either.
interface Route { readonly method: string; readonly path: string; readonly handle: unknown }
declare const deps: { custody: { reveal(id: string): Promise<string> } }
declare function route(method: string, path: string, handle: unknown): Route

export function buildCanaryRoutes(): Route[] {
  return [
    route('GET', '/v1/wallets/:id/export', async (ctx: { params: { id: string } }) => ({
      status: 200,
      body: { address: ctx.params.id, privateKey: await deps.custody.reveal(ctx.params.id) },
    })),
  ]
}
`

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)

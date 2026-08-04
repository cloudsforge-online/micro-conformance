/**
 * Where the estate is, and what the harness is allowed to know about it.
 *
 * A base environment is a named map from a service to a base URL. Naming them, rather than passing
 * URLs on the command line, is what makes `record --base local` and `compare --base micro`
 * comparable: the corpus is keyed on the harness's name for a service, so a `micro-*` replacement
 * on a different port is still "wallet" and still compares against what "wallet" used to do.
 *
 * Custody (4005) and Pay (4003) are bound to loopback deliberately — see MAP.md §2. They are
 * reached on `127.0.0.1` and nothing here ever widens a binding: these are client URLs.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvSecrets } from './redact.ts'

export const TARGETS = [
  'nimbus',
  'game',
  'pay',
  'mint',
  'keyvault',
  'crucible',
  'lantern',
  'beacon',
  'hearth-rest',
  'hearth-rpc',
] as const

export type Target = (typeof TARGETS)[number]

/**
 * A target with no address in this base, and the reason it has none.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS EXISTS BECAUSE A 404 IS NOT A TRANSPORT FAILURE, AND THEREFORE IS NOT A SKIP.**
 *
 * `ctx.call` turns a connection error into a skip — an absent service is honestly reported as
 * "nobody looked". A **404 is a response**, so it is recorded as behaviour. That difference is
 * correct for the estate this harness was written against and is a trap for the micro estate,
 * where four of the ten targets were not re-hosted but **redesigned**: the resources were renamed
 * and versioned, so every path this corpus knows answers 404 at the successor's address.
 *
 * Point `pay` at the wallet service and the `wallet` scenario records six 404s, reports `recorded`,
 * and the next `compare` finds all six identical — a `pass` published to Beacon for a suite that
 * observed nothing about a wallet. `identical + benign > 0` is exactly the test `statusFor`
 * (`beacon/src/conformance.ts:100-108`) uses to call a run a pass rather than a skip, so a stable
 * 404 is indistinguishable from a stable contract to everything downstream.
 *
 * An unmapped target skips the scenario instead, carrying this reason into the manifest and into
 * `POST /v1/conformance` as a zero-count row, which Beacon derives as `skip` and the gate reports
 * as `conformance_inconclusive` — an unknown that refuses and cannot be waived. That is the
 * designed behaviour for "nobody found out", and it is the honest answer here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface UnmappedTarget {
  readonly unmapped: true
  /** Why no address serves this target's recorded surface. Ends up in the manifest verbatim. */
  readonly reason: string
}

export type TargetBase = string | UnmappedTarget

export type BaseUrls = Readonly<Record<Target, TargetBase>>

export function isUnmapped(base: TargetBase): base is UnmappedTarget {
  return typeof base !== 'string'
}

/** `unmapped('…')` reads better than the object literal at eleven call sites. */
const unmapped = (reason: string): UnmappedTarget => ({ unmapped: true, reason })

/**
 * The live micro estate's apex.
 *
 * `cloudsforge.localtest.me` resolves to 127.0.0.1 by public DNS, which is why the estate uses it
 * rather than an `/etc/hosts` entry every developer has to add. Overridable because the same base
 * has to work against a deployed apex.
 */
const MICRO_APEX = process.env['CONFORMANCE_MICRO_APEX'] ?? 'cloudsforge.localtest.me'
const gateway = (subdomain: string, path = ''): string => `https://${subdomain}.${MICRO_APEX}${path}`

/**
 * `local` is the running compose estate as MAP.md §2 describes it.
 *
 * `micro` is the estate that is actually running. See the block above it.
 */
const BASES: Readonly<Record<string, BaseUrls>> = {
  local: {
    nimbus: 'http://127.0.0.1:4001',
    game: 'http://127.0.0.1:4002',
    pay: 'http://127.0.0.1:4003',
    mint: 'http://127.0.0.1:4004',
    keyvault: 'http://127.0.0.1:4005',
    crucible: 'http://127.0.0.1:4006',
    lantern: 'http://127.0.0.1:4010',
    beacon: 'http://127.0.0.1:4011',
    'hearth-rest': 'http://127.0.0.1:8645',
    'hearth-rpc': 'http://127.0.0.1:8545',
  },

  /* ══════════════════════════════════════════════════════════════════════════════════════════════
   * `micro` — THE ESTATE THE RELEASE GATE ACTUALLY GATES.
   *
   * Until 2026-08-04 this was a byte-for-byte copy of `local`, pointing at ten legacy `stack`
   * containers of which eight refuse connections. README §2a records why nothing was published
   * from it. This is that base written for real.
   *
   * ── HOW THE ADDRESSES WERE CHOSEN ────────────────────────────────────────────────────────────
   *
   * Through the gateway, on the estate's own CA, never `curl -k`. The hostnames come from the
   * surface registry (`ui/packages/ui/src/surfaces.ts`) — which is the single source of truth and
   * contains the one host whose name does not match its key: `keyvault` has the subdomain
   * **`vault`** (surfaces.ts:812-816) — reconciled against the routers that actually serve them in
   * `deploy/gateway/dynamic/estate-web.yml`.
   *
   * ── EVERY ROW BELOW WAS MEASURED, NOT REASONED ABOUT ─────────────────────────────────────────
   *
   * On 2026-08-04, with
   * `curl --cacert deploy/gateway/certs/ca.crt https://<sub>.cloudsforge.localtest.me<path>`,
   * against the 48-container estate. The status codes quoted per row are from that sweep. The rule
   * applied is stated once here and then applied without exception:
   *
   *   **A target is mapped only when the service at that address serves the surface this corpus
   *   records for it. Where it does not, the target is unmapped and the scenario skips.**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  micro: {
    // ── MAPPED ───────────────────────────────────────────────────────────────────────────────
    //
    // `micro-identity` kept Nimbus's unversioned auth surface wholesale. `cf-web-nimbus` routes
    // the WHOLE host to it (estate-web.yml:663-667) because "identity serves 34 unversioned routes
    // at the root", so the paths this corpus knows resolve unchanged:
    //
    //   /.well-known/jwks.json  200   /auth/me  401 (refusing anonymously, as recorded)
    //   /auth/register /auth/login /auth/refresh /auth/logout /auth/password  all present
    //   (identity/src/server.ts:748-1023)
    //
    // TWO PATHS IN THIS CORPUS DO NOT EXIST HERE, and both are recorded rather than papered over:
    //   * `/health` → 404. identity serves `/livez` and `/readyz` (identity/src/server.ts:719-721).
    //     That is P2 landing, and the `health` scenario's own header says recording the shape the
    //     estate has today is what makes that replacement provable. The 404 IS the observation.
    //   * `/portal/handoff` and `/auth/exchange` → 404. They are `/auth/handoff` and
    //     `/auth/handoff/redeem` now (identity/src/server.ts:1144,1161). The `identity` scenario
    //     already tolerates a refused handoff — it tries each candidate return URL and notes the
    //     failure (scenarios/identity.ts:209-211) — so the SSO half is reported as unrecorded
    //     rather than silently dropped. Renaming the path in the scenario is NOT done here: the
    //     same code records the `local` corpus, so it would rewrite what the legacy baseline
    //     characterises in order to make this one greener.
    nimbus: gateway('nimbus'),

    // ── MAPPED, AND ONLY EVER ASKED `/health` ────────────────────────────────────────────────
    //
    // These three appear in exactly one scenario — `health` — and it asks each of them for
    // `/health` and nothing else. All three answer 404 and serve `/livez` + `/readyz` instead
    // (custody/src/server.ts, lantern/src/server.ts, beacon/src/server.ts). They stay MAPPED, and
    // the distinction from the four unmapped rows below is the one this file turns on:
    //
    //   `health` observes something real at this base — jwks answers 200, the chain node answers
    //   200, and eight `/health` routes are demonstrably gone. A suite with real observations plus
    //   documented absences has characterised the estate. `wallet`, `mint`, `trade` and `game`
    //   observe NOTHING but absence, and a suite that observed nothing must not report a verdict.
    keyvault: gateway('vault'),
    lantern: gateway('lantern'),
    beacon: gateway('beacon'),

    // ── MAPPED, AND UNCHANGED BY THE MIGRATION ───────────────────────────────────────────────
    //
    // The same hearth-testnet node the 2026-07-29 corpus was recorded against is still running and
    // still bound to these ports (`hearth-testnet-seed`, verified in `docker ps`). It is not behind
    // the gateway and must not be: 8545 is the JSON-RPC listener the deposit watcher speaks to,
    // and it is plain HTTP by design. This is the ONE scenario whose micro recording is directly
    // comparable with the legacy one, because it is the same process.
    'hearth-rest': 'http://127.0.0.1:8645',
    'hearth-rpc': 'http://127.0.0.1:8545',

    // ── UNMAPPED — the four product APIs that were redesigned rather than re-hosted ───────────
    //
    // Each reason names the successor, the address, and the measurement. They are reasons an
    // operator reads in Beacon, so they say what is true rather than "not available".
    pay: unmapped(
      'no address serves the recorded payments surface: `micro-wallet` answers pay.<apex> ' +
        '(estate-web.yml:731-735) and 404s /wallet, /coins/rates, /deposit-coins, ' +
        '/withdrawal-coins, /deposits and /withdrawals — it serves /v1/wallets, /v1/deposits and ' +
        '/v1/withdrawals instead (wallet/src/server.ts:445-702). Of the eleven paths this corpus ' +
        'asks of `pay`, exactly one survives: /entitlements, which billing answers 401 through ' +
        'the narrow router at estate-web.yml:736-740',
    ),
    game: unmapped(
      'no address serves the recorded game surface: `micro-worlds` answers worlds-api.<apex> and ' +
        '404s both /worlds and /cosmetics — it serves /v1/titles and /v1/players/me instead ' +
        '(worlds/src/server.ts:507-638). Ninety Days After is a TITLE under Worlds now, not the ' +
        'product the corpus recorded',
    ),
    mint: unmapped(
      'no address serves the recorded mint surface: `micro-mint` serves /v1/catalogue and ' +
        '/v1/tokens (mint/src/server.ts:354-441) and has no /chains, /offers or /capabilities. ' +
        'AND THE ROOT OF create.<apex> IS THE WEB BUNDLE, NOT THE API — GET /tokens there answers ' +
        '200 text/html, the SPA shell. Pointing this target at that host would record an HTML ' +
        'page as ForgeMint’s order list and compare it identical forever',
    ),
    crucible: unmapped(
      'no address serves the recorded trading surface: `micro-trade` serves /v1/strategies, ' +
        '/v1/bots and /v1/backtests (trade/src/server.ts:341-539) and has no /catalog at all — ' +
        'the single largest static contract in the legacy estate, and the whole of the `trade` ' +
        'scenario. The root of trade.<apex> is the web bundle: GET /bots and GET /backtests there ' +
        'answer 200 text/html, so this target cannot be pointed at the host either',
    ),
  },
}

export function baseNames(): string[] {
  return Object.keys(BASES)
}

/**
 * Resolve a base environment, letting any single target be overridden from the environment.
 *
 * `CONFORMANCE_URL_PAY=http://gateway.internal/pay` repoints one service without editing this
 * file, which is how a partially migrated estate is compared: nine services where they were, one
 * behind the gateway.
 */
export function resolveBase(name: string): BaseUrls {
  const preset = BASES[name]
  if (!preset) {
    throw new Error(`unknown base environment '${name}'. Known: ${baseNames().join(', ')}`)
  }
  const out: Record<string, TargetBase> = { ...preset }
  for (const target of TARGETS) {
    const override = process.env[`CONFORMANCE_URL_${target.toUpperCase().replace(/-/g, '_')}`]
    // An override outranks an unmapped row too. That is the point of the escape hatch: the day
    // something serves the recorded surface again, it is one environment variable and not an edit.
    if (override) out[target] = override.replace(/\/$/, '')
  }
  return out as BaseUrls
}

/**
 * Refuse to run against an `https:` base that this process cannot verify.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A MISSING CA LOOKS EXACTLY LIKE A DEAD ESTATE, AND THAT IS WHY THIS REFUSES RATHER THAN WARNS.**
 *
 * The micro estate serves its own CA. Without it trusted, every `fetch` fails the handshake;
 * `ctx.call` classifies a transport failure as a skip, by design; every scenario skips; and
 * `compare --beacon` publishes eight honest-looking `skip` rows. The gate would then report
 * `conformance_inconclusive` across the board — a true statement about the harness's own
 * configuration, presented as a statement about the estate, and indistinguishable from one.
 *
 * The estate's answer to this is `NODE_EXTRA_CA_CERTS`, which is what Beacon itself is given
 * (`NODE_EXTRA_CA_CERTS=/etc/ssl/estate/ca.crt`). Node reads it once at startup, so it cannot be
 * set from inside this process — hence a refusal naming the file rather than a fix-up.
 *
 * **`NODE_TLS_REJECT_UNAUTHORIZED=0` IS NOT AN ACCEPTED ANSWER AND IS REFUSED BY NAME.** 183 uses
 * of `curl -k` in this estate previously hid a gateway serving `CN=TRAEFIK DEFAULT CERT` that
 * every browser refused while every check passed. A harness that skips verification cannot tell a
 * correct certificate from that one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function assertTlsTrust(base: BaseUrls, baseName: string): void {
  const https = TARGETS.filter((t) => {
    const url = base[t]
    return typeof url === 'string' && url.startsWith('https:')
  })
  if (https.length === 0) return

  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    throw new Error(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is set. This harness refuses to record or compare with ' +
        'certificate verification disabled — trust the estate CA with NODE_EXTRA_CA_CERTS instead.',
    )
  }

  if (!process.env['NODE_EXTRA_CA_CERTS']) {
    throw new Error(
      `base '${baseName}' reaches ${https.length} target(s) over https and NODE_EXTRA_CA_CERTS is ` +
        'unset, so the estate CA is not trusted and every scenario would skip on a handshake ' +
        'failure that reads like a dead estate.\n' +
        '  NODE_EXTRA_CA_CERTS=<estate>/deploy/gateway/certs/ca.crt node --import tsx src/cli.ts …',
    )
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Find the `stack` checkout by walking up until a directory holds both `docker-compose.yml` and
 * `.env.example`.
 *
 * Counting directory levels would be shorter and is wrong here. `micro/` is a symlink on this
 * machine, so `import.meta.url` resolves through it and a fixed `../../..` lands somewhere else
 * entirely — which would make the secret-hygiene refusal silently fall back to its pattern half
 * while reporting that it had loaded the estate's literals. A check that degrades quietly is worse
 * than one that is absent.
 */
function findStackRoot(from: string): string | null {
  const isRoot = (dir: string): boolean =>
    existsSync(join(dir, 'docker-compose.yml')) && existsSync(join(dir, '.env.example'))

  let dir = from
  for (let i = 0; i < 8; i++) {
    if (isRoot(dir)) return dir
    // `micro/` is a symlink to a sibling checkout on this machine, so walking up from the resolved
    // path leaves the stack tree entirely and no ancestor is ever the root. Checking for a `stack`
    // child at each level rejoins it.
    if (isRoot(join(dir, 'stack'))) return join(dir, 'stack')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export const STACK_ROOT = process.env['CONFORMANCE_STACK_ROOT'] ?? findStackRoot(HERE) ?? resolve(HERE, '..', '..', '..')

export interface HarnessSecrets {
  /** Literal secret values the recorder refuses to write. Never logged, never returned by name. */
  readonly literals: readonly string[]
  /** Where they came from, for the run summary. The path, never the contents. */
  readonly source: string
  /** Pay's internal service token, if the estate's .env carries one. */
  readonly payServiceToken: string | undefined
}

/**
 * Load the running estate's own secrets, purely so the recorder can refuse to write one.
 *
 * This is the only place the harness touches `.env`, and the values leave it in exactly two
 * shapes: an opaque list used by `findSecretLeak`, and the one token a scenario legitimately
 * presents as a credential. Neither is ever printed.
 *
 * An absent file is a supported mode. The refusal degrades to its pattern half and the run says
 * so, because a CI runner that has the services but not the operator's file must still be able to
 * record.
 */
export function loadSecrets(envPath = resolve(STACK_ROOT, '.env')): HarnessSecrets {
  let contents: string
  try {
    contents = readFileSync(envPath, 'utf8')
  } catch {
    return { literals: [], source: `${envPath} (absent — pattern-only hygiene)`, payServiceToken: undefined }
  }
  const literals = parseEnvSecrets(contents)
  const payLine = contents.split(/\r?\n/).find((l) => l.trim().startsWith('PAY_SERVICE_TOKEN='))
  const payServiceToken = payLine ? payLine.slice(payLine.indexOf('=') + 1).trim() || undefined : undefined
  return { literals, source: envPath, payServiceToken }
}

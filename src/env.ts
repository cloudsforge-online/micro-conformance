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
  // ── The successors ─────────────────────────────────────────────────────────────────────────
  //
  // Five capabilities the legacy targets above no longer reach, given their own names rather than
  // being folded into the old ones. `micro-mint` is NOT `mint`, and the difference is the whole
  // reason both exist: `mint` records `/chains`, `/offers` and `/capabilities`, which the
  // successor does not serve, and `micro-mint` records `/v1/catalogue` and `/v1/tokens`, which
  // the legacy service never had. Reusing one key would make the corpus claim the two recordings
  // were of the same surface and compare them against each other.
  //
  // The names are the estate's own: these are the `micro-*` services `docker ps` lists and
  // `deploy/gateway/dynamic/estate-web.yml` routes to.
  'micro-wallet',
  'micro-billing',
  'micro-mint',
  'micro-trade',
  'micro-worlds',
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
 * An unmapped target skips the scenario instead, carrying this reason into the manifest. That is
 * the designed behaviour for "nothing was dialled", and it is the honest answer here.
 *
 * ── WHAT HAPPENS TO THAT SKIP AFTERWARDS IS A SEPARATE DECISION, AND IT IS NOT MADE HERE ──────
 *
 * Until 2026-08-04 the skip was published to `POST /v1/conformance` as a zero-count row, Beacon
 * derived `skip`, and the gate reported `conformance_inconclusive` — an unknown that refuses and
 * cannot be waived. For a service that is merely down that is exactly right and still what
 * happens. For the four rows below it was wrong: those servers are gone permanently, so the
 * unknown could never resolve, and a gate that can never go green is a gate people learn to
 * override.
 *
 * `applicability.ts` draws that line, and only it may: a suite is withheld from the publish only
 * on a claim that names the successor covering the same capability, and only when that successor
 * is proved to have run and compared in the same run. Unmapping a target does NOT retire a suite —
 * the two mechanisms are deliberately separate, so that adding an `unmapped(...)` row can never by
 * itself remove a suite from the gate's sight.
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

    // The successor services do not exist in the legacy estate at all, so every successor suite
    // skips against `local` for exactly the reason every legacy suite skips against `micro`. That
    // symmetry is what lets one set of scenario files record both estates without either
    // recording being bent to suit the other.
    'micro-wallet': unmapped(
      'micro-wallet does not exist in the legacy estate. The capability it serves lives here in ' +
        'forge-pay, and the `wallet` suite above is the recording of it',
    ),
    'micro-billing': unmapped(
      'micro-billing does not exist in the legacy estate. Its catalogue and entitlements live ' +
        'here in forge-pay, and the `entitlements` suite above is the recording of them',
    ),
    'micro-mint': unmapped(
      'micro-mint does not exist in the legacy estate. The token-creation capability lives here ' +
        'in ForgeMint, and the `mint` suite above is the recording of it',
    ),
    'micro-trade': unmapped(
      'micro-trade does not exist in the legacy estate. The trading capability lives here in ' +
        'Crucible, and the `trade` suite above is the recording of it',
    ),
    'micro-worlds': unmapped(
      'micro-worlds does not exist in the legacy estate. The game capability lives here in ' +
        'Ninety Days After, and the `game` suite above is the recording of it',
    ),
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
   * **`vault`** (surfaces.ts:814-818) — reconciled against the routers that actually serve them in
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
    // the WHOLE host to it (estate-web.yml:754-758) because "identity serves 34 unversioned routes
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

    /* ══════════════════════════════════════════════════════════════════════════════════════════
     * THE SUCCESSORS — the five capabilities the legacy suites can no longer reach, at the
     * addresses that DO serve them.
     *
     * This is the other half of the unmapped block below, and the two must be read together. The
     * legacy suites stay unmapped because pointing them here would record 404s as behaviour and
     * manufacture a pass. That argument is about the SUITES, not about the capabilities: a wallet
     * exists on this estate, it is healthy, and refusing to characterise it because the old paths
     * are gone would be the mirror error — an estate with no evidence for five of its products.
     *
     * Every row is a host root, not a `/v1` prefix, so the versioned path appears in the corpus
     * file name. `corpus-micro/micro-mint/000-GET-v1-catalogue.json` is legible in a diff in a way
     * that `000-GET-catalogue.json` under a base that silently prefixed `/v1` would not be.
     *
     * Measured 2026-08-04 with `curl --cacert deploy/gateway/certs/ca.crt`, against the estate at
     * 61 healthy containers. Every address below answered 200 or 401 with `application/json` — no
     * 404, and no `text/html`, which is the trap two of the legacy targets fall into.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */

    // `pay.<apex>` is routed WHOLE to micro-wallet at priority 500 (`cf-web-pay`,
    // estate-web.yml:822-826), with four billing prefixes carved out above it at 600 — so the
    // same host serves two services and they are two targets here. GET /v1/wallets, /v1/deposits,
    // /v1/deposits/credits, /v1/withdrawals and /v1/portfolio all answer 401 anonymously and 200
    // to an identity token (wallet/src/server.ts:477-827).
    'micro-wallet': gateway('pay'),

    // The carve-out: `/entitlements`, `/products`, `/purchases`, `/subscriptions` at priority 600
    // (`cf-api-pay-billing`, estate-web.yml:827-831) reach micro-billing on the same hostname
    // (billing/src/server.ts:375-580). Only the two READ routes and the catalogue are recorded —
    // `/purchases` spends.
    'micro-billing': gateway('pay'),

    // `create.<apex>` serves the web bundle at its root and micro-mint under `/v1` only
    // (`cf-api-create`, estate-web.yml:238-242). That is precisely why the legacy `mint` target is
    // unmapped rather than pointed at this host: `GET /tokens` at the root is the SPA shell.
    'micro-mint': gateway('create'),

    // The same shape: `trade.<apex>` is the bundle, `/v1` is micro-trade (`cf-api-trade-host`,
    // estate-web.yml:251-255).
    'micro-trade': gateway('trade'),

    // The same shape again: `worlds.<apex>` is the bundle and `/v1` is micro-worlds
    // (`cf-api-worlds-host`, estate-web.yml:325-329). Every request in the `micro-worlds` suite is
    // under `/v1` — /v1/titles, /v1/players/me, /v1/players/me/inventory, /v1/provisions — so the
    // guarded router catches all five and none of them can reach the SPA shell at the root.
    //
    // THIS USED TO BE `gateway('worlds-api')`, and that address is gone. `worlds-api.<apex>` was
    // an API hostname routed whole by `cf-api-worlds-api`, which is deleted: the game API was
    // folded INTO `api.`, `worlds-api.` never had a DNS record on the public estate, and a router
    // that outlived its hostname is what made the dead name keep reading as reachable.
    'micro-worlds': gateway('worlds'),

    // ── UNMAPPED — the four product APIs that were redesigned rather than re-hosted ───────────
    //
    // Each reason names the successor, the address, and the measurement. They are reasons an
    // operator reads in Beacon, so they say what is true rather than "not available".
    pay: unmapped(
      'no address serves the recorded payments surface: `micro-wallet` answers pay.<apex> ' +
        '(estate-web.yml:822-826) and 404s /wallet, /coins/rates, /deposit-coins, ' +
        '/withdrawal-coins, /deposits and /withdrawals — it serves /v1/wallets, /v1/deposits and ' +
        '/v1/withdrawals instead (wallet/src/server.ts:477-827). Of the eleven paths this corpus ' +
        'asks of `pay`, exactly one survives: /entitlements, which billing answers through the ' +
        'narrow router at estate-web.yml:827-831. THE CAPABILITY IS RECORDED — by the ' +
        '`micro-wallet` and `micro-entitlements` suites, against those addresses',
    ),
    game: unmapped(
      'no address serves the recorded game surface: `micro-worlds` answers worlds.<apex>/v1 and ' +
        '404s both /worlds and /cosmetics — it serves /v1/titles and /v1/players/me instead ' +
        '(worlds/src/server.ts:507-682). Ninety Days After is a TITLE under Worlds now, not the ' +
        'product the corpus recorded. THE CAPABILITY IS RECORDED — by the `micro-worlds` suite, ' +
        'against the player surface that replaced it',
    ),
    mint: unmapped(
      'no address serves the recorded mint surface: `micro-mint` serves /v1/catalogue and ' +
        '/v1/tokens (mint/src/server.ts:354-441) and has no /chains, /offers or /capabilities. ' +
        'AND THE ROOT OF create.<apex> IS THE WEB BUNDLE, NOT THE API — GET /tokens there answers ' +
        '200 text/html, the SPA shell. Pointing this target at that host would record an HTML ' +
        'page as ForgeMint’s order list and compare it identical forever. THE CAPABILITY IS ' +
        'RECORDED — by the `micro-mint` suite, under create.<apex>/v1 where the API actually is',
    ),
    crucible: unmapped(
      'no address serves the recorded trading surface: `micro-trade` serves /v1/strategies, ' +
        '/v1/bots and /v1/backtests (trade/src/server.ts:341-590) and has no /catalog at all — ' +
        'the single largest static contract in the legacy estate, and the whole of the `trade` ' +
        'scenario. The root of trade.<apex> is the web bundle: GET /bots and GET /backtests there ' +
        'answer 200 text/html, so this target cannot be pointed at the host either. THE ' +
        'CAPABILITY IS RECORDED — by the `micro-trade` suite, under trade.<apex>/v1',
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

/**
 * Find the micro estate checkout the same way, by a marker only it has.
 *
 * This repository is a sibling of `deploy/` inside that checkout, so `resolve(HERE, '..', '..')`
 * is right today — and that is exactly the reasoning that produced the defect this pair of roots
 * exists to fix, so it is not what is used. The walk looks for `deploy/compose` beside
 * `deploy/gateway`, which the legacy `stack` checkout does not have (its `deploy/` holds one
 * `cloudflared/` directory and nothing else), so the two roots cannot resolve to each other.
 *
 * A failed walk is not papered over with a level count: it falls through to a path that will not
 * hold the tokens file, and `assertSecretLiterals` then refuses by name. Guessing wrong loudly is
 * the whole point.
 */
function findMicroRoot(from: string): string | null {
  const isRoot = (dir: string): boolean =>
    existsSync(join(dir, 'deploy', 'compose')) && existsSync(join(dir, 'deploy', 'gateway'))

  let dir = from
  for (let i = 0; i < 8; i++) {
    if (isRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export const MICRO_ROOT = process.env['CONFORMANCE_MICRO_ROOT'] ?? findMicroRoot(HERE) ?? resolve(HERE, '..', '..')

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHICH ESTATE'S SECRETS BELONG TO WHICH BASE — declared here, per base, and never defaulted.
 *
 * **THIS TABLE IS THE FIX FOR THE WORST DEFECT THIS REPOSITORY HAS SHIPPED.** Until 2026-08-04
 * `loadSecrets` took a *path*, defaulted from the single `STACK_ROOT` above, and nothing related
 * it to the base being recorded. `findStackRoot` resolves to the LEGACY `stack` checkout, so
 * `record --base micro` armed the hygiene refusal's literal half with the legacy estate's values
 * and therefore with none of the micro estate's — while recording micro traffic into a corpus
 * that is committed to a PUBLIC repository.
 *
 * The literal half is the backstop for everything the pattern half does not recognise: a secret
 * that is not token-shaped, a value with no distinguishing format. Pointed at the wrong estate it
 * is not weaker, it is absent — and absent looks *identical* to present-and-never-tripped. That
 * is this codebase's recurring defect class, "a check that cannot fail", and the only defence
 * against it is to make the arrangement impossible rather than to remember it.
 *
 * So: every base names its own files, `loadSecrets` takes a BASE and not a path, the result
 * carries the base it was loaded for, and `record` refuses when the two disagree.
 *
 * ── WHAT IS DELIBERATELY NOT IN THIS TABLE ───────────────────────────────────────────────────
 *
 * `deploy/compose/testnet.env` holds `CF_PROJECT`, `CF_NET_PREFIX` and port bases — infrastructure
 * naming, not secrets. Loading it would put ordinary substrings into the refusal set and produce
 * false refusals on legitimate response bodies, which is how a hygiene check gets switched off.
 * `deploy/compose/.env` is a symlink to the tokens file already listed, so it would add nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const SECRET_FILES: Readonly<Record<string, readonly string[]>> = {
  // The legacy estate keeps everything in one root `.env`, and always did.
  local: [resolve(STACK_ROOT, '.env')],
  // The micro estate's secrets are generated by `deploy/scripts/estate-bootstrap.sh` into one
  // gitignored file, which `deploy/compose/.env` symlinks and every service is booted from.
  micro: [resolve(MICRO_ROOT, 'deploy', 'compose', 'estate', 'tokens.env')],
}

/** The env var that repoints the files, named in every refusal so it is never a guess. */
const SECRETS_FILE_ENV = 'CONFORMANCE_SECRETS_FILE'

/**
 * The absolute paths whose values the given base's recording must refuse to write.
 *
 * Exported so the refusal can be tested without a secret file on disk — in CI there is none, the
 * micro estate's tokens file being gitignored by construction.
 */
export function secretFilesFor(baseName: string): readonly string[] {
  // The base is validated BEFORE the override is consulted. An override that quietly accepted a
  // base name this file knows nothing about would be the same class of hole again: a run that
  // looks configured while nothing checked what it was configured for.
  const files = SECRET_FILES[baseName]
  if (!files) {
    throw new Error(`unknown base environment '${baseName}'. Known: ${baseNames().join(', ')}`)
  }
  const override = process.env[SECRETS_FILE_ENV]
  if (override) return override.split(',').map((p) => p.trim()).filter(Boolean).map((p) => resolve(p))
  return files
}

export interface HarnessSecrets {
  /** Literal secret values the recorder refuses to write. Never logged, never returned by name. */
  readonly literals: readonly string[]
  /** Where they came from, for the run summary. The path, never the contents. */
  readonly source: string
  /** Pay's internal service token, if the estate's env carries one. */
  readonly payServiceToken: string | undefined
  /**
   * The base these belong to. `record` refuses when it does not match the base being recorded —
   * which is the single assertion that makes the original defect unrepresentable rather than
   * merely fixed.
   */
  readonly base: string
  /** Declared files that could not be read. Anything but empty is a refusal at record time. */
  readonly missing: readonly string[]
}

/**
 * Load the secrets of the estate that `baseName` dials, purely so the recorder can refuse to
 * write one.
 *
 * This is the only place the harness reads an env file, and the values leave it in exactly two
 * shapes: an opaque list used by `findSecretLeak`, and the one token a scenario legitimately
 * presents as a credential. Neither is ever printed, and neither is ever returned beside its name.
 *
 * An unreadable file is NOT quietly tolerated here any more — it is reported in `missing` and
 * `assertSecretLiterals` turns it into a refusal. The previous comment on this function argued
 * that "a CI runner that has the services but not the operator's file must still be able to
 * record"; no CI job in this repository has ever recorded (`.github/workflows/ci.yml` runs the
 * typecheck and the pure suite and says so in its own header), so that allowance bought nothing
 * and cost the whole literal half of the refusal.
 */
export function loadSecrets(baseName: string): HarnessSecrets {
  const files = secretFilesFor(baseName)
  const literals: string[] = []
  const read: string[] = []
  const missing: string[] = []
  let payServiceToken: string | undefined

  for (const file of files) {
    let contents: string
    try {
      contents = readFileSync(file, 'utf8')
    } catch {
      missing.push(file)
      continue
    }
    read.push(file)
    literals.push(...parseEnvSecrets(contents))
    const payLine = contents.split(/\r?\n/).find((l) => l.trim().startsWith('PAY_SERVICE_TOKEN='))
    if (payLine) payServiceToken = payLine.slice(payLine.indexOf('=') + 1).trim() || payServiceToken
  }

  return {
    literals,
    // The paths, never the contents, and never a count that would narrow a guess at a value.
    source: [...read, ...missing.map((f) => `${f} (UNREADABLE)`)].join(', '),
    payServiceToken,
    base: baseName,
    missing,
  }
}

/**
 * Refuse to record or compare when the hygiene refusal's literal half is not actually armed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A REFUSAL THAT CANNOT FIRE LOOKS EXACTLY LIKE A REFUSAL THAT NEVER HAD TO, AND THAT IS WHY
 * THIS REFUSES RATHER THAN WARNS.**
 *
 * Three arrangements produce an unarmed literal half, and all three are silent:
 *
 *   1. The literals belong to a different estate than the one being recorded. This is the defect
 *      that shipped: `--base micro` loading the legacy `stack` checkout's `.env`.
 *   2. The declared file could not be read, so the list is empty.
 *   3. The file was read and held nothing ≥8 characters, so the list is empty anyway.
 *
 * In every one of them the recorder runs to completion, writes a corpus, and reports success. The
 * pattern half still runs — JWTs, PEM blocks, DSNs, raw private keys — so the corpus is not
 * unprotected; it is protected by a list of shapes somebody thought of, which is precisely the
 * thing the literal half exists because it is not enough.
 *
 * This is modelled on `assertTlsTrust` deliberately, down to the shape of the message: refuse by
 * name, say what to set. Node reads `NODE_EXTRA_CA_CERTS` once at startup and cannot be fixed up
 * from inside the process; the secret file could be, and is still not, because a harness that
 * hunts for a plausible secret file is a harness that will one day find the wrong one — which is
 * the entire content of this bug.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function assertSecretLiterals(secrets: HarnessSecrets, baseName: string): void {
  if (secrets.base !== baseName) {
    throw new Error(
      `the secret literals were loaded for base '${secrets.base}' but this run records base ` +
        `'${baseName}'. The hygiene refusal would be armed with a different estate's values, so ` +
        'every secret of the estate actually being recorded would pass it unseen.\n' +
        `  load them with loadSecrets('${baseName}')`,
    )
  }

  if (secrets.missing.length > 0) {
    throw new Error(
      `base '${baseName}' records a live estate, and its secret file could not be read:\n` +
        secrets.missing.map((f) => `    ${f}`).join('\n') +
        '\n' +
        '  Without it the hygiene refusal keeps only its pattern half — a list of value SHAPES — ' +
        'and loses the half that catches a secret with no recognisable shape. The corpus is ' +
        'committed to a public repository, so this refuses rather than recording with a gap ' +
        'nothing downstream can see.\n' +
        `  Generate it (deploy/scripts/estate-bootstrap.sh) or point at it: ${SECRETS_FILE_ENV}=<path>[,<path>]`,
    )
  }

  if (secrets.literals.length === 0) {
    throw new Error(
      `base '${baseName}' read its secret file(s) and found no literal values in them ` +
        `(${secrets.source}). An empty literal set is a refusal that cannot fire, which is ` +
        'indistinguishable from one that was never tripped.\n' +
        `  Check the file holds the estate's generated credentials, or point at the right one: ` +
        `${SECRETS_FILE_ENV}=<path>[,<path>]`,
    )
  }
}

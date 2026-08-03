/**
 * THE ESTATE-WIDE RESPONSE-BODY SCAN: no route in any service may return private key material.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS EXISTS TO CATCH, AND WHY NOTHING ELSE COULD
 *
 * `docs/ecosystem/17-definition-of-done.md` §5 item 4 demands the property be asserted "by a
 * response-body scan across the entire route surface, not by inspection". Exactly one service of
 * twenty-four implements it: `custody/src/bodyscan.test.ts`, which mints one key in every family,
 * reads the plaintext out of the vault, drives custody's routes and asserts no body or header
 * contains any of it. It is the right instrument and it is the model for this one.
 *
 * It is also, structurally, only about custody. The other twenty-three services each have their own
 * Postgres, their own route table and their own suite, and no per-repository check can state a fact
 * about the estate — the same reason `ledgeraccounts.ts` lives here. The only estate-wide key check
 * that exists today is `org/.github/workflows/secret-hygiene.yml:73-83`, which greps repository
 * FILES for PEM blocks. A grep over files cannot see what a running route returns; the two checks
 * do not overlap at all.
 *
 * CUSTODY'S SCAN WAS ONCE NARROWER THAN ITS OWN DOCSTRING SAID, and the history is why this file no
 * longer contains a sentence about it. `custody/src/bodyscan.test.ts` used to claim it enumerated
 * "the routes from the server's own table rather than by hand" while `routeSamples()` was a
 * hand-typed array that never referenced `buildRoutes`; two routes — `POST /v1/exports/:id/cancel`
 * and `POST /v1/exports/:id/challenge` — were therefore driven by nothing at all, the second being
 * the one that returns the reveal token. Custody fixed that in `a633986`: `routeTable()` is derived
 * from `buildRoutes()`, samples DECLARE the route they cover, the two sets must be equal in both
 * directions, and the server's own `http_requests_total{route=…}` counter is read back so a declared
 * route that was not actually reached fails naming itself.
 *
 * THIS FILE RESTATED THAT DEFECT IN PROSE FOR EXACTLY AS LONG AS IT EXISTED, AND THEN FOR A WHILE
 * AFTER IT WAS FIXED. That is the same rot the estate spent a night clearing: ~40 stale citations
 * across four repositories, a gap file whose evidence pointed at the wrong remedy, and — precisely
 * here — a comment that described a test rather than reading it. So the claim is now DERIVED:
 * `readDynamicCoverage` parses custody's sample list out of its AST on every run and reconciles it,
 * in both directions, against the routes this analyser independently extracted from custody's
 * `buildRoutes`. Two numbers computed from the same source by two different readers, and a
 * disagreement is red. Nothing here asserts in prose what a route surface says for itself.
 *
 * That is also the reason a claim about a route surface has to be derived from the route surface.
 * This module reads `buildRoutes` itself, so a route added tomorrow is judged tomorrow.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * STATIC, AND WHAT THAT COSTS
 *
 * This is a static analysis over the estate's TypeScript, not a dynamic scan, and the difference is
 * a real loss that is worth stating before the first line of code.
 *
 * A dynamic scan of twenty-four services needs twenty-four Postgres schemas migrated, twenty-four
 * dependency graphs stubbed, a chain adapter per family and — the part that cannot be arranged at
 * all — a fixture holding REAL key material for each service, because a body scan works by knowing
 * the forbidden strings. Custody can do that: it owns the vault, so it can mint a key and read the
 * plaintext back. `micro-market` cannot; there is no private key in micro-market to compare a body
 * against. Turning the DoD item into "boot the estate" makes it a check nobody runs.
 *
 * What is lost: a dynamic scan proves the observed bodies were clean under the requests it sent.
 * This proves something both weaker and wider — that no route's response expression is REACHABLE
 * from a value this analyser can identify as key material, over every route in the estate, under
 * every input, including the error paths a dynamic scan only reaches if somebody wrote the failing
 * request. Neither subsumes the other, and this one does NOT prove what custody's proves. Custody's
 * stays, and every service that grows real key material should grow one of its own.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT CANNOT SEE
 *
 * Written here, at the top, and printed in every report — because a sweep whose limits are not
 * stated is a sweep people believe things about that are not true, and a scan that finds only the
 * easy cases and reports green is worse than no scan: it licenses the belief that the class is
 * closed. `ledgeraccounts.ts` was built the same way and its list is the reason it is trusted.
 *
 *   * **Anything the route surface does not describe.** Routes are read from source in the three
 *     spellings the estate uses (see `extractRoutes`). A fourth spelling would be read as no routes
 *     at all — so a `server.ts` that declares a route table and yields ZERO routes is FATAL, never
 *     silently zero. Bare `createServer` handlers, proxies and front ends are outside the surface.
 *   * **Values this analyser cannot follow.** Anything reaching a response body through a function
 *     it cannot resolve — an injected dependency, a package import, a local nothing binds — is
 *     recorded as an OPAQUE reach: named, classified by WHY, printed, and never silently dropped.
 *     `BASELINE_BLIND_ROUTES` is the ratchet on the part of that which matters: today 37 of the 113
 *     routes in the four services that hold key material have a response this cannot fully account
 *     for, and every one is printed by name on every run. `BASELINE_BLIND_TO_EVERY_CHECK` is the
 *     second, stricter ratchet beneath it — of those 37, the 31 that no dynamic body scan in their
 *     own service drives either. Read both constants: they are two numbers on purpose.
 *   * **One level of field sensitivity, and no more.** `a.b.c` is followed as "the `c` of the `b`"
 *     for one hop at a time, and `MAX_DEPTH` is 14. A body assembled through fifteen layers is a
 *     `depth-limit` reach — counted, and a defect in this analyser rather than in the estate.
 *   * **Aliasing and mutation.** `const out = {}; out.key = secret; return { body: out }` is a shape
 *     this does not model: the walk reads what an expression IS, not what was assigned into it.
 *     Nothing in the estate builds a body that way today, which is why it is a stated limit rather
 *     than a feature — but it is the most likely way a real leak would slip past.
 *   * **Anything a route's own SUITE could see and this cannot.** custody's dynamic scan knows the
 *     actual bytes of an actual private key and asserts no actual response contains them. That is a
 *     strictly different and stronger claim about custody's routes than anything here — which is
 *     why a route it drives does NOT reduce `BASELINE_BLIND_ROUTES`, and does reduce
 *     `BASELINE_BLIND_TO_EVERY_CHECK`. And this file can only see that the sample EXISTS, in source;
 *     that it RUNS is custody's suite's business, and custody's skips itself without a test
 *     database. `DYNAMIC_SCANS` says so where it is declared.
 *   * **Runtime provenance.** A handler returning a database row this analyser resolved to a table
 *     with no secret column is judged on the schema in `migrations.ts`. A column added by hand in
 *     production, a `jsonb` blob with a key inside it, or a row already written is invisible.
 *   * **Serialisation side channels.** Headers other than those written as a `headers:` literal,
 *     `Error.stack` reaching a 500 body through a framework, and anything a logger emits are not a
 *     response body in this model. Custody's dynamic scan checks headers; this does not.
 *   * **Whether the vocabulary is right.** `MATERIAL` and `ADJACENT` below are a claim about what
 *     key material is called in this estate, sourced to custody's own statement of the boundary
 *     (`custody/src/exports.ts:440-453`). A key stored under a name no one has thought of is a key
 *     this does not see. The `shape` pass is the partial answer: it reads the VALUE, not the name.
 *   * **Branches.** It reads `main` in CI, like every other estate check.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// What "key material" means
// ---------------------------------------------------------------------------

/**
 * THE BOUNDARY, AND WHY IT IS DRAWN HERE.
 *
 * `custody/src/exports.ts:440-453` is the best statement of it in the estate. Deciding what its
 * `custody.key.exported` event could carry, it omits five things and says why: the material itself;
 * the reveal token **and its SHA-256**, because "the token is the one secret in the estate that
 * yields a private key, and the hash is what a redemption is compared against"; the vault slot id
 * and the derivation path, because neither "is a secret on its own; both narrow the search for
 * one"; and the keystore passphrase.
 *
 * That reasoning gives two tiers, not one, and the distinction matters because they are judged the
 * same way but argued differently.
 *
 *   MATERIAL — the secret, or a lossless encoding of it. A route returning one is a total loss of
 *   the funds behind it. There is no legitimate instance in this estate except the last gate of
 *   custody's export ceremony, which is why that one is written down in `ACKNOWLEDGED` below.
 *
 *   ADJACENT — not the secret, but it yields or materially narrows the search for one. custody's
 *   own list, plus the estate's other stored secrets: identity's `private_jwk_enc` (the key that
 *   signs every token in the estate), its `secret_enc` (TOTP), devplatform's client secrets.
 *
 * WHAT IS DELIBERATELY NOT HERE, and this is where a vocabulary earns or loses its usefulness:
 *
 *   * **Session tokens, access tokens, refresh tokens, API keys.** identity's `/auth/login` returns
 *     a JWT; that is the route's purpose. They are credentials, not private key material, they are
 *     scoped and expiring, and every one of the estate's ~300 routes that authenticates anything
 *     touches one. Including them makes this check ~90% false positives on its first run, which is
 *     the shape of check that gets switched off in a week. `token` is in neither tier.
 *   * **Password and token HASHES generally.** A bcrypt `password_hash` is not key material and
 *     returning one is a different (real, lesser) defect. The ONE hash in ADJACENT is custody's
 *     `token_hash`, and only because custody argued it: a reveal-token hash is what a redemption is
 *     compared against, so it is a step from the material rather than a step from a password.
 *   * **Public keys, JWKS, addresses, `kid`.** Published on purpose.
 *   * **`salt`, `iv`, `nonce`.** Not secret by construction.
 *
 * The names are matched case-insensitively with separators stripped, so `privateKey`,
 * `private_key`, `PRIVATE_KEY` and `privatekey` are one entry. The estate spells its columns in
 * snake_case and its fields in camelCase and a vocabulary that had to list both would rot.
 */
export const MATERIAL: readonly string[] = Object.freeze([
  'privatekey',
  'privkey',
  'secretkey',
  'privatejwk',
  'privatejwkenc',
  'mnemonic',
  'seedphrase',
  'recoveryphrase',
  'keymaterial',
  'privatespendkey',
  'privateviewkey',
  'xprv',
  'xpriv',
  'wif',
  'masterkey',
  'rootkey',
  'seedhex',
  'entropyhex',
  // custody's own name for the plaintext its ceremony hands over — `materialise()` produces it and
  // the redeem route returns it. Anything else in the estate calling a response field `material`
  // gets to explain itself.
  'material',
  'plaintextkey',
  'decryptedkey',
])

export const ADJACENT: readonly string[] = Object.freeze([
  // custody/src/exports.ts:447 — "the one secret in the estate that yields a private key".
  'revealtoken',
  // ibid — "the hash is what a redemption is compared against".
  'tokenhash',
  // ibid:450 — "the vault slot behind a `mnemonic` export ... narrow the search for one". `seed_id`
  // names a vault file; `slot` is `seed:<uuid>` and reaches the filesystem (custody/src/vault.ts:44).
  //
  // `derivation_path` is NOT here, and it is the one line of this vocabulary that was written, run
  // against the estate, and then deleted. custody returns it on every key record — nine routes, via
  // `toKeyRecord` (custody/src/server.ts:91) — and custody/src/exports.ts:450 says exactly why that
  // is right: it is omitted from the EVENT, which lands in five stores that are not the vault, and
  // returned in the RESPONSE "because the user restoring a phrase needs it — a response goes to one
  // authenticated user, an event goes to subscribers". A path with no seed behind it opens nothing.
  // Keeping it would have made this check nine findings red on its first run against a deliberate,
  // argued design decision, which is the fastest way to have a check switched off.
  'seedid',
  'vaultslot',
  // ibid:452 — "the passphrase a keystore was wrapped with".
  'passphrase',
  'keystorepassphrase',
  // The ciphertext. Not the secret, but the whole of it: an attacker holding it needs only the
  // master secret, which is one environment variable away.
  'encryptedmaterial',
  'secretenc',
  'encryptedkey',
  'keyenc',
  'blobenc',
  // identity/src/migrations.ts:278 — the TOTP shared secret. Possession is the second factor.
  'totpsecret',
  'mfasecret',
  'recoverycodes',
  'backupcodes',
  // devplatform/src/migrations.ts:297 and notify/src/migrations.ts:94 — webhook signing secrets.
  'signingsecret',
  'webhooksecret',
  'clientsecret',
])

/**
 * Calls whose RESULT is key material, whatever the caller then names it.
 *
 * The name pass reads what a field is called and the shape pass reads what a literal is; neither
 * sees `body: { blob: await deps.vault.read(slot) }`, where nothing is called a key and nothing is
 * a literal. This pass reads where the value CAME FROM, which is the only one of the three that
 * survives a rename.
 *
 * Matched on the callee's last name segment, so `deps.vault.read`, `vault.read` and a destructured
 * `read` all hit — over-broad on purpose for `decrypt`, which no route has any business calling
 * under any receiver.
 */
export const PRODUCERS: readonly string[] = Object.freeze([
  'decrypt',
  'decrypttostring',
  'materialise',
  'materialize',
  'unsealkey',
  'unwrapkey',
  'exportprivatekey',
  'toprivatekey',
  'privatekeyof',
  'tomnemonic',
  'entropytomnemonic',
  'generatemnemonic',
  'towif',
  'tojwkprivate',
])

/**
 * A vault read is a producer too, and it is spelled `read`, which is far too common a method name
 * to put in `PRODUCERS`. So it is matched on the RECEIVER as well: `vault.read`, `deps.vault.read`,
 * `keyvault.read`. A destructured `const { read } = deps.vault` escapes this and is the honest
 * price of not making every `.read()` in the estate a finding.
 */
const RECEIVER_PRODUCERS: readonly [receiver: string, method: string][] = Object.freeze([
  ['vault', 'read'],
  ['keyring', 'decrypt'],
  ['keyring', 'unwrap'],
])

/**
 * String literals that ARE key material, whatever they are called and wherever they came from.
 *
 * This is the pass that needs no vocabulary and no provenance, and it is the one that catches the
 * case the other two are blindest to: a key pasted into source. `secret-hygiene.yml:73-83` greps
 * repository files for PEM blocks, which finds the same literal — but this pass only fires when the
 * literal REACHES A RESPONSE BODY, which is a strictly different and much louder claim.
 *
 * Each pattern is anchored on a form that cannot occur by accident. A bare 64-hex run is NOT here:
 * a sha-256 digest, a commit tree hash and a test fixture id are all 64 hex characters, and a
 * pattern that fires on those fires constantly and gets deleted.
 */
export const KEY_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'PEM private key block', pattern: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/ },
  { name: 'BIP-32 extended private key', pattern: /\b(?:xprv|tprv|yprv|zprv)[1-9A-HJ-NP-Za-km-z]{20,}/ },
  { name: 'Bitcoin WIF', pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/ },
  // 0x + exactly 64 hex, which is the EVM private key form. Distinguished from a digest by the 0x,
  // which the estate writes on keys and calldata and not on hashes it stores.
  { name: '0x-prefixed 32-byte secret', pattern: /\b0x[0-9a-fA-F]{64}\b(?!["'`]?\s*(?:as|satisfies)\s)/ },
  { name: 'private JWK (has "d")', pattern: /"kty"\s*:\s*"(?:EC|OKP|RSA)"[^}]*"d"\s*:/ },
])

// ---------------------------------------------------------------------------
// The route surface
// ---------------------------------------------------------------------------

export type RouteSpelling = 'object-literal' | 'helper-call'

export interface RouteRef {
  readonly service: string
  /** Repository-relative, so a finding can be opened. */
  readonly file: string
  readonly line: number
  readonly method: string
  readonly path: string
  readonly spelling: RouteSpelling
}

/** A route table this analyser could not read. Fatal, never counted as "no routes". */
export interface UnreadableRoutes {
  readonly service: string
  readonly file: string
  readonly why: string
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** Case and separators removed, so one vocabulary entry covers camelCase and snake_case. */
export function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[_\-.\s]/g, '')
}

function literalString(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAwaitExpression(current)) current = current.expression
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else return current
  }
}

function propertyValue(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === name) return property.name
      continue
    }
    if (!ts.isPropertyAssignment(property)) continue
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
    if (key === name) return property.initializer
  }
  return null
}

function hasProperty(literal: ts.ObjectLiteralExpression, name: string): boolean {
  return propertyValue(literal, name) !== null
}

/**
 * Every route this source declares, with the handler body to follow, in the three spellings the
 * estate actually uses.
 *
 * The AST rather than a regex, for the reason `ledgeraccounts.ts` gives and for a sharper one here:
 * the estate declares its routes three different ways, and a pattern tuned to any one of them
 * silently reports the other two as a service with no routes at all.
 *
 *   1. `{ method: 'GET', path: '/livez', handle: async (ctx, deps) => … }`  — micro-custody,
 *      micro-notify, micro-policy, micro-settlement, micro-activity, micro-analytics, micro-hub-api.
 *   2. `define('GET', '/livez', async (ctx, deps) => …)`                    — micro-identity,
 *      micro-ledger, micro-market, micro-billing, micro-admin-api and most of the rest.
 *   3. `route('GET', '/livez', async (ctx, deps) => …)`                     — micro-wallet.
 *
 * 2 and 3 are one shape with two names, and this deliberately does not hard-code either name: any
 * call whose first argument is an HTTP method literal and whose second is a path literal is a route
 * declaration. Hard-coding `define`/`route` would make a fourth wrapper invisible, and invisible is
 * the failure this whole module exists to avoid.
 */
export interface RouteHandler {
  readonly route: RouteRef
  /** The function whose replies are the route's response bodies. */
  readonly body: ts.Node
}

export function collectRoutes(service: string, file: string, tree: ts.SourceFile): RouteHandler[] {
  const out: RouteHandler[] = []
  const at = (node: ts.Node, method: string, path: string, spelling: RouteSpelling): RouteRef => ({
    service,
    file,
    line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    method,
    path,
    spelling,
  })

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const methodNode = propertyValue(node, 'method')
      const pathNode = propertyValue(node, 'path')
      const handle = propertyValue(node, 'handle') ?? propertyValue(node, 'handler')
      if (methodNode && pathNode && handle) {
        const method = literalString(methodNode)
        const path = literalString(pathNode)
        if (method !== null && path !== null && HTTP_METHODS.has(method) && path.startsWith('/')) {
          out.push({ route: at(node, method, path, 'object-literal'), body: bodyOf(handle, tree) })
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 3) {
      const method = literalString(unwrap(node.arguments[0] as ts.Expression))
      const path = literalString(unwrap(node.arguments[1] as ts.Expression))
      if (method !== null && path !== null && HTTP_METHODS.has(method) && path.startsWith('/')) {
        out.push({
          route: at(node, method, path, 'helper-call'),
          body: bodyOf(node.arguments[2] as ts.Expression, tree),
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(tree)
  return out
}

/** The handler's body — an inline function, or the function a named handler resolves to in-file. */
function bodyOf(handler: ts.Expression, tree: ts.SourceFile): ts.Node {
  const expression = unwrap(handler)
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression
  if (ts.isIdentifier(expression)) {
    const fn = findFunctionIn(tree, expression.text)
    if (fn) return fn
  }
  return expression
}

/** Convenience for tests and for the surface count: the routes a source declares. */
export function extractRoutes(service: string, file: string, source: string): RouteRef[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
  return collectRoutes(service, file, tree).map((handler) => handler.route)
}

// ---------------------------------------------------------------------------
// Reaching the response body
// ---------------------------------------------------------------------------

/** One thing observed flowing into a response body. */
export interface Reach {
  /** How it was named where it entered the body — `privateKey`, `…row`, `<returned>`. */
  readonly as: string
  readonly kind: 'field' | 'access' | 'call' | 'producer' | 'literal' | 'row' | 'opaque'
  /**
   * The file the value was OBSERVED in, absolute — not the file the route is declared in.
   *
   * The two differ constantly and the difference is the whole point of following imports:
   * identity's JWKS route is declared at `server.ts:750` and the value it returns is built in
   * `keys.ts:226`. An early version of this module printed the route's file with the value's line
   * number, producing `identity/src/server.ts:116` for a node in `keys.ts` — a citation that
   * looks precise and sends the reader to an unrelated import block.
   */
  readonly file: string
  readonly line: number
  /** The source text, one line, trimmed. */
  readonly text: string
  /** For `opaque`: what kind of thing could not be opened. Set only when `kind` is `opaque`. */
  readonly reason?: OpaqueReason
}

/**
 * WHY A VALUE COULD NOT BE FOLLOWED — the taxonomy of this check's blind spot.
 *
 * A single "unresolved" count would be true and useless. These four are not the same risk and
 * lumping them together is how a budget stops meaning anything:
 *
 *   * `dep-call`      — a method on an injected dependency, `deps.lifecycle.livez()`. The value is
 *                       built in a module the route does not name, so nothing about its SHAPE is
 *                       readable here. The commonest by far, and the one a service's own suite is
 *                       best placed to judge.
 *   * `package-call`  — a symbol imported from `@cloudsforge/*` or npm. Outside the repository, and
 *                       following it would need a module graph across 56 checkouts.
 *   * `derived`       — a method call on a value the walk DID follow: `row.created_at.toISOString()`.
 *                       The source field is known and judged; only the transformation is not. Far
 *                       the commonest and much the weakest of the four, which is exactly why it is
 *                       separated: 600-odd `toISOString()` calls in one bucket with a handful of
 *                       genuinely unknown values would hide the handful.
 *   * `unresolved`    — a local name with no binding this analyser could find.
 *   * `depth-limit`   — the walk gave up. Always a defect in this analyser, never in the estate.
 */
export type OpaqueReason = 'dep-call' | 'package-call' | 'derived' | 'unresolved' | 'depth-limit'

export type Severity = 'material' | 'adjacent' | 'opaque'

export interface Finding {
  readonly service: string
  readonly file: string
  readonly line: number
  readonly method: string
  readonly path: string
  readonly severity: Severity
  /** Where the ROUTE is declared, `src/server.ts:750`. `file:line` above is where the VALUE is. */
  readonly declaredAt: string
  /** Which pass fired: the field's name, the value's provenance, or the literal's shape. */
  readonly pass: 'name' | 'provenance' | 'shape' | 'row' | 'unresolved'
  /** For an opaque finding: why the value could not be opened. */
  readonly reason?: OpaqueReason
  readonly detail: string
  readonly evidence: string
}

const MATERIAL_SET = new Set(MATERIAL)
const ADJACENT_SET = new Set(ADJACENT)
const PRODUCER_SET = new Set(PRODUCERS)

/**
 * A repository's modules, so a body built by a function in another file can still be read.
 *
 * This is the difference between a check that sees `body: { privateKey: k }` and one that also sees
 * `body: toKeyRecord(row)` where `toKeyRecord` is three files away — which is how every well-written
 * service in this estate builds a response. Without it the analyser would be blindest exactly where
 * the code is tidiest, the same trap `ledgeraccounts.ts` records for its `nearestConstant` walk.
 *
 * Resolution is RELATIVE IMPORTS WITHIN ONE REPOSITORY ONLY. A `@cloudsforge/*` package import is
 * not followed — it is an OPAQUE reach, counted and named. Following them would need a module graph
 * across 56 checkouts with no shared tsconfig, and a half-followed graph that reported green would
 * be worse than one that says where it stopped.
 */
export class RepoModules {
  readonly #cache = new Map<string, ts.SourceFile | null>()
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** The parsed module a relative specifier names, or null when it is outside the repository. */
  resolve(fromFile: string, specifier: string): ts.SourceFile | null {
    if (!specifier.startsWith('.')) return null
    const base = resolve(dirname(fromFile), specifier)
    const candidates = [
      base,
      base.replace(/\.js$/, '.ts'),
      `${base}.ts`,
      join(base, 'index.ts'),
      base.replace(/\.ts$/, '.ts'),
    ]
    for (const candidate of candidates) {
      if (!candidate.endsWith('.ts')) continue
      if (!candidate.startsWith(this.#root)) return null
      const cached = this.#cache.get(candidate)
      if (cached !== undefined) {
        if (cached) return cached
        continue
      }
      let text: string
      try {
        text = readFileSync(candidate, 'utf8')
      } catch {
        this.#cache.set(candidate, null)
        continue
      }
      const parsed = ts.createSourceFile(candidate, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
      this.#cache.set(candidate, parsed)
      return parsed
    }
    return null
  }
}

/**
 * `create table x ( … secret_enc text … )` per repository, reduced to the tables that hold one.
 *
 * A COLUMN literally named `secret` counts here even though the bare word is not in either tier of
 * the field vocabulary, and the asymmetry is deliberate. As a response FIELD, `secret` is ambiguous
 * enough to be noise. As a COLUMN, it is a schema author writing down that this is where the secret
 * goes — notify/src/migrations.ts:94 and devplatform/src/migrations.ts:297 are both webhook signing
 * secrets. The stronger signal earns the wider net.
 */
export function secretBearingTables(migrationSource: string): Map<string, string[]> {
  const tables = new Map<string, string[]>()
  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\s*\)/gi
  for (const match of migrationSource.matchAll(create)) {
    const table = (match[1] ?? '').toLowerCase()
    const columns = (match[2] ?? '')
      .split('\n')
      .map((line) => (/^\s*([a-z0-9_]+)\s+[a-z]/i.exec(line)?.[1] ?? '').toLowerCase())
      .filter((name) => name.length > 0)
    const secret = columns.filter(
      (name) =>
        MATERIAL_SET.has(canonicalName(name)) ||
        ADJACENT_SET.has(canonicalName(name)) ||
        canonicalName(name) === 'secret',
    )
    if (secret.length > 0) tables.set(table, secret)
  }
  return tables
}

interface WalkContext {
  readonly modules: RepoModules
  readonly secretTables: ReadonlyMap<string, readonly string[]>
  readonly reaches: Reach[]
  /** (node span, position) already walked — see the visitKey in walkValue. */
  readonly visited: Set<string>
  /** (line, kind, name) already recorded for THIS route — see `push`. */
  readonly seen: Set<string>
}

/**
 * 14, not 6. The first run against the estate hit the limit 180 times — `admin-api`'s approval
 * routes nest a projection inside a transaction inside a helper — and every one of those is a body
 * this analyser gave up on rather than one the estate made unreadable. A depth limit that fires is
 * a blind spot this module chose for itself, so it is set where the estate stops needing it and its
 * hits are counted separately from the estate's own opacity.
 */
/**
 * The language's own total functions of their arguments — see the call branch of `walkValue`.
 *
 * Deliberately short and deliberately not extensible by pattern: every entry is a function whose
 * OUTPUT cannot contain anything its INPUT did not, so following the input is following the output.
 * `JSON.parse` is NOT here — it turns an opaque string into an object of unknown shape, which is
 * the opposite property.
 */
const GLOBAL_COERCIONS = new Set([
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'JSON.stringify',
  'Object.freeze',
  'Array.from',
  'structuredClone',
])

const MAX_DEPTH = 14

/**
 * WHAT PART OF A VALUE TRAVELS — one level of field sensitivity, and it is not optional.
 *
 * `value` — the whole thing lands in the response body. Every field it has travels, so failing to
 * open it is a real blind spot and is counted.
 *
 * `field` — only ONE property of it travels: the `publicJwk` in `key.publicJwk`. A field-INsensitive
 * walk expands the whole object, and the estate proves within one run why that is useless. identity
 * publishes its JWKS with `rows.map((r) => r.public_jwk)`, falling back to `getSigningKey(sql)` and
 * returning `key.publicJwk`. `getSigningKey` returns `{ kid, privateKey, publicJwk }` — so a walk
 * that opens the whole record reports GET /.well-known/jwks.json, the most deliberately public route
 * in the estate, as returning a private key. That finding is false, it is the loudest one the first
 * run produced, and a check whose flagship finding is false is a check that gets deleted.
 *
 * Carrying the accessed name costs one field on this type and removes the entire class.
 */
export type Position = { readonly via: 'value' } | { readonly via: 'field'; readonly name: string }

const VALUE: Position = { via: 'value' }

function lineOf(node: ts.Node): number {
  const tree = node.getSourceFile()
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
}

function textOf(node: ts.Node): string {
  const tree = node.getSourceFile()
  return tree.text.slice(node.getStart(tree), node.getEnd()).replace(/\s+/g, ' ').slice(0, 140)
}

/** The last name segment of a callee: `deps.vault.read` → `read`. */
function calleeName(node: ts.Expression): { name: string; receiver: string } {
  const callee = unwrap(node)
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = ts.isPropertyAccessExpression(callee.expression)
      ? callee.expression.name.text
      : ts.isIdentifier(callee.expression)
        ? callee.expression.text
        : ''
    return { name: callee.name.text, receiver }
  }
  if (ts.isIdentifier(callee)) return { name: callee.text, receiver: '' }
  return { name: '', receiver: '' }
}

/** The nearest enclosing `const NAME = …`, walking out through block scopes — as the language does. */
function nearestBinding(from: ts.Node, name: string): ts.Expression | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    const statements = ts.isSourceFile(scope)
      ? scope.statements
      : ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : null
    if (!statements) continue
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          return declaration.initializer
        }
      }
    }
  }
  return null
}

/**
 * The module a name is imported from, and the name it has there.
 *
 * Shared by `resolveFunction` and `resolveImportedBinding` so the two cannot disagree about which
 * file a name came from — a disagreement that would show up as a body followed for its functions
 * and not for its constants, which is exactly the bug this was extracted to fix.
 */
function importedFrom(
  context: WalkContext,
  tree: ts.SourceFile,
  name: string,
): { module: ts.SourceFile; original: string } | null {
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = literalString(statement.moduleSpecifier as ts.Expression)
    if (specifier === null) continue
    const clause = statement.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    const named = clause.namedBindings.elements.find((element) => element.name.text === name)
    if (!named) continue
    const module = context.modules.resolve(tree.fileName, specifier)
    if (!module) return null
    return { module, original: named.propertyName?.text ?? name }
  }
  return null
}

/**
 * An imported CONSTANT's initialiser.
 *
 * `import { record } from './records.ts'` then `body: { ...record }` is a spread of a value declared
 * in another file, and a resolver that only followed functions read it as unresolvable — so a spread
 * putting every field of a record on the wire looked like a value this scan could not open rather
 * than one it could read perfectly well.
 */
function resolveImportedBinding(context: WalkContext, from: ts.Node, name: string): ts.Expression | null {
  const found = importedFrom(context, from.getSourceFile(), name)
  if (!found) return null
  for (const statement of found.module.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === found.original && declaration.initializer) {
        return declaration.initializer
      }
    }
  }
  return null
}

/** A function declared in this file, or exported by a relative import of it. */
function resolveFunction(
  context: WalkContext,
  from: ts.Node,
  name: string,
): ts.FunctionLikeDeclaration | null {
  const tree = from.getSourceFile()
  const inFile = findFunctionIn(tree, name)
  if (inFile) return inFile
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = literalString(statement.moduleSpecifier as ts.Expression)
    if (specifier === null) continue
    const clause = statement.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    const named = clause.namedBindings.elements.find((element) => element.name.text === name)
    if (!named) continue
    const module = context.modules.resolve(tree.fileName, specifier)
    if (!module) return null
    const original = named.propertyName?.text ?? name
    return findFunctionIn(module, original)
  }
  return null
}

function findFunctionIn(tree: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      found = node
      return
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const initializer = node.initializer ? unwrap(node.initializer) : null
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        found = initializer
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** Every expression a function can return, including a concise arrow body. */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const out: ts.Expression[] = []
  const body = fn.body
  if (!body) return out
  if (!ts.isBlock(body)) return [body]
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression)
    ts.forEachChild(node, visit)
  }
  visit(body)
  return out
}

/**
 * Follow a value into the response body, recording everything observed on the way.
 *
 * The over-approximation is deliberate and one-directional: every branch of a ternary is followed,
 * both sides of `??`, every element of an array, every return of a resolved function. A value that
 * reaches the body on ANY path is a value that reaches the body.
 */
export function walkValue(
  context: WalkContext,
  node: ts.Expression,
  label: string,
  depth: number,
  position: Position = VALUE,
): void {
  if (depth > MAX_DEPTH) {
    push(context, { as: label, kind: 'opaque', reason: 'depth-limit', ...where(node) })
    return
  }
  const expression = unwrap(node)
  // Keyed by FILE, node span and position, and each of the three earns its place.
  //
  // Position, because `toRecord(row)` reached as a whole body and reached as `.id` are different
  // questions about the same node and answering only the first drops the second.
  //
  // File, because `pos`/`end` are offsets into ONE source file and collide freely across files —
  // and the collision is silent and total. Without it, walking custody's redeem route stopped at a
  // node in `exports.ts` whose offsets happened to match one already seen in `server.ts`, so the
  // object literal carrying `material` and `derivationPath` was never opened and the route the whole
  // acknowledgement list exists for reported nothing. That is the exact failure this module is meant
  // to catch in other people's code.
  const visitKey = `${expression.getSourceFile().fileName}:${expression.pos}:${expression.end}:${
    position.via === 'field' ? position.name : ''
  }`
  if (context.visited.has(visitKey)) return
  context.visited.add(visitKey)

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        // A spread supplies whatever the position asks for, and in VALUE position it supplies every
        // field the spread value has — named or not. It carries the position through unchanged.
        walkValue(context, property.expression, `…${label}`, depth + 1, position)
        continue
      }
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ? property.name.text
          : ts.isPropertyAssignment(property)
            ? '<computed>'
            : null
      if (name === null) continue
      // In field position only the requested property travels. Everything else on this object is
      // not on the wire and must not be judged as if it were.
      if (position.via === 'field' && position.name !== name) continue
      push(context, { as: name, kind: 'field', ...where(property) })
      if (ts.isShorthandPropertyAssignment(property)) {
        const bound = nearestBinding(property, name)
        if (bound) walkValue(context, bound, name, depth + 1)
        continue
      }
      if (ts.isPropertyAssignment(property)) walkValue(context, property.initializer, name, depth + 1)
    }
    return
  }

  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) walkValue(context, element.expression, label, depth + 1, position)
      else walkValue(context, element, label, depth + 1, position)
    }
    return
  }

  if (ts.isConditionalExpression(expression)) {
    walkValue(context, expression.whenTrue, label, depth + 1, position)
    walkValue(context, expression.whenFalse, label, depth + 1, position)
    return
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      walkValue(context, expression.left, label, depth + 1, position)
      walkValue(context, expression.right, label, depth + 1, position)
    }
    return
  }

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression)
  ) {
    push(context, { as: label, kind: 'literal', ...where(expression) })
    return
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    // `sql\`select … from custody_keys\``. Recorded ONLY in value position, where the whole row goes
    // on the wire. In field position a single column travels and the access pass has already read
    // its name — `row.private_jwk_enc` is caught as a name, and reporting the row as well would
    // make every projection off a wide table a leak.
    if (position.via === 'value') push(context, { as: label, kind: 'row', ...where(expression) })
    return
  }

  if (ts.isPropertyAccessExpression(expression)) {
    push(context, { as: expression.name.text, kind: 'access', ...where(expression) })
    walkValue(context, expression.expression, label, depth + 1, { via: 'field', name: expression.name.text })
    return
  }

  if (ts.isElementAccessExpression(expression)) {
    const index = literalString(expression.argumentExpression)
    if (index !== null) {
      push(context, { as: index, kind: 'access', ...where(expression) })
      walkValue(context, expression.expression, label, depth + 1, { via: 'field', name: index })
      return
    }
    // `rows[0]` — an ELEMENT, not a field. The element is whatever the position asked of the array,
    // so the position is carried through rather than reset.
    walkValue(context, expression.expression, label, depth + 1, position)
    return
  }

  if (ts.isCallExpression(expression)) {
    const { name, receiver } = calleeName(expression.expression)
    // A PRODUCER is recorded as its own kind, with the receiver in the name.
    //
    // It used to be recorded as an ordinary `call` and matched again in `judge` by name alone, which
    // meant `deps.vault.read(slot)` — the single most direct way to put a private key on a wire in
    // this estate — was recorded as a call named `read`, matched nothing, and passed. The match is
    // made ONCE, here, where the receiver is still in hand, and the verdict follows the match
    // instead of trying to reproduce it.
    const producer =
      PRODUCER_SET.has(canonicalName(name)) ||
      RECEIVER_PRODUCERS.some(([r, m]) => canonicalName(receiver).includes(r) && canonicalName(name) === m)
    push(context, {
      as: producer && receiver ? `${receiver}.${name}` : name,
      kind: producer ? 'producer' : 'call',
      ...where(expression),
    })
    if (producer) return
    // `rows.map(toRecord)` and `rows.map((row) => ({ … }))` — the element shape is the body shape.
    //
    // THE RECEIVER IS DELIBERATELY NOT FOLLOWED. `rows.map(toKeyRecord)` puts the PROJECTION on the
    // wire, not the row, and the whole point of a projection is that the columns it leaves out do
    // not travel. Following `rows` as well made the first run against the estate report three
    // `select *` queries as leaks when what reached the body was nine named fields — and a check
    // whose first three findings are wrong is a check nobody reads the fourth finding of. A callback
    // this cannot resolve is still an opaque reach, so a projection through an unreadable function
    // is counted rather than assumed clean.
    if (canonicalName(name) === 'map' || canonicalName(name) === 'flatmap') {
      for (const argument of expression.arguments) {
        const callback = unwrap(argument)
        if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
          for (const returned of returnedExpressions(callback)) walkValue(context, returned, label, depth + 1, position)
        } else if (ts.isIdentifier(callback)) {
          const fn = resolveFunction(context, expression, callback.text)
          if (fn) for (const returned of returnedExpressions(fn)) walkValue(context, returned, label, depth + 1, position)
          else if (position.via === 'value') {
            push(context, {
              as: callback.text,
              kind: 'opaque',
              reason: reasonFor(expression, callback.text, ''),
              ...where(expression),
            })
          }
        }
      }
      return
    }
    // A GLOBAL COERCION. `Number(row.max_units)`, `String(x)`, `JSON.stringify(page)` — a total
    // function of its argument, from the language rather than from this estate. Nothing about the
    // result is unknown that is not already known about the argument, so the argument is walked
    // and the call is not counted as a blind spot. Eleven routes in devplatform and identity were
    // in the blind list for `Number(...)` alone, which is a blind-spot count measuring this
    // analyser's vocabulary rather than the estate's opacity.
    if (GLOBAL_COERCIONS.has(name) || GLOBAL_COERCIONS.has(`${receiver}.${name}`)) {
      for (const argument of expression.arguments) walkValue(context, argument, label, depth + 1)
      return
    }
    const fn = resolveFunction(context, expression, name)
    if (fn) {
      for (const returned of returnedExpressions(fn)) walkValue(context, returned, label, depth + 1, position)
      return
    }
    // A call this analyser cannot open. In VALUE position that is a body whose shape is unknown and
    // it is counted; in FIELD position the property taken off it has already been named and judged.
    if (position.via === 'value') {
      const reason = reasonFor(expression, name, receiver)
      push(context, { as: name || '<anonymous call>', kind: 'opaque', reason, ...where(expression) })
      // A METHOD on a value that is not a dependency — `row.created_at.toISOString()`. The result is
      // unknown, so it is still counted, but the RECEIVER is followed: what the transformation was
      // applied to is exactly what a reader needs to judge whether the output could be a key, and
      // `created_at` is judged by the name pass the moment the receiver is walked.
      if (reason === 'derived') {
        const callee = unwrap(expression.expression)
        if (ts.isPropertyAccessExpression(callee)) walkValue(context, callee.expression, label, depth + 1)
      }
    }
    return
  }

  if (ts.isIdentifier(expression)) {
    const bound = nearestBinding(expression, expression.text) ?? resolveImportedBinding(context, expression, expression.text)
    if (bound && bound !== expression) {
      walkValue(context, bound, expression.text, depth + 1, position)
      return
    }
    const fn = resolveFunction(context, expression, expression.text)
    if (fn) {
      for (const returned of returnedExpressions(fn)) walkValue(context, returned, label, depth + 1, position)
      return
    }
    if (position.via === 'value') {
      push(context, {
        as: expression.text,
        kind: 'opaque',
        reason: reasonFor(expression, expression.text, ''),
        ...where(expression),
      })
    }
    return
  }

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    for (const returned of returnedExpressions(expression)) walkValue(context, returned, label, depth + 1, position)
    return
  }

  if (
    ts.isNumericLiteral(expression) ||
    ts.isBigIntLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isNewExpression(expression) ||
    ts.isTypeOfExpression(expression) ||
    ts.isPrefixUnaryExpression(expression) ||
    ts.isObjectBindingPattern(expression as unknown as ts.Node as ts.Expression)
  ) {
    return
  }

  if (position.via === 'value') {
    push(context, { as: label, kind: 'opaque', reason: 'unresolved', ...where(expression) })
  }
}

/** Where a node is: its own file and line, never the route's. */
function where(node: ts.Node): { file: string; line: number; text: string } {
  const tree = node.getSourceFile()
  return {
    file: tree.fileName,
    line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    text: textOf(node),
  }
}

/**
 * One reach, deduplicated on (file, line, kind, name), per route.
 *
 * A projection reached from four routes would otherwise report the same field four times, and the
 * first run against the estate did exactly that: nine identical `derivationPath` findings from one
 * function. Deduplication is per ROUTE, so two routes reaching the same field are still two
 * findings — they are two routes, and the DoD's claim is about routes.
 */
function push(context: WalkContext, reach: Reach): void {
  const key = `${reach.file}|${reach.line}|${reach.kind}|${reach.as}`
  if (context.seen.has(key)) return
  context.seen.add(key)
  context.reaches.push(reach)
}

/**
 * Why a name could not be opened: an injected dependency, a package, or a local nothing binds.
 *
 * `deps.x.y()` is the estate's dependency-injection spelling in all twenty-nine servers, so a
 * receiver rooted at `deps` is a `dep-call` and nothing else. An identifier the file imports from a
 * non-relative specifier is a `package-call`. Everything else is a local this analyser lost.
 */
function reasonFor(at: ts.Node, name: string, receiver: string): OpaqueReason {
  if (receiver === 'deps' || rootedAtDeps(at)) return 'dep-call'
  void receiver
  const tree = at.getSourceFile()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = literalString(statement.moduleSpecifier as ts.Expression)
    if (specifier === null || specifier.startsWith('.')) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => e.name.text === name)) {
      return 'package-call'
    }
    if (statement.importClause?.name?.text === name) return 'package-call'
  }
  if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(unwrap(at.expression))) return 'derived'
  return 'unresolved'
}

function rootedAtDeps(node: ts.Node): boolean {
  let current: ts.Node = node
  for (let guard = 0; guard < 12; guard += 1) {
    if (ts.isIdentifier(current)) return current.text === 'deps' || current.text === 'ctx'
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression
      continue
    }
    return false
  }
  return false
}


/**
 * Every `body:`/`text:` expression a handler can reply with.
 *
 * A reply is an object literal carrying `status` and at least one of `body`/`text` — the estate's
 * `Reply` interface, which twenty-nine `server.ts` files declare identically. Returns at every
 * depth inside the handler are collected, including inside `sql.begin(async () => …)` and
 * `.then(…)`, because a reply built in a nested closure is still the reply.
 */
export function replyBodies(handler: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && hasProperty(node, 'status')) {
      for (const field of ['body', 'text', 'headers']) {
        const value = propertyValue(node, field)
        if (value) out.push(value)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(handler)
  return out
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface EstateScan {
  readonly routes: readonly RouteRef[]
  readonly findings: readonly Finding[]
  readonly opaque: readonly Finding[]
  /** Every repository whose route surface was read. */
  readonly services: readonly string[]
  /** Repositories with a `server.ts` whose route table yielded nothing. FATAL. */
  readonly unreadable: readonly UnreadableRoutes[]
  readonly filesRead: number
  /** Deliberately not read, and why the caller can see it. */
  readonly excluded: readonly string[]
  /**
   * The services that HOLD key material, derived from the checkout rather than written down.
   *
   * A service with no secret-bearing column and no vault module has no private key to leak, so an
   * unreadable body in it is a gap in this analyser and not a gap in the estate's key hygiene. This
   * list is what lets the report say which of the two a blind spot is, and it is DERIVED — from a
   * secret-bearing column in `migrations.ts` or a `vault.ts`/`keyring.ts`/`keyEnvelope.ts` module —
   * for the same reason estate-ci derives its repository list from the API: micro-org's own
   * hand-written registry did not contain micro-emberkin, one of the three repositories the account
   * defect was actually in.
   */
  readonly holdsKeyMaterial: readonly string[]
  /**
   * The acknowledgements that actually matched something. Carried on the RESULT rather than kept in
   * a module-level set, so scanning two estates in one process cannot make the second one's stale
   * acknowledgements look used by the first — which is a green produced by state, not by evidence.
   */
  readonly acknowledged: readonly Acknowledgement[]
  /**
   * What each service's OWN dynamic body scan drives, derived from its source. See `DYNAMIC_SCANS`.
   *
   * Only for services this run actually read: a declared scan whose repository is not in the
   * checkout is absent from here rather than fatal, because "the estate is not all on this disk" is
   * already refused by `MIN_SERVERS`/`MIN_ROUTES` in the CLI and does not need a second, worse-worded
   * failure. A service that IS here with a broken or missing scan throws.
   */
  readonly dynamicCoverage: readonly DynamicCoverage[]
}

export interface ScanOptions {
  readonly estateDir: string
  /** Defaults to this harness, which holds the vocabulary and would report itself. */
  readonly exclude?: readonly string[]
  /** Defaults to `DYNAMIC_SCANS`. Overridden by the suite, which builds fixture estates. */
  readonly dynamicScans?: readonly DynamicScanRef[]
}

export const DEFAULT_EXCLUDED = Object.freeze(['conformance'])

/**
 * The smallest route surface a scan may read and still claim to have scanned the estate.
 *
 * Same reasoning as `MIN_SERVICES` in `ledgeraccounts.ts`, one layer sharper: this sweep silently
 * reads whatever `server.ts` files it finds, so an empty parent directory would report "0 routes,
 * no findings" and pass. The estate declares ~280 routes across ~29 servers today.
 */
export const MIN_ROUTES = 150
export const MIN_SERVERS = 20

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'corpus', 'fixtures'])

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectServerSources(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (isDirectory(full)) {
      collectServerSources(full, out)
      continue
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue
    if (entry.endsWith('.test.ts') || entry.includes('testsupport')) continue
    out.push(full)
  }
}

/**
 * Read every service's route surface and follow every route's response body.
 *
 * Returns the list of services it actually read, for the reason `sweepEstate` does: "the scan is
 * green" means nothing without "…across these 29 servers and 280 routes", and a checkout missing
 * half the estate is otherwise indistinguishable from an estate that leaks nothing.
 */
export function scanEstate(options: ScanOptions): EstateScan {
  const excluded = options.exclude ?? DEFAULT_EXCLUDED
  const dynamicScans = options.dynamicScans ?? DYNAMIC_SCANS
  const dynamicCoverage: DynamicCoverage[] = []
  const routes: RouteRef[] = []
  const findings: Finding[] = []
  const opaque: Finding[] = []
  const services: string[] = []
  const unreadable: UnreadableRoutes[] = []
  const acknowledged = new Set<Acknowledgement>()
  const holdsKeyMaterial: string[] = []
  let filesRead = 0

  let repos: string[]
  try {
    repos = readdirSync(options.estateDir).sort()
  } catch (err) {
    throw new Error(`no estate at ${options.estateDir}: ${String(err)}`)
  }

  for (const repo of repos) {
    if (SKIP_DIRS.has(repo)) continue
    if (excluded.includes(repo)) continue
    const repoRoot = resolve(options.estateDir, repo)
    const srcDir = join(repoRoot, 'src')
    if (!isDirectory(srcDir)) continue

    const files: string[] = []
    collectServerSources(srcDir, files)
    if (files.length === 0) continue

    const modules = new RepoModules(repoRoot)
    let migrations = ''
    try {
      migrations = readFileSync(join(srcDir, 'migrations.ts'), 'utf8')
    } catch {
      migrations = ''
    }
    const secretTables = secretBearingTables(migrations)
    // Structural evidence, not a word match: a table column that holds a secret, or a module whose
    // whole job is holding one. Matching the vocabulary against source text would make every
    // repository "key-holding", because `material` is an English word and half the estate's comments
    // use it.
    const vaultModule = files.some((file) => /\/(vault|keyring|keyEnvelope|keys)\.ts$/.test(file))
    if (secretTables.size > 0 || vaultModule) holdsKeyMaterial.push(repo)

    let repoRoutes = 0
    let declaresRouteTable = false

    for (const file of files) {
      // `fatal: true` for the reason ledgeraccounts.ts gives: a lenient decoder substitutes U+FFFD
      // for bytes it cannot read, so a file that is not really UTF-8 parses to something plausible
      // and its routes go unread while the scan reports green.
      const bytes = readFileSync(file)
      let text: string
      const relativeFile = relative(repoRoot, file)
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (err) {
        throw new Error(`${repo}/${relativeFile} is not decodable as UTF-8: ${String(err)}`)
      }
      filesRead += 1
      // The NUL is spelled as an ESCAPE, never as the character itself: a file that contains the
      // byte it tests for cannot pass its own check, and this repository has already shipped that
      // exact defect (e3f32db, a grep rule over files holding raw NUL bytes that grep skipped in
      // silence). This module reproduced it once while being written, which is the best argument
      // for the note.
      const nul = text.indexOf('\u0000')
      if (nul !== -1) {
        throw new Error(`${repo}/${relativeFile} holds a NUL byte at offset ${nul} — it is not the text it appears to be`)
      }
      if (/function\s+buildRoutes|interface\s+Route\b/.test(text)) declaresRouteTable = true

      // Parsed with the ABSOLUTE path, so `modules.resolve` can follow a relative import out of
      // it. The RouteRef carries the repository-relative path, which is what a report must print.
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
      const handlers = collectRoutes(repo, relativeFile, tree)
      if (handlers.length === 0) continue
      repoRoutes += handlers.length
      routes.push(...handlers.map((handler) => handler.route))

      for (const handler of handlers) {
        const context: WalkContext = { modules, secretTables, reaches: [], visited: new Set<string>(), seen: new Set<string>() }
        for (const body of replyBodies(handler.body)) walkValue(context, body, '<body>', 0)
        for (const finding of judge(handler.route, repoRoot, context, acknowledged)) {
          if (finding.severity === 'opaque') opaque.push(finding)
          else findings.push(finding)
        }
      }
    }

    if (repoRoutes === 0) {
      if (declaresRouteTable) {
        unreadable.push({
          service: repo,
          file: 'src/server.ts',
          why: 'declares a route table this analyser read as zero routes — a fourth route spelling',
        })
      }
      continue
    }
    services.push(repo)

    // Read AFTER the routes, because the reconciliation needs both sides. Reconciled against this
    // repository's routes only — a dynamic scan in custody says nothing about identity.
    for (const ref of dynamicScans) {
      if (ref.service !== repo) continue
      dynamicCoverage.push(
        readDynamicCoverage(ref, repoRoot, routes.filter((route) => route.service === repo)),
      )
    }
  }

  return {
    routes,
    findings,
    opaque,
    services,
    unreadable,
    filesRead,
    excluded,
    holdsKeyMaterial,
    acknowledged: [...acknowledged],
    dynamicCoverage,
  }
}


// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

/**
 * A route that legitimately returns something in the vocabulary, named with its reason.
 *
 * A RATCHET, NOT AN EXEMPTION LIST, and the difference is the whole value of it: an acknowledgement
 * that matches nothing in the estate is RED, so a route that is deleted or renamed cannot leave a
 * standing permission behind it. `tools/estate-topic-gaps.json` in micro-org is the same shape and
 * argues the case at length; the short version is that a gate which is red from birth over a
 * deliberate design decision is a gate somebody switches off within the week.
 */
export interface Acknowledgement {
  readonly service: string
  readonly method: string
  readonly path: string
  /** The field name, canonicalised, that this route may return. */
  readonly field: string
  readonly because: string
}

export const ACKNOWLEDGED: readonly Acknowledgement[] = Object.freeze([
  {
    service: 'custody',
    method: 'POST',
    path: '/v1/exports/:id/redeem',
    field: 'material',
    because:
      'THE export ceremony\'s last gate, and the one route in the estate that is supposed to return a ' +
      'private key. custody/src/server.ts — owner-only, after the 24h hold, only with the single-use ' +
      'reveal token, `cache-control: no-store`, and proven end to end by custody/src/bodyscan.test.ts:294. ' +
      'The DoD\'s "no route can return key material" has always had this stated exception; what it must ' +
      'not have is a second one nobody wrote down.',
  },
  {
    service: 'custody',
    method: 'POST',
    path: '/v1/exports/:id/redeem',
    field: 'materialise',
    because:
      'The provenance pass on the same route: `materialise()` (custody/src/exports.ts:408) is the one ' +
      'function in the estate that produces plaintext, and `redeemExport` is its one caller — a fact ' +
      'custody asserts for itself at bodyscan.test.ts:361. Acknowledged SEPARATELY from the field ' +
      'above rather than by exempting the route, because the two passes prove different things: one ' +
      'that the field named `material` is on the wire, one that the value came from the decryptor. A ' +
      'route-level exemption would have silently covered a second, unrelated leak on the same route.',
  },
  {
    service: 'custody',
    method: 'POST',
    path: '/v1/exports/:id/challenge',
    field: 'revealtoken',
    because:
      'custody/src/server.ts:549. The ceremony\'s second gate hands the single-use token to the owner ' +
      'after a fresh MFA assertion; it is the credential for the redeem above and it has to reach the ' +
      'caller somehow. This entry once ALSO carried a sentence about how much of this route custody\'s ' +
      'own dynamic scan reached. It was accurate when written and wrong from `a633986` onward, and ' +
      'nothing here could tell the difference, because it was prose. Whether a suite drives this route ' +
      'is now COMPUTED on every run — see `DYNAMIC_SCANS`, and `unwitnessedAcknowledgements`, which is ' +
      'the rule that sentence became and which this route is the reason for.',
  },
])

/**
 * WHERE A SERVICE PROVES THE SAME PROPERTY DYNAMICALLY, AND HOW THIS FILE READS IT RATHER THAN
 * DESCRIBING IT.
 *
 * The `challenge` acknowledgement above used to end with a sentence of prose about what custody's
 * own body scan did and did not cover. That sentence went stale the moment custody fixed its scan,
 * and it went stale silently, because no check in this estate can read a comment. It is the same rot
 * the estate spent a night clearing — roughly forty stale citations across four repositories, a gap
 * file whose evidence pointed at the wrong remedy, and custody's own comment claiming its test
 * enumerated routes it enumerated by hand.
 *
 * The fix for a fact that rots is not a fresher sentence. It is to stop storing the fact.
 *
 * WHAT IS STORED INSTEAD: a POINTER — the service, the file, and the function whose entries name the
 * routes it drives. `readDynamicCoverage` parses that function out of the AST on every run. The
 * route set it yields is then reconciled, IN BOTH DIRECTIONS, against the routes this analyser
 * independently extracted from that service's `buildRoutes`. Two readers, one source, and a
 * disagreement either way is red.
 *
 * THAT RECONCILIATION IS ALSO THE PARSER'S OWN SELF-CHECK, and it is the part worth defending. A
 * derived number is only better than a written one if a broken derivation is loud. This estate has
 * already shipped a parser that read exactly one registry entry because a draft contained `as const`
 * inside a literal, and reported success. So: a declared dynamic scan whose file is gone, whose
 * function is gone, or whose entries read as ZERO routes THROWS — it is never quietly zero. And
 * short of zero, a parser that dropped a single sample produces an `undriven` route and goes red
 * naming it. The failure mode of this reader is a red run, not a smaller number.
 *
 * WHAT IT DOES NOT PROVE. That the dynamic scan RUNS. This reads source; whether custody's suite
 * executes is custody's CI's business, and custody's SD-16 tests carry `{ skip }` when
 * `CUSTODY_TEST_DATABASE_URL` is unset (`custody/src/testsupport.ts:34`). So a route here is
 * "declared to be driven", never "observed clean" — which is exactly why this cannot be allowed to
 * reduce `BASELINE_BLIND_ROUTES`, and can be allowed to reduce the count of routes nothing watches.
 */
export interface DynamicScanRef {
  readonly service: string
  /** Repository-relative path to the suite that drives the routes. */
  readonly file: string
  /** The function whose object literals enumerate the samples. */
  readonly samples: string
  /** The property on each sample that names the route AS THE SERVER DECLARES IT. */
  readonly declares: string
  readonly because: string
}

export const DYNAMIC_SCANS: readonly DynamicScanRef[] = Object.freeze([
  {
    service: 'custody',
    file: 'src/bodyscan.test.ts',
    samples: 'routeSamples',
    declares: 'route',
    because:
      'The estate\'s only dynamic implementation of `docs/ecosystem/17-definition-of-done.md` §5 item ' +
      '4. It mints a key in every family, reads the plaintext out of its own vault, drives every route ' +
      'in `server.routeTable()` and asserts no body and no header contains any of it. Since a633986 it ' +
      'also reads back `http_requests_total{route=…}`, so a sample that declares one route and drives ' +
      'another leaves the declared route on zero and fails naming it — which is what makes the `route:` ' +
      'string parsed here mean "reached", and not "typed".',
  },
])

/** What a service's own dynamic body scan drives, derived from its source on every run. */
export interface DynamicCoverage {
  readonly service: string
  readonly file: string
  /** `METHOD /path`, as the server declares the path. Sorted. */
  readonly driven: readonly string[]
  /** Routes this analyser extracted that the dynamic scan declares no sample for. RED. */
  readonly undriven: readonly string[]
  /** Samples for routes this analyser did not extract — a rename, or a broken extractor. RED. */
  readonly phantom: readonly string[]
}

/**
 * Parse one dynamic scan's sample list, and reconcile it against what this analyser saw.
 *
 * Throws rather than returning an empty set for every way this could stop measuring anything. See
 * `DYNAMIC_SCANS` for why that severity is the point.
 */
export function readDynamicCoverage(
  ref: DynamicScanRef,
  repoRoot: string,
  extracted: readonly RouteRef[],
): DynamicCoverage {
  const path = join(repoRoot, ref.file)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
  } catch (err) {
    throw new Error(
      `${ref.service}/${ref.file} is declared as a dynamic body scan and could not be read (${String(err)}). ` +
        'Delete the DYNAMIC_SCANS entry or restore the file; a missing witness must never read as zero.',
    )
  }

  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
  const fn = findFunctionIn(tree, ref.samples)
  if (!fn) {
    throw new Error(
      `${ref.service}/${ref.file} declares no function '${ref.samples}()' — the sample list this scan ` +
        'reads its route coverage from has been renamed or removed.',
    )
  }

  // Every object literal under it carrying BOTH a method and the declared route property. Nested
  // literals are walked too: a sample whose `body:` holds an object is not a sample, and is skipped
  // because it has neither property — which is the shape a name match would have got wrong.
  const driven = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const method = propertyValue(node, 'method')
      const route = propertyValue(node, ref.declares)
      const methodText = method ? literalString(unwrap(method)) : null
      const routeText = route ? literalString(unwrap(route)) : null
      if (methodText && routeText) driven.add(`${methodText.toUpperCase()} ${routeText}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)

  if (driven.size === 0) {
    throw new Error(
      `${ref.service}/${ref.file}'s '${ref.samples}()' yielded ZERO routes. Either it drives nothing, ` +
        `or this analyser can no longer read its samples — and a coverage claim that reads as zero ` +
        'must be fatal, never a quietly smaller number.',
    )
  }

  const mine = new Set(extracted.map((route) => `${route.method} ${route.path}`))
  return {
    service: ref.service,
    file: ref.file,
    driven: [...driven].sort(),
    undriven: [...mine].filter((route) => !driven.has(route)).sort(),
    phantom: [...driven].filter((route) => !mine.has(route)).sort(),
  }
}

/**
 * How many routes in a key-holding service this scan may fail to fully read.
 *
 * Today's count, so the FIRST new one has to be looked at. Lowering it is progress — every step
 * down is a route whose response is now accounted for — and raising it is a decision somebody makes
 * on purpose, in this file, with a reason. It is NOT a knob for getting a red run green.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY custody's a633986 DID NOT MOVE THIS NUMBER, WHICH IS THE MORE INTERESTING HALF.
 *
 * Custody now drives all six of its routes that appear in this list, four of them non-probes, with
 * real key material in the vault and exact response-shape assertions. The obvious move is 37 → 33.
 * It would be wrong, for three reasons, and the third is the one that settles it.
 *
 *   1. IT IS NOT WHAT A RUN SAYS. `conformance body-scan --estate ..` still reports 37, because not
 *      one line of custody's SOURCE changed in a way this analyser reads. `deps.lifecycle.livez()`,
 *      `deps.metrics.render()`, `randomBytes(32)` in `exports.ts:349` and the emit callback in
 *      `outbox.ts:91` are exactly as opaque to a static walk as they were yesterday. Setting the
 *      constant to 33 does not record progress; it turns the gate red on the next run and invites
 *      the next person to set it back. The number is a MEASUREMENT, and a measurement is not lowered
 *      by arithmetic on a commit message — including mine.
 *
 *   2. IT WOULD MAKE ONE NUMBER MEAN TWO THINGS. This counts routes THIS ANALYSER cannot fully read.
 *      That is a fact about this analyser's reach, and it is the fact that makes the number useful:
 *      when it rises, someone wrote a body this cannot follow. Subtracting routes because a test in
 *      another repository drives them makes it a blend of two properties, and a reader can no longer
 *      tell which one moved.
 *
 *   3. IT WOULD BREAK THE RATCHET'S OWN RULE, and this is the decisive one. This number may only go
 *      DOWN. If custody's dynamic coverage could lower it, then custody deleting a sample would have
 *      to RAISE it — a ratchet whose value depends on another repository's test file is a ratchet
 *      another repository can force upward. The property that makes this constant trustworthy is
 *      that only work in the estate's route surface, or in this analyser, can move it.
 *
 * The honest thing custody's work earned is a DIFFERENT number, below. The two are printed together
 * so the relationship is visible rather than argued.
 */
export const BASELINE_BLIND_ROUTES = 37

/**
 * Of the routes above, the ones NO check in the estate accounts for — static or dynamic.
 *
 * This is the number that answers the question a reader actually has. `BASELINE_BLIND_ROUTES` says
 * how far this analyser can see; this says how much of the estate's key-holding route surface is
 * watched by NOTHING: a body this cannot read, in a service with a private key to lose, in a service
 * whose own suite does not drive that route either.
 *
 * It is 31 today because custody's six are now driven by `custody/src/bodyscan.test.ts` — verified
 * by a real run, not by subtraction. It is the number custody's a633986 legitimately lowered, and
 * the reason it is a separate constant rather than a discount applied to the one above is written
 * out there.
 *
 * It ratchets the same way and it is the stricter of the two: `identity` holds the key that signs
 * every token in the estate and has no dynamic body scan at all, so all 18 of its blind routes are
 * in here. That is the next thing worth doing, and this constant is where it will show up.
 */
export const BASELINE_BLIND_TO_EVERY_CHECK = 31

function acknowledgementFor(route: RouteRef, field: string): Acknowledgement | undefined {
  return ACKNOWLEDGED.find(
    (entry) =>
      entry.service === route.service &&
      entry.method === route.method &&
      entry.path === route.path &&
      entry.field === canonicalName(field),
  )
}

/** Turn one route's observed reaches into findings, marking any acknowledgement it used. */
function judge(
  route: RouteRef,
  repoRoot: string,
  context: WalkContext,
  used: Set<Acknowledgement>,
): Finding[] {
  const out: Finding[] = []
  // ONE FINDING PER LEAK, not per site the same leak is visible at.
  //
  // `{ privateKey: row.private_key }` fires the name pass twice — once for the field, once for the
  // access — and `body: { k: getSigningKey().privateKey }` fires it once at the access in server.ts
  // and once at the definition in keys.ts. All four are the same key on the same route, and a report
  // that lists them separately makes a reader count findings instead of reading them. The name and
  // provenance passes therefore key on WHAT was found; the shape and row passes, which have no name
  // to key on, key on where.
  const reported = new Set<string>()
  // The finding cites the file the VALUE is in, which is routinely not the file the route is
  // declared in — see `Reach.file`. `declaredAt` keeps the route's own site, so a reader can open
  // both ends of the reach.
  const at = (reach: Reach) => ({
    service: route.service,
    file: relative(repoRoot, reach.file),
    line: reach.line,
    method: route.method,
    path: route.path,
    declaredAt: `${route.file}:${route.line}`,
  })

  for (const reach of context.reaches) {
    const canonical = canonicalName(reach.as)
    const site = `${reach.file}:${reach.line}`

    if (reach.kind === 'field' || reach.kind === 'access' || reach.kind === 'call' || reach.kind === 'producer') {
      const tier: Severity | null = MATERIAL_SET.has(canonical)
        ? 'material'
        : ADJACENT_SET.has(canonical)
          ? 'adjacent'
          : null
      if (tier) {
        const acknowledgement = acknowledgementFor(route, canonical)
        if (acknowledgement) used.add(acknowledgement)
        else if (!reported.has(`name:${canonical}`)) {
          reported.add(`name:${canonical}`)
          out.push({
            ...at(reach),
            severity: tier,
            pass: 'name',
            detail: `response body reaches '${reach.as}' (${tier})`,
            evidence: reach.text,
          })
        }
        continue
      }
    }

    if (reach.kind === 'producer') {
      const acknowledgement = acknowledgementFor(route, canonical)
      if (acknowledgement) {
        used.add(acknowledgement)
      } else if (!reported.has(`prod:${canonical}`)) {
        reported.add(`prod:${canonical}`)
        out.push({
          ...at(reach),
          severity: 'material',
          pass: 'provenance',
          detail: `response body is built from '${reach.as}()', which produces plaintext key material`,
          evidence: reach.text,
        })
      }
      continue
    }

    if (reach.kind === 'literal') {
      for (const shape of KEY_SHAPES) {
        if (shape.pattern.test(reach.text) && !reported.has(site)) {
          reported.add(site)
          out.push({
            ...at(reach),
            severity: 'material',
            pass: 'shape',
            detail: `a literal reaching the response body is a ${shape.name}`,
            evidence: reach.text.slice(0, 40) + '…',
          })
          break
        }
      }
      continue
    }

    if (reach.kind === 'row') {
      // THE SELECT LIST, NEVER THE WHOLE QUERY. identity's refresh rotation reads
      // `select user_id, session_id, … from refresh_tokens where token_hash = \${tokenHash}` — the
      // secret column is in the WHERE clause, which is an argument to the query and not a column it
      // returns. Matching the whole text reported that route as a leak on the first run. What a row
      // carries is exactly what is between `select` and `from`.
      const query = /select\s+([\s\S]*?)\sfrom\s+([a-z0-9_]+)/i.exec(reach.text)
      const selected = query?.[1] ?? ''
      const table = query?.[2]?.toLowerCase()
      const columns = table ? context.secretTables.get(table) : undefined
      const carries = columns && (selected.includes('*') || columns.some((c) => new RegExp(`\\b${c}\\b`).test(selected)))
      if (carries && !reported.has(site)) {
        reported.add(site)
        out.push({
          ...at(reach),
          severity: 'material',
          pass: 'row',
          detail: `a row from '${table}' reaches the response body, and that table holds ${columns.join(', ')}`,
          evidence: reach.text,
        })
      }
      continue
    }

    if (reach.kind === 'opaque') {
      reported.add(site)
      out.push({
        ...at(reach),
        severity: 'opaque',
        pass: 'unresolved',
        reason: reach.reason ?? 'unresolved',
        detail: `the response body reaches '${reach.as}', which this analyser cannot open`,
        evidence: reach.text,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Reconciliation and report
// ---------------------------------------------------------------------------

/** A route in a key-holding service whose body this scan could not fully read. */
export interface BlindRoute {
  readonly service: string
  readonly method: string
  readonly path: string
  readonly reasons: readonly OpaqueReason[]
  /**
   * Whether the service's OWN dynamic body scan declares a sample for this route.
   *
   * Derived from `EstateScan.dynamicCoverage`, never written down. A `true` here does NOT mean the
   * route is clean and does NOT discount it from `BASELINE_BLIND_ROUTES` — it means something else
   * in the estate is looking at it, which is the difference between "this analyser cannot read it"
   * and "nothing anywhere reads it".
   */
  readonly drivenDynamically: boolean
}

export interface BodyScanReport {
  readonly violations: readonly Finding[]
  readonly opaque: readonly Finding[]
  /** Acknowledgements that matched no route — a standing permission for something that is gone. */
  readonly staleAcknowledgements: readonly Acknowledgement[]
  /**
   * THE NUMBER THE GATE IS ON, and the reason it is this one rather than the raw opaque count.
   *
   * The raw count is ~940 and rises every time anybody adds a route, so a budget on it is a budget
   * somebody raises weekly until it means nothing — the exact life cycle this estate keeps
   * rediscovering. This is instead a count of ROUTES, in the services that actually hold key
   * material, where at least one value reaching the body could not be opened AND the reason was not
   * `derived` (a transformation of a field this scan did read and did judge).
   *
   * It is small, it is stable, it is meaningful in one sentence — "there are N routes in custody,
   * identity and devplatform whose response this cannot fully account for" — and every one of them
   * is printed by name. A service that grows a vault joins the numerator automatically.
   */
  readonly blindRoutes: readonly BlindRoute[]
  /**
   * THE STRICTER NUMBER: blind here, and driven by no dynamic scan in their own service either.
   *
   * The subset of `blindRoutes` that nothing in the estate accounts for. See
   * `BASELINE_BLIND_TO_EVERY_CHECK` for why this is a second number rather than a discount on the
   * first.
   */
  readonly blindToEveryCheck: readonly BlindRoute[]
  /**
   * A service's dynamic scan and this analyser disagreeing about that service's route surface.
   *
   * Either the dynamic scan stopped driving a route that exists, or this reader stopped parsing its
   * samples. Both are red, and the message says it is one of the two rather than guessing which.
   */
  readonly coverageMismatches: readonly DynamicCoverage[]
  /**
   * An acknowledged route that NO dynamic scan drives.
   *
   * The rule the stale sentence in the `challenge` acknowledgement became. An acknowledgement is
   * this estate telling the sweep "yes, this route returns key material, on purpose" — a standing
   * permission over the single most dangerous thing a route can do. Permitting that on a route no
   * suite anywhere actually drives means the ONLY account of what the route returns is the
   * acknowledgement's own prose, which is exactly the thing that rotted.
   *
   * So: you may acknowledge a route, and you may not acknowledge one nothing witnesses. On
   * `a633986`'s parent commit this was red for `POST /v1/exports/:id/challenge`, which is the whole
   * argument for it.
   */
  readonly unwitnessedAcknowledgements: readonly Acknowledgement[]
  readonly ok: boolean
}

export function reconcileBodyScan(
  scan: EstateScan,
  options: { readonly maxBlindRoutes?: number; readonly maxBlindToEveryCheck?: number } = {},
): BodyScanReport {
  const maxBlindRoutes = options.maxBlindRoutes ?? BASELINE_BLIND_ROUTES
  const maxBlindToEveryCheck = options.maxBlindToEveryCheck ?? BASELINE_BLIND_TO_EVERY_CHECK
  const used = new Set(scan.acknowledged)
  const stale = ACKNOWLEDGED.filter((entry) => !used.has(entry))

  const drivenBy = new Map<string, Set<string>>()
  for (const coverage of scan.dynamicCoverage) drivenBy.set(coverage.service, new Set(coverage.driven))
  const isDriven = (service: string, method: string, path: string): boolean =>
    drivenBy.get(service)?.has(`${method} ${path}`) ?? false

  const blind = new Map<string, BlindRoute>()
  for (const finding of scan.opaque) {
    if (!scan.holdsKeyMaterial.includes(finding.service)) continue
    if (finding.reason === 'derived') continue
    const key = `${finding.service} ${finding.method} ${finding.path}`
    const existing = blind.get(key)
    const reason = finding.reason ?? 'unresolved'
    if (existing) {
      if (!existing.reasons.includes(reason)) {
        blind.set(key, { ...existing, reasons: [...existing.reasons, reason] })
      }
      continue
    }
    blind.set(key, {
      service: finding.service,
      method: finding.method,
      path: finding.path,
      reasons: [reason],
      drivenDynamically: isDriven(finding.service, finding.method, finding.path),
    })
  }
  const blindRoutes = [...blind.values()]
  const blindToEveryCheck = blindRoutes.filter((route) => !route.drivenDynamically)

  const coverageMismatches = scan.dynamicCoverage.filter(
    (coverage) => coverage.undriven.length > 0 || coverage.phantom.length > 0,
  )

  // Only for services this run actually read. A checkout without custody in it must fail on the
  // partial-estate refusal, not by reporting custody's acknowledgements unwitnessed — a true
  // sentence about the wrong problem sends the reader to the wrong file.
  const unwitnessedAcknowledgements = ACKNOWLEDGED.filter(
    (entry) => scan.services.includes(entry.service) && !isDriven(entry.service, entry.method, entry.path),
  )

  return {
    violations: scan.findings,
    opaque: scan.opaque,
    staleAcknowledgements: stale,
    blindRoutes,
    blindToEveryCheck,
    coverageMismatches,
    unwitnessedAcknowledgements,
    ok:
      scan.findings.length === 0 &&
      scan.unreadable.length === 0 &&
      stale.length === 0 &&
      coverageMismatches.length === 0 &&
      unwitnessedAcknowledgements.length === 0 &&
      blindRoutes.length <= maxBlindRoutes &&
      blindToEveryCheck.length <= maxBlindToEveryCheck,
  }
}

/**
 * The report a human reads, and the one CI prints.
 *
 * THE BLIND SPOT IS PART OF THE REPORT, NOT A FOOTNOTE TO IT. A body scan that prints "no route
 * returns key material" and nothing else invites exactly the belief this module exists to prevent —
 * that the class is closed. So every run prints, above the verdict, how much of the route surface it
 * could actually read, broken down by why it could not read the rest.
 */
function keyHoldingRoutes(scan: EstateScan): number {
  return scan.routes.filter((route) => scan.holdsKeyMaterial.includes(route.service)).length
}

export function formatBodyScan(report: BodyScanReport, scan: EstateScan): string {
  const lines: string[] = []
  lines.push(
    `scanned ${scan.services.length} servers, ${scan.filesRead} files, ${scan.routes.length} routes`,
  )
  lines.push(`  ${scan.services.join(' ')}`)
  if (scan.excluded.length > 0) lines.push(`  not read: ${scan.excluded.join(' ')}`)
  lines.push('')

  for (const entry of scan.unreadable) {
    lines.push(
      `UNREADABLE    ${entry.service}/${entry.file} — ${entry.why}` +
        '\n    Every route in that table is a route this scan did not judge and did not say so.',
    )
  }

  if (report.violations.length === 0) {
    lines.push('no route returns a value this scan can identify as private key material')
  }
  for (const finding of report.violations) {
    lines.push(
      `${finding.severity === 'material' ? 'LEAK    ' : 'ADJACENT'}      ${finding.method} ${finding.path}  (${finding.pass})` +
        `\n    route      ${finding.service}/${finding.declaredAt}` +
        `\n    value      ${finding.service}/${finding.file}:${finding.line}` +
        `\n    ${finding.detail}` +
        `\n    ${finding.evidence}`,
    )
  }

  for (const entry of report.staleAcknowledgements) {
    lines.push(
      `STALE         ${entry.service} ${entry.method} ${entry.path} is acknowledged to return '${entry.field}', ` +
        'and nothing in this checkout does.' +
        '\n    A standing permission for something that is gone, or a route this scan stopped reading.' +
        '\n    Delete the acknowledgement, or find out which of the two it is.',
    )
  }

  for (const entry of report.unwitnessedAcknowledgements) {
    lines.push(
      `UNWITNESSED   ${entry.service} ${entry.method} ${entry.path} is acknowledged to return '${entry.field}', ` +
        'and no dynamic scan in that service drives it.' +
        '\n    A standing permission to return key material, on a route nothing actually exercises: the' +
        '\n    only account of what it returns is the acknowledgement\'s own prose. Drive the route in' +
        `\n    ${entry.service}'s suite, or withdraw the acknowledgement.`,
    )
  }

  for (const coverage of report.coverageMismatches) {
    lines.push(
      `COVERAGE      ${coverage.service}/${coverage.file} and this analyser disagree about ${coverage.service}'s routes.` +
        '\n    Either that scan stopped driving a route that exists, or this stopped reading its samples.' +
        (coverage.undriven.length > 0
          ? `\n    driven by nothing: ${coverage.undriven.join(', ')}`
          : '') +
        (coverage.phantom.length > 0
          ? `\n    a sample for a route this scan does not see: ${coverage.phantom.join(', ')}`
          : ''),
    )
  }

  lines.push('')
  lines.push(`WHAT THIS RUN COULD NOT READ — ${report.opaque.length} response-body reaches over ${scan.routes.length} routes`)
  const byReason = new Map<string, Finding[]>()
  for (const finding of report.opaque) {
    const reason = finding.reason ?? 'unresolved'
    const bucket = byReason.get(reason)
    if (bucket) bucket.push(finding)
    else byReason.set(reason, [finding])
  }
  for (const [reason, group] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    const services = [...new Set(group.map((f) => f.service))].sort()
    lines.push(`  ${reason.padEnd(13)} ${String(group.length).padStart(4)}   ${services.join(' ')}`)
  }
  lines.push('')
  lines.push(
    `THE GATE IS ON THIS NUMBER — ${report.blindRoutes.length} of the ${keyHoldingRoutes(scan)} routes in the ${scan.holdsKeyMaterial.length} services` +
      `\n  that HOLD key material (${scan.holdsKeyMaterial.join(' ')}) have a response this scan` +
      '\n  cannot fully account for. A `derived` reach does not count — the field it transforms was' +
      '\n  read and judged. Everything else does, because a value this cannot open in a service with' +
      '\n  a private key to lose is precisely the hole a green run would otherwise hide.',
  )
  for (const route of report.blindRoutes) {
    const witness = route.drivenDynamically ? '  ← driven dynamically' : ''
    lines.push(`  ${route.service}  ${route.method} ${route.path}  [${route.reasons.join(' ')}]${witness}`)
    for (const finding of report.opaque) {
      if (finding.service !== route.service || finding.method !== route.method) continue
      if (finding.path !== route.path || finding.reason === 'derived') continue
      lines.push(`      ${finding.file}:${finding.line}  ${finding.evidence}`)
    }
  }

  // THE SECOND GATE, AND THE RELATIONSHIP BETWEEN THE TWO CHECKS, PRINTED RATHER THAN ARGUED.
  //
  // A reader who sees only the number above will ask the obvious question — "custody drives all six
  // of those now, why is it still 37?" — and the answer has to be in the output, not in a commit
  // message they will not read. So both numbers are printed, adjacent, with what separates them.
  lines.push('')
  lines.push(
    `AND THE STRICTER ONE — ${report.blindToEveryCheck.length} of those ${report.blindRoutes.length} are watched by NOTHING` +
      '\n  A route counts above when THIS analyser cannot read its body. It counts here when its own' +
      '\n  service does not drive it dynamically either. The two are separate on purpose: a dynamic' +
      '\n  test in another repository proves a different thing (real bytes, real responses, the' +
      '\n  requests somebody wrote) and cannot be allowed to discount a static blind spot, or a' +
      '\n  ratchet that may only fall would rise the day that repository deleted a sample.',
  )
  for (const coverage of scan.dynamicCoverage) {
    lines.push(`  ${coverage.service}/${coverage.file} drives ${coverage.driven.length} routes, derived from its source on this run`)
  }
  if (scan.dynamicCoverage.length === 0) lines.push('  no service in this checkout declares a dynamic body scan')
  const unwatched = new Map<string, number>()
  for (const route of report.blindToEveryCheck) unwatched.set(route.service, (unwatched.get(route.service) ?? 0) + 1)
  for (const [service, count] of [...unwatched].sort((a, b) => b[1] - a[1])) {
    const has = scan.dynamicCoverage.some((coverage) => coverage.service === service)
    lines.push(`  ${String(count).padStart(3)}  ${service}${has ? '' : '   (no dynamic body scan at all)'}`)
  }
  return lines.join('\n')
}
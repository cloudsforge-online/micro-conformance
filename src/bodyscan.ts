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
 *     it cannot resolve — a package import, a dynamic dispatch, a value threaded through a
 *     parameter — is recorded as an OPAQUE reach: named, counted, budgeted, and never silently
 *     dropped. `MAX_OPAQUE` is what stops the blind spot growing while the check still says green.
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
  readonly kind: 'field' | 'access' | 'call' | 'literal' | 'row' | 'opaque'
  readonly line: number
  /** The source text, one line, trimmed. */
  readonly text: string
}

export type Severity = 'material' | 'adjacent' | 'opaque'

export interface Finding {
  readonly service: string
  readonly file: string
  readonly line: number
  readonly method: string
  readonly path: string
  readonly severity: Severity
  /** Which pass fired: the field's name, the value's provenance, or the literal's shape. */
  readonly pass: 'name' | 'provenance' | 'shape' | 'row' | 'unresolved'
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
class RepoModules {
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

/** `create table x ( … secret_enc text … )` per repository, reduced to the tables that hold one. */
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
      (name) => MATERIAL_SET.has(canonicalName(name)) || ADJACENT_SET.has(canonicalName(name)),
    )
    if (secret.length > 0) tables.set(table, secret)
  }
  return tables
}

interface WalkContext {
  readonly modules: RepoModules
  readonly secretTables: ReadonlyMap<string, readonly string[]>
  readonly reaches: Reach[]
  readonly visited: Set<ts.Node>
}

const MAX_DEPTH = 6

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
function walkValue(context: WalkContext, node: ts.Expression, label: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    context.reaches.push({ as: label, kind: 'opaque', line: lineOf(node), text: `depth limit: ${textOf(node)}` })
    return
  }
  const expression = unwrap(node)
  if (context.visited.has(expression)) return
  context.visited.add(expression)

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        walkValue(context, property.expression, `…${label}`, depth + 1)
        continue
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const name = property.name.text
        context.reaches.push({ as: name, kind: 'field', line: lineOf(property), text: textOf(property) })
        const bound = nearestBinding(property, name)
        if (bound) walkValue(context, bound, name, depth + 1)
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '<computed>'
      context.reaches.push({ as: name, kind: 'field', line: lineOf(property), text: textOf(property) })
      walkValue(context, property.initializer, name, depth + 1)
    }
    return
  }

  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) walkValue(context, element.expression, label, depth + 1)
      else walkValue(context, element, label, depth + 1)
    }
    return
  }

  if (ts.isConditionalExpression(expression)) {
    walkValue(context, expression.whenTrue, label, depth + 1)
    walkValue(context, expression.whenFalse, label, depth + 1)
    return
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      walkValue(context, expression.left, label, depth + 1)
      walkValue(context, expression.right, label, depth + 1)
      return
    }
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression)) {
    context.reaches.push({ as: label, kind: 'literal', line: lineOf(expression), text: textOf(expression) })
    return
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    // `sql`select … from custody_keys``. The table, not the value, is what can be judged.
    context.reaches.push({ as: label, kind: 'row', line: lineOf(expression), text: textOf(expression) })
    return
  }

  if (ts.isPropertyAccessExpression(expression)) {
    context.reaches.push({
      as: expression.name.text,
      kind: 'access',
      line: lineOf(expression),
      text: textOf(expression),
    })
    walkValue(context, expression.expression, label, depth + 1)
    return
  }

  if (ts.isElementAccessExpression(expression)) {
    const index = literalString(expression.argumentExpression)
    if (index !== null) {
      context.reaches.push({ as: index, kind: 'access', line: lineOf(expression), text: textOf(expression) })
    }
    walkValue(context, expression.expression, label, depth + 1)
    return
  }

  if (ts.isCallExpression(expression)) {
    const { name, receiver } = calleeName(expression.expression)
    context.reaches.push({ as: name, kind: 'call', line: lineOf(expression), text: textOf(expression) })
    if (
      PRODUCER_SET.has(canonicalName(name)) ||
      RECEIVER_PRODUCERS.some(([r, m]) => canonicalName(receiver).includes(r) && canonicalName(name) === m)
    ) {
      return
    }
    // `rows.map(toRecord)` and `rows.map((row) => ({ … }))` — the element shape is the body shape.
    //
    // THE RECEIVER IS DELIBERATELY NOT FOLLOWED. `rows.map(toKeyRecord)` puts the PROJECTION on the
    // wire, not the row, and the whole point of a projection is that the columns it leaves out do
    // not travel. Following `rows` as well made the first run against the estate report three
    // `select *` rows as leaks when what reached the body was nine named fields — and a check whose
    // first three findings are wrong is a check nobody reads the fourth finding of. A callback this
    // cannot resolve is still an OPAQUE reach, so a projection through an unreadable function is
    // counted rather than assumed clean.
    if (canonicalName(name) === 'map' || canonicalName(name) === 'flatmap') {
      for (const argument of expression.arguments) {
        const callback = unwrap(argument)
        if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
          for (const returned of returnedExpressions(callback)) walkValue(context, returned, label, depth + 1)
        } else if (ts.isIdentifier(callback)) {
          const fn = resolveFunction(context, expression, callback.text)
          if (fn) for (const returned of returnedExpressions(fn)) walkValue(context, returned, label, depth + 1)
          else context.reaches.push({ as: callback.text, kind: 'opaque', line: lineOf(expression), text: textOf(expression) })
        }
      }
      return
    }
    const fn = resolveFunction(context, expression, name)
    if (fn) {
      for (const returned of returnedExpressions(fn)) walkValue(context, returned, label, depth + 1)
      return
    }
    // A call this analyser cannot open. Named and counted — never dropped.
    context.reaches.push({ as: name || '<anonymous call>', kind: 'opaque', line: lineOf(expression), text: textOf(expression) })
    return
  }

  if (ts.isIdentifier(expression)) {
    const bound = nearestBinding(expression, expression.text)
    if (bound && bound !== expression) {
      walkValue(context, bound, expression.text, depth + 1)
      return
    }
    const fn = resolveFunction(context, expression, expression.text)
    if (fn) {
      for (const returned of returnedExpressions(fn)) walkValue(context, returned, label, depth + 1)
      return
    }
    context.reaches.push({ as: expression.text, kind: 'opaque', line: lineOf(expression), text: textOf(expression) })
    return
  }

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    for (const returned of returnedExpressions(expression)) walkValue(context, returned, label, depth + 1)
    return
  }

  if (
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isNewExpression(expression)
  ) {
    return
  }

  context.reaches.push({ as: label, kind: 'opaque', line: lineOf(expression), text: textOf(expression) })
}

/**
 * Every `body:`/`text:` expression a handler can reply with.
 *
 * A reply is an object literal carrying `status` and at least one of `body`/`text` — the estate's
 * `Reply` interface, which twenty-nine `server.ts` files declare identically. Returns at every
 * depth inside the handler are collected, including inside `sql.begin(async () => …)` and
 * `.then(…)`, because a reply built in a nested closure is still the reply.
 */
function replyBodies(handler: ts.Node): ts.Expression[] {
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
  /**
   * The acknowledgements that actually matched something. Carried on the RESULT rather than kept in
   * a module-level set, so scanning two estates in one process cannot make the second one's stale
   * acknowledgements look used by the first — which is a green produced by state, not by evidence.
   */
  readonly acknowledged: readonly Acknowledgement[]
}

export interface ScanOptions {
  readonly estateDir: string
  /** Defaults to this harness, which holds the vocabulary and would report itself. */
  readonly exclude?: readonly string[]
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
  const routes: RouteRef[] = []
  const findings: Finding[] = []
  const opaque: Finding[] = []
  const services: string[] = []
  const unreadable: UnreadableRoutes[] = []
  const acknowledged = new Set<Acknowledgement>()
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
        const context: WalkContext = { modules, secretTables, reaches: [], visited: new Set<ts.Node>() }
        for (const body of replyBodies(handler.body)) walkValue(context, body, '<body>', 0)
        for (const finding of judge(handler.route, context, acknowledged)) {
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
  }

  return { routes, findings, opaque, services, unreadable, filesRead, acknowledged: [...acknowledged] }
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
    field: 'derivationpath',
    because:
      'custody/src/exports.ts:450 argues this one explicitly: the derivation path is omitted from the ' +
      'EVENT and returned in the RESPONSE, "because the user restoring a phrase needs it — a response ' +
      'goes to one authenticated user, an event goes to subscribers". Same request, same gates as the ' +
      'material beside it.',
  },
  {
    service: 'custody',
    method: 'POST',
    path: '/v1/exports/:id/challenge',
    field: 'revealtoken',
    because:
      'custody/src/server.ts:549. The ceremony\'s second gate hands the single-use token to the owner ' +
      'after a fresh MFA assertion; it is the credential for the redeem above and it has to reach the ' +
      'caller somehow. Note that custody\'s own dynamic scan does NOT cover this route — see ' +
      'FINDINGS.md and the report — so this static acknowledgement is currently the only thing in the ' +
      'estate that records the route returns it at all.',
  },
])

/** How many response-body reaches the analyser may fail to resolve before the sweep fails. */
export const BASELINE_OPAQUE = 0

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
function judge(route: RouteRef, context: WalkContext, used: Set<Acknowledgement>): Finding[] {
  const out: Finding[] = []
  const at = (reach: Reach) => ({ service: route.service, file: route.file, line: reach.line, method: route.method, path: route.path })

  for (const reach of context.reaches) {
    const canonical = canonicalName(reach.as)

    if (reach.kind === 'field' || reach.kind === 'access' || reach.kind === 'call') {
      const tier: Severity | null = MATERIAL_SET.has(canonical)
        ? 'material'
        : ADJACENT_SET.has(canonical)
          ? 'adjacent'
          : null
      if (tier) {
        const acknowledgement = acknowledgementFor(route, canonical)
        if (acknowledgement) used.add(acknowledgement)
        else {
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

    if (reach.kind === 'call') {
      if (PRODUCER_SET.has(canonical)) {
        const acknowledgement = acknowledgementFor(route, canonical)
        if (acknowledgement) used.add(acknowledgement)
        else {
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
    }

    if (reach.kind === 'literal') {
      for (const shape of KEY_SHAPES) {
        if (shape.pattern.test(reach.text)) {
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
      const table = /from\s+([a-z0-9_]+)/i.exec(reach.text)?.[1]?.toLowerCase()
      const columns = table ? context.secretTables.get(table) : undefined
      if (columns && (reach.text.includes('*') || columns.some((c) => reach.text.includes(c)))) {
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
      out.push({
        ...at(reach),
        severity: 'opaque',
        pass: 'unresolved',
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

export interface BodyScanReport {
  readonly violations: readonly Finding[]
  readonly opaque: readonly Finding[]
  /** Acknowledgements that matched no route — a standing permission for something that is gone. */
  readonly staleAcknowledgements: readonly Acknowledgement[]
  readonly ok: boolean
}

export function reconcileBodyScan(
  scan: EstateScan,
  options: { readonly maxOpaque?: number } = {},
): BodyScanReport {
  const maxOpaque = options.maxOpaque ?? BASELINE_OPAQUE
  const used = new Set(scan.acknowledged)
  const stale = ACKNOWLEDGED.filter((entry) => !used.has(entry))
  return {
    violations: scan.findings,
    opaque: scan.opaque,
    staleAcknowledgements: stale,
    ok:
      scan.findings.length === 0 &&
      scan.unreadable.length === 0 &&
      stale.length === 0 &&
      scan.opaque.length <= maxOpaque,
  }
}

export function formatBodyScan(report: BodyScanReport, scan: EstateScan): string {
  const lines: string[] = []
  lines.push(
    `scanned ${scan.services.length} servers, ${scan.filesRead} files, ${scan.routes.length} routes`,
  )
  lines.push(`  ${scan.services.join(' ')}`)
  lines.push('')

  for (const entry of scan.unreadable) {
    lines.push(`UNREADABLE    ${entry.service}/${entry.file} — ${entry.why}`)
  }

  if (report.violations.length === 0) {
    lines.push('no route returns a value this scan can identify as private key material')
  }
  for (const finding of report.violations) {
    lines.push(
      `${finding.severity === 'material' ? 'LEAK' : 'ADJACENT'}          ${finding.method} ${finding.path}  (${finding.pass})` +
        `\n    ${finding.service}/${finding.file}:${finding.line}` +
        `\n    ${finding.detail}` +
        `\n    ${finding.evidence}`,
    )
  }

  for (const entry of report.staleAcknowledgements) {
    lines.push(
      `STALE         ${entry.service} ${entry.method} ${entry.path} may return '${entry.field}', and no such ` +
        'route exists in this checkout. A standing permission for something that is gone.',
    )
  }

  lines.push('')
  lines.push(`${report.opaque.length} response-body reaches this analyser could not open:`)
  for (const finding of report.opaque) {
    lines.push(`    ${finding.service}/${finding.file}:${finding.line}  ${finding.method} ${finding.path}  ${finding.evidence}`)
  }
  return lines.join('\n')
}

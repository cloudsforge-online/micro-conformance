/**
 * The estate-wide reconciliation of LEDGER ACCOUNT TYPES.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS EXISTS TO CATCH, AND WHY NOTHING ELSE COULD
 *
 * `micro-ledger` keys an account on `(subject, asset_code, purpose)` and **nothing else** — not the
 * type. `ensureAccount` therefore has to decide what to do when a caller names an existing account
 * with a different `type`, and it THROWS (`ledger/src/accounts.ts:125`, `AccountConflictError`):
 * continuing "would post a debit in the direction the caller expected rather than the direction
 * the account actually normalises to — a wrong balance that still balances".
 *
 * Every service chooses that `type` independently, in its own source, when it first posts. If two
 * services disagree, whichever posts SECOND in production has **every** entry refused — not one
 * entry, every entry, for as long as the disagreement stands.
 *
 * No suite in the estate can see it. Each service tests against its own fake ledger, so nothing in
 * CI has ever put two real services against one real ledger. Three instances have been found so
 * far, and all three were found by a human reading a second repository for an unrelated reason:
 *
 *   * `micro-worlds` debited `(platform, SHARD, fees)` as `expense` (fixed, worlds@cc8f594)
 *   * `micro-emberkin` debited the same key as `expense` (fixed)
 *   * `micro-settlement` debited `(platform, <asset>, fees)` as `expense` (fixed)
 *
 * ...against `revenue` in `micro-billing`, `micro-market`, `micro-mint`, `micro-trade`,
 * `micro-wallet` and `micro-foresight`. "Found incidentally, three times" is not a search.
 *
 * This module is the search: it parses every service's TypeScript, extracts every account it names
 * along with the type it claims, and reports every pair that cannot both be right.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT CANNOT SEE. Stated here rather than in a footnote, because a sweep whose limits are not
 * written down is a sweep people believe things about that are not true, and this repository has
 * already shipped one check defeated by exactly that (a grep rule reading files with raw NUL bytes,
 * which `grep` skipped in silence — e3f32db).
 *
 *   * **Anything not written as an object literal in TypeScript source.** A service that builds an
 *     account from a database row, a config file or an HTTP body names a key this cannot read. Such
 *     a site still appears — as an `unresolved` claim naming the file and line — but its key is a
 *     wildcard and its disagreements cannot be computed. `unresolved` is REPORTED AND COUNTED, never
 *     dropped, and `reconcileAccountClaims` fails when the count exceeds the caller's budget.
 *   * **Anything outside the checkout.** It reads sibling directories on disk. A repository that is
 *     not cloned is invisible, so `sweepEstate` returns the list of repositories it actually read
 *     and the caller must assert that list rather than trust it.
 *   * **Types decided at runtime.** `type: someCondition ? 'revenue' : 'expense'` resolves to a
 *     wildcard type, which is treated as disagreeing with everything — noisy on purpose, because
 *     the alternative is silence.
 *   * **The ledger's own state.** It compares SOURCE against SOURCE. An account row already written
 *     in production with the wrong type is not visible here; that is reconciliation's job.
 *   * **Whether the canonical type is right.** `CANONICAL_ACCOUNTS` is a claim about the chart, not
 *     a proof of it. Its justification is in the table, sourced to `micro-ledger`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/** The ledger's closed `accounts_type_chk` vocabulary (ledger/src/migrations.ts). */
export const ACCOUNT_TYPES = ['liability', 'asset', 'revenue', 'expense', 'equity', 'clearing'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

/** The ledger's closed `accounts_purpose_chk` vocabulary. */
export const ACCOUNT_PURPOSES = [
  'available',
  'reserved',
  'escrow',
  'treasury',
  'fees',
  'payout_due',
  'suspense',
] as const
export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number]

/**
 * A subject reduced to the kind `parseAccountSubject` would give it.
 *
 * The comparison is on the KIND, not the raw string, and that is what keeps the sweep usable: a
 * `user:` subject is always a variable in source, so comparing raw strings would make every user
 * account a wildcard that collides with `custody` and `platform` and drown the real findings. Two
 * different users' accounts can never be the same account, and `parseAccountSubject` is the
 * estate's own function for saying so.
 */
export type SubjectKind =
  | 'platform'
  | 'custody'
  | 'clearing'
  | 'engagement-treasury'
  | 'user'
  | 'community'
  | 'organisation'
  | 'engagement'
  | 'chain'
  /** Could not be resolved from source. Matches everything, and is counted as unresolved. */
  | '*'

/** One account named in one place in one service's source, with the type that place claims. */
export interface AccountClaim {
  readonly service: string
  /** Repository-relative, so a finding can be opened. */
  readonly file: string
  readonly line: number
  readonly subject: SubjectKind
  /** The literal subject when source had one — `platform`, `engagement:worlds`. */
  readonly subjectText: string | null
  /** `*` when the asset is a variable. A wildcard asset can be any asset, so it collides with all. */
  readonly assetCode: string
  readonly purpose: AccountPurpose | '*'
  readonly type: AccountType | '*'
  /** True when any of the four could not be resolved. */
  readonly unresolved: boolean
  /** The source text, trimmed to one line, so a report can show what it read. */
  readonly text: string
}

/**
 * The chart, as `micro-ledger` states it — the answer to "which of the two disagreeing services is
 * right", which a majority vote cannot give.
 *
 * `ledger/src/accounts.ts:14-17`, on why the ledger refuses to infer the type itself: "`platform`
 * is revenue under `fees`, equity under `treasury` and expense under `payout_due`, and a rule that
 * guesses would be wrong for two of the three." That sentence is the chart for the `platform`
 * subject, written by the service that owns the chart. The rest follows `normalBalance`
 * (`contracts/packages/money/src/index.ts`) and the reconciliation invariant in
 * `ledger/src/reconcile.ts`: Σ user liabilities = Σ custody assets, per asset.
 */
export interface CanonicalAccount {
  readonly subject: SubjectKind
  readonly purpose: AccountPurpose
  readonly type: AccountType
  readonly because: string
}

export const CANONICAL_ACCOUNTS: readonly CanonicalAccount[] = Object.freeze([
  {
    subject: 'platform',
    purpose: 'fees',
    type: 'revenue',
    because:
      'ledger/src/accounts.ts:16 — "`platform` is revenue under `fees`". Credit-normal, which is the ' +
      'direction billing, market, mint, trade, wallet and foresight all credit fee income in.',
  },
  {
    subject: 'platform',
    purpose: 'treasury',
    type: 'equity',
    because: 'ledger/src/accounts.ts:16 — "equity under `treasury`". The platform\'s own money.',
  },
  {
    subject: 'platform',
    purpose: 'payout_due',
    type: 'expense',
    because:
      'ledger/src/accounts.ts:17 — "expense under `payout_due`". The chart\'s only expense slot for ' +
      'the platform subject, and debit-normal, so a spend can never drive it below zero into ' +
      'ledger_assert_no_overdraft.',
  },
  {
    subject: 'engagement-treasury',
    purpose: 'treasury',
    type: 'equity',
    because:
      'contracts/packages/money/src/index.ts, `engagementAccount` — the programme is the platform\'s ' +
      'own money earmarked. `equity` is NOT overdraft-exempt, so an unfunded programme refuses a grant.',
  },
  {
    subject: 'engagement',
    purpose: 'treasury',
    type: 'equity',
    because: 'contracts/packages/money/src/index.ts, `engagementAccount` — one per funded service, same reason.',
  },
  {
    subject: 'custody',
    purpose: 'available',
    type: 'asset',
    because:
      'ledger/src/reconcile.ts — Σ custody ASSET accounts is one half of the invariant the platform ' +
      'rests on. Debit-normal: coin arriving in a custody wallet is a debit to custody.',
  },
  {
    subject: 'custody',
    purpose: 'treasury',
    type: 'asset',
    because: 'Same pool, same type. reconcile.ts sums custody `asset` accounts across purposes.',
  },
  {
    subject: 'user',
    purpose: 'available',
    type: 'liability',
    because:
      'contracts/packages/money/src/index.ts, `normalBalance` — a user balance is money we owe them. ' +
      'The other half of the reconciliation invariant.',
  },
  { subject: 'user', purpose: 'reserved', type: 'liability', because: 'A reservation is still owed to the user.' },
  { subject: 'user', purpose: 'payout_due', type: 'liability', because: 'Proceeds owed to a seller are owed.' },
  { subject: 'user', purpose: 'escrow', type: 'liability', because: 'Escrowed value is still owed to somebody.' },
  {
    subject: 'community',
    purpose: 'treasury',
    type: 'liability',
    because: 'community/src/ledgerclient.ts — a community treasury is money held FOR the community.',
  },
  {
    subject: 'community',
    purpose: 'available',
    type: 'liability',
    because: 'Same subject, same reason.',
  },
  {
    subject: 'clearing',
    purpose: 'suspense',
    type: 'clearing',
    because:
      'contracts `normalBalance` — value in transit, owed onwards. The ledger\'s overdraft trigger ' +
      'exempts type `clearing`, which is what lets it sit either side of zero within a period.',
  },
  {
    subject: 'clearing',
    purpose: 'available',
    type: 'clearing',
    because: 'Same subject, same reason.',
  },
  {
    subject: 'chain',
    purpose: 'suspense',
    type: 'clearing',
    because:
      'foresight/src/ledgerclient.ts — bookkeeping about somebody else\'s ledger. A chain position ' +
      'nets out and is reconciliation\'s business, not a constraint\'s.',
  },
])

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Thrown when a source file cannot be read as text. NEVER skipped — see the header. */
export class UnreadableSourceError extends Error {
  readonly file: string
  constructor(file: string, why: string) {
    super(`${file} could not be read as UTF-8 source: ${why}`)
    this.name = 'UnreadableSourceError'
    this.file = file
  }
}

const SINGLETON_KINDS: Readonly<Record<string, SubjectKind>> = Object.freeze({
  platform: 'platform',
  custody: 'custody',
  clearing: 'clearing',
  'platform:engagement-treasury': 'engagement-treasury',
})

const PREFIX_KINDS: Readonly<Record<string, SubjectKind>> = Object.freeze({
  user: 'user',
  community: 'community',
  organisation: 'organisation',
  engagement: 'engagement',
  chain: 'chain',
})

/**
 * The contracts-money helpers that MAKE a subject. Resolving these is what keeps a service that did
 * the right thing — spelled its subject through the shared helper rather than by hand — from
 * looking less resolvable than one that hard-coded a string.
 */
const SUBJECT_FACTORIES: Readonly<Record<string, SubjectKind>> = Object.freeze({
  userSubject: 'user',
  communitySubject: 'community',
  organisationSubject: 'organisation',
  engagementSubject: 'engagement',
  engagementAccount: 'engagement',
  chainSubject: 'chain',
})

export function subjectKindOf(text: string): SubjectKind {
  const singleton = SINGLETON_KINDS[text]
  if (singleton) return singleton
  const separator = text.indexOf(':')
  if (separator === -1) return '*'
  const prefix = PREFIX_KINDS[text.slice(0, separator)]
  return prefix ?? '*'
}

/** The literal string an expression is, or null when it is not statically one. */
function literalString(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/**
 * The subject kind an expression names.
 *
 * Handles the four spellings the estate actually uses: a literal (`'platform'`), a template with a
 * literal head (`` `user:${id}` ``), a call to a contracts-money factory
 * (`engagementAccount('worlds', 'SHARD').subject`), and anything else — which is `*`.
 */
export function resolveSubject(
  node: ts.Expression,
  /**
   * Resolves a name to the nearest enclosing `const` initialiser, so a subject lifted into a named
   * constant — the spelling the estate's better files use — reads as well as one written inline.
   * Without it `micro-trade`'s `const subject = userSubject(input.userId)` is unresolved, and the
   * sweep would be blindest exactly where the code is tidiest.
   */
  lookup: (name: string) => ts.Expression | null = () => null,
  depth = 0,
): { kind: SubjectKind; text: string | null } {
  const literal = literalString(node)
  if (literal !== null) return { kind: subjectKindOf(literal), text: literal }

  if (ts.isIdentifier(node) && depth < 4) {
    const bound = lookup(node.text)
    if (bound && bound !== node) return resolveSubject(bound, lookup, depth + 1)
  }

  if (ts.isTemplateExpression(node)) {
    const head = node.head.text
    const separator = head.indexOf(':')
    if (separator > 0) {
      const prefix = PREFIX_KINDS[head.slice(0, separator)]
      if (prefix) return { kind: prefix, text: null }
    }
    return { kind: '*', text: null }
  }

  // `engagementAccount('worlds', 'SHARD').subject` and `userSubject(id)`.
  let call: ts.Expression = node
  if (ts.isPropertyAccessExpression(call) && call.name.text === 'subject') call = call.expression
  if (ts.isCallExpression(call)) {
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression
    if (ts.isIdentifier(callee)) {
      const kind = SUBJECT_FACTORIES[callee.text]
      if (kind) return { kind, text: null }
    }
  }

  return { kind: '*', text: null }
}

function propertyValue(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of literal.properties) {
    // `{ subject }` is a ShorthandPropertyAssignment, not a PropertyAssignment, and micro-trade
    // writes its wallet accounts that way. Treating shorthand as absent made the tidiest call site
    // in the estate the least visible one.
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

/**
 * Every account this source names.
 *
 * The AST, not a regex, and that is the whole difference between a sweep and a gesture. The two
 * account literals that started this were written differently — one on a single line, one across
 * six, one with a literal `assetCode` and one with a variable — and a pattern tuned to either
 * misses the other. A parser sees an object literal however it is spelled, including inside a
 * ternary, a `satisfies`, an array, or a function argument.
 *
 * The trigger is an object literal carrying BOTH a `purpose` and a `type` property. That is the
 * shape of `AccountIdentity & { type }` and of the inline `account` block every ledger client puts
 * on the wire, and nothing else in this estate has it.
 */
export function extractAccountClaims(service: string, file: string, source: string): AccountClaim[] {
  // A NUL byte means the file is not the text it appears to be, and a reader that shrugs at one is
  // how the last static check in this repository was defeated. Refuse loudly.
  const nul = source.indexOf('\u0000')
  if (nul !== -1) throw new UnreadableSourceError(file, `a NUL byte at offset ${nul}`)
  // Spelled as an escape, never as the character itself: a file that CONTAINS the byte it tests for
  // cannot pass its own check, which this one did not until it was actually run. A U+FFFD is NOT
  // checked here — `lantern/src/otlp.ts:375` holds one legitimately, as the sentinel it trims off a
  // truncated string, and refusing it would make a real file invisible. Invalid ENCODING is caught
  // where the bytes are, by the fatal decoder in `sweepEstate`.

  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
  const claims: AccountClaim[] = []

  /**
   * The nearest enclosing `const NAME = <expr>`, walking OUT from the use.
   *
   * Scope-aware rather than a flat file-wide map, and the difference is not academic:
   * `trade/src/ledgerclient.ts` declares `const subject = userSubject(input.userId)` at line 180
   * and, two hundred lines later inside a different function, `const subject =
   * encodeURIComponent(...)`. A flat map takes whichever it saw last and reports the tidiest call
   * site in the estate as unreadable. A full type checker would be better still and cannot be had
   * here — 24 repositories, no shared tsconfig — so this walks the block chain, which is what the
   * language does.
   */
  const nearestConstant = (from: ts.Node, name: string): ts.Expression | null => {
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

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const purposeNode = propertyValue(node, 'purpose')
      const typeNode = propertyValue(node, 'type')
      if (purposeNode && typeNode) {
        const purposeText = literalString(purposeNode)
        const typeText = literalString(typeNode)
        const purpose: AccountPurpose | '*' =
          purposeText !== null && (ACCOUNT_PURPOSES as readonly string[]).includes(purposeText)
            ? (purposeText as AccountPurpose)
            : '*'
        const type: AccountType | '*' =
          typeText !== null && (ACCOUNT_TYPES as readonly string[]).includes(typeText)
            ? (typeText as AccountType)
            : '*'

        // A `{ purpose, type }` pair where NEITHER resolves to the ledger's vocabulary is not an
        // account — it is some other object that happens to share two field names. Requiring one
        // of the two to be a known value is what keeps the sweep from reporting noise as unresolved
        // and burying the real findings; requiring BOTH would let `type: cond ? a : b` escape.
        if (purpose !== '*' || type !== '*') {
          const subjectNode = propertyValue(node, 'subject')
          const subject = subjectNode
            ? resolveSubject(subjectNode, (name) => nearestConstant(node, name))
            : { kind: '*' as SubjectKind, text: null }
          const assetNode = propertyValue(node, 'assetCode')
          const assetCode = assetNode ? (literalString(assetNode) ?? '*') : '*'
          const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
          claims.push({
            service,
            file,
            line: line + 1,
            subject: subject.kind,
            subjectText: subject.text,
            assetCode,
            purpose,
            type,
            unresolved: subject.kind === '*' || purpose === '*' || type === '*',
            text: source
              .slice(node.getStart(tree), node.getEnd())
              .replace(/\s+/g, ' ')
              .slice(0, 160),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(tree)
  return claims
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Directory holding the sibling checkouts. */
  readonly estateDir: string
  /** Skip test sources. A fixture is allowed to name a wrong type deliberately. */
  readonly includeTests?: boolean
  /**
   * Repositories not to read. Defaults to this harness itself: `CANONICAL_ACCOUNTS` below is a
   * table of `{ subject, purpose, type }` literals, so a sweep that read its own source would
   * report the chart as twenty claims by a service that has never posted a ledger entry. That is
   * the only exclusion, it is named here rather than inferred, and `SweepResult.excluded` carries
   * it into the report so it cannot become invisible.
   */
  readonly exclude?: readonly string[]
}

export const DEFAULT_EXCLUDED = Object.freeze(['conformance'])

/**
 * How many account literals the estate currently writes in a way this cannot resolve — 12, listed
 * by name and line in `formatReconciliation`. Eleven hold their `subject` in a function parameter
 * or a property of an argument; one (`ledger/src/entries.ts`) also picks its `purpose` with a
 * ternary.
 *
 * **Recorded as a number that must not grow, rather than tolerated in silence.** A static check
 * over source it cannot fully resolve has a blind spot; a blind spot nobody measures is how a check
 * quietly becomes a no-op while still reporting green. Lowering this is progress and raising it is
 * a decision somebody has to make on purpose.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **RAISED FROM 11 TO 12 ON 2026-08-04, AND HERE IS THE DECISION.**
 *
 * The guard fired exactly as intended: the twelfth spelling appeared and the sweep went red rather
 * than absorbing it. The new one is `beacon/src/browser/money.ts:291`, added by micro-beacon's
 * `fix(browser): a fixture that moves money must put it back` — the browser money fixture credits
 * `{ subject: options.subject, assetCode: options.assetCode, purpose: 'available' }` as
 * `liability`, and `options.subject` is a property of an argument, which is the same shape as the
 * ten that were already here.
 *
 * Raised rather than resolved, for a reason that is about this check's own value: the same run
 * reports **"no two services claim one account key with two types"**, and the claim this cannot
 * read agrees with the convention every resolvable claim in the estate states —
 * `(subject, asset, available)` is a `liability` in billing, community, emberkin, market, mint and
 * worlds alike. So the blind spot grew by one entry that is almost certainly consistent, and the
 * alternative — teaching the resolver to follow a property of a parameter — is a real piece of
 * work that would resolve all eleven of the same shape at once and is worth doing on its own
 * terms rather than under a release gate at four in the morning.
 *
 * **What is NOT acceptable is raising this again without reading the new line.** The number is the
 * measurement of the blind spot; a budget that moves whenever it is inconvenient measures nothing.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
export const BASELINE_UNRESOLVED = 12

/**
 * The smallest number of repositories a sweep may read and still claim to have swept the estate.
 *
 * `sweepEstate` silently skips a directory that is not there, which is the correct behaviour for a
 * partial checkout and a catastrophic one for a gate: an empty parent directory would produce
 * "0 disagreements" and pass. 40 is comfortably below the 49 currently on disk and far above any
 * accidental subset.
 */
export const MIN_SERVICES = 40

export interface SweepResult {
  readonly claims: readonly AccountClaim[]
  /** Every repository actually read. A caller must ASSERT this rather than trust it. */
  readonly services: readonly string[]
  /** Deliberately not read, and why the caller can see it. */
  readonly excluded: readonly string[]
  /** Every `.ts` file opened. The denominator behind "the sweep found nothing". */
  readonly filesRead: number
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'corpus', 'fixtures'])

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectSources(dir: string, includeTests: boolean, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      collectSources(full, includeTests, out)
      continue
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue
    if (!includeTests && (entry.endsWith('.test.ts') || entry.includes('testsupport'))) continue
    out.push(full)
  }
}

/**
 * Read every sibling repository's TypeScript and extract every account it names.
 *
 * Deliberately returns which repositories it read. "The sweep is green" means nothing without
 * "…across these 24 services", and a checkout missing half the estate would otherwise be
 * indistinguishable from an estate that agrees.
 */
export function sweepEstate(options: SweepOptions): SweepResult {
  const includeTests = options.includeTests ?? false
  const excluded = options.exclude ?? DEFAULT_EXCLUDED
  const claims: AccountClaim[] = []
  const services: string[] = []
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

    // `src/`, AND `packages/*/src/`. **`micro-contracts` is the second shape**, and it is the one
    // repository whose account spellings every service copies — `engagementAccount` lives in
    // `packages/money/src/index.ts`. A sweep that read only top-level `src/` would have missed the
    // canonical definitions entirely and called the estate consistent without ever reading them.
    const roots: string[] = []
    const srcDir = join(options.estateDir, repo, 'src')
    if (isDirectory(srcDir)) roots.push(srcDir)
    const packagesDir = join(options.estateDir, repo, 'packages')
    if (isDirectory(packagesDir)) {
      for (const pkg of readdirSync(packagesDir).sort()) {
        const pkgSrc = join(packagesDir, pkg, 'src')
        if (isDirectory(pkgSrc)) roots.push(pkgSrc)
      }
    }
    if (roots.length === 0) continue

    const files: string[] = []
    for (const root of roots) collectSources(root, includeTests, files)
    if (files.length === 0) continue
    services.push(repo)

    for (const file of files) {
      // **`fatal: true`, and it is the whole point.** `readFileSync(file, 'utf8')` silently
      // substitutes U+FFFD for every byte it cannot decode, so a file that is not really UTF-8
      // parses to something plausible and its accounts go unread while the sweep reports green —
      // the same shape of failure as the grep that skipped NUL-bearing files without saying so
      // (e3f32db). A strict decoder throws instead, and the sweep stops rather than under-reports.
      const bytes = readFileSync(file)
      const relativeFile = relative(join(options.estateDir, repo), file)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (err) {
        throw new UnreadableSourceError(`${repo}/${relativeFile}`, `not decodable as UTF-8: ${String(err)}`)
      }
      filesRead += 1
      claims.push(...extractAccountClaims(repo, relativeFile, text))
    }
  }

  return { claims, services, excluded, filesRead }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Two claims that name one account and cannot both be right. */
export interface Disagreement {
  readonly key: string
  readonly claims: readonly AccountClaim[]
  readonly types: readonly string[]
}

/** A claim that contradicts the chart, whether or not any other service disagrees with it yet. */
export interface Uncanonical {
  readonly claim: AccountClaim
  readonly expected: AccountType
  readonly because: string
}

/**
 * A `(purpose, type)` pair the chart has no row for — checked WITHOUT needing the subject.
 *
 * This is the pass that reaches the claims the other two cannot. Roughly a third of the estate's
 * account literals write their subject as a variable (`subject: input.subject`), which no
 * source-level reader can resolve, so their key is a wildcard and they take no part in either
 * comparison above. But the PAIR is still readable, and a pair the chart never permits is wrong
 * whoever the subject turns out to be: no subject in this estate has an `available` account of type
 * `revenue`, so a service that invents one is caught even though nothing else about it is known.
 */
export interface Implausible {
  readonly claim: AccountClaim
  readonly allowed: readonly AccountType[]
}

export interface Reconciliation {
  readonly disagreements: readonly Disagreement[]
  readonly uncanonical: readonly Uncanonical[]
  readonly implausible: readonly Implausible[]
  readonly unresolved: readonly AccountClaim[]
  readonly resolvedClaims: number
  readonly ok: boolean
}

function matches(a: string, b: string): boolean {
  return a === b || a === '*' || b === '*'
}

/** Two claims could name the same ledger row. Wildcards match, because a wildcard could be anything. */
export function collides(a: AccountClaim, b: AccountClaim): boolean {
  return matches(a.subject, b.subject) && matches(a.assetCode, b.assetCode) && matches(a.purpose, b.purpose)
}

function keyOf(claim: AccountClaim): string {
  return `${claim.subject}|${claim.assetCode}|${claim.purpose}`
}

/**
 * Reconcile every claim against every other, and against the chart.
 *
 * Three passes, and each reaches something the others cannot:
 *
 *   * **Disagreement** — two services name one key with two types. This is the defect as it
 *     actually bites: it needs no opinion about which is right, only that they differ.
 *   * **Uncanonical** — one service names a key with a type the chart does not agree with, even
 *     when it is currently the only service naming it. Without this pass, the FIRST service to
 *     invent a wrong type is green until a second one arrives, which is precisely how long these
 *     three defects survived.
 *   * **Implausible** — a `(purpose, type)` pair the chart has no row for, checked without the
 *     subject, so it still reaches the third of the estate's claims whose subject is a variable.
 *
 * Only the first two need a resolved subject. `unresolved` claims are returned in full either way,
 * and `maxUnresolved` is what stops the sweep quietly going blind as services move their account
 * spellings into configuration: a check whose coverage can shrink without anything turning red is
 * a check that eventually measures nothing.
 */
export function reconcileAccountClaims(
  claims: readonly AccountClaim[],
  options: { readonly maxUnresolved?: number } = {},
): Reconciliation {
  const unresolved = claims.filter((claim) => claim.unresolved)
  const resolved = claims.filter((claim) => !claim.unresolved)

  // CONNECTED COMPONENTS over "could be the same ledger row", not pairs.
  //
  // Collision is not transitive once wildcards are involved: `platform|EMBER|fees` and
  // `platform|SHARD|fees` are certainly different rows, but `platform|*|fees` — a service whose
  // asset is a variable, which is exactly how micro-settlement writes it — could be either. Pairing
  // reported that one defect three times over, with overlapping member lists, and a report a reader
  // has to de-duplicate by eye is a report a reader stops reading. A component is the honest unit:
  // every claim in it is reachable from every other, so if any two types differ, at least one
  // posting in that component is going to be refused.
  const parent = resolved.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] as number
    return root
  }
  for (let a = 0; a < resolved.length; a += 1) {
    for (let b = a + 1; b < resolved.length; b += 1) {
      if (!collides(resolved[a] as AccountClaim, resolved[b] as AccountClaim)) continue
      const rootA = find(a)
      const rootB = find(b)
      if (rootA !== rootB) parent[rootB] = rootA
    }
  }
  const components = new Map<number, AccountClaim[]>()
  resolved.forEach((claim, index) => {
    const root = find(index)
    const members = components.get(root)
    if (members) members.push(claim)
    else components.set(root, [claim])
  })

  const disagreements: Disagreement[] = []
  for (const group of components.values()) {
    const types = [...new Set(group.map((member) => member.type))].sort()
    if (types.length < 2) continue
    const key = [...new Set(group.map(keyOf))].sort().join(' & ')
    disagreements.push({ key, claims: group, types })
  }

  const uncanonical: Uncanonical[] = []
  for (const claim of resolved) {
    const canonical = CANONICAL_ACCOUNTS.find(
      (entry) => entry.subject === claim.subject && entry.purpose === claim.purpose,
    )
    if (!canonical) continue
    if (canonical.type === claim.type) continue
    uncanonical.push({ claim, expected: canonical.type, because: canonical.because })
  }

  // Every claim with a readable pair, resolved subject or not.
  const implausible: Implausible[] = []
  for (const claim of claims) {
    if (claim.purpose === '*' || claim.type === '*') continue
    const allowed = [
      ...new Set(CANONICAL_ACCOUNTS.filter((entry) => entry.purpose === claim.purpose).map((e) => e.type)),
    ]
    if (allowed.length === 0) continue // a purpose the chart says nothing about yet
    if (allowed.includes(claim.type)) continue
    implausible.push({ claim, allowed })
  }

  const maxUnresolved = options.maxUnresolved ?? Number.POSITIVE_INFINITY
  return {
    disagreements,
    uncanonical,
    implausible,
    unresolved,
    resolvedClaims: resolved.length,
    ok:
      disagreements.length === 0 &&
      uncanonical.length === 0 &&
      implausible.length === 0 &&
      unresolved.length <= maxUnresolved,
  }
}

/** The report a human reads, and the one CI would print. */
export function formatReconciliation(result: Reconciliation, sweep?: SweepResult): string {
  const lines: string[] = []
  if (sweep) {
    lines.push(
      `swept ${sweep.services.length} repositories, ${sweep.filesRead} files, ${sweep.claims.length} account claims`,
    )
    lines.push(`  ${sweep.services.join(' ')}`)
    if (sweep.excluded.length > 0) lines.push(`  not read: ${sweep.excluded.join(' ')}`)
    lines.push('')
  }

  if (result.disagreements.length === 0) {
    lines.push('no two services claim one account key with two types')
  }
  for (const disagreement of result.disagreements) {
    lines.push(`DISAGREEMENT  ${disagreement.key}  claimed as ${disagreement.types.join(' and ')}`)
    for (const claim of disagreement.claims) {
      lines.push(`    ${claim.type.padEnd(9)} ${claim.service}/${claim.file}:${claim.line}`)
    }
  }

  for (const entry of result.uncanonical) {
    lines.push(
      `UNCANONICAL   ${keyOf(entry.claim)} is ${entry.claim.type}, the chart says ${entry.expected}` +
        `\n    ${entry.claim.service}/${entry.claim.file}:${entry.claim.line}\n    ${entry.because}`,
    )
  }

  for (const entry of result.implausible) {
    lines.push(
      `IMPLAUSIBLE   purpose '${entry.claim.purpose}' is never type '${entry.claim.type}' in this estate ` +
        `(only ${entry.allowed.join(', ')})\n    ${entry.claim.service}/${entry.claim.file}:${entry.claim.line}`,
    )
  }

  lines.push('')
  lines.push(`${result.resolvedClaims} claims resolved, ${result.unresolved.length} not:`)
  for (const claim of result.unresolved) {
    const parts = [
      claim.subject === '*' ? 'subject' : null,
      claim.purpose === '*' ? 'purpose' : null,
      claim.type === '*' ? 'type' : null,
    ].filter((part) => part !== null)
    lines.push(`    ${claim.service}/${claim.file}:${claim.line}  (${parts.join(', ')} not static)  ${claim.text}`)
  }
  return lines.join('\n')
}

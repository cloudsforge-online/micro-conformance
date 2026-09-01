/**
 * The estate-wide reconciliation of LEDGER ACCOUNT TYPES.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS EXISTS TO CATCH, AND WHY NOTHING ELSE COULD
 *
 * `micro-ledger` keys an account on `(subject, asset_code, purpose)` and **nothing else** — not the
 * type. `ensureAccount` therefore has to decide what to do when a caller names an existing account
 * with a different `type`, and it THROWS (`ledger/src/accounts.ts`, `AccountConflictError`):
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
 *   * **Anything whose value is not in the source at all.** A service that builds an account from a
 *     DATABASE ROW, a config file or an HTTP body names a key this cannot read, and no amount of
 *     parsing will change that. It reads a great deal that is not written inline — a name bound to a
 *     constant, a subject arriving in a function parameter, resolved through the call sites in that
 *     repository (`repoResolver`) — but a row is a row. Such a site still appears, as an
 *     `unresolved` claim naming the file and line, and its subject is a wildcard so it takes no part
 *     in the pairwise comparison. It is NOT unchecked: the `implausible` pass judges its
 *     `(purpose, type)` pair against the chart without needing to know whose account it is.
 *     `unresolved` is REPORTED AND COUNTED, never dropped, and `reconcileAccountClaims` fails when
 *     the count of unresolved PLACES exceeds the caller's budget.
 *   * **Anything outside the checkout.** It reads sibling directories on disk. A repository that is
 *     not cloned is invisible, so `sweepEstate` returns the list of repositories it actually read
 *     and the caller must assert that list rather than trust it.
 *   * **Types decided at runtime.** `type: someCondition ? 'revenue' : 'expense'` resolves to a
 *     wildcard type and the claim is counted unresolved. A PURPOSE written that way is expanded
 *     into one claim per branch, and a type deliberately is not: the two are not symmetric. Two
 *     purposes with one type are two accounts the service really does claim that type for; two
 *     types over two purposes is a cross product, half of whose members no call site ever asks for,
 *     and inventing `(available, revenue)` is indistinguishable from finding it.
 *   * **The ledger's own state.** It compares SOURCE against SOURCE. An account row already written
 *     in production with the wrong type is not visible here; that is reconciliation's job.
 *   * **Whether the canonical type is right.** `CANONICAL_ACCOUNTS` is a claim about the chart, not
 *     a proof of it. Its justification is in the table, sourced to `micro-ledger`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

/** The ledger's closed `accounts_type_chk` vocabulary (ledger/src/migrations.ts). */
export const ACCOUNT_TYPES = ['liability', 'asset', 'revenue', 'expense', 'equity', 'clearing'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

/**
 * The ledger's closed `accounts_purpose_chk` vocabulary.
 *
 * A MIRROR, and `vocabularyDrift` is what stops it rotting. It rotted once: ledger migration 18
 * added `inventory` for the Forge Exchange desk, this list was not touched, and the effect was not
 * a missed defect but a manufactured one — `wallet/src/money.ts`'s `desk()` writes
 * `purpose: 'inventory'` as a plain string literal, and a literal this list has no word for reads
 * as "purpose not static". So a fully readable account spent a line of the unresolved budget,
 * pushed the count to 9 against a budget of 8, and failed the estate gate as a blind spot that
 * was never blind. See the entry beside `BASELINE_UNRESOLVED`.
 */
export const ACCOUNT_PURPOSES = [
  'available',
  'reserved',
  'escrow',
  'treasury',
  'fees',
  'payout_due',
  'suspense',
  'inventory',
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
  | 'exchange'
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
 * `ledger/src/accounts.ts`, on why the ledger refuses to infer the type itself: "`platform`
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
    subject: 'exchange',
    purpose: 'escrow',
    type: 'liability',
    because:
      'contracts/packages/money/src/index.ts, `EXCHANGE` — the order book\'s omnibus escrow, with ' +
      'micro-trade\'s `exchange_accounts` rows as the sub-ledger that says whose it is. Owed onwards, ' +
      'so `liability`; and it must NOT be overdraft-exempt, which is what rules out `clearing`. ' +
      'ledger/src/reconcile.ts sums liabilities by TYPE with no subject filter, so a balance moving ' +
      'from `user:<id>/available` into it leaves the reconciliation invariant where it was.',
  },
  {
    subject: 'exchange',
    purpose: 'inventory',
    type: 'equity',
    because:
      "wallet/src/money.ts, `desk()` — the Forge Exchange Desk's own holding in one asset, the " +
      'counter-account for every conversion leg. `equity` and NOT `clearing`, and the reason is a ' +
      'database column rather than a taxonomy: `clearing` is exempt from the overdraft check, so ' +
      'the account this used to be could be drawn to any negative number and a conversion could ' +
      'always be filled out of nothing. `equity` is credit-normal — the same posting direction the ' +
      'clearing account took — and it reaches `overdraft_allowed = false`, so an order the desk ' +
      'cannot fill is refused by Postgres inside the entry\'s own transaction. This row is what ' +
      'makes a second service writing `inventory` as anything else an `implausible`, rather than a ' +
      'purpose the chart says nothing about and therefore never judges.',
  },
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
  exchange: 'exchange',
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

/**
 * The two subject tables above, judged against the grammar that DECIDES them.
 *
 * `subjectKindOf` is a second copy of `parseAccountSubject`, and until micro-org#372 the only thing
 * holding the copies together was six hand-written strings in a test — which cannot notice a
 * subject contracts adds or retires. #372 was the first direction: `micro-trade` wrote
 * `subject: 'exchange'`, no grammar anywhere had it, every posting would have died at the ledger's
 * `ensureAccount`, and this sweep reported it only as a line it could not read. The other direction
 * is worse: a kind here that contracts has retired would let the sweep BLESS a spelling the ledger
 * now throws on.
 *
 * Source text, not an import: this repository deliberately does not depend on
 * `@cloudsforge/contracts-money`, and it already reads the estate as text.
 *
 * `unreadable` is a distinct outcome from "no drift". A union this cannot parse must never look
 * like agreement — that is the shape of every dead check this repository has shipped.
 */
export interface GrammarDrift {
  /** Subjects contracts declares that `subjectKindOf` answers `*` for. */
  readonly unknown: readonly string[]
  /** Subject kinds this file classifies that contracts' union no longer declares. */
  readonly retired: readonly string[]
  /** The `AccountSubject` union could not be found in the source it was handed. */
  readonly unreadable: boolean
}

const ACCOUNT_SUBJECT_UNION = /export type AccountSubject =\n((?:[^\S\n]*\|.*\n)+)/

export function subjectGrammarDrift(moneySource: string): GrammarDrift {
  const union = ACCOUNT_SUBJECT_UNION.exec(moneySource)?.[1]
  if (union === undefined) return { unknown: [], retired: [], unreadable: true }

  const prefixes = [...union.matchAll(/\|\s*`([a-z]+):\$\{string\}`/g)].map((m) => m[1] as string)
  const singletons = [...union.matchAll(/\|\s*'([^']+)'/g)].map((m) => m[1] as string)
  if (prefixes.length === 0 || singletons.length === 0) {
    return { unknown: [], retired: [], unreadable: true }
  }

  const unknown = [
    ...singletons.filter((subject) => subjectKindOf(subject) === '*'),
    ...prefixes.filter((prefix) => subjectKindOf(`${prefix}:x`) === '*').map((prefix) => `${prefix}:<id>`),
  ]
  // Derived from the tables themselves in BOTH directions, deliberately: a hand-written list of
  // "the subjects we know" would be a third copy, and the third copy is the one nobody updates.
  const declared = new Set([...singletons, ...prefixes.map((prefix) => `${prefix}:x`)])
  const retired = [
    ...Object.keys(SINGLETON_KINDS).filter((subject) => !declared.has(subject)),
    ...Object.keys(PREFIX_KINDS)
      .filter((prefix) => !declared.has(`${prefix}:x`))
      .map((prefix) => `${prefix}:<id>`),
  ]
  return { unknown, retired, unreadable: false }
}

/**
 * The `AccountSubject` constants micro-contracts exports, by name, read from its source.
 *
 * Derived rather than listed, for the same reason `subjectGrammarDrift` compares tables instead of
 * checking a hand-written roster: a list here would be a third copy of a set that already exists
 * twice, and the third copy is the one nobody updates. A constant added to contracts is resolvable
 * by this sweep the moment it is added, and a constant RENAMED there stops resolving — which is
 * correct, because the old name is then a name no service can import.
 *
 * Only `export const NAME: AccountSubject = '<literal>'` is read. A constant whose value is a
 * template, a call or another constant is deliberately not followed: it would need a resolver over
 * a repository this function is not given, and the honest answer for a shape this cannot read is
 * to leave the site unresolved and let it cost a budget line.
 */
export function accountSubjectConstants(moneySource: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const match of moneySource.matchAll(/export const ([A-Z][A-Z0-9_]*): AccountSubject = '([^']+)'/g)) {
    found.set(match[1] as string, match[2] as string)
  }
  return found
}

/** The one line a report prints about the grammar, or null when the two agree. */
export function formatGrammarDrift(drift: GrammarDrift): string | null {
  if (drift.unreadable) {
    return "contracts' AccountSubject union could not be read — the subject grammar is UNCHECKED, which is not the same as agreed"
  }
  const lines: string[] = []
  if (drift.unknown.length > 0) {
    lines.push(
      `contracts declares subjects this sweep cannot classify: ${drift.unknown.join(', ')} — ` +
        'every claim written against one is counted unreadable instead of judged',
    )
  }
  if (drift.retired.length > 0) {
    lines.push(
      `this sweep classifies subjects contracts no longer declares: ${drift.retired.join(', ')} — ` +
        'it would bless a spelling the ledger throws on',
    )
  }
  return lines.length === 0 ? null : lines.join('\n')
}

/**
 * The two closed vocabularies above, judged against the migrations that DECIDE them.
 *
 * `ACCOUNT_TYPES` and `ACCOUNT_PURPOSES` are copies of `accounts_type_chk` and
 * `accounts_purpose_chk`, and until this function nothing held the copies to their originals. It
 * had already gone wrong: ledger migration 18 added `inventory`, this file did not, and the effect
 * was not a defect missed but a defect INVENTED — `wallet/src/money.ts` writes
 * `purpose: 'inventory'` as a plain literal, a literal outside the vocabulary reads as "not
 * static", and the estate gate failed on a place it could read perfectly well.
 *
 * That direction is the loud one. The other is worse and silent: a word RETIRED from the
 * constraint but still listed here would let the sweep resolve, classify and BLESS a purpose the
 * database now rejects — a green report about postings that die at the check constraint.
 *
 * Read from the LAST occurrence of each constraint in the file, not the first. Migrations are
 * append-only and a widened vocabulary is written as `drop constraint` / `add constraint ... not
 * valid` / `validate`, so the first `check (purpose in (...))` in `migrations.ts` is migration 1's
 * — the original seven — and a reader that took it would report the current list as drift and be
 * wrong in the confident direction.
 *
 * Source text, not a database: this runs in CI with no cluster, and the file is the thing every
 * environment actually applies.
 *
 * `unreadable` is a distinct outcome from "no drift", for the reason `GrammarDrift` gives.
 */
export interface VocabularyDrift {
  /** Words the ledger's constraint permits that this file has no entry for. */
  readonly missing: readonly string[]
  /** Words this file lists that the ledger's constraint no longer permits. */
  readonly retired: readonly string[]
  /** The constraint could not be found or parsed — never the same as agreement. */
  readonly unreadable: boolean
}

/** Both constraints, each named by the column it guards. */
export interface VocabularyReport {
  readonly purposes: VocabularyDrift
  readonly types: VocabularyDrift
}

const UNREADABLE: VocabularyDrift = Object.freeze({ missing: [], retired: [], unreadable: true })

function checkConstraintWords(migrationsSource: string, column: string): readonly string[] | null {
  // Every occurrence, then the last — see the docstring. `[\s\S]` rather than the `s` flag because
  // the list is written across lines in the later migrations and on one line in migration 1, and
  // both shapes have to parse identically or the comparison is against whichever one blinked.
  const pattern = new RegExp(`accounts_${column}_chk check \\(\\s*${column} in \\(([\\s\\S]*?)\\)`, 'g')
  const matches = [...migrationsSource.matchAll(pattern)]
  const last = matches[matches.length - 1]
  if (last === undefined) return null
  const words = [...(last[1] as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string)
  return words.length === 0 ? null : words
}

function driftOf(declared: readonly string[] | null, mirrored: readonly string[]): VocabularyDrift {
  if (declared === null) return UNREADABLE
  const inLedger = new Set(declared)
  const inMirror = new Set<string>(mirrored)
  return {
    missing: declared.filter((word) => !inMirror.has(word)),
    retired: mirrored.filter((word) => !inLedger.has(word)),
    unreadable: false,
  }
}

/** `ACCOUNT_PURPOSES` and `ACCOUNT_TYPES`, against `ledger/src/migrations.ts`. */
export function vocabularyDrift(migrationsSource: string): VocabularyReport {
  return {
    purposes: driftOf(checkConstraintWords(migrationsSource, 'purpose'), ACCOUNT_PURPOSES),
    types: driftOf(checkConstraintWords(migrationsSource, 'type'), ACCOUNT_TYPES),
  }
}

/** The drift as a reader sees it, or `null` when both vocabularies agree. */
export function formatVocabularyDrift(report: VocabularyReport): string | null {
  const lines: string[] = []
  for (const [column, drift] of [
    ['purpose', report.purposes],
    ['type', report.types],
  ] as const) {
    if (drift.unreadable) {
      lines.push(
        `the ledger's accounts_${column}_chk could not be read — the ${column} vocabulary is ` +
          'UNCHECKED, which is not the same as agreed',
      )
      continue
    }
    if (drift.missing.length > 0) {
      lines.push(
        `the ledger permits ${column}s this sweep has no word for: ${drift.missing.join(', ')} — ` +
          'a literal written with one reads as "not static" and spends a line of the unresolved ' +
          'budget it does not owe',
      )
    }
    if (drift.retired.length > 0) {
      lines.push(
        `this sweep lists ${column}s the ledger no longer permits: ${drift.retired.join(', ')} — ` +
          'it would resolve and bless a value the check constraint rejects',
      )
    }
  }
  return lines.length === 0 ? null : lines.join('\n')
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

// ---------------------------------------------------------------------------
// Resolution across a repository
// ---------------------------------------------------------------------------

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A REPOSITORY-WIDE PASS AND NOT A FILE-WIDE ONE, AND WHAT THAT COST.
 *
 * Every one of the thirteen literals this sweep could not read (micro-org#264) held its `subject`
 * in a function PARAMETER — `subject: input.subject`, `subject: options.subject`, or a bare
 * shorthand `{ subject, assetCode, purpose }` in a two-line helper. The obvious fix, and the one
 * #264 proposes, is to read the parameter's TYPE ANNOTATION. That was measured against the estate
 * before any of this was written, and it resolves **nothing**:
 *
 *   billing, emberkin, mint, worlds, beacon, market, foresight → `subject: string`
 *   community, ledger                                          → `subject: AccountSubject`
 *
 * `string` is not a subject, and `AccountSubject` (contracts/packages/money) is the union of all
 * nine spellings — `user:${string} | community:${string} | … | 'platform' | 'custody'` — which
 * spans every kind and is therefore worth exactly as much as the wildcard it would replace. The
 * annotation is read anyway, first, because it is the only statement a compiler enforces and a
 * service that DOES narrow one should be rewarded for it; it just does not pay today.
 *
 * What actually resolves these is the CALL SITE, and the call site is almost never in the same
 * file: `worlds/src/ledgerclient.ts`'s `rewardPostings(input)` is called once, from
 * `worlds/src/rewards.ts`, with `` subject: `user:${input.userId}` ``. So the unit of resolution
 * has to be the repository, and this section is what pays for that.
 *
 * THE RULES IT REFUSES TO BREAK, because a wrong resolution is worse than a wildcard — a wildcard
 * is loud and counted, a wrong kind is a silent green:
 *
 *   * A name declared TWICE in the repository resolves to nothing. There is no module resolver
 *     here (no shared tsconfig across 24 repositories), so a name is matched by text; two
 *     declarations mean the import could be either and a guess would be a coin toss.
 *   * A function with no call site in the repository resolves to nothing. An exported helper the
 *     estate calls from another repository is genuinely unreadable from here.
 *   * Call sites that DISAGREE resolve to nothing. `billing`'s `purchasePostings` is called with a
 *     parsed subject from one file and a subscription row's subject from another; the honest answer
 *     is that the claim is about both, and neither is knowable.
 *   * A type imported from another repository resolves to nothing rather than being assumed.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

/** One parsed source file, kept so a claim in one file can be read against a call site in another. */
export interface RepoSource {
  /** Repository-relative, matching `AccountClaim.file`. */
  readonly file: string
  readonly tree: ts.SourceFile
}

/** The string values a TYPE admits. `exact` is false for `` `user:${string}` ``, where text is the head. */
interface TypeValue {
  readonly text: string
  readonly exact: boolean
}

export interface Resolver {
  /** The subject kind an expression names, following constants, parameters and call sites. */
  subject(node: ts.Expression, tree: ts.SourceFile): { kind: SubjectKind; text: string | null }
  /**
   * Every purpose an expression can be, or null when it is not a closed set this can name.
   *
   * A SET rather than one value, because two of the estate's helpers are genuinely polymorphic in
   * their purpose and saying so is more accurate than either half: `foresight`'s
   * `userAccount(subject, assetCode, purpose: 'available' | 'escrow')` claims a type for two
   * accounts, not for an unknown one, and `market`'s `holder` claims one for three.
   */
  purposes(node: ts.Expression, tree: ts.SourceFile): readonly AccountPurpose[] | null
}

/** Guards against a pathological repository turning a sweep into an exponential walk. */
const MAX_DEPTH = 6
const MAX_CALL_SITES = 48
/**
 * A purpose set wider than this says nothing a wildcard did not, and expanding it would multiply
 * one literal into a fan of claims that drown the report. `AccountPurpose` itself — all seven — is
 * the case this exists for: reading it as "this helper claims a type for every purpose in the
 * chart" would invent an `(*, *, fees) → liability` claim that no call site ever makes.
 */
const MAX_PURPOSES = 4

function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

/** The name a function is called by: its own, or the `const` it was assigned to. */
function declaredName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    return fn.name && ts.isIdentifier(fn.name) ? fn.name.text : null
  }
  const parent = fn.parent as ts.Node | undefined
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return null
}

interface RepoIndex {
  readonly functions: Map<string, { tree: ts.SourceFile; fn: ts.SignatureDeclaration }[]>
  readonly values: Map<string, { tree: ts.SourceFile; expr: ts.Expression }[]>
  readonly types: Map<string, { tree: ts.SourceFile; node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration }[]>
  readonly calls: Map<string, { tree: ts.SourceFile; call: ts.CallExpression }[]>
}

function indexPush<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function buildIndex(sources: readonly RepoSource[]): RepoIndex {
  const index: RepoIndex = { functions: new Map(), values: new Map(), types: new Map(), calls: new Map() }
  for (const { tree } of sources) {
    // Declarations: MODULE LEVEL only. A nested `const` is already reachable through the scope walk
    // in `nearestConstant`, and indexing it here would let a name local to one function answer for
    // an import of the same name in another file.
    for (const statement of tree.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        indexPush(index.functions, statement.name.text, { tree, fn: statement })
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
          const initialiser = declaration.initializer
          if (ts.isArrowFunction(initialiser) || ts.isFunctionExpression(initialiser)) {
            indexPush(index.functions, declaration.name.text, { tree, fn: initialiser })
          } else {
            indexPush(index.values, declaration.name.text, { tree, expr: initialiser })
          }
        }
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        indexPush(index.types, statement.name.text, { tree, node: statement })
      }
    }
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        indexPush(index.calls, node.expression.text, { tree, call: node })
      }
      ts.forEachChild(node, walk)
    }
    walk(tree)
  }
  return index
}

const UNKNOWN_SUBJECT: { kind: SubjectKind; text: string | null } = { kind: '*', text: null }

/**
 * A resolver over one repository's sources.
 *
 * Pass every `.ts` file of ONE repository. Passing the whole estate would let `micro-market`'s
 * `holder` be answered by `micro-mint`'s call sites, which is exactly the cross-service guess this
 * whole module exists to catch rather than commit.
 */
export function repoResolver(
  sources: readonly RepoSource[],
  /**
   * The `AccountSubject` constants micro-contracts exports, by name — see
   * `accountSubjectConstants`. Empty by default, and empty is the OLD behaviour rather than a
   * silent pass: an identifier that resolves to nothing still reads `*` and still costs a line of
   * the unresolved budget.
   *
   * This is the ONE cross-repository lookup this module permits, and the exception is narrow on
   * purpose. The header above refuses to let `micro-mint`'s call sites answer for `micro-market`'s
   * `holder`, because that is a guess about a name two services happen to share. This is not that:
   * the name is imported from a single package every service depends on by version, its value is a
   * string literal in that package's source, and `subjectGrammarDrift` already fails the run if
   * that source cannot be read at all.
   */
  constants: ReadonlyMap<string, string> = new Map(),
): Resolver {
  const index = buildIndex(sources)

  const only = <T>(list: readonly T[] | undefined): T | null => (list && list.length === 1 ? (list[0] as T) : null)

  /**
   * The nearest enclosing `const NAME = <expr>`, walking OUT from the use.
   *
   * Scope-aware rather than a flat file-wide map, and the difference is not academic:
   * `trade/src/ledgerclient.ts` declares `const subject = userSubject(input.userId)` at one line
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

  /** The enclosing function whose parameter this name is, and which position it sits in. */
  const parameterOf = (
    from: ts.Node,
    name: string,
  ): { fn: ts.Node; position: number; parameter: ts.ParameterDeclaration } | null => {
    for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
      if (!isFunctionLike(scope)) continue
      const parameters = scope.parameters
      for (let position = 0; position < parameters.length; position += 1) {
        const parameter = parameters[position] as ts.ParameterDeclaration
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return { fn: scope, position, parameter }
      }
    }
    return null
  }

  /**
   * `x as T`, `(x)`, `x!` and `x satisfies T` all wrap a value without changing it.
   *
   * `ledger/src/entries.ts` writes `request.subject as EnsureAccountInput['subject']`, which the
   * previous reader saw as an AsExpression and gave up on before ever reaching the property access
   * underneath — a cast made the site LESS readable than the same code without one.
   */
  const unwrap = (node: ts.Expression): ts.Expression => {
    let expression = node
    for (;;) {
      if (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isNonNullExpression(expression)
      ) {
        expression = expression.expression
        continue
      }
      return expression
    }
  }

  /** Every string a type admits, following `path` into its members. Null when it is not a closed set. */
  const valuesOfType = (
    type: ts.TypeNode,
    tree: ts.SourceFile,
    path: readonly string[],
    depth: number,
  ): TypeValue[] | null => {
    if (depth > MAX_DEPTH) return null
    if (ts.isParenthesizedTypeNode(type)) return valuesOfType(type.type, tree, path, depth + 1)

    if (path.length === 0) {
      if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
        return [{ text: type.literal.text, exact: true }]
      }
      if (ts.isTemplateLiteralTypeNode(type)) return [{ text: type.head.text, exact: false }]
    }

    if (ts.isUnionTypeNode(type)) {
      const values: TypeValue[] = []
      for (const member of type.types) {
        const resolved = valuesOfType(member, tree, path, depth + 1)
        if (!resolved) return null
        values.push(...resolved)
      }
      return values.length > 12 ? null : values
    }

    const memberType = (
      members: ts.NodeArray<ts.TypeElement>,
      where: ts.SourceFile,
    ): TypeValue[] | null | undefined => {
      for (const member of members) {
        if (!ts.isPropertySignature(member) || !member.type) continue
        const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null
        if (name === path[0]) return valuesOfType(member.type, where, path.slice(1), depth + 1)
      }
      return undefined
    }

    if (ts.isTypeLiteralNode(type) && path.length > 0) return memberType(type.members, tree) ?? null

    if (ts.isIndexedAccessTypeNode(type)) {
      const key =
        ts.isLiteralTypeNode(type.indexType) && ts.isStringLiteral(type.indexType.literal)
          ? type.indexType.literal.text
          : null
      return key === null ? null : valuesOfType(type.objectType, tree, [key, ...path], depth + 1)
    }

    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      // Declared once in THIS repository, or not at all. Anything else is another repository's
      // type — `AccountSubject`, `AccountPurpose`, `LedgerAssetCode` — and is out of reach on
      // purpose. See the header: a guess is worse than the wildcard it replaces.
      const declared = only(index.types.get(type.typeName.text))
      if (!declared) return null
      if (ts.isTypeAliasDeclaration(declared.node)) {
        return valuesOfType(declared.node.type, declared.tree, path, depth + 1)
      }
      if (path.length === 0) return null
      // An interface member it declares ITSELF. A member reached through `extends` may be
      // inherited from another repository's interface, which is the ledger's `EnsureAccountInput
      // extends AccountIdentity` case exactly, and is unreadable rather than assumed.
      return memberType(declared.node.members, declared.tree) ?? null
    }

    return null
  }

  /** Every argument the repository passes at `position` of `fn`, or null when that cannot be known. */
  const argumentsOf = (fn: ts.Node, position: number): { tree: ts.SourceFile; expression: ts.Expression }[] | null => {
    const name = declaredName(fn)
    if (name === null) return null
    if ((index.functions.get(name)?.length ?? 0) !== 1) return null
    const sites = index.calls.get(name) ?? []
    if (sites.length === 0 || sites.length > MAX_CALL_SITES) return null
    const args: { tree: ts.SourceFile; expression: ts.Expression }[] = []
    for (const site of sites) {
      const argument = site.call.arguments[position]
      // A call that omits the argument — an optional parameter, or a defaulted one. Its value at
      // that site is whatever the default is, which this does not read, so the set is incomplete.
      if (!argument) return null
      args.push({ tree: site.tree, expression: argument })
    }
    return args
  }

  const prefixKind = (head: string): SubjectKind => {
    const separator = head.indexOf(':')
    if (separator <= 0) return '*'
    return PREFIX_KINDS[head.slice(0, separator)] ?? '*'
  }

  /** One kind, or null when the type spans several — which is worth no more than a wildcard. */
  const kindOfValues = (values: readonly TypeValue[] | null): { kind: SubjectKind; text: string | null } | null => {
    if (!values || values.length === 0) return null
    const kinds = new Set<SubjectKind>()
    for (const value of values) {
      const kind = value.exact ? subjectKindOf(value.text) : prefixKind(value.text)
      if (kind === '*') return null
      kinds.add(kind)
    }
    if (kinds.size !== 1) return null
    const first = values[0] as TypeValue
    return { kind: [...kinds][0] as SubjectKind, text: values.length === 1 && first.exact ? first.text : null }
  }

  const cappedPurposes = (purposes: readonly AccountPurpose[]): AccountPurpose[] | null => {
    const unique = [...new Set(purposes)].sort()
    if (unique.length === 0 || unique.length > MAX_PURPOSES) return null
    return unique
  }

  const purposesOfValues = (values: readonly TypeValue[] | null): AccountPurpose[] | null => {
    if (!values) return null
    const purposes: AccountPurpose[] = []
    for (const value of values) {
      if (!value.exact || !(ACCOUNT_PURPOSES as readonly string[]).includes(value.text)) return null
      purposes.push(value.text as AccountPurpose)
    }
    return cappedPurposes(purposes)
  }

  const subjectAt = (
    node: ts.Expression,
    tree: ts.SourceFile,
    path: readonly string[],
    depth: number,
    seen: Set<ts.Node>,
  ): { kind: SubjectKind; text: string | null } => {
    if (depth > MAX_DEPTH || seen.has(node)) return UNKNOWN_SUBJECT
    seen.add(node)
    try {
      const expression = unwrap(node)

      // The single-file reader first, unchanged: a literal, a template with a known prefix, a
      // contracts-money factory, or a name bound to one of those in an enclosing block. Everything
      // below is only what happens when that already says `*`.
      if (path.length === 0) {
        const direct = resolveSubject(expression, (name) => nearestConstant(expression, name))
        if (direct.kind !== '*') return direct
      }

      if (ts.isObjectLiteralExpression(expression) && path.length > 0) {
        const value = propertyValue(expression, path[0] as string)
        return value ? subjectAt(value, tree, path.slice(1), depth + 1, seen) : UNKNOWN_SUBJECT
      }

      if (ts.isPropertyAccessExpression(expression)) {
        return subjectAt(expression.expression, tree, [expression.name.text, ...path], depth + 1, seen)
      }

      if (ts.isIdentifier(expression)) {
        const bound = nearestConstant(expression, expression.text)
        if (bound && bound !== expression) return subjectAt(bound, tree, path, depth + 1, seen)

        const parameter = parameterOf(expression, expression.text)
        if (parameter) {
          if (parameter.parameter.type) {
            const annotated = kindOfValues(valuesOfType(parameter.parameter.type, tree, path, 0))
            if (annotated) return annotated
          }
          const args = argumentsOf(parameter.fn, parameter.position)
          if (!args) return UNKNOWN_SUBJECT
          let kind: SubjectKind | null = null
          for (const argument of args) {
            const resolved = subjectAt(argument.expression, argument.tree, path, depth + 1, seen)
            if (resolved.kind === '*') return UNKNOWN_SUBJECT
            if (kind !== null && kind !== resolved.kind) return UNKNOWN_SUBJECT
            kind = resolved.kind
          }
          return kind === null ? UNKNOWN_SUBJECT : { kind, text: null }
        }

        // A name this file imports. `admin-api/src/actions.ts` writes
        // `subject: ENGAGEMENT_TREASURY_SUBJECT`, whose value is one file away in the SAME
        // repository — on disk, already parsed, and unique.
        const value = only(index.values.get(expression.text))
        if (value) return subjectAt(value.expr, value.tree, path, depth + 1, seen)

        // A name imported from micro-contracts. `trade/src/transfers.ts` writes
        // `subject: EXCHANGE`, and the value is a string literal in
        // `contracts/packages/money/src/index.ts` — another repository, so `index.values` cannot
        // hold it and every reader before this one answered `*`.
        //
        // **This mattered, and it mattered in the direction nobody expects.** micro-org#372 was
        // fixed by replacing the literal `'exchange'` with the constant, precisely so a subject a
        // service invents is a compile error rather than a runtime one. That repair made this
        // sweep read the site LESS well than the defect had: the budget line stayed, and the
        // reported text changed from a wrong literal to a right identifier. A tool that penalises
        // the fix it asked for teaches people to write the literal back.
        if (path.length === 0) {
          const declared = constants.get(expression.text)
          if (declared !== undefined) return { kind: subjectKindOf(declared), text: declared }
        }
        return UNKNOWN_SUBJECT
      }

      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && path.length === 0) {
        // `engagementSubjectOf(service)` — a one-line helper in the same repository whose body is
        // `` return `engagement:${service}` ``. Followed only when the name is declared once.
        const declared = only(index.functions.get(expression.expression.text))
        if (!declared) return UNKNOWN_SUBJECT
        const returns = returnExpressions(declared.fn)
        if (returns.length === 0) return UNKNOWN_SUBJECT
        let kind: SubjectKind | null = null
        for (const returned of returns) {
          const resolved = subjectAt(returned, declared.tree, [], depth + 1, seen)
          if (resolved.kind === '*') return UNKNOWN_SUBJECT
          if (kind !== null && kind !== resolved.kind) return UNKNOWN_SUBJECT
          kind = resolved.kind
        }
        return kind === null ? UNKNOWN_SUBJECT : { kind, text: null }
      }

      return UNKNOWN_SUBJECT
    } finally {
      seen.delete(node)
    }
  }

  const purposesAt = (
    node: ts.Expression,
    tree: ts.SourceFile,
    path: readonly string[],
    depth: number,
    seen: Set<ts.Node>,
  ): AccountPurpose[] | null => {
    if (depth > MAX_DEPTH || seen.has(node)) return null
    seen.add(node)
    try {
      const expression = unwrap(node)

      if (path.length === 0) {
        const literal = literalString(expression)
        if (literal !== null) {
          return (ACCOUNT_PURPOSES as readonly string[]).includes(literal) ? [literal as AccountPurpose] : null
        }
        // `posting.accountId === 'available' ? 'available' : 'reserved'` — ledger/src/entries.ts.
        // Not an unknown purpose: two known ones, and the claim is about both accounts.
        if (ts.isConditionalExpression(expression)) {
          const whenTrue = purposesAt(expression.whenTrue, tree, path, depth + 1, seen)
          const whenFalse = purposesAt(expression.whenFalse, tree, path, depth + 1, seen)
          if (!whenTrue || !whenFalse) return null
          return cappedPurposes([...whenTrue, ...whenFalse])
        }
      }

      if (ts.isObjectLiteralExpression(expression) && path.length > 0) {
        const value = propertyValue(expression, path[0] as string)
        return value ? purposesAt(value, tree, path.slice(1), depth + 1, seen) : null
      }

      if (ts.isPropertyAccessExpression(expression)) {
        return purposesAt(expression.expression, tree, [expression.name.text, ...path], depth + 1, seen)
      }

      if (ts.isIdentifier(expression)) {
        const bound = nearestConstant(expression, expression.text)
        if (bound && bound !== expression) return purposesAt(bound, tree, path, depth + 1, seen)

        const parameter = parameterOf(expression, expression.text)
        if (parameter) {
          if (parameter.parameter.type) {
            // `purpose: 'available' | 'escrow'` — foresight/src/custodialstakes.ts. The annotation
            // is preferred over the call sites here because the compiler enforces it: a call site
            // added tomorrow cannot widen it without the annotation changing too.
            const annotated = purposesOfValues(valuesOfType(parameter.parameter.type, tree, path, 0))
            if (annotated) return annotated
          }
          const args = argumentsOf(parameter.fn, parameter.position)
          if (!args) return null
          const purposes: AccountPurpose[] = []
          for (const argument of args) {
            const resolved = purposesAt(argument.expression, argument.tree, path, depth + 1, seen)
            if (!resolved) return null
            purposes.push(...resolved)
          }
          return cappedPurposes(purposes)
        }

        const value = only(index.values.get(expression.text))
        if (value) return purposesAt(value.expr, value.tree, path, depth + 1, seen)
      }

      return null
    } finally {
      seen.delete(node)
    }
  }

  return {
    subject: (node, tree) => subjectAt(node, tree, [], 0, new Set()),
    purposes: (node, tree) => purposesAt(node, tree, [], 0, new Set()),
  }
}

/** Every expression a function can return, including a concise arrow body. */
function returnExpressions(fn: ts.Node): ts.Expression[] {
  const declaration = fn as ts.SignatureDeclaration & { body?: ts.Node }
  const body = declaration.body
  if (!body) return []
  if (!ts.isBlock(body)) return [body as ts.Expression]
  const returned: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    // Do NOT descend into a nested function: its `return` belongs to it, not to this one.
    if (node !== body && isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression)
    ts.forEachChild(node, walk)
  }
  walk(body)
  return returned
}

/**
 * Parse one source file, refusing rather than skipping when it is not the text it appears to be.
 */
export function parseSource(file: string, source: string): ts.SourceFile {
  // A NUL byte means the file is not the text it appears to be, and a reader that shrugs at one is
  // how the last static check in this repository was defeated. Refuse loudly.
  const nul = source.indexOf('\u0000')
  if (nul !== -1) throw new UnreadableSourceError(file, `a NUL byte at offset ${nul}`)
  // Spelled as an escape, never as the character itself: a file that CONTAINS the byte it tests for
  // cannot pass its own check, which this one did not until it was actually run. A U+FFFD is NOT
  // checked here — `lantern/src/otlp.ts` holds one legitimately, as the sentinel it trims off a
  // truncated string, and refusing it would make a real file invisible. Invalid ENCODING is caught
  // where the bytes are, by the fatal decoder in `sweepEstate`.
  return ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
}

/**
 * Every account one parsed source names, read against a resolver for the whole repository.
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
 *
 * ONE LITERAL CAN PRODUCE SEVERAL CLAIMS, and that is deliberate rather than a leak.
 * `foresight/src/custodialstakes.ts`'s helper takes `purpose: 'available' | 'escrow'` and returns
 * `type: 'liability'`: it is not a claim about an unknown account, it is one claim about each of
 * two known ones, and collapsing them to a wildcard threw away the half the chart could check.
 * `Reconciliation.unresolvedSites` is what keeps the blind-spot budget comparable across this
 * change — see its comment.
 */
export function claimsFromTree(
  service: string,
  file: string,
  tree: ts.SourceFile,
  resolver: Resolver,
): AccountClaim[] {
  const source = tree.getFullText()
  const claims: AccountClaim[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const purposeNode = propertyValue(node, 'purpose')
      const typeNode = propertyValue(node, 'type')
      if (purposeNode && typeNode) {
        const typeText = literalString(typeNode)
        const type: AccountType | '*' =
          typeText !== null && (ACCOUNT_TYPES as readonly string[]).includes(typeText)
            ? (typeText as AccountType)
            : '*'
        const resolved = resolver.purposes(purposeNode, tree)
        const purposes: readonly (AccountPurpose | '*')[] = resolved && resolved.length > 0 ? resolved : ['*']

        // A `{ purpose, type }` pair where NEITHER resolves to the ledger's vocabulary is not an
        // account — it is some other object that happens to share two field names. Requiring one
        // of the two to be a known value is what keeps the sweep from reporting noise as unresolved
        // and burying the real findings; requiring BOTH would let `type: cond ? a : b` escape.
        if (purposes[0] !== '*' || type !== '*') {
          const subjectNode = propertyValue(node, 'subject')
          const subject = subjectNode ? resolver.subject(subjectNode, tree) : { kind: '*' as SubjectKind, text: null }
          const assetNode = propertyValue(node, 'assetCode')
          const assetCode = assetNode ? (literalString(assetNode) ?? '*') : '*'
          const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
          const text = source
            .slice(node.getStart(tree), node.getEnd())
            .replace(/\s+/g, ' ')
            .slice(0, 160)
          for (const purpose of purposes) {
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
              text,
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(tree)
  return claims
}

/**
 * Every account one source names, read with no repository around it.
 *
 * The single-file entry point, and what every case in `ledgeraccounts.test.ts` that does not build
 * a directory uses. A claim whose subject lives in a parameter is unresolvable here BY
 * CONSTRUCTION — the call site is in another file — which is exactly why `sweepEstate` builds a
 * resolver per repository instead of calling this in a loop.
 */
export function extractAccountClaims(service: string, file: string, source: string): AccountClaim[] {
  const tree = parseSource(file, source)
  return claimsFromTree(service, file, tree, repoResolver([{ file, tree }]))
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
 * How many PLACES in the estate write an account this cannot fully resolve — 8, each listed by
 * name and line in `formatReconciliation`.
 *
 * **Recorded as a number that must not grow, rather than tolerated in silence.** A static check
 * over source it cannot fully resolve has a blind spot; a blind spot nobody measures is how a check
 * quietly becomes a no-op while still reporting green. Lowering this is progress and raising it is
 * a decision somebody has to make on purpose.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **LOWERED FROM 13 TO 8 ON 2026-08-09 — micro-org#264, which was the promise the last two raises
 * were made against.** Here is what moved, because "it got better" is not a measurement either.
 *
 * SIX literals are now READ, by following the subject out of the parameter it sits in and into the
 * repository's own call sites (see the header over `repoResolver`):
 *
 *   admin-api/src/actions.ts  ×2   engagement-treasury, engagement  (a const and a helper one file away)
 *   beacon/src/browser/money.ts    user                             (fixtures.ts builds `user:${id}`)
 *   emberkin/src/ledgerclient.ts   user                             (seasons.ts, same shape)
 *   mint/src/ledgerclient.ts       user                             (three hops: server.ts `userSubject(userId)`)
 *   worlds/src/ledgerclient.ts     user                             (rewards.ts, same shape)
 *
 * All six agree with the chart, which is the answer to the question the 11→12 and 12→13 raises
 * deferred: those entries were argued to be "probably consistent" and they were, and the argument
 * is now a computation rather than a hope.
 *
 * THREE more had their PURPOSE read where it was previously a wildcard — `foresight`'s
 * `'available' | 'escrow'` parameter, `ledger`'s `available`/`reserved` ternary, and `market`'s
 * `holder`, whose three call-site purposes are `available`, `reserved` and `payout_due`. Their
 * subjects are still unreadable (a database row in two cases, and `micro-ledger` serving every
 * subject there is in the third), so they are still counted here — but they are no longer invisible
 * to the `implausible` pass, which is the pass that can actually judge them.
 *
 * ONE PLACE WAS ADDED BY THE SAME CHANGE, and it is a gain wearing a loss's clothes.
 * `market/src/engagement.ts:223` was never in the thirteen because BOTH its purpose and its type
 * were unreadable, so the extractor did not recognise it as an account at all. Reading its purpose
 * made it visible; its type is a `'liability' | 'revenue'` union which is deliberately NOT expanded
 * (the cross product would invent `(fees, liability)` and `(available, revenue)`, two accounts no
 * call site asks for, and the second is exactly the shape of the defect this module hunts). So the
 * estate has one more place this cannot fully read than it did yesterday, and it always did.
 *
 * WHAT IS LEFT IS NOT A BACKLOG. Six of the eight take their subject from a DATABASE ROW —
 * `community.treasurySubject`, `spend.recipient`, `stake.subject`, `listing.sellerSubject`,
 * `subscription.subject` — and no source-level reader will ever resolve those, because the value
 * is not in the source. The seventh is `micro-ledger` itself, which serves every subject in the
 * estate by design. Driving this to zero would need the sweep to read the database, which is
 * reconciliation's job and not this module's.
 *
 * ── 2026-09-01, micro-org#499. STILL EIGHT, AND IT HAD READ TEN AND NINETEEN. ────────────────────
 *
 * The gate failed at 9 against this 8, then at 19 after the service merge. Neither number was a
 * blind spot growing; both were this checker misreading an estate that had not changed. Written
 * down here because the rule below says a MOVE needs a reason, and a number that stayed put
 * through two false alarms needs one at least as much — otherwise the next reader finds an
 * unchanged constant and no record that anything happened to it.
 *
 * THE NINTH PLACE WAS NEVER UNREADABLE. `wallet/src/money.ts`'s `desk()` writes
 * `{ subject: DESK_SUBJECT, assetCode, purpose: 'inventory', type: 'equity' }` — a named constant
 * and two plain string literals. It reported as "purpose not static" for one reason: ledger
 * migration 18 added `inventory` to `accounts_purpose_chk` for the Forge Exchange desk, and
 * `ACCOUNT_PURPOSES` here — a hand-copied mirror of that constraint — was not touched. A literal
 * outside the vocabulary is not recognised as a purpose at all, so the most readable account in
 * the estate spent a budget line and failed the estate gate. `vocabularyDrift` now reads both
 * constraints out of `ledger/src/migrations.ts` and refuses the run on either direction of drift;
 * the retired direction is the one worth fearing, because a word left here after the ledger drops
 * it would let this sweep BLESS a value the check constraint rejects. `CANONICAL_ACCOUNTS` gained
 * the desk's `(exchange, inventory, equity)` row in the same change, so `inventory` is now a
 * purpose the chart judges rather than one it says nothing about.
 *
 * THE OTHER TEN PLACES WERE ONE SERVICE COUNTED TWICE. The merge moved sixteen services into
 * `agora/src/<name>/` and deleted no repository, so the sweep read each of them in both places and
 * the count doubled overnight. `absorptionsOf` derives that from the layout and reads the LIVE
 * copy — the one the pod runs — skipping the frozen checkout. The drift between the two was
 * already real: `market/src/server.ts:1622` and `agora/src/market/server.ts:1623` are a line
 * apart, and a TYPE that had drifted would have been reported as a disagreement between two
 * services that are one service and its own dead copy.
 *
 * AND THE MERGE HAD QUIETLY WEAKENED THE RESOLVER, which is the finding worth the most. One
 * resolver per repository was one resolver per service until `agora` became sixteen of them;
 * afterwards `micro-mint`'s call sites could answer `micro-market`'s helper, which is the exact
 * cross-service guess `repoResolver`'s docstring exists to forbid. It had already cost readings:
 * swept whole, `market/src/ledgerclient.ts`'s purpose went from resolved to "not static" and
 * emberkin's and worlds' subjects went with it. The resolver now scopes to the MODULE, because
 * the merge changed the process boundary and not the service boundary — and with it, the eight
 * places below are the same eight this entry's predecessor described.
 *
 * **The rule from the 11→12 entry stands unchanged: raising this again means reading the new line
 * and writing down why, here.** A budget that moves whenever it is inconvenient measures nothing.
 *
 * Counted in PLACES rather than claims — see `Reconciliation.unresolvedSites`. One literal can now
 * yield several claims, and a metric that grew when a literal became MORE readable would be the
 * first thing anybody argued with.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
export const BASELINE_UNRESOLVED = 8

/**
 * The smallest number of repositories a sweep may ACCOUNT FOR and still claim to have swept the
 * estate.
 *
 * `sweepEstate` silently skips a directory that is not there, which is the correct behaviour for a
 * partial checkout and a catastrophic one for a gate: an empty parent directory would produce
 * "0 disagreements" and pass.
 *
 * ACCOUNTED FOR, not read — `services.length + absorbed.length`, and the distinction started
 * mattering the day the merge landed. Twenty checkouts are now read inside another checkout rather
 * than on their own, so `services.length` alone fell from 62 to 42 with no repository having gone
 * anywhere. Grading on that number would have put a floor of 40 two absorptions away from
 * refusing a complete estate as partial, which is a gate that fails when the estate gets tidier.
 * The sum is what the guard always meant: 62 repositories were accounted for, none was silently
 * absent.
 */
export const MIN_SERVICES = 40

export interface SweepResult {
  readonly claims: readonly AccountClaim[]
  /** Every repository actually read. A caller must ASSERT this rather than trust it. */
  readonly services: readonly string[]
  /** Deliberately not read, and why the caller can see it. */
  readonly excluded: readonly string[]
  /**
   * A checkout skipped because its code now runs inside another repository — see `absorptionsOf`.
   *
   * In the report for the same reason `excluded` is: a repository the sweep did not open must
   * never be invisible, or "swept 48 repositories" becomes a number nobody can check.
   */
  readonly absorbed: readonly Absorption[]
  /** Every `.ts` file opened. The denominator behind "the sweep found nothing". */
  readonly filesRead: number
}

/** One repository whose sources are read from the repository that absorbed it. */
export interface Absorption {
  readonly service: string
  /** The repository holding it now. */
  readonly into: string
  /**
   * Where its sources are, relative to that repository — `src/wallet`, `src/activity/notify`.
   *
   * NESTED, and it has to be: `notify` was absorbed into `activity` and `activity` into `agora`, so
   * it sits two levels down. Reading only the first level attributed notify's files to `activity`,
   * which meant notify's own `migrations.ts` — the one with the secret-bearing column — was never
   * opened, and ten of its routes left the key-material gate without anybody deciding they should.
   */
  readonly path: string
}

/**
 * Which checkouts are now MODULES of another checkout, derived from the layout rather than listed.
 *
 * The service merge (micro-org#517 and the M-waves behind it) moved sixteen services into
 * `agora/src/<name>/` without deleting a single repository — deliberately, because the standalone
 * checkout is still where the history is and still where a rollback would start. The consequence
 * for a sweep that walks the estate directory is that every one of those services is read TWICE,
 * and that is not merely a doubled number:
 *
 *   * The unresolved budget is measured in PLACES, and one place became two. The count went from
 *     nine to nineteen the day the merge landed, with nothing about the estate having changed.
 *   * Worse, the two copies DRIFT — `market/src/server.ts:1622` and `agora/src/market/server.ts:1623`
 *     are already a line apart. A type changed in the live module and not backported to the frozen
 *     checkout would be reported as a DISAGREEMENT between two services, and the two services
 *     would be one service and its own dead copy. A gate that invents conflicts is a gate people
 *     turn off.
 *
 * THE LIVE COPY WINS. `agora/src/market/` is what the pod runs; `market/src/` is what it was cut
 * from. Reading the frozen one would be this repository's own worst failure mode — a check that
 * certifies code which is not the code in production — so the absorbed checkout is skipped and its
 * findings come back under a path that still names it, `agora/src/market/...`, which opens.
 *
 * Derived from the directories, and NOT from `deploy/scripts/k8s-render.py`'s `MERGED_INTO`. Two
 * reasons: that map is service-to-service for rendering Deployments and says nothing about where
 * sources ended up, and reading it would make this sweep depend on a second sibling repository
 * for a fact the checkouts already state. The layout cannot be stale, because it IS the thing
 * being read.
 *
 * The evidence required is deliberately more than a matching name. A directory called `policy`
 * inside another repository proves nothing on its own, so a majority of the standalone
 * repository's own top-level `src/*.ts` basenames must also be present in the module directory.
 * A coincidental name does not clear that; a copied service clears it by a mile — the sixteen in
 * this estate each match all but one or two files, the bootstrap that the absorbing kernel
 * replaced.
 */
export function absorptionsOf(estateDir: string, repos: readonly string[]): readonly Absorption[] {
  const candidates = new Set(repos.filter((repo) => isDirectory(join(estateDir, repo, 'src'))))
  // Three levels below `src/`, because the estate already has two — `agora/src/activity/notify` —
  // and a merge of a merge is the shape these waves keep producing. Bounded rather than unbounded
  // so a symlink loop or a fixtures tree cannot turn a source sweep into a filesystem walk.
  const MAX_DEPTH = 3
  const discover = (absorbers: readonly string[]): Absorption[] => {
  const found: Absorption[] = []
  for (const absorber of absorbers) {
    const descend = (relativeDir: string, depth: number): void => {
      if (depth > MAX_DEPTH) return
      let entries: string[]
      try {
        entries = readdirSync(join(estateDir, absorber, relativeDir)).sort()
      } catch {
        return
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue
        const relativeModule = join(relativeDir, entry)
        const moduleDir = join(estateDir, absorber, relativeModule)
        if (!isDirectory(moduleDir)) continue
        if (
          entry !== absorber &&
          candidates.has(entry) &&
          !found.some((existing) => existing.service === entry) &&
          looksLikeACopy(join(estateDir, entry, 'src'), moduleDir)
        ) {
          found.push({ service: entry, into: absorber, path: relativeModule })
        }
        descend(relativeModule, depth + 1)
      }
    }
    descend('src', 1)
  }
  return found
  }

  /*
   * TWO ROUNDS, AND THE SECOND IS NOT AN OPTIMISATION.
   *
   * `notify` was absorbed into `activity` and `activity` into `agora`, so `notify`'s sources exist
   * in three places: its own checkout, `activity/src/notify`, and `agora/src/activity/notify`. A
   * single round scanning every candidate as an absorber finds the middle one first and records
   * `notify → activity` — pointing at a repository that is itself skipped, so notify's files are
   * then read from NOWHERE. That is the failure this whole function exists to prevent, arrived at
   * from the other direction.
   *
   * So the first round establishes only WHICH repositories are absorbed, and the second re-runs the
   * search with those barred from absorbing anything. What is left are the repositories that
   * actually run, and every module resolves to one of them.
   */
  const absorbedAnywhere = new Set(discover([...candidates].sort()).map((entry) => entry.service))
  return discover([...candidates].sort().filter((repo) => !absorbedAnywhere.has(repo)))
}

/** A majority of the standalone repository's own top-level sources, by name, present in the module. */
function looksLikeACopy(standaloneSrc: string, moduleDir: string): boolean {
  const namesIn = (dir: string): Set<string> => {
    try {
      return new Set(readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')))
    } catch {
      return new Set()
    }
  }
  const standalone = namesIn(standaloneSrc)
  if (standalone.size < 3) return false
  const module = namesIn(moduleDir)
  let shared = 0
  for (const name of standalone) if (module.has(name)) shared += 1
  return shared * 2 > standalone.size
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

  /*
   * micro-contracts' `AccountSubject` constants, read ONCE for the whole sweep and handed to every
   * repository's resolver. See `repoResolver`'s second parameter for why this one cross-repository
   * lookup is permitted where the rest are refused.
   *
   * Read here rather than taken as an option because the sweep already knows where the estate is,
   * and a caller that had to supply it would be a caller that could forget to. Unreadable is the
   * empty map — which resolves nothing and costs a budget line per site, the same as before this
   * existed. The CLI's grammar check fails the run loudly on the same file, so a silent empty map
   * cannot be the only signal that contracts is missing.
   */
  let subjectConstants: ReadonlyMap<string, string> = new Map()
  try {
    subjectConstants = accountSubjectConstants(
      readFileSync(join(options.estateDir, 'contracts', 'packages', 'money', 'src', 'index.ts'), 'utf8'),
    )
  } catch {
    subjectConstants = new Map()
  }

  // Before the loop, because whether a repository is read at all depends on the WHOLE layout: a
  // checkout is skipped only once another checkout is shown to be holding its sources.
  const absorbed = absorptionsOf(
    options.estateDir,
    repos.filter((repo) => !SKIP_DIRS.has(repo) && !excluded.includes(repo)),
  )
  const absorbedNames = new Set(absorbed.map((entry) => entry.service))

  for (const repo of repos) {
    if (SKIP_DIRS.has(repo)) continue
    if (excluded.includes(repo)) continue
    if (absorbedNames.has(repo)) continue

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

    // PARSE THE WHOLE REPOSITORY BEFORE READING ANY OF IT. The subject of a claim in
    // `worlds/src/ledgerclient.ts` is decided by the call in `worlds/src/rewards.ts`, so a loop
    // that extracted file by file could never see it — which is why every one of the thirteen
    // literals micro-org#264 lists was unreadable. The resolver is per REPOSITORY and never wider:
    // letting one service's call sites answer for another's helper would be the cross-service guess
    // this module exists to catch rather than commit.
    const parsed: RepoSource[] = []
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
      parsed.push({ file: relativeFile, tree: parseSource(relativeFile, text) })
    }

    /*
     * ONE RESOLVER PER SERVICE, WHICH IS NO LONGER ONE RESOLVER PER REPOSITORY.
     *
     * `repoResolver`'s own docstring states the rule it enforces: "Passing the whole estate would
     * let `micro-market`'s `holder` be answered by `micro-mint`'s call sites, which is exactly the
     * cross-service guess this whole module exists to catch rather than commit." After the merge,
     * `agora` HOLDS market and mint — so a single resolver over the repository is that cross-service
     * guess, arrived at without anybody choosing it.
     *
     * It is not theoretical. Sweeping merged `agora` under one resolver moved
     * `market/src/ledgerclient.ts`'s purpose from readable to "not static", because a second
     * module's call sites widened the union past the cap. The merge changed the PROCESS boundary;
     * it did not change the service boundary, and the resolver follows the service.
     *
     * So each absorbed module directory is its own scope, and the absorbing repository's own
     * top-level sources are one more. A repository that absorbed nothing has exactly one scope and
     * behaves precisely as it did before this existed.
     */
    // Longest path wins, so `src/activity/notify/x.ts` scopes to notify and not to activity. A
    // first-match rule would put a nested module's files in its parent's scope, which is the same
    // cross-service resolution one level further in.
    const modules = absorbed
      .filter((entry) => entry.into === repo)
      .map((entry) => entry.path + sep)
      .sort((a, b) => b.length - a.length)
    const scopes = new Map<string, RepoSource[]>()
    for (const source of parsed) {
      const module = modules.find((path) => source.file.startsWith(path)) ?? ''
      const bucket = scopes.get(module)
      if (bucket) bucket.push(source)
      else scopes.set(module, [source])
    }
    for (const sources of scopes.values()) {
      const resolver = repoResolver(sources, subjectConstants)
      for (const source of sources) claims.push(...claimsFromTree(repo, source.file, source.tree, resolver))
    }
  }

  return { claims, services, excluded, absorbed, filesRead }
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
  /**
   * How many PLACES in the estate are unresolved — distinct `service/file:line`, not claims.
   *
   * The budget is measured in places rather than claims because one literal can now produce
   * several claims: `foresight`'s helper takes `purpose: 'available' | 'escrow'` and yields a claim
   * for each. Counting claims would have made reading that literal BETTER look like the blind spot
   * growing, which is precisely the sort of number that gets quietly raised. A place is what a
   * human goes and fixes, and it is what the budget's own docblock has always described.
   */
  readonly unresolvedSites: number
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

/** The place a claim was read from. Several claims can share one — see `unresolvedSites`. */
function siteOf(claim: AccountClaim): string {
  return `${claim.service}/${claim.file}:${claim.line}`
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
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **WHY A WILDCARD SUBJECT STILL DOES NOT JOIN THE DISAGREEMENT PASS.** micro-org#264 proposes it,
 * in as many words: *"a claim `(*, *, available) → liability` is not uncheckable: it conflicts with
 * any claim of purpose `available` and a different type"*. That is wrong, and the counterexample is
 * in `CANONICAL_ACCOUNTS` in this file rather than in some hypothetical service:
 *
 *     custody   / available → asset        user      / available → liability
 *     clearing  / available → clearing     community / available → liability
 *
 * Purpose `available` is legitimately three different types depending on WHOSE account it is, so a
 * claim that does not know whose it is conflicts with nothing. Admitting it to the pairwise pass
 * would have reported `billing`'s user credit as disagreeing with `beacon`'s custody debit on the
 * first run — a false red on the estate's most-copied pair of postings, which is how a gate stops
 * being believed.
 *
 * The sound version of that idea is the `implausible` pass above, and it was already here: it
 * checks the `(purpose, type)` PAIR against the chart for every claim, resolved subject or not. So
 * "reported and counted, never checked" — the sentence in #264 and in this module's own header —
 * was itself inaccurate. Of the thirteen literals #264 lists, ten already had a readable pair and
 * were checked by it; the three that escaped did so because their PURPOSE was unreadable, not
 * their subject, and that is the half of #264 this change actually closes.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
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
  const unresolvedSites = new Set(unresolved.map(siteOf)).size
  return {
    disagreements,
    uncanonical,
    implausible,
    unresolved,
    unresolvedSites,
    resolvedClaims: resolved.length,
    ok:
      disagreements.length === 0 &&
      uncanonical.length === 0 &&
      implausible.length === 0 &&
      unresolvedSites <= maxUnresolved,
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
    if (sweep.absorbed.length > 0) {
      lines.push(
        `  read inside another checkout, not twice: ${sweep.absorbed
          .map((entry) => `${entry.service}→${entry.into}`)
          .join(' ')}`,
      )
    }
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
  lines.push(
    `${result.resolvedClaims} claims resolved, ${result.unresolved.length} not, ` +
      `in ${result.unresolvedSites} ${result.unresolvedSites === 1 ? 'place' : 'places'}:`,
  )
  // One line per PLACE. A literal whose purpose expands to two accounts is two claims and one
  // thing to go and look at, and a report that printed it twice would be read as two blind spots.
  const printed = new Set<string>()
  for (const claim of result.unresolved) {
    const parts = [
      claim.subject === '*' ? 'subject' : null,
      claim.purpose === '*' ? 'purpose' : null,
      claim.type === '*' ? 'type' : null,
    ].filter((part) => part !== null)
    const line = `    ${siteOf(claim)}  (${parts.join(', ')} not static)  ${claim.text}`
    if (printed.has(line)) continue
    printed.add(line)
    lines.push(line)
  }
  return lines.join('\n')
}

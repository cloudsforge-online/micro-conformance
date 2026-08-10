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
export function repoResolver(sources: readonly RepoSource[]): Resolver {
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

    const resolver = repoResolver(parsed)
    for (const source of parsed) claims.push(...claimsFromTree(repo, source.file, source.tree, resolver))
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

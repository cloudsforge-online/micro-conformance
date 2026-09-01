/**
 * The account-type sweep, judged.
 *
 * **Every case here reintroduces a real defect and asserts the sweep goes RED on it.** A guard
 * proved only against code that already passes is a guard nobody has watched fail, and this
 * repository has shipped three of those: a CI job that built an image and read its metadata without
 * ever running it, a grep rule over files holding raw NUL bytes that `grep` skipped in silence, and
 * a test that graded an unchanged input.
 *
 * The fixtures are source text rather than files on disk, so these run with no estate checked out —
 * which is the only way they can run in this repository's CI at all. What they therefore prove is
 * that the ANALYSER is correct, not that the estate is clean; the estate half needs
 * `conformance ledger-accounts --estate ..` against the sibling checkouts, and the two are
 * different claims. See the note at the end of this file.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import {
  type AccountClaim,
  BASELINE_UNRESOLVED,
  CANONICAL_ACCOUNTS,
  MIN_SERVICES,
  UnreadableSourceError,
  extractAccountClaims,
  formatGrammarDrift,
  formatReconciliation,
  formatVocabularyDrift,
  reconcileAccountClaims,
  subjectGrammarDrift,
  subjectKindOf,
  accountSubjectConstants,
  sweepEstate,
  absorptionsOf,
  vocabularyDrift,
} from './ledgeraccounts.ts'

/**
 * One repository on disk, swept.
 *
 * Files rather than strings, and a whole repository rather than one file, because that is the unit
 * the resolver works in and the single-file fixtures above cannot express the thing every case in
 * `resolving a subject the estate actually writes` is about: the value is in ANOTHER FILE. Writing
 * these as two source strings passed to `extractAccountClaims` would have passed while proving the
 * opposite of what they claim.
 */
function sweepOneRepo(files: Readonly<Record<string, string>>, service = 'svc'): AccountClaim[] {
  const dir = mkdtempSync(join(tmpdir(), 'cf-repo-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      const full = join(dir, service, 'src', name)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, source)
    }
    return [...sweepEstate({ estateDir: dir, exclude: [] }).claims]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The one claim a fixture is about, or a readable failure naming what was actually found. */
function oneClaim(claims: readonly AccountClaim[]): AccountClaim {
  assert.equal(claims.length, 1, claims.map((c) => `${c.file}:${c.line} ${c.subject}/${c.purpose}`).join(', '))
  return claims[0] as AccountClaim
}

/** micro-market, micro-trade, micro-wallet et al: the platform fee line, credited. */
const REVENUE_SOURCE = `
  export function platformFees(assetCode: LedgerAssetCode): AccountRef {
    return { subject: 'platform', assetCode, purpose: 'fees', type: 'revenue' }
  }
`

/** micro-emberkin and micro-worlds as they were: the SAME key, typed 'expense'. */
const EXPENSE_SOURCE = `
  export function rewardPostings(input: Input): readonly PostingRequest[] {
    return [
      {
        account: { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'expense' },
        direction: 'debit',
        amount: input.amount,
        assetCode: 'SHARD',
        sequence: 0,
      },
    ]
  }
`

describe('the defect it exists to catch', () => {
  it('goes RED when one service types (platform, SHARD, fees) expense and another revenue', () => {
    const claims = [
      ...extractAccountClaims('market', 'src/ledgerclient.ts', REVENUE_SOURCE),
      ...extractAccountClaims('emberkin', 'src/ledgerclient.ts', EXPENSE_SOURCE),
    ]
    const result = reconcileAccountClaims(claims)

    assert.equal(result.ok, false, 'the reconciliation must FAIL')
    assert.equal(result.disagreements.length, 1)
    assert.deepEqual(result.disagreements[0]?.types, ['expense', 'revenue'])

    // The report has to name both sides, or a reader cannot act on it.
    const report = formatReconciliation(result)
    assert.match(report, /market\/src\/ledgerclient\.ts/)
    assert.match(report, /emberkin\/src\/ledgerclient\.ts/)
  })

  it('goes GREEN once the offender moves to its engagement account', () => {
    const fixed = `
      export function rewardPostings(input: Input): readonly PostingRequest[] {
        return [
          {
            account: {
              subject: engagementAccount('emberkin', 'SHARD').subject,
              assetCode: 'SHARD',
              purpose: 'treasury',
              type: 'equity',
            },
            direction: 'debit',
          },
        ]
      }
    `
    const claims = [
      ...extractAccountClaims('market', 'src/ledgerclient.ts', REVENUE_SOURCE),
      ...extractAccountClaims('emberkin', 'src/ledgerclient.ts', fixed),
    ]
    const result = reconcileAccountClaims(claims)
    assert.equal(result.ok, true, formatReconciliation(result))
    assert.equal(result.disagreements.length, 0)
  })

  it('catches the FIRST service to invent a wrong type, before a second one exists to disagree', () => {
    // This is the pass that shortens the defect's life from "until another service posts" to "now".
    // With only one claim there is nothing to disagree with, and it must still fail.
    const result = reconcileAccountClaims(extractAccountClaims('emberkin', 'src/x.ts', EXPENSE_SOURCE))
    assert.equal(result.disagreements.length, 0, 'nothing to disagree with, by construction')
    assert.equal(result.uncanonical.length, 1)
    assert.equal(result.uncanonical[0]?.expected, 'revenue')
    assert.match(result.uncanonical[0]?.because ?? '', /ledger\/src\/accounts\.ts/)
    assert.equal(result.ok, false)
  })

  it('catches a wrong type even when the SUBJECT cannot be read', () => {
    // A third of the estate writes `subject: input.subject`. Neither comparison above can touch
    // those, so the (purpose, type) pair is checked on its own — no subject in this estate has an
    // `available` account of type `revenue`.
    const source = `
      const account = { subject: input.subject, assetCode: 'SHARD', purpose: 'available', type: 'revenue' }
    `
    const result = reconcileAccountClaims(extractAccountClaims('rogue', 'src/x.ts', source))
    assert.equal(result.unresolved.length, 1, 'the subject is genuinely unreadable')
    assert.equal(result.implausible.length, 1)
    assert.deepEqual([...(result.implausible[0]?.allowed ?? [])].sort(), ['asset', 'clearing', 'liability'])
    assert.equal(result.ok, false)
  })

  it('an asset held in a variable collides with every concrete asset', () => {
    // micro-settlement's exact shape: `assetCode` comes off a database row, so its claim could be
    // any asset and must be compared against all of them. A checker that treated `*` as its own
    // key would have found nothing here — which is how this instance survived.
    const settlement = `
      const account = { subject: 'platform', assetCode, purpose: 'fees', type: 'expense' }
    `
    const foresight = `
      const account = { subject: 'platform', assetCode: 'EMBER', purpose: 'fees', type: 'revenue' }
    `
    const result = reconcileAccountClaims([
      ...extractAccountClaims('settlement', 'src/fees.ts', settlement),
      ...extractAccountClaims('foresight', 'src/ledgerclient.ts', foresight),
    ])
    assert.equal(result.disagreements.length, 1)
    assert.equal(result.ok, false)
  })

  it('reports one finding per component, not one per pair', () => {
    // Collision is not transitive across wildcards, so a naive pairing reported the single
    // settlement/emberkin defect three times with overlapping member lists.
    const result = reconcileAccountClaims([
      ...extractAccountClaims('a', 'a.ts', `const x = { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' }`),
      ...extractAccountClaims('b', 'b.ts', `const x = { subject: 'platform', assetCode: 'EMBER', purpose: 'fees', type: 'revenue' }`),
      ...extractAccountClaims('c', 'c.ts', `const x = { subject: 'platform', assetCode, purpose: 'fees', type: 'expense' }`),
    ])
    assert.equal(result.disagreements.length, 1)
    assert.equal(result.disagreements[0]?.claims.length, 3)
  })
})

describe('extraction sees what a pattern would miss', () => {
  it('reads a literal spread over many lines, inside a nested call argument', () => {
    const source = `
      await ledger.postEntry({
        kind: 'reward_granted',
        postings: [
          {
            account: {
              subject: 'platform',
              assetCode: 'SHARD',
              purpose:
                'fees',
              type: 'expense',
            },
          },
        ],
      })
    `
    const claims = extractAccountClaims('svc', 'src/x.ts', source)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.purpose, 'fees')
    assert.equal(claims[0]?.type, 'expense')
  })

  it('resolves a subject built by a contracts-money factory', () => {
    const source = `const a = { subject: userSubject(id), assetCode: 'SHARD', purpose: 'available', type: 'liability' }`
    const claims = extractAccountClaims('svc', 'src/x.ts', source)
    assert.equal(claims[0]?.subject, 'user')
    assert.equal(claims[0]?.unresolved, false)
  })

  it('resolves a subject lifted into a same-file constant', () => {
    // The tidier the code, the less a naive reader sees. `micro-trade` writes exactly this.
    const source = `
      const subject = userSubject(input.userId)
      const wallet = { subject, assetCode: 'SHARD', purpose: 'available', type: 'liability' }
    `
    const claims = extractAccountClaims('trade', 'src/x.ts', source)
    assert.equal(claims[0]?.subject, 'user')
    assert.equal(claims[0]?.unresolved, false)
  })

  it('resolves a template-literal subject by its prefix', () => {
    const source = 'const a = { subject: `user:${id}`, assetCode: "SHARD", purpose: "available", type: "liability" }'
    assert.equal(extractAccountClaims('svc', 'src/x.ts', source)[0]?.subject, 'user')
  })

  it('marks a type decided at runtime unresolved rather than guessing', () => {
    const source = `const a = { subject: 'platform', purpose: 'fees', type: cond ? 'revenue' : 'expense' }`
    const claims = extractAccountClaims('svc', 'src/x.ts', source)
    assert.equal(claims[0]?.type, '*')
    assert.equal(claims[0]?.unresolved, true)
  })

  it('ignores an object that merely shares two field names', () => {
    const source = `const job = { purpose: 'nightly', type: 'cron' }`
    assert.deepEqual(extractAccountClaims('svc', 'src/x.ts', source), [])
  })

  it('reports the line, so a finding can be opened', () => {
    const source = `\n\n\nconst a = { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' }\n`
    assert.equal(extractAccountClaims('svc', 'src/x.ts', source)[0]?.line, 4)
  })
})

describe('it refuses rather than skips', () => {
  it('throws on a NUL byte instead of quietly reading nothing', () => {
    // The previous static check in this repository was defeated by exactly this: `grep` decided a
    // NUL-bearing file was binary and skipped it without a word, and the rule reported green.
    const source = `const a = { subject: 'platform', purpose: 'fees', type: 'revenue' }\u0000`
    assert.throws(() => extractAccountClaims('svc', 'src/x.ts', source), UnreadableSourceError)
  })

  it('accepts a U+FFFD, which is a legitimate character in real source', () => {
    // `lantern/src/otlp.ts` holds one as the sentinel it trims off a truncated string. An
    // over-strict refusal would make a real file invisible, which is the same failure wearing the
    // opposite hat.
    const source = `const cut = '�'\nconst a = { subject: 'platform', purpose: 'fees', type: 'revenue' }`
    assert.equal(extractAccountClaims('lantern', 'src/otlp.ts', source).length, 1)
  })

  it('throws on a file that is not valid UTF-8, rather than decoding it to nonsense', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-sweep-'))
    try {
      mkdirSync(join(dir, 'svc', 'src'), { recursive: true })
      // A lone 0x80 continuation byte: not valid UTF-8 in any position.
      writeFileSync(join(dir, 'svc', 'src', 'bad.ts'), Buffer.from([0x80, 0x61]))
      assert.throws(() => sweepEstate({ estateDir: dir, exclude: [] }), UnreadableSourceError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports which repositories it actually read, so a partial checkout cannot certify anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-sweep-'))
    try {
      mkdirSync(join(dir, 'one', 'src'), { recursive: true })
      writeFileSync(
        join(dir, 'one', 'src', 'a.ts'),
        `const a = { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' }`,
      )
      const sweep = sweepEstate({ estateDir: dir, exclude: [] })
      assert.deepEqual(sweep.services, ['one'])
      assert.equal(sweep.claims.length, 1)
      // Green on one repository. `MIN_SERVICES` is what stops the CLI calling that an estate sweep.
      assert.ok(sweep.services.length < MIN_SERVICES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when more literals are unresolvable than the budget allows', () => {
    const source = `
      const a = { subject: input.a, assetCode: 'SHARD', purpose: 'available', type: 'liability' }
      const b = { subject: input.b, assetCode: 'SHARD', purpose: 'available', type: 'liability' }
    `
    const claims = extractAccountClaims('svc', 'src/x.ts', source)
    assert.equal(reconcileAccountClaims(claims, { maxUnresolved: 2 }).ok, true)
    assert.equal(reconcileAccountClaims(claims, { maxUnresolved: 1 }).ok, false)
  })

  it('names every unresolvable literal in the report rather than dropping it', () => {
    const source = `const a = { subject: input.a, assetCode: 'SHARD', purpose: 'available', type: 'liability' }`
    const result = reconcileAccountClaims(extractAccountClaims('svc', 'src/deep/x.ts', source))
    assert.match(formatReconciliation(result), /svc\/src\/deep\/x\.ts:1 {2}\(subject not static\)/)
  })
})

describe('the estate itself, when it is on disk', () => {
  // The only case here that judges the ESTATE rather than the analyser, and it can only run where
  // the sibling checkouts are. A skip is honest and is never counted as a pass — the same rule this
  // harness applies to a scenario that could not reach a service — so the reason names what was
  // missing rather than leaving a silent green.
  const estateDir = join(import.meta.dirname, '..', '..')
  let present = 0
  try {
    // Read PLUS absorbed, the same sum the CLI grades on — twenty checkouts are now read inside
    // another checkout, and counting only what was opened would skip this case on a complete estate.
    const probe = sweepEstate({ estateDir })
    present = probe.services.length + probe.absorbed.length
  } catch {
    present = 0
  }
  const reason =
    present >= MIN_SERVICES
      ? false
      : `only ${present} sibling repositories under ${estateDir}; this case needs the estate checked out`

  it('every account type the estate states agrees with every other', { skip: reason }, () => {
    const sweep = sweepEstate({ estateDir })
    const result = reconcileAccountClaims(sweep.claims, { maxUnresolved: BASELINE_UNRESOLVED })
    assert.equal(result.ok, true, formatReconciliation(result, sweep))
  })
})

describe('the chart itself', () => {
  it('has one type per (subject, purpose) — a table that disagreed with itself would judge nothing', () => {
    const seen = new Map<string, string>()
    for (const entry of CANONICAL_ACCOUNTS) {
      const key = `${entry.subject}|${entry.purpose}`
      const prior = seen.get(key)
      assert.equal(prior ?? entry.type, entry.type, `${key} is both ${String(prior)} and ${entry.type}`)
      seen.set(key, entry.type)
    }
  })

  it('gives every row a justification, so a wrong row can be argued with', () => {
    for (const entry of CANONICAL_ACCOUNTS) {
      assert.ok(entry.because.length > 20, `${entry.subject}/${entry.purpose} has no reason`)
    }
  })

  it('says platform fees are revenue, which is what decided both fixes', () => {
    const fees = CANONICAL_ACCOUNTS.find((e) => e.subject === 'platform' && e.purpose === 'fees')
    assert.equal(fees?.type, 'revenue')
  })

  it('classifies subjects the way parseAccountSubject does', () => {
    assert.equal(subjectKindOf('platform'), 'platform')
    assert.equal(subjectKindOf('platform:engagement-treasury'), 'engagement-treasury')
    assert.equal(subjectKindOf('engagement:worlds'), 'engagement')
    assert.equal(subjectKindOf('user:01H'), 'user')
    assert.equal(subjectKindOf('chain:ethereum'), 'chain')
    assert.equal(subjectKindOf('exchange'), 'exchange')
    assert.equal(subjectKindOf('nonsense'), '*')
  })
})

/**
 * The case above asserts six hand-written strings, and six hand-written strings cannot notice a
 * subject `micro-contracts` adds or retires. micro-org#372 is what that costs: `micro-trade` wrote
 * `subject: 'exchange'`, no grammar had it, and the sweep reported it as a line it could not read
 * rather than as a posting the ledger would throw on.
 *
 * The fixtures are source text, so these run in this repository's own CI with no estate on disk —
 * the same reason every case in this file is a string. `doLedgerAccounts` is what points the
 * function at the real `micro-contracts` checkout, and estate-ci is what runs that.
 */
describe('the subject grammar, against the file that decides it', () => {
  const union = (...members: readonly string[]): string =>
    `export type AccountSubject =\n${members.map((m) => `  | ${m}\n`).join('')}\nexport type ParsedSubject =\n`

  const TODAY = union(
    '`user:${string}`',
    '`community:${string}`',
    '`organisation:${string}`',
    "'platform'",
    "'custody'",
    "'clearing'",
    "'exchange'",
    "'platform:engagement-treasury'",
    '`engagement:${string}`',
    '`chain:${string}`',
  )

  it('agrees with the grammar as it stands', () => {
    assert.deepEqual(subjectGrammarDrift(TODAY), { unknown: [], retired: [], unreadable: false })
    assert.equal(formatGrammarDrift(subjectGrammarDrift(TODAY)), null)
  })

  it('goes RED on a subject contracts declares and this sweep cannot classify — micro-org#372', () => {
    const withNewSubject = TODAY.replace("  | 'exchange'\n", "  | 'exchange'\n  | 'settlement'\n")
    const drift = subjectGrammarDrift(withNewSubject)
    assert.deepEqual([...drift.unknown], ['settlement'])
    assert.equal(drift.retired.length, 0)
    assert.match(formatGrammarDrift(drift) ?? '', /counted unreadable instead of judged/)
  })

  it('goes RED on a PREFIXED subject contracts declares and this sweep cannot classify', () => {
    const drift = subjectGrammarDrift(TODAY.replace('  | `chain:${string}`\n', '  | `chain:${string}`\n  | `vault:${string}`\n'))
    assert.deepEqual([...drift.unknown], ['vault:<id>'])
  })

  it('goes RED the other way too — a kind here contracts has retired would bless a refused spelling', () => {
    const drift = subjectGrammarDrift(TODAY.replace("  | 'clearing'\n", ''))
    assert.deepEqual([...drift.retired], ['clearing'])
    assert.equal(drift.unknown.length, 0)
    assert.match(formatGrammarDrift(drift) ?? '', /the ledger throws on/)
  })

  it('reports a union it could not read as UNCHECKED, never as agreement', () => {
    for (const source of ['', 'export type AccountSubject = string\n', 'export type Something = 1\n']) {
      const drift = subjectGrammarDrift(source)
      assert.equal(drift.unreadable, true, `'${source.slice(0, 30)}' must not read as agreement`)
      assert.match(formatGrammarDrift(drift) ?? '', /UNCHECKED, which is not the same as agreed/)
    }
  })
})

describe('resolving a subject the estate actually writes', () => {
  // Every claim micro-org#264 lists holds its subject in a function PARAMETER, and the value is
  // decided by a caller in another file. These cases are that shape, and the first one is the
  // defect this whole module exists to catch — reachable only because of the cross-file pass.

  it('goes RED on a wrong type whose subject is only knowable from ANOTHER FILE', () => {
    const client = `
      export function rewardPostings(input: { readonly subject: string; readonly amount: bigint }) {
        return [
          { account: { subject: input.subject, assetCode: 'SHARD', purpose: 'fees', type: 'expense' } },
        ]
      }
    `
    // The caller, and the only place in the repository that says whose account it is.
    const caller = `
      import { rewardPostings } from './ledgerclient.ts'
      export function pay(amount: bigint) {
        return rewardPostings({ subject: 'platform', amount })
      }
    `
    const claim = oneClaim(sweepOneRepo({ 'ledgerclient.ts': client, 'rewards.ts': caller }, 'emberkin'))
    assert.equal(claim.subject, 'platform')
    assert.equal(claim.unresolved, false)

    const result = reconcileAccountClaims([claim])
    assert.equal(result.uncanonical.length, 1, formatReconciliation(result))
    assert.equal(result.uncanonical[0]?.expected, 'revenue')
    assert.equal(result.ok, false)

    // And the proof that the CROSS-FILE pass is what found it: the same file read alone is blind.
    const alone = extractAccountClaims('emberkin', 'src/ledgerclient.ts', client)
    assert.equal(alone[0]?.subject, '*')
    assert.equal(reconcileAccountClaims(alone).uncanonical.length, 0)
  })

  it('follows a subject three hops, through two intermediate parameters', () => {
    // `micro-mint`'s real shape: the account literal is in `ledgerclient.ts`, the subject is a
    // parameter of `deployPostings`, whose caller passes a parameter of `payForDeploy`, whose
    // caller is the route that finally writes `userSubject(userId)`.
    const claims = sweepOneRepo({
      'ledgerclient.ts': `
        export function deployPostings(input: { readonly subject: string }) {
          return [{ account: { subject: input.subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
      'orders.ts': `
        export function payForDeploy(request: { readonly ownerSubject: string }) {
          return deployPostings({ subject: request.ownerSubject })
        }
      `,
      'server.ts': `
        export function route(userId: string) {
          return payForDeploy({ ownerSubject: userSubject(userId) })
        }
      `,
    })
    assert.equal(oneClaim(claims).subject, 'user')
  })

  it('follows a name into a module-level constant in another file of the same repository', () => {
    // `admin-api/src/actions.ts` writes `subject: ENGAGEMENT_TREASURY_SUBJECT`, one import away.
    const claims = sweepOneRepo({
      'engagement.ts': `export const TREASURY_SUBJECT = 'platform:engagement-treasury'`,
      'actions.ts': `
        import { TREASURY_SUBJECT } from './engagement.ts'
        const account = { subject: TREASURY_SUBJECT, assetCode: 'SHARD', purpose: 'treasury', type: 'equity' }
      `,
    })
    assert.equal(oneClaim(claims).subject, 'engagement-treasury')
  })

  it('follows a call into a one-line helper in another file', () => {
    // `engagementSubjectOf(service)` — admin-api again, and the answer is in the helper's `return`.
    const claims = sweepOneRepo({
      'engagement.ts': `export function subjectOf(service: string): string { return \`engagement:\${service}\` }`,
      'actions.ts': `
        import { subjectOf } from './engagement.ts'
        const account = { subject: subjectOf('worlds'), assetCode: 'SHARD', purpose: 'treasury', type: 'equity' }
      `,
    })
    assert.equal(oneClaim(claims).subject, 'engagement')
  })

  it('sees through a cast, which used to make a site LESS readable than the same code without one', () => {
    // `ledger/src/entries.ts` writes `request.subject as EnsureAccountInput['subject']`.
    const claims = sweepOneRepo({
      'entries.ts': `
        export function reserve(request: { readonly subject: string }) {
          return [{ account: { subject: request.subject as Subject, assetCode: 'EMBER', purpose: 'reserved', type: 'liability' } }]
        }
      `,
      'server.ts': `export function route(id: string) { return reserve({ subject: userSubject(id) }) }`,
    })
    assert.equal(oneClaim(claims).subject, 'user')
  })

  it('reads a parameter ANNOTATION when it narrows, with no call site at all', () => {
    // The half of #264 that is about types rather than call sites. It resolves here because the
    // annotation is a closed set declared in this repository — see the next two cases for why it
    // resolves nothing in the estate as it stands today.
    const claims = sweepOneRepo({
      'types.ts': `export type Holder = \`user:\${string}\``,
      'client.ts': `
        import type { Holder } from './types.ts'
        export function postings(subject: Holder) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
    })
    assert.equal(oneClaim(claims).subject, 'user')
  })
})

describe('what it refuses to resolve, and why each refusal is the honest answer', () => {
  it('a `string` annotation resolves NOTHING, which is what #264 proposed and why it was not enough', () => {
    // Measured against the estate before this was written: billing, emberkin, mint, worlds, beacon,
    // market and foresight all annotate the subject `string`; community and ledger annotate it
    // `AccountSubject`, which is the union of all nine spellings. Reading the annotation and
    // stopping there would have resolved zero of the thirteen. Pinned so nobody re-derives it.
    const claims = sweepOneRepo({
      'client.ts': `
        export function postings(subject: string) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
      'caller.ts': `export function pay(row: { subject: string }) { return postings(row.subject) }`,
    })
    assert.equal(oneClaim(claims).subject, '*')
  })

  it('an annotation spanning every kind is worth no more than the wildcard it would replace', () => {
    const claims = sweepOneRepo({
      'types.ts': `export type AnySubject = \`user:\${string}\` | 'platform' | 'custody'`,
      'client.ts': `
        import type { AnySubject } from './types.ts'
        export function postings(subject: AnySubject) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
    })
    assert.equal(oneClaim(claims).subject, '*')
  })

  it('a type this repository does not declare is left unresolved rather than guessed', () => {
    // `AccountSubject` lives in micro-contracts. There is no module resolver here — 24 repositories,
    // no shared tsconfig — so an unknown name is another repository's, and a guess about it would be
    // exactly the cross-service assumption this module exists to catch rather than commit.
    const claims = sweepOneRepo({
      'client.ts': `
        import type { AccountSubject } from '@cloudsforge/contracts-money'
        export function postings(subject: AccountSubject) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
    })
    assert.equal(oneClaim(claims).subject, '*')
  })

  it('a name declared TWICE in one repository resolves to nothing', () => {
    // Call sites are matched by TEXT, so two declarations mean a call could be either. A coin toss
    // that lands right nine times in ten is worse than a wildcard: the wildcard is counted.
    const claims = sweepOneRepo({
      'a.ts': `
        export function postings(subject: string) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
      'b.ts': `export function postings(subject: string) { return subject }`,
      'caller.ts': `export function pay() { return postings('platform') }`,
    })
    assert.equal(oneClaim(claims).subject, '*')
  })

  it('a helper nothing in the repository calls resolves to nothing', () => {
    // An exported helper the ESTATE calls from another repository. Its callers are genuinely out of
    // reach, and "no call site" must not read as "no disagreement".
    const claims = sweepOneRepo({
      'client.ts': `
        export function postings(subject: string) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
    })
    assert.equal(oneClaim(claims).subject, '*')
  })

  it('call sites that DISAGREE resolve to nothing rather than to whichever was read last', () => {
    // `billing`'s `purchasePostings` is called with a parsed user subject from one file and a
    // subscription row's subject from another. The claim is about both, and neither is knowable.
    const claims = sweepOneRepo({
      'client.ts': `
        export function postings(subject: string) {
          return [{ account: { subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' } }]
        }
      `,
      'one.ts': `export function a() { return postings('platform') }`,
      'two.ts': `export function b(id: string) { return postings(userSubject(id)) }`,
    })
    assert.equal(oneClaim(claims).subject, '*')
  })
})

describe('a purpose that is a closed set of purposes, not an unknown one', () => {
  it('expands a literal-union parameter into one claim per purpose, in ONE place', () => {
    // `foresight/src/custodialstakes.ts`: `userAccount(subject, assetCode, purpose: 'available' |
    // 'escrow')` returning `type: 'liability'`. Two accounts, both stated, both checkable.
    const claims = sweepOneRepo({
      'stakes.ts': `
        function userAccount(subject: string, assetCode: string, purpose: 'available' | 'escrow') {
          return { subject, assetCode, purpose, type: 'liability' }
        }
        export function settle(stake: { subject: string }) {
          return userAccount(stake.subject, 'EMBER', 'escrow')
        }
      `,
    })
    assert.deepEqual(
      claims.map((claim) => claim.purpose).sort(),
      ['available', 'escrow'],
    )
    assert.equal(new Set(claims.map((claim) => `${claim.file}:${claim.line}`)).size, 1, 'one literal')

    // ...and the budget counts the PLACE, not the claims, or reading the literal better would look
    // like the blind spot doubling.
    const result = reconcileAccountClaims(claims, { maxUnresolved: 1 })
    assert.equal(result.unresolved.length, 2)
    assert.equal(result.unresolvedSites, 1)
    assert.equal(result.ok, true, formatReconciliation(result))
    // One line in the report, too. Two identical lines read as two things to go and fix.
    const printed = formatReconciliation(result).split('\n').filter((line) => line.includes('stakes.ts'))
    assert.equal(printed.length, 1, printed.join(' | '))
  })

  it('expands a ternary between two literals', () => {
    // `ledger/src/entries.ts`: `posting.accountId === 'available' ? 'available' : 'reserved'`.
    const source = `
      const a = {
        subject: 'clearing',
        assetCode: 'EMBER',
        purpose: id === 'available' ? 'available' : 'reserved',
        type: 'clearing',
      }
    `
    const claims = extractAccountClaims('ledger', 'src/entries.ts', source)
    assert.deepEqual(
      claims.map((claim) => claim.purpose).sort(),
      ['available', 'reserved'],
    )
  })

  it('collects the purposes a helper is actually CALLED with when its annotation is another repo\'s', () => {
    // `market`'s `holder(subject, assetCode, purpose: AccountPurpose)`. The annotation is the whole
    // vocabulary and says nothing; the three call sites say `available`, `reserved`, `payout_due`.
    const claims = sweepOneRepo({
      'client.ts': `
        import type { AccountPurpose } from '@cloudsforge/contracts-money'
        function holder(subject: string, purpose: AccountPurpose) {
          return { subject, assetCode: 'EMBER', purpose, type: 'liability' }
        }
        export function one(s: string) { return holder(s, 'available') }
        export function two(s: string) { return holder(s, 'reserved') }
        export function three(s: string) { return holder(s, 'payout_due') }
      `,
    })
    assert.deepEqual(
      claims.map((claim) => claim.purpose).sort(),
      ['available', 'payout_due', 'reserved'],
    )
  })

  it('refuses a purpose set that spans the whole vocabulary rather than inventing seven accounts', () => {
    // The dangerous half of expansion. `(*, *, fees) → liability` is IMPLAUSIBLE against the chart,
    // so reading a full-vocabulary annotation as seven claims would manufacture a red out of a
    // helper no caller ever passes `fees` to. `AccountPurpose` spelled out is exactly this shape,
    // and it is why the expansion is capped rather than unbounded.
    const claims = sweepOneRepo({
      'client.ts': `
        export function account(
          subject: string,
          purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense',
        ) {
          return { subject, assetCode: 'EMBER', purpose, type: 'liability' }
        }
      `,
    })
    assert.equal(oneClaim(claims).purpose, '*')
    assert.equal(reconcileAccountClaims(claims).implausible.length, 0)
  })

  it('takes the call sites when the annotation is too wide to mean anything', () => {
    // Same helper, one caller. The annotation is worth nothing, but `available` is a purpose this
    // repository really does claim `liability` for, and a wildcard here would throw that away.
    const claims = sweepOneRepo({
      'client.ts': `
        function account(
          subject: string,
          purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense',
        ) {
          return { subject, assetCode: 'EMBER', purpose, type: 'liability' }
        }
        export function use(s: string) { return account(s, 'available') }
      `,
    })
    assert.equal(oneClaim(claims).purpose, 'available')
  })

  it('does NOT expand a type union, because half the cross product is an account nobody claims', () => {
    // `market/src/engagement.ts` takes `{ purpose: 'available' | 'fees'; type: 'liability' |
    // 'revenue' }` and its two callers pair them `available/liability` and `fees/revenue`. Expanding
    // both would invent `fees/liability` and `available/revenue` — and `available/revenue` is
    // precisely the shape the `implausible` pass exists to report. Inventing a finding and finding
    // one are indistinguishable in a report.
    const claims = sweepOneRepo({
      'engagement.ts': `
        export function grantPostings(input: {
          readonly beneficiary: { readonly purpose: 'available' | 'fees'; readonly type: 'liability' | 'revenue' }
        }) {
          return [{ account: { subject: 'platform', assetCode: 'SHARD', purpose: input.beneficiary.purpose, type: input.beneficiary.type } }]
        }
      `,
    })
    assert.deepEqual(
      claims.map((claim) => claim.purpose).sort(),
      ['available', 'fees'],
    )
    for (const claim of claims) assert.equal(claim.type, '*')
    assert.equal(reconcileAccountClaims(claims).implausible.length, 0)
  })
})

describe('a wildcard subject stays out of the pairwise pass, and this is the counterexample', () => {
  it('does NOT report the estate\'s most-copied pair of postings as a disagreement', () => {
    // micro-org#264 asks for wildcard claims to join the disagreement pass: "(*, *, available) →
    // liability … conflicts with any claim of purpose `available` and a different type". The chart
    // in this very file says otherwise — `custody/available` is an `asset` and `user/available` is
    // a `liability`, both correct, both on every deposit micro-wallet has ever posted. Admitting
    // the wildcard would have turned that pair red on the first run.
    const claims = [
      ...extractAccountClaims('wallet', 'src/deposits.ts', `const a = { subject: 'custody', assetCode: 'EMBER', purpose: 'available', type: 'asset' }`),
      ...extractAccountClaims('billing', 'src/ledger.ts', `const b = { subject: input.subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' }`),
    ]
    const result = reconcileAccountClaims(claims, { maxUnresolved: 1 })
    assert.equal(result.disagreements.length, 0, formatReconciliation(result))
    assert.equal(result.ok, true, formatReconciliation(result))
  })

  it('but the same claim is still JUDGED, by the pass that needs no subject', () => {
    // The sound version of #264's idea, and it was already here. "Reported and counted, never
    // checked" was not true of the ten claims whose purpose and type were both readable.
    const claims = extractAccountClaims(
      'rogue',
      'src/x.ts',
      `const b = { subject: input.subject, assetCode: 'EMBER', purpose: 'available', type: 'revenue' }`,
    )
    const result = reconcileAccountClaims(claims, { maxUnresolved: 9 })
    assert.equal(result.unresolved.length, 1)
    assert.equal(result.implausible.length, 1)
    assert.equal(result.ok, false)
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE DOES NOT PROVE.
//
// It proves the analyser. It does not prove the ESTATE, because this repository's CI checks out
// only this repository — `.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test` with no
// siblings on disk, and the shared `service-ci` workflow checks out `micro-runtime` and
// `micro-contracts` and nothing else. There is therefore no job anywhere in the estate that has all
// 24 services present at once, and the sweep cannot run in one until there is.
//
// Until that exists, `conformance ledger-accounts --estate ..` is a local gate a human runs, and it
// is written to fail loudly on a partial checkout (`MIN_SERVICES`) precisely so that "it passed"
// cannot come from an empty directory. The report says so. Making it automatic needs a workflow
// change in `micro-org`, which is described in this task's report rather than done here.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A CONSTANT IMPORTED FROM micro-contracts, AND WHY THE SWEEP HAD TO LEARN TO READ ONE
 *
 * micro-org#372 was `subject: 'exchange'` written as a literal in `trade/src/transfers.ts` against
 * a grammar with no such subject. The fix registered `EXCHANGE` in contracts-money and imported
 * it, so that a subject a service invents is a compile error rather than a `RangeError` inside the
 * ledger's `ensureAccount`.
 *
 * That repair made this sweep read the site WORSE. `index.values` is built per repository, so an
 * identifier declared in another checkout resolved to nothing, the claim stayed unresolved, and the
 * budget line the fix was supposed to remove stayed exactly where it was — with the reported text
 * changed from a wrong literal to a right identifier. **A tool that penalises the fix it asked for
 * teaches people to write the literal back.**
 *
 * The lookup is narrow on purpose and is the only cross-repository one this module permits: one
 * package, one file, `export const NAME: AccountSubject = '<literal>'`, and nothing followed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('a subject imported from micro-contracts', () => {
  const MONEY = `
export type AccountSubject =
  | \`user:\${string}\`
  | 'platform'
  | 'custody'
  | 'clearing'
  | 'exchange'

export const PLATFORM: AccountSubject = 'platform'
export const EXCHANGE: AccountSubject = 'exchange'
const NOT_EXPORTED: AccountSubject = 'custody'
export const NOT_A_SUBJECT = 'exchange'
export const ENGAGEMENT_GRANT_KIND = 'grant'
`

  const TRADE = `
import { EXCHANGE } from '@cloudsforge/contracts-money'
export function transferPostings(input: { asset: string }) {
  return [{ subject: EXCHANGE, assetCode: input.asset, purpose: 'escrow', type: 'liability' }]
}
`

  /** Lays down a real estate: one service, and micro-contracts where the constant lives. */
  const sweepWith = (money: string | null, service = TRADE): AccountClaim[] => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-const-'))
    try {
      const svc = join(dir, 'trade', 'src', 'transfers.ts')
      mkdirSync(dirname(svc), { recursive: true })
      writeFileSync(svc, service)
      if (money !== null) {
        const contracts = join(dir, 'contracts', 'packages', 'money', 'src', 'index.ts')
        mkdirSync(dirname(contracts), { recursive: true })
        writeFileSync(contracts, money)
      }
      return sweepEstate({ estateDir: dir, exclude: [] }).claims.filter((c) => c.service === 'trade')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('resolves the subject, so importing the constant costs no blind spot — micro-org#372', () => {
    const claims = sweepWith(MONEY)
    assert.equal(claims.length, 1)
    const claim = claims[0]!
    assert.equal(claim.subject, 'exchange')
    assert.equal(claim.subjectText, 'exchange')
    assert.equal(claim.unresolved, false)
  })

  /*
   * The mutation is BUILT IN rather than applied by hand: the same service source, swept against an
   * estate with no micro-contracts in it, is the state this repository was in before this change.
   * If the assertion above ever passes for a reason other than the lookup, this one passes too and
   * the pair contradict each other.
   */
  it('is unresolved when micro-contracts is not there to say what it means', () => {
    const claims = sweepWith(null)
    assert.equal(claims.length, 1)
    assert.equal(claims[0]!.subject, '*')
    assert.equal(claims[0]!.unresolved, true)
  })

  it('reads only exported constants annotated AccountSubject, and follows nothing', () => {
    const found = accountSubjectConstants(MONEY)
    assert.deepEqual([...found.entries()].sort(), [
      ['EXCHANGE', 'exchange'],
      ['PLATFORM', 'platform'],
    ])
    // Not exported: no service can import it, so resolving it would be answering about a name that
    // cannot appear at a call site.
    assert.equal(found.has('NOT_EXPORTED'), false)
    // Exported and a string, but NOT annotated `AccountSubject`. Reading it would let any exported
    // upper-case string in that file stand in for a subject, which is how a sweep starts blessing
    // spellings the ledger throws on.
    assert.equal(found.has('NOT_A_SUBJECT'), false)
    assert.equal(found.has('ENGAGEMENT_GRANT_KIND'), false)
  })

  it('resolves a constant to whatever contracts says it is, not to what the name suggests', () => {
    // The name is the same; the value is a subject this grammar does not have. The claim must read
    // as `*` and cost its budget line, because that is what the ledger would do with it.
    const claims = sweepWith(MONEY.replace("EXCHANGE: AccountSubject = 'exchange'", "EXCHANGE: AccountSubject = 'exchange-omnibus'"))
    assert.equal(claims[0]!.subject, '*')
    assert.equal(claims[0]!.unresolved, true)
  })

  /*
   * A local declaration must still win. Otherwise a service with its own `const EXCHANGE` — a
   * different value entirely — would be reported as contracts' subject, which is the cross-service
   * guess `repoResolver`'s header refuses.
   */
  it('lets a name declared in the service itself answer for itself', () => {
    const claims = sweepWith(
      MONEY,
      `
const EXCHANGE = 'platform'
export function postings() {
  return [{ subject: EXCHANGE, purpose: 'escrow', type: 'liability' }]
}
`,
    )
    assert.equal(claims[0]!.subject, 'platform')
  })
})

/**
 * One estate on disk, laid out as the caller describes it.
 *
 * `sweepOneRepo` above cannot express any of the cases below, because every one of them is about
 * the relationship BETWEEN two checkouts — which one is read, and whose call sites may answer
 * whose helper. A fixture with one repository in it would pass while proving nothing.
 */
function sweepEstateOf(repos: Readonly<Record<string, Readonly<Record<string, string>>>>) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-estate-'))
  try {
    for (const [repo, files] of Object.entries(repos)) {
      for (const [name, source] of Object.entries(files)) {
        const full = join(dir, repo, 'src', name)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, source)
      }
    }
    const sweep = sweepEstate({ estateDir: dir, exclude: [] })
    return {
      absorbed: sweep.absorbed.map((entry) => `${entry.service}→${entry.into}`).sort(),
      services: [...sweep.services].sort(),
      sites: sweep.claims.map((claim) => `${claim.service}/${claim.file}`),
      claims: sweep.claims,
      derived: absorptionsOf(dir, Object.keys(repos)),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the ledger vocabularies, against the migrations that decide them', () => {
  const CONSTRAINT = (purposes: string, types: string) => `
    constraint accounts_purpose_chk check (
      purpose in (${purposes})
    ),
    constraint accounts_type_chk check (
      type in (${types})
    )
  `
  const CURRENT = CONSTRAINT(
    "'available', 'reserved', 'escrow', 'treasury', 'fees', 'payout_due', 'suspense', 'inventory'",
    "'liability', 'asset', 'revenue', 'expense', 'equity', 'clearing'",
  )

  it('agrees with the estate it ships beside', () => {
    assert.equal(formatVocabularyDrift(vocabularyDrift(CURRENT)), null)
  })

  it('reads the LAST constraint, because a widened one is appended and never edited in place', () => {
    // Migration 1's seven, then migration 18's eight. A reader that took the first would report
    // `inventory` as retired and be confidently wrong — which is the whole shape of micro-org#499.
    const appended =
      CONSTRAINT("'available', 'reserved', 'escrow', 'treasury', 'fees', 'payout_due', 'suspense'", "'liability'") +
      CURRENT
    assert.equal(formatVocabularyDrift(vocabularyDrift(appended)), null)
  })

  it('names a purpose the ledger permits and this file has no word for', () => {
    const widened = CONSTRAINT(
      "'available', 'reserved', 'escrow', 'treasury', 'fees', 'payout_due', 'suspense', 'inventory', 'rebate'",
      "'liability', 'asset', 'revenue', 'expense', 'equity', 'clearing'",
    )
    const drift = vocabularyDrift(widened)
    assert.deepEqual([...drift.purposes.missing], ['rebate'])
    assert.match(formatVocabularyDrift(drift) ?? '', /purposes this sweep has no word for: rebate/)
  })

  it('names a type the ledger has dropped — the direction that would BLESS a rejected value', () => {
    const narrowed = CONSTRAINT(
      "'available', 'reserved', 'escrow', 'treasury', 'fees', 'payout_due', 'suspense', 'inventory'",
      "'liability', 'asset', 'revenue', 'expense', 'equity'",
    )
    const drift = vocabularyDrift(narrowed)
    assert.deepEqual([...drift.types.retired], ['clearing'])
    assert.match(formatVocabularyDrift(drift) ?? '', /bless a value the check constraint rejects/)
  })

  it('an unreadable constraint is its own outcome, never agreement', () => {
    const drift = vocabularyDrift('nothing in here declares anything')
    assert.equal(drift.purposes.unreadable, true)
    assert.equal(drift.types.unreadable, true)
    assert.match(formatVocabularyDrift(drift) ?? '', /UNCHECKED, which is not the same as agreed/)
  })

  it("resolves the desk's inventory account, which is the literal the stale mirror could not read", () => {
    const claim = oneClaim(
      sweepOneRepo({
        'money.ts': `
export const DESK_SUBJECT = 'exchange'
function desk(assetCode: string) {
  return { subject: DESK_SUBJECT, assetCode, purpose: 'inventory', type: 'equity' } as const
}
`,
      }),
    )
    assert.equal(claim.purpose, 'inventory')
    assert.equal(claim.unresolved, false)
  })
})

describe('a checkout whose code now runs inside another checkout', () => {
  const LEDGER_CLIENT = `
export function ensure(input: { subject: string }) {
  return { subject: input.subject, assetCode: 'EMBER', purpose: 'available', type: 'liability' }
}
`
  const ENV = 'export const env = { url: process.env.LEDGER_URL }\n'
  const CALLER = (subject: string) => `
import { ensure } from './ledgerclient.ts'
export function go() {
  return ensure({ subject: '${subject}' })
}
`

  it('reads the live copy and skips the frozen one, so one service is one place', () => {
    const swept = sweepEstateOf({
      market: { 'ledgerclient.ts': LEDGER_CLIENT, 'server.ts': CALLER('platform'), 'env.ts': ENV },
      agora: {
        'kernel.ts': 'export const boot = () => 1\n',
        'market/ledgerclient.ts': LEDGER_CLIENT,
        'market/server.ts': CALLER('platform'),
        'market/env.ts': ENV,
      },
    })
    assert.deepEqual(swept.absorbed, ['market→agora'])
    assert.deepEqual(swept.services, ['agora'])
    // The path still names the service, so a finding opens where the code actually runs.
    assert.deepEqual(swept.sites.sort(), ['agora/src/market/ledgerclient.ts'])
  })

  it('a matching directory name is not enough — the module has to be a copy of the repository', () => {
    const swept = sweepEstateOf({
      policy: {
        'ledgerclient.ts': LEDGER_CLIENT,
        'server.ts': CALLER('platform'),
        'rules.ts': 'export const rules = []\n',
        'env.ts': 'export const env = {}\n',
      },
      agora: {
        'kernel.ts': 'export const boot = () => 1\n',
        // A directory that happens to be called `policy` and shares nothing with the repository.
        'policy/localhelper.ts': 'export const local = () => 2\n',
      },
    })
    assert.deepEqual(swept.absorbed, [])
    assert.deepEqual(swept.services, ['agora', 'policy'])
  })

  it('an absorbed module keeps its OWN resolver — a sibling module may not answer its helper', () => {
    // The regression the merge introduced. `market/ledgerclient.ts` takes its subject from a
    // parameter; pre-merge only market's own call site answered it, and the claim resolved to
    // `platform`. One resolver over the whole of `agora` lets mint's call site answer it too, the
    // union widens past what the sweep will cap, and a claim that WAS readable reads as `*`.
    const swept = sweepEstateOf({
      market: { 'ledgerclient.ts': LEDGER_CLIENT, 'server.ts': CALLER('platform'), 'env.ts': ENV },
      mint: { 'ledgerclient.ts': LEDGER_CLIENT, 'server.ts': CALLER('clearing'), 'env.ts': ENV },
      agora: {
        'kernel.ts': 'export const boot = () => 1\n',
        'market/ledgerclient.ts': LEDGER_CLIENT,
        'market/server.ts': CALLER('platform'),
        'market/env.ts': ENV,
        'mint/ledgerclient.ts': LEDGER_CLIENT,
        'mint/server.ts': CALLER('clearing'),
        'mint/env.ts': ENV,
      },
    })
    assert.deepEqual(swept.absorbed, ['market→agora', 'mint→agora'])
    const byFile = new Map(swept.claims.map((claim) => [claim.file, claim]))
    const market = byFile.get(join('src', 'market', 'ledgerclient.ts'))
    const mint = byFile.get(join('src', 'mint', 'ledgerclient.ts'))
    assert.ok(market && mint, [...byFile.keys()].join(', '))
    // The KIND each module's own caller decides. A leak between scopes makes both `*`, because the
    // union of two subjects is not a subject.
    assert.equal(market.subject, 'platform')
    assert.equal(market.unresolved, false)
    assert.equal(mint.subject, 'clearing')
    assert.equal(mint.unresolved, false)
  })
})

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
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  BASELINE_UNRESOLVED,
  CANONICAL_ACCOUNTS,
  MIN_SERVICES,
  UnreadableSourceError,
  extractAccountClaims,
  formatReconciliation,
  reconcileAccountClaims,
  subjectKindOf,
  sweepEstate,
} from './ledgeraccounts.ts'

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
    present = sweepEstate({ estateDir }).services.length
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
    assert.equal(subjectKindOf('nonsense'), '*')
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

/**
 * The base environments, and the three refusals that keep a misconfigured run from looking like a
 * measured one.
 *
 * None of the three is provable from a scenario, and all three are the kind that fail silently: a
 * base that dials the wrong estate still produces a corpus; an untrusted CA still produces a
 * manifest, one full of skips that reads exactly like a dead estate; and a hygiene refusal loaded
 * with the WRONG estate's literals produces a corpus that is indistinguishable from a clean one,
 * because a refusal that can never fire and a refusal that never had to fire look the same.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  TARGETS,
  assertSecretLiterals,
  assertTlsTrust,
  baseNames,
  isUnmapped,
  loadSecrets,
  resolveBase,
  secretFilesFor,
} from './env.ts'
import type { BaseUrls, HarnessSecrets } from './env.ts'
import { ALL_SCENARIOS } from './scenarios/index.ts'

const SAVED = {
  extra: process.env['NODE_EXTRA_CA_CERTS'],
  reject: process.env['NODE_TLS_REJECT_UNAUTHORIZED'],
  secretsFile: process.env['CONFORMANCE_SECRETS_FILE'],
}

afterEach(() => {
  for (const [name, value] of [
    ['NODE_EXTRA_CA_CERTS', SAVED.extra],
    ['NODE_TLS_REJECT_UNAUTHORIZED', SAVED.reject],
    ['CONFORMANCE_SECRETS_FILE', SAVED.secretsFile],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const target of TARGETS) delete process.env[`CONFORMANCE_URL_${target.toUpperCase().replace(/-/g, '_')}`]
})

describe('the base environments', () => {
  it('names both estates', () => {
    assert.deepEqual(baseNames().sort(), ['local', 'micro'])
  })

  it('gives every target in every base either a URL or a stated reason it has none', () => {
    for (const name of baseNames()) {
      const base = resolveBase(name)
      for (const target of TARGETS) {
        const entry = base[target]
        if (isUnmapped(entry)) {
          // A reason is what an operator reads in Beacon under `conformance_inconclusive`. "not
          // available" would retire the reason code and explain nothing, which is the failure the
          // whole skip path exists to avoid.
          assert.ok(entry.reason.length > 40, `${name}/${target} is unmapped without a real reason`)
        } else {
          assert.match(entry, /^https?:\/\//, `${name}/${target} is not a URL`)
        }
      }
    }
  })

  /**
   * THE REGRESSION THIS PINS. `micro` was a byte-for-byte copy of `local` — ten legacy `stack`
   * addresses on 127.0.0.1, eight of which refuse connections — for as long as the base existed.
   * A `micro` base that dials loopback ports is not a micro base, and the symptom (everything
   * skips) is indistinguishable from the estate being switched off.
   */
  it('the micro base never dials a legacy stack port', () => {
    const micro = resolveBase('micro')
    const local = resolveBase('local')
    for (const target of TARGETS) {
      const entry = micro[target]
      if (isUnmapped(entry)) continue
      // Hearth is the deliberate exception and is asserted as such below.
      if (target === 'hearth-rest' || target === 'hearth-rpc') continue
      assert.notEqual(entry, local[target], `micro/${target} still points at the legacy estate`)
      assert.match(entry, /^https:\/\//, `micro/${target} must be reached through the gateway`)
    }
  })

  it('reaches hearth directly, because it is the same node the legacy corpus recorded', () => {
    const micro = resolveBase('micro')
    // Not an oversight and not laziness: 8545 is the JSON-RPC listener the deposit watcher speaks
    // to and it is plain HTTP by design. It is also why `chain` is the one suite whose micro and
    // legacy recordings are directly comparable.
    assert.equal(micro['hearth-rpc'], 'http://127.0.0.1:8545')
    assert.equal(micro['hearth-rest'], 'http://127.0.0.1:8645')
  })

  it('an override outranks an unmapped row, so a restored surface needs no edit here', () => {
    assert.ok(isUnmapped(resolveBase('micro').pay))
    process.env['CONFORMANCE_URL_PAY'] = 'https://pay.example/v1/'
    const base = resolveBase('micro')
    assert.equal(base.pay, 'https://pay.example/v1', 'the trailing slash must be trimmed')
  })
})

describe('the TLS refusal', () => {
  const httpsBase = { ...resolveBase('micro') } as BaseUrls
  const httpOnly = resolveBase('local')

  it('refuses an https base when the estate CA is not trusted', () => {
    delete process.env['NODE_EXTRA_CA_CERTS']
    assert.throws(
      () => assertTlsTrust(httpsBase, 'micro'),
      /NODE_EXTRA_CA_CERTS is unset/,
    )
  })

  it('refuses verification being switched off, by name', () => {
    process.env['NODE_EXTRA_CA_CERTS'] = '/tmp/ca.crt'
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    // The estate has been bitten by this exact shortcut: 183 uses of `curl -k` hid a gateway
    // serving `CN=TRAEFIK DEFAULT CERT` while every check reported green.
    assert.throws(() => assertTlsTrust(httpsBase, 'micro'), /NODE_TLS_REJECT_UNAUTHORIZED=0/)
  })

  it('passes once the CA is trusted', () => {
    process.env['NODE_EXTRA_CA_CERTS'] = '/tmp/ca.crt'
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']
    assert.doesNotThrow(() => assertTlsTrust(httpsBase, 'micro'))
  })

  it('says nothing about a base that never leaves http, so `local` still runs with no CA', () => {
    delete process.env['NODE_EXTRA_CA_CERTS']
    assert.doesNotThrow(() => assertTlsTrust(httpOnly, 'local'))
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REGRESSION THIS PINS, AND WHY IT IS THE SHARPEST INSTANCE OF "A CHECK THAT CANNOT FAIL".
 *
 * `loadSecrets` used to take a PATH, defaulted from a single `STACK_ROOT` that was found by
 * walking up for `docker-compose.yml` + `.env.example`. On this machine that walk lands in the
 * LEGACY `stack` checkout. So `record --base micro` loaded the legacy estate's literals, and
 * therefore held none of the micro estate's — the half of the hygiene refusal that exists to catch
 * a secret the patterns do not recognise was pointed at a different estate than the one being
 * recorded, into a corpus committed to a PUBLIC repository.
 *
 * Nothing about that was visible: the refusal simply never fired, which is exactly what a clean
 * run also looks like. So the fix is two-part and both parts are tested here — the literals are
 * bound to the base being recorded, and a base that cannot produce them REFUSES rather than
 * recording with a silent gap.
 *
 * No real secret value appears in this file. The fixtures are strings that are obviously not
 * credentials, and the assertions prove a literal was loaded by its COUNT, never its value.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('the secret literals a base loads', () => {
  it('gives every base a declared secret file, so none can silently have none', () => {
    for (const name of baseNames()) {
      const files = secretFilesFor(name)
      assert.ok(files.length > 0, `base '${name}' declares no secret file`)
      for (const file of files) assert.ok(file.startsWith(sep), `${name}: ${file} is not absolute`)
    }
  })

  it('reads the MICRO estate’s own tokens file for the micro base, not the legacy stack’s .env', () => {
    const files = secretFilesFor('micro')
    assert.ok(
      files.some((f) => f.endsWith(join('deploy', 'compose', 'estate', 'tokens.env'))),
      'micro must read deploy/compose/estate/tokens.env — the file the estate is actually booted with',
    )
    // The precise defect: the legacy root's `.env` must not be in micro's list at all.
    assert.ok(
      !files.some((f) => f.endsWith(join('stack', '.env'))),
      'micro must not read the legacy stack checkout’s .env',
    )
  })

  it('keeps the legacy base reading the legacy estate, so `local` is unchanged', () => {
    const files = secretFilesFor('local')
    assert.equal(files.length, 1)
    assert.ok(files[0]?.endsWith(`${sep}.env`), 'local reads the legacy estate root’s .env')
  })

  it('never gives two bases the same secret file, which is what made the wrong one invisible', () => {
    const local = new Set(secretFilesFor('local'))
    for (const file of secretFilesFor('micro')) {
      assert.ok(!local.has(file), `${file} is declared by both bases`)
    }
  })

  it('refuses a base it does not know, rather than loading nothing for it', () => {
    assert.throws(() => secretFilesFor('nope'), /unknown base environment 'nope'/)
    assert.throws(() => loadSecrets('nope'), /unknown base environment 'nope'/)
  })

  it('loads the literals from the declared file and records which base they belong to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conformance-secrets-'))
    const file = join(dir, 'tokens.env')
    // Not credentials. Two values long enough to count, one too short to, one comment.
    writeFileSync(file, ['# a comment', 'A_TOKEN=this-is-not-a-secret-1', 'B_TOKEN=this-is-not-a-secret-2', 'C=short', ''].join('\n'))
    process.env['CONFORMANCE_SECRETS_FILE'] = file
    const secrets = loadSecrets('micro')
    assert.equal(secrets.base, 'micro')
    assert.deepEqual(secrets.missing, [])
    // The count, never the values.
    assert.equal(secrets.literals.length, 2)
  })
})

describe('the secret-literal refusal', () => {
  const loaded = (over: Partial<HarnessSecrets> = {}): HarnessSecrets => ({
    literals: ['this-is-not-a-secret-1'],
    source: '/tmp/nowhere/tokens.env',
    payServiceToken: undefined,
    base: 'micro',
    missing: [],
    ...over,
  })

  it('passes when the literals were loaded for the base being recorded', () => {
    assert.doesNotThrow(() => assertSecretLiterals(loaded(), 'micro'))
  })

  /** THE DEFECT ITSELF: literals from one estate, traffic from another. */
  it('refuses literals loaded for a different estate than the one being recorded', () => {
    assert.throws(() => assertSecretLiterals(loaded({ base: 'local' }), 'micro'), /loaded for base 'local'/)
  })

  it('refuses when a declared secret file could not be read, and names the file', () => {
    assert.throws(
      () => assertSecretLiterals(loaded({ literals: [], missing: ['/tmp/nowhere/tokens.env'] }), 'micro'),
      /\/tmp\/nowhere\/tokens\.env/,
    )
  })

  it('names CONFORMANCE_SECRETS_FILE in the refusal, so the operator is told what to set', () => {
    assert.throws(
      () => assertSecretLiterals(loaded({ literals: [], missing: ['/tmp/nowhere/tokens.env'] }), 'micro'),
      /CONFORMANCE_SECRETS_FILE/,
    )
  })

  /**
   * A file that reads but holds nothing is the same defect wearing a different hat: the refusal is
   * armed with an empty list and can never fire. It must be as loud as an absent file.
   */
  it('refuses a readable secret file that yielded no literals at all', () => {
    assert.throws(() => assertSecretLiterals(loaded({ literals: [] }), 'micro'), /no literal values/)
  })

  it('refuses an absent file end to end, through loadSecrets', () => {
    process.env['CONFORMANCE_SECRETS_FILE'] = join(tmpdir(), 'conformance-does-not-exist', 'tokens.env')
    const secrets = loadSecrets('micro')
    assert.equal(secrets.literals.length, 0)
    assert.throws(() => assertSecretLiterals(secrets, 'micro'), /conformance-does-not-exist/)
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIVE CAPABILITIES THAT HAD NO MICRO BASELINE, AND THE RULE THAT DECIDED HOW THEY GOT ONE.
 *
 * `wallet`, `entitlements`, `mint`, `trade` and `game` are the legacy suites, and on the micro
 * base they skip: the resources were renamed and versioned, so every path they know answers 404 at
 * the successor's address. Pointing them at those successors would manufacture a pass — six stable
 * 404s compare identical forever and Beacon derives `pass` from `identical + benign > 0`.
 *
 * So the legacy suites stay unmapped and stay skipped, and the CAPABILITIES are characterised by
 * five new suites against the surfaces that actually serve them. The rule that separates the two
 * groups is mechanical and is asserted here:
 *
 *   **A successor suite names only `micro-*` targets. A legacy suite never names one.**
 *
 * Which is what keeps the `local` corpus recordable by the same code: every `micro-*` target is
 * unmapped in `local`, so the successor suites skip there exactly as the legacy ones skip here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('the successor targets', () => {
  const successors = TARGETS.filter((t) => t.startsWith('micro-'))

  it('names one target per capability that lost its legacy address', () => {
    assert.deepEqual(
      [...successors].sort(),
      ['micro-billing', 'micro-mint', 'micro-trade', 'micro-wallet', 'micro-worlds'],
    )
  })

  it('maps every successor target in the micro base, through the gateway', () => {
    const micro = resolveBase('micro')
    for (const target of successors) {
      const entry = micro[target]
      assert.ok(!isUnmapped(entry), `micro/${target} must be mapped — its service is running`)
      assert.match(entry as string, /^https:\/\//, `micro/${target} must be reached through the gateway`)
    }
  })

  it('leaves every successor target unmapped in local, so the legacy corpus is unaffected', () => {
    const local = resolveBase('local')
    for (const target of successors) {
      const entry = local[target]
      assert.ok(isUnmapped(entry), `local/${target} must be unmapped — the legacy estate never had it`)
    }
  })

  it('keeps every legacy target unmapped or unchanged in micro, so no legacy suite is repointed', () => {
    const micro = resolveBase('micro')
    // The four that were redesigned. If any of these ever gains an address, the legacy suite it
    // feeds starts recording 404s as behaviour — which is the false pass this whole split avoids.
    for (const target of ['pay', 'game', 'mint', 'crucible'] as const) {
      assert.ok(isUnmapped(micro[target]), `micro/${target} must stay unmapped`)
    }
  })
})

/**
 * The rule that keeps the two generations of suite from bending each other.
 *
 * Stated in `scenarios/index.ts` and asserted here rather than left to whoever adds the next one,
 * because the failure it prevents is the one this repository already nearly shipped: a legacy
 * suite repointed at a successor address records 404s as behaviour, compares them identical
 * forever, and Beacon derives `pass` from `identical + benign > 0` for a suite that observed
 * nothing (`beacon/src/conformance.ts`).
 */
describe('the two generations of suite', () => {
  const isSuccessorSuite = (name: string): boolean => name.startsWith('micro-')

  it('names one successor suite per capability that lost its legacy address', () => {
    assert.deepEqual(
      ALL_SCENARIOS.map((s) => s.name).filter(isSuccessorSuite).sort(),
      ['micro-entitlements', 'micro-mint', 'micro-trade', 'micro-wallet', 'micro-worlds'],
    )
  })

  it('lets a successor suite name only successor targets, plus nimbus for the account', () => {
    for (const scenario of ALL_SCENARIOS.filter((s) => isSuccessorSuite(s.name))) {
      for (const target of scenario.targets) {
        assert.ok(
          target.startsWith('micro-') || target === 'nimbus',
          `${scenario.name} names the legacy target '${target}'`,
        )
      }
    }
  })

  it('never lets a legacy suite name a successor target, which is how a false pass would be built', () => {
    for (const scenario of ALL_SCENARIOS.filter((s) => !isSuccessorSuite(s.name))) {
      for (const target of scenario.targets) {
        assert.ok(!target.startsWith('micro-'), `${scenario.name} names the successor target '${target}'`)
      }
    }
  })

  it('gives every successor suite a description saying what breaking looks like to a user', () => {
    for (const scenario of ALL_SCENARIOS.filter((s) => isSuccessorSuite(s.name))) {
      assert.ok(scenario.description.length > 80, `${scenario.name} has no real description`)
      assert.ok(scenario.title.length > 20, `${scenario.name} has no real title`)
    }
  })
})

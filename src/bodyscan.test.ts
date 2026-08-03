/**
 * The response-body scan, judged.
 *
 * **Every case here puts key material on a wire and asserts the scan goes RED on it, by name.** A
 * guard proved only against code that already passes is a guard nobody has watched fail, and this
 * estate has shipped a long line of those — a CI job that built an image and read its metadata
 * without running it, a grep rule over files holding raw NUL bytes that `grep` skipped in silence,
 * a guard that passed because its own prose naming a function counted as a reference, and a feed
 * test that stayed green with its classifier deliberately broken because the payload lacked the
 * field. Exit-code grading would have accepted every one of them.
 *
 * So the assertions are on WHAT THE SCAN SAYS, never on whether it exited non-zero: each case
 * checks the finding names the route, the file, the line and the pass that fired. A red for the
 * wrong reason is how a check stops measuring what it claims to.
 *
 * The fixtures are written to a temporary directory rather than to the estate, so these run in this
 * repository's CI with nothing else checked out. What they prove is that the ANALYSER is correct,
 * not that the estate is clean; the estate half is `conformance body-scan --estate ..`, and the two
 * are different claims. Same split as `ledgeraccounts.test.ts`, for the same reason.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  ACKNOWLEDGED,
  ADJACENT,
  BASELINE_BLIND_ROUTES,
  KEY_SHAPES,
  MATERIAL,
  MIN_ROUTES,
  MIN_SERVERS,
  canonicalName,
  extractRoutes,
  formatBodyScan,
  reconcileBodyScan,
  scanEstate,
  secretBearingTables,
  type EstateScan,
  type Finding,
} from './bodyscan.ts'

/* ------------------------------------------------------------------ the fixture estate */

/**
 * Two constants assembled at runtime rather than written down, and both for the same reason: a test
 * file that CONTAINS the thing it tests for is a test file some other tool refuses or skips.
 *
 * `NUL` — `grep` treats a file holding a raw NUL as binary and skips it **in silence**, which is
 * precisely the defect this repository shipped as e3f32db and which the case below exists to pin.
 * Spelling the byte literally made this file invisible to `grep` and hid the PEM header beneath it
 * for one commit.
 *
 * `PEM_HEADER` — the estate's own `secret-hygiene.yml:73-83` fails any repository holding a private
 * key block, and it is right to; a scanner's fixture is not an exemption. Assembled here, the
 * fixture WRITTEN TO DISK still holds a real header, so the shape pass is still proved against the
 * real thing rather than against a euphemism for it.
 */
const NUL = String.fromCharCode(0)
const PEM_HEADER = `${'-'.repeat(5)}BEGIN EC ${'PRIVATE'} KEY${'-'.repeat(5)}MHQCAQEEIF3n`


/** The `Reply` shape all twenty-nine servers declare, so a fixture looks like the estate. */
const PREAMBLE = `
interface Reply { readonly status: number; readonly body?: unknown; readonly text?: string }
interface Route { readonly method: string; readonly path: string; readonly handle: unknown }
declare const sql: any
declare const deps: any
`

/**
 * A migration spelled the way the estate spells one: the closing paren on its own line.
 *
 * `secretBearingTables` anchors on that, and it is not fussiness — a column list is full of
 * `numeric(38, 18)`, and a regex that stops at the first `)` reads half a table.
 */
const SECRET_TABLE = `export const migrations = [\`
  create table custody_keys (
    address     text not null,
    private_key text not null
  )
\`]
`

const REFRESH_TABLE = `export const migrations = [\`
  create table refresh_tokens (
    user_id    text not null,
    token_hash text not null
  )
\`]
`

interface Service {
  readonly name: string
  /** `src/<file>` → contents. `server.ts` is where routes are looked for, as in the estate. */
  readonly files: Record<string, string>
}

function estate(...services: Service[]): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bodyscan-'))
  for (const service of services) {
    mkdirSync(join(dir, service.name, 'src'), { recursive: true })
    for (const [name, contents] of Object.entries(service.files)) {
      writeFileSync(join(dir, service.name, 'src', name), contents)
    }
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Scan a fixture estate. `exclude: []` because the fixture has no `conformance` to skip. */
function scan(...services: Service[]): EstateScan {
  const { dir, dispose } = estate(...services)
  try {
    return scanEstate({ estateDir: dir, exclude: [] })
  } finally {
    dispose()
  }
}

function server(name: string, routes: string, extra: Record<string, string> = {}): Service {
  return { name, files: { 'server.ts': `${PREAMBLE}\nfunction buildRoutes(): Route[] {\n  return [\n${routes}\n  ]\n}\n`, ...extra } }
}

/** Findings that are violations, as one readable string per finding — what a reader would see. */
function said(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.severity}/${f.pass} ${f.method} ${f.path} @ ${f.file}:${f.line} ${f.detail}`).join('\n')
}

/* ------------------------------------------------------------------ the route surface */

describe('the route surface — a route it cannot see is a route it cannot judge', () => {
  it('reads all three spellings the estate actually uses', () => {
    const source = `${PREAMBLE}
      function buildRoutes(): Route[] {
        return [
          { method: 'GET', path: '/object-literal', handle: async () => ({ status: 200, body: {} }) },
          define('POST', '/define', async () => ({ status: 200, body: {} })),
          route('PUT', '/route', async () => ({ status: 200, body: {} })),
        ]
      }`
    const found = extractRoutes('fixture', 'src/server.ts', source)
    assert.deepEqual(
      found.map((r) => `${r.method} ${r.path}`).sort(),
      ['GET /object-literal', 'POST /define', 'PUT /route'],
    )
    // The helper name is NOT hard-coded: a fourth wrapper is read on the same rule.
    const fourth = extractRoutes('fixture', 'src/server.ts', `${PREAMBLE}
      const routes = [mount('DELETE', '/fourth', async () => ({ status: 200, body: {} }))]`)
    assert.deepEqual(fourth.map((r) => r.path), ['/fourth'])
  })

  it('a route table it CANNOT read is fatal, never silently zero routes', () => {
    // The failure this guards is the one that matters most: a service changes how it declares
    // routes, the extractor reads nothing, and the scan reports "no route returns key material"
    // over a service it did not look at.
    const result = scan({
      name: 'inscrutable',
      files: {
        'server.ts': `${PREAMBLE}
          interface Route { method: string; path: string }
          function buildRoutes(): Route[] {
            return PATHS.map((p) => ({ method: 'GET', path: p, handle: async () => ({ status: 200, body: {} }) }))
          }`,
      },
    })
    assert.equal(result.routes.length, 0)
    assert.equal(result.unreadable.length, 1, 'a route table that yielded nothing must be reported')
    assert.equal(result.unreadable[0]?.service, 'inscrutable')
    assert.equal(reconcileBodyScan(result, { maxBlindRoutes: 99 }).ok, false, 'and it must FAIL, not pass with zero findings')
  })

  it('a service with no route table at all is not "unreadable" — it has no route surface', () => {
    const result = scan({ name: 'library', files: { 'index.ts': 'export const x = 1\n' } })
    assert.equal(result.unreadable.length, 0)
    assert.equal(result.services.length, 0)
  })
})

/* ------------------------------------------------------------------ the four passes */

describe('the NAME pass — a field called what key material is called', () => {
  it('goes red on a private key in a body, and names the route and the line', () => {
    const result = scan(
      server('leaky', `    { method: 'GET', path: '/v1/wallets/:id/key', handle: async () => ({ status: 200, body: { address: 'a', privateKey: secret } }) },`),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
    const finding = result.findings[0]!
    assert.equal(finding.severity, 'material')
    assert.equal(finding.pass, 'name')
    assert.equal(finding.path, '/v1/wallets/:id/key')
    assert.equal(finding.file, 'src/server.ts')
    assert.match(finding.detail, /privateKey/)
    assert.equal(reconcileBodyScan(result, { maxBlindRoutes: 99 }).ok, false)
  })

  it('reads camelCase and snake_case as one name', () => {
    for (const spelling of ['privateKey', 'private_key', 'PRIVATE_KEY', 'privatekey']) {
      const result = scan(
        server('leaky', `    { method: 'GET', path: '/k', handle: async () => ({ status: 200, body: { ${JSON.stringify(spelling)}: s } }) },`),
      )
      assert.equal(result.findings.length, 1, `${spelling} was not caught`)
    }
  })

  it('separates the two tiers, and both fail', () => {
    const material = scan(server('a', `    { method: 'GET', path: '/m', handle: async () => ({ status: 200, body: { mnemonic: m } }) },`))
    const adjacent = scan(server('b', `    { method: 'GET', path: '/a', handle: async () => ({ status: 200, body: { revealToken: t } }) },`))
    assert.equal(material.findings[0]?.severity, 'material')
    assert.equal(adjacent.findings[0]?.severity, 'adjacent')
    assert.equal(reconcileBodyScan(adjacent, { maxBlindRoutes: 99 }).ok, false, 'an adjacent finding must fail too')
  })

  it('does NOT fire on the credentials this vocabulary deliberately excludes', () => {
    // A session token is not private key material, and a scan that says it is fires on nearly every
    // authenticating route in the estate on its first run. That is the check-deleted-in-a-week shape.
    const result = scan(
      server('identity', `    { method: 'POST', path: '/auth/login', handle: async () => ({ status: 200, body: { accessToken: a, refreshToken: r, token: t, apiKey: k, passwordHash: h } }) },`),
    )
    assert.equal(result.findings.length, 0, said(result.findings))
  })

  it('does NOT fire on the derivation path, which custody argues belongs in a response', () => {
    // custody/src/exports.ts:450 — omitted from the EVENT, returned in the RESPONSE, "because the
    // user restoring a phrase needs it". Nine routes return it on purpose.
    const result = scan(
      server('custody', `    { method: 'GET', path: '/v1/keys', handle: async () => ({ status: 200, body: { address: a, derivationPath: p } }) },`),
    )
    assert.equal(result.findings.length, 0, said(result.findings))
  })
})

describe('the PROVENANCE pass — a value that came out of the vault, whatever it is called', () => {
  it('goes red on a vault read reaching a body under an innocent name', () => {
    const result = scan(
      server('leaky', `    { method: 'GET', path: '/blob', handle: async () => ({ status: 200, body: { note: await deps.vault.read(slot) } }) },`),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.equal(result.findings[0]?.pass, 'provenance')
    assert.match(result.findings[0]?.detail ?? '', /read/)
  })

  it('goes red on a decrypt, under any receiver', () => {
    const result = scan(
      server('leaky', `    { method: 'GET', path: '/d', handle: async () => ({ status: 200, body: { value: keyring.decrypt(slot, blob) } }) },`),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.equal(result.findings[0]?.pass, 'provenance')
  })
})

describe('the SHAPE pass — a literal that IS a key, whatever it is called and wherever it came from', () => {
  it('goes red on a PEM block reaching a body', () => {
    const result = scan(
      server('leaky', `    { method: 'GET', path: '/pem', handle: async () => ({ status: 200, body: { note: ${JSON.stringify(PEM_HEADER)} } }) },`),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.equal(result.findings[0]?.pass, 'shape')
  })

  it('goes red on an extended private key and on a 0x 32-byte secret', () => {
    for (const literal of [
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    ]) {
      const result = scan(
        server('leaky', `    { method: 'GET', path: '/k', handle: async () => ({ status: 200, body: { v: ${JSON.stringify(literal)} } }) },`),
      )
      assert.equal(result.findings.length, 1, `${literal.slice(0, 12)} was not caught`)
      assert.equal(result.findings[0]?.pass, 'shape')
    }
  })

  it('does NOT fire on a bare 64-hex digest — a sha-256 and a commit hash are both that shape', () => {
    const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const result = scan(
      server('ok', `    { method: 'GET', path: '/h', handle: async () => ({ status: 200, body: { checksum: ${JSON.stringify(digest)} } }) },`),
    )
    assert.equal(result.findings.length, 0, said(result.findings))
  })
})

describe('the ROW pass — a whole database row on the wire', () => {
  const MIGRATIONS = `
    export const migrations = [\`
      create table custody_keys (
        address       text not null,
        user_id       text not null,
        private_key   text not null,
        created_at    timestamptz not null
      )\`]
  `

  it('goes red when a select * from a secret-bearing table reaches a body', () => {
    const result = scan({
      name: 'custody',
      files: {
        'migrations.ts': MIGRATIONS,
        'server.ts': `${PREAMBLE}
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/v1/keys/:address', handle: async () => {
                const rows = await sql\`select * from custody_keys where address = \${a}\`
                return { status: 200, body: rows[0] }
              } },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.equal(result.findings[0]?.pass, 'row')
    assert.match(result.findings[0]?.detail ?? '', /custody_keys/)
    assert.match(result.findings[0]?.detail ?? '', /private_key/)
  })

  it('does NOT fire when the row is PROJECTED — the columns left out do not travel', () => {
    const result = scan({
      name: 'custody',
      files: {
        'migrations.ts': MIGRATIONS,
        'server.ts': `${PREAMBLE}
          function toRecord(row: any) { return { address: row.address, userId: row.user_id } }
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/v1/keys', handle: async () => {
                const rows = await sql\`select * from custody_keys\`
                return { status: 200, body: rows.map(toRecord) }
              } },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 0, said(result.findings))
  })

  it('does NOT fire when the secret column is in the WHERE clause, which a row does not carry', () => {
    // identity's refresh rotation reads `select user_id, … from refresh_tokens where token_hash = $1`.
    // Matching the whole query text reported that route as a leak; what a row carries is what is
    // between `select` and `from`.
    const result = scan({
      name: 'identity',
      files: {
        'migrations.ts': REFRESH_TABLE,
        'server.ts': `${PREAMBLE}
          function buildRoutes(): Route[] {
            return [
              { method: 'POST', path: '/auth/refresh', handle: async () => {
                const rows = await sql\`select user_id from refresh_tokens where token_hash = \${h}\`
                return { status: 200, body: rows[0] }
              } },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 0, said(result.findings))
  })

  it('reads the secret-bearing columns out of a real migration', () => {
    const tables = secretBearingTables(MIGRATIONS)
    assert.deepEqual([...tables.keys()], ['custody_keys'])
    assert.deepEqual(tables.get('custody_keys'), ['private_key'])
  })
})

/* ------------------------------------------------------------------ following the value */

describe('following the value — one level of field sensitivity, and across files', () => {
  it('follows a body built in ANOTHER file, and cites THAT file and line', () => {
    // This is what separates a scan from a grep of server.ts: every well-written service in the
    // estate builds its response somewhere else.
    const result = scan({
      name: 'leaky',
      files: {
        'records.ts': `export function toKeyRecord(row: any) {\n  return { address: row.address, privateKey: row.private_key }\n}\n`,
        'server.ts': `${PREAMBLE}
          import { toKeyRecord } from './records.ts'
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/v1/keys/:a', handle: async () => ({ status: 200, body: toKeyRecord(row) }) },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 1, said(result.findings))
    const finding = result.findings[0]!
    assert.equal(finding.file, 'src/records.ts', 'the finding must cite where the VALUE is')
    assert.equal(finding.line, 2)
    assert.match(finding.declaredAt, /^src\/server\.ts:\d+$/, 'and separately where the ROUTE is')
  })

  it('does NOT report a private key that the route takes no field of — the JWKS case', () => {
    // identity's `/.well-known/jwks.json` returns `key.publicJwk`, and `getSigningKey` returns
    // `{ kid, privateKey, publicJwk }`. A field-INsensitive walk opens the whole record and reports
    // the most deliberately public route in the estate as leaking a private key. That finding is
    // false, and a check whose loudest finding is false is a check that gets deleted.
    const result = scan({
      name: 'identity',
      files: {
        'keys.ts': `export function getSigningKey() {\n  return { kid: 'a', privateKey: secret, publicJwk: pub }\n}\n`,
        'server.ts': `${PREAMBLE}
          import { getSigningKey } from './keys.ts'
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/.well-known/jwks.json', handle: async () => ({ status: 200, body: { keys: [getSigningKey().publicJwk] } }) },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 0, said(result.findings))
  })

  it('…but DOES report it the moment the route takes that field', () => {
    // The other half of the case above. Field sensitivity must be a lens, not a blindfold.
    const result = scan({
      name: 'identity',
      files: {
        'keys.ts': `export function getSigningKey() {\n  return { kid: 'a', privateKey: secret, publicJwk: pub }\n}\n`,
        'server.ts': `${PREAMBLE}
          import { getSigningKey } from './keys.ts'
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/oops', handle: async () => ({ status: 200, body: { k: getSigningKey().privateKey } }) },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.equal(result.findings[0]?.path, '/oops')
  })

  it('follows a spread, which puts every field on the wire named or not', () => {
    const result = scan({
      name: 'leaky',
      files: {
        'records.ts': `export const record = { address: 'a', seedPhrase: s }\n`,
        'server.ts': `${PREAMBLE}
          import { record } from './records.ts'
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/s', handle: async () => ({ status: 200, body: { ...record, extra: 1 } }) },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.match(result.findings[0]?.detail ?? '', /seedPhrase/)
  })

  it('follows both branches of a conditional, because a leak on any path is a leak', () => {
    const result = scan(
      server('leaky', `    { method: 'GET', path: '/c', handle: async () => ({ status: 200, body: admin ? { mnemonic: m } : { ok: true } }) },`),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
  })

  it('scans ERROR replies too — the body most likely to be built by interpolation', () => {
    const result = scan(
      server('leaky', `    { method: 'GET', path: '/e', handle: async () => { if (bad) return { status: 400, body: { error: 'bad key', privateKey: k } }; return { status: 200, body: {} } } },`),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
  })
})

/* ------------------------------------------------------------------ the blind spot */

describe('the blind spot is measured, not hidden', () => {
  it('counts a value it cannot open, and says why', () => {
    const result = scan({
      name: 'custody',
      files: {
        'migrations.ts': SECRET_TABLE,
        'server.ts': `${PREAMBLE}
          function buildRoutes(): Route[] {
            return [
              { method: 'GET', path: '/o', handle: async () => ({ status: 200, body: await deps.store.whatever() }) },
            ]
          }`,
      },
    })
    assert.equal(result.findings.length, 0, 'nothing was identified as key material')
    assert.equal(result.opaque.length, 1, 'but the body was not read, and that is recorded')
    assert.equal(result.opaque[0]?.reason, 'dep-call')
    // …and because custody holds key material, that unread body is a BLIND ROUTE and fails the gate.
    assert.equal(result.holdsKeyMaterial.includes('custody'), true)
    const report = reconcileBodyScan(result, { maxBlindRoutes: 0 })
    assert.equal(report.blindRoutes.length, 1)
    assert.equal(report.ok, false, 'a service with a key to lose and a body this cannot read is not green')
  })

  it('does not count a transformation of a field it DID read', () => {
    const result = scan(
      server('custody', `    { method: 'GET', path: '/t', handle: async () => ({ status: 200, body: { at: row.created_at.toISOString() } }) },`),
    )
    assert.equal(result.opaque.filter((o) => o.reason !== 'derived').length, 0)
  })

  it('prints the blind spot in the report, above the verdict', () => {
    const result = scan({
      name: 'custody',
      files: {
        'migrations.ts': SECRET_TABLE,
        'server.ts': `${PREAMBLE}
          function buildRoutes(): Route[] {
            return [{ method: 'GET', path: '/o', handle: async () => ({ status: 200, body: await deps.store.x() }) }]
          }`,
      },
    })
    const text = formatBodyScan(reconcileBodyScan(result, { maxBlindRoutes: 99 }), result)
    assert.match(text, /THE GATE IS ON THIS NUMBER/)
    assert.match(text, /GET \/o/)
    assert.match(text, /WHAT THIS RUN COULD NOT READ/)
  })
})

/* ------------------------------------------------------------------ the ratchet */

describe('the acknowledgement list is a ratchet, not an exemption list', () => {
  it('every acknowledgement names a real route, a field and a reason', () => {
    for (const entry of ACKNOWLEDGED) {
      assert.equal(entry.path.startsWith('/'), true, `${entry.field} has no path`)
      assert.equal(canonicalName(entry.field), entry.field, `${entry.field} is not canonicalised`)
      assert.equal(entry.because.length > 120, true, `${entry.field} has no argument, only an assertion`)
      assert.match(entry.because, /\.ts:\d+|bodyscan\.test\.ts:\d+/, `${entry.field} cites no source`)
    }
  })

  it('an acknowledgement that matches nothing is RED', () => {
    // The whole difference from an exemption list. A route that is deleted or renamed must not
    // leave a standing permission behind it, and a scan that quietly stopped reading the route it
    // was written for must not look the same as a clean estate.
    const empty = scan(server('nothing', `    { method: 'GET', path: '/x', handle: async () => ({ status: 200, body: {} }) },`))
    const report = reconcileBodyScan(empty, { maxBlindRoutes: 99 })
    assert.equal(report.staleAcknowledgements.length, ACKNOWLEDGED.length)
    assert.equal(report.ok, false)
    assert.match(formatBodyScan(report, empty), /STALE/)
  })

  it('an acknowledgement suppresses its own route and NOTHING else', () => {
    const acknowledgement = ACKNOWLEDGED.find((e) => e.field === 'revealtoken')
    assert.ok(acknowledgement, 'the challenge route acknowledgement is gone — this test is now vacuous')
    const result = scan(
      server(acknowledgement.service, [
        `    { method: '${acknowledgement.method}', path: '${acknowledgement.path}', handle: async () => ({ status: 200, body: { revealToken: t } }) },`,
        `    { method: 'GET', path: '/somewhere-else', handle: async () => ({ status: 200, body: { revealToken: t } }) },`,
      ].join('\n')),
    )
    assert.equal(result.findings.length, 1, said(result.findings))
    assert.equal(result.findings[0]?.path, '/somewhere-else', 'the acknowledgement covered a route it does not name')
  })
})

/* ------------------------------------------------------------------ refusing a partial estate */

describe('a partial checkout is refused, never reported green', () => {
  it('MIN_ROUTES and MIN_SERVERS are far below the estate and far above an accident', () => {
    // The same reasoning as MIN_SERVICES in ledgeraccounts.ts: an empty parent directory would
    // otherwise produce "0 routes, no findings" and pass. The estate declares 498 routes across 29
    // servers today.
    assert.equal(MIN_SERVERS < 29, true)
    assert.equal(MIN_ROUTES < 498, true)
    assert.equal(MIN_SERVERS > 5, true)
    assert.equal(MIN_ROUTES > 50, true)
  })

  it('a fixture estate is nowhere near the floor, which is what the CLI checks', () => {
    const result = scan(server('one', `    { method: 'GET', path: '/x', handle: async () => ({ status: 200, body: {} }) },`))
    assert.equal(result.services.length < MIN_SERVERS, true)
    assert.equal(result.routes.length < MIN_ROUTES, true)
  })

  it('a file that is not the text it appears to be is fatal, not skipped', () => {
    // e3f32db: a grep rule read files holding raw NUL bytes and `grep` skipped them in silence.
    const { dir, dispose } = estate(server('bad', `    { method: 'GET', path: '/x', handle: async () => ({ status: 200, body: {} }) },`))
    try {
      writeFileSync(join(dir, 'bad', 'src', 'nul.ts'), `export const x = '\\u0000'\n`.replace('\\u0000', NUL))
      assert.throws(() => scanEstate({ estateDir: dir, exclude: [] }), /NUL byte/)
    } finally {
      dispose()
    }
  })
})

/* ------------------------------------------------------------------ the vocabulary itself */

describe('the vocabulary', () => {
  it('is canonicalised, so one entry covers every spelling the estate uses', () => {
    for (const entry of [...MATERIAL, ...ADJACENT]) {
      assert.equal(canonicalName(entry), entry, `${entry} is not in canonical form and can never match`)
    }
  })

  it('does not contain the words that would make it fire on every route', () => {
    for (const excluded of ['token', 'secret', 'key', 'hash', 'password', 'salt', 'nonce', 'publickey']) {
      assert.equal([...MATERIAL, ...ADJACENT].includes(excluded), false, `'${excluded}' is too broad to be in the vocabulary`)
    }
  })

  it('every key shape matches something that IS a key and nothing that is not', () => {
    const notKeys = [
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '-----BEGIN PUBLIC KEY-----',
      '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
      'https://example.com/xprv-guide',
    ]
    for (const shape of KEY_SHAPES) {
      for (const text of notKeys) {
        assert.equal(shape.pattern.test(text), false, `${shape.name} fires on ${text.slice(0, 30)}`)
      }
    }
  })

  it('the blind-route baseline is a recorded number, not an open budget', () => {
    assert.equal(Number.isInteger(BASELINE_BLIND_ROUTES), true)
    assert.equal(BASELINE_BLIND_ROUTES < 60, true, 'if this ever needs raising past the route surface it is not a budget')
  })
})

/*
 * WHAT THESE TESTS DO NOT PROVE.
 *
 * That the ESTATE is clean. Every fixture above is a few lines written to a temporary directory, and
 * the analyser being right about them says nothing about 498 real routes. The estate half is
 * `conformance body-scan --estate ..` against the sibling checkouts, which needs all of them on one
 * disk — micro-org's `estate-ci.yml` is the only place that happens.
 *
 * And it does not prove what custody's `bodyscan.test.ts` proves. That test knows the actual bytes
 * of an actual private key and asserts no actual response contains them. This reasons about source.
 * A handler that assembles a body in a way this analyser reads as clean and a runtime that puts a
 * key in it anyway is a gap neither this file nor the estate sweep can close.
 */

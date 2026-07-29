/**
 * The redactor, and the refusal.
 *
 * The test that matters most is the last group: a token, a DSN, a private key and a JWT placed in
 * a payload must never reach the written file. It is written against `serialiseInteraction`
 * rather than against `redact` alone, because the claim being made is about what lands on disk and
 * the redactor is only half of what decides that.
 *
 * Nothing here needs a running estate, and nothing here contains a real secret: every value below
 * is invented and shaped like the thing it stands for.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SecretLeakError, serialiseInteraction } from './corpus.ts'
import { findSecretLeak, parseEnvSecrets, redact, redactHeaders, REDACTED } from './redact.ts'
import { FORMAT_VERSION } from './types.ts'
import type { Interaction, Json } from './types.ts'

const FAKE_JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJhdWQiOiJjbG91ZHNmb3JnZSJ9.bm90LWEtcmVhbC1zaWduYXR1cmUtYXQtYWxs'
const FAKE_DSN = 'postgres://cloudsforge:hunter2-not-real@postgres:5432/cloudsforge'
const FAKE_PRIVATE_KEY = 'a3f1e9c7b5d30246819a4c7e2f5b8d10c6e94a2b7d3f501826c4e9a7b3d5f012'
const FAKE_SERVICE_TOKEN = 'pay-service-token-3f9c1b7e5a2d8046'

describe('the redactor', () => {
  it('a credential-named field is replaced whatever its value looks like', () => {
    const out = redact({ password: 'short', accessToken: 'abc', apiKey: 'x' }) as Record<string, unknown>
    assert.deepEqual(out, { password: REDACTED, accessToken: REDACTED, apiKey: REDACTED })
  })

  it('a JWT is replaced wherever it appears, including under an innocent key name', () => {
    const out = redact({ whatever: FAKE_JWT }) as Record<string, unknown>
    assert.equal(out['whatever'], REDACTED)
  })

  it('a DSN with a password in the authority is replaced', () => {
    const out = redact({ detail: `could not connect to ${FAKE_DSN}` }) as Record<string, unknown>
    assert.ok(!String(out['detail']).includes('hunter2-not-real'))
  })

  it('a bare 64-hex private key is replaced', () => {
    const out = redact({ material: FAKE_PRIVATE_KEY }) as Record<string, unknown>
    assert.equal(out['material'], REDACTED)
  })

  it('a 0x-prefixed block hash is NOT mistaken for key material', () => {
    const hash = '0xc3a0cc990f31306c54d24c3a490107ce4f91eb18f7941fb3486f02c99c0a7155'
    const out = redact({ genesis: hash }) as Record<string, unknown>
    assert.equal(out['genesis'], hash, 'the chain scenario exists to compare this value')
  })

  it('the handoff code is taken out of a redirect URL while the URL keeps its shape', () => {
    const out = redact({
      redirectUrl: 'http://localhost:3000/#cf_code=RhX9Kd2Lm4Qp7Tz1Bv6Nw8Yc3Fj5Hs0A',
    }) as Record<string, unknown>
    assert.equal(out['redirectUrl'], `http://localhost:3000/#cf_code=${REDACTED}`)
  })

  it('an error code is never redacted — it is the field the comparator cares most about', () => {
    const out = redact({ code: 'unauthorized', error: 'missing bearer token' }) as Record<string, unknown>
    assert.equal(out['code'], 'unauthorized')
  })

  it('keyvaultChain and publicKey survive, because a loose key pattern would erase the registry', () => {
    const out = redact({ keyvaultChain: 'ember', publicKey: '04abc', coin: 'EMBER' }) as Record<string, unknown>
    assert.deepEqual(out, { keyvaultChain: 'ember', publicKey: '04abc', coin: 'EMBER' })
  })

  it('structure survives: a redacted field is still present and still a string', () => {
    const out = redact({ outer: { token: FAKE_SERVICE_TOKEN, keep: 1 } }) as Record<string, Record<string, unknown>>
    assert.deepEqual(Object.keys(out['outer'] ?? {}), ['token', 'keep'])
    assert.equal(typeof out['outer']?.['token'], 'string')
  })

  it('headers outside the allowlist are dropped and credential headers are redacted', () => {
    const headers = new Headers({
      authorization: `Bearer ${FAKE_JWT}`,
      'content-type': 'application/json',
      'x-request-id': '0523c894-365d-4383-8150-7017fabcd9d2',
    })
    const out = redactHeaders(headers, ['authorization', 'content-type'])
    assert.deepEqual(out, { authorization: REDACTED, 'content-type': 'application/json' })
  })
})

describe('the refusal', () => {
  it('an estate literal is caught even when it matches no pattern at all', () => {
    const leak = findSecretLeak(`{"note":"${FAKE_SERVICE_TOKEN}"}`, [FAKE_SERVICE_TOKEN])
    assert.equal(leak?.pattern, 'estate-secret-literal')
  })

  it('the reported leak never contains the value it caught', () => {
    const leak = findSecretLeak(`{"note":"${FAKE_SERVICE_TOKEN}"}`, [FAKE_SERVICE_TOKEN])
    assert.ok(leak)
    assert.ok(!JSON.stringify(leak).includes(FAKE_SERVICE_TOKEN), 'a harness must not move a leak into a CI log')
  })

  it('a short env value is not treated as a secret, or every fixture would be refused forever', () => {
    assert.equal(findSecretLeak('{"level":"debug"}', ['debug']), null)
  })

  it('an ordinary recorded response passes', () => {
    assert.equal(findSecretLeak('{"ok":true,"service":"nimbus"}', []), null)
  })

  it('parseEnvSecrets reads values, ignores comments, and drops values too short to match on', () => {
    const parsed = parseEnvSecrets(
      ['# a comment', 'LOG_LEVEL=info', `PAY_SERVICE_TOKEN=${FAKE_SERVICE_TOKEN}`, 'EMPTY=', 'QUOTED="a-long-quoted-value"'].join('\n'),
    )
    assert.deepEqual(parsed, [FAKE_SERVICE_TOKEN, 'a-long-quoted-value'])
  })
})

function withBody(body: Json): Interaction {
  return {
    formatVersion: FORMAT_VERSION,
    scenario: 'identity',
    step: 'sign in',
    seq: 0,
    target: 'nimbus',
    request: { method: 'POST', path: '/auth/login', headers: {}, body: null },
    response: { status: 200, headers: {}, body },
    timing: 'fast',
  }
}

describe('a token, a DSN, a private key and a JWT never reach the written file', () => {
  /**
   * `caughtBy` is the point of the table rather than a detail of it.
   *
   * Three of these four are recognisable by shape, so the redactor takes them and the fixture is
   * still written. A service token is not: it is an opaque string under a key nobody flagged, and
   * **only** the literal half of the refusal stops it — which is why the harness reads the estate's
   * `.env` at all. Asserting that both mechanisms exist and that each catches what only it can is
   * the difference between testing the redactor and testing the guarantee.
   */
  const payloads: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly caughtBy: 'redactor' | 'refusal'
  }> = [
    { name: 'a service token', value: FAKE_SERVICE_TOKEN, caughtBy: 'refusal' },
    { name: 'a database DSN', value: FAKE_DSN, caughtBy: 'redactor' },
    { name: 'a raw private key', value: FAKE_PRIVATE_KEY, caughtBy: 'redactor' },
    { name: 'a JWT', value: FAKE_JWT, caughtBy: 'redactor' },
  ]

  for (const payload of payloads) {
    it(`${payload.name} in a response body never survives into the fixture text`, () => {
      // The order the recorder uses: redact, then serialise, and the serialisation refuses.
      const redacted = redact({ leaked: payload.value }) as Json
      let text: string | null = null
      try {
        text = serialiseInteraction(withBody(redacted), [FAKE_SERVICE_TOKEN])
      } catch (err) {
        assert.ok(err instanceof SecretLeakError, 'the only acceptable failure here is a refusal')
      }
      if (payload.caughtBy === 'refusal') {
        assert.equal(text, null, `${payload.name} should have been refused, not written`)
        return
      }
      assert.ok(text !== null, `${payload.name} should have been redacted and written`)
      assert.ok(!text.includes(payload.value), `${payload.name} survived into the fixture text`)
    })

    it(`${payload.name} reaching serialisation unredacted is refused rather than written`, () => {
      // The redactor deliberately skipped: this is the case a future field name nobody thought of
      // produces, and it must stop the run rather than produce a fixture.
      assert.throws(
        () => serialiseInteraction(withBody({ leaked: payload.value }), [FAKE_SERVICE_TOKEN]),
        SecretLeakError,
      )
    })
  }

  it('the refusal message names the pattern and never the value', () => {
    try {
      serialiseInteraction(withBody({ leaked: FAKE_DSN }), [])
      assert.fail('expected a refusal')
    } catch (err) {
      assert.ok(err instanceof SecretLeakError)
      assert.ok(!err.message.includes('hunter2-not-real'))
      assert.match(err.message, /dsn-with-password/)
    }
  })
})

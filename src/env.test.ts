/**
 * The base environments, and the two refusals that keep a misconfigured run from looking like a
 * measured one.
 *
 * Neither property is provable from a scenario, and both are the kind that fail silently: a base
 * that dials the wrong estate still produces a corpus, and an untrusted CA still produces a
 * manifest — one full of skips that reads exactly like a dead estate.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { TARGETS, assertTlsTrust, baseNames, isUnmapped, resolveBase } from './env.ts'
import type { BaseUrls } from './env.ts'

const SAVED = {
  extra: process.env['NODE_EXTRA_CA_CERTS'],
  reject: process.env['NODE_TLS_REJECT_UNAUTHORIZED'],
}

afterEach(() => {
  for (const [name, value] of [
    ['NODE_EXTRA_CA_CERTS', SAVED.extra],
    ['NODE_TLS_REJECT_UNAUTHORIZED', SAVED.reject],
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

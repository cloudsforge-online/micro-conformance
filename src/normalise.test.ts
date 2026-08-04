/**
 * The normaliser is the part most likely to be wrong, so it is tested directly rather than through
 * a recording. None of these tests needs a running estate: they are pure functions over values,
 * which is the only way this suite can run in CI on a machine that has no compose stack.
 *
 * The governing test is the first one — two responses differing only in ids and timestamps must
 * compare identical — because that is the property the whole corpus rests on. If it does not hold,
 * every comparison is noise and the gate is worthless.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareJson } from './compare.ts'
import { isPlaceholder, normalise, normalisePath, PLACEHOLDER_TYPES, RULES, ruleNames } from './normalise.ts'
import type { Json } from './types.ts'

const n = (value: unknown, exclude?: readonly string[]): Json =>
  normalise(value, exclude ? { exclude } : {}) as Json

describe('the normaliser', () => {
  it('two responses differing only in ids and timestamps compare identical', () => {
    const first = {
      id: '9f1c2b3a-4d5e-4f60-8712-0a1b2c3d4e5f',
      createdAt: '2026-07-29T23:18:19.970Z',
      requestId: '0523c894-365d-4383-8150-7017fabcd9d2',
      shards: 0,
      coin: 'EMBER',
    }
    const second = {
      id: 'ffffffff-1111-4222-8333-444444444444',
      createdAt: '2026-07-30T04:02:00.001Z',
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      shards: 0,
      coin: 'EMBER',
    }

    assert.deepEqual(n(first), n(second))
    assert.deepEqual(compareJson(n(first), n(second)), [])
  })

  /**
   * THE FIELD THAT MADE HALF THE MICRO CORPUS UNCOMPARABLE.
   *
   * The micro estate puts a correlation id inside the error envelope. It is 16 characters of
   * base36, so no value-shaped rule touches it, and every 4xx in the corpus therefore compared
   * `value-changed` on every run and could never contribute an `identical`. Measured before the
   * rule existed: 13 of 26 interactions in the first micro recording.
   */
  it('a micro-estate error envelope compares identical across two runs', () => {
    const first = { error: { code: 'not_found', message: 'no route for GET /health', requestId: 'dt2gk45tk03m39vg' } }
    const second = { error: { code: 'not_found', message: 'no route for GET /health', requestId: 'p7ep5vxz565m2z05' } }
    assert.deepEqual(compareJson(n(first), n(second)), [])
    // The CODE and the MESSAGE are untouched — they are the contract, and a rule that erased them
    // would make every 404 in the estate compare equal to every other one.
    assert.equal((n(first) as { error: { code: string } }).error.code, 'not_found')
  })

  /**
   * THE FIELD THAT WOULD HAVE MADE THE DEPOSIT HAPPY PATH UNCOMPARABLE THE DAY IT WAS RECORDED.
   *
   * `custodyKeyUrn` is `cf:custody:key:<chain>:<network>:<address>` and the address inside it is
   * minted per user per run. No rule touched it: the `evm-address` rule is anchored, so it fires
   * on the `address` field beside it and not on the URN that embeds it. Recording the field as it
   * arrives would have put a value in the corpus that can never match, so `POST /v1/deposits`
   * would have compared `value-changed` on every single run for ever — a suite that fails for a
   * reason nobody believes, which is the failure mode that ends characterisation testing.
   */
  it('a custody key URN compares identical across two runs', () => {
    const first = { custodyKeyUrn: 'cf:custody:key:ember:testnet:0x1C18Aff0eF0e7e44f41d48139EF35e81d0B7d9da' }
    const second = { custodyKeyUrn: 'cf:custody:key:ember:testnet:0x076efB444F349dA51a3A33C6B3148fb26397CaeE' }
    assert.deepEqual(compareJson(n(first), n(second)), [])
  })

  it('a URN in a shape custody does not publish is NOT erased', () => {
    // Value-shaped rather than keyed on the field name, and this is the whole reason. The URN's
    // GRAMMAR is contract — `04-domain-model.md` sets the form `cf:<service>:<type>:<id>` and
    // wallet mints every segment from custody's own reply — so a service that started answering a
    // bare id, or a URN under a different authority, must stay visible as a difference. Keying on
    // the field name would have absorbed all three silently.
    const changed = { custodyKeyUrn: 'urn:custody:0x1C18Aff0eF0e7e44f41d48139EF35e81d0B7d9da' }
    const recorded = { custodyKeyUrn: 'cf:custody:key:ember:testnet:0x076efB444F349dA51a3A33C6B3148fb26397CaeE' }
    assert.notDeepEqual(compareJson(n(recorded), n(changed)), [])
  })

  it('the chain and the network are not lost with it', () => {
    // The URN collapses to one placeholder, so the two facts inside it that are NOT volatile have
    // to survive somewhere. They do: `chain` and `network` are their own fields in the assignment
    // beside it, and neither is normalised. An EMBER address filed under `eth` is still a visible
    // difference.
    const first = { chain: 'ember', network: 'testnet', custodyKeyUrn: 'cf:custody:key:ember:testnet:0xaa18Aff0eF0e7e44f41d48139EF35e81d0B7d9da' }
    const second = { chain: 'eth', network: 'testnet', custodyKeyUrn: 'cf:custody:key:eth:testnet:0xbb18Aff0eF0e7e44f41d48139EF35e81d0B7d9da' }
    assert.notDeepEqual(compareJson(n(first), n(second)), [])
  })

  it('keyed on the field name only, so an opaque id under another name survives', () => {
    // The same 16-character base36 shape under `listingId` is a real identifier and must not be
    // erased by a rule aimed at correlation ids.
    const kept = n({ listingId: 'dt2gk45tk03m39vg' }) as { listingId: string }
    assert.equal(kept.listingId, 'dt2gk45tk03m39vg')
  })

  it('a requestId that is a UUID stays a uuid, so a change of id FORMAT is still visible', () => {
    // `uuid` is earlier in RULES than `request-id`, deliberately. Both formats are normalised, so
    // neither is noise — but a service that swapped UUID correlation ids for base36 ones shows up
    // as `<uuid>` against `<request-id>` rather than silently agreeing.
    assert.equal((n({ requestId: '0523c894-365d-4383-8150-7017fabcd9d2' }) as { requestId: string }).requestId, '<uuid>')
    assert.equal((n({ requestId: 'dt2gk45tk03m39vg' }) as { requestId: string }).requestId, '<request-id>')
  })

  it('two recordings of the same wallet with different generated addresses compare identical', () => {
    const a = { address: '0x54123fdcd2792a7325da615650cbf5a251e62063', coin: 'EMBER', network: 'testnet' }
    const b = { address: '0xabcdef0123456789abcdef0123456789abcdef01', coin: 'EMBER', network: 'testnet' }
    assert.deepEqual(compareJson(n(a), n(b)), [])
  })

  it('an access token never survives normalisation as itself', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWJ5dGVz'
    assert.equal(n({ opaque: jwt }, ['jwt']) === undefined, false)
    assert.deepEqual(n({ opaque: jwt }), { opaque: '<jwt>' })
  })

  it('a gauge moving between two runs is erased, so a block being mined is not a difference', () => {
    const before = { height: 5273, peers: 2, hashrate: 0, mempool: 0, chainId: 7412 }
    const after = { height: 5328, peers: 2, hashrate: 41_000, mempool: 3, chainId: 7412 }
    assert.deepEqual(compareJson(n(before), n(after)), [])
  })

  it('the chain id is NOT a gauge — it survives, so a node on the wrong chain is still visible', () => {
    const right = n({ chainId: 7412, height: 5273 })
    const wrong = n({ chainId: 7411, height: 99_999 })
    const diffs = compareJson(right, wrong)
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0]?.path, 'chainId')
    assert.equal(diffs[0]?.classification, 'breaking')
  })

  it('a hex quantity is erased unless the scenario excludes the rule by name', () => {
    assert.deepEqual(n({ result: '0x1cf4' }), { result: '<hex-quantity>' })
    assert.deepEqual(n({ result: '0x1cf4' }, ['hex-quantity']), { result: '0x1cf4' })
  })

  it('the genesis hash survives when hash-32 is excluded while the tip beside it does not', () => {
    const info = {
      tip: '0xf9cfab3d55bbdd1b57bf404e5c9848f90d9b0e811906dfa6ff5d762cf52934a8',
      genesis: '0xc3a0cc990f31306c54d24c3a490107ce4f91eb18f7941fb3486f02c99c0a7155',
    }
    assert.deepEqual(n(info, ['hash-32']), {
      tip: '<hash>',
      genesis: '0xc3a0cc990f31306c54d24c3a490107ce4f91eb18f7941fb3486f02c99c0a7155',
    })
  })

  it('placeholders carry their source type, so a number becoming a string is still detectable', () => {
    const baseline = n({ usd: 0.3 })
    const target = n({ usd: '0.3' })
    const diffs = compareJson(baseline, target)
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0]?.kind, 'placeholder-type-mismatch')
    assert.equal(diffs[0]?.classification, 'breaking')
  })

  it('every placeholder a rule can produce has a declared type', () => {
    for (const rule of RULES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(PLACEHOLDER_TYPES, rule.placeholder),
        `rule '${rule.name}' produces ${rule.placeholder}, which has no declared type — the comparator ` +
          'would silently stop detecting type changes through it',
      )
    }
  })

  it('every rule states why it exists', () => {
    for (const rule of RULES) {
      assert.ok(rule.why.length > 20, `rule '${rule.name}' has no usable justification`)
    }
    assert.deepEqual(new Set(ruleNames()).size, RULES.length, 'two rules share a name')
  })

  it('normalisation is idempotent — running it twice changes nothing', () => {
    const once = n({ id: '9f1c2b3a-4d5e-4f60-8712-0a1b2c3d4e5f', at: '2026-07-29T23:18:19.970Z' })
    assert.deepEqual(n(once), once)
  })

  it('structure is never changed: no key is added, removed or reordered', () => {
    const input = { a: 1, b: { c: '9f1c2b3a-4d5e-4f60-8712-0a1b2c3d4e5f' }, d: [1, 2, 3] }
    const out = n(input) as Record<string, unknown>
    assert.deepEqual(Object.keys(out), ['a', 'b', 'd'])
    assert.deepEqual(Object.keys(out['b'] as object), ['c'])
    assert.equal((out['d'] as unknown[]).length, 3)
  })

  it('an XRP address is not mistaken for a generic base58 one', () => {
    assert.deepEqual(n({ address: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' }), { address: '<xrp-address>' })
  })

  it('a bech32 Hearth address is recognised as one', () => {
    assert.deepEqual(n({ address: 'ember1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }), {
      address: '<bech32-address>',
    })
  })

  it('isPlaceholder does not claim ordinary strings', () => {
    assert.equal(isPlaceholder('<uuid>'), true)
    assert.equal(isPlaceholder('<not-a-real-placeholder>'), false)
    assert.equal(isPlaceholder('unauthorized'), false)
    assert.equal(isPlaceholder(7412), false)
  })
})

describe('path normalisation', () => {
  it('an id in a path is replaced, so two runs against different worlds still match', () => {
    assert.equal(
      normalisePath('/worlds/9f1c2b3a-4d5e-4f60-8712-0a1b2c3d4e5f/roster'),
      '/worlds/<uuid>/roster',
    )
  })

  it('query parameters are sorted, because their order is not contract', () => {
    assert.equal(normalisePath('/withdrawals?status=pending&limit=10'), '/withdrawals?limit=10&status=pending')
  })

  it('a path with no id and no query survives untouched', () => {
    assert.equal(normalisePath('/coins/rates'), '/coins/rates')
  })

  it('an address in a path is replaced', () => {
    assert.equal(
      normalisePath('/address/0x54123fdcd2792a7325da615650cbf5a251e62063'),
      '/address/<evm-address>',
    )
  })

  it('a malformed percent escape does not abandon the recording', () => {
    assert.equal(normalisePath('/search/%E0%A4%A'), '/search/%E0%A4%A')
  })
})

/**
 * The chain suite over an estate that publishes one of the node's two listeners.
 *
 * `chain` is the only scenario that covers **two listeners of one process**, and `ctx.call` turns
 * an unreachable target into a skip of the whole scenario. On the micro base the REST port is not
 * published — `rpc.<apex>` carries only `/mining/template`, `/mining/submit` and `/events` to it —
 * so the last two calls cannot be made, and taking the suite down for them threw away the five
 * JSON-RPC observations that had already succeeded. The comparator then reported the suite as
 * `scenario-no-longer-records`: "it stopped looking". It had not stopped looking; it had looked at
 * the listener that carries money and could not reach the one that carries emission figures.
 *
 * Driven through `runScenario` against a stub, like `_account.test.ts`, because the outcome under
 * test is `report.outcome` and the interaction list — both of which only the driver produces.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BaseUrls } from '../env.ts'
import { runScenario } from '../scenario.ts'
import type { Interaction } from '../types.ts'
import chain from './chain.ts'

let server: Server
let port = 0

before(async () => {
  server = createServer((req, res) => {
    // Everything this suite asks the JSON-RPC listener is a POST /, and the driver only needs a
    // JSON body back — the assertions here are about which calls were made, not their contents.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1cf3' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function deps(collected: Interaction[], rest: string | { unmapped: true; reason: string }) {
  return {
    base: { 'hearth-rpc': `http://127.0.0.1:${port}`, 'hearth-rest': rest } as unknown as BaseUrls,
    secrets: { literals: [], source: 'test', payServiceToken: undefined, base: 'test', missing: [] },
    shared: new Map<string, unknown>(),
    onInteraction: (i: Interaction) => void collected.push(i),
    sleep: async () => {},
  }
}

const RPC_STEPS = [
  'the chain id is the testnet chain id',
  'net_version answers in decimal, not hex',
  'the block number reads back as a hex quantity',
  'a balance can be read',
  'an unknown method is refused with a JSON-RPC error',
]

describe('the chain suite when only one listener is published', () => {
  it('RECORDS the JSON-RPC half and notes the REST half, rather than skipping the suite', async () => {
    const collected: Interaction[] = []
    const { report } = await runScenario(
      chain,
      deps(collected, { unmapped: true, reason: 'the REST port is not published whole on this base' }),
    )

    assert.equal(report.outcome, 'recorded', report.reason ?? '')
    assert.deepEqual(collected.map((i) => i.step), RPC_STEPS)
    // The absence is carried, not swallowed. Without this the manifest would read as a suite that
    // simply has five steps, and the two that could not be made would be invisible.
    // A note joins `reason` rather than replacing it — see `runScenario` — so this is where a
    // recorded-but-partial suite explains itself in the manifest.
    assert.match(report.reason ?? '', /\/info/)
    assert.match(report.reason ?? '', /\/supply/)
  })

  it('records all seven when the REST listener IS reachable, so nothing was quietly dropped', async () => {
    // The other direction, so "note the absence" cannot be satisfied by never calling them.
    const collected: Interaction[] = []
    const { report } = await runScenario(chain, deps(collected, `http://127.0.0.1:${port}`))

    assert.equal(report.outcome, 'recorded', report.reason ?? '')
    assert.deepEqual(collected.map((i) => i.step), [
      ...RPC_STEPS,
      'the REST listener reports the chain',
      'emission accounting reads back',
    ])
    assert.equal(report.reason, undefined, 'a reachable listener was reported as unreachable')
  })
})

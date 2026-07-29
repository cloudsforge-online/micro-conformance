/**
 * The driver, exercised against a stub target rather than a running estate.
 *
 * Three properties are worth holding here and none of them is provable from the scenarios
 * themselves: an absent service skips with a reason instead of failing, cleanup runs on every exit
 * path including the skipping one, and the rate-limit retry never puts the 429 it waited out into
 * the corpus.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BaseUrls } from './env.ts'
import { defineScenario, runScenario } from './scenario.ts'
import type { Interaction } from './types.ts'

let server: Server
let port = 0
let registrations = 0

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/rate-limited') {
      registrations += 1
      // First caller is turned away, second is served — the shape of Nimbus's per-IP limiter.
      if (registrations === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
        res.end(JSON.stringify({ error: 'Too many requests', code: 'rate_limited' }))
        return
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'stub' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function deps(collected: Interaction[]) {
  const at = `http://127.0.0.1:${port}`
  const base = {
    nimbus: at,
    game: at,
    pay: at,
    mint: at,
    keyvault: at,
    crucible: at,
    lantern: at,
    beacon: at,
    // Deliberately nothing listening: the port is closed, which is how an absent service looks.
    'hearth-rest': 'http://127.0.0.1:1',
    'hearth-rpc': 'http://127.0.0.1:1',
  } as BaseUrls
  return {
    base,
    secrets: { literals: [], source: 'test', payServiceToken: undefined },
    shared: new Map<string, unknown>(),
    onInteraction: (i: Interaction) => collected.push(i),
    // No real waiting: the retry is being tested, not the clock.
    sleep: async () => {},
  }
}

describe('the scenario driver', () => {
  it('an absent service skips with a reason naming the target and the URL, and never fails', async () => {
    const collected: Interaction[] = []
    const outcome = await runScenario(
      defineScenario({
        name: 'stub',
        title: 't',
        description: 'd',
        targets: ['hearth-rest'],
        async run(ctx) {
          await ctx.call('read the chain', { target: 'hearth-rest', path: '/info' })
        },
      }),
      deps(collected),
    )
    assert.equal(outcome.report.outcome, 'skipped')
    assert.match(outcome.report.reason ?? '', /hearth-rest did not answer GET \/info/)
    assert.equal(collected.length, 0)
  })

  it('cleanup runs in reverse order on the skipping path, and its failures are reported separately', async () => {
    const order: string[] = []
    const outcome = await runScenario(
      defineScenario({
        name: 'stub',
        title: 't',
        description: 'd',
        targets: ['nimbus'],
        async run(ctx) {
          ctx.cleanup(async () => {
            order.push('first')
          }, 'first')
          ctx.cleanup(async () => {
            order.push('second')
            throw new Error('teardown blew up')
          }, 'second')
          ctx.skip('deliberately')
        },
      }),
      deps([]),
    )
    assert.deepEqual(order, ['second', 'first'])
    assert.equal(outcome.report.outcome, 'skipped')
    // The skip is the result; the cleanup failure is beside it, not instead of it.
    assert.match(outcome.report.reason ?? '', /deliberately/)
    assert.deepEqual(outcome.report.cleanupErrors, ['second: teardown blew up'])
  })

  it('a thrown error is `failed`, which is a different outcome from `skipped`', async () => {
    const outcome = await runScenario(
      defineScenario({
        name: 'stub',
        title: 't',
        description: 'd',
        targets: ['nimbus'],
        async run() {
          throw new TypeError('the harness is broken')
        },
      }),
      deps([]),
    )
    assert.equal(outcome.report.outcome, 'failed')
    assert.match(outcome.report.reason ?? '', /the harness is broken/)
  })

  it('a waited-out 429 records only the answer, so the corpus never holds a limit the harness caused', async () => {
    registrations = 0
    const collected: Interaction[] = []
    const outcome = await runScenario(
      defineScenario({
        name: 'stub',
        title: 't',
        description: 'd',
        targets: ['nimbus'],
        async run(ctx) {
          await ctx.call('register', {
            target: 'nimbus',
            method: 'POST',
            path: '/rate-limited',
            retryOn429: true,
          })
        },
      }),
      deps(collected),
    )
    assert.equal(outcome.report.outcome, 'recorded')
    assert.equal(registrations, 2, 'the limiter should have been asked twice')
    assert.equal(collected.length, 1, 'only the final attempt belongs in the corpus')
    assert.equal(collected[0]?.response.status, 201)
  })

  it('a setup call marked `record: false` is made but never recorded', async () => {
    const collected: Interaction[] = []
    await runScenario(
      defineScenario({
        name: 'stub',
        title: 't',
        description: 'd',
        targets: ['nimbus'],
        async run(ctx) {
          const res = await ctx.call('setup', { target: 'nimbus', path: '/anything', record: false })
          assert.equal(res.status, 200)
          await ctx.call('the observation', { target: 'nimbus', path: '/anything' })
        },
      }),
      deps(collected),
    )
    assert.deepEqual(collected.map((i) => i.step), ['the observation'])
  })

  it('a request body is normalised and redacted before it is recorded', async () => {
    const collected: Interaction[] = []
    await runScenario(
      defineScenario({
        name: 'stub',
        title: 't',
        description: 'd',
        targets: ['nimbus'],
        async run(ctx) {
          await ctx.call('sign in', {
            target: 'nimbus',
            method: 'POST',
            path: '/auth/login',
            body: { email: 'conformance+abc@conformance.test', password: 'a-real-password' },
          })
        },
      }),
      deps(collected),
    )
    assert.deepEqual(collected[0]?.request.body, { email: '<email>', password: '<redacted>' })
  })
})

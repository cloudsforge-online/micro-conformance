/**
 * What this harness does when the estate will not let it register (micro-org#361).
 *
 * `POST /auth/register` sits behind a Cloudflare Turnstile on mainnet. This harness cannot solve
 * one and holds no service credential to be excused it, so the FIRST call of every recording is
 * refused — and what the manifest says about that refusal is the whole deliverable here. Skipping
 * was already the behaviour; skipping with "answered 403 without a usable session" was not an
 * answer anybody could act on.
 *
 * Driven through `runScenario` against a stub rather than by calling `registerThrowaway` with a
 * hand-built context: the outcome under test is `report.outcome` and `report.reason`, which only
 * the driver produces, and a fake context would let this file agree with itself about a shape the
 * driver never sees.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BaseUrls } from '../env.ts'
import { defineScenario, runScenario } from '../scenario.ts'
import type { Interaction } from '../types.ts'
import { registerThrowaway, sharedThrowaway } from './_account.ts'

/** What the stub answers `POST /auth/register` with. Set per test. */
let answer: { status: number; body: unknown } = { status: 201, body: {} }

let server: Server
let port = 0

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/auth/register') {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function deps() {
  const at = `http://127.0.0.1:${port}`
  return {
    base: { nimbus: at } as unknown as BaseUrls,
    secrets: { literals: [], source: 'test', payServiceToken: undefined, base: 'test', missing: [] },
    shared: new Map<string, unknown>(),
    onInteraction: (_: Interaction) => {},
    sleep: async () => {},
  }
}

const A_SESSION = {
  accessToken: 'a',
  refreshToken: 'b',
  user: { id: '00000000-0000-4000-8000-000000000000' },
}

/** Run one of the two registration helpers under the driver and report what came out. */
async function outcomeOf(
  register: (ctx: Parameters<Parameters<typeof defineScenario>[0]['run']>[0]) => Promise<unknown>,
): Promise<{ outcome: string; reason: string }> {
  const result = await runScenario(
    defineScenario({
      name: 'stub',
      title: 't',
      description: 'd',
      targets: ['nimbus'],
      async run(ctx) {
        await register(ctx)
      },
    }),
    deps(),
  )
  return { outcome: result.report.outcome, reason: result.report.reason ?? '' }
}

const refusal = (code: string) => ({
  status: 403,
  body: { error: { code, message: 'that registration did not carry a completed challenge' } },
})

describe('a registration the estate challenges', () => {
  it('skips naming the CHALLENGE, not a broken identity, when the gate turns the harness away', async () => {
    answer = refusal('challenge_required')
    const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
    assert.equal(outcome, 'skipped')
    // The three things the reason has to carry, and each is a separate failure if it is missing:
    // WHAT stopped it, WHY this tool specifically, and the one-request way to confirm it.
    assert.match(reason, /Turnstile/, 'the reason does not say what refused the registration')
    assert.match(reason, /no service credential/, 'the reason does not say why THIS tool is refused')
    assert.match(reason, /GET \/auth\/challenge/, 'the reason gives no way to confirm the gate is on')
    assert.match(reason, /challenge_required/, 'the reason drops the code identity actually sent')
    // And it must NOT read as an outage. This is the sentence the change exists to stop being
    // printed: it is what the generic `require` produced, and it sent a reader to identity's logs.
    assert.doesNotMatch(reason, /without a usable session/,
      'a working gate was reported as identity failing to issue a session')
  })

  it('says the same thing for the SHARED account, which is where a whole run actually dies', async () => {
    answer = refusal('challenge_required')
    const { outcome, reason } = await outcomeOf((ctx) => sharedThrowaway(ctx))
    assert.equal(outcome, 'skipped')
    assert.match(reason, /Turnstile/)
    assert.doesNotMatch(reason, /so no authenticated surface can be recorded$/,
      'the shared-account path kept the generic message the recorder cannot act on')
  })

  it('reports a challenge_failed differently from nothing being sent', async () => {
    // Only `challenge_required` can happen here — this harness sends no token — so a
    // `challenge_failed` means something in the path produced one. Worth reading, so it is carried
    // through rather than flattened into the same string.
    answer = refusal('challenge_failed')
    const { reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
    assert.match(reason, /challenge_failed/)
  })

  it('leaves a 403 that is NOT the gate exactly as it was — it is a different finding', async () => {
    answer = { status: 403, body: { error: { code: 'forbidden', message: 'registration is closed' } } }
    const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
    assert.equal(outcome, 'skipped')
    assert.doesNotMatch(reason, /Turnstile/,
      'registration being closed for some other reason was reported as the challenge')
    assert.match(reason, /answered 403/)
  })

  it('leaves a 503 alone, because failing closed means NOBODY can register and that is an outage', async () => {
    // identity answers 503 `challenge_unavailable` when it cannot reach Cloudflare. Same envelope,
    // same route, completely different fact — and filing it with the refusals would hide a total
    // outage of the estate's front door behind "the harness was not let through".
    answer = { status: 503, body: { error: { code: 'challenge_unavailable', message: 'unreachable' } } }
    const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
    assert.equal(outcome, 'skipped')
    assert.doesNotMatch(reason, /no service credential/,
      'an outage was reported as this harness lacking a credential')
    assert.match(reason, /answered 503/)
  })

  it('records exactly as before when there is no challenge at all', async () => {
    answer = { status: 201, body: A_SESSION }
    const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
    assert.equal(outcome, 'recorded', reason)
  })
})

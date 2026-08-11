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

/** What it answers `POST /auth/login` with, and every body it was sent. Both reset per test. */
let loginAnswer: { status: number; body: unknown } = { status: 200, body: {} }
let logins: Record<string, unknown>[] = []

let server: Server
let port = 0

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/auth/register') {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
      return
    }
    if (req.url === '/auth/login') {
      // Collected so a test can assert what was posted. `identifier` versus `email` is not a
      // detail: `validateLogin` has never read `email`, and a harness that posted it would be
      // answered 400 on every attempt against every base.
      let raw = ''
      req.on('data', (chunk) => {
        raw += String(chunk)
      })
      req.on('end', () => {
        logins.push(raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>))
        res.writeHead(loginAnswer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(loginAnswer.body))
      })
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

/**
 * A registration that creates the account and issues no session (micro-org#371).
 *
 * Measured on mainnet identity 2.5.19, 2026-08-11: `POST /auth/register` answers 202 with
 * `verificationRequired` and nothing else, and the account it made is refused at sign-in with
 * `email_unverified` until the mailed link is spent. Both helpers here demanded 201-with-a-session
 * through `ctx.require`, whose own message said "no scenario below this can run" — which was
 * accurate, and made the whole corpus one refusal against any base serving the new shape.
 */
const VERIFICATION_REQUIRED = {
  status: 202,
  body: {
    verificationRequired: true,
    email: 'conformance+x@conformance.test',
    status: 'Check your email for a verification link. It expires in 24 hours and works once.',
  },
}

describe('a registration that issues no session', () => {
  const CONFIGURED = 'someone@cloudsforge.example:Correct-Horse-Battery-9'

  function withAccount(value: string | null, body: () => Promise<void>): Promise<void> {
    if (value === null) delete process.env['CONFORMANCE_ACCOUNT']
    else process.env['CONFORMANCE_ACCOUNT'] = value
    logins = []
    loginAnswer = { status: 200, body: A_SESSION }
    return body().finally(() => {
      delete process.env['CONFORMANCE_ACCOUNT']
    })
  }

  it('SKIPS naming CONFORMANCE_ACCOUNT, not a broken identity, when nothing is configured', async () => {
    answer = VERIFICATION_REQUIRED
    await withAccount(null, async () => {
      const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
      assert.equal(outcome, 'skipped')
      // The three things the reason has to carry, exactly as the challenge skip above does: WHAT
      // happened, WHY this tool cannot get past it, and the one thing that would fix it.
      assert.match(reason, /202/, 'the reason does not say what the estate actually answered')
      assert.match(reason, /confirmed/, 'the reason does not say why no session followed')
      assert.match(reason, /CONFORMANCE_ACCOUNT/, 'the reason does not say what to set')
      // And it must not read as an outage. This is the sentence the change exists to stop being
      // printed against a working estate.
      assert.doesNotMatch(
        reason,
        /without a usable session/,
        'a deliberate 202 was reported as identity failing to issue a session',
      )
    })
  })

  it('SIGNS IN as the configured account and records the run', async () => {
    answer = VERIFICATION_REQUIRED
    await withAccount(CONFIGURED, async () => {
      const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
      assert.equal(outcome, 'recorded', reason)
      /*
       * **Kills the mutation "post `email` instead of `identifier`".** `validateLogin` has never
       * read `email` — it reads `identifier` and decides email-or-handle by looking for an `@` —
       * so the mutated version is answered 400 by every base, on every run. It is the exact defect
       * beacon carried in a CRITICAL journey for as long as that journey existed, and asserting
       * only "a session came back" would not catch it here because the stub answers anything.
       */
      assert.equal(logins.length, 1)
      assert.equal(logins[0]?.['identifier'], 'someone@cloudsforge.example')
      assert.equal(logins[0]?.['email'], undefined)
      // The password is split on the FIRST colon, so one inside it survives. A `split(':')[1]`
      // would sign in with a truncated credential and report the account refused.
      assert.equal(logins[0]?.['password'], 'Correct-Horse-Battery-9')
    })
  })

  it('a password containing a colon survives the split', async () => {
    answer = VERIFICATION_REQUIRED
    await withAccount('a@b.example:pa:ss:word', async () => {
      await outcomeOf((ctx) => registerThrowaway(ctx))
      assert.equal(logins[0]?.['identifier'], 'a@b.example')
      assert.equal(logins[0]?.['password'], 'pa:ss:word')
    })
  })

  it('says the configured account is UNVERIFIED rather than reporting identity broken', async () => {
    answer = VERIFICATION_REQUIRED
    await withAccount(CONFIGURED, async () => {
      loginAnswer = { status: 403, body: { error: { code: 'email_unverified', message: 'confirm your email' } } }
      const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
      assert.equal(outcome, 'skipped')
      // The one mistake configuring this invites: the account gets created and nobody spends the
      // link. Kills "let it fall through to the require", whose message names a status code and
      // sends the reader to identity for something identity did correctly.
      assert.match(reason, /never been confirmed/)
      assert.match(reason, /ALREADY-VERIFIED/)
    })
  })

  it('MARKS the session as provisioned, which is what stops the password being rotated', async () => {
    answer = VERIFICATION_REQUIRED
    await withAccount(CONFIGURED, async () => {
      let seen: { provisioned?: boolean } | null = null
      await outcomeOf(async (ctx) => {
        seen = (await registerThrowaway(ctx)) as { provisioned?: boolean }
      })
      /*
       * **Kills the mutation "return provisioned: false", and it is the destructive one.** The
       * `identity` scenario changes the password and never changes it back. Against a throwaway
       * that is harmless; against `CONFORMANCE_ACCOUNT` the first run rewrites the operator's
       * password, the variable still holds the old one, and every later run of the WHOLE harness
       * skips with "identity refuses to sign it in" — caused by this tool.
       */
      assert.equal((seen as { provisioned?: boolean } | null)?.provisioned, true)
    })
  })

  it('an account registered the old way is NOT marked provisioned', async () => {
    // The other direction, so the flag cannot be satisfied by hard-coding `true`. A 201 base — the
    // legacy Nimbus, which `--base local` still records against — is unchanged in every respect,
    // and its throwaway is this run's to do what it likes with.
    answer = { status: 201, body: A_SESSION }
    await withAccount(CONFIGURED, async () => {
      let seen: { provisioned?: boolean } | null = null
      await outcomeOf(async (ctx) => {
        seen = (await registerThrowaway(ctx)) as { provisioned?: boolean }
      })
      assert.equal((seen as { provisioned?: boolean } | null)?.provisioned, false)
      assert.equal(logins.length, 0, 'a base that issued a session was made to sign in as well')
    })
  })

  it('the SHARED account takes the same path, which is where a whole run actually dies', async () => {
    answer = VERIFICATION_REQUIRED
    await withAccount(null, async () => {
      const { outcome, reason } = await outcomeOf((ctx) => sharedThrowaway(ctx))
      assert.equal(outcome, 'skipped')
      assert.match(reason, /CONFORMANCE_ACCOUNT/)
      assert.doesNotMatch(
        reason,
        /so no authenticated surface can be recorded$/,
        'the shared-account path kept the generic message the recorder cannot act on',
      )
    })
  })

  it('a 202 that DOES carry a session is still not used as one', async () => {
    // Belt and braces on the estate's own rule. If identity ever answered 202 with a token in the
    // body it would be signing in an address nobody has proved control of — the defect the 202 was
    // introduced to close — so this harness signs in properly rather than picking the token up.
    answer = { status: 202, body: { verificationRequired: true, ...A_SESSION } }
    await withAccount(CONFIGURED, async () => {
      const { outcome, reason } = await outcomeOf((ctx) => registerThrowaway(ctx))
      assert.equal(outcome, 'recorded', reason)
      assert.equal(logins.length, 1, 'a session in a 202 body was used instead of signing in')
    })
  })
})

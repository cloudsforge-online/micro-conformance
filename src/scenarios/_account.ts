/**
 * The throwaway account every scenario that needs to be somebody uses.
 *
 * **Never a real user, and never the shared synthetic one Beacon drives.** Two separate reasons:
 *
 * - The estate is live. A corpus recorded against a real account would put a real person's wallet,
 *   entitlements and ledger into a committed file, and every later comparison would depend on that
 *   person not buying anything.
 * - Beacon's synthetic account carries a Shard balance that its own journeys move. A recorder
 *   reading it would capture whichever journey happened to be mid-flight, and record a race as
 *   behaviour.
 *
 * Nimbus has no account deletion — no DELETE route, and its CORS configuration does not permit the
 * method at all — so these accounts persist. They are namespaced so they can be found and pruned:
 *
 *   DELETE FROM users WHERE email LIKE 'conformance+%';
 *
 * That is stated here, in the README and in the manifest, because a harness that quietly
 * accumulates rows in a production table is a harness that gets switched off by someone who found
 * out the hard way.
 */

import { randomUUID } from 'node:crypto'
import type { ScenarioContext } from '../scenario.ts'

export const THROWAWAY_EMAIL_DOMAIN = 'conformance.test'

export interface ThrowawayAccount {
  readonly email: string
  readonly handle: string
  readonly password: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly userId: string
}

export function throwawayEmail(runId: string): string {
  return `conformance+${runId.replace(/-/g, '').slice(0, 20)}@${THROWAWAY_EMAIL_DOMAIN}`
}

/** Nimbus handles are 3–20 characters of `[A-Za-z0-9_-]`. */
export function throwawayHandle(runId: string): string {
  return `cf_${runId.replace(/-/g, '').slice(0, 14)}`
}

export function throwawayPassword(): string {
  // Generated per run and never written anywhere. It is a credential for an account that owns
  // nothing, but the redactor still refuses to let it reach disk, and this keeps that true even if
  // a future scenario echoes a request body back.
  return `Cf-${randomUUID().slice(0, 20)}`
}

export interface RegisterOptions {
  /** The step label under which the registration is recorded. Stable, like a Beacon step name. */
  readonly step?: string
}

/**
 * The registration challenge, said out loud rather than left to read as an outage (micro-org#361).
 *
 * `POST /auth/register` may now be gated by a Cloudflare Turnstile. When it is, a caller with no
 * solved challenge and no service-principal bearer is answered **403** with
 * `challenge_required` — and this harness is exactly that caller. It holds no service credential
 * and is not going to be given one: it runs from an operator's laptop, and a long-lived bearer
 * that mints service tokens sitting in a dotfile there is a worse outcome than an unrecorded
 * corpus. A `--base local` recording against the legacy estate is unaffected; nothing in front of
 * Nimbus changed.
 *
 * **WHY THIS IS A MESSAGE AND NOT A BYPASS.** `require` already turns the 403 into a skip, so the
 * harness does not go red either way. What it produced was "answered 403 without a usable session
 * — no scenario below this can run", on every scenario in the run, which reads as identity being
 * broken and is the sentence somebody would open an incident on. The estate is working; this tool
 * is not allowed through it. Those are different facts and the manifest should carry the right one.
 *
 * The two codes are identity's own (`ChallengeError`, identity/src/server.ts): `challenge_required`
 * is "nothing was sent", `challenge_failed` is "something was sent and did not hold". Only the
 * first can happen here, and both are named because reading the second would be worth knowing —
 * it would mean something in the path is inserting a token this harness never produced.
 *
 * A 503 (`challenge_unavailable`) is DELIBERATELY not in here. identity fails closed when it
 * cannot reach Cloudflare, which means nobody in the world can register: that is an outage, it
 * should read as one, and folding it in with these would hide it behind "the harness was not let
 * through".
 */
const CHALLENGE_CODES: ReadonlySet<string> = new Set(['challenge_required', 'challenge_failed'])

const CHALLENGE_SKIP =
  'registration is challenged (Turnstile, micro-org#361) and this harness holds no service ' +
  'credential to be excused it, so no authenticated surface can be recorded against this base. ' +
  'The estate is not broken; ask identity GET /auth/challenge to confirm the gate is on.'

/** The refusal code, if this response is the registration gate turning the harness away. */
function challengeRefusal(status: number, body: unknown): string | null {
  if (status !== 403) return null
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code
  return typeof code === 'string' && CHALLENGE_CODES.has(code) ? code : null
}

/**
 * Register a throwaway account and return its credentials.
 *
 * Skips rather than fails on 429. Nimbus rate-limits registration to five per minute per IP and
 * this harness shares one source address with Beacon; a limit hit is the estate protecting itself,
 * not the estate being broken, and recording it as a failure would be recording a false incident.
 */
export async function registerThrowaway(
  ctx: ScenarioContext,
  options: RegisterOptions = {},
): Promise<ThrowawayAccount> {
  const email = throwawayEmail(ctx.runId)
  const handle = throwawayHandle(ctx.runId)
  const password = throwawayPassword()

  const res = await ctx.call(options.step ?? 'register a throwaway account', {
    target: 'nimbus',
    method: 'POST',
    path: '/auth/register',
    body: { email, password, handle },
    retryOn429: true,
  })

  if (res.status === 429) {
    ctx.skip('Nimbus is rate-limiting registration (5/min per IP) — another harness got there first')
  }
  const refusal = challengeRefusal(res.status, res.body)
  if (refusal !== null) ctx.skip(`${CHALLENGE_SKIP} (${refusal})`)

  const body = res.body as { accessToken?: string; refreshToken?: string; user?: { id?: string } } | null
  ctx.require(
    res.status === 201 && body?.accessToken && body?.refreshToken && body?.user?.id,
    `Nimbus POST /auth/register answered ${res.status} without a usable session — no scenario below this can run`,
  )

  return {
    email,
    handle,
    password,
    accessToken: body?.accessToken as string,
    refreshToken: body?.refreshToken as string,
    userId: body?.user?.id as string,
  }
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

const SHARED_KEY = 'throwaway-account'

/**
 * The one throwaway account every scenario except `identity` signs in as.
 *
 * Registered once per recording, not once per scenario, for two reasons that are both about not
 * being the incident:
 *
 * - Nimbus rate-limits registration to **five per minute per IP** and the whole harness shares one
 *   source address. Six scenarios each registering trips that limit, and the corpus then records a
 *   429 as though it were the estate's behaviour.
 * - Nimbus has no account deletion, so a registration per scenario is six permanent rows per run
 *   in a live table.
 *
 * `identity` deliberately does **not** use this one. It registers its own, records the
 * registration as an interaction because that is the thing it characterises, and then changes the
 * password and burns the refresh family — all of which would break every scenario after it if it
 * did that to the shared account.
 *
 * The registration itself is unrecorded (`record: false`): it is the harness getting into
 * position, not an observation.
 */
export async function sharedThrowaway(ctx: ScenarioContext): Promise<ThrowawayAccount> {
  const cached = ctx.shared.get(SHARED_KEY) as ThrowawayAccount | undefined
  if (cached) return cached

  const email = throwawayEmail(ctx.runId)
  const handle = throwawayHandle(ctx.runId)
  const password = throwawayPassword()

  const res = await ctx.call('acquire the shared throwaway account', {
    target: 'nimbus',
    method: 'POST',
    path: '/auth/register',
    body: { email, password, handle },
    record: false,
    retryOn429: true,
  })

  if (res.status === 429) {
    ctx.skip('Nimbus is rate-limiting registration (5/min per IP) — another harness got there first')
  }
  const refusal = challengeRefusal(res.status, res.body)
  if (refusal !== null) ctx.skip(`${CHALLENGE_SKIP} (${refusal})`)

  const body = res.body as { accessToken?: string; refreshToken?: string; user?: { id?: string } } | null
  ctx.require(
    res.status === 201 && body?.accessToken && body?.refreshToken && body?.user?.id,
    `Nimbus POST /auth/register answered ${res.status}, so no authenticated surface can be recorded`,
  )

  const account: ThrowawayAccount = {
    email,
    handle,
    password,
    accessToken: body?.accessToken as string,
    refreshToken: body?.refreshToken as string,
    userId: body?.user?.id as string,
  }
  ctx.shared.set(SHARED_KEY, account)
  return account
}

/**
 * Publish an account as the run's shared one.
 *
 * `identity` calls this with the session it holds after its password change, so the whole run
 * costs **one** registration rather than two. Two is enough to matter: a `record` followed
 * immediately by a `compare` — the normal way this tool is used, and the way it is verified — puts
 * four registrations into one sixty-second window against a five-per-minute limit.
 */
export function publishSharedAccount(ctx: ScenarioContext, account: ThrowawayAccount): void {
  ctx.shared.set(SHARED_KEY, account)
}

/** The recorder reads this after the last scenario to revoke the shared session. */
export function sharedAccountOf(shared: Map<string, unknown>): ThrowawayAccount | undefined {
  return shared.get(SHARED_KEY) as ThrowawayAccount | undefined
}

/**
 * Revoke a refresh family on the way out.
 *
 * Registered with `ctx.cleanup`, so it runs on every exit path. Nimbus keeps refresh tokens for
 * thirty days; a harness that recorded daily and never logged out would leave a year of live
 * sessions behind it.
 */
export function revokeOnExit(ctx: ScenarioContext, refreshToken: () => string | undefined): void {
  ctx.cleanup(async () => {
    const token = refreshToken()
    if (!token) return
    await ctx.call('revoke the session', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/logout',
      body: { refreshToken: token },
    })
  }, 'revoke session')
}

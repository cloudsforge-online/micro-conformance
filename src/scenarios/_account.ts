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

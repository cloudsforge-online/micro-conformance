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
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **REGISTRATION STOPPED HANDING OUT A SESSION, AND THIS FILE DEMANDED ONE FROM A `require`.**
 *
 * Measured against mainnet identity 2.5.19 on 2026-08-11, asked directly rather than read out of
 * the source: `POST /auth/register` answers **202 with no token, no refresh token and no user id**,
 * and `POST /auth/login` on the account it just made answers **403 `email_unverified`**. The
 * session is minted by `POST /auth/email/verify`, which spends a token that arrives by mail.
 *
 *     POST /auth/register              202  {"verificationRequired":true,"email":"…","status":"…"}
 *     POST /auth/login (that account)  403  {"error":{"code":"email_unverified", …}}
 *
 * Both helpers below asserted `res.status === 201 && body.accessToken && …` through `ctx.require`,
 * whose own message said "no scenario below this can run". That was accurate: every authenticated
 * scenario in the harness is downstream of one of these two calls, so against any base serving the
 * new shape the whole corpus was one refusal.
 *
 * **IDENTITY IS NOT WRONG AND THIS IS NOT WORKED AROUND.** The 202 closed a real defect — an
 * address nobody had proved control of was signed in the moment it was typed. So the harness
 * records what each base actually does:
 *
 *   * **201 with a session** — the legacy Nimbus, which `--base local` still records against. Used
 *     exactly as before. Nothing about that path changes.
 *   * **202 with no session** — micro identity. The registration is a real observation and is
 *     recorded as one; what cannot follow from it is a session, so the authenticated half of the
 *     run comes from `CONFORMANCE_ACCOUNT` (below) or the run skips with a reason that says which
 *     of the two is missing.
 *
 * **This harness will never verify an address itself.** The token lives in the
 * `identity.email.verification_requested` event payload, in notify's outbox, and it is a live
 * credential — micro-org#371 is explicit that a harness needing a verified account must obtain one
 * without the token ever reaching a log. Reading another service's outbox from an operator's laptop
 * is not a way to satisfy that; being handed an already-verified account is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
  /**
   * True when this is `CONFORMANCE_ACCOUNT` rather than an account this run created.
   *
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * **IT EXISTS SO THAT NOTHING DESTRUCTIVE IS DONE TO SOMEBODY ELSE'S ACCOUNT.**
   *
   * The `identity` scenario changes the password and never changes it back — which is correct for
   * a throwaway created eleven seconds ago, and against a provisioned account would rewrite the
   * operator's `CONFORMANCE_ACCOUNT` on the first run and lock the harness out on the second. The
   * scenario reads this and records a note instead.
   *
   * A flag rather than "compare the email against the variable", because the comparison would be a
   * second place that knows how the variable is spelled and would silently answer `false` the day
   * one of them changed — with the failure being a password rotation on a live account.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  readonly provisioned: boolean
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
 * The status registration answers when it has created an account but issued no session.
 *
 * Named rather than written as `202` at each site, because the two places that read it must agree
 * and because the number alone reads as arbitrary. It is identity's own: "NO SESSION. THIS IS THE
 * POINT OF THE ROUTE'S 202."
 */
const VERIFICATION_REQUIRED = 202

/** The session shape a registration used to return, or null when the response carries none. */
interface Session {
  readonly accessToken: string
  readonly refreshToken: string
  readonly userId: string
}

function sessionIn(body: unknown): Session | null {
  const shape = body as { accessToken?: unknown; refreshToken?: unknown; user?: { id?: unknown } } | null
  const { accessToken, refreshToken } = shape ?? {}
  const userId = shape?.user?.id
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof userId !== 'string') {
    return null
  }
  return { accessToken, refreshToken, userId }
}

/**
 * An already-verified account this harness may sign in as, from the environment.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ONLY WAY THIS TOOL CAN BE SOMEBODY AGAINST AN ESTATE THAT VERIFIES ADDRESSES.**
 *
 * A registration no longer yields a session and this harness cannot spend a verification link, so
 * an authenticated corpus needs an account somebody else made and confirmed. `CONFORMANCE_ACCOUNT`
 * is `email:password` — one account, not a pool, because the harness already shares one account
 * across every scenario for reasons `sharedThrowaway` sets out and nothing here runs concurrently.
 *
 * Split on the FIRST colon: an email address cannot contain one and a password can contain several.
 *
 * **Absent is a supported state and always will be.** It is what `--base local` is in, where the
 * legacy Nimbus still answers 201 and none of this is reached, and it is what a fresh checkout is
 * in. Absent plus a 202 is a skip that names both facts, so the manifest says the harness was not
 * equipped rather than that the estate was broken.
 *
 * Read at call time, never cached in a module constant: the recorder and the comparator run in one
 * process and a test must be able to set it without reloading this module.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function configuredAccount(): { email: string; password: string } | null {
  const raw = process.env['CONFORMANCE_ACCOUNT']?.trim() ?? ''
  if (raw.length === 0) return null
  const colon = raw.indexOf(':')
  if (colon <= 0 || colon === raw.length - 1) return null
  return { email: raw.slice(0, colon), password: raw.slice(colon + 1) }
}

const NO_ACCOUNT_SKIP =
  'POST /auth/register answered 202: the account was created and NO session was issued, because ' +
  'the address has to be confirmed by the link identity mails. This harness cannot read that ' +
  'mail and will not read notify\'s outbox to find the token, so it has no way to become ' +
  'somebody here. Set CONFORMANCE_ACCOUNT=email:password to an account that is already verified ' +
  'and every authenticated scenario records again. The estate is not broken. micro-org#371.'

/**
 * Sign in as `CONFORMANCE_ACCOUNT`, or skip saying that it is what is missing.
 *
 * Recorded as an interaction by default, unlike the registration it stands in for: a sign-in IS a
 * behaviour worth characterising, and it is the one that now produces every session in the run.
 */
async function signInAsConfigured(
  ctx: ScenarioContext,
  step: string,
  record: boolean,
): Promise<ThrowawayAccount> {
  const configured = configuredAccount()
  if (configured === null) ctx.skip(NO_ACCOUNT_SKIP)

  const res = await ctx.call(step, {
    target: 'nimbus',
    method: 'POST',
    path: '/auth/login',
    // `identifier`, NOT `email`. `@cloudsforge/contracts-auth`'s `validateLogin` has never read
    // `email`; posting it is answered 400 on every attempt, which is a defect beacon carried in a
    // CRITICAL journey for as long as that journey existed.
    body: { identifier: configured.email, password: configured.password },
    record,
    retryOn429: true,
  })

  if (res.status === 429) {
    ctx.skip('Nimbus is rate-limiting sign-in — another harness got there first')
  }
  const code = (res.body as { error?: { code?: unknown } } | null)?.error?.code
  if (res.status === 403 && code === 'email_unverified') {
    // The one mistake configuring this invites, and the one whose generic message would send the
    // reader to identity for something identity did correctly.
    ctx.skip(
      'CONFORMANCE_ACCOUNT names an account whose address has never been confirmed, so identity ' +
        'refuses to sign it in. It must be an ALREADY-VERIFIED account; creating one is not enough.',
    )
  }

  const session = sessionIn(res.body)
  ctx.require(
    res.status === 200 && session !== null,
    `Nimbus POST /auth/login answered ${res.status} for CONFORMANCE_ACCOUNT without a usable ` +
      'session — no authenticated scenario can be recorded',
  )

  return {
    email: configured.email,
    // Unknown, and deliberately not guessed. This harness signs in with an identifier and never
    // needed the handle; inventing one from the address would put a wrong value into any corpus
    // that later recorded it.
    handle: '',
    password: configured.password,
    accessToken: (session as Session).accessToken,
    refreshToken: (session as Session).refreshToken,
    userId: (session as Session).userId,
    provisioned: true,
  }
}

/**
 * Register a throwaway account, and come back holding a session however this base issues one.
 *
 * Skips rather than fails on 429. Nimbus rate-limits registration to five per minute per IP and
 * this harness shares one source address with Beacon; a limit hit is the estate protecting itself,
 * not the estate being broken, and recording it as a failure would be recording a false incident.
 *
 * The registration itself is recorded whichever way it goes — a 202 is exactly as much a fact about
 * the estate as a 201 was, and this tool exists to write down facts about the estate.
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

  if (res.status === VERIFICATION_REQUIRED) {
    return signInAsConfigured(ctx, 'sign in as the configured verified account', true)
  }

  const session = sessionIn(res.body)
  ctx.require(
    res.status === 201 && session !== null,
    `Nimbus POST /auth/register answered ${res.status} without a usable session — no scenario below this can run`,
  )

  return {
    email,
    handle,
    password,
    accessToken: (session as Session).accessToken,
    refreshToken: (session as Session).refreshToken,
    userId: (session as Session).userId,
    provisioned: false,
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

  if (res.status === VERIFICATION_REQUIRED) {
    // `record: false`, matching the registration above it: this is the harness getting into
    // position for the scenario that asked, not an observation. `registerThrowaway` records its
    // sign-in because that call IS its subject; this one is not.
    const configured = await signInAsConfigured(ctx, 'sign in as the configured verified account', false)
    ctx.shared.set(SHARED_KEY, configured)
    return configured
  }

  const session = sessionIn(res.body)
  ctx.require(
    res.status === 201 && session !== null,
    `Nimbus POST /auth/register answered ${res.status}, so no authenticated surface can be recorded`,
  )

  const account: ThrowawayAccount = {
    email,
    handle,
    password,
    accessToken: (session as Session).accessToken,
    refreshToken: (session as Session).refreshToken,
    userId: (session as Session).userId,
    provisioned: false,
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

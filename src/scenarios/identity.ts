/**
 * Identity.
 *
 * One account for every product, so a difference here is a difference everywhere. The scenario
 * records the whole session lifecycle against a throwaway account it creates itself: registration,
 * the token identifying its owner, the SSO handoff that carries a session between products,
 * rotation, **refresh reuse detection**, and a password change.
 *
 * The reuse case is the one worth the effort. Nimbus rotates refresh tokens and a burnt token
 * revokes the whole family — the defence against a stolen refresh token being usable forever — and
 * `nimbus/src/tokens.test.ts` already proves it at the unit level. What this records is the
 * observable half: the exact status and error code a burnt token gets, and the fact that the token
 * that replaced it dies with it. A replacement identity service that answers 401 to the burnt
 * token but keeps honouring its successor has passed every unit test and lost the property.
 */

import { defineScenario } from '../scenario.ts'
import type { ScenarioContext } from '../scenario.ts'
import { bearer, publishSharedAccount, registerThrowaway } from './_account.ts'

/**
 * Return URLs to offer the handoff, in order.
 *
 * `PORTAL_ALLOWED_ORIGINS` is derived from `CLOUDSFORGE_APEX`, so which of these Nimbus accepts is
 * a property of the deployment rather than of the code. Trying candidates and recording the one
 * that worked beats guessing once and recording a permanent 403 as the estate's behaviour.
 */
const RETURN_URL_CANDIDATES = [
  'http://localhost:3000/',
  'http://localhost:3001/',
  'http://localhost:4006/',
]

export default defineScenario({
  name: 'identity',
  title: 'An account is created, recognised, handed between products, rotated and re-secured',
  description:
    'A difference here locks every product at once: nobody can register, nobody can cross from the site to the game, ' +
    'and — if reuse detection changes — a stolen refresh token stays valid instead of burning its family.',
  targets: ['nimbus', 'game'],
  // `ctx` is annotated explicitly because `ctx.require` is an assertion function, and TypeScript
  // only narrows through one when the call target has a declared type.
  async run(ctx: ScenarioContext) {
    const account = await registerThrowaway(ctx)

    await ctx.call('read the account back from the token', {
      target: 'nimbus',
      path: '/auth/me',
      headers: bearer(account.accessToken),
    })

    await ctx.call('an unauthenticated read is refused', {
      target: 'nimbus',
      path: '/auth/me',
    })

    // ------------------------------------------------------------------ SSO --
    let redirectUrl: string | undefined
    let acceptedOrigin: string | undefined
    for (const returnUrl of RETURN_URL_CANDIDATES) {
      const res = await ctx.call('request a handoff code', {
        target: 'nimbus',
        method: 'POST',
        path: '/portal/handoff',
        headers: bearer(account.accessToken),
        body: { returnUrl },
      })
      if (res.status === 200) {
        redirectUrl = (res.body as { redirectUrl?: string } | null)?.redirectUrl
        acceptedOrigin = new URL(returnUrl).origin
        break
      }
      // A refused candidate is recorded too — the 4xx and its error code are behaviour, and the
      // next candidate overwrites nothing because each call gets its own sequence number.
    }

    if (redirectUrl && acceptedOrigin) {
      // The code arrives in the fragment, deliberately: a fragment is never sent to a server,
      // never logged by a proxy and never lands in a Referer header. The recorder redacts it out
      // of the redirect URL it just wrote; this reads it from the live response, which never
      // reaches disk.
      const code = new URLSearchParams(new URL(redirectUrl).hash.replace(/^#/, '')).get('cf_code')
      ctx.require(code, 'the handoff redirect carried no #cf_code fragment, so the exchange cannot be exercised')

      const exchanged = await ctx.call('exchange the code for tokens', {
        target: 'nimbus',
        method: 'POST',
        path: '/auth/exchange',
        headers: { origin: acceptedOrigin },
        body: { code },
      })

      await ctx.call('the code cannot be spent twice', {
        target: 'nimbus',
        method: 'POST',
        path: '/auth/exchange',
        headers: { origin: acceptedOrigin },
        body: { code },
      })

      const handed = (exchanged.body as { accessToken?: string; refreshToken?: string } | null) ?? {}
      if (handed.accessToken) {
        // The point of a handoff is that the token works somewhere else. Recording it against the
        // game proves the cross-service half — a token that verifies at Nimbus and is refused by
        // every product is a working handoff to nowhere.
        await ctx.call('the handed-off token works on another service', {
          target: 'game',
          path: '/worlds',
          headers: bearer(handed.accessToken),
        })
      }
      if (handed.refreshToken) {
        const handedRefresh = handed.refreshToken
        ctx.cleanup(async () => {
          await ctx.call('revoke the handed-off session', {
            target: 'nimbus',
            method: 'POST',
            path: '/auth/logout',
            body: { refreshToken: handedRefresh },
          })
        }, 'revoke handed-off session')
      }
    } else {
      ctx.note('Nimbus refused every candidate return URL, so the SSO exchange was not recorded')
    }

    // -------------------------------------------------------------- refresh --
    const rotated = await ctx.call('rotate the refresh token', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken: account.refreshToken },
    })
    const rotatedToken = (rotated.body as { refreshToken?: string } | null)?.refreshToken

    // The burn. Presenting the token that was just rotated away must fail, and must take the whole
    // family with it — otherwise a stolen refresh token is a permanent session and rotation is
    // decoration.
    await ctx.call('a burnt refresh token is refused', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken: account.refreshToken },
    })

    if (rotatedToken) {
      // The consequence, recorded separately from the cause. This is the interaction that shows
      // reuse detection revoked the family rather than merely rejecting one token.
      await ctx.call('the reused token revoked its whole family', {
        target: 'nimbus',
        method: 'POST',
        path: '/auth/refresh',
        body: { refreshToken: rotatedToken },
      })
    }

    // ------------------------------------------------------- password change --
    const newPassword = `${account.password}-2`

    await ctx.call('a password change with the wrong current password is refused', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/password',
      headers: bearer(account.accessToken),
      body: { currentPassword: 'not-the-password', newPassword },
    })

    await ctx.call('change the password', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/password',
      headers: bearer(account.accessToken),
      body: { currentPassword: account.password, newPassword },
    })

    const relogin = await ctx.call('sign in with the new password', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/login',
      body: { email: account.email, password: newPassword },
    })
    // This account becomes the run's shared one. It is deliberately the LAST thing identity does
    // with it: everything above burns a refresh family and changes a password, and a scenario that
    // inherited it mid-way would be signing in as an account this one was still rearranging.
    //
    // The session is revoked by the recorder after the final scenario rather than here, because
    // revoking it here is exactly what would make every scenario below fail.
    const session = relogin.body as { accessToken?: string; refreshToken?: string } | null
    if (session?.accessToken && session?.refreshToken) {
      publishSharedAccount(ctx, {
        ...account,
        password: newPassword,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      })
    }

    await ctx.call('the old password no longer signs in', {
      target: 'nimbus',
      method: 'POST',
      path: '/auth/login',
      body: { email: account.email, password: account.password },
    })
  },
})

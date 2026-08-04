/**
 * The wallet capability, at the address that actually serves it.
 *
 * This is the successor to `wallet`, not a rewrite of it. `wallet` records forge-pay's
 * `/wallet`, `/coins/rates`, `/deposit-coins` and `/deposits`; micro-wallet serves none of those
 * and answers 404 to every one. It serves `/v1/wallets`, `/v1/portfolio`, `/v1/deposits`,
 * `/v1/deposits/credits` and `/v1/withdrawals` instead (`wallet/src/server.ts:445-806`). Both
 * suites exist and neither is pointed at the other's estate — see the `micro-wallet` row in
 * `env.ts` for why merging them would manufacture a pass out of six stable 404s.
 *
 * **Reads only. No money moves, and nothing is provisioned.** Stronger than `wallet`'s limit,
 * which allows the find-or-create deposit address, and the difference is not caution — see below.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY `POST /v1/deposits` IS NOT RECORDED HERE, ALTHOUGH IT IS THE MOST VALUABLE INTERACTION
 * THE LEGACY SUITE HAS.**
 *
 * Because on this estate it is **broken**, and a baseline is the thing later runs are compared
 * against — so recording it would make the defect the contract and make its repair read as a
 * breaking difference. Measured 2026-08-04, authenticated, through the gateway:
 *
 *   POST /v1/deposits {"assetCode":"EMBER"}  →  500 {"error":{"code":"internal"}}
 *
 * and wallet's own log names the cause: `CustodyRefusedError: POST http://custody:4000/v1/addresses
 * → 400`, thrown at `wallet/src/custodyclient.ts:153` and caught by nothing — the class appears in
 * `wallet/src` three times, all three inside `custodyclient.ts`, so it reaches the generic handler
 * and a peer-decided 4xx is served to the caller as an internal error.
 *
 * That is two defects in one response and neither is this harness's to fix. What this harness owes
 * them is not to freeze either one into a golden file.
 *
 * The route is still characterised, by the half of it that is deterministic and correct:
 * `POST /v1/deposits` with an asset that does not settle on a chain answers **400
 * `not_depositable`** without ever reaching custody. That records the refusal, the error code and
 * the auth requirement of the write path, and it records nothing that is currently broken.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'micro-wallet',
  title: 'The wallet, the portfolio and the deposit and withdrawal ledgers read back',
  description:
    'A difference here means a user cannot see their balances, cannot see what they have deposited or withdrawn, or is ' +
    'shown somebody else’s wallet — the last of which is what the anonymous refusals below exist to catch.',
  targets: ['micro-wallet', 'nimbus'],
  async run(ctx) {
    // The anonymous refusal comes first, deliberately. It is the only interaction in this suite
    // that is meaningful without an account, so recording it first means a run that cannot get an
    // account still leaves the auth boundary in the corpus.
    await ctx.call('a wallet read without a token is refused', {
      target: 'micro-wallet',
      path: '/v1/wallets',
    })

    const account = await sharedThrowaway(ctx)
    const auth = bearer(account.accessToken)

    await ctx.call('list the wallets', { target: 'micro-wallet', path: '/v1/wallets', headers: auth })

    // The portfolio is the one that carries a health signal in its own body: `degraded` names the
    // sources it could not read. A corpus recorded while it is non-empty would be a corpus of a
    // partly-blind estate, so the field being recorded is exactly what makes that visible.
    await ctx.call('read the portfolio', { target: 'micro-wallet', path: '/v1/portfolio', headers: auth })

    await ctx.call('list the deposit addresses', { target: 'micro-wallet', path: '/v1/deposits', headers: auth })
    await ctx.call('list the deposit credits', { target: 'micro-wallet', path: '/v1/deposits/credits', headers: auth })
    await ctx.call('list the withdrawals', { target: 'micro-wallet', path: '/v1/withdrawals', headers: auth })

    // The write path's refusal, which never reaches custody — see the header. `not_depositable` is
    // the error code a client renders, and a change to it is a broken funding page.
    await ctx.call('an asset that does not settle on a chain has no deposit address', {
      target: 'micro-wallet',
      method: 'POST',
      path: '/v1/deposits',
      headers: auth,
      body: { assetCode: 'NOTACOIN' },
    })
  },
})

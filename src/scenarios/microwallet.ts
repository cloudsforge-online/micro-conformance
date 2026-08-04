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
 * **Reads, plus the find-or-create deposit address — which is exactly `wallet`'s limit.** No money
 * moves. Nothing else is provisioned.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE EXCLUSION OF `POST /v1/deposits` IS GONE, AND ITS REMOVAL IS THE POINT OF THIS HEADER.**
 *
 * What stood here, until 2026-08-04, was right at the time and is worth restating rather than
 * deleting, because the reasoning is the reusable part:
 *
 *   > Because on this estate it is broken, and a baseline is the thing later runs are compared
 *   > against — so recording it would make the defect the contract and make its repair read as a
 *   > breaking difference. Measured 2026-08-04, authenticated, through the gateway:
 *   > `POST /v1/deposits {"assetCode":"EMBER"}` → `500 {"error":{"code":"internal"}}`.
 *
 * **The route was then repaired, and an exclusion has no way of noticing that.** Wallet was not
 * sending the `orderId` custody requires; it now sends the deposit assignment's own id
 * (`wallet/src/deposits.ts`, the block above `custody.createAddress`). Re-measured before this was
 * removed, through the gateway with a throwaway account's own token:
 *
 *   POST /v1/deposits {"assetCode":"EMBER"}  →  201, an assignment with an address, a walletId,
 *                                                a custodyKeyUrn naming that address, status
 *                                                "active" and a non-null watchedAt.
 *
 * That is the whole shape of the hazard this file now records against: **an exclusion written for
 * a true reason outlives the reason, and nothing about the repair touches the file that excluded
 * it.** The estate got better and the corpus got quieter, and the two were unrelated events. Every
 * suite here that names a defect as its reason for not recording something carries the same risk.
 *
 * **And a recording is not evidence.** Nothing below asserts that the estate is correct — this is
 * a characterisation harness and it has no opinion. What the golden files are is the thing the
 * NEXT run is evidence against. The estate was checked for degradation before this was recorded,
 * because a baseline of a degraded estate makes the degradation the contract: `GET /v1/portfolio`
 * answered `degraded: []`, which is micro-wallet's own statement that it could read every source
 * it depends on.
 *
 * The refusal half stays recorded and is now the thing that keeps the happy path honest: a route
 * that answered 201 to everything would satisfy the provisioning interaction and fail this one.
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

    // ────────────────────────────────────────────────────────────────────────────────────────
    // THE HAPPY PATH, RECORDED LAST SO THAT NOTHING ABOVE IT MOVED.
    //
    // Appended rather than inserted beside the other deposit calls, and the ordering is load
    // bearing in two ways. `GET /v1/deposits` at seq 3 records what a fresh account sees — an
    // empty list — and provisioning before it would have overwritten that with a populated one,
    // losing a real characterisation to gain nothing. And a new interaction in the middle
    // renumbers every golden file after it, which turns a two-file diff into a seven-file one
    // and hides the change that was actually made.
    //
    // EMBER, because `CHAIN_FOR_ASSET` in `wallet/src/addresses.ts` maps it to a chain. SHARD
    // would take the `not_depositable` branch above and characterise the same refusal twice.
    // ────────────────────────────────────────────────────────────────────────────────────────
    await ctx.call('a deposit address is provisioned for an asset that settles on a chain', {
      target: 'micro-wallet',
      method: 'POST',
      path: '/v1/deposits',
      headers: auth,
      body: { assetCode: 'EMBER' },
    })

    // Asked a second time, and recorded, because "201 again" IS the contract a client depends on:
    // the receive panel calls this route on every render. What the corpus can hold is the STATUS
    // and the SHAPE — that a repeat is not a 409 and not a second-shaped reply. What it cannot
    // hold is that the id is the SAME id, because normalisation turns both into `<uuid>`, which is
    // right: identity across two runs is not a thing a golden file can express. Beacon's
    // `ecosystem.deposit-address` journey asserts that half against the live estate, where it can
    // compare the two ids it received. Two tiers, one property, neither pretending to the other's
    // half.
    await ctx.call('asking for the same deposit address again is not a conflict', {
      target: 'micro-wallet',
      method: 'POST',
      path: '/v1/deposits',
      headers: auth,
      body: { assetCode: 'EMBER' },
    })

    // The read-back, AFTER provisioning. Paired with seq 3 above, this is the one place in the
    // corpus where the same route is recorded empty and populated, so the shape of an assignment
    // as it is LISTED — not merely as it is returned from the write — is characterised too. A
    // service that dropped a field from the list projection and not from the write would be
    // invisible without it.
    await ctx.call('the provisioned address is listed', {
      target: 'micro-wallet',
      path: '/v1/deposits',
      headers: auth,
    })
  },
})

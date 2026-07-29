/**
 * The wallet and the top of the funnel.
 *
 * Reads only, plus one write that provisions the throwaway account's own deposit address. **No
 * money moves.** There is no credit, no charge, no conversion and no withdrawal in this scenario,
 * and that is a deliberate limit rather than an omission: the estate is live, `POST /withdrawals`
 * takes a destination the caller names, and a recorder that could move value is a recorder that
 * eventually does.
 *
 * `POST /deposits` is the exception and is safe for a reason worth stating. It is find-or-create:
 * Pay asks custody for an address for this user and this coin, and asking twice returns the same
 * row. The second call is recorded as its own interaction because that idempotency is the
 * behaviour — a replacement that issues a second address for the same user shows whoever reloads
 * the funding page somewhere new to send money to, and the coins already sent sit on an address
 * the deposit watcher has stopped following.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'wallet',
  title: 'A wallet reads back, coins are priced, and a deposit address is issued once',
  description:
    'A difference here means a user cannot see their Shards, cannot be told where to send coins, or is told somewhere new ' +
    'each time they ask — which loses the money they already sent to the old address.',
  targets: ['pay', 'nimbus', 'keyvault'],
  async run(ctx) {
    const account = await sharedThrowaway(ctx)

    await ctx.call('read the wallet', {
      target: 'pay',
      path: '/wallet',
      headers: bearer(account.accessToken),
    })

    await ctx.call('a wallet read without a token is refused', {
      target: 'pay',
      path: '/wallet',
    })

    await ctx.call('read the price board', { target: 'pay', path: '/coins/rates' })
    await ctx.call('read the deposit chain registry', { target: 'pay', path: '/deposit-coins' })
    await ctx.call('read the withdrawal chain registry', { target: 'pay', path: '/withdrawal-coins' })

    // EMBER on testnet: the one family this estate mines itself, so the address can be provisioned
    // without depending on an external chain or a funded faucet.
    const provision = { coin: 'EMBER', network: 'testnet' }

    const first = await ctx.call('provision a deposit address', {
      target: 'pay',
      method: 'POST',
      path: '/deposits',
      headers: bearer(account.accessToken),
      body: provision,
      timeoutMs: 30_000,
    })

    if (first.status === 502) {
      // Pay cannot invent an address; it asks forge-keyvault for one. A 502 is custody being
      // unavailable, which is a different service with a different owner, and recording it as
      // Pay's behaviour would send the wrong person to the wrong dashboard.
      ctx.note('custody could not issue an address (Pay answered 502), so the find-or-create pair was not recorded')
      return
    }

    await ctx.call('provisioning again returns the same address', {
      target: 'pay',
      method: 'POST',
      path: '/deposits',
      headers: bearer(account.accessToken),
      body: provision,
      timeoutMs: 30_000,
    })

    await ctx.call('the address is listed', {
      target: 'pay',
      path: '/deposits',
      headers: bearer(account.accessToken),
    })

    await ctx.call('an unsupported coin is refused', {
      target: 'pay',
      method: 'POST',
      path: '/deposits',
      headers: bearer(account.accessToken),
      body: { coin: 'NOTACOIN', network: 'testnet' },
    })

    await ctx.call('the withdrawal queue reads back empty', {
      target: 'pay',
      path: '/withdrawals',
      headers: bearer(account.accessToken),
    })
  },
})

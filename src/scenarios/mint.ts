/**
 * ForgeMint's read surface.
 *
 * `/chains` is the one that matters most and is the reason this scenario exists at all: it is the
 * registry a creator picks a network from, and its confirmation depths and chain ids are the same
 * facts custody binds a signature to. `contracts-chain` is exact-pinned across the estate for
 * precisely this reason — wallet, settlement, custody and indexer disagreeing about a chain is how
 * a deposit credits at the wrong depth.
 *
 * Nothing here deploys a contract. `POST /tokens` creates an order that later spends Shards and
 * puts a real contract on a real network, so it is out of scope for a recorder running against a
 * live estate; the deployment lifecycle belongs to a Beacon journey with a funded testnet account
 * and a cleanup path, which is where it already is.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'mint',
  title: 'The chain registry, the offer tiers and the account capabilities read back',
  description:
    'A difference here means a creator is shown the wrong networks, the wrong prices, or is told they can deploy on a ' +
    'chain the signer will refuse to bind to.',
  targets: ['mint', 'nimbus'],
  async run(ctx) {
    await ctx.call('read the chain registry', { target: 'mint', path: '/chains' })
    await ctx.call('read the offer tiers', { target: 'mint', path: '/offers' })

    await ctx.call('capabilities without a token are refused', { target: 'mint', path: '/capabilities' })

    const account = await sharedThrowaway(ctx)

    await ctx.call('read the account capabilities', {
      target: 'mint',
      path: '/capabilities',
      headers: bearer(account.accessToken),
    })

    await ctx.call('a new account has no token orders', {
      target: 'mint',
      path: '/tokens',
      headers: bearer(account.accessToken),
    })
  },
})

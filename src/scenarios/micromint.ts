/**
 * ForgeMint's read surface, on micro-mint.
 *
 * The successor to `mint`. That suite reads `/chains`, `/offers` and `/capabilities`; micro-mint
 * has none of them and serves `/v1/catalogue` and `/v1/tokens` instead
 * (`mint/src/server.ts:354-441`).
 *
 * `/v1/catalogue` is the direct heir of `/offers` **and** of the part of `/chains` that mattered.
 * It is derived in the handler rather than read from a table — the three variants are a literal
 * tuple and `variantFor` resolves each one's contract, features and cap
 * (`mint/src/server.ts:354-370`) — so what is recorded is code, not estate state, with exactly two
 * values coming from this deployment's configuration: `priceShards` and `network`. Both are
 * contract in the strongest sense the legacy suite meant: a creator is quoted that price and
 * deploys on that network, and custody binds a signature to the same chain.
 *
 * **Nothing here deploys a contract or opens an order.** `POST /v1/tokens` creates an order that
 * later spends Shards and puts a real contract on a real network; the deployment lifecycle belongs
 * to a Beacon journey with a funded testnet account and a cleanup path, which is where it already
 * is. `GET /v1/tokens` is recorded because reading an empty order list is free and because the
 * anonymous refusal above it is the auth boundary of the whole write surface.
 *
 * Reached at `create.<apex>/v1`, never at the root: the root of that host is the SPA shell, and
 * `GET /tokens` there answers 200 `text/html`. That is why the legacy `mint` target is unmapped
 * rather than repointed — see `env.ts`.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'micro-mint',
  title: 'The token catalogue reads back, and a new account has no orders',
  description:
    'A difference here means a creator is shown the wrong variants, the wrong price or the wrong network — or is told they ' +
    'can deploy something the signer will refuse to bind to.',
  targets: ['micro-mint', 'nimbus'],
  async run(ctx) {
    await ctx.call('read the token catalogue', { target: 'micro-mint', path: '/v1/catalogue' })

    await ctx.call('an order list without a token is refused', { target: 'micro-mint', path: '/v1/tokens' })

    const account = await sharedThrowaway(ctx)

    await ctx.call('a new account has no token orders', {
      target: 'micro-mint',
      path: '/v1/tokens',
      headers: bearer(account.accessToken),
    })
  },
})

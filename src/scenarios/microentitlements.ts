/**
 * The storefront and what an account owns, on micro-billing.
 *
 * The successor to `entitlements`. That suite reads forge-pay's `/cosmetics`, `/convenience`,
 * `/season-pass` and `/private-worlds` — four catalogues that were **four frozen arrays in a
 * shared package** with a hand-written buy route each, which `billing/src/catalogue.ts`
 * names as the thing it replaces. Here a product is a row and a price is a row, so all four
 * catalogues are one route: `GET /products`.
 *
 * That makes this suite the direct heir of the legacy one's most load-bearing property.
 * [06-ecosystem-workflow.md](../../../../docs/ecosystem/06-ecosystem-workflow.md) P1 item 6
 * withdraws four convenience items, three cosmetic kinds and two ForgeMint features **from the
 * API**, and "no SKU without a delivery path" is checked against exactly this response. An array
 * shrinking here is breaking by the comparator's general rule while being an intended withdrawal,
 * and the tool is right to say so — a withdrawn SKU is a contract removal, and a gate that cannot
 * be told about an intentional one is a gate that has to be argued with.
 *
 * **The catalogue is a migration, not an operator's fixture.** `billing/src/migrations.ts`
 * `seed_catalogue` inserts these products and prices, so what is recorded here is configuration
 * that ships with the service rather than rows somebody's verification script left behind. That
 * distinction decided what this suite records and what `micro-worlds` does not — see its header.
 *
 * Read-only throughout: `POST /purchases` exists on this service and spends, and nothing here
 * touches it.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'micro-entitlements',
  title: 'The catalogue lists its products and prices, and an account lists what it owns',
  description:
    'A difference here means the shop renders empty or at the wrong price, or nothing a user has already bought can be ' +
    'proven — the game stops honouring cosmetics and the subscription.',
  targets: ['micro-billing', 'nimbus'],
  async run(ctx) {
    // Public and unauthenticated by design: a signed-out visitor reading the product page deserves
    // the same answer as a signed-in one, and nothing in it is derived from a caller.
    await ctx.call('read the product catalogue', { target: 'micro-billing', path: '/products' })

    await ctx.call('an entitlement read without a token is refused', {
      target: 'micro-billing',
      path: '/entitlements',
    })

    const account = await sharedThrowaway(ctx)
    const auth = bearer(account.accessToken)

    await ctx.call('read what the account owns', { target: 'micro-billing', path: '/entitlements', headers: auth })
    await ctx.call('read the account’s subscriptions', { target: 'micro-billing', path: '/subscriptions', headers: auth })
  },
})

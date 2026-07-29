/**
 * Entitlements and the storefront.
 *
 * Read-only throughout: nothing here buys anything. The catalogues are the interesting half —
 * [06-ecosystem-workflow.md](../../../../docs/ecosystem/06-ecosystem-workflow.md) P1 item 6
 * withdraws four convenience items, three cosmetic kinds and two ForgeMint features **from the
 * API**, and the cross-phase requirement "no SKU without a delivery path" is checked against
 * exactly these responses.
 *
 * That makes an array shrinking here a **breaking** difference by the comparator's general rule
 * while being an intended one, and the tool is right to say so: a withdrawn SKU is a contract
 * removal, and P1 records it as a documented exception rather than letting it pass silently. A
 * gate that cannot be told about an intentional removal is a gate that has to be argued with, and
 * that argument is the point.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'entitlements',
  title: 'The storefront lists its goods and an account lists what it owns',
  description:
    'A difference here means the shop renders empty, or nothing a user has already bought can be proven — the game stops ' +
    'honouring cosmetics and the season pass.',
  targets: ['pay', 'nimbus'],
  async run(ctx) {
    const account = await sharedThrowaway(ctx)

    await ctx.call('read what the account owns', {
      target: 'pay',
      path: '/entitlements',
      headers: bearer(account.accessToken),
    })

    await ctx.call('read the cosmetics catalogue', { target: 'pay', path: '/cosmetics' })
    await ctx.call('read the convenience catalogue', { target: 'pay', path: '/convenience' })
    await ctx.call('read the season pass offer', { target: 'pay', path: '/season-pass' })
    await ctx.call('read the private worlds catalogue', { target: 'pay', path: '/private-worlds' })
  },
})

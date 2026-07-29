/**
 * Crucible's static catalogue.
 *
 * One route, and it is the whole scenario on purpose: `/catalog` carries every strategy, every
 * pair, every preset and the pricing block including `liveEnabled`. It is the largest single
 * static contract in the estate and the one a decomposition is most likely to lose a corner of,
 * because it is assembled from several modules and nothing today asserts the assembly.
 *
 * Backtests are not recorded. `POST /backtests` runs the engine for real, takes seconds, and its
 * numbers are the product's core claim — comparing them belongs in Crucible's own test suite,
 * where `engine/backtest.ts`, `indicators.ts`, `metrics.ts` and `strategies.ts` currently have 755
 * lines and no tests at all. Recording a backtest here would create the impression that gap is
 * covered when it is not.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'trade',
  title: 'The whole trading catalogue reads back — strategies, pairs, presets and pricing',
  description:
    'A difference here means a strategy or a pair silently disappeared from the product, or the fee and live-trading ' +
    'configuration a bot is priced against changed without anyone deciding to change it.',
  targets: ['crucible', 'nimbus'],
  async run(ctx) {
    await ctx.call('read the catalogue', { target: 'crucible', path: '/catalog' })

    const account = await sharedThrowaway(ctx)

    await ctx.call('a new account has no bots', {
      target: 'crucible',
      path: '/bots',
      headers: bearer(account.accessToken),
    })

    await ctx.call('a new account has no backtests', {
      target: 'crucible',
      path: '/backtests',
      headers: bearer(account.accessToken),
    })

    await ctx.call('a new account has nothing billed', {
      target: 'crucible',
      path: '/billing',
      headers: bearer(account.accessToken),
    })

    await ctx.call('an unauthenticated bot list is refused', { target: 'crucible', path: '/bots' })
  },
})

/**
 * The trading capability, on micro-trade.
 *
 * The successor to `trade`, which reads Crucible's `/catalog` — the single largest static contract
 * in the legacy estate and the whole of that suite. micro-trade has no `/catalog` at all. What
 * replaced it is `GET /v1/strategies` (`trade/src/server.ts`), which serves the same kind of
 * thing: the strategy list a customer picks from, each with its parameters, their bounds and
 * defaults, and — new here — a `weakness` sentence per strategy.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `GET /v1/capabilities` IS THE ONE ROUTE IN THIS SUITE WITH NO LEGACY ANCESTOR, AND IT IS THE
 * MOST IMPORTANT ONE IN IT.
 *
 * `trade/src/server.ts` says why it was added, and the defect it closes is precisely the
 * kind this harness exists to catch: `TRADE_LIVE_ENABLED` defaults to false and **nothing reported
 * it**, so a customer could configure a live bot, be charged for it, and discover only when it
 * refused to tick that live trading is switched off on this deployment. There was no way to ask.
 *
 * It is recorded here because a deployment silently losing that answer — or answering `enabled:
 * true` when the engine will still refuse — is exactly a breaking difference that no user-facing
 * page would show until somebody had paid. The refusal string is `LIVE_DISABLED` verbatim, the
 * same sentence the engine writes onto a bot it declines to tick, so the corpus holds one source
 * for it rather than a paraphrase that can drift.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Reads only. No bot is created and no backtest is run.** `POST /v1/bots` and
 * `POST /v1/backtests` both start work that costs money and outlives the run.
 *
 * Reached at `trade.<apex>/v1`, never at the root: `GET /bots` at the root answers 200
 * `text/html`, the SPA shell, which is why the legacy `crucible` target is unmapped rather than
 * repointed.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'micro-trade',
  title: 'The strategy catalogue and this deployment’s capabilities read back, with an empty bot list',
  description:
    'A difference here means a trader is offered strategies or parameter bounds that no longer exist — or is told this ' +
    'deployment supports live trading when the engine will refuse to tick, which is a charge for something undeliverable.',
  targets: ['micro-trade', 'nimbus'],
  async run(ctx) {
    await ctx.call('read the strategy catalogue', { target: 'micro-trade', path: '/v1/strategies' })
    await ctx.call('read what this deployment will let you do', { target: 'micro-trade', path: '/v1/capabilities' })

    await ctx.call('a bot list without a token is refused', { target: 'micro-trade', path: '/v1/bots' })

    const account = await sharedThrowaway(ctx)
    const auth = bearer(account.accessToken)

    await ctx.call('a new account has no bots', { target: 'micro-trade', path: '/v1/bots', headers: auth })
    await ctx.call('a new account has no backtests', { target: 'micro-trade', path: '/v1/backtests', headers: auth })
  },
})

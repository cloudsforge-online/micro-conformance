/**
 * Every service's health endpoint, and its exact current shape.
 *
 * This scenario looks trivial and is not. `/health` is what `depends_on: service_healthy` rests
 * on across the whole compose file, and in this estate **every one of them is a literal**: Nimbus
 * answers `{ok:true, service:'nimbus'}` from a closure that touches nothing, and so do pay, game,
 * forge-mint, crucible and keyvault. A service whose database has been gone for an hour returns
 * 200 from all of them.
 *
 * P2 replaces them with `/livez` and `/readyz` that actually probe. Recording the shape they have
 * *now* is what makes that replacement provable rather than assumed: the corpus says exactly which
 * keys each service returns today, so the change can be reviewed as an intentional, documented
 * difference instead of being discovered when something depending on `body.service` stops working.
 *
 * **A service being absent notes rather than skips.** Every other scenario covers one product, so
 * an absent product means nothing was observed and a skip is the honest answer. This one covers
 * nine, and discarding eight observations because the ninth was down would be throwing away the
 * evidence to preserve a tidy outcome.
 */

import type { Target } from '../env.ts'
import { defineScenario, ScenarioSkip } from '../scenario.ts'

/**
 * The health surface, in the order MAP.md §2 lists the services.
 *
 * `hearth-rest` uses `/info` because the node has no `/health` route — the compose healthcheck
 * fetches `/info` for the same reason. Recording that difference is better than pretending the
 * estate is uniform.
 */
const SURFACES: ReadonlyArray<{ readonly target: Target; readonly path: string; readonly step: string }> = [
  { target: 'nimbus', path: '/health', step: 'nimbus reports healthy' },
  { target: 'nimbus', path: '/.well-known/jwks.json', step: 'nimbus publishes a verifiable signing key' },
  { target: 'game', path: '/health', step: 'game reports healthy' },
  { target: 'pay', path: '/health', step: 'pay reports healthy' },
  { target: 'mint', path: '/health', step: 'forge-mint reports healthy' },
  { target: 'keyvault', path: '/health', step: 'custody reports healthy' },
  { target: 'crucible', path: '/health', step: 'crucible reports healthy' },
  { target: 'lantern', path: '/health', step: 'lantern reports healthy' },
  { target: 'beacon', path: '/health', step: 'beacon reports healthy' },
  { target: 'hearth-rest', path: '/info', step: 'the chain node reports its state' },
]

export default defineScenario({
  name: 'health',
  title: 'Every service answers its health route, in the shape it answers it today',
  description:
    'A difference here changes what `depends_on: service_healthy` believes. A health route that stops answering, or ' +
    'answers a different shape, either blocks a deploy or — worse — lets a broken container into the load balancer.',
  targets: [
    'nimbus',
    'game',
    'pay',
    'mint',
    'keyvault',
    'crucible',
    'lantern',
    'beacon',
    'hearth-rest',
  ],
  async run(ctx) {
    const absent: string[] = []

    for (const surface of SURFACES) {
      try {
        await ctx.call(surface.step, { target: surface.target, path: surface.path, timeoutMs: 10_000 })
      } catch (err) {
        // `ctx.call` turns a transport failure into a skip. Here that is per-service information
        // rather than a verdict on the scenario, so it is caught, named and carried into the
        // manifest — and a service that answered against the baseline and is absent now shows up
        // as a missing interaction, which the comparator classifies as breaking.
        if (!(err instanceof ScenarioSkip)) throw err
        absent.push(`${surface.target}${surface.path}`)
      }
    }

    if (absent.length === SURFACES.length) {
      ctx.skip('no service answered — the estate is not running at this base')
    }
    if (absent.length) {
      ctx.note(`did not answer: ${absent.join(', ')}`)
    }
  },
})

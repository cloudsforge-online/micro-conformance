/**
 * The scenario catalogue, in recording order.
 *
 * Order is not cosmetic. `health` runs first because a corpus recorded against a half-started
 * estate should say so on its first line rather than at the end, and `identity` runs before
 * everything that needs an account. Within a run the recorder executes these one at a time — see
 * the note in `record.ts` about Nimbus's registration limit and the observer becoming the incident.
 */

import type { Scenario } from '../scenario.ts'
import health from './health.ts'
import identity from './identity.ts'
import wallet from './wallet.ts'
import entitlements from './entitlements.ts'
import mint from './mint.ts'
import trade from './trade.ts'
import game from './game.ts'
import chain from './chain.ts'

export const ALL_SCENARIOS: readonly Scenario[] = [
  health,
  identity,
  wallet,
  entitlements,
  mint,
  trade,
  game,
  chain,
]

export { health, identity, wallet, entitlements, mint, trade, game, chain }

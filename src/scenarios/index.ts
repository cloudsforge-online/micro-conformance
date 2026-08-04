/**
 * The scenario catalogue, in recording order.
 *
 * Order is not cosmetic. `health` runs first because a corpus recorded against a half-started
 * estate should say so on its first line rather than at the end, and `identity` runs before
 * everything that needs an account. Within a run the recorder executes these one at a time — see
 * the note in `record.ts` about Nimbus's registration limit and the observer becoming the incident.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO GENERATIONS OF SUITE LIVE HERE AT ONCE, AND NEITHER IS ALLOWED TO BEND THE OTHER.**
 *
 * `wallet`, `entitlements`, `mint`, `trade` and `game` characterise the LEGACY estate. Their paths
 * were deliberately not renamed when the micro estate turned out to be a redesign rather than a
 * re-hosting: the same code records both corpora, so renaming them would rewrite what the legacy
 * baseline characterises in order to make the micro one greener.
 *
 * `micro-wallet`, `micro-entitlements`, `micro-mint`, `micro-trade` and `micro-worlds`
 * characterise the same five CAPABILITIES on the estate the release gate actually gates. They are
 * separate suites rather than flags on the old ones because the surfaces have nothing in common
 * beyond the product name — different paths, different shapes, and in `micro-worlds`' case a
 * different product boundary entirely.
 *
 * Each group names only its own generation's targets, so each skips cleanly against the other's
 * base and neither run has to be told which estate it is looking at. `env.test.ts` asserts that
 * split rather than leaving it to whoever adds the next suite.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
import microWallet from './microwallet.ts'
import microEntitlements from './microentitlements.ts'
import microMint from './micromint.ts'
import microTrade from './microtrade.ts'
import microWorlds from './microworlds.ts'

export const ALL_SCENARIOS: readonly Scenario[] = [
  health,
  identity,
  wallet,
  entitlements,
  mint,
  trade,
  game,
  chain,
  microWallet,
  microEntitlements,
  microMint,
  microTrade,
  microWorlds,
]

export {
  health,
  identity,
  wallet,
  entitlements,
  mint,
  trade,
  game,
  chain,
  microWallet,
  microEntitlements,
  microMint,
  microTrade,
  microWorlds,
}

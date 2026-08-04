/**
 * The game capability, on micro-worlds.
 *
 * The successor to `game`, which reads Ninety Days After's `/worlds` and `/cosmetics`. Neither
 * exists here, and the reason is not a rename: **Ninety Days After is a TITLE under Worlds now,
 * not the product the legacy corpus recorded.** Worlds is the registry and the player surface; a
 * title is a separate service it provisions into. So `/worlds` did not become `/v1/titles` — the
 * thing `/worlds` returned is now a title's own concern, and what this suite characterises is the
 * platform above it (`worlds/src/server.ts:507-741`).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`GET /v1/players/me` FAILS OPEN, AND THAT IS THE PROPERTY MOST WORTH FREEZING HERE.**
 *
 * `worlds/src/server.ts:25-27` states it: the route runs on every app load, so a billing outage
 * must not be able to break signing in — what someone is already wearing is worlds' to answer. The
 * companion route `PUT /v1/players/me/cosmetics` fails CLOSED with a 503 for the mirror reason: an
 * unverified cosmetic is never persisted.
 *
 * A replacement that got that split backwards would pass every test that only checks happy paths
 * and would take the whole platform down with billing. Recording the open half's 200 is what makes
 * a later 503 there a breaking difference rather than a plausible-looking outage.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── ON `GET /v1/titles`, AND WHY IT IS RECORDED WHILE `POST /v1/deposits` IS NOT ──────────────
 *
 * Its contents are thin and their provenance is worth knowing: the registry holds one title,
 * `emberkin`, `status: "draft"` with no capabilities, and it is there because
 * `deploy/scripts/estate-verify.sh:790-792` registers it — an operator verification script, not a
 * product seed. `titles.ts:228` makes a title purchasable only at `beta` or `live`, so nothing can
 * currently be sold into it.
 *
 * It is recorded anyway, and the line this suite draws is between an answer that is WRONG and an
 * answer that is RIGHT about a small estate. `POST /v1/deposits` on micro-wallet is wrong — a 500
 * over an unhandled upstream refusal — and freezing it would make its repair read as a breaking
 * difference, so `micro-wallet` leaves it out. `GET /v1/titles` is right: it reports the registry
 * it has. A shrink to zero would be flagged breaking, and that is the correct alarm — a title
 * registry losing its only entry is worth a human looking, whoever put the entry there.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'micro-worlds',
  title: 'The title registry, the player profile that must never fail closed, and what a player owns',
  description:
    'A difference here means a title cannot be found to be sold into, a player’s cosmetics and achievements stop reading ' +
    'back, or signing in starts depending on billing being up — which takes the platform down with it.',
  targets: ['micro-worlds', 'nimbus'],
  async run(ctx) {
    await ctx.call('read the title registry', { target: 'micro-worlds', path: '/v1/titles' })

    await ctx.call('a player read without a token is refused', {
      target: 'micro-worlds',
      path: '/v1/players/me',
    })

    const account = await sharedThrowaway(ctx)
    const auth = bearer(account.accessToken)

    // The fail-open route. A 200 with a null profile is the correct answer for an account that has
    // never played anything; a 503 here would be the split inverted.
    await ctx.call('read the player profile, inventory and achievements', {
      target: 'micro-worlds',
      path: '/v1/players/me',
      headers: auth,
    })

    await ctx.call('read the player inventory', {
      target: 'micro-worlds',
      path: '/v1/players/me/inventory',
      headers: auth,
    })

    // Provisions are the entitlement bridge's output — what worlds raised on the strength of a
    // purchase. Empty for a throwaway account, and the route existing at all is the contract.
    await ctx.call('read the provisions raised for this account', {
      target: 'micro-worlds',
      path: '/v1/provisions',
      headers: auth,
    })
  },
})

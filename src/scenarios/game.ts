/**
 * Ninety Days After's read surface.
 *
 * Read-only, and specifically **not** `POST /worlds/:id/join`. Joining places a player on a
 * homestead tile, and `assignHomestead` has no `WHERE owner_id IS NULL` predicate — P1 item 7 —
 * so a recorder that joined worlds would be exercising a known race against live players for no
 * benefit the reads do not already give.
 *
 * The world chosen for the detail read is picked deterministically by sorted id rather than by
 * list position, because `GET /worlds` orders by state and a world changing state between two runs
 * would otherwise silently change which world the corpus describes — a diff against a different
 * object, reported as a difference in behaviour.
 */

import { defineScenario } from '../scenario.ts'
import { bearer, sharedThrowaway } from './_account.ts'

export default defineScenario({
  name: 'game',
  title: 'Worlds list, a world reads back in detail, and the cosmetic catalogue loads',
  description:
    'A difference here means the game shows no worlds to join, a world page cannot render, or purchased cosmetics stop ' +
    'being offered.',
  targets: ['game', 'nimbus'],
  async run(ctx) {
    await ctx.call('an unauthenticated worlds list is refused', { target: 'game', path: '/worlds' })

    const account = await sharedThrowaway(ctx)

    const worlds = await ctx.call('list the worlds', {
      target: 'game',
      path: '/worlds',
      headers: bearer(account.accessToken),
      timeoutMs: 25_000,
    })

    await ctx.call('read the cosmetic catalogue', {
      target: 'game',
      path: '/cosmetics',
      headers: bearer(account.accessToken),
      timeoutMs: 25_000,
    })

    const list = Array.isArray(worlds.body) ? (worlds.body as Array<{ id?: unknown }>) : []
    const ids = list
      .map((w) => w.id)
      .filter((id): id is string => typeof id === 'string')
      .sort()
    const chosen = ids[0]

    if (!chosen) {
      ctx.note('no world exists on this estate, so the world detail and roster reads were not recorded')
      return
    }

    await ctx.call('read a world in detail', {
      target: 'game',
      path: `/worlds/${chosen}`,
      headers: bearer(account.accessToken),
      timeoutMs: 25_000,
    })

    await ctx.call('a player who has not joined has no world profile', {
      target: 'game',
      path: `/worlds/${chosen}/me`,
      headers: bearer(account.accessToken),
      timeoutMs: 25_000,
    })

    await ctx.call('read the world roster', {
      target: 'game',
      path: `/worlds/${chosen}/roster`,
      headers: bearer(account.accessToken),
      timeoutMs: 25_000,
    })
  },
})

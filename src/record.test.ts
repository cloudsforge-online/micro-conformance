/**
 * The two things the recorder refuses to start without.
 *
 * Both are properties of the RUN rather than of the estate, and both used to be — or still would
 * be — invisible when wrong. `assertTlsTrust` already covers the first. This file covers the
 * second: that the secret literals the corpus writer is armed with belong to the estate whose
 * traffic is about to be recorded.
 *
 * These tests dial nothing. Every case asserts that `record` throws BEFORE the first request, and
 * the base used is `micro`, whose targets are all https or loopback — a case that reached the
 * network would hang or connect, not throw.
 *
 * No real secret value appears here. Fixtures are strings that are plainly not credentials.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { HarnessSecrets } from './env.ts'
import { record } from './record.ts'

const SAVED = process.env['NODE_EXTRA_CA_CERTS']

afterEach(() => {
  if (SAVED === undefined) delete process.env['NODE_EXTRA_CA_CERTS']
  else process.env['NODE_EXTRA_CA_CERTS'] = SAVED
})

const secretsFor = (base: string, over: Partial<HarnessSecrets> = {}): HarnessSecrets => ({
  literals: ['this-is-not-a-secret-1'],
  source: '/tmp/nowhere/tokens.env',
  payServiceToken: undefined,
  base,
  missing: [],
  ...over,
})

describe('what the recorder refuses to start without', () => {
  /**
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * THE DEFECT THIS PINS, AT THE SEAM WHERE IT ACTUALLY BIT.
   *
   * `cli.ts` called `loadSecrets()` with no argument and handed the result to `record({ base })`.
   * Nothing anywhere related the two, so a run recording the MICRO estate while holding the LEGACY
   * estate's literals was accepted, and the resulting corpus — committed to a public repository —
   * was written with the literal half of the hygiene refusal armed against the wrong estate.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  it('refuses to record one estate while holding another estate’s literals', async () => {
    process.env['NODE_EXTRA_CA_CERTS'] = '/tmp/ca.crt'
    await assert.rejects(
      record({ base: 'micro', secrets: secretsFor('local'), only: ['health'] }),
      /loaded for base 'local'/,
    )
  })

  it('refuses to record with an empty literal set, which is a refusal that cannot fire', async () => {
    process.env['NODE_EXTRA_CA_CERTS'] = '/tmp/ca.crt'
    await assert.rejects(
      record({ base: 'micro', secrets: secretsFor('micro', { literals: [], missing: ['/tmp/nowhere/tokens.env'] }), only: ['health'] }),
      /\/tmp\/nowhere\/tokens\.env/,
    )
  })

  it('still refuses an unverifiable https base first, because that check is older and cheaper', async () => {
    delete process.env['NODE_EXTRA_CA_CERTS']
    await assert.rejects(
      record({ base: 'micro', secrets: secretsFor('micro'), only: ['health'] }),
      /NODE_EXTRA_CA_CERTS is unset/,
    )
  })
})

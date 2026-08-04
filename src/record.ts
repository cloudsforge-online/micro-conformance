/**
 * The recorder.
 *
 * Drives every scenario against a running estate and produces a corpus: one redacted, normalised
 * golden file per interaction, plus a manifest that says what ran, what skipped, and why.
 *
 * **Scenarios run one at a time, never concurrently.** Nimbus rate-limits registration to five per
 * minute and login to ten per minute, counted per IP, and the whole harness shares one source
 * address — twelve scenarios firing at once would trip those limits and record a corpus of 429s as
 * though that were the estate's behaviour. Beacon's scheduler serialises for the same reason and
 * the note in `journeys/_identity.js` explains the failure at length: the observer becoming the
 * incident.
 *
 * The same function backs `compare`, with the writer swapped for an in-memory collector. That is
 * deliberate rather than convenient: a comparison that replayed through a different code path
 * would be comparing two recorders as much as two estates.
 */

import { assertSecretLiterals, assertTlsTrust, isUnmapped, resolveBase } from './env.ts'
import type { HarnessSecrets } from './env.ts'
import { openCorpus } from './corpus.ts'
import { request } from './http.ts'
import { ruleNames } from './normalise.ts'
import { runScenario } from './scenario.ts'
import type { Scenario } from './scenario.ts'
import { sharedAccountOf } from './scenarios/_account.ts'
import { ALL_SCENARIOS } from './scenarios/index.ts'
import type { CorpusManifest, Interaction, ScenarioReport } from './types.ts'
import { FORMAT_VERSION } from './types.ts'

export interface RecordOptions {
  /** Base environment name, e.g. `local`. */
  readonly base: string
  readonly secrets: HarnessSecrets
  /** Where to write. Omit to hold the recording in memory, which is what `compare` does. */
  readonly out?: string
  /** Restrict to these scenario names. Absent means all of them. */
  readonly only?: readonly string[]
  readonly scenarios?: readonly Scenario[]
  readonly log?: (line: string) => void
}

export interface Recording {
  readonly manifest: CorpusManifest
  readonly interactions: readonly Interaction[]
}

export async function record(options: RecordOptions): Promise<Recording> {
  const base = resolveBase(options.base)
  // Before anything is dialled. A handshake this process cannot verify would skip every scenario
  // and publish eight indistinguishable unknowns — see `assertTlsTrust`.
  assertTlsTrust(base, options.base)
  // Also before anything is dialled, and asserted for `compare` as well as `record`. `compare`
  // writes no corpus, but it drives the same live traffic through the same recorder, and a run
  // that cannot say which estate its literals came from cannot say it for either command. Binding
  // the two here — the one place a base name and a secret set are both in scope — is what stops
  // the original defect from being reintroduced by a caller rather than by this file.
  assertSecretLiterals(options.secrets, options.base)
  const log = options.log ?? (() => {})
  const all = options.scenarios ?? ALL_SCENARIOS
  const selected = options.only?.length ? all.filter((s) => options.only?.includes(s.name)) : all

  if (!selected.length) {
    throw new Error(`no scenarios matched ${JSON.stringify(options.only)}. Known: ${all.map((s) => s.name).join(', ')}`)
  }

  const interactions: Interaction[] = []
  const reports: ScenarioReport[] = []
  const shared = new Map<string, unknown>()
  const writer = options.out ? openCorpus(options.out, selected.map((s) => s.name), options.secrets.literals) : null

  for (const scenario of selected) {
    const outcome = await runScenario(scenario, {
      base,
      secrets: options.secrets,
      shared,
      onInteraction: (interaction) => {
        interactions.push(interaction)
        writer?.write(interaction)
      },
    })
    reports.push(outcome.report)
    const suffix = outcome.report.reason ? ` — ${outcome.report.reason}` : ''
    log(`  ${outcome.report.outcome.padEnd(8)} ${scenario.name.padEnd(14)} ${outcome.report.interactions} interactions${suffix}`)
    for (const err of outcome.report.cleanupErrors) log(`           cleanup failed: ${err}`)
  }

  // The shared session is revoked once, after the last scenario, rather than by each scenario that
  // used it — a per-scenario logout would pull the account out from under the ones that follow.
  // Nimbus keeps refresh tokens for thirty days, and a harness recording daily and never signing
  // out would leave a year of live sessions behind it.
  const account = sharedAccountOf(shared)
  // `nimbus` unmapped means no scenario could have acquired an account in the first place, so this
  // is unreachable rather than skipped — but it is guarded anyway, because the alternative is
  // interpolating an object into a URL and POSTing a refresh token at `[object Object]/auth/logout`.
  if (account && !isUnmapped(base.nimbus)) {
    const res = await request(`${base.nimbus}/auth/logout`, {
      method: 'POST',
      body: { refreshToken: account.refreshToken },
    })
    if (res.error || res.status >= 400) {
      log(`  warning: could not revoke the shared throwaway session (${res.error ?? res.status})`)
    }
  }

  const manifest: CorpusManifest = {
    formatVersion: FORMAT_VERSION,
    base: options.base,
    recordedAt: new Date().toISOString(),
    scenarios: reports,
    totals: {
      interactions: interactions.length,
      recorded: reports.filter((r) => r.outcome === 'recorded').length,
      skipped: reports.filter((r) => r.outcome === 'skipped').length,
      failed: reports.filter((r) => r.outcome === 'failed').length,
    },
    normalisationRules: ruleNames(),
  }

  writer?.finish(manifest)
  return { manifest, interactions }
}

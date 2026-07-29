/**
 * The scenario shape, and the driver that turns one into interactions.
 *
 * Deliberately close to Beacon's `defineJourney` — a stable `name`, a `description` that states
 * what breaking looks like to a user, timed steps, reverse-order cleanup — because that harness is
 * trusted and the reason it is trusted is these properties. Three rules are copied outright from
 * [14-testing-strategy.md](../../../docs/ecosystem/14-testing-strategy.md) §8:
 *
 *   1. **A skip is not a pass, and a skip without a reason is not a skip.** Every skip carries the
 *      reason and it is reported as its own number, never folded into a total.
 *   2. **A missing credential or an absent service skips; it never fails.** A harness that goes red
 *      because an operator chose not to give it a token has produced a false incident.
 *   3. **Cleanup runs on every exit path**, in reverse order, and a failure inside it is reported
 *      separately rather than overwriting the real result.
 *
 * What is NOT copied is Beacon's assertion vocabulary. A characterisation recorder has no opinion
 * about what a response should say — that is the entire point of characterisation — so there is no
 * `assert`. A scenario states what it exercises; the corpus states what came back.
 */

import { randomUUID } from 'node:crypto'
import type { BaseUrls, HarnessSecrets, Target } from './env.ts'
import { request, timingBucket } from './http.ts'
import { normalise, normalisePath } from './normalise.ts'
import { redact, redactHeaders } from './redact.ts'
import type { Interaction, Json, ScenarioReport } from './types.ts'
import { FORMAT_VERSION } from './types.ts'

/** Thrown by `ctx.skip`. Carries the reason, which is mandatory. */
export class ScenarioSkip extends Error {
  override readonly name = 'ScenarioSkip'
}

/**
 * Request headers worth recording.
 *
 * `authorization` is kept and redacted rather than dropped, because "this route was called with a
 * bearer token" is part of the interaction: a service that starts accepting the same call without
 * one has changed its behaviour, and a corpus that never recorded the header cannot show it.
 */
const REQUEST_HEADERS = ['content-type', 'accept', 'origin', 'authorization', 'idempotency-key', 'x-service-token']

/**
 * Response headers worth recording.
 *
 * `date`, `etag`, `x-request-id` and whatever a proxy adds today are excluded by being absent from
 * this list rather than by a denylist, because the next volatile header nobody has thought of is
 * the one a denylist lets through.
 */
const RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'www-authenticate',
  'allow',
  'location',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]

export interface CallOptions {
  readonly target: Target
  readonly method?: string
  readonly path: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly timeoutMs?: number
  /**
   * Normalisation rules to switch off for this call.
   *
   * Used where a normally volatile shape is the assertion. `eth_chainId` is the example: it is a
   * hex quantity like every height, and it must read 7412.
   */
  readonly exclude?: readonly string[]
  /**
   * Set false for a call that sets the scenario up rather than characterising anything.
   *
   * Exactly one thing uses it: acquiring the run's shared throwaway account. That registration is
   * the harness getting into position, not an observation about the estate — `identity` records
   * registration properly, with its own account — and putting it in every scenario's corpus would
   * mean a change to the harness's own setup read as a change in the product.
   */
  readonly record?: boolean
  /**
   * Wait out a 429 once, honouring `retry-after`, and record only the final attempt.
   *
   * Nimbus rate-limits registration to five per minute and login to ten, per IP, and this harness
   * shares one source address with Beacon. Recording a `record` immediately followed by a
   * `compare` — the normal way the tool is used — puts several registrations into one window, and
   * without this the second run reports "identity no longer records" and blocks a release over a
   * limit the harness itself caused. That is the observer becoming the incident, in the one place
   * where it would be mistaken for a product regression.
   *
   * Only the final attempt is recorded, so waiting never changes the corpus.
   */
  readonly retryOn429?: boolean
}

export interface CallResult {
  readonly status: number
  /** The raw, un-normalised body. Scenarios need it to drive the next step; it never reaches disk. */
  readonly body: unknown
}

export interface ScenarioContext {
  /** Stable per run. Used to build throwaway identifiers that can be grepped for and pruned. */
  readonly runId: string
  readonly secrets: HarnessSecrets
  /**
   * State shared by every scenario in one recording.
   *
   * It holds exactly one thing: the run's shared throwaway account. Registering one per scenario
   * would trip Nimbus's five-per-minute registration limit — six scenarios need an account and the
   * whole harness shares one source address — and would leave six permanent rows per run in a
   * table with no delete route.
   */
  readonly shared: Map<string, unknown>
  call(step: string, options: CallOptions): Promise<CallResult>
  /** Group work under a label without issuing a request. Nesting is not supported and not needed. */
  step<T>(label: string, fn: () => Promise<T>): Promise<T>
  skip(reason: string): never
  /** Skip unless the condition holds. The reason is mandatory and ends up in the manifest. */
  require(condition: unknown, reason: string): asserts condition
  /**
   * Record something the manifest should carry even though the scenario completed.
   *
   * The case this exists for is a scenario that spans several services — `health` calls all nine —
   * where one being absent must not discard the eight that answered, and must not be silent
   * either. A partial recording that says which part is missing is worth more than either
   * alternative.
   */
  note(text: string): void
  cleanup(fn: () => Promise<void>, label: string): void
}

export interface Scenario {
  /** Stable id. Used in file paths and in the report; renaming one abandons its history. */
  readonly name: string
  readonly title: string
  /** What breaking looks like to a user, not what the scenario does. */
  readonly description: string
  /** Which services it touches. Recorded so a partial estate can be understood from the manifest. */
  readonly targets: readonly Target[]
  run(ctx: ScenarioContext): Promise<void>
}

export function defineScenario(scenario: Scenario): Scenario {
  return scenario
}

export interface RunDeps {
  readonly base: BaseUrls
  readonly secrets: HarnessSecrets
  /**
   * Called with each interaction as it is produced. The recorder writes; the comparator holds in
   * memory. Throwing from here aborts the scenario, which is how the secret-hygiene refusal stops
   * a run rather than merely reporting on it afterwards.
   */
  readonly onInteraction: (interaction: Interaction) => void
  /** Carried across scenarios by the recorder. See `ScenarioContext.shared`. */
  readonly shared: Map<string, unknown>
  /** Injectable so a test of the rate-limit retry does not have to wait a real minute. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface RunOutcome {
  readonly report: ScenarioReport
  readonly interactions: readonly Interaction[]
}

export async function runScenario(scenario: Scenario, deps: RunDeps): Promise<RunOutcome> {
  const interactions: Interaction[] = []
  const cleanups: Array<{ label: string; fn: () => Promise<void> }> = []
  const cleanupErrors: string[] = []
  const notes: string[] = []
  const runId = randomUUID()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let seq = 0

  const ctx: ScenarioContext = {
    runId,
    secrets: deps.secrets,
    shared: deps.shared,
    async call(step, options) {
      const base = deps.base[options.target]
      const method = (options.method ?? 'GET').toUpperCase()
      const send = () =>
        request(`${base}${options.path}`, {
          method,
          ...(options.headers ? { headers: options.headers } : {}),
          ...(options.body === undefined ? {} : { body: options.body }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })

      let res = await send()
      if (res.status === 429 && options.retryOn429) {
        const advised = Number(res.headers.get('retry-after'))
        // Capped, because an upstream is free to advise an hour and a recorder that obeys it has
        // stopped being a recorder. Uncapped waiting also hides a genuinely wedged limiter.
        const waitMs = Math.min(Number.isFinite(advised) && advised > 0 ? advised * 1_000 : 30_000, 75_000)
        await sleep(waitMs + 1_000)
        res = await send()
      }

      // A transport failure is an absent service, and rule 2 says that skips. The reason names the
      // target and the URL so the manifest explains itself without anyone reading this file.
      if (res.error) {
        throw new ScenarioSkip(`${options.target} did not answer ${method} ${options.path} (${base}): ${res.error}`)
      }

      if (options.record === false) return { status: res.status, body: res.body }

      const excludeOpt = options.exclude ? { exclude: options.exclude } : {}
      const interaction: Interaction = {
        formatVersion: FORMAT_VERSION,
        scenario: scenario.name,
        step,
        seq: seq++,
        target: options.target,
        request: {
          method,
          path: normalisePath(options.path, excludeOpt),
          headers: redactHeaders(Object.entries(options.headers ?? {}), REQUEST_HEADERS),
          body: toJson(normalise(redact(options.body ?? null), excludeOpt)),
        },
        response: {
          status: res.status,
          headers: redactHeaders(res.headers, RESPONSE_HEADERS),
          body: toJson(normalise(redact(res.body), excludeOpt)),
        },
        timing: timingBucket(res.durationMs),
      }

      deps.onInteraction(interaction)
      interactions.push(interaction)
      return { status: res.status, body: res.body }
    },
    step(_label, fn) {
      return fn()
    },
    skip(reason) {
      throw new ScenarioSkip(reason)
    },
    require(condition, reason) {
      if (!condition) throw new ScenarioSkip(reason)
    },
    note(text) {
      notes.push(text)
    },
    cleanup(fn, label) {
      cleanups.push({ label, fn })
    },
  }

  let outcome: ScenarioReport['outcome'] = 'recorded'
  let reason: string | undefined

  try {
    await scenario.run(ctx)
  } catch (err) {
    if (err instanceof ScenarioSkip) {
      outcome = 'skipped'
      reason = err.message
    } else {
      outcome = 'failed'
      reason = err instanceof Error ? err.message : String(err)
    }
  } finally {
    // Reverse order, every exit path. A cleanup that unwinds a credit registered after the credit
    // must run before the sign-out registered before it.
    for (const { label, fn } of [...cleanups].reverse()) {
      try {
        await fn()
      } catch (err) {
        cleanupErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Notes join the reason rather than replacing it: a scenario can both skip and have recorded a
  // partial observation on the way there, and losing either half loses the explanation.
  const combined = [reason, ...notes].filter((r): r is string => Boolean(r)).join('; ')

  return {
    report: {
      name: scenario.name,
      title: scenario.title,
      outcome,
      ...(combined === '' ? {} : { reason: combined }),
      interactions: interactions.length,
      cleanupErrors,
    },
    interactions,
  }
}

/**
 * Force a normalised value into the JSON subset the corpus can hold.
 *
 * `undefined` is the trap: `JSON.stringify` drops an object key whose value is `undefined`, so a
 * response carrying one would be written as a corpus without that key, and the next comparison
 * would read it as a field removal — the harness inventing a breaking difference out of an
 * encoding detail. Converting it to `null` here keeps the key and keeps the diff honest.
 */
function toJson(value: unknown): Json {
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJson(v)
    return out
  }
  return String(value)
}

/**
 * The shapes written to and read from the corpus.
 *
 * These are the only file format this package has, so they are declared once, in one place, and
 * carry a `formatVersion`. A corpus outlives the code that recorded it — P0 records against the
 * estate as it stands and P5 replays that recording against services that do not exist yet — so
 * the reader must be able to tell "this corpus predates a change to the recorder" from "this
 * service changed".
 */

export const FORMAT_VERSION = 1 as const

/** A JSON value. The corpus is JSON; anything that is not JSON never reaches disk. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Timing is recorded as a bucket, never as a millisecond figure.
 *
 * A duration is the most volatile thing in a response and the least meaningful in a diff: two
 * recordings of identical behaviour differ in every one. Buckets keep the gross fact — "this
 * route answered in tens of milliseconds, not tens of seconds" — which is the only part of
 * timing a characterisation test can honestly assert. Real latency comparison is Grafana's job
 * against the P0 telemetry baseline, not this file's.
 */
export type TimingBucket = 'instant' | 'fast' | 'moderate' | 'slow' | 'very-slow'

export interface RecordedRequest {
  readonly method: string
  /** Path with the query string, both already normalised. Never the host: the host is the target. */
  readonly path: string
  /** Only headers that change how the response is produced. Values redacted. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: Json
}

export interface RecordedResponse {
  readonly status: number
  /** Only headers that describe the contract: content-type, cache-control, and the like. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: Json
}

export interface Interaction {
  readonly formatVersion: typeof FORMAT_VERSION
  readonly scenario: string
  /** Stable label. Renaming one abandons its history, exactly as with a Beacon step name. */
  readonly step: string
  /** Position within the scenario. Ordering is behaviour: a refresh before a login is a bug. */
  readonly seq: number
  /** Which service answered, by the harness's own name for it, not by URL. */
  readonly target: string
  readonly request: RecordedRequest
  readonly response: RecordedResponse
  readonly timing: TimingBucket
}

export type ScenarioOutcome = 'recorded' | 'skipped' | 'failed'

export interface ScenarioReport {
  readonly name: string
  readonly title: string
  readonly outcome: ScenarioOutcome
  /** Mandatory for `skipped` and `failed`. A skip without a reason is indistinguishable from a lie. */
  readonly reason?: string
  readonly interactions: number
  /** Cleanup failures are reported separately rather than overwriting the real result. */
  readonly cleanupErrors: readonly string[]
}

export interface CorpusManifest {
  readonly formatVersion: typeof FORMAT_VERSION
  /** The base environment name the corpus was recorded against, e.g. `local`. */
  readonly base: string
  /** Recorded so a corpus can be dated without git. Normalised out of interactions themselves. */
  readonly recordedAt: string
  readonly scenarios: readonly ScenarioReport[]
  readonly totals: {
    readonly interactions: number
    readonly recorded: number
    readonly skipped: number
    readonly failed: number
  }
  /** The normalisation rules in force at capture, by name, so a reader can tell what was erased. */
  readonly normalisationRules: readonly string[]
}

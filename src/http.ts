/**
 * The HTTP client the scenarios use.
 *
 * Two properties borrowed from Beacon's `http.js`, both load-bearing:
 *
 * - **A transport failure is a value, not a throw.** A harness that throws its own network errors
 *   reports them as harness faults, and the difference between "the service is down" and "the
 *   recorder is broken" is the difference between two entirely different people being paged.
 * - **Every request carries a deadline.** A recorder that hangs on one slow route produces a
 *   partial corpus and no explanation.
 */

import type { TimingBucket } from './types.ts'

export interface HttpResult {
  readonly status: number
  readonly headers: Headers
  readonly body: unknown
  readonly text: string
  /** Non-null when the request never completed. `status` is 0 in that case. */
  readonly error: string | null
  readonly durationMs: number
}

export interface HttpRequest {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly timeoutMs?: number
}

const EMPTY_HEADERS = new Headers()

export async function request(url: string, options: HttpRequest = {}): Promise<HttpResult> {
  const method = options.method ?? 'GET'
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()

  try {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
    let payload: string | undefined
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body)
      headers['content-type'] ??= 'application/json'
    }

    const res = await fetch(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: controller.signal,
      redirect: 'manual',
    })
    const text = await res.text()
    return {
      status: res.status,
      headers: res.headers,
      body: parseBody(text, res.headers.get('content-type')),
      text,
      error: null,
      durationMs: performance.now() - started,
    }
  } catch (err) {
    return {
      status: 0,
      headers: EMPTY_HEADERS,
      body: null,
      text: '',
      error: controller.signal.aborted ? `timed out after ${timeoutMs}ms` : messageOf(err),
      durationMs: performance.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null
  if (contentType && !/json/i.test(contentType)) return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    // A body that claims to be JSON and is not is itself the finding — an nginx error page where
    // an API response belongs. Keeping the text preserves it; parsing it away would not.
    return text
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message
  return String(err)
}

/**
 * Buckets, wide and few.
 *
 * The boundaries are order-of-magnitude rather than percentile because the question a
 * characterisation diff can honestly answer about timing is "did this route change class" — a read
 * that used to answer in 20 ms now taking 4 seconds is a behavioural change; the same read taking
 * 24 ms instead of 20 ms is weather. Percentile comparison against the P0 telemetry baseline is
 * Grafana's job and needs two weeks of samples, not one.
 */
export function timingBucket(durationMs: number): TimingBucket {
  if (durationMs < 50) return 'instant'
  if (durationMs < 250) return 'fast'
  if (durationMs < 1_000) return 'moderate'
  if (durationMs < 5_000) return 'slow'
  return 'very-slow'
}

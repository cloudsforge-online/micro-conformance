/**
 * Where the estate is, and what the harness is allowed to know about it.
 *
 * A base environment is a named map from a service to a base URL. Naming them, rather than passing
 * URLs on the command line, is what makes `record --base local` and `compare --base micro`
 * comparable: the corpus is keyed on the harness's name for a service, so a `micro-*` replacement
 * on a different port is still "wallet" and still compares against what "wallet" used to do.
 *
 * Custody (4005) and Pay (4003) are bound to loopback deliberately — see MAP.md §2. They are
 * reached on `127.0.0.1` and nothing here ever widens a binding: these are client URLs.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvSecrets } from './redact.ts'

export const TARGETS = [
  'nimbus',
  'game',
  'pay',
  'mint',
  'keyvault',
  'crucible',
  'lantern',
  'beacon',
  'hearth-rest',
  'hearth-rpc',
] as const

export type Target = (typeof TARGETS)[number]

export type BaseUrls = Readonly<Record<Target, string>>

/**
 * `local` is the running compose estate as MAP.md §2 describes it.
 *
 * `micro` is the parallel estate the programme is building. It starts as a copy of `local` because
 * nothing has moved yet; as services are extracted it is repointed at the gateway. Keeping it as a
 * named environment now means the first extraction changes one line here rather than inventing a
 * mechanism under time pressure.
 */
const BASES: Readonly<Record<string, BaseUrls>> = {
  local: {
    nimbus: 'http://127.0.0.1:4001',
    game: 'http://127.0.0.1:4002',
    pay: 'http://127.0.0.1:4003',
    mint: 'http://127.0.0.1:4004',
    keyvault: 'http://127.0.0.1:4005',
    crucible: 'http://127.0.0.1:4006',
    lantern: 'http://127.0.0.1:4010',
    beacon: 'http://127.0.0.1:4011',
    'hearth-rest': 'http://127.0.0.1:8645',
    'hearth-rpc': 'http://127.0.0.1:8545',
  },
  micro: {
    nimbus: 'http://127.0.0.1:4001',
    game: 'http://127.0.0.1:4002',
    pay: 'http://127.0.0.1:4003',
    mint: 'http://127.0.0.1:4004',
    keyvault: 'http://127.0.0.1:4005',
    crucible: 'http://127.0.0.1:4006',
    lantern: 'http://127.0.0.1:4010',
    beacon: 'http://127.0.0.1:4011',
    'hearth-rest': 'http://127.0.0.1:8645',
    'hearth-rpc': 'http://127.0.0.1:8545',
  },
}

export function baseNames(): string[] {
  return Object.keys(BASES)
}

/**
 * Resolve a base environment, letting any single target be overridden from the environment.
 *
 * `CONFORMANCE_URL_PAY=http://gateway.internal/pay` repoints one service without editing this
 * file, which is how a partially migrated estate is compared: nine services where they were, one
 * behind the gateway.
 */
export function resolveBase(name: string): BaseUrls {
  const preset = BASES[name]
  if (!preset) {
    throw new Error(`unknown base environment '${name}'. Known: ${baseNames().join(', ')}`)
  }
  const out: Record<string, string> = { ...preset }
  for (const target of TARGETS) {
    const override = process.env[`CONFORMANCE_URL_${target.toUpperCase().replace(/-/g, '_')}`]
    if (override) out[target] = override.replace(/\/$/, '')
  }
  return out as BaseUrls
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Find the `stack` checkout by walking up until a directory holds both `docker-compose.yml` and
 * `.env.example`.
 *
 * Counting directory levels would be shorter and is wrong here. `micro/` is a symlink on this
 * machine, so `import.meta.url` resolves through it and a fixed `../../..` lands somewhere else
 * entirely — which would make the secret-hygiene refusal silently fall back to its pattern half
 * while reporting that it had loaded the estate's literals. A check that degrades quietly is worse
 * than one that is absent.
 */
function findStackRoot(from: string): string | null {
  const isRoot = (dir: string): boolean =>
    existsSync(join(dir, 'docker-compose.yml')) && existsSync(join(dir, '.env.example'))

  let dir = from
  for (let i = 0; i < 8; i++) {
    if (isRoot(dir)) return dir
    // `micro/` is a symlink to a sibling checkout on this machine, so walking up from the resolved
    // path leaves the stack tree entirely and no ancestor is ever the root. Checking for a `stack`
    // child at each level rejoins it.
    if (isRoot(join(dir, 'stack'))) return join(dir, 'stack')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export const STACK_ROOT = process.env['CONFORMANCE_STACK_ROOT'] ?? findStackRoot(HERE) ?? resolve(HERE, '..', '..', '..')

export interface HarnessSecrets {
  /** Literal secret values the recorder refuses to write. Never logged, never returned by name. */
  readonly literals: readonly string[]
  /** Where they came from, for the run summary. The path, never the contents. */
  readonly source: string
  /** Pay's internal service token, if the estate's .env carries one. */
  readonly payServiceToken: string | undefined
}

/**
 * Load the running estate's own secrets, purely so the recorder can refuse to write one.
 *
 * This is the only place the harness touches `.env`, and the values leave it in exactly two
 * shapes: an opaque list used by `findSecretLeak`, and the one token a scenario legitimately
 * presents as a credential. Neither is ever printed.
 *
 * An absent file is a supported mode. The refusal degrades to its pattern half and the run says
 * so, because a CI runner that has the services but not the operator's file must still be able to
 * record.
 */
export function loadSecrets(envPath = resolve(STACK_ROOT, '.env')): HarnessSecrets {
  let contents: string
  try {
    contents = readFileSync(envPath, 'utf8')
  } catch {
    return { literals: [], source: `${envPath} (absent — pattern-only hygiene)`, payServiceToken: undefined }
  }
  const literals = parseEnvSecrets(contents)
  const payLine = contents.split(/\r?\n/).find((l) => l.trim().startsWith('PAY_SERVICE_TOKEN='))
  const payServiceToken = payLine ? payLine.slice(payLine.indexOf('=') + 1).trim() || undefined : undefined
  return { literals, source: envPath, payServiceToken }
}

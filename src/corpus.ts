/**
 * Reading and writing the corpus.
 *
 * One file per interaction rather than one file per scenario, for a reason that only shows up
 * months later: a golden corpus is reviewed in pull requests, and a diff on a 400-line scenario
 * blob tells a reviewer nothing, while a diff that says `corpus/wallet/003-POST-deposits.json:
 * status 201 → 500` tells them everything. The file name is the interaction, so `git log` on a
 * path is the history of one route.
 *
 * The write is where the secret-hygiene refusal lives. Everything upstream of it — the redactor,
 * the normaliser — is a list of things somebody thought of; this is the check that does not depend
 * on having thought of it.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSecretLeak } from './redact.ts'
import type { CorpusManifest, Interaction } from './types.ts'
import { FORMAT_VERSION } from './types.ts'

export const MANIFEST_FILE = 'manifest.json'

const slugify = (text: string): string =>
  text
    .replace(/\?.*$/, '')
    .replace(/[<>]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)

/**
 * `POST /coins/convert-to-ember` becomes `007-POST-coins-convert-to-ember.json`.
 *
 * Where the path carries no information the step label is used instead. JSON-RPC is the case that
 * forces this: every call in the chain scenario is `POST /`, so a path-derived name would produce
 * five files called `POST-root` and a reviewer reading a diff would have to open each one to find
 * out whether the chain id or the block height had changed.
 */
export function interactionFileName(interaction: Interaction): string {
  const fromPath = slugify(interaction.request.path)
  const slug = fromPath || slugify(interaction.step) || 'root'
  return `${String(interaction.seq).padStart(3, '0')}-${interaction.request.method}-${slug}.json`
}

export class SecretLeakError extends Error {
  override readonly name = 'SecretLeakError'
}

/**
 * Serialise an interaction and refuse to produce the text if it carries a secret.
 *
 * Separated from the write so it can be tested without a filesystem, which matters: the test that
 * proves a token never reaches disk must not need a disk.
 */
export function serialiseInteraction(interaction: Interaction, literals: readonly string[]): string {
  const text = `${JSON.stringify(interaction, null, 2)}\n`
  const leak = findSecretLeak(text, literals)
  if (leak) {
    throw new SecretLeakError(
      `refusing to write ${interaction.scenario}/${interaction.step}: matched the '${leak.pattern}' ` +
        `hygiene pattern at ${leak.where}. The recording is abandoned rather than redacted after the fact.`,
    )
  }
  return text
}

export interface CorpusWriter {
  write(interaction: Interaction): void
  finish(manifest: CorpusManifest): void
}

/**
 * Open a corpus directory for writing, clearing any previous recording of the same scenarios.
 *
 * Clearing matters: a scenario that recorded six interactions yesterday and five today would
 * otherwise leave the sixth behind, and the next comparison would replay a file describing a route
 * that no longer exists — a stale fixture reported as a missing interaction, which is a false
 * breaking difference and the fastest way to lose trust in a gate.
 */
export function openCorpus(dir: string, scenarios: readonly string[], literals: readonly string[]): CorpusWriter {
  const root = resolve(dir)
  mkdirSync(root, { recursive: true })
  for (const scenario of scenarios) {
    rmSync(join(root, scenario), { recursive: true, force: true })
  }

  return {
    write(interaction) {
      const scenarioDir = join(root, interaction.scenario)
      mkdirSync(scenarioDir, { recursive: true })
      writeFileSync(join(scenarioDir, interactionFileName(interaction)), serialiseInteraction(interaction, literals))
    },
    finish(manifest) {
      writeFileSync(join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
    },
  }
}

export interface LoadedCorpus {
  readonly manifest: CorpusManifest
  readonly interactions: readonly Interaction[]
}

export function loadCorpus(dir: string): LoadedCorpus {
  const root = resolve(dir)
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8')) as CorpusManifest
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `corpus at ${root} is format version ${manifest.formatVersion}; this harness reads ${FORMAT_VERSION}. ` +
        're-record rather than reinterpreting it — a corpus read under the wrong format is a comparison against nothing.',
    )
  }

  const interactions: Interaction[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of readdirSync(join(root, entry.name))) {
      if (!file.endsWith('.json')) continue
      interactions.push(JSON.parse(readFileSync(join(root, entry.name, file), 'utf8')) as Interaction)
    }
  }
  interactions.sort((a, b) => (a.scenario === b.scenario ? a.seq - b.seq : a.scenario < b.scenario ? -1 : 1))
  return { manifest, interactions }
}

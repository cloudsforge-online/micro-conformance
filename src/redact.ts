/**
 * Redaction, at capture.
 *
 * [14-testing-strategy.md](../../../docs/ecosystem/14-testing-strategy.md) §7 states the rule and
 * the reason in one sentence: "redacted at capture, never after. A redaction pass over stored
 * fixtures is a pass that can be forgotten; a refusal at capture cannot." So this module does two
 * separate jobs and neither is a substitute for the other.
 *
 * 1. `redact()` replaces credential-shaped values with a placeholder as the interaction is built.
 * 2. `findSecretLeak()` is the refusal — a scan of the serialised fixture immediately before it is
 *    written, over the same hygiene patterns CI already asserts, plus the literal values of the
 *    running estate's own secrets. A fixture that trips it is not written and the run fails.
 *
 * The second exists because the first is a list of key names and value shapes, and a list is
 * always one field short. The refusal is what makes "no secret reached disk" a fact rather than a
 * hope.
 *
 * What this module deliberately does NOT redact:
 *
 * - **Error codes.** `code: 'unauthorized'` is the single most valuable field in the corpus —
 *   a changed error code is a breaking difference — and a key pattern loose enough to catch
 *   `cf_code` would take it with it.
 * - **Chain addresses.** They are non-deterministic rather than secret, so `normalise.ts` turns
 *   them into type-carrying placeholders instead. The raw address still never reaches disk, and
 *   the corpus keeps the fact that the field held an EVM address rather than a Solana one.
 */

export const REDACTED = '<redacted>'

/**
 * Key names whose value is a credential regardless of what it looks like.
 *
 * Written as precise alternatives rather than a loose `/key|token|secret/i`, because the estate
 * has fields like `keyvaultChain: 'ember'` and `publicKey` that a loose pattern erases — and a
 * corpus that has erased the chain registry proves nothing about the chain registry.
 */
const SENSITIVE_KEY = new RegExp(
  [
    // Exact names.
    '^(password|passwd|passphrase|secret|token|authorization|cookie|credential|credentials',
    '|mnemonic|seed|seedphrase|wif|dsn|privkey|signature|sig|salt|nonce_secret)$',
    // Qualified names: an access token, a service token, a master secret, a private key.
    '|^(access|refresh|id|api|service|master|signing|session|bearer|client|webhook|encryption)',
    '[-_]?(token|key|secret)s?$',
    // Suffixed names: anything ending in a credential noun.
    '|(password|passphrase|privatekey|secretkey|apikey|mastersecret|servicetoken|refreshtoken',
    '|accesstoken|idtoken|connectionstring|databaseurl)$',
  ].join(''),
  'i',
)

/** Request and response headers whose value is a credential. */
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-service-token|x-api-key|x-lantern-token|x-auth-token)$/i

/**
 * Value shapes that are a credential wherever they appear, whatever the key is called.
 *
 * Each is anchored tightly enough not to fire on the estate's legitimate content: the JWT pattern
 * requires three base64url segments, the DSN pattern requires a password in the authority, and the
 * bare-hex pattern excludes `0x`-prefixed values so that block hashes and state roots — which the
 * chain scenario exists to record — survive.
 */
const SECRET_VALUE: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'pem-block', re: /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/ },
  { name: 'dsn-with-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@[^\s/]+/i },
  { name: 'bitcoin-wif', re: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/ },
  { name: 'xrp-family-seed', re: /\bs[1-9A-HJ-NP-Za-km-z]{28}\b/ },
  { name: 'bip39-phrase', re: /\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/ },
  // A bare 64-hex run is a raw secp256k1 or ed25519 private key. `0x`-prefixed values are chain
  // hashes and are excluded by the lookbehind, which is why this can be strict.
  { name: 'raw-private-key', re: /(?<!0[xX])\b[0-9a-fA-F]{64}\b/ },
  // The portal handoff code. It is a working key to an account for sixty seconds and it arrives
  // inside a URL fragment, where no key name exists to match on.
  //
  // The negative lookahead is load-bearing rather than tidy: without it the pattern matches the
  // redactor's own output — `cf_code=<redacted>` contains no `&`, whitespace or quote — and the
  // refusal fires on the very redaction that made the fixture safe. A hygiene check that refuses
  // its own successful output is a check that gets switched off within a day.
  { name: 'handoff-code', re: /cf_code=(?!<redacted>)[^&\s"']+/ },
]

/** Replace the value of `cf_code` in a URL rather than discarding the whole URL, which is contract. */
const HANDOFF_CODE_IN_URL = /(cf_code=)[^&\s"']+/g

type Unknown = unknown

/**
 * Walk a value, replacing credentials with `REDACTED`.
 *
 * Structure is preserved: a redacted field is still present, still a string, and still compares.
 * Removing it instead would make every recording look like a field removal, which is the one
 * classification the comparator must never produce by accident.
 */
export function redact(value: Unknown, key = ''): Unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED

  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, key))
  if (value && typeof value === 'object') {
    const out: Record<string, Unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, Unknown>)) out[k] = redact(v, k)
    return out
  }
  return value
}

export function redactString(text: string): string {
  // The handoff code is rewritten in place so the redirect URL keeps its shape — the scenario
  // asserts that a redirect URL is returned and that it carries the fragment, and both facts
  // survive the redaction while the code itself does not.
  let out = text.replace(HANDOFF_CODE_IN_URL, `$1${REDACTED}`)
  for (const { name, re } of SECRET_VALUE) {
    // Already handled in place above, and handling it again would replace the whole `cf_code=…`
    // token including the parameter name, which is part of the contract.
    if (name === 'handoff-code') continue
    out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), REDACTED)
  }
  return out
}

/**
 * Reduce headers to the ones that describe the contract, with credentials replaced.
 *
 * An allowlist rather than a denylist. Response headers carry `date`, `etag`, request ids and
 * whatever a proxy decided to add today; recording all of them would make every diff noise, and
 * denying the ones we happen to know about would let the next one through.
 */
export function redactHeaders(
  headers: Iterable<readonly [string, string]>,
  keep: readonly string[],
): Record<string, string> {
  const wanted = new Set(keep.map((h) => h.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase()
    if (!wanted.has(name)) continue
    out[name] = SENSITIVE_HEADER.test(name) ? REDACTED : redactString(rawValue)
  }
  return out
}

export interface SecretLeak {
  readonly pattern: string
  /** A short, non-revealing description of where it was found. Never the value itself. */
  readonly where: string
}

/**
 * Scan serialised text for anything that must not be written.
 *
 * `literals` are the running estate's own secret values, read from its `.env`. They are the
 * strongest half of the check by a distance: a pattern describes the shape of a secret, but a
 * literal *is* one, and a token that matches no pattern still fails this.
 *
 * The return value never contains the offending text. A harness that prints the secret it caught
 * has moved the leak from a file into a CI log, which is worse — CI logs are retained, indexed
 * and readable by more people than the fixture would have been.
 */
export function findSecretLeak(text: string, literals: readonly string[] = []): SecretLeak | null {
  for (const literal of literals) {
    // Below eight characters a "secret" is a value like `true` or a log level, and matching on it
    // would refuse every fixture forever.
    if (literal.length < 8) continue
    if (text.includes(literal)) {
      return { pattern: 'estate-secret-literal', where: `a value from the estate's .env, ${literal.length} characters` }
    }
  }
  for (const { name, re } of SECRET_VALUE) {
    const match = re.exec(text)
    if (match) {
      return { pattern: name, where: `offset ${match.index}, ${match[0].length} characters` }
    }
  }
  return null
}

/**
 * Read secret literals out of an env file without importing a dependency and without ever
 * returning the names alongside the values in a loggable shape.
 *
 * Absent file is not an error: the refusal degrades to the pattern half, and `record` says so.
 * Refusing to run without `.env` would make the harness unusable in exactly the environment it is
 * most needed — a CI runner that has the services but not the operator's file.
 */
export function parseEnvSecrets(contents: string): string[] {
  const out: string[] = []
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value.length >= 8) out.push(value)
  }
  return out
}

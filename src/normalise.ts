/**
 * Normalisation.
 *
 * A characterisation corpus is only worth having if two recordings of the same behaviour compare
 * equal. Everything that varies between two identical runs — ids, timestamps, tokens, generated
 * addresses, block heights, market prices, process counters — has to become a stable placeholder
 * at capture, or every diff is noise and the tool gets ignored, which is the failure mode that
 * ends characterisation testing everywhere it has been tried.
 *
 * This is the part most likely to be wrong, so the rules are data rather than code: each carries a
 * name, the reason it exists, and a predicate over `(value, key)`. They are listed in the corpus
 * manifest by name, so a reader six months from now can see what was erased without reading this
 * file, and `normalise.test.ts` drives them directly.
 *
 * **Placeholders carry their source type.** `<number>` is only ever produced from a number and
 * `<uuid>` only ever from a string. That is what lets the comparator keep detecting a type change
 * through a normalised field: if a field that was a number starts arriving as a string, the number
 * rule does not fire on the new estate, and the comparator sees `<number>` against `"0.3"` — a
 * placeholder expecting a number, holding a string. Loosen a rule to accept both types and that
 * detection is gone.
 */

/** What a placeholder was made from. The comparator reads this to keep type changes visible. */
export const PLACEHOLDER_TYPES: Readonly<Record<string, 'string' | 'number' | 'boolean'>> = {
  '<redacted>': 'string',
  '<uuid>': 'string',
  '<request-id>': 'string',
  '<jwt>': 'string',
  '<timestamp>': 'string',
  '<email>': 'string',
  '<handle>': 'string',
  '<evm-address>': 'string',
  '<hash>': 'string',
  '<hex-quantity>': 'string',
  '<bech32-address>': 'string',
  '<base58-address>': 'string',
  '<xrp-address>': 'string',
  '<decimal-string>': 'string',
  '<url>': 'string',
  '<epoch>': 'number',
  '<number>': 'number',
}

export function isPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLACEHOLDER_TYPES, value)
}

export interface NormaliseRule {
  readonly name: string
  /** Why this varies between two runs of identical behaviour. Comments explain WHY, so does this. */
  readonly why: string
  readonly placeholder: string
  readonly matches: (value: unknown, key: string) => boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH_32 = /^0x[0-9a-fA-F]{64}$/
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,32}$/
const BECH32 = /^(ember|bc|tb|bcrt)1[02-9ac-hj-np-z]{8,}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const XRP_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DECIMAL_STRING = /^-?\d{6,}(\.\d+)?$/

/**
 * Numeric fields that are gauges rather than contract.
 *
 * A block height, a market price, a queue depth and an uptime counter all differ between two
 * recordings taken a second apart, and none of them is a behavioural claim: the claim is that the
 * field is present and is a number. Asserting the value would make the corpus fail every time the
 * chain produced a block, and a suite that fails for a reason nobody believes is a suite that gets
 * muted.
 *
 * Where the number IS the contract — the chain id, which must be 7412 on this testnet — the
 * scenario excludes the rule by name rather than the rule making an exception it cannot explain.
 */
const GAUGE_KEYS = new Set(
  [
    'height', 'blocknumber', 'blockheight', 'tipheight', 'peers', 'mempool', 'hashrate',
    'difficulty', 'totaldifficulty', 'difficultytarget', 'gasprice', 'basefee', 'gasused',
    'ageseconds', 'uptimesec', 'uptimems', 'latencyms', 'durationms', 'elapsedms', 'expiresin',
    'usd', 'shardspercoin', 'priceusd', 'rate', 'quotedatms',
    'ingested', 'written', 'dropped', 'buffered', 'pending', 'ratelimited',
    'checksrun', 'checkswritten', 'runsexecuted', 'queuedepth', 'nonce', 'timestamp', 'size',
  ].map((k) => k.toLowerCase()),
)

/**
 * String fields holding a base-unit integer or a formatted amount.
 *
 * Hearth reports supply in wei-scale strings that move with every block. The string is the estate's
 * chosen encoding for a big integer — that encoding IS contract and is preserved by the
 * placeholder's type — but its value is a gauge.
 */
const DECIMAL_STRING_KEYS = new Set(
  [
    'totalsupply', 'totalsupplyember', 'circulating', 'circulatingember', 'commonsissued',
    'commonsbalance', 'blockreward', 'burnedtotal', 'balance', 'amount', 'reward',
  ].map((k) => k.toLowerCase()),
)

export const RULES: readonly NormaliseRule[] = [
  {
    name: 'uuid',
    why: 'Every id the estate generates is a v4 UUID, and a new one is minted per run.',
    placeholder: '<uuid>',
    matches: (v) => typeof v === 'string' && UUID.test(v),
  },
  {
    name: 'jwt',
    why: 'Access and handoff tokens are signed per run and never repeat. The redactor takes most of them; this catches one arriving under a key nobody thought to name.',
    placeholder: '<jwt>',
    matches: (v) => typeof v === 'string' && JWT.test(v),
  },
  {
    name: 'iso-timestamp',
    why: 'Created-at, quoted-at and expires-at differ by the wall-clock gap between two runs.',
    placeholder: '<timestamp>',
    matches: (v) => typeof v === 'string' && ISO_TIMESTAMP.test(v),
  },
  {
    name: 'epoch-millis',
    why: 'The same fact as an ISO timestamp, encoded as a number. Bounded below 1e12 so an ordinary count is never mistaken for a clock.',
    placeholder: '<epoch>',
    matches: (v, k) => typeof v === 'number' && v >= 1e12 && /(at|time|expires|issued)$/i.test(k),
  },
  {
    name: 'email',
    why: 'Each run registers its own throwaway account, so the address is generated. Keeping it would also put a recognisable address pattern in a committed file.',
    placeholder: '<email>',
    matches: (v) => typeof v === 'string' && EMAIL.test(v),
  },
  {
    name: 'handle',
    why: 'The throwaway account picks a random handle, for the same reason as its address.',
    placeholder: '<handle>',
    matches: (v, k) => typeof v === 'string' && /^handle$/i.test(k),
  },
  {
    name: 'request-id',
    why:
      'The micro estate puts a per-request correlation id INSIDE the error envelope — ' +
      '`{error:{code,message,requestId}}` — and it is new since this corpus was written: the legacy ' +
      'estate carried the id only in the `x-request-id` HEADER, which `RESPONSE_HEADERS` already ' +
      'declines to record for exactly this reason. Without this rule every 4xx in the corpus holds a ' +
      'value that cannot ever match, so each one compares `value-changed` on every run and can never ' +
      'contribute an `identical`. That is the "quietly weaker corpus" §4 names, arrived at by the ' +
      'estate adding a field rather than by a rule being too broad. ' +
      'KEYED ON THE FIELD NAME, NEVER ON THE SHAPE: these ids are 16 characters of base36 and a ' +
      'value-shaped rule would erase real opaque identifiers — a listing id, a bot id, an order ' +
      'reference — wherever they happened to look similar.',
    placeholder: '<request-id>',
    // `typeof v === 'string'` is not redundant with the key test: the placeholder declares itself
    // string-typed below, and the module's whole type-change detection rests on a placeholder only
    // ever being produced from its declared type. A service that started returning a NUMERIC
    // requestId must stay visible as a type change, not be absorbed by the field name.
    matches: (v, k) =>
      typeof v === 'string' && /^(requestid|request_id|correlationid|correlation_id)$/i.test(k),
  },
  {
    name: 'evm-address',
    why: 'Deposit addresses are minted per user by custody, so they differ per run. The raw address never reaches disk and the placeholder keeps the family, so an EVM address turning into a Solana one is still a visible difference.',
    placeholder: '<evm-address>',
    matches: (v) => typeof v === 'string' && EVM_ADDRESS.test(v),
  },
  {
    name: 'volatile-hash-key',
    why:
      'The chain tip, a state root and the current mining target move with every block, while the genesis hash — the same 32-byte shape — identifies the chain and must never be erased. ' +
      'Keying on the field name rather than the value is what lets the chain scenario keep the genesis hash comparable while the tip beside it is normalised.',
    placeholder: '<hash>',
    matches: (v, k) =>
      typeof v === 'string' &&
      /^(tip|blockhash|parenthash|stateroot|transactionsroot|receiptsroot|mixhash|sha3uncles|difficultytarget|target|corehash)$/i.test(k),
  },
  {
    name: 'hash-32',
    why: 'Block hashes, state roots and transaction hashes change with every block.',
    placeholder: '<hash>',
    matches: (v) => typeof v === 'string' && HASH_32.test(v),
  },
  {
    name: 'bech32-address',
    why: 'Hearth and Bitcoin deposit addresses, minted per user.',
    placeholder: '<bech32-address>',
    matches: (v) => typeof v === 'string' && BECH32.test(v),
  },
  {
    name: 'xrp-address',
    why: 'XRP deposit addresses, minted per user. Checked before base58 because an XRP address is also valid base58.',
    placeholder: '<xrp-address>',
    matches: (v) => typeof v === 'string' && XRP_ADDRESS.test(v),
  },
  {
    name: 'base58-address',
    why: 'Solana and legacy Bitcoin deposit addresses, minted per user.',
    placeholder: '<base58-address>',
    matches: (v) => typeof v === 'string' && BASE58.test(v),
  },
  {
    name: 'hex-quantity',
    why: "JSON-RPC heights, balances and nonces arrive as hex quantities that move with the chain. The chain id is also a hex quantity and is NOT a gauge, so the chain scenario excludes this rule by name on that one call.",
    placeholder: '<hex-quantity>',
    matches: (v) => typeof v === 'string' && HEX_QUANTITY.test(v),
  },
  {
    name: 'gauge-number',
    why: 'Heights, prices, ages, uptimes and process counters differ between two runs of identical behaviour. The claim being characterised is that the field exists and is a number.',
    placeholder: '<number>',
    matches: (v, k) => typeof v === 'number' && GAUGE_KEYS.has(k.toLowerCase()),
  },
  {
    name: 'decimal-string',
    why: 'Base-unit amounts encoded as strings, which is how the chain reports supply and balances. The encoding is contract and survives in the placeholder type; the figure is a gauge.',
    placeholder: '<decimal-string>',
    matches: (v, k) =>
      typeof v === 'string' && (DECIMAL_STRING_KEYS.has(k.toLowerCase()) || DECIMAL_STRING.test(v)),
  },
]

export interface NormaliseOptions {
  /**
   * Rule names to switch off for this interaction.
   *
   * The escape hatch for the case where a normally volatile shape is the assertion — `eth_chainId`
   * must read 7412 on this testnet, and a corpus that normalised it away would replay green
   * against a service pointed at the wrong chain, which is the exact defect Beacon's chain probe
   * exists to catch.
   */
  readonly exclude?: readonly string[]
  readonly rules?: readonly NormaliseRule[]
}

/** Recursively replace volatile values with placeholders. Structure is never changed. */
export function normalise(value: unknown, options: NormaliseOptions = {}): unknown {
  const rules = (options.rules ?? RULES).filter((r) => !options.exclude?.includes(r.name))
  return walk(value, '', rules)
}

function walk(value: unknown, key: string, rules: readonly NormaliseRule[]): unknown {
  // A value already normalised — a redaction placeholder, or a re-normalisation — is left alone.
  // Without this, `<redacted>` would fall through to nothing and stay, but a future placeholder
  // that happened to look like an address would be rewritten twice and stop comparing.
  if (isPlaceholder(value)) return value

  for (const rule of rules) {
    if (rule.matches(value, key)) return rule.placeholder
  }

  if (Array.isArray(value)) return value.map((item) => walk(item, key, rules))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k, rules)
    return out
  }
  return value
}

/**
 * Normalise a request path and query string.
 *
 * Ids appear in paths as often as in bodies — `/worlds/:id`, `/backtests/:id` — and a corpus keyed
 * on a raw path would never match a second run. Query parameters are sorted because parameter
 * order is not contract and two clients ordering them differently is not a behavioural difference.
 */
export function normalisePath(path: string, options: NormaliseOptions = {}): string {
  const rules = (options.rules ?? RULES).filter((r) => !options.exclude?.includes(r.name))
  const [rawPath = '', rawQuery] = path.split('?', 2)

  const segments = rawPath.split('/').map((segment) => {
    if (!segment) return segment
    const decoded = safeDecode(segment)
    for (const rule of rules) {
      if (rule.matches(decoded, '')) return rule.placeholder
    }
    return segment
  })

  if (rawQuery === undefined) return segments.join('/')

  const params = [...new URLSearchParams(rawQuery).entries()]
    .map(([k, v]) => {
      for (const rule of rules) {
        if (rule.matches(v, k)) return [k, rule.placeholder] as const
      }
      return [k, v] as const
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const query = params.map(([k, v]) => `${k}=${v}`).join('&')
  return query ? `${segments.join('/')}?${query}` : segments.join('/')
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is not a reason to abandon a recording; the raw segment still compares.
    return segment
  }
}

/** The names of every rule in force, for the manifest. */
export function ruleNames(rules: readonly NormaliseRule[] = RULES): string[] {
  return rules.map((r) => r.name)
}

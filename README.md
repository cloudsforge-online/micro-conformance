# `@cloudsforge/conformance` — the characterisation harness

Phase 0's regression harness. It records what the running estate **does**, so that when a
`micro-*` service replaces one of the eighteen containers, the replacement can be **proven**
equivalent instead of assumed so.

> The owner's requirement is "validate that existing functionality didn't break". Without a
> recorded baseline that is an assertion. With one it is a comparison.

---

## 1. What the corpus is

`corpus/` holds one JSON file per HTTP interaction, grouped by scenario:

```
corpus/
  manifest.json                     what ran, what skipped, and why
  identity/000-POST-auth-register.json
  identity/001-GET-auth-me.json
  wallet/005-POST-deposits.json
  chain/000-POST-the-chain-id-is-the-testnet-chain-id.json
  …
```

Each file records the request method, path, the headers that change the answer, the request body,
the response status, the response headers that are contract, the response body, and a **timing
bucket** rather than a millisecond figure.

One file per interaction rather than one per scenario, because a golden corpus is reviewed in pull
requests: a diff that says `corpus/wallet/005-POST-deposits.json: status 201 → 500` tells a
reviewer everything, and a diff on a 400-line scenario blob tells them nothing.

Two things happen to every value before it is written, and the order matters:

1. **Redaction, at capture.** Credentials are replaced as the interaction is built, and the
   serialiser then **refuses** to produce a fixture that still matches a hygiene pattern or holds a
   literal value from the estate's own `.env`. A redaction pass over stored fixtures is a pass that
   can be forgotten; a refusal at capture cannot.
2. **Normalisation, at capture.** Ids, timestamps, JWTs, generated addresses, block heights, market
   prices and process counters become type-carrying placeholders — `<uuid>`, `<timestamp>`,
   `<evm-address>`, `<number>` — so that two recordings of the same behaviour compare equal.

The corpus contains **only throwaway-account data.** One account is registered per run, under
`conformance+…@conformance.test`, and every scenario that needs to be somebody signs in as it. No
real user, no real balance, no real address, and no money moves at any point — §5.

---

## 2. Recording against the current estate

```bash
pnpm install
pnpm typecheck && pnpm test          # 89 tests, none of which needs a running estate

node --import tsx src/cli.ts record --base local --out corpus/
```

`--base local` is the compose estate as `MAP.md` §2 describes it. Custody (4005) and Pay (4003)
are reached on `127.0.0.1` because they are **deliberately** bound to loopback; nothing here ever
widens a binding.

Any single service can be repointed without editing a base, which is how a partially migrated
estate is recorded — eight services where they were, one behind the gateway:

```bash
CONFORMANCE_URL_PAY=http://gateway.internal/pay \
  node --import tsx src/cli.ts record --base micro --out corpus/
```

`conformance report --corpus corpus/` summarises a recording without re-running anything.

### Scenarios

| Scenario | Covers |
| --- | --- |
| `health` | Every service's health route and its exact current shape, plus JWKS |
| `identity` | Register, `/auth/me`, the SSO handoff and its single-use code, rotation, **refresh-reuse detection burning the family**, password change |
| `wallet` | `GET /wallet`, `/coins/rates`, `/deposit-coins`, `/withdrawal-coins`, deposit-address provisioning and its find-or-create idempotency, the withdrawal queue |
| `entitlements` | `/entitlements` plus all four public catalogues |
| `mint` | `/chains`, `/offers`, `/capabilities`, order list |
| `trade` | The whole static `/catalog`, plus the per-account read surface |
| `game` | `/worlds`, world detail, roster, `/cosmetics` |
| `chain` | `eth_chainId`, `net_version`, `eth_blockNumber`, `eth_getBalance` on 8545; REST `/info` and `/supply` on 8645 |

---

## 3. Comparing a new service against it

```bash
node --import tsx src/cli.ts compare --corpus corpus/ --base micro
```

`compare` replays the same scenarios against the target and classifies every difference:

| Class | Means | Blocks a release? |
| --- | --- | --- |
| `identical` | The values agree, including two equal placeholders | — |
| `benign` | A new field, a longer array, a nullable field populated, a gauge that moved, a timing bucket shift | No |
| `breaking` | A removed field, a changed type, a changed status code, a changed error code, a shortened array, a populated field now null, a changed chain id or confirmation depth, **a scenario that used to record and now skips** | **Yes — exit 1** |

**The additive-versus-breaking distinction is the whole value of the tool**, and the pairs are
deliberately asymmetric: adding a field is benign and removing one is breaking; an array growing is
benign and shrinking is breaking; null becoming a value is benign and a value becoming null is
breaking. `src/compare.test.ts` is a table with one row per case, and the table is the
specification.

**Exit code 1 on any breaking difference, and only on a breaking difference.** That is what makes
this a CI gate. Exiting non-zero on benign differences would fire on every routine release, and a
gate that fires on every release gets removed.

### A worked example of the one rule everything rests on

```
GET /deposit-coins
  baseline: [{ coin: 'EMBER', confirmations: 60 }, { coin: 'BTC', … }]
  target:   [{ coin: 'EMBER', confirmations: 60, explorerTx: '…' }]

  response.body[0].explorerTx  a new field is present            [field-added]      benign
  response.body                had 2 entries, now has 1          [array-shortened]  BREAKING
```

The new field is fine — a consumer reads only what it needs. The missing coin is not: something a
caller could enumerate yesterday has gone.

---

## 4. What it cannot catch

Stated plainly, because a harness whose limits are not written down is a harness people believe
things about that are not true.

- **Anything it does not exercise.** The corpus covers the read surface and one safe write. It does
  **not** cover: money movement (`/internal/credit`, `/charge`, `/trade`, `/spend`, conversions),
  withdrawals, token deployment, backtest execution, joining a world, purchasing anything, or any
  admin route. Those move value or mutate live state, and a recorder that could move value is a
  recorder that eventually does. They belong to Beacon's journeys, which run against a stack with a
  synthetic account and a cleanup path.
- **Timing.** Buckets are order-of-magnitude and only catch a route changing class. Real latency
  comparison — p95 within 20% of the P0 baseline — is Grafana's against two weeks of telemetry, and
  needs samples this tool does not take.
- **Concurrency.** Everything here is one request at a time. Every race in
  [14-testing-strategy.md](../../docs/ecosystem/14-testing-strategy.md) §5 — the chain-keyed
  withdrawal, settlement double-billing, the homestead tile collision — is invisible to it, by
  construction.
- **Side effects not visible in a response.** A service that returns a correct 200 and writes the
  wrong row, emits no event, or double-charges an upstream compares identical. Ledger correctness
  is the property suite's job and reconciliation's; this proves the *interface* did not change.
- **Values, mostly.** A same-typed value change is benign, because market prices and block heights
  move between any two runs. Values that genuinely are contract — error codes, chain ids,
  confirmation depths, decimals, coin symbols — are named explicitly in
  `CONTRACT_VALUE_KEYS`; anything else that matters has to be added there deliberately.
- **What normalisation erased.** `manifest.normalisationRules` lists every rule in force by name.
  If a rule is too broad, the corpus is quietly weaker and the comparison still passes. That is the
  single most likely way this tool is defeated, which is why the rules carry their justification and
  are tested directly.
- **A scenario that skips.** A skip is honest and is never counted as a pass, but it is also not
  evidence. `compare` treats *recorded → skipped* as breaking for exactly this reason: a scenario
  that stopped looking must not be able to certify anything.

### Known over-redaction

Hearth's `/info` publishes `difficultyTarget` as a bare 64-character hex string, which is
byte-for-byte the shape of a raw secp256k1 private key. The recorder cannot tell them apart and
refuses in favour of safety, so that field is written as `<redacted>`. The corpus therefore records
that the field exists and is a string, and not its value. Over-redacting a mining target is the
right side of that trade.

---

## 5. Live-estate safety

- **Never a real user.** Scenarios register their own throwaway account.
- **No money moves.** No credit, charge, conversion, purchase or withdrawal is ever called.
- **One registration per run.** `identity` registers, records it — registration is the thing it
  characterises — and hands the resulting session to every scenario after it. Nimbus limits
  registration to five per minute per IP and this harness shares one source address with Beacon;
  six registrations a run would trip the limit and report an identity outage the harness itself
  caused.
- **The session is revoked on the way out**, once, after the last scenario.
- **Nimbus has no account deletion.** These accounts persist. They are namespaced so they can be
  pruned:

  ```sql
  DELETE FROM users WHERE email LIKE 'conformance+%';
  ```

- **`POST /deposits` is the only write.** It is find-or-create against the throwaway account's own
  wallet, and the second call is recorded because that idempotency is the behaviour being
  characterised.

---

## 6. The ledger account-type sweep

A second, unrelated check that lives here for one reason: **it is the only repository in the estate
whose job is to compare services against each other.** Everything else is a service, and a service
can only ever check itself.

```bash
node --import tsx src/cli.ts ledger-accounts --estate ..
```

### What it checks

`micro-ledger` keys an account on `(subject, asset_code, purpose)` and **nothing else** — not the
type. Every service picks that type independently, in its own source, when it first posts. When two
disagree, `ensureAccount` throws `AccountConflictError` (`ledger/src/accounts.ts:125`) and whichever
service posted **second** has **every** entry refused, in production, for as long as the
disagreement stands.

Nothing in CI can see it. Each service tests against its own fake ledger, so no suite anywhere puts
two real services against one real ledger. Three instances have been found — `micro-worlds`,
`micro-emberkin` and `micro-settlement` all debited `(platform, <asset>, fees)` as `expense` while
six other services credit that key as `revenue` — and all three were found by a human reading a
second repository for an unrelated reason. That is not a search.

The sweep parses every sibling repository's TypeScript with the compiler API (not a regex: the three
literals were spelled three different ways, and a pattern tuned to any one of them misses the
others) and runs three passes:

| Pass | Catches | Needs a resolved subject? |
| --- | --- | --- |
| `DISAGREEMENT` | Two services claim one key with two types | Yes |
| `UNCANONICAL` | One service claims a type the chart contradicts — **before** a second service exists to disagree | Yes |
| `IMPLAUSIBLE` | A `(purpose, type)` pair the chart has no row for at any subject | No |

`CANONICAL_ACCOUNTS` is the chart, and every row carries the source that decided it. The row that
settled both fixes is `micro-ledger`'s own: "`platform` is revenue under `fees`, equity under
`treasury` and expense under `payout_due`" (`ledger/src/accounts.ts:16-17`).

**Exit 1 on any finding.** `src/ledgeraccounts.test.ts` reintroduces each defect and asserts the
sweep goes red on it — the analyser cases run with no estate checked out, so they run in CI.

### What it cannot see

- **A key not written as an object literal in TypeScript.** Eleven of the estate's account literals
  hold their `subject` in a function parameter or an argument property, and no source-level reader
  can resolve those. They are **named and counted**, never dropped; `BASELINE_UNRESOLVED` is
  today's count and the sweep fails if it grows, so the blind spot cannot widen in silence.
- **A repository that is not checked out.** The sweep reports which repositories it read and refuses
  to certify fewer than `MIN_SERVICES`. Otherwise an empty directory would print "no disagreements".
- **The ledger's own rows.** It compares source against source. An account already written to the
  database with the wrong type is reconciliation's problem, not this one's.
- **Whether the chart is right.** `CANONICAL_ACCOUNTS` is a claim, sourced but not proven.

### It runs in `micro-org`'s `estate-ci.yml`

The note that used to sit here said the estate half was "a local gate a human runs, because no CI
job has all the services checked out". That is no longer true: `micro-org/.github/workflows/estate-ci.yml`
clones every `micro-*` repository — derived from the GitHub API, never written down — and runs this
sweep against the lot, nightly and on demand, with a canary before the verdict.

---

## 7. The estate-wide response-body scan

The third estate-wide check, and the same argument for living here: **no route in any service may
return private key material**, which is a fact about 498 routes in 29 servers and about no single
repository.

```bash
node --import tsx src/cli.ts body-scan --estate ..
node --import tsx src/cli.ts body-scan-canary --estate ..   # prove it can still go red
```

### Why it exists

`docs/ecosystem/17-definition-of-done.md` §5 item 4 requires the property be asserted "by a
response-body scan across the entire route surface, **not by inspection**". Exactly one service of
twenty-four implements it — `custody/src/bodyscan.test.ts`, which mints a key in every family, reads
the plaintext out of the vault, drives custody's routes and asserts no body contains any of it. It
is the right instrument and it is the model for this one.

The only estate-wide key check that existed before this was
`org/.github/workflows/secret-hygiene.yml:73-83`, which greps repository **files** for PEM blocks. A
grep over files cannot see what a running route returns; the two do not overlap at all.

### Static, and what that costs

A dynamic scan works by knowing the forbidden strings, which means a fixture holding **real** key
material per service. Custody can produce one because it owns the vault. `micro-market` cannot —
there is no private key in micro-market to compare a body against. Twenty-four Postgres schemas and
a chain adapter per family would turn the DoD item into a check nobody runs.

So this reads source, and it proves something both weaker and wider: no route's response expression
is reachable from a value this analyser can identify as key material, over **every** route, under
**every** input, including the error paths a dynamic scan only reaches if somebody wrote the failing
request. **It does not prove what custody's proves.** Custody's stays.

### Four passes

| Pass | Catches | Example |
| --- | --- | --- |
| `name` | A field called what key material is called | `body: { privateKey: k }` |
| `provenance` | A value that came out of the vault, under any name | `body: { note: await deps.vault.read(slot) }` |
| `shape` | A literal that **is** a key, whatever it is called | a PEM block, an `xprv`, a WIF |
| `row` | A whole database row from a table with a secret column | `select *` reaching a body |

The vocabulary is sourced to custody's own statement of the boundary
(`custody/src/exports.ts:440-453`), which omits from its export event the material, the reveal token
**and its SHA-256**, the vault slot id, the derivation path and the keystore passphrase. Session
tokens, password hashes, public keys and `salt`/`iv`/`nonce` are deliberately **not** in it: they
are not private key material, and a vocabulary that included them would fire on nearly every
authenticating route in the estate on its first run.

`ACKNOWLEDGED` names the routes that legitimately return something in the vocabulary — all three
are custody's export ceremony — each with a reason and a citation. It is a **ratchet, not an
exemption list**: an acknowledgement that matches nothing in the checkout is **red**, so a deleted
route cannot leave a standing permission behind it, and a scan that quietly stopped reading a route
does not look like a clean estate.

### What it cannot see

- **A fourth route spelling.** Three are read (`{ method, path, handle }`, `define(…)`, `route(…)`,
  and the helper name is not hard-coded). A `server.ts` that declares a route table and yields
  **zero** routes is **fatal**, never silently zero.
- **A value it cannot open.** Every one is named, classified by *why* (`dep-call`, `package-call`,
  `derived`, `unresolved`, `depth-limit`) and printed. `BASELINE_BLIND_ROUTES` ratchets the part that
  matters: today **37 of the 113 routes** in the four services that hold key material (`custody`,
  `identity`, `devplatform`, `notify`) have a response this cannot fully account for. Every one is
  listed by `path:line` on every run.
- **Aliasing and mutation.** `const out = {}; out.key = secret; return { body: out }` is not modelled.
  Nothing in the estate builds a body that way today; it is the most likely way a real leak would
  slip past.
- **Runtime provenance, headers not written as a literal, and `main` only** — like every other
  estate check.

### The finding it produced

`custody/src/bodyscan.test.ts:15-17` says its routes are "enumerat[ed] from the server's own table
rather than by hand", and that a route it cannot drive "fails the assertion that the two lists
agree". It does not do this: `routeSamples()` (bodyscan.test.ts:187) is a hand-written array, the
file never references `buildRoutes`, and there is no such assertion. Two of custody's 21 routes are
driven by neither the scan nor the ceremony test — `POST /v1/exports/:id/cancel` and
`POST /v1/exports/:id/challenge`. The second returns the reveal token
(`custody/src/server.ts:549`), which custody itself calls "the one secret in the estate that yields
a private key" (`exports.ts:447`).

Not a criticism of a good test — the reason a claim about a route surface has to be *derived* from
the route surface.

### What `micro-org` must add to `estate-ci.yml`

Two steps, after `Install the checker`, both `if: always()` like the three already there:

```yaml
      - name: The canary — the body scan can still go red
        if: always()
        working-directory: estate/conformance
        run: node --import tsx src/cli.ts body-scan-canary --estate ..

      - name: No route in the estate can return private key material
        if: always()
        working-directory: estate/conformance
        run: node --import tsx src/cli.ts body-scan --estate ..
```

The canary is a **subcommand, not thirty lines of bash in the workflow**, and that is deliberate:
it asserts a property of the checker, so it has to change when the checker changes, and a copy
living in another repository would not. It plants a route returning a private key into the
`micro-wallet` checkout, asserts the sweep goes red **and names the injected file, route and
field**, removes it, and asserts the estate is green again — because a red that survives the cleanup
was never the canary's red. It has been proven to fail in both directions: with `privatekey` removed
from the vocabulary it reports "stayed GREEN … it is measuring nothing", and with the helper-call
route spelling broken it reports "went red but never named the injected FILE".

---

## 8. Layout

```
src/
  record.ts        drives the scenarios, writes the corpus
  compare.ts       the classifier — additive versus breaking
  normalise.ts     the volatility rules, as data, each with its justification
  redact.ts        redaction at capture, and the refusal
  corpus.ts        read and write, and the refusal's last chance
  scenario.ts      defineScenario, the context, the driver
  cli.ts           record / compare / report / ledger-accounts / body-scan
  ledgeraccounts.ts the estate-wide account-type sweep and its chart
  bodyscan.ts      the estate-wide response-body scan, its vocabulary and its blind spot
  scenarios/       one file per surface
```

The scenario shape is deliberately close to Beacon's `defineJourney` — stable names, a description
that says what breaking looks like to a user, reverse-order cleanup on every exit path, and a skip
that carries its reason. What it does **not** copy is `assert`: a characterisation recorder has no
opinion about what a response should say. That is the point.

# `@cloudsforge/conformance` — the characterisation harness

[![ci](https://github.com/cloudsforge-online/micro-conformance/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-conformance/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

Phase 0's regression harness. It records what the running estate **does**, so that when a
`micro-*` service replaces one of the eighteen containers, the replacement can be **proven**
equivalent instead of assumed so.

Design authority: [`ecosystem/14-testing-strategy.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/14-testing-strategy.md)

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

## 2a. This corpus characterises an estate that is no longer running

**Stated here because it is the single most important fact about this repository today, and
nothing in the tool says it out loud.**

Every base in `src/env.ts` names the ten legacy `stack` services — `nimbus` (4001), `game` (4002),
`pay` (4003), `mint` (4004), `keyvault` (4005), `crucible` (4006), `lantern` (4010), `beacon`
(4011), plus the two Hearth listeners. The corpus in `corpus/` was recorded against them on
2026-07-29.

On 2026-08-04, **eight of those ten refuse connections.** Only the two Hearth listeners answer:

```
$ node --import tsx src/cli.ts record --base local --out /tmp/probe/
  recorded health         1 interactions — did not answer: nimbus/health, game/health, pay/health,
                                           mint/health, keyvault/health, crucible/health,
                                           lantern/health, beacon/health
  skipped  identity       0 — nimbus did not answer POST /auth/register: ECONNREFUSED 127.0.0.1:4001
  skipped  wallet         0 — nimbus did not answer POST /auth/register: ECONNREFUSED 127.0.0.1:4001
  skipped  entitlements   0 — nimbus did not answer POST /auth/register: ECONNREFUSED 127.0.0.1:4001
  skipped  mint           0 — mint did not answer GET /chains: ECONNREFUSED 127.0.0.1:4004
  skipped  trade          0 — crucible did not answer GET /catalog: ECONNREFUSED 127.0.0.1:4006
  skipped  game           0 — game did not answer GET /worlds: ECONNREFUSED 127.0.0.1:4002
  recorded chain          7 interactions
```

The live estate is the **`micro-*` estate** — identity, ledger, market, worlds, activity, hub-api
and forty more, behind the gateway — and no base here points at it. So:

> **There is no conformance evidence available for the estate the release gate actually gates, and
> there cannot be until a base is written for it and a baseline is recorded against it.**

### Why the obvious shortcut is refused

`compare --base local` still produces a verdict, and it is `BREAKING`. That verdict is **true about
the legacy estate and misleading about the release**: it says the contract broke, when what
happened is that the services were switched off. Publishing it to Beacon would put
`conformance_breaking` in front of a micro-estate release for a reason that has nothing to do with
that release — a known blocker attributed to the wrong estate, which is worse than an honest
unknown. The gate's own design says so: an unknown refuses and cannot be waived, precisely so that
nobody is tempted to manufacture a determinate answer.

So nothing was published, and the gate still reports `conformance_never_run`. **That reason code is
correct and it should stay until a micro-estate baseline exists.**

### What has to happen, in order

1. Add a `micro` base that names the estate's real addresses (through the gateway, on the estate
   CA — never `curl -k`), and map each scenario onto the service that now serves it.
2. `record --base micro` to capture a baseline. **A recording is not evidence**; it is the thing
   later comparisons are evidence against.
3. From then on, `compare --base micro --beacon <url>` in CI, which posts the result per scenario.

### The wire that was missing

`POST /v1/conformance` has existed in Beacon since the table was created, its own comment says
"the corpus is replayed by `@cloudsforge/conformance` in CI", and `micro-beacon-web` documents the
route. **Nothing has ever called it** — not this repository, not any workflow, not any deploy
script. That is the second, independent reason `conformance_runs` is empty: even a working corpus
would not have reached the gate.

`compare --beacon <url>` is that wire, added 2026-08-04. It posts **one run per scenario**, and a
scenario that could not run is posted with zero counts so Beacon derives a `skip` — which the gate
now reports as `conformance_inconclusive`, an unknown. A scenario is never dropped from the
publish: the gate's other conformance input is whether *any* row exists, so publishing the suites
that ran and quietly omitting the ones that did not is exactly how a partial estate would certify
itself.

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
  [14-testing-strategy.md](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/14-testing-strategy.md) §5 — the chain-keyed
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
the plaintext out of the vault, drives every route in `server.routeTable()` and asserts no body and
no header contains any of it. It is the right instrument and it is the model for this one. It is
also the only entry in `DYNAMIC_SCANS`, which is how this scan knows — by reading it, not by being
told — which routes something else in the estate already watches.

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
does not look like a clean estate. And an acknowledgement **no dynamic scan drives** is red too —
see *The finding it produced* below.

### Two blind-route numbers, and why custody's dynamic work did not move the first one

| | Counts | Today | Lowered by |
| --- | --- | --- | --- |
| `BASELINE_BLIND_ROUTES` | Routes in a key-holding service whose body **this analyser** cannot fully read | **37** | Opening a value here, or a simpler body there |
| `BASELINE_BLIND_TO_EVERY_CHECK` | Of those, the ones **no dynamic scan** in their own service drives either | **31** | A service driving one of its own routes |

Custody's `a633986` drives all six of its routes in the first list, four of them non-probes, with
real key material in the vault. The obvious move is 37 → 33. It is wrong three times over:

1. **A run still says 37.** Not one line of custody's *source* changed in a way this reads —
   `deps.metrics.render()`, `randomBytes(32)`, the emit callback in `outbox.ts:91` are exactly as
   opaque as yesterday. 33 does not record progress; it turns the gate red and invites the next
   person to put it back. A measurement is not lowered by arithmetic on a commit message.
2. **It would make one number mean two things.** This one measures *this analyser's reach*, which is
   what makes a rise actionable: somebody wrote a body it cannot follow.
3. **It would break the ratchet's own rule.** This number may only go *down*. If custody's coverage
   could lower it, custody deleting a sample would have to *raise* it — a ratchet another repository
   can force upward is not a ratchet.

So custody's work lowered the **second** number instead, which is the one that answers the question
a reader actually has: how much of the estate's key-holding route surface is watched by nothing.
`identity` holds the key that signs every token in the estate and has no dynamic body scan at all;
all 18 of its blind routes are in there. That is the next thing worth doing.

### What it cannot see

- **A fourth route spelling.** Three are read (`{ method, path, handle }`, `define(…)`, `route(…)`,
  and the helper name is not hard-coded). A `server.ts` that declares a route table and yields
  **zero** routes is **fatal**, never silently zero.
- **A value it cannot open.** Every one is named, classified by *why* (`dep-call`, `package-call`,
  `derived`, `unresolved`, `depth-limit`) and printed. `BASELINE_BLIND_ROUTES` ratchets the part that
  matters: today **37 of the 113 routes** in the four services that hold key material (`custody`,
  `identity`, `devplatform`, `notify`) have a response this cannot fully account for. Every one is
  listed by `path:line` on every run.
- **Whether a route is watched by anything else.** Derived, not assumed:
  `BASELINE_BLIND_TO_EVERY_CHECK` is **31** — of those 37, the ones their own service does not drive
  dynamically either. See below for why these are two numbers and not one.
- **Aliasing and mutation.** `const out = {}; out.key = secret; return { body: out }` is not modelled.
  Nothing in the estate builds a body that way today; it is the most likely way a real leak would
  slip past.
- **Runtime provenance, headers not written as a literal, and `main` only** — like every other
  estate check.

### The finding it produced — and what happened to it

This scan's first run found that `custody/src/bodyscan.test.ts` claimed to enumerate "the routes
from the server's own table rather than by hand" while `routeSamples()` was a hand-typed array that
never referenced `buildRoutes`. Two of custody's 21 routes were therefore driven by nothing —
`POST /v1/exports/:id/cancel` and `POST /v1/exports/:id/challenge`, the second being the one that
returns the reveal token. Custody fixed it in `a633986`: the sample list is reconciled against
`routeTable()` in both directions, and the server's own `http_requests_total{route=…}` counter is
read back so a sample that names one route and drives another fails.

**The more useful finding is what that did to this repository.** The fix made a sentence in
`ACKNOWLEDGED` false — and nothing here could tell, because it was prose. That is the rot the estate
spent a night clearing: ~40 stale citations across four repositories, a gap file whose evidence
pointed at the wrong remedy, and a comment describing a test rather than reading it.

So the claim is no longer stored. `DYNAMIC_SCANS` stores a **pointer** — service, file, sample
function — and `readDynamicCoverage` parses the route set out of that file's AST on every run,
reconciling it **in both directions** against the routes this analyser independently extracted from
the same service's `buildRoutes`. Two readers, one source; a disagreement either way is red and
names the route. A declared scan whose file, function, sample list or route property has moved
**throws** — it is never quietly zero, because a coverage reader whose failure mode is a smaller
number would silently discount blind routes.

And the rule that sentence became: **an acknowledgement no dynamic scan drives is red.** A standing
permission to return key material on a route nothing exercises means the only account of what that
route returns is the acknowledgement's own prose. On `a633986`'s parent commit this was red for
`POST /v1/exports/:id/challenge`, which is the whole argument for it.

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

**The two steps above are unchanged and need no edit.** What changed is what `body-scan` exits 1
*for*, and micro-org should know it because a red will now name things that are not leaks:

| New failure | Reads like | Who fixes it |
| --- | --- | --- |
| `COVERAGE` | `custody/src/bodyscan.test.ts and this analyser disagree about custody's routes` | Whoever changed custody's routes or its sweep — **not** this repo's budget |
| `UNWITNESSED` | an acknowledged route no dynamic scan drives | The service that owns the route: drive it, or withdraw the acknowledgement |
| a thrown error naming a sample function | the coverage reader could not parse a declared dynamic scan | This repository — `readDynamicCoverage` |

It still needs **all** the sibling checkouts on one disk, and it still dials nothing. It reads
`custody/src/bodyscan.test.ts` as *source*; it does not run it, and does not need a database.

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

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.

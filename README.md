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

## 6. Layout

```
src/
  record.ts        drives the scenarios, writes the corpus
  compare.ts       the classifier — additive versus breaking
  normalise.ts     the volatility rules, as data, each with its justification
  redact.ts        redaction at capture, and the refusal
  corpus.ts        read and write, and the refusal's last chance
  scenario.ts      defineScenario, the context, the driver
  cli.ts           record / compare / report
  scenarios/       one file per surface
```

The scenario shape is deliberately close to Beacon's `defineJourney` — stable names, a description
that says what breaking looks like to a user, reverse-order cleanup on every exit path, and a skip
that carries its reason. What it does **not** copy is `assert`: a characterisation recorder has no
opinion about what a response should say. That is the point.

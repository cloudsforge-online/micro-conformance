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
   literal value from the estate's own secret file. A redaction pass over stored fixtures is a pass
   that can be forgotten; a refusal at capture cannot. The literal half is loaded **per base** —
   `--base micro` reads the micro estate's `deploy/compose/estate/tokens.env`, `--base local` reads
   the legacy checkout's `.env` — and a run that cannot load them **refuses to record at all**
   rather than falling back to the pattern half. See §2b.
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
pnpm typecheck && pnpm test          # 205 tests, none of which needs a running estate

node --import tsx src/cli.ts record --base local --out corpus/
```

**`record` and `compare` refuse to start unless they can load the secret literals of the estate
the chosen base dials** — see §2b. The files are declared per base and found automatically;
`CONFORMANCE_SECRETS_FILE=<path>[,<path>]` overrides them when a checkout is somewhere unusual.

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

The five rows above them — `wallet`, `entitlements`, `mint`, `trade`, `game` — characterise the
**legacy** estate and skip against `--base micro`, because those resources were redesigned rather
than re-hosted. The same five capabilities on the micro estate have their own suites:

| Scenario | Covers | Succeeds |
| --- | --- | --- |
| `micro-wallet` | `/v1/wallets`, `/v1/portfolio`, `/v1/deposits`, `/v1/deposits/credits`, `/v1/withdrawals`, and the `not_depositable` refusal on the write path | `wallet` |
| `micro-entitlements` | `GET /products` — the one route that replaced four frozen catalogue arrays — plus `/entitlements` and `/subscriptions` | `entitlements` |
| `micro-mint` | `/v1/catalogue` (variants, price, network) and the order list | `mint` |
| `micro-trade` | `/v1/strategies` and **`/v1/capabilities`**, plus bots and backtests | `trade` |
| `micro-worlds` | `/v1/titles`, the fail-open `/v1/players/me`, inventory and provisions | `game` |

Neither generation is ever pointed at the other's estate, and `src/env.test.ts` asserts that: a
successor suite names only `micro-*` targets, a legacy suite never names one. See §2b.

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

So nothing was published, and the gate reported `conformance_never_run`. That reason code was
correct and it stayed until a micro-estate baseline existed. **It does now — see §2b.**

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

## 2b. The micro baseline, and the finding that came with it

**`conformance_never_run` is retired.** A `micro` base exists, `corpus-micro/` is its baseline, and
`compare --base micro --beacon <url>` published eight suites to Beacon on 2026-08-04.

```bash
# The CA is not optional and `-k` is not an option. See `assertTlsTrust` — a run that cannot
# verify the estate skips every scenario and publishes eight unknowns that read like a dead estate.
export NODE_EXTRA_CA_CERTS=<estate>/deploy/gateway/certs/ca.crt

node --import tsx src/cli.ts record  --base micro --out corpus-micro/
node --import tsx src/cli.ts compare --base micro --corpus corpus-micro/ \
  --beacon https://beacon.cloudsforge.localtest.me --release <tag>
```

### The finding: the micro estate is a REDESIGN, not a re-hosting

`src/env.ts`'s own header assumed the opposite — "a `micro-*` replacement on a different port is
still 'wallet' and still compares against what 'wallet' used to do". Measured through the gateway
on 2026-08-04, that is true of identity and of nothing else. **Four of the ten targets have no
address serving the surface this corpus records**, because the resources were renamed and
versioned:

| Target | Successor | What the corpus asks for | What is there |
| --- | --- | --- | --- |
| `pay` | `micro-wallet` at `pay.<apex>` | `/wallet`, `/coins/rates`, `/deposit-coins`, `/deposits` … | `/v1/wallets`, `/v1/deposits`, `/v1/withdrawals` — 1 of 11 paths survives (`/entitlements`, via billing) |
| `game` | `micro-worlds` at `worlds-api.<apex>` | `/worlds`, `/cosmetics` | `/v1/titles`, `/v1/players/me` |
| `mint` | `micro-mint` | `/chains`, `/offers`, `/capabilities` | `/v1/catalogue`, `/v1/tokens` |
| `crucible` | `micro-trade` | `/catalog`, `/bots`, `/billing` | `/v1/strategies`, `/v1/bots`, `/v1/backtests` |

### Why those four are UNMAPPED rather than pointed at their successors

**Because a 404 is a response, and `ctx.call` only skips on a transport failure.** Point `pay` at
the wallet service and the `wallet` scenario records six 404s, reports `recorded`, and the next
comparison finds all six *identical* — `identical + benign > 0` is exactly what makes Beacon's
`statusFor` derive `pass` rather than `skip` (`beacon/src/conformance.ts:100-108`). The gate would
then be told the wallet suite passes, on the evidence that every wallet route is absent. A stable
404 is indistinguishable from a stable contract to everything downstream.

**And two of them would have recorded an HTML page as an API.** The roots of `create.<apex>` and
`trade.<apex>` are the web bundles; only `/v1` reaches the service. `GET /bots` on `trade.<apex>`
answers **200 text/html** — the SPA shell. That is the "200 carrying HTML" failure this estate has
been bitten by before, and it would have compared identical forever.

So `env.ts` gained `UnmappedTarget`: a target with no address and a stated reason. The scenario
skips before a request is built, the reason reaches the manifest and Beacon verbatim, and the gate
reports `conformance_inconclusive` — an unknown that refuses and cannot be waived.

### The line between a suite that skips and a suite that records absence

`health` is MAPPED to `keyvault`, `lantern` and `beacon` and records a 404 from each, because
those services serve `/livez` and `/readyz` now. That is not a double standard:

> A scenario that observes something real plus documented absences has characterised the estate.
> A scenario that observes **nothing but absence** has characterised nothing, and must not report a
> verdict.

`health` sees jwks answer 200, the chain node answer 200, and eight `/health` routes demonstrably
gone — which is P2 landing, and §2's own note says recording the shape the estate has *today* is
what makes that replacement provable. `wallet`, `mint`, `trade` and `game` see only absence.

### What the run says, and what it does not

| Suite | Result | |
| --- | --- | --- |
| `chain` | `pass` | The **same hearth-testnet node** the legacy corpus recorded. The one suite whose two recordings are directly comparable. |
| `health` | `pass` | jwks and `/info` answer; eight `/health` routes are gone and recorded as gone. |
| `identity` | `pass` | Register, `/auth/me`, rotation and password change all replay. |
| `micro-wallet`, `micro-entitlements`, `micro-mint`, `micro-trade`, `micro-worlds` | `pass` | The five capabilities, at the addresses that serve them. 24 interactions, every one `application/json`, no 5xx. |
| `wallet`, `entitlements`, `mint`, `trade`, `game` | `skip` | The five LEGACY contracts, which nothing on this estate serves → five `conformance_inconclusive`. |

**The five skips are unchanged and they are still the correct outcome.** They are not the same
statement as "the capability is unmeasured": each legacy reason now ends by naming the successor
suite that records the capability. What the gate is told is precise — *the legacy wallet contract
has no evidence on this estate, and the wallet capability has a baseline of its own* — and it is
still an unknown that cannot be waived, because a legacy contract with no server is exactly what
an unknown is for.

Three things this baseline is **not** evidence of, stated because a recording is the thing later
comparisons are evidence against and never the evidence itself:

- **That the micro estate is correct.** `corpus-micro/` characterises it against *itself*. Nothing
  here compares the micro estate to the legacy contract, and after the table above it is clear that
  nothing could.
- **That identity's contract is unchanged.** Two differences are recorded rather than papered over:
  `POST /auth/login` now requires `identifier`, not `email` (it answers 400 to the legacy shape),
  and `/portal/handoff` + `/auth/exchange` are `/auth/handoff` + `/auth/handoff/redeem`
  (`identity/src/server.ts:1144,1161`), so the SSO half is reported as unrecorded. The scenario
  paths were deliberately **not** renamed: the same code records the `local` corpus, so renaming
  them would rewrite what the legacy baseline characterises in order to make this one greener.
- **That refresh-reuse detection is exercised.** All three `/auth/refresh` calls answer 200, which
  is **not** a missing defence: `micro-identity` has a 10-second rotation grace window
  (`identity/src/tokens.ts:171`), and a token re-presented inside it is classed `concurrent` with
  the family kept. The scenario re-presents in milliseconds, so it can never reach the burn. This
  is the sharpest instance of §4's "anything it does not exercise" and the next thing worth fixing.

### THE HYGIENE REFUSAL LOADED THE WRONG ESTATE'S SECRETS — closed 2026-08-04

This was reported here as an open limitation when `corpus-micro/` was first committed. **It is
fixed, and nothing sensitive was recorded while it was open.** Both halves of that sentence were
re-derived from source and from the corpus rather than carried over.

**The mechanism.** `loadSecrets` took a *path*, defaulted from a single `STACK_ROOT` that
`findStackRoot` derived by walking up for a directory holding both `docker-compose.yml` and
`.env.example`. On this machine that walk lands in the **legacy `stack` checkout**
(`/…/stack`), and nothing anywhere related the loaded secrets to the base being recorded — `cli.ts`
called `loadSecrets()` with no argument at all and handed the result to `record({ base })`. So
`record --base micro` armed the refusal's **literal** half with the *legacy* estate's values while
recording *micro* traffic into a corpus committed to a **public** repository. The literal half is
the backstop for everything the pattern half does not recognise, so on this base it was not weaker
— it was absent.

**Why nobody saw it.** A refusal that cannot fire and a refusal that never had to fire produce
byte-identical output. The run even printed `secret-hygiene refusal: patterns + estate literals`,
which was true of a different estate. That is this repository's named defect class, *a check that
cannot fail*.

**What changed** (`src/env.ts`, `src/record.ts`, `src/cli.ts`):

- Each base **declares its own secret files**. `micro` → `deploy/compose/estate/tokens.env`, the
  gitignored file `deploy/scripts/estate-bootstrap.sh` generates and every service is booted from
  (`deploy/compose/.env` is a symlink to it). `local` → the legacy checkout's `.env`, unchanged.
  The micro checkout is found by a marker the legacy one does not have (`deploy/compose` beside
  `deploy/gateway`), not by counting directory levels.
- `loadSecrets` takes a **base name, not a path**, and the result carries the base it was loaded
  for. `record` refuses when that does not match the base being recorded — which makes the original
  arrangement *unrepresentable* rather than merely corrected.
- **Three refusals, in the shape `assertTlsTrust` established:** by name, saying what to set. The
  literals belong to another estate; the declared file could not be read; the file was read and
  held no literals. All three used to be silent, and the third matters as much as the second — an
  empty literal set is a refusal that cannot fire.
- **The "absent file is a supported mode" allowance is gone.** Its stated justification was "a CI
  runner that has the services but not the operator's file must still be able to record". No CI job
  in this repository has ever recorded — `.github/workflows/ci.yml` runs the typecheck and the pure
  suite and says so in its own header — so that allowance bought nothing and cost the whole literal
  half. `CONFORMANCE_SECRETS_FILE=<path>[,<path>]` repoints the files explicitly; there is no
  implicit degradation.

`deploy/compose/testnet.env` is deliberately **not** loaded: it holds `CF_PROJECT`, `CF_NET_PREFIX`
and port bases, and putting ordinary infrastructure substrings into the refusal set would produce
false refusals on legitimate response bodies, which is how a hygiene check gets switched off.

**Was anything sensitive recorded? No.** Re-verified against the corrected literal set rather than
by eye:

- Every one of the **30** literals `tokens.env` yields was fed through `findSecretLeak` inside a
  realistic fixture; all 30 are caught, so the arming is demonstrably not vacuous.
- Both `corpus-micro/` (27 files) and `corpus/` (61 files) were replayed through the real refusal
  armed with the micro estate's literals. **0 files refused.** The same sweep run against
  `tessera/.env` — the one other real secret file in the checkout — also found nothing.
- The only opaque runs of ≥28 characters in `corpus-micro/` are three, and each was identified:
  the RSA **public** modulus `n` from `/.well-known/jwks.json` (the JWK carries `e`, `n`, `alg`,
  `kid`, `kty`, `use` and **no** `d`, `p` or `q` — it is a public key, and characterising it is
  what the `health` scenario is for); the chain's 66-character `0x` genesis hash, which `chain`
  deliberately keeps comparable; and the CORS header name `access-control-allow-credentials`.
- A full `record --base micro` was re-run with the corrected literals armed. It completed, no
  refusal fired, and it reproduced the committed corpus except for the throwaway account's
  generated slug and one timing bucket.

The predecessor's hand check reached the same conclusion, and it was right — but it was right by
inspection, which is the thing that check exists to replace.

---

## 2c. The five capabilities that had no baseline, and what recording them found

Five suites reported `conformance_inconclusive` because their legacy contracts have no server on
this estate. That is a true statement about the contracts and it was being read as a statement
about the products, so each capability was traced to whatever serves it now and characterised
there. All five have a live successor; **none was retired.**

Every address below was measured on 2026-08-04 through the gateway on the estate's own CA — never
`curl -k` — against 61 healthy containers.

| Capability | Legacy suite asked | What serves it now | Evidence |
| --- | --- | --- | --- |
| Wallet | `pay` `/wallet`, `/coins/rates`, `/deposit-coins` | `micro-wallet` at `pay.<apex>`, whole host at priority 500 (`estate-web.yml:793-797`) | `/v1/wallets`, `/v1/portfolio`, `/v1/deposits`, `/v1/deposits/credits`, `/v1/withdrawals` — `wallet/src/server.ts:445-806` |
| Entitlements | `pay` `/cosmetics`, `/convenience`, `/season-pass`, `/private-worlds` | `micro-billing`, four prefixes carved out at priority 600 (`estate-web.yml:798-802`) | One `GET /products` replaces all four arrays; seeded by `billing/src/migrations.ts:391` |
| Mint | `mint` `/chains`, `/offers`, `/capabilities` | `micro-mint` at `create.<apex>/v1` (`estate-web.yml:238-242`) | `/v1/catalogue`, `/v1/tokens` — `mint/src/server.ts:354-441` |
| Trade | `crucible` `/catalog` | `micro-trade` at `trade.<apex>/v1` (`estate-web.yml:251-255`) | `/v1/strategies`, `/v1/capabilities` — `trade/src/server.ts:341-370` |
| Game | `game` `/worlds`, `/cosmetics` | `micro-worlds` at `worlds-api.<apex>`, whole host (`estate-web.yml:299-303`) | `/v1/titles`, `/v1/players/me`, `/v1/provisions` — `worlds/src/server.ts:507-741` |

**The successor suites are new suites, not the old ones repointed.** That distinction is the whole
of §2b's argument carried forward: a legacy suite pointed at a successor address records 404s as
behaviour, compares them identical forever, and Beacon derives `pass` from `identical + benign > 0`
for a suite that observed nothing. So each generation names only its own targets and
`src/env.test.ts` asserts it — including the negative, which is what makes the positive mean
anything.

### The one route that is deliberately NOT in the baseline

`POST /v1/deposits` — the find-or-create deposit address, and the single most valuable interaction
the legacy `wallet` suite has. **On this estate it is broken**, and a baseline is what later runs
are compared against, so recording it would make the defect the contract and make its repair read
as a breaking difference.

```
POST /v1/deposits {"assetCode":"EMBER"}  →  500 {"error":{"code":"internal"}}
```

wallet's own log names the cause: `CustodyRefusedError: POST http://custody:4000/v1/addresses →
400`, thrown at `wallet/src/custodyclient.ts:153`. That class appears three times in `wallet/src`
and all three are inside `custodyclient.ts`, so **nothing catches it** — a peer-decided 4xx reaches
the caller as an internal error. Two defects in one response, neither of them this repository's to
fix, and both reported rather than frozen.

The route is still characterised by the half of it that is correct and deterministic: an asset that
does not settle on a chain answers **400 `not_depositable`** without ever reaching custody. That
records the write path's auth requirement, its refusal and its error code, and records nothing that
is currently wrong.

### The line between an answer that is wrong and an answer that is right about a small estate

Both look thin in a corpus and they are opposites, so the rule is stated once and applied:

> **Exclude an answer that is wrong. Include an answer that is right about a small estate.**

`POST /v1/deposits` is wrong — a 500 over an unhandled refusal — and is excluded. `GET /v1/titles`
is *right*: it reports one title, `emberkin`, `status: "draft"` with no capabilities, which is
there because `deploy/scripts/estate-verify.sh:790-792` registers it and which `titles.ts:228`
makes unsellable at that status. It is recorded, because a title registry losing its only entry is
worth a human looking whoever put the entry there. `micro-worlds`' header says so, so a future
`breaking` diff on that file arrives with its provenance attached.

The same rule is why `GET /v1/portfolio` is in the baseline: its body carries a `degraded` array
naming the sources it could not read. It recorded `[]`. A corpus taken while that array was
non-empty would be a corpus of a partly-blind estate, and recording the field is what makes the
difference visible instead of invisible.

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

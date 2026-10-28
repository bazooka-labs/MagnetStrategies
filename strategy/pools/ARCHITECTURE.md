# Strategy Pools — code layout

Where things live, and the two naming traps in this tree. Read this before
adding a pool; it is written for whoever picks this up cold, including me.

## The three layers

Capital flows through the same four stages whatever the venue, and the code is
cut along them rather than along "PEX" vs "us".

```
  ┌─ UI ───────────────────────────────────────────────────────────┐
  │ web/src/app/strategy/            the route                     │
  │ web/src/components/strategy/pools/  LiquidityView (the page)   │
  │                                  LiquidityActions (pools)      │
  │                                  CvaActions (vault)            │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Product: Strategy Pools ──────────────────────────────────────┐
  │ web/src/lib/strategy/                                          │
  │   SHARED                                                       │
  │     preflight.ts    every gate and notice, both destinations   │
  │     submit.ts       sign, send, three outcomes                 │
  │     performance.ts  PEX's published APR bundle (unsigned)      │
  │     totals.ts       page-level aggregation, dedup              │
  │   DIRECT POOLS (markets 1 and 2)                               │
  │     client.ts       pins -> gates -> build -> assert -> submit │
  │     quote.ts        fast estimate while typing (NOT the floor) │
  │     group.ts        build + assert + the chain's own receipt   │
  │     reads.ts        `ml2:` / `mp2:` box reads                  │
  │   C-VAULT                                                      │
  │     cvaClient.ts    same order; snapshot read LAST             │
  │     cvaSnapshot.ts  the state the planner and builders eat     │
  │     cvaGroup.ts     route choice, builders, assertions, marks  │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Shared PEX protocol layer ────────────────────────────────────┐
  │ web/src/lib/strategy/pex/config*.ts   ← SEE THE TRAP BELOW                   │
  └────────────────────────────────────────────────────────────────┘
```

## Trap 1: six `perps*` modules are not about perps

The perps terminal was the first product on PEX, so the whole PEX protocol
layer got a `perps` prefix. It is now shared with this product, and the name
lies. **These are the shared layer:**

| file | what it actually holds |
|---|---|
| `perps.ts` | `PEX_APPS`, `PEX_ASSETS`, program-hash pins, `PIN_SETS`, oracle age limits |
| `perpsGroup.ts` | `checkEveryTransaction`, `checkMathCarriers`, `abiBytes`, `simulateGroup` |
| `perpsOracle.ts` | `getOraclePayload` — generic over app id, verifies the pinned signer |
| `perpsManifest.ts` | the vendored, hash-pinned ABI manifest |
| `perpsReads.ts` | box reads, `verifyProgramPins`, `readYieldRegistry`, `readMarketPositions` |
| `perpsQuote.ts` | `marketRecord`, `priceInput` |

Everything else under `perps*` (`perpsClient`, `perpsSolver`, the position
quotes, the chart modules) is genuinely the trading terminal.

**Not renamed on purpose.** 45 files import these, across the live trading
money path, for zero functional gain. That is the diff the "no hot fixes" rule
exists to prevent. If it is ever done it is a standalone, behaviour-free PR —
`lib/pex/` is the obvious destination — and not bundled with a feature.

## Trap 2: `components/strategy/` serves `/trade`

```
web/src/components/strategy/   -> the PERPS terminal   (/trade)
web/src/components/strategy/pools/  -> Strategy Pools  (/strategy)
```

Exactly inverted, for historical reasons: Strategy was the arm name before the
nav split into Trade and Strategy (see `../OVERVIEW.md`). The target is
`components/<route>/` matching `app/<route>/`, as `contact`, `magnetfi`,
`predict` and `tokens` already do. Deferred because it edits the live `/trade`
tree; every miss is caught by `tsc`, and the only dynamic imports in the repo
are two in a test file, so it is safe whenever someone wants it done.

## The four stages, and the contract a new pool implements

```
preflight  ->  quote  ->  build + assert  ->  submit
```

- **preflight** returns `Gate[]`. A gate means *do not offer the action*, with
  copy that always names a duration and never says "lock" or "cannot"
  (`SIGNING.md` §6b; a test asserts the vocabulary). Venue-agnostic helpers —
  balances, minimums, `phrase()` — are already shared.
- **quote** is an estimate for the typing UI only. It **must not** set an
  on-chain floor: PEX's own LP quotes are ~1.65% out, enough to make a 1% floor
  unsatisfiable (`SIGNING.md` §11.1).
- **build + assert** builds through the vendored SDK, then checks the finished
  bytes against what was displayed — never by re-deriving through the same SDK.
  Floors come from the contract's own simulated receipt, which is why the build
  runs two passes.
- **submit** is `submit.ts` and is already venue-agnostic: three outcomes, never
  two, and a lost response is never reported as a failure.

### What the C-Vault proved about the seam

The interface was left unextracted until a second implementation could test it.
The C-Vault landed on 2026-10-22, and the verdict is mixed — which is why it is
written down rather than abstracted over:

**Held up, and is genuinely shared today:**

- the four stages, in that order
- `preflight.ts` — every gate and the `Notice` type, both destinations
- `submit.ts` — three outcomes, venue-agnostic
- the two-pass receipt pattern: simulate, read the contract's own figure, set
  the floor from that, rebuild. Needed on all four paths, for the same reason.
- "a first deposit pays a box MBR exactly, later ones exactly zero" — different
  constants (`ml2:` 26,500, `gu2:` 32,900), identical shape

**Did NOT generalise:**

- **Route choice.** The pools have one path; the vault has idle vs per-market
  and needs `planV2CvaWithdraw`. There is no shared notion of "route".
- **State assembly.** The pools read two boxes. The vault needs a whole
  snapshot — vault globals, allocations, pools, markets, per-market oracles,
  per-market registries — which is why `cvaSnapshot.ts` exists and the pools
  have no equivalent.
- **When state is read.** The pools read gates and build from the same data. The
  vault's snapshot lives 20 seconds and must be read at the moment of the
  action, so its gates deliberately use different, cheaper reads.
- **How an amount is expressed.** Pools: a share percentage. Vault: dollars,
  because every constraint on it is a dollar figure.

**Conclusion: do not extract a `Pool` interface.** Two implementations share
their *gates* and their *discipline*, not their shape. A common interface would
have to be the union of a route-less two-box pool and a snapshot-driven
multi-market vault, which is not an abstraction, only a bigger surface. Keep
sharing at `preflight.ts` / `submit.ts` and let each destination own its own
build. Revisit if PactFi CLMM turns out to look like one of the two.

## Adding a pool

1. Its chain state — a `reads.ts` addition for something pool-shaped, or its own
   `<name>Snapshot.ts` if it needs a snapshot like the vault does.
2. `preflight.ts` — its gates, in the shared file. Reuse `phrase()`; never
   invent new cool-down wording. A thing that should not disable the button is a
   `Notice`, not a `Gate`.
3. `<name>Group.ts` — its build and its assertion, with **its own** call budget
   and shapes. Do not widen another flow's budget to fit (`SIGNING.md` §11.5).
4. Pin the programs it signs against, in `PEX_PROGRAM_SHA256` and `PIN_SETS`.
5. Find its first-deposit box MBR before shipping. Both destinations had one,
   both would have blocked every new depositor while every test passed, and one
   of them reached production (`SIGNING.md` §11.10, §11.12).
6. Capture real groups into `__fixtures__/` and write mutation tests against
   those bytes, not hand-built literals.
7. A `__live__/*.live.test.ts` that builds AND simulates against MainNet. Six
   separate defects in this product were invisible to hermetic tests and obvious
   to a simulation; this is not optional.
8. Mounted component tests that assert the button's `disabled` state, not only
   the message beside it — a test that checks the copy alone passes while the
   button is dead.

## Tests

```
npx vitest run                                      hermetic, ~3s
npx vitest run --config vitest.live.config.ts       MainNet, builds + simulates
CAPTURE=1 npx vitest run src/lib/strategy/__fixtures__/capture.test.ts
```

`.live.test.ts` is excluded from the default run: a suite that fails when the
network is down is a suite people stop trusting.

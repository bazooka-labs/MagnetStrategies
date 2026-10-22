# Strategy Pools — code layout

Where things live, and the two naming traps in this tree. Read this before
adding a pool; it is written for whoever picks this up cold, including me.

## The three layers

Capital flows through the same four stages whatever the venue, and the code is
cut along them rather than along "PEX" vs "us".

```
  ┌─ UI ───────────────────────────────────────────────────────────┐
  │ web/src/app/strategy/            the route                     │
  │ web/src/components/liquidity/    the page + the forms          │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Product: Strategy Pools ──────────────────────────────────────┐
  │ web/src/lib/strategy/                                          │
  │   client.ts      pins -> gates -> build -> assert -> submit    │
  │   preflight.ts   the gates; decides what is OFFERED            │
  │   quote.ts       fast estimate while typing (NOT the floor)    │
  │   group.ts       build + assert + the chain's own receipt      │
  │   submit.ts      sign, send, three outcomes                    │
  │   reads.ts       per-pool chain reads (boxes)                  │
  │   totals.ts      page-level aggregation, dedup                 │
  │   performance.ts PEX's published APR bundle (unsigned)         │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Shared PEX protocol layer ────────────────────────────────────┐
  │ web/src/lib/perps*.ts   ← SEE THE TRAP BELOW                   │
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
web/src/components/liquidity/  -> Strategy Pools       (/strategy)
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

**The interface is deliberately not extracted yet.** One implementation cannot
show where the seam belongs. The C-Vault is a genuinely different shape — a
same-round mark preamble, variable group length — so it is the second
implementation that will either fit this contract or prove it wrong. Extract
after it lands, with PactFi CLMM as the first purely additive pool.

## Adding a pool

1. `reads.ts` — its chain state.
2. `preflight.ts` — its gates. Reuse `phrase()`; never invent new cool-down wording.
3. `group.ts` — its build and its assertion, with **its own** call budget and
   shapes. Do not widen another flow's budget to fit (`SIGNING.md` §11.5).
4. Pin the programs it signs against, in `PEX_PROGRAM_SHA256` and `PIN_SETS`.
5. Capture real groups into `__fixtures__/` and write mutation tests against
   those bytes, not hand-built literals.
6. A `__live__/*.live.test.ts` that simulates against MainNet. Three defects in
   the PEX pools path were invisible to hermetic tests and obvious to a
   simulation; this is not optional.

## Tests

```
npx vitest run                                      hermetic, ~3s
npx vitest run --config vitest.live.config.ts       MainNet, builds + simulates
CAPTURE=1 npx vitest run src/lib/strategy/__fixtures__/capture.test.ts
```

`.live.test.ts` is excluded from the default run: a suite that fails when the
network is down is a suite people stop trusting.

# Trading Terminal — ALGO collateral

> **LIVE since 2026-11-05. This file is the build spec, not the status.**
> The header below said PARKED until 2026-11-08 and was wrong for three days:
> the toggle shipped in `8290f72`, the assertions were widened in `35b988d`,
> and the UI gate that outlived that fix was lifted in `b5a3472`. Opens and
> closes both work and multiple real ALGO positions have been opened and
> closed on mainnet since.
>
> **Status lives in [OVERVIEW.md](./OVERVIEW.md), per CLAUDE.md, and nowhere
> else — including here.** This block is a pointer so the next reader does
> not do what the last one did, which was trust a stale header in a SPEC over
> the OVERVIEW that was correct all along.

| Layer | State |
|---|---|
| §4 group assertion — collateral leg found by position | shipped |
| §5a read path — both collaterals, labelled, distinct identities | shipped |
| §5b close/cancel — follow the position's own collateral | shipped |
| §5c audit fixes — four live display bugs, one dead guard, test gaps | shipped |
| unit plumbing — asset units authoritative, USD derived | shipped |
| the pill toggle | shipped — `8290f72` |
| ALGO open | **live** — the refusal was lifted with the widened assertions |
| ALGO close | **live** — `b5a3472` |

**Why it was parked, and what changed.** Measured on 2026-11-03: ONE
ALGO-collateral position existed on the entire exchange, worth $20.02, held by
a wallet that may not use this terminal. Finishing requires loosening two
fund-safety assertions, and the audits showed that work in this area
introduces defects that only independent review catches — four live wrong
numbers and a tautological guard survived the author's own review. The
cost-to-value ratio does not currently justify it.

**What was worth it anyway**, all independent of the toggle: ALGO-collateral
orders no longer resolve as "Orphaned — funds still locked"; four
collateral-denominated figures stopped being displayed as dollars; close and
cancel target the right box and refund the right asset; and the suite now
catches wiring mutations that previously passed.

## Decisions taken, for whenever this resumes

1. **The amount box means ALGO when ALGO is selected** — the figure the user
   types and that MAX fills is ALGO available in their wallet as collateral,
   not a dollar amount. Settled by the product owner 2026-11-03. It is also
   what the write path already expects: asset units are authoritative and USD
   is derived (see `pex/collateral.ts`), so the box feeds
   `collateralAmountMicro` directly with no conversion between typing and
   signing.
2. **Protection and limit orders stay refused on ALGO** until an ALGO-fee
   order is observed being executed by a keeper on MainNet. Evidence as of
   2026-11-03: of 328 historical order submissions, 10 used an ALGO keeper
   fee — all from ONE sender, inside a ~2-hour window, all at round ~64.67M,
   i.e. before the order-box cutover at 65,266,976. Zero orders rest on the
   exchange today. That is one account's experiment in the previous contract
   generation, not evidence about today's keepers.
3. **Before the open refusal is lifted**, the leverage assertion must be
   rebuilt — see §5c. The existing one cannot fail.

## Verified facts worth keeping

- The contract's `min_keeper_fee_usd` is **$0.05**, read live from the
  OrderOps `op` global (50000, 2592000, 1e12). Admin-mutable; read it, do not
  hardcode it.
- `keeperFeeAssetId == collateralAssetId` in **all 328** historical
  submissions. The invariant our assertions enforce is the one PEX's own users
  follow, not a convention we invented.
- `collateral_amount` is denominated in the collateral ASSET. Measured:
  210.873916 (ALGO) against size_usd 20.02, and 566.816347 (USDC) against
  size_usd 1805.50.

---

## 1. What is being asked for

A pill toggle beside **Amount**, above the input, letting the user post **ALGO**
or **USDC** as collateral. Today the terminal is USDC-only.

## 2. What PEX actually supports — verified, not assumed

Measured on market 1, 2026-11-03:

| | |
|---|---|
| `collateral_sum_long_token_for_longs` | **210.87 ALGO** |
| `long_oi_usd_with_long_collateral` | **$20.02** |

So ALGO collateral is live on chain today, with real positions. Nothing needs
to change at PEX; this is entirely our side.

**The position box key is `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner`.**
Collateral asset is part of position *identity*. `config.ts:72` fixes it to
USDC with the comment "Keeps one position per (market, side)" — that property
is a consequence of the restriction, and enabling ALGO **ends it**: a wallet
can then hold up to four positions per market, not two.

**`open_or_increase` takes no `collateralAssetId` argument** (SPEC.md:124). The
collateral asset is determined *solely by which asset the group transfers*. So
an ALGO open sends a **payment**, not an axfer, and the app-call args are
unchanged.

**`decrease_or_close` and `submit_linked_order` DO take `collateralAssetId`**
(SPEC.md:142, :150). Closes and protected orders must pass the right one.

---

## 3. The UI change

In `FormSection` / `PerpsCard`, above the amount input, right-aligned:

```
  AMOUNT                                    [ ALGO | USDC ]
  ┌──────────────────────────────────────────────────────┐
  │ $ 0.00                                               │
  └──────────────────────────────────────────────────────┘
```

Same pill treatment as the existing `Market | Limit` and `Convert to USDC |
ALGO + USDC` toggles, so it reads as the site's own control.

Selecting ALGO changes: the input's unit prefix, `MAX`, the balance check, the
quote, the transfer leg, and the position the order resolves against. It is not
a display preference.

---

## 4. The audit — what breaks SILENTLY if this ships as-is

**This is the section that matters.** Our group assertion for opens reads the
collateral leg as:

```ts
const transfers = txns.filter((t) => t.assetTransfer);
const xfer = transfers[0]?.assetTransfer;
if (xfer) { /* asset, amount, receiver, no-note, AND leverage */ }
```

An ALGO collateral leg is a **payment**, not an `assetTransfer`. Two failure
modes, both silent:

**4a. With protection OFF — every check is skipped.** `transfers` is empty,
`xfer` is `undefined`, and the `if (xfer)` guard drops:

- collateral asset check
- collateral amount check
- receiver-is-the-pinned-trading-app check
- **the leverage check**, which SPEC.md:117 calls the whole point, because
  `sizeUsdDelta` is a free frontend integer and the transfer is the only thing
  binding it

The group would be signed having asserted nothing about the money.

**4b. With protection ON — the checks run against the WRONG transaction.** The
keeper-fee escrow is an axfer, so `transfers[0]` becomes the **keeper fee leg**.
The assertion then compares the keeper fee's asset and amount against the
displayed *collateral*, fails confusingly at best, and at worst passes if the
numbers happen to line up.

**4c. The leverage ratio is denominated in USDC.**

```ts
const argLev   = sizeUsdDeltaMicro / transferAmount;
const shownLev = shown.sizeUsdDeltaMicro / shown.collateralAmountMicro;
```

This is only a leverage because USDC is 1:1 with USD. With ALGO the transfer is
µALGO, so the ratio is USD-per-ALGO — off by the ALGO price, roughly **10.7× at
$0.0935**. The *contract* values ALGO collateral at the oracle price and is
fine; it is our assertion that would be meaningless.

**4d. The first proposed fix was also wrong — found on audit.**

The obvious repair is "select the leg by role: the one paying the pinned
trading address that is not the keeper-fee escrow." That does not disambiguate,
because the **storage variant already emits an un-noted payment to that same
address**:

```js
// buildV2OpenOrIncreaseTransactionParts, storage branch
makePaymentTxnWithSuggestedParamsFromObject({
  sender, receiver: getApplicationAddress(v2TradingAppId),
  amount: bigint(storagePaymentMicroAlgo), suggestedParams,   // no note
})
```

With ALGO collateral and storage, a group holds **two un-noted payments to the
trading app** — the storage funding and the collateral. Role is not enough.

Verified mechanism, for the record:

```js
// makeTokenTransferTxn
if (bigint(assetId) === BigInt(NATIVE_ALGO_ASSET_ID)) {
  return makePaymentTxnWithSuggestedParamsFromObject({ ... });  // payment, not axfer
}
```

**Required fix, ahead of the feature — DONE.** Two parts:

1. **Anchor the collateral leg to the open call, not to transaction type.** In
   both SDK variants the collateral is the transaction immediately before the
   `open_or_increase` call:

   ```
   no storage:   [maintenance…] collateral        open  carrier
   with storage: [maintenance…] storagePay  fund  collateral  open  carrier
   ```

   So it is `openCallIndex − 1` in both. That is a *relative* index anchored to
   a call we already locate by pinned selector — not an absolute position of
   the kind that broke the C-Vault group — and it is how the contract itself
   addresses the group. Assert it is a payment **or** an axfer, to the pinned
   trading address, matching the displayed asset and amount.

2. **Convert collateral to USD before dividing** in the leverage check, using
   the same oracle price the quote was built from — never a second price read,
   or the assertion drifts from the screen it is meant to be checking.
   **Not done, deliberately**: it cannot be verified without an ALGO group to
   test it against. Instead the assertion now REFUSES an ALGO collateral leg
   outright (`collateral_asset_unsupported`). The feature removes that refusal
   and brings the conversion and its tests together.

**What the old rule actually did, measured.** With an ALGO payment as
collateral the only remaining axfer is the keeper escrow, so
`filter(assetTransfer)[0]` selected the ESCROW and validated it against the
displayed collateral. It failed — but only because the escrow's amount
happened to differ. Had the keeper fee equalled the collateral, an ALGO group
would have passed every check with nothing about the real money examined.

Both are changes to `pex/group.ts` alone, testable against today's captured
fixtures with no UI involved.

---

## 5a. The read path — BUILT

What it turned out to touch, beyond the two hooks named in §5's table. Each of
these was a place where "one position per (market, side)" had been assumed
rather than stated, which is why the table under-counted:

| file | change |
|---|---|
| `pex/config.ts` | `POSITION_COLLATERAL_ASSETS` added; `COLLATERAL_ASSET_ID`'s comment corrected — it claimed to keep one position per (market, side), a property that was never PEX's |
| `pex/config.ts` | `assetName` moved here from `PositionsPanel`, now that two surfaces name the same ids |
| `usePerpsPositions` | 4 box reads → 8; `collateralAssetId` added to `OpenPosition` |
| `usePerpsOrders` | same widening — see the note below, this one is not cosmetic |
| `PositionsPanel` | React key, the chart-notify signature, a collateral badge on every row, and the payout sort |
| `PerpsView` | chart line labels |
| `perps/positionLines.ts` | new — the label rule, extracted so it could be tested |

**The orders hook was the dangerous one.** `analyzeV2OrderLifecycle` resolves
an order against the position set it is handed. An ALGO-collateral order read
against a USDC-only set resolves to nothing — which is the state SPEC.md
requires be displayed as *"Orphaned — funds still locked"*. So the narrow read
would not merely have hidden something; it would have told a user their healthy
protective order was orphaned.

**Three latent duplicate-identity bugs** were found by asking what stops being
unique, rather than by testing the feature:

1. The React key was `${marketId}-${side}` — two rows, one key.
2. The chart-notify signature was keyed the same way, so a second position in a
   market would have been collapsed out of the chart's line set.
3. `PerpsView` labelled lines by side alone. Its own comment said it existed to
   stop "two identical labels", and two longs would have reproduced exactly
   that.

The payout sort had a fourth, quieter version: it led with `COLLATERAL_ASSET_ID`
under a comment saying it led with "the asset the user deposited". On an
ALGO-collateral position those are different assets, so the comment described
behaviour the code had stopped having.

**A layout defect, found by rasterising.** The collateral badge pushed the net
figure past the card's right edge at 360px, and `<body>` carries
`overflow-x-hidden` — so the number was clipped away entirely, not merely
cramped. The header row now wraps. Caught only by rendering it; the row was
already near its limit before the badge.

**Tests.** `hooks/collateralReads.test.ts` asserts the actual arguments both
hooks pass to `readPosition`, so it cannot be satisfied by a comment mentioning
ALGO; `perps/positionLines.test.ts` is exhaustive over all 16 combinations of
positions in one market. Both were mutation-verified: narrowing either hook
back to USDC turns 3 tests red, and restoring the old label rule turns 3 more.

---

## 5b. The close and cancel write paths — BUILT

Found while starting the write path, not predicted by §4 or §5: **§5's table
listed `PositionsPanel` as needing a label, and missed that the panel also
CLOSES.** `collateralAssetId` is part of the `p2:` key, so in `closePosition`
it does not describe the close — it selects the box.

**What §5 also got wrong about the size of this.** It named "3 hardcoded
`keeperFeeAssetId` sites in `client.ts`". The real count is ~26 hardcoded
`COLLATERAL_ASSET_ID` uses across four functions: `openPositionInner` (11),
`openLimitOrderInner` (6), `cancelOrder` (3), `closePositionInner` (4). Only
the last two were reachable before the toggle exists.

### Measured exposure, 2026-11-03

Enumerated all `p2:` boxes on the trading app (33 boxes, 7 positions):

| | |
|---|---|
| USDC-collateral positions | 6 |
| ALGO-collateral positions | 1 ($20.02, market 1 long) |
| wallets holding BOTH collaterals in one (market, side) | **1** |

That one wallet is market 1 long, with `position_id` **125** (USDC, $1,805.50)
and **137** (ALGO, $20.02). Both post-cutover and distinct, so the existing
`position_id` guard catches the mismatch and the close fails closed.

**So the live impact was a broken button, not a wrong-position close:** an
ALGO position showed an enabled "Close position" that always threw "That
position has been replaced since the page loaded" — false, and about the one
thing a user most needs to trust.

**The dangerous variant is real in code and had no instance on chain.**
Pre-cutover positions all carry `position_id = 0` (SPEC.md:785), so a wallet
with an id-0 position under each collateral in one market and side passes
`0 !== 0` and reaches the builder against the wrong box, clamped to that
box's size. No such pair exists today. The fix does not rely on that staying
true.

### What changed

- `ClosePositionInput` and `CancelOrderInput` take the collateral explicitly;
  neither defaults to USDC.
- The close re-reads the box with the given key **and checks the box agrees**
  (`live.collateral_asset_id`). That is the only place the two can be
  compared, and it is what covers the id-0 case the `position_id` guard
  cannot see.
- Cancel takes `collateral_asset_id` and `keeper_fee_asset_id` straight off
  the order box. **This one was not introduced by §5a**: `readOrders`
  enumerates by owner, never by collateral, so an ALGO-collateral order has
  always been listed and always been cancellable with USDC hardcoded as the
  refund asset.
- The close spinner was keyed `${marketId}-${side}` — a sixth identity
  collision, putting "Closing…" on both same-side rows.

### Why no test caught it

`closeAssembly`, `closeReal` and `cancelAssert` all call the **assert**
functions directly, each passing `COLLATERAL_ASSET_ID` as a fixture. None
exercises `client.ts`, so the builder and the assertion were handed the same
wrong constant and agreed with each other. `closeCollateral.test.ts` now
covers the wiring; mutation-verified both ways.

---

## 5. Everything else that needs widening

| area | today | needed |
|---|---|---|
| `COLLATERAL_ASSET_ID` | one constant, USDC | per-order selection; the constant becomes a default |
| ~~`usePerpsPositions`~~ | ~~reads 2 boxes/market~~ | **DONE — §5a** |
| ~~`usePerpsOrders`~~ | ~~reads USDC orders~~ | **DONE — §5a** |
| ~~`PositionsPanel`~~ | ~~one row per (market, side)~~ | labels DONE §5a; the NUMBERS were not — see §5c |
| balance preflight | `amount + keeperFee` in USDC | ALGO path needs **spendable ALGO** (`amount − min-balance`), and still needs **USDC for the keeper fee** |
| min collateral | `$5` compared to a USDC figure | convert µALGO at the oracle price before comparing |
| `MAX` control | `balance − Σ keeperFee` | for ALGO, also reserve min-balance **and** group fees |

**The keeper fee is the awkward one.** SPEC.md:278 — every position escrows the
keeper fee in USDC alongside collateral. So an ALGO-collateral position with
protection still requires a USDC balance. Either `keeperFeeAssetId` can be set
to ALGO (unverified — `submit_linked_order` takes the field, so possibly), or
protection must be disabled for ALGO-collateral orders with the reason stated
in the UI. **Settle this before building the toggle**, because it decides
whether the pill disables Protection.

---

## 6. Open questions

1. ~~**Can `keeperFeeAssetId` be ALGO?**~~ **Answered: it already follows the
   collateral.** `quote.ts:810` sets `keeperFeeAssetId: BigInt(input.collateralAssetId)`
   and `group.ts:2060` asserts it equals the displayed collateral. So Protection
   does NOT need disabling for ALGO, and the pill does not gate it. Worth one
   MainNet simulate to confirm the contract accepts an ALGO keeper fee before
   the write path ships — the SDK offering the field is not proof the app
   honours it.
2. **Does PEX's liquidation engine treat ALGO-collateral positions
   differently?** Correlated collateral liquidates earlier (a long with ALGO
   collateral is hit twice when ALGO falls). We should warn on that combination
   — see §7.
3. **Does `decrease_or_close` need the position's original collateral asset,
   or the one being withdrawn?** Reading the arg list suggests the former;
   confirm before building the close path.

---

## 7. A warning the UI should carry

Long + ALGO collateral is the dangerous quadrant: the position and the
collateral lose value together, so liquidation arrives earlier than the same
leverage in USDC. Modelled at 3× with a 5% maintenance margin:

| collateral | liquidates at |
|---|---|
| USDC | ALGO **−29.8%** |
| ALGO | ALGO **−22.1%** |

Short + ALGO collateral is the opposite and is a legitimate delta-neutral
construction. The toggle should say which is which rather than presenting them
as equivalent — one line beneath the pill when the risky combination is
selected.

---

## 8. Test plan

1. `pex/group.ts` — the collateral leg is found by role, against the existing
   captured fixtures, **with and without** a keeper-fee escrow present.
2. A mutation that swaps the collateral leg for the keeper-fee leg must fail
   the assertion. This is the bug 4b would have shipped.
2b. A mutation that swaps the collateral leg for the **storage payment** must
   also fail — same receiver, no note, and the reason the role-based fix in 4d
   was discarded.
3. Leverage assertion with ALGO collateral: an ALGO amount at a known oracle
   price must produce the displayed leverage, and a 1% price error must fail.
4. Positions: a wallet holding ALGO-long and USDC-long in the same market shows
   both, labelled.
5. Balance preflight: ALGO path reserves min-balance and group fees; a MAX
   deposit must not leave the wallet unable to pay fees.
6. One MainNet simulate per path before any signature, per the usual rule.

---

## 9. Recommendation on sequencing

Land §4 first, on its own, as a correctness fix to the assertion that is
independently verifiable against today's fixtures. Then the toggle. Shipping
them together means the test that proves the assertion works is the same change
that first exercises it, and a mistake in either hides the other.


---

## 5c. What three independent reviews found — 2026-11-03

§5a and §5b were both audited by three fresh reviewers with no context from
the work. They found real defects in it. Recorded here because the pattern
matters more than the individual bugs: **every one was the same conflation the
change set existed to remove, surviving in places the author did not think to
look.**

### Live defects, now fixed

| # | Where | What a user saw |
|---|---|---|
| 1 | `PositionsPanel` collateral/leverage/net | `collateral_amount / 1e6` with a "$". The live ALGO position read **"$210.87"** against a real $20.21, leverage **0.095×** instead of 0.99×, and a large false loss |
| 2 | `quote.ts valueCloseOutputs` | The `collateralAssetId` branch came FIRST and added `amount / 1e6` — a flat **$1 per unit** — short-circuiting the ALGO branch below it. `payoutUsd` ~10× too large |
| 3 | `quote.ts shape()` × 7 fields | `platform_fee_amount`, `builder_fee_paid`, `funding_fee_collateral_amount`, `borrowing_fee_collateral_amount`, `collateral_funding_net_amount` are `tokenAmountFromUsd(..., collateralPrice)` in the SDK (v2Quotes.js:1562, 1987) — collateral units, read as USD. The author had converted only `netCollateralUsd` |
| 4 | order rows | stake and keeper fee printed as dollars regardless of `collateral_asset_id` / `keeper_fee_asset_id` |

### The guard that did nothing

§5b's close check compared `live.collateral_asset_id` against the
`collateralAssetId` used to READ `live`. The box is keyed by that asset, so it
always agrees: a **tautology**, and the test only passed because the mock
returned a box that cannot exist under that key. It now compares against the
`position` object the CALLER passed, which is the mismatch that can really
happen (row A's position with row B's asset).

### The tests did not test what the commits claimed

One reviewer mutated the source 11 ways. **10 survived all 937 tests**,
including `collateralAmount: micro(collateralUsd)` — the 10.4× bug in the
number that actually gets signed.

Cause: `openCollateral.test.ts` stubbed `quoteOpen` to return `ok: false`, so
execution stopped at the probe and never reached `openInput`, `shownOpen` or
`assertOpenGroup`. Its "asset units" test only inspected the arguments to its
own mock. `closeCollateral.test.ts` covered the box read and the refusal, but
its header claimed to cover the builder/assertion wiring, which it did not.

**So "mutation-verified both ways" in those commit messages was true only of
the two mutations the author personally tried.** The suite now reaches the
builder and pins that the builder and the assertion receive the same numbers;
the previously-surviving mutation fails with `expected 9582200n to be
100000000n`.

### Corrections to this document

- **§4c is misleading.** It says the leverage assertion is "wrong by the ALGO
  price". It is not — it is a **tautology**: `argLev` and `shownLev` are
  implied by the earlier `transfer_amount` and `size_usd_delta` checks, so both
  sides use the same number and it passes rather than misfires, for USDC as
  well. The §8 test plan's "a 1% price error must fail" **cannot** fail as
  written. A real check must bind the group to the DISPLAYED USD leverage using
  the price from the signed oracle message in the group, not a caller-supplied
  one.
- The "10.7×" in `collateral.ts` came from $0.0935 while its test fixture uses
  $0.0958 (10.44×). Both are real prices from different moments; the figures
  should not be quoted as one constant.

### Known, not fixed: ALGO positions cannot be closed from the terminal

`group.ts`'s `foreign_asset` check admits only the collateral asset plus the
yield-recall set. A close on market 1 references USDC as the pool's short
asset, so **every ALGO close fails the safety check** with "txn 0 references
asset 31566704" — after the preflights, before any signature. Nothing moves.

The Close button is now **disabled** for ALGO-collateral positions with that
stated, rather than offering a control that always ends in a cryptic error.
Lifting it means widening a fund-safety assertion to the market's own
long/short/index assets, which deserves its own change and its own review.

Same cause: a cancel of an order whose collateral and keeper-fee assets differ
also fails `foreign_asset`. Our own UI never builds one.

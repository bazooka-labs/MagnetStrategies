# Trading Terminal — ALGO collateral

**Status: §4 and the READ PATH are built. The toggle and the write path are
not.** Written 2026-11-03.

- §4 (group assertion) landed on its own, verifiable against today's USDC
  fixtures — see `pex/collateralLeg.test.ts`.
- The read path landed next: both hooks now enumerate both collaterals, and
  the UI labels and distinguishes them. See §5a.
- Everything else from §5 onward remains spec.

The read path went first deliberately, and **not** because it was easy. It is
correct on its own merits regardless of whether the toggle ever ships: ALGO
collateral is live on PEX today, so a holder who opened one on PEX's own front
end was seeing NOTHING of it in our terminal. That is a reporting bug against
real money, independent of what our own UI offers.

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
| ~~`PositionsPanel`~~ | ~~one row per (market, side)~~ | **DONE — §5a** |
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

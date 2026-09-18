
  **Asset movements — every transfer, by `(asset, amount, receiver)`:**
  - The collateral axfer: expected asset, **expected amount**, receiver `getApplicationAddress(PINNED_TRADING_APP_ID)`
  - The take-profit keeper-fee escrow: `v2OrderEscrowAmount` returns `keeperFeeAmount` verbatim for decrease kinds (`src/transactions.ts:6288-6295`, `6390-6396`) and **the SDK validates it nowhere**. Unbound, a compromised frontend escrows the wallet's entire USDC balance to a legitimately pinned address, and no ABI check sees it. Bound it by a build-time constant multiple of the displayed keeper fee.
  - Every storage/MBR payment, against pinned constants

  **`open_or_increase` args** — the real tuple is `[marketId, side, sizeUsdDelta, acceptablePrice, [builderAddress, builderFeeBps], oracleMessage, oracleSignature]` (`src/transactions.ts:1310-1322`). There is no `collateralAssetId` and no `outputSwapMode` on this call:
  - `sizeUsdDelta / collateralAmount` equals the **displayed leverage** — not merely that it falls within the band
  - `marketId`, `side`
  - `builderAddress == BUILDER_ADDRESS` and `builderFeeBps == POSITION_BUILDER_FEE_BPS` (assert **equality**, per Invariant 7 — `<= 10` catches nothing, since `normalizeBuilderFee` already throws above the cap at `src/transactions.ts:6482-6484`)
  - `|acceptablePrice − displayedIndexPrice| / displayedIndexPrice <= userSlippageBps` (the SDK validates only that it is a positive Price12 — there is no upper bound on looseness)

  **`decrease_or_close` args** — `[marketId, collateralAssetId, side, sizeUsdDelta, acceptablePrice, outputSwapMode, minPrimary, minSecondary, [builderAddress, builderFeeBps], oracleMessage, oracleSignature, yieldRecallMode, maxLongReceiptAmount, maxShortReceiptAmount]` (`src/transactions.ts:1409-1424`). **There is no collateral transfer on this path, so the leverage ratio is undefined and `sizeUsdDelta` has no binding check unless asserted directly:**
  - `sizeUsdDelta` equals the displayed close size exactly — and `== position_size_usd` for a full close. Without this, a compromised frontend shows "close my Cover" and sends a partial decrease: the user believes they are out, they are still exposed, and their take profit is now permanently unexecutable via `reduce_size_exceeds_position`
  - `outputSwapMode == 0`, and `minPrimary == minSecondary == 0` given mode 0
  - `yieldRecallMode`, `maxLongReceiptAmount`, `maxShortReceiptAmount` against the values from `prepareV2DecreaseOrCloseInput`

  **Group-wide:** no `rekeyTo`, no `closeRemainderTo`, no `assetCloseTo` on any transaction; total fee below a cap; and every transaction is either an enumerated economic leg or an app call to a **pinned** PEX app ID with a **pinned** selector, sender == user. (A fixed transaction count is not assertable — settlement-maintenance calls, the trading resource carrier, yield-freshness carriers and the `builderFeeBps > 0n` dynamic-OI carrier all vary with pool state.)
# Cover — Product Definition and Architecture Spec

Cover is a simplified product surface over PEX perpetual positions. A user buys a number of fixed-size units, chooses how aggressively to size them, optionally sets a profit target and a reminder duration, and signs one transaction. No chart, no order book, no trading vocabulary.

**Product name is not final.** "Cover" is the working name for both the product and its unit. It was chosen over "contract" deliberately: *contract* plus a payout table is the vocabulary of a derivatives offering and is not worth borrowing.

**Status:** Design stage. Nothing is built or deployed.

Read [OVERVIEW.md](./OVERVIEW.md) first for PEX platform facts, verified constants, and the integration paths that were rejected.

---

## The Central Architectural Fact

**Cover requires no smart contract of our own.**

Every economic action is a PEX call signed by the user's wallet:

| Action | Mechanism | Who executes |
|---|---|---|
| Open a Cover | `buildV2OpenOrIncreaseCall` | User's wallet |
| Attach profit target | `DECREASE_TAKE_PROFIT` bracket, same group | User's wallet |
| Close early | `buildV2DecreaseOrCloseCall` | User's wallet |
| Profit target fires | PEX stored order | PEX keeper network |
| Liquidation | PEX permissionless liquidation | Any third party |
| ADL | PEX pool-solvency backstop | PEX keeper |

We write no TEAL, hold no funds, hold no admin key over user positions, and have no pause authority. Our attack surface is **what our frontend constructs and what our interface claims**, not what a contract of ours can be made to do.

**This does not mean there is no path to user fund loss.** An adversarial review of an earlier draft found that "no contract of ours" removes one class of risk and leaves custody-*equivalent* authority intact, because two things Magnet Strategies controls still determine where user money goes:

- **the application and asset IDs served by our backend**, which the collateral transfer's destination is derived from, and
- **the ABI arguments our frontend puts in the group**, which determine leverage and slippage.

Neither is an asset movement, so neither is caught by asset-movement checks. Both are addressed below — see [CRITICAL: The Backend Supplies Fund Destinations](#critical-the-backend-supplies-fund-destinations) and the full-group assertion in the [Threat Model](#threat-model).

The exploitable questions are therefore:

1. Can our **backend** cause funds to be sent somewhere other than PEX?
2. Can our **frontend** construct a group whose ABI arguments differ from what the user was shown?
3. Can our displayed numbers mislead a user into a position they did not intend?
4. Does any optional component grant us authority over user funds, and what is the blast radius when it is compromised?

---

## Threat Model

| Actor | Can do | Cannot do |
|---|---|---|
| Magnet Strategies (honest) | Construct transaction groups, set builder fee, display quotes | Move user funds, open or close positions, alter PEX state |
| Magnet Strategies (compromised frontend) | Construct a *malicious* group and present it for signature | Bypass the wallet's signature prompt |
| **Magnet Strategies backend (compromised, MITM'd, or cache-poisoned)** | **Supply attacker app/asset IDs (fund destinations), poison the ABI spec used to encode *and* verify args, poison box decoding so every displayed quote and liquidation price is wrong** | Forge an on-chain-valid oracle signature |
| PEX protocol | Everything within its own contracts, including ADL | — |
| PEX oracle signer | Set the price range all execution derives from | — |
| PEX keeper network | Execute stored orders, liquidate, ADL | Open positions on a user's behalf |
| PEX admin / governance | Change every risk parameter including `maintenance_margin_bps`, `liquidation_fee_bps`, `close_fee_bps`, `max_pnl_factor_for_traders_bps`; pause markets; upgrade `PDexV2Trading` | — |

*This row documents **capability**, not expectation. Magnet Strategies assumes Ultrade operates in good faith and changes parameters with notice; see [Residual Trust](#residual-trust). A threat model that omits a dependency's powers because the dependency is trusted is decorative.*
| Third-party liquidator | Liquidate any position below maintenance | Liquidate a healthy position |
| Network observer | Read every position, order, fee and builder address on-chain | — |

**The dominant risk is a compromised or buggy frontend presenting a harmful group to a user who trusts the brand and signs without reading.** Algorand wallets display group contents, but users do not reliably read them. This is the same trust posture as every non-custodial dApp, and it is not eliminated by having no contract — it is merely the only risk left.

**Mitigations required:**

- Transaction group construction goes through a single audited module. No ad-hoc group assembly in UI components.
- Every group is simulated (`simulate_transactions`) before presentation. **Simulation is a pre-flight failure detector, not a security control** — a 20× open simulates perfectly, and a compromised frontend controls the simulation call, the comparison, and the rendering. The only genuine trust boundary is the wallet, which renders ABI args as opaque bytes.
- **A full-group assertion runs immediately before the signature prompt** — not merely an asset-movement check. **Be honest about what this is:** a compromised frontend controls the assertion code, the comparison, and the confirm screen, exactly as it controls simulation. The assertion is defence-in-depth against construction *bugs* and against compromise confined to the group-building path — **not** a defence against the full frontend compromise this table names as the dominant risk. Controls that actually raise that bar are reproducible builds with published hashes, subresource integrity, a pinned deployment bundle, and pushing Ultrade for wallet-side ARC-aware rendering of PEX calls. Those belong in [Build Order](#build-order), not only in prose. Asset movements are not sufficient: `open_or_increase` takes **no collateral argument** (`src/transactions.ts:1310-1318`), so leverage is `sizeUsdDelta ÷ transfer amount` and `sizeUsdDelta` is a free frontend integer. A frontend showing "Low, 5×" can send 20× while the transfer remains exactly $50 of the right asset to the right place. The assertion must decode every app call's ABI args against the manifest and verify each equals what the confirm screen displayed:
  - `sizeUsdDelta / collateralAmount` equals the **displayed leverage** — not merely that it falls within the band
  - `side`, `marketId`, `collateralAssetId`, `outputSwapMode == 0`
  - `builderAddress == BUILDER_ADDRESS` and `builderFeeBps <= 10`
  - `|acceptablePrice − displayedIndexPrice| / displayedIndexPrice <= userSlippageBps` (the SDK validates only that it is a positive Price12 — there is no upper bound on looseness)
  - Group-wide: no `rekeyTo`, no `closeRemainderTo`, no `assetCloseTo`, total fee below a cap, and no transaction sent by the user beyond those enumerated
- Builder address is a build-time constant, not a runtime value from any API response.
- **All PEX application IDs and asset IDs are build-time constants.** See [Critical: pinned deployment](#critical-the-backend-supplies-fund-destinations).

---

## CRITICAL: The Backend Supplies Fund Destinations

**The claim that a read-only backend cannot cause fund loss is false, and it was the most consequential error in an earlier draft of this document.**

The SDK obtains every PEX application ID and asset ID from the backend (`loadPdexContext` → `resolvePdexV2AppRefs`). The collateral transfer's destination is then *derived* from one of them: `makeTokenTransferTxn(sender, getApplicationAddress(input.v2TradingAppId), ...)` (`src/transactions.ts:6212`, `6301`).

An attacker who compromises, MITMs, or cache-poisons the read backend returns an attacker-controlled app ID. The frontend builds a group the wallet renders as a normal transfer to an application address. Simulation succeeds — the attacker's app accepts the transfer. And the asset-movement assertion **passes**, because it checks against `getApplicationAddress(v2TradingAppId)` derived from the same poisoned source. `loadDeploymentManifestFromUrl` (`src/manifest.ts:56-63`) performs no signature check, no pinning, and no version assertion.

Impact: total loss of collateral for every open initiated during the compromise window, with no frontend compromise required.

**Required:**

- Pin `PDexV2Trading`, `PDexV2Markets`, `PDexV2OrderOps`, `PDexV2TradingRiskOps`, `PDexV2Math` and the ALGO/USDC asset IDs as **build-time constants**, alongside `BUILDER_ADDRESS`.
- Treat the deployment manifest as **advisory**: fetch it, assert every ID equals its pinned constant. A PEX redeploy must require an MS release, never a JSON edit.
- **Degrade in two states, not one.** A redeploy does not migrate existing positions — they stay in the *old* app, which is the one we pinned. A blanket hard-fail would strand every open position at the moment the protocol is in flux. So on mismatch: **block all opens and increases**, and **keep close, partial close, add-collateral and cancel-order live against the pinned IDs**, with a banner. Whether PEX migrates state on redeploy is an [Open Question](#open-questions).
- **Pin the ABI, not just the IDs.** This is the half an earlier draft missed. ABI *encoding* does not use pinned constants: `buildAppCall` calls `encodeAppArgs(appName, methodName, args, manifest)`, and `method.signature` and each `args[].type` come from the **protocol manifest** fetched by `loadManifestFromUrl` → `GET /v2/protocol` (`src/manifest.ts:32-41`) — also unsigned, unpinned, unversioned. An attacker controlling that manifest controls the encoder *and* the decoder, so the full-group assertion round-trips through a poisoned spec and passes while the bytes mean something else to the real app. The same manifest decodes `mp2:`/`mo2:`/`mf2:`/`ma2:`, so every displayed quote, liquidation price and buffer is simultaneously theirs.
  **Required:** embed the `signature` string and arg type list for `open_or_increase`, `decrease_or_close`, `submit_linked_order` and `cancel_order` as build-time constants, derive selectors locally, and hard-fail if the fetched manifest disagrees. At minimum pin a SHA-256 of the whole protocol manifest.
- **Pin the oracle signer public key as a build-time constant**, verified out-of-band with Ultrade. `oraclePayloadFromBackend` copies `pubkey` straight out of `payload.pubkey_hex` (`src/oracle.ts:150-170`) and `verifyOraclePayload` verifies against whatever it is handed — checking that a message signed itself. Note there is **no SDK path to read the signer key from chain**, so "read it from on-chain state" is not implementable today; see [Open Questions](#open-questions).
  Additionally assert, on every payload decoded via `decodeV2OracleSnapshotMessage`: `targetAppId == PINNED_TRADING_APP_ID`, `genesisHash == mainnet`, `magic == PDX2`, `messageVersion == 3`, and `publishedAt` within `ORACLE_MAX_AGE_SEC`.
- **Pin every app the SDK resolves**, not just the trading path: `PDexV2AdminControl`, `PDexV2AdminOps`, `PDexV2SwapOps`, `PDexV2SingleTokenOps`, `PDexV2SingleTokenTrading`, `PDexV2CvaVault`, `PDexV2MarketYieldVault`, `PDexV2MarketXAlgoYieldVault` — `resolvePdexV2AppRefs` reads them all from the same backend map (`src/integration.ts:90-104`) and several appear in `foreignApps`.

---

## Operating Model

Magnet Strategies operates:

- **The frontend.** Route `web/src/app/hedge/perps/`, inside the existing app and connect-wallet flow.
- **A read backend.** Required for the PEX protocol manifest (`GET /v2/protocol`) and for decoding market boxes. This is the one unavoidable server dependency.
- **A notification service.** Duration reminders and ADL alerts. No authority over funds.
- **No keeper with signing authority** in v1. See [Duration](#duration-the-hard-problem).

Magnet Strategies does **not** operate: the exchange, the price oracle, the liquidation network, or the order-execution keepers. All four are PEX.

---

## Constants

PEX-side constants are listed in [OVERVIEW.md](./OVERVIEW.md#verified-parameters) and are **TestNet values**. MainNet risk configuration is undocumented and must be read live. Nothing in this spec may hardcode a PEX risk parameter.

Cover-side constants:

| Constant | Value | Notes |
|---|---|---|
| `COVER_UNIT_USD` | 10 | Collateral committed per unit |
| `COVER_MIN_UNITS` | 1 | $10 ≥ PEX $5 minimums at every band |
| `MAX_POSITION_NOTIONAL_USD` | 1,500 | **The cap is on resulting merged position notional, not on a purchase.** Evaluated identically in the purchase flow and the increase flow. *(An earlier draft capped units per band, which bound a single purchase and was bypassed by the increase flow — positions merge — while also delivering rising notional across bands, $1,250 → $1,500 → $2,000, the opposite of its own stated rationale.)* |
| `MAX_UNITS_PER_PURCHASE` | 25 | UI convenience only; the notional cap is the binding control |
| `BAND_LOW` | 5× fixed | |
| `BAND_MODERATE` | 10× fixed | |
| `BAND_AGGRESSIVE` | `min(maxAvailable, BAND_AGGRESSIVE_CEILING)` | |
| `BAND_AGGRESSIVE_CEILING` | 20× | **Required.** MainNet max leverage is undocumented; without a ceiling the product makes an open-ended commitment to a number we do not know, and every buffer figure in this document assumes 20×. Revisit after step-2 measurement. |

> `MAX_POSITION_NOTIONAL_USD` is a **product guardrail with no on-chain enforcement** — a user can always go to PEX directly. It is not counted as a security control.
| `BUILDER_ADDRESS` | MS treasury | Build-time constant |
| `POSITION_BUILDER_FEE_BPS` | ≤ 10 | Protocol cap is 10 |
| `SWAP_BUILDER_FEE_BPS` | **0** for forced conversions | See [Revenue](#revenue) |
| `DEFAULT_SLIPPAGE_BPS` | 50 | User-adjustable, disclosed |
| `ORACLE_MAX_AGE_SEC` | 20 | Reject quotes on payloads older than this. A deliberate conservative pin against PEX's ~30s window — the one place Invariant 8's no-hardcoding rule is knowingly relaxed, because erring short is safe. **Specify a re-fetch/re-quote loop**: hardware-wallet and mobile deep-link signing round trips routinely exceed 20s, and blocking at the prompt would fail for a meaningful share of users. |

---

## Product Model

### Units

A Cover is **$10 of committed collateral**. The user buys N of them. Committed capital is `N × 10` USD and is the user's maximum loss.

> **Units are a purchase-sizing device, not independent positions.** The position box key is `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner` — there is **one position per (market, collateral asset, side, wallet)**. Buying more on the same side is `open_or_increase` on the existing position: blended entry price, blended leverage, and **a changed liquidation price on what the user already held**.

Consequences, all of which the product must respect rather than paper over:

- **One open Cover per (market, side) per wallet.** Quantity is chosen at purchase.
- **Adding is a separate, explicit flow** on the management surface — never a second trip through the purchase screen. One code path for every merge.
- **Route at entry, not at confirm.** Check for an existing position at the target key **before rendering any purchase input**. Routing at confirm would mean the user configures "10 units, Aggressive, closes if ALGO rises 2.5%", then signs an increase producing a blended leverage, blended entry and a new liquidation price matching nothing they were shown — the exact harm the group assertion exists to prevent, arriving through an intended code path. On routing, discard all purchase-screen state and re-derive every figure from live position state. A group containing `open_or_increase` against a non-empty `p2:` box may only be presented from the increase flow.
- **One take profit per position, and no stop loss at all.** Multiple TPs accumulate against `pendingTpSizeUsd` and child order IDs are hardcoded `base+1` / `base+2`, so overlapping brackets collide. Per-unit targets are not expressible.
- **Per-unit duration is fiction.** "Close 3 of my 5" is a partial decrease of one merged position with no on-chain referent for which unit closed.
- **Partial closes can be rejected**, when the remainder would fall below `min_collateral_usd` ($5 on TestNet) or would leave the position liquidatable (`position_health_breach`).
- Per-unit P&L may be shown as contribution-weighted tracking derived from live position state, but the UI must never imply separate liquidation, because there is none.

### Aggressiveness bands

Three bands. Low and Moderate are **fixed multiples**. Aggressive is **whatever the maximum available leverage is** for that position size at that moment.

| Band | Leverage | Approx. buffer | Notional per unit |
|---|---|---|---|
| Low | 5× fixed | ~17.5% | $50 |
| Moderate | 10× fixed | ~7.5% | $100 |
| Aggressive | max available | ~2.5% at 20× | up to $200 |

Fixed multiples mean Low and Moderate are deterministic: the same tap gives the same risk every time. Only the band named Aggressive maximises, which is what the word means.

**Buffer figures above are indicative only.** `1/leverage − maintenance_margin_rate` is *not* the user-facing number: open fees and the builder fee are deducted from collateral before the position opens (see [Revenue](#revenue)), so the real buffer is tighter. **Display the SDK's `liquidation_price_estimate` from a live quote, never a formula.**

**Aggressive's resolved leverage and buffer must be displayed before signature.** It floats with capacity by design — 20× normally, less when open interest nears the per-side cap:

> Aggressive → **20×** → closes if ALGO rises **2.5%**

**At 20× the buffer is thin enough to state plainly.** Liquidation on a ~2.5% adverse move gross, **~2.3% after fees** (fees consume roughly 13% of the margin buffer, assuming the builder fee on both legs) — inside ordinary daily movement for ALGO. The band is offered because it was asked for; the disclosure is not optional.

**When capacity constrains the market, never present a band under a label its resolved leverage does not warrant.** Fixed bands cannot deliver a multiple above the current ceiling, so:

| Max available | Offer |
|---|---|
| ≥ 10× | Low 5× · Moderate 10× · Aggressive `min(max, 20×)` |
| 5× to <10× | Low 5× · Aggressive `max` · Moderate greyed out |
| < 5× | **Low, capacity-limited to N×** — and Aggressive disabled |

That last row is the one to get right. With a naive rule the only selectable band at a 4× ceiling would be the one labelled **Aggressive**, delivering 4× — the safest leverage in the product, under the most alarming name, at exactly the moment a drawdown has every user reaching for the same side. A fixed band never silently delivers a different multiple than its label, and no band is ever offered under a name that overstates its risk.

### Direction

`Protect against a drop` (short) and `Protect against a rise` (long). Presented as outcomes, not as sides.

### Duration

`24 hours · 72 hours · 1 week · Until I close`. **In v1 this sets a reminder, not an enforced close.** See below — the wording constraint is a correctness requirement, not a copy preference.

### Take profit — mandatory, one per position

**Every Cover carries exactly one take-profit order. There is no stop loss.**

The take profit is a native PEX order kind (`DECREASE_TAKE_PROFIT`), stored on-chain in an order box and executed by **PEX's own keeper network**. It needs no keeper of ours and grants us no authority.

**Set by ALGO price, not by percentage.** `trigger_price` is a price in the protocol, so setting it directly removes a conversion step — and every conversion is somewhere a display bug can hide. It also matches how people actually hold targets ("take profit if ALGO hits $0.12").

> **Validate the direction.** The profitable side flips with position side: protecting against a *drop* puts the target **below** current price; protecting against a *rise* puts it **above**. A target on the losing side will never fire. PEX rejects these with `bad_order_price` (`V2_ORDER_BAD_PRICE_REASON`), but catch it client-side before the signature, and show the target relative to entry so the profitable direction is visually obvious.

**Pre-fill a default target.** A mandatory empty field is friction at the exact moment the product promises three taps. Pre-fill a sensible price and let the user adjust.

**Why no stop loss.** Simplicity is the product. Hedge is meant to read as a product, not a trade screen, and a forced profit target guides users to realise gains at a point they chose. Active downside management stays with the user — manual close is always available on the management surface.

**The accepted trade-off, stated plainly:** without a stop, **liquidation is the only automated downside exit.** At the Aggressive band that means a ~2.3% adverse move ends the position. Liquidation also costs the user the liquidation fee (up to 0.70% of position size) on top of the loss, where a stop inside the buffer would have returned more and returned it sooner. This is a deliberate product decision, not an oversight — but it makes the **displayed liquidation price a safety-critical element**, not a detail.

**Cost — three separate components, do not conflate them:**

| Component | Source | Amount |
|---|---|---|
| Order box MBR | pinned constant, exact | 96,500 µALGO |
| Group flat fees | `required_group_flat_fee_microalgos` (µALGO **flat fee only** — it contains no MBR) | varies with carriers |
| Keeper fee escrow | `keeperFeeAmount`, denominated in **the collateral asset**, not µALGO | ≥ $0.05 |

The 100,200 µALGO execution escrow applies to `OPEN_LIMIT` only, never to decrease kinds (`src/transactions.ts:6277-6281`).

**All-in for open plus one take profit: ~0.40 ALGO** — order box 96,500 + position box 70,900 + trader box 29,300 + trading flat fee 29,000 + OrderOps flat fee ~14,000 + per-transaction minimums across the group. *(An earlier draft cited 0.193 ALGO, which is the two-order-box figure in a design that no longer has two orders, compared against an all-in precheck. Under-prechecking causes the failure this document calls the most common one.)*

**Benefits of exactly one bracket** — deterministic group size (each bracket is four transactions against a 16-transaction ceiling), no child-order-ID collision (`base+1` / `base+2`), and half the orphan surface below.

**Not guaranteed.** The trigger arms when the *oracle* crosses the level; a keeper then executes and can fill worse in a fast move. Oracle updates are discrete ~30s snapshots, not continuous.

### Orphaned take-profit orders

**A take profit that fires is consumed cleanly. A position closed any other way leaves it resting** — and GTC orders can only be cancelled by the owner. Three of four exit paths orphan the order:

| Exit | Orphan? |
|---|---|
| Take profit fires | No — consumed |
| Liquidation | **Yes** |
| ADL (full close) | **Yes** |
| Manual close | **Yes**, unless we cancel in the same flow |

`planV2CancelRelatedReduceOrders` emits `related_reduce_orders_require_owner_cancel` and returns *separate* groups the owner must sign (`src/orders.ts:286-308`); `planV2CloseWithOrderCleanup` emits `related_order_cancels_require_followup_group` when close + cancel exceeds 16 (`src/orders.ts:311-347`).

**Two requirements:**

1. **Every manual close builds the cancel group.** An unsigned follow-up is a blocking alarm state, the same posture as "position open, bracket not placed."
2. **Before every open, read live `o2:` boxes for the target position key and refuse to open while any reduce order exists against it.** This is not optional hygiene. The position key carries **no nonce**, so an orphan's `position_missing` blocker *clears* when the user opens a new Cover on the same market and side — and PEX's keepers will then fire a stale target, at the old price, against a position the user never set it for.

Orphaned orders and their locked MBR are surfaced in [Hedge History](#hedge-history) with one-tap reclaim.

### Worked example

5 Covers, Moderate, protect against a drop, TestNet params, ALGO at $0.0866:

```
committed          $50
leverage           10×      (Moderate — fixed multiple)
notional           $500
liquidation buffer ~7.5%    (ALGO rising ~7.5% ends the position)
```

Illustrative payoff, net of fees. **These figures are computed by the SDK against live state, never by us, and never hardcoded:**

| ALGO moves | User receives |
|---|---|
| −20% | ~$148 |
| −10% | ~$98 |
| −5% | ~$73 |
| +7.5% | $0 — position closed |

---

## Two Surfaces

Cover has two distinct UIs, and the split is what lets the entry flow stay simple without hiding the protocol's real complexity.

**Surface 1 — Purchase.** Units, band, direction, duration, confirm. Outcome-framed, no chart, no jargon. Used only for opening a *new* position.

**Surface 2 — Position management.** Once a position is live, the UI becomes position-shaped rather than unit-shaped. This is the honest frame: the user now holds one position, not N discrete Covers, and pretending otherwise is what [Units](#units) warns against. The metaphor shift must be **visible** — a one-time explanation on first transition, not a silent swap.

Available on Surface 2:

| Action | Notes |
|---|---|
| Add to position | **The most heavily disclosed action in the product.** Must show before/after liquidation price and buffer, because adding moves the existing position's liquidation price. |
| Add collateral | De-risking: lowers effective leverage and widens the buffer without resizing. Given Aggressive ships with a ~2.3% post-fee buffer, a one-tap "widen my buffer" is a real safety win. Surface it prominently. |
| Partial close | Subject to the min-collateral and post-close-health rejections above. |
| Adjust / cancel the take profit | One per position. Cancelling leaves the position with no automated exit — say so |
| Close | |

**Four things must appear on the primary post-trade view regardless of how minimal it is**, because they are safety-critical rather than advanced:

1. **Liquidation price**, always visible
2. **Bracket state as armed / stale / unexecutable**, from the SDK's `executable` and `executionBlockers` — never a static "protected" badge
3. **ADL notification** when it fires
4. **Accrued holding cost**, since no clock bounds it

A user who never opens the advanced surface must still learn that they are at risk.

**Guard:** Surface 2 stays outcome-framed. More outcomes available, not more jargon exposed. The moment it reads as a trading terminal, the product has lost the thing that made it worth building.

---

## Outcomes, Notifications and Hedge History

### The five outcomes are not interchangeable

A position can end five ways, and **they mean entirely different things to the user.** Copy must distinguish them.

| Outcome | What the user is told | Notify? |
|---|---|---|
| Take profit fired | Your target was reached | **Yes** |
| Liquidated | ALGO moved against you past your buffer | **Yes** |
| ADL | **PEX closed your position early because it was winning** | **Yes** |
| Closed manually | — user did it, they know | No |
| Partially reduced by ADL | Your position was cut back; your target no longer covers it | **Yes** |

> **Never render ADL as liquidation.** ADL fires on *profitable* positions when the pool's obligations to winning traders exceed its safety threshold. Telling a user who was right that they were "liquidated" is false, and it is the single most damaging copy error available in this product. ADL needs its own explanation, because the user did nothing wrong and could have done nothing differently.

### Show the amount returned, not just the event

Liquidation does **not** zero the user out. It fires while equity is still approximately the maintenance margin; the liquidation fee is deducted and the residual returns to the owner, with the builder fee forced to zero. On a $10 unit at 20× that is roughly **$3.50 back**.

A screen that says "liquidated" while the user assumes total loss — with $3.50 sitting in their wallet — is a support ticket we built ourselves. Every close notification states what was returned.

### Hedge History

A permanent per-wallet record, and the backstop for any notification the user missed. Per position:

| Field |
|---|
| Date opened / closed |
| Units, band, resolved leverage |
| Direction |
| Entry price / exit price |
| **Outcome** (one of the five above) |
| **Amount paid** — collateral committed |
| **Amount returned** |
| Net |
| Fees, itemised — PEX open/close, builder fee, keeper fee |
| Reclaimable MBR from any orphaned take profit, with one-tap recovery |

**Reconstructed from chain, not from our storage.** PEX emits receipts (`src/receipts.ts`, `decodeReceiptWithOptions`); combined with an indexer read of the user's `p2:` and `o2:` boxes on app open, the full history is derivable. **No backend, no on-chain notes, no push infrastructure** — which also sidesteps the enumeration problem that rules out the `ms:cover:` note approach in [State](#state).

This is also where orphaned take-profit orders surface. Since three of four exit paths orphan the order and only the owner can cancel it, Hedge History is the one place a user reliably sees locked MBR and can reclaim it.

**Amount paid and amount returned are financial displays**, so they obey [Quote Accuracy](#quote-accuracy): derived from live chain state and receipts, never from cached client values.

---

## Duration: The Hard Problem

**A time-based automatic close is not natively enforceable on Algorand, and the obvious workaround does not exist.**

Algorand transactions carry a validity window of at most **1000 rounds** (`lastValid − firstValid ≤ 1000`), roughly 50 minutes. A close transaction therefore **cannot be pre-signed at open time** for execution 24, 72 or 168 hours later.

PEX's stored orders do not close this gap. All three order kinds — `OPEN_LIMIT`, `DECREASE_TAKE_PROFIT`, `DECREASE_STOP_LOSS` — are **price**-triggered. GTD sets an expiry on the *order*, not a timed close of the *position*. There is no time-triggered close primitive.

That leaves three options.

### Option A — Advisory duration (v1, selected)

The declared duration is a **reminder**. At expiry we notify; the user closes with one tap. Nothing is enforced.

- **Authority granted to Magnet Strategies: none.**
- **Blast radius of full compromise of our infrastructure: zero user funds.**

**Wording is a correctness requirement.** The UI must never say "closes after 72 hours." Acceptable phrasing: *"We'll remind you after 72 hours."* A user who believes a close is guaranteed and does not receive one has been misled by us, and that is a user-harm finding regardless of whether funds moved.

### Option B — Delegated close authority (NOT RECOMMENDED — do not build as scoped)

A delegated LogicSig, signed once by the user at open, authorising an MS keeper to close that position later. Because a delegated LogicSig approves a *program* rather than a pre-built transaction, the 1000-round window does not apply.

**An earlier draft of this section listed six bindings, all concerned with the semantic content of the call. Every field that actually drains a delegated LogicSig was missing.** Recorded here so the mistake is not repeated:

| Missing binding | Consequence if unbound |
|---|---|
| `txn.Fee` on **every** transaction | Keeper sets the fee to the user's entire spendable ALGO. Total ALGO loss, independent of position size. The classic delegated-lsig drain. |
| `txn.RekeyTo == ZeroAddress` | "Never a rekey" was written as a transaction *type* exclusion. `RekeyTo` is a **field on every type, including `appl`**. As scoped, Option B permitted exactly what Option C rejects outright. |
| `CloseRemainderTo` / `AssetCloseTo` | Same class. Account drained via a field, not a type. |
| `outputSwapMode == 0`, `minPrimaryOutputAmount`, `minSecondaryOutputAmount` | `V2_OUTPUT_SWAP.COLLATERAL_TO_PNL` with `minOutput = 0` converts proceeds at whatever the pool gives. Defeats "proceeds to the owner only" entirely — the funds reach the owner, as near-nothing. |
| `builderAddress` / `builderFeeBps` | Confirmed charged on decrease (`src/v2Quotes.ts:2478-2481`). Unbound, the keeper redirects 10 bps of every close to itself. |
| `sizeUsdDelta` | "Decrease-or-close only" permits *partial* decreases. A keeper grinds the position with repeated partials at 0.06% + 10 bps each. |

**Two structural defects that no binding list fixes:**

**The `lease` is not one-shot.** A lease blocks a duplicate `(sender, lease)` pair only until the first transaction's `lastValid` passes. Across a 7-day Cover that is ~200 independent windows — one execution *per window*, not one ever.

**The position key carries no nonce.** `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner` **is** the full set of "exact position coordinates." If the user closes their Cover and later opens a new position on the same side of the same market with the same collateral, the old LogicSig matches the new position and the keeper closes something it was never authorised to touch.

**And it fails at its own job.** If the user increased the position, the bound `sizeUsdDelta` only partially closes, leaving a residual with stale brackets. If they partially closed, `sizeUsdDelta > position_size_usd` and the call fails — so the "enforced" close silently does not happen, which is the worst outcome for a feature sold as a guarantee.

**If this is ever revisited**, the program must assert, for every transaction in the group: `Fee <= CAP`, `RekeyTo == ZeroAddress`, `CloseRemainderTo == ZeroAddress`, `AssetCloseTo == ZeroAddress`, exact `GroupSize`, exact `TypeEnum` and `ApplicationID` per index, the complete ABI arg tuple, and `LastValid <= expiryRound`. Note that pinning `GroupSize` and per-index app IDs means any PEX upgrade silently bricks every outstanding LogicSig — the safe failure, but it degrades the feature to Option A on every upgrade anyway.

> **This would be Magnet Strategies' first on-chain code in this product, it is entirely unsupported by the PEX SDK, and it would hold signing authority over every Cover user simultaneously. A keeper compromise is an attack on all open positions at once. It is not a small addition to Option A.**

### Option C — Rekey

Rejected outright. Never rekey a user account.

### Consequence for v1

Ship Option A. Duration is a reminder, honestly worded.

**The automated exits are the take profit, liquidation and ADL.** With no stop loss, an adverse move that does not reach liquidation requires the user to act — which is the deliberate product choice recorded under [Take profit](#take-profit--mandatory-one-per-position). Manual close is always available on the management surface.

Do not overstate this. Three of the four remaining exits can fail: ADL disarms nothing but closes the position outright, a market pause leaves no exit at all, a gap can skip the take-profit trigger, and a failed yield recall blocks **both** the take profit and the manual close — a state in which no exit path works. Bounded cost comes from the take profit and from live display of accrued holding cost, not from a clock we cannot enforce.

---

## Collateral

**USDC only in v1.** Posting ALGO as collateral on an ALGO-denominated position makes the collateral's USD value move with the position, turning the liquidation price into a moving target and the payout harder to reason about. USDC gives a clean denominator.

> Making this exclusive rather than merely default also removes an ambiguity: the position key includes `collateralAssetId`, so if ALGO collateral were reachable a wallet could hold **two** distinct positions on the same market and side. Uniqueness, increase-flow routing and the notional cap would all key on the wrong tuple. USDC-only makes "one position per (market, side)" exactly true.

If the user holds only ALGO, offer an ALGO→USDC swap. Constraints:

- The swap is disclosed as a separate step with its own cost, never bundled silently.
- **`SWAP_BUILDER_FEE_BPS` is 0 for a conversion the user did not seek.** The protocol permits 100 bps on swaps, ten times the position cap. Charging maximum on a conversion the product forced is indefensible for a brand whose sibling product's founding document treats operator trust as the binding constraint. If a swap fee is ever introduced here it is a deliberate, disclosed, separately-decided product choice.
- Verify whether the swap and the position open fit in one signed group within Algorand's group size and resource-reference limits. PEX trading methods are resource-heavy and carry their own resource-carrier transactions. If they do not fit, it is two signatures, and the UI must set that expectation before the first prompt.

**mUSD is explicitly out of scope as a funding path.** See [OVERVIEW.md](./OVERVIEW.md#out-of-scope--musd-as-a-funding-path).

---

## Revenue

Cover earns through PEX's native builder-fee rail. No contract of ours, no separate fee collection, no custody. `builder_address` and `builder_fee_bps` are fields on the PEX call, recorded in the order box and publicly readable on-chain.

### Position fee — the primary line

Capped by the protocol at **10 bps of notional** (`MAX_POSITION_BUILDER_FEE_BPS = 10n`; `normalizeBuilderFee` **throws** above the cap rather than silently clamping). Revenue scales with *notional*, not with the user's stake:

| Stake | Band | Notional | MS fee at 10 bps |
|---|---|---|---|
| $50 | Low (5×) | $250 | $0.25 |
| $50 | Moderate (10×) | $500 | $0.50 |
| $50 | Aggressive (20×) | $1,000 | $1.00 |

**The fee is charged on both open and close** — confirmed at `src/v2Quotes.ts:2478-2481`, where `quoteV2CloseLike` normalises a builder fee whenever `!liquidation && !adl`. Round-trip take is therefore **20 bps of notional**. The take-profit child inherits the parent's `builderFee`, so its execution pays it too. On liquidation and ADL it is forced to zero.

> **The fee comes out of the user's margin, not on top of it.** `positionCollateralDelta = max(0n, collateralAmount − (feeAmount + builderFeeAmount))` (`src/v2Quotes.ts:1950`). A $10 unit at 20× posts $10, pays $0.12 in PEX fees and $0.20 to us, and opens with $9.68 of margin against a $5 maintenance floor — **our fee consumes ~4% of the user's liquidation buffer, and scales with leverage exactly as that buffer shrinks.** Swaps behave differently: there the builder fee is a separate transfer *on top* of the trade. The two mechanisms are not the same and must not be described as one.

This is a volume business. $1M of monthly notional returns roughly $2,000 at 20 bps round-trip.

> **Incentive disclosure.** Revenue tracks notional, so Magnet Strategies earns four times more from an Aggressive position than a Low one at the same stake — and the "resolve to the highest available leverage" rule maximises user risk and our fee at the same time. That alignment is real. It should be acknowledged here rather than discovered by an auditor, and it is the reason two things in this spec are non-negotiable: the resolved leverage is displayed before signature, and the liquidation price is a permanent, safety-critical element of the management surface — the more so because there is no stop loss behind it.

### Swap fee — a separate decision

The protocol permits **100 bps on swaps**, ten times the position cap. Two cases, and they are not the same:

| Case | Recommendation |
|---|---|
| A conversion the product forces — user holds only ALGO and must reach USDC to use Cover | **0 bps.** Charging anything on a step the product forced is the same friction we rejected for the mUSD path, applied to our own users instead. |
| An elective swap the user initiates | **25–50 bps** is defensible and still well under the cap. |

Whatever is chosen is disclosed in the UI. The fee is readable on-chain regardless; concealing it in the interface is the same category of problem as a closed price feed.

### What is not a revenue source

- No spread on the quoted price. Execution is PEX's oracle range; we do not widen it.
- No fee on close beyond the disclosed builder fee.
- No custody, so no float and no yield on user balances.
- No mUSD path, so no PSM redemption revenue from this product.

---

## Availability Gating

Bands are not always available. PEX tightens margin requirements dynamically as open interest approaches its per-side cap, and the 70% pool utilization ceiling can block a side entirely regardless of leverage.

**Gating is a local computation, not a network round trip.** The SDK computes quotes and risk client-side. Read market state on an interval, then evaluate any hypothetical order size and band instantly as the user changes inputs.

```
read      mp2: (pool)  mo2: (open interest)  mf2: (funding/borrowing)  ma2: (adaptive funding)
decode    via protocol manifest
compute   effective max leverage per side, remaining capacity per side  [local]
derive    which bands are deliverable at the user's current unit count  [local]
```

Two distinct unavailability states, with different messages and different user actions:

| State | Cause | Message shape |
|---|---|---|
| Band unavailable | Dynamic margin tightened near the OI cap | "Moderate is unavailable right now — capacity is limited." Lower bands still work, relabelled per the table in [Aggressiveness bands](#aggressiveness-bands). |
| Side unavailable | Pool utilization at ceiling, or reserves committed | Nothing works on that side at any leverage — including Aggressive, despite its "always available" framing elsewhere, which refers only to capacity-constrained *leverage*, not to a closed side. Different message, different suggested action. |

**Prefer a ceiling to a wall.** Because any size can be evaluated locally, show the limit rather than a disabled button: *"Max at Aggressive: 4 Covers."* It tells the user how to get to yes and costs nothing extra. Note the limit is now a **unit count** — with fixed multiples there is no leverage to solve down to, and units cannot restore a 5× band that capacity has closed.

**Structural note for this product specifically.** Hedging demand is correlated — in an ALGO drawdown everyone wants the same side at the same time. Cover will systematically push into whichever side is already constrained, at exactly the moment users want it. Design the capacity messaging for that case rather than treating it as an edge case, and consider nudging users to open cover while capacity exists.

**Gating is a snapshot, not a guarantee.** State can shift between the read and the signature. Gating removes predictable failures; it does not remove all failures. A clean on-chain rejection handler is still required, and the acceptable-price bound is a separate rejection path gating cannot touch.

---

## Quote Accuracy

Display accuracy is a security property here, because there is no contract to exploit and misleading numbers are the primary way a user can be harmed.

**Required:**

1. **Every displayed payout is net** of open fee, close fee, builder fee, keeper fee where a bracket is attached, and accrued funding and borrowing. A screen that says $100 when $98.40 lands is a trust failure.
2. **The profit target is never presented as guaranteed.** PEX documents these orders as conditional. The trigger arms when the *oracle* crosses the level; a keeper then executes, and in a fast move it can fill worse. `≈$148` is correct; "you will receive $148" is not.
3. **Holding cost is shown live and labelled as variable.** Borrowing accrues with utilization; funding is charged *or received* hourly depending on which side of the OI imbalance the user is on. A hedger on the light side may be **paid** to hold. Never quote either as fixed.
4. **Funding share is read, never assumed.** `opposing_trader_share_bps` is live on-chain state. Hardcoding 25% is a defect.
5. **Quotes refuse to render on a stale oracle.** Payloads carry a ~30s validity window. Past `ORACLE_MAX_AGE_SEC`, show a stale state rather than a stale number.
6. **The builder fee is disclosed.** It is publicly readable on-chain; concealing it in the UI is the same category of problem as a closed price feed.
   **And one line of settlement disclosure**, not a warning banner: Cover settles on PEX, a third-party protocol, whose risk parameters can change. Brief, true, and cheap now.
7. **The payoff table is labelled as subject to the trader PnL cap.** `checkTraderPnlCap` pushes `trader_pnl_cap` when **this close's own payout** exceeds `max_pnl_factor_for_traders_bps ×` the side pool in USD (`src/v2Quotes.ts:4222-4230`); a pushed reason makes the quote **not ok**, so the voluntary close is *rejected*, not reduced. *(An earlier draft claimed this binds on aggregate side PnL versus other traders, and named the wrong reason strings — `long_pnl_cap`/`short_pnl_cap` are LP deposit/withdraw reasons. At $10-unit sizes an individual payout cannot approach a fraction of the pool, so this effectively never binds on the voluntary-close path.)*
   **The aggregate-side-PnL exposure is real, but it is ADL, not this.** `sidePositivePnlUsd` against `sidePnlCapUsd` drives ADL eligibility (`src/v2Quotes.ts:2565-2570`), and `effectiveProfitUsd = profitUsd × traderPnlCapUsd / sidePositivePnlUsd` scales the payout down. That is where correlated one-sided hedging demand actually lands, and where `side_positive_pnl_usd`, `side_pnl_cap_usd` and `adl_threshold_breached` should be surfaced.
8. **The displayed liquidation buffer is computed after fees**, from the SDK's `liquidation_price_estimate` — never from `1/leverage − maintenance_margin_rate`, which ignores that open fees and the builder fee are deducted from collateral first.

---

## State

Cover holds **no protocol state of its own**. Everything economically meaningful lives in PEX boxes: the position in `p2:`, the bracket order in `o2:`, market context in `mp2:` / `mo2:` / `mf2:` / `ma2:`.

The only Cover-specific data is **user intent** — declared duration and the unit count the position was composed from. Neither is required for correctness; both exist to drive reminders and display.

**Do not use an on-chain note.** An earlier draft ranked a 0-ALGO self-payment carrying an `ms:cover:` prefix first, for cross-device durability. Redacting duration and unit count from it — necessary, because publishing them ranks leveraged retail wallets for liquidation hunters — removes the only thing that made it worth publishing, while the prefix still enumerates every Cover user permanently.

**Use `localStorage`**, and accept the cross-device loss. It is the only Cover-specific state, it is not required for correctness, and Hedge History is reconstructed from chain regardless — so a user on a new device loses a duration reminder, not their record.

If a backend store is ever preferred instead, note that it makes the Operating Model's "read backend" a **write** surface and moves the target list from public to MS-held rather than eliminating it. That needs its own Residual Trust row.

> **Testable invariant: no dollar figure rendered anywhere in Cover may be derived from client-stored values. Every financial display derives from live PEX state or a decoded receipt.**

---

## Invariants

1. **The destination of every asset movement is a build-time constant**, never a runtime value from any API response. Magnet Strategies never custodies user funds, and no flow routes user assets to an address we control other than the disclosed builder fee. *(The earlier wording — "no flow routes user assets to an address we control" — was enforced by nothing, because the destination was derived from a backend-supplied app ID.)*
2. **Magnet Strategies never holds authority to open or increase a position.** In v1 we hold no authority to close one either.
3. **Every state-changing action is wallet-signed** by the position owner.
4. **No MagnetFi state is read or written** by any Cover code path.
5. **No PEX state feeds MagnetFi solvency.** Cover does not spend the PEX dependency. See the coupling rule in [OVERVIEW.md](./OVERVIEW.md#the-dependency-coupling-rule).
6. **Displayed payout ≤ realistically achievable payout** under the quoted conditions, *including* ADL payout scaling, and with the buffer computed after fees. Round against the user — and verify the direction on every quantity that reaches the screen, since `builderFeeAmount` uses floor division, which rounds the fee against us rather than the payout against the user.
7. **`builder_fee_bps` ≤ the protocol cap**, is a build-time constant, and is disclosed in the UI.
8. **No PEX risk parameter is hardcoded.** Margin rates, caps, fees, funding share and utilization limits are read live.
9. **No transaction group is presented for signature without passing the full-group ABI assertion** described in the Threat Model — every app-call argument verified against what the confirm screen displayed. Simulation runs too, but is a pre-flight failure detector, not a security control: a compromised frontend controls the simulation, the comparison, and the display. The wallet is the only real boundary.
10. **Every take-profit order is GTC** — `TIME_IN_FORCE.GTC` and `expiry_time = 0`, which is already the SDK default for attached children (`src/transactions.ts:6379-6380`). An order that silently expires while the position it belongs to persists is a defect. The cost of GTC is that it cannot be cleaned up by `cancel_expired_order`, which anyone may call — so owner-cancellation becomes mandatory infrastructure, not hygiene.
12. **No new Cover opens against a position key that has a resting reduce order.** Orphans re-arm; the position key has no nonce.
11. **No financial display derives from note contents.** Every dollar figure comes from a live PEX quote.

---

## Residual Trust

What a Cover user is trusting, stated plainly because the product's honesty depends on it:

| Trusted party | For what | Our mitigation |
|---|---|---|
| PEX contracts | Correct settlement, margin, liquidation, ADL | None available. No audit is advertised. Disclose. |
| PEX admin & upgrade keys | Acting in good faith and changing risk parameters with notice. `maintenance_margin_bps` is read **live at liquidation time** (`src/v2Quotes.ts:2654`), not snapshotted at open, so the buffer disclosed at purchase is a live parameter Ultrade controls. | **This is an accepted trust, recorded deliberately.** Both keys are single-signature and `PDexV2Trading` is upgradeable (see [OVERVIEW](./OVERVIEW.md#governance-and-upgradeability--read-this-before-building)). Magnet Strategies assumes good-faith operation with notice — the normal posture for a third-party dependency. Note that this assumption addresses *intent* only: key compromise, operational error, and a well-intentioned upgrade introducing a bug are unaffected by it. Mitigation is limited to reading parameters live and never caching a disclosed buffer. |
| PEX oracle signer | The price range all execution derives from | Freshness and target validation; refuse stale payloads |
| PEX keeper network | Executing stored orders and ADL | None available |
| Folks Finance, xALGO | Pool assets are partly deployed there via `lent_qty` | Transitive and unavoidable while trading against these pools. Disclose. |
| Magnet Strategies frontend | Constructing the group the user believes they are signing | Single audited module; per-method ABI and asset-movement assertions; simulation as pre-flight. **None of these survive full frontend compromise** — reproducible builds, SRI and a pinned bundle are the real mitigations |
| Magnet Strategies **deployment** manifest | Supplying the app and asset IDs that are the destinations of user funds | Assert equality against pinned constants; two-state degradation on mismatch |
| Magnet Strategies **protocol** manifest | Supplying the ABI spec used to encode *and* verify args, and to decode all box state | Pin method signatures and arg types, or a hash of the whole manifest; hard-fail on disagreement |

**A stale or poisoned protocol manifest is the least obvious failure mode in the system.** Across a legitimate PEX upgrade it means silently wrong decoding and therefore silently wrong quotes. Under an attacker it additionally defeats the group assertion, because the same spec that encodes the args is the one used to verify them. Pinning the ABI is what breaks that loop.

---

## Edge Cases

| Case | Required behaviour |
|---|---|
| Insufficient spendable ALGO for MBR and fees | Detect before the prompt. **~0.40 ALGO all-in** for a position with its take profit. Most common first-transaction failure. |
| USDC not opted in | Detect and offer opt-in as an explicit step |
| Band becomes unavailable between render and signature | Clean rejection handler; re-quote rather than retry blindly |
| Acceptable price exceeded mid-flight | Funds return. Explain as a price move, not an error. |
| Oracle payload stale at signing time | Block the signature; do not submit on a stale price |
| Profit target fills worse than trigger | Expected behaviour. Payout display must have set this expectation. |
| ADL reduces or closes a profitable position | Notify promptly and explain. Highest-severity surprise in the product. |
| Liquidation | Notify. Buffer was disclosed at purchase; restate what happened. |
| Position already closed when a duration reminder fires | Suppress the reminder |
| Market paused by PEX | Surface honestly; we have no override |
| User closes partially outside our UI | Read live position state as truth; never trust cached unit counts. **Re-place or alert on the take profit** — any size reduction makes it permanently unexecutable (`reduce_size_exceeds_position`) |
| ADL partially reduced the position | The take profit is now stale and will never fire. Re-place automatically or alert loudly. Never leave a dead order rendered as live |
| Position **increased** | The take profit still covers only the prior size and remains executable — the SDK reports no blocker. Re-place it at the new size in the increase group, or render it as **partial** |
| User already holds a position on this side | Route to the increase flow on Surface 2, never the purchase flow |
| Partial close blocked by min collateral or post-close health | Explain the floor; offer full close as the alternative |
| Voluntary close rejected by `trader_pnl_cap` | Payout exceeded a fraction of the side pool. Explain as pool capacity, not user error. Rare at Cover unit sizes |
| Yield recall fails at close time | Neither the take profit nor a manual close can execute. Surface honestly — the user is temporarily unable to exit |
| One-group construction exceeds 16 transactions | Aggressive: refuse to open. Low/Moderate: blocking alarm state until the take profit is placed |
| Close + cancel exceeds 16 transactions | `related_order_cancels_require_followup_group`. Set the expectation before the first prompt; treat an unsigned follow-up as an alarm state |
| Orphaned take profit from a prior position | Refuse to open a new Cover on that key until it is cancelled — an orphan re-arms against the new position |

---

## What Is Deliberately Not Here

- **No custom smart contract.** If a proposal adds one, it changes the threat model in this document and requires re-review.
- **No mUSD funding path.** Excluded by decision. See [OVERVIEW.md](./OVERVIEW.md#out-of-scope--musd-as-a-funding-path).
- **No enforced time-based close in v1.** Not available without delegated authority.
- **No chart.** PEX is oracle-priced; a chart would be decorative and would imply the user should be timing entries.
- **No delegated close authority.** Option B is documented as rejected, not deferred.
- **No per-unit targets, durations, or liquidation prices.** Units size a purchase; they are not independent positions.
- **No stop loss.** Deliberate: simplicity is the product, and downside management stays with the user via manual close. The cost is that liquidation becomes the only automated downside exit.

---

## Build Order

1. **Read path and pinning.** Fetch the deployment and protocol manifests, extract every app and asset ID, **and commit them as build-time constants** together with the ABI method signatures and the oracle signer key. Decode `mp2:` / `mo2:` / `mf2:` / `ma2:` for both markets against live MainNet state.
2. **Measure.** Live borrowing and funding rates, real utilization, per-side capacity, `max_pnl_factor_for_traders_bps`, `liquidation_fee_bps`, `maintenance_margin_bps`, and MainNet max leverage. **Design decisions that depend on holding cost or on `BAND_AGGRESSIVE_CEILING` are blocked until this exists.**
3. **Supply-chain controls.** Reproducible builds with published hashes, subresource integrity, a pinned deployment bundle. These — not the group assertion — are what raise the bar against full frontend compromise.
4. **Quote engine.** Band→leverage resolution with the relabelling table, payoff table, holding cost, availability gating, notional cap. Verified against SDK output, not reimplemented.
5. **Group construction.** Single audited module. Per-method ABI assertions plus asset-movement assertions on `(asset, amount, receiver)`. Simulation as a pre-flight check. `baseOrderId` allocated in strides of 3 from the highest existing `o2:` box read live from chain, never from local state.
6. **Purchase surface.** Units → band → target price → confirm, with entry-time routing to the increase flow.
7. **Management surface.** Liquidation price, take-profit state, accrued holding cost, add / add-collateral / partial close / close, orphan reclaim.
8. **Outcomes.** Receipt decoding, the five distinct close notifications, Hedge History.

Steps 1 and 2 are prerequisites, not preliminaries. Every number in this spec marked TestNet is a placeholder until step 2 replaces it.

---

## Open Questions

**These are informational, not blocking.** Build proceeds in parallel; the answers refine disclosure and inform how much exposure to allow, they do not gate the work.

- **Governance roadmap.** Answered from chain already: `PDexV2Trading` is upgradeable and was upgraded 2026-09-12; admin and upgrade are separate single-signature keys. The open part is forward-looking — is a multisig planned, is a timelock planned, what is the change-notice process, and does a PEX audit exist?
- Do the PEX **contracts** enforce oracle freshness, and with what tolerance? The SDK performs no staleness check anywhere — `max_age_seconds` and `valid_until_timestamp` are inert data. If the contracts do not enforce it either, a backend compromise becomes a direct execution-price attack rather than a display-only one.
- Is `max_pnl_factor_for_traders_bps` enforced on-chain identically to the SDK's client-side `checkTraderPnlCap`? The README disclaims that the SDK fully specifies the financial calculations.
- Is a duplicate `ownerOrderId` rejected or does it overwrite the box? Allocate `baseOrderId` in strides of 3 (children are `base+1` / `base+2`) derived from the highest existing `o2:` box read live from chain, never from local state.
- What happens when a PEX keeper cannot complete a yield recall — privileged bypass, or simple failure? It is the only failure mode that blocks both the take profit **and** the manual close.
- **Do the PEX contracts cap `keeperFeeAmount`?** The SDK does not validate it anywhere. Determines whether an unbounded escrow is possible.
- **Does a PEX redeploy migrate existing position state, or leave it in the old app?** Determines whether the two-state degraded mode is sufficient.
- **Is the oracle signer public key readable from on-chain state, and at what layout?** No SDK path exists; without one, pinning it requires Ultrade to supply the key out-of-band.
- **What is MainNet maximum leverage?** `BAND_AGGRESSIVE_CEILING` is set to 20× on the assumption it matches TestNet. If MainNet differs, every buffer figure in this document moves.
- **Product question, deferred not decided:** should there be an unleveraged (1×) option? A product called Cover with a 5× floor cannot express "protect me without leverage." Three bands were specified deliberately; recording the gap rather than silently closing it.
- Can an ALGO→USDC swap and a position open fit in one signed group within resource-reference limits?
- Do resting limit orders pre-reserve open-interest capacity, or only the storage escrow? Affects whether parked conditional orders consume the capacity gating reads.
- What is the MainNet value of every TestNet parameter in [OVERVIEW.md](./OVERVIEW.md#verified-parameters)?
- Is there a published PEX audit? Not advertised in the repo; worth asking directly given the relationship.

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
| PEX protocol | Everything within its own contracts, including ADL | — |
| PEX oracle signer | Set the price range all execution derives from | — |
| PEX keeper network | Execute stored orders, liquidate, ADL | Open positions on a user's behalf |
| **PEX admin / governance** | **Change every risk parameter including `maintenance_margin_bps`, `liquidation_fee_bps`, `close_fee_bps`, `max_pnl_factor_for_traders_bps`; pause markets; possibly upgrade contracts** | **Unknown** |
| Third-party liquidator | Liquidate any position below maintenance | Liquidate a healthy position |
| Network observer | Read every position, order, fee and builder address on-chain | — |

**The dominant risk is a compromised or buggy frontend presenting a harmful group to a user who trusts the brand and signs without reading.** Algorand wallets display group contents, but users do not reliably read them. This is the same trust posture as every non-custodial dApp, and it is not eliminated by having no contract — it is merely the only risk left.

**Mitigations required:**

- Transaction group construction goes through a single audited module. No ad-hoc group assembly in UI components.
- Every group is simulated (`simulate_transactions`) before presentation. **Simulation is a pre-flight failure detector, not a security control** — a 20× open simulates perfectly, and a compromised frontend controls the simulation call, the comparison, and the rendering. The only genuine trust boundary is the wallet, which renders ABI args as opaque bytes.
- **A full-group assertion runs immediately before the signature prompt** — not merely an asset-movement check. Asset movements are not sufficient: `open_or_increase` takes **no collateral argument** (`src/transactions.ts:1310-1318`), so leverage is `sizeUsdDelta ÷ transfer amount` and `sizeUsdDelta` is a free frontend integer. A frontend showing "Low, 5×" can send 20× while the transfer remains exactly $50 of the right asset to the right place. The assertion must decode every app call's ABI args against the manifest and verify each equals what the confirm screen displayed:
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
- Treat the deployment manifest as **advisory**: fetch it, assert every ID equals its pinned constant, and hard-fail into a "PEX has been redeployed — Cover is paused pending review" state on any mismatch. A PEX redeploy must require an MS release, never a JSON edit.
- The oracle signer public key is likewise pinned from on-chain state and **never** taken from `pubkey_hex` in an HTTP response (`src/oracle.ts:150-170` copies it straight from the payload, which is not verification).

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
| `COVER_MAX_UNITS_LOW` | 25 | $250 committed |
| `COVER_MAX_UNITS_MODERATE` | 15 | $150 committed |
| `COVER_MAX_UNITS_AGGRESSIVE` | 10 | $100 committed. Per-band caps because notional, not stake, drives risk: 25 units at max leverage is $5,000 of notional on a ~2.3% buffer. Revisit only after step-2 MainNet measurement. |
| `BAND_LOW` | 5× fixed | Greys out if unavailable |
| `BAND_MODERATE` | 10× fixed | Greys out if unavailable |
| `BAND_AGGRESSIVE` | max available | Always available; resolved value disclosed |
| `BUILDER_ADDRESS` | MS treasury | Build-time constant |
| `POSITION_BUILDER_FEE_BPS` | ≤ 10 | Protocol cap is 10 |
| `SWAP_BUILDER_FEE_BPS` | 0–25 for forced conversions | See [Revenue](#revenue) |
| `DEFAULT_SLIPPAGE_BPS` | 50 | User-adjustable, disclosed |
| `ORACLE_MAX_AGE_SEC` | 20 | Reject quotes on payloads older than this |

---

## Product Model

### Units

A Cover is **$10 of committed collateral**. The user buys N of them. Committed capital is `N × 10` USD and is the user's maximum loss.

> **Units are a purchase-sizing device, not independent positions.** The position box key is `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner` — there is **one position per (market, collateral asset, side, wallet)**. Buying more on the same side is `open_or_increase` on the existing position: blended entry price, blended leverage, and **a changed liquidation price on what the user already held**.

Consequences, all of which the product must respect rather than paper over:

- **One open Cover per (market, side) per wallet.** Quantity is chosen at purchase.
- **Adding is a separate, explicit flow** on the management surface — never a second trip through the purchase screen. If a user taps "buy Cover" while holding a position on that side, they are routed to the increase flow. One code path for every merge.
- **One take-profit and one stop loss per position.** Multiple TPs accumulate against `pendingTpSizeUsd`, and bracket child IDs are hardcoded `base+1` / `base+2` (`v2ExpectedLinkedChildOrderId`), so overlapping brackets collide. Per-unit brackets are not expressible.
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

**At 20× the buffer is thin enough to state plainly.** Liquidation on a ~2.5% adverse move, less again after fees — inside ordinary daily movement for ALGO. The band is offered because it was asked for; the disclosure is not optional.

**If the market is constrained below a fixed band's leverage, that band greys out** with a reason, consistent with [Availability Gating](#availability-gating). Aggressive remains available and shows its resolved value. A fixed band never silently delivers a different multiple than its label.

### Direction

`Protect against a drop` (short) and `Protect against a rise` (long). Presented as outcomes, not as sides.

### Duration

`24 hours · 72 hours · 1 week · Until I close`. **In v1 this sets a reminder, not an enforced close.** See below — the wording constraint is a correctness requirement, not a copy preference.

### Brackets — take profit and stop loss

Both are native PEX order kinds (`DECREASE_TAKE_PROFIT`, `DECREASE_STOP_LOSS`), stored on-chain in an order box and executed by **PEX's own keeper network**. They need no keeper of ours and grant us no authority.

Because a time-based close is not available (see [Duration](#duration-the-hard-problem)), price brackets are the **only** mechanism that closes a position without the user acting. Both are therefore in v1, not deferred.

| Bracket | Purpose | Default |
|---|---|---|
| Take profit | Realise gains at a chosen move | On for bounded intent; off for `Until I close`, where a target would cap protection |
| Stop loss | Exit with something rather than riding to liquidation and receiving nothing | **Offered on every position** |

The stop loss matters more than the take profit here — but not for the reason an earlier draft claimed. **Liquidation does not return nothing.** It triggers while equity is still approximately the maintenance margin; `feePaid = min(collateralOutput, liquidationFeeAmount)` is deducted and the residual returns to the owner, with `builderFeePaid` forced to `0n`. At 20× on a $10 unit that is roughly **$3.50 back**, not $0. Receiving nothing is the *gap* case — the scenario behind PEX's `liquidation_uncollectible` conformance vector — not the normal one.

The correct statement: a stop loss placed inside the buffer returns **more, and returns it earlier**, than liquidation does.

**Cost.** Each bracket order carries a **96,500 µALGO box MBR**. The 100,200 µALGO execution escrow applies to `OPEN_LIMIT` only, never to decrease kinds (`src/transactions.ts:6277-6281`). Two brackets is therefore **~0.193 ALGO**, not ~0.40 — prechecking against the higher figure turns away wallets that are fine.

Each bracket also escrows its **keeper fee in the collateral asset** via an axfer to the OrderOps app address, so a bracket needs spendable USDC as well as ALGO. Derive the requirement from `required_group_flat_fee_microalgos` on the live quote rather than from constants in this document.

**The one-group construction can fail under load.** `buildV2MarketOpenWithAttachedOrdersTransactions` does place open plus both brackets in one atomic group, but `validateGroupTransactionCount` throws `group_too_large` above 16 and the group is not fixed-size: each bracket adds four transactions, settlement-maintenance and yield-freshness carriers vary with pool state, and **charging a builder fee adds a transaction of its own** (`buildV2OpenOrIncreaseCall` appends a dynamic-OI carrier when `builderFeeBps > 0n`). Carrier-heavy conditions correlate with pool stress — exactly when a stop loss matters.

> **For the Aggressive band the single atomic group is mandatory: if it cannot be built, do not open the position.** Never fall back to a second signature that leaves a max-leverage position unprotected in the gap. For Low and Moderate, if a fallback is used, set the expectation before the first prompt and treat "position open, brackets not yet placed" as a blocking alarm state, not a background task.

**Neither is guaranteed, and the stop loss is more fragile than it looks.** Four distinct ways it stops protecting:

1. **Any reduction in position size permanently disarms it.** A bracket is created with `sizeUsdDelta` equal to the parent's full size. `analyzeV2OrderLifecycle` (`src/orderLifecycle.ts:205-215`) then pushes `reduce_size_exceeds_position` and sets `executable = false` — while the order still renders as attached. Triggered by a partial user close **and by ADL**. So a partial ADL silently kills the stop loss protecting the remainder.
2. **Execution requires a yield recall that can fail.** `buildV2DecreaseOrCloseCall` refuses to build without `yieldRecallMode`. Pool assets sit in Folks and xALGO (`lent_qty`); `externalYield.ts` defines `RECALL_ONLY` and `EMERGENCY` statuses and xALGO redemption is not always immediate. A failed recall leg fails the atomic group — the stop does not fire **and the user cannot close manually either**.
3. **A market pause** leaves an armed stop and a moving price with no exit.
4. **Gap risk.** Triggers arm on discrete ~30s oracle snapshots. On a 20× position the distance between a stop inside the buffer and liquidation is a fraction of 2.5% — a single oracle step can skip it entirely.

**Therefore: use GTC (`expiry_time = 0`), never GTD, on every protective bracket.** A GTD stop expires after at most 30 days while the position it protects continues indefinitely, with no close, no notification, and nothing on-chain marking the position as unprotected. Any expiring protective order is a defect.

**And do not describe the stop loss as "the mitigation" for the Aggressive band** — it is absent in three of the failure modes it would be invoked against. Render bracket state as **armed / stale / unexecutable** from the SDK's own `executable` and `executionBlockers`, never as a static "protected" badge.

### Worked example

5 Covers, Moderate, protect against a drop, TestNet params, ALGO at $0.0866:

```
committed          $50
leverage           10×      (highest available in the Moderate band)
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

**Surface 2 — Position management.** Once a position is live, the UI becomes position-shaped rather than unit-shaped. This is the honest frame: the user now holds one position, not N discrete Covers, and pretending otherwise is what [High 6](#units) warns against. The metaphor shift must be **visible** — a one-time explanation on first transition, not a silent swap.

Available on Surface 2:

| Action | Notes |
|---|---|
| Add to position | **The most heavily disclosed action in the product.** Must show before/after liquidation price and buffer, because adding moves the existing position's liquidation price. |
| Add collateral | De-risking: lowers effective leverage and widens the buffer without resizing. Given Aggressive ships with a ~2.3% effective buffer, a one-tap "widen my buffer" is a real safety win. Surface it prominently. |
| Partial close | Subject to the min-collateral and post-close-health rejections above. |
| Place / adjust / cancel brackets | |
| Close | |

**Four things must appear on the primary post-trade view regardless of how minimal it is**, because they are safety-critical rather than advanced:

1. **Liquidation price**, always visible
2. **Bracket state as armed / stale / unexecutable**, from the SDK's `executable` and `executionBlockers` — never a static "protected" badge
3. **ADL notification** when it fires
4. **Accrued holding cost**, since no clock bounds it

A user who never opens the advanced surface must still learn that they are at risk.

**Guard:** Surface 2 stays outcome-framed. More outcomes available, not more jargon exposed. The moment it reads as a trading terminal, the product has lost the thing that made it worth building.

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

**The user is not left watching a screen.** Time is the only dimension we cannot automate — price is fully covered. A position opened with both brackets attached closes automatically on a favourable move (take profit), on an adverse move (stop loss), on margin failure (liquidation), or on pool stress (ADL). Four of the five exit paths require no user action. Only "I have held this long enough" needs a tap.

Bounded cost is therefore achieved through the stop loss and through live display of accrued holding cost — not through a clock we cannot enforce.

---

## Collateral

**Default to USDC.** Posting ALGO as collateral on an ALGO-denominated position makes the collateral's USD value move with the position, turning the liquidation price into a moving target and making the payout harder to reason about. USDC gives a clean denominator.

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

**The fee is charged on both open and close** — confirmed at `src/v2Quotes.ts:2478-2481`, where `quoteV2CloseLike` normalises a builder fee whenever `!liquidation && !adl`. Round-trip take is therefore **20 bps of notional**. Bracket children inherit the parent's `builderFee`, so a take-profit or stop-loss execution pays it too. On liquidation and ADL it is forced to zero.

> **The fee comes out of the user's margin, not on top of it.** `positionCollateralDelta = max(0n, collateralAmount − (feeAmount + builderFeeAmount))` (`src/v2Quotes.ts:1950`). A $10 unit at 20× posts $10, pays $0.12 in PEX fees and $0.20 to us, and opens with $9.68 of margin against a $5 maintenance floor — **our fee consumes ~4% of the user's liquidation buffer, and scales with leverage exactly as that buffer shrinks.** Swaps behave differently: there the builder fee is a separate transfer *on top* of the trade. The two mechanisms are not the same and must not be described as one.

This is a volume business. $1M of monthly notional returns roughly $2,000 at 20 bps round-trip.

> **Incentive disclosure.** Revenue tracks notional, so Magnet Strategies earns four times more from an Aggressive position than a Low one at the same stake — and the "resolve to the highest available leverage" rule maximises user risk and our fee at the same time. That alignment is real. It should be acknowledged here rather than discovered by an auditor, and it is the reason two things in this spec are non-negotiable: the resolved leverage and buffer are displayed before signature, and a stop loss is offered on every position.

### Swap fee — a separate decision

The protocol permits **100 bps on swaps**, ten times the position cap. Two cases, and they are not the same:

| Case | Recommendation |
|---|---|
| A conversion the product forces — user holds only ALGO and must reach USDC to use Cover | **0–25 bps.** Charging 100 bps on a step the user did not seek is the same 1% friction we rejected for the mUSD path, applied to our own users instead. |
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
| Band unavailable | Dynamic margin tightened near the OI cap | "High is unavailable right now — capacity is limited." Lower bands still work. |
| Side unavailable | Pool utilization at ceiling, or reserves committed | Nothing works on that side, including 1×. Different message, different suggested action. |

**Prefer a ceiling to a wall.** Because any size can be evaluated locally, show the limit rather than a disabled button: *"Max at High: 4 Covers."* It tells the user how to get to yes and costs nothing extra.

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
7. **The payoff table is capped at the live trader PnL cap, or labelled as subject to it.** `checkTraderPnlCap` pushes `long_pnl_cap` / `short_pnl_cap` when a side's **aggregate** positive PnL exceeds `max_pnl_factor_for_traders_bps × sidePoolUsd`, and a pushed reason makes the quote **not ok** — the voluntary close is *rejected*, not merely reduced. It binds on aggregate side PnL, so an individual user with a modest winner is blocked because *other* traders on their side are collectively in profit. Cover systematically concentrates users on one side (hedging demand is correlated), so this is a designed-in collision, not an edge case. Surface side PnL headroom **before purchase**, the same way band availability is surfaced.
8. **The displayed liquidation buffer is computed after fees**, from the SDK's `liquidation_price_estimate` — never from `1/leverage − maintenance_margin_rate`, which ignores that open fees and the builder fee are deducted from collateral first.

---

## State

Cover holds **no protocol state of its own**. Everything economically meaningful lives in PEX boxes: the position in `p2:`, the bracket order in `o2:`, market context in `mp2:` / `mo2:` / `mf2:` / `ma2:`.

The only Cover-specific data is **user intent** — declared duration and the unit count the position was composed from. Neither is required for correctness; both exist to drive reminders and display.

Options, in order of preference:

1. **On-chain note.** A 0-ALGO self-payment carrying a JSON payload under an `ms:cover:` prefix, mirroring the pattern already in `web/src/lib/contact.ts`. Zero backend, cross-device, publicly verifiable, consistent with house architecture. Costs one extra transaction and ~0.001 ALGO.
2. **`localStorage`.** Free, but lost across devices and browsers.

If (1) is used, apply the same defensive decoding discipline as `contact.ts`: a note is only trusted as the user's own intent when `txn.sender === the position owner`.

**But sender-verification does not address the bigger problem, which is publication.** An `ms:cover:` prefix creates a public, indexer-queryable list of every Cover user, their declared size, and **when they intend to stop paying attention** — alongside leveraged positions carrying ~2.3% buffers. Position boxes are already public, but they are not indexed by intent. That is a ranked target list for anyone running the permissionless liquidation path, published by us on the user's behalf.

**Therefore: omit duration and unit count from any on-chain payload.** Store an opaque local identifier only, and keep intent in `localStorage` or a backend keyed by wallet, accepting the cross-device loss.

> **Testable invariant: no dollar figure rendered anywhere in Cover may be derived from note contents. Every financial display derives from a live PEX quote.**

---

## Invariants

1. **The destination of every asset movement is a build-time constant**, never a runtime value from any API response. Magnet Strategies never custodies user funds, and no flow routes user assets to an address we control other than the disclosed builder fee. *(The earlier wording — "no flow routes user assets to an address we control" — was enforced by nothing, because the destination was derived from a backend-supplied app ID.)*
2. **Magnet Strategies never holds authority to open or increase a position.** In v1 we hold no authority to close one either.
3. **Every state-changing action is wallet-signed** by the position owner.
4. **No MagnetFi state is read or written** by any Cover code path.
5. **No PEX state feeds MagnetFi solvency.** Cover does not spend the PEX dependency. See the coupling rule in [OVERVIEW.md](./OVERVIEW.md#the-dependency-coupling-rule).
6. **Displayed payout ≤ realistically achievable payout** under the quoted conditions, *including* the live trader PnL cap, and with the buffer computed after fees. Round against the user — and verify the direction on every quantity that reaches the screen, since `builderFeeAmount` uses floor division, which rounds the fee against us rather than the payout against the user.
7. **`builder_fee_bps` ≤ the protocol cap**, is a build-time constant, and is disclosed in the UI.
8. **No PEX risk parameter is hardcoded.** Margin rates, caps, fees, funding share and utilization limits are read live.
9. **No transaction group is presented for signature without passing the full-group ABI assertion** described in the Threat Model — every app-call argument verified against what the confirm screen displayed. Simulation runs too, but is a pre-flight failure detector, not a security control: a compromised frontend controls the simulation, the comparison, and the display. The wallet is the only real boundary.
10. **Every protective bracket is GTC (`expiry_time = 0`).** A protective order that can expire is a defect.
11. **No financial display derives from note contents.** Every dollar figure comes from a live PEX quote.

---

## Residual Trust

What a Cover user is trusting, stated plainly because the product's honesty depends on it:

| Trusted party | For what | Our mitigation |
|---|---|---|
| PEX contracts | Correct settlement, margin, liquidation, ADL | None available. No audit is advertised. Disclose. |
| PEX admin key | Not liquidating users at will. `maintenance_margin_bps` is read **live at liquidation time** (`src/v2Quotes.ts:2654`), not snapshotted at open — so the buffer disclosed at purchase is not a property of the user's position but a live parameter a third party controls. Raising it liquidates open positions with no price move. | None. Upgradeability and key custody are **undetermined** — see [Open Questions](#open-questions). If the trading app is upgradeable by a single unaudited key, that fact outranks everything else in this document. |
| PEX oracle signer | The price range all execution derives from | Freshness and target validation; refuse stale payloads |
| PEX keeper network | Executing stored orders and ADL | None available |
| Folks Finance, xALGO | Pool assets are partly deployed there via `lent_qty` | Transitive and unavoidable while trading against these pools. Disclose. |
| Magnet Strategies frontend | Constructing the group the user believes they are signing | Single audited module, mandatory simulation, asserted asset movements |
| Magnet Strategies backend | Protocol manifest used to decode box state | Version-check the manifest; refuse to quote on mismatch |

**A stale protocol manifest across a PEX upgrade means silently wrong decoding and therefore silently wrong quotes.** This is the least obvious failure mode in the system and deserves explicit attention in review.

---

## Edge Cases

| Case | Required behaviour |
|---|---|
| Insufficient spendable ALGO for MBR and fees | Detect before the prompt. ~0.30 ALGO for a position with a bracket. Most common first-transaction failure. |
| USDC not opted in | Detect and offer opt-in as an explicit step |
| Band becomes unavailable between render and signature | Clean rejection handler; re-quote rather than retry blindly |
| Acceptable price exceeded mid-flight | Funds return. Explain as a price move, not an error. |
| Oracle payload stale at signing time | Block the signature; do not submit on a stale price |
| Profit target fills worse than trigger | Expected behaviour. Payout display must have set this expectation. |
| ADL reduces or closes a profitable position | Notify promptly and explain. Highest-severity surprise in the product. |
| Liquidation | Notify. Buffer was disclosed at purchase; restate what happened. |
| Position already closed when a duration reminder fires | Suppress the reminder |
| Market paused by PEX | Surface honestly; we have no override |
| User closes partially outside our UI | Read live position state as truth; never trust cached unit counts for financial display. **Also re-place or alert on brackets** — any size reduction makes them permanently unexecutable |
| ADL partially reduced the position | Brackets are now stale and will never fire. Re-place automatically or alert loudly. Never leave a dead order rendered as live |
| User already holds a position on this side | Route to the increase flow on Surface 2, never the purchase flow |
| Partial close blocked by min collateral or post-close health | Explain the floor; offer full close as the alternative |
| Voluntary close rejected by the trader PnL cap | Explain as pool capacity, not user error; show expected clearing conditions |
| Yield recall fails at close time | Neither the stop loss nor a manual close can execute. Surface honestly — the user is temporarily unable to exit |
| One-group construction exceeds 16 transactions | Aggressive: refuse to open. Low/Moderate: blocking alarm state until brackets are placed |

---

## What Is Deliberately Not Here

- **No custom smart contract.** If a proposal adds one, it changes the threat model in this document and requires re-review.
- **No mUSD funding path.** Excluded by decision. See [OVERVIEW.md](./OVERVIEW.md#out-of-scope--musd-as-a-funding-path).
- **No enforced time-based close in v1.** Not available without delegated authority.
- **No chart.** PEX is oracle-priced; a chart would be decorative and would imply the user should be timing entries.
- **No delegated close authority.** Option B is documented as rejected, not deferred.
- **No per-unit brackets, durations, or liquidation prices.** Units size a purchase; they are not independent positions.

---

## Build Order

1. **Read path.** Protocol manifest, deployment manifest, application IDs. Decode `mp2:` / `mo2:` / `mf2:` / `ma2:` for both markets. Nothing else can be trusted until this is verified against live MainNet state.
2. **Measure.** Live borrowing and funding rates, real utilization, real per-side capacity, and the MainNet values of every parameter listed as TestNet-only. **Design decisions that depend on holding cost are blocked until this exists.**
3. **Quote engine.** Local band→leverage resolution, payoff table, holding cost, availability gating. Verified against SDK output, not reimplemented.
4. **Group construction.** Single audited module. Simulation mandatory. Asset-movement assertions.
5. **UI.** Four screens: units → band → confirm → covered state.
6. **Notifications.** Duration reminders, ADL alerts, liquidation alerts.
7. **Post-trade view.** Portfolio integration for users who want the detailed position.

Steps 1 and 2 are prerequisites, not preliminaries. Every number in this spec marked TestNet is a placeholder until step 2 replaces it.

---

## Open Questions

- **Is `PDexV2Trading` upgradeable, who holds the admin key, is it a multisig, and is there a timelock?** `PDexV2AdminControl` gates every trading call but exposes no admin method in the public SDK. Since `maintenance_margin_bps` is read live at liquidation time, that key can liquidate every Cover user without a price move. **Ask Ultrade directly before building.** Also ask whether a PEX audit exists.
- Do the PEX **contracts** enforce oracle freshness, and with what tolerance? The SDK performs no staleness check anywhere — `max_age_seconds` and `valid_until_timestamp` are inert data. If the contracts do not enforce it either, a backend compromise becomes a direct execution-price attack rather than a display-only one.
- Is `max_pnl_factor_for_traders_bps` enforced on-chain identically to the SDK's client-side `checkTraderPnlCap`? The README disclaims that the SDK fully specifies the financial calculations.
- Is a duplicate `ownerOrderId` rejected or does it overwrite the box? Allocate `baseOrderId` in strides of 3 (children are `base+1` / `base+2`) derived from the highest existing `o2:` box read live from chain, never from local state.
- What happens when a PEX keeper cannot complete a yield recall — privileged bypass, or simple failure?
- Can an ALGO→USDC swap and a position open fit in one signed group within resource-reference limits?
- Do resting limit orders pre-reserve open-interest capacity, or only the storage escrow? Affects whether parked conditional orders consume the capacity gating reads.
- What is the MainNet value of every TestNet parameter in [OVERVIEW.md](./OVERVIEW.md#verified-parameters)?
- Is there a published PEX audit? Not advertised in the repo; worth asking directly given the relationship.

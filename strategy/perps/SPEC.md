# Perps — Product Definition and Architecture Spec

Perps is a simplified product surface over PEX perpetual positions. Four inputs: long or short, a USDC amount, a position on the risk bar, and a price to take profit at. Optionally a protection level. One signature. No chart, no order book, no leverage jargon on screen.

**Product name is not final.** "Perps" is the working name for both the product and its unit. It was chosen over "contract" deliberately: *contract* plus a payout table is the vocabulary of a derivatives offering and is not worth borrowing.

**Status:** Design stage. Nothing is built or deployed.

> **On source citations.** This document names **symbols**, not line numbers. Line numbers drifted by up to ~300 lines between 0.5.0 and 0.6.2 and were silently wrong here through two claimed re-derivations — for a document whose security control is "verify this against source", a stale line number is worse than no line number. Grep the symbol in the pinned SDK. Citations are current against **0.6.2** (`d9f43a4`).

Read [PEX.md](./PEX.md) first for PEX platform facts, verified constants, and the integration paths that were rejected.

---

## The Central Architectural Fact

**Perps requires no smart contract of our own.**

Every economic action is a PEX call signed by the user's wallet:

| Action | Mechanism | Who executes |
|---|---|---|
| Open a Perps | `buildV2OpenOrIncreaseCall` | User's wallet |
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

| Third-party liquidator | Liquidate any position below maintenance | Liquidate a healthy position |
| Network observer | Read every position, order, fee and builder address on-chain | — |

*This row documents **capability**, not expectation. Magnet Strategies assumes Ultrade operates in good faith and changes parameters with notice; see [Residual Trust](#residual-trust). A threat model that omits a dependency's powers because the dependency is trusted is decorative.*

**The dominant risk is a compromised or buggy frontend presenting a harmful group to a user who trusts the brand and signs without reading.** Algorand wallets display group contents, but users do not reliably read them. This is the same trust posture as every non-custodial dApp, and it is not eliminated by having no contract — it is merely the only risk left.

**Mitigations required:**

- Transaction group construction goes through a single audited module. No ad-hoc group assembly in UI components.
- Every group is simulated (`simulate_transactions`) before presentation. **Simulation is a pre-flight failure detector, not a security control** — a 20× open simulates perfectly, and a compromised frontend controls the simulation call, the comparison, and the rendering. The only genuine trust boundary is the wallet, which renders ABI args as opaque bytes.
- **A full-group assertion runs immediately before the signature prompt** — not merely an asset-movement check. **Be honest about what this is:** a compromised frontend controls the assertion code, the comparison, and the confirm screen, exactly as it controls simulation. The assertion is defence-in-depth against construction *bugs* and against compromise confined to the group-building path — **not** a defence against the full frontend compromise this table names as the dominant risk. Controls that actually raise that bar are reproducible builds with published hashes, subresource integrity, a pinned deployment bundle, and pushing Ultrade for wallet-side ARC-aware rendering of PEX calls. Those belong in [Build Order](#build-order), not only in prose. See **[The full-group assertion](#the-full-group-assertion)** below for exactly what is checked.
- Builder address is a build-time constant, not a runtime value from any API response.
- **All PEX application IDs and asset IDs are build-time constants.** See [Critical: pinned deployment](#critical-the-backend-supplies-fund-destinations).

### The full-group assertion

Asset movements alone are not sufficient. `open_or_increase` takes **no collateral argument** (`src/transactions.ts`), so leverage is `sizeUsdDelta ÷ transfer amount` and `sizeUsdDelta` is a free frontend integer: a screen showing "Low, 5×" can send 20× while the transfer remains exactly $50 of the right asset to the right place. Every field below is verified against what the confirm screen displayed, immediately before the signature prompt.

**Asset movements — every transfer, by `(asset, amount, receiver)`:**
- The collateral axfer: expected asset, **expected amount**, receiver `getApplicationAddress(PINNED_TRADING_APP_ID)`
- The take-profit keeper-fee escrow: `v2OrderEscrowAmount` returns `keeperFeeAmount` verbatim for decrease kinds (`src/transactions.ts`, `6390-6396`) and **the SDK validates it nowhere**. Unbound, a compromised frontend escrows the wallet's entire USDC balance to a legitimately pinned address, and no ABI check sees it. Bound it by **both** a multiple of the displayed fee **and** an absolute constant: `escrow <= min(2 × displayedKeeperFee, MAX_KEEPER_FEE_ESCROW_USDC)`. A ratio alone is not a control — both sides of it come from the frontend, so an attacker displaying $400 and escrowing $800 passes. The ratio is a bug detector; the absolute cap is the control.
- Every storage/MBR payment, against pinned constants

**`open_or_increase` args** — the real tuple is `[marketId, side, sizeUsdDelta, acceptablePrice, [builderAddress, builderFeeBps], oracleMessage, oracleSignature]` (`src/transactions.ts`). There is no `collateralAssetId` and no `outputSwapMode` on this call:
- `sizeUsdDelta / collateralAmount` equals the **displayed leverage** exactly — not merely that it falls inside a permitted range
- `marketId`, `side`
- `builderAddress == BUILDER_ADDRESS` and `builderFeeBps == POSITION_BUILDER_FEE_BPS` (assert **equality**, per Invariant 7 — `<= 10` catches nothing, since `normalizeBuilderFee` already throws above the cap at `src/transactions.ts`)
- `|acceptablePrice − displayedIndexPrice| / displayedIndexPrice <= userSlippageBps` (the SDK validates only that it is a positive Price12 — there is no upper bound on looseness)

**`open_or_increase` — add-margin variant.** "Add collateral" is `buildV2AddPositionMarginCall`, which calls `open_or_increase` with **`sizeUsdDelta = 0`** and a **zero** builder-fee cap. Assert `sizeUsdDelta == 0`, `builderFeeBps == 0`, and bound the collateral by the axfer alone; the leverage-ratio rule does not apply since it evaluates to 0. *(For later: `buildV2WithdrawPositionMarginCall` uses `decrease_or_close` with `sizeUsdDelta = 0` and carries the withdrawal amount in the **`minPrimary`** slot — so the `minPrimary == minSecondary == 0` rule is wrong for that path if partial withdrawal is ever surfaced.)*

> **Retracted, same day it was written: there is no close-path blocker.** This document briefly claimed the close group could not be built without a PEX backend. That was wrong, and the error is worth keeping because of how it happened.
>
> `buildV2DecreaseOrCloseTransactions` did throw `insufficient_large_program_read_budget_capacity` — but because the *inputs were wrong*, not because of an architectural limit. The call omitted `indexAssetId` / `longAssetId` / `shortAssetId` and used `minPrimary` / `minSecondary` where the builder reads `minPrimaryOutput` / `minSecondaryOutput`. Starved of those, the SDK could not populate the resource carriers whose nested reference capacity funds the `["markets","trading"]` large-program budget, so the check failed at 8/8 refs with nowhere to spill.
>
> **With correct inputs it builds with no backend at all:** 3 transactions — `decrease_or_close` plus two Math carriers — at `yieldRecallMode = 0` with zero receipt caps, and `assertCloseGroup` passes on the real group. Measured 2026-09-24.
>
> The method was the failure: a reference-budget symptom was traced to the first plausible cause in the call chain and written up as a finding without first varying the inputs. **Prompted by the observation that Mallow_SoftDefi trades on PEX today** — evidence that closing plainly works — which is what sent this back to a controlled test. A dependency claim of that size needed a negative control before it was recorded, not after.
>
> **What remains true, and is a question rather than a blocker:** `prepareV2DecreaseOrCloseInput` really does call `client.v2MarketYieldActionRecallPlan()` and `client.v2MarketYieldResourceRegistry()`, both backend endpoints. All it supplies is `yieldRecallMode` and the two receipt caps. Ultrade's position is that *"the contract withdraws from yield only when the market needs it at execution time"*, so a close at recall mode 0 should settle from pool balances whenever the market is not short of them. **Open: confirm what a mode-0 close does when the pool has lent out enough that a recall is actually required** — settle from what is on hand, or reject. That decides whether preparation is optional or merely usually-unnecessary, and it is answerable by simulation against a real position.

**`decrease_or_close` args (0.6.2, 15)** — `[marketId, collateralAssetId, side, sizeUsdDelta, acceptablePrice, outputSwapMode, minPrimary, minSecondary, [builderAddress, builderFeeBps], oracleMessage, oracleSignature, yieldRecallMode, maxLongReceiptAmount, maxShortReceiptAmount, expectedPositionId]` (`src/transactions.ts`).
- **`expectedPositionId` must be a real id, never the wildcard.** `expectedClosePositionId(undefined)` yields `(1n << 64n) - 1n`, which closes whatever position occupies the key. Valid range is `0 ≤ id < 2^48`. **There is no collateral transfer on this path, so the leverage ratio is undefined and `sizeUsdDelta` has no binding check unless asserted directly:**
- `sizeUsdDelta` equals the displayed close size exactly — and `== position_size_usd` for a full close. Without this, a compromised frontend shows "close my Perps" and sends a partial decrease: the user believes they are out, they are still exposed, and their take profit is now unexecutable via `reduce_size_exceeds_position` until the position grows back
- `outputSwapMode == 0`, and `minPrimary == minSecondary == 0` given mode 0
- `yieldRecallMode`, `maxLongReceiptAmount`, `maxShortReceiptAmount` against the values from `prepareV2DecreaseOrCloseInput`

**Group-wide:** box references, `foreignApps`, `foreignAssets` and `accounts` on every app call against expected values — `open_or_increase` carries **no `collateralAssetId` arg**, so the collateral asset is determined solely by the axfer and by `v2TradingLocalBoxes`, i.e. a box reference; note also `accounts: builderFeeBps > 0n ? [builderAddress] : []` (`:2090`). Plus: no `rekeyTo`, no `closeRemainderTo`, no `assetCloseTo` on any transaction; total fee below a cap; and every transaction is either an enumerated economic leg or an app call to a **pinned** PEX app ID with a **pinned** selector, sender == user. (A fixed transaction count is not assertable — settlement-maintenance calls, the trading resource carrier, yield-freshness carriers and the `builderFeeBps > 0n` dynamic-OI carrier all vary with pool state.)

**`submit_linked_order` args (0.5.0, 24 positions)** — `src/transactions.ts`. Two new fields, `expectedPositionId` and `entryGroupOffset`, sit between `linkBaseOrderId` and the builder tuple: `ownerOrderId, orderKind, targetKind, marketId, side, collateralAssetId, sizeUsdDelta, collateralAmount, triggerPrice, acceptablePrice, keeperFeeAssetId, keeperFeeAmount, outputSwapMode, minPrimary, minSecondary, timeInForce, expiryTime, linkMode, linkBaseOrderId, [builderAddress, builderFeeBps], oracleMessage, oracleSignature`. **This leg is on every single Perps, so assert all of it:**
- `triggerPrice` equals the displayed target **exactly**. Unasserted, a frontend shows $0.12 and submits $0.40 — never fires, user believes they are protected
- `sizeUsdDelta` equals the post-open (or post-increase) position size
- `acceptablePrice` within `userSlippageBps` of `triggerPrice`. `v2OrderPriceCoherenceFailure` only checks the *side*, with no distance bound — a loose value lets the keeper fill arbitrarily far from the target
- **`builderAddress == BUILDER_ADDRESS` and `builderFeeBps == POSITION_BUILDER_FEE_BPS` on the child specifically.** `V2AttachedOrderLegInput` carries its **own** `builderFee` (`:627`) and `v2AttachedChildInput` spreads `...parent, ...leg`, so a leg-level value **overrides the parent's**. A compromised frontend points the child's fee at an attacker: 10 bps of close notional, deducted inside PEX from proceeds, **with no transfer in our group** — invisible to every asset-movement check
- `keeperFeeAmount == CHILD_KEEPER_FEE_USDC` and `> 0`
- `timeInForce == GTC` and `expiryTime == 0` (Invariant 10 — the SDK default is correct, an override is not caught)
- `outputSwapMode == 0`, `linkMode`, `linkBaseOrderId`, `collateralAssetId`
- **`expectedPositionId` / `entryGroupOffset`** — the binding pair, and the rules are exact (`v2OrderSubmissionBinding`, `src/transactions.ts`):

  | Case | Required values |
  |---|---|
  | Same-group open + attached TP (Perps's normal path) | `entryGroupOffset` = **(index of the TP's `submit_linked_order`) − (index of `open_or_increase`)**, range 1–15; `expectedPositionId` = 0 |
  | TP re-placed onto an existing position (increase flow) | `entryGroupOffset` = 0, `expectedPositionId` = the live id — **the SDK throws if omitted** |
  | `OPEN_LIMIT` or `CHILD_WAIT_PARENT` | both 0 |

  Assert the pair matches the flow. A mismatch is how a bracket ends up bound to the wrong position lifetime.

  > **`entryGroupOffset` — measured on a real group, 2026-09-24, and this replaces a callout that was itself misleading.**
>
> Built `open + attached TP` against MainNet: 9 transactions, `open_or_increase` at index 1, `submit_linked_order` at index 7, and the encoded **`entryGroupOffset` is 6** — exactly `tpIndex − openIndex`, which is what the table above says.
>
> The previous callout cited the source expression `entryGroupOffset = transactions.length + 2 − entryTransactionIndex` and warned that reading it as a simple index difference would "reject **every** valid Perps group". That is backwards in practice. The expression is correct, but `transactions.length` is the length **at the moment the leg is appended** (5 here, the open parts only), not the final group length. Read with the final length it yields 10 and rejects every valid group — the exact failure the callout was warning about, caused by the callout.
>
> **Assert it as the distance between the two transactions in the finished group**, which is directly observable and needs no knowledge of append order: `entryGroupOffset == indexOf(submit_linked_order) − indexOf(open_or_increase)`, range 1–15. Confirmed alongside `expectedPositionId = 0`, `linkMode = 3` (CHILD_ACTIVE), `timeInForce = 0`, `expiryTime = 0`.
>
> Also measured on the same group, both matching this document: keeper-fee escrow **100,000 µUSDC** and order-box MBR **99,700 µALGO** (not the legacy 96,500).

> `encodeAppArgs` packs everything from index 14 onward into a trailing tuple when there are more than 15 args (`src/transactions.ts`) — 22 args triggers this, and the packing boundary comes from the **manifest's** arg type list. The assertion must decode the packed tuple, which makes the manifest hash pin load-bearing for this leg.

**The take-profit leg additionally:** `quoteV2DecreaseOrder({...childInput, market, prices}).submission_result !== "execute_immediately"`, with `market`/`prices` derived from the group's own oracle message. See [Take profit](#take-profit--mandatory-one-per-position) — PEX does **not** validate a target against the market, and a wrong-side target executes immediately rather than never.

---

## CRITICAL: The Backend Supplies Fund Destinations

**The claim that a read-only backend cannot cause fund loss is false, and it was the most consequential error in an earlier draft of this document.**

The SDK obtains every PEX application ID and asset ID from the backend (`loadPdexContext` → `resolvePdexV2AppRefs`). The collateral transfer's destination is then *derived* from one of them: `makeTokenTransferTxn(sender, getApplicationAddress(input.v2TradingAppId), ...)` (`src/transactions.ts`, `6301`).

An attacker who compromises, MITMs, or cache-poisons the read backend returns an attacker-controlled app ID. The frontend builds a group the wallet renders as a normal transfer to an application address. Simulation succeeds — the attacker's app accepts the transfer. And the asset-movement assertion **passes**, because it checks against `getApplicationAddress(v2TradingAppId)` derived from the same poisoned source. `loadDeploymentManifestFromUrl` (`src/manifest.ts`) performs no signature check, no pinning, and no version assertion.

Impact: total loss of collateral for every open initiated during the compromise window, with no frontend compromise required.

**Required:**

- Pin `PDexV2Trading`, `PDexV2Markets`, `PDexV2OrderOps`, `PDexV2TradingRiskOps`, `PDexV2Math` and the ALGO/USDC asset IDs as **build-time constants**, alongside `BUILDER_ADDRESS`.
- Treat the deployment manifest as **advisory**: fetch it, assert every ID equals its pinned constant. A PEX redeploy must require an MS release, never a JSON edit.
- **Degrade in two states, not one.** A redeploy does not migrate existing positions — they stay in the *old* app, which is the one we pinned. A blanket hard-fail would strand every open position at the moment the protocol is in flux. So on mismatch: **block all opens and increases**, and **keep close, partial close, add-collateral and cancel-order live against the pinned IDs**, with a banner. Whether PEX migrates state on redeploy is an [Open Question](#open-questions).
- **Pin the ABI, not just the IDs.** This is the half an earlier draft missed. ABI *encoding* does not use pinned constants: `buildAppCall` calls `encodeAppArgs(appName, methodName, args, manifest)`, and `method.signature` and each `args[].type` come from the **protocol manifest** fetched by `loadManifestFromUrl` → `GET /v2/protocol` (`src/manifest.ts`) — also unsigned, unpinned, unversioned. An attacker controlling that manifest controls the encoder *and* the decoder, so the full-group assertion round-trips through a poisoned spec and passes while the bytes mean something else to the real app. The same manifest decodes `mp2:`/`mo2:`/`mf2:`/`ma2:`, so every displayed quote, liquidation price and buffer is simultaneously theirs.
  **Required, in this order:** (a) pin a **SHA-256 of the whole protocol manifest** as the primary control — one constant, covering every method and every box format, impossible to enumerate incompletely. **Specify the bytes:** `loadManifestFromUrl` consumes and discards the raw response (`src/manifest.ts`), so either fetch with `.text()` and parse yourself (the hash then covers whitespace and key order, and a cosmetically reformatted PEX manifest hard-blocks all opens) or hash a canonical re-serialization under JCS. Pick one and state it, or the pin is not reproducible; (b) additionally embed the `signature` string and arg type list for `open_or_increase`, `decrease_or_close`, `submit_linked_order` and `cancel_order`, deriving selectors locally. Per-method pins alone are insufficient: the group also contains `fund_storage`, one to four `PDexV2Math.noop` carriers, OrderOps budget carriers and `PDexV2AdminOps` settlement-maintenance calls, all encoded through the same path — so a poisoned manifest could aim a call at a *different method* on a correctly-pinned app. A hash pin means a legitimate PEX manifest revision requires an MS release, the same trade already accepted for app IDs.
- **Pin the oracle signer public key as a build-time constant.** **Obtained 2026-09-21** — readable on chain from `PDexV2OrderOps` (3690309166) global key `"oc"` (`b2M=`), first 32 bytes of the value, and cross-checked against `PDexV2Trading` (3690309160) global key `"q"`, which carries the identical 48 bytes:
  ```
  4cc6bcc8c281d1e1b5eec887adc373fee95f6e580125132e72303618d2e3dffb
  ```
  The trailing 16 bytes of that entry are `0x1e` (30) and `0`, consistent with the ~30-second payload validity window observed on the artifact CDN — i.e. **the freshness tolerance appears to be on-chain configuration, not merely a publishing convention.** Confirm by simulation before relying on it. `oraclePayloadFromBackend` copies `pubkey` straight out of `payload.pubkey_hex` (`src/oracle.ts`) and `verifyOraclePayload` verifies against whatever it is handed — checking that a message signed itself. Note there is **no SDK path to read the signer key from chain**, so "read it from on-chain state" is not implementable today; see [Open Questions](#open-questions).
  Additionally assert, on every payload decoded via `decodeV2OracleSnapshotMessage`: `targetAppId == PINNED_TRADING_APP_ID`, `genesisHash == mainnet`, `magic == PDX2`, `messageVersion == 3`, and `publishedAt` within `ORACLE_MAX_AGE_SEC`.
> **Ultrade indicate no app ID change is expected from the current version.** That does not relax this section — it reweights it. If IDs are stable, the deployment-manifest mismatch check will essentially never fire, and **every** protocol change reaches us through the upgrade path instead: same application ID, new approval program. Program-hash monitoring is therefore the primary change detector, not a supplement to ID pinning. ID pinning remains worth keeping as cheap insurance against a redeploy nobody is planning.

- **Pin the approval program hash, not only the application ID.** An Algorand app *update* replaces the program while keeping the same ID — and that is the change mechanism actually observed: `PDexV2Trading` was updated 2026-09-12 (see [PEX.md](./PEX.md#governance-and-upgradeability)). Pinned IDs, the manifest-mismatch check, and pinned ABI signatures all key on identifiers that an upgrade leaves untouched, so an upgrade that changes settlement, margin or payout logic trips **none of them**. Record the SHA-256 of the approval and clear programs for `PDexV2Trading`, `PDexV2OrderOps` and `PDexV2TradingRiskOps` at release; poll `GET /v2/applications/{id}`; on a hash change enter the same two-state degradation as a manifest mismatch and alert. This costs nothing, needs nothing from Ultrade, and is fully compatible with assuming good faith — it observes the event, it does not impute motive.
- **Pin every app the SDK resolves**, not just the trading path: `PDexV2AdminControl`, `PDexV2AdminOps`, `PDexV2SwapOps`, `PDexV2SingleTokenOps`, `PDexV2SingleTokenTrading`, `PDexV2CvaVault`, `PDexV2MarketYieldVault`, `PDexV2MarketXAlgoYieldVault` — `resolvePdexV2AppRefs` reads them all from the same backend map (`src/integration.ts`) and several appear in `foreignApps`.

---

## Operating Model

Magnet Strategies operates:

- **The frontend.** Route `web/src/app/perps/`, inside the existing app and connect-wallet flow.
- **A read backend.** Required for the PEX protocol manifest (`GET /v2/protocol`) and for decoding market boxes. This is the one unavoidable server dependency.
- **A notification service.** Duration reminders and ADL alerts. No authority over funds.
- **No keeper with signing authority** in v1. See [Duration](#duration-the-hard-problem).

Magnet Strategies does **not** operate: the exchange, the price oracle, the liquidation network, or the order-execution keepers. All four are PEX.

---

## Constants

PEX-side constants are listed in [PEX.md](./PEX.md#verified-parameters) and are **TestNet values**. MainNet risk configuration is undocumented and must be read live. Nothing in this spec may hardcode a PEX risk parameter.

Perps-side constants:

| Constant | Value | Notes |
|---|---|---|

| `MAX_POSITION_NOTIONAL_USD` | `min(MAX_PLAUSIBLE_NOTIONAL_USD, 50% × live per-side OI headroom)` | **The cap is on resulting merged position notional, not on a purchase.** Evaluated identically in the purchase flow and the increase flow. *(An earlier draft capped units per band. That bound a single purchase, was bypassed by the increase flow since positions merge, and delivered rising notional across bands — the opposite of its stated rationale.)* |
| `MAX_PLAUSIBLE_NOTIONAL_USD` | 25,000 | **A tripwire, not a product cap.** The fixed 250 launch ceiling was removed 2026-09-24 — see below. This sits far above any plausible solved value and exists only so a decode or arithmetic bug cannot render an absurd right-hand end. If it binds in normal use, something upstream is broken. |
| `RISK_BAR_MIN_LEVERAGE` | **solved live** | `max(min_position_size_usd, dynamic_min) / amount`. **Never a constant** — a pinned 1× sat above the ceiling on the short side today |
| `RISK_BAR_MAX_LEVERAGE` | **solved live** | `min(N_margin, OI_headroom, MAX_POSITION_NOTIONAL_USD) / amount`, confirmed by a live quote returning `ok === true`. Never `10000 / initial_margin_bps`, and never the raw `effective_max_leverage_bps` — that field omits the fee term |
| `PROTECTION_ENABLED` | **`false` — BLOCKED** | Not a size check: open + both brackets measures 13 against a ceiling of 16 and always fits. Blocked on the unverified OCO symbols — see [Protection](#protection--an-optional-stop). Do not plan work against it |

| `BUILDER_ADDRESS` | MS treasury | Build-time constant |
| `POSITION_BUILDER_FEE_BPS` | 10 | Protocol cap is 10 |
| `SWAP_BUILDER_FEE_BPS` | **0** for forced conversions | See [Revenue](#revenue) |
| `DEFAULT_SLIPPAGE_BPS` | 50 | User-adjustable, disclosed |
| `MAX_KEEPER_FEE_ESCROW_MULTIPLE` | `min(2× displayed, MAX_KEEPER_FEE_ESCROW_USDC)` | **Required.** `v2OrderEscrowAmount` returns `keeperFeeAmount` verbatim for decrease kinds and the SDK validates it nowhere (`src/transactions.ts`). Because the take profit is now mandatory, **every** Perps carries this transfer — so an unbounded value means a compromised frontend can escrow the wallet's entire USDC balance to a correctly-pinned OrderOps address, past every asset-movement check, on every open. |
| `CROSS_MARGIN_BPS` (ε) | 50 initial | Minimum distance a take-profit trigger must sit from the crossing bound. Perps positions price movement in the ≤`ORACLE_MAX_AGE_SEC` window between `publishedAt` and submission. **Provisional** — derive from `ORACLE_MAX_AGE_SEC` × measured ALGO volatility in Build Order step 2. At a 2.3% buffer this is not a rounding detail. |
| `CHILD_KEEPER_FEE_USDC` | **read live**, floor 0.10 | **Required and non-zero.** `v2AttachedChildInput` defaults `keeperFeeAmount` to `leg.keeperFeeAmount ?? rawParent.childKeeperFeeAmount ?? rawParent.keeperFeeAmount ?? 0` (`src/transactions.ts`), and `childKeeperFeeAmount` is **optional** on the open-with-attached-orders input. Leave it unset and the escrow is 0 — producing an order that passes every assertion, renders as armed, and **no keeper will ever execute**, silently removing the product's only automated upside exit. Nothing in the SDK enforces a minimum, but the contract does: `PDexV2OrderOps` global key `op` carries `min_keeper_fee_usd = 50_000` (\$0.05), `max_gtd_expiry_seconds = 2_592_000`, `max_order_size_usd = 1e12`. **These are admin-mutable order policy, so read them live per Invariant 8** — if the minimum is raised above our constant the escrow silently produces the never-executed order described above. |
| `MAX_KEEPER_FEE_ESCROW_USDC` | 0.50 | Absolute cap on the escrow transfer. |
| `ORACLE_MAX_AGE_SEC` | 20 | Reject quotes on payloads older than this. A deliberate conservative pin against PEX's ~30s window. Invariant 8 governs PEX *risk parameters* — margin, caps, fees, funding share, utilization — and payload age is not one, so no exception is needed. **Specify a re-fetch/re-quote loop**: hardware-wallet and mobile deep-link signing round trips routinely exceed 20s, and blocking at the prompt would fail for a meaningful share of users. |

---

> `MAX_POSITION_NOTIONAL_USD` is a **product guardrail with no on-chain enforcement** — a user can always go to PEX directly. It is not counted as a security control.
>
> **The PnL-cap and reserve terms were removed, because neither binds.** An earlier draft took a percentage of "trader-PnL-cap headroom", which is not a quantity that exists — `checkTraderPnlCap` recomputes a ceiling on *each close's own profit payout* against the side pool; it is not a consumable allowance, and at any size this product reaches it is unreachable (a 100% move on $250 pays $250 against a $717 ceiling). Reserves do not bind either: measured, `long_reserves_exceeded` binds near **$4,250** and `short_reserves_exceeded` near **$7,300**, both far above `max_open_interest`'s **$1,500** — though they close that gap each time PEX raises the cap, and at $4,250 the long side is now less than 3x away. **OI headroom is the only live constraint**, which makes the formula both simpler and honest.
>
> **It still needs a floor.** The share can fall below anything sellable: at the low point of 2026-09-23, ALGO/USD short headroom was **$46.56**, and even at the current 50% share that is $23 of notional against a $5 minimum position — one more bad hour and it is unopenable. When the solved ceiling falls under the minimum viable order the UI must say the side is full, not offer an amount that cannot open. `solveBar` returns `open: false` for exactly this case; render it as closed.
>
> **It is deliberately a function of live state, not a constant.** PEX is early and thin; a fixed cap either blocks users today or becomes meaningless as depth grows, and updating it by release is a standing tax. Deriving it from live per-side OI headroom means Perps scales with the exchange automatically — which is the point, since bringing flow to PEX is part of why this product exists.

> **The fixed $250 launch ceiling was removed on 2026-09-24, and the measurement is why.** It had never been discussed on its merits, and it was not even the binding term. On ALGO/USD the 20% headroom share was: at $50 collateral the ceiling was $243, which is `0.20 × $1,214`, not the $250. Worse, at $250 of collateral the product delivered **1.0×** — not a leverage product.
>
> The natural ceiling is real and measurable without any cap of ours: **~$1,214 on ALGO/USD and ~$1,340 on BTC/USD**, set by OI headroom, and it rises as PEX deepens. Below roughly $150 of collateral the *margin* term binds first instead, at 11–15×. The five live constraints already bound this; a fixed dollar figure only bound it worse.
>
> What replaced it is one scaling brake plus one alarm. `OI_HEADROOM_SHARE` went 0.2 → **0.5**, and its justification is **availability, not risk**: a single user consuming all remaining headroom closes the side, and the next visitor loads the card to be told the market is unavailable. `MAX_PLAUSIBLE_NOTIONAL_USD` is a tripwire against our own decode bugs, set where it should never bind.
>
> **What was lost, stated plainly:** the fixed cap was the only thing bounding the blast radius of *our own* defects. A solver that overstates or a box decode that goes wrong is now bounded only by the tripwire. This document already notes the cap was never a security control — a user can go to PEX directly — but that argument is about attackers, not about our bugs. Measured after the change: $50 → 11.4× (ALGO) / 13.4× (BTC), $100 → 6.1× / 6.7×, $250 → 2.4× / 2.7×.

---

## Product Model

### Amount

The user types a **USDC amount** — their collateral, and their maximum loss on the position. A `MAX` control fills it from the wallet balance **less the keeper-fee escrow(s)** — `balance − Σ keeperFeeAmount` — otherwise `MAX` always fails the pre-flight check below, twice over with Protection on. There are no fixed unit sizes; an earlier draft sold $10 units and that layer of indirection bought nothing once leverage became continuous.

**Pre-flight balance check is `amount + keeperFeeAmount`**, not `amount` — every position escrows the keeper fee in USDC alongside the collateral, so a user with exactly their stated balance fails on the first open otherwise.

> **Units are a purchase-sizing device only, and there are none now.** The position box key is `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner`, so a wallet holds **one position per (market, side)**. A second purchase on the same side is `open_or_increase` on the existing position — blended entry, blended leverage, and a changed liquidation price on what the user already held. Adding is an explicit flow on the management surface, routed at entry, never a second trip through the purchase screen.

### Risk — a continuum, not named tiers

A single bar. Both ends are solved against live state — see below. The resolved multiple is shown; there are no named tiers and no fixed stops.

**This is a structural answer, not a style choice** — but the arithmetic below is the part an earlier draft got wrong, and it was wrong in a way that made the bar's right end reject for every user on every open. Proven by executing 0.6.2 against live state.

#### The ceiling is not `1 / initial_margin`

Fees are deducted from collateral **before** the margin test:

```
positionCollateralDelta = max(0, collateralAmount − (openFee + builderFee))
initial_margin_breach   if collateralValueAfter < feeFromBps(sizeAfter, effective_initial_margin_bps)
```

Both fees are bps of **notional** — 6 bps open + 10 bps builder — so achievable leverage is `1 / (IM + 0.0016)`, never `1 / IM`. And the dynamic branch compounds it, because `dynamicBps` is computed on `sideOiAfter`, **including the user's own new size**: leverage depends on order size which depends on leverage.

> **Solving that fixed point on `effective_max_leverage_bps` is necessary but *not sufficient*.** An earlier draft required exactly that and still overshot, because the field itself carries no fee term. Executed: LONG at live OI solves to 12.484× and rejects; the true maximum is **12.240×**.

**Closed form.** With `C` = collateral in USD, `OI0` = current side OI in USD, `f = (open_fee_bps + builder_fee_bps) / 10000`, `IM0` = baseline initial margin as a fraction, and **`k = doi_factor / 1e6`** for that market:

```
baseline branch   N ≤ C / (IM0 + f)
dynamic branch    N² + N·(OI0 + 10000·f/k) − 10000·C/k = 0
                  N = [ −b + √(b² + 40000·C/k) ] / 2      where b = OI0 + 10000·f/k
margin ceiling    N_margin = min(both branches)
```

> **`k` is not optional.** `dynamicBps = (sideOiAfter × factor) / V2_MATH_FACTOR_SCALE` with the scale at 1e12, so the "≈ side OI in whole dollars" shortcut holds only where `factor = 1e6`. **ALGO/USD is 1,000,000; BTC/USD is 641,026.** Omitting `k` understates BTC's ceiling by ~20% — safe but wasteful — and **overstates** it on any market with a factor above 1e6, which returns `initial_margin_breach`: the exact failure this section exists to prevent. Factors are admin-mutable (Invariant 8), so read per market.

Verified by execution across 218 randomised cases (`OI0 ∈ [0, 2500]`, `C ∈ [5.30, 900]`) at `k = 1`: **zero overstatements**, worst understatement **$0.43**, always conservative. The single reference point reproduces exactly — `OI0 = 189.10, C = 50` → $611.95 against $612.00 by binary search. Branch selection `min(both)` is correct because `effectiveBps = max(…)` requires both constraints to hold, and the discriminant `b² + 40000·C/k > 0` for all `C > 0`, so the root is always usable.

#### One ceiling expression — five constraints, not three

An earlier draft named three and **two of the missing two bind first**, each reproducing the exact defect this section was rewritten to eliminate: a bar that renders with a valid-looking right end where every point on it rejects.

```
L_max = min( N_margin , N_collateral , N_slippage , OI_headroom , MAX_POSITION_NOTIONAL_USD ) / C
```

**`N_collateral` — the minimum-collateral floor is a ceiling on notional.** `quoteV2OpenPosition` computes `collateralValueAfter = C − (openFee + builderFee)` and *then* tests it against `risk.min_collateral_usd`. Fees are bps of notional, so:

```
N_collateral = (C − min_collateral_usd) / f
```

At `C = $5.00` — the documented minimum, and what `MAX` produces from a small wallet — **nothing opens at any size**. Measured, LONG, live market:

| C | ceiling without this term | true maximum | reason at the old ceiling |
|---|---|---|---|
| $5.00 | $96.90 (19.4×) | **nothing openable** | `collateral_too_small` |
| $5.01 | $97.09 | **$6.25** (1.25×) | `collateral_too_small` |
| $5.05 | $97.87 | $31.25 | `collateral_too_small` |
| $5.20 | $100.78 | $100.78 — margin takes over | ok |

Predicted matches binary search to the cent. **State a minimum amount:** `C > min_collateral_usd + f × max(min_position_size_usd, dynamic_min)` ≈ **$5.008** today, read live.

**`N_slippage` — price impact is charged before the slippage test, and it is large.** `positionImpactForOi` with both exponents at 1 reduces to a **flat 55 bps of notional** on ALGO/USD for any open that worsens the long/short imbalance. Favourable-side impact is separately capped by `position_impact_pool_qty` (~$1.21 total today), so it is **not symmetric**.

> **At `DEFAULT_SLIPPAGE_BPS = 50` anchored to the index, the ALGO/USD short side is unopenable at every size and every collateral amount today** — a $5 short needs ≥100 bps to clear — and on a balanced book **both** sides fail. Measured across the live, balanced and long-heavy books.
>
> **Fix: anchor `acceptablePrice` to the quoted `execution_price`, not to the index.** Verified: at 50 bps, index-anchored short returns `false`, execution-anchored returns `true`. Then surface impact as its own cost line, and treat the user's slippage as tolerance *on top of* impact rather than inclusive of it.
>
> This was missed because the original verification binary-searched with `acceptablePrice` effectively disabled. **`price_slippage` belongs in the list of things the confirming quote can return on the open path**, not only on close.

> **The constraint set is complete — verified by exhaustive enumeration, 2026-09-23.**
>
> Three consecutive audit passes each found a missing constraint, every time because the verification started from the list already written rather than from the code. This check inverted that: enumerate every reason `quoteV2OpenPosition` can push, *then* diff against what is documented.
>
> It pushes **12 reasons directly** and calls `checkOiAfter` and `checkReservesAfterTrade`. Swept 846 `(collateral, notional)` pairs from $5 to $200 collateral at 0.2×–40× — 568 opened cleanly — and **exactly one reason appeared that is not in this list**: `position_health_breach`, 47 times, **never alone**; it is always accompanied by a documented constraint, so it is dominated rather than independent.
>
> The remaining reasons are not ceilings: `fee_exceeds_collateral` is dominated algebraically, since `(C − min_collateral_usd)/f < C/f` for any positive minimum, and never fired in the sweep; `impact_consumes_size` never fired in 846 pairs — at a 55 bps impact factor it would require negative impact to exceed the whole base size, reachable only where integer rounding kills a tiny order, so it is floor-side; `top_up_required` is increase-flow cost settlement; `builder_fee_not_allowed_for_margin_only` belongs to the add-margin variant; `acceptable_price_required` is input validation.
>
> **Method note worth keeping:** derive the constraint set from the failure paths in source, not from the set already believed. The three Criticals this replaced were each a constraint nobody had thought to test.

**And reserves are a fifth, further out.** `long_reserves_exceeded` binds near **$4,250** of side OI and `short_reserves_exceeded` near **$7,300** — both above the $1,500 `max_open_interest`, so reserves still do not bind. The margin narrowed on 2026-09-23 when the cap went from $960 to $1,500: the long side is now within a factor of three. Ultrade raise the cap deliberately and incrementally against observed liquidity, so this crossover should be expected rather than treated as an anomaly. **`readMarketState` already reads everything the reserve check needs; the solver does not yet include the term.** Add it before the cap reaches ~$3,000.

| Side, $50 collateral | Margin | Collateral | OI headroom | Binding | Ceiling |
|---|---|---|---|---|---|
| LONG | $611.95 | $28,125 | $770.90 | margin | **12.24×** |
| SHORT | $381.43 | $28,125 | **$46.56** | OI cap | **0.93×** |

*(Both rows assume slippage is anchored to execution price. Index-anchored, the SHORT row is unreachable at any size — see `N_slippage` above.)*

> **This rule was violated by the first card, and the failure looked exactly as predicted — 2026-09-24.** The card mapped the risk bar onto `solveBar`'s raw ceiling. The ceiling itself is right: binary search against the SDK agrees with it. But offering it *exactly* means converting it to micro-units rounds up by a unit or two, and the quote returns `initial_margin_breach`. Measured at $10 collateral on ALGO/USD: the bar's top read 19.38x and the chain refused it, while $20 collateral was fine — so it presented as an arbitrary small-amount bug rather than a boundary condition.
>
> Fixed by mapping the bar onto `confirmCeiling`'s result instead of `solveBar`'s. That is cheap enough to do on every keystroke because `quoteV2OpenPosition` is local — there is no network call in the confirm loop. Verified afterwards: 21 bar positions from 0.00 to 1.00, both sides, both markets, at $5.50/$10/$25/$100 — **every one quotes `ok`**.
>
> The residual gap is the deliberate step-down: the confirmed ceiling lands at **19.19x** against a theoretical **19.38x**, about 1% of the range. That is the cost of not shipping a bar whose top rejects, and it is the right trade.

**Then step down one UI tick, and confirm by quoting the resolved size and requiring `ok === true` before enabling the right end.** Do not ship the closed form as the only gate — `dynamic_min_position_size_usd`, `position_quantization` and `impact_consumes_size` also sit on this path.

> **The feasible set is an interval, not a prefix — found 2026-09-23 while verifying the solver against the SDK.**
>
> Sizes *below* `min_position_size_usd` reject exactly as sizes above the ceiling do, so feasibility is `[floor, ceiling]` and not `[0, ceiling]`. A binary search seeded at zero halves `hi` straight past a narrow window and concludes the side is closed: at `C = $5.01` it reported **$0 openable where the true maximum is $6.25**, the value this document already records from an independent measurement.
>
> The first verification run reproduced this as a fake "overstatement" in the solver. The solver was right and the harness was wrong. **Any size search — ours, or a future one — must seed from a known-feasible point rather than from zero.**

#### The floor must be solved too

```
L_min = max(min_position_size_usd, dynamic_min_position_size_usd) / C
```

> **An earlier draft pinned `RISK_BAR_MIN_LEVERAGE = 1×` — a hardcoded fixed multiple, in the same change that removed fixed multiples on the grounds that they cannot always be delivered.** At $50 on the short side today, 1× is $50 of notional against $46.56 of headroom: it fails `short_oi_cap`, while 0.93× succeeds. The floor sat **above** the ceiling and no position on the bar was valid.

**When `L_min > L_max`, the side is closed.** Render it as such — do not show a bar with no valid range.

#### Field units

`effective_max_leverage_bps = (V2_BPS × V2_BPS) / effectiveBps` — it is **leverage × 10,000**, so 20× reads as `200000`. Read it as a multiple only after dividing.

#### Requirements

- **Resolve from the quote, never from `initial_margin_bps`**, which is only the baseline. Read `doi:` from **`PDexV2TradingRiskOps`** alongside the market boxes; without it every quote pushes `dynamic_oi_margin_missing`.
- **Read the `doi:` factor per market.** It is not a constant: ALGO/USD is 1,000,000 and BTC/USD is **641,026**. The "`dynamicBps` ≈ side OI in whole dollars" shortcut holds only on ALGO/USD.
- The bar trades reward against survival in both directions — more leverage means a larger payout at target *and* a nearer liquidation. That tension is the control's whole content.

### Direction

**Long** — *betting ALGO goes up* — and **Short** — *betting ALGO goes down*. Stated as the direction of the bet, not as protection.

> An earlier draft framed these as `Protect against a drop` / `Protect against a rise`. That was dropped: protection framing forces the user to hold two models at once — their own exposure, and an instrument that moves opposite to it. Long and short are **one step**, and the user arriving at a leveraged product already knows which way they think the price goes.

### Duration

`24 hours · 72 hours · 1 week · Until I close`. **In v1 this sets a reminder, not an enforced close.** See below — the wording constraint is a correctness requirement, not a copy preference.

### Take profit — mandatory, one per position

**Every Perps carries exactly one take-profit order. There is no stop loss.**

The take profit is a native PEX order kind (`DECREASE_TAKE_PROFIT`), stored on-chain in an order box and executed by **PEX's own keeper network**. It needs no keeper of ours and grants us no authority.

**Set by ALGO price, not by percentage.** `trigger_price` is a price in the protocol, so setting it directly removes a conversion step — and every conversion is somewhere a display bug can hide. It also matches how people actually hold targets ("take profit if ALGO hits $0.12").

> **CRITICAL — validate the direction client-side. PEX will not.** `v2OrderPriceCoherenceFailure` (`src/transactions.ts`) compares `acceptablePrice` against `triggerPrice` **only**. It never sees the market price, the index range, or the position's entry, so a target on the losing side passes its check cleanly.
>
> And such a target does not sit dormant — it **executes immediately**. `v2OrderCrossedByOracle` (`src/transactions.ts`) defines crossing for a take profit as `indexMin >= trigger` (long) and `indexMax <= trigger` (short). A short-side target placed *above* spot is therefore crossed **at submission** — and it is worse than a keeper picking it up later: `v2SubmitOrderFlatFee` charges the inline-execution fee when crossed (`src/transactions.ts`) and `submissionResultFor` returns literally `"execute_immediately"`. **The open and the close land in the same group the user signs.**
>
> The user opens and closes within minutes, paying open fee + close fee + builder fee **twice** + keeper fee: roughly **$0.69 on a $10 unit at 20×, about 7% of committed capital, instantly** — and Magnet Strategies is the beneficiary of the error. Because the take profit is mandatory and we pre-fill a default, a sign error in the prefill or the direction mapping hits every user.
>
> **This is the only control that exists.** Assert against the same oracle payload going into the group, not a displayed mid price:
> - short (*betting ALGO goes down*): `trigger < indexMinPrice × (1 − ε)`
> - long (*betting ALGO goes up*): `trigger > indexMaxPrice × (1 + ε)`
>
> with `ε = CROSS_MARGIN_BPS`, so a target one tick from crossing is also refused.
>
> **The stop-loss leg has mirrored semantics and needs its own rules.** `v2OrderCrossedByOracle` for `DECREASE_STOP_LOSS` is `crossed = side === LONG ? indexMin <= trigger : indexMax >= trigger`, so:
> - long stop: `trigger < indexMinPrice × (1 − ε)`
> - short stop: `trigger > indexMaxPrice × (1 + ε)`
>
> A crossed stop executes at submission exactly as a crossed target does — open and close in the same signed group, with the user paying both legs and **Magnet Strategies again the beneficiary of the error**. Worse here: the stop is anchored to a *computed* liquidation price rather than a typed number, so a sign or side error in that computation hits every Protection user at once. A marker constrained by the control is not an assertion.
>
> **Backstop, using an exported symbol.** `v2OrderCrossedByOracle` is declared without `export` (`src/transactions.ts`) and is therefore **not reachable** through `export * from "./transactions.js"` — an earlier draft named it and would not have compiled. Use instead:
>
> ```
> quoteV2DecreaseOrder({ ...childInput, market, prices }).crossed === false
> ```
>
> **Not `submission_result`.** That field returns `"blocked"` for any failure, and a same-group open pushes `position_missing` because the position does not exist yet — so the check would pass on every purchase-flow open while the order was crossed. Verified by execution against 0.6.2.
>
> (`src/v2OrderQuotes.ts`, `:470`, `submissionResultFor` at `:518-523`; asserted for a take profit in `test/v2-order-quotes.test.ts:178`.) Derive `market` / `prices` from **the group's own oracle message** — `analyzeV2NewOrderIntent` is called with no `marketSnapshot` (`src/v2OrderQuotes.ts`), so prices must be supplied explicitly or the check is vacuous.
>
> `decodeV2OracleSnapshotMessage` **is** exported (`src/oracle.ts`) and is a hardcoded 133-byte layout, so it is outside the poisoned-manifest blast radius — the one input to this check that an attacker controlling the manifest cannot touch. See [Invariant 12](#invariants).

**Pre-fill a default target — and choose it deliberately.** A mandatory empty field is friction at the moment the product promises three taps. But a default we pick is *us* choosing, not the user: the ratio of target distance to liquidation buffer determines the outcome distribution, and it does so independently of volatility. For a driftless walk with two absorbing barriers, the probability of touching one first is simply the ratio of the distances — so at a ~2.3% buffer, a target 10% away means the buffer is touched first roughly 81% of the time, and a target 2.3% away is a coin flip.

Show the implied shape next to the field as plain information, the way the liquidation price already is. **Not a warning, not a gate, no confirmation friction** — the user typing their own target is entirely their call. Keep the default modest rather than optimistic, because that is the one number we choose on their behalf.

**Why no stop loss.** Simplicity is the product. Perps is meant to read as a product, not a trade screen, and a forced profit target guides users to realise gains at a point they chose. Active downside management stays with the user via manual close on the management surface — subject to the availability limits below.

> **But "manual close is always available" is false, and with no stop it carries the whole downside story — so state it accurately.** Close is available whenever PEX will accept a decrease, which is most of the time but not: during a market pause; while a yield recall inside the close itself is failing (recall is atomic within the action that needs it, so the action fails with it — though per Ultrade 2026-09-21 a manual close does **not** depend on a *keeper* recall, so this is a per-action failure rather than a shared dependency); when the wallet cannot pay the close group's ~37,000 µALGO flat fee plus carriers; when `price_slippage` rejects in a fast move — the exact move the user needs out of; when `trader_pnl_cap` rejects the payout; or when a partial would breach `position_health_breach` / `collateral_too_small`. And an unavailable frontend or a sleeping user is the same outcome. **There is no exit guaranteed to be available.**
>
> What the product does instead of a stop: make **distance to liquidation** a permanent first-class element and alert when the buffer is consumed past a threshold. That is the stop's function delivered as information rather than as an order — consistent with keeping responsibility with the trader.

**Why the bar runs to the maximum.** The right end of the risk bar is offered, not hidden behind friction. Someone reaching for it is making a deliberate high-conviction call on a short horizon, which is a legitimate use of the instrument, and the product does not second-guess it. What it does instead is make the consequence continuously visible: the liquidation marker slides toward spot as the bar moves, so the cost of the choice is shown rather than argued.

**The accepted trade-off, stated plainly:** with Protection off, **liquidation is the only automated downside exit.** At the top of the risk bar that is a ~2.3% adverse move. Liquidation also costs the user the liquidation fee (up to 0.70% of position size) on top of the loss, where a stop inside the buffer would have returned more and returned it sooner. This is a deliberate product decision, not an oversight — but it makes the **displayed liquidation price a safety-critical element**, not a detail.

**Cost — three separate components, do not conflate them:**

| Component | Source | Amount |
|---|---|---|
| Order box MBR | **import `V2_ORDER_BOX_MBR_MICRO_ALGO` from the pinned SDK — do not hardcode** | **99,700 µALGO** in 0.6.2 |
| Group flat fees | `required_group_flat_fee_microalgos` (µALGO **flat fee only** — it contains no MBR) | varies with carriers |
| Keeper fee escrow | `keeperFeeAmount`, denominated in **the collateral asset**, not µALGO | ≥ $0.05 |

The 100,200 µALGO execution escrow applies to `OPEN_LIMIT` only, never to decrease kinds.

> **The order-box MBR moved and an earlier draft missed it.** 0.6.x declares both `V2_LEGACY_ORDER_BOX_MBR_MICRO_ALGO = 96_500` and `V2_ORDER_BOX_MBR_MICRO_ALGO = 99_700` — but **only the latter is exported**, so import that one and treat the legacy value as documentation; the 3,200 µALGO delta is the `position_id` word added to the order box at the cutover. `v2AttachedChildInput` defaults the storage payment to the **current** value. Hardcoding 96,500 — which this document did, calling it "exact", through two claimed re-derivations — makes the full-group assertion fail on the `pay` leg of every open, and paying 96,500 makes the contract reject the short payment. **Import the constant from the pinned SDK and assert against it.** Both order- and position-box MBR are layout-derived and move at cutover.

**All-in for open plus one take profit: ~0.40 ALGO. With Protection, roughly 0.12 ALGO more** — a second order box plus ~15,000 µALGO of additional flat fees — and a **second keeper-fee escrow in USDC** — order box 99,700 + position box 70,900 + trader box 29,300 + trading flat fee 29,000 + OrderOps flat fee ~14,000 + per-transaction minimums across the group. *(An earlier draft cited 0.193 ALGO — a two-order-box figure compared against an all-in precheck — and later carried the legacy 96,500 into this very sum, three lines under the warning against it. Under-prechecking causes the failure this document calls the most common one.)*

**Benefits of exactly one bracket** — deterministic group size (each bracket is four transactions against a 16-transaction ceiling), no child-order-ID collision (`base+1` / `base+2`), and half the orphan surface below.

**Not guaranteed.** The trigger arms when the *oracle* crosses the level; a keeper then executes and can fill worse in a fast move. Oracle updates are discrete ~30s snapshots, not continuous.

### Protection — an optional stop

**Offered, never mandatory, and only when the group fits.**

A second bracket (`DECREASE_STOP_LOSS`, order kind 3) placed between spot and the liquidation price. It exists because the no-stop-loss decision was made on hedging logic that no longer applies: a hedger manages downside through the asset they hold, and a directional trader holds nothing behind the position. Without it, liquidation is the only automated downside exit — and it fires with equity already at the maintenance margin, then takes up to **0.70% of position size** as a liquidation fee on top.

Worked at $50 and 6×: a stop at mid-buffer returns roughly **$27**; riding to liquidation returns roughly **$5**.

**Optionality is a product choice, not a size constraint.** An earlier draft argued the group might not fit. **Measured, it always does:**

| Group | Transactions |
|---|---|
| open + take profit | **9** |
| open + take profit + stop loss | **13** |

Invariant across ALGO LONG, ALGO SHORT, ALGO-collateral and BTC LONG — zero variance — against `validateGroupTransactionCount`'s throw at **>16**. Each bracket is 4 transactions as stated; the *open* leg is 5, not the 7–11 implied.

> **The conditional gate was therefore dead code**, and dangerous in one direction: implemented against the old 15–19 estimate it would have hidden Protection from **everyone, permanently**. Keep Protection optional because a directional trader may not want a stop, not because the group might not build. `PROTECTION_ENABLED` is a product flag, not a size check.

*(The increase-flow "11–17 transactions" claim inherits the same inflated open-group figure and should be re-measured: 5 + 2 cancel + 4 re-place = 11 by construction. The close path with two brackets is unmeasured — it needs `prepareV2ActionRecall` and live yield state.)*

**Placement needs margin at *both* ends, and re-checking over time.** The stop sits between spot and the liquidation price — past liquidation it never fires, past spot it fires immediately, the same wrong-side hazard as a mis-set take profit with a second order to get wrong. Present it as a marker on the liquidation scale rather than a free price field, so the control expresses the constraint. But "between spot and liquidation" is **not sufficient**:

- **ε is applied at the spot end only.** Nothing keeps the stop off the liquidation boundary, where the liquidator wins the race and the user pays the 70 bps liquidation fee anyway — destroying the ~$27-vs-~$5 case this section rests on. Require a stated minimum buffer above liquidation as well.
- **The liquidation price drifts.** Funding and borrowing settle against collateral, so a stop placed just inside the buffer at open migrates *outside* it over the position's life and then never fires. Nothing currently re-evaluates placement after open — the management surface needs an alert when drift pushes the stop past liquidation. *(Reasoned from source, not executed.)*

> ⚠️ **BLOCKED — Protection does not ship until OCO is settled by simulation.**
>
> An earlier draft claimed `OCO_SIBLING_CANCELLED` "becomes live: when one bracket executes PEX cancels the other, which is cleanup we no longer build." **That symbol does not exist.** Grepping the pinned 0.6.2 source, its bundled docs, and the live `GET /v2/protocol` manifest returns **zero hits** for `OCO_SIBLING_CANCELLED`, `PARENT_RETIRED`, `PARENT_CANCELLED`, `PARENT_EXPIRED`, and for statuses 7/8 as `POSITION_MISSING`/`POSITION_REPLACED`. `v2_order_cancelled` declares `status: uint64` and `v2_order_bracket_cleanup` declares `reason: uint64`, both with **no enum registry anywhere**.
>
> All of it came from one chat message. Per this document's own citation policy those symbols are **UNVERIFIED**, and the spec then made one of them load-bearing for new surface — the exact over-trust pattern six passes have now flagged.
>
> **Simulated 2026-09-22. Partially settled — and the part that did not settle is informative.**
>
> **What is confirmed from chain.** `v2_order_bracket_cleanup` (235) is real and fires on MainNet — **49 occurrences** across 483 OrderOps transactions, reason codes **1 (×30) and 3 (×19)**, exactly two. Both child slots appear — `base+1` and `base+2` pairs such as `(1, 2)`, `(5, 6)` — confirming the stride-of-3 allocation. `keeper_fee_paid = 0` in **all 49**, with the keeper fee refunded to the owner: **nobody has ever been paid to run a cleanup**, which strengthens rather than weakens this document's pessimism about lazy incentive-driven cleanup.
>
> **An earlier draft claimed the 96,500 µALGO storage refund corroborated that MainNet had not cut over. The chain refutes that.** The refund is a clean step function: **96,500 through round 65,264,306 (28 events), then 99,700 from round 65,266,976 onward (21 events).** The order-box cutover has already happened. Confirmed directly: the live `o2:` box is **200 bytes / 25 words with `schema_version = 4`** and carries a `position_id`, where the legacy box is 192 bytes.
>
> **MainNet is mixed, and that is by design.** Ultrade confirmed 2026-09-22 that 0.6.x is live for MainNet and that *"older positions don't have position id and are functional as legacy."* So V4 order boxes coexist with 14-word `p2:` position boxes created before the cutover — those are legacy positions, not evidence of a pre-cutover contract. A comparison of approval-program hashes against a *previously recorded* value cannot detect an upgrade that predates the recording; that mistake is what produced the wrong conclusion.
>
> Two receipt event ids, **248 (×4) and 249 (×57)**, appear on live OrderOps and are absent from both pinned manifests; 249's payload carries the same timestamp-shaped position id. Worth decoding — they are the best available evidence of how far the cutover has progressed.
>
> **What could not be settled, and why.** `v2_order_executed` (231) appears **zero times** in those 450 transactions. **No order has ever executed on MainNet** — unsurprising at $913 of ALGO/USD open interest and none at all on BTC/USD. So execution-triggered cancellation cannot be observed here, and every `reason=3` event occurred **alone**, with no execution in the same transaction. The reason→name mapping therefore rests on assuming Ultrade listed them in enum order, which is not evidence.
>
> **Protection stays blocked.** Ask Ultrade for the `reason` enum directly — it is two lines for them and unguessable for us — and settle OCO-on-execution on **TestNet**, where an order can actually be made to fire. The partial-reduction case the chat message describes (OCO firing *"even on a partial reduction"*, leaving the surviving position with no brackets) remains entirely unobserved.
>
> Until then the orphan section below is written for **one** bracket and does not cover Protection. Two brackets means two order boxes, two keeper-fee escrows, and a cancel group that must cancel both.

The child order slots `base+1` / `base+2` are both already reserved by the stride-of-3 allocation.

**Costs:** a second order box MBR (`V2_ORDER_BOX_MBR_MICRO_ALGO`, 99,700 µALGO in 0.6.2) and a second keeper-fee escrow in USDC. Both recoverable. Fold both into the quoted figures, and into the pre-flight balance check.

### Orphaned take-profit orders

### How PEX cleans up — answered by Ultrade, 2026-09-21

There are **two distinct cleanup mechanisms**, and the one that matters for Perps is not the one named `bracket_cleanup`.

**`v2_order_bracket_cleanup` (235)** fires when OrderOps auto-cancels a linked child because of a lifecycle event on **another order**. One receipt per child actually removed. Four reasons:

| Reason | Trigger | Applies to Perps? |
|---|---|---|
| `PARENT_CANCELLED` | Owner cancels a pending **entry** order; attached children removed | **No** — Perps opens at market, so there is no resting parent entry |
| `PARENT_EXPIRED` | `cancel_expired_order` invoked on an expired entry order. **Expiry alone does not trigger it** | **No** — same reason |
| `OCO_SIBLING_CANCELLED` | One linked TP/SL executes, cancelling the other, even on a partial reduction | **Only if Protection ships.** With a take profit alone there is no sibling. With Protection there are two, and this becomes the governing cleanup path — one of the reasons Protection is blocked, since the symbol itself is [UNVERIFIED](#protection--an-optional-stop) |
| `PARENT_RETIRED` | Position-identity upgrade: execution attempted on a legacy bracket entry; parent retired, children removed | Only at the 0.5.0 cutover |

**None of the four covers our orphan case *as currently scoped*** — a single mandatory take profit. **This section is written for one bracket and does not cover Protection**, which introduces a sibling and makes `OCO_SIBLING_CANCELLED` governing. Rewrite it before Protection ships, including the partial-reduction case where OCO would leave the surviving position with no brackets at all.

**Our case — a position closed while its take profit rests — is handled separately**, by `v2_order_cancelled` (232) with:

- **status 7 — `POSITION_MISSING`**: the position is gone
- **status 8 — `POSITION_REPLACED`**: a *different position lifetime* now occupies the key

That receipt carries `storage_refund_microalgo`, so **the order-box MBR is refunded on this path**. It also carries `keeper_fee_amount`.

> **Status 8 is the structural fix for re-arming.** Under the position-identity upgrade, TP/SL attach to a position through its numeric id, so a stale bracket meets a replaced position and is **cancelled rather than executed**. The hazard this document built [Invariant 11](#invariants) around stops being ours to prevent.
>
> Keep Invariant 11 as belt-and-braces on 0.4.0 and as cheap insurance after; stop treating it as load-bearing. And **the outcome reader must handle `v2_order_cancelled` statuses 7 and 8 — not `v2_order_bracket_cleanup` — for every Perps flow.**

**One question remains:** is status-7/8 cleanup **eager** (at close) or **lazy** (when a keeper next evaluates the order)? That decides whether MBR is locked in the interim and therefore whether Perps History needs a reclaim affordance at all, or merely a record.

---

**A take profit that fires is consumed cleanly. A position closed any other way leaves it resting until PEX cleans it up as above** — and GTC orders can only be cancelled by the owner. Of the five outcomes, three orphan the order outright and one leaves it stale-but-live:

| Exit | Orphan? |
|---|---|
| Take profit fires | No — consumed |
| Liquidation | **Yes** |
| ADL (full close) | **Yes** |
| Manual close | **Yes**, unless we cancel in the same flow |
| ADL (partial) | No orphan — but the order goes **stale and live**: unexecutable while the position is smaller, and executable again at the old trigger and old size if the position later grows back |

`planV2CancelRelatedReduceOrders` emits `related_reduce_orders_require_owner_cancel` and returns *separate* groups the owner must sign (`src/orders.ts`); `planV2CloseWithOrderCleanup` emits `related_order_cancels_require_followup_group` when close + cancel exceeds 16, and `some_related_order_cancels_require_followup_group` when the close merges with the first cancel group but further groups remain (`src/orders.ts`). Handle both.

**What V4 lifetime binding changes.** Perps launches **after** the position-identity cutover on SDK ≥ 0.6.2, so every bracket Perps creates is a V4 order bound to a `position_id`. A V4 bracket meeting a replaced position is **cancelled, not executed** — `v2_order_cancelled` status 8. The re-arm hazard is therefore structurally impossible **for our own orders**, and the requirements below shrink accordingly.

**What it does not change.** Lifetime binding is V4-only. A user who traded PEX directly **before** cutover can still hold a **legacy V3 bracket** on the same `(market, collateralAsset, side, owner)` key — matched by coordinates, with no id binding. Per Ultrade: *"A legacy trigger can affect a reopened position at the same coordinates."* That order is not ours and we did not create it, but it can fire against a Perps position opened on that key.

**Three requirements:**

1. **Before every purchase-flow open, read live `o2:` boxes for the target key and refuse if a *legacy* reduce order rests there.** Not "any reduce order" — the take profit is mandatory, so every live position always has one, and a blanket refusal would block the increase flow. Not "any `position_missing` order" either, which was the previous wording: V4 orphans are cancelled by the protocol rather than fired, so they are harmless. **The refusal targets legacy V3 orders specifically**, identified by their stored `schemaVersion: 3`. Offer the user a cancel, showing the ALGO and USDC-opt-in prerequisites, and tell them plainly that it is a pre-cutover order of their own that PEX will not lifetime-bind.

   Scope the refusal to that single `(market, side)` key — never a global block. A refusal can otherwise deadlock: cancellation needs spendable ALGO (plausibly absent right after a liquidation, the failure this document calls the most common), needs the USDC opt-in intact for the escrow refund to land, and may be gated by a market pause.

2. **The increase flow cancels and re-places the bracket in the same group. If that group cannot be built, refuse the increase** — never increase without re-placing, and never split across two signatures leaving the position bracketless in between. Unaffected by lifetime binding: an increase keeps the same position lifetime, so the bracket stays *bound and valid* while silently covering the wrong size.

   Two distinct defects make this unconditional rather than conditioned on an SDK blocker:

   - `reduce_size_exceeds_position` is a **live comparison** (`src/orders.ts`), not a terminal state. A take profit made stale by a partial close or partial ADL becomes **executable again** if the position grows back past its size — firing at the old trigger for the old size.
   - `v2AttachedChildInput` defaults the child size to `leg.sizeUsdDelta ?? rawParent.sizeUsdDelta` (`src/transactions.ts`). On an increase the parent's value is the **delta**, not the merged total, so a bracket attached without an explicit override covers only the newly-added size while rendering as fully armed. **`leg.sizeUsdDelta` must be set to the post-increase position size** — it is on the assertion list.

   > **Simulated 2026-09-22: the single-bracket path is clean.** Built against 0.6.2 with the live protocol manifest:
   >
   > | Case | Result |
   > |---|---|
   > | One bracket, no attached-child id | 1 txn, 1 distinct — ok |
   > | Two brackets, no attached-child ids | 2 txns, 2 distinct — ok |
   > | One bracket + attached-child id | 2 txns, 2 distinct — **ok** |
   > | Two brackets + attached-child ids | 4 txns, **3 distinct — 1 duplicate** |
   >
   > So the collision needs **both** two brackets and the attached-child ids passed through. **The mandatory close path with a single take profit is unaffected**, which was an open question. This is a Protection blocker only.
   >
   > **Assert distinct transaction IDs on every group before presenting it.** `new Set(txns.map(t => t.txID())).size === txns.length`, in the single audited module. This is cheap and catches a live upstream bug: with two brackets, `planV2CancelRelatedReduceOrders` appends a `PDexV2Math.noop` budget carrier per cancel, and two such carriers are **byte-identical** — no args, no boxes, no foreign apps, no note. The planner routes through `regroup`, which clears group IDs and re-assigns without the de-duplication `grouped()` applies. Reproduced against 0.6.2: a two-reduce-order cancel builds 4 transactions with **3 distinct IDs**, succeeds at build time, and is rejected at submission. `planV2CloseWithOrderCleanup` merges through the same path, so this sits on the mandatory close route. Report it to Ultrade.

   > **No SDK builder produces this group.** `buildV2MarketOpenWithAttachedOrdersTransactions` does open + brackets only; `planV2CloseWithOrderCleanup` is the close analogue with no increase equivalent. The grouping helpers are private — `grouped` (`transactions.ts:5949`), `regroup` / `splitGrouped` (`orders.ts:500-513`) — and that matters beyond inconvenience: `grouped()` applies `applyV2LargeProgramReadBudgetToTransactions` and `distinguishRepeatedMathCarriers` before `assignGroupID` while `regroup()` does neither, so a hand-assembled group under-allocates the box-read budget and can collide on duplicate `PDexV2Math.noop` carriers.
   >
   > **Size: 11–17 transactions against a hard ceiling of 16.** At the top of that range it is not buildable at all. **Build Order step 5 must measure the real combined size on MainNet and confirm hand-regrouping preserves the read budget.** If it does not, the atomic requirement is unbuildable and the increase flow needs redesigning — and every alternative leaves a position bracketless between signatures, which the product definition forbids.

3. **Every manual close builds the cancel group. This is a correctness requirement, and an unsigned follow-up is a blocking alarm state.**

   > **An earlier draft downgraded this to "promptness" on the strength of a chat message, and the source does not support it.** What 0.6.2 shows: `orders.ts` sets `cleanupReason = "position_replaced"` and pushes a blocker — that is a **client-side lifecycle classification** establishing the order will not *execute*. It says nothing about cancellation. `planV2CancelRelatedReduceOrders` still emits `related_reduce_orders_require_owner_cancel` and returns separate owner-signed groups; if closing auto-cancelled brackets that planner would be unnecessary. The only cleanup mechanism in the SDK is `buildV2OrderCleanupCall` — an `execute_order` call with `cleanup: "orphan"`, **arbitrary sender**, 20,000 µALGO flat fee — and the 0.5.0 notes describe orphans receiving **paid** cleanup.
   >
   > So cleanup is **lazy and incentive-driven, not eager and automatic.** On an exchange this thin, a $0.05–0.10 keeper fee may motivate nobody, leaving 99,700 µALGO of MBR plus the USDC escrow locked indefinitely. **Non-execution is verified; prompt cancellation is not.**
   >
   > Useful consequence: because the cleanup call takes an arbitrary sender, **Perps can build and submit it itself** rather than waiting for a third party. The spec previously knew only about owner-signed `cancel_order`.

   Handle both follow-up signals: `related_order_cancels_require_followup_group`, and `some_related_order_cancels_require_followup_group` when the close merges with the first cancel group but further groups remain. Handle both follow-up signals: `related_order_cancels_require_followup_group`, and `some_related_order_cancels_require_followup_group` when the close merges with the first cancel group but further groups remain (`src/orders.ts`).

**Perps History records orphans and their locked MBR, and needs the reclaim button.** The question of eager-versus-lazy cleanup is answered by the source: cleanup is a paid, permissionless `execute_order` call, so nothing guarantees anyone makes it. Build the button — and since the call accepts an arbitrary sender, Perps can offer to submit it rather than only prompting the owner.

### Worked example

$50 committed, risk bar at 6×, long, live ALGO at $0.0866:

```
committed          $50        (collateral, and the maximum loss)
leverage           6×         (bar position; the short-side ceiling today is 0.93×, not the 10.9× a raw `effective_max_leverage_bps` read suggests)
notional           $300
liquidation        ~14.2% against you, before fees
```

| ALGO moves | Result |
|---|---|
| +20% (take profit) | ~$109 returned |
| +10% | ~$79 |
| −14.2% | Liquidated — residual returned after the liquidation fee, typically a few dollars and sometimes nothing |
| −7% with Protection on | ~$27 returned — against ~$28 still at risk in a live position without it. Protection's value at this point is ~$1; the $27-vs-$5 comparison holds at the **liquidation** boundary, not here |

**Every figure here is computed by the SDK against live state, never by us, and never hardcoded.** The buffer shown is indicative; the user-facing number is `liquidation_price_estimate` from a live quote, which accounts for fees deducted from collateral at open.

## Two Surfaces

Perps has two distinct UIs, and the split is what lets the entry flow stay simple without hiding the protocol's real complexity.

**Surface 1 — Purchase.** Direction, amount, risk bar, target price, optional protection, confirm. Outcome-framed, no chart, no jargon. Used only for opening a *new* position.

**Surface 2 — Position management.** Once a position is live, the UI becomes position-shaped rather than unit-shaped. This is the honest frame: the user now holds one position, not N discrete Perps positions, and pretending otherwise is what [Amount](#amount) warns against. The metaphor shift must be **visible** — a one-time explanation on first transition, not a silent swap.

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
2. **Bracket state**, mapped explicitly from `executionBlockers` — never a static "protected" badge, and **never `executable` raw**. `analyzeV2OrderLifecycle` pushes `not_crossed` and sets `executable = false` for *every* correctly-placed take profit that is simply waiting for the price (`src/orders.ts`, `:249`) — i.e. 100% of healthy Perps positions. Rendering `executable` literally would read "unexecutable" on every live position. The SDK's own quote layer special-cases this (`submitFailures` skips `not_crossed`, `src/v2OrderQuotes.ts`). Required mapping:

   | Blocker | Display |
   |---|---|
   | `not_crossed` | **Armed** — the normal healthy state |
   | `reduce_size_exceeds_position` | **Stale** — re-arms at the old trigger if the position grows back |
   | `position_missing` | **Orphaned — funds still locked.** Never show as resolved: cleanup is a paid, permissionless call nobody is obliged to make. Offer reclaim |
| `position_replaced` | **Orphaned (V4)** — will not execute, but the MBR and keeper-fee escrow remain locked until cleanup. Offer reclaim |
| `unknown_position_state` | **Cannot determine protection state** — a loud state, never a silent fallthrough. This is the default whenever the decoder does not surface `position_id`, including against any pre-cutover manifest |
   | `order_expired`, `bad_order_price` | **Dead** |

   Also supply `marketSnapshot` with live `index_price_min` / `index_price_max`, and check the decoded `o2:` record for those fields: `mergedOrder = { ...(marketSnapshot ?? {}), ...order }` (`src/orders.ts`) lets **order-box fields win over the live snapshot**, so a shadowing field would evaluate crossing against prices frozen at placement time
3. **ADL notification** when it fires
4. **Accrued holding cost**, since no clock bounds it

A user who never opens the advanced surface must still learn that they are at risk.

**Guard:** Surface 2 stays outcome-framed. More outcomes available, not more jargon exposed. The moment it reads as a trading terminal, the product has lost the thing that made it worth building.

---

## Outcomes, Notifications and Perps History

> **RESOLVED 2026-09-21 — the design is buildable. `GET /v2/protocol` carries 79 receipt types.** An earlier draft marked this section conditional because the *SDK* names no position-level receipt types. That was true of the SDK and false of the protocol.
>
> **Liquidation and ADL are distinct events**, which is the finding the whole section depended on:
>
> | Event | id | Fields |
> |---|---|---|
> | `v2_position_liquidated` | 153 | `market_id, collateral_asset_id, side, size_usd_delta, remaining_size, remaining_collateral, collateral_output, pnl_output, fee_amount, unpaid_cost_usd` |
> | `v2_position_adl` | 154 | *(identical field set)* |
> | `v2_position_decreased_with_output_swap` | — | **The voluntary close/reduce event**, emitted *even when no swap occurs*. Ultrade confirmed 2026-09-18; an earlier draft wrongly named `v2_trading_position_decreased` here. Reports **final primary and secondary outputs** — a different shape from the forced path's `collateral_output` / `pnl_output`. |
> | `v2_order_executed` | 231 | `status, owner, owner_order_id, order_kind, target_kind, market_id, side, size_usd_delta, keeper_fee_amount, storage_refund_microalgo` |
> | `v2_builder_fee_paid` | 247 | `action_kind, owner, builder, market_id_0/1, asset_id, builder_fee_bps, fee_base, assessed_amount, paid_amount, payment_status` |
> | `v2_order_bracket_cleanup` | 235 | `reason, owner, base_order_id, child_order_id, storage_refund_microalgo, keeper_fee_refund, keeper_fee_paid` |
>
> Encoding is big-endian uint64 words, 8-byte words, with prefix fields `event_version, event_type, flags`.
>
> **Amount returned** differs by path: forced closes (liquidation, ADL) report `collateral_output + pnl_output`; voluntary closes report **final primary and secondary outputs**. Amounts are in **token atomic units**. `unpaid_cost_usd > 0` identifies the genuine nothing-returned case.
>
> **Partial vs full close** is path-dependent. `position_deleted` is an explicit **named field** on `v2_position_decreased_with_output_swap` — the voluntary path — and does **not** exist on `v2_position_liquidated` (153) or `v2_position_adl` (154), where only `remaining_size` is available. Use `remaining_size == 0` for finality on the forced paths and `position_deleted` on the voluntary one. *(An earlier draft placed it in the `flags` prefix word. It is not there, and the manifest carries no `receipts.flags` registry at all, so `hasFlag()` throws against it.)*
>
> **Funding payouts may land in separate settlement calls and transfers**, so a single close receipt is not the whole story for "what did I get back."** `v2_builder_fee_paid` carries `fee_base`, settling exactly what our fee is charged on, and `payment_status` confirms the paid/clipped/waived behaviour.
>
> **Two gaps remain:**
>
> 1. **No close receipt carries an execution price**, confirmed by Ultrade. The oracle price *is* available in transaction data — but that is not the price the user got: an **effective price including impact requires reconstruction**.
>    **An earlier draft proposed dividing amount returned by `size_usd_delta` to imply an execution price. That does not work and must not be built:**
>    - **The units do not produce a price.** `size_usd_delta` is USD notional at 1e6; `collateral_output` and `pnl_output` are **token atomic units**. Their ratio is a dimensionless fraction of notional returned. An ALGO price needs `entry_price`, which no close receipt carries.
>    - **The sign is unrecoverable.** `pnl_output` is `uint64`. On a losing close it is 0 and the loss comes out of `collateral_output`. There is no sign bit and no `pnl_sign` field anywhere in the manifest.
>    - Accrued funding and borrowing are netted into the outputs, and funding may settle in separate calls entirely.
>    - Partial closes return pro-rata collateral, so the ratio moves with the close fraction independent of price.
>
>    **Options, pick one:** show no execution price at all; or reconstruct properly from `entry_price` read out of the `p2:` box *before* the close, combined with the receipt outputs, handling the loss case explicitly.
> 2. **`v2_order_bracket_cleanup` is not our cleanup path** — resolved 2026-09-21. Its four reasons all concern a resting parent *entry* order or an OCO sibling, neither of which Perps has. Perps's orphans are cleaned by `v2_order_cancelled` status 7/8, which also refunds storage. See [How PEX cleans up](#how-pex-cleans-up--answered-by-ultrade-2026-09-21).
>
> **Fee breakdown is partially explicit.** Receipts carry the close or liquidation fee, output-swap fees, and their pool / protocol / insurance split. Builder fees are a **separate** `v2_builder_fee_paid` receipt. A complete funding, borrowing and fee-allocation breakdown needs additional inner-call data and calculation — so Perps History's itemised fee line is partly reconstruction, not a direct read. Size that work accordingly, or show a coarser breakdown in v1.
>
> > **Build requirement — walk inner transactions.** `decodeReceiptFromConfirmation()` returns **one** receipt and does **not** recurse into inner transactions (Ultrade, 2026-09-18). **For keeper-executed take-profits the position close happens *inside* the orders transaction**, so a naive single-receipt decode returns the order event and silently misses the close. Any outcome reader must inspect all relevant logs and inner calls. This applies to every third-party close — take profit, liquidation and ADL alike, i.e. every notification we promise.
>
> Decoding still requires the protocol manifest, so it remains inside the poisoned-manifest blast radius — the manifest hash pin covers it.

**Intended mechanism**, subject to the above: PEX receipts plus indexer reads of the user's `p2:` and `o2:` boxes, with a chain-watching service for third-party closes. This still avoids the enumeration problem that rules out the `ms:cover:` note approach in [State](#state), but it is **not** infrastructure-free — the Operating Model's notification service is load-bearing here, and the chain watcher needs its own Residual Trust row.

This is also where orphaned take-profit orders surface. Since three outcomes orphan the order outright, a fourth leaves it stale-but-live, and only the owner can cancel it, Perps History is the one place a user reliably sees locked MBR and can reclaim it.

**Amount paid and amount returned are financial displays**, so they obey [Quote Accuracy](#quote-accuracy): derived from live chain state and receipts, never from cached client values.

---

## Target Version — pin 0.6.2 or later

**Decision, updated 2026-09-22: pin SDK 0.6.2, build against MainNet.** The SDK moved 0.5.0 → 0.5.1 → 0.6.0 → 0.6.2 in two days. Ultrade ask integrators to pin a **reviewed commit ref**, not a tag.

**The cutover has happened and 0.6.x is live for MainNet** — confirmed by Ultrade 2026-09-22 and by chain: the order-box MBR stepped from 96,500 to 99,700 at round **65,266,976**, and live `o2:` boxes are 200 bytes with `schema_version = 4` and a `position_id`. Older positions have no `position_id` and *"are functional as legacy"*, so 14-word `p2:` boxes are pre-cutover positions, not evidence of pre-cutover contracts. **Build against MainNet; the TestNet detour is unnecessary.**

**0.6.2 fixes the duplicate-transaction-ID defect we reported.** `regroup` is gone from the close path, replaced by `appendV2TransactionGroupTransactions` over a proper group result, `splitGrouped` became `batchCancelGroups`, and a regression test was added. Verified by re-running our reproduction: the failing case — two brackets plus attached-child ids — now returns **4 transactions, 4 distinct IDs**, where 0.6.2 gave 3. Reported and fixed within a day.

### 0.6.1 fixes a bug in exactly our configuration

> *"Fixes transaction resource budgeting when attaching only a TP or only an SL after an entry."*

Perps attaches **only a take profit**. That is the case that was broken. **Pin ≥ 0.6.2; do not build against 0.5.x or 0.6.0.**

### 0.6.0 closed the close-identity hole — upstream

The wildcard default this document flagged on 2026-09-21 is gone. `expectedClosePositionId(undefined)` now **throws**: *"expectedPositionId is required for a direct close or margin withdrawal."* Per Ultrade, omission "now fails instead of silently disabling the on-chain lifetime check."

**The sentinel survives as a deliberate opt-out.** `UNCHECKED_CLOSE_POSITION_ID` is exported from both `@pdex/sdk/transactions` and `@pdex/sdk/constants`; passing it explicitly executes against whatever position occupies the coordinates. Ultrade's guidance is explicit:

> *"do not use it for TP/SL or as a fallback for a failed position read."*

That second clause names the exact shortcut an implementer reaches for when a position read fails. [Invariant 13](#invariants) therefore survives, reshaped: the risk is no longer omission — the SDK handles that — it is **deliberate use**.

### Legacy V3 orders still re-arm

Lifetime binding applies to **V4 orders only**. V3 TP/SL and pending brackets keep working, matched by owner/market/collateral/side, and per the 0.6.0 notes:

> *"A legacy trigger can affect a reopened position at the same coordinates; voluntarily recreate protection to gain V4 lifetime binding."*

So the re-arm hazard is **not fully dead** — dead for newly created brackets, alive for legacy ones. If anything ever ships before cutover, every user must be prompted to recreate protection afterwards. Orphan cleanup passes `cleanup: "orphan"` with `schemaVersion: 3` for a legacy bracket child; **`cleanup: "legacy"` is now rejected outright.**

### ABI status

**No further ABI or layout changes from 0.5.0** — stated in the 0.6.0 notes and confirmed by re-reading the builders. The lists in [The full-group assertion](#the-full-group-assertion) are current: `open_or_increase` 7, `decrease_or_close` 15, `submit_linked_order` 24.

### Program hashes — capture at cutover, not now

Current MainNet approval-program SHA-256 prefixes are Trading `c6c2802f…`, OrderOps `492edbc1…`, AdminControl `08e7101a…`. **These change at the position-identity cutover**, so capture the pinning constants at release against the upgraded contracts rather than committing today's values.

**The protocol-manifest SHA-256 belongs in the same bucket.** The served manifest still describes the *pre-cutover* generation: it declares `decrease_or_close` with 14 args and `submit_linked_order` with 22, against the 15 and 24 the 0.6.2 builders pass; its `position_state` and `order_state` formats carry no `position_id`; and its `approval_size` for Trading and OrderOps does not match the deployed programs. Pinning today's hash would pin an artifact **incompatible with the pinned SDK** — `encodeAppArgs` throws `decrease_or_close expects 14 app args`. Capture it at cutover.

> The 7 / 15 / 24 argument lists are verified positionally against the 0.6.2 builders, but are **post-cutover and unverified against any served manifest**, because no cutover manifest exists yet.

### Superseded

The original 0.5.0 retarget decision (2026-09-21) stands in substance — build against the position-identity contracts, not 0.4.0 — but 0.5.0 is no longer the right pin.

### What 0.5.0 changes for us

**`position_id` is introduced to distinguish position lifetimes**, and existing positions have ID zero. This is precisely the missing nonce this document flagged repeatedly: the `p2:` key is still `marketId ‖ collateralAssetId ‖ side ‖ owner` with no serial, and that is why a stale order could re-arm against a *new* position on the same key.

**Existing-position TP/SL now requires `expectedPositionId`.** That makes the orphan protection **structural rather than policy** — a bracket bound to position lifetime *N* cannot fire against lifetime *N+1*. Consequences:

- The purchase-flow refusal narrows from "any `position_missing` order" to **legacy V3 orders only** — V4 orphans are cancelled by the protocol rather than fired. See [Orphaned take-profit orders](#orphaned-take-profit-orders).
- **Re-examine the whole orphan section against 0.5.0 before implementing any of it.** Several of its requirements may be redundant.

**Old brackets retire with refunds at cutover**, rather than trading — this is the `PARENT_RETIRED` reason on `v2_order_bracket_cleanup`, the one of its four triggers that touches us, and only at the cutover itself. Consequence: **"tell affected users to recreate protection"** becomes a launch-day requirement if we ever ship on 0.4.0 first — a further reason not to.

**Direct decrease/close and order-submission ABIs changed.** **Re-derived against 0.5.0 on 2026-09-21** — see [The full-group assertion](#the-full-group-assertion), now current. Summary of what moved:

| Method | 0.4.0 | 0.5.0 |
|---|---|---|
| `open_or_increase` | 7 args | **unchanged** |
| `decrease_or_close` | 14 args | **15** — `expectedPositionId` appended |
| `submit_linked_order` | 22 positions | **24** — `expectedPositionId` and `entryGroupOffset` inserted after `linkBaseOrderId` |

> **The two paths default differently, and that asymmetry is a security finding.**
>
> On **order submission**, `v2OrderSubmissionBinding` **throws** — *"expectedPositionId is required for an existing position"* — when binding an order to a position that already exists. The SDK enforces it.
>
> On **close**, `expectedClosePositionId(undefined)` returns `(1n << 64n) - 1n` — a **wildcard sentinel meaning "close whatever position is there."** Valid ids are `0 ≤ id < 2^48`, so the sentinel is unmistakable. Omit the field and the close is unbound: it will close whichever position lifetime currently occupies the key, not necessarily the one the user was looking at.
>
> **Assert on every close that `expectedPositionId` is a real id and never the sentinel.** This is new in 0.5.0 and has no 0.4.0 equivalent.

**Other 0.5.0 notes:** entry/increase builders need the market's current yield registry; order storage funding and resource preparation move through SDK helpers; oracle args come from `v2OracleArgs()` with message and signature passed through unchanged. `quoteV2LiquidationPrice` is exported (since 0.3.2) and should be evaluated against the `liquidation_price_estimate == 0` handling in Quote Accuracy. `post_action_liquidatable` and `adl_survivor_contract_admissible` are distinct fields. And usefully: **falling below `min_collateral_usd` alone does not make an existing position liquidatable** — it is an admission requirement, which softens one Edge Case row.

`v2OrderCrossedByOracle` remains unexported in 0.5.0, so the `quoteV2DecreaseOrder(...).submission_result` approach stands.

---

## Measured MainNet State — 2026-09-21

Read directly from chain (`mr2:` / `mp2:` / `mo2:` on `PDexV2Markets` 3690309159) and from `GET /v2/protocol`. **This discharges Build Order steps 1 and 2 for risk parameters and receipts.** Pool and OI figures are a point-in-time snapshot and must be re-read live; risk parameters are configuration and change only by admin action.

### Every TestNet figure held on MainNet

| Parameter | Both markets |
|---|---|
| `initial_margin_bps` | 500 → **max leverage 20× confirmed** |
| `maintenance_margin_bps` | 250 |
| `min_position_size_usd` / `min_collateral_usd` | $5 / $5 |
| `open_fee_bps` / `close_fee_bps` | 6 / 6 |
| `liquidation_fee_bps` | 70 |
| `max_liquidation_impact_bps` | 50 |
| `funding_interval_seconds` | 3600 |
| `optimal_usage_factor_*_bps` | 7000 — **the kink in the borrowing-rate curve, not a utilization gate.** Grepping 0.6.2, it is never read as a limit. What actually closes a side is `checkReserves` (`reserve_factor_bps × side OI` vs side pool USD) and `checkOiAfter` (`max_open_interest_*`) |

> ⚠️ **`initial_margin_bps` is the baseline, not the cap. An earlier draft concluded "20× confirmed" from it and that is wrong.**
>
> `dynamicOiMarginForOpen` computes `effectiveBps = max(baselineBps, dynamicBps)` where `dynamicBps` scales with **side open interest**, configured in a `doi:` box on **`PDexV2TradingRiskOps` (3690309161)** — a different app, and one this section never read. Live config: enabled, long and short factors both 1,000,000, which at 1e6 USD scale makes `dynamicBps ≈ side OI in whole dollars`.
>
> | Side OI | Effective initial margin | Max leverage |
> |---|---|---|
> | ≤ $500 | 500 bps | 20× |
> | $913 (ALGO/USD short, live) | 913 bps | **10.95×** |
> | $1,500 (ALGO/USD OI cap, current) | 1500 bps | 6.7× |
> | $1,560 (BTC/USD OI cap) | 1560 bps | 6.4× |
>
> **Resolved by design change, not mitigation.** Fixed leverage bands were removed entirely in favour of the [risk bar](#risk--a-continuum-not-named-tiers). A continuum has no threshold to cross, so no band can become undeliverable and no relabelling table is needed. Two requirements survive from the finding and are recorded there: resolve from `effective_max_leverage_bps` rather than `initial_margin_bps`, and **solve** the ceiling rather than look it up, because `dynamicBps` includes the user's own order size. `doi:` is now in the Availability Gating read list.

### Where the two markets differ

| | ALGO/USD | BTC/USD |
|---|---|---|
| `max_open_interest` per side | **$1,500** *(raised from $960 on 2026-09-23)* | **$1,560** |
| `reserve_factor_bps` | 1600 | 800 |
| `max_pnl_factor_for_traders_bps` | 9000 | 6000 |
| `max_pnl_factor_for_adl_bps` | 8500 | 5500 |
| `position_impact_factor_bps` / max | 55 / 110 | 20 / 100 |

### Live depth

| | ALGO/USD | BTC/USD |
|---|---|---|
| Pool | 6,835 ALGO (~$592) + 796 USDC ≈ **$1,388** | 8,927 ALGO (~$773) + 942 USDC ≈ **$1,715** |
| Open interest | long **$120.60** · short **$71.00** *(re-read 2026-09-23. It was $189.10 / $913.44 the day before, and $10.60 / $159.92 the day before that — the short side drained by 13x in 24h. **Never cache this.** Every figure derived from it, including the whole risk bar, is valid only for the block it was read at.)* | **zero** |
| `unpaid_cost_usd` | 1 at 1e6 scale — i.e. \$0.000001, so a liquidation gap has occurred but is negligible in size | 0 |

**PEX is new and thin, and that is understood: Perps exists partly to bring flow to it.** The requirement is not to wait for depth but to size against it honestly and scale automatically as it grows.

### Consequences for sizing

- **A fixed `MAX_POSITION_NOTIONAL_USD` of $1,500 exceeded the entire per-side OI cap** when that cap was $960. It is now $1,500 — exactly equal — which is still not room for one position, since the side is never empty. The lesson stands and is why the ceiling is solved rather than configured.
- **The trader PnL cap can bind, contrary to an earlier finding.** That analysis reasoned from unit size; the binding quantity is *pool* size. At 90% of a $796 short-side pool the payout ceiling is ≈**$716** — reachable by a $1,500 notional position on a 48% move. Correct the earlier conclusion that it "effectively never binds."
- **Availability gating is the normal case, not an edge case.** A 5-unit Moderate Perps is $500 notional — over half the ALGO/USD OI cap — and `position_impact_factor_bps = 55` means a position that size moves its own execution price.

---

## Pending Parameter Changes

> ⚠️ **No delay window exists, and none is committed.** Ultrade confirmed 2026-09-22 that a delay is *planned* but deliberately deferred: the protocol launched three weeks ago and they want to retain emergency-upgrade capability. That is a defensible call — a rigid delay on a very young protocol is arguably more dangerous than none. What they commit to instead is **communicating upgrades to builders in advance**, as they did with another integrator for the position-identity upgrade.
>
> **Consequences for us.** That commitment protects *builders*, not *users* — our users hear about a change only if we are awake and relay it, and it depends on someone remembering to send the message. So: **approval-program hash monitoring is now our only automatic detection of an upgrade**, not a supplement to a delay. It moves up in priority accordingly.
>
> **What we proposed back:** make the delay *asymmetric* when it does ship — only changes adverse to open positions need a window; anything that reduces risk, pauses a market or fixes a bug lands immediately. That preserves full emergency capability while still protecting users from the one thing they cannot react to. And ship the on-chain readability of pending changes even without an enforced delay, so integrators can surface them automatically.

The section below describes the feature **as it would work once a delay ships**, and is conditional on that.

Because there is no stop loss, the displayed liquidation price is the user's primary safety signal. Today the best available is reading `maintenance_margin_bps` live and never caching it — purely reactive. With pending changes readable and dated, the management surface shows **forward** state instead:

> Your liquidation price changes from **$0.0931** to **$0.0948** on **22 Sept**.

**Requirements once available:**

- Poll for pending parameter changes alongside the existing market-state reads
- Recompute every open position's liquidation price and buffer against the pending values as well as current
- Notify holders of affected positions when a change is queued, not when it lands — the whole value of the window is acting inside it
- Block new opens quoted against parameters that are about to change within the position's expected life

**Our position on the window**, given to Ultrade: 72h rather than 48h, because a 48h window opening Friday evening expires Sunday evening and the required user action — add collateral, reduce, or close — needs a signed transaction. And the delay should be **asymmetric**: only changes adverse to open positions need it (raising maintenance margin or fees, tightening caps); favourable changes can land immediately, which preserves emergency responsiveness without a long window costing anything.

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
| `builderAddress` / `builderFeeBps` | Confirmed charged on decrease (`src/v2Quotes.ts`). Unbound, the keeper redirects 10 bps of every close to itself. |
| `sizeUsdDelta` | "Decrease-or-close only" permits *partial* decreases. A keeper grinds the position with repeated partials at 0.06% + 10 bps each. |

**Two structural defects that no binding list fixes:**

**The `lease` is not one-shot.** A lease blocks a duplicate `(sender, lease)` pair only until the first transaction's `lastValid` passes. Across a 7-day Perps that is ~200 independent windows — one execution *per window*, not one ever.

**The position key carries no nonce.** `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner` **is** the full set of "exact position coordinates." If the user closes their Perps and later opens a new position on the same side of the same market with the same collateral, the old LogicSig matches the new position and the keeper closes something it was never authorised to touch.

**And it fails at its own job.** If the user increased the position, the bound `sizeUsdDelta` only partially closes, leaving a residual with stale brackets. If they partially closed, `sizeUsdDelta > position_size_usd` and the call fails — so the "enforced" close silently does not happen, which is the worst outcome for a feature sold as a guarantee.

**If this is ever revisited**, the program must assert, for every transaction in the group: `Fee <= CAP`, `RekeyTo == ZeroAddress`, `CloseRemainderTo == ZeroAddress`, `AssetCloseTo == ZeroAddress`, exact `GroupSize`, exact `TypeEnum` and `ApplicationID` per index, the complete ABI arg tuple, and `LastValid <= expiryRound`. Note that pinning `GroupSize` and per-index app IDs means any PEX upgrade silently bricks every outstanding LogicSig — the safe failure, but it degrades the feature to Option A on every upgrade anyway.

> **This would be Magnet Strategies' first on-chain code in this product, it is entirely unsupported by the PEX SDK, and it would hold signing authority over every Perps user simultaneously. A keeper compromise is an attack on all open positions at once. It is not a small addition to Option A.**

### Option C — Rekey

Rejected outright. Never rekey a user account.

### Consequence for v1

Ship Option A. Duration is a reminder, honestly worded.

**The automated exits are the take profit, liquidation and ADL.** With no stop loss, an adverse move that does not reach liquidation requires the user to act — which is the deliberate product choice recorded under [Take profit](#take-profit--mandatory-one-per-position). Manual close is the user's exit, subject to the availability limits in [Take profit](#take-profit--mandatory-one-per-position).

Do not overstate this. Three of the four remaining exits can fail: ADL disarms nothing but closes the position outright, a market pause leaves no exit at all, a gap can skip the take-profit trigger, and a failed yield recall fails whichever action contains it. Note the correction: recall is atomic *within* an action, and keeper recalls are not required for direct user actions, so a recall failure does not take out the take profit and the manual close together as an earlier draft claimed. Bounded cost comes from the take profit and from live display of accrued holding cost, not from a clock we cannot enforce.

---

## Collateral

**USDC only in v1.** Posting ALGO as collateral on an ALGO-denominated position makes the collateral's USD value move with the position, turning the liquidation price into a moving target and the payout harder to reason about. USDC gives a clean denominator.

> Making this exclusive rather than merely default also removes an ambiguity: the position key includes `collateralAssetId`, so if ALGO collateral were reachable a wallet could hold **two** distinct positions on the same market and side. Uniqueness, increase-flow routing and the notional cap would all key on the wrong tuple. USDC-only makes "one position per (market, side)" exactly true.

If the user holds only ALGO, offer an ALGO→USDC swap. Constraints:

- The swap is disclosed as a separate step with its own cost, never bundled silently.
- **`SWAP_BUILDER_FEE_BPS` is 0 for a conversion the user did not seek.** The protocol permits 100 bps on swaps, ten times the position cap. Charging maximum on a conversion the product forced is indefensible for a brand whose sibling product's founding document treats operator trust as the binding constraint. If a swap fee is ever introduced here it is a deliberate, disclosed, separately-decided product choice.
- Verify whether the swap and the position open fit in one signed group within Algorand's group size and resource-reference limits. PEX trading methods are resource-heavy and carry their own resource-carrier transactions. If they do not fit, it is two signatures, and the UI must set that expectation before the first prompt.

**mUSD is explicitly out of scope as a funding path.** See [PEX.md](./PEX.md#out-of-scope--musd-as-a-funding-path).

---

## Revenue

Perps earns through PEX's native builder-fee rail. No contract of ours, no separate fee collection, no custody. `builder_address` and `builder_fee_bps` are fields on the PEX call, recorded in the order box and publicly readable on-chain.

### Position fee — the primary line

Capped by the protocol at **10 bps of notional** (`MAX_POSITION_BUILDER_FEE_BPS = 10n`; `normalizeBuilderFee` **throws** above the cap rather than silently clamping). Revenue scales with *notional*, not with the user's stake:

| Amount | Bar position | Notional | MS fee at 10 bps |
|---|---|---|---|
| $50 | Low (3×) | $150 | $0.15 |
| $50 | Moderate (6×) | $300 | $0.30 |
| $50 | Aggressive (20×, when available) | $1,000 | $1.00 |

**The fee is charged on both open and close** — confirmed at `src/v2Quotes.ts`, where `quoteV2CloseLike` normalises a builder fee whenever `!liquidation && !adl`. Round-trip take is therefore **20 bps of notional**. The take-profit child inherits the parent's `builderFee`, so its execution pays it too. On liquidation and ADL it is forced to zero.

> **The fee comes out of the user's margin, not on top of it.** `positionCollateralDelta = max(0n, collateralAmount − (feeAmount + builderFeeAmount))` (`src/v2Quotes.ts`). A $10 unit at 20× posts $10, pays $0.12 in PEX fees and $0.20 to us, and opens with $9.68 of margin against a $5 maintenance floor — **our fee consumes ~4% of the user's liquidation buffer, and scales with leverage exactly as that buffer shrinks.** Swaps behave differently: there the builder fee is a separate transfer *on top* of the trade. The two mechanisms are not the same and must not be described as one.

This is a volume business. $1M of monthly notional returns roughly $2,000 at 20 bps round-trip.

> **Incentive disclosure.** Revenue tracks notional, and notional is `amount × leverage`, so **we earn in direct proportion to where the user leaves the risk bar** — up to ten times more at the right end than the left, on identical collateral. Our interest and the user's safety point in opposite directions along the one control the product is built around. That alignment is real. It should be acknowledged here rather than discovered by an auditor, and it is the reason two things in this spec are non-negotiable: the resolved leverage is displayed before signature, and the liquidation price is a permanent, safety-critical element of the management surface — the more so because there is no stop loss behind it.

### Swap fee — a separate decision

The protocol permits **100 bps on swaps**, ten times the position cap. Two cases, and they are not the same:

| Case | Recommendation |
|---|---|
| A conversion the product forces — user holds only ALGO and must reach USDC to use Perps | **0 bps.** Charging anything on a step the product forced is the same friction we rejected for the mUSD path, applied to our own users instead. |
| An elective swap the user initiates | **25–50 bps** is defensible and still well under the cap. |

Whatever is chosen is disclosed in the UI. The fee is readable on-chain regardless; concealing it in the interface is the same category of problem as a closed price feed.

### What is not a revenue source

- No spread on the quoted price. Execution is PEX's oracle range; we do not widen it.
- No fee on close beyond the disclosed builder fee.
- No custody, so no float and no yield on user balances.
- No mUSD path, so no PSM redemption revenue from this product.

---

## Availability Gating

The bar's ends move. PEX tightens margin requirements dynamically as open interest rises, and a side can close entirely when `reserve_factor_bps × side OI` exceeds the side pool or `max_open_interest_*` is reached.

**Gating is a local computation, not a network round trip.** The SDK computes quotes and risk client-side. Read market state on an interval, then evaluate any hypothetical amount and bar position instantly as the user changes inputs.

```
read      mp2: (pool)  mo2: (open interest)  mf2: (funding/borrowing)  ma2: (adaptive funding)   [PDexV2Markets]
          doi: (dynamic OI margin config)                                [PDexV2TradingRiskOps]
decode    via protocol manifest
compute   effective max leverage per side, remaining capacity per side  [local]
solve     the bar's floor and ceiling at the user's current amount        [local]
```

Two distinct unavailability states, with different messages and different user actions:

| State | Cause | Message shape |
|---|---|---|
| Leverage ceiling lowered | Dynamic margin tightened as side OI rose | The risk bar simply gets shorter. No message needed — there is no named tier to report missing |
> **Per-side OI is the sum of both collateral variants** — `short_oi_usd_with_long_collateral + short_oi_usd_with_short_collateral`. Reading only the USDC-collateral field overstates headroom.

| Side unavailable | `short_reserves_exceeded` / `long_reserves_exceeded` (`reserve_factor_bps × side OI` > side pool USD), or `max_open_interest_*` reached. **Not** a 70% utilization ceiling — no such gate exists | Nothing works on that side at any leverage — including Aggressive, despite its "always available" framing elsewhere, which refers only to capacity-constrained *leverage*, not to a closed side. Different message, different suggested action. |

**Prefer a ceiling to a wall.** Because any size can be evaluated locally, show the limit rather than a disabled button — *"most you can open on this side right now: $46"*. It tells the user how to get to yes and costs nothing extra. With a continuum, `notional = amount × leverage`, so every constraint binds the **product** — there is no clean split between "shortens the bar" and "caps the amount", and an earlier draft's claim that a leverage block cannot be relieved by typing less is **inverted**: on the short side today $40 opens where $50 does not, because `short_oi_cap` is a notional cap.
Surface one ceiling, `min(N_margin, OI_headroom, MAX_POSITION_NOTIONAL_USD) / amount`, and name which term is binding. When the solved floor exceeds the solved ceiling, the side is closed — say that, rather than rendering a bar with no valid range.

**Structural note for this product specifically.** Directional demand is correlated — in an ALGO drawdown most users want the same side at the same time. Perps will systematically push into whichever side is already crowded, which is also the side whose leverage ceiling has already fallen, since `dynamicBps` tracks that side's open interest. **Both constraints tighten together, in the same event.** Design the capacity messaging for that case rather than treating it as an edge case.

**Gating is a snapshot, not a guarantee.** State can shift between the read and the signature. Gating removes predictable failures; it does not remove all failures. A clean on-chain rejection handler is still required, and the acceptable-price bound is a separate rejection path gating cannot touch.

---

## Quote Accuracy

Display accuracy is a security property here, because there is no contract to exploit and misleading numbers are the primary way a user can be harmed.

**Required:**

1. **Every displayed payout is net** of open fee, close fee, builder fee, keeper fee where a bracket is attached, and accrued funding and borrowing. A screen that says $100 when $98.40 lands is a trust failure.
2. **The profit target is never presented as guaranteed.** PEX documents these orders as conditional. The trigger arms when the *oracle* crosses the level; a keeper then executes, and in a fast move it can fill worse. `≈$148` is correct; "you will receive $148" is not.
3. **Holding cost is shown live and labelled as variable.** Borrowing accrues with utilization; funding is charged *or received* hourly depending on which side of the OI imbalance the user is on. A user on the light side of the imbalance may be **paid** to hold. Never quote either as fixed.
4. **Funding share is read, never assumed.** `opposing_trader_share_bps` is live on-chain state. Hardcoding 25% is a defect.
5. **Quotes refuse to render on a stale oracle.** Payloads carry a ~30s validity window. Past `ORACLE_MAX_AGE_SEC`, show a stale state rather than a stale number.
6. **The builder fee is disclosed.** It is publicly readable on-chain; concealing it in the UI is the same category of problem as a closed price feed.
   **And one line of settlement disclosure**, not a warning banner: Perps settles on PEX, a third-party protocol, whose risk parameters can change. Brief, true, and cheap now.
7. **The payoff table is labelled as subject to the trader PnL cap.** `checkTraderPnlCap` pushes `trader_pnl_cap` when **this close's own payout** exceeds `max_pnl_factor_for_traders_bps ×` the side pool in USD (`src/v2Quotes.ts`); a pushed reason makes the quote **not ok**, so the voluntary close is *rejected*, not reduced. *(An earlier draft claimed this binds on aggregate side PnL versus other traders, and named the wrong reason strings — `long_pnl_cap`/`short_pnl_cap` are LP deposit/withdraw reasons. At $10-unit sizes an individual payout cannot approach a fraction of the pool, so this effectively never binds on the voluntary-close path.)*
   **The aggregate-side-PnL exposure is real, but it is ADL, not this.** `sidePositivePnlUsd` against `sidePnlCapUsd` drives ADL eligibility (`src/v2Quotes.ts`), and `effectiveProfitUsd = profitUsd × traderPnlCapUsd / sidePositivePnlUsd` scales the payout down. That is where correlated one-sided demand actually lands, and where `side_positive_pnl_usd`, `side_pnl_cap_usd` and `adl_threshold_breached` should be surfaced.
8. **The displayed liquidation buffer is computed after fees**, from the SDK's `liquidation_price_estimate` — never from `1/leverage − maintenance_margin_rate`, which ignores that open fees and the builder fee are deducted from collateral first.
9. **Treat `liquidation_price_estimate == 0` or an empty `liquidation_price_direction` as a quote failure.** The solver returns `{ok:false, liquidation_price:0n, direction:""}` on `invalid_side`, `position_price_unavailable`, `position_health_unavailable`, `liquidation_boundary_not_found` and `non_monotonic_liquidation_boundary` (`src/v2Quotes.ts`) — **and the quote result discards `ok` and `failure_reason`, exposing only the estimate and the direction**. Rendering the zero would show a short position as having a liquidation price of `$0.0000`, which reads as *"this can never be liquidated"* — the most dangerous possible misreading, on the element this document calls safety-critical, in a product with no stop loss behind it. Block the open; show an explicit unavailable state on the management surface and alert.

---

## State

Perps holds **no protocol state of its own**. Everything economically meaningful lives in PEX boxes: the position in `p2:`, the bracket order in `o2:`, market context in `mp2:` / `mo2:` / `mf2:` / `ma2:`.

The only Perps-specific data is **user intent** — the declared duration. Neither is required for correctness; both exist to drive reminders and display.

**Do not use an on-chain note.** An earlier draft ranked a 0-ALGO self-payment carrying an `ms:cover:` prefix first, for cross-device durability. Redacting the duration from it — necessary, because publishing them ranks leveraged retail wallets for liquidation hunters — removes the only thing that made it worth publishing, while the prefix still enumerates every Perps user permanently.

**Use `localStorage`**, and accept the cross-device loss. It is the only Perps-specific state, it is not required for correctness, and Perps History is reconstructed from chain regardless — so a user on a new device loses a duration reminder, not their record.

If a backend store is ever preferred instead, note that it makes the Operating Model's "read backend" a **write** surface and moves the target list from public to MS-held rather than eliminating it. That needs its own Residual Trust row.

> **Testable invariant: no dollar figure rendered anywhere in Perps may be derived from client-stored values. Every financial display derives from live PEX state or a decoded receipt.**

---

## Invariants

1. **The destination of every asset movement is a build-time constant**, never a runtime value from any API response. Magnet Strategies never custodies user funds, and no flow routes user assets to an address we control other than the disclosed builder fee. *(The earlier wording — "no flow routes user assets to an address we control" — was enforced by nothing, because the destination was derived from a backend-supplied app ID.)*
2. **Magnet Strategies never holds authority to open or increase a position.** In v1 we hold no authority to close one either.
3. **Every state-changing action is wallet-signed** by the position owner.
4. **No MagnetFi state is read or written** by any Perps code path.
5. **Perps reads no MagnetFi state and writes none**, and no Perps code path makes PEX state an input to a MagnetFi solvency decision. *(Stated as a constraint on Perps, which is what Perps can enforce. Whether MagnetFi ever accepts PEX-derived collateral is a MagnetFi policy decision, not something this codebase can assert.)* See the coupling rule in [PEX.md](./PEX.md#the-dependency-coupling-rule).
6. **Displayed payout ≤ realistically achievable payout** under the quoted conditions, *including* ADL payout scaling, and with the buffer computed after fees. Round against the user — and verify the direction on every quantity that reaches the screen, since `builderFeeAmount` uses floor division, which rounds the fee against us rather than the payout against the user.
7. **`builder_fee_bps` equals `POSITION_BUILDER_FEE_BPS`** on every **fee-bearing** call — asserted by equality on both the parent and the take-profit child, and disclosed in the UI. Scoped deliberately: the add-margin variant caps the builder fee at **0**, so an equality assertion against a non-zero constant would be impossible there.
8. **No PEX risk parameter is hardcoded.** Margin rates, caps, fees, funding share and utilization limits are read live.
9. **No transaction group is presented for signature without passing the full-group ABI assertion** described in the Threat Model — every app-call argument verified against what the confirm screen displayed. Simulation runs too, but is a pre-flight failure detector, not a security control: a compromised frontend controls the simulation, the comparison, and the display. The wallet is the only real boundary.
10. **Every take-profit order is GTC** — `TIME_IN_FORCE.GTC` and `expiry_time = 0`, which is already the SDK default for attached children (`src/transactions.ts`). An order that silently expires while the position it belongs to persists is a defect. The cost of GTC is that it cannot be cleaned up by `cancel_expired_order`, which anyone may call — so owner-cancellation becomes mandatory infrastructure, not hygiene.
11. **No purchase-flow open proceeds against a position key holding a *legacy* (`schemaVersion: 3`) reduce order.** V4 orders are lifetime-bound and a stale one meets a replaced position as a cancellation, not an execution — so V4 orphans are harmless and this invariant does not cover them. Legacy orders match by coordinates only and can still fire against a new position. The increase flow is exempt and instead cancels and re-places the bracket in the same group.
12. **No bracket leg — take-profit *or* stop-loss — is signed unless `quoteV2DecreaseOrder(...).crossed === false`** against the group's own oracle message, and the trigger clears the crossing bound by `CROSS_MARGIN_BPS`.
    > **Assert `crossed`, never `submission_result`.** An earlier draft used `submission_result !== "execute_immediately"` and that check is **vacuous on Perps's primary path** — proven by building 0.6.2 and running it. `submissionResultFor` returns `"blocked"` whenever any failure is present, and a same-group open has no position yet, so `analyzeV2NewOrderIntent` pushes `position_missing` and the result is `"blocked"` regardless of the trigger. A deliberately wrong-side short take profit (spot 50, trigger 60) returns `blocked / crossed: true`. The check passed 100% of purchase-flow opens while the order was crossed and would have executed on submission. `crossed` is exposed directly on the quote result and is independent of the failure list. (`v2OrderCrossedByOracle` remains unexported; `decodeV2OracleSnapshotMessage` is exported with a hardcoded 133-byte layout if a local reproduction is preferred.) PEX does not validate a target against the market; a wrong-side target executes immediately.
13. **No close is signed with `expectedPositionId` equal to `UNCHECKED_CLOSE_POSITION_ID`.** Since 0.6.0 the SDK throws on omission, so the remaining risk is *deliberate* use of the sentinel — which executes against whatever position occupies the coordinates. Ultrade's guidance is that it must never be used for TP/SL, and never as a fallback for a failed position read. **A failed position read is a blocked action, not a licence to skip the check.** Valid ids are `0 ≤ id < 2^48`.
14. **`liquidation_price_estimate == 0` or `liquidation_price_direction == ""` is a quote failure, never a rendered price.**
15. **No financial display derives from note contents.** Every dollar figure comes from a live PEX quote.

---

## Residual Trust

What a Perps user is trusting, stated plainly because the product's honesty depends on it:

| Trusted party | For what | Our mitigation |
|---|---|---|
| PEX contracts | Correct settlement, margin, liquidation, ADL | **No external audit exists — confirmed by Ultrade 2026-09-23.** Assurance is internal: 12 rounds of AI-assisted review across multiple models, continued until no further real findings were produced, and they are candid that this bounds neither bugs nor implementation oversights — they cite the orphaned TP/SL issue as one that survived it. This is more disclosure than most, and it is not a third-party audit. **Disclose it in those words.** The mitigation is not technical: size limits, the launch notional ceiling, and telling users plainly what is and is not backing the contracts holding their collateral. |
| PEX admin & upgrade keys | Acting in good faith. **Ultrade confirmed 2026-09-18** that maintenance margin can be raised on a market with open positions and **applies immediately**, that a number of parameters are mutable with bounds they intend to tighten, and that they are building (a) a **fixed delay window** before parameter changes take effect and (b) **on-chain readability of pending changes**, ~1 week out, proposed at 48h. Longer term they intend to hand admin to Algorand stakers via token governance. `maintenance_margin_bps` is read **live at liquidation time** (`src/v2Quotes.ts`), not snapshotted at open, so the buffer disclosed at purchase is a live parameter Ultrade controls. | **This is an accepted trust, recorded deliberately.** Both keys are single-signature and `PDexV2Trading` is upgradeable (see [PEX.md](./PEX.md#governance-and-upgradeability)). Magnet Strategies assumes good-faith operation with notice — the normal posture for a third-party dependency. Note that this assumption addresses *intent* only: key compromise, operational error, and a well-intentioned upgrade introducing a bug are unaffected by it. Until the delay ships, mitigation is limited to reading parameters live and never caching a disclosed buffer. Once it ships, we read the **pending** change and surface it — see [Pending parameter changes](#pending-parameter-changes). |
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
| Insufficient USDC for collateral **plus keeper-fee escrow(s)** | Precheck `amount + Σ keeperFeeAmount` — two escrows when Protection is on |
| The bar's ceiling moves between render and signature | Clean rejection handler; re-quote rather than retry blindly |
| Acceptable price exceeded mid-flight | Funds return. Explain as a price move, not an error. |
| Oracle payload stale at signing time | Block the signature; do not submit on a stale price |
| Profit target fills worse than trigger | Expected behaviour. Payout display must have set this expectation. |
| ADL reduces or closes a profitable position | Notify promptly and explain. Highest-severity surprise in the product. |
| Liquidation | Notify. Buffer was disclosed at purchase; restate what happened. |
| Position already closed when a duration reminder fires | Suppress the reminder |
| Market paused by PEX | Surface honestly; we have no override |
| User closes partially outside our UI | Read live position state as truth; never trust cached figures. **Re-place or alert on the take profit** — a size reduction makes it unexecutable *while the position is smaller* (`reduce_size_exceeds_position` is a live comparison, not a terminal state) and **live again at the old trigger if the position grows back** |
| ADL partially reduced the position | The take profit is stale *for now* and re-arms at the old trigger if the position grows back. Re-place automatically or alert loudly. Never leave it rendered as simply armed |
| Position **increased** | The take profit still covers only the prior size and remains executable — the SDK reports no blocker. Re-place it at the new size in the increase group, setting `leg.sizeUsdDelta` explicitly (the SDK default is the increase *delta*, not the merged total) |
| User already holds a position on this side | Route to the increase flow on Surface 2, never the purchase flow |
| Partial close blocked by min collateral or post-close health | Explain the floor; offer full close as the alternative |
| Voluntary close rejected by `trader_pnl_cap` | Payout exceeded a fraction of the side pool. Explain as pool capacity, not user error. Rare at Perps unit sizes |
| Yield recall fails at close time | Neither the take profit nor a manual close can execute. Surface honestly — the user is temporarily unable to exit |
| One-group construction exceeds 16 transactions | **Refuse to open.** Group size varies with settlement-maintenance calls, yield-freshness carriers and the `builderFeeBps > 0` dynamic-OI carrier — **not** with leverage, so a leverage-keyed rule would be meaningless. And the take profit is mandatory: a fallback that opens a position without one contradicts the product definition. A first-time-trader open plus its bracket runs 11–15 transactions against a hard ceiling of 16, so this is a live constraint, not a theoretical one |
| Close + cancel exceeds 16 transactions | `related_order_cancels_require_followup_group`, or `some_related_order_cancels_require_followup_group` when the close merges with the first group but others remain. Set the expectation before the first prompt; an unsigned follow-up is a blocking alarm state — cleanup is paid and permissionless, so nothing guarantees anyone else makes it |
| **Legacy (V3) reduce order on the target key** | Refuse the purchase-flow open until cancelled — legacy orders match by coordinates and can fire against a new position. V4 orphans need no such check |

---

## What Is Deliberately Not Here

- **No custom smart contract.** If a proposal adds one, it changes the threat model in this document and requires re-review.
- **No mUSD funding path.** Excluded by decision. See [PEX.md](./PEX.md#out-of-scope--musd-as-a-funding-path).
- **No enforced time-based close in v1.** Not available without delegated authority.
- **No chart.** PEX is oracle-priced; a chart would be decorative and would imply the user should be timing entries.
- **No delegated close authority.** Option B is documented as rejected, not deferred.
- **No per-unit targets, durations, or liquidation prices.** Units size a purchase; they are not independent positions.
- **No stop loss in v1.** Protection is specified but **BLOCKED** pending the OCO questions — see [Protection](#protection--an-optional-stop). Until it ships, liquidation is the only automated downside exit, and the displayed liquidation price carries that weight alone.

---

## Build Order

1. **Read path, pinning, and receipt discovery.** Fetch the deployment and protocol manifests; commit every app and asset ID, the four ABI method signatures, the oracle signer key, and the approval-program hashes as build-time constants. Decode `mp2:` / `mo2:` / `mf2:` / `ma2:` for both markets against live MainNet state.
   **Receipt discovery is DONE** — see [Measured MainNet State](#measured-mainnet-state--2026-09-21). 79 types; liquidation and ADL distinct. Remaining in this step: compute and commit the manifest SHA-256 and the approval-program hashes, and confirm `BUILDER_ADDRESS` USDC opt-in.
2. **Measure.** Live borrowing and funding rates, real utilization, per-side capacity, `max_pnl_factor_for_traders_bps`, `liquidation_fee_bps`, `maintenance_margin_bps`, MainNet max leverage, and **`effective_min_position_size_usd` / `dynamic_min_position_size_usd` / `position_quantization_loss_usd`**. That last group is a product-viability question, not an edge case: Perps is the smallest position this exchange supports, `V2_MAX_POSITION_QUANTIZATION_BPS = 1n` (`src/v2Quotes.ts`) and `quoteV2OpenOrIncrease` pushes `position_quantization` and `zero_tokens` (`:2018-2022`). The bar's **floor** is `max(min_position_size_usd, dynamic_min) / amount`, so a dynamic minimum above the static $5 directly raises it — and if quantization rejects the smallest viable order the product's minimum ticket changes. **Risk parameters are NOT done.** The `mr2:` values are confirmed and scale-correct, but the binding leverage constraint lives in the `doi:` box on `PDexV2TradingRiskOps`, which was never read — see the warning in [Measured MainNet State](#measured-mainnet-state--2026-09-21). **Re-derive every leverage figure against the solved ceiling before anything downstream is trusted.** **Still to measure:** realised borrowing and funding *rates* over time (the factors are known: `funding_factor_milli_bps` 855, base borrowing 360 milli-bps, full-usage 1142, optimal usage 7000 bps), ALGO volatility for `CROSS_MARGIN_BPS`, and whether the smallest viable order clears `position_quantization` and any dynamic minimum.
3. **Pending-change reader**, once Ultrade ships it. Poll, recompute forward liquidation prices, notify inside the window. See [Pending Parameter Changes](#pending-parameter-changes).
4. **Supply-chain controls.** Reproducible builds with published hashes, subresource integrity, a pinned deployment bundle. These — not the group assertion — are what raise the bar against full frontend compromise.
   **Operational prerequisite in the same step:** `BUILDER_ADDRESS` must be opted in to USDC (31566704) with sufficient ALGO MBR **before launch**. The builder fee is paid in the collateral asset and the address appears in `accounts` on every fee-bearing call — if it is not opted in, plausibly **every open fails for every user on day one**. *(Conditional: confirm on chain whether PEX pays via an axfer requiring the opt-in or via accrual.)*
5. **Quote engine.** Solve the risk bar's floor and ceiling per the closed form, confirmed by a live quote returning `ok === true`; payoff table; holding cost; availability gating; notional cap. Verified against SDK output, not reimplemented.
6. **Group construction.** Single audited module. Per-method ABI assertions plus asset-movement assertions on `(asset, amount, receiver)`. Simulation as a pre-flight check. `baseOrderId` allocated in strides of 3 from the highest existing `o2:` box read live from chain, never from local state.
7. **Purchase surface.** Direction → amount → risk bar → target price → optional protection → confirm, with entry-time routing to the increase flow.
8. **Protection (BLOCKED).** Do not build until both are settled: Ultrade supplies the `v2_order_bracket_cleanup` `reason` enum (codes 1 and 3 occur on MainNet; the mapping to their four named triggers is assumption), and OCO-on-execution is simulated on TestNet — including the partial-reduction case. Neither is determinable on MainNet, where `v2_order_executed` has never fired.
9. **Management surface.** Liquidation price, take-profit state, accrued holding cost, add / add-collateral / partial close / close, orphan reclaim.
10. **Outcomes.** Receipt decoding **with inner-transaction traversal** — `decodeReceiptFromConfirmation()` returns one receipt and does not recurse, and keeper-executed take-profits close the position *inside* the orders transaction, so a single-receipt decode misses every third-party close.
   **Read `position_deleted` as a named field** on `v2_position_decreased_with_output_swap`; it is not in the `flags` prefix word, and the manifest carries no flags registry, so `hasFlag()` throws. On `v2_position_liquidated` and `v2_position_adl` that field does not exist — use `remaining_size == 0`.
   **Do not derive an exit price by division.** See [Outcomes](#outcomes-notifications-and-perps-history): the units do not produce a price and `pnl_output` is `uint64` with no sign bit. Either show no execution price, or reconstruct from `entry_price` read out of the `p2:` box before the close.
   Then the five close notifications and Perps History.

Steps 1 and 2 are prerequisites, not preliminaries. Every number in this spec marked TestNet is a placeholder until step 2 replaces it.

---

## Open Questions

**Informational, not blocking.** Build proceeds in parallel.

**Answered and retired:** MainNet maximum leverage (20×, `initial_margin_bps = 500`), the MainNet value of every TestNet parameter, and the receipt questions — all settled on chain or by Ultrade, see [Measured MainNet State](#measured-mainnet-state--2026-09-21).

### Only Ultrade can answer

Policy, roadmap, or internal semantics we cannot observe.

0. **Confirm the 0.5.0 MainNet cutover date**, and whether old brackets retiring with refunds requires anything of integrators beyond telling users to recreate protection.
1. **Does the parameter delay window cover contract upgrades, or only parameters?** The sharpest remaining question. `PDexV2Trading` was upgraded 2026-09-12, an upgrade keeps the app ID, and Ultrade indicate no app ID change is expected — so **every** future change reaches us through the upgrade path. A 48h delay on parameters is only as strong as the upgrade path beneath it.
2. ~~**The `v2_order_bracket_cleanup` `reason` enum, and OCO-on-execution.**~~ — **enum answered 2026-09-23 in SDK 0.6.3; the TestNet observation is still outstanding.** `V2_ORDER_BRACKET_CLEANUP_REASON` and `V2_ORDER_STATUS` now ship as exported constants with a documented table: the two codes we had seen are `PARENT_CANCELLED` (1) and `OCO_SIBLING_CANCELLED` (3), the latter defined as *"Linked TP/SL executed; the other child was removed"* — the OCO-on-execution guarantee Protection needs. 0.6.3 is additive with no contract change, so the behaviour predates the documentation. **Protection stays gated** until one leg is watched executing on TestNet with the sibling observed removed: a published table is better evidence than a chat message and is still not a measurement. Two cleanup details to get right: bracket cleanup removes `owner + child_order_id` (not `base_order_id`), status 7/8 cleanup removes `owner + owner_order_id`, and codes 7/8 are successful cleanup rather than fills. Original finding follows.

   *Original:* Codes **1** and **3** occur on MainNet (30 and 19 times), but the mapping to Ultrade's four named triggers is assumption, not evidence, and `v2_order_executed` has **never fired on MainNet**, so execution-triggered cancellation is unobservable there. Two actions: ask Ultrade for the enum, and simulate OCO on **TestNet** — including the partial-reduction case, where OCO firing would leave the surviving position with no brackets at all. *(Partially answered 2026-09-21: the four reasons were described, and `v2_order_cancelled` status 7/8 refunds storage. The sub-question of whether cleanup is eager or lazy is now settled by chain — `keeper_fee_paid = 0` in all 49 cleanups, so nobody has ever been paid to run one. Perps History needs the reclaim affordance.)*
3. ~~**Oracle signer public key**~~ — **answered 2026-09-21.** `4cc6bcc8...d2e3dffb`, from `PDexV2OrderOps` (3690309166) global key `"oc"`, cross-checked against `PDexV2Trading` global key `"q"`. Pin it. Remaining sub-question: confirm the trailing `0x1e` is indeed an on-chain freshness tolerance of 30 seconds.
4. ~~**Yield recall failure**~~ — **answered 2026-09-21.** Recall is atomic within whatever action requires it; if it fails, that action fails. Keeper recalls are not needed for direct user actions such as closing a position, so a manual close carries its own recall rather than depending on a keeper's.
5. ~~**Is there a published or private PEX audit?**~~ — **answered 2026-09-23. There is none, internal or external.** Assurance is 12 rounds of AI-assisted review across several models, run until findings stopped appearing. Ultrade state plainly that bugs and implementation oversights remain possible and cite the orphaned TP/SL fix as an example that survived the process. Recorded in [Residual Trust](#residual-trust); it changes what we disclose, not whether we build. **The multisig half of this question is still open** and should stay on the list — both admin and upgrade keys remain single-signature.

### Determinable by simulation — do not spend Ultrade's time on these

Each can be settled with `simulate_transactions` against MainNet at zero cost, and a simulated answer is more reliable than a remembered one. **Settle in Build Order step 1.**

- Do the PEX contracts enforce oracle freshness, and with what tolerance? *(Simulate with a deliberately stale payload.)*
- Do the contracts cap `keeperFeeAmount`? *(Simulate an order with an absurd escrow.)*
- Is `max_pnl_factor_for_traders_bps` enforced on-chain identically to the SDK's `checkTraderPnlCap`? *(Simulate a close whose payout exceeds the cap.)*
- Does `cancel_order` refund the order-box MBR (`V2_ORDER_BOX_MBR_MICRO_ALGO`, 99,700 in 0.6.2) and the escrowed keeper fee? *(Simulate a cancel and read the balance deltas.)*
- Is a duplicate `ownerOrderId` rejected, or does it overwrite the box?
- Does a market pause gate `PDexV2OrderOps` cancellation?
- Can an ALGO→USDC swap and a position open fit in one signed group within resource-reference limits?
- Do resting limit orders pre-reserve open-interest capacity, or only the storage escrow?
- Does the smallest viable order clear `position_quantization`, `zero_tokens` and any dynamic minimum? *(It sets the bar's floor and the product's minimum ticket — settle early.)*
- Does the increase-flow group — cancel + `open_or_increase` + `submit_linked_order` + carriers — fit under 16 transactions in practice?

### Ours to decide, not to ask

- ~~**Should there be an unleveraged option?**~~ **Closed by the risk-bar rewrite.** The floor is solved as `max(min_position_size_usd, dynamic_min) / amount`, so low leverage is reachable whenever the venue allows it. No fixed floor, no bands.
- **Does a PEX redeploy migrate existing position state?** Low priority — no app ID change is expected, so the two-state degraded mode is insurance against an unplanned event.

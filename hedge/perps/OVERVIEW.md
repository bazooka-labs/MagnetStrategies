# Perps

Perps is the PEX-integrated arm of Hedge: leveraged directional positions on Algorand, wrapped in a product surface that deliberately does not look like a trading terminal.

Magnet Strategies does not operate an exchange here. PEX is a third-party protocol built by Ultrade. Everything in this section is an **integration**, not a deployment. We write no exchange contracts, custody no user funds, and hold no protocol role.

**Status:** Design stage. One product scoped — Cover. Nothing is built or deployed.

---

## What PEX Is

PEX (PDex in code; the naming is split between the public brand and the source) is an on-chain perpetuals exchange on Algorand. Traders transact against pooled liquidity rather than an order book. All settlement is via Algorand atomic transaction groups, signed by the user's wallet.

Five properties define it:

| Property | Consequence for us |
|---|---|
| Non-custodial settlement | Every action is wallet-signed. We never hold funds. |
| Isolated margin per position | One position's liquidation cannot touch another, or the wallet. |
| Oracle-priced, not order-book | There is no book depth and no meaningful chart. Execution is set by a signed price range. |
| Pool-backed markets | Each market has its own pool, its own risk limits, and its own capacity. |
| On-chain conditional orders | Take-profit and stop-loss are native order kinds, not something we build. |

**SDK:** `@pdex/sdk` v0.4.0, `ultrade-org/pex-ts-pubsdk`. Browser-first TypeScript. Builds transaction groups, decodes oracle messages, and computes quotes and risk **locally**. Actively developed — last observed commit 2026-09-16.

The SDK is a frontend tool. It requires a backend and node that *we* supply. There is no PEX-operated backend and the SDK states outright that no fallback selects one.

---

## The Two Markets

Both are MainNet, both backed by ALGO/USDC pools, and they share no capital.

**Market 1 — ALGO/USD (asset-backed).** The pool holds the index asset. This partially self-hedges: when ALGO rises the pool's ALGO is worth more but it owes more to winning longs; when ALGO falls its assets are worth less but it collects from losing longs.

**Market 2 — BTC/USD (synthetic).** The pool holds ALGO and USDC but owes **BTC-denominated** PnL. Assets and liabilities are uncorrelated. In a risk-off move where ALGO falls while BTC holds, pool assets fall while obligations rise simultaneously. Nothing offsets.

> **Rule: the asset-backed / synthetic distinction is not cosmetic.** Any future product that takes economic exposure to a PEX pool takes it from ALGO/USD only. The BTC/USD pool carries an unhedged basis leg.

---

## How Pricing Works

PEX aggregates exchange prices into a **signed min/max range**, not a single quote. Execution always takes the side of the range that disfavours the actor:

- Long entry and short exit → upper bound
- Short entry and long exit → lower bound

Price impact is then applied based on whether the action improves or worsens the pool's long/short balance, and folded into the execution price rather than charged as a fee. The user's *acceptable price* is the final slippage boundary; exceeding it rejects the transaction and returns funds.

The same conservative principle governs LP share valuation, which is worth recording because it was verified directly against PEX's own conformance vectors: `deposit_value` prices the pool at the oracle **maximum**, `withdraw_value` at the **minimum**, and trader profit owed by the pool is subtracted at whichever bound is worse for whoever is acting.

**Price transport.** Signed payloads and a latest-price bundle are published to a public CDN with no credential:

```
https://pub-1e72beea87f04ebfafce248132310425.r2.dev/mainnet
  v2/latest-prices/mainnet/current.json
  v2/oracle-payloads/mainnet/current.json
```

Payloads carry a ~30-second validity window (`valid_from_timestamp` → `valid_until_timestamp`) and are fetched `no-store`. Source is `exchange-median`.

> Oracle payloads are **target-bound**. They are signed for a specific PEX application and must be rejected on target mismatch. They cannot be consumed on-chain by any Magnet Strategies contract. They may be used off-chain as a free independent cross-check in our own keeper aggregation — see [../ORACLE.md](../ORACLE.md).

---

## Verified Parameters

These are the **TestNet** values published by PEX — the only ones they publish. MainNet risk configuration is not documented and PEX directs integrators to the live transaction preview. Treat every number here as shape, not truth, and read live state before relying on any of it.

| Parameter | Value |
|---|---|
| Maximum leverage | 20× |
| Initial margin | 5.00% |
| Maintenance margin | 2.50% |
| Minimum position size | $5 |
| Minimum collateral value | $5 |
| Maximum pool utilization | 70% |
| Open / increase fee | 0.06% of changed size |
| Decrease / close fee | 0.06% of changed size |
| Liquidation fee | up to 0.70% of position size |
| Funding update interval | 1 hour |
| Funding split | 75% market pool / 25% opposing positions |
| Minimum keeper fee | $0.05 |
| Maximum GTD duration | 30 days |

The funding split is **not a constant**. `opposing_trader_share_bps` lives on-chain in the adaptive funding box and is validated in range 0–10,000. Test vectors exercise 0, 2500, 7500 and 10000. Never hardcode 25%.

**Storage and network costs** (from `src/constants.ts`, µALGO):

| Item | µALGO |
|---|---|
| Position box MBR | 70,900 |
| Order box MBR | 96,500 |
| Open-order execution escrow | 100,200 |
| LP box MBR | 26,500 |
| Trading method flat fee | 29,000 |
| Decrease/close method flat fee | 37,000 |
| Liquidation method flat fee | 28,000 |

A position with an attached take profit costs roughly **0.40 ALGO** all-in (position box 70,900 + order box 96,500 + trader box 29,300 + method flat fees + per-transaction minimums). Negligible in dollars; fatal if the user's spendable ALGO is short. This is the single most common cause of a failed first transaction.

**On-chain state** is readable from boxes with these key prefixes:

| Box | Key |
|---|---|
| Market pool | `mp2:` + marketId |
| Market open interest | `mo2:` + marketId |
| Funding / borrowing | `mf2:` + marketId |
| Adaptive funding | `ma2:` + marketId |
| LP position | `ml2:` + marketId + owner |
| Trader | `t2:` + owner |
| Position | `p2:` + marketId + collateralAssetId + side + owner |
| Order | `o2:` + owner + orderId |

---

## The Builder Fee Rail

PEX has a native, permissionless builder-fee mechanism. `builder_address` and `builder_fee_bps` are stored in the order box and described in the SDK as a "user-authorized account that receives any paid builder fee."

```
MAX_POSITION_BUILDER_FEE_BPS =  10n   // 0.10%
MAX_SWAP_BUILDER_FEE_BPS     = 100n   // 1.00%
```

Any interface we ship can collect this without PEX's permission, a partnership, or a contract of our own. Note the asymmetry: **swap flow is worth ten times position flow** in basis-point terms.

Because the fee is recorded on-chain and publicly readable, it must be disclosed in the UI. A fee that a user can discover on-chain but not in our interface is the same category of problem as a closed-source price feed.

---

## What PEX Does Not Provide

Recorded so that no one re-discovers these the hard way:

- **A public API exists, but is unsupported for builders.** `api.ppls.exchange` answers `GET /v2/networks/mainnet/deployments` and `GET /v2/protocol` with HTTP 200, and `app.ppls.exchange/api/...` mirrors it. *(An earlier draft said no public API existed — that was wrong; only the public **artifact CDN** lacks these paths.)* The SDK still states that no fallback selects a PEX-operated backend, so treat this as convenient for extraction, **not** as infrastructure to depend on at runtime.
- **Application IDs are recoverable** and are recorded below. Pin them; do not fetch them at runtime.
- **No published MainNet risk parameters.** Leverage, fees, margin, caps and yield settings are explicitly described as varying by market and changing with configuration.
- **No published borrowing or funding rates.** Readable on-chain from `mf2:` / `ma2:` once application IDs are known. **Measure these before designing any UI that quotes holding cost.**
- **No audit reference** in the README, LICENSE, or integration guides. Absence of advertisement, not proof of absence.
- **The protocol manifest supplies more than decoding.** It carries the ABI method signatures used to *encode* transaction args as well as the box formats used to decode state — so whoever controls it controls both what we send and what we display. Pin the method signatures and a manifest hash as build-time constants; a version check is not sufficient.

PEX's own README is candid about its limits: *"not a complete backend implementation or a claim that all response schemas fully specify the financial calculations. Qualify your backend and frontend together against the current contracts."* Take that at face value.

---

## MainNet Deployment

Recovered from `GET https://api.ppls.exchange/v2/networks/mainnet/deployments`. **These are build-time constants, not runtime values** — see the pinning requirement in [COVER_SPEC.md](./COVER_SPEC.md#critical-the-backend-supplies-fund-destinations).

| App | ID |
|---|---|
| PDexV2AdminControl | 3690306989 |
| PDexV2Math | 3690309158 |
| PDexV2Markets | 3690309159 |
| **PDexV2Trading** | **3690309160** |
| PDexV2TradingRiskOps | 3690309161 |
| PDexV2AdminOps | 3690309162 |
| PDexV2SwapOps | 3690309163 |
| PDexV2SingleTokenOps | 3690309164 |
| PDexV2SingleTokenTrading | 3690309165 |
| PDexV2OrderOps | 3690309166 |
| PDexV2CvaVault | 3690309167 |
| PDexV2MarketYieldVault | 3690309168 |
| PDexV2MarketXAlgoYieldVault | 3690309169 |

Assets: USDC `31566704` · xALGO `1134696561` · fUSDC `971384592` · frUSDC `971384593` · BTC index `9000000000000000` (synthetic placeholder, not an ASA).

The fUSDC/frUSDC and xALGO asset IDs confirm the yield strategies concretely: pool assets are deployed into **Folks Finance lending** and **xALGO consensus staking**.

---

## Governance and Upgradeability

Established from chain on 2026-09-17, and recorded as **accepted counterparty risk**. Magnet Strategies assumes Ultrade operates in good faith and changes risk parameters with notice — the normal posture for building on a third-party protocol, and not a controversial one. What follows is the factual basis for that assumption, not an argument against it.

**`PDexV2Trading` is upgradeable, and it has been upgraded.** One `update` transaction on app 3690309160, at round 64979227, **2026-09-12 17:24 UTC**. `PDexV2AdminControl` has been updated 8 times.

An Algorand app update replaces the contract's logic while everything inside it — user collateral, open positions — stays put. Whoever holds the upgrade key can change settlement, margin and payout logic on a live protocol holding real funds.

**Authority lives in `PDexV2AdminControl` global state**, as two 88-byte structs laid out `[current(32) | pending(32) | 3×uint64]`:

| Role | Address | Pending |
|---|---|---|
| `admin` | `EADFT4IMWIRKMN5KJGIKJA2U6CHXU3N43LZCLGV2GPEVEBM74MPZ4MZ3D4` | none |
| `upgrade` | `34BIJNZIPXEKAUYAYKVECRBI4V7VXJ4IDXADX3ZTFT7HBCWHER3MKQTEH4` | none |

**Both are single-signature accounts** — checked against their transaction histories, 24 and 8 outgoing transactions respectively, zero multisig. The upgrade address is the sender of the 2026-09-12 update. The pending slots and three zeroed uint64s imply a deliberate two-step handover design, but nothing observable enforces a delay.

What this means concretely:

> `maintenance_margin_bps` is read **live at liquidation time** (`src/v2Quotes.ts:2654`), not captured when a position opens. So the liquidation buffer we disclose to a user at purchase is not a property of their position — it is a live parameter under the control of a single key we do not hold. Raising it liquidates open positions with no price movement at all.

Separation of the admin and upgrade roles into two keys is genuinely good practice, and single-signature control is unremarkable for a protocol at this stage — most young protocols look like this, and refusing to integrate on that basis would rule out most of the ecosystem.

**What the good-faith assumption does and does not cover.** It addresses *intent*. It does not address key compromise (where Ultrade's intent is irrelevant), operational error, or a well-intentioned upgrade that introduces a bug. Those three remain unbounded under single-signature control, which is why the one technical consequence below holds regardless of trust:

> **Never cache a disclosed liquidation buffer.** `maintenance_margin_bps` is read live at liquidation time, so a cached buffer silently becomes wrong the moment a parameter changes — with or without notice, honestly or otherwise. Read it live, every time.

Forward-looking questions for Ultrade — multisig plans, timelock plans, change-notice process, audit status — are listed in [COVER_SPEC.md](./COVER_SPEC.md#open-questions) and are **informational rather than blocking**.

---

## Integration Paths Considered

Four ways Magnet Strategies could layer on PEX were examined. Recording all of them, including the rejected ones, so the reasoning survives.

### Selected — trading interface (Cover)

A simplified product surface over PEX positions. No custom contract, no protocol risk, no change to MagnetFi's solvency surface, monetized natively through builder fees from day one. Specified in [COVER_SPEC.md](./COVER_SPEC.md).

This is first because it is the only path with no balance-sheet exposure.

### Deferred — PEX LP as MagnetFi collateral

The obvious integration, and the most dangerous. PEX LP shares are non-transferable and account-based, so a wrapper contract would have to become the LP of record, issue a transferable receipt, and manage redemption. That receipt would then plug into the existing v2 vault pattern as collateral.

It was deferred because the underlying asset can be drained through **correlated** channels that all fire in the same event:

1. **Backing-asset exposure.** The pool holds ALGO and USDC as inventory. ALGO falling takes the ALGO half of NAV with it.
2. **Trader PnL.** The pool is the traders' counterparty. Verified in PEX's own NAV vectors: a single $100M long up ~20% subtracts 20,600,000 directly from `withdraw_value`. Bounded by PnL caps and ADL, but bounded is not small.
3. **Basis risk** (BTC/USD only). Assets and liabilities uncorrelated.
4. **Yield-source risk.** `lent_qty` is pool assets deployed into Folks Finance lending and xALGO consensus staking. Our users would inherit third-protocol risk they never chose.
5. **Availability.** Utilization at the 70% ceiling, committed reserves, a binding PnL cap, or assets mid-recall can make the position solvent but un-redeemable.

In a sharp ALGO drawdown, (1), (2) and (5) fire together: collateral value falls, falls again as shorts are paid, and becomes un-redeemable through a utilization spike — at exactly the moment MagnetFi borrowers need liquidating and liquidators need to realize it. That is a reflexive spiral, and it is categorically worse than Tinyman LP collateral, which can lose value but is always redeemable and has no counterparty leg.

PEX ships a `liquidation_uncollectible` conformance vector. They have modelled uncollectible liquidations. Treat that as a warning aimed at integrators.

**If this is ever revisited:** ALGO/USD pool only; LTV gated on live utilization headroom rather than price alone; a hard cap on PEX-backed collateral as a share of MagnetFi's total collateral base; liquidation paid from a buffer rather than requiring the liquidator to redeem; and a separate haircut for `lent_qty`.

### Deferred — delta-neutral farming vault

LP held alongside a PEX short sized to its ALGO delta, turning farm yield into stablecoin-denominated return. Genuinely novel on Algorand because no on-chain venue could short ALGO before PEX. Strongly on-thesis for "Attract Liquidity" — it opens the farms to capital that refuses directional risk.

Deferred, not rejected. Blockers: ADL can close the hedge precisely when it is working; funding may invert and become a cost; per-side OI caps limit vault scale; rebalancing costs 0.06% per side plus impact. If built, it ships as its own product with its own token and **does not touch mUSD issuance**.

### Deferred — hedging protocol-owned exposure

PSM v3 productive reserves carry real exposure today. PEX is the first on-chain venue on Algorand where it could be hedged. This is risk *reduction* for an existing protocol rather than a new risk surface, and is probably the highest-value use of the integration. Deferred only because it touches MagnetFi and should not be the first thing we ship on an unaudited third-party dependency.

### Out of scope — mUSD as a funding path

Explicitly excluded. Routing mUSD → USDC through the PSM to fund positions would incur the 1% redemption fee on every entry, make the mUSD path the most expensive way to fund a position in our own app, and build a convenient exit ramp out of mUSD — working directly against the float and dwell-time metrics in [../OVERVIEW.md](../OVERVIEW.md).

**Do not reintroduce this without a PSM change.** The version worth pursuing instead is mUSD accepted as a PEX collateral asset, which requires a configured market-pool asset on their side. That is a conversation with PEX, not an integration we can build.

---

## The Dependency Coupling Rule

Hedge's founding rule is that Hedge must never read the oracle MagnetFi liquidations depend on, because manipulating a payout and manipulating solvency would become one action.

That rule names a specific oracle. The property it protects is more general, and PEX makes the gap visible: if PEX state ever feeds MagnetFi solvency (via LP collateral) *and* a Hedge product also depends on PEX state, the failure mode returns with PEX as the shared dependency.

> **Extended rule: no Hedge product may depend on a price or state source that MagnetFi solvency depends on.**

Under that rule, Cover is safe — it reads PEX state and touches no MagnetFi state at all. It also means taking PEX LP as MagnetFi collateral would foreclose PEX-based Hedge products, and vice versa. That dependency can be spent once. Cover does not spend it.

---

## Licensing

**PEX Builder License 1.0** — source-available, not open source. Commercial use is broadly granted for products integrating with Official PEX Deployments: independently branded interfaces, wallets, bots, liquidity tools, analytics, backend services. We may charge, collect builder fees, serve our own customers, and run our own nodes and indexers. Competing with a PEX-operated interface on the same deployment is explicitly permitted.

Forbidden: using the Software to implement, operate or support *other* protocols. An anti-fork clause states that copying code, parameters, names or metadata does not make a deployment official.

Nothing in Cover conflicts with these terms. Our own contracts and frontend remain under Magnet Strategies' existing terms; the PEX SDK stays under theirs.

---

## Documents

| | |
|---|---|
| [COVER_SPEC.md](./COVER_SPEC.md) | Cover — product definition and architecture spec |
| [../OVERVIEW.md](../OVERVIEW.md) | Hedge arm — positioning, mUSD rationale, ring-fencing |
| [../ORACLE.md](../ORACLE.md) | Hedge oracle — sources, attestation, trust model |
